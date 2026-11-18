import path from "node:path";
import fs from "node:fs/promises";
import syncFs, { constants, type BigIntStats, type Stats } from "node:fs";
import crypto from "node:crypto";
import { readDeviceIdentity, removeDesktopDeviceIdentity } from "./deviceIdentity.js";
import { GENERATED_FILES, REMOVE_FILES, REMOVE_DIRECTORIES } from "./desktopRemovalPaths.js";
import { assertDesktopStoragePath, readDesktopJsonFile, verifyDesktopReinstallStorage, verifyDesktopStorageLocation,
  assertDesktopRemovalRoots, inspectDesktopRemovalRoots, verifyDesktopRemovalLocation, removeDesktopStorageLocation,
  assertDesktopUnregisteredStorage, rebindDesktopStorageLocation,
  type DesktopStorageLocation, type DesktopReinstallAuthorization, type DesktopRemovalRoots } from "./desktopStorageLocation.js";

export type MaintenanceMode = "keep" | "remove";
type MaintenancePhase = "started" | "data_action_authorized" | "completed" | "reinstalling" | "consumed";
type MaintenanceContext = {
  maintenanceRequestId: string; clientId: string | null; oldDeviceId: string | null; mode: MaintenanceMode; maintenancePhase: MaintenancePhase;
  nextDeviceId?: string;
};
export type MaintenanceRecord = {
  schemaVersion: 1; appId: "ai.codeflow.codeflowai"; requestId: string; mode: MaintenanceMode; phase: MaintenancePhase;
  installRoot: string; dataDir: string; clientId: string | null; oldDeviceId: string | null; nextDeviceId?: string; createdAt?: string;
  rebindFromInstallRoot?: string;
  authorizedPaths?: string[];
  removalRoots?: DesktopRemovalRoots;
  retainedFiles?: { configSha256: string; databaseSha256: string; metadataSha256: string };
};
export type DesktopReinstallContinuation = { authorization: DesktopReinstallAuthorization; record: MaintenanceRecord };
type MaintenanceInput = { userDataDir: string; location: DesktopStorageLocation };

/** 只清理无存活进程且指向本库的客户端锁；活锁、坏锁或越界路径保留失败。 */
function removeStaleClientProcessLocks(dataDir: string): void {
  if (!syncFs.existsSync(dataDir)) return;
  const databasePath = path.join(dataDir, "codeflowai.db");
  const matches = (left: string) => process.platform === "win32" ? left.toLowerCase() === databasePath.toLowerCase() : left === databasePath;
  for (const name of syncFs.readdirSync(dataDir)) {
    if (!/^client\.[0-9a-f]{12}\.lock$/u.test(name)) continue;
    const lockPath = path.join(dataDir, name), stat = syncFs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CLIENT_LOCK_INVALID");
    let lock: { pid?: unknown; token?: unknown; clientId?: unknown; dbPath?: unknown };
    try { lock = JSON.parse(syncFs.readFileSync(lockPath, "utf8")); }
    catch { throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CLIENT_LOCK_INVALID"); }
    const pid = Number(lock.pid);
    if (!Number.isInteger(pid) || pid <= 0 || typeof lock.token !== "string" || !lock.token
      || typeof lock.clientId !== "string" || !lock.clientId || typeof lock.dbPath !== "string" || !matches(path.resolve(lock.dbPath))) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CLIENT_LOCK_INVALID");
    }
    try { process.kill(pid, 0); throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CLIENT_LOCK_ACTIVE"); }
    catch (cause) {
      if (cause instanceof DesktopMaintenanceStartupError) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
    syncFs.unlinkSync(lockPath);
  }
}

/** 同锁维护先核当前旧归属再写started；同请求只恢复原阶段，不接管其他pending。 */
export async function beginDesktopMaintenance(input: MaintenanceInput & { requestId: string; mode: MaintenanceMode }): Promise<MaintenanceRecord> {
  const { location, userDataDir, requestId, mode } = input;
  const started = parseRecord({ schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId, mode, phase: "started",
    installRoot: location.installRoot, dataDir: location.dataDir, clientId: location.clientId, oldDeviceId: location.deviceId });
  const details = context(started);
  try {
    removeStaleClientProcessLocks(location.dataDir);
    assertMaintenanceContext(input, started);
    const value = await readDesktopJsonFile(path.join(userDataDir, "desktop-uninstall-result.json"));
    const previous = value === null ? null : parseRecord(value);
    if (started.clientId === null) {
      if (previous && !(previous.phase === "completed" && (previous.clientId === null || previous.mode === "remove"))
        && (previous.requestId !== requestId || previous.mode !== mode || previous.clientId !== null)) {
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PENDING", context(previous));
      }
      if (previous?.requestId === requestId && previous.mode !== mode) {
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PENDING", context(previous));
      }
      if (previous?.requestId === requestId) {
        assertMaintenanceContext(input, previous);
        if (previous.phase === "completed") { await assertRecordCurrent(userDataDir, previous); return previous; }
        await verifyEmptyMaintenance(input, previous, previous.phase === "data_action_authorized");
        await assertRecordCurrent(userDataDir, previous); assertDesktopUnregisteredStorage(location); return previous;
      }
      await verifyEmptyMaintenance(input, started, false);
      await replaceRecord(userDataDir, previous, started, undefined, () => assertDesktopUnregisteredStorage(location));
      return started;
    }
    const historical = previous?.phase === "completed" && (previous.mode === "remove" || previous.clientId === null);
    if (previous && previous.phase !== "consumed" && (!historical || previous.requestId === requestId)) {
      if (previous.requestId !== requestId || previous.mode !== mode || !["started", "data_action_authorized", "completed"].includes(previous.phase)) {
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PENDING", context(previous));
      }
      assertMaintenanceContext(input, previous);
      if (previous.phase === "started") await verifyDesktopStorageLocation(location);
      else if (previous.mode === "keep") { const retained = await verifyKeepAuthorization(input, previous); await retained.assertCurrent(); }
      else if (previous.phase === "data_action_authorized") {
        await verifyDesktopRemovalLocation(location, previous.removalRoots!, true); assertDesktopRemovalRoots(location, previous.removalRoots!);
        inspectRemovalInventory(input, previous);
        await verifyRemovalIdentity(input, previous); assertDesktopRemovalRoots(location, previous.removalRoots!);
        await completeEmptyRemovalAuth(input, previous); assertDesktopRemovalRoots(location, previous.removalRoots!);
      }
      await assertRecordCurrent(userDataDir, previous);
      if (previous.mode === "remove" && previous.removalRoots) assertDesktopRemovalRoots(location, previous.removalRoots);
      return previous;
    }
    await verifyDesktopStorageLocation(location);
    if (previous && !historical) {
      if (previous.requestId === requestId || path.relative(previous.installRoot, location.installRoot) !== ""
        || path.relative(previous.dataDir, location.dataDir) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
      await assertConsumedIdentity(previous, location);
    }
    await replaceRecord(userDataDir, previous, started, async () => { await verifyDesktopStorageLocation(location); });
    return started;
  } catch (cause) { throw maintenanceFailure(cause, details, mode === "keep" ? "DESKTOP_KEEP_MAINTENANCE_FAILED" : "DESKTOP_REMOVE_MAINTENANCE_FAILED"); }
}

/** worker/browser成功后固定 keep 接续或 remove 根与清单；落盘失败不授权删除。 */
export async function authorizeDesktopMaintenance(input: MaintenanceInput, value: MaintenanceRecord): Promise<MaintenanceRecord> {
  const record = parseRecord(structuredClone(value)), details = context(record);
  try {
    assertMaintenanceContext(input, record);
    if (record.phase !== "started") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PHASE_INVALID", details);
    if (record.clientId === null) {
      await assertRecordCurrent(input.userDataDir, record); assertDesktopUnregisteredStorage(input.location);
      const roots = await verifyEmptyMaintenance(input, record, false);
      const authorized: MaintenanceRecord = { ...record, phase: "data_action_authorized", authorizedPaths: ["userDataDir/desktop-data-location.json"], removalRoots: roots };
      await replaceRecord(input.userDataDir, record, authorized, undefined, () => {
        assertDesktopRemovalRoots(input.location, roots); assertDesktopUnregisteredStorage(input.location);
      });
      return authorized;
    }
    await assertRecordCurrent(input.userDataDir, record); await verifyDesktopStorageLocation(input.location);
    const retained = await inspectRetainedFiles(record);
    const config = await readDesktopJsonFile(path.join(record.dataDir, "config.json"));
    if (!config || typeof config !== "object" || (config as Record<string, unknown>).apiKey !== "") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CREDENTIALS_NOT_CLEARED", details);
    }
    if (record.mode === "remove") {
      const roots = await inspectDesktopRemovalRoots(input.location); assertDesktopRemovalRoots(input.location, roots);
      const archived = retiredUpdateAttemptArchives(record.dataDir);
      const authorized: MaintenanceRecord = { ...record, phase: "data_action_authorized",
        authorizedPaths: [...AUTHORIZED_PATHS, ...archived.map(name => `dataDir/${name}`)], removalRoots: roots };
      const inventory = inspectRemovalInventory(input, authorized, false);
      await replaceRecord(input.userDataDir, record, authorized, async () => {
        assertDesktopRemovalRoots(input.location, roots);
        await verifyDesktopStorageLocation(input.location); assertDesktopRemovalRoots(input.location, roots);
        await retained.assertCurrent(); assertDesktopRemovalRoots(input.location, roots); inventory.assertCurrent();
      }, inventory.assertCurrent);
      inventory.assertCurrent(); return authorized;
    }
    const authorized: MaintenanceRecord = { ...record, phase: "data_action_authorized", nextDeviceId: crypto.randomUUID(),
      createdAt: new Date().toISOString(), retainedFiles: retained.retainedFiles };
    await replaceRecord(input.userDataDir, record, authorized, async () => {
      await verifyDesktopStorageLocation(input.location); await retained.assertCurrent();
    });
    return authorized;
  } catch (cause) { throw maintenanceFailure(cause, details, record.mode === "keep" ? "DESKTOP_KEEP_MAINTENANCE_FAILED" : "DESKTOP_REMOVE_MAINTENANCE_FAILED"); }
}

/** 持久授权下完成对应数据动作，身份最后；结果写失败保授权供同请求重入。 */
export async function completeDesktopMaintenance(input: MaintenanceInput, value: MaintenanceRecord): Promise<void> {
  const record = parseRecord(structuredClone(value)), details = context(record);
  try {
    assertMaintenanceContext(input, record);
    if (record.phase !== "data_action_authorized" && record.phase !== "completed") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PHASE_INVALID", details);
    await assertRecordCurrent(input.userDataDir, record);
    if (record.clientId === null) {
      if (record.phase === "completed") return;
      const roots = await verifyEmptyMaintenance(input, record, true);
      await removeDesktopStorageLocation(input.location, roots, record.requestId, () => assertDesktopUnregisteredStorage(input.location));
      assertDesktopRemovalRoots(input.location, roots); assertDesktopUnregisteredStorage(input.location);
      const completed = { ...record, phase: "completed" as const }; delete completed.authorizedPaths; delete completed.removalRoots;
      await replaceRecord(input.userDataDir, record, completed, undefined, () => {
        assertDesktopRemovalRoots(input.location, roots); assertDesktopUnregisteredStorage(input.location);
        if (removalStat(path.join(input.userDataDir, "desktop-data-location.json"))
          || syncFs.readdirSync(input.userDataDir).some(name => name.toLowerCase().startsWith("desktop-data-location.json."))) {
          throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_REMOVE_INCOMPLETE", details);
        }
      });
      return;
    }
    if (record.mode === "remove") {
      if (record.phase === "completed") return;
      const roots = record.removalRoots!;
      await verifyDesktopRemovalLocation(input.location, roots, true); assertDesktopRemovalRoots(input.location, roots);
      await verifyRemovalIdentity(input, record); assertDesktopRemovalRoots(input.location, roots);
      const inventory = inspectRemovalInventory(input, record);
      await removePrivateTargets(input, record, inventory); inventory.assertBoundary();
      await assertRecordCurrent(input.userDataDir, record); inventory.assertBoundary();
      await removeDesktopStorageLocation(input.location, roots, record.requestId, inventory.assertBoundary); inventory.assertBoundary();
      await assertRecordCurrent(input.userDataDir, record); inventory.assertBoundary();
      await removeDesktopDeviceIdentity(record.dataDir, record.oldDeviceId!); inventory.assertBoundary();
      await assertIdentityMissing(record); inventory.assertBoundary();
      const completed = { ...record, phase: "completed" as const }; delete completed.authorizedPaths; delete completed.removalRoots;
      /** 收尾复用原保留目录身份，并在每个异步返回点核验私有命名空间已空。 */
      const assertFinished = (): void => {
        inventory.assertBoundary();
        const finalInventory = inspectRemovalInventory(input, record); finalInventory.assertCurrent();
        if ([...finalInventory.entries.values()].some(Boolean) || removalStat(path.join(input.userDataDir, "desktop-data-location.json"))
          || syncFs.readdirSync(input.userDataDir).some(name => name.toLowerCase().startsWith("desktop-data-location.json."))
          || syncFs.readdirSync(record.dataDir).some(name => name.toLowerCase().startsWith("device-identity.json"))) {
          throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_REMOVE_INCOMPLETE", details);
        }
      };
      await replaceRecord(input.userDataDir, record, completed, async () => {
        await assertIdentityMissing(record); inventory.assertBoundary();
      }, assertFinished);
      inventory.assertBoundary(); return;
    }
    const retained = await verifyKeepAuthorization(input, record);
    await retained.assertCurrent(); await assertRecordCurrent(input.userDataDir, record);
    if (record.phase === "completed") return;
    await removeDesktopDeviceIdentity(record.dataDir, record.oldDeviceId!);
    await assertIdentityMissing(record);
    await replaceRecord(input.userDataDir, record, { ...record, phase: "completed" }, async () => {
      await retained.assertCurrent(); await assertIdentityMissing(record);
    });
  } catch (cause) { throw maintenanceFailure(cause, details, record.mode === "keep" ? "DESKTOP_KEEP_MAINTENANCE_FAILED" : "DESKTOP_REMOVE_MAINTENANCE_FAILED"); }
}

/** 维护只消费同一完整旧locator，不允许调用参数扩大或替换持久归属。 */
function assertMaintenanceContext(input: MaintenanceInput, record: MaintenanceRecord): void {
  const { location } = input;
  if (path.relative(input.userDataDir, location.userDataDir) !== ""
    || path.relative(location.installRoot, record.installRoot) !== "" || path.relative(location.dataDir, record.dataDir) !== ""
    || location.clientId !== record.clientId || location.deviceId !== record.oldDeviceId) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", context(record));
  }
}

/** 空安装不打开数据库或读取 D13；每个异步返回点必须仍为同根，且默认 runtime 仅接受已知自身条目。 */
async function verifyEmptyMaintenance(input: MaintenanceInput, record: MaintenanceRecord, allowMissingLocator: boolean): Promise<DesktopRemovalRoots> {
  assertMaintenanceContext(input, record); assertDesktopUnregisteredStorage(input.location);
  const roots = record.removalRoots ?? await inspectDesktopRemovalRoots(input.location);
  const guard = () => { assertDesktopRemovalRoots(input.location, roots); assertDesktopUnregisteredStorage(input.location); };
  guard(); await verifyDesktopRemovalLocation(input.location, roots, allowMissingLocator, () => assertDesktopUnregisteredStorage(input.location)); guard();
  return roots;
}

/** 同根started只读准许修复安装；keep重绑仍先记录后定位，不扩大删除授权。 */
export async function rebindDesktopKeepInstallation(input: MaintenanceInput & { installRoot: string }): Promise<DesktopStorageLocation> {
  const { location, userDataDir, installRoot } = input;
  await assertDesktopStoragePath(installRoot);
  const value = await readDesktopJsonFile(path.join(userDataDir, "desktop-uninstall-result.json"));
  const record = value === null ? null : parseRecord(value);
  if (!record || record.phase === "consumed" || record.phase === "completed" && (record.mode === "remove" || record.clientId === null)) {
    if (path.relative(location.installRoot, installRoot) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", record ? context(record) : undefined);
    await verifyDesktopStorageLocation(location); return location;
  }
  const details = context(record);
  try {
    if (record.phase === "started" && record.clientId !== null) {
      assertMaintenanceContext(input, record);
      if (path.relative(record.installRoot, installRoot) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
      await verifyDesktopStorageLocation(location); await assertRecordCurrent(userDataDir, record);
      return location;
    }
    if (record.mode !== "keep" || record.clientId === null || !["completed", "reinstalling"].includes(record.phase) || !record.retainedFiles
      || location.clientId !== record.clientId || ![record.oldDeviceId, record.nextDeviceId].includes(location.deviceId)
      || path.relative(record.dataDir, location.dataDir) !== "" || path.relative(userDataDir, location.userDataDir) !== "") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    }
    const from = record.rebindFromInstallRoot ?? record.installRoot;
    await assertDesktopStoragePath(from);
    if (record.rebindFromInstallRoot && (path.relative(record.installRoot, installRoot) !== ""
      || ![from, record.installRoot].some(root => path.relative(root, location.installRoot) === ""))) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    }
    if (!record.rebindFromInstallRoot && path.relative(location.installRoot, record.installRoot) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    const authorization = { clientId: record.clientId, oldDeviceId: record.oldDeviceId!, nextDeviceId: record.nextDeviceId!, createdAt: record.createdAt! };
    let currentLocation = location;
    const verify = async (): Promise<void> => {
      await verifyDesktopReinstallStorage(currentLocation, authorization);
      if (record.phase === "completed") { const retained = await inspectRetainedFiles(record); await retained.assertCurrent(); }
      await assertRecordCurrent(userDataDir, current);
      await assertDesktopStoragePath(from);
      await assertDesktopStoragePath(currentLocation.installRoot);
    };
    let current = record;
    await verify();
    if (!record.rebindFromInstallRoot && path.relative(record.installRoot, installRoot) !== "") {
      const rebound = { ...record, installRoot, rebindFromInstallRoot: from };
      await replaceRecord(userDataDir, record, rebound, verify); current = rebound;
    }
    const selected = Object.freeze({ ...location, installRoot });
    if (path.relative(location.installRoot, installRoot) !== "") await rebindDesktopStorageLocation(location, selected, verify);
    currentLocation = selected;
    await verify(); return selected;
  } catch (cause) { throw maintenanceFailure(cause, details); }
}

/** 缺失仅在已授权阶段合法；路径安全核验失败与任何已存在对象都不等价缺失。 */
async function assertIdentityMissing(record: MaintenanceRecord): Promise<void> {
  const filePath = path.join(record.dataDir, "device-identity.json"); await assertDesktopStoragePath(filePath);
  try { await fs.lstat(filePath); }
  catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return; throw cause; }
  throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", context(record));
}

/** 授权重入只接受原旧身份或合法缺失，明确拒绝F4预定next及第三身份。 */
async function verifyKeepAuthorization(input: MaintenanceInput, record: MaintenanceRecord) {
  if (!record.clientId || !record.oldDeviceId || !record.retainedFiles || !record.nextDeviceId || !record.createdAt) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_INVALID", context(record));
  const filePath = path.join(record.dataDir, "device-identity.json"); await assertDesktopStoragePath(filePath);
  let present: boolean;
  try { await fs.lstat(filePath); present = true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw cause; present = false; }
  if (present) {
    if (record.phase === "completed") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", context(record));
    await verifyDesktopStorageLocation(input.location);
  } else {
    await assertIdentityMissing(record);
    await verifyDesktopReinstallStorage(input.location, { clientId: record.clientId, oldDeviceId: record.oldDeviceId,
      nextDeviceId: record.nextDeviceId, createdAt: record.createdAt });
    await assertIdentityMissing(record);
  }
  const retained = await inspectRetainedFiles(record);
  return { async assertCurrent(): Promise<void> {
    await retained.assertCurrent();
    if (!present) await assertIdentityMissing(record);
  } };
}

/** completed先严格核摘要再持久唯一授权；reinstalling重试不重复要求旧字节。 */
export async function prepareDesktopReinstall(input: { userDataDir: string; location: DesktopStorageLocation }): Promise<DesktopReinstallContinuation | null> {
  const value = await readDesktopJsonFile(path.join(input.userDataDir, "desktop-uninstall-result.json"));
  if (value === null) return null;
  const record = parseRecord(value);
  if (record.mode !== "keep" || record.clientId === null || record.oldDeviceId === null || (record.phase !== "completed" && record.phase !== "reinstalling") || !record.retainedFiles) return null;
  const details = context(record);
  try {
    await assertDesktopStoragePath(record.installRoot); await assertDesktopStoragePath(record.dataDir);
    if (path.relative(input.userDataDir, input.location.userDataDir) !== "" || path.relative(input.location.installRoot, record.installRoot) !== ""
      || path.relative(input.location.dataDir, record.dataDir) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    const authorization = { clientId: record.clientId, oldDeviceId: record.oldDeviceId, nextDeviceId: record.nextDeviceId!, createdAt: record.createdAt! };
    await verifyDesktopReinstallStorage(input.location, authorization);
    let assertPrepared: (() => Promise<void>) | undefined;
    if (record.phase === "completed") {
      const retained = await inspectRetainedFiles(record); assertPrepared = retained.assertCurrent;
    }
    const next: MaintenanceRecord = { ...record, phase: "reinstalling" };
    if (record.phase === "completed") await replaceRecord(input.userDataDir, record, next, assertPrepared);
    else await assertRecordCurrent(input.userDataDir, record);
    return { authorization, record: next };
  } catch (cause) { throw maintenanceFailure(cause, details); }
}

/** 所有资源关闭且locator与实际next一致后压缩唯一记录，失败保reinstalling重试。 */
export async function finishDesktopReinstall(input: { userDataDir: string; location: DesktopStorageLocation }, continuation: DesktopReinstallContinuation): Promise<void> {
  const record = parseRecord(continuation.record), details = context(record);
  try {
    if (record.mode !== "keep" || record.phase !== "reinstalling" || input.location.clientId !== record.clientId
      || input.location.deviceId !== record.nextDeviceId) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", details);
    await verifyDesktopStorageLocation(input.location);
    await assertConsumedIdentity(record, input.location);
    const consumed = { ...record, phase: "consumed" as const };
    delete consumed.createdAt; delete consumed.retainedFiles; delete consumed.rebindFromInstallRoot;
    await replaceRecord(input.userDataDir, record, consumed);
  } catch (cause) { throw maintenanceFailure(cause, details); }
}
const BASE_FIELDS = ["schemaVersion", "appId", "requestId", "mode", "phase", "installRoot", "dataDir", "clientId", "oldDeviceId"];
const UPDATE_PATHS = ["pending-release.json", "update-database-backup.json", "update-database-backups"];
const RETIRED_UPDATE_ARCHIVE = /^shell-update-retired-(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|install-[A-Za-z0-9][A-Za-z0-9._+-]{0,127}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?)\.json$/u;
const AUTHORIZED_PATHS = [...REMOVE_FILES, ...REMOVE_DIRECTORIES].map(name => `dataDir/${name}`).concat("userDataDir/desktop-data-location.json");
// 历史清单保持原值；新增更新状态与备份目录只由本次新授权删除。
const PRE_UPDATE_AUTHORIZED_PATHS = AUTHORIZED_PATHS.filter(value => !UPDATE_PATHS.some(name => value === `dataDir/${name}`));
const PREVIOUS_AUTHORIZED_PATHS = PRE_UPDATE_AUTHORIZED_PATHS.filter(value => value !== "dataDir/cli-runtime");
const LEGACY_AUTHORIZED_PATHS = PREVIOUS_AUTHORIZED_PATHS.filter(value => value !== "dataDir/legacy-client-migration"
  && !GENERATED_FILES.some(name => value === `dataDir/${name}`));
const PHASES: MaintenancePhase[] = ["started", "data_action_authorized", "completed", "reinstalling", "consumed"];

/** 已有壳更新归档仅在本次 remove 授权时按精确文件名纳入清理范围。 */
function retiredUpdateAttemptArchives(dataDir: string): string[] {
  return syncFs.readdirSync(dataDir).filter(isRetiredUpdateArchive);
}

/** 归档名必须是产品生成的 UUID 文件，不能把相似前缀的用户文件带入删除集合。 */
function isRetiredUpdateArchive(name: string): boolean {
  return RETIRED_UPDATE_ARCHIVE.test(name);
}

/** 历史归档只使用授权记录中的精确名称，不作目录通配删除。 */
function removalFiles(record: MaintenanceRecord): string[] {
  const archives = record.authorizedPaths?.filter(value => value.startsWith("dataDir/"))
    .map(value => value.slice("dataDir/".length)).filter(isRetiredUpdateArchive) ?? [];
  return [...REMOVE_FILES, ...archives];
}

/** 删除仅覆盖持久授权清单；默认工作区只核目录身份并保留，未知条目仍拒绝。 */
function inspectRemovalInventory(input: MaintenanceInput, record: MaintenanceRecord, allowCapture = true) {
  if (record.oldDeviceId === null) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_INVALID", context(record));
  const roots = record.removalRoots!, { location } = input, details = context(record);
  const entries = new Map<string, BigIntStats | undefined>(), children = new Map<string, string[]>();
  const workspace = path.join(record.dataDir, "workspace"), retained = removalStat(workspace);
  if (retained && (!retained.isDirectory() || retained.isSymbolicLink())) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_INVALID", details);
  /** 保留目录不会递归或进入删除集合；异步期间新增、替换或链接同样失败。 */
  const guard = (): void => {
    assertDesktopRemovalRoots(location, roots);
    const current = removalStat(workspace);
    if (retained ? !current || !sameRemovalEntry(retained, current) : current !== undefined) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
    }
  };
  guard();
  const names = syncFs.readdirSync(record.dataDir), fixed = [...removalFiles(record), ...REMOVE_DIRECTORIES];
  const identityPrefix = `device-identity.json.removing-${record.oldDeviceId.toLowerCase()}-`;
  const captures = names.filter(name => name.toLowerCase().startsWith("device-identity.json."));
  if (captures.length > 1 || captures.some(name => !allowCapture || !name.startsWith(identityPrefix) || !name.endsWith(".tmp")
    || !deviceId(name.slice(identityPrefix.length, -4)) || name.slice(identityPrefix.length, -4) !== name.slice(identityPrefix.length, -4).toLowerCase())
    || captures.length && names.includes("device-identity.json")) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNKNOWN_ENTRY", details);
  if (names.some(name => name !== "workspace" && name !== "device-identity.json" && !captures.includes(name)
    && (!fixed.includes(name) || !record.authorizedPaths?.includes(`dataDir/${name}`)))) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNKNOWN_ENTRY", details);
  }
  const locatorNames = syncFs.readdirSync(input.userDataDir).filter(name => name.toLowerCase().startsWith("desktop-data-location.json."));
  const locatorPrefix = `desktop-data-location.json.removing-${crypto.createHash("sha256").update(record.requestId).digest("hex")}-`;
  if (locatorNames.length > 1 || locatorNames.some(name => !allowCapture || !name.startsWith(locatorPrefix) || !name.endsWith(".tmp")
    || !deviceId(name.slice(locatorPrefix.length, -4)) || name.slice(locatorPrefix.length, -4) !== name.slice(locatorPrefix.length, -4).toLowerCase())
    || locatorNames.length && removalStat(path.join(input.userDataDir, "desktop-data-location.json"))) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNKNOWN_ENTRY", details);
  }
  if (locatorNames.length && (captures.length || !removalStat(path.join(record.dataDir, "device-identity.json"))
    || removalFiles(record).some(name => removalStat(path.join(record.dataDir, name)))
    || REMOVE_DIRECTORIES.some(name => name !== ".shell-update-file-auth" && removalStat(path.join(record.dataDir, name))))) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", details);
  }
  /** 根内固定目录才能递归；不跟随链接或接受工作区元数据目录。 */
  const inspect = (target: string, directory: boolean): void => {
    guard(); const stat = removalStat(target); entries.set(target, stat);
    if (!stat) return;
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_INVALID", details);
    }
    if (directory) {
      const members = syncFs.readdirSync(target); children.set(target, members);
      if (target === path.join(record.dataDir, ".shell-update-file-auth")) {
        const key = removalStat(path.join(target, "key"));
        if (members.length && (members.length !== 1 || members[0] !== "key" || !key?.isFile() || key.isSymbolicLink() || key.nlink !== 1n || key.size !== 32n)) {
          throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_HANDOFF_AUTH_INVALID", details);
        }
      }
      for (const name of members) {
        if ([".codeflow", ".codeflowai"].includes(name.toLowerCase())) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNKNOWN_ENTRY", details);
        const child = path.join(target, name), childStat = removalStat(child);
        if (!childStat) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
        inspect(child, childStat.isDirectory());
      }
    }
  };
  for (const name of removalFiles(record)) inspect(path.join(record.dataDir, name), false);
  for (const name of REMOVE_DIRECTORIES) inspect(path.join(record.dataDir, name), true);
  for (const name of ["device-identity.json", ...captures]) {
    const stat = removalStat(path.join(record.dataDir, name));
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_INVALID", details);
  }
  for (const name of locatorNames) {
    const stat = removalStat(path.join(input.userDataDir, name));
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_INVALID", details);
  }
  /** 成员移除由本轮显式记账；不会把新增文件并入删除集合。 */
  const assertCurrent = (): void => {
    guard();
    const currentNames = syncFs.readdirSync(record.dataDir);
    if (currentNames.some(name => !names.includes(name))) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNKNOWN_ENTRY", details);
    for (const [target, before] of entries) {
      const current = removalStat(target);
      if (before ? !current || !sameRemovalEntry(before, current) : current !== undefined) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
      const expected = children.get(target);
      if (expected) {
        const actual = syncFs.readdirSync(target);
        if (actual.length !== expected.length || actual.some(name => !expected.includes(name))) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
      }
    }
  };
  /** 单目标只复核自身及已取样祖先；完整成员表在授权边界和目录删除前核验。 */
  const assertTarget = (target: string): void => {
    guard();
    for (let current = target; current !== record.dataDir; current = path.dirname(current)) {
      const before = entries.get(current), actual = removalStat(current);
      if (!before || !actual || !sameRemovalEntry(before, actual)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
    }
    const expected = children.get(target);
    if (expected) {
      const actual = syncFs.readdirSync(target);
      if (actual.length !== expected.length || actual.some(name => !expected.includes(name))) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
    }
  };
  return { entries, children, assertCurrent, assertTarget, assertBoundary: guard };
}

/** 仅明确 ENOENT 可视为已授权目标已删；其他系统错误保留根因。 */
function removalStat(target: string): BigIntStats | undefined {
  try { return syncFs.lstatSync(target, { bigint: true }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined; throw cause; }
}

/** 删除业务目标前拒绝第三身份；捕获格式由原 identity owner 最终验签并删除。 */
async function verifyRemovalIdentity(input: MaintenanceInput, record: MaintenanceRecord): Promise<void> {
  const roots = record.removalRoots!, standard = path.join(record.dataDir, "device-identity.json");
  assertDesktopRemovalRoots(input.location, roots);
  const captures = syncFs.readdirSync(record.dataDir).filter(name => name.toLowerCase().startsWith("device-identity.json."));
  if (captures.length && (removalFiles(record).some(name => removalStat(path.join(record.dataDir, name)))
    || REMOVE_DIRECTORIES.some(name => name !== ".shell-update-file-auth" && removalStat(path.join(record.dataDir, name)))
    || removalStat(path.join(input.userDataDir, "desktop-data-location.json"))
    || syncFs.readdirSync(input.userDataDir).some(name => name.toLowerCase().startsWith("desktop-data-location.json.")))) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", context(record));
  }
  const source = captures.length === 1 ? path.join(record.dataDir, captures[0]!) : standard, before = removalStat(source);
  if (!before) return;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || captures.length > 1 || captures.length && removalStat(standard)) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", context(record));
  }
  const identity = source === standard ? await readDeviceIdentity(record.dataDir) : await readDesktopJsonFile(source);
  assertDesktopRemovalRoots(input.location, roots);
  const current = removalStat(source);
  if (!identity || typeof identity !== "object" || (identity as { deviceId?: unknown }).deviceId !== record.oldDeviceId
    || !current || !sameRemovalEntry(before, current)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", context(record));
}

/** 目录内容会随本轮删除变化，文件仍核正文元数据及单链接身份。 */
function sameRemovalEntry(before: BigIntStats, after: BigIntStats): boolean {
  return !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs
    && (before.isDirectory() ? after.isDirectory() : after.isFile() && after.nlink === 1n && before.nlink === 1n
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
}

/** 固定快照后序删除；每次 await 后核原两根，目录非空或目标替换立即失败。 */
async function removePrivateTargets(input: MaintenanceInput, record: MaintenanceRecord, inventory: ReturnType<typeof inspectRemovalInventory>): Promise<void> {
  const roots = record.removalRoots!, details = context(record);
  const order: string[] = [];
  /** 迭代编译根的既有快照，先 attempt 再 release，auth 固定最后。 */
  const append = (target: string): void => {
    for (const name of inventory.children.get(target) ?? []) append(path.join(target, name));
    order.push(target);
  };
  for (const name of [...removalFiles(record), ...REMOVE_DIRECTORIES]) append(path.join(record.dataDir, name));
  inventory.assertCurrent();
  for (const target of order) {
    assertDesktopRemovalRoots(input.location, roots);
    const before = inventory.entries.get(target);
    if (!before) continue;
    inventory.assertTarget(target);
    if (before.isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
    assertDesktopRemovalRoots(input.location, roots);
    if (removalStat(target)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_REMOVE_INCOMPLETE", details);
    inventory.entries.set(target, undefined); inventory.children.delete(target);
    const parent = inventory.children.get(path.dirname(target));
    if (parent) inventory.children.set(path.dirname(target), parent.filter(name => name !== path.basename(target)));
  }
  inventory.assertCurrent();
}

/** 只补完本授权已删 key 的空目录；首次 D13 读取仍由 main 按原准入执行。 */
async function completeEmptyRemovalAuth(input: MaintenanceInput, record: MaintenanceRecord): Promise<void> {
  const roots = record.removalRoots!, directory = path.join(record.dataDir, ".shell-update-file-auth"), attempt = path.join(record.dataDir, "shell-update-attempt.json");
  assertDesktopRemovalRoots(input.location, roots);
  const before = removalStat(directory);
  if (!before) {
    if (removalStat(attempt)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_HANDOFF_AUTH_INVALID", context(record));
    return;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_INVALID", context(record));
  const names = syncFs.readdirSync(directory);
  if (names.length === 1 && names[0] === "key") {
    const key = removalStat(path.join(directory, "key"));
    if (key?.isFile() && !key.isSymbolicLink() && key.nlink === 1n && key.size === 32n) return;
  }
  if (names.length || removalStat(attempt)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_HANDOFF_AUTH_INVALID", context(record));
  await assertRecordCurrent(input.userDataDir, record); assertDesktopRemovalRoots(input.location, roots);
  const current = removalStat(directory);
  if (!current || !sameRemovalEntry(before, current) || syncFs.readdirSync(directory).length || removalStat(attempt)) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", context(record));
  }
  await fs.rmdir(directory); assertDesktopRemovalRoots(input.location, roots);
  if (removalStat(directory) || removalStat(attempt)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_REMOVE_INCOMPLETE", context(record));
}

/** 显式重开可复用同根同模式的原请求；只读选择，归属和阶段仍由原维护入口核验。 */
export async function readDesktopMaintenanceStartup(input: { userDataDir: string; installRoot: string; requestId: string; mode: MaintenanceMode; resumePending?: boolean }): Promise<
  { kind: "authorized"; record: MaintenanceRecord; location: DesktopStorageLocation } | { kind: "completed" | "pending"; record: MaintenanceRecord } | null> {
  let details: MaintenanceContext | undefined;
  try {
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(input.requestId)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_INVALID");
    const value = await readDesktopJsonFile(path.join(input.userDataDir, "desktop-uninstall-result.json"));
    if (value === null) return null;
    const record = parseRecord(value); details = context(record);
    if ((record.mode === "remove" || record.clientId === null) && record.phase === "completed") {
      const locator = path.join(input.userDataDir, "desktop-data-location.json");
      if (record.requestId !== input.requestId && !input.resumePending) return null;
      if (input.resumePending && await readDesktopJsonFile(locator) !== null) {
        if (record.requestId !== input.requestId) return null;
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
      }
      if (record.mode !== input.mode || path.relative(record.installRoot, input.installRoot) !== "") throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
      await assertRecordCurrent(input.userDataDir, record);
      if (input.resumePending && removalStat(locator)) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
      return { kind: "completed", record };
    }
    if (record.phase === "consumed") return null;
    if (record.requestId !== input.requestId && !input.resumePending || record.mode !== input.mode) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PENDING", details);
    if (input.resumePending && (record.phase === "reinstalling" || path.relative(record.installRoot, input.installRoot) !== "")) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    }
    if (record.mode === "keep" && record.clientId !== null && ["started", "data_action_authorized", "completed"].includes(record.phase)) {
      await assertRecordCurrent(input.userDataDir, record); return input.resumePending ? { kind: "pending", record } : null;
    }
    if (record.phase === "started") {
      await assertRecordCurrent(input.userDataDir, record); return input.resumePending ? { kind: "pending", record } : null;
    }
    if (record.phase !== "data_action_authorized" || path.relative(record.installRoot, input.installRoot) !== "") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    }
    const location: DesktopStorageLocation = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", installRoot: record.installRoot,
      dataDir: record.dataDir, userDataDir: input.userDataDir, clientId: record.clientId, deviceId: record.oldDeviceId };
    await verifyDesktopRemovalLocation(location, record.removalRoots!, true, record.clientId === null ? () => assertDesktopUnregisteredStorage(location) : undefined);
    assertDesktopRemovalRoots(location, record.removalRoots!);
    if (record.clientId === null) assertDesktopUnregisteredStorage(location);
    await assertRecordCurrent(input.userDataDir, record); assertDesktopRemovalRoots(location, record.removalRoots!);
    if (record.clientId === null) assertDesktopUnregisteredStorage(location);
    return { kind: "authorized", record, location };
  } catch (cause) {
    if (details) throw maintenanceFailure(cause, details, "DESKTOP_REMOVE_MAINTENANCE_FAILED");
    if (cause instanceof DesktopMaintenanceStartupError) throw cause;
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_READ_FAILED", undefined, cause);
  }
}

/** 维护及接续错误保安全关联与原始因果树，不在底层重复记日志。 */
function maintenanceFailure(cause: unknown, details: MaintenanceContext, fallback = "DESKTOP_MAINTENANCE_REINSTALL_FAILED"): DesktopMaintenanceStartupError {
  if (cause instanceof DesktopMaintenanceStartupError) return cause;
  const code = cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, "code")?.value : undefined;
  return new DesktopMaintenanceStartupError(typeof code === "string" && /^DESKTOP_[A-Z_]{1,70}$/u.test(code)
    ? code : fallback, details, cause);
}

/** 三个保留文件及缺失/空日志共用整组快照，摘要与rename前复核不分叉。 */
async function inspectRetainedFiles(record: MaintenanceRecord) {
  const details = context(record), names = { configSha256: "config.json", databaseSha256: "codeflowai.db", metadataSha256: "codeflowai.db.meta.json" } as const;
  const snapshots = new Map<string, Stats | null>(), retainedFiles = {} as NonNullable<MaintenanceRecord["retainedFiles"]>;
  for (const key of Object.keys(names) as Array<keyof typeof names>) {
    const filePath = path.join(record.dataDir, names[key]), observed = await hashRetainedFile(filePath);
    snapshots.set(filePath, observed.stat); retainedFiles[key] = observed.digest;
    if (record.retainedFiles && observed.digest !== record.retainedFiles[key]) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_DIGEST_MISMATCH", details);
  }
  for (const suffix of ["-wal", "-journal"]) {
    const filePath = path.join(record.dataDir, `codeflowai.db${suffix}`); await assertDesktopStoragePath(filePath);
    try {
      const stat = await fs.lstat(filePath);
      if (!sameFile(stat, stat) || stat.size !== 0) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_UNCHECKPOINTED_DATA", details);
      snapshots.set(filePath, stat);
    } catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw cause; snapshots.set(filePath, null); }
  }
  return { retainedFiles, async assertCurrent(): Promise<void> {
    for (const [filePath, before] of snapshots) {
      await assertDesktopStoragePath(filePath);
      let current: Stats | null;
      try { current = await fs.lstat(filePath); }
      catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw cause; current = null; }
      if (before ? !current || !sameFile(before, current) : current !== null) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_FILE_CHANGED", details);
    }
  } };
}

/** 普通单链接文件身份与内容元数据必须保持一致。 */
function sameFile(before: Stats, after: Stats): boolean {
  return before.isFile() && after.isFile() && before.nlink === 1 && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** 摘要只读取已验证句柄，不开库或解析任何秘密正文。 */
async function hashRetainedFile(filePath: string): Promise<{ digest: string; stat: Stats }> {
  await assertDesktopStoragePath(filePath);
  const before = await fs.lstat(filePath);
  if (!sameFile(before, before)) throw new Error("DESKTOP_MAINTENANCE_FILE_INVALID");
  const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    if (!sameFile(before, await file.stat())) throw new Error("DESKTOP_MAINTENANCE_FILE_CHANGED");
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("DESKTOP_MAINTENANCE_FILE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    await assertDesktopStoragePath(filePath);
    if (!sameFile(before, await file.stat()) || !sameFile(before, await fs.lstat(filePath))) throw new Error("DESKTOP_MAINTENANCE_FILE_CHANGED");
    return { digest: hash.digest("hex"), stat: before };
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_MAINTENANCE_CLOSE_FAILED") : cause; }
  }
}

/** 唯一记录必须仍为本次读到的事实，不能覆盖另一请求或阶段。 */
async function assertRecordCurrent(userDataDir: string, expected: MaintenanceRecord | null): Promise<void> {
  if (JSON.stringify(await readDesktopJsonFile(path.join(userDataDir, "desktop-uninstall-result.json"))) !== JSON.stringify(expected)) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_CHANGED", expected ? context(expected) : undefined);
  }
}

/** phase先原子落盘再授权副作用；只清本次临时文件并保关闭/清理主副因。 */
async function replaceRecord(userDataDir: string, expected: MaintenanceRecord | null, next: MaintenanceRecord, beforeReplace?: () => Promise<void>, assertBoundary?: () => void): Promise<void> {
  parseRecord(next);
  assertBoundary?.(); await assertDesktopStoragePath(userDataDir); assertBoundary?.();
  await assertRecordCurrent(userDataDir, expected); assertBoundary?.();
  const directory = await fs.lstat(userDataDir), target = path.join(userDataDir, "desktop-uninstall-result.json");
  assertBoundary?.();
  if (!directory.isDirectory()) throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", context(next));
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`, file = await fs.open(temporary, "wx", 0o600);
  let owned: Stats | undefined, closed = false, replaced = false;
  try {
    let failure: { cause: unknown } | undefined;
    try {
      assertBoundary?.(); owned = await file.stat(); assertBoundary?.();
      if (!sameFile(owned, owned)) throw new Error("DESKTOP_MAINTENANCE_FILE_INVALID");
      await file.writeFile(`${JSON.stringify(next)}\n`, "utf8"); assertBoundary?.();
      await file.sync(); assertBoundary?.(); owned = await file.stat(); assertBoundary?.();
    } catch (cause) { failure = { cause }; }
    try { await file.close(); closed = true; assertBoundary?.(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_MAINTENANCE_CLOSE_FAILED") : cause; }
    if (failure) throw failure.cause;
    await assertDesktopStoragePath(userDataDir); assertBoundary?.();
    await assertRecordCurrent(userDataDir, expected); assertBoundary?.();
    const current = await fs.lstat(userDataDir); assertBoundary?.();
    const temporaryNow = await fs.lstat(temporary); assertBoundary?.();
    if (current.dev !== directory.dev || current.ino !== directory.ino || !owned || !sameFile(owned, temporaryNow)) throw new Error("DESKTOP_MAINTENANCE_FILE_CHANGED");
    await beforeReplace?.(); assertBoundary?.();
    await assertRecordCurrent(userDataDir, expected); assertBoundary?.();
    await fs.rename(temporary, target); replaced = true; assertBoundary?.();
    await assertRecordCurrent(userDataDir, next); assertBoundary?.();
  } catch (cause) {
    if (replaced) throw cause;
    try {
      if (!closed || !owned) throw new Error("DESKTOP_MAINTENANCE_TEMP_CLEANUP_UNSAFE");
      await assertDesktopStoragePath(userDataDir); assertBoundary?.();
      const current = await fs.lstat(temporary); assertBoundary?.();
      if (owned.dev !== current.dev || owned.ino !== current.ino || !current.isFile() || current.nlink !== 1) throw new Error("DESKTOP_MAINTENANCE_TEMP_CLEANUP_UNSAFE");
      await fs.unlink(temporary); assertBoundary?.();
    } catch (cleanup) { throw new AggregateError([cause, cleanup], "DESKTOP_MAINTENANCE_CLEANUP_FAILED"); }
    throw cause;
  }
}

/** 维护拒绝保留独立诊断字段，不覆盖普通启动关联。 */
export class DesktopMaintenanceStartupError extends Error {
  readonly maintenanceRequestId?: string;
  readonly clientId?: string | null;
  readonly oldDeviceId?: string | null;
  readonly nextDeviceId?: string;
  readonly mode?: MaintenanceMode;
  readonly maintenancePhase?: MaintenancePhase;

  /** 仅复制已校验的定位信息，原始载荷不进入错误文本。 */
  constructor(readonly code: string, context?: MaintenanceContext, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "DesktopMaintenanceStartupError";
    if (context) {
      this.maintenanceRequestId = context.maintenanceRequestId; this.clientId = context.clientId; this.oldDeviceId = context.oldDeviceId;
      this.nextDeviceId = context.nextDeviceId;
      this.mode = context.mode; this.maintenancePhase = context.maintenancePhase;
    }
  }
}

/** 与原安装身份相同的 UUID v4 格式，不生成或规整未知身份。 */
function deviceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/** 稳定 Client 标识沿定位合同保留，不强制 UUID 或前缀。 */
function clientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f]/u.test(value);
}

/** 每阶段只接受当前已确定字段；未定义的未来授权载荷显式拒绝。 */
function parseRecord(value: unknown): MaintenanceRecord {
  const invalid = new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_INVALID");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.appId !== "ai.codeflow.codeflowai"
    || typeof record.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(record.requestId)
    || (record.mode !== "keep" && record.mode !== "remove") || !PHASES.includes(record.phase as MaintenancePhase)
    || typeof record.installRoot !== "string" || typeof record.dataDir !== "string"
    || !((record.clientId === null && record.oldDeviceId === null) || clientId(record.clientId) && deviceId(record.oldDeviceId))) throw invalid;
  if ([record.installRoot, record.dataDir].some(value => !path.isAbsolute(value as string) || path.resolve(value as string) !== value || /[\x00-\x1f]/u.test(value as string))) throw invalid;
  let fields = BASE_FIELDS;
  if (record.clientId === null && ["reinstalling", "consumed"].includes(record.phase as string)) throw invalid;
  if (record.phase !== "started" && record.mode === "keep" && record.clientId !== null) {
    fields = [...fields, "nextDeviceId", ...(record.phase === "consumed" ? [] : ["createdAt"])];
    if (!deviceId(record.nextDeviceId) || record.nextDeviceId.toLowerCase() === (record.oldDeviceId as string).toLowerCase()) throw invalid;
    if (record.phase !== "consumed" && (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || new Date(record.createdAt).toISOString() !== record.createdAt)) throw invalid;
    if (record.phase !== "consumed" && Object.hasOwn(record, "retainedFiles")) {
      fields = [...fields, "retainedFiles"];
      const digests = record.retainedFiles;
      const names = ["configSha256", "databaseSha256", "metadataSha256"];
      if (!digests || typeof digests !== "object" || Array.isArray(digests) || Object.keys(digests).length !== names.length
        || Object.entries(digests).some(([key, value]) => !names.includes(key) || typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))) throw invalid;
    }
  } else if (record.mode === "remove" || record.clientId === null) {
    if (record.phase === "reinstalling" || record.phase === "consumed") throw invalid;
    if (record.phase === "data_action_authorized") {
      fields = [...fields, "authorizedPaths", "removalRoots"];
      const authorized = record.authorizedPaths;
      const paths = record.clientId === null ? ["userDataDir/desktop-data-location.json"] : AUTHORIZED_PATHS;
      // 历史授权只读接续原清单；新生成文件不因升级而获得旧授权的删除权。
      const supported = record.clientId === null ? [paths] : [paths, PRE_UPDATE_AUTHORIZED_PATHS, PREVIOUS_AUTHORIZED_PATHS, LEGACY_AUTHORIZED_PATHS];
      const archiveExtended = record.clientId !== null && Array.isArray(authorized)
        && AUTHORIZED_PATHS.every(value => authorized.includes(value))
        && authorized.every(value => typeof value === "string" && (AUTHORIZED_PATHS.includes(value)
          || value.startsWith("dataDir/") && isRetiredUpdateArchive(value.slice("dataDir/".length))));
      if (!Array.isArray(authorized) || new Set(authorized).size !== authorized.length
        || !supported.some(known => authorized.length === known.length && authorized.every(value => typeof value === "string" && known.includes(value)))
          && !archiveExtended) throw invalid;
      const roots = record.removalRoots as Record<string, unknown> | null;
      if (!roots || typeof roots !== "object" || Array.isArray(roots) || Object.keys(roots).length !== 2
        || Object.keys(roots).some(key => key !== "dataDir" && key !== "userDataDir")) throw invalid;
      for (const name of ["dataDir", "userDataDir"]) {
        const root = roots[name] as Record<string, unknown> | null;
        if (!root || typeof root !== "object" || Array.isArray(root) || Object.keys(root).length !== 3
          || Object.keys(root).some(key => !["dev", "ino", "birthtimeNs"].includes(key))
          || Object.values(root).some(value => typeof value !== "string" || !/^[1-9][0-9]{0,79}$/u.test(value))) throw invalid;
      }
    }
  }
  if (Object.hasOwn(record, "rebindFromInstallRoot")) {
    const from = record.rebindFromInstallRoot;
    if (record.mode !== "keep" || record.clientId === null || !["completed", "reinstalling"].includes(record.phase as string)
      || typeof from !== "string" || !path.isAbsolute(from) || path.resolve(from) !== from || /[\x00-\x1f]/u.test(from)
      || path.relative(from, record.installRoot as string) === "") throw invalid;
    fields = [...fields, "rebindFromInstallRoot"];
  }
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))) throw invalid;
  return record as MaintenanceRecord;
}

/** 保持维护请求与普通启动请求分开，日志只投影此安全上下文。 */
function context(record: MaintenanceRecord): MaintenanceContext {
  return { maintenanceRequestId: record.requestId, clientId: record.clientId, oldDeviceId: record.oldDeviceId,
    mode: record.mode, maintenancePhase: record.phase, nextDeviceId: record.nextDeviceId };
}

/** consumed 只承认已登记的预定身份，不升级旧格式或重新创建身份。 */
async function assertConsumedIdentity(record: MaintenanceRecord, location: DesktopStorageLocation): Promise<void> {
  const details = context(record);
  if (!location.clientId || !location.deviceId || location.clientId !== record.clientId || location.deviceId !== record.nextDeviceId) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", details);
  }
  const identityPath = path.join(location.dataDir, "device-identity.json");
  const before = await readDesktopJsonFile(identityPath);
  const identity = await readDeviceIdentity(location.dataDir);
  const after = await readDesktopJsonFile(identityPath);
  if (identity.deviceId !== record.nextDeviceId || before === null || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", details);
  }
}

/** 同锁普通启动只消费准入事实，不写阶段、不创建业务目录或执行维护。 */
export async function assertDesktopMaintenanceStartup(input: { userDataDir: string; location: DesktopStorageLocation }): Promise<void> {
  let details: MaintenanceContext | undefined;
  try {
    const { userDataDir, location } = input;
    await assertDesktopStoragePath(userDataDir);
    if (path.relative(userDataDir, location.userDataDir) !== "") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH");
    }
    const recordPath = path.join(userDataDir, "desktop-uninstall-result.json");
    const value = await readDesktopJsonFile(recordPath);
    if (value === null) return;
    const record = parseRecord(value); details = context(record);
    if ((record.mode === "remove" || record.clientId === null) && record.phase === "completed") {
      if (JSON.stringify(await readDesktopJsonFile(recordPath)) !== JSON.stringify(value)) {
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_CHANGED", details);
      }
      return;
    }
    await assertDesktopStoragePath(record.installRoot); await assertDesktopStoragePath(record.dataDir);
    if (path.relative(location.installRoot, record.installRoot) !== "" || path.relative(location.dataDir, record.dataDir) !== "") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_CONTEXT_MISMATCH", details);
    }
    if (record.phase === "consumed") {
      await assertConsumedIdentity(record, location);
      if (JSON.stringify(await readDesktopJsonFile(recordPath)) !== JSON.stringify(value)) {
        throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_RECORD_CHANGED", details);
      }
      return;
    }
    if (record.mode === "keep" && record.phase !== "started") {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_REINSTALL_NOT_READY", details);
    }
    if ((location.clientId !== null && location.clientId !== record.clientId)
      || (location.deviceId !== null && location.deviceId !== record.oldDeviceId)) {
      throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_OWNERSHIP_MISMATCH", details);
    }
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_PENDING", details);
  } catch (cause) {
    if (cause instanceof DesktopMaintenanceStartupError) throw cause;
    throw new DesktopMaintenanceStartupError("DESKTOP_MAINTENANCE_READ_FAILED", details, cause);
  }
}
