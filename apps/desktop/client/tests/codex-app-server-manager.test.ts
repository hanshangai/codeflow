import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { CodexAppServerManager } from "../src/engines/codex-app-server/codexAppServerManager.ts";

const WORKSPACE_ID = "client-test:ws-codex-manager" as WorkspaceId;
const WORKSPACE_PATH = "Z:/code/aidt-code";

/** 创建不启动真实子进程的 Manager。 */
function createManager(stdoutDispatchLimits?: {
  batchMessages?: number;
  batchBytes?: number;
  highWaterMessages?: number;
  highWaterBytes?: number;
}): CodexAppServerManager {
  return new CodexAppServerManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    stdoutDispatchLimits,
  });
}

/** 等待 stdout 调度器完成一轮 setImmediate。 */
function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 为 stdout 调度测试绑定一个不会启动真实进程的当前代 child。 */
function markWorkspaceRunning(workspace: any): void {
  const child = {
    killed: false,
    pid: 0,
    kill() {
      child.killed = true;
      return true;
    },
  };
  workspace.child = child;
  workspace.processGeneration = 1;
  workspace.kill = async () => {
    workspace.child = null;
  };
}

test("Codex app-server 同一 thread 复用、不同 thread 隔离进程", async () => {
  const manager = createManager();
  const firstThread = "thread-codex-manager-1" as ThreadId;
  const secondThread = "thread-codex-manager-2" as ThreadId;

  const first = manager.forThread(firstThread).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const reused = manager.forThread(firstThread).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const isolated = manager.forThread(secondThread).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);

  assert.equal(reused, first);
  assert.notEqual(isolated, first);
  await manager.killAllWorkspaces();
});

test("Codex app-server releaseThread 只释放目标 thread 并允许重建", async () => {
  const manager = createManager();
  const firstThread = "thread-codex-release-1" as ThreadId;
  const secondThread = "thread-codex-release-2" as ThreadId;
  const firstHandle = manager.forThread(firstThread);
  const secondHandle = manager.forThread(secondThread);
  const first = firstHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const second = secondHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let firstKillCount = 0;
  let secondKillCount = 0;
  (first as any).kill = async () => { firstKillCount += 1; };
  (second as any).kill = async () => { secondKillCount += 1; };

  await manager.releaseThread(firstThread);

  assert.equal(firstKillCount, 1);
  assert.equal(secondKillCount, 0);
  assert.equal(firstHandle.getExisting(WORKSPACE_ID), null);
  assert.equal(secondHandle.getExisting(WORKSPACE_ID), second);
  assert.notEqual(firstHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH), first);
  await manager.killAllWorkspaces();
});

test("Codex app-server restart 只重启目标 thread 并返回新 Workspace", async () => {
  const manager = createManager();
  const threadId = "thread-codex-target-restart" as ThreadId;
  const handle = manager.forThread(threadId);
  const first = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let killCalls = 0;
  (first as any).kill = async () => { killCalls += 1; };

  const restarted = await handle.restart!(WORKSPACE_ID, WORKSPACE_PATH);

  assert.equal(killCalls, 1);
  assert.notEqual(restarted, first);
  assert.equal(handle.getExisting(WORKSPACE_ID), restarted);
  await manager.releaseThread(threadId);
});

test("Codex app-server restart 迁移目标 thread 的消息 handler", async () => {
  const manager = createManager();
  const threadId = "thread-codex-handler-transfer" as ThreadId;
  const handle = manager.forThread(threadId);
  const first = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const received: string[] = [];
  first.registerThread("provider-handler-transfer", (message) => {
    received.push(String((message.params as any)?.seq));
  });
  (first as any).kill = async () => {};

  const replacement = await handle.restart!(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(replacement);
  (replacement as any).onStdoutLine(JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "provider-handler-transfer", seq: 1 },
  }));
  await handle.drainMessages();

  assert.deepEqual(received, ["1"]);
  await manager.releaseThread(threadId);
});

test("Codex app-server 拒绝同一 thread 跨 workspace 复用", async () => {
  const manager = createManager();
  const threadId = "thread-codex-scope" as ThreadId;
  const handle = manager.forThread(threadId);
  handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);

  assert.throws(
    () => handle.getOrCreate("client-test:ws-other" as WorkspaceId, WORKSPACE_PATH),
    /thread scope mismatch/,
  );
  await manager.killAllWorkspaces();
});

test("Codex app-server 进程终止失败时保留 thread 记录供重试", async () => {
  const manager = createManager();
  const threadId = "thread-codex-release-failed" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  (workspace as any).kill = async () => { throw new Error("taskkill failed"); };

  await assert.rejects(manager.releaseThread(threadId), /taskkill failed/);
  assert.equal(handle.getExisting(WORKSPACE_ID), workspace);

  (workspace as any).kill = async () => {};
  await manager.releaseThread(threadId);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
});

test("Codex app-server 同步终止异常会清理门禁并保留记录供重试", async () => {
  const manager = createManager();
  const threadId = "thread-codex-release-sync-failed" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let killCalls = 0;
  (workspace as any).kill = () => {
    killCalls += 1;
    throw new Error("taskkill sync failed");
  };

  await assert.rejects(manager.releaseThread(threadId), /taskkill sync failed/);
  assert.equal(killCalls, 1);
  assert.equal(handle.getExisting(WORKSPACE_ID), workspace);

  (workspace as any).kill = async () => { killCalls += 1; };
  await manager.releaseThread(threadId);
  assert.equal(killCalls, 2);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
});

test("Codex app-server 并发 releaseThread 共享失败并允许重试", async () => {
  const manager = createManager();
  const threadId = "thread-codex-release-shared-failure" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let rejectKill!: (error: Error) => void;
  let killCalls = 0;
  (workspace as any).kill = () => {
    killCalls += 1;
    return new Promise<void>((_resolve, reject) => { rejectKill = reject; });
  };

  const first = manager.releaseThread(threadId);
  const second = manager.releaseThread(threadId);
  assert.equal(first, second);
  rejectKill(new Error("taskkill shared failure"));
  const results = await Promise.allSettled([first, second]);

  assert.equal(killCalls, 1);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.match(String((results[0] as PromiseRejectedResult).reason), /taskkill shared failure/);
  assert.equal(handle.getExisting(WORKSPACE_ID), workspace);

  (workspace as any).kill = async () => { killCalls += 1; };
  await manager.releaseThread(threadId);
  assert.equal(killCalls, 2);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
});

test("Codex app-server 并发 releaseThread 复用回收且完成前保留记录", async () => {
  const manager = createManager();
  const threadId = "thread-codex-release-singleflight" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let releaseKill!: () => void;
  const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
  let killCalls = 0;
  (workspace as any).kill = async () => {
    killCalls += 1;
    await killGate;
  };

  const first = manager.releaseThread(threadId);
  const second = manager.releaseThread(threadId);
  await nextImmediate();

  assert.equal(first, second);
  assert.equal(killCalls, 1);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
  assert.throws(
    () => handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH),
    /being released/,
  );

  releaseKill();
  await first;
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
});

test("Codex app-server releaseThread 在 kill 同步回调前建立 Manager 门禁", async () => {
  const manager = createManager();
  const threadId = "thread-codex-release-reentrant" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let nestedRelease: Promise<void> | null = null;
  let replacementError: unknown = null;
  (workspace as any).kill = () => {
    nestedRelease = manager.releaseThread(threadId);
    try {
      handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
    } catch (error) {
      replacementError = error;
    }
    return Promise.resolve();
  };

  const release = manager.releaseThread(threadId);
  assert.equal(nestedRelease, release);
  assert.match(String((replacementError as Error)?.message ?? replacementError), /being released/);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
  await release;
});

test("Codex app-server 全量回收删除成功项并保留失败项", async () => {
  const manager = createManager();
  const succeededThreadId = "thread-codex-kill-all-succeeded" as ThreadId;
  const failedThreadId = "thread-codex-kill-all-failed" as ThreadId;
  const succeededHandle = manager.forThread(succeededThreadId);
  const failedHandle = manager.forThread(failedThreadId);
  const succeeded = succeededHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const failed = failedHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  (succeeded as any).kill = async () => {};
  (failed as any).kill = async () => { throw new Error("taskkill failed"); };

  await assert.rejects(
    manager.killAllWorkspaces(),
    (error: any) => error instanceof AggregateError && /1 个/.test(error.message),
  );

  assert.equal(succeededHandle.getExisting(WORKSPACE_ID), null);
  assert.equal(failedHandle.getExisting(WORKSPACE_ID), failed);
  (failed as any).kill = async () => {};
  await manager.releaseThread(failedThreadId);
});

test("Codex app-server 全量回收失败后清理门禁并允许整体重试", async () => {
  const manager = createManager();
  const threadId = "thread-codex-kill-all-retry" as ThreadId;
  const handle = manager.forThread(threadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  let shouldFail = true;
  let killCalls = 0;
  (workspace as any).kill = async () => {
    killCalls += 1;
    if (shouldFail) throw new Error("taskkill retryable failure");
  };

  await assert.rejects(manager.killAllWorkspaces(), /1 个/);
  assert.equal(handle.getExisting(WORKSPACE_ID), workspace);
  shouldFail = false;
  await manager.killAllWorkspaces();

  assert.equal(killCalls, 2);
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
});

test("Codex app-server 全量回收 singleflight 且期间拒绝创建新进程", async () => {
  const manager = createManager();
  const firstThreadId = "thread-codex-kill-all-gate-first" as ThreadId;
  const secondThreadId = "thread-codex-kill-all-gate-second" as ThreadId;
  const first = manager.forThread(firstThreadId).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const second = manager.forThread(secondThreadId).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const order: string[] = [];
  let releaseFirst!: () => void;
  (first as any).kill = async () => {
    order.push("first-start");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
  };
  (second as any).kill = async () => { order.push("second"); };

  const firstKillAll = manager.killAllWorkspaces();
  const secondKillAll = manager.killAllWorkspaces();
  await nextImmediate();
  assert.equal(firstKillAll, secondKillAll);
  assert.deepEqual(order, ["first-start"]);
  assert.throws(
    () => manager.forThread("thread-codex-kill-all-new" as ThreadId).getOrCreate(WORKSPACE_ID, WORKSPACE_PATH),
    /workspaces are being released/,
  );

  releaseFirst();
  await firstKillAll;
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("Codex stdout 跨 thread round-robin 且每个 thread 严格 FIFO", async () => {
  const manager = createManager({
    batchMessages: 2,
    batchBytes: 1024 * 1024,
    highWaterMessages: 100,
    highWaterBytes: 1024 * 1024,
  });
  const firstHandle = manager.forThread("thread-stdout-a" as ThreadId);
  const secondHandle = manager.forThread("thread-stdout-b" as ThreadId);
  const first = firstHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const second = secondHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(first);
  markWorkspaceRunning(second);
  const received: string[] = [];
  first.registerThread("provider-a", (message) => received.push(String((message.params as any)?.seq)));
  second.registerThread("provider-b", (message) => received.push(String((message.params as any)?.seq)));

  for (const seq of ["a1", "a2", "a3"]) {
    (first as any).onStdoutLine(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-a", seq } }));
  }
  for (const seq of ["b1", "b2"]) {
    (second as any).onStdoutLine(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-b", seq } }));
  }

  assert.deepEqual(received, []);
  await nextImmediate();
  assert.deepEqual(received, ["a1", "b1"]);
  await nextImmediate();
  assert.deepEqual(received, ["a1", "b1", "a2", "b2"]);
  await Promise.all([firstHandle.drainMessages(), secondHandle.drainMessages()]);
  assert.deepEqual(received, ["a1", "b1", "a2", "b2", "a3"]);
  await manager.killAllWorkspaces();
});

test("Codex stdout 单条处理超出时间预算后让出，下一轮继续保序", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const manager = createManager();
  t.after(() => manager.killAllWorkspaces());
  const handle = manager.forThread("thread-stdout-time-budget" as ThreadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(workspace);
  const received: number[] = [];
  workspace.registerThread("provider-time-budget", message => {
    received.push((message.params as { seq: number }).seq);
    now += 9;
  });
  for (const seq of [1, 2, 3]) {
    (workspace as any).onStdoutLine(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-time-budget", seq } }));
  }
  await nextImmediate();
  assert.deepEqual(received, [1]);
  await nextImmediate();
  assert.deepEqual(received, [1, 2]);
  await handle.drainMessages();
  assert.deepEqual(received, [1, 2, 3]);
});

test("单 thread 10746 条 stdout 洪峰分批让出且不饿死其它 thread", async t => {
  t.mock.method(performance, "now", () => 0);
  const manager = createManager({
    batchMessages: 100,
    batchBytes: 1024 * 1024,
    highWaterMessages: 20_000,
    highWaterBytes: 128 * 1024 * 1024,
  });
  const noisyHandle = manager.forThread("thread-stdout-noisy" as ThreadId);
  const siblingHandle = manager.forThread("thread-stdout-sibling" as ThreadId);
  const noisy = noisyHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const sibling = siblingHandle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(noisy);
  markWorkspaceRunning(sibling);
  let noisyCalls = 0;
  let siblingCalls = 0;
  noisy.registerThread("provider-noisy", () => { noisyCalls += 1; });
  sibling.registerThread("provider-sibling", () => { siblingCalls += 1; });

  for (let seq = 1; seq <= 10_746; seq += 1) {
    (noisy as any).onStdoutLine(JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "provider-noisy", seq },
    }));
  }
  (sibling as any).onStdoutLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "provider-sibling", seq: 1 },
  }));

  assert.equal(noisyCalls, 0);
  assert.equal(siblingCalls, 0);
  await nextImmediate();
  assert.equal(noisyCalls, 99);
  assert.equal(siblingCalls, 1);
  await Promise.all([noisyHandle.drainMessages(), siblingHandle.drainMessages()]);
  assert.equal(noisyCalls, 10_746);
  assert.equal(siblingCalls, 1);
  await manager.killAllWorkspaces();
});

test("Codex stdout 高水位只反压目标 thread 的独占子进程", async () => {
  const manager = createManager({
    batchMessages: 1,
    batchBytes: 1024 * 1024,
    highWaterMessages: 2,
    highWaterBytes: 1024 * 1024,
  });
  const handle = manager.forThread("thread-stdout-flow-control" as ThreadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(workspace);
  let pauseCount = 0;
  let resumeCount = 0;
  const stdout = {
    pause: () => { pauseCount += 1; },
    resume: () => { resumeCount += 1; },
  };
  workspace.registerThread("provider-flow", () => undefined);

  for (const seq of [1, 2, 3]) {
    (workspace as any).onStdoutLine(
      JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-flow", seq } }),
      stdout,
    );
  }

  assert.equal(pauseCount, 1);
  await nextImmediate();
  assert.equal(resumeCount, 0);
  await nextImmediate();
  assert.equal(resumeCount, 1);
  await handle.drainMessages();
  await manager.killAllWorkspaces();
});

test("Codex stdout 已暂停时控制 RPC 会唤醒管道且不再次暂停", async () => {
  const manager = createManager({
    batchMessages: 100,
    batchBytes: 1024 * 1024,
    highWaterMessages: 2,
    highWaterBytes: 1024 * 1024,
  });
  const handle = manager.forThread("thread-stdout-control-plane" as ThreadId);
  const workspace = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  markWorkspaceRunning(workspace);
  (workspace as any).child.stdin = { write: () => true };
  let pauseCount = 0;
  let resumeCount = 0;
  const stdout = {
    pause: () => { pauseCount += 1; },
    resume: () => { resumeCount += 1; },
  };
  workspace.registerThread("provider-control-plane", () => undefined);

  for (const seq of [1, 2]) {
    (workspace as any).onStdoutLine(
      JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-control-plane", seq } }),
      stdout,
    );
  }
  assert.equal(pauseCount, 1);

  const request = workspace.request("thread/read", {}, { timeoutMs: 2_000 });
  while ((workspace as any).pending.size === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(resumeCount, 1);

  for (const seq of [3, 4, 5]) {
    (workspace as any).onStdoutLine(
      JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "provider-control-plane", seq } }),
      stdout,
    );
  }
  assert.equal(pauseCount, 1);

  const requestId = Array.from((workspace as any).pending.keys())[0] as number;
  (workspace as any).onStdoutLine(JSON.stringify({ id: requestId, result: { ok: true } }));
  assert.deepEqual(await request, { ok: true });
  await handle.drainMessages();
  await manager.killAllWorkspaces();
});

test("Codex诊断失败首次release仍拒绝，确认物理回收后新record可继续且不重发旧turn", async () => {
  const failure = new Error("workspace-log-failed");
  const manager = new CodexAppServerManager({ writeWorkspaceLog() { throw failure; }, clientInfo: { name: "test", title: "test", version: "0" } });
  const threadId = "diagnostic-release" as ThreadId, handle = manager.forThread(threadId);
  const first = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const child = { pid: 42, exitCode: null, signalCode: null };
  (first as any).child = child;
  (first as any).processGeneration = 1;
  (first as any).opts.terminateProcessTree = async () => {};
  (first as any).failWorkspace(Object.assign(new Error("process failed"), { code: "codex_app_server_process_error" }), {
    child, processGeneration: 1, notifyThreads: false, killChild: true,
  });
  await assert.rejects(manager.releaseThread(threadId));
  assert.equal(handle.getExisting(WORKSPACE_ID), null);
  const replacement = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  assert.notEqual(replacement, first);
  assert.equal(replacement.isRunning(), false);
  await manager.killAllWorkspaces();
});

test("Codex诊断失败合并未确认kill时保留原record并拒绝替换", async () => {
  const manager = new CodexAppServerManager({ writeWorkspaceLog() { throw undefined; }, clientInfo: { name: "test", title: "test", version: "0" } });
  const threadId = "diagnostic-kill-failed" as ThreadId, handle = manager.forThread(threadId);
  const first = handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH);
  const child = { pid: 43, exitCode: null, signalCode: null };
  (first as any).child = child;
  (first as any).processGeneration = 1;
  (first as any).opts.terminateProcessTree = async () => { throw new Error("kill-unconfirmed"); };
  (first as any).failWorkspace(Object.assign(new Error("process failed"), { code: "codex_app_server_process_error" }), {
    child, processGeneration: 1, notifyThreads: false, killChild: true,
  });
  await assert.rejects(manager.releaseThread(threadId));
  assert.equal(handle.getExisting(WORKSPACE_ID), first);
  assert.equal(handle.getOrCreate(WORKSPACE_ID, WORKSPACE_PATH), first);
  assert.equal(first.isReleaseComplete(), false);
});
