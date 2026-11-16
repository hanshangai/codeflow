import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { assertTrustedDesktopSender } from '../src/webProtocol.js';
import { snapshotShellHandoffErrorContext } from '../src/shellHandoff.js';
import { createDesktopApplication } from '../src/desktopApplication.js';
import { describeUserFacingError } from '@codeflowai/shared';

/** 执行原 main IPC 注册函数，只替换 Electron 传输和窗口边界。 */
async function fixture(logFailure?: Error, getDiagnostics?: (...args: unknown[]) => Promise<unknown>, dataDir?: string,
  update?: { getUpdateState?: (...args: unknown[]) => Promise<unknown>; getUpdateDetails?: (...args: unknown[]) => Promise<unknown>;
    checkForUpdates?: (...args: unknown[]) => Promise<unknown>; restartForUpdate?: (...args: unknown[]) => Promise<unknown> }, showOpenDialog?: (...args: any[]) => Promise<unknown>) {
  const source = await fs.readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getFullText(ast)).join('\n');
  const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const frame = { url: 'codeflow://desktop/' }, contents = { mainFrame: frame }, logs: Array<{ error: unknown; context: any }> = [];
  const failure = Object.assign(new Error('DESKTOP_OPERATION_IN_PROGRESS'), { code: 'DESKTOP_OPERATION_IN_PROGRESS' });
  const context = vm.createContext({ Error, AggregateError, Object, crypto: { randomUUID: () => 'ipc:request' },
    fs: fsSync, path, describeUserFacingError, snapshotShellHandoffErrorContext, preloggedDesktopErrors: new WeakSet<Error>(),
    ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel) },
    assertTrustedDesktopSender, bindMainFrameEvents: () => () => {},
    dialog: { showOpenDialog },
  });
  vm.runInContext(compiled, context);
  const register = vm.runInContext('registerIpcHandlers', context) as Function;
  const unregister = register({ getState() {}, openWindow() {}, exit() {}, request: async () => { throw failure; }, onEvent() {},
    ...(getDiagnostics ? { getUpdateDiagnostics: getDiagnostics } : {}), ...update },
    { webContents: contents, on() {}, removeListener() {} }, 'codeflow://desktop/', (error: unknown, details: unknown) => {
      logs.push({ error, context: details });
      if (logFailure) throw logFailure;
      if (dataDir) (vm.runInContext('recordDesktopError', context) as Function)(dataDir, error, details);
    });
  return { handlers, event: { sender: contents, senderFrame: frame }, failure, logs, unregister };
}

test('directory picker uses the owning window, restricts selection to a single folder and preserves cancellation', async () => {
  let cancelled = false;
  const f = await fixture(undefined, undefined, undefined, undefined, async (owner, options) => {
    assert.equal(owner.webContents, f.event.sender);
    assert.deepEqual(Array.from(options.properties), ['openDirectory']);
    assert.equal(options.defaultPath, 'C:\\project');
    return { canceled: cancelled, filePaths: cancelled ? [] : ['C:\\chosen'] };
  });
  const pick = f.handlers.get('desktop:selectDirectory');
  assert.equal(typeof pick, 'function');
  assert.equal(await pick!(f.event, 'C:\\project'), 'C:\\chosen');
  cancelled = true;
  assert.equal(await pick!(f.event, 'C:\\project'), null);
  assert.equal(f.logs.length, 0);
  f.unregister();
  assert.equal(f.handlers.has('desktop:selectDirectory'), false);
});

test('cloud registration failure logs device and signed request correlation without account payload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-registration-ipc-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = await fixture(undefined, undefined, directory);
  const deviceId = '868683b1-e79b-4509-9ca1-97b7786e5344', registrationRequestId = '36d2e07e-74ed-4e6e-8699-fc42fc5c3a21';
  Object.assign(f.failure, { code: 'DESKTOP_DEVICE_REVOKED', deviceId, registrationRequestId });
  const result = await f.handlers.get('desktop:request')!(f.event, { method: 'runtime.cloudAccount.link',
    body: { serverOrigin: 'https://PRIVATE_SERVER', sessionToken: 'PRIVATE_TOKEN' } }) as { status: number; body: Record<string, unknown> };
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'DESKTOP_DEVICE_REVOKED');
  assert.match(String(result.body.message), /已撤销/);
  assert.equal(result.body.requestId, 'ipc:request');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|DESKTOP_OPERATION_IN_PROGRESS/);
  const content = await fs.readFile(path.join(directory, 'logs', 'desktop-errors.jsonl'), 'utf8');
  const record = JSON.parse(content.trim());
  assert.equal(record.requestId, 'ipc:request');
  assert.equal(record.registrationRequestId, registrationRequestId);
  assert.equal(record.deviceId, deviceId);
  assert.equal(record.method, 'runtime.cloudAccount.link');
  assert.equal(record.errorCode, 'DESKTOP_DEVICE_REVOKED');
  assert.doesNotMatch(content, /PRIVATE/);
});

test('cloud registration diagnostic correlation ignores getters and malformed IDs', async () => {
  const f = await fixture();
  let reads = 0;
  Object.defineProperty(f.failure, 'registrationRequestId', { get() { reads++; throw new Error('GETTER_EVALUATED'); } });
  Object.assign(f.failure, { deviceId: 'PRIVATE_TOKEN' });
  const result = await f.handlers.get('desktop:request')!(f.event, { method: 'runtime.cloudAccount.link' }) as { body: Record<string, unknown> };
  assert.equal(result.body.ok, false);
  assert.equal(reads, 0);
  assert.equal(f.logs[0]!.context.deviceId, undefined);
  assert.equal(f.logs[0]!.context.registrationRequestId, undefined);
});

test('directory picker rejects invalid input and untrusted senders before opening the system dialog', async () => {
  let calls = 0;
  const f = await fixture(undefined, undefined, undefined, undefined, async () => { calls++; });
  const pick = f.handlers.get('desktop:selectDirectory');
  assert.equal(typeof pick, 'function');
  await assert.rejects(pick!(f.event, { properties: ['openFile'] }), /DESKTOP_DIRECTORY_PATH_INVALID/);
  for (const event of [
    { ...f.event, senderFrame: { url: 'codeflow://desktop/' } },
    { ...f.event, sender: {} },
    { ...f.event, senderFrame: { ...f.event.senderFrame, url: 'https://example.invalid/' } },
  ]) await assert.rejects(pick!(event), /DESKTOP_IPC_FORBIDDEN/);
  assert.equal(calls, 0);
  assert.equal(f.logs.length, 4);
});

test('directory picker records and propagates native dialog failure instead of returning cancellation', async () => {
  const cause = new Error('NATIVE_DIALOG_FAILED');
  const f = await fixture(undefined, undefined, undefined, undefined, async () => { throw cause; });
  const pick = f.handlers.get('desktop:selectDirectory');
  assert.equal(typeof pick, 'function');
  await assert.rejects(pick!(f.event), error => error === cause);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0]!.context.channel, 'desktop:selectDirectory');
  assert.equal(f.logs[0]!.context.requestId, 'ipc:request');
});

for (const method of ['getUpdateState', 'getUpdateDetails', 'checkForUpdates', 'restartForUpdate'] as const) {
  test(`${method} IPC uses a fixed zero-argument capability and unregisters`, async () => {
    const snapshot = { deviceId: 'current', operation: 'idle' };
    const f = await fixture(undefined, undefined, undefined, { [method]: async (...args: unknown[]) => { assert.equal(args.length, 0); return snapshot; } });
    const handler = f.handlers.get('desktop:' + method); assert.equal(typeof handler, 'function');
    assert.deepEqual(await handler!(f.event, { deviceId: 'other', path: 'PRIVATE', force: true }), method === 'checkForUpdates' || method === 'restartForUpdate' ? undefined : snapshot);
    f.unregister(); assert.equal(f.handlers.has('desktop:' + method), false);
    assert.equal((await fixture()).handlers.has('desktop:' + method), false);
  });
  for (const sender of ['subframe', 'foreign-contents', 'external-url'] as const) test(`${method} IPC rejects ${sender} before action`, async () => {
    let calls = 0;
    const f = await fixture(undefined, undefined, undefined, { [method]: async () => { calls++; } });
    const event = { ...f.event };
    if (sender === 'subframe') event.senderFrame = { url: 'codeflow://desktop/' };
    if (sender === 'foreign-contents') event.sender = { mainFrame: f.event.senderFrame };
    if (sender === 'external-url') event.senderFrame.url = 'https://example.invalid/';
    const handler = f.handlers.get('desktop:' + method); assert.equal(typeof handler, 'function');
    await assert.rejects(handler!(event), /DESKTOP_IPC_FORBIDDEN/); assert.equal(calls, 0); assert.equal(f.logs.length, 1);
  });
  for (const cause of [false, null, undefined, 0, '']) test(`${method} IPC keeps falsy failure ${String(cause)}`, async () => {
    const f = await fixture(undefined, undefined, undefined, { [method]: async () => { throw cause; } });
    const handler = f.handlers.get('desktop:' + method); assert.equal(typeof handler, 'function');
    await assert.rejects(handler!(f.event), error => error === cause); assert.equal(f.logs.length, 1);
  });
  test(`${method} IPC logs device and request correlation and preserves two causes on log failure`, async () => {
    const cause = Object.assign(new Error('ORIGINAL'), { code: 'ORIGINAL', deviceId: '868683b1-e79b-4509-9ca1-97b7786e5344', updateRequestId: 'update:original' });
    const logging = new Error('LOG_FAILED'), f = await fixture(logging, undefined, undefined, { [method]: async () => { throw cause; } });
    const handler = f.handlers.get('desktop:' + method); assert.equal(typeof handler, 'function');
    await assert.rejects(handler!(f.event), error => { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cause, logging]); return true; });
    assert.equal(f.logs[0]!.context.deviceId, cause.deviceId); assert.equal(f.logs[0]!.context.requestId, 'ipc:request');
    assert.equal(f.logs[0]!.context.channel, 'desktop:' + method);
    assert.equal(f.logs[0]!.context.updateRequestId, 'update:original');
  });
}

test('diagnostics identity failure reaches the real safe file logger with a searchable root code', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-ipc-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = createDesktopApplication({ dataDir: directory, initialReleaseDir: directory, host: {
    createWindow() { throw new Error('must not start'); }, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: () => () => {}, quit() {},
  } });
  const f = await fixture(undefined, app.getUpdateDiagnostics, directory);
  await assert.rejects(f.handlers.get('desktop:getUpdateDiagnostics')!(f.event), /DESKTOP_UPDATE_DIAGNOSTICS_FAILED/);
  const lines = (await fs.readFile(path.join(directory, 'logs', 'desktop-errors.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.requestId, 'ipc:request');
  assert.deepEqual(record.causeCodes, ['DESKTOP_UPDATE_DIAGNOSTICS_FAILED', 'DESKTOP_DEVICE_IDENTITY_NOT_READY']);
});

test('update state identity failure reaches the real file logger and stays rejected', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'update-state-ipc-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = createDesktopApplication({ dataDir: directory, initialReleaseDir: directory, host: {
    createWindow() { throw new Error('must not start'); }, loadWeb: async () => {}, createTray: () => ({ destroy() {} }),
    registerBridge: () => () => {}, quit() {},
  } });
  const f = await fixture(undefined, undefined, directory, { getUpdateState: app.getUpdateState });
  await assert.rejects(f.handlers.get('desktop:getUpdateState')!(f.event), /DESKTOP_UPDATE_STATE_FAILED/);
  const lines = (await fs.readFile(path.join(directory, 'logs', 'desktop-errors.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.errorCode, 'DESKTOP_UPDATE_STATE_FAILED');
  assert.equal(record.requestId, 'ipc:request'); assert.equal(record.channel, 'desktop:getUpdateState');
  assert.deepEqual(record.causeCodes, ['DESKTOP_UPDATE_STATE_FAILED', 'DESKTOP_DEVICE_IDENTITY_NOT_READY']);
});

test('update check rejection persists separate IPC and update request IDs without private cause text', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'update-check-ipc-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cause = Object.assign(new Error('PRIVATE_PATH?token=PRIVATE_TOKEN'), { code: 'DESKTOP_UPDATE_HTTP_FAILED' });
  const failure = Object.assign(new Error('DESKTOP_UPDATE_CHECK_FAILED', { cause }), {
    code: 'DESKTOP_UPDATE_CHECK_FAILED', deviceId: '868683b1-e79b-4509-9ca1-97b7786e5344', updateRequestId: 'update:original',
  });
  const f = await fixture(undefined, undefined, directory, { checkForUpdates: async () => { throw failure; } });
  await assert.rejects(f.handlers.get('desktop:checkForUpdates')!(f.event), error => error === failure);
  const content = await fs.readFile(path.join(directory, 'logs', 'desktop-errors.jsonl'), 'utf8');
  const lines = content.trim().split('\n'); assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.errorCode, 'DESKTOP_UPDATE_CHECK_FAILED'); assert.equal(record.deviceId, failure.deviceId);
  assert.equal(record.requestId, 'ipc:request'); assert.equal(record.updateRequestId, 'update:original');
  assert.equal(record.channel, 'desktop:checkForUpdates');
  assert.deepEqual(record.causeCodes, ['DESKTOP_UPDATE_CHECK_FAILED', 'DESKTOP_UPDATE_HTTP_FAILED']);
  assert.doesNotMatch(content, /PRIVATE/);
});

test('diagnostics IPC ignores renderer parameters and removes its handler on unregister', async () => {
  const snapshot = { deviceId: '868683b1-e79b-4509-9ca1-97b7786e5344', failures: [] };
  const f = await fixture(undefined, async (...args) => { assert.equal(args.length, 0); return snapshot; });
  const get = f.handlers.get('desktop:getUpdateDiagnostics');
  assert.equal(typeof get, 'function', 'main must register fixed diagnostics');
  assert.deepEqual(await get!(f.event, { deviceId: 'other-device', path: 'PRIVATE_PATH', token: 'PRIVATE_TOKEN' }), snapshot);
  assert.equal(f.logs.length, 0);
  f.unregister(); assert.equal(f.handlers.has('desktop:getUpdateDiagnostics'), false);
});

test('old shells do not register a diagnostics channel that pretends to support empty results', async () => {
  assert.equal((await fixture()).handlers.has('desktop:getUpdateDiagnostics'), false);
});

for (const sender of ['subframe', 'foreign-contents', 'external-url'] as const) {
  test(`diagnostics IPC refuses ${sender} using the real sender gate before reading`, async () => {
    let reads = 0;
    const f = await fixture(undefined, async () => { reads++; return { deviceId: 'current', failures: [] }; });
    const get = f.handlers.get('desktop:getUpdateDiagnostics');
    assert.equal(typeof get, 'function', 'main must protect fixed diagnostics');
    const event = { ...f.event };
    if (sender === 'subframe') event.senderFrame = { url: 'codeflow://desktop/' };
    if (sender === 'foreign-contents') event.sender = { mainFrame: f.event.senderFrame };
    if (sender === 'external-url') event.senderFrame.url = 'https://example.invalid/';
    await assert.rejects(get!(event), /DESKTOP_IPC_FORBIDDEN/);
    assert.equal(reads, 0); assert.equal(f.logs.length, 1);
  });
}

for (const loggingFailure of [false, true]) {
  test(`diagnostics IPC preserves read failure, identity and request context with logging failure=${loggingFailure}`, async () => {
    const original = new Error('EACCES'), cause = Object.assign(new Error('DESKTOP_UPDATE_DIAGNOSTICS_FAILED', { cause: original }), {
      code: 'DESKTOP_UPDATE_DIAGNOSTICS_FAILED', deviceId: '868683b1-e79b-4509-9ca1-97b7786e5344',
    });
    const logging = new Error('LOG_WRITE_FAILED');
    const f = await fixture(loggingFailure ? logging : undefined, async () => { throw cause; });
    const get = f.handlers.get('desktop:getUpdateDiagnostics');
    assert.equal(typeof get, 'function', 'main must propagate diagnostics failures');
    await assert.rejects(get!(f.event), error => {
      if (loggingFailure) {
        assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cause, logging]);
      } else assert.equal(error, cause);
      return true;
    });
    assert.equal(f.logs.length, 1); assert.ok(f.logs[0]!.error instanceof Error);
    assert.equal(f.logs[0]!.error.cause, original);
    assert.equal(f.logs[0]!.context.requestId, 'ipc:request'); assert.equal(f.logs[0]!.context.deviceId, cause.deviceId);
    assert.equal(f.logs[0]!.context.errorCode, 'DESKTOP_UPDATE_DIAGNOSTICS_FAILED');
  });
}

test('IPC rejection retains caller failure and safe request method/channel without request payload', async () => {
  const f = await fixture();
  await assert.rejects(f.handlers.get('desktop:request')!(f.event, { method: 'workspaces.list', body: { token: 'private-secret' } }), cause => cause === f.failure);
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0]!.error, f.failure);
  assert.equal(f.logs[0]!.context?.requestId, 'ipc:request'); assert.equal(f.logs[0]!.context?.method, 'workspaces.list');
  assert.equal(f.logs[0]!.context?.channel, 'desktop:request'); assert.equal(f.logs[0]!.context?.errorCode, 'DESKTOP_OPERATION_IN_PROGRESS');
  assert.doesNotMatch(JSON.stringify(f.logs), /private-secret/);
});

test('IPC diagnostic never invokes an untrusted method getter', async () => {
  const f = await fixture(); let reads = 0;
  const payload = Object.defineProperty({}, 'method', { get() { reads++; throw new Error('PRIVATE_GETTER'); } });
  await assert.rejects(f.handlers.get('desktop:request')!(f.event, payload), cause => cause === f.failure);
  assert.equal(reads, 0); assert.equal(f.logs[0]!.context?.method, undefined);
});

test('IPC diagnostic failure retains the original rejection and logging failure', async () => {
  const logging = new Error('LOG_WRITE_FAILED'), f = await fixture(logging);
  await assert.rejects(f.handlers.get('desktop:request')!(f.event, { method: 'workspaces.list' }), cause => {
    assert.ok(cause instanceof AggregateError);
    assert.equal(cause.message, 'DESKTOP_IPC_DIAGNOSTIC_FAILED');
    assert.equal(cause.cause, f.failure);
    assert.deepEqual(cause.errors, [f.failure, logging]);
    return true;
  });
  assert.equal(f.logs.length, 1);
});
