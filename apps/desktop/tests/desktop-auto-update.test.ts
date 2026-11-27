import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { signReleaseBundleManifest } from '@codeflowai/shared/desktop-release-signing';
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from '@codeflowai/shared/desktop-device-auth';
import { createDesktopApplication, type DesktopHost } from '../src/desktopApplication.js';
import type { ClientRuntime, ClientRuntimeExpectation } from '../src/clientRuntime.js';
import { DESKTOP_STARTUP_CAPABILITY_PATH, type DesktopStartupMode } from '@codeflowai/shared';
import { loadOrCreateDeviceIdentity } from '../src/deviceIdentity.js';
import { readActivePointer } from '../src/releaseBundleCoordinator.js';
import { createUpdateFailureJournal } from '../src/updateFailureJournal.js';
import { createUpdateReceiptJournal } from '../src/updateReceiptJournal.js';
import { createReleaseDatabaseBackup } from '../src/releaseDatabaseBackup.js';

/** 真实 HTTP、签名归档及日志；仅原生窗口与 Client 进程使用替身。 */
async function fixture(t: test.TestContext, installed?: 'same' | 'conflict' | 'different', baselineSchema = 88) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-d12o-auto-'));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const packageDir = path.join(dataDir, 'incoming');
  await fs.mkdir(path.join(packageDir, 'web'), { recursive: true });
  await fs.mkdir(path.join(packageDir, 'client', 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'web', 'index.html'), 'web');
  await fs.writeFile(path.join(packageDir, 'client', 'dist', 'index.cjs'), 'client');
  const capability = JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: crypto.createHash('sha256').update('client').digest('hex') });
  await fs.writeFile(path.join(packageDir, DESKTOP_STARTUP_CAPABILITY_PATH), capability);
  const archivePath = path.join(dataDir, 'bundle.tar.gz');
  await tar.c({ cwd: packageDir, file: archivePath, gzip: true, portable: true }, ['web', 'client']);
  const archive = await fs.readFile(archivePath);
  const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
  const webSha256 = hash(`index.html\0${hash('web')}\n`);
  const clientSha256 = hash(`dist/desktop-startup-capability.json\0${hash(capability)}\ndist/index.cjs\0${hash('client')}\n`);
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: 'auto-release', version: '1.0.0',
    webVersion: '1.0.0', clientVersion: '1.0.0', protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: process.platform, arch: process.arch, keyId: 'auto-fixture', archiveSha256: hash(archive), archiveSize: archive.length,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: DESKTOP_STARTUP_CAPABILITY_PATH, size: Buffer.byteLength(capability), sha256: hash(capability) }, { path: 'client/dist/index.cjs', size: 6, sha256: hash('client') }, { path: 'web/index.html', size: 3, sha256: hash('web') }],
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-10-24T00:00:00.000Z' }, privateKey);
  const requests: { path: string; requestId: string }[] = [];
  const baselineDir = path.join(dataDir, 'baseline');
  await fs.cp(packageDir, baselineDir, { recursive: true });
  const { signature: _signature, ...payload } = manifest;
  const baselineManifest = signReleaseBundleManifest({ ...payload, version: installed && baselineSchema === 88 ? manifest.version : '0.9.0', dbSchemaVersion: baselineSchema, releaseId: installed && installed !== 'different' ? manifest.releaseId : 'baseline-release',
    ...(installed === 'conflict' ? { archiveSha256: 'b'.repeat(64) } : {}) }, privateKey);
  await fs.writeFile(path.join(baselineDir, 'baseline-release-manifest.json'), JSON.stringify(baselineManifest));
  const receipts: { stage: string; requestId: string; at: string }[] = [];
  const actions: string[] = [];
  const failures: unknown[] = [];
  const serverErrors: unknown[] = [];
  const control = { available: true, authorized: true, busy: false, badSignature: false, holdArchive: false,
    failuresRemaining: 0, failReceipt: undefined as string | undefined, rejectLoadWeb: false, holdErrorBody: false,
    holdDiscovery: undefined as (() => Promise<void>) | undefined,
    onCandidateStart: undefined as (() => Promise<void>) | undefined, refuseCandidateContinuation: false };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const meta = readDesktopDeviceHeaders(request.rawHeaders);
      requests.push({ path: request.url!, requestId: meta.requestId });
      response.setHeader('content-type', 'application/json');
      if (request.url!.endsWith('/devices/register')) {
        response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId,
          publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      } else if (request.url!.startsWith('/api/software/desktop/release-availability') || request.url === '/api/software/desktop/update-availability') {
        if (control.holdErrorBody) { response.writeHead(403, { 'content-length': '128' }); response.flushHeaders(); return; }
        if (control.failuresRemaining > 0) {
          control.failuresRemaining--; response.writeHead(503, { 'retry-after': '0' }); response.end(JSON.stringify({ ok: false, code: 'DESKTOP_UPDATE_UNAVAILABLE' })); return;
        }
        await control.holdDiscovery?.();
        const available = control.available && new URL(request.url!, 'http://localhost').searchParams.get('excludeReleaseId') !== manifest.releaseId;
        const resource = { available, ...(available ? { manifest: control.badSignature ? { ...manifest, signature: 'A'.repeat(88) } : manifest } : {}) };
        response.end(JSON.stringify(request.url === '/api/software/desktop/update-availability'
          ? { ok: true, deviceId: identity.deviceId, requestId: meta.requestId, resource, shell: { available: false } }
          : { ok: true, deviceId: identity.deviceId, requestId: meta.requestId, ...resource }));
      } else if (request.url!.endsWith('/archive')) {
        if (control.holdArchive) {
          response.writeHead(200, { etag: `"${manifest.archiveSha256}"`, 'content-length': archive.length });
          response.flushHeaders(); return;
        }
        response.writeHead(200, { etag: `"${manifest.archiveSha256}"`, 'content-length': archive.length }); response.end(archive);
      } else if (request.url!.endsWith('/switch-authorization')) {
        response.end(JSON.stringify({ ok: true, authorized: control.authorized, deviceId: identity.deviceId, requestId: meta.requestId,
          releaseId: manifest.releaseId, ...(control.authorized ? { archiveSha256: manifest.archiveSha256 } : {}) }));
      } else if (request.url!.endsWith('/update-failures')) {
        const failure = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.end(JSON.stringify({ ok: true, deviceId: failure.deviceId, errorId: failure.errorId, payloadSha256: failure.payloadSha256 }));
      } else {
        assert.equal(request.url, '/api/software/desktop/update-receipts');
        const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        receipts.push(receipt);
        // 回执补报用例模拟业务拒绝，瞬时 503 的预算由发现与传输测试单独覆盖。
        if (control.failReceipt === receipt.stage) { response.writeHead(409); response.end(JSON.stringify({ code: 'DESKTOP_UPDATE_UNAVAILABLE' })); return; }
        response.end(JSON.stringify({ ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
          archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }));
      }
    })().catch(error => { serverErrors.push(error); response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() { actions.push('destroy'); } });
  const retries: { requestId: string; retry: number }[] = [];
  const host: DesktopHost = { createWindow: () => window, async loadWeb(_window, releaseDir) { if (control.rejectLoadWeb && releaseDir.endsWith(manifest.releaseId)) { control.rejectLoadWeb = false; throw new Error('WEB_LOAD_FAILED'); } },
    createTray: () => ({ destroy() {} }), registerBridge: () => () => {}, quit() { actions.push('quit'); },
    onUpdateError(error) { failures.push(error); }, onUpdateRetry(context) { retries.push(context); } };
  host.relaunch = () => { actions.push('relaunch'); };
  /** 原健康与更新控制协议保留，观察停止前的真实调用顺序。 */
  const createRuntime = (_entry: string, expected?: ClientRuntimeExpectation, startup?: DesktopStartupMode): ClientRuntime => ({
    /** 候选迁移故障只注入临时数据库，保持原启动与健康协议。 */
    async start() { actions.push('start'); actions.push(`start:${expected?.releaseId ?? 'installation'}`); if (expected?.releaseId === manifest.releaseId) await control.onCandidateStart?.(); },
    async waitReady() {}, async stop() {}, async drain() { actions.push('drain'); }, onEvent() { return () => {}; },
    async request(request) {
      actions.push(request.method);
      if (request.method === 'runtime.startup.continue' && expected?.releaseId === manifest.releaseId && control.refuseCandidateContinuation) {
        return { status: 503, body: { ok: false } };
      }
      return { status: 200, body: request.method === 'runtime.startup.continue' ? { ok: true } : { ok: true, hasRunningSessions: control.busy } };
    },
    snapshot() { return { status: 'ready', requestId: null, releaseId: expected?.releaseId ?? null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: expected?.clientVersion ?? '1.0.0', dbSchemaVersion: expected?.dbSchemaVersion ?? 88, database: 'ready' },
      ...(startup?.mode === 'held' ? { startup: { continuationId: startup.continuationId, admission: 'paused' as const } } : {}) }; } });
  const runtimeFacts: Array<{ versions: { releaseId: string } }> = [];
  const options = { dataDir, initialReleaseDir: baselineDir, requireBaseline: Boolean(installed),
    onRuntimeFacts: (facts: { versions: { releaseId: string } }) => { runtimeFacts.push(facts); },
    trustedReleaseKeys: { 'auto-fixture': publicKey }, host, createRuntime,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  let app = createDesktopApplication(options);
  await app.start();
  let exited = false;
  t.after(async () => {
    if (!exited) await app.exit();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true }); assert.deepEqual(serverErrors, []);
  });
  return { get app() { return app; }, control, requests, receipts, actions, failures, retries, dataDir, manifest, identity, runtimeFacts, host,
    journal: () => createUpdateFailureJournal(dataDir).pending(identity.deviceId),
    /** 模拟完整安装包已经包含原先准备的目标，只改测试目录中的签名基线。 */
    async installPreparedAsBaseline(conflicting = false) {
      options.requireBaseline = true;
      const installed = conflicting ? signReleaseBundleManifest({ ...payload, archiveSha256: 'b'.repeat(64) }, privateKey) : manifest;
      await fs.writeFile(path.join(baselineDir, 'baseline-release-manifest.json'), JSON.stringify(installed));
    },
    /** 模拟更新版本已安装，只提升签名基线版本，目录内容保持不变。 */
    async installBaselineVersion(version: string, dbSchemaVersion = manifest.dbSchemaVersion) {
      options.requireBaseline = true;
      const installed = signReleaseBundleManifest({ ...payload, dbSchemaVersion, releaseId: `baseline-${version}`, version,
        webVersion: version, clientVersion: version }, privateKey);
      await fs.writeFile(path.join(baselineDir, 'baseline-release-manifest.json'), JSON.stringify(installed));
    },
    /** 在临时目录建立真实已签名旧活动版本，覆盖覆盖安装保留指针的行为。 */
    async installOldActive() {
      const releaseDir = path.join(dataDir, 'releases', baselineManifest.releaseId);
      await fs.mkdir(path.dirname(releaseDir), { recursive: true });
      await fs.cp(packageDir, releaseDir, { recursive: true });
      await fs.writeFile(path.join(releaseDir, 'manifest.json'), JSON.stringify(baselineManifest));
      await fs.writeFile(path.join(dataDir, 'active-release.json'), JSON.stringify({ releaseId: baselineManifest.releaseId }));
    },
    async exit() { await app.exit(); exited = true; },
    async restart() { await app.exit(); app = createDesktopApplication(options); await app.start(); } };
}

test('下载与验签阶段写入关联的升级诊断', async t => {
  const f = await fixture(t), trace: Array<Record<string, unknown>> = [];
  f.host.onUpgradeDiagnostic = event => trace.push(event);
  await f.app.checkForUpdates();
  assert.ok(trace.some(event => event.phase === 'download' && event.outcome === 'start' && event.releaseId === f.manifest.releaseId));
  assert.ok(trace.some(event => event.phase === 'download' && event.outcome === 'success'
    && event.receivedBytes === f.manifest.archiveSize && event.totalBytes === f.manifest.archiveSize));
  assert.ok(trace.some(event => event.phase === 'verify' && event.outcome === 'success' && event.releaseId === f.manifest.releaseId));
  assert.ok(trace.every(event => !Object.hasOwn(event, 'url') && !Object.hasOwn(event, 'body')));
  await f.app.exit();
});

test('内置已安装发布与目标相同，不下载、不准备也不提示重启', async t => {
  const f = await fixture(t, 'same');
  assert.equal(f.runtimeFacts.at(-1)?.versions.releaseId, f.manifest.releaseId);
  f.actions.length = 0;
  await f.app.checkForUpdates();
  const details = await f.app.getUpdateDetails();
  assert.equal(details.current.bundle?.releaseId, f.manifest.releaseId);
  assert.equal(details.bundle.result, 'same');
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 0);
  assert.equal(f.receipts.length, 0);
  assert.deepEqual(f.actions, []);
  await assert.rejects(fs.access(path.join(f.dataDir, 'pending-release.json')), { code: 'ENOENT' });
  await assert.rejects(f.app.restartForUpdate(), /DESKTOP_UPDATE_NOT_PREPARED/);
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'same');
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 0);
});

test('内置发布同版本重打包时使用本地版本，摘要差异只记诊断', async t => {
  const f = await fixture(t, 'conflict');
  const diagnostics: Array<{ diagnostic?: Record<string, unknown> }> = [];
  f.host.onUpgradeDiagnostic = event => diagnostics.push(event);
  assert.equal(await f.app.checkForUpdates(), null);
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 0);
  const details = await f.app.getUpdateDetails();
  assert.equal(details.bundle.result, 'same');
  assert.equal(details.current.bundle?.version, '1.0.0');
  assert.equal(f.app.updateCheckFailure, null);
  assert.ok(diagnostics.some(event => event.diagnostic?.code === 'DESKTOP_RELEASE_ARCHIVE_DIFFERS'));
});

test('资源版本相同但发布身份不同，不重复下载更新', async t => {
  const f = await fixture(t, 'different');
  await f.app.checkForUpdates();
  const details = await f.app.getUpdateDetails();
  assert.equal(details.current.bundle?.version, details.bundle.target?.version);
  assert.notEqual(details.current.bundle?.releaseId, details.bundle.target?.releaseId);
  assert.equal(details.bundle.result, 'same');
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 0);
});

for (const expired of [false, true]) test(`完整安装已包含待更新同包时清理待更新标记：已过下载有效期=${expired}`, async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  await f.installPreparedAsBaseline();
  if (expired) t.mock.timers.enable({ apis: ['Date'], now: Date.parse(f.manifest.expiresAt) + 1 });
  f.requests.length = 0; f.receipts.length = 0; f.actions.length = 0;
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'same');
  assert.equal(await readActivePointer(f.dataDir), null, '不能将安装基线伪装为活动更新');
  assert.equal(f.actions.filter(action => action === 'start').length, 1);
  assert.equal(f.actions.filter(action => action === 'drain').length, 1, '仅模拟重启的正常退出停止一次旧运行环境');
  assert.equal(f.actions.filter(action => action === 'runtime.startup.continue').length, 1);
  assert.equal(f.requests.filter(request => request.path.endsWith('/switch-authorization')).length, 0);
  assert.equal(f.receipts.some(receipt => ['switched', 'healthy'].includes(receipt.stage)), false);
  await assert.rejects(fs.access(path.join(f.dataDir, 'pending-release.json')), { code: 'ENOENT' });
  await assert.rejects(f.app.restartForUpdate(), /DESKTOP_UPDATE_NOT_PREPARED/);
  assert.deepEqual(f.failures, []);
});

test('未安装的过期候选不能借用内置包身份绕过有效期', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(f.manifest.expiresAt) + 1 });
  await f.restart();
  assert.ok(f.app.updateCheckFailure);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'failure');
  assert.equal(await readActivePointer(f.dataDir), null);
  await fs.access(path.join(f.dataDir, 'pending-release.json'));
});

test('暂存候选低于当前安装版本时启动直接放弃，不请求切换授权', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  await f.installBaselineVersion('1.0.1');
  f.requests.length = 0; f.receipts.length = 0; f.actions.length = 0;
  await f.restart();
  const details = await f.app.getUpdateDetails();
  assert.equal(details.bundle.result, 'same');
  assert.equal(details.current.bundle?.version, '1.0.1');
  assert.equal(f.requests.filter(request => request.path.endsWith('/switch-authorization')).length, 0);
  await assert.rejects(fs.access(path.join(f.dataDir, 'pending-release.json')), { code: 'ENOENT' });
  await assert.rejects(f.app.restartForUpdate(), /DESKTOP_UPDATE_NOT_PREPARED/);
  assert.deepEqual(f.failures, []);
});

test('待更新候选被撤回且服务器无可用发布时，检查结果保持空而不是撤回', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  f.control.authorized = false;
  f.control.available = false;
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'none');
  assert.equal(f.app.updateCheckFailure, null);
  await assert.rejects(f.app.restartForUpdate(), /DESKTOP_UPDATE_NOT_PREPARED/);
});

test('启动恢复的待更新候选未获切换资格时不保留可重启状态', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  await fs.access(pendingFile);
  f.control.authorized = false;
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'revoked');
  assert.equal(f.app.updateCheckFailure, null);
  await assert.rejects(f.app.restartForUpdate(), /DESKTOP_UPDATE_NOT_PREPARED/);
  await fs.access(pendingFile);
});

test('覆盖安装同版本后，过期异摘要的待更新包只在本地资源健康后收口', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json'), pending = await fs.readFile(pendingFile);
  await f.installPreparedAsBaseline(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(f.manifest.expiresAt) + 1 });
  f.host.loadWeb = async () => {
    assert.deepEqual(await fs.readFile(pendingFile), pending);
    throw new Error('CURRENT_WEB_FAILED');
  };
  await assert.rejects(f.restart(), /CURRENT_WEB_FAILED/u);
  assert.deepEqual(await fs.readFile(pendingFile), pending);
  const { stagingName } = JSON.parse(pending.toString('utf8'));
  await fs.unlink(path.join(f.dataDir, '.staging', stagingName, 'web/index.html'));
  f.host.loadWeb = async () => { assert.deepEqual(await fs.readFile(pendingFile), pending); };
  await f.restart();
  assert.equal(f.app.updateCheckFailure, null);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'same');
  await assert.rejects(fs.access(pendingFile), { code: 'ENOENT' });
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal(f.receipts.some(receipt => ['switched', 'healthy'].includes(receipt.stage)), false);
});

test('background and manual checks share preparation without interrupting running tasks', async t => {
  const f = await fixture(t);
  f.app.startAutomaticUpdates();
  const active = await f.app.checkForUpdates();
  await f.app.flushReceipts();
  assert.equal(active, null);
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  assert.equal(f.actions.includes('runtime.update.prepare'), false);
  assert.equal(f.actions.includes('drain'), false);
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 1);
  assert.deepEqual(f.receipts.map(receipt => receipt.stage), ['received', 'verified', 'prepared']);
  assert.equal(new Set(f.receipts.map(receipt => receipt.requestId)).size, 1);
  assert.deepEqual(f.failures, []);
});

test('periodic checks keep the active package and do not download or switch twice', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.app.startAutomaticUpdates(); await f.app.checkForUpdates();
  t.mock.timers.tick(30 * 60 * 1000); await f.app.checkForUpdates();
  await f.app.flushReceipts();
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 1);
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 1);
  assert.equal(f.receipts.length, 3);
});

test('prepared update waits for normal restart and resumes the original attempt', async t => {
  const f = await fixture(t); f.control.busy = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.app.startAutomaticUpdates(); assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  const requestId = f.receipts[0]!.requestId;
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(f.actions.filter(action => action === 'confirm').length, 0);
  assert.equal(await f.app.checkForUpdates(), null);
  await f.restart();
  await f.app.flushReceipts();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.equal(f.actions.filter(action => action === 'runtime.startup.continue').length, 1);
  assert.equal(f.actions.filter(action => action === 'confirm').length, 0);
  assert.ok(f.receipts.every(receipt => receipt.requestId === requestId));
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 1);
  assert.ok(f.requests.filter(request => request.path.endsWith('/switch-authorization')).every(request => request.requestId === requestId));
  assert.deepEqual(f.journal(), []);
});

test('server pause does not suppress the next automatic cycle and retains the same attempt', async t => {
  const f = await fixture(t); f.control.authorized = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.app.startAutomaticUpdates(); assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  const requestId = f.receipts[0]!.requestId;
  f.control.authorized = true; t.mock.timers.tick(30 * 60 * 1000);
  await f.app.checkForUpdates(); await f.restart();
  await f.app.flushReceipts();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.ok(f.receipts.every(receipt => receipt.requestId === requestId));
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 1);
  assert.deepEqual(f.journal(), []);
});

test('signature failure stops the schedule, preserves diagnostics and keeps Client alive', async t => {
  const f = await fixture(t); f.control.badSignature = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.app.startAutomaticUpdates(); await assert.rejects(() => f.app.checkForUpdates());
  assert.equal(f.failures.length, 1); assert.equal(f.journal().length, 1);
  const before = f.requests.length; t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(f.requests.length, before); assert.equal(f.actions.includes('quit'), false);
});

test('busy tasks are not interrupted or asked to confirm during background preparation', async t => {
  const f = await fixture(t); f.control.busy = true;
  f.app.startAutomaticUpdates(); await f.app.checkForUpdates(); await f.exit();
  assert.equal(f.actions.includes('runtime.update.interrupt'), false);
  assert.equal(f.actions.includes('confirm'), false); assert.equal(f.actions.at(-1), 'quit');
  assert.deepEqual(f.journal(), []); assert.deepEqual(f.failures, []);
});

test('transient discovery succeeds before creating an incident and retains one attempt ID', async t => {
  const f = await fixture(t); f.control.failuresRemaining = 2;
  await f.app.checkForUpdates(); assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  const discovery = f.requests.filter(request => request.path.endsWith('/update-availability'));
  assert.equal(discovery.length, 3); assert.equal(new Set(discovery.map(request => request.requestId)).size, 1);
  assert.deepEqual(f.retries.map(retry => retry.retry), [1, 2]);
  assert.deepEqual(f.journal(), []); assert.deepEqual(f.failures, []);
});

test('retry exhaustion creates one failure and requires manual recovery', async t => {
  const f = await fixture(t); f.control.failuresRemaining = 4;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.app.startAutomaticUpdates(); await assert.rejects(() => f.app.checkForUpdates());
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 4);
  assert.deepEqual(f.retries.map(retry => retry.retry), [1, 2, 3]);
  assert.equal(f.journal().length, 1); assert.equal(f.failures.length, 1);
  t.mock.timers.tick(30 * 60 * 1000);
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 4);
});

test('healthy ACK recovery replays exact original evidence without switching the active release twice', async t => {
  const f = await fixture(t); f.control.failReceipt = 'healthy';
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(f.app.updateCheckFailure, null);
  await assert.rejects(f.app.flushReceipts());
  assert.ok(f.app.updateReceiptFailure);
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  const healthy = f.receipts.find(receipt => receipt.stage === 'healthy'); assert.ok(healthy);
  const interruptions = f.actions.filter(action => action === 'runtime.update.interrupt').length;
  f.control.failReceipt = undefined;
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  assert.equal(f.actions.filter(action => action === 'runtime.update.interrupt').length, interruptions);
  assert.deepEqual(f.receipts.filter(receipt => receipt.stage === 'healthy'), [healthy, healthy]);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId), []);
});

test('committed pending cleanup retains installed-release semantics after the download authorization expires', async t => {
  const f = await fixture(t); await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  const pending = await fs.readFile(pendingFile);
  await f.restart(); await fs.writeFile(pendingFile, pending);
  const receipts = [...f.receipts];
  const starts = f.actions.filter(action => action === 'start').length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(f.manifest.expiresAt) + 1 });
  await f.restart();
  assert.equal(f.app.updateCheckFailure, null);
  assert.equal(f.actions.filter(action => action === 'start').length, starts + 1);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'healthy');
  assert.deepEqual(f.receipts, receipts);
  await assert.rejects(() => fs.access(pendingFile), { code: 'ENOENT' });
});

test('restart finishes committed pending cleanup and replays the original receipts without switching again', async t => {
  const f = await fixture(t); await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  const pending = await fs.readFile(pendingFile);
  f.control.failReceipt = 'healthy'; await f.restart();
  await assert.rejects(f.app.flushReceipts());
  const original = f.receipts.find(receipt => receipt.stage === 'healthy'); assert.ok(original);
  // 恢复提交后、清理前的磁盘状态，模拟此窗口进程中断。
  await fs.writeFile(pendingFile, pending);
  const starts = f.actions.filter(action => action === 'start').length;
  const authorizations = f.requests.filter(request => request.path.endsWith('/switch-authorization')).length;
  await f.restart(); assert.equal(f.app.updateCheckFailure, null);
  await assert.rejects(f.app.flushReceipts());
  await assert.rejects(fs.access(pendingFile), { code: 'ENOENT' });
  assert.equal(f.actions.filter(action => action === 'start').length, starts + 1);
  f.control.failReceipt = undefined; await f.restart();
  await f.app.flushReceipts();
  assert.equal(f.app.updateCheckFailure, null);
  assert.equal(f.actions.filter(action => action === 'start').length, starts + 2);
  assert.equal(f.requests.filter(request => request.path.endsWith('/switch-authorization')).length, authorizations);
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.releaseId, f.manifest.releaseId);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'unknown', '普通冷启动不把历史交付补报伪装成本次资源激活');
  await assert.rejects(() => fs.access(pendingFile), { code: 'ENOENT' });
  assert.equal(await f.app.checkForUpdates(), null);
  assert.equal(await f.app.checkForUpdates(), null);
  assert.deepEqual(f.receipts.filter(receipt => receipt.stage === 'healthy'), [original, original, original]);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId), []);
});

for (const failedStage of ['switched', 'healthy']) {
  test(`restart recovers committed pending when ${failedStage} evidence was not persisted`, async t => {
    const f = await fixture(t); await f.app.checkForUpdates();
    const pendingFile = path.join(f.dataDir, 'pending-release.json');
    const pending = await fs.readFile(pendingFile);
    const open = fs.open.bind(fs); let failed = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('update-receipts.jsonl')) {
        const write = file.writeFile.bind(file);
        t.mock.method(file, 'writeFile', async (...values: Parameters<typeof file.writeFile>) => {
          if (!failed && String(values[0]).includes(`"stage":"${failedStage}"`)) {
            failed = true; throw Object.assign(new Error('RECEIPT_STORE_FAILED'), { code: 'EIO' });
          }
          return await write(...values);
        });
      }
      return file;
    });
    await f.restart(); assert.equal(failed, true); assert.ok(f.app.updateCheckFailure);
    assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
    const journal = createUpdateReceiptJournal(f.dataDir);
    const requestId = JSON.parse(pending.toString('utf8')).requestId;
    const switched = await journal.find(f.identity.deviceId, requestId, 'switched');
    assert.deepEqual(await fs.readFile(pendingFile), pending, '回执未落盘时必须保留真实待更新记录');
    const starts = f.actions.filter(action => action === 'start').length;
    await f.restart();
    assert.equal(f.app.updateCheckFailure, null);
    assert.equal(f.actions.filter(action => action === 'start').length, starts + 1);
    if (switched) assert.deepEqual(await journal.find(f.identity.deviceId, requestId, 'switched'), switched);
    assert.equal(await f.app.checkForUpdates(), null);
    await f.app.flushReceipts();
    assert.equal(f.receipts.filter(receipt => receipt.stage === 'healthy').length, 1);
    assert.deepEqual(await journal.pending(f.identity.deviceId), []);
    await assert.rejects(() => fs.access(pendingFile), { code: 'ENOENT' });
  });
}

test('rollback terminal attempt is never reused for a manual installation', async t => {
  const f = await fixture(t); f.control.rejectLoadWeb = true;
  await f.app.checkForUpdates(); await f.restart();
  await f.app.flushReceipts();
  const rolledBack = f.receipts.find(receipt => receipt.stage === 'rolled_back'); assert.ok(rolledBack);
  assert.equal(await readActivePointer(f.dataDir), null);
  await f.app.checkForUpdates(); await f.restart();
  await f.app.flushReceipts();
  const healthy = f.receipts.find(receipt => receipt.stage === 'healthy'); assert.ok(healthy);
  assert.notEqual(healthy.requestId, rolledBack.requestId);
});

test('exit cancels an in-flight archive and clears the timer without reporting a false incident', async t => {
  const f = await fixture(t); f.control.holdArchive = true;
  f.app.startAutomaticUpdates();
  while (!f.requests.some(request => request.path.endsWith('/archive'))) await new Promise<void>(resolve => setImmediate(resolve));
  await f.exit();
  assert.equal(f.actions.at(-1), 'quit'); assert.deepEqual(f.journal(), []); assert.deepEqual(f.failures, []);
  assert.equal(f.receipts.length, 0);
});

test('received ACK recovery retains the verified manifest and original attempt without rediscovery', async t => {
  const f = await fixture(t); f.control.failReceipt = 'received';
  await f.app.checkForUpdates();
  await assert.rejects(f.app.flushReceipts());
  const original = f.receipts[0]!; assert.equal(original.stage, 'received');
  f.control.failReceipt = undefined;
  await f.app.checkForUpdates(); assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  await f.app.flushReceipts();
  assert.ok(f.receipts.every(receipt => receipt.requestId === original.requestId));
  assert.deepEqual(f.receipts.filter(receipt => receipt.stage === 'received'), [original, original]);
  assert.equal(f.requests.filter(request => request.path.endsWith('/update-availability')).length, 1);
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 1);
});

test('switched ACK recovery sends the persisted healthy fact without repeating the switch', async t => {
  const f = await fixture(t); f.control.failReceipt = 'switched';
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(f.app.updateCheckFailure, null);
  await assert.rejects(f.app.flushReceipts());
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  const requestId = f.receipts[0]!.requestId;
  assert.deepEqual((await createUpdateReceiptJournal(f.dataDir).pending(f.identity.deviceId)).map(receipt => receipt.stage), ['switched', 'healthy']);
  f.control.failReceipt = undefined;
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  const healthy = f.receipts.filter(receipt => receipt.stage === 'healthy');
  assert.equal(healthy.length, 1); assert.equal(healthy[0]!.requestId, requestId);
  assert.equal(f.actions.filter(action => action === 'runtime.update.interrupt').length, 0);
});

test('resume between permission denial and discovery retains the original same-package attempt', async t => {
  const f = await fixture(t); f.control.authorized = false;
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  const requestId = f.receipts[0]!.requestId;
  f.control.holdDiscovery = async () => { f.control.authorized = true; };
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.checkForUpdates(); assert.equal((await f.app.getUpdateDetails()).bundle.result, 'prepared');
  await f.app.flushReceipts();
  assert.ok(f.receipts.every(receipt => receipt.requestId === requestId));
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 1);
});

test('exit cancels an unfinished HTTP error body without creating an update incident', async t => {
  const f = await fixture(t); f.control.holdErrorBody = true;
  f.app.startAutomaticUpdates();
  while (!f.requests.some(request => request.path.endsWith('/update-availability'))) await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.exit();
  assert.equal(f.actions.at(-1), 'quit'); assert.deepEqual(f.journal(), []); assert.deepEqual(f.failures, []);
});

test('healthy persistence failure stays explicit until its observed receipt is stored and sent', async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs); let failed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('update-receipts.jsonl')) {
      const write = file.writeFile.bind(file);
      t.mock.method(file, 'writeFile', async (...values: Parameters<typeof file.writeFile>) => {
        if (!failed && String(values[0]).includes('"stage":"healthy"')) { failed = true; throw Object.assign(new Error('HEALTHY_STORE_FAILED'), { code: 'EIO' }); }
        return await write(...values);
      });
    }
    return file;
  });
  await f.app.checkForUpdates(); await f.restart(); assert.equal(failed, true);
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.flushReceipts();
  assert.equal(f.receipts.filter(receipt => receipt.stage === 'healthy').length, 1);
  assert.equal(f.actions.filter(action => action === 'runtime.update.interrupt').length, 0);
});

test('restart defers a revoked candidate, keeps current resources, then activates after permission returns', async t => {
  const f = await fixture(t); await f.app.checkForUpdates();
  f.control.authorized = false; await f.restart();
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'revoked');
  assert.equal(f.receipts.some(receipt => receipt.stage === 'healthy'), false);
  f.control.authorized = true; await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.equal(f.requests.filter(request => request.path.endsWith('/archive')).length, 1);
});

test('user restart uses normal shutdown and relaunch without activating in the running process', async t => {
  const f = await fixture(t); await f.app.checkForUpdates();
  await f.app.restartForUpdate();
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.deepEqual(f.actions.slice(-3), ['destroy', 'relaunch', 'quit']);
});

test('活动指针重命名后刷盘失败保留候选数据库，完整重启核验后再完成升级', async t => {
  const f = await fixture(t);
  const workspace = path.join(f.dataDir, 'project');
  await fs.mkdir(path.join(workspace, '.codeflowai'), { recursive: true });
  const database = path.join(f.dataDir, 'codeflowai.db'), workspaceDb = path.join(workspace, '.codeflowai', 'workspace.db');
  const root = new DatabaseSync(database);
  try {
    root.exec('CREATE TABLE workspaces(path TEXT); CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)');
    root.prepare('INSERT INTO workspaces VALUES(?)').run(workspace);
  } finally { root.close(); }
  const local = new DatabaseSync(workspaceDb);
  try { local.exec('CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)'); }
  finally { local.close(); }
  f.control.onCandidateStart = async () => {
    for (const file of [database, workspaceDb]) {
      const db = new DatabaseSync(file);
      try { db.exec('UPDATE version SET v=2'); } finally { db.close(); }
    }
  };
  await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json'), pending = await fs.readFile(pendingFile);
  const open = fs.open.bind(fs), copyFile = fs.copyFile.bind(fs);
  let pointerFault = false, restoreAttempts = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!pointerFault && args[0] === path.join(f.dataDir, 'active-release.json') && args[1] === 'r+') {
      pointerFault = true; throw Object.assign(new Error('ACTIVE_POINTER_FLUSH_FAILED'), { code: 'EIO' });
    }
    return await open(...args);
  });
  t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (String(args[1]).endsWith('.restore')) {
      restoreAttempts++;
      if (String(args[1]).startsWith(`${workspaceDb}.`)) throw Object.assign(new Error('WORKSPACE_RESTORE_FAILED'), { code: 'EIO' });
    }
    return await copyFile(...args);
  });
  await assert.rejects(f.restart());
  assert.equal(pointerFault, true);
  assert.equal(restoreAttempts, 0, '活动指针可能已提交时不能开始旧库回退');
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  for (const file of [database, workspaceDb]) {
    const db = new DatabaseSync(file);
    try { assert.equal(db.prepare('SELECT v FROM version').get()?.v, 2); } finally { db.close(); }
  }
  const marker = path.join(f.dataDir, 'update-database-backup.json');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(pendingFile), pending);
  assert.equal(f.receipts.some(receipt => receipt.stage === 'healthy'), false);
  assert.equal(f.receipts.some(receipt => ['rolled_back', 'unavailable'].includes(receipt.stage)), false, '提交未确认不能关闭原升级尝试');
  f.control.onCandidateStart = undefined;
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'healthy');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  for (const file of [database, workspaceDb]) {
    const db = new DatabaseSync(file);
    try { assert.equal(db.prepare('SELECT v FROM version').get()?.v, 2); } finally { db.close(); }
  }
  await assert.rejects(fs.access(pendingFile), { code: 'ENOENT' });
  await f.app.flushReceipts();
  assert.equal(f.receipts.filter(receipt => receipt.stage === 'healthy').length, 1);
});

test('升级直接使用现有数据库，不创建快照或因快照写入失败阻断升级', async t => {
  const f = await fixture(t); await f.app.checkForUpdates();
  const write = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).includes('update-database-backup.json')) throw new Error('SNAPSHOT_DISK_FAILED');
    return await write(...args);
  });
  f.actions.length = 0;
  const registrationCount = f.requests.filter(request => request.path.endsWith('/devices/register')).length;
  await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.equal(f.app.updateCheckFailure, null);
  assert.equal(f.actions.filter(action => action === 'start').length, 1, '启动时直接启动候选 Client');
  assert.equal(f.runtimeFacts.at(-1)?.versions.releaseId, f.manifest.releaseId, '崩溃上下文跟随已提交候选');
  assert.ok(f.requests.filter(request => request.path.endsWith('/devices/register')).length > registrationCount, '提交候选后刷新设备版本心跳');
  assert.equal(f.actions.filter(action => action === 'runtime.startup.continue').length, 1);
  await assert.rejects(fs.access(path.join(f.dataDir, 'update-database-backups')), { code: 'ENOENT' });
});

test('跨结构候选启动失败保留原库并阻止本轮及重启后启动旧版', async t => {
  const f = await fixture(t, 'different', 87);
  const database = path.join(f.dataDir, 'codeflowai.db');
  const db = new DatabaseSync(database);
  try { db.exec('CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(87)'); } finally { db.close(); }
  f.control.onCandidateStart = async () => {
    const current = new DatabaseSync(database);
    try { current.exec('UPDATE version SET v=88'); } finally { current.close(); }
    throw new Error('CANDIDATE_START_FAILED');
  };
  await f.app.checkForUpdates();
  await assert.rejects(f.restart());
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'unavailable');
  assert.equal(f.receipts.some(receipt => receipt.stage === 'rolled_back'), false);
  const current = new DatabaseSync(database);
  try { assert.equal(current.prepare('SELECT v FROM version').get()?.v, 88); } finally { current.close(); }
  const starts = f.actions.filter(action => action === 'start').length;
  await assert.rejects(f.restart(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.filter(action => action === 'start').length, starts);
  await fs.writeFile(path.join(f.dataDir, 'pending-release.json'), '{}');
  await assert.rejects(f.restart(), /DESKTOP_PENDING_RELEASE_INVALID/u);
  assert.equal(f.actions.filter(action => action === 'start').length, starts);
  await assert.rejects(fs.access(path.join(f.dataDir, 'update-database-backups')), { code: 'ENOENT' });
});

for (const damagedBaseline of [false, true]) test(`跨结构候选在写围栏后中断，可重试同一签名候选，基线损坏=${damagedBaseline}`, async t => {
  const f = await fixture(t, 'different', 87);
  if (damagedBaseline) {
    await f.installOldActive();
    await f.restart();
    await fs.writeFile(path.join(f.dataDir, 'baseline', 'baseline-release-manifest.json'), '{');
  }
  await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  const pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  await fs.mkdir(path.join(f.dataDir, 'releases'), { recursive: true });
  await fs.rename(path.join(f.dataDir, '.staging', pending.stagingName), path.join(f.dataDir, 'releases', f.manifest.releaseId));
  await fs.writeFile(pendingFile, JSON.stringify({ ...pending, databaseSchemaVersion: 88 }));
  const database = new DatabaseSync(path.join(f.dataDir, 'codeflowai.db'));
  try { database.exec('PRAGMA user_version=87'); } finally { database.close(); }
  await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  await assert.rejects(fs.access(pendingFile), { code: 'ENOENT' });
});

test('候选放行后活动指针写入失败，原活动资源正常恢复', async t => {
  const f = await fixture(t);
  await f.installBaselineVersion('0.9.0');
  await f.installOldActive();
  await f.restart();
  await f.app.checkForUpdates();
  const rename = fs.rename.bind(fs);
  let failed = false;
  const pointer = path.join(f.dataDir, 'active-release.json');
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === pointer && !failed) {
      failed = true;
      throw Object.assign(new Error('ACTIVE_POINTER_WRITE_FAILED'), { code: 'EIO' });
    }
    return await rename(...args);
  });
  await f.restart();
  assert.equal(failed, true);
  assert.equal(await readActivePointer(f.dataDir), 'baseline-release');
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'restored');
  assert.ok(f.app.updateCheckFailure);
});

test('候选 Client 放行失败不能提交健康或丢失重试记录', async t => {
  const f = await fixture(t, 'different', 87);
  await f.app.checkForUpdates();
  f.control.refuseCandidateContinuation = true;
  await assert.rejects(f.restart(), /DESKTOP_STARTUP_CONTINUATION_FAILED|切换失败/u);
  assert.equal(await readActivePointer(f.dataDir), null);
  await fs.access(path.join(f.dataDir, 'pending-release.json'));
  const pending = JSON.parse(await fs.readFile(path.join(f.dataDir, 'pending-release.json'), 'utf8'));
  const receipts = createUpdateReceiptJournal(f.dataDir);
  assert.equal(await receipts.find(f.identity.deviceId, pending.requestId, 'switched'), undefined);
  assert.equal(await receipts.find(f.identity.deviceId, pending.requestId, 'healthy'), undefined);
  assert.equal(await receipts.find(f.identity.deviceId, pending.requestId, 'unavailable'), undefined);
  f.control.refuseCandidateContinuation = false;
  await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.ok(await receipts.find(f.identity.deviceId, pending.requestId, 'healthy'));
  await assert.rejects(fs.access(path.join(f.dataDir, 'pending-release.json')), { code: 'ENOENT' });
});

test('旧版已产生但未提交的数据库快照仍沿原恢复入口收口', async t => {
  const f = await fixture(t);
  const database = path.join(f.dataDir, 'codeflowai.db');
  const db = new DatabaseSync(database);
  try { db.exec('CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)'); } finally { db.close(); }
  await createReleaseDatabaseBackup(f.dataDir).prepare('legacy-candidate');
  const changed = new DatabaseSync(database);
  try { changed.exec('UPDATE version SET v=2'); } finally { changed.close(); }
  await f.restart();
  const restored = new DatabaseSync(database);
  try { assert.equal(restored.prepare('SELECT v FROM version').get()?.v, 1); } finally { restored.close(); }
  const marker = JSON.parse(await fs.readFile(path.join(f.dataDir, 'update-database-backup.json'), 'utf8'));
  assert.equal(marker.state, 'restored');
  assert.equal(f.app.updateCheckFailure, null);
});

test('跨结构失败后覆盖安装兼容修复包接管启动，后续重启不再选择旧活动版本', async t => {
  const f = await fixture(t, 'different', 87);
  await f.installOldActive(); await f.restart();
  const database = path.join(f.dataDir, 'codeflowai.db');
  const db = new DatabaseSync(database);
  try { db.exec('CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(87)'); } finally { db.close(); }
  f.control.onCandidateStart = async () => {
    const current = new DatabaseSync(database);
    try { current.exec('UPDATE version SET v=88'); } finally { current.close(); }
    throw new Error('CANDIDATE_START_FAILED');
  };
  await f.app.checkForUpdates(); await assert.rejects(f.restart());
  assert.equal(await readActivePointer(f.dataDir), 'baseline-release');
  f.control.onCandidateStart = undefined;
  await f.installBaselineVersion('1.0.1', 88);
  f.actions.length = 0;
  await f.restart();
  assert.deepEqual(f.actions.filter(action => action.startsWith('start:')), ['start:baseline-1.0.1']);
  assert.equal(f.runtimeFacts.at(-1)?.versions.releaseId, 'baseline-1.0.1');
  assert.equal(await readActivePointer(f.dataDir), null);
  await assert.rejects(fs.access(path.join(f.dataDir, 'pending-release.json')), { code: 'ENOENT' });
  const current = new DatabaseSync(database);
  try { assert.equal(current.prepare('SELECT v FROM version').get()?.v, 88); } finally { current.close(); }
  f.actions.length = 0; await f.restart();
  assert.deepEqual(f.actions.filter(action => action.startsWith('start:')), ['start:baseline-1.0.1']);
});

test('覆盖安装的修复包不兼容时仍保留数据库围栏和旧活动指针', async t => {
  const f = await fixture(t, 'different', 87);
  await f.installOldActive(); await f.restart();
  f.control.onCandidateStart = async () => { throw new Error('CANDIDATE_START_FAILED'); };
  await f.app.checkForUpdates(); await assert.rejects(f.restart());
  await f.installBaselineVersion('1.0.1', 87);
  f.actions.length = 0;
  await assert.rejects(f.restart(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.includes('start'), false);
  assert.equal(await readActivePointer(f.dataDir), 'baseline-release');
  await fs.access(path.join(f.dataDir, 'pending-release.json'));
});

test('已提交迁移留下的待更新记录可由兼容新安装基线收口', async t => {
  const f = await fixture(t, 'different', 87);
  await f.installOldActive(); await f.restart(); await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  const pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  f.control.onCandidateStart = async () => {
    const database = new DatabaseSync(path.join(f.dataDir, 'codeflowai.db'));
    try { database.exec('PRAGMA user_version=88'); } finally { database.close(); }
  };
  await f.restart();
  await fs.writeFile(pendingFile, JSON.stringify({ ...pending, databaseSchemaVersion: 88 }));
  await f.installBaselineVersion('1.0.1', 88);
  f.host.loadWeb = async () => { throw new Error('REPAIR_WEB_FAILED'); };
  await assert.rejects(f.restart(), /REPAIR_WEB_FAILED/u);
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  await fs.access(pendingFile);
  f.host.loadWeb = async () => {};
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.version, '1.0.1');
  assert.equal(await readActivePointer(f.dataDir), null);
  await assert.rejects(fs.access(pendingFile), { code: 'ENOENT' });
});

test('已损坏的活动资源由基线接管后，同一签名发布可重新启用', async t => {
  const f = await fixture(t, 'different', 87);
  await f.installBaselineVersion('0.9.0', 88); await f.restart();
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  const entry = path.join(f.dataDir, 'releases', f.manifest.releaseId, 'client', 'dist', 'index.cjs');
  await fs.unlink(entry);
  await f.restart();
  assert.equal(await readActivePointer(f.dataDir), null);
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
  assert.equal(await fs.readFile(entry, 'utf8'), 'client');
  assert.equal(f.app.updateCheckFailure, null);
});

test('原活动版本的 Web 启动失败时保留尚未收口的已提交更新记录', async t => {
  const f = await fixture(t);
  await f.app.checkForUpdates();
  const pendingFile = path.join(f.dataDir, 'pending-release.json');
  const pending = await fs.readFile(pendingFile);
  await f.restart(); await f.app.flushReceipts();
  await fs.writeFile(pendingFile, pending);
  f.host.loadWeb = async () => { throw new Error('ACTIVE_WEB_FAILED'); };
  await assert.rejects(f.restart(), /ACTIVE_WEB_FAILED/u);
  assert.deepEqual(await fs.readFile(pendingFile), pending);
  assert.equal(await readActivePointer(f.dataDir), f.manifest.releaseId);
});

test('更高结构修复包页面失败保留更高围栏、旧指针和待更新记录', async t => {
  const f = await fixture(t, 'different', 87);
  await f.installOldActive(); await f.restart();
  f.control.onCandidateStart = async () => { throw new Error('CANDIDATE_START_FAILED'); };
  await f.app.checkForUpdates(); await assert.rejects(f.restart());
  await f.installBaselineVersion('1.0.2', 89);
  f.host.loadWeb = async () => { throw new Error('REPAIR_WEB_FAILED'); };
  f.actions.length = 0;
  await assert.rejects(f.restart(), /REPAIR_WEB_FAILED/u);
  assert.deepEqual(f.actions.filter(action => action.startsWith('start:')), ['start:baseline-1.0.2']);
  assert.equal(await readActivePointer(f.dataDir), 'baseline-release');
  const pending = JSON.parse(await fs.readFile(path.join(f.dataDir, 'pending-release.json'), 'utf8'));
  assert.equal(pending.databaseSchemaVersion, 89);
  await f.installBaselineVersion('1.0.1', 88);
  f.actions.length = 0;
  await assert.rejects(f.restart(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.includes('start'), false);
});

test('同结构新页面失败只回退资源，保留候选已经写入的原库内容', async t => {
  const f = await fixture(t);
  const database = path.join(f.dataDir, 'codeflowai.db');
  const db = new DatabaseSync(database);
  try { db.exec('CREATE TABLE version(v INTEGER); INSERT INTO version VALUES(1)'); } finally { db.close(); }
  f.control.onCandidateStart = async () => {
    const current = new DatabaseSync(database);
    try { current.exec('UPDATE version SET v=2'); } finally { current.close(); }
  };
  f.control.rejectLoadWeb = true;
  const runtimeFactCount = f.runtimeFacts.length;
  await f.app.checkForUpdates(); await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, 'restored');
  assert.ok(f.runtimeFacts.length > runtimeFactCount, '资源回滚后重新发布实际恢复版本事实');
  assert.equal(f.runtimeFacts.at(-1)?.versions.releaseId, 'baseline-release');
  assert.equal(await readActivePointer(f.dataDir), null);
  const current = new DatabaseSync(database);
  try { assert.equal(current.prepare('SELECT v FROM version').get()?.v, 2); } finally { current.close(); }
  await assert.rejects(fs.access(path.join(f.dataDir, 'update-database-backups')), { code: 'ENOENT' });
});

test('无法读取待更新安全事实时启动失败，不猜测数据库仍兼容旧版', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, 'pending-release.json'), '{}');
  const starts = f.actions.filter(action => action === 'start').length;
  await assert.rejects(f.restart(), /DESKTOP_PENDING_RELEASE_INVALID/u);
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal(f.actions.filter(action => action === 'start').length, starts);
  assert.equal(f.receipts.some(receipt => receipt.stage === 'healthy'), false);
});
