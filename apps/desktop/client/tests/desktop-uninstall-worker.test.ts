import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fork, type Serializable } from 'node:child_process';
import { terminateCliProcessTree } from '../src/app/handlers/engineHandlers.js';
import type { ThreadId, WorkspaceId } from '@codeflowai/shared';
import { openClientDb } from '../src/db/clientDb.js';
import { openSqliteDb, type SqliteDb } from '../src/db/sqliteDb.js';
import { EngineKeyRepo } from '../src/db/repos/engineKeyRepo.js';
import { parseDesktopReinstallRequest, parseDesktopUninstallRequest, runDesktopReinstallLocalTasks, runDesktopUninstallCleanup } from '../src/desktopUninstallWorker.js';
import { scheduledTaskRuntimeKey } from '../src/db/repos/scheduledTaskRuntimeStateRepo.js';
import { pathToFileURL } from 'node:url';

/** 真实库及配置只建在本次隔离目录，关闭业务连接后交维护入口。 */
function fixture(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'codeflowai.db'), configPath = path.join(dataDir, 'config.json');
  const db = openClientDb({ dbPath });
  db.db.prepare("INSERT INTO meta(key, value) VALUES ('client_id', 'stable-client')").run();
  const custom = db.engineKeys.insert({ label: '保留标签', engine: 'codex', providerId: 'openai', apiKey: 'custom-secret', baseUrl: 'https://custom.example/v1' });
  const origin = 'https://server.example', owner = 'local-owner', keyId = 'server-key';
  const ref = `builtin-relay:${crypto.createHash('sha256').update(`${origin}:${owner}`).digest('hex')}:${keyId}:${crypto.randomUUID()}`;
  const builtin = db.engineKeys.saveBuiltIn({ label: '内置', engine: 'claude', providerId: 'anthropic', baseUrl: 'https://relay.example/v1', serverOrigin: origin, ownerUserId: owner, keyId, secretRef: ref });
  db.engineKeys.activate(builtin.id);
  db.db.prepare("INSERT INTO meta(key, value) VALUES ('history-marker', 'preserved')").run();
  const before = db.engineKeys.list();
  db.close();
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: 'plain_sqlite', ownership: 'local_os_user', initializationState: 'ready' }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({ clientId: 'stable-client', apiKey: 'cloud-secret', serverWs: 'wss://server.example/ws/client', custom: { keep: true } }), 'utf8');
  const secrets = new Map([[ref, 'builtin-secret'], ['independent-native', 'untouched']]);
  const store = { get: (key: string) => secrets.get(key) ?? null, set: (key: string, value: string) => { secrets.set(key, value); }, delete: (key: string) => { secrets.delete(key); } };
  const input = { schemaVersion: 1 as const, requestId: 'uninstall-request', dataDir, clientId: 'stable-client', deviceId: crypto.randomUUID() };
  return { dataDir, dbPath, configPath, input, custom, builtin, ref, before, secrets, store };
}

test('uninstall refuses an unowned migration archive before clearing current credentials', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dataDir, 'legacy-client-migration'));
  const before = fs.readFileSync(f.configPath);
  assert.throws(() => runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), /MIGRATION_ARCHIVE_OWNER_MISSING/u);
  assert.deepEqual(fs.readFileSync(f.configPath), before);
  assert.equal(f.secrets.get(f.ref), 'builtin-secret');
});

test('uninstall repo stops managed scopes without taking independent native scopes', t => {
  const f = fixture(t), db = openSqliteDb(f.dbPath, { fileMustExist: true });
  try {
    const repo = new EngineKeyRepo(db);
    repo.blockNativeFallback('claude', 'zai');
    repo.beginDesktopUninstallCredentialCleanup();
    assert.equal(repo.list().some(key => key.isActive), false);
    assert.equal(repo.isNativeFallbackBlocked('codex', 'openai'), true);
    assert.equal(repo.isNativeFallbackBlocked('claude', 'anthropic'), true);
    assert.equal(repo.isNativeFallbackBlocked('claude', 'zai'), true);
    assert.equal(repo.isNativeFallbackBlocked('claude', 'deepseek'), false);
    assert.equal(f.secrets.get('independent-native'), 'untouched');
  } finally { db.close(); }
});

test('uninstall repo with no managed rows preserves an independent native scope', t => {
  const f = fixture(t), db = openSqliteDb(f.dbPath, { fileMustExist: true });
  try {
    db.prepare('DELETE FROM engine_keys').run();
    const repo = new EngineKeyRepo(db);
    repo.beginDesktopUninstallCredentialCleanup();
    assert.equal(repo.isNativeFallbackBlocked('codex'), false);
    assert.equal(repo.isNativeFallbackBlocked('claude'), false);
  } finally { db.close(); }
});

/** 每次观察都重开真实 SQLite，并保证测试观察连接自己关闭。 */
function inspect<T>(file: string, operation: (db: SqliteDb, repo: EngineKeyRepo) => T): T {
  const db = openSqliteDb(file, { fileMustExist: true });
  try { return operation(db, new EngineKeyRepo(db)); }
  finally { db.close(); }
}

/** 通过原 ClientDb 造应用/工作区真实本机任务，保留配置、凭据和水位快照。 */
function reinstallFixture(t: TestContext) {
  const f = fixture(t), project = path.join(f.dataDir, 'project'); fs.mkdirSync(project);
  const workspaceId = 'stable-client:project' as WorkspaceId, oldDeviceId = f.input.deviceId, nextDeviceId = crypto.randomUUID();
  const db = openClientDb({ dbPath: f.dbPath });
  try {
    db.workspaces.upsert({ id: workspaceId, title: '保留本机任务', path: project });
    for (const scope of [null, workspaceId]) db.withLocalScheduledTasks(scope, repos => {
      const id = scope ? 'workspace-reinstall-task' : 'application-reinstall-task';
      repos.configs.create({ config: { id, source: 'local', clientId: f.input.clientId, deviceId: oldDeviceId,
        workspaceScope: scope ? { scopeType: 'local_workspace', scopeId: scope } : null,
        name: '保留任务', description: '只接续设备归属', taskType: 'script', cronExpr: '* * * * *', timezone: 'UTC', enabled: true,
        payload: { shell: 'sh', command: 'true', ...(scope ? { contextWorkspaceId: scope } : {}) },
        concurrencyPolicy: 'queue_one', missedPolicy: 'skip_missed', timeoutMs: 10_000 }, at: 100 });
      repos.runtime.markStarted({ taskId: scheduledTaskRuntimeKey(id, 'local'), clientId: f.input.clientId,
        deviceId: oldDeviceId, runId: 'old-running-' + id, scheduledAt: 101, startedAt: 102 });
      repos.runtime.queueLocalConcurrency({ taskId: id, clientId: f.input.clientId, deviceId: oldDeviceId,
        runId: 'old-running-' + id, scheduledAt: 103, at: 104 });
      repos.runs.create({ expectedConfigRevision: 1, run: { id: 'old-history-' + id, taskId: id, clientId: f.input.clientId,
        deviceId: oldDeviceId, workspaceId: scope, workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null,
        scheduledAt: 95, startedAt: null, finishedAt: 95, status: 'skipped', triggerSource: 'schedule', attempt: 1, durationMs: null,
        summary: '保留历史', errorMessage: null, outputExcerpt: null, createdAt: 95 } });
    });
  } finally { db.close(); }
  const files = [f.dbPath, path.join(project, '.codeflowai/workspace.db')];
  /** 逐物理库只读原行，不通过任务列表过滤历史或墓碑。 */
  const snapshot = () => files.map(file => inspect(file, connection => ({
    configs: connection.prepare('SELECT * FROM scheduled_task_configs ORDER BY id').all() as Record<string, unknown>[],
    runtime: connection.prepare('SELECT * FROM scheduled_task_runtime_states ORDER BY task_id').all() as Record<string, unknown>[],
    runs: connection.prepare('SELECT * FROM scheduled_task_runs ORDER BY id').all(),
  })));
  const input = { schemaVersion: 1 as const, action: 'reinstall_local_tasks' as const, requestId: 'reinstall-request',
    dataDir: f.dataDir, clientId: f.input.clientId, oldDeviceId, nextDeviceId };
  return { ...f, input, files, snapshot, beforeTasks: snapshot(), configBefore: fs.readFileSync(f.configPath),
    metadataBefore: fs.readFileSync(f.dbPath + '.meta.json') };
}

test('reinstall worker rebinds real application/workspace tasks without reclearing credentials or changing task watermarks', t => {
  const f = reinstallFixture(t);
  assert.deepEqual(runDesktopReinstallLocalTasks(f.input), { rebound: 2, unchanged: 0 });
  const expected = f.beforeTasks.map(scope => ({ ...scope,
    configs: scope.configs.map(row => ({ ...row, device_id: f.input.nextDeviceId })),
    runtime: scope.runtime.map(row => ({ ...row, device_id: f.input.nextDeviceId })),
  }));
  assert.deepEqual(f.snapshot(), expected);
  assert.deepEqual(runDesktopReinstallLocalTasks(f.input), { rebound: 0, unchanged: 2 });
  assert.deepEqual(f.snapshot(), expected);
  assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
  assert.deepEqual(fs.readFileSync(f.dbPath + '.meta.json'), f.metadataBefore);
  inspect(f.dbPath, (_db, repo) => assert.deepEqual(repo.list(), f.before));
  assert.equal(f.secrets.get(f.ref), 'builtin-secret');
});

test('reinstall protocol accepts only explicit exact fields without evaluating accessors', () => {
  const input = { schemaVersion: 1, action: 'reinstall_local_tasks', requestId: 'reinstall:req', dataDir: path.resolve('isolated-reinstall'),
    clientId: 'stable-client', oldDeviceId: crypto.randomUUID(), nextDeviceId: crypto.randomUUID() };
  assert.deepEqual(parseDesktopReinstallRequest(input), input);
  let reads = 0;
  for (const value of [{ ...input, action: 'cleanup' }, { ...input, action: undefined }, { ...input, deviceId: input.oldDeviceId },
    { ...input, schemaVersion: 2 }, { ...input, nextDeviceId: input.oldDeviceId }, { ...input, oldDeviceId: 'old' },
    { ...input, clientId: ' stable-client' }, { ...input, requestId: 'bad\nrequest' }, { ...input, [Symbol('extra')]: true },
    Object.defineProperty({ ...input }, 'clientId', { get() { reads++; return input.clientId; } })]) {
    assert.throws(() => parseDesktopReinstallRequest(value), /DESKTOP_REINSTALL_REQUEST_INVALID/u);
  }
  assert.equal(reads, 0);
  assert.throws(() => parseDesktopReinstallRequest({ ...input, dataDir: '../relative' }), /DESKTOP_REINSTALL_PATH_INVALID/u);
  assert.throws(() => parseDesktopUninstallRequest(input), /DESKTOP_UNINSTALL_REQUEST_INVALID/u);
});

for (const invalid of ['pending', 'account', 'missing-db', 'wrong-config-client', 'wrong-db-client', 'bad-config', 'workspace-kind', 'future-schema', 'missing-column'] as const) {
  test(`reinstall ${invalid} preflight rejects before writable ClientDb and preserves credentials`, t => {
    const f = reinstallFixture(t), config = fs.readFileSync(f.configPath), keys = f.before;
    if (invalid === 'pending' || invalid === 'account') fs.writeFileSync(f.dbPath + '.meta.json', JSON.stringify({ schemaVersion: 3,
      storageMode: 'plain_sqlite', ownership: invalid === 'account' ? 'account' : 'local_os_user', initializationState: invalid === 'pending' ? 'pending' : 'ready' }), 'utf8');
    if (invalid === 'missing-db') fs.renameSync(f.dbPath, f.dbPath + '.saved');
    if (invalid === 'wrong-db-client') inspect(f.dbPath, db => db.prepare("UPDATE meta SET value='different-client' WHERE key='client_id'").run());
    if (invalid === 'bad-config') fs.writeFileSync(f.configPath, '{broken', 'utf8');
    if (invalid === 'workspace-kind') inspect(f.dbPath, db => db.pragma('application_id = 1128683347'));
    if (invalid === 'future-schema') inspect(f.dbPath, db => db.pragma('user_version = 1000000'));
    if (invalid === 'missing-column') inspect(f.dbPath, db => db.exec('ALTER TABLE engine_keys DROP COLUMN secret_ref'));
    let opened = false;
    assert.throws(() => runDesktopReinstallLocalTasks({ ...f.input, ...(invalid === 'wrong-config-client' ? { clientId: 'other-client' } : {}) },
      { openClientDb() { opened = true; throw new Error('MUST_NOT_OPEN_WRITABLE_DB'); } }));
    assert.equal(opened, false);
    if (invalid !== 'bad-config') assert.deepEqual(fs.readFileSync(f.configPath), config);
    if (invalid === 'missing-db') assert.equal(fs.existsSync(f.dbPath), false);
    else if (invalid !== 'missing-column') inspect(f.dbPath, (_db, repo) => assert.deepEqual(repo.list(), keys));
    assert.equal(f.secrets.get(f.ref), 'builtin-secret');
  });
}

for (const phase of ['close', 'business-and-close', 'false-and-close', 'undefined-and-close', 'invalid-result'] as const) {
  test(`reinstall ${phase} explicitly fails after closing original ClientDb and retains both causes`, t => {
    const f = reinstallFixture(t), secondary = new Error('injected-client-close'), primary = new Error('injected-rebind');
    let closed = 0, methodCalls = 0;
    const open: typeof openClientDb = options => {
      assert.equal(options?.existingOnly, true);
      const db = openClientDb(options);
      return new Proxy(db, { get(target, key) {
        if (key === 'rebindLocalScheduledTasksForDesktopReinstall') return () => {
          methodCalls++;
          if (phase.endsWith('-and-close')) throw phase === 'false-and-close' ? false : phase === 'undefined-and-close' ? undefined : primary;
          return phase === 'invalid-result' ? { rebound: -1, unchanged: 0 } : { rebound: 0, unchanged: 0 };
        };
        if (key === 'close') return () => { target.close(); closed++; if (phase !== 'invalid-result') throw secondary; };
        return Reflect.get(target, key);
      } });
    };
    assert.throws(() => runDesktopReinstallLocalTasks(f.input, { openClientDb: open }), error => {
      if (phase.endsWith('-and-close')) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [phase === 'false-and-close' ? false : phase === 'undefined-and-close' ? undefined : primary, secondary]);
      } else if (phase === 'invalid-result') assert.match(String(error), /DESKTOP_REINSTALL_RESULT_INVALID/u);
      else assert.equal(error, secondary);
      return true;
    });
    assert.equal(methodCalls, 1); assert.equal(closed, 1);
    assert.deepEqual(f.snapshot(), f.beforeTasks);
    assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
  });
}

test('reinstall identity verification close failure prevents opening writable ClientDb', t => {
  const f = reinstallFixture(t), secondary = new Error('injected-identity-close');
  let opened = false, closed = 0;
  assert.throws(() => runDesktopReinstallLocalTasks(f.input, {
    openDb(file, options) {
      assert.equal(options?.fileMustExist, true); assert.equal(options?.readonly, true);
      const db = openSqliteDb(file, options);
      return new Proxy(db, { get(target, key) {
        if (key === 'close') return () => { target.close(); closed++; throw secondary; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    openClientDb() { opened = true; throw new Error('MUST_NOT_OPEN_WRITABLE_DB'); },
  }), error => error === secondary);
  assert.equal(closed, 1); assert.equal(opened, false);
  assert.deepEqual(f.snapshot(), f.beforeTasks);
});

for (const target of ['database', 'metadata', 'config', 'sidecar', 'directory'] as const) {
  test(`reinstall ${target} physical path substitution rejects without opening ClientDb or touching external files`, t => {
    const f = reinstallFixture(t), external = fs.mkdtempSync(path.join(os.tmpdir(), 'reinstall-external-'));
    t.after(() => fs.rmSync(external, { recursive: true }));
    let input = f.input, protectedFile: string | undefined, protectedBytes: Buffer | undefined;
    if (target === 'directory') {
      const link = path.join(external, 'data-link'); fs.symlinkSync(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      input = { ...input, dataDir: link };
    } else {
      const file = target === 'database' ? f.dbPath : target === 'metadata' ? f.dbPath + '.meta.json'
        : target === 'config' ? f.configPath : f.dbPath + '-wal';
      const original = path.join(external, 'untouched');
      if (fs.existsSync(file)) fs.renameSync(file, original); else fs.writeFileSync(original, 'sidecar-marker', 'utf8');
      fs.linkSync(original, file);
      protectedFile = original; protectedBytes = fs.readFileSync(original);
    }
    let opened = false;
    assert.throws(() => runDesktopReinstallLocalTasks(input, { openClientDb() { opened = true; throw new Error('MUST_NOT_OPEN_WRITABLE_DB'); } }), /PATH_INVALID/u);
    assert.equal(opened, false); assert.equal(f.secrets.get(f.ref), 'builtin-secret');
    if (protectedFile) assert.deepEqual(fs.readFileSync(protectedFile), protectedBytes);
  });
}

test('uninstall consumer clears managed secrets across reopen and keeps history and independent native files', t => {
  const f = fixture(t), native = path.join(f.dataDir, 'independent-native.json');
  const history = openClientDb({ dbPath: f.dbPath });
  const workspaceId = 'uninstall-history-workspace' as WorkspaceId, threadId = 'uninstall-history-thread' as ThreadId;
  const tables = ['workspaces', 'threads', 'conversation_events', 'raw_engine_events'];
  let historyBefore: unknown[][];
  try {
    history.workspaces.upsert({ id: workspaceId, title: '保留工作区', path: f.dataDir });
    history.threads.create({ id: threadId, workspaceId, engine: 'codex', title: '保留会话' });
    history.conversationEvents.appendEnvelope({ schema: 1, seq: 101, ts: 1_800_000_000_000, workspaceId, threadId, engine: 'codex', type: 'turn.started', payload: { turnId: 'uninstall-history-turn' as never } });
    history.rawEvents.appendEnvelope({ schema: 1, seq: 102, ts: 1_800_000_000_001, workspaceId, threadId, engine: 'codex', source: 'uninstall-test', data: { original: '保留原始事件' }, handled: true, action: 'mapped', emittedTypes: ['turn.started'] });
    historyBefore = tables.map(table => history.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.ok(historyBefore.every(rows => rows.length === 1));
  } finally { history.close(); }
  fs.writeFileSync(native, 'independent-cli-login', 'utf8');
  assert.deepEqual(runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), { cleanedKeys: 2 });
  inspect(f.dbPath, (db, repo) => {
    const keys = repo.list();
    assert.deepEqual(keys.map(key => ({ ...key, apiKey: '', secretRef: null, isActive: false })),
      f.before.map(key => ({ ...key, apiKey: '', secretRef: null, isActive: false })));
    assert.equal(keys.every(key => key.apiKey === '' && key.secretRef === null && !key.isActive), true);
    assert.deepEqual(db.prepare("SELECT value FROM meta WHERE key = 'history-marker'").get(), { value: 'preserved' });
    assert.equal(repo.isNativeFallbackBlocked('codex', 'openai'), true);
    assert.equal(repo.isNativeFallbackBlocked('claude', 'anthropic'), true);
  });
  assert.equal(f.secrets.has(f.ref), false);
  assert.equal(f.secrets.get('independent-native'), 'untouched');
  assert.equal(fs.readFileSync(native, 'utf8'), 'independent-cli-login');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), { clientId: 'stable-client', apiKey: '', serverWs: 'wss://server.example/ws/client', custom: { keep: true } });
  assert.equal(fs.readFileSync(f.dbPath).includes(Buffer.from('custom-secret')), false);
  const reader = openSqliteDb(f.dbPath, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(tables.map(table => reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), historyBefore); }
  finally { reader.close(); }
  assert.deepEqual(runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), { cleanedKeys: 2 });
});

for (const failure of ['get', 'delete', 'still-present'] as const) {
  test(`uninstall store ${failure} fails explicitly, leaves references and supports same-scope retry`, t => {
    const f = fixture(t), error = new Error(`injected store ${failure}`);
    const failing = { ...f.store, get: (ref: string) => { if (failure === 'get') throw error; return f.store.get(ref); },
      delete: (ref: string) => { if (failure === 'delete') throw error; if (failure !== 'still-present') f.store.delete(ref); } };
    assert.throws(() => runDesktopUninstallCleanup(f.input, { credentialStore: failing }), failure === 'still-present' ? /SECRET_DELETE_FAILED/u : candidate => candidate === error);
    inspect(f.dbPath, (_db, repo) => {
      assert.equal(repo.get(f.builtin.id)?.secretRef, f.ref);
      assert.equal(repo.get(f.custom.id)?.apiKey, 'custom-secret');
      assert.equal(repo.list().some(key => key.isActive), false);
      assert.equal(repo.isNativeFallbackBlocked('codex', 'openai'), true);
    });
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).apiKey, 'cloud-secret');
    runDesktopUninstallCleanup(f.input, { credentialStore: f.store });
  });
}

for (const phase of ['begin', 'finish', 'rollback'] as const) {
  test(`uninstall ${phase} transaction failure preserves the original error and stops later effects`, t => {
    const f = fixture(t);
    inspect(f.dbPath, db => db.exec(`CREATE TRIGGER fail_cleanup BEFORE UPDATE ON engine_keys
      ${phase === 'finish' ? "WHEN NEW.api_key = '' AND OLD.api_key <> ''" : ''} BEGIN SELECT RAISE(${phase === 'rollback' ? 'ROLLBACK' : 'ABORT'}, 'injected-cleanup-failure'); END`));
    assert.throws(() => runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), error => {
      if (phase === 'rollback') {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /injected-cleanup-failure/u);
      } else assert.match(String(error), /injected-cleanup-failure/u);
      return true;
    });
    assert.equal(f.secrets.has(f.ref), phase !== 'finish');
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).apiKey, 'cloud-secret');
    inspect(f.dbPath, (db, repo) => {
      assert.equal(repo.get(f.custom.id)?.apiKey, 'custom-secret');
      assert.equal(repo.isNativeFallbackBlocked('codex', 'openai'), phase === 'finish');
      db.exec('DROP TRIGGER fail_cleanup');
    });
    runDesktopUninstallCleanup(f.input, { credentialStore: f.store });
  });
}

test('uninstall config replacement failure never reports success or restores deleted secrets', t => {
  const f = fixture(t), rename = fs.renameSync, error = new Error('injected config rename');
  const mock = t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (target === f.configPath) throw error;
    return rename(source, target);
  });
  assert.throws(() => runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), candidate => candidate === error);
  assert.equal(f.secrets.has(f.ref), false);
  inspect(f.dbPath, (_db, repo) => assert.equal(repo.get(f.custom.id)?.apiKey, ''));
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).apiKey, 'cloud-secret');
  assert.deepEqual(fs.readdirSync(f.dataDir).filter(name => name.endsWith('.tmp')), []);
  mock.mock.restore();
  runDesktopUninstallCleanup(f.input, { credentialStore: f.store });
});

test('uninstall checkpoint busy fails after durable cleanup and succeeds when reader releases', t => {
  const f = fixture(t), reader = openSqliteDb(f.dbPath, { readonly: true, fileMustExist: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM engine_keys').all();
    assert.throws(() => runDesktopUninstallCleanup(f.input, { credentialStore: f.store }), /CHECKPOINT_BUSY/u);
    assert.equal(f.secrets.has(f.ref), false);
    reader.exec('ROLLBACK');
  } finally { reader.close(); }
  runDesktopUninstallCleanup(f.input, { credentialStore: f.store });
});

for (const phase of ['close', 'reopen', 'verify-close', 'store-and-close', 'false-and-close', 'undefined-and-close'] as const) {
  test(`uninstall ${phase} failure remains explicit and releases test-owned connections`, t => {
    const f = fixture(t), connections: SqliteDb[] = [], primary = new Error('injected store-primary'), secondary = new Error(`injected ${phase}`);
    t.after(() => { for (const db of connections) db.close(); });
    let calls = 0;
    const openDb: typeof openSqliteDb = (file, options) => {
      calls += 1;
      if (phase === 'reopen' && calls === 2) throw secondary;
      const db = openSqliteDb(file, options); connections.push(db);
      if ((calls === 1 && ['close', 'store-and-close', 'false-and-close', 'undefined-and-close'].includes(phase)) || (calls === 2 && phase === 'verify-close')) {
        return new Proxy(db, { get(target, key) { if (key === 'close') return () => { target.close(); throw secondary; }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
      }
      return db;
    };
    assert.throws(() => runDesktopUninstallCleanup(f.input, { openDb,
      credentialStore: phase.endsWith('-and-close') ? { ...f.store, get() { throw phase === 'false-and-close' ? false : phase === 'undefined-and-close' ? undefined : primary; } } : f.store }), error => {
      if (phase.endsWith('-and-close')) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [phase === 'false-and-close' ? false : phase === 'undefined-and-close' ? undefined : primary, secondary]); }
      else assert.equal(error, secondary);
      return true;
    });
    runDesktopUninstallCleanup(f.input, { credentialStore: f.store });
  });
}

for (const invalid of ['pending', 'account', 'missing-db', 'wrong-client', 'bad-ref', 'bad-config', 'workspace-kind', 'future-schema', 'missing-column'] as const) {
  test(`uninstall ${invalid} preflight rejects without clearing any credential`, t => {
    const f = fixture(t), original = fs.readFileSync(f.configPath);
    if (invalid === 'pending' || invalid === 'account') fs.writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: 'plain_sqlite', ownership: invalid === 'account' ? 'account' : 'local_os_user', initializationState: invalid === 'pending' ? 'pending' : 'ready' }), 'utf8');
    if (invalid === 'missing-db') fs.renameSync(f.dbPath, `${f.dbPath}.saved`);
    if (invalid === 'bad-ref') inspect(f.dbPath, db => db.prepare('UPDATE engine_keys SET secret_ref = ? WHERE id = ?').run('independent-native', f.builtin.id));
    if (invalid === 'bad-config') fs.writeFileSync(f.configPath, '{broken', 'utf8');
    if (invalid === 'workspace-kind') inspect(f.dbPath, db => db.pragma('application_id = 1128683347'));
    if (invalid === 'future-schema') inspect(f.dbPath, db => db.pragma('user_version = 1000000'));
    if (invalid === 'missing-column') inspect(f.dbPath, db => db.exec('ALTER TABLE engine_keys DROP COLUMN secret_ref'));
    assert.throws(() => runDesktopUninstallCleanup({ ...f.input, ...(invalid === 'wrong-client' ? { clientId: 'other' } : {}) }, { credentialStore: f.store }));
    assert.equal(f.secrets.has(f.ref), true);
    if (invalid !== 'bad-config') assert.deepEqual(fs.readFileSync(f.configPath), original);
    if (invalid === 'missing-db') assert.equal(fs.existsSync(f.dbPath), false);
  });
}

test('uninstall protocol rejects additional paths and relative data roots', () => {
  const input = { schemaVersion: 1, requestId: 'req', dataDir: 'D:/isolated', clientId: 'client', deviceId: 'device' };
  assert.throws(() => parseDesktopUninstallRequest({ ...input, sql: 'DELETE FROM meta' }), /REQUEST_INVALID/u);
  assert.throws(() => parseDesktopUninstallRequest({ ...input, dataDir: '../other' }), /PATH_INVALID/u);
});

/** 真子进程仅继承隔离环境，等待 close 后才能把 IPC 响应视为完成。 */
async function runIpc(input: Serializable, duplicate = false, disconnect = false, entryPath?: string): Promise<{ code: number | null; messages: unknown[]; stderr: string; disconnectedLifecycle?: Record<string, unknown> }> {
  const worker = entryPath ?? path.resolve('src/desktopUninstallWorker.ts');
  const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-worker-ipc-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|systemdrive)$/iu.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    env[key] = path.join(environmentRoot, key.toLowerCase()); fs.mkdirSync(env[key]);
  }
  env.CODEFLOWAI_CLIENT_LOG_DIR = path.join(environmentRoot, 'logs');
  const child = fork(worker, [], { execArgv: ['--conditions', 'development', '--import', 'tsx'], env,
    detached: process.platform !== 'win32', silent: true });
  const messages: unknown[] = [], stderr: Buffer[] = [];
  child.on('message', message => messages.push(message)); child.stderr!.on('data', bytes => stderr.push(bytes));
  child.stdout!.resume();
  // Node 在父主动断 IPC 时可能不发 ChildProcess close；该窄例逐项核实际资源。
  let disconnected = false, exitObserved = false, disconnectCode: number | null = null;
  const pipeClosed = new Set<string>();
  let resolveDisconnected!: (code: number | null) => void;
  const disconnectedExit = new Promise<number | null>(resolve => { resolveDisconnected = resolve; });
  /** 仅父主动断连路径允许用 exit、全部管道关闭和 PID 不存在共同确认资源。 */
  function confirmDisconnected(): void {
    if (!disconnect || !disconnected || !exitObserved || pipeClosed.size !== 3) return;
    resolveDisconnected(disconnectCode);
  }
  if (disconnect) {
    child.once('disconnect', () => { disconnected = true; confirmDisconnected(); });
    child.once('exit', code => { exitObserved = true; disconnectCode = code; confirmDisconnected(); });
    for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      stream!.once('close', () => { pipeClosed.add(name); confirmDisconnected(); });
    }
  }
  let closed = false, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const exited = new Promise<number | null>(resolve => { child.once('error', rejectFailure); child.once('close', code => { closed = true; resolve(code); }); });
  const timer = setTimeout(() => rejectFailure(new Error('UNINSTALL_IPC_TEST_TIMEOUT')), 15_000);
  try {
    if (disconnect) child.disconnect();
    else {
      child.send(input, error => { if (error) rejectFailure(error); });
      if (duplicate) child.send(input, error => { if (error) rejectFailure(error); });
    }
    const code = await Promise.race([disconnect ? disconnectedExit : exited, failure]);
    if (disconnect) assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
    const result = { code, messages, stderr: Buffer.concat(stderr).toString('utf8'),
      ...(disconnect ? { disconnectedLifecycle: { childCloseObserved: closed, exitObserved, ipcDisconnected: disconnected, stdioClosed: [...pipeClosed].sort(), pidAbsent: true } } : {}) };
    fs.rmSync(environmentRoot, { recursive: true });
    return result;
  } catch (error) {
    const secondary: unknown[] = [];
    if (!closed) {
      try { const stopped = await terminateCliProcessTree(child, { timeoutMs: 10_000, strictTreeConfirmation: true }); if (stopped !== null) secondary.push(new Error(stopped)); }
      catch (stopError) { secondary.push(stopError); }
      try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error('UNINSTALL_IPC_TEST_CLOSE_TIMEOUT')), 10_000); })]); }
      catch (closeError) { secondary.push(closeError); }
    }
    throw secondary.length ? new AggregateError([error, ...secondary], 'UNINSTALL_IPC_TEST_CLEANUP_FAILED', { cause: error }) : error;
  } finally { clearTimeout(timer); clearTimeout(closeTimer); }
}

test('real reinstall IPC returns exact correlated counts only after app/workspace resources close and leaves secrets unchanged', async t => {
  const f = reinstallFixture(t), result = await runIpc(f.input);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, [{ schemaVersion: 1, requestId: f.input.requestId, ok: true, result: { rebound: 2, unchanged: 0 } }]);
  const expected = f.beforeTasks.map(scope => ({ ...scope,
    configs: scope.configs.map(row => ({ ...row, device_id: f.input.nextDeviceId })),
    runtime: scope.runtime.map(row => ({ ...row, device_id: f.input.nextDeviceId })),
  }));
  assert.deepEqual(f.snapshot(), expected);
  assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
  inspect(f.dbPath, (_db, repo) => assert.deepEqual(repo.list(), f.before));
  const retry = await runIpc(f.input);
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(retry.messages, [{ schemaVersion: 1, requestId: f.input.requestId, ok: true, result: { rebound: 0, unchanged: 2 } }]);
  assert.deepEqual(f.snapshot(), expected);
});

for (const invalid of ['unknown-action', 'extra-field', 'missing-action'] as const) {
  test(`real reinstall IPC ${invalid} rejects without falling through cleanup`, async t => {
    const f = reinstallFixture(t), input: Record<string, unknown> = { ...f.input };
    if (invalid === 'unknown-action') input.action = 'uninstall_credentials';
    if (invalid === 'extra-field') input.deviceId = f.input.oldDeviceId;
    if (invalid === 'missing-action') delete input.action;
    const result = await runIpc(input);
    assert.equal(result.code, 1); assert.equal(result.messages.length, 1);
    assert.equal((result.messages[0] as { ok: boolean }).ok, false);
    assert.deepEqual(f.snapshot(), f.beforeTasks);
    assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
    inspect(f.dbPath, (_db, repo) => assert.deepEqual(repo.list(), f.before));
  });
}

test('real reinstall IPC ClientDb close failure is nonzero with one safe correlated response after actual close', async t => {
  const f = reinstallFixture(t), entry = path.join(f.dataDir, 'ipc-reinstall-close.mjs');
  const worker = pathToFileURL(path.resolve('src/desktopUninstallWorker.ts')).href;
  fs.writeFileSync(entry, `import {DatabaseSync} from 'node:sqlite';\nimport {startDesktopUninstallWorker} from ${JSON.stringify(worker)};\nconst prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close;\nDatabaseSync.prototype.close=function(){const match=prepare.call(this,'PRAGMA database_list').all().some(row=>row.file===${JSON.stringify(f.dbPath.replaceAll('\\', '/'))}||row.file===${JSON.stringify(f.dbPath)});const rebound=match&&prepare.call(this,"SELECT device_id FROM scheduled_task_configs WHERE id='application-reinstall-task'").get()?.device_id===${JSON.stringify(f.input.nextDeviceId)};close.call(this);if(rebound)throw new Error('private-client-close');};\nstartDesktopUninstallWorker();\n`, 'utf8');
  const result = await runIpc(f.input, false, false, entry);
  assert.equal(result.code, 1); assert.equal(result.messages.length, 1, result.stderr);
  const response = result.messages[0] as { requestId: string; ok: boolean; error: { code: string } };
  assert.equal(response.requestId, f.input.requestId); assert.equal(response.ok, false);
  const logs = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(logs.length, 1); assert.equal(logs[0].stage, 'database_close');
  assert.equal(logs[0].event.action, 'reinstall_local_tasks');
  assert.equal(logs[0].oldDeviceId, f.input.oldDeviceId); assert.equal(logs[0].nextDeviceId, f.input.nextDeviceId);
  assert.equal(result.stderr.includes('private-client-close'), false);
  assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
  const after = f.snapshot();
  assert.ok(after.every(scope => scope.configs.every(row => row.device_id === f.input.nextDeviceId)));
  const retry = await runIpc(f.input);
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(retry.messages, [{ schemaVersion: 1, requestId: f.input.requestId, ok: true, result: { rebound: 0, unchanged: 2 } }]);
});

test('real reinstall IPC ownership conflict explicitly fails with unchanged tasks and retained secret material', async t => {
  const f = reinstallFixture(t);
  inspect(f.dbPath, db => db.prepare('UPDATE scheduled_task_runtime_states SET device_id=? WHERE task_id=?')
    .run(crypto.randomUUID(), scheduledTaskRuntimeKey('application-reinstall-task', 'local')));
  const before = f.snapshot(), result = await runIpc(f.input);
  assert.equal(result.code, 1); assert.equal(result.messages.length, 1);
  const response = result.messages[0] as { requestId: string; ok: boolean };
  assert.equal(response.requestId, f.input.requestId); assert.equal(response.ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(fs.readFileSync(f.configPath), f.configBefore);
  inspect(f.dbPath, (_db, repo) => assert.deepEqual(repo.list(), f.before));
  const logs = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(logs.length, 1); assert.equal(logs[0].event.action, 'reinstall_local_tasks');
  assert.equal(result.stderr.includes('cloud-secret'), false); assert.equal(result.stderr.includes('builtin-secret'), false);
});

test('real migration-only IPC preserves current credentials and database bytes', async t => {
  const f = fixture(t), config = fs.readFileSync(f.configPath), database = fs.readFileSync(f.dbPath);
  const result = await runIpc({ ...f.input, action: 'migration_credentials' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, [{ schemaVersion: 1, requestId: f.input.requestId, ok: true, result: { cleanedKeys: 0 } }]);
  assert.deepEqual(fs.readFileSync(f.configPath), config); assert.deepEqual(fs.readFileSync(f.dbPath), database);
  assert.equal(f.secrets.get(f.ref), 'builtin-secret');
  assert.throws(() => parseDesktopUninstallRequest({ ...f.input, action: 'migration_credentials', sql: 'DELETE FROM meta' }), /REQUEST_INVALID/u);
});

test('real uninstall IPC clears custom material and exits after the one response', async t => {
  const f = fixture(t);
  // 产品 IPC 无测试存储协议：移除隔离库中的 OS 引用，避免访问真实用户 keyring。
  inspect(f.dbPath, db => db.prepare('UPDATE engine_keys SET secret_ref = NULL').run());
  const result = await runIpc(f.input);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, [{ schemaVersion: 1, requestId: f.input.requestId, ok: true, result: { cleanedKeys: 2 } }]);
  inspect(f.dbPath, (_db, repo) => assert.equal(repo.get(f.custom.id)?.apiKey, ''));
});

test('real uninstall IPC reports invalid input once and exits nonzero without keyring', async () => {
  const result = await runIpc({ schemaVersion: 9, sql: 'forbidden' });
  assert.equal(result.code, 1);
  assert.equal(result.messages.length, 1);
  const response = result.messages[0] as { ok: boolean; error: { code: string } };
  assert.equal(response.ok, false); assert.equal(response.error.code, 'DESKTOP_UNINSTALL_REQUEST_INVALID');
  const errors = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, 'DESKTOP_UNINSTALL_REQUEST_INVALID');
});

test('real uninstall IPC duplicate input fails explicitly without a second cleanup', async t => {
  const f = fixture(t);
  inspect(f.dbPath, db => db.prepare('UPDATE engine_keys SET secret_ref = NULL').run());
  const result = await runIpc(f.input, true);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.messages.length, 1);
  assert.match(result.stderr, /DESKTOP_UNINSTALL_IPC_DUPLICATE/u);
});

test('real uninstall IPC parent disconnect fails without touching managed material', async t => {
  const f = fixture(t), result = await runIpc(f.input, false, true);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.messages.length, 0);
  assert.match(result.stderr, /DESKTOP_UNINSTALL_IPC_DISCONNECTED|DESKTOP_UNINSTALL_IPC_REQUIRED/u);
  assert.deepEqual({ ...result.disconnectedLifecycle, childCloseObserved: undefined }, { childCloseObserved: undefined, exitObserved: true, ipcDisconnected: true, stdioClosed: ['stderr', 'stdin', 'stdout'], pidAbsent: true });
  t.diagnostic(JSON.stringify(result.disconnectedLifecycle));
  assert.equal(f.secrets.has(f.ref), true);
  inspect(f.dbPath, (_db, repo) => assert.equal(repo.get(f.custom.id)?.apiKey, 'custom-secret'));
});

for (const [kind, expression] of [
  ['false', 'false'],
  ['undefined', 'undefined'],
  ['null-prototype', 'Object.create(null)'],
  ['symbol-message', "Object.defineProperty(new Error(), 'message', {value: Symbol('private-payload')})"],
  ['conversion-throws', "({[Symbol.toPrimitive]() { throw new Error('private-payload'); }})"],
  ['field-getters', "Object.defineProperties({}, Object.fromEntries(['message','code','name','cause','syscall','errors'].map(key => [key, {get() { throw new Error('private-payload'); }}])))"],
  ['revoked-proxy-array', "(()=>{const value=Proxy.revocable([],{});value.revoke();return Object.assign(new Error('private-payload'),{errors:value.proxy});})()"],
] as const) {
  test(`real uninstall IPC arbitrary failure ${kind} retains one safe failure response and log`, async t => {
    const f = fixture(t), entry = path.join(f.dataDir, 'ipc-arbitrary-failure.mjs');
    const worker = pathToFileURL(path.resolve('src/desktopUninstallWorker.ts')).href;
    fs.writeFileSync(entry, `import fs from 'node:fs';\nimport {startDesktopUninstallWorker} from ${JSON.stringify(worker)};\nconst failure=${expression};\nfs.lstatSync=()=>{throw failure;};\nstartDesktopUninstallWorker();\n`, 'utf8');
    const result = await runIpc(f.input, false, false, entry);
    assert.equal(result.code, 1);
    assert.equal(result.messages.length, 1, result.stderr);
    const response = result.messages[0] as { ok: boolean; requestId: string; error: { code: string } };
    assert.equal(response.ok, false);
    assert.equal(response.requestId, f.input.requestId);
    assert.equal(response.error.code, 'DESKTOP_UNINSTALL_CLEANUP_FAILED');
    const logs = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].stage, 'preflight');
    assert.equal(logs[0].requestId, f.input.requestId);
    assert.deepEqual(logs[0].rootCause, response.error);
    assert.equal(JSON.stringify(response).includes('private-payload'), false);
    assert.equal(result.stderr.includes('private-payload'), false);
    assert.equal(f.secrets.has(f.ref), true);
    inspect(f.dbPath, (_db, repo) => assert.equal(repo.get(f.custom.id)?.apiKey, 'custom-secret'));
  });
}
