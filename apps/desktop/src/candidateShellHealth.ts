import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { assertReleaseId, type DesktopClientHealth } from "@codeflowai/shared";
import { assertTrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { createClientRuntime } from "./clientRuntime.js";
import { loadOrCreateDeviceIdentity } from "./deviceIdentity.js";
import type { ReleaseBundleManifest } from "./contracts.js";
import { resolveActiveRelease } from "./releaseBundleCoordinator.js";
import { readShellLaunchState } from "./shellLaunchState.js";
import { createDesktopWebHandler, DESKTOP_WEB_ENTRY } from "./webProtocol.js";
import { processSnapshot, sameIdentity, stopIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";

export const CANDIDATE_SHELL_HEALTH_FLAG = "--codeflow-shell-health";
const REQUEST_KEYS = ["schemaVersion", "requestId", "candidateShellId", "installationDir", "sourceDataDir", "candidateExecutablePath", "temporaryRoot", "timeoutMs"];
const DIRECTORY_ENV: Readonly<Record<string, string>> = { HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "local-appdata",
  CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", TMP: "tmp", TEMP: "tmp", TMPDIR: "tmp" };
const SYSTEM_ENV = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture|logonserver|userdomain|username)$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CandidateShellHealthRequest = {
  schemaVersion: 1; requestId: string; candidateShellId: string; installationDir: string; sourceDataDir: string;
  candidateExecutablePath: string; temporaryRoot: string; timeoutMs: number;
};
export type CandidateShellHealthCheck = {
  role: "baseline" | "active"; releaseId: string; releaseDir: string; health: DesktopClientHealth;
  native: { loaded: string[]; credentialsAccessed: false; ptyCreated: false };
  web: { files: string[] }; database: { integrity: "ok"; schemaVersion: number }; childClosed: true;
};
export type CandidateShellHealthReport = {
  schemaVersion: 1; requestId: string; candidateShellId: string; temporaryRoot: string; status: "passed" | "failed";
  checks: CandidateShellHealthCheck[]; phase: string; error?: Record<string, unknown>; releaseId?: string; childPhase?: string;
};
type SourceSnapshot = { pointers: Record<string, string | null>; resources: Record<string, string> };
type HealthError = Error & { code: string; temporaryRoot?: string; reportPath?: string };
type Selection = { role: "baseline" | "active"; releaseId: string; releaseDir: string; expectedRelease?: ReleaseBundleManifest };

/** 专用参数一旦出现就严格处理；无效请求绝不退回正常启动。 */
export function readCandidateShellHealthRequest(argv: string[], executablePath = process.execPath): CandidateShellHealthRequest | null {
  const positions = argv.flatMap((argument, index) => argument.startsWith(CANDIDATE_SHELL_HEALTH_FLAG) ? [index] : []);
  if (!positions.length) return null;
  const index = positions[0]!;
  if (positions.length !== 1 || argv[index] !== CANDIDATE_SHELL_HEALTH_FLAG || index > 1 || argv.length !== index + 2) fail("REQUEST_INVALID");
  const file = argv[index + 1]!;
  if (!path.isAbsolute(file) || path.basename(file) !== "request.json") fail("REQUEST_INVALID");
  let input: unknown;
  try { input = JSON.parse(readBounded(file)); }
  catch (cause) { fail("REQUEST_INVALID", cause); }
  const request = validateRequest(input, executablePath);
  if (!samePath(path.dirname(file), request.temporaryRoot)) fail("PATH_INVALID");
  return request;
}

/** 父进程只投影系统启动变量，并在本次根内建立全部用户和临时目录。 */
export async function createCandidateShellHealthEnvironment(temporaryRoot: string, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  assertOrdinary(temporaryRoot, true);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(source).filter(([key]) => SYSTEM_ENV.test(key)));
  for (const [key, directory] of Object.entries(DIRECTORY_ENV)) {
    env[key] = path.join(temporaryRoot, directory);
    await fsp.mkdir(env[key]!, { recursive: true });
    assertOrdinary(env[key]!, true);
  }
  if (process.platform === "win32") Object.assign(env, windowsHomeEnvironment(temporaryRoot));
  for (const directory of ["user-data", "session-data"]) {
    await fsp.mkdir(path.join(temporaryRoot, directory), { recursive: true }); assertOrdinary(path.join(temporaryRoot, directory), true);
  }
  return env;
}

/** 单次父 runner 独占临时目录；只有真实 close 和完整报告均成功才返回。 */
export async function runCandidateShellHealth(input: {
  candidateExecutablePath: string; installationDir: string; sourceDataDir: string; temporaryParentDir?: string; timeoutMs?: number;
}): Promise<CandidateShellHealthReport> {
  if (process.platform !== "win32" || process.arch !== "x64") fail("PLATFORM_INVALID");
  const installationDir = canonical(input.installationDir, true), sourceDataDir = canonical(input.sourceDataDir, true);
  const relative = path.relative(path.resolve(input.installationDir), path.resolve(input.candidateExecutablePath)).split(path.sep);
  if (relative.length !== 3 || relative[0]!.toLowerCase() !== "shells" || relative[2]!.toLowerCase() !== "codeflowai.exe") fail("PATH_INVALID");
  const candidateShellId = validId(relative[1]);
  const candidateExecutablePath = path.join(installationDir, "shells", candidateShellId, "CodeFlowAI.exe");
  assertOrdinary(candidateExecutablePath, false);
  separate(installationDir, sourceDataDir);
  const parent = canonical(input.temporaryParentDir ?? os.tmpdir(), true);
  if (within(installationDir, parent) || within(sourceDataDir, parent)) fail("PATH_INVALID");
  const timeoutMs = validTimeout(input.timeoutMs ?? 120_000);
  const before = await captureSources({ installationDir, sourceDataDir, candidateExecutablePath });
  const temporaryRoot = await fsp.realpath(await fsp.mkdtemp(path.join(parent, "cf-shell-health-")));
  const request: CandidateShellHealthRequest = { schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId,
    installationDir, sourceDataDir, candidateExecutablePath, temporaryRoot, timeoutMs };
  const reportPath = path.join(temporaryRoot, "report.json");
  let failure: unknown, report: CandidateShellHealthReport | undefined;
  let failureReleaseId: string | undefined, childPhase: string | undefined;
  try {
    const selections = await selectReleases(request);
    const env = await createCandidateShellHealthEnvironment(temporaryRoot);
    const requestPath = path.join(temporaryRoot, "request.json");
    await fsp.writeFile(requestPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", flag: "wx" });
    try { await runOwned(candidateExecutablePath, [CANDIDATE_SHELL_HEALTH_FLAG, requestPath], { cwd: temporaryRoot, env, timeoutMs }); }
    catch (error) { failure = error; }
    try {
      report = validateCandidateShellHealthReport(JSON.parse(readBounded(reportPath)), request, selections);
      if (report.status !== "passed") {
        const role = /^(baseline|active):(?:web|native|client|database)$/u.exec(report.phase)?.[1];
        failureReleaseId = selections.find(selected => selected.role === role)?.releaseId;
        childPhase = report.phase;
        const childFailure = Object.assign(new Error("DESKTOP_SHELL_HEALTH_CANDIDATE_FAILED", { cause: structuredError(report.error) }),
          { code: "DESKTOP_SHELL_HEALTH_CANDIDATE_FAILED", phase: report.phase, details: report.error });
        failure = combine(failure, childFailure, "CANDIDATE_FAILED");
      }
    } catch (error) { failure = combine(failure, error, "REPORT_READ_FAILED"); }
  } catch (error) { failure = error; }
  try {
    const after = await captureSources(request);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail("SOURCE_CHANGED");
  } catch (error) { failure = combine(failure, error, "SOURCE_CHECK_FAILED"); }
  if (failure !== undefined) {
    const failed: CandidateShellHealthReport = { schemaVersion: 1, requestId: request.requestId, candidateShellId, temporaryRoot,
      status: "failed", checks: report?.checks ?? [], phase: "parent", error: safeFailure(failure),
      ...(failureReleaseId ? { releaseId: failureReleaseId } : {}), ...(childPhase ? { childPhase } : {}) };
    try { await writeReport(request, failed, "parent-report.json"); }
    catch (error) { failure = combine(failure, error, "REPORT_FAILED"); }
    throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_FAILED", { cause: failure }),
      { code: "DESKTOP_SHELL_HEALTH_FAILED", temporaryRoot, reportPath });
  }
  return report!;
}

/** 候选仅检查只读包与全新临时数据，任何失败及清理失败均写失败报告并抛出。 */
export async function executeCandidateShellHealth(input: CandidateShellHealthRequest): Promise<CandidateShellHealthReport> {
  const request = validateRequest(input, process.execPath, false);
  const report: CandidateShellHealthReport = { schemaVersion: 1, requestId: request.requestId, candidateShellId: request.candidateShellId,
    temporaryRoot: request.temporaryRoot, status: "failed", checks: [], phase: "environment" };
  let failure: unknown;
  try {
    assertCandidateShellHealthEnvironment(request);
    if (!process.versions.electron || process.platform !== "win32" || process.arch !== "x64") fail("PLATFORM_INVALID");
    for (const entry of fs.readdirSync(request.temporaryRoot)) {
      if (!["request.json", "home", "appdata", "local-appdata", "codex", "claude", "config", "data", "tmp", "user-data", "session-data"].includes(entry)) fail("OUTPUT_NOT_FRESH");
    }
    report.phase = "source";
    const before = await captureSources(request);
    report.phase = "active";
    const selections = await selectReleases(request);
    for (const [index, selected] of selections.entries()) {
      report.phase = `${selected.role}:client`;
      const dataDir = path.join(request.temporaryRoot, `client-${index}`); await fsp.mkdir(dataDir);
      // Client 只读取壳已有身份；每组在空临时目录生成独立身份，不复制或登记真实安装。
      await loadOrCreateDeviceIdentity(dataDir);
      report.phase = `${selected.role}:web`;
      const web = await checkWeb(selected.releaseDir);
      report.phase = `${selected.role}:native`;
      const native = await checkNative(selected.releaseDir, request);
      report.phase = `${selected.role}:client`;
      let observed: OwnedProcess | undefined;
      const runtime = createClientRuntime({ entry: path.join(selected.releaseDir, "client", "dist", "index.cjs"), dataDir,
        expectedRelease: selected.expectedRelease,
        /** 保持原启动与 IPC；只捕获真实 close，以便健康边界完整收口。 */
        spawn(file, args, options) {
          if (!samePath(file, request.candidateExecutablePath)) fail("PROCESS_IDENTITY_INVALID");
          const child = spawn(file, args, options);
          observed = observeOwned(child); return child;
        } });
      let runtimeFailure: unknown, snapshot: ReturnType<typeof runtime.snapshot> | undefined;
      try { await runtime.start(); await runtime.waitReady(Math.min(request.timeoutMs, 60_000)); snapshot = runtime.snapshot();
        if (snapshot.status !== "ready" || !snapshot.health || snapshot.health.database !== "ready") fail("CLIENT_NOT_HEALTHY");
      } catch (error) { runtimeFailure = error; }
      try { await runtime.drain(Math.min(request.timeoutMs, 30_000)); }
      catch (error) { runtimeFailure = combine(runtimeFailure, error, "CLIENT_DRAIN_FAILED"); }
      if (observed) {
        try { await finishOwned(observed, Math.min(request.timeoutMs, 10_000)); }
        catch (error) { runtimeFailure = combine(runtimeFailure, error, "CLIENT_CLOSE_FAILED"); }
      }
      if (runtimeFailure !== undefined) throw runtimeFailure;
      if (!observed || !snapshot?.health) fail("CLIENT_NOT_HEALTHY");
      report.phase = `${selected.role}:database`;
      const database = await checkDatabase(dataDir, snapshot.health, request);
      report.checks.push({ role: selected.role, releaseId: selected.releaseId, releaseDir: selected.releaseDir,
        health: snapshot.health, native, web, database, childClosed: true });
    }
    report.phase = "source-after";
    const after = await captureSources(request);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("SOURCE_CHANGED");
    report.phase = "complete"; report.status = "passed";
  } catch (error) { failure = error; report.error = safeFailure(error); }
  try { await writeReport(request, report, "report.json"); }
  catch (error) { failure = combine(failure, error, "REPORT_FAILED"); }
  if (failure !== undefined) throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_FAILED", { cause: failure }),
    { code: "DESKTOP_SHELL_HEALTH_FAILED", temporaryRoot: request.temporaryRoot, reportPath: path.join(request.temporaryRoot, "report.json") });
  return report;
}

/** 手工启动候选同样必须处于白名单环境，防止有效描述文件继承真实凭据。 */
export function assertCandidateShellHealthEnvironment(request: CandidateShellHealthRequest, env: NodeJS.ProcessEnv = process.env): void {
  const home = process.platform === "win32" ? windowsHomeEnvironment(request.temporaryRoot) : {};
  for (const [key, value] of Object.entries(env)) {
    if (SYSTEM_ENV.test(key) || key === "ELECTRON_NO_ATTACH_CONSOLE") continue;
    if (Object.hasOwn(home, key)) { if (value !== home[key]) fail("ENVIRONMENT_INVALID"); continue; }
    const directory = DIRECTORY_ENV[key];
    if (!directory || typeof value !== "string" || !samePath(value, path.join(request.temporaryRoot, directory))) fail("ENVIRONMENT_INVALID");
  }
  for (const [key, directory] of Object.entries(DIRECTORY_ENV)) {
    if (!env[key] || !samePath(env[key]!, path.join(request.temporaryRoot, directory))) fail("ENVIRONMENT_INVALID");
    assertOrdinary(env[key]!, true);
  }
  for (const [key, value] of Object.entries(home)) if (env[key] !== value) fail("ENVIRONMENT_INVALID");
}

/** Windows 自动补充的 home 配对必须和本次 HOME/USERPROFILE 指向同一隔离目录。 */
function windowsHomeEnvironment(temporaryRoot: string): Record<string, string> {
  const home = path.join(temporaryRoot, "home"), root = path.parse(home).root;
  return { HOMEDRIVE: root.slice(0, -1), HOMEPATH: path.sep + path.relative(root, home) };
}

/** 父子各自冻结唯一启动状态、业务指针和实际只读资源，不读取真实配置或数据库。 */
async function captureSources(input: Pick<CandidateShellHealthRequest, "installationDir" | "sourceDataDir" | "candidateExecutablePath">): Promise<SourceSnapshot> {
  const startup = await readShellLaunchState(input.installationDir);
  const pointers: Record<string, string | null> = {};
  for (const file of [path.join(input.installationDir, "shell-launch.ini"), path.join(input.sourceDataDir, "active-release.json"), path.join(input.sourceDataDir, "previous-release.json")]) {
    try { pointers[file] = crypto.createHash("sha256").update(readBounded(file)).digest("hex"); }
    catch (error) {
      if (error instanceof Error && error.cause && (error.cause as NodeJS.ErrnoException).code === "ENOENT"
        && !samePath(file, path.join(input.installationDir, "shell-launch.ini"))) pointers[file] = null;
      else throw error;
    }
  }
  const resources: Record<string, string> = {};
  // 这里只读物理工件字节；Electron 的 asar 虚拟目录视图不能用于安装文件摘要。
  const physicalFs: typeof fs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : fs;
  const roots = new Set([path.dirname(input.candidateExecutablePath), startup.initialReleaseDir]);
  if (pointers[path.join(input.sourceDataDir, "active-release.json")] !== null) {
    const pointer = JSON.parse(readBounded(path.join(input.sourceDataDir, "active-release.json")));
    roots.add(path.join(input.sourceDataDir, "releases", validId(pointer?.releaseId)));
  }
  for (const root of roots) await hashTree(root, resources, physicalFs);
  return { pointers, resources: Object.fromEntries(Object.entries(resources).sort(([left], [right]) => left.localeCompare(right))) };
}

/** 父子共用原活动包校验口径，候选安装信任根必须覆盖原绑定版本。 */
async function selectReleases(request: Pick<CandidateShellHealthRequest, "installationDir" | "sourceDataDir" | "candidateExecutablePath">): Promise<Selection[]> {
  const startup = await readShellLaunchState(request.installationDir);
  const trustPath = path.join(path.dirname(request.candidateExecutablePath), "resources", "release-trust.json");
  const trustedReleaseKeys = assertTrustedReleaseKeys(JSON.parse(readBounded(trustPath)));
  const active = await resolveActiveRelease(request.sourceDataDir, { trustedReleaseKeys });
  return [{ role: "baseline", releaseId: "installation", releaseDir: startup.initialReleaseDir },
    ...(active && !samePath(active.releaseDir, startup.initialReleaseDir)
      ? [{ role: "active" as const, releaseId: active.releaseId, releaseDir: active.releaseDir, expectedRelease: active.manifest }] : [])];
}

/** 普通文件逐个流式摘要，链接及意外文件类型明确失败。 */
async function hashTree(directory: string, output: Record<string, string>, view: typeof fs): Promise<void> {
  assertOrdinary(directory, true, view);
  for (const entry of await view.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await hashTree(file, output, view);
    else if (entry.isFile() && !entry.isSymbolicLink()) {
      assertOrdinary(file, false, view); const hash = crypto.createHash("sha256");
      for await (const bytes of view.createReadStream(file)) hash.update(bytes);
      output[file] = hash.digest("hex");
    } else fail("PATH_INVALID");
  }
}

/** 沿原 Web 协议读取首页和首页声明的本地静态资源，不装业务桥或访问网络。 */
async function checkWeb(releaseDir: string): Promise<CandidateShellHealthCheck["web"]> {
  // handler 继续抛出原错误；单次健康边界统一补充阶段并记录，避免重复日志。
  const handler = createDesktopWebHandler({ getWebDir: () => path.join(releaseDir, "web"), onError: () => undefined });
  const response = await handler(new Request(DESKTOP_WEB_ENTRY)); const html = await response.text();
  if (!html.trim()) fail("WEB_INVALID");
  const urls = new Set<string>([DESKTOP_WEB_ENTRY]);
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    const value = match[1]!; if (value.startsWith("#") || /^(?:data|mailto):/iu.test(value)) continue;
    const url = new URL(value, DESKTOP_WEB_ENTRY);
    if (url.origin === new URL(DESKTOP_WEB_ENTRY).origin && url.protocol === "codeflow:") urls.add(url.href);
    else if (/^https?:$/u.test(url.protocol)) continue;
    else fail("WEB_INVALID");
  }
  for (const url of urls) { const resource = await handler(new Request(url)); if (!resource.ok || (await resource.arrayBuffer()).byteLength === 0) fail("WEB_INVALID"); }
  return { files: [...urls] };
}

/** 候选 Electron Node 直接加载包内 native；绝不创建 keyring Entry 或实际终端。 */
async function checkNative(releaseDir: string, request: CandidateShellHealthRequest): Promise<CandidateShellHealthCheck["native"]> {
  const client = path.join(releaseDir, "client"), packageFile = path.join(client, "package.json");
  assertOrdinary(packageFile, false); const require = createRequire(packageFile), modules = path.join(client, "node_modules");
  assertOrdinary(modules, true);
  const ptyPackage = require.resolve("node-pty/package.json"), ptyRoot = path.dirname(ptyPackage);
  const files = [require.resolve("@napi-rs/keyring"), ...["pty.node", "conpty.node", "conpty_console_list.node"].map(file => path.join(ptyRoot, "prebuilds", "win32-x64", file))];
  for (const file of files) { assertOrdinary(file, false); if (!within(modules, canonical(file, false))) fail("NATIVE_OUTSIDE_PACKAGE"); }
  const script = probeScript("const fs=require('node:fs'),path=require('node:path');const input=JSON.parse(process.argv[1]);for(const file of input.files)require(file);const loaded=Object.keys(require.cache).filter(file=>file.endsWith('.node')).map(file=>fs.realpathSync(file));if(!loaded.length||loaded.some(file=>{const r=path.relative(input.modules,file);return r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)}))throw Object.assign(new Error('native outside package'),{code:'DESKTOP_SHELL_HEALTH_NATIVE_OUTSIDE_PACKAGE'});process.stdout.write(JSON.stringify({loaded,credentialsAccessed:false,ptyCreated:false}));");
  const result = await runOwned(request.candidateExecutablePath, ["-e", script, JSON.stringify({ files, modules })],
    { cwd: request.temporaryRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: Math.min(request.timeoutMs, 30_000), capture: true });
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.loaded) || value.loaded.length < 4 || value.credentialsAccessed !== false || value.ptyCreated !== false) fail("NATIVE_INVALID");
  return value;
}

/** Client 已关闭后用同一候选 Electron 只读检查临时 DB，关闭失败同样使健康失败。 */
async function checkDatabase(dataDir: string, health: DesktopClientHealth, request: CandidateShellHealthRequest): Promise<CandidateShellHealthCheck["database"]> {
  const file = path.join(dataDir, "codeflowai.db"); assertOrdinary(file, false);
  const script = probeScript("const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});let failure;try{const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check,schemaVersion=db.prepare('PRAGMA user_version').get().user_version;if(integrity!=='ok'||schemaVersion!==Number(process.argv[2]))throw Object.assign(new Error('database invalid'),{code:'DESKTOP_SHELL_HEALTH_DATABASE_INVALID'});process.stdout.write(JSON.stringify({integrity,schemaVersion}));}catch(error){failure=error;throw error}finally{try{db.close()}catch(error){throw failure?new AggregateError([failure,error],'DESKTOP_SHELL_HEALTH_DATABASE_CLOSE_FAILED'):error}}");
  const result = await runOwned(request.candidateExecutablePath, ["-e", script, file, String(health.dbSchemaVersion)],
    { cwd: request.temporaryRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: Math.min(request.timeoutMs, 30_000), capture: true });
  const value = JSON.parse(result.stdout);
  if (value.integrity !== "ok" || value.schemaVersion !== health.dbSchemaVersion) fail("DATABASE_INVALID"); return value;
}

type OwnedProcess = { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; didClose: boolean;
  startedAt: number; exitedAt?: number; errors: unknown[] };
/** spawn后捕获子进程及输出流错误和真实close，不能以exit或零退出码掩盖错误。 */
function observeOwned(child: ChildProcess): OwnedProcess {
  // spawn 已同步取得 PID；一秒只用于覆盖调用返回与 Windows 创建时间的精度差，不用于放宽退出后的新进程。
  const owned: OwnedProcess = { child, didClose: false, startedAt: Date.now() - 1_000, errors: [], closed: Promise.resolve({ code: null, signal: null }) };
  /** 统一保留所属进程及双流错误，由关闭与清理入口显式失败。 */
  const recordError = (error: unknown): void => { owned.errors.push(error); };
  child.on("error", recordError);
  child.stdout?.on("error", recordError);
  child.stderr?.on("error", recordError);
  child.once("exit", () => { owned.exitedAt = Date.now(); });
  owned.closed = new Promise(resolve => child.once("close", (code, signal) => { owned.didClose = true; resolve({ code, signal }); }));
  return owned;
}

/** 有界等待只控制本次等待；超时后仍必须执行归属进程清理。 */
async function bounded<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { try { fail(code); } catch (error) { reject(error); } }, milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 保留关闭前及清理期间的全部错误，超时仅清理真实父链和创建窗口确认的本次进程。 */
async function finishOwned(owned: OwnedProcess, timeoutMs: number): Promise<void> {
  let failure: unknown, consumedEvents = 0;
  try {
    const result = await bounded(owned.closed, timeoutMs, "PROCESS_TIMEOUT");
    if (owned.errors.length) {
      consumedEvents = owned.errors.length;
      throw consumedEvents === 1 ? owned.errors[0] : new AggregateError([...owned.errors], "DESKTOP_SHELL_HEALTH_PROCESS_EVENTS_FAILED");
    }
    if (result.code !== 0 || result.signal !== null) throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_PROCESS_EXIT_FAILED"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_EXIT_FAILED", details: result });
    return;
  } catch (error) { failure = error; }
  if (!owned.didClose && owned.child.pid) {
    try {
      if (process.platform !== "win32") fail("PLATFORM_INVALID");
      const snapshot = await processSnapshot();
      const root = snapshot.find(item => item.pid === owned.child.pid);
      const rootAlive = owned.child.exitCode === null && owned.child.signalCode === null;
      if (rootAlive && (!root || root.parentPid !== process.pid || root.created < owned.startedAt
        || root.created > Date.now() || !samePath(root.executable, owned.child.spawnfile))) fail("PROCESS_IDENTITY_INVALID");
      const records = new Map<number, ProcessIdentity>();
      if (rootAlive && root) records.set(root.pid, root);
      const parentWindows = new Map<number, { start: number; end: number }>([[owned.child.pid,
        { start: rootAlive && root ? root.created : owned.startedAt, end: owned.exitedAt ?? Date.now() }]]);
      let added = true;
      while (added) {
        added = false;
        for (const item of snapshot) {
          const parent = parentWindows.get(item.parentPid);
          if (!parent || records.has(item.pid) || item.created < parent.start || item.created > parent.end + 1) continue;
          records.set(item.pid, item); parentWindows.set(item.pid, { start: item.created, end: Date.now() }); added = true;
        }
      }
      const cleanupErrors: unknown[] = [];
      for (const identity of [...records.values()].reverse()) {
        try { await stopIdentity(identity); } catch (error) { cleanupErrors.push(error); }
      }
      try { await bounded(owned.closed, 5_000, "PROCESS_CLEANUP_TIMEOUT"); } catch (error) { cleanupErrors.push(error); }
      try {
        const remaining = await processSnapshot();
        if ([...records.values()].some(identity => remaining.some(item => sameIdentity(item, identity)))) fail("PROCESS_REMAINS");
      } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "DESKTOP_SHELL_HEALTH_PROCESS_CLEANUP_FAILED");
    } catch (error) { failure = combine(failure, error, "PROCESS_CLEANUP_FAILED"); }
  }
  if (!owned.didClose) failure = combine(failure, new Error("DESKTOP_SHELL_HEALTH_PROCESS_REMAINS"), "PROCESS_CLEANUP_FAILED");
  const late = owned.errors.slice(consumedEvents);
  if (late.length) failure = new AggregateError([failure, ...late], "DESKTOP_SHELL_HEALTH_PROCESS_EVENTS_FAILED");
  throw failure;
}

/** 所有辅助进程沿同一归属关闭入口；输出只用于内部结构化检查。 */
async function runOwned(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; capture?: boolean }): Promise<{ stdout: string }> {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const owned = observeOwned(child); let stdout = "", stderr = "", overflow = false;
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 1_048_576) overflow = true; stdout = stdout.slice(-1_048_576); });
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 1_048_576) overflow = true; stderr = stderr.slice(-1_048_576); });
  try { await finishOwned(owned, options.timeoutMs); }
  catch (cause) {
    let probeFailure: unknown;
    for (const line of stderr.split(/\r?\n/u)) if (line.startsWith("CODEFLOW_HEALTH_PROBE_ERROR=")) {
      try { probeFailure = JSON.parse(line.slice("CODEFLOW_HEALTH_PROBE_ERROR=".length)); }
      catch (error) { throw new AggregateError([cause, error], "DESKTOP_SHELL_HEALTH_PROBE_ERROR_INVALID"); }
    }
    throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_PROCESS_FAILED", { cause }), { code: "DESKTOP_SHELL_HEALTH_PROCESS_FAILED", details: { probe: sanitizeStructuredFailure(probeFailure) } }); }
  if (overflow) fail("PROCESS_OUTPUT_LIMIT"); return { stdout };
}

/** 报告只接受同次身份和完整检查，不允许空结果或失败状态被当成成功。 */
export function validateCandidateShellHealthReport(input: unknown, request: CandidateShellHealthRequest,
  selections: ReadonlyArray<Pick<Selection, "role" | "releaseId" | "releaseDir">>): CandidateShellHealthReport {
  const value = input as CandidateShellHealthReport | null;
  if (!value || value.schemaVersion !== 1 || value.requestId !== request.requestId || value.candidateShellId !== request.candidateShellId
    || !samePath(value.temporaryRoot, request.temporaryRoot) || !["passed", "failed"].includes(value.status) || !Array.isArray(value.checks)
    || typeof value.phase !== "string" || value.phase.length > 64) fail("REPORT_INVALID");
  if (value.status === "passed" && (!value.checks.length || value.phase !== "complete" || value.error)) fail("REPORT_INVALID");
  if (value.status === "failed" && !value.error) fail("REPORT_INVALID");
  if (value.checks.length > selections.length || value.status === "passed" && value.checks.length !== selections.length) fail("REPORT_INVALID");
  for (const [index, check] of value.checks.entries()) {
    const selected = selections[index]!;
    if (check.role !== selected.role || check.releaseId !== selected.releaseId || !samePath(check.releaseDir, selected.releaseDir)) fail("REPORT_INVALID");
    if (!["baseline", "active"].includes(check.role) || typeof check.releaseId !== "string" || !path.isAbsolute(check.releaseDir)
      || check.childClosed !== true || check.health?.database !== "ready" || check.database?.integrity !== "ok"
      || check.database.schemaVersion !== check.health.dbSchemaVersion || check.native?.credentialsAccessed !== false || check.native.ptyCreated !== false
      || !Array.isArray(check.native.loaded) || check.native.loaded.length < 4 || !Array.isArray(check.web?.files) || !check.web.files.length) fail("REPORT_INVALID");
  }
  return value;
}

/** 安全原因只保留固定短码、阶段和有限根因链，未知正文不进入报告。 */
function safeFailure(error: unknown, depth = 0, seen = new Set<unknown>()): Record<string, unknown> {
  if (!(error instanceof Error) || depth > 6 || seen.has(error)) return { code: "UNKNOWN_ERROR" };
  seen.add(error); const value = error as Error & { code?: unknown; details?: unknown; phase?: unknown };
  const code = typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(value.code) ? value.code
    : /^[A-Z][A-Z0-9_]{2,95}(?=:|$)/u.exec(value.message)?.[0] ?? "UNKNOWN_ERROR";
  const result: Record<string, unknown> = { code };
  if (typeof value.phase === "string" && /^[a-z:-]{1,64}$/u.test(value.phase)) result.phase = value.phase;
  if (value.details && typeof value.details === "object") {
    const details = value.details as { code?: unknown; signal?: unknown; probe?: unknown };
    result.details = { ...(details.code === null || Number.isSafeInteger(details.code) ? { exitCode: details.code } : {}),
      ...(details.signal === null || typeof details.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(details.signal) ? { signal: details.signal } : {}),
      ...(details.probe ? { probe: sanitizeStructuredFailure(details.probe) } : {}) };
  }
  if (error.cause !== undefined) result.cause = safeFailure(error.cause, depth + 1, seen);
  if (error instanceof AggregateError) result.errors = error.errors.slice(0, 8).map(cause => safeFailure(cause, depth + 1, seen));
  return result;
}

/** 辅助探针以固定 JSON 协议报告安全系统码，绝不解析任意 stderr 为错误事实。 */
function probeScript(body: string): string {
  return "try{" + body + "}catch(error){const safe=(e,d=0)=>{if(!e||d>6)return{code:'UNKNOWN_ERROR'};const value={code:typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(e.code)?e.code:'UNKNOWN_ERROR'};if(Number.isSafeInteger(e.errno))value.errno=e.errno;if(e.cause)value.cause=safe(e.cause,d+1);if(e instanceof AggregateError)value.errors=e.errors.slice(0,8).map(c=>safe(c,d+1));return value};process.stderr.write('CODEFLOW_HEALTH_PROBE_ERROR='+JSON.stringify(safe(error))+'\\n');process.exitCode=1}";
}

/** 来自外进程的错误对象仅允许安全短码、数值 errno 和有限原因链。 */
function sanitizeStructuredFailure(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== "object" || depth > 6) return { code: "UNKNOWN_ERROR" };
  const value = input as { code?: unknown; errno?: unknown; cause?: unknown; errors?: unknown; details?: { probe?: unknown } };
  const result: Record<string, unknown> = { code: typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(value.code) ? value.code : "UNKNOWN_ERROR" };
  if (Number.isSafeInteger(value.errno)) result.errno = value.errno;
  if (value.cause) result.cause = sanitizeStructuredFailure(value.cause, depth + 1);
  if (Array.isArray(value.errors)) result.errors = value.errors.slice(0, 8).map(error => sanitizeStructuredFailure(error, depth + 1));
  if (value.details && typeof value.details === "object" && value.details.probe) result.details = { probe: sanitizeStructuredFailure(value.details.probe, depth + 1) };
  return result;
}

/** 启动分流的唯一失败出口；未验证请求仅写 stderr，不能沿不可信路径落盘。 */
export async function reportCandidateShellHealthFailure(request: CandidateShellHealthRequest | null, error: unknown, phase: "request" | "bootstrap", persist: boolean): Promise<void> {
  let failure = error;
  if (request && persist) {
    const report: CandidateShellHealthReport = { schemaVersion: 1, requestId: request.requestId, candidateShellId: request.candidateShellId,
      temporaryRoot: request.temporaryRoot, status: "failed", checks: [], phase, error: safeFailure(error) };
    try { await writeReport(request, report, "report.json"); } catch (cause) { failure = combine(failure, cause, "REPORT_FAILED"); }
  }
  await new Promise<void>((resolve, reject) => process.stderr.write(`${JSON.stringify({ errorCode: "DESKTOP_SHELL_HEALTH_FAILED", requestId: request?.requestId ?? crypto.randomUUID(),
    candidateShellId: request?.candidateShellId, phase, rootCause: safeFailure(failure) })}\n`, error => error ? reject(error) : resolve()));
  // 调用方在该诊断边界结算后以非零码退出；记录失败仍由 rejection 显式交还。
  if (failure !== error) throw failure;
}

/** 将已脱敏子报告还原为错误码链，父失败不丢候选阶段的原始原因。 */
function structuredError(input: unknown, depth = 0): Error {
  const value = sanitizeStructuredFailure(input, depth) as { code: string; cause?: unknown; errors?: unknown[]; details?: { probe?: unknown } };
  if (value.details?.probe) value.errors = [...(value.errors ?? []), ...(value.cause ? [value.cause] : []), value.details.probe];
  const error = value.errors ? new AggregateError(value.errors.map(item => structuredError(item, depth + 1)), value.code)
    : new Error(value.code, value.cause ? { cause: structuredError(value.cause, depth + 1) } : undefined);
  return Object.assign(error, { code: value.code });
}

/** 原子独占报告与一次失败日志在已验证临时根下写入，失败不降级。 */
async function writeReport(request: CandidateShellHealthRequest, report: CandidateShellHealthReport, name: string): Promise<void> {
  assertOrdinary(request.temporaryRoot, true);
  await fsp.writeFile(path.join(request.temporaryRoot, name), `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx" });
  if (name === "parent-report.json") await fsp.writeFile(path.join(request.temporaryRoot, "health-errors.jsonl"), `${JSON.stringify({
    errorCode: "DESKTOP_SHELL_HEALTH_FAILED", requestId: request.requestId, candidateShellId: request.candidateShellId,
    phase: report.phase, releaseId: report.releaseId, childPhase: report.childPhase, rootCause: report.error })}\n`, { encoding: "utf8", flag: "wx" });
}

/** 请求只接受固定字段、真实普通路径和完全分离的输入输出。 */
function validateRequest(input: unknown, executablePath: string, fresh = true): CandidateShellHealthRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("REQUEST_INVALID");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== REQUEST_KEYS.length || Object.keys(value).some(key => !REQUEST_KEYS.includes(key))
    || value.schemaVersion !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId)) fail("REQUEST_INVALID");
  for (const key of ["installationDir", "sourceDataDir", "candidateExecutablePath", "temporaryRoot"] as const) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key])) fail("PATH_INVALID");
    const actual = canonical(value[key], key !== "candidateExecutablePath");
    if (!samePath(actual, value[key])) fail("PATH_INVALID");
  }
  const request = value as CandidateShellHealthRequest;
  const id = validId(request.candidateShellId);
  if (!samePath(request.candidateExecutablePath, path.join(request.installationDir, "shells", id, "CodeFlowAI.exe"))
    || !samePath(canonical(executablePath, false), request.candidateExecutablePath)) fail("PATH_INVALID");
  separate(request.installationDir, request.sourceDataDir);
  separate(request.installationDir, request.temporaryRoot); separate(request.sourceDataDir, request.temporaryRoot);
  validTimeout(request.timeoutMs);
  const directories = new Set([...Object.values(DIRECTORY_ENV), "user-data", "session-data"]);
  for (const directory of directories) {
    const target = path.join(request.temporaryRoot, directory); assertOrdinary(target, true);
    if (fresh && fs.readdirSync(target).length) fail("OUTPUT_NOT_FRESH");
  }
  return request;
}

/** 读取前后均校验普通文件和身份；最多读取 64 KiB 加一字节。 */
function readBounded(file: string): string {
  assertOrdinary(file, false);
  const before = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let failure: unknown;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > 65_536 || stat.ino !== before.ino || stat.dev !== before.dev) fail("REQUEST_INVALID");
    const bytes = Buffer.alloc(65_537); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    const after = fs.lstatSync(file);
    if (length > 65_536 || stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) fail("REQUEST_INVALID");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) { failure = error; throw error; }
  finally { try { fs.closeSync(fd); } catch (error) { throw combine(failure, error, "REQUEST_CLOSE_FAILED"); } }
}

/** 逐段拒绝链接和类型错误，不能用 realpath 将内部 junction 洗成普通目录。 */
function assertOrdinary(file: string, directory: boolean, view: typeof fs = fs): void {
  try {
    const absolute = path.resolve(file), root = path.parse(absolute).root;
    let current = root;
    for (const [index, segment] of path.relative(root, absolute).split(path.sep).entries()) {
      current = path.join(current, segment); const stat = view.lstatSync(current);
      const last = samePath(current, absolute);
      if (stat.isSymbolicLink() || (last && !directory ? !stat.isFile() : !stat.isDirectory())) fail("PATH_INVALID");
      if (index > 256) fail("PATH_INVALID");
    }
  } catch (cause) { if (isHealthError(cause)) throw cause; fail("PATH_INVALID", cause); }
}

/** 根路径先核链接再取规范名称，允许 Windows 长短名和大小写等价。 */
function canonical(file: string, directory: boolean): string { assertOrdinary(file, directory); return fs.realpathSync(file); }
/** Windows 路径按文件系统大小写口径比较。 */
function samePath(left: string, right: string): boolean { return path.relative(left, right) === ""; }
/** 路径包含关系同时覆盖相等。 */
function within(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
/** 输入、输出不允许任何方向的相互包含。 */
function separate(left: string, right: string): void { if (within(left, right) || within(right, left)) fail("PATH_INVALID"); }
/** 候选 ID 沿共享发布 ID 合同，不接受路径与设备名。 */
function validId(value: unknown): string { try { if (typeof value !== "string" || value.length > 128) fail("REQUEST_INVALID"); return assertReleaseId(value); } catch (cause) { fail("REQUEST_INVALID", cause); } }
/** 单次操作预算必须有限，不能通过无穷等待阻碍清理。 */
function validTimeout(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1_000 || (value as number) > 300_000) fail("REQUEST_INVALID"); return value as number; }
/** 组合错误保留原始失败和清理失败，不用后者覆盖前者。 */
function combine(original: unknown, next: unknown, code: string): Error { return original === undefined ? next instanceof Error ? next : new Error(String(next)) : new AggregateError([original, next], `DESKTOP_SHELL_HEALTH_${code}`); }
/** 领域短码允许上层辨别预期失败，不回显请求或参数。 */
function isHealthError(error: unknown): error is HealthError { return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("DESKTOP_SHELL_HEALTH_"); }
/** 统一失败保留内存根因；日志只投影安全字段。 */
function fail(code: string, cause?: unknown): never { const value = `DESKTOP_SHELL_HEALTH_${code}`; throw Object.assign(new Error(value, cause === undefined ? undefined : { cause }), { code: value }); }
