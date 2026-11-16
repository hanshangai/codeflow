import type {
  TextFileAttachment,
  ThreadDraftImageAttachment,
  ThreadId,
  ThreadMessageQueueItem,
  ThreadQueueAppendRequestBody,
  ThreadQueueChangedReason,
  ThreadQueueClearRequestBody,
  ThreadQueueListRequestBody,
  ThreadQueueMoveRequestBody,
  ThreadQueuePauseRequestBody,
  ThreadQueuePauseReason,
  ThreadQueueRemoveRequestBody,
  ThreadQueueResumeRequestBody,
  ThreadQueueSendOptions,
  ThreadQueueSnapshot,
  WorkspacePathReference,
  WorkspaceId,
} from "@codeflowai/shared";
import {
  createWorkspacePathReference,
  normalizeThreadInputContract,
  normalizeWorkspacePathReferenceList,
  ThreadInputContractError,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "./handleApiRequest.js";
import { describeWorkspaceApiFailure, isWorkspaceApiRequestFailure, readThreadExecutionProfileContext, WorkspaceApiRequestFailure } from "./handleApiRequest.js";
import { logger } from "../logger.js";
import { ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE } from "../db/repos/threadMessageQueueRepo.js";
import { summarizeImageInputs } from "../diagnostics/imageInputDiagnostics.js";
import { readSharedWorkspaceToolExecutionContext } from "./sharedWorkspaceToolPolicy.js";
import { hasExplicitThreadInputContract } from "../engines/threadInputActions.js";
import {
  buildUnsupportedOrchestrationNodeQueueMessage,
  resolveOrchestrationNodeQueueBinding,
  resolveOrchestrationNodeQueueMode,
} from "../queue/orchestrationNodeQueuePolicy.js";
import {
  buildNodeExecutionOptionsConflictMessage,
  compareThreadQueueExecutionOptions,
  ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
} from "../queue/threadQueueExecutionPolicy.js";

/**
 * dispatcher 抽象：handler 只触发 idle 消费；active turn 注入由运行事件边界触发。
 * 真实实现在 ThreadQueueDispatcher（src/queue/threadQueueDispatcher.ts），
 * 未注入时调用为 no-op（不阻塞 handler 自身）。
 */
export interface ThreadQueueKickAdapter {
  forWorkspace?(workspaceId: WorkspaceId): ThreadQueueKickAdapter;
  kickIfIdle(threadId: ThreadId): void;
  kickAtActiveTurnBoundary(threadId: ThreadId): void;
  /** 对已持久化但唤醒失败的节点输入只重试唤醒，不重复写入反馈。 */
  retryPersistedNodeWake?(
    threadId: ThreadId,
    queueItemId: string,
  ): Promise<void>;
  /** 对 provider/节点已 ACK 的队列项只重试本地收尾，不重复业务副作用。 */
  retryAcknowledgedFinalization?(
    threadId: ThreadId,
    queueItemId: string,
  ): Promise<void>;
  notifyTurnTerminal(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: string;
    source: "user_send" | "queue_consume";
    queueItemId: string | null;
    outcome: "completed" | "error";
    terminationKind?: "manual_interrupt" | "transient_cleanup" | "error";
    errorCode?: string | null;
  }): void;
}

/** 通知失败已隔离时可停止所属后台调度；隔离落库失败必须继续向上抛。 */
export class QueueChangeNotificationError extends Error {
  readonly code: string;

  /** 只描述通知及隔离结果，不改变 provider ACK 或队列业务事实。 */
  constructor(readonly isolated: boolean, cause: unknown) {
    super(isolated ? "队列变更通知失败，队列已暂停" : "队列变更通知失败且无法持久化暂停状态", { cause });
    this.code = isolated ? "QUEUE_CHANGE_NOTIFICATION_FAILED" : "QUEUE_CHANGE_NOTIFICATION_CLEANUP_FAILED";
  }
}

/** 可信队列诊断固定落所属W；失败保留原值，禁止后续投递或响应伪成功。 */
function writeWorkspaceQueueLog(
  ctx: ApiHandlerContext,
  scope: { workspaceId: WorkspaceId; threadId: ThreadId; requestId: string; method?: string },
  level: "info" | "error",
  message: string,
  data: Record<string, unknown>,
  original?: { error: unknown; causes?: unknown[] },
): string | undefined {
  try {
    const description = original ? describeWorkspaceApiFailure(original.error) : undefined;
    const causes = original?.causes?.map(error => describeWorkspaceApiFailure(error).rootCause);
    ctx.db.writeWorkspaceLog(scope.workspaceId, { level, tag: "queue", message, data: {
      ...data, workspaceId: scope.workspaceId, threadId: scope.threadId, requestId: scope.requestId,
      event: { category: "queue", action: scope.method ?? "threads.queue.append", outcome: level === "error" ? "fail" : "success" },
      ...(description ? { rootCause: causes ?? description.rootCause } : {}),
    } });
    return description?.message;
  } catch (failure) {
    throw new WorkspaceApiRequestFailure(original ? [original.error, failure] : [failure], {
      code: "WORKSPACE_API_REQUEST_LOG_FAILED", ...scope, method: scope.method ?? "threads.queue.append",
    });
  }
}

/** 兼容 void 发送器；同步拒绝时持久化失败暂停，禁止继续 kick 或返回成功。 */
export function emitQueueChanged(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  reason: ThreadQueueChangedReason,
  correlation: { requestId?: string; queueItemId?: string } = {},
): void {
  try {
    const result = ctx.send({
      t: "thread.queue.changed",
      workspaceId,
      threadId,
      reason,
    });
    if (result?.accepted === false) throw result;
  } catch (cause) {
    let failure = new QueueChangeNotificationError(true, cause);
    const causes = [cause];
    try {
      const state = ctx.db.threadQueueStates.getState(threadId);
      if (!state.paused || state.pausedReason === "send_failed") ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
    } catch (cleanupError) {
      causes.push(cleanupError);
      failure = new QueueChangeNotificationError(false, new AggregateError([cause, cleanupError], "队列通知失败收尾落库失败"));
    }
    writeWorkspaceQueueLog(ctx, { workspaceId, threadId, requestId: correlation.requestId ?? `queue-notification:${threadId}`,
      method: "thread.queue.changed" }, "error", "thread queue change notification failed", {
      code: failure.code, queueItemId: correlation.queueItemId ?? null, reason,
      isolated: failure.isolated,
    }, { error: failure, causes });
    ctx.onApiFailureLogged?.();
    throw failure;
  }
}

function buildSnapshot(ctx: ApiHandlerContext, threadId: ThreadId): ThreadQueueSnapshot {
  const items = ctx.db.threadMessageQueue.listActiveByThread(threadId);
  const state = ctx.db.threadQueueStates.getState(threadId);
  return { state, items };
}

/** 已验证的工作区固定队列及编排 owner，后续事务全部在同一物理库执行。 */
function routeWorkspaceCoreQueueContext(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): ApiHandlerContext | null {
  if (!ctx.workspaces.has(workspaceId)) return null;
  return {
    ...ctx,
    db: ctx.db.forWorkspace(workspaceId),
    queueDispatcher: ctx.queueDispatcher?.forWorkspace?.(workspaceId) ?? ctx.queueDispatcher,
    orchEngine: ctx.orchEngine?.forWorkspace(workspaceId) ?? ctx.orchEngine,
  };
}

/** 校验队列编辑目标：只有 pending 项允许移动/删除，sending 必须由运行态收尾。 */
function loadPendingQueueItemForMutation(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; queueItemId: string },
): ThreadMessageQueueItem | { errorStatus: number; message: string } {
  const item = ctx.db.threadMessageQueue.getById(input.queueItemId);
  if (!item || item.threadId !== input.threadId || item.workspaceId !== input.workspaceId) {
    return { errorStatus: 404, message: "队列项不存在或不属于当前 thread" };
  }
  if (item.status !== "pending") {
    return { errorStatus: 409, message: "该队列项正在发送或已结束，不能移动或删除" };
  }
  return item;
}

function validateQueueEligibleThread(
  ctx: ApiHandlerContext,
  input: {
    threadId: ThreadId;
    subtype: string | null | undefined;
    imageCount: number;
  },
): { status: number; message: string } | null {
  // 普通 chat 继续走原队列；编排节点/需求分析线程由 dispatcher 按各自业务完成态消费。
  if (!input.subtype) return null;
  if (input.subtype === "node-discussion") return null;
  if (input.subtype === "requirement-analysis") return null;
  if (input.subtype !== "node") {
    return { status: 409, message: "当前线程类型不支持队列。" };
  }

  const binding = resolveOrchestrationNodeQueueBinding(ctx, input.threadId);
  const mode = resolveOrchestrationNodeQueueMode(binding);
  if (mode === "unsupported") {
    return {
      status: 409,
      message: buildUnsupportedOrchestrationNodeQueueMessage(binding),
    };
  }
  if (mode === "feedback_resume" && input.imageCount > 0) {
    return { status: 400, message: "异常中断节点在会话中恢复执行时暂不支持直接附带图片，请改用文本描述后继续。" };
  }
  return null;
}

function parseSendOptions(raw: unknown): ThreadQueueSendOptions | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const workMode = obj.workMode === "general" ? "general" : null;
  const accessMode =
    obj.accessMode === "read-only" || obj.accessMode === "current" || obj.accessMode === "full-access"
      ? obj.accessMode
      : null;
  const planMode = Boolean(obj.planMode);
  const model = typeof obj.model === "string" ? obj.model : null;
  const effort = typeof obj.effort === "string" ? obj.effort : null;
  const serviceTier = obj.serviceTier === "fast" ? "fast" : null;
  const roleId = typeof obj.roleId === "string" && obj.roleId.trim() ? obj.roleId.trim() as ThreadQueueSendOptions["roleId"] : null;
  const contextWindow = typeof obj.contextWindow === "number" && obj.contextWindow > 0
    ? Math.round(obj.contextWindow)
    : null;
  const autoCompactPct = typeof obj.autoCompactPct === "number"
    && obj.autoCompactPct >= 50
    && obj.autoCompactPct <= 99
    ? obj.autoCompactPct
    : null;
  const forceNewTurn = obj.forceNewTurn === true;
  return { workMode, planMode, accessMode, model, effort, contextWindow, autoCompactPct, serviceTier, roleId, forceNewTurn };
}

function parseImages(raw: unknown): ThreadDraftImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx): ThreadDraftImageAttachment | null => {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      const dataUrl = String(r.dataUrl ?? "");
      if (!dataUrl) return null;
      return {
        id: String(r.id ?? "").trim() || `img_${idx}`,
        name: String(r.name ?? "").trim() || "image",
        dataUrl,
        size: typeof r.size === "number" ? r.size : 0,
      };
    })
    .filter((x): x is ThreadDraftImageAttachment => x !== null);
}

function parseFiles(raw: unknown): TextFileAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx): TextFileAttachment | null => {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      return {
        id: String(r.id ?? "").trim() || `file_${idx}`,
        name: String(r.name ?? "").trim() || "file",
        displayName: typeof r.displayName === "string" && r.displayName ? r.displayName : null,
        mime: typeof r.mime === "string" ? r.mime : "",
        size: typeof r.size === "number" ? r.size : 0,
        text: typeof r.text === "string" ? r.text : "",
      };
    })
    .filter((x): x is TextFileAttachment => x !== null);
}

/** 规范化队列项 @ 路径引用；引用不存在不应阻断正文入队。 */
function parsePathReferences(raw: unknown): WorkspacePathReference[] {
  return normalizeWorkspacePathReferenceList(raw).map((ref) => createWorkspacePathReference(ref));
}

/** 解析队列暂停原因；外部未传原因时按“手动暂停队列”处理。 */
function parsePauseReason(raw: unknown): ThreadQueuePauseReason {
  const v = String(raw ?? "").trim();
  if (
    v === "user_pause" ||
    v === "user_stop" ||
    v === "turn_error" ||
    v === "send_failed" ||
    v === "session_invalidated" ||
    v === "rollback" ||
    v === "transient_cleanup"
  ) {
    return v;
  }
  return "user_pause";
}

/** 真正的新输入可解除发送失败暂停；普通聊天的幂等重放不表示用户要求恢复。 */
function shouldAutoResumeStalePauseOnAppend(
  reason: ThreadQueuePauseReason | null,
  activeItemCount: number,
  nodeQueueMode: ReturnType<typeof resolveOrchestrationNodeQueueMode> | null,
  idempotent: boolean,
): boolean {
  if (reason === "user_stop" && nodeQueueMode === "feedback_resume") return true;
  if (reason === "send_failed") {
    return !idempotent || Boolean(nodeQueueMode && nodeQueueMode !== "unsupported");
  }
  if (reason === "session_invalidated") {
    return Boolean(nodeQueueMode)
      && nodeQueueMode !== "unsupported";
  }
  if (activeItemCount > 0) return false;
  return reason === "user_stop" || reason === "rollback" || reason === "transient_cleanup";
}

/** 生成节点输入的语义指纹；忽略附件/路径引用的内部行 ID。 */
function buildNodeInputSemanticFingerprint(input: {
  text: string;
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences: WorkspacePathReference[];
  sendOptions: ThreadQueueSendOptions;
}): string {
  return JSON.stringify({
    text: input.text.trim(),
    images: input.images.map((image) => ({
      name: image.name,
      dataUrl: image.dataUrl,
      size: image.size,
    })),
    files: input.files.map((file) => ({
      name: file.name,
      displayName: file.displayName ?? null,
      mime: file.mime,
      size: file.size,
      text: file.text,
    })),
    pathReferences: input.pathReferences.map((reference) => ({
      path: reference.path,
      kind: reference.kind,
      displayName: reference.displayName ?? null,
      source: reference.source ?? null,
    })),
    sendOptions: input.sendOptions,
  });
}

/** 识别已接收节点输入的幂等唤醒重试，避免把同一反馈再次入队。 */
function resolvePersistedNodeWakeRetryItem(input: {
  ctx: ApiHandlerContext;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  text: string;
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences: WorkspacePathReference[];
  sendOptions: ThreadQueueSendOptions;
  clientItemId: string | null;
  pausedReason: ThreadQueuePauseReason | null;
  lastConsumedQueueId: string | null;
  nodeQueueMode: ReturnType<typeof resolveOrchestrationNodeQueueMode> | null;
}): ThreadMessageQueueItem | null {
  const queueItemId = String(input.lastConsumedQueueId ?? "").trim();
  if (!queueItemId) return null;
  const item = input.ctx.db.threadMessageQueue.getById(queueItemId);
  const persistedWakeCompleted = item?.status === "sent" && item.sentTurnId === null;
  if (!item
    || item.workspaceId !== input.workspaceId
    || item.threadId !== input.threadId
    || !persistedWakeCompleted) {
    return null;
  }
  const sameClientItem = Boolean(input.clientItemId && item.clientItemId === input.clientItemId);
  const sameSemanticInput = buildNodeInputSemanticFingerprint(input) === buildNodeInputSemanticFingerprint({
    text: item.text,
    images: item.images,
    files: item.files,
    pathReferences: item.pathReferences,
    sendOptions: item.sendOptions,
  });
  if (!input.nodeQueueMode
    || input.nodeQueueMode === "unsupported") {
    return null;
  }
  const nextInputRetriesFailedWake = input.pausedReason === "send_failed"
    && input.nodeQueueMode === "pending_feedback"
    && sameSemanticInput;
  return sameClientItem || nextInputRetriesFailedWake ? item : null;
}

/** 普通入队及异步回答共用校验与幂等；附属事实成功保存后才允许派发。 */
export async function onThreadQueueAppend(ctx: ApiHandlerContext, req: ApiRequestMessage,
  options?: { beforeDispatch: () => void }): Promise<void> {
  const body = req.body as ThreadQueueAppendRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const text = String(body?.text ?? "");
  let inputContract: ReturnType<typeof normalizeThreadInputContract>;
  try {
    inputContract = normalizeThreadInputContract(body, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("queue", "thread queue input contract validation failed", {
      code: error instanceof ThreadInputContractError ? error.code : "BAD_REQUEST",
      requestId: req.id,
      workspaceId,
      threadId,
      rootCause: message,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  const parsedSendOptions = parseSendOptions(body?.sendOptions);
  const images = parseImages(body?.images);
  const files = parseFiles(body?.files);
  const rawPathReferences = Array.isArray((body as any)?.pathReferences) ? (body as any).pathReferences : [];
  const sharedWorkspaceToolContext = readSharedWorkspaceToolExecutionContext(body as unknown as Record<string, unknown>);
  const executionProfileContext = readThreadExecutionProfileContext(body as unknown as Record<string, unknown>);
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!text.trim() && images.length === 0 && files.length === 0 && rawPathReferences.length === 0) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "队列项不能为空" } });
    return;
  }
  if (!parsedSendOptions) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：sendOptions" } });
    return;
  }
  if (inputContract.inputKind === "provider-slash") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "PROVIDER_SLASH_CONFLICT", message: "Provider Slash 不能进入消息队列" },
    });
    return;
  }

  const scoped = await withQueueDatabase(ctx, req.id, () => routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId));
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;

  const persistedThread = await withQueueDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  if (!persistedThread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (persistedThread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  const logScope = { workspaceId, threadId, requestId: req.id, method: req.method };
  if (images.length > 0) {
    await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "info", "thread queue image input received", {
      code: "thread_queue_image_input_received",
      ...summarizeImageInputs(images.map((image) => image.dataUrl)),
    }));
  }
  if (hasExplicitThreadInputContract(body) && (persistedThread.threadSubtype != null || persistedThread.threadType === "orchestration")) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "PROVIDER_SLASH_CONFLICT", message: "输入动作仅支持普通聊天会话" },
    });
    return;
  }
  if (inputContract.skillMentions?.length && persistedThread.engine !== "codex") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: "CODEX_SKILL_BINDING_INVALID", message: "Skill binding 仅支持 Codex" },
    });
    return;
  }
  // 节点讨论是只读聊天面；队列快照也必须在入队边界锁定，不能保留调用方伪造的写权限/计划模式。
  const sendOptions: ThreadQueueSendOptions = persistedThread.threadSubtype === "node-discussion"
    ? { ...parsedSendOptions, accessMode: "read-only", planMode: false }
    : parsedSendOptions;
  const incomingClientItemId = typeof body?.clientItemId === "string" ? body.clientItemId.trim() : "";
  const replay = ctx.assertAssetExecution && incomingClientItemId
    ? await withQueueDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.findIdempotentItem(threadId, incomingClientItemId)) : null;
  const root = sendOptions.roleId ? { assetType: "role" as const, assetId: sendOptions.roleId } : undefined;
  const assetBinding = !replay && ctx.assertAssetExecution && persistedThread.threadSubtype === "node" ? await withQueueDatabase(ctx, req.id, () => resolveOrchestrationNodeQueueBinding(ctx, threadId)) : null;
  const nodeAuthorization = assetBinding ? await withQueueDatabase(ctx, req.id, () => ctx.db.orchInstances.get(assetBinding.instanceId)?.assetRuntimeSnapshot?.executionAuthorization) : null;
  const historicalAuthorization = !replay && ctx.assertAssetExecution
    ? await withQueueDatabase(ctx, req.id, () => ctx.db.turns.getAssetExecutionAuthorizations(threadId, persistedThread.sessionId).at(-1)) : null;
  const assetExecutionAuthorization = nodeAuthorization ?? historicalAuthorization ?? null;
  if (!replay) await withQueueDatabase(ctx, req.id, () => ctx.assertAssetExecution?.({ workspaceId, threadId, root, ...(assetExecutionAuthorization ? { authorization: assetExecutionAuthorization } : {}),
    toolContext: sharedWorkspaceToolContext }));
  if (assetExecutionAuthorization) sendOptions.accessMode = "read-only";
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const queueStateBeforeAppend = await withQueueDatabase(ctx, req.id, () => ctx.db.threadQueueStates.getState(threadId));
  let pathReferences: WorkspacePathReference[];
  try {
    pathReferences = parsePathReferences(rawPathReferences);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  const nodeQueueBinding = persistedThread.threadSubtype === "node"
    ? await withQueueDatabase(ctx, req.id, () => resolveOrchestrationNodeQueueBinding(ctx, threadId))
    : null;
  const nodeQueueMode = persistedThread.threadSubtype === "node"
    ? resolveOrchestrationNodeQueueMode(nodeQueueBinding)
    : null;
  if (persistedThread.threadSubtype === "node" && nodeQueueMode === "active_supplement") {
    const activeTurn = ctx.getActiveThreadTurn?.({ workspaceId, threadId, includeDb: false }) ?? null;
    const executionCompatibility = activeTurn
      ? compareThreadQueueExecutionOptions(activeTurn.execution, sendOptions)
      : sendOptions.forceNewTurn === true
        ? "different"
        : null;
    if (executionCompatibility && executionCompatibility !== "same") {
      const message = buildNodeExecutionOptionsConflictMessage(executionCompatibility);
      await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "orchestration node queue append rejected by execution options", {
        code: ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
        requestId: req.id,
        workspaceId,
        threadId,
        turnId: activeTurn?.turnId ?? null,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
        nodeStatus: nodeQueueBinding?.status ?? null,
        executionCompatibility,
        activeModel: activeTurn?.execution?.model ?? null,
        requestedModel: sendOptions.model,
        rootCause: message,
      }));
      ctx.onApiFailureLogged?.();
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: {
          ok: false,
          code: ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
          message,
        },
      });
      return;
    }
  }

  const originWebSessionId = ((): string | null => {
    const fromBody = (body as unknown as Record<string, unknown>)?.originWebSessionId;
    return typeof fromBody === "string" && fromBody ? fromBody : null;
  })();
  const clientItemId = typeof body?.clientItemId === "string" && body.clientItemId.trim() ? body.clientItemId.trim() : null;
  const activeItemCountBeforeAppend = await withQueueDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.listActiveByThread(threadId).length);
  const persistedNodeWakeRetryItem = await withQueueDatabase(ctx, req.id, () => resolvePersistedNodeWakeRetryItem({
    ctx,
    workspaceId,
    threadId,
    text,
    images,
    files,
    pathReferences,
    sendOptions,
    clientItemId,
    pausedReason: queueStateBeforeAppend.paused ? queueStateBeforeAppend.pausedReason : null,
    lastConsumedQueueId: queueStateBeforeAppend.lastConsumedQueueId,
    nodeQueueMode,
  }));
  if (persistedNodeWakeRetryItem) {
    try {
      if (!ctx.queueDispatcher?.retryPersistedNodeWake) throw new Error("节点唤醒重试能力未就绪");
      await ctx.queueDispatcher.retryPersistedNodeWake(threadId, persistedNodeWakeRetryItem.id);
      const retriedItem = await withQueueDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.getById(persistedNodeWakeRetryItem.id) ?? persistedNodeWakeRetryItem);
      await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "info", "persisted orchestration node wake retry accepted", {
        workspaceId,
        threadId,
        queueItemId: persistedNodeWakeRetryItem.id,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
      }));
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 200,
        body: { ok: true, item: retriedItem, idempotent: true },
      });
    } catch (error) {
      if (isWorkspaceApiRequestFailure(error)) throw error;
      const rootCause = await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "persisted orchestration node wake retry rejected", {
        code: "orchestration_persisted_input_wake_retry_failed",
        requestId: req.id,
        workspaceId,
        threadId,
        queueItemId: persistedNodeWakeRetryItem.id,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
      }, { error }));
      ctx.onApiFailureLogged?.();
      ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: rootCause } });
    }
    return;
  }
  const queueEligibilityError = await withQueueDatabase(ctx, req.id, () => validateQueueEligibleThread(ctx, {
    threadId,
    subtype: persistedThread.threadSubtype,
    imageCount: images.length,
  }));
  if (queueEligibilityError) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: queueEligibilityError.status,
      body: { ok: false, message: queueEligibilityError.message },
    });
    return;
  }

  let item: ThreadMessageQueueItem;
  let idempotent = false;
  try {
    const result = await withQueueDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.appendItem({
      workspaceId,
      threadId,
      text,
      ...(inputContract.inputKind ? { inputKind: inputContract.inputKind } : {}),
      ...(inputContract.skillMentions ? { skillMentions: inputContract.skillMentions } : {}),
      images,
      files,
      pathReferences,
      sendOptions,
      originWebSessionId,
      sharedWorkspaceToolContext,
      executionProfileContext,
      assetExecutionAuthorization,
      clientItemId,
    }));
    item = result.item;
    idempotent = result.idempotent;
  } catch (e) {
    const message = await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "thread queue append persistence failed", {
      code: "THREAD_QUEUE_APPEND_FAILED",
      requestId: req.id,
      workspaceId,
      threadId,
      clientItemId,
    }, { error: e }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message } });
    return;
  }

  // 结果未知的重放必须显式失败，不能恢复暂停或再次执行引擎副作用。
  if (idempotent && item.status === "failed" && item.failureCode === ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE) {
    const message = "上次消息是否已被接收尚未确认，为避免重复执行，本次不会再次投递。请先核对会话记录。";
    await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "queue append replay rejected: delivery outcome unknown", {
      code: ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE,
      requestId: req.id,
      workspaceId,
      threadId,
      queueItemId: item.id,
      clientItemId,
      rootCause: { type: "persisted_queue_failure", code: item.failureCode },
    }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE, message } });
    return;
  }

  if (idempotent && item.status === "failed" && isRecoverableAcknowledgedFinalizationFailure(item.failureCode)) {
    const acknowledgedFailureCode = item.failureCode;
    try {
      if (!ctx.queueDispatcher?.retryAcknowledgedFinalization) {
        throw new Error("队列 ACK 后本地收尾重试能力未就绪");
      }
      await ctx.queueDispatcher.retryAcknowledgedFinalization(threadId, item.id);
      item = await withQueueDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.getById(item.id) ?? item);
      await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "info", "acknowledged queue finalization retry accepted", {
        requestId: req.id,
        workspaceId,
        threadId,
        queueItemId: item.id,
        clientItemId,
        acknowledgedFailureCode,
      }));
    } catch (error) {
      if (isWorkspaceApiRequestFailure(error)) throw error;
      const rootCause = await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "acknowledged queue finalization retry rejected", {
        code: "queue_post_ack_finalization_retry_failed",
        requestId: req.id,
        workspaceId,
        threadId,
        queueItemId: item.id,
        clientItemId,
      }, { error }));
      ctx.onApiFailureLogged?.();
      ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: rootCause } });
      return;
    }
  }

  if (idempotent && item.status === "failed" && item.failureCode === "active_turn_append_evidence_incomplete") {
    await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "error", "acknowledged queue evidence is incomplete", {
      code: item.failureCode,
      requestId: req.id,
      workspaceId,
      threadId,
      queueItemId: item.id,
      clientItemId,
      rootCause: { type: "persisted_queue_failure", code: item.failureCode },
    }));
    ctx.onApiFailureLogged?.();
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, message: "输入已被接收，但本地记录未完整保存；为避免重复执行，系统不会再次投递。" },
    });
    return;
  }

  if (options) {
    try { options.beforeDispatch(); }
    catch (cause) {
      try {
        // 失败隔离不得覆盖用户或生命周期已设置的暂停原因。
        await withQueueDatabase(ctx, req.id, () => {
          if (!ctx.db.threadQueueStates.getState(threadId).paused) ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
        });
      }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "异步回答保存与队列隔离均失败"); }
      throw cause;
    }
  }
  let autoResumeStalePause = queueStateBeforeAppend.paused
    && (options ? item.status === "pending" && queueStateBeforeAppend.pausedReason === "send_failed" : shouldAutoResumeStalePauseOnAppend(
      queueStateBeforeAppend.pausedReason,
      activeItemCountBeforeAppend,
      nodeQueueMode,
      idempotent,
    ));
  if (autoResumeStalePause && item.status !== "sent") {
    // 只恢复入口时的暂停代次，许可间新增的用户暂停或通知失败必须保留。
    autoResumeStalePause = await withQueueDatabase(ctx, req.id, () => {
      const current = ctx.db.threadQueueStates.getState(threadId);
      if (!current.paused || current.pausedReason !== queueStateBeforeAppend.pausedReason || current.pausedAt !== queueStateBeforeAppend.pausedAt) return false;
      ctx.db.threadQueueStates.resume(threadId, workspaceId);
      return true;
    });
  }
  if (autoResumeStalePause && item.status !== "sent") {
    await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "info", "stale queue pause auto-resumed on append", {
      workspaceId,
      threadId,
      pausedReason: queueStateBeforeAppend.pausedReason,
      queueItemId: item.id,
      idempotent,
    }));
    if (idempotent) await withQueueDatabase(ctx, req.id, () => emitQueueChanged(ctx, workspaceId, threadId, "resumed", { requestId: req.id, queueItemId: item.id }));
  }
  if (!idempotent) {
    // 仅真实创建新项时广播；幂等 ack 不打扰其他端
    await withQueueDatabase(ctx, req.id, () => emitQueueChanged(ctx, workspaceId, threadId, "appended", { requestId: req.id, queueItemId: item.id }));
    await withQueueDatabase(ctx, req.id, () => writeWorkspaceQueueLog(ctx, logScope, "info", "queue item appended", {
      workspaceId,
      threadId,
      queueItemId: item.id,
      textLength: text.trim().length,
      imageCount: images.length,
      fileCount: files.length,
      pathReferenceCount: pathReferences.length,
      pendingCount: ctx.db.threadMessageQueue.listActiveByThread(threadId).filter((it) => it.status === "pending").length,
      sessionActive: ctx.sessions.hasActiveTurn(threadId),
      activeTurnId: ctx.getActiveThreadTurn?.({ workspaceId, threadId })?.turnId ?? null,
      paused: ctx.db.threadQueueStates.getState(threadId).paused,
    }));
  }
  if ((!idempotent || autoResumeStalePause || options && item.status === "pending") && item.status !== "sent") {
    ctx.queueDispatcher?.kickIfIdle(threadId);
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, item, idempotent } });
}

/** 仅识别业务已 ACK、尚待完成本地队列收尾的稳定失败码。 */
function isRecoverableAcknowledgedFinalizationFailure(code: string | null): boolean {
  return code === "active_turn_append_post_ack_failed"
    || code === "orchestration_pending_input_post_ack_failed"
    || code === "orchestration_feedback_post_ack_failed";
}

/** 同步队列段复用唯一数据库准入，异步重试必须在许可外等待。 */
function withQueueDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** threads.queue.list：返回 thread 当前队列快照（活跃项 + 暂停状态）。 */
export async function onThreadQueueList(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueueListRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  const persistedThread = ctx.db.threads.get(threadId);
  if (!persistedThread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (persistedThread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  const snapshot = buildSnapshot(ctx, threadId);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...snapshot } });
  });
}

/** threads.queue.move：上移/下移 pending 单项（sending 项不允许调整顺序）。 */
export async function onThreadQueueMove(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueueMoveRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const queueItemId = String(body?.queueItemId ?? "").trim();
  const direction = body?.direction === "down" ? "down" : "up";
  if (!workspaceId || !threadId || !queueItemId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/queueItemId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  const item = loadPendingQueueItemForMutation(ctx, { workspaceId, threadId, queueItemId });
  if ("errorStatus" in item) {
    ctx.send({ t: "api.res", id: req.id, status: item.errorStatus, body: { ok: false, message: item.message } });
    return;
  }
  const moved = direction === "up"
    ? ctx.db.threadMessageQueue.moveUp(threadId, queueItemId)
    : ctx.db.threadMessageQueue.moveDown(threadId, queueItemId);
  const items = ctx.db.threadMessageQueue.listActiveByThread(threadId);
  if (moved) emitQueueChanged(ctx, workspaceId, threadId, "moved", { requestId: req.id, queueItemId });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, items } });
  });
}

/** threads.queue.remove：硬删 pending 单项（sending 项不允许删除）。 */
export async function onThreadQueueRemove(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueueRemoveRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const queueItemId = String(body?.queueItemId ?? "").trim();
  if (!workspaceId || !threadId || !queueItemId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/queueItemId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  const item = loadPendingQueueItemForMutation(ctx, { workspaceId, threadId, queueItemId });
  if ("errorStatus" in item) {
    ctx.send({ t: "api.res", id: req.id, status: item.errorStatus, body: { ok: false, message: item.message } });
    return;
  }
  const removed = ctx.db.threadMessageQueue.remove(threadId, queueItemId);
  if (removed) emitQueueChanged(ctx, workspaceId, threadId, "removed", { requestId: req.id, queueItemId });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, removed } });
  });
}

/** threads.queue.clear：清空 thread 全部 pending 项；sending 项由运行态收尾。 */
export async function onThreadQueueClear(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueueClearRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  const cleared = ctx.db.threadMessageQueue.clear(threadId);
  if (cleared > 0) emitQueueChanged(ctx, workspaceId, threadId, "cleared", { requestId: req.id });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, cleared } });
  });
}

/** threads.queue.resume：清暂停 + 立即触发 dispatcher 消费下一条。 */
export async function onThreadQueueResume(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueueResumeRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  const persistedThread = ctx.db.threads.get(threadId);
  if (!persistedThread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (persistedThread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  const queueState = ctx.db.threadQueueStates.getState(threadId);
  ctx.db.threadQueueStates.resume(threadId, workspaceId);
  emitQueueChanged(ctx, workspaceId, threadId, "resumed", { requestId: req.id });
  ctx.queueDispatcher?.kickIfIdle(threadId);
  const snapshot = buildSnapshot(ctx, threadId);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...snapshot } });
  });
}

/** threads.queue.pause：标记 paused（用户主动暂停或来自 dispatcher 的状态同步）。 */
export async function onThreadQueuePause(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  return await withQueueDatabase(ctx, req.id, () => {
  const body = req.body as ThreadQueuePauseRequestBody;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const reason = parsePauseReason(body?.reason);
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const scoped = routeWorkspaceCoreQueueContext(ctx, workspaceId, threadId);
  if (!scoped) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "工作区未承载" } });
    return;
  }
  ctx = scoped;
  ctx.db.threadQueueStates.pause(threadId, workspaceId, reason);
  emitQueueChanged(ctx, workspaceId, threadId, "paused", { requestId: req.id });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, paused: true } });
  });
}
