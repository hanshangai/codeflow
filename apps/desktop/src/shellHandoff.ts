import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotDesktopStartupReady } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, type TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import type { DesktopStartupReadyFacts } from "./desktopApplication.js";
import { createShellUpdateAttemptStore, decideShellUpdateRecovery, isShellUpdateHandoffAttempt, shellUpdateHandoffRevision, shellUpdateProcessInventory, shellUpdateProcessSnapshotContext,
  shellUpdateProcessHistory, assertShellUpdateInventoryReleased, assertShellUpdateInventoryExtension, snapshotShellUpdateReadyEvidence, type ShellUpdateHandoffAttempt, type ShellUpdateReadyEvidence,
  type ShellUpdateTerminalEvidence, type ShellUpdatePreparationAttemptV5 } from "./shellUpdateAttempt.js";
import { readShellLaunchState, resolveVersionedShellStartup, serializeShellLaunchState } from "./shellLaunchState.js";
import { processSnapshot, sameIdentity, stopIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";
import { resolveActiveRelease, resolveBaselineRelease } from "./releaseBundleCoordinator.js";

export const SHELL_HANDOFF_FLAG = "--codeflow-shell-handoff";
/** 交接包含完整验签和哈希核验，所有参与方共用五分钟有界等待。 */
export const DEFAULT_SHELL_HANDOFF_TIMEOUT_MS = 300_000;
export type ShellHandoffChannel = {
  connected?: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};
type MessageBodies = {
  arm: { oldMain: ProcessIdentity }; armed: { helper: ProcessIdentity }; accept: {}; accepted: {}; drained: {}; switched: {}; "exit-request": {};
  bootstrap: { role: "candidate" | "original"; main: ProcessIdentity }; ready: { ready: ShellUpdateReadyEvidence }; permit: {};
  started: { terminalEvidence: ShellUpdateTerminalEvidence };
};
export type ShellHandoffKind = keyof MessageBodies;
export type ShellHandoffMessage<K extends ShellHandoffKind = ShellHandoffKind> = { [P in K]: {
  t: "desktop.shell-handoff"; schemaVersion: 1; kind: P; requestId: string; continuationId: string; revision: number; nonce: string; body: MessageBodies[P];
} }[K];
type StartupInput = {
  executablePath: string; pid: number; parentPid: number; dataDir: string; userDataDir: string; sessionDataDir: string;
  argv: string[]; channel?: ShellHandoffChannel; timeoutMs?: number; snapshot?: typeof processSnapshot;
  trustedKeys?: TrustedReleaseKeys;
};
export type ShellHandoffInbox = ReturnType<typeof createShellHandoffInbox>;
export type ShellRecoveryControllerOwner = {
  readonly helper: ProcessIdentity | undefined; readonly closed: Promise<void>; readonly didClose: boolean; readonly released: boolean;
  assertHealthy(): void; close(): Promise<void>; dispose(): void;
};
export type ShellHandoffStartup = { kind: "ordinary" } | { kind: "recovery-control"; attempt: unknown; decision: { action: string; reason: string } }
  | { kind: "held-candidate"; attempt: ShellUpdateHandoffAttempt; bootstrap: ShellHandoffMessage<"bootstrap">;
      inbox: ShellHandoffInbox; channel: ShellHandoffChannel; input: StartupInput };

/** 仅真实版本壳开放原更新入口；非版本壳/开发态不启用，已匹配布局的事实失配明确失败。 */
export async function readShellUpdateHostFacts(input: Pick<StartupInput, "executablePath" | "pid" | "parentPid" | "userDataDir" | "sessionDataDir" | "snapshot"> & {
  packaged: boolean; platform: string; configuredServerOrigin?: string;
}): Promise<{ installationDir: string; userDataDir: string; sessionDataDir: string; main: ProcessIdentity } | undefined> {
  if (!input.packaged || input.platform !== "win32" || !input.configuredServerOrigin) return undefined;
  const startup = await resolveVersionedShellStartup(input.executablePath);
  if (!startup) return undefined;
  const installationDir = path.dirname(path.dirname(path.dirname(input.executablePath)));
  for (const directory of [installationDir, input.userDataDir, input.sessionDataDir]) if (!path.isAbsolute(directory) || await fs.realpath(directory) !== directory) fail("HOST_PROFILE_INVALID");
  if (startup.executablePath !== input.executablePath) fail("HOST_SHELL_INVALID");
  const processes = await (input.snapshot ?? processSnapshot)(), observed = processes.find(item => item.pid === input.pid);
  const main = identity(observed);
  if (main.parentPid !== input.parentPid || main.executable !== input.executablePath || main.created > Date.now()) fail("HOST_PROCESS_INVALID");
  return { installationDir, userDataDir: input.userDataDir, sessionDataDir: input.sessionDataDir, main: structuredClone(main) };
}

/** 主进程日志只投影稳定上下文、短码和已核诊断；不执行访问器或记录进程正文。 */
export function snapshotShellHandoffErrorContext(input: unknown): {
  requestId?: string; shellId?: string; revision?: number; phase?: string; installerRequestId?: string; causeCodes: string[]; diagnostic?: Record<string, unknown>;
  processIdentityConflicts?: ReturnType<typeof identityConflictDiagnostic>[];
  inventoryFailures?: ReturnType<typeof inventoryFailureDiagnostic>[];
} {
  const result: ReturnType<typeof snapshotShellHandoffErrorContext> = { causeCodes: [] };
  const pending = [input], seen = new Set<unknown>();
  /** 仅自有数据属性可进入安全投影，不求值异常对象上自报的 getter。 */
  const own = (value: unknown, key: string): unknown => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  while (pending.length && seen.size < 32) {
    const value = pending.shift(); if (seen.has(value)) continue; seen.add(value);
    if (value && typeof value === "object" && Object.hasOwn(value, "processIdentityConflict")) {
      try { (result.processIdentityConflicts ??= []).push(identityConflictDiagnostic(diagnosticData(value, "processIdentityConflict"))); }
      catch (cause) { throw new AggregateError([input, cause], "DESKTOP_SHELL_HANDOFF_IDENTITY_CONFLICT_DIAGNOSTIC_FAILED"); }
    }
    if (value && typeof value === "object" && Object.hasOwn(value, "inventoryFailure")) {
      try { (result.inventoryFailures ??= []).push(inventoryFailureDiagnostic(diagnosticData(value, "inventoryFailure"))); }
      catch (cause) { throw new AggregateError([input, cause], "DESKTOP_SHELL_HANDOFF_INVENTORY_DIAGNOSTIC_FAILED"); }
    }
    const code = own(value, "code"), safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : value === undefined ? "UNDEFINED" : value instanceof Error ? "ERROR" : "NON_ERROR";
    if (!result.causeCodes.includes(safeCode)) result.causeCodes.push(safeCode);
    for (const key of ["requestId", "shellId", "installerRequestId", "phase"] as const) {
      const field = own(value, key);
      if (result[key] !== undefined || typeof field !== "string") continue;
      if (key === "requestId" ? requestId(field) : key === "installerRequestId" ? /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(field)
        : key === "phase" ? /^[a-z][a-z0-9:-]{0,63}$/u.test(field) : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(field)) result[key] = field;
    }
    const revision = own(value, "revision"); if (result.revision === undefined && Number.isSafeInteger(revision) && (revision as number) >= 0) result.revision = revision as number;
    const diagnostic = own(own(value, "details"), "diagnostic"), diagnosticId = own(diagnostic, "requestId"), stage = own(diagnostic, "stage"), win32Error = own(diagnostic, "win32Error"), shellId = own(diagnostic, "shellId");
    if (!result.diagnostic && own(diagnostic, "errorCode") === "DESKTOP_SHELL_INSTALL_FAILED" && typeof diagnosticId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(diagnosticId)
      && typeof shellId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(shellId) && typeof stage === "string" && ["arguments", "root", "create-target", "extract-temp", "extract"].includes(stage)
      && Number.isSafeInteger(win32Error) && (win32Error as number) >= 0 && (win32Error as number) <= 0xffff_ffff) {
      const cleanup = own(diagnostic, "cleanupWin32Error");
      const rootCause = own(diagnostic, "rootCause");
      result.diagnostic = { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId: diagnosticId, shellId, stage, win32Error,
        ...(typeof rootCause === "string" && ["ARGUMENTS_INVALID", "ARGUMENT_PARSE_FAILED", "ARGUMENT_RELEASE_FAILED", "PATH_UNAVAILABLE", "PATH_REPARSE", "PATH_NOT_DIRECTORY", "ROOT_DRIVE_UNSUPPORTED", "ROOT_INVALID", "TARGET_CREATE_FAILED", "PAYLOAD_DIRECTORY_FAILED", "PAYLOAD_WRITE_FAILED", "PAYLOAD_TEMP_FAILED"].includes(rootCause) ? { rootCause } : {}),
        ...(Number.isSafeInteger(cleanup) && (cleanup as number) >= 0 && (cleanup as number) <= 0xffff_ffff ? { cleanupWin32Error: cleanup } : {}) };
    }
    if (value && typeof value === "object" && Object.hasOwn(value, "cause")) pending.push(own(value, "cause"));
    if (value instanceof AggregateError) {
      const errors = own(value, "errors");
      if (Array.isArray(errors)) for (let index = 0; index < 16; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
        if (descriptor && Object.hasOwn(descriptor, "value")) pending.push(descriptor.value);
        else if (descriptor && !result.causeCodes.includes("AGGREGATE_ERROR_ACCESSOR_OMITTED")) result.causeCodes.push("AGGREGATE_ERROR_ACCESSOR_OMITTED");
      }
      else if (!result.causeCodes.includes("AGGREGATE_ERRORS_UNAVAILABLE")) result.causeCodes.push("AGGREGATE_ERRORS_UNAVAILABLE");
    }
  }
  return result;
}

/** 错误及诊断字段必须是自有数据属性，不调用可能隐藏副作用的getter。 */
export function diagnosticData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, "value")) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  return descriptor?.value;
}
/** 安全投影只接受精确白名单普通对象，拒绝额外字段和原型载荷。 */
export function diagnosticRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  return Object.fromEntries(keys.map(key => [key, diagnosticData(value, key)]));
}
/** 数组按自有索引复制，拒绝稀疏项、访问器和额外属性，不执行迭代器。 */
export function diagnosticArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  const length = diagnosticData(value, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 0 || Reflect.ownKeys(value).length !== (length as number) + 1) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  return Array.from({ length: length as number }, (_, index) => {
    if (!Object.hasOwn(value, index)) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
    return diagnosticData(value, index);
  });
}
/** main/helper共用既有冲突白名单，校验变化字段和值域后返回安全副本。 */
export function identityConflictDiagnostic(value: unknown) {
  const record = diagnosticRecord(value, ["pid", "changedFields", "expected", "actual"]);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  /** 原身份须完整，实际快照允许创建时间暂缺为0。 */
  const project = (input: unknown, minimumCreated: number) => {
    const data = diagnosticRecord(input, ["parentPid", "created", "executableSha256", "commandLineSha256"]);
    if (!Number.isSafeInteger(data.parentPid) || (data.parentPid as number) < 0
      || !Number.isSafeInteger(data.created) || (data.created as number) < minimumCreated
      || typeof data.executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.executableSha256)
      || typeof data.commandLineSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.commandLineSha256)) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
    return { parentPid: data.parentPid as number, created: data.created as number,
      executableSha256: data.executableSha256, commandLineSha256: data.commandLineSha256 };
  };
  const expected = project(record.expected, 1), actual = project(record.actual, 0), changedFields = diagnosticArray(record.changedFields);
  if (!changedFields.length || changedFields.length > 4 || changedFields.some(field => typeof field !== "string"
    || !["parentPid", "created", "executable", "commandLine"].includes(field))) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  const emptySha256 = crypto.createHash("sha256").update("").digest("hex");
  const differences = [expected.parentPid !== actual.parentPid && "parentPid", expected.created !== actual.created && "created",
    actual.executableSha256 !== emptySha256 && expected.executableSha256 !== actual.executableSha256 && "executable",
    actual.commandLineSha256 !== emptySha256 && expected.commandLineSha256 !== actual.commandLineSha256 && "commandLine"].filter(Boolean);
  if (!equal(changedFields, differences)) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  return { pid: record.pid as number, changedFields, expected, actual };
}

/** main/helper共用库存诊断，只接观察或严格读取的固定原因与实例摘要。 */
export function inventoryFailureDiagnostic(value: unknown) {
  const data = diagnosticRecord(value, ["reason", "pid", "parentPid", "created", "instanceSha256"]);
  if (!["OBSERVER_UNAVAILABLE", "ACTIVE_IDENTITY_CHANGED", "RELEASED_IDENTITY_REAPPEARED", "RELEASED_IDENTITY_INVALID",
    "UNKNOWN_PARENT_MISSING", "CHILD_PREDATES_PARENT", "CHILD_ROLE_CONFLICT", "RELATED_IDENTITY_INVALID", "CHILD_IDENTITY_INVALID"].includes(data.reason as string)
    || !Number.isSafeInteger(data.pid) || (data.pid as number) < 1 || !Number.isSafeInteger(data.parentPid) || (data.parentPid as number) < 0
    || !Number.isSafeInteger(data.created) || (data.created as number) < 0
    || typeof data.instanceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.instanceSha256)) fail("IDENTITY_CONFLICT_DIAGNOSTIC_INVALID");
  return data;
}

/** 单一IPC信封和body结构校验；不把载荷、nonce或未验证身份放入异常。 */
export function readShellHandoffMessage(input: unknown): ShellHandoffMessage {
  const value = record(input, ["t", "schemaVersion", "kind", "requestId", "continuationId", "revision", "nonce", "body"]);
  if (value.t !== "desktop.shell-handoff" || value.schemaVersion !== 1 || !requestId(value.requestId)
    || typeof value.continuationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.continuationId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(value.nonce)) fail("MESSAGE_INVALID");
  const keys: Record<ShellHandoffKind, string[]> = { arm: ["oldMain"], armed: ["helper"], accept: [], accepted: [], drained: [], switched: [], "exit-request": [],
    bootstrap: ["role", "main"], ready: ["ready"], permit: [], started: ["terminalEvidence"] };
  if (typeof value.kind !== "string" || !Object.hasOwn(keys, value.kind)) fail("MESSAGE_INVALID");
  const body = record(value.body, keys[value.kind as ShellHandoffKind]);
  if (value.kind === "arm") identity(body.oldMain);
  if (value.kind === "armed") identity(body.helper);
  if (value.kind === "bootstrap") { if (!["candidate", "original"].includes(body.role)) fail("MESSAGE_INVALID"); identity(body.main); }
  if (value.kind === "ready") readyShape(body.ready);
  if (value.kind === "started") {
    const terminal = record(body.terminalEvidence, ["ready", "startedRequestId", "continueRequestId", "startup", "application"]);
    readyShape(terminal.ready);
    if (!requestId(terminal.startedRequestId) || !requestId(terminal.continueRequestId) || terminal.startup !== "completed" || terminal.application !== "started") fail("MESSAGE_INVALID");
  }
  return structuredClone(value) as ShellHandoffMessage;
}

/** 发送仍走继承IPC；回调失败显式交还调用方，不记录消息正文。 */
export async function sendShellHandoffMessage(channel: ShellHandoffChannel, input: ShellHandoffMessage): Promise<void> {
  const message = readShellHandoffMessage(input);
  if (!channel.connected || !channel.send) fail("CHANNEL_UNAVAILABLE");
  await new Promise<void>((resolve, reject) => channel.send!(message, error => error ? reject(error) : resolve()));
}

/** 只接当前明确等待的消息；乱序、重复或断链锁定失败，不缓冲成未来许可。 */
export function createShellHandoffInbox(channel: ShellHandoffChannel, timeoutMs = DEFAULT_SHELL_HANDOFF_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail("TIMEOUT_INVALID");
  let failed: { cause: unknown } | undefined, disposed = false;
  let pending: { kind: ShellHandoffKind; resolve(value: ShellHandoffMessage): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> } | undefined;
  /** 首个通道错误保留到所有后续等待，防止重复消息重新开启流程。 */
  const reject = (cause: unknown) => { failed ??= { cause }; if (pending) { clearTimeout(pending.timer); const current = pending; pending = undefined; current.reject(failed.cause); } };
  const onMessage = (input: unknown) => {
    try { const message = readShellHandoffMessage(input); if (!pending || message.kind !== pending.kind) fail("MESSAGE_ORDER_INVALID");
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message); }
    catch (cause) { reject(cause); }
  };
  const onDisconnect = () => reject(error("CHANNEL_CLOSED"));
  const onError = (cause: unknown) => reject(cause);
  channel.on("message", onMessage); channel.on("disconnect", onDisconnect); channel.on("error", onError);
  return {
    /** 每次只开放一个预期kind，revision/nonce等因果由具体会话核验。 */
    async next<K extends ShellHandoffKind>(kind: K): Promise<ShellHandoffMessage<K>> {
      if (failed) throw failed.cause;
      if (disposed || pending) fail("MESSAGE_ORDER_INVALID");
      return await new Promise<ShellHandoffMessage<K>>((resolve, rejectPromise) => {
        const timer = setTimeout(() => reject(error("TIMEOUT")), timeoutMs);
        pending = { kind, resolve: value => resolve(value as ShellHandoffMessage<K>), reject: rejectPromise, timer };
      });
    },
    /** 在后续副作用前检查等待之间发生的乱序/断链。 */
    check(): void { if (failed) throw failed.cause; if (disposed) fail("CHANNEL_CLOSED"); },
    /** 注销本会话监听；未结等待显式失败，调用方继续拥有进程关闭职责。 */
    dispose(): void { if (disposed) return; disposed = true; reject(error("CHANNEL_CLOSED"));
      channel.removeListener("message", onMessage); channel.removeListener("disconnect", onDisconnect); channel.removeListener("error", onError); },
  };
}

/** 只在已创建且由调用方持有close的helper上完成arm握手，不创建或清理第二进程owner。 */
export async function startShellHandoffHelper(input: { channel: ShellHandoffChannel; oldMain: ProcessIdentity; helper: ProcessIdentity;
  requestId: string; continuationId: string; revision: number; nonce: string; timeoutMs?: number; snapshot?: typeof processSnapshot }) {
  const inbox = createShellHandoffInbox(input.channel, input.timeoutMs);
  try {
    const observed = await (input.snapshot ?? processSnapshot)();
    if (input.helper.parentPid !== input.oldMain.pid || !observed.some(item => sameIdentity(item, input.oldMain))
      || !observed.some(item => sameIdentity(item, input.helper))) fail("PROCESS_IDENTITY_INVALID");
    const [result] = await Promise.all([inbox.next("armed"), sendShellHandoffMessage(input.channel, { t: "desktop.shell-handoff", schemaVersion: 1, kind: "arm", requestId: input.requestId,
      continuationId: input.continuationId, revision: input.revision, nonce: input.nonce, body: { oldMain: input.oldMain } })]);
    correlated(result, input);
    if (result.revision !== input.revision || !sameIdentity(result.body.helper, input.helper)) fail("PROCESS_IDENTITY_INVALID");
    return { inbox, helper: input.helper };
  } catch (cause) { inbox.dispose(); throw cause; }
}

/** 单实例锁由 main 持有；本入口只创建零 Client controller 的一个恢复 helper 并提交同 attempt claim。 */
export async function startShellRecoveryController(input: StartupInput & {
  helperScriptPath?: string; onOwned?(owner: ShellRecoveryControllerOwner): void;
  boundary?: { spawn: typeof spawn; stop: typeof stopIdentity };
}): Promise<ShellRecoveryControllerOwner> {
  const store = createShellUpdateAttemptStore(input.dataDir);
  const timeout = input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS;
  let owner: ShellRecoveryControllerOwner | undefined, armed: Awaited<ReturnType<typeof startShellHandoffHelper>> | undefined;
  let attempt: ShellUpdateHandoffAttempt | undefined;
  /** 当前恢复事实只提供纯查询预检，helper清理权限仍由已持有owner决定。 */
  const snapshot = input.snapshot ?? (() => processSnapshot(attempt && attempt.schemaVersion !== 3
    ? shellUpdateProcessSnapshotContext(attempt, owner?.helper ? [owner.helper] : []) : undefined));
  try {
    const value = await store.read();
    if (!value || !isShellUpdateHandoffAttempt(value) || !Object.hasOwn(value, "owned") || value.recovery?.terminalEvidence
      || !value.recovery && ["completed", "restored"].includes(value.phase)) fail("RECOVERY_INVENTORY_REQUIRED");
    attempt = value;
    const launchOptions = attempt.admission === null ? { restoreOriginal: { originalState: attempt.originalState, candidateState: attempt.candidateState, admission: null } } : undefined;
    await matchingProfile(input, attempt);
    const before = await snapshot(), caller = before.find(item => item.pid === input.pid);
    if (!caller || caller.parentPid !== input.parentPid || caller.executable !== input.executablePath) fail("PROCESS_IDENTITY_INVALID");
    assertShellUpdateInventoryReleased(attempt, before);
    const initialLaunch = await readShellLaunchState(attempt.installationDir, launchOptions);
    if (!equal(initialLaunch.state, attempt.originalState) && !equal(initialLaunch.state, attempt.candidateState)
      || initialLaunch.executablePath !== caller.executable && (attempt.admission !== null
        || caller.executable !== path.join(attempt.installationDir, "shells", attempt.originalState.activeShellId, "CodeFlowAI.exe"))
      || attempt.admission && !equal(initialLaunch.state, attempt.candidateState)) fail("STARTUP_FACTS_INVALID");
    await currentBinding(input, attempt, true);
    if (!equal(await store.read(), attempt)) fail("STATE_CONFLICT");
    // Windows下helper跨越controller正常退出，失败清理和owner边界保持不变。
    const child = (input.boundary?.spawn ?? spawn)(input.executablePath,
      [input.helperScriptPath ?? fileURLToPath(new URL("./shellHandoffHelper.js", import.meta.url)), "--codeflow-shell-recovery-helper", input.dataDir],
      { cwd: attempt.installationDir, windowsHide: true, detached: process.platform === "win32", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let helper: ProcessIdentity | undefined, didClose = false, released = false;
    const failures: unknown[] = [];
    const onError = (cause: unknown) => { failures.push(cause); };
    child.on("error", onError);
    const closed = new Promise<void>(resolve => child.once("close", () => { didClose = true; resolve(); }));
    owner = {
      get helper() { return helper; }, closed, get didClose() { return didClose; }, get released() { return released; },
      /** helper 尚未接管前的 error/close 不得被看成握手成功。 */
      assertHealthy() { if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError([...failures], "DESKTOP_SHELL_RECOVERY_HELPER_ERRORS"); if (didClose) fail("RECOVERY_HELPER_CLOSED"); },
      /** 精确清理本controller的helper；历史早行不形成父链，未知后代和查询失败保留owner。 */
      async close() {
        const cleanup: unknown[] = [];
        const observedErrors = failures.length;
        try {
          const processes = await snapshot();
          if (!helper) fail("RECOVERY_HELPER_IDENTITY_UNKNOWN");
          else {
            const actual = processes.find(item => item.pid === helper!.pid);
            if (actual && !sameIdentity(actual, helper)) fail("PROCESS_IDENTITY_INVALID");
            if (processes.some(item => item.parentPid === helper!.pid
              && !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < helper!.created))) fail("RECOVERY_HELPER_DESCENDANT_UNKNOWN");
            if (actual) await (input.boundary?.stop ?? stopIdentity)(helper);
          }
        } catch (cause) { cleanup.push(cause); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(error("RECOVERY_HELPER_CLOSE_TIMEOUT")), timeout); })]); }
        catch (cause) { cleanup.push(cause); }
        finally { clearTimeout(timer); }
        try { if (helper) assertReleased([helper], await snapshot()); } catch (cause) { cleanup.push(cause); }
        cleanup.push(...failures.slice(observedErrors));
        if (cleanup.length) throw new AggregateError(cleanup, "DESKTOP_SHELL_RECOVERY_HELPER_CLEANUP_FAILED");
        released = true;
      },
      /** 生命周期监听只在明确关闭后移除，未释放失败不得丢管理。 */
      dispose() { if (!didClose) fail("RECOVERY_HELPER_NOT_CLOSED"); child.removeListener("error", onError); },
    };
    input.onOwned?.(owner);
    const deadline = Date.now() + timeout;
    do {
      owner.assertHealthy();
      const processes = await snapshot(), current = processes.find(item => item.pid === child.pid);
      if (current) {
        if (current.parentPid !== caller.pid || current.executable !== caller.executable || current.created < caller.created) fail("PROCESS_IDENTITY_INVALID");
        helper = current; break;
      }
      if (Date.now() >= deadline) fail("RECOVERY_HELPER_IDENTITY_UNKNOWN");
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    const nonce = crypto.randomBytes(32).toString("hex");
    // recovery 模式的 arm.oldMain 指当前零 Client controller，历史 oldMain 始终保留在 attempt。
    armed = await startShellHandoffHelper({ channel: child, oldMain: caller, helper: helper!, requestId: attempt.requestId,
      continuationId: attempt.continuationId, revision: shellUpdateHandoffRevision(attempt), nonce, timeoutMs: timeout, snapshot });
    await matchingProfile(input, attempt); const launch = await readShellLaunchState(attempt.installationDir, launchOptions);
    const binding = await currentBinding(input, attempt, true);
    const processes = await snapshot(); assertShellUpdateInventoryReleased(attempt, processes);
    if (!processes.some(item => sameIdentity(item, caller)) || !processes.some(item => sameIdentity(item, helper!))
      || !equal((await readShellLaunchState(attempt.installationDir, launchOptions)).state, launch.state)) fail("RECOVERY_FACTS_CHANGED");
    const claimed = await store.beginRecovery(attempt, { caller, helper, processes,
      owner: { status: "gone", identity: attempt.helper }, oldMain: { status: "gone", identity: attempt.oldMain },
      selectedMain: attempt.selectedMain ? { status: "gone", identity: attempt.selectedMain } : { status: "not-started" },
      launchState: { status: "known", value: launch.state }, binding: { status: "matched", value: binding },
      profile: { status: "known", dataDir: input.dataDir, userDataDir: input.userDataDir, sessionDataDir: input.sessionDataDir },
      ownedReleased: "verified", knownOwned: { status: "known", identities: shellUpdateProcessHistory(attempt) } });
    const accepted = await sendAndWait(armed.inbox, child, "accepted", { t: "desktop.shell-handoff", schemaVersion: 1, kind: "accept",
      requestId: claimed.requestId, continuationId: claimed.continuationId, revision: shellUpdateHandoffRevision(claimed), nonce, body: {} });
    correlated(accepted, { ...claimed, nonce }); if (accepted.revision !== shellUpdateHandoffRevision(claimed)) fail("REVISION_CONFLICT");
    owner.assertHealthy(); armed.inbox.dispose(); return owner;
  } catch (cause) {
    armed?.inbox.dispose(); let failure = cause;
    if (owner) { try { await owner.close(); owner.dispose(); } catch (cleanup) { failure = new AggregateError([cause, cleanup], "DESKTOP_SHELL_RECOVERY_CONTROLLER_CLEANUP_FAILED"); } }
    throw Object.assign(new Error("DESKTOP_SHELL_RECOVERY_CONTROLLER_FAILED", { cause: failure }), { code: "DESKTOP_SHELL_RECOVERY_CONTROLLER_FAILED", requestId: attempt?.requestId, owner });
  }
}

/** Client创建前读取唯一attempt；交接前确定网络失败只保留原壳普通启动资格，不复活更新。 */
export async function readShellHandoffStartup(input: StartupInput): Promise<ShellHandoffStartup> {
  const flags = input.argv.filter(arg => arg.startsWith(SHELL_HANDOFF_FLAG));
  if (flags.length > 1 || flags.length === 1 && flags[0] !== SHELL_HANDOFF_FLAG) fail("ARGUMENT_INVALID");
  const inbox = flags.length ? createShellHandoffInbox(requiredChannel(input.channel), input.timeoutMs) : undefined;
  let preparationContext: Pick<ShellUpdatePreparationAttemptV5, "requestId" | "revision" | "phase"> | undefined;
  try {
    const bootstrap = inbox ? await inbox.next("bootstrap") : undefined;
    let root: string;
    try { root = await fs.realpath(input.dataDir); }
    catch (cause) { if (!bootstrap && cause instanceof Error && "code" in cause && cause.code === "ENOENT") return { kind: "ordinary" }; throw cause; }
    const store = createShellUpdateAttemptStore(root), attempt = await store.read();
    if (attempt?.schemaVersion === 5 && !isShellUpdateHandoffAttempt(attempt))
      preparationContext = { requestId: attempt.requestId, revision: attempt.revision, phase: attempt.phase };
    if (attempt === null) { if (bootstrap) fail("ATTEMPT_REQUIRED"); return { kind: "ordinary" }; }
    if (root !== input.dataDir) fail("PROFILE_INVALID");
    await matchingProfile(input, attempt);
    const restoringOriginal = !bootstrap && isShellUpdateHandoffAttempt(attempt) && attempt.admission === null && !attempt.recovery?.terminalEvidence
      && Boolean(attempt.recovery || !["completed", "restored"].includes(attempt.phase));
    const launch = await readShellLaunchState(attempt.installationDir, restoringOriginal ? { restoreOriginal: {
      originalState: attempt.originalState, candidateState: attempt.candidateState, admission: null } } : undefined);
    if (!isShellUpdateHandoffAttempt(attempt)) {
      if (bootstrap) fail("ATTEMPT_REQUIRED");
      if (attempt.schemaVersion === 5) {
        if (!["preparing", "no-update"].includes(attempt.phase) && !(attempt.phase === "failed" && attempt.network?.status === "failed")
          || !equal(launch.state, attempt.originalState) || input.executablePath !== launch.executablePath) fail("STARTUP_FACTS_INVALID");
        const binding = await currentBinding(input, attempt, true);
        const processes = await (input.snapshot ?? processSnapshot)(shellUpdateProcessSnapshotContext(attempt));
        const caller = identity(processes.find(item => item.pid === input.pid));
        if (caller.parentPid !== input.parentPid || caller.executable !== input.executablePath || caller.created > Date.now()) fail("PROCESS_IDENTITY_INVALID");
        await store.bindPreparationMain(attempt, { caller, processes, launchState: { status: "known", value: launch.state },
          binding: { status: "matched", value: binding }, profile: { status: "known", dataDir: input.dataDir, userDataDir: input.userDataDir, sessionDataDir: input.sessionDataDir } });
        return { kind: "ordinary" };
      }
      if ((attempt.phase === "preparing" || attempt.phase === "no-update"
        || attempt.schemaVersion === 2 && attempt.phase === "failed" && attempt.network?.status === "failed") && equal(launch.state, attempt.originalState)
        && path.resolve(input.executablePath) === launch.executablePath) return { kind: "ordinary" };
      return { kind: "recovery-control", attempt, decision: { action: "stop", reason: "legacy-attempt-requires-recovery" } };
    }
    const snapshot = await (input.snapshot ?? processSnapshot)(attempt.schemaVersion === 3 ? undefined : shellUpdateProcessSnapshotContext(attempt)), caller = snapshot.find(item => item.pid === input.pid);
    if (!caller || caller.parentPid !== input.parentPid || caller.executable !== input.executablePath) fail("PROCESS_IDENTITY_INVALID");
    if (!bootstrap) {
      if (attempt.recovery?.terminalEvidence || !attempt.recovery && ["completed", "restored"].includes(attempt.phase)) {
        const expected = attempt.admission ? attempt.candidateState : attempt.originalState;
        if (!equal(launch.state, expected) || launch.executablePath !== caller.executable) fail("TERMINAL_STATE_INVALID");
        assertShellUpdateInventoryReleased(attempt, snapshot);
        await currentBinding(input, attempt, false);
        const confirmed = await (input.snapshot ?? processSnapshot)(attempt.schemaVersion === 3 ? undefined : shellUpdateProcessSnapshotContext(attempt, [caller]));
        assertShellUpdateInventoryReleased(attempt, confirmed);
        if (!confirmed.some(item => sameIdentity(item, caller)) || !equal((await readShellLaunchState(attempt.installationDir)).state, expected)
          || !equal(await store.read(), attempt)) fail("TERMINAL_FACTS_CHANGED");
        await matchingProfile(input, attempt);
        return { kind: "ordinary" };
      }
      const observe = (identity: ProcessIdentity) => ({ status: snapshot.some(item => sameIdentity(item, identity)) ? "alive" as const : "gone" as const, identity });
      return { kind: "recovery-control", attempt, decision: decideShellUpdateRecovery(attempt, { caller, owner: observe(attempt.helper), oldMain: observe(attempt.oldMain),
        selectedMain: attempt.selectedMain ? observe(attempt.selectedMain) : { status: "not-started" }, launchState: { status: "known", value: launch.state },
        binding: { status: "unknown" }, profile: { status: "known", dataDir: input.dataDir, userDataDir: input.userDataDir, sessionDataDir: input.sessionDataDir }, ownedReleased: "unknown" }) };
    }
    correlated(bootstrap, attempt);
    const candidate = bootstrap.body.role === "candidate";
    const recovery = attempt.recovery, helper = recovery?.helper ?? attempt.helper;
    if (recovery) {
      if (recovery.terminalEvidence !== null || recovery.direction !== bootstrap.body.role || !recovery.main || !sameIdentity(recovery.main, caller)) fail("STARTUP_FACTS_INVALID");
      assertShellUpdateInventoryReleased({ ...attempt, recovery: null }, snapshot, [helper]); assertReleased([recovery.controller], snapshot, [helper]);
    }
    if (bootstrap.revision !== shellUpdateHandoffRevision(attempt) || !recovery && (!["handoff", ...(candidate ? [] : ["failed"])].includes(attempt.phase) || attempt.admission !== null)
      || !sameIdentity(bootstrap.body.main, caller) || caller.parentPid !== helper.pid
      || !snapshot.some(item => sameIdentity(item, helper)) || snapshot.some(item => sameIdentity(item, attempt.oldMain))
      || !equal(launch.state, candidate ? attempt.candidateState : attempt.originalState) || launch.executablePath !== caller.executable
      || !recovery && (candidate ? !attempt.selectedMain || !sameIdentity(attempt.selectedMain, caller)
        : attempt.selectedMain !== null && snapshot.some(item => sameIdentity(item, attempt.selectedMain!)))) fail("STARTUP_FACTS_INVALID");
    inbox!.check();
    return { kind: "held-candidate", attempt, bootstrap, inbox: inbox!, channel: input.channel!, input };
  } catch (cause) {
    inbox?.dispose();
    if (preparationContext) {
      const code = cause && typeof cause === "object" ? Object.getOwnPropertyDescriptor(cause, "code")?.value : undefined;
      throw Object.assign(new Error("DESKTOP_SHELL_HANDOFF_PREPARATION_STARTUP_FAILED", { cause }), {
        code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : "DESKTOP_SHELL_HANDOFF_PREPARATION_STARTUP_FAILED",
        ...preparationContext });
    }
    throw cause;
  }
}

/** 已持久身份是释放核验下界；旧充分终态不据缺 owned 推断历史任意未知孙进程。 */
function knownInventory(attempt: ShellUpdateHandoffAttempt): ProcessIdentity[] {
  if (attempt.schemaVersion !== 3) return shellUpdateProcessInventory(attempt);
  const recovery = attempt.recovery;
  const values = [attempt.oldMain, attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : []), ...(attempt.owned ?? []),
    ...(attempt.admission ? [attempt.admission.main, attempt.admission.client] : []),
    ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main, attempt.terminalEvidence.ready.client] : []),
    ...(recovery ? [recovery.controller, recovery.helper, ...(recovery.main ? [recovery.main] : []), ...recovery.knownOwned,
      ...(recovery.terminalEvidence ? [recovery.terminalEvidence.ready.main, recovery.terminalEvidence.ready.client] : [])] : [])];
  const result: ProcessIdentity[] = [];
  for (const value of values) { const previous = result.find(item => item.pid === value.pid); if (previous && !sameIdentity(previous, value)) fail("PROCESS_IDENTITY_INVALID"); if (!previous) result.push(value); }
  return result;
}

/** 相关 PID 和未知后代必须释放；严格早于父实例的历史行不形成父子关系。 */
function assertReleased(known: ProcessIdentity[], processes: ProcessIdentity[], excluded: ProcessIdentity[] = []): void {
  for (const original of known) if (processes.some(item => item.pid === original.pid)
    || processes.some(item => item.parentPid === original.pid && !excluded.some(value => sameIdentity(item, value))
      && !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < original.created))) fail("PREVIOUS_PROCESS_UNRELEASED");
}

/** 始终验签实际 baseline/active 及 held 能力；仅未终结恢复要求保持历史业务 binding。 */
async function currentBinding(input: StartupInput, attempt: ShellUpdateHandoffAttempt | ShellUpdatePreparationAttemptV5, historical: boolean) {
  const trustedExecutable = historical && isShellUpdateHandoffAttempt(attempt) && attempt.admission === null ? attempt.oldMain.executable : input.executablePath;
  const keys = input.trustedKeys ?? assertTrustedReleaseKeys(JSON.parse(await fs.readFile(path.join(path.dirname(trustedExecutable), "resources", "release-trust.json"), "utf8")));
  const baseline = await resolveBaselineRelease(path.join(attempt.installationDir, "shells", attempt.originalState.baselineShellId, "resources"), { trustedReleaseKeys: keys, requireHeldStartup: true });
  const active = await resolveActiveRelease(attempt.dataDir, { trustedReleaseKeys: keys, requireHeldStartup: true });
  const manifest = active?.manifest ?? baseline.manifest;
  const health = { protocolVersion: manifest.protocolVersion, clientVersion: manifest.clientVersion, dbSchemaVersion: manifest.dbSchemaVersion, database: "ready" as const };
  const binding = active ? { kind: "active" as const, releaseId: active.releaseId, packageSha256: active.manifest.packageSha256, health }
    : { kind: "installation" as const, baselineShellId: attempt.originalState.baselineShellId, health };
  if (historical && !equal(binding, attempt.binding)) fail("BINDING_CHANGED");
  return binding;
}

/** 复用application门禁；ready后只有持久intent许可可返回，continue仍由原application唯一执行。 */
export function createShellHandoffContinuation(input: { startup: Extract<ShellHandoffStartup, { kind: "held-candidate" }>;
  getMainFrame(): { loaded: boolean; trusted: boolean } }) {
  const { startup } = input, { attempt, inbox, bootstrap } = startup;
  const helper = attempt.recovery?.helper ?? attempt.helper;
  let ready: ShellUpdateReadyEvidence | undefined, permittedAttempt: ShellUpdateHandoffAttempt | undefined, permitRevision: number | undefined, continueRequestId: string | undefined, authorized = false, used = false;
  return {
    continuation: { continuationId: attempt.continuationId,
      /** 从正常app已核工件和main真实实例构造证据，拒绝盘上自报ready。 */
      async authorizeReady(facts: DesktopStartupReadyFacts): Promise<void> {
        if (used) fail("MESSAGE_ORDER_INVALID"); used = true; inbox.check();
        const frame = input.getMainFrame(), client = facts.client;
        snapshotDesktopStartupReady(client.startup, attempt.continuationId);
        if (!frame.loaded || !frame.trusted || facts.web.loaded !== true || client.status !== "ready" || !client.health || !client.pid || !client.requestId
          || !requestId(facts.continueRequestId) || !equal(client.health, attempt.binding.health)
          || facts.baseline.releaseDir !== path.join(attempt.installationDir, "shells", attempt.originalState.baselineShellId, "resources")
          || facts.web.releaseDir !== (facts.active?.releaseDir ?? facts.baseline.releaseDir)) fail("READY_FACTS_INVALID");
        if (attempt.binding.kind === "active" ? !facts.active || facts.active.releaseId !== attempt.binding.releaseId || facts.active.manifest.packageSha256 !== attempt.binding.packageSha256
          : facts.active !== null || attempt.binding.baselineShellId !== attempt.originalState.baselineShellId) fail("BINDING_CHANGED");
        const selected = facts.active?.manifest ?? facts.baseline.manifest;
        if (selected.clientVersion !== client.health.clientVersion || selected.protocolVersion !== client.health.protocolVersion || selected.dbSchemaVersion !== client.health.dbSchemaVersion) fail("BINDING_CHANGED");
        await matchingProfile(startup.input, attempt);
        let samplingAttempt = attempt;
        if (attempt.schemaVersion !== 3) {
          const latest = await createShellUpdateAttemptStore(attempt.dataDir).read();
          if (!latest || !isShellUpdateHandoffAttempt(latest)) fail("READY_FACTS_INVALID");
          assertShellUpdateInventoryExtension(attempt, latest); samplingAttempt = latest;
        }
        const launch = await readShellLaunchState(attempt.installationDir), processes = await (startup.input.snapshot ?? processSnapshot)(samplingAttempt.schemaVersion === 3 ? undefined : shellUpdateProcessSnapshotContext(samplingAttempt));
        const actualMain = bootstrap.body.main, candidate = bootstrap.body.role === "candidate", expectedState = candidate ? attempt.candidateState : attempt.originalState;
        const actualClient = processes.find(item => item.pid === client.pid);
        if (attempt.recovery) { assertShellUpdateInventoryReleased({ ...attempt, recovery: null }, processes, [helper]); assertReleased([attempt.recovery.controller], processes, [helper]); }
        if (!actualClient || actualClient.parentPid !== actualMain.pid || actualClient.created < actualMain.created
          || !processes.some(item => sameIdentity(item, actualMain)) || !processes.some(item => sameIdentity(item, helper))
          || processes.some(item => sameIdentity(item, attempt.oldMain)) || !equal(launch.state, expectedState)) fail("PROCESS_IDENTITY_INVALID");
        ready = { role: bootstrap.body.role, continuationId: attempt.continuationId, main: actualMain, client: actualClient, readyRequestId: client.requestId,
          health: structuredClone(client.health), binding: structuredClone(attempt.binding), launchState: launch.state,
          profile: { dataDir: startup.input.dataDir, userDataDir: startup.input.userDataDir, sessionDataDir: startup.input.sessionDataDir }, mainFrame: "loaded", startup: client.startup! };
        continueRequestId = facts.continueRequestId;
        const message = await sendAndWait(inbox, startup.channel, "permit", { ...bootstrap, kind: "ready", body: { ready } });
        correlated(message, bootstrap);
        const observed = await createShellUpdateAttemptStore(attempt.dataDir).read();
        if (!observed || !isShellUpdateHandoffAttempt(observed)) fail("PERMIT_NOT_COMMITTED");
        // 用helper已持久的新Client库存严格归一ready，避免CIM键序影响相等判断。
        ready = snapshotShellUpdateReadyEvidence(observed, ready, bootstrap.body.role);
        if (attempt.schemaVersion !== observed.schemaVersion) fail("PERMIT_NOT_COMMITTED");
        if (attempt.schemaVersion !== 3 && observed.schemaVersion !== 3) {
          const inventoryOnly = { ...observed, controlRevision: attempt.controlRevision,
            phase: attempt.phase, admission: attempt.admission };
          assertShellUpdateInventoryExtension(attempt, inventoryOnly);
          if (attempt.recovery ? !observed.recovery || observed.recovery.terminalEvidence !== null || message.revision !== bootstrap.revision
            : candidate ? observed.phase !== "admission-intent" || message.revision <= bootstrap.revision || !equal(observed.admission, ready)
            : !["handoff", "failed"].includes(observed.phase) || observed.admission !== null || message.revision !== bootstrap.revision
              || !equal((await readShellLaunchState(attempt.installationDir)).state, attempt.originalState)) fail("PERMIT_NOT_COMMITTED");
        }
        if (observed.requestId !== attempt.requestId || observed.continuationId !== attempt.continuationId
          || ["installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "candidateState", "binding", "target", "oldMain"]
            .some(key => !equal(observed[key as keyof ShellUpdateHandoffAttempt], attempt[key as keyof ShellUpdateHandoffAttempt]))
          || message.revision !== shellUpdateHandoffRevision(observed) || !sameIdentity(observed.helper, attempt.helper)
          || !equal(observed.selectedMain, attempt.selectedMain) || attempt.schemaVersion === 3 && (attempt.recovery ? !observed.recovery || observed.recovery.terminalEvidence !== null
            || !equal({ ...observed.recovery, knownOwned: [] }, { ...attempt.recovery, knownOwned: [] }) || !equal(observed.admission, attempt.admission)
            || !equal({ ...observed, revision: attempt.revision, recovery: null }, { ...attempt, recovery: null })
            || !attempt.recovery.knownOwned.every(identity => observed.recovery!.knownOwned.some(item => sameIdentity(item, identity)))
            || observed.phase !== attempt.phase || message.revision < bootstrap.revision
            : candidate ? observed.phase !== "admission-intent" || message.revision <= bootstrap.revision || !equal(observed.admission, ready)
            : !["handoff", "failed"].includes(observed.phase) || observed.admission !== null || message.revision < bootstrap.revision
              || !equal({ ...observed, revision: attempt.revision, owned: [] }, { ...attempt, owned: [] })
              || !(attempt.owned ?? []).every(identity => observed.owned?.some(item => sameIdentity(item, identity)))
              || !equal((await readShellLaunchState(attempt.installationDir)).state, attempt.originalState))) fail("PERMIT_NOT_COMMITTED");
        const confirmedFrame = input.getMainFrame(), confirmedProcesses = await (startup.input.snapshot ?? processSnapshot)(observed.schemaVersion === 3 ? undefined : shellUpdateProcessSnapshotContext(observed));
        if (attempt.recovery) { assertShellUpdateInventoryReleased({ ...observed, recovery: null }, confirmedProcesses, [helper]); assertReleased([attempt.recovery.controller], confirmedProcesses, [helper]); }
        await matchingProfile(startup.input, attempt);
        if (!confirmedFrame.loaded || !confirmedFrame.trusted || !equal((await readShellLaunchState(attempt.installationDir)).state, expectedState)
          || !confirmedProcesses.some(item => sameIdentity(item, actualMain)) || !confirmedProcesses.some(item => sameIdentity(item, helper))
          || !confirmedProcesses.some(item => sameIdentity(item, actualClient)) || confirmedProcesses.some(item => sameIdentity(item, attempt.oldMain))) fail("PERMIT_FACTS_CHANGED");
        inbox.check(); permitRevision = message.revision; permittedAttempt = observed; authorized = true;
      } },
    /** application完成后发送证据，并等待同一持久终态及真实helper释放才开放自动工作。 */
    async started(): Promise<void> {
      inbox.check(); if (!authorized || !ready || !permittedAttempt || permitRevision === undefined || !continueRequestId) fail("MESSAGE_ORDER_INVALID");
      authorized = false;
      const terminalEvidence: ShellUpdateTerminalEvidence = { ready, startedRequestId: crypto.randomUUID(), continueRequestId, startup: "completed", application: "started" };
      await sendShellHandoffMessage(startup.channel, { ...bootstrap, kind: "started", revision: permitRevision, body: { terminalEvidence } });
      inbox.dispose();
      await waitHandoffCompletion(startup.input, permittedAttempt, terminalEvidence);
    },
    dispose: () => inbox.dispose(),
  };
}

/** 只观察原store和真实进程，不新增确认消息；查询、事实漂移或超时均阻止后续自动操作。 */
async function waitHandoffCompletion(input: StartupInput, permitted: ShellUpdateHandoffAttempt, terminal: ShellUpdateTerminalEvidence): Promise<void> {
  const store = createShellUpdateAttemptStore(permitted.dataDir), helper = permitted.recovery?.helper ?? permitted.helper;
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS), ready = terminal.ready;
  let previous = permitted;
  while (true) {
    const observed = await store.read();
    if (!observed || !isShellUpdateHandoffAttempt(observed) || observed.revision < permitted.revision) fail("COMPLETION_STATE_CHANGED");
    if (observed.schemaVersion !== permitted.schemaVersion) fail("COMPLETION_STATE_CHANGED");
    const previousOwned = permitted.recovery?.knownOwned ?? permitted.owned ?? [], currentOwned = observed.recovery?.knownOwned ?? observed.owned ?? [];
    if (!previousOwned.every(identity => currentOwned.some(item => sameIdentity(item, identity)))) fail("COMPLETION_STATE_CHANGED");
    const completed = observed.recovery ? observed.recovery.terminalEvidence : observed.terminalEvidence;
    if (permitted.schemaVersion !== 3 && observed.schemaVersion !== 3) {
      if (previous.schemaVersion === 3 || previous.schemaVersion !== observed.schemaVersion) fail("COMPLETION_STATE_CHANGED");
      const previousTerminal = previous.recovery?.terminalEvidence ?? previous.terminalEvidence;
      if (completed && !previousTerminal ? observed.controlRevision <= previous.controlRevision : observed.controlRevision !== previous.controlRevision) fail("COMPLETION_STATE_CHANGED");
      const inventoryOnly = { ...observed, controlRevision: previous.controlRevision, phase: previous.phase, terminalEvidence: previous.terminalEvidence,
        ...(observed.recovery ? { recovery: { ...observed.recovery, terminalEvidence: previous.recovery?.terminalEvidence ?? null } } : {}) };
      assertShellUpdateInventoryExtension(previous, inventoryOnly); previous = observed;
      if (!permitted.recovery && observed.phase !== (completed ? ready.role === "candidate" ? "completed" : "restored" : permitted.phase)) fail("COMPLETION_STATE_CHANGED");
    } else if (permitted.recovery) {
      if (!observed.recovery || !equal({ ...observed, revision: permitted.revision, recovery: null }, { ...permitted, recovery: null })
        || !equal({ ...observed.recovery, knownOwned: [], terminalEvidence: null }, { ...permitted.recovery, knownOwned: [], terminalEvidence: null })) fail("COMPLETION_STATE_CHANGED");
    } else if (observed.recovery || !equal({ ...observed, revision: permitted.revision, phase: permitted.phase, owned: permitted.owned, terminalEvidence: permitted.terminalEvidence }, permitted)
      || observed.phase !== (completed ? ready.role === "candidate" ? "completed" : "restored" : permitted.phase)) fail("COMPLETION_STATE_CHANGED");
    if (completed && !equal(completed, terminal)) fail("COMPLETION_EVIDENCE_CHANGED");
    await matchingProfile(input, permitted);
    if (!equal((await readShellLaunchState(permitted.installationDir)).state, ready.launchState)) fail("COMPLETION_FACTS_CHANGED");
    const processes = await (input.snapshot ?? processSnapshot)(observed.schemaVersion === 3 ? undefined : shellUpdateProcessSnapshotContext(observed));
    if (![ready.main, ready.client].every(identity => processes.some(item => sameIdentity(item, identity)))
      || processes.some(item => item.pid === helper.pid && !sameIdentity(item, helper))) fail("COMPLETION_PROCESS_CHANGED");
    const inventory = knownInventory(observed), active = [ready.main];
    if (inventory.some(identity => processes.some(item => item.pid === identity.pid && !sameIdentity(item, identity)))) fail("COMPLETION_PROCESS_CHANGED");
    let changed = true;
    while (changed) {
      changed = false;
      for (const identity of inventory) if (!active.some(item => sameIdentity(item, identity))
        && active.some(parent => identity.parentPid === parent.pid && identity.created >= parent.created)) { active.push(identity); changed = true; }
    }
    if (observed.schemaVersion !== 3) assertShellUpdateInventoryReleased(observed, processes, [helper, ...active]);
    else assertReleased(inventory.filter(identity => !sameIdentity(identity, helper) && !active.some(item => sameIdentity(item, identity))), processes, [helper, ...active]);
    if (completed && !processes.some(item => item.pid === helper.pid)) { assertReleased([helper], processes, active); return; }
    if (Date.now() >= deadline) fail(completed ? "COMPLETION_HELPER_RELEASE_TIMEOUT" : "COMPLETION_TERMINAL_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** 同时归属发送和等待失败；发送失败时注销并结算等待，避免遗留未处理拒绝。 */
async function sendAndWait<K extends ShellHandoffKind>(inbox: ShellHandoffInbox, channel: ShellHandoffChannel, kind: K, message: ShellHandoffMessage): Promise<ShellHandoffMessage<K>> {
  try { const [response] = await Promise.all([inbox.next(kind), sendShellHandoffMessage(channel, message)]); return response; }
  catch (cause) { inbox.dispose(); throw cause; }
}

/** profile只取既有main实际路径，磁盘attempt不能为通过检查改指目录。 */
async function matchingProfile(input: Pick<StartupInput, "dataDir" | "userDataDir" | "sessionDataDir">, attempt: Pick<ShellUpdateHandoffAttempt, "dataDir" | "userDataDir" | "sessionDataDir">): Promise<void> {
  for (const key of ["dataDir", "userDataDir", "sessionDataDir"] as const) if (input[key] !== attempt[key] || await fs.realpath(input[key]) !== input[key]) fail("PROFILE_INVALID");
}
/** 同一请求和接续，nonce仅在真实父子IPC关联，revision交具体阶段核验。 */
function correlated(message: ShellHandoffMessage, expected: { requestId: string; continuationId: string; nonce?: string }): void {
  if (message.requestId !== expected.requestId || message.continuationId !== expected.continuationId || expected.nonce !== undefined && message.nonce !== expected.nonce) fail("MESSAGE_CORRELATION_INVALID");
}
/** 缺真实继承IPC时不能由参数或磁盘取得held授权。 */
function requiredChannel(channel: ShellHandoffChannel | undefined): ShellHandoffChannel { if (!channel?.connected || !channel.send) fail("CHANNEL_UNAVAILABLE"); return channel; }
/** 精确普通数据属性，避免校验时执行访问器。 */
function record(input: unknown, keys: string[]): Record<string, any> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key) || !("value" in Object.getOwnPropertyDescriptor(input, key)!))) fail("MESSAGE_INVALID");
  return input as Record<string, any>;
}
/** 消息只校验已有身份字段，不复制Windows查询/终止策略。 */
function identity(input: unknown): ProcessIdentity {
  const value = record(input, ["pid", "parentPid", "created", "executable", "commandLine"]);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.parentPid) || value.parentPid < 0 || value.pid === value.parentPid
    || !Number.isSafeInteger(value.created) || value.created < 1 || typeof value.executable !== "string" || !path.isAbsolute(value.executable) || value.executable.includes("\0")
    || typeof value.commandLine !== "string" || value.commandLine.includes("\0") || value.commandLine.length > 32768) fail("MESSAGE_INVALID");
  return value as ProcessIdentity;
}
/** ready沿原attempt字段；binding分支只读自有数据描述符，完整一致性仍由store/app/main核实。 */
function readyShape(input: unknown): void {
  const value = record(input, ["role", "continuationId", "main", "client", "readyRequestId", "health", "binding", "launchState", "profile", "mainFrame", "startup"]);
  identity(value.main); identity(value.client);
  if (!["original", "candidate"].includes(value.role) || !requestId(value.readyRequestId) || value.mainFrame !== "loaded"
    || typeof value.continuationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.continuationId)) fail("MESSAGE_INVALID");
  healthShape(value.health);
  serializeShellLaunchState(value.launchState);
  const profile = record(value.profile, ["dataDir", "userDataDir", "sessionDataDir"]);
  if (Object.values(profile).some(item => typeof item !== "string" || !path.isAbsolute(item) || item.includes("\0"))) fail("MESSAGE_INVALID");
  const startup = record(value.startup, ["continuationId", "admission"]);
  if (startup.continuationId !== value.continuationId || startup.admission !== "paused") fail("MESSAGE_INVALID");
  const bindingKind = value.binding && typeof value.binding === "object" ? Object.getOwnPropertyDescriptor(value.binding, "kind") : undefined;
  if (!bindingKind || !("value" in bindingKind)) fail("MESSAGE_INVALID");
  const binding = record(value.binding, bindingKind.value === "active" ? ["kind", "releaseId", "packageSha256", "health"] : ["kind", "baselineShellId", "health"]);
  if (!["active", "installation"].includes(binding.kind) || (binding.kind === "active" ? !requestId(binding.releaseId)
    || typeof binding.packageSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binding.packageSha256) : !requestId(binding.baselineShellId))) fail("MESSAGE_INVALID");
  healthShape(binding.health);
  if (!equal(binding.health, value.health)) fail("MESSAGE_INVALID");
}
/** 消息健康只接受现有Client合同的ready值，不宽松复制未知业务状态。 */
function healthShape(input: unknown): void {
  const value = record(input, ["protocolVersion", "clientVersion", "dbSchemaVersion", "database"]);
  if (value.protocolVersion !== 1 || typeof value.clientVersion !== "string" || !value.clientVersion || value.clientVersion.length > 128
    || !Number.isSafeInteger(value.dbSchemaVersion) || value.dbSchemaVersion < 0 || value.database !== "ready") fail("MESSAGE_INVALID");
}
/** 应用层操作ID与原attempt请求使用相同的可检索短文本边界。 */
function requestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value); }
/** 已经来自严格reader的事实以规范字段值比较，不以对象引用决定授权。 */
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
/** 固定异常不含IPC载荷，特别不包含nonce。 */
function error(code: string): Error { return Object.assign(new Error(`DESKTOP_SHELL_HANDOFF_${code}`), { code: `DESKTOP_SHELL_HANDOFF_${code}` }); }
/** 同步边界显式失败，不创建默认成功事实。 */
function fail(code: string): never { throw error(code); }
