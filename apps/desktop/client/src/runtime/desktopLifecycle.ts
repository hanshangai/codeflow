import type { DesktopApiRequest, DesktopApiRequestMessage, DesktopApiResponse, DesktopApiResponseMessage, DesktopClientHealth, DesktopClientReadyMessage, DesktopEvent, DesktopEventMessage, DesktopRuntimeRequest, DesktopUpdateControlRequest, DesktopStartupMode, DesktopStartupControlRequest } from "@codeflowai/shared";
import { isConversationChangedMessage, isDesktopTerminalEvent, snapshotDesktopStartupMode, toConversationDisplayMessage } from "@codeflowai/shared";
import type { DesktopStartupHooks } from "./desktopStartupRecovery.js";
import type { SqliteDb } from "../db/sqliteTypes.js";
import { describeWorkspaceProfileFailure } from "../db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../db/migrateClientDb.js";
import { logger } from "../logger.js";
import { toErrorLog } from "../scheduled-tasks/scheduledTaskScheduler.js";
import { createHash } from "node:crypto";

type DesktopChannel = {
  connected?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send?: (message: unknown, callback: (error: Error | null) => void) => unknown;
};

type DesktopShutdown = (reason: string, error?: Error) => void | Promise<void>;
type DesktopApiHandler = (request: DesktopApiRequest, id: string) => Promise<DesktopApiResponse>;

export type DesktopUpdateOperation = { requestId: string; signal: AbortSignal };
export type DesktopUpdateHooks = {
  prepare(operation?: DesktopUpdateOperation): Promise<{ hasRunningSessions: boolean }>;
  interrupt(operation?: DesktopUpdateOperation): Promise<void>;
  resume(operation?: DesktopUpdateOperation): Promise<void>;
};

/** 更新控制只在父通道识别，普通业务仍由原白名单处理。 */
function isUpdateControl(request: DesktopRuntimeRequest): request is DesktopUpdateControlRequest {
  return request?.method === "runtime.update.prepare" || request?.method === "runtime.update.cancel" || request?.method === "runtime.update.interrupt";
}

/** 父专用首次恢复不落入普通业务handler。 */
function isStartupControl(request: DesktopRuntimeRequest): request is DesktopStartupControlRequest {
  if (!request || typeof request !== "object") return false;
  const method = Object.getOwnPropertyDescriptor(request, "method");
  return Boolean(method && "value" in method && method.value === "runtime.startup.continue");
}

/** 已知 Profile/任务/Git 聚合复用有界诊断，保 falsy 因且不读取访问器。 */
function describeDesktopProfileFailure(error: unknown, depth = 0, scheduled = false): Record<string, unknown> {
  const type = error === null ? "null" : typeof error;
  if (!(error instanceof Error)) return { type };
  /** 访问器及任意对象正文不参与诊断。 */
  const data = (key: string): PropertyDescriptor | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  };
  const safe = new Error();
  for (const key of ["name", "message", "code", "errno", "errcode", "field", "rootCauseCode", "taskId", "requestId", "runId", "workspaceId", "revision"]) {
    const descriptor = data(key);
    if (descriptor && (typeof descriptor.value === "string" || typeof descriptor.value === "number")) Object.defineProperty(safe, key, descriptor);
  }
  const cause = data("cause"), errors = data("errors");
  const length = Array.isArray(errors?.value) ? Object.getOwnPropertyDescriptor(errors.value, "length") : undefined;
  const count = length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 ? Math.min(length.value, 10) : 0;
  return { type: "Error", ...(scheduled ? toErrorLog(safe).error : describeWorkspaceProfileFailure(safe)),
    ...(depth < 3 && cause ? { cause: describeDesktopProfileFailure(cause.value, depth + 1, scheduled) } : {}),
    ...(depth < 3 && error instanceof AggregateError && Array.isArray(errors?.value)
      ? { errors: Array.from({ length: count }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
        return describeDesktopProfileFailure(item && "value" in item ? item.value : undefined, depth + 1, scheduled);
      }) } : {}),
  };
}

/** 启动时即监听父进程，关闭请求等本地资源初始化收口后交给统一入口。 */
export function createDesktopLifecycle(channel: DesktopChannel, requestId: string, input: {
  abortStartup(reason: string): void;
  initializationStopTimeoutMs?: number;
  startup?: DesktopStartupMode;
}) {
  if (!channel.send) throw new Error("DESKTOP_IPC_CHANNEL_REQUIRED");
  const startup = snapshotDesktopStartupMode(input.startup);
  let stopReason: string | null = null;
  let shutdown: DesktopShutdown | null = null;
  let shutdownResult: Promise<void> | null = null;
  let stopError: Error | undefined;
  let deliveryError: Error | undefined;
  let startupStopTimer: ReturnType<typeof setTimeout> | null = null;
  let acceptingRequests = false;
  let publishingEvents = false;
  let localEventRecovery: Promise<void> | null = null;
  let apiHandler: DesktopApiHandler | undefined;
  let updateHooks: DesktopUpdateHooks | undefined;
  let taskAdmissionPaused = startup.mode === "held";
  let startupHooks: DesktopStartupHooks | undefined;
  const startupOwner: { controller: AbortController; result?: DesktopApiResponse; failure?: AggregateError; responses: number } = {
    controller: new AbortController(), responses: 0,
  };
  let controllingUpdate: { method: DesktopUpdateControlRequest["method"]; controller: AbortController; done: Promise<void> } | null = null;
  const requests = new Set<Promise<void>>();
  const businessRequests = new Set<Promise<void>>();
  const processChanges = new Map<string, Extract<DesktopEvent, { t: "conversation.changed" }>>();
  let processChangeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 同一会话的高频过程事件只保留最新耐久版本，发送失败仍由统一投递边界处理。 */
  const flushProcessChanges = (threadId?: string): void => {
    for (const [key, event] of processChanges) {
      if (threadId && event.threadId !== threadId) continue;
      processChanges.delete(key);
      const pending = send({ t: "desktop.event", requestId, event });
      trackDelivery(pending, { requestId: `${requestId}:event:conversation.changed`, workspaceId: event.workspaceId,
        threadId: event.threadId, eventSeq: event.version }, true);
    }
    if (!processChanges.size && processChangeTimer) { clearTimeout(processChangeTimer); processChangeTimer = undefined; }
  };
  /** IPC 发送结果必须可观察；失败交给所属生命周期边界关闭。 */
  const send = (message: DesktopClientReadyMessage | DesktopApiResponseMessage | DesktopEventMessage): Promise<void> => new Promise((resolve, reject) => {
    channel.send!(message, (error) => error ? reject(error) : resolve());
  });
  /** 让就绪发送失败等待同一次清理，避免全局启动异常提前退出。 */
  const runShutdown = async (): Promise<void> => { await shutdown!(stopReason!, stopError); };
  /** 关闭只执行一次；保留首个原因，并升级已有关闭流程的失败事实。 */
  const stop = (reason: string, error?: Error, blocksDrain = true): Promise<void> | undefined => {
    stopError ??= error;
    if (blocksDrain) deliveryError ??= error;
    if (stopReason) return shutdownResult ?? undefined;
    acceptingRequests = false;
    stopReason = reason;
    if (processChangeTimer) clearTimeout(processChangeTimer);
    processChangeTimer = undefined;
    processChanges.clear();
    taskAdmissionPaused = true;
    startupOwner.controller.abort(error ?? new Error("DESKTOP_RUNTIME_NOT_READY"));
    controllingUpdate?.controller.abort(Object.assign(new Error("本地运行时正在关闭"), { code: "DESKTOP_RUNTIME_NOT_READY" }));
    if (shutdown) {
      shutdownResult = runShutdown();
      return shutdownResult;
    }
    else {
      startupStopTimer = setTimeout(() => input.abortStartup(reason), input.initializationStopTimeoutMs ?? 30_000);
      startupStopTimer.unref();
    }
  };
  /** 异步关闭失败不能变成未处理 Promise；记录后走现有非零退出入口。 */
  const requestStop = (reason: string, error?: Error, blocksDrain = true): void => {
    void stop(reason, error, blocksDrain)?.catch((cleanupError: unknown) => {
      logger.error("desktop-api", "desktop cleanup failed", { code: "DESKTOP_API_CLEANUP_FAILED", requestId, reason,
        rootCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      input.abortStartup("desktop_cleanup_failed");
    });
  };
  /** 响应移出原在途集合后关闭，首次恢复不会等待包含自己的drain。 */
  const stopAfterStartupDelivery = (): void => {
    if (startupOwner.failure && startupOwner.responses === 0) requestStop("desktop_startup_recovery_failed", startupOwner.failure, false);
  };
  /** 首次失败立即冻结；主因留给关闭，业务失败不冒充IPC资源未排空。 */
  const failStartup = (cause: unknown, stage: string, controlRequestId: string): void => {
    if (cause === startupOwner.failure && startupOwner.failure) return;
    const failure = new Error("DESKTOP_STARTUP_RECOVERY_FAILED", { cause });
    if (startupOwner.failure) startupOwner.failure.errors.push(failure);
    else startupOwner.failure = new AggregateError([failure], "DESKTOP_STARTUP_RECOVERY_FAILED", { cause });
    taskAdmissionPaused = true;
    acceptingRequests = false;
    startupOwner.controller.abort(startupOwner.failure);
    try {
      logger.error("desktop-api", "desktop first recovery failed", { code: "DESKTOP_STARTUP_RECOVERY_FAILED", requestId: controlRequestId,
        parentRequestId: requestId, stage, rootCause: { type: cause instanceof Error ? "Error" : cause === null ? "null" : typeof cause,
          fingerprint: createHash("sha256").update(cause instanceof Error ? cause.message : String(cause)).digest("hex") } });
    } catch (logError) { startupOwner.failure.errors.push(logError); }
    stopAfterStartupDelivery();
  };
  /** 同一启动只登记一次原恢复入口，结果保留供同身份请求重放。 */
  const continueStartup = (controlRequestId: string): DesktopApiResponse => {
    if (startupOwner.result) return startupOwner.result;
    if (!startupHooks) return { status: 503, body: { ok: false, code: "DESKTOP_STARTUP_UNAVAILABLE", message: "启动接续尚未就绪" } };
    startupOwner.result = { status: 200, body: { ok: true } };
    taskAdmissionPaused = false;
    try {
      startupOwner.controller.signal.throwIfAborted();
      startupHooks.recover({ requestId: controlRequestId, signal: startupOwner.controller.signal,
        fail: (cause, stage) => failStartup(cause, stage, controlRequestId) });
      if (startupOwner.failure) startupOwner.result = { status: 500, body: { ok: false, code: "DESKTOP_STARTUP_RECOVERY_FAILED", message: "启动接续失败" } };
    } catch (cause) {
      startupOwner.result = { status: 500, body: { ok: false, code: "DESKTOP_STARTUP_RECOVERY_FAILED", message: "启动接续失败" } };
      failStartup(cause, "registration", controlRequestId);
    }
    return startupOwner.result;
  };
  /** data descriptor快照拒绝访问器和额外字段，不能由旧cancel绕过。 */
  const handleStartupControl = (request: DesktopStartupControlRequest, controlRequestId: string): DesktopApiResponse => {
    const invalid = (): DesktopApiResponse => ({ status: 400, body: { ok: false, code: "DESKTOP_STARTUP_INPUT_INVALID", message: "启动接续参数无效" } });
    if (!request || typeof request !== "object" || Reflect.ownKeys(request).length !== 2) return invalid();
    const method = Object.getOwnPropertyDescriptor(request, "method"), body = Object.getOwnPropertyDescriptor(request, "body");
    if (!method || !("value" in method) || method.value !== "runtime.startup.continue" || !body || !("value" in body)
      || !body.value || typeof body.value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(body.value))
      || Reflect.ownKeys(body.value).length !== 1) return invalid();
    const id = Object.getOwnPropertyDescriptor(body.value, "continuationId");
    if (!id || !("value" in id) || typeof id.value !== "string") return invalid();
    if (startup.mode !== "held" || id.value !== startup.continuationId) return { status: 409, body: { ok: false, code: "CONFLICT", message: "启动接续身份不匹配" } };
    if (controllingUpdate) return { status: 409, body: { ok: false, code: "CONFLICT", message: "运行时控制正在执行" } };
    return continueStartup(controlRequestId);
  };
  /** 投递均进入同一在途集合，失败先移出再关闭，避免关闭等待自身。 */
  const trackDelivery = (pending: Promise<void>, context: { requestId: string; method?: unknown; eventSeq?: number; workspaceId?: string; threadId?: string }, event = false): void => {
    requests.add(pending);
    void pending.then(() => {
      requests.delete(pending); businessRequests.delete(pending);
      if (context.method === "runtime.startup.continue") { startupOwner.responses--; stopAfterStartupDelivery(); }
    }, (error: unknown) => {
      requests.delete(pending);
      businessRequests.delete(pending);
      let failure = error instanceof Error ? error : new Error(String(error), { cause: error });
      try {
        logger.error("desktop-api", "desktop IPC delivery failed", { code: event ? "DESKTOP_EVENT_DELIVERY_FAILED" : "DESKTOP_API_DELIVERY_FAILED",
          ...context, parentRequestId: requestId, rootCause: failure.message });
      } catch (logError) { failure = new AggregateError([failure, logError], "DESKTOP_IPC_DELIVERY_LOG_FAILED"); }
      publishingEvents = false;
      if (context.method === "runtime.startup.continue") startupOwner.responses--;
      requestStop(event ? "desktop_event_delivery_failed" : "desktop_api_delivery_failed",
        startupOwner.failure ? new AggregateError([startupOwner.failure, failure], "DESKTOP_STARTUP_DELIVERY_FAILED") : failure);
    });
  };
  /** 先冻结并收口已受理短请求；恢复钩子可派发，恢复失败则重新关闭围栏。 */
  const handleUpdateControl = async (request: DesktopUpdateControlRequest, controlRequestId: string): Promise<DesktopApiResponse> => {
    if (!acceptingRequests || stopReason) return { status: 503, body: { ok: false, code: "DESKTOP_RUNTIME_NOT_READY", message: "本地运行时正在关闭" } };
    if (startup.mode === "held" && (!startupOwner.result || startupOwner.failure)) return { status: 409, body: { ok: false, code: "CONFLICT", message: "首次启动接续尚未完成" } };
    if (Array.isArray(request) || Object.keys(request).some(key => key !== "method")) {
      return { status: 400, body: { ok: false, code: "DESKTOP_UPDATE_CONTROL_INVALID", message: "更新控制不接受附加参数" } };
    }
    if (!updateHooks) return { status: 503, body: { ok: false, code: "DESKTOP_UPDATE_CONTROL_UNAVAILABLE", message: "更新控制尚未接入" } };
    if (controllingUpdate) {
      if (request.method !== "runtime.update.cancel") return { status: 409, body: { ok: false, code: "DESKTOP_UPDATE_CONTROL_IN_PROGRESS", message: "更新控制正在执行" } };
      const current = controllingUpdate;
      if (current.method !== "runtime.update.cancel") current.controller.abort(Object.assign(new Error("更新已取消"), { code: "DESKTOP_UPDATE_CANCELLED" }));
      // 等待原动作真正结算；即使父请求已超时，也不能丢弃 owner 后继续停止。
      await current.done;
      return await handleUpdateControl(request, controlRequestId);
    }
    if (request.method === "runtime.update.interrupt" && !taskAdmissionPaused) {
      return { status: 409, body: { ok: false, code: "DESKTOP_UPDATE_NOT_PREPARED", message: "更新尚未暂停新任务" } };
    }
    let complete!: () => void;
    const owner = { method: request.method, controller: new AbortController(), done: new Promise<void>(resolve => { complete = resolve; }) };
    controllingUpdate = owner;
    const operation = { requestId: controlRequestId, signal: owner.controller.signal };
    try {
      if (request.method === "runtime.update.prepare") {
        taskAdmissionPaused = true;
        await Promise.all([...businessRequests]);
        operation.signal.throwIfAborted();
        if (stopReason) throw new Error("DESKTOP_RUNTIME_NOT_READY");
        const activity = await updateHooks.prepare(operation);
        operation.signal.throwIfAborted();
        if (!activity || typeof activity.hasRunningSessions !== "boolean") throw new Error("DESKTOP_UPDATE_ACTIVITY_INVALID");
        return { status: 200, body: { ok: true, hasRunningSessions: activity.hasRunningSessions } };
      }
      if (request.method === "runtime.update.cancel") {
        if (taskAdmissionPaused) {
          taskAdmissionPaused = false;
          try { await updateHooks.resume(operation); }
          catch (error) { taskAdmissionPaused = true; throw error; }
        }
      } else { await updateHooks.interrupt(operation); operation.signal.throwIfAborted(); }
      return { status: 200, body: { ok: true } };
    } finally {
      if (controllingUpdate === owner) controllingUpdate = null;
      complete();
    }
  };
  /** 请求失败在本请求内返回；更新诊断/响应再失败保双因，沿原投递边界统一关闭。 */
  const handleRequest = async (message: DesktopApiRequestMessage): Promise<void> => {
    if (message.requestId === requestId && message.id.trim() && localEventRecovery) await localEventRecovery;
    const method = message.request?.method;
    let response: DesktopApiResponse;
    let ownsFailure = true;
    let updateFailure: unknown;
    let hasUpdateFailure = false;
    let profileFailure: AggregateError | undefined;
    let scheduledFailure: AggregateError | undefined;
    let gitReadFailure: AggregateError | undefined;
    if (!message.id.trim()) response = { status: 400, body: { ok: false, code: "DESKTOP_API_REQUEST_INVALID", message: "桌面 API 缺少请求 ID" } };
    else if (message.requestId !== requestId) response = { status: 403, body: { ok: false, code: "FORBIDDEN", message: "桌面父进程关联不匹配" } };
    else if ((!acceptingRequests || stopReason) && !(isStartupControl(message.request) && startupOwner.result)
      || (!apiHandler && !isUpdateControl(message.request) && !isStartupControl(message.request))) response = { status: 503, body: { ok: false, code: "DESKTOP_RUNTIME_NOT_READY", message: "本地运行时尚未就绪或正在关闭" } };
    else {
      try {
        if (isStartupControl(message.request)) { response = handleStartupControl(message.request, message.id); ownsFailure = !(response.status === 500 && startupOwner.failure); }
        else if (isUpdateControl(message.request)) response = await handleUpdateControl(message.request, message.id);
        else {
          response = await apiHandler!(message.request, message.id);
          ownsFailure = false;
        }
      }
      catch (error) {
        if (isUpdateControl(message.request)) { updateFailure = error; hasUpdateFailure = true; }
        if (["workspaceExecutionProfile.get", "workspaceExecutionProfile.update", "workspaceExecutionProfile.status"].includes(String(method))
          && error instanceof AggregateError && Object.getOwnPropertyDescriptor(error, "message")?.value === "WORKSPACE_PROFILE_FAILURE_LOG_FAILED") profileFailure = error;
        if (typeof method === "string" && method.startsWith("scheduledTasks.local.") && error instanceof AggregateError) {
          const code = Object.getOwnPropertyDescriptor(error, "code");
          if (code && "value" in code && ["SCHEDULED_TASK_REQUEST_LOG_FAILED", "SCHEDULED_TASK_TRANSACTION_LOG_FAILED", "SCHEDULED_TASK_EXECUTION_LOG_FAILED"].includes(code.value)) scheduledFailure = error;
        }
        if (typeof method === "string" && ["git.status", "git.diff", "git.diffFiles"].includes(method) && error instanceof AggregateError) {
          const code = Object.getOwnPropertyDescriptor(error, "code");
          if (code && "value" in code && ["GIT_STATUS_METADATA_LOG_FAILED", "GIT_READ_REQUEST_LOG_FAILED", "GIT_READ_RESPONSE_FAILED"].includes(code.value)) gitReadFailure = error;
        }
        const rootCause = error instanceof Error ? error.message : String(error);
        response = { status: 500, body: { ok: false, code: isUpdateControl(message.request) ? "DESKTOP_UPDATE_CONTROL_FAILED" : "DESKTOP_API_REQUEST_FAILED",
          message: isUpdateControl(message.request) ? "更新控制失败，请重试并查看诊断" : rootCause } };
      }
    }
    if (ownsFailure && response.status >= 400) {
      const failure = response.body as { code?: unknown; message?: unknown } | null;
      try {
        const body = message.request && typeof message.request === "object" ? Object.getOwnPropertyDescriptor(message.request, "body") : undefined;
        const bodyValue: unknown = body && "value" in body ? body.value : undefined;
        const workspace = !isStartupControl(message.request) && bodyValue && typeof bodyValue === "object"
          ? Object.getOwnPropertyDescriptor(bodyValue, "workspaceId") : undefined;
        logger[response.status >= 500 ? "error" : "warn"]("desktop-api", "desktop API request failed", {
          code: failure?.code ?? "DESKTOP_API_REQUEST_FAILED", requestId: message.id, parentRequestId: requestId,
          method, workspaceId: workspace && "value" in workspace && typeof workspace.value === "string" ? workspace.value : null, status: response.status,
          rootCause: gitReadFailure ? describeDesktopProfileFailure(gitReadFailure, 0, true) : scheduledFailure ? describeDesktopProfileFailure(scheduledFailure, 0, true) : profileFailure ? describeDesktopProfileFailure(profileFailure) : hasUpdateFailure ? { type: updateFailure instanceof Error ? "Error" : typeof updateFailure,
            fingerprint: createHash("sha256").update(updateFailure instanceof Error ? updateFailure.message : String(updateFailure)).digest("hex") } : failure?.message ?? "request failed",
        });
      } catch (logError) {
        // 诊断失败沿原投递失败边界显式拒绝，cause 保留完整原聚合。
        if (profileFailure) throw new AggregateError([profileFailure, logError], "DESKTOP_PROFILE_FAILURE_DIAGNOSTIC_FAILED", { cause: profileFailure });
        if (scheduledFailure) throw new AggregateError([scheduledFailure, logError], "DESKTOP_SCHEDULED_TASK_FAILURE_DIAGNOSTIC_FAILED", { cause: scheduledFailure });
        if (gitReadFailure) throw new AggregateError([gitReadFailure, logError], "DESKTOP_GIT_READ_FAILURE_DIAGNOSTIC_FAILED", { cause: gitReadFailure });
        if (hasUpdateFailure) throw new AggregateError([updateFailure, logError], "DESKTOP_UPDATE_CONTROL_DIAGNOSTIC_FAILED", { cause: updateFailure });
        throw logError;
      }
    }
    try { await send({ t: "desktop.api.res", requestId, id: message.id, response }); }
    catch (error) {
      if (gitReadFailure) throw Object.assign(new AggregateError([gitReadFailure, error], "GIT_READ_RESPONSE_FAILED", { cause: gitReadFailure }), { code: "GIT_READ_RESPONSE_FAILED" });
      if (hasUpdateFailure) throw new AggregateError([updateFailure, error], "DESKTOP_UPDATE_CONTROL_RESPONSE_FAILED", { cause: updateFailure });
      throw error;
    }
  };
  channel.on("message", (message: unknown) => {
    const value = message as { t?: unknown; requestId?: unknown; id?: unknown; request?: unknown } | null;
    if (value?.t === "desktop.shutdown" && value.requestId === requestId) requestStop("desktop_exit");
    if (value?.t !== "desktop.api.req") return;
    if (isStartupControl(value.request as DesktopRuntimeRequest)) startupOwner.responses++;
    const pending = handleRequest({ ...value, id: typeof value.id === "string" ? value.id : "" } as DesktopApiRequestMessage);
    // 长任务由 Scheduler 的原 owner 管理更新停止，仍参与 requests 的全局退出排空。
    if (!isUpdateControl(value.request as DesktopRuntimeRequest) && !isStartupControl(value.request as DesktopRuntimeRequest)
      && (value.request as DesktopApiRequest | undefined)?.method !== "scheduledTasks.local.runNow") businessRequests.add(pending);
    trackDelivery(pending, { requestId: typeof value.id === "string" ? value.id : "", method: (value.request as DesktopApiRequest | undefined)?.method });
  });
  channel.on("disconnect", () => { publishingEvents = false; requestStop("desktop_parent_disconnected"); });
  if (channel.connected === false) stop("desktop_parent_disconnected");
  return {
    /** 所有任务入口读取同一可逆更新围栏，不自行持有暂停状态。 */
    isTaskAdmissionPaused(): boolean { return taskAdmissionPaused; },
    /** 发布已提交事实；过程正文在桥发送前替换为合并版本通知。 */
    publishEvent(event: DesktopEvent): void {
      if (!publishingEvents || channel.connected === false) throw new Error("DESKTOP_EVENT_NOT_READY");
      if (isDesktopTerminalEvent(event)) {
        // 终端事件形状与 clientId/workspaceId 归属已由共享契约严格校验。
      } else if (event?.t === "engineKeys.changed") {
        if (Object.keys(event).some(key => key !== "t")) throw new Error("DESKTOP_EVENT_INVALID");
      } else if (event?.t === "reminders.changed") {
        if (typeof event.workspaceId !== "string" || !event.workspaceId.trim()
          || Object.keys(event).some(key => !["t", "workspaceId"].includes(key))) throw new Error("DESKTOP_EVENT_INVALID");
      } else if (event?.t === "thread.queue.changed") {
        if (typeof event.workspaceId !== "string" || !event.workspaceId.trim() || typeof event.threadId !== "string" || !event.threadId.trim()
          || typeof event.reason !== "string" || !event.reason.trim()) throw new Error("DESKTOP_EVENT_INVALID");
      } else if (event?.t === "orchestration.event") {
        const record = event.event;
        if (typeof event.workspaceId !== "string" || !event.workspaceId.trim() || typeof record?.id !== "string" || !record.id.trim()
          || typeof record.instanceId !== "string" || !record.instanceId.trim() || typeof record.type !== "string" || !record.type.trim()
          || typeof record.payloadJson !== "string" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
          || record.nodeId != null && typeof record.nodeId !== "string") throw new Error("DESKTOP_EVENT_INVALID");
      } else if (event?.t === "conversation.changed") {
        if (!isConversationChangedMessage(event)) throw new Error("DESKTOP_EVENT_INVALID");
      } else if (event?.t !== "conversation.event" || event.event?.schema !== 1 || !Number.isSafeInteger(event.event.seq) || event.event.seq <= 0) {
        throw new Error("DESKTOP_EVENT_INVALID");
      }
      if (event.t === "conversation.event") {
        const displayMessage = toConversationDisplayMessage(event.event);
        if (displayMessage.t === "conversation.changed") event = displayMessage;
        else if (event.event.type === "turn.completed" || event.event.type === "turn.error") flushProcessChanges(event.event.threadId);
      }
      if (event.t === "conversation.changed") {
        if (event.toolCompleted) {
          flushProcessChanges(event.threadId);
          const pending = send({ t: "desktop.event", requestId, event });
          trackDelivery(pending, { requestId: `${requestId}:event:conversation.changed`, workspaceId: event.workspaceId,
            threadId: event.threadId, eventSeq: event.version }, true);
          return;
        }
        const key = JSON.stringify([event.workspaceId, event.threadId]);
        const previous = processChanges.get(key);
        if (!previous || event.version > previous.version) processChanges.set(key, event);
        if (!processChangeTimer) {
          processChangeTimer = setTimeout(() => { processChangeTimer = undefined; flushProcessChanges(); }, 150);
          processChangeTimer.unref();
        }
        return;
      }
      const metadata = event.t === "conversation.event" ? { workspaceId: event.event.workspaceId, threadId: event.event.threadId, eventSeq: event.event.seq }
        : event.t === "orchestration.event" ? { workspaceId: event.workspaceId, instanceId: event.event.instanceId }
        : event.t === "thread.queue.changed" ? { workspaceId: event.workspaceId, threadId: event.threadId }
        : event.t === "reminders.changed" ? { workspaceId: event.workspaceId }
        : isDesktopTerminalEvent(event) ? { workspaceId: event.t === "terminal.created" ? event.terminal.workspaceId : event.workspaceId,
          terminalId: event.t === "terminal.created" ? event.terminal.id : "terminalId" in event ? event.terminalId ?? null : null } : {};
      const pending = send({ t: "desktop.event", requestId, event });
      trackDelivery(pending, { requestId: `${requestId}:event:${event.t}`, ...metadata }, true);
    },
    /** 先禁止新API并排空；关闭生产者前可保留事件发布，最终默认排空才关闭发布。 */
    async drainRequests(timeoutMs = 10_000, options?: { keepEventPublishing?: boolean }): Promise<void> {
      acceptingRequests = false;
      flushProcessChanges();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            do {
              if (requests.size) await Promise.all([...requests]);
              flushProcessChanges();
            } while (requests.size || processChanges.size);
            if (deliveryError) throw deliveryError;
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("DESKTOP_API_DRAIN_TIMEOUT")), timeoutMs);
          }),
        ]);
      } finally {
        if (!options?.keepEventPublishing) {
          publishingEvents = false;
          if (processChangeTimer) clearTimeout(processChangeTimer);
          processChangeTimer = undefined;
          processChanges.clear();
        }
        if (timer) clearTimeout(timer);
      }
    },
    /** 注册统一清理后等待实际健康；异步检查期间停止也不得发布迟到就绪。 */
    async ready(onShutdown: DesktopShutdown, getHealth: () => DesktopClientHealth | Promise<DesktopClientHealth>, onApiRequest?: DesktopApiHandler, onUpdate?: DesktopUpdateHooks, onStartup?: DesktopStartupHooks): Promise<void> {
      if (startupStopTimer) clearTimeout(startupStopTimer);
      shutdown = onShutdown;
      if (stopReason) {
        shutdownResult = runShutdown();
        await shutdownResult;
        return;
      }
      try {
        apiHandler = onApiRequest;
        updateHooks = onUpdate;
        startupHooks = onStartup;
        const health = await getHealth();
        if (stopReason) { await shutdownResult; return; }
        const message: DesktopClientReadyMessage = { t: "desktop.ready", requestId, health,
          ...(startup.mode === "held" ? { startup: { continuationId: startup.continuationId, admission: "paused" as const } } : {}) };
        await send(message);
        publishingEvents = !stopReason;
        localEventRecovery = startupHooks?.recoverLocalEvents?.() ?? null;
        if (localEventRecovery) {
          await localEventRecovery;
          localEventRecovery = null;
        }
        if (stopReason) { await shutdownResult; return; }
        acceptingRequests = true;
      } catch (error) {
        try {
          await stop("desktop_ready_failed", error instanceof Error ? error : new Error(String(error)));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "DESKTOP_READY_CLEANUP_FAILED");
        }
        throw error;
      }
      if (!stopReason && startup.mode === "automatic" && startupHooks) continueStartup(requestId);
    },
  };
}

/** 在打开数据库前拒绝壳预期之外的结构迁移，保持旧版本仍能接管数据。 */
export function assertDesktopDbSchemaVersion(expected: string | undefined): void {
  if (expected === undefined) return;
  if (expected !== String(CLIENT_DB_SCHEMA_VERSION)) {
    throw new Error(`DESKTOP_DB_SCHEMA_INCOMPATIBLE: expected=${expected}, client=${CLIENT_DB_SCHEMA_VERSION}`);
  }
}

/** 读取实际 SQLite 结构并执行查询；任何失败均不发布 ready。 */
export function readDesktopClientHealth(db: SqliteDb, clientVersion: string | null): DesktopClientHealth {
  if (!clientVersion?.trim()) throw new Error("DESKTOP_CLIENT_VERSION_REQUIRED");
  const dbSchemaVersion = Number(db.pragma("user_version", { simple: true }));
  if (dbSchemaVersion !== CLIENT_DB_SCHEMA_VERSION) {
    throw new Error(`DESKTOP_DB_SCHEMA_MISMATCH: expected=${CLIENT_DB_SCHEMA_VERSION}, actual=${dbSchemaVersion}`);
  }
  db.prepare("SELECT 1 AS ready").get();
  return { protocolVersion: 1, clientVersion: clientVersion.trim(), dbSchemaVersion, database: "ready" };
}
