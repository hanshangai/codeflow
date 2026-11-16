import fs from "node:fs/promises";
import path from "node:path";
import { assertReleaseId } from "./contracts.js";
import { assertDesktopStoragePath, readDesktopJsonFile } from "./desktopStorageLocation.js";
import { writeDurableJson } from "./durableFile.js";

export type PendingRelease = { requestId: string; releaseId: string; stagingDir: string };
const fileName = "pending-release.json";

/** 只保存协调器直属暂存目录；持久记录不接受页面或任意绝对路径。 */
export async function savePendingRelease(root: string, pending: PendingRelease): Promise<void> {
  const rootDir = path.resolve(root), stagingDir = path.resolve(pending.stagingDir);
  assertReleaseId(pending.releaseId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(pending.requestId)
    || path.dirname(stagingDir) !== path.join(rootDir, ".staging")) throw new Error("DESKTOP_PENDING_RELEASE_INVALID");
  await assertDesktopStoragePath(stagingDir);
  await writeDurableJson(path.join(rootDir, fileName), { schemaVersion: 1, requestId: pending.requestId, releaseId: pending.releaseId, stagingName: path.basename(stagingDir) });
}

/** 启动恢复待更新事实；协调器移动目录后断电时沿同一 release 目录继续。 */
export async function readPendingRelease(root: string): Promise<PendingRelease | null> {
  const rootDir = path.resolve(root), value = await readDesktopJsonFile(path.join(rootDir, fileName));
  if (value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.schemaVersion !== 1 || typeof record.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.requestId)
    || typeof record.stagingName !== "string" || path.basename(record.stagingName) !== record.stagingName
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(record.stagingName)) throw new Error("DESKTOP_PENDING_RELEASE_INVALID");
  const releaseId = assertReleaseId(record.releaseId);
  let stagingDir = path.join(rootDir, ".staging", record.stagingName);
  try { await fs.access(stagingDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    stagingDir = path.join(rootDir, "releases", releaseId);
  }
  await assertDesktopStoragePath(stagingDir);
  return { requestId: record.requestId, releaseId, stagingDir };
}

/** 只在已激活或明确放弃旧尝试时清除记录，不删除用户数据。 */
export async function clearPendingRelease(root: string): Promise<void> {
  await fs.rm(path.join(path.resolve(root), fileName), { force: true });
}
