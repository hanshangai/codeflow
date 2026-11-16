import crypto, { KeyObject } from "node:crypto";
import { assertShellReleaseManifest, assertShellReleasePayload, serializeShellReleasePayload,
  type ShellReleaseManifest } from "./desktopShellReleaseContract.js";
import type { TrustedReleaseKeys } from "./desktopReleaseSigning.js";

/** 仅使用显式 Ed25519 私钥签名独立壳域，不读取环境或生成密钥。 */
export function signShellReleaseManifest(value: unknown, privateKey: string | Buffer | KeyObject): ShellReleaseManifest {
  const payload = assertShellReleasePayload(value);
  let key: KeyObject;
  try { key = privateKey instanceof KeyObject ? privateKey : crypto.createPrivateKey(privateKey); }
  catch (cause) { return fail("DESKTOP_SHELL_RELEASE_PRIVATE_KEY_INVALID", cause); }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") fail("DESKTOP_SHELL_RELEASE_PRIVATE_KEY_INVALID");
  try {
    return { ...payload, signature: crypto.sign(null, Buffer.from(serializeShellReleasePayload(payload)), key).toString("base64") };
  } catch (cause) { return fail("DESKTOP_SHELL_RELEASE_SIGNING_FAILED", cause); }
}

/** 验签只消费自有信任根公钥，拒绝私钥推导、公钥访问器及跨域签名。 */
export function verifyShellReleaseSignature(value: unknown, trustedKeys: TrustedReleaseKeys): ShellReleaseManifest {
  const manifest = assertShellReleaseManifest(value);
  const descriptor = trustedKeys && typeof trustedKeys === "object" ? Object.getOwnPropertyDescriptor(trustedKeys, manifest.keyId) : undefined;
  if (!descriptor) fail("DESKTOP_SHELL_RELEASE_UNTRUSTED_KEY");
  if (!("value" in descriptor)) fail("DESKTOP_SHELL_RELEASE_PUBLIC_KEY_INVALID");
  const configured: unknown = descriptor.value;
  let key: KeyObject;
  if (configured instanceof KeyObject) key = configured;
  else if (typeof configured === "string" && configured.startsWith("-----BEGIN PUBLIC KEY-----")) {
    try { key = crypto.createPublicKey(configured); }
    catch (cause) { return fail("DESKTOP_SHELL_RELEASE_PUBLIC_KEY_INVALID", cause); }
  } else return fail("DESKTOP_SHELL_RELEASE_PUBLIC_KEY_INVALID");
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") fail("DESKTOP_SHELL_RELEASE_PUBLIC_KEY_INVALID");
  let valid: boolean;
  try { valid = crypto.verify(null, Buffer.from(serializeShellReleasePayload(manifest)), key, Buffer.from(manifest.signature, "base64")); }
  catch (cause) { return fail("DESKTOP_SHELL_RELEASE_VERIFICATION_FAILED", cause); }
  if (!valid) fail("DESKTOP_SHELL_RELEASE_SIGNATURE_INVALID");
  return manifest;
}

/** 异常翻译保持显式失败，消息不包含输入正文、签名或密钥材料。 */
function fail(code: string, cause?: unknown): never {
  throw Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}
