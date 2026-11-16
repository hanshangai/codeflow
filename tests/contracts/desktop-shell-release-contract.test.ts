import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { assertReleaseBundleManifest } from "../../packages/shared/src/desktopReleaseContract.js";
import { signReleaseBundleManifest } from "../../packages/shared/src/desktopReleaseSigning.js";
import { assertShellReleaseFilePath, assertShellReleaseManifest, assertShellReleasePayload, serializeShellReleasePayload,
  SHELL_RELEASE_PROTOCOL, type ShellReleaseFile } from "../../packages/shared/src/desktopShellReleaseContract.js";
import { signShellReleaseManifest, verifyShellReleaseSignature } from "../../packages/shared/src/desktopShellReleaseSigning.js";

/** 使用固定库存与临时密钥，禁止依赖真实发布或环境中的签名材料。 */
function payload() {
  return { schemaVersion: 1 as const, protocol: "codeflow-desktop-shell-v1" as const, shellId: "2026.10.27.01", version: "2.0.0",
    platform: "win32" as const, arch: "x64" as const, installerSha256: "a".repeat(64), installerSize: 100,
    files: [{ path: "CodeFlowAI.exe", size: 12, sha256: "b".repeat(64) },
      { path: "resources/app.asar", size: 34, sha256: "c".repeat(64) },
      { path: "resources/release-trust.json", size: 56, sha256: "d".repeat(64) }],
    createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-27T00:00:00.000Z", keyId: "fixture" };
}

/** 独立构造旧绑定包，只验证两个发布合同始终相互隔离。 */
function bundlePayload() {
  return { schemaVersion: 2 as const, releaseId: "2026.10.27.01", version: "2.0.0", webVersion: "2.0.0", clientVersion: "2.0.0",
    protocolVersion: 1 as const, capabilityVersion: 1 as const, dbSchemaVersion: 88, platform: "win32" as const, arch: "x64" as const,
    webSha256: "a".repeat(64), clientSha256: "b".repeat(64), packageSha256: "c".repeat(64),
    files: [{ path: "client/dist/index.cjs", size: 1, sha256: "d".repeat(64) }, { path: "web/index.html", size: 2, sha256: "e".repeat(64) }],
    archiveSha256: "f".repeat(64), archiveSize: 100, createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-27T00:00:00.000Z", keyId: "fixture" };
}

/** 保持原始路径升序，为库存反例排除无关的排序失败。 */
function ordered(files: ShellReleaseFile[]): ShellReleaseFile[] {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

test("canonical shell bytes are stable and a real Ed25519 manifest round-trips", () => {
  const value = payload();
  const canonical = JSON.stringify(value);
  assert.equal(SHELL_RELEASE_PROTOCOL, "codeflow-desktop-shell-v1");
  assert.equal(serializeShellReleasePayload(value), canonical);
  assert.equal(serializeShellReleasePayload(Object.fromEntries(Object.entries(value).reverse())), canonical);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = signShellReleaseManifest(value, privateKey);
  assert.deepEqual(verifyShellReleaseSignature(manifest, { fixture: publicKey }), manifest);
  assert.equal(serializeShellReleasePayload(manifest), canonical);
  assert.equal(Buffer.from(manifest.signature, "base64").byteLength, 64);
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.deepEqual(verifyShellReleaseSignature(manifest, { fixture: pem }), manifest);
  assert.deepEqual(signShellReleaseManifest(value, privateKey.export({ format: "pem", type: "pkcs8" })), manifest);
});

test("signed snapshots do not retain caller-owned files or objects", () => {
  const value = payload();
  const snapshot = assertShellReleasePayload(value);
  assert.notEqual(snapshot, value);
  assert.notEqual(snapshot.files, value.files);
  assert.notEqual(snapshot.files[0], value.files[0]);
  value.files[0]!.size = 999;
  value.version = "changed";
  assert.equal(snapshot.files[0]!.size, 12);
  assert.equal(snapshot.version, "2.0.0");
});

test("real signatures reject tampering, unknown trust and another temporary key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = signShellReleaseManifest(payload(), privateKey);
  for (const change of [{ version: "attacker" }, { installerSize: 101 }, { installerSha256: "f".repeat(64) },
    { files: payload().files.map(file => ({ ...file, size: file.size + 1 })) }]) {
    assert.throws(() => verifyShellReleaseSignature({ ...manifest, ...change }, { fixture: publicKey }), /SIGNATURE_INVALID/);
  }
  assert.throws(() => verifyShellReleaseSignature(manifest, {}), /UNTRUSTED_KEY/);
  assert.throws(() => verifyShellReleaseSignature(manifest, { fixture: generateKeyPairSync("ed25519").publicKey }), /SIGNATURE_INVALID/);
  assert.throws(() => verifyShellReleaseSignature(manifest, Object.create({ fixture: publicKey })), /UNTRUSTED_KEY/);
});

test("the same key cannot transfer a signature from another domain or schema 2", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const value = payload();
  const wrongDomain = { ...value, protocol: "codeflow-desktop-shell-other" };
  const signature = sign(null, Buffer.from(JSON.stringify(wrongDomain)), privateKey).toString("base64");
  assert.throws(() => verifyShellReleaseSignature({ ...value, signature }, { fixture: publicKey }), /SIGNATURE_INVALID/);
  assert.throws(() => verifyShellReleaseSignature({ ...wrongDomain, signature }, { fixture: publicKey }), /protocol/);
  const shellManifest = signShellReleaseManifest(value, privateKey);
  const bundleManifest = signReleaseBundleManifest(bundlePayload(), privateKey);
  assert.throws(() => verifyShellReleaseSignature(bundleManifest, { fixture: publicKey }), /PAYLOAD_INVALID/);
  assert.throws(() => assertReleaseBundleManifest(shellManifest), /完整绑定包/);
});

test("shell fields reject alternate schemas, unsafe identifiers and noncanonical values", () => {
  for (const change of [{ schemaVersion: 2 }, { protocol: "other" }, { platform: "darwin" }, { arch: "arm64" },
    { shellId: "../shell" }, { shellId: "CON" }, { shellId: "x".repeat(129) }, { version: "" }, { version: " 2.0.0" },
    { installerSize: 0 }, { installerSize: -1 }, { installerSize: 0.5 }, { installerSize: Number.MAX_SAFE_INTEGER + 1 },
    { installerSha256: "A".repeat(64) }, { installerSha256: "bad" }, { unexpected: true }, { keyId: "../key" },
    { createdAt: "2026-10-27" }, { createdAt: "2026-10-27T08:00:00.000+08:00" },
    { expiresAt: "2026-10-27T00:00:00.000Z" }, { expiresAt: "2026-10-26T00:00:00.000Z" }]) {
    assert.throws(() => assertShellReleasePayload({ ...payload(), ...change }), /DESKTOP_SHELL_RELEASE_PAYLOAD_INVALID/);
  }
  const missing = { ...payload() } as Record<string, unknown>;
  delete missing.version;
  assert.throws(() => assertShellReleasePayload(missing), /version/);
  assert.equal(assertShellReleasePayload({ ...payload(), shellId: "x".repeat(128) }).shellId.length, 128);
  assert.equal(assertShellReleasePayload({ ...payload(), createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-02-01T00:00:00.000Z" }).version, "2.0.0");
});

test("unknown, inherited, symbol and accessor fields fail without invoking getters", () => {
  const value = payload();
  const getter = { ...value };
  Object.defineProperty(getter, "version", { get() { assert.fail("payload getter executed"); }, enumerable: true });
  const symbol = { ...value, [Symbol("hidden")]: true };
  for (const input of [getter, symbol, Object.assign(Object.create(value), { version: "2.0.0" }),
    Object.assign(Object.create({ inherited: true }), value)]) {
    assert.throws(() => assertShellReleasePayload(input), /PAYLOAD_INVALID/);
  }
  const fileGetter = { ...value.files[0] };
  Object.defineProperty(fileGetter, "size", { get() { assert.fail("file getter executed"); }, enumerable: true });
  assert.throws(() => assertShellReleasePayload({ ...value, files: [fileGetter, ...value.files.slice(1)] }), /files/);
  const nullPrototype = Object.assign(Object.create(null), value);
  assert.equal(assertShellReleasePayload(nullPrototype).version, "2.0.0");
});

test("shell paths reject traversal, Windows aliases and device names", () => {
  for (const filePath of ["", "/CodeFlowAI.exe", "../CodeFlowAI.exe", "resources/../app.asar", "resources//app.asar", "./CodeFlowAI.exe",
    "resources/a\\b", "C:/CodeFlowAI.exe", "resources/a:b", "resources/a\u0000b", "resources/a\u007fb", "resources/a\u0085b",
    "resources/CON", "resources/aux.txt", "resources/COM1.dll", "resources/LPT9", "resources/COM¹", "resources/LPT².txt",
    "resources/CONIN$", "resources/CONOUT$.txt",
    "resources/a.", "resources/a ", "resources/a?b", "resources/a|b", "resources/a<b", "resources/a\"b"]) {
    assert.throws(() => assertShellReleaseFilePath(filePath), /files.path/);
  }
  for (const filePath of ["CodeFlowAI.exe", "resources/app.asar", "locales/zh-CN.pak", "resources/资源.dat"]) {
    assert.equal(assertShellReleaseFilePath(filePath), filePath);
  }
});

test("inventory rejects sparse arrays, aliases, conflicts and missing exact entry files", () => {
  const value = payload();
  const file = value.files[0]!;
  const sparse = [...value.files];
  delete sparse[1];
  const accessor = [...value.files];
  Object.defineProperty(accessor, "0", { get() { assert.fail("array getter executed"); }, enumerable: true });
  const extra = Object.assign([...value.files], { unexpected: true });
  const symbolic = Object.assign([...value.files], { [Symbol("hidden")]: true });
  const inherited = [...value.files];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  for (const files of [[], value.files.slice(1), value.files.slice(0, 2), value.files.filter(entry => entry.path !== "resources/app.asar"),
    [...value.files].reverse(), [...value.files, file], sparse, accessor, extra, symbolic, inherited,
    ordered([...value.files, { ...file, path: "codeflowai.exe" }]),
    ordered([...value.files, { ...file, path: "resources" }]),
    ordered([...value.files, { ...file, path: "CodeFlowAI.exe/child" }]),
    ordered([...value.files, { ...file, path: "Resources/new.dat" }]),
    ordered([...value.files, { ...file, path: "Dir/a" }, { ...file, path: "dir/b" }]),
    [{ ...file, size: -1 }, ...value.files.slice(1)], [{ ...file, size: 0.5 }, ...value.files.slice(1)],
    [{ ...file, size: Number.MAX_SAFE_INTEGER + 1 }, ...value.files.slice(1)],
    [{ ...file, sha256: "A".repeat(64) }, ...value.files.slice(1)],
    [{ ...file, extra: true }, ...value.files.slice(1)],
    [{ ...file, [Symbol("hidden")]: true }, ...value.files.slice(1)]]) {
    assert.throws(() => assertShellReleasePayload({ ...value, files }), /files/);
  }
  assert.equal(assertShellReleasePayload({ ...value, files: [{ ...file, size: 0 }, ...value.files.slice(1)] }).files[0]!.size, 0);
});

test("only canonical 64-byte Base64 signatures are accepted", () => {
  const value = payload();
  const canonical = "A".repeat(86) + "==";
  assert.equal(assertShellReleaseManifest({ ...value, signature: canonical }).signature, canonical);
  for (const signature of ["", "bad", "A".repeat(85) + "B==", "A".repeat(86), canonical + "\n", "A".repeat(88),
    Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")]) {
    assert.throws(() => assertShellReleaseManifest({ ...value, signature }), /signature/);
  }
  assert.throws(() => assertShellReleasePayload({ ...value, signature: canonical }), /signature/);
  const accessor = { ...value };
  Object.defineProperty(accessor, "signature", { get() { assert.fail("signature getter executed"); }, enumerable: true });
  assert.throws(() => serializeShellReleasePayload(accessor), /signature/);
});

test("validation errors expose structured fields without echoing attacker-controlled names", () => {
  const secret = "unknown-field-secret-sentinel\nsecond-line";
  for (const field of [secret, Symbol(secret)]) {
    assert.throws(() => assertShellReleasePayload({ ...payload(), [field]: true }), error => {
      const failure = error as Error & { code: string; field: string };
      assert.equal(failure.code, "DESKTOP_SHELL_RELEASE_PAYLOAD_INVALID");
      assert.equal(failure.field, "fields");
      assert.equal(failure.message.includes(secret), false);
      return true;
    });
    assert.throws(() => assertShellReleasePayload({ ...payload(), files: [{ ...payload().files[0], [field]: true }, ...payload().files.slice(1)] }), error => {
      const failure = error as Error & { code: string; field: string };
      assert.equal(failure.field, "files.fields");
      assert.equal(failure.message.includes(secret), false);
      return true;
    });
  }
});

test("signing and trust reject public/private role confusion and non-Ed25519 material", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifest = signShellReleaseManifest(payload(), privateKey);
  assert.throws(() => signShellReleaseManifest(payload(), publicKey), /PRIVATE_KEY_INVALID/);
  assert.throws(() => signShellReleaseManifest(payload(), rsa.privateKey), /PRIVATE_KEY_INVALID/);
  assert.throws(() => signShellReleaseManifest(payload(), "not a key"), error => {
    assert.match((error as Error).message, /PRIVATE_KEY_INVALID/);
    assert.ok((error as Error).cause);
    assert.equal((error as Error).message.includes("not a key"), false);
    return true;
  });
  for (const key of [privateKey, privateKey.export({ format: "pem", type: "pkcs8" }).toString(), rsa.publicKey,
    rsa.publicKey.export({ format: "pem", type: "spki" }).toString(), "not a key"]) {
    assert.throws(() => verifyShellReleaseSignature(manifest, { fixture: key }), /PUBLIC_KEY_INVALID/);
  }
  const accessor = Object.defineProperty({}, "fixture", { get() { assert.fail("trust getter executed"); }, enumerable: true });
  assert.throws(() => verifyShellReleaseSignature(manifest, accessor), /PUBLIC_KEY_INVALID/);
});
