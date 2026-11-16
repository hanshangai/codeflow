import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIRECTORY_PREFIX = "codeflow-client-upgrade-";
const ARCHIVE_NAME = "client.tgz";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export type PreparedClientUpgradePackage = { directory: string; archivePath: string; sha256: string };
export type ClientUpgradePreparationProgress = {
  stage: "checksum" | "download" | "verified";
  downloadedBytes: number;
  totalBytes: number | null;
  elapsedMs: number;
};

export class ClientUpgradePackageError extends Error {
  readonly stage = "prepare";
  constructor(readonly code: string, message: string, cause?: unknown) { super(message, { cause }); }
}

/** 只允许清理本模块创建的单层临时目录及两个固定文件，不递归删除目录。 */
function assertOwnedDirectory(prepared: PreparedClientUpgradePackage): void {
  const directory = path.resolve(prepared.directory);
  if (directory !== prepared.directory || !/^codeflow-client-upgrade-[a-zA-Z0-9]{6}$/.test(path.basename(directory))
    || path.dirname(directory) !== path.resolve(os.tmpdir())
    || prepared.archivePath !== path.join(directory, ARCHIVE_NAME)
    || fs.lstatSync(directory).isSymbolicLink()) {
    throw new ClientUpgradePackageError("CLIENT_UPGRADE_TEMP_PATH_INVALID", "升级临时包路径不合法");
  }
}

export async function cleanupClientUpgradePackage(prepared: PreparedClientUpgradePackage): Promise<void> {
  assertOwnedDirectory(prepared);
  for (const file of [prepared.archivePath, prepared.archivePath + ".part"]) {
    try { await fs.promises.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await fs.promises.rmdir(prepared.directory);
}

/** 停机前重新检查本地文件，防止准备完成后包被删除、损坏或替换。内存占用固定。 */
export function verifyPreparedClientUpgradePackage(prepared: PreparedClientUpgradePackage): void {
  assertOwnedDirectory(prepared);
  const stat = fs.lstatSync(prepared.archivePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{64}$/.test(prepared.sha256)) {
    throw new ClientUpgradePackageError("CLIENT_UPGRADE_PACKAGE_INVALID", "升级包文件无效");
  }
  const fd = fs.openSync(prepared.archivePath, "r");
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.alloc(256 * 1024);
  try {
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  if (digest.digest("hex") !== prepared.sha256) {
    throw new ClientUpgradePackageError("CLIENT_UPGRADE_CHECKSUM_MISMATCH", "升级包 SHA256 不匹配，未停止现有 Client");
  }
}

/** 下载仅接受同源跳转，不携带 Client Key，不把 HTTP 错误正文写入日志。 */
async function fetchUpgradeFile(url: URL, signal: AbortSignal): Promise<Response> {
  const origin = url.origin;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new ClientUpgradePackageError("CLIENT_UPGRADE_REDIRECT_INVALID", "升级包下载跳转缺少地址");
      const next = new URL(location, url);
      if (next.origin !== origin || next.username || next.password || next.hash) {
        throw new ClientUpgradePackageError("CLIENT_UPGRADE_REDIRECT_REJECTED", "升级包下载发生非同源跳转，已拒绝");
      }
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ClientUpgradePackageError("CLIENT_UPGRADE_DOWNLOAD_HTTP_FAILED", `升级文件下载失败：HTTP ${response.status}`);
    }
    return response;
  }
  throw new ClientUpgradePackageError("CLIENT_UPGRADE_REDIRECT_LIMIT", "升级包下载跳转次数过多");
}

/** 在调用方触碰运行进程之前完成下载及摘要校验；只把完整校验过的本地包交给安装器。 */
export async function prepareClientUpgradePackage(input: {
  installUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ClientUpgradePreparationProgress) => void;
}): Promise<PreparedClientUpgradePackage> {
  const url = new URL(input.installUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !url.pathname.endsWith(".tgz")) {
    throw new ClientUpgradePackageError("CLIENT_UPGRADE_URL_INVALID", "升级包下载地址不合法");
  }
  const directory = await fs.promises.mkdtemp(path.join(path.resolve(os.tmpdir()), DIRECTORY_PREFIX));
  const prepared = { directory, archivePath: path.join(directory, ARCHIVE_NAME), sha256: "" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(abort, input.timeoutMs ?? 15 * 60_000);
  const started = Date.now();
  let stage: ClientUpgradePreparationProgress["stage"] = "checksum";
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  const progress = () => input.onProgress?.({ stage, downloadedBytes, totalBytes, elapsedMs: Date.now() - started });
  const heartbeat = setInterval(progress, 15000);
  try {
    progress();
    const checksumUrl = new URL(url); checksumUrl.pathname += ".sha256";
    const checksumResponse = await fetchUpgradeFile(checksumUrl, controller.signal);
    const checksumReader = checksumResponse.body?.getReader();
    if (!checksumReader) throw new ClientUpgradePackageError("CLIENT_UPGRADE_CHECKSUM_INVALID", "升级包校验文件为空");
    let checksum = Buffer.alloc(0);
    try {
      while (true) {
        const { done, value } = await checksumReader.read(); if (done) break;
        if (checksum.length + value.byteLength > 1024) throw new ClientUpgradePackageError("CLIENT_UPGRADE_CHECKSUM_INVALID", "升级包校验文件过大");
        checksum = Buffer.concat([checksum, value]);
      }
    } finally { await checksumReader.cancel().catch(() => { /* read() 已保留传输失败根因。 */ }); }
    prepared.sha256 = checksum.toString("utf8").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(prepared.sha256)) throw new ClientUpgradePackageError("CLIENT_UPGRADE_CHECKSUM_INVALID", "升级包校验文件不是有效的 SHA256");

    stage = "download"; progress();
    const response = await fetchUpgradeFile(url, controller.signal);
    const length = Number(response.headers.get("content-length"));
    totalBytes = Number.isSafeInteger(length) && length > 0 ? length : null;
    if (totalBytes && totalBytes > MAX_ARCHIVE_BYTES) {
      await response.body?.cancel();
      throw new ClientUpgradePackageError("CLIENT_UPGRADE_PACKAGE_TOO_LARGE", "升级包超过大小上限");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ClientUpgradePackageError("CLIENT_UPGRADE_PACKAGE_INVALID", "升级包下载响应为空");
    let file: fs.promises.FileHandle | null = null;
    const digest = crypto.createHash("sha256");
    let header = Buffer.alloc(0);
    let lastProgressAt = Date.now();
    try {
      file = await fs.promises.open(prepared.archivePath + ".part", "wx", 0o600);
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        downloadedBytes += value.byteLength;
        if (downloadedBytes > MAX_ARCHIVE_BYTES) throw new ClientUpgradePackageError("CLIENT_UPGRADE_PACKAGE_TOO_LARGE", "升级包超过大小上限");
        if (header.length < 2) header = Buffer.concat([header, value.subarray(0, 2 - header.length)]);
        digest.update(value); await file.writeFile(value);
        if (Date.now() - lastProgressAt >= 1000) { progress(); lastProgressAt = Date.now(); }
      }
    } finally {
      try { await reader.cancel().catch(() => { /* read() 已保留传输失败根因。 */ }); }
      finally { await file?.close(); }
    }
    controller.signal.throwIfAborted();
    if (header[0] !== 0x1f || header[1] !== 0x8b) throw new ClientUpgradePackageError("CLIENT_UPGRADE_PACKAGE_INVALID", "升级包不是 gzip 文件");
    if (digest.digest("hex") !== prepared.sha256) throw new ClientUpgradePackageError("CLIENT_UPGRADE_CHECKSUM_MISMATCH", "升级包 SHA256 不匹配，未停止现有 Client");
    await fs.promises.rename(prepared.archivePath + ".part", prepared.archivePath);
    stage = "verified"; progress();
    return prepared;
  } catch (cause) {
    try { await cleanupClientUpgradePackage(prepared); }
    catch (cleanupError) { throw new ClientUpgradePackageError("CLIENT_UPGRADE_PREPARE_CLEANUP_FAILED", "升级包准备失败，且临时文件清理失败", new AggregateError([cause, cleanupError])); }
    if (cause instanceof ClientUpgradePackageError) throw cause;
    throw new ClientUpgradePackageError(controller.signal.aborted ? "CLIENT_UPGRADE_DOWNLOAD_ABORTED" : "CLIENT_UPGRADE_DOWNLOAD_FAILED",
      controller.signal.aborted ? "升级包下载超时或已取消，未停止现有 Client" : "升级包下载或写入失败，未停止现有 Client", cause);
  } finally {
    clearTimeout(timeout); clearInterval(heartbeat); input.signal?.removeEventListener("abort", abort);
  }
}
