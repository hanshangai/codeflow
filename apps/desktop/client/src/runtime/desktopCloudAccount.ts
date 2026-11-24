import type { ClientToServerMessage, DesktopCloudAccountState, ServerToClientMessage, HostRpcHttpTask, HostRpcHttpResultMessage,
  ClientScheduledTaskReportRequestBody, ClientScheduledTaskReportResponseBody, ClientScheduledTaskSyncResponseBody,
  ClientScheduledTaskConfigWritebackRequestBody, ClientScheduledTaskConfigWritebackResponseBody } from "@codeflowai/shared";
import crypto from "node:crypto";
import { WsTransport, type WsSendJsonResult } from "../transport/wsTransport.js";
import { logger } from "../logger.js";
import { HostRpcHttpTransport } from "../transport/hostRpcHttpTransport.js";
import { ServerMessageHelloReadyFence } from "../transport/serverMessageHelloReadyFence.js";
import { createCodeAttributionHttpTransport, type CodeAttributionHttpTransport } from "../orchestration/codeAttributionHttpTransport.js";

export type DesktopCloudAccountOwner = { serverOrigin: string; ownerUserId: string; accountSessionId: string; generation: number };
type Hello = Extract<ServerToClientMessage, { t: "client.helloAck" }>;
type LinkInput = { serverOrigin: string; sessionToken: string };
type TaskAction = "sync" | "report" | "config";
type TaskResponse<Action extends TaskAction> = Action extends "config" ? ClientScheduledTaskConfigWritebackResponseBody
  : Action extends "sync" ? ClientScheduledTaskSyncResponseBody : ClientScheduledTaskReportResponseBody;
/** 精确代次资格撤销表示请求取消，不能误判为新账号清理失败。 */
class DesktopCloudOwnerCancelled extends Error {
  readonly code = "DESKTOP_CLOUD_OWNER_STALE_OR_UNAVAILABLE";
  constructor(readonly ownerGeneration: number) { super("DESKTOP_CLOUD_OWNER_STALE_OR_UNAVAILABLE"); }
}
/** 跨桥只保留 HTTP 失败状态与已知定位字段，不携带 Server 响应原文。 */
export class DesktopBuiltInRelayRequestError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number> | undefined;
  /** 状态码保持 HTTP 事实，定位详情只投影已知字段。 */
  constructor(readonly status: number, code: unknown, details?: unknown) {
    const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : "DESKTOP_BUILTIN_ENSURE_FAILED";
    super("内置中转凭据请求失败：" + safeCode + "（HTTP " + status + "）");
    this.code = safeCode;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const source = details as Record<string, unknown>;
      const safe: Record<string, string | number> = {};
      for (const field of ["reason", "providerId", "requestId"]) {
        const value = source[field];
        if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value)) safe[field] = value;
      }
      if (typeof source.runningCount === "number" && Number.isSafeInteger(source.runningCount) && source.runningCount >= 0) safe.runningCount = source.runningCount;
      this.details = Object.keys(safe).length ? safe : undefined;
    }
  }
}
type Attempt = {
  input: LinkInput; generation: number; owner: DesktopCloudAccountOwner | null; transport: WsTransport | null;
  host: HostRpcHttpTransport | null; fenceGeneration: number; timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<DesktopCloudAccountState>; resolve(state: DesktopCloudAccountState): void; reject(error: Error): void; settled: boolean;
  controller: AbortController; hostRpcSessionId: string | null;
  operations: Set<{ done: Promise<PromiseSettledResult<unknown>>; release?: () => Promise<void> }>;
  hostScopeWaiters: Set<() => void>;
};

/** 只接受完整 HTTP origin，令牌始终留在当前进程内存。 */
function normalizeLink(input: LinkInput): LinkInput {
  const url = new URL(input.serverOrigin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("DESKTOP_CLOUD_ORIGIN_INVALID");
  if (typeof input.sessionToken !== "string" || !input.sessionToken.trim() || /[\r\n]/u.test(input.sessionToken)) throw new Error("DESKTOP_CLOUD_SESSION_INVALID");
  return { serverOrigin: url.origin, sessionToken: input.sessionToken };
}

/** 固定错误码供现有日志白名单检索；cause只携带所属边界已脱敏的诊断。 */
function cloudConnectionError(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}

/** 桌面云连接只拥有账号和认证 Host；本机事实及旧 Client 激活入口保持各自职责。 */
export function createDesktopCloudAccount(input: {
  clientId: string; deviceId: string; clientVersion: string; timeoutMs: number;
  /** 每次 hello 读取本机工作区，供同账号移动端/Web 发现；不上传工作区数据。 */
  getWorkspaceIds: () => string[];
  onHello(message: Hello, owner: DesktopCloudAccountOwner, activation: { send(message: ClientToServerMessage): WsSendJsonResult; assertCurrent(): void }): Promise<void>;
  onMessage(message: ServerToClientMessage, owner: DesktopCloudAccountOwner): Promise<void>;
  onOwnerInvalidated(owner: DesktopCloudAccountOwner, reason: "network" | "revoked"): void;
  onFailure(error: Error, context: { generation: number; serverOrigin: string | null }): void;
  onRequestCancelled?: (context: { generation: number; serverOrigin: string }) => void;
  getCredentialCleanupErrorCode?: () => string | null;
  onLinked?: (owner: DesktopCloudAccountOwner) => Promise<void | { builtInRelayErrorCode: NonNullable<DesktopCloudAccountState["builtInRelayErrorCode"]> }>;
  executeHostTask?: (task: HostRpcHttpTask, owner: DesktopCloudAccountOwner) => Promise<HostRpcHttpResultMessage[]>;
  /** 沿现有Host范围入口核验；HTTP命令可等待并发到达的WS授权，不另存授权状态。 */
  isHostCommandAuthorized?: (message: Extract<ServerToClientMessage, { t: "sharedWorkspace.command" }>, owner: DesktopCloudAccountOwner) => boolean;
}) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("DESKTOP_CLOUD_TIMEOUT_INVALID");
  const fence = new ServerMessageHelloReadyFence();
  let generation = 0;
  let current: Attempt | null = null;
  let state: DesktopCloudAccountState = { status: "unlinked", generation, serverOrigin: null, userSummary: null, errorCode: null };
  const cleanup = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  let transitionTail = Promise.resolve();
  let transitionRelease: (() => Promise<void>) | null = null;

  /** 对外状态复制可信摘要，不暴露内存 token 或可变 owner。 */
  const snapshot = (): DesktopCloudAccountState => ({ ...state, builtInRelayErrorCode: state.builtInRelayErrorCode ?? null, userSummary: state.userSummary ? { ...state.userSummary } : null, errorCode: input.getCredentialCleanupErrorCode?.() ?? state.errorCode });
  /** 所有新副作用必须使用当前且已完成 hello 的相同 owner。 */
  const assertOwner = (owner: DesktopCloudAccountOwner): void => {
    if (!current?.owner || state.status !== "linked" || owner.generation !== current.generation
      || owner.serverOrigin !== current.owner.serverOrigin || owner.ownerUserId !== current.owner.ownerUserId
      || owner.accountSessionId !== current.owner.accountSessionId) throw new DesktopCloudOwnerCancelled(owner.generation);
  };
  /** 跨传输最多等待五秒；账号撤销立即取消，每次唤醒重验当前绑定。 */
  const waitForHostScope = async (attempt: Attempt, message: Extract<ServerToClientMessage, { t: "sharedWorkspace.command" }>, owner: DesktopCloudAccountOwner): Promise<void> => {
    assertOwner(owner);
    if (!input.isHostCommandAuthorized || input.isHostCommandAuthorized(message, owner)) return;
    await new Promise<void>((resolve, reject) => {
      const signal = attempt.controller.signal;
      /** 移除监听与超时，迟到授权不能重新结算已撤销任务。 */
      const finish = (error?: unknown): void => {
        clearTimeout(timer); attempt.hostScopeWaiters.delete(check); signal.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = (): void => finish(signal.reason);
      const check = (): void => {
        try { assertOwner(owner); if (input.isHostCommandAuthorized!(message, owner)) finish(); }
        catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(cloudConnectionError("DESKTOP_CLOUD_HOST_SCOPE_REQUIRED")), Math.min(input.timeoutMs, 5_000));
      attempt.hostScopeWaiters.add(check); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel(); else check();
    });
    assertOwner(owner);
  };
  /** link 的结算与状态分别管理，迟到的旧连接不能改写当前状态。 */
  const settle = (attempt: Attempt, error?: Error): void => {
    if (attempt.timer) clearTimeout(attempt.timer); attempt.timer = null;
    if (attempt.settled) return; attempt.settled = true;
    if (error) attempt.reject(error); else attempt.resolve(snapshot());
  };
  /** 同步撤销 fence 与 owner，异步排空不延后新操作的资格失效。 */
  const revoke = (attempt: Attempt, reason: "network" | "revoked" = "revoked"): void => {
    fence.closeConnection(attempt.fenceGeneration);
    attempt.controller.abort(new DesktopCloudOwnerCancelled(attempt.generation));
    const owner = attempt.owner; attempt.owner = null;
    if (owner) input.onOwnerInvalidated(owner, reason);
  };
  /** 两种原生传输都要排空，保留所有清理失败。 */
  const drain = async (attempt: Attempt): Promise<void> => {
    const results = await Promise.allSettled([attempt.transport?.stopAndDrain(), attempt.host?.stopAndDrain(), ...[...attempt.operations].map(operation => operation.done)]);
    /** 只消解本模块产生且代次匹配的取消；任何其他错误仍完整失败。 */
    const classify = (error: unknown): unknown[] => {
      if (error instanceof DesktopCloudOwnerCancelled && error.ownerGeneration === attempt.generation) {
        input.onRequestCancelled?.({ generation: attempt.generation, serverOrigin: attempt.input.serverOrigin }); return [];
      }
      if (error instanceof AggregateError) return error.errors.flatMap(classify);
      return [error];
    };
    const failures = results.flatMap(result => result.status === "rejected" ? classify(result.reason) : []);
    if (failures.length) throw new AggregateError(failures, "DESKTOP_CLOUD_DRAIN_FAILED");
  };
  /** 显式重登只核退休 Attempt 的 HTTP 资源，不重放业务操作或清除历史错误。 */
  const releaseOperations = async (attempt: Attempt): Promise<void> => {
    for (const operation of attempt.operations) { if (operation.release) await operation.release(); else await operation.done; }
  };
  /** 每个退休分支都接原串行tail；未确认的 HTTP 资源保留在原 Attempt，不能重登绕过。 */
  const retire = (attempt: Attempt): Promise<void> => {
    const previousRelease = transitionRelease;
    transitionRelease = async () => { await previousRelease?.(); await releaseOperations(attempt); };
    const operation = drain(attempt);
    const combined = Promise.allSettled([transitionTail, operation]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "DESKTOP_CLOUD_DRAIN_FAILED");
    });
    transitionTail = combined; return combined;
  };
  /** 清理失败始终归属原 Attempt，仍在 shutdown 再抛。 */
  const trackCleanup = (attempt: Attempt, pending: Promise<void>): void => {
    const tracked = pending.then(() => { cleanup.delete(tracked); }, error => {
      cleanup.delete(tracked); cleanupFailures.push(error);
      input.onFailure(new Error("DESKTOP_CLOUD_DRAIN_FAILED", { cause: error }), { generation: attempt.generation, serverOrigin: attempt.input.serverOrigin });
    });
    cleanup.add(tracked);
  };
  /** 当前连接故障只隔离云模块，不终止可独立工作的本机运行时。 */
  const fail = (attempt: Attempt, error: Error, reason: "network" | "revoked" = "revoked"): void => {
    if (current !== attempt) return;
    revoke(attempt, reason); current = null;
    state = { status: "failed", generation: attempt.generation, serverOrigin: attempt.input.serverOrigin, userSummary: null, errorCode: "DESKTOP_CLOUD_CONNECTION_FAILED" };
    settle(attempt, error);
    input.onFailure(error, { generation: attempt.generation, serverOrigin: attempt.input.serverOrigin });
    trackCleanup(attempt, retire(attempt));
  };
  /** 新代次独占传输和 HTTP 会话，回调只接受其捕获的 owner。 */
  const start = (attempt: Attempt): void => {
    if (current !== attempt) return;
    const wsUrl = attempt.input.serverOrigin.replace(/^http/u, "ws") + "/ws/client";
    const transport = new WsTransport({ url: wsUrl, headers: { Authorization: `Bearer ${attempt.input.sessionToken}` }, events: {
      onOpen() {
        if (current !== attempt) return;
        attempt.fenceGeneration = fence.beginConnection();
        // 同账号远程设备通过 Server 发现本机工作区；数据仍只留在本机。
        const sent = transport.sendJson({ t: "client.hello", clientId: input.clientId, deviceId: input.deviceId, version: input.clientVersion, platform: process.platform, arch: process.arch, workspaceIds: input.getWorkspaceIds(), capabilities: { desktopLocalRuntimeV1: true, desktopAccountScheduledTasksV1: true, localCanonicalRelayV1: true, localCanonicalRelayOnDemandV1: true, remoteDataDemandV1: true, sharedThreadAclLocal: true, sharedThreadAclInlineList: true, sharedOrchestrationResourceAclLocal: true, hostRpcHttpLongPoll: true, threadInputActionsV1: true, engineModelCatalogV1: true } });
        if (!sent.accepted) fail(attempt, cloudConnectionError("DESKTOP_CLOUD_HELLO_SEND_FAILED"));
      },
      onClose(info) {
        fail(attempt, cloudConnectionError("DESKTOP_CLOUD_CONNECTION_CLOSED", cloudConnectionError(`WS_CLOSE_${info.code}`)),
          info.code === 1006 ? "network" : "revoked");
      },
      onError(_message, context) {
        const network = context?.source === "socket" && context.code !== null
          && ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(context.code);
        const cause = context?.code && /^[A-Z][A-Z0-9_]{0,95}$/u.test(context.code) ? cloudConnectionError(context.code) : undefined;
        fail(attempt, cloudConnectionError("DESKTOP_CLOUD_TRANSPORT_FAILED", cause), network ? "network" : "revoked");
      },
      onDeliveryFailure(failure) {
        fail(attempt, cloudConnectionError("DESKTOP_CLOUD_DELIVERY_FAILED", cloudConnectionError(`WS_DELIVERY_${failure.phase.toUpperCase()}`)));
      },
      onMessageFailure(failure) { fail(attempt, failure.error instanceof Error ? failure.error : cloudConnectionError("DESKTOP_CLOUD_MESSAGE_FAILED", failure.error)); },
      async onMessage(data) {
        if (current !== attempt) return;
        let message: ServerToClientMessage;
        try { message = (typeof data === "string" || Buffer.isBuffer(data) ? JSON.parse(String(data)) : data) as ServerToClientMessage; }
        catch { throw cloudConnectionError("DESKTOP_CLOUD_MESSAGE_INVALID"); }
        if (!message || typeof message !== "object" || typeof message.t !== "string") throw cloudConnectionError("DESKTOP_CLOUD_MESSAGE_INVALID");
        if (message.t === "client.helloAck") {
          if (attempt.owner || !message.userSummary?.userId || !message.accountSessionId || message.capabilities?.desktopLocalRuntimeV1 !== true) throw cloudConnectionError("DESKTOP_CLOUD_HELLO_INVALID");
          const owner: DesktopCloudAccountOwner = { serverOrigin: attempt.input.serverOrigin, ownerUserId: message.userSummary.userId, accountSessionId: message.accountSessionId, generation: attempt.generation };
          attempt.owner = owner;
          attempt.hostRpcSessionId = message.capabilities.hostRpcHttpSessionId ?? null;
          await input.onHello(message, owner, { send: value => transport.sendJson(value), assertCurrent() {
            if (current !== attempt || attempt.owner !== owner || !fence.isCurrent(attempt.fenceGeneration)) throw cloudConnectionError("DESKTOP_CLOUD_HELLO_STALE");
          } });
          if (current !== attempt || attempt.owner !== owner || !fence.isCurrent(attempt.fenceGeneration)) return;
          if (message.capabilities.hostRpcHttpLongPoll) {
            if (!message.capabilities.hostRpcHttpSessionId || !input.executeHostTask) throw cloudConnectionError("DESKTOP_CLOUD_HOST_RPC_UNAVAILABLE");
            attempt.host = new HostRpcHttpTransport({ serverWsUrl: wsUrl, apiKey: attempt.input.sessionToken, clientId: input.clientId,
              execute: async task => {
                assertOwner(owner);
                if (task.message.t === "sharedWorkspace.command") await waitForHostScope(attempt, task.message, owner);
                const result = await input.executeHostTask!(task, owner); assertOwner(owner); return result;
              },
              events: {
                onDiagnostic: (level, message, data) => logger[level]("desktop-cloud-host-rpc", message, {
                  ...data, clientId: input.clientId, generation: attempt.generation, serverOrigin: attempt.input.serverOrigin,
                }),
                /** Host RPC已有脱敏响应元数据进入原云失败owner，不泄露响应正文。 */
                onFatal: error => {
                  const metadata = (error as Error & { responseMetadata?: { status?: unknown; responseErrorCode?: unknown } }).responseMetadata;
                  const code = metadata?.responseErrorCode;
                  const failure = cloudConnectionError("DESKTOP_CLOUD_HOST_RPC_FAILED", typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code)
                    ? cloudConnectionError(code, error) : error);
                  if (Number.isInteger(metadata?.status) && Number(metadata!.status) >= 100 && Number(metadata!.status) <= 599) {
                    Object.assign(failure, { status: metadata!.status });
                  }
                  fail(attempt, failure);
                },
                onSessionInvalidated: () => fail(attempt, cloudConnectionError("DESKTOP_CLOUD_SESSION_INVALIDATED")),
              } });
          }
          transport.markReady();
          if (!fence.markReady(attempt.fenceGeneration)) throw cloudConnectionError("DESKTOP_CLOUD_HELLO_STALE");
          state = { status: "linked", generation: attempt.generation, serverOrigin: owner.serverOrigin, userSummary: message.userSummary, errorCode: null };
          // 认证握手已完成，自动 Key 的独立结果不能再触发握手超时。
          if (attempt.timer) clearTimeout(attempt.timer); attempt.timer = null;
          attempt.host?.start(message.capabilities.hostRpcHttpSessionId!);
          const linkedResult = await input.onLinked?.(owner);
          if (current !== attempt || attempt.owner !== owner) return;
          state.builtInRelayErrorCode = linkedResult?.builtInRelayErrorCode ?? null;
          settle(attempt); return;
        }
        if (!await fence.waitUntilReady(attempt.fenceGeneration) || current !== attempt || !attempt.owner) return;
        assertOwner(attempt.owner);
        if (message.t === "sharedWorkspace.command") await waitForHostScope(attempt, message, attempt.owner);
        await input.onMessage(message, attempt.owner);
        if (message.t === "conversation.event.relayScopes") for (const check of [...attempt.hostScopeWaiters]) check();
      },
    } });
    attempt.transport = transport;
    attempt.timer = setTimeout(() => fail(attempt, cloudConnectionError("DESKTOP_CLOUD_HELLO_TIMEOUT")), input.timeoutMs);
    transport.start();
  };

  return {
    snapshot, assertOwner,
    /** 任务HTTP只用原Attempt内存会话；正文读完才收口，业务失败明确交付调用方。 */
    async requestScheduledTasks<Action extends TaskAction>(owner: DesktopCloudAccountOwner, action: Action,
      payload: Pick<ClientScheduledTaskReportRequestBody, "nextRuns" | "run"> | Omit<ClientScheduledTaskConfigWritebackRequestBody, "clientId" | "deviceId">,
      requestId: string): Promise<TaskResponse<Action>> {
      assertOwner(owner);
      if (!["sync", "report", "config"].includes(action) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) throw new Error("SCHEDULED_TASK_REQUEST_INVALID");
      const fields = payload as Partial<ClientScheduledTaskReportRequestBody & ClientScheduledTaskConfigWritebackRequestBody>;
      if (action === "config" && (typeof fields.taskId !== "string" || !fields.taskId.trim() || !Number.isSafeInteger(fields.localRevision)
        || fields.localRevision! < 1 || !Number.isSafeInteger(fields.expectedConfigRevision) || fields.expectedConfigRevision! < 1
        || !["update", "delete"].includes(fields.operation ?? "") || fields.operation === "update" && (!fields.config || typeof fields.config !== "object"))) {
        throw new Error("SCHEDULED_TASK_REQUEST_INVALID");
      }
      const requestBody = { ...(action === "report" ? { run: fields.run, nextRuns: fields.nextRuns } : action === "config"
        ? { taskId: fields.taskId, localRevision: fields.localRevision, expectedConfigRevision: fields.expectedConfigRevision, operation: fields.operation,
          ...(fields.operation === "update" ? { config: fields.config } : {}) } : {}), clientId: input.clientId, deviceId: input.deviceId };
      const sentRevision = { taskId: fields.taskId, localRevision: fields.localRevision, expectedConfigRevision: fields.expectedConfigRevision, operation: fields.operation };
      const attempt = current!;
      const operation = { done: Promise.resolve({ status: "fulfilled" as const, value: undefined }) as Promise<PromiseSettledResult<unknown>> };
      attempt.operations.add(operation);
      /** 错误只投影原任务诊断合同，不回显响应正文或会话。 */
      const failure = (reason: string, response?: Response, cause?: unknown, upstreamCode?: unknown): Error => Object.assign(new Error("SCHEDULED_TASK_API_FAILED", { cause }), {
        code: "SCHEDULED_TASK_API_FAILED", reason, requestId, ownerUserId: owner.ownerUserId, serverOrigin: owner.serverOrigin,
        clientId: input.clientId, deviceId: input.deviceId, httpStatus: response?.status,
        upstreamRequestId: /^[A-Za-z0-9._:-]{1,128}$/u.test(response?.headers.get("x-request-id") ?? "") ? response!.headers.get("x-request-id") : undefined,
        ...(action === "config" && typeof upstreamCode === "string" && ["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNAUTHORIZED"].includes(upstreamCode) ? { upstreamCode } : {}),
      });
      const pending = (async () => {
        let response: Response;
        try {
          response = await fetch(new URL(`/api/client/scheduled-tasks/${action}`, owner.serverOrigin), {
            method: "POST", headers: { Authorization: `Bearer ${attempt.input.sessionToken}`, "content-type": "application/json", "x-request-id": requestId },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(input.timeoutMs)]), redirect: "error",
          });
        } catch (cause) { assertOwner(owner); throw failure("transport_failed", undefined, cause); }
        assertOwner(owner);
        let text: string;
        try { text = await response.text(); }
        catch (cause) { assertOwner(owner); throw failure("transport_failed", response, cause); }
        assertOwner(owner);
        let body: any;
        try { body = JSON.parse(text); }
        catch { assertOwner(owner); throw failure("invalid_json", response); }
        assertOwner(owner);
        if (!response.ok || body?.ok !== true) throw failure("rejected_response", response, undefined, body?.code);
        if (action === "config") {
          const task = body.task;
          if (body.taskId !== sentRevision.taskId || body.localRevision !== sentRevision.localRevision || body.expectedConfigRevision !== sentRevision.expectedConfigRevision
            || body.deleted !== (sentRevision.operation === "delete") || (body.deleted ? task !== null : !task || task.id !== sentRevision.taskId
              || task.ownerUserId !== owner.ownerUserId || task.clientId !== input.clientId || task.deviceId !== input.deviceId || task.deviceKind !== "desktop"
              || task.configRevision !== sentRevision.expectedConfigRevision! + 1)) throw failure("invalid_ack", response);
          return { taskId: body.taskId, localRevision: body.localRevision, expectedConfigRevision: body.expectedConfigRevision, deleted: body.deleted, task };
        }
        if (!Number.isSafeInteger(body.serverNow) || body.serverNow < 0 || (action === "sync" && !Array.isArray(body.tasks))) throw failure("invalid_ack", response);
        if (action === "report") return { serverNow: body.serverNow };
        let configRevisionFloors: ClientScheduledTaskSyncResponseBody["configRevisionFloors"];
        if (body.configRevisionFloors !== undefined) {
          const rawFloors = body.configRevisionFloors, taskIds = new Set<string>(), floorIds = new Set<string>();
          if (!Array.isArray(rawFloors) || rawFloors.length !== body.tasks.length) throw failure("invalid_ack", response);
          for (const task of body.tasks) {
            if (typeof task?.id !== "string" || !task.id.trim() || taskIds.has(task.id)) throw failure("invalid_ack", response);
            taskIds.add(task.id);
          }
          configRevisionFloors = rawFloors.map(floor => {
            if (!floor || Array.isArray(floor) || typeof floor.taskId !== "string" || !taskIds.has(floor.taskId) || floorIds.has(floor.taskId)
              || !Number.isSafeInteger(floor.localRevision) || floor.localRevision < 0) throw failure("invalid_ack", response);
            floorIds.add(floor.taskId);
            return { taskId: floor.taskId, localRevision: floor.localRevision };
          });
        }
        return { tasks: body.tasks, serverNow: body.serverNow, ...(configRevisionFloors === undefined ? {} : { configRevisionFloors }) };
      })();
      // 原资源集合等待请求结算；已返回给调用方的业务拒绝不重复升级为账号清理故障。
      operation.done = pending.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
      try { const result = await pending; assertOwner(owner); return result as TaskResponse<Action>; }
      finally { attempt.operations.delete(operation); }
    },
    /** 只有当前 owner 的真实 Codex 内置启用成功才能清除独立 Key 失败。 */
    markBuiltInRelayReady(owner: DesktopCloudAccountOwner): void { assertOwner(owner); if (state.builtInRelayErrorCode === "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED") state.builtInRelayErrorCode = null; },
    /** 只有完成真实握手才提供当次运行 owner；持久数据不能代替许可。 */
    getOwner(): DesktopCloudAccountOwner | null { return current?.owner && state.status === "linked" ? { ...current.owner } : null; },
    /** 仅为当前需求创建归因传输；令牌留在原 Attempt，退出排空所有已发请求。 */
    createCodeAttributionTransport(owner: DesktopCloudAccountOwner): CodeAttributionHttpTransport {
      assertOwner(owner);
      const attempt = current!;
      const transport = createCodeAttributionHttpTransport({
        serverWsUrl: owner.serverOrigin.replace(/^http/u, "ws") + "/ws/client",
        apiKey: attempt.input.sessionToken,
      }, { signal: attempt.controller.signal, timeoutMs: input.timeoutMs });
      /** 每次派发与回执均复验原账号代次，禁止跨账号复用上传资格。 */
      const run = async <T>(operation: () => Promise<T>): Promise<T> => {
        assertOwner(owner);
        const pending = (async () => {
          try { const result = await operation(); assertOwner(owner); return result; }
          catch (error) { assertOwner(owner); throw error; }
        })();
        const tracked = { done: pending.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })) };
        attempt.operations.add(tracked);
        try { return await pending; }
        finally { attempt.operations.delete(tracked); }
      };
      return {
        upload: batch => run(() => transport.upload(batch)),
        uploadRetention: observation => run(() => transport.uploadRetention(observation)),
        renewAssociation: request => run(() => transport.renewAssociation!(request)),
      };
    },
    /** 调用同步撤销旧身份，清理成功后才启动新连接；相同有效会话复用原结果。 */
    link(raw: LinkInput): Promise<DesktopCloudAccountState> {
      const normalized = normalizeLink(raw);
      logger.info("desktop-cloud", "link requested", {
        clientId: input.clientId, serverOrigin: normalized.serverOrigin, generation: generation + 1,
        workspaceCount: input.getWorkspaceIds().length,
      });
      if (current?.input.serverOrigin === normalized.serverOrigin && current.input.sessionToken === normalized.sessionToken) return current.promise;
      if (!current && state.status === "failed") transitionTail = transitionRelease ? transitionRelease() : Promise.resolve();
      const old = current; generation += 1;
      let resolve!: Attempt["resolve"]; let reject!: Attempt["reject"];
      const promise = new Promise<DesktopCloudAccountState>((yes, no) => { resolve = yes; reject = no; });
      const attempt: Attempt = { input: normalized, generation, owner: null, transport: null, host: null, fenceGeneration: 0, timer: null, promise, resolve, reject, settled: false,
        controller: new AbortController(), hostRpcSessionId: null, operations: new Set(), hostScopeWaiters: new Set() };
      current = attempt; state = { status: "linking", generation, serverOrigin: normalized.serverOrigin, userSummary: null, errorCode: null };
      if (old) { revoke(old); settle(old, new Error("DESKTOP_CLOUD_LINK_SUPERSEDED")); }
      const previousTransition = transitionTail;
      if (old) { const previousRelease = transitionRelease; transitionRelease = async () => { await previousRelease?.(); await releaseOperations(old); }; }
      const transition = (async () => { await previousTransition; if (old) await drain(old); if (current === attempt) { transitionRelease = null; start(attempt); } })();
      transitionTail = transition;
      void transition.catch(error => {
        if (!cleanupFailures.includes(error)) cleanupFailures.push(error);
        fail(attempt, new Error("DESKTOP_CLOUD_LINK_FAILED", { cause: error }));
      });
      return promise;
    },
    /** 退出账号先吊销新操作资格，再等待原传输收口；不删除本地事实。 */
    async unlink(): Promise<DesktopCloudAccountState> {
      const old = current; current = null; generation += 1;
      state = { status: "unlinked", generation, serverOrigin: null, userSummary: null, errorCode: null };
      if (old) { revoke(old); settle(old, new Error("DESKTOP_CLOUD_LINK_CANCELLED")); }
      if (old) await retire(old); else await transitionTail;
      return snapshot();
    },
    /** 每个请求前后都核对 owner，旧 ensure 不得写入凭据仓储。 */
    async requestEnsure(owner: DesktopCloudAccountOwner, request: { providerId: string; requestId: string; reset?: boolean }) {
      assertOwner(owner); const attempt = current!;
      const url = new URL("/api/client/relay/key/ensure", owner.serverOrigin); url.searchParams.set("clientId", input.clientId);
      const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${attempt.input.sessionToken}`, "content-type": "application/json", "x-request-id": request.requestId }, body: JSON.stringify({ providerId: request.providerId, engine: request.providerId === "openai" ? "codex" : "claude", reset: request.reset === true }), signal: AbortSignal.timeout(input.timeoutMs), redirect: "error" });
      assertOwner(owner);
      let body: { ok?: boolean; code?: string; details?: unknown; key?: { keyId: string; providerId: string; ownerUserId: string; rawKey: string; baseUrl: string } } | null;
      try { body = await response.json(); }
      catch {
        assertOwner(owner);
        throw new DesktopBuiltInRelayRequestError(response.ok ? 502 : response.status, "DESKTOP_BUILTIN_ENSURE_RESPONSE_INVALID");
      }
      assertOwner(owner);
      if (!response.ok || body?.ok !== true) throw new DesktopBuiltInRelayRequestError(response.ok ? 502 : response.status, body?.code, body?.details);
      const key = body.key;
      if (!key?.keyId || key.providerId !== request.providerId || key.ownerUserId !== owner.ownerUserId || !key.rawKey?.trim() || !key.baseUrl?.trim()) throw new Error("DESKTOP_BUILTIN_ENSURE_IDENTITY_INVALID");
      return key;
    },
    /** 云端发送只接收当前连接，不允许将旧 owner 的缓冲转给新账号。 */
    send(message: ClientToServerMessage): WsSendJsonResult {
      if (!current?.transport || state.status !== "linked") return { accepted: false, messageType: message.t, readyState: null, bufferedAmount: null, bytes: 0, reason: "desktop cloud unavailable", queuedAt: Date.now(), callbackError: null };
      return current.transport.sendJson(message);
    },
    /** 远程事件失败在本模块显式失败，后续登录同步可重新关联。 */
    disconnect(error: Error): void { if (current) fail(current, error); },
    /** 停机收口所有已登记传输；事件清理错误不能被成功状态覆盖。 */
    async stopAndDrain(): Promise<void> {
      const old = current; current = null; if (old) { revoke(old); settle(old, new Error("DESKTOP_CLOUD_STOPPED")); }
      const results = await Promise.allSettled([transitionTail, old ? drain(old) : undefined, ...cleanup]);
      const failures = [...cleanupFailures, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      if (failures.length) throw new AggregateError(failures, "DESKTOP_CLOUD_CLEANUP_FAILED");
    },
  };
}

export type DesktopCloudAccount = ReturnType<typeof createDesktopCloudAccount>;
