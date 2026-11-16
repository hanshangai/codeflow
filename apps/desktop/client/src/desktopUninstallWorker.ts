import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { clearDesktopConfigApiKey, readDesktopConfigForMaintenance } from './config.js';
import { openClientDb } from './db/clientDb.js';
import { EngineKeyRepo, type PersistedEngineKey } from './db/repos/engineKeyRepo.js';
import { openSqliteDb, type SqliteDb } from './db/sqliteDb.js';
import { assertExistingDesktopClientDbStorage } from './security/clientDbSecurity.js';
import { createCredentialStore, type CredentialStore } from './security/credentialStore.js';
import { clearLegacyMigrationCredentials, rebindLegacyMigrationForReinstall } from './legacy-migration/legacyClientMigration.js';

export type DesktopUninstallRequest = {
  schemaVersion: 1;
  action?: 'migration_credentials';
  requestId: string;
  dataDir: string;
  clientId: string;
  deviceId: string;
};
type CleanupDependencies = { credentialStore?: CredentialStore; openDb?: typeof openSqliteDb; onStage?: (stage: string) => void };
export type DesktopReinstallRequest = {
  schemaVersion: 1;
  action: 'reinstall_local_tasks';
  requestId: string;
  dataDir: string;
  clientId: string;
  oldDeviceId: string;
  nextDeviceId: string;
};
type ReinstallDependencies = { openDb?: typeof openSqliteDb; openClientDb?: typeof openClientDb; onStage?: (stage: string) => void };

/** 任务接续必须由显式 action 选择；坏新协议不降级为凭据清理。 */
export function parseDesktopReinstallRequest(value: unknown): DesktopReinstallRequest {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('DESKTOP_REINSTALL_REQUEST_INVALID');
  const raw = value as Record<string, unknown>, fields = ['schemaVersion', 'action', 'requestId', 'dataDir', 'clientId', 'oldDeviceId', 'nextDeviceId'];
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)
    || !('value' in Object.getOwnPropertyDescriptor(raw, key)!))
    || raw.schemaVersion !== 1 || raw.action !== 'reinstall_local_tasks') throw new Error('DESKTOP_REINSTALL_REQUEST_INVALID');
  for (const field of fields.slice(2)) {
    if (typeof raw[field] !== 'string' || !raw[field] || raw[field].trim() !== raw[field]
      || raw[field].length > 4096 || /[\x00-\x1f]/u.test(raw[field])) throw new Error('DESKTOP_REINSTALL_REQUEST_INVALID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(raw.requestId as string)) throw new Error('DESKTOP_REINSTALL_REQUEST_INVALID');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(raw.oldDeviceId as string) || !uuid.test(raw.nextDeviceId as string)
    || (raw.oldDeviceId as string).toLowerCase() === (raw.nextDeviceId as string).toLowerCase()) throw new Error('DESKTOP_REINSTALL_REQUEST_INVALID');
  if (!path.isAbsolute(raw.dataDir as string)) throw new Error('DESKTOP_REINSTALL_PATH_INVALID');
  return raw as DesktopReinstallRequest;
}

/** 父 main 已授权旧/新身份；先接续已完成迁移，再重绑本机任务，资源关闭后才返回成功。 */
export function runDesktopReinstallLocalTasks(value: unknown, dependencies: ReinstallDependencies = {}): { rebound: number; unchanged: number } {
  dependencies.onStage?.('preflight');
  const input = parseDesktopReinstallRequest(value), dataDir = path.resolve(input.dataDir);
  const dbPath = path.join(dataDir, 'codeflowai.db'), configPath = path.join(dataDir, 'config.json');
  assertPrivatePath(dataDir, true);
  for (const file of [dbPath, `${dbPath}.meta.json`, configPath]) assertPrivatePath(file);
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(`${dbPath}${suffix}`)) assertPrivatePath(`${dbPath}${suffix}`);
  readDesktopConfigForMaintenance(configPath, input.clientId);
  assertExistingDesktopClientDbStorage(dbPath);
  dependencies.onStage?.('identity_verify');
  const verification = (dependencies.openDb ?? openSqliteDb)(dbPath, { readonly: true, fileMustExist: true, busyTimeoutMs: 0 });
  withConnection(verification, () => {
    const owner = verification.prepare("SELECT value FROM meta WHERE key = 'client_id'").get() as { value?: unknown } | undefined;
    if (owner?.value !== input.clientId) throw new Error('DESKTOP_REINSTALL_CLIENT_ID_MISMATCH');
  });
  dependencies.onStage?.('migration_rebind');
  rebindLegacyMigrationForReinstall(input);
  dependencies.onStage?.('database_open');
  const db = (dependencies.openClientDb ?? openClientDb)({ dbPath, existingOnly: true });
  return withConnection(db, () => {
    dependencies.onStage?.('rebind_local_tasks');
    const result = db.rebindLocalScheduledTasksForDesktopReinstall({ clientId: input.clientId,
      oldDeviceId: input.oldDeviceId, nextDeviceId: input.nextDeviceId });
    if (!result || typeof result !== 'object' || types.isProxy(result) || Reflect.ownKeys(result).length !== 2
      || Reflect.ownKeys(result).some(key => key !== 'rebound' && key !== 'unchanged')
      || !Number.isSafeInteger(result.rebound) || result.rebound < 0 || !Number.isSafeInteger(result.unchanged) || result.unchanged < 0) {
      throw new Error('DESKTOP_REINSTALL_RESULT_INVALID');
    }
    dependencies.onStage?.('database_close');
    return result;
  });
}

/** 只接受完整卸载或显式归档补清的固定字段；未知action不能降级为完整清理。 */
export function parseDesktopUninstallRequest(value: unknown): DesktopUninstallRequest {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('DESKTOP_UNINSTALL_REQUEST_INVALID');
  const raw = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'requestId', 'dataDir', 'clientId', 'deviceId',
    ...(Object.getOwnPropertyDescriptor(raw, 'action')?.value === 'migration_credentials' ? ['action'] : [])];
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)
    || !('value' in Object.getOwnPropertyDescriptor(raw, key)!)) || raw.schemaVersion !== 1) {
    throw new Error('DESKTOP_UNINSTALL_REQUEST_INVALID');
  }
  for (const field of fields.slice(1)) {
    if (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 4096) throw new Error('DESKTOP_UNINSTALL_REQUEST_INVALID');
  }
  if (!path.isAbsolute(raw.dataDir as string)) throw new Error('DESKTOP_UNINSTALL_PATH_INVALID');
  return raw as DesktopUninstallRequest;
}

/** 只允许既有普通私有文件，不沿链接、硬链接或其他物理路径清理。 */
function assertPrivatePath(file: string, directory = false): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) throw new Error('DESKTOP_UNINSTALL_PATH_INVALID');
}

/** 精确沿原签发 ref 合同证明归属，不枚举凭据存储或认领原生登录。 */
function assertOwnedSecretReference(key: PersistedEngineKey): void {
  if (key.secretRef === null) return;
  if (key.source !== 'builtin' || !key.serverOrigin?.trim() || !key.ownerUserId?.trim() || !key.keyId?.trim()) {
    throw new Error('DESKTOP_UNINSTALL_SECRET_OWNER_INVALID');
  }
  const ownerHash = crypto.createHash('sha256').update(`${key.serverOrigin}:${key.ownerUserId}`).digest('hex');
  const prefix = `builtin-relay:${ownerHash}:${key.keyId}:`;
  if (!key.secretRef.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(key.secretRef.slice(prefix.length))) {
    throw new Error('DESKTOP_UNINSTALL_SECRET_OWNER_INVALID');
  }
}

/** 操作失败仍关闭本连接；双错保留两原因，不以关闭覆盖业务错误。 */
function withConnection<T>(db: Pick<SqliteDb, 'close'>, operation: () => T): T {
  let failure: unknown, failed = false;
  try { return operation(); }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { db.close(); }
    catch (error) { throw failed ? new AggregateError([failure, error], 'DESKTOP_UNINSTALL_CLOSE_FAILED', { cause: failure }) : error; }
  }
}

/** 核稳定身份和原必需列；不开普通 Client，不建库或迁移。 */
function readManagedKeys(db: SqliteDb, clientId: string): PersistedEngineKey[] {
  const owner = db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get() as { value?: unknown } | undefined;
  if (owner?.value !== clientId) throw new Error('DESKTOP_UNINSTALL_CLIENT_ID_MISMATCH');
  return new EngineKeyRepo(db).list();
}

/** 先清迁移归档；显式补清到此结束，完整卸载再沿原repo/store清当前凭据。 */
export function runDesktopUninstallCleanup(value: unknown, dependencies: CleanupDependencies = {}): { cleanedKeys: number } {
  dependencies.onStage?.('preflight');
  const input = parseDesktopUninstallRequest(value), dataDir = path.resolve(input.dataDir);
  const dbPath = path.join(dataDir, 'codeflowai.db'), configPath = path.join(dataDir, 'config.json');
  assertPrivatePath(dataDir, true);
  for (const file of [dbPath, `${dbPath}.meta.json`, configPath]) assertPrivatePath(file);
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(`${dbPath}${suffix}`)) assertPrivatePath(`${dbPath}${suffix}`);
  readDesktopConfigForMaintenance(configPath, input.clientId);
  assertExistingDesktopClientDbStorage(dbPath);
  dependencies.onStage?.('migration_credentials');
  clearLegacyMigrationCredentials({ dataDir, targetClientId: input.clientId, targetDeviceId: input.deviceId });
  if (input.action === 'migration_credentials') return { cleanedKeys: 0 };
  const open = dependencies.openDb ?? openSqliteDb;
  dependencies.onStage?.('database_open');
  const db = open(dbPath, { fileMustExist: true, busyTimeoutMs: 0 });
  const cleanedKeys = withConnection(db, () => {
    const keys = readManagedKeys(db, input.clientId);
    for (const key of keys) assertOwnedSecretReference(key);
    if (db.pragma('secure_delete = ON', { simple: true }) !== 1) throw new Error('DESKTOP_UNINSTALL_SECURE_DELETE_FAILED');
    const repo = new EngineKeyRepo(db);
    dependencies.onStage?.('block_managed_scopes');
    repo.beginDesktopUninstallCredentialCleanup();
    const refs = [...new Set(keys.flatMap(key => key.secretRef === null ? [] : [key.secretRef]))];
    const store = refs.length ? dependencies.credentialStore ?? createCredentialStore({ requireOs: true }) : undefined;
    dependencies.onStage?.('credential_store');
    for (const ref of refs) {
      // 原 missing 合同允许同一 ref 重试，其他 store 异常必须中止。
      if (store!.get(ref) !== null) store!.delete(ref);
      if (store!.get(ref) !== null) throw new Error('DESKTOP_UNINSTALL_SECRET_DELETE_FAILED');
    }
    dependencies.onStage?.('database_secrets');
    repo.finishDesktopUninstallCredentialCleanup(refs);
    dependencies.onStage?.('config');
    clearDesktopConfigApiKey({ configPath, clientId: input.clientId });
    dependencies.onStage?.('checkpoint');
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy?: unknown; log?: unknown; checkpointed?: unknown }[];
    if (checkpoint.length !== 1 || checkpoint[0]?.busy !== 0 || checkpoint[0].log !== checkpoint[0].checkpointed) {
      throw new Error('DESKTOP_UNINSTALL_CHECKPOINT_BUSY');
    }
    dependencies.onStage?.('database_close');
    return keys.length;
  });
  dependencies.onStage?.('readonly_reopen');
  const verification = open(dbPath, { readonly: true, fileMustExist: true, busyTimeoutMs: 0 });
  withConnection(verification, () => {
    if (verification.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('DESKTOP_UNINSTALL_VERIFY_FAILED');
    const keys = readManagedKeys(verification, input.clientId), repo = new EngineKeyRepo(verification);
    for (const key of keys) {
      if (key.apiKey !== '' || key.secretRef !== null || key.isActive || !repo.isNativeFallbackBlocked(key.engine as 'codex' | 'claude', key.providerId)) {
        throw new Error('DESKTOP_UNINSTALL_VERIFY_FAILED');
      }
    }
    if (readDesktopConfigForMaintenance(configPath, input.clientId).apiKey !== '') throw new Error('DESKTOP_UNINSTALL_VERIFY_FAILED');
    dependencies.onStage?.('verification_close');
  });
  return { cleanedKeys };
}

/** 跨 IPC 只传安全错误形状；原主副错在当前异常链保留，不回显存储正文或凭据。 */
function safeFailure(error: unknown, depth = 0): Record<string, unknown> {
  const native = types.isNativeError(error);
  /** 仅原生 Error 自有数据字段可读，未知对象、代理和 getter 不参与日志求值。 */
  function own(field: string): PropertyDescriptor | undefined {
    if (!native) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, field);
    return descriptor && 'value' in descriptor ? descriptor : undefined;
  }
  const message = native ? own('message')?.value : typeof error === 'string' ? error : undefined;
  const rawCode = own('code')?.value, rawName = own('name')?.value;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/u.test(rawCode) ? rawCode
    : typeof message === 'string' && /^DESKTOP_(?:UNINSTALL|REINSTALL)_[A-Z_]+$/u.test(message) ? message : 'DESKTOP_UNINSTALL_CLEANUP_FAILED';
  const detail: Record<string, unknown> = { name: typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(rawName) ? rawName : 'Error',
    code, thrownType: error === null ? 'null' : typeof error, messageType: message === null ? 'null' : typeof message };
  if (typeof message === 'string') detail.messageSha256 = crypto.createHash('sha256').update(message).digest('hex');
  for (const field of ['errno', 'errcode']) {
    const value = own(field)?.value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) detail[field] = value;
  }
  const syscall = own('syscall')?.value;
  if (typeof syscall === 'string' && /^[A-Za-z0-9_]{1,48}$/u.test(syscall)) detail.syscall = syscall;
  if (depth < 3) {
    const errors = own('errors')?.value, cause = own('cause');
    if (!types.isProxy(errors) && Array.isArray(errors)) {
      const causes: Record<string, unknown>[] = [];
      for (let index = 0; index < Math.min(errors.length, 8); index += 1) {
        const item = Object.getOwnPropertyDescriptor(errors, index);
        causes.push(item && 'value' in item ? safeFailure(item.value, depth + 1) : { thrownType: 'unreadable' });
      }
      detail.causes = causes;
    } else if (cause) detail.causes = [safeFailure(cause.value, depth + 1)];
  }
  return detail;
}

/** 包内子进程只收一次 IPC，失败一条结构日志并非零退出，成功须连接已关闭。 */
export function startDesktopUninstallWorker(): void {
  if (typeof process.send !== 'function' || !process.connected || process.ppid <= 1) throw new Error('DESKTOP_UNINSTALL_IPC_REQUIRED');
  type Outcome = { ok: true; result: { cleanedKeys: number } | { rebound: number; unchanged: number } } | { ok: false; error: unknown };
  let handled = false, dispatched = false, stage = 'ipc';
  let input: DesktopUninstallRequest | DesktopReinstallRequest | undefined, outcome: Outcome;
  const timer = setTimeout(() => finish({ ok: false, error: new Error('DESKTOP_UNINSTALL_IPC_TIMEOUT') }), 15_000);
  /** 一次安全结构日志保错误指纹与主副因，不回显凭据存储正文。 */
  function logFailure(error: unknown): Record<string, unknown> {
    const failure = safeFailure(error);
    const reinstall = input?.action === 'reinstall_local_tasks' ? input : undefined;
    process.stderr.write(`${JSON.stringify({ level: 'error', errorCode: failure.code, requestId: input?.requestId ?? null,
      clientId: input?.clientId ?? null, deviceId: input && 'deviceId' in input ? input.deviceId : null,
      ...(reinstall ? { oldDeviceId: reinstall.oldDeviceId, nextDeviceId: reinstall.nextDeviceId } : {}),
      stage, event: { category: 'desktop', action: input?.action ?? 'uninstall_credentials', outcome: 'failure' }, rootCause: failure })}\n`);
    return failure;
  }
  /** 回复后断开 IPC；发送失败保持非零结果交父进程 close 核验。 */
  function finish(value: Outcome): void {
    clearTimeout(timer);
    handled = true;
    dispatched = true;
    process.exitCode = value.ok ? 0 : 1;
    const response = value.ok ? { result: value.result } : { error: logFailure(value.error) };
    try {
      if (!process.connected) throw new Error('DESKTOP_UNINSTALL_IPC_DISCONNECTED');
      process.send!({ schemaVersion: 1, requestId: input?.requestId ?? null, ok: value.ok, ...response }, sendError => {
        if (sendError) { process.exitCode = 1; logFailure(Object.assign(new Error('DESKTOP_UNINSTALL_IPC_SEND_FAILED', { cause: sendError }), { code: 'DESKTOP_UNINSTALL_IPC_SEND_FAILED' })); }
        if (process.connected) process.disconnect!();
      });
    } catch (error) { process.exitCode = 1; logFailure(error); if (process.connected) process.disconnect!(); }
  }
  process.once('disconnect', () => {
    if (dispatched) return;
    clearTimeout(timer); handled = true; dispatched = true; process.exitCode = 1;
    logFailure(new Error('DESKTOP_UNINSTALL_IPC_DISCONNECTED'));
  });
  process.on('message', value => {
    if (handled) {
      const error = new Error('DESKTOP_UNINSTALL_IPC_DUPLICATE');
      if (dispatched) { process.exitCode = 1; logFailure(error); }
      else outcome = { ok: false, error };
      return;
    }
    handled = true;
    try {
      const reinstall = value && typeof value === 'object' && Object.hasOwn(value, 'action')
        && Object.getOwnPropertyDescriptor(value, 'action')?.value !== 'migration_credentials';
      input = reinstall ? parseDesktopReinstallRequest(value) : parseDesktopUninstallRequest(value);
      const onStage = (value: string): void => { stage = value; };
      outcome = { ok: true, result: reinstall ? runDesktopReinstallLocalTasks(input, { onStage }) : runDesktopUninstallCleanup(input, { onStage }) };
    }
    catch (error) { outcome = { ok: false, error }; }
    setImmediate(() => finish(outcome));
  });
}

// 仅明确包内入口启动维护；普通 import 不绑定 IPC 或执行清理。
if (/^desktopUninstallWorker\.(?:cjs|ts)$/u.test(path.basename(process.argv[1] ?? ''))) {
  try { startDesktopUninstallWorker(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', errorCode: 'DESKTOP_UNINSTALL_IPC_REQUIRED', requestId: null, clientId: null, deviceId: null, stage: 'ipc', rootCause: safeFailure(error) })}\n`);
    process.exitCode = 1;
  }
}
