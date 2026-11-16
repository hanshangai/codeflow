import crypto from "node:crypto";

import {
  type ConversationEventInput,
  type EngineType,
  type EngineCallTrace,
  type ItemId,
  type NodeFeedbackExecutionOverride,
  type OrchestrationId,
  type ThreadId,
  type ThreadMessageQueueItem,
  type ThreadQueueSendOptions,
  type ThreadQueueChangedReason,
  type ThreadQueuePauseReason,
  type ThreadQueueSharedWorkspaceContext,
  type ThreadQueueState,
  type TurnId,
  type WorkspaceId,
} from "@codeflowai/shared";
import { buildPromptText } from "../app/utils/promptWithAttachments.js";

import type { ApiHandlerContext, ApiRequestMessage } from "../app/handleApiRequest.js";
import { describeWorkspaceApiFailure, handleApiRequest, isWorkspaceApiRequestFailure, WorkspaceApiRequestFailure } from "../app/handleApiRequest.js";
import { emitQueueChanged, QueueChangeNotificationError } from "../app/handleThreadQueueRequest.js";
import { ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE } from "../db/repos/threadMessageQueueRepo.js";
import { OrchRequirementAnalysisSessionRepoError } from "../db/repos/orchRequirementAnalysisSessionRepo.js";
import { OrchInstanceScopeError, readStrictInstanceNodeStates } from "../db/repos/orchInstanceRepo.js";
import { RequirementAnalysisService } from "../orchestration/requirementAnalysisService.js";
import {
  buildUnsupportedOrchestrationNodeQueueMessage,
  type OrchestrationNodeQueueBinding,
  resolveOrchestrationNodeQueueBinding,
  resolveOrchestrationNodeQueueMode,
} from "./orchestrationNodeQueuePolicy.js";
import {
  buildNodeExecutionOptionsConflictMessage,
  compareThreadQueueExecutionOptions,
  ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
  type ThreadQueueExecutionCompatibility,
} from "./threadQueueExecutionPolicy.js";

type ActiveQueueTurn = NonNullable<ReturnType<NonNullable<ApiHandlerContext["getActiveThreadTurn"]>>>;
type QueueOperation = { running: boolean; promise: Promise<void>; failure?: { error: unknown } };

/**
 * 运行中输入队列调度器。
 * 触发点：
 *   - resume / append 后 kickIfIdle（仅 idle 时开新 turn）
 *   - assistant/tool 完成边界 kickAtActiveTurnBoundary（active 时走 append/steer）
 *   - onThreadsSendMessage turn 终态回调 notifyTurnTerminal（兜底推进）
 *   - bootstrap 时 recoverOnStartup（重置残留 sending）
 */
export class ThreadQueueDispatcher {
  /** 同一 thread 串行消费的简单互斥（防御 kickIfIdle 重入与并发触发）。 */
  private readonly inFlight = new Map<string, QueueOperation>();
  /** 已为 pending 节点输入发起过的实例唤醒；等 active turn 出现后再清理并消费。 */
  private readonly orchestrationWakeRequests = new Set<string>();
  /** 已持久化节点输入的在途唤醒；同一实例/线程的幂等重试共享结果。 */
  private readonly persistedOrchestrationWakeRequests = new Map<
    string,
    Promise<{ ok: true; deferred?: boolean } | { ok: false; rootCause: string }>
  >();
  /** turn 终态事件落库存在异步回环，完成后用短延迟重试队列消费。 */
  private readonly scheduledKickTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private startupClaimsReset = false;
  private readonly workspaceDispatchers = new Map<WorkspaceId, ThreadQueueDispatcher>();
  private readonly databaseAdmissions = new Set<Promise<void>>();

  /** 同一调度器在实际派发前按持久会话归属选执行上下文。 */
  constructor(private readonly ctx: ApiHandlerContext, private readonly resolveExecutionContext?: (threadId: ThreadId, workspaceId?: WorkspaceId) => ApiHandlerContext,
    private readonly onBackgroundFailure?: (workspaceId: WorkspaceId, threadId: ThreadId, error: unknown) => void,
    private readonly withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>) {}

  /** 每个同步数据库段独立准入，调用方不得将provider Promise放进此回调。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.withLegacyDatabase ? await this.withLegacyDatabase(`queue:${this.ctx.db.workspaceId ?? "root"}`, operation) : operation();
  }

  /** kick准入与真实派发分开记录，避免预先占用inFlight把自己的claim短路。 */
  private admitKick(threadId: ThreadId, operation: () => void): void {
    const task = this.withDatabase(operation).catch(async error => {
      try { await this.withDatabase(() => this.retainBackgroundFailure(threadId, { running: false, promise: Promise.resolve() }, error)); }
      catch (cause) { this.retainAdmissionFailure(threadId, { running: false, promise: Promise.resolve() }, error, cause); }
    });
    this.databaseAdmissions.add(task);
    void task.then(() => this.databaseAdmissions.delete(task));
  }

  /** 准入自身失效时不再次访问数据库，原失败保留给waitForIdle并通知owner。 */
  private retainAdmissionFailure(threadId: ThreadId, operation: QueueOperation, error: unknown, cause: unknown): void {
    const failure = new AggregateError([error, cause], "QUEUE_ADMISSION_FAILED", { cause: error });
    operation.running = false; operation.failure = { error: failure };
    this.inFlight.set(String(threadId), operation);
    try { this.onBackgroundFailure?.(this.ctx.db.workspaceId as WorkspaceId, threadId, failure); }
    catch (notification) { operation.failure = { error: new AggregateError([failure, notification], "QUEUE_FAILURE_OWNER_NOTIFICATION_FAILED", { cause: failure }) }; }
  }

  /** 更新准入只观察已收口失败；不等待运行任务、不消费原结果。 */
  assertNoFailure(): void {
    const failures: unknown[] = [];
    for (const operation of this.inFlight.values()) if (!operation.running && operation.failure) failures.push(operation.failure.error);
    for (const dispatcher of this.workspaceDispatchers.values()) {
      try { dispatcher.assertNoFailure(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "QUEUE_BACKGROUND_OPERATIONS_FAILED", { cause: failures[0] });
  }

  /** 原在途记录持有已处理Promise及失败原值；最终owner等待后才消费失败。 */
  async waitForIdle(): Promise<void> {
    const failures: unknown[] = [];
    const recordFailure = (error: unknown): void => { if (!failures.some(existing => Object.is(existing, error))) failures.push(error); };
    const observed = new Map<string, QueueOperation>();
    while (true) {
      for (const [threadId, operation] of this.inFlight) observed.set(threadId, operation);
      if (![...this.inFlight.values()].some(operation => operation.running) && !this.persistedOrchestrationWakeRequests.size && !this.databaseAdmissions.size) break;
      const results = await Promise.allSettled([...this.inFlight.values()].map(operation => operation.promise)
        .concat([...this.persistedOrchestrationWakeRequests.values()].map(promise => promise.then(() => {})), [...this.databaseAdmissions]));
      for (const result of results) if (result.status === "rejected") recordFailure(result.reason);
    }
    for (const [threadId, operation] of observed) {
      if (operation.failure) {
        recordFailure(operation.failure.error);
        if (this.inFlight.get(threadId) === operation) this.inFlight.delete(threadId);
      }
    }
    for (const dispatcher of this.workspaceDispatchers.values()) {
      try { await dispatcher.waitForIdle(); } catch (error) { recordFailure(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "QUEUE_BACKGROUND_OPERATIONS_FAILED", { cause: failures[0] });
  }

  /** 在原互斥记录中保留后台结果；失败通知只唤醒最终owner，不抛离timer/Promise。 */
  private retainBackgroundFailure(threadId: ThreadId, operation: QueueOperation, error: unknown): void {
    operation.running = false;
    this.cancelScheduledKick(threadId);
    this.clearOrchestrationWakeRequest(threadId);
    let failure = error;
    try {
      const state = this.ctx.db.threadQueueStates.getState(threadId);
      if (!state.paused && this.ctx.db.threadMessageQueue.hasActiveByThread(threadId)) {
        this.ctx.db.threadQueueStates.pause(threadId, this.ctx.db.workspaceId as WorkspaceId, "send_failed");
      }
    } catch (cleanupError) { failure = new WorkspaceApiRequestFailure([error, cleanupError], { code: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
      workspaceId: this.ctx.db.workspaceId, requestId: `queue:${threadId}`, method: "queue.dispatch" }); }
    operation.failure = { error: failure };
    this.inFlight.set(String(threadId), operation);
    try { this.onBackgroundFailure?.(this.ctx.db.workspaceId as WorkspaceId, threadId, failure); }
    catch (notificationError) {
      operation.failure = { error: new AggregateError([failure, notificationError], "QUEUE_FAILURE_OWNER_NOTIFICATION_FAILED", { cause: failure }) };
      this.inFlight.set(String(threadId), operation);
    }
  }

  /** 后台任务总有已处理结果，隔离通知沿原合同结束，其余失败保留到等待入口。 */
  private trackBackgroundOperation(threadId: ThreadId, task: Promise<void>, completed?: () => void): void {
    const operation: QueueOperation = { running: true, promise: Promise.resolve() };
    this.inFlight.set(String(threadId), operation);
    operation.promise = task.then(async () => {
      this.inFlight.delete(String(threadId));
      if (completed) await this.withDatabase(completed);
    }).catch(async error => {
      if (error instanceof QueueChangeNotificationError && error.isolated) { this.inFlight.delete(String(threadId)); return; }
      let failure = error;
      try {
      await this.withDatabase(() => {
      if (!(error instanceof QueueChangeNotificationError) && !isWorkspaceApiRequestFailure(error)) {
        try { this.writeLog("error", "queue background task failed", { code: "QUEUE_BACKGROUND_TASK_FAILED", threadId }, { error }); }
        catch (loggingError) { failure = loggingError; }
      }
      this.retainBackgroundFailure(threadId, operation, failure);
      });
      } catch (cause) { this.retainAdmissionFailure(threadId, operation, error, cause); }
    });
  }

  /** 未知异常描述失败仍保原因，不执行getter或把秘密正文写入诊断。 */
  private describeFailure(error: unknown): ReturnType<typeof describeWorkspaceApiFailure> {
    try { return describeWorkspaceApiFailure(error); }
    catch (failure) { throw new WorkspaceApiRequestFailure([error, failure], { code: "WORKSPACE_API_REQUEST_LOG_FAILED",
      workspaceId: this.ctx.db.workspaceId, requestId: "queue:diagnostic", method: "queue.dispatch" }); }
  }

  /** 调度诊断只落当前W；格式或writer失败阻止后续业务副作用并保留原值。 */
  private writeLog(level: "debug" | "info" | "warn" | "error", message: string, data: Record<string, unknown>, original?: { error: unknown }): void {
    const workspaceId = this.ctx.db.workspaceId;
    const requestId = typeof data.requestId === "string" && data.requestId ? data.requestId : `queue:${String(data.queueItemId ?? data.threadId ?? workspaceId)}`;
    try {
      if (!workspaceId) throw new Error("QUEUE_WORKSPACE_SCOPE_REQUIRED");
      const safeData = { ...data };
      for (const key of ["rootCause", "error", "message"]) {
        if (key in safeData) { safeData[key] = describeWorkspaceApiFailure(safeData[key]).rootCause; }
      }
      this.ctx.db.writeWorkspaceLog(workspaceId, { level, tag: "queue", message, data: { ...safeData, workspaceId, requestId,
        event: { category: "queue", action: "dispatch", outcome: level === "error" ? "fail" : "success" },
        ...(original ? { rootCause: describeWorkspaceApiFailure(original.error).rootCause } : {}) } });
    } catch (failure) { throw new WorkspaceApiRequestFailure(original ? [original.error, failure] : [failure], {
      code: "WORKSPACE_API_REQUEST_LOG_FAILED", workspaceId, requestId, method: "queue.dispatch",
    }); }
  }

  /** 明确尚未调用业务的诊断失败只释放当前attempt；不碰任何ACK后的队列事实。 */
  private writeBeforeDelivery(item: Pick<ThreadMessageQueueItem, "id" | "attemptCount">, message: string, data: Record<string, unknown>): void {
    try { this.writeLog("info", message, data); }
    catch (error) {
      try { if (!this.ctx.db.threadMessageQueue.releaseClaim(item.id, item.attemptCount)) throw new Error("QUEUE_DIAGNOSTIC_CLAIM_RELEASE_CONFLICT"); }
      catch (cleanupError) { throw new WorkspaceApiRequestFailure([error, cleanupError], { code: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
        workspaceId: this.ctx.db.workspaceId, requestId: `queue:${item.id}`, method: "queue.dispatch" }); }
      throw error;
    }
  }

  /** 原运行 owner 为每个可信工作区保留独立在途状态，禁止按裸 ID 反查物理库。 */
  forWorkspace(workspaceId: WorkspaceId): ThreadQueueDispatcher {
    if (!this.ctx.workspaces.has(workspaceId)) throw new Error("QUEUE_WORKSPACE_NOT_HOSTED");
    if (this.ctx.db.workspaceId === workspaceId) return this;
    const existing = this.workspaceDispatchers.get(workspaceId);
    if (existing) return existing;
    const context: ApiHandlerContext = { ...this.ctx, db: this.ctx.db.forWorkspace(workspaceId),
      ...(this.ctx.orchEngine ? { orchEngine: this.ctx.orchEngine.forWorkspace(workspaceId) } : {}) };
    const dispatcher = new ThreadQueueDispatcher(context, this.resolveExecutionContext, this.onBackgroundFailure, this.withLegacyDatabase);
    context.queueDispatcher = dispatcher;
    this.workspaceDispatchers.set(workspaceId, dispatcher);
    return dispatcher;
  }

  /** 生产根调度器必须先由可信工作区选定，单库适配器沿其既有连接执行。 */
  private assertWorkspaceSelected(): void {
    if (this.ctx.db.workspaceId === null) throw new Error("QUEUE_WORKSPACE_SCOPE_REQUIRED");
  }

  /** 所有消费和唤醒复用当前可信工作区上下文。 */
  private requireReadyExecutionContext(threadId: ThreadId): ApiHandlerContext {
    this.assertWorkspaceSelected();
    const resolved = this.resolveExecutionContext?.(threadId, this.ctx.db.workspaceId ?? undefined) ?? this.ctx;
    const context = this.ctx.db.workspaceId ? { ...resolved, db: this.ctx.db,
      ...(resolved.orchEngine ? { orchEngine: resolved.orchEngine.forWorkspace(this.ctx.db.workspaceId) } : {}), queueDispatcher: this } : resolved;
    return context;
  }

  /** claim及真实追加前复验持久来源；旧共享写上下文原样交给权威入口拒绝。 */
  private assertQueueAssetExecution(context: ApiHandlerContext, threadId: ThreadId,
    item: Pick<ThreadMessageQueueItem, "id" | "sendOptions">): void {
    if (!context.assertAssetExecution) return;
    const thread = context.db.threads.get(threadId);
    if (!thread) throw new Error(`队列执行会话不存在：${threadId}`);
    const authorization = context.db.threadMessageQueue.getAssetExecutionAuthorization(item.id);
    const toolContext = context.db.threadMessageQueue.getSharedWorkspaceToolContext(item.id);
    context.assertAssetExecution({ workspaceId: thread.workspaceId, threadId,
      ...(item.sendOptions.roleId ? { root: { assetType: "role", assetId: item.sendOptions.roleId } } : {}), authorization, toolContext });
  }

  /** 返回指定工作区当前正在调度的 thread，供迁移活动门禁读取真实运行态。 */
  listInFlightByWorkspace(workspaceId: WorkspaceId): Array<{ threadId: ThreadId; resourceId: string }> {
    if (this.ctx.db.workspaceId === null) return this.workspaceDispatchers.get(workspaceId)?.listInFlightByWorkspace(workspaceId) ?? [];
    const result: Array<{ threadId: ThreadId; resourceId: string }> = [];
    for (const [rawThreadId, operation] of this.inFlight) {
      if (!operation.running) continue;
      const threadId = rawThreadId as ThreadId;
      const thread = this.ctx.db.threads.get(threadId);
      if (thread?.workspaceId !== workspaceId) continue;
      result.push({ threadId, resourceId: `thread:${threadId}` });
    }
    return result.sort((left, right) => String(left.threadId).localeCompare(String(right.threadId)));
  }

  /** 更新冻结后等待所有已受理队列操作收口，仅读取原在途集合。 */
  hasInFlightWork(): boolean {
    return this.inFlight.size > 0 || this.persistedOrchestrationWakeRequests.size > 0
      || [...this.workspaceDispatchers.values()].some(dispatcher => dispatcher.hasInFlightWork());
  }

  /** 迁移门禁释放后重新触发该工作区仍为 pending 的队列。 */
  resumeWorkspace(workspaceId: WorkspaceId): void {
    if (this.ctx.db.workspaceId === null) { this.forWorkspace(workspaceId).resumeWorkspace(workspaceId); return; }
    if (this.ctx.db.workspaceId && this.ctx.db.workspaceId !== workspaceId) throw new Error("QUEUE_WORKSPACE_SCOPE_MISMATCH");
    for (const threadId of this.ctx.db.threadMessageQueue.listThreadsWithPending()) {
      const thread = this.ctx.db.threads.get(threadId);
      if (thread?.workspaceId === workspaceId) this.scheduleKickIfIdle(threadId);
    }
  }

  /** 启动重置sending；归属故障显式失败队列，坏节点绑定阻断本区节点而不关闭Client。 */
  recoverOnStartup(shouldRecover: (threadId: ThreadId, workspaceId?: WorkspaceId) => boolean = () => true): void {
    if (this.ctx.db.workspaceId === null) {
      for (const workspaceId of this.ctx.workspaces.keys()) this.forWorkspace(workspaceId).recoverOnStartup(shouldRecover);
      return;
    }
    const reset = this.startupClaimsReset ? 0 : this.ctx.db.threadMessageQueue.resetAllSending();
    this.startupClaimsReset = true;
    if (reset > 0) {
      this.writeLog("info", "reset residual sending items on startup", { reset });
    }
    for (const threadId of this.ctx.db.threadMessageQueue.listThreadsWithPending()) {
      let recover: boolean;
      try { recover = shouldRecover(threadId, this.ctx.db.workspaceId ?? undefined); }
      catch (error) {
        if (!(error instanceof OrchRequirementAnalysisSessionRepoError) && !(error instanceof OrchInstanceScopeError)) throw error;
        const thread = this.ctx.db.threads.get(threadId);
        if (!thread) throw error;
        let isolationScope: "thread" | "workspace_nodes" = "thread";
        if (error instanceof OrchRequirementAnalysisSessionRepoError) {
          if (thread.threadSubtype !== "requirement-analysis" || error.details.sessionId !== threadId) throw error;
        } else {
          if (thread.threadSubtype !== "node" && thread.threadSubtype !== "node-discussion") throw error;
          const parent = this.ctx.db.db.prepare("SELECT id, workspace_id, node_states_json FROM orch_instances WHERE id = ? AND workspace_id = ?").get(error.details.instanceId, String(thread.workspaceId));
          if (!parent || thread.workspaceId !== this.ctx.db.workspaceId || error.details.workspaceId !== thread.workspaceId) throw error;
          // 绑定列损坏无法证明单实例归属；本区节点各自明确失败，修复后须沿原入口显式恢复。
          if (["node_states_json", "node_states_json.threadId", "node_states_json.discussionThreadId", "node_states_json.previousThreadIds"].includes(error.details.field)) {
            isolationScope = "workspace_nodes";
          } else if (!Object.values(readStrictInstanceNodeStates(parent)).some(state =>
            state.threadId === threadId || state.discussionThreadId === threadId || state.previousThreadIds?.includes(threadId))) throw error;
        }
        const queueItemIds = this.ctx.db.db.transaction(() => {
          const items = this.ctx.db.threadMessageQueue.listActiveByThread(threadId);
          if (items.some(item => item.threadId !== threadId || item.workspaceId !== thread.workspaceId)) throw error;
          for (const item of items) this.ctx.db.threadMessageQueue.markFailed(item.id, error.code, "持久归属校验失败，队列已暂停");
          this.ctx.db.threadQueueStates.pause(threadId, thread.workspaceId, "send_failed");
          return items.map(item => item.id);
        })();
        this.writeLog("error", "persisted authority queue recovery failed", {
          event: { category: "queue", action: "startup_recovery", outcome: "fail" },
          errorCode: error.code, requestId: `queue-recovery:${threadId}`, workspaceId: thread.workspaceId, threadId, isolationScope,
          ...(error instanceof OrchRequirementAnalysisSessionRepoError ? { sessionId: error.details.sessionId, sessionWorkspaceId: error.details.workspaceId }
            : { instanceId: error.details.instanceId, field: error.details.field, reason: error.details.reason }), queueItemIds,
          rootCause: error instanceof OrchInstanceScopeError ? error.details.reason : error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : error.code,
        }, { error: error });
        continue;
      }
      if (recover) this.scheduleKickIfIdle(threadId);
    }
  }

  /** 消费首个 pending 项；仅当前 thread idle 时开新 turn。 */
  kickIfIdle(threadId: ThreadId): void {
    if (this.withLegacyDatabase) { this.admitKick(threadId, () => { this.kick(threadId, { allowActiveAppend: false }); }); return; }
    this.kick(threadId, { allowActiveAppend: false });
  }

  /** active 边界只隔离已持久化的队列通知失败，避免污染 canonical 事件 ACK。 */
  kickAtActiveTurnBoundary(threadId: ThreadId): void {
    if (this.withLegacyDatabase) { this.admitKick(threadId, () => { this.kick(threadId, { allowActiveAppend: true }); }); return; }
    try { this.kick(threadId, { allowActiveAppend: true }); }
    catch (error) {
      if (!(error instanceof QueueChangeNotificationError) || !error.isolated) throw error;
    }
  }

  /** 恢复已持久化节点输入的唤醒步骤，不再重复追加反馈。 */
  async retryPersistedNodeWake(
    threadId: ThreadId,
    queueItemId: string,
  ): Promise<void> {
    const { workspaceId, state, binding, nodeQueueMode } = await this.withDatabase(() => {
    this.requireReadyExecutionContext(threadId);
    const persistedThread = this.ctx.db.threads.get(threadId);
    if (!persistedThread || persistedThread.threadSubtype !== "node") {
      throw new Error(`节点唤醒重试缺少有效会话：threadId=${threadId}`);
    }
    const workspaceId = persistedThread.workspaceId as WorkspaceId;
    const state = this.ctx.db.threadQueueStates.getState(threadId);
    const item = this.ctx.db.threadMessageQueue.getById(queueItemId);
    if (!item
      || item.workspaceId !== workspaceId
      || item.threadId !== threadId
      || item.status !== "sent"
      || item.sentTurnId !== null
      || state.lastConsumedQueueId !== item.id) {
      throw new Error(`节点唤醒重试缺少已接收队列项：threadId=${threadId}, queueItemId=${queueItemId}`);
    }

    const binding = resolveOrchestrationNodeQueueBinding(this.ctx, threadId);
    const nodeQueueMode = resolveOrchestrationNodeQueueMode(binding);
    if (!binding || nodeQueueMode === "unsupported") {
      throw new Error(`节点唤醒重试状态已变化：threadId=${threadId}, queueItemId=${queueItemId}`);
    }
    return { workspaceId, state, binding, nodeQueueMode };
    });

    if (nodeQueueMode !== "pending_feedback") {
      await this.withDatabase(() => {
      if (state.paused && state.pausedReason === "send_failed") {
        this.ctx.db.threadQueueStates.resume(threadId, workspaceId);
        this.broadcastChanged(workspaceId, threadId, "resumed");
      }
      });
      return;
    }

    const wakeKey = this.orchestrationWakeKey(binding.instanceId, threadId);
    const inFlightWake = this.persistedOrchestrationWakeRequests.get(wakeKey);
    if (inFlightWake) {
      const result = await inFlightWake;
      if (!result.ok) throw new Error(result.rootCause);
      return;
    }
    if (!state.paused || state.pausedReason !== "send_failed") return;
    await this.withDatabase(() => this.writeLog("info", "persisted orchestration node wake retry started", {
      workspaceId,
      threadId,
      queueItemId,
      instanceId: binding.instanceId,
      nodeId: binding.nodeId,
      nodeStatus: binding.status,
    }));
    const result = await this.wakeOrchestrationForPersistedInput(workspaceId, threadId, queueItemId, binding, state);
    if (!result.ok) throw new Error(result.rootCause);
  }

  /** provider/节点业务已 ACK 后补齐本地状态；pending 输入还需完成遗漏的节点唤醒。 */
  async retryAcknowledgedFinalization(
    threadId: ThreadId,
    queueItemId: string,
  ): Promise<void> {
    const { persistedThread, item } = await this.withDatabase(() => {
    this.requireReadyExecutionContext(threadId);
    const persistedThread = this.ctx.db.threads.get(threadId);
    const item = this.ctx.db.threadMessageQueue.getById(queueItemId);
    if (!persistedThread
      || !item
      || item.threadId !== threadId
      || item.workspaceId !== persistedThread.workspaceId) {
      throw new Error(`ACK 后收尾重试缺少有效队列项：threadId=${threadId}, queueItemId=${queueItemId}`);
    }
    return { persistedThread, item };
    });
    if (item.status === "sent" && this.isAcknowledgedCompletionTombstone(item.failureCode)) {
      await this.withDatabase(() => this.assertAcknowledgedCompletionPointer(threadId, item));
      if (item.failureCode === "orchestration_pending_input_post_ack_failed_completed") {
        await this.retryPersistedNodeWake(threadId, queueItemId);
      }
      return;
    }
    if (item.status !== "failed") {
      throw new Error(`ACK 后收尾重试状态不兼容：threadId=${threadId}, queueItemId=${queueItemId}, status=${item.status}`);
    }
    const failureCode = String(item.failureCode ?? "");
    const requiresPersistedNodeWake = failureCode === "orchestration_pending_input_post_ack_failed";
    const sentTurnId = failureCode === "active_turn_append_post_ack_failed" ? item.sentTurnId : null;
    if ((failureCode !== "active_turn_append_post_ack_failed"
        && failureCode !== "orchestration_pending_input_post_ack_failed"
        && failureCode !== "orchestration_feedback_post_ack_failed")
      || (failureCode === "active_turn_append_post_ack_failed" && !sentTurnId)) {
      throw new Error(`ACK 后收尾重试状态不兼容：threadId=${threadId}, queueItemId=${queueItemId}, code=${failureCode || "none"}`);
    }
    const workspaceId = persistedThread.workspaceId as WorkspaceId;
    try {
      await this.withDatabase(() => this.finalizeAcknowledgedQueueItem({
        workspaceId,
        threadId,
        item,
        failureCode,
        sentTurnId,
        resumeSendFailedPause: !requiresPersistedNodeWake,
      }));
    } catch (error) {
      const current = await this.withDatabase(() => this.ctx.db.threadMessageQueue.getById(queueItemId));
      if (current?.status === "sent" && this.isAcknowledgedCompletionTombstone(current.failureCode)) {
        await this.withDatabase(() => this.assertAcknowledgedCompletionPointer(threadId, current));
        if (current.failureCode === "orchestration_pending_input_post_ack_failed_completed") {
          await this.retryPersistedNodeWake(threadId, queueItemId);
        }
        return;
      }
      throw error;
    }
    if (requiresPersistedNodeWake) {
      await this.retryPersistedNodeWake(threadId, queueItemId);
    }
    await this.withDatabase(() => this.writeLog("info", "acknowledged queue finalization retried", {
      code: "queue_post_ack_finalization_retried",
      requestId: null,
      workspaceId,
      threadId,
      queueItemId,
      failureCode,
      turnId: sentTurnId,
    }));
    this.broadcastChanged(workspaceId, threadId, "consumed");
  }

  /** ACK 屏障和消费指针同事务完成；pending wake 可保留失败暂停直到唤醒成功。 */
  private finalizeAcknowledgedQueueItem(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    item: Pick<ThreadMessageQueueItem, "id" | "attemptCount">;
    failureCode: string;
    sentTurnId: TurnId | null;
    resumeSendFailedPause?: boolean;
  }): { resumed: boolean } {
    const transaction = this.ctx.db.db.transaction(() => {
      const completed = this.ctx.db.threadMessageQueue.completePostAck(
        input.item.id,
        input.failureCode,
        input.sentTurnId,
        input.item.attemptCount,
      );
      if (!completed) {
        const current = this.ctx.db.threadMessageQueue.getById(input.item.id);
        const state = this.ctx.db.threadQueueStates.getState(input.threadId);
        if (current?.status === "sent"
          && current.failureCode === `${input.failureCode}_completed`
          && current.sentTurnId === input.sentTurnId
          && state.lastConsumedQueueId === current.id
          && state.lastConsumedTurnId === current.sentTurnId) {
          return { resumed: false };
        }
        throw new Error(`ACK 后队列收尾状态冲突：threadId=${input.threadId}, queueItemId=${input.item.id}`);
      }
      this.ctx.db.threadQueueStates.setLastConsumed(
        input.threadId,
        input.workspaceId,
        input.item.id,
        input.sentTurnId,
      );
      const state = this.ctx.db.threadQueueStates.getState(input.threadId);
      if (input.resumeSendFailedPause !== false && state.paused && state.pausedReason === "send_failed") {
        this.ctx.db.threadQueueStates.resume(input.threadId, input.workspaceId);
        return { resumed: true };
      }
      return { resumed: false };
    });
    return transaction();
  }

  /** 判断 sent 项是否为 ACK 本地收尾完成墓碑。 */
  private isAcknowledgedCompletionTombstone(code: string | null): boolean {
      return code === "active_turn_append_post_ack_failed_completed"
      || code === "orchestration_pending_input_post_ack_failed_completed"
      || code === "orchestration_feedback_post_ack_failed_completed";
  }

  /** 验证完成墓碑与最近消费指针一致，避免把半完成状态伪装成幂等成功。 */
  private assertAcknowledgedCompletionPointer(threadId: ThreadId, item: ThreadMessageQueueItem): void {
    const state = this.ctx.db.threadQueueStates.getState(threadId);
    if (state.lastConsumedQueueId !== item.id || state.lastConsumedTurnId !== item.sentTurnId) {
      throw new Error(`ACK 完成墓碑与消费指针不一致：threadId=${threadId}, queueItemId=${item.id}`);
    }
  }

  /** 按更新围栏消费；退役授权在 claim 前显式失败并暂停，空 node 返回哨兵。 */
  private kick(threadId: ThreadId, opts: { allowActiveAppend: boolean }): "empty_node" | void {
    this.assertWorkspaceSelected();
    if (this.ctx.isTaskAdmissionPaused?.()) return;
    const tid = String(threadId);
    if (this.inFlight.has(tid)) {
      this.writeLog("debug", "queue kick skipped: in-flight", { threadId, allowActiveAppend: opts.allowActiveAppend });
      return;
    }
    const persistedThread = this.ctx.db.threads.get(threadId);
    if (!persistedThread) {
      this.writeLog("warn", "queue kick skipped: thread not found", { threadId, allowActiveAppend: opts.allowActiveAppend });
      return;
    }
    const workspaceId = persistedThread.workspaceId as WorkspaceId;
    const migrationOperationId = this.ctx.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null;
    if (migrationOperationId) {
      this.writeLog("info", "queue kick deferred: workspace directory migration in progress", {
        workspaceId,
        threadId,
        operationId: migrationOperationId,
        allowActiveAppend: opts.allowActiveAppend,
      });
      return;
    }
    const isRequirementAnalysisQueue = persistedThread.threadSubtype === "requirement-analysis";
    const isNodeDiscussionQueue = persistedThread.threadSubtype === "node-discussion";
    if (persistedThread.threadSubtype
      && persistedThread.threadSubtype !== "node"
      && !isRequirementAnalysisQueue
      && !isNodeDiscussionQueue) {
      this.failActiveQueueItems({
        workspaceId,
        threadId,
        code: "subtype_not_supported",
        message: "当前线程类型不支持队列",
        subtype: persistedThread.threadSubtype,
      });
      return;
    }
    if (persistedThread.threadSubtype === "node"
      && !this.ctx.db.threadMessageQueue.hasActiveByThread(threadId)) {
      this.clearOrchestrationWakeRequest(threadId);
      this.writeLog("debug", "orchestration node queue kick skipped: no active item", {
        workspaceId,
        threadId,
        allowActiveAppend: opts.allowActiveAppend,
      });
      return "empty_node";
    }
    this.requireReadyExecutionContext(threadId);
    const queueState = this.ctx.db.threadQueueStates.getState(threadId);
    const nodeQueueBinding = persistedThread.threadSubtype === "node"
      ? resolveOrchestrationNodeQueueBinding(this.ctx, threadId)
      : null;
    const nodeQueueMode = persistedThread.threadSubtype === "node"
      ? resolveOrchestrationNodeQueueMode(nodeQueueBinding)
      : null;
    if (nodeQueueMode !== "active_supplement" && nodeQueueMode !== "pending_feedback") {
      this.clearOrchestrationWakeRequest(threadId);
    }
    if (persistedThread.threadSubtype === "node" && nodeQueueMode === "unsupported") {
      this.failActiveQueueItems({
        workspaceId,
        threadId,
        code: "orchestration_node_queue_not_supported",
        message: buildUnsupportedOrchestrationNodeQueueMessage(nodeQueueBinding),
        subtype: persistedThread.threadSubtype,
        binding: nodeQueueBinding,
      });
      return;
    }

    const state = queueState;
    if (state.paused) {
      const activeItems = this.ctx.db.threadMessageQueue.listActiveByThread(threadId);
      if (this.shouldAutoResumeStalePauseForActiveItems(state, activeItems, nodeQueueMode)) {
        this.ctx.db.threadQueueStates.resume(threadId, workspaceId);
        this.writeLog("info", "stale queue pause auto-resumed before kick", {
          workspaceId,
          threadId,
          pausedReason: state.pausedReason,
          pausedAt: state.pausedAt,
          activeItemCount: activeItems.length,
          allowActiveAppend: opts.allowActiveAppend,
        });
        this.broadcastChanged(workspaceId, threadId, "resumed");
      } else {
        this.writeLog("info", "queue kick skipped: paused", {
          workspaceId,
          threadId,
          pausedReason: state.pausedReason,
          allowActiveAppend: opts.allowActiveAppend,
          activeItemCount: activeItems.length,
        });
        return;
      }
    }

    const activeTurn = this.resolveAppendableActiveTurn(workspaceId, threadId);
    if (nodeQueueMode === "active_supplement" && activeTurn && nodeQueueBinding) {
      this.orchestrationWakeRequests.delete(this.orchestrationWakeKey(nodeQueueBinding.instanceId, threadId));
    }
    const nextSharedWorkspaceContext = this.ctx.db.threadMessageQueue.peekNextPendingSharedWorkspaceContext(threadId);
    if (isRequirementAnalysisQueue && (activeTurn || this.hasBlockingActiveTurn(workspaceId, threadId))) {
      this.writeLog("info", "requirement analysis queue deferred: active turn still running", {
        workspaceId,
        threadId,
        activeTurnId: activeTurn?.turnId ?? null,
        allowActiveAppend: opts.allowActiveAppend,
      });
      return;
    }
    if (nextSharedWorkspaceContext && (activeTurn || this.hasBlockingActiveTurn(workspaceId, threadId))) {
      this.writeLog("info", "shared workspace queue deferred: active turn still running", {
        workspaceId,
        threadId,
        sharedWorkspaceId: nextSharedWorkspaceContext.sharedWorkspaceId,
        activeTurnId: activeTurn?.turnId ?? null,
      });
      return;
    }
    if (nodeQueueMode === "feedback_resume"
      && (activeTurn || this.hasBlockingActiveTurn(workspaceId, threadId))) {
      this.writeLog("info", "orchestration feedback queue deferred: active turn still running", {
        workspaceId,
        threadId,
        activeTurnId: activeTurn?.turnId ?? null,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
      });
      return;
    }
    if (activeTurn && !opts.allowActiveAppend) {
      this.writeLog("info", "queue kick deferred: active turn waits for boundary", {
        workspaceId,
        threadId,
        activeTurnId: activeTurn.turnId,
      });
      return;
    }
    if (!activeTurn && this.hasBlockingActiveTurn(workspaceId, threadId)) {
      this.writeLog("info", "queue kick deferred: active turn not appendable yet", {
        workspaceId,
        threadId,
        allowActiveAppend: opts.allowActiveAppend,
      });
      return;
    }
    const nextPendingItem = activeTurn
      ? this.ctx.db.threadMessageQueue.listActiveByThread(threadId).find((item) => item.status === "pending") ?? null
      : null;
    if (activeTurn && nodeQueueMode === "active_supplement" && nodeQueueBinding && nextPendingItem) {
      const executionCompatibility = compareThreadQueueExecutionOptions(activeTurn.execution, nextPendingItem.sendOptions);
      if (executionCompatibility !== "same") {
        this.failNodeExecutionOptionsConflict({
          workspaceId,
          threadId,
          item: nextPendingItem,
          activeTurn,
          binding: nodeQueueBinding,
          executionCompatibility,
        });
        return;
      }
    }
    if (activeTurn
      && persistedThread.threadSubtype !== "node"
      && this.nextPendingItemRequiresFreshTurn(threadId, nextPendingItem, activeTurn)) {
      this.writeLog("info", "queue kick deferred: pending input requires fresh turn", {
        workspaceId,
        threadId,
        activeTurnId: activeTurn.turnId,
      });
      return;
    }
    if (nodeQueueMode === "pending_feedback") {
      // pending/ready/queued 还没有可追加的 provider turn；先认领并持久化反馈，再唤醒实例。
    } else if (nodeQueueMode === "active_supplement" && !activeTurn) {
      const hasPendingItem = this.ctx.db.threadMessageQueue
        .listActiveByThread(threadId)
        .some((item) => item.status === "pending");
      if (!hasPendingItem) {
        this.clearOrchestrationWakeRequest(threadId);
        return;
      }
      this.writeLog("info", "orchestration node queue deferred: waiting for active turn", {
        workspaceId,
        threadId,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
        status: nodeQueueBinding?.status ?? null,
      });
      if (nodeQueueBinding) {
        const pendingItem = this.ctx.db.threadMessageQueue
          .listActiveByThread(threadId)
          .find((item) => item.status === "pending") ?? null;
        if (pendingItem) {
          this.wakeOrchestrationForPendingInput(workspaceId, threadId, pendingItem.id, nodeQueueBinding);
        }
      }
      return;
    }

    const pendingItem = this.ctx.db.threadMessageQueue.listActiveByThread(threadId).find(item => item.status === "pending");
    if (pendingItem) {
      const executionContext = this.requireReadyExecutionContext(threadId);
      try { this.assertQueueAssetExecution(executionContext, threadId, pendingItem); }
      catch (error) {
        const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
        if (code !== "ASSET_CACHE_EXECUTION_REMOVED") throw error;
        const reason = this.describeFailure(error).message;
        this.ctx.db.db.transaction(() => {
          this.ctx.db.threadMessageQueue.markFailed(pendingItem.id, code, reason);
          this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
        })();
        this.writeLog("error", "retired asset queue input rejected before claim", {
          code, workspaceId, threadId, queueItemId: pendingItem.id, attemptCount: pendingItem.attemptCount,
        }, { error });
        this.broadcastChanged(workspaceId, threadId, "failed", pendingItem.id);
        return;
      }
    }
    const claim = this.ctx.db.threadMessageQueue.claimNextPendingForDispatch(threadId);
    if (!claim) {
      this.writeLog("debug", "queue kick skipped: no pending item", { workspaceId, threadId, allowActiveAppend: opts.allowActiveAppend });
      return;
    }
    if (claim.kind === "contract-invalid") {
      this.writeLog("error", "thread queue input contract invalid", {
        code: claim.failureCode,
        requestId: null,
        workspaceId: claim.workspaceId,
        threadId: claim.threadId,
        queueItemId: claim.queueItemId,
        attemptCount: claim.attemptCount,
        rootCause: claim.failureReason,
      });
      this.broadcastChanged(claim.workspaceId, claim.threadId, "failed");
      this.scheduleKickIfIdle(threadId);
      return;
    }
    const next = claim.item;

    this.inFlight.set(tid, { running: true, promise: Promise.resolve() });
    let queueConsumeMode = "idle_send";
    if (nodeQueueMode === "pending_feedback") queueConsumeMode = "orchestration_pending_feedback";
    else if (nodeQueueMode === "feedback_resume") queueConsumeMode = "orchestration_feedback";
    else if (isRequirementAnalysisQueue) queueConsumeMode = "requirement_analysis";
    else if (activeTurn) queueConsumeMode = "active_append";
    try {
      this.writeLog("info", "queue item claimed", {
        workspaceId,
        threadId,
        queueItemId: next.id,
        mode: queueConsumeMode,
        activeTurnId: activeTurn?.turnId ?? null,
        instanceId: nodeQueueBinding?.instanceId ?? null,
        nodeId: nodeQueueBinding?.nodeId ?? null,
        textLength: String(next.text ?? "").trim().length,
        imageCount: next.images.length,
        fileCount: next.files.length,
      });
      this.broadcastChanged(workspaceId, threadId, "consuming", next.id);
    } catch (error) {
      try {
        if (isWorkspaceApiRequestFailure(error)) {
          if (!this.ctx.db.threadMessageQueue.releaseClaim(next.id, next.attemptCount)) throw new Error("QUEUE_DIAGNOSTIC_CLAIM_RELEASE_CONFLICT");
        } else if (error instanceof QueueChangeNotificationError && error.isolated) {
          this.ctx.db.db.transaction(() => {
            const current = this.ctx.db.threadMessageQueue.getById(next.id);
            if (!current || current.threadId !== threadId || current.workspaceId !== workspaceId
              || current.status !== "sending" || current.attemptCount !== next.attemptCount) {
              throw new Error(`队列通知失败认领状态冲突：queueItemId=${next.id}`);
            }
            this.ctx.db.threadMessageQueue.markFailed(next.id, error.code, error.message);
          })();
        }
      } catch (cleanupError) {
        const combined = new QueueChangeNotificationError(false, new AggregateError([error, cleanupError], "队列通知失败认领收尾失败"));
        this.writeLog("error", "queue notification claim cleanup failed", {
          code: "QUEUE_CHANGE_NOTIFICATION_CLAIM_CLEANUP_FAILED", requestId: `queue-notification:${next.id}`,
          workspaceId, threadId, queueItemId: next.id, attemptCount: next.attemptCount,
        }, { error: combined });
        throw combined;
      } finally { this.inFlight.delete(tid); }
      throw error;
    }

    let task: Promise<void>;
    let admissionPaused: boolean;
    try { admissionPaused = this.ctx.isTaskAdmissionPaused?.() === true; }
    catch (error) {
      let failure = error;
      try {
        try { this.releaseUpdateClaim(next, workspaceId, threadId); }
        catch (cleanupError) { failure = new AggregateError([error, cleanupError], "DESKTOP_UPDATE_QUEUE_CLAIM_CLEANUP_FAILED", { cause: error }); }
        this.writeLog("error", "desktop update admission query failed after queue claim", {
          code: "DESKTOP_UPDATE_ADMISSION_QUERY_FAILED", requestId: `queue-update:${next.id}`, workspaceId, threadId,
          queueItemId: next.id, attemptCount: next.attemptCount,
        }, { error: failure });
        throw failure;
      } finally { this.inFlight.delete(tid); }
    }
    if (admissionPaused) {
      try { this.releaseUpdateClaim(next, workspaceId, threadId); }
      finally { this.inFlight.delete(tid); }
      return;
    }
    if (nodeQueueMode === "pending_feedback" && nodeQueueBinding) {
      task = this.executePendingOrchestrationNodeInput(next, workspaceId, threadId, nodeQueueBinding);
    } else if (nodeQueueMode === "feedback_resume" && nodeQueueBinding) {
      task = this.executeOrchestrationFeedbackResume(next, workspaceId, threadId, nodeQueueBinding);
    } else if (isRequirementAnalysisQueue) {
      task = this.executeRequirementAnalysisQueueSend(next, workspaceId, threadId);
    } else if (activeTurn) {
      task = this.executeActiveTurnAppend(next, workspaceId, threadId, activeTurn.turnId);
    } else {
      task = this.executeQueueSend(next, workspaceId, threadId);
    }
    this.trackBackgroundOperation(threadId, task, () => {
      if (this.ctx.db.threadQueueStates.getState(threadId).paused) return;
      if (activeTurn && opts.allowActiveAppend) {
        this.scheduleKickIfIdle(threadId, 0, true);
        return;
      }
      this.scheduleKickIfIdle(threadId);
    });
  }

  /** 模型边界、Role 或输入合同要求 fresh turn 时，不得退化为 active append。 */
  private nextPendingItemRequiresFreshTurn(
    threadId: ThreadId,
    item: ThreadMessageQueueItem | null,
    activeTurn: ActiveQueueTurn,
  ): boolean {
    if (!item) return false;
    if (compareThreadQueueExecutionOptions(activeTurn.execution, item.sendOptions) !== "same") return true;
    if (this.ctx.db.threadMessageQueue.peekNextPendingNeedsFreshTurn(threadId)) return true;
    return Boolean(this.ctx.db.threadMessageQueue.peekNextPendingRoleId(threadId));
  }

  /** onThreadsSendMessage 的 turn 终态回调：决定是否消费下一条 / 暂停。 */
  notifyTurnTerminal(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: string;
    source: "user_send" | "queue_consume";
    queueItemId: string | null;
    outcome: "completed" | "error";
    terminationKind?: "manual_interrupt" | "transient_cleanup" | "error";
    errorCode?: string | null;
  }): void {
    if (this.ctx.db.workspaceId === null) { this.forWorkspace(input.workspaceId).notifyTurnTerminal(input); return; }
    if (this.ctx.db.workspaceId && this.ctx.db.workspaceId !== input.workspaceId) throw new Error("QUEUE_WORKSPACE_SCOPE_MISMATCH");
    try { this.handleTurnTerminal(input); }
    catch (error) {
      if (!(error instanceof QueueChangeNotificationError) || !error.isolated) throw error;
    }
  }

  /** 先完成终态与暂停记录，再通知；失败后不推进下一项。 */
  private handleTurnTerminal(input: Parameters<ThreadQueueDispatcher["notifyTurnTerminal"]>[0]): void {
    const { workspaceId, threadId, turnId, source, queueItemId, outcome, terminationKind, errorCode } = input;
    if (source !== "user_send" && source !== "queue_consume") return;
    this.writeLog("info", "queue observed turn terminal", {
      workspaceId,
      threadId,
      turnId,
      source,
      queueItemId,
      outcome,
      terminationKind: terminationKind ?? null,
      errorCode: errorCode ?? null,
    });
    let pauseReason: ThreadQueuePauseReason = "turn_error";
    if (terminationKind === "manual_interrupt") {
      pauseReason = "user_stop";
    } else if (terminationKind === "transient_cleanup") {
      pauseReason = "transient_cleanup";
    } else if (errorCode === "session_invalidated") {
      pauseReason = "session_invalidated";
    }

    const committed = this.ctx.db.db.transaction(() => {
      this.markTurnTerminalLocally({ workspaceId, threadId, turnId: turnId as TurnId, outcome });
      let changedReason: ThreadQueueChangedReason | null = null;
      if (source === "queue_consume" && queueItemId) {
        const item = this.ctx.db.threadMessageQueue.getById(queueItemId);
        if (item && (item.workspaceId !== workspaceId || item.threadId !== threadId)) {
          throw new Error(`队列终态归属冲突：threadId=${threadId}, queueItemId=${queueItemId}`);
        }
        if (item?.status === "sending") {
          if (outcome === "completed") {
            this.ctx.db.threadMessageQueue.markSent(queueItemId, turnId as TurnId);
            this.ctx.db.threadQueueStates.setLastConsumed(threadId, workspaceId, queueItemId, turnId as TurnId);
            changedReason = "consumed";
          } else if (terminationKind === "manual_interrupt") {
            this.ctx.db.threadMessageQueue.markCancelled(queueItemId, "user_stop", "queue turn interrupted by user");
            changedReason = "cancelled";
          } else {
            this.ctx.db.threadMessageQueue.markFailed(queueItemId, errorCode ?? "turn_error", "turn ended in error");
            changedReason = "failed";
          }
        }
      }
      const paused = outcome === "error" && this.pauseQueueIfActiveItemsRemain({ workspaceId, threadId, turnId, pauseReason, source }, false);
      return { changedReason, paused };
    })();
    this.ctx.clearActiveThreadTurn?.({ threadId, turnId: turnId as TurnId });
    if (committed.changedReason) this.broadcastChanged(workspaceId, threadId, committed.changedReason, queueItemId ?? undefined);
    if (committed.paused) this.broadcastChanged(workspaceId, threadId, "paused", queueItemId ?? undefined);
    if (outcome === "completed") {
      // 事件索引和 Session 收尾可能略晚，提交后再安排下一项消费。
      this.cancelScheduledKick(threadId);
      this.scheduleKickIfIdle(threadId);
    }
  }

  // ===== private =====

  /** 只有活跃且仍接受输入的回合才允许追加；通道关闭后等待真实终态。 */
  private resolveAppendableActiveTurn(workspaceId: WorkspaceId, threadId: ThreadId): ActiveQueueTurn | null {
    if (!this.ctx.sessions.hasActiveTurn(threadId) || !this.ctx.sessions.canAppendInput(threadId)) return null;
    return this.ctx.getActiveThreadTurn?.({ workspaceId, threadId, includeDb: false }) ?? null;
  }

  /** 队列消费只由 live session/runtime 阻断，历史 DB started 留给 Stop 与启动对账。 */
  private hasBlockingActiveTurn(workspaceId: WorkspaceId, threadId: ThreadId): boolean {
    if (this.ctx.sessions.hasActiveTurn(threadId)) return true;
    return Boolean(this.ctx.getActiveThreadTurn?.({ workspaceId, threadId, includeDb: false }));
  }

  /** 本地补齐并收敛 turn 索引，避免终态先到时被迟到 started 复活。 */
  private markTurnTerminalLocally(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    outcome: "completed" | "error";
  }): void {
    const existing = this.ctx.db.turns.get(input.turnId);
    if (existing && (existing.workspaceId !== input.workspaceId || existing.threadId !== input.threadId)) {
      throw new Error(`turn 终态归属冲突：turnId=${input.turnId}, threadId=${input.threadId}`);
    }
    if (!existing) {
      const thread = this.ctx.db.threads.get(input.threadId);
      if (!thread) throw new Error(`turn 终态缺少本地会话：threadId=${input.threadId}, turnId=${input.turnId}`);
      if (thread.workspaceId !== input.workspaceId) {
        throw new Error(`turn 终态工作区不匹配：threadId=${input.threadId}, turnId=${input.turnId}`);
      }
      const activeTurn = this.ctx.getActiveThreadTurn?.({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        includeDb: false,
      }) ?? null;
      const startedAt = activeTurn?.turnId === input.turnId && Number.isFinite(activeTurn.startedAt)
        ? Number(activeTurn.startedAt)
        : Date.now();
      this.ctx.db.turns.insertStarted({
        workspaceId: thread.workspaceId,
        threadId: input.threadId,
        engine: thread.engine,
        turnId: input.turnId,
        startedAt,
        startEventSeq: null,
      });
    }
    this.ctx.db.turns.setEnded(input.turnId, {
      status: input.outcome === "completed" ? "completed" : "error",
      endedAt: Date.now(),
      endEventSeq: null,
    });
  }

  /** 将不支持当前 thread/subtype 的活跃队列项显式失败，避免 pending 幽灵项反复重试。 */
  private failActiveQueueItems(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    code: string;
    message: string;
    subtype: string;
    binding?: OrchestrationNodeQueueBinding | null;
  }): void {
    const items = this.ctx.db.threadMessageQueue.listActiveByThread(input.threadId);
    for (const item of items) {
      this.ctx.db.threadMessageQueue.markFailed(item.id, input.code, input.message);
    }
    this.writeLog("warn", "queue kick skipped: thread queue mode not supported", {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      subtype: input.subtype,
      activeCount: items.length,
      instanceId: input.binding?.instanceId ?? null,
      nodeId: input.binding?.nodeId ?? null,
      nodeStatus: input.binding?.status ?? null,
      humanActionSource: input.binding?.humanActionSource ?? null,
      code: input.code,
      message: input.message,
    });
    if (items.length > 0) this.broadcastChanged(input.workspaceId, input.threadId, "failed");
  }

  /** 运行中节点的模型参数不兼容时显式失败并暂停，禁止继续向旧 turn 追加。 */
  private failNodeExecutionOptionsConflict(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    item: ThreadMessageQueueItem;
    activeTurn: ActiveQueueTurn;
    binding: OrchestrationNodeQueueBinding;
    executionCompatibility: ThreadQueueExecutionCompatibility;
  }): void {
    const message = buildNodeExecutionOptionsConflictMessage(input.executionCompatibility);
    this.ctx.db.threadMessageQueue.markFailed(
      input.item.id,
      ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
      message,
    );
    this.ctx.db.threadQueueStates.pause(input.threadId, input.workspaceId, "send_failed");
    this.writeLog("error", "orchestration node execution options conflict", {
      code: ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT,
      requestId: null,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      queueItemId: input.item.id,
      turnId: input.activeTurn.turnId,
      instanceId: input.binding.instanceId,
      nodeId: input.binding.nodeId,
      nodeStatus: input.binding.status,
      executionCompatibility: input.executionCompatibility,
      activeModel: input.activeTurn.execution?.model ?? null,
      requestedModel: input.item.sendOptions.model,
      rootCause: message,
    });
    this.broadcastChanged(input.workspaceId, input.threadId, "failed");
  }

  /** 唤醒前重查更新围栏；未接受的输入保持 pending，禁止退化为普通 chat turn。 */
  private wakeOrchestrationForPendingInput(
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    queueItemId: string,
    binding: OrchestrationNodeQueueBinding,
  ): void {
    const wakeKey = this.orchestrationWakeKey(binding.instanceId, threadId);
    if (this.orchestrationWakeRequests.has(wakeKey)) return;
    this.orchestrationWakeRequests.add(wakeKey);
    try { this.writeLog("info", "orchestration node queue wake started", {
      workspaceId,
      threadId,
      instanceId: binding.instanceId,
      instanceStatus: binding.instanceStatus ?? null,
      nodeId: binding.nodeId,
      nodeStatus: binding.status,
    }); } catch (error) { this.orchestrationWakeRequests.delete(wakeKey); throw error; }

    const task = Promise.resolve()
      .then(async () => {
        if (this.ctx.isTaskAdmissionPaused?.()) { this.orchestrationWakeRequests.delete(wakeKey); return false; }
        const context = await this.withDatabase(() => this.requireReadyExecutionContext(threadId));
        await context.orchEngine.resumeInBackground(binding.instanceId);
        return true;
      })
      .then(async (accepted) => {
        if (!accepted) return;
        await this.withDatabase(() => {
        this.writeLog("info", "orchestration node queue wake accepted", {
          workspaceId,
          threadId,
          instanceId: binding.instanceId,
          nodeId: binding.nodeId,
        });
        this.scheduleKickIfIdle(threadId);
        });
      })
      .catch(async (error) => {
        if (isWorkspaceApiRequestFailure(error)) throw error;
        await this.withDatabase(() => {
        this.orchestrationWakeRequests.delete(wakeKey);
        const message = this.describeFailure(error).message;
        const pendingItem = this.ctx.db.threadMessageQueue.getById(queueItemId);
        if (pendingItem?.status === "pending") {
          this.ctx.db.threadMessageQueue.markFailed(
            queueItemId,
            "orchestration_node_wake_failed",
            message,
          );
          this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
        }
        this.writeLog("error", "orchestration node queue wake failed", {
          code: "orchestration_node_wake_failed",
          requestId: null,
          workspaceId,
          threadId,
          queueItemId,
          instanceId: binding.instanceId,
          nodeId: binding.nodeId,
          nodeStatus: binding.status,
          error: message,
        }, { error: error });
        if (pendingItem?.status === "pending") this.broadcastChanged(workspaceId, threadId, "failed", queueItemId);
        const state = this.ctx.db.threadQueueStates.getState(threadId);
        const hasPendingItem = this.ctx.db.threadMessageQueue
          .listActiveByThread(threadId)
          .some((item) => item.status === "pending");
        if (hasPendingItem && !state.paused) {
          this.scheduleKickIfIdle(threadId);
        }
        });
      });
    this.trackBackgroundOperation(threadId, task);
  }

  private orchestrationWakeKey(instanceId: OrchestrationId, threadId: ThreadId): string {
    return `${String(instanceId)}\u0000${String(threadId)}`;
  }

  private clearOrchestrationWakeRequest(threadId: ThreadId): void {
    const suffix = `\u0000${String(threadId)}`;
    for (const key of this.orchestrationWakeRequests) {
      if (key.endsWith(suffix)) this.orchestrationWakeRequests.delete(key);
    }
  }

  /** 需求分析队列必须等业务服务完成落库后，才能把队列项标记为已消费。 */
  private async executeRequirementAnalysisQueueSend(
    item: Pick<ThreadMessageQueueItem, "id" | "text" | "images" | "files" | "pathReferences" | "sendOptions" | "attemptCount">,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ): Promise<void> {
    const turnId = `turn_req_queue_${crypto.randomUUID()}` as TurnId;
    await this.withDatabase(() => this.writeBeforeDelivery(item, "requirement analysis queue send started", {
      workspaceId,
      threadId,
      queueItemId: item.id,
      turnId,
      textLength: String(item.text ?? "").trim().length,
      imageCount: item.images.length,
      fileCount: item.files.length,
      pathReferenceCount: item.pathReferences.length,
    }));
    try {
      const executionContext = await this.withDatabase(() => {
        const context = this.requireReadyExecutionContext(threadId);
        this.assertQueueAssetExecution(context, threadId, item);
        return context;
      });
      await this.createRequirementAnalysisService(executionContext).sendMessage({
        workspaceId,
        sessionId: threadId as any,
        text: item.text,
        turnId,
        planMode: item.sendOptions.planMode,
        accessMode: item.sendOptions.accessMode,
        model: item.sendOptions.model,
        effort: item.sendOptions.effort,
        images: item.images.map((image) => image.dataUrl),
        files: item.files,
        pathReferences: item.pathReferences,
        contextWindow: item.sendOptions.contextWindow,
        autoCompactPct: item.sendOptions.autoCompactPct,
        serviceTier: item.sendOptions.serviceTier,
      });
      await this.withDatabase(() => {
      this.ctx.db.threadMessageQueue.markSent(item.id, turnId);
      this.ctx.db.threadQueueStates.setLastConsumed(threadId, workspaceId, item.id, turnId);
      this.writeLog("info", "requirement analysis queue send completed", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        turnId,
      });
      this.broadcastChanged(workspaceId, threadId, "consumed", item.id);
      });
    } catch (error) {
      if (error instanceof QueueChangeNotificationError || isWorkspaceApiRequestFailure(error)) throw error;
      await this.withDatabase(() => {
      const code = resolveQueueErrorCode(error, "requirement_analysis_send_failed");
      const message = this.describeFailure(error).message;
      const pauseReason: ThreadQueuePauseReason = code === "session_invalidated" ? "session_invalidated" : "send_failed";
      this.ctx.db.threadMessageQueue.markFailed(item.id, code, message);
      this.ctx.db.threadQueueStates.pause(threadId, workspaceId, pauseReason);
      this.writeLog("error", "requirement analysis queue send failed", {
        requestId: item.id,
        workspaceId,
        threadId,
        queueItemId: item.id,
        turnId,
        code,
        errorCode: code,
        rootCause: message,
      }, { error: error });
      this.broadcastChanged(workspaceId, threadId, "failed", item.id);
      });
    }
  }

  /** 沿可信上下文装配归属和资产，保留与 API 一致的通知投递结果。 */
  private createRequirementAnalysisService(context: ApiHandlerContext): RequirementAnalysisService {
    return new RequirementAnalysisService({
      db: context.db,
      intakeWorkspaceScope: context.intakeWorkspaceScope,
      orchAssetRuntimeRead: context.orchAssetRuntimeRead,
      threads: context.threads,
      sessions: context.sessions,
      workspaces: context.workspaces,
      timeoutPolicy: context.timeoutPolicy,
      emitConversation: (event) => {
        if (context.onBeforeEmitConversationEvent) context.onBeforeEmitConversationEvent(event);
        return context.send({ t: "conversation.event", event });
      },
      emitRaw: (event) => {
        context.send({ t: "raw.event", event });
      },
    });
  }

  /** 仅在仍有活跃队列项时写暂停态，避免历史终止污染下一次新入队。 */
  private pauseQueueIfActiveItemsRemain(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: string;
    pauseReason: ThreadQueuePauseReason;
    source: "user_send" | "queue_consume";
  }, notify = true): boolean {
    const activeItemCount = this.ctx.db.threadMessageQueue.listActiveByThread(input.threadId).length;
    if (activeItemCount <= 0) {
      this.writeLog("info", "queue pause skipped: no active items remain", {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
        pauseReason: input.pauseReason,
        source: input.source,
      });
      return false;
    }
    this.ctx.db.threadQueueStates.pause(input.threadId, input.workspaceId, input.pauseReason);
    this.writeLog("info", "queue paused after turn error", {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      pauseReason: input.pauseReason,
      source: input.source,
      activeItemCount,
    });
    if (notify) this.broadcastChanged(input.workspaceId, input.threadId, "paused");
    return true;
  }

  /** 只恢复历史中断类暂停；节点恢复模式须有暂停后的新输入才自动唤醒。 */
  private shouldAutoResumeStalePauseForActiveItems(
    state: ThreadQueueState,
    activeItems: ThreadMessageQueueItem[],
    nodeQueueMode: ReturnType<typeof resolveOrchestrationNodeQueueMode> | null = null,
  ): boolean {
    const reason = state.pausedReason;
    if (reason !== "user_stop" && reason !== "rollback" && reason !== "transient_cleanup") return false;
    if (activeItems.length === 0) return true;
    const pausedAt = Number(state.pausedAt ?? 0);
    if (!pausedAt) return false;
    if (reason === "user_stop" && nodeQueueMode === "feedback_resume") {
      return activeItems.some((item) => Number(item.enqueuedAt ?? 0) > pausedAt);
    }
    return activeItems.every((item) => Number(item.enqueuedAt ?? 0) > pausedAt);
  }

  /** 取消旧的延迟 kick，让真实 turn 终态可以立刻触发下一条队列。 */
  private cancelScheduledKick(threadId: ThreadId): void {
    const tid = String(threadId);
    const timer = this.scheduledKickTimers.get(tid);
    if (!timer) return;
    clearTimeout(timer);
    this.scheduledKickTimers.delete(tid);
  }

  /** 延迟触发消费，覆盖终态事件尚未写入 DB / session 尚未清理的短窗口。 */
  private scheduleKickIfIdle(threadId: ThreadId, attempt = 0, allowActiveAppend = false): void {
    const tid = String(threadId);
    if (this.scheduledKickTimers.has(tid)) return;
    const delays = [0, 80, 250, 1000, 3000];
    const delayMs = delays[Math.min(attempt, delays.length - 1)];
    const timer = setTimeout(() => {
      const run = (): void => {
      if (this.scheduledKickTimers.get(tid) !== timer) return;
      this.scheduledKickTimers.delete(tid);
      try {
        const kickResult = this.kick(threadId, { allowActiveAppend });
        if (kickResult === "empty_node") return;
        if (attempt >= delays.length - 1) return;
        const persistedThread = this.ctx.db.threads.get(threadId);
        if (!persistedThread) return;
        const state = this.ctx.db.threadQueueStates.getState(threadId);
        const hasPending = this.ctx.db.threadMessageQueue.listActiveByThread(threadId).some((item) => item.status === "pending");
        if (hasPending && !state.paused && !this.inFlight.has(tid)) {
          this.scheduleKickIfIdle(threadId, attempt + 1, allowActiveAppend);
        }
      } catch (e) {
        if (e instanceof QueueChangeNotificationError && e.isolated) return;
        let failure = e;
        if (!isWorkspaceApiRequestFailure(e)) {
          try { this.writeLog("error", "scheduled queue kick failed", { threadId, attempt }, { error: e }); }
          catch (loggingError) { failure = loggingError; }
        }
        this.retainBackgroundFailure(threadId, { running: false, promise: Promise.resolve() }, failure);
      }
      };
      if (this.withLegacyDatabase) this.admitKick(threadId, run);
      else run();
    }, delayMs);
    this.scheduledKickTimers.set(tid, timer);
  }

  /** active 追加的 ACK 后立即收尾；接收结果未知时保留持久化幂等屏障。 */
  private async executeActiveTurnAppend(
    item: Pick<ThreadMessageQueueItem, "id" | "text" | "images" | "files" | "pathReferences" | "attemptCount" | "sendOptions">,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    activeTurnId: TurnId,
  ): Promise<void> {
    const userItemId = `item_user_${crypto.randomUUID()}` as ItemId;
    const displayText = String(item.text ?? "").trim();
    const promptText = buildPromptText({ text: displayText, files: item.files, pathReferences: item.pathReferences });
    const images = item.images.map((image) => String(image.dataUrl ?? "")).filter(Boolean);
    let providerAccepted = false;
    let assetAdmissionValidated = false;
    let postAckFailureCode: string | null = null;

    try {
      const executionContext = await this.withDatabase(() => {
      const context = this.requireReadyExecutionContext(threadId);
      this.assertQueueAssetExecution(context, threadId, item);
      assetAdmissionValidated = true;
      this.writeBeforeDelivery(item, "active turn queue append started", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        turnId: activeTurnId,
        textLength: displayText.length,
        imageCount: images.length,
        fileCount: item.files.length,
        pathReferenceCount: item.pathReferences.length,
      });
      return context;
      });
      const appendResult = await executionContext.sessions.appendInput(threadId, {
        turnId: activeTurnId,
        userItemId,
        text: displayText,
        userMessage: promptText,
        images,
      });
      if (!appendResult) throw new Error("active turn 已结束，未能追加队列输入");
      providerAccepted = true;
      await this.withDatabase(() => {
      postAckFailureCode = "active_turn_append_evidence_incomplete";
      if (!this.ctx.db.threadMessageQueue.markPostAckPending(
        item.id,
        postAckFailureCode,
        "provider 已 ACK，等待本地证据与队列收尾",
        activeTurnId,
        item.attemptCount,
      )) {
        throw new Error(`provider ACK 屏障状态冲突：threadId=${threadId}, queueItemId=${item.id}`);
      }
      const engine = (appendResult.engineCall?.engine ?? this.ctx.db.threads.get(threadId)?.engine ?? "codex") as EngineType;

      this.emitConversation({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        type: "item.userMessage.created",
        payload: {
          turnId: activeTurnId,
          itemId: userItemId,
          activeTurnAppend: true,
          text: displayText,
          images: images.length ? images : undefined,
          files: item.files.length ? item.files : undefined,
          pathReferences: item.pathReferences.length ? item.pathReferences : undefined,
        },
      } satisfies ConversationEventInput);

      if (appendResult.engineCall) {
        this.emitUserMessageEngineCall({
          workspaceId,
          threadId,
          itemId: userItemId,
          engineCall: appendResult.engineCall,
        });
      }
      if (!this.ctx.db.threadMessageQueue.transitionPostAckCode(
        item.id,
        postAckFailureCode,
        "active_turn_append_post_ack_failed",
        "provider 与本地证据已 ACK，等待队列收尾",
        item.attemptCount,
      )) {
        throw new Error(`provider ACK 证据屏障状态冲突：threadId=${threadId}, queueItemId=${item.id}`);
      }
      postAckFailureCode = "active_turn_append_post_ack_failed";
      this.finalizeAcknowledgedQueueItem({ workspaceId, threadId, item, failureCode: postAckFailureCode, sentTurnId: activeTurnId, resumeSendFailedPause: false });
      this.writeLog("info", "active turn queue append acknowledged", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        turnId: activeTurnId,
        engine,
        transport: appendResult.engineCall?.kind ?? null,
      });
      this.broadcastChanged(workspaceId, threadId, "consumed", item.id);
      });
    } catch (e) {
      if (e instanceof QueueChangeNotificationError || isWorkspaceApiRequestFailure(e)) throw e;
      await this.withDatabase(() => {
      const message = this.describeFailure(e).message;
      if (!providerAccepted
        && assetAdmissionValidated
        && this.isActiveAppendTurnClosedBeforeDelivery(workspaceId, threadId, activeTurnId, e)
        && this.ctx.db.threadMessageQueue.releaseClaim(item.id, item.attemptCount)) {
        this.writeLog("info", "active turn queue append requeued after terminal race", {
          code: "active_turn_append_requeued",
          requestId: null,
          workspaceId,
          threadId,
          queueItemId: item.id,
          turnId: activeTurnId,
          attemptCount: item.attemptCount,
          error: message,
        });
        this.broadcastChanged(workspaceId, threadId, "resumed");
        return;
      }
      const errorRecord = e && typeof e === "object" ? e as Record<string, unknown> : null;
      const outcomeUnknown = !providerAccepted && (
        errorRecord?.requestOutcomeUnknown === true
        || (errorRecord?.method === "turn/steer" && errorRecord.code === "codex_app_server_request_timeout")
      );
      const failureCode = providerAccepted
        ? (postAckFailureCode ?? "active_turn_append_evidence_incomplete")
        : outcomeUnknown ? ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE : "append_failed";
      if (providerAccepted) {
        this.ctx.db.threadMessageQueue.updatePostAckPendingReason(item.id, failureCode, message, item.attemptCount);
      } else {
        this.ctx.db.threadMessageQueue.markFailed(item.id, failureCode, message);
      }
      this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
      this.writeLog("error", "active turn queue append failed", {
        code: failureCode,
        requestId: null,
        workspaceId,
        threadId,
        queueItemId: item.id,
        turnId: activeTurnId,
        attemptCount: item.attemptCount,
        providerAccepted,
        requestOutcomeUnknown: outcomeUnknown,
        postAckFailureCode,
        rootCause: message,
      }, { error: e });
      this.broadcastChanged(workspaceId, threadId, "failed", item.id);
      });
    }
  }

  /** 仅确认 provider 尚未接收时退回队列；请求结果未知时禁止重复投递。 */
  private isActiveAppendTurnClosedBeforeDelivery(
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    activeTurnId: TurnId,
    error: unknown,
  ): boolean {
    const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
    if (record?.requestOutcomeUnknown === true) return false;
    const method = String(record?.method ?? "").trim();
    if (method === "turn/steer") return false;
    if (record?.code === "active_turn_input_closed" && record.requestOutcomeUnknown === false) return true;
    if (!this.ctx.sessions.hasActiveTurn(threadId)) return true;
    const current = this.ctx.getActiveThreadTurn?.({ workspaceId, threadId, includeDb: false }) ?? null;
    return !current || current.turnId !== activeTurnId;
  }

  /** 尚未启动的节点先落反馈，再唤醒编排；不会创建普通 chat turn。 */
  private async executePendingOrchestrationNodeInput(
    item: Pick<ThreadMessageQueueItem, "id" | "text" | "images" | "files" | "pathReferences" | "sendOptions" | "attemptCount">,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    binding: OrchestrationNodeQueueBinding,
  ): Promise<void> {
    const feedback = buildPromptText({
      text: String(item.text ?? "").trim(),
      files: item.files,
      pathReferences: item.pathReferences,
    }).trim();
    let businessAccepted = false;
    try {
      const shouldWake = await this.withDatabase(() => {
      const executionContext = this.requireReadyExecutionContext(threadId);
      this.assertQueueAssetExecution(executionContext, threadId, item);
      if (!feedback && item.images.length === 0) throw new Error("编排节点补充内容为空");
      this.writeBeforeDelivery(item, "pending orchestration node input persistence started", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
        nodeStatus: binding.status,
        textLength: String(item.text ?? "").trim().length,
        imageCount: item.images.length,
        fileCount: item.files.length,
        pathReferenceCount: item.pathReferences.length,
      });
      executionContext.orchEngine.appendPendingNodeInput(binding.instanceId, binding.nodeId, {
        feedback,
        images: item.images.map((image) => String(image.dataUrl ?? "")).filter(Boolean),
        executionOverride: buildNodeFeedbackExecutionOverride(item.sendOptions),
      });
      businessAccepted = true;
      const failureCode = "orchestration_pending_input_post_ack_failed";
      if (!this.ctx.db.threadMessageQueue.markPostAckPending(
        item.id,
        failureCode,
        "节点输入已接收，等待本地队列收尾",
        null,
        item.attemptCount,
      )) throw new Error(`节点输入 ACK 屏障状态冲突：threadId=${threadId}, queueItemId=${item.id}`);
      this.finalizeAcknowledgedQueueItem({ workspaceId, threadId, item, failureCode, sentTurnId: null, resumeSendFailedPause: false });
      this.broadcastChanged(workspaceId, threadId, "consumed", item.id);
      if (this.ctx.db.threadQueueStates.getState(threadId).paused) return false;
      this.writeLog("info", "pending orchestration node input persisted", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
        nodeStatus: binding.status,
      });
      return true;
      });
      if (!shouldWake) return;
      // 等唤醒结果收敛后再处理下一条，确保失败时只有当前已接收项需要幂等恢复。
      const wakeResult = await this.wakeOrchestrationForPersistedInput(workspaceId, threadId, item.id, binding);
      if (!wakeResult.ok) return;
    } catch (error) {
      if (error instanceof QueueChangeNotificationError || isWorkspaceApiRequestFailure(error)) throw error;
      await this.withDatabase(() => {
      const message = this.describeFailure(error).message;
      const failureCode = businessAccepted
        ? "orchestration_pending_input_post_ack_failed"
        : "orchestration_pending_input_failed";
      if (businessAccepted) {
        this.ctx.db.threadMessageQueue.updatePostAckPendingReason(item.id, failureCode, message, item.attemptCount);
      } else {
        this.ctx.db.threadMessageQueue.markFailed(item.id, failureCode, message);
      }
      this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
      this.writeLog("error", "pending orchestration node input persistence failed", {
        code: failureCode,
        requestId: null,
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
        nodeStatus: binding.status,
        businessAccepted,
        rootCause: message,
      }, { error: error });
      this.broadcastChanged(workspaceId, threadId, "failed", item.id);
      });
    }
  }

  /** 已持久化输入在原在途集合内收口；更新须等待它，失败不回滚已接收内容。 */
  private wakeOrchestrationForPersistedInput(
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    queueItemId: string,
    binding: Pick<OrchestrationNodeQueueBinding, "instanceId" | "nodeId" | "status">,
    expectedPause?: Pick<ThreadQueueState, "paused" | "pausedReason" | "pausedAt">,
  ): Promise<{ ok: true; deferred?: boolean } | { ok: false; rootCause: string }> {
    const wakeKey = this.orchestrationWakeKey(binding.instanceId, threadId);
    const existing = this.persistedOrchestrationWakeRequests.get(wakeKey);
    if (existing) return existing;
    const wakeRequest = this.withDatabase(() => ({ state: this.ctx.db.threadQueueStates.getState(threadId), context: this.requireReadyExecutionContext(threadId) }))
      .then(async ({ state: currentStartState, context }) => {
        // 重试只拥有入口时的暂停代次，等待许可期间的新通知失败不能被唤醒清除。
        const wakeStartState = expectedPause ?? currentStartState;
        await context.orchEngine.resumeInBackground(binding.instanceId);
        return this.withDatabase(() => {
        const state = this.ctx.db.threadQueueStates.getState(threadId);
        const wakeOwnsPause = wakeStartState.paused
          && wakeStartState.pausedReason === "send_failed"
          && state.paused
          && state.pausedReason === "send_failed"
          && state.pausedAt === wakeStartState.pausedAt;
        if (wakeOwnsPause) {
          this.ctx.db.threadQueueStates.resume(threadId, workspaceId);
          this.broadcastChanged(workspaceId, threadId, "resumed");
        }
        this.writeLog("info", "persisted orchestration node input wake accepted", {
          workspaceId,
          threadId,
          queueItemId,
          instanceId: binding.instanceId,
          nodeId: binding.nodeId,
        });
        const hasPendingItem = this.ctx.db.threadMessageQueue
          .listActiveByThread(threadId)
          .some((item) => item.status === "pending");
        if (hasPendingItem && (!state.paused || wakeOwnsPause)) this.scheduleKickIfIdle(threadId);
        return { ok: true } as const;
        });
      })
      .catch(async (error) => {
        if (error instanceof QueueChangeNotificationError || isWorkspaceApiRequestFailure(error)) throw error;
        return this.withDatabase(() => {
        const message = this.describeFailure(error).message;
        const state = this.ctx.db.threadQueueStates.getState(threadId);
        if (!state.paused) {
          this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
        }
        this.writeLog("error", "persisted orchestration node input wake failed", {
          code: "orchestration_persisted_input_wake_failed",
          requestId: null,
          workspaceId,
          threadId,
          queueItemId,
          instanceId: binding.instanceId,
          nodeId: binding.nodeId,
          nodeStatus: binding.status,
          preservedPauseReason: state.paused ? state.pausedReason : null,
          rootCause: message,
        }, { error: error });
        if (!state.paused) this.broadcastChanged(workspaceId, threadId, "paused", queueItemId);
        return { ok: false, rootCause: message } as const;
        });
      })
      .finally(() => {
        if (this.persistedOrchestrationWakeRequests.get(wakeKey) === wakeRequest) {
          this.persistedOrchestrationWakeRequests.delete(wakeKey);
        }
      });
    this.persistedOrchestrationWakeRequests.set(wakeKey, wakeRequest);
    return wakeRequest;
  }

  /** 将异常中断节点的队列补充作为编排反馈提交，成功后消费队列项但不创建普通 chat turn。 */
  private async executeOrchestrationFeedbackResume(
    item: Pick<ThreadMessageQueueItem, "id" | "text" | "images" | "files" | "pathReferences" | "sendOptions" | "attemptCount">,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    binding: OrchestrationNodeQueueBinding,
  ): Promise<void> {
    const feedback = buildPromptText({ text: String(item.text ?? "").trim(), files: item.files, pathReferences: item.pathReferences }).trim();
    let businessAccepted = false;
    try {
      const executionContext = await this.withDatabase(() => {
      const context = this.requireReadyExecutionContext(threadId);
      this.assertQueueAssetExecution(context, threadId, item);
      if (item.images.length > 0) {
        throw new Error("异常中断节点在会话中恢复执行时暂不支持直接附带图片，请改用文本描述后继续。");
      }
      if (!feedback) {
        throw new Error("编排节点恢复补充内容为空");
      }
      this.writeBeforeDelivery(item, "orchestration feedback queue resume started", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
        textLength: String(item.text ?? "").trim().length,
        fileCount: item.files.length,
        pathReferenceCount: item.pathReferences.length,
      });
      return context;
      });
      await executionContext.orchEngine.submitFeedback(
        binding.instanceId,
        binding.nodeId,
        "resume_with_input",
        {
          feedback,
          executionOverride: buildNodeFeedbackExecutionOverride(item.sendOptions),
        },
      );
      businessAccepted = true;
      await this.withDatabase(() => {
      const failureCode = "orchestration_feedback_post_ack_failed";
      if (!this.ctx.db.threadMessageQueue.markPostAckPending(
        item.id,
        failureCode,
        "节点反馈已接收，等待本地队列收尾",
        null,
        item.attemptCount,
      )) throw new Error(`节点反馈 ACK 屏障状态冲突：threadId=${threadId}, queueItemId=${item.id}`);
      this.finalizeAcknowledgedQueueItem({ workspaceId, threadId, item, failureCode, sentTurnId: null, resumeSendFailedPause: false });
      this.writeLog("info", "orchestration feedback queue resume acknowledged", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
      });
      this.broadcastChanged(workspaceId, threadId, "consumed", item.id);
      });
    } catch (e) {
      if (e instanceof QueueChangeNotificationError || isWorkspaceApiRequestFailure(e)) throw e;
      await this.withDatabase(() => {
      const message = this.describeFailure(e).message;
      const failureCode = businessAccepted
        ? "orchestration_feedback_post_ack_failed"
        : "orchestration_feedback_failed";
      if (businessAccepted) {
        this.ctx.db.threadMessageQueue.updatePostAckPendingReason(item.id, failureCode, message, item.attemptCount);
      } else {
        this.ctx.db.threadMessageQueue.markFailed(item.id, failureCode, message);
      }
      this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
      this.writeLog("error", "orchestration feedback queue resume failed", {
        code: failureCode,
        requestId: null,
        workspaceId,
        threadId,
        queueItemId: item.id,
        instanceId: binding.instanceId,
        nodeId: binding.nodeId,
        businessAccepted,
        rootCause: message,
      }, { error: e });
      this.broadcastChanged(workspaceId, threadId, "failed", item.id);
      });
    }
  }

  /** 发送 canonical conversation 事件，并执行 emit 前本地索引同步。 */
  private emitConversation(event: ConversationEventInput): void {
    if (this.ctx.onBeforeEmitConversationEvent) this.ctx.onBeforeEmitConversationEvent(event);
    this.ctx.send({ t: "conversation.event", event });
  }

  /** 将 provider 投递追踪绑定到刚创建的追加用户消息。 */
  private emitUserMessageEngineCall(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    itemId: ItemId;
    engineCall: EngineCallTrace;
  }): void {
    this.emitConversation({
      ts: Date.now(),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: input.engineCall.engine,
      type: "item.userMessage.engineCall.created",
      payload: { itemId: input.itemId, call: input.engineCall },
    } satisfies ConversationEventInput);
  }

  /**
   * 自动消费一条队列项：用"虚拟 ApiHandlerContext"调 handleApiRequest，复用 onThreadsSendMessage 的全部业务分支
   * （subtype 校验 / lifecycle / item.userMessage.created emit / continueThreadTurnWithManagedServices）。
   *
   * 为什么不直接抽出 executeSendMessageInternal 共享：
   *   onThreadsSendMessage 内含 ~300 行业务（编排 / requirementAnalysis / lifecycle / 事件 emit），抽函数风险大；
   *   虚拟 ctx 仅拦截 api.res（用于 ack 判断），其它 ws 消息透传真实 ctx，事件流与 user_send 路径完全一致。
   *   active turn 追加输入走 executeActiveTurnAppend；更新拒绝按原 claim 退回 pending。
   */
  private async executeQueueSend(
    item: Pick<
      ThreadMessageQueueItem,
      "id" | "text" | "inputKind" | "skillMentions" | "images" | "files" | "pathReferences" | "sendOptions" | "attemptCount"
    >,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
  ): Promise<void> {
    let acked = false;
    let ackTurnId: TurnId | null = null;
    let ackError: { code: string; message: string } | null = null;

    // 构造虚拟 ApiRequestMessage 复用 onThreadsSendMessage 全部分支（事件 emit / lifecycle / managed services）
    const fakeReqId = `internal_queue_${item.id}_${Date.now()}`;
    await this.withDatabase(() => this.writeBeforeDelivery(item, "idle queue send started", {
      workspaceId,
      threadId,
      queueItemId: item.id,
      fakeReqId,
      textLength: String(item.text ?? "").trim().length,
      imageCount: item.images.length,
      fileCount: item.files.length,
      pathReferenceCount: item.pathReferences.length,
    }));
    const fakeReq: ApiRequestMessage = {
      t: "api.req",
      id: fakeReqId,
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId,
        threadId,
        text: item.text,
        images: item.images.map((i) => i.dataUrl),
        files: item.files,
        pathReferences: item.pathReferences,
        ...(item.inputKind ? { inputKind: item.inputKind } : {}),
        ...(item.skillMentions?.length ? { skillMentions: item.skillMentions } : {}),
        ...item.sendOptions,
        // 透传：让 onThreadsSendMessage 的 turn 终态回调走 dispatcher.notifyTurnTerminal 的 queue_consume 分支
        __queueSource: { queueItemId: item.id },
      },
    };

    // 拦截 send：捕获 api.res 决定 ack 是否成功；其他事件透传到真实 ws
    try {
      const { executionCtx, queueAuthorization } = await this.withDatabase(() => {
      const resolved = this.resolveExecutionContext?.(threadId, workspaceId) ?? this.ctx;
      const executionCtx = { ...resolved, db: this.ctx.db, queueDispatcher: this,
        ...(resolved.orchEngine ? { orchEngine: resolved.orchEngine.forWorkspace(workspaceId) } : {}) };
      this.assertQueueAssetExecution(executionCtx, threadId, item);
      const queueAuthorization = executionCtx.assertAssetExecution
        ? this.ctx.db.threadMessageQueue.getAssetExecutionAuthorization(item.id) : null;
      Object.assign(fakeReq.body as Record<string, unknown>, this.buildSharedWorkspaceSendContextBody(item.id), this.buildExecutionProfileBody(item.id));
      return { executionCtx, queueAuthorization };
      });
      const virtualCtx: ApiHandlerContext = {
        ...executionCtx,
        ...(executionCtx.assertAssetExecution ? { assertAssetExecution: input => executionCtx.assertAssetExecution!({ ...input, authorization: queueAuthorization }) } : {}),
        send: (msg) => {
          if (msg && (msg as Record<string, unknown>).t === "api.res" && (msg as Record<string, unknown>).id === fakeReqId) {
            const status = Number((msg as Record<string, unknown>).status ?? 0);
            const resBody = (msg as Record<string, unknown>).body as Record<string, unknown> | undefined;
            const turnId = String(resBody?.turnId ?? "").trim() as TurnId;
            if (status === 200 && resBody?.ok === true && turnId) {
              acked = true;
              ackTurnId = turnId;
            } else {
              ackError = {
                code: String(resBody?.code ?? (status === 200 ? "missing_turn_id" : `status_${status}`)),
                message: String(resBody?.message ?? (status === 200 ? "send ack missing turnId" : "send failed")),
              };
            }
            return;
          }
          executionCtx.send(msg);
        },
      };

      await handleApiRequest(virtualCtx, fakeReq);
    } catch (e) {
      if (isWorkspaceApiRequestFailure(e)) throw e;
      ackError = {
        code: "exception",
        message: this.describeFailure(e).message,
      };
    }

    await this.withDatabase(() => {
    if (!acked) {
      // RPC 协议层 ack 失败（参数错误 / active turn 冲突 / subtype 拒绝 / 其他 4xx-5xx）
      // 失败必同时暂停消费；用单次 reason="failed" 通知前端，避免重复 list 拉取
      const reason = ackError ?? { code: "send_failed", message: "send failed" };
      if (reason.code === "DESKTOP_UPDATE_TASKS_PAUSED") {
        this.releaseUpdateClaim(item, workspaceId, threadId);
        return;
      }
      if (this.deferFreshTurnReservationConflict(item, workspaceId, threadId, reason)) return;
      this.ctx.db.threadMessageQueue.markFailed(item.id, reason.code, reason.message);
      this.ctx.db.threadQueueStates.pause(threadId, workspaceId, "send_failed");
      this.writeLog("error", "idle queue send ack failed", {
        workspaceId,
        threadId,
        queueItemId: item.id,
        fakeReqId,
        code: reason.code,
        message: reason.message,
      });
      this.broadcastChanged(workspaceId, threadId, "failed", item.id);
      return;
    }
    // onThreadsSendMessage 在 ACK 前已发出 item.userMessage.created；此时可立即移出 active 队列。
    this.ctx.db.threadMessageQueue.markSent(item.id, ackTurnId!);
    this.ctx.db.threadQueueStates.setLastConsumed(threadId, workspaceId, item.id, ackTurnId!);
    this.writeLog("info", "idle queue send acknowledged", {
      workspaceId,
      threadId,
      queueItemId: item.id,
      fakeReqId,
      turnId: ackTurnId,
    });
    this.broadcastChanged(workspaceId, threadId, "consumed", item.id);
    });
  }

  /** 更新尚未派发的认领按 attempt 退回 pending，保留原业务暂停；冲突显式失败。 */
  private releaseUpdateClaim(item: Pick<ThreadMessageQueueItem, "id" | "attemptCount">, workspaceId: WorkspaceId, threadId: ThreadId): void {
    if (!this.ctx.db.threadMessageQueue.releaseClaim(item.id, item.attemptCount)) {
      const message = `更新暂停队列认领释放失败：queueItemId=${item.id}`;
      this.writeLog("error", "desktop update could not release queue claim", {
        code: "DESKTOP_UPDATE_QUEUE_CLAIM_CONFLICT", requestId: `queue-update:${item.id}`, workspaceId, threadId,
        queueItemId: item.id, attemptCount: item.attemptCount, rootCause: message,
      });
      throw new Error(message);
    }
    this.broadcastChanged(workspaceId, threadId, "appended", item.id);
  }

  /** 将 fresh-turn 预占竞态按 claim attempt 原子退回 pending，等待当前 turn 结束后重试。 */
  private deferFreshTurnReservationConflict(
    item: Pick<ThreadMessageQueueItem, "id" | "inputKind" | "skillMentions" | "attemptCount">,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    reason: { code: string; message: string },
  ): boolean {
    if (
      reason.code !== "active_turn_conflict"
      || (item.inputKind == null && !item.skillMentions?.length)
    ) return false;

    const released = this.ctx.db.threadMessageQueue.releaseClaim(item.id, item.attemptCount);
    const current = released ? null : this.ctx.db.threadMessageQueue.getById(item.id);
    if (!released && current?.status === "sending" && current.attemptCount === item.attemptCount) {
      this.writeLog("error", "fresh-turn queue reservation conflict could not release claim", {
        code: "queue_claim_release_conflict",
        requestId: null,
        workspaceId,
        threadId,
        queueItemId: item.id,
        attemptCount: item.attemptCount,
        rootCause: reason.message,
      });
    } else {
      this.writeLog("info", "fresh-turn queue reservation conflict deferred", {
        code: "active_turn_conflict",
        requestId: null,
        workspaceId,
        threadId,
        queueItemId: item.id,
        attemptCount: item.attemptCount,
      });
    }
    this.broadcastChanged(workspaceId, threadId, "appended");
    return true;
  }

  /** 把队列项隐藏的共享工作区上下文还原成 threads.sendMessage 可识别的 body 字段。 */
  private buildSharedWorkspaceSendContextBody(queueItemId: string): Record<string, unknown> {
    const context = this.ctx.db.threadMessageQueue.getSharedWorkspaceToolContext(queueItemId);
    return context ? toSharedWorkspaceSendContextBody(context) : {};
  }

  /** 恢复可信入口持久化的 Profile 身份与范围，不从队列展示字段推断身份。 */
  private buildExecutionProfileBody(queueItemId: string): Record<string, unknown> {
    const context = this.ctx.db.threadMessageQueue.getExecutionProfileContext(queueItemId);
    return context ? {
      executionProfileUserId: context.userId,
      executionProfileScopeType: context.scope.scopeType,
      executionProfileScopeId: context.scope.scopeId,
    } : {};
  }

  /** 复用通知失败合同，停止所属线程的延迟调度，不改变 ACK 和 sent 事实。 */
  private broadcastChanged(workspaceId: WorkspaceId, threadId: ThreadId, reason: ThreadQueueChangedReason, queueItemId?: string): void {
    try {
      emitQueueChanged(this.ctx, workspaceId, threadId, reason, { queueItemId });
    } catch (error) {
      this.cancelScheduledKick(threadId);
      this.clearOrchestrationWakeRequest(threadId);
      throw error;
    }
  }
}

/** 把节点会话输入栏的模型参数收敛为一次性恢复覆盖，不改变角色或实例默认配置。 */
function buildNodeFeedbackExecutionOverride(sendOptions: ThreadQueueSendOptions): NodeFeedbackExecutionOverride | null {
  const model = String(sendOptions.model ?? "").trim();
  if (!model) return null;
  return {
    model,
    effort: String(sendOptions.effort ?? "").trim() || null,
    autoCompactPct: sendOptions.autoCompactPct ?? null,
    contextWindow: sendOptions.contextWindow ?? null,
    serviceTier: sendOptions.serviceTier ?? null,
  };
}

/** 将持久化上下文转为 API body 字段，保持和共享直发路径同一策略入口。 */
function toSharedWorkspaceSendContextBody(context: ThreadQueueSharedWorkspaceContext): Record<string, unknown> {
  return {
    sharedWorkspaceId: context.sharedWorkspaceId,
    sharedWorkspaceOperationId: context.operationId,
    sharedWorkspaceRouteEventId: context.routeEventId ?? null,
    sharedWorkspaceOperationKey: context.operationKey,
    sharedWorkspaceToolPolicyKey: context.toolPolicyKey,
    sharedWorkspaceLockToken: context.lockToken ?? null,
    sharedWorkspaceLockVersion: context.lockVersion ?? null,
    sharedWorkspaceAllowSharedUpgrade: Boolean(context.allowSharedUpgrade),
  };
}

/** 提取可检索的队列失败码；无结构化 code 时使用调用方给定的业务兜底码。 */
function resolveQueueErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.trim() ? code.trim() : fallback;
}
