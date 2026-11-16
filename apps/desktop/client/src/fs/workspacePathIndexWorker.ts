import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { openWorkspacePathIndexDb, workspacePathIndexStorageErrorCode, type WorkspacePathIndexDb, type WorkspacePathIndexEntry } from "./workspacePathIndexDb.js";
import { isWorkspacePathIndexPathExcluded, readWorkspacePathIndexPathScope, WorkspacePathIndexPathError, workspacePathIndexFsPath, WORKSPACE_PATH_INDEX_POLICY_STAMP } from "./workspacePathIndexConfig.js";

type WorkerInput = {
  workspaceId: string;
  workspacePath: string;
  generation: number;
  includeHidden: boolean;
  maxEntries: number;
  configStamp: string;
  excludeRulesStamp: string;
  policyStamp: string;
  excludeDirNames: string[];
  excludePathPrefixes: string[];
};

const BATCH_SIZE = 500;
const HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 300_000;
const MIN_MAX_ENTRIES = 1_000;
const MAX_MAX_ENTRIES = 500_000;
const input = normalizeInput(workerData);
let indexedCount = 0;
let skippedDirCount = 0;
let truncated = false;
let currentBatch: WorkspacePathIndexEntry[] = [];
let lastHeartbeatAt = Date.now();
let indexDb: WorkspacePathIndexDb | null = null;
let pathScope: ReturnType<typeof readWorkspacePathIndexPathScope>;

try {
  const root = path.resolve(input.workspacePath);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`工作区路径不是目录：${input.workspacePath}`);
  pathScope = readWorkspacePathIndexPathScope(root);
  indexDb = openWorkspacePathIndexDb({
    workspaceId: input.workspaceId,
    workspacePath: root,
    settings: {
      configStamp: input.configStamp,
      excludeRulesStamp: input.excludeRulesStamp,
      policyStamp: input.policyStamp,
      maxEntries: input.maxEntries,
    },
  });
  if (!indexDb.writeBuildEntries(input.generation, [])) {
    throw new Error(`workspace 文件索引 generation 已过期：${input.generation}`);
  }
  walk(root, "");
  flushBatch();
  postMessage({
    type: "done",
    workspaceId: input.workspaceId,
    generation: input.generation,
    indexedCount,
    skippedDirCount,
    partial: truncated,
  });
} catch (error) {
  postMessage({
    type: "failed",
    workspaceId: input.workspaceId,
    generation: input.generation,
    message: error instanceof Error ? error.message : String(error),
    ...(workspacePathIndexStorageErrorCode(error) ? { storageCode: workspacePathIndexStorageErrorCode(error) } : {}),
    ...(error instanceof WorkspacePathIndexPathError ? { diagnosticCode: error.diagnosticCode, logicalPath: error.logicalPath, systemCode: error.systemCode } : {}),
  });
} finally {
  indexDb?.close();
}

/** 读取并校验 worker 入参，避免无效 workspace 进入扫描。 */
function normalizeInput(value: unknown): WorkerInput {
  const raw = (value ?? {}) as Partial<WorkerInput>;
  const workspaceId = String(raw.workspaceId ?? "").trim();
  const workspacePath = String(raw.workspacePath ?? "").trim();
  const generation = Number(raw.generation);
  if (!workspaceId) throw new Error("worker 缺少 workspaceId");
  if (!workspacePath) throw new Error("worker 缺少 workspacePath");
  if (!Number.isInteger(generation) || generation <= 0) throw new Error("worker generation 必须是正整数");
  return {
    workspaceId,
    workspacePath,
    generation,
    includeHidden: raw.includeHidden === true,
    maxEntries: normalizeMaxEntries(raw.maxEntries),
    configStamp: String(raw.configStamp ?? "").trim(),
    excludeRulesStamp: String(raw.excludeRulesStamp ?? "").trim(),
    policyStamp: String(raw.policyStamp ?? "").trim() || WORKSPACE_PATH_INDEX_POLICY_STAMP,
    excludeDirNames: normalizeRuleList(raw.excludeDirNames),
    excludePathPrefixes: normalizeRuleList(raw.excludePathPrefixes),
  };
}

/** 限制单个 workspace 索引规模，避免异常目录拖垮 worker 内存。 */
function normalizeMaxEntries(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ENTRIES;
  return Math.min(MAX_MAX_ENTRIES, Math.max(MIN_MAX_ENTRIES, Math.floor(parsed)));
}

/** 归一化主线程传入的排除规则列表；规则已在 service 层校验。 */
function normalizeRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)));
}

/** 深度优先枚举且先排除私有真实目标，目录 symlink 不递归以避免环路。 */
function walk(dirAbs: string, dirRelPath: string): void {
  if (truncated) return;
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(workspacePathIndexFsPath(dirAbs));
  } catch (error) {
    throw new Error(`无法索引目录：${dirRelPath || "."}（${error instanceof Error ? error.message : String(error)}）`);
  }

  let parentEntryOrder = 0;
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (truncated) return;
      emitHeartbeatIfDue();
      const relPath = joinRelPath(dirRelPath, entry.name);
      const hidden = isHiddenPath(relPath);
      const abs = path.join(dirAbs, entry.name);
      if (isWorkspacePathIndexPathExcluded(relPath, entry.isDirectory(), { ...input, pathScope })) {
        if (entry.isDirectory()) skippedDirCount += 1;
        continue;
      }
      const kind = resolveEntryKind(entry, workspacePathIndexFsPath(abs), relPath);
      if (!kind) continue;

      if (!input.includeHidden && hidden) continue;
      if (kind.isDir !== entry.isDirectory() && isWorkspacePathIndexPathExcluded(relPath, kind.isDir, input)) {
        if (kind.isDir) skippedDirCount += 1;
        continue;
      }

      pushEntry({
        path: relPath,
        name: entry.name,
        isDir: kind.isDir,
        hidden,
        parentEntryOrder,
      });
      parentEntryOrder += 1;

      if (kind.isDir && !kind.isSymlinkDir) walk(abs, relPath);
    }
  } finally {
    dir.closeSync();
  }
}

/** 同步遍历期间按时间主动发送心跳，避免事件循环被扫描阻塞时 interval 失效。 */
function emitHeartbeatIfDue(): void {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  postMessage({
    type: "heartbeat",
    workspaceId: input.workspaceId,
    generation: input.generation,
    indexedCount,
  });
}

/** 解析目录项类型；文件 symlink 可入索引，目录 symlink 默认不递归。 */
function resolveEntryKind(entry: fs.Dirent, abs: string, relPath: string): { isDir: boolean; isFile: boolean; isSymlinkDir: boolean } | null {
  if (entry.isDirectory()) return { isDir: true, isFile: false, isSymlinkDir: false };
  if (entry.isFile()) return { isDir: false, isFile: true, isSymlinkDir: false };
  if (!entry.isSymbolicLink()) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    throw new Error(`无法解析软连接：${relPath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (stat.isDirectory()) return { isDir: true, isFile: false, isSymlinkDir: true };
  if (stat.isFile()) return { isDir: false, isFile: true, isSymlinkDir: false };
  return null;
}

/** 写入一条索引记录并按批次发送给主线程。 */
function pushEntry(entry: WorkspacePathIndexEntry): void {
  indexedCount += 1;
  if (indexedCount > input.maxEntries) {
    indexedCount = input.maxEntries;
    truncated = true;
    return;
  }
  currentBatch.push(entry);
  if (currentBatch.length >= BATCH_SIZE) flushBatch();
}

/** 把当前固定批次直接写入 build generation，避免完整路径集合回到主线程。 */
function flushBatch(): void {
  if (!currentBatch.length) return;
  if (!indexDb?.writeBuildEntries(input.generation, currentBatch)) {
    throw new Error(`workspace 文件索引 generation 已过期：${input.generation}`);
  }
  currentBatch = [];
}

/** 拼接 POSIX workspace 相对路径。 */
function joinRelPath(dirRelPath: string, name: string): string {
  return dirRelPath ? `${dirRelPath}/${name}` : name;
}

/** 判断路径任一段是否为隐藏名称。 */
function isHiddenPath(relPath: string): boolean {
  return relPath.split("/").some((part) => part.startsWith("."));
}

/** 向主线程发送结构化消息，缺失 parentPort 时显式失败。 */
function postMessage(message: Record<string, unknown>): void {
  if (!parentPort) throw new Error("workspace path index worker 缺少 parentPort");
  parentPort.postMessage(message);
}
