import { assertDesktopDeviceIdentity, desktopDevicePublicKeySha256, hashDesktopDeviceBytes, verifyDesktopDeviceSignature } from "./desktopDeviceAuth.js";
import { canonicalizeOrchAssetJson } from "./utils/orchestrationAssetCanonical.js";

export const CLIENT_MIGRATION_PATH = "/api/account/auth/client-migration";
export type ClientMigrationRequest = { schemaVersion: 1; migrationId: string; sourceClientId: string; targetClientId: string;
  deviceId: string; publicKey: string; timestamp: number; nonce: string; signature: string };
export type ClientMigrationUnsignedRequest = Omit<ClientMigrationRequest, "signature">;
export type ClientMigrationAuthCode = "CLIENT_MIGRATION_INVALID" | "CLIENT_MIGRATION_EXPIRED" | "CLIENT_MIGRATION_SIGNATURE_INVALID";

/** 协议错误仅包含稳定错误码，不保留凭据或签名正文。 */
export class ClientMigrationAuthError extends Error {
  /** 将输入或验签失败交由 HTTP 边界显式翻译。 */
  constructor(readonly code: ClientMigrationAuthCode) { super(code); this.name = "ClientMigrationAuthError"; }
}

/** 严格检查非秘密字段；调用者不得补值或改写安装身份。 */
function assertUnsigned(value: unknown): asserts value is ClientMigrationUnsignedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID");
  const request = value as Record<string, unknown>;
  if (request.schemaVersion !== 1 || !Number.isSafeInteger(request.timestamp) || Number(request.timestamp) < 0
    || ![request.sourceClientId, request.targetClientId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200
      && id === id.trim() && !/[\x00-\x1f\x7f]/u.test(id))) throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID");
  try {
    assertDesktopDeviceIdentity(request.migrationId);
    assertDesktopDeviceIdentity(request.deviceId);
    assertDesktopDeviceIdentity(request.nonce);
    desktopDevicePublicKeySha256(request.publicKey);
  } catch { throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID"); }
}

/** 完整请求只允许声明字段；未知账号、角色或路由字段一律拒绝。 */
export function assertClientMigrationRequest(value: unknown): asserts value is ClientMigrationRequest {
  assertUnsigned(value);
  const fields = ["schemaVersion", "migrationId", "sourceClientId", "targetClientId", "deviceId", "publicKey", "timestamp", "nonce", "signature"];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))
    || typeof (value as ClientMigrationRequest).signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test((value as ClientMigrationRequest).signature)
    || Buffer.from((value as ClientMigrationRequest).signature, "base64").toString("base64") !== (value as ClientMigrationRequest).signature) {
    throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID");
  }
}

/** 固定方法和路径，绑定全部声明字段及 Bearer 摘要；明文 Key 不进入信封。 */
export function buildClientMigrationPayload(request: ClientMigrationUnsignedRequest, apiKey: string): Buffer {
  assertUnsigned(request);
  if (typeof apiKey !== "string" || !apiKey.length || apiKey.length > 4096 || apiKey !== apiKey.trim() || apiKey.startsWith("sess_")) {
    throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID");
  }
  return Buffer.from(canonicalizeOrchAssetJson({ protocol: "codeflow.client-migration.v1", method: "POST", path: CLIENT_MIGRATION_PATH,
    schemaVersion: request.schemaVersion, migrationId: request.migrationId, sourceClientId: request.sourceClientId,
    targetClientId: request.targetClientId, deviceId: request.deviceId, publicKey: request.publicKey, timestamp: request.timestamp,
    nonce: request.nonce, apiKeySha256: hashDesktopDeviceBytes(Buffer.from(apiKey, "utf8")) }), "utf8");
}

/** 五分钟请求预算与安装私钥证明共同验证，重试保留领取身份并刷新时间。 */
export function verifyClientMigrationRequest(value: unknown, apiKey: string, now: number): ClientMigrationRequest {
  assertClientMigrationRequest(value);
  if (!Number.isSafeInteger(now) || now < 0) throw new ClientMigrationAuthError("CLIENT_MIGRATION_INVALID");
  if (Math.abs(now - value.timestamp) > 300_000) throw new ClientMigrationAuthError("CLIENT_MIGRATION_EXPIRED");
  const payload = buildClientMigrationPayload(value, apiKey);
  try { verifyDesktopDeviceSignature(value.publicKey, payload, value.signature); }
  catch { throw new ClientMigrationAuthError("CLIENT_MIGRATION_SIGNATURE_INVALID"); }
  return value;
}
