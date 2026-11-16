import fs from "node:fs";
import path from "node:path";

/** 工作区级配置目录统一使用隐藏目录，不再在工作区根创建 `codeflowai/`。 */
export const WORKSPACE_CODEFLOWAI_DIRECTORY = ".codeflowai";
/** 历史配置目录只用于兼容读取和迁移，不再用于新建。 */
export const LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY = "codeflowai";
export const WORKSPACE_RUNTIME_DIRECTORY = ".codeflow";
export type WorkspaceCodeflowaiDirectoryName =
  | typeof WORKSPACE_CODEFLOWAI_DIRECTORY
  | typeof LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY
  | typeof WORKSPACE_RUNTIME_DIRECTORY;

export type WorkspaceCodeflowaiDirectoryIdentity = {
  workspaceRoot: string;
  directoryPath: string;
  directoryName: WorkspaceCodeflowaiDirectoryName;
  workspaceDev: number;
  workspaceIno: number;
  directoryDev: number;
  directoryIno: number;
};

type WorkspaceCodeflowaiFileIdentity = {
  path: string;
  dev: number;
  ino: number;
};

export class WorkspaceCodeflowaiDirectoryError extends Error {
  readonly code = "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCodeflowaiDirectoryError";
  }
}

/** 只在工作区真实根下创建直接子目录，并返回可用于 TOCTOU 复核的物理身份。 */
export function ensureWorkspaceCodeflowaiDirectory(
  workspacePath: string,
  directoryName: WorkspaceCodeflowaiDirectoryName = WORKSPACE_CODEFLOWAI_DIRECTORY,
): WorkspaceCodeflowaiDirectoryIdentity {
  assertControlledDirectoryName(directoryName);
  const workspaceRoot = resolveCanonicalWorkspaceRoot(workspacePath);
  const directoryPath = path.join(workspaceRoot, directoryName);
  try {
    fs.mkdirSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
      throw unsafeDirectoryError("无法创建工作区 codeflowai 直接子目录", error);
    }
  }
  return inspectWorkspaceCodeflowaiDirectory(workspaceRoot, directoryPath, directoryName);
}

/** 只读检查现有 codeflowai 直接子目录；目录缺失时不产生任何文件系统写入。 */
export function inspectExistingWorkspaceCodeflowaiDirectory(
  workspacePath: string,
  directoryName: WorkspaceCodeflowaiDirectoryName = WORKSPACE_CODEFLOWAI_DIRECTORY,
): WorkspaceCodeflowaiDirectoryIdentity | null {
  assertControlledDirectoryName(directoryName);
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveCanonicalWorkspaceRoot(workspacePath);
  } catch (error) {
    // 工作区根已不存在时没有可检查的控制目录；调用方按缺失处理，不创建任何文件。
    if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT") return null;
    throw error;
  }
  const directoryPath = path.join(workspaceRoot, directoryName);
  try {
    fs.lstatSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      if (fsPathKey(resolveCanonicalWorkspaceRoot(workspacePath)) !== fsPathKey(workspaceRoot)) {
        throw unsafeDirectoryError("工作区物理根在访问期间已变化");
      }
      return null;
    }
    throw unsafeDirectoryError("无法确认工作区 codeflowai 目录是否存在", error);
  }
  return inspectWorkspaceCodeflowaiDirectory(workspaceRoot, directoryPath, directoryName);
}

/** 复核 workspace 根和 codeflowai 直接子目录仍是最初验证的同一物理目录。 */
export function assertWorkspaceCodeflowaiDirectory(
  expected: WorkspaceCodeflowaiDirectoryIdentity,
): WorkspaceCodeflowaiDirectoryIdentity {
  const current = inspectWorkspaceCodeflowaiDirectory(expected.workspaceRoot, expected.directoryPath, expected.directoryName);
  if (
    current.workspaceDev !== expected.workspaceDev
    || current.workspaceIno !== expected.workspaceIno
    || current.directoryDev !== expected.directoryDev
    || current.directoryIno !== expected.directoryIno
  ) {
    throw unsafeDirectoryError("工作区或 codeflowai 目录在访问期间已被替换");
  }
  return current;
}

/** 判断控制文件是否存在；存在时必须是当前 codeflowai 目录内的普通文件。 */
export function inspectWorkspaceCodeflowaiFile(
  directory: WorkspaceCodeflowaiDirectoryIdentity,
  fileName: string,
): WorkspaceCodeflowaiFileIdentity | null {
  return inspectWorkspaceCodeflowaiFiles(directory, [fileName])[0]!;
}

/** 同步批量检查控制文件；批次前后核对目录，各文件仍验证普通独占类型和真实路径。 */
export function inspectWorkspaceCodeflowaiFiles(
  directory: WorkspaceCodeflowaiDirectoryIdentity,
  fileNames: readonly string[],
): Array<WorkspaceCodeflowaiFileIdentity | null> {
  assertWorkspaceCodeflowaiDirectory(directory);
  const files = fileNames.map(fileName => inspectControlledFile(directory, fileName));
  assertWorkspaceCodeflowaiDirectory(directory);
  return files;
}

/** 仅供已包围目录身份检查的同步批次使用，不承担跨调用缓存。 */
function inspectControlledFile(directory: WorkspaceCodeflowaiDirectoryIdentity, fileName: string): WorkspaceCodeflowaiFileIdentity | null {
  const filePath = resolveControlledFilePath(directory, fileName);
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return null;
    }
    throw unsafeDirectoryError(`无法确认 codeflowai 控制文件类型：${fileName}`, error);
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
    throw unsafeDirectoryError(`codeflowai 控制文件不是普通文件：${fileName}`);
  }
  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync.native(filePath);
  } catch (error) {
    throw unsafeDirectoryError(`无法确认 codeflowai 控制文件物理位置：${fileName}`, error);
  }
  if (fsPathKey(realFilePath) !== fsPathKey(filePath)) {
    throw unsafeDirectoryError(`codeflowai 控制文件位于工作区之外：${fileName}`);
  }
  return { path: filePath, dev: fileStat.dev, ino: fileStat.ino };
}

/** 从已验证普通文件读取内容；打开后的 fd 身份必须与 lstat 结果一致。 */
export function readWorkspaceCodeflowaiFile(
  directory: WorkspaceCodeflowaiDirectoryIdentity,
  fileName: string,
): Buffer {
  const expected = inspectWorkspaceCodeflowaiFile(directory, fileName);
  if (!expected) throw new Error(`codeflowai 控制文件不存在：${fileName}`);
  const fd = fs.openSync(expected.path, "r");
  try {
    assertOpenedFileIdentity(fd, expected, fileName);
    assertWorkspaceCodeflowaiDirectory(directory);
    const content = fs.readFileSync(fd);
    assertOpenedFileIdentity(fd, expected, fileName);
    assertWorkspaceCodeflowaiDirectory(directory);
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/** 写入已验证普通文件；缺失文件使用 wx 创建，避免跟随竞态插入的链接。 */
export function writeWorkspaceCodeflowaiFile(
  directory: WorkspaceCodeflowaiDirectoryIdentity,
  fileName: string,
  content: string | Buffer,
  options?: { onlyIfMissing?: boolean },
): { path: string; created: boolean } {
  const expected = inspectWorkspaceCodeflowaiFile(directory, fileName);
  const filePath = resolveControlledFilePath(directory, fileName);
  if (expected && options?.onlyIfMissing) return { path: filePath, created: false };

  if (!expected) {
    let fd: number;
    try {
      fd = fs.openSync(filePath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST" && options?.onlyIfMissing) {
        if (!inspectWorkspaceCodeflowaiFile(directory, fileName)) {
          throw unsafeDirectoryError(`codeflowai 控制文件创建竞态未收敛：${fileName}`, error);
        }
        return { path: filePath, created: false };
      }
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) {
        throw unsafeDirectoryError(`新建的 codeflowai 控制文件不是普通文件：${fileName}`);
      }
      assertWorkspaceCodeflowaiDirectory(directory);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    if (!inspectWorkspaceCodeflowaiFile(directory, fileName)) {
      throw unsafeDirectoryError(`新建的 codeflowai 控制文件不可复核：${fileName}`);
    }
    return { path: filePath, created: true };
  }

  const fd = fs.openSync(filePath, "r+");
  try {
    assertOpenedFileIdentity(fd, expected, fileName);
    assertWorkspaceCodeflowaiDirectory(directory);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
    assertOpenedFileIdentity(fd, expected, fileName);
    assertWorkspaceCodeflowaiDirectory(directory);
  } finally {
    fs.closeSync(fd);
  }
  inspectWorkspaceCodeflowaiFile(directory, fileName);
  return { path: filePath, created: false };
}

/** 迁移完成后合并只含控制文件和旧索引缓存的历史目录；未知文件保留整个目录。 */
export function cleanupLegacyWorkspaceCodeflowaiDirectory(workspacePath: string, onDeferred?: (error: unknown) => void): void {
  const legacy = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath, LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY);
  if (!legacy) return;
  const nameSet = new Set(fs.readdirSync(legacy.directoryPath));
  const copied = new Set(["codeflowai.json", "terminal-actions.json", "file-index-ignore.txt"]);
  // 旧目录索引库只是可重建缓存；仅在新主库已存在时随目录一起清理。
  const indexArtifacts = new Set(["file-index.db", "file-index.db-wal", "file-index.db-shm", "file-index.db-journal"]);
  if (nameSet.size === 0) {
    fs.rmdirSync(legacy.directoryPath);
    return;
  }
  if ([...nameSet].some(name => !copied.has(name) && !indexArtifacts.has(name))) return;
  const current = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath);
  if (!current) return;
  if ([...nameSet].some(name => copied.has(name) && !inspectWorkspaceCodeflowaiFile(current, name))) return;
  if ([...nameSet].some(name => indexArtifacts.has(name)) && !inspectWorkspaceCodeflowaiFile(current, "file-index.db")) return;
  // 内容不同的旧控制文件改名保留在新目录内，绝不覆盖当前生效配置。
  const stamp = `${Date.now()}-${process.pid}`;
  try {
    for (const name of nameSet) {
      const from = path.join(legacy.directoryPath, name);
      if (copied.has(name) && !readWorkspaceCodeflowaiFile(current, name).equals(readWorkspaceCodeflowaiFile(legacy, name))) {
        fs.renameSync(from, path.join(current.directoryPath, `${name}.legacy-${stamp}`));
      } else {
        fs.unlinkSync(from);
      }
    }
    fs.rmdirSync(legacy.directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // 旧缓存被其他实例占用时保留旧目录，交由调用边界记录后继续使用新目录。
    if (onDeferred && (code === "EBUSY" || code === "EPERM" || code === "EACCES")) { onDeferred(error); return; }
    throw error;
  }
}

/** 公共配置和私有运行目录共用同一物理身份检查，不接受任意目录名。 */
function inspectWorkspaceCodeflowaiDirectory(workspaceRoot: string, directoryPath: string, directoryName: WorkspaceCodeflowaiDirectoryName): WorkspaceCodeflowaiDirectoryIdentity {
  assertControlledDirectoryName(directoryName);
  let workspaceStat: fs.Stats;
  let directoryStat: fs.Stats;
  let realWorkspaceRoot: string;
  let realDirectory: string;
  try {
    workspaceStat = fs.lstatSync(workspaceRoot);
    directoryStat = fs.lstatSync(directoryPath);
    if (!workspaceStat.isDirectory()) throw new Error("工作区物理根不是目录");
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("codeflowai 不是工作区内的普通目录");
    }
    realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    realDirectory = fs.realpathSync.native(directoryPath);
  } catch (error) {
    throw unsafeDirectoryError("无法确认工作区 codeflowai 目录的物理身份", error);
  }
  const expectedDirectory = path.join(realWorkspaceRoot, directoryName);
  if (fsPathKey(realWorkspaceRoot) !== fsPathKey(workspaceRoot)) {
    throw unsafeDirectoryError("工作区物理根在访问期间已变化");
  }
  if (fsPathKey(directoryPath) !== fsPathKey(expectedDirectory) || fsPathKey(realDirectory) !== fsPathKey(expectedDirectory)) {
    throw unsafeDirectoryError("codeflowai 目录不是工作区真实根下的直接子目录");
  }
  return {
    workspaceRoot: realWorkspaceRoot,
    directoryPath: expectedDirectory,
    directoryName,
    workspaceDev: workspaceStat.dev,
    workspaceIno: workspaceStat.ino,
    directoryDev: directoryStat.dev,
    directoryIno: directoryStat.ino,
  };
}

/** 限定两个已定义的直接子目录，运行时同样拒绝绕过类型的外部输入。 */
function assertControlledDirectoryName(value: WorkspaceCodeflowaiDirectoryName): void {
  if (value !== WORKSPACE_CODEFLOWAI_DIRECTORY && value !== LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY
    && value !== WORKSPACE_RUNTIME_DIRECTORY) {
    throw unsafeDirectoryError("工作区控制目录名非法");
  }
}

function resolveCanonicalWorkspaceRoot(workspacePath: string): string {
  const resolved = path.resolve(String(workspacePath ?? "").trim());
  try {
    const workspaceRoot = fs.realpathSync.native(resolved);
    if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error("工作区路径不是目录");
    return workspaceRoot;
  } catch (error) {
    throw unsafeDirectoryError("无法确认工作区物理根", error);
  }
}

function resolveControlledFilePath(directory: WorkspaceCodeflowaiDirectoryIdentity, fileName: string): string {
  const normalizedName = String(fileName ?? "").trim();
  if (!normalizedName || path.basename(normalizedName) !== normalizedName || normalizedName === "." || normalizedName === "..") {
    throw unsafeDirectoryError(`codeflowai 控制文件名非法：${fileName}`);
  }
  return path.join(directory.directoryPath, normalizedName);
}

function assertOpenedFileIdentity(fd: number, expected: WorkspaceCodeflowaiFileIdentity, fileName: string): void {
  const opened = fs.fstatSync(fd);
  if (
    !opened.isFile()
    || opened.nlink !== 1
    || !isWorkspaceCodeflowaiFileDeviceMatch(expected.dev, opened.dev)
    || opened.ino !== expected.ino
  ) {
    throw unsafeDirectoryError(`codeflowai 控制文件在打开期间已被替换：${fileName}`);
  }
}

/** Windows 单侧 dev=0 表示设备号不可用；其余场景仍要求 lstat/fstat 设备号一致。 */
export function isWorkspaceCodeflowaiFileDeviceMatch(
  expectedDev: number,
  openedDev: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return expectedDev === openedDev
    || (platform === "win32" && (expectedDev === 0 || openedDev === 0));
}

function fsPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function unsafeDirectoryError(message: string, cause?: unknown): WorkspaceCodeflowaiDirectoryError {
  const rootCause = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  return new WorkspaceCodeflowaiDirectoryError(
    rootCause ? `${message}：${rootCause}` : message,
    cause === undefined ? undefined : { cause },
  );
}
