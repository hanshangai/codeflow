import type { ToolPresentation } from "../tool-presentation.js";

export type ClaudeBackgroundShellTaskMeta = {
  taskId: string;
  toolUseId?: string;
  description: string;
  command: string;
  startedAt: number;
};

export type ClaudeTaskTodoItem = {
  id: string;
  step: string;
  status: string;
  description?: string;
  activeForm?: string;
  order: number;
};

export type PendingClaudeTaskTodoItem = Omit<ClaudeTaskTodoItem, "id">;

export type ToolState = {
  toolNameById: Map<string, string>;
  toolIdByIndex: Map<number, string>;
  toolInputById: Map<string, string>;
  /** todolist 类工具（todowrite）的解析结果，在 input 完整时填入，在 tool_result 时取出。 */
  toolTodolistItemsById: Map<string, { step: string; status: string }[]>;
  /** Claude TaskCreate/TaskUpdate 工具族生成的任务快照，用于兼容新版 Claude todolist。 */
  claudeTaskTodoById: Map<string, ClaudeTaskTodoItem>;
  /** TaskCreate tool_result 返回 taskId 前的临时任务信息。 */
  pendingClaudeTaskTodoByToolUseId: Map<string, PendingClaudeTaskTodoItem>;
  /** Claude TaskCreate 的稳定排序计数器。 */
  claudeTaskTodoOrder: number;
  /** 工具展示信息（summary/changes），由适配器统一派生，供 tool_result 补齐。 */
  toolPresentationById: Map<string, ToolPresentation>;
  /** AskUserQuestion：requestId → tool_use_id 映射（用于将用户回答写回 stdin tool_result）。 */
  pendingUserInputByRequestId: Map<string, string>;
  /** 权限审批：requestId → tool_use_id 映射（用于将审批结果写回 stdin，--permission-prompt-tool stdio 模式）。 */
  pendingApprovalByRequestId: Map<string, string>;
  /** 已收到根 result 且后台／通知轮次收尾；关闭 stdin 前仍需检查交互待办。 */
  claudeResultReceived: boolean;
  /** control protocol：tool_use_id → control_request 的 request_id（用于 AskUserQuestion control_response 回写）。 */
  controlRequestIdByToolUseId: Map<string, string>;
  /** control protocol：tool_use_id → 原始 input（包含 questions 数组，用于 updatedInput 回填）。 */
  controlRequestInputByToolUseId: Map<string, unknown>;
  /** subagent：parent_tool_use_id(Task 工具的 tool_use_id) → taskId。 */
  subagentTaskIdByToolUseId: Map<string, string>;
  /** Claude task lifecycle：taskId → task_type，用于区分 local_agent 与 local_bash。 */
  taskTypeByTaskId: Map<string, string>;
  /** 每个 subagent 独立的 ToolState（用于 tool_use→tool_result 关联）。 */
  subagentToolStateByTaskId: Map<string, ToolState>;
  /** 已发出 item.tool.started 事件的 toolId（用于延迟空 input 的 started 事件）。 */
  toolStartedEmitted: Set<string>;
  /** 缓存已到达 tool_result 但 task_started 尚未到达的 subagent 完成信息（处理 Claude Code 事件乱序）。 */
  pendingSubagentCompletion: Map<string, { taskId: string; status: string; summary: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }>;
  /** 早期 subagent 映射：realTaskId → earlyTaskId（= toolUseId）。用于处理 task_started 晚于首个子事件到达的场景。 */
  earlySubagentTaskIdMapping: Map<string, string>;
  /** 已 emit item.subagent.completed 的 ID 集合（同时包含 toolUseId 和 effectiveTaskId）。
   *  用于阻止迟到的 task_started/task_progress 发出 progress 把终态踩回 running。 */
  completedSubagentIds: Set<string>;
  /** Claude 本地后台命令任务：taskId → 元信息。 */
  backgroundShellMetaByTaskId: Map<string, ClaudeBackgroundShellTaskMeta>;
};

/** 初始化 tool 状态（用于 tool_use/tool_result 与 input_json_delta 归并）。 */
export function createToolState(): ToolState {
  return {
    toolNameById: new Map(),
    toolIdByIndex: new Map(),
    toolInputById: new Map(),
    toolTodolistItemsById: new Map(),
    claudeTaskTodoById: new Map(),
    pendingClaudeTaskTodoByToolUseId: new Map(),
    claudeTaskTodoOrder: 0,
    toolPresentationById: new Map(),
    pendingUserInputByRequestId: new Map(),
    pendingApprovalByRequestId: new Map(),
    claudeResultReceived: false,
    controlRequestIdByToolUseId: new Map(),
    controlRequestInputByToolUseId: new Map(),
    subagentTaskIdByToolUseId: new Map(),
    taskTypeByTaskId: new Map(),
    subagentToolStateByTaskId: new Map(),
    toolStartedEmitted: new Set(),
    pendingSubagentCompletion: new Map(),
    earlySubagentTaskIdMapping: new Map(),
    completedSubagentIds: new Set(),
    backgroundShellMetaByTaskId: new Map(),
  };
}

/** 从 todowrite input 的 todos 数组中提取标准 todolistItems。 */
export function extractTodolistItems(todos: unknown): { step: string; status: string }[] | null {
  if (!Array.isArray(todos)) return null;
  const items = todos
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const r = t as Record<string, unknown>;
      const step = String(r.content ?? r.text ?? r.task ?? r.title ?? "").trim();
      const status = String(r.status ?? "").trim();
      return step ? { step, status } : null;
    })
    .filter((v): v is { step: string; status: string } => v !== null);
  return items.length ? items : null;
}

export function resolveToolUseId(block: any, index: number | null): string | null {
  const id = extractString(block, ["id", "tool_use_id", "toolUseId", "tool_id", "toolId"]);
  if (id) return id;
  if (typeof index === "number") return `tool-block-${index}`;
  return null;
}

export function resolveToolResultId(block: any, index: number | null, tool: ToolState): string | null {
  // 优先用 index→toolId 映射：避免 tool_result 自带 id 与 tool_use 缺失 id 时产生不一致，导致 Web 卡在“运行中”。
  if (typeof index === "number") {
    const mapped = tool.toolIdByIndex.get(index);
    if (mapped) return mapped;
  }
  const direct = extractString(block, ["tool_use_id", "toolUseId", "toolUseID", "tool_id", "toolId", "id"]);
  if (direct) return direct;
  return null;
}

export function extractToolOutput(content: any): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (typeof c?.text === "string" ? c.text : typeof c === "string" ? c : null))
      .filter((v): v is string => Boolean(v));
    if (texts.length) return texts.join("");
    return content;
  }
  return content ?? null;
}

function extractString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
