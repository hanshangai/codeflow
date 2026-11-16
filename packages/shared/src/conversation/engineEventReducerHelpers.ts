import type {
  ConversationApprovalRequest,
  ConversationDiff,
  ConversationExplore,
  ConversationMessage,
  ConversationReasoning,
  ConversationReview,
  ConversationSubagent,
  ConversationTool,
} from "../index.js";

import type { ThreadConversationState, TodolistRow } from "./chatTypes.js";

/** 将任意输入尽量格式化为可读文本（用于 tool/detail/output 展示）。 */
export function formatJson(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/* ---- 索引辅助：push 到 items 的同时维护 _indexById ---- */

export function indexedPush(state: ThreadConversationState, item: { id?: unknown; requestId?: unknown; [k: string]: unknown }): void {
  state.items.push(item as any);
  const key = String((item as any).id ?? "");
  if (key) state._indexById.set(key, item as any);
}

export function applyMessageTimestamp(message: Pick<ConversationMessage, "createdAt">, ts: number | null | undefined): void {
  const normalizedTs = Number(ts ?? 0);
  if (!Number.isFinite(normalizedTs) || normalizedTs <= 0) return;
  if (!message.createdAt || message.createdAt <= 0) {
    message.createdAt = normalizedTs;
    return;
  }
  message.createdAt = Math.min(message.createdAt, normalizedTs);
}

/** 查找指定 itemId 的 user message（找不到返回 null）。 */
export function findUserMessage(state: ThreadConversationState, itemId: string): ConversationMessage | null {
  const hit = state._indexById.get(itemId);
  if (hit && hit.kind === "message" && hit.role === "user") return hit as ConversationMessage;
  return null;
}

/** 按 turnId 查找本地 optimistic user message；避免同 turn 的追加消息覆盖权威消息。 */
export function findOptimisticUserMessageByTurnId(
  state: ThreadConversationState,
  turnId: string | null | undefined,
): ConversationMessage | null {
  const normalizedTurnId = normalizeOptionalId(turnId);
  if (!normalizedTurnId) return null;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind !== "message" || item.role !== "user") continue;
    if (!isOptimisticUserMessageId(item.id)) continue;
    if (normalizeOptionalId(item.turnId) === normalizedTurnId) {
      return item as ConversationMessage;
    }
  }
  return null;
}

export function findLatestOptimisticUserMessageByContent(
  state: ThreadConversationState,
  input: {
    text: string;
    inputKind?: ConversationMessage["inputKind"];
    skillMentions?: ConversationMessage["skillMentions"];
    images?: string[];
    files?: ConversationMessage["files"];
    pathReferences?: ConversationMessage["pathReferences"];
  },
): ConversationMessage | null {
  const expectedText = input.text ?? "";
  const expectedInputKind = input.inputKind ?? null;
  const expectedSkillMentions = input.skillMentions ?? [];
  const expectedImages = input.images ?? [];
  const expectedFiles = input.files ?? [];
  const expectedPathReferences = input.pathReferences ?? [];
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind !== "message" || item.role !== "user") continue;
    if (!isOptimisticUserMessageId(item.id)) continue;
    if ((item.text ?? "") !== expectedText) continue;
    if ((item.inputKind ?? null) !== expectedInputKind) continue;
    if (!sameSkillMentions(item.skillMentions ?? [], expectedSkillMentions)) continue;
    if (!sameStringArray(item.images ?? [], expectedImages)) continue;
    if (!sameFiles(item.files ?? [], expectedFiles)) continue;
    if (!samePathReferences(item.pathReferences ?? [], expectedPathReferences)) continue;
    return item as ConversationMessage;
  }
  return null;
}

/** 比较乐观消息的 opaque Skill binding。 */
function sameSkillMentions(
  a: readonly NonNullable<ConversationMessage["skillMentions"]>[number][],
  b: readonly NonNullable<ConversationMessage["skillMentions"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export function rekeyIndexedItem(
  state: ThreadConversationState,
  item: { id?: unknown; [k: string]: unknown },
  nextId: string,
): void {
  const normalizedNextId = normalizeRequiredId(nextId);
  if (!normalizedNextId) return;
  const currentId = normalizeRequiredId(item.id);
  if (currentId === normalizedNextId) return;
  if (currentId && state._indexById.get(currentId) === item) {
    state._indexById.delete(currentId);
  }
  (item as any).id = normalizedNextId;
  state._indexById.set(normalizedNextId, item as any);
}

/** 查找或创建 assistant message（用于 delta 合并）。 */
export function findOrCreateAssistantMessage(
  state: ThreadConversationState,
  input: { engine: string; itemId: string; turnId?: string | null },
): ConversationMessage {
  const transcriptId = resolveAssistantTranscriptId(state, input);
  const hit = state._indexById.get(transcriptId);
  if (hit && hit.kind === "message" && hit.role === "assistant") return hit as ConversationMessage;
  const created: ConversationMessage = {
    kind: "message",
    id: transcriptId as any,
    role: "assistant",
    text: "",
    format: "plain",
  };
  const turnId = normalizeOptionalId(input.turnId);
  if (turnId) created.turnId = turnId as any;
  indexedPush(state, created);
  return created;
}

function resolveAssistantTranscriptId(
  state: ThreadConversationState,
  input: { engine: string; itemId: string; turnId?: string | null },
): string {
  const itemId = normalizeRequiredId(input.itemId);
  if (!itemId) return "";
  // 真实时间线下，assistant raw item 应按自身 itemId 独立展示。
  // 这里不再把 Codex 同一 turn 的多个 assistant item 折叠成一个 transcript。
  return itemId;
}

function normalizeRequiredId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalId(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function isOptimisticUserMessageId(value: unknown): boolean {
  return normalizeRequiredId(value).startsWith("local_user_");
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i] ?? "") !== String(b[i] ?? "")) return false;
  }
  return true;
}

function sameFiles(
  a: readonly NonNullable<ConversationMessage["files"]>[number][],
  b: readonly NonNullable<ConversationMessage["files"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 比较用户消息路径引用，用于本地乐观消息与权威事件合并。 */
function samePathReferences(
  a: readonly NonNullable<ConversationMessage["pathReferences"]>[number][],
  b: readonly NonNullable<ConversationMessage["pathReferences"]>[number][],
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 查找或创建 reasoning 条目（用于 delta 合并）。 */
export function findOrCreateReasoning(
  state: ThreadConversationState,
  itemId: string,
  input?: { placeholder?: boolean },
): ConversationReasoning {
  const hit = state._indexById.get(itemId);
  if (hit && hit.kind === "reasoning") return hit as ConversationReasoning;
  const created: ConversationReasoning = {
    kind: "reasoning",
    id: itemId,
    summary: undefined,
    content: "",
    placeholder: input?.placeholder || undefined,
  };
  indexedPush(state, created);
  return created;
}

export function removeEmptyReasoningPlaceholders(state: ThreadConversationState): boolean {
  const removedIds: string[] = [];
  state.items = state.items.filter((item) => {
    if (item.kind !== "reasoning") return true;
    if (!item.placeholder) return true;
    if (String(item.content ?? "").trim()) return true;
    if (String(item.summary ?? "").trim()) return true;
    removedIds.push(String(item.id));
    return false;
  });
  for (const id of removedIds) {
    state._indexById.delete(id);
  }
  return removedIds.length > 0;
}

/** 查找工具条目（找不到返回 null）。 */
export function findTool(state: ThreadConversationState, itemId: string): ConversationTool | null {
  const hit = state._indexById.get(itemId);
  if (hit && hit.kind === "tool") return hit as ConversationTool;
  return null;
}

/** 查找或创建工具条目（用于 started/delta/completed 合并）。 */
export function findOrCreateTool(state: ThreadConversationState, itemId: string, toolName: string): ConversationTool {
  const existing = findTool(state, itemId);
  if (existing) return existing;
  const created: ConversationTool = {
    kind: "tool",
    id: itemId,
    toolType: toolName,
    title: toolName,
    detail: "",
    status: "unknown",
  };
  indexedPush(state, created);
  return created;
}

/** 查找指定 requestId 的 approval 请求（找不到返回 null）。 */
export function findApproval(state: ThreadConversationState, requestId: unknown): ConversationApprovalRequest | null {
  // approval 的 id 格式为 `approval_${requestId}`，直接用 id 查索引。
  const key = `approval_${String(requestId ?? "")}`;
  const hit = state._indexById.get(key);
  if (hit && hit.kind === "approvalRequest") return hit as ConversationApprovalRequest;
  return null;
}

/** 写入或更新 approval 条目（幂等）。 */
export function upsertApproval(state: ThreadConversationState, item: ConversationApprovalRequest): void {
  const existing = findApproval(state, item.requestId);
  if (existing) {
    existing.toolName = item.toolName;
    existing.message = item.message;
    existing.input = item.input;
    existing.state = item.state;
    return;
  }
  indexedPush(state, item);
}

/** 写入或更新 diff 条目（幂等）。 */
export function upsertDiff(state: ThreadConversationState, item: ConversationDiff): void {
  const hit = state._indexById.get(String(item.id));
  if (hit && hit.kind === "diff") {
    const existing = hit as ConversationDiff;
    existing.title = item.title;
    existing.diff = item.diff;
    existing.status = item.status;
    return;
  }
  indexedPush(state, item);
}

/** 写入或更新 review 条目（幂等）。 */
export function upsertReview(state: ThreadConversationState, item: ConversationReview): void {
  const hit = state._indexById.get(String(item.id));
  if (hit && hit.kind === "review") {
    const existing = hit as ConversationReview;
    existing.state = item.state;
    existing.text = item.text;
    return;
  }
  indexedPush(state, item);
}

/** 写入或更新 explore 条目（幂等）。 */
export function upsertExplore(state: ThreadConversationState, item: ConversationExplore): void {
  const hit = state._indexById.get(String(item.id));
  if (hit && hit.kind === "explore") {
    const existing = hit as ConversationExplore;
    existing.status = item.status;
    existing.entries = item.entries;
    return;
  }
  indexedPush(state, item);
}

/** 查找 subagent 条目（找不到返回 null）。 */
export function findSubagent(state: ThreadConversationState, itemId: string): ConversationSubagent | null {
  const hit = state._indexById.get(itemId);
  if (hit && hit.kind === "subagent") return hit as ConversationSubagent;
  return null;
}

/** 写入或更新 subagent 条目（幂等）。 */
export function upsertSubagent(state: ThreadConversationState, item: ConversationSubagent): void {
  const existing = findSubagent(state, String(item.id));
  if (existing) {
    existing.status = item.status;
    existing.description = item.description || existing.description;
    if (item.summary != null) existing.summary = item.summary;
    if (item.lastToolName != null) existing.lastToolName = item.lastToolName;
    if (item.usage != null) existing.usage = item.usage;
    return;
  }
  // Claude Code 的 task_started 事件可能晚于 tool_result 和 assistant text delta 到达，
  // 导致 subagent 卡片被 push 到 AI 文本之后。如果有 toolUseId，将 subagent 插入到
  // 对应 Tool 卡片之后，保证 Tool → Subagent → AI文本 的正确视觉顺序。
  if (item.toolUseId) {
    const toolIdx = state.items.findIndex((i) => i.id === item.toolUseId);
    if (toolIdx >= 0) {
      state.items.splice(toolIdx + 1, 0, item as any);
      const key = String(item.id ?? "");
      if (key) state._indexById.set(key, item as any);
      return;
    }
  }
  indexedPush(state, item);
}

/* ---- todolist 解析工具函数 ---- */

export function formatTodolistStatus(statusRaw: string): Pick<TodolistRow, "statusLabel" | "statusColor"> {
  const s = String(statusRaw ?? "").trim().toLowerCase();
  if (s === "completed" || s === "done") return { statusLabel: "已完成", statusColor: "green" };
  if (s === "in_progress" || s === "inprogress" || s === "in-progress" || s === "in progress" || s === "doing" || s === "running")
    return { statusLabel: "进行中", statusColor: "blue" };
  if (s === "pending" || s === "todo") return { statusLabel: "未开始", statusColor: "default" };
  return { statusLabel: statusRaw || "unknown", statusColor: "default" };
}

/**
 * 将 ConversationTool.todolistItems 同步到 state.currentTodolist（供浮动 TodolistBar 读取）。
 * 仅在 tool.todolistItems 有效时调用。
 */
export function syncCurrentTodolist(
  state: ThreadConversationState,
  tool: { summary?: string; todolistItems?: { step: string; status: string }[] },
): void {
  const items = tool.todolistItems;
  if (!items?.length) return;
  const rows: TodolistRow[] = items
    .filter(({ step }) => Boolean(step))
    .map(({ step, status }) => ({ step, status, ...formatTodolistStatus(status) }));
  if (rows.length) {
    state.currentTodolist = { explanation: tool.summary ?? "", rows };
  }
}

