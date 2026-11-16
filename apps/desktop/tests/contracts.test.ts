import test from "node:test";
import assert from "node:assert/strict";

import { assertReleaseBundleManifest } from "../src/contracts.js";

const signedFields = { webVersion: "2.1.0", clientVersion: "1.9.0", capabilityVersion: 1, platform: "win32", arch: "x64",
  files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 2, sha256: "e".repeat(64) }],
  archiveSha256: "f".repeat(64), archiveSize: 100, expiresAt: "2026-11-24T00:00:00.000Z", keyId: "fixture", signature: "A".repeat(86) + "==" };

test("desktop consumes the shared signed schema 2 contract", () => {
  const manifest = { schemaVersion: 2, releaseId: "signed-release", version: "2.0.0", webVersion: "2.1.0", clientVersion: "1.9.0",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88, platform: "win32", arch: "x64",
    webSha256: "a".repeat(64), clientSha256: "b".repeat(64), packageSha256: "c".repeat(64),
    files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 2, sha256: "e".repeat(64) }],
    archiveSha256: "f".repeat(64), archiveSize: 100, createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-11-24T00:00:00.000Z",
    keyId: "fixture", signature: "A".repeat(86) + "==" };
  assert.deepEqual(assertReleaseBundleManifest(manifest), manifest);
});

test("accepts a complete Web/Client bundle manifest", () => {
  assert.deepEqual(assertReleaseBundleManifest({
    ...signedFields,
    schemaVersion: 2,
    releaseId: "2026.10.24.01",
    version: "2026.10.24.01",
    protocolVersion: 1,
    dbSchemaVersion: 88,
    webSha256: "a".repeat(64),
    clientSha256: "b".repeat(64),
    packageSha256: "c".repeat(64),
    createdAt: "2026-10-24T00:00:00.000Z",
  }).releaseId, "2026.10.24.01");
});

test("rejects a manifest that would allow partial release switching", () => {
  assert.throws(() => assertReleaseBundleManifest({ schemaVersion: 1, releaseId: "x" }), /完整绑定包/);
});

test("rejects a timestamp that is parseable but not canonical ISO", () => {
  assert.throws(() => assertReleaseBundleManifest({
    ...signedFields,
    schemaVersion: 2,
    releaseId: "2026.10.24.01",
    version: "2026.10.24.01",
    protocolVersion: 1,
    dbSchemaVersion: 88,
    webSha256: "a".repeat(64),
    clientSha256: "b".repeat(64),
    packageSha256: "c".repeat(64),
    createdAt: "2026-10-24",
  }), /createdAt/);
});

test("rejects a release ID that escapes the release directory", () => {
  assert.throws(() => assertReleaseBundleManifest({
    ...signedFields,
    schemaVersion: 2,
    releaseId: "../outside",
    version: "2026.10.24.01",
    protocolVersion: 1,
    dbSchemaVersion: 88,
    webSha256: "a".repeat(64),
    clientSha256: "b".repeat(64),
    packageSha256: "c".repeat(64),
    createdAt: "2026-10-24T00:00:00.000Z",
  }), /releaseId/);
});

test("rejects unsupported runtime contracts before a release can be prepared", () => {
  const manifest = {
    ...signedFields,
    schemaVersion: 2, releaseId: "release", version: "1.0.0", protocolVersion: 1, dbSchemaVersion: 88,
    webSha256: "a".repeat(64), clientSha256: "b".repeat(64), packageSha256: "c".repeat(64),
    createdAt: "2026-10-24T00:00:00.000Z",
  };
  for (const protocolVersion of [undefined, 2, "1"]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, protocolVersion }), /protocolVersion/);
  }
  for (const dbSchemaVersion of [undefined, 0, -1, 1.5, "88"]) {
    assert.throws(() => assertReleaseBundleManifest({ ...manifest, dbSchemaVersion }), /dbSchemaVersion/);
  }
  const accepted = assertReleaseBundleManifest(manifest);
  assert.equal(accepted.protocolVersion, 1);
  assert.equal(accepted.dbSchemaVersion, 88);
});
