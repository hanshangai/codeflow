import crypto from "node:crypto";
import { canonicalizeOrchAssetJson, compareOrchAssetCodePoints } from "./utils/orchestrationAssetCanonical.js";

export const DESKTOP_DEVICE_AUTH_PREFIX = "/api/software/desktop/";
export const DESKTOP_DEVICE_AUTH_HEADERS = Object.freeze({ version: "x-codeflow-device-auth", deviceId: "x-codeflow-device-id",
  requestId: "x-codeflow-request-id", timestamp: "x-codeflow-timestamp", signature: "x-codeflow-signature" });
export type DesktopDeviceAuthCode = "DESKTOP_DEVICE_AUTH_INVALID" | "DESKTOP_DEVICE_SIGNATURE_INVALID" | "DESKTOP_DEVICE_AUTH_EXPIRED";
export type DesktopDeviceMetadata = { deviceId: string; requestId: string; timestamp: number; signature: string; range: string | null; ifMatch: string | null };
export type DesktopDeviceRequest = { method: string; url: string; body: Uint8Array; rawHeaders: readonly string[] };
export type DesktopDevicePlatform = { platform: "win32"; arch: "x64" } | { platform: "darwin"; arch: "x64" | "arm64" };

/** 协议失败只保留固定诊断码，不保留签名、正文或密钥材料。 */
export class DesktopDeviceAuthError extends Error {
  /** 认证拒绝由 HTTP 边界转换，不在共享层记录日志。 */
  constructor(readonly code: DesktopDeviceAuthCode) { super(code); this.name = "DesktopDeviceAuthError"; }
}

/** 校验安装声明的壳二进制平台，返回精确支持组合，不推断或转换输入。 */
export function readDesktopDevicePlatform(platform: unknown, arch: unknown): DesktopDevicePlatform {
  if (platform === "win32" && arch === "x64") return { platform, arch };
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return { platform, arch };
  throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
}

/** 精确安装身份与请求标识不得通过裁剪、强制转换或别名改写。 */
export function assertDesktopDeviceIdentity(deviceId: unknown): asserts deviceId is string {
  if (typeof deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(deviceId)) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
}

/** 绑定确切传输字节；无正文须由调用方传入空数组。 */
export function hashDesktopDeviceBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** 公钥必须为完整且规范编码的 Ed25519 SPKI，摘要只覆盖公开 DER。 */
export function desktopDevicePublicKeySha256(value: unknown): string {
  return hashDesktopDeviceBytes(readPublicKey(value).export({ format: "der", type: "spki" }));
}

/** 认证只绑定传输 header 原值，Range 和 ETag 的业务语义由包传输层校验。 */
function transferHeader(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.length || value !== value.trim() || value.length > 1024 || /[^\x20-\x7e]/u.test(value)) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
  return value;
}

/** 规范化查询但保留 pathname；重复键、无效转义和路径规范化歧义直接失败。 */
export function desktopDeviceRequestTarget(url: string): { path: string; query: Array<[string, string]> } {
  if (typeof url !== "string" || !url.startsWith(DESKTOP_DEVICE_AUTH_PREFIX) || url.length > 8192 || /[\x00-\x20\x7f#\\]/u.test(url)) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
  const separator = url.indexOf("?");
  const path = separator < 0 ? url : url.slice(0, separator);
  const queryText = separator < 0 ? "" : url.slice(separator + 1);
  const parsed = new URL(url, "https://desktop.invalid");
  if (parsed.pathname !== path) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  try { decodeURIComponent(path); }
  catch { throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID"); }
  const seen = new Set<string>();
  const query: Array<[string, string]> = [];
  for (const part of queryText ? queryText.split("&") : []) {
    const separator = part.indexOf("=");
    let key: string, value: string;
    try {
      key = decodeURIComponent((separator < 0 ? part : part.slice(0, separator)).replace(/\+/gu, " "));
      value = decodeURIComponent((separator < 0 ? "" : part.slice(separator + 1)).replace(/\+/gu, " "));
    } catch { throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID"); }
    if (!key || seen.has(key)) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
    seen.add(key);
    query.push([key, value]);
  }
  query.sort((left, right) => compareOrchAssetCodePoints(left[0], right[0]) || compareOrchAssetCodePoints(left[1], right[1]));
  return { path, query };
}

/** 唯一签名信封复用既有稳定 JSON；正文摘要不解析或重排原始字节。 */
export function buildDesktopDevicePayload(input: { deviceId: string; method: string; url: string; body: Uint8Array;
  range?: string | null; ifMatch?: string | null; requestId: string; timestamp: number }): Buffer {
  assertDesktopDeviceIdentity(input.deviceId);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(input.requestId) || !Number.isSafeInteger(input.timestamp) || input.timestamp < 0
    || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(input.method) || !(input.body instanceof Uint8Array)
    || ((input.method === "GET" || input.method === "HEAD") && input.body.byteLength)) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  const target = desktopDeviceRequestTarget(input.url);
  return Buffer.from(canonicalizeOrchAssetJson({ protocol: "codeflow.desktop-device-http.v1", deviceId: input.deviceId,
    method: input.method, ...target, bodySha256: hashDesktopDeviceBytes(input.body), range: transferHeader(input.range),
    ifMatch: transferHeader(input.ifMatch), requestId: input.requestId, timestamp: input.timestamp }), "utf8");
}

/** 从原始 headers 拒绝重复认证字段和账号凭据，不依赖 Node 合并后的 header 值。 */
export function readDesktopDeviceHeaders(raw: readonly string[]): DesktopDeviceMetadata {
  if (!Array.isArray(raw) || raw.length % 2) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  const values = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 2) {
    if (typeof raw[index] !== "string" || typeof raw[index + 1] !== "string") throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
    const key = raw[index]!.toLowerCase();
    if (values.has(key) || key === "authorization" || key === "cookie") throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
    values.set(key, raw[index + 1]!);
  }
  const deviceId = values.get(DESKTOP_DEVICE_AUTH_HEADERS.deviceId);
  assertDesktopDeviceIdentity(deviceId);
  const timestamp = values.get(DESKTOP_DEVICE_AUTH_HEADERS.timestamp) ?? "";
  const requestId = values.get(DESKTOP_DEVICE_AUTH_HEADERS.requestId) ?? "";
  const signature = values.get(DESKTOP_DEVICE_AUTH_HEADERS.signature) ?? "";
  if (values.get(DESKTOP_DEVICE_AUTH_HEADERS.version) !== "v1" || !/^(0|[1-9][0-9]{0,15})$/u.test(timestamp)
    || !Number.isSafeInteger(Number(timestamp)) || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(requestId)
    || !/^[A-Za-z0-9+/]{86}==$/u.test(signature) || Buffer.from(signature, "base64").toString("base64") !== signature) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
  return { deviceId, requestId, timestamp: Number(timestamp), signature, range: transferHeader(values.get("range")), ifMatch: transferHeader(values.get("if-match")) };
}

/** 固定五分钟预算仅约束本次请求，过期重试不能沿用旧时间。 */
export function assertDesktopDeviceRequestTime(timestamp: number, now: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(now) || now < 0) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  if (Math.abs(now - timestamp) > 300_000) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_EXPIRED");
}

/** 使用明确公钥验签；解析失败与不匹配均返回固定失败，不泄露原始材料。 */
export function verifyDesktopDeviceSignature(publicKeyBase64: unknown, payload: Uint8Array, signature: string): void {
  const key = readPublicKey(publicKeyBase64);
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)
    || Buffer.from(signature, "base64").toString("base64") !== signature
    || !crypto.verify(null, payload, key, Buffer.from(signature, "base64"))) throw new DesktopDeviceAuthError("DESKTOP_DEVICE_SIGNATURE_INVALID");
}

/** 公钥格式检查不保留解析异常正文或输入材料。 */
function readPublicKey(value: unknown): crypto.KeyObject {
  if (typeof value !== "string" || value.length !== 60 || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" }); }
  catch { throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID"); }
  if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64") !== value) {
    throw new DesktopDeviceAuthError("DESKTOP_DEVICE_AUTH_INVALID");
  }
  return key;
}
