import { describeUserFacingError, type ApiErr, type ApiResult } from "@codeflowai/shared";
import { getDesktopBridge, resolveDesktopApiRequest } from "../services/desktop";

export type ApiRequestContext = {
  serverWsOrigin: string;
  sessionToken: string | null;
  webSessionId: string | null;
  /** 实际本机运行时标识，用于区分本机与其他 Client 的请求。 */
  desktopClientId?: string | null;
  /** 判断认证失败是否由用户主动退出触发；此时应按请求取消处理。 */
  isLogoutInProgress?: () => boolean;
  /** 确保 session 可用（缺失/过期时退出登录）。 */
  ensureSession?: (signal?: AbortSignal) => Promise<string>;
  /** 清空 session（例如 server 返回 401 时）。 */
  clearSession?: () => void;
};

export type BlobApiResult =
  | { ok: true; blob: Blob; filename: string | null; contentType: string | null }
  | ApiResult<Record<string, never>>;

export class ApiResultError extends Error {
  readonly code: ApiErr["code"];
  readonly details?: unknown;

  /** 展示可读描述，保留原响应及 code/details 供失败判定和排障。 */
  constructor(result: ApiErr) {
    super(describeUserFacingError(result, undefined, true), { cause: result });
    this.name = "ApiResultError";
    this.code = result.code;
    this.details = result.details;
  }
}

/** 将统一 API 失败响应转换为保留 code/details 的异常。 */
export function createApiResultError(result: ApiErr): ApiResultError {
  return new ApiResultError(result);
}

/** 识别会话类错误，供退出期间统一转换为可忽略的请求取消。 */
export function isAuthSessionErrorMessage(message: unknown): boolean {
  const normalized = String(message ?? "").trim();
  if (!normalized) return false;
  return normalized.includes("账号会话已过期")
    || normalized.includes("请重新登录")
    || normalized.includes("Missing account session")
    || normalized.includes("Web 端仅支持账号登录");
}

/** 判断未知异常是否来自统一 API 失败响应。 */
export function isApiResultError(error: unknown): error is ApiResultError {
  return error instanceof ApiResultError
    || (typeof error === "object"
      && error !== null
      && (error as { name?: unknown }).name === "ApiResultError"
      && typeof (error as { code?: unknown }).code === "string");
}

export type AbortKind =
  | "scope-change"
  | "selection-change"
  | "workspace-switch"
  | "clear"
  | "delete"
  | "thread-invalidated"
  | "reconnect-scope-change"
  | "disconnect"
  | "component-unmount"
  | "stale-result";

const ABORT_KINDS = new Set<AbortKind>([
  "scope-change",
  "selection-change",
  "workspace-switch",
  "clear",
  "delete",
  "thread-invalidated",
  "reconnect-scope-change",
  "disconnect",
  "component-unmount",
  "stale-result",
]);

const WS_WEB_SUFFIX = "/ws/web";
const JSON_ANONYMOUS_PATHS = new Set<string>([
  "/api/public/contact-info",
  "/api/public/best-practice-articles",
  "/api/public/relay/pricing/current",
]);
const PUBLIC_BEST_PRACTICE_DETAIL_PATH = /^\/api\/public\/best-practice-articles\/[^/]+$/u;

export class CancelledRequestError extends Error {
  kind: AbortKind;

  constructor(kind: AbortKind, message?: string) {
    super(message ?? `请求已取消：${kind}`);
    this.name = "CancelledRequestError";
    this.kind = kind;
  }
}

export function createCancelledRequestError(kind: AbortKind, message?: string): CancelledRequestError {
  return new CancelledRequestError(kind, message);
}

export function isCancelledRequestError(error: unknown): error is CancelledRequestError {
  return error instanceof CancelledRequestError
    || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "CancelledRequestError");
}

export function normalizeCancelledRequestError(
  reason: unknown,
  fallbackKind: AbortKind = "scope-change",
): CancelledRequestError {
  if (isCancelledRequestError(reason)) return reason;
  if (typeof reason === "string" && ABORT_KINDS.has(reason as AbortKind)) {
    return createCancelledRequestError(reason as AbortKind);
  }
  if (typeof reason === "object" && reason !== null) {
    const kind = (reason as { kind?: unknown }).kind;
    const message = (reason as { message?: unknown }).message;
    if (typeof kind === "string" && ABORT_KINDS.has(kind as AbortKind)) {
      return createCancelledRequestError(kind as AbortKind, typeof message === "string" ? message : undefined);
    }
  }
  if (isAbortLikeError(reason)) {
    return createCancelledRequestError(fallbackKind);
  }
  return createCancelledRequestError(fallbackKind);
}

export function throwIfRequestCancelled(
  signal?: AbortSignal,
  fallbackKind: AbortKind = "scope-change",
): void {
  if (!signal?.aborted) return;
  throw normalizeCancelledRequestError(signal.reason, fallbackKind);
}

export function createLinkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!signal) return { controller, cleanup: () => {} };
  if (signal.aborted) {
    controller.abort(normalizeCancelledRequestError(signal.reason));
    return { controller, cleanup: () => {} };
  }

  const onAbort = () => {
    controller.abort(normalizeCancelledRequestError(signal.reason));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

export async function awaitWithAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  fallbackKind: AbortKind = "scope-change",
): Promise<T> {
  throwIfRequestCancelled(signal, fallbackKind);
  if (!signal) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(normalizeCancelledRequestError(signal.reason, fallbackKind));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Normalize persisted server origins and strip an accidental trailing /ws/web suffix. */
export function normalizeServerWsOrigin(serverWsOrigin: string): string {
  const raw = String(serverWsOrigin ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const normalizedPath = stripWsWebSuffix(url.pathname);
    url.pathname = normalizedPath || "/";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${normalizedPath}`;
  } catch {
    const sanitized = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return stripWsWebSuffix(sanitized);
  }
}

/** Build the canonical /ws/web endpoint from a configured server origin. */
export function buildServerWsWebUrl(serverWsOrigin: string): string {
  const normalizedOrigin = normalizeServerWsOrigin(serverWsOrigin);
  if (!normalizedOrigin) return "";
  return `${normalizedOrigin}${WS_WEB_SUFFIX}`;
}

export function wsOriginToHttpOrigin(serverWsOrigin: string): string {
  const s = normalizeServerWsOrigin(serverWsOrigin);
  if (s.startsWith("ws://")) return `http://${s.slice("ws://".length)}`;
  if (s.startsWith("wss://")) return `https://${s.slice("wss://".length)}`;
  return s;
}

/** 统一 JSON 请求入口；本机默认桥接，服务端权威数据可显式指定云端认证路径。 */
export async function requestJson<T extends object>(
  ctx: ApiRequestContext,
  opts: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    requireWebSession?: boolean;
    /** 聚合服务端权威信息时跳过本机桥接，不作为本机失败后的重试。 */
    serverOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<ApiResult<T>> {
  const bridge = getDesktopBridge();
  const localRequest = bridge && !opts.serverOnly ? resolveDesktopApiRequest(opts, ctx.desktopClientId) : null;
  if (bridge && localRequest) {
    throwIfRequestCancelled(opts.signal);
    const serializableRequest = JSON.parse(JSON.stringify(localRequest)) as typeof localRequest;
    const response = await awaitWithAbortSignal(bridge.request(serializableRequest), opts.signal);
    throwIfRequestCancelled(opts.signal);
    if (!response || !response.body || typeof response.body !== "object" || typeof (response.body as { ok?: unknown }).ok !== "boolean") {
      throw new Error("DESKTOP_API_RESPONSE_INVALID");
    }
    return response.body as ApiResult<T>;
  }
  const allowAnonymous = isAnonymousJsonRequest(opts.method, opts.path);
  let sessionToken = "";
  if (!allowAnonymous) {
    try {
      throwIfRequestCancelled(opts.signal);
      sessionToken = ctx.ensureSession ? await ctx.ensureSession(opts.signal) : (ctx.sessionToken ?? "").trim();
      throwIfRequestCancelled(opts.signal);
    } catch (e) {
      const cancelled = asCancelledRequestError(e, opts.signal);
      if (cancelled) throw cancelled;
      if (ctx.isLogoutInProgress?.() && isAuthSessionErrorMessage(e instanceof Error ? e.message : e)) {
        throw createCancelledRequestError("disconnect");
      }
      return { ok: false, code: "UNAUTHORIZED", message: e instanceof Error ? e.message : String(e) };
    }

    if (!sessionToken) {
      if (ctx.isLogoutInProgress?.()) throw createCancelledRequestError("disconnect");
      return { ok: false, code: "UNAUTHORIZED", message: "缺少鉴权 token（session）" };
    }
  }
  if (opts.requireWebSession && !ctx.webSessionId) return { ok: false, code: "BAD_REQUEST", message: "缺少 webSessionId（请先 WS 连接成功）" };

  const url = `${wsOriginToHttpOrigin(ctx.serverWsOrigin)}${opts.path}`;

  const doFetch = async (resolvedSessionToken: string): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (resolvedSessionToken) {
      headers.Authorization = `Bearer ${resolvedSessionToken}`;
    }
    if (ctx.webSessionId) headers["x-web-session-id"] = ctx.webSessionId;

    const init: RequestInit = {
      method: opts.method,
      headers,
      signal: opts.signal,
    };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return await fetch(url, init);
  };

  const parseResponse = async (res: Response): Promise<ApiResult<T>> => {
    throwIfRequestCancelled(opts.signal);
    const text = await res.text();
    throwIfRequestCancelled(opts.signal);
    try {
      return JSON.parse(text) as ApiResult<T>;
    } catch {
      return { ok: false, code: "NON_JSON", message: `响应非 JSON（status=${res.status}）`, details: text };
    }
  };

  let res: Response;
  try {
    res = await doFetch(sessionToken);
  } catch (e) {
    const cancelled = asCancelledRequestError(e, opts.signal);
    if (cancelled) throw cancelled;
    throw e;
  }
  if (res.status === 401 && ctx.isLogoutInProgress?.()) {
    throw createCancelledRequestError("disconnect");
  }
  if (res.status === 401 && sessionToken && ctx.clearSession) {
    ctx.clearSession();
  }

  try {
    return await parseResponse(res);
  } catch (e) {
    const cancelled = asCancelledRequestError(e, opts.signal);
    if (cancelled) throw cancelled;
    throw e;
  }
}

function asCancelledRequestError(
  error: unknown,
  signal?: AbortSignal,
  fallbackKind: AbortKind = "scope-change",
): CancelledRequestError | null {
  if (isCancelledRequestError(error)) return error;
  if (signal?.aborted) return normalizeCancelledRequestError(signal.reason, fallbackKind);
  if (isAbortLikeError(error)) return normalizeCancelledRequestError(error, fallbackKind);
  return null;
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "AbortError";
}

/** Keep any deployment base path, but remove the WebSocket terminal path suffix. */
function stripWsWebSuffix(pathname: string): string {
  const normalizedPath = String(pathname ?? "").trim().replace(/\/+$/, "");
  if (!normalizedPath) return "";
  if (!normalizedPath.toLowerCase().endsWith(WS_WEB_SUFFIX)) {
    return normalizedPath;
  }
  const stripped = normalizedPath.slice(0, normalizedPath.length - WS_WEB_SUFFIX.length);
  return stripped.replace(/\/+$/, "");
}

/** 统一二进制请求入口；当前 blob 请求仍要求登录态，不走公开白名单。 */
export async function requestBlob(
  ctx: ApiRequestContext,
  opts: { method: "GET" | "POST"; path: string; body?: unknown; requireWebSession?: boolean; signal?: AbortSignal },
): Promise<BlobApiResult> {
  let sessionToken = "";
  try {
    throwIfRequestCancelled(opts.signal);
    sessionToken = ctx.ensureSession ? await ctx.ensureSession(opts.signal) : (ctx.sessionToken ?? "").trim();
    throwIfRequestCancelled(opts.signal);
  } catch (error) {
    const cancelled = asCancelledRequestError(error, opts.signal);
    if (cancelled) throw cancelled;
    if (ctx.isLogoutInProgress?.() && isAuthSessionErrorMessage(error instanceof Error ? error.message : error)) {
      throw createCancelledRequestError("disconnect");
    }
    return { ok: false, code: "UNAUTHORIZED", message: error instanceof Error ? error.message : String(error) };
  }

  if (!sessionToken) {
    if (ctx.isLogoutInProgress?.()) throw createCancelledRequestError("disconnect");
    return { ok: false, code: "UNAUTHORIZED", message: "缺少鉴权 token（session）" };
  }
  if (opts.requireWebSession && !ctx.webSessionId) return { ok: false, code: "BAD_REQUEST", message: "缺少 webSessionId（请先建立 WS 连接）" };

  const url = `${wsOriginToHttpOrigin(ctx.serverWsOrigin)}${opts.path}`;

  const doFetch = async (resolvedSessionToken: string): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (resolvedSessionToken) {
      headers.Authorization = `Bearer ${resolvedSessionToken}`;
    }
    if (ctx.webSessionId) headers["x-web-session-id"] = ctx.webSessionId;

    const init: RequestInit = {
      method: opts.method,
      headers,
      signal: opts.signal,
    };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return await fetch(url, init);
  };

  const parseError = async (res: Response): Promise<ApiResult<Record<string, never>>> => {
    const text = await res.text();
    try {
      return JSON.parse(text) as ApiResult<Record<string, never>>;
    } catch {
      return { ok: false, code: "NON_JSON", message: `响应不是 JSON（status=${res.status}）`, details: text };
    }
  };

  let res: Response;
  try {
    res = await doFetch(sessionToken);
  } catch (error) {
    const cancelled = asCancelledRequestError(error, opts.signal);
    if (cancelled) throw cancelled;
    throw error;
  }
  if (res.status === 401 && ctx.isLogoutInProgress?.()) {
    throw createCancelledRequestError("disconnect");
  }
  if (res.status === 401 && sessionToken && ctx.clearSession) {
    ctx.clearSession();
  }

  if (!res.ok) {
    return await parseError(res);
  }

  const disposition = res.headers.get("content-disposition");
  const filename = readDispositionFilename(disposition);
  return {
    ok: true,
    blob: await res.blob(),
    filename,
    contentType: res.headers.get("content-type"),
  };
}

/** 统一二进制上传入口；正文不 JSON 编码，用于工作区文件上传。 */
export async function requestBinaryJson<T extends object>(
  ctx: ApiRequestContext,
  opts: {
    method: "POST";
    path: string;
    body: BodyInit;
    contentType?: string;
    signal?: AbortSignal;
  },
): Promise<ApiResult<T>> {
  let sessionToken = "";
  try {
    throwIfRequestCancelled(opts.signal);
    sessionToken = ctx.ensureSession ? await ctx.ensureSession(opts.signal) : (ctx.sessionToken ?? "").trim();
    throwIfRequestCancelled(opts.signal);
  } catch (error) {
    const cancelled = asCancelledRequestError(error, opts.signal);
    if (cancelled) throw cancelled;
    if (ctx.isLogoutInProgress?.() && isAuthSessionErrorMessage(error instanceof Error ? error.message : error)) {
      throw createCancelledRequestError("disconnect");
    }
    return { ok: false, code: "UNAUTHORIZED", message: error instanceof Error ? error.message : String(error) };
  }

  if (!sessionToken) {
    if (ctx.isLogoutInProgress?.()) throw createCancelledRequestError("disconnect");
    return { ok: false, code: "UNAUTHORIZED", message: "缺少鉴权 token（session）" };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    "content-type": opts.contentType || "application/octet-stream",
  };
  if (ctx.webSessionId) headers["x-web-session-id"] = ctx.webSessionId;

  let res: Response;
  try {
    res = await fetch(`${wsOriginToHttpOrigin(ctx.serverWsOrigin)}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body,
      signal: opts.signal,
    });
  } catch (error) {
    const cancelled = asCancelledRequestError(error, opts.signal);
    if (cancelled) throw cancelled;
    throw error;
  }
  if (res.status === 401 && ctx.isLogoutInProgress?.()) {
    throw createCancelledRequestError("disconnect");
  }
  if (res.status === 401 && sessionToken && ctx.clearSession) ctx.clearSession();
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResult<T>;
  } catch {
    return { ok: false, code: "NON_JSON", message: `响应非 JSON（status=${res.status}）`, details: text };
  }
}

function readDispositionFilename(value: string | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = text.match(/filename="?([^\";]+)"?/i);
  return plainMatch?.[1] ?? null;
}

/** 归一化请求路径，白名单匹配仅基于 pathname，不比较 query/hash。 */
function normalizeRequestPath(path: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? "";
  }
}

/** 判断当前 JSON 请求是否为允许匿名读取的公开接口。 */
function isAnonymousJsonRequest(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const normalizedPath = normalizeRequestPath(path);
  return JSON_ANONYMOUS_PATHS.has(normalizedPath)
    || PUBLIC_BEST_PRACTICE_DETAIL_PATH.test(normalizedPath);
}
