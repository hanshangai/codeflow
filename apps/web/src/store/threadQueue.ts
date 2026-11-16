import { defineStore } from "pinia";
import { message } from "ant-design-vue";
import type {
  ThreadId,
  ThreadMessageQueueItem,
  ThreadQueueAppendRequestBody,
  ThreadQueuePauseReason,
  ThreadQueueSendOptions,
  ThreadQueueSnapshot,
  ThreadQueueState,
  WorkspaceId,
} from "@codeflowai/shared";

import { createApiResultError, type ApiRequestContext } from "../api/request";
import {
  appendThreadQueueItem,
  clearThreadQueue,
  listThreadQueue,
  moveThreadQueueItem,
  pauseThreadQueue,
  removeThreadQueueItem,
  resumeThreadQueue,
} from "../api/threads-queue";

type ThreadQueueSlot = {
  items: ThreadMessageQueueItem[];
  state: ThreadQueueState;
  loading: boolean;
  error: string | null;
};

const queueRefreshInFlight = new Map<string, Promise<void>>();
const queueRefreshQueued = new Set<string>();

/** 为同一 workspace/thread 生成刷新合并键。 */
function queueRefreshKey(workspaceId: WorkspaceId, threadId: ThreadId): string {
  return `${String(workspaceId)}\u0000${String(threadId)}`;
}

function defaultState(threadId: ThreadId): ThreadQueueState {
  return {
    threadId,
    workspaceId: "" as WorkspaceId,
    paused: false,
    pausedReason: null,
    pausedAt: null,
    lastConsumedQueueId: null,
    lastConsumedTurnId: null,
  };
}

function defaultSlot(threadId: ThreadId): ThreadQueueSlot {
  return { items: [], state: defaultState(threadId), loading: false, error: null };
}

/**
 * 队列状态在前端按 thread 切片：
 * - chip 与 panel 都从这里读 itemCountFor / pausedFor
 * - ws 事件 thread.queue.changed 触发主动 refresh
 * - 写操作（append/move/remove/clear/resume/pause）通过 actions 走 API
 */
export const useThreadQueueStore = defineStore("threadQueue", {
  state: () => ({
    byThreadId: {} as Record<string, ThreadQueueSlot>,
  }),
  getters: {
    /** 当前活跃项数（pending + sending）。 */
    itemCountFor: (state) => (threadId: ThreadId): number => {
      return state.byThreadId[String(threadId)]?.items.length ?? 0;
    },
    pausedFor: (state) => (threadId: ThreadId): boolean => {
      return state.byThreadId[String(threadId)]?.state.paused ?? false;
    },
    pausedReasonFor: (state) => (threadId: ThreadId): ThreadQueuePauseReason | null => {
      return state.byThreadId[String(threadId)]?.state.pausedReason ?? null;
    },
    itemsFor: (state) => (threadId: ThreadId): ThreadMessageQueueItem[] => {
      return state.byThreadId[String(threadId)]?.items ?? [];
    },
    snapshotFor: (state) => (threadId: ThreadId): ThreadQueueSnapshot => {
      const slot = state.byThreadId[String(threadId)];
      if (!slot) return { state: defaultState(threadId), items: [] };
      return { state: slot.state, items: slot.items };
    },
  },
  actions: {
    ensureSlot(threadId: ThreadId): ThreadQueueSlot {
      const key = String(threadId);
      if (!this.byThreadId[key]) {
        this.byThreadId[key] = defaultSlot(threadId);
      }
      return this.byThreadId[key];
    },

    /** 合并队列快照刷新；失败保留旧数据，并交给调用边界显式上报。 */
    async refresh(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId): Promise<void> {
      const refreshKey = queueRefreshKey(workspaceId, threadId);
      const existing = queueRefreshInFlight.get(refreshKey);
      if (existing) {
        queueRefreshQueued.add(refreshKey);
        return existing;
      }

      const slot = this.ensureSlot(threadId);
      const refreshPromise = (async () => {
        try {
          do {
            queueRefreshQueued.delete(refreshKey);
            slot.loading = true;
            slot.error = null;
            const result = await listThreadQueue(ctx, { workspaceId, threadId });
            if (!result.ok) {
              slot.error = result.message;
              throw createApiResultError(result);
            } else {
              // ApiOk<T> = { ok: true } & T —— T 字段直接展开在 result 上，不存在 .data 包装层
              slot.items = result.items ?? [];
              slot.state = result.state ?? defaultState(threadId);
            }
          } while (queueRefreshQueued.has(refreshKey));
        } finally {
          slot.loading = false;
          queueRefreshInFlight.delete(refreshKey);
          queueRefreshQueued.delete(refreshKey);
        }
      })();
      queueRefreshInFlight.set(refreshKey, refreshPromise);
      return refreshPromise;
    },

    /** 入队（按方案要求：运行中或队列非空时所有 send 走入队）。 */
    async append(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      payload: {
        text: string;
        inputKind?: ThreadMessageQueueItem["inputKind"];
        skillMentions?: ThreadMessageQueueItem["skillMentions"];
        images: ThreadMessageQueueItem["images"];
        files: ThreadMessageQueueItem["files"];
        pathReferences: ThreadMessageQueueItem["pathReferences"];
        sendOptions: ThreadQueueSendOptions;
        clientItemId?: string;
      },
    ): Promise<void> {
      const body: ThreadQueueAppendRequestBody = {
        workspaceId,
        threadId,
        text: payload.text,
        ...(payload.inputKind ? { inputKind: payload.inputKind } : {}),
        ...(payload.skillMentions?.length
          ? { skillMentions: payload.skillMentions.map((binding) => ({ ...binding })) }
          : {}),
        images: payload.images,
        files: payload.files,
        pathReferences: payload.pathReferences,
        sendOptions: payload.sendOptions,
        clientItemId: payload.clientItemId,
      };
      const result = await appendThreadQueueItem(ctx, body);
      if (!result.ok) {
        throw createApiResultError(result);
      }
      // 乐观更新：把 item 添加到本地末尾；ws.thread.queue.changed 也会触发 refresh 拉权威态
      // 幂等 ack（idempotent=true）时 server 不广播，本地也不重复 push 同 id 项
      const slot = this.ensureSlot(threadId);
      const item = result.item;
      if (item) {
        const exists = slot.items.some((it) => it.id === item.id);
        if (!exists) slot.items = [...slot.items, item];
      }
    },

    async moveUp(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId, queueItemId: string): Promise<void> {
      const result = await moveThreadQueueItem(ctx, { workspaceId, threadId, queueItemId, direction: "up" });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      const slot = this.ensureSlot(threadId);
      slot.items = result.items ?? slot.items;
    },

    async moveDown(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId, queueItemId: string): Promise<void> {
      const result = await moveThreadQueueItem(ctx, { workspaceId, threadId, queueItemId, direction: "down" });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      const slot = this.ensureSlot(threadId);
      slot.items = result.items ?? slot.items;
    },

    async remove(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId, queueItemId: string): Promise<void> {
      const result = await removeThreadQueueItem(ctx, { workspaceId, threadId, queueItemId });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      // 乐观删除；以 ws 推送拉来的快照为准
      const slot = this.ensureSlot(threadId);
      slot.items = slot.items.filter((it) => it.id !== queueItemId);
    },

    /** 清空 pending 项后立即拉权威快照，保留可能仍在发送的队列项展示。 */
    async clear(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId): Promise<void> {
      const result = await clearThreadQueue(ctx, { workspaceId, threadId });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      await this.refresh(ctx, workspaceId, threadId);
    },

    async resume(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId): Promise<void> {
      const result = await resumeThreadQueue(ctx, { workspaceId, threadId });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      const slot = this.ensureSlot(threadId);
      slot.items = result.items ?? slot.items;
      slot.state = result.state ?? slot.state;
    },

    async pause(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      threadId: ThreadId,
      reason?: ThreadQueuePauseReason,
    ): Promise<void> {
      const result = await pauseThreadQueue(ctx, { workspaceId, threadId, reason });
      if (!result.ok) {
        message.error(result.message);
        return;
      }
      const slot = this.ensureSlot(threadId);
      slot.state = { ...slot.state, paused: true, pausedReason: reason ?? slot.state.pausedReason };
    },

    /** 收到 thread.queue.changed ws 推送时主动拉新快照。 */
    async ingestServerEvent(ctx: ApiRequestContext, workspaceId: WorkspaceId, threadId: ThreadId): Promise<void> {
      await this.refresh(ctx, workspaceId, threadId);
    },

    /** 切 thread / 切 workspace 时清理本地切片，避免显示旧数据。 */
    resetThread(threadId: ThreadId): void {
      delete this.byThreadId[String(threadId)];
    },
  },
});
