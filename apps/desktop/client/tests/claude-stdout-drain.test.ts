import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import type { ConversationEventInput, RawEngineEventInput } from "@codeflowai/shared";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { createLocalEventPipeline } from "../src/runtime/localEventPersistence.js";

let nextFakePid = 12345;

class FakeClaudeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  readonly pid = nextFakePid++;
  killed = false;
  exitCode: number | null = null;
  closed = false;

  /** 模拟 stdio 已结束的 child close，不启动任何外部程序。 */
  close(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  /** 中断异步交还 close；已退出的进程拒绝重复信号，与真实 child 一致。 */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.closed) return false;
    this.killed = true;
    setImmediate(() => this.close(0, signal));
    return true;
  }
}

/** 生成可直接映射 reasoning 的一组合法 stdout 行及最终 result。 */
function output(count = 6): string {
  return [...Array.from({ length: count }, (_, index) => JSON.stringify({ type: "stream_event", event: {
    type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: String(index) },
  } })), JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", uuid: "result-1" })].join("\n") + "\n";
}

/** 先让真实readline收到EOF尾行；child close不能先于stdio的end事实。 */
async function endWithEofTail(child: FakeClaudeChild): Promise<void> {
  const ended = new Promise<void>(resolve => child.stdout.once("end", resolve));
  child.stdout.end(output().trimEnd());
  await ended;
}

/** 只替换 provider 子进程；保留实际 session、stream processor 和退出状态流转。 */
async function fixture(t: TestContext, hooks: {
  raw?: (event: RawEngineEventInput) => void;
  conversation?: (event: ConversationEventInput) => void;
  startupTimeoutMs?: number;
  treeExitCode?: number;
  flush?: () => Promise<void>;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  onSessionId?: () => void;
  threadId?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-claude-stdout-"));
  resetEngineModelCatalogRuntimeForTest();
  initializeLocalEngineModelCatalog();
  const child = new FakeClaudeChild();
  let treeStops = 0;
  const previousSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options?: childProcess.SpawnOptions) => {
    if (path.basename(command).toLowerCase() !== "taskkill.exe") return child as unknown as childProcess.ChildProcess;
    if (args[1] !== String(child.pid)) return previousSpawn(command, args, options);
    assert.deepEqual(args, ["/PID", String(child.pid), "/T", "/F"]);
    treeStops++;
    const helper = new EventEmitter();
    setImmediate(() => { child.close(1); helper.emit("close", hooks.treeExitCode ?? 0); });
    return helper as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  const events: string[] = [];
  const raw: RawEngineEventInput[] = [];
  const logs: unknown[] = [];
  const session = new ClaudeThreadSession({
    workspacePath: root, workspaceId: "stdout-probe:workspace", threadId: hooks.threadId ?? "stdout-thread", initialSessionId: null,
    onEngineProcessSnapshot: () => false, onSessionId: hooks.onSessionId ?? (() => {}),
    withLegacyDatabase: hooks.withLegacyDatabase,
    writeWorkspaceLog(_workspaceId, entry) { logs.push(entry); },
    hasConfiguredProviderCredentials: () => true,
    readProviderCredentials: () => ({ apiKey: "synthetic-test-key", baseUrl: "http://invalid.local" }),
  });
  let settled = false;
  const outcome = session.sendMessage({ turnId: "stdout-turn", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "synthetic", images: [], timeoutPolicy: { mode: "legacy-turn", timeoutMs: 10_000, startupTimeoutMs: hooks.startupTimeoutMs ?? 1_000 },
  }, {
    flush: hooks.flush,
    raw(event) { hooks.raw?.(event); raw.push(event); events.push(`raw:${String((event.data as any)?.event?.delta?.thinking ?? (event.data as any)?.type)}`); },
    conversation(event) {
      hooks.conversation?.(event);
      if (event.type === "item.reasoning.delta") events.push(`canonical:${event.payload.delta}`);
    },
  }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })).finally(() => { settled = true; });
  t.after(async () => {
    child.close();
    await outcome;
    fs.rmSync(root, { recursive: true, force: false });
    resetEngineModelCatalogRuntimeForTest();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (let attempt = 0; child.stdout.listenerCount("data") === 0 && !settled && attempt < 100; attempt++) await nextTick();
  assert.ok(child.stdout.listenerCount("data") > 0, `实际 session 必须完成 stdout 监听；outcome=${JSON.stringify(await Promise.race([outcome, Promise.resolve("pending")]))}`);
  return { child, session, raw, events, logs, outcome, isSettled: () => settled, treeStops: () => treeStops };
}

/** 聚合及 cause 中仍必须能找到原始异常，包括 falsy 值。 */
function hasCause(error: unknown, expected: unknown): boolean {
  if (Object.is(error, expected)) return true;
  if (!error || typeof error !== "object") return false;
  return error instanceof AggregateError && error.errors.some(item => hasCause(item, expected))
    || Object.hasOwn(error, "cause") && hasCause((error as Error).cause, expected);
}

test("Claude绑定变化等待短许可时保留stdout owner，delta不重复申请许可", async t => {
  let permitted = false, blocked = false, calls = 0, bindings = 0, allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  const f = await fixture(t, {
    withLegacyDatabase: async (_requestId, operation) => {
      calls++;
      if (blocked) await gate;
      permitted = true;
      try { return operation(); } finally { permitted = false; }
    },
    onSessionId() { assert.equal(permitted, true); bindings++; },
  });
  const preparationCalls = calls;
  blocked = true;
  const first = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "before-init" } } });
  f.child.stdout.write(first + "\n" + JSON.stringify({ type: "system", subtype: "init", session_id: "guarded-session", slash_commands: [], skills: [] }) + "\n" + output(2));
  f.child.close();
  await nextTick();
  assert.equal(f.isSettled(), false);
  assert.equal(bindings, 0);
  allow();
  assert.equal((await f.outcome).ok, true);
  assert.equal(bindings, 1);
  assert.equal(calls, preparationCalls + 1);
  assert.equal(f.raw.length, 5);
});

test("Claude持续输出在存储屏障未完成时暂停消费，完成后保留全部事件顺序", async t => {
  let release!: () => void, flushes = 0, permitted = false;
  const storage = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, {
    withLegacyDatabase: async (_requestId, operation) => { permitted = true; try { return operation(); } finally { permitted = false; } },
    flush: async () => { assert.equal(permitted, false, "等待落盘不能持有数据库短许可"); flushes++; await storage; },
  });
  f.child.stdout.write(output(120));
  try {
    for (let tick = 0; flushes === 0 && f.raw.length < 121 && tick < 200; tick++) await nextTick();
    assert.ok(flushes > 0, "provider仍运行时即应等待存储，不能只在回合结束时flush");
    const count = f.raw.length;
    assert.ok(count > 0 && count < 121);
    await nextTick(); await nextTick();
    assert.equal(f.raw.length, count, "存储积压时不得继续消费后续stdout");
  } finally { release(); f.child.close(); }
  assert.equal((await f.outcome).ok, true);
  assert.equal(f.raw.length, 121);
  assert.deepEqual(f.events.filter(event => event.startsWith("canonical:")), Array.from({ length: 120 }, (_, index) => `canonical:${index}`));
});

test("Claude输出保存屏障失败停止后续事件，保留原失败并释放调度", async t => {
  const failure = new Error("STREAM_STORAGE_FAILED");
  const f = await fixture(t, { flush: async () => { throw failure; } });
  f.child.stdout.write(output(120));
  f.child.close();
  const outcome = await f.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(hasCause(outcome.error, failure));
  assert.ok(f.raw.length < 121, "保存失败后不能继续交付后续输出");
});

test("Claude大输出按字节预算等待存储，不必等到行数阈值", async t => {
  let release!: () => void, entered!: () => void;
  const storage = new Promise<void>(resolve => { release = resolve; });
  const flushing = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { flush: async () => { entered(); await storage; } });
  const line = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "a".repeat(80 * 1024) } } });
  f.child.stdout.write(Array.from({ length: 8 }, () => line).join("\n") + "\n");
  try {
    await flushing;
    assert.ok(f.raw.length > 0 && f.raw.length < 8);
    await nextTick(); assert.ok(f.raw.length < 8);
  } finally { release(); f.child.stdout.write(output(0)); f.child.close(); }
  assert.equal((await f.outcome).ok, true);
  assert.equal(f.raw.length, 9);
});

test("Claude流式保存等待中仍可先停止进程，再排空原事件", async t => {
  let release!: () => void, entered!: () => void;
  const storage = new Promise<void>(resolve => { release = resolve; });
  const flushing = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { flush: async () => { entered(); await storage; } });
  f.child.stdout.write(output(80));
  await flushing;
  let confirmed = false, settled = false;
  const stopping = f.session.interrupt("stdout-turn", { onStopConfirmed() { confirmed = true; } })
    .then(value => { settled = true; return value; });
  try {
    for (let tick = 0; !confirmed && tick < 10; tick++) await nextTick();
    assert.equal(confirmed, true);
    assert.equal(settled, false, "停止证明不能代替保存完成");
  } finally { release(); }
  assert.equal(await stopping, true);
  assert.equal(f.raw.length, 81);
  assert.equal((await f.outcome).ok, false);
});

test("五路Claude持续输出超过管线容量时等待慢存储，恢复后全部保存不丢事件", { timeout: 20_000 }, async t => {
  let release!: () => void, persisted = 0;
  const storage = new Promise<void>(resolve => { release = resolve; });
  const flushing = new Set<string>();
  let allFlushing!: () => void;
  const backpressured = new Promise<void>(resolve => { allFlushing = resolve; });
  const failures: unknown[] = [];
  const pipeline = createLocalEventPipeline({ writer: {
    async submit(batch) {
      await storage;
      const messages = batch.events.map(message => ({ ...message, event: { ...message.event, schema: 1, seq: ++persisted } })) as any;
      return { batchId: batch.batchId, digest: "test", messages, indexedCount: messages.length, indexedThroughSeq: persisted };
    },
    async completeIndexes(_workspaceId, _batchId, count) { return count; },
    async withLegacyDatabase(_requestId, operation) { return operation(); },
    failIndexes(_workspaceId, _batchId, error) { failures.push(error); },
  }, apply() {}, publish() {}, onFailure(error) { failures.push(error); } });
  const sessions = [];
  for (let index = 0; index < 5; index++) {
    const threadId = `stream-${index}`;
    sessions.push(await fixture(t, { threadId,
      raw: event => pipeline.enqueue({ t: "raw.event", event }, "stdout-turn", 1),
      conversation: event => pipeline.enqueue({ t: "conversation.event", event }, "stdout-turn", 1),
      flush: () => { flushing.add(threadId); if (flushing.size === 5) allFlushing(); return pipeline.flush("stdout-probe:workspace", threadId); },
    }));
  }
  for (const f of sessions) { f.child.stdout.write(output(1000)); f.child.close(); }
  await backpressured;
  assert.equal(persisted, 0);
  release();
  for (const f of sessions) {
    assert.equal((await f.outcome).ok, true);
    assert.equal(f.raw.length, 1001);
  }
  await pipeline.close();
  assert.equal(persisted, 10_015);
  assert.deepEqual(failures, []);
});

test("Claude异步绑定排空后继续读取后续chunk，无需等待child关闭", async t => {
  let bindings = 0;
  const f = await fixture(t, {
    withLegacyDatabase: async (_requestId, operation) => operation(),
    onSessionId() { bindings++; },
  });
  f.child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "new-session", slash_commands: [], skills: [] }) + "\n");
  for (let attempt = 0; bindings === 0 && attempt < 100; attempt++) await nextTick();
  assert.equal(bindings, 1);
  await nextTick();

  f.child.stdout.write(output(2));
  for (let attempt = 0; !f.events.includes("raw:result") && attempt < 100; attempt++) await nextTick();
  assert.deepEqual(f.events, ["raw:system", "raw:0", "canonical:0", "raw:1", "canonical:1", "raw:result"]);
  assert.equal(f.child.closed, false);
  f.child.close();
  assert.equal((await f.outcome).ok, true);
});

test("Claude异步绑定后恢复读取失败归stdout owner返回", async t => {
  const failure = new Error("SESSION_STDOUT_RESUME_FAILED");
  const f = await fixture(t, { withLegacyDatabase: async (_requestId, operation) => operation() });
  t.mock.method(f.child.stdout, "resume", () => { throw failure; });
  f.child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "new-session", slash_commands: [], skills: [] }) + "\n");
  for (let attempt = 0; !f.isSettled() && attempt < 100; attempt++) await nextTick();
  assert.equal(f.isSettled(), true, "恢复读取失败必须结束回合");
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(hasCause(result.error, failure));
  assert.equal(f.child.killed, true);
});

test("Claude短许可中的绑定失败归stdout owner返回且阻止后续canonical", async t => {
  const failure = new Error("SESSION_BINDING_DATABASE_FAILED");
  const f = await fixture(t, { withLegacyDatabase: async (_requestId, operation) => operation(), onSessionId() { throw failure; } });
  f.child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "failed-session", slash_commands: [], skills: [] }) + "\n" + output(2));
  f.child.close();
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("binding failure must fail send");
  assert.ok(hasCause(result.error, failure));
  assert.equal(f.events.some(event => event.startsWith("canonical:")), false);
});

test("Claude stdout 单 chunk 有界处理，close 等待已接收行且保持 raw/canonical 顺序", async t => {
  const f = await fixture(t);
  f.child.stdout.write(output());
  const acceptedSynchronously = f.raw.length;
  f.child.close();
  assert.ok(acceptedSynchronously <= 2, `当前 chunk 连续处理了 ${acceptedSynchronously} 行，必须让出执行机会`);
  await nextTick();
  assert.ok(f.raw.length > 0 && f.raw.length < 7, "单 tick 不能消耗整批已接收行");
  assert.equal(f.isSettled(), false, "close 不能越过 stdout 排空");
  const result = await f.outcome;
  assert.equal(result.ok, true);
  assert.equal(f.raw.length, 7);
  assert.deepEqual(f.events, ["raw:0", "canonical:0", "raw:1", "canonical:1", "raw:2", "canonical:2", "raw:3", "canonical:3", "raw:4", "canonical:4", "raw:5", "canonical:5", "raw:result"]);
});

for (const lineCostMs of [5, 9]) {
  test(`Claude 多 session 共享 stdout 时间预算，单行耗时 ${lineCostMs}ms 后公平让出`, async t => {
    let now = 0;
    const sessions = [];
    for (let index = 0; index < 4; index++) sessions.push(await fixture(t, { raw() { now += lineCostMs; } }));
    t.mock.method(performance, "now", () => now);
    for (const f of sessions) { f.child.stdout.write(output(4)); f.child.close(); }
    await nextTick();
    assert.equal(sessions.reduce((count, f) => count + f.raw.length, 0), lineCostMs === 5 ? 2 : 1,
      "全部 session 必须共用单 tick 预算，不能各自消耗两行或各自获得 8ms");
    assert.equal(sessions[1]!.raw.length, 0, "预算用尽后其他 session 等下一 tick");
    await nextTick();
    assert.ok(sessions[1]!.raw.length > 0, "持续积压的首个 session 必须轮转，让下一 session 先执行");
    for (const f of sessions) {
      assert.equal((await f.outcome).ok, true);
      assert.deepEqual(f.events, ["raw:0", "canonical:0", "raw:1", "canonical:1", "raw:2", "canonical:2", "raw:3", "canonical:3", "raw:result"]);
    }
  });
}

test("Claude 共享 stdout 调度中一 session 失败不阻止其他 session 完成", async t => {
  const failure = new Error("synthetic isolated stdout failure");
  const failed = await fixture(t, { raw() { throw failure; } });
  const healthy = await fixture(t);
  failed.child.stdout.write(output());
  healthy.child.stdout.write(output());
  healthy.child.close();
  const failedResult = await failed.outcome;
  assert.equal(failedResult.ok, false);
  if (!failedResult.ok) assert.equal(hasCause(failedResult.error, failure), true);
  assert.equal((await healthy.outcome).ok, true);
  assert.equal(healthy.raw.length, 7);
  const completed = healthy.events.length;
  await nextTick();
  assert.equal(healthy.events.length, completed, "排空后不能残留输出回调");
});

for (const stop of ["interrupt", "dispose"] as const) {
  test(`Claude 共享 stdout 预算下 ${stop} 仍排空原 owner 且其他 session 的 EOF 正常完成`, async t => {
    let now = 0;
    const stopped = await fixture(t, { raw() { now += 9; } });
    const healthy = await fixture(t, { raw() { now += 9; } });
    t.mock.method(performance, "now", () => now);
    stopped.child.stdout.write(output());
    await endWithEofTail(healthy.child);
    healthy.child.close();
    if (stop === "interrupt") assert.equal(await stopped.session.interrupt("stdout-turn"), true);
    else await stopped.session.dispose();
    assert.equal(stopped.raw.length, 7);
    assert.equal((await stopped.outcome).ok, false);
    assert.equal((await healthy.outcome).ok, true);
    assert.equal(healthy.raw.length, 7);
    const counts = [stopped.events.length, healthy.events.length];
    await nextTick();
    assert.deepEqual([stopped.events.length, healthy.events.length], counts, "收口后不遗留跨 session 回调");
  });
}

test("Claude stdout EOF无换行尾行自动关闭后仍正常完成已接收FIFO", async t => {
  const f = await fixture(t);
  await endWithEofTail(f.child);
  f.child.close();
  const result = await f.outcome;
  assert.equal(result.ok, true, result.ok ? undefined : String(result.error));
  assert.equal(f.raw.length, 7);
  assert.deepEqual(f.events, ["raw:0", "canonical:0", "raw:1", "canonical:1", "raw:2", "canonical:2", "raw:3", "canonical:3", "raw:4", "canonical:4", "raw:5", "canonical:5", "raw:result"]);
});

test("Claude stdout EOF尾行回调失败保首因并停止后续canonical", async t => {
  const failure = Object.assign(new Error("synthetic EOF callback failure"), { code: "EIO" });
  const f = await fixture(t, { raw(event) { if ((event.data as any)?.type === "result") throw failure; } });
  await endWithEofTail(f.child);
  f.child.close();
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(hasCause(result.error, failure), true);
    assert.equal(hasCauseCode(result.error, "ERR_USE_AFTER_CLOSE"), false);
  }
  assert.equal(f.raw.length, 6);
  assert.equal(f.events.includes("raw:result"), false);
});

/** 只核结构化code及原cause，不靠异常文案判断关闭或恢复。 */
function hasCauseCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === code
    || error instanceof AggregateError && error.errors.some(item => hasCauseCode(item, code))
    || Object.hasOwn(error, "cause") && hasCauseCode((error as Error).cause, code);
}

test("Claude 中断时EOF无换行尾行仍排空且保手动中断终态", async t => {
  const f = await fixture(t);
  await endWithEofTail(f.child);
  assert.equal(await f.session.interrupt("stdout-turn"), true);
  assert.equal(f.raw.length, 7);
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(String(result.error), /turn interrupted/);
    assert.equal(hasCauseCode(result.error, "ERR_USE_AFTER_CLOSE"), false);
  }
});

for (const flushActiveTurn of [true, false]) {
  test(`Claude dispose flushActiveTurn=${flushActiveTurn} 等待EOF尾行并释放资源`, async t => {
    const f = await fixture(t);
    await endWithEofTail(f.child);
    await f.session.dispose({ flushActiveTurn });
    assert.equal(f.raw.length, 7);
    const result = await f.outcome;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(hasCauseCode(result.error, "ERR_USE_AFTER_CLOSE"), false);
    const count = f.events.length;
    await nextTick();
    assert.equal(f.events.length, count);
  });
}

for (const boundary of ["raw", "canonical"] as const) {
  for (const failure of [Object.assign(new Error("synthetic persistence failure"), { code: "EIO" }), null, undefined]) {
    test(`Claude stdout ${boundary} 回调失败保留 ${failure === null ? "null" : failure === undefined ? "undefined" : "Error"} 首因并停止后续副作用`, async t => {
      const f = await fixture(t, boundary === "raw" ? { raw(event) {
        if ((event.data as any)?.event?.delta?.thinking === "2") throw failure;
      } } : { conversation(event) {
        if (event.type === "item.reasoning.delta" && event.payload.delta === "2") throw failure;
      } });
      f.child.stdout.write(output());
      const result = await f.outcome;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(hasCause(result.error, failure), true);
      assert.equal(f.events.includes("raw:3"), false);
      assert.equal(f.events.includes("canonical:3"), false);
      assert.equal(f.child.killed, true);
    });
  }
}

test("Claude child error 先到仍排空已接收行并保留 child 首因", async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error("synthetic child error"), { code: "EPIPE" });
  f.child.stdout.write(output());
  f.child.emit("error", failure);
  f.child.close();
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(hasCause(result.error, failure), true);
  assert.equal(f.raw.length, 7);
});

test("Claude 手动中断不把 stdout 回调失败确认成成功", async t => {
  const failure = Object.assign(new Error("synthetic callback failure"), { code: "EIO" });
  const f = await fixture(t, { raw(event) {
    if ((event.data as any)?.event?.delta?.thinking === "2") throw failure;
  } });
  f.child.stdout.write(output());
  await assert.rejects(f.session.interrupt("stdout-turn"), error => hasCause(error, failure));
  assert.equal((await f.outcome).ok, false);
});

test("Claude 失败后恢复 stdout 再失败会释放管道并保留两因", async t => {
  const failure = Object.assign(new Error("synthetic callback failure"), { code: "EIO" });
  const resumeFailure = Object.assign(new Error("synthetic resume failure"), { code: "EPIPE" });
  const f = await fixture(t, { raw(event) {
    if ((event.data as any)?.event?.delta?.thinking === "2") throw failure;
  } });
  t.mock.method(f.child.stdout, "resume", () => { throw resumeFailure; });
  f.child.stdout.write(output());
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(hasCause(result.error, failure), true);
    assert.equal(hasCause(result.error, resumeFailure), true);
  }
  assert.equal(f.child.stdout.destroyed, true, "恢复失败不能使暂停管道悬挂");
});

test("Claude 正常排空恢复 stdout 失败也释放暂停管道", async t => {
  const failure = Object.assign(new Error("synthetic resume failure"), { code: "EPIPE" });
  const f = await fixture(t);
  t.mock.method(f.child.stdout, "resume", () => { throw failure; });
  f.child.stdout.write(output());
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(hasCause(result.error, failure), true);
  assert.equal(f.child.stdout.destroyed, true);
});

test("Claude 已接收首行在队列执行前取消 startup watchdog", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { startupTimeoutMs: 1 });
  f.child.stdout.write(output());
  t.mock.timers.tick(5);
  assert.equal(f.child.killed, false);
  f.child.close();
  assert.equal((await f.outcome).ok, true);
});

test("Claude 手动中断等待当前 chunk 排空后返回", async t => {
  const f = await fixture(t);
  f.child.stdout.write(output());
  assert.equal(await f.session.interrupt("stdout-turn"), true);
  assert.equal(f.raw.length, 7);
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(String(result.error), /turn interrupted/);
});

test("Claude 进程停止证明先于积压输出收尾，重复停止共享证明且保留draining", async t => {
  const f = await fixture(t);
  f.child.stdout.write(output(80));
  let confirmations = 0, finished = false;
  const stopping = f.session.interrupt("stdout-turn", { onStopConfirmed() { confirmations++; } })
    .then(value => { finished = true; return value; });
  for (let tick = 0; confirmations === 0 && tick < 8; tick++) await nextTick();
  assert.equal(confirmations, 1, "真实进程退出后立即提供停止证明");
  assert.equal(finished, false, "停止证明不等待已接收输出排空");
  assert.equal(f.session.getTurnPhase("stdout-turn"), "draining");
  assert.equal(await stopping, true);
  assert.equal(f.raw.length, 81);
});

test("Claude 停止已确认后保存超过30秒仍持有原owner，保存失败显式返回", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectFlush!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
  const failure = new Error("EVENT_WRITE_FAILED");
  const f = await fixture(t, { flush: () => pending });
  let confirmed = false, settled = false;
  const stopping = f.session.interrupt("stdout-turn", { onStopConfirmed() { confirmed = true; } })
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  for (let tick = 0; !confirmed && tick < 8; tick++) await nextTick();
  assert.equal(confirmed, true);
  t.mock.timers.tick(31_000);
  await nextTick();
  assert.equal(settled, false);
  assert.equal(f.session.hasActiveTurn(), true);
  rejectFlush(failure);
  const result = await stopping;
  assert.ok("error" in result && hasCause(result.error, failure));
  assert.equal((await f.outcome).ok, false);
  assert.equal(f.session.getTurnPhase("stdout-turn"), "failed");
  assert.equal(f.session.getTurnFailure("stdout-turn"), "TURN_EVENT_FLUSH_FAILED");
  assert.equal(f.session.hasActiveTurn(), true);
});

for (const failDrain of [false, true]) {
  test(`Claude 进程关闭后收尾超过 3 秒可重复终止，输出失败=${failDrain}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const failure = new Error("synthetic late stdout persistence failure");
    const f = await fixture(t, { raw(event) {
      if (failDrain && (event.data as any)?.event?.delta?.thinking === "8") throw failure;
    } });
    const kill = t.mock.method(f.child, "kill");
    f.child.stdout.write(output(30));
    const first = f.session.interrupt("stdout-turn").then(value => ({ value }), error => ({ error }));
    await nextTick();
    assert.equal(f.child.closed, true);
    assert.equal(f.isSettled(), false, "进程已关，已接收输出仍待处理");
    t.mock.timers.tick(3_100);
    await nextTick();
    assert.equal(kill.mock.calls.filter(call => call.arguments[0] === "SIGKILL").length, 0,
      "排空超时不能再次终止已关闭进程");
    assert.equal(f.isSettled(), false);
    const second = f.session.interrupt("stdout-turn").then(value => ({ value }), error => ({ error }));
    const results = await Promise.all([first, second]);
    if (process.platform === "win32") assert.equal(f.treeStops(), 1, "重复停止复用已确认的进程树终止");
    if (failDrain) {
      for (const result of results) assert.equal("error" in result && hasCause(result.error, failure), true);
    } else {
      assert.deepEqual(results, [{ value: true }, { value: true }]);
      assert.equal(f.raw.length, 31, "停止成功前完整保存已接收输出");
    }
    assert.equal((await f.outcome).ok, false);
  });
}

test("Claude 同一回合并发终止共用进程停止任务", async t => {
  const f = await fixture(t);
  f.child.stdout.write(output());
  assert.deepEqual(await Promise.all([f.session.interrupt("stdout-turn"), f.session.interrupt("stdout-turn")]), [true, true]);
  if (process.platform === "win32") assert.equal(f.treeStops(), 1);
  assert.equal(f.raw.length, 7);
});

for (const retry of ["interrupt", "dispose"] as const) {
  test(`Windows Claude 树终止失败且根已关闭后 ${retry} 仍保留失败`, { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t, { treeExitCode: 7 });
    await assert.rejects(f.session.interrupt("stdout-turn"), /taskkill exit code=7/);
    assert.equal((await f.outcome).ok, false);
    assert.equal(f.child.closed, true);
    await assert.rejects(retry === "interrupt" ? f.session.interrupt("stdout-turn") : f.session.dispose(), /taskkill exit code=7/);
    assert.equal(f.treeStops(), 1, "根退出不能补发 taskkill 或覆盖原进程树失败");
    assert.equal(f.session.hasActiveTurn(), true, "未确认的失败 owner 必须保留");
  });
}

for (const flushActiveTurn of [true, false]) {
  test(`Claude dispose flushActiveTurn=${flushActiveTurn} 不丢弃已接收 stdout`, async t => {
    const f = await fixture(t);
    f.child.stdout.write(output());
    await f.session.dispose({ flushActiveTurn });
    assert.equal(f.raw.length, 7);
    assert.equal((await f.outcome).ok, false);
    const count = f.events.length;
    await nextTick();
    assert.equal(f.events.length, count, "dispose 后不能再执行遗留行回调");
  });
}
