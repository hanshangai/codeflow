import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import { ClaudeThreadSession } from "../../apps/desktop/client/src/engines/claude/claudeThreadSession.ts";
import { testEngineWorkspaceLog } from "../../apps/desktop/client/tests/engine-workspace-log-fixture.ts";
import { ActiveTurnInputClosedError } from "../../apps/desktop/client/src/engines/threadSession.ts";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION } from "../../packages/shared/src/index.ts";

test.before(() => applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 0, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] }));
test.after(() => resetEngineModelCatalogRuntimeForTest());

/** 排空测试自有资源并保全全部收尾错误，不覆盖测试本身已报告的断言。 */
async function cleanupResources(actions: Array<() => void | Promise<unknown>>): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Claude fixture cleanup failed", { cause: errors[0] });
}

/** 收集业务日志供断言；本夹具不并发驱动真实文件 logger 的启动 flush。 */
function captureFixtureLogs(t: test.TestContext) {
  const logs: Array<{ level: string; tag: string; message: string; data: unknown }> = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    t.mock.method(logger, level, (tag: string, message: string, data?: unknown) => { logs.push({ level, tag, message, data }); });
  }
  return logs;
}

/** 用真实 session 和内存管道验证 stdin 生命周期，不启动 CLI 或网络请求。 */
async function harness(t: test.TestContext, opts?: { planMode?: boolean; accessMode?: "current" | "read-only" | "full-access" }) {
  const logs = captureFixtureLogs(t);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { child.emit("close", 0, null); return true; },
  });
  const spawnMock = t.mock.method(childProcess, "spawn", () => child as any);
  syncBuiltinESMExports();
  const writes: any[] = [];
  child.stdin.on("data", chunk => { for (const line of String(chunk).trim().split("\n")) writes.push(JSON.parse(line)); });
  const events: any[] = [];
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: process.cwd(), workspaceId: "test:workspace" as any, threadId: "test-thread", initialSessionId: null,
    onEngineProcessSnapshot: () => false, onSessionId() {},
    resolveModelProvider: () => "anthropic", readProviderCredentials: () => null, hasConfiguredProviderCredentials: () => false,
  });
  const done = session.sendMessage({
    turnId: "test-turn" as any, userItemId: "user-1" as any, text: "review", images: [],
    assistantItemId: "assistant-1", reasoningItemId: "reasoning-1",
    accessMode: opts?.accessMode ?? "full-access", planMode: opts?.planMode ?? false,
    model: "claude-sonnet-5",
  }, { conversation: event => events.push(event), raw() {} });
  // Capture early setup failures and wait for stdout listeners, not merely spawn.
  let failure: { error: unknown } | undefined;
  let expectedFailure: ((error: unknown) => boolean) | undefined;
  const observed = done.then(() => ({ ok: true as const }), error => { failure = { error }; return { ok: false as const, error: error as unknown }; });
  t.after(async () => {
    child.emit("close", 0, null);
    const outcome = await observed;
    await cleanupResources([
      () => { if (!outcome.ok) assert.ok(expectedFailure?.(outcome.error), `unexpected send failure: ${String(outcome.error)}`); },
      () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
      () => { spawnMock.mock.restore(); syncBuiltinESMExports(); },
    ]);
  });
  for (let i = 0; !child.stdout.listenerCount("data") && i < 100; i++) {
    await nextTick();
    if (failure) throw failure.error;
  }
  assert.equal(spawnMock.mock.callCount(), 1);
  assert.ok((spawnMock.mock.calls[0]?.arguments[1] as string[]).includes("--replay-user-messages"));
  assert.ok(child.stdout.listenerCount("data"));
  return { child, session, writes, events, logs, done, expectFailure: (predicate: (error: unknown) => boolean) => { expectedFailure = predicate; }, emit: (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`) };
}

const started = (id: string, extra = {}) => ({ type: "system", subtype: "task_started", task_id: id, task_type: "local_agent", is_backgrounded: true, ...extra });
const notified = (id: string, extra = {}) => ({ type: "system", subtype: "task_notification", task_id: id, status: "completed", ...extra });
const result = (index: number, extra = {}) => ({ type: "result", subtype: "success", result: "done", result_index: index, queued_turn_count: 0, terminal_reason: "completed", ...extra });
const notificationResult = (index: number) => result(index, { origin: { kind: "task-notification" } });

test("Claude stdout普通日志失败只告警，回合继续完成并可正常释放", async t => {
  const h = await harness(t), original = new Error("STDOUT_LOG_FAILED"), info = logger.info;
  t.mock.method(logger, "info", (...args: Parameters<typeof logger.info>) => {
    if (String(args[1]).startsWith("control_request received")) throw original;
    return info(...args);
  });
  assert.doesNotThrow(() => h.emit({ type: "control_request", request_id: "control", request: {
    subtype: "can_use_tool", tool_name: "Read", input: { path: "file.ts" },
  } }));
  await nextTick();
  h.emit(result(0));
  await nextTick();
  h.child.emit("close", 0, null);
  await h.done;
  assert.equal(h.session.hasActiveTurn(), false);
  assert.equal(h.session.canIdleDispose(), true);
  await h.session.dispose();
  assert.ok(h.logs.some(entry => (entry.data as { code?: string })?.code === "ENGINE_WORKSPACE_LOG_DEGRADED"));
});

test("Claude追加输入写入失败保持原业务对象，诊断失败只告警", async t => {
  const h = await harness(t), primary = new Error("APPEND_PRIMARY"), log = logger.error;
  h.expectFailure(error => error instanceof Error && (error as Error & { code?: string }).code === "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT");
  t.mock.method(h.child.stdin, "write", (...args: unknown[]) => {
    (args.at(-1) as (error: Error) => void)(primary);
    return false;
  });
  t.mock.method(logger, "error", (...args: Parameters<typeof logger.error>) => {
    if (args[1] === "appendInput stream-json write failed") throw 0;
    return log(...args);
  });
  await assert.rejects(h.session.appendInput({ turnId: "test-turn", text: "followup", userItemId: "next", images: [] } as any), error => {
    const queue: unknown[] = [error]; let business = false;
    while (queue.length) {
      const value = queue.shift();
      business ||= value === primary;
      if (value instanceof AggregateError) queue.push(...value.errors);
      if (value instanceof Error && "cause" in value) queue.push(value.cause);
    }
    return business;
  });
});

/** 回放 CLI 对指定追加输入的原生 UUID 确认，不把本地 write ACK 当作执行完成。 */
function acknowledgeInput(h: Awaited<ReturnType<typeof harness>>, index: number): void {
  const input = h.writes.filter(message => message.type === "user" && message.uuid)[index];
  assert.ok(input?.uuid);
  h.emit({ ...input, isReplay: true, parent_tool_use_id: null });
}

/** stdout 由生产端以 setImmediate 分批消费，断言前需等待批次排空。 */
async function flushStdout(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await nextTick();
}

async function ask(h: Awaited<ReturnType<typeof harness>>, id = "ask") {
  const input = { questions: [{ question: "使用该方案？", header: "方案", options: [{ label: "同意", description: "执行" }], multiSelect: false }] };
  h.emit({ type: "assistant", message: { id: `${id}-message`, content: [{ type: "tool_use", id: `${id}-tool`, name: "AskUserQuestion", input }] } });
  h.emit({ type: "control_request", request_id: `${id}-control`, request: { subtype: "can_use_tool", tool_use_id: `${id}-tool`, tool_name: "AskUserQuestion", input } });
  for (let index = 0; index < 100; index += 1) {
    const request = h.events.filter(event => event.type === "userInput.requested").at(-1)?.payload.request;
    if (request) {
      // control_request 可能仍在后续批次，先排空再允许调用方回写。
      await flushStdout();
      return request;
    }
    await nextTick();
  }
  assert.fail("AskUserQuestion request was not emitted");
}

/** 保留首次 write 回调，使用 argv 中的真实提示路径观察早期事件。 */
async function promptHarness(t: test.TestContext, bridge = false, executeHostTool?: () => Promise<any>) {
  const logs = captureFixtureLogs(t);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-prompt-lifecycle-"));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true,
  });
  // 受控 child 保留 error 通道，让缺失生产监听体现为业务断言失败。
  child.on("error", () => {});
  let confirmWrite: ((error?: Error | null) => void) | undefined;
  let writeStarted!: () => void;
  const writing = new Promise<void>(resolve => { writeStarted = resolve; });
  t.mock.method(child.stdin, "write", (...args: unknown[]) => {
    confirmWrite = args.at(-1) as (error?: Error | null) => void;
    writeStarted();
    return true;
  });
  t.mock.method(os, "tmpdir", () => root);
  const spawnMock = t.mock.method(childProcess, "spawn", () => child as any);
  const servers: http.Server[] = [];
  const createServer = http.createServer;
  t.mock.method(http, "createServer", (...args: Parameters<typeof http.createServer>) => {
    const server = createServer(...args); servers.push(server); return server;
  });
  syncBuiltinESMExports();
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: root, workspaceId: "ws_prompt_lifecycle", threadId: "th_prompt_lifecycle", initialSessionId: null,
    onEngineProcessSnapshot: () => false, onSessionId() {},
    resolveModelProvider: () => "anthropic", readProviderCredentials: () => null, hasConfiguredProviderCredentials: () => false,
  });
  let settled = false;
  const input = {
    turnId: "turn_prompt_lifecycle", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "test", images: [], model: "claude-sonnet-5", systemMessage: "真实私有提示正文",
    ...(bridge ? { toolRegistry: { tools: [{ toolsetId: "tools", toolsetName: "Tools", toolId: "test", name: "Test", description: "test", runtime: "node" as const, code: "", permissions: { requiresWrite: false } }] }, executeHostTool: executeHostTool ?? (async () => { throw new Error("must not execute"); }) } : {}),
  };
  const send = () => session.sendMessage(input, { conversation() {}, raw() {} });
  const done = send();
  const outcome = done.then(value => { settled = true; return { ok: true as const, value }; }, error => { settled = true; return { ok: false as const, error: error as unknown }; });
  t.after(async () => {
    confirmWrite?.();
    child.emit("close", 0, null);
    await outcome;
    await cleanupResources([
      () => { t.mock.restoreAll(); syncBuiltinESMExports(); captureFixtureLogs(t); },
      () => session.dispose(),
      () => { for (const server of servers) assert.equal(server.listening, false, "本次 bridge 必须已关闭"); },
      () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
      () => fsp.rmdir(root),
    ]);
  });
  await Promise.race([writing, outcome.then(value => { assert.fail(`send ended before write: ${String(value.ok)}`); })]);
  assert.ok(confirmWrite, "公开 send 必须到达 initial stdin");
  const args = spawnMock.mock.calls[0]!.arguments[1] as string[];
  const promptPath = args[args.indexOf("--append-system-prompt-file") + 1]!;
  assert.equal(await fsp.readFile(promptPath, "utf8"), "真实私有提示正文");
  return { root, child, session, outcome, promptPath, logs, confirmWrite: confirmWrite!, send, servers, spawnMock, isSettled: () => settled,
    emit: (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`) };
}

test("平台工具致命回调保留kill失败，诊断只告警且HTTP保留原业务失败", async t => {
  const h = await promptHarness(t, true, async () => ({ ok: false, code: "KNOWLEDGE_ASSET_READ_LIMIT_REACHED", message: "limit" }));
  h.confirmWrite();
  for (let index = 0; !h.child.stdout.listenerCount("data") && index < 100; index++) await nextTick();
  assert.ok(h.child.stdout.listenerCount("data"));
  t.mock.method(h.child, "kill", () => { throw 0; });
  const warn = logger.warn;
  t.mock.method(logger, "warn", (...args: Parameters<typeof logger.warn>) => {
    if (args[1] === "failed to kill child after platform tool fatal error") throw false;
    return warn(...args);
  });
  const args = h.spawnMock.mock.calls[0]!.arguments[1] as string[];
  const config = JSON.parse(await fsp.readFile(args[args.indexOf("--mcp-config") + 1]!, "utf8"));
  const env = (Object.values(config.mcpServers)[0] as any).env;
  const registry = JSON.parse(await fsp.readFile(env.CODEFLOWAI_PLATFORM_TOOLS_REGISTRY_PATH, "utf8"));
  const response = await fetch(`${env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_URL}/call`, { method: "POST",
    headers: { authorization: `Bearer ${env.CODEFLOWAI_PLATFORM_TOOLS_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: registry.tools[0].name, arguments: {} }) });
  const result = await response.json() as { code: string };
  h.child.emit("close", 1, null);
  const outcome = await h.outcome;
  assert.equal(result.code, "KNOWLEDGE_ASSET_READ_LIMIT_REACHED");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error instanceof AggregateError);
  const errors = !outcome.ok && (outcome.error as AggregateError).errors;
  assert.ok(Array.isArray(errors) && errors.includes(0));
  assert.ok(h.logs.some(entry => (entry.data as { code?: string })?.code === "ENGINE_WORKSPACE_LOG_DEGRADED"));
  await assert.rejects(h.session.dispose(), error => !outcome.ok && error === outcome.error);
});

/** 有界观察真实发送结果，并清除测试自身的超时句柄。 */
async function waitForPromptSettlement(outcome: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([outcome, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("prompt release remembers close before initial stdin acknowledgment", async t => {
  const h = await promptHarness(t);
  h.child.emit("close", 0, null);
  assert.equal(await fsp.readFile(h.promptPath, "utf8"), "真实私有提示正文");
  h.confirmWrite();
  await waitForPromptSettlement(h.outcome);
  assert.equal(h.isSettled(), true, "已经发生的真实 close 不得被后置监听遗漏");
  const outcome = await h.outcome;
  assert.equal(outcome.ok, false);
  assert.deepEqual(await fsp.readdir(h.root), []);
});

test("prompt release preserves early child error before initial stdin acknowledgment", async t => {
  const h = await promptHarness(t);
  const primary = Object.freeze(new Error("early-child-primary"));
  h.child.emit("error", primary);
  assert.equal(await fsp.readFile(h.promptPath, "utf8"), "真实私有提示正文");
  h.child.emit("close", 1, null);
  h.confirmWrite();
  await waitForPromptSettlement(h.outcome);
  assert.equal(h.isSettled(), true, "早期 error/close 必须完成原发送");
  const outcome = await h.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error, primary);
  const failureLog = h.logs.find(log => log.level === "error")?.data as Record<string, unknown>;
  assert.equal(failureLog.workspaceId, "ws_prompt_lifecycle");
  assert.equal(failureLog.threadId, "th_prompt_lifecycle");
  assert.equal(failureLog.turnId, "turn_prompt_lifecycle");
  assert.match(String(failureLog.requestId), /^claude-prompt:/);
  assert.deepEqual(failureLog.rootCause, { kind: "Error" });
  assert.doesNotMatch(JSON.stringify(failureLog), /early-child-primary|真实私有提示正文/);
  assert.deepEqual(await fsp.readdir(h.root), []);
});

test("prompt release keeps final-result files until real close and restores idle only after explicit disposal", async t => {
  const h = await promptHarness(t);
  h.confirmWrite();
  for (let i = 0; !h.child.stdout.listenerCount("data") && i < 100; i++) await nextTick();
  h.emit(result(0));
  assert.equal(h.isSettled(), false);
  assert.equal(h.session.canIdleDispose(), false);
  assert.equal(await fsp.readFile(h.promptPath, "utf8"), "真实私有提示正文");
  h.child.emit("close", 0, null);
  assert.equal((await h.outcome).ok, true);
  assert.equal(h.session.canIdleDispose(), true);
  assert.deepEqual(await fsp.readdir(h.root), []);
});

test("prompt close logging failure cannot prevent file or real bridge disposal", async t => {
  const h = await promptHarness(t, true);
  const loggingCause = Object.freeze(new Error("private-close-log-cause"));
  const info = logger.info;
  t.mock.method(logger, "info", (...args: Parameters<typeof logger.info>) => {
    if (String(args[1]).startsWith("child exited")) throw loggingCause;
    return info(...args);
  });
  h.confirmWrite();
  for (let i = 0; !h.child.stdout.listenerCount("data") && i < 100; i++) await nextTick();
  assert.ok(h.child.stdout.listenerCount("data"));
  h.emit(result(0));
  h.child.emit("close", 0, null);
  const outcome = await h.outcome;
  assert.equal(outcome.ok, true);
  assert.equal(h.servers[0]!.listening, false);
  assert.deepEqual(await fsp.readdir(h.root), []);
});

test("explicit prompt disposal keeps the existing manual interrupt result for an active turn", async t => {
  usePosixSignals(t);
  const h = await promptHarness(t, true);
  h.confirmWrite();
  for (let i = 0; !h.child.stdout.listenerCount("data") && i < 100; i++) await nextTick();
  assert.ok(h.child.stdout.listenerCount("data"));
  t.mock.method(h.child, "kill", () => { h.child.emit("close", null, "SIGTERM"); return true; });
  await h.session.dispose();
  const outcome = await h.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal((outcome.error as { code: string }).code, "turn_interrupted");
  assert.equal(h.session.canIdleDispose(), true);
  assert.deepEqual(await fsp.readdir(h.root), []);
  assert.equal(h.servers[0]!.listening, false);
});

test("prompt failure still preserves original bridge disposal Error after stopping its listener", async t => {
  const h = await promptHarness(t, true);
  const primary = Object.freeze(new Error("private-child-primary"));
  const promptCause = Object.freeze(new Error("private-prompt-unlink"));
  const bridgeCause = Object.freeze(new Error("private-bridge-delete"));
  const unlink = t.mock.method(fsp, "unlink", async () => { throw promptCause; });
  let retainedBridge = "";
  const bridgeRemove = t.mock.method(fsp, "rm", async (...args: Parameters<typeof fsp.rm>) => {
    retainedBridge = String(args[0]); throw bridgeCause;
  });
  h.child.emit("error", primary);
  h.child.emit("close", 1, null);
  h.confirmWrite();
  const outcome = await h.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof AggregateError);
    assert.deepEqual(outcome.error.errors, [primary, promptCause, bridgeCause]);
    assert.equal(outcome.error.cause, primary);
  }
  assert.equal(h.servers[0]!.listening, false);
  unlink.mock.restore(); bridgeRemove.mock.restore();
  // 原 bridge helper 不保 owner，本例仅显式移除它的两个固定自有夹具文件。
  assert.deepEqual((await fsp.readdir(retainedBridge)).sort(), ["mcp.json", "registry.json"]);
  await fsp.unlink(path.join(retainedBridge, "mcp.json"));
  await fsp.unlink(path.join(retainedBridge, "registry.json"));
  await fsp.rmdir(retainedBridge);
  await h.session.dispose();
  assert.deepEqual(await fsp.readdir(h.root), []);
});

for (const stop of ["false", "throw"] as const) {
  test(`prompt release bounds unknown close once and preserves stop ${stop} with frozen stdin cause`, async t => {
    const h = await promptHarness(t, true);
    const cause = Object.freeze(new Error("frozen-private-stdin"));
    const stopCause = Object.freeze(new Error("stop-private-cause"));
    const kill = t.mock.method(h.child, "kill", () => { if (stop === "throw") throw stopCause; return false; });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    h.confirmWrite(cause);
    await nextTick();
    const disposing = h.session.dispose().then(() => ({ ok: true as const }), error => ({ ok: false as const, error: error as unknown }));
    h.child.emit("exit", 1, null);
    t.mock.timers.tick(4_999);
    await nextTick();
    assert.equal(h.isSettled(), false);
    assert.equal(await fsp.readFile(h.promptPath, "utf8"), "真实私有提示正文");
    t.mock.timers.tick(1);
    const outcome = await h.outcome;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof AggregateError);
      assert.equal((outcome.error as AggregateError & { requestOutcomeUnknown: boolean; retryable: boolean }).requestOutcomeUnknown, true);
      assert.equal((outcome.error as AggregateError & { retryable: boolean }).retryable, false);
      const primary = outcome.error.errors[0] as Error & { requestOutcomeUnknown: boolean };
      assert.equal(primary.cause, cause);
      assert.equal(primary.requestOutcomeUnknown, true);
      const cleanup = outcome.error.errors[1] as AggregateError & { code: string; retryable: boolean };
      assert.equal(cleanup.code, "CLAUDE_PROMPT_CLOSE_UNCONFIRMED");
      assert.equal(cleanup.retryable, false);
      if (stop === "throw") assert.equal(cleanup.errors[1], stopCause);
    }
    assert.equal((await disposing).ok, false);
    assert.equal(kill.mock.callCount(), 1);
    assert.equal(h.session.canIdleDispose(), false);
    assert.equal(h.servers[0]!.listening, false);
    await assert.rejects(h.send(), { code: "CLAUDE_PROMPT_RELEASE_PENDING" });
    h.child.emit("close", 1, null);
    await nextTick();
    assert.equal(h.session.canIdleDispose(), false, "迟到 close 不得自动清理或恢复 idle");
    assert.equal(await fsp.readFile(h.promptPath, "utf8"), "真实私有提示正文");
    await h.session.dispose();
    assert.equal(h.session.canIdleDispose(), true);
    assert.deepEqual(await fsp.readdir(h.root), []);
  });
}

for (const primary of [null, undefined, false]) {
  test(`prompt release preserves falsy child error ${String(primary)} and unlink failure while logging only warns`, async t => {
    const h = await promptHarness(t, true);
    const unlinkCause = Object.freeze(new Error("unlink-private-cause")), logCause = Object.freeze(new Error("log-private-cause"));
    const unlink = t.mock.method(fsp, "unlink", async () => { throw unlinkCause; });
    const log = t.mock.method(logger, "error", () => { throw logCause; });
    h.child.emit("error", primary);
    h.child.emit("close", 1, null);
    h.confirmWrite();
    const outcome = await h.outcome;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof AggregateError);
      assert.deepEqual(outcome.error.errors, [primary, unlinkCause]);
      assert.equal(outcome.error.cause, primary);
    }
    assert.equal(h.servers[0]!.listening, false);
    assert.equal(h.session.canIdleDispose(), false);
    unlink.mock.restore(); log.mock.restore();
    await h.session.dispose();
    assert.deepEqual(await fsp.readdir(h.root), []);
  });
}

/** 保留 POSIX 信号升级合同；Windows 的真实进程树回收由专门回归覆盖。 */
function usePosixSignals(t: test.TestContext): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", original));
}

test("POSIX manual interrupt waits for Claude close before acknowledging success", async t => {
  usePosixSignals(t);
  const h = await harness(t);
  h.expectFailure(error => (error as { code?: string }).code === "turn_interrupted");
  const kill = t.mock.method(h.child, "kill", () => true);
  let acknowledged = false;
  const stopping = h.session.interrupt("test-turn" as any).then((stopped) => {
    acknowledged = true;
    return stopped;
  });

  await nextTick();
  assert.equal(kill.mock.callCount(), 1);
  assert.equal(acknowledged, false, "SIGTERM 已发出不等于进程已退出");
  assert.equal(h.session.hasActiveTurn(), true);
  assert.equal(h.session.canAppendInput(), false, "中断中的回合不能继续接收输入");

  h.child.emit("close", null, "SIGTERM");
  assert.equal(await stopping, true);
  assert.equal(h.session.hasActiveTurn(), false);
});

test("POSIX manual interrupt escalates once and rejects success if Claude never closes", async t => {
  usePosixSignals(t);
  const h = await harness(t);
  h.expectFailure(error => (error as { code?: string }).code === "turn_interrupted");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kill = t.mock.method(h.child, "kill", () => true);
  const stopping = h.session.interrupt("test-turn" as any);

  await nextTick();
  t.mock.timers.tick(3_001);
  await nextTick();
  assert.equal(kill.mock.callCount(), 2);
  assert.equal((kill.mock.calls[1] as any)?.arguments?.[0], "SIGKILL");

  t.mock.timers.tick(3_001);
  await assert.rejects(stopping, (error: any) => error?.code === "claude_interrupt_unconfirmed");
  assert.equal(h.session.hasActiveTurn(), true, "未确认退出时不能伪造已停止");
});

test("ds replay: intermediate result keeps confirmation pipe writable through both background notifications", async t => {
  const h = await harness(t);
  h.emit(started("agent-a")); h.emit(started("agent-b"));
  h.emit(result(0));
  assert.equal(h.child.stdin.writableEnded, false, "first result must not close the permission channel");
  h.emit(notified("agent-b")); h.emit(notified("agent-a"));
  const request = await ask(h);
  await h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } });
  assert.equal(h.writes.at(-1).response.request_id, "ask-control");
  assert.deepEqual(h.writes.at(-1).response.response.updatedInput.answers, { "使用该方案？": "同意" });
  h.emit({ type: "control_request", request_id: "plan-control", request: { subtype: "can_use_tool", tool_use_id: "plan-tool", tool_name: "ExitPlanMode", input: { plan: "实施方案" } } });
  await flushStdout();
  await h.session.respondApproval("plan-control", "accept");
  assert.equal(h.writes.at(-1).response.request_id, "plan-control");
  h.emit(notificationResult(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false, "one notification result cannot finish two notification turns");
  h.emit(notificationResult(2));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
  h.child.emit("close", 0, null);
  await h.done;
});

test("nested result cannot close the root conversation", async t => {
  const h = await harness(t);
  h.emit(result(0, { parent_tool_use_id: "parent-agent" }));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("ordinary final result still closes stdin with a long-running background shell", async t => {
  const h = await harness(t);
  h.emit(started("server", { task_type: "local_bash" }));
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("duplicate notifications and result replays neither close early nor keep stdin stuck", async t => {
  const h = await harness(t);
  h.emit(started("a")); h.emit(started("b")); h.emit(result(0));
  h.emit(notified("a")); h.emit(notified("a")); h.emit(notified("b"));
  h.emit(started("a")); // A late start cannot revive a completed task.
  h.emit(notificationResult(1)); h.emit(notificationResult(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(notificationResult(2));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("modern Claude aggregate root result closes after task notifications without per-notification results", async t => {
  const h = await harness(t);
  h.emit({ type: "system", subtype: "background_tasks_changed" });
  h.emit(started("agent-a")); h.emit(started("agent-b"));
  h.emit({ type: "system", subtype: "task_updated", task_id: "agent-a", status: "completed" });
  h.emit({ type: "system", subtype: "task_updated", task_id: "agent-b", status: "completed" });
  h.emit(notified("agent-a")); h.emit(notified("agent-b"));
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("legacy result waits for background completion without requiring modern origin metadata", async t => {
  const h = await harness(t);
  h.emit(started("a", { is_backgrounded: undefined }));
  const legacy = { type: "result", subtype: "success", result: "done" };
  h.emit(legacy);
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(notified("a"));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(legacy);
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("queued provider turns keep stdin open until their final result", async t => {
  const h = await harness(t);
  h.emit(result(0, { queued_turn_count: 1 }));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(result(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("resumed task notification result cannot settle the queued initial input", async t => {
  const h = await harness(t);
  h.emit(notificationResult(0));
  assert.equal(h.child.stdin.writableEnded, false, "恢复会话的后台通知 result 不能关闭首条用户输入通道");
  const request = await ask(h, "resumed-notification");
  await h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } });
  assert.equal(h.writes.at(-1).response.request_id, "resumed-notification-control");
  h.emit(result(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("locally appended input survives the preceding result and keeps later interactions writable", async t => {
  const h = await harness(t);
  await h.session.appendInput({
    turnId: "test-turn" as any,
    userItemId: "user-appended" as any,
    text: "继续处理",
    images: [],
  });
  h.emit(result(0, { queued_turn_count: 1 }));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false, "前一轮 result 不能结算刚追加的用户输入");
  h.emit({
    type: "control_request",
    request_id: "plan-control",
    request: { subtype: "can_use_tool", tool_use_id: "plan-tool", tool_name: "ExitPlanMode", input: { plan: "实施方案" } },
  });
  await flushStdout();
  await h.session.respondApproval("plan-control", "accept");
  assert.equal(h.writes.at(-1).response.request_id, "plan-control");
  acknowledgeInput(h, 0);
  h.emit(result(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("multiple active appends are settled by one final root result when provider queue is empty", async t => {
  const h = await harness(t);
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-appended-1" as any, text: "补充一", images: [] });
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-appended-2" as any, text: "补充二", images: [] });

  acknowledgeInput(h, 0);
  acknowledgeInput(h, 1);
  h.emit(result(0));
  await flushStdout();

  assert.equal(h.child.stdin.writableEnded, true, "合并输入只返回一个 queued_turn_count=0 根 result 时必须收口");
  h.child.emit("close", 0, null);
  await h.done;
});

test("an aggregate root result still keeps appended stdin open for a pending user answer", async t => {
  const h = await harness(t);
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-appended" as any, text: "补充后继续询问", images: [] });
  const request = await ask(h, "aggregate-ask");
  acknowledgeInput(h, 0);
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false, "根 result 收口输入批次后，未回答的交互请求仍需保持 stdin 打开");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } });
  t.mock.timers.tick(5_001);
  assert.equal(h.child.stdin.writableEnded, true, "迟到回答且没有后续 provider 输出时应安全收口");
});

test("a stale empty-queue result cannot settle unacknowledged active appends", async t => {
  const h = await harness(t);
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-a" as any, text: "补充一", images: [] });
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false, "旧结果的空队列快照不能收口刚写入的输入");
  assert.equal(h.session.canAppendInput(), true);

  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-b" as any, text: "补充二", images: [] });
  acknowledgeInput(h, 0);
  acknowledgeInput(h, 0); // 重复回显不得提前确认第二条输入。
  const second = h.writes.filter(message => message.type === "user" && message.uuid)[1];
  h.emit({ ...second, isReplay: true, parent_tool_use_id: "nested-agent" });
  h.emit({ ...second, uuid: "unrelated-user-message", isReplay: true });
  h.emit(result(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);

  acknowledgeInput(h, 1);
  h.emit(result(1)); // 旧 result 重放不得结算新确认的输入。
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(result(2));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
  assert.equal(h.events.some(event => event.type === "item.userMessage.created"), false, "原生回显不重复创建用户消息");
});

test("a closed stdin rejects append before writing while the child is still active", async t => {
  const h = await harness(t);
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.session.hasActiveTurn(), true);
  assert.equal(h.session.canAppendInput(), false);
  const writeCount = h.writes.length;
  await assert.rejects(
    h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-late" as any, text: "继续", images: [] }),
    error => error instanceof ActiveTurnInputClosedError && error.requestOutcomeUnknown === false,
  );
  assert.equal(h.writes.length, writeCount);
  h.child.emit("close", 0, null);
  await h.done;
  assert.equal(h.session.hasActiveTurn(), false);
});

test("a notification result cannot settle an acknowledged appended user input", async t => {
  const h = await harness(t);
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-after-notification" as any, text: "继续处理", images: [] });
  acknowledgeInput(h, 0);
  h.emit(notificationResult(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(result(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("a child exiting before appended input settles fails explicitly without reporting success", async t => {
  const h = await harness(t);
  h.expectFailure(error => (error as { code?: string }).code === "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT");
  await h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-unsettled" as any, text: "继续处理", images: [] });
  h.emit(result(0));
  h.child.emit("close", 0, null);
  await assert.rejects(h.done, (error: any) => error.code === "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT");
});

test("a failed stdin write has unknown delivery outcome and cannot be retried as a closed pipe", async t => {
  const h = await harness(t);
  h.expectFailure(error => (error as { code?: string }).code === "CLAUDE_STDIN_INPUT_UNSETTLED_ON_EXIT");
  t.mock.method(h.child.stdin as any, "write", (...args: any[]) => {
    queueMicrotask(() => args.at(-1)(new Error("write acknowledgment failed")));
    return false;
  });
  await assert.rejects(
    h.session.appendInput({ turnId: "test-turn" as any, userItemId: "user-unknown" as any, text: "继续", images: [] }),
    (error: any) => error.requestOutcomeUnknown === true && /write acknowledgment failed/.test(error.cause?.message),
  );
});

test("interactive requests stay pending until their stdin writes are confirmed", async t => {
  const h = await harness(t);
  const request = await ask(h, "write-confirmation");
  let writeMock = t.mock.method(h.child.stdin as any, "write", (...args: any[]) => {
    const callback = args.at(-1);
    queueMicrotask(() => callback(new Error("Stream closed")));
    return false;
  });
  await assert.rejects(
    h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } }),
    /Stream closed/,
  );
  writeMock.mock.restore();
  await h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } });
  assert.equal(h.events.filter(event => event.type === "userInput.resolved").length, 1);

  h.emit({
    type: "control_request",
    request_id: "write-confirmation-plan",
    request: { subtype: "can_use_tool", tool_use_id: "write-confirmation-tool", tool_name: "ExitPlanMode", input: { plan: "实施方案" } },
  });
  await flushStdout();
  writeMock = t.mock.method(h.child.stdin as any, "write", (...args: any[]) => {
    const callback = args.at(-1);
    queueMicrotask(() => callback(new Error("Stream closed")));
    return false;
  });
  await assert.rejects(h.session.respondApproval("write-confirmation-plan", "accept"), /Stream closed/);
  writeMock.mock.restore();
  await h.session.respondApproval("write-confirmation-plan", "accept");
  assert.equal(h.events.filter(event => event.type === "approval.resolved").length, 1);
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("foreground agents do not require a background notification turn", async t => {
  const h = await harness(t);
  h.emit(started("foreground", { is_backgrounded: false }));
  h.emit(notified("foreground"));
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

test("failed and stopped background tasks still wait for their notification results", async t => {
  const h = await harness(t);
  h.emit(notified("failed", { status: "failed" }));
  h.emit(started("failed")); // Completion may precede the lifecycle start event.
  h.emit(started("stopped")); h.emit(notified("stopped", { status: "stopped" }));
  h.emit(result(0));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(notificationResult(1));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, false);
  h.emit(notificationResult(2));
  await flushStdout();
  assert.equal(h.child.stdin.writableEnded, true);
});

for (const activity of ["output", "approval", "background", "none"] as const) {
  test(`late-answer fallback closes only an idle settled turn: ${activity}`, async t => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const request = await ask(h);
    h.emit(result(0));
    await flushStdout();
    assert.equal(h.child.stdin.writableEnded, false, "pending question keeps stdin open");
    await h.session.respondUserInput(request.requestId, { q_0: { answers: ["同意"] } });
    if (activity === "output") {
      h.emit({ type: "assistant", message: { id: "continued", content: [{ type: "text", text: "continuing" }] } });
    } else if (activity === "approval") {
      h.emit({ type: "control_request", request_id: "plan-control", request: { subtype: "can_use_tool", tool_use_id: "plan-tool", tool_name: "ExitPlanMode", input: { plan: "实施方案" } } });
    } else if (activity === "background") {
      h.emit(started("new-agent"));
    }
    await flushStdout();
    t.mock.timers.tick(5_001);
    await flushStdout();
    assert.equal(h.child.stdin.writableEnded, activity === "none");
  });
}

test("运行中关闭计划模式通过 control_request 恢复到进入前模式并等待 CLI 回执", async t => {
  const h = await harness(t, { planMode: true, accessMode: "current" });
  const switching = h.session.applyPermissionPrefs({ planMode: false });
  let request: any;
  for (let index = 0; index < 100 && !request; index += 1) {
    request = h.writes.find(message => message.type === "control_request" && message.request?.subtype === "set_permission_mode");
    if (!request) await nextTick();
  }
  assert.equal(request?.request?.mode, "acceptEdits");
  let settled = false;
  switching.then(() => { settled = true; }, () => { settled = true; });
  await flushStdout();
  assert.equal(settled, false, "CLI 回执前不得提前报告切换成功");
  h.emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
  await switching;
  assert.equal((h.session as any).currentControlMode, "acceptEdits");
  h.emit(result(0));
  await flushStdout();
});

test("运行中仅修改 accessMode 时按当前 profile 切换控制模式", async t => {
  const h = await harness(t);
  const switching = h.session.applyPermissionPrefs({ accessMode: "current" });
  let request: any;
  for (let index = 0; index < 100 && !request; index += 1) {
    request = h.writes.find(message => message.type === "control_request" && message.request?.subtype === "set_permission_mode");
    if (!request) await nextTick();
  }
  assert.equal(request?.request?.mode, "acceptEdits");
  h.emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
  await switching;
  assert.equal((h.session as any).currentControlMode, "acceptEdits");
  assert.equal((h.session as any).currentDeclaredAccessMode, "current");
  h.emit(result(0));
  await flushStdout();
});

test("并发权限切换按调用顺序串行等待 CLI 回执", async t => {
  const h = await harness(t);
  const first = h.session.applyPermissionPrefs({ accessMode: "current" });
  const second = h.session.applyPermissionPrefs({ planMode: true });
  await flushStdout();
  let requests = h.writes.filter(message => message.type === "control_request" && message.request?.subtype === "set_permission_mode");
  assert.equal(requests.length, 1, "第二个切换必须等待第一个回执");
  h.emit({ type: "control_response", response: { subtype: "success", request_id: requests[0].request_id } });
  await first;
  for (let index = 0; index < 100 && requests.length < 2; index += 1) {
    requests = h.writes.filter(message => message.type === "control_request" && message.request?.subtype === "set_permission_mode");
    if (requests.length < 2) await nextTick();
  }
  assert.equal(requests[1]?.request?.mode, "plan");
  h.emit({ type: "control_response", response: { subtype: "success", request_id: requests[1].request_id } });
  await second;
  assert.equal((h.session as any).currentControlMode, "plan");
  h.emit(result(0));
  await flushStdout();
});

test("普通工具审批未改变模式时不回写 nextPlanMode", async t => {
  const h = await harness(t, { planMode: true, accessMode: "current" });
  h.emit({ type: "control_request", request_id: "plan-tool-control", request: {
    subtype: "can_use_tool", tool_use_id: "plan-tool", tool_name: "Bash", input: { command: "git status" },
  } });
  let approval: any;
  for (let index = 0; index < 100 && !approval; index += 1) {
    approval = h.events.find(event => event.type === "approval.request");
    if (!approval) await nextTick();
  }
  assert.ok(approval);
  await h.session.respondApproval("plan-tool-control", "accept");
  const resolved = h.events.filter(event => event.type === "approval.resolved").at(-1) as any;
  assert.ok(resolved);
  assert.equal(resolved.payload.nextPlanMode, undefined);
  assert.equal(resolved.payload.nextAccessMode, undefined);
  h.emit(result(0));
  await flushStdout();
});
