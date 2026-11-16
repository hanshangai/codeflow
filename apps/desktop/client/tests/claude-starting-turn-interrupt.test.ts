import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MANUAL_TURN_INTERRUPT_CODE, type RawEngineEventInput } from "@codeflowai/shared";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import type { SendMessageInput } from "../src/engines/threadSession.js";

/** 在真实准备边界插入门闩；provider 只运行测试拥有的 Node 进程。 */
async function fixture(t: test.TestContext, stage: "prompt" | "bridge" | "stdin" | "stdin-no-prompt", failCleanup = false,
  termination?: { failure: boolean }, complete = false,
  providerOptions: { outputBeforeInput?: boolean; descendant?: boolean; failBridgeCleanup?: boolean } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-start-interrupt-"));
  const open = fsp.open, unlink = fsp.unlink, rm = fsp.rm, createServer = http.createServer, spawn = childProcess.spawn;
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const servers: http.Server[] = [], children: childProcess.ChildProcess[] = [];
  const rawEvents: RawEngineEventInput[] = [];
  let outputReady: Promise<unknown> | undefined;
  let spawns = 0, rejectCleanup = failCleanup;
  const cleanupError = Object.assign(new Error("synthetic prompt unlink failure"), { code: "EPERM" });
  let bridgeCleanupAttempts = 0, rejectBridgeCleanup = Boolean(providerOptions.failBridgeCleanup);
  const bridgeCleanupError = Object.assign(new Error("synthetic bridge rm failure"), { code: "EPERM" });
  t.mock.method(os, "tmpdir", () => root);
  if (stage === "prompt") t.mock.method(fsp, "open", async (...args: Parameters<typeof open>) => {
    if (path.basename(String(args[0])) === "append-system-prompt.txt") { reached(); await gate; }
    return open(...args);
  });
  t.mock.method(fsp, "unlink", async (...args: Parameters<typeof unlink>) => {
    if (rejectCleanup && path.basename(String(args[0])) === "append-system-prompt.txt") throw cleanupError;
    return unlink(...args);
  });
  t.mock.method(fsp, "rm", async (...args: Parameters<typeof rm>) => {
    if (path.basename(String(args[0])).startsWith("codeflowai-claude-platform-tools-")) {
      bridgeCleanupAttempts++;
      if (rejectBridgeCleanup) throw bridgeCleanupError;
    }
    return rm(...args);
  });
  t.mock.method(http, "createServer", (...args: Parameters<typeof createServer>) => {
    const server = createServer(...args);
    servers.push(server);
    if (stage === "bridge") {
      const listen = server.listen;
      t.mock.method(server, "listen", function (this: http.Server, ...values: any[]) {
        reached();
        void gate.then(() => (listen as (...args: any[]) => http.Server).apply(this, values));
        return this;
      });
    }
    return server;
  });
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (path.basename(String(command)).toLowerCase() === "taskkill.exe") {
      if (termination?.failure) throw new Error("synthetic taskkill denied");
      return spawn(command, args, options);
    }
    spawns++;
    const providerCode = complete
      ? `process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'})+'\\n');process.stdin.destroy();});`
      : "process.stdin.resume();setInterval(()=>{},1000)";
    const startup = providerOptions.descendant
      ? `const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true,detached:true});descendant.once('error',error=>{throw error;});descendant.once('spawn',()=>{process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'starting-session',childPid:descendant.pid})+'\\n');process.stderr.write('synthetic startup stderr\\n');});`
      : providerOptions.outputBeforeInput
        ? `process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'starting-session'})+'\\n');process.stderr.write('synthetic startup stderr\\n');`
        : "";
    const child = spawn(process.execPath, ["-e", startup + providerCode], options);
    children.push(child);
    if (providerOptions.outputBeforeInput || providerOptions.descendant) outputReady = Promise.all([once(child.stdout!, "data"), once(child.stderr!, "data")]);
    if (stage.startsWith("stdin")) t.mock.method(child.stdin!, "write", (_line: string, _encoding: string, callback: () => void) => {
      reached();
      void gate.then(callback);
      return true;
    });
    return child;
  });
  syncBuiltinESMExports();
  resetEngineModelCatalogRuntimeForTest();
  initializeLocalEngineModelCatalog();
  const session = new ClaudeThreadSession({ workspacePath: root, workspaceId: "start:workspace", threadId: "starting-thread", initialSessionId: null,
    onSessionId() {}, onEngineProcessSnapshot: () => false, writeWorkspaceLog() {},
    hasConfiguredProviderCredentials: () => true,
    readProviderCredentials: () => ({ apiKey: "synthetic-test-key", baseUrl: "http://invalid.local" }),
  });
  const input: SendMessageInput = { turnId: "starting-turn", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "synthetic", images: [], systemMessage: stage === "bridge" || stage === "stdin-no-prompt" ? null : "synthetic system prompt",
    ...(stage === "bridge" ? { toolRegistry: { tools: [{ toolsetId: "test", toolsetName: "Test", toolId: "test", name: "Test",
      description: "test", runtime: "node" as const, code: "", permissions: { requiresWrite: false } }] },
    executeHostTool: async () => { throw new Error("provider tool must not run"); } } : {}),
    timeoutPolicy: { mode: "legacy-turn", timeoutMs: 5_000, startupTimeoutMs: 2_000 },
  };
  const outcome = session.sendMessage(input, { conversation() {}, raw(event) { rawEvents.push(event); } })
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  t.after(async () => {
    release();
    rejectCleanup = false;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const event of rawEvents) {
      const pid = (event.data as { childPid?: number }).childPid;
      if (!pid) continue;
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
      const helper = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const [code] = await once(helper, "close");
      assert.equal(code, 0, "测试拥有的子进程必须清理成功");
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await outcome;
    await session.dispose();
    for (const server of servers) if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    resetEngineModelCatalogRuntimeForTest();
    await fsp.rmdir(root);
  });
  await Promise.race([entered, outcome.then(result => { throw new Error(`preparation did not reach gate: ${JSON.stringify(result)}`); })]);
  return { session, outcome, release, root, servers, cleanupError, bridgeCleanupError, rawEvents,
    /** 仅观测测试 provider 已输出，不消费或解析实际 session 的原始事件。 */
    waitForOutput() { assert.ok(outputReady); return outputReady; },
    get spawns() { return spawns; }, get provider() { return children[0]; }, allowCleanup() { rejectCleanup = false; },
    get bridgeCleanupAttempts() { return bridgeCleanupAttempts; }, allowBridgeCleanup() { rejectBridgeCleanup = false; },
  };
}

for (const stage of ["prompt", "bridge", "stdin", "stdin-no-prompt"] as const) test(`Claude ${stage} 准备窗口终止等待原 owner 释放，禁止迟到启动`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, stage);
  const running = f.session.hasActiveTurn(), turnId = f.session.getActiveTurnId();
  let stopFinished = false;
  const stopping = f.session.interrupt("starting-turn").then(result => { stopFinished = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const premature = stopFinished;
  f.release();
  assert.equal(await stopping, true);
  const idleAfterStop = f.session.canIdleDispose();
  const result = await f.outcome;
  assert.equal(running, true);
  assert.equal(turnId, "starting-turn");
  if (!stage.startsWith("stdin")) assert.equal(premature, false, "准备资源释放前不能确认停止");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(f.spawns, stage.startsWith("stdin") ? 1 : 0);
  assert.equal(f.session.hasActiveTurn(), false);
  assert.equal(f.session.canIdleDispose(), true);
  assert.equal(idleAfterStop, true, "停止成功必须等待提示文件和凭据收尾");
  assert.ok(f.servers.every(server => !server.listening));
  assert.deepEqual(await fsp.readdir(f.root), []);
});

test("Claude 初始输入未确认时终止仍归档已收到的 stdout 和 stderr", { timeout: 12_000 }, async t => {
  const f = await fixture(t, "stdin", false, undefined, false, { outputBeforeInput: true });
  await f.waitForOutput();
  const stopping = f.session.interrupt("starting-turn");
  f.release();
  assert.equal(await stopping, true);
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(f.rawEvents.some(event => event.source === "claude.stream-json.stdout" && (event.data as { type?: string }).type === "system"), true);
  assert.equal(f.rawEvents.some(event => event.source === "claude.stderr" && (event.data as { line?: string }).line === "synthetic startup stderr"), true);
});

test("Windows Claude 带提示文件的初始输入窗口关闭先回收子树再释放文件", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async t => {
  const f = await fixture(t, "stdin", false, undefined, false, { descendant: true });
  await f.waitForOutput();
  await new Promise<void>(resolve => setImmediate(resolve));
  const descendantPid = f.rawEvents.map(event => (event.data as { childPid?: number }).childPid).find(Boolean);
  assert.ok(descendantPid);
  const closing = f.session.dispose();
  f.release();
  await closing;
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(f.session.canIdleDispose(), true);
});

test("Claude 未取消的提示准备完成后正常发送，不被运行代切换误判失效", { timeout: 12_000 }, async t => {
  const f = await fixture(t, "prompt", false, undefined, true);
  f.release();
  const result = await f.outcome;
  assert.equal(result.ok, true, result.ok ? undefined : String(result.error));
  assert.equal(f.spawns, 1);
  assert.equal(f.session.canIdleDispose(), true);
});

test("Claude 初始 stdin 期间终止进程树失败保留 owner，显式重试才释放", {
  skip: process.platform !== "win32", timeout: 12_000,
}, async t => {
  const termination = { failure: true };
  const f = await fixture(t, "stdin", false, termination);
  const stopping = f.session.interrupt("starting-turn");
  f.release();
  await assert.rejects(stopping, error => (error as { code?: string }).code === "claude_interrupt_unconfirmed");
  assert.equal(f.session.hasActiveTurn(), true);
  assert.equal(f.provider?.exitCode, null);
  assert.equal(f.provider?.signalCode, null);
  termination.failure = false;
  assert.equal(await f.session.interrupt("starting-turn"), true);
  const result = await f.outcome;
  assert.equal(result.ok, false);
  assert.equal(f.session.hasActiveTurn(), false);
});

test("Claude 准备期关闭入口终止失败后仍可从中断入口重试", {
  skip: process.platform !== "win32", timeout: 12_000,
}, async t => {
  const termination = { failure: true };
  const f = await fixture(t, "stdin-no-prompt", false, termination);
  const closing = f.session.dispose();
  f.release();
  await assert.rejects(closing, error => (error as { code?: string }).code === "claude_interrupt_unconfirmed");
  assert.equal(f.session.hasActiveTurn(), true);
  termination.failure = false;
  assert.equal(await f.session.interrupt("starting-turn"), true);
  const result = await f.outcome;
  assert.equal(result.ok, false);
  assert.equal(f.session.hasActiveTurn(), false);
});

test("Claude 准备期拒绝旧 turnId，当前 owner 仍能精确终止", { timeout: 12_000 }, async t => {
  const f = await fixture(t, "prompt");
  assert.equal(await f.session.interrupt("previous-turn"), false);
  const current = f.session.getActiveTurnId();
  const stopping = f.session.interrupt("starting-turn");
  f.release();
  assert.equal(await stopping, true);
  assert.equal(current, "starting-turn");
  assert.equal(f.spawns, 0);
});

test("Claude 准备期清理失败不确认停止，修复资源后可重试", { timeout: 12_000 }, async t => {
  const f = await fixture(t, "prompt", true);
  const stopping = f.session.interrupt("starting-turn");
  f.release();
  await assert.rejects(stopping, error => error instanceof AggregateError && error.errors.includes(f.cleanupError));
  assert.equal(f.session.canIdleDispose(), false);
  assert.equal(f.spawns, 0);
  f.allowCleanup();
  assert.equal(await f.session.interrupt("starting-turn"), true);
  assert.equal(f.session.canIdleDispose(), true);
});

test("Claude 工具桥清理持续失败时重复终止仍失败，恢复后必须重新释放", { timeout: 12_000 }, async t => {
  const f = await fixture(t, "bridge", false, undefined, false, { failBridgeCleanup: true });
  const stopping = f.session.interrupt("starting-turn");
  f.release();
  await assert.rejects(stopping, error => error instanceof AggregateError && error.errors.includes(f.bridgeCleanupError));
  await f.outcome;
  assert.equal(f.bridgeCleanupAttempts, 1);
  await assert.rejects(f.session.interrupt("starting-turn"), error => error === f.bridgeCleanupError);
  assert.equal(f.bridgeCleanupAttempts, 2);
  assert.equal(f.session.hasActiveTurn(), true);
  assert.equal(f.session.canIdleDispose(), false);
  f.allowBridgeCleanup();
  assert.equal(await f.session.interrupt("starting-turn"), true);
  assert.equal(f.bridgeCleanupAttempts, 3);
  assert.equal(f.session.canIdleDispose(), true);
  assert.deepEqual(await fsp.readdir(f.root), []);
});
