import type {
  NodeHumanActionSource,
  OrchestrationId,
  OrchestrationStatus,
  ThreadId,
  WorkspaceId,
} from "@codeflowai/shared";

type NodeQueuePolicyContext = {
  db: {
    threads: {
      get(threadId: ThreadId): { workspaceId: WorkspaceId } | null;
    };
    orchInstances: {
      listByWorkspace(workspaceId: WorkspaceId): Array<{
        id: OrchestrationId;
        status: OrchestrationStatus;
        nodeStates?: Record<string, Record<string, unknown>> | null;
        createdAt: number;
        updatedAt: number;
      }>;
    };
  };
};

export type OrchestrationNodeQueueMode =
  | "pending_feedback"
  | "active_supplement"
  | "feedback_resume"
  | "unsupported";

export type OrchestrationNodeQueueBinding = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  instanceStatus?: OrchestrationStatus;
  nodeId: string;
  status: string;
  humanActionSource: NodeHumanActionSource | null;
};

const TERMINAL_INSTANCE_STATUSES = new Set<OrchestrationStatus>(["completed", "failed", "cancelled"]);
const FEEDBACK_RESUME_SOURCES = new Set<NodeHumanActionSource>(["execution", "human_input", "review", "gate"]);

/** 解析 node thread 当前绑定的编排节点；未绑定时不得按普通队列消费。 */
export function resolveOrchestrationNodeQueueBinding(
  ctx: NodeQueuePolicyContext,
  threadId: ThreadId,
  predicate?: (binding: OrchestrationNodeQueueBinding) => boolean,
): OrchestrationNodeQueueBinding | null {
  const persistedThread = ctx.db.threads.get(threadId);
  if (!persistedThread) return null;

  const instances = [...ctx.db.orchInstances.listByWorkspace(persistedThread.workspaceId)]
    .filter((instance) => !TERMINAL_INSTANCE_STATUSES.has(instance.status))
    .sort((left, right) => (
      Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
      || Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0)
      || String(right.id).localeCompare(String(left.id))
    ));

  for (const instance of instances) {
    for (const [nodeId, rawState] of Object.entries(instance.nodeStates ?? {})) {
      if (String(rawState?.threadId ?? "").trim() !== String(threadId)) continue;
      const status = String(rawState?.status ?? "").trim();
      if (!isBindableNodeStatus(status)) continue;
      const binding: OrchestrationNodeQueueBinding = {
        workspaceId: persistedThread.workspaceId,
        instanceId: instance.id,
        instanceStatus: instance.status,
        nodeId,
        status,
        humanActionSource: normalizeHumanActionSource(rawState?.humanActionSource),
      };
      if (predicate && !predicate(binding)) continue;
      return binding;
    }
  }

  return null;
}

/** 将节点状态映射为安全的队列消费模式，确保输入仍是“继续当前节点”。 */
export function resolveOrchestrationNodeQueueMode(
  binding: OrchestrationNodeQueueBinding | null,
): OrchestrationNodeQueueMode {
  if (!binding) return "unsupported";
  if (binding.status === "waiting-feedback"
    && binding.humanActionSource
    && FEEDBACK_RESUME_SOURCES.has(binding.humanActionSource)) {
    return "feedback_resume";
  }
  if (isPendingFeedbackStatus(binding.status)) {
    return "pending_feedback";
  }
  if (isActiveSupplementStatus(binding.status)) {
    return "active_supplement";
  }
  return "unsupported";
}

/** 生成人可读拒绝原因；只描述当前节点为什么不能安全补充入队。 */
export function buildUnsupportedOrchestrationNodeQueueMessage(
  binding: OrchestrationNodeQueueBinding | null,
): string {
  if (!binding) return "当前节点已不再接收输入；如需继续修改，请回到流程详情从对应节点发起重跑。";
  if (binding.status === "waiting-approval" || binding.humanActionSource === "approval") {
    return "当前节点需要明确审批，不能用自由文本代替。";
  }
  if (binding.status === "waiting-start") {
    return "当前节点需要明确启动或跳过，不能用自由文本代替。";
  }
  if (binding.humanActionSource === "branch_decision") {
    return "当前节点需要明确选择分支，不能用自由文本代替。";
  }
  if (isResultClosingStatus(binding.status)) {
    return "当前节点正在完成结果处理，请稍后再试。";
  }
  return "当前节点暂时无法接收自由文本，请按页面提示完成当前操作。";
}

/** 尚未进入 provider turn 的节点先冻结补充输入，再由编排恢复执行。 */
function isPendingFeedbackStatus(status: string): boolean {
  return status === "pending" || status === "ready" || status === "queued";
}

/** 只有 provider turn 仍运行时才允许原地追加补充输入。 */
function isActiveSupplementStatus(status: string): boolean {
  return status === "running";
}

/** provider turn 已结束的结果收口阶段只保留绑定，用于返回可理解的稍后重试提示。 */
function isResultClosingStatus(status: string): boolean {
  return status === "result-submitted"
    || status === "finalizing"
    || status === "artifact-writing"
    || status === "gate-checking";
}

/** 终态节点只用于历史回看，不能抢占同一 thread 的当前执行绑定。 */
function isBindableNodeStatus(status: string): boolean {
  return isPendingFeedbackStatus(status)
    || isActiveSupplementStatus(status)
    || isResultClosingStatus(status)
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

/** 只接受共享协议声明的人工动作来源；未知旧值保持 unsupported，避免猜测决策。 */
function normalizeHumanActionSource(value: unknown): NodeHumanActionSource | null {
  const source = String(value ?? "").trim();
  if (source === "approval"
    || source === "gate"
    || source === "execution"
    || source === "review"
    || source === "human_input"
    || source === "branch_decision") {
    return source;
  }
  return null;
}
