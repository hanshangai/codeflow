import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_KEY_SWITCH_CONFLICT_REASONS } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import {
  handleEngineKeysActivate,
  handleEngineKeysDelete,
  handleEngineKeysUpsert,
} from "../src/app/handlers/engineKeyHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { createBuiltInRelayCredentialService } from '../src/security/builtInRelayCredentialService.js';
import { ThreadSessionManager } from '../src/engines/threadSessionManager.js';
import type { ClaudeThreadSession } from '../src/engines/claude/claudeThreadSession.js';
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from '../src/engines/engineModelCatalogRuntime.js';
import { logger } from '../src/logger.js';
import { ClientDbWriterService } from '../src/db/clientDbWriterService.js';

test("Key变更在真实Writer下持短许可，重启失败后补偿原快照", async t => {
  const h = setupEngineKeyRestartFailure();
  const writer = new ClientDbWriterService({ dbPath: path.join(h.workspacePath, "client.db"), db: h.db, onFatalError(error) { throw error; } });
  t.after(async () => { try { await writer.close(); } finally { h.cleanup(); } });
  await writer.ready();
  h.ctx.withDatabase = (id, operation) => writer.withLegacyDatabase(id, operation);
  let restartCalled = false;
  h.ctx.sessions.restartCodexProcesses = async () => {
    restartCalled = true;
    assert.throws(() => h.db.engineKeys.list(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    throw new Error("EXPECTED_RESTART_FAILURE");
  };
  await handleEngineKeysActivate(h.ctx, { id: "writer-key", method: "engineKeys.activate", body: { id: h.standby.id } } as ApiRequestMessage);
  assert.equal(restartCalled, true);
  assert.equal(h.sent.at(-1).status, 500);
  assert.match(h.sent.at(-1).body.message, /Key 数据已恢复/u);
  assert.equal(await writer.withLegacyDatabase("verify-key", () => h.db.engineKeys.getActive("codex", "openai")?.id), h.active.id);
});

for (const [engine, providerId] of [['codex', 'openai'], ['claude', 'anthropic']] as const) {
  test(`uninstall-cleared ${engine} keys cannot activate or replace a deleted re-entered key`, () => {
    const h = setupEngineKeyRestartFailure();
    try {
      for (const key of h.db.engineKeys.list()) h.db.engineKeys.delete(key.id);
      const a = h.db.engineKeys.insert({ label: 'cleared-a', engine, providerId, apiKey: 'old-a' });
      const b = h.db.engineKeys.insert({ label: 'cleared-b', engine, providerId, apiKey: 'old-b' });
      const sql = h.db.engineKeys as unknown as { db: import('../src/db/sqliteTypes.js').SqliteDb };
      sql.db.prepare("UPDATE engine_keys SET api_key = ?, is_active = 0 WHERE id IN (?, ?)").run('\u00a0\uFEFF\t', a.id, b.id);
      h.db.engineKeys.blockNativeFallback(engine, providerId);
      assert.throws(() => h.db.engineKeys.activate(b.id), /重新录入|不能为空/u);
      h.db.engineKeys.update(a.id, { apiKey: 're-entered-a' });
      h.db.engineKeys.activate(a.id);
      h.db.engineKeys.delete(a.id);
      assert.equal(h.db.engineKeys.getActive(engine, providerId), null);
      assert.equal(h.db.engineKeys.isNativeFallbackBlocked(engine, providerId), true);
    } finally { h.cleanup(); }
  });

  test(`uninstall-cleared ${engine} fallback skips every blank candidate and retains normal selection`, () => {
    const h = setupEngineKeyRestartFailure();
    try {
      for (const key of h.db.engineKeys.list()) h.db.engineKeys.delete(key.id);
      const valid = h.db.engineKeys.insert({ label: 'valid', engine, providerId, apiKey: 'still-valid' });
      const blank = h.db.engineKeys.insert({ label: 'blank-newest', engine, providerId, apiKey: 'old' });
      const active = h.db.engineKeys.insert({ label: 'active', engine, providerId, apiKey: 'current' });
      const sql = h.db.engineKeys as unknown as { db: import('../src/db/sqliteTypes.js').SqliteDb };
      sql.db.prepare('UPDATE engine_keys SET api_key = ?, updated_at = ? WHERE id = ?').run('\u2003\n', Date.now() + 100_000, blank.id);
      h.db.engineKeys.activate(active.id);
      h.db.engineKeys.delete(active.id);
      assert.equal(h.db.engineKeys.getActive(engine, providerId)?.id, valid.id);
    } finally { h.cleanup(); }
  });
}

test('uninstall-cleared key provider and label editing cannot activate empty material', () => {
  const h = setupEngineKeyRestartFailure();
  try {
    const key = h.db.engineKeys.insert({ label: 'cleared', engine: 'claude', providerId: 'anthropic', apiKey: 'old' });
    const sql = h.db.engineKeys as unknown as { db: import('../src/db/sqliteTypes.js').SqliteDb };
    sql.db.prepare("UPDATE engine_keys SET api_key = '', is_active = 0 WHERE id = ?").run(key.id);
    h.db.engineKeys.blockNativeFallback('claude', 'anthropic');
    h.db.engineKeys.blockNativeFallback('claude', 'zai');
    h.db.engineKeys.update(key.id, { label: 'renamed', providerId: 'zai' });
    assert.equal(h.db.engineKeys.get(key.id)?.isActive, false);
    assert.equal(h.db.engineKeys.isNativeFallbackBlocked('claude', 'anthropic'), true);
    assert.equal(h.db.engineKeys.isNativeFallbackBlocked('claude', 'zai'), true);
  } finally { h.cleanup(); }
});

/** 创建会在 app-server dispose 阶段拒绝 native 配置同步的 Key 测试现场。 */
function setupEngineKeyRestartFailure() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-engine-key-restart-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const active = db.engineKeys.insert({
    label: "active",
    engine: "codex",
    providerId: "openai",
    apiKey: "key-active",
    baseUrl: null,
  });
  const standby = db.engineKeys.insert({
    label: "standby",
    engine: "codex",
    providerId: "openai",
    apiKey: "key-standby",
    baseUrl: null,
  });
  const sent: any[] = [];
  const ctx = {
    db,
    sessions: {
      async restartCodexProcesses() {
        throw new Error("injected dispose failure");
      },
    },
    send(message: any) {
      sent.push(message);
    },
  } as unknown as ApiHandlerContext;
  return {
    db,
    ctx,
    active,
    standby,
    sent,
    workspacePath,
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 为 Key 激活测试补齐一个普通 Codex running turn 与正式中断链所需的最小上下文。 */
function seedRunningCodexTurn(harness: ReturnType<typeof setupEngineKeyRestartFailure>, suffix: string) {
  const workspaceId = `workspace-engine-key-${suffix}` as any;
  const threadId = `thread-engine-key-${suffix}` as any;
  const turnId = `turn-engine-key-${suffix}` as any;
  const workspacePath = harness.workspacePath;
  let seq = 100;
  harness.db.workspaces.upsert({ id: workspaceId, title: "Key 切换测试", path: workspacePath });
  harness.db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Key 切换测试" });
  harness.db.turns.insertStarted({
    workspaceId,
    threadId,
    engine: "codex",
    turnId,
    startedAt: Date.now() - 1_000,
    startEventSeq: 1,
  });
  Object.assign(harness.ctx, {
    workspaces: new Map([[workspaceId, workspacePath]]),
    clientId: "client-engine-key-test",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    threads: new ThreadStore(),
    orchEngine: {},
    onBeforeEmitConversationEvent(event: Record<string, unknown>) {
      harness.db.conversationEvents.appendEnvelope({ ...event, seq: ++seq } as any);
    },
  });
  Object.assign(harness.ctx.sessions, {
    detachCodexProviderGeneration() {},
    async disposeThreadWithOptions() {},
  });
  return { workspaceId, threadId, turnId };
}

/** 真实仓储、凭据和会话生命周期，仅模拟完成态及外部进程释放。 */
async function setupClaudeCustomSwitch(t: test.TestContext) {
  const h = setupEngineKeyRestartFailure(); t.after(h.cleanup);
  const owner = { serverOrigin: 'https://server.example', ownerUserId: 'claude-owner', accountSessionId: 'claude-session', generation: 1 }, secrets = new Map<string, string>();
  const service = createBuiltInRelayCredentialService({ repo: h.db.engineKeys, getOwner: () => owner, assertOwner() {}, releaseOwnerSessions: async () => {}, requestEnsure: async (_owner, request) => ({ providerId: request.providerId, keyId: `claude-server-${request.providerId}`, ownerUserId: owner.ownerUserId, rawKey: 'claude-builtin-secret', baseUrl: 'https://relay.example/v1' }), credentialStore: { get: ref => secrets.get(ref) ?? null, set: (ref, value) => { secrets.set(ref, value); }, delete: ref => { secrets.delete(ref); } } });
  const builtin = await service.ensure({ engine: 'claude', providerId: 'anthropic', requestId: 'builtin' });
  const workspaceId = 'ws-claude-custom-switch' as any, threadId = 'thread-claude-custom-switch' as any, threads = new ThreadStore();
  const thread = threads.create({ threadId, workspaceId, engine: 'claude', title: 'switch' });
  const manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map([[workspaceId, h.workspacePath]]), threads, builtInRelayCredentials: service, resolveClaudeModelProvider: model => model === 'glm-test' ? 'zai' : 'anthropic', sessionIdleCleanup: { enabled: false } });
  const session = manager.getOrCreate(thread) as ClaudeThreadSession, lease = (session as any).opts.acquireCredential({});
  const personal = h.db.engineKeys.insert({ label: 'personal', engine: 'claude', providerId: 'anthropic', apiKey: 'personal-secret' });
  Object.assign(h.ctx, { sessions: manager, builtInRelayCredentials: service });
  return { ...h, service, builtin, personal, manager, session, lease, thread,
    /** 经真实激活处理器提交显式自配选择。 */
    async activate() { await handleEngineKeysActivate(h.ctx, { t: 'api.req', id: 'activate-personal', method: 'engineKeys.activate', path: '', body: { id: personal.id } } as ApiRequestMessage); return h.sent.at(-1); },
  };
}

test('completed Claude builtin switches to explicit custom credentials on the next same-thread send', async t => {
  const h = await setupClaudeCustomSwitch(t); h.lease.release(); await h.service.deactivate(h.builtin.id, 'disable');
  let disposals = 0; t.mock.method(h.session, 'dispose', async () => { disposals += 1; });
  assert.equal((await h.activate()).status, 200); assert.equal(disposals, 1);
  const next = h.manager.getOrCreate(h.thread); assert.notEqual(next, h.session);
  const lease = (next as any).opts.acquireCredential({}); assert.equal(lease.config.apiKey, 'personal-secret'); lease.release();
  initializeLocalEngineModelCatalog(); t.after(resetEngineModelCatalogRuntimeForTest);
  await assert.rejects(next.sendMessage({ turnId: 'turn-custom' as any, userItemId: 'user' as any, text: 'test', images: [], assistantItemId: 'assistant' as any, reasoningItemId: 'reasoning' as any, model: 'missing-model' }, { conversation() {}, raw() {} }), { code: 'ENGINE_MODEL_NOT_AVAILABLE' });
});

for (const accepted of [true, false]) {
  test(`Claude Anthropic custom activation preserves an unrelated ${accepted ? 'accepted' : 'completed'} ZAI session`, async t => {
    const h = await setupClaudeCustomSwitch(t); h.lease.release();
    const zai = await h.service.ensure({ engine: 'claude', providerId: 'zai', requestId: 'builtin-zai' });
    const other = h.manager.createIsolatedSession({ sessionKey: 'isolated-zai', workspaceId: h.thread.workspaceId, engine: 'claude', onSessionId() {} });
    const otherLease = (other.session as any).opts.acquireCredential({ model: 'glm-test' });
    if (!accepted) otherLease.release();
    const disposals: string[] = [];
    t.mock.method(h.session, 'dispose', async () => { disposals.push('anthropic'); });
    t.mock.method(other.session as ClaudeThreadSession, 'dispose', async () => { disposals.push('zai'); });
    const zaiBefore = h.db.engineKeys.get(zai.id);
    try {
      assert.equal((await h.activate()).status, 200);
      assert.deepEqual(disposals, ['anthropic']); assert.equal(h.manager.getExisting('isolated-zai' as any), other.session);
      assert.deepEqual(h.db.engineKeys.get(zai.id), zaiBefore); assert.equal(h.service.isAvailable(zai), true);
      assert.doesNotThrow(() => otherLease.assertCurrent());
      const next = h.service.acquire({ engine: 'claude', providerId: 'zai' }); assert.equal(next.config?.apiKey, 'claude-builtin-secret'); next.release();
      assert.equal(h.db.engineKeys.getActive('claude', 'anthropic')?.id, h.personal.id);
    } finally { otherLease.release(); await h.manager.stopAndDrain(); }
  });
}

test('Claude custom switch preserves an accepted builtin turn and restores its active key', async t => {
  const h = await setupClaudeCustomSwitch(t); let disposals = 0;
  t.mock.method(h.session, 'dispose', async () => { disposals += 1; });
  const response = await h.activate();
  assert.equal(response.status, 409); assert.equal(disposals, 0); assert.equal(h.db.engineKeys.getActive('claude', 'anthropic')?.id, h.builtin.id);
  assert.equal(h.lease.config.apiKey, 'claude-builtin-secret'); h.lease.release();
  assert.equal((await h.activate()).status, 200); assert.equal(disposals, 1);
});

test('Claude custom switch propagates disposal failure and restores the builtin active key', async t => {
  const h = await setupClaudeCustomSwitch(t); h.lease.release();
  const errors: any[] = []; t.mock.method(logger, 'error', (_tag: string, _message: string, context: any) => { errors.push(context); });
  t.mock.method(h.session, 'dispose', async () => { throw new Error('injected Claude disposal failure'); });
  const response = await h.activate();
  assert.equal(response.status, 500); assert.match(response.body.message, /Claude.*失败/u);
  assert.equal(errors.at(-1).requestId, 'activate-personal'); assert.equal(errors.at(-1).rootCause.message, 'injected Claude disposal failure');
  assert.equal(h.db.engineKeys.getActive('claude', 'anthropic')?.id, h.builtin.id); assert.equal(h.manager.getExisting(h.thread.threadId), h.session);
});

test('builtin activation preserves original conflict confirmation and refreshes the existing process before issuing credentials', async () => {
  const harness = setupEngineKeyRestartFailure();
  try {
    const running = seedRunningCodexTurn(harness, 'builtin'), secrets = new Map<string, string>(), order: string[] = [];
    const owner = { serverOrigin: 'https://server.example', ownerUserId: 'user-builtin', accountSessionId: 'session-builtin', generation: 1 };
    const key = harness.db.engineKeys.saveBuiltIn({ label: 'builtin', engine: 'codex', providerId: 'openai', baseUrl: 'https://relay.example/v1', serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId, keyId: 'server-key', secretRef: 'old-reference' });
    harness.ctx.builtInRelayCredentials = createBuiltInRelayCredentialService({ repo: harness.db.engineKeys, getOwner: () => owner, assertOwner() {}, requestEnsure: async () => { order.push('ensure'); return { providerId: 'openai', keyId: 'server-key', ownerUserId: owner.ownerUserId, rawKey: 'new-test-secret', baseUrl: 'https://relay.example/v1' }; }, releaseOwnerSessions: async () => { order.push('release-owner'); }, credentialStore: { get: ref => secrets.get(ref) ?? null, set: (ref, value) => { secrets.set(ref, value); }, delete: ref => { secrets.delete(ref); } } });
    Object.assign(harness.ctx.sessions, { async interrupt() { order.push('interrupt'); return true; }, async restartCodexProcesses() { order.push('restart'); } });
    for (const confirmed of [false, true]) {
      const id = `builtin-activate-${confirmed}`;
      await handleEngineKeysActivate(harness.ctx, { t: 'api.req', id, method: 'engineKeys.activate', path: '/engine-keys/activate', body: { id: key.id, stopRunningTurns: confirmed } } as ApiRequestMessage);
      const response = harness.sent.find(message => message.id === id);
      assert.equal(response.status, confirmed ? 200 : 409, response.body?.message);
      if (!confirmed) { assert.deepEqual(order, []); assert.equal(harness.db.turns.get(running.turnId)?.status, 'started'); }
      else { assert.deepEqual(order, ['interrupt', 'restart', 'release-owner', 'ensure']); assert.equal(response.body.key.apiKey, ''); assert.equal(Object.hasOwn(response.body.key, 'secretRef'), false); }
    }
  } finally { harness.cleanup(); }
});

test("Codex Key activation asks for confirmation without stopping or restarting running turns", async () => {
  const harness = setupEngineKeyRestartFailure();
  const running = seedRunningCodexTurn(harness, "confirm");
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysActivate(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-confirm-running",
      method: "engineKeys.activate",
      path: "/engine-keys/activate",
      body: { id: harness.standby.id },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-confirm-running");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "CONFLICT");
    assert.equal(response?.body?.details?.reason, CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired);
    assert.equal(response?.body?.details?.runningCount, 1);
    assert.equal(response?.body?.details?.runningTurns?.[0]?.turnId, running.turnId);
    assert.equal(interruptCalls, 0);
    assert.equal(restartCalls, 0);
    assert.equal(harness.db.engineKeys.getFirstActiveForEngine("codex")?.id, harness.active.id);
    assert.equal(harness.db.turns.get(running.turnId)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

test("confirmed Codex Key activation settles running turns before restart", async () => {
  const harness = setupEngineKeyRestartFailure();
  const running = seedRunningCodexTurn(harness, "stop-success");
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysActivate(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-stop-running",
      method: "engineKeys.activate",
      path: "/engine-keys/activate",
      body: { id: harness.standby.id, stopRunningTurns: true },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-stop-running");
    assert.equal(response?.status, 200, response?.body?.message);
    assert.equal(interruptCalls, 1);
    assert.equal(restartCalls, 1);
    assert.equal(harness.db.turns.get(running.turnId)?.status, "error");
    assert.equal(harness.db.engineKeys.getFirstActiveForEngine("codex")?.id, harness.standby.id);
    const terminal = harness.db.conversationEvents
      .listByThread(running.threadId)
      .find((event) => event.type === "turn.error");
    assert.equal((terminal?.payload as any)?.terminationKind, "manual_interrupt");
  } finally {
    harness.cleanup();
  }
});

test("failed Codex turn interruption keeps the current Key and skips restart", async () => {
  const harness = setupEngineKeyRestartFailure();
  const running = seedRunningCodexTurn(harness, "stop-failure");
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        throw new Error("injected interrupt failure");
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysActivate(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-stop-failure",
      method: "engineKeys.activate",
      path: "/engine-keys/activate",
      body: { id: harness.standby.id, stopRunningTurns: true },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-stop-failure");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "CONFLICT");
    assert.equal(response?.body?.details?.reason, CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsStopFailed);
    assert.equal(response?.body?.details?.failedCount, 1);
    assert.equal(restartCalls, 0);
    assert.equal(harness.db.engineKeys.getFirstActiveForEngine("codex")?.id, harness.active.id);
    assert.equal(harness.db.turns.get(running.turnId)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

test("running Codex controlled experiments block activation even after ordinary-turn confirmation", async () => {
  const harness = setupEngineKeyRestartFailure();
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    (harness.db.controlledExperiments as any).listRunningForSessionGate = () => [{
      workspaceId: "workspace-experiment",
      threadId: "run-experiment",
      turnId: "turn-experiment",
      engine: "codex",
      startedAt: Date.now() - 1_000,
    }];
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysActivate(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-experiment-running",
      method: "engineKeys.activate",
      path: "/engine-keys/activate",
      body: { id: harness.standby.id, stopRunningTurns: true },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-experiment-running");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "CONFLICT");
    assert.equal(response?.body?.details?.reason, CODEX_KEY_SWITCH_CONFLICT_REASONS.controlledExperimentRunning);
    assert.equal(interruptCalls, 0);
    assert.equal(restartCalls, 0);
    assert.equal(harness.db.engineKeys.getFirstActiveForEngine("codex")?.id, harness.active.id);
  } finally {
    harness.cleanup();
  }
});

test("active Codex Key update asks for confirmation before changing a running Client", async () => {
  const harness = setupEngineKeyRestartFailure();
  const running = seedRunningCodexTurn(harness, "update-confirm");
  const before = harness.db.engineKeys.list();
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-update-confirm-running",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.active.id,
        label: "changed",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-changed",
        baseUrl: null,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-update-confirm-running");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "CONFLICT");
    assert.equal(response?.body?.details?.reason, CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired);
    assert.equal(response?.body?.details?.runningTurns?.[0]?.turnId, running.turnId);
    assert.equal(interruptCalls, 0);
    assert.equal(restartCalls, 0);
    assert.deepEqual(harness.db.engineKeys.list(), before);
    assert.equal(harness.db.turns.get(running.turnId)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

test("first Codex Key insert asks for confirmation before changing a running Client", async () => {
  const harness = setupEngineKeyRestartFailure();
  harness.db.engineKeys.delete(harness.active.id);
  harness.db.engineKeys.delete(harness.standby.id);
  const running = seedRunningCodexTurn(harness, "insert-confirm");
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses() {
        restartCalls += 1;
      },
    });

    await handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-insert-confirm-running",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        label: "first",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-first",
        baseUrl: null,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-insert-confirm-running");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.details?.reason, CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired);
    assert.equal(response?.body?.details?.runningTurns?.[0]?.turnId, running.turnId);
    assert.equal(interruptCalls, 0);
    assert.equal(restartCalls, 0);
    assert.deepEqual(harness.db.engineKeys.list(), []);
  } finally {
    harness.cleanup();
  }
});

test("confirmed active Codex Key update stops running turns before native sync", async () => {
  const harness = setupEngineKeyRestartFailure();
  const running = seedRunningCodexTurn(harness, "update-stop-success");
  let interruptCalls = 0;
  let restartCalls = 0;
  try {
    Object.assign(harness.ctx.sessions, {
      async interrupt() {
        interruptCalls += 1;
        return true;
      },
      async restartCodexProcesses(options?: { beforeKill?: () => void | Promise<void> }) {
        restartCalls += 1;
        await options?.beforeKill?.();
      },
    });

    await handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-update-stop-running",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.active.id,
        label: "changed",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-changed",
        baseUrl: null,
        stopRunningTurns: true,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.id === "req-engine-key-update-stop-running");
    assert.equal(response?.status, 200, response?.body?.message);
    assert.equal(interruptCalls, 1);
    assert.equal(restartCalls, 1);
    assert.equal(harness.db.turns.get(running.turnId)?.status, "error");
    assert.equal(harness.db.engineKeys.get(harness.active.id)?.apiKey, "key-changed");
  } finally {
    harness.cleanup();
  }
});

test("active Codex Key update restores the exact DB snapshot when restart is blocked", async () => {
  const harness = setupEngineKeyRestartFailure();
  try {
    const before = harness.db.engineKeys.list();
    await handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-update-restart-failure",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.active.id,
        label: "changed",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-changed",
        baseUrl: null,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res");
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /Key 数据已恢复/);
    assert.deepEqual(harness.db.engineKeys.list(), before);
  } finally {
    harness.cleanup();
  }
});

test("active Codex Key deletion restores IDs and activation flags when restart is blocked", async () => {
  const harness = setupEngineKeyRestartFailure();
  try {
    const before = harness.db.engineKeys.list();
    await handleEngineKeysDelete(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-delete-restart-failure",
      method: "engineKeys.delete",
      path: "/engine-keys/delete",
      body: { id: harness.active.id },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res");
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /Key 数据已恢复/);
    assert.deepEqual(harness.db.engineKeys.list(), before);
  } finally {
    harness.cleanup();
  }
});

test("same-engine Key mutations stay serialized across restart rollback compensation", async () => {
  const harness = setupEngineKeyRestartFailure();
  let releaseRestart!: () => void;
  let markRestartStarted!: () => void;
  const restartStarted = new Promise<void>((resolve) => { markRestartStarted = resolve; });
  const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
  let activeUpdate: Promise<void> | null = null;
  let standbyUpdate: Promise<void> | null = null;
  try {
    (harness.ctx.sessions as any).restartCodexProcesses = async () => {
      markRestartStarted();
      await restartGate;
      throw new Error("injected delayed restart failure");
    };

    activeUpdate = handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-serialized-active",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.active.id,
        label: "active-pending",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-active-pending",
        baseUrl: null,
      },
    } as ApiRequestMessage);
    await restartStarted;

    standbyUpdate = handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-serialized-standby",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.standby.id,
        label: "standby-after-rollback",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-standby-after-rollback",
        baseUrl: null,
      },
    } as ApiRequestMessage);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.sent.some((message) => message.id === "req-engine-key-serialized-standby"), false);
    assert.equal(harness.db.engineKeys.get(harness.standby.id)?.label, "standby");

    releaseRestart();
    await Promise.all([activeUpdate, standbyUpdate]);

    assert.equal(harness.sent.find((message) => message.id === "req-engine-key-serialized-active")?.status, 500);
    assert.equal(harness.sent.find((message) => message.id === "req-engine-key-serialized-standby")?.status, 200);
    assert.equal(harness.db.engineKeys.get(harness.active.id)?.apiKey, "key-active");
    assert.equal(harness.db.engineKeys.get(harness.standby.id)?.label, "standby-after-rollback");
    assert.equal(harness.db.engineKeys.get(harness.standby.id)?.apiKey, "key-standby-after-rollback");
  } finally {
    releaseRestart?.();
    await Promise.allSettled([activeUpdate, standbyUpdate].filter((value): value is Promise<void> => Boolean(value)));
    harness.cleanup();
  }
});

test("different-engine Key mutations remain parallel while Codex restart is pending", async () => {
  const harness = setupEngineKeyRestartFailure();
  const claude = harness.db.engineKeys.insert({
    label: "claude-active",
    engine: "claude",
    providerId: "anthropic",
    apiKey: "claude-key-active",
    baseUrl: null,
  });
  let releaseRestart!: () => void;
  let markRestartStarted!: () => void;
  const restartStarted = new Promise<void>((resolve) => { markRestartStarted = resolve; });
  const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
  let codexUpdate: Promise<void> | null = null;
  try {
    (harness.ctx.sessions as any).restartCodexProcesses = async () => {
      markRestartStarted();
      await restartGate;
      throw new Error("injected delayed restart failure");
    };

    codexUpdate = handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-parallel-codex",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: harness.active.id,
        label: "codex-pending",
        engine: "codex",
        providerId: "openai",
        apiKey: "key-codex-pending",
        baseUrl: null,
      },
    } as ApiRequestMessage);
    await restartStarted;

    await handleEngineKeysUpsert(harness.ctx, {
      t: "api.req",
      id: "req-engine-key-parallel-claude",
      method: "engineKeys.upsert",
      path: "/engine-keys/upsert",
      body: {
        id: claude.id,
        label: "claude-updated",
        engine: "claude",
        providerId: "anthropic",
        apiKey: "claude-key-updated",
        baseUrl: null,
      },
    } as ApiRequestMessage);

    assert.equal(harness.sent.find((message) => message.id === "req-engine-key-parallel-claude")?.status, 200);
    assert.equal(harness.sent.some((message) => message.id === "req-engine-key-parallel-codex"), false);
    assert.equal(harness.db.engineKeys.get(claude.id)?.apiKey, "claude-key-updated");

    releaseRestart();
    await codexUpdate;
    assert.equal(harness.sent.find((message) => message.id === "req-engine-key-parallel-codex")?.status, 500);
    assert.equal(harness.db.engineKeys.get(claude.id)?.apiKey, "claude-key-updated");
  } finally {
    releaseRestart?.();
    if (codexUpdate) await Promise.allSettled([codexUpdate]);
    harness.cleanup();
  }
});
