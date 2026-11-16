import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeAssetFiles } from "../src/knowledge/knowledgeAssetFiles.js";
import { logger } from "../src/logger.js";

/** 故障仅限本例原子写临时文件；所有 fd 和目录在退出前释放。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "knowledge-write-cleanup-"));
  const relative = "docs/current.json", target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, "original", "utf8");
  const files = new KnowledgeAssetFiles(root);
  const opened: Array<{ fd: number; path: string }> = [];
  const unclosed = new Set<number>();
  const errors: Record<string, unknown>[] = [];
  const open = fs.openSync, close = fs.closeSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]).startsWith(`${target}.`) && String(args[0]).endsWith(".tmp")) {
      opened.push({ fd, path: String(args[0]) });
      unclosed.add(fd);
    }
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); unclosed.delete(fd); });
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  t.after(() => {
    t.mock.restoreAll();
    for (const fd of unclosed) close(fd);
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("knowledge-write-cleanup-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, relative, target, files, opened, unclosed, errors };
}

/** 清理错误不伪造成功，日志只保系统字段而不带正文及私有异常文案。 */
function cleanupFailure(error: unknown, operation: unknown, cleanup: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: string }).code, "KNOWLEDGE_ASSET_WRITE_CLEANUP_FAILED");
  assert.match(error.message, /requestId=knowledge-write:/);
  if (operation !== undefined) {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operation, cleanup]);
    assert.equal(error.cause, operation);
  } else assert.equal(error.cause, cleanup);
  return true;
}

for (const stage of ["write", "fsync"] as const) {
  test(`${stage} failure removes the partial temporary file and leaves original bytes available for retry`, t => {
    const f = fixture(t), original = fs.writeFileSync;
    const primary = Object.assign(new Error("private-write-failure"), { code: "ENOSPC" });
    const mock = stage === "write" ? t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && f.unclosed.has(args[0])) {
        original(args[0], "partial");
        throw primary;
      }
      return original(...args);
    }) : t.mock.method(fs, "fsyncSync", () => { throw primary; });
    assert.throws(() => f.files.write(f.relative, "new-body"), error => error === primary);
    assert.equal(fs.readFileSync(f.target, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["current.json"]);
    assert.equal(f.unclosed.size, 0);
    mock.mock.restore();
    f.files.write(f.relative, "retry-body");
    assert.equal(fs.readFileSync(f.target, "utf8"), "retry-body");
    assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["current.json"]);
    assert.equal(f.errors.length, 0, "普通 I/O 原错沿既有业务边界记录");
  });
}

for (const stage of ["write", "fsync", "rename"] as const) {
  test(`${stage} and unlink failures retain both causes and the temporary recovery file`, t => {
    const f = fixture(t), write = fs.writeFileSync;
    const primary = Object.assign(new Error("private-original-failure"), { code: "EIO", syscall: stage });
    const cleanup = Object.assign(new Error("private-cleanup-failure"), { code: "EACCES", syscall: "unlink" });
    if (stage === "write") t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && f.unclosed.has(args[0])) { write(args[0], "partial"); throw primary; }
      return write(...args);
    });
    if (stage === "fsync") t.mock.method(fs, "fsyncSync", () => { throw primary; });
    if (stage === "rename") t.mock.method(fs, "renameSync", () => { throw primary; });
    const unlink = fs.unlinkSync;
    t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
      if (f.opened.some(entry => entry.path === String(target))) throw cleanup;
      return unlink(target);
    });
    assert.throws(() => f.files.write(f.relative, "private-new-body"), error => cleanupFailure(error, primary, cleanup));
    assert.equal(fs.readFileSync(f.target, "utf8"), "original");
    assert.equal(f.unclosed.size, 0);
    assert.equal(fs.existsSync(f.opened[0].path), true);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].errorCode, "KNOWLEDGE_ASSET_WRITE_CLEANUP_FAILED");
    assert.equal(f.errors[0].workspacePath, f.root);
    assert.equal(f.errors[0].relativePath, f.relative);
    assert.equal(f.errors[0].temporaryPath, f.opened[0].path);
    assert.deepEqual(f.errors[0].event, { category: "knowledge", action: "write_cleanup", outcome: "fail" });
    assert.deepEqual(f.errors[0].operationCause, { name: "Error", code: "EIO", syscall: stage });
    assert.deepEqual(f.errors[0].cleanupCause, { name: "Error", code: "EACCES", syscall: "unlink" });
    assert.doesNotMatch(JSON.stringify(f.errors), /private-original|private-cleanup|private-new-body/);
  });
}

for (const writeFails of [false, true]) {
  test(`close failure preserves temporary bytes and does not rename or unlink (writeFails=${writeFails})`, t => {
    const f = fixture(t), write = fs.writeFileSync;
    const primary = Object.assign(new Error("write failure"), { code: "EIO" });
    const cleanup = Object.assign(new Error("close failure"), { code: "EBADF", syscall: "close" });
    if (writeFails) t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number" && f.unclosed.has(args[0])) { write(args[0], "partial"); throw primary; }
      return write(...args);
    });
    const close = fs.closeSync;
    t.mock.method(fs, "closeSync", (fd: number) => {
      if (f.unclosed.has(fd)) throw cleanup;
      return close(fd);
    });
    const rename = t.mock.method(fs, "renameSync");
    const unlink = t.mock.method(fs, "unlinkSync");
    assert.throws(() => f.files.write(f.relative, "new-body"), error => cleanupFailure(error, writeFails ? primary : undefined, cleanup));
    assert.equal(fs.readFileSync(f.target, "utf8"), "original");
    assert.equal(fs.existsSync(f.opened[0].path), true);
    assert.equal(rename.mock.callCount(), 0);
    assert.equal(unlink.mock.callCount(), 0);
    assert.equal(f.errors.length, 1);
  });
}

test("normal atomic replacement publishes exact UTF-8 bytes and leaves no temporary file", t => {
  const f = fixture(t);
  f.files.write(f.relative, "正文\n第二行\n");
  assert.equal(fs.readFileSync(f.target, "utf8"), "正文\n第二行\n");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["current.json"]);
  assert.equal(f.unclosed.size, 0);
  assert.equal(f.errors.length, 0);
});

test("rename failure preserves original error after removing its own closed temporary file", t => {
  const f = fixture(t), primary = Object.assign(new Error("rename failed"), { code: "EACCES" });
  t.mock.method(fs, "renameSync", () => { throw primary; });
  assert.throws(() => f.files.write(f.relative, "new-body"), error => error === primary);
  assert.equal(fs.readFileSync(f.target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["current.json"]);
});

for (const operationFails of [false, true]) {
  test(`temporary file replacement is never published or deleted (operationFails=${operationFails})`, t => {
    const f = fixture(t), fsync = fs.fsyncSync;
    const primary = Object.assign(new Error("fsync failed after replacement"), { code: "EIO" });
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      fsync(fd);
      const temporary = f.opened[0].path;
      fs.renameSync(temporary, `${temporary}.saved`);
      fs.writeFileSync(temporary, "replacement");
      if (operationFails) throw primary;
    });
    assert.throws(() => f.files.write(f.relative, "new-body"));
    assert.equal(fs.readFileSync(f.target, "utf8"), "original");
    assert.equal(fs.readFileSync(f.opened[0].path, "utf8"), "replacement");
    assert.equal(fs.readFileSync(`${f.opened[0].path}.saved`, "utf8"), "new-body");
    assert.equal(f.unclosed.size, 0);
    assert.equal(f.errors.length, 1);
  });
}

test("parent directory replacement stops cleanup and leaves outside files untouched", t => {
  const f = fixture(t), rename = fs.renameSync;
  const outside = path.join(f.root, "outside"), saved = path.join(f.root, "saved");
  fs.mkdirSync(outside);
  let externalTemporary = "";
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (!f.opened.some(entry => entry.path === String(source))) return rename(source, target);
    rename(path.dirname(f.target), saved);
    externalTemporary = path.join(outside, path.basename(f.opened[0].path));
    fs.writeFileSync(externalTemporary, "outside-preserved");
    fs.symlinkSync(outside, path.dirname(f.target), process.platform === "win32" ? "junction" : "dir");
    throw Object.assign(new Error("rename failure"), { code: "EIO" });
  });
  assert.throws(() => f.files.write(f.relative, "new-body"));
  assert.equal(fs.readFileSync(externalTemporary, "utf8"), "outside-preserved");
  assert.equal(fs.readFileSync(path.join(saved, "current.json"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(saved, path.basename(f.opened[0].path)), "utf8"), "new-body");
  assert.equal(f.unclosed.size, 0);
});
