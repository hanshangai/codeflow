import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openClientDb } from '../src/db/clientDb.js';
import { createBuiltInRelayCredentialService } from '../src/security/builtInRelayCredentialService.js';

/** 真实 SQLite 与隔离内存秘密仓测试；只替换外部 Server/OS 边界。 */
function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-builtin-credentials-'));
  const dbPath = path.join(root, 'client.db'), db = openClientDb({ dbPath });
  let closed = false;
  /** 重启用例提前关闭原连接，清理时不重复关闭。 */
  function closeDb(): void { if (!closed) { db.close(); closed = true; } }
  t.after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
  let owner = { serverOrigin: 'https://server.example', ownerUserId: 'user-a', accountSessionId: 'session-a', generation: 1 };
  const secrets = new Map<string, string>();
  const writes: string[] = []; let storeFailure: Error | null = null;
  const releasedSessions: { owner: typeof owner; keyId?: string }[] = [];
  let response = async () => ({ providerId: 'openai', keyId: 'server-key-a', ownerUserId: 'user-a', rawKey: 'builtin-secret-a', baseUrl: 'https://relay.example/v1' });
  const service = createBuiltInRelayCredentialService({
    repo: db.engineKeys, getOwner: () => owner,
    assertOwner: snapshot => { if (snapshot !== owner) throw Object.assign(new Error('owner changed'), { code: 'BUILT_IN_RELAY_OWNER_CHANGED' }); },
    requestEnsure: async () => await response(),
    releaseOwnerSessions: async (snapshot, keyId) => { releasedSessions.push({ owner: snapshot, keyId }); },
    credentialStore: { get: key => secrets.get(key) ?? null, set: (key, value) => { if (storeFailure) throw storeFailure; writes.push(key); secrets.set(key, value); }, delete: key => { secrets.delete(key); } },
  });
  return { db, dbPath, closeDb, service, secrets, writes, releasedSessions, failStore: (error: Error) => { storeFailure = error; }, getOwner: () => owner, setOwner: (next: typeof owner) => { owner = next; }, setResponse: (next: typeof response) => { response = next; } };
}

for (const action of ['activate', 'auto'] as const) {
  test(`数据库许可等待后切换账号不能继续旧内置凭据操作：${action}`, async t => {
    const h = setup(t);
    const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'seed' });
    let issued = 0, prepared = 0;
    const snapshot = h.getOwner();
    const service = createBuiltInRelayCredentialService({ repo: h.db.engineKeys, getOwner: h.getOwner,
      assertOwner(owner) { if (owner !== h.getOwner()) throw new Error('OWNER_REVOKED_DURING_DATABASE_WAIT'); },
      async withLegacyDatabase(_id, operation) {
        const result = operation();
        h.setOwner({ ...snapshot, ownerUserId: 'user-b', accountSessionId: 'session-b', generation: 2 });
        return result;
      },
      async requestEnsure() { issued++; throw new Error('MUST_NOT_ISSUE'); },
    });
    const prepareKeySwitch = async () => { prepared++; };
    await assert.rejects(action === 'activate' ? service.activate(key.id, 'activate', prepareKeySwitch)
      : service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'auto', intent: 'auto', prepareKeySwitch }), /OWNER_REVOKED_DURING_DATABASE_WAIT/);
    assert.equal(issued, 0); assert.equal(prepared, 0);
    assert.equal(h.db.engineKeys.get(key.id)?.ownerUserId, snapshot.ownerUserId);
  });
}

test('trusted builtin ensure stores only a reference in SQLite and leaves custom credentials unchanged', async t => {
  const h = setup(t);
  const custom = h.db.engineKeys.insert({ label: 'personal', engine: 'claude', providerId: 'anthropic', apiKey: 'personal-secret' });
  const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'ensure-a' });
  const row = h.db.db.prepare('SELECT api_key, source, owner_user_id, server_key_id, secret_ref FROM engine_keys WHERE id = ?').get(key.id) as any;
  assert.equal(row.api_key, ''); assert.equal(row.source, 'builtin'); assert.equal(row.owner_user_id, 'user-a'); assert.equal(row.server_key_id, 'server-key-a');
  assert.ok(row.secret_ref); assert.equal(h.secrets.get(row.secret_ref), 'builtin-secret-a');
  assert.equal(h.db.engineKeys.get(custom.id)?.apiKey, 'personal-secret');
  assert.equal(h.service.resolveCredentials(key).apiKey, 'builtin-secret-a');
});

test('late ensure from A cannot persist a secret or metadata after switching to B', async t => {
  const h = setup(t); let finish!: (value: any) => void;
  h.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'late-a' });
  await new Promise(resolve => setImmediate(resolve));
  const prior = h.getOwner(); h.setOwner({ ...prior, ownerUserId: 'user-b', accountSessionId: 'session-b', generation: 2 });
  finish({ providerId: 'openai', keyId: 'key-a', ownerUserId: 'user-a', rawKey: 'late-secret', baseUrl: 'https://relay.example/v1' });
  await assert.rejects(pending, /owner changed/);
  assert.equal(h.writes.length, 0); assert.deepEqual(h.db.engineKeys.list(), []);
});

test('persisted builtin material does not authorize a restarted credential service', async t => {
  const h = setup(t); const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const restarted = createBuiltInRelayCredentialService({ repo: h.db.engineKeys, getOwner: h.getOwner, assertOwner: () => {}, requestEnsure: async () => { throw new Error('server unavailable'); }, credentialStore: { get: ref => h.secrets.get(ref) ?? null, set: () => {}, delete: () => {} } });
  assert.throws(() => restarted.resolveCredentials(key), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
});

test('legacy unknown credentials remain stored but cannot dispatch or appear available before re-entry', t => {
  const h = setup(t);
  const saved = h.db.engineKeys.insert({ label: 'legacy', engine: 'codex', providerId: 'openai', apiKey: 'legacy-secret' });
  h.db.db.prepare("UPDATE engine_keys SET source = 'unknown' WHERE id = ?").run(saved.id);
  const legacy = h.db.engineKeys.get(saved.id)!;
  assert.throws(() => h.service.acquire({ engine: 'codex' }), { code: 'CONFLICT' });
  assert.throws(() => h.service.resolveCredentials(legacy), { code: 'CONFLICT' });
  assert.equal(h.service.isAvailable(legacy), false);
  assert.equal(h.service.isScopeBlocked('codex', 'openai'), true);
  assert.equal(h.db.engineKeys.get(saved.id)?.apiKey, 'legacy-secret');
  h.db.engineKeys.update(saved.id, { apiKey: 're-entered-secret' });
  assert.equal(h.service.acquire({ engine: 'codex' }).config?.apiKey, 're-entered-secret');
});

test('deleted builtin scope remains blocked after reopening the database until explicit re-enable', async t => {
  const h = setup(t), key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  await h.service.delete(key.id, 'delete');
  h.closeDb();
  const reopened = openClientDb({ dbPath: h.dbPath });
  try {
  let ensureCalls = 0;
  const restarted = createBuiltInRelayCredentialService({ repo: reopened.engineKeys, getOwner: h.getOwner, assertOwner: () => {}, requestEnsure: async () => { ensureCalls += 1; return { providerId: 'openai', keyId: 're-enabled', ownerUserId: 'user-a', rawKey: 're-enabled-secret', baseUrl: 'https://relay.example/v1' }; }, credentialStore: { get: ref => h.secrets.get(ref) ?? null, set: (ref, value) => { h.secrets.set(ref, value); }, delete: ref => { h.secrets.delete(ref); } } });
  assert.throws(() => restarted.acquire({ engine: 'codex' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  assert.equal(restarted.isScopeBlocked('codex', 'openai'), true);
  assert.equal(restarted.isScopeBlocked('claude', 'anthropic'), false);
  assert.equal(restarted.acquire({ engine: 'claude', providerId: 'anthropic' }).config, null);
  await assert.rejects(restarted.ensure({ engine: 'codex', providerId: 'openai', requestId: 'automatic-retry', intent: 'auto' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  assert.equal(ensureCalls, 0); assert.equal(h.secrets.size, 0);
  assert.equal(restarted.isScopeBlocked('codex', 'openai'), true);
  const replacement = await restarted.ensure({ engine: 'codex', providerId: 'openai', requestId: 'explicit-enable' });
  assert.equal(restarted.isScopeBlocked('codex', 'openai'), false);
  assert.equal(restarted.resolveCredentials(replacement).apiKey, 're-enabled-secret');
  } finally { reopened.close(); }
});

test('failed deletion intent write stops secret deletion and keeps the current key authorized', async t => {
  const h = setup(t), key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const failure = new Error('intent storage unavailable');
  t.mock.method(h.db.engineKeys, 'blockNativeFallback', () => { throw failure; });
  await assert.rejects(h.service.delete(key.id, 'delete'), error => error === failure);
  assert.equal(h.db.engineKeys.get(key.id)?.isActive, true);
  assert.equal(h.secrets.size, 1); assert.equal(h.service.isAvailable(key), true);
});

test('explicit custom selection clears only its own persisted deletion intent', async t => {
  const h = setup(t);
  const builtin = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  await h.service.delete(builtin.id, 'delete');
  h.db.engineKeys.blockNativeFallback('claude', 'anthropic');
  const custom = h.db.engineKeys.insert({ label: 'personal', engine: 'codex', providerId: 'openai', apiKey: 'personal-secret' });
  h.service.confirmUserConfigured(custom);
  assert.equal(h.db.engineKeys.isNativeFallbackBlocked('codex', 'openai'), false);
  assert.equal(h.db.engineKeys.isNativeFallbackBlocked('claude', 'anthropic'), true);
  h.db.engineKeys.deactivate(custom.id);
  assert.equal(h.service.isScopeBlocked('codex', 'openai'), false);
  assert.equal(h.service.acquire({ engine: 'codex', providerId: 'openai' }).config, null);
});

test('owner invalidation blocks new dispatch immediately and drains only after accepted turn releases', async t => {
  const h = setup(t); await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const lease = h.service.acquire({ engine: 'codex', threadId: 'thread-a', turnId: 'turn-a' });
  assert.equal(lease.config?.apiKey, 'builtin-secret-a');
  let drained = false; const draining = h.service.invalidateOwner(h.getOwner()).then(() => { drained = true; });
  assert.throws(() => h.service.acquire({ engine: 'codex', threadId: 'thread-next', turnId: 'turn-next' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  assert.equal(lease.config?.apiKey, 'builtin-secret-a'); lease.release(); await draining; assert.equal(drained, true);
});

test('Server response owner mismatch fails before any secret or database side effect', async t => {
  const h = setup(t); h.setResponse(async () => ({ providerId: 'openai', keyId: 'other-key', ownerUserId: 'user-other', rawKey: 'other-secret', baseUrl: 'https://relay.example/v1' }));
  await assert.rejects(h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'wrong-owner' }), { code: 'BUILT_IN_RELAY_OWNER_MISMATCH' });
  assert.equal(h.writes.length, 0); assert.deepEqual(h.db.engineKeys.list(), []);
});

test('OS secret failure leaves metadata and activation untouched', async t => {
  const h = setup(t), cause = new Error('OS unavailable'); h.failStore(cause);
  await assert.rejects(h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'os-failure' }), error => error === cause);
  assert.deepEqual(h.db.engineKeys.list(), []); assert.equal(h.secrets.size, 0);
});

test('activation failure retains an unavailable metadata row and cleans only its newly managed secret', async t => {
  const h = setup(t), cause = new Error('activation write failed');
  t.mock.method(h.db.engineKeys, 'activate', () => { throw cause; });
  await assert.rejects(h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'activation-failure' }), error => error === cause);
  const rows = h.db.engineKeys.list(); assert.equal(rows.length, 1); assert.equal(rows[0]!.isActive, false);
  assert.equal(h.secrets.size, 0); assert.throws(() => h.service.resolveCredentials(rows[0]!), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
});

test('explicit builtin deactivation and deletion never fall back to native authentication or standby keys', async t => {
  const h = setup(t); const builtin = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const standby = h.db.engineKeys.insert({ label: 'standby', engine: 'codex', providerId: 'openai', apiKey: 'standby-secret' });
  await h.service.deactivate(builtin.id, 'deactivate');
  assert.equal(h.db.engineKeys.get(standby.id)?.isActive, false);
  assert.throws(() => h.service.acquire({ engine: 'codex' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  await h.service.delete(builtin.id, 'delete');
  assert.equal(h.db.engineKeys.get(standby.id)?.isActive, false);
  assert.throws(() => h.service.acquire({ engine: 'codex' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
});

test('failed refresh revokes prior runtime permission while accepted turn keeps its frozen credential', async t => {
  const h = setup(t); const builtin = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const lease = h.service.acquire({ engine: 'codex' });
  h.setResponse(async () => { throw new Error('server unavailable'); });
  const refresh = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'refresh' });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => h.service.resolveCredentials(builtin), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  assert.equal(lease.config?.apiKey, 'builtin-secret-a'); lease.release();
  await assert.rejects(refresh, /server unavailable/);
});

test('refresh drains and releases only the target key while another provider keeps its accepted and new operations', async t => {
  const h = setup(t), codex = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'codex-initial' });
  h.setResponse(async () => ({ providerId: 'anthropic', keyId: 'server-key-b', ownerUserId: 'user-a', rawKey: 'builtin-secret-b', baseUrl: 'https://relay.example/anthropic' }));
  const claude = await h.service.ensure({ engine: 'claude', providerId: 'anthropic', requestId: 'claude-initial' });
  const codexLease = h.service.acquire({ engine: 'codex' }), claudeLease = h.service.acquire({ engine: 'claude', providerId: 'anthropic' });
  let ensureCalls = 0;
  h.setResponse(async () => { ensureCalls += 1; return { providerId: 'openai', keyId: 'server-key-a', ownerUserId: 'user-a', rawKey: 'replacement-secret', baseUrl: 'https://relay.example/v1' }; });
  const refreshing = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'codex-refresh' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => codexLease.assertCurrent(), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
    assert.doesNotThrow(() => claudeLease.assertCurrent());
    assert.equal(h.service.isAvailable(claude), true); assert.equal(ensureCalls, 0);
    codexLease.release();
    await refreshing;
    assert.equal(ensureCalls, 1);
    assert.deepEqual(h.releasedSessions, [{ owner: h.getOwner(), keyId: codex.id }]);
    assert.doesNotThrow(() => claudeLease.assertCurrent());
    const nextClaude = h.service.acquire({ engine: 'claude', providerId: 'anthropic' });
    assert.equal(nextClaude.config?.apiKey, 'builtin-secret-b'); nextClaude.release();
  } finally { codexLease.release(); claudeLease.release(); await refreshing; }
});

test('another account cannot deactivate or delete persisted builtin credentials', async t => {
  const h = setup(t); const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  h.setOwner({ ...h.getOwner(), ownerUserId: 'user-b', accountSessionId: 'session-b', generation: 2 });
  await assert.rejects(h.service.deactivate(key.id, 'wrong-owner-disable'), { code: 'BUILT_IN_RELAY_OWNER_MISMATCH' });
  await assert.rejects(h.service.delete(key.id, 'wrong-owner-delete'), { code: 'BUILT_IN_RELAY_OWNER_MISMATCH' });
  assert.equal(h.db.engineKeys.get(key.id)?.isActive, true); assert.equal(h.secrets.size, 1);
});

test('delete and refresh serialize across accepted turn drainage without orphaning a replacement secret', async t => {
  const h = setup(t); const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const lease = h.service.acquire({ engine: 'codex' });
  const deleting = h.service.delete(key.id, 'delete');
  await new Promise(resolve => setImmediate(resolve));
  const refreshing = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'refresh' });
  lease.release(); await deleting; const replacement = await refreshing;
  assert.ok(h.db.engineKeys.get(replacement.id)); assert.equal(h.secrets.size, 1);
  assert.equal(h.service.resolveCredentials(replacement).apiKey, 'builtin-secret-a');
});

test('owner switch while delete is draining cannot remove prior account material', async t => {
  const h = setup(t); const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const lease = h.service.acquire({ engine: 'codex' }); const deleting = h.service.delete(key.id, 'delete');
  await new Promise(resolve => setImmediate(resolve));
  h.setOwner({ ...h.getOwner(), ownerUserId: 'user-b', accountSessionId: 'session-b', generation: 2 });
  lease.release(); await assert.rejects(deleting, /owner changed/);
  assert.ok(h.db.engineKeys.get(key.id)); assert.equal(h.secrets.size, 1);
});

test('missing OS material rejects new operations while an accepted turn retains frozen credentials', async t => {
  const h = setup(t); const key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const lease = h.service.acquire({ engine: 'codex' }); h.secrets.clear();
  assert.throws(() => h.service.acquire({ engine: 'codex' }), { code: 'BUILT_IN_RELAY_SECRET_MISSING' });
  assert.equal(lease.config?.apiKey, 'builtin-secret-a'); lease.release();
  assert.equal(h.service.isAvailable(key), false);
});

test('first failed builtin ensure blocks default-provider native fallback without requiring a metadata row', async t => {
  const h = setup(t); h.setResponse(async () => { throw new Error('server unavailable'); });
  await assert.rejects(h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'first-failure' }), /server unavailable/);
  assert.deepEqual(h.db.engineKeys.list(), []);
  assert.throws(() => h.service.acquire({ engine: 'codex' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  assert.throws(() => h.service.acquire({ engine: 'codex', providerId: 'openai' }), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  assert.equal(h.service.isScopeBlocked('codex', 'openai'), true);
});

test('key switch preparation remains inside the original mutation queue and fences its await', async t => {
  const h = setup(t); let entered!: () => void, resume!: () => void;
  const prepared = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { resume = resolve; });
  const pending = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'queued', prepareKeySwitch: async () => { entered(); await waiting; } });
  await prepared; h.setOwner({ ...h.getOwner(), ownerUserId: 'user-b', accountSessionId: 'session-b', generation: 2 }); resume();
  await assert.rejects(pending, /owner changed/); assert.equal(h.writes.length, 0); assert.deepEqual(h.db.engineKeys.list(), []);
});

test('an unconfirmed key switch conflict does not revoke the current builtin permission', async t => {
  const h = setup(t), key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  const conflict = Object.assign(new Error('confirmation required'), { code: 'CONFLICT' });
  await assert.rejects(h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'unconfirmed', prepareKeySwitch: async () => { throw conflict; } }), error => error === conflict);
  assert.equal(h.service.resolveCredentials(key).apiKey, 'builtin-secret-a'); assert.equal(h.writes.length, 1);
});

test('queued deactivation revokes the replacement permission created by an in-flight refresh', async t => {
  const h = setup(t), key = await h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'initial' });
  let finish!: (value: any) => void; h.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const refresh = h.service.ensure({ engine: 'codex', providerId: 'openai', requestId: 'refresh' });
  await new Promise(resolve => setImmediate(resolve));
  const disabling = h.service.deactivate(key.id, 'queued-disable');
  finish({ providerId: 'openai', keyId: 'server-key-a', ownerUserId: 'user-a', rawKey: 'replacement-secret', baseUrl: 'https://relay.example/v1' });
  await refresh; const deactivated = await disabling;
  assert.equal(deactivated.isActive, false); assert.equal(h.service.isAvailable(deactivated), false);
  assert.throws(() => h.service.resolveCredentials(deactivated), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
});
