import { defineStore } from "pinia";
import type {
  AccountMeSummaryResponseBody,
  AccountRegisterRequestBody,
  CancelMyAccountRequestBody,
  ApiResult,
  AuditLogFilters,
  AuditLogItem,
  EnterpriseCandidateItem,
  EnterpriseMemberItem,
  EnterpriseMemberSortBy,
  EnterpriseMemberSortDirection,
  EnterpriseSummaryResponseBody,
  PreviewRemoveEnterpriseMemberResponseBody,
  RespondEnterpriseInvitationRequestBody,
  VerificationPurpose,
} from "@codeflowai/shared";

import * as accountApi from "../api/account";
import { trackProductEvent } from "../analytics/analytics";
import { useConfigStore } from "./config";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../api/request";

type VerificationCooldownState = Record<VerificationPurpose, number>;
export type AccountDrawerTab = "overview" | "password" | "account-cancel";
export type AccountDrawerSurface = "default" | "h5";
type OpenAccountDrawerOptions = { tab?: AccountDrawerTab; surface?: AccountDrawerSurface };
type LoadMeSummaryOptions = { silent?: boolean; maxAgeMs?: number; owner?: ReturnType<typeof captureAccountSession> };
type EnterpriseMemberSortByState = EnterpriseMemberSortBy | "";
type EnterpriseMemberSortDirectionState = EnterpriseMemberSortDirection | "";
type LoadEnterpriseMembersOptions = {
  silent?: boolean;
  enterpriseId?: string | null;
  page?: number;
  pageSize?: number;
  sortBy?: EnterpriseMemberSortByState;
  sortDirection?: EnterpriseMemberSortDirectionState;
};
const ME_SUMMARY_REFRESH_INTERVAL_MS = 5_000;
const ENTERPRISE_DRAWER_REFRESH_INTERVAL_MS = 10_000;

let meSummaryRefreshTimer: number | null = null;
let meSummaryFocusHandler: (() => void) | null = null;
let meSummaryVisibilityHandler: (() => void) | null = null;
let meSummaryPendingRequest: { scope: string; owner: ReturnType<typeof captureAccountSession>; promise: Promise<AccountMeSummaryResponseBody | null> } | null = null;
let meSummaryRequestRevision = 0;
let meSummaryLoadedAt = 0;
let enterpriseRefreshTimer: number | null = null;
let enterpriseFocusHandler: (() => void) | null = null;
let enterpriseVisibilityHandler: (() => void) | null = null;
let enterpriseSummaryPendingRequest: {
  scopeId: string | null;
  revision: number;
  promise: Promise<EnterpriseSummaryResponseBody | null>;
} | null = null;
let enterpriseMembersPendingRequest: {
  scopeId: string | null;
  queryKey: string;
  revision: number;
  promise: Promise<EnterpriseMemberItem[]>;
} | null = null;
let enterpriseLoadingRequestCount = 0;
let enterpriseDataRevision = 0;
const accountLoginRevisions = new WeakMap<object, number>();
// 忙状态属于当次注销调用，不能复用会被登录动作推进的修订号。
const pendingAccountCancellations = new WeakMap<object, object>();
const pendingDefaultKeyRotations = new WeakMap<object, object>();
const pendingDefaultKeySends = new WeakMap<object, object>();
const pendingPasswordChanges = new WeakMap<object, object>();
const pendingEnterpriseProfileUpdates = new WeakMap<object, object>();
const pendingEnterprisePasswordResets = new WeakMap<object, object>();
const pendingEnterpriseInvitationResponses = new WeakMap<object, object>();
const pendingProfileUpdates = new WeakMap<object, { scope: string; requests: Set<object> }>();
const accountSessionScopes = new WeakMap<object, { scope: string; revision: number; expiry?: { from: number; at: number } }>();

/** 资料与头像共用忙状态，只由同一会话最后一个实际请求释放。 */
function trackProfileUpdate(store: object, config: ReturnType<typeof useConfigStore>): () => boolean {
  const scope = meSummaryScope(config);
  let pending = pendingProfileUpdates.get(store);
  if (!pending || pending.scope !== scope) {
    pending = { scope, requests: new Set() };
    pendingProfileUpdates.set(store, pending);
  }
  const request = {};
  pending.requests.add(request);
  return () => {
    pending.requests.delete(request);
    if (pendingProfileUpdates.get(store) !== pending || pending.requests.size) return false;
    pendingProfileUpdates.delete(store);
    return true;
  };
}

/** Invalidates in-flight enterprise view requests so stale responses cannot overwrite fresh snapshots. */
function invalidateEnterprisePendingRequests(): number {
  enterpriseDataRevision += 1;
  enterpriseSummaryPendingRequest = null;
  enterpriseMembersPendingRequest = null;
  return enterpriseDataRevision;
}

function createApiContext(config: ReturnType<typeof useConfigStore>) {
  return {
    serverWsOrigin: config.serverWsOrigin,
    sessionToken: config.sessionToken,
    webSessionId: config.webSessionId,
    isLogoutInProgress: () => config.logoutInProgress,
    ensureSession: () => config.ensureSession(),
    clearSession: () => config.expireCurrentSession(),
  };
}

/** 仅用于内存中的请求隔离，包含会话凭据，禁止记录到日志。 */
function meSummaryScope(config: ReturnType<typeof useConfigStore>): string {
  return JSON.stringify([config.authMode, config.serverWsOrigin, config.userSummary?.userId, config.sessionToken]);
}

/** 同步观察现有会话字段，区分A过期与B接管后再次过期；不增加持久认证状态。 */
function observeAccountSession(config: ReturnType<typeof useConfigStore>) {
  let observed = accountSessionScopes.get(config);
  if (!observed) {
    observed = { scope: meSummaryScope(config), revision: 0 };
    accountSessionScopes.set(config, observed);
    const current = observed;
    config.$subscribe(() => {
      const scope = meSummaryScope(config);
      if (scope !== current.scope) { current.scope = scope; current.revision += 1; }
    }, { detached: true, flush: "sync" });
  }
  return observed;
}

/** 绑定原请求的认证与清理入口，异步恢复后不得借用另一会话；未传上下文时使用账号默认入口。 */
export function captureAccountSession(config: ReturnType<typeof useConfigStore>, context?: ApiRequestContext) {
  const observed = observeAccountSession(config), revision = observed.revision;
  const scope = meSummaryScope(config);
  const userId = config.userSummary?.userId ?? null;
  const serverWsOrigin = config.serverWsOrigin;
  const apiContext = context ?? createApiContext(config);
  /** 仅同修订认证入口实际清除的同源会话可保留其失败结果。 */
  const isExpired = () => !config.sessionToken && config.serverWsOrigin === serverWsOrigin
    && (!config.userSummary || config.userSummary.userId === userId);
  /** 响应与UI共用原scope，只额外承认同修订的认证失效。 */
  const isCurrentResponse = () => (observed.revision === revision && meSummaryScope(config) === scope)
    || (observed.expiry?.from === revision && observed.revision === observed.expiry.at && isExpired());
  /** scope 仅用于内存比较，不进入日志。 */
  const assertCurrent = () => {
    if (observed.revision !== revision || meSummaryScope(config) !== scope) throw createCancelledRequestError("scope-change");
  };
  const requestContext = {
    ...apiContext,
    /** ensureSession 自身清空过期认证时保留明确失败；新账号仍按 scope 隔离。 */
    isLogoutInProgress: () => {
      if (isExpired()) return false;
      assertCurrent();
      return apiContext.isLogoutInProgress?.() ?? config.logoutInProgress;
    },
    ensureSession: async (signal?: AbortSignal) => {
      assertCurrent();
      const validation = apiContext.ensureSession ? apiContext.ensureSession(signal) : Promise.resolve(apiContext.sessionToken ?? "");
      if (isExpired()) observed.expiry = { from: revision, at: observed.revision };
      const token = await validation;
      assertCurrent();
      return token;
    },
    /** 先核owner，再将本请求401清理标为可报告的认证失败。 */
    clearSession: () => { assertCurrent(); apiContext.clearSession?.(); observed.expiry = { from: revision, at: observed.revision }; },
  };
  /** 成功仍须严格assertCurrent；只有失败结果允许本次认证失效。 */
  const assertResponseCurrent = () => { if (!isCurrentResponse()) throw createCancelledRequestError("scope-change"); };
  return { userId, assertCurrent, assertResponseCurrent, isCurrentResponse, requestContext };
}

/** 账号边界仅记录安全定位并返回关联ID，失败仍由调用方显式传播。 */
function reportAccountSessionFailure(error: unknown, operation: "login" | "logout" | "cancel" | "rotate-default-key" | "profile" | "avatar" | "send-default-key" | "change-password" | "enterprise-profile" | "enterprise-password" | "enterprise-invitation" | "enterprise-summary",
  owner: ReturnType<typeof captureAccountSession>, config: ReturnType<typeof useConfigStore>,
  target?: { enterpriseId?: string | null; membershipId?: string; invitationId?: string; action?: "accept" | "decline" }, secrets: readonly string[] = []): string {
  const requestId = `account-${operation}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const errorRecord = error && typeof error === "object" ? error as { code?: unknown; details?: unknown } : null;
  const details = errorRecord?.details && typeof errorRecord.details === "object"
    ? errorRecord.details as { requestId?: unknown; serverRequestId?: unknown } : null;
  /** 定位字段格式正确也不能携带会话凭据或本次提交的密码。 */
  const safeLogField = (value: unknown, format: RegExp): value is string => typeof value === "string" && format.test(value)
    && ![owner.requestContext.sessionToken, config.sessionToken, ...secrets].some((secret) => secret && value.includes(secret));
  const apiCode = safeLogField(errorRecord?.code, /^[A-Z][A-Z0-9_]{0,80}$/u)
    ? errorRecord.code : isCancelledRequestError(error) ? "REQUEST_CANCELLED" : "REQUEST_FAILED";
  const serverRequestId = [details?.requestId, details?.serverRequestId].find((value): value is string =>
    safeLogField(value, /^[A-Za-z0-9._:-]{1,128}$/u));
  const { code, path } = {
    login: { code: "ACCOUNT_LOGIN_FAILED", path: "/api/account/auth/login" },
    logout: { code: "ACCOUNT_LOGOUT_FAILED", path: "/api/account/me/logout" },
    cancel: { code: "ACCOUNT_CANCEL_FAILED", path: "/api/account/me/cancel" },
    "rotate-default-key": { code: "ACCOUNT_DEFAULT_KEY_ROTATION_FAILED", path: "/api/account/me/default-key/rotate" },
    profile: { code: "ACCOUNT_PROFILE_UPDATE_FAILED", path: "/api/account/me/profile/update" },
    avatar: { code: "ACCOUNT_AVATAR_UPDATE_FAILED", path: "/api/account/me/profile/update" },
    "send-default-key": { code: "ACCOUNT_DEFAULT_KEY_SEND_FAILED", path: "/api/account/me/default-key/send" },
    "change-password": { code: "ACCOUNT_PASSWORD_CHANGE_FAILED", path: "/api/account/me/password/change" },
    "enterprise-profile": { code: "ACCOUNT_ENTERPRISE_PROFILE_UPDATE_FAILED", path: "/api/account/enterprise/profile/update" },
    "enterprise-password": { code: "ACCOUNT_ENTERPRISE_PASSWORD_RESET_FAILED", path: "/api/account/enterprise/members/:membershipId/password/reset" },
    "enterprise-invitation": { code: "ACCOUNT_ENTERPRISE_INVITATION_RESPONSE_FAILED", path: "/api/account/me/enterprise-invitations/:invitationId/respond" },
    "enterprise-summary": { code: "ACCOUNT_ENTERPRISE_SUMMARY_FAILED", path: "/api/account/enterprise/summary" },
  }[operation];
  const logRequestId = serverRequestId ?? requestId;
  console.error(`[${code}]`, { code, requestId: logRequestId, userId: safeLogField(owner.userId, /^[A-Za-z0-9._:-]{1,128}$/u) ? owner.userId : null,
    ...(target?.enterpriseId !== undefined ? { enterpriseId: safeLogField(target.enterpriseId, /^[A-Za-z0-9._:-]{1,128}$/u) ? target.enterpriseId : null } : {}),
    ...(target?.membershipId !== undefined ? { membershipId: safeLogField(target.membershipId, /^[A-Za-z0-9._:-]{1,128}$/u) ? target.membershipId : null } : {}),
    ...(target?.invitationId !== undefined ? { invitationId: safeLogField(target.invitationId, /^[A-Za-z0-9._:-]{1,128}$/u) ? target.invitationId : null } : {}),
    ...(target?.action !== undefined ? { action: target.action === "decline" ? "decline" : "accept" } : {}),
    path, apiCode,
    cause: isCancelledRequestError(error) ? "账号请求被取消"
      : error instanceof TypeError ? "网络请求或响应解析失败" : "账号接口请求失败" });
  return logRequestId;
}

function downloadBlobFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function normalizeEnterpriseScopeId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function resolveRequestedEnterpriseScopeId(
  config: ReturnType<typeof useConfigStore>,
  enterpriseId?: string | null,
): string | null {
  return normalizeEnterpriseScopeId(enterpriseId) ?? normalizeEnterpriseScopeId(config.userSummary?.enterpriseId ?? null);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/** 标准化企业成员列表排序字段，只允许共享契约中的成员字段。 */
function normalizeEnterpriseMemberSortBy(
  value: EnterpriseMemberSortByState | undefined,
  fallback: EnterpriseMemberSortByState,
): EnterpriseMemberSortByState {
  const next = value === undefined ? fallback : value;
  return next === "joinedAt" || next === "email" ? next : "";
}

/** 标准化企业成员列表排序方向，清空排序时方向也置空。 */
function normalizeEnterpriseMemberSortDirection(
  value: EnterpriseMemberSortDirectionState | undefined,
  fallback: EnterpriseMemberSortDirectionState,
  sortBy: EnterpriseMemberSortByState,
): EnterpriseMemberSortDirectionState {
  if (!sortBy) return "";
  const next = value === undefined ? fallback : value;
  return next === "desc" ? "desc" : "asc";
}

export const useAccountStore = defineStore("account", {
  state: () => ({
    accountDrawerOpen: false,
    accountDrawerTab: "overview" as AccountDrawerTab,
    accountDrawerSurface: "default" as AccountDrawerSurface,
    enterpriseDrawerOpen: false,

    meSummary: null as AccountMeSummaryResponseBody | null,
    meLoading: false,
    meLoadError: null as { code: string; message: string; requestId: string } | null,
    savingMeProfile: false,

    enterpriseSummary: null as EnterpriseSummaryResponseBody | null,
    enterpriseScopeId: null as string | null,
    enterpriseMembers: [] as EnterpriseMemberItem[],
    enterpriseMembersTotal: 0,
    enterpriseMembersPage: 1,
    enterpriseMembersPageSize: 20,
    enterpriseMembersSortBy: "" as EnterpriseMemberSortByState,
    enterpriseMembersSortDirection: "" as EnterpriseMemberSortDirectionState,
    enterpriseLoading: false,
    enterpriseAuditLogs: [] as AuditLogItem[],
    enterpriseAuditTotal: 0,
    enterpriseAuditLoading: false,
    exportingEnterpriseAudit: false,

    candidateKeyword: "",
    enterpriseCandidates: [] as EnterpriseCandidateItem[],
    candidateLoading: false,

    sendingDefaultKey: false,
    rotatingDefaultKey: false,
    changingPassword: false,
    cancellingAccount: false,
    savingEnterpriseProfile: false,
    resettingEnterprisePassword: false,
    addingEnterpriseMember: false,
    respondingEnterpriseInvitation: false,
    updatingEnterpriseMemberStatus: false,
    removingEnterpriseMember: false,

    verificationCooldownUntil: {
      register: 0,
      forgot_password: 0,
    } as VerificationCooldownState,
  }),
  actions: {
    /** 账号投影重置时撤销旧资料busy归属，旧finally不影响下一账号。 */
    resetRuntimeState() {
      pendingProfileUpdates.delete(this);
      this.clearMeSummaryAutoRefresh();
      this.clearEnterpriseAutoRefresh();
      meSummaryLoadedAt = 0;
      meSummaryRequestRevision += 1;
      meSummaryPendingRequest = null;
      this.accountDrawerOpen = false;
      this.accountDrawerTab = "overview";
      this.accountDrawerSurface = "default";
      this.enterpriseDrawerOpen = false;
      this.meSummary = null;
      this.meLoading = false;
      this.meLoadError = null;
      this.savingMeProfile = false;
      this.enterpriseSummary = null;
      this.enterpriseScopeId = null;
      this.enterpriseMembers = [];
      this.enterpriseMembersTotal = 0;
      this.enterpriseMembersPage = 1;
      this.enterpriseMembersPageSize = 20;
      this.enterpriseMembersSortBy = "";
      this.enterpriseMembersSortDirection = "";
      this.enterpriseLoading = false;
      this.enterpriseAuditLogs = [];
      this.enterpriseAuditTotal = 0;
      this.enterpriseAuditLoading = false;
      this.exportingEnterpriseAudit = false;
      this.candidateKeyword = "";
      this.enterpriseCandidates = [];
      this.candidateLoading = false;
      this.sendingDefaultKey = false;
      this.rotatingDefaultKey = false;
      this.changingPassword = false;
      this.cancellingAccount = false;
      this.savingEnterpriseProfile = false;
      this.resettingEnterprisePassword = false;
      this.addingEnterpriseMember = false;
      this.respondingEnterpriseInvitation = false;
      this.updatingEnterpriseMemberStatus = false;
      this.removingEnterpriseMember = false;
      invalidateEnterprisePendingRequests();
      enterpriseLoadingRequestCount = 0;
    },

    /** Reset enterprise view state when switching scopes and block stale request writes. */
    applyEnterpriseScope(scopeId: string | null) {
      const normalizedScopeId = normalizeEnterpriseScopeId(scopeId);
      if (this.enterpriseScopeId === normalizedScopeId) {
        return false;
      }
      this.enterpriseScopeId = normalizedScopeId;
      this.enterpriseSummary = null;
      this.enterpriseMembers = [];
      this.enterpriseMembersTotal = 0;
      this.enterpriseMembersPage = 1;
      this.enterpriseMembersPageSize = 20;
      this.enterpriseMembersSortBy = "";
      this.enterpriseMembersSortDirection = "";
      this.enterpriseCandidates = [];
      this.candidateKeyword = "";
      this.enterpriseAuditLogs = [];
      this.enterpriseAuditTotal = 0;
      invalidateEnterprisePendingRequests();
      return true;
    },

    /** 使用套餐操作返回的企业摘要更新当前作用域，避免成功后再请求 summary。 */
    applyEnterpriseSummarySnapshot(scopeId: string | null, summary: EnterpriseSummaryResponseBody) {
      const summaryScopeId = normalizeEnterpriseScopeId(summary.enterpriseId);
      const normalizedScopeId = normalizeEnterpriseScopeId(scopeId) ?? summaryScopeId;
      if (this.enterpriseScopeId === normalizedScopeId) {
        invalidateEnterprisePendingRequests();
        this.enterpriseSummary = summary;
        this.enterpriseScopeId = normalizedScopeId;
      }
      const myEnterpriseId = normalizeEnterpriseScopeId(
        this.meSummary?.enterpriseSummary?.enterpriseId ?? this.meSummary?.accessContext.enterpriseId ?? null,
      );
      if (myEnterpriseId === summaryScopeId && this.meSummary) {
        this.meSummary = { ...this.meSummary, enterpriseSummary: summary };
      }
    },

    setVerificationCooldown(purpose: VerificationPurpose, cooldownSec: number) {
      this.verificationCooldownUntil[purpose] = Date.now() + Math.max(0, cooldownSec) * 1000;
    },

    async sendVerificationCode(input: {
      purpose: VerificationPurpose;
      email: string;
      captchaToken: string;
    }) {
      const config = useConfigStore();
      const result = await accountApi.sendVerificationCode(config.serverWsOrigin, input);
      if (result.ok && result.delivered) {
        this.setVerificationCooldown(input.purpose, result.cooldownSec);
      } else if (!result.ok && result.code === "EMAIL_SEND_COOLDOWN") {
        const details = (result.details ?? {}) as Record<string, unknown>;
        const retryAfterSec = Number(details.retryAfterSec ?? 0);
        if (retryAfterSec > 0) {
          this.setVerificationCooldown(input.purpose, retryAfterSec);
        }
      }
      return result;
    },

    async checkVerificationEmail(input: {
      purpose: VerificationPurpose;
      email: string;
    }) {
      const config = useConfigStore();
      return await accountApi.checkVerificationEmail(config.serverWsOrigin, input);
    },

    /** 校验企业名称是否可用于企业管理员注册。 */
    async checkEnterpriseName(input: { enterpriseName: string }) {
      const config = useConfigStore();
      return await accountApi.checkEnterpriseName(config.serverWsOrigin, input);
    },

    async fetchCaptchaChallenge(theme?: "light" | "dark") {
      const config = useConfigStore();
      return await accountApi.getCaptchaChallenge(config.serverWsOrigin, theme);
    },

    async fetchNumericCaptchaChallenge(theme?: "light" | "dark") {
      const config = useConfigStore();
      return await accountApi.getNumericCaptchaChallenge(config.serverWsOrigin, theme);
    },

    async register(input: AccountRegisterRequestBody) {
      const config = useConfigStore();
      return await accountApi.registerAccount(config.serverWsOrigin, input);
    },

    /** 固定本次登录输入；桌面先撤旧关联并在真实关联完成后复核账号。 */
    async login(input: {
      email: string;
      password: string;
      captchaToken: string;
    }) {
      const config = useConfigStore();
      const revision = (accountLoginRevisions.get(this) ?? 0) + 1;
      accountLoginRevisions.set(this, revision);
      const owner = captureAccountSession(config);
      const body = { ...input }, secrets = [body.password, body.captchaToken];
      const serverWsOrigin = config.serverWsOrigin;
      /** 同一入口复用原修订号；普通浏览器同样禁止迟到登录覆盖新选择。 */
      const assertCurrent = () => {
        if (accountLoginRevisions.get(this) !== revision || config.serverWsOrigin !== serverWsOrigin || config.logoutInProgress) {
          throw createCancelledRequestError("scope-change");
        }
      };
      if (config.isDesktop) await config.unlinkDesktopCloudAccount();
      assertCurrent();
      owner.assertCurrent();
      let result: Awaited<ReturnType<typeof accountApi.loginAccount>>;
      try {
        result = await accountApi.loginAccount(serverWsOrigin, body);
      } catch (error) {
        if (!isCancelledRequestError(error) || error.kind !== "scope-change") reportAccountSessionFailure(error, "login", owner, config, undefined, secrets);
        throw error;
      }
      assertCurrent();
      owner.assertCurrent();
      if (result.ok) {
        config.setAccountSession(result);
        this.resetRuntimeState();
        const appliedOwner = captureAccountSession(config);
        if (config.isDesktop) {
          try { await config.syncDesktopCloudAccount(); }
          catch (error) {
            // 关联失败不阻断网页登录；后续壳同步会重试，状态由 config 独立呈现。
            const code = (error as { code?: unknown })?.code;
            console.warn("[DESKTOP_CLOUD_ACCOUNT_LINK_DEFERRED]", {
              code: typeof code === "string" ? code : "DESKTOP_CLOUD_ACCOUNT_FAILED",
            });
          }
        }
        assertCurrent();
        appliedOwner.assertCurrent();
      } else {
        reportAccountSessionFailure(createApiResultError(result), "login", owner, config, undefined, secrets);
      }
      return result;
    },

    async forgotPassword(input: {
      email: string;
      verificationCode: string;
      newPassword: string;
      confirmPassword: string;
    }) {
      const config = useConfigStore();
      return await accountApi.forgotPassword(config.serverWsOrigin, input);
    },

    /** 注销发起时账号，旧响应不得清新会话，旧 finally 不修改新操作的忙状态。 */
    async cancelAccount(input: CancelMyAccountRequestBody) {
      const config = useConfigStore();
      const owner = captureAccountSession(config);
      const request = {};
      pendingAccountCancellations.set(this, request);
      this.cancellingAccount = true;
      try {
        accountLoginRevisions.set(this, (accountLoginRevisions.get(this) ?? 0) + 1);
        if (config.isDesktop) await config.unlinkDesktopCloudAccount();
        owner.assertCurrent();
        try {
          const result = await accountApi.cancelMyAccount(owner.requestContext, input);
          if (result.ok) {
            owner.assertCurrent();
            this.resetRuntimeState();
            config.logout();
          } else {
            reportAccountSessionFailure(createApiResultError(result), "cancel", owner, config);
          }
          return result;
        } catch (error) {
          if (!isCancelledRequestError(error) || error.kind !== "scope-change") reportAccountSessionFailure(error, "cancel", owner, config);
          throw error;
        }
      } finally {
        if (pendingAccountCancellations.get(this) === request) {
          pendingAccountCancellations.delete(this);
          this.cancellingAccount = false;
        }
      }
    },

    /** 仅撤销发起时的会话；桌面先 unlink，失败或 owner 改变时停止后续清理。 */
    async logout() {
      const config = useConfigStore();
      const owner = captureAccountSession(config);
      accountLoginRevisions.set(this, (accountLoginRevisions.get(this) ?? 0) + 1);
      if (config.isDesktop) await config.unlinkDesktopCloudAccount();
      owner.assertCurrent();
      if (config.authMode === "account" && config.sessionToken) {
        try {
          const result = await accountApi.logoutMySession(owner.requestContext);
          if (!result.ok) throw createApiResultError(result);
          owner.assertCurrent();
        } catch (error) {
          if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
          reportAccountSessionFailure(error, "logout", owner, config);
          throw error;
        }
      }
      this.resetRuntimeState();
      config.logout();
    },

    /** 加载当前账号概况；认证清理绑定发起owner，静默刷新可复用新鲜缓存。 */
    async loadMeSummary(force = false, options?: LoadMeSummaryOptions) {
      if (this.meSummary && !force) return this.meSummary;
      const config = useConfigStore();
      const silent = Boolean(options?.silent);
      const maxAgeMs = normalizePositiveInteger(options?.maxAgeMs, 0);
      if (this.meSummary && force && silent && maxAgeMs > 0 && Date.now() - meSummaryLoadedAt < maxAgeMs) {
        return this.meSummary;
      }
      const scope = meSummaryScope(config);
      const owner = options?.owner ?? captureAccountSession(config);
      if (meSummaryPendingRequest?.scope === scope) {
        return await meSummaryPendingRequest.promise;
      }

      const revision = ++meSummaryRequestRevision;
      const requestId = `account-summary-${Date.now()}-${revision}`;
      const userId = config.userSummary?.userId ?? null;
      const isCurrent = () => revision === meSummaryRequestRevision && owner.isCurrentResponse();
      this.meLoadError = null;
      if (!silent) {
        this.meLoading = true;
      }

      const promise = (async () => {
        try {
          const result = await accountApi.getMeSummary(owner.requestContext);
          if (!isCurrent()) return null;
          if (result.ok) {
            this.meSummary = result;
            meSummaryLoadedAt = Date.now();
            config.applyAccountProfile(result);
            return result;
          }
          // 不记录整个响应或原始 message，避免接口异常时回显 Key / token。
          const apiCode = /^[A-Z][A-Z0-9_]{0,80}$/.test(result.code) ? result.code : "REQUEST_FAILED";
          this.meLoadError = { code: apiCode, message: `读取账号信息失败（${apiCode}），请重试。`, requestId };
          console.error("[ACCOUNT_ME_SUMMARY_FAILED]", { code: "ACCOUNT_ME_SUMMARY_FAILED", requestId, userId, path: "/api/account/me/summary", apiCode, cause: "账号概况接口返回失败" });
          return null;
        } catch (error) {
          if (!isCurrent()) return null;
          this.meLoadError = { code: "NETWORK_ERROR", message: "读取账号信息失败，请检查与 Server 的网络连接后重试。", requestId };
          console.error("[ACCOUNT_ME_SUMMARY_FAILED]", { code: "ACCOUNT_ME_SUMMARY_FAILED", requestId, userId, path: "/api/account/me/summary", cause: error instanceof TypeError ? "网络请求或响应解析失败" : "账号概况请求异常" });
          throw error;
        }
      })();
      meSummaryPendingRequest = { scope, owner, promise };

      try {
        return await promise;
      } finally {
        if (revision === meSummaryRequestRevision) {
          meSummaryPendingRequest = null;
          this.meLoading = false;
        }
      }
    },

    /** 打开账号中心，并允许 H5 入口指定独立内容页。 */
    async openAccountDrawer(options: OpenAccountDrawerOptions = {}) {
      this.accountDrawerTab = options.tab ?? "overview";
      this.accountDrawerSurface = options.surface ?? "default";
      this.accountDrawerOpen = true;
      trackProductEvent("account_center_open", {
        source: "user_menu",
      });
      this.ensureMeSummaryAutoRefresh();
      await this.loadMeSummary(true, { silent: Boolean(this.meSummary) });
    },

    closeAccountDrawer() {
      this.clearMeSummaryAutoRefresh();
      this.accountDrawerOpen = false;
    },

    ensureMeSummaryAutoRefresh() {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return;
      }
      const refresh = () => {
        if (!this.accountDrawerOpen || document.hidden) return;
        void this.loadMeSummary(true, { silent: true });
      };

      this.clearMeSummaryAutoRefresh();
      meSummaryRefreshTimer = window.setInterval(refresh, ME_SUMMARY_REFRESH_INTERVAL_MS);
      meSummaryFocusHandler = refresh;
      meSummaryVisibilityHandler = () => {
        if (!document.hidden) {
          refresh();
        }
      };
      window.addEventListener("focus", meSummaryFocusHandler);
      document.addEventListener("visibilitychange", meSummaryVisibilityHandler);
    },

    clearMeSummaryAutoRefresh() {
      if (typeof window !== "undefined" && meSummaryFocusHandler) {
        window.removeEventListener("focus", meSummaryFocusHandler);
      }
      if (typeof document !== "undefined" && meSummaryVisibilityHandler) {
        document.removeEventListener("visibilitychange", meSummaryVisibilityHandler);
      }
      if (meSummaryRefreshTimer != null) {
        clearInterval(meSummaryRefreshTimer);
      }
      meSummaryRefreshTimer = null;
      meSummaryFocusHandler = null;
      meSummaryVisibilityHandler = null;
    },

    /** 邮件请求与后置刷新均绑定原会话，刷新失败不伪造整个流程成功。 */
    async sendDefaultKey() {
      const config = useConfigStore();
      const owner = captureAccountSession(config), request = {};
      pendingDefaultKeySends.set(this, request);
      this.sendingDefaultKey = true;
      let refreshing = false;
      const refreshMessage = "默认 Key 已发送，但账号资料刷新失败，请重新打开账号面板";
      try {
        const result = await accountApi.sendMyDefaultKey(owner.requestContext);
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          refreshing = true;
          const refreshOwner = meSummaryPendingRequest?.scope === meSummaryScope(config) ? meSummaryPendingRequest.owner : owner;
          let summary: AccountMeSummaryResponseBody | null;
          try { summary = await this.loadMeSummary(true, { owner: refreshOwner }); }
          catch (error) {
            refreshOwner.assertResponseCurrent();
            if (isCancelledRequestError(error)) throw error;
            throw Object.assign(new Error(refreshMessage, { cause: error }), {
              code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" : "CLIENT_ERROR",
              details: { operationCompleted: true, requestId: this.meLoadError?.requestId },
            });
          }
          refreshOwner.assertResponseCurrent();
          if (!summary) return { ok: false as const, code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" as const : "CLIENT_ERROR" as const, message: refreshMessage,
            details: { operationCompleted: true, requestId: this.meLoadError?.requestId } };
          owner.assertCurrent();
        } else reportAccountSessionFailure(createApiResultError(result), "send-default-key", owner, config);
        return result;
      } catch (error) {
        if (!refreshing && (!isCancelledRequestError(error) || error.kind !== "scope-change")) reportAccountSessionFailure(error, "send-default-key", owner, config);
        throw error;
      } finally {
        if (pendingDefaultKeySends.get(this) === request) {
          pendingDefaultKeySends.delete(this);
          this.sendingDefaultKey = false;
        }
      }
    },

    /** 轮换结果只应用于发起会话，旧请求不能清新认证或释放新操作的忙状态。 */
    async rotateDefaultKey() {
      const config = useConfigStore();
      const owner = captureAccountSession(config);
      const request = {};
      pendingDefaultKeyRotations.set(this, request);
      this.rotatingDefaultKey = true;
      try {
        const result = await accountApi.rotateMyDefaultKey(owner.requestContext);
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          config.setAccountSession(result);
          this.meSummary = result.summary;
          config.applyAccountProfile(result.summary);
          const appliedOwner = captureAccountSession(config);
          return { ...result, assertCurrent: appliedOwner.assertCurrent };
        } else {
          reportAccountSessionFailure(createApiResultError(result), "rotate-default-key", owner, config);
        }
        return result;
      } catch (error) {
        if (!isCancelledRequestError(error) || error.kind !== "scope-change") reportAccountSessionFailure(error, "rotate-default-key", owner, config);
        throw error;
      } finally {
        if (pendingDefaultKeyRotations.get(this) === request) {
          pendingDefaultKeyRotations.delete(this);
          this.rotatingDefaultKey = false;
        }
      }
    },

    /** 密码提交成功后不重发；刷新失败保完成事实，日志排除本次全部密码。 */
    async changePassword(input: { oldPassword: string; newPassword: string; confirmPassword: string }) {
      const config = useConfigStore();
      const owner = captureAccountSession(config), request = {};
      const body = { ...input }, secrets = [body.oldPassword, body.newPassword, body.confirmPassword];
      pendingPasswordChanges.set(this, request);
      this.changingPassword = true;
      let refreshing = false;
      const refreshMessage = "密码已修改，但账号资料刷新失败，请重新打开账号面板";
      try {
        const result = await accountApi.changeMyPassword(owner.requestContext, body);
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          refreshing = true;
          const refreshOwner = meSummaryPendingRequest?.scope === meSummaryScope(config) ? meSummaryPendingRequest.owner : owner;
          let summary: AccountMeSummaryResponseBody | null;
          try { summary = await this.loadMeSummary(true, { owner: refreshOwner }); }
          catch (error) {
            refreshOwner.assertResponseCurrent();
            if (isCancelledRequestError(error)) throw error;
            throw Object.assign(new Error(refreshMessage, { cause: error }), {
              code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" : "CLIENT_ERROR",
              details: { operationCompleted: true, requestId: this.meLoadError?.requestId },
            });
          }
          refreshOwner.assertResponseCurrent();
          if (!summary) return { ok: false as const, code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" as const : "CLIENT_ERROR" as const, message: refreshMessage,
            details: { operationCompleted: true, requestId: this.meLoadError?.requestId } };
          owner.assertCurrent();
        } else reportAccountSessionFailure(createApiResultError(result), "change-password", owner, config, undefined, secrets);
        return result;
      } catch (error) {
        if (!refreshing && (!isCancelledRequestError(error) || error.kind !== "scope-change")) reportAccountSessionFailure(error, "change-password", owner, config, undefined, secrets);
        throw error;
      } finally {
        if (pendingPasswordChanges.get(this) === request) {
          pendingPasswordChanges.delete(this);
          this.changingPassword = false;
        }
      }
    },

    /** 只更新发起会话的资料，失败保持原API结果或异常。 */
    async updateMyProfile(input: { fullName: string; phone: string; avatarUrl: string | null }) {
      const config = useConfigStore();
      const owner = captureAccountSession(config), release = trackProfileUpdate(this, config);
      this.savingMeProfile = true;
      try {
        const result = await accountApi.updateMyProfile(owner.requestContext, input);
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          this.meSummary = result;
          config.applyAccountProfile(result);
        } else reportAccountSessionFailure(createApiResultError(result), "profile", owner, config);
        return result;
      } catch (error) {
        if (!isCancelledRequestError(error) || error.kind !== "scope-change") reportAccountSessionFailure(error, "profile", owner, config);
        throw error;
      } finally {
        if (release()) this.savingMeProfile = false;
      }
    },

    /** 头像预加载与保存共享原owner，任何前置失败都不提交后续POST。 */
    async updateMyAvatar(avatarUrl: string | null): Promise<ApiResult<AccountMeSummaryResponseBody>> {
      const config = useConfigStore();
      const owner = !this.meSummary && meSummaryPendingRequest?.scope === meSummaryScope(config)
        ? meSummaryPendingRequest.owner : captureAccountSession(config);
      const release = trackProfileUpdate(this, config);
      this.savingMeProfile = true;
      let loadingSummary = false;
      try {
        let summary = this.meSummary;
        if (!summary) {
          loadingSummary = true;
          summary = await this.loadMeSummary(true, { silent: true, owner });
          loadingSummary = false;
        }
        owner.assertResponseCurrent();
        if (!summary) {
          return {
            ok: false,
            code: this.meLoadError?.code === "UNAUTHORIZED" ? "UNAUTHORIZED" : "CLIENT_ERROR",
            message: this.meLoadError?.message ?? "未获取到当前个人资料，请稍后重试",
          };
        }

        owner.assertCurrent();
        if (summary.userId !== owner.userId) throw createCancelledRequestError("scope-change");
        const result = await accountApi.updateMyProfile(owner.requestContext, {
          fullName: summary.fullName,
          phone: summary.phone,
          avatarUrl,
        });
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          this.meSummary = result;
          config.applyAccountProfile(result);
        } else reportAccountSessionFailure(createApiResultError(result), "avatar", owner, config);
        return result;
      } catch (error) {
        if (!loadingSummary && (!isCancelledRequestError(error) || error.kind !== "scope-change")) reportAccountSessionFailure(error, "avatar", owner, config);
        throw error;
      } finally {
        if (release()) this.savingMeProfile = false;
      }
    },

    /** 读取当前企业摘要；失败显式传播，过期响应不得写入其他作用域。 */
    async loadEnterpriseSummary(force = false, options?: { silent?: boolean; enterpriseId?: string | null }) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, options?.enterpriseId);
      const scopeChanged = this.applyEnterpriseScope(scopeId);
      if (this.enterpriseSummary && !force && !scopeChanged) return this.enterpriseSummary;
      const silent = Boolean(options?.silent);
      const requestRevision = enterpriseDataRevision;
      if (enterpriseSummaryPendingRequest?.scopeId === scopeId && enterpriseSummaryPendingRequest.revision === requestRevision) {
        return await enterpriseSummaryPendingRequest.promise;
      }

      if (!silent) {
        enterpriseLoadingRequestCount += 1;
        this.enterpriseLoading = true;
      }

      enterpriseSummaryPendingRequest = {
        scopeId,
        revision: requestRevision,
        promise: (async () => {
          const owner = captureAccountSession(config);
          let result;
          try {
            result = await accountApi.getEnterpriseSummary(owner.requestContext, { enterpriseId: scopeId ?? undefined });
            owner.assertResponseCurrent();
            if (!result.ok) throw createApiResultError(result);
          } catch (error) {
            if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
            const requestId = reportAccountSessionFailure(error, "enterprise-summary", owner, config, { enterpriseId: scopeId });
            throw Object.assign(new Error("企业资格加载失败，请重试", { cause: error }), { details: { requestId } });
          }
          owner.assertCurrent();
          if (this.enterpriseScopeId === scopeId && enterpriseDataRevision === requestRevision) {
            this.enterpriseSummary = result;
            this.enterpriseScopeId = normalizeEnterpriseScopeId(result.enterpriseId);
          }
          return result;
        })(),
      };

      try {
        return await enterpriseSummaryPendingRequest.promise;
      } finally {
        if (enterpriseSummaryPendingRequest?.scopeId === scopeId && enterpriseSummaryPendingRequest.revision === requestRevision) {
          enterpriseSummaryPendingRequest = null;
        }
        if (!silent) {
          enterpriseLoadingRequestCount = Math.max(0, enterpriseLoadingRequestCount - 1);
          this.enterpriseLoading = enterpriseLoadingRequestCount > 0;
        }
      }
    },

    /** 按当前企业作用域拉取成员分页，并把页码状态保存在 store 里供自动刷新复用。 */
    async loadEnterpriseMembers(
      force = false,
      options?: LoadEnterpriseMembersOptions,
    ): Promise<EnterpriseMemberItem[]> {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, options?.enterpriseId);
      const scopeChanged = this.applyEnterpriseScope(scopeId);
      const requestedPage = normalizePositiveInteger(options?.page, this.enterpriseMembersPage);
      const requestedPageSize = normalizePositiveInteger(options?.pageSize, this.enterpriseMembersPageSize);
      const requestedSortBy = normalizeEnterpriseMemberSortBy(options?.sortBy, this.enterpriseMembersSortBy);
      const requestedSortDirection = normalizeEnterpriseMemberSortDirection(
        options?.sortDirection,
        this.enterpriseMembersSortDirection,
        requestedSortBy,
      );
      const queryKey = `${requestedPage}:${requestedPageSize}:${requestedSortBy}:${requestedSortDirection}`;
      const currentQueryKey = `${this.enterpriseMembersPage}:${this.enterpriseMembersPageSize}:${this.enterpriseMembersSortBy}:${this.enterpriseMembersSortDirection}`;
      if (this.enterpriseMembers.length && !force && !scopeChanged && queryKey === currentQueryKey) {
        return this.enterpriseMembers;
      }
      const silent = Boolean(options?.silent);
      const requestRevision = enterpriseDataRevision;
      if (enterpriseMembersPendingRequest?.scopeId === scopeId && enterpriseMembersPendingRequest.queryKey === queryKey && enterpriseMembersPendingRequest.revision === requestRevision) {
        return await enterpriseMembersPendingRequest.promise;
      }

      if (!silent) {
        enterpriseLoadingRequestCount += 1;
        this.enterpriseLoading = true;
      }

      enterpriseMembersPendingRequest = {
        scopeId,
        queryKey,
        revision: requestRevision,
        promise: (async (): Promise<EnterpriseMemberItem[]> => {
          const result = await accountApi.listEnterpriseMembers(createApiContext(config), {
            enterpriseId: scopeId ?? undefined,
            offset: (requestedPage - 1) * requestedPageSize,
            limit: requestedPageSize,
            sortBy: requestedSortBy || undefined,
            sortDirection: requestedSortBy ? requestedSortDirection || undefined : undefined,
          });
          if (result.ok) {
            const totalPages = Math.max(1, Math.ceil(result.total / requestedPageSize));
            if (requestedPage > totalPages && result.total > 0) {
              return await this.loadEnterpriseMembers(true, {
                silent,
                enterpriseId: scopeId,
                page: totalPages,
                pageSize: requestedPageSize,
                sortBy: requestedSortBy,
                sortDirection: requestedSortDirection,
              });
            }
            if (this.enterpriseScopeId === scopeId && enterpriseDataRevision === requestRevision) {
              this.enterpriseMembers = result.items;
              this.enterpriseMembersTotal = result.total;
              this.enterpriseMembersPage = requestedPage;
              this.enterpriseMembersPageSize = requestedPageSize;
              this.enterpriseMembersSortBy = requestedSortBy;
              this.enterpriseMembersSortDirection = requestedSortDirection;
            }
            return result.items;
          }
          return [];
        })(),
      };

      try {
        return await enterpriseMembersPendingRequest.promise;
      } finally {
        if (enterpriseMembersPendingRequest?.scopeId === scopeId && enterpriseMembersPendingRequest.queryKey === queryKey && enterpriseMembersPendingRequest.revision === requestRevision) {
          enterpriseMembersPendingRequest = null;
        }
        if (!silent) {
          enterpriseLoadingRequestCount = Math.max(0, enterpriseLoadingRequestCount - 1);
          this.enterpriseLoading = enterpriseLoadingRequestCount > 0;
        }
      }
    },

    async openEnterpriseDrawer() {
      this.enterpriseDrawerOpen = true;
      trackProductEvent("enterprise_center_open", {
        source: "account_center",
      });
      this.ensureEnterpriseAutoRefresh();
      await Promise.all([
        this.loadEnterpriseSummary(true, { silent: Boolean(this.enterpriseSummary) }),
        this.loadEnterpriseMembers(true, {
          silent: Boolean(this.enterpriseMembers.length),
          page: this.enterpriseMembersPage,
          pageSize: this.enterpriseMembersPageSize,
        }),
      ]);
    },

    closeEnterpriseDrawer() {
      this.clearEnterpriseAutoRefresh();
      this.enterpriseDrawerOpen = false;
      this.enterpriseCandidates = [];
      this.candidateKeyword = "";
      this.enterpriseAuditLogs = [];
      this.enterpriseAuditTotal = 0;
    },

    ensureEnterpriseAutoRefresh() {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return;
      }
      const refresh = () => {
        if (!this.enterpriseDrawerOpen || document.hidden) return;
        void Promise.all([
          this.loadEnterpriseSummary(true, { silent: true }),
          this.loadEnterpriseMembers(true, {
            silent: true,
            page: this.enterpriseMembersPage,
            pageSize: this.enterpriseMembersPageSize,
          }),
        ]);
      };

      this.clearEnterpriseAutoRefresh();
      enterpriseRefreshTimer = window.setInterval(refresh, ENTERPRISE_DRAWER_REFRESH_INTERVAL_MS);
      enterpriseFocusHandler = refresh;
      enterpriseVisibilityHandler = () => {
        if (!document.hidden) {
          refresh();
        }
      };
      window.addEventListener("focus", enterpriseFocusHandler);
      document.addEventListener("visibilitychange", enterpriseVisibilityHandler);
    },

    clearEnterpriseAutoRefresh() {
      if (typeof window !== "undefined" && enterpriseFocusHandler) {
        window.removeEventListener("focus", enterpriseFocusHandler);
      }
      if (typeof document !== "undefined" && enterpriseVisibilityHandler) {
        document.removeEventListener("visibilitychange", enterpriseVisibilityHandler);
      }
      if (enterpriseRefreshTimer != null) {
        clearInterval(enterpriseRefreshTimer);
      }
      enterpriseRefreshTimer = null;
      enterpriseFocusHandler = null;
      enterpriseVisibilityHandler = null;
    },

    async searchEnterpriseCandidates(keyword: string, enterpriseId?: string | null) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      this.applyEnterpriseScope(scopeId);
      this.candidateKeyword = keyword.trim();
      this.candidateLoading = true;
      try {
        const result = await accountApi.searchEnterpriseCandidates(createApiContext(config), this.candidateKeyword, scopeId);
        if (result.ok) {
          if (this.enterpriseScopeId === scopeId) {
            this.enterpriseCandidates = result.items;
          }
        }
        return result;
      } finally {
        this.candidateLoading = false;
      }
    },

    /** 邀请成员成功后刷新当前分页，让成员管理立即显示“邀请中”行。 */
    async addEnterpriseMember(email: string, enterpriseId?: string | null) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      this.applyEnterpriseScope(scopeId);
      this.addingEnterpriseMember = true;
      try {
        const result = await accountApi.addEnterpriseMember(createApiContext(config), { email, enterpriseId: scopeId ?? undefined });
        if (result.ok) {
          await this.loadEnterpriseMembers(true, {
            silent: true,
            enterpriseId: scopeId,
            page: this.enterpriseMembersPage,
            pageSize: this.enterpriseMembersPageSize,
          });
        }
        return result;
      } finally {
        this.addingEnterpriseMember = false;
      }
    },

    /** 邀请处理与资料刷新绑定发起账号，已完成的邀请操作不因刷新失败而重发。 */
    async respondEnterpriseInvitation(invitationId: string, action: RespondEnterpriseInvitationRequestBody["action"]) {
      const config = useConfigStore();
      const owner = captureAccountSession(config), request = {}, target = { invitationId, action };
      pendingEnterpriseInvitationResponses.set(this, request);
      this.respondingEnterpriseInvitation = true;
      let refreshing = false;
      const refreshMessage = `邀请已${action === "accept" ? "接受" : "拒绝"}，但账号资料刷新失败，请重新打开账号面板`;
      try {
        const result = await accountApi.respondEnterpriseInvitation(owner.requestContext, invitationId, { action });
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          refreshing = true;
          const pendingSummary = meSummaryPendingRequest?.scope === meSummaryScope(config) ? meSummaryPendingRequest : null;
          const refreshOwner = pendingSummary?.owner ?? owner;
          let summary: AccountMeSummaryResponseBody | null;
          try {
            summary = await this.loadMeSummary(true, { silent: true, owner: refreshOwner });
            if (pendingSummary && summary) {
              owner.assertCurrent();
              summary = await this.loadMeSummary(true, { silent: true, owner });
            }
          }
          catch (error) {
            refreshOwner.assertResponseCurrent();
            if (isCancelledRequestError(error)) throw error;
            throw Object.assign(new Error(refreshMessage, { cause: error }), {
              code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" : "CLIENT_ERROR",
              details: { operationCompleted: true, requestId: this.meLoadError?.requestId },
            });
          }
          refreshOwner.assertResponseCurrent();
          if (!summary) return { ok: false as const, code: !config.sessionToken && !config.userSummary ? "UNAUTHORIZED" as const : "CLIENT_ERROR" as const,
            message: refreshMessage, details: { operationCompleted: true, requestId: this.meLoadError?.requestId } };
          owner.assertCurrent();
        } else {
          const requestId = reportAccountSessionFailure(createApiResultError(result), "enterprise-invitation", owner, config, target);
          if (!config.sessionToken && !config.userSummary && result.code !== "UNAUTHORIZED") return {
            ok: false as const, code: "UNAUTHORIZED" as const, message: "账号会话已过期，请重新登录", details: { requestId, causeCode: result.code },
          };
        }
        return result;
      } catch (error) {
        if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
        if (!refreshing) {
          owner.assertResponseCurrent();
          const requestId = reportAccountSessionFailure(error, "enterprise-invitation", owner, config, target);
          if (!config.sessionToken && !config.userSummary && !isCancelledRequestError(error)) throw Object.assign(
            new Error("账号会话已过期，请重新登录", { cause: error }), { code: "UNAUTHORIZED", details: { requestId } },
          );
        }
        throw error;
      } finally {
        if (pendingEnterpriseInvitationResponses.get(this) === request) {
          pendingEnterpriseInvitationResponses.delete(this);
          this.respondingEnterpriseInvitation = false;
        }
      }
    },

    /** 企业资料响应只更新发起账号，同企业的新账号也不可接收旧结果。 */
    async updateEnterpriseProfile(
      input: { name?: string; contactName?: string; contactEmail?: string; contactPhone?: string },
      enterpriseId?: string | null,
    ) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      const owner = captureAccountSession(config), request = {};
      pendingEnterpriseProfileUpdates.set(this, request);
      this.applyEnterpriseScope(scopeId);
      this.savingEnterpriseProfile = true;
      try {
        const result = await accountApi.updateEnterpriseProfile(owner.requestContext, {
          ...input,
          enterpriseId: scopeId ?? undefined,
        });
        owner.assertResponseCurrent();
        if (result.ok) {
          owner.assertCurrent();
          if (this.enterpriseScopeId === scopeId) {
            this.enterpriseSummary = result;
            this.enterpriseScopeId = normalizeEnterpriseScopeId(result.enterpriseId);
          }
          if (this.meSummary?.enterpriseSummary?.enterpriseId === result.enterpriseId) {
            this.meSummary = {
              ...this.meSummary,
              enterpriseSummary: result,
            };
          }
        } else reportAccountSessionFailure(createApiResultError(result), "enterprise-profile", owner, config, { enterpriseId: scopeId });
        return result;
      } catch (error) {
        if (!isCancelledRequestError(error) || error.kind !== "scope-change") reportAccountSessionFailure(error, "enterprise-profile", owner, config, { enterpriseId: scopeId });
        throw error;
      } finally {
        if (pendingEnterpriseProfileUpdates.get(this) === request) {
          pendingEnterpriseProfileUpdates.delete(this);
          this.savingEnterpriseProfile = false;
        }
      }
    },

    /** 固定重置输入与日志排除值，响应及busy仅归发起会话。 */
    async resetEnterpriseMemberPassword(membershipId: string, input: { newPassword: string; confirmPassword: string }) {
      const config = useConfigStore();
      const owner = captureAccountSession(config), request = {}, enterpriseId = this.enterpriseScopeId ?? config.userSummary?.enterpriseId ?? null;
      const body = { ...input }, secrets = [body.newPassword, body.confirmPassword];
      pendingEnterprisePasswordResets.set(this, request);
      this.resettingEnterprisePassword = true;
      try {
        const result = await accountApi.resetEnterpriseMemberPassword(owner.requestContext, membershipId, body);
        owner.assertResponseCurrent();
        if (result.ok) owner.assertCurrent();
        else {
          const requestId = reportAccountSessionFailure(createApiResultError(result), "enterprise-password", owner, config, { enterpriseId, membershipId }, secrets);
          if (!config.sessionToken && !config.userSummary && result.code !== "UNAUTHORIZED") return {
            ok: false as const, code: "UNAUTHORIZED" as const, message: "账号会话已过期，请重新登录", details: { requestId, causeCode: result.code },
          };
        }
        return result;
      } catch (error) {
        if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
        owner.assertResponseCurrent();
        const requestId = reportAccountSessionFailure(error, "enterprise-password", owner, config, { enterpriseId, membershipId }, secrets);
        if (!config.sessionToken && !config.userSummary && !isCancelledRequestError(error)) throw Object.assign(
          new Error("账号会话已过期，请重新登录", { cause: error }), { code: "UNAUTHORIZED", details: { requestId } },
        );
        throw error;
      } finally {
        if (pendingEnterprisePasswordResets.get(this) === request) {
          pendingEnterprisePasswordResets.delete(this);
          this.resettingEnterprisePassword = false;
        }
      }
    },

    async updateEnterpriseMemberStatus(membershipId: string, status: "active" | "disabled", enterpriseId?: string | null) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      this.applyEnterpriseScope(scopeId);
      this.updatingEnterpriseMemberStatus = true;
      try {
        const result = await accountApi.updateEnterpriseMemberStatus(createApiContext(config), membershipId, { status });
        if (result.ok) {
          await Promise.all([
            this.loadEnterpriseSummary(true, { silent: true, enterpriseId: scopeId }),
            this.loadEnterpriseMembers(true, { silent: true, enterpriseId: scopeId }),
          ]);
        }
        return result;
      } finally {
        this.updatingEnterpriseMemberStatus = false;
      }
    },

    async removeEnterpriseMember(membershipId: string, enterpriseId?: string | null) {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      this.applyEnterpriseScope(scopeId);
      this.removingEnterpriseMember = true;
      try {
        const result = await accountApi.removeEnterpriseMember(createApiContext(config), membershipId, scopeId);
        if (result.ok) {
          await Promise.all([
            this.loadEnterpriseSummary(true, { silent: true, enterpriseId: scopeId }),
            this.loadEnterpriseMembers(true, { silent: true, enterpriseId: scopeId }),
          ]);
        }
        return result;
      } finally {
        this.removingEnterpriseMember = false;
      }
    },

    /** 读取后端成员移除预览，确认目标与权限。 */
    async previewRemoveEnterpriseMember(
      membershipId: string,
      enterpriseId?: string | null,
    ): Promise<ApiResult<PreviewRemoveEnterpriseMemberResponseBody>> {
      const config = useConfigStore();
      const scopeId = resolveRequestedEnterpriseScopeId(config, enterpriseId);
      this.applyEnterpriseScope(scopeId);
      return accountApi.previewRemoveEnterpriseMember(createApiContext(config), membershipId, scopeId);
    },

    async loadEnterpriseAuditLogs(filters?: AuditLogFilters) {
      const config = useConfigStore();
      this.enterpriseAuditLoading = true;
      try {
        const result = await accountApi.listEnterpriseAuditLogs(createApiContext(config), filters);
        if (result.ok) {
          this.enterpriseAuditLogs = result.items;
          this.enterpriseAuditTotal = result.total;
        }
        return result;
      } finally {
        this.enterpriseAuditLoading = false;
      }
    },

    async exportEnterpriseAuditLogs(filters?: AuditLogFilters) {
      const config = useConfigStore();
      this.exportingEnterpriseAudit = true;
      try {
        const result = await accountApi.exportEnterpriseAuditLogs(createApiContext(config), filters);
        if (result.ok) {
          downloadBlobFile(result.blob, result.filename ?? "enterprise-audit-logs.xml");
        }
        return result;
      } finally {
        this.exportingEnterpriseAudit = false;
      }
    },
  },
});

