import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { desktopDeviceRequestTarget } from "@codeflowai/shared/desktop-device-auth";
import { verifyReleaseBundleSignature, type TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { assertReleaseBundleManifest, type ReleaseBundleManifest } from "@codeflowai/shared";
import type { createDesktopUpdateTransport } from "./updateTransport.js";
import { preserveUpdateNetworkCancellation, type UpdateNetworkRetry } from "./updateNetworkRetry.js";

export type DownloadOptions = {
  rootDir: string;
  manifestBytes: Uint8Array;
  archivePath: string;
  transport: Pick<ReturnType<typeof createDesktopUpdateTransport>, "request">;
  trustedReleaseKeys: TrustedReleaseKeys;
  platform?: string;
  arch?: string;
  now?: () => number;
  signal?: AbortSignal;
  requestId?: string;
  /** 本轮共享网络预算；仅读流和传输故障可重试，磁盘及包校验不进入该边界。 */
  networkRetry?: UpdateNetworkRetry;
  /** 归档完整落盘后追加 received 阶段事实；失败显式阻止本次下载返回。 */
  receivedReporter?: (received: { requestId: string; directory: string; archivePath: string; manifest: ReleaseBundleManifest }) => Promise<void>;
  /** 仅报告实际传输/校验边界；观察不拥有重试或资源释放权。 */
  onPhase?: (phase: "download" | "verify") => void;
  /** 下载阶段字节进度；仅用于状态展示，不参与重试或校验。 */
  onProgress?: (received: number, total: number) => void;
};
type DownloadedRelease = { requestId: string; directory: string; archivePath: string; manifest: ReleaseBundleManifest };
const inFlight = new Set<string>();

/** 固定错误码与请求标识交给拥有更新上下文的调用边界记录，不携带包正文。 */
class DownloadError extends Error {
  /** 保留系统或传输根因，业务检查只使用固定原因。 */
  constructor(readonly code: string, readonly requestId: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "DesktopReleaseDownloadError";
  }
}

/** 复用下载前的纯清单检查；不联网或落盘，保留固定错误码与安全根因。 */
export function verifyDownloadManifest(input: Pick<DownloadOptions, "manifestBytes" | "trustedReleaseKeys" | "platform" | "arch" | "now">
  & { requestId: string }): ReleaseBundleManifest {
  const requestId = input.requestId;
  let parsed: ReleaseBundleManifest;
  try { parsed = assertReleaseBundleManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes))); }
  catch (cause) {
    // schema 的未知字段名可能来自远端正文，不能原样带入异常链。
    throw new DownloadError("DESKTOP_RELEASE_MANIFEST_INVALID", requestId,
      cause instanceof SyntaxError ? new Error("INVALID_JSON") : cause instanceof TypeError ? cause : new Error("INVALID_RELEASE_MANIFEST"));
  }
  let manifest: ReleaseBundleManifest;
  try { manifest = verifyReleaseBundleSignature(parsed, input.trustedReleaseKeys); }
  catch (cause) {
    const code = cause instanceof Error
      ? /^(DESKTOP_RELEASE_(?:UNTRUSTED_KEY|SIGNATURE_INVALID|PUBLIC_KEY_INVALID))(?:$|:)/.exec(cause.message)?.[1] : undefined;
    throw new DownloadError(code ?? "DESKTOP_RELEASE_MANIFEST_INVALID", requestId, code ? new Error(code) : cause);
  }
  if (manifest.platform !== (input.platform ?? process.platform) || manifest.arch !== (input.arch ?? process.arch)) {
    throw new DownloadError("DESKTOP_RELEASE_PLATFORM_MISMATCH", requestId);
  }
  if (Date.parse(manifest.expiresAt) <= (input.now?.() ?? Date.now())) throw new DownloadError("DESKTOP_RELEASE_EXPIRED", requestId);
  return manifest;
}

/** 按已验签清单字节隔离下载缓存；关闭失败保留原因，不修改活动资源。 */
export async function downloadReleaseBundle(input: DownloadOptions): Promise<DownloadedRelease> {
  const requestId = input.requestId ?? crypto.randomUUID();
  let lock: string | undefined;
  try {
    input.signal?.throwIfAborted();
    const manifestBytes = Buffer.from(input.manifestBytes);
    const manifest = verifyDownloadManifest({ ...input, manifestBytes, requestId });
    desktopDeviceRequestTarget(input.archivePath);
    const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    const directory = path.resolve(input.rootDir, ".staging", `download-${manifestSha256}`);
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (inFlight.has(key)) throw new DownloadError("DESKTOP_RELEASE_DOWNLOAD_BUSY", requestId);
    inFlight.add(key);
    lock = key;
    await ensureDirectory(directory, requestId);
    await bindManifest(directory, manifestBytes, requestId);
    const archivePath = path.join(directory, "bundle.tar.gz");
    const partPath = path.join(directory, "bundle.tar.gz.part");
    const completed = await optionalStat(archivePath);
    const partial = await optionalStat(partPath);
    if (completed && partial) throw new DownloadError("DESKTOP_RELEASE_CACHE_CONFLICT", requestId);
    const filePath = completed ? archivePath : partPath;
    const file = await openRegular(filePath, completed ? constants.O_RDONLY : constants.O_RDWR, !completed && !partial, requestId);
    let failure: { cause: unknown } | undefined;
    try {
      const size = (await file.stat()).size;
      if (size > manifest.archiveSize || (completed && size !== manifest.archiveSize)) {
        throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
      }
      if (!completed && size < manifest.archiveSize) { input.onPhase?.("download"); await receiveArchive(input, file, size, manifest, requestId); }
      input.onPhase?.("verify");
      await verifyArchive(file, manifest, input.signal, requestId);
      await ensureDirectory(directory, requestId);
      await assertSameFile(filePath, file, requestId);
      if (!completed) {
        await file.sync();
        input.signal?.throwIfAborted();
        if (await optionalStat(archivePath)) throw new DownloadError("DESKTOP_RELEASE_CACHE_CONFLICT", requestId);
        input.signal?.throwIfAborted();
        await fs.rename(partPath, archivePath);
      }
      const archived = await fs.lstat(archivePath);
      if (!archived.isFile() || archived.size !== manifest.archiveSize) throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
      const result = { requestId, directory, archivePath, manifest };
      await input.receivedReporter?.(result);
      return result;
    } catch (error) {
      failure = { cause: error };
      if (error instanceof DownloadError && ["DESKTOP_RELEASE_ARCHIVE_MISMATCH", "DESKTOP_RELEASE_ETAG_MISMATCH"].includes(error.code)) {
        try {
          await ensureDirectory(directory, requestId);
          await assertSameFile(filePath, file, requestId);
          await fs.unlink(filePath);
        } catch (cleanup) {
          failure = { cause: new AggregateError([error, cleanup], "DESKTOP_RELEASE_DOWNLOAD_DISCARD_FAILED") };
          throw failure.cause;
        }
      }
      throw error;
    }
    finally {
      try { await file.close(); }
      catch (error) { throw failure ? new AggregateError([failure.cause, error], "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED") : error; }
    }
  } catch (cause) {
    if (cause instanceof DownloadError) throw cause;
    throw new DownloadError(input.signal?.aborted ? "DESKTOP_RELEASE_DOWNLOAD_CANCELLED" : "DESKTOP_RELEASE_DOWNLOAD_FAILED", requestId, cause);
  } finally { if (lock !== undefined) inFlight.delete(lock); }
}

/** 仅 ENOENT 表示不存在，其余文件系统错误全部上抛。 */
async function optionalStat(target: string): Promise<Stats | undefined> {
  try { return await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** 从根目录逐段检查；并发创建后仍复验，拒绝任何祖先链接或非目录。 */
async function ensureDirectory(directory: string, requestId: string): Promise<void> {
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!await optionalStat(current)) {
      try { await fs.mkdir(current); }
      catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause; }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DownloadError("DESKTOP_RELEASE_CACHE_UNSAFE", requestId);
  }
}

/** 打开的句柄必须仍对应原路径的单链接普通文件，禁止跟随链接写出缓存。 */
async function assertSameFile(target: string, file: FileHandle, requestId: string): Promise<void> {
  const pathname = await fs.lstat(target);
  const opened = await file.stat();
  if (!pathname.isFile() || pathname.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1
    || pathname.dev !== opened.dev || pathname.ino !== opened.ino) throw new DownloadError("DESKTOP_RELEASE_CACHE_UNSAFE", requestId);
}

/** 排他新建失败时仅清理再次确认身份的新文件；既有文件保持不变。 */
async function openRegular(target: string, flags: number, create: boolean, requestId: string): Promise<FileHandle> {
  if (!create) {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DownloadError("DESKTOP_RELEASE_CACHE_UNSAFE", requestId);
  }
  const file = await fs.open(target, flags | (constants.O_NOFOLLOW ?? 0) | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try { await assertSameFile(target, file, requestId); return file; }
  catch (error) {
    let failure = error;
    if (create) {
      try {
        await ensureDirectory(path.dirname(target), requestId);
        await assertSameFile(target, file, requestId);
        await fs.unlink(target);
      } catch (cleanup) { failure = new AggregateError([error, cleanup], "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED"); }
    }
    try { await file.close(); }
    catch (cleanup) { throw new AggregateError([failure, cleanup], "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED"); }
    throw failure;
  }
}

/** 原字节绑定续传身份；只清理本次新清单，关闭失败保留原操作及清理原因。 */
async function bindManifest(directory: string, bytes: Buffer, requestId: string): Promise<void> {
  const entries = await fs.readdir(directory);
  if (entries.some(name => !["manifest.json", "bundle.tar.gz", "bundle.tar.gz.part"].includes(name))
    || (!entries.includes("manifest.json") && entries.length !== 0)) throw new DownloadError("DESKTOP_RELEASE_CACHE_CONFLICT", requestId);
  const existing = entries.includes("manifest.json");
  const manifestPath = path.join(directory, "manifest.json");
  const file = await openRegular(manifestPath, existing ? constants.O_RDONLY : constants.O_WRONLY, !existing, requestId);
  let failure: { cause: unknown } | undefined;
  try {
    if (existing) {
      if ((await file.stat()).size !== bytes.length || !(await file.readFile()).equals(bytes)) throw new DownloadError("DESKTOP_RELEASE_CACHE_CONFLICT", requestId);
    } else { await file.writeFile(bytes); await file.sync(); }
  } catch (error) {
    failure = { cause: error };
    if (!existing) {
      try {
        await ensureDirectory(directory, requestId);
        await assertSameFile(manifestPath, file, requestId);
        await fs.unlink(manifestPath);
      } catch (cleanup) {
        failure = { cause: new AggregateError([error, cleanup], "DESKTOP_RELEASE_MANIFEST_CLEANUP_FAILED") };
        throw failure.cause;
      }
    }
    throw error;
  }
  finally {
    try { await file.close(); }
    catch (error) { throw failure ? new AggregateError([failure.cause, error], "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED") : error; }
  }
}

/** 响应必须完整覆盖剩余区间，强 ETag、编码与声明长度缺一不可。 */
function assertResponse(response: Response, start: number, manifest: ReleaseBundleManifest, requestId: string): void {
  const encoding = response.headers.get("content-encoding");
  const range = response.headers.get("content-range");
  const etag = response.headers.get("etag");
  if (etag !== `"${manifest.archiveSha256}"` && etag !== null && /^"[^"\x00-\x20\x7f]*"$/.test(etag)) {
    throw new DownloadError("DESKTOP_RELEASE_ETAG_MISMATCH", requestId);
  }
  if (response.status !== (start ? 206 : 200) || etag !== `"${manifest.archiveSha256}"`
    || (encoding !== null && encoding !== "identity") || response.headers.get("content-length") !== String(manifest.archiveSize - start)
    || range !== (start ? `bytes ${start}-${manifest.archiveSize - 1}/${manifest.archiveSize}` : null) || !response.body) {
    throw new DownloadError("DESKTOP_RELEASE_RESPONSE_INVALID", requestId);
  }
}

/** 临时网络失败沿已写前缀续传；每次重读 fd 大小，不重放磁盘写入或校验失败。 */
async function receiveArchive(input: DownloadOptions, file: FileHandle, start: number, manifest: ReleaseBundleManifest, requestId: string): Promise<void> {
  input.onProgress?.(start, manifest.archiveSize);
  if (!input.networkRetry) return await receiveArchiveOnce(input, file, start, manifest, requestId);
  await input.networkRetry.run(async () => {
    const size = (await file.stat()).size;
    if (size > manifest.archiveSize) throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
    if (size < manifest.archiveSize) await receiveArchiveOnce(input, file, size, manifest, requestId);
  });
}

/** 单次响应校验后才写入；收尾保留全部原因，仅已知读流网络故障交给原重试。 */
async function receiveArchiveOnce(input: DownloadOptions, file: FileHandle, start: number, manifest: ReleaseBundleManifest, requestId: string): Promise<void> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failure: { cause: unknown } | undefined;
  let settled = false;
  /** 清理次因不覆盖主因；原领域短码与请求关联保持，聚合阻止网络重试。 */
  const retainCleanup = (cause: unknown): void => {
    const original = failure?.cause;
    const combined = failure ? new AggregateError([original, cause], "DESKTOP_RELEASE_DOWNLOAD_CLEANUP_FAILED") : cause;
    failure = { cause: original instanceof DownloadError ? new DownloadError(original.code, requestId, combined) : combined };
  };
  try {
    const response = await input.transport.request({ method: "GET", path: input.archivePath, requestId,
      ifMatch: `"${manifest.archiveSha256}"`, ...(start ? { range: `bytes=${start}-` } : {}), streamResponse: true,
      signal: input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal });
    reader = response.body?.getReader();
    assertResponse(response, start, manifest, requestId);
    let position = start;
    while (true) {
      input.signal?.throwIfAborted();
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader!.read(); }
      catch (cause) {
        settled = true;
        if (!input.networkRetry) throw cause;
        const failure = preserveUpdateNetworkCancellation(cause, input.signal);
        if (input.signal?.aborted && failure === input.signal.reason) throw failure;
        throw Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: failure }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId });
      }
      const { value, done } = next;
      if (done) { settled = true; break; }
      input.signal?.throwIfAborted();
      if (value.byteLength > manifest.archiveSize - position) throw new DownloadError("DESKTOP_RELEASE_RESPONSE_INVALID", requestId);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, position);
        if (!bytesWritten) throw new DownloadError("DESKTOP_RELEASE_DOWNLOAD_FAILED", requestId);
        offset += bytesWritten;
        position += bytesWritten;
      }
      input.onProgress?.(position, manifest.archiveSize);
    }
    if (position !== manifest.archiveSize) throw new DownloadError("DESKTOP_RELEASE_RESPONSE_INVALID", requestId);
  } catch (cause) { failure = { cause }; }
  try { if (reader && !settled) await reader.cancel(); }
  catch (cause) { retainCleanup(cause); }
  abort.abort();
  try { reader?.releaseLock(); }
  catch (cause) { retainCleanup(cause); }
  if (failure) throw failure.cause;
}

/** 同一 fd 分块核对完整长度和 SHA-256，缓存命中也必须重新读取。 */
async function verifyArchive(file: FileHandle, manifest: ReleaseBundleManifest, signal: AbortSignal | undefined, requestId: string): Promise<void> {
  if ((await file.stat()).size !== manifest.archiveSize) throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < manifest.archiveSize) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, manifest.archiveSize - position), position);
    if (!bytesRead) throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  signal?.throwIfAborted();
  if (digest.digest("hex") !== manifest.archiveSha256 || (await file.stat()).size !== manifest.archiveSize) {
    throw new DownloadError("DESKTOP_RELEASE_ARCHIVE_MISMATCH", requestId);
  }
}
