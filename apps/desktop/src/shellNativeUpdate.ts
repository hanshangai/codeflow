import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareNumericVersion, type DesktopShellUpdatePhase, type DesktopUpdateResult, type ShellReleaseManifest } from '@codeflowai/shared';
import { verifyShellReleaseSignature } from '@codeflowai/shared/desktop-shell-release-signing';
import { createDesktopUpdateTransport } from './updateTransport.js';
import { downloadShellInstaller } from './shellInstallerDownload.js';
import { installShellCandidate } from './shellInstallerProcess.js';
import { readShellLaunchState, serializeShellLaunchState } from './shellLaunchState.js';
import { startAfterExitShellSwitch, testShellProcess } from './shellSwitchProcess.js';
import { processSnapshot, sameIdentity, type ProcessIdentity } from './windowsProcessIdentity.js';
import type { ShellUpdateHelperOwner, ShellUpdateOperationInput, ShellUpdateOperationResult } from './shellUpdateOperation.js';

export type NativeShellUpdateBoundary = {
  transport?: Pick<ReturnType<typeof createDesktopUpdateTransport>, 'register' | 'request' | 'requestJson'>;
  install?: typeof installShellCandidate;
  test?: typeof testShellProcess;
  switch?: typeof startAfterExitShellSwitch;
  snapshot?: typeof processSnapshot;
};

/** 壳准备复用安装边界的已验结果；退出后切换独立于业务资源、数据库及历史交接尝试。 */
export async function runNativeShellUpdate(input: ShellUpdateOperationInput, boundary: NativeShellUpdateBoundary = {}): Promise<ShellUpdateOperationResult> {
  const facts = structuredClone(input.facts), requestId = input.requestId;
  let phase: DesktopShellUpdatePhase = 'prepare', manifest: ShellReleaseManifest | undefined;
  let resumeNeeded = false, drainStarted = false, recovery = 'not_needed';
  let executor: Awaited<ReturnType<typeof startAfterExitShellSwitch>> | undefined;
  let owner: ShellUpdateHelperOwner | undefined, released = false;
  /** 每次等待结束先接受取消，不再继续下一个网络或文件副作用。 */
  const checked = async <T>(action: Promise<T>): Promise<T> => { const value = await action; input.signal.throwIfAborted(); return value; };
  /** 观察不授予推进权；错误阶段与当前可信壳目标沿同一上下文输出。 */
  const observe = (next: DesktopShellUpdatePhase, result?: DesktopUpdateResult): void => {
    phase = next;
    input.onProgress?.({ requestId, phase, ...(result ? { result } : {}), ...(manifest ? { target: { shellId: manifest.shellId, version: manifest.version } } : {}) });
  };
  /** 只包装固定错误上下文，根因保留在 cause，不拼接路径或响应正文。 */
  const contextual = (cause: unknown): Error => Object.assign(new Error('DESKTOP_SHELL_OPERATION_FAILED', { cause }), {
    code: 'DESKTOP_SHELL_OPERATION_FAILED', requestId, deviceId: input.identity.deviceId, shellId: manifest?.shellId ?? null,
    failurePhase: phase, recovery, ...(executor && owner ? { helperOwner: owner } : {}),
  });
  /** 执行器尚等旧 main 时先取消，再撤销本次暂停或恢复本次停止的 Client。 */
  const restore = async (allowResume = true): Promise<void> => {
    if (executor) { await executor.cancel(); executor = undefined; }
    if (resumeNeeded && allowResume) { await input.hooks.resume(); resumeNeeded = false; recovery = drainStarted ? 'restored' : 'not_needed'; }
  };
  owner = {
    /** 旧 main 明确退出前必须仍持有活执行器。 */
    check() { if (!executor) fail('OWNER_RELEASED'); executor.check(); },
    /** 应用唯一退出边界放弃句柄，执行器接管原生文件事务。 */
    release() { if (!executor) fail('OWNER_RELEASED'); executor.release(); released = true; },
    /** 只有尚未交出的执行器允许取消；已销毁业务界面不得重新启动 Client。 */
    async recover(cause, allowResume = true) {
      if (released) return contextual(new AggregateError([cause, new Error('DESKTOP_SHELL_SWITCH_ALREADY_RELEASED')], 'DESKTOP_SHELL_SWITCH_RECOVERY_FAILED'));
      if (!allowResume && resumeNeeded) recovery = 'failed';
      try { await restore(allowResume); }
      catch (cleanup) { recovery = 'failed'; return contextual(new AggregateError([cause, cleanup], 'DESKTOP_SHELL_SWITCH_RECOVERY_FAILED')); }
      return contextual(cause);
    },
  };
  try {
    input.signal.throwIfAborted();
    if (process.platform !== 'win32' || process.arch !== 'x64') fail('PLATFORM_UNSUPPORTED');
    const version = numericVersion(input.shellVersion);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) fail('REQUEST_INVALID');
    if (!Number.isSafeInteger(facts.main.pid) || facts.main.pid < 1 || !Number.isSafeInteger(facts.main.created) || facts.main.created < 1) fail('MAIN_IDENTITY_CHANGED');
    for (const directory of [input.dataDir, facts.installationDir, facts.userDataDir, facts.sessionDataDir]) await checked(assertDirectory(directory, input.signal));
    const launch = await checked(readShellLaunchState(facts.installationDir));
    if (launch.executablePath !== facts.main.executable) fail('MAIN_IDENTITY_CHANGED');
    const transport = boundary.transport ?? createDesktopUpdateTransport({ dataDir: input.dataDir, identity: input.identity,
      configuredServerOrigin: input.configuredServerOrigin, timeoutMs: input.timeoutMs });
    observe('prepare');
    let response: unknown;
    if (input.discovery) response = await checked(input.discovery(requestId));
    else {
      await checked(transport.register({ requestId, signal: input.signal }));
      response = await checked(transport.requestJson({ method: 'GET', path: '/api/software/desktop/shell-release-availability', requestId, signal: input.signal }));
    }
    const discovery = dataObject(response);
    exactFields(discovery, ['ok', 'available', 'deviceId', 'requestId', ...(discovery.available === true ? ['manifest'] : [])]);
    if (discovery.ok !== true || typeof discovery.available !== 'boolean' || discovery.deviceId !== input.identity.deviceId || discovery.requestId !== requestId) fail('RESPONSE_INVALID');
    if (!discovery.available) { observe('prepare', 'none'); return { status: 'no-update', requestId }; }
    manifest = verifyShellReleaseSignature(discovery.manifest, input.trustedKeys);
    assertCurrentManifest(manifest);
    if (compareNumericVersion(numericVersion(manifest.version), version) <= 0) { observe('prepare', 'same'); return { status: 'no-update', requestId }; }
    if (manifest.shellId === launch.state.activeShellId) fail('VERSION_ID_CONFLICT');
    let directory = input.dataDir;
    for (const segment of ['.staging', 'shell-update-artifacts']) {
      await checked(assertDirectory(directory, input.signal));
      directory = path.join(directory, segment);
      try { await checked(fs.mkdir(directory)); }
      catch (cause) { if (!isExists(cause)) throw cause; input.signal.throwIfAborted(); }
      await checked(assertDirectory(directory, input.signal));
    }
    observe('download');
    const downloaded = await checked(downloadShellInstaller({ directory, manifest, trustedKeys: input.trustedKeys, requestId, signal: input.signal, transport }));
    observe('install');
    const installed = await checked((boundary.install ?? installShellCandidate)({ manifest, trustedKeys: input.trustedKeys,
      installerPath: downloaded.installerPath, installationDir: facts.installationDir, expectedState: launch.state,
      requestId, signal: input.signal, timeoutMs: input.timeoutMs, temporaryParentDir: facts.temporaryParentDir }));
    const candidateDirectory = path.join(facts.installationDir, 'shells', manifest.shellId);
    if (installed.candidateDirectory !== candidateDirectory || JSON.stringify(installed.manifest) !== JSON.stringify(manifest)) fail('TARGET_CHANGED');
    observe('health');
    await checked((boundary.test ?? testShellProcess)({ executablePath: path.join(candidateDirectory, 'CodeFlowAI.exe'),
      temporaryParentDir: facts.temporaryParentDir, signal: input.signal, timeoutMs: input.timeoutMs }));
    observe('handoff', 'prepared');
    assertCurrentManifest(manifest);
    const accepted = await input.hooks.prepare();
    if (accepted === true) resumeNeeded = true;
    input.signal.throwIfAborted();
    if (typeof accepted !== 'boolean') fail('PREPARATION_INVALID');
    if (!accepted) { observe('handoff', 'postponed'); return { status: 'postponed', requestId }; }
    const snapshot = boundary.snapshot ?? processSnapshot;
    const before = await checked(snapshot({ known: [facts.main], timeoutMs: Math.min(input.timeoutMs ?? 10_000, 10_000) }));
    assertMain(before, facts.main);
    // 只读取 PID 绑定真实实例；failed/starting 或损坏业务数据库不影响壳准备。
    const clientPid = input.getClient().pid;
    const client = clientPid === null ? undefined : before.find(item => item.pid === clientPid);
    if (client && (client.parentPid !== facts.main.pid || client.created <= 0 || !path.isAbsolute(client.executable))) fail('CLIENT_IDENTITY_CHANGED');
    const authorization = dataObject(await checked(transport.requestJson({ method: 'GET', path: `/api/software/desktop/shell-releases/${manifest.shellId}/switch-authorization`, requestId, signal: input.signal })));
    exactFields(authorization, ['ok', 'authorized', 'deviceId', 'requestId', 'shellId', ...(authorization.authorized === true ? ['installerSha256', 'manifestSha256'] : [])]);
    if (authorization.ok !== true || authorization.authorized !== true || authorization.deviceId !== input.identity.deviceId || authorization.requestId !== requestId
      || authorization.shellId !== manifest.shellId || authorization.installerSha256 !== manifest.installerSha256
      || authorization.manifestSha256 !== crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')) fail('AUTHORIZATION_REJECTED');
    assertCurrentManifest(manifest);
    const confirmed = await checked(readShellLaunchState(facts.installationDir));
    if (serializeShellLaunchState(confirmed.state) !== serializeShellLaunchState(launch.state)) fail('LAUNCH_STATE_CHANGED');
    drainStarted = true;
    await checked(input.hooks.drain());
    const remaining = await checked(snapshot({ known: [facts.main, ...(client ? [client] : [])], timeoutMs: Math.min(input.timeoutMs ?? 10_000, 10_000) }));
    assertMain(remaining, facts.main);
    if (client && remaining.some(item => item.pid === client.pid)) fail('CLIENT_STILL_RUNNING');
    const current = await checked(readShellLaunchState(facts.installationDir));
    if (serializeShellLaunchState(current.state) !== serializeShellLaunchState(launch.state)) fail('LAUNCH_STATE_CHANGED');
    assertCurrentManifest(manifest);
    executor = await (boundary.switch ?? startAfterExitShellSwitch)({ executablePath: facts.main.executable, installationDir: facts.installationDir,
      previous: launch.state.activeShellId, target: manifest.shellId, pid: facts.main.pid, requestId,
      userDataDir: facts.userDataDir, sessionDataDir: facts.sessionDataDir });
    input.signal.throwIfAborted();
    executor.check();
    input.hooks.committed();
    input.signal.throwIfAborted();
    return { status: 'handoff', requestId, owner };
  } catch (cause) {
    const failures = [cause];
    try { input.onFailure?.(contextual(cause)); } catch (report) { failures.push(report); }
    try { await restore(); } catch (cleanup) { recovery = 'failed'; failures.push(cleanup); }
    try { input.onProgress?.({ requestId, phase, result: 'failure' }); } catch (observation) { failures.push(observation); }
    throw contextual(failures.length === 1 ? cause : new AggregateError(failures, 'DESKTOP_SHELL_NATIVE_RECOVERY_FAILED'));
  }
}

/** 原目录必须是同一绝对普通目录，禁止路径别名或链接进入工件缓存。 */
async function assertDirectory(directory: string, signal: AbortSignal): Promise<void> {
  if (!path.isAbsolute(directory)) fail('PATH_INVALID');
  const stat = await fs.lstat(directory);
  signal.throwIfAborted();
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PATH_INVALID');
  const actual = await fs.realpath(directory); signal.throwIfAborted();
  if (actual !== directory) fail('PATH_INVALID');
}

/** 两段旧版本补零后使用现有数字比较，未知值或不安全数字明确失败。 */
function numericVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/u.test(value) || value.split('.').some(part => !Number.isSafeInteger(Number(part)))) fail('VERSION_INVALID');
  return value.split('.').length === 2 ? `${value}.0` : value;
}

/** 可信清单仍须符合当前时间和本机 Windows 平台，过期不能授予切换资格。 */
function assertCurrentManifest(manifest: ShellReleaseManifest): void {
  const now = Date.now();
  if (manifest.platform !== process.platform || manifest.arch !== process.arch || Date.parse(manifest.createdAt) > now || now >= Date.parse(manifest.expiresAt)) fail('MANIFEST_INVALID');
}

/** 响应只消费普通数据属性，不触发访问器或继承的授权字段。 */
function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('RESPONSE_INVALID');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) fail('RESPONSE_INVALID');
    result[key] = descriptor.value;
  }
  return result;
}

/** 授权和发现均拒绝额外或缺失字段，不能把部分响应当作成功。 */
function exactFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail('RESPONSE_INVALID');
}

/** 快照只核真实旧 main 实例，不从进程名或业务 ready 推导归属。 */
function assertMain(processes: ProcessIdentity[], main: ProcessIdentity): void {
  if (!processes.some(item => sameIdentity(item, main))) fail('MAIN_IDENTITY_CHANGED');
}

/** 缓存目录的已存在结果必须随后经过普通目录复核。 */
function isExists(cause: unknown): boolean { return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST'; }

/** 领域短码作为根因保留，由入口统一追加设备及请求上下文。 */
function fail(reason: string): never { throw Object.assign(new Error(`DESKTOP_SHELL_NATIVE_${reason}`), { code: `DESKTOP_SHELL_NATIVE_${reason}` }); }
