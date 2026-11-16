import { onScopeDispose, ref, watch, type Ref } from "vue";

import type { OrchAssetType, OrchBuiltinAssetCatalogItem } from "@codeflowai/shared";

import { listBuiltinOrchAssets } from "../../../api/orchestration";
import { createApiResultError, isApiResultError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { createBrowserUuid } from "../../../utils/browserUuid";

export type BuiltinAssetLibrary = {
  /** 已成功读取的内置资产，按类型缓存。 */
  itemsByType: Ref<Partial<Record<OrchAssetType, OrchBuiltinAssetCatalogItem[]>>>;
  loadingByType: Ref<Partial<Record<OrchAssetType, boolean>>>;
  /** 已显式暴露给预览面板的失败原因，空串表示当前无失败。 */
  errorByType: Ref<Partial<Record<OrchAssetType, string>>>;
  ensureTypeLoaded: (assetType: OrchAssetType) => Promise<void>;
  retry: (assetType: OrchAssetType) => Promise<void>;
};

/**
 * 无工作区只读预览专用的内置资产读取器：只调用只读接口，不接触编排 store，也不触发任何写操作。
 */
export function useBuiltinAssetLibrary(): BuiltinAssetLibrary {
  const { ctx } = useApiContext();
  const config = useConfigStore();
  const itemsByType = ref<Partial<Record<OrchAssetType, OrchBuiltinAssetCatalogItem[]>>>({});
  const loadingByType = ref<Partial<Record<OrchAssetType, boolean>>>({});
  const errorByType = ref<Partial<Record<OrchAssetType, string>>>({});
  const loadPromises = new Map<OrchAssetType, Promise<void>>();
  const requestedTypes = new Set<OrchAssetType>();
  let scopeGeneration = 0;

  watch(() => config.isDesktop
    ? JSON.stringify(["local", config.localRuntimeReady, config.desktopClient?.clientId, config.desktopRuntime?.requestId])
    : JSON.stringify(["account", config.serverWsOrigin, config.userSummary?.userId, config.hasActiveSession]), () => {
    scopeGeneration += 1;
    itemsByType.value = {};
    loadingByType.value = {};
    errorByType.value = {};
    loadPromises.clear();
    for (const assetType of requestedTypes) void ensureTypeLoaded(assetType);
  }, { flush: "sync" });
  onScopeDispose(() => { scopeGeneration += 1; loadPromises.clear(); });

  /** 读取一类内置资产；失败写入 errorByType 由预览面板显式呈现，不静默吞掉。 */
  async function loadType(assetType: OrchAssetType): Promise<void> {
    const generation = scopeGeneration;
    const requestContext = { ...ctx.value };
    const desktop = config.isDesktop;
    const userId = desktop ? undefined : config.userSummary?.userId;
    const runtimeId = config.desktopRuntime?.requestId;
    const requestId = `builtin-assets-${createBrowserUuid()}`;
    loadingByType.value = { ...loadingByType.value, [assetType]: true };
    errorByType.value = { ...errorByType.value, [assetType]: "" };
    try {
      // 浏览器没有本机 Client；无在线工作区时不再回落 Server 内置资产目录。
      if (!desktop) {
        const message = config.hasActiveSession
          ? "请先选择工作区查看内置资产"
          : "没有在线工作区，无法查看内置资产";
        throw Object.assign(new Error(message), { code: "BUILTIN_ASSET_WORKSPACE_REQUIRED" });
      }
      if (!config.localRuntimeReady) throw Object.assign(new Error("本机运行时尚未就绪，请稍候重试。"), { code: "DESKTOP_RUNTIME_NOT_READY" });
      const res = await listBuiltinOrchAssets(requestContext, assetType);
      if (!res.ok) throw createApiResultError(res);
      if (generation !== scopeGeneration) return;
      itemsByType.value = { ...itemsByType.value, [assetType]: res.items };
    } catch (error) {
      const details = isApiResultError(error) ? error.details as { requestId?: unknown } | undefined : undefined;
      console.error("[builtin-assets.load-failed]", {
        code: isApiResultError(error) ? error.code : error instanceof Error && "code" in error ? String(error.code) : "BUILTIN_ASSET_LOAD_FAILED",
        requestId: typeof details?.requestId === "string" ? details.requestId : requestId,
        assetType, scope: desktop ? "local" : "account", desktopClientId: requestContext.desktopClientId,
        runtimeId, userId, serverOrigin: desktop ? undefined : requestContext.serverWsOrigin,
        rootCause: error instanceof Error ? error.message : String(error),
      });
      if (generation === scopeGeneration) errorByType.value = {
        ...errorByType.value,
        [assetType]: error instanceof Error && error.message.trim()
          ? error.message
          : "内置资产加载失败，请重试。",
      };
    } finally {
      if (generation === scopeGeneration) loadingByType.value = { ...loadingByType.value, [assetType]: false };
    }
  }

  /** 首次进入某类型时才发起读取；同类型已在途则复用同一个 Promise。 */
  function ensureTypeLoaded(assetType: OrchAssetType): Promise<void> {
    requestedTypes.add(assetType);
    if (itemsByType.value[assetType]) return Promise.resolve();
    const existing = loadPromises.get(assetType);
    if (existing) return existing;
    const pending = loadType(assetType).finally(() => { if (loadPromises.get(assetType) === pending) loadPromises.delete(assetType); });
    loadPromises.set(assetType, pending);
    return pending;
  }

  /** 清掉上次失败原因后重新读取同一类型。 */
  function retry(assetType: OrchAssetType): Promise<void> {
    errorByType.value = { ...errorByType.value, [assetType]: "" };
    return ensureTypeLoaded(assetType);
  }

  return { itemsByType, loadingByType, errorByType, ensureTypeLoaded, retry };
}
