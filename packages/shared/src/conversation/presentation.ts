import type { ConversationEventEnvelope } from "../types/events.js";
import type { ConversationItem, ConversationProcess } from "../types/conversation.js";
import type { ThreadId, WorkspaceId } from "../types/ids.js";
import type { ThreadConversationState } from "./chatTypes.js";
import { buildAssistantRenderNodes, buildProcessBatchPreview, countProcessBatchStatuses, isProcessBatchItem } from "./assistantRenderNodes.js";
import { prepareConversationItemsForDisplay } from "./prepareConversationItems.js";
import { refreshConversationNodeLabels, type OrchestrationNodeLabelMap } from "./engineEventReducer.js";

export type ConversationStateSnapshot = Omit<ThreadConversationState,
  "items" | "_indexById" | "deletedMessageIds" | "_assistantTranscriptIdByItemId" | "_assistantTranscriptIdByTurnId"> & {
  deletedMessageIds: string[];
  assistantTranscriptIdsByItem: Array<[string, string]>;
  assistantTranscriptIdsByTurn: Array<[string, string]>;
};

export type ThreadPresentation = { version: number; items: ConversationItem[]; state: ConversationStateSnapshot;
  /** 窗口之前是否还有更早消息；全量读取时省略。 */
  hasMoreOlder?: boolean;
  /** 已加载窗口最早消息的展示位置；增量读取时作为 beforePosition 游标。 */
  oldestPosition?: number | null };
export type ThreadProcessDetails = {
  items: ConversationItem[];
  version: number;
  nextCursor: string | null;
  hasMore: boolean;
  /** 当前过程的轻量成员顺序，处理分页期间迟到子任务插入和成员移除。 */
  itemOrder?: string[];
};
export type ConversationChangedMessage = {
  t: "conversation.changed"; workspaceId: WorkspaceId; threadId: ThreadId; version: number;
  /** 仅保留资源刷新信号，工具输入、输出、diff 与推理正文都不跨展示通道。 */
  toolCompleted?: { seq: number; toolName: string; hasFileChanges: boolean; managedServicesChanged: boolean };
};
export type ConversationProcessGroup = { processId: string; items: ConversationItem[] };

/** 投影索引只保留摘要及归并所需信息；目标条目更新前必须恢复完整快照。 */
export function createConversationItemStub(item: ConversationItem): ConversationItem {
  if (!isProcessBatchItem(item)) return item;
  if (item.kind === "reasoning") return { ...item, content: item.content.slice(0, 160), summary: item.summary?.slice(0, 160) };
  if (item.kind === "diff") return { ...item, diff: "", title: item.title?.slice(0, 160) };
  if (item.kind === "review") return { ...item, text: item.text.slice(0, 160) };
  if (item.kind === "explore") return { ...item, entries: item.entries.slice(0, 1).map(entry => ({ ...entry, label: entry.label.slice(0, 160), detail: undefined })) };
  if (item.kind === "subagent") return { ...item, description: item.description.slice(0, 160), summary: item.summary?.slice(0, 160), children: undefined };
  if (item.kind === "tool") {
    const display = prepareConversationItemsForDisplay([item])[0];
    const stub = { ...item, detail: "", output: undefined, todolistText: undefined, changes: undefined,
      summary: item.summary?.slice(0, 160), title: item.title.slice(0, 160) };
    if (display?.kind === "explore" || display?.kind === "review") {
      return Object.assign(stub, { _display: createConversationItemStub(display) });
    }
    return stub;
  }
  return item;
}

/** 创建现有 reducer 的空状态，供本地投影和前端共用。 */
export function createConversationState(threadId: ThreadId): ThreadConversationState {
  return { threadId, items: [], _indexById: new Map(), _assistantTranscriptIdByItemId: new Map(),
    _assistantTranscriptIdByTurnId: new Map(), tokenUsage: null, runningTurnId: null, runningTurnStartedAt: null,
    completedTurnIds: {}, engineSessionId: null, currentTodolist: null, invalidated: false };
}

/** 仅序列化 reducer 的轻量状态，排除含正文的条目索引。 */
export function snapshotConversationState(state: ThreadConversationState): ConversationStateSnapshot {
  return { threadId: state.threadId, tokenUsage: state.tokenUsage, runningTurnId: state.runningTurnId,
    runningTurnStartedAt: state.runningTurnStartedAt, completedTurnIds: state.completedTurnIds,
    engineSessionId: state.engineSessionId, currentTodolist: state.currentTodolist, invalidated: state.invalidated,
    deletedMessageIds: [...(state.deletedMessageIds ?? [])],
    assistantTranscriptIdsByItem: [...state._assistantTranscriptIdByItemId],
    assistantTranscriptIdsByTurn: [...state._assistantTranscriptIdByTurnId] };
}

/** 恢复同一 reducer 状态；条目按 ID 建索引，正文快照不再回放 delta。 */
export function restoreConversationState(snapshot: ConversationStateSnapshot, items: ConversationItem[], nodeLabels?: OrchestrationNodeLabelMap): ThreadConversationState {
  const { deletedMessageIds, assistantTranscriptIdsByItem, assistantTranscriptIdsByTurn, ...state } = snapshot;
  if (nodeLabels) items = refreshConversationNodeLabels(items, nodeLabels);
  return { ...state, items, deletedMessageIds: new Set(deletedMessageIds), _indexById: new Map(items.map(item => [String(item.id), item])),
    _assistantTranscriptIdByItemId: new Map(assistantTranscriptIdsByItem), _assistantTranscriptIdByTurnId: new Map(assistantTranscriptIdsByTurn) };
}

/** 空助手占位不切断过程，和现有渲染节点规则保持一致。 */
function isInvisibleMessage(item: ConversationItem): boolean {
  return item.kind === "message" && item.role === "assistant" && !item.text.trim() && !item.images?.length && !item.files?.length;
}

/** 用原始条目 ID 确定过程归属；展示转换改变工具类型时入口 ID 仍稳定。 */
export function getConversationProcessGroups(items: readonly ConversationItem[]): ConversationProcessGroup[] {
  const groups: ConversationProcessGroup[] = [];
  let current: ConversationProcessGroup | null = null;
  for (const item of items) {
    if (isInvisibleMessage(item)) continue;
    if (!isProcessBatchItem(item)) { current = null; continue; }
    if (!current) { current = { processId: `process:${String(item.id)}`, items: [] }; groups.push(current); }
    current.items.push(item);
  }
  return groups;
}

/** 用既有工具归并、diff 合并和状态统计生成轻量过程入口。 */
export function summarizeConversationProcess(group: ConversationProcessGroup, version: number): ConversationProcess {
  const nodes = buildAssistantRenderNodes(prepareConversationItemsForDisplay(group.items));
  const entries = nodes.flatMap(node => node.kind === "process-batch" ? node.entries : [{ key: node.key, item: node.item, diff: node.diff }]);
  return { kind: "process", id: group.processId, version, itemCount: entries.length,
    preview: buildProcessBatchPreview(entries).slice(0, 160), statusCounts: countProcessBatchStatuses(entries) };
}

/** 首屏仅包含消息、交互和过程摘要；过程详情按独立版本补读。 */
export function buildThreadPresentation(state: ThreadConversationState, version: number, itemVersions?: ReadonlyMap<string, number>): ThreadPresentation {
  const groups = getConversationProcessGroups(state.items);
  const groupByMember = new Map<string, ConversationProcessGroup>();
  for (const group of groups) for (const item of group.items) groupByMember.set(String(item.id), group);
  const emitted = new Set<string>();
  const items: ConversationItem[] = [];
  for (const item of state.items) {
    const group = groupByMember.get(String(item.id));
    if (!group) { if (!isInvisibleMessage(item)) items.push(item); continue; }
    if (emitted.has(group.processId)) continue;
    emitted.add(group.processId);
    const processVersion = itemVersions ? Math.max(0, ...group.items.map(member => itemVersions.get(String(member.id)) ?? 0)) : version;
    items.push(summarizeConversationProcess(group, processVersion));
  }
  return { version, items, state: snapshotConversationState(state) };
}

/** 过程事件只通知已提交版本；正文、审批、待输入和回合终态继续直接推送。 */
export function toConversationDisplayMessage(event: ConversationEventEnvelope): ConversationChangedMessage | { t: "conversation.event"; event: ConversationEventEnvelope } {
  const process = /^(?:item\.(?:reasoning|tool|diff|review|explore|subagent)\.)/.test(event.type);
  const toolName = "toolName" in event.payload ? String(event.payload.toolName ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!process || toolName === "update_plan" || toolName === "todowrite" || "todolistItems" in event.payload) return { t: "conversation.event", event };
  const message: ConversationChangedMessage = { t: "conversation.changed", workspaceId: event.workspaceId, threadId: event.threadId, version: event.seq };
  if (event.type === "item.tool.completed") {
    const output = event.payload.output;
    const service = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : null;
    const managedServicesChanged = ["管理进程", "管理本地进程"].includes(event.payload.toolName ?? "")
      || Boolean(service?.serviceId && service.action && ["starting", "ready", "stopped", "exited"].includes(String(service.status ?? "")));
    message.toolCompleted = { seq: event.seq, toolName: event.payload.toolName ?? "",
      hasFileChanges: Boolean(event.payload.changes?.length), managedServicesChanged };
  }
  return message;
}

/** 严格验证轻量版本通知，避免非法桥消息推动缓存游标。 */
export function isConversationChangedMessage(value: unknown): value is ConversationChangedMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as ConversationChangedMessage;
  const tool = message.toolCompleted;
  return message.t === "conversation.changed" && typeof message.workspaceId === "string" && Boolean(message.workspaceId.trim())
    && typeof message.threadId === "string" && Boolean(message.threadId.trim()) && Number.isSafeInteger(message.version) && message.version > 0
    && (tool === undefined || Boolean(tool && typeof tool === "object" && Number.isSafeInteger(tool.seq) && tool.seq > 0 && tool.seq <= message.version
      && typeof tool.toolName === "string" && typeof tool.hasFileChanges === "boolean" && typeof tool.managedServicesChanged === "boolean"));
}
