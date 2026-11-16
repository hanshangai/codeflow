import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { EngineModelInfo, EngineType, ThreadId, WorkspaceId, LocalScheduledTaskConfig, LocalScheduledTaskRun, ScheduledTaskRun } from "@codeflowai/shared";

import { migrateClientDb, assertWorkspaceDbReadOnlySchema, ensureWorkspaceCoreQueueTables, ensureWorkspaceAdditionalTables, WORKSPACE_CORE_TABLES, WORKSPACE_ADDITIONAL_TABLES } from "./migrateClientDb.js";
import { WorkspaceRepo } from "./repos/workspaceRepo.js";
import { WorkspaceExecutionProfileRepo } from "./repos/workspaceExecutionProfileRepo.js";
import { ThreadRepo } from "./repos/threadRepo.js";
import { ConversationEventRepo, RawEngineEventRepo } from "./repos/eventRepo.js";
import { ThreadTurnRepo } from "./repos/threadTurnRepo.js";
import { FileBlobRepo } from "./repos/fileBlobRepo.js";
import { TurnFileChangeRepo } from "./repos/turnFileChangeRepo.js";
import { ThreadRollbackRepo } from "./repos/threadRollbackRepo.js";
import { ThreadStateBindingRepo } from "./repos/threadStateBindingRepo.js";
import { TerminalConfigRepo } from "./repos/terminalConfigRepo.js";
import { WorkspacePrefsRepo } from "./repos/workspacePrefsRepo.js";
import { EngineKeyRepo } from "./repos/engineKeyRepo.js";
import { EngineCustomModelRepo } from "./repos/engineCustomModelRepo.js";
import { ThreadDraftRepo } from "./repos/threadDraftRepo.js";
import { ThreadMessageQueueRepo } from "./repos/threadMessageQueueRepo.js";
import { ThreadQueueStateRepo } from "./repos/threadQueueStateRepo.js";
import { OrchRoleRepo } from "./repos/orchRoleRepo.js";
import { OrchWorkflowRepo } from "./repos/orchWorkflowRepo.js";
import { OrchAssigneeTemplateRepo } from "./repos/orchAssigneeTemplateRepo.js";
import { OrchWorkflowExecutionDefaultRepo } from "./repos/orchWorkflowExecutionDefaultRepo.js";
import { OrchInstanceRepo } from "./repos/orchInstanceRepo.js";
import { OrchInstanceSummaryProjectionReader } from "./orchInstanceSummaryProjection.js";
import { OrchSkillRepo } from "./repos/orchSkillRepo.js";
import { OrchToolsetRepo } from "./repos/orchToolsetRepo.js";
import { OrchIntakeRepo } from "./repos/orchIntakeRepo.js";
import { OrchIntakeListStateRepo } from "./repos/orchIntakeListStateRepo.js";
import { OrchProposalRepo } from "./repos/orchProposalRepo.js";
import { OrchArtifactRepo } from "./repos/orchArtifactRepo.js";
import { OrchEventRepo } from "./repos/orchEventRepo.js";
import { OrchFeedbackRepo } from "./repos/orchFeedbackRepo.js";
import { OrchKnowledgeBundleRepo } from "./repos/orchKnowledgeBundleRepo.js";
import { OrchPromptSnapshotRepo } from "./repos/orchPromptSnapshotRepo.js";
import { OrchGateEvaluationRunRepo } from "./repos/orchGateEvaluationRunRepo.js";
import { OrchArtifactFileRepo } from "./repos/orchArtifactFileRepo.js";
import { OrchArtifactFieldRepo } from "./repos/orchArtifactFieldRepo.js";
import { OrchNodeContextResolutionRepo } from "./repos/orchNodeContextResolutionRepo.js";
import { OrchNodeAttemptRepo } from "./repos/orchNodeAttemptRepo.js";
import { OrchNodeWorkItemRepo } from "./repos/orchNodeWorkItemRepo.js";
import { OrchAssetGenerationJobRepo } from "./repos/orchAssetGenerationJobRepo.js";
import { OrchAssetDraftRepo } from "./repos/orchAssetDraftRepo.js";
import { OrchAssetJobEventRepo } from "./repos/orchAssetJobEventRepo.js";
import { OrchAssetVersionRepo } from "./repos/orchAssetVersionRepo.js";
import { OrchAssetGroupRepo } from "./repos/orchAssetGroupRepo.js";
import { OrchRequirementAnalysisSessionRepo } from "./repos/orchRequirementAnalysisSessionRepo.js";
import { OrchRequirementAnalysisMessageRepo } from "./repos/orchRequirementAnalysisMessageRepo.js";
import { OrchRequirementCandidateDraftRepo } from "./repos/orchRequirementCandidateDraftRepo.js";
import { ReminderIgnoreRepo } from "./repos/reminderIgnoreRepo.js";
import { ReminderReceiptRepo } from "./repos/reminderReceiptRepo.js";
import { ThreadReminderStateRepo } from "./repos/threadReminderStateRepo.js";
import { ScheduledTaskRuntimeStateRepo, scheduledTaskRuntimeKey, scheduledTaskAccountRuntimeKey, type ScheduledTaskRuntimeState } from "./repos/scheduledTaskRuntimeStateRepo.js";
import { ScheduledTaskConfigRepo, ScheduledTaskConfigError } from "./repos/scheduledTaskConfigRepo.js";
import { ScheduledTaskRunRepo, ScheduledTaskRunError, assertScheduledTaskAccountOwner, type ScheduledTaskAccountOwner, type AccountScheduledTaskRun } from "./repos/scheduledTaskRunRepo.js";
import { DingTalkReminderNotificationRepo } from "./repos/dingTalkReminderNotificationRepo.js";
import { WeComReminderNotificationRepo } from "./repos/weComReminderNotificationRepo.js";
import { ControlledExperimentRepo } from "./repos/controlledExperimentRepo.js";
import { WorkspaceDirectoryMigrationRepo } from "./repos/workspaceDirectoryMigrationRepo.js";
import { CodeAttributionOutboxRepo } from "./repos/codeAttributionOutboxRepo.js";
import { CodeAttributionRetentionTaskRepo } from "./repos/codeAttributionRetentionTaskRepo.js";
import { openSqliteDb } from "./sqliteDb.js";
import { ScheduledTaskAccountConfigRepo, ScheduledTaskAccountConfigError, effectiveAccountTask, type AccountScheduledTaskConfigSnapshot } from "./repos/scheduledTaskAccountConfigRepo.js";
import { validateAccountTaskSnapshot, validateAccountConfigRevisionFloors } from "../scheduled-tasks/scheduledTaskAccountSnapshot.js";
import type { ClientScheduledTaskSyncResponseBody, ScheduledTask } from "@codeflowai/shared";
import type { SqliteDb } from "./sqliteTypes.js";
import { logger, formatWorkspaceLogEntry, writeWorkspaceLogFile, type WorkspaceLogEntry } from "../logger.js";
import { WorkspaceOperationGate } from "../workspace-migration/workspaceOperationGate.js";
import { ensureWorkspaceCodeflowaiDirectory, inspectExistingWorkspaceCodeflowaiDirectory, inspectWorkspaceCodeflowaiFile, inspectWorkspaceCodeflowaiFiles, writeWorkspaceCodeflowaiFile,
  isWorkspaceCodeflowaiFileDeviceMatch } from "../codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude } from "../git/workspacePrivateRuntimeGitExclude.js";

export type LocalScheduledTaskRepos = { db: SqliteDb; configs: ScheduledTaskConfigRepo; runs: ScheduledTaskRunRepo; runtime: ScheduledTaskRuntimeStateRepo };
export type AccountScheduledTaskRepos = Pick<LocalScheduledTaskRepos, "db" | "runtime" | "runs"> & { accountConfigs: ScheduledTaskAccountConfigRepo };
type TaskRepos = LocalScheduledTaskRepos & Pick<AccountScheduledTaskRepos, "accountConfigs">;
export type AccountScheduledTaskRunLocation = { workspaceId: WorkspaceId | null; run: AccountScheduledTaskRun };
export type AccountScheduledTaskLocation = { workspaceId: WorkspaceId | null; runtime: ScheduledTaskRuntimeState };
export type AccountScheduledTaskState = { locations: AccountScheduledTaskLocation[]; running: AccountScheduledTaskLocation | null;
  queued: AccountScheduledTaskLocation | null; lastScheduledAt: number | null; lastWorkflowInstanceId: string | null; lastWorkflowSequence: number | null };
type TaskDevice = { clientId: string; deviceId: string };
type DesktopReinstallDevice = { clientId: string; oldDeviceId: string; nextDeviceId: string };
type TaskFileIdentity = { path: string; dev: number; ino: number };
export type WorkspaceCoreRepos = Pick<ClientDb, "db" |
  "threads" | "conversationEvents" | "rawEvents" | "turns" | "threadReminderStates" |
  "reminderReceipts" | "reminderIgnores" | "dingTalkReminderNotifications" | "weComReminderNotifications" | "blobs" |
  "fileChanges" | "rollbacks" | "threadStateBindings" | "threadDrafts" | "threadMessageQueue" |
  "threadQueueStates" | "orchRoles" | "orchWorkflows" | "orchToolsets" | "orchSkills" |
  "orchKnowledgeBundles" | "orchIntakes" | "orchIntakeListStates" | "orchProposals" | "orchInstances" |
  "orchArtifacts" | "orchEvents" | "orchFeedback" | "orchPromptSnapshots" | "orchGateEvaluationRuns" |
  "orchArtifactFiles" | "orchArtifactFields" | "orchNodeContextResolutions" | "orchNodeAttempts" | "orchNodeWorkItems" |
  "orchAssetGenerationJobs" | "orchAssetDrafts" | "orchAssetJobEvents" | "orchAssetVersions" |
  "orchAssetGroups" | "orchRequirementAnalysisSessions" | "orchRequirementAnalysisMessages" | "orchRequirementCandidateDrafts" | "codeAttributionOutbox" |
  "codeAttributionRetentionTasks">;
export type WorkspaceCoreRouter = Omit<WorkspaceCoreRepos, "db">;
export type WorkspaceReaderSourceLease = {
  source: { dbPath: string; workspaceId: WorkspaceId; dev: string; ino: string };
  verify: () => void;
  release: () => void;
  retainFailedResource: (close: () => void, failure: unknown) => void;
};
export type ClientDb = {
  db: SqliteDb;
  applicationDb: SqliteDb;
  workspaceId: WorkspaceId | null;
  configureLegacyAccessGuard: (guard: (() => void) | null) => void;
  /** 运行时可信工作区根供同步日志复用；日志不得为定位路径等待数据库。 */
  configureWorkspaceLogResolver: (resolve: ((workspaceId: WorkspaceId) => string | null) | null) => void;
  closeWorkspaceConnections: (workspaceId?: WorkspaceId) => void;
  forWorkspace: (workspaceId: WorkspaceId, options?: { readonly?: boolean }) => ClientDb;
  ensureThreadPresentation: (workspaceId: WorkspaceId, threadId: ThreadId, opts?: { withDatabase?: <T>(operation: () => T) => Promise<T> }) => Promise<void>;
  withWorkspaceAssetWrite: <T>(workspaceId: WorkspaceId, operation: (view: ClientDb) => T) => T;
  acquireWorkspaceReaderSource: (workspaceId: WorkspaceId) => WorkspaceReaderSourceLease | null;
  withWorkspaceCoreSnapshot: <T>(workspaceId: WorkspaceId, operationId: string | null, operation: (view: ClientDb | null) => T) => T;
  workspaces: WorkspaceRepo;
  withWorkspaceExecutionProfiles: <T>(workspaceId: WorkspaceId, operation: (repo: WorkspaceExecutionProfileRepo) => T & (T extends PromiseLike<unknown> ? never : unknown)) => T;
  withWorkspacePrefs: <T>(workspaceId: WorkspaceId, operation: (repo: WorkspacePrefsRepo) => T & (T extends PromiseLike<unknown> ? never : unknown)) => T;
  withWorkspaceCoreRepos: <T>(workspaceId: WorkspaceId, operation: (repos: WorkspaceCoreRepos) => T & (T extends PromiseLike<unknown> ? never : unknown)) => T;
  workspaceCoreRouter: (workspaceId: WorkspaceId, threadId: ThreadId) => WorkspaceCoreRouter | null;
  writeWorkspaceLog: (workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => void;
  withLocalScheduledTasks: <T>(workspaceId: WorkspaceId | null, operation: (repos: LocalScheduledTaskRepos) => T & (T extends PromiseLike<unknown> ? never : unknown), includeDeleted?: boolean) => T;
  withAccountScheduledTasks: <T>(workspaceId: WorkspaceId | null, operation: (repos: AccountScheduledTaskRepos) => T & (T extends PromiseLike<unknown> ? never : unknown), includeDeleted?: boolean) => T;
  replaceAccountScheduledTaskConfigs: (owner: ScheduledTaskAccountOwner, response: ClientScheduledTaskSyncResponseBody,
    recovery?: { onCorrupt: (error: ScheduledTaskAccountConfigError, workspaceId: WorkspaceId | null) => void }) => Map<string, ScheduledTask>;
  listAccountScheduledTaskConfigs: (owner: ScheduledTaskAccountOwner) => Array<{ workspaceId: WorkspaceId | null; snapshot: AccountScheduledTaskConfigSnapshot }>;
  readAccountScheduledTaskState: (taskId: string, owner: ScheduledTaskAccountOwner) => AccountScheduledTaskState;
  listAccountScheduledMigrationQueued: (owner: ScheduledTaskAccountOwner) => AccountScheduledTaskLocation[];
  listAccountScheduledRunning: (workspaceId: WorkspaceId, operationId: string | null) => Array<{ taskId: string; runId: string }>;
  listAccountScheduledTaskRunSources: (owner?: ScheduledTaskAccountOwner, taskIds?: ReadonlySet<string>) => Array<WorkspaceId | null>;
  getAccountScheduledTaskRun: (runId: string, owner: ScheduledTaskAccountOwner) => AccountScheduledTaskRunLocation | null;
  listPendingAccountScheduledTaskRuns: (owner: ScheduledTaskAccountOwner, limit?: number) => AccountScheduledTaskRunLocation[];
  listAccountScheduledTaskRuns: (owner: ScheduledTaskAccountOwner, query: { taskId?: string; offset: number; limit: number }) => { items: AccountScheduledTaskRun[]; total: number };
  deferAccountScheduledTask: (input: { workspaceId: WorkspaceId; taskId: string; owner: ScheduledTaskAccountOwner; operationId: string; scheduledAt: number; at: number; skipped: boolean; skippedRun?: ScheduledTaskRun; taskName?: string }) => void;
  getLocalScheduledTask: (taskId: string) => LocalScheduledTaskConfig | null;
  rebindLocalScheduledTasksForDesktopReinstall: (input: DesktopReinstallDevice) => { rebound: number; unchanged: number };
  listLocalScheduledTaskConfigs: (device: TaskDevice) => LocalScheduledTaskConfig[];
  listLocalScheduledTaskRuns: (query: TaskDevice & { taskId?: string; offset: number; limit: number }) => { items: LocalScheduledTaskRun[]; total: number };
  getLocalScheduledTaskRuntime: (task: LocalScheduledTaskConfig) => ScheduledTaskRuntimeState | null;
  listLocalScheduledRunning: (workspaceId: WorkspaceId, device: TaskDevice, operationId: string | null) => Array<{ taskId: string; runId: string }>;
  deferLocalScheduledTask: (input: { task: LocalScheduledTaskConfig; operationId: string; scheduledAt: number; at: number; skippedRun?: ScheduledTaskRun }) => void;
  threads: ThreadRepo;
  conversationEvents: ConversationEventRepo;
  rawEvents: RawEngineEventRepo;
  turns: ThreadTurnRepo;
  threadReminderStates: ThreadReminderStateRepo;
  reminderReceipts: ReminderReceiptRepo;
  reminderIgnores: ReminderIgnoreRepo;
  dingTalkReminderNotifications: DingTalkReminderNotificationRepo;
  weComReminderNotifications: WeComReminderNotificationRepo;
  scheduledTaskRuntimeStates: ScheduledTaskRuntimeStateRepo;
  scheduledTaskConfigs: ScheduledTaskConfigRepo;
  scheduledTaskRuns: ScheduledTaskRunRepo;
  blobs: FileBlobRepo;
  fileChanges: TurnFileChangeRepo;
  rollbacks: ThreadRollbackRepo;
  threadStateBindings: ThreadStateBindingRepo;
  terminalConfigs: TerminalConfigRepo;
  threadDrafts: ThreadDraftRepo;
  threadMessageQueue: ThreadMessageQueueRepo;
  threadQueueStates: ThreadQueueStateRepo;
  engineKeys: EngineKeyRepo;
  engineCustomModels: EngineCustomModelRepo;
  orchRoles: OrchRoleRepo;
  orchWorkflows: OrchWorkflowRepo;
  orchAssigneeTemplates: OrchAssigneeTemplateRepo;
  orchWorkflowExecutionDefaults: OrchWorkflowExecutionDefaultRepo;
  orchToolsets: OrchToolsetRepo;
  orchSkills: OrchSkillRepo;
  orchKnowledgeBundles: OrchKnowledgeBundleRepo;
  orchIntakes: OrchIntakeRepo;
  orchIntakeListStates: OrchIntakeListStateRepo;
  orchProposals: OrchProposalRepo;
  orchInstances: OrchInstanceRepo;
  orchArtifacts: OrchArtifactRepo;
  orchEvents: OrchEventRepo;
  orchFeedback: OrchFeedbackRepo;
  orchPromptSnapshots: OrchPromptSnapshotRepo;
  orchGateEvaluationRuns: OrchGateEvaluationRunRepo;
  orchArtifactFiles: OrchArtifactFileRepo;
  orchArtifactFields: OrchArtifactFieldRepo;
  orchNodeContextResolutions: OrchNodeContextResolutionRepo;
  orchNodeAttempts: OrchNodeAttemptRepo;
  orchNodeWorkItems: OrchNodeWorkItemRepo;
  orchAssetGenerationJobs: OrchAssetGenerationJobRepo;
  orchAssetDrafts: OrchAssetDraftRepo;
  orchAssetJobEvents: OrchAssetJobEventRepo;
  orchAssetVersions: OrchAssetVersionRepo;
  orchAssetGroups: OrchAssetGroupRepo;
  orchRequirementAnalysisSessions: OrchRequirementAnalysisSessionRepo;
  orchRequirementAnalysisMessages: OrchRequirementAnalysisMessageRepo;
  orchRequirementCandidateDrafts: OrchRequirementCandidateDraftRepo;
  controlledExperiments: ControlledExperimentRepo;
  workspaceDirectoryMigrations: WorkspaceDirectoryMigrationRepo;
  codeAttributionOutbox: CodeAttributionOutboxRepo;
  codeAttributionRetentionTasks: CodeAttributionRetentionTaskRepo;
  close: () => void;
};

export function resolveAppHomeDir(): string {
  return path.join(os.homedir(), ".codeflowai");
}

/** 判断是否显式指定 Client DB 路径；显式模式不做账号级自动隔离。 */
export function hasExplicitClientDbPath(): boolean {
  const fromEnv = String(process.env.CODEFLOWAI_CLIENT_DB_PATH ?? "").trim();
  return Boolean(fromEnv);
}

/** 解析本地 DB 文件路径；账号命名空间只用于普通 Client 的目录隔离。 */
export function resolveClientDbPath(accountNamespace?: string | null): string {
  const fromEnv = String(process.env.CODEFLOWAI_CLIENT_DB_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  const namespace = String(accountNamespace ?? "").trim();
  if (namespace) return path.join(resolveAppHomeDir(), "client-dbs", namespace, "codeflowai.db");
  return path.join(resolveAppHomeDir(), "codeflowai.db");
}

/** 打开并迁移 Client SQLite；屏障通知贯穿根与工作区仓储，仅供外部合并调度。 */
export function openClientDb(opts?: {
  dbPath?: string;
  existingOnly?: boolean;
  resolveEngineModels?: (engine: EngineType) => EngineModelInfo[] | null;
  localCanonicalEvents?: boolean;
  onRelayInvalidation?: (scopeKey: string) => void;
  workspaceOperationGate?: WorkspaceOperationGate;
  workspaceConnectionCache?: { maxEntries?: number; idleMs?: number; onError: (error: unknown, workspaceId: WorkspaceId) => void };
}): ClientDb {
  const dbPath = (opts?.dbPath ?? resolveClientDbPath()).trim();
  if (!dbPath) throw new Error("Invalid dbPath");
  if (opts?.workspaceConnectionCache && [opts.workspaceConnectionCache.maxEntries ?? 8, opts.workspaceConnectionCache.idleMs ?? 30_000]
    .some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("WORKSPACE_CONNECTION_CACHE_CONFIG_INVALID");
  if (!opts?.existingOnly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openMigratedSqliteDb(dbPath, opts?.existingOnly === true);

  const workspaces = new WorkspaceRepo(db);
  const workspaceOperationGate = opts?.workspaceOperationGate ?? new WorkspaceOperationGate();
  const failedProfileResources = new Map<WorkspaceId, { close?: () => void; release: () => void; failure: unknown }>();
  let closing = false;
  let legacyAccessGuard: (() => void) | null = null;
  let resolveRuntimeWorkspaceLogRoot: ((workspaceId: WorkspaceId) => string | null) | null = null;
  /** Worker 独占使用的连接缓存；主线程遗留访问仍为同步短连接。 */
  const cachedWorkspaceConnections = new Map<WorkspaceId, { db: SqliteDb; verify: () => void; release: () => void; timer: ReturnType<typeof setTimeout> | null }>();
  /** 关闭前先保留 owner，失败不释放迁移门禁。 */
  const closeWorkspaceConnections: ClientDb["closeWorkspaceConnections"] = workspaceId => {
    for (const [id, entry] of cachedWorkspaceConnections) {
      if (workspaceId !== undefined && workspaceId !== id) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      try { entry.db.close(); }
      catch (failure) {
        failedProfileResources.set(id, { failure, release: entry.release,
          close: () => { entry.db.close(); cachedWorkspaceConnections.delete(id); } });
        throw failure;
      }
      entry.release();
      cachedWorkspaceConnections.delete(id);
      if (failedProfileResources.get(id)?.release === entry.release) failedProfileResources.delete(id);
    }
  };
  /** 只对已协调的主线程连接启用零等待；旧语句读取同一动态 guard。 */
  const configureLegacyAccessGuard: ClientDb["configureLegacyAccessGuard"] = guard => {
    if (guard && legacyAccessGuard && guard !== legacyAccessGuard) throw new Error("CLIENT_DB_WRITER_OWNER_CONFLICT");
    db.setAccessGuard?.(null);
    if (guard) db.pragma("busy_timeout = 0");
    legacyAccessGuard = guard;
    db.setAccessGuard?.(guard);
  };
  /** DB 和固定日志共用原失败 owner 准入，不允许绕过 closing 或同工作区未收口资源。 */
  const assertWorkspaceAvailable = (workspaceId: WorkspaceId): void => {
    if (closing) throw profileStorageFailure(workspaceId, new Error("CLIENT_DB_CLOSING"));
    const failed = failedProfileResources.get(workspaceId);
    if (failed) throw profileStorageFailure(workspaceId, failed.failure);
  };
  /** 只保留失败资源所属操作的门禁；嵌套的已收口操作仍释放自身计数。 */
  const finishWorkspaceOperation = (workspaceId: WorkspaceId, release: () => void): void => {
    if (failedProfileResources.get(workspaceId)?.release !== release) release();
  };
  /** 固定日志不打开 workspace.db；只从可信注册表取根并持 gate 至同步收口。 */
  const writeWorkspaceLog = (workspaceId: WorkspaceId, entry: WorkspaceLogEntry): void => {
    assertWorkspaceAvailable(workspaceId);
    const line = formatWorkspaceLogEntry(entry);
    if (line === undefined) return;
    const release = workspaceOperationGate.beginWrite(workspaceId);
    try {
      const workspacePath = resolveRuntimeWorkspaceLogRoot ? resolveRuntimeWorkspaceLogRoot(workspaceId) : workspaces.get(workspaceId)?.path;
      if (!workspacePath) throw new Error("WORKSPACE_LOG_WORKSPACE_NOT_FOUND");
      writeWorkspaceLogFile(workspacePath, line, (phase, error) => {
        const failure = Object.assign(new Error("WORKSPACE_LOG_CLOSE_UNCONFIRMED", { cause: error }), {
          code: "WORKSPACE_LOG_CLOSE_UNCONFIRMED", phase, workspaceId,
          requestId: entry.data && typeof entry.data === "object" ? (entry.data as { requestId?: unknown }).requestId : undefined,
        });
        failedProfileResources.set(workspaceId, { release, failure });
      });
    } finally { finishWorkspaceOperation(workspaceId, release); }
  };
  /** 每次同步开关工作区库；只有未关闭资源留在原 ClientDb 生命周期内。 */
  const withWorkspaceDb = <T>(workspaceId: WorkspaceId, operation: (database: SqliteDb) => T,
    options?: { readonly?: boolean; existingFile?: TaskFileIdentity; operationId?: string | null; defer?: boolean; task?: boolean; core?: boolean; includeDeleted?: boolean; whenMissing?: () => T }): T => {
    assertWorkspaceAvailable(workspaceId);
    legacyAccessGuard?.();
    const cached = opts?.workspaceConnectionCache && !options?.readonly && !options?.existingFile && !options?.operationId
      ? cachedWorkspaceConnections.get(workspaceId) : undefined;
    if (cached) {
      workspaceOperationGate.assertWriteAllowed(workspaceId);
      if (cached.timer) clearTimeout(cached.timer);
      cached.timer = null;
      try {
        cached.verify();
        const result = synchronousTaskResult(operation(cached.db));
        cached.verify();
        return result;
      } catch (error) {
        try { closeWorkspaceConnections(workspaceId); }
        catch (closeError) { throw new AggregateError([error, closeError], "WORKSPACE_PROFILE_CLEANUP_FAILED", { cause: error }); }
        throw error;
      } finally {
        if (cachedWorkspaceConnections.get(workspaceId) === cached) scheduleWorkspaceConnectionClose(workspaceId, cached);
      }
    }
    const release = options?.readonly || options?.defer
      ? workspaceOperationGate.beginScheduledTaskOperation(workspaceId, options.operationId ?? null, options.defer ? "defer" : "snapshot")
      : workspaceOperationGate.beginWrite(workspaceId);
    let profileDb: SqliteDb | null = null, unclosed: (() => void) | undefined;
    let verify: (() => void) | undefined;
    let failure: unknown, hasFailure = false, operationStarted = false;
    try {
      const workspace = options?.includeDeleted ? workspaces.getIncludingDeleted(workspaceId) : workspaces.get(workspaceId);
      if (!workspace) throw new Error("WORKSPACE_PROFILE_WORKSPACE_NOT_FOUND");
      const directory = options?.readonly || options?.existingFile ? inspectExistingWorkspaceCodeflowaiDirectory(workspace.path)
        : ensureWorkspaceCodeflowaiDirectory(workspace.path);
      if (!directory) {
        if (!options?.whenMissing) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
        return options.whenMissing();
      }
      const names = ["", "-wal", "-shm", "-journal"].map(suffix => `workspace.db${suffix}`);
      const before = inspectWorkspaceCodeflowaiFiles(directory, names);
      if (options?.existingFile && (!before[0] || before[0].ino !== options.existingFile.ino
        || !isWorkspaceCodeflowaiFileDeviceMatch(before[0].dev, options.existingFile.dev))) throw new Error("WORKSPACE_PROFILE_FILE_REPLACED");
      if (!before[0] && before.slice(1).some(Boolean)) throw new Error("WORKSPACE_PROFILE_ORPHAN_SIDECAR");
      if (options?.readonly && !before[0]) {
        if (!options.whenMissing) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
        return options.whenMissing();
      }
      if (!options?.readonly && !options?.existingFile) {
        ensureWorkspacePrivateRuntimeGitExclude(workspace.path, names);
        writeWorkspaceCodeflowaiFile(directory, "workspace.db", Buffer.alloc(0), { onlyIfMissing: true });
      }
      const main = before[0] ?? inspectWorkspaceCodeflowaiFile(directory, "workspace.db")!;
      /** 副作用前后保持同一物理主库，既有 sidecar 同样不得被替换。 */
      verify = (): void => {
        const registered = options?.includeDeleted ? workspaces.getIncludingDeleted(workspaceId) : workspaces.get(workspaceId);
        if (!registered || registered.path !== workspace.path) throw new Error("WORKSPACE_PROFILE_REGISTRATION_CHANGED");
        const currentFiles = inspectWorkspaceCodeflowaiFiles(directory, names);
        for (let index = 0; index < names.length; index++) {
          const current = currentFiles[index];
          const expected = index === 0 ? main : before[index];
          if (expected && current && (!isWorkspaceCodeflowaiFileDeviceMatch(expected.dev, current.dev) || expected.ino !== current.ino)
            || index === 0 && !current) throw new Error("WORKSPACE_PROFILE_FILE_REPLACED");
        }
      };
      verify();
      profileDb = openSqliteDb(main.path, { readonly: options?.readonly, fileMustExist: true,
        busyTimeoutMs: legacyAccessGuard ? 0 : undefined, assertAccess: () => legacyAccessGuard?.(),
        statementCacheSize: opts?.workspaceConnectionCache ? 256 : 0,
        onInitializationCleanupFailure: close => { unclosed = close; } });
      verify();
      if (options?.readonly || options?.existingFile) {
        const schema = assertWorkspaceDbReadOnlySchema(profileDb);
        if (schema.schemaVersion < 96) {
          if (!options.whenMissing) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
          return options.whenMissing();
        }
      } else migrateClientDb(profileDb, { scope: "workspace" });
      verify();
      operationStarted = true;
      const result = operation(profileDb);
      if (result != null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS");
      }
      verify();
      if (opts?.workspaceConnectionCache && !options?.readonly && !options?.existingFile && !options?.operationId) {
        const maxEntries = opts.workspaceConnectionCache.maxEntries ?? 8;
        while (cachedWorkspaceConnections.size >= maxEntries) closeWorkspaceConnections(cachedWorkspaceConnections.keys().next().value!);
        const entry = { db: profileDb, verify, release, timer: null as ReturnType<typeof setTimeout> | null };
        cachedWorkspaceConnections.set(workspaceId, entry);
        scheduleWorkspaceConnectionClose(workspaceId, entry);
        profileDb = null;
      }
      return result;
    } catch (error) {
      hasFailure = true; failure = error;
      if (options?.core && operationStarted) throw error;
      if (options?.task && (error instanceof ScheduledTaskConfigError || error instanceof ScheduledTaskRunError || error instanceof ScheduledTaskAccountConfigError
        || error instanceof Error && ["SCHEDULED_TASK_RUNTIME_CORRUPT", "SCHEDULED_TASK_RUNTIME_CONFLICT", "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED"].includes(String((error as { code?: unknown }).code)))) {
        throw Object.assign(error, { workspaceId });
      }
      throw profileStorageFailure(workspaceId, error);
    }
    finally {
      try { profileDb?.close(); }
      catch (closeError) {
        const combined = hasFailure ? new AggregateError([failure, closeError], "WORKSPACE_PROFILE_CLEANUP_FAILED", { cause: failure }) : closeError;
        failedProfileResources.set(workspaceId, { close: () => profileDb!.close(), release, failure: combined });
        throw profileStorageFailure(workspaceId, combined);
      }
      if (unclosed) failedProfileResources.set(workspaceId, { close: unclosed, release, failure });
      else {
        try { if (!hasFailure) verify?.(); }
        catch (error) { throw profileStorageFailure(workspaceId, error); }
        finally { if (!cachedWorkspaceConnections.has(workspaceId)) finishWorkspaceOperation(workspaceId, release); }
      }
    }
  };
  /** 空闲连接只在同步操作退出后回收，关闭错误保留在原失败 owner。 */
  function scheduleWorkspaceConnectionClose(workspaceId: WorkspaceId, entry: { timer: ReturnType<typeof setTimeout> | null }): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      try { closeWorkspaceConnections(workspaceId); }
      catch (error) { opts!.workspaceConnectionCache!.onError(error, workspaceId); }
    }, opts!.workspaceConnectionCache!.idleMs ?? 30_000);
    entry.timer.unref?.();
  }
  /** 可信注册和原安全路径产生短 reader 租约；完成关闭前不释放迁移门禁。 */
  const acquireWorkspaceReaderSource: ClientDb["acquireWorkspaceReaderSource"] = workspaceId => {
    assertWorkspaceAvailable(workspaceId);
    const release = workspaceOperationGate.beginWrite(workspaceId);
    try {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) throw new Error("WORKSPACE_PROFILE_WORKSPACE_NOT_FOUND");
      const directory = inspectExistingWorkspaceCodeflowaiDirectory(workspace.path);
      const main = directory && inspectWorkspaceCodeflowaiFile(directory, "workspace.db");
      if (!directory || !main) { release(); return null; }
      const identity = fs.lstatSync(main.path, { bigint: true });
      if (!identity.isFile() || identity.isSymbolicLink() || !isWorkspaceCodeflowaiFileDeviceMatch(main.dev, Number(identity.dev)) || main.ino !== Number(identity.ino)) {
        throw new Error("WORKSPACE_PROFILE_FILE_REPLACED");
      }
      return {
        source: { dbPath: main.path, workspaceId, dev: String(identity.dev), ino: String(identity.ino) },
        verify: () => {
          const current = inspectWorkspaceCodeflowaiFile(directory, "workspace.db");
          const actual = fs.lstatSync(main.path, { bigint: true });
          if (!current || !actual.isFile() || actual.isSymbolicLink() || identity.dev !== actual.dev || identity.ino !== actual.ino) {
            throw new Error("WORKSPACE_PROFILE_FILE_REPLACED");
          }
        },
        release,
        retainFailedResource: (close, failure) => {
          failedProfileResources.set(workspaceId, { close, release, failure });
        },
      };
    } catch (error) { release(); throw error; }
  };
  /** Profile 与偏好共用物理库、同步边界和失败资源 owner，保持原错误合同。 */
  const withWorkspaceExecutionProfiles: ClientDb["withWorkspaceExecutionProfiles"] = (workspaceId, operation) =>
    withWorkspaceDb(workspaceId, database => operation(new WorkspaceExecutionProfileRepo(database)));
  /** 仅在已注册物理工作区内同步操作偏好，不读取应用库历史行。 */
  const withWorkspacePrefs: ClientDb["withWorkspacePrefs"] = (workspaceId, operation) =>
    withWorkspaceDb(workspaceId, database => operation(new WorkspacePrefsRepo(database)));
  const threads = new ThreadRepo(db, opts?.resolveEngineModels);
  const conversationEvents = new ConversationEventRepo(db, { localCanonicalEvents: opts?.localCanonicalEvents === true, onRelayInvalidation: opts?.onRelayInvalidation });
  const rawEvents = new RawEngineEventRepo(db);
  const turns = new ThreadTurnRepo(db);
  const threadReminderStates = new ThreadReminderStateRepo(db);
  const reminderReceipts = new ReminderReceiptRepo(db);
  const reminderIgnores = new ReminderIgnoreRepo(db);
  const dingTalkReminderNotifications = new DingTalkReminderNotificationRepo(db);
  const weComReminderNotifications = new WeComReminderNotificationRepo(db);
  const scheduledTaskRuntimeStates = new ScheduledTaskRuntimeStateRepo(db);
  const scheduledTaskConfigs = new ScheduledTaskConfigRepo(db, scheduledTaskRuntimeStates);
  const scheduledTaskRuns = new ScheduledTaskRunRepo(db, scheduledTaskConfigs);
  const accountConfigs = new ScheduledTaskAccountConfigRepo(db, null);
  /** 任务仓储始终在同一连接内构造，不保存跨操作的workspace Repo。 */
  const taskRepos = (database: SqliteDb, workspaceId: WorkspaceId | null): TaskRepos => {
    const runtime = new ScheduledTaskRuntimeStateRepo(database, workspaceId), configs = new ScheduledTaskConfigRepo(database, runtime, workspaceId);
    return { db: database, runtime, configs, runs: new ScheduledTaskRunRepo(database, configs), accountConfigs: new ScheduledTaskAccountConfigRepo(database, workspaceId) };
  };
  /** 普通任务操作沿原同步 opener，已认领收尾可读取软删注册。 */
  const withLocalScheduledTasks = <T>(workspaceId: WorkspaceId | null,
    operation: (repos: LocalScheduledTaskRepos) => T & (T extends PromiseLike<unknown> ? never : unknown), includeDeleted = false, existingFile?: TaskFileIdentity): T => workspaceId === null
    ? synchronousTaskResult(operation({ db, configs: scheduledTaskConfigs, runs: scheduledTaskRuns, runtime: scheduledTaskRuntimeStates }))
    : withWorkspaceDb(workspaceId, database => operation(taskRepos(database, workspaceId)), { includeDeleted, task: true, existingFile });
  /** 内部只读快照同用唯一 opener；合法缺库/旧版无三表才返回调用方的空值。 */
  const readTasks = <T>(workspaceId: WorkspaceId | null, operation: (repos: TaskRepos) => T, empty: () => T,
    operationId = workspaceId === null ? null : workspaceOperationGate.getMigrationOperationId(workspaceId)): T => workspaceId === null
    ? operation({ db, configs: scheduledTaskConfigs, runs: scheduledTaskRuns, runtime: scheduledTaskRuntimeStates, accountConfigs })
    : withWorkspaceDb(workspaceId, database => operation(taskRepos(database, workspaceId)),
      { readonly: true, task: true, includeDeleted: true, operationId, whenMissing: empty });
  /** 遍历注册物理来源，包含墓碑；不能按裸 ID 覆盖任一来源。 */
  const sources = (): Array<WorkspaceId | null> => [null, ...workspaces.list({ includeDeleted: true }).map(item => item.id)];
  /** 仅由维护进程在普通调度启动前接续保留的本机任务。 */
  const rebindLocalScheduledTasksForDesktopReinstall: ClientDb["rebindLocalScheduledTasksForDesktopReinstall"] = input => {
    if (![input.clientId, input.oldDeviceId, input.nextDeviceId].every(value => typeof value === "string" && value.trim())
      || input.oldDeviceId === input.nextDeviceId) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "reinstall_owner");
    if (closing) throw new Error("CLIENT_DB_CLOSING");
    const locations: Array<{ workspaceId: WorkspaceId | null; tasks: LocalScheduledTaskConfig[]; file: TaskFileIdentity }> = [];
    for (const workspaceId of sources()) readTasks(workspaceId, repos => {
      const tasks = repos.configs.listDesktopReinstallCandidates(input), byId = new Map(tasks.map(task => [task.id, task]));
      for (const task of tasks) {
        const runtime = repos.runtime.get(scheduledTaskRuntimeKey(task.id, "local"));
        if (runtime && (runtime.source !== "local" || runtime.clientId !== task.clientId || runtime.deviceId !== task.deviceId)) {
          throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", task.id, "reinstall_owner");
        }
      }
      for (const runtime of repos.runtime.listLocalDesktopReinstallStates(input.clientId)) {
        const task = byId.get(runtime.taskId);
        if (!task || runtime.deviceId !== task.deviceId) {
          throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", runtime.taskId, "reinstall_orphan_or_owner");
        }
      }
      if (tasks.length) {
        const row = (repos.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(item => item.name === "main");
        if (!row?.file) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED", "", "reinstall_file");
        const file = fs.statSync(row.file);
        locations.push({ workspaceId, tasks, file: { path: row.file, dev: file.dev, ino: file.ino } });
      }
    }, () => undefined);
    for (const location of locations) for (const task of location.tasks) getLocalScheduledTask(task.id);
    const result = { rebound: 0, unchanged: 0 };
    for (const location of locations) {
      const counts = withLocalScheduledTasks(location.workspaceId, repos => repos.db.transaction(() => {
        const current = fs.statSync(location.file.path);
        if (current.ino !== location.file.ino || !isWorkspaceCodeflowaiFileDeviceMatch(current.dev, location.file.dev)) {
          throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", "", "reinstall_file");
        }
        const counts = { rebound: 0, unchanged: 0 };
        for (const task of location.tasks) {
          if (repos.configs.rebindDesktopDevice({ ...input, taskId: task.id })) counts.rebound++;
          else counts.unchanged++;
        }
        return counts;
      })(), true, location.file);
      result.rebound += counts.rebound; result.unchanged += counts.unchanged;
    }
    return result;
  };
  /** 账号callback暴露同连接配置、历史与runtime；无工作区复用原应用连接。 */
  const withAccountScheduledTasks: ClientDb["withAccountScheduledTasks"] = (workspaceId, operation, includeDeleted = false) => workspaceId === null
    ? synchronousTaskResult(operation({ db, runtime: scheduledTaskRuntimeStates, runs: scheduledTaskRuns, accountConfigs }))
    : withWorkspaceDb(workspaceId, database => operation(taskRepos(database, workspaceId)), { includeDeleted, task: true });
  /** 当前owner跨物理来源仅读，任何重复任务（含停删）都显式失败。 */
  const listAccountScheduledTaskConfigs: ClientDb["listAccountScheduledTaskConfigs"] = owner => {
    assertScheduledTaskAccountOwner(owner);
    const seen = new Set<string>(), located: ReturnType<ClientDb["listAccountScheduledTaskConfigs"]> = [];
    for (const workspaceId of sources()) for (const snapshot of readTasks(workspaceId,
      repos => Number(repos.db.pragma("user_version", { simple: true })) >= 99 ? repos.accountConfigs.list(owner) : [], () => [])) {
      if (seen.has(snapshot.task.id)) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", snapshot.task.id, "physical_task_collision");
      seen.add(snapshot.task.id); located.push({ workspaceId, snapshot });
    }
    return located;
  };
  /** 完整校验与物理归属预检先于写入；主动刷新只修坏行，各库原子回读后发布。 */
  const replaceAccountScheduledTaskConfigs: ClientDb["replaceAccountScheduledTaskConfigs"] = (owner, response, recovery) => {
    assertScheduledTaskAccountOwner(owner);
    const tasks = validateAccountTaskSnapshot(response, owner, true), floors = validateAccountConfigRevisionFloors(response, tasks);
    const grouped = new Map<WorkspaceId | null, ScheduledTask[]>();
    for (const task of tasks.values()) {
      const workspaceId = task.payload.contextWorkspaceId ?? null;
      if (workspaceId !== null && !workspaces.get(workspaceId)) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", task.id, "workspace_missing");
      const items = grouped.get(workspaceId) ?? []; items.push(task); grouped.set(workspaceId, items);
    }
    const previous = new Map<string, WorkspaceId | null>();
    const repairs = new Map<WorkspaceId | null, Set<string>>(), corruptions: Array<{ error: ScheduledTaskAccountConfigError; workspaceId: WorkspaceId | null }> = [];
    for (const workspaceId of sources()) {
      const existing = readTasks(workspaceId, repos => Number(repos.db.pragma("user_version", { simple: true })) >= 99
        ? recovery ? repos.accountConfigs.inspectForResync(owner) : repos.accountConfigs.list(owner).map(snapshot => ({ taskId: snapshot.task.id, snapshot })) : [], () => []);
      if (existing.length && !grouped.has(workspaceId)) grouped.set(workspaceId, []);
      for (const item of existing) {
        if (previous.has(item.taskId)) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", item.taskId, "physical_task_collision");
        previous.set(item.taskId, workspaceId);
        if (tasks.has(item.taskId) && (tasks.get(item.taskId)!.payload.contextWorkspaceId ?? null) !== workspaceId) {
          throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", item.taskId, "workspace_immutable");
        }
        if (!item.snapshot) {
          const taskIds = repairs.get(workspaceId) ?? new Set<string>(); taskIds.add(item.taskId); repairs.set(workspaceId, taskIds);
          corruptions.push({ error: item.corruption, workspaceId });
        }
      }
    }
    for (const item of corruptions) recovery!.onCorrupt(item.error, item.workspaceId);
    const saved = new Map<string, ScheduledTask>();
    for (const [workspaceId, configs] of grouped) {
      for (const snapshot of withAccountScheduledTasks(workspaceId, repos => repos.accountConfigs.replace(owner,
        configs.map(task => ({ task, localRevision: floors.get(task.id)! })), recovery ? repairs.get(workspaceId) ?? new Set<string>() : undefined), configs.length === 0)) {
        if (snapshot.serverPresent && snapshot.stopIntent !== "deleted") saved.set(snapshot.task.id, effectiveAccountTask(snapshot));
      }
    }
    return saved;
  };
  /** 历史能力单独按98探测；结算时仅返回确需写入的W，应用保原事务入口。 */
  const listAccountScheduledTaskRunSources: ClientDb["listAccountScheduledTaskRunSources"] = (owner, taskIds) => sources().filter(workspaceId => workspaceId === null
    || readTasks(workspaceId, repos => Number(repos.db.pragma("user_version", { simple: true })) >= 98
      && (!owner || !taskIds || repos.runs.hasMissingAccount(owner, taskIds)), () => false));
  /** 先跨合法来源定位元数据；同 owner 的任一重复ID（含已结算）均显式冲突。 */
  const getAccountScheduledTaskRun: ClientDb["getAccountScheduledTaskRun"] = (runId, owner) => {
    let found: WorkspaceId | null | undefined;
    for (const workspaceId of listAccountScheduledTaskRunSources()) {
      if (!readTasks(workspaceId, repos => repos.runs.hasAccount(runId, owner), () => false)) continue;
      if (found !== undefined) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", "", runId, "physical_run_id_collision");
      found = workspaceId;
    }
    if (found === undefined) return null;
    const run = readTasks(found, repos => repos.runs.getAccount(runId, owner), () => null);
    if (!run) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", "", runId, "physical_run_missing");
    return { workspaceId: found, run };
  };
  /** 每库只取前limit候选，跨全来源查重后稳定合页；不维护第二份待报状态。 */
  const listPendingAccountScheduledTaskRuns: ClientDb["listPendingAccountScheduledTaskRuns"] = (owner, limit = 100) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "limit");
    const items: AccountScheduledTaskRunLocation[] = [];
    for (const workspaceId of listAccountScheduledTaskRunSources()) {
      for (const run of readTasks(workspaceId, repos => repos.runs.listPendingAccount(owner, limit), () => [])) items.push({ workspaceId, run });
    }
    for (const { run } of items) getAccountScheduledTaskRun(run.id, owner);
    return items.sort((a,b) => a.run.createdAt-b.run.createdAt || compareTaskText(a.run.id,b.run.id)
      || compareTaskText(a.workspaceId??"",b.workspaceId??"")).slice(0,limit);
  };

  /** 原来源逐库读取前K和批量核ID归属；页外碰撞仍拒绝，不逐条重开数据库。 */
  const listAccountScheduledTaskRuns: ClientDb["listAccountScheduledTaskRuns"] = (owner, query) => {
    assertScheduledTaskAccountOwner(owner);
    const k = query.offset + query.limit;
    if (query.taskId !== undefined && (typeof query.taskId !== "string" || !query.taskId.trim())
      || !Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || !Number.isSafeInteger(k)) {
      throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_INVALID", "", "", "history_query");
    }
    const items: AccountScheduledTaskRunLocation[] = []; let total = 0;
    const scopeIds = listAccountScheduledTaskRunSources();
    for (const workspaceId of scopeIds) readTasks(workspaceId, repos => repos.db.transaction(() => {
      let count = 0;
      for (let offset = 0; offset < k; offset += 200) {
        const page = repos.runs.listAccountHistory(owner, { ...query, offset, limit: Math.min(200, k - offset) });
        count = page.total; for (const run of page.items) items.push({ workspaceId, run });
        if (offset + page.items.length >= page.total) break;
      }
      total += count;
    })(), () => undefined);
    const expected = new Map<string, WorkspaceId | null>();
    for (const { run, workspaceId } of items) {
      if (expected.has(run.id)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", run.taskId, run.id, "physical_run_id_collision");
      expected.set(run.id, workspaceId);
    }
    const ids = [...expected.keys()], seen = new Set<string>();
    if (ids.length) for (const workspaceId of scopeIds) readTasks(workspaceId, repos => repos.db.transaction(() => {
      for (let offset = 0; offset < ids.length; offset += 200) for (const id of repos.runs.listAccountRunIds(owner, ids.slice(offset, offset + 200))) {
        if (seen.has(id) || expected.get(id) !== workspaceId) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", "", id, "physical_run_id_collision");
        seen.add(id);
      }
    })(), () => undefined);
    if (seen.size !== ids.length) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", "", "", "physical_run_missing");
    items.sort((a,b) => b.run.createdAt-a.run.createdAt || compareTaskText(b.run.id,a.run.id) || compareTaskText(a.workspaceId??"",b.workspaceId??""));
    return { total, items: items.slice(query.offset, k).map(item => item.run) };
  };
  /** 同 owner/task 聚合水位与指针；running/延期必须各自只有一个物理位置。 */
  const readAccountScheduledTaskState: ClientDb["readAccountScheduledTaskState"] = (taskId, owner) => {
    scheduledTaskAccountRuntimeKey(taskId, owner);
    const locations: AccountScheduledTaskLocation[] = [];
    for (const workspaceId of sources()) {
      const runtime = readTasks(workspaceId, repos => repos.runtime.getAccount(taskId, owner), () => null);
      if (runtime) locations.push({ workspaceId, runtime });
    }
    const running = locations.filter(item => item.runtime.runningRunId !== null), queued = locations.filter(item => item.runtime.queuedScheduledAt !== null);
    if (running.length > 1 || queued.length > 1) throw Object.assign(new Error("账号任务存在多个运行或延期位置"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId, field: "physical_runtime_collision" });
    let lastWorkflowSequence: number | null = null, lastScheduledAt: number | null = null;
    for (const { runtime } of locations) {
      if (runtime.lastScheduledAt !== null) lastScheduledAt = Math.max(lastScheduledAt ?? 0, runtime.lastScheduledAt);
      if (runtime.lastWorkflowSequence === null) continue;
      lastWorkflowSequence = Math.max(lastWorkflowSequence ?? 0, runtime.lastWorkflowSequence);
    }
    const pointers = new Set(locations.filter(item => lastWorkflowSequence !== null && item.runtime.lastWorkflowSequence === lastWorkflowSequence).map(item => item.runtime.lastWorkflowInstanceId));
    if (pointers.size > 1) throw Object.assign(new Error("账号上一流程顺序冲突"), { code: "SCHEDULED_TASK_RUNTIME_CORRUPT", taskId, field: "workflow_sequence_collision" });
    const lastWorkflowInstanceId = pointers.values().next().value ?? null;
    return { locations, running: running[0] ?? null, queued: queued[0] ?? null, lastScheduledAt, lastWorkflowInstanceId, lastWorkflowSequence };
  };
  /** 当前 owner 延期跨注册库读取，旧 bare key 与其他账号不接管。 */
  const listAccountScheduledMigrationQueued: ClientDb["listAccountScheduledMigrationQueued"] = owner => {
    const result: AccountScheduledTaskLocation[] = [];
    for (const workspaceId of sources()) for (const runtime of readTasks(workspaceId, repos => repos.runtime.listAccountStates(owner), () => [])) {
      if (runtime.queuedScheduledAt !== null) result.push({ workspaceId, runtime });
    }
    for (const { runtime } of result) readAccountScheduledTaskState(runtime.taskId, owner);
    return result.sort((a,b) => a.runtime.queuedScheduledAt! - b.runtime.queuedScheduledAt! || compareTaskText(a.runtime.taskId,b.runtime.taskId));
  };
  /** Inspector保留全部owner活动事实；98有关联历史时按原owner严格核认领。 */
  const listAccountScheduledRunning: ClientDb["listAccountScheduledRunning"] = (workspaceId, operationId) => readTasks(workspaceId,
    repos => repos.runtime.listAccountStates().filter(runtime => runtime.runningRunId !== null).map(runtime => {
      if (Number(repos.db.pragma("user_version", { simple: true })) >= 98) {
        const run = repos.runs.getAccount(runtime.runningRunId!, runtime.owner!);
        if (run && (run.taskId !== runtime.taskId || run.status !== "running")) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", runtime.taskId, runtime.runningRunId!, "runtime_run");
      }
      return { taskId: runtime.taskId, runId: runtime.runningRunId! };
    }), () => [], operationId);
  /** gate owner 仅允许固定延期输入，不将任意业务 callback 带入写豁免。 */
  const deferAccountScheduledTask: ClientDb["deferAccountScheduledTask"] = input => {
    const key = scheduledTaskAccountRuntimeKey(input.taskId, input.owner);
    if (!Number.isSafeInteger(input.scheduledAt) || input.scheduledAt < 0 || !Number.isSafeInteger(input.at) || input.at < 0
      || input.skippedRun && !input.skipped || Boolean(input.skippedRun) !== Boolean(input.taskName)) throw new Error("SCHEDULED_TASK_ACCOUNT_DEFER_INVALID");
    withWorkspaceDb(input.workspaceId, database => database.transaction(() => {
      const { runtime, runs } = taskRepos(database, input.workspaceId);
      runtime.getAccount(input.taskId, input.owner);
      if (input.skipped) {
        if (input.skippedRun) {
          if (input.skippedRun.taskId !== input.taskId || input.skippedRun.status !== "skipped" || input.skippedRun.scheduledAt !== input.scheduledAt
            || input.skippedRun.finishedAt !== input.at || !input.taskName) throw new Error("SCHEDULED_TASK_ACCOUNT_DEFER_INVALID");
          runs.createAccount({ run: input.skippedRun, owner: input.owner, taskName: input.taskName });
        }
        runtime.skipAccount(input);
      }
      else runtime.queueForWorkspaceMigration({ ...input, taskId: key, clientId: input.owner.clientId, deviceId: input.owner.deviceId });
    })(), { defer: true, task: true, operationId: input.operationId });
  };
  /** 先按身份元数据跨实际库查重，再解码唯一配置；历史 owner 在正文解码前核验。 */
  const getLocalScheduledTask = (taskId: string, device?: TaskDevice): LocalScheduledTaskConfig | null => {
    if (typeof taskId !== "string" || !taskId.trim()) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", "", "id");
    let found: { workspaceId: WorkspaceId | null; clientId: string; deviceId: string } | undefined;
    for (const workspaceId of sources()) {
      const identity = readTasks(workspaceId, repos => repos.configs.getIdentity(taskId), () => null);
      if (!identity) continue;
      if (found) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT", taskId, "physical_task_id_collision");
      found = { workspaceId, ...identity };
    }
    if (!found || device && (found.clientId !== device.clientId || found.deviceId !== device.deviceId)) return null;
    return readTasks(found.workspaceId, repos => repos.configs.get(taskId), () => null);
  };
  /** 本设备候选先跨全部身份唯一定位置，墓碑同样参与，再按稳定顺序聚合。 */
  const listLocalScheduledTaskConfigs: ClientDb["listLocalScheduledTaskConfigs"] = device => {
    const items: Array<{ task: LocalScheduledTaskConfig; workspaceId: WorkspaceId | null }> = [];
    for (const workspaceId of sources()) for (const task of readTasks(workspaceId, repos => repos.configs.list(device, true), () => [])) {
      getLocalScheduledTask(task.id);
      if (task.deletedAt === null && (workspaceId === null || workspaces.get(workspaceId))) items.push({ task, workspaceId });
    }
    items.sort((a,b) => b.task.updatedAt-a.task.updatedAt || compareTaskText(a.task.id,b.task.id) || compareTaskText(a.workspaceId??"",b.workspaceId??""));
    return items.map(item => item.task);
  };
  /** 当前配置含墓碑先核唯一归属，每库沿原 200 页读取前 K；保留相同 runId 物理事实。 */
  const listLocalScheduledTaskRuns: ClientDb["listLocalScheduledTaskRuns"] = query => {
    if (typeof query.clientId !== "string" || !query.clientId.trim() || typeof query.deviceId !== "string" || !query.deviceId.trim()) {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", query.taskId ?? "", "device");
    }
    const k = query.offset + query.limit;
    if (!Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || !Number.isSafeInteger(k)) {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID", query.taskId ?? "", "pagination");
    }
    const located = query.taskId !== undefined ? getLocalScheduledTask(query.taskId, query) : undefined;
    if (query.taskId !== undefined && !located) return { items: [], total: 0 };
    const scopeIds = located ? [located.workspaceScope?.scopeId as WorkspaceId | undefined ?? null] : sources();
    if (!located) for (const workspaceId of scopeIds) {
      for (const task of readTasks(workspaceId, repos => repos.configs.list(query, true), () => [])) getLocalScheduledTask(task.id, query);
    }
    const items: Array<{ run: LocalScheduledTaskRun; workspaceId: WorkspaceId | null }> = [];
    let total = 0;
    for (const workspaceId of scopeIds) readTasks(workspaceId, repos => repos.db.transaction(() => {
      let count = 0;
      for (let offset=0; offset < k; offset += 200) {
        const page = repos.runs.listLocalHistory({ ...query, offset, limit: Math.min(200,k-offset) });
        count = page.total; for (const run of page.items) items.push({ run, workspaceId });
        if (offset + page.items.length >= page.total) break;
      }
      total += count;
    })(), () => undefined);
    items.sort((a,b) => b.run.createdAt-a.run.createdAt || compareTaskText(b.run.id,a.run.id) || compareTaskText(a.workspaceId??"",b.workspaceId??""));
    return { total, items: items.slice(query.offset,k).map(item => item.run) };
  };
  /** 已知本机任务只在自身物理库读取 runtime，不接管应用库旧 workspace key。 */
  const getLocalScheduledTaskRuntime: ClientDb["getLocalScheduledTaskRuntime"] = task => readTasks(task.workspaceScope?.scopeId as WorkspaceId | undefined ?? null,
    repos => repos.runtime.get(scheduledTaskRuntimeKey(task.id,"local")), () => null);
  /** 活动检查仅读目标库；owner 必须来自同 gate，停删配置仍保留 running。 */
  const listLocalScheduledRunning: ClientDb["listLocalScheduledRunning"] = (workspaceId,device,operationId) => readTasks(workspaceId, repos =>
    repos.runtime.listLocalRunning(device).map(runtime => {
      const task = repos.configs.get(runtime.taskId);
      if (!task) throw Object.assign(new Error("本机 running 缺少配置证据"), { code:"SCHEDULED_TASK_LOCAL_CONFIG_MISSING",taskId:runtime.taskId,runId:runtime.runningRunId,workspaceId });
      return { taskId:task.id,runId:runtime.runningRunId! };
    }), () => [], operationId);
  /** 迁移 owner 只能执行固定延期或 skipped 事务，不向普通 callback 开放写豁免。 */
  const deferLocalScheduledTask: ClientDb["deferLocalScheduledTask"] = input => {
    const workspaceId = input.task.workspaceScope?.scopeId as WorkspaceId | undefined;
    if (!workspaceId) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID",input.task.id,"workspaceScope");
    if (!Number.isSafeInteger(input.scheduledAt) || input.scheduledAt < 0 || !Number.isSafeInteger(input.at) || input.at < 0
      || input.skippedRun && (input.task.concurrencyPolicy !== "skip_if_running" || input.skippedRun.status !== "skipped"
        || input.skippedRun.taskId !== input.task.id || input.skippedRun.scheduledAt !== input.scheduledAt
        || input.skippedRun.triggerSource !== "schedule" || input.skippedRun.clientId !== input.task.clientId || input.skippedRun.deviceId !== input.task.deviceId
        || input.skippedRun.workspaceId !== workspaceId) || !input.skippedRun && input.task.concurrencyPolicy !== "queue_one") {
      throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_INVALID",input.task.id,"defer_input");
    }
    withWorkspaceDb(workspaceId,database => {
      const repos=taskRepos(database,workspaceId);
      repos.db.transaction(() => {
        const current=repos.configs.get(input.task.id);
        if (!current?.enabled || current.deletedAt !== null || current.revision !== input.task.revision
          || current.clientId!==input.task.clientId || current.deviceId!==input.task.deviceId) throw new ScheduledTaskConfigError("SCHEDULED_TASK_CONFIG_CONFLICT",input.task.id,"revision");
        if (input.skippedRun) {
          repos.runs.create({run:input.skippedRun,expectedConfigRevision:current.revision});
          repos.runtime.markSkipped({taskId:scheduledTaskRuntimeKey(current.id,"local"),clientId:current.clientId,deviceId:current.deviceId,scheduledAt:input.scheduledAt,at:input.at});
          if (repos.runtime.get(scheduledTaskRuntimeKey(current.id,"local"))?.lastScheduledAt !== input.scheduledAt) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED",current.id,input.skippedRun.id,"skip_watermark");
        } else repos.runtime.queueForWorkspaceMigration({taskId:scheduledTaskRuntimeKey(current.id,"local"),clientId:current.clientId,deviceId:current.deviceId,scheduledAt:input.scheduledAt,operationId:input.operationId,at:input.at});
      })();
    },{defer:true,task:true,operationId:input.operationId});
  };
  const blobs = new FileBlobRepo(db);
  const fileChanges = new TurnFileChangeRepo(db, blobs);
  const rollbacks = new ThreadRollbackRepo(db);
  const threadStateBindings = new ThreadStateBindingRepo(db);
  const terminalConfigs = new TerminalConfigRepo(db);
  const threadDrafts = new ThreadDraftRepo(db, blobs);
  const threadMessageQueue = new ThreadMessageQueueRepo(db, blobs);
  const threadQueueStates = new ThreadQueueStateRepo(db);
  /** 核心仓储共享连接与屏障通知；应用注册、凭据和迁移权威继续使用应用库。 */
  const buildWorkspaceCoreRepos = (database: SqliteDb): WorkspaceCoreRepos => {
    const blobs = new FileBlobRepo(database);
    const summaries = new OrchInstanceSummaryProjectionReader(database);
    const listStates = new OrchIntakeListStateRepo(database, summaries);
    const sessions = new OrchRequirementAnalysisSessionRepo(database);
    return {
      db: database,
      threads: new ThreadRepo(database, opts?.resolveEngineModels),
      conversationEvents: new ConversationEventRepo(database, { localCanonicalEvents: opts?.localCanonicalEvents, onRelayInvalidation: opts?.onRelayInvalidation }),
      rawEvents: new RawEngineEventRepo(database),
      turns: new ThreadTurnRepo(database),
      threadReminderStates: new ThreadReminderStateRepo(database),
      reminderReceipts: new ReminderReceiptRepo(database),
      reminderIgnores: new ReminderIgnoreRepo(database),
      dingTalkReminderNotifications: new DingTalkReminderNotificationRepo(database),
      weComReminderNotifications: new WeComReminderNotificationRepo(database),
      blobs,
      fileChanges: new TurnFileChangeRepo(database, blobs),
      rollbacks: new ThreadRollbackRepo(database),
      threadStateBindings: new ThreadStateBindingRepo(database),
      threadDrafts: new ThreadDraftRepo(database, blobs),
      threadMessageQueue: new ThreadMessageQueueRepo(database, blobs),
      threadQueueStates: new ThreadQueueStateRepo(database),
      orchRoles: new OrchRoleRepo(database),
      orchWorkflows: new OrchWorkflowRepo(database),
      orchToolsets: new OrchToolsetRepo(database),
      orchSkills: new OrchSkillRepo(database),
      orchKnowledgeBundles: new OrchKnowledgeBundleRepo(database),
      orchIntakes: new OrchIntakeRepo(database, listStates),
      orchIntakeListStates: listStates,
      orchProposals: new OrchProposalRepo(database),
      orchInstances: new OrchInstanceRepo(database, listStates, summaries),
      orchArtifacts: new OrchArtifactRepo(database),
      orchEvents: new OrchEventRepo(database),
      orchFeedback: new OrchFeedbackRepo(database),
      orchPromptSnapshots: new OrchPromptSnapshotRepo(database),
      orchGateEvaluationRuns: new OrchGateEvaluationRunRepo(database),
      orchArtifactFiles: new OrchArtifactFileRepo(database),
      orchArtifactFields: new OrchArtifactFieldRepo(database),
      orchNodeContextResolutions: new OrchNodeContextResolutionRepo(database),
      orchNodeAttempts: new OrchNodeAttemptRepo(database),
      orchNodeWorkItems: new OrchNodeWorkItemRepo(database),
      orchAssetGenerationJobs: new OrchAssetGenerationJobRepo(database),
      orchAssetDrafts: new OrchAssetDraftRepo(database),
      orchAssetJobEvents: new OrchAssetJobEventRepo(database),
      orchAssetVersions: new OrchAssetVersionRepo(database),
      orchAssetGroups: new OrchAssetGroupRepo(database),
      orchRequirementAnalysisSessions: sessions,
      orchRequirementAnalysisMessages: new OrchRequirementAnalysisMessageRepo(database),
      orchRequirementCandidateDrafts: new OrchRequirementCandidateDraftRepo(database, sessions),
      codeAttributionOutbox: new CodeAttributionOutboxRepo(database),
      codeAttributionRetentionTasks: new CodeAttributionRetentionTaskRepo(database),
    };
  };
  const workspaceViews = new Map<WorkspaceId, ClientDb>();
  /** 已有视图沿同步调用栈复用连接；首次初始化仍由原 opener 持有生命周期。 */
  const withWorkspaceCoreRepos: ClientDb["withWorkspaceCoreRepos"] = (workspaceId, operation) => {
    const view = workspaceViews.get(workspaceId);
    if (view) return view.withWorkspaceCoreRepos(workspaceId, operation);
    return withWorkspaceDb(workspaceId, database => {
      prepareWorkspaceCoreConnection(database, workspaceId);
      return operation(buildWorkspaceCoreRepos(database));
    }, { core: true });
  };
  /** 只读视图保留工作区 owner，替换为只读仓储；不初始化或跨异步边界持有连接。 */
  const forWorkspace: ClientDb["forWorkspace"] = (workspaceId, options) => {
    const readonly = options?.readonly === true;
    const existing = workspaceViews.get(workspaceId);
    if (existing && !readonly) return existing;
    if (!readonly) withWorkspaceCoreRepos(workspaceId, () => undefined);
    const scoped = createWorkspaceSqliteDb(operation => withWorkspaceDb(workspaceId, database => {
      if (readonly) {
        const version = database.prepare("SELECT value FROM meta WHERE key='workspace_core_schema_version'").get() as { value: string } | undefined;
        if (version?.value !== "1") throw new Error("WORKSPACE_CORE_SCHEMA_VERSION_UNSUPPORTED");
      } else {
        prepareWorkspaceCoreConnection(database, workspaceId);
      }
      return operation(database);
    }, { core: true, readonly }));
    const coreRepos = buildWorkspaceCoreRepos(scoped);
    const view: ClientDb = { ...(existing ?? client), ...coreRepos, workspaceId,
      /** 同一工作区的写视图只在本次同步回调中共享连接；只读或其他工作区沿原入口。 */
      withWorkspaceCoreRepos: (target, operation) => target === workspaceId && !readonly
        ? scoped.withConnection(() => operation(coreRepos))
        : withWorkspaceCoreRepos(target, operation),
      terminalConfigs: new TerminalConfigRepo(scoped),
      controlledExperiments: new ControlledExperimentRepo(scoped), orchAssigneeTemplates: new OrchAssigneeTemplateRepo(scoped),
      orchWorkflowExecutionDefaults: new OrchWorkflowExecutionDefaultRepo(scoped),
    };
    if (!readonly) workspaceViews.set(workspaceId, view);
    return view;
  };
  const presentationBuilds = new Map<string, Promise<void>>();
  /** 热读只探测索引；首次缺失才进入已有 schema owner 和写入构建，合并同线程并发请求。 */
  const ensureThreadPresentation: ClientDb["ensureThreadPresentation"] = async (workspaceId, threadId, opts) => {
    /** 只读探测、writer初始化与重建各批次复用同一协调入口。 */
    const access = <T>(operation: () => T): Promise<T> => opts?.withDatabase ? opts.withDatabase(operation) : Promise.resolve(operation());
    if (await access(() => forWorkspace(workspaceId, { readonly: true }).conversationEvents.isPresentationReady(threadId))) return;
    const key = JSON.stringify([workspaceId, threadId]);
    const pending = presentationBuilds.get(key);
    if (pending) return await pending;
    const build = (async () => {
      const events = await access(() => forWorkspace(workspaceId).conversationEvents);
      await events.ensurePresentation(threadId, opts);
    })();
    presentationBuilds.set(key, build);
    try { await build; }
    finally { presentationBuilds.delete(key); }
  };
  /** 整组本地资产写入固定工作区事务；嵌套仓储共享同一提交。 */
  const withWorkspaceAssetWrite: ClientDb["withWorkspaceAssetWrite"] = (workspaceId, operation) => {
    const view = forWorkspace(workspaceId);
    return view.db.transaction(() => synchronousTaskResult(operation(view)))();
  };
  /** 迁移 owner 的只读短快照不修库；从未初始化核心库时只返回无持久执行事实。 */
  const withWorkspaceCoreSnapshot: ClientDb["withWorkspaceCoreSnapshot"] = (workspaceId, operationId, operation) =>
    withWorkspaceDb(workspaceId, database => {
      const hasCore = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get();
      if (!hasCore) return operation(null);
      const version = database.prepare("SELECT value FROM meta WHERE key='workspace_core_schema_version'").get() as { value: string } | undefined;
      if (version?.value !== "1") throw new Error("WORKSPACE_CORE_SCHEMA_VERSION_UNSUPPORTED");
      const view: ClientDb = { ...client, ...buildWorkspaceCoreRepos(database), workspaceId,
        controlledExperiments: new ControlledExperimentRepo(database), terminalConfigs: new TerminalConfigRepo(database) };
      return database.transaction(() => synchronousTaskResult(operation(view)))();
    }, { readonly: true, operationId, core: true, includeDeleted: true, whenMissing: () => synchronousTaskResult(operation(null)) });
  /** 兼容既有队列入口，但只检查指定工作区，绝不按裸 ID 扫描其他库。 */
  const workspaceCoreRouter: ClientDb["workspaceCoreRouter"] = (workspaceId, threadId) => {
    const view = forWorkspace(workspaceId);
    return view.threads.get(threadId) ? view : null;
  };
  const engineKeys = new EngineKeyRepo(db);
  const engineCustomModels = new EngineCustomModelRepo(db);
  const orchRoles = new OrchRoleRepo(db);
  const orchWorkflows = new OrchWorkflowRepo(db);
  const orchAssigneeTemplates = new OrchAssigneeTemplateRepo(db);
  const orchWorkflowExecutionDefaults = new OrchWorkflowExecutionDefaultRepo(db);
  const orchToolsets = new OrchToolsetRepo(db);
  const orchSkills = new OrchSkillRepo(db);
  const orchKnowledgeBundles = new OrchKnowledgeBundleRepo(db);
  const orchInstanceSummaries = new OrchInstanceSummaryProjectionReader(db);
  const orchIntakeListStates = new OrchIntakeListStateRepo(db, orchInstanceSummaries);
  const orchIntakes = new OrchIntakeRepo(db, orchIntakeListStates);
  const orchProposals = new OrchProposalRepo(db);
  const orchInstances = new OrchInstanceRepo(db, orchIntakeListStates, orchInstanceSummaries);
  const orchArtifacts = new OrchArtifactRepo(db);
  const orchEvents = new OrchEventRepo(db);
  const orchFeedback = new OrchFeedbackRepo(db);
  const orchPromptSnapshots = new OrchPromptSnapshotRepo(db);
  const orchGateEvaluationRuns = new OrchGateEvaluationRunRepo(db);
  const orchArtifactFiles = new OrchArtifactFileRepo(db);
  const orchArtifactFields = new OrchArtifactFieldRepo(db);
  const orchNodeContextResolutions = new OrchNodeContextResolutionRepo(db);
  const orchNodeAttempts = new OrchNodeAttemptRepo(db);
  const orchNodeWorkItems = new OrchNodeWorkItemRepo(db);
  const orchAssetGenerationJobs = new OrchAssetGenerationJobRepo(db);
  const orchAssetDrafts = new OrchAssetDraftRepo(db);
  const orchAssetJobEvents = new OrchAssetJobEventRepo(db);
  const orchAssetVersions = new OrchAssetVersionRepo(db);
  const orchAssetGroups = new OrchAssetGroupRepo(db);
  const orchRequirementAnalysisSessions = new OrchRequirementAnalysisSessionRepo(db);
  const orchRequirementAnalysisMessages = new OrchRequirementAnalysisMessageRepo(db);
  const orchRequirementCandidateDrafts = new OrchRequirementCandidateDraftRepo(db, orchRequirementAnalysisSessions);
  const controlledExperiments = new ControlledExperimentRepo(db);
  const workspaceDirectoryMigrations = new WorkspaceDirectoryMigrationRepo(db);
  const codeAttributionOutbox = new CodeAttributionOutboxRepo(db);
  const codeAttributionRetentionTasks = new CodeAttributionRetentionTaskRepo(db);

  const client: ClientDb = {
    db,
    applicationDb: db,
    workspaceId: null,
    configureLegacyAccessGuard,
    configureWorkspaceLogResolver(resolve) { resolveRuntimeWorkspaceLogRoot = resolve; },
    closeWorkspaceConnections,
    forWorkspace,
    ensureThreadPresentation,
    withWorkspaceAssetWrite,
    acquireWorkspaceReaderSource,
    withWorkspaceCoreSnapshot,
    workspaces,
    withWorkspaceExecutionProfiles,
    withWorkspacePrefs,
    withWorkspaceCoreRepos,
    workspaceCoreRouter,
    withLocalScheduledTasks,
    withAccountScheduledTasks,
    replaceAccountScheduledTaskConfigs,
    listAccountScheduledTaskConfigs,
    readAccountScheduledTaskState,
    listAccountScheduledMigrationQueued,
    listAccountScheduledRunning,
    listAccountScheduledTaskRunSources,
    getAccountScheduledTaskRun,
    listPendingAccountScheduledTaskRuns,
    deferAccountScheduledTask,
    getLocalScheduledTask,
    rebindLocalScheduledTasksForDesktopReinstall,
    listLocalScheduledTaskConfigs,
    listLocalScheduledTaskRuns,
    listAccountScheduledTaskRuns,
    getLocalScheduledTaskRuntime,
    listLocalScheduledRunning,
    deferLocalScheduledTask,
    threads,
    conversationEvents,
    rawEvents,
    turns,
    threadReminderStates,
    reminderReceipts,
    reminderIgnores,
    dingTalkReminderNotifications,
    weComReminderNotifications,
    scheduledTaskRuntimeStates,
    scheduledTaskConfigs,
    scheduledTaskRuns,
    blobs,
    fileChanges,
    rollbacks,
    threadStateBindings,
    terminalConfigs,
    threadDrafts,
    threadMessageQueue,
    threadQueueStates,
    engineKeys,
    engineCustomModels,
    orchRoles,
    orchWorkflows,
    orchAssigneeTemplates,
    orchWorkflowExecutionDefaults,
    orchToolsets,
    orchSkills,
    orchKnowledgeBundles,
    orchIntakes,
    orchIntakeListStates,
    orchProposals,
    orchInstances,
    orchArtifacts,
    orchEvents,
    orchFeedback,
    orchPromptSnapshots,
    orchGateEvaluationRuns,
    orchArtifactFiles,
    orchArtifactFields,
    orchNodeContextResolutions,
    orchNodeAttempts,
    orchNodeWorkItems,
    orchAssetGenerationJobs,
    orchAssetDrafts,
    orchAssetJobEvents,
    orchAssetVersions,
    orchAssetGroups,
    orchRequirementAnalysisSessions,
    orchRequirementAnalysisMessages,
    orchRequirementCandidateDrafts,
    controlledExperiments,
    workspaceDirectoryMigrations,
    codeAttributionOutbox,
    codeAttributionRetentionTasks,
    writeWorkspaceLog,
    /** 仅重试 SQLite 对象；fd 收口未确认显式失败，仍独立关闭应用库。 */
    close: () => {
      closing = true;
      const failures: unknown[] = [];
      try { closeWorkspaceConnections(); } catch (error) { failures.push(error); }
      for (const [workspaceId, resource] of failedProfileResources) {
        if (!resource.close) { failures.push(resource.failure); continue; }
        try { resource.close(); resource.release(); failedProfileResources.delete(workspaceId); }
        catch (error) { failures.push(new AggregateError([resource.failure, error], "WORKSPACE_PROFILE_CLEANUP_FAILED", { cause: resource.failure })); }
      }
      try { db.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "CLIENT_DB_CLOSE_FAILED");
    },
  };
  return client;
}

const workspaceConnectionScopes = new WeakMap<SqliteDb, { workspaceId: WorkspaceId; schemaVersion: unknown }>();

/** 已验证连接仅复核scope与schema代次，避免每批重复枚举全部表和初始化投影。 */
function prepareWorkspaceCoreConnection(database: SqliteDb, workspaceId: WorkspaceId): void {
  if (!workspaceConnectionScopes.has(database)) {
    ensureWorkspaceCoreQueueTables(database);
    ensureWorkspaceAdditionalTables(database);
  }
  constrainWorkspaceCoreWrites(database, workspaceId);
}

/** 同次读取列元数据后装配连接局部约束；FTS 归属仍由原本地父记录派生。 */
function constrainWorkspaceCoreWrites(database: SqliteDb, workspaceId: WorkspaceId): void {
  const schemaVersion = database.pragma("schema_version", { simple: true });
  const existing = workspaceConnectionScopes.get(database);
  if (existing) {
    if (existing.workspaceId !== workspaceId || existing.schemaVersion !== schemaVersion) throw new Error("WORKSPACE_CORE_CONNECTION_SCHEMA_CHANGED");
    return;
  }
  const tables = [...WORKSPACE_CORE_TABLES, ...WORKSPACE_ADDITIONAL_TABLES];
  const columns = database.prepare(`WITH targets(name) AS (VALUES ${tables.map(() => "(?)").join(",")})
    SELECT targets.name AS table_name FROM targets JOIN pragma_table_info(targets.name) AS info
    WHERE info.name = 'workspace_id'`).all(...tables) as Array<{ table_name: string }>;
  const scopedTables = new Set(columns.map(column => column.table_name));
  const identity = `'${String(workspaceId).replaceAll("'", "''")}'`;
  const statements: string[] = [];
  for (const table of tables) {
    if (!scopedTables.has(table) || table.endsWith("_fts")) continue;
    for (const action of ["INSERT", "UPDATE"] as const) {
      statements.push(`CREATE TEMP TRIGGER "workspace_scope_${table}_${action}" BEFORE ${action} ON main."${table}"
        WHEN NEW.workspace_id IS NOT ${identity} BEGIN SELECT RAISE(ABORT, 'WORKSPACE_CORE_SCOPE_MISMATCH'); END`);
    }
  }
  if (statements.length) database.exec(statements.join(";\n"));
  workspaceConnectionScopes.set(database, { workspaceId, schemaVersion });
}

/** 语句和显式同步作用域共用原 opener；连接只在最外层回调存活。 */
function createWorkspaceSqliteDb(withDatabase: <T>(operation: (database: SqliteDb) => T) => T): SqliteDb & {
  withConnection: <T>(operation: (database: SqliteDb) => T) => T;
} {
  let active: SqliteDb | null = null;
  /** 嵌套同步操作复用当前连接，最外层操作完成即交回原关闭 owner。 */
  const execute = <T>(operation: (database: SqliteDb) => T): T => {
    if (active) return synchronousTaskResult(operation(active));
    return withDatabase(database => {
      active = database;
      try { return synchronousTaskResult(operation(database)); }
      finally { active = null; }
    });
  };
  return {
    /** 复用调用栈内连接，拒绝异步结果；不隐式开启或延长 SQL 事务。 */
    withConnection: execute,
    /** 延迟编译，缓存的语句只保存 SQL；迭代结果在连接关闭前物化。 */
    prepare: sql => ({
      get: (...params) => execute(database => database.prepare(sql).get(...params)),
      all: (...params) => execute(database => database.prepare(sql).all(...params)),
      run: (...params) => execute(database => database.prepare(sql).run(...params)),
      iterate: (...params) => execute(database => database.prepare(sql).all(...params))[Symbol.iterator](),
    }),
    exec: sql => execute(database => database.exec(sql)),
    pragma: (sql, options) => execute(database => database.pragma(sql, options)),
    /** SQL 事务及嵌套 SAVEPOINT 仍由原 SqliteDb 管理；异步 callback 在提交前拒绝。 */
    transaction: (operation, options) => ((...args: unknown[]) => execute(database =>
      database.transaction(() => synchronousTaskResult(operation(...args)), options)())) as typeof operation,
    /** 视图没有长驻连接；实际资源只由 ClientDb.close 收口。 */
    close: () => { throw new Error("WORKSPACE_VIEW_CLOSE_REQUIRES_CLIENT_DB"); },
  };
}

/** 按码点比较稳定物理来源和标识，避免 locale 或注册顺序改变分页。 */
function compareTaskText(a: string,b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** 应用无 scope 分支同样拒绝异步 callback，避免返回成功后继续写入。 */
function synchronousTaskResult<T>(result: T): T {
  if (result != null && (typeof result === "object" || typeof result === "function") && typeof (result as {then?:unknown}).then === "function") {
    throw new Error("WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS");
  }
  return result;
}

/** 固定外层诊断携物理 workspace，原异常留 cause 供拥有上下文的边界记录。 */
function profileStorageFailure(workspaceId: WorkspaceId, cause: unknown): Error {
  return Object.assign(new Error("工作区执行 Profile 存储失败", { cause }), { code: "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED", workspaceId });
}

/** Profile 日志保留固定原因、原 helper 错误码及有界因果树，不输出任意异常正文。 */
export function describeWorkspaceProfileFailure(error: unknown, depth = 0): Record<string, unknown> {
  const details = error as { code?: unknown; errno?: unknown; errcode?: unknown } | null;
  const codes = ["WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED", "ERR_SQLITE_ERROR", "ERR_INVALID_STATE", "SQLITE_TRANSACTION_ROLLBACK_FAILED",
    "SQLITE_OPEN_CLEANUP_FAILED", "SQLITE_OPEN_CLEANUP_HANDOFF_FAILED", "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE",
    "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED", "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED", "EACCES", "EPERM", "ENOENT", "ENOSPC", "EBUSY", "EIO"];
  const reasons = ["CLIENT_DB_CLOSING", "CLIENT_DB_CLOSE_FAILED", "WORKSPACE_PROFILE_WORKSPACE_NOT_FOUND", "WORKSPACE_PROFILE_ORPHAN_SIDECAR",
    "WORKSPACE_PROFILE_FILE_REPLACED", "WORKSPACE_PROFILE_CALLBACK_MUST_BE_SYNCHRONOUS", "WORKSPACE_PROFILE_CLEANUP_FAILED",
    "WORKSPACE_DB_KIND_OR_VERSION_UNSUPPORTED", "WORKSPACE_DB_SCHEMA_INVALID", "WORKSPACE_DB_JOURNAL_MODE_INVALID",
    "SQLITE_OPEN_CLEANUP_FAILED", "SQLITE_OPEN_CLEANUP_HANDOFF_FAILED", "SQLITE_TRANSACTION_ROLLBACK_FAILED"];
  return { name: error instanceof Error && ["Error", "AggregateError", "TypeError", "RangeError", "SystemError",
      "WorkspaceCodeflowaiDirectoryError", "WorkspacePrivateRuntimeGitError"].includes(error.name) ? error.name : "Error",
    code: typeof details?.code === "string" && codes.includes(details.code) ? details.code : null,
    errno: typeof details?.errno === "number" ? details.errno : null,
    errcode: typeof details?.errcode === "number" ? details.errcode : null,
    reason: error instanceof Error && reasons.includes(error.message) ? error.message : "WORKSPACE_PROFILE_OPERATION_FAILED",
    ...(depth < 3 && error instanceof AggregateError ? { errors: error.errors.slice(0, 10).map(item => describeWorkspaceProfileFailure(item, depth + 1)) } : {}),
    ...(depth < 3 && error instanceof Error && error.cause !== undefined ? { cause: describeWorkspaceProfileFailure(error.cause, depth + 1) } : {}),
  };
}

/** 维护只读验主库且复核普通单链物理文件；SQLite 可重建自有 SHM 索引。 */
function assertExistingClientDbReadable(dbPath: string): () => void {
  const main = fs.lstatSync(dbPath);
  /** 原路径及主库身份不变；旁文件缺失合法，存在则必须属于该物理路径。 */
  const verify = (): void => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = `${dbPath}${suffix}`, stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat && suffix) continue;
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || path.resolve(fs.realpathSync(file)) !== path.resolve(file)
        || !suffix && (stat.ino !== main.ino || !isWorkspaceCodeflowaiFileDeviceMatch(stat.dev, main.dev))) {
        throw new Error("CLIENT_DB_EXISTING_FILE_UNSAFE");
      }
    }
  };
  verify();
  const probe = openSqliteDb(dbPath, { readonly: true, fileMustExist: true });
  let failure: unknown, hasFailure = false;
  try { probe.pragma("application_id", { simple: true }); }
  catch (error) { hasFailure = true; failure = error; throw error; }
  finally {
    try { probe.close(); }
    catch (closeError) {
      if (hasFailure) throw new AggregateError([failure, closeError], "CLIENT_DB_OPEN_CLEANUP_FAILED", { cause: failure });
      throw closeError;
    }
  }
  verify();
  return verify;
}

/** 打开并迁移 SQLite；维护路径禁止新建及隔离重试，普通路径保原授权。 */
function openMigratedSqliteDb(dbPath: string, existingOnly = false): SqliteDb {
  const verify = existingOnly ? assertExistingClientDbReadable(dbPath) : undefined;
  let db: SqliteDb | null = null;
  try {
    db = openSqliteDb(dbPath, { fileMustExist: existingOnly });
    verify?.();
    migrateClientDb(db);
    verify?.();
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "CLIENT_DB_OPEN_CLEANUP_FAILED", { cause: error });
    }
    db = null;

    if (existingOnly || !isSqliteFileNotDatabaseError(error)) throw error;
    let quarantined: QuarantinedSqliteSidecar[];
    try {
      quarantined = quarantineInvalidPlainSqliteSidecarsForRetry(dbPath);
    } catch (quarantineError) {
      throw new AggregateError([error, quarantineError], "CLIENT_DB_SIDECAR_QUARANTINE_FAILED", { cause: error });
    }
    if (!quarantined.length) throw error;

    const requestId = `client-db-open:${process.pid}:${randomUUID()}`;
    const retryContext = {
      requestId,
      dbPath,
      sidecars: quarantined.map((item) => ({ from: item.from, to: item.to })),
      retryAttempt: 1,
      maxRetries: 1,
      sidecarValidity: "unverified",
      impact: "wal_only_committed_transactions_may_be_unavailable",
      manualRecoveryGuide: "docs/superpowers/plans/2026-10-27-client-db-open-failure.md#manual-recovery",
    };
    const sqliteError = error as Error & { code: string; errcode: number };
    // 已授权的降级仅隔离保留文件；WAL 独有提交可能暂不可见，须按指引在副本上人工恢复。
    logger.warn("client-db", "SQLite WAL/SHM 已改名保留，将重试一次；未验证文件损坏，WAL 独有提交可能暂不可见；恢复前先停用并完整备份，勿直接覆盖", {
      ...retryContext,
      errorCode: "CLIENT_DB_SIDECAR_RETRY",
      event: { category: "database", action: "sidecar_retry", outcome: "start" },
      rootCause: { code: sqliteError.code, errcode: sqliteError.errcode, message: sqliteError.message },
    });

    try {
      db = openSqliteDb(dbPath);
      migrateClientDb(db);
      logger.info("client-db", "SQLite 隔离后重试开库完成；隔离文件仍保留，未验证 WAL 数据恢复完整性", {
        ...retryContext,
        event: { category: "database", action: "sidecar_retry", outcome: "success" },
        dataRecoveryVerified: false,
      });
      return db;
    } catch (retryError) {
      try {
        db?.close();
      } catch (closeError) {
        throw Object.assign(new AggregateError([error, retryError, closeError], "CLIENT_DB_RETRY_CLEANUP_FAILED", { cause: retryError }), {
          code: "CLIENT_DB_RETRY_CLEANUP_FAILED", ...retryContext,
        });
      }
      try {
        restoreQuarantinedSidecars(quarantined);
      } catch (restoreError) {
        throw Object.assign(new AggregateError([error, retryError, restoreError], "CLIENT_DB_SIDECAR_RESTORE_FAILED", { cause: retryError }), {
          code: "CLIENT_DB_SIDECAR_RESTORE_FAILED", ...retryContext,
        });
      }
      throw Object.assign(new AggregateError([error, retryError], "CLIENT_DB_SIDECAR_RETRY_FAILED", { cause: retryError }), {
        code: "CLIENT_DB_SIDECAR_RETRY_FAILED", ...retryContext,
      });
    }
  }
}

type QuarantinedSqliteSidecar = {
  from: string;
  to: string;
};

/** 改名保留本次 WAL/SHM，不判断损坏；部分移动失败须回滚，失败保留双因。 */
export function quarantineInvalidPlainSqliteSidecarsForRetry(dbPath: string): QuarantinedSqliteSidecar[] {
  if (!hasPlainSqliteHeader(dbPath)) return [];
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter((filePath) => fs.existsSync(filePath));
  if (!sidecars.length) return [];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined: QuarantinedSqliteSidecar[] = [];
  try {
    for (const sidecar of sidecars) {
      const target = nextAvailablePath(`${sidecar}.invalid-${stamp}`);
      fs.renameSync(sidecar, target);
      quarantined.push({ from: sidecar, to: target });
    }
  } catch (error) {
    try {
      restoreQuarantinedSidecars(quarantined);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "CLIENT_DB_SIDECAR_QUARANTINE_RESTORE_FAILED", { cause: error });
    }
    throw error;
  }
  return quarantined;
}

/** 连接关闭后逆序恢复本次隔离项；路径冲突或恢复失败均显式中止。 */
function restoreQuarantinedSidecars(items: QuarantinedSqliteSidecar[]): void {
  for (const item of [...items].reverse()) {
    if (fs.existsSync(item.from)) {
      throw Object.assign(new Error(`SQLite sidecar restore target already exists: ${item.from}`), { code: "EEXIST" });
    }
    fs.renameSync(item.to, item.from);
  }
}

export function hasPlainSqliteHeader(dbPath: string): boolean {
  const sqliteHeader = Buffer.from("SQLite format 3\0", "utf8");
  try {
    const fd = fs.openSync(dbPath, "r");
    try {
      const header = Buffer.alloc(sqliteHeader.length);
      const read = fs.readSync(fd, header, 0, header.length, 0);
      return read === sqliteHeader.length && header.equals(sqliteHeader);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function nextAvailablePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${filePath}.${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate SQLite sidecar quarantine path: ${filePath}`);
}

/** 仅按原生结构化 NOTADB 错误识别恢复资格，不根据消息文案推断。 */
function isSqliteFileNotDatabaseError(error: unknown): boolean {
  const err = error as { code?: unknown; errcode?: unknown } | null;
  return err?.code === "ERR_SQLITE_ERROR" && err.errcode === 26;
}
