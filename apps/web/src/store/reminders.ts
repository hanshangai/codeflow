import { defineStore } from "pinia";
import type { ReminderItem, WorkspaceId, WorkspaceReminderSummary } from "@codeflowai/shared";
import { isReminderActionItem, isReminderReceiptItem } from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../api/request";
import { ignoreReminderItems, listWorkspaceReminderItems, listWorkspaceReminderSummaries, markReminderRead } from "../api/reminders";
import { isSharedWorkspaceSelectionId, workspaceIdsReferToSameWorkspace } from "../utils/workspaceId";

type ReminderState = {
  summariesByWorkspaceId: Record<string, WorkspaceReminderSummary>;
  currentWorkspaceId: WorkspaceId | null;
  currentSummary: WorkspaceReminderSummary | null;
  currentItems: ReminderItem[];
  workspaceSummariesLoading: boolean;
  currentItemsLoading: boolean;
  lastError: string | null;
};

function summarizeWorkspaceReminderItems(workspaceId: WorkspaceId, items: ReminderItem[]): WorkspaceReminderSummary {
  return {
    workspaceId,
    pendingActionCount: items.filter((item) => isReminderActionItem(item)).length,
    pendingReceiptCount: items.filter((item) => isReminderReceiptItem(item) && item.readState === "unread").length,
    updatedAt: items[0]?.updatedAt ?? null,
  };
}

type ReminderRefreshTask = {
  scopeKey: string;
  controller: AbortController;
  promise: Promise<void>;
};

export function buildReminderSummariesRefreshScopeKey(
  ctx: Pick<ApiRequestContext, "serverWsOrigin" | "sessionToken">,
): string {
  return [
    "reminder-summaries",
    String(ctx.serverWsOrigin ?? "").trim(),
    String(ctx.sessionToken ?? "").trim(),
  ].join("::");
}

export function buildReminderItemsRefreshScopeKey(
  ctx: Pick<ApiRequestContext, "serverWsOrigin" | "sessionToken">,
  workspaceId: WorkspaceId,
): string {
  return [
    "reminder-items",
    String(ctx.serverWsOrigin ?? "").trim(),
    String(ctx.sessionToken ?? "").trim(),
    String(workspaceId ?? "").trim(),
  ].join("::");
}

let reminderSummariesRefreshTask: ReminderRefreshTask | null = null;
let reminderItemsRefreshTask: ReminderRefreshTask | null = null;

function bindAbortSignal(controller: AbortController, signal?: AbortSignal): void {
  if (!signal) return;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
}

export const useReminderStore = defineStore("reminders", {
  state: (): ReminderState => ({
    summariesByWorkspaceId: {},
    currentWorkspaceId: null,
    currentSummary: null,
    currentItems: [],
    workspaceSummariesLoading: false,
    currentItemsLoading: false,
    lastError: null,
  }),
  getters: {
    workspaceSummaryById: (state) => (workspaceId: WorkspaceId | null | undefined): WorkspaceReminderSummary | null => {
      const key = String(workspaceId ?? "").trim();
      return key ? (state.summariesByWorkspaceId[key] ?? null) : null;
    },
    threadReceiptItem: (state) => (
      threadId: string | null | undefined,
      workspaceId?: WorkspaceId | null,
    ): ReminderItem | null => {
      const key = String(threadId ?? "").trim();
      if (!key) return null;
      return state.currentItems.find((item) =>
        item.sourceType === "chat"
        && isReminderReceiptItem(item)
        && (workspaceId == null || workspaceIdsReferToSameWorkspace(item.workspaceId, workspaceId))
        && String(item.routeTarget.threadId ?? "") === key,
      ) ?? null;
    },
  },
  actions: {
    applyCurrentWorkspaceItems(workspaceId: WorkspaceId, items: ReminderItem[]): void {
      this.currentWorkspaceId = workspaceId;
      this.currentItems = items;
      const summary = summarizeWorkspaceReminderItems(workspaceId, items);
      this.currentSummary = summary;
      this.summariesByWorkspaceId[String(workspaceId)] = summary;
    },

    /** 切换工作区时立即清除旧提醒视图，并使旧的在途请求失效。 */
    resetForWorkspace(workspaceId: WorkspaceId | null = null): void {
      reminderItemsRefreshTask?.controller.abort(createCancelledRequestError("workspace-switch"));
      reminderItemsRefreshTask = null;
      const normalizedWorkspaceId = String(workspaceId ?? "").trim() as WorkspaceId | "";
      this.currentWorkspaceId = normalizedWorkspaceId || null;
      this.currentItems = [];
      this.currentSummary = normalizedWorkspaceId && !isSharedWorkspaceSelectionId(normalizedWorkspaceId)
        ? this.summariesByWorkspaceId[normalizedWorkspaceId] ?? null
        : normalizedWorkspaceId
          ? summarizeWorkspaceReminderItems(normalizedWorkspaceId, [])
          : null;
      this.currentItemsLoading = false;
      this.lastError = null;
    },

    /** 刷新账号可见工作区摘要，仅允许最新作用域请求写回状态。 */
    async refreshWorkspaceSummaries(
      ctx: ApiRequestContext,
      opts?: { signal?: AbortSignal; scopeKey?: string },
    ): Promise<void> {
      const scopeKey = opts?.scopeKey ?? buildReminderSummariesRefreshScopeKey(ctx);
      const existing = reminderSummariesRefreshTask;
      if (existing) {
        if (existing.scopeKey === scopeKey) return existing.promise;
        existing.controller.abort(createCancelledRequestError("scope-change"));
      }

      const controller = new AbortController();
      bindAbortSignal(controller, opts?.signal);

      let task!: Promise<void>;
      task = (async () => {
        this.workspaceSummariesLoading = true;
        try {
          const res = await listWorkspaceReminderSummaries(ctx, { signal: controller.signal });
          if (!res.ok) throw createApiResultError(res);
          if (controller.signal.aborted || reminderSummariesRefreshTask?.promise !== task) return;
          this.summariesByWorkspaceId = Object.fromEntries(
            (res.summaries ?? []).map((summary) => [String(summary.workspaceId), summary] as const),
          );
          this.lastError = null;
        } catch (error) {
          if (isCancelledRequestError(error)) return;
          if (controller.signal.aborted || reminderSummariesRefreshTask?.promise !== task) throw createCancelledRequestError("scope-change");
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (reminderSummariesRefreshTask?.promise === task) {
            reminderSummariesRefreshTask = null;
            this.workspaceSummariesLoading = false;
          } else if (!reminderSummariesRefreshTask) {
            this.workspaceSummariesLoading = false;
          }
        }
      })();

      reminderSummariesRefreshTask = {
        scopeKey,
        controller,
        promise: task,
      };
      return task;
    },

    /** 刷新指定工作区提醒；共享工作区只保留空投影，不读取成员本地提醒。 */
    async refreshCurrentWorkspace(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { signal?: AbortSignal; scopeKey?: string },
    ): Promise<void> {
      const scopeKey = opts?.scopeKey ?? buildReminderItemsRefreshScopeKey(ctx, workspaceId);
      const existing = reminderItemsRefreshTask;
      if (existing) {
        if (existing.scopeKey === scopeKey) return existing.promise;
        existing.controller.abort(createCancelledRequestError("scope-change"));
        reminderItemsRefreshTask = null;
      }

      if (isSharedWorkspaceSelectionId(workspaceId)) {
        const emptySummary = summarizeWorkspaceReminderItems(workspaceId, []);
        this.currentWorkspaceId = workspaceId;
        this.currentItems = [];
        this.currentSummary = emptySummary;
        this.summariesByWorkspaceId[String(workspaceId)] = emptySummary;
        this.currentItemsLoading = false;
        this.lastError = null;
        return;
      }

      const controller = new AbortController();
      bindAbortSignal(controller, opts?.signal);

      if (String(this.currentWorkspaceId ?? "") !== String(workspaceId)) {
        this.currentSummary = null;
        this.currentItems = [];
      }

      let task!: Promise<void>;
      task = (async () => {
        this.currentWorkspaceId = workspaceId;
        this.currentItemsLoading = true;
        try {
          const res = await listWorkspaceReminderItems(ctx, workspaceId, { signal: controller.signal });
          if (!res.ok) throw createApiResultError(res);
          if (
            controller.signal.aborted
            || reminderItemsRefreshTask?.promise !== task
            || !workspaceIdsReferToSameWorkspace(this.currentWorkspaceId, workspaceId)
          ) return;
          this.currentItems = res.items ?? [];
          this.currentSummary = res.summary ?? summarizeWorkspaceReminderItems(workspaceId, this.currentItems);
          this.summariesByWorkspaceId[String(workspaceId)] = this.currentSummary;
          this.lastError = null;
        } catch (error) {
          if (isCancelledRequestError(error)) return;
          if (controller.signal.aborted || reminderItemsRefreshTask?.promise !== task) throw createCancelledRequestError("scope-change");
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (reminderItemsRefreshTask?.promise === task) {
            reminderItemsRefreshTask = null;
            this.currentItemsLoading = false;
          } else if (!reminderItemsRefreshTask) {
            this.currentItemsLoading = false;
          }
        }
      })();

      reminderItemsRefreshTask = {
        scopeKey,
        controller,
        promise: task,
      };
      return task;
    },

    /** 将提醒对应的实体回执写入 Client，并从当前工作区视图移除该提醒。 */
    async markItemRead(ctx: ApiRequestContext, item: ReminderItem): Promise<void> {
      const entityType = item.sourceType === "chat" ? "thread" : "orch_instance";
      const entityId = item.sourceType === "chat"
        ? String(item.routeTarget.threadId ?? "").trim()
        : String(item.routeTarget.instanceId ?? "").trim();
      const marker = item.sourceType === "chat"
        ? String(item.ignoreMarker ?? "").trim() || null
        : String(item.routeTarget.instanceId ?? "").trim() || null;
      if (!entityId) return;
      const res = await markReminderRead(ctx, {
        workspaceId: item.workspaceId,
        entityType,
        entityId,
        marker,
      });
      if (!res.ok) throw new Error(res.message);
      if (workspaceIdsReferToSameWorkspace(this.currentWorkspaceId, item.workspaceId)) {
        this.applyCurrentWorkspaceItems(
          item.workspaceId,
          this.currentItems.filter((entry) => entry.id !== item.id),
        );
      }
    },

    /** 批量忽略同一工作区提醒，回执项通过稳定 marker 收口为已读。 */
    async consumeItems(ctx: ApiRequestContext, items: ReminderItem[]): Promise<string[]> {
      const deduped = items.filter((item, index, list) =>
        list.findIndex((candidate) => candidate.id === item.id) === index,
      );
      if (!deduped.length) return [];
      const workspaceId = deduped[0]?.workspaceId;
      if (!workspaceId) return [];
      const scopedItems = deduped.filter((item) => workspaceIdsReferToSameWorkspace(item.workspaceId, workspaceId));
      const res = await ignoreReminderItems(ctx, {
        workspaceId,
        items: scopedItems.map((item) => ({
          reminderId: item.id,
          ignoreMarker: item.ignoreMarker,
        })),
      });
      if (!res.ok) throw new Error(res.message);
      const ignoredIds = new Set((res.ignoredIds ?? []).map((id) => String(id)));
      if (!ignoredIds.size) return [];
      if (workspaceIdsReferToSameWorkspace(this.currentWorkspaceId, workspaceId)) {
        this.applyCurrentWorkspaceItems(
          workspaceId,
          this.currentItems.filter((entry) => !ignoredIds.has(entry.id)),
        );
      }
      return [...ignoredIds];
    },

    async ignoreItems(ctx: ApiRequestContext, items: ReminderItem[]): Promise<string[]> {
      return this.consumeItems(ctx, items);
    },

    reset(): void {
      reminderSummariesRefreshTask?.controller.abort(createCancelledRequestError("clear"));
      reminderItemsRefreshTask?.controller.abort(createCancelledRequestError("clear"));
      reminderSummariesRefreshTask = null;
      reminderItemsRefreshTask = null;
      this.summariesByWorkspaceId = {};
      this.currentWorkspaceId = null;
      this.currentSummary = null;
      this.currentItems = [];
      this.workspaceSummariesLoading = false;
      this.currentItemsLoading = false;
      this.lastError = null;
    },
  },
});

export type ReminderStore = ReturnType<typeof useReminderStore>;
