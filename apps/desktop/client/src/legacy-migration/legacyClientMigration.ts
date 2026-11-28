import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import type { WorkspaceId, ThreadId, OrchestrationId } from '@codeflowai/shared';
import { openSqliteDb, type SqliteDb } from '../db/sqliteDb.js';
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb, assertWorkspaceDbReadOnlySchema,
  ensureWorkspaceCoreQueueTables, ensureWorkspaceAdditionalTables, WORKSPACE_CORE_TABLES, WORKSPACE_ADDITIONAL_TABLES } from '../db/migrateClientDb.js';
import { WorkspaceRepo, type PersistedWorkspace } from '../db/repos/workspaceRepo.js';
import { ThreadQueueStateRepo } from '../db/repos/threadQueueStateRepo.js';
import { FileBlobRepo } from '../db/repos/fileBlobRepo.js';
import { OrchInstanceRepo, OrchInstanceScopeError, readStrictInstanceScope } from '../db/repos/orchInstanceRepo.js';
import { ChatWorkflowRepo } from '../db/repos/chatWorkflowRepo.js';
import { hashOrchNodeAttemptSubmission } from '../db/repos/orchNodeAttemptRepo.js';
import { serializeCodeAttributionOutboxPayload } from '../db/repos/codeAttributionOutboxRepo.js';
import { OrchIntakeListStateRepo } from '../db/repos/orchIntakeListStateRepo.js';
import { OrchInstanceSummaryProjectionReader } from '../db/orchInstanceSummaryProjection.js';
import { scheduledTaskAccountRuntimeKey } from '../db/repos/scheduledTaskRuntimeStateRepo.js';
import { ConversationEventRepo, RawEngineEventRepo, readWorkspaceEventSeqFloor, recordWorkspaceEventSeqFloor } from '../db/repos/eventRepo.js';
import { acquireClientProcessLock, buildClientProcessLockPath, type ClientProcessLock } from '../startup/clientStartupGuards.js';
import { ensureWorkspaceCodeflowaiDirectory, inspectExistingWorkspaceCodeflowaiDirectory, inspectWorkspaceCodeflowaiFiles,
  assertWorkspaceCodeflowaiDirectory, WORKSPACE_CODEFLOWAI_DIRECTORY, WORKSPACE_RUNTIME_DIRECTORY } from '../codeflowai/workspaceCodeflowaiDirectory.js';
import { resolveWorkspaceReadPath } from '../fs/fsHelpers.js';
import { parseLegacyClientMigrationRequest, type LegacyClientMigrationRequest, type LegacyClientMigrationProgress,
  type LegacyClientMigrationResult, type LegacyClientMigrationContext,
  type LegacyClientMigrationTargetInUse } from './legacyClientMigrationProtocol.js';

type Input = Omit<LegacyClientMigrationRequest, 'action'>;
type Row = Record<string, any>;
type ConversionReport = (phase: string, table?: string, processed?: number, threadId?: string,
  workspaceIndex?: number, threadCount?: number) => void;
type SourceConfig = { apiKey: string; serverWs: string; clientId: string };
type Source = { configPath: string; dbPath: string; accountNamespace: string; sourceClientId: string; serverWs: string;
  workspaces: Array<PersistedWorkspace & { workspaceDbPath: string | null }>; candidateId: string };
type PublishedFile = { target: string; staged: string; sha256: string; originalSha256: string | null; published: boolean };
type WorkflowScopeRepairFix = { workspaceId: string; instanceId: string; previousScopeId: string };
type WorkflowScopeRepairBackup = { schemaVersion: 1; migrationId: string; fixes: WorkflowScopeRepairFix[] };
type MigrationSkippedRecord = { workspaceId: string; table: string; recordId: string;
  reason: 'constraint' | 'parent_record_skipped'; rootCauseCode: 'SQLITE_CONSTRAINT_IGNORED' | 'MIGRATION_PARENT_RECORD_SKIPPED' };
type MigrationSkipReport = { schemaVersion: 1; migrationId: string; skipped: MigrationSkippedRecord[] };
type WorkspaceCopyState = { skippedLocalTaskIds: Set<string>; skippedAccountRuntimeKeys: Set<string> };
type Journal = { schemaVersion: 1 | 2; migrationId: string; candidateId: string; targetClientId: string; targetDeviceId: string;
  source: Source; stage: string; files: PublishedFile[]; snapshotsReady: boolean; converted: boolean;
  completed: boolean; deferred?: boolean; errorCode: string | null; snapshotGeneration: string | null;
  targetInitialization: { dbSha256: string; metaSha256: string } | null;
  snapshotHashes: Array<{ name: string; sha256: string }> };
export type LegacyClientMigrationDependencies = {
  homeDir?: string;
  resolveNamespace?: (config: SourceConfig) => Promise<string>;
  onProgress?: (progress: LegacyClientMigrationProgress) => void;
  signal?: AbortSignal;
  afterPublish?: (file: { target: string }) => void;
};
const JOURNAL = 'legacy-client-migration-journal.json';
const LEGACY_MIGRATION_DIR = 'legacy-client-migration';
const TARGET_IN_USE_MARKER = 'target-in-use.json';
const WORKFLOW_SCOPE_REPAIR = 'workflow-scope-repair.json';
const MIGRATION_SKIPPED_RECORDS = 'migration-skipped-records.json';
type TargetInUseReason = 'business_data' | 'workspaces' | 'workspace_deleted' | 'workspace_path' | 'workspace_database'
  | 'event_seq' | 'meta_key' | 'config_api_key';
const TARGET_IN_USE_REASONS = new Set<string>(['business_data', 'workspaces', 'workspace_deleted', 'workspace_path',
  'workspace_database', 'event_seq', 'meta_key', 'config_api_key']);
type TargetInspection = { state: 'empty'; initialization: Journal['targetInitialization'] }
  | { state: 'in_use'; evidence: LegacyClientMigrationTargetInUse & { reason: TargetInUseReason } };
type TargetInUseMarker = { schemaVersion: 1; targetClientId: string; reason: TargetInUseReason;
  table?: string; workspaceCount?: number; decidedAt: string };
const SIDECARS = ['-wal', '-shm', '-journal'];
const PROFILE_TABLES = ['workspace_execution_profiles', 'workspace_prefs', 'scheduled_task_configs', 'scheduled_task_runs',
  'scheduled_task_account_configs', 'scheduled_task_runtime_states'];
const CACHE_TABLES = ['conversation_presentations', 'conversation_presentation_items', 'orch_list_status_count_cache'];
const WORKSPACE_TABLES = [...new Set([...WORKSPACE_CORE_TABLES, ...WORKSPACE_ADDITIONAL_TABLES, ...PROFILE_TABLES])]
  .filter(table => table !== 'meta' && !CACHE_TABLES.includes(table));
const RETIRED_TABLES = ['notes', 'orch_asset_bundle_sync', 'orch_asset_cache_entries', 'orch_asset_cache_group_assignments',
  'orch_asset_cache_groups', 'orch_asset_cache_skill_files', 'orch_asset_cache_state', 'orch_asset_cache_sync_pages',
  'orch_asset_cache_sync_runs', 'orch_asset_legacy_authority_state', 'orch_asset_migration_lock_state',
  'engine_events', 'conversation_items'];
const REFERENCE_KEYS = new Set(['workspaceId', 'workspace_id', 'workspaceScopeId', 'workspace_scope_id',
  'sourceWorkspaceId', 'targetWorkspaceId', 'localWorkspaceId', 'hostWorkspaceId']);

/** 发现当前配置账号；已完成迁移先校验并修复可确定的工作流本机范围。 */
export async function discoverLegacyClientMigration(input: Input, dependencies: LegacyClientMigrationDependencies = {}): Promise<LegacyClientMigrationResult> {
  validateInput(input);
  const journal = readJournal(input);
  if (journal) {
    if (journal.deferred) {
      if (!isPrepublication(journal)) fail('MIGRATION_DEFER_UNSAFE');
      return { candidateId: null, workspaceCount: 0, migrationId: journal.migrationId, deferred: true };
    }
    if (journal.completed) { validateCompleted(input, journal, true); return await journalResult(journal, dependencies); }
    return { candidateId: journal.candidateId, workspaceCount: journal.source.workspaces.length, migrationId: journal.migrationId,
      resume: true, canDefer: canDeferJournal(journal) };
  }
  const marker = readTargetInUseMarker(input);
  // 标记命中且目标仍在使用时直接跳过：不再扫描旧数据、不联网、不重复提示。
  if (marker?.targetClientId === input.targetClientId && targetStillInUse(input)) {
    return { candidateId: null, workspaceCount: 0 };
  }
  const inspection = inspectTarget(input);
  if (inspection.state === 'in_use') {
    persistTargetInUseMarker(input, inspection.evidence);
    return { candidateId: null, workspaceCount: 0, targetInUse: inspection.evidence };
  }
  if (marker) removeTargetInUseMarker(input);
  const source = await discoverSource(input, dependencies);
  return { candidateId: source?.candidateId ?? null, workspaceCount: source?.workspaces.length ?? 0 };
}

/** 仅未进入发布的任务可暂缓；保留journal归属，后续启动不再自动导入或恢复旧账号。 */
export function deferLegacyClientMigration(input: Input): LegacyClientMigrationResult {
  parseLegacyClientMigrationRequest({ ...input, action: 'defer' }); validateInput(input);
  const lock = acquireClientProcessLock({ dbPath: path.join(input.dataDir, 'codeflowai.db'), clientId: input.targetClientId });
  let failure: unknown;
  try {
    const journal = readJournal(input);
    if (!journal || !canDeferJournal(journal)) fail('MIGRATION_DEFER_UNSAFE');
    // 旧Worker只接受版本1；暂缓升级格式，防止忽略新字段后自动续迁。
    journal.deferred = true; journal.schemaVersion = 2; writeJournal(input, journal);
    return { candidateId: null, workspaceCount: 0, migrationId: journal.migrationId, deferred: true };
  } catch (error) { failure = error; throw error; }
  finally {
    try { lock.release(); }
    catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], 'MIGRATION_LOCK_RELEASE_FAILED', { cause: failure }); }
  }
}

/** 发布阶段包括rename落地但journal未更新的窗口，任何published计数都不能绕过。 */
function isPrepublication(journal: Journal): boolean {
  return !journal.completed && ['quiesce', 'snapshot', 'convert', 'verify'].includes(journal.stage)
    && journal.files.every(file => !file.published);
}

/** 暂缓前复验暂存仍在、原目标未替换；已暂缓后正常桌面可合法更新原目标。 */
function canDeferJournal(journal: Journal): boolean {
  return isPrepublication(journal) && (journal.deferred === true || journal.files.every(file => exists(file.staged)
    && (file.originalSha256 === null ? !exists(file.target) : exists(file.target) && sha256File(file.target) === file.originalSha256)));
}

/** 卸载清本安装已完成或已暂缓的私有归档凭据，保留历史，原Client及项目不写。 */
export function clearLegacyMigrationCredentials(input: Input): void {
  const root = path.join(input.dataDir, LEGACY_MIGRATION_DIR), journal = readJournal(input);
  if (!journal) {
    if (!exists(root)) return;
    // 临时目录可能经短路径打开，这里只核物理目录类型，不做 realpath 等值比较。
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SOURCE_PATH_UNSAFE');
    const names = fs.readdirSync(root);
    // 目标已使用但没有迁移归档时，目录内只允许去重标记；空目录仍视为无主归档。
    if (!names.length || names.some(name => name !== TARGET_IN_USE_MARKER)) fail('MIGRATION_ARCHIVE_OWNER_MISSING');
    return;
  }
  validateInput(input);
  if (journal.deferred) { if (!isPrepublication(journal)) fail('MIGRATION_DEFER_UNSAFE'); }
  else { if (!journal.completed) fail('MIGRATION_NOT_COMPLETED'); validateCompleted(input, journal); }
  if (!exists(root)) return;
  assertDirectory(root);
  const archive = archiveDirectory(input, journal);
  if (fs.readdirSync(root).some(name => name !== journal.migrationId && name !== TARGET_IN_USE_MARKER)) fail('MIGRATION_ARCHIVE_UNKNOWN_ENTRY');
  if (!exists(archive)) return;
  const databases: string[] = [], temporary: string[] = [];
  /** 归档只允许已生成的两层目录和固定文件；收齐清单后才打开可写库。 */
  const inspect = (directory: string, generation: boolean): void => {
    assertDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!generation && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) { inspect(file, true); continue; }
      assertFile(file);
      const database = generation ? /^(?:source-application|(?:original|source)-workspace-[0-9]+)\.db$/ : /^(?:original-empty-application|target-application|converted-workspace-[0-9]+)\.db$/;
      const base = name.replace(/-(?:wal|shm|journal)$|\.meta\.json$|\.snapshot$/u, '');
      if (database.test(name)) databases.push(file);
      else if (database.test(base) && name !== base) {
        if (name.endsWith('.snapshot')) temporary.push(file);
        else if (!exists(path.join(directory, base))) fail('MIGRATION_ARCHIVE_ORPHAN_SIDECAR');
      } else if (!generation && name === WORKFLOW_SCOPE_REPAIR) {
        validateWorkflowScopeRepairBackup(readObject(file), journal);
      } else if (!generation && name === MIGRATION_SKIPPED_RECORDS) {
        validateMigrationSkipReport(readObject(file), journal);
      } else if (generation && name === 'source-application.meta.json') {
        readObject(file);
      } else if (!generation && ['target-config.json', 'target-meta.json'].includes(name)) {
        if (name === 'target-config.json' && readObject(file).apiKey !== '') fail('MIGRATION_ARCHIVE_CONFIG_INVALID');
      } else fail('MIGRATION_ARCHIVE_UNKNOWN_ENTRY');
    }
  };
  inspect(archive, false);
  for (const file of databases) clearArchivedDatabaseCredentials(file);
  for (const file of temporary) { assertFile(file); fs.unlinkSync(file); }
  if (journal.snapshotGeneration && exists(snapshotDirectory(input, journal))) {
    const directory = snapshotDirectory(input, journal);
    journal.snapshotHashes = fs.readdirSync(directory).map(name => ({ name, sha256: sha256File(path.join(directory, name)) }));
    writeJournal(input, journal);
  }
}

/** 历史SQLite只更新凭据列，不迁schema；安全删除及收口后重开核验，失败阻断卸载。 */
function clearArchivedDatabaseCredentials(filename: string): void {
  withDatabase(filename, false, db => {
    integrity(db);
    if (db.pragma('secure_delete = ON', { simple: true }) !== 1) fail('MIGRATION_ARCHIVE_SECURE_DELETE_FAILED');
    if (hasTable(db, 'engine_keys')) {
      const names = columns(db, 'engine_keys');
      if (!names.includes('api_key') || !names.includes('is_active')) fail('MIGRATION_ARCHIVE_SCHEMA_INVALID');
      db.prepare(`UPDATE engine_keys SET api_key='',is_active=0${names.includes('secret_ref') ? ',secret_ref=NULL' : ''}`).run();
    }
    db.exec('VACUUM');
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Row[];
    if (checkpoint.length !== 1 || checkpoint[0]!.busy !== 0 || checkpoint[0]!.log !== checkpoint[0]!.checkpointed
      || db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') fail('MIGRATION_ARCHIVE_CHECKPOINT_FAILED');
    integrity(db);
  });
  syncFile(filename);
  withDatabase(filename, true, db => {
    integrity(db);
    if (hasTable(db, 'engine_keys') && db.prepare(`SELECT 1 FROM engine_keys WHERE api_key<>'' OR is_active<>0${columns(db, 'engine_keys').includes('secret_ref') ? ' OR secret_ref IS NOT NULL' : ''} LIMIT 1`).get()) {
      fail('MIGRATION_ARCHIVE_CREDENTIALS_NOT_CLEARED');
    }
  });
}

/** 重装按明确旧/新身份清归档并接续完成或暂缓事实；不把暂缓伪造成完成。 */
export function rebindLegacyMigrationForReinstall(input: { dataDir: string; clientId: string; oldDeviceId: string; nextDeviceId: string }): void {
  const filename = path.join(input.dataDir, JOURNAL);
  if (!exists(filename)) return;
  const value = readObject(filename);
  if (![input.oldDeviceId, input.nextDeviceId].includes(value.targetDeviceId)) fail('MIGRATION_JOURNAL_CONFLICT');
  const target = { dataDir: input.dataDir, targetClientId: input.clientId, targetDeviceId: value.targetDeviceId as string };
  validateInput(target);
  const journal = readJournal(target)!;
  if (journal.deferred) { if (!isPrepublication(journal)) fail('MIGRATION_DEFER_UNSAFE'); }
  else { if (!journal.completed) fail('MIGRATION_NOT_COMPLETED'); validateCompleted(target, journal); }
  clearLegacyMigrationCredentials(target);
  if (journal.targetDeviceId !== input.nextDeviceId) writeJournal(target, { ...readJournal(target)!, targetDeviceId: input.nextDeviceId });
}

/** 用户确认后独占来源、快照转换并逐项提交；任何失败都保持业务屏障与归档。 */
export async function migrateLegacyClientMigration(input: Input, dependencies: LegacyClientMigrationDependencies = {}): Promise<LegacyClientMigrationResult> {
  parseLegacyClientMigrationRequest({ ...input, action: 'migrate' }); validateInput(input);
  let journal = readJournal(input);
  if (journal?.deferred) fail('MIGRATION_DATA_DEFERRED');
  if (journal?.completed) { validateCompleted(input, journal, true); return await journalResult(journal, dependencies); }
  if (!journal) {
    const source = await discoverSource(input, dependencies);
    if (!source || source.candidateId !== input.candidateId) fail('MIGRATION_CANDIDATE_CHANGED');
    const targetInitialization = assertEmptyTarget(input);
    journal = { schemaVersion: 1, migrationId: input.migrationId!, candidateId: source.candidateId,
      targetClientId: input.targetClientId, targetDeviceId: input.targetDeviceId, source, stage: 'quiesce', files: [],
      snapshotsReady: false, converted: false, completed: false, errorCode: null, snapshotGeneration: null, targetInitialization, snapshotHashes: [] };
    writeJournal(input, journal);
  }
  if (journal.candidateId !== input.candidateId || journal.migrationId !== input.migrationId) fail('MIGRATION_ID_CONFLICT');
  const locks: ClientProcessLock[] = [];
  let failure: unknown;
  try {
    checkpoint(dependencies); progress(dependencies, 'quiesce', 0, null, journal);
    await stopLegacyOwner(journal.source, dependencies);
    locks.push(acquireClientProcessLock({ dbPath: journal.source.dbPath, clientId: journal.source.sourceClientId }));
    locks.push(acquireClientProcessLock({ dbPath: path.join(input.dataDir, 'codeflowai.db'), clientId: input.targetClientId }));
    if (!journal.snapshotsReady) refreshFrozenSource(journal.source);
    for (const dbPath of journal.source.workspaces.flatMap(work => work.workspaceDbPath ? [work.workspaceDbPath] : [])) {
      locks.push(acquireClientProcessLock({ dbPath, clientId: journal.source.sourceClientId }));
    }
    const archive = archiveDirectory(input, journal); fs.mkdirSync(archive, { recursive: true });
    archiveEmptyInitialization(input, journal);
    if (!journal.snapshotsReady) {
      journal.stage = 'snapshot'; journal.snapshotGeneration = crypto.randomUUID(); writeJournal(input, journal);
      const generation = snapshotDirectory(input, journal); fs.mkdirSync(generation);
      snapshot(journal.source.dbPath, path.join(generation, 'source-application.db'));
      fs.copyFileSync(`${journal.source.dbPath}.meta.json`, path.join(generation, 'source-application.meta.json'), fs.constants.COPYFILE_EXCL);
      syncFile(path.join(generation, 'source-application.meta.json'));
      const config = readSourceConfig(journal.source.configPath);
      if (config.clientId !== journal.source.sourceClientId) fail('SOURCE_IDENTITY_CHANGED');
      for (let index = 0; index < journal.source.workspaces.length; index++) {
        checkpoint(dependencies);
        const work = journal.source.workspaces[index]!;
        if (work.workspaceDbPath) {
          for (const suffix of ['', ...SIDECARS]) {
            const original = `${work.workspaceDbPath}${suffix}`, archived = path.join(generation, `original-workspace-${index}.db${suffix}`);
            if (exists(original) && !exists(archived)) { assertFile(original); fs.copyFileSync(original, archived, fs.constants.COPYFILE_EXCL); syncFile(archived); }
          }
          snapshot(work.workspaceDbPath, path.join(generation, `source-workspace-${index}.db`));
        }
        progress(dependencies, 'snapshot', index + 1, journal.source.workspaces.length, journal);
        await yieldLoop();
      }
      journal.snapshotHashes = fs.readdirSync(generation).map(name => ({ name, sha256: sha256File(path.join(generation, name)) }));
      journal.snapshotsReady = true; writeJournal(input, journal);
    }
    if (!journal.converted) {
      for (const archived of journal.snapshotHashes) {
        if (path.basename(archived.name) !== archived.name || sha256File(path.join(snapshotDirectory(input, journal), archived.name)) !== archived.sha256) fail('MIGRATION_ARCHIVE_CHANGED');
      }
      journal.stage = 'convert'; writeJournal(input, journal);
      journal.files = await convertSnapshots(input, journal, dependencies);
      journal.converted = true; journal.stage = 'verify'; writeJournal(input, journal);
    }
    for (const [index, file] of journal.files.entries()) {
      checkpoint(dependencies);
      assertWorkspacePublishLocation(journal, file);
      if (!file.published && (exists(file.staged) ? sha256File(file.staged) !== file.sha256
        : !exists(file.target) || sha256File(file.target) !== file.sha256)) fail('MIGRATION_STAGING_CHANGED');
      progress(dependencies, 'verify', index + 1, journal.files.length, journal);
    }
    journal.stage = 'publish'; writeJournal(input, journal);
    for (const [index, file] of journal.files.entries()) {
      checkpoint(dependencies); publishFile(input, journal, file);
      progress(dependencies, 'publish', index + 1, journal.files.length, journal);
      dependencies.afterPublish?.({ target: file.target });
      await yieldLoop();
    }
    withDatabase(path.join(input.dataDir, 'codeflowai.db'), true, db => {
      for (const source of journal.source.workspaces) if (!new WorkspaceRepo(db).getIncludingDeleted(mappedWorkspaceId(source.id, journal.source.sourceClientId, input.targetClientId) as WorkspaceId)) fail('MIGRATION_REGISTRATION_INCOMPLETE');
    });
    validateCompleted(input, journal);
    journal.completed = true; journal.stage = 'completed'; journal.errorCode = null; writeJournal(input, journal);
    return await journalResult(journal, dependencies);
  } catch (error) {
    failure = error; journal.errorCode = errorCode(error); writeJournal(input, journal); throw error;
  } finally {
    const errors: unknown[] = [];
    for (const lock of locks.reverse()) { try { lock.release(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], 'MIGRATION_LOCK_RELEASE_FAILED', { cause: failure });
  }
}

/** 扫描仅限当前用户的已知目录；先排除明确加密，再向原 Server 只读确认账号。 */
async function discoverSource(input: Input, dependencies: LegacyClientMigrationDependencies): Promise<Source | null> {
  checkpoint(dependencies);
  const home = path.resolve(dependencies.homeDir ?? os.homedir()), sourceDir = path.join(home, '.codeflowai');
  const configPath = path.join(sourceDir, 'config.json');
  if (!exists(configPath)) return null;
  const config = readSourceConfig(configPath);
  const paths = [path.join(sourceDir, 'codeflowai.db')];
  const accounts = path.join(sourceDir, 'client-dbs');
  if (exists(accounts)) {
    assertDirectory(accounts);
    for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
      if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('SOURCE_PATH_UNSAFE');
      paths.push(path.join(accounts, entry.name, 'codeflowai.db'));
    }
  }
  const plain: Array<{ dbPath: string; meta: Row }> = [];
  let encrypted = false;
  for (const dbPath of paths) {
    if (!exists(dbPath) && !exists(`${dbPath}.meta.json`)) continue;
    const meta = exists(`${dbPath}.meta.json`) ? readObject(`${dbPath}.meta.json`) : {};
    if (meta.encryptionMode === 'server_managed_sqlcipher' && meta.cipher === 'sqlcipher'
      && typeof meta.dbId === 'string' && Number.isSafeInteger(meta.keyVersion) && meta.keyVersion > 0) { encrypted = true; continue; }
    plain.push({ dbPath, meta });
  }
  if (!plain.length) return null;
  if (!config.clientId) fail('SOURCE_CLIENT_ID_MISSING');
  let accountNamespace: string;
  try { accountNamespace = await (dependencies.resolveNamespace ?? resolveNamespace)(config); }
  catch (error) {
    checkpoint(dependencies);
    if (!encrypted || errorCode(error) !== 'SOURCE_ACCOUNT_UNRESOLVED') throw error;
    // 用户确认：仅混合目录的账号认证不可用允许本次不提醒；不猜归属、不写标记，下次启动重新只读检测。
    process.stderr.write(`${JSON.stringify({ event: 'LEGACY_MIGRATION_DISCOVERY_DEFERRED', errorCode: 'SOURCE_ACCOUNT_UNRESOLVED',
      requestId: 'legacy-discovery', sourceClientId: config.clientId, targetClientId: input.targetClientId, stage: 'discover',
      rootCause: { code: errorCode(error), type: error instanceof Error ? 'Error' : typeof error } })}\n`);
    return null;
  }
  if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(accountNamespace)) fail('SOURCE_ACCOUNT_UNRESOLVED');
  const matching = plain.filter(entry => entry.meta.accountNamespace === accountNamespace
    || path.basename(path.dirname(entry.dbPath)) === accountNamespace);
  if (matching.length > 1) fail('SOURCE_ACCOUNT_AMBIGUOUS');
  if (!matching.length) {
    if (plain.some(entry => entry.meta.accountNamespace === undefined)) fail('SOURCE_OWNERSHIP_UNKNOWN');
    return null;
  }
  const entry = matching[0]!, meta = entry.meta;
  if (!exists(entry.dbPath)) fail('SOURCE_FILE_MISSING');
  assertFile(entry.dbPath);
  if (!plainHeader(entry.dbPath)) fail('SOURCE_FORMAT_UNKNOWN');
  if (meta.schemaVersion !== 2 || meta.storageMode !== 'plain_sqlite' || meta.initializationState !== 'ready'
    || !['ed25519', 'runtime'].includes(meta.deviceAuthMode)) fail('SOURCE_META_UNSUPPORTED');
  if (samePath(entry.dbPath, path.join(input.dataDir, 'codeflowai.db'))) fail('SOURCE_TARGET_OVERLAP');
  const source = withDatabase(entry.dbPath, true, db => {
    assertApplicationSource(db); integrity(db);
    if (metaValue(db, 'client_id') !== config.clientId) fail('SOURCE_CLIENT_ID_MISMATCH');
    const workspaces = new WorkspaceRepo(db).list({ includeDeleted: true }).map(inspectSourceWorkspace);
    if (!workspaces.length) return null;
    const identity = workspaces.map(work => ({ id: work.id, path: fs.realpathSync.native(work.path), workspaceDbPath: work.workspaceDbPath }));
    const candidateId = sha256(JSON.stringify({ dbPath: fs.realpathSync.native(entry.dbPath), accountNamespace, clientId: config.clientId, identity }));
    return { dbPath: entry.dbPath, configPath, accountNamespace, sourceClientId: config.clientId, serverWs: config.serverWs, workspaces, candidateId };
  });
  return source;
}

/** 独占应用库后刷新最终注册清单，关闭期间新增的已提交工作区也进入同一闭包。 */
function refreshFrozenSource(source: Source): void {
  const meta = readObject(`${source.dbPath}.meta.json`), config = readSourceConfig(source.configPath);
  if (meta.accountNamespace !== source.accountNamespace || config.clientId !== source.sourceClientId || config.serverWs !== source.serverWs) fail('SOURCE_IDENTITY_CHANGED');
  source.workspaces = withDatabase(source.dbPath, true, db => {
    assertApplicationSource(db);
    if (metaValue(db, 'client_id') !== source.sourceClientId) fail('SOURCE_CLIENT_ID_MISMATCH');
    return new WorkspaceRepo(db).list({ includeDeleted: true }).map(inspectSourceWorkspace);
  });
  const paths = source.workspaces.map(work => pathKey(fs.realpathSync.native(work.path)));
  if (new Set(paths).size !== paths.length) fail('SOURCE_WORKSPACE_PATH_AMBIGUOUS');
}

/** 已注册物理工作区及其分库必须能证明归属；同路径不明数据不能认领。 */
function inspectSourceWorkspace(work: PersistedWorkspace): Source['workspaces'][number] {
  assertDirectory(work.path);
  const candidates = ([WORKSPACE_CODEFLOWAI_DIRECTORY, WORKSPACE_RUNTIME_DIRECTORY] as const).flatMap(name => {
    const directory = inspectExistingWorkspaceCodeflowaiDirectory(work.path, name);
    if (!directory) return [];
    const [file, ...sidecars] = inspectWorkspaceCodeflowaiFiles(directory, ['workspace.db', ...SIDECARS.map(suffix => `workspace.db${suffix}`)]);
    if (!file && sidecars.some(Boolean)) fail('SOURCE_ORPHAN_SIDECAR', { workspaceId: work.id });
    return file ? [file.path] : [];
  });
  if (candidates.length > 1) fail('SOURCE_WORKSPACE_DATABASE_CONFLICT', { workspaceId: work.id });
  const workspaceDbPath = candidates[0] ?? null;
  if (workspaceDbPath) withDatabase(workspaceDbPath, true, workspace => { assertWorkspaceDbReadOnlySchema(workspace); assertWorkspaceOwnership(workspace, work.id); integrity(workspace); });
  return { ...work, workspaceDbPath };
}

/** 从冻结来源推导发布位置。无来源分库的历史日志沿用旧目录。 */
function workspaceMigrationDestination(work: Source['workspaces'][number]) {
  if (!work || typeof work.path !== 'string' || !path.isAbsolute(work.path)) fail('MIGRATION_JOURNAL_INVALID');
  // 旧 journal 可能没有该字段；按无来源分库兼容，非字符串仍显式失败。
  const workspaceDbPath = work.workspaceDbPath ?? null;
  for (const directoryName of [WORKSPACE_RUNTIME_DIRECTORY, WORKSPACE_CODEFLOWAI_DIRECTORY] as const) {
    const target = path.join(work.path, directoryName, 'workspace.db');
    if ((workspaceDbPath === null && directoryName === WORKSPACE_RUNTIME_DIRECTORY)
      || (typeof workspaceDbPath === 'string' && samePath(workspaceDbPath, target))) return { directoryName, target };
  }
  fail('MIGRATION_JOURNAL_INVALID');
}

/** 只读既有账号命名空间入口；失败不暴露远端正文或回显 Key。 */
async function resolveNamespace(config: SourceConfig): Promise<string> {
  const url = new URL(config.serverWs);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('SOURCE_SERVER_INVALID');
  url.protocol = url.protocol.replace('ws', 'http'); url.pathname = '/api/client-db/startup-context'; url.search = ''; url.hash = '';
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: process.platform, arch: process.arch }), signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
  catch (error) { throw migrationError('SOURCE_ACCOUNT_UNRESOLVED', error); }
  if (!response.ok) fail('SOURCE_ACCOUNT_UNRESOLVED');
  let body: Row;
  try { body = await response.json() as Row; } catch (error) { throw migrationError('SOURCE_ACCOUNT_UNRESOLVED', error); }
  if (body?.ok !== true || typeof body.accountNamespace !== 'string') fail('SOURCE_ACCOUNT_UNRESOLVED');
  return body.accountNamespace;
}

/** 只停止来源 DB 锁与 daemon owner 能互证的实例，拒绝未知前台进程。 */
async function stopLegacyOwner(source: Source, dependencies: LegacyClientMigrationDependencies): Promise<void> {
  const sourceDir = path.dirname(source.configPath), daemonPath = path.join(sourceDir, 'client-daemon.json');
  const liveLocks = [source.dbPath, ...source.workspaces.flatMap(work => work.workspaceDbPath ? [work.workspaceDbPath] : [])]
    .map(dbPath => ({ dbPath, lockPath: buildClientProcessLockPath(dbPath) }))
    .filter(entry => exists(entry.lockPath)).map(entry => ({ ...entry, lock: readObject(entry.lockPath) }))
    .filter(entry => processRunning(entry.lock.pid));
  const state = exists(daemonPath) ? readObject(daemonPath) : null;
  if (!state) { if (liveLocks.length) fail('SOURCE_OWNER_UNVERIFIED'); return; }
  if (!processRunning(state.supervisorPid ?? state.pid) && !processRunning(state.clientPid ?? state.pid)) {
    if (liveLocks.length) fail('SOURCE_OWNER_UNVERIFIED'); return;
  }
  if (state.schemaVersion !== 2 || typeof state.supervisorToken !== 'string' || !Number.isInteger(state.supervisorPid)
    || !liveLocks.length || liveLocks.some(entry => entry.lock.pid !== state.clientPid || entry.lock.clientId !== source.sourceClientId
      || !samePath(entry.lock.dbPath, entry.dbPath))) fail('SOURCE_OWNER_UNVERIFIED');
  const supervisorLock = path.join(sourceDir, 'client-daemon-supervisor.lock');
  const owner = readObject(supervisorLock);
  if (owner.token !== state.supervisorToken || owner.pid !== state.supervisorPid) fail('SOURCE_OWNER_UNVERIFIED');
  const { requestVerifiedDaemonSupervisorStop } = await import('../clientDaemon.js');
  await requestVerifiedDaemonSupervisorStop(supervisorLock, state.supervisorToken, state.supervisorPid);
  const deadline = Date.now() + 15_000;
  while (processRunning(state.supervisorPid) || processRunning(state.clientPid)) {
    checkpoint(dependencies); if (Date.now() >= deadline) fail('SOURCE_STOP_TIMEOUT'); await delay(50);
  }
}

/** SQLite 自身生成含 WAL 已提交内容的一致性副本；已存在归档只接受完整有效库。 */
function snapshot(source: string, target: string): void {
  assertFile(source);
  if (exists(target)) { withDatabase(target, true, integrity); return; }
  const temporary = `${target}.snapshot`;
  if (exists(temporary)) fs.unlinkSync(temporary);
  withDatabase(source, true, db => { integrity(db); db.prepare('VACUUM INTO ?').run(temporary); });
  withDatabase(temporary, true, integrity); syncFile(temporary); fs.renameSync(temporary, target); syncDirectory(path.dirname(target));
}

/** 使用现有 schema 转换快照；覆盖基线固定取原始归档，不接纳中断后的来源写入。 */
async function convertSnapshots(input: Input, journal: Journal, dependencies: LegacyClientMigrationDependencies): Promise<PublishedFile[]> {
  const startedAt = Date.now();
  let workspaceIndex: number | undefined;
  /** 记录 SQLite 大步骤开始及完成时间，工作区/查询状态随 Worker 进度发送。 */
  const report: ConversionReport = (phase, table, processed = 0, threadId, threadPosition, threadCount) => {
    checkpoint(dependencies);
    progress(dependencies, 'convert', 0, journal.source.workspaces.length, journal,
      { phase, table, processed, elapsedMs: Date.now() - startedAt,
        ...(threadId ? { threadId } : {}), ...(threadPosition === undefined ? {} : { threadIndex: threadPosition }),
        ...(threadCount === undefined ? {} : { threadCount }),
        ...(workspaceIndex === undefined ? {} : { workspaceIndex: workspaceIndex + 1 }) });
  };
  report('application_snapshot');
  const archive = archiveDirectory(input, journal), appPath = path.join(archive, 'target-application.db');
  const skipReportPath = path.join(archive, MIGRATION_SKIPPED_RECORDS);
  removeOwnedTemporary(skipReportPath);
  const skipped: MigrationSkippedRecord[] = [];
  const recordSkipped = (entry: MigrationSkippedRecord): void => {
    if (skipped.some(row => JSON.stringify(row) === JSON.stringify(entry))) return;
    skipped.push(entry);
  };
  const persistSkipped = (): void => {
    if (skipped.length) writeAtomic(skipReportPath, { schemaVersion: 1, migrationId: journal.migrationId, skipped });
  };
  removeOwnedTemporary(appPath);
  fs.copyFileSync(path.join(snapshotDirectory(input, journal), 'source-application.db'), appPath, fs.constants.COPYFILE_EXCL);
  const files: PublishedFile[] = [];
  const eventSequences = new Set<number>();
  const app = openSqliteDb(appPath, { fileMustExist: true });
  let failure: unknown;
  try {
    report('schema');
    assertApplicationSource(app); migrateClientDb(app); dropRetiredTables(app);
    assertKnownTables(app);
    if ((app.prepare("SELECT operation_id FROM workspace_directory_migrations WHERE state NOT IN ('completed','cancelled','failed') LIMIT 1").get())) fail('SOURCE_WORKSPACE_MOVE_ACTIVE');
    const mapping = new Map(journal.source.workspaces.map(work => [String(work.id), mappedWorkspaceId(work.id, journal.source.sourceClientId, input.targetClientId)]));
    for (const [oldId, newId] of mapping) new WorkspaceRepo(app).migrateWorkspaceId(oldId as WorkspaceId, newId as WorkspaceId);
    await rewriteBusinessReferences(app, mapping, report, dependencies);
    let highWater = validCounter(metaValue(app, 'event_seq'));
    for (let index = 0; index < journal.source.workspaces.length; index++) {
      checkpoint(dependencies);
      const source = journal.source.workspaces[index]!, id = mapping.get(source.id)!;
      workspaceIndex = index;
      report('workspace_schema', undefined, 0, undefined, undefined, journal.source.workspaces.length);
      const { directoryName, target } = workspaceMigrationDestination(source);
      const directory = ensureWorkspaceCodeflowaiDirectory(source.path, directoryName);
      const staged = path.join(directory.directoryPath, `legacy-migration-${journal.migrationId}.db`);
      removeOwnedTemporary(staged);
      const workspace = openSqliteDb(staged);
      const copyState: WorkspaceCopyState = { skippedLocalTaskIds: new Set(), skippedAccountRuntimeKeys: new Set() };
      let workFailure: unknown;
      try {
        migrateClientDb(workspace, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(workspace); ensureWorkspaceAdditionalTables(workspace);
        copyWorkspaceRows(app, workspace, id, false, report, copyState, recordSkipped);
        persistSkipped();
        if (source.workspaceDbPath) {
          const converted = path.join(archive, `converted-workspace-${index}.db`); removeOwnedTemporary(converted);
          fs.copyFileSync(path.join(snapshotDirectory(input, journal), `source-workspace-${index}.db`), converted, fs.constants.COPYFILE_EXCL);
          await withDatabaseAsync(converted, false, async previous => {
            assertKnownTables(previous); assertWorkspaceOwnership(previous, source.id);
            dropRetiredTables(previous);
            migrateClientDb(previous, { scope: 'workspace' }); ensureWorkspaceCoreQueueTables(previous); ensureWorkspaceAdditionalTables(previous);
            await rewriteBusinessReferences(previous, mapping, report, dependencies);
            for (const table of listTables(previous)) {
              const cols = columns(previous, table);
              if (cols.includes('workspace_id')) previous.prepare(`UPDATE ${quote(table)} SET workspace_id=? WHERE workspace_id=?`).run(id, source.id);
              if (cols.includes('workspace_scope_id')) previous.prepare(`UPDATE ${quote(table)} SET workspace_scope_id=? WHERE workspace_scope_id=?`).run(id, source.id);
            }
            copyWorkspaceRows(previous, workspace, id, true, report, copyState, recordSkipped);
            persistSkipped();
            const oldFloor = readWorkspaceEventSeqFloor(previous);
            if (oldFloor > 0) recordWorkspaceEventSeqFloor(workspace, oldFloor);
          });
        }
        report('pause', undefined, 0, undefined, undefined, journal.source.workspaces.length);
        pauseExecution(workspace, input, id);
        await verifyWorkspace(workspace, id, source.path, report, dependencies);
        report('event_sequences', 'conversation_events', 0, undefined, undefined, journal.source.workspaces.length);
        let sequenceCount = 0;
        for (const row of workspace.prepare('SELECT seq FROM conversation_events UNION ALL SELECT seq FROM raw_engine_events').iterate() as IterableIterator<Row>) {
          if (eventSequences.has(row.seq)) fail('SOURCE_EVENT_SEQUENCE_CONFLICT'); eventSequences.add(row.seq);
          if (++sequenceCount % 1_024 === 0) report('event_sequences', 'conversation_events', sequenceCount);
        }
        const floor = referenceHighWater(workspace); if (floor > 0) recordWorkspaceEventSeqFloor(workspace, floor);
        highWater = Math.max(highWater, floor);
        integrity(workspace);
      } catch (error) { workFailure = error; throw error; }
      finally { closeDatabase(workspace, workFailure); }
      syncFile(staged); assertWorkspaceCodeflowaiDirectory(directory);
      files.push({ target, staged, sha256: sha256File(staged), originalSha256: source.workspaceDbPath
        ? sha256File(path.join(snapshotDirectory(input, journal), `original-workspace-${index}.db`)) : null, published: false });
      progress(dependencies, 'convert', index + 1, journal.source.workspaces.length, journal,
        { phase: 'workspace_completed', workspaceIndex: index + 1, elapsedMs: Date.now() - startedAt });
      await yieldLoop();
    }
    workspaceIndex = undefined;
    cleanApplicationWorkspaceRows(app, mapping, report);
    report('application_finalize');
    pauseExecution(app, input, null);
    app.prepare("UPDATE meta SET value=? WHERE key='client_id'").run(input.targetClientId);
    app.prepare("UPDATE meta SET value=? WHERE key='event_seq'").run(String(highWater));
    app.prepare("UPDATE engine_keys SET is_active=0, api_key='', secret_ref=NULL WHERE source='builtin'").run();
    integrity(app);
    app.pragma('wal_checkpoint(TRUNCATE)'); app.pragma('journal_mode = DELETE');
  } catch (error) { failure = error; throw error; }
  finally { closeDatabase(app, failure); }
  syncFile(appPath);
  const targetConfig = path.join(input.dataDir, 'config.json');
  if (exists(targetConfig) && readObject(targetConfig).clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const configStaged = path.join(archive, 'target-config.json');
  writeAtomic(configStaged, { ...(exists(targetConfig) ? readObject(targetConfig) : {}), clientId: input.targetClientId, apiKey: '', serverWs: readSourceConfig(journal.source.configPath).serverWs });
  files.push({ target: targetConfig, staged: configStaged, sha256: sha256File(configStaged), originalSha256: exists(targetConfig) ? sha256File(targetConfig) : null, published: false });
  const metaStaged = path.join(archive, 'target-meta.json');
  writeAtomic(metaStaged, { schemaVersion: 3, storageMode: 'plain_sqlite', ownership: 'local_os_user', initializationState: 'ready' });
  files.push({ target: path.join(input.dataDir, 'codeflowai.db.meta.json'), staged: metaStaged, sha256: sha256File(metaStaged), originalSha256: journal.targetInitialization?.metaSha256 ?? null, published: false });
  files.push({ target: path.join(input.dataDir, 'codeflowai.db'), staged: appPath, sha256: sha256File(appPath), originalSha256: journal.targetInitialization?.dbSha256 ?? null, published: false });
  return files;
}

/** 按行复制；SQLite 约束拒绝时记账跳过该行，数据库和 I/O 故障仍终止迁移。 */
function copyWorkspaceRows(source: SqliteDb, target: SqliteDb, id: string, whole: boolean, report: ConversionReport,
  state: WorkspaceCopyState, recordSkipped: (entry: MigrationSkippedRecord) => void): void {
  source.pragma('foreign_keys = ON'); target.pragma('foreign_keys = OFF');
  try {
    target.transaction(() => {
      for (const table of WORKSPACE_TABLES) {
        if (!hasTable(source, table)) continue;
        const predicate = whole ? '1' : workspacePredicate(source, table, id);
        if (!predicate) fail('SOURCE_TABLE_OWNERSHIP_UNSUPPORTED');
        report('copy', table);
        const rows = source.prepare("SELECT * FROM " + quote(table) + " WHERE " + predicate).iterate() as IterableIterator<Row>;
        const names = columns(source, table), targetNames = columns(target, table);
        if (names.some(name => !targetNames.includes(name))) fail('SOURCE_SCHEMA_UNSUPPORTED');
        const before = tableCount(target, table);
        const insert = target.prepare(`INSERT OR IGNORE INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
        let copied = 0;
        let scanned = 0;
        for (const row of rows) {
          scanned++;
          if (table === 'scheduled_task_runtime_states' && skippedScheduledTaskParent(target, row.task_id, state)) {
            recordSkipped({ workspaceId: id, table, recordId: migrationRecordId(source, table, row, scanned),
              reason: 'parent_record_skipped', rootCauseCode: 'MIGRATION_PARENT_RECORD_SKIPPED' });
            continue;
          }
          const result = insert.run(...names.map(name => row[name]));
          if (Number(result.changes ?? 0) === 0) {
            recordSkipped({ workspaceId: id, table, recordId: migrationRecordId(source, table, row, scanned),
              reason: 'constraint', rootCauseCode: 'SQLITE_CONSTRAINT_IGNORED' });
            if (table === 'scheduled_task_configs' && typeof row.id === 'string') state.skippedLocalTaskIds.add(row.id);
            if (table === 'scheduled_task_account_configs' && typeof row.task_id === 'string'
              && [row.server_origin, row.owner_user_id, row.client_id, row.device_id].every(value => typeof value === 'string' && value)) {
              state.skippedAccountRuntimeKeys.add(scheduledTaskAccountRuntimeKey(row.task_id,
                { serverOrigin: row.server_origin, ownerUserId: row.owner_user_id, clientId: row.client_id, deviceId: row.device_id }));
            }
          } else copied++;
          if (scanned % 1_024 === 0) report('copy', table, scanned);
        }
        const count = Number((target.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as Row).count);
        if (count - before !== copied) fail('MIGRATION_ROW_COUNT_MISMATCH');
        report('copy', table, scanned);
      }
      if (whole && hasTable(source, 'meta')) {
        for (const row of source.prepare('SELECT key,value FROM meta').all() as Array<{ key: string; value: string }>) {
          if (!row.key.startsWith('engine_native_fallback_block:')) continue;
          target.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key, row.value);
        }
      }
      skipRowsWithMissingParents(target, id, state, recordSkipped);
    })();
  } finally { target.pragma('foreign_keys = ON'); }
}

/** 父记录因约束被跳过后，递归跳过外键未闭合的子记录。 */
function skipRowsWithMissingParents(target: SqliteDb, workspaceId: string, state: WorkspaceCopyState,
  recordSkipped: (entry: MigrationSkippedRecord) => void): void {
  while (true) {
    const violations = target.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | null }>;
    if (!violations.length) return;
    let removed = 0;
    for (const violation of violations) {
      if (!WORKSPACE_TABLES.includes(violation.table) || !Number.isSafeInteger(violation.rowid)) fail('MIGRATION_FOREIGN_KEY_ROW_UNIDENTIFIABLE');
      const row = target.prepare(`SELECT * FROM ${quote(violation.table)} WHERE rowid=?`).get(violation.rowid!) as Row | undefined;
      if (!row) fail('MIGRATION_FOREIGN_KEY_ROW_UNIDENTIFIABLE');
      const result = target.prepare(`DELETE FROM ${quote(violation.table)} WHERE rowid=?`).run(violation.rowid!);
      if (Number(result.changes ?? 0) !== 1) fail('MIGRATION_FOREIGN_KEY_ROW_UNIDENTIFIABLE');
      if (violation.table === 'scheduled_task_configs' && typeof row.id === 'string') state.skippedLocalTaskIds.add(row.id);
      recordSkipped({ workspaceId, table: violation.table, recordId: migrationRecordId(target, violation.table, row, Number(violation.rowid)),
        reason: 'parent_record_skipped', rootCauseCode: 'MIGRATION_PARENT_RECORD_SKIPPED' });
      removed++;
    }
    if (!removed) fail('MIGRATION_FOREIGN_KEY_ROW_UNIDENTIFIABLE');
  }
}

/** 集中库按已有实体键关联；无 FK 的业务表在这里明确归属，禁止扫表后默认丢弃。 */
function workspacePredicate(db: SqliteDb, table: string, id: string): string | null {
  const literal = sqlString(id), cols = columns(db, table);
  if (table === 'scheduled_task_runtime_states') {
    const accountKeys = (db.prepare('SELECT * FROM scheduled_task_account_configs WHERE workspace_id=?').all(id) as Row[])
      .map(row => sqlString(scheduledTaskAccountRuntimeKey(row.task_id, { serverOrigin: row.server_origin, ownerUserId: row.owner_user_id, clientId: row.client_id, deviceId: row.device_id })));
    return `task_id IN (SELECT '__local_scheduled_task__:' || id FROM scheduled_task_configs WHERE workspace_scope_id=${literal})${accountKeys.length ? ` OR task_id IN (${accountKeys.join(',')})` : ''}`;
  }
  if (table === 'workspace_execution_profiles') return `(scope_type='local_workspace' AND scope_id=${literal})
    OR (scope_type='shared_workspace' AND scope_id IN (SELECT shared_workspace_id FROM threads WHERE workspace_id=${literal}
      UNION SELECT shared_workspace_id FROM thread_groups WHERE workspace_id=${literal}))`;
  if (table === 'scheduled_task_configs') return `workspace_scope_type='local_workspace' AND workspace_scope_id=${literal}`;
  if (cols.includes('workspace_id')) return `workspace_id=${literal}`;
  const threads = `SELECT id FROM threads WHERE workspace_id=${literal}`;
  if (table === 'file_blobs') return `blob_id IN (
    SELECT before_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT after_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT accepted_blob_id FROM turn_file_changes WHERE thread_id IN (${threads}) UNION
    SELECT blob_id FROM thread_draft_attachments WHERE thread_id IN (${threads}) UNION
    SELECT a.blob_id FROM thread_message_queue_attachments a JOIN thread_message_queue q ON q.id=a.queue_item_id WHERE q.thread_id IN (${threads}))`;
  if (table === 'thread_message_queue_attachments') return `queue_item_id IN (SELECT id FROM thread_message_queue WHERE workspace_id=${literal})`;
  if (table === 'chat_workflow_actions') return `task_id IN (SELECT id FROM chat_workflow_tasks WHERE workspace_id=${literal})`;
  if (cols.includes('instance_id')) return `instance_id IN (SELECT id FROM orch_instances WHERE workspace_id=${literal})`;
  if (cols.includes('artifact_id')) return `artifact_id IN (SELECT id FROM orch_artifacts WHERE instance_id IN (SELECT id FROM orch_instances WHERE workspace_id=${literal}))`;
  if (cols.includes('session_id')) return `session_id IN (SELECT id FROM orch_requirement_analysis_sessions WHERE workspace_id=${literal})`;
  if (cols.includes('job_id')) return `job_id IN (SELECT id FROM orch_asset_generation_jobs WHERE workspace_id=${literal})`;
  if (cols.includes('skill_id')) return `skill_id IN (SELECT id FROM orch_skills WHERE workspace_id=${literal})`;
  if (cols.includes('snapshot_id')) return `snapshot_id IN (SELECT id FROM controlled_experiment_snapshots WHERE workspace_id=${literal})`;
  if (cols.includes('thread_id')) return `thread_id IN (${threads})`;
  return null;
}

/** 已跳过配置的调度状态没有可验证的父配置，随父记录一起跳过。 */
function skippedScheduledTaskParent(target: SqliteDb, taskId: unknown, state: WorkspaceCopyState): boolean {
  if (typeof taskId !== 'string') return false;
  const localPrefix = '__local_scheduled_task__:', accountPrefix = '__account_scheduled_task__:';
  if (taskId.startsWith(localPrefix) && state.skippedLocalTaskIds.has(taskId.slice(localPrefix.length))) {
    return !target.prepare('SELECT 1 FROM scheduled_task_configs WHERE id=?').get(taskId.slice(localPrefix.length));
  }
  if (taskId.startsWith(accountPrefix) && state.skippedAccountRuntimeKeys.has(taskId)) {
    const ownerAndTask = JSON.parse(taskId.slice(accountPrefix.length)) as unknown[];
    if (ownerAndTask.length !== 5 || ownerAndTask.some(value => typeof value !== 'string')) return false;
    const exists = target.prepare(`SELECT 1 FROM scheduled_task_account_configs WHERE
      server_origin=? AND owner_user_id=? AND client_id=? AND device_id=? AND task_id=?`).get(...ownerAndTask);
    return !exists;
  }
  return false;
}

/** 诊断只保留稳定主键；自由文本主键改用表内扫描序号避免泄漏正文。 */
function migrationRecordId(db: SqliteDb, table: string, row: Row, rowIndex: number): string {
  const keys = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string; pk: number }>)
    .filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk);
  const values = keys.map(column => row[column.name]);
  const value = values.length === 1 ? String(values[0]) : JSON.stringify(values);
  return value && value.length <= 256 && /^[A-Za-z0-9_:.\/-]+$/.test(value) ? value : `row:${rowIndex}`;
}

/** 移出的工作区事实只留在 W；个人资产和应用定时历史仍由现有应用库拥有。 */
function cleanApplicationWorkspaceRows(db: SqliteDb, mapping: Map<string, string>, report: ConversionReport): void {
  const selected = new Map<string, Row[]>();
  for (const table of WORKSPACE_TABLES) {
    if (!hasTable(db, table)) continue;
    const conditions = [...mapping.values()].map(id => workspacePredicate(db, table, id)).filter(Boolean);
    if (conditions.length) selected.set(table, db.prepare(`SELECT rowid AS migration_rowid FROM ${quote(table)} WHERE ${conditions.map(value => `(${value})`).join(' OR ')}`).all() as Row[]);
  }
  db.pragma('foreign_keys = OFF');
  try { db.transaction(() => {
    for (const [table, rows] of selected) {
      report('application_cleanup', table);
      const statement = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid=?`);
      for (const row of rows) statement.run(row.migration_rowid);
    }
    for (const table of CACHE_TABLES) db.prepare("DELETE FROM " + quote(table)).run();
  })(); } finally { db.pragma('foreign_keys = ON'); }
}

/** 结构化 ID 字段才改写；原始 trace、提示词和自由正文保留原字节语义。 */
async function rewriteBusinessReferences(db: SqliteDb, mapping: Map<string, string>, report: ConversionReport,
  dependencies: LegacyClientMigrationDependencies): Promise<void> {
  for (const table of listTables(db)) {
    if (CACHE_TABLES.includes(table) || table.endsWith('_fts') || table.includes('_fts_')) continue;
    const jsonColumns = columns(db, table).filter(column => column.endsWith('_json'));
    if (!jsonColumns.length) continue;
    report('rewrite_references', table);
    const digestColumn = table === 'orch_node_attempts' ? 'submission_hash' : table === 'code_attribution_outbox' ? 'content_sha256' : null;
    const select = db.prepare("SELECT rowid AS migration_rowid, " + [...jsonColumns, ...(digestColumn ? [digestColumn] : [])].map(quote).join(',')
      + " FROM " + quote(table) + " WHERE rowid > ? ORDER BY rowid LIMIT ?");
    let cursor = 0, processed = 0;
    while (true) {
      checkpoint(dependencies);
      const rows = select.all(cursor, 1_024) as Row[];
      if (!rows.length) break;
      for (const row of rows) {
        for (const column of jsonColumns) {
          const raw = row[column]; if (raw === null || raw === undefined || raw === '') continue;
          let value: any; try { value = JSON.parse(raw); } catch (error) { throw migrationError('SOURCE_JSON_INVALID', error); }
          if (table === 'orch_node_attempts' && column === 'submission_json'
            && hashOrchNodeAttemptSubmission(value).submissionHash !== row.submission_hash) fail('SOURCE_SUBMISSION_HASH_INVALID');
          if (table === 'code_attribution_outbox' && column === 'payload_json') {
            serializeCodeAttributionOutboxPayload(value);
            if (sha256(raw) !== row.content_sha256) fail('SOURCE_ATTRIBUTION_HASH_INVALID');
          }
          if (table === 'raw_engine_events') {
            if (value && mapping.has(value.workspaceId)) value.workspaceId = mapping.get(value.workspaceId);
          } else {
            rewriteJson(value, mapping);
            rewriteLocalOrchestrationScope(table, column, value, mapping);
          }
          const changed = JSON.stringify(value);
          if (changed !== JSON.stringify(JSON.parse(raw))) {
            if (table === 'controlled_experiment_snapshots') fail('SOURCE_HASHED_REFERENCE_UNSUPPORTED');
            if (table === 'orch_node_attempts' && column === 'submission_json') {
              const hashed = hashOrchNodeAttemptSubmission(value);
              db.prepare('UPDATE orch_node_attempts SET submission_json=?,submission_hash=? WHERE rowid=?').run(hashed.submissionJson, hashed.submissionHash, row.migration_rowid);
            } else if (table === 'code_attribution_outbox' && column === 'payload_json') {
              const serialized = serializeCodeAttributionOutboxPayload(value);
              db.prepare('UPDATE code_attribution_outbox SET payload_json=?,content_sha256=? WHERE rowid=?').run(serialized, sha256(serialized), row.migration_rowid);
            } else db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`).run(changed, row.migration_rowid);
          }
        }
        cursor = row.migration_rowid;
        processed++;
      }
      report('rewrite_references', table, processed);
      await yieldLoop();
    }
    report('rewrite_references', table, processed);
  }
  for (const [oldId, newId] of mapping) {
    if (hasTable(db, 'scheduled_task_configs')) db.prepare('UPDATE scheduled_task_configs SET workspace_scope_id=? WHERE workspace_scope_id=?').run(newId, oldId);
    if (hasTable(db, 'workspace_execution_profiles')) db.prepare("UPDATE workspace_execution_profiles SET scope_id=? WHERE scope_type='local_workspace' AND scope_id=?").run(newId, oldId);
  }
}

/** 只按编排持久化字段改写本机范围；共享范围和自由业务 JSON 中的 scopeId 保持原值。 */
function rewriteLocalOrchestrationScope(table: string, column: string, value: any, mapping: Map<string, string>): void {
  let scope;
  if (table === 'orch_instances' && column === 'runtime_config_json') scope = value?.executionProfileScope;
  else if (table === 'orch_instances' && column === 'intake_snapshot_json' || table === 'orch_intakes' && column === 'intake_json') scope = value?.workspaceScope;
  else if (table === 'orch_proposals' && column === 'proposal_json') scope = value?.intakeSnapshot?.workspaceScope;
  else if (table === 'orch_requirement_analysis_sessions' && column === 'workspace_scope_json') scope = value;
  if (scope?.scopeType === 'local_workspace' && mapping.has(scope.scopeId)) scope.scopeId = mapping.get(scope.scopeId);
}

/** 仅递归已声明的业务 ID 键及 ID 数组，不替换文本内容或原始协议载荷。 */
function rewriteJson(value: any, mapping: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, current] of Object.entries(value)) {
    if (REFERENCE_KEYS.has(key) && typeof current === 'string') {
      if (mapping.has(current)) value[key] = mapping.get(current);
      else if ([...mapping.keys()].some(id => id.includes(':') && current.startsWith(id.slice(0, id.indexOf(':') + 1)))) fail('SOURCE_REFERENCE_INVALID');
    }
    else if (key === 'workspaceIds' && Array.isArray(current)) value[key] = current.map(id => typeof id === 'string' ? mapping.get(id) ?? id : id);
    else if (!['raw', 'rawEvent', 'prompt', 'text', 'content'].includes(key)) rewriteJson(current, mapping);
  }
}

/** 执行入口暂停并沿原仓储收口未完成启动；卡片状态与 JSON 保持一致，不重跑成功事实。 */
function pauseExecution(db: SqliteDb, input: Input, workspaceId: string | null): void {
  removeRemoteMetadata(db, workspaceId !== null);
  const now = Date.now();
  const queue = new ThreadQueueStateRepo(db);
  for (const row of db.prepare('SELECT id,workspace_id FROM threads').all() as Row[]) queue.pause(row.id as ThreadId, row.workspace_id as WorkspaceId, 'user_pause');
  db.prepare("UPDATE thread_turns SET status='error', ended_at=? WHERE status='started' AND ended_at IS NULL").run(now);
  db.prepare("UPDATE thread_message_queue SET status='failed',failure_code='LEGACY_MIGRATION_SEND_INTERRUPTED',failure_reason='迁移前发送结果未确认，请核对历史后处理',updated_at=? WHERE status='sending'").run(now);
  const summaries = new OrchInstanceSummaryProjectionReader(db);
  const instances = new OrchInstanceRepo(db, new OrchIntakeListStateRepo(db, summaries), summaries);
  for (const row of db.prepare("SELECT id FROM orch_instances WHERE status IN ('pending','running','waiting-start','waiting-approval','waiting-feedback')").all() as Row[]) instances.updateStatus(row.id as OrchestrationId, 'paused');
  db.prepare("UPDATE orch_asset_generation_jobs SET status='failed',failure_json=?,updated_at=? WHERE status IN ('queued','planning','collecting_context','generating','validating')")
    .run(JSON.stringify({ code: 'LEGACY_MIGRATION_PAUSED', message: '迁移后需人工恢复' }), now);
  new ChatWorkflowRepo(db).recoverStarts();
  db.prepare("UPDATE chat_workflow_actions SET state='interrupted',updated_at=? WHERE state='processing'").run(now);
  db.prepare("UPDATE scheduled_task_configs SET enabled=0,client_id=?,device_id=?").run(input.targetClientId, input.targetDeviceId);
  db.prepare("UPDATE scheduled_task_runs SET client_id=?,device_id=? WHERE source='local'").run(input.targetClientId, input.targetDeviceId);
  db.prepare("UPDATE scheduled_task_runs SET status='failed',finished_at=?,duration_ms=CASE WHEN started_at IS NULL THEN NULL ELSE MAX(0,?-started_at) END,error_message='LEGACY_MIGRATION_PAUSED' WHERE status='running'").run(now, now);
  db.prepare("UPDATE scheduled_task_runtime_states SET running_run_id=NULL,queued_scheduled_at=NULL,queued_reason=NULL,queued_operation_id=NULL,client_id=?,device_id=? WHERE task_id LIKE '__local_scheduled_task__:%'").run(input.targetClientId, input.targetDeviceId);
  for (const table of ['code_attribution_outbox', 'code_attribution_retention_tasks']) {
    db.prepare(`UPDATE ${quote(table)} SET status='failed',available_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code='LEGACY_MIGRATION_PAUSED'`).run(Number.MAX_SAFE_INTEGER);
  }
  db.prepare('UPDATE code_attribution_outbox SET association_expires_at=0').run();
  db.prepare("UPDATE controlled_experiment_runs SET status='cancelled',completed_at=?,error_code='LEGACY_MIGRATION_PAUSED',status_version=status_version+1 WHERE status IN ('dispatched','running','cancel_requested')").run(now);
}

/** 核对信封及正文引用；产物沿工作区真实路径解析，越界或摘要损坏均阻断发布。 */
async function verifyWorkspace(db: SqliteDb, id: string, workspacePath: string, report: ConversionReport,
  dependencies: LegacyClientMigrationDependencies): Promise<void> {
  assertWorkspaceOwnership(db, id);
  report('workflow_instances', 'orch_instances');
  let instanceCount = 0;
  for (const row of db.prepare(`SELECT id,workspace_id,intake_snapshot_json,runtime_config_json,node_states_json
    FROM orch_instances WHERE workspace_id=? ORDER BY id`).iterate(id) as IterableIterator<Row>) {
    checkpoint(dependencies);
    readStrictInstanceScope(row);
    if (++instanceCount % 256 === 0) { report('workflow_instances', 'orch_instances', instanceCount); await yieldLoop(); }
  }
  report('workflow_instances', 'orch_instances', instanceCount);
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM conversation_events) AS canonical, (SELECT COUNT(*) FROM raw_engine_events) AS raw").get() as
    { canonical: number; raw: number };
  const blobs = new FileBlobRepo(db);
  const threads = (db.prepare('SELECT id FROM threads').all() as Row[]).map(row => row.id as ThreadId);
  const canonical = new ConversationEventRepo(db);
  const raw = new RawEngineEventRepo(db);
  let projectedTotal = 0, checkedRawCount = 0;
  for (const [threadIndex, threadId] of threads.entries()) {
    let projected = 0;
    try { await canonical.ensurePresentation(threadId, {
      /** 同一次 reducer 事件读取中校验列与父会话，避免再全表解析 canonical JSON。 */
      validateEvent(event) {
        if (event.schema !== 1 || event.workspaceId !== id || event.threadId !== threadId || event.seq <= 0
          || !['codex', 'claude'].includes(event.engine) || !Number.isSafeInteger(event.ts) || event.ts < 0
          || typeof event.type !== 'string' || !event.type.trim() || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
          throw migrationError('SOURCE_CANONICAL_EVENT_INVALID', undefined, { phase: 'presentation', table: 'conversation_events',
            workspaceId: id, threadId, reason: 'event_envelope' });
        }
        projected++;
        if (projected % 1_024 === 0) report('presentation', 'conversation_events', projected, threadId, threadIndex + 1, threads.length);
      },
      /** 沿仓储原有 256 条事务边界汇报进度，异常仍保留统一 canonical 错误码。 */
      async withDatabase<T>(operation: () => T): Promise<T> {
        checkpoint(dependencies);
        let result: T;
        try { result = operation(); }
        catch (error) { throw migrationError('SOURCE_CANONICAL_EVENT_INVALID', error); }
        if (projected === 0 || projected % 1_024 === 0) report('presentation', 'conversation_events', projected, threadId, threadIndex + 1, threads.length);
        return result;
      },
    }); }
    catch (error) { if ((error as { code?: unknown })?.code === 'SOURCE_CANONICAL_EVENT_INVALID') throw error; throw migrationError('SOURCE_CANONICAL_EVENT_INVALID', error); }
    report('presentation', 'conversation_events', projected, threadId, threadIndex + 1, threads.length);
    projectedTotal += projected;
    if (projectedTotal > counts.canonical) fail('SOURCE_EVENT_COUNT_CHANGED');
    let beforeSeq: number | null = null;
    let processed = 0;
    do {
      report('raw_events', 'raw_engine_events', processed, threadId, threadIndex + 1, threads.length);
      let page;
      try { page = raw.pageByThread(threadId, { beforeSeq, limit: 2_000 }); }
      catch (error) { throw migrationError('SOURCE_RAW_EVENT_INVALID', error); }
      beforeSeq = page.events.length ? page.nextBeforeSeq : null;
      processed += page.events.length;
      checkedRawCount += page.events.length;
      report('raw_events', 'raw_engine_events', processed, threadId, threadIndex + 1, threads.length);
      await yieldLoop();
    } while (beforeSeq !== null);
  }
  if (projectedTotal !== counts.canonical || checkedRawCount !== counts.raw) fail('SOURCE_EVENT_COUNT_CHANGED');
  const verifiedBlobs = await verifyAttachments(db, id, report);
  let blobProcessed = 0;
  for (const reference of blobs.collectReferencedByThreadIds(threads)) {
    if (!verifiedBlobs.has(reference.blobId)) {
      const blob = blobs.get(reference.blobId);
      if (!blob || blob.data.length !== blob.byteLen || sha256(blob.data) !== blob.blobId) {
        throw migrationError('SOURCE_BLOB_INVALID', undefined, { phase: 'blobs', workspaceId: id, table: 'file_blobs',
          blobId: reference.blobId, expectedSize: reference.byteLen,
          reason: !blob ? 'missing_blob' : blob.data.length !== blob.byteLen ? 'blob_length' : 'blob_hash',
          ...(blob ? { actualSize: blob.data.length } : {}) });
      }
      verifiedBlobs.add(reference.blobId);
    }
    if (++blobProcessed % 1_024 === 0) { report('blobs', 'file_blobs', blobProcessed); await yieldLoop(); }
  }
  report('blobs', 'file_blobs', blobProcessed);
  if (db.prepare('SELECT 1 FROM chat_workflow_actions a LEFT JOIN chat_workflow_tasks t ON t.id=a.task_id WHERE t.id IS NULL LIMIT 1').get()) fail('SOURCE_REFERENCE_INVALID');
  for (const row of db.prepare('SELECT staging_path,published_path,content_hash,size_bytes FROM orch_artifact_files').all() as Row[]) {
    const storedPath = row.published_path || row.staging_path;
    if (!storedPath) continue;
    const file = resolveWorkspaceReadPath(workspacePath, storedPath);
    assertFile(file);
    if (row.size_bytes !== null && fs.statSync(file).size !== row.size_bytes || row.content_hash && sha256File(file) !== row.content_hash) fail('SOURCE_ARTIFACT_INVALID');
  }
}

/** 对两个附件表使用同一编码规则，保留图片原始大小并拦截内容、引用和存储长度损坏。 */
async function verifyAttachments(db: SqliteDb, workspaceId: string, report: ConversionReport): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const table of ['thread_draft_attachments', 'thread_message_queue_attachments']) {
    report('attachments', table);
    const recordId = table === 'thread_draft_attachments' ? 'a.attachment_id' : 'a.id';
    const threadId = table === 'thread_draft_attachments' ? 'a.thread_id' : 'q.thread_id';
    const parent = table === 'thread_draft_attachments' ? '' : 'LEFT JOIN thread_message_queue q ON q.id=a.queue_item_id';
    const sql = 'SELECT ' + recordId + ' AS record_id,' + threadId
      + ' AS thread_id,a.kind,a.size,a.blob_id,b.byte_len,b.encoding,b.data FROM ' + table + ' a ' + parent
      + ' LEFT JOIN file_blobs b ON b.blob_id=a.blob_id';
    const rows = db.prepare(sql).iterate() as IterableIterator<Row>;
    let processed = 0, lastProgressAt = Date.now();
    for (const row of rows) {
      const context: LegacyClientMigrationContext = { phase: 'attachments', workspaceId, table,
        ...(row.record_id ? { recordId: String(row.record_id) } : {}), ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
        blobId: String(row.blob_id ?? ''), expectedSize: Number(row.size),
        ...(row.byte_len === null ? {} : { storedSize: Number(row.byte_len) }) };
      /** 每种附件损坏均保留记录键和大小上下文，不输出 blob 正文。 */
      const invalid = (reason: string, actualSize?: number): never => {
        throw migrationError('SOURCE_BLOB_INVALID', undefined, { ...context, reason,
          ...(actualSize === undefined ? {} : { actualSize }) });
      };
      if (!row.thread_id) invalid('attachment_parent_missing');
      if (row.data === null) invalid(row.blob_id === null ? 'missing_reference' : 'missing_blob');
      const data = Buffer.from(row.data);
      if (data.length !== row.byte_len) invalid('blob_length', data.length);
      if (!verified.has(row.blob_id) && sha256(data) !== row.blob_id) invalid('blob_hash', data.length);
      if (!['binary', 'utf8', 'gb18030'].includes(row.encoding)) invalid('blob_encoding', data.length);
      if (row.encoding === 'utf8' && !isUtf8(data)) invalid('invalid_utf8', data.length);
      let actualSize = data.length;
      if (row.kind === 'image' && row.encoding === 'utf8') {
        const dataUrl = data.toString('utf8'), comma = dataUrl.indexOf(',');
        const header = dataUrl.slice(5, comma);
        if (!dataUrl.startsWith('data:') || comma < 0 || !(header === ';base64' || /.+;base64$/i.test(header))) invalid('invalid_data_url');
        const encoded = dataUrl.slice(comma + 1).trim();
        if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid('invalid_base64');
        const decoded = Buffer.from(encoded, 'base64'), canonical = decoded.toString('base64');
        if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) invalid('invalid_base64');
        actualSize = decoded.length;
      }
      const size = Number(row.size);
      const legacyTextFile = row.encoding === 'utf8' && ['file', 'text-file'].includes(String(row.kind));
      // Text extraction keeps source-file size, which may exceed UTF-8 extracted text bytes.
      const imageDataUrl = row.kind === 'image' && row.encoding === 'utf8';
      const matches = Number.isSafeInteger(size) && size >= 0 && (imageDataUrl ? size === actualSize
        : size === data.length || legacyTextFile && size >= data.length);
      if (!matches) invalid('attachment_size', actualSize);
      verified.add(row.blob_id);
      processed++;
      if (processed % 1_024 === 0 || Date.now() - lastProgressAt >= 1_000) {
        report('attachments', table, processed);
        lastProgressAt = Date.now();
        await yieldLoop();
      }
    }
    report('attachments', table, processed);
  }
  return verified;
}

/** 远端投递/权限缓存不授予新身份；工作区仅保留已知本地 schema 与提交下界。 */
function removeRemoteMetadata(db: SqliteDb, workspace: boolean): void {
  db.prepare(`UPDATE orch_instances SET asset_runtime_snapshot_json=json_remove(asset_runtime_snapshot_json,'$.executionAuthorization')
    WHERE asset_runtime_snapshot_json IS NOT NULL AND json_type(asset_runtime_snapshot_json,'$.executionAuthorization') IS NOT NULL`).run();
  for (const row of db.prepare('SELECT key FROM meta').all() as Array<{ key: string }>) {
    if (row.key.startsWith('conversation_relay:') || /^(?:last_acked_|last_ack_|raw_event_ack|conversation_event_ack|shared_lease:|shared_auth:|asset_cache:)/.test(row.key)
      || workspace && ['client_id', 'event_seq'].includes(row.key)) db.prepare('DELETE FROM meta WHERE key=?').run(row.key);
  }
}

/** 冻结快照后分库搬迁或出现另一套库时中止，避免发布到 Client 不会使用的位置。 */
function assertWorkspacePublishLocation(journal: Journal, file: PublishedFile): void {
  if (path.basename(file.target) !== 'workspace.db') return;
  const directory = path.dirname(file.target);
  const workspacePath = path.dirname(directory);
  const alternate = path.basename(directory) === WORKSPACE_CODEFLOWAI_DIRECTORY ? WORKSPACE_RUNTIME_DIRECTORY : WORKSPACE_CODEFLOWAI_DIRECTORY;
  const alternateDb = path.join(workspacePath, alternate, 'workspace.db');
  if (['', ...SIDECARS].some(suffix => exists(`${alternateDb}${suffix}`))
    || file.originalSha256 !== null && !exists(file.target)) {
    const workspaceId = journal.source.workspaces.find(work => samePath(work.path, workspacePath))?.id;
    fail('TARGET_CONFLICT', { workspaceId, reason: 'workspace_database_location_changed' });
  }
}

/** 发布前复核归档与原目标；rename 后崩溃可由相同摘要认领，其他目标永不覆盖。 */
function publishFile(input: Input, journal: Journal, file: PublishedFile): void {
  assertWorkspacePublishLocation(journal, file);
  if (file.published) { if (!exists(file.target) || sha256File(file.target) !== file.sha256) fail('MIGRATION_PUBLISHED_FILE_CHANGED'); return; }
  if (!exists(file.staged) && exists(file.target) && sha256File(file.target) === file.sha256) { file.published = true; writeJournal(input, journal); return; }
  if (exists(file.target)) {
    if (file.originalSha256 === null || sha256File(file.target) !== file.originalSha256) fail('TARGET_CONFLICT');
    if (path.basename(file.target) === 'codeflowai.db' && journal.targetInitialization) {
      for (const suffix of SIDECARS) {
        const sidecar = `${file.target}${suffix}`, archived = path.join(archiveDirectory(input, journal), `original-empty-application.db${suffix}`);
        if (!exists(sidecar)) continue;
        if (!exists(archived) || sha256File(sidecar) !== sha256File(archived)) fail('TARGET_CONFLICT');
        fs.unlinkSync(sidecar);
      }
    } else if (path.basename(file.target) === 'workspace.db') {
      const index = journal.source.workspaces.findIndex(work => samePath(workspaceMigrationDestination(work).target, file.target));
      const archived = path.join(snapshotDirectory(input, journal), `source-workspace-${index}.db`);
      if (index < 0 || !exists(archived)) fail('MIGRATION_ARCHIVE_MISSING');
      withDatabase(archived, true, integrity);
      for (const suffix of SIDECARS) {
        const sidecar = `${file.target}${suffix}`;
        if (!exists(sidecar)) continue;
        assertFile(sidecar);
        const archivedSidecar = path.join(snapshotDirectory(input, journal), `original-workspace-${index}.db${suffix}`);
        if (!exists(archivedSidecar) || sha256File(sidecar) !== sha256File(archivedSidecar)) fail('SOURCE_SIDECAR_CHANGED');
        fs.unlinkSync(sidecar);
      }
    }
  }
  fs.renameSync(file.staged, file.target); syncFile(file.target); syncDirectory(path.dirname(file.target));
  file.published = true; writeJournal(input, journal);
}

/** 核验完成库的稳定事实；正常启动允许修复旧工作流引用，维护入口仍只读核验。 */
function validateCompleted(input: Input, journal: Journal, repairWorkflowScopes = false): void {
  const config = readObject(path.join(input.dataDir, 'config.json'));
  if (config.clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const meta = readObject(path.join(input.dataDir, 'codeflowai.db.meta.json'));
  if (meta.schemaVersion !== 3 || meta.ownership !== 'local_os_user' || meta.initializationState !== 'ready') fail('TARGET_META_CONFLICT');
  withDatabase(path.join(input.dataDir, 'codeflowai.db'), true, db => {
    if (metaValue(db, 'client_id') !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
    const version = Number(db.pragma('user_version', { simple: true }));
    if (db.pragma('application_id', { simple: true }) !== 0 || !Number.isInteger(version) || version < 83 || version > CLIENT_DB_SCHEMA_VERSION) fail('TARGET_SCHEMA_UNSUPPORTED');
    integrity(db);
  });
  if (repairWorkflowScopes) repairCompletedWorkflowScopes(input, journal);
}

/** 完成库只修复能从原workspace映射唯一确定的本机Profile引用，并先保存可回放备份。 */
function repairCompletedWorkflowScopes(input: Input, journal: Journal): void {
  const mapping = new Map(journal.source.workspaces.map(work => [work.id, mappedWorkspaceId(work.id, journal.source.sourceClientId, input.targetClientId)]));
  const applicationDb = path.join(input.dataDir, 'codeflowai.db');
  const migratedIds = new Set(mapping.values());
  /** 用当前注册定位迁移库，优先选 Client 实际读取的目录，兼容首次启动前的旧位置。 */
  const findTargets = () => withDatabase(applicationDb, true, db => new WorkspaceRepo(db).list({ includeDeleted: true }).flatMap(work => {
    if (!migratedIds.has(work.id)) return [];
    for (const directory of [WORKSPACE_CODEFLOWAI_DIRECTORY, WORKSPACE_RUNTIME_DIRECTORY]) {
      const dbPath = path.join(work.path, directory, 'workspace.db');
      if (!exists(dbPath)) continue;
      assertFile(dbPath);
      return [{ workspaceId: work.id, dbPath }];
    }
    return [];
  }));
  if (!collectWorkflowScopeRepairs(findTargets(), mapping).length) return;

  const locks: ClientProcessLock[] = [];
  let failure: unknown;
  try {
    locks.push(acquireClientProcessLock({ dbPath: applicationDb, clientId: input.targetClientId }));
    const targets = findTargets();
    for (const target of targets) locks.push(acquireClientProcessLock({ dbPath: target.dbPath, clientId: input.targetClientId }));
    const current = collectWorkflowScopeRepairs(targets, mapping);
    if (!current.length) return;
    const archive = archiveDirectory(input, journal), archiveRoot = path.dirname(archive);
    if (exists(archiveRoot)) assertDirectory(archiveRoot); else { fs.mkdirSync(archiveRoot); assertDirectory(archiveRoot); }
    if (exists(archive)) assertDirectory(archive); else { fs.mkdirSync(archive); assertDirectory(archive); }
    const backupPath = path.join(archive, WORKFLOW_SCOPE_REPAIR);
    const backup = exists(backupPath) ? validateWorkflowScopeRepairBackup(readObject(backupPath), journal, mapping).fixes : [];
    const saved = new Set(backup.map(repairFixKey));
    const additions = current.filter(fix => !saved.has(repairFixKey(fix)));
    if (additions.length) writeAtomic(backupPath, { schemaVersion: 1, migrationId: journal.migrationId, fixes: [...backup, ...additions] });

    for (const target of targets) {
      const fixes = current.filter(fix => fix.workspaceId === target.workspaceId);
      if (!fixes.length) continue;
      withDatabase(target.dbPath, false, db => {
        db.transaction(() => {
          const select = db.prepare('SELECT id,workspace_id,intake_snapshot_json,runtime_config_json,node_states_json FROM orch_instances WHERE id=?');
          const update = db.prepare('UPDATE orch_instances SET runtime_config_json=? WHERE id=? AND workspace_id=? AND runtime_config_json=?');
          for (const fix of fixes) {
            const row = select.get(fix.instanceId) as Row | undefined;
            if (!row) fail('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT');
            if (row.workspace_id !== fix.workspaceId || typeof row.runtime_config_json !== 'string') fail('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT');
            let runtimeConfig: any;
            try { runtimeConfig = JSON.parse(row.runtime_config_json); } catch (error) { throw migrationError('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT', error); }
            const scope = runtimeConfig?.executionProfileScope;
            if (!scope || scope.scopeType !== 'local_workspace') fail('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT');
            if (scope.scopeId !== fix.previousScopeId || mapping.get(fix.previousScopeId) !== fix.workspaceId) fail('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT');
            scope.scopeId = fix.workspaceId;
            const changed = JSON.stringify(runtimeConfig);
            readStrictInstanceScope({ ...row, runtime_config_json: changed });
            if (update.run(changed, fix.instanceId, fix.workspaceId, row.runtime_config_json).changes !== 1) fail('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT');
          }
          integrity(db);
        })();
      });
      syncFile(target.dbPath);
    }
  } catch (error) { failure = error; throw error; }
  finally {
    const releaseErrors: unknown[] = [];
    for (const lock of locks.reverse()) { try { lock.release(); } catch (error) { releaseErrors.push(error); } }
    if (releaseErrors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...releaseErrors],
      'MIGRATION_WORKFLOW_SCOPE_REPAIR_LOCK_RELEASE_FAILED', { cause: failure });
  }
}

/** 只预检旧迁移涉及的本机范围不一致，其他工作流归正常读取边界校验。 */
function collectWorkflowScopeRepairs(targets: Array<{ workspaceId: string; dbPath: string }>, mapping: Map<string, string>): WorkflowScopeRepairFix[] {
  const fixes: WorkflowScopeRepairFix[] = [];
  for (const target of targets) withDatabase(target.dbPath, true, db => {
    if (!hasTable(db, 'orch_instances')) return;
    for (const row of db.prepare(`SELECT id,workspace_id,intake_snapshot_json,runtime_config_json,node_states_json
      FROM orch_instances WHERE workspace_id=? AND CASE WHEN json_valid(runtime_config_json) THEN
        json_extract(runtime_config_json,'$.executionProfileScope.scopeType')='local_workspace'
        AND json_extract(runtime_config_json,'$.executionProfileScope.scopeId')<>workspace_id END ORDER BY id`)
      .iterate(target.workspaceId) as IterableIterator<Row>) {
      try { readStrictInstanceScope(row); }
      catch (error) {
        if (!(error instanceof OrchInstanceScopeError) || error.details.field !== 'runtime_config_json.executionProfileScope'
          || error.details.reason !== 'local_profile_workspace_mismatch') throw error;
        let runtimeConfig: any;
        try { runtimeConfig = JSON.parse(row.runtime_config_json); } catch (parseError) { throw migrationError('MIGRATION_WORKFLOW_SCOPE_REPAIR_CONFLICT', parseError); }
        const profileScope = runtimeConfig.executionProfileScope, previousScopeId = profileScope.scopeId;
        if (mapping.get(previousScopeId) !== target.workspaceId) throw error;
        profileScope.scopeId = target.workspaceId;
        readStrictInstanceScope({ ...row, runtime_config_json: JSON.stringify(runtimeConfig) });
        fixes.push({ workspaceId: target.workspaceId, instanceId: String(row.id), previousScopeId });
      }
    }
  });
  return fixes.sort((left, right) => repairFixKey(left).localeCompare(repairFixKey(right)));
}

/** 已存在的修复备份只接受本迁移生成的固定、无正文记录。 */
function validateWorkflowScopeRepairBackup(value: unknown, journal: Journal,
  mapping?: Map<string, string>): WorkflowScopeRepairBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_WORKFLOW_SCOPE_BACKUP_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== 'fixes|migrationId|schemaVersion' || record.schemaVersion !== 1
    || record.migrationId !== journal.migrationId || !Array.isArray(record.fixes)) fail('MIGRATION_WORKFLOW_SCOPE_BACKUP_INVALID');
  const workspaceMapping = mapping ?? new Map(journal.source.workspaces.map(work =>
    [work.id, mappedWorkspaceId(work.id, journal.source.sourceClientId, journal.targetClientId)]));
  const seen = new Set<string>();
  const fixes = record.fixes.map((value): WorkflowScopeRepairFix => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_WORKFLOW_SCOPE_BACKUP_INVALID');
    const fix = value as Record<string, unknown>;
    if (Object.keys(fix).sort().join('|') !== 'instanceId|previousScopeId|workspaceId' || typeof fix.workspaceId !== 'string'
      || typeof fix.instanceId !== 'string' || !fix.instanceId || typeof fix.previousScopeId !== 'string'
      || workspaceMapping.get(fix.previousScopeId) !== fix.workspaceId) fail('MIGRATION_WORKFLOW_SCOPE_BACKUP_INVALID');
    const result = { workspaceId: fix.workspaceId, instanceId: fix.instanceId, previousScopeId: fix.previousScopeId };
    const key = repairFixKey(result);
    if (seen.has(key)) fail('MIGRATION_WORKFLOW_SCOPE_BACKUP_INVALID');
    seen.add(key);
    return result;
  });
  return { schemaVersion: 1, migrationId: journal.migrationId, fixes };
}

/** 固定组合键用于备份幂等比对，不依赖不可信分隔符。 */
function repairFixKey(fix: WorkflowScopeRepairFix): string { return JSON.stringify([fix.workspaceId, fix.instanceId, fix.previousScopeId]); }

/** 跳过清单只允许固定业务键和原因码，不保存异常正文或记录内容。 */
function validateMigrationSkipReport(value: unknown, journal: Journal): MigrationSkipReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_SKIP_REPORT_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== 'migrationId|schemaVersion|skipped' || record.schemaVersion !== 1
    || record.migrationId !== journal.migrationId || !Array.isArray(record.skipped)) fail('MIGRATION_SKIP_REPORT_INVALID');
  const workspaces = new Set(journal.source.workspaces.map(work =>
    mappedWorkspaceId(work.id, journal.source.sourceClientId, journal.targetClientId)));
  const seen = new Set<string>();
  const skipped = record.skipped.map((value): MigrationSkippedRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_SKIP_REPORT_INVALID');
    const entry = value as Record<string, unknown>;
    if (typeof entry.workspaceId !== 'string' || !workspaces.has(entry.workspaceId)
      || typeof entry.table !== 'string' || !WORKSPACE_TABLES.includes(entry.table)
      || typeof entry.recordId !== 'string' || !entry.recordId || entry.recordId.length > 256
      || entry.reason !== 'constraint' && entry.reason !== 'parent_record_skipped'
      || entry.reason === 'constraint' && entry.rootCauseCode !== 'SQLITE_CONSTRAINT_IGNORED'
      || entry.reason === 'parent_record_skipped' && entry.rootCauseCode !== 'MIGRATION_PARENT_RECORD_SKIPPED'
      || Object.keys(entry).sort().join('|') !== 'reason|recordId|rootCauseCode|table|workspaceId') fail('MIGRATION_SKIP_REPORT_INVALID');
    const result = entry as MigrationSkippedRecord, key = JSON.stringify(result);
    if (seen.has(key)) fail('MIGRATION_SKIP_REPORT_INVALID');
    seen.add(key);
    return result;
  });
  return { schemaVersion: 1, migrationId: journal.migrationId, skipped };
}

/** 完成响应的凭据只从原配置即时读取，绝不进入迁移记录。 */
async function journalResult(journal: Journal, dependencies: LegacyClientMigrationDependencies): Promise<LegacyClientMigrationResult> {
  const result: LegacyClientMigrationResult = { candidateId: journal.candidateId, workspaceCount: journal.source.workspaces.length,
    migrationId: journal.migrationId, completed: true };
  try {
    const config = readSourceConfig(journal.source.configPath);
    if (config.clientId !== journal.source.sourceClientId || config.serverWs !== journal.source.serverWs
      || await (dependencies.resolveNamespace ?? resolveNamespace)(config) !== journal.source.accountNamespace) fail('SOURCE_ACCOUNT_CHANGED');
    result.accountSource = { sourceClientId: config.clientId, apiKey: config.apiKey, serverWs: config.serverWs };
  } catch (error) {
    // 已确认仅账号恢复允许失败；本地完成仍放行，由宿主显示失败并提供账号重试/正常登录。
    process.stderr.write(`${JSON.stringify({ errorCode: 'SOURCE_ACCOUNT_SOURCE_UNAVAILABLE', requestId: journal.migrationId,
      migrationId: journal.migrationId, sourceClientId: journal.source.sourceClientId, stage: 'account_source',
      rootCause: { code: errorCode(error), type: error instanceof Error ? error.name : typeof error } })}\n`);
  }
  return result;
}

/** 普通库从已验证的历史 v83 起；未知表、列和高版本绝不借正常修复猜测。 */
function assertApplicationSource(db: SqliteDb): void {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (db.pragma('application_id', { simple: true }) !== 0 || !Number.isInteger(version) || version < 83 || version > CLIENT_DB_SCHEMA_VERSION) fail('SOURCE_SCHEMA_UNSUPPORTED');
  assertKnownTables(db);
}

/** 退役表只保留在来源快照；FTS shadow 只接受已声明虚表对应的 SQLite 内部表。 */
function assertKnownTables(db: SqliteDb): void {
  const reference = openSqliteDb(':memory:');
  try {
    migrateClientDb(reference);
    const known = new Set(listTables(reference));
    for (const table of listTables(db)) {
      if (RETIRED_TABLES.includes(table)) continue;
      if (!known.has(table)) fail('SOURCE_TABLE_UNSUPPORTED');
      const expected = columns(reference, table);
      if (columns(db, table).some(column => !expected.includes(column))) fail('SOURCE_SCHEMA_UNSUPPORTED');
    }
  } finally { reference.close(); }
}

/** 只从目标临时副本移除已确认退役的表，来源数据库及其只读归档保持完整。 */
function dropRetiredTables(db: SqliteDb): void {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
  } finally { db.pragma('foreign_keys = ON'); }
}

/** 工作区库的所有直接归属必须与注册表一致，阻止认领同路径的其他 Client 数据。 */
function assertWorkspaceOwnership(db: SqliteDb, id: string): void {
  for (const table of listTables(db)) {
    if (table.includes('_fts_')) continue;
    const names = columns(db, table);
    for (const column of ['workspace_id', 'workspace_scope_id']) {
      if (names.includes(column) && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL AND ${quote(column)}<>? LIMIT 1`).get(id)) fail('SOURCE_WORKSPACE_OWNERSHIP_CONFLICT');
    }
  }
}

/** 已提交事件及回滚/turn 引用保持同一序号空间，不使用远端 ACK 作为高水位。 */
function referenceHighWater(db: SqliteDb): number {
  let maximum = readWorkspaceEventSeqFloor(db);
  for (const [table, column] of [['thread_turns', 'start_event_seq'], ['thread_turns', 'end_event_seq'], ['thread_rollbacks', 'dropped_event_seq_gt']]) {
    const row = db.prepare(`SELECT MAX(${column}) AS maximum FROM ${table}`).get() as Row;
    if (row.maximum !== null) maximum = Math.max(maximum, validCounter(String(row.maximum)));
  }
  return maximum;
}

/** 用户可产生的业务表；系统内置资产、默认模板与实验配置不阻止迁移。 */
const WORKSPACE_USER_DATA_TABLES = new Set([
  'threads', 'thread_turns', 'turn_file_changes', 'conversation_events', 'raw_engine_events',
  'conversation_diff_snapshots', 'conversation_message_deletions', 'knowledge_conversations', 'thread_drafts',
  'thread_draft_attachments', 'thread_message_queue', 'thread_message_queue_attachments', 'thread_queue_states',
  'thread_reminder_states', 'thread_rollbacks', 'thread_state_bindings', 'file_blobs', 'thread_groups',
  'reminder_receipts', 'reminder_ignores', 'dingtalk_reminder_notifications', 'wecom_reminder_notifications',
  'code_attribution_outbox', 'code_attribution_retention_tasks', 'terminal_configs', 'workspace_execution_profiles',
  'workspace_prefs', 'scheduled_task_configs', 'scheduled_task_runs', 'scheduled_task_account_configs',
  'scheduled_task_runtime_states', 'chat_workflow_tasks', 'chat_workflow_actions', 'chat_workflow_settings',
  'orch_requirement_analysis_sessions', 'orch_requirement_analysis_messages', 'orch_requirement_candidate_drafts',
  'orch_intakes', 'orch_proposals', 'orch_intake_list_states', 'orch_instances', 'orch_instance_summaries',
  'orch_artifacts', 'orch_artifact_files', 'orch_artifact_fields', 'orch_events', 'orch_feedback_records',
  'orch_gate_evaluation_runs', 'orch_prompt_snapshots', 'orch_node_context_resolutions', 'orch_node_attempts',
  'orch_node_work_item_boards', 'orch_node_work_items', 'orch_node_work_item_events', 'orch_asset_drafts',
  'orch_asset_generation_jobs', 'orch_asset_job_events',
]);
const WORKSPACE_ASSET_DEFINITION_TABLES = ['orch_roles', 'orch_workflows', 'orch_knowledge_bundles', 'orch_skills', 'orch_toolsets'];

/** 默认工作区有用户业务或已提交事件时保护目标；系统内置资产和空分库仍允许迁移。 */
function hasDefaultWorkspaceData(input: Input): boolean {
  return [WORKSPACE_CODEFLOWAI_DIRECTORY, WORKSPACE_RUNTIME_DIRECTORY].some(directory => {
    const filename = path.join(input.dataDir, 'workspace', directory, 'workspace.db');
    if (!exists(filename)) return false;
    try {
      return withDatabase(filename, true, db => {
        assertWorkspaceDbReadOnlySchema(db);
        const floor = hasTable(db, 'meta')
          ? db.prepare("SELECT value FROM meta WHERE key='event_seq_floor'").get() as { value: string } | undefined : undefined;
        if (validCounter(floor?.value ?? '0') > 0) return true;
        for (const table of WORKSPACE_USER_DATA_TABLES) {
          if (hasTable(db, table) && db.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()) return true;
        }
        for (const table of WORKSPACE_ASSET_DEFINITION_TABLES) {
          if (hasTable(db, table) && columns(db, table).includes('kind')
            && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE kind<>'builtin' LIMIT 1`).get()) return true;
        }
        return false;
      });
    } catch (error) {
      // 默认分库损坏或结构不支持属于目标异常，统一为可检索的迁移冲突。
      throw migrationError('TARGET_CONFLICT', error, { reason: 'workspace_database_unreadable' });
    }
  });
}

/** 标记命中时核对目标身份和结构；应用库消失时检查仍在磁盘上的业务证据。 */
function targetStillInUse(input: Input): boolean {
  const configPath = path.join(input.dataDir, 'config.json');
  const config = exists(configPath) ? readObject(configPath) : null;
  if (config && config.clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const target = path.join(input.dataDir, 'codeflowai.db'), metaPath = `${target}.meta.json`;
  if (!exists(target)) {
    for (const suffix of [...SIDECARS, '.meta.json']) if (exists(`${target}${suffix}`)) fail('TARGET_CONFLICT');
    return Boolean(config?.apiKey) || hasDefaultWorkspaceData(input);
  }
  assertFile(target);
  if (!exists(metaPath) || !plainHeader(target)) fail('TARGET_CONFLICT');
  const meta = readObject(metaPath);
  if (meta.schemaVersion !== 3 || meta.ownership !== 'local_os_user' || meta.storageMode !== 'plain_sqlite' || meta.initializationState !== 'ready') fail('TARGET_CONFLICT');
  withDatabase(target, true, db => {
    if (metaValue(db, 'client_id') !== input.targetClientId || db.pragma('user_version', { simple: true }) !== CLIENT_DB_SCHEMA_VERSION) fail('TARGET_CONFLICT');
  });
  return true;
}

/** 只读分类目标库：真实损坏/身份不符仍失败，已被正常使用则返回可脱敏证据。 */
function inspectTarget(input: Input): TargetInspection {
  const configPath = path.join(input.dataDir, 'config.json');
  const config = exists(configPath) ? readObject(configPath) : null;
  if (config && config.clientId !== input.targetClientId) fail('TARGET_IDENTITY_CONFLICT');
  const target = path.join(input.dataDir, 'codeflowai.db'), metaPath = `${target}.meta.json`;
  if (!exists(target)) {
    for (const suffix of [...SIDECARS, '.meta.json']) if (exists(`${target}${suffix}`)) fail('TARGET_CONFLICT');
    if (config?.apiKey) return { state: 'in_use', evidence: { reason: 'config_api_key' } };
    if (hasDefaultWorkspaceData(input)) return { state: 'in_use', evidence: { reason: 'workspace_database' } };
    return { state: 'empty', initialization: null };
  }
  if (!exists(metaPath) || !plainHeader(target)) fail('TARGET_CONFLICT');
  const meta = readObject(metaPath);
  if (meta.schemaVersion !== 3 || meta.ownership !== 'local_os_user' || meta.storageMode !== 'plain_sqlite' || meta.initializationState !== 'ready') fail('TARGET_CONFLICT');
  const evidence = withDatabase(target, true, db => {
    if (metaValue(db, 'client_id') !== input.targetClientId || db.pragma('user_version', { simple: true }) !== CLIENT_DB_SCHEMA_VERSION) fail('TARGET_CONFLICT');
    integrity(db); assertKnownTables(db);
    for (const table of listTables(db)) {
      if (['meta', 'workspaces'].includes(table) || table.includes('_fts_')) continue;
      if (table === 'local_quick_phrase_collection') {
        // 初始化为 revision=0；用户改过集合即视为已使用，即使已删空词条。
        const revision = (db.prepare('SELECT revision FROM local_quick_phrase_collection WHERE id=1').get() as Row | undefined)?.revision;
        if (Number(revision) > 0) return { reason: 'business_data' as const, table };
        continue;
      }
      if (tableCount(db, table)) return { reason: 'business_data' as const, table };
    }
    const workspaces = new WorkspaceRepo(db).list({ includeDeleted: true });
    if (workspaces.length > 1) return { reason: 'workspaces' as const, workspaceCount: workspaces.length };
    if (workspaces.some(work => work.isDeleted)) return { reason: 'workspace_deleted' as const, workspaceCount: workspaces.length };
    if (workspaces.some(work => !samePath(work.path, path.join(input.dataDir, 'workspace')))) return { reason: 'workspace_path' as const };
    if (hasDefaultWorkspaceData(input)) return { reason: 'workspace_database' as const };
    for (const row of db.prepare('SELECT key,value FROM meta').all() as Row[]) {
      if (!['client_id', 'event_seq', 'conversation_presentation_schema_version'].includes(row.key)) return { reason: 'meta_key' as const };
      if (row.key === 'event_seq' && row.value !== '0') return { reason: 'event_seq' as const };
    }
    return config?.apiKey ? { reason: 'config_api_key' as const } : null;
  });
  return evidence ? { state: 'in_use', evidence }
    : { state: 'empty', initialization: { dbSha256: sha256File(target), metaSha256: sha256File(metaPath) } };
}

/** 迁移入口仍要求空目标；目标已被正常使用时返回可追踪的显式错误。 */
function assertEmptyTarget(input: Input): Journal['targetInitialization'] {
  const inspection = inspectTarget(input);
  if (inspection.state === 'in_use') {
    // 迁移竞态同样落标记，下一次启动不再重复探测。
    persistTargetInUseMarker(input, inspection.evidence);
    fail('TARGET_IN_USE', {
      reason: inspection.evidence.reason,
      ...(inspection.evidence.table ? { table: inspection.evidence.table } : {}),
      ...(inspection.evidence.workspaceCount === undefined ? {} : { workspaceCount: inspection.evidence.workspaceCount }),
    });
  }
  return inspection.initialization;
}

function targetInUseMarkerPath(input: Input): string {
  return path.join(input.dataDir, LEGACY_MIGRATION_DIR, TARGET_IN_USE_MARKER);
}

/** 标记只用于去重提示，不承载迁移正确性；损坏时记录并重新判定。 */
function readTargetInUseMarker(input: Input): TargetInUseMarker | null {
  const filename = targetInUseMarkerPath(input);
  try {
    if (!exists(filename)) return null;
    const value = readObject(filename);
    if (value.schemaVersion !== 1 || typeof value.targetClientId !== 'string' || !/^local_[0-9a-f-]{36}$/i.test(value.targetClientId)
      || !TARGET_IN_USE_REASONS.has(String(value.reason)) || typeof value.decidedAt !== 'string'
      || value.table !== undefined && (typeof value.table !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(value.table))
      || value.workspaceCount !== undefined && (!Number.isSafeInteger(value.workspaceCount) || value.workspaceCount < 0)) {
      logTargetInUseDiagnostic('LEGACY_MIGRATION_TARGET_IN_USE_MARKER_INVALID');
      removeTargetInUseMarker(input);
      return null;
    }
    return value as TargetInUseMarker;
  } catch (error) {
    logTargetInUseDiagnostic('LEGACY_MIGRATION_TARGET_IN_USE_MARKER_INVALID', error);
    removeTargetInUseMarker(input);
    return null;
  }
}

/** 原子写入不适用事实；失败只会导致下次重复提示，记录后继续启动。 */
function persistTargetInUseMarker(input: Input, evidence: LegacyClientMigrationTargetInUse): void {
  try {
    writeAtomic(targetInUseMarkerPath(input), {
      schemaVersion: 1, targetClientId: input.targetClientId, reason: evidence.reason,
      ...(evidence.table ? { table: evidence.table } : {}),
      ...(evidence.workspaceCount === undefined ? {} : { workspaceCount: evidence.workspaceCount }),
      decidedAt: new Date().toISOString(),
    });
  } catch (error) {
    logTargetInUseDiagnostic('LEGACY_MIGRATION_TARGET_IN_USE_MARKER_WRITE_FAILED', error);
  }
}

/** 目标重置或身份变化时移除失效标记；失败下次启动重试。 */
function removeTargetInUseMarker(input: Input): void {
  const filename = targetInUseMarkerPath(input);
  try {
    if (!exists(filename)) return;
    assertFile(filename); fs.unlinkSync(filename); syncDirectory(path.dirname(filename));
  } catch (error) {
    logTargetInUseDiagnostic('LEGACY_MIGRATION_TARGET_IN_USE_MARKER_REMOVE_FAILED', error);
  }
}

/** 标记异常只影响提示去重；保留可检索事件且不输出路径、文件内容或凭据。 */
function logTargetInUseDiagnostic(event: string, error?: unknown): void {
  process.stderr.write(`${JSON.stringify({ event, errorCode: event,
    rootCause: { type: error instanceof Error ? error.name : typeof error } })}\n`);
}

/** 接管仅限已证明没有业务的默认初始化库，原字节和sidecar先归档。 */
function archiveEmptyInitialization(input: Input, journal: Journal): void {
  if (!journal.targetInitialization || journal.files.some(file => file.published && path.basename(file.target) === 'codeflowai.db')) return;
  const root = archiveDirectory(input, journal), target = path.join(input.dataDir, 'codeflowai.db');
  if (!exists(path.join(root, 'original-empty-application.db'))) {
    if (sha256File(target) !== journal.targetInitialization.dbSha256) fail('TARGET_CONFLICT');
    for (const suffix of ['', ...SIDECARS, '.meta.json']) {
      if (!exists(`${target}${suffix}`)) continue;
      fs.copyFileSync(`${target}${suffix}`, path.join(root, `original-empty-application.db${suffix}`), fs.constants.COPYFILE_EXCL);
      syncFile(path.join(root, `original-empty-application.db${suffix}`));
    }
  }
}

/** 活跃迁移严格绑定目标；暂缓归档只绑定原任务和设备，允许正常Client生成独立身份。 */
function readJournal(input: Input): Journal | null {
  const filename = path.join(input.dataDir, JOURNAL); if (!exists(filename)) return null;
  const journal = readObject(filename) as Journal;
  if (![1, 2].includes(journal.schemaVersion) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.migrationId)
    || journal.snapshotGeneration !== null && !/^[0-9a-f-]{36}$/i.test(journal.snapshotGeneration)
    || !journal.source || !Array.isArray(journal.source.workspaces) || !Array.isArray(journal.files) || !Array.isArray(journal.snapshotHashes)
    || journal.targetClientId !== input.targetClientId && journal.deferred !== true || journal.targetDeviceId !== input.targetDeviceId
    || input.migrationId && input.migrationId !== journal.migrationId) fail('MIGRATION_JOURNAL_CONFLICT');
  if (!['quiesce', 'snapshot', 'convert', 'verify', 'publish', 'completed'].includes(journal.stage)
    || typeof journal.completed !== 'boolean' || typeof journal.converted !== 'boolean' || typeof journal.snapshotsReady !== 'boolean'
    || journal.deferred !== undefined && typeof journal.deferred !== 'boolean'
    || (journal.schemaVersion === 2) !== (journal.deferred === true)) fail('MIGRATION_JOURNAL_INVALID');
  parseLegacyClientMigrationRequest({ action: 'discover', dataDir: input.dataDir, targetClientId: journal.targetClientId, targetDeviceId: journal.targetDeviceId });
  const workspaceTargets = journal.source.workspaces.map(work => workspaceMigrationDestination(work).target);
  const targets = [path.join(input.dataDir, 'codeflowai.db'), path.join(input.dataDir, 'config.json'), path.join(input.dataDir, 'codeflowai.db.meta.json'),
    ...workspaceTargets];
  for (const file of journal.files) {
    const workspaceTarget = workspaceTargets.find(target => samePath(target, file.target));
    const staged = workspaceTarget ? path.join(path.dirname(workspaceTarget), `legacy-migration-${journal.migrationId}.db`)
      : path.join(archiveDirectory(input, journal), path.basename(file.target) === 'config.json' ? 'target-config.json'
        : path.basename(file.target) === 'codeflowai.db.meta.json' ? 'target-meta.json' : 'target-application.db');
    if (!targets.some(target => samePath(target, file.target)) || !samePath(staged, file.staged)
      || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.published !== 'boolean'
      || file.originalSha256 !== null && !/^[0-9a-f]{64}$/.test(file.originalSha256)) fail('MIGRATION_JOURNAL_INVALID');
  }
  return journal;
}

/** 所有迁移事实使用同目录临时文件 + fsync + rename 持久化。 */
function writeJournal(input: Input, journal: Journal): void { writeAtomic(path.join(input.dataDir, JOURNAL), journal); }
/** 临时归档只由固定迁移编号派生，不能接受页面路径。 */
function archiveDirectory(input: Input, journal: Journal): string { return path.join(input.dataDir, LEGACY_MIGRATION_DIR, journal.migrationId); }
/** 每次未封存快照重试创建新代，保留前次原始归档且绝不拼接不同时刻的库。 */
function snapshotDirectory(input: Input, journal: Journal): string { if (!journal.snapshotGeneration) fail('MIGRATION_SNAPSHOT_MISSING'); return path.join(archiveDirectory(input, journal), journal.snapshotGeneration); }
/** 原 Client 命名空间替换为稳定桌面身份，未知第三方前缀显式失败。 */
function mappedWorkspaceId(id: string, sourceClientId: string, targetClientId: string): string {
  if (id.startsWith(`${sourceClientId}:`)) return `${targetClientId}:${id.slice(sourceClientId.length + 1)}`;
  if (!id.includes(':')) return `${targetClientId}:${id}`;
  fail('SOURCE_WORKSPACE_ID_UNSUPPORTED');
}
/** 校验宿主隔离目录与稳定身份，防止退回普通 Client 默认库。 */
function validateInput(input: Input): void {
  parseLegacyClientMigrationRequest({ ...input, action: 'discover' });
  if (!path.isAbsolute(input.dataDir)) fail('MIGRATION_REQUEST_INVALID');
  if (exists(input.dataDir)) assertDirectory(input.dataDir);
}
/** 原配置只读且保留秘密在内存；格式错误不能生成替代身份。 */
function readSourceConfig(filename: string): SourceConfig {
  const config = readObject(filename);
  if (typeof config.apiKey !== 'string' || typeof config.serverWs !== 'string' || typeof config.clientId !== 'string') fail('SOURCE_CONFIG_INVALID');
  const url = new URL(config.serverWs);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('SOURCE_SERVER_INVALID');
  return { apiKey: config.apiKey, serverWs: config.serverWs, clientId: config.clientId };
}
/** 每次短连接都显式收口，关闭失败保留业务根因。 */
function withDatabase<T>(filename: string, readonly: boolean, operation: (db: SqliteDb) => T): T {
  assertFile(filename); const db = openSqliteDb(filename, { readonly, fileMustExist: true }); let failure: unknown;
  try { return operation(db); } catch (error) { failure = error; throw error; } finally { closeDatabase(db, failure); }
}
/** 异步转换旧 workspace 副本时仍在原边界等待连接关闭并保留双错。 */
async function withDatabaseAsync<T>(filename: string, readonly: boolean, operation: (db: SqliteDb) => Promise<T>): Promise<T> {
  assertFile(filename); const db = openSqliteDb(filename, { readonly, fileMustExist: true }); let failure: unknown;
  try { return await operation(db); } catch (error) { failure = error; throw error; } finally { closeDatabase(db, failure); }
}
/** SQLite 关闭失败不得覆盖原错误或伪造安全释放。 */
function closeDatabase(db: SqliteDb, failure: unknown): void {
  try { db.close(); } catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], 'MIGRATION_DB_CLOSE_FAILED', { cause: failure }); }
}
/** 完整性及 FK 校验同时成立才允许提交转换结果。 */
function integrity(db: SqliteDb): void {
  const result = db.pragma('integrity_check', { simple: true }), foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (result !== 'ok' || foreignKeys.length) {
    process.stderr.write(JSON.stringify({ diagnostic: 'MIGRATION_INTEGRITY_FIXTURE', check: result, foreignKeys: foreignKeys.slice(0, 10) }) + '\n');
    throw Object.assign(migrationError('SOURCE_INTEGRITY_INVALID'), { check: result, foreignKeys: foreignKeys.slice(0, 10) });
  }
}
/** 返回实际表清单，SQLite 自有 sequence 不属于迁移业务。 */
function listTables(db: SqliteDb): string[] { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map(row => row.name); }
/** 列名来自受核验 schema，后续 SQL 统一转义。 */
function columns(db: SqliteDb, table: string): string[] { return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Row[]).map(row => row.name); }
/** 仅检查真实表，不触发建表修复。 */
function hasTable(db: SqliteDb, table: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined; }
/** 统计阶段读取真实记录数量。 */
function tableCount(db: SqliteDb, table: string): number { return hasTable(db, table) ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as Row).count) : 0; }
/** 标量元数据缺失显式保留为空，调用边界决定是否允许。 */
function metaValue(db: SqliteDb, key: string): string { return String((db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined)?.value ?? ''); }
/** 序号只接受非负安全整数，不把损坏计数降成零。 */
function validCounter(value: string): number { if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('SOURCE_EVENT_SEQUENCE_INVALID'); return Number(value); }
/** SQL 标识符只来自固定清单或 SQLite 结构。 */
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
/** 仅用于已校验的内部 ID 常量条件，绝不接受页面 SQL。 */
function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
/** 摘要不包含源凭据，仅用于文件或业务字节完整性。 */
function sha256(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
/** 文件摘要采用分块读取，避免大 SQLite 全部进内存。 */
function sha256File(filename: string): string {
  assertFile(filename); const hash = crypto.createHash('sha256'), fd = fs.openSync(filename, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let size: number; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
/** 缺失与权限失败严格区分，不将读取失败当成无数据。 */
function exists(filename: string): boolean { try { fs.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
/** 普通文件必须无符号链接及硬链接，避免替换或越界读写。 */
function assertFile(filename: string): void { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync.native(filename), filename)) fail('SOURCE_PATH_UNSAFE'); }
/** 受管目录必须是物理目录，父链链接也不得把操作导向别处。 */
function assertDirectory(filename: string): void { const stat = fs.lstatSync(filename); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(filename), filename)) fail('SOURCE_PATH_UNSAFE'); }
/** 读取元数据只接受对象，解析根因不上抛含秘密正文的 message。 */
function readObject(filename: string): Row { assertFile(filename); let value: unknown; try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (error) { throw migrationError('MIGRATION_JSON_INVALID', error); } if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_JSON_INVALID'); return value as Row; }
/** 比较路径沿当前 OS 大小写口径。 */
function samePath(left: string, right: string): boolean { return pathKey(left) === pathKey(right); }
/** Windows 路径比较保持与现有来源锁相同的大小写口径。 */
function pathKey(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
/** SQLite 文件头只是普通格式证据，未知头不等同于加密。 */
function plainHeader(filename: string): boolean { const fd = fs.openSync(filename, 'r'), header = Buffer.alloc(16); try { return fs.readSync(fd, header, 0, 16, 0) === 16 && header.toString('ascii') === 'SQLite format 3\0'; } finally { fs.closeSync(fd); } }
/** 只删除本迁移固定临时文件，sidecar 同时清理避免副本重试污染。 */
function removeOwnedTemporary(filename: string): void { for (const suffix of ['', ...SIDECARS]) { const target = `${filename}${suffix}`; if (exists(target)) { assertFile(target); fs.unlinkSync(target); } } }
/** 原子持久化JSON；失败回收本次临时文件，保留写入及清理的全部错误。 */
function writeAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true }); assertDirectory(path.dirname(filename));
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  let failure: unknown;
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally {
      try { fs.closeSync(fd); }
      catch (error) { throw failure === undefined ? error : new AggregateError([failure, error], 'MIGRATION_JSON_CLOSE_FAILED', { cause: failure }); }
    }
    if (exists(filename)) assertFile(filename);
    fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename));
  } catch (error) {
    try { if (exists(temporary)) { assertFile(temporary); fs.unlinkSync(temporary); } }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'MIGRATION_JSON_CLEANUP_FAILED', { cause: error }); }
    throw error;
  }
}
/** 文件持久提交后才更新 journal 的可见事实。 */
function syncFile(filename: string): void { const fd = fs.openSync(filename, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** POSIX 持久化 rename 的目录项；Windows 的目录句柄不支持 fsync。 */
function syncDirectory(filename: string): void { if (process.platform === 'win32') return; const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** 只用 PID 探活，不把它当作发送停止信号的授权证据。 */
function processRunning(pid: unknown): boolean { if (!Number.isInteger(pid) || Number(pid) <= 0) return false; try { process.kill(Number(pid), 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; } }
/** 取消会保留 journal，下一次继续原任务而非重复导入。 */
function checkpoint(dependencies: LegacyClientMigrationDependencies): void { dependencies.signal?.throwIfAborted(); }
/** 进度仅来自已完成的工作单元，不使用时间插值。 */
function progress(dependencies: LegacyClientMigrationDependencies, stage: string, completed: number, total: number | null, journal: Journal,
  detail: Partial<LegacyClientMigrationProgress> = {}): void {
  dependencies.onProgress?.({ ...detail, stage, completed, total, workspaceCount: journal.source.workspaces.length });
}
/** 对外错误只携带固定码，原异常由受管 Worker 边界安全记录。 */
function migrationError(code: string, cause?: unknown, context?: LegacyClientMigrationContext): Error & { code: string; context?: LegacyClientMigrationContext } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code, ...(context ? { context } : {}) });
}
/** 无法验证的事实必须立即失败。 */
function fail(code: string, context?: LegacyClientMigrationContext): never { throw migrationError(code, undefined, context); }
/** journal 只保存稳定错误码，不保存可能含凭据的异常原文。 */
function errorCode(error: unknown): string { const code = (error as { code?: unknown })?.code; return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'LEGACY_MIGRATION_FAILED'; }
