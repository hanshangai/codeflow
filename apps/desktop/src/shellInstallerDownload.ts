import crypto from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ShellReleaseManifest } from "@codeflowai/shared";
import { verifyShellReleaseSignature } from "@codeflowai/shared/desktop-shell-release-signing";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { verifyShellInstallerArtifact } from "./shellReleaseArtifact.js";
import { preserveUpdateNetworkCancellation } from "./updateNetworkRetry.js";

type InstallerInput = {
  directory: string; manifest: unknown; trustedKeys: TrustedReleaseKeys; requestId: string; signal?: AbortSignal; now?: () => number;
  transport: { request(input: { method: "GET"; path: string; requestId: string; range?: string; ifMatch: string; signal?: AbortSignal; streamResponse?: true }): Promise<Response> };
};
export type DownloadedShellInstaller = { installerPath: string; sha256: string; size: number };
type Directory = { path: string; identity: BigIntStats };
const running = new Set<string>();

/** 磁盘和验证错误不归为网络重试；根因由实际业务 owner 统一记录。 */
class InstallerError extends Error {
  /** 错误保留本轮请求及原始主副因，包括 undefined。 */
  constructor(readonly code: string, readonly requestId: string, cause?: unknown) { super(code, { cause }); }
}

/** 单次下载同步关闭后完整验一次；发布仅改变链接数，返回前仍核同一实体与内容元数据。 */
export async function downloadShellInstaller(input: InstallerInput): Promise<DownloadedShellInstaller> {
  const { manifest, root, directory } = installerContext(input), key = root.toLowerCase();
  if (running.has(key)) throw new InstallerError("DESKTOP_SHELL_INSTALLER_BUSY", input.requestId);
  running.add(key);
  try {
    const directories = await snapshotDirectories(root);
    await assertDirectories(directories);
    try { await fs.mkdir(directory); }
    catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause; }
    directories.push(await readDirectory(directory));
    const installerPath = path.join(directory, "installer.exe"), partPath = `${installerPath}.part`;
    const completed = await optionalStat(installerPath), partial = await optionalStat(partPath);
    if (completed && partial) throw new InstallerError("DESKTOP_SHELL_INSTALLER_CACHE_CONFLICT", input.requestId);
    if (completed) {
      await verifyShellInstallerArtifact({ manifest, trustedKeys: input.trustedKeys, installerPath });
      await assertDirectories(directories);
      if (!sameMetadata(completed, await fs.lstat(installerPath, { bigint: true }))) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
      input.signal?.throwIfAborted();
      assertCurrentManifest(manifest, input);
      return { installerPath, sha256: manifest.installerSha256, size: manifest.installerSize };
    }
    await assertDirectories(directories);
    if (partial) assertRegular(partial);
    const file = await fs.open(partPath, constants.O_RDWR | (partial ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
    let failure: { cause: unknown } | undefined, closed: BigIntStats | undefined, syncAttempted = false;
    try {
      const opened = await file.stat({ bigint: true }); assertRegular(opened);
      if (partial && !sameMetadata(partial, opened)) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
      await assertFile(partPath, file, opened);
      if (opened.size > BigInt(manifest.installerSize)) throw new Error("DESKTOP_SHELL_INSTALLER_SIZE_INVALID");
      if (opened.size < BigInt(manifest.installerSize)) await receive(input, manifest, partPath, file, opened, directories);
      await assertDirectories(directories); await assertFile(partPath, file, opened);
      if ((await file.stat({ bigint: true })).size !== BigInt(manifest.installerSize)) throw new Error("DESKTOP_SHELL_INSTALLER_SIZE_INVALID");
      syncAttempted = true; await file.sync(); closed = await file.stat({ bigint: true });
    } catch (cause) { failure = { cause }; }
    if (failure && !syncAttempted) {
      try { await assertDirectories(directories); await file.sync(); }
      catch (cause) { failure = { cause: new AggregateError([failure.cause, cause], "DESKTOP_SHELL_INSTALLER_SYNC_FAILED") }; }
    }
    try { await file.close(); }
    catch (cause) { throw new InstallerError("DESKTOP_SHELL_INSTALLER_CLOSE_FAILED", input.requestId, failure ? new AggregateError([failure.cause, cause], "DESKTOP_SHELL_INSTALLER_CLOSE_FAILED") : cause); }
    if (failure) throw failure.cause;
    await assertDirectories(directories);
    if (!closed || !sameMetadata(closed, await fs.lstat(partPath, { bigint: true }))) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    await verifyShellInstallerArtifact({ manifest, trustedKeys: input.trustedKeys, installerPath: partPath });
    await assertDirectories(directories);
    if (!sameMetadata(closed, await fs.lstat(partPath, { bigint: true }))) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    input.signal?.throwIfAborted();
    assertCurrentManifest(manifest, input);
    // 排他发布同一已验证实体；link/unlink 只允许改变 ctime 和链接数。
    await fs.link(partPath, installerPath);
    const linked = await fs.lstat(installerPath, { bigint: true }), original = await fs.lstat(partPath, { bigint: true });
    if (!sameContentMetadata(closed, linked) || !sameMetadata(linked, original) || linked.nlink !== 2n) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    await assertDirectories(directories); await fs.unlink(partPath);
    const published = await fs.lstat(installerPath, { bigint: true }); assertRegular(published);
    if (!sameContentMetadata(linked, published)) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    await assertDirectories(directories); input.signal?.throwIfAborted();
    if (!sameMetadata(published, await fs.lstat(installerPath, { bigint: true }))) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    assertCurrentManifest(manifest, input);
    return { installerPath, sha256: manifest.installerSha256, size: manifest.installerSize };
  } catch (cause) {
    if (cause instanceof InstallerError || (input.signal?.aborted && cause === input.signal.reason)
      || (cause instanceof Error && "code" in cause && ["DESKTOP_UPDATE_TRANSPORT_FAILED", "DESKTOP_UPDATE_RESPONSE_INVALID", "DESKTOP_UPDATE_HTTP_FAILED"].includes(String(cause.code)))) throw cause;
    throw new InstallerError("DESKTOP_SHELL_INSTALLER_DOWNLOAD_FAILED", input.requestId, cause);
  } finally { running.delete(key); }
}

/** 只读复验已发布安装器；显式已安装上下文仅豁免时效，part不证明完成且始终不联网。 */
export async function recoverShellInstaller(input: Omit<InstallerInput, "transport"> & { installed?: true }): Promise<{ status: "unknown" } | { status: "verified"; value: DownloadedShellInstaller }> {
  if (input.installed !== undefined && input.installed !== true) throw new InstallerError("DESKTOP_SHELL_INSTALLER_INPUT_INVALID", input.requestId);
  const installed = input.installed === true;
  const { manifest, root, directory } = installerContext(input, !installed);
  try {
    const directories = await snapshotDirectories(root);
    if (!await optionalStat(directory)) { await assertDirectories(directories); input.signal?.throwIfAborted(); return { status: "unknown" }; }
    directories.push(await readDirectory(directory));
    const installerPath = path.join(directory, "installer.exe"), completed = await optionalStat(installerPath), partial = await optionalStat(`${installerPath}.part`);
    if (completed && partial) throw new Error("DESKTOP_SHELL_INSTALLER_CACHE_CONFLICT");
    if (!completed) {
      if (partial) { assertRegular(partial); if (partial.size > BigInt(manifest.installerSize)) throw new Error("DESKTOP_SHELL_INSTALLER_SIZE_INVALID"); }
      await assertDirectories(directories); input.signal?.throwIfAborted(); return { status: "unknown" };
    }
    await verifyShellInstallerArtifact({ manifest, trustedKeys: input.trustedKeys, installerPath });
    await assertDirectories(directories); input.signal?.throwIfAborted();
    if (!sameMetadata(completed, await fs.lstat(installerPath, { bigint: true }))) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
    if (!installed) assertCurrentManifest(manifest, input);
    return { status: "verified", value: { installerPath, sha256: manifest.installerSha256, size: manifest.installerSize } };
  } catch (cause) { throw new InstallerError("DESKTOP_SHELL_INSTALLER_RECOVERY_FAILED", input.requestId, cause); }
}

/** 共用纯验签/时效/路径推导；结果路径只由规范完整清单摘要生成。 */
function installerContext(input: Omit<InstallerInput, "transport">, requireFresh = true) {
  input.signal?.throwIfAborted();
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(input.requestId)
    || typeof input.directory !== "string" || !path.isAbsolute(input.directory)) throw new InstallerError("DESKTOP_SHELL_INSTALLER_INPUT_INVALID", input.requestId);
  const manifest = verifyShellReleaseSignature(input.manifest, input.trustedKeys);
  if (requireFresh) assertCurrentManifest(manifest, input);
  else if (manifest.platform !== "win32" || manifest.arch !== "x64") throw new InstallerError("DESKTOP_SHELL_INSTALLER_MANIFEST_INVALID", input.requestId);
  const root = path.resolve(input.directory), directory = path.join(root, crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
  return { root, directory, manifest };
}

/** 发布和读取返回前重核同一份已验签清单的时效，不换成调用方后来提供的目标。 */
function assertCurrentManifest(manifest: ShellReleaseManifest, input: Pick<InstallerInput, "now" | "requestId">): void {
  const now = input.now?.() ?? Date.now();
  if (!Number.isFinite(now) || manifest.platform !== "win32" || manifest.arch !== "x64"
    || Date.parse(manifest.createdAt) > now || now >= Date.parse(manifest.expiresAt)) throw new InstallerError("DESKTOP_SHELL_INSTALLER_MANIFEST_INVALID", input.requestId);
}

/** 一个响应写完或显式失败；纯取消保留原 reason，reader 清理与前缀关闭仍须完成。 */
async function receive(input: InstallerInput, manifest: ShellReleaseManifest, target: string, file: FileHandle, opened: BigIntStats, directories: Directory[]): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, failure: { cause: unknown } | undefined;
  let readFailure: { cause: unknown } | undefined;
  const start = Number(opened.size), abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  try {
    const response = await input.transport.request({ method: "GET", path: `/api/software/desktop/shell-releases/${manifest.shellId}/installer`,
      requestId: input.requestId, ifMatch: `"${manifest.installerSha256}"`, ...(start ? { range: `bytes=${start}-` } : {}), signal, streamResponse: true });
    reader = response.body?.getReader();
    if (response.status !== (start ? 206 : 200) || response.headers.get("etag") !== `"${manifest.installerSha256}"`
      || response.headers.get("content-length") !== String(manifest.installerSize - start)
      || response.headers.get("content-range") !== (start ? `bytes ${start}-${manifest.installerSize - 1}/${manifest.installerSize}` : null)
      || ![null, "identity"].includes(response.headers.get("content-encoding")) || !reader) throw new Error("DESKTOP_SHELL_INSTALLER_RESPONSE_INVALID");
    let position = start;
    while (true) {
      signal.throwIfAborted();
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch (cause) {
        readFailure = { cause };
        const failure = preserveUpdateNetworkCancellation(cause, input.signal);
        if (input.signal?.aborted && failure === input.signal.reason) throw failure;
        throw Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: failure }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: input.requestId });
      }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > manifest.installerSize - position) throw new Error("DESKTOP_SHELL_INSTALLER_RESPONSE_INVALID");
      let offset = 0;
      while (offset < next.value.byteLength) {
        signal.throwIfAborted(); await assertDirectories(directories); await assertFile(target, file, opened);
        const { bytesWritten } = await file.write(next.value, offset, next.value.byteLength - offset, position);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > next.value.byteLength - offset) throw new Error("DESKTOP_SHELL_INSTALLER_SHORT_WRITE");
        position += bytesWritten; offset += bytesWritten;
      }
    }
    if (position !== manifest.installerSize) throw new Error("DESKTOP_SHELL_INSTALLER_RESPONSE_INVALID");
  } catch (cause) { failure = { cause }; }
  try { if (reader) await reader.cancel(); }
  catch (cause) {
    // 已 errored 的流会把同一根因再次交给 cancel；仅去重同一实体，其他清理副因必须保留。
    if (!readFailure || !(cause instanceof Error) || cause !== readFailure.cause) failure = { cause: failure ? new AggregateError([failure.cause, cause], "DESKTOP_SHELL_INSTALLER_READER_CANCEL_FAILED") : cause };
  }
  try { reader?.releaseLock(); }
  catch (cause) { failure = { cause: failure ? new AggregateError([failure.cause, cause], "DESKTOP_SHELL_INSTALLER_READER_RELEASE_FAILED") : cause }; }
  abort.abort();
  if (failure) throw failure.cause;
}

/** 只有缺失是正常缓存分支，所有访问故障显式上抛。 */
async function optionalStat(target: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined; throw cause; }
}

/** 文件只能是独立普通实体，写入不跟随符号或硬链接。 */
function assertRegular(stat: BigIntStats): void { if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("DESKTOP_SHELL_INSTALLER_PATH_INVALID"); }

/** 写入会改变时间与长度，身份比较只负责同一实体，读后核验另比完整元数据。 */
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode; }

/** link/unlink 改变 ctime 和链接数，已验内容仍须绑定同一实体、大小与修改时间。 */
function sameContentMetadata(a: BigIntStats, b: BigIntStats): boolean { return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs; }

/** 完成读写并关闭后的实体不得被替换、截断、改写或增加别名。 */
function sameMetadata(a: BigIntStats, b: BigIntStats): boolean { return sameIdentity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }

/** 同时核对已开句柄和路径，拒绝落盘过程中被替换或增加链接。 */
async function assertFile(target: string, file: FileHandle, expected: BigIntStats): Promise<void> {
  const current = await file.stat({ bigint: true }), pathname = await fs.lstat(target, { bigint: true });
  assertRegular(current); assertRegular(pathname);
  if (!sameIdentity(expected, current) || !sameMetadata(current, pathname)) throw new Error("DESKTOP_SHELL_INSTALLER_FILE_CHANGED");
}

/** 每层目录都固定真实实体，根路径和内部目录均不跟随链接。 */
async function readDirectory(target: string): Promise<Directory> {
  const identity = await fs.lstat(target, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("DESKTOP_SHELL_INSTALLER_DIRECTORY_INVALID");
  return { path: target, identity };
}

/** 从卷根逐层取样，防止祖先重指令本次写入逃离调用方结果根。 */
async function snapshotDirectories(target: string): Promise<Directory[]> {
  let current = path.parse(target).root;
  const result = [await readDirectory(current)];
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) { current = path.join(current, segment); result.push(await readDirectory(current)); }
  return result;
}

/** 目录内容可因本次写入变化，但路径必须仍对应同一普通目录。 */
async function assertDirectories(directories: Directory[]): Promise<void> {
  for (const entry of directories) { const current = await readDirectory(entry.path); if (!sameIdentity(entry.identity, current.identity)) throw new Error("DESKTOP_SHELL_INSTALLER_DIRECTORY_CHANGED"); }
}
