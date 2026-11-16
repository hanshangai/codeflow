import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 刷新文件内容及元数据；失败保留原错误，关闭错误不能覆盖主因。 */
export async function flushFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  let failure: { error: unknown } | undefined;
  try { await handle.sync(); }
  catch (error) { failure = { error }; throw error; }
  finally {
    try { await handle.close(); }
    catch (error) { throw failure ? new AggregateError([failure.error, error], "DESKTOP_FILE_CLOSE_FAILED") : error; }
  }
}

/** Unix 同步父目录条目；Windows 通过重开目标 FlushFileBuffers 刷新重命名后的文件元数据。 */
async function flushRename(file: string): Promise<void> {
  await flushFile(file);
  await flushDirectory(path.dirname(file));
}

/** POSIX 刷新目录条目；Windows 文件自身 FlushFileBuffers 已覆盖创建/重命名元数据。 */
export async function flushDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await fs.open(directoryPath, "r");
  let failure: { error: unknown } | undefined;
  try { await directory.sync(); }
  catch (error) { failure = { error }; throw error; }
  finally {
    try { await directory.close(); }
    catch (error) { throw failure ? new AggregateError([failure.error, error], "DESKTOP_DIRECTORY_CLOSE_FAILED") : error; }
  }
}

/** 先持久替换为空文件再删除，掉电遗留也不能复活候选 SQLite WAL。 */
export async function removeDatabaseFile(file: string): Promise<void> {
  try { await fs.access(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const temporary = `${file}.${crypto.randomUUID()}.empty`;
  await fs.writeFile(temporary, "", { flag: "wx", mode: 0o600 });
  await flushFile(temporary);
  await fs.rename(temporary, file);
  await flushRename(file);
  await fs.rm(file);
  await flushDirectory(path.dirname(file));
}

/** 先持久完整临时载荷，再原子替换并刷新目标；仅供更新状态事实使用。 */
export async function writeDurableJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await flushFile(temporary);
    await fs.rename(temporary, file);
    await flushRename(file);
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "DESKTOP_STATE_WRITE_CLEANUP_FAILED"); }
    throw error;
  }
}

/** 恢复副本先刷盘再替换，完成后才允许删除恢复标记。 */
export async function restoreDurableFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.${crypto.randomUUID()}.restore`;
  try {
    await fs.copyFile(source, temporary);
    await flushFile(temporary);
    await fs.rename(temporary, target);
    await flushRename(target);
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "DESKTOP_DB_RESTORE_CLEANUP_FAILED"); }
    throw error;
  }
}
