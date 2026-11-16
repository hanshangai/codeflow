import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncateClaudeSessionToByteLen } from "../src/engines/claude/claudeSessionStore.js";
import { logger } from "../src/logger.js";

/** 所有 provider 历史与索引放在独占 Temp，实际执行备份及裁剪入口。 */
async function fixture(t: TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-boundary-failure-"));
  t.after(async () => { t.mock.restoreAll(); await fsp.rm(root, { recursive: true, force: true }); });
  const logs: Record<string, unknown>[] = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: unknown) => { logs.push(data as Record<string, unknown>); });
  t.mock.method(os, "homedir", () => root);
  const workspace = path.join(root, "workspace"), project = path.join(root, ".claude", "projects", "test-project");
  await fsp.mkdir(project, { recursive: true });
  const sessionFile = path.join(project, "session.jsonl"), indexFile = path.join(project, "sessions-index.json");
  const firstTurn = JSON.stringify({ type: "user", isSidechain: false, uuid: "u1", text: "第一轮" }) + "\n"
    + JSON.stringify({ type: "assistant", isSidechain: false, parentUuid: "u1", text: "回复" }) + "\n";
  const original = firstTurn + JSON.stringify({ type: "user", isSidechain: false, uuid: "u2", text: "第二轮" }) + "\n";
  const index = JSON.stringify({ originalPath: workspace, entries: [{ sessionId: "session", messageCount: 3 }] });
  await fsp.writeFile(sessionFile, original, "utf8");
  await fsp.writeFile(indexFile, index, "utf8");
  return {
    project, sessionFile, indexFile, original, index, firstTurn, workspace, logs,
    truncate: (byteLen = Buffer.byteLength(firstTurn) + 5) => truncateClaudeSessionToByteLen({ workspacePath: workspace, sessionId: "session", byteLen }),
  };
}

/** 验证失败发生在裁剪前，备份和原历史/索引均保留且无后续写副作用。 */
async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>, truncateCalls: number) {
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), f.original);
  assert.equal(await fsp.readFile(f.indexFile, "utf8"), f.index);
  assert.equal(truncateCalls, 0);
  const backups = (await fsp.readdir(f.project)).filter(name => name.startsWith("session.jsonl.bak."));
  assert.equal(backups.length, 1);
  assert.equal(await fsp.readFile(path.join(f.project, backups[0]!), "utf8"), f.original);
}

for (const stage of ["stat", "open", "read", "close"] as const) {
  test(`checkpoint ${stage} failure cannot turn an existing session into an empty successful rollback`, async t => {
    const f = await fixture(t);
    const failure = Object.freeze(Object.assign(new Error(`${stage} denied`), { code: "EACCES" }));
    const stat = fs.statSync, open = fs.openSync, read = fs.readSync, close = fs.closeSync, truncate = fs.truncateSync;
    let ownedFd: number | undefined, truncateCalls = 0;
    t.mock.method(fs, "truncateSync", (...args: Parameters<typeof fs.truncateSync>) => { truncateCalls += 1; return truncate(...args); });
    t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      if (stage === "stat" && String(args[0]) === f.sessionFile) throw failure;
      return stat(...args);
    });
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === f.sessionFile) {
        if (stage === "open") throw failure;
        ownedFd = open(...args);
        return ownedFd;
      }
      return open(...args);
    });
    t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
      if (stage === "read" && args[0] === ownedFd) throw failure;
      return read(...args);
    });
    t.mock.method(fs, "closeSync", (fd: number) => {
      close(fd);
      if (stage === "close" && fd === ownedFd) throw failure;
    });
    await assert.rejects(f.truncate(), error => error === failure);
    await assertPreserved(f, truncateCalls);
    if (ownedFd !== undefined) assert.throws(() => fs.fstatSync(ownedFd!), { code: "EBADF" });
  });
}

test("read and close failures retain both causes and stop before truncation", async t => {
  const f = await fixture(t);
  const readError = Object.assign(new Error("read failed"), { code: "EIO", syscall: "read" });
  const closeError = Object.assign(new Error("close failed"), { code: "EBADF", syscall: "close" });
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, truncate = fs.truncateSync;
  let ownedFd: number | undefined, truncateCalls = 0;
  t.mock.method(fs, "truncateSync", (...args: Parameters<typeof fs.truncateSync>) => { truncateCalls += 1; return truncate(...args); });
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]) === f.sessionFile) ownedFd = fd;
    return fd;
  });
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    if (args[0] === ownedFd) throw readError;
    return read(...args);
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    close(fd);
    if (fd === ownedFd) throw closeError;
  });
  await assert.rejects(f.truncate(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], readError);
    assert.equal(error.errors[1], closeError);
    assert.equal(error.cause, readError);
    return true;
  });
  await assertPreserved(f, truncateCalls);
  assert.throws(() => fs.fstatSync(ownedFd!), { code: "EBADF" });
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0]!.rootCause, { kind: "Error", errors: [
    { kind: "Error", code: "EIO", syscall: "read" }, { kind: "Error", code: "EBADF", syscall: "close" },
  ] });
});

test("a valid checkpoint still truncates at the previous JSONL boundary and updates its message count", async t => {
  const f = await fixture(t);
  const result = await f.truncate();
  assert.equal(result.ok, true);
  assert.equal(result.truncatedToByteLen, Buffer.byteLength(f.firstTurn));
  assert.equal(result.messageCount, 2);
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), f.firstTurn);
  assert.equal(await fsp.readFile(result.backupPath, "utf8"), f.original);
  assert.equal(JSON.parse(await fsp.readFile(f.indexFile, "utf8")).entries[0].messageCount, 2);
});

test("an explicitly requested zero checkpoint remains a valid rollback", async t => {
  const f = await fixture(t);
  const result = await f.truncate(0);
  assert.equal(result.ok, true);
  assert.equal(result.truncatedToByteLen, 0);
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), "");
  assert.equal(await fsp.readFile(result.backupPath, "utf8"), f.original);
});

test("boundary failure logs traceable session and backup context without private error messages", async t => {
  const f = await fixture(t), failure = Object.freeze(Object.assign(new Error("private-session-cause"), { code: "EIO", syscall: "stat" }));
  const stat = fs.statSync;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]) === f.sessionFile) throw failure;
    return stat(...args);
  });
  await assert.rejects(f.truncate(), error => error === failure);
  assert.equal(f.logs.length, 1);
  const log = f.logs[0]!;
  assert.equal(log.code, "CLAUDE_SESSION_BOUNDARY_READ_FAILED");
  assert.match(String(log.requestId), /^claude-rollback-boundary:/);
  assert.equal(log.sessionId, "session");
  assert.equal(log.workspacePath, f.workspace);
  assert.equal(log.sessionFile, f.sessionFile);
  assert.equal(log.requestedByteLen, Buffer.byteLength(f.firstTurn) + 5);
  assert.equal(log.providerMutationStarted, false);
  assert.equal(await fsp.readFile(String(log.backupPath), "utf8"), f.original);
  assert.deepEqual(log.event, { category: "engine", action: "session_boundary_read", outcome: "fail" });
  assert.equal((log.rootCause as Record<string, unknown>).code, "EIO");
  assert.doesNotMatch(JSON.stringify(log), /private-session-cause|第一轮|第二轮/);
});

test("boundary logging failure preserves the original error and stops without touching session history", async t => {
  const f = await fixture(t), primary = Object.freeze(new Error("read failed")), loggingError = new Error("log failed");
  const stat = fs.statSync;
  let truncateCalls = 0;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]) === f.sessionFile) throw primary;
    return stat(...args);
  });
  t.mock.method(fs, "truncateSync", () => { truncateCalls += 1; throw new Error("must not truncate"); });
  t.mock.method(logger, "error", () => { throw loggingError; });
  await assert.rejects(f.truncate(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1], loggingError);
    assert.equal(error.cause, primary);
    return true;
  });
  await assertPreserved(f, truncateCalls);
});
