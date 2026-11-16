import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { REMOVE_FILES, REMOVE_DIRECTORIES } from "./desktopRemovalPaths.js";

const APP_ID = "ai.codeflow.codeflowai";
const LOCATOR = "desktop-data-location.json";
/** 只删除应用自身的缓存与浏览器配置；默认工作区不在其中。 */
const PROFILE_DIRECTORIES = ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "GrShaderCache", "ShaderCache", "Local Storage", "Session Storage", "Network", "blob_storage", "shared_proto_db",
  "Crashpad", "logs", "Service Worker"];
const PROFILE_FILES = ["desktop-uninstall-result.json"];

export type MacOSUninstallPlan = {
  applicationRoot: string;
  dataDir: string;
  userDataDir: string;
  sessionDataDir?: string;
  logFile: string;
  parentPid?: number;
  requestId?: string;
};

type UninstallDependencies = {
  waitForExit?: (pid: number) => Promise<void>;
  prepareTrash?: (applicationRoot: string) => Promise<void>;
  trashApplication?: (applicationRoot: string) => Promise<void>;
};

/** 所有输入必须是绝对路径且不含控制字符；相对路径可能把删除范围交给启动目录。 */
function assertAbsolute(target: string, code: string): string {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target || /[\x00-\x1f]/u.test(target)) {
    throw Object.assign(new Error(code), { code });
  }
  return target;
}

/** 目录只能是现存普通目录，链接会改变真实删除范围。 */
async function assertDirectory(target: string, code: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error(code), { code });
  return await fs.realpath(target);
}

/** 定位文件必须属于本应用并指向同一数据目录。 */
async function readOwnedDataDir(userDataDir: string, dataDir: string): Promise<void> {
  const file = path.join(userDataDir, LOCATOR);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID" });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file))); }
  catch (cause) { throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID", { cause }), { code: "DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID" }); }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (record.schemaVersion !== 1 || record.appId !== APP_ID || typeof record.installRoot !== "string" || typeof record.dataDir !== "string"
    || path.resolve(record.dataDir) !== dataDir) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID" });
  }
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 删除前只检查目标形态；任何链接或类型变化都在首个删除动作前失败。 */
async function inspectFile(target: string): Promise<void> {
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_TARGET_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_TARGET_INVALID", target });
  }
}

/** 授权目录本身不得是链接；内部链接在删除时只移除链接节点。 */
async function inspectDirectory(target: string): Promise<void> {
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_TARGET_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_TARGET_INVALID", target });
  }
}

/** 删除单个授权文件；链接、硬链接与目录一律失败，不扩大删除范围。 */
async function removeFile(target: string, removed: string[]): Promise<void> {
  await inspectFile(target);
  try { await fs.unlink(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  removed.push(target);
}

/** 删除授权目录；目录本身为链接时失败，内部链接只删除链接节点不跟随。 */
async function removeDirectory(target: string, removed: string[]): Promise<void> {
  await inspectDirectory(target);
  try { await fs.rm(target, { recursive: true, force: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  removed.push(target);
}

/** 移除受权文件与缓存；默认工作区、未知数据目录内容保留并返回给调用方记录。 */
export async function removeMacOSUninstallData(plan: MacOSUninstallPlan): Promise<{ removed: string[]; retained: string[] }> {
  const applicationRoot = assertAbsolute(plan.applicationRoot, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const userDataDir = assertAbsolute(plan.userDataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const dataDir = assertAbsolute(plan.dataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const sessionDataDir = plan.sessionDataDir === undefined ? undefined : assertAbsolute(plan.sessionDataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const home = await fs.realpath(os.homedir());
  const root = path.parse(dataDir).root;
  if (dataDir === root || userDataDir === root || applicationRoot === root || contains(dataDir, home) || contains(userDataDir, home)) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_PATH_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_PATH_INVALID" });
  }
  const realUser = await assertDirectory(userDataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const realData = await assertDirectory(dataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const realApp = await assertDirectory(applicationRoot, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  let realSession: string | undefined;
  if (sessionDataDir !== undefined) {
    try { realSession = await assertDirectory(sessionDataDir, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (path.extname(realApp).toLowerCase() !== ".app" || contains(realApp, home)) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_PATH_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_PATH_INVALID" });
  }
  await readOwnedDataDir(realUser, realData);
  const dataInsideProfile = contains(realUser, realData);
  const identities = (await fs.readdir(realData)).filter(name => name === "device-identity.json" || name.startsWith("device-identity.json.removing-"));
  // 先完整预检，避免中间一个链接或类型错误留下半删除状态。
  for (const name of REMOVE_FILES) await inspectFile(path.join(realData, name));
  for (const name of REMOVE_DIRECTORIES) await inspectDirectory(path.join(realData, name));
  for (const name of identities) await inspectFile(path.join(realData, name));
  await inspectFile(path.join(realUser, LOCATOR));
  if (dataInsideProfile) {
    for (const name of PROFILE_DIRECTORIES) await inspectDirectory(path.join(realUser, name));
    for (const name of PROFILE_FILES) await inspectFile(path.join(realUser, name));
  }
  const removed: string[] = [];
  for (const name of REMOVE_FILES) await removeFile(path.join(realData, name), removed);
  for (const name of REMOVE_DIRECTORIES) await removeDirectory(path.join(realData, name), removed);
  for (const name of identities) await removeFile(path.join(realData, name), removed);
  const locator = path.join(realUser, LOCATOR);
  await removeFile(locator, removed);
  if (dataInsideProfile) {
    for (const name of PROFILE_DIRECTORIES) await removeDirectory(path.join(realUser, name), removed);
    for (const name of PROFILE_FILES) await removeFile(path.join(realUser, name), removed);
  } else {
    await fs.rm(realUser, { recursive: true, force: false, maxRetries: 2 }); removed.push(realUser);
  }
  // 会话目录可能就在即将删除的 profile 内；外层根删除后不再重复处理。
  if (realSession && realSession !== realUser && !contains(realUser, realSession)) {
    await fs.rm(realSession, { recursive: true, force: false, maxRetries: 2 }); removed.push(realSession);
  }
  const remaining = await fs.readdir(realData);
  const retained = remaining.map(name => path.join(realData, name));
  if (!remaining.length) await fs.rmdir(realData);
  return { removed, retained };
}

/** 等父应用释放 Client 与数据库后再删除；超时明确失败，不并发清库。 */
export async function waitForMacOSParentExit(pid: number, timeoutMs = 30_000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_PID_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_PID_INVALID" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_PARENT_ALIVE"), { code: "DESKTOP_MACOS_UNINSTALL_PARENT_ALIVE" });
}

/** 删除数据前先确认应用可被移动到废纸篓，避免数据已清理但 .app 留在原处。 */
export async function assertMacOSApplicationTrashable(applicationRoot: string): Promise<void> {
  const trash = path.join(os.homedir(), ".Trash");
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  let trashStat, appStat;
  try { trashStat = await fs.lstat(trash); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("DESKTOP_MACOS_UNINSTALL_TRASH_INVALID"); throw error; }
  try { appStat = await fs.lstat(applicationRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("DESKTOP_MACOS_UNINSTALL_PATH_INVALID"); throw error; }
  if (!trashStat!.isDirectory() || trashStat!.isSymbolicLink() || !appStat!.isDirectory() || appStat!.isSymbolicLink()) {
    fail("DESKTOP_MACOS_UNINSTALL_TRASH_INVALID");
  }
  if (trashStat!.dev !== appStat!.dev) fail("DESKTOP_MACOS_UNINSTALL_TRASH_DEVICE_CHANGED");
  await fs.access(path.dirname(applicationRoot), constants.W_OK);
  await fs.access(trash, constants.W_OK);
}

/** 直接移入用户废纸篓，避免触发 Finder 自动化授权；重名时保留时间戳后缀。 */
export async function trashMacOSApplication(applicationRoot: string): Promise<void> {
  const trash = path.join(os.homedir(), ".Trash");
  if (!(await fs.lstat(trash)).isDirectory()) throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_TRASH_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_TRASH_INVALID" });
  const name = path.basename(applicationRoot);
  let target = path.join(trash, name);
  try {
    await fs.lstat(target);
    target = path.join(trash, `${path.parse(name).name}-${Date.now()}.app`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.rename(applicationRoot, target);
}

/** 结构化追加；日志写失败回退 stderr，绝不吞掉卸载主因。 */
async function appendUninstallLog(logFile: string, record: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
    await fs.appendFile(logFile, line, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(JSON.stringify({ code: "DESKTOP_MACOS_UNINSTALL_LOG_FAILED", rootCause: error instanceof Error ? error.message : String(error) }));
    console.error(line.trimEnd());
  }
}

/** 完整卸载：等待父进程退出、清理授权数据、移入废纸篓，并把结果写入可检索日志。 */
export async function runMacOSUninstall(plan: MacOSUninstallPlan, dependencies: UninstallDependencies = {}): Promise<{ removed: string[]; retained: string[] }> {
  const logFile = assertAbsolute(plan.logFile, "DESKTOP_MACOS_UNINSTALL_PATH_INVALID");
  const parentPid = plan.parentPid ?? null;
  try {
    if (plan.parentPid !== undefined) await (dependencies.waitForExit ?? waitForMacOSParentExit)(plan.parentPid);
    await (dependencies.prepareTrash ?? assertMacOSApplicationTrashable)(plan.applicationRoot);
    const result = await removeMacOSUninstallData(plan);
    await (dependencies.trashApplication ?? trashMacOSApplication)(plan.applicationRoot);
    await appendUninstallLog(logFile, { code: "DESKTOP_MACOS_UNINSTALL_COMPLETED", requestId: plan.requestId ?? null, parentPid, ...result });
    return result;
  } catch (error) {
    await appendUninstallLog(logFile, { code: "DESKTOP_MACOS_UNINSTALL_FAILED", requestId: plan.requestId ?? null, parentPid,
      rootCause: error instanceof Error ? error.message : String(error), errorCode: error && typeof error === "object" && "code" in error ? error.code : null });
    throw error;
  }
}
