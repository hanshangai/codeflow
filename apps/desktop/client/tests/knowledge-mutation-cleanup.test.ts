import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeAssetFiles } from "../src/knowledge/knowledgeAssetFiles.js";
import { logger } from "../src/logger.js";

const LOCK_RELATIVE = ".codeflowai/knowledge-cache/execution/write.lock";

/** 锁与业务文件仅落本例独占Temp，退出恢复注入后释放可能未确认的fd。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "knowledge-mutation-cleanup-"));
  const lock = path.join(root, LOCK_RELATIVE), business = path.join(root, "business.txt");
  const files = new KnowledgeAssetFiles(root), opened = new Set<number>();
  const errors: Record<string, unknown>[] = [];
  const open = fs.openSync, close = fs.closeSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]) === lock) opened.add(fd);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); opened.delete(fd); });
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  t.after(() => {
    t.mock.restoreAll();
    for (const fd of opened) close(fd);
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("knowledge-mutation-cleanup-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, lock, business, files, opened, errors };
}

/** 单一清理失败仍失败；双错必须按顺序保留原始业务和资源错误。 */
function cleanupFailure(error: unknown, primary: unknown, cleanup: unknown, failed = true): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: string }).code, "KNOWLEDGE_ASSET_LOCK_CLEANUP_FAILED");
  assert.match(error.message, /requestId=knowledge-lock:/);
  if (failed) {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.equal(error.cause, primary);
  } else assert.equal(error.cause, cleanup);
  return true;
}

for (const stage of ["write", "action"] as const) {
  for (const cleanup of ["close", "unlink"] as const) {
    test(`${stage} failure and ${cleanup} failure preserve both causes and stop further cleanup`, t => {
      const f = fixture(t), write = fs.writeFileSync, close = fs.closeSync, unlink = fs.unlinkSync;
      const primary = Object.assign(new Error("private-operation-error"), { code: "EIO", syscall: stage });
      const secondary = Object.assign(new Error("private-cleanup-error"), { code: "EACCES", syscall: cleanup });
      if (stage === "write") t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "number" && f.opened.has(args[0])) throw primary;
        return write(...args);
      });
      if (cleanup === "close") t.mock.method(fs, "closeSync", (fd: number) => {
        if (f.opened.has(fd)) throw secondary;
        return close(fd);
      });
      const removals: string[] = [];
      t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
        if (String(target) === f.lock) { removals.push(String(target)); if (cleanup === "unlink") throw secondary; }
        return unlink(target);
      });
      let called = false;
      assert.throws(() => f.files.mutate(() => { called = true; throw primary; }), error => cleanupFailure(error, primary, secondary));
      assert.equal(called, stage === "action");
      assert.equal(fs.existsSync(f.lock), true);
      assert.equal(removals.length, cleanup === "close" ? 0 : 1);
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0].errorCode, "KNOWLEDGE_ASSET_LOCK_CLEANUP_FAILED");
      assert.equal(f.errors[0].workspacePath, f.root);
      assert.equal(f.errors[0].relativePath, LOCK_RELATIVE);
      assert.equal(f.errors[0].lockPath, f.lock);
      assert.deepEqual(f.errors[0].event, { category: "knowledge", action: "lock_cleanup", outcome: "fail" });
      assert.deepEqual(f.errors[0].operationCause, { name: "Error", code: "EIO", syscall: stage });
      assert.deepEqual(f.errors[0].cleanupCause, { name: "Error", code: "EACCES", syscall: cleanup });
      assert.doesNotMatch(JSON.stringify(f.errors), /private-operation-error|private-cleanup-error/);
    });
  }
}

for (const cleanup of ["close", "unlink"] as const) {
  test(`successful business action cannot report success when ${cleanup} fails`, t => {
    const f = fixture(t), close = fs.closeSync, unlink = fs.unlinkSync;
    const secondary = Object.assign(new Error("resource release failed"), { code: "EACCES", syscall: cleanup });
    if (cleanup === "close") t.mock.method(fs, "closeSync", (fd: number) => {
      if (f.opened.has(fd)) throw secondary;
      return close(fd);
    });
    if (cleanup === "unlink") t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
      if (String(target) === f.lock) throw secondary;
      return unlink(target);
    });
    assert.throws(() => f.files.mutate(() => { fs.appendFileSync(f.business, "once"); return "done"; }), error => cleanupFailure(error, undefined, secondary, false));
    assert.equal(fs.readFileSync(f.business, "utf8"), "once");
    assert.equal(fs.existsSync(f.lock), true);
    assert.equal(f.errors[0].businessActionStarted, true);
    assert.equal(f.errors[0].retryable, false);
  });
}

for (const fails of [false, true]) {
  test(`lock replacement after close is preserved rather than deleted (actionFails=${fails})`, t => {
    const f = fixture(t), close = fs.closeSync;
    t.mock.method(fs, "closeSync", (fd: number) => {
      const owned = f.opened.has(fd);
      close(fd);
      if (owned) { fs.renameSync(f.lock, `${f.lock}.saved`); fs.writeFileSync(f.lock, "replacement"); }
    });
    assert.throws(() => f.files.mutate(() => { if (fails) throw new Error("action failed"); return "done"; }));
    assert.equal(fs.readFileSync(f.lock, "utf8"), "replacement");
    assert.equal(JSON.parse(fs.readFileSync(`${f.lock}.saved`, "utf8")).pid, process.pid);
    assert.equal(f.errors.length, 1);
  });
}

test("parent junction replacement cannot delete an external namesake lock", t => {
  const f = fixture(t), close = fs.closeSync;
  const outside = path.join(f.root, "outside"), saved = path.join(f.root, "saved");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "write.lock"), "outside-preserved");
  t.mock.method(fs, "closeSync", (fd: number) => {
    const owned = f.opened.has(fd);
    close(fd);
    if (owned) {
      fs.renameSync(path.dirname(f.lock), saved);
      fs.symlinkSync(outside, path.dirname(f.lock), process.platform === "win32" ? "junction" : "dir");
    }
  });
  assert.throws(() => f.files.mutate(() => "done"));
  assert.equal(fs.readFileSync(path.join(outside, "write.lock"), "utf8"), "outside-preserved");
  assert.equal(JSON.parse(fs.readFileSync(path.join(saved, "write.lock"), "utf8")).pid, process.pid);
  assert.equal(f.errors.length, 1);
});

test("ordinary action failure releases its own lock, preserves the exact error and permits a fresh mutation", t => {
  const f = fixture(t), primary = new Error("business failed");
  assert.throws(() => f.files.mutate(() => { throw primary; }), error => error === primary);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.files.mutate(() => 42), 42);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.opened.size, 0);
  assert.equal(f.errors.length, 0);
});

test("throw undefined remains a failure while its lock is released", t => {
  const f = fixture(t);
  let thrown = false;
  try { f.files.mutate(() => { throw undefined; }); } catch (error) { thrown = true; assert.equal(error, undefined); }
  assert.equal(thrown, true);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(f.opened.size, 0);
});
