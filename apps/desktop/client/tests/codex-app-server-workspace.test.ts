import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";

import type { WorkspaceId } from "@codeflowai/shared";

import { logger } from "../src/logger.ts";
import {
  CODEX_APP_SERVER_MAX_LINE_BYTES,
  CodexAppServerLineReader,
} from "../src/engines/codex-app-server/codexAppServerLineReader.ts";
import {
  CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  CodexAppServerWorkspace,
  terminateCodexProcessTree,
} from "../src/engines/codex-app-server/codexAppServerWorkspace.ts";

test("Codex app-server Windows 终止实现不再调用同步 taskkill", () => {
  const source = fs.readFileSync(
    new URL("../src/engines/codex-app-server/codexAppServerWorkspace.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bspawnSync\b/);
  assert.match(source, /spawnProcess\(taskkillPath/);
});

test("Windows taskkill 仅以零退出码确认完整进程树回收", async () => {
  const helper = createTaskkillHelper();
  let spawnArgs: readonly string[] = [];
  const handle = terminateCodexProcessTree(createWindowsProcess(45_001) as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: ((_command: string, args: readonly string[]) => {
      spawnArgs = args;
      return helper;
    }) as any,
    timeoutMs: 1_000,
  });

  helper.exitCode = 0;
  helper.emit("close", 0, null);
  await handle.outcome;
  assert.deepEqual(spawnArgs, ["/PID", "45001", "/T", "/F"]);
  assert.deepEqual(await handle.completion, { status: "confirmed" });
});

test("Windows taskkill 非零退出即使根进程随后退出也保持失败", async () => {
  const helper = createTaskkillHelper();
  const child = createWindowsProcess(45_002);
  const handle = terminateCodexProcessTree(child as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => helper) as any,
    timeoutMs: 1_000,
  });

  child.exitCode = 0;
  helper.stderr.write("tree termination denied");
  helper.exitCode = 1;
  helper.emit("close", 1, null);
  await assert.rejects(handle.outcome, /code=1/);
  const completion = await handle.completion;
  assert.equal(completion.status, "failed");
  if (completion.status === "failed") assert.match(completion.error.message, /tree termination denied/);
});

test("Windows 无效 PID 显式失败且不降级调用 child.kill", async () => {
  const child = createWindowsProcess(0);
  let spawnCalls = 0;
  const handle = terminateCodexProcessTree(child as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => {
      spawnCalls += 1;
      return createTaskkillHelper();
    }) as any,
  });

  await assert.rejects(handle.outcome, /PID is unavailable/);
  assert.equal(child.killCount, 0);
  assert.equal(spawnCalls, 0);
});

test("Windows taskkill 超时先失败调用但 helper close 前保留生命周期", async () => {
  const helper = createTaskkillHelper();
  const handle = terminateCodexProcessTree(createWindowsProcess(45_003) as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => helper) as any,
    timeoutMs: 10,
    stopGraceMs: 10,
  });
  let completionSettled = false;
  void handle.completion.then(() => { completionSettled = true; });
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    await assert.rejects(handle.outcome, /timed out/);
    assert.equal(helper.killCalls, 1);
    assert.equal(completionSettled, false);

    helper.exitCode = 0;
    helper.emit("close", 0, null);
    assert.deepEqual(await handle.completion, { status: "confirmed" });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("Windows taskkill helper exit 即可有界收口生命周期", async () => {
  const helper = createTaskkillHelper();
  const handle = terminateCodexProcessTree(createWindowsProcess(45_004) as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => helper) as any,
    timeoutMs: 1_000,
    stopGraceMs: 10,
  });
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    helper.exitCode = 1;
    helper.emit("exit", 1, null);
    await assert.rejects(handle.outcome, /code=1/);
    const completion = await handle.completion;
    assert.equal(completion.status, "failed");
    if (completion.status === "failed") assert.match(completion.error.message, /code=1/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("Windows taskkill 超时且 helper 无 exit/close 时有界失败", async () => {
  const helper = createTaskkillHelper();
  const handle = terminateCodexProcessTree(createWindowsProcess(45_005) as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => helper) as any,
    timeoutMs: 10,
    stopGraceMs: 10,
  });
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    await assert.rejects(handle.outcome, /timed out/);
    const completion = await handle.completion;
    assert.equal(completion.status, "failed");
    if (completion.status === "failed") {
      assert.match(completion.error.message, /taskkillHelperLifecycle=unconfirmed/);
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

test("Windows taskkill helper error 后无 exit/close 时有界失败", async () => {
  const helper = createTaskkillHelper();
  const handle = terminateCodexProcessTree(createWindowsProcess(45_006) as any, {
    platform: "win32",
    systemRoot: "C:/Windows",
    spawnProcess: (() => helper) as any,
    timeoutMs: 10,
    stopGraceMs: 10,
  });
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    helper.emit("error", new Error("taskkill helper stream failed"));
    await assert.rejects(handle.outcome, /helper error/);
    const completion = await handle.completion;
    assert.equal(completion.status, "failed");
    if (completion.status === "failed") {
      assert.match(completion.error.message, /taskkill helper stream failed/);
      assert.match(completion.error.message, /taskkillHelperLifecycle=unconfirmed/);
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

type FakeChild = {
  stdin: { write: (line: string) => boolean };
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (signal?: string) => boolean;
  written: string[];
  killCount: number;
};

/** 创建 request 测试所需的最小 app-server 子进程替身。 */
function createFakeChild(): FakeChild {
  const child: FakeChild = {
    stdin: {
      write(line: string) {
        child.written.push(line);
        return true;
      },
    },
    pid: 42_424,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      child.killed = true;
      child.killCount += 1;
      return true;
    },
    written: [],
    killCount: 0,
  };
  return child;
}

/** 创建绕过真实 spawn 的 workspace 测试夹具。 */
function createWorkspaceFixture(resolveCodexRuntimeConfig?: () => { baseUrl?: string | null } | null) {
  const requestTimeouts: any[] = [];
  const processFaults: any[] = [];
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-app-server" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    resolveCodexRuntimeConfig,
    onRequestTimeout: (timeout) => requestTimeouts.push(timeout),
    onProcessFault: (fault) => processFaults.push(fault),
    terminateProcessTree: async (child) => {
      child.kill("SIGTERM");
    },
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  return { workspace, child, requestTimeouts, processFaults };
}

test("请求超时诊断失败仍拒绝原 pending 并保留迟到结算句柄", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = createWorkspaceFixture(), failure = new Error("timeout-log-failed");
  (fixture.workspace as any).opts.onRequestTimeout = () => { throw failure; };
  const request = fixture.workspace.request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true });
  await Promise.resolve();
  const rejected = request.then(() => assert.fail("request must fail"), error => error);
  assert.doesNotThrow(() => t.mock.timers.tick(500));
  const error = await rejected;
  assert.equal(error.code, "ENGINE_WORKSPACE_LOG_FAILED");
  assert.equal(typeof error.lateSettlement?.then, "function");
  assert.equal((fixture.workspace as any).pending.size, 0);
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: error.requestId, result: { accepted: true } }));
  assert.deepEqual(await error.lateSettlement, { status: "fulfilled", value: { accepted: true } });
  await assert.rejects(fixture.workspace.kill(), cause => cause === error);
});

test("进程故障回调失败先结算所有请求并在关闭返回原诊断失败", async () => {
  const fixture = createWorkspaceFixture(), failure = new Error("process-fault-log-failed");
  (fixture.workspace as any).opts.onProcessFault = () => { throw failure; };
  const request = fixture.workspace.request("turn/start", {}, { timeoutMs: 2_000 });
  const rejected = request.then(() => assert.fail("request must fail"), error => error);
  await Promise.resolve();
  const processError = Object.assign(new Error("process stopped"), { code: "codex_app_server_closed", terminationKind: "error" });
  assert.doesNotThrow(() => (fixture.workspace as any).failWorkspace(processError, {
    child: fixture.child, processGeneration: 1, notifyThreads: false, killChild: false,
  }));
  const error = await rejected;
  assert.equal(error.code, "ENGINE_WORKSPACE_LOG_FAILED");
  assert.equal((fixture.workspace as any).pending.size, 0);
  await assert.rejects(fixture.workspace.kill());
});

test("thread/start 和 thread/resume 会携带当前运行时 provider", async () => {
  const fixture = createWorkspaceFixture(() => ({ baseUrl: "https://switchbase.example/v1" }));
  const resume = fixture.workspace.request("thread/resume", { threadId: "provider-current" }, { timeoutMs: 2_000 });
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const resumeRequestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;
  const resumePayload = JSON.parse(fixture.child.written[0]!);
  assert.deepEqual(resumePayload.params, {
    threadId: "provider-current",
    modelProvider: "codeflowai",
    excludeTurns: true,
  });
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: resumeRequestId, result: {} }));
  await resume;

  const start = fixture.workspace.request("thread/start", { cwd: "Z:/code/aidt-code" }, { timeoutMs: 2_000 });
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const startRequestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;
  const startPayload = JSON.parse(fixture.child.written[1]!);
  assert.equal(startPayload.params.modelProvider, "codeflowai");
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: startRequestId, result: {} }));
  await start;
});

test("Codex app-server line reader preserves split UTF-8 lines and CRLF", () => {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const reader = new CodexAppServerLineReader((line) => lines.push(line), (error) => errors.push(error));

  const bytes = Buffer.from('{"text":"中文内容"}\r\n{"id":2}\n', "utf8");
  reader.push(bytes.subarray(0, 10));
  reader.push(bytes.subarray(10));

  assert.deepEqual(lines, ['{"text":"中文内容"}', '{"id":2}']);
  assert.deepEqual(errors, []);
});

test("Codex app-server line reader rejects an oversized unterminated line once", () => {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const reader = new CodexAppServerLineReader((line) => lines.push(line), (error) => errors.push(error), 8);

  reader.push(Buffer.from("1234"));
  reader.push(Buffer.from("56789\n{"));
  reader.push(Buffer.from("ignored"));

  assert.deepEqual(lines, []);
  assert.deepEqual(errors, [{ lineBytes: 9, maxLineBytes: 8 }]);
  assert.equal(CODEX_APP_SERVER_MAX_LINE_BYTES, 64 * 1024 * 1024);
});

test("Codex app-server line reader emits a final unterminated line at EOF", () => {
  const lines: string[] = [];
  const reader = new CodexAppServerLineReader((line) => lines.push(line), (error) => assert.fail(JSON.stringify(error)));
  reader.push(Buffer.from("first\nlast"));
  reader.end();
  reader.end();
  assert.deepEqual(lines, ["first", "last"]);
});

test("full thread reads use paginated RPCs and never send includeTurns=true", async () => {
  const fixture = createWorkspaceFixture();
  const read = fixture.workspace.request("thread/read", { threadId: "provider-thread", includeTurns: true }, {
    history: { itemTypes: [] },
  });
  while (fixture.child.written.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const metadata = JSON.parse(fixture.child.written[0]!);
  assert.equal(metadata.params.includeTurns, false);
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: metadata.id, result: { thread: { id: "provider-thread", status: { type: "idle" } } } }));
  while (fixture.child.written.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  const page = JSON.parse(fixture.child.written[1]!);
  assert.equal(page.method, "thread/turns/list");
  assert.equal(page.params.itemsView, "notLoaded");
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: page.id, result: { data: [{ id: "turn", status: "completed", items: [] }], nextCursor: null } }));

  const result = await read as any;
  assert.equal(result.thread.turns[0].id, "turn");
  assert.equal(fixture.child.written.length, 2);
});

test("paginated history stops when the owning app-server generation changes", async () => {
  const fixture = createWorkspaceFixture();
  const read = fixture.workspace.request("thread/read", { threadId: "provider-thread", includeTurns: true }, {
    history: { itemTypes: [] },
  });
  while (fixture.child.written.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const metadata = JSON.parse(fixture.child.written[0]!);
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: metadata.id, result: { thread: { id: "provider-thread" } } }));
  const replacement = createFakeChild();
  (fixture.workspace as any).child = replacement;
  (fixture.workspace as any).processGeneration = 2;

  await assert.rejects(read, (error: any) => error?.code === "codex_app_server_generation_changed");
  assert.equal(replacement.written.length, 0);
});

test("oversized Codex app-server lines explicitly fail only their workspace", async () => {
  const fixture = createWorkspaceFixture();
  const pending = fixture.workspace.request("thread/read", { threadId: "provider-thread" }, { timeoutMs: 2_000 });
  while ((fixture.workspace as any).pending.size === 0) await new Promise<void>((resolve) => setImmediate(resolve));

  (fixture.workspace as any).failOversizedLine(fixture.child, 1, "stdout", {
    lineBytes: CODEX_APP_SERVER_MAX_LINE_BYTES + 1,
    maxLineBytes: CODEX_APP_SERVER_MAX_LINE_BYTES,
  });

  await assert.rejects(pending, (error: any) => error?.code === "codex_app_server_protocol_line_too_large");
  await (fixture.workspace as any).termination?.promise;
  assert.equal(fixture.child.killCount, 1);
  assert.equal(fixture.workspace.isRunning(), false);
  assert.equal(fixture.processFaults[0]?.code, "codex_app_server_protocol_line_too_large");
  assert.equal(fixture.processFaults[0]?.requestId, "codex-app-server:42424:1:stdout");
  assert.match(fixture.processFaults[0]?.message ?? "", /lineBytes=67108865/);
});

/** 创建可控的 taskkill helper 替身。 */
function createTaskkillHelper() {
  const helper = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
    killCalls: number;
  };
  helper.pid = 43_434;
  helper.exitCode = null;
  helper.signalCode = null;
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.killCalls = 0;
  helper.kill = () => {
    helper.killCalls += 1;
    return true;
  };
  return helper;
}

/** 创建默认 Windows 终止器测试所需的运行中 child。 */
function createWindowsProcess(pid = 44_444): FakeChild {
  const child = createFakeChild();
  child.pid = pid;
  return child;
}

test("普通 request 超时只拒绝当前请求，不终止共享 app-server", async () => {
  const fixture = createWorkspaceFixture();
  let threadFaultCount = 0;
  fixture.workspace.registerThread("provider-thread-1", () => {
    threadFaultCount += 1;
  });

  const timedOut = fixture.workspace.request("thread/read", {}, { timeoutMs: 500 });
  const sibling = fixture.workspace.request("thread/resume", {}, { timeoutMs: 2_000 });
  await assert.rejects(timedOut, (error: any) => {
    assert.equal(error?.code, "codex_app_server_request_timeout");
    assert.equal(error?.method, "thread/read");
    assert.equal(error?.requestId, 1);
    assert.equal(error?.processGeneration, 1);
    return true;
  });

  assert.equal(fixture.child.killCount, 0);
  assert.equal(fixture.workspace.isRunning(), true);
  assert.equal(threadFaultCount, 0);
  assert.equal(fixture.processFaults.length, 0);
  assert.deepEqual(fixture.requestTimeouts.map((item) => item.method), ["thread/read"]);
  assert.deepEqual(fixture.requestTimeouts[0]?.pendingMethods, ["thread/read", "thread/resume"]);

  const siblingId = Array.from((fixture.workspace as any).pending.keys())[0];
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: siblingId, result: { ok: true } }));
  assert.deepEqual(await sibling, { ok: true });
});

test("ensureStarted 在 child 已 spawn 但 initialize 未完成时仍等待 ready 栅栏", async () => {
  const fixture = createWorkspaceFixture();
  (fixture.workspace as any).child = null;
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let startCalls = 0;
  (fixture.workspace as any).start = async () => {
    startCalls += 1;
    (fixture.workspace as any).child = createFakeChild();
    (fixture.workspace as any).processGeneration = 2;
    await startGate;
  };

  const first = fixture.workspace.ensureStarted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = fixture.workspace.ensureStarted();
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(startCalls, 1);
  assert.equal(secondSettled, false);
  releaseStart();
  await Promise.all([first, second]);
  assert.equal(secondSettled, true);
});

test("恢复 RPC 相同参数只发送一个请求，并在响应后解除 singleflight", async () => {
  const fixture = createWorkspaceFixture();
  const first = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-singleflight" },
    { timeoutMs: 10_000 },
  );
  const second = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-singleflight" },
    { timeoutMs: 10_000 },
  );
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal((fixture.workspace as any).pending.size, 1);
  assert.equal(((fixture.workspace as any).child as FakeChild).written.length, 1);
  const requestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: requestId, result: { ok: true } }));
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
});

test("恢复 RPC 旧 10 秒调用点实际使用 180 秒预算并开启迟到追踪", async () => {
  const fixture = createWorkspaceFixture();
  const request = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-recovery-budget" },
    { timeoutMs: 10_000 },
  );
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const pending = Array.from((fixture.workspace as any).pending.values())[0] as any;
  assert.equal(pending.timeout?._idleTimeout, CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS);
  const requestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;
  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: requestId, result: {} }));
  assert.deepEqual(await request, {});
});

test("恢复 RPC 超时保留迟到结算并阻止同一请求重复发出", async () => {
  const fixture = createWorkspaceFixture();
  const first = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-late-recovery" },
    { timeoutMs: 500, trackLateSettlement: true },
  );
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const firstError = await first.then(() => null, (error) => error as any);
  assert.equal(firstError?.code, "codex_app_server_request_timeout");
  assert.equal((fixture.workspace as any).timedOutPending.size, 1);

  const retryBeforeLate = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-late-recovery" },
    { timeoutMs: 500, trackLateSettlement: true },
  );
  const retryError = await retryBeforeLate.then(() => null, (error) => error as any);
  assert.equal(retryError, firstError);
  assert.equal(((fixture.workspace as any).child as FakeChild).written.length, 1);

  (fixture.workspace as any).onStdoutLine(JSON.stringify({
    id: firstError.requestId,
    result: { thread: { id: "provider-late-recovery" } },
  }));
  assert.deepEqual(await firstError.lateSettlement, {
    status: "fulfilled",
    value: { thread: { id: "provider-late-recovery" } },
  });
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);
});

test("恢复 RPC 写出前失败会释放迟到 singleflight", async () => {
  const fixture = createWorkspaceFixture();
  let writeCalls = 0;
  (fixture.child.stdin as any).write = () => {
    writeCalls += 1;
    throw new Error("stdin closed before recovery request");
  };

  const first = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-write-failed" },
    { timeoutMs: 500, trackLateSettlement: true },
  );
  const firstError = await first.then(() => null, (error) => error as Error);
  assert.match(firstError?.message ?? "", /stdin closed before recovery request/);
  assert.equal((fixture.workspace as any).inFlightRecoveryRequests.size, 0);

  const second = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-write-failed" },
    { timeoutMs: 500, trackLateSettlement: true },
  );
  const secondError = await second.then(() => null, (error) => error as Error);
  assert.match(secondError?.message ?? "", /stdin closed before recovery request/);
  assert.equal(writeCalls, 2);
});

test("恢复 RPC 超时后 stdout 背压仍不得暂停迟到响应", async () => {
  const fixture = createWorkspaceFixture();
  const request = fixture.workspace.request(
    "thread/resume",
    { threadId: "provider-late-backpressure" },
    { timeoutMs: 500, trackLateSettlement: true },
  );
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const requestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;
  const requestError = await request.then(() => null, (error) => error as any);
  assert.equal(requestError?.code, "codex_app_server_request_timeout");
  assert.equal((fixture.workspace as any).canPauseStdout(fixture.child, 1), false);

  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: requestId, result: { ok: true } }));
  assert.deepEqual(await requestError.lateSettlement, { status: "fulfilled", value: { ok: true } });
  assert.equal((fixture.workspace as any).canPauseStdout(fixture.child, 1), true);
});

test("迁移后的 thread handler 仍可由旧注销句柄释放", () => {
  const first = createWorkspaceFixture();
  const second = createWorkspaceFixture();
  let calls = 0;
  const unregister = first.workspace.registerThread("provider-handler-migrated", () => { calls += 1; });

  first.workspace.transferThreadHandlersTo(second.workspace);
  (second.workspace as any).onStdoutLine(JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "provider-handler-migrated", seq: 1 },
  }));
  assert.equal(calls, 1);

  unregister();
  (second.workspace as any).onStdoutLine(JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "provider-handler-migrated", seq: 2 },
  }));
  assert.equal(calls, 1);
});

test("旧 thread unregister 不会删除同 ID 后注册的 handler", () => {
  const fixture = createWorkspaceFixture();
  let oldHandlerCalls = 0;
  let currentHandlerCalls = 0;
  const unregisterOld = fixture.workspace.registerThread("provider-thread-owned", () => {
    oldHandlerCalls += 1;
  });
  const unregisterCurrent = fixture.workspace.registerThread("provider-thread-owned", () => {
    currentHandlerCalls += 1;
  });

  unregisterOld();
  (fixture.workspace as any).onStdoutLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "provider-thread-owned", turn: { id: "turn-current" } },
  }));

  assert.equal(oldHandlerCalls, 0);
  assert.equal(currentHandlerCalls, 1);
  unregisterCurrent();
  assert.equal((fixture.workspace as any).threadHandlers.has("provider-thread-owned"), false);
});

test("stdout RPC 响应立即结算，thread 通知交给外部调度器", async () => {
  const scheduled: Array<() => void> = [];
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-stdout-schedule" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    scheduleThreadMessage: (task) => scheduled.push(task.run),
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  let notificationCalls = 0;
  workspace.registerThread("provider-scheduled", () => { notificationCalls += 1; });

  (workspace as any).onStdoutLine(JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "provider-scheduled", delta: "chunk" },
  }));
  const request = workspace.request("thread/read", {}, { timeoutMs: 2_000 });
  while ((workspace as any).pending.size === 0) await new Promise((resolve) => setImmediate(resolve));
  const requestId = Array.from((workspace as any).pending.keys())[0];
  (workspace as any).onStdoutLine(JSON.stringify({ id: requestId, result: { ok: true } }));

  assert.deepEqual(await request, { ok: true });
  assert.equal(notificationCalls, 0);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  assert.equal(notificationCalls, 1);
});

test("JSON-RPC error 携带原请求 method 与 requestId 的明确拒绝标记", async () => {
  const fixture = createWorkspaceFixture();
  const request = fixture.workspace.request("turn/start", {}, { timeoutMs: 2_000 });
  while ((fixture.workspace as any).pending.size === 0) await new Promise((resolve) => setImmediate(resolve));
  const requestId = Array.from((fixture.workspace as any).pending.keys())[0] as number;

  (fixture.workspace as any).onStdoutLine(JSON.stringify({
    id: requestId,
    error: { message: "turn rejected" },
  }));

  await assert.rejects(request, (error: any) => {
    assert.equal(error?.rpcError, true);
    assert.equal(error?.method, "turn/start");
    assert.equal(error?.requestId, requestId);
    assert.equal(error?.terminationKind, "error");
    assert.equal(error?.message, "turn rejected");
    return true;
  });
});

test("Windows root 已退出时保留未确认事实并允许清理旧 Workspace", async (t) => {
  let spawnCalls = 0;
  const warnings: Array<{ tag: string; message: string; data: unknown }> = [];
  t.mock.method(logger, "warn", (tag, message, data) => {
    warnings.push({ tag, message, data });
  });
  let terminationHandle: ReturnType<typeof terminateCodexProcessTree> | null = null;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-root-exit-race" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: (child) => {
      terminationHandle = terminateCodexProcessTree(child, {
        platform: "win32",
        systemRoot: "C:/Windows",
        spawnProcess: (() => {
          spawnCalls += 1;
          return createTaskkillHelper();
        }) as any,
      });
      return terminationHandle;
    },
  });
  const child = createWindowsProcess(45_007);
  child.exitCode = 0;
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;

  await workspace.kill();
  const completion = await terminationHandle!.completion;

  assert.equal(spawnCalls, 0);
  assert.equal(completion.status, "unconfirmed");
  if (completion.status === "unconfirmed") {
    assert.match(completion.reason, /pid=45007, exitCode=0, signalCode=null/);
  }
  assert.equal(workspace.isRunning(), false);
  assert.equal((workspace as any).terminationFailure, null);
  assert.deepEqual(warnings, [{
    tag: "codex-app-server",
    message: "process tree termination unconfirmed",
    data: {
      code: "codex_app_server_process_tree_termination_unconfirmed",
      workspaceId: "client-test:ws-codex-root-exit-race",
      threadId: "test-thread",
      requestId: "engine:client-test:ws-codex-root-exit-race",
      pid: 45_007,
      processGeneration: 1,
      exitCode: 0,
      signalCode: null,
      reason: "Codex app-server root process already exited; descendant process tree termination is unconfirmed: pid=45007, exitCode=0, signalCode=null",
    },
  }]);
});

test("显式 kill 异步回收进程树且并发调用复用同一结果", async () => {
  let terminatedChild: FakeChild | null = null;
  let releaseTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
  let terminateCalls = 0;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-process-tree" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async (child) => {
      terminateCalls += 1;
      terminatedChild = child as unknown as FakeChild;
      await terminationGate;
    },
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;

  const first = workspace.kill();
  const second = workspace.kill();
  let immediateRan = false;
  await new Promise<void>((resolve) => setImmediate(() => {
    immediateRan = true;
    resolve();
  }));

  assert.equal(first, second);
  assert.equal(terminateCalls, 1);
  assert.equal(terminatedChild, child);
  assert.equal(immediateRan, true);
  assert.equal(workspace.isRunning(), true);
  await assert.rejects(workspace.ensureStarted(), /termination is in progress/);

  releaseTermination();
  await first;
  assert.equal(workspace.isRunning(), false);
  assert.equal(child.killCount, 0);
  let startCalls = 0;
  (workspace as any).start = async () => { startCalls += 1; };
  await assert.rejects(workspace.ensureStarted(), /has been released/);
  await assert.rejects(workspace.request("thread/read", {}), /has been released/);
  await assert.rejects(workspace.notify("initialized"), /has been released/);
  await assert.rejects(workspace.respond(1, {}), /has been released/);
  assert.equal(startCalls, 0);
});

test("故障回收中显式 kill 复用终止并永久封存旧 Workspace", async () => {
  let releaseTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
  let terminateCalls = 0;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-fault-release" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async () => {
      terminateCalls += 1;
      await terminationGate;
    },
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_thread_handler_error",
    terminationKind: "error",
  });

  (workspace as any).failWorkspace(processError, {
    child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: true,
  });
  const faultTermination = (workspace as any).termination.promise as Promise<void>;
  const explicitRelease = workspace.kill();
  assert.equal(explicitRelease, faultTermination);
  assert.equal(terminateCalls, 1);

  releaseTermination();
  await explicitRelease;
  await assert.rejects(workspace.ensureStarted(), /has been released/);
});

test("fault handler 同步重入 kill 不递归且只启动一次终止", async () => {
  let releaseTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
  let terminateCalls = 0;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-fault-reentrant-kill" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async () => {
      terminateCalls += 1;
      await terminationGate;
    },
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  let handlerCalls = 0;
  let reentrantTermination: Promise<void> | null = null;
  workspace.registerThread("provider-reentrant", (message) => {
    if ((message as any).method !== "error") return;
    handlerCalls += 1;
    reentrantTermination = workspace.kill();
  });
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_process_error",
    terminationKind: "error",
  });

  (workspace as any).failWorkspace(processError, {
    child,
    processGeneration: 1,
    notifyThreads: true,
    killChild: true,
  });
  const primaryTermination = (workspace as any).termination.promise as Promise<void>;
  assert.equal(reentrantTermination, primaryTermination);
  assert.equal(handlerCalls, 1);
  assert.equal(terminateCalls, 1);

  releaseTermination();
  await primaryTermination;
});

test("故障回收成功后未显式 release 的 Workspace 可以启动下一代", async () => {
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-fault-restart" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async () => undefined,
  });
  const child = createFakeChild();
  const replacement = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_process_error",
    terminationKind: "error",
  });

  (workspace as any).failWorkspace(processError, {
    child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: true,
  });
  await (workspace as any).termination.promise;
  let startCalls = 0;
  (workspace as any).start = async () => {
    startCalls += 1;
    (workspace as any).child = replacement;
    (workspace as any).processGeneration = 2;
  };

  await workspace.ensureStarted();
  assert.equal(startCalls, 1);
  assert.equal(workspace.isRunning(), true);
  assert.equal((workspace as any).processGeneration, 2);
});

test("实际 unexpected close 透传结构化退出事实，隔离旧 child/generation 且重复通知只结算一次", async () => {
  const fixture = createWorkspaceFixture();
  const notifications: any[] = [];
  fixture.workspace.registerThread("provider-thread", message => notifications.push(message));
  (fixture.workspace as any).handleChildClose(createFakeChild(), 1, 1, null);
  (fixture.workspace as any).handleChildClose(fixture.child, 0, 1, null);
  assert.equal(fixture.workspace.isRunning(), true);
  assert.equal(notifications.length, 0);
  const request = fixture.workspace.request("turn/start", {}, { timeoutMs: 2_000 });
  while ((fixture.workspace as any).pending.size === 0) await new Promise<void>(resolve => setImmediate(resolve));
  (fixture.workspace as any).handleChildClose(fixture.child, 1, null, "SIGTERM");
  (fixture.workspace as any).handleChildClose(fixture.child, 1, null, "SIGTERM");
  const processExit = { exitCode: null, signal: "SIGTERM", processGeneration: 1, pid: 42_424 };
  await assert.rejects(request, (error: any) => {
    assert.equal(error.code, "codex_app_server_closed");
    assert.deepEqual(error.processExit, processExit);
    return true;
  });
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0]?.params.error.processExit, processExit);
  assert.equal(notifications[0]?.params.error.processGeneration, 1);
  assert.equal(fixture.processFaults.length, 1);
});

test("显式 kill 的 closed 通知不冒充实际 unexpected close", async () => {
  const fixture = createWorkspaceFixture();
  const notifications: any[] = [];
  fixture.workspace.registerThread("provider-thread", message => notifications.push(message));
  await fixture.workspace.kill();
  (fixture.workspace as any).handleChildClose(fixture.child, 1, 0, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.params.error.code, "codex_app_server_closed");
  assert.equal(notifications[0]?.params.error.processExit, undefined);
});

test("实际 unexpected close 的迟到请求错误副本保留结构化退出事实", async () => {
  const fixture = createWorkspaceFixture();
  const request = fixture.workspace.request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true });
  const error = await request.then(() => assert.fail("未响应请求必须超时"), cause => cause as any);
  assert.equal(error.code, "codex_app_server_request_timeout");
  assert.equal(error.processExit, undefined, "请求超时不能冒充进程退出");
  (fixture.workspace as any).handleChildClose(fixture.child, 1, 1, null);
  const late = await error.lateSettlement;
  assert.equal(late.status, "rejected");
  assert.equal(late.kind, "process_fault");
  assert.deepEqual(late.reason.processExit, { exitCode: 1, signal: null, processGeneration: 1, pid: 42_424 });
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);
});

test("root process 自行退出只失败当前代并允许同一 Client 拉起下一代", async () => {
  const fixture = createWorkspaceFixture();
  const replacement = createFakeChild();
  let threadFaultCount = 0;
  fixture.workspace.registerThread("provider-root-exited", (message) => {
    if ((message as any)?.method === "error") threadFaultCount += 1;
  });

  (fixture.workspace as any).handleChildClose(fixture.child, 1, 1, null);

  assert.equal(fixture.workspace.isRunning(), false);
  assert.equal((fixture.workspace as any).terminationFailure, null);
  assert.equal(threadFaultCount, 1);
  assert.equal(fixture.processFaults[0]?.code, "codex_app_server_closed");

  let startCalls = 0;
  (fixture.workspace as any).start = async () => {
    startCalls += 1;
    (fixture.workspace as any).child = replacement;
    (fixture.workspace as any).processGeneration = 2;
  };
  await fixture.workspace.ensureStarted();

  assert.equal(startCalls, 1);
  assert.equal(fixture.workspace.isRunning(), true);
  assert.equal((fixture.workspace as any).processGeneration, 2);
});

test("故障终止失败时保留旧进程并阻止启动替代进程", async () => {
  let shouldFail = true;
  let terminateCalls = 0;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-process-tree-failure" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async () => {
      terminateCalls += 1;
      if (shouldFail) throw new Error("taskkill failed");
    },
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_thread_handler_error",
    terminationKind: "error",
  });

  (workspace as any).failWorkspace(processError, {
    child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: true,
  });
  await assert.rejects((workspace as any).termination.promise, /process tree termination failed after fault/);

  assert.equal(workspace.isRunning(), true);
  await assert.rejects(workspace.ensureStarted(), /process tree termination failed after fault/);
  shouldFail = false;
  await workspace.kill();
  assert.equal(terminateCalls, 2);
  assert.equal(workspace.isRunning(), false);
});

test("helper 生命周期未确认时，即使原进程退出也保留回收失败门禁", async () => {
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-helper-unconfirmed" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: () => ({
      outcome: Promise.reject(new Error("taskkill timed out")),
      completion: Promise.resolve({ status: "failed", error: new Error("taskkillHelperLifecycle=unconfirmed") }),
    }),
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;

  await assert.rejects(workspace.kill(), /process tree termination failed/);
  child.exitCode = 1;
  (workspace as any).handleChildClose(child, 1, 1, null);

  assert.equal(workspace.isReleaseComplete(), false);
  await assert.rejects(workspace.ensureStarted(), /process tree termination failed/);
});

test("终止失败向会话返回根因和显式重启指引，并保留可追踪的故障标识", async () => {
  const faults: any[] = [];
  const rootCause = new Error("taskkill did not confirm process tree termination: code=128");
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-termination-diagnostics" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: async () => { throw rootCause; },
    onProcessFault: (fault) => faults.push(fault),
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 7;

  await assert.rejects(workspace.kill(), (error: any) => {
    assert.equal(error.code, "codex_app_server_process_tree_termination_failed");
    assert.equal(error.cause, rootCause);
    assert.match(error.message, /code=128/);
    assert.match(error.message, /重启 Codex/);
    assert.equal(error.requestId, "codex-app-server:42424:7:termination");
    assert.equal(error.processGeneration, 7);
    assert.equal(error.terminationKind, "error");
    return true;
  });
  await assert.rejects(workspace.ensureStarted(), /code=128/);
  assert.equal(workspace.isRunning(), true);
  assert.equal(faults.length, 1);
  assert.equal(faults[0].requestId, "codex-app-server:42424:7:termination");
  assert.equal(faults[0].message.match(/code=128/g)?.length, 1);
});

test("故障终止失败由结构化回调收口且不产生 unhandled rejection", async () => {
  const faults: any[] = [];
  let rejectTermination!: (error: Error) => void;
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-fault-termination-log" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    onProcessFault: (fault) => faults.push(fault),
    terminateProcessTree: () => new Promise<void>((_resolve, reject) => {
      rejectTermination = reject;
    }),
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_thread_handler_error",
    terminationKind: "error",
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    (workspace as any).failWorkspace(processError, {
      child,
      processGeneration: 1,
      notifyThreads: false,
      killChild: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    rejectTermination(new Error("taskkill failed"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(faults[0]?.code, "codex_app_server_thread_handler_error");
    assert.equal(faults[1]?.code, "codex_app_server_process_tree_termination_failed");
    assert.match(faults[1]?.message ?? "", /taskkill failed/);
    assert.equal(workspace.isRunning(), true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("taskkill 超时后的非零 close 保留权威失败上下文并允许重试", async () => {
  const helper = createTaskkillHelper();
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-taskkill-late-failure" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: (child) => terminateCodexProcessTree(child, {
      platform: "win32",
      systemRoot: "C:/Windows",
      spawnProcess: (() => helper) as any,
      timeoutMs: 10,
      stopGraceMs: 10,
    }),
  });
  const child = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const keepAlive = setTimeout(() => undefined, 1_000);

  try {
    await assert.rejects(workspace.kill(), (error: any) => /timed out/.test(String(error?.cause?.message)));
    assert.notEqual((workspace as any).termination, null);
    helper.stderr.write("tree termination denied");
    helper.exitCode = 1;
    helper.emit("close", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((workspace as any).termination, null);
    assert.equal((workspace as any).child, child);
    const finalCause = String((workspace as any).terminationFailure?.cause?.message ?? "");
    assert.match(finalCause, /code=1/);
    assert.match(finalCause, /tree termination denied/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("旧终止 outcome 迟到失败不污染已重建的 Workspace", async () => {
  let rejectOutcome!: (error: Error) => void;
  let resolveCompletion!: (value: { status: "confirmed" }) => void;
  const outcome = new Promise<void>((_resolve, reject) => { rejectOutcome = reject; });
  const completion = new Promise<{ status: "confirmed" }>((resolve) => { resolveCompletion = resolve; });
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog, localThreadId: "test-thread",
    workspaceId: "client-test:ws-codex-stale-outcome" as WorkspaceId,
    workspacePath: "Z:/code/aidt-code",
    clientInfo: { name: "codeflowai-test", title: "CodeFlow Test", version: "0.0.0" },
    terminateProcessTree: () => ({ outcome, completion }),
  });
  const child = createFakeChild();
  const replacement = createFakeChild();
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const processError = Object.assign(new Error("app-server protocol fault"), {
    code: "codex_app_server_process_error",
    terminationKind: "error",
  });

  (workspace as any).failWorkspace(processError, {
    child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: true,
  });
  resolveCompletion({ status: "confirmed" });
  await (workspace as any).termination.promise;
  (workspace as any).child = replacement;
  (workspace as any).processGeneration = 2;

  rejectOutcome(new Error("stale timeout"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((workspace as any).terminationFailure, null);
  assert.equal((workspace as any).child, replacement);
});

test("副作用 request 超时后仍交付迟到成功响应", async () => {
  const fixture = createWorkspaceFixture();
  const timeoutError = await fixture.workspace
    .request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true })
    .then(() => null, (error) => error as any);

  assert.equal(timeoutError?.code, "codex_app_server_request_timeout");
  assert.equal(timeoutError?.method, "turn/start");
  assert.equal(typeof timeoutError?.lateSettlement?.then, "function");
  assert.equal((fixture.workspace as any).timedOutPending.size, 1);

  (fixture.workspace as any).onStdoutLine(JSON.stringify({ id: timeoutError.requestId, result: { turn: { id: "turn-late" } } }));
  assert.deepEqual(await timeoutError.lateSettlement, {
    status: "fulfilled",
    value: { turn: { id: "turn-late" } },
  });
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);
});

test("副作用 request 的迟到追踪可在权威收口后显式释放", async () => {
  const fixture = createWorkspaceFixture();
  const timeoutError = await fixture.workspace
    .request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true })
    .then(() => null, (error) => error as any);

  assert.equal((fixture.workspace as any).timedOutPending.size, 1);
  assert.equal(typeof timeoutError?.releaseLateSettlement, "function");
  timeoutError.releaseLateSettlement();
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);

  (fixture.workspace as any).onStdoutLine(JSON.stringify({
    id: timeoutError.requestId,
    result: { turn: { id: "turn-released" } },
  }));
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);
});

test("副作用 request 的迟到错误和进程故障都会显式完成结算", async () => {
  const lateErrorFixture = createWorkspaceFixture();
  const lateError = await lateErrorFixture.workspace
    .request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true })
    .then(() => null, (error) => error as any);
  (lateErrorFixture.workspace as any).onStdoutLine(JSON.stringify({
    id: lateError.requestId,
    error: { message: "turn rejected after timeout" },
  }));
  const rejected = await lateError.lateSettlement;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.kind, "rpc_error");
  assert.match(rejected.reason.message, /turn rejected after timeout/);
  assert.equal((rejected.reason as any).rpcError, true);
  assert.equal((rejected.reason as any).method, "turn/start");
  assert.equal((rejected.reason as any).requestId, lateError.requestId);

  const faultFixture = createWorkspaceFixture();
  const faultTimeout = await faultFixture.workspace
    .request("turn/start", {}, { timeoutMs: 500, trackLateSettlement: true })
    .then(() => null, (error) => error as any);
  const processError = Object.assign(new Error("app-server closed"), {
    code: "codex_app_server_closed",
    terminationKind: "error",
  });
  (faultFixture.workspace as any).failWorkspace(processError, {
    child: faultFixture.child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: false,
  });
  const faulted = await faultTimeout.lateSettlement;
  assert.equal(faulted.status, "rejected");
  assert.equal(faulted.kind, "process_fault");
  assert.match(faulted.reason.message, /app-server closed/);
  assert.equal((faultFixture.workspace as any).timedOutPending.size, 0);
});

test("pending turn/start 遇进程故障时携带请求级 unknown 标记", async () => {
  const fixture = createWorkspaceFixture();
  const pendingStart = fixture.workspace.request("turn/start", {}, {
    timeoutMs: 2_000,
    trackLateSettlement: true,
  });
  while ((fixture.workspace as any).pending.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const processError = Object.assign(new Error("app-server closed before response"), {
    code: "codex_app_server_closed",
    terminationKind: "error",
  });
  (fixture.workspace as any).failWorkspace(processError, {
    child: fixture.child,
    processGeneration: 1,
    notifyThreads: false,
    killChild: false,
  });

  await assert.rejects(pendingStart, (error: any) => {
    assert.equal(error?.code, "codex_app_server_closed");
    assert.equal(error?.method, "turn/start");
    assert.equal(error?.requestId, 1);
    assert.equal(error?.processGeneration, 1);
    assert.equal(error?.requestOutcomeUnknown, true);
    return true;
  });
  assert.equal((fixture.workspace as any).pending.size, 0);
  assert.equal((fixture.workspace as any).timedOutPending.size, 0);
});

test("initialize 超时仍终止当前代 app-server 并广播进程故障", async () => {
  const fixture = createWorkspaceFixture();
  let threadFaultCount = 0;
  fixture.workspace.registerThread("provider-thread-2", () => {
    threadFaultCount += 1;
  });

  const initialize = fixture.workspace.request("initialize", {}, { timeoutMs: 500 });
  const sibling = fixture.workspace.request("thread/read", {}, { timeoutMs: 2_000 });
  const [initializeResult, siblingResult] = await Promise.allSettled([initialize, sibling]);
  await (fixture.workspace as any).termination?.promise;

  assert.equal(initializeResult.status, "rejected");
  assert.equal((initializeResult as PromiseRejectedResult).reason?.code, "codex_app_server_request_timeout");
  assert.equal(siblingResult.status, "rejected");
  assert.equal((siblingResult as PromiseRejectedResult).reason?.code, "codex_app_server_request_timeout");
  assert.equal(fixture.child.killCount, 1);
  assert.equal(fixture.workspace.isRunning(), false);
  assert.equal(threadFaultCount, 1);
  assert.equal(fixture.processFaults.length, 1);
});

test("旧代 initialize 定时器不得终止已替换的新 app-server", async () => {
  const fixture = createWorkspaceFixture();
  let threadFaultCount = 0;
  fixture.workspace.registerThread("provider-thread-3", () => {
    threadFaultCount += 1;
  });
  const staleInitialize = fixture.workspace.request("initialize", {}, { timeoutMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const replacement = createFakeChild();
  (fixture.workspace as any).child = replacement;
  (fixture.workspace as any).processGeneration = 2;
  await assert.rejects(staleInitialize, /Codex app-server request timeout: initialize/);

  assert.equal(fixture.child.killCount, 0);
  assert.equal(replacement.killCount, 0);
  assert.equal(fixture.workspace.isRunning(), true);
  assert.equal(threadFaultCount, 0);
  assert.equal(fixture.processFaults.length, 0);
});

test("thread handler 异常只故障化当前 workspace，不逃出 stdout 分发", async () => {
  const fixture = createWorkspaceFixture();
  let failingHandlerCalls = 0;
  let siblingFaultCount = 0;
  fixture.workspace.registerThread("provider-thread-failing", () => {
    failingHandlerCalls += 1;
    throw new Error("provider turn binding conflict");
  });
  fixture.workspace.registerThread("provider-thread-sibling", (message) => {
    if ((message as any)?.method === "error") siblingFaultCount += 1;
  });

  assert.doesNotThrow(() => {
    (fixture.workspace as any).onStdoutLine(JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-thread-failing", turn: { id: "provider-turn" } },
    }));
  });
  await assert.rejects((fixture.workspace as any).termination.promise, /引擎工作区诊断或固定日志失败/);

  assert.equal(fixture.child.killCount, 1);
  assert.equal(fixture.workspace.isRunning(), false);
  assert.equal(failingHandlerCalls, 2);
  assert.equal(siblingFaultCount, 1);
  assert.equal(fixture.processFaults[0]?.code, "codex_app_server_thread_handler_error");
  assert.equal(fixture.processFaults[0]?.method, "turn/started");
  assert.match(fixture.processFaults[0]?.message ?? "", /threadId=provider-thread-failing/);
  assert.match(fixture.processFaults[0]?.message ?? "", /method=turn\/started/);
});
