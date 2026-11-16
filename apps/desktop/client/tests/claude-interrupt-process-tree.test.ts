import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MANUAL_TURN_INTERRUPT_CODE } from "@codeflowai/shared";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";

/** 仅把 provider 替换成持有继承管道的真实父子进程，终止器仍调用 Windows。 */
async function fixture(t: test.TestContext, termination?: { failure: "spawn" | "nonzero" | null; cause: Error }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-claude-interrupt-tree-"));
  const spawn = childProcess.spawn;
  let provider: childProcess.ChildProcess | undefined;
  let descendantPid: number | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const providerCode = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true,
    });
    descendant.once('error', error => { throw error; });
    descendant.once('spawn', () => process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'tree-session', childPid: descendant.pid,
    }) + '\\n'));
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (path.basename(String(command)).toLowerCase() === "taskkill.exe") {
      if (termination?.failure === "spawn") throw termination.cause;
      if (termination?.failure === "nonzero") return spawn(process.execPath, ["-e", "process.exit(7)"], options);
      return spawn(command, args, options);
    }
    assert.equal(provider, undefined, "一次发送只应启动一个 provider");
    provider = spawn(process.execPath, ["-e", providerCode], options);
    return provider;
  });
  syncBuiltinESMExports();
  resetEngineModelCatalogRuntimeForTest();
  initializeLocalEngineModelCatalog();
  const session = new ClaudeThreadSession({
    workspacePath: root, workspaceId: "tree:workspace", threadId: "tree-thread", initialSessionId: null,
    onEngineProcessSnapshot: () => false, onSessionId() {}, writeWorkspaceLog() {},
    hasConfiguredProviderCredentials: () => true,
    readProviderCredentials: () => ({ apiKey: "synthetic-test-key", baseUrl: "http://invalid.local" }),
  });
  const outcome = session.sendMessage({
    turnId: "tree-turn", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "synthetic", images: [], timeoutPolicy: { mode: "legacy-turn", timeoutMs: 30_000, startupTimeoutMs: 10_000 },
  }, {
    conversation() {},
    raw(event) {
      const data = event.data as { childPid?: number };
      if (data.childPid) { descendantPid = data.childPid; ready(); }
    },
  }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const pid of [descendantPid, provider?.pid]) {
      if (!pid || !isAlive(pid)) continue;
      const helper = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const [code] = await once(helper, "close");
      assert.equal(code, 0, `测试拥有的进程 ${pid} 必须清理成功`);
    }
    await outcome;
    await session.dispose();
    resetEngineModelCatalogRuntimeForTest();
    fs.rmSync(root, { recursive: true });
  });
  await Promise.race([started, outcome.then(result => { throw new Error(`provider 未就绪：${JSON.stringify(result)}`); })]);
  assert.ok(provider?.pid);
  assert.ok(descendantPid);
  return { session, provider, descendantPid, outcome };
}

/** 只将操作系统确认的 ESRCH 视为退出，权限与其他探测错误原样失败。 */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("Windows Claude 终止同时回收继承 stdout 的工具子进程并解除回合运行态", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async t => {
  const f = await fixture(t);
  assert.equal(isAlive(f.provider.pid!), true);
  assert.equal(isAlive(f.descendantPid), true);
  assert.equal(await f.session.interrupt("tree-turn"), true);
  assert.equal(f.session.hasActiveTurn(), false);
  assert.equal(isAlive(f.provider.pid!), false);
  assert.equal(isAlive(f.descendantPid), false, "根进程退出后不能留下持有管道的工具子进程");
  const result = await f.outcome;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, MANUAL_TURN_INTERRUPT_CODE);
});

for (const failure of ["spawn", "nonzero"] as const) {
  test(`Windows Claude 进程树 ${failure} 失败保持运行态，修复后可重试终止`, {
    skip: process.platform !== "win32", timeout: 20_000,
  }, async t => {
    const termination: { failure: "spawn" | "nonzero" | null; cause: Error } = { failure, cause: new Error("synthetic taskkill denied") };
    const f = await fixture(t, termination);
    await assert.rejects(f.session.interrupt("tree-turn"), error => {
      const actual = error as Error & { code?: string };
      assert.equal(actual.code, "claude_interrupt_unconfirmed");
      if (failure === "spawn") assert.equal(actual.cause, termination.cause);
      else assert.match(actual.message, /exit code=7/u);
      return true;
    });
    assert.equal(f.session.hasActiveTurn(), true);
    assert.equal(isAlive(f.provider.pid!), true);
    assert.equal(isAlive(f.descendantPid), true);
    termination.failure = null;
    assert.equal(await f.session.interrupt("tree-turn"), true);
    assert.equal(f.session.hasActiveTurn(), false);
    assert.equal(isAlive(f.descendantPid), false);
  });
}

test("Windows Claude 拒绝旧 turnId，不能终止当前回合的进程树", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async t => {
  const f = await fixture(t);
  assert.equal(await f.session.interrupt("previous-turn"), false);
  assert.equal(f.session.getActiveTurnId(), "tree-turn");
  assert.equal(isAlive(f.provider.pid!), true);
  assert.equal(isAlive(f.descendantPid), true);
  assert.equal(await f.session.interrupt("tree-turn"), true);
});
