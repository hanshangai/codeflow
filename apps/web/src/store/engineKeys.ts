import { defineStore } from "pinia";
import { normalizeEngineKeyProviderId, type EngineKeyEntry, type EngineType } from "@codeflowai/shared";

import { listEngineKeys } from "../api/engineKeys";
import { createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../api/request";

export type EngineKeysScopePhase = "unknown" | "loading" | "success" | "error";

export type EngineKeysScopeSnapshot = {
  workspaceId: string;
  phase: EngineKeysScopePhase;
  keys: EngineKeyEntry[];
  lastError: string | null;
  lastUpdatedAt: number | null;
  requestId: number;
};

export type EngineKeysState = {
  keys: EngineKeyEntry[];
  loading: boolean;
  lastError: string | null;
  lastUpdatedAt: number | null;
  activeWorkspaceId: string | null;
  latestRequestId: number;
  scopeByWorkspaceId: Record<string, EngineKeysScopeSnapshot>;
};

export type EngineKeysListLoader = typeof listEngineKeys;

/** 返回一个未请求过的工作区快照，避免调用方复用其它工作区数据。 */
export function createUnknownEngineKeysScope(workspaceId: string): EngineKeysScopeSnapshot {
  return { workspaceId, phase: "unknown", keys: [], lastError: null, lastUpdatedAt: null, requestId: 0 };
}

/** 执行工作区作用域刷新；只有最新请求且会话所有者仍有效时提交。 */
export async function refreshEngineKeysScope(
  state: EngineKeysState,
  ctx: ApiRequestContext,
  workspaceId: string | undefined,
  loader: EngineKeysListLoader = listEngineKeys,
  shouldApply?: () => boolean,
): Promise<void> {
  if (shouldApply && !shouldApply()) throw createCancelledRequestError("scope-change");
  const targetWorkspaceId = String(workspaceId ?? "").trim();
  if (!targetWorkspaceId) {
    state.activeWorkspaceId = null;
    projectActiveScope(state);
    return;
  }

  const previousWorkspaceId = state.activeWorkspaceId;
  if (previousWorkspaceId && previousWorkspaceId !== targetWorkspaceId) {
    const previousScope = state.scopeByWorkspaceId[previousWorkspaceId];
    if (previousScope?.phase === "loading") writeScope(state, createUnknownEngineKeysScope(previousWorkspaceId));
  }

  const requestId = ++state.latestRequestId;
  // 保留同工作区上次成功结果作为缓存，刷新期间列表不闪空、不重放首次加载态。
  const cachedScope = state.scopeByWorkspaceId[targetWorkspaceId];
  state.activeWorkspaceId = targetWorkspaceId;
  writeScope(state, {
    workspaceId: targetWorkspaceId,
    phase: "loading",
    keys: cachedScope?.phase === "success" ? cachedScope.keys : [],
    lastError: null,
    lastUpdatedAt: cachedScope?.phase === "success" ? cachedScope.lastUpdatedAt : null,
    requestId,
  });
  projectActiveScope(state);

  try {
    const res = await loader(ctx, targetWorkspaceId);
    if (requestId !== state.latestRequestId || state.activeWorkspaceId !== targetWorkspaceId) return;
    if (shouldApply && !shouldApply()) {
      writeScope(state, createUnknownEngineKeysScope(targetWorkspaceId));
      projectActiveScope(state);
      throw createCancelledRequestError("scope-change");
    }
    if (!res.ok) throw new Error((res as { message?: string }).message ?? "读取 Key 列表失败");
    writeScope(state, {
      workspaceId: targetWorkspaceId,
      phase: "success",
      keys: res.keys,
      lastError: null,
      lastUpdatedAt: Date.now(),
      requestId,
    });
    projectActiveScope(state);
  } catch (error) {
    if (requestId !== state.latestRequestId || state.activeWorkspaceId !== targetWorkspaceId) return;
    if (shouldApply && !shouldApply()) {
      writeScope(state, createUnknownEngineKeysScope(targetWorkspaceId));
      projectActiveScope(state);
      throw error;
    }
    if (isCancelledRequestError(error)) {
      writeScope(state, createUnknownEngineKeysScope(targetWorkspaceId));
      projectActiveScope(state);
      return;
    }
    const lastError = error instanceof Error ? error.message : String(error);
    writeScope(state, {
      workspaceId: targetWorkspaceId,
      phase: "error",
      keys: [],
      lastError,
      lastUpdatedAt: null,
      requestId,
    });
    projectActiveScope(state);
    throw error;
  }
}

function writeScope(state: EngineKeysState, snapshot: EngineKeysScopeSnapshot): void {
  state.scopeByWorkspaceId = { ...state.scopeByWorkspaceId, [snapshot.workspaceId]: snapshot };
}

function projectActiveScope(state: EngineKeysState): void {
  const scope = state.activeWorkspaceId
    ? (state.scopeByWorkspaceId[state.activeWorkspaceId] ?? createUnknownEngineKeysScope(state.activeWorkspaceId))
    : null;
  state.keys = scope?.keys ?? [];
  state.loading = scope?.phase === "loading";
  state.lastError = scope?.lastError ?? null;
  state.lastUpdatedAt = scope?.lastUpdatedAt ?? null;
}

/** 大模型 Key 状态：给设置页和模型选择共用同一份 provider 可用性。 */
export const useEngineKeysStore = defineStore("engineKeys", {
  state: (): EngineKeysState => ({
    keys: [],
    loading: false,
    lastError: null,
    lastUpdatedAt: null,
    activeWorkspaceId: null,
    latestRequestId: 0,
    scopeByWorkspaceId: {},
  }),
  getters: {
    hasAnyKeys: (state): boolean => state.keys.length > 0,
    hasKeysForEngine: (state) => (engine: EngineType): boolean => state.keys.some((key) => key.engine === engine),
    scopeSnapshotForWorkspace: (state) => (workspaceId: string | null | undefined): EngineKeysScopeSnapshot => {
      const normalizedWorkspaceId = String(workspaceId ?? "").trim();
      if (!normalizedWorkspaceId) return createUnknownEngineKeysScope("");
      return state.scopeByWorkspaceId[normalizedWorkspaceId] ?? createUnknownEngineKeysScope(normalizedWorkspaceId);
    },
    hasActiveKeyForWorkspace(): (workspaceId: string | null | undefined) => boolean {
      return (workspaceId): boolean => {
        const scope = this.scopeSnapshotForWorkspace(workspaceId);
        return scope.phase === "success" && scope.keys.some((key) => key.isActive);
      };
    },
    /** 当前已启用默认 Key 的供应商列表。 */
    providerIdsForEngine: (state) => (engine: EngineType): string[] => {
      const ids = new Set<string>();
      for (const key of state.keys) {
        if (key.engine !== engine || !key.isActive) continue;
        const providerId = normalizeEngineKeyProviderId(engine, key.providerId);
        if (providerId) ids.add(providerId);
      }
      return [...ids];
    },
  },
  actions: {
    /** 刷新 Key 列表；调用方可附加账号所有者栅栏。 */
    async refresh(ctx: ApiRequestContext, workspaceId?: string, shouldApply?: () => boolean): Promise<void> {
      await refreshEngineKeysScope(this, ctx, workspaceId, listEngineKeys, shouldApply);
    },
  },
});
