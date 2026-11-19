import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DesktopClientHealth, ShellReleaseManifest, DesktopShellUpdatePhase, DesktopShellVersion, DesktopUpdateResult } from "@codeflowai/shared";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import type { ShellUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import type { ClientRuntimeSnapshot } from "./clientRuntime.js";
import type { DeviceIdentity } from "./deviceIdentity.js";
import { resolveActiveRelease, resolveBaselineRelease } from "./releaseBundleCoordinator.js";
import { createShellUpdateAttemptStore, isShellUpdateHandoffAttempt, shellUpdateHandoffRevision, shellUpdateProcessInventory, shellUpdateProcessSnapshotContext, assertShellUpdateInventoryReleased,
  type ShellUpdateAttempt, type ShellUpdateAttemptBinding, type ShellUpdateAttemptV2, type ShellUpdatePreparationAttempt, type ShellUpdateHandoffAttempt } from "./shellUpdateAttempt.js";
import { createShellUpdateNetwork } from "./shellUpdateNetwork.js";
import { readShellLaunchState, replaceShellLaunchState, type ShellLaunchState } from "./shellLaunchState.js";
import { runCandidateShellHealth } from "./candidateShellHealth.js";
import { startShellHandoffHelper, sendShellHandoffMessage, DEFAULT_SHELL_HANDOFF_TIMEOUT_MS, type ShellHandoffInbox, type ShellHandoffMessage } from "./shellHandoff.js";
import { processSnapshot, sameIdentity, stopIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";
import { runNativeShellUpdate } from "./shellNativeUpdate.js";

export type ShellUpdateHostFacts = { installationDir: string; userDataDir: string; sessionDataDir: string; main: ProcessIdentity; temporaryParentDir?: string };
type NetworkInput = Parameters<typeof createShellUpdateNetwork>[0];
type InstallInput = { manifest: ShellReleaseManifest; trustedKeys: TrustedReleaseKeys; installerPath: string; installationDir: string;
  expectedState: ShellLaunchState; requestId: string; signal?: AbortSignal; timeoutMs?: number; temporaryParentDir?: string };
export type ShellUpdateOperationBoundary = {
  createNetwork(input: NetworkInput): Pick<ReturnType<typeof createShellUpdateNetwork>, "prepare" | "downloadInstaller"> & Partial<Pick<ReturnType<typeof createShellUpdateNetwork>, "authorizeSwitch">>;
  install(input: InstallInput): Promise<{ manifest: ShellReleaseManifest; candidateDirectory: string }>;
  health: typeof runCandidateShellHealth;
  snapshot: typeof processSnapshot;
  spawnHelper(facts: ShellUpdateHostFacts, dataDir: string, configuredServerOrigin: string): ChildProcess;
  stop: typeof stopIdentity;
};
export type ShellUpdateOperationInput = {
  shellVersion?: string;
  discovery?: NetworkInput["discovery"];
  dataDir: string; initialReleaseDir: string; identity: DeviceIdentity; trustedKeys: TrustedReleaseKeys; configuredServerOrigin: string;
  requestId: string; signal: AbortSignal; facts: ShellUpdateHostFacts; getClient(): ClientRuntimeSnapshot;
  onRetry: NetworkInput["onRetry"]; boundary?: Partial<ShellUpdateOperationBoundary>; timeoutMs?: number;
  /** 只有本次显式人工操作可用已有耐久壳失败开启新请求；共享自动 flight 不提升权限。 */
  manual?: boolean;
  getFailureEvidence?(requestId: string, shellId: string | null): ShellUpdateFailureRecord;
  /** 恢复等待前同步报告首错；报告失败仍受原方向与清理门禁约束。 */
  onFailure?(error: Error): void;
  /** 只观察原阶段与核验目标，不授予更新、重试或恢复权限。 */
  onProgress?(observation: { requestId: string; phase: DesktopShellUpdatePhase; result?: DesktopUpdateResult; target?: DesktopShellVersion }): void;
  hooks: { prepare(): Promise<boolean>; drain(): Promise<void>; resume(): Promise<void>; committed(): void };
};
export type ShellUpdateHelperOwner = { check(): void; release(): void; recover(cause: unknown, allowResume?: boolean): Promise<Error> };
export type ShellUpdateOperationResult = { status: "no-update" | "postponed"; requestId: string }
  | { status: "handoff"; requestId: string; owner: ShellUpdateHelperOwner };
type Owned = { child: ChildProcess; identity?: ProcessIdentity; inbox?: ShellHandoffInbox; closed: Promise<void>; didClose: boolean; errors: unknown[] };

/** 默认走独立原生文件事务；显式旧 helper 边界保留历史交接兼容。 */
export async function runShellUpdateOperation(input: ShellUpdateOperationInput): Promise<ShellUpdateOperationResult> {
  if (!input.boundary?.spawnHelper) return await runNativeShellUpdate(input);
  input = { ...input, facts: structuredClone(input.facts) };
  const store = createShellUpdateAttemptStore(input.dataDir);
  const timeout = input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS;
  let requestId = input.requestId, attempt: ShellUpdateAttempt | null = null, owned: Owned | undefined, resumeNeeded = false;
  let binding: ShellUpdateAttemptBinding | undefined, originalState: ShellLaunchState | undefined;
  let clientIdentity: ProcessIdentity | undefined, readyRequestId: string | undefined;
  let failurePhase: ShellUpdateFailureRecord["phase"] = "prepare", recovery: ShellUpdateFailureRecord["recovery"] = "not_needed", drainStarted = false;
  let manualRequired = false;
  /** 原 failurePhase 同时供错误证据与页面观察，仍由原控制流推进。 */
  const observe = (phase: DesktopShellUpdatePhase, result?: DesktopUpdateResult, target?: DesktopShellVersion): void => {
    failurePhase = phase; input.onProgress?.({ requestId, phase, ...(result ? { result } : {}), ...(target ? { target } : {}) });
  };
  /** 明确阻断自动恢复的原分支才要求人工；不从 recovery=failed 推断。 */
  const requireManual: (code: string) => never = code => { manualRequired = true; return fail(code); };
  const knownOwned: ProcessIdentity[] = [];
  /** 完整库存预检与已验证Client共用原采样预算，网络阶段不因重采重开。 */
  const snapshot = input.boundary?.snapshot ?? (() => {
    const known = [input.facts.main, ...(attempt?.schemaVersion === 2 ? knownOwned : []),
      ...(clientIdentity ? [clientIdentity] : []), ...(owned?.identity ? [owned.identity] : [])];
    const context = attempt && (isShellUpdateHandoffAttempt(attempt) || attempt.schemaVersion === 5)
      ? shellUpdateProcessSnapshotContext(attempt, known) : { known };
    return processSnapshot({ ...context, timeoutMs: Math.min(timeout, 10_000) });
  });
  /** 错误保留原请求及实体，正文和nonce不进入诊断。 */
  const contextual = (cause: unknown): Error => Object.assign(new Error("DESKTOP_SHELL_OPERATION_FAILED", { cause }), {
    code: "DESKTOP_SHELL_OPERATION_FAILED", requestId, deviceId: input.identity.deviceId,
    shellId: attempt?.target?.shellId, revision: attempt?.revision, phase: attempt?.phase, failurePhase, recovery,
    helperOwner: owned && !owned.didClose ? helperOwner(owned, recoverObserved) : undefined });
  /** 等待前报告首错；只有旧main仍活且无候选/intent才清helper，报告失败不恢复Client。 */
  const recover = async (cause: unknown, allowResume = true): Promise<Error> => {
    recovery = "failed";
    const primary = contextual(cause);
    let reportFailure: { cause: unknown } | undefined;
    let cleanupFailure: { cause: unknown } | undefined;
    try { input.onFailure?.(primary); }
    catch (additional) { reportFailure = { cause: additional }; }
    try {
      const current = await store.read();
      if (current && isShellUpdateHandoffAttempt(current) && (current.admission !== null || current.selectedMain !== null)
        || !(await snapshot()).some(item => sameIdentity(item, input.facts.main))) requireManual("RECOVERY_DIRECTION_UNKNOWN");
      if (!current || (attempt && isShellUpdateHandoffAttempt(attempt) ? !isShellUpdateHandoffAttempt(current) || !sameHandoff(current, attempt) : !equal(current, attempt))) requireManual("RECOVERY_DIRECTION_UNKNOWN");
      if (owned) {
        try { await closeHelper(owned, snapshot, input.boundary?.stop ?? stopIdentity, timeout); }
        catch (additional) { if (!owned.didClose) throw additional; cleanupFailure = { cause: additional }; }
      }
      const confirmed = await store.read();
      if (attempt && isShellUpdateHandoffAttempt(attempt)) {
        if (!confirmed || !isShellUpdateHandoffAttempt(confirmed) || !sameHandoff(confirmed, attempt) || confirmed.admission !== null || confirmed.selectedMain !== null
          || confirmed.terminalEvidence !== null || !["handoff", "failed"].includes(confirmed.phase)) requireManual("RECOVERY_DIRECTION_UNKNOWN");
        const restoreOriginal = { originalState: confirmed.originalState, candidateState: confirmed.candidateState, admission: confirmed.admission };
        const actual = (await readShellLaunchState(input.facts.installationDir, { restoreOriginal })).state;
        if (equal(actual, confirmed.candidateState)) await replaceShellLaunchState({ installationDir: input.facts.installationDir, expectedState: actual, nextState: confirmed.originalState, restoreOriginal });
        else if (!equal(actual, confirmed.originalState)) requireManual("RECOVERY_DIRECTION_UNKNOWN");
      }
      await readCurrent(false);
      if (cleanupFailure) throw cleanupFailure.cause;
      if (reportFailure) throw reportFailure.cause;
      if (!allowResume) requireManual("UI_RECOVERY_REQUIRED");
      resumeNeeded = false; await input.hooks.resume(); recovery = drainStarted ? "restored" : "not_needed";
    } catch (additional) {
      const failures = [...(reportFailure ? [reportFailure.cause] : []), ...(cleanupFailure ? [cleanupFailure.cause] : [])];
      if (!failures.some(item => Object.is(item, additional))) failures.push(additional);
      return contextual(new AggregateError([cause, ...failures], "DESKTOP_SHELL_OPERATION_RECOVERY_FAILED"));
    }
    return Object.assign(primary, { recovery, helperOwner: owned && !owned.didClose ? helperOwner(owned, recoverObserved) : undefined });
  };
  /** 同一恢复 owner 在操作返回后仍报告实际结果；观察失败不省略恢复或原错误。 */
  const recoverObserved = async (cause: unknown, allowResume = true): Promise<Error> => {
    let observationFailure: { cause: unknown } | undefined;
    try { input.onProgress?.({ requestId, phase: "recovery" }); } catch (additional) { observationFailure = { cause: additional }; }
    const failure = await recover(cause, allowResume);
    try { input.onProgress?.({ requestId, phase: "recovery", result: manualRequired ? "manual_required" : recovery === "restored" ? "restored" : "failure" }); }
    catch (additional) { observationFailure = { cause: observationFailure ? new AggregateError([observationFailure.cause, additional], "DESKTOP_UPDATE_OBSERVATION_FAILED") : additional }; }
    return observationFailure ? contextual(new AggregateError([failure, observationFailure.cause], "DESKTOP_UPDATE_OBSERVATION_FAILED")) : failure;
  };
  /** 先核真实业务与Client；仅准备阶段边界持久观察，helper创建后冻结观察。 */
  const readCurrent = async (requireClient: boolean, observePreparation = true) => {
    for (const directory of [input.dataDir, input.facts.installationDir, input.facts.userDataDir, input.facts.sessionDataDir]) {
      if (!path.isAbsolute(directory) || await fs.realpath(directory) !== directory) fail("PROFILE_CHANGED");
    }
    const launch = await readShellLaunchState(input.facts.installationDir);
    if (launch.executablePath !== input.facts.main.executable || launch.initialReleaseDir !== input.initialReleaseDir) fail("SHELL_FACTS_CHANGED");
    const trust = { trustedReleaseKeys: input.trustedKeys, requireHeldStartup: true };
    const baseline = await resolveBaselineRelease(input.initialReleaseDir, trust), active = await resolveActiveRelease(input.dataDir, trust);
    const selected = active?.manifest ?? baseline.manifest;
    const health: DesktopClientHealth = { protocolVersion: selected.protocolVersion, clientVersion: selected.clientVersion, dbSchemaVersion: selected.dbSchemaVersion, database: "ready" };
    const actualBinding: ShellUpdateAttemptBinding = active ? { kind: "active", releaseId: active.releaseId, packageSha256: active.manifest.packageSha256!, health }
      : { kind: "installation", baselineShellId: launch.state.baselineShellId, health };
    const processes = await snapshot();
    if (!processes.some(item => sameIdentity(item, input.facts.main))) fail("MAIN_IDENTITY_CHANGED");
    if (requireClient) {
      const client = input.getClient();
      const observedClient = processes.find(item => item.pid === client.pid && item.parentPid === input.facts.main.pid);
      if (client.status !== "ready" || !client.requestId || !equal(client.health, health)
        || (active ? client.releaseId !== active.releaseId : ![null, "installation", baseline.manifest.releaseId].includes(client.releaseId))
        || !observedClient || clientIdentity && !sameIdentity(observedClient, clientIdentity) || readyRequestId && client.requestId !== readyRequestId) fail("CLIENT_BINDING_CHANGED");
      clientIdentity ??= structuredClone(observedClient); readyRequestId ??= client.requestId;
    }
    if (binding && !equal(actualBinding, binding) || originalState && !equal(launch.state, originalState)) fail("ORIGINAL_FACTS_CHANGED");
    if (attempt?.schemaVersion === 5 && !isShellUpdateHandoffAttempt(attempt)) {
      if (!sameIdentity(attempt.preparationMains.at(-1)!.identity, input.facts.main)) fail("MAIN_IDENTITY_CHANGED");
      if (requireClient && observePreparation && !owned) attempt = await store.observePreparationOwned(attempt, { caller: input.facts.main, processes });
    } else if (attempt?.schemaVersion === 2) sampleOwned(processes, [input.facts.main, ...(owned?.identity ? [owned.identity] : [])], knownOwned);
    return { state: launch.state, binding: actualBinding, active, baseline, processes };
  };
  /** stage不拥有持久推进权时必须复核原快照，未知写入不能流到helper。 */
  const unchanged = async () => { if (!equal(await store.read(), attempt)) fail("ATTEMPT_CHANGED"); };
  try {
    input.signal.throwIfAborted();
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 300_000) fail("TIMEOUT_INVALID");
    attempt = await store.read();
    requestId = attempt?.requestId ?? input.requestId;
    if (attempt && isShellUpdateHandoffAttempt(attempt)) {
      failurePhase = attempt.recovery ? "recovery" : attempt.admission ? "admission-intent" : "handoff";
      const terminal = attempt.recovery?.terminalEvidence ?? attempt.terminalEvidence;
      recovery = terminal ? terminal.ready.role === "original" ? "restored" : "not_needed" : "failed";
    }
    const facts = await readCurrent(true, false); binding = facts.binding; originalState = facts.state;
    const fresh: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: input.requestId, revision: 0, dataDir: input.dataDir, installationDir: input.facts.installationDir,
      userDataDir: input.facts.userDataDir, sessionDataDir: input.facts.sessionDataDir, originalState, binding, retriesUsed: 0,
      phase: "preparing", target: null, candidateState: null, network: null };
    const preparation = { main: input.facts.main, client: clientIdentity!, readyRequestId: readyRequestId!, processes: facts.processes };
    if (attempt === null) attempt = await store.beginPreparation(null, fresh, preparation);
    else if (!isShellUpdateHandoffAttempt(attempt) && (attempt.schemaVersion === 2 || attempt.schemaVersion === 5) && attempt.phase === "no-update") {
      attempt = await store.beginPreparation(attempt, fresh, preparation);
    }
    else if (isShellUpdateHandoffAttempt(attempt) && (attempt.recovery ? attempt.recovery.terminalEvidence !== null : ["completed", "restored"].includes(attempt.phase))) {
      assertTerminalReleased(attempt, facts.processes, input.facts.main, clientIdentity!);
      const confirmed = await readCurrent(true); await unchanged();
      assertTerminalReleased(attempt, confirmed.processes, input.facts.main, clientIdentity!);
      attempt = await store.beginPreparation(attempt, fresh, { ...preparation, processes: confirmed.processes });
    }
    else if (input.manual === true && attempt.schemaVersion === 5 && !isShellUpdateHandoffAttempt(attempt)
      && attempt.phase === "failed" && attempt.network?.status === "failed") {
      if (!input.getFailureEvidence) fail("FAILURE_EVIDENCE_REQUIRED");
      const failure = input.getFailureEvidence(attempt.requestId, attempt.target?.shellId ?? null);
      if (failure.deviceId !== input.identity.deviceId) fail("FAILURE_DEVICE_MISMATCH");
      const confirmed = await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
      attempt = await store.beginPreparation(attempt, fresh, { ...preparation, processes: confirmed.processes, failure });
    }
    else {
      requestId = attempt.requestId;
      if (!isPreparation(attempt) || attempt.phase !== "preparing") requireManual("RECOVERY_REQUIRED");
      if (["dataDir", "installationDir", "userDataDir", "sessionDataDir", "originalState", "binding"]
        .some(key => !equal(attempt![key as keyof ShellUpdateAttempt], fresh[key as keyof ShellUpdateAttemptV2]))) fail("ATTEMPT_FACTS_CHANGED");
      if (attempt.schemaVersion === 5) attempt = await store.observePreparationOwned(attempt, { caller: input.facts.main, processes: facts.processes });
    }
    requestId = attempt.requestId;
    recovery = "not_needed"; observe("prepare");
    const network = (input.boundary?.createNetwork ?? createShellUpdateNetwork)({ store, identity: input.identity, configuredServerOrigin: input.configuredServerOrigin,
      discovery: input.discovery, currentShellVersion: input.shellVersion, trustedKeys: input.trustedKeys, signal: input.signal, onRetry: input.onRetry,
      onExhausted() { manualRequired = true; observe(failurePhase, "manual_required"); } });
    const prepared = await network.prepare();
    if (!samePreparation(prepared.attempt, attempt)) fail("ATTEMPT_CHANGED");
    attempt = prepared.attempt;
    await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
    if (prepared.status === "no-update") { observe("prepare", prepared.reason ?? "unknown"); return { status: "no-update", requestId }; }
    observe("download", undefined, { shellId: prepared.manifest.shellId, version: prepared.manifest.version });
    const beforeDownload = attempt, downloaded = await network.downloadInstaller(); attempt = await store.read();
    if (!attempt || !samePreparation(attempt, beforeDownload) || attempt.phase !== "preparing" || !attempt.target || !equal(attempt.target, prepared.attempt.target)
      || downloaded.sha256 !== attempt.target.installerSha256 || downloaded.size !== attempt.target.installerSize) fail("TARGET_CHANGED");
    await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
    const install = input.boundary?.install ?? (async options => await (await import("./shellInstallerProcess.js")).installShellCandidate(options));
    observe("install");
    const installed = await install({ manifest: prepared.manifest, trustedKeys: input.trustedKeys, installerPath: downloaded.installerPath,
      installationDir: input.facts.installationDir, expectedState: originalState, requestId, signal: input.signal, timeoutMs: input.timeoutMs, temporaryParentDir: input.facts.temporaryParentDir });
    const candidateDirectory = path.join(input.facts.installationDir, "shells", attempt.target.shellId);
    if (installed.candidateDirectory !== candidateDirectory || !equal(installed.manifest, prepared.manifest)) fail("TARGET_CHANGED");
    await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
    observe("health");
    const health = await (input.boundary?.health ?? runCandidateShellHealth)({ candidateExecutablePath: path.join(candidateDirectory, "CodeFlowAI.exe"),
      installationDir: input.facts.installationDir, sourceDataDir: input.dataDir, temporaryParentDir: input.facts.temporaryParentDir, timeoutMs: input.timeoutMs });
    // 健康报告用installation标记固定基线，active仍按真实签名发布ID和目录核验。
    if (health.status !== "passed" || health.candidateShellId !== attempt.target.shellId || health.checks.length !== (facts.active ? 2 : 1)
      || ![facts.baseline, ...(facts.active ? [facts.active] : [])].every((release, index) => health.checks.some(check => check.role === (index ? "active" : "baseline")
        && check.releaseId === (index ? release.manifest.releaseId : "installation") && check.releaseDir === release.releaseDir
        && check.childClosed === true && equal(check.health, { protocolVersion: release.manifest.protocolVersion,
          clientVersion: release.manifest.clientVersion, dbSchemaVersion: release.manifest.dbSchemaVersion, database: "ready" })))) fail("HEALTH_BINDING_CHANGED");
    await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
    observe("handoff"); resumeNeeded = true;
    if (!await input.hooks.prepare()) { resumeNeeded = false; recovery = "failed"; await input.hooks.resume(); recovery = "not_needed"; observe("handoff", "postponed"); return { status: "postponed", requestId }; }
    await readCurrent(true); await unchanged(); input.signal.throwIfAborted();
    owned = observeHelper((input.boundary?.spawnHelper ?? spawnHelper)(input.facts, input.dataDir, input.configuredServerOrigin));
    owned.identity = await helperIdentity(owned, input.facts.main, snapshot, timeout);
    const continuationId = crypto.randomUUID(), nonce = crypto.randomBytes(32).toString("hex");
    const armed = await startShellHandoffHelper({ channel: owned.child, oldMain: input.facts.main, helper: owned.identity,
      requestId, continuationId, revision: attempt.revision, nonce, snapshot, timeoutMs: timeout });
    owned.inbox = armed.inbox; checkHelper(owned); input.signal.throwIfAborted();
    const handoffFacts = await readCurrent(true); await unchanged();
    const handoff = attempt.schemaVersion === 5
      ? await store.beginHandoff(attempt, { lifecycle: true, continuationId, oldMain: input.facts.main, helper: owned.identity, processes: handoffFacts.processes })
      : await store.beginHandoff(attempt, { lifecycle: true, continuationId, oldMain: input.facts.main, helper: owned.identity,
        processes: handoffFacts.processes, knownOwned }); attempt = handoff;
    const message: ShellHandoffMessage<"accept"> = { t: "desktop.shell-handoff", schemaVersion: 1, kind: "accept", requestId, continuationId,
      revision: shellUpdateHandoffRevision(handoff), nonce, body: {} };
    const accepted = await sendAndWait(owned, "accepted", message);
    correlate(accepted, message); checkHelper(owned); input.hooks.committed();
    drainStarted = true; await input.hooks.drain();
    const exit = await sendAndWait(owned, "exit-request", { ...message, kind: "drained" });
    const latest = await store.read();
    if (!latest || !isShellUpdateHandoffAttempt(latest) || !sameHandoff(latest, handoff) || latest.phase !== "handoff" || latest.selectedMain !== null || latest.admission !== null
      || latest.terminalEvidence !== null || latest.network.status !== "succeeded" || latest.network.evidence.kind !== "shell-switch-authorization"
      || !equal((await readShellLaunchState(input.facts.installationDir)).state, latest.candidateState)) fail("EXIT_NOT_COMMITTED");
    correlate(exit, { ...message, revision: shellUpdateHandoffRevision(latest) }); attempt = latest; checkHelper(owned); armed.inbox.dispose();
    return { status: "handoff", requestId, owner: helperOwner(owned, recoverObserved) };
  } catch (cause) {
    if (owned) throw await recoverObserved(cause);
    let failure = cause;
    if (resumeNeeded) { resumeNeeded = false; try { await input.hooks.resume(); } catch (additional) { recovery = "failed"; failure = new AggregateError([cause, additional], "DESKTOP_SHELL_OPERATION_ADMISSION_RESUME_FAILED"); } }
    const error = contextual(failure);
    try { observe(failurePhase, manualRequired ? "manual_required" : "failure"); }
    catch (additional) { throw contextual(new AggregateError([error, additional], "DESKTOP_UPDATE_OBSERVATION_FAILED")); }
    throw error;
  }
}

/** owner只持有本次进程；未知方向失败仍交回调用方，不创建第二operation。 */
function helperOwner(owned: Owned, recover: ShellUpdateHelperOwner["recover"]): ShellUpdateHelperOwner {
  return {
    /** quit前再核本次helper没有提前失败。 */
    check() { checkHelper(owned); },
    /** 仅在统一quit成功后放弃本次进程owner，不提前断开接管。 */
    release() { owned.child.unref(); owned.child.channel?.unref(); },
    recover,
  };
}

/** 默认复用原exe的Node脚本模式和真实继承IPC；nonce只在arm消息中。 */
function spawnHelper(facts: ShellUpdateHostFacts, dataDir: string, configuredServerOrigin: string): ChildProcess {
  // Windows下独立存活跨越旧main退出，IPC及owner仍保留到原交接释放点。
  return spawn(facts.main.executable, [fileURLToPath(new URL("./shellHandoffHelper.js", import.meta.url)), "--codeflow-shell-handoff-helper", dataDir], {
    cwd: facts.installationDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEFLOWAI_DESKTOP_SERVER_ORIGIN: configuredServerOrigin }, windowsHide: true, detached: process.platform === "win32", stdio: ["ignore", "inherit", "inherit", "ipc"] });
}
/** 创建后立即持有真实close及错误，关闭前不释放本次helper引用。 */
function observeHelper(child: ChildProcess): Owned {
  let closed!: () => void;
  const owned: Owned = { child, closed: new Promise(resolve => { closed = resolve; }), didClose: false, errors: [] };
  child.on("error", cause => { owned.errors.push(cause); owned.inbox?.dispose(); });
  child.once("close", () => { owned.didClose = true; owned.inbox?.dispose(); closed(); });
  return owned;
}
/** 同时归属发送与响应，发送先失败也结算pending，不遗留未处理拒绝。 */
async function sendAndWait<K extends "accepted" | "exit-request">(owned: Owned, kind: K, message: ShellHandoffMessage): Promise<ShellHandoffMessage<K>> {
  if (!owned.inbox) fail("CHANNEL_UNAVAILABLE");
  try { const [response] = await Promise.all([owned.inbox.next(kind), sendShellHandoffMessage(owned.child, message)]); return response; }
  catch (cause) { owned.inbox.dispose(); throw cause; }
}
/** 唯一身份查询入口；PID匹配仍必须同父、同exe并保持完整实例。 */
async function helperIdentity(owned: Owned, main: ProcessIdentity, snapshot: typeof processSnapshot, timeout: number): Promise<ProcessIdentity> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkHelper(owned);
    const observed = (await snapshot()).find(item => item.pid === owned.child.pid);
    if (observed) { if (observed.parentPid !== main.pid || observed.executable !== main.executable) fail("HELPER_IDENTITY_CHANGED"); return observed; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("HELPER_IDENTITY_TIMEOUT");
}
/** 仅停止已核本次实例；未关闭时仍保全部清理/进程原因，并交回原owner。 */
async function closeHelper(owned: Owned, snapshot: typeof processSnapshot, stop: typeof stopIdentity, timeout: number): Promise<void> {
  const failures: unknown[] = [...owned.errors];
  if (!owned.didClose) {
    try { if (owned.child.connected) owned.child.disconnect(); await bounded(owned.closed, timeout); }
    catch (cause) {
      failures.push(cause);
      try {
        if (!owned.identity) fail("HELPER_IDENTITY_UNKNOWN");
        const processes = await snapshot();
        if (processes.some(item => sameIdentity(item, owned.identity!))) await stop(owned.identity);
        await bounded(owned.closed, timeout);
      } catch (additional) { failures.push(additional); }
    }
  }
  for (const cause of owned.errors) if (!failures.includes(cause)) failures.push(cause);
  if (!owned.didClose) {
    const code = "DESKTOP_SHELL_OPERATION_HELPER_NOT_CLOSED";
    failures.push(Object.assign(new Error(code), { code }));
  }
  if (failures.length) throw new AggregateError(failures, "DESKTOP_SHELL_OPERATION_HELPER_CLEANUP_FAILED");
}

/** 只沿完整活父收集后代，排除严格早于父实例的历史行；身份冲突与未知时间仍失败。 */
function sampleOwned(processes: ProcessIdentity[], roots: ProcessIdentity[], known: ProcessIdentity[]): void {
  for (const identity of [...roots, ...known]) {
    const actual = processes.find(item => item.pid === identity.pid);
    if (actual && !sameIdentity(actual, identity)) fail("OWNED_IDENTITY_CHANGED", { reason: "ACTIVE_IDENTITY_CHANGED", identity });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of processes) {
      if ([...roots, ...known].some(item => sameIdentity(item, identity))) continue;
      const parent = [...roots, ...known].find(item => item.pid === identity.parentPid);
      if (!parent) continue;
      if (Number.isSafeInteger(identity.created) && identity.created > 0 && identity.created < parent.created) continue;
      if (!processes.some(item => sameIdentity(item, parent))) fail("OWNED_IDENTITY_UNKNOWN", { reason: "UNKNOWN_PARENT_MISSING", identity });
      if (identity.created < parent.created) fail("OWNED_IDENTITY_UNKNOWN", { reason: "CHILD_PREDATES_PARENT", identity });
      known.push(structuredClone(identity)); changed = true;
    }
  }
}

/** 充分终态仅豁免当前正常main及完整现存后代；历史helper、其他main/Client和未知孤儿必须释放。 */
function assertTerminalReleased(attempt: ShellUpdateHandoffAttempt, processes: ProcessIdentity[], main: ProcessIdentity, client: ProcessIdentity): void {
  const terminal = attempt.recovery?.terminalEvidence ?? attempt.terminalEvidence;
  if (!terminal || !equal(terminal.ready.launchState, attempt.admission ? attempt.candidateState : attempt.originalState)) fail("TERMINAL_REQUIRED");
  const recovery = attempt.recovery;
  const owners = [attempt.oldMain, attempt.helper, ...(attempt.schemaVersion === 5 ? attempt.preparationMains.map(item => item.identity) : []), ...(attempt.selectedMain ? [attempt.selectedMain] : []),
    ...(attempt.admission ? [attempt.admission.main] : []), ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main] : []),
    ...(recovery ? [recovery.controller, recovery.helper, ...(recovery.main ? [recovery.main] : [])] : [])];
  const clients = [attempt.admission?.client, attempt.terminalEvidence?.ready.client, recovery?.terminalEvidence?.ready.client]
    .filter((value): value is ProcessIdentity => value !== undefined);
  const known = shellUpdateProcessInventory(attempt);
  const descendants: ProcessIdentity[] = []; sampleOwned(processes, [main], descendants);
  const current = [main, ...descendants];
  const controllers = [attempt.helper, ...(recovery ? [recovery.controller, recovery.helper] : [])];
  if (attempt.schemaVersion === 4 || attempt.schemaVersion === 5) {
    const allowed = known.filter(identity => owners.some(item => sameIdentity(item, identity))
      ? sameIdentity(identity, main) && sameIdentity(identity, terminal.ready.main) && !controllers.some(item => sameIdentity(item, identity))
      : clients.some(item => sameIdentity(item, identity)) ? sameIdentity(identity, client) : current.some(item => sameIdentity(item, identity)));
    assertShellUpdateInventoryReleased(attempt, processes, allowed); return;
  }
  for (const identity of known) {
    const isOwner = owners.some(item => sameIdentity(item, identity)), isClient = clients.some(item => sameIdentity(item, identity));
    const allowed = isOwner ? sameIdentity(identity, main) && sameIdentity(identity, terminal.ready.main) && !controllers.some(item => sameIdentity(item, identity))
      : isClient ? sameIdentity(identity, client) : current.some(item => sameIdentity(item, identity));
    if (processes.some(item => item.pid === identity.pid && (!allowed || !sameIdentity(item, identity)))
      || processes.some(item => item.parentPid === identity.pid && !current.some(value => sameIdentity(value, item)))) fail("TERMINAL_PROCESS_UNRELEASED");
  }
}
/** 各等待共享已有调用预算，不以永远pending伪造仍在执行。 */
async function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DESKTOP_SHELL_OPERATION_HELPER_CLOSE_TIMEOUT")), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** 当前通道身份和revision必须与唯一持久交接完全对应。 */
function correlate(value: ShellHandoffMessage, expected: ShellHandoffMessage): void {
  if (["requestId", "continuationId", "revision", "nonce"].some(key => value[key as keyof ShellHandoffMessage] !== expected[key as keyof ShellHandoffMessage])) fail("MESSAGE_CORRELATION_INVALID");
}
/** helper提前退出或error都显式失败，不能继续交出原main。 */
function checkHelper(owned: Owned): void { if (owned.errors.length) throw new AggregateError(owned.errors, "DESKTOP_SHELL_OPERATION_HELPER_FAILED"); if (owned.didClose) fail("HELPER_EXITED"); }
/** 已验签和严格reader事实按值比较，不新增状态口径。 */
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
/** 授权槽可推进revision，交接的原始身份/profile/S0/S1/目标/binding不得改变。 */
function sameHandoff(left: ShellUpdateHandoffAttempt, right: ShellUpdateHandoffAttempt): boolean {
  return sameOriginal(left, right) && ["continuationId", "candidateState", "target", "oldMain", "helper", ...(left.schemaVersion === 5 ? ["handoffRevision"] : [])]
    .every(key => equal(left[key as keyof ShellUpdateHandoffAttempt], right[key as keyof ShellUpdateHandoffAttempt]));
}
/** 网络可以推进目标和槽，但原请求、目录、S0与绑定必须保持。 */
function sameOriginal(left: ShellUpdateAttempt, right: ShellUpdateAttempt): boolean {
  return ["schemaVersion", "requestId", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "binding", ...(left.schemaVersion === 5 ? ["preparationMains"] : [])]
    .every(key => equal(left[key as keyof ShellUpdateAttempt], right[key as keyof ShellUpdateAttempt]));
}
/** 网络只可推进其槽和目标，准备库存及角色根必须保持原值。 */
function samePreparation(left: ShellUpdateAttempt, right: ShellUpdateAttempt): left is ShellUpdatePreparationAttempt {
  return isPreparation(left) && isPreparation(right) && sameOriginal(left, right)
    && (left.schemaVersion !== 5 || right.schemaVersion === 5 && equal(left.owned, right.owned) && equal(left.ownedLifecycle, right.ownedLifecycle));
}
/** 准备5与交接5共享版本号，必须通过原严格读取后的结构判别。 */
function isPreparation(attempt: ShellUpdateAttempt): attempt is ShellUpdatePreparationAttempt {
  return attempt.schemaVersion === 2 || attempt.schemaVersion === 5 && !isShellUpdateHandoffAttempt(attempt);
}
/** 原失败码可附既有库存诊断格式，实例正文只参与摘要、不进入日志。 */
function fail(code: string, observation?: { reason: "ACTIVE_IDENTITY_CHANGED" | "UNKNOWN_PARENT_MISSING" | "CHILD_PREDATES_PARENT"; identity: ProcessIdentity }): never {
  const identity = observation?.identity;
  const inventoryFailure = observation && identity ? { reason: observation.reason, pid: identity.pid, parentPid: identity.parentPid, created: identity.created,
    instanceSha256: crypto.createHash("sha256").update(JSON.stringify([identity.pid, identity.parentPid, identity.created, identity.executable, identity.commandLine]), "utf8").digest("hex") } : undefined;
  throw Object.assign(new Error(`DESKTOP_SHELL_OPERATION_${code}`), { code: `DESKTOP_SHELL_OPERATION_${code}`, ...(inventoryFailure ? { inventoryFailure } : {}) });
}
