const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_MESSAGE_LENGTH = 1_000;
const MAX_REQUEST_ID_LENGTH = 256;
const SERVER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type OrchAssetHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export type OrchAssetHttpJsonClientOptions = {
  fetchImpl?: OrchAssetHttpFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  hostRpcSessionId?: string;
  signal?: AbortSignal;
};

export type OrchAssetHttpFailureKind =
  | "config_invalid"
  | "request_invalid"
  | "network_failed"
  | "timeout"
  | "response_too_large"
  | "response_invalid"
  | "server_rejected";

export type OrchAssetHttpFailure<TEndpoint extends string> = {
  kind: OrchAssetHttpFailureKind;
  endpoint: TEndpoint | null;
  status: number | null;
  serverCode: string | null;
  requestId: string | null;
  serverMessage: string | null;
  message: string;
  retryAfterMs?: number | null;
  cause?: Error;
};

export type OrchAssetHttpJsonClientPolicy<TEndpoint extends string, TError extends Error> = {
  label: string;
  retainServerMessage: boolean;
  retainNetworkCauseMessage: boolean;
  createError(failure: OrchAssetHttpFailure<TEndpoint>): TError;
  isTransportError(error: unknown): error is TError;
};

export type OrchAssetHttpJsonClient<TEndpoint extends string> = {
  drain(): Promise<void>;
  post(endpoint: TEndpoint, path: string, body: unknown): Promise<{
    envelope: Record<string, unknown>;
    status: number;
  }>;
};

/** Creates one bounded authenticated JSON client shared by asset HTTP protocols. */
export function createOrchAssetHttpJsonClient<TEndpoint extends string, TError extends Error>(
  config: { serverWsUrl: string; apiKey: string },
  options: OrchAssetHttpJsonClientOptions,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): OrchAssetHttpJsonClient<TEndpoint> {
  const apiKey = requiredText(config.apiKey, policy, "HTTP API Key 非法");
  const httpBase = resolveHttpBase(config.serverWsUrl, policy);
  const fetchImpl = options.fetchImpl ?? snapshotGlobalFetch(policy);
  if (typeof fetchImpl !== "function") throw configError(policy, `${policy.label} HTTP 实现非法`);
  const timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, policy);
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    policy,
  );
  const hostRpcSessionId = options.hostRpcSessionId === undefined ? undefined : requiredText(options.hostRpcSessionId, policy, "Host HTTP session 非法");
  let pendingResource: Promise<unknown> | null = null;

  return {
    /** 等待真实fetch/读流收口；超时仅拒绝，不把仍在运行的资源视为释放。 */
    async drain() {
      if (!pendingResource) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pendingResource.then(() => undefined, () => undefined), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("ASSET_HTTP_RESOURCE_UNCONFIRMED")), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    },
    /** Sends one request to the fixed Server origin and returns its parsed envelope. */
    async post(endpoint, path, body) {
      return await postJson({
        endpoint,
        url: `${httpBase}${path}`,
        apiKey,
        body,
        fetchImpl,
        timeoutMs,
        maxResponseBytes,
        policy,
        hostRpcSessionId,
        signal: options.signal,
        ownResource(operation) { pendingResource = operation; void operation.then(() => { if (pendingResource === operation) pendingResource = null; }, () => { if (pendingResource === operation) pendingResource = null; }); },
      });
    },
  };
}

/** Sends one bounded JSON request without following redirects or retaining response content in failures. */
async function postJson<TEndpoint extends string, TError extends Error>(input: {
  endpoint: TEndpoint;
  url: string;
  apiKey: string;
  body: unknown;
  fetchImpl: OrchAssetHttpFetch;
  timeoutMs: number;
  maxResponseBytes: number;
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>;
  hostRpcSessionId?: string;
  signal?: AbortSignal;
  ownResource(operation: Promise<unknown>): void;
}): Promise<{ envelope: Record<string, unknown>; status: number }> {
  let requestBody: string;
  try {
    requestBody = JSON.stringify(input.body);
  } catch {
    throw input.policy.createError({
      kind: "request_invalid",
      endpoint: input.endpoint,
      status: null,
      serverCode: null,
      requestId: null,
      serverMessage: null,
      message: `${input.policy.label}请求无法序列化`,
      cause: new Error("Asset HTTP request serialization failed"),
    });
  }
  if (typeof requestBody !== "string") {
    throw input.policy.createError({
      kind: "request_invalid",
      endpoint: input.endpoint,
      status: null,
      serverCode: null,
      requestId: null,
      serverMessage: null,
      message: `${input.policy.label}请求无法序列化`,
    });
  }

  const controller = new AbortController();
  input.signal?.throwIfAborted();
  const abort = (): void => { controller.abort(input.signal?.reason); };
  input.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  let timeoutFailure: TError | null = null;
  let rejectTimeout: (error: TError) => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutFailure = requestFailure(
      input.endpoint,
      true,
      new Error("Asset HTTP deadline exceeded"),
      input.apiKey,
      input.policy,
    );
    rejectTimeout(timeoutFailure);
    controller.abort(timeoutFailure);
  }, input.timeoutMs);
  timer.unref?.();

  const operation = (async () => {
    let response: Response;
    try {
      response = await input.fetchImpl(input.url, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${input.apiKey}`,
          ...(input.hostRpcSessionId ? { "x-codeflow-host-rpc-session": input.hostRpcSessionId } : {}),
        },
        body: requestBody,
        redirect: "error",
        signal: controller.signal,
      });
      if (timedOut && timeoutFailure) throw timeoutFailure;
    } catch (cause) {
      if (input.policy.isTransportError(cause)) throw cause;
      throw requestFailure(input.endpoint, timedOut, cause, input.apiKey, input.policy);
    }

    let text: string;
    try {
      text = await readBoundedUtf8Body(
        response,
        input.endpoint,
        input.maxResponseBytes,
        controller,
        input.policy,
      );
      if (timedOut && timeoutFailure) throw timeoutFailure;
    } catch (cause) {
      if (input.policy.isTransportError(cause)) throw cause;
      throw requestFailure(input.endpoint, timedOut, cause, input.apiKey, input.policy);
    }
    return {
      envelope: parseEnvelope(response, input.endpoint, text, input.apiKey, input.policy),
      status: response.status,
    };
  })();
  input.ownResource(operation);

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

/** Reads at most the configured UTF-8 bytes and rejects invalid length or encoding. */
async function readBoundedUtf8Body<TEndpoint extends string, TError extends Error>(
  response: Response,
  endpoint: TEndpoint,
  maxBytes: number,
  controller: AbortController,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) {
      throw responseError(policy, endpoint, response.status, `${policy.label}响应 Content-Length 非法`);
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      throw responseError(policy, endpoint, response.status, `${policy.label}响应 Content-Length 非法`);
    }
    if (declaredBytes > maxBytes) {
      controller.abort();
      throw tooLargeError(policy, endpoint, response.status);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw tooLargeError(policy, endpoint, response.status);
      }
      text += decodeUtf8(decoder, chunk.value, true, policy, endpoint, response.status);
    }
    return text + decodeUtf8(decoder, undefined, false, policy, endpoint, response.status);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Parses one API envelope and retains only content-safe Server correlation fields. */
function parseEnvelope<TEndpoint extends string, TError extends Error>(
  response: Response,
  endpoint: TEndpoint,
  text: string,
  apiKey: string,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw responseError(policy, endpoint, response.status, `${policy.label}响应不是有效 JSON`);
  }
  if (!isPlainRecord(value)) {
    throw responseError(policy, endpoint, response.status, `${policy.label}响应 envelope 非法`);
  }
  if (!response.ok || value.ok === false) {
    const retryAfterMs = readRetryAfter(response.headers.get("retry-after"), endpoint, response.status, policy);
    const serverCode = safeServerCode(value.code, apiKey);
    const requestId = readRequestId(value.details, apiKey);
    const serverMessage = policy.retainServerMessage && response.status >= 400 && response.status < 500
      ? safeServerText(value.message, MAX_SERVER_MESSAGE_LENGTH, apiKey)
      : null;
    throw policy.createError({
      kind: "server_rejected",
      endpoint,
      status: response.status,
      serverCode,
      requestId,
      serverMessage,
      retryAfterMs,
      message: `${policy.label} Server 请求失败：HTTP ${response.status}${serverCode ? ` ${serverCode}` : ""}`,
    });
  }
  if (value.ok !== true) {
    throw responseError(policy, endpoint, response.status, `${policy.label}成功响应缺少 ok=true`);
  }
  return value;
}

/** 仅消费服务端明确的重试时刻；坏头不静默变成另一种重试策略。 */
function readRetryAfter<TEndpoint extends string, TError extends Error>(value: string | null, endpoint: TEndpoint, status: number,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>): number | null {
  if (value === null) return null;
  const seconds = /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : null;
  const date = seconds === null && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) ? Date.parse(value) : NaN;
  const delay = seconds === null ? Math.max(0, date - Date.now()) : seconds * 1000;
  if (!Number.isFinite(delay) || !Number.isSafeInteger(delay) || delay > 2_147_483_647) {
    throw responseError(policy, endpoint, status, `${policy.label} Retry-After 非法`);
  }
  return delay;
}

/** Converts a WS endpoint into its same-origin HTTP origin. */
function resolveHttpBase<TEndpoint extends string, TError extends Error>(
  value: unknown,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): string {
  const raw = requiredText(value, policy, "Server WS 地址非法");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError(policy, "Server WS 地址非法");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw configError(policy, "Server WS 地址只支持 ws 或 wss");
  }
  if (url.username || url.password) throw configError(policy, "Server WS 地址不能携带 URL 凭据");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/** Captures the process fetch implementation before mutable globals can replace it. */
function snapshotGlobalFetch<TEndpoint extends string, TError extends Error>(
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): OrchAssetHttpFetch {
  const fetchSnapshot = globalThis.fetch;
  if (typeof fetchSnapshot !== "function") throw configError(policy, `${policy.label} HTTP 实现非法`);
  return async (url, init) => await fetchSnapshot(url, init);
}

/** Requires non-empty text without whitespace repair or control characters. */
function requiredText<TEndpoint extends string, TError extends Error>(
  value: unknown,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
  message: string,
): string {
  if (typeof value !== "string" || !value || value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw configError(policy, message);
  }
  return value;
}

/** Requires a positive integer within the protocol's fixed maximum. */
function boundedPositiveInteger<TEndpoint extends string, TError extends Error>(
  value: unknown,
  max: number,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw configError(policy, `${policy.label} HTTP 数值配置非法`);
  }
  return value;
}

/** Returns bounded Server text without coercion, controls, or credential echoes. */
function safeServerText(value: unknown, maxLength: number, sensitiveValue?: string): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && (!sensitiveValue || !value.includes(sensitiveValue))
    ? value
    : null;
}

/** Accepts only the stable uppercase Server error-code shape. */
function safeServerCode(value: unknown, sensitiveValue: string): string | null {
  return typeof value === "string" && !value.includes(sensitiveValue) && SERVER_CODE_PATTERN.test(value) ? value : null;
}

/** Extracts only the Fastify request identity from Server error details. */
function readRequestId(value: unknown, sensitiveValue: string): string | null {
  return isPlainRecord(value) ? safeServerText(value.requestId, MAX_REQUEST_ID_LENGTH, sensitiveValue) : null;
}

/** Decodes one fragment and converts decoder diagnostics into a safe response failure. */
function decodeUtf8<TEndpoint extends string, TError extends Error>(
  decoder: TextDecoder,
  bytes: Uint8Array | undefined,
  stream: boolean,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
  endpoint: TEndpoint,
  status: number,
): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw responseError(policy, endpoint, status, `${policy.label}响应不是有效 UTF-8`);
  }
}

/** Checks a JSON object without accepting arrays or class instances. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Creates a domain-specific configuration error before any network side effect. */
function configError<TEndpoint extends string, TError extends Error>(
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
  message: string,
): TError {
  return policy.createError({
    kind: "config_invalid",
    endpoint: null,
    status: null,
    serverCode: null,
    requestId: null,
    serverMessage: null,
    message,
  });
}

/** Creates a bounded domain-specific response failure. */
function responseError<TEndpoint extends string, TError extends Error>(
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
  endpoint: TEndpoint,
  status: number | null,
  message: string,
): TError {
  return policy.createError({
    kind: "response_invalid",
    endpoint,
    status,
    serverCode: null,
    requestId: null,
    serverMessage: null,
    message,
  });
}

/** Creates a response-size failure without retaining its body. */
function tooLargeError<TEndpoint extends string, TError extends Error>(
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
  endpoint: TEndpoint,
  status: number,
): TError {
  return policy.createError({
    kind: "response_too_large",
    endpoint,
    status,
    serverCode: null,
    requestId: null,
    serverMessage: null,
    message: `${policy.label}响应超过配置的安全上限`,
    cause: new Error("Asset HTTP response exceeded the configured byte limit"),
  });
}

/** Maps network and deadline failures while retaining only a sanitized cause. */
function requestFailure<TEndpoint extends string, TError extends Error>(
  endpoint: TEndpoint,
  timedOut: boolean,
  cause: unknown,
  apiKey: string,
  policy: OrchAssetHttpJsonClientPolicy<TEndpoint, TError>,
): TError {
  return policy.createError({
    kind: timedOut ? "timeout" : "network_failed",
    endpoint,
    status: null,
    serverCode: null,
    requestId: null,
    serverMessage: null,
    message: timedOut ? `${policy.label} HTTP 请求超时` : `${policy.label} HTTP 请求失败`,
    cause: safeHttpCause(cause, apiKey, policy.retainNetworkCauseMessage),
  });
}

/** Copies only a bounded diagnostic message so thrown objects cannot retain credentials. */
function safeHttpCause(value: unknown, apiKey: string, retainMessage: boolean): Error {
  if (!retainMessage) return new Error("Asset HTTP request failed");
  if (!(value instanceof Error)) return new Error("Non-Error asset HTTP failure");
  const descriptor = Object.getOwnPropertyDescriptor(value, "message");
  const message = descriptor && "value" in descriptor
    ? safeServerText(descriptor.value, MAX_SERVER_MESSAGE_LENGTH, apiKey)
    : null;
  return new Error(message ?? "Asset HTTP request failed");
}
