import { computed } from "vue";

import type { ApiRequestContext } from "../api/request";
import { useConfigStore } from "../store/config";

/**
 * 从 config store 派生统一请求上下文，区分真实本机和云端认证。
 * - 返回 computed，调用方使用 `ctx.value`。
 */
export function useApiContext() {
  const config = useConfigStore();

  const ctx = computed<ApiRequestContext>(() => ({
    serverWsOrigin: config.serverWsOrigin,
    sessionToken: config.sessionToken,
    webSessionId: config.webSessionId,
    desktopClientId: config.desktopClient?.clientId ?? null,
    isLogoutInProgress: () => config.logoutInProgress,
    ensureSession: (signal?: AbortSignal) => config.ensureSession(signal),
    clearSession: () => config.clearSession(),
  }));

  return { ctx };
}
