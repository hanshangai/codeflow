import type { ConversationDiff, ConversationTool } from "../types/conversation.js";

import type { DisplayConversationItem } from "./prepareConversationItems.js";

export type ProcessRenderEntry = {
  key: string;
  item: DisplayConversationItem;
  diff: ConversationDiff | null;
};

export type AssistantRenderNode =
  | { kind: "item"; key: string; item: DisplayConversationItem; diff: ConversationDiff | null }
  | {
    kind: "process-batch";
    key: string;
    entries: ProcessRenderEntry[];
    preview: string;
    statusCounts: { done: number; running: number; warning: number; failed: number };
  };

/**
 * 如果 items[idx+1] 是 diff，返回该 diff（用于合并到 tool 卡片内）；否则返回 null。
 */
function getFollowingDiff(items: DisplayConversationItem[], idx: number): ConversationDiff | null {
  const next = idx + 1 < items.length ? items[idx + 1] : null;
  return next?.kind === "diff" ? (next as ConversationDiff) : null;
}

function isInvisibleAssistantMessageItem(item: DisplayConversationItem | null | undefined): boolean {
  if (!item || item.kind !== "message") return false;
  if (item.role !== "assistant") return false;
  return !String(item.text ?? "").trim() && !(item.images?.length) && !(item.files?.length);
}

function normalizeToolTypeKey(toolTypeRaw: string): string {
  return String(toolTypeRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** todolist 类工具（update_plan/todowrite）始终独立成行，不参与过程分组。 */
function isTaskToolItem(item: ConversationTool): boolean {
  const toolKey = normalizeToolTypeKey(item.toolType);
  return toolKey === "update_plan" || toolKey === "todowrite";
}

/** 可参与「过程」分组的条目：除 todolist 工具外的工具、子任务、推理、diff、评审、explore。 */
export function isProcessBatchItem(item: DisplayConversationItem): boolean {
  if (item.kind === "tool") return !isTaskToolItem(item);
  return item.kind === "reasoning"
    || item.kind === "subagent"
    || item.kind === "diff"
    || item.kind === "review"
    || item.kind === "explore";
}

/** 取单条目的摘要文本；无可用字段时返回空串。 */
function summarizeProcessEntry(entry: ProcessRenderEntry): string {
  const item = entry.item;
  if (item.kind === "reasoning") {
    return String(item.summary ?? item.content ?? "").trim();
  }
  if (item.kind === "tool") {
    return String(item.summary ?? item.title ?? item.toolType ?? "").trim();
  }
  if (item.kind === "subagent") {
    return String(item.description ?? "").trim();
  }
  if (item.kind === "explore") {
    return String(item.entries?.[0]?.label ?? "").trim();
  }
  if (item.kind === "review") {
    return String(item.text ?? "").trim();
  }
  if (item.kind === "diff") {
    return String(item.title ?? "").trim();
  }
  return "";
}

/** 按展示顺序选择首个可用摘要，调用方负责长度上限。 */
export function buildProcessBatchPreview(entries: ProcessRenderEntry[]): string {
  for (const entry of entries) {
    const preview = summarizeProcessEntry(entry);
    if (preview) return preview;
  }
  return "";
}

/** 按明细状态分别计数；推理、差异等无执行状态条目只计入总条数。 */
export function countProcessBatchStatuses(entries: ProcessRenderEntry[]): Extract<AssistantRenderNode, { kind: "process-batch" }>["statusCounts"] {
  const counts = { done: 0, running: 0, warning: 0, failed: 0 };
  for (const entry of entries) {
    const item = entry.item;
    if (item.kind === "tool") {
      if (item.status === "completed") counts.done += 1;
      else if (item.status === "failed") counts.failed += 1;
      else if (item.status === "incomplete") counts.warning += 1;
      else counts.running += 1;
    }
    if (item.kind === "subagent") {
      if (item.status === "completed") counts.done += 1;
      else if (item.status === "running") counts.running += 1;
      else counts.failed += 1;
    }
    if (item.kind === "explore") {
      if (item.status === "explored") counts.done += 1;
      else counts.running += 1;
    }
    if (item.kind === "review") {
      if (item.state === "completed") counts.done += 1;
      else counts.running += 1;
    }
  }
  return counts;
}

/** 为 assistant 组内同级节点生成带类型命名空间的 Vue key，避免聚合节点与原始 item id 碰撞。 */
function renderKeyForItem(item: DisplayConversationItem): string {
  return `${String(item.kind)}:${String(item.id)}`;
}

/** 生成展示节点，合并连续过程条目并统计各自执行状态。 */
export function buildAssistantRenderNodes(items: DisplayConversationItem[]): AssistantRenderNode[] {
  const normalizedItems = items.filter((item) => !isInvisibleAssistantMessageItem(item));
  const nodes: AssistantRenderNode[] = [];
  let idx = 0;

  while (idx < normalizedItems.length) {
    const current = normalizedItems[idx]!;

    if (current.kind === "approvalRequest" || current.kind === "userInputRequest") {
      nodes.push({
        kind: "item",
        key: renderKeyForItem(current),
        item: current,
        diff: null,
      });
      idx += 1;
      continue;
    }

    if (isProcessBatchItem(current)) {
      const entries: ProcessRenderEntry[] = [];
      while (idx < normalizedItems.length && isProcessBatchItem(normalizedItems[idx]!)) {
        const item = normalizedItems[idx]!;
        if (item.kind === "tool") {
          const tool = item as ConversationTool;
          const diff = getFollowingDiff(normalizedItems, idx);
          entries.push({
            key: renderKeyForItem(tool),
            item: tool,
            diff,
          });
          idx += diff ? 2 : 1;
          continue;
        }
        entries.push({
          key: renderKeyForItem(item),
          item,
          diff: null,
        });
        idx += 1;
      }
      if (entries.length > 1) {
        nodes.push({
          kind: "process-batch",
          key: `process-batch:${entries[0]!.key}`,
          entries,
          preview: buildProcessBatchPreview(entries),
          statusCounts: countProcessBatchStatuses(entries),
        });
      } else {
        const only = entries[0]!;
        nodes.push({
          kind: "item",
          key: only.key,
          item: only.item,
          diff: only.diff,
        });
      }
      continue;
    }

    if (current.kind === "diff" && idx > 0 && normalizedItems[idx - 1]?.kind === "tool") {
      idx += 1;
      continue;
    }

    nodes.push({
      kind: "item",
      key: renderKeyForItem(current),
      item: current,
      diff: null,
    });
    idx += 1;
  }

  return nodes;
}
