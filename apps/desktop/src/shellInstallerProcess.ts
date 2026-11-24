import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ShellReleaseManifest } from "@codeflowai/shared";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { verifyShellReleaseSignature } from "@codeflowai/shared/desktop-shell-release-signing";
import { verifyShellInstallerArtifact, verifyShellReleaseArtifact } from "./shellReleaseArtifact.js";
import { parseShellLaunchState, readShellLaunchState, serializeShellLaunchState, type ShellLaunchState } from "./shellLaunchState.js";
import { processSnapshot, sameIdentity, stopIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";

type InstallerInput = {
  manifest: unknown; trustedKeys: TrustedReleaseKeys; installerPath: string; installationDir: string; expectedState: ShellLaunchState; requestId: string;
  signal?: AbortSignal; timeoutMs?: number; temporaryParentDir?: string;
  boundary?: { spawn: typeof spawn; snapshot: typeof processSnapshot; stop: typeof stopIdentity };
};
type Diagnostic = { errorCode: "DESKTOP_SHELL_INSTALL_FAILED"; requestId: string; shellId: string; stage: string;
  win32Error: number; rootCause: string; cleanupWin32Error?: number };
type ExecutionDetails = { exitCode?: number | null; signal?: NodeJS.Signals | null; diagnostic?: Diagnostic };
type Owned = { child: ChildProcess; pid?: number; identity?: ProcessIdentity; known: Map<number, ProcessIdentity>; startedAt: number;
  didExit: boolean; didClose: boolean; closed: Promise<void>; failures: unknown[]; stderr: Buffer[]; stderrBytes: number; stdoutBytes: number };
type Directory = { path: string; identity: BigIntStats };
const OUTPUT_LIMIT = 65_536;

/** 低层显式失败；原业务 owner 统一记录日志，根因不拼接任意进程输出。 */
class InstallerProcessError extends Error {
  readonly code: string;
  /** 固定短码始终保留 cause，包括 undefined。 */
  constructor(code: string, cause?: unknown) { super(`DESKTOP_SHELL_INSTALLER_PROCESS_${code}`, { cause }); this.code = this.message; }
}

/** 已有候选只验一次安装器与入口；新装在执行前验安装器、执行后查入口，不改 INI。 */
export async function installShellCandidate(input: InstallerInput): Promise<{ manifest: ShellReleaseManifest; candidateDirectory: string }> {
  let phase = "input", manifest: ShellReleaseManifest | undefined, installerRequestId: string | undefined, temporaryRoot: string | undefined;
  const details: ExecutionDetails = {};
  try {
    input.signal?.throwIfAborted();
    const timeout = input.timeoutMs ?? 120_000;
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(input.requestId)
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000 || !path.isAbsolute(input.installationDir)
      || !path.isAbsolute(input.installerPath)) fail("INPUT_INVALID");
    const expected = parseShellLaunchState(Buffer.from(serializeShellLaunchState(input.expectedState), "ascii"));
    phase = "installer";
    manifest = verifyShellReleaseSignature(input.manifest, input.trustedKeys);
    const installerEntry = await fs.lstat(input.installerPath, { bigint: true });
    if (!installerEntry.isFile() || installerEntry.isSymbolicLink() || installerEntry.nlink !== 1n) fail("INSTALLER_PATH_INVALID");
    const installationDir = await fs.realpath(input.installationDir), installerPath = await fs.realpath(input.installerPath);
    const directories = await snapshotDirectories(path.join(installationDir, "shells"));
    const candidateDirectory = path.join(installationDir, "shells", manifest.shellId);
    if (expected.activeShellId === manifest.shellId) fail("TARGET_CONFLICT");
    await assertLaunch(installationDir, expected); await assertDirectories(directories); input.signal?.throwIfAborted();
    phase = "candidate";
    if (await exists(candidateDirectory)) {
      await assertCandidateRoot(candidateDirectory);
      const verified = await verifyShellReleaseArtifact({ ...input, manifest, installerPath, candidateDirectory, verification: "installed" });
      await assertDirectories(directories); await assertLaunch(installationDir, expected); input.signal?.throwIfAborted();
      return { manifest: verified, candidateDirectory };
    }
    phase = "temporary";
    const parent = await fs.realpath(input.temporaryParentDir ?? os.tmpdir());
    if (within(installationDir, parent)) fail("TEMPORARY_PATH_INVALID");
    const temporaryDirectories = await snapshotDirectories(parent);
    temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(parent, "cf-shell-installer-")));
    if (within(installationDir, temporaryRoot) || within(temporaryRoot, installationDir)
      || within(temporaryRoot, installerPath) || within(installerPath, temporaryRoot)) fail("TEMPORARY_PATH_INVALID");
    temporaryDirectories.push({ path: temporaryRoot, identity: await fs.lstat(temporaryRoot, { bigint: true }) });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (["TEMP", "TMP", "TMPDIR", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase())) delete env[key];
    Object.assign(env, { TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot });
    installerRequestId = crypto.randomUUID();
    phase = "before-spawn";
    await assertDirectories([...directories, ...temporaryDirectories]); await assertLaunch(installationDir, expected);
    if (await exists(candidateDirectory)) fail("TARGET_APPEARED");
    await verifyShellInstallerArtifact({ ...input, manifest, installerPath });
    input.signal?.throwIfAborted();
    phase = "process";
    await executeOwned({ ...input, installerPath }, ["--codeflow-candidate-install", "--installation-root", installationDir, "--request-id", installerRequestId],
      { cwd: installationDir, env, timeout, manifest, installerRequestId, details });
    phase = "candidate";
    await assertDirectories([...directories, ...temporaryDirectories]); await assertCandidateRoot(candidateDirectory);
    const verified = await verifyShellReleaseArtifact({ ...input, manifest, installerPath, candidateDirectory, verification: "installed" });
    await assertDirectories(directories); await assertLaunch(installationDir, expected); input.signal?.throwIfAborted();
    return { manifest: verified, candidateDirectory };
  } catch (cause) {
    const code = "DESKTOP_SHELL_INSTALLER_PROCESS_FAILED";
    throw Object.assign(new Error(code, { cause }), { code, requestId: input.requestId, shellId: manifest?.shellId,
      installerRequestId, phase, temporaryRoot, details });
  }
}

/** 持有真实close并串行采样；成功返回前核总预算，原失败仍先清理后上抛。 */
async function executeOwned(input: InstallerInput, args: string[], context: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; manifest: ShellReleaseManifest; installerRequestId: string; details: ExecutionDetails;
}): Promise<void> {
  const startedAt = Date.now(), child = (input.boundary?.spawn ?? spawn)(input.installerPath, args,
    { cwd: context.cwd, env: context.env, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
  const owned: Owned = { child, pid: child.pid, known: new Map(), startedAt, didExit: false, didClose: false,
    closed: Promise.resolve(), failures: [], stderr: [], stderrBytes: 0, stdoutBytes: 0 };
  const onError = (cause: unknown) => { owned.failures.push(cause); };
  const onExit = () => { owned.didExit = true; };
  const stdout = (chunk: Buffer) => { owned.stdoutBytes += Buffer.byteLength(chunk); if (owned.stdoutBytes > OUTPUT_LIMIT && owned.stdoutBytes - chunk.length <= OUTPUT_LIMIT) owned.failures.push(new InstallerProcessError("OUTPUT_LIMIT")); };
  const stderr = (chunk: Buffer) => { owned.stderrBytes += Buffer.byteLength(chunk); if (owned.stderrBytes <= OUTPUT_LIMIT) owned.stderr.push(Buffer.from(chunk));
    else if (owned.stderrBytes - chunk.length <= OUTPUT_LIMIT) owned.failures.push(new InstallerProcessError("OUTPUT_LIMIT")); };
  child.on("error", onError); child.once("exit", onExit);
  child.stdout?.on("data", stdout); child.stderr?.on("data", stderr);
  child.stdout?.on("error", onError); child.stderr?.on("error", onError);
  owned.closed = new Promise(resolve => child.once("close", (code, signal) => {
    owned.didClose = true; context.details.exitCode = code; context.details.signal = signal; resolve();
  }));
  const failures: unknown[] = [], snapshot = input.boundary?.snapshot ?? processSnapshot;
  let consumedEvents = 0;
  try {
    const deadline = startedAt + context.timeout;
    do {
      input.signal?.throwIfAborted();
      const live = await sampleOwned(owned, snapshot, input.installerPath);
      if (owned.failures.length) { consumedEvents = owned.failures.length; throw consumedEvents === 1 ? owned.failures[0] : new AggregateError([...owned.failures], "DESKTOP_SHELL_INSTALLER_PROCESS_EVENTS_FAILED"); }
      input.signal?.throwIfAborted();
      if (owned.didClose && (context.details.exitCode !== 0 || context.details.signal !== null)) fail("EXIT_FAILED");
      if (Date.now() >= deadline) fail("TIMEOUT");
      if (owned.didClose && !live) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
  } catch (cause) {
    failures.push(cause);
    try { await cleanupOwned(owned, snapshot, input.boundary?.stop ?? stopIdentity, input.installerPath, Math.min(context.timeout, 5_000)); }
    catch (cleanup) { failures.push(cleanup); }
  }
  failures.push(...owned.failures.slice(consumedEvents));
  if (owned.didClose) {
    try {
      const diagnostic = readDiagnostic(owned, context.installerRequestId, context.manifest.shellId);
      if (diagnostic) { context.details.diagnostic = diagnostic; if (!failures.length) fail("DIAGNOSTIC_FAILED"); }
    } catch (cause) { failures.push(cause); }
  }
  /** close 前保留有限观察器，释放失败不能变成后续未处理 error；close 后统一解绑。 */
  const dispose = () => { child.off("error", onError); child.off("exit", onExit); child.stdout?.off("data", stdout); child.stderr?.off("data", stderr);
    child.stdout?.off("error", onError); child.stderr?.off("error", onError); };
  if (owned.didClose) dispose(); else child.once("close", dispose);
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "DESKTOP_SHELL_INSTALLER_PROCESS_EXECUTION_FAILED");
}

/** 只从仍匹配的本次实例扩展父链；消失父亲的陌生后代和 PID 复用均不认领。 */
async function sampleOwned(owned: Owned, snapshot: typeof processSnapshot, executable: string): Promise<boolean> {
  const processes = await snapshot();
  if (!owned.pid) { if (!owned.didClose) fail("IDENTITY_UNKNOWN"); return false; }
  const root = processes.find(item => item.pid === owned.pid);
  if (!owned.identity && root) {
    if (owned.didExit || owned.didClose || root.parentPid !== process.pid || root.executable !== executable
      || !Number.isSafeInteger(root.created) || root.created < owned.startedAt || root.created > Date.now()) fail("IDENTITY_UNKNOWN");
    owned.identity = root;
  }
  const records = owned.identity ? [owned.identity, ...owned.known.values()] : [];
  for (const record of records) {
    const current = processes.find(item => item.pid === record.pid);
    if (current && !sameIdentity(current, record)) fail("IDENTITY_CHANGED");
  }
  const roots = new Map(records.filter(record => processes.some(item => sameIdentity(item, record))).map(record => [record.pid, record]));
  let changed = true;
  while (changed) { changed = false; for (const item of processes) {
    const parent = roots.get(item.parentPid);
    if (!parent || roots.has(item.pid)) continue;
    if (!item.executable || !Number.isSafeInteger(item.created) || item.created < parent.created) fail("DESCENDANT_IDENTITY_UNKNOWN");
    const previous = owned.known.get(item.pid); if (previous && !sameIdentity(previous, item)) fail("IDENTITY_CHANGED");
    owned.known.set(item.pid, item); roots.set(item.pid, item); changed = true;
  } }
  for (const pid of [owned.pid, ...owned.known.keys()]) {
    if (roots.has(pid)) continue;
    if (processes.some(item => item.parentPid === pid && ![...owned.known.values()].some(record => sameIdentity(item, record)))) fail("DESCENDANT_IDENTITY_UNKNOWN");
  }
  return roots.size > 0;
}

/** 只停重核成功的实例；查询故障中止 kill，但仍结算 close 与最终释放检查并保全部副因。 */
async function cleanupOwned(owned: Owned, snapshot: typeof processSnapshot, stop: typeof stopIdentity, executable: string, timeout: number): Promise<void> {
  const failures: unknown[] = [];
  try {
    await sampleOwned(owned, snapshot, executable);
    for (const identity of [...owned.known.values()].reverse().concat(owned.identity ? [owned.identity] : [])) {
      const current = (await snapshot()).find(item => item.pid === identity.pid);
      if (!current) continue;
      if (!sameIdentity(current, identity)) fail("IDENTITY_CHANGED");
      try { await stop(identity); }
      catch (cause) { failures.push(cause); }
    }
  } catch (cause) { failures.push(cause); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([owned.closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new InstallerProcessError("CLOSE_TIMEOUT")), Math.max(100, timeout)); })]);
  } catch (cause) { failures.push(cause); }
  finally { clearTimeout(timer); }
  try { if (await sampleOwned(owned, snapshot, executable)) fail("PROCESS_REMAINS"); }
  catch (cause) { failures.push(cause); }
  if (failures.length) throw new AggregateError(failures, "DESKTOP_SHELL_INSTALLER_PROCESS_CLEANUP_FAILED");
}

/** 仅接受同次 NSIS 固定结构的安全投影；未知正文只产生短码，不进入 cause 或日志。 */
function readDiagnostic(owned: Owned, requestId: string, shellId: string): Diagnostic | undefined {
  if (owned.stderrBytes > OUTPUT_LIMIT) fail("OUTPUT_LIMIT");
  if (!owned.stderrBytes) return undefined;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(owned.stderr))); }
  catch { fail("DIAGNOSTIC_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DIAGNOSTIC_INVALID");
  const item = value as Record<string, unknown>, keys = Object.keys(item), optional = Object.hasOwn(item, "cleanupWin32Error");
  const fields = ["errorCode", "requestId", "shellId", "stage", "win32Error", "rootCause", ...(optional ? ["cleanupWin32Error"] : [])];
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || item.errorCode !== "DESKTOP_SHELL_INSTALL_FAILED"
    || item.requestId !== requestId || item.shellId !== shellId || typeof item.stage !== "string" || !["arguments", "root", "create-target", "extract-temp", "extract"].includes(item.stage)
    || typeof item.rootCause !== "string" || !["ARGUMENTS_INVALID", "ARGUMENT_PARSE_FAILED", "ARGUMENT_RELEASE_FAILED", "PATH_UNAVAILABLE", "PATH_REPARSE", "PATH_NOT_DIRECTORY", "ROOT_DRIVE_UNSUPPORTED", "ROOT_INVALID", "TARGET_CREATE_FAILED", "PAYLOAD_DIRECTORY_FAILED", "PAYLOAD_WRITE_FAILED", "PAYLOAD_TEMP_FAILED"].includes(item.rootCause)
    || !win32(item.win32Error) || optional && !win32(item.cleanupWin32Error)) fail("DIAGNOSTIC_INVALID");
  return { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId, shellId, stage: item.stage as string, win32Error: item.win32Error as number,
    rootCause: item.rootCause as string, ...(optional ? { cleanupWin32Error: item.cleanupWin32Error as number } : {}) };
}

/** Win32 错误仅允许有限无符号整数，不能携带任意文本。 */
function win32(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff; }
/** 缺失候选是正常新装分支；其他访问故障不降级。 */
async function exists(target: string): Promise<boolean> { try { await fs.lstat(target); return true; } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false; throw cause; } }
/** 候选根自身不可为 junction，完整内部库存仍交原 validator。 */
async function assertCandidateRoot(target: string): Promise<void> { const stat = await fs.lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CANDIDATE_PATH_INVALID"); }
/** 完整 S0 包含 previous 和 baseline，执行片始终只读。 */
async function assertLaunch(root: string, expected: ShellLaunchState): Promise<void> { if (serializeShellLaunchState((await readShellLaunchState(root)).state) !== serializeShellLaunchState(expected)) fail("LAUNCH_STATE_CHANGED"); }
/** 包含关系覆盖相等，不允许临时环境写入安装或安装器输入树。 */
function within(parent: string, target: string): boolean { const relative = path.relative(parent, target); return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
/** 每层目录只接受物理普通实体，避免路径别名改变执行目标。 */
async function snapshotDirectories(target: string): Promise<Directory[]> {
  let current = path.parse(target).root; const result: Directory[] = [];
  for (const segment of ["", ...path.relative(current, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment); const identity = await fs.lstat(current, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail("DIRECTORY_INVALID"); result.push({ path: current, identity });
  }
  return result;
}
/** 内容变化可来自安装，但祖先实体不得在校验或执行间更换。 */
async function assertDirectories(records: Directory[]): Promise<void> {
  for (const record of records) { const current = await fs.lstat(record.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== record.identity.dev || current.ino !== record.identity.ino) fail("DIRECTORY_CHANGED"); }
}
/** 领域错误不包含环境、输出或参数正文。 */
function fail(code: string): never { throw new InstallerProcessError(code); }
