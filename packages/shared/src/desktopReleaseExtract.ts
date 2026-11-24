import crypto from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Parser, type ReadEntry } from "tar";
import { assertReleaseFilePath, type ReleaseBundleManifest } from "./desktopReleaseContract.js";

/** 仅标识本模块合成的操作组合，展平去重时保留外部I/O聚合的原实体。 */
class ExtractOperationError extends AggregateError {}

/** 仅向空 staging 安全解包并单遍核整包摘要；调用者须在失败后清理 staging。 */
export async function extractReleaseBundle(input: {
  archivePath: string; stagingDir: string; manifest: ReleaseBundleManifest; signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const stat = await fs.lstat(input.archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DESKTOP_RELEASE_ARCHIVE_INVALID");
  const file = await fs.open(input.archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    const opened = await file.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile() || opened.nlink !== 1) throw new Error("DESKTOP_RELEASE_ARCHIVE_INVALID");
    if (opened.size !== input.manifest.archiveSize) throw new Error("DESKTOP_RELEASE_ARCHIVE_MISMATCH");
    await extractEntries(file, input);
  } catch (error) { failure = { cause: error }; throw error; }
  finally {
    try { await file.close(); }
    catch (error) {
      if (!failure) throw error;
      const causes = failure.cause instanceof ExtractOperationError ? failure.cause.errors : [failure.cause];
      throw new AggregateError([...causes, error], "DESKTOP_RELEASE_ARCHIVE_CLOSE_FAILED");
    }
  }
}

/** 解包同一数据流时核摘要；串行任务保留在途错误，等待文件关闭后返回。 */
async function extractEntries(file: FileHandle, input: {
  stagingDir: string; manifest: ReleaseBundleManifest; signal?: AbortSignal;
}): Promise<void> {
  const inventory = new Map(input.manifest.files.map(entry => [entry.path, entry]));
  const seen = new Map<string, string>();
  const spellings = new Map<string, string>();
  const directories = new Set<string>();
  const active = new Set<ReadEntry>();
  let failure: Error | undefined;
  let aborting = false;
  let eof = false;
  let tasks = Promise.resolve();
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 });

  /** 显式失败并停止解析；操作结算合并独立原因，事件仍按首因收口。 */
  const fail = (cause: unknown, operation = false): void => {
    const error = cause instanceof Error ? cause : operation
      ? new ExtractOperationError([cause], "DESKTOP_RELEASE_EXTRACT_FAILED") : new Error("DESKTOP_RELEASE_EXTRACT_FAILED", { cause });
    if (error instanceof AggregateError && error.errors.includes(failure)) failure = error;
    else if (operation && failure && cause !== failure) {
      const previous = failure instanceof ExtractOperationError ? failure.errors : [failure];
      const following = cause instanceof ExtractOperationError ? cause.errors : [cause];
      failure = new ExtractOperationError([...new Set([...previous, ...following])], "DESKTOP_RELEASE_EXTRACT_TASK_FAILED");
    }
    else failure ??= error;
    if (!aborting) {
      aborting = true;
      parser.abort(new Error("DESKTOP_RELEASE_EXTRACT_ABORTED", { cause: error }));
      for (const entry of active) entry.destroy(error);
    }
    complete();
  };
  /** 操作结算后保留在途独立错误；事件衍生错误仍由fail按首因收口。 */
  const failOperation = (error: unknown): void => { fail(error, true); };
  parser.on("error", fail);
  parser.on("end", complete);
  parser.on("eof", () => { eof = true; });
  parser.on("ignoredEntry", () => fail(new Error("DESKTOP_RELEASE_ARCHIVE_ENTRY_INVALID")));
  parser.on("meta", (metadata: string) => {
    if (metadata.includes("\\")) fail(new Error("DESKTOP_RELEASE_ARCHIVE_PATH_INVALID"));
    else if (metadata.endsWith("\0")) {
      try { assertReleaseFilePath(metadata.replace(/\0+$/, "")); }
      catch { fail(new Error("DESKTOP_RELEASE_ARCHIVE_PATH_INVALID")); }
    } else if (!metadata.endsWith("\n") || metadata.slice(0, -1).split("\n").some(line => {
      const field = /^([1-9][0-9]*) [^= ]+=.*$/u.exec(line);
      return !field || Number(field[1]) !== Buffer.byteLength(line) + 1 || line.includes("\0");
    })) fail(new Error("DESKTOP_RELEASE_ARCHIVE_METADATA_INVALID"));
  });
  parser.filter = (_name, candidate): boolean => {
    const entry = candidate as ReadEntry;
    try {
      if (failure) return false;
      const directory = entry.type === "Directory";
      if (!directory && entry.type !== "File" && entry.type !== "OldFile") throw new Error("DESKTOP_RELEASE_ARCHIVE_ENTRY_INVALID");
      if (entry.header.path?.includes("\\") || entry.path.includes("\\")) throw new Error("DESKTOP_RELEASE_ARCHIVE_PATH_INVALID");
      const relative = directory && entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
      if (relative !== "web" && relative !== "client") assertReleaseFilePath(relative);
      else if (!directory) throw new Error("DESKTOP_RELEASE_ARCHIVE_ENTRY_INVALID");
      const folded = relative.toLowerCase();
      const previous = seen.get(folded);
      if (previous !== undefined) throw new Error("DESKTOP_RELEASE_ARCHIVE_DUPLICATE_ENTRY");
      const parts = relative.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        const parent = parts.slice(0, index).join("/");
        const known = spellings.get(parent.toLowerCase());
        if (known !== undefined && known !== parent) throw new Error("DESKTOP_RELEASE_ARCHIVE_PATH_INVALID");
        spellings.set(parent.toLowerCase(), parent);
        if ((directory || index < parts.length) && inventory.has(parent)) throw new Error("DESKTOP_RELEASE_ARCHIVE_ENTRY_INVALID");
      }
      if (directory) {
        if (entry.size !== 0) throw new Error("DESKTOP_RELEASE_ARCHIVE_ENTRY_INVALID");
        directories.add(relative);
      } else {
        const expected = inventory.get(relative);
        if (!expected || expected.size !== entry.size || directories.has(relative)) throw new Error("DESKTOP_RELEASE_ARCHIVE_FILES_MISMATCH");
      }
      seen.set(folded, relative);
      return true;
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith("DESKTOP_RELEASE_") ? error : new Error("DESKTOP_RELEASE_ARCHIVE_PATH_INVALID"));
      return false;
    }
  };
  parser.on("entry", (entry: ReadEntry) => {
    active.add(entry);
    entry.on("error", fail);
    tasks = tasks.then(async () => {
      if (failure) throw failure;
      input.signal?.throwIfAborted();
      const relative = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
      const target = path.join(input.stagingDir, relative);
      if (entry.type === "Directory") {
        await fs.mkdir(target, { recursive: true, mode: (entry.mode ?? 0o755) & 0o777 });
        entry.resume();
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeEntry(entry, target, input.signal);
      }
      active.delete(entry);
    }).catch(failOperation);
  });
  /** 取消沿同一失败入口终止 parser 和已打开的条目流。 */
  const onAbort = (): void => { fail(input.signal?.reason ?? new Error("DESKTOP_RELEASE_EXTRACT_CANCELLED")); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let position = 0;
    const digest = crypto.createHash("sha256");
    while (position < input.manifest.archiveSize && !failure) {
      input.signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, input.manifest.archiveSize - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw new Error("DESKTOP_RELEASE_ARCHIVE_MISMATCH");
      position += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
      if (!parser.write(buffer.subarray(0, bytesRead)) && !failure) {
        await new Promise<void>(resolve => {
          /** 反压等待在排空、解析失败或结束时解除，并立即解绑临时监听。 */
          const settle = (): void => { parser.off("drain", settle); parser.off("error", settle); parser.off("end", settle); resolve(); };
          parser.once("drain", settle); parser.once("error", settle); parser.once("end", settle);
        });
      }
    }
    if (!failure) parser.end();
    await completed;
    if (!failure && (digest.digest("hex") !== input.manifest.archiveSha256 || (await file.stat()).size !== input.manifest.archiveSize)) {
      throw new Error("DESKTOP_RELEASE_ARCHIVE_MISMATCH");
    }
  } catch (error) { failOperation(error); }
  finally {
    await tasks;
    input.signal?.removeEventListener("abort", onAbort);
  }
  if (failure) throw failure instanceof ExtractOperationError && failure.errors.length === 1 ? failure.errors[0] : failure;
  input.signal?.throwIfAborted();
  if (!eof) throw new Error("DESKTOP_RELEASE_ARCHIVE_TRUNCATED");
  if (input.manifest.files.some(entry => !seen.has(entry.path.toLowerCase()))) throw new Error("DESKTOP_RELEASE_ARCHIVE_FILES_MISMATCH");
}

/** 排他写入并同步普通文件；本地关闭组合保留次因与原始拒绝（含undefined）。 */
async function writeEntry(entry: ReadEntry, target: string, signal?: AbortSignal): Promise<void> {
  const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), (entry.mode ?? 0o644) & 0o777);
  let failure: { cause: unknown } | undefined;
  try {
    let position = 0;
    for await (const chunk of entry) {
      signal?.throwIfAborted();
      let offset = 0;
      while (offset < chunk.length) {
        signal?.throwIfAborted();
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, position);
        if (!bytesWritten) throw new Error("DESKTOP_RELEASE_EXTRACT_WRITE_FAILED");
        offset += bytesWritten;
        position += bytesWritten;
      }
    }
    if (position !== entry.size) throw new Error("DESKTOP_RELEASE_ARCHIVE_FILES_MISMATCH");
    await file.sync();
    signal?.throwIfAborted();
  } catch (error) { failure = { cause: error }; throw error; }
  finally {
    try { await file.close(); }
    catch (error) { throw failure ? new ExtractOperationError([failure.cause, error], "DESKTOP_RELEASE_EXTRACT_CLOSE_FAILED") : error; }
  }
}
