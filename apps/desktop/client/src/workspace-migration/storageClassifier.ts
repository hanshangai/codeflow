import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceDirectoryMigrationErrorCode } from "@codeflowai/shared";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_ALLOWED_BUS_TYPES = new Set([8, 10, 11, 16, 17]);
const LINUX_ALLOWED_FILESYSTEMS = new Set([
  "exfat", "ext2", "ext3", "ext4", "f2fs", "jfs", "nilfs2", "ntfs3", "reiserfs", "udf", "vfat", "xfs",
]);
const LINUX_ALLOWED_SAS_RAID_DRIVERS = new Set([
  "3w-9xxx", "3w-sas", "aacraid", "arcmsr", "hpsa", "megaraid_sas", "mpt2sas", "mpt3sas", "smartpqi",
]);

export type StorageClassification = {
  platform: NodeJS.Platform;
  realPath: string;
  mountPoint: string;
  fileSystemType: string;
  deviceIds: string[];
  busTypes: string[];
};

type CommandResult = { stdout: string; stderr: string };
type DirectoryStat = { isDirectory: () => boolean };

export type StorageClassifierDependencies = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  realpath: (targetPath: string) => Promise<string>;
  stat: (targetPath: string) => Promise<DirectoryStat>;
  readFile: (targetPath: string) => Promise<string>;
  readDir: (targetPath: string) => Promise<string[]>;
  runCommand: (command: string, args: string[], input?: string) => Promise<CommandResult>;
};

export type StorageClassifierOptions = {
  registeredSyncRoots?: string[];
  dependencies?: Partial<StorageClassifierDependencies>;
};

/** 固定磁盘判定失败；调用边界必须记录 requestId/workspaceId 后显式返回该业务错误。 */
export class StorageClassifierError extends Error {
  constructor(
    public readonly code: Extract<
      WorkspaceDirectoryMigrationErrorCode,
      "WORKSPACE_MIGRATION_TARGET_INVALID" | "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED"
    >,
    message: string,
    public readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageClassifierError";
  }
}

/** 单一平台存储分类入口；无法证明为支持的本机固定磁盘时拒绝。 */
export class StorageClassifier {
  private readonly deps: StorageClassifierDependencies;
  private readonly registeredSyncRoots: string[];

  constructor(options?: StorageClassifierOptions) {
    this.deps = createDependencies(options?.dependencies);
    this.registeredSyncRoots = [...(options?.registeredSyncRoots ?? [])];
  }

  /** 校验目标父目录并返回已证明的挂载点、设备和总线信息。 */
  async assertSupportedTarget(targetParentPath: string): Promise<StorageClassification> {
    const pathApi = this.deps.platform === "win32" ? path.win32 : path.posix;
    const requestedPath = normalizeRequestedPath(targetParentPath, this.deps.platform);
    if (!requestedPath || !pathApi.isAbsolute(requestedPath)) {
      throw classifierError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标父目录必须是绝对路径", "path_not_absolute");
    }
    if (this.deps.platform === "win32" && requestedPath.startsWith("\\\\")) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标父目录不能位于 UNC 网络路径",
        "windows_unc_path",
      );
    }

    let realPath: string;
    try {
      realPath = await this.deps.realpath(requestedPath);
      const stat = await this.deps.stat(realPath);
      if (!stat.isDirectory()) {
        throw classifierError("WORKSPACE_MIGRATION_TARGET_INVALID", "目标父目录不是目录", "path_not_directory");
      }
    } catch (error) {
      if (error instanceof StorageClassifierError) throw error;
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_INVALID",
        "无法读取目标父目录",
        "path_unavailable",
        error,
      );
    }

    const configuredSyncRoots = collectConfiguredSyncRoots(this.deps, this.registeredSyncRoots);
    assertOutsideSyncRoots(realPath, configuredSyncRoots, this.deps.platform);

    switch (this.deps.platform) {
      case "win32":
        return this.classifyWindows(realPath);
      case "darwin":
        return this.classifyDarwin(realPath);
      case "linux":
        return this.classifyLinux(realPath);
      default:
        throw classifierError(
          "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
          `当前平台不支持目录迁移存储判定：${this.deps.platform}`,
          "platform_unsupported",
        );
    }
  }

  /** Windows 同时校验 LogicalDisk DriveType、MSFT_Disk BusType 和 OneDrive 注册根。 */
  private async classifyWindows(realPath: string): Promise<StorageClassification> {
    const executable = resolveWindowsPowerShell(this.deps.env);
    const result = await this.runProbe(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_STORAGE_PROBE_SCRIPT,
    ], "windows_storage_probe_failed", realPath);
    const probe = parseJsonObject(result.stdout, "windows_storage_probe_invalid");
    const driveType = toInteger(probe.driveType);
    const providerName = nullableString(probe.providerName);
    const deviceId = requiredString(probe.deviceId, "windows_device_id_missing");
    const fileSystemType = requiredString(probe.fileSystem, "windows_filesystem_missing").toLowerCase();
    const busTypes = toIntegerArray(probe.busTypes);
    const diskNumbers = toIntegerArray(probe.diskNumbers);
    const mappedDiskNumbers = toIntegerArray(probe.mappedDiskNumbers);
    const syncRoots = toStringArray(probe.syncRoots);
    assertOutsideSyncRoots(realPath, syncRoots, "win32");

    if (driveType !== 3 || providerName) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标不是本机固定磁盘",
        "windows_drive_not_fixed",
        undefined,
        { driveType, providerMapped: Boolean(providerName) },
      );
    }
    const mountPoint = path.win32.parse(realPath).root;
    if (deviceId.toLowerCase() !== mountPoint.replace(/[\\/]+$/, "").toLowerCase()) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "Windows 逻辑磁盘与目标路径不匹配",
        "windows_device_mismatch",
      );
    }
    if (
      diskNumbers === null
      || mappedDiskNumbers === null
      || busTypes === null
      || diskNumbers.length === 0
      || !sameIntegerSet(diskNumbers, mappedDiskNumbers)
      || busTypes.length !== mappedDiskNumbers.length
      || busTypes.some((busType) => !WINDOWS_ALLOWED_BUS_TYPES.has(busType))
    ) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标物理磁盘总线不受支持或无法证明",
        "windows_bus_unsupported",
        undefined,
        { diskNumbers, mappedDiskNumbers, busTypes },
      );
    }
    return {
      platform: "win32",
      realPath,
      mountPoint,
      fileSystemType,
      deviceIds: diskNumbers.map(String),
      busTypes: busTypes.map(String),
    };
  }

  /** macOS 解析 diskutil plist；APFS 合成卷必须继续证明全部 physical stores。 */
  private async classifyDarwin(realPath: string): Promise<StorageClassification> {
    const volumeInfo = await this.readDarwinDiskInfo(realPath);
    const storeIds = extractDarwinPhysicalStoreIds(volumeInfo);
    if (hasDarwinPhysicalStoreField(volumeInfo) && storeIds.length === 0) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "macOS APFS 物理存储映射无法解析",
        "darwin_physical_store_invalid",
      );
    }
    const physicalInfos = storeIds.length > 0
      ? await Promise.all(storeIds.map((storeId) => this.readDarwinDiskInfo(storeId)))
      : [volumeInfo];
    for (const info of physicalInfos) assertDarwinPhysicalDisk(info);
    return {
      platform: "darwin",
      realPath,
      mountPoint: requiredString(volumeInfo.MountPoint, "darwin_mount_point_missing"),
      fileSystemType: requiredString(
        volumeInfo.FilesystemType ?? volumeInfo.FileSystemPersonality,
        "darwin_filesystem_missing",
      ).toLowerCase(),
      deviceIds: physicalInfos.map((info) => requiredString(info.DeviceIdentifier, "darwin_device_id_missing")),
      busTypes: physicalInfos.map((info) => requiredString(info.BusProtocol ?? info.Protocol, "darwin_protocol_missing")),
    };
  }

  /** 读取并通过系统 plutil 结构化转换单个 diskutil plist。 */
  private async readDarwinDiskInfo(subject: string): Promise<Record<string, unknown>> {
    const plist = await this.runProbe("/usr/sbin/diskutil", ["info", "-plist", subject], "darwin_diskutil_failed");
    const json = await this.runProbe(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "-"],
      "darwin_plist_parse_failed",
      plist.stdout,
    );
    return parseJsonObject(json.stdout, "darwin_disk_info_invalid");
  }

  /** Linux 以最长挂载点匹配 mountinfo，并递归证明 dm/md 的全部 sysfs 后端。 */
  private async classifyLinux(realPath: string): Promise<StorageClassification> {
    let mountInfoText: string;
    try {
      mountInfoText = await this.deps.readFile("/proc/self/mountinfo");
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "无法读取 Linux 挂载信息",
        "linux_mountinfo_unavailable",
        error,
      );
    }
    const mount = findLinuxMount(realPath, mountInfoText);
    if (!mount || !isSupportedLinuxFilesystem(mount.fsType, mount.source)) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标不是受支持的本地块设备文件系统",
        "linux_filesystem_unsupported",
        undefined,
        { fsType: mount?.fsType ?? null },
      );
    }
    const leaves = await this.resolveLinuxBlockLeaves(`/sys/dev/block/${mount.majorMinor}`, new Set());
    if (leaves.length === 0) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "无法解析 Linux 目标块设备",
        "linux_device_unresolved",
      );
    }
    return {
      platform: "linux",
      realPath,
      mountPoint: mount.mountPoint,
      fileSystemType: mount.fsType.toLowerCase(),
      deviceIds: leaves.map((leaf) => leaf.deviceId),
      busTypes: leaves.map((leaf) => leaf.busType),
    };
  }

  /** 递归解析 dm/md slaves；叶设备必须为不可移除且可证明的本地总线。 */
  private async resolveLinuxBlockLeaves(
    sysDevicePath: string,
    visited: Set<string>,
  ): Promise<Array<{ deviceId: string; busType: string }>> {
    let realDevicePath: string;
    try {
      realDevicePath = await this.deps.realpath(sysDevicePath);
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "Linux 块设备映射不存在",
        "linux_sysfs_device_missing",
        error,
      );
    }
    if (visited.has(realDevicePath)) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "Linux 块设备 slave 关系存在循环",
        "linux_sysfs_cycle",
      );
    }
    visited.add(realDevicePath);
    let slaves: string[];
    try {
      slaves = await this.deps.readDir(path.posix.join(realDevicePath, "slaves"));
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "无法读取 Linux 块设备关系",
        "linux_sysfs_slaves_unavailable",
        error,
      );
    }
    if (slaves.length > 0) {
      const nested = await Promise.all(slaves.map((name) => this.resolveLinuxBlockLeaves(
        `/sys/class/block/${name}`,
        new Set(visited),
      )));
      return nested.flat();
    }

    let removable: number | null;
    try {
      removable = await readLinuxRemovableFlag(this.deps, realDevicePath);
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "无法读取 Linux 块设备可移除属性",
        "linux_removable_flag_unavailable",
        error,
      );
    }
    let classification: string | null;
    try {
      classification = classifyLinuxLeafPath(realDevicePath)
        ?? await classifyLinuxLeafDriver(this.deps, realDevicePath);
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "无法读取 Linux 块设备驱动信息",
        "linux_device_driver_unavailable",
        error,
      );
    }
    if (removable !== 0 || !classification) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "Linux 目标块设备可移除、虚拟或总线不受支持",
        "linux_device_unsupported",
        undefined,
        { deviceId: path.posix.basename(realDevicePath), removable },
      );
    }
    return [{ deviceId: path.posix.basename(realDevicePath), busType: classification }];
  }

  /** 统一包装系统探针错误；超时、退出码和解析失败均不降级。 */
  private async runProbe(command: string, args: string[], reason: string, input?: string): Promise<CommandResult> {
    try {
      return await this.deps.runCommand(command, args, input);
    } catch (error) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标存储系统探针执行失败",
        reason,
        error,
      );
    }
  }
}

/** 规范 Windows 本地扩展路径；扩展 UNC 保持网络路径语义并由统一检查拒绝。 */
function normalizeRequestedPath(value: unknown, platform: NodeJS.Platform): string {
  const requestedPath = String(value ?? "").trim();
  if (platform !== "win32") return requestedPath;
  if (/^\\\\\?\\UNC\\/i.test(requestedPath)) return `\\\\${requestedPath.slice(8)}`;
  if (/^\\\\\?\\[a-z]:\\/i.test(requestedPath)) return requestedPath.slice(4);
  return requestedPath;
}

/** 构造真实平台依赖；测试可逐项替换而不执行宿主命令。 */
function createDependencies(overrides?: Partial<StorageClassifierDependencies>): StorageClassifierDependencies {
  return {
    platform: overrides?.platform ?? process.platform,
    env: overrides?.env ?? process.env,
    homeDir: overrides?.homeDir ?? os.homedir(),
    realpath: overrides?.realpath ?? ((targetPath) => fs.promises.realpath(targetPath)),
    stat: overrides?.stat ?? ((targetPath) => fs.promises.stat(targetPath)),
    readFile: overrides?.readFile ?? ((targetPath) => fs.promises.readFile(targetPath, "utf8")),
    readDir: overrides?.readDir ?? ((targetPath) => fs.promises.readdir(targetPath)),
    runCommand: overrides?.runCommand ?? runStorageProbeCommand,
  };
}

/** 无 shell 执行固定系统命令，并在进程关闭后返回超时或输出上限错误。 */
export async function runStorageProbeCommand(
  command: string,
  args: string[],
  input?: string,
  limits?: { timeoutMs?: number; maxOutputBytes?: number },
): Promise<CommandResult> {
  const timeoutMs = normalizePositiveInteger(limits?.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const maxOutputBytes = normalizePositiveInteger(limits?.maxOutputBytes, MAX_PROBE_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (settled || terminationError) return;
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        terminationError = new Error(`storage probe output exceeds ${maxOutputBytes} bytes`);
        if (!child.kill()) finish(terminationError);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => {
      if (!terminationError) finish(error);
    });
    child.once("close", (code, signal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        finish(new Error(`storage probe exited code=${code ?? "null"}, signal=${signal ?? "none"}, stderr=${stderrText.slice(0, 500)}`));
        return;
      }
      finish(undefined, { stdout: stdoutText, stderr: stderrText });
    });
    timer = setTimeout(() => {
      terminationError = new Error(`storage probe timed out after ${timeoutMs}ms`);
      if (!child.kill()) finish(terminationError);
    }, timeoutMs);
    if (input !== undefined) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}

/** 收集显式配置与系统登记的同步根，不按目标路径名称猜测。 */
function collectConfiguredSyncRoots(deps: StorageClassifierDependencies, configured: string[]): string[] {
  const roots = [...configured];
  for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] as const) {
    const value = String(deps.env[key] ?? "").trim();
    if (value) roots.push(value);
  }
  const customRoots = String(deps.env.CODEFLOWAI_SYNC_ROOTS ?? "").trim();
  const delimiter = deps.platform === "win32" ? ";" : ":";
  if (customRoots) roots.push(...customRoots.split(delimiter).map((item) => item.trim()).filter(Boolean));
  if (deps.platform === "darwin") {
    roots.push(
      path.posix.join(deps.homeDir, "Library", "CloudStorage"),
      path.posix.join(deps.homeDir, "Library", "Mobile Documents", "com~apple~CloudDocs"),
    );
  }
  return [...new Set(roots.map((root) => String(root).trim()).filter(Boolean))];
}

/** 目标落在任何已登记同步根内时直接拒绝，用户确认不能覆盖。 */
function assertOutsideSyncRoots(targetPath: string, roots: string[], platform: NodeJS.Platform): void {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = pathApi.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const target = normalize(targetPath);
  for (const rootValue of roots) {
    const root = normalize(rootValue);
    if (isPathWithin(target, root, pathApi)) {
      throw classifierError(
        "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
        "目标位于已登记的同步目录",
        "sync_root_detected",
        undefined,
        { syncProviderDetected: true },
      );
    }
  }
}

/** 查找 realPath 所属的最长 Linux 挂载点。 */
function findLinuxMount(realPath: string, mountInfoText: string): LinuxMount | null {
  const candidates = String(mountInfoText ?? "")
    .split(/\r?\n/)
    .map(parseLinuxMountLine)
    .filter((item): item is LinuxMount => Boolean(item))
    .filter((item) => isPathWithin(realPath, item.mountPoint, path.posix));
  const sorted = candidates.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  const longest = sorted[0];
  if (!longest) return null;
  if (sorted.filter((item) => item.mountPoint === longest.mountPoint).length !== 1) {
    throw classifierError(
      "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
      "Linux 目标挂载点无法唯一匹配",
      "linux_mount_ambiguous",
    );
  }
  return longest;
}

type LinuxMount = { majorMinor: string; mountPoint: string; fsType: string; source: string };

/** 解析内核 mountinfo 单行，格式不完整时返回 null 供上层最终拒绝。 */
function parseLinuxMountLine(line: string): LinuxMount | null {
  const separator = line.indexOf(" - ");
  if (separator < 0) return null;
  const left = line.slice(0, separator).split(" ");
  const right = line.slice(separator + 3).split(" ");
  if (left.length < 5 || right.length < 2 || !/^\d+:\d+$/.test(left[2] ?? "")) return null;
  return {
    majorMinor: left[2]!,
    mountPoint: decodeMountInfoPath(left[4]!),
    fsType: right[0]!,
    source: decodeMountInfoPath(right[1]!),
  };
}

/** 解码 mountinfo 的八进制路径转义。 */
function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** 仅接受一期明确支持的本地文件系统，未知和多设备文件系统均拒绝。 */
function isSupportedLinuxFilesystem(fsType: string, source: string): boolean {
  const normalized = String(fsType ?? "").toLowerCase();
  return LINUX_ALLOWED_FILESYSTEMS.has(normalized)
    && !source.startsWith("//")
    && !source.includes(":/");
}

/** 从分区向父级查找 removable；无法找到时返回 null 并由调用方拒绝。 */
async function readLinuxRemovableFlag(
  deps: StorageClassifierDependencies,
  realDevicePath: string,
): Promise<number | null> {
  let current = realDevicePath;
  while (current.startsWith("/sys/") && current !== "/sys") {
    try {
      const value = (await deps.readFile(path.posix.join(current, "removable"))).trim();
      if (value === "0" || value === "1") return Number(value);
      throw new Error(`invalid removable flag: ${value}`);
    } catch (error) {
      if (!hasFsCode(error, "ENOENT") && !hasFsCode(error, "ENOTDIR")) throw error;
    }
    current = path.posix.dirname(current);
  }
  return null;
}

/** 依据 sysfs 实路径识别允许的本地叶总线。 */
function classifyLinuxLeafPath(realDevicePath: string): string | null {
  const normalized = realDevicePath.toLowerCase();
  if (
    normalized.includes("/virtual/")
    || /\/(loop|ram|zram)\d/.test(normalized)
    || /(\/usb|\/mmc|firewire|thunderbolt|iscsi|\/session\d|\/rport-|fc_host|nvme-fabrics|\/nbd\d|\/xen|\/vmbus|hyperv|virtio|aoe|rbd|drbd)/.test(normalized)
  ) return null;
  if (normalized.includes("/nvme")) return "nvme";
  if (normalized.includes("/ata")) return "sata";
  if (normalized.includes("/sas") || normalized.includes("/end_device-")) return "sas";
  return null;
}

/** 沿分区父级读取块设备驱动，仅认可明确的 SAS/硬件 RAID 驱动。 */
async function classifyLinuxLeafDriver(
  deps: StorageClassifierDependencies,
  realDevicePath: string,
): Promise<string | null> {
  let current = realDevicePath;
  while (current.startsWith("/sys/") && current !== "/sys") {
    try {
      const driverPath = await deps.realpath(path.posix.join(current, "device", "driver"));
      const driverName = path.posix.basename(driverPath).toLowerCase();
      return LINUX_ALLOWED_SAS_RAID_DRIVERS.has(driverName) ? "sas_or_hardware_raid" : null;
    } catch (error) {
      if (!hasFsCode(error, "ENOENT") && !hasFsCode(error, "ENOTDIR")) throw error;
    }
    current = path.posix.dirname(current);
  }
  return null;
}

/** diskutil APFSPhysicalStores 支持字符串或对象数组两种 plist 形状。 */
function extractDarwinPhysicalStoreIds(info: Record<string, unknown>): string[] {
  const raw = info.APFSPhysicalStores ?? info.APFSPhysicalStore;
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(values.map((value) => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return String(record.APFSPhysicalStore ?? record.DeviceIdentifier ?? "").trim();
    }
    return "";
  }).filter(Boolean))];
}

/** 判断 diskutil 是否声明了 APFS 物理存储映射，避免把畸形字段误当普通物理卷。 */
function hasDarwinPhysicalStoreField(info: Record<string, unknown>): boolean {
  return Object.hasOwn(info, "APFSPhysicalStores") || Object.hasOwn(info, "APFSPhysicalStore");
}

/** macOS 叶设备必须明确为内置、不可移除、不可弹出和物理设备。 */
function assertDarwinPhysicalDisk(info: Record<string, unknown>): void {
  const protocol = nullableString(info.BusProtocol ?? info.Protocol)?.toLowerCase() ?? "";
  if (
    info.Internal !== true
    || info.Removable !== false
    || info.Ejectable !== false
    || String(info.VirtualOrPhysical ?? "").toLowerCase() !== "physical"
    || !protocol
    || /(usb|firewire|iscsi|disk image|virtual|network)/.test(protocol)
  ) {
    throw classifierError(
      "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
      "macOS 目标不是受支持的内置物理磁盘",
      "darwin_device_unsupported",
      undefined,
      { internal: info.Internal, removable: info.Removable, ejectable: info.Ejectable, protocol },
    );
  }
}

/** PowerShell JSON 必须为对象，解析失败显式拒绝。 */
function parseJsonObject(value: string, reason: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw classifierError(
      "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
      "目标存储探针输出无法解析",
      reason,
      error,
    );
  }
}

/** 构造稳定分类错误并保留内部 cause，外层日志负责补充业务主键。 */
function classifierError(
  code: StorageClassifierError["code"],
  message: string,
  reason: string,
  cause?: unknown,
  details?: Record<string, unknown>,
): StorageClassifierError {
  return new StorageClassifierError(
    code,
    message,
    {
      reason,
      ...details,
    },
    cause === undefined ? undefined : { cause },
  );
}

/** 解析系统自带 Windows PowerShell 路径，未提供系统根时交给系统 PATH 查找。 */
function resolveWindowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = String(env.SystemRoot ?? env.WINDIR ?? "").trim();
  return systemRoot
    ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** 按目标平台语义判断目标是否等于或位于给定根路径下。 */
function isPathWithin(targetPath: string, rootPath: string, pathApi: typeof path.posix | typeof path.win32): boolean {
  const relative = pathApi.relative(rootPath, targetPath);
  return !relative
    || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

/** 判断未知异常是否为指定 Node 文件系统错误码。 */
function hasFsCode(error: unknown, expected: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === expected;
}

/** 把可空探针字段规范为非空字符串或 null。 */
function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 读取必填字符串字段，缺失时以指定原因显式失败。 */
function requiredString(value: unknown, reason: string): string {
  const text = nullableString(value);
  if (text) return text;
  throw classifierError(
    "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
    "目标存储探针缺少必要字段",
    reason,
  );
}

/** 把单个探针字段解析为安全整数，非法值返回 null 供上层拒绝。 */
function toInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** 把探针数组解析为安全整数列表；任一非法项都使整个字段无效。 */
function toIntegerArray(value: unknown): number[] | null {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const parsed = values.map(toInteger);
  return parsed.some((item) => item === null) ? null : parsed as number[];
}

/** 把可单值或数组的探针字段规范为非空字符串列表。 */
function toStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/** 读取正整数限制，非法配置回退到内置安全值。 */
function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 比较整数集合，确保每个 Windows 物理磁盘都映射到 MSFT_Disk。 */
function sameIntegerSet(left: number[], right: number[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

const WINDOWS_STORAGE_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$TargetPath = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw 'Target path is required' }
$root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($TargetPath)).TrimEnd('\')
$escapedRoot = $root.Replace("'", "''")
$logical = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$escapedRoot'"
if ($null -eq $logical) { throw "Logical disk not found: $root" }
$partitions = @(Get-CimAssociatedInstance -InputObject $logical -Association Win32_LogicalDiskToPartition)
$diskNumbers = @($partitions | ForEach-Object { [int]$_.DiskIndex } | Sort-Object -Unique)
$storageDisks = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_Disk)
$mappedDisks = @($storageDisks | Where-Object { $diskNumbers -contains [int]$_.Number } | Sort-Object Number)
$mappedDiskNumbers = @($mappedDisks | ForEach-Object { [int]$_.Number })
$busTypes = @($mappedDisks | ForEach-Object { [int]$_.BusType })
$syncRoots = @(
  $env:OneDrive,
  $env:OneDriveConsumer,
  $env:OneDriveCommercial
)
$accountsPath = 'HKCU:\Software\Microsoft\OneDrive\Accounts'
if (Test-Path -LiteralPath $accountsPath) {
  $syncRoots += @(Get-ChildItem -LiteralPath $accountsPath -ErrorAction Stop | ForEach-Object {
    (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop).UserFolder
  })
}
$syncRoots = @($syncRoots | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
[pscustomobject]@{
  deviceId = [string]$logical.DeviceID
  driveType = [int]$logical.DriveType
  providerName = [string]$logical.ProviderName
  fileSystem = [string]$logical.FileSystem
  diskNumbers = $diskNumbers
  mappedDiskNumbers = $mappedDiskNumbers
  busTypes = $busTypes
  syncRoots = $syncRoots
} | ConvertTo-Json -Compress -Depth 5
`;
