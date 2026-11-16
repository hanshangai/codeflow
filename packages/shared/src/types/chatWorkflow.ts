import type { FeedbackAction, NodeExecutionStatus, OrchestrationStatus, WorkflowNodeType, WorkflowRuntimeDefinition } from "./orchestration.js";

/** 会话入口的用户决定与编排运行事实分开保存。 */
export type ChatWorkflowTask = {
  id: string;
  workspaceId: string;
  threadId: string;
  sourceTurnId: string;
  initiatorUserId: string;
  version: number;
  state: "recommended" | "dismissed" | "starting" | "linked" | "superseded";
  title: string;
  goal: string;
  context: string;
  acceptanceCriteria: string[];
  rationale: string;
  workflow: WorkflowRuntimeDefinition;
  assetHash: string;
  proposalId: string | null;
  intakeId: string | null;
  instanceId: string | null;
  /** 用户选择会话处理后持久化的续跑项；旧推荐可能没有此字段。 */
  continuationQueueItemId?: string;
  acceptedResultVersion: string | null;
  acceptedBy: string | null;
  acceptedAt: number | null;
  rework: { nodeId: string; reason: string; affectedNodeIds: string[]; resultVersion: string } | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatWorkflowTodo = {
  nodeId: string;
  label: string;
  version: string;
  status: string;
  summary: string;
  question: string;
  actions: Array<{ action: FeedbackAction | "start_node"; label: string; effect: string }>;
  branches: Array<{ nodeId: string; label: string }>;
};

export type ChatWorkflowView = {
  task: ChatWorkflowTask;
  continuation?: { queueItemId: string; status: "pending" | "sending" | "sent" | "failed" | "cancelled"; paused: boolean; failureReason: string | null };
  status: OrchestrationStatus | null;
  resultVersion: string | null;
  /**
   * activeMs 为已闭合的执行区间之和；activeSinceAt 为仍未闭合区间的起点，由前端按本机时钟秒级递增。
   * stages 已按 DAG 依赖排序；parallelBranchIndex 标出节点属于哪条并行分支，
   * isBranchStart 标出该分支在展示顺序中的首个节点，供卡片画 ∥ 与分支序号。
   */
  stages: Array<{ nodeId: string; nodeType: WorkflowNodeType; label: string; status: NodeExecutionStatus; error: string | null;
    activeMs?: number; activeSinceAt?: number | null;
    parallelBranchIndex?: number | null; isBranchStart?: boolean }>;
  todos: ChatWorkflowTodo[];
  artifacts: Array<{ id: string; title: string; nodeId: string; version: number; summary: string }>;
  checks: Array<{ nodeId: string; criterion: string; passed: boolean; message: string }>;
  canAccept: boolean;
  accepted: boolean;
  updates: Array<{ id: string; createdAt: number; text: string }>;
  acceptance: Array<{ text: string; status: "passed" | "failed" | "unverified"; evidence: string }>;
};

export type ChatWorkflowSnapshot = {
  recommendationEnabled: boolean;
  tasks: ChatWorkflowView[];
};

export type ChatWorkflowAction = "start" | "dismiss" | "pause" | "resume" | "cancel" | "feedback" | "accept" | "confirm_rework";
export type ChatWorkflowActionInput = {
  workspaceId: string;
  threadId: string;
  taskId: string;
  requestId: string;
  action: ChatWorkflowAction;
  expectedVersion: number;
  resultVersion?: string;
  nodeId?: string;
  nodeVersion?: string;
  feedbackAction?: FeedbackAction | "start_node";
  feedback?: string;
  targetNodeId?: string;
};

/** 活跃态的唯一定义处：SQL 白名单与前端徽标判据都由它派生，避免口径漂移。数组顺序即多活跃工作流合并时的优先级（越靠前越高）。 */
export const CHAT_WORKFLOW_ACTIVE_STATUS_LIST = [
  "pending", "running", "paused", "waiting-start", "waiting-approval", "waiting-feedback",
] as const;
export type ChatWorkflowActiveStatus = (typeof CHAT_WORKFLOW_ACTIVE_STATUS_LIST)[number];
export const CHAT_WORKFLOW_ACTIVE_STATUSES = new Set<string>(CHAT_WORKFLOW_ACTIVE_STATUS_LIST);

/** 批准类词汇；长词在前，「同意方案：」剥离时才能吃到整词。刻意不含「可以/继续」——它们带冒号也可能是聊天句。 */
const CHAT_WORKFLOW_APPROVAL_WORD_SOURCE = "同意方案|审核通过|通过审核|同意";
/** 前缀式批准：冒号后为随本次审批下传的意见。 */
export const CHAT_WORKFLOW_APPROVAL_PREFIX_PATTERN = new RegExp(`^(?:${CHAT_WORKFLOW_APPROVAL_WORD_SOURCE})[：:]`, "u");
/** 显式前缀意图（补充：/选择分支：/前缀式批准）：写了前缀就是给工作流的指令，服务端未处理时必须显式失败。 */
export const CHAT_WORKFLOW_EXPLICIT_PREFIX_PATTERN = new RegExp(`^(?:补充[：:]|选择分支[：:]|(?:${CHAT_WORKFLOW_APPROVAL_WORD_SOURCE})[：:])`, "u");
/** 裸关键词预筛：只给前端决定「要不要先问一次 /natural」，权威仍是下面的解析器。 */
export const CHAT_WORKFLOW_BARE_INTENT_PATTERN = /^(?:确认使用并启动|确认启动工作流|使用这个工作流|启动工作流|本次不用工作流|本次直接在会话处理|暂停|暂停工作流|暂停这个流程|终止工作流|终止这个流程|取消工作流|恢复工作流|恢复这个流程|验收通过|确认验收通过|确认返工|按这个方案返工|同意|同意方案|审核通过|通过审核|可以|继续)$/u;

/** 仅在当前只有一个可补充待办时，把会话框文字提交给该待办；多待办仍要求明确指向。 */
export function resolveChatWorkflowNaturalAction(
  text: string,
  snapshot: ChatWorkflowSnapshot,
): Omit<ChatWorkflowActionInput, "workspaceId" | "threadId" | "requestId"> | null {
  const normalized = text.trim().replace(/[。！!]+$/u, "");
  const recommended = snapshot.tasks.filter(v => v.task.state === "recommended");
  const active = snapshot.tasks.filter(v => v.status && CHAT_WORKFLOW_ACTIVE_STATUSES.has(v.status));
  let view: ChatWorkflowView | undefined;
  let action: ChatWorkflowAction | undefined;
  if (/^(确认使用并启动|确认启动工作流|使用这个工作流|启动工作流)$/u.test(normalized) && recommended.length === 1) {
    view = recommended[0]; action = "start";
  } else if (/^(本次不用工作流|本次直接在会话处理)$/u.test(normalized) && recommended.length === 1) {
    view = recommended[0]; action = "dismiss";
  } else if (/^(暂停|暂停工作流|暂停这个流程)$/u.test(normalized) && active.length === 1) {
    view = active[0]; action = "pause";
  } else if (/^(终止工作流|终止这个流程|取消工作流)$/u.test(normalized) && active.length === 1) {
    view = active[0]; action = "cancel";
  } else if (/^(恢复工作流|恢复这个流程)$/u.test(normalized) && active.length === 1 && active[0]?.status === "paused") {
    view = active[0]; action = "resume";
  } else if (/^(验收通过|确认验收通过)$/u.test(normalized)) {
    const pending = snapshot.tasks.filter(v => v.status === "completed" && !v.accepted && v.canAccept);
    if (pending.length === 1) { view = pending[0]; action = "accept"; }
  } else if (/^(确认返工|按这个方案返工)$/u.test(normalized)) {
    const pending = snapshot.tasks.filter(v => v.task.rework);
    if (pending.length === 1) { view = pending[0]; action = "confirm_rework"; }
  } else if (/^(同意|同意方案|审核通过|通过审核|可以|继续)$/u.test(normalized) && recommended.length === 0 && !snapshot.tasks.some(v => v.task.rework || (v.status === "completed" && !v.accepted))) {
    const pending = active.flatMap(v => v.todos.map(todo => ({ view: v, todo })));
    if (pending.length === 1 && pending[0]?.todo.actions.some(a => a.action === "approve")) {
      const { view: selected, todo } = pending[0];
      return { taskId: selected.task.id, expectedVersion: selected.task.version, action: "feedback", nodeId: todo.nodeId, nodeVersion: todo.version, feedbackAction: "approve" };
    }
  } else if (CHAT_WORKFLOW_APPROVAL_PREFIX_PATTERN.test(normalized)
    // 唯一真实可达的歧义：已完成待验收与节点审批的文案区分（H3）。recommended/rework 在「已存在唯一 approve 待办」时不可达，保留只会让显式前缀多出无法自查的失败来源。
    && !snapshot.tasks.some(v => v.status === "completed" && !v.accepted)) {
    const pending = active.flatMap(v => v.todos.filter(t => t.actions.some(a => a.action === "approve")).map(todo => ({ view: v, todo })));
    if (pending.length === 1) {
      const { view: selected, todo } = pending[0]!;
      const note = normalized.replace(CHAT_WORKFLOW_APPROVAL_PREFIX_PATTERN, "").trim();
      return { taskId: selected.task.id, expectedVersion: selected.task.version, action: "feedback", nodeId: todo.nodeId, nodeVersion: todo.version, feedbackAction: "approve", ...(note ? { feedback: note } : {}) };
    }
  } else if (/^补充[：:]/u.test(normalized)) {
    const pending = active.flatMap(v => v.todos.filter(t => t.actions.some(a => a.action === "resume_with_input")).map(todo => ({ view: v, todo })));
    if (pending.length === 1 && normalized.replace(/^补充[：:]/u, "").trim()) {
      const selected = pending[0]!;
      return { taskId: selected.view.task.id, expectedVersion: selected.view.task.version, action: "feedback", nodeId: selected.todo.nodeId, nodeVersion: selected.todo.version, feedbackAction: "resume_with_input", feedback: normalized.replace(/^补充[：:]/u, "").trim() };
    }
  } else if (/^选择分支[：:]/u.test(normalized)) {
    const selectedLabel = normalized.replace(/^选择分支[：:]/u, "").trim();
    const pending = active.flatMap(v => v.todos.filter(t => t.actions.some(a => a.action === "choose_branch")).flatMap(todo => todo.branches.filter(b => b.label === selectedLabel || b.nodeId === selectedLabel).map(branch => ({ view: v, todo, branch }))));
    if (pending.length === 1) {
      const selected = pending[0]!;
      return { taskId: selected.view.task.id, expectedVersion: selected.view.task.version, action: "feedback", nodeId: selected.todo.nodeId, nodeVersion: selected.todo.version, feedbackAction: "choose_branch", targetNodeId: selected.branch.nodeId };
    }
  } else {
    const pending = active.flatMap(v => v.todos.filter(t => t.actions.some(a => a.action === "resume_with_input")).map(todo => ({ view: v, todo })));
    if (pending.length === 1 && normalized) {
      const selected = pending[0]!;
      return { taskId: selected.view.task.id, expectedVersion: selected.view.task.version, action: "feedback", nodeId: selected.todo.nodeId, nodeVersion: selected.todo.version, feedbackAction: "resume_with_input", feedback: text.trim() };
    }
  }
  return view && action ? { taskId: view.task.id, expectedVersion: view.task.version, action, resultVersion: view.resultVersion ?? undefined } : null;
}
