import { defineStore } from "pinia";
import {
  cloneEngineModelCatalogSnapshot,
  engineModelCatalogRowsToModelInfo,
  mergeEngineModelsWithCustomModels,
  type EngineCustomModelsByEngine,
  type EngineModelCatalogSnapshot,
  type EngineModelCatalogSyncState,
  type EngineStatus,
  type EngineType,
} from "@codeflowai/shared";

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
  catalog: EngineModelCatalogSnapshot | null;
  catalogVersion: number | null;
  hostAppliedCatalogVersion: number | null;
  hostCatalogSyncState: EngineModelCatalogSyncState | null;
  refreshGenerationByWorkspace: Record<string, number>;
};

export type EngineWorkspaceState = {
  localModels?: boolean;
  engines: EngineStatus[];
  loading: boolean;
  lastError: string | null;
  lastUpdatedAt: number | null;
  catalogVersion: number | null;
  hostAppliedCatalogVersion: number | null;
  hostCatalogSyncState: EngineModelCatalogSyncState | null;
  customModelsByEngine: EngineCustomModelsByEngine;
};

export type EngineStore = ReturnType<typeof useEngineStore>;

/** 引擎状态：用于模型下拉与能力提示。 */
export const useEngineStore = defineStore("engine", {
  state: (): EngineState => ({
    engines: [],
    loading: false,
    lastError: null,
    lastUpdatedAt: null,
    activeWorkspaceId: "",
    customModelsByEngine: {},
    byWorkspaceId: {},
    catalog: null,
    catalogVersion: null,
    hostAppliedCatalogVersion: null,
    hostCatalogSyncState: null,
    refreshGenerationByWorkspace: {},
  }),
  getters: {
    byType: (s) => {
      return buildEngineTypeMap(s.engines);
    },
    byTypeForWorkspace: (s) => (workspaceId?: string | null) => {
      const key = normalizeEngineWorkspaceKey(workspaceId);
      const scoped = s.byWorkspaceId[key];
      if (scoped) return buildEngineTypeMap(scoped.engines);
      if (s.activeWorkspaceId === key) return buildEngineTypeMap(s.engines);
      return new Map<EngineType, EngineStatus>();
    },
  },
  actions: {
    /** 刷新实际执行端目录；失败保留可见错误态并向调用方抛出。 */
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
        catalogVersion: this.byWorkspaceId[key]?.catalogVersion ?? (localModels ? null : this.catalog?.configVersion) ?? null,
        hostAppliedCatalogVersion: this.byWorkspaceId[key]?.hostAppliedCatalogVersion ?? null,
        hostCatalogSyncState: this.byWorkspaceId[key]?.hostCatalogSyncState ?? null,
        customModelsByEngine: this.byWorkspaceId[key]?.customModelsByEngine ?? {},
      };
      try {
        const res = await getEnginesStatus(ctx, workspaceId, { signal: opts?.signal });
        if (!res.ok) throw new Error(res.message);
        if (this.refreshGenerationByWorkspace[key] !== requestGeneration) return;
        const now = Date.now();
        const previousByType = buildEngineTypeMap(previousEngines);
        let resolvedEngines = res.engines.map((status) =>
          mergeEngineStatusAfterDetection(previousByType.get(status.engineType), status));
        const responseVersion = res.catalogVersion ?? null;
        const currentCatalog = localModels ? null : this.catalog;
        const customModelsByEngine = res.customModelsByEngine ?? {};
        const responsePredatesCatalog = Boolean(
          currentCatalog && (responseVersion == null || responseVersion < currentCatalog.configVersion),
        );
        if (currentCatalog && (responseVersion == null || responseVersion <= currentCatalog.configVersion)) {
          resolvedEngines = replaceEngineModels(resolvedEngines, currentCatalog, customModelsByEngine);
        }
        const catalogVersion = responsePredatesCatalog
          ? currentCatalog!.configVersion
          : responseVersion ?? currentCatalog?.configVersion ?? null;
        const hostAppliedCatalogVersion = res.hostAppliedCatalogVersion ?? null;
        const hostCatalogSyncState = responsePredatesCatalog
          ? res.hostCatalogSyncState === "offline" || res.hostCatalogSyncState === "unsupported"
            ? res.hostCatalogSyncState
            : hostAppliedCatalogVersion === currentCatalog!.configVersion
              ? "applied"
              : "waiting"
          : res.hostCatalogSyncState ?? null;
        this.byWorkspaceId[key] = {
          localModels,
          engines: resolvedEngines,
          loading: false,
          lastError: null,
          lastUpdatedAt: now,
          catalogVersion,
          hostAppliedCatalogVersion,
          hostCatalogSyncState,
          customModelsByEngine,
        };
        if (opts?.shouldApply?.() !== false) {
          this.activeWorkspaceId = key;
          this.engines = resolvedEngines;
          this.customModelsByEngine = customModelsByEngine;
          this.lastUpdatedAt = now;
          this.lastError = null;
          this.catalogVersion = catalogVersion;
          this.hostAppliedCatalogVersion = hostAppliedCatalogVersion;
          this.hostCatalogSyncState = hostCatalogSyncState;
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
          catalogVersion: this.byWorkspaceId[key]?.catalogVersion ?? (localModels ? null : this.catalog?.configVersion) ?? null,
          hostAppliedCatalogVersion: this.byWorkspaceId[key]?.hostAppliedCatalogVersion ?? null,
          hostCatalogSyncState: this.byWorkspaceId[key]?.hostCatalogSyncState ?? null,
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
    /** 应用 Server 目录到远程工作区；本机模型保持 Client 返回的有效目录。 */
    applyCatalog(value: unknown): void {
      const catalog = cloneEngineModelCatalogSnapshot(value);
      if (this.catalog && catalog.configVersion < this.catalog.configVersion) return;
      this.catalog = catalog;
      if (!this.byWorkspaceId[this.activeWorkspaceId]?.localModels) {
        this.catalogVersion = catalog.configVersion;
        this.engines = replaceEngineModels(this.engines, catalog, this.customModelsByEngine);
      }
      for (const [workspaceId, state] of Object.entries(this.byWorkspaceId)) {
        if (state.localModels) continue;
        this.byWorkspaceId[workspaceId] = {
          ...state,
          engines: replaceEngineModels(state.engines, catalog, state.customModelsByEngine),
          catalogVersion: catalog.configVersion,
          hostCatalogSyncState: state.hostCatalogSyncState === "offline" || state.hostCatalogSyncState === "unsupported"
            ? state.hostCatalogSyncState
            : state.hostAppliedCatalogVersion === catalog.configVersion
              ? "applied"
              : "waiting",
        };
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

/** 用全局目录重建模型列表，并追加当前工作区明确返回的本地自定义模型。 */
function replaceEngineModels(
  engines: EngineStatus[],
  catalog: EngineModelCatalogSnapshot,
  customModelsByEngine: EngineCustomModelsByEngine,
): EngineStatus[] {
  return engines.map((engine) => ({
    ...engine,
    models: mergeEngineModelsWithCustomModels(
      engine.engineType,
      engineModelCatalogRowsToModelInfo(catalog.rows, engine.engineType),
      customModelsByEngine[engine.engineType],
    ),
  }));
}


