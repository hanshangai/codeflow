import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTick } from "node:timers/promises";
import type { SendMessageInput } from "../src/engines/threadSession.js";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";

test('revoked builtin Claude credential fails before prompt or provider side effects', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-credential-admission-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const denied = Object.assign(new Error('credential revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const session = new ClaudeThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  workspacePath: root, workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: null,
    onEngineProcessSnapshot: () => { throw new Error('must not spawn'); }, onSessionId() {},
    acquireCredential: () => { throw denied; },
  });
  await assert.rejects(session.sendMessage({ turnId: 'turn_credentials', userItemId: 'user', text: 'test', images: [], assistantItemId: 'assistant', reasoningItemId: 'reasoning' }, { conversation() {}, raw() {} }), error => error === denied);
  assert.deepEqual(await fsp.readdir(root), []);
});

test('revoked builtin Claude credential blocks new human responses', async () => {
  const denied = Object.assign(new Error('credential revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const session = new ClaudeThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  workspacePath: 'D:/isolated', workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: null, onEngineProcessSnapshot: () => false, onSessionId() {}, acquireCredential: () => { throw denied; } });
  await assert.rejects(session.respondApproval('approval', 'accept'), error => error === denied);
  await assert.rejects(session.respondUserInput('question', {}), error => error === denied);
});

test("unavailable Claude model releases prompt file and platform bridge before spawning", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-dispatch-cleanup-"));
  const servers: http.Server[] = [];
  const createServer = http.createServer;
  t.mock.method(os, "tmpdir", () => root);
  t.mock.method(http, "createServer", (...args: Parameters<typeof http.createServer>) => {
    const server = createServer(...args);
    servers.push(server);
    return server;
  });
  t.after(async () => {
    resetEngineModelCatalogRuntimeForTest();
    for (const server of servers) {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fsp.rm(root, { recursive: true, force: true });
  });
  resetEngineModelCatalogRuntimeForTest();
  initializeLocalEngineModelCatalog();
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: root, workspaceId: "ws_cleanup", threadId: "th_cleanup", initialSessionId: null,
    onEngineProcessSnapshot: () => { throw new Error("unavailable model must not spawn"); },
    onSessionId: () => { throw new Error("unavailable model must not start a session"); },
  });
  const input: SendMessageInput = {
    turnId: "turn_cleanup", userItemId: "item_user", text: "test", images: [],
    assistantItemId: "item_assistant", reasoningItemId: "item_reasoning", model: "missing-model",
    systemMessage: "临时提示应在模型不可用时释放",
    toolRegistry: { tools: [{ toolsetId: "tools", toolsetName: "Tools", toolId: "cleanup", name: "Cleanup",
      description: "test", runtime: "node", code: "", permissions: { requiresWrite: false } }] },
    executeHostTool: async () => { throw new Error("unavailable model must not call a tool"); },
  };
  await assert.rejects(session.sendMessage(input, {
    conversation: () => { throw new Error("unavailable model must not emit an engine call"); },
    raw: () => { throw new Error("unavailable model must not emit provider output"); },
  }), { code: "ENGINE_MODEL_NOT_AVAILABLE" });
  assert.equal(servers.length, 1, "exercise a real platform bridge");
  assert.equal(servers[0]!.listening, false);
  assert.deepEqual(await fsp.readdir(root), []);
  assert.equal((session as unknown as { currentPlatformToolNames: Set<string> }).currentPlatformToolNames.size, 0);
});

for (const blocked of ["bridge", "prompt"] as const) {
  test(`dispose revokes dispatch while ${blocked} preparation is pending`, async t => {
    resetEngineModelCatalogRuntimeForTest();
    initializeLocalEngineModelCatalog();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-dispose-barrier-"));
    const mkdtemp = fsp.mkdtemp, createServer = http.createServer;
    const servers: http.Server[] = [];
    let unblock!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    t.mock.method(os, "tmpdir", () => root);
    t.mock.method(http, "createServer", (...args: Parameters<typeof http.createServer>) => {
      const server = createServer(...args); servers.push(server); return server;
    });
    t.mock.method(fsp, "mkdtemp", async (...args: Parameters<typeof fsp.mkdtemp>) => {
      const value = await mkdtemp(...args);
      if (String(args[0]).includes(blocked === "bridge" ? "claude-platform-tools-" : "claude-system-prompt-")) {
        reached(); await gate;
      }
      return value;
    });
    const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("revoked send must never spawn"); });
    syncBuiltinESMExports();
    const session = new ClaudeThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  workspacePath: root, workspaceId: "ws_barrier", threadId: "th_barrier", initialSessionId: null,
      onEngineProcessSnapshot: () => false, onSessionId() {},
    });
    const input: SendMessageInput = {
      turnId: "turn_barrier", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning", text: "test", images: [],
      systemMessage: "pending private prompt", model: "missing-model",
      toolRegistry: { tools: [{ toolsetId: "tools", toolsetName: "Tools", toolId: "test", name: "Test", description: "test", runtime: "node", code: "", permissions: { requiresWrite: false } }] },
      executeHostTool: async () => { throw new Error("must not execute"); },
    };
    const send = () => session.sendMessage(input, { conversation() {}, raw() {} });
    const outcome = send().then(() => ({ ok: true as const }), error => ({ ok: false as const, error: error as unknown }));
    t.after(async () => {
      unblock(); await outcome; t.mock.restoreAll(); syncBuiltinESMExports();
      resetEngineModelCatalogRuntimeForTest();
      await session.dispose();
      for (const server of servers) assert.equal(server.listening, false);
      await fsp.rmdir(root);
    });
    await waiting;
    assert.equal(session.canIdleDispose(), false);
    let disposed = false;
    const disposing = session.dispose().then(() => { disposed = true; });
    await nextTick();
    assert.equal(disposed, false, "dispose 必须等待同一准备边界");
    await assert.rejects(send(), { code: "CLAUDE_PROMPT_RELEASE_PENDING" });
    unblock();
    const result = await outcome;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal((result.error as { code: string }).code, "CLAUDE_PROMPT_DISPATCH_INVALIDATED");
    await disposing;
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(session.canIdleDispose(), true);
    assert.deepEqual(await fsp.readdir(root), []);
    for (const server of servers) assert.equal(server.listening, false);
    await assert.rejects(send(), { code: "ENGINE_MODEL_NOT_AVAILABLE" });
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(session.canIdleDispose(), true);
  });
}
