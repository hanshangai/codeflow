import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncateClaudeSessionToByteLen } from "../src/engines/claude/claudeSessionStore.js";
import { logger } from "../src/logger.js";

/** 使用真实 JSONL、备份和索引，读取故障只作用于本次存档 fd。 */
async function fixture(t: TestContext, content: string) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-boundary-read-"));
  t.after(async () => { t.mock.restoreAll(); await fsp.rm(root, { recursive: true, force: true }); });
  t.mock.method(os, "homedir", () => root);
  t.mock.method(logger, "error", () => {});
  const workspace = path.join(root, "workspace"), project = path.join(root, ".claude", "projects", "fixture");
  await fsp.mkdir(project, { recursive: true });
  const sessionFile = path.join(project, "session.jsonl"), indexFile = path.join(project, "sessions-index.json");
  const index = JSON.stringify({ originalPath: workspace, entries: [{ sessionId: "session", messageCount: 3 }] });
  await fsp.writeFile(sessionFile, content, "utf8");
  await fsp.writeFile(indexFile, index, "utf8");
  return {
    project, sessionFile, indexFile, index,
    truncate: (byteLen: number) => truncateClaudeSessionToByteLen({ workspacePath: workspace, sessionId: "session", byteLen }),
  };
}

const firstLine = JSON.stringify({ type: "user", isSidechain: false, text: "保留这一条" }) + "\n";
const longLine = JSON.stringify({ type: "assistant", isSidechain: false, text: "长消息".repeat(30_000) }) + "\n";

test("a checkpoint inside a multi-window message preserves the preceding complete JSONL record", async t => {
  const content = firstLine + longLine;
  const f = await fixture(t, content);
  const result = await f.truncate(Buffer.byteLength(firstLine) + 150_000);
  assert.equal(result.ok, true);
  assert.equal(result.truncatedToByteLen, Buffer.byteLength(firstLine));
  assert.equal(result.messageCount, 1);
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), firstLine);
  assert.equal(await fsp.readFile(result.backupPath, "utf8"), content);
});

test("short native reads are filled before selecting a JSONL boundary", async t => {
  const content = firstLine + longLine, f = await fixture(t, content);
  const open = fs.openSync, read = fs.readSync;
  let ownedFd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]) === f.sessionFile) ownedFd = fd;
    return fd;
  });
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    if (fd !== ownedFd) return read(fd, buffer, offset, length, position);
    buffer.fill(120, offset, offset + length);
    return read(fd, buffer, offset, Math.min(length, 7), position);
  });
  const result = await f.truncate(Buffer.byteLength(firstLine) + 12);
  assert.equal(result.ok, true);
  assert.equal(result.truncatedToByteLen, Buffer.byteLength(firstLine));
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), firstLine);
  assert.equal(await fsp.readFile(result.backupPath, "utf8"), content);
});

test("unexpected EOF during boundary read rejects before truncation and preserves the backup", async t => {
  const content = firstLine + longLine, f = await fixture(t, content), open = fs.openSync, read = fs.readSync;
  let ownedFd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]) === f.sessionFile) ownedFd = fd;
    return fd;
  });
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    if (fd !== ownedFd) return read(fd, buffer, offset, length, position);
    buffer.fill(120, offset, offset + length);
    return 0;
  });
  await assert.rejects(f.truncate(Buffer.byteLength(firstLine) + 12), { code: "CLAUDE_SESSION_BOUNDARY_INCOMPLETE_READ" });
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), content);
  assert.equal(await fsp.readFile(f.indexFile, "utf8"), f.index);
  const backups = (await fsp.readdir(f.project)).filter(name => name.startsWith("session.jsonl.bak."));
  assert.equal(backups.length, 1);
  assert.equal(await fsp.readFile(path.join(f.project, backups[0]!), "utf8"), content);
  assert.throws(() => fs.fstatSync(ownedFd!), { code: "EBADF" });
});

test("a first message spanning several windows has no earlier complete record to preserve", async t => {
  const f = await fixture(t, longLine);
  const result = await f.truncate(150_000);
  assert.equal(result.ok, true);
  assert.equal(result.truncatedToByteLen, 0);
  assert.equal(await fsp.readFile(f.sessionFile, "utf8"), "");
  assert.equal(await fsp.readFile(result.backupPath, "utf8"), longLine);
});
