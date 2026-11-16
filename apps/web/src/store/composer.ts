import { defineStore } from "pinia";
import type { EngineType, TextFileAttachment, ThreadId, WorkspaceId } from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";
import { isCancelledRequestError } from "../api/request";
import { getWorkspacePrefs, saveWorkspacePrefs } from "../api/workspacePrefs";

export type ComposerState = {
  /** 按引擎记忆自动压缩阈值（百分比 50-99，null 表示使用产品默认值 90%）。 */
  autoCompactPctByWorkspaceEngine: Record<string, number | null>;
  /** 每个引擎的上下文窗口覆盖值（token 数）。null = 使用模型默认值。 */
  contextWindowByWorkspaceEngine: Record<string, number | null>;
  /** 外部入口注入到当前 composer 的一次性动作。 */
  externalActions: ComposerExternalAction[];
  externalActionTick: number;
};

export type ComposerExternalAction =
  | {
    id: string;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "append-text";
    text: string;
  }
  | {
    id: string;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "send-text";
    text: string;
  }
  | {
    id: string;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "attach-text-file";
    file: TextFileAttachment;
  };

export type ComposerExternalActionInput =
  | {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "append-text";
    text: string;
  }
  | {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "send-text";
    text: string;
  }
  | {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    kind: "attach-text-file";
    file: TextFileAttachment;
  };

export type ComposerStore = ReturnType<typeof useComposerStore>;

/** Composer 偏好：保存 UI 选择，同时持久化到 Client DB。 */
export const useComposerStore = defineStore("composer", {
  state: (): ComposerState => ({
    autoCompactPctByWorkspaceEngine: {},
    contextWindowByWorkspaceEngine: {},
    externalActions: [],
    externalActionTick: 0,
  }),
  persist: {
    pick: ["autoCompactPctByWorkspaceEngine", "contextWindowByWorkspaceEngine"],
    debug: true,
  },
  actions: {
    /** 设置自动压缩阈值（百分比 50-99，null 表示使用产品默认值 90%）。传入 ctx+workspaceId 时同步写入 DB。 */
    setAutoCompactPct(engine: EngineType, pct: number | null, ctx?: ApiRequestContext, workspaceId?: string) {
      if (!workspaceId) return;
      this.autoCompactPctByWorkspaceEngine[keyOf(workspaceId, engine)] = pct;
      if (ctx && workspaceId) {
        this.saveWorkspacePrefsToDb(ctx, workspaceId, engine);
      }
    },
    /** 设置上下文窗口覆盖值（token 数，null 表示使用模型默认值）。传入 ctx+workspaceId 时同步写入 DB。 */
    setContextWindow(engine: EngineType, value: number | null, ctx?: ApiRequestContext, workspaceId?: string) {
      if (!workspaceId) return;
      this.contextWindowByWorkspaceEngine[keyOf(workspaceId, engine)] = value;
      if (ctx && workspaceId) {
        this.saveWorkspacePrefsToDb(ctx, workspaceId, engine);
      }
    },
    getAutoCompactPct(workspaceId: string, engine: EngineType): number | null {
      return this.autoCompactPctByWorkspaceEngine[keyOf(workspaceId, engine)] ?? null;
    },
    getContextWindow(workspaceId: string, engine: EngineType): number | null {
      return this.contextWindowByWorkspaceEngine[keyOf(workspaceId, engine)] ?? null;
    },
    enqueueExternalAction(action: ComposerExternalActionInput): string {
      const id = `composer_action_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      this.externalActions.push({ ...action, id });
      this.externalActionTick += 1;
      return id;
    },
    consumeExternalActions(workspaceId: WorkspaceId, threadId: ThreadId): ComposerExternalAction[] {
      if (!workspaceId || !threadId || !this.externalActions.length) return [];
      const matched: ComposerExternalAction[] = [];
      const remaining: ComposerExternalAction[] = [];
      for (const action of this.externalActions) {
        if (action.workspaceId === workspaceId && action.threadId === threadId) matched.push(action);
        else remaining.push(action);
      }
      if (matched.length) this.externalActions = remaining;
      return matched;
    },

    // ── 工作区级 prefs 持久化 ────────────────────────────

    /** 从 DB 加载工作区级偏好（contextWindow / autoCompactPct）。 */
    async loadWorkspacePrefs(
      ctx: ApiRequestContext,
      workspaceId: string,
      opts?: { signal?: AbortSignal },
    ): Promise<void> {
      try {
        const res = await getWorkspacePrefs(ctx, workspaceId, { signal: opts?.signal });
        if (!res.ok) return;
        const seenEngines = new Set<EngineType>();
        for (const p of res.prefs) {
          const eng = p.engine as EngineType;
          seenEngines.add(eng);
          this.contextWindowByWorkspaceEngine[keyOf(workspaceId, eng)] = "contextWindow" in p ? (p.contextWindow ?? null) : null;
          this.autoCompactPctByWorkspaceEngine[keyOf(workspaceId, eng)] = "autoCompactPct" in p ? (p.autoCompactPct ?? null) : null;
        }
        for (const engine of ["claude", "codex"] as EngineType[]) {
          if (seenEngines.has(engine)) continue;
          this.contextWindowByWorkspaceEngine[keyOf(workspaceId, engine)] = null;
          this.autoCompactPctByWorkspaceEngine[keyOf(workspaceId, engine)] = null;
        }
      } catch (error) {
        if (isCancelledRequestError(error)) return;
        throw error;
      }
    },

    /** 保存引擎级偏好到 DB（fire-and-forget）。 */
    saveWorkspacePrefsToDb(ctx: ApiRequestContext, workspaceId: string, engine: EngineType): void {
      void saveWorkspacePrefs(ctx, {
        workspaceId: workspaceId as WorkspaceId,
        prefs: [{
          engine,
          workMode: "general",
          contextWindow: this.getContextWindow(workspaceId, engine),
          autoCompactPct: this.getAutoCompactPct(workspaceId, engine),
        }],
      });
    },
  },
});

function keyOf(workspaceId: string, engine: EngineType): string {
  return `${String(workspaceId ?? "").trim()}::${engine}`;
}

