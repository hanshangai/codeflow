import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from '../src/db/migrateClientDb.js';
import { openSqliteDb } from '../src/db/sqliteDb.js';
import { assertEngineKeySourceVerified, EngineKeyRepo } from '../src/db/repos/engineKeyRepo.js';
import { buildClaudeChildEnv } from '../src/engines/claude/claudeThreadSession.js';
import { createBuiltInRelayCredentialService } from '../src/security/builtInRelayCredentialService.js';

for (const source of ['user_configured', 'unknown'] as const) {
  test(`failed deletion-intent clearing restores native and DB for previous ${source} material`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-native-rollback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = `
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      const root = process.argv[2]; os.homedir = () => root;
      const {openClientDb} = await import('./apps/desktop/client/src/db/clientDb.ts');
      const {handleEngineKeysUpsert} = await import('./apps/desktop/client/src/app/handlers/engineKeyHandlers.ts');
      const db = openClientDb({dbPath:path.join(root,'client.db')});
      try {
        const row = db.engineKeys.insert({label:'before',engine:'codex',providerId:'openai',apiKey:'old-managed-secret'});
        db.db.prepare('UPDATE engine_keys SET source = ? WHERE id = ?').run(${JSON.stringify(source)},row.id);
        db.engineKeys.blockNativeFallback('codex','openai');
        db.engineKeys.clearNativeFallbackBlock = () => {throw new Error('injected marker delete failure');};
        const auth = path.join(root,'.codex','auth.json');fs.mkdirSync(path.dirname(auth),{recursive:true});
        fs.writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:${JSON.stringify(source === 'unknown' ? 'original-native-secret' : 'old-managed-secret')}}),'utf8');
        const before = db.engineKeys.list(); const responses=[];
        const ctx={db,send:m=>responses.push(m),sessions:{restartCodexProcesses:async options=>{await options?.beforeKill?.();}}};
        await handleEngineKeysUpsert(ctx,{t:'api.req',id:'clear-failure',method:'engineKeys.upsert',path:'',body:{id:row.id,label:'after',engine:'codex',providerId:'openai',apiKey:'new-managed-secret'}});
        assert.equal(responses.at(-1).status,500);assert.deepEqual(db.engineKeys.list(),before);
        assert.equal(db.engineKeys.isNativeFallbackBlocked('codex','openai'),true);
        assert.equal(JSON.parse(fs.readFileSync(auth,'utf8')).OPENAI_API_KEY,${JSON.stringify(source === 'unknown' ? 'original-native-secret' : 'old-managed-secret')});
        assert.match(responses.at(-1).body.message,/injected marker delete failure/);
      } finally {db.close();}
    `;
    const result = spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '-', root], { input: script, encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '../../../..') });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

/** main 不能直接启动；抽取现役回调并保留真实仓储和来源校验。 */
function loadCredentialConsumers(repo: EngineKeyRepo, desktopLifecycle: object | null = null, builtInRelayCredentials: unknown = null) {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    resolveCodexRuntimeConfig: () => {'), end = source.indexOf('    assertCodexMutationAllowed:', start);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(`return ({${source.slice(start, end)}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('db', 'desktopLifecycle', 'builtInRelayCredentials', 'assertEngineKeySourceVerified', 'resolveRuntimeEngineModelProviderId', compiled)({ engineKeys: repo }, desktopLifecycle, builtInRelayCredentials, assertEngineKeySourceVerified, () => 'anthropic') as { resolveCodexRuntimeConfig(): { apiKey: string } | null; resolveClaudeCredentials(providerId: string): { apiKey: string } | null; hasClaudeCredentials(providerId: string): boolean };
}

for (const engine of ['codex', 'claude'] as const) {
  test(`non-desktop ${engine} consumer rejects legacy unknown without native fallback until explicit re-entry`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-legacy-consumer-')), db = openSqliteDb(path.join(root, 'client.db'));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    migrateClientDb(db); const repo = new EngineKeyRepo(db), providerId = engine === 'codex' ? 'openai' : 'anthropic';
    const key = repo.insert({ label: 'legacy', engine, providerId, apiKey: 'legacy-secret' });
    db.prepare("UPDATE engine_keys SET source = 'unknown' WHERE id = ?").run(key.id);
    const consumer = loadCredentialConsumers(repo), resolve = () => engine === 'codex' ? consumer.resolveCodexRuntimeConfig() : consumer.resolveClaudeCredentials(providerId);
    assert.throws(resolve, { code: 'CONFLICT' });
    if (engine === 'claude') assert.throws(() => consumer.hasClaudeCredentials(providerId), { code: 'CONFLICT' });
    assert.equal(repo.get(key.id)?.apiKey, 'legacy-secret');
    repo.update(key.id, { apiKey: 're-entered-secret' });
    assert.equal(resolve()?.apiKey, 're-entered-secret');
    if (engine === 'claude') assert.equal(consumer.hasClaudeCredentials(providerId), true);
  });
}

for (const state of ['unknown', 'inactive-unknown', 'stale-builtin', 'inactive-builtin', 'deleted-block', 'unmanaged'] as const) {
  test(`actual Claude child env ${state} cannot inherit managed legacy auth unless scope is unmanaged`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-legacy-claude-env-')), db = openSqliteDb(path.join(root, 'client.db'));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    migrateClientDb(db); const repo = new EngineKeyRepo(db);
    if (state === 'unknown' || state === 'inactive-unknown') { const key = repo.insert({ label: 'legacy', engine: 'claude', providerId: 'anthropic', apiKey: 'legacy-managed-secret' }); db.prepare("UPDATE engine_keys SET source='unknown' WHERE id=?").run(key.id); if (state === 'inactive-unknown') repo.deactivate(key.id); }
    if (state === 'stale-builtin' || state === 'inactive-builtin') { const key = repo.saveBuiltIn({ label: 'builtin', engine: 'claude', providerId: 'anthropic', baseUrl: 'https://relay.example', serverOrigin: 'https://server.example', ownerUserId: 'owner', keyId: 'server-key', secretRef: 'isolated-reference' }); if (state === 'stale-builtin') repo.activate(key.id); }
    if (state === 'deleted-block') repo.blockNativeFallback('claude', 'anthropic');
    const service = createBuiltInRelayCredentialService({ repo, getOwner: () => null, assertOwner() {}, requestEnsure: async () => { throw new Error('must not contact Server'); } });
    const consumer = loadCredentialConsumers(repo, state.startsWith('inactive-') ? null : {}, state.startsWith('inactive-') ? null : service);
    const build = () => buildClaudeChildEnv({ ANTHROPIC_AUTH_TOKEN: 'legacy-env-sentinel', CLAUDE_CODE_GIT_BASH_PATH: 'isolated-bash' }, { providerId: 'anthropic', dangerouslySkipPermissions: false, readCredentials: consumer.resolveClaudeCredentials as any, hasConfiguredCredentials: consumer.hasClaudeCredentials });
    if (state === 'unmanaged') assert.equal(build().ANTHROPIC_AUTH_TOKEN, 'legacy-env-sentinel');
    else assert.throws(build);
  });
}

for (const source of ['unknown', 'builtin'] as const) {
  test(`non-desktop Codex inactive ${source} prevents native fallback`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-inactive-codex-')), db = openSqliteDb(path.join(root, 'client.db'));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    migrateClientDb(db); const repo = new EngineKeyRepo(db);
    const key = source === 'builtin' ? repo.saveBuiltIn({ label: 'builtin', engine: 'codex', providerId: 'openai', baseUrl: 'https://relay.example', serverOrigin: 'https://server.example', ownerUserId: 'owner', keyId: 'server-key', secretRef: 'ref' }) : repo.insert({ label: 'legacy', engine: 'codex', providerId: 'openai', apiKey: 'legacy-secret' });
    if (source === 'unknown') db.prepare("UPDATE engine_keys SET source='unknown' WHERE id=?").run(key.id);
    repo.deactivate(key.id);
    assert.throws(() => loadCredentialConsumers(repo).resolveCodexRuntimeConfig(), { code: 'CONFLICT' });
  });
}

test('metadata migration confirms legacy local keys as user-configured without changing bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-migration-'));
  const db = openSqliteDb(path.join(root, 'client.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrateClientDb(db);
  for (const column of ['source', 'server_origin', 'owner_user_id', 'server_key_id', 'secret_ref']) db.exec(`ALTER TABLE engine_keys DROP COLUMN ${column}`);
  db.exec("DROP INDEX IF EXISTS idx_local_quick_phrases_order; DROP TABLE IF EXISTS local_quick_phrases; DROP TABLE IF EXISTS local_quick_phrase_collection; DROP TABLE IF EXISTS local_model_context_preferences;");
  db.pragma('user_version = 89');
  db.prepare("INSERT INTO engine_keys (id,label,engine,provider_id,api_key,base_url,is_active,created_at,updated_at) VALUES ('old','个人历史 Key','codex','openai','unchanged-old-secret',NULL,1,1,2)").run();
  db.prepare("INSERT INTO engine_keys (id,label,engine,provider_id,api_key,base_url,is_active,created_at,updated_at) VALUES ('builtin','CodeFlow 内置中转（Codex）','codex','openai','legacy-relay-secret',NULL,0,1,2)").run();
  migrateClientDb(db);
  assert.equal(db.pragma('user_version', { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  const row = db.prepare("SELECT api_key, source, server_origin, owner_user_id, server_key_id, secret_ref FROM engine_keys WHERE id='old'").get() as any;
  assert.equal(row.api_key, 'unchanged-old-secret'); assert.equal(row.source, 'user_configured');
  assert.equal(row.server_origin, null); assert.equal(row.owner_user_id, null); assert.equal(row.server_key_id, null); assert.equal(row.secret_ref, null);
  assert.equal((db.prepare("SELECT source FROM engine_keys WHERE id='builtin'").get() as any).source, 'unknown');
  const repo = new EngineKeyRepo(db);
  const custom = repo.insert({ label: 'CodeFlow 内置中转 fake', engine: 'claude', providerId: 'anthropic', apiKey: 'personal-secret' });
  assert.equal(custom.source, 'user_configured'); assert.equal(custom.apiKey, 'personal-secret');
  repo.update('old', { label: 'renamed legacy' });
  assert.equal(repo.get('old')?.source, 'user_configured');
  assert.equal(repo.get('old')?.apiKey, 'unchanged-old-secret');
  assert.equal(repo.activate('old').apiKey, 'unchanged-old-secret');
});

test('v103 confirms an existing 102 database local key without re-entry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-migration-102-'));
  const db = openSqliteDb(path.join(root, 'client.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrateClientDb(db);
  const repo = new EngineKeyRepo(db);
  const key = repo.insert({ label: 'migrated', engine: 'codex', providerId: 'openai', apiKey: 'migrated-secret' });
  db.prepare("UPDATE engine_keys SET source='unknown' WHERE id=?").run(key.id);
  db.pragma('user_version = 102');
  migrateClientDb(db);
  assert.equal(repo.get(key.id)?.source, 'user_configured');
  assert.equal(repo.activate(key.id).apiKey, 'migrated-secret');
});

test('v103 re-confirms local keys when the source column was repaired', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-migration-repair-'));
  const db = openSqliteDb(path.join(root, 'client.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrateClientDb(db);
  const key = new EngineKeyRepo(db).insert({ label: 'personal', engine: 'codex', providerId: 'openai', apiKey: 'personal-secret' });
  db.exec('ALTER TABLE engine_keys DROP COLUMN source');
  assert.equal(db.pragma('user_version', { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  migrateClientDb(db);
  assert.equal(new EngineKeyRepo(db).get(key.id)?.source, 'user_configured');
});

test('v103 leaves server-owned or secret-reference keys unconfirmed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-migration-ref-'));
  const db = openSqliteDb(path.join(root, 'client.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrateClientDb(db);
  const key = new EngineKeyRepo(db).insert({ label: 'server legacy', engine: 'codex', providerId: 'openai', apiKey: 'legacy-secret' });
  db.prepare("UPDATE engine_keys SET source='unknown', server_origin='https://server.example', secret_ref='ref' WHERE id=?").run(key.id);
  db.pragma('user_version = 102');
  migrateClientDb(db);
  assert.equal(new EngineKeyRepo(db).get(key.id)?.source, 'unknown');
});
