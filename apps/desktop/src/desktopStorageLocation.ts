import fs from "node:fs/promises";
import syncFs from "node:fs";
import { constants, type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readDeviceIdentity } from "./deviceIdentity.js";

const APP_ID = "ai.codeflow.codeflowai";
const LOCATOR = "desktop-data-location.json";
const FIELDS = ["schemaVersion", "appId", "installRoot", "dataDir", "clientId", "deviceId"];
export type DesktopStorageLocation = Readonly<{
  schemaVersion: 1; appId: typeof APP_ID; installRoot: string; dataDir: string;
  clientId: string | null; deviceId: string | null; userDataDir: string;
}>;
export type DesktopReinstallAuthorization = { clientId: string; oldDeviceId: string; nextDeviceId: string; createdAt: string };
export type DesktopRemovalRoots = Readonly<{
  dataDir: Readonly<{ dev: string; ino: string; birthtimeNs: string }>;
  userDataDir: Readonly<{ dev: string; ino: string; birthtimeNs: string }>;
}>;

/** 固定短码保留原因，调用方在唯一启动边界记录日志。 */
function fail(code: string, cause?: unknown): never {
  throw Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}

/** 比较同一普通文件；读取期间还核内容元数据，拒绝替换或截断。 */
function sameFile(a: Stats, b: Stats, content = true): boolean {
  return a.isFile() && b.isFile() && a.nlink === 1 && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino
    && (!content || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}

/** 只读核每级真实路径；允许尚不存在的尾段，但不创建或跟随链接。 */
export async function assertDesktopStoragePath(target: string): Promise<void> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || /[\x00-\x1f]/u.test(target)) fail("DESKTOP_STORAGE_PATH_INVALID");
  const root = path.parse(target).root;
  let current = root;
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index <= parts.length; index++) {
    if (index) current = path.join(current, parts[index - 1]!);
    let entry: Stats;
    try { entry = await fs.lstat(current); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
    if (entry.isSymbolicLink() || (index < parts.length && !entry.isDirectory())) fail("DESKTOP_STORAGE_PATH_INVALID");
    const real = await fs.lstat(await fs.realpath(current));
    if (entry.dev !== real.dev || entry.ino !== real.ino) fail("DESKTOP_STORAGE_PATH_INVALID");
  }
}

/** 固定 JSON 边界只将缺文件视为无记录，编码、链接、关闭错误均明确失败。 */
export async function readDesktopJsonFile(filePath: string): Promise<unknown | null> {
  await assertDesktopStoragePath(filePath);
  let before: Stats;
  try { before = await fs.lstat(filePath); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  if (!sameFile(before, before) || before.size > 1024 * 1024) fail("DESKTOP_STORAGE_FILE_INVALID");
  const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    const opened = await file.stat();
    if (!sameFile(before, opened)) fail("DESKTOP_STORAGE_FILE_CHANGED");
    const bytes = await file.readFile();
    if (bytes.length > 1024 * 1024 || !sameFile(opened, await file.stat())) fail("DESKTOP_STORAGE_FILE_CHANGED");
    await assertDesktopStoragePath(filePath);
    if (!sameFile(opened, await fs.lstat(filePath))) fail("DESKTOP_STORAGE_FILE_CHANGED");
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("DESKTOP_STORAGE_JSON_INVALID");
      return parsed;
    }
    catch (cause) { fail("DESKTOP_STORAGE_JSON_INVALID", cause); }
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
  }
}

/** 客户端标识沿原配置合同接受非空字符串，不强制 UUID。 */
function clientId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && !/[\x00-\x1f]/u.test(value);
}

/** 定位文件只接受六项事实，不从环境或未知字段补齐身份。 */
function parseLocator(value: unknown, userDataDir: string): DesktopStorageLocation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== FIELDS.length
    || Object.keys(value).some(key => !FIELDS.includes(key))) fail("DESKTOP_STORAGE_LOCATION_INVALID");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.appId !== APP_ID || typeof record.installRoot !== "string" || typeof record.dataDir !== "string"
    || !((record.clientId === null && record.deviceId === null) || (clientId(record.clientId) && typeof record.deviceId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.deviceId)))) fail("DESKTOP_STORAGE_LOCATION_INVALID");
  return Object.freeze({ ...record, userDataDir }) as DesktopStorageLocation;
}

/** 持久载荷不包含进程内的 userData 上下文。 */
function payload(location: DesktopStorageLocation): Record<string, unknown> {
  return { schemaVersion: location.schemaVersion, appId: location.appId, installRoot: location.installRoot, dataDir: location.dataDir,
    clientId: location.clientId, deviceId: location.deviceId };
}

/** 相对路径比较覆盖 Windows 大小写，同时拒绝祖先交叠。 */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 用最近真实祖先展开 Windows 短名；不存在的尾段无需创建。 */
async function physicalPath(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = path.dirname(current);
      if (parent === current) throw cause;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

/** 数据目标不能覆盖安装、用户根或工程知识边界；默认 userData/runtime 保持合法。 */
async function assertLocation(location: DesktopStorageLocation): Promise<void> {
  const { installRoot, dataDir, userDataDir } = location;
  await assertDesktopStoragePath(userDataDir); await assertDesktopStoragePath(installRoot); await assertDesktopStoragePath(dataDir);
  const data = await physicalPath(dataDir), install = await physicalPath(installRoot), profile = await physicalPath(userDataDir);
  if (data === path.parse(data).root || contains(data, await physicalPath(os.homedir())) || contains(data, profile)
    || contains(data, install) || contains(install, data)
    || data.split(path.sep).some(part => part.toLowerCase() === ".codeflow")) fail("DESKTOP_STORAGE_PATH_INVALID");
  try { await fs.lstat(path.join(data, ".codeflow")); fail("DESKTOP_STORAGE_PATH_INVALID"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
}

/** 同锁只读选择定位；无定位时仅接受空应用目录或保留的默认工作区。 */
export async function resolveDesktopStorageLocation(input: { userDataDir: string; installRoot: string; configuredDataDir?: string; allowInstallRootChange?: boolean }): Promise<DesktopStorageLocation> {
  const userDataDir = path.resolve(input.userDataDir), installRoot = path.resolve(input.installRoot);
  const configured = input.configuredDataDir;
  if (configured !== undefined && (!configured.trim() || !path.isAbsolute(configured))) fail("DESKTOP_STORAGE_PATH_INVALID");
  const record = await readDesktopJsonFile(path.join(userDataDir, LOCATOR));
  const location = record === null ? parseLocator({ schemaVersion: 1, appId: APP_ID, installRoot,
    dataDir: configured ? path.resolve(configured) : path.join(userDataDir, "runtime"), clientId: null, deviceId: null }, userDataDir) : parseLocator(record, userDataDir);
  if (record !== null && configured && path.relative(location.dataDir, path.resolve(configured)) !== ""
    && location.clientId === null && location.deviceId === null && path.relative(location.installRoot, installRoot) === ""
    && path.relative(location.dataDir, path.join(userDataDir, "runtime")) === "") {
    const selected = Object.freeze({ ...location, dataDir: path.resolve(configured) });
    await assertLocation(location); await assertLocation(selected);
    assertDesktopEmptyStorage(location, true); assertDesktopEmptyStorage(selected, true);
    return selected;
  }
  const installRootChanged = path.relative(location.installRoot, installRoot) !== "";
  if ((installRootChanged && !input.allowInstallRootChange) || (configured && path.relative(location.dataDir, path.resolve(configured)) !== "")) {
    fail("DESKTOP_STORAGE_LOCATION_CONFLICT");
  }
  // macOS 应用被移动或由 Gatekeeper 转译后路径会变化；只放宽安装根，数据目录与身份仍严格保持。
  const selectedLocation = installRootChanged ? Object.freeze({ ...location, installRoot }) : location;
  await assertLocation(selectedLocation);
  if (record === null) {
    try {
      const names = await fs.readdir(selectedLocation.dataDir);
      if (names.some(name => name !== "workspace")) fail("DESKTOP_STORAGE_LOCATION_REQUIRED");
      if (names.length) assertDesktopEmptyStorage(selectedLocation);
    }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  return selectedLocation;
}

/** macOS 移动 .app 后只把定位安装根改绑到当前包根；数据目录、身份与其他字段不得变化。 */
export async function rebindDesktopInstallRoot(location: DesktopStorageLocation): Promise<void> {
  const current = await readDesktopJsonFile(path.join(location.userDataDir, LOCATOR));
  // 首次启动尚无定位文件，随后由 persistDesktopStorageLocation 按当前根创建。
  if (current === null) return;
  const previous = parseLocator(current, location.userDataDir);
  if (path.relative(previous.installRoot, location.installRoot) === "") return;
  if (FIELDS.filter(key => key !== "installRoot").some(key => payload(previous)[key] !== payload(location)[key])) {
    fail("DESKTOP_STORAGE_LOCATION_CHANGED");
  }
  await assertLocation(location);
  await writeLocator(previous, location, false);
  await assertExpected(location, false);
}

/** 双 null 时必须无应用数据；仅保留普通默认工作区目录，不遍历或删除项目。 */
export function assertDesktopEmptyStorage(location: DesktopStorageLocation, allowMissing = false): void {
  if (location.clientId !== null || location.deviceId !== null) fail("DESKTOP_STORAGE_EMPTY_REQUIRED");
  let stat: BigIntStats;
  try { stat = syncFs.lstatSync(location.dataDir, { bigint: true }); }
  catch (cause) { if (allowMissing && (cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return; throw cause; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DESKTOP_STORAGE_EMPTY_REQUIRED");
  removalRoot(location.dataDir);
  const names = syncFs.readdirSync(location.dataDir);
  if (names.some(name => name !== "workspace")) fail("DESKTOP_STORAGE_EMPTY_REQUIRED");
  if (names.length) {
    const workspace = syncFs.lstatSync(path.join(location.dataDir, "workspace"));
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) fail("DESKTOP_STORAGE_EMPTY_REQUIRED");
  }
}

/** 安装仅登记同一六字段定位；门禁先于目录与文件写入，既有 custom 原样返回。 */
export async function registerDesktopInstallation(input: { userDataDir: string; installRoot: string;
  beforePersist?: (location: DesktopStorageLocation) => Promise<void> }): Promise<DesktopStorageLocation> {
  const userDataDir = path.resolve(input.userDataDir), installRoot = path.resolve(input.installRoot);
  const current = await readDesktopJsonFile(path.join(userDataDir, LOCATOR));
  const location = current === null ? parseLocator({ schemaVersion: 1, appId: APP_ID, installRoot,
    dataDir: path.join(userDataDir, "runtime"), clientId: null, deviceId: null }, userDataDir) : parseLocator(current, userDataDir);
  await assertLocation(location);
  if (input.beforePersist) await input.beforePersist(location);
  else if (await readDesktopJsonFile(path.join(userDataDir, "desktop-uninstall-result.json")) !== null) fail("DESKTOP_STORAGE_LOCATION_REQUIRED");
  if (current !== null) { await assertExpected(location, false); return location; }
  assertDesktopEmptyStorage(location, true);
  await fs.mkdir(userDataDir, { recursive: true }); assertDesktopEmptyStorage(location, true);
  await assertDesktopStoragePath(userDataDir); assertDesktopEmptyStorage(location, true);
  await fs.mkdir(location.dataDir, { recursive: true }); assertDesktopEmptyStorage(location);
  await assertLocation(location); assertDesktopEmptyStorage(location);
  await writeLocator(location, location, true, () => assertDesktopEmptyStorage(location));
  assertDesktopEmptyStorage(location); return location;
}

/** 根重绑只改 installRoot，Record 回调负责唯一 keep 授权和写序。 */
export async function rebindDesktopStorageLocation(expected: DesktopStorageLocation, next: DesktopStorageLocation,
  beforeReplace: () => Promise<void>): Promise<void> {
  if (!expected.clientId || !expected.deviceId || FIELDS.filter(key => key !== "installRoot").some(key => payload(expected)[key] !== payload(next)[key])
    || path.relative(expected.userDataDir, next.userDataDir) !== "") fail("DESKTOP_STORAGE_LOCATION_CHANGED");
  const roots = await inspectDesktopRemovalRoots(expected); await assertLocation(next); assertDesktopRemovalRoots(expected, roots);
  await writeLocator(expected, next, false, () => assertDesktopRemovalRoots(expected, roots), beforeReplace);
  assertDesktopRemovalRoots(next, roots);
}

/** 核待替换定位与本次读取事实一致，防止异步期间接管另一归属。 */
async function assertExpected(location: DesktopStorageLocation, allowMissing: boolean): Promise<void> {
  const current = await readDesktopJsonFile(path.join(location.userDataDir, LOCATOR));
  if (current === null) { if (allowMissing) return; fail("DESKTOP_STORAGE_LOCATION_CHANGED"); }
  const parsed = parseLocator(current, location.userDataDir);
  if (FIELDS.some(key => payload(parsed)[key] !== payload(location)[key])) fail("DESKTOP_STORAGE_LOCATION_CHANGED");
}

/** 删除期间根内容可变；只接受现存普通物理目录及其稳定 bigint 身份。 */
function removalRoot(directory: string): DesktopRemovalRoots["dataDir"] {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || /[\x00-\x1f]/u.test(directory)) fail("DESKTOP_STORAGE_PATH_INVALID");
  let identity: BigIntStats | undefined;
  for (let current = directory; ; current = path.dirname(current)) {
    const entry = syncFs.lstatSync(current, { bigint: true });
    const real = syncFs.lstatSync(syncFs.realpathSync.native(current), { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== real.dev || entry.ino !== real.ino) fail("DESKTOP_STORAGE_PATH_INVALID");
    identity ??= entry;
    if (path.dirname(current) === current) break;
  }
  const root = { dev: identity!.dev.toString(), ino: identity!.ino.toString(), birthtimeNs: identity!.birthtimeNs.toString() };
  if (Object.values(root).some(value => !/^[1-9][0-9]{0,79}$/u.test(value))) fail("DESKTOP_STORAGE_REMOVAL_ROOT_INVALID");
  return Object.freeze(root);
}

/** 同一授权内每个异步边界同步重核祖先和两根，避免只凭原路径继续删除。 */
export function assertDesktopRemovalRoots(location: DesktopStorageLocation, roots: DesktopRemovalRoots): void {
  if (!roots || typeof roots !== "object" || Array.isArray(roots) || Object.keys(roots).length !== 2
    || Object.keys(roots).some(key => key !== "dataDir" && key !== "userDataDir")) fail("DESKTOP_STORAGE_REMOVAL_ROOT_INVALID");
  for (const name of ["dataDir", "userDataDir"] as const) {
    const expected = roots[name], fields = ["dev", "ino", "birthtimeNs"] as const;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length !== fields.length
      || Object.keys(expected).some(key => !fields.includes(key as typeof fields[number]))
      || fields.some(key => typeof expected[key] !== "string" || !/^[1-9][0-9]{0,79}$/u.test(expected[key]))) fail("DESKTOP_STORAGE_REMOVAL_ROOT_INVALID");
    const current = removalRoot(location[name]);
    if (fields.some(key => current[key] !== expected[key])) fail("DESKTOP_STORAGE_REMOVAL_ROOT_CHANGED");
  }
}

/** 只取应用和 profile 两根事实，不创建目录或读取应用数据库。 */
export async function inspectDesktopRemovalRoots(location: DesktopStorageLocation): Promise<DesktopRemovalRoots> {
  const roots = Object.freeze({ dataDir: removalRoot(location.dataDir), userDataDir: removalRoot(location.userDataDir) });
  await assertLocation(location); assertDesktopRemovalRoots(location, roots);
  return roots;
}

/** 只有目标本身缺失可表示已删；权限、链接及其他 I/O 故障均明确失败。 */
function removalEntry(target: string): BigIntStats | undefined {
  try { return syncFs.lstatSync(target, { bigint: true }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined; throw cause; }
}

/** 捕获 rename 只允许 ctime 改变，仍绑定单链普通文件、实体、长度和 mtime。 */
function sameRemovalFile(before: BigIntStats, after: BigIntStats, compareChangeTime = true): boolean {
  return before.isFile() && after.isFile() && !before.isSymbolicLink() && !after.isSymbolicLink() && before.nlink === 1n && after.nlink === 1n
    && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs
    && (!compareChangeTime || before.ctimeNs === after.ctimeNs);
}

/** 沿原六字段合同读同一文件；句柄、路径、根与调用方边界每次异步返回仍一致。 */
async function readRemovalLocator(file: FileHandle, target: string, before: BigIntStats, location: DesktopStorageLocation,
  roots: DesktopRemovalRoots, assertBoundary?: () => void): Promise<void> {
  /** 根与内容约束同步复核，不引入新的异步空隙。 */
  const guard = (): void => { assertDesktopRemovalRoots(location, roots); assertBoundary?.(); };
  guard(); const opened = await file.stat({ bigint: true }); guard();
  if (!sameRemovalFile(before, opened) || before.size > 1024n * 1024n) fail("DESKTOP_STORAGE_FILE_CHANGED");
  const bytes = Buffer.alloc(Number(before.size));
  for (let offset = 0; offset < bytes.length;) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset); guard();
    if (!result.bytesRead) fail("DESKTOP_STORAGE_FILE_CHANGED");
    offset += result.bytesRead;
  }
  const after = await file.stat({ bigint: true }); guard();
  const pathname = removalEntry(target);
  if (bytes.length > 1024 * 1024 || !sameRemovalFile(before, after) || !pathname || !sameRemovalFile(before, pathname)) fail("DESKTOP_STORAGE_FILE_CHANGED");
  let parsed: DesktopStorageLocation;
  try { parsed = parseLocator(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), location.userDataDir); }
  catch (cause) { fail("DESKTOP_STORAGE_LOCATION_INVALID", cause); }
  if (FIELDS.some(key => payload(parsed)[key] !== payload(location)[key])) fail("DESKTOP_STORAGE_LOCATION_CHANGED");
}

/** 授权重入核原定位、物理根和可选内容边界；缺 locator 须由同请求授权显式允许。 */
export async function verifyDesktopRemovalLocation(location: DesktopStorageLocation, roots: DesktopRemovalRoots,
  allowMissingLocator: boolean, assertBoundary?: () => void): Promise<void> {
  /** 校验期间的额外内容约束与物理根使用相同同步边界。 */
  const guard = (): void => { assertDesktopRemovalRoots(location, roots); assertBoundary?.(); };
  guard(); await assertLocation(location); guard();
  const target = path.join(location.userDataDir, LOCATOR), before = removalEntry(target);
  if (!before) { if (!allowMissingLocator) fail("DESKTOP_STORAGE_LOCATION_CHANGED"); return; }
  if (!sameRemovalFile(before, before)) fail("DESKTOP_STORAGE_FILE_INVALID");
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try { guard(); await readRemovalLocator(file, target, before, location, roots, assertBoundary); guard(); }
  catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); guard(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
  }
}

/** 只删本请求旧 locator；每个异步边界和破坏操作前同步核根及可选内容约束。 */
export async function removeDesktopStorageLocation(location: DesktopStorageLocation, roots: DesktopRemovalRoots,
  requestId: string, assertBoundary?: () => void): Promise<void> {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(requestId)) fail("DESKTOP_STORAGE_REMOVAL_REQUEST_INVALID");
  /** 调用方约束必须持续成立，不能只在删除入口检查一次。 */
  const guard = (): void => { assertDesktopRemovalRoots(location, roots); assertBoundary?.(); };
  guard(); await assertLocation(location); guard();
  const target = path.join(location.userDataDir, LOCATOR), requestHash = crypto.createHash("sha256").update(requestId).digest("hex");
  const prefix = `${LOCATOR}.removing-${requestHash}-`;
  /** family 不接管其他临时项；唯一规范捕获才允许同请求重入。 */
  const readCapture = (): string | undefined => {
    guard();
    const names = syncFs.readdirSync(location.userDataDir).filter(name => name.toLowerCase().startsWith(`${LOCATOR}.`));
    if (names.length > 1 || names.some(name => !name.startsWith(prefix) || !name.endsWith(".tmp")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name.slice(prefix.length, -4)))) fail("DESKTOP_STORAGE_LOCATOR_CAPTURE_CONFLICT");
    return names.length ? path.join(location.userDataDir, names[0]!) : undefined;
  };
  let capture = readCapture();
  const standard = removalEntry(target);
  if (capture && standard) fail("DESKTOP_STORAGE_LOCATOR_CAPTURE_CONFLICT");
  const source = capture ?? target, before = capture ? removalEntry(capture) : standard;
  if (!before) {
    guard();
    if (capture || removalEntry(target) || readCapture()) fail("DESKTOP_STORAGE_FILE_CHANGED");
    return;
  }
  if (!sameRemovalFile(before, before)) fail("DESKTOP_STORAGE_FILE_INVALID");
  const file = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    guard(); await readRemovalLocator(file, source, before, location, roots, assertBoundary); guard();
    if (!capture) {
      if (readCapture()) fail("DESKTOP_STORAGE_LOCATOR_CAPTURE_CONFLICT");
      capture = path.join(location.userDataDir, `${prefix}${crypto.randomUUID()}.tmp`);
      if (removalEntry(capture)) fail("DESKTOP_STORAGE_LOCATOR_CAPTURE_CONFLICT");
      guard(); await fs.rename(target, capture); guard();
    }
    const opened = await file.stat({ bigint: true }); guard();
    const captured = removalEntry(capture);
    if (!captured || !sameRemovalFile(before, captured, false) || !sameRemovalFile(captured, opened)) fail("DESKTOP_STORAGE_FILE_CHANGED");
    await readRemovalLocator(file, capture, captured, location, roots, assertBoundary); guard();
    const finalOpened = await file.stat({ bigint: true }); guard();
    const current = removalEntry(capture);
    if (!current || !sameRemovalFile(captured, current) || !sameRemovalFile(captured, finalOpened)) fail("DESKTOP_STORAGE_FILE_CHANGED");
    if (removalEntry(target) || readCapture() !== capture) fail("DESKTOP_STORAGE_LOCATOR_CAPTURE_CONFLICT");
    guard(); await fs.unlink(capture); guard();
    if (removalEntry(capture) || removalEntry(target) || readCapture()) fail("DESKTOP_STORAGE_LOCATOR_REMOVE_INCOMPLETE");
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); guard(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
  }
}

/** 单锁原子替换；仅清理本次独占临时文件，主因、关闭和清理失败全部保留。 */
async function writeLocator(expected: DesktopStorageLocation, next: DesktopStorageLocation, allowMissing: boolean,
  assertBoundary?: () => void, beforeReplace?: () => Promise<void>): Promise<void> {
  assertBoundary?.();
  await assertLocation(expected);
  assertBoundary?.();
  await assertExpected(expected, allowMissing);
  assertBoundary?.();
  const directoryBefore = await fs.lstat(expected.userDataDir);
  assertBoundary?.();
  if (!directoryBefore.isDirectory()) fail("DESKTOP_STORAGE_PATH_INVALID");
  const temporaryPath = path.join(expected.userDataDir, `${LOCATOR}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let owned: Stats | undefined, closed = false, replaced = false;
  const file = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let failure: { cause: unknown } | undefined;
    try {
      assertBoundary?.(); owned = await file.stat(); assertBoundary?.();
      if (!sameFile(owned, owned)) fail("DESKTOP_STORAGE_FILE_INVALID");
      await file.writeFile(`${JSON.stringify(payload(next))}\n`, "utf8"); assertBoundary?.();
      await file.sync(); assertBoundary?.();
      owned = await file.stat(); assertBoundary?.();
    } catch (cause) { failure = { cause }; }
    try { await file.close(); closed = true; assertBoundary?.(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
    if (failure) throw failure.cause;
    await assertLocation(expected); assertBoundary?.();
    const directoryNow = await fs.lstat(expected.userDataDir); assertBoundary?.();
    if (directoryBefore.dev !== directoryNow.dev || directoryBefore.ino !== directoryNow.ino) fail("DESKTOP_STORAGE_PATH_CHANGED");
    await assertExpected(expected, allowMissing); assertBoundary?.();
    const temporaryNow = await fs.lstat(temporaryPath); assertBoundary?.();
    if (!owned || !sameFile(owned, temporaryNow)) fail("DESKTOP_STORAGE_FILE_CHANGED");
    await beforeReplace?.(); assertBoundary?.();
    await assertExpected(expected, allowMissing); assertBoundary?.();
    await fs.rename(temporaryPath, path.join(expected.userDataDir, LOCATOR)); replaced = true; assertBoundary?.();
    await assertExpected(next, false); assertBoundary?.();
  } catch (cause) {
    if (replaced) throw cause;
    try {
      if (!closed || !owned) fail("DESKTOP_STORAGE_TEMP_CLEANUP_UNSAFE");
      await assertDesktopStoragePath(expected.userDataDir);
      if (!sameFile(owned, await fs.lstat(temporaryPath), false)) fail("DESKTOP_STORAGE_TEMP_CLEANUP_UNSAFE");
      await fs.unlink(temporaryPath);
    } catch (cleanup) { throw new AggregateError([cause, cleanup], "DESKTOP_STORAGE_TEMP_CLEANUP_FAILED"); }
    throw cause;
  }
}

/** 首次初始化前固化双 null；已有相同定位不重复写。 */
export async function persistDesktopStorageLocation(location: DesktopStorageLocation): Promise<void> {
  await assertLocation(location);
  const current = await readDesktopJsonFile(path.join(location.userDataDir, LOCATOR));
  if (current !== null) {
    const previous = parseLocator(current, location.userDataDir);
    if (previous.clientId === null && previous.deviceId === null && location.clientId === null && location.deviceId === null
      && path.relative(previous.installRoot, location.installRoot) === "" && path.relative(previous.dataDir, path.join(location.userDataDir, "runtime")) === ""
      && path.relative(previous.dataDir, location.dataDir) !== "") {
      const assertEmpty = () => { assertDesktopEmptyStorage(previous, true); assertDesktopEmptyStorage(location, true); };
      assertEmpty(); await writeLocator(previous, location, false, assertEmpty); return;
    }
    await assertExpected(location, false); return;
  }
  if (location.clientId !== null || location.deviceId !== null) fail("DESKTOP_STORAGE_LOCATION_CHANGED");
  await writeLocator(location, location, true);
}

/** 普通文件缺失有明确语义，链接及其他读取失败不能伪装缺失。 */
async function optionalFile(filePath: string): Promise<Stats | null> {
  await assertDesktopStoragePath(filePath);
  try {
    const entry = await fs.lstat(filePath);
    if (!sameFile(entry, entry)) fail("DESKTOP_STORAGE_FILE_INVALID");
    return entry;
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
}

/** 只从已验证的原文件句柄流式复制；源变化和关闭双错均中止快照。 */
async function copySnapshotFile(source: string, target: string, before: Stats): Promise<void> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    if (!sameFile(before, await input.stat())) fail("DESKTOP_STORAGE_FILE_CHANGED");
    const output = await fs.open(target, "wx", 0o600);
    let copyFailure: { cause: unknown } | undefined;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) fail("DESKTOP_STORAGE_FILE_CHANGED");
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) fail("DESKTOP_STORAGE_SNAPSHOT_WRITE_FAILED");
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      if (!sameFile(before, await input.stat())) fail("DESKTOP_STORAGE_FILE_CHANGED");
    } catch (cause) { copyFailure = { cause }; throw cause; }
    finally {
      try { await output.close(); }
      catch (cause) { throw copyFailure ? new AggregateError([copyFailure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
    }
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await input.close(); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
  }
}

/** SQLite 只打开独占临时副本，避免 readOnly 在真实目录创建或写入 WAL/SHM。 */
async function readDatabaseClientId(dataDir: string): Promise<unknown> {
  const source = path.join(dataDir, "codeflowai.db"), before = await optionalFile(source), wal = await optionalFile(`${source}-wal`);
  if (!before) fail("DESKTOP_STORAGE_DB_NOT_READY");
  await optionalFile(`${source}-shm`);
  const temporaryRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "codeflow-storage-check-"));
  let failure: { cause: unknown } | undefined;
  try {
    const snapshot = path.join(temporaryRoot, "codeflowai.db");
    await copySnapshotFile(source, snapshot, before);
    if (wal) await copySnapshotFile(`${source}-wal`, `${snapshot}-wal`, wal);
    const assertSource = async (): Promise<void> => {
      const current = await optionalFile(source), currentWal = await optionalFile(`${source}-wal`);
      if (!current || !sameFile(before, current) || (wal ? !currentWal || !sameFile(wal, currentWal) : currentWal !== null)) fail("DESKTOP_STORAGE_FILE_CHANGED");
    };
    await assertSource();
    const db = new DatabaseSync(snapshot, { readOnly: true });
    let queryFailure: { cause: unknown } | undefined;
    let result: unknown;
    try { result = db.prepare("SELECT value FROM meta WHERE key = ?").get("client_id")?.value; }
    catch (cause) { queryFailure = { cause }; throw cause; }
    finally {
      try { db.close(); }
      catch (cause) { throw queryFailure ? new AggregateError([queryFailure.cause, cause], "DESKTOP_STORAGE_DB_CLOSE_FAILED") : cause; }
    }
    await assertSource();
    return result;
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await fs.rm(temporaryRoot, { recursive: true }); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_SNAPSHOT_CLEANUP_FAILED") : cause; }
  }
}

/** 固定配置与ready库共用唯一事实读取；调用方在身份读取后再核同组内容。 */
async function inspectPersistentOwnership(location: DesktopStorageLocation): Promise<{ clientId: string; assertCurrent(): Promise<void> }> {
  await assertLocation(location); await assertExpected(location, false);
  const config = await readDesktopJsonFile(path.join(location.dataDir, "config.json"));
  const meta = await readDesktopJsonFile(path.join(location.dataDir, "codeflowai.db.meta.json"));
  const configStat = await fs.lstat(path.join(location.dataDir, "config.json"));
  const metaStat = await fs.lstat(path.join(location.dataDir, "codeflowai.db.meta.json"));
  if (!config || typeof config !== "object" || Array.isArray(config) || !clientId((config as Record<string, unknown>).clientId)) fail("DESKTOP_STORAGE_CONFIG_INVALID");
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) fail("DESKTOP_STORAGE_DB_NOT_READY");
  const metadata = meta as Record<string, unknown>;
  if (metadata.schemaVersion !== 3 || metadata.storageMode !== "plain_sqlite" || metadata.ownership !== "local_os_user"
    || metadata.initializationState !== "ready" || Object.hasOwn(metadata, "accountNamespace")) fail("DESKTOP_STORAGE_DB_NOT_READY");
  const stableClientId = (config as { clientId: string }).clientId;
  const databaseClientId = await readDatabaseClientId(location.dataDir);
  if (stableClientId !== databaseClientId) fail("DESKTOP_STORAGE_OWNERSHIP_CONFLICT");
  return { clientId: stableClientId, async assertCurrent() {
    if (!sameFile(configStat, await fs.lstat(path.join(location.dataDir, "config.json")))
      || !sameFile(metaStat, await fs.lstat(path.join(location.dataDir, "codeflowai.db.meta.json")))
      || JSON.stringify(config) !== JSON.stringify(await readDesktopJsonFile(path.join(location.dataDir, "config.json")))
      || JSON.stringify(meta) !== JSON.stringify(await readDesktopJsonFile(path.join(location.dataDir, "codeflowai.db.meta.json")))) fail("DESKTOP_STORAGE_FILE_CHANGED");
    await assertExpected(location, false);
  } };
}

/** 沿原签名身份只读入口核验，路径和文件身份变化均明确失败。 */
async function verifiedIdentity(dataDir: string): Promise<Awaited<ReturnType<typeof readDeviceIdentity>>> {
  const filePath = path.join(dataDir, "device-identity.json"), before = await optionalFile(filePath);
  if (!before) fail("DESKTOP_DEVICE_IDENTITY_MISSING");
  const identity = await readDeviceIdentity(dataDir);
  await assertDesktopStoragePath(filePath);
  if (!sameFile(before, await fs.lstat(filePath))) fail("DESKTOP_STORAGE_FILE_CHANGED");
  return identity;
}

/** ready 归属只取实际持久事实；已有完整定位必须逐项保持一致。 */
export async function verifyDesktopStorageLocation(location: DesktopStorageLocation, envClientId?: string): Promise<DesktopStorageLocation> {
  const facts = await inspectPersistentOwnership(location), identity = await verifiedIdentity(location.dataDir);
  if ((envClientId?.trim() && envClientId.trim() !== facts.clientId) || (location.clientId !== null && location.clientId !== facts.clientId)
    || (location.deviceId !== null && location.deviceId !== identity.deviceId)) fail("DESKTOP_STORAGE_OWNERSHIP_CONFLICT");
  await facts.assertCurrent();
  await assertExpected(location, false);
  return Object.freeze({ ...location, clientId: facts.clientId, deviceId: identity.deviceId });
}

/** 原 application ready 后才补归属；验证失败不触碰定位或业务数据。 */
export async function completeDesktopStorageLocation(location: DesktopStorageLocation, envClientId?: string): Promise<DesktopStorageLocation> {
  const completed = await verifyDesktopStorageLocation(location, envClientId);
  if (location.clientId === null) await writeLocator(location, completed, false);
  return completed;
}

/** 授权只允许当前完整old/next定位，首个await前复制并拒绝访问器。 */
function reinstallAuthorization(location: DesktopStorageLocation, input: DesktopReinstallAuthorization): DesktopReinstallAuthorization {
  const fields = ["clientId", "oldDeviceId", "nextDeviceId", "createdAt"];
  if (!input || typeof input !== "object" || Reflect.ownKeys(input).length !== fields.length) fail("DESKTOP_REINSTALL_AUTHORIZATION_INVALID");
  const values = fields.map(field => {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") fail("DESKTOP_REINSTALL_AUTHORIZATION_INVALID");
    return descriptor.value as string;
  });
  const [client, old, next, created] = values as [string, string, string, string];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!clientId(client) || !uuid.test(old) || !uuid.test(next) || old.toLowerCase() === next.toLowerCase()
    || !Number.isFinite(Date.parse(created)) || new Date(created).toISOString() !== created
    || location.clientId !== client || (location.deviceId !== old && location.deviceId !== next)) fail("DESKTOP_REINSTALL_AUTHORIZATION_INVALID");
  return { clientId: client, oldDeviceId: old, nextDeviceId: next, createdAt: created };
}

/** 接续前只核已有数据与缺失/预定next身份，不因此创建身份或修改定位。 */
export async function verifyDesktopReinstallStorage(location: DesktopStorageLocation, input: DesktopReinstallAuthorization): Promise<void> {
  const authorization = reinstallAuthorization(location, input), facts = await inspectPersistentOwnership(location);
  if (facts.clientId !== authorization.clientId) fail("DESKTOP_STORAGE_OWNERSHIP_CONFLICT");
  if (await optionalFile(path.join(location.dataDir, "device-identity.json"))) {
    const identity = await verifiedIdentity(location.dataDir);
    if (identity.deviceId !== authorization.nextDeviceId || identity.createdAt !== authorization.createdAt) fail("DESKTOP_REINSTALL_IDENTITY_CONFLICT");
  }
  await facts.assertCurrent();
}

/** 接续后仍沿固定定位事实回填，不提供任意路径setter。 */
export async function completeDesktopReinstallLocation(location: DesktopStorageLocation, input: DesktopReinstallAuthorization): Promise<DesktopStorageLocation> {
  const authorization = reinstallAuthorization(location, input);
  await verifyDesktopReinstallStorage(location, authorization);
  const identity = await verifiedIdentity(location.dataDir);
  if (identity.deviceId !== authorization.nextDeviceId || identity.createdAt !== authorization.createdAt) fail("DESKTOP_REINSTALL_IDENTITY_CONFLICT");
  const completed = Object.freeze({ ...location, deviceId: authorization.nextDeviceId });
  if (location.deviceId !== authorization.nextDeviceId) await writeLocator(location, completed, false);
  return completed;
}

/** 启动拒绝只写固定profile日志，逐级拒绝链接，写入与关闭故障均保留。 */
export function appendDesktopStartupDiagnostic(userDataDir: string, line: string): void {
  const assertPath = (target: string): void => {
    const root = path.parse(target).root;
    let current = root;
    for (const part of ["", ...target.slice(root.length).split(path.sep).filter(Boolean)]) {
      current = path.join(current, part);
      const entry = syncFs.lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail("DESKTOP_STORAGE_PATH_INVALID");
    }
  };
  assertPath(userDataDir);
  const profile = syncFs.lstatSync(userDataDir), directory = path.join(userDataDir, "logs");
  try { syncFs.mkdirSync(directory); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  assertPath(directory);
  const currentProfile = syncFs.lstatSync(userDataDir), directoryBefore = syncFs.lstatSync(directory);
  if (profile.dev !== currentProfile.dev || profile.ino !== currentProfile.ino) fail("DESKTOP_STORAGE_PATH_CHANGED");
  const log = path.join(directory, "desktop-errors.jsonl");
  let before: Stats | undefined;
  try { before = syncFs.lstatSync(log); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  if (before && !sameFile(before, before)) fail("DESKTOP_STORAGE_FILE_INVALID");
  const file = syncFs.openSync(log, constants.O_WRONLY | constants.O_APPEND | (before ? 0 : constants.O_CREAT | constants.O_EXCL)
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  let failure: { cause: unknown } | undefined;
  try {
    assertPath(directory);
    const currentDirectory = syncFs.lstatSync(directory), opened = syncFs.fstatSync(file);
    if (directoryBefore.dev !== currentDirectory.dev || directoryBefore.ino !== currentDirectory.ino
      || !sameFile(opened, opened) || (before && !sameFile(before, opened)) || !sameFile(opened, syncFs.lstatSync(log))) fail("DESKTOP_STORAGE_FILE_CHANGED");
    syncFs.writeFileSync(file, line, "utf8");
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { syncFs.closeSync(file); }
    catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_STORAGE_CLOSE_FAILED") : cause; }
  }
}
