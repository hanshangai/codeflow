import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import test from 'node:test';
import { openClientDb } from '../src/db/clientDb.js';
import { assertDesktopStartupCapability } from '@codeflowai/shared';
import { terminateCliProcessTree } from '../src/app/handlers/engineHandlers.js';

/** 失败先严格终止所属树并观察真实 close；清理副错保留在主因后。 */
async function waitForClose(child: import('node:child_process').ChildProcess, timeoutMs: number, send?: (fail: (error: unknown) => void) => void) {
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', rejectFailure);
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  timer = setTimeout(() => rejectFailure(new Error('UNINSTALL_TEST_PROCESS_TIMEOUT')), timeoutMs);
  try { send?.(rejectFailure); return await Promise.race([exited, failure]); }
  catch (error) {
    const secondary: unknown[] = [];
    if (!closed) {
      try {
        const stopped = await terminateCliProcessTree(child, { timeoutMs: 10_000, strictTreeConfirmation: true });
        if (stopped !== null) secondary.push(new Error(stopped));
      } catch (stopError) { secondary.push(stopError); }
      try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error('UNINSTALL_TEST_CLOSE_TIMEOUT')), 10_000); })]); }
      catch (closeError) { secondary.push(closeError); }
    }
    throw secondary.length ? new AggregateError([error, ...secondary], 'UNINSTALL_TEST_PROCESS_CLEANUP_FAILED', { cause: error }) : error;
  } finally { clearTimeout(timer); clearTimeout(closeTimer); }
}

/** 构建与测试子进程都等待 close，并留原始输出、时间和退出证据。 */
async function command(root: string, name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 180_000) {
  const startedAt = new Date().toISOString(), stdout: Buffer[] = [], stderr: Buffer[] = [];
  const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_OPTIONS'
    && !key.startsWith('CODEFLOWAI_') && !/(TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)/iu.test(key)));
  const child = spawn(process.execPath, args, { cwd, env: isolatedEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  let closed = false;
  child.once('close', () => { closed = true; });
  try {
    const result = await waitForClose(child, timeoutMs);
    const output = Buffer.concat(stdout).toString('utf8'), errors = Buffer.concat(stderr).toString('utf8');
    await fs.writeFile(path.join(root, `${name}.stdout.log`), output, 'utf8');
    await fs.writeFile(path.join(root, `${name}.stderr.log`), errors, 'utf8');
    await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify({ command: [process.execPath, ...args], cwd, startedAt, endedAt: new Date().toISOString(), pid: child.pid,
      ...result, closed, stdoutSha256: crypto.createHash('sha256').update(output).digest('hex'), stderrSha256: crypto.createHash('sha256').update(errors).digest('hex') }, null, 2), 'utf8');
    return { ...result, output, errors };
  } catch (error) {
    await fs.writeFile(path.join(root, `${name}.stdout.log`), Buffer.concat(stdout));
    await fs.writeFile(path.join(root, `${name}.stderr.log`), Buffer.concat(stderr));
    await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify({ command: [process.execPath, ...args], startedAt, endedAt: new Date().toISOString(), pid: child.pid,
      closed, failed: true, error: String(error), causes: error instanceof AggregateError ? error.errors.map(String) : [] }, null, 2), 'utf8');
    throw error;
  }
}

test('uninstall build process timeout fails and confirms close of the owned process', async () => {
  const root = await fs.mkdtemp(path.join(process.env.CF_UNINSTALL_EVIDENCE_ROOT ?? os.tmpdir(), 'controlled-process-'));
  await assert.rejects(command(root, 'timeout', path.resolve(import.meta.dirname, '..'), ['-e', 'setInterval(() => {}, 1000)'], process.env, 200), /UNINSTALL_TEST_PROCESS_TIMEOUT/u);
  const result = JSON.parse(await fs.readFile(path.join(root, 'timeout.json'), 'utf8'));
  assert.equal(result.closed, true);
  assert.equal(result.failed, true);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});

/** 直接复用原完整构建测试的真实快照及依赖处理，不再建第二套构建夹具。 */
test('real full Client package includes callable uninstall worker and rejects its failed build before capability publication', { timeout: 240_000 }, async () => {
  const evidence = process.env.CF_UNINSTALL_EVIDENCE_ROOT ?? path.join(os.tmpdir(), 'uninstall-build');
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidence, 'consumer-'));
  const clientDir = path.resolve(import.meta.dirname, '..');
  const original = await command(root, 'original-full-build', clientDir,
    ['--conditions', 'development', '--import', 'tsx', '--test', '--test-name-pattern', '^the real current Client build declares held startup only after all original entries succeed$', 'tests/desktop-startup-capability-build.test.ts'],
    { ...process.env, CF_STARTUP_CAPABILITY_EVIDENCE_ROOT: root });
  assert.equal(original.code, 0, original.errors + original.output); assert.equal(original.signal, null);
  const snapshots = (await fs.readdir(root)).filter(name => name.startsWith('real-build-'));
  assert.equal(snapshots.length, 1);
  const snapshot = path.join(root, snapshots[0]), client = path.join(snapshot, 'apps/desktop/client'), dist = path.join(client, 'dist');
  const worker = path.join(dist, 'desktopUninstallWorker.cjs');
  assert.ok((await fs.stat(worker)).isFile());
  const marker = assertDesktopStartupCapability(JSON.parse(await fs.readFile(path.join(dist, 'desktop-startup-capability.json'), 'utf8')));
  assert.equal(marker.clientEntrySha256, crypto.createHash('sha256').update(await fs.readFile(path.join(dist, 'index.cjs'))).digest('hex'));

  const dataDir = path.join(root, 'ipc-data'); await fs.mkdir(dataDir);
  const dbPath = path.join(dataDir, 'codeflowai.db'), db = openClientDb({ dbPath });
  db.db.prepare("INSERT INTO meta(key,value) VALUES ('client_id','package-client')").run();
  const key = db.engineKeys.insert({ label: 'package', engine: 'codex', providerId: 'openai', apiKey: 'package-secret' });
  db.close();
  await fs.writeFile(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: 'plain_sqlite', ownership: 'local_os_user', initializationState: 'ready' }), 'utf8');
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ clientId: 'package-client', apiKey: 'cloud-secret' }), 'utf8');
  const startedAt = new Date().toISOString(), messages: unknown[] = [], stderr: Buffer[] = [];
  const child = fork(worker, [], { cwd: client, execArgv: [], silent: true, detached: process.platform !== 'win32' });
  child.on('message', value => messages.push(value)); child.stderr!.on('data', bytes => stderr.push(bytes));
  const closed = await waitForClose(child, 15_000, fail => child.send({ schemaVersion: 1, requestId: 'package-cleanup', dataDir, clientId: 'package-client', deviceId: crypto.randomUUID() }, error => { if (error) fail(error); }));
  const { code } = closed;
  const ipcErrors = Buffer.concat(stderr).toString('utf8');
  await fs.writeFile(path.join(root, 'package-ipc.json'), JSON.stringify({ startedAt, endedAt: new Date().toISOString(), pid: child.pid, code, closed: true, messages, stderr: ipcErrors }, null, 2), 'utf8');
  assert.equal(code, 0, ipcErrors);
  assert.deepEqual(messages, [{ schemaVersion: 1, requestId: 'package-cleanup', ok: true, result: { cleanedKeys: 1 } }]);
  const verified = openClientDb({ dbPath });
  try { assert.equal(verified.engineKeys.get(key.id)?.apiKey, ''); assert.equal(verified.engineKeys.get(key.id)?.isActive, false); }
  finally { verified.close(); }

  const input = path.join(client, 'src/desktopUninstallWorker.ts'), originalWorker = await fs.readFile(input);
  const success = path.join(root, 'success-evidence');
  await fs.mkdir(success);
  await fs.cp(dist, path.join(success, 'dist'), { recursive: true, errorOnExist: true });
  await fs.copyFile(path.join(snapshot, 'inputs.json'), path.join(success, 'inputs.json'));
  await fs.writeFile(path.join(success, 'desktopUninstallWorker.ts'), originalWorker);
  await fs.writeFile(input, 'export const invalid = ;\n', 'utf8');
  await fs.writeFile(path.join(root, 'failure-input.json'), JSON.stringify({ input, originalSha256: crypto.createHash('sha256').update(originalWorker).digest('hex'), failure: 'worker syntax invalid in same frozen snapshot' }), 'utf8');
  const failed = await command(root, 'failed-worker-build', client, [path.join(client, 'scripts/build-bundle.mjs')]);
  assert.notEqual(failed.code, 0); assert.equal(failed.signal, null);
  assert.match(failed.errors, /desktopUninstallWorker\.ts/u);
  await assert.rejects(fs.access(path.join(dist, 'desktop-startup-capability.json')), { code: 'ENOENT' });
  await fs.writeFile(input, originalWorker);
});
