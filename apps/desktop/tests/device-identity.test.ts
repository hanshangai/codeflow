import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createDesktopUpdateReceipt, toDesktopUpdateReceiptAck } from "@codeflowai/shared/desktop-update-receipt";

import { loadOrCreateDeviceIdentity, removeDesktopDeviceIdentity, signDevicePayload } from "../src/deviceIdentity.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";

/** 删除用例只创建临时签名身份和无秘密的保留文件。 */
async function removalFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "codeflow-remove-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"), identity = await loadOrCreateDeviceIdentity(dataDir);
  const file = path.join(dataDir, "device-identity.json"), bytes = await fs.readFile(file);
  await fs.writeFile(path.join(dataDir, "config.json"), "retained-config", "utf8");
  return { root, dataDir, file, identity, bytes };
}

test("D16 keep 删除精确旧签名身份且保留数据，同授权缺失重试不生成身份", async t => {
  const f = await removalFixture(t);
  await removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.dataDir, "config.json"), "utf8"), "retained-config");
  await removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId);
  assert.deepEqual(await fs.readdir(f.dataDir), ["config.json"]);
});

test("D16 keep 拒绝空路径、相对路径、非法UUID和不存在目录，不创建删除目标", async t => {
  const f = await removalFixture(t);
  for (const dataDir of ["", " ", ".", `${f.dataDir} `, `${f.dataDir}\u0000`]) {
    await assert.rejects(removeDesktopDeviceIdentity(dataDir, f.identity.deviceId));
  }
  for (const deviceId of ["", "not-a-uuid", ` ${f.identity.deviceId}`, `${f.identity.deviceId}\n`, "00000000-0000-0000-0000-000000000000"]) {
    await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, deviceId), /DESKTOP_DEVICE_IDENTITY_REMOVE_INVALID/u);
  }
  const missing = path.join(f.root, "missing", "data");
  await assert.rejects(removeDesktopDeviceIdentity(missing, f.identity.deviceId), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.dirname(missing)), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test("D16 keep 旧格式、第三身份和坏签名均保原字节且不泄露私钥", async t => {
  const f = await removalFixture(t), stored = JSON.parse(f.bytes.toString("utf8"));
  for (const invalid of [
    { deviceId: f.identity.deviceId, createdAt: f.identity.createdAt },
    { ...stored, deviceId: crypto.randomUUID() },
    { ...stored, privateKeyBase64: "private-secret-fragment" },
    { ...stored, publicKeyBase64: "wrong-public-key" },
  ]) {
    const bytes = Buffer.from(JSON.stringify(invalid)); await fs.writeFile(f.file, bytes);
    await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => {
      assert.ok(error instanceof Error);
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
        assert.ok(!cause.message.includes(stored.privateKeyBase64)); assert.doesNotMatch(cause.message, /private-secret-fragment/u);
      }
      return true;
    });
    assert.deepEqual(await fs.readFile(f.file), bytes);
  }
});

test("D16 keep unlink IO错误显式保因，文件已删后报错可按同授权幂等重试", async t => {
  const f = await removalFixture(t), unlink = fs.unlink, failure = Object.assign(new Error("fixture unlink IO failed"), { code: "EIO" });
  let mode: "before" | "after" | "normal" = "before", calls = 0;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (!String(args[0]).startsWith(`${f.file}.removing-`)) return unlink(...args);
    calls++;
    if (mode === "before") throw failure;
    await unlink(...args);
    if (mode === "after") throw failure;
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => error === failure);
  const captured = (await fs.readdir(f.dataDir)).find(name => name.startsWith("device-identity.json.removing-"))!;
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, captured)), f.bytes);
  mode = "after";
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => error === failure);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
  mode = "normal"; await removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId);
  assert.equal(calls, 2); assert.deepEqual(await fs.readdir(f.dataDir), ["config.json"]);
});

test("D16 keep 单链普通身份和每级目录祖先必需，拒硬链与祖先junction", async t => {
  const f = await removalFixture(t), hardLink = path.join(f.root, "identity-linked.json");
  await fs.link(f.file, hardLink);
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId));
  assert.deepEqual(await fs.readFile(f.file), f.bytes); await fs.unlink(hardLink);
  const junction = path.join(f.root, "linked-parent");
  await fs.symlink(f.dataDir, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(removeDesktopDeviceIdentity(junction, f.identity.deviceId));
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  await fs.unlink(junction);
  await fs.mkdir(path.join(f.dataDir, "nested"));
  await fs.symlink(f.dataDir, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(removeDesktopDeviceIdentity(path.join(junction, "nested"), f.identity.deviceId));
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

for (const phase of ["open", "read"] as const) test(`D16 keep ${phase}期间身份被替换拒绝删除，原件和第三身份均保留`, async t => {
  const f = await removalFixture(t), replacementDir = path.join(f.root, "replacement");
  await loadOrCreateDeviceIdentity(replacementDir);
  const replacement = await fs.readFile(path.join(replacementDir, "device-identity.json"));
  const open = fs.open, retained = path.join(f.dataDir, "identity-retained.json"); let replaced = false;
  /** 只在当前真实句柄的读取边界替换路径，不模拟签名解析结果。 */
  const replace = async (): Promise<void> => {
    await fs.rename(f.file, retained); await fs.writeFile(f.file, replacement); replaced = true;
  };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === f.file && phase === "open") await replace();
    const file = await open(...args);
    if (String(args[0]) !== f.file || phase !== "read") return file;
    return new Proxy(file, { get(target, field) {
      if (field === "readFile") return async () => { const bytes = await target.readFile(); await replace(); return bytes; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_FILE_CHANGED/u);
  assert.equal(replaced, true); assert.deepEqual(await fs.readFile(f.file), replacement); assert.deepEqual(await fs.readFile(retained), f.bytes);
});

test("D16 keep 缺失探测时数据目录被替换不删除新目录身份", async t => {
  const f = await removalFixture(t), replacementDir = path.join(f.root, "replacement");
  await loadOrCreateDeviceIdentity(replacementDir);
  const replacement = await fs.readFile(path.join(replacementDir, "device-identity.json"));
  const lstat = fs.lstat, retained = path.join(f.root, "retained-data"); let replaced = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.file && !replaced) {
      await fs.rename(f.dataDir, retained); await fs.mkdir(f.dataDir); await fs.writeFile(f.file, replacement); replaced = true;
      throw Object.assign(new Error("fixture observed absence during directory replacement"), { code: "ENOENT" });
    }
    return lstat(...args);
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_PATH_CHANGED/u);
  assert.equal(replaced, true); assert.deepEqual(await fs.readFile(f.file), replacement);
  assert.deepEqual(await fs.readFile(path.join(retained, "device-identity.json")), f.bytes);
});

for (const kind of ["driver", "null", "undefined"] as const) test(`D16 keep 读取与close双错保原始主副因${kind}，失败不删除身份`, async t => {
  const f = await removalFixture(t), open = fs.open;
  const primary = kind === "driver" ? Object.assign(new Error("fixture identity read failed"), { code: "EIO" }) : kind === "null" ? null : undefined;
  const cleanup = new Error("fixture identity close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) !== f.file) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "readFile") return async () => { throw primary; };
      if (field === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => error instanceof AggregateError
    && error.errors.length === 2 && error.errors[0] === primary && error.errors[1] === cleanup && error.cause === primary);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test("D16 keep 删除后close失败仍显式失败，关闭确认后同授权重试不重建身份", async t => {
  const f = await removalFixture(t), open = fs.open, cleanup = new Error("fixture close failed after unlink");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) !== f.file) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => error === cleanup);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
  await removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId);
  assert.deepEqual(await fs.readdir(f.dataDir), ["config.json"]);
});

test("D16 keep unlink未真正删除时明确失败，不能把调用返回当缺失事实", async t => {
  const f = await removalFixture(t), unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (!String(args[0]).startsWith(`${f.file}.removing-`)) await unlink(...args);
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_REMOVE_INCOMPLETE/u);
  const captured = (await fs.readdir(f.dataDir)).find(name => name.startsWith("device-identity.json.removing-"))!;
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, captured)), f.bytes);
});

test("D16 keep 首次探测缺失后出现第三身份不能伪造幂等完成", async t => {
  const f = await removalFixture(t), lstat = fs.lstat;
  const replacementDir = path.join(f.root, "replacement"); await loadOrCreateDeviceIdentity(replacementDir);
  const replacement = await fs.readFile(path.join(replacementDir, "device-identity.json"));
  await fs.unlink(f.file); let missingObserved = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.file && !missingObserved) {
      missingObserved = true; await fs.writeFile(f.file, replacement);
      throw Object.assign(new Error("fixture observed initial absence"), { code: "ENOENT" });
    }
    return lstat(...args);
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_FILE_CHANGED/u);
  assert.equal(missingObserved, true); assert.deepEqual(await fs.readFile(f.file), replacement);
});

test("D16 keep 最终路径检查后换入第三身份不得删除，捕获冲突保第三身份原字节", async t => {
  const f = await removalFixture(t), other = path.join(f.root, "other"); await loadOrCreateDeviceIdentity(other);
  const replacement = await fs.readFile(path.join(other, "device-identity.json")), retained = path.join(f.root, "old-retained.json");
  const lstat = fs.lstat; let observed = 0, replaced = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const entry = await lstat(...args);
    if (String(args[0]) === f.file && ++observed === 2) {
      await fs.rename(f.file, retained); await fs.writeFile(f.file, replacement); replaced = true;
    }
    return entry;
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_FILE_CHANGED/u);
  assert.equal(replaced, true); assert.deepEqual(await fs.readFile(retained), f.bytes);
  const identityFiles = (await fs.readdir(f.dataDir)).filter(name => name.startsWith("device-identity.json"));
  assert.equal(identityFiles.length, 1); assert.deepEqual(await fs.readFile(path.join(f.dataDir, identityFiles[0]!)), replacement);
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId));
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, identityFiles[0]!)), replacement);
});

for (const phase of ["before", "after"] as const) test(`D16 keep 捕获rename${phase}失败保原文件或唯一捕获，同授权可续删`, async t => {
  const f = await removalFixture(t), rename = fs.rename, failure = Object.assign(new Error("fixture capture rename failed"), { code: "EIO" });
  const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]) !== f.file || !String(args[1]).startsWith(`${f.file}.removing-`)) return rename(...args);
    if (phase === "after") await rename(...args);
    throw failure;
  });
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), error => error === failure);
  const files = (await fs.readdir(f.dataDir)).filter(name => name.startsWith("device-identity.json"));
  assert.equal(files.length, 1); assert.deepEqual(await fs.readFile(path.join(f.dataDir, files[0]!)), f.bytes);
  assert.equal(files[0] === "device-identity.json", phase === "before");
  fault.mock.restore(); await removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId);
  assert.deepEqual(await fs.readdir(f.dataDir), ["config.json"]);
});

for (const shape of ["unknown", "foreign-old", "multiple", "standard-present", "hard-link"] as const)
test(`D16 keep 拒绝${shape}捕获证据且不删除标准名或任何保留文件`, async t => {
  const f = await removalFixture(t);
  const prefix = `device-identity.json.removing-${f.identity.deviceId.toLowerCase()}-`;
  const first = `${prefix}${crypto.randomUUID()}.tmp`;
  if (shape !== "standard-present") await fs.unlink(f.file);
  if (shape === "unknown") await fs.writeFile(path.join(f.dataDir, "device-identity.json.unknown.tmp"), f.bytes);
  else if (shape === "foreign-old") await fs.writeFile(path.join(f.dataDir, `device-identity.json.removing-${crypto.randomUUID()}-${crypto.randomUUID()}.tmp`), f.bytes);
  else {
    await fs.writeFile(path.join(f.dataDir, first), f.bytes);
    if (shape === "multiple") await fs.writeFile(path.join(f.dataDir, `${prefix}${crypto.randomUUID()}.tmp`), f.bytes);
    if (shape === "hard-link") await fs.link(path.join(f.dataDir, first), path.join(f.root, "linked-capture"));
  }
  const names = await fs.readdir(f.dataDir), before = await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, name))));
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId));
  assert.deepEqual(await fs.readdir(f.dataDir), names);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, name)))), before);
});

for (const shape of ["unknown", "capture", "standard-present"] as const)
test(`D16 keep 拒绝大小写别名${shape}身份残留并保留原字节`, async t => {
  const f = await removalFixture(t);
  const name = shape === "capture"
    ? `DEVICE-IDENTITY.JSON.removing-${f.identity.deviceId.toLowerCase()}-${crypto.randomUUID()}.tmp`
    : "DEVICE-IDENTITY.JSON.unknown.tmp";
  if (shape !== "standard-present") await fs.unlink(f.file);
  const retained = path.join(f.dataDir, name); await fs.writeFile(retained, f.bytes);
  await assert.rejects(removeDesktopDeviceIdentity(f.dataDir, f.identity.deviceId), /DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT/u);
  assert.deepEqual(await fs.readFile(retained), f.bytes);
  if (shape === "standard-present") assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test("D16 未知大写身份残留阻断普通身份创建", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d16-uppercase-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const retained = path.join(root, "DEVICE-IDENTITY.JSON.unknown.tmp"); await fs.writeFile(retained, "unknown fixture");
  await assert.rejects(loadOrCreateDeviceIdentity(root), /DESKTOP_DEVICE_IDENTITY_MISSING/u);
  assert.equal(await fs.readFile(retained, "utf8"), "unknown fixture");
  await assert.rejects(fs.lstat(path.join(root, "device-identity.json")), { code: "ENOENT" });
});

test("read-only installation identity neither creates nor upgrades signing material", async (t) => {
  const api = await import("../src/deviceIdentity.js") as any;
  assert.equal(typeof api.readDeviceIdentity, "function", "proof signing needs a read-only installation entry");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-read-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(api.readDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/);
  assert.deepEqual(await fs.readdir(directory), []);
  const file = path.join(directory, "device-identity.json");
  const old = JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: "2026-10-24T00:00:00.000Z" });
  await fs.writeFile(file, old, "utf8");
  await assert.rejects(api.readDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/);
  assert.equal(await fs.readFile(file, "utf8"), old);
  const identity = await loadOrCreateDeviceIdentity(directory), before = await fs.readFile(file);
  assert.deepEqual(await api.readDeviceIdentity(directory), identity);
  assert.deepEqual(await fs.readFile(file), before);
});

test("creates once and reloads the same local device identity", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  try {
    const first = await loadOrCreateDeviceIdentity(tempDir);
    const second = await loadOrCreateDeviceIdentity(tempDir);
    assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.createdAt, first.createdAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects a malformed existing identity instead of silently replacing it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  try {
    await fs.writeFile(path.join(tempDir, "device-identity.json"), "{}", "utf8");
    await assert.rejects(() => loadOrCreateDeviceIdentity(tempDir), /设备身份文件无效/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("persists signing identity without exposing the private key and verifies exact payload bytes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(directory);
  const payload = Buffer.from("desktop-update-register\nrequest-1");
  const signed = await signDevicePayload(directory, payload);
  assert.equal(signed.deviceId, identity.deviceId);
  assert.equal("privateKey" in identity, false);
  assert.equal("privateKeyBase64" in identity, false);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(signed.publicKeyBase64, "base64"), format: "der", type: "spki" });
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  assert.equal(crypto.verify(null, payload, publicKey, Buffer.from(signed.signature, "base64")), true);
  assert.equal(crypto.verify(null, Buffer.from("different request"), publicKey, Buffer.from(signed.signature, "base64")), false);
  assert.deepEqual(await loadOrCreateDeviceIdentity(directory), identity);
});

test("upgrades the pre-signing format once while preserving installation identity", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = { deviceId: crypto.randomUUID(), createdAt: "2026-10-24T00:00:00.000Z" };
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify(original), "utf8");
  const upgraded = await loadOrCreateDeviceIdentity(directory);
  assert.equal(upgraded.deviceId, original.deviceId);
  assert.equal(upgraded.createdAt, original.createdAt);
  assert.ok(upgraded.publicKeyBase64);
  assert.deepEqual(await loadOrCreateDeviceIdentity(directory), upgraded);
});

test("existing installation evidence without identity cannot silently become a new device", async (t) => {
  for (const artifact of ["codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "active-release.json", "errors.jsonl"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, artifact), "retained evidence", "utf8");
    await assert.rejects(() => loadOrCreateDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/);
    await assert.rejects(() => fs.access(path.join(directory, "device-identity.json")), { code: "ENOENT" });
  }
});

// 回执正文不参与身份恢复；任何保留日志都必须阻止普通启动更换身份。
for (const state of ["pending", "acknowledged", "empty", "invalid"] as const) {
  test(`retained ${state} update receipt journal requires the original installation identity`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-receipt-identity-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const identity = await loadOrCreateDeviceIdentity(directory);
    const identityFile = path.join(directory, "device-identity.json"), journalFile = path.join(directory, "update-receipts.jsonl");
    if (state === "pending" || state === "acknowledged") {
      const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(),
        releaseId: "receipt-identity-test", archiveSha256: "a".repeat(64), stage: "received", at: "2026-11-03T00:00:00.000Z",
        errorCode: null, errorId: null });
      const journal = createUpdateReceiptJournal(directory);
      await journal.record(receipt);
      if (state === "acknowledged") await journal.acknowledge(toDesktopUpdateReceiptAck(receipt));
    } else await fs.writeFile(journalFile, state === "empty" ? "" : "retained invalid receipt\n", "utf8");
    const identityBefore = await fs.readFile(identityFile), journalBefore = await fs.readFile(journalFile);
    assert.deepEqual(await loadOrCreateDeviceIdentity(directory), identity);
    assert.deepEqual(await fs.readFile(identityFile), identityBefore);
    assert.deepEqual(await fs.readFile(journalFile), journalBefore);
    await fs.unlink(identityFile);
    await assert.rejects(loadOrCreateDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/u);
    assert.deepEqual(await fs.readdir(directory), ["update-receipts.jsonl"]);
    assert.deepEqual(await fs.readFile(journalFile), journalBefore);
  });
}

// Windows 文件系统可将大小写变体解析到规范日志路径，不能据名称差异认定首次安装。
for (const journalName of ["UPDATE-RECEIPTS.JSONL", "Update-Receipts.Jsonl"]) {
  test(`retained ${journalName} also blocks creating another installation identity`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-receipt-case-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const journalFile = path.join(directory, journalName), before = Buffer.from("retained receipt evidence\n");
    await fs.writeFile(journalFile, before);
    if (process.platform === "win32") await fs.access(path.join(directory, "update-receipts.jsonl"));
    await assert.rejects(loadOrCreateDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/u);
    assert.deepEqual(await fs.readdir(directory), [journalName]);
    assert.deepEqual(await fs.readFile(journalFile), before);
  });
}

test("signing never creates identity and malformed signing keys remain unchanged", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => signDevicePayload(directory, Buffer.from("request")), /DESKTOP_DEVICE_IDENTITY_MISSING/);
  await loadOrCreateDeviceIdentity(directory);
  const file = path.join(directory, "device-identity.json");
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const invalid of [{ ...original, privateKeyBase64: "broken" }, { ...original, publicKeyBase64: "broken" },
    { ...original, schemaVersion: 2 }, { ...original, privateKeyBase64: undefined }]) {
    const bytes = JSON.stringify(invalid);
    await fs.writeFile(file, bytes, "utf8");
    await assert.rejects(() => loadOrCreateDeviceIdentity(directory), /设备身份文件无效/);
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
});

test("invalid identity JSON cannot leak private fragments through its error cause", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = "private_secret_fragment";
  await fs.writeFile(path.join(directory, "device-identity.json"), `{"privateKeyBase64":${secret}}`, "utf8");
  await assert.rejects(() => loadOrCreateDeviceIdentity(directory), (error: Error) => {
    assert.match(error.message, /设备身份文件无效/);
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) assert.ok(!cause.message.includes("private_se"));
    return true;
  });
});

test("authorized reinstall uses its fixed next identity while ordinary retained-data startup stays blocked", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-reinstall-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ["config.json", "codeflowai.db", "codeflowai.db.meta.json", "update-receipts.jsonl"]) await fs.writeFile(path.join(directory, name), "retained");
  const next = { deviceId: "16e38f2a-0640-49b0-a871-a897e5fcae81", createdAt: "2026-10-31T00:00:00.000Z" };
  await assert.rejects(loadOrCreateDeviceIdentity(directory), /DESKTOP_DEVICE_IDENTITY_MISSING/u);
  const identity = await loadOrCreateDeviceIdentity(directory, next);
  assert.equal(identity.deviceId, next.deviceId); assert.equal(identity.createdAt, next.createdAt);
  const bytes = await fs.readFile(path.join(directory, "device-identity.json"));
  assert.deepEqual(await loadOrCreateDeviceIdentity(directory, next), identity);
  assert.deepEqual(await fs.readFile(path.join(directory, "device-identity.json")), bytes);
  await assert.rejects(loadOrCreateDeviceIdentity(directory, { ...next, deviceId: crypto.randomUUID() }), /DESKTOP_REINSTALL_IDENTITY_CONFLICT/u);
  assert.deepEqual(await fs.readFile(path.join(directory, "device-identity.json")), bytes);
  assert.equal(await fs.readFile(path.join(directory, "update-receipts.jsonl"), "utf8"), "retained");
});

test("reinstall rejects an empty target and malformed or accessor next identity before writing", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-reinstall-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const next = { deviceId: "16e38f2a-0640-49b0-a871-a897e5fcae81", createdAt: "2026-10-31T00:00:00.000Z" };
  await assert.rejects(loadOrCreateDeviceIdentity(directory, next), /DESKTOP_REINSTALL_STORAGE_MISSING/u);
  await assert.rejects(loadOrCreateDeviceIdentity(directory, { ...next, deviceId: "invalid" }), /DESKTOP_REINSTALL_IDENTITY_INVALID/u);
  let reads = 0;
  const invalid = Object.defineProperty({ ...next }, "deviceId", { get() { reads++; throw new Error("ACCESSOR_CALLED"); } });
  await assert.rejects(loadOrCreateDeviceIdentity(directory, invalid), /DESKTOP_REINSTALL_IDENTITY_INVALID/u);
  assert.equal(reads, 0); assert.deepEqual(await fs.readdir(directory), []);
});

test("identity write failure preserves its original cause when close also fails", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-reinstall-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const open = fs.open, primary = new Error("fixture write failed"), cleanup = new Error("fixture close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (!String(args[0]).includes("device-identity.json.")) return file;
    return new Proxy(file, { get(target, field) {
      if (field === "writeFile") return async () => { throw primary; };
      if (field === "close") return async () => { await target.close(); throw cleanup; };
      const value = Reflect.get(target, field, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(loadOrCreateDeviceIdentity(directory), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
  assert.deepEqual(await fs.readdir(directory), []);
});
