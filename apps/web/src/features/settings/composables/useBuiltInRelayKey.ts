import type { EngineKeyEntry, EngineModelProviderId, EngineType, RelayProviderId } from "@codeflowai/shared";
import { resolveBuiltInRelayBaseUrl } from "@codeflowai/shared";

import { ensureMyRelayKey, getMyRelayKeyStatus } from "../../../api/account";
import { activateEngineKey, upsertEngineKey } from "../../../api/engineKeys";
import { createApiResultError, createCancelledRequestError, wsOriginToHttpOrigin, type ApiRequestContext } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { useConfigStore } from "../../../store/config";
import { isDesktopWorkspace, requestDesktopApi } from "../../../services/desktop";

export type BuiltInRelayTarget = {
  engine: EngineType;
  providerId: EngineModelProviderId;
  label: string;
};

export type BuiltInRelayAvailability = {
  available: boolean;
  message: string;
  publicBaseUrl?: string;
  providerGroupsConfigured?: Partial<Record<RelayProviderId, boolean>>;
};

export type BuiltInRelaySyncOptions = {
  intent?: "manual" | "auto" | "reset";
  /** 用户确认后，先停止普通 Codex 回合再激活内置中转 Key。 */
  stopRunningTurns?: boolean;
};

export const ANTHROPIC_RELAY_TARGET: BuiltInRelayTarget = { engine: "claude", providerId: "anthropic", label: "Claude" };
export const DEEPSEEK_RELAY_TARGET: BuiltInRelayTarget = { engine: "claude", providerId: "deepseek", label: "DeepSeek" };
export const MOONSHOT_RELAY_TARGET: BuiltInRelayTarget = { engine: "claude", providerId: "moonshot", label: "Moonshot / Kimi" };
export const QWEN_RELAY_TARGET: BuiltInRelayTarget = { engine: "claude", providerId: "qwen", label: "Qwen" };
export const ZAI_RELAY_TARGET: BuiltInRelayTarget = { engine: "claude", providerId: "zai", label: "Z.AI" };
export const CODEX_RELAY_TARGET: BuiltInRelayTarget = { engine: "codex", providerId: "openai", label: "Codex" };
const BUILT_IN_RELAY_AVAILABILITY_CACHE_TTL_MS = 60_000;
const builtInRelayAvailabilityCache = new Map<string, { value: BuiltInRelayAvailability; updatedAt: number }>();

// 实现已上移到 packages/shared（Server 签发与 Client 落地需共用同一份口径），此处保持原导出路径不变。
export { resolveBuiltInRelayBaseUrl };

/** 按账号会话隔离内置中转状态缓存，避免不同登录态互相复用。 */
function resolveBuiltInRelayAvailabilityCacheKey(input: { serverWsOrigin: string; webSessionId: string | null; sessionToken: string | null }): string | null {
  const origin = String(input.serverWsOrigin ?? "").trim();
  const webSessionId = String(input.webSessionId ?? "").trim();
  return origin && input.sessionToken ? JSON.stringify([origin, webSessionId, input.sessionToken]) : null;
}

/** 写入短 TTL 状态缓存；缓存不包含 raw key。 */
function writeBuiltInRelayAvailabilityCache(cacheKey: string | null, value: BuiltInRelayAvailability): void {
  if (!cacheKey) return;
  builtInRelayAvailabilityCache.set(cacheKey, {
    value: { ...value, providerGroupsConfigured: { ...(value.providerGroupsConfigured ?? {}) } },
    updatedAt: Date.now(),
  });
}

/** 提供 CodeFlow 内置中转 Key 的查找、创建与激活能力。 */
export function useBuiltInRelayKey() {
  const { ctx } = useApiContext();
  const engineKeys = useEngineKeysStore();
  const config = useConfigStore();

  /** 捕获会话所有者与关联代际；迟到请求不得借用新账号继续写入。 */
  function captureScope(workspaceId?: string, shouldApply?: () => boolean) {
    const origin = config.serverWsOrigin;
    const token = config.sessionToken;
    const userId = config.userSummary?.userId;
    const generation = config.desktopCloudAccount?.generation;
    const requestContext: ApiRequestContext = { ...ctx.value, ensureSession: async () => {
      assertCurrent();
      if (!token) throw new Error("请先登录账号");
      return token;
    }, clearSession: () => { if (isCurrent()) config.expireCurrentSession(); } };
    const isCurrent = () => config.serverWsOrigin === origin && config.sessionToken === token
      && config.userSummary?.userId === userId && !config.logoutInProgress
      && (!config.isDesktop || config.desktopCloudAccount?.generation === generation)
      && (shouldApply ? shouldApply() : !workspaceId || config.workspaceId === workspaceId);
    /** 作用域取消沿既有取消类型传播，调用方不得宣称启用成功。 */
    function assertCurrent(): void { if (!isCurrent()) throw createCancelledRequestError("scope-change"); }
    return { requestContext, generation, assertCurrent, isCurrent };
  }

  /** 桌面内置 Key 必须取得 Client 真实认证资格，本机 ready 不授权。 */
  function assertDesktopAccount(): void {
    if (config.isDesktop && !config.desktopCloudAccountLinked) throw new Error("DESKTOP_CLOUD_ACCOUNT_REQUIRED");
  }

  /** 读取当前账号会话的短 TTL 内置中转状态缓存。 */
  function getCachedBuiltInRelayAvailability(): BuiltInRelayAvailability | null {
    if (config.isDesktop && !config.desktopCloudAccountLinked) return null;
    const cacheKey = resolveBuiltInRelayAvailabilityCacheKey(ctx.value);
    if (!cacheKey) return null;
    const cached = builtInRelayAvailabilityCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.updatedAt > BUILT_IN_RELAY_AVAILABILITY_CACHE_TTL_MS) {
      builtInRelayAvailabilityCache.delete(cacheKey);
      return null;
    }
    return { ...cached.value, providerGroupsConfigured: { ...(cached.value.providerGroupsConfigured ?? {}) } };
  }

  /** 查询当前账号是否可使用内置中转；只读状态，不创建 key。 */
  async function getBuiltInRelayAvailability(): Promise<BuiltInRelayAvailability> {
    assertDesktopAccount();
    const scope = captureScope();
    const cacheKey = resolveBuiltInRelayAvailabilityCacheKey(scope.requestContext);
    const result = await getMyRelayKeyStatus(scope.requestContext);
    scope.assertCurrent();
    if (!result.ok) {
      throw createApiResultError(result);
    }
    const providerGroupsConfigured = result.status.providerGroupsConfigured ?? {};
    const publicBaseUrl = String(result.status.publicBaseUrl ?? "").trim();
    if (result.status.state === "disabled") {
      const availability = { available: false, message: "内置中转未启用", publicBaseUrl, providerGroupsConfigured };
      writeBuiltInRelayAvailabilityCache(cacheKey, availability);
      return availability;
    }
    if (result.status.state !== "enabled") {
      const availability = { available: false, message: "内置中转配置不完整", publicBaseUrl, providerGroupsConfigured };
      writeBuiltInRelayAvailabilityCache(cacheKey, availability);
      return availability;
    }
    if (!publicBaseUrl) {
      const availability = { available: false, message: "内置中转公开地址未配置", publicBaseUrl, providerGroupsConfigured };
      writeBuiltInRelayAvailabilityCache(cacheKey, availability);
      return availability;
    }
    const availability = { available: true, message: "", publicBaseUrl, providerGroupsConfigured };
    writeBuiltInRelayAvailabilityCache(cacheKey, availability);
    return availability;
  }

  /** 判断本地 Engine Key 是否为 CodeFlow 内置中转生成项。 */
  function isBuiltInRelayKey(key: EngineKeyEntry, target: BuiltInRelayTarget): boolean {
    if (config.isDesktop) return key.engine === target.engine && key.providerId === target.providerId
      && key.source === "builtin" && key.serverOrigin === wsOriginToHttpOrigin(config.serverWsOrigin)
      && key.ownerUserId === config.userSummary?.userId;
    return key.engine === target.engine
      && key.providerId === target.providerId
      && key.label.startsWith("CodeFlow 内置中转");
  }

  /** 在当前本地 Key 列表中查找指定引擎的内置中转项。 */
  function findBuiltInRelayKey(target: BuiltInRelayTarget, workspaceId?: string): EngineKeyEntry | null {
    const keys = workspaceId
      ? engineKeys.scopeSnapshotForWorkspace(workspaceId).keys
      : engineKeys.keys;
    return keys.find((key) => isBuiltInRelayKey(key, target)) ?? null;
  }

  /** 同步内置中转 Key；确认切换时可先安全停止普通 Codex 回合。 */
  async function syncBuiltInRelayKey(
    target: BuiltInRelayTarget,
    workspaceId: string,
    shouldApply?: () => boolean,
    options: BuiltInRelaySyncOptions = {},
  ): Promise<EngineKeyEntry | null> {
    const scope = captureScope(workspaceId, shouldApply);
    scope.assertCurrent();
    if (config.isDesktop) {
      assertDesktopAccount();
      if (!isDesktopWorkspace(config, workspaceId)) throw new Error("DESKTOP_WORKSPACE_REQUIRED");
      const result = await requestDesktopApi<{ key: EngineKeyEntry; accountGeneration: number }>({
        method: "engineKeys.builtInRelay.ensure",
        body: { workspaceId, engine: target.engine, providerId: target.providerId, intent: options.intent ?? "manual",
          ...(options.stopRunningTurns ? { stopRunningTurns: true } : {}) },
      });
      scope.assertCurrent();
      if (!result.ok) throw createApiResultError(result);
      if (result.accountGeneration !== scope.generation) throw createCancelledRequestError("scope-change");
      if (!result.key?.id || !isBuiltInRelayKey(result.key, target)) throw new Error("DESKTOP_BUILT_IN_RELAY_RESULT_INVALID");
      await engineKeys.refresh(scope.requestContext, workspaceId, scope.isCurrent);
      scope.assertCurrent();
      return result.key;
    }
    const ensured = await ensureMyRelayKey(scope.requestContext, { providerId: target.providerId as RelayProviderId });
    scope.assertCurrent();
    if (!ensured.ok) {
      throw createApiResultError(ensured);
    }
    if (ensured.status.state !== "enabled") {
      throw new Error("内置中转未启用或配置不完整");
    }
    const relayBaseUrl = resolveBuiltInRelayBaseUrl(target.engine, ensured.status.publicBaseUrl);
    const rawKey = String(ensured.key.rawKey ?? "").trim();
    if (!rawKey) {
      throw new Error("当前账号内置中转 Key 暂时不可展示，请修复内置中转");
    }

    let existing = findBuiltInRelayKey(target, workspaceId);
    if (!existing) {
      await engineKeys.refresh(scope.requestContext, workspaceId, scope.isCurrent);
      scope.assertCurrent();
      if (shouldApply && !shouldApply()) return null;
      if (engineKeys.scopeSnapshotForWorkspace(workspaceId).phase !== "success") {
        throw new Error("本地 Key 列表刷新未完成，请重试");
      }
      existing = findBuiltInRelayKey(target, workspaceId);
    }
    const label = `CodeFlow 内置中转（${target.label}）`;
    scope.assertCurrent();
    const upserted = await upsertEngineKey(scope.requestContext, {
      id: existing?.id,
      label,
      engine: target.engine,
      providerId: target.providerId,
      apiKey: rawKey,
      baseUrl: relayBaseUrl,
    }, workspaceId);
    scope.assertCurrent();
    if (!upserted.ok) {
      // 保留 code/details：Codex 切换冲突等已登记原因需要按元数据判定，不能退化成普通错误。
      throw createApiResultError(upserted);
    }

    const keyId = upserted.key?.id ?? existing?.id;
    const alreadyActive = Boolean(upserted.key?.isActive ?? existing?.isActive);
    if (keyId && !alreadyActive) {
      const activated = await activateEngineKey(scope.requestContext, {
        id: keyId,
        ...(options.stopRunningTurns ? { stopRunningTurns: true } : {}),
      }, workspaceId);
      scope.assertCurrent();
      if (!activated.ok) {
        throw createApiResultError(activated);
      }
    }

    if (shouldApply && !shouldApply()) return null;
    await engineKeys.refresh(scope.requestContext, workspaceId, scope.isCurrent);
    scope.assertCurrent();
    if (shouldApply && !shouldApply()) return null;
    if (!keyId) {
      // 契约护栏：服务端 ok 却既无新行也无既有行（当前 Client 不可达）。抛错而非返回 null，
      // 让「返回 null」保持单义——写成功但本地列表读不回。
      throw new Error("内置中转 Key 写入后未取得 Key 标识，无法确认启用结果");
    }
    return engineKeys.scopeSnapshotForWorkspace(workspaceId).keys.find((key) => key.id === keyId) ?? null;
  }

  return {
    findBuiltInRelayKey,
    getCachedBuiltInRelayAvailability,
    getBuiltInRelayAvailability,
    isBuiltInRelayKey,
    resolveBuiltInRelayBaseUrl,
    syncBuiltInRelayKey,
  };
}
