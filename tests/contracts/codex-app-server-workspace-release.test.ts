import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import type { ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { CodexAppServerManager } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerManager.ts";
import {
  type CodexAppServerWorkspace,
  type CodexProcessTreeTerminationCompletion,
  type CodexProcessTreeTerminationHandle,
  terminateCodexProcessTree,
} from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerWorkspace.ts";
import { ThreadSessionManager } from "../../apps/desktop/client/src/engines/threadSessionManager.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";

const workspaceId = "workspace-release-regression" as WorkspaceId;
const threadId = "thread-release-regression" as ThreadId;
let fixtureDirectory: string;
let originalPath: string | undefined;
const terminationCleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();
const workspaceLogs: any[] = [];
const processCloses = new Map<ChildProcessWithoutNullStreams, Promise<unknown>>();

/** 使用真正的 Node 子进程和 JSON-RPC 管道，不调用外部模型或客户环境。 */
test.before(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-codex-release-"));
  originalPath = process.env.PATH;
  const entry = path.join(fixtureDirectory, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `
const readline = require("node:readline");
let requests = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
    return;
  }
  requests += 1;
  if (msg.method === "fixture/emit") {
    process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params.threadId } }) + "\\n");
  }
  process.stdout.write(JSON.stringify({ id: msg.id, result: { pid: process.pid, requests } }) + "\\n");
});
`);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(fixtureDirectory, "codex.cmd"), "@echo off\r\n");
  } else {
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    fs.writeFileSync(path.join(fixtureDirectory, "codex"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { mode: 0o755 });
  }
  process.env.PATH = `${fixtureDirectory}${path.delimiter}${originalPath ?? ""}`;
});

/** 所有真实 child 的管道与进程 close 后再删除工作目录，避免 Windows 仍持有目录句柄。 */
test.after(async () => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(processCloses.values()),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("测试子进程 close 未在 5 秒内完成")), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (originalPath == null) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type TerminationSeam = {
  terminateProcessTree: (child: ChildProcessWithoutNullStreams) => CodexProcessTreeTerminationHandle;
};

/** 只控制终止器的两阶段结算；启动、RPC、缓存和释放执行正式代码。 */
function holdTermination(t: TestContext, workspace: CodexAppServerWorkspace) {
  const outcome = deferred<void>();
  const completion = deferred<CodexProcessTreeTerminationCompletion>();
  let child: ChildProcessWithoutNullStreams | null = null;
  let calls = 0;
  const mock = t.mock.method(workspace as unknown as TerminationSeam, "terminateProcessTree", (value: ChildProcessWithoutNullStreams) => {
    child = value;
    calls += 1;
    return { outcome: outcome.promise, completion: completion.promise };
  });
  const confirm = async () => {
    assert.ok(child, "尚未请求终止测试子进程");
    if (child.exitCode == null && child.signalCode == null) {
      const closed = once(child, "close");
      assert.equal(child.kill(), true);
      await closed;
    }
    completion.resolve({ status: "confirmed" });
    await nextImmediate();
  };
  const cleanups = terminationCleanups.get(t) ?? [];
  cleanups.push(async () => {
    if (child) await confirm();
    outcome.resolve();
    mock.mock.restore();
  });
  terminationCleanups.set(t, cleanups);
  return { outcome, completion, confirm, get calls() { return calls; } };
}

async function finishHeldTerminations(t: TestContext): Promise<void> {
  for (const cleanup of terminationCleanups.get(t) ?? []) await cleanup();
  t.mock.restoreAll();
}

function createManager(t: TestContext) {
  const manager = new CodexAppServerManager({
    writeWorkspaceLog: (_workspaceId, entry) => { workspaceLogs.push(entry); },
    clientInfo: { name: "release_test", title: "Release test", version: "1" },
    resolveCodexRuntimeConfig: () => null,
  });
  t.after(async () => {
    await finishHeldTerminations(t);
    await manager.killAllWorkspaces();
  });
  return manager;
}

/** 执行真实 RPC 并追踪启动的 child，供全局清理有界等待 close。 */
async function ping(workspace: CodexAppServerWorkspace) {
  const result = await workspace.request("fixture/ping", {}) as { pid: number; requests: number };
  const child = (workspace as unknown as { child: ChildProcessWithoutNullStreams }).child;
  if (!processCloses.has(child)) processCloses.set(child, once(child, "close"));
  return result;
}

test("Windows taskkill helper 超时先失败、迟到零退出码仍能确认回收", async () => {
  const helper = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  const root = { pid: 54321, exitCode: null, signalCode: null } as ChildProcessWithoutNullStreams;
  const handle = terminateCodexProcessTree(root, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    timeoutMs: 5,
    stopGraceMs: 5,
    spawnProcess: (() => helper) as unknown as typeof import("node:child_process").spawn,
  });
  // 生产终止器的超时计时器是 unref，测试用有界计时器维持事件循环。
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(handle.outcome, /taskkill timed out/);
    helper.exitCode = 0;
    helper.emit("close", 0, null);
    assert.deepEqual(await handle.completion, { status: "confirmed" });
  } finally {
    clearTimeout(keepAlive);
    helper.emit("close", 0, null);
    helper.stdout.destroy();
    helper.stderr.destroy();
  }
});

test("释放先超时后确认退出：同一会话恢复新 workspace，其他会话保持可用", async (t) => {
  const manager = createManager(t);
  const bound = manager.forThread(threadId);
  const old = bound.getOrCreate(workspaceId, fixtureDirectory);
  const original = await ping(old);
  const sibling = manager.forThread("thread-release-sibling" as ThreadId)
    .getOrCreate(workspaceId, fixtureDirectory);
  const siblingProcess = await ping(sibling);
  const held = holdTermination(t, old);
  const release = manager.releaseThread(threadId);
  assert.strictEqual(manager.releaseThread(threadId), release);
  assert.throws(() => bound.getOrCreate(workspaceId, fixtureDirectory), /being released/);
  held.outcome.reject(new Error("injected taskkill timeout"));
  await assert.rejects(release, { code: "codex_app_server_process_tree_termination_failed" });
  assert.strictEqual(bound.getOrCreate(workspaceId, fixtureDirectory), old);
  await assert.rejects(ping(old), { code: "codex_app_server_process_tree_termination_failed" });
  assert.equal((await ping(sibling)).pid, siblingProcess.pid);

  await held.confirm();
  // 精确复现客户文案：旧对象永久封存，不能靠重置 releaseRequested 复活。
  await assert.rejects(ping(old), /Codex app-server workspace has been released/);
  t.diagnostic("已通过真实 RPC 启动的旧对象复现：Codex app-server workspace has been released");
  const replacement = bound.getOrCreate(workspaceId, fixtureDirectory);
  assert.notStrictEqual(replacement, old, "回收已完成后不得继续返回已释放的旧 workspace");
  const restarted = await ping(replacement);
  assert.notEqual(restarted.pid, original.pid);
  assert.equal(restarted.requests, 1, "替换对象不会自动重播旧 RPC");
  assert.equal((await ping(sibling)).pid, siblingProcess.pid);
});

test("迟到确认后 getExisting 不暴露已释放对象，并保留 thread 事件路由及注销句柄", async (t) => {
  const manager = createManager(t);
  const bound = manager.forThread(threadId);
  const old = bound.getOrCreate(workspaceId, fixtureDirectory);
  await ping(old);
  const messages: unknown[] = [];
  const unregister = old.registerThread("provider-thread", (message) => messages.push(message));
  const held = holdTermination(t, old);
  const release = manager.releaseThread(threadId);
  held.outcome.reject(new Error("injected taskkill timeout"));
  await assert.rejects(release);
  await held.confirm();
  assert.equal(bound.getExisting(workspaceId), null);
  const replacement = bound.getOrCreate(workspaceId, fixtureDirectory);
  messages.length = 0;
  await replacement.request("fixture/emit", { threadId: "provider-thread" });
  await bound.drainMessages?.();
  assert.equal(messages.length, 1);
  unregister();
  await replacement.request("fixture/emit", { threadId: "provider-thread" });
  await bound.drainMessages?.();
  assert.equal(messages.length, 1, "旧注销句柄仍能注销迁移后的 handler");
});

test("回收最终失败时保留旧进程，禁止新建替代进程，显式重启可再次回收", async (t) => {
  const manager = createManager(t);
  const bound = manager.forThread(threadId);
  const old = bound.getOrCreate(workspaceId, fixtureDirectory);
  await ping(old);
  const held = holdTermination(t, old);
  const release = manager.releaseThread(threadId);
  held.outcome.reject(new Error("injected access denied"));
  held.completion.resolve({ status: "failed", error: new Error("injected helper failure") });
  await assert.rejects(release);
  await nextImmediate();
  assert.equal(old.isRunning(), true);
  assert.strictEqual(bound.getOrCreate(workspaceId, fixtureDirectory), old);
  await assert.rejects(ping(old), { code: "codex_app_server_process_tree_termination_failed" });
  assert.equal(held.calls, 1, "获取旧记录不会隐式重试杀进程或启动第二实例");
  t.mock.restoreAll();
  const replacement = await bound.restart!(workspaceId, fixtureDirectory);
  assert.notStrictEqual(replacement, old);
  await ping(replacement);
});

for (const rootExitOrder of ["before_helper", "after_helper"] as const) {
  test(`taskkill 非零退出后仅在原进程确认退出时解除续聊阻塞：${rootExitOrder}`, async (t) => {
    const manager = createManager(t);
    const bound = manager.forThread(threadId);
    const old = bound.getOrCreate(workspaceId, fixtureDirectory);
    const original = await ping(old);
    const sibling = manager.forThread("thread-root-exit-sibling" as ThreadId).getOrCreate(workspaceId, fixtureDirectory);
    const siblingProcess = await ping(sibling);
    const warnings: any[] = [];
    t.mock.method(logger, "warn", (_tag, _message, data) => { warnings.push(data); });
    const helper = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
    });
    let child: ChildProcessWithoutNullStreams | null = null;
    t.mock.method(old as unknown as TerminationSeam, "terminateProcessTree", (value: ChildProcessWithoutNullStreams) => {
      child = value;
      return terminateCodexProcessTree(value, {
        platform: "win32",
        systemRoot: "C:/Windows",
        spawnProcess: (() => helper) as unknown as typeof import("node:child_process").spawn,
      });
    });
    /** 只终止本测试持有的真实 child，等待 close 作为退出证据。 */
    const closeRoot = async () => {
      assert.ok(child);
      const closed = once(child, "close");
      assert.equal(child.kill(), true);
      await closed;
    };
    t.after(async () => {
      if (child && child.exitCode == null && child.signalCode == null) await closeRoot();
      helper.stdout.destroy();
      helper.stderr.destroy();
    });

    const release = manager.releaseThread(threadId);
    if (rootExitOrder === "before_helper") await closeRoot();
    helper.stderr.write("taskkill could not terminate an exited descendant");
    helper.exitCode = 128;
    helper.emit("close", 128, null);
    await assert.rejects(release, { code: "codex_app_server_process_tree_termination_failed" });
    if (rootExitOrder === "after_helper") {
      assert.strictEqual(bound.getOrCreate(workspaceId, fixtureDirectory), old);
      await assert.rejects(ping(old), { code: "codex_app_server_process_tree_termination_failed" });
      await closeRoot();
    }
    await nextImmediate();

    assert.equal(old.isReleaseComplete(), true);
    const workspaceRecovery = workspaceLogs.map(entry => entry?.data)
      .filter(item => item?.code === "codex_app_server_process_tree_termination_unconfirmed");
    const recovery = [...new Map((workspaceRecovery.length
      ? workspaceRecovery
      : warnings.filter(item => item?.code === "codex_app_server_process_tree_termination_unconfirmed"))
      .map(item => [item.requestId, item])).values()];
    assert.equal(recovery.length, 1);
    assert.match(recovery[0].rootCause, /code=128/);
    assert.match(recovery[0].requestId, /^codex-app-server:\d+:1:termination$/);
    const replacement = bound.getOrCreate(workspaceId, fixtureDirectory);
    assert.notStrictEqual(replacement, old);
    const restarted = await ping(replacement);
    assert.notEqual(restarted.pid, original.pid);
    assert.equal(restarted.requests, 1);
    assert.equal((await ping(sibling)).pid, siblingProcess.pid);
  });
}

test("正常释放成功和未启动对象释放均允许同一会话再次创建", async (t) => {
  const manager = createManager(t);
  const bound = manager.forThread(threadId);
  const unused = bound.getOrCreate(workspaceId, fixtureDirectory);
  await manager.releaseThread(threadId);
  const running = bound.getOrCreate(workspaceId, fixtureDirectory);
  assert.notStrictEqual(running, unused);
  await ping(running);
  await manager.releaseThread(threadId);
  assert.equal(bound.getExisting(workspaceId), null);
  const replacement = bound.getOrCreate(workspaceId, fixtureDirectory);
  assert.notStrictEqual(replacement, running);
  await ping(replacement);
});

test("idle 回收失败后 session 已删除：迟到退出确认允许原 thread 创建新 session 和进程", async (t) => {
  const threads = new ThreadStore();
  const runtime = threads.create({ threadId, workspaceId, engine: "codex", title: "release regression" });
  const sessions = new ThreadSessionManager({
    writeWorkspaceLog: () => {},
    workspaces: new Map([[workspaceId, fixtureDirectory]]),
    threads,
    resolveCodexRuntimeConfig: () => null,
    sessionIdleCleanup: { enabled: true, idleMs: 100, scanMs: 60_000, now: () => 0 },
  });
  const manager = (sessions as unknown as { codexAppServer: CodexAppServerManager }).codexAppServer;
  t.after(async () => {
    await finishHeldTerminations(t);
    await sessions.stopAndDrain();
  });
  const oldSession = sessions.getOrCreate(runtime);
  const bound = manager.forThread(threadId);
  const old = bound.getOrCreate(workspaceId, fixtureDirectory);
  await ping(old);
  const held = holdTermination(t, old);
  const cleanup = sessions.disposeIdleSessions(101);
  // session.dispose 和 stdout 排空会在调用 kill 前异步完成。
  while (held.calls === 0) await nextImmediate();
  held.outcome.reject(new Error("injected idle taskkill timeout"));
  await assert.rejects(cleanup, AggregateError);
  assert.equal(sessions.getExisting(threadId), null);
  await held.confirm();
  const replacementSession = sessions.getOrCreate(runtime);
  assert.notStrictEqual(replacementSession, oldSession);
  const replacement = bound.getOrCreate(workspaceId, fixtureDirectory);
  assert.notStrictEqual(replacement, old);
  await ping(replacement);
});
