import type { AccountH5BootstrapRequest, AccountH5BootstrapResponse, ApiResult, CreateThreadResponseBody, GetThreadPrefsResponseBody, GetThreadSummaryResponseBody, InterruptTurnResponseBody, ListThreadEventsResponseBody, ListThreadsResponseBody, LoadThreadResponseBody, OfficeH5ActionGuardRequest, OfficeH5ActionGuardResponse, OfficeH5BindingCompleteRequest, OfficeH5BindingCompleteResponse, OfficeH5BindingRevokeRequest, OfficeH5BindingRevokeResponse, OfficeH5BindingStartRequest, OfficeH5BootstrapRequest, OfficeH5BootstrapResponse, OfficeH5JsSdkSignatureRequest, OfficeH5JsSdkSignatureResponse, OfficeH5LoginOptionsResponse, OfficeH5EnterpriseAppsResponse, OfficeH5MyBindingsResponse, OfficeH5OAuthStartRequest, OfficeH5OAuthStartResponse, OfficeH5PlatformContext, OfficeH5ResumeRequest, OfficeH5ResumeResponse, OfficeH5StateIssueRequest, OfficeH5StateIssueResponse, UpsertOfficeH5EnterpriseAppRequest, SendMessageResponseBody, OrchArtifactsListResponseBody, OrchInstancesGetResponseBody, OrchPendingMineListResponseBody, WorkspaceId } from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { throwIfRequestCancelled, wsOriginToHttpOrigin } from "../request";
import { requestJson } from "../request";

export type OfficeH5PlatformMeta = Pick<OfficeH5PlatformContext, "platform" | "corpId" | "requestId"> & {
  entryChannel?: "office_h5";
  enterpriseId?: string | null;
};

export type AccountH5HttpMeta = {
  entryChannel: "h5";
  requestId: string;
};

export type OfficeH5HttpMeta = OfficeH5PlatformMeta | AccountH5HttpMeta;

type OfficeH5JsonOptions = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  meta?: OfficeH5HttpMeta | null;
  auth?: boolean;
  signal?: AbortSignal;
};

/** 判断请求是否携带办公平台上下文，账号 H5 不发送 Office Header。 */
function isOfficeH5PlatformMeta(meta: OfficeH5HttpMeta | null | undefined): meta is OfficeH5PlatformMeta {
  return Boolean(meta && "platform" in meta && "corpId" in meta);
}

function officeH5Context(meta: OfficeH5HttpMeta | null | undefined) {
  if (!isOfficeH5PlatformMeta(meta)) return null;
  return {
    platform: meta.platform,
    corpId: meta.corpId,
    enterpriseId: meta.enterpriseId ?? null,
    requestId: meta.requestId,
    entryChannel: "office_h5" as const,
  };
}

function appendOfficeH5Context(body: unknown, meta: OfficeH5HttpMeta | null | undefined): unknown {
  const context = officeH5Context(meta);
  if (!context || !body || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), officeH5Context: context };
}

function normalizeApiResult<T extends object>(value: unknown): ApiResult<T> {
  if (value && typeof value === "object" && "ok" in value) return value as ApiResult<T>;
  return { ok: false, code: "INTERNAL_ERROR", message: "Invalid Office H5 API response" };
}

/** 发送 H5 API 请求，并携带当前标签页会话标识供服务端校验。 */
async function requestOfficeH5Json<T extends object>(ctx: ApiRequestContext, opts: OfficeH5JsonOptions): Promise<ApiResult<T>> {
  throwIfRequestCancelled(opts.signal);
  const headers: Record<string, string> = {};
  const webSessionId = String(ctx.webSessionId ?? "").trim();
  if (webSessionId) headers["x-web-session-id"] = webSessionId;
  const needsAuth = opts.auth !== false;
  if (needsAuth) {
    const sessionToken = ctx.ensureSession ? await ctx.ensureSession(opts.signal) : String(ctx.sessionToken ?? "").trim();
    if (!sessionToken) return { ok: false, code: "UNAUTHORIZED", message: "Missing session token" };
    headers.Authorization = `Bearer ${sessionToken}`;
  }
  if (isOfficeH5PlatformMeta(opts.meta)) {
    headers["x-office-h5-platform"] = opts.meta.platform;
    headers["x-office-h5-corp-id"] = opts.meta.corpId;
    headers["x-office-h5-request-id"] = opts.meta.requestId;
  }
  const init: RequestInit = { method: opts.method, headers, signal: opts.signal };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(appendOfficeH5Context(opts.body, opts.meta));
  }
  const res = await fetch(`${wsOriginToHttpOrigin(ctx.serverWsOrigin)}${opts.path}`, init);
  throwIfRequestCancelled(opts.signal);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : { ok: false, code: "INTERNAL_ERROR", message: `Empty response: ${res.status}` };
  } catch {
    parsed = { ok: false, code: "INTERNAL_ERROR", message: text || `HTTP ${res.status}` };
  }
  const result = normalizeApiResult<T>(parsed);
  if (!result.ok && (res.status === 401 || result.code === "UNAUTHORIZED")) ctx.clearSession?.();
  return result;
}

export function createOfficeH5RequestId(prefix = "oh5_web"): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function bootstrapOfficeH5(serverWsOrigin: string, body: OfficeH5BootstrapRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5BootstrapResponse>> {
  return requestOfficeH5Json<OfficeH5BootstrapResponse>({ serverWsOrigin, sessionToken: null, webSessionId: null }, {
    method: "POST",
    path: "/api/office-h5/bootstrap",
    body,
    auth: false,
    signal,
  });
}

/** 使用当前账号会话恢复七天内已验证的办公入口。 */
export function resumeOfficeH5(ctx: ApiRequestContext, body: OfficeH5ResumeRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5ResumeResponse>> {
  return requestOfficeH5Json<OfficeH5ResumeResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/resume",
    body,
    signal,
  });
}

/** 使用现有账号 session 校验通用 H5 入口，不依赖办公平台 CorpId。 */
export function bootstrapAccountH5(ctx: ApiRequestContext, body: AccountH5BootstrapRequest, signal?: AbortSignal): Promise<ApiResult<AccountH5BootstrapResponse>> {
  return requestOfficeH5Json<AccountH5BootstrapResponse>(ctx, {
    method: "POST",
    path: "/api/h5/bootstrap",
    body,
    signal,
  });
}


export function issueOfficeH5State(serverWsOrigin: string, body: OfficeH5StateIssueRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5StateIssueResponse>> {
  return requestOfficeH5Json<OfficeH5StateIssueResponse>({ serverWsOrigin, sessionToken: null, webSessionId: null }, {
    method: "POST",
    path: "/api/office-h5/state",
    body,
    auth: false,
    signal,
  });
}

export function startOfficeH5OAuth(serverWsOrigin: string, body: OfficeH5OAuthStartRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5OAuthStartResponse>> {
  return requestOfficeH5Json<OfficeH5OAuthStartResponse>({ serverWsOrigin, sessionToken: null, webSessionId: null }, {
    method: "POST",
    path: "/api/office-h5/oauth/start",
    body,
    auth: false,
    signal,
  });
}

/** 获取登录页可用的企业微信和钉钉入口。 */
export function getOfficeH5LoginOptions(serverWsOrigin: string, signal?: AbortSignal): Promise<ApiResult<OfficeH5LoginOptionsResponse>> {
  return requestOfficeH5Json<OfficeH5LoginOptionsResponse>({ serverWsOrigin, sessionToken: null, webSessionId: null }, {
    method: "GET",
    path: "/api/office-h5/login-options",
    auth: false,
    signal,
  });
}

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/** 读取当前企业的企业微信和钉钉应用配置。 */
export function getEnterpriseOfficeH5Apps(ctx: ApiRequestContext, signal?: AbortSignal): Promise<ApiResult<OfficeH5EnterpriseAppsResponse>> {
  return requestJson(ctx, { method: "GET", path: "/api/account/enterprise/office-h5/apps", signal });
}

/** 保存当前企业单个平台的 H5 应用配置。 */
export function updateEnterpriseOfficeH5App(
  ctx: ApiRequestContext,
  body: UpsertOfficeH5EnterpriseAppRequest,
  signal?: AbortSignal,
): Promise<ApiResult<OfficeH5EnterpriseAppsResponse>> {
  return requestJson(ctx, { method: "POST", path: "/api/account/enterprise/office-h5/apps", body, signal });
}

/** 获取当前 CodeFlow 用户的办公平台绑定状态。 */
export function getMyOfficeH5Bindings(ctx: ApiRequestContext, signal?: AbortSignal): Promise<ApiResult<OfficeH5MyBindingsResponse>> {
  return requestOfficeH5Json<OfficeH5MyBindingsResponse>(ctx, {
    method: "GET",
    path: "/api/office-h5/me/bindings",
    signal,
  });
}

/** 发起与当前 CodeFlow 用户绑定的办公平台 OAuth。 */
export function startMyOfficeH5Binding(ctx: ApiRequestContext, body: OfficeH5BindingStartRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5OAuthStartResponse>> {
  return requestOfficeH5Json<OfficeH5OAuthStartResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/me/bindings/start",
    body,
    signal,
  });
}

/** 完成当前 CodeFlow 用户的办公平台绑定回调。 */
export function completeMyOfficeH5Binding(ctx: ApiRequestContext, body: OfficeH5BindingCompleteRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5BindingCompleteResponse>> {
  return requestOfficeH5Json<OfficeH5BindingCompleteResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/me/bindings/complete",
    body,
    signal,
  });
}

/** 解除当前 CodeFlow 用户指定平台的绑定。 */
export function revokeMyOfficeH5Binding(ctx: ApiRequestContext, body: OfficeH5BindingRevokeRequest, signal?: AbortSignal): Promise<ApiResult<OfficeH5BindingRevokeResponse>> {
  return requestOfficeH5Json<OfficeH5BindingRevokeResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/me/bindings/revoke",
    body,
    signal,
  });
}

/** 调用办公平台动作 Guard；账号 H5 直接使用普通账号 API 权限链路。 */
export function guardOfficeH5Action(ctx: ApiRequestContext, meta: OfficeH5PlatformMeta, body: OfficeH5ActionGuardRequest, signal?: AbortSignal) {
  return requestOfficeH5Json<OfficeH5ActionGuardResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/action-guard",
    body,
    meta,
    signal,
  });
}

/** 获取办公平台 JS-SDK 签名，要求真实平台上下文。 */
export function getOfficeH5JsSdkSignature(ctx: ApiRequestContext, meta: OfficeH5PlatformMeta, body: OfficeH5JsSdkSignatureRequest, signal?: AbortSignal) {
  return requestOfficeH5Json<OfficeH5JsSdkSignatureResponse>(ctx, {
    method: "POST",
    path: "/api/office-h5/js-sdk-signature",
    body,
    meta,
    signal,
  });
}

export function listOfficeH5Threads(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, workspaceId: WorkspaceId, signal?: AbortSignal) {
  const params = new URLSearchParams({ workspaceId: String(workspaceId), scope: "current", sort: "activity_desc", limit: "20" });
  return requestOfficeH5Json<ListThreadsResponseBody>(ctx, { method: "GET", path: `/api/threads?${params.toString()}`, meta, signal });
}


export function getOfficeH5ThreadSummary(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<GetThreadSummaryResponseBody>(ctx, { method: "POST", path: "/api/threads/summary", body, meta, signal });
}

export function loadOfficeH5Thread(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<LoadThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/load", body, meta, signal });
}

export function listOfficeH5ThreadEvents(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<ListThreadEventsResponseBody>(ctx, { method: "POST", path: "/api/threads/events", body, meta, signal });
}

export function createOfficeH5Thread(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<CreateThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/create", body, meta, signal });
}

export function renameOfficeH5Thread(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/threads/rename", body, meta, signal });
}

export function archiveOfficeH5Thread(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/threads/archive", body, meta, signal });
}

export function deleteOfficeH5Thread(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/threads/delete", body, meta, signal });
}

/** Read the current thread execution preferences before an H5 send. */
export function getOfficeH5ThreadPrefs(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<GetThreadPrefsResponseBody>(ctx, { method: "POST", path: "/api/threads/prefs", body, meta, signal });
}

export function sendOfficeH5Message(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<SendMessageResponseBody>(ctx, { method: "POST", path: "/api/threads/send", body, meta, signal });
}

export function interruptOfficeH5Turn(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<InterruptTurnResponseBody>(ctx, { method: "POST", path: "/api/turns/interrupt", body, meta, signal });
}

export function listOfficeH5PendingMine(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, workspaceId: WorkspaceId, signal?: AbortSignal) {
  const params = new URLSearchParams({ workspaceId: String(workspaceId), onlyRelatedToMe: "true", limit: "20" });
  return requestOfficeH5Json<OrchPendingMineListResponseBody>(ctx, { method: "GET", path: `/api/orch/pending-mine?${params.toString()}`, meta, signal });
}


export function getOfficeH5OrchInstance(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<OrchInstancesGetResponseBody>(ctx, { method: "POST", path: "/api/orch/instances/get", body, meta, signal });
}

export function listOfficeH5OrchArtifacts(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<OrchArtifactsListResponseBody>(ctx, { method: "POST", path: "/api/orch/artifacts/list", body, meta, signal });
}

export function resumeOfficeH5OrchInstance(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/orch/instances/resume", body, meta, signal });
}

export function startOfficeH5OrchNode(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/orch/nodes/start", body, meta, signal });
}

export function skipOfficeH5OrchNode(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/orch/nodes/skip", body, meta, signal });
}

export function submitOfficeH5OrchFeedback(ctx: ApiRequestContext, meta: OfficeH5HttpMeta, body: Record<string, unknown>, signal?: AbortSignal) {
  return requestOfficeH5Json<{}>(ctx, { method: "POST", path: "/api/orch/instances/feedback", body, meta, signal });
}
