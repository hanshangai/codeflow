import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { assertDesktopStartupCapability, DESKTOP_STARTUP_CAPABILITY_PATH } from "@codeflowai/shared";
import { signReleaseBundleManifest, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";

const hash = "a".repeat(64);

test("startup capability snapshots only the supported protocol and exact entry digest", () => {
  const input = { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash };
  const snapshot = assertDesktopStartupCapability(input);
  assert.deepEqual(snapshot, { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash });
  assert.notEqual(snapshot, input);
  input.clientEntrySha256 = "b".repeat(64);
  assert.equal(snapshot.clientEntrySha256, hash);
  assert.deepEqual(assertDesktopStartupCapability(Object.assign(Object.create(null), snapshot)), snapshot);
});

for (const value of [null, [], "held", {},
  { schemaVersion: 2, heldStartupProtocol: 1, clientEntrySha256: hash },
  { schemaVersion: 1, heldStartupProtocol: "1", clientEntrySha256: hash },
  { schemaVersion: 1, heldStartupProtocol: 2, clientEntrySha256: hash },
  { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: "A".repeat(64) },
  { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: "a".repeat(63) },
  { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash, enabled: true },
  Object.assign(Object.create({ inherited: true }), { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash }),
]) test(`startup capability rejects malformed input ${JSON.stringify(value)}`, () => {
  assert.throws(() => assertDesktopStartupCapability(value), /DESKTOP_STARTUP_CAPABILITY_INVALID/u);
});

test("startup capability rejects accessor, hidden and symbol fields without executing getters", () => {
  let reads = 0;
  const accessor = { schemaVersion: 1, heldStartupProtocol: 1, get clientEntrySha256() { reads++; return hash; } };
  const hidden = Object.defineProperty({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash }, "clientEntrySha256", { enumerable: false });
  const symbol = { schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: hash, [Symbol("extra")]: true };
  for (const input of [accessor, hidden, symbol]) assert.throws(() => assertDesktopStartupCapability(input), /DESKTOP_STARTUP_CAPABILITY_INVALID/u);
  assert.equal(reads, 0);
});

test("the existing schema 2 capability 1 signature covers an optional startup marker inventory entry", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const markerBytes = Buffer.from('{"schemaVersion":1,"heldStartupProtocol":1,"clientEntrySha256":"' + hash + '"}\n', "utf8");
  const files = [{ path: "client/dist/index.cjs", size: 6, sha256: hash }, { path: "web/index.html", size: 3, sha256: "b".repeat(64) }];
  const payload = { schemaVersion: 2, releaseId: "capability-fixture", version: "1", webVersion: "1", clientVersion: "1", protocolVersion: 1,
    capabilityVersion: 1, dbSchemaVersion: 92, platform: "win32", arch: "x64", webSha256: "b".repeat(64), clientSha256: hash,
    packageSha256: "c".repeat(64), archiveSha256: "d".repeat(64), archiveSize: 1,
    createdAt: "2026-10-28T00:00:00.000Z", expiresAt: "2027-10-28T00:00:00.000Z", keyId: "fixture", files };
  assert.equal(verifyReleaseBundleSignature(signReleaseBundleManifest(payload, privateKey), { fixture: publicKey }).capabilityVersion, 1);
  const markerPath = DESKTOP_STARTUP_CAPABILITY_PATH;
  const signed = signReleaseBundleManifest({ ...payload, files: [
    { path: markerPath, size: markerBytes.length, sha256: crypto.createHash("sha256").update(markerBytes).digest("hex") }, ...files,
  ] }, privateKey);
  assert.equal(verifyReleaseBundleSignature(signed, { fixture: publicKey }).files[0]!.path, "client/dist/desktop-startup-capability.json");
  const tampered = structuredClone(signed); tampered.files[0]!.sha256 = "e".repeat(64);
  assert.throws(() => verifyReleaseBundleSignature(tampered, { fixture: publicKey }), /SIGNATURE_INVALID/u);
});
