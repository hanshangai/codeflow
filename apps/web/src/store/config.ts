import { defineStore } from "pinia";
import { message } from "ant-design-vue";
import type { AccessContext, AccountLoginResponseBody, AccountRole, AccountUserSummary, AuthMode, DesktopCloudAccountState, DesktopRuntimeState, OfficePlatform, OnlineClientInfo } from "@codeflowai/shared";
import { compareNumericVersion, isSharedWorkspaceSelectionId } from "@codeflowai/shared";

import { buildServerWsWebUrl, createApiResultError, createCancelledRequestError, isCancelledRequestError, normalizeServerWsOrigin, throwIfRequestCancelled, wsOriginToHttpOrigin } from "../api/request";
import { clearAnalyticsAccountContext, setAnalyticsAccountContext, trackProductEvent } from "../analytics/analytics";
import { flushWorkspaceDraftsBeforeSwitch, useChatStore } from "./chat";
import { getDesktopBridge, requestDesktopApi } from "../services/desktop";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

const viteEnv = import.meta.env as Record<string, string | undefined> | undefined;
const WORKSPACE_TAB_STORAGE_PREFIX = "codeflowai.workspace.tab";
const WORKSPACE_RECENT_STORAGE_PREFIX = "codeflowai.workspace.recent";
let workspaceSwitchRequestEpoch = 0;
let workspaceSwitchDraftFlushTask: Promise<void> | null = null;
/** 用户主动切换来源，仅用于失败遥测归因。 */
export type WorkspaceSwitchSource = "workspace_selector" | "workspace_manager";
/** 应用内切换后通知 UI 层同步 Router 快照，避免 stale query 写回旧工作区。 */
export const WORKSPACE_URL_SYNC_EVENT = "codeflow-workspace-url-sync";
export type WorkspaceUrlSyncDetail = { workspaceId: string };
/** 以稳定的 store 状态隔离同步记录，避免 Pinia action 代理变化导致重复关联。 */
const desktopAccountSync = new WeakMap<object, { scope: string | null; suppressedScope: string | null; runtimeId: string | null; revision: number; revoked: boolean; pending: Promise<DesktopCloudAccountState | null> | null; failures: number; nextRetryAt: number }>();

/** 关联凭据只参与内存隔离，不进入持久化、日志或桥状态响应。 */
function desktopAccountScope(config: ConfigState, includeLoggingOut = false): string | null {
  if (config.authMode !== "account" || (!includeLoggingOut && config.logoutInProgress) || !config.userSummary?.userId
    || !config.sessionToken || !config.sessionExpiresAt || config.sessionExpiresAt <= Date.now() + 5_000) return null;
  return JSON.stringify([wsOriginToHttpOrigin(config.serverWsOrigin), config.userSummary.userId, config.sessionToken]);
}
const DEFAULT_SERVER_WS_ORIGIN = String(
  viteEnv?.VITE_CODEFLOWAI_SERVER_WS_ORIGIN
  ?? viteEnv?.VITE_AIDT_CODE_SERVER_WS_ORIGIN
  ?? "",
) || deriveServerWsOrigin();
const DEFAULT_WORKSPACE_ID = String(
  viteEnv?.VITE_CODEFLOWAI_WORKSPACE_ID
  ?? viteEnv?.VITE_AIDT_CODE_WORKSPACE_ID
  ?? "",
);

/** 仅测试包迁移明确的旧测试入口，保留生产和用户自定义服务器配置。 */
export function normalizeConfiguredServerWsOrigin(value: string, defaultOrigin = DEFAULT_SERVER_WS_ORIGIN): string {
  const normalized = normalizeServerWsOrigin(value);
  const target = "wss://codeflow-test.hanshangai.com";
  return normalizeServerWsOrigin(defaultOrigin) === target
    && ["ws://47.98.203.210:39280", "ws://codeflow-test.hanshangai.com"].includes(normalized) ? target : normalized;
}

export type ConfigState = {
  serverWsOrigin: string;
  workspaceId: string;
  webInstanceId: string;
  connected: boolean;
  connectionStatus: ConnectionStatus;
  webSessionId: string | null;
  sessionToken: string | null;
  sessionExpiresAt: number | null;
  lastBackfillCount: number | null;
  clientVersion: string | null;
  latestClientVersion: string | null;
  clientSelfUpgrade: boolean | null;
  loginWarning: string | null;
  logoutInProgress: boolean;
  authMode: AuthMode | null;
  accountRole: AccountRole | null;
  accessContext: AccessContext | null;
  homePath: string;
  userSummary: AccountUserSummary | null;
  officeH5Resume: Partial<Record<OfficePlatform, { corpId: string; credential: string; expiresAt: number }>>;
  desktopRuntime: DesktopRuntimeState | null;
  desktopClient: OnlineClientInfo | null;
  /** 本机 Client 身份；运行态失败时仍保留，用于区分远端 presence。 */
  desktopClientId: string | null;
  desktopError: string | null;
  desktopCloudAccount: DesktopCloudAccountState | null;
  desktopCloudAccountError: string | null;
};

export type ConfigStore = ReturnType<typeof useConfigStore>;

const CONFIG_PERSISTED_FIELDS = [
  "serverWsOrigin", "sessionToken", "sessionExpiresAt", "authMode", "accountRole", "accessContext",
  "homePath", "userSummary", "officeH5Resume",
] satisfies Array<keyof ConfigState>;

export const useConfigStore = defineStore("config", {
  state: (): ConfigState => ({
    serverWsOrigin: normalizeServerWsOrigin(DEFAULT_SERVER_WS_ORIGIN),
    workspaceId: DEFAULT_WORKSPACE_ID,
    webInstanceId: getOrCreateWebInstanceId(),
    connected: false,
    connectionStatus: "disconnected",
    webSessionId: null,
    sessionToken: null,
    sessionExpiresAt: null,
    lastBackfillCount: null,
    clientVersion: null,
    latestClientVersion: null,
    clientSelfUpgrade: null,
    loginWarning: null,
    logoutInProgress: false,
    authMode: null,
    accountRole: null,
    accessContext: null,
    homePath: "/chat",
    userSummary: null,
    officeH5Resume: {},
    desktopRuntime: null,
    desktopClient: null,
    desktopClientId: null,
    desktopError: null,
    desktopCloudAccount: null,
    desktopCloudAccountError: null,
  }),
  persist: {
    afterHydrate: ({ store }) => {
      const config = store as ConfigStore;
      // Normalize historical persisted values such as ".../ws/web" before any scope restore runs.
      const normalizedServerWsOrigin = normalizeConfiguredServerWsOrigin(config.serverWsOrigin);
      if (normalizedServerWsOrigin && normalizedServerWsOrigin !== config.serverWsOrigin) {
        config.serverWsOrigin = normalizedServerWsOrigin;
      }
      config.restoreWorkspaceSelectionForCurrentScope();
      config.syncAnalyticsAccountContext();
    },
    pick: CONFIG_PERSISTED_FIELDS,
  },
  getters: {
    isDesktop: () => Boolean(getDesktopBridge()),
    localRuntimeReady: (state) => state.desktopRuntime?.status === "ready" && state.desktopClient !== null,
    /** 已关联只消费 Client 认证 hello 事实，并核对当前账号与 Server。 */
    desktopCloudAccountLinked: (state): boolean => Boolean(desktopAccountScope(state)
      && state.desktopRuntime?.status === "ready" && state.desktopClient
      && state.desktopCloudAccount?.status === "linked"
      && state.desktopCloudAccount.serverOrigin === wsOriginToHttpOrigin(state.serverWsOrigin)
      && state.desktopCloudAccount.userSummary?.userId === state.userSummary?.userId),
    canManageWorkspaces(): boolean { return this.localRuntimeReady || this.connected; },
    wsWebUrl: (state) => buildServerWsWebUrl(state.serverWsOrigin),
    isAdmin: (state) => state.accountRole === "super_admin",
    isSuperAdmin: (state) => state.accountRole === "super_admin",
    isEnterpriseAdmin: (state) => state.accountRole === "enterprise_admin",
    isAccountSession: (state) => state.authMode === "account",
    hasActiveSession: (state) => Boolean(state.sessionToken && state.sessionExpiresAt && state.sessionExpiresAt > Date.now() + 5_000),
    canConnectServer: (state): boolean => {
      if (!String(state.serverWsOrigin).trim()) return false;
      return state.authMode === "account"
        && Boolean(state.sessionToken && state.sessionExpiresAt && state.sessionExpiresAt > Date.now() + 5_000);
    },
    clientUpdateAvailable: (state) => {
      if (state.clientSelfUpgrade === false) return false;
      if (!state.clientVersion || !state.latestClientVersion) return false;
      return compareNumericVersion(state.clientVersion, state.latestClientVersion) < 0;
    },
  },
  actions: {
    /** 同步真实关联状态；手动重试可跳过退避，仍复用原请求锁和 owner 校验。 */
    async syncDesktopCloudAccount(forceUnlink = false, retryNow = false): Promise<DesktopCloudAccountState | null> {
      if (!getDesktopBridge()) return null;
      let sync = desktopAccountSync.get(this.$state);
      const ownerScope = desktopAccountScope(this, true);
      const runtimeId = this.desktopRuntime?.requestId ?? null;
      if (forceUnlink && sync) sync.suppressedScope = ownerScope;
      const scope = forceUnlink || (ownerScope && sync?.suppressedScope === ownerScope) ? null : desktopAccountScope(this);
      if (!forceUnlink && sync?.scope === scope && sync.runtimeId === runtimeId && sync.pending) return await sync.pending;
      if (retryNow && sync) sync.nextRetryAt = 0;
      // 账号作用域变化或上次撤销未完成才重新关联；常规轮询只查状态，避免每 5 秒重连。
      const ownerChanged = !sync || sync.scope !== scope || sync.runtimeId !== runtimeId || forceUnlink;
      // 撤销失败仍显式保留 failed，退避期间不查询或恢复尚未撤销的旧关联。
      if (!ownerChanged && sync && !sync.revoked && Date.now() < sync.nextRetryAt) return this.desktopCloudAccount;
      const changed = ownerChanged || !sync?.revoked;
      if (!sync) { sync = { scope, suppressedScope: forceUnlink ? ownerScope : null, runtimeId, revision: 0, revoked: false, pending: null, failures: 0, nextRetryAt: 0 }; desktopAccountSync.set(this.$state, sync); }
      if (ownerChanged) { sync.failures = 0; sync.nextRetryAt = 0; }
      if (!changed && scope === null) return this.desktopCloudAccount;
      if (changed) { sync.scope = scope; sync.runtimeId = runtimeId; sync.revision += 1; sync.revoked = false; }
      const revision = sync.revision;
      const token = this.sessionToken;
      const userId = this.userSummary?.userId ?? null;
      const generation = this.desktopCloudAccount?.generation ?? 0;
      const serverOrigin = wsOriginToHttpOrigin(this.serverWsOrigin);
      const retryDelayed = !changed && Date.now() < sync.nextRetryAt;
      const isCurrent = () => sync.revision === revision && (this.desktopRuntime?.requestId ?? null) === runtimeId && (forceUnlink
        ? desktopAccountScope(this, true) === ownerScope
        : (scope === null ? desktopAccountScope(this) === null || desktopAccountScope(this, true) === sync.suppressedScope : desktopAccountScope(this) === scope));
      if (changed) this.desktopCloudAccount = { status: scope ? "linking" : "unlinked", generation: this.desktopCloudAccount?.generation ?? 0, serverOrigin: scope ? serverOrigin : null, userSummary: null, errorCode: null };
      /** 同一 owner 的实际失败按 5–60 秒退避；状态查询不延长重试期限。 */
      const postponeRetry = () => {
        sync.failures = Math.min(sync.failures + 1, 5);
        sync.nextRetryAt = Date.now() + Math.min(5_000 * 2 ** (sync.failures - 1), 60_000);
      };
      const task = (async (): Promise<DesktopCloudAccountState | null> => {
        try {
          if (changed) {
            const unlinked = await requestDesktopApi<{ account: DesktopCloudAccountState }>({ method: "runtime.cloudAccount.unlink" });
            if (!unlinked.ok) throw createApiResultError(unlinked);
            if (!isCurrent()) return null;
            if (unlinked.account?.status !== "unlinked" || !Number.isSafeInteger(unlinked.account.generation)) throw new Error("DESKTOP_CLOUD_ACCOUNT_STATE_INVALID");
            sync.revoked = true;
            this.desktopCloudAccount = unlinked.account;
          }
          if (scope) {
            let attemptedLink = changed;
            let result = await requestDesktopApi<{ account: DesktopCloudAccountState }>(changed
              ? { method: "runtime.cloudAccount.link", body: { serverOrigin, sessionToken: token } }
              : { method: "runtime.cloudAccount.status" });
            if (!result.ok) throw createApiResultError(result);
            if (!isCurrent()) return null;
            // 运行时重启或瞬时网络失败会丢失关联；状态查询发现未关联/失败时恢复 link。
            if (!changed && (result.account?.status === "unlinked" || result.account?.status === "failed") && Date.now() >= sync.nextRetryAt) {
              attemptedLink = true;
              result = await requestDesktopApi<{ account: DesktopCloudAccountState }>({
                method: "runtime.cloudAccount.link", body: { serverOrigin, sessionToken: token },
              });
              if (!result.ok) throw createApiResultError(result);
              if (!isCurrent()) return null;
            }
            const account = result.account;
            if (!account || !["unlinked", "linking", "linked", "failed"].includes(account.status) || !Number.isSafeInteger(account.generation)) throw new Error("DESKTOP_CLOUD_ACCOUNT_STATE_INVALID");
            // 未到重试时点仍暴露上次失败，不能把 Client 的 unlinked 当作恢复成功。
            if (!attemptedLink && Date.now() < sync.nextRetryAt && (account.status === "failed" || account.status === "unlinked")) return this.desktopCloudAccount;
            this.desktopCloudAccount = account;
            if (account.status === "failed" && attemptedLink) postponeRetry();
            if (account.status === "linked") { sync.failures = 0; sync.nextRetryAt = 0; }
          }
          if (isCurrent()) this.desktopCloudAccountError = this.desktopCloudAccount?.errorCode ?? null;
          return this.desktopCloudAccount;
        } catch (error) {
          const errorCode = (error as { code?: unknown })?.code;
          const code = typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{0,80}$/u.test(errorCode)
            && ![token, this.sessionToken].some((secret) => secret && errorCode.includes(secret))
            ? errorCode : "DESKTOP_CLOUD_ACCOUNT_FAILED";
          // 延迟轮重复失败返回 failed 且保留期限；到期由原入口重试并重新报告。
          if (isCurrent() && retryDelayed && this.desktopCloudAccount?.status === "failed" && this.desktopCloudAccountError === code) return this.desktopCloudAccount;
          if (isCurrent()) {
            postponeRetry();
            this.desktopCloudAccount = { status: "failed", generation: this.desktopCloudAccount?.generation ?? 0, serverOrigin: scope ? serverOrigin : null, userSummary: null, errorCode: code };
            this.desktopCloudAccountError = code;
          }
          console.error("[DESKTOP_CLOUD_ACCOUNT_FAILED]", { code,
            requestId: runtimeId, userId, generation, cause: "桌面账号关联请求失败" });
          throw error;
        }
      })();
      sync.pending = task;
      try { return await task; } finally { if (sync.pending === task) sync.pending = null; }
    },
    /** 显式撤销完成后才允许账号切换继续；失败由调用方展示并中止。 */
    async unlinkDesktopCloudAccount(): Promise<void> {
      const cancel = getDesktopBridge()?.cancelMigrationAccount;
      if (cancel) {
        const owner = desktopAccountScope(this, true);
        await cancel();
        if (owner !== desktopAccountScope(this, true)) throw createCancelledRequestError("scope-change");
      }
      await this.syncDesktopCloudAccount(true);
    },
    /** 读取当前壳和实际 Client 状态；本机就绪不修改云端认证或连接事实。 */
    async refreshDesktopRuntime(): Promise<void> {
      const bridge = getDesktopBridge();
      if (!bridge) return;
      try {
        if (typeof bridge.onEvent !== "function") throw new Error("DESKTOP_EVENT_BRIDGE_REQUIRED");
        this.desktopRuntime = await bridge.getState();
        this.desktopError = this.desktopRuntime.errorCode;
        if (this.desktopRuntime.status !== "ready") {
          this.desktopClient = null;
          return;
        }
        const response = await bridge.request({ method: "runtime.info" });
        const body = response.body as { ok?: boolean; code?: string; client?: OnlineClientInfo; message?: string } | null;
        if (response.status !== 200 || body?.ok !== true) {
          throw Object.assign(new Error(body?.message || "DESKTOP_RUNTIME_INFO_FAILED"), { code: body?.code });
        }
        const client = body.client;
        if (!client?.clientId || !client.version || !Array.isArray(client.workspaceIds) || !Number.isFinite(client.connectedAt)) {
          throw new Error("DESKTOP_RUNTIME_INFO_INVALID");
        }
        this.desktopClient = { ...client, workspaceIds: [...client.workspaceIds] };
        this.desktopClientId = client.clientId;
      } catch (error) {
        this.desktopClient = null;
        // 退出中的结构化拒绝是正常收尾，不刷新为错误态或弹窗。
        if ((error as { code?: string } | null)?.code === "APP_SHUTTING_DOWN") return;
        this.desktopRuntime = { status: "failed", requestId: this.desktopRuntime?.requestId ?? null,
          releaseId: this.desktopRuntime?.releaseId ?? null, errorCode: "DESKTOP_RUNTIME_UNAVAILABLE" };
        this.desktopError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    setConnectionStatus(status: ConnectionStatus) {
      this.connectionStatus = status;
      this.connected = status === "connected";
      if (!this.connected) this.webSessionId = null;
      if (status === "disconnected") this.lastBackfillCount = null;
    },
    setConnected(connected: boolean) {
      this.setConnectionStatus(connected ? "connected" : "disconnected");
    },
    /** 标记账号退出生命周期，供请求层取消旧认证请求并抑制误报。 */
    setLogoutInProgress(value: boolean) {
      this.logoutInProgress = value;
    },
    setWebSessionId(id: string) {
      this.webSessionId = id;
    },
    setSession(session: { token: string; expiresAt: number }) {
      this.sessionToken = session.token;
      this.sessionExpiresAt = session.expiresAt;
    },
    /** 建立账号会话，并按账号作用域恢复向导完成状态。 */
    setAccountSession(session: AccountLoginResponseBody) {
      this.logoutInProgress = false;
      if (this.sessionToken && this.sessionToken !== session.sessionToken) this.clearOfficeH5Resume();
      this.authMode = "account";
      this.accountRole = session.accountRole;
      this.accessContext = session.accessContext;
      this.homePath = session.homePath || "/chat";
      this.userSummary = session.userSummary;
      this.setSession({ token: session.sessionToken, expiresAt: session.sessionExpiresAt });
      this.restoreWorkspaceSelectionForCurrentScope();
      this.syncAnalyticsAccountContext();
    },
    /** 账号交付确认前强制保存既有 config，并逐字段验证真实持久状态，插件吞错也必须显式失败。 */
    persistAccountSession(): void {
      try {
        this.$persist();
        const saved = JSON.parse(window.localStorage.getItem(this.$id) ?? "null") as Partial<ConfigState> | null;
        if (!saved || CONFIG_PERSISTED_FIELDS.some(key => JSON.stringify(saved[key]) !== JSON.stringify(this.$state[key]))) {
          throw new Error("ACCOUNT_SESSION_PERSISTENCE_MISMATCH");
        }
      } catch (cause) {
        throw Object.assign(new Error("ACCOUNT_SESSION_PERSIST_FAILED", { cause }), { code: "ACCOUNT_SESSION_PERSIST_FAILED" });
      }
    },
    /** 保存同一账号会话下的办公 H5 七天恢复凭证。 */
    setOfficeH5Resume(input: { platform: OfficePlatform; corpId: string; credential: string; expiresAt: number }) {
      this.officeH5Resume = { ...this.officeH5Resume, [input.platform]: { corpId: input.corpId, credential: input.credential, expiresAt: input.expiresAt } };
    },
    /** 清理指定平台或全部办公 H5 恢复凭证。 */
    clearOfficeH5Resume(platform?: OfficePlatform) {
      if (!platform) {
        this.officeH5Resume = {};
        return;
      }
      const next = { ...this.officeH5Resume };
      delete next[platform];
      this.officeH5Resume = next;
    },
    applyAccountProfile(summary: {
      fullName: string;
      email: string;
      phone: string;
      avatarUrl: string | null;
      accountRole: AccountRole;
      accessContext: AccessContext;
      enterpriseSummary: { enterpriseId: string; name: string } | null;
    }) {
      if (this.authMode !== "account") return;
      this.accountRole = summary.accountRole;
      this.accessContext = summary.accessContext;
      this.userSummary = {
        userId: this.userSummary?.userId ?? "",
        email: summary.email,
        fullName: summary.fullName,
        phone: summary.phone,
        avatarUrl: summary.avatarUrl,
        accountRole: summary.accountRole,
        status: this.userSummary?.status ?? "active",
        enterpriseId: summary.enterpriseSummary?.enterpriseId ?? null,
        enterpriseName: summary.enterpriseSummary?.name ?? null,
      };
      this.syncAnalyticsAccountContext();
    },
    applySessionFromHello(payload: {
      authMode?: AuthMode;
      accountRole?: AccountRole | null;
      accessContext?: AccessContext | null;
      homePath?: string | null;
      userSummary?: AccountUserSummary | null;
    }) {
      if (payload.authMode !== "account") return;
      this.authMode = "account";
      this.accountRole = payload.accountRole ?? this.accountRole;
      this.accessContext = payload.accessContext ?? this.accessContext;
      this.homePath = payload.homePath || this.homePath || "/chat";
      this.userSummary = payload.userSummary ?? this.userSummary;
      this.syncAnalyticsAccountContext();
    },
    expireCurrentSession() {
      this.sessionToken = null;
      this.sessionExpiresAt = null;
      this.loginWarning = null;
      this.clearOfficeH5Resume();
      if (this.authMode === "account") {
        this.accountRole = null;
        this.accessContext = null;
        this.userSummary = null;
        this.homePath = "/auth/login";
      }
      clearAnalyticsAccountContext();
    },
    async ensureSession(signal?: AbortSignal): Promise<string> {
      throwIfRequestCancelled(signal);
      const serverWsOrigin = this.serverWsOrigin.trim();
      if (!serverWsOrigin) throw new Error("请先填写 Server 地址");

      const now = Date.now();
      const token = this.sessionToken ?? null;
      const expiresAt = this.sessionExpiresAt ?? null;
      const accountReady = this.authMode === "account" && this.accountRole != null && this.userSummary != null;

      if (!accountReady) {
        this.expireCurrentSession();
        throw new Error("Web 端仅支持账号登录，请先登录账号");
      }

      if (token && expiresAt && expiresAt > now + 5_000) {
        this.loginWarning = null;
        return token;
      }
      this.expireCurrentSession();
      throw new Error("账号会话已过期，请重新登录");
    },
    clearSession() {
      this.sessionToken = null;
      this.sessionExpiresAt = null;
      this.loginWarning = null;
      this.clearOfficeH5Resume();
    },
    /** 撤销云端会话；桌面本地工作区选择独立保留。 */
    logout() {
      this.sessionToken = null;
      this.sessionExpiresAt = null;
      this.clearOfficeH5Resume();
      this.authMode = null;
      this.accountRole = null;
      this.accessContext = null;
      this.homePath = this.isDesktop ? "/chat" : "/auth/login";
      this.userSummary = null;
      this.connected = false;
      this.connectionStatus = "disconnected";
      this.webSessionId = null;
      this.lastBackfillCount = null;
      this.loginWarning = null;
      if (!this.isDesktop || isSharedWorkspaceSelectionId(this.workspaceId)) this.workspaceId = DEFAULT_WORKSPACE_ID;
      clearAnalyticsAccountContext();
    },
    /** 同步当前账号上下文到百度统计；不传邮箱、企业 ID 或工作区 ID。 */
    syncAnalyticsAccountContext() {
      if (this.authMode !== "account" || !this.userSummary) {
        clearAnalyticsAccountContext();
        return;
      }
      setAnalyticsAccountContext({
        email: this.userSummary.email,
        accountRole: this.accountRole,
        accessContext: this.accessContext,
        enterpriseId: this.userSummary.enterpriseId ?? this.accessContext?.enterpriseId ?? null,
        workspaceSet: Boolean(String(this.workspaceId ?? "").trim()),
      });
    },
    /** 恢复当前账号/页签作用域的工作区选择；账号无历史时等待真实列表兜底。 */
    restoreWorkspaceSelectionForCurrentScope() {
      const scopeInput = {
        serverWsOrigin: this.serverWsOrigin,
        authMode: this.authMode,
        userSummary: this.userSummary,
        webInstanceId: this.webInstanceId,
      };
      const restored = readWorkspaceSelectionForScope(scopeInput);
      const restoredWorkspaceId = resolveWorkspaceIdAfterScopedRestore({
        restoredWorkspaceId: restored.workspaceId,
        hasAccountWorkspaceScope: Boolean(resolveWorkspaceSelectionScope(scopeInput)),
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      this.workspaceId = restoredWorkspaceId;
      persistWorkspaceSelectionForScope(scopeInput, restoredWorkspaceId, { updateRecent: restored.source === "legacy" });
      this.syncAnalyticsAccountContext();
    },
    setLastBackfillCount(count: number) {
      this.lastBackfillCount = count;
    },
    /** 更新当前工作区 Client 的版本与升级能力，省略能力兼容旧 Server。 */
    setClientVersionInfo(info: { clientVersion: string | null; latestClientVersion: string | null; selfUpgrade?: boolean | null }) {
      this.clientVersion = info.clientVersion;
      this.latestClientVersion = info.latestClientVersion;
      this.clientSelfUpgrade = info.selfUpgrade ?? null;
    },
    /** 保存草稿后按生命周期守卫执行刷新；失效时保留草稿并停止后续副作用。 */
    async reloadCurrentWorkspacePage(
      afterDraftFlush?: () => void | Promise<void>,
      shouldContinue?: () => boolean,
    ): Promise<void> {
      if (workspaceSwitchDraftFlushTask) await workspaceSwitchDraftFlushTask;
      if (shouldContinue && !shouldContinue()) return;
      const pendingDraftFlush = flushWorkspaceDraftsBeforeSwitch();
      if (pendingDraftFlush) {
        workspaceSwitchDraftFlushTask = pendingDraftFlush;
        try {
          await pendingDraftFlush;
        } finally {
          if (workspaceSwitchDraftFlushTask === pendingDraftFlush) workspaceSwitchDraftFlushTask = null;
        }
      }
      if (shouldContinue && !shouldContinue()) return;
      await afterDraftFlush?.();
      if (shouldContinue && !shouldContinue()) return;
      reloadPageAfterWorkspaceSwitch();
    },
    /**
     * 切换工作区；用户主动切换可先严格保存草稿。
     * reloadPage 保留整页重建；flushDrafts 走应用内切换并同步地址栏。
     */
    switchWorkspace(newId: string, options?: {
      reloadPage?: boolean;
      preservePrimaryThreadUrl?: boolean;
      flushDrafts?: boolean;
      source?: WorkspaceSwitchSource;
      /** 状态提交及 URL 通知完成后回调；失败不触发。 */
      onApplied?: (workspaceId: string) => void;
    }) {
      const nextWorkspaceId = String(newId ?? "").trim();
      // 当前工作区的点击是空操作，不能取消仍在等待草稿保存的切换。
      if (this.workspaceId === nextWorkspaceId) return;
      const requiresDraftFlush = Boolean(options?.reloadPage || options?.flushDrafts);
      if (!requiresDraftFlush && workspaceSwitchDraftFlushTask) return;
      const requestEpoch = ++workspaceSwitchRequestEpoch;
      const chat = useChatStore();
      const workspaceType = isSharedWorkspaceSelectionId(nextWorkspaceId) ? "shared" : "local";
      /** 仅让最新一次请求提交 workspace 状态与可选页面刷新。 */
      const applyWorkspaceSwitch = () => {
        if (requestEpoch !== workspaceSwitchRequestEpoch) return;
        chat.clearPrimaryThreadSelection({
          clearUrl: !(options?.preservePrimaryThreadUrl && nextWorkspaceId),
          reason: "workspace-switch",
        });
        chat.clearPrimaryRouteResolution();
        this.workspaceId = nextWorkspaceId;
        persistWorkspaceSelectionForScope({
          serverWsOrigin: this.serverWsOrigin,
          authMode: this.authMode,
          userSummary: this.userSummary,
          webInstanceId: this.webInstanceId,
        }, nextWorkspaceId, { updateRecent: true });
        this.syncAnalyticsAccountContext();
        if (options?.reloadPage) {
          trackProductEvent("workspace_switch", { status: "success", source: "workspace_reload", workspace_type: workspaceType });
          reloadPageAfterWorkspaceSwitch(nextWorkspaceId);
        } else if (options?.flushDrafts) {
          notifyWorkspaceUrlSync(nextWorkspaceId);
        }
        options?.onApplied?.(nextWorkspaceId);
      };
      if (!requiresDraftFlush) {
        applyWorkspaceSwitch();
        return;
      }
      const pendingDraftFlush = flushWorkspaceDraftsBeforeSwitch();
      if (!pendingDraftFlush) {
        applyWorkspaceSwitch();
        return;
      }
      workspaceSwitchDraftFlushTask = pendingDraftFlush;
      void pendingDraftFlush
        .then(applyWorkspaceSwitch)
        .catch((error) => {
          if (isCancelledRequestError(error)) return;
          if (requestEpoch !== workspaceSwitchRequestEpoch) return;
          trackProductEvent("workspace_switch", {
            status: "failed",
            source: options?.reloadPage ? "workspace_reload" : options?.source ?? "workspace_selector",
            workspace_type: workspaceType,
            error_code_group: "draft_save_failed",
          });
          message.error(`切换工作区前保存草稿失败：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          if (workspaceSwitchDraftFlushTask === pendingDraftFlush) workspaceSwitchDraftFlushTask = null;
        });
    },
  },
});

/** 主动切工作区时同步聊天页和知识页地址，清理旧工作区目标，避免刷新后切回。 */
export function resolveWorkspaceSwitchReloadUrl(href: string, workspaceId: string): string {
  const url = new URL(href);
  if (url.pathname !== "/knowledge" && url.pathname !== "/chat") return href;
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  else url.searchParams.delete("workspaceId");
  const targetKeys = url.pathname === "/chat" ? ["threadId", "targetId"] : ["threadId", "executionThreadId", "changeId"];
  for (const key of targetKeys) url.searchParams.delete(key);
  return url.href;
}

/** 切项目时同步范围；无目标参数的普通刷新保留当前深链。 */
function reloadPageAfterWorkspaceSwitch(workspaceId?: string): void {
  if (typeof window === "undefined") return;
  const href = workspaceId === undefined ? window.location.href : resolveWorkspaceSwitchReloadUrl(window.location.href, workspaceId);
  if (href !== window.location.href) window.history.replaceState(window.history.state, "", href);
  window.location.reload();
}

/** 应用内切换后请求 UI 层同步 Router 快照，避免后续导航把旧工作区写回地址栏。 */
function notifyWorkspaceUrlSync(workspaceId: string): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent<WorkspaceUrlSyncDetail>(WORKSPACE_URL_SYNC_EVENT, { detail: { workspaceId } }));
}

/** 加载后归一旧测试入口与页面默认值，不覆盖其他已保存服务器。 */
export function migrateConfigDefaults() {
  if (typeof window === "undefined") return;
  const store = useConfigStore();
  const normalizedServerWsOrigin = normalizeConfiguredServerWsOrigin(store.serverWsOrigin);
  if (window.location.protocol === "codeflow:" && !normalizedServerWsOrigin && DEFAULT_SERVER_WS_ORIGIN) {
    store.serverWsOrigin = normalizeServerWsOrigin(DEFAULT_SERVER_WS_ORIGIN);
    store.restoreWorkspaceSelectionForCurrentScope();
    return;
  }
  if (shouldUsePageOriginForPersistedServer(normalizedServerWsOrigin)) {
    store.serverWsOrigin = deriveServerWsOrigin();
    store.restoreWorkspaceSelectionForCurrentScope();
    return;
  }
  if (normalizedServerWsOrigin && normalizedServerWsOrigin !== store.serverWsOrigin) {
    store.serverWsOrigin = normalizedServerWsOrigin;
    store.restoreWorkspaceSelectionForCurrentScope();
  }
}

/** 仅从 HTTP 页面推导 Server；静态协议保持未配置，开发页沿用 39280。 */
function deriveServerWsOrigin(): string {
  if (typeof window === "undefined") return "ws://127.0.0.1:39280";
  const loc = window.location;
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return "";
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  const host = loc.port === "39281"
    ? formatHostnameWithPort(loc.hostname, "39280")
    : (loc.host || loc.hostname);
  return `${protocol}//${host}`;
}

/** ???????????????? Vite ????????????? */
function isLocalDevelopmentHost(hostname: string): boolean {
  const value = String(hostname ?? "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

/** ? IPv6 ??????????????????? URL? */
function formatHostnameWithPort(hostname: string, port: string): string {
  const value = String(hostname ?? "").trim();
  const host = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return `${host}:${port}`;
}

/** 仅 HTTP 页面修复历史默认地址，静态协议不改写持久来源。 */
function shouldUsePageOriginForPersistedServer(normalizedServerWsOrigin: string): boolean {
  if (typeof window === "undefined") return false;
  const loc = window.location;
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return false;
  if (isLocalDevelopmentHost(loc.hostname)) return false;
  if (normalizedServerWsOrigin === "ws://127.0.0.1:39280") return true;
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  if (normalizedServerWsOrigin === `${protocol}//${formatHostnameWithPort(loc.hostname, "39280")}`) return true;
  return loc.port === "39281" && normalizedServerWsOrigin === `${protocol}//${formatHostnameWithPort(loc.hostname, "39281")}`;
}

function getOrCreateWebInstanceId(): string {
  try {
    const key = "codeflowai.webInstanceId";
    const sessionStorageRef = typeof window !== "undefined" ? window.sessionStorage : null;
    const existing = sessionStorageRef?.getItem(key) ?? "";
    if (existing && existing.length <= 200) return existing;

    const created = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `webi_${crypto.randomUUID()}`
      : `webi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    sessionStorageRef?.setItem(key, created);
    return created;
  } catch {
    return `webi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

type WorkspaceSelectionScopeInput = Pick<ConfigState, "serverWsOrigin" | "authMode" | "userSummary" | "webInstanceId">;

/** 桌面选择属于本机系统用户，云端账号切换不改变该本地选择范围。 */
function resolveWorkspaceSelectionScope(input: WorkspaceSelectionScopeInput): {
  serverWsOrigin: string;
  userId: string;
  webInstanceId: string;
} | null {
  if (getDesktopBridge()) return { serverWsOrigin: "desktop-local", userId: "local_os_user", webInstanceId: input.webInstanceId };
  if (input.authMode !== "account") return null;
  const serverWsOrigin = String(input.serverWsOrigin ?? "").trim();
  const userId = String(input.userSummary?.userId ?? "").trim();
  const webInstanceId = String(input.webInstanceId ?? "").trim();
  if (!serverWsOrigin || !userId || !webInstanceId) return null;
  return { serverWsOrigin, userId, webInstanceId };
}

function workspaceStoragePart(value: string): string {
  return encodeURIComponent(String(value ?? "").trim());
}

function workspaceTabStorageKey(scope: { serverWsOrigin: string; userId: string; webInstanceId: string }): string {
  return [
    WORKSPACE_TAB_STORAGE_PREFIX,
    workspaceStoragePart(scope.serverWsOrigin),
    workspaceStoragePart(scope.userId),
    workspaceStoragePart(scope.webInstanceId),
  ].join("::");
}

function workspaceRecentStorageKey(scope: { serverWsOrigin: string; userId: string }): string {
  return [
    WORKSPACE_RECENT_STORAGE_PREFIX,
    workspaceStoragePart(scope.serverWsOrigin),
    workspaceStoragePart(scope.userId),
  ].join("::");
}

function safeReadSessionStorage(key: string): string {
  try {
    return String(window.sessionStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function safeReadLocalStorage(key: string): string {
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function safeWriteSessionStorage(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // ignore storage write failures
  }
}

function safeWriteLocalStorage(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // ignore storage write failures
  }
}

function readLegacyPersistedWorkspaceId(): string {
  try {
    const raw = String(window.localStorage.getItem("config") ?? "").trim();
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { workspaceId?: unknown };
    return String(parsed.workspaceId ?? "").trim();
  } catch {
    return "";
  }
}

function readWorkspaceSelectionForScope(input: WorkspaceSelectionScopeInput): {
  workspaceId: string;
  source: "tab" | "recent" | "legacy" | "none";
} {
  const scope = resolveWorkspaceSelectionScope(input);
  if (!scope || typeof window === "undefined") {
    return { workspaceId: "", source: "none" };
  }
  const tabWorkspaceId = safeReadSessionStorage(workspaceTabStorageKey(scope));
  if (tabWorkspaceId) return { workspaceId: tabWorkspaceId, source: "tab" };
  const recentWorkspaceId = safeReadLocalStorage(workspaceRecentStorageKey(scope));
  if (recentWorkspaceId) return { workspaceId: recentWorkspaceId, source: "recent" };
  const legacyWorkspaceId = readLegacyPersistedWorkspaceId();
  if (legacyWorkspaceId) return { workspaceId: legacyWorkspaceId, source: "legacy" };
  return { workspaceId: "", source: "none" };
}

/** 账号作用域无历史时不写入构建默认工作区，避免把 ws-demo 当成真实选择。 */
export function resolveWorkspaceIdAfterScopedRestore(input: {
  restoredWorkspaceId: string | null | undefined;
  hasAccountWorkspaceScope: boolean;
  defaultWorkspaceId: string | null | undefined;
}): string {
  const restoredWorkspaceId = String(input.restoredWorkspaceId ?? "").trim();
  if (restoredWorkspaceId) return restoredWorkspaceId;
  return input.hasAccountWorkspaceScope ? "" : String(input.defaultWorkspaceId ?? "").trim();
}

function persistWorkspaceSelectionForScope(
  input: WorkspaceSelectionScopeInput,
  workspaceId: string,
  options: { updateRecent: boolean },
): void {
  const scope = resolveWorkspaceSelectionScope(input);
  if (!scope || typeof window === "undefined") return;
  const normalizedWorkspaceId = String(workspaceId ?? "").trim();
  safeWriteSessionStorage(workspaceTabStorageKey(scope), normalizedWorkspaceId);
  if (options.updateRecent && normalizedWorkspaceId) {
    safeWriteLocalStorage(workspaceRecentStorageKey(scope), normalizedWorkspaceId);
  }
}
