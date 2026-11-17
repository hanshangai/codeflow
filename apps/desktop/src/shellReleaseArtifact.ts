import crypto from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ShellReleaseManifest } from "@codeflowai/shared";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { verifyShellReleaseSignature } from "@codeflowai/shared/desktop-shell-release-signing";

type VerificationPhase = "signature" | "installer" | "candidate";
type DirectorySnapshot = { directory: string; stat: BigIntStats; names: string[] };

/** 低层只保留校验原因；调用入口再附加已验签身份和阶段。 */
class ArtifactError extends Error {
  readonly code: string;
  /** 校验错误采用稳定代码，原始 I/O 或双故障保持在 cause 中。 */
  constructor(code: string, cause?: unknown) {
    super(`DESKTOP_SHELL_ARTIFACT_${code}`, { cause });
    this.code = this.message;
  }
}

/** 先验签，再只读校验独立安装器和候选目录全部物理普通文件；不安装或激活。 */
export async function verifyShellReleaseArtifact(input: {
  manifest: unknown; trustedKeys: TrustedReleaseKeys; installerPath: string; candidateDirectory: string;
}): Promise<ShellReleaseManifest> {
  const { manifest, installerPath, installer, view } = await verifyInstaller(input);
  let phase: VerificationPhase = "candidate", artifactPath: string | undefined;
  try {
    artifactPath = input.candidateDirectory;
    const candidate = await view.promises.realpath(path.resolve(input.candidateDirectory));
    artifactPath = candidate;
    const physicalInstaller = await view.promises.realpath(installerPath);
    const relativeInstaller = path.relative(candidate, physicalInstaller);
    if (!relativeInstaller || (!path.isAbsolute(relativeInstaller) && relativeInstaller !== ".." && !relativeInstaller.startsWith(`..${path.sep}`))) {
      throw new ArtifactError("PATH_OVERLAP");
    }
    if (!sameMetadata(installer, await view.promises.lstat(installerPath, { bigint: true }))) throw new ArtifactError("FILE_CHANGED");
    await verifyCandidate(candidate, manifest, installer, view);
    phase = "installer";
    artifactPath = installerPath;
    if (!sameMetadata(installer, await view.promises.lstat(installerPath, { bigint: true }))) throw new ArtifactError("FILE_CHANGED");
    return manifest;
  } catch (cause) {
    const error = cause instanceof ArtifactError ? cause : new ArtifactError("IO_FAILED", cause);
    throw Object.assign(error, { phase, shellId: manifest.shellId, artifactPath });
  }
}

/** 只读核验独立安装器；不需要候选库存，不执行安装或判断当前发布资格。 */
export async function verifyShellInstallerArtifact(input: {
  manifest: unknown; trustedKeys: TrustedReleaseKeys; installerPath: string;
}): Promise<ShellReleaseManifest> {
  return (await verifyInstaller(input)).manifest;
}

/** 仅已验签完整库存可证明现有壳相同；内容差异返回 false，物理读取异常仍失败。 */
export async function matchesInstalledShellRelease(input: {
  manifest: unknown; trustedKeys: TrustedReleaseKeys; candidateDirectory: string;
}): Promise<boolean> {
  const manifest = verifyShellReleaseSignature(input.manifest, input.trustedKeys);
  const view: typeof fs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : fs;
  const directory = path.resolve(input.candidateDirectory), stat = await view.promises.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError("PATH_INVALID");
  return await verifyCandidate(directory, manifest, undefined, view, true);
}

/** 完整候选与单安装器共用验签、同 fd 摘要及错误翻译边界。 */
async function verifyInstaller(input: { manifest: unknown; trustedKeys: TrustedReleaseKeys; installerPath: string }) {
  let manifest: ShellReleaseManifest;
  try { manifest = verifyShellReleaseSignature(input.manifest, input.trustedKeys); }
  catch (cause) { throw Object.assign(new ArtifactError("SIGNATURE_INVALID", cause), { phase: "signature" as VerificationPhase }); }
  let artifactPath: string | undefined;
  try {
    const view: typeof fs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : fs;
    const installerPath = path.resolve(input.installerPath);
    artifactPath = installerPath;
    const installer = await verifyFile(installerPath, { size: manifest.installerSize, sha256: manifest.installerSha256 }, view);
    if (!sameMetadata(installer, await view.promises.lstat(installerPath, { bigint: true }))) throw new ArtifactError("FILE_CHANGED");
    return { manifest, installerPath, installer, view };
  } catch (cause) {
    const error = cause instanceof ArtifactError ? cause : new ArtifactError("IO_FAILED", cause);
    throw Object.assign(error, { phase: "installer" as VerificationPhase, shellId: manifest.shellId, artifactPath });
  }
}

/** 安装器和库存文件均须独立普通文件，拒绝硬链接形成的安装器别名。 */
function assertRegular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new ArtifactError("PATH_INVALID");
}

/** 比对身份和可观察元数据，发现读期间替换、截断或改写时明确失败。 */
function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** 同一个只读句柄最多按 64 KiB 分块摘要，读取和关闭双故障均向上保留。 */
async function verifyFile(target: string, expected: { size: number; sha256: string }, view: typeof fs): Promise<BigIntStats>;
async function verifyFile(target: string, expected: { size: number; sha256: string }, view: typeof fs, compare: boolean): Promise<BigIntStats | null>;
async function verifyFile(target: string, expected: { size: number; sha256: string }, view: typeof fs, compare = false): Promise<BigIntStats | null> {
  const before = await view.promises.lstat(target, { bigint: true });
  assertRegular(before);
  if (before.size !== BigInt(expected.size)) { if (compare) return null; throw new ArtifactError("FILE_MISMATCH"); }
  const file = await view.promises.open(target, view.constants.O_RDONLY | (view.constants.O_NOFOLLOW ?? 0));
  let failed = false, failure: unknown;
  try {
    const opened = await file.stat({ bigint: true });
    assertRegular(opened);
    if (!sameMetadata(before, opened)) throw new ArtifactError("FILE_CHANGED");
    const digest = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(65_536);
    let position = 0;
    while (position < expected.size) {
      const length = Math.min(buffer.length, expected.size - position);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > length) throw new ArtifactError("FILE_MISMATCH");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat({ bigint: true }), pathname = await view.promises.lstat(target, { bigint: true });
    assertRegular(after); assertRegular(pathname);
    if (!sameMetadata(opened, after) || !sameMetadata(opened, pathname)) throw new ArtifactError("FILE_CHANGED");
    if (digest.digest("hex") !== expected.sha256) { if (compare) return null; throw new ArtifactError("FILE_MISMATCH"); }
    return opened;
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await file.close(); }
    catch (error) { throw failed ? new AggregateError([failure, error], "DESKTOP_SHELL_ARTIFACT_CLOSE_FAILED") : error; }
  }
}

/** 清单精确覆盖全部物理文件；根别名已解析，内部目录及文件一律不跟随链接。 */
async function verifyCandidate(root: string, manifest: ShellReleaseManifest, installer: BigIntStats | undefined, view: typeof fs, compare = false): Promise<boolean> {
  const expected = new Map(manifest.files.map(file => [file.path, file])), verified = new Map<string, BigIntStats>();
  const directories: DirectorySnapshot[] = [];
  /** 目录记录身份和条目快照，文件在本次遍历中逐个绑定已签名摘要。 */
  const visit = async (directory: string, relative: string): Promise<boolean> => {
    const stat = await view.promises.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError("PATH_INVALID");
    const names = (await view.promises.readdir(directory)).sort();
    directories.push({ directory, stat, names });
    for (const name of names) {
      const target = path.join(directory, name), filePath = relative ? `${relative}/${name}` : name;
      const entry = await view.promises.lstat(target, { bigint: true });
      if (entry.isSymbolicLink()) throw new ArtifactError("PATH_INVALID");
      if (entry.isDirectory()) { if (!await visit(target, filePath)) return false; }
      else {
        assertRegular(entry);
        if (installer && entry.dev === installer.dev && entry.ino === installer.ino) throw new ArtifactError("PATH_OVERLAP");
        const signed = expected.get(filePath);
        if (!signed) { if (compare) return false; throw new ArtifactError("INVENTORY_MISMATCH"); }
        const stat = await verifyFile(target, signed, view, compare);
        if (!stat) return false;
        verified.set(target, stat);
      }
    }
    return true;
  };
  if (!await visit(root, "")) return false;
  if (verified.size !== expected.size) { if (compare) return false; throw new ArtifactError("INVENTORY_MISMATCH"); }
  for (const [target, original] of verified) {
    const current = await view.promises.lstat(target, { bigint: true });
    assertRegular(current);
    if (!sameMetadata(original, current)) throw new ArtifactError("FILE_CHANGED");
  }
  for (const snapshot of directories) {
    const stat = await view.promises.lstat(snapshot.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameMetadata(snapshot.stat, stat)) throw new ArtifactError("DIRECTORY_CHANGED");
    const names = (await view.promises.readdir(snapshot.directory)).sort();
    if (names.length !== snapshot.names.length || names.some((name, index) => name !== snapshot.names[index])) throw new ArtifactError("DIRECTORY_CHANGED");
    if (!sameMetadata(stat, await view.promises.lstat(snapshot.directory, { bigint: true }))) throw new ArtifactError("DIRECTORY_CHANGED");
  }
  return true;
}
