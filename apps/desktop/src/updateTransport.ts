import crypto from "node:crypto";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, desktopDeviceRequestTarget, readDesktopDevicePlatform, DESKTOP_DEVICE_AUTH_HEADERS } from "@codeflowai/shared/desktop-device-auth";
import { signDevicePayload, type DeviceIdentity } from "./deviceIdentity.js";
import { preserveUpdateNetworkCancellation, type UpdateNetworkRetry } from "./updateNetworkRetry.js";

type UpdateRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"; path: string; body?: unknown;
  range?: string | null; ifMatch?: string | null; requestId?: string; signal?: AbortSignal };
const REMOTE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** 固定 origin 与唯一 signer 供更新下载、阶段回执和错误补报复用，不自动联网。 */
export function createDesktopUpdateTransport(input: { dataDir: string; identity: DeviceIdentity; configuredServerOrigin: string; timeoutMs?: number;
  /** 账号 Server 可显式使用 HTTP；例外仅用于签名登记，不能下载更新或发送回执。 */
  allowHttpRegistration?: boolean;
  getNetworkContext?: () => { signal: AbortSignal; retry: UpdateNetworkRetry } | undefined }) {
  const identity = { deviceId: input.identity.deviceId, publicKeyBase64: input.identity.publicKeyBase64 };
  const publicKeySha256 = desktopDevicePublicKeySha256(identity.publicKeyBase64);
  const origin = new URL(input.configuredServerOrigin);
  const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const registrationHttp = origin.protocol === "http:" && !localHttp && input.allowHttpRegistration === true;
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.origin !== input.configuredServerOrigin || (origin.protocol !== "https:" && !localHttp && !registrationHttp)) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("DESKTOP_UPDATE_TIMEOUT_INVALID");

  /** 对确切正文签名；HTTP 失败分别保留本地传输类型和远端业务码。 */
  const send = async (request: UpdateRequest, body: Uint8Array, raw = false): Promise<Response> => {
    request.signal?.throwIfAborted();
    if (registrationHttp && (request.method !== "POST" || request.path !== "/api/software/desktop/devices/register")) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
    desktopDeviceRequestTarget(request.path);
    const url = new URL(request.path, origin);
    if (url.origin !== origin.origin) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
    const metadata = { requestId: request.requestId ?? crypto.randomUUID(), timestamp: Date.now() };
    const signature = await signDevicePayload(input.dataDir, buildDesktopDevicePayload({ ...metadata, deviceId: identity.deviceId,
      method: request.method, url: request.path, body, range: request.range, ifMatch: request.ifMatch }));
    if (signature.deviceId !== identity.deviceId || signature.publicKeyBase64 !== identity.publicKeyBase64) throw new Error("DESKTOP_DEVICE_IDENTITY_CHANGED");
    const headers: Record<string, string> = { [DESKTOP_DEVICE_AUTH_HEADERS.version]: "v1", [DESKTOP_DEVICE_AUTH_HEADERS.deviceId]: identity.deviceId,
      [DESKTOP_DEVICE_AUTH_HEADERS.requestId]: metadata.requestId, [DESKTOP_DEVICE_AUTH_HEADERS.timestamp]: String(metadata.timestamp),
      [DESKTOP_DEVICE_AUTH_HEADERS.signature]: signature.signature };
    if (body.byteLength) headers["content-type"] = "application/json";
    if (request.range != null) headers.range = request.range;
    if (request.ifMatch != null) headers["if-match"] = request.ifMatch;
    let response: Response;
    try {
      response = await fetch(url, { method: request.method, headers, body: body.byteLength ? Buffer.from(body) : undefined,
        redirect: "error", credentials: "omit", signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]) });
    } catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: preserveUpdateNetworkCancellation(cause, request.signal) }),
        { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: metadata.requestId });
    }
    if (!raw && !response.ok) {
      const retryAfter = response.headers.get("retry-after");
      let failure: unknown;
      try { failure = await response.json(); }
      catch (cause) {
        throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED", { cause: cause instanceof SyntaxError ? new Error("DESKTOP_UPDATE_RESPONSE_INVALID")
          : preserveUpdateNetworkCancellation(cause, request.signal) }),
          { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId: metadata.requestId, status: response.status, retryAfter });
      }
      const value = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
      throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED"),
        { code: safeRemoteErrorCode(value.code, "DESKTOP_UPDATE_HTTP_FAILED"), transportCode: "DESKTOP_UPDATE_HTTP_FAILED",
          requestId: metadata.requestId, status: response.status, retryAfter });
    }
    return response;
  };

  /** 固定本次 ID 与确切正文，普通/raw/JSON 入口共同使用同一序列化。 */
  const prepare = (request: UpdateRequest) => ({ requestId: request.requestId ?? crypto.randomUUID(),
    body: request.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request.body), "utf8") });

  /** 一次公共动作只获取一份上下文；JSON 读取与登记确认属于同一次重试。 */
  const runNetwork = async <T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
    const context = input.getNetworkContext?.();
    const combined = context ? signal ? AbortSignal.any([context.signal, signal]) : context.signal : signal;
    return context ? await context.retry.run(() => operation(combined)) : await operation(combined);
  };

  /** 非 JSON 响应不能把远端正文片段带入异常链，读流失败仍保留原始原因。 */
  const readJson = async (response: Response, requestId: string, signal?: AbortSignal): Promise<unknown> => {
    try { return await response.json(); }
    catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID", { cause: cause instanceof SyntaxError ? new Error("INVALID_JSON")
        : preserveUpdateNetworkCancellation(cause, signal) }),
        { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId });
    }
  };

  return {
    /** 单次物理发送，非 2xx 也只交响应；完整正文、HTTP 失败和清理由外层 owner 负责。 */
    async requestRaw(request: UpdateRequest): Promise<Response> {
      const { requestId, body } = prepare(request);
      return await send({ ...request, requestId }, body, true);
    },
    /** 正文与 requestId 固定一次；只重试取得响应，归档读流由下载器负责。 */
    async request(request: UpdateRequest): Promise<Response> {
      const { requestId, body } = prepare(request);
      return await runNetwork(request.signal, async signal => await send({ ...request, requestId, signal }, body));
    },
    /** JSON 结构及业务失败保留请求标识，回执和错误补报不能把 HTTP 200 当成业务成功。 */
    async requestJson<T extends object>(input: UpdateRequest): Promise<T & { ok: true }> {
      const { requestId, body: bytes } = prepare(input);
      return await runNetwork(input.signal, async signal => {
        const response = await send({ ...input, requestId, signal }, bytes);
        const value = await readJson(response, requestId, signal);
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).ok !== "boolean") {
          throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID"), { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId });
        }
        const body = value as Record<string, unknown>;
        if (body.ok !== true) throw Object.assign(new Error("DESKTOP_UPDATE_REQUEST_FAILED"),
          { code: safeRemoteErrorCode(body.code, "DESKTOP_UPDATE_REQUEST_FAILED"), requestId });
        return value as T & { ok: true };
      });
    },
    /** 平台来自当前壳二进制；登记前校验，确认仍只核对设备和公钥摘要。 */
    async register(options: { signal?: AbortSignal; requestId?: string } = {}): Promise<{ deviceId: string; publicKeySha256: string }> {
      options.signal?.throwIfAborted();
      const platform = readDesktopDevicePlatform(process.platform, process.arch);
      const body = Buffer.from(JSON.stringify({ deviceId: identity.deviceId, publicKeyBase64: identity.publicKeyBase64, ...platform }), "utf8");
      const requestId = options.requestId ?? crypto.randomUUID();
      return await runNetwork(options.signal, async signal => {
        const response = await send({ method: "POST", path: "/api/software/desktop/devices/register", signal, requestId }, body);
        const ack = await readJson(response, requestId, signal);
        if (!ack || typeof ack !== "object" || Array.isArray(ack) || Object.keys(ack).length !== 3
          || (ack as Record<string, unknown>).ok !== true || (ack as Record<string, unknown>).deviceId !== identity.deviceId
          || (ack as Record<string, unknown>).publicKeySha256 !== publicKeySha256) {
          throw Object.assign(new Error("DESKTOP_DEVICE_REGISTRATION_ACK_INVALID"), { code: "DESKTOP_DEVICE_REGISTRATION_ACK_INVALID", requestId });
        }
        return { deviceId: identity.deviceId, publicKeySha256 };
      });
    },
  };
}

/** 仅接受短 ASCII 错误码，避免远端正文伪装为本地诊断字段。 */
function safeRemoteErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && REMOTE_ERROR_CODE.test(value) ? value : fallback;
}
