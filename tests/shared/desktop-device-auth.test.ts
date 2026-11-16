import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import * as desktopDeviceAuth from "../../packages/shared/src/desktopDeviceAuth.ts";
import { buildDesktopDevicePayload, hashDesktopDeviceBytes, verifyDesktopDeviceSignature, readDesktopDeviceHeaders,
  assertDesktopDeviceRequestTime, DESKTOP_DEVICE_AUTH_HEADERS } from "../../packages/shared/src/desktopDeviceAuth.ts";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";
const pair = crypto.generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const input = { deviceId, method: "POST", url: "/api/software/desktop/report?z=%E4%B8%AD&a=1", body: Buffer.from('{"phase":"healthy"}'),
  range: "bytes=1-", ifMatch: '"digest"', requestId: "request-1", timestamp: 100_000 };

test("device platform accepts only exact supported binary platform pairs without aliases or coercion", () => {
  const read = (desktopDeviceAuth as unknown as { readDesktopDevicePlatform: (platform: unknown, arch: unknown) => unknown }).readDesktopDevicePlatform;
  assert.equal(typeof read, "function");
  for (const value of [{ platform: "win32", arch: "x64" }, { platform: "darwin", arch: "x64" }, { platform: "darwin", arch: "arm64" }]) {
    assert.deepEqual(read(value.platform, value.arch), value);
  }
  for (const [platform, arch] of [["win32", "arm64"], ["linux", "x64"], ["darwin", "ia32"], ["Windows", "x64"],
    ["darwin ", "arm64"], ["darwin", "ARM64"], [null, "x64"], ["darwin", undefined], [undefined, undefined], ["darwin", null], [42, "x64"], [{ toString: () => "darwin" }, "x64"]]) {
    assert.throws(() => read(platform, arch), error => error instanceof desktopDeviceAuth.DesktopDeviceAuthError
      && error.code === "DESKTOP_DEVICE_AUTH_INVALID" && error.message === "DESKTOP_DEVICE_AUTH_INVALID");
  }
});

test("device signatures bind method, raw path, normalized query, exact body and transfer metadata", () => {
  const payload = buildDesktopDevicePayload(input);
  const signature = crypto.sign(null, payload, pair.privateKey).toString("base64");
  verifyDesktopDeviceSignature(publicKey, payload, signature);
  assert.deepEqual(buildDesktopDevicePayload({ ...input, url: "/api/software/desktop/report?a=1&z=%E4%B8%AD" }), payload);
  for (const mutation of [{ method: "GET", body: Buffer.alloc(0) }, { url: "/api/software/desktop/other?z=%E4%B8%AD&a=1" },
    { url: "/api/software/desktop/report?z=%E4%B8%AD&a=2" }, { body: Buffer.from('{ "phase":"healthy"}') },
    { range: "bytes=2-" }, { ifMatch: '"other"' }, { requestId: "request-2" }, { timestamp: 100_001 },
    { deviceId: "3b56bc3b-28ea-4d9a-8a32-7881a29b3648" }]) {
    assert.throws(() => verifyDesktopDeviceSignature(publicKey, buildDesktopDevicePayload({ ...input, ...mutation }), signature));
  }
  assert.equal(hashDesktopDeviceBytes(Buffer.alloc(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("device metadata rejects ambiguous headers, query, malformed fields and nonempty GET bodies", () => {
  const headers = Object.entries(DESKTOP_DEVICE_AUTH_HEADERS).flatMap(([key, name]) => [name,
    ({ version: "v1", deviceId, requestId: "request-1", timestamp: "100000", signature: Buffer.alloc(64).toString("base64") } as Record<string, string>)[key]!]);
  assert.equal(readDesktopDeviceHeaders(headers).deviceId, deviceId);
  for (const raw of [[...headers, "X-CodeFlow-Device-Id", deviceId], [...headers, "Range", "a", "range", "b"],
    [...headers, "If-Match", "x\ny"], [...headers, "Authorization", "Bearer forbidden"],
    [...headers, "x-extra", "a", "X-Extra", "b"], [...headers, "Range", " bytes=1-"]]) assert.throws(() => readDesktopDeviceHeaders(raw));
  for (const mutation of [{ url: "/api/software/desktop/report?a=1&a=2" }, { url: "/api/software/desktop/../other" },
    { url: "https://elsewhere.invalid/api/software/desktop/report" }, { url: "/api/software/desktop/report?x=%zz" },
    { url: "/api/software/desktop/%zz" },
    { method: "GET" }, { deviceId: "bad" }, { timestamp: NaN }, { requestId: "has space" }]) {
    assert.throws(() => buildDesktopDevicePayload({ ...input, ...mutation }));
  }
  assertDesktopDeviceRequestTime(100_000, 400_000);
  assert.throws(() => assertDesktopDeviceRequestTime(100_000, 400_001));
  assert.throws(() => assertDesktopDeviceRequestTime(400_001, 100_000));
});
