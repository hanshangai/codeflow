import { defineStore } from "pinia";
import { type EngineCustomModelsByEngine, type EngineStatus, type EngineType } from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";
import { isCancelledRequestError } from "../api/request";
import { getEnginesStatus } from "../api/engines";
import { mergeEngineStatusAfterDetection } from "../utils/engineAvailability";
import { getDesktopBridge, resolveDesktopApiRequest } from "../services/desktop";

export type EngineState = {
  engines: EngineStatus[];
  loading: boolean;
  lastError: string | null;
  lastUpdatedAt: number | null;
  activeWorkspaceId: string;
  customModelsByEngine: EngineCustomModelsByEngine;
  byWorkspaceId: Record<string, EngineWorkspaceState>;
  refreshGenerationByWorkspace: Record<string, number>;
};

export type EngineWorkspaceState = {
  localModels?: boolean;
  engines: EngineStatus[];
  loading: boolean;
  lastError: string | null;
  lastUpdatedAt: number | null;
  customModelsByEngine: EngineCustomModelsByEngine;
};

export type EngineStore = ReturnType<typeof useEngineStore>;

/** 引擎状态：用于模型下拉与能力提示；模型列表统一来自内置模型与 Host 上报。 */
export const useEngineStore = defineStore("engine", {
  state: (): EngineState => ({
    engines: [],
    loading: false,
    lastError: null,
    lastUpdatedAt: null,
    activeWorkspaceId: "",
    customModelsByEngine: {},
    byWorkspaceId: {},
    refreshGenerationByWorkspace: {},
  }),
  getters: {
    byType: (s) => buildEngineTypeMap(s.engines),
    byTypeForWorkspace: (s) => (workspaceId?: string | null) => {
      const key = normalizeEngineWorkspaceKey(workspaceId);
      const scoped = s.byWorkspaceId[key];
      if (scoped) return buildEngineTypeMap(scoped.engines);
      if (s.activeWorkspaceId === key) return buildEngineTypeMap(s.engines);
      return new Map<EngineType, EngineStatus>();
    },
  },
  actions: {
    /** 刷新实际执行端状态；失败保留可见错误态并向调用方抛出。 */
    async refresh(ctx: ApiRequestContext, workspaceId?: string, opts?: { signal?: AbortSignal; shouldApply?: () => boolean }): Promise<void> {
      const key = normalizeEngineWorkspaceKey(workspaceId);
      const localModels = Boolean(getDesktopBridge() && resolveDesktopApiRequest({ method: "GET", path: `/api/engines/status?workspaceId=${encodeURIComponent(key)}` }, ctx.desktopClientId));
      const requestGeneration = (this.refreshGenerationByWorkspace[key] ?? 0) + 1;
      this.refreshGenerationByWorkspace[key] = requestGeneration;
      const previousEngines = this.byWorkspaceId[key]?.engines ?? [];
      this.loading = true;
      this.lastError = null;
      this.byWorkspaceId[key] = {
        localModels,
        engines: previousEngines,
        loading: true,
        lastError: null,
        lastUpdatedAt: this.byWorkspaceId[key]?.lastUpdatedAt ?? null,
        customModelsByEngine: this.byWorkspaceId[key]?.customModelsByEngine ?? {},
      };
      try {
        const res = await getEnginesStatus(ctx, workspaceId, { signal: opts?.signal });
        if (!res.ok) throw new Error(res.message);
        if (this.refreshGenerationByWorkspace[key] !== requestGeneration) return;
        const now = Date.now();
        const previousByType = buildEngineTypeMap(previousEngines);
        const resolvedEngines = res.engines.map((status) =>
          mergeEngineStatusAfterDetection(previousByType.get(status.engineType), status));
        const customModelsByEngine = res.customModelsByEngine ?? {};
        this.byWorkspaceId[key] = {
          localModels,
          engines: resolvedEngines,
          loading: false,
          lastError: null,
          lastUpdatedAt: now,
          customModelsByEngine,
        };
        if (opts?.shouldApply?.() !== false) {
          this.activeWorkspaceId = key;
          this.engines = resolvedEngines;
          this.customModelsByEngine = customModelsByEngine;
          this.lastUpdatedAt = now;
          this.lastError = null;
        }
      } catch (e) {
        if (isCancelledRequestError(e)) return;
        if (this.refreshGenerationByWorkspace[key] !== requestGeneration) return;
        const message = e instanceof Error ? e.message : String(e);
        this.byWorkspaceId[key] = {
          localModels,
          engines: this.byWorkspaceId[key]?.engines ?? [],
          loading: false,
          lastError: message,
          lastUpdatedAt: this.byWorkspaceId[key]?.lastUpdatedAt ?? null,
          customModelsByEngine: this.byWorkspaceId[key]?.customModelsByEngine ?? {},
        };
        if (opts?.shouldApply?.() !== false) this.lastError = message;
        throw e;
      } finally {
        if (this.refreshGenerationByWorkspace[key] === requestGeneration) {
          this.loading = false;
          const scoped = this.byWorkspaceId[key];
          if (scoped?.loading) this.byWorkspaceId[key] = { ...scoped, loading: false };
        }
      }
    },
  },
});

/** 归一化 engine 状态缓存 key；空 workspace 用空串兼容旧调用。 */
function normalizeEngineWorkspaceKey(workspaceId?: string | null): string {
  return String(workspaceId ?? "").trim();
}

/** 将 engine 数组转为按类型索引的只读视图。 */
function buildEngineTypeMap(engines: EngineStatus[]): Map<EngineType, EngineStatus> {
  const map = new Map<EngineType, EngineStatus>();
  for (const engine of engines) map.set(engine.engineType, engine);
  return map;
}
