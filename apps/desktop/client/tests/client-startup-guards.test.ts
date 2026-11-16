import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../src/db/clientDb.ts";
import {
  acquireClientProcessLock,
  assertClientIdOverrideAllowed,
  buildClientProcessLockPath,
  ensureStableClientId,
  isClientProcessRunning,
  readBoundClientId,
  selectStartupWorkspaces,
} from "../src/startup/clientStartupGuards.ts";

test("当前 Client 的进程检查不启动外部命令", t => {
  const probe = t.mock.method(process, "kill", () => { throw new Error("当前进程不需要探测"); });
  const command = t.mock.method(childProcess, "execFileSync", () => { throw new Error("当前进程不需要查询"); });
  assert.equal(isClientProcessRunning(process.pid), true);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(command.mock.callCount(), 0);
});

test("Windows 权限探测受限时按完整进程列表核验，PID 复用不误认 Client", { skip: process.platform !== "win32" }, t => {
  const pid = 2_000_000_000;
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  let output = `"HPAudioAnalytics.exe","${pid}","Services","0","12 K"\n`;
  const command = t.mock.method(childProcess, "execFileSync", () => output);
  assert.equal(isClientProcessRunning(pid), false);
  output = `"${path.basename(process.execPath)}","${pid}","Console","1","12 K"\n`;
  assert.equal(isClientProcessRunning(pid), true, "权限不足但镜像仍是 Client 时必须保持占用");
  output = '"other.exe","1","Services","0","12 K"\n';
  assert.equal(isClientProcessRunning(pid), false, "有效列表中没有目标 PID 才确认已退出");
  assert.deepEqual(command.mock.calls[0]!.arguments.slice(0, 2), ["tasklist", ["/FO", "CSV", "/NH"]]);
});

test("Windows 进程列表异常或命令失败必须显式失败", { skip: process.platform !== "win32" }, t => {
  const pid = 2_000_000_000;
  t.mock.method(process, "kill", () => true);
  let output = "";
  let commandFailure: Error | null = null;
  t.mock.method(childProcess, "execFileSync", () => { if (commandFailure) throw commandFailure; return output; });
  assert.throws(() => isClientProcessRunning(pid), /返回空列表/);
  output = "tasklist access denied";
  assert.throws(() => isClientProcessRunning(pid), /返回无效 CSV/);
  output = `"${path.basename(process.execPath)}","${pid}","Console","1","12 K"\ninvalid row`;
  assert.throws(() => isClientProcessRunning(pid), /返回无效 CSV/);
  const failure = Object.assign(new Error("tasklist timeout"), { code: "ETIMEDOUT" });
  commandFailure = failure;
  assert.throws(() => isClientProcessRunning(pid), error => error === failure);
});

test("未知进程探测错误向上抛出，不伪造进程退出", t => {
  const failure = Object.assign(new Error("probe failed"), { code: "EIO" });
  t.mock.method(process, "kill", () => { throw failure; });
  assert.throws(() => isClientProcessRunning(2_000_000_000), error => error === failure);
});

test("startup workspace selection skips a missing root without dropping available workspaces", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-startup-workspaces-"));
  const availableWorkspaceId = "client-test:available" as WorkspaceId;
  const missingWorkspaceId = "client-test:missing" as WorkspaceId;
  const missingPath = path.join(tempDir, "missing");

  try {
    const selection = await selectStartupWorkspaces([
      { id: missingWorkspaceId, path: missingPath },
      { id: availableWorkspaceId, path: tempDir },
    ]);

    assert.deepEqual(Array.from(selection.workspaces.entries()), [[availableWorkspaceId, tempDir]]);
    assert.equal(selection.missingWorkspaces.length, 1);
    assert.equal(selection.missingWorkspaces[0]?.workspaceId, missingWorkspaceId);
    assert.equal(selection.missingWorkspaces[0]?.workspacePath, missingPath);
    assert.equal(selection.missingWorkspaces[0]?.cause.code, "ENOENT");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup workspace selection rethrows non-ENOENT filesystem errors", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-startup-workspace-file-"));
  const filePath = path.join(tempDir, "not-a-directory");
  try {
    fs.writeFileSync(filePath, "not a workspace", "utf8");
    await assert.rejects(
      () => selectStartupWorkspaces([{
        id: "client-test:invalid" as WorkspaceId,
        path: filePath,
      }]),
      (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOTDIR",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client process lock rejects a second writer for the same DB", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-lock-"));
  const dbPath = path.join(tempDir, "client.db");

  try {
    const lock = acquireClientProcessLock({ dbPath, clientId: "client-a" });
    try {
      assert.throws(
        () => acquireClientProcessLock({ dbPath, clientId: "client-b" }),
        /已有 CodeFlow client 正在使用同一个 DB/,
      );
      assert.equal(fs.existsSync(lock.lockPath), true);
    } finally {
      lock.release();
    }
    assert.equal(fs.existsSync(lock.lockPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client process lock removes a stale Windows lock after PID reuse", { skip: process.platform !== "win32" }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-lock-reused-pid-"));
  const dbPath = path.join(tempDir, "client.db");
  const sleeper = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], {
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      sleeper.once("spawn", resolve);
      sleeper.once("error", reject);
    });
    assert.ok(sleeper.pid);
    const lockPath = buildClientProcessLockPath(dbPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      token: "stale-token",
      pid: sleeper.pid,
      clientId: "client-stale",
      dbPath,
      startedAt: Date.now() - 60_000,
    }));

    const lock = acquireClientProcessLock({ dbPath, clientId: "client-current" });
    try {
      assert.equal(fs.existsSync(lock.lockPath), true);
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, "utf8")) as { pid: number; clientId: string };
      assert.equal(payload.pid, process.pid);
      assert.equal(payload.clientId, "client-current");
    } finally {
      lock.release();
    }
  } finally {
    sleeper.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client process lock removes a stale Windows lock when kill0 reports EPERM but tasklist has no match", { skip: process.platform !== "win32" }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-lock-missing-pid-"));
  const dbPath = path.join(tempDir, "client.db");
  const lockPath = buildClientProcessLockPath(dbPath);
  const stalePid = 999_999;
  const originalKill = process.kill;

  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      token: "stale-token",
      pid: stalePid,
      clientId: "client-stale",
      dbPath,
      startedAt: Date.now() - 60_000,
    }));
    (process as typeof process & { kill: typeof process.kill }).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid && signal === 0) {
        const error = new Error("kill EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    const lock = acquireClientProcessLock({ dbPath, clientId: "client-current" });
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, "utf8")) as { pid: number; clientId: string };
      assert.equal(payload.pid, process.pid);
      assert.equal(payload.clientId, "client-current");
    } finally {
      lock.release();
    }
  } finally {
    process.kill = originalKill;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
test("stable client id is persisted per local DB and cannot drift", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-id-"));
  const dbPath = path.join(tempDir, "client.db");

  try {
    const db = openClientDb({ dbPath });
    try {
      ensureStableClientId(db, "client-a");
      ensureStableClientId(db, "client-a");
      assert.equal(readBoundClientId(db), "client-a");
      assert.throws(
        () => ensureStableClientId(db, "client-b"),
        /同一个 DB 不允许更换 clientId/,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default DB rejects implicit CODEFLOWAI_CLIENT_ID override", () => {
  const defaultDbPath = path.join(os.homedir(), ".codeflowai", "codeflowai.db");
  assert.throws(
    () => assertClientIdOverrideAllowed({
      dbPath: defaultDbPath,
      clientIdSource: "env",
      allowOverride: false,
    }),
    /默认 CodeFlow DB 不允许直接覆盖 CODEFLOWAI_CLIENT_ID/,
  );
  assert.doesNotThrow(
    () => assertClientIdOverrideAllowed({
      dbPath: defaultDbPath,
      clientIdSource: "config",
      allowOverride: false,
    }),
  );
  assert.doesNotThrow(
    () => assertClientIdOverrideAllowed({
      dbPath: defaultDbPath,
      clientIdSource: "db-meta",
      allowOverride: false,
    }),
  );
  assert.doesNotThrow(
    () => assertClientIdOverrideAllowed({
      dbPath: defaultDbPath,
      clientIdSource: "hostname",
      allowOverride: false,
    }),
  );
  assert.doesNotThrow(
    () => assertClientIdOverrideAllowed({
      dbPath: path.join(os.tmpdir(), "codeflowai-test.db"),
      clientIdSource: "env",
      allowOverride: false,
    }),
  );
});
