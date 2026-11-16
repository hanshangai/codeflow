import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertReleaseId } from "./contracts.js";
import { assertDesktopStoragePath, readDesktopJsonFile } from "./desktopStorageLocation.js";
import { flushFile, flushDirectory, removeDatabaseFile, restoreDurableFile, writeDurableJson } from "./durableFile.js";

type BackupFile = { path: string; name: string; sha256: string | null };
type BackupRecord = { schemaVersion: 1; state: "prepared" | "restored" | "committed"; releaseId: string; directory: string; files: BackupFile[] };
const marker = "update-database-backup.json";
const suffixes = ["", "-wal", "-shm", "-journal"];
const workspaceNames = ["workspace.db", "file-index.db", "knowledge-search.sqlite"];

/** 仅不存在表示无文件，权限与磁盘错误保持失败。 */
async function optionalStat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** 流式摘要避免大型用户数据库全部进入壳内存。 */
async function digest(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 停止 Client 后复制 SQLite 及其旁文件；项目源码不属于恢复范围。 */
export function createReleaseDatabaseBackup(root: string) {
  const rootDir = path.resolve(root), markerPath = path.join(rootDir, marker);
  const backupsRoot = path.join(rootDir, "update-database-backups");
  /** 元数据只接受固定数据库文件，拒绝任意目录恢复或损坏快照。 */
  const read = async (): Promise<BackupRecord | null> => {
    const value = await readDesktopJsonFile(markerPath);
    if (value === null) return null;
    const record = value as BackupRecord;
    if (Object.keys(record).length !== 5 || record.schemaVersion !== 1 || !["prepared", "restored", "committed"].includes(record.state) || typeof record.directory !== "string"
      || !/^\.update-db-[A-Za-z0-9_-]+$/u.test(record.directory) || !Array.isArray(record.files)) throw new Error("DESKTOP_DB_BACKUP_INVALID");
    assertReleaseId(record.releaseId);
    const seen = new Set<string>();
    for (const file of record.files) {
      if (!file || Object.keys(file).length !== 3 || typeof file.path !== "string" || !path.isAbsolute(file.path)
        || typeof file.name !== "string" || !/^\d+\.snapshot$/u.test(file.name)
        || !(file.sha256 === null || typeof file.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.sha256))
        || seen.has(file.path)) throw new Error("DESKTOP_DB_BACKUP_INVALID");
      seen.add(file.path);
      const isRoot = suffixes.some(suffix => file.path === path.join(rootDir, `codeflowai.db${suffix}`));
      const isWorkspace = path.basename(path.dirname(file.path)) === ".codeflowai"
        && workspaceNames.some(name => suffixes.some(suffix => path.basename(file.path) === `${name}${suffix}`));
      if (!isRoot && !isWorkspace) throw new Error("DESKTOP_DB_BACKUP_INVALID");
      await assertDesktopStoragePath(file.path);
    }
    return record;
  };
  /** 快照清单原子落盘以后才允许启动可能迁移数据库的候选 Client。 */
  const prepare = async (releaseId: string): Promise<void> => {
    assertReleaseId(releaseId);
    const previous = await read();
    if (previous?.state === "prepared") throw new Error("DESKTOP_DB_BACKUP_ALREADY_EXISTS");
    const database = path.join(rootDir, "codeflowai.db");
    await assertDesktopStoragePath(database);
    let workspacePaths: string[] = [];
    const stat = await optionalStat(database);
    if (stat) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").get();
        if (table) workspacePaths = db.prepare("SELECT path FROM workspaces").all().map(row => {
          if (typeof row.path !== "string" || !path.isAbsolute(row.path)) throw new Error("DESKTOP_DB_WORKSPACE_PATH_INVALID");
          return row.path;
        });
      } finally { db.close(); }
    }
    const databases = [database, ...new Set(workspacePaths.flatMap(workspace => workspaceNames.map(name => path.join(workspace, ".codeflowai", name))))];
    await assertDesktopStoragePath(backupsRoot);
    await fs.mkdir(backupsRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(backupsRoot, ".update-db-"));
    const files: BackupFile[] = [];
    for (const databasePath of databases) for (const suffix of suffixes) {
      const filePath = `${databasePath}${suffix}`, name = `${files.length}.snapshot`;
      await assertDesktopStoragePath(filePath);
      const entry = await optionalStat(filePath);
      if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error("DESKTOP_DB_BACKUP_FILE_INVALID");
      let sha256: string | null = null;
      if (entry) {
        await fs.copyFile(filePath, path.join(directory, name));
        await flushFile(path.join(directory, name));
        sha256 = await digest(path.join(directory, name));
      }
      files.push({ path: filePath, name, sha256 });
    }
    await flushDirectory(directory);
    await flushDirectory(backupsRoot);
    const record: BackupRecord = { schemaVersion: 1, state: "prepared", releaseId, directory: path.basename(directory), files };
    await writeDurableJson(markerPath, record);
    // 新恢复点已持久化后才淘汰上次已完成快照，始终保留当前唯一恢复材料。
    if (previous) await fs.rm(path.join(backupsRoot, previous.directory), { recursive: true });
  };
  /** 先完整核验全部副本再恢复；失败保留标记供下次启动继续。 */
  const restore = async (): Promise<void> => {
    const record = await read();
    if (!record || record.state !== "prepared") return;
    const directory = path.join(backupsRoot, record.directory);
    await assertDesktopStoragePath(directory);
    for (const file of record.files) if (file.sha256 !== null) {
      const source = path.join(directory, file.name);
      await assertDesktopStoragePath(source);
      if (await digest(source) !== file.sha256) throw new Error("DESKTOP_DB_BACKUP_HASH_MISMATCH");
    }
    for (const file of record.files) {
      if (file.sha256 === null) await removeDatabaseFile(file.path);
      else {
        await restoreDurableFile(path.join(directory, file.name), file.path);
      }
    }
    await writeDurableJson(markerPath, { ...record, state: "restored" });
  };
  /** 活动指针已提交则保留迁移结果；未提交的中断必须先恢复旧库。 */
  const recover = async (activeReleaseId: string | null): Promise<boolean> => {
    const record = await read();
    if (!record || record.state !== "prepared") return false;
    if (record.releaseId !== activeReleaseId) { await restore(); return true; }
    await writeDurableJson(markerPath, { ...record, state: "committed" });
    return false;
  };
  return { prepare, restore, recover };
}
