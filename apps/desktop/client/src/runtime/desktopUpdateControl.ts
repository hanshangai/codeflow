import type { OrchestrationInstance, ThreadId, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../app/handleApiRequest.js";
import type { ThreadTurnRecord } from "../db/repos/threadTurnRepo.js";
import { cancelOrdinaryTurnBeforeDispatch, hasOrdinaryTurnExecutions, listOrdinaryTurnExecutions, waitForOrdinaryTurnExecution } from "../app/ordinaryTurnExecution.js";
import type { DesktopUpdateHooks, DesktopUpdateOperation } from "./desktopLifecycle.js";
import { waitForKnowledgeUpdateCheck } from "../knowledge/knowledgeUpdateService.js";

type UpdateContext = Pick<ApiHandlerContext, "db" | "workspaces" | "orchEngine" | "sessions" | "controlledExperiments" | "isTaskAdmissionPaused" | "withDatabase">;
type UpdateControlInput = {
  context: UpdateContext;
  requestId: string;
  timeoutMs?: number;
  queueDispatcher: { hasInFlightWork(): boolean; assertNoFailure(): void; resumeWorkspace(workspaceId: WorkspaceId): void };
  scheduledTaskScheduler: { hasInFlightWork(): boolean; beginUpdateStop(requestId: string): void; stopForUpdate(input: { requestId: string; timeoutMs?: number }): Promise<void>; resumeAfterUpdate(requestId: string): void };
  terminalManager: { hasRunningTerminals(): boolean; stopAllForUpdate(input: { requestId: string; timeoutMs?: number }): Promise<void> };
  hasBlockingTransaction(): boolean | Promise<boolean>;
  hasKnowledgeWork(): boolean;
  stopKnowledgeWork(operation: DesktopUpdateOperation): Promise<void>;
  hasAssetDraftWork(): boolean | Promise<boolean>;
  stopAssetDraftWork(operation: DesktopUpdateOperation): Promise<void>;
  interruptTurn(turn: Pick<ThreadTurnRecord, "workspaceId" | "threadId" | "turnId">, operation: DesktopUpdateOperation): Promise<void>;
};

/** 只组合既有活动和停止入口；可逆准入事实始终由 desktopLifecycle 持有。 */
export function createDesktopUpdateControl(input: UpdateControlInput): DesktopUpdateHooks {
  const ctx = input.context, timeoutMs = input.timeoutMs ?? 10_000;
  /** 活动快照与恢复写入仅占同步短许可，停止资源和等待provider由原owner执行。 */
  const database = <T>(operation: DesktopUpdateOperation, run: () => T): Promise<T> => ctx.withDatabase ? ctx.withDatabase(operation.requestId, run) : Promise.resolve(run());
  let preparedOrdinaryExecutions: ReturnType<typeof listOrdinaryTurnExecutions> = [];
  if (!input.requestId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("DESKTOP_UPDATE_CONTROL_INPUT_INVALID");
  /** 控制入口必须已冻结；业务查询和用户选择稍后不在此处另建暂停状态。 */
  const assertPrepared = (operation: DesktopUpdateOperation): void => {
    operation.signal.throwIfAborted();
    if (!ctx.isTaskAdmissionPaused?.()) throw Object.assign(new Error("更新尚未暂停新任务"), { code: "DESKTOP_UPDATE_NOT_PREPARED" });
  };
  /** 等待不可取消的原事务边界；超时明确失败，不停止进程冒充收口。 */
  const waitUntil = async (busy: () => boolean | Promise<boolean>, operation: DesktopUpdateOperation): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      assertPrepared(operation);
      const active = await busy();
      assertPrepared(operation);
      if (!active) return;
      if (Date.now() >= deadline) throw Object.assign(new Error("仍有任务或事务尚未安全结束，请稍后重试更新"), { code: "DESKTOP_UPDATE_BUSY", requestId: operation.requestId });
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
  };
  /** 原检查已收口后仍须消费诊断失败，失败时不进入后续停止副作用。 */
  const waitKnowledgeChecks = async (operation: DesktopUpdateOperation): Promise<void> => {
    for (const workspacePath of ctx.workspaces.values()) {
      assertPrepared(operation);
      await waitForKnowledgeUpdateCheck(workspacePath, { requestId: operation.requestId, timeoutMs, signal: operation.signal });
    }
  };
  /** 分页包含归档线程，托管进程不能因会话隐藏而漏查。 */
  const threadIds = (workspaceId: WorkspaceId): ThreadId[] => {
    const result = new Set<ThreadId>();
    const db = ctx.db.forWorkspace(workspaceId);
    let cursor: string | null = null;
    do {
      const page = db.threads.listByWorkspace(workspaceId, { includeArchived: true, limit: 2_000, cursor });
      for (const thread of page.threads) result.add(thread.id);
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && !cursor) throw new Error("DESKTOP_UPDATE_THREAD_CURSOR_MISSING");
    } while (cursor);
    return [...result];
  };
  /** 运行回合只从可信W读取；同turn主键跨库保留各自归属。 */
  const runningTurns = (): ThreadTurnRecord[] => [...ctx.workspaces.keys()].flatMap(workspaceId =>
    ctx.db.forWorkspace(workspaceId).turns.listRunning().map(turn => {
      if (turn.workspaceId !== workspaceId) throw Object.assign(new Error("更新回合的物理工作区不一致"), {
        code: "DESKTOP_UPDATE_TURN_SCOPE_MISMATCH", workspaceId, threadId: turn.threadId, turnId: turn.turnId,
      });
      return turn;
    }));
  /** 只把已启动且未终态流程计入会话，草稿沿原节点及启动事件事实区分。 */
  const unfinishedInstances = (): Array<{ workspaceId: WorkspaceId; instance: OrchestrationInstance }> => {
    const result: Array<{ workspaceId: WorkspaceId; instance: OrchestrationInstance }> = [];
    for (const workspaceId of ctx.workspaces.keys()) {
      const db = ctx.db.forWorkspace(workspaceId);
      for (const instance of db.orchInstances.listByWorkspace(workspaceId)) {
        if (["completed", "failed", "cancelled"].includes(instance.status)) continue;
        const nodes = Object.values(instance.nodeStates);
        if (instance.status === "running" || nodes.some(node => node.startedAt != null || Number(node.attemptNo ?? 0) > 0 || Boolean(node.attemptId || node.nodeExecutionId))
          || db.orchEvents.listByInstance(instance.id, { includePayload: false }).some(event => event.type === "orchestration.started" || event.type === "orchestration.resumed")) result.push({ workspaceId, instance });
      }
    }
    return result;
  };
  /** 合并平台和引擎的原服务快照，不按 child.killed 或空 PID 推断已经退出。 */
  const runningServices = () => [...ctx.workspaces.keys()].flatMap(workspaceId => {
    const engine = ctx.orchEngine.existingWorkspace(workspaceId);
    return engine ? threadIds(workspaceId).flatMap(threadId => engine.listManagedServicesForThread(threadId)
      .filter(service => service.status === "starting" || service.status === "ready").map(service => ({ engine, threadId, service }))) : [];
  });
  /** 任一真实活动均需要用户确认；准备阶段不等待整轮模型自然完成。 */
  const hasRunningSessions = async (operation: DesktopUpdateOperation): Promise<boolean> => await database(operation, () =>
    runningTurns().length > 0 || unfinishedInstances().length > 0 || hasOrdinaryTurnExecutions(ctx.sessions) || ctx.orchEngine.hasInFlightWork())
    || input.hasKnowledgeWork() || await input.hasAssetDraftWork() || ctx.controlledExperiments.hasInFlightWork()
    || await database(operation, () => [...ctx.workspaces.keys()].some(workspaceId => ctx.db.forWorkspace(workspaceId).controlledExperiments.listRunningForSessionGate().length > 0))
    || input.terminalManager.hasRunningTerminals() || await database(operation, () => runningServices().length > 0)
    || input.queueDispatcher.hasInFlightWork() || input.scheduledTaskScheduler.hasInFlightWork();
  return {
    /** 冻结后的事务安全点重新读取真实活动，空闲由壳静默切换。 */
    async prepare(operation = { requestId: input.requestId, signal: new AbortController().signal }) {
      assertPrepared(operation);
      preparedOrdinaryExecutions = [];
      await waitUntil(input.hasBlockingTransaction, operation);
      input.queueDispatcher.assertNoFailure();
      await waitKnowledgeChecks(operation);
      preparedOrdinaryExecutions = listOrdinaryTurnExecutions(ctx.sessions);
      const active = await hasRunningSessions(operation);
      assertPrepared(operation);
      return { hasRunningSessions: active };
    },
    /** 仅在用户已确认或真实空闲时调用；任何停止失败立即中止后续副作用。 */
    async interrupt(operation = { requestId: input.requestId, signal: new AbortController().signal }) {
      assertPrepared(operation);
      input.scheduledTaskScheduler.beginUpdateStop(operation.requestId);
      await waitUntil(input.hasBlockingTransaction, operation);
      input.queueDispatcher.assertNoFailure();
      const pendingOrdinaryExecutions = listOrdinaryTurnExecutions(ctx.sessions);
      const ordinaryExecutions = [...new Map([...preparedOrdinaryExecutions, ...pendingOrdinaryExecutions].map(scope =>
        [JSON.stringify([scope.workspaceId, scope.threadId, scope.turnId]), scope])).values()];
      for (const scope of pendingOrdinaryExecutions) {
        const turn = await database(operation, () => ctx.db.forWorkspace(scope.workspaceId).turns.get(scope.turnId));
        if (turn ? turn.workspaceId !== scope.workspaceId || turn.threadId !== scope.threadId
          : !cancelOrdinaryTurnBeforeDispatch(ctx.sessions, scope)) {
          throw Object.assign(new Error("普通回合缺少精确停止归属"), { code: "DESKTOP_UPDATE_TURN_NOT_SETTLED", requestId: operation.requestId, ...scope });
        }
      }
      await waitKnowledgeChecks(operation);
      await input.stopKnowledgeWork(operation);
      assertPrepared(operation);
      await input.stopAssetDraftWork(operation);
      assertPrepared(operation);
      await ctx.controlledExperiments.stopForUpdate({ requestId: operation.requestId, timeoutMs });
      assertPrepared(operation);
      const interruptedThreads = new Set<ThreadId>();
      for (const turn of await database(operation, runningTurns)) {
        assertPrepared(operation);
        await input.interruptTurn(turn, operation);
        interruptedThreads.add(turn.threadId);
      }
      for (const { workspaceId, instance } of await database(operation, unfinishedInstances)) {
        assertPrepared(operation);
        const engine = ctx.orchEngine.existingWorkspace(workspaceId);
        if (!engine) throw Object.assign(new Error("更新缺少工作区流程owner"), {
          code: "DESKTOP_UPDATE_ORCHESTRATION_OWNER_MISSING", requestId: operation.requestId, workspaceId, instanceId: instance.id,
        });
        await engine.cancelAndWait(instance.id, { requestId: operation.requestId });
      }
      assertPrepared(operation);
      for (const { engine, threadId, service } of await database(operation, runningServices)) {
        assertPrepared(operation);
        if (service.stopSupported === false || !await engine.stopManagedServiceForThread(threadId, service.serviceId)) throw Object.assign(
          new Error("托管服务未确认停止"), { code: "DESKTOP_UPDATE_SERVICE_STOP_FAILED", requestId: operation.requestId, threadId, serviceId: service.serviceId });
      }
      for (const threadId of interruptedThreads) { assertPrepared(operation); await ctx.sessions.disposeThread(threadId); }
      assertPrepared(operation);
      for (const scope of ordinaryExecutions) {
        await waitForOrdinaryTurnExecution(ctx.sessions, scope, { timeoutMs });
        assertPrepared(operation);
      }
      await ctx.orchEngine.waitForInFlightWork({ requestId: operation.requestId, timeoutMs });
      assertPrepared(operation);
      await input.scheduledTaskScheduler.stopForUpdate({ requestId: operation.requestId, timeoutMs });
      assertPrepared(operation);
      await input.terminalManager.stopAllForUpdate({ requestId: operation.requestId, timeoutMs });
      await waitUntil(async () => { input.queueDispatcher.assertNoFailure(); return await input.hasBlockingTransaction() || await hasRunningSessions(operation); }, operation);
    },
    /** 生命周期解除围栏后恢复队列与原后台调度，控制响应不等待网络同步。 */
    async resume(operation = { requestId: input.requestId, signal: new AbortController().signal }) {
      operation.signal.throwIfAborted();
      preparedOrdinaryExecutions = [];
      for (const workspaceId of ctx.workspaces.keys()) {
        if (ctx.isTaskAdmissionPaused?.()) return;
        await database(operation, () => {
          operation.signal.throwIfAborted();
          if (!ctx.isTaskAdmissionPaused?.()) input.queueDispatcher.resumeWorkspace(workspaceId);
        });
      }
      if (!ctx.isTaskAdmissionPaused?.()) input.scheduledTaskScheduler.resumeAfterUpdate(operation.requestId);
    },
  };
}
