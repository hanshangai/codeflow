import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageClassifier,
  StorageClassifierError,
  runStorageProbeCommand,
  type StorageClassifierDependencies,
} from "../src/workspace-migration/storageClassifier.ts";

type DependencyOverrides = Partial<StorageClassifierDependencies>;

const DIRECTORY_STAT = { isDirectory: () => true };

/** 构造指定目标平台的纯注入分类器，避免测试读取宿主存储信息。 */
function createClassifier(
  platform: NodeJS.Platform,
  overrides: DependencyOverrides,
  registeredSyncRoots: string[] = [],
): StorageClassifier {
  return new StorageClassifier({
    registeredSyncRoots,
    dependencies: {
      platform,
      env: {},
      homeDir: platform === "win32" ? "C:\\Users\\tester" : "/Users/tester",
      realpath: async (targetPath) => targetPath,
      stat: async () => DIRECTORY_STAT,
      readFile: async (targetPath) => { throw fsError("ENOENT", targetPath); },
      readDir: async (targetPath) => { throw fsError("ENOENT", targetPath); },
      runCommand: async () => { throw new Error("unexpected command"); },
      ...overrides,
    },
  });
}

/** 构造带 code 的文件系统错误，用于验证缺失与权限错误的不同语义。 */
function fsError(code: string, targetPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${targetPath}`), { code });
}

/** 断言分类显式失败为统一业务错误及指定内部原因。 */
async function expectStorageError(
  action: () => Promise<unknown>,
  reason: string,
  code: StorageClassifierError["code"] = "WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED",
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof StorageClassifierError);
    assert.equal(error.code, code);
    assert.equal(error.details.reason, reason);
    assert.equal(Object.hasOwn(error.details, "rootCause"), false);
    return true;
  });
}

/** 生成 Windows CIM 探针的默认固定磁盘响应。 */
function windowsProbe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: "C:",
    driveType: 3,
    providerName: "",
    fileSystem: "NTFS",
    diskNumbers: [0],
    mappedDiskNumbers: [0],
    busTypes: [11],
    syncRoots: [],
    ...overrides,
  };
}

/** 构造 Windows 分类器并记录 PowerShell 调用参数。 */
function createWindowsClassifier(
  probe: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; calls?: Array<{ args: string[]; input?: string }> } = {},
): StorageClassifier {
  return createClassifier("win32", {
    env: options.env ?? {},
    realpath: async (targetPath) => targetPath,
    runCommand: async (_command, args, input) => {
      options.calls?.push({ args, input });
      return { stdout: JSON.stringify(probe), stderr: "" };
    },
  });
}

test("Windows 接受 RAID、SAS、SATA、Storage Spaces 和 NVMe，并通过 stdin 传递路径", async () => {
  for (const busType of [8, 10, 11, 16, 17]) {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const classifier = createWindowsClassifier(windowsProbe({ busTypes: [busType] }), { calls });
    const result = await classifier.assertSupportedTarget("C:\\Target Parent");
    assert.equal(result.mountPoint, "C:\\");
    assert.equal(result.fileSystemType, "ntfs");
    assert.deepEqual(result.deviceIds, ["0"]);
    assert.deepEqual(result.busTypes, [String(busType)]);
    assert.equal(calls[0]?.input, "C:\\Target Parent");
    assert.equal(calls[0]?.args.at(-1)?.includes("[Console]::In.ReadToEnd()"), true);
  }
  const extended = await createWindowsClassifier(windowsProbe()).assertSupportedTarget("\\\\?\\C:\\target");
  assert.equal(extended.realPath, "C:\\target");
});

test("Windows 拒绝 USB、SD、iSCSI、虚拟盘和未知总线", async () => {
  for (const busType of [7, 12, 9, 15, 0]) {
    const classifier = createWindowsClassifier(windowsProbe({ busTypes: [busType] }));
    await expectStorageError(() => classifier.assertSupportedTarget("C:\\target"), "windows_bus_unsupported");
  }
});

test("Windows 拒绝未完整映射的多物理磁盘", async () => {
  const classifier = createWindowsClassifier(windowsProbe({
    diskNumbers: [0, 1],
    mappedDiskNumbers: [0],
    busTypes: [11],
  }));
  await expectStorageError(() => classifier.assertSupportedTarget("C:\\target"), "windows_bus_unsupported");

  const malformed = createWindowsClassifier(windowsProbe({ diskNumbers: [0, "invalid"] }));
  await expectStorageError(() => malformed.assertSupportedTarget("C:\\target"), "windows_bus_unsupported");
});

test("Windows 拒绝移动盘、映射盘和 UNC", async () => {
  await expectStorageError(
    () => createWindowsClassifier(windowsProbe({ driveType: 4 })).assertSupportedTarget("C:\\target"),
    "windows_drive_not_fixed",
  );
  await expectStorageError(
    () => createWindowsClassifier(windowsProbe({ providerName: "\\\\server\\share" })).assertSupportedTarget("C:\\target"),
    "windows_drive_not_fixed",
  );
  await expectStorageError(
    () => createWindowsClassifier(windowsProbe()).assertSupportedTarget("\\\\server\\share"),
    "windows_unc_path",
  );
  await expectStorageError(
    () => createWindowsClassifier(windowsProbe()).assertSupportedTarget("\\\\?\\UNC\\server\\share"),
    "windows_unc_path",
  );
});

test("Windows 缺少文件系统类型时拒绝生成不完整分类", async () => {
  await expectStorageError(
    () => createWindowsClassifier(windowsProbe({ fileSystem: "" })).assertSupportedTarget("C:\\target"),
    "windows_filesystem_missing",
  );
});

test("Windows 拒绝环境变量及注册表探针识别的 OneDrive 根", async () => {
  const envClassifier = createWindowsClassifier(windowsProbe(), { env: { OneDrive: "C:\\Sync" } });
  await expectStorageError(() => envClassifier.assertSupportedTarget("C:\\Sync\\workspace"), "sync_root_detected");
  const registryClassifier = createWindowsClassifier(windowsProbe({ syncRoots: ["C:\\Cloud"] }));
  await expectStorageError(() => registryClassifier.assertSupportedTarget("C:\\Cloud\\workspace"), "sync_root_detected");
  await expectStorageError(() => envClassifier.assertSupportedTarget("C:\\Sync\\..workspace"), "sync_root_detected");
});

test("平台自定义同步根使用目标平台分隔符", async () => {
  const classifier = createClassifier("linux", {
    env: { CODEFLOWAI_SYNC_ROOTS: "/other:/sync" },
  });
  await expectStorageError(() => classifier.assertSupportedTarget("/sync/workspace"), "sync_root_detected");

  const iCloud = createClassifier("darwin", {});
  await expectStorageError(
    () => iCloud.assertSupportedTarget("/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/workspace"),
    "sync_root_detected",
  );
});

/** 构造 diskutil/plutil 的顺序化响应，支持卷到 APFS physical store 的追踪。 */
function createDarwinClassifier(infos: Record<string, Record<string, unknown>>): StorageClassifier {
  return createClassifier("darwin", {
    runCommand: async (command, args, input) => {
      if (command === "/usr/sbin/diskutil") return { stdout: String(args[2]), stderr: "" };
      if (command === "/usr/bin/plutil") {
        const info = infos[String(input)];
        if (!info) throw new Error(`missing disk info: ${input}`);
        return { stdout: JSON.stringify(info), stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });
}

/** 生成 macOS 内置物理设备的默认 diskutil 信息。 */
function darwinPhysical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MountPoint: "/Volumes/Data",
    DeviceIdentifier: "disk0s2",
    BusProtocol: "PCI-Express",
    FilesystemType: "apfs",
    Internal: true,
    Removable: false,
    Ejectable: false,
    VirtualOrPhysical: "Physical",
    ...overrides,
  };
}

test("macOS 接受内置物理卷和可追踪的 APFS physical store", async () => {
  const direct = createDarwinClassifier({ "/Volumes/Data/workspaces": darwinPhysical() });
  const directResult = await direct.assertSupportedTarget("/Volumes/Data/workspaces");
  assert.deepEqual(directResult.deviceIds, ["disk0s2"]);
  assert.equal(directResult.fileSystemType, "apfs");

  const apfs = createDarwinClassifier({
    "/Volumes/Data/workspaces": {
      MountPoint: "/Volumes/Data",
      FilesystemType: "apfs",
      APFSPhysicalStores: [{ APFSPhysicalStore: "disk0s2" }],
    },
    disk0s2: darwinPhysical({ MountPoint: undefined }),
  });
  assert.deepEqual((await apfs.assertSupportedTarget("/Volumes/Data/workspaces")).deviceIds, ["disk0s2"]);

  for (const physicalStores of [
    ["disk0s2"],
    [{ DeviceIdentifier: "disk0s2" }],
  ]) {
    const variant = createDarwinClassifier({
      "/Volumes/Data/workspaces": { MountPoint: "/Volumes/Data", FilesystemType: "apfs", APFSPhysicalStores: physicalStores },
      disk0s2: darwinPhysical({ MountPoint: undefined }),
    });
    assert.deepEqual((await variant.assertSupportedTarget("/Volumes/Data/workspaces")).deviceIds, ["disk0s2"]);
  }
});

test("macOS 拒绝外置、可移除、虚拟、未知协议和畸形 APFS 映射", async () => {
  const variants = [
    { Internal: false },
    { Removable: true },
    { Ejectable: true },
    { VirtualOrPhysical: "Virtual" },
    { BusProtocol: "USB" },
    { BusProtocol: "" },
  ];
  for (const variant of variants) {
    const classifier = createDarwinClassifier({ "/Volumes/Data/workspaces": darwinPhysical(variant) });
    await expectStorageError(() => classifier.assertSupportedTarget("/Volumes/Data/workspaces"), "darwin_device_unsupported");
  }
  const malformed = createDarwinClassifier({
    "/Volumes/Data/workspaces": { MountPoint: "/Volumes/Data", APFSPhysicalStores: [{}] },
  });
  await expectStorageError(() => malformed.assertSupportedTarget("/Volumes/Data/workspaces"), "darwin_physical_store_invalid");
});

test("macOS 缺少挂载点或设备标识时显式失败", async () => {
  const noMount = createDarwinClassifier({ "/Volumes/Data/workspaces": darwinPhysical({ MountPoint: undefined }) });
  await expectStorageError(() => noMount.assertSupportedTarget("/Volumes/Data/workspaces"), "darwin_mount_point_missing");
  const noDevice = createDarwinClassifier({ "/Volumes/Data/workspaces": darwinPhysical({ DeviceIdentifier: undefined }) });
  await expectStorageError(() => noDevice.assertSupportedTarget("/Volumes/Data/workspaces"), "darwin_device_id_missing");

  const noFilesystem = createDarwinClassifier({
    "/Volumes/Data/workspaces": darwinPhysical({ FilesystemType: undefined }),
  });
  await expectStorageError(() => noFilesystem.assertSupportedTarget("/Volumes/Data/workspaces"), "darwin_filesystem_missing");
});

type LinuxFixture = {
  mountInfo?: string;
  realPaths: Record<string, string>;
  directories?: Record<string, string[]>;
  files?: Record<string, string>;
  readDirError?: { path: string; code: string };
};

/** 构造 Linux mountinfo/sysfs 虚拟夹具，严格拒绝未声明的探针路径。 */
function createLinuxClassifier(fixture: LinuxFixture): StorageClassifier {
  return createClassifier("linux", {
    realpath: async (targetPath) => {
      if (Object.hasOwn(fixture.realPaths, targetPath)) return fixture.realPaths[targetPath]!;
      if (targetPath.startsWith("/sys/")) throw fsError("ENOENT", targetPath);
      return targetPath;
    },
    readFile: async (targetPath) => {
      if (targetPath === "/proc/self/mountinfo") {
        return fixture.mountInfo ?? "36 25 8:1 / /data rw - ext4 /dev/sda1 rw";
      }
      if (Object.hasOwn(fixture.files ?? {}, targetPath)) return fixture.files![targetPath]!;
      throw fsError("ENOENT", targetPath);
    },
    readDir: async (targetPath) => {
      if (fixture.readDirError?.path === targetPath) throw fsError(fixture.readDirError.code, targetPath);
      if (Object.hasOwn(fixture.directories ?? {}, targetPath)) return fixture.directories![targetPath]!;
      throw fsError("ENOENT", targetPath);
    },
  });
}

test("Linux 接受不可移除的 SATA 和 NVMe 分区", async () => {
  const cases = [
    {
      realPath: "/sys/devices/pci0000:00/ata1/host0/target0/block/sda/sda1",
      removablePath: "/sys/devices/pci0000:00/ata1/host0/target0/block/sda/removable",
      busType: "sata",
    },
    {
      realPath: "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/nvme0n1p1",
      removablePath: "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/removable",
      busType: "nvme",
    },
  ];
  for (const item of cases) {
    const classifier = createLinuxClassifier({
      realPaths: { "/sys/dev/block/8:1": item.realPath },
      directories: { [`${item.realPath}/slaves`]: [] },
      files: { [item.removablePath]: "0\n" },
    });
    const result = await classifier.assertSupportedTarget("/data/workspaces");
    assert.deepEqual(result.busTypes, [item.busType]);
    assert.equal(result.fileSystemType, "ext4");
  }
});

test("Linux 递归证明 dm/md 的全部后端设备", async () => {
  const dm = "/sys/devices/virtual/block/dm-0";
  const sata = "/sys/devices/pci0000:00/ata1/host0/target0/block/sda/sda1";
  const nvme = "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/nvme0n1p1";
  const classifier = createLinuxClassifier({
    mountInfo: "36 25 253:0 / /data rw - ext4 /dev/dm-0 rw",
    realPaths: {
      "/sys/dev/block/253:0": dm,
      "/sys/class/block/sda1": sata,
      "/sys/class/block/nvme0n1p1": nvme,
    },
    directories: {
      [`${dm}/slaves`]: ["sda1", "nvme0n1p1"],
      [`${sata}/slaves`]: [],
      [`${nvme}/slaves`]: [],
    },
    files: {
      "/sys/devices/pci0000:00/ata1/host0/target0/block/sda/removable": "0",
      "/sys/devices/pci0000:00/nvme/nvme0/nvme0n1/removable": "0",
    },
  });
  const result = await classifier.assertSupportedTarget("/data/workspaces");
  assert.deepEqual(new Set(result.busTypes), new Set(["sata", "nvme"]));
});

test("Linux 接受 SAS 路径和明确的硬件 RAID 驱动", async () => {
  const sas = "/sys/devices/pci0000:00/sas/host0/end_device-0/block/sda/sda1";
  const sasClassifier = createLinuxClassifier({
    realPaths: { "/sys/dev/block/8:1": sas },
    directories: { [`${sas}/slaves`]: [] },
    files: { [`${sas}/removable`]: "0" },
  });
  assert.deepEqual((await sasClassifier.assertSupportedTarget("/data/workspaces")).busTypes, ["sas"]);

  const raidPartition = "/sys/devices/pci0000:00/host0/target0/block/sdb/sdb1";
  const raidDisk = "/sys/devices/pci0000:00/host0/target0/block/sdb";
  const raidClassifier = createLinuxClassifier({
    realPaths: {
      "/sys/dev/block/8:1": raidPartition,
      [`${raidDisk}/device/driver`]: "/sys/bus/pci/drivers/megaraid_sas",
    },
    directories: { [`${raidPartition}/slaves`]: [] },
    files: { [`${raidDisk}/removable`]: "0" },
  });
  assert.deepEqual(
    (await raidClassifier.assertSupportedTarget("/data/workspaces")).busTypes,
    ["sas_or_hardware_raid"],
  );
});

test("Linux 拒绝任一可移除、USB、loop、虚拟或未知叶设备", async () => {
  const variants = [
    { path: "/sys/devices/pci0000:00/ata1/block/sda/sda1", removable: "1", reason: "linux_device_unsupported" },
    { path: "/sys/devices/pci0000:00/usb1/1-1/block/sdb/sdb1", removable: "0", reason: "linux_device_unsupported" },
    { path: "/sys/devices/pci0000:00/host6/rport-6:0-1/target6/block/sdc/sdc1", removable: "0", reason: "linux_device_unsupported" },
    { path: "/sys/devices/virtual/block/loop0", removable: "0", reason: "linux_device_unsupported" },
    { path: "/sys/devices/platform/unknown/block/xda/xda1", removable: "0", reason: "linux_device_unsupported" },
  ];
  for (const variant of variants) {
    const classifier = createLinuxClassifier({
      realPaths: { "/sys/dev/block/8:1": variant.path },
      directories: { [`${variant.path}/slaves`]: [] },
      files: { [`${variant.path}/removable`]: variant.removable },
    });
    await expectStorageError(() => classifier.assertSupportedTarget("/data/workspaces"), variant.reason);
  }
});

test("Linux 拒绝 FUSE、NFS 和无法唯一匹配的挂载信息", async () => {
  for (const mountInfo of [
    "36 25 0:45 / /data rw - fuse.sshfs remote rw",
    "36 25 0:46 / /data rw - nfs4 host:/data rw",
    "36 25 8:1 / /data rw - btrfs /dev/sda1 rw",
    "invalid mountinfo",
  ]) {
    const classifier = createLinuxClassifier({ mountInfo, realPaths: {} });
    await expectStorageError(() => classifier.assertSupportedTarget("/data/workspaces"), "linux_filesystem_unsupported");
  }
});

test("Linux 重复最长挂载点时拒绝猜测当前可见设备", async () => {
  const classifier = createLinuxClassifier({
    mountInfo: [
      "36 25 8:1 / /data rw - ext4 /dev/sda1 rw",
      "37 25 0:46 / /data rw - nfs4 host:/data rw",
    ].join("\n"),
    realPaths: {},
  });
  await expectStorageError(() => classifier.assertSupportedTarget("/data/..workspace"), "linux_mount_ambiguous");
});

test("Linux sysfs 权限错误显式归一化且不泄露本地路径", async () => {
  const realPath = "/sys/devices/pci0000:00/ata1/block/sda/sda1";
  const classifier = createLinuxClassifier({
    realPaths: { "/sys/dev/block/8:1": realPath },
    readDirError: { path: `${realPath}/slaves`, code: "EACCES" },
  });
  await expectStorageError(() => classifier.assertSupportedTarget("/data/workspaces"), "linux_sysfs_slaves_unavailable");
});

test("命令失败和非法 JSON 均显式返回存储不支持", async () => {
  const timeout = createClassifier("win32", {
    runCommand: async () => { throw new Error("probe timeout for C:\\secret\\path"); },
  });
  await expectStorageError(() => timeout.assertSupportedTarget("C:\\target"), "windows_storage_probe_failed");

  const invalid = createClassifier("win32", {
    runCommand: async () => ({ stdout: "not-json", stderr: "" }),
  });
  await expectStorageError(() => invalid.assertSupportedTarget("C:\\target"), "windows_storage_probe_invalid");
});

test("默认命令执行器覆盖成功、退出码、输出上限、超时和 stdin 提前关闭", async () => {
  const success = await runStorageProbeCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    "probe-input",
    { timeoutMs: 1_000, maxOutputBytes: 1_024 },
  );
  assert.equal(success.stdout, "probe-input");

  await assert.rejects(
    runStorageProbeCommand(process.execPath, ["-e", "process.exit(7)"], undefined, { timeoutMs: 1_000 }),
    /code=7/,
  );
  await assert.rejects(
    runStorageProbeCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2048))"],
      undefined,
      { timeoutMs: 1_000, maxOutputBytes: 128 },
    ),
    /output exceeds 128 bytes/,
  );
  await assert.rejects(
    runStorageProbeCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      undefined,
      { timeoutMs: 50 },
    ),
    /timed out after 50ms/,
  );
  await assert.rejects(
    runStorageProbeCommand(process.execPath, ["-e", "process.exit(1)"], "x".repeat(1024 * 1024)),
  );
});

test("相对路径和非目录使用目标无效错误码", async () => {
  const classifier = createClassifier("linux", { stat: async () => ({ isDirectory: () => false }) });
  await expectStorageError(
    () => classifier.assertSupportedTarget("relative/path"),
    "path_not_absolute",
    "WORKSPACE_MIGRATION_TARGET_INVALID",
  );
  await expectStorageError(
    () => classifier.assertSupportedTarget("/data/file"),
    "path_not_directory",
    "WORKSPACE_MIGRATION_TARGET_INVALID",
  );
});
