import type { ItemId, ThreadId, TurnId, WorkspaceId } from "./ids";
import type { EngineType, TokenUsageSnapshot } from "./engine";
import type { TextFileAttachment } from "./attachments";
import type { WorkspacePathReference } from "./pathReferences";
import type { EngineCallTrace } from "./engineCall";
import type { SharedWorkspaceContextListItem } from "./sharedWorkspace";
import type { CodexSkillMentionBinding, ThreadInputKind } from "../inputActions";

export type ThreadGroupId = string;

export type ConversationItem =
  | ConversationMessage
  | ConversationSystemMessage
  | ConversationReasoning
  | ConversationTool
  | ConversationDiff
  | ConversationReview
  | ConversationExplore
  | ConversationApprovalRequest
  | ConversationUserInputRequest
  | ConversationSubagent
  | ConversationProcess;

/** 折叠过程的轻量入口；正文仅由过程详情接口返回。 */
export type ConversationProcess = {
  kind: "process";
  id: string;
  preview: string;
  itemCount: number;
  statusCounts: { done: number; running: number; warning: number; failed: number };
  version: number;
};

export type AssistantMessagePhase =
  | "commentary"
  | "final_answer"
  | "structured_result";

export type AssistantCompletionSource =
  | "provider"
  | "snapshot_reconcile"
  | "runtime_close_reconcile"
  | "synthetic_structured_result";

export type ConversationMessage = {
  kind: "message";
  id: ItemId;
  role: "user" | "assistant";
  /** 消息显示时间（来自 canonical 事件时间戳），用于聊天区展示。 */
  createdAt?: number;
  /** assistant 消息对应的引擎原生 messageId；user message 为空。 */
  engineMessageId?: string;
  /** 可选：所属 turnId（仅 user message 一定存在；用于“回滚到这里”等交互）。 */
  turnId?: TurnId;
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images?: string[];
  files?: TextFileAttachment[];
  pathReferences?: WorkspacePathReference[];
  /** 可选：引擎调用追踪（仅用于排障展示）。 */
  engineCall?: EngineCallTrace;
  /**
   * Web 渲染提示：assistant 流式阶段建议用 plain（避免频繁 Markdown 渲染导致卡顿/看起来像"一次性输出"）。
   * - `plain`：直接文本渲染（保留换行）
   * - `markdown`：Markdown 渲染（通常在 completed 后切换）
   */
  format?: "plain" | "markdown";
  /** assistant 消息的规范化版本号；snapshot/completed 必须单调递增。 */
  revision?: number;
  /** assistant 消息的流式状态。 */
  streamState?: "streaming" | "completed";
  /** assistant 消息的阶段语义。 */
  phase?: AssistantMessagePhase;
  /** assistant 完成态的来源。 */
  completionSource?: AssistantCompletionSource;
  /** 可选：规范化结构载荷（当前用于需求分析等宿主托管结构结果）。 */
  structuredPayloadJson?: string | null;
};

export type ConversationSystemMessage = {
  kind: "systemMessage";
  id: ItemId;
  /**
   * 系统消息类型：
   * - `info`：一般信息提示
   * - `warning`：警告（如中断、限流等）
   * - `error`：错误信息
   * - `success`：成功提示
   */
  type: "info" | "warning" | "error" | "success";
  text: string;
  /** 可选：来源 turnId，供前端回放和状态收口使用。 */
  turnId?: TurnId;
  /** 可选：来源错误码，供前端区分瞬时提示与真实阻断。 */
  code?: string;
  /** 可选：这类提示只在“当前没有后续活动”时展示，新回合开始后可自动收口。 */
  transient?: boolean;
  /** 编排文案的轻量格式参数，用于快照恢复时按当前节点名重新展示。 */
  orchestrationDisplay?: { type: string; payload: Record<string, unknown> };
};

export type ConversationReasoning = {
  kind: "reasoning";
  id: ItemId;
  summary?: string;
  content: string;
  /** 仅用于当前会话的临时占位，不应作为真实 reasoning 文本持久保留。 */
  placeholder?: boolean;
};

export type ConversationTool = {
  kind: "tool";
  id: ItemId;
  toolType: string;
  title: string;
  detail: string;
  /**
   * tool 渲染态：
   * - started: 已开始且仍在流式更新
   * - completed: 收到明确 completed 事件
   * - failed: 收到明确失败/错误终态
   * - incomplete: 轮次已结束，但工具缺少 completed 收尾事件
   * - unknown: 仅看到零散片段，暂未判断终态
   */
  status: "started" | "completed" | "failed" | "incomplete" | "unknown";
  output?: string;
  /** todolist 原文（例如 Codex 的 ThreadItem(type=plan).text），用于排障与回放展示。 */
  todolistText?: string;
  durationMs?: number | null;
  changes?: { path: string; kind?: string; diff?: string }[];
  /** 卡片折叠态摘要文字（由适配器填充：fileChange=文件名，commandExecution=命令，todolist=说明文字）。 */
  summary?: string;
  /** 任务列表结构化数据（仅 todolist 类工具，由适配器填充）。 */
  todolistItems?: { step: string; status: string }[];
  /** 是否为 todolist 类工具（由 reducer 根据 toolType 归一化后设置，供前端组件使用）。 */
  isTodolist?: boolean;
};

export type ConversationDiff = {
  kind: "diff";
  id: ItemId;
  title: string;
  diff: string;
  status?: string;
};

export type ConversationReview = {
  kind: "review";
  id: ItemId;
  state: "started" | "completed";
  text: string;
};

export type ConversationExplore = {
  kind: "explore";
  id: ItemId;
  status: "exploring" | "explored";
  entries: { kind: "read" | "search" | "list" | "run"; label: string; detail?: string }[];
};

export type ConversationApprovalRequest = {
  kind: "approvalRequest";
  id: ItemId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  requestId: number | string;
  toolName: string;
  message?: string;
  input?: unknown;
  approvalKind?: "generic" | "enterPlanMode" | "exitPlanMode";
  options?: Array<{
    value: string;
    label: string;
    description?: string;
    intent: "accept" | "decline";
    requiresNote?: boolean;
    notePlaceholder?: string;
  }>;
  state: "pending" | "accepted" | "declined" | "expired";
  resolvedChoice?: string;
  resolvedNote?: string;
};

export type ConversationUserInputRequest = {
  /** 异步提问不随来源回合结束失效。 */
  delivery?: "async";
  kind: "userInputRequest";
  id: ItemId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  requestId: number | string;
  header: string;
  prompt: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther?: boolean;
    options?: Array<{ label: string; description: string }>;
    /** true = 多选（checkbox），false/undefined = 单选（radio）。 */
    multiSelect?: boolean;
  }>;
  state: "pending" | "submitted" | "expired";
  /** 提交后回填的答案（由 reducer 在 userInput.resolved 时写入，用于历史展示）。 */
  submittedAnswers?: Record<string, { answers: string[] }>;
};

export type ConversationSubagent = {
  kind: "subagent";
  id: ItemId;
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  lastToolName?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  /** subagent 内部执行过程（复用 ConversationItem 渲染）。 */
  children?: ConversationItem[];
};

export type ThreadType = "chat" | "orchestration";
export type ThreadSubtype = "master" | "node" | "asset-draft" | "knowledge-assets" | "knowledge-review" | "knowledge-conversation" | "requirement-analysis" | "node-discussion" | "gate-evaluation";
export type ThreadListScope = "all" | "current" | "archived" | "orchestration" | "knowledge";
export type ThreadListSort =
  | "activity_desc"
  | "activity_asc"
  | "created_desc"
  | "created_asc"
  | "title_asc"
  | "title_desc";
export type ThreadEntryVisibility = {
  routeDeepLink: boolean;
  threadList: boolean;
  embeddedDetail: boolean;
  internalRestore: boolean;
};
export type ThreadEntrySource = keyof ThreadEntryVisibility;
export type ThreadGroupSummary = {
  id: ThreadGroupId;
  workspaceId: WorkspaceId;
  sharedWorkspaceId: string | null;
  name: string;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 当前操作者是否能维护该分组；本地工作区恒为 true。 */
  canManage?: boolean;
};

export type ThreadSummary = {
  id: ThreadId;
  /** 会话名称（用户可编辑）。 */
  title: string;
  /** 会话来源类型：普通聊天 or 编排派生。 */
  threadType: ThreadType;
  /** 会话细分类：对编排线程或特定扩展聊天线程有效。 */
  threadSubtype: ThreadSubtype | null;
  /** 是否归档（归档后默认不展示，可手动切换显示）。 */
  archived: boolean;
  /** 置顶时间；为空表示未置顶。 */
  pinnedAt?: number | null;
  /** 自建会话所属分组；为空表示未分组。 */
  groupId?: ThreadGroupId | null;
  createdAt: number;
  updatedAt: number;
  /** thread 创建时选择的引擎；创建后不可变。 */
  engine: EngineType;
  /** 共享工作区上下文；存在时用于区分本人相关记录和只读团队记录。 */
  sharedContext?: SharedWorkspaceContextListItem | null;
  /** 共享工作区只读标记；true 表示当前账号只能查看，不能输入或维护该记录。 */
  readOnly?: boolean;
};

const DEFAULT_THREAD_ENTRY_VISIBILITY: ThreadEntryVisibility = {
  routeDeepLink: true,
  threadList: true,
  embeddedDetail: true,
  internalRestore: true,
};

const HIDDEN_MASTER_THREAD_ENTRY_VISIBILITY: ThreadEntryVisibility = {
  routeDeepLink: false,
  threadList: false,
  embeddedDetail: false,
  internalRestore: true,
};

const HIDDEN_ASSET_DRAFT_THREAD_ENTRY_VISIBILITY: ThreadEntryVisibility = {
  routeDeepLink: false,
  threadList: false,
  embeddedDetail: false,
  internalRestore: true,
};

const KNOWLEDGE_EXECUTION_THREAD_ENTRY_VISIBILITY: ThreadEntryVisibility = {
  // 文件工作会话支持主会话直开，知识写入仍由绑定工具控制。
  routeDeepLink: true,
  threadList: true,
  embeddedDetail: true,
  internalRestore: true,
};

const HIDDEN_GATE_EVALUATION_THREAD_ENTRY_VISIBILITY: ThreadEntryVisibility = {
  routeDeepLink: false,
  threadList: false,
  embeddedDetail: false,
  internalRestore: true,
};

/** 内部复检仅在所属文件会话展开，禁止作为独立会话进入列表。 */
export function getThreadEntryVisibility(
  thread: Pick<ThreadSummary, "threadType" | "threadSubtype"> | { threadType: ThreadType; threadSubtype: ThreadSubtype | null },
): ThreadEntryVisibility {
  const subtype = thread.threadSubtype ?? null;
  if (subtype === "knowledge-conversation") {
    return { routeDeepLink: true, threadList: true, embeddedDetail: true, internalRestore: true };
  }
  if (thread.threadType === "orchestration" && subtype === "master") {
    return { ...HIDDEN_MASTER_THREAD_ENTRY_VISIBILITY };
  }
  if (subtype === "master") {
    return { ...HIDDEN_MASTER_THREAD_ENTRY_VISIBILITY };
  }
  if (subtype === "knowledge-assets") {
    return { ...KNOWLEDGE_EXECUTION_THREAD_ENTRY_VISIBILITY };
  }
  if (subtype === "asset-draft") {
    return { ...HIDDEN_ASSET_DRAFT_THREAD_ENTRY_VISIBILITY };
  }
  if (subtype === "gate-evaluation" || subtype === "knowledge-review") {
    return { ...HIDDEN_GATE_EVALUATION_THREAD_ENTRY_VISIBILITY };
  }
  return { ...DEFAULT_THREAD_ENTRY_VISIBILITY };
}

export function canAccessThreadFrom(
  thread: Pick<ThreadSummary, "threadType" | "threadSubtype"> | { threadType: ThreadType; threadSubtype: ThreadSubtype | null },
  source: ThreadEntrySource,
): boolean {
  return getThreadEntryVisibility(thread)[source];
}

export function normalizeThreadListScope(raw: unknown, fallback: ThreadListScope = "all"): ThreadListScope {
  const value = String(raw ?? "").trim();
  if (value === "all" || value === "current" || value === "archived" || value === "orchestration" || value === "knowledge") {
    return value;
  }
  return fallback;
}

/** 归一化会话列表排序；默认按最近活动倒序。 */
export function normalizeThreadListSort(raw: unknown, fallback: ThreadListSort = "activity_desc"): ThreadListSort {
  const value = String(raw ?? "").trim();
  if (
    value === "activity_desc"
    || value === "activity_asc"
    || value === "created_desc"
    || value === "created_asc"
    || value === "title_asc"
    || value === "title_desc"
  ) {
    return value;
  }
  return fallback;
}

export function isOrchestrationScopedThread(
  thread: Pick<ThreadSummary, "threadType" | "threadSubtype"> | { threadType: ThreadType; threadSubtype: ThreadSubtype | null },
): boolean {
  return thread.threadType === "orchestration"
    || thread.threadSubtype === "requirement-analysis"
    || thread.threadSubtype === "node-discussion"
    || thread.threadSubtype === "gate-evaluation";
}

export function matchesThreadListScope(
  thread: Pick<ThreadSummary, "threadType" | "threadSubtype" | "archived"> | { threadType: ThreadType; threadSubtype: ThreadSubtype | null; archived: boolean },
  scope: ThreadListScope,
): boolean {
  if (scope === "all") return true;
  if (scope === "archived") return Boolean(thread.archived);
  if (scope === "orchestration") return isOrchestrationScopedThread(thread);
  if (scope === "knowledge") return !thread.archived && (thread.threadSubtype === "knowledge-conversation" || thread.threadSubtype === "knowledge-assets");
  return !thread.archived && !isOrchestrationScopedThread(thread) && thread.threadSubtype !== "knowledge-conversation";
}

export type ThreadTokenUsageState = {
  threadId: ThreadId;
  tokenUsage: TokenUsageSnapshot | null;
};
