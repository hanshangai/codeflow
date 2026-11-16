import {
  CHAT_WORKFLOW_ACTIVE_STATUS_LIST,
  CHAT_WORKFLOW_ACTIVE_STATUSES,
  type ChatWorkflowActiveStatus,
  type ThreadId,
  type ThreadRunningState,
  type ThreadWorkflowState,
  type TurnId,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ActiveChatWorkflowRow } from "../db/repos/threadRepo.js";
import type { ApiHandlerContext } from "./handleApiRequest.js";

type ActiveThreadTurn = { turnId: TurnId; startedAt?: number | null; source?: "runtime" | "db"; phase?: ThreadRunningState["phase"] };
type RunningStateContext = Pick<ApiHandlerContext, "db" | "getActiveThreadTurn"> & Partial<Pick<ApiHandlerContext, "sessions">> & {
  getTurnFinalizationFailure?: (input: { workspaceId: WorkspaceId; threadId: ThreadId }) => { turnId: TurnId; errorCode: string } | null;
};

export type TurnErrorIndexScope =
  | { kind: "turn"; turnId: TurnId }
  | { kind: "unscoped" };

/** 识别 turn.error 的精确 turn scope；协议允许缺 ID，此时调用方只能保留证据并跳过 turn 级变更。 */
export function resolveTurnErrorIndexScope(turnId: unknown): TurnErrorIndexScope {
  const normalizedTurnId = String(turnId ?? "").trim();
  return normalizedTurnId
    ? { kind: "turn", turnId: normalizedTurnId as TurnId }
    : { kind: "unscoped" };
}

/** 仅在终态属于当前 active turn 时清理运行态，避免迟到 ACK 误删 successor。 */
export function clearActiveThreadTurnIfMatches(
  activeTurnByThreadId: Pick<Map<ThreadId, ActiveThreadTurn>, "get" | "delete">,
  threadId: ThreadId,
  terminalTurnId: TurnId,
): boolean {
  const active = activeTurnByThreadId.get(threadId);
  if (!active || String(active.turnId) !== String(terminalTurnId)) return false;
  return activeTurnByThreadId.delete(threadId);
}

/** 规范化 running startedAt；非法时间返回 null 以便调用方选择 fallback。 */
function normalizeStartedAt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 转换任意 running 记录为前端可消费的 ThreadRunningState。 */
function normalizeRunningState(running: ThreadRunningState | null | undefined): ThreadRunningState | null {
  const turnId = String(running?.runningTurnId ?? "").trim();
  const startedAt = normalizeStartedAt(running?.runningTurnStartedAt);
  if (!turnId || startedAt == null) return null;
  return {
    runningTurnId: turnId as TurnId,
    runningTurnStartedAt: startedAt,
    ...(running?.phase ? { phase: running.phase } : {}),
    ...(running?.runningSource ? { runningSource: running.runningSource } : {}),
    ...(running?.failureCode ? { failureCode: running.failureCode } : {}),
  };
}

/** 统一 DB running 与 runtime active，避免 API 阻断和前端终止按钮使用不同状态源。 */
export function resolveThreadRunningState(
  ctx: RunningStateContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    runningByThreadId?: Record<string, ThreadRunningState> | null;
  },
): ThreadRunningState | null {
  const key = String(input.threadId);
  const preloadedDbRunning = input.runningByThreadId
    ? normalizeRunningState(input.runningByThreadId[key] ?? null)
    : null;
  const active = ctx.getActiveThreadTurn?.({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    includeDb: !input.runningByThreadId,
  }) as ActiveThreadTurn | null | undefined;
  const activeTurnId = String(active?.turnId ?? "").trim();
  const finalizationFailure = ctx.getTurnFinalizationFailure?.({ workspaceId: input.workspaceId, threadId: input.threadId });
  if (finalizationFailure && (!activeTurnId || activeTurnId === finalizationFailure.turnId)) return {
    runningTurnId: finalizationFailure.turnId, runningTurnStartedAt: normalizeStartedAt(active?.startedAt) ?? preloadedDbRunning?.runningTurnStartedAt ?? Date.now(),
    runningSource: "runtime", phase: "failed", failureCode: finalizationFailure.errorCode,
  };
  if (!activeTurnId) {
    if (input.runningByThreadId) return preloadedDbRunning;
    const runningByThreadId = ctx.db.turns.listRunningByWorkspace(input.workspaceId);
    return normalizeRunningState(runningByThreadId[key] ?? null);
  }

  const activeStartedAt = normalizeStartedAt(active?.startedAt);
  const dbRunning = activeStartedAt == null
    ? preloadedDbRunning ?? normalizeRunningState(ctx.db.turns.listRunningByWorkspace(input.workspaceId)[key] ?? null)
    : preloadedDbRunning;
  const dbStartedAt = dbRunning && String(dbRunning.runningTurnId) === activeTurnId ? dbRunning.runningTurnStartedAt : null;
  const failureCode = ctx.sessions?.getTurnFailure?.(input.threadId, activeTurnId as TurnId);
  const phase = failureCode ? "failed" : active?.phase ?? ctx.sessions?.getTurnPhase?.(input.threadId, activeTurnId as TurnId);
  return {
    runningTurnId: activeTurnId as TurnId,
    runningTurnStartedAt: activeStartedAt ?? dbStartedAt ?? Date.now(),
    ...(active?.source === "runtime" ? { runningSource: "runtime" as const } : {}),
    ...(phase ? { phase } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
}

/** 批量解析可见 threads 的 running 状态；仅返回有 turnId 的项。 */
export function resolveThreadRunningStateMap(
  ctx: RunningStateContext,
  input: { workspaceId: WorkspaceId; threads: Array<{ id: ThreadId }> },
): Record<string, ThreadRunningState> {
  const runningByThreadId = ctx.db.turns.listRunningByWorkspace(input.workspaceId);
  const out: Record<string, ThreadRunningState> = {};
  for (const thread of input.threads) {
    const running = resolveThreadRunningState(ctx, {
      workspaceId: input.workspaceId,
      threadId: thread.id,
      runningByThreadId,
    });
    if (running) out[String(thread.id)] = running;
  }
  return out;
}

/** 收敛原始实例状态为活跃档位；非白名单返回 null。 */
function normalizeActiveChatWorkflowStatus(value: string | null): ChatWorkflowActiveStatus | null {
  const status = String(value ?? "").trim() as ChatWorkflowActiveStatus;
  return CHAT_WORKFLOW_ACTIVE_STATUSES.has(status) ? status : null;
}

/**
 * 解析单行的活跃档位：实例状态优先；实例尚未创建但任务在启动中时视为排队（pending）。
 * task_state 为 linked 而实例状态非活跃（终态或脏数据）时判为不活跃。
 */
function resolveActiveChatWorkflowStatus(row: ActiveChatWorkflowRow): ChatWorkflowActiveStatus | null {
  const instanceStatus = normalizeActiveChatWorkflowStatus(row.instanceStatus);
  if (instanceStatus) return instanceStatus;
  return row.taskState === "starting" ? "pending" : null;
}

/** 优先级取最高的候选：枚举声明顺序越靠前越高，同级按 created_at DESC、taskId DESC 保证多次请求结果一致。 */
function isPreferredActiveChatWorkflow(
  next: { status: ChatWorkflowActiveStatus; row: ActiveChatWorkflowRow },
  current: { status: ChatWorkflowActiveStatus; row: ActiveChatWorkflowRow },
): boolean {
  const nextRank = CHAT_WORKFLOW_ACTIVE_STATUS_LIST.indexOf(next.status);
  const currentRank = CHAT_WORKFLOW_ACTIVE_STATUS_LIST.indexOf(current.status);
  if (nextRank !== currentRank) return nextRank < currentRank;
  if (next.row.createdAt !== current.row.createdAt) return next.row.createdAt > current.row.createdAt;
  return next.row.taskId > current.row.taskId;
}

/**
 * 批量解析可见 threads 的会话工作流活跃态；只返回活跃项。
 * 必须只按入参 threads 过滤：按 workspace 全量扫描会泄露订阅者无权查看的会话存在性。
 */
export function resolveThreadWorkflowStateMap(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { workspaceId: WorkspaceId; threads: Array<{ id: ThreadId }> },
): Record<string, ThreadWorkflowState> {
  if (!input.threads.length) return {};
  const rows = ctx.db.threads.listActiveChatWorkflows(input.workspaceId, input.threads.map((thread) => thread.id));
  const preferred = new Map<string, { status: ChatWorkflowActiveStatus; row: ActiveChatWorkflowRow }>();
  for (const row of rows) {
    const status = resolveActiveChatWorkflowStatus(row);
    if (!status) continue;
    const candidate = { status, row };
    const current = preferred.get(row.threadId);
    if (!current || isPreferredActiveChatWorkflow(candidate, current)) preferred.set(row.threadId, candidate);
  }
  const out: Record<string, ThreadWorkflowState> = {};
  for (const [threadId, item] of preferred) {
    out[threadId] = { status: item.status, instanceId: item.row.instanceId, taskId: item.row.taskId };
  }
  return out;
}
