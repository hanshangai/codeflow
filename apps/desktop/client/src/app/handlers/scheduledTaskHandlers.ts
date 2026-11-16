import crypto from "node:crypto";
import { computeNextCronTimeMsList, parseCronExpression, type ApiErrorCode, type DesktopApiResponse, type DesktopAccountScheduledTaskListResponseBody,
  type LocalScheduledTaskConfig, type LocalScheduledTaskConfigInput, type ScheduledTaskRunNowClientResponseBody, type WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { ScheduledTaskConfigError } from "../../db/repos/scheduledTaskConfigRepo.js";
import { ScheduledTaskRunError } from "../../db/repos/scheduledTaskRunRepo.js";
import { isScheduledTaskDiagnosticFailure, toErrorLog } from "../../scheduled-tasks/scheduledTaskScheduler.js";
import { logger } from "../../logger.js";
import { isDesktopLocalAssetWorkspace } from "../../orchestration/desktopBuiltinAssetService.js";
import { WorkspaceOperationGateError } from "../../workspace-migration/workspaceOperationGate.js";
import { ScheduledTaskAccountConfigError } from "../../db/repos/scheduledTaskAccountConfigRepo.js";

const EDITABLE_FIELDS = ["name", "description", "taskType", "cronExpr", "timezone", "enabled", "payload", "concurrencyPolicy", "missedPolicy", "timeoutMs"] as const;

/** 配置、快照与诊断持同步短许可，调度和网络等待仍由原owner管理。 */
function withScheduledTaskDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 桌面账号列表投影可信Host设备，配置/运行/历史沿原身份与诊断边界。 */
export async function handleAccountScheduledTaskConfigRequest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const action = req.method.slice("scheduledTasks.account.".length);
  try {
    if (!ctx.localWorkspaceOnly || !ctx.scheduledTaskScheduler) throw new Error("SCHEDULED_TASK_DESKTOP_REQUIRED");
    if (!record(req.body)) throw new Error("SCHEDULED_TASK_CONFIG_REQUEST_INVALID");
    const scheduler = ctx.scheduledTaskScheduler, body = req.body as Record<string, unknown>;
    let result: Record<string, unknown>;
    if (action === "list" || action === "sync") {
      const clientId = identity(ctx.clientId, "clientId"), deviceId = identity(ctx.deviceId, "deviceId");
      if (action === "sync") await scheduler.refreshAccountConfigs(req.id);
      result = { clientId, deviceId, items: await withScheduledTaskDatabase(ctx, req.id, () => scheduler.listAccountConfigs()) } satisfies DesktopAccountScheduledTaskListResponseBody;
    } else if (action === "runs") result = await withScheduledTaskDatabase(ctx, req.id, () => scheduler.listAccountRuns({ ...(body.taskId === undefined ? {} : { taskId: identity(body.taskId, "taskId") }),
      offset: body.offset === undefined ? 0 : integer(body.offset, "offset", 0), limit: body.limit === undefined ? 20 : integer(body.limit, "limit", 1, 200) }));
    else if (action === "runNow") result = { run: await scheduler.runNow(identity(body.taskId, "taskId")) };
    else if (action === "update" || action === "delete") {
      const taskId = identity(body.taskId, "taskId"), expectedLocalRevision = integer(body.expectedLocalRevision, "expectedLocalRevision", 0);
      const item = await scheduler.reviseAccountConfig({ taskId, expectedLocalRevision, operation: action === "delete" ? "delete" : "update",
        ...(action === "update" ? { config: body.config as never } : {}) });
      result = action === "delete" ? { deleted: true } : { item };
    } else throw new Error("SCHEDULED_TASK_CONFIG_REQUEST_INVALID");
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
  } catch (cause) {
    if (isScheduledTaskDiagnosticFailure(cause)) throw cause;
    const safe = toErrorLog(cause).error;
    try {
      if (!(cause as { scheduledTaskFailureLogged?: boolean } | null)?.scheduledTaskFailureLogged) logger.error("scheduled-tasks", "account configuration request failed", {
        errorCode: safe.systemCode ?? "SCHEDULED_TASK_ACCOUNT_CONFIG_REQUEST_FAILED", requestId: req.id, clientId: ctx.clientId, deviceId: ctx.deviceId,
        taskId: safe.taskId, ownerUserId: safe.ownerUserId, rootCause: safe,
      });
    } catch (diagnostic) { throw Object.assign(new AggregateError([cause, diagnostic], "SCHEDULED_TASK_REQUEST_LOG_FAILED", { cause }), { code: "SCHEDULED_TASK_REQUEST_LOG_FAILED" }); }
    ctx.onApiFailureLogged?.();
    const conflict = cause instanceof ScheduledTaskAccountConfigError && cause.code === "SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT";
    const failureMessage = action === "runs" ? "账号任务历史读取失败，请查看诊断" : action === "runNow" ? "账号任务运行失败，请查看诊断" : "账号任务配置操作失败，请重新同步";
    ctx.send({ t: "api.res", id: req.id, status: conflict ? 409 : 500,
      body: { ok: false, code: conflict ? "CONFLICT" : "CLIENT_ERROR", message: conflict ? "任务已变化，请刷新后重试" : failureMessage } });
    // 诊断和失败响应均完成后才标记；投递失败仍阻止退出排空成功。
    if (cause instanceof Error) Object.assign(cause, { scheduledTaskFailureLogged: true });
  }
}

class LocalTaskRequestError extends Error {
  /** 仅保留固定失败原因和字段，不包含 renderer 正文。 */
  constructor(readonly status: number, readonly reason: string, readonly field: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** 本机桥只固定可信设备和 scope；配置 CAS、停删消费与运行仍归原仓储和 Scheduler。 */
export async function handleLocalScheduledTaskRequest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  let response: DesktopApiResponse;
  let task: LocalScheduledTaskConfig | undefined;
  let requestWorkspaceId: WorkspaceId | null = null;
  const body = req.body;
  try {
    if (ctx.localWorkspaceOnly !== true || typeof ctx.deviceId !== "string" || !ctx.deviceId.trim()) {
      throw new LocalTaskRequestError(403, "SCHEDULED_TASK_LOCAL_CONTEXT_REQUIRED", "deviceId", "仅允许可信桌面本机任务请求");
    }
    if (!record(body)) invalid("body");
    const action = req.method.slice("scheduledTasks.local.".length), input = body as Record<string, unknown>;
    const device = { clientId: ctx.clientId, deviceId: ctx.deviceId };
    let result: Record<string, unknown>;
    if (action === "list") {
      const { offset, limit } = pagination(input);
      if (input.taskType !== undefined && input.taskType !== "script" && input.taskType !== "workflow") invalid("taskType");
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") invalid("enabled");
      const items = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.listLocalScheduledTaskConfigs(device).filter(config => (input.taskType === undefined || config.taskType === input.taskType)
        && (input.enabled === undefined || config.enabled === input.enabled)));
      result = { items: items.slice(offset, offset + limit), total: items.length };
    } else if (action === "runs") {
      const { offset, limit } = pagination(input);
      const taskId = input.taskId === undefined ? undefined : identity(input.taskId, "taskId");
      result = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.listLocalScheduledTaskRuns({ ...device, ...(taskId ? { taskId } : {}), offset, limit }));
    } else if (action === "cronPreview") {
      try { result = previewCron(input); }
      catch (error) {
        if (!(error instanceof LocalTaskRequestError) || error.reason !== "SCHEDULED_TASK_LOCAL_CRON_INVALID") throw error;
        await withScheduledTaskDatabase(ctx, req.id, () => logLocalTaskFailure(ctx, req, error));
        result = { valid: false, message: "cron 或时区无效，或未来一年内没有可执行时间", nextRunAts: [] };
      }
    } else if (action === "create") {
      const config = await withScheduledTaskDatabase(ctx, req.id, () => prepareLocalConfig(ctx, input, crypto.randomUUID()));
      requestWorkspaceId = config.workspaceScope?.scopeId as WorkspaceId | undefined ?? null;
      assertExecutableCron(config);
      task = await withScheduledTaskDatabase(ctx, req.id, () => {
        if (ctx.db.getLocalScheduledTask(config.id)) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT",config.id,"id");
        return ctx.db.withLocalScheduledTasks(config.workspaceScope?.scopeId as WorkspaceId | undefined ?? null,
          repos => repos.configs.create({ config, at: Date.now() }));
      });
      result = { task };
    } else if (action === "update" || action === "setEnabled" || action === "delete" || action === "runNow") {
      const taskId = identity(input.taskId, "taskId");
      const existing = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.getLocalScheduledTask(taskId));
      if (!existing || existing.clientId !== device.clientId || existing.deviceId !== device.deviceId) {
        throw new LocalTaskRequestError(404, "SCHEDULED_TASK_LOCAL_NOT_FOUND", "taskId", "本机任务不存在");
      }
      task = existing;
      if (action === "runNow") {
        if (!ctx.scheduledTaskScheduler) throw new LocalTaskRequestError(503, "SCHEDULED_TASK_SCHEDULER_UNAVAILABLE", "scheduler", "定时任务调度器未启动");
        result = { run: await ctx.scheduledTaskScheduler.runLocalNow(taskId) };
      } else {
        const expectedRevision = integer(input.expectedRevision, "expectedRevision", 1);
        if (action === "update") {
          const config = await withScheduledTaskDatabase(ctx, req.id, () => prepareLocalConfig(ctx, input, taskId));
          assertExecutableCron(config);
          task = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.withLocalScheduledTasks(existing.workspaceScope?.scopeId as WorkspaceId | undefined ?? null,
            repos => repos.configs.update({ config, expectedRevision, at: Date.now() })));
        } else if (action === "setEnabled") {
          if (typeof input.enabled !== "boolean") invalid("enabled");
          if (input.enabled) assertExecutableCron(existing);
          task = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.withLocalScheduledTasks(existing.workspaceScope?.scopeId as WorkspaceId | undefined ?? null,
            repos => repos.configs.setEnabled({ taskId, expectedRevision, enabled: input.enabled as boolean, at: Date.now() })));
        } else { task = await withScheduledTaskDatabase(ctx, req.id, () => ctx.db.withLocalScheduledTasks(existing.workspaceScope?.scopeId as WorkspaceId | undefined ?? null,
          repos => repos.configs.delete({ taskId, expectedRevision, at: Date.now() }))); }
        result = { ...(action === "delete" ? { deleted: true } : {}), task };
      }
    } else { throw new LocalTaskRequestError(404, "SCHEDULED_TASK_LOCAL_METHOD_NOT_FOUND", "method", "本机任务方法不存在"); }
    response = { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    await withScheduledTaskDatabase(ctx, req.id, () => logLocalTaskFailure(ctx, req, error, task, requestWorkspaceId));
    const failure = translateLocalTaskFailure(error);
    response = { status: failure.status, body: { ok: false, code: failure.code, message: failure.message,
      details: { reason: failure.reason, field: failure.field, ...(task ? { revision: task.revision } : {}), ...failure.details } } };
  }
  ctx.send({ t: "api.res", id: req.id, ...response });
}

/** 按两类 payload 白名单重建业务字段，scope 只由可信工作区查验派生。 */
function prepareLocalConfig(ctx: ApiHandlerContext, input: Record<string, unknown>, id: string): LocalScheduledTaskConfigInput {
  if (input.taskType !== "script" && input.taskType !== "workflow") invalid("taskType");
  const fields = input.taskType === "script" ? ["shell", "command", "contextWorkspaceId", "cwdRelative", "envRefs"]
    : ["workflowId", "contextWorkspaceId", "workflowVersionPolicy", "intake", "runMode", "approvalMode", "interactionMode", "skipWhenPreviousInstanceStatuses"];
  assertFields(input.payload, fields, "payload");
  const payload = Object.fromEntries(Object.entries(input.payload as Record<string, unknown>));
  let workspaceScope: LocalScheduledTaskConfigInput["workspaceScope"] = null;
  if (payload.contextWorkspaceId != null) {
    const workspaceId = identity(payload.contextWorkspaceId, "payload.contextWorkspaceId") as WorkspaceId;
    if (!isDesktopLocalAssetWorkspace(ctx.clientId, ctx.workspaces, workspaceId)) invalid("payload.contextWorkspaceId");
    const persisted = ctx.db.workspaces.get(workspaceId), hosted = ctx.workspaces.get(workspaceId);
    if (!persisted || !hosted || persisted.path !== hosted) {
      throw new LocalTaskRequestError(404, "SCHEDULED_TASK_LOCAL_WORKSPACE_NOT_FOUND", "payload.contextWorkspaceId", "工作区不存在或未由本机承载");
    }
    workspaceScope = { scopeType: "local_workspace", scopeId: workspaceId };
  }
  const editable = Object.fromEntries(EDITABLE_FIELDS.map(field => [field, field === "payload" ? payload : input[field]]));
  return { ...editable, id, clientId: ctx.clientId, deviceId: ctx.deviceId!, source: "local", workspaceScope } as LocalScheduledTaskConfigInput;
}

/** 保存或启用前必须存在真实执行点；停用和删除不依赖下一执行时间。 */
function assertExecutableCron(config: LocalScheduledTaskConfigInput): void {
  if (typeof config.cronExpr !== "string" || !config.cronExpr.trim()) invalid("cronExpr");
  if (typeof config.timezone !== "string" || !config.timezone.trim() || config.timezone !== config.timezone.trim()) invalid("timezone");
  computeLocalCronTimes(config.cronExpr, config.timezone, Date.now(), 1);
}

/** 复用原预览合同，格式或不可执行 cron 显式返回 valid=false；请求形状错误为 400。 */
function previewCron(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.cronExpr !== "string") invalid("cronExpr");
  if (input.timezone != null && typeof input.timezone !== "string") invalid("timezone");
  if (input.count != null) integer(input.count, "count", 1, 10);
  if (input.afterMs != null) integer(input.afterMs, "afterMs", 0, 8_640_000_000_000_000);
  return { valid: true, message: null, nextRunAts: computeLocalCronTimes(input.cronExpr as string,
    input.timezone as string | null ?? "Asia/Shanghai", input.afterMs as number | null ?? Date.now(), input.count as number | null ?? 5) };
}

/** 纯语法、Intl 的非法时区和固定无执行点码是输入失败；未知运行故障继续抛出。 */
function computeLocalCronTimes(cronExpr: string, timezone: string, afterMs: number, count: number): number[] {
  try { parseCronExpression(cronExpr); }
  catch (cause) { throw new LocalTaskRequestError(400, "SCHEDULED_TASK_LOCAL_CRON_INVALID", "cronExpr", "cron 表达式无效", cause); }
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
  catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw new LocalTaskRequestError(400, "SCHEDULED_TASK_LOCAL_CRON_INVALID", "timezone", "时区无效", cause);
  }
  try { return computeNextCronTimeMsList(cronExpr, afterMs, timezone, count); }
  catch (cause) {
    if ((cause as { code?: unknown } | null)?.code !== "SCHEDULED_TASK_CRON_NO_EXECUTION_TIME") throw cause;
    throw new LocalTaskRequestError(400, "SCHEDULED_TASK_LOCAL_CRON_INVALID", "cronExpr", "cron 未来一年内没有可执行时间", cause);
  }
}

/** 分页只接受受限安全整数，沿运行历史默认每页 50、上限 200。 */
function pagination(input: Record<string, unknown>): { offset: number; limit: number } {
  return { offset: input.offset === undefined ? 0 : integer(input.offset, "offset", 0), limit: input.limit === undefined ? 50 : integer(input.limit, "limit", 1, 200) };
}

/** 两类 payload 只接受既有业务字段；顶层字段复用桌面唯一白名单。 */
function assertFields(value: unknown, fields: readonly string[], field: string): void {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) invalid(field);
}

/** 标识不归一化，拒绝校验与保存的实际值不一致。 */
function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) invalid(field);
  return value as string;
}

/** 数字不隐式转换或截断，避免 CAS 和分页误用。 */
function integer(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value as number;
}

/** 本机请求对象必须是 JSON 对象。 */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** 输入错误固定失败，不回显任意配置正文。 */
function invalid(field: string): never { throw new LocalTaskRequestError(400, "SCHEDULED_TASK_LOCAL_INPUT_INVALID", field, "本机任务参数无效"); }

/** 请求边界关联安全领域投影；预览 valid=false 同样记录根因且不重复经 adapter 记录。 */
function logLocalTaskFailure(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown, task?: LocalScheduledTaskConfig, requestWorkspaceId: WorkspaceId | null = null): void {
  let code: PropertyDescriptor | undefined, logged: PropertyDescriptor | undefined;
  try {
    code = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    logged = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "scheduledTaskFailureLogged") : undefined;
  } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_REQUEST_LOG_FAILED", { cause: error }),
    { code: "SCHEDULED_TASK_REQUEST_LOG_FAILED" }); }
  if (error instanceof AggregateError && code && "value" in code
    && ["SCHEDULED_TASK_TRANSACTION_LOG_FAILED", "SCHEDULED_TASK_EXECUTION_LOG_FAILED", "SCHEDULED_TASK_REQUEST_LOG_FAILED"].includes(code.value)) throw error;
  if (logged && "value" in logged && logged.value === true) { ctx.onApiFailureLogged?.(); return; }
  try {
    const failure = translateLocalTaskFailure(error), safe = toErrorLog(error).error;
    const body = record(req.body) ? req.body : {};
    const data = {
      code: failure.reason, errorCode: failure.reason, event: { category: "scheduled-tasks", action: req.method, outcome: "fail" }, requestId: req.id, method: req.method, clientId: ctx.clientId, deviceId: ctx.deviceId ?? null,
      taskId: safe.taskId ?? task?.id ?? (typeof body.taskId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(body.taskId) ? body.taskId : null),
      runId: safe.runId ?? null, revision: task?.revision ?? safe.revision ?? null,
      expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : null,
      workspaceId: task?.workspaceScope?.scopeId ?? safe.workspaceId ?? null, rootCause: safe,
      ...(error instanceof WorkspaceOperationGateError ? { operationId: error.details.operationId ?? null } : {}),
    };
    // 领域错误只信真实 ClientDb 回调注入的物理 W；安全投影不提供归属。
    const domainWorkspace = error instanceof ScheduledTaskConfigError || error instanceof ScheduledTaskRunError
      ? Object.getOwnPropertyDescriptor(error, "workspaceId") : undefined;
    const workspaceId = task?.workspaceScope?.scopeId ?? requestWorkspaceId
      ?? (domainWorkspace && "value" in domainWorkspace && typeof domainWorkspace.value === "string" ? domainWorkspace.value as WorkspaceId : null);
    if (ctx.localWorkspaceOnly === true && workspaceId) ctx.db.writeWorkspaceLog(workspaceId as WorkspaceId, {
      level: failure.status >= 500 ? "error" : "warn", tag: "scheduled-tasks", message: "local scheduled task request failed", data: { ...data, workspaceId },
    });
    else logger[failure.status >= 500 ? "error" : "warn"]("scheduled-tasks", "local scheduled task request failed", data);
  } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_REQUEST_LOG_FAILED", { cause: error }),
    { code: "SCHEDULED_TASK_REQUEST_LOG_FAILED" }); }
  ctx.onApiFailureLogged?.();
}

/** 只翻译可信领域错误；未知、损坏和存储失败一律显式 500 且不反射异常正文。 */
function translateLocalTaskFailure(error: unknown): { status: number; code: ApiErrorCode | WorkspaceOperationGateError["code"]; reason: string; field: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof WorkspaceOperationGateError) return { status: 409, code: error.code, reason: error.code,
    field: "workspaceId", message: "工作区正在迁移或忙碌，请稍后重试", details: error.details };
  let status = 500, reason = "SCHEDULED_TASK_LOCAL_REQUEST_FAILED", field = "request";
  if (error instanceof LocalTaskRequestError) { status = error.status; reason = error.reason; field = error.field; }
  else if (error instanceof ScheduledTaskConfigError || error instanceof ScheduledTaskRunError) {
    reason = error.code; field = error.field;
    if (["SCHEDULED_TASK_CONFIG_INVALID", "SCHEDULED_TASK_RUN_INVALID"].includes(error.code)) status = 400;
    else if (["SCHEDULED_TASK_CONFIG_CONFLICT", "SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE", "SCHEDULED_TASK_RUN_CONFIG_CONFLICT", "SCHEDULED_TASK_RUN_CONFLICT"].includes(error.code)) status = 409;
  } else {
    const descriptor = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (["SCHEDULED_TASK_LOCAL_UNAVAILABLE", "SCHEDULED_TASK_ALREADY_RUNNING", "SCHEDULED_TASK_ORPHAN_RUNNING", "DESKTOP_UPDATE_TASKS_PAUSED"].includes(code as string)) { status = 409; reason = code as string; }
    else if (code === "SCHEDULED_TASK_LOCAL_SCOPE_INVALID") { status = 403; reason = code; }
  }
  const code: ApiErrorCode = status === 400 ? "BAD_REQUEST" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INTERNAL_ERROR";
  return { status, code, reason, field, message: error instanceof LocalTaskRequestError ? error.message
    : status === 400 ? "本机任务参数无效" : status === 409 ? "本机任务配置或运行状态已变化，请刷新后重试" : status === 403 ? "本机任务归属无效" : "本机任务操作失败，请查看诊断" };
}

/** 账号请求沿原单日志标记消费，诊断失败继续拒绝；尚未归属W的请求失败保应用日志。 */
export async function handleScheduledTaskRunNow(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const scheduler = ctx.scheduledTaskScheduler;
  if (!scheduler) {
    ctx.send({ t: "api.res", id: req.id, status: 503, body: { ok: false, message: "定时任务调度器未启动" } });
    return;
  }
  const taskId = String((req.body as any)?.taskId ?? "").trim();
  if (!taskId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：taskId" } });
    return;
  }
  try {
    const run = await scheduler.runNow(taskId);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, run } satisfies ScheduledTaskRunNowClientResponseBody & { ok: true } });
  } catch (error) {
    if (isScheduledTaskDiagnosticFailure(error)) throw error;
    try {
      const logged = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "scheduledTaskFailureLogged") : undefined;
      if (!(logged && "value" in logged && logged.value === true)) {
        const safe = toErrorLog(error).error;
        logger.error("scheduled-tasks", "account scheduled task run request failed", {
          code: safe.systemCode ?? "SCHEDULED_TASK_RUN_REQUEST_FAILED", requestId: req.id,
          taskId: /^[A-Za-z0-9._:-]{1,160}$/.test(taskId) ? taskId : null,
          clientId: ctx.clientId, deviceId: ctx.deviceId ?? null, rootCause: safe,
        });
      }
    } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_REQUEST_LOG_FAILED", { cause: error }),
      { code: "SCHEDULED_TASK_REQUEST_LOG_FAILED" }); }
    ctx.onApiFailureLogged?.();
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, message: error instanceof Error ? error.message : String(error) },
    });
  }
}
