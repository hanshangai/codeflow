import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signReleaseBundleManifest } from '@codeflowai/shared/desktop-release-signing';
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, readDesktopDeviceHeaders,
  verifyDesktopDeviceSignature } from '@codeflowai/shared/desktop-device-auth';
import { createDesktopUpdateReceipt, type DesktopUpdateReceipt } from '@codeflowai/shared/desktop-update-receipt';
import { createDesktopApplication, type DesktopHost } from '../src/desktopApplication.js';
import type { ClientRuntime } from '../src/clientRuntime.js';
import { loadOrCreateDeviceIdentity } from '../src/deviceIdentity.js';
import { readActivePointer } from '../src/releaseBundleCoordinator.js';
import { createUpdateFailureJournal } from '../src/updateFailureJournal.js';
import { createUpdateReceiptJournal } from '../src/updateReceiptJournal.js';

/** 确认窗口和网络检查使用显式屏障，避免以延迟推断操作顺序。 */
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** 原应用、签名传输与日志使用临时真实资源，运行时替身仅记录调度。 */
async function fixture(t: test.TestContext, options: { busy?: boolean; expiresAt?: number } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-d12m-desktop-'));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  const requestId = crypto.randomUUID();
  const actions: string[] = [];
  const receipts: DesktopUpdateReceipt[] = [];
  const authorizationRequests: string[] = [];
  const serverFailures: unknown[] = [];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const packageDir = path.join(dataDir, 'incoming');
  await fs.mkdir(path.join(packageDir, 'web'), { recursive: true });
  await fs.mkdir(path.join(packageDir, 'client', 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'web', 'index.html'), 'web');
  await fs.writeFile(path.join(packageDir, 'client', 'dist', 'index.cjs'), 'client');
  const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  const webSha256 = hash(`index.html\0${hash('web')}\n`);
  const clientSha256 = hash(`dist/index.cjs\0${hash('client')}\n`);
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: 'switch-release', version: '2.0.0',
    webVersion: '2.1.0', clientVersion: '2.2.0', protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 88,
    platform: process.platform, arch: process.arch, keyId: 'switch-fixture', archiveSha256: 'f'.repeat(64), archiveSize: 100,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: 'client/dist/index.cjs', size: 6, sha256: hash('client') }, { path: 'web/index.html', size: 3, sha256: hash('web') }],
    createdAt: '2026-10-24T00:00:00.000Z', expiresAt: new Date(options.expiresAt ?? Date.parse('2099-10-24T00:00:00.000Z')).toISOString(),
  }, privateKey);
  await fs.writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest));
  const window = Object.assign(new EventEmitter(), { show() {}, focus() {}, hide() {}, destroy() {} });
  const runtime: ClientRuntime = {
    async start() { actions.push('start'); }, async waitReady() { actions.push('ready'); }, async stop() {},
    async drain() { actions.push('drain'); }, onEvent() { return () => {}; },
    async request(request) {
      actions.push(request.method);
      if (request.method === 'runtime.update.prepare') return { status: 200, body: { ok: true, hasRunningSessions: options.busy ?? false } };
      return { status: 200, body: { ok: true } };
    },
    snapshot() { return { status: 'ready', requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: '1.0.0', dbSchemaVersion: 88, database: 'ready' } }; },
  };
  const host: DesktopHost = { createWindow: () => window, async loadWeb() { actions.push('reload-web'); },
    createTray: () => ({ destroy() {} }), registerBridge: () => () => {}, quit() {},
    async confirmUpdate() { actions.push('confirm'); return true; } };
  const ack = (authorized = true) => ({ ok: true, authorized, deviceId: identity.deviceId, requestId, releaseId: manifest.releaseId,
    ...(authorized ? { archiveSha256: manifest.archiveSha256 } : {}) });
  const control = { respond: async (_request: http.IncomingMessage, response: http.ServerResponse) => { response.end(JSON.stringify(ack())); } };
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const meta = readDesktopDeviceHeaders(request.rawHeaders);
      assert.equal(meta.deviceId, identity.deviceId);
      verifyDesktopDeviceSignature(identity.publicKeyBase64, buildDesktopDevicePayload({ ...meta, method: request.method!, url: request.url!, body }), meta.signature);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/software/desktop/devices/register') {
        response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      } else if (request.url === '/api/software/desktop/update-receipts') {
        const record = JSON.parse(body.toString('utf8')) as DesktopUpdateReceipt;
        receipts.push(record);
        response.end(JSON.stringify({ ok: true, deviceId: record.deviceId, requestId: record.requestId, releaseId: record.releaseId,
          archiveSha256: record.archiveSha256, stage: record.stage, at: record.at, payloadSha256: record.payloadSha256 }));
      } else {
        assert.equal(request.method, 'GET');
        assert.equal(request.url, `/api/software/desktop/releases/${manifest.releaseId}/switch-authorization`);
        assert.equal(meta.requestId, requestId);
        authorizationRequests.push(meta.requestId); actions.push('switch-authorization');
        await control.respond(request, response);
      }
    })().catch(error => { serverFailures.push(error); response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const app = createDesktopApplication({ dataDir, initialReleaseDir: dataDir, trustedReleaseKeys: { 'switch-fixture': publicKey }, host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => runtime });
  let started = false;
  t.after(async () => {
    if (started) await app.exit();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(serverFailures, []);
  });
  await app.start(); started = true;
  await app.reportReceipt(createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId, releaseId: manifest.releaseId,
    archiveSha256: manifest.archiveSha256, stage: 'received', at: new Date().toISOString(), errorCode: null, errorId: null }));
  actions.length = 0;
  const failures = () => createUpdateFailureJournal(dataDir).pending(identity.deviceId);
  return { app, dataDir, packageDir, manifest, identity, requestId, actions, receipts, authorizationRequests, host, runtime, control, ack, failures };
}

/** 准入检查失败不能进入中断、停止、重载或提交活动指针。 */
async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.actions.includes('runtime.update.interrupt'), false);
  assert.equal(f.actions.includes('drain'), false);
  assert.equal(f.actions.includes('reload-web'), false);
  assert.equal(f.actions.at(-1), 'runtime.update.cancel');
  assert.equal(await readActivePointer(f.dataDir), null);
  await fs.access(path.join(f.dataDir, 'releases', f.manifest.releaseId, 'web', 'index.html'));
  assert.deepEqual(f.receipts.map(record => record.stage), ['received', 'verified', 'prepared']);
}

for (const busy of [false, true]) test(`switch authorization runs after ${busy ? 'confirmation' : 'idle preparation'} before interruption`, async t => {
  const f = await fixture(t, { busy });
  assert.equal((await f.app.applyRelease(f.packageDir, { requestId: f.requestId }))?.releaseId, f.manifest.releaseId);
  assert.deepEqual(f.actions.slice(0, busy ? 5 : 4), busy
    ? ['runtime.update.prepare', 'confirm', 'switch-authorization', 'runtime.update.interrupt', 'drain']
    : ['runtime.update.prepare', 'switch-authorization', 'runtime.update.interrupt', 'drain']);
  assert.deepEqual(f.authorizationRequests, [f.requestId]);
  assert.deepEqual(f.receipts.map(record => record.stage), ['received', 'verified', 'prepared', 'switched', 'healthy']);
  assert.equal(f.receipts.every(record => record.requestId === f.requestId), true);
});

test('pause during confirmation preserves package and original receipts, then retry rechecks the same attempt', async t => {
  const f = await fixture(t, { busy: true });
  const confirming = barrier(); const answer = barrier(); let authorized = true;
  f.host.confirmUpdate = async () => { f.actions.push('confirm'); confirming.release(); await answer.promise; return true; };
  f.control.respond = async (_request, response) => { response.end(JSON.stringify(f.ack(authorized))); };
  const applying = f.app.applyRelease(f.packageDir, { requestId: f.requestId });
  await confirming.promise; assert.deepEqual(f.authorizationRequests, []);
  authorized = false; answer.release(); assert.equal(await applying, null);
  await assertPreserved(f); assert.deepEqual(f.failures(), []);
  const journal = createUpdateReceiptJournal(f.dataDir);
  const originalPrepared = await journal.find(f.identity.deviceId, f.requestId, 'prepared');
  const originalVerified = await journal.find(f.identity.deviceId, f.requestId, 'verified');
  f.actions.length = 0; authorized = true;
  assert.equal((await f.app.applyRelease(f.packageDir, { requestId: f.requestId }))?.releaseId, f.manifest.releaseId);
  assert.deepEqual(f.authorizationRequests, [f.requestId, f.requestId]);
  assert.deepEqual(await journal.find(f.identity.deviceId, f.requestId, 'prepared'), originalPrepared);
  assert.deepEqual(await journal.find(f.identity.deviceId, f.requestId, 'verified'), originalVerified);
  assert.deepEqual(f.failures(), []);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, '.staging')), []);
});

test('choosing later skips the authorization request and resumes admission without a failure', async t => {
  const f = await fixture(t, { busy: true });
  f.host.confirmUpdate = async () => { f.actions.push('confirm'); return false; };
  assert.equal(await f.app.applyRelease(f.packageDir, { requestId: f.requestId }), null);
  await assertPreserved(f); assert.deepEqual(f.authorizationRequests, []); assert.deepEqual(f.failures(), []);
});

test('cancelling at confirmation prevents authorization and keeps the existing cancellation failure contract', async t => {
  const f = await fixture(t, { busy: true }); const controller = new AbortController();
  f.host.confirmUpdate = async () => { f.actions.push('confirm'); controller.abort(new Error('confirmation-cancelled')); return true; };
  await assert.rejects(() => f.app.applyRelease(f.packageDir, { requestId: f.requestId, signal: controller.signal }), /confirmation-cancelled/u);
  await assertPreserved(f); assert.deepEqual(f.authorizationRequests, []); assert.equal(f.failures().length, 1);
});

test('an authorization already returned is a time snapshot rather than a live pause subscription', async t => {
  const f = await fixture(t); let paused = false;
  f.control.respond = async (_request, response) => { response.end(JSON.stringify(f.ack(!paused))); };
  const original = f.runtime.request;
  f.runtime.request = async request => {
    if (request.method === 'runtime.update.interrupt') paused = true;
    return await original(request);
  };
  assert.equal((await f.app.applyRelease(f.packageDir, { requestId: f.requestId }))?.releaseId, f.manifest.releaseId);
  assert.equal(paused, true); assert.deepEqual(f.authorizationRequests, [f.requestId]);
  assert.deepEqual(f.failures(), []);
});

const badAcks: Array<[string, (ack: Record<string, unknown>) => unknown]> = [
  ['foreign device', ack => ({ ...ack, deviceId: crypto.randomUUID() })],
  ['different attempt', ack => ({ ...ack, requestId: crypto.randomUUID() })],
  ['different release', ack => ({ ...ack, releaseId: 'other-release' })],
  ['different archive', ack => ({ ...ack, archiveSha256: 'a'.repeat(64) })],
  ['extra field', ack => ({ ...ack, path: 'PRIVATE_REMOTE_PATH' })],
  ['missing archive', ack => { const { archiveSha256: _hash, ...rest } = ack; return rest; }],
  ['missing identity', ack => { const { deviceId: _device, ...rest } = ack; return rest; }],
  ['string authorization', ack => ({ ...ack, authorized: 'true' })],
  ['string API envelope', ack => ({ ...ack, ok: 'true' })],
  ['negative with archive', ack => ({ ...ack, authorized: false })],
  ['array body', ack => [ack]],
];
for (const [name, change] of badAcks) test(`invalid switch ACK ${name} fails closed with one existing failure record`, async t => {
  const f = await fixture(t);
  f.control.respond = async (_request, response) => { response.end(JSON.stringify(change(f.ack()))); };
  await assert.rejects(() => f.app.applyRelease(f.packageDir, { requestId: f.requestId }), { code: 'DESKTOP_UPDATE_RESPONSE_INVALID' });
  await assertPreserved(f);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0]!.phase, 'drain');
  assert.equal(f.failures()[0]!.requestId, f.requestId);
  assert.equal(JSON.stringify(f.failures()).includes('PRIVATE_REMOTE_PATH'), false);
});

for (const kind of ['http', 'json', 'cancel'] as const) test(`switch authorization ${kind} failure resumes admission and preserves the package`, async t => {
  const f = await fixture(t); const controller = new AbortController();
  f.control.respond = async (_request, response) => {
    if (kind === 'http') { response.writeHead(503); response.end(JSON.stringify({ ok: false, code: 'DESKTOP_UPDATE_UNAVAILABLE' })); }
    else if (kind === 'json') response.end('PRIVATE_BROKEN_JSON');
    else { controller.abort(new Error('switch-check-cancelled')); response.end(JSON.stringify(f.ack())); }
  };
  await assert.rejects(() => f.app.applyRelease(f.packageDir, { requestId: f.requestId, signal: controller.signal }), error => {
    if (kind === 'http') assert.equal((error as { code?: string }).code, 'DESKTOP_UPDATE_UNAVAILABLE');
    else if (kind === 'json') assert.equal((error as { code?: string }).code, 'DESKTOP_UPDATE_RESPONSE_INVALID');
    return true;
  });
  await assertPreserved(f); assert.equal(f.failures().length, 1);
  assert.equal(JSON.stringify(f.failures()).includes('PRIVATE_BROKEN_JSON'), false);
});

test('negative authorization whose admission recovery fails remains a real aggregate failure', async t => {
  const f = await fixture(t);
  f.control.respond = async (_request, response) => { response.end(JSON.stringify(f.ack(false))); };
  const original = f.runtime.request;
  f.runtime.request = async request => {
    if (request.method === 'runtime.update.cancel') { f.actions.push(request.method); throw new Error('ADMISSION_RESUME_FAILED'); }
    return await original(request);
  };
  await assert.rejects(() => f.app.applyRelease(f.packageDir, { requestId: f.requestId }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, 'DESKTOP_UPDATE_ADMISSION_RESUME_FAILED');
    assert.equal(error.errors[1].message, 'ADMISSION_RESUME_FAILED'); return true;
  });
  await assertPreserved(f); assert.equal(f.failures().length, 1);
});

test('a positive authorization cannot switch a package that expired while confirmation was open', async t => {
  let now = Date.parse('2026-10-26T12:00:00.000Z'); const expiresAt = now + 60_000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { busy: true, expiresAt });
  f.host.confirmUpdate = async () => { f.actions.push('confirm'); now = expiresAt - 1; return true; };
  f.control.respond = async (_request, response) => { now = expiresAt; response.end(JSON.stringify(f.ack())); };
  await assert.rejects(() => f.app.applyRelease(f.packageDir, { requestId: f.requestId }), { code: 'DESKTOP_RELEASE_EXPIRED' });
  await assertPreserved(f); assert.equal(f.failures().length, 1);
  assert.deepEqual(f.authorizationRequests, [f.requestId]);
});
