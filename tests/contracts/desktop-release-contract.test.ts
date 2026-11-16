import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

import { assertReleaseBundleManifest, serializeReleaseBundlePayload } from "../../packages/shared/src/desktopReleaseContract.js";
import { assertTrustedReleaseKeys, signReleaseBundleManifest, verifyReleaseBundleSignature } from "../../packages/shared/src/desktopReleaseSigning.js";

/** 固定合同样本不依赖磁盘、现有发布或生产签名材料。 */
function payload() {
  return { schemaVersion: 2 as const, releaseId: "2026.10.24.01", version: "2.0.0", webVersion: "2.1.0", clientVersion: "1.9.0",
    protocolVersion: 1 as const, capabilityVersion: 1 as const, dbSchemaVersion: 88, platform: "win32" as const, arch: "x64" as const,
    webSha256: "a".repeat(64), clientSha256: "b".repeat(64), packageSha256: "c".repeat(64),
    files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 2, sha256: "e".repeat(64) }],
    archiveSha256: "f".repeat(64), archiveSize: 100, createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-11-24T00:00:00.000Z", keyId: "fixture" };
}

test("schema 2 has one canonical signature payload independent of object insertion order", () => {
  const value = payload();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(serializeReleaseBundlePayload(value), serializeReleaseBundlePayload(reversed));
  assert.equal(serializeReleaseBundlePayload(value), JSON.stringify(value));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = signReleaseBundleManifest(value, privateKey);
  assert.equal(assertReleaseBundleManifest(manifest).clientVersion, "1.9.0");
  assert.deepEqual(verifyReleaseBundleSignature(manifest, { fixture: publicKey }), manifest);
  assert.equal(serializeReleaseBundlePayload(manifest), serializeReleaseBundlePayload(value));
});

test("real Ed25519 rejects tampering, unknown keys and an unrelated signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = signReleaseBundleManifest(payload(), privateKey);
  assert.throws(() => verifyReleaseBundleSignature({ ...manifest, clientVersion: "attacker" }, { fixture: publicKey }), /SIGNATURE_INVALID/);
  assert.throws(() => verifyReleaseBundleSignature(manifest, {}), /UNTRUSTED_KEY/);
  const other = generateKeyPairSync("ed25519");
  const forged = signReleaseBundleManifest(payload(), other.privateKey);
  assert.throws(() => verifyReleaseBundleSignature(forged, { fixture: publicKey }), /SIGNATURE_INVALID/);
  assert.throws(() => verifyReleaseBundleSignature({ ...manifest, publicKey }, { fixture: publicKey }), /publicKey/);
});

test("rejects old schemas, unknown fields, unsupported capabilities and platform pairs", () => {
  const manifest = { ...payload(), signature: "A".repeat(86) + "==" };
  for (const change of [{ schemaVersion: 1 }, { protocolVersion: 2 }, { capabilityVersion: 2 }, { platform: "linux" },
    { platform: "win32", arch: "arm64" }, { arch: "ia32" }, { archiveSize: 0 }, { archiveSize: 1.5 }, { unexpected: true },
    { clientVersion: " " }, { webVersion: undefined }, { signature: "bad" }, { keyId: "../key" },
    { createdAt: "2026-10-24" }, { expiresAt: "2026-10-23T00:00:00.000Z" }]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, ...change }), /完整绑定包/);
  }
  for (const arch of ["x64", "arm64"]) assert.equal(assertReleaseBundleManifest({ ...manifest, platform: "darwin", arch }).arch, arch);
});

test("file inventory is exact, portable, ordered and contains both runtime entries", () => {
  const manifest = { ...payload(), signature: "A".repeat(86) + "==" };
  const file = manifest.files[0]!;
  for (const filePath of ["../client/index.cjs", "/web/index.html", "web/../index.html", "web//index.html", "web/a\\b", "web/a:b",
    "web/CON", "web/a.", "web/a ", "manifest.json", "other/index.html", "web/a\u0000b"]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, files: [{ ...file, path: filePath }, manifest.files[1]] }), /files/);
  }
  for (const files of [[], [file], [file, file, manifest.files[1]], [...manifest.files].reverse(),
    [file, { ...file, path: "client/DIST/index.cjs" }, manifest.files[1]],
    [{ ...file, path: "client/A/b" }, { ...file, path: "client/a" }, ...manifest.files],
    [{ ...file, size: -1 }, manifest.files[1]], [{ ...file, sha256: "invalid" }, manifest.files[1]],
    [{ ...file, extra: true }, manifest.files[1]]]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, files }), /files/);
  }
});

test("release IDs and trust keys reject unsafe names or private and non-Ed25519 material", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const valid = { fixture: publicKey.export({ format: "pem", type: "spki" }) };
  const manifest = signReleaseBundleManifest(payload(), privateKey);
  assert.equal(verifyReleaseBundleSignature(manifest, assertTrustedReleaseKeys(valid)).keyId, "fixture");
  assert.throws(() => assertTrustedReleaseKeys({ fixture: privateKey.export({ format: "pem", type: "pkcs8" }) }), /TRUST_INVALID/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => assertTrustedReleaseKeys({ fixture: rsa.publicKey.export({ format: "pem", type: "spki" }) }), /TRUST_INVALID/);
  for (const releaseId of ["CON", "aux.txt", "LPT1", "release."]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, releaseId }), /releaseId/);
  }
});
