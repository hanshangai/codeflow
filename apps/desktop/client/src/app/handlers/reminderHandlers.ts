import type {
  IgnoreReminderItemsResponseBody,
  IntakeId,
  MarkReminderReadResponseBody,
  OrchestrationMetricReviewReminderScanResponseBody,
  ReminderItem,
  ThreadSummary,
  WorkspaceReminderSummary,
  WorkspaceId,
  OrchestrationInstanceSummary,
} from "@codeflowai/shared";
import { isReminderActionItem, isReminderReceiptItem, resolveReminderDisplayKind } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import type { ThreadReminderStateRecord } from "../../db/repos/threadReminderStateRepo.js";
import type { ReminderReceiptRecord } from "../../db/repos/reminderReceiptRepo.js";
import type { ReminderIgnoreRecord } from "../../db/repos/reminderIgnoreRepo.js";
import { OrchCurrentWorkflowLabelResolver, relabelInstanceSummary } from "../../orchestration/orchCurrentDefinitionLabels.js";
import { shouldSendThreadCompletionNotification } from "../../notifications/threadCompletionNotificationPolicy.js";
import {
  deriveDueMetricReviewReminders,
  toMetricReviewReminderItem,
  toMetricReviewReminderScanItem,
} from "../../reminders/orchestrationMetricReviewReminder.js";

type ReminderEntityType = "thread" | "orch_instance";
type ReminderListItem = ReminderItem;

export function handleReminderWorkspaceSummaries(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const summaries = ctx.db.workspaces.list().map((workspace) => deriveWorkspaceReminderSummary(ctx, workspace.id, req.id));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, summaries } });
}

export function handleReminderItemsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const items = deriveWorkspaceReminderItems(ctx, workspaceId, { requestId: req.id });
  const summary = summarizeReminderItems(workspaceId, items);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, summary, items } });
}

/** Scans one local workspace for due metric reviews and returns deterministic notification facts. */
export function handleReminderMetricReviewScan(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const scanAt = Number((req.body as any)?.now);
  if (!Number.isFinite(scanAt) || scanAt <= 0) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：now" } });
    return;
  }
  const workspaceTitle = ctx.db.workspaces.get(workspaceId)?.title ?? String(workspaceId);
  const items = deriveDueMetricReviewReminders(ctx.db.orchIntakes.listByWorkspace(workspaceId), scanAt)
    .map((item) => toMetricReviewReminderScanItem(item, workspaceTitle));
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, items } satisfies OrchestrationMetricReviewReminderScanResponseBody & { ok: true },
  });
}

export function handleReminderIgnoreItems(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const rawSelections = Array.isArray((req.body as any)?.items)
    ? ((req.body as any).items as Array<Record<string, unknown>>)
    : null;
  if (!workspaceId || !rawSelections) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/items" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const currentItems = deriveWorkspaceReminderItems(ctx, workspaceId, { includeIgnored: true, requestId: req.id });
  const itemsById = new Map(currentItems.map((item) => [item.id, item] as const));
  const seenSelections = new Set<string>();
  const ignoredIds: string[] = [];
  for (const selection of rawSelections) {
    const reminderId = String(selection?.reminderId ?? "").trim();
    const ignoreMarker = String(selection?.ignoreMarker ?? "").trim();
    const selectionKey = `${reminderId}::${ignoreMarker}`;
    if (!reminderId || !ignoreMarker || seenSelections.has(selectionKey)) continue;
    seenSelections.add(selectionKey);
    const item = itemsById.get(reminderId);
    if (!item || item.ignoreMarker !== ignoreMarker) continue;

    if (isReminderReceiptItem(item)) {
      const receiptTarget = resolveReminderReceiptTarget(item);
      if (!receiptTarget) continue;
      ctx.db.reminderReceipts.upsert({
        entityType: receiptTarget.entityType,
        workspaceId,
        entityId: receiptTarget.entityId,
        marker: receiptTarget.marker,
      });
      ignoredIds.push(item.id);
      continue;
    }

    ctx.db.reminderIgnores.upsert({
      workspaceId,
      reminderId: item.id,
      marker: item.ignoreMarker,
    });
    ignoredIds.push(item.id);
  }

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, ignoredIds } satisfies IgnoreReminderItemsResponseBody,
  });
}

export function handleReminderMarkRead(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const entityType = normalizeEntityType((req.body as any)?.entityType);
  const entityId = String((req.body as any)?.entityId ?? "").trim();
  const marker = String((req.body as any)?.marker ?? "").trim() || null;
  if (!workspaceId || !entityType || !entityId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/entityType/entityId" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const resolvedMarker = resolveReminderReceiptMarker(ctx, {
    entityType,
    workspaceId,
    entityId,
    marker,
  });
  if (!resolvedMarker) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "提醒项不存在或无可标记内容" } });
    return;
  }

  ctx.db.reminderReceipts.upsert({
    entityType,
    workspaceId,
    entityId,
    marker: resolvedMarker,
  });
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } satisfies MarkReminderReadResponseBody });
}

function deriveWorkspaceReminderSummary(ctx: ApiHandlerContext, workspaceId: WorkspaceId, requestId: string): WorkspaceReminderSummary {
  const items = deriveWorkspaceReminderItems(ctx, workspaceId, { requestId });
  return summarizeReminderItems(workspaceId, items);
}

function summarizeReminderItems(workspaceId: WorkspaceId, items: ReminderListItem[]): WorkspaceReminderSummary {
  return {
    workspaceId,
    pendingActionCount: items.filter((item) => isReminderActionItem(item)).length,
    pendingReceiptCount: items.filter((item) => isReminderReceiptItem(item) && item.readState === "unread").length,
    updatedAt: items[0]?.updatedAt ?? null,
  };
}

/** 已承载工作区共用一次只读短快照；旧应用库上下文保留原仓储归属。 */
function deriveWorkspaceReminderItems(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  opts?: { includeIgnored?: boolean; requestId?: string },
): ReminderListItem[] {
  if (ctx.db.workspaceId !== workspaceId) return deriveReminderItems(ctx, workspaceId, opts);
  return ctx.db.withWorkspaceCoreSnapshot(workspaceId, null, db => {
    if (!db) throw Object.assign(new Error("提醒工作区快照不可用"), {
      code: "REMINDER_WORKSPACE_SNAPSHOT_UNAVAILABLE", requestId: opts?.requestId, workspaceId,
    });
    return deriveReminderItems({ ...ctx, db }, workspaceId, opts);
  });
}

/** 批量读取标记后派生提醒，查询数量不随会话数量增长。 */
function deriveReminderItems(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  opts?: { includeIgnored?: boolean; requestId?: string },
): ReminderListItem[] {
  const receipts = new Map(ctx.db.reminderReceipts.listByWorkspace(workspaceId)
    .map(record => [`${record.entityType}:${record.entityId}`, record] as const));
  const items = [
    ...deriveThreadReminderItems(ctx, workspaceId, receipts),
    ...deriveOrchestrationReminderItems(ctx, workspaceId, opts?.requestId ?? null, receipts),
    ...deriveMetricReviewReminderItems(ctx, workspaceId),
  ];
  const sorted = items.sort(compareReminderItems);
  if (opts?.includeIgnored) return sorted;
  const ignores = new Map(ctx.db.reminderIgnores.listByWorkspace(workspaceId).map(record => [record.reminderId, record]));
  return sorted.filter((item) => !isReminderIgnored(ignores, item));
}

/** Derives review reminders from Intake evidence through the shared due-fact helper. */
function deriveMetricReviewReminderItems(ctx: ApiHandlerContext, workspaceId: WorkspaceId): ReminderListItem[] {
  return deriveDueMetricReviewReminders(ctx.db.orchIntakes.listByWorkspace(workspaceId), Date.now())
    .map(toMetricReviewReminderItem);
}

/** 在线程状态快照上应用本批已读标记。 */
function deriveThreadReminderItems(ctx: ApiHandlerContext, workspaceId: WorkspaceId,
  receipts: ReadonlyMap<string, ReminderReceiptRecord>): ReminderListItem[] {
  const threads = ctx.db.threads.listByWorkspace(workspaceId, {
    includeArchived: false,
    threadListOnly: true,
  }).threads;
  const runningByThreadId = ctx.db.turns.listRunningByWorkspace(workspaceId);
  const reminderStateByThreadId = new Map(
    ctx.db.threadReminderStates.listByWorkspace(workspaceId).map((state) => [String(state.threadId), state] as const),
  );

  const items: ReminderListItem[] = [];
  for (const thread of threads) {
    if (!shouldSendThreadCompletionNotification(thread)) continue;
    if (runningByThreadId[String(thread.id)]) continue;
    const state = reminderStateByThreadId.get(String(thread.id));
    if (!state) continue;
    const item = buildThreadReminderItem(workspaceId, thread, state, receipts);
    if (item) items.push(item);
  }
  return items;
}

/** 从已读取的线程状态和已读标记生成单项提醒。 */
function buildThreadReminderItem(
  workspaceId: WorkspaceId,
  thread: ThreadSummary,
  state: ThreadReminderStateRecord,
  receipts: ReadonlyMap<string, ReminderReceiptRecord>,
): ReminderListItem | null {
  if (state.attentionKind === "approval") {
    return createReminderItem({
      id: `thread:${thread.id}:approval`,
      sourceType: "chat",
      workspaceId,
      displayKind: "action",
      title: thread.title,
      statusLabel: "待确认",
      tone: "info",
      summary: "会话等待您的确认后继续。",
      updatedAt: state.updatedAt,
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_chat_pending_approval",
      primaryActionLabel: "打开会话并确认",
      ignoreMarker: buildThreadAttentionIgnoreMarker(state),
      routeTarget: { workspaceId, threadId: thread.id },
    });
  }
  if (state.attentionKind === "user_input") {
    return createReminderItem({
      id: `thread:${thread.id}:user-input`,
      sourceType: "chat",
      workspaceId,
      displayKind: "action",
      title: thread.title,
      statusLabel: "待补充",
      tone: "warning",
      summary: "会话等待您补充输入后继续。",
      updatedAt: state.updatedAt,
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_chat_pending_input",
      primaryActionLabel: "打开会话并补充",
      ignoreMarker: buildThreadAttentionIgnoreMarker(state),
      routeTarget: { workspaceId, threadId: thread.id },
    });
  }
  if (state.attentionKind === "error") {
    return createReminderItem({
      id: `thread:${thread.id}:error`,
      sourceType: "chat",
      workspaceId,
      displayKind: "action",
      title: thread.title,
      statusLabel: "异常",
      tone: "danger",
      summary: "会话已异常结束，建议先查看上下文。",
      updatedAt: state.updatedAt,
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_chat_thread",
      primaryActionLabel: "查看会话",
      ignoreMarker: buildThreadTerminalIgnoreMarker("error", state.updatedAt),
      routeTarget: { workspaceId, threadId: thread.id },
    });
  }
  if (state.latestCompletedStatus === "interrupted") {
    return createReminderItem({
      id: `thread:${thread.id}:interrupted`,
      sourceType: "chat",
      workspaceId,
      displayKind: "status",
      title: thread.title,
      statusLabel: "已中止",
      tone: "neutral",
      summary: "本次请求已中止，可继续发送消息。",
      updatedAt: state.updatedAt,
      isActionRequired: false,
      readState: "unread",
      primaryActionKind: "open_chat_thread",
      primaryActionLabel: "查看会话",
      ignoreMarker: buildThreadTerminalIgnoreMarker("interrupted", state.updatedAt),
      routeTarget: { workspaceId, threadId: thread.id },
    });
  }
  if (!state.latestCompletedTurnId || state.latestCompletedStatus !== "completed") return null;
  const receipt = receipts.get(`thread:${thread.id}`);
  if (receipt?.marker && receipt.marker === state.latestCompletedTurnId) return null;
  return createReminderItem({
    id: `thread:${thread.id}:receipt:${state.latestCompletedTurnId}`,
    sourceType: "chat",
    workspaceId,
    displayKind: "receipt",
    title: thread.title,
    statusLabel: "待查收",
    tone: "success",
    summary: "会话已完成，等待您查看结果。",
    updatedAt: state.latestCompletedAt ?? state.updatedAt,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "查看结果",
    ignoreMarker: String(state.latestCompletedTurnId),
    routeTarget: { workspaceId, threadId: thread.id },
  });
}

/** 从窄摘要投影派生编排提醒，避免轮询读取实例详情 JSON。 */
function deriveOrchestrationReminderItems(ctx: ApiHandlerContext, workspaceId: WorkspaceId, requestId: string | null,
  receipts: ReadonlyMap<string, ReminderReceiptRecord>): ReminderListItem[] {
  // 提醒项里的节点名取当前工作流定义；读不到定义时 relabel 原样返回冻结快照摘要。
  const resolver = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, requestId);
  const summaries = ctx.db.orchInstances.listReminderSummariesByWorkspace(workspaceId)
    .map((summary) => relabelInstanceSummary(summary, resolver.resolve(workspaceId, summary.workflowId)));
  const grouped = new Map<string, OrchestrationInstanceSummary[]>();
  for (const summary of summaries) {
    const intakeId = String(summary.intakeId ?? "").trim();
    if (!intakeId) continue;
    const list = grouped.get(intakeId) ?? [];
    list.push(summary);
    grouped.set(intakeId, list);
  }
  const items: ReminderListItem[] = [];
  for (const [intakeId, intakeInstances] of grouped.entries()) {
    const item = buildOrchestrationReminderItem(workspaceId, intakeId, intakeInstances, receipts);
    if (item) items.push(item);
  }
  return items;
}

/** 将同一需求的展示摘要转换为一个提醒项。 */
function buildOrchestrationReminderItem(
  workspaceId: WorkspaceId,
  intakeId: string,
  instances: OrchestrationInstanceSummary[],
  receipts: ReadonlyMap<string, ReminderReceiptRecord>,
): ReminderListItem | null {
  const instance = pickDisplayInstance(instances);
  if (!instance) return null;
  const title = String(instance.intakeTitle ?? "").trim() || "未命名需求";
  if (instance.status === "completed") {
    const receipt = receipts.get(`orch_instance:${instance.id}`);
    if (receipt?.marker && receipt.marker === String(instance.id)) return null;
    return createReminderItem({
      id: `orch:${instance.id}:receipt`,
      sourceType: "orchestration",
      workspaceId,
      displayKind: "receipt",
      title,
      statusLabel: "待查收",
      tone: "success",
      summary: "编排执行已完成，等待您查看结果。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: false,
      readState: "unread",
      primaryActionKind: "open_orch_artifacts",
      primaryActionLabel: "查看结果",
      ignoreMarker: String(instance.id),
      routeTarget: {
        workspaceId,
        intakeId: intakeId as IntakeId,
        instanceId: instance.id,
      },
    });
  }

  const waiting = resolveOrchestrationWaitingReminder(instance);
  if (waiting) {
    return createReminderItem({
      id: `orch:${instance.id}:${waiting.kind}:${waiting.nodeId}`,
      sourceType: "orchestration",
      workspaceId,
      displayKind: "action",
      title,
      statusLabel: instance.runSummary.statusLabel,
      tone: instance.runSummary.statusTone,
      summary: waiting.detailText,
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: waiting.actionLabel,
      ignoreMarker: buildOrchestrationIgnoreMarker(instance.id, waiting.kind, waiting.nodeId, instance.updatedAt),
      routeTarget: {
        workspaceId,
        intakeId: intakeId as IntakeId,
        instanceId: instance.id,
        nodeId: waiting.nodeId,
      },
    });
  }

  if (instance.status === "failed") {
    return createReminderItem({
      id: `orch:${instance.id}:failed`,
      sourceType: "orchestration",
      workspaceId,
      displayKind: "action",
      title,
      statusLabel: "失败",
      tone: "danger",
      summary: "执行失败，建议先进入执行工作区查看详情。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: buildOrchestrationIgnoreMarker(instance.id, "failed", null, instance.updatedAt),
      routeTarget: {
        workspaceId,
        intakeId: intakeId as IntakeId,
        instanceId: instance.id,
      },
    });
  }

  if (instance.status === "paused") {
    return createReminderItem({
      id: `orch:${instance.id}:paused`,
      sourceType: "orchestration",
      workspaceId,
      displayKind: "action",
      title,
      statusLabel: "已暂停",
      tone: "warning",
      summary: "执行已暂停，等待您继续处理。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      readState: "unread",
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: buildOrchestrationIgnoreMarker(instance.id, "paused", null, instance.updatedAt),
      routeTarget: {
        workspaceId,
        intakeId: intakeId as IntakeId,
        instanceId: instance.id,
      },
    });
  }

  return null;
}

/** 同一需求优先展示活跃实例，否则展示最近更新的终态实例。 */
function pickDisplayInstance(instances: OrchestrationInstanceSummary[]): OrchestrationInstanceSummary | null {
  const active = instances
    .filter((instance) =>
      instance.status === "pending"
      || instance.status === "running"
      || instance.status === "paused"
      || instance.status === "waiting-start"
      || instance.status === "waiting-approval"
      || instance.status === "waiting-feedback")
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (active[0]) return active[0];
  return [...instances].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

/** 把共享运行摘要中的单一等待节点映射为提醒动作。 */
function resolveOrchestrationWaitingReminder(instance: OrchestrationInstanceSummary): {
  kind: "start" | "feedback" | "approval";
  nodeId: string;
  detailText: string;
  actionLabel: string;
} | null {
  const nodeId = String(instance.runSummary.activeNodeId ?? "").trim();
  if (!nodeId) return null;
  const nodeLabel = String(instance.runSummary.activeNodeLabel ?? "").trim() || "当前节点";
  const detailText = String(instance.runSummary.detailText ?? "").trim();
  if (instance.runSummary.activeNodeStatus === "waiting-start") {
    return { kind: "start", nodeId, detailText: detailText || `${nodeLabel} · 等待人工启动`, actionLabel: "启动节点" };
  }
  if (instance.runSummary.activeNodeStatus === "waiting-approval") {
    return {
      kind: "approval",
      nodeId,
      detailText: detailText || `${nodeLabel} · 等待人工审核`,
      actionLabel: instance.runSummary.statusLabel === "待确认退回" ? "查看结果并决策" : "查看结果并审核",
    };
  }
  if (instance.runSummary.activeNodeStatus !== "waiting-feedback") return null;
  const actionLabel = resolveWaitingFeedbackActionLabel(instance.runSummary.waitingActionKind);
  return { kind: "feedback", nodeId, detailText: detailText || `${nodeLabel} · 等待人工处理`, actionLabel };
}

/** 按共享摘要动作类型生成反馈按钮文案。 */
function resolveWaitingFeedbackActionLabel(kind: OrchestrationInstanceSummary["runSummary"]["waitingActionKind"]): string {
  switch (kind) {
    case "branch_decision":
      return "选择分支";
    case "human_input":
      return "补充并继续";
    case "review_decision":
      return "查看结果并决策";
    case "gate_failure":
      return "查看结果并处理";
    case "execution_error":
      return "查看异常会话";
    default:
      return "查看并处理";
  }
}

function normalizeEntityType(value: unknown): ReminderEntityType | null {
  const entityType = String(value ?? "").trim();
  if (entityType === "thread" || entityType === "orch_instance") return entityType;
  return null;
}

function resolveReminderReceiptMarker(
  ctx: ApiHandlerContext,
  input: {
    entityType: ReminderEntityType;
    workspaceId: WorkspaceId;
    entityId: string;
    marker: string | null;
  },
): string | null {
  if (input.marker) return input.marker;
  if (input.entityType === "thread") {
    const state = ctx.db.threadReminderStates.get(input.entityId);
    if (!state || state.workspaceId !== input.workspaceId) return null;
    return state.latestCompletedTurnId ?? null;
  }
  const instance = ctx.db.orchInstances.get(input.entityId as any);
  if (!instance || instance.workspaceId !== input.workspaceId || instance.status !== "completed") return null;
  return String(instance.id);
}

function resolveReminderReceiptTarget(
  item: ReminderListItem,
): { entityType: ReminderEntityType; entityId: string; marker: string } | null {
  if (!isReminderReceiptItem(item)) return null;
  if (item.sourceType === "chat") {
    const entityId = String(item.routeTarget.threadId ?? "").trim();
    const marker = String(item.ignoreMarker ?? "").trim();
    if (!entityId || !marker) return null;
    return { entityType: "thread", entityId, marker };
  }
  const entityId = String(item.routeTarget.instanceId ?? "").trim();
  const marker = String(item.ignoreMarker ?? "").trim();
  if (!entityId || !marker) return null;
  return { entityType: "orch_instance", entityId, marker };
}

/** 只按本工作区同版本标记过滤，回执项继续由已读标记控制。 */
function isReminderIgnored(ignores: ReadonlyMap<string, ReminderIgnoreRecord>, item: ReminderListItem): boolean {
  if (isReminderReceiptItem(item)) return false;
  const record = ignores.get(item.id);
  return Boolean(record && record.marker === item.ignoreMarker);
}

function compareReminderItems(left: ReminderListItem, right: ReminderListItem): number {
  const leftKind = resolveReminderDisplayKind(left);
  const rightKind = resolveReminderDisplayKind(right);
  if (leftKind !== rightKind) return reminderDisplayPriority(leftKind) - reminderDisplayPriority(rightKind);
  return right.updatedAt - left.updatedAt;
}

function createReminderItem(input: ReminderListItem): ReminderListItem {
  return input;
}

function buildThreadAttentionIgnoreMarker(state: ThreadReminderStateRecord): string {
  const requestId = String(state.attentionRequestId ?? "").trim();
  return `thread-attention:${state.attentionKind ?? "unknown"}:${requestId || state.updatedAt}`;
}

function buildThreadTerminalIgnoreMarker(kind: "error" | "interrupted", updatedAt: number): string {
  return `thread-terminal:${kind}:${updatedAt}`;
}

function buildOrchestrationIgnoreMarker(
  instanceId: string,
  kind: "start" | "feedback" | "approval" | "failed" | "paused",
  nodeId: string | null,
  updatedAt: number,
): string {
  const suffix = nodeId ? `:${nodeId}` : "";
  return `orch:${instanceId}:${kind}${suffix}:${updatedAt}`;
}

function reminderDisplayPriority(kind: ReturnType<typeof resolveReminderDisplayKind>): number {
  if (kind === "action") return 0;
  if (kind === "status") return 1;
  return 2;
}
