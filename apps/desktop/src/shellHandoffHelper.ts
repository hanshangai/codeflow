import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertTrustedReleaseKeys, type TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { createShellUpdateAttemptStore, isShellUpdateHandoffAttempt, shellUpdateHandoffRevision, shellUpdateProcessInventory, shellUpdateProcessSnapshotContext, shellUpdateOwnedInventory,
  assertShellUpdateInventoryReleased, assertShellUpdateInventoryExtension, snapshotShellUpdateReadyEvidence, type ShellUpdateHandoffAttempt,
  type ShellUpdateReadyEvidence, type ShellUpdatePreparationAttemptV5 } from "./shellUpdateAttempt.js";
import { readShellLaunchState, replaceShellLaunchState } from "./shellLaunchState.js";
import { processSnapshot, sameIdentity, stopIdentity, type ProcessIdentity } from "./windowsProcessIdentity.js";
import { processInstanceKey } from "./shellProcessInventory.js";
import { createShellHandoffInbox, sendShellHandoffMessage, SHELL_HANDOFF_FLAG, DEFAULT_SHELL_HANDOFF_TIMEOUT_MS,
  diagnosticData, diagnosticArray, identityConflictDiagnostic, inventoryFailureDiagnostic, type ShellHandoffChannel, type ShellHandoffMessage } from "./shellHandoff.js";
import { createShellUpdateNetwork } from "./shellUpdateNetwork.js";
import { readDeviceIdentity } from "./deviceIdentity.js";
import { verifyShellReleaseArtifact } from "./shellReleaseArtifact.js";
import { resolveActiveRelease, resolveBaselineRelease } from "./releaseBundleCoordinator.js";
import type { ShellUpdateFileOwnerScope } from "./shellUpdateFileCoordinator.js";
import { createUpdateFailureJournal } from "./updateFailureJournal.js";

type HelperBoundary = {
  snapshot: typeof processSnapshot;
  authorizeSwitch(attempt: ShellUpdateHandoffAttempt): Promise<unknown>;
  verifyPrepared(attempt: ShellUpdateHandoffAttempt): Promise<void>;
  verifyOriginal(attempt: ShellUpdateHandoffAttempt): Promise<void>;
  spawnMain(executable: string, attempt: ShellUpdateHandoffAttempt): ChildProcess;
  stop: typeof stopIdentity;
};
type HelperInput = {
  dataDir: string; channel: ShellHandoffChannel; pid?: number; parentPid?: number; timeoutMs?: number;
  trustedKeys?: TrustedReleaseKeys; configuredServerOrigin?: string; boundary?: Partial<HelperBoundary>;
};
type Owned = { child: ChildProcess; identity?: ProcessIdentity; closed: Promise<void>; failure?: { cause: unknown };
  inbox: ReturnType<typeof createShellHandoffInbox>; known: Map<number, ProcessIdentity> };

/** 单一helper接管；持久intent前才允许完整S0恢复，intent后失败只保候选方向。 */
export async function runShellHandoffHelper(input: HelperInput): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS, pid = input.pid ?? process.pid, parentPid = input.parentPid ?? process.ppid;
  const store = createShellUpdateAttemptStore(input.dataDir), inbox = createShellHandoffInbox(input.channel, timeout);
  let attempt: ShellUpdateHandoffAttempt | undefined, owner: ProcessIdentity | undefined, owned: Owned | undefined;
  let requestId: string | undefined;
  let preparation: ShellUpdatePreparationAttemptV5 | undefined;
  let accepted = false, switched = false, restorationPermitted = false;
  let physicalOwner: ShellUpdateFileOwnerScope | undefined, ownerRequired = false, runFailure: { cause: unknown } | undefined;
  const known = new Map<number, ProcessIdentity>();
  /** 当前唯一库存提供完整预检；已验证角色沿原有界查询合同重采。 */
  const readSnapshot = input.boundary?.snapshot ?? (() => {
    const current = attempt ?? preparation;
    const extra = [...(attempt?.schemaVersion === 3 ? [...known.values(), ...(owned ? [...owned.known.values()] : [])] : []),
      ...(owner ? [owner] : []), ...(owned?.identity ? [owned.identity] : [])];
    return processSnapshot(current ? { ...shellUpdateProcessSnapshotContext(current, extra), timeoutMs: Math.min(timeout, 10_000) } : undefined);
  });
  /** 到期后不再采样后继续写库存；在途查询完成时再次核验。 */
  const snapshot: typeof processSnapshot = async context => {
    physicalOwner?.assertActive();
    const processes = await readSnapshot(context);
    physicalOwner?.assertActive();
    return processes;
  };
  /** 候选和恢复入口复用同一作用域，异步边界后禁止过期副作用。 */
  const assertOwner = () => physicalOwner?.assertActive();
  /** 库存提交可能跨越截止时间，每个实际停止操作前仍须重新核owner。 */
  const stop: typeof stopIdentity = async identity => {
    assertOwner(); await (input.boundary?.stop ?? stopIdentity)(identity); assertOwner();
  };
  try {
    const arm = await inbox.next("arm"); requestId = arm.requestId;
    const initial = await store.read();
    if (initial?.schemaVersion === 5 && !isShellUpdateHandoffAttempt(initial)) preparation = initial;
    const processes = await snapshot();
    const oldMain = arm.body.oldMain; owner = processes.find(item => item.pid === pid);
    if (!owner || owner.parentPid !== parentPid || parentPid !== oldMain.pid || owner.executable !== oldMain.executable
      || !processes.some(item => sameIdentity(item, oldMain)) || !initial || isShellUpdateHandoffAttempt(initial) || initial.schemaVersion !== 2 && initial.schemaVersion !== 5 || initial.phase !== "preparing"
      || initial.target === null || initial.network?.status !== "succeeded" || initial.requestId !== arm.requestId || initial.revision !== arm.revision
      || initial.schemaVersion === 5 && !sameIdentity(initial.preparationMains.at(-1)!.identity, oldMain)
      || oldMain.executable !== path.join(initial.installationDir, "shells", initial.originalState.activeShellId, "CodeFlowAI.exe")) fail("ARM_INVALID");
    if (initial.schemaVersion === 2) collectDescendants(processes, oldMain, owner, known);
    const message = await sendAndWait(inbox, input.channel, "accept", { ...arm, kind: "armed", body: { helper: owner } }), observed = await store.read(); correlate(message, arm);
    if (!observed || !isShellUpdateHandoffAttempt(observed) || observed.phase !== "handoff" || shellUpdateHandoffRevision(observed) !== message.revision || observed.revision !== initial.revision + 1
      || observed.continuationId !== arm.continuationId || !sameIdentity(observed.helper, owner) || !sameIdentity(observed.oldMain, oldMain)
      || observed.selectedMain !== null || observed.admission !== null || observed.owned === undefined || !["requestId", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "candidateState", "binding", "target", "network", "retriesUsed"]
        .every(key => equal(observed[key as keyof typeof observed], initial[key as keyof typeof initial]))) fail("ACCEPT_NOT_COMMITTED");
    if (initial.schemaVersion === 5) {
      if (observed.schemaVersion !== 5 || observed.handoffRevision !== initial.revision + 1) fail("ACCEPT_NOT_COMMITTED");
      assertShellUpdateInventoryExtension(initial, observed);
    }
    attempt = observed; preparation = undefined; accepted = true;
    refreshOwned(known, attempt, attempt.oldMain);
    const acceptedRevision = shellUpdateHandoffRevision(attempt);
    const drainMessage = await watchSamples(async () => {
      const processes = await snapshot();
      if (attempt!.schemaVersion === 3) { collectDescendants(processes, attempt!.oldMain, owner!, known); assertNoUnknownDescendants(processes, attempt!.oldMain, owner!, known); }
      attempt = await persistOwned(attempt!, processes, known.values()); refreshOwned(known, attempt, attempt.oldMain);
    }, () => sendAndWait(inbox, input.channel, "drained", { ...arm, kind: "accepted", revision: acceptedRevision, body: {} }), () => inbox.dispose()); correlate(drainMessage, arm);
    if (drainMessage.revision !== acceptedRevision) fail("REVISION_CONFLICT");
    attempt = await persistOwned(attempt, await snapshot(), known.values()); refreshOwned(known, attempt, attempt.oldMain);
    inbox.check();
    const boundary = await dependencies(input, attempt);
    await boundary.verifyPrepared(attempt); await boundary.authorizeSwitch(attempt);
    attempt = await currentHandoff(store, attempt);
    await assertLaunch(attempt, "original"); await boundary.verifyPrepared(attempt); inbox.check();
    await replaceShellLaunchState({ installationDir: attempt.installationDir, expectedState: attempt.originalState, nextState: attempt.candidateState }); switched = true;
    const beforeExit = await snapshot();
    if (!beforeExit.some(item => sameIdentity(item, attempt!.oldMain)) || !beforeExit.some(item => sameIdentity(item, owner!))) fail("OLD_MAIN_EXITED_BEFORE_REQUEST");
    if (attempt.schemaVersion === 3) collectDescendants(beforeExit, attempt.oldMain, owner, known);
    attempt = await persistOwned(attempt, beforeExit, known.values()); refreshOwned(known, attempt, attempt.oldMain);
    await sendShellHandoffMessage(input.channel, { ...arm, kind: "exit-request", revision: shellUpdateHandoffRevision(attempt), body: {} });
    await waitReleased(snapshot, attempt.oldMain, owner, known, timeout, async processes => { attempt = await persistOwned(attempt!, processes, known.values()); refreshOwned(known, attempt, attempt.oldMain); }, attempt.schemaVersion !== 3);
    // 旧main正常退出会断开旧通道，此后只使用唯一store和新子IPC。
    inbox.dispose();
    ownerRequired = true; physicalOwner = await store.acquireOwner(3 * timeout); assertOwner();
    const candidate = await launchMain(boundary, attempt, "candidate", snapshot, timeout, value => { owned = value; }, value => { attempt = value; }, assertOwner); attempt = candidate.attempt;
    const ready = await candidate.ready;
    await validateReady(attempt, ready, "candidate", snapshot); assertOwner();
    const intended = await store.replace(attempt, { ...attempt, revision: attempt.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateHandoffAttempt;
    attempt = intended;
    const permitRevision = shellUpdateHandoffRevision(intended);
    const completion = await watchOwned(candidate.owned, snapshot, () => {
      assertOwner(); return sendAndWait(candidate.inbox, candidate.owned.child as ShellHandoffChannel, "started", { ...candidate.bootstrap, kind: "permit", revision: permitRevision, body: {} });
    },
      intended.schemaVersion !== 3 ? async processes => { attempt = await persistOwned(attempt!, processes, candidate.owned.known.values()); refreshOwned(candidate.owned.known, attempt); } : undefined); correlate(completion, candidate.bootstrap);
    if (completion.revision !== permitRevision) fail("REVISION_CONFLICT");
    await assertLaunch(intended, "candidate");
    const completed = await persistOwned(attempt, await snapshot(), candidate.owned.known.values());
    await verifyProfile(completed); assertOwner();
    await store.replace(completed, { ...completed, revision: completed.revision + 1, phase: "completed", terminalEvidence: completion.body.terminalEvidence });
    candidate.inbox.dispose(); candidate.owned.child.disconnect(); candidate.owned.child.unref(); owned = undefined;
  } catch (cause) {
    let failure: unknown = cause;
    let cleanupAllowed = false;
    try {
      // 取得失败时不再启动其他main；已取得的owner到期也必须停止恢复副作用。
      if (ownerRequired && !physicalOwner) throw cause;
      assertOwner();
      const observed = await store.read();
      if (accepted && observed && isShellUpdateHandoffAttempt(observed) && !observed.recovery && owner && sameIdentity(observed.helper, owner) && attempt && sameHandoffFacts(observed, attempt)) {
        attempt = observed;
        if (observed.admission === null && observed.phase !== "restored" && observed.phase !== "completed") {
          cleanupAllowed = true;
          if (owned) { await stopOwned(owned, snapshot, timeout, stop, attempt.schemaVersion !== 3 ? async processes => {
            attempt = await persistOwned(attempt!, processes, []); return shellUpdateOwnedInventory(attempt);
          } : undefined); owned.inbox.dispose(); owned = undefined; }
          const boundary = await dependencies(input, observed); await boundary.verifyOriginal(observed); await verifyProfile(observed); assertOwner();
          const restoreOriginal = { originalState: observed.originalState, candidateState: observed.candidateState, admission: null };
          const actual = await readShellLaunchState(observed.installationDir, { restoreOriginal });
          assertOwner();
          if (equal(actual.state, observed.candidateState)) {
            await replaceShellLaunchState({ installationDir: observed.installationDir, expectedState: observed.candidateState, nextState: observed.originalState, restoreOriginal });
          } else if (!equal(actual.state, observed.originalState)) fail("RESTORE_STATE_CONFLICT");
          if (switched) {
            const oldAlive = (await snapshot()).some(item => sameIdentity(item, observed.oldMain));
            if (oldAlive) fail("ORIGINAL_APPLICATION_RECOVERY_REQUIRED");
            await waitReleased(snapshot, observed.oldMain, owner, known, timeout, async processes => { attempt = await persistOwned(attempt!, processes, known.values()); refreshOwned(known, attempt, attempt.oldMain); }, observed.schemaVersion !== 3);
            await boundary.verifyOriginal(observed); assertOwner();
            const restored = await launchMain(boundary, attempt, "original", snapshot, timeout, value => { owned = value; }, value => { attempt = value; }, assertOwner);
            owned = restored.owned; const ready = await restored.ready, current = restored.attempt; attempt = current;
            await validateReady(current, ready, "original", snapshot); assertOwner();
            restorationPermitted = true;
            const permitRevision = shellUpdateHandoffRevision(current);
            const completion = await watchOwned(restored.owned, snapshot, () => {
              assertOwner(); return sendAndWait(restored.inbox, restored.owned.child as ShellHandoffChannel, "started", { ...restored.bootstrap, kind: "permit", revision: permitRevision, body: {} });
            },
              current.schemaVersion !== 3 ? async processes => { attempt = await persistOwned(attempt!, processes, restored.owned.known.values()); refreshOwned(restored.owned.known, attempt); } : undefined); correlate(completion, restored.bootstrap);
            if (completion.revision !== permitRevision || !equal(completion.body.terminalEvidence.ready, ready)) fail("RESTORE_EVIDENCE_INVALID");
            await assertLaunch(current, "original");
            const completed = await persistOwned(attempt, await snapshot(), restored.owned.known.values());
            await store.replace(completed, { ...completed, revision: completed.revision + 1, phase: "restored", terminalEvidence: completion.body.terminalEvidence });
            restored.inbox.dispose(); owned.child.disconnect(); owned.child.unref(); owned = undefined;
          }
        }
        const latest = await store.read();
        if (latest && isShellUpdateHandoffAttempt(latest) && latest.phase !== "completed" && latest.phase !== "restored" && latest.phase !== "failed") {
          await store.replace(latest, { ...latest, revision: latest.revision + 1, phase: "failed", terminalEvidence: null });
        }
      }
    } catch (additional) { failure = additional === cause ? cause : new AggregateError([cause, additional], "DESKTOP_SHELL_HANDOFF_HELPER_RECOVERY_FAILED"); }
    if (owned && cleanupAllowed && !restorationPermitted) {
      try { await stopOwned(owned, snapshot, timeout, stop, attempt && attempt.schemaVersion !== 3 ? async processes => {
        attempt = await persistOwned(attempt!, processes, []); return shellUpdateOwnedInventory(attempt);
      } : undefined); owned.inbox.dispose(); owned = undefined; }
      catch (cleanup) { failure = new AggregateError([failure, cleanup], "DESKTOP_SHELL_HANDOFF_HELPER_CLEANUP_FAILED"); }
    }
    if (owned && (!cleanupAllowed || restorationPermitted)) {
      try { owned.inbox.dispose(); if (owned.child.connected) owned.child.disconnect(); owned.child.unref(); }
      catch (additional) { failure = new AggregateError([failure, additional], "DESKTOP_SHELL_HANDOFF_HELPER_DETACH_FAILED"); }
    }
    runFailure = { cause: failure };
  } finally {
    inbox.dispose();
    if (physicalOwner) {
      try { await physicalOwner.release(); }
      catch (cause) { runFailure = { cause: runFailure ? new AggregateError([runFailure.cause, cause], "DESKTOP_SHELL_HANDOFF_HELPER_OWNER_RELEASE_FAILED") : cause }; }
    }
  }
  if (runFailure) throw await recordFinalHelperFailure(input, attempt, owner, false, Object.assign(new Error("DESKTOP_SHELL_HANDOFF_HELPER_FAILED", { cause: runFailure.cause }),
    { code: "DESKTOP_SHELL_HANDOFF_HELPER_FAILED", requestId: attempt?.requestId ?? requestId, phase: attempt?.phase }));
}

/** 同唯一attempt承接显式claim与初始库存；零Client controller子树释放后才按持久admission恢复。 */
export async function runShellRecoveryHelper(input: HelperInput): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS, pid = input.pid ?? process.pid, parentPid = input.parentPid ?? process.ppid;
  const store = createShellUpdateAttemptStore(input.dataDir), inbox = createShellHandoffInbox(input.channel, timeout);
  let attempt: ShellUpdateHandoffAttempt | undefined, owned: Owned | undefined, owner: ProcessIdentity | undefined, requestId: string | undefined;
  let permitted = false, acceptedExecution = false;
  /** 每次查询绑定当前claim及完整历史；临时新子不成为恢复停止权限。 */
  const snapshot = input.boundary?.snapshot ?? (() => {
    const extra = [...(owner ? [owner] : []), ...(owned?.identity ? [owned.identity] : []),
      ...(attempt?.schemaVersion === 3 && owned ? [...owned.known.values()] : [])];
    return processSnapshot(attempt ? { ...shellUpdateProcessSnapshotContext(attempt, extra), timeoutMs: Math.min(timeout, 10_000) } : undefined);
  });
  try {
    const arm = await inbox.next("arm"), initial = await store.read(); requestId = arm.requestId;
    if (initial?.schemaVersion === 5 && isShellUpdateHandoffAttempt(initial)) attempt = initial;
    const processes = await snapshot();
    const controller = arm.body.oldMain; owner = processes.find(item => item.pid === pid);
    if (!initial || !isShellUpdateHandoffAttempt(initial) || initial.requestId !== arm.requestId || initial.continuationId !== arm.continuationId || shellUpdateHandoffRevision(initial) !== arm.revision
      || !owner || owner.parentPid !== parentPid || controller.pid !== parentPid || owner.executable !== controller.executable
      || !processes.some(item => sameIdentity(item, controller))) fail("RECOVERY_ARM_INVALID");
    const accepted = await sendAndWait(inbox, input.channel, "accept", { ...arm, kind: "armed", body: { helper: owner } }); correlate(accepted, arm);
    const claimed = await store.read(), recovery = claimed && isShellUpdateHandoffAttempt(claimed) ? claimed.recovery : undefined;
    if (!claimed || !isShellUpdateHandoffAttempt(claimed) || !recovery || accepted.revision !== initial.revision + 1 || shellUpdateHandoffRevision(claimed) !== accepted.revision
      || recovery.claimedFromRevision !== initial.revision || !sameIdentity(recovery.controller, controller) || !sameIdentity(recovery.helper, owner)
      || recovery.main !== null || (claimed.schemaVersion === 3 ? recovery.knownOwned.length !== 0 : claimed.recovery!.knownOwnedLifecycle.some(item => item.release !== null))
      || recovery.terminalEvidence !== null || !sameHistory(claimed, initial, true)) fail("RECOVERY_ACCEPT_NOT_COMMITTED");
    attempt = claimed; acceptedExecution = true;
    await sendShellHandoffMessage(input.channel, { ...arm, kind: "accepted", revision: shellUpdateHandoffRevision(claimed), body: {} });
    attempt = await waitRecoveryReleased(attempt, snapshot, timeout, initial, value => { attempt = value; }); inbox.dispose();
    const boundary = await dependencies(input, attempt), role = recovery.direction;
    await verifyProfile(attempt);
    if (role === "original") {
      await boundary.verifyOriginal(attempt);
      const restoreOriginal = { originalState: attempt.originalState, candidateState: attempt.candidateState, admission: null };
      const actual = (await readShellLaunchState(attempt.installationDir, { restoreOriginal })).state;
      if (equal(actual, attempt.candidateState)) await replaceShellLaunchState({ installationDir: attempt.installationDir, expectedState: actual, nextState: attempt.originalState, restoreOriginal });
      else if (!equal(actual, attempt.originalState)) fail("RESTORE_STATE_CONFLICT");
    } else await boundary.verifyPrepared(attempt);
    await assertLaunch(attempt, role); await verifyProfile(attempt);
    const selected = await launchMain(boundary, attempt, role, snapshot, timeout, value => { owned = value; }, value => { attempt = value; }); attempt = selected.attempt;
    await validateReady(attempt, selected.ready, role, snapshot);
    if (role === "original") await boundary.verifyOriginal(attempt); else await boundary.verifyPrepared(attempt);
    await assertLaunch(attempt, role);
    const permittedRevision = shellUpdateHandoffRevision(attempt);
    permitted = true;
    const completion = await watchOwned(selected.owned, snapshot, () => sendAndWait(selected.inbox, selected.owned.child, "started", {
      ...selected.bootstrap, kind: "permit", revision: permittedRevision, body: {} }),
      attempt.schemaVersion !== 3 ? async processes => { attempt = await persistOwned(attempt!, processes, selected.owned.known.values()); refreshOwned(selected.owned.known, attempt); } : undefined); correlate(completion, selected.bootstrap);
    if (completion.revision !== permittedRevision || !equal(completion.body.terminalEvidence.ready, selected.ready)) fail("RESTORE_EVIDENCE_INVALID");
    await assertLaunch(attempt, role); await verifyProfile(attempt);
    attempt = await persistOwned(attempt, await snapshot(), selected.owned.known.values());
    await store.completeRecovery(attempt, completion.body.terminalEvidence);
    selected.inbox.dispose(); selected.owned.child.disconnect(); selected.owned.child.unref(); owned = undefined;
  } catch (cause) {
    let failure = cause;
    try {
      const current = await store.read();
      if (owned && attempt && current && isShellUpdateHandoffAttempt(current) && current.recovery && owner && sameIdentity(current.recovery.helper, owner)
        && sameHistory(current, attempt) && sameRecoveryOwner(current, attempt) && current.admission === null && current.recovery.terminalEvidence === null
        && owned.identity && current.recovery.main && sameIdentity(current.recovery.main, owned.identity) && !permitted) {
        attempt = current;
        await stopOwned(owned, snapshot, timeout, input.boundary?.stop ?? stopIdentity, current.schemaVersion !== 3 ? async processes => {
          attempt = await persistOwned(attempt!, processes, []); return shellUpdateOwnedInventory(attempt);
        } : undefined); owned.inbox.dispose(); owned = undefined;
      }
    } catch (additional) { failure = new AggregateError([cause, additional], "DESKTOP_SHELL_RECOVERY_HELPER_CLEANUP_FAILED"); }
    if (owned) {
      try { owned.inbox.dispose(); if (owned.child.connected) owned.child.disconnect(); owned.child.unref(); }
      catch (additional) { failure = new AggregateError([failure, additional], "DESKTOP_SHELL_RECOVERY_HELPER_DETACH_FAILED"); }
    }
    throw await recordFinalHelperFailure(input, acceptedExecution ? attempt : undefined, owner, true,
      Object.assign(new Error("DESKTOP_SHELL_RECOVERY_HELPER_FAILED", { cause: failure }), { code: "DESKTOP_SHELL_RECOVERY_HELPER_FAILED", requestId, phase: attempt?.phase }));
  } finally { inbox.dispose(); }
}

/** controller排空先持久观察；历史早行不形成父链，helper后代仍保留在原库存。 */
async function waitRecoveryReleased(attempt: ShellUpdateHandoffAttempt, snapshot: typeof processSnapshot, timeout: number, previous: ShellUpdateHandoffAttempt,
  onAttempt: (value: ShellUpdateHandoffAttempt) => void): Promise<ShellUpdateHandoffAttempt> {
  const recovery = attempt.recovery!;
  const prior = previous.recovery;
  const historical = attempt.schemaVersion !== 3 ? shellUpdateProcessInventory(previous)
    : [...historicalInventory(attempt), ...(prior ? [prior.controller, prior.helper, ...(prior.main ? [prior.main] : []), ...prior.knownOwned] : [])], deadline = Date.now() + timeout;
  while (true) {
    const processes = await snapshot();
    if (attempt.schemaVersion !== 3) {
      attempt = await persistOwned(attempt, processes, []); onAttempt(attempt);
      assertShellUpdateInventoryReleased(attempt, processes, shellUpdateProcessInventory(attempt));
    }
    const current = shellUpdateProcessInventory(attempt), pending = new Map<number, ProcessIdentity>();
    if (attempt.schemaVersion !== 3) refreshOwned(pending, attempt, recovery.controller);
    if (!processes.some(item => sameIdentity(item, recovery.helper))) fail("PROCESS_IDENTITY_INVALID");
    for (const identity of [...historical, recovery.controller]) {
      if (processes.some(item => item.pid === identity.pid && !sameIdentity(item, identity))) fail("PROCESS_IDENTITY_INVALID");
      if (processes.some(item => item.parentPid === identity.pid && !sameIdentity(item, recovery.helper)
        && !(attempt.schemaVersion !== 3 ? current : historical).some(known => sameIdentity(item, known))
        && !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < identity.created))) fail("DESCENDANT_IDENTITY_UNKNOWN");
    }
    if (!processes.some(item => [...historical, recovery.controller, ...pending.values()].some(identity => item.pid === identity.pid))) return attempt;
    if (Date.now() >= deadline) fail("PROCESS_RELEASE_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** 当前恢复写入只使用真实完整运行时事实，复用原store门禁。 */
async function recoveryRuntime(attempt: ShellUpdateHandoffAttempt, processes: ProcessIdentity[]) {
  await verifyProfile(attempt);
  const restore = attempt.admission === null && attempt.recovery?.main === null ? { restoreOriginal: {
    originalState: attempt.originalState, candidateState: attempt.candidateState, admission: null } } : undefined;
  return { caller: attempt.recovery!.helper, processes, launchState: { status: "known" as const, value: (await readShellLaunchState(attempt.installationDir, restore)).state },
    binding: { status: "matched" as const, value: attempt.binding }, profile: { status: "known" as const, dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir } };
}

/** 完整采样交原store观察；生命周期版本只用活动投影，不补写已消失临时实例。 */
async function persistOwned(attempt: ShellUpdateHandoffAttempt, processes: ProcessIdentity[], observed: Iterable<ProcessIdentity>): Promise<ShellUpdateHandoffAttempt> {
  const store = createShellUpdateAttemptStore(attempt.dataDir);
  if (attempt.schemaVersion !== 3) {
    return attempt.recovery ? await store.observeRecoveryOwned(attempt, await recoveryRuntime(attempt, processes))
      : await store.observeHandoffOwned(attempt, { caller: attempt.helper, processes });
  }
  const roots = attempt.recovery ? [attempt.recovery.controller, attempt.recovery.helper, ...(attempt.recovery.main ? [attempt.recovery.main] : [])]
    : [attempt.oldMain, attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : [])];
  const known = new Map<number, ProcessIdentity>();
  for (const item of [...(attempt.recovery?.knownOwned ?? attempt.owned ?? []), ...observed]) {
    const previous = known.get(item.pid), root = roots.find(value => value.pid === item.pid);
    if (previous && !sameIdentity(previous, item) || root && !sameIdentity(root, item)) fail("PROCESS_IDENTITY_INVALID");
    if (!root) known.set(item.pid, item);
  }
  const knownOwned = [...known.values()];
  if (attempt.recovery) return await store.observeRecoveryOwned(attempt, { ...await recoveryRuntime(attempt, processes), knownOwned });
  return await store.observeHandoffOwned(attempt, { caller: attempt.helper, processes, knownOwned });
}

/** Map只缓存持久活跃投影；旧主排空沿具体parentKey子树止于helper角色边界。 */
function refreshOwned(known: Map<number, ProcessIdentity>, attempt: ShellUpdateHandoffAttempt, root?: ProcessIdentity): void {
  let identities = shellUpdateOwnedInventory(attempt);
  if (root && attempt.schemaVersion !== 3) {
    const keys = new Set([processInstanceKey(root)]), lifecycle = attempt.recovery?.knownOwnedLifecycle ?? attempt.ownedLifecycle;
    let changed = true;
    while (changed) { changed = false; for (const item of lifecycle) if (item.release === null && keys.has(item.parentKey) && !keys.has(item.key)) { keys.add(item.key); changed = true; } }
    identities = identities.filter(identity => keys.has(processInstanceKey(identity)));
  }
  known.clear(); for (const identity of identities) known.set(identity.pid, identity);
}

/** profile仅沿真实目录，不根据attempt重定向宿主用户数据。 */
async function verifyProfile(attempt: ShellUpdateHandoffAttempt): Promise<void> {
  for (const directory of [attempt.installationDir, attempt.dataDir, attempt.userDataDir, attempt.sessionDataDir]) if (await fs.realpath(directory) !== directory) fail("PROFILE_CHANGED");
}

/** 历史字段保持原样；仅新claim必须恰好追加前轮恢复，同owner清理不准追加。 */
function sameHistory(left: ShellUpdateHandoffAttempt, right: ShellUpdateHandoffAttempt, claimed = false): boolean {
  const { revision: _leftRevision, recovery: _leftRecovery, ...leftHistory } = left, { revision: _rightRevision, recovery: _rightRecovery, ...rightHistory } = right;
  if (left.schemaVersion !== 3 && right.schemaVersion === left.schemaVersion) return equal({ ...leftHistory, controlRevision: 0, recoveryHistory: [] }, { ...rightHistory, controlRevision: 0, recoveryHistory: [] })
    && equal(left.recoveryHistory, [...right.recoveryHistory, ...(claimed && right.recovery ? [right.recovery] : [])]);
  return equal(leftHistory, rightHistory);
}
/** 首轮错误恢复只能认同一交接事实，不能收养外来request/profile/target。 */
function sameHandoffFacts(left: ShellUpdateHandoffAttempt, right: ShellUpdateHandoffAttempt): boolean {
  return ["schemaVersion", "preparationMains", "handoffRevision", "requestId", "continuationId", "oldMain", "helper", "target", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "candidateState", "binding"]
    .every(key => equal(left[key as keyof ShellUpdateHandoffAttempt], right[key as keyof ShellUpdateHandoffAttempt]));
}
/** 库存和绑定main可以按原入口推进，当前claim/controller/helper方向不能被替换。 */
function sameRecoveryOwner(left: ShellUpdateHandoffAttempt, right: ShellUpdateHandoffAttempt): boolean {
  return Boolean(left.recovery && right.recovery && ["controller", "helper", "direction", "claimedFromRevision"]
    .every(key => equal(left.recovery![key as keyof NonNullable<ShellUpdateHandoffAttempt["recovery"]>], right.recovery![key as keyof NonNullable<ShellUpdateHandoffAttempt["recovery"]>])));
}

/** 历史实例下界来自同一attempt，不能因本次helper没见过就丢弃。 */
function historicalInventory(attempt: ShellUpdateHandoffAttempt): ProcessIdentity[] {
  return [attempt.oldMain, attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : []), ...(attempt.owned ?? []),
    ...(attempt.admission ? [attempt.admission.main, attempt.admission.client] : []), ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main, attempt.terminalEvidence.ready.client] : [])];
}

/** 默认能力复用原网络、签名工件和binding；测试仅替换实际外部边界。 */
async function dependencies(input: HelperInput, attempt: ShellUpdateHandoffAttempt): Promise<HelperBoundary> {
  const snapshot = input.boundary?.snapshot ?? processSnapshot;
  let network: ReturnType<typeof createShellUpdateNetwork> | undefined;
  /** original恢复不依赖未使用网络；候选proof仍复用原唯一network读取入口。 */
  const networkOwner = async () => network ??= createShellUpdateNetwork({ store: createShellUpdateAttemptStore(attempt.dataDir),
    identity: await readDeviceIdentity(attempt.dataDir), configuredServerOrigin: input.configuredServerOrigin ?? requiredOrigin(), trustedKeys: input.trustedKeys ?? await installedKeys(attempt),
    signal: new AbortController().signal, onRetry: async context => await logHelper(input.dataDir, "DESKTOP_UPDATE_RETRY_SCHEDULED", attempt, context.error, { retry: context.retry, delayMs: context.delayMs }) });
  const trustedKeys = input.trustedKeys;
  return {
    snapshot,
    authorizeSwitch: input.boundary?.authorizeSwitch ?? (async () => await (await networkOwner()).authorizeSwitch()),
    verifyPrepared: input.boundary?.verifyPrepared ?? (async current => {
      const network = await networkOwner(), prepared = await (current.recovery || current.admission ? network.readInstalledPrepared() : network.readPrepared()), keys = trustedKeys ?? await installedKeys(current);
      await verifyShellReleaseArtifact({ manifest: prepared.manifest, trustedKeys: keys, installerPath: prepared.installerPath,
        candidateDirectory: path.join(current.installationDir, "shells", current.target.shellId) });
      await verifyBinding(current, keys);
      if (!current.recovery && !current.admission && (Date.now() < Date.parse(prepared.manifest.createdAt) || Date.now() >= Date.parse(prepared.manifest.expiresAt))) fail("MANIFEST_EXPIRED");
    }),
    verifyOriginal: input.boundary?.verifyOriginal ?? (async current => { await verifyBinding(current, trustedKeys ?? await installedKeys(current)); await verifyProfile(current); }),
    spawnMain: input.boundary?.spawnMain ?? ((executable, current) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEFLOWAI_DESKTOP_DATA_DIR: current.dataDir }; delete env.ELECTRON_RUN_AS_NODE;
      // GUI启动失败必须可见；主壳跨越helper退出，held IPC和disconnect/unref时点不变。
      return spawn(executable, [SHELL_HANDOFF_FLAG, `--user-data-dir=${current.userDataDir}`], { cwd: current.installationDir, env, windowsHide: false, detached: process.platform === "win32", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    }),
    stop: input.boundary?.stop ?? stopIdentity,
  };
}

/** 固定baseline及原active共用现有完整签名门禁，换壳不换业务binding或DB schema。 */
async function verifyBinding(attempt: ShellUpdateHandoffAttempt, keys: TrustedReleaseKeys) {
  const baseline = await resolveBaselineRelease(path.join(attempt.installationDir, "shells", attempt.originalState.baselineShellId, "resources"), { trustedReleaseKeys: keys, requireHeldStartup: true });
  const active = await resolveActiveRelease(attempt.dataDir, { trustedReleaseKeys: keys, requireHeldStartup: true });
  const health = attempt.binding.health, manifest = active?.manifest ?? baseline.manifest;
  if (attempt.binding.kind === "active" ? !active || active.releaseId !== attempt.binding.releaseId || active.manifest.packageSha256 !== attempt.binding.packageSha256 : active !== null) fail("BINDING_CHANGED");
  if (manifest.clientVersion !== health.clientVersion || manifest.protocolVersion !== health.protocolVersion || manifest.dbSchemaVersion !== health.dbSchemaVersion) fail("BINDING_CHANGED");
  return { currentReleaseId: active?.releaseId ?? "installation", webVersion: manifest.webVersion, clientVersion: manifest.clientVersion };
}

/** 仅已接管执行的最终失败落原单日志；活跃main仍拥有报告权，未知事实或写入失败保双因。 */
async function recordFinalHelperFailure(input: HelperInput, expected: ShellUpdateHandoffAttempt | undefined, owner: ProcessIdentity | undefined,
  recoveryExecution: boolean, failure: Error): Promise<Error> {
  if (!expected || !owner) return failure;
  try {
    const store = createShellUpdateAttemptStore(input.dataDir), attempt = await store.read();
    if (!attempt || !isShellUpdateHandoffAttempt(attempt) || !sameHandoffFacts(attempt, expected)
      || (recoveryExecution ? !sameHistory(attempt, expected) || !sameRecoveryOwner(attempt, expected) : Boolean(attempt.recovery))) fail("FAILURE_OWNER_INVALID");
    const helper = recoveryExecution ? attempt.recovery!.helper : attempt.helper;
    if (!sameIdentity(helper, owner) || helper.pid !== (input.pid ?? process.pid)) fail("FAILURE_OWNER_INVALID");
    const processes = await (input.boundary?.snapshot ?? processSnapshot)({ ...shellUpdateProcessSnapshotContext(attempt, [helper]), timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_SHELL_HANDOFF_TIMEOUT_MS, 10_000) });
    if (!processes.some(item => sameIdentity(item, helper))) fail("FAILURE_OWNER_INVALID");
    const prior = [attempt.oldMain, ...(recoveryExecution ? [attempt.recovery!.controller] : [])];
    if (prior.some(identity => processes.some(item => item.pid === identity.pid && !sameIdentity(item, identity)))) fail("FAILURE_OWNER_INVALID");
    if (prior.some(identity => processes.some(item => sameIdentity(item, identity)))) return failure;
    const identity = await readDeviceIdentity(attempt.dataDir), bytes = await fs.readFile(new URL("../package.json", import.meta.url));
    const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const version = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as { version?: unknown }).version : undefined;
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u.test(version)) fail("FAILURE_CONTEXT_INVALID");
    const context = await verifyBinding(attempt, input.trustedKeys ?? await installedKeys(attempt));
    if (!equal(await store.read(), attempt)) fail("FAILURE_OWNER_INVALID");
    const terminal = recoveryExecution ? attempt.recovery!.terminalEvidence : attempt.terminalEvidence;
    createUpdateFailureJournal(attempt.dataDir).recordShell({ ...context, deviceId: identity.deviceId, shellVersion: version,
      requestId: attempt.requestId, shellId: attempt.target.shellId,
      phase: recoveryExecution ? "recovery" : attempt.admission !== null ? "admission-intent" : "handoff",
      recovery: terminal ? terminal.ready.role === "original" ? "restored" : "not_needed" : "failed", error: failure });
  } catch (additional) {
    failure.cause = Object.assign(new AggregateError([failure.cause, additional], "DESKTOP_SHELL_HANDOFF_FAILURE_RECORD_FAILED"), { code: "DESKTOP_SHELL_HANDOFF_FAILURE_RECORD_FAILED" });
  }
  return failure;
}

/** 对正常主壳先持有真实close，再绑定实际采样实例，最后才发送bootstrap。 */
async function launchMain(boundary: HelperBoundary, attempt: ShellUpdateHandoffAttempt, role: "candidate" | "original", snapshot: typeof processSnapshot, timeout: number, onOwned: (value: Owned) => void,
  onAttempt: (value: ShellUpdateHandoffAttempt) => void, assertOwner?: () => void) {
  const helper = attempt.recovery?.helper ?? attempt.helper;
  const shellId = role === "candidate" ? attempt.target.shellId : attempt.originalState.activeShellId;
  assertOwner?.();
  const child = boundary.spawnMain(path.join(attempt.installationDir, "shells", shellId, "CodeFlowAI.exe"), attempt), inbox = createShellHandoffInbox(child as ShellHandoffChannel, timeout);
  let failure: { cause: unknown } | undefined;
  const closed = new Promise<void>(resolve => { child.once("error", cause => { failure = { cause }; if (owned) owned.failure = failure; }); child.once("close", () => resolve()); });
  const owned: Owned = { child, closed, inbox, known: new Map() }; onOwned(owned);
  if (!child.pid) fail("SPAWN_FAILED");
  let current = attempt;
  const store = createShellUpdateAttemptStore(attempt.dataDir);
  const sampled = await waitIdentity(snapshot, child.pid, helper.pid, timeout, attempt.schemaVersion !== 3 ? async processes => {
    current = await persistOwned(current, processes, []); onAttempt(current);
  } : undefined), identity = sampled.identity;
  owned.identity = identity;
  assertOwner?.();
  if (failure) { owned.failure = failure; throw failure.cause; }
  if (identity.executable !== path.join(attempt.installationDir, "shells", shellId, "CodeFlowAI.exe") || identity.created < helper.created) fail("PROCESS_IDENTITY_INVALID");
  if (current.recovery) current = await store.bindRecoveryMain(current, { ...await recoveryRuntime(current, sampled.processes), main: identity });
  else if (role === "candidate") current = await store.replace(current, { ...current, revision: current.revision + 1, selectedMain: identity }) as ShellUpdateHandoffAttempt;
  onAttempt(current); current = await persistOwned(current, sampled.processes, owned.known.values()); refreshOwned(owned.known, current); onAttempt(current);
  const bootstrap: ShellHandoffMessage<"bootstrap"> = { t: "desktop.shell-handoff", schemaVersion: 1, kind: "bootstrap", requestId: current.requestId,
    continuationId: current.continuationId, revision: shellUpdateHandoffRevision(current), nonce: cryptoNonce(), body: { role, main: identity } };
  assertOwner?.();
  const message = await watchOwned(owned, snapshot, () => {
    assertOwner?.(); return sendAndWait(inbox, child as ShellHandoffChannel, "ready", bootstrap);
  },
    current.schemaVersion !== 3 ? async processes => { current = await persistOwned(current, processes, owned.known.values()); refreshOwned(owned.known, current); onAttempt(current); } : undefined);
  correlate(message, bootstrap); if (message.revision !== bootstrap.revision || !sameIdentity(message.body.ready.main, identity)) fail("READY_EVIDENCE_INVALID");
  current = await persistOwned(current, await snapshot(), owned.known.values()); refreshOwned(owned.known, current); onAttempt(current);
  // Client库存已持久，再沿原严格reader归一首轮及恢复ready的键序。
  assertOwner?.();
  const ready = snapshotShellUpdateReadyEvidence(current, message.body.ready, role);
  return { owned, inbox, bootstrap, ready, attempt: current };
}

/** 等待真实旧实例与已采样后代消失；查询失败绝不当成gone，PID复用不跟随。 */
async function waitReleased(snapshot: typeof processSnapshot, oldMain: ProcessIdentity, helper: ProcessIdentity, known: Map<number, ProcessIdentity>, timeout: number,
  persist?: (processes: ProcessIdentity[]) => Promise<void>, lifecycle = false): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    const processes = await snapshot();
    if (lifecycle) { if (processes.some(item => item.pid === oldMain.pid && !sameIdentity(item, oldMain))) fail("PROCESS_IDENTITY_INVALID"); }
    else { collectDescendants(processes, oldMain, helper, known); assertNoUnknownDescendants(processes, oldMain, helper, known); }
    if (persist) await persist(processes);
    if (!processes.some(item => sameIdentity(item, oldMain)) && ![...known.values()].some(identity => processes.some(item => sameIdentity(item, identity)))) return;
    if (Date.now() >= deadline) fail("PROCESS_RELEASE_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}

/** 只沿完整活父扩展归属；未登记历史早行不认领，已知PID不受此豁免。 */
function collectDescendants(processes: ProcessIdentity[], parent: ProcessIdentity, helper: ProcessIdentity, known: Map<number, ProcessIdentity>): void {
  const roots = new Set<number>();
  if (processes.some(item => sameIdentity(item, parent))) roots.add(parent.pid);
  for (const identity of known.values()) if (processes.some(item => sameIdentity(item, identity))) roots.add(identity.pid);
  let changed = true;
  while (changed) { changed = false; for (const item of processes) if (roots.has(item.parentPid) && item.pid !== helper.pid && !roots.has(item.pid)) {
    const directParent = [parent, ...known.values()].find(identity => identity.pid === item.parentPid)!;
    if (item.pid !== parent.pid && !known.has(item.pid) && Number.isSafeInteger(item.created) && item.created > 0 && item.created < directParent.created) continue;
    if (item.created < parent.created) fail("PROCESS_IDENTITY_INVALID"); known.set(item.pid, item); roots.add(item.pid); changed = true;
  } }
}

/** 清理仅停止本次创建并重核的实例，仍等待direct child close及已知后代释放。 */
async function stopOwned(owned: Owned, snapshot: typeof processSnapshot, timeout: number, stop: typeof stopIdentity,
  observe?: (processes: ProcessIdentity[]) => Promise<ProcessIdentity[]>): Promise<void> {
  if (!owned.identity) fail("OWNED_IDENTITY_UNKNOWN");
  const original = owned.identity;
  if (observe) {
    /** 停止权只来自成功持久化后的活跃子树，不能追随复用PID。 */
    const current = async () => {
      const processes = await snapshot(), inventory = await observe(processes), descendants = [original];
      let changed = true;
      while (changed) { changed = false; for (const identity of inventory) if (!descendants.some(item => sameIdentity(item, identity))
        && descendants.some(parent => identity.parentPid === parent.pid && identity.created >= parent.created)) { descendants.push(identity); changed = true; } }
      return { processes, descendants };
    };
    const initial = await current();
    for (const identity of initial.descendants.reverse()) if ((await current()).processes.some(item => sameIdentity(item, identity))) await stop(identity);
    await bounded(owned.closed, timeout);
    const deadline = Date.now() + timeout;
    while (true) {
      const sampled = await current();
      if (!sampled.processes.some(item => sampled.descendants.some(identity => sameIdentity(item, identity)))) return;
      if (Date.now() >= deadline) fail("PROCESS_RELEASE_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const known = owned.known, processes = await snapshot();
  collectDescendants(processes, original, { ...original, pid: -1 }, known);
  assertNoUnknownDescendants(processes, original, { ...original, pid: -1 }, known);
  for (const identity of [...known.values()].reverse()) if ((await snapshot()).some(item => sameIdentity(item, identity))) await stop(identity);
  if ((await snapshot()).some(item => sameIdentity(item, original))) await stop(original);
  await bounded(owned.closed, timeout); await waitReleased(snapshot, original, { ...original, pid: -1 }, known, timeout);
}

/** 等待期间串行采样；缺父仅排除历史早行，查询故障和新孤儿中止并等在途采样结束。 */
async function watchOwned<T>(owned: Owned, snapshot: typeof processSnapshot, operation: () => Promise<T>, observe?: (processes: ProcessIdentity[]) => Promise<void>): Promise<T> {
  return await watchSamples(async () => {
    if (!owned.identity) return;
    if (owned.failure) throw owned.failure.cause;
    const original = owned.identity, processes = await snapshot();
    if (observe) await observe(processes);
    else { collectDescendants(processes, original, { ...original, pid: -1 }, owned.known); assertNoUnknownDescendants(processes, original, { ...original, pid: -1 }, owned.known); }
    if (processes.some(item => item.pid === original.pid && !sameIdentity(item, original))) fail("PROCESS_IDENTITY_INVALID");
    if (!processes.some(item => sameIdentity(item, original)) && processes.some(item => item.parentPid === original.pid && !owned.known.has(item.pid)
      && !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < original.created))) fail("DESCENDANT_IDENTITY_UNKNOWN");
  }, operation, () => owned.inbox.dispose());
}

/** 仅一条串行采样尾链；阶段结束先停并await，后续network/intent/complete才能写。 */
async function watchSamples<T>(sampleInput: () => Promise<void>, operation: () => Promise<T>, cancel: () => void): Promise<T> {
  let rejectQuery!: (cause: unknown) => void, active = true, failure: { cause: unknown } | undefined;
  let tail = Promise.resolve();
  const queryFailed = new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
  const sample = async () => {
    if (active) await sampleInput();
  };
  await sample();
  const timer = setInterval(() => {
    tail = tail.then(sample).catch(cause => { failure ??= { cause }; rejectQuery(cause); });
  }, 50);
  let primary: { cause: unknown } | undefined, result!: T;
  try { result = await Promise.race([operation(), queryFailed]); }
  catch (cause) { primary = { cause }; cancel(); }
  finally { active = false; clearInterval(timer); await tail; }
  if (primary) throw failure && failure.cause !== primary.cause ? new AggregateError([primary.cause, failure.cause], "DESKTOP_SHELL_HANDOFF_SAMPLE_FAILED") : primary.cause;
  if (failure) throw failure.cause;
  await sampleInput();
  return result;
}

/** 缺父新孤儿必须中止；仅未登记且严格早于完整父实例的历史行不形成关系。 */
function assertNoUnknownDescendants(processes: ProcessIdentity[], parent: ProcessIdentity, helper: ProcessIdentity, known: Map<number, ProcessIdentity>): void {
  for (const original of [parent, ...known.values()]) {
    if (processes.some(item => sameIdentity(item, original))) continue;
    if (processes.some(item => item.parentPid === original.pid && item.pid !== helper.pid
      && ![...known.values()].some(identity => sameIdentity(item, identity))
      && (item.pid === parent.pid || known.has(item.pid) || !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < original.created)))) fail("DESCENDANT_IDENTITY_UNKNOWN");
  }
}

/** 返回身份及同次完整快照供绑定后观察；未见main的成功样本也不能丢失已知库存。 */
async function waitIdentity(snapshot: typeof processSnapshot, pid: number, parentPid: number, timeout: number,
  observe?: (processes: ProcessIdentity[]) => Promise<void>): Promise<{ identity: ProcessIdentity; processes: ProcessIdentity[] }> {
  const deadline = Date.now() + timeout;
  do { const processes = await snapshot(), identity = processes.find(item => item.pid === pid); if (identity) { if (identity.parentPid !== parentPid || identity.created < 1 || !identity.executable) fail("PROCESS_IDENTITY_INVALID"); return { identity, processes }; }
    if (observe) await observe(processes);
    if (Date.now() >= deadline) fail("PROCESS_IDENTITY_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
}

/** 授权可推进原网络槽，但不能换旧主/helper/目标或进入放行阶段。 */
async function currentHandoff(store: ReturnType<typeof createShellUpdateAttemptStore>, expected: ShellUpdateHandoffAttempt): Promise<ShellUpdateHandoffAttempt> {
  const current = await store.read();
  if (!current || !isShellUpdateHandoffAttempt(current) || current.recovery || current.phase !== "handoff" || current.admission !== null || current.selectedMain !== null
    || current.requestId !== expected.requestId || !sameIdentity(current.helper, expected.helper) || !sameIdentity(current.oldMain, expected.oldMain)
    || !["schemaVersion", "preparationMains", "handoffRevision", "target", "installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "candidateState", "binding"].every(key => equal(current[key as keyof typeof current], expected[key as keyof typeof expected]))
    || current.continuationId !== expected.continuationId) fail("STATE_CONFLICT");
  return current;
}

/** 完整S0/S1包含previous/baseline，第三态不允许恢复或继续副作用。 */
async function assertLaunch(attempt: ShellUpdateHandoffAttempt, role: "original" | "candidate"): Promise<void> {
  if (!equal((await readShellLaunchState(attempt.installationDir)).state, role === "original" ? attempt.originalState : attempt.candidateState)) fail("LAUNCH_STATE_CONFLICT");
}
/** permit前共用原严格证据reader，并核实际helper/main/Client实例和完整INI。 */
async function validateReady(attempt: ShellUpdateHandoffAttempt, input: ShellUpdateReadyEvidence, role: "original" | "candidate", snapshot: typeof processSnapshot): Promise<void> {
  const ready = snapshotShellUpdateReadyEvidence(attempt, input, role), processes = await snapshot();
  if (![attempt.recovery?.helper ?? attempt.helper, ready.main, ready.client].every(identity => processes.some(item => sameIdentity(item, identity)))
    || processes.some(item => sameIdentity(item, attempt.oldMain) || attempt.recovery && sameIdentity(item, attempt.recovery.controller))) fail("READY_PROCESS_CONFLICT");
  await assertLaunch(attempt, role);
}
/** 同一通道会话严格关联请求/接续/nonce，revision由每个持久阶段另核。 */
function correlate(message: ShellHandoffMessage, expected: Pick<ShellHandoffMessage, "requestId" | "continuationId" | "nonce">): void {
  if (message.requestId !== expected.requestId || message.continuationId !== expected.continuationId || message.nonce !== expected.nonce) fail("MESSAGE_CORRELATION_INVALID");
}
/** 有界等待不吞掉实际失败或提前释放进程owner。 */
async function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DESKTOP_SHELL_HANDOFF_CLOSE_TIMEOUT")), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** 同时拥有发送和等待，发送拒绝后也结算pending，防止未处理Promise。 */
async function sendAndWait<K extends Parameters<ReturnType<typeof createShellHandoffInbox>["next"]>[0]>(inbox: ReturnType<typeof createShellHandoffInbox>, channel: ShellHandoffChannel, kind: K, message: ShellHandoffMessage) {
  try { const [response] = await Promise.all([inbox.next(kind), sendShellHandoffMessage(channel, message)]); return response; }
  catch (cause) { inbox.dispose(); throw cause; }
}
/** 信任仍只取原安装资源，不读取用户数据中的信任根。 */
async function installedKeys(attempt: ShellUpdateHandoffAttempt): Promise<TrustedReleaseKeys> { return assertTrustedReleaseKeys(JSON.parse(await fs.readFile(path.join(path.dirname(attempt.oldMain.executable), "resources", "release-trust.json"), "utf8"))); }
/** 缺少固定origin明确失败，不退回另一个服务器。 */
function requiredOrigin(): string { const value = process.env.CODEFLOWAI_DESKTOP_SERVER_ORIGIN?.trim(); if (!value) fail("ORIGIN_REQUIRED"); return value; }
/** nonce只用于继承IPC，不进入参数、环境或日志。 */
function cryptoNonce(): string { return crypto.randomBytes(32).toString("hex"); }
/** 已严格reader生成的事实比较不使用对象身份。 */
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** 固定短码交所属main/helper边界记录，不包含消息正文。 */
function fail(code: string): never { throw Object.assign(new Error(`DESKTOP_SHELL_HANDOFF_${code}`), { code: `DESKTOP_SHELL_HANDOFF_${code}` }); }

/** helper错误只记录短码、已核实体与冲突安全投影，保留根因类别，不记录原文凭据。 */
async function logHelper(dataDir: string, errorCode: string, attempt: ShellUpdateHandoffAttempt | undefined, cause: unknown, extra: object = {}): Promise<void> {
  const codes: string[] = [], processIdentityConflicts: ReturnType<typeof identityConflictDiagnostic>[] = [],
    inventoryFailures: ReturnType<typeof inventoryFailureDiagnostic>[] = [], pending = [cause], seen = new Set<unknown>();
  while (pending.length) { const value = pending.pop(); if (seen.has(value)) continue; seen.add(value);
    if (value instanceof Error) {
      if (Object.hasOwn(value, "processIdentityConflict")) processIdentityConflicts.push(identityConflictDiagnostic(diagnosticData(value, "processIdentityConflict")));
      if (Object.hasOwn(value, "inventoryFailure")) inventoryFailures.push(inventoryFailureDiagnostic(diagnosticData(value, "inventoryFailure")));
      const code = diagnosticData(value, "code"); let name: unknown;
      for (let prototype: object | null = value; prototype && name === undefined; prototype = Object.getPrototypeOf(prototype)) name = diagnosticData(prototype, "name");
      codes.push(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : typeof name === "string" ? name : "Error");
      if (Object.hasOwn(value, "cause")) pending.push(diagnosticData(value, "cause"));
      if (value instanceof AggregateError) pending.push(...diagnosticArray(diagnosticData(value, "errors")));
    } else codes.push(value === undefined ? "UNDEFINED" : "NON_ERROR");
  }
  const directory = path.join(dataDir, "logs"); await fs.mkdir(directory, { recursive: true });
  const id = cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, "requestId")?.value : undefined;
  const helper = attempt?.recovery?.helper ?? attempt?.helper;
  await fs.appendFile(path.join(directory, "desktop-errors.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), errorCode,
    requestId: attempt?.requestId ?? (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(id) ? id : crypto.randomUUID()),
    shellId: attempt?.target.shellId, revision: attempt?.revision, phase: attempt?.phase, dataDir, processId: process.pid,
    helper: helper ? { pid: helper.pid, parentPid: helper.parentPid, created: helper.created } : undefined,
    recoveryDirection: attempt?.recovery?.direction, claimedFromRevision: attempt?.recovery?.claimedFromRevision, rootCause: codes,
    ...(processIdentityConflicts.length ? { processIdentityConflicts } : {}), ...(inventoryFailures.length ? { inventoryFailures } : {}), ...extra })}\n`, "utf8");
}

/** 脚本处理边界只记一次；事实读取或落日志失败也必须保留原始helper根因。 */
export async function reportShellHandoffHelperFailure(dataDir: string, cause: unknown): Promise<never> {
  let failure = cause, attempt: ShellUpdateHandoffAttempt | undefined;
  try { const observed = await createShellUpdateAttemptStore(dataDir).read(); if (observed && isShellUpdateHandoffAttempt(observed)) attempt = observed; }
  catch (additional) { failure = new AggregateError([failure, additional], "DESKTOP_SHELL_HANDOFF_HELPER_DIAGNOSTIC_READ_FAILED"); }
  try { await logHelper(dataDir, "DESKTOP_SHELL_HANDOFF_HELPER_FAILED", attempt, failure); }
  catch (additional) { failure = new AggregateError([failure, additional], "DESKTOP_SHELL_HANDOFF_HELPER_LOG_FAILED"); }
  throw failure;
}

// 仅显式脚本入口运行；普通import不启动helper或联网。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.argv[3];
  void (async () => {
    if (process.argv.length !== 4 || !["--codeflow-shell-handoff-helper", "--codeflow-shell-recovery-helper"].includes(process.argv[2]!) || !dataDir || !path.isAbsolute(dataDir)
      || await fs.realpath(dataDir) !== dataDir || !process.send || !process.connected) fail("ENTRY_INVALID");
    try { await (process.argv[2] === "--codeflow-shell-recovery-helper" ? runShellRecoveryHelper : runShellHandoffHelper)({ dataDir, channel: process }); }
    catch (cause) { await reportShellHandoffHelperFailure(dataDir, cause); }
  })().then(() => { if (process.connected) process.disconnect?.(); }, cause => {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "DESKTOP_SHELL_HANDOFF_HELPER_FAILED";
    process.stderr.write(`${JSON.stringify({ errorCode: code })}\n`); process.exitCode = 1; if (process.connected) process.disconnect?.();
  });
}
