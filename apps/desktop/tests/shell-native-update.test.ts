import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signShellReleaseManifest } from '@codeflowai/shared/desktop-shell-release-signing';
import { DESKTOP_DEVICE_AUTH_HEADERS, desktopDevicePublicKeySha256 } from '@codeflowai/shared/desktop-device-auth';
import { loadOrCreateDeviceIdentity } from '../src/deviceIdentity.js';
import { serializeShellLaunchState } from '../src/shellLaunchState.js';
import type { ShellUpdateOperationInput } from '../src/shellUpdateOperation.js';
import type { ProcessIdentity } from '../src/windowsProcessIdentity.js';
import { runShellUpdateOperation } from '../src/shellUpdateOperation.js';

const implementation = existsSync(new URL('../src/shellNativeUpdate.ts', import.meta.url)) ? await import('../src/shellNativeUpdate.js') : {};

/** RED 同样核对公开执行入口；测试从不执行合成 exe。 */
async function run(input: ShellUpdateOperationInput, boundary: unknown) {
  const entry = (implementation as Record<string, unknown>).runNativeShellUpdate;
  assert.equal(typeof entry, 'function', 'runNativeShellUpdate must be available');
  return await (entry as (input: ShellUpdateOperationInput, boundary: unknown) => Promise<any>)(input, boundary);
}

/** 仅活动壳、真实签名和普通目录；刻意不创建 Client、Web、数据库及历史 baseline。 */
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-shell-update-')));
  t.after(() => fs.rm(root, { recursive: true }));
  const installationDir = path.join(root, 'installation'), dataDir = path.join(root, 'data');
  const userDataDir = path.join(root, 'profile'), sessionDataDir = path.join(root, 'session');
  for (const directory of [path.join(installationDir, 'shells', 'old'), dataDir, userDataDir, sessionDataDir]) await fs.mkdir(directory, { recursive: true });
  const executable = path.join(installationDir, 'shells', 'old', 'CodeFlowAI.exe');
  await fs.writeFile(executable, 'old shell');
  const state = { activeShellId: 'old', previousShellId: null, baselineShellId: 'missing-baseline' };
  await fs.writeFile(path.join(installationDir, 'shell-launch.ini'), serializeShellLaunchState(state));
  const identity = await loadOrCreateDeviceIdentity(dataDir), keys = crypto.generateKeyPairSync('ed25519');
  const installer = Buffer.from('signed synthetic installer');
  const contents = { 'CodeFlowAI.exe': 'new shell', 'resources/app.asar': 'shell only', 'resources/release-trust.json': '{}' };
  const payload = { schemaVersion: 1 as const, protocol: 'codeflow-desktop-shell-v1' as const, shellId: 'next', version: '1.1',
    platform: 'win32' as const, arch: 'x64' as const, installerSha256: crypto.createHash('sha256').update(installer).digest('hex'), installerSize: installer.length,
    files: Object.entries(contents).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: crypto.createHash('sha256').update(bytes).digest('hex') })),
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', keyId: 'fixture' };
  let manifest = signShellReleaseManifest(payload, keys.privateKey);
  const candidateDirectory = path.join(installationDir, 'shells', 'next');
  for (const [relative, bytes] of Object.entries(contents)) { const file = path.join(candidateDirectory, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  const actions: string[] = [], controller = new AbortController();
  const main: ProcessIdentity = { pid: 101, parentPid: 90, created: 1001, executable, commandLine: 'original main' };
  const client: ProcessIdentity = { pid: 102, parentPid: main.pid, created: 1002, executable: path.join(root, 'missing-client.exe'), commandLine: 'failed client' };
  let processes = [main, client], authorized = true;
  const input: ShellUpdateOperationInput = { shellVersion: '1.0', dataDir, initialReleaseDir: path.join(root, 'missing-resources'), identity,
    trustedKeys: { fixture: keys.publicKey }, configuredServerOrigin: 'http://127.0.0.1:40411', requestId: crypto.randomUUID(), signal: controller.signal,
    facts: { installationDir, userDataDir, sessionDataDir, main }, getClient: () => ({ status: 'failed', pid: client.pid, health: null, errorCode: 'BROKEN_DATABASE', requestId: null, releaseId: null }),
    async onRetry() { assert.fail('unexpected retry'); },
    hooks: { async prepare() { actions.push('prepare'); return true; }, async drain() { actions.push('drain'); processes = [main]; },
      async resume() { actions.push('resume'); processes = [main, client]; }, committed() { actions.push('committed'); } } };
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const pathname = new URL(String(url)).pathname, headers = options?.headers as Record<string, string>;
    actions.push(pathname);
    const requestId = headers[DESKTOP_DEVICE_AUTH_HEADERS.requestId];
    if (pathname.endsWith('/devices/register')) return Response.json({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) });
    if (pathname.endsWith('/shell-release-availability')) return Response.json({ ok: true, available: true, deviceId: identity.deviceId, requestId, manifest });
    if (pathname.endsWith('/installer')) return new Response(installer, { headers: { etag: `"${manifest.installerSha256}"`, 'content-length': String(installer.length) } });
    if (pathname.endsWith('/switch-authorization')) return Response.json({ ok: true, authorized, deviceId: identity.deviceId, requestId, shellId: manifest.shellId,
      ...(authorized ? { installerSha256: manifest.installerSha256, manifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex') } : {}) });
    throw new Error('unexpected test URL');
  });
  const boundary = { async test() { actions.push('self-test'); }, async snapshot() { return structuredClone(processes); },
    async switch(options: Record<string, unknown>) { actions.push('switch'); assert.equal(options.userDataDir, userDataDir); assert.equal(options.sessionDataDir, sessionDataDir);
      return { check() {}, release() { actions.push('release'); }, async cancel() { actions.push('cancel'); } }; } };
  return { root, input, boundary, actions, controller, candidateDirectory, state, installer, main, client,
    get manifest() { return manifest; }, setManifest(changes: Partial<typeof payload>) { manifest = signShellReleaseManifest({ ...payload, ...changes }, keys.privateKey); },
    denyAuthorization() { authorized = false; }, setProcesses(value: ProcessIdentity[]) { processes = value; } };
}

test('native shell update prepares and hands off without Client health, resources, SQLite or an old attempt', async t => {
  const f = await fixture(t), result = await run(f.input, f.boundary);
  assert.equal(result.status, 'handoff');
  assert.ok(f.actions.indexOf('self-test') < f.actions.indexOf('prepare'));
  assert.ok(f.actions.findIndex(value => value.endsWith('/switch-authorization')) < f.actions.indexOf('drain'));
  assert.deepEqual(f.actions.slice(-3), ['drain', 'switch', 'committed']);
  assert.equal((await fs.readdir(f.input.dataDir)).some(name => name.includes('attempt')), false);
  assert.equal(await fs.readFile(path.join(f.input.facts.installationDir, 'shell-launch.ini'), 'utf8'), serializeShellLaunchState(f.state));
  result.owner.release();
});

for (const version of ['1.0', '0.9']) test(`native shell version ${version} does not download or inspect candidate files`, async t => {
  const f = await fixture(t); f.setManifest({ version });
  await fs.rm(f.candidateDirectory, { recursive: true });
  assert.equal((await run(f.input, f.boundary)).status, 'no-update');
  assert.equal(f.actions.some(value => value.endsWith('/installer')), false);
  assert.equal(f.actions.includes('self-test'), false);
});

test('postponing a prepared native shell never drains or starts the switch executor', async t => {
  const f = await fixture(t); f.input.hooks.prepare = async () => false;
  assert.equal((await run(f.input, f.boundary)).status, 'postponed');
  assert.equal(f.actions.includes('drain'), false); assert.equal(f.actions.includes('switch'), false);
});

test('authorization rejection cancels this preparation without draining the original Client', async t => {
  const f = await fixture(t); f.denyAuthorization();
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.equal(f.actions.includes('drain'), false); assert.equal(f.actions.includes('switch'), false); assert.equal(f.actions.includes('resume'), true);
});

test('cancellation during drain stops subsequent switch and restores only this operation', async t => {
  const f = await fixture(t);
  f.input.hooks.drain = async () => { f.actions.push('drain'); f.controller.abort(new Error('cancelled during drain')); };
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.equal(f.actions.includes('switch'), false); assert.equal(f.actions.filter(value => value === 'resume').length, 1);
});

test('an unchanged owned Client process after drain prevents any switch', async t => {
  const f = await fixture(t); f.input.hooks.drain = async () => { f.actions.push('drain'); };
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.equal(f.actions.includes('switch'), false); assert.equal(f.actions.includes('resume'), true);
});

for (const change of ['signature', 'expired', 'platform', 'same-id', 'request']) test(`native ${change} discovery failure stops before installer download`, async t => {
  const f = await fixture(t);
  if (change === 'expired') f.setManifest({ expiresAt: '2026-01-02T00:00:00.000Z' });
  if (change === 'same-id') f.setManifest({ shellId: 'old' });
  f.input.discovery = async requestId => ({ ok: true, available: true, requestId: change === 'request' ? 'different' : requestId,
    deviceId: f.input.identity.deviceId, manifest: change === 'signature' ? { ...f.manifest, version: '2.0' }
      : change === 'platform' ? { ...f.manifest, platform: 'darwin' } as any : f.manifest });
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.equal(f.actions.some(value => value.endsWith('/installer')), false);
  assert.equal(f.actions.includes('prepare'), false); assert.equal(f.actions.includes('drain'), false);
});

for (const version of [undefined, 'unknown', '1', '1.0-rc', '1.9007199254740992']) test(`native current version ${version} cannot be guessed`, async t => {
  const f = await fixture(t); f.input.shellVersion = version;
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.deepEqual(f.actions, []);
});

test('cancellation after successful preparation restores admission before any authorization', async t => {
  const f = await fixture(t);
  f.input.hooks.prepare = async () => { f.actions.push('prepare'); f.controller.abort(new Error('cancelled after confirmation')); return true; };
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.equal(f.actions.some(value => value.endsWith('/switch-authorization')), false);
  assert.equal(f.actions.includes('drain'), false); assert.equal(f.actions.includes('resume'), true);
});

test('cancellation while the switch executor starts cancels it before restoring the stopped Client', async t => {
  const f = await fixture(t), start = f.boundary.switch;
  f.boundary.switch = async input => { const executor = await start(input); f.controller.abort(new Error('cancelled while starting executor')); return executor; };
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.ok(f.actions.indexOf('cancel') < f.actions.indexOf('resume'));
  assert.equal(f.actions.includes('committed'), false);
});

test('an executor cancellation failure retains its owner and cannot resume the Client prematurely', async t => {
  const f = await fixture(t), start = f.boundary.switch, cleanup = new Error('executor cancellation denied');
  let failed = false;
  f.boundary.switch = async input => {
    const executor = await start(input);
    return { ...executor, async cancel() { f.actions.push('cancel'); if (!failed) { failed = true; throw cleanup; } } };
  };
  f.input.hooks.committed = () => { throw new Error('commit observer failed'); };
  let failure: any;
  await assert.rejects(run(f.input, f.boundary), error => { failure = error; return true; });
  assert.equal(failure.recovery, 'failed'); assert.ok(failure.helperOwner);
  assert.equal(f.actions.includes('resume'), false);
  await failure.helperOwner.recover(failure);
  assert.equal(f.actions.includes('resume'), true);
});

test('recovering after the application UI was destroyed never restarts Client', async t => {
  const f = await fixture(t), result = await run(f.input, f.boundary);
  await result.owner.recover(new Error('quit failed after UI cleanup'), false);
  assert.equal(f.actions.includes('cancel'), true); assert.equal(f.actions.includes('resume'), false);
});

test('candidate inventory mismatch fails the install phase without changing the active selection', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.candidateDirectory, 'unexpected.txt'), 'unsigned extra');
  await assert.rejects(run(f.input, f.boundary), (error: unknown) => {
    assert.equal((error as { failurePhase: string }).failurePhase, 'install'); return true;
  });
  assert.equal(f.actions.includes('self-test'), false); assert.equal(f.actions.includes('drain'), false);
});

test('cache links are rejected before any installer file is written outside the data directory', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.input.dataDir, '.staging'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(f.input, f.boundary), { code: 'DESKTOP_SHELL_OPERATION_FAILED' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('default operation dispatch never touches a corrupt legacy attempt or missing business baseline', async t => {
  const f = await fixture(t); f.setManifest({ version: '1.0' });
  await fs.writeFile(path.join(f.input.dataDir, 'shell-update-attempt.json'), '{broken historical attempt');
  assert.equal((await runShellUpdateOperation(f.input)).status, 'no-update');
  assert.equal(await fs.readFile(path.join(f.input.dataDir, 'shell-update-attempt.json'), 'utf8'), '{broken historical attempt');
});
