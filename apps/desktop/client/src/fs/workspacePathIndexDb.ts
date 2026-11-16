import fs from "node:fs";
import path from "node:path";

import type { FsSearchIndexStatus } from "@codeflowai/shared";
import { openSqliteDb, type SqliteDb } from "../db/sqliteDb.js";
import {
  assertWorkspaceCodeflowaiDirectory,
  ensureWorkspaceCodeflowaiDirectory,
  inspectWorkspaceCodeflowaiFile,
  type WorkspaceCodeflowaiDirectoryIdentity,
} from "../codeflowai/workspaceCodeflowaiDirectory.js";
import {
  WORKSPACE_PATH_INDEX_APPLICATION_ID,
  WORKSPACE_PATH_INDEX_DATABASE_FILE,
  WORKSPACE_PATH_INDEX_DIRECTORY,
  WORKSPACE_PATH_INDEX_POLICY_STAMP,
  WORKSPACE_PATH_INDEX_SCHEMA_VERSION,
} from "./workspacePathIndexConfig.js";
import { ensureWorkspacePrivateRuntimeGitExclude, WorkspacePrivateRuntimeGitError } from "../git/workspacePrivateRuntimeGitExclude.js";
import { logger } from "../logger.js";

export type WorkspacePathIndexEntry = {
  path: string;
  name: string;
  isDir: boolean;
  hidden: boolean;
  parentEntryOrder: number;
};

export type WorkspacePathIndexStoredEntry = WorkspacePathIndexEntry & {
  pathKey: string;
  parentPathKey: string;
};

export type WorkspacePathIndexDbSettings = {
  configStamp: string;
  excludeRulesStamp: string;
  policyStamp?: string;
  maxEntries: number;
};

export type WorkspacePathIndexDbMeta = {
  workspaceId: string;
  workspaceRoot: string;
  workspaceRootKey: string;
  activeGeneration: number | null;
  activeIndexedCount: number;
  activeConfigStamp: string | null;
  activeExcludeRulesStamp: string | null;
  activePolicyStamp: string | null;
  buildGeneration: number | null;
  buildConfigStamp: string | null;
  buildExcludeRulesStamp: string | null;
  buildPolicyStamp: string | null;
  buildTruncated: boolean;
  nextGeneration: number;
  mutationSeq: number;
  status: FsSearchIndexStatus;
  partial: boolean;
  maxEntries: number;
  message: string | null;
};

export type WorkspacePathIndexDbSearchPage = {
  entries: WorkspacePathIndexStoredEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type WorkspacePathIndexDbMutation =
  | { type: "upsert"; entry: WorkspacePathIndexEntry; forcesStale?: boolean }
  | { type: "delete"; path: string; recursive: true; forcesStale?: boolean };

export type WorkspacePathIndexDbMutationOptions = {
  staleIfDirectoryPaths?: readonly string[];
};

export type WorkspacePathIndexDbErrorCode =
  | WorkspacePathIndexStorageErrorCode
  | "WORKSPACE_FILE_INDEX_OPEN_FAILED"
  | "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE"
  | "WORKSPACE_FILE_INDEX_METADATA_MISMATCH"
  | "WORKSPACE_FILE_INDEX_CORRUPT"
  | "WORKSPACE_FILE_INDEX_STALE_GENERATION";

export type WorkspacePathIndexStorageErrorCode = "WORKSPACE_FILE_INDEX_PATH_UNSAFE" | "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED" | "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED";

/** 仅识别本模块与冻结 Git 边界的稳定保护码，供 Worker 传递和 Service 收口。 */
export function workspacePathIndexStorageErrorCode(error: unknown): WorkspacePathIndexStorageErrorCode | null {
  if (!(error instanceof WorkspacePathIndexDbError) && !(error instanceof WorkspacePrivateRuntimeGitError)) return null;
  return isWorkspacePathIndexStorageErrorCode(error.code) ? error.code : null;
}

/** Worker 传输值必须落入受限保护码集合，不能依据异常正文推断。 */
export function isWorkspacePathIndexStorageErrorCode(value: unknown): value is WorkspacePathIndexStorageErrorCode {
  return value === "WORKSPACE_FILE_INDEX_PATH_UNSAFE" || value === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED" || value === "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED";
}

export class WorkspacePathIndexDbError extends Error {
  constructor(
    readonly code: WorkspacePathIndexDbErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspacePathIndexDbError";
  }
}

type OpenWorkspacePathIndexDbInput = {
  workspaceId: string;
  workspacePath: string;
  settings: WorkspacePathIndexDbSettings;
};

type MetaRow = {
  workspace_id: string;
  workspace_root: string;
  workspace_root_key: string;
  active_generation: number | null;
  active_indexed_count: number;
  active_config_stamp: string | null;
  active_exclude_rules_stamp: string | null;
  active_policy_stamp: string | null;
  build_generation: number | null;
  build_config_stamp: string | null;
  build_exclude_rules_stamp: string | null;
  build_policy_stamp: string | null;
  build_truncated: number;
  next_generation: number;
  mutation_seq: number;
  status: FsSearchIndexStatus;
  partial: number;
  max_entries: number;
  message: string | null;
};

const SQLITE_CACHE_KIB = 8 * 1024;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 256;
const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_LIMIT = 100;
const PUBLISH_MUTATION_BATCH_SIZE = 256;
const CLEANUP_BATCH_SIZE = 1_000;

/** 打开当前工作区专属索引库，并在信任条目前校验 schema 与工作区身份。 */
export function openWorkspacePathIndexDb(input: OpenWorkspacePathIndexDbInput): WorkspacePathIndexDb {
  const workspaceId = String(input.workspaceId ?? "").trim();
  if (!workspaceId) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_OPEN_FAILED", "workspace 文件索引缺少 workspaceId");
  const directoryIdentity = ensureWorkspacePathIndexDirectory(input.workspacePath);
  const workspaceRoot = directoryIdentity.workspaceRoot;
  const workspaceRootKey = workspacePathIndexRootKey(workspaceRoot);
  const indexDirectory = directoryIdentity.directoryPath;
  const indexPath = path.join(indexDirectory, WORKSPACE_PATH_INDEX_DATABASE_FILE);
  assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
  if (!fs.existsSync(indexPath) && workspacePathIndexSidecarPaths(indexPath).some((sidecarPath) => fs.existsSync(sidecarPath))) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_CORRUPT",
      "workspace 文件索引主库缺失但 SQLite sidecar 仍存在",
    );
  }

  let db: SqliteDb | null = null;
  try {
    assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
    db = openSqliteDb(indexPath, { busyTimeoutMs: 10_000 });
    assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
    configureConnection(db);
    assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
    initializeOrValidateSchema(db, { workspaceId, workspaceRoot, workspaceRootKey, settings: input.settings });
    assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
    return new WorkspacePathIndexDb(db, indexPath, workspaceRoot, workspaceRootKey, directoryIdentity);
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      throw new WorkspacePathIndexDbError(workspacePathIndexStorageErrorCode(error) ?? "WORKSPACE_FILE_INDEX_OPEN_FAILED", "打开 workspace 文件索引失败，且关闭连接失败", { cause: new AggregateError([error, closeError], "文件索引打开及清理均失败") });
    }
    if (error instanceof WorkspacePathIndexDbError || error instanceof WorkspacePrivateRuntimeGitError) throw error;
    throw new WorkspacePathIndexDbError(
      isCorruptSqliteError(error) ? "WORKSPACE_FILE_INDEX_CORRUPT" : "WORKSPACE_FILE_INDEX_OPEN_FAILED",
      `打开 workspace 文件索引失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** 把损坏或不兼容的主库与 sidecar 移到同目录 recovery 名称，随后可安全创建新库。 */
export function recoverWorkspacePathIndexDbFiles(workspacePath: string): { indexPath: string; recoveredPaths: string[] } {
  const directoryIdentity = ensureWorkspacePathIndexDirectory(workspacePath);
  const workspaceRoot = directoryIdentity.workspaceRoot;
  const indexDirectory = directoryIdentity.directoryPath;
  const indexPath = path.join(indexDirectory, WORKSPACE_PATH_INDEX_DATABASE_FILE);
  assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
  const sources = [indexPath, ...workspacePathIndexSidecarPaths(indexPath)];
  const existingSources = sources.filter((sourcePath) => fs.existsSync(sourcePath));
  if (!existingSources.length) return { indexPath, recoveredPaths: [] };
  const token = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const recoveryBase = `${indexPath}.recovery-${token}`;
  const recoveredPaths: string[] = [];
  try {
    for (const sourcePath of existingSources) {
      assertWorkspacePathIndexStorageLocation(workspaceRoot, indexDirectory, indexPath, directoryIdentity);
      const suffix = sourcePath.slice(indexPath.length);
      const targetPath = `${recoveryBase}${suffix}`;
      fs.renameSync(sourcePath, targetPath);
      if (!inspectWorkspaceCodeflowaiFile(directoryIdentity, path.basename(targetPath))) {
        throw workspacePathIndexUnsafeError(`无法复核隔离后的 workspace 文件索引工件：${path.basename(targetPath)}`);
      }
      assertWorkspaceCodeflowaiDirectory(directoryIdentity);
      recoveredPaths.push(targetPath);
    }
  } catch (error) {
    throw new WorkspacePathIndexDbError(
      workspacePathIndexStorageErrorCode(error) ?? "WORKSPACE_FILE_INDEX_OPEN_FAILED",
      `隔离 workspace 文件索引失败（已移动 ${recoveredPaths.length}/${existingSources.length} 个文件）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { indexPath, recoveredPaths };
}

/** 在启用索引的回退前复核真实保护，不打开数据库或执行 SQL。 */
export function assertWorkspacePathIndexStorage(workspacePath: string): void {
  const identity = ensureWorkspacePathIndexDirectory(workspacePath);
  assertWorkspacePathIndexStorageLocation(identity.workspaceRoot, identity.directoryPath, path.join(identity.directoryPath, WORKSPACE_PATH_INDEX_DATABASE_FILE), identity);
}

function workspacePathIndexSidecarPaths(indexPath: string): string[] {
  return [`${indexPath}-wal`, `${indexPath}-shm`, `${indexPath}-journal`];
}

/** 开库前复用本机 Git 保护，并确认工作区运行目录的物理边界。 */
function ensureWorkspacePathIndexDirectory(workspacePath: string): WorkspaceCodeflowaiDirectoryIdentity {
  ensureWorkspacePrivateRuntimeGitExclude(workspacePath, "file-index.db");
  try {
    return ensureWorkspaceCodeflowaiDirectory(workspacePath, WORKSPACE_PATH_INDEX_DIRECTORY);
  } catch (error) {
    throw workspacePathIndexUnsafeError("无法确认 workspace 文件索引控制目录", error);
  }
}

/**
 * 拒绝索引容器、主库和 sidecar 的 symlink/junction，并复核容器仍是工作区根下的精确物理目录。
 * expectedIdentity 用于创建完成后、SQLite 打开前后的 TOCTOU 复核。
 */
function assertWorkspacePathIndexStorageLocation(
  workspaceRoot: string,
  indexDirectory: string,
  indexPath: string,
  expectedIdentity: WorkspaceCodeflowaiDirectoryIdentity,
): WorkspaceCodeflowaiDirectoryIdentity {
  let identity: WorkspaceCodeflowaiDirectoryIdentity;
  try {
    identity = assertWorkspaceCodeflowaiDirectory(expectedIdentity);
  } catch (error) {
    throw workspacePathIndexUnsafeError("无法确认工作区运行索引目录的物理位置", error);
  }

  const expectedDirectory = path.join(workspaceRoot, WORKSPACE_PATH_INDEX_DIRECTORY);
  if (workspacePathIndexRootKey(identity.directoryPath) !== workspacePathIndexRootKey(expectedDirectory)) {
    throw workspacePathIndexUnsafeError("工作区运行索引目录位于工作区物理根之外");
  }
  if (path.dirname(indexPath) !== indexDirectory || path.basename(indexPath) !== WORKSPACE_PATH_INDEX_DATABASE_FILE) {
    throw workspacePathIndexUnsafeError("workspace 文件索引路径不是预期的工作区相对路径");
  }

  for (const artifactPath of [indexPath, ...workspacePathIndexSidecarPaths(indexPath)]) {
    let artifactStat: fs.Stats;
    try {
      artifactStat = fs.lstatSync(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
      throw workspacePathIndexUnsafeError("无法确认 workspace 文件索引工件类型", error);
    }
    if (artifactStat.isSymbolicLink() || !artifactStat.isFile() || artifactStat.nlink !== 1) {
      throw workspacePathIndexUnsafeError(`workspace 文件索引工件不是普通文件：${path.basename(artifactPath)}`);
    }
  }
  return identity;
}

function workspacePathIndexUnsafeError(message: string, cause?: unknown): WorkspacePathIndexDbError {
  const rootCause = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  return new WorkspacePathIndexDbError(
    "WORKSPACE_FILE_INDEX_PATH_UNSAFE",
    rootCause ? `${message}：${rootCause}` : message,
    cause === undefined ? undefined : { cause },
  );
}

export class WorkspacePathIndexDb {
  private closed = false;

  constructor(
    private readonly db: SqliteDb,
    readonly indexPath: string,
    readonly workspaceRoot: string,
    readonly workspaceRootKey: string,
    private readonly directoryIdentity: WorkspaceCodeflowaiDirectoryIdentity,
  ) {}

  /** 长连接每次写入和查询边界复核 Git 及最初保存的目录身份。 */
  assertStorage(): void {
    this.assertOpen();
    ensureWorkspacePrivateRuntimeGitExclude(this.workspaceRoot, "file-index.db");
    assertWorkspacePathIndexStorageLocation(this.workspaceRoot, this.directoryIdentity.directoryPath, this.indexPath, this.directoryIdentity);
  }

  /** 返回数据库标量快照；不暴露完整路径集合。 */
  getMeta(): WorkspacePathIndexDbMeta {
    this.assertOpen();
    return mapMetaRow(this.readMetaRow());
  }

  /** 当前 active generation 的配置戳全部匹配时才允许直接复用。 */
  isActiveCompatible(settings: WorkspacePathIndexDbSettings): boolean {
    const meta = this.getMeta();
    return meta.activeGeneration !== null
      && meta.activeConfigStamp === settings.configStamp
      && meta.activeExcludeRulesStamp === settings.excludeRulesStamp
      && meta.activePolicyStamp === normalizePolicyStamp(settings.policyStamp)
      && meta.maxEntries === settings.maxEntries;
  }

  /** 事务性预留新 generation；上一代 active 指针和条目保持不变。 */
  reserveBuild(settings: WorkspacePathIndexDbSettings, message: string): number {
    this.assertStorage();
    return this.db.transaction(() => {
      const row = this.readMetaRow();
      const generation = Number(row.next_generation);
      this.db.prepare(`
        DELETE FROM file_index_mutations
        WHERE build_generation = $generation
      `).run({ generation });
      this.db.prepare(`
        DELETE FROM file_index_entries
        WHERE generation = $generation
      `).run({ generation });
      this.db.prepare(`
        UPDATE file_index_meta
        SET build_generation = $generation,
            build_base_mutation_seq = mutation_seq,
            build_config_stamp = $configStamp,
            build_exclude_rules_stamp = $excludeRulesStamp,
            build_policy_stamp = $policyStamp,
            build_truncated = 0,
            next_generation = $nextGeneration,
            status = 'queued', partial = 1,
            max_entries = $maxEntries, message = $message,
            updated_at = $updatedAt
        WHERE id = 1
      `).run({
        generation,
        configStamp: settings.configStamp,
        excludeRulesStamp: settings.excludeRulesStamp,
        policyStamp: normalizePolicyStamp(settings.policyStamp),
        nextGeneration: generation + 1,
        maxEntries: settings.maxEntries,
        message,
        updatedAt: Date.now(),
      });
      return generation;
    })();
  }

  /** 把匹配的预留 generation 标记为 building。 */
  markBuilding(generation: number): boolean {
    this.assertStorage();
    const result = this.db.prepare(`
      UPDATE file_index_meta
      SET status = 'building', partial = 1, message = '索引正在后台构建', updated_at = $updatedAt
      WHERE id = 1 AND build_generation = $generation
    `).run({ generation, updatedAt: Date.now() });
    return Number(result.changes ?? 0) === 1;
  }

  /** Worker 以固定批次直写 build generation；CAS 失败时拒绝迟到批次。 */
  writeBuildEntries(generation: number, entries: readonly WorkspacePathIndexEntry[]): boolean {
    this.assertStorage();
    if (!entries.length) return this.getMeta().buildGeneration === generation;
    return this.db.transaction(() => {
      const meta = this.readMetaRow();
      if (meta.build_generation === null || generation <= 0 || Number(meta.build_generation) !== generation) return false;
      let indexedCount = this.countGeneration(generation);
      let dropped = false;
      const statement = this.db.prepare(`
        INSERT INTO file_index_entries (
          generation, path_key, path, parent_path_key, parent_entry_order, name,
          path_folded_utf16le, name_folded_utf16le, is_dir, hidden
        ) VALUES (
          $generation, $pathKey, $path, $parentPathKey, $parentEntryOrder, $name,
          $pathFolded, $nameFolded, $isDir, $hidden
        )
        ON CONFLICT(generation, path_key) DO UPDATE SET
          path = excluded.path,
          parent_path_key = excluded.parent_path_key,
          parent_entry_order = excluded.parent_entry_order,
          name = excluded.name,
          path_folded_utf16le = excluded.path_folded_utf16le,
          name_folded_utf16le = excluded.name_folded_utf16le,
          is_dir = excluded.is_dir,
          hidden = excluded.hidden
      `);
      for (const rawEntry of entries) {
        const entry = toStoredEntry(rawEntry);
        const exists = this.db.prepare(`
          SELECT 1 AS present FROM file_index_entries
          WHERE generation = $generation AND path_key = $pathKey
        `).get({ generation, pathKey: entry.pathKey });
        if (!exists && indexedCount >= Number(meta.max_entries)) {
          dropped = true;
          continue;
        }
        statement.run(toEntryParams(generation, entry));
        if (!exists) indexedCount += 1;
      }
      if (dropped) {
        this.db.prepare(`
          UPDATE file_index_meta
          SET build_truncated = 1, updated_at = $updatedAt
          WHERE id = 1 AND build_generation = $generation
        `).run({ generation, updatedAt: Date.now() });
      }
      return true;
    })();
  }

  /** 发布 build generation，并在同一事务中回放构建期间的已知增量。 */
  publishBuild(generation: number, workerPartial: boolean): WorkspacePathIndexDbMeta {
    this.assertStorage();
    const published = this.db.transaction(() => {
      const meta = this.readMetaRow();
      if (meta.build_generation === null || generation <= 0 || Number(meta.build_generation) !== generation) {
        throw new WorkspacePathIndexDbError(
          "WORKSPACE_FILE_INDEX_STALE_GENERATION",
          `索引 generation 已过期：${generation}`,
        );
      }
      let forcesStale = false;
      let mutationDropped = false;
      const readMutations = this.db.prepare(`
        SELECT seq, ordinal, op, path_key, path, parent_path_key, parent_entry_order, name,
               path_folded_utf16le, name_folded_utf16le, is_dir, hidden, recursive, forces_stale
        FROM file_index_mutations
        WHERE build_generation = $generation
          AND (seq > $afterSeq OR (seq = $afterSeq AND ordinal > $afterOrdinal))
        ORDER BY seq ASC, ordinal ASC
        LIMIT $batchSize
      `);
      let afterSeq = -1;
      let afterOrdinal = -1;
      while (true) {
        const mutations = readMutations.all({
          generation,
          afterSeq,
          afterOrdinal,
          batchSize: PUBLISH_MUTATION_BATCH_SIZE,
        }) as Array<Record<string, unknown>>;
        if (mutations.length === 0) break;
        for (const mutation of mutations) {
          forcesStale ||= Number(mutation.forces_stale) === 1;
          if (mutation.op === "delete") {
            this.deleteGenerationPath(generation, String(mutation.path_key), Number(mutation.recursive) === 1);
          } else {
            const result = this.upsertGenerationEntryWithinLimit(generation, mutation, Number(meta.max_entries));
            mutationDropped ||= result.dropped;
          }
        }
        const lastMutation = mutations.at(-1)!;
        afterSeq = Number(lastMutation.seq);
        afterOrdinal = Number(lastMutation.ordinal);
      }
      const count = this.countGeneration(generation);
      const partial = workerPartial || Number(meta.build_truncated) === 1 || mutationDropped || forcesStale;
      const message = forcesStale
        ? "目录变更已增量记录，子路径可通过手工重建索引补齐"
        : partial
          ? `索引已达到上限，仅包含前 ${count} 个路径`
          : null;
      this.db.prepare(`
        UPDATE file_index_meta
        SET active_generation = $generation,
            active_indexed_count = $count,
            active_config_stamp = build_config_stamp,
            active_exclude_rules_stamp = build_exclude_rules_stamp,
            active_policy_stamp = build_policy_stamp,
            build_generation = NULL,
            build_base_mutation_seq = NULL,
            build_config_stamp = NULL,
            build_exclude_rules_stamp = NULL,
            build_policy_stamp = NULL,
            build_truncated = 0,
            status = $status, partial = $partial, message = $message,
            updated_at = $updatedAt
        WHERE id = 1 AND build_generation = $generation
      `).run({
        generation,
        count,
        status: partial ? "stale" : "ready",
        partial,
        message,
        updatedAt: Date.now(),
      });
      return mapMetaRow(this.readMetaRow());
    })();
    this.cleanupObsoleteGenerations(published.activeGeneration, published.workspaceId);
    return published;
  }

  /** 取消或终止 generation；active generation 始终保留。 */
  cancelBuild(generation: number, status: "stale" | "failed", message: string): boolean {
    this.assertStorage();
    const result = this.db.prepare(`
      UPDATE file_index_meta
      SET build_generation = NULL,
          build_base_mutation_seq = NULL,
          build_config_stamp = NULL,
          build_exclude_rules_stamp = NULL,
          build_policy_stamp = NULL,
          build_truncated = 0,
          status = $status, partial = 1, message = $message, updated_at = $updatedAt
      WHERE id = 1 AND build_generation = $generation
    `).run({ generation, status, message, updatedAt: Date.now() });
    return Number(result.changes ?? 0) === 1;
  }

  /** 对 active generation 持久化增量，同时为正在构建的 generation 追加 mutation journal。 */
  applyMutations(
    mutations: readonly WorkspacePathIndexDbMutation[],
    options: WorkspacePathIndexDbMutationOptions = {},
  ): WorkspacePathIndexDbMeta {
    this.assertStorage();
    if (!mutations.length) return this.getMeta();
    return this.db.transaction(() => {
      const meta = this.readMetaRow();
      const activeGeneration = meta.active_generation === null ? null : Number(meta.active_generation);
      const buildGeneration = meta.build_generation === null ? null : Number(meta.build_generation);
      const visibleGeneration = activeGeneration ?? buildGeneration;
      const seq = Number(meta.mutation_seq) + 1;
      const staleFromSourceDirectory = visibleGeneration !== null
        && this.isAnyGenerationPathDirectory(visibleGeneration, options.staleIfDirectoryPaths ?? []);
      let forcesStale = staleFromSourceDirectory;
      let entryDropped = false;
      mutations.forEach((mutation, ordinal) => {
        const mutationForcesStale = staleFromSourceDirectory || mutation.forcesStale === true;
        forcesStale ||= mutationForcesStale;
        if (mutation.type === "delete") {
          const pathKey = workspacePathIndexPathKey(mutation.path);
          if (visibleGeneration !== null) this.deleteGenerationPath(visibleGeneration, pathKey, true);
          if (buildGeneration !== null) this.insertDeleteMutation(buildGeneration, seq, ordinal, pathKey, mutationForcesStale);
          return;
        }
        const entry = toStoredEntry(mutation.entry);
        if (visibleGeneration !== null) {
          const result = this.upsertGenerationEntryWithinLimit(visibleGeneration, entry, Number(meta.max_entries));
          entryDropped ||= result.dropped;
        }
        if (buildGeneration !== null) this.insertUpsertMutation(buildGeneration, seq, ordinal, entry, mutationForcesStale);
      });
      const activeCount = activeGeneration === null ? 0 : this.countGeneration(activeGeneration);
      const partial = Number(meta.partial) === 1 || forcesStale || entryDropped;
      const status = (forcesStale || entryDropped) && meta.status === "ready" ? "stale" : meta.status;
      const message = forcesStale
        ? "目录变更已增量记录，子路径可通过手工重建索引补齐"
        : entryDropped
          ? `索引已达到上限，仅包含前 ${activeCount} 个路径`
          : meta.message;
      this.db.prepare(`
        UPDATE file_index_meta
        SET mutation_seq = $seq,
            active_indexed_count = $activeCount,
            status = $status, partial = $partial, message = $message,
            updated_at = $updatedAt
        WHERE id = 1
      `).run({ seq, activeCount, status, partial, message, updatedAt: Date.now() });
      return mapMetaRow(this.readMetaRow());
    })();
  }

  /** 在增量事务当前可见 generation 中判断任一旧路径是否为目录。 */
  private isAnyGenerationPathDirectory(generation: number, relPaths: readonly string[]): boolean {
    if (!relPaths.length) return false;
    const statement = this.db.prepare(`
      SELECT is_dir
      FROM file_index_entries
      WHERE generation = $generation AND path_key = $pathKey
    `);
    return relPaths.some((relPath) => {
      const row = statement.get({
        generation,
        pathKey: workspacePathIndexPathKey(relPath),
      }) as { is_dir?: number } | undefined;
      return Number(row?.is_dir) === 1;
    });
  }

  /** 从 active generation 执行普通模糊查询、排序和分页。 */
  search(query: string, options: { limit: number; offset: number; includeHidden: boolean; kind: "file" | "directory" | "all" }): WorkspacePathIndexDbSearchPage {
    this.assertOpen();
    const meta = this.readMetaRow();
    const queryGeneration = meta.active_generation ?? meta.build_generation;
    if (queryGeneration === null) return emptyDbPage();
    const queryBlob = Buffer.from(String(query ?? "").toLowerCase(), "utf16le");
    const limit = normalizeQueryLimit(options.limit);
    const offset = normalizeQueryOffset(options.offset);
    const kind = options.kind;
    const rows = this.db.prepare(`
      SELECT path_key, path, parent_path_key, parent_entry_order, name, is_dir, hidden,
        CASE
          WHEN name_folded_utf16le = $query THEN 0
          WHEN substr(name_folded_utf16le, 1, length($query)) = $query THEN 100 + (length(name_folded_utf16le) / 2) * 10
          WHEN substr(path_folded_utf16le, 1, length($query)) = $query THEN 400 + (length(path_folded_utf16le) / 2) * 10
          WHEN instr(name_folded_utf16le, $query) > 0 THEN 800 + ((instr(name_folded_utf16le, $query) - 1) / 2) * 10 + (length(name_folded_utf16le) / 2) * 10
          ELSE 1400 + ((instr(path_folded_utf16le, $query) - 1) / 2) * 10 + (length(path_folded_utf16le) / 2) * 10
        END - CASE WHEN is_dir = 1 THEN 2 ELSE 0 END AS score
      FROM file_index_entries
      WHERE generation = $generation
        AND ($includeHidden = 1 OR hidden = 0)
        AND ($kind = 'all' OR ($kind = 'directory' AND is_dir = 1) OR ($kind = 'file' AND is_dir = 0))
        AND (instr(name_folded_utf16le, $query) > 0 OR instr(path_folded_utf16le, $query) > 0)
      ORDER BY score ASC, is_dir DESC, path_key ASC
      LIMIT $limitPlusOne OFFSET $offset
    `).all({
      query: queryBlob,
      generation: queryGeneration,
      includeHidden: options.includeHidden,
      kind,
      limitPlusOne: limit + 1,
      offset,
    });
    return rowsToPage(rows, limit, offset);
  }

  /** 通过 parent_path_key 快速读取目录查询的一页结果。 */
  searchDirectory(parentPath: string, filter: string, options: { limit: number; offset: number; includeHidden: boolean; kind: "file" | "directory" | "all" }): WorkspacePathIndexDbSearchPage {
    this.assertOpen();
    const meta = this.readMetaRow();
    const queryGeneration = meta.active_generation ?? meta.build_generation;
    if (queryGeneration === null) return emptyDbPage();
    const queryBlob = Buffer.from(String(filter ?? "").toLowerCase(), "utf16le");
    const limit = normalizeQueryLimit(options.limit);
    const offset = normalizeQueryOffset(options.offset);
    const rows = this.db.prepare(`
      SELECT path_key, path, parent_path_key, parent_entry_order, name, is_dir, hidden
      FROM file_index_entries
      WHERE generation = $generation
        AND parent_path_key = $parentPathKey
        AND ($includeHidden = 1 OR hidden = 0)
        AND ($kind = 'all' OR ($kind = 'directory' AND is_dir = 1) OR ($kind = 'file' AND is_dir = 0))
        AND (length($query) = 0 OR instr(name_folded_utf16le, $query) > 0 OR instr(path_folded_utf16le, $query) > 0)
      ORDER BY parent_entry_order ASC, path_key ASC
      LIMIT $limitPlusOne OFFSET $offset
    `).all({
      generation: queryGeneration,
      parentPathKey: workspacePathIndexPathKey(parentPath),
      includeHidden: options.includeHidden,
      kind: options.kind,
      query: queryBlob,
      limitPlusOne: limit + 1,
      offset,
    });
    return rowsToPage(rows, limit, offset);
  }

  /** 为增量新增项分配当前 generation 内的父目录尾部枚举序。 */
  nextParentEntryOrder(parentPath: string): number {
    this.assertOpen();
    const meta = this.readMetaRow();
    const generation = meta.active_generation ?? meta.build_generation;
    if (generation === null) return 0;
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(parent_entry_order), -1) + 1 AS next_order
      FROM file_index_entries
      WHERE generation = $generation AND parent_path_key = $parentPathKey
    `).get({ generation, parentPathKey: workspacePathIndexPathKey(parentPath) }) as { next_order?: number } | undefined;
    return Math.max(0, Number(row?.next_order ?? 0));
  }

  /** 读取单个当前可查询 generation 条目，用于增量 modify 保留目录枚举序。 */
  getEntry(relPath: string): WorkspacePathIndexStoredEntry | null {
    this.assertOpen();
    const meta = this.readMetaRow();
    const generation = meta.active_generation ?? meta.build_generation;
    if (generation === null) return null;
    const row = this.db.prepare(`
      SELECT path_key, path, parent_path_key, parent_entry_order, name, is_dir, hidden
      FROM file_index_entries
      WHERE generation = $generation AND path_key = $pathKey
    `).get({ generation, pathKey: workspacePathIndexPathKey(relPath) }) as Record<string, unknown> | undefined;
    return row ? mutationRowToEntry(row) : null;
  }

  /** 更新持久化生命周期状态，不改变 generation 指针。 */
  updateStatus(status: FsSearchIndexStatus, partial: boolean, message: string | null): WorkspacePathIndexDbMeta {
    this.assertStorage();
    this.db.prepare(`
      UPDATE file_index_meta
      SET status = $status, partial = $partial, message = $message, updated_at = $updatedAt
      WHERE id = 1
    `).run({ status, partial, message, updatedAt: Date.now() });
    return this.getMeta();
  }

  /** 关闭该工作区连接。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private readMetaRow(): MetaRow {
    const row = this.db.prepare(`SELECT * FROM file_index_meta WHERE id = 1`).get() as MetaRow | undefined;
    if (!row) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_CORRUPT", "workspace 文件索引缺少元数据");
    return row;
  }

  private deleteGenerationPath(generation: number, pathKey: string, recursive: boolean): void {
    const prefix = `${pathKey}/`;
    this.db.prepare(`
      DELETE FROM file_index_entries
      WHERE generation = $generation
        AND (path_key = $pathKey OR ($recursive = 1 AND substr(path_key, 1, length($prefix)) = $prefix))
    `).run({ generation, pathKey, recursive, prefix });
  }

  private upsertGenerationEntryWithinLimit(
    generation: number,
    rawEntry: WorkspacePathIndexEntry | Record<string, unknown>,
    maxEntries: number,
  ): { dropped: boolean } {
    const entry = "pathKey" in rawEntry
      ? rawEntry as unknown as WorkspacePathIndexStoredEntry
      : "path_key" in rawEntry
        ? mutationRowToEntry(rawEntry)
        : toStoredEntry(rawEntry as WorkspacePathIndexEntry);
    const exists = this.db.prepare(`
      SELECT 1 AS present FROM file_index_entries
      WHERE generation = $generation AND path_key = $pathKey
    `).get({ generation, pathKey: entry.pathKey });
    if (!exists && this.countGeneration(generation) >= maxEntries) return { dropped: true };
    this.writeEntry(generation, entry);
    return { dropped: false };
  }

  private writeEntry(generation: number, entry: WorkspacePathIndexStoredEntry): void {
    this.db.prepare(`
      INSERT INTO file_index_entries (
        generation, path_key, path, parent_path_key, parent_entry_order, name,
        path_folded_utf16le, name_folded_utf16le, is_dir, hidden
      ) VALUES (
        $generation, $pathKey, $path, $parentPathKey, $parentEntryOrder, $name,
        $pathFolded, $nameFolded, $isDir, $hidden
      )
      ON CONFLICT(generation, path_key) DO UPDATE SET
        path = excluded.path,
        parent_path_key = excluded.parent_path_key,
        parent_entry_order = excluded.parent_entry_order,
        name = excluded.name,
        path_folded_utf16le = excluded.path_folded_utf16le,
        name_folded_utf16le = excluded.name_folded_utf16le,
        is_dir = excluded.is_dir,
        hidden = excluded.hidden
    `).run(toEntryParams(generation, entry));
  }

  private insertDeleteMutation(buildGeneration: number, seq: number, ordinal: number, pathKey: string, forcesStale: boolean): void {
    this.db.prepare(`
      INSERT INTO file_index_mutations (
        build_generation, seq, ordinal, op, path_key, recursive, forces_stale
      ) VALUES ($buildGeneration, $seq, $ordinal, 'delete', $pathKey, 1, $forcesStale)
    `).run({ buildGeneration, seq, ordinal, pathKey, forcesStale });
  }

  private insertUpsertMutation(buildGeneration: number, seq: number, ordinal: number, entry: WorkspacePathIndexStoredEntry, forcesStale: boolean): void {
    const { generation: _generation, ...entryParams } = toEntryParams(buildGeneration, entry);
    this.db.prepare(`
      INSERT INTO file_index_mutations (
        build_generation, seq, ordinal, op, path_key, path, parent_path_key,
        parent_entry_order, name, path_folded_utf16le, name_folded_utf16le,
        is_dir, hidden, recursive, forces_stale
      ) VALUES (
        $buildGeneration, $seq, $ordinal, 'upsert', $pathKey, $path, $parentPathKey,
        $parentEntryOrder, $name, $pathFolded, $nameFolded,
        $isDir, $hidden, 0, $forcesStale
      )
    `).run({ buildGeneration, seq, ordinal, forcesStale, ...entryParams });
  }

  private countGeneration(generation: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM file_index_entries WHERE generation = $generation
    `).get({ generation }) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private cleanupObsoleteGenerations(activeGeneration: number | null, workspaceId: string): void {
    if (activeGeneration === null) return;
    try {
      while (true) {
        const result = this.db.prepare(`
          DELETE FROM file_index_entries
          WHERE (generation, path_key) IN (
            SELECT generation, path_key
            FROM file_index_entries
            WHERE generation <> $activeGeneration
            LIMIT $batchSize
          )
        `).run({ activeGeneration, batchSize: CLEANUP_BATCH_SIZE });
        if (Number(result.changes ?? 0) < CLEANUP_BATCH_SIZE) break;
      }
      while (true) {
        const result = this.db.prepare(`
          DELETE FROM file_index_mutations
          WHERE (build_generation, seq, ordinal) IN (
            SELECT build_generation, seq, ordinal
            FROM file_index_mutations
            WHERE build_generation <> COALESCE((SELECT build_generation FROM file_index_meta WHERE id = 1), -1)
            LIMIT $batchSize
          )
        `).run({ batchSize: CLEANUP_BATCH_SIZE });
        if (Number(result.changes ?? 0) < CLEANUP_BATCH_SIZE) break;
      }
    } catch (error) {
      logger.warn("workspace-index", "workspace path index obsolete generation cleanup failed", {
        code: "workspace_file_index_cleanup_failed",
        requestId: null,
        workspaceId,
        generation: activeGeneration,
        indexPath: this.indexPath,
        rootCause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_OPEN_FAILED", "workspace 文件索引连接已关闭");
  }
}

/** 解析真实工作区根；符号链接和 `..` 不能形成不同索引 owner。 */
export function resolveCanonicalWorkspaceRoot(workspacePath: string): string {
  const resolved = path.resolve(String(workspacePath ?? "").trim());
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_OPEN_FAILED", `工作区路径不是目录：${workspacePath}`);
  return fs.realpathSync.native(resolved);
}

/** 生成平台大小写语义一致的物理根比较键。 */
export function workspacePathIndexRootKey(workspaceRoot: string): string {
  const normalized = path.normalize(workspaceRoot);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 生成稳定路径主键；输入和输出统一使用 POSIX workspace 相对路径。 */
export function workspacePathIndexPathKey(relPath: string): string {
  const normalized = normalizeWorkspacePathIndexRelPath(relPath, true);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 归一化分隔符但保留真实文件名空格；只有空字符串可表示根 parent key。 */
export function normalizeWorkspacePathIndexRelPath(value: unknown, allowEmpty = false): string {
  const normalized = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized && allowEmpty) return "";
  if (!normalized) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_OPEN_FAILED", "索引路径不能为空");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_OPEN_FAILED", `索引路径非法：${value}`);
  }
  return normalized;
}

function configureConnection(db: SqliteDb): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`cache_size = -${SQLITE_CACHE_KIB}`);
  db.pragma("temp_store = FILE");
  db.pragma("mmap_size = 0");
  db.pragma(`wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
  db.pragma(`journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
}

function initializeOrValidateSchema(
  db: SqliteDb,
  input: { workspaceId: string; workspaceRoot: string; workspaceRootKey: string; settings: WorkspacePathIndexDbSettings },
): void {
  const applicationId = Number(db.pragma("application_id", { simple: true }) ?? 0);
  const userVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name?: string }>;
  const isEmpty = tables.length === 0;
  if (isEmpty && applicationId === 0 && userVersion === 0) {
    createSchema(db, input);
    return;
  }
  if (applicationId !== WORKSPACE_PATH_INDEX_APPLICATION_ID || userVersion !== WORKSPACE_PATH_INDEX_SCHEMA_VERSION) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
      `workspace 文件索引 schema 不兼容：application_id=${applicationId}, user_version=${userVersion}`,
    );
  }
  const quickCheck = String(db.pragma("quick_check(1)", { simple: true }) ?? "");
  if (quickCheck !== "ok") {
    throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_CORRUPT", `workspace 文件索引完整性检查失败：${quickCheck}`);
  }
  assertRequiredSchema(db);
  const row = db.prepare(`SELECT workspace_id, workspace_root_key FROM file_index_meta WHERE id = 1`).get() as {
    workspace_id?: string;
    workspace_root_key?: string;
  } | undefined;
  if (!row || row.workspace_id !== input.workspaceId || row.workspace_root_key !== input.workspaceRootKey) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_METADATA_MISMATCH",
      "workspace 文件索引元数据与当前工作区不匹配",
    );
  }
  db.prepare(`
    UPDATE file_index_meta
    SET workspace_root = $workspaceRoot, updated_at = $updatedAt
    WHERE id = 1
  `).run({ workspaceRoot: input.workspaceRoot, updatedAt: Date.now() });
}

function createSchema(
  db: SqliteDb,
  input: { workspaceId: string; workspaceRoot: string; workspaceRootKey: string; settings: WorkspacePathIndexDbSettings },
): void {
  db.exec(`
    PRAGMA application_id = ${WORKSPACE_PATH_INDEX_APPLICATION_ID};
    PRAGMA user_version = ${WORKSPACE_PATH_INDEX_SCHEMA_VERSION};

    CREATE TABLE file_index_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      workspace_root_key TEXT NOT NULL,
      active_generation INTEGER,
      active_indexed_count INTEGER NOT NULL DEFAULT 0 CHECK (active_indexed_count >= 0),
      active_config_stamp TEXT,
      active_exclude_rules_stamp TEXT,
      active_policy_stamp TEXT,
      build_generation INTEGER,
      build_base_mutation_seq INTEGER,
      build_config_stamp TEXT,
      build_exclude_rules_stamp TEXT,
      build_policy_stamp TEXT,
      build_truncated INTEGER NOT NULL DEFAULT 0 CHECK (build_truncated IN (0,1)),
      next_generation INTEGER NOT NULL DEFAULT 1 CHECK (next_generation > 0),
      mutation_seq INTEGER NOT NULL DEFAULT 0 CHECK (mutation_seq >= 0),
      status TEXT NOT NULL CHECK (status IN ('queued','building','ready','stale','failed','disabled')),
      partial INTEGER NOT NULL CHECK (partial IN (0,1)),
      max_entries INTEGER NOT NULL CHECK (max_entries > 0),
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE file_index_entries (
      generation INTEGER NOT NULL,
      path_key TEXT NOT NULL,
      path TEXT NOT NULL,
      parent_path_key TEXT NOT NULL,
      parent_entry_order INTEGER NOT NULL CHECK (parent_entry_order >= 0),
      name TEXT NOT NULL,
      path_folded_utf16le BLOB NOT NULL,
      name_folded_utf16le BLOB NOT NULL,
      is_dir INTEGER NOT NULL CHECK (is_dir IN (0,1)),
      hidden INTEGER NOT NULL CHECK (hidden IN (0,1)),
      PRIMARY KEY (generation, path_key)
    ) WITHOUT ROWID, STRICT;

    CREATE INDEX idx_file_index_entries_parent
      ON file_index_entries(generation, parent_path_key, parent_entry_order);

    CREATE TABLE file_index_mutations (
      build_generation INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
      path_key TEXT NOT NULL,
      path TEXT,
      parent_path_key TEXT,
      parent_entry_order INTEGER,
      name TEXT,
      path_folded_utf16le BLOB,
      name_folded_utf16le BLOB,
      is_dir INTEGER,
      hidden INTEGER,
      recursive INTEGER NOT NULL CHECK (recursive IN (0,1)),
      forces_stale INTEGER NOT NULL CHECK (forces_stale IN (0,1)),
      PRIMARY KEY (build_generation, seq, ordinal)
    ) WITHOUT ROWID, STRICT;
  `);
  const now = Date.now();
  db.prepare(`
    INSERT INTO file_index_meta (
      id, workspace_id, workspace_root, workspace_root_key,
      status, partial, max_entries, message, created_at, updated_at
    ) VALUES (
      1, $workspaceId, $workspaceRoot, $workspaceRootKey,
      'stale', 1, $maxEntries, '索引尚未构建', $now, $now
    )
  `).run({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    workspaceRootKey: input.workspaceRootKey,
    maxEntries: input.settings.maxEntries,
    now,
  });
}

function assertRequiredSchema(db: SqliteDb): void {
  const required = new Set(["file_index_meta", "file_index_entries", "file_index_mutations"]);
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name?: string }>;
  for (const row of rows) required.delete(String(row.name ?? ""));
  if (required.size > 0) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
      `workspace 文件索引缺少必要表：${Array.from(required).join(", ")}`,
    );
  }
  assertRequiredColumns(db, "file_index_meta", [
    "id", "workspace_id", "workspace_root", "workspace_root_key",
    "active_generation", "active_indexed_count", "active_config_stamp",
    "active_exclude_rules_stamp", "active_policy_stamp", "build_generation",
    "build_base_mutation_seq", "build_config_stamp", "build_exclude_rules_stamp",
    "build_policy_stamp", "build_truncated", "next_generation", "mutation_seq", "status", "partial",
    "max_entries", "message", "created_at", "updated_at",
  ]);
  assertRequiredColumns(db, "file_index_entries", [
    "generation", "path_key", "path", "parent_path_key", "parent_entry_order", "name",
    "path_folded_utf16le", "name_folded_utf16le", "is_dir", "hidden",
  ]);
  assertRequiredColumns(db, "file_index_mutations", [
    "build_generation", "seq", "ordinal", "op", "path_key", "path",
    "parent_path_key", "parent_entry_order", "name", "path_folded_utf16le",
    "name_folded_utf16le", "is_dir", "hidden", "recursive", "forces_stale",
  ]);
  const indexes = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name?: string }>)
      .map((row) => String(row.name ?? "")),
  );
  if (!indexes.has("idx_file_index_entries_parent")) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
      "workspace 文件索引缺少必要索引：idx_file_index_entries_parent",
    );
  }
}

function assertRequiredColumns(db: SqliteDb, tableName: string, requiredColumns: readonly string[]): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>)
      .map((row) => String(row.name ?? "")),
  );
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new WorkspacePathIndexDbError(
      "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
      `workspace 文件索引表 ${tableName} 缺少字段：${missing.join(", ")}`,
    );
  }
}

/** 条目路径和显示名均保留原字符，避免合法空格名称碰撞。 */
function toStoredEntry(entry: WorkspacePathIndexEntry): WorkspacePathIndexStoredEntry {
  const relPath = normalizeWorkspacePathIndexRelPath(entry.path);
  const name = String(entry.name ?? "") || path.posix.basename(relPath);
  const parentPath = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
  return {
    path: relPath,
    pathKey: workspacePathIndexPathKey(relPath),
    parentPathKey: workspacePathIndexPathKey(parentPath),
    parentEntryOrder: Math.max(0, Math.trunc(Number(entry.parentEntryOrder) || 0)),
    name,
    isDir: entry.isDir === true,
    hidden: entry.hidden === true,
  };
}

function toEntryParams(generation: number, entry: WorkspacePathIndexStoredEntry): Record<string, unknown> {
  return {
    generation,
    pathKey: entry.pathKey,
    path: entry.path,
    parentPathKey: entry.parentPathKey,
    parentEntryOrder: entry.parentEntryOrder,
    name: entry.name,
    pathFolded: Buffer.from(entry.path.toLowerCase(), "utf16le"),
    nameFolded: Buffer.from(entry.name.toLowerCase(), "utf16le"),
    isDir: entry.isDir,
    hidden: entry.hidden,
  };
}

function mutationRowToEntry(row: Record<string, unknown>): WorkspacePathIndexStoredEntry {
  return {
    pathKey: String(row.path_key),
    path: String(row.path),
    parentPathKey: String(row.parent_path_key),
    parentEntryOrder: Number(row.parent_entry_order),
    name: String(row.name),
    isDir: Number(row.is_dir) === 1,
    hidden: Number(row.hidden) === 1,
  };
}

function rowsToPage(rows: unknown[], limit: number, offset: number): WorkspacePathIndexDbSearchPage {
  const mapped = (rows as Array<Record<string, unknown>>).map((row) => mutationRowToEntry(row));
  const hasMore = mapped.length > limit;
  const entries = hasMore ? mapped.slice(0, limit) : mapped;
  return {
    entries,
    hasMore,
    nextCursor: hasMore ? String(offset + entries.length) : null,
  };
}

function emptyDbPage(): WorkspacePathIndexDbSearchPage {
  return { entries: [], hasMore: false, nextCursor: null };
}

function mapMetaRow(row: MetaRow): WorkspacePathIndexDbMeta {
  return {
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    workspaceRootKey: row.workspace_root_key,
    activeGeneration: row.active_generation === null ? null : Number(row.active_generation),
    activeIndexedCount: Number(row.active_indexed_count),
    activeConfigStamp: row.active_config_stamp,
    activeExcludeRulesStamp: row.active_exclude_rules_stamp,
    activePolicyStamp: row.active_policy_stamp,
    buildGeneration: row.build_generation === null ? null : Number(row.build_generation),
    buildConfigStamp: row.build_config_stamp,
    buildExcludeRulesStamp: row.build_exclude_rules_stamp,
    buildPolicyStamp: row.build_policy_stamp,
    buildTruncated: Number(row.build_truncated) === 1,
    nextGeneration: Number(row.next_generation),
    mutationSeq: Number(row.mutation_seq),
    status: row.status,
    partial: Number(row.partial) === 1,
    maxEntries: Number(row.max_entries),
    message: row.message,
  };
}

function normalizePolicyStamp(value: unknown): string {
  const stamp = String(value ?? "").trim();
  return stamp || WORKSPACE_PATH_INDEX_POLICY_STAMP;
}

function normalizeQueryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function normalizeQueryOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
}

function isCorruptSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed|not a database|database disk image|database corrupt/i.test(message);
}
