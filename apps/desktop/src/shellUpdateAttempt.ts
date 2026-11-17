import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertReleaseId, type DesktopClientHealth } from "@codeflowai/shared";
import { assertDesktopUpdateFailureRecord, type ShellUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import { parseShellLaunchState, serializeShellLaunchState, type ShellLaunchState } from "./shellLaunchState.js";
import { snapshotUpdateNetworkDurableState, type UpdateNetworkDurableAdapter, type UpdateNetworkDurableState, type UpdateNetworkSlot } from "./updateNetworkRetry.js";
import { sameIdentity, type ProcessIdentity, type ProcessSnapshotContext } from "./windowsProcessIdentity.js";
import { activeProcessInventory, assertProcessInventoryReleased, createProcessInventory, observeProcessInventory,
  preflightProcessInventory, processInstanceKey, readProcessInventory, type ShellProcessInventory, type ShellProcessLifecycle } from "./shellProcessInventory.js";
import { acquireShellUpdateFileOwner, coordinateShellUpdateFile, type ShellUpdateFileRequest, type ShellUpdateFileOwnerScope } from "./shellUpdateFileCoordinator.js";
export type { ShellProcessInventory, ShellProcessLifecycle, ShellProcessRelease } from "./shellProcessInventory.js";

export type ShellUpdateAttemptBinding =
  | { kind: "active"; releaseId: string; packageSha256: string; health: DesktopClientHealth }
  | { kind: "installation"; baselineShellId: string; health: DesktopClientHealth };
type AttemptBase = {
  requestId: string; revision: number;
  installationDir: string; dataDir: string; userDataDir: string; sessionDataDir: string;
  originalState: ShellLaunchState; binding: ShellUpdateAttemptBinding;
  retriesUsed: number;
};
type AttemptPhase = "preparing" | "handoff" | "failed";
export type ShellUpdateTarget = { shellId: string; manifestSha256: string; installerSha256: string; installerSize: number };
type SelectedTarget = { target: ShellUpdateTarget; candidateState: ShellLaunchState };
export type ShellUpdateAttemptV1 = AttemptBase & SelectedTarget & { schemaVersion: 1; phase: AttemptPhase };
export type ShellUpdateAttemptV2 = AttemptBase & { schemaVersion: 2; phase: AttemptPhase | "no-update"; network: UpdateNetworkSlot | null }
  & (SelectedTarget | { target: null; candidateState: null });
export type ShellUpdateReadyEvidence = {
  role: "original" | "candidate"; continuationId: string; main: ProcessIdentity; client: ProcessIdentity;
  readyRequestId: string; health: DesktopClientHealth; binding: ShellUpdateAttemptBinding; launchState: ShellLaunchState;
  profile: { dataDir: string; userDataDir: string; sessionDataDir: string }; mainFrame: "loaded";
  startup: { continuationId: string; admission: "paused" };
};
export type ShellUpdateTerminalEvidence = {
  ready: ShellUpdateReadyEvidence; startedRequestId: string; continueRequestId: string;
  startup: "completed"; application: "started";
};
export type ShellUpdateHandoffFacts = { continuationId: string; oldMain: ProcessIdentity; helper: ProcessIdentity };
export type ShellUpdateHandoffSnapshotFacts = ShellUpdateHandoffFacts
  & ({ processes: ProcessIdentity[]; knownOwned: ProcessIdentity[]; lifecycle?: true } | { processes?: never; knownOwned?: never; lifecycle?: never });
export type ShellUpdateHandoffOwnedFacts = { caller: ProcessIdentity; processes: ProcessIdentity[]; knownOwned?: ProcessIdentity[] };
export type ShellUpdateRecoveryExecution = {
  controller: ProcessIdentity; helper: ProcessIdentity; main: ProcessIdentity | null; direction: "original" | "candidate";
  claimedFromRevision: number; knownOwned: ProcessIdentity[]; terminalEvidence: ShellUpdateTerminalEvidence | null;
};
export type ShellUpdateAttemptV3 = AttemptBase & SelectedTarget & ShellUpdateHandoffFacts & {
  schemaVersion: 3; phase: "handoff" | "admission-intent" | "completed" | "restored" | "failed";
  network: UpdateNetworkSlot; selectedMain: ProcessIdentity | null;
  admission: ShellUpdateReadyEvidence | null; terminalEvidence: ShellUpdateTerminalEvidence | null;
  recovery?: ShellUpdateRecoveryExecution | null;
  owned?: ProcessIdentity[];
};
export type ShellUpdateRecoveryExecutionV4 = ShellUpdateRecoveryExecution & { knownOwnedLifecycle: ShellProcessLifecycle[] };
export type ShellUpdateAttemptV4 = Omit<ShellUpdateAttemptV3, "schemaVersion" | "owned" | "recovery"> & {
  schemaVersion: 4; controlRevision: number; owned: ProcessIdentity[]; ownedLifecycle: ShellProcessLifecycle[];
  recoveryHistory: ShellUpdateRecoveryExecutionV4[]; recovery?: ShellUpdateRecoveryExecutionV4 | null;
};
export type ShellPreparationMain = { identity: ProcessIdentity; boundAtRevision: number };
export type ShellUpdatePreparationAttemptV5 = Omit<ShellUpdateAttemptV2, "schemaVersion" | "phase"> & {
  schemaVersion: 5; phase: "preparing" | "no-update" | "failed"; controlRevision: number;
  preparationMains: ShellPreparationMain[]; owned: ProcessIdentity[]; ownedLifecycle: ShellProcessLifecycle[];
};
export type ShellUpdatePreparationAttempt = ShellUpdateAttemptV2 | ShellUpdatePreparationAttemptV5;
export type ShellUpdateHandoffAttemptV5 = Omit<ShellUpdateAttemptV4, "schemaVersion"> & {
  schemaVersion: 5; preparationMains: ShellPreparationMain[]; handoffRevision: number;
};
type LifecycleHandoffAttempt = ShellUpdateAttemptV4 | ShellUpdateHandoffAttemptV5;
type InventoryAttempt = ShellUpdateHandoffAttempt | ShellUpdatePreparationAttemptV5;
export type ShellUpdateHandoffAttempt = ShellUpdateAttemptV3 | LifecycleHandoffAttempt;
export type ShellUpdateAttempt = ShellUpdateAttemptV1 | ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt;
export type ShellUpdateProcessObservation = { status: "alive" | "gone"; identity: ProcessIdentity } | { status: "unknown" };
export type ShellUpdateRecoveryFacts = {
  caller: ProcessIdentity; owner: ShellUpdateProcessObservation; oldMain: ShellUpdateProcessObservation;
  selectedMain: ShellUpdateProcessObservation | { status: "not-started" };
  launchState: { status: "known"; value: ShellLaunchState } | { status: "unknown" };
  binding: { status: "matched"; value: ShellUpdateAttemptBinding } | { status: "mismatch" | "unknown" };
  profile: { status: "known"; dataDir: string; userDataDir: string; sessionDataDir: string } | { status: "unknown" };
  ownedReleased: "verified" | "pending" | "unknown";
};
export type ShellUpdateRecoveryDecision = { action: "wait-owner" | "resume-original" | "restore-original" | "resume-candidate" | "stop"; reason: string };
export type ShellUpdateRecoveryRuntimeFacts = Pick<ShellUpdateRecoveryFacts, "caller" | "launchState" | "binding" | "profile"> & { processes: ProcessIdentity[] };
export type ShellUpdateRecoveryOwnedFacts = ShellUpdateRecoveryRuntimeFacts & { knownOwned?: ProcessIdentity[] };
export type ShellUpdateRecoveryBindFacts = ShellUpdateRecoveryRuntimeFacts & { main: ProcessIdentity };
export type ShellUpdateRecoveryClaimFacts = ShellUpdateRecoveryFacts & { helper: ProcessIdentity; processes: ProcessIdentity[];
  knownOwned: { status: "known"; identities: ProcessIdentity[] } | { status: "unknown" } };
export type ShellUpdateAttemptStore = {
  /** 仅已释放的准备/充分终态可归档，未完成交接不能被资源或安装覆盖绕过。 */
  retire(expected: unknown, facts: { processes: ProcessIdentity[]; caller?: ProcessIdentity }): Promise<void>;
  read(): Promise<ShellUpdateAttempt | null>;
  replace(expected: unknown, next: unknown): Promise<ShellUpdateAttempt>;
  /** 新helper以同一真实根和严格reader保留物理owner，释放前不允许嵌套。 */
  acquireOwner(timeoutMs: number): Promise<ShellUpdateFileOwnerScope>;
  /** 仅从无更新或充分启动完成事实开启新ID周期；运行时另核实际释放和binding。 */
  startNext(expectedTerminal: unknown, fresh: unknown): Promise<ShellUpdateAttempt>;
  /** 新周期以真实主进程和就绪Client建立准备期唯一持久库存。 */
  beginPreparation(expected: unknown, fresh: unknown, facts: { main: ProcessIdentity; client: ProcessIdentity; readyRequestId: string; processes: ProcessIdentity[]; failure?: ShellUpdateFailureRecord }): Promise<ShellUpdatePreparationAttemptV5>;
  /** 普通启动在旧树严格释放后原子追加新主进程根。 */
  bindPreparationMain(expected: unknown, facts: ShellUpdateRecoveryRuntimeFacts): Promise<ShellUpdatePreparationAttemptV5>;
  /** 当前准备主进程按完整快照持久化归属及释放。 */
  observePreparationOwned(expected: unknown, facts: { caller: ProcessIdentity; processes: ProcessIdentity[] }): Promise<ShellUpdatePreparationAttemptV5>;
  /** 已选目标显式交给helper；旧2保持3/4返回，新5保留准备历史。 */
  beginHandoff(expected: ShellUpdatePreparationAttemptV5, facts: ShellUpdateHandoffFacts & { lifecycle: true; processes: ProcessIdentity[] }): Promise<ShellUpdateHandoffAttemptV5>;
  beginHandoff<const F>(expectedV2: unknown, facts: F): Promise<F extends { lifecycle: true } ? ShellUpdateAttemptV4 : ShellUpdateAttemptV3>;
  /** 首轮helper接收真实采样历史并沿存活父链扩展；旧缺库存不能在此补造。 */
  observeHandoffOwned<T extends ShellUpdateHandoffAttempt>(expected: T, facts: unknown): Promise<T>;
  /** 原owner与已知库存明确释放后，在同一事实中记录当前恢复执行。 */
  beginRecovery<T extends ShellUpdateHandoffAttempt>(expected: T, facts: unknown): Promise<T>;
  /** 当前恢复helper只可绑定一次实际子main，不能改历史selectedMain。 */
  bindRecoveryMain<T extends ShellUpdateHandoffAttempt>(expected: T, facts: unknown): Promise<T>;
  /** 仅当前归属库存变化时持久化，无变化仍核磁盘expected。 */
  observeRecoveryOwned<T extends ShellUpdateHandoffAttempt>(expected: T, facts: unknown): Promise<T>;
  /** 充分started只结算当前恢复执行，历史准入和终态不变。 */
  completeRecovery<T extends ShellUpdateHandoffAttempt>(expected: T, evidence: unknown): Promise<T>;
};

const FILENAME = "shell-update-attempt.json";
const MAX_BYTES = 64 * 1024;
const MAX_LIFECYCLE_BYTES = 1024 * 1024;
const FIELDS = ["schemaVersion", "requestId", "revision", "installationDir", "dataDir", "userDataDir", "sessionDataDir",
  "target", "originalState", "candidateState", "binding", "retriesUsed", "phase"] as const;
type Temporary = { path: string; identity?: BigIntStats; closed: boolean };

/** 所有实例经同根写优先入口保存唯一事实；不核远端资格或承诺断电目录项耐久。 */
export function createShellUpdateAttemptStore(dataDir: string): ShellUpdateAttemptStore {
  const selectedRoot = readPath(dataDir);
  let boundRoot: { root: string; identity: BigIntStats } | undefined;
  let ownerScope: ShellUpdateFileOwnerScope | undefined;

  /** 首次确认后固定真实根；同 owner 不接受别名重指或同路径实体重建。 */
  async function resolveBoundRoot(): Promise<{ root: string; identity: BigIntStats }> {
    const root = await fs.realpath(selectedRoot), identity = await rootStat(root);
    if (boundRoot && (root !== boundRoot.root || identity.dev !== boundRoot.identity.dev || identity.ino !== boundRoot.identity.ino)) invalid();
    boundRoot ??= { root, identity };
    return boundRoot;
  }

  /** owner 独自执行完整物理操作；内部 expected 与读回不重入协调器。 */
  async function execute(request: ShellUpdateFileRequest): Promise<ShellUpdateAttempt | null> {
    if (request.kind === "read") {
      try {
        const { root, identity } = await resolveBoundRoot();
        return await readCurrent(root, identity);
      } catch (cause) { throw operationError("READ", "read", false, cause); }
    }
    let expected: ShellUpdateAttempt | null, next: ShellUpdateAttempt | undefined;
    try {
      expected = request.expected === null ? null : readAttempt(request.expected);
      if (request.kind === "replace") next = readAttempt(request.next);
    } catch (cause) { throw operationError("REPLACE", "input", false, cause); }
    if (next) return await replaceCurrent(resolveBoundRoot, expected, next);
    if (request.kind === "retire") {
      let archived = false;
      try {
        if (!expected) invalid();
        const facts = fields(request.facts, undefined), caller = Object.hasOwn(facts, "caller") ? readProcess(facts.caller) : undefined;
        fields(facts, ["processes", ...(caller ? ["caller"] : [])]);
        const processes = readProcessList(facts.processes, true);
        if (caller && (!processes.some(item => sameIdentity(item, caller))
          || ![expected.originalState.activeShellId, expected.candidateState?.activeShellId].some(id => id && caller.executable === shellExecutable(expected!, id)))) invalid();
        const retained = caller ? [caller] : [];
        // 只保留当前壳及其 Electron 辅助进程；Client/引擎仍必须真实退出。
        for (let length = -1; length !== retained.length;) {
          length = retained.length;
          for (const item of processes) if (caller && item.executable === caller.executable
            && /(?:^|\s)"?--type=(?:renderer|gpu-process|utility|zygote|crashpad-handler|broker)"?(?:\s|$)/u.test(item.commandLine)
            && retained.some(parent => item.parentPid === parent.pid && item.created >= parent.created)
            && !retained.some(known => sameIdentity(known, item))) retained.push(item);
        }
        if (isShellUpdateHandoffAttempt(expected)) {
          const terminal = expected.recovery ? expected.recovery.terminalEvidence !== null : ["completed", "restored"].includes(expected.phase);
          if (!terminal) invalid();
          assertShellUpdateInventoryReleased(expected, processes, retained);
        } else {
          // 明确网络失败尚未交接；原失败事实完整归档，仍须证明 Client 和引擎已退出。
          if (expected.schemaVersion !== 5 || !["preparing", "no-update"].includes(expected.phase)
            && !(expected.phase === "failed" && expected.network?.status === "failed")) invalid();
          assertShellUpdateInventoryReleased(expected, processes, retained);
        }
        const { root, identity } = await resolveBoundRoot();
        if (expected.dataDir !== root || !equal(await readCurrent(root, identity), expected)) invalid();
        await assertRoot(root, identity);
        await fs.rename(path.join(root, FILENAME), path.join(root, `shell-update-retired-${crypto.randomUUID()}.json`));
        archived = true;
        await assertRoot(root, identity);
        if (await readCurrent(root, identity) !== null) invalid();
        return null;
      } catch (cause) { throw operationError("REPLACE", "retire", archived, cause, expected?.requestId); }
    }
    try {
      const { root, identity } = await resolveBoundRoot(), current = await readCurrent(root, identity);
      if (!expected || expected.dataDir !== root || !equal(current, expected)) invalid();
      return current;
    } catch (cause) { throw operationError("REPLACE", "check-expected", false, cause, expected?.requestId); }
  }

  /** 根身份可先查询；目标文件只由当选 owner 打开，远端值再次严格复制。 */
  async function physical(request: ShellUpdateFileRequest): Promise<ShellUpdateAttempt | null> {
    ownerScope?.assertActive();
    let bound: Awaited<ReturnType<typeof resolveBoundRoot>>;
    try { bound = boundRoot ?? await resolveBoundRoot(); }
    catch (cause) {
      const write = request.kind !== "read";
      throw operationError(write ? "REPLACE" : "READ", write ? request.kind === "checkExpected" ? "check-expected" : "read-current" : "read", false, cause,
        write && request.expected !== null ? (request.expected as ShellUpdateAttempt).requestId : undefined);
    }
    let result: ShellUpdateAttempt | null;
    try {
      result = await coordinateShellUpdateFile({ root: bound.root, dev: bound.identity.dev.toString(), ino: bound.identity.ino.toString() }, request, execute,
        async () => { await resolveBoundRoot(); });
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_MISMATCH") {
        throw operationError(request.kind === "read" ? "READ" : "REPLACE", request.kind === "read" ? "read" : "read-current", false, cause,
          request.kind === "replace" ? (request.next as ShellUpdateAttempt).requestId : undefined);
      }
      throw cause;
    }
    if (result === null && (request.kind === "read" || request.kind === "retire")) return null;
    const value = readAttempt(result);
    if (value.dataDir !== bound.root || request.kind === "replace" && !equal(value, request.next)
      || request.kind === "checkExpected" && !equal(value, request.expected)) invalid();
    return value;
  }

  /** 显式库存及恢复操作共用严格快照和物理核心；零变化也按队列核真实expected。 */
  async function recover(kind: "handoff-owned" | "claim" | "bind" | "observe" | "complete", expectedInput: unknown, factsInput: unknown): Promise<ShellUpdateHandoffAttempt> {
    let expected: ShellUpdateHandoffAttempt, next: ShellUpdateHandoffAttempt;
    let requestId: string | undefined;
    try {
      const value = readAttempt(expectedInput); requestId = value.requestId;
      if (!isShellUpdateHandoffAttempt(value)) invalid();
      expected = value; next = expected.schemaVersion !== 3 ? lifecycleNext(kind, expected, factsInput) : recoveryNext(kind, expected, factsInput);
    } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
    return await physical(equal(expected, next) ? { kind: "checkExpected", expected } : { kind: "replace", expected, next }) as ShellUpdateHandoffAttempt;
  }

  return {
    /** 首次 await 前严格复制事实，归档在唯一物理队列内核 expected 后执行。 */
    async retire(expectedInput, factsInput) {
      const expected = readAttempt(expectedInput), facts = fields(factsInput, undefined);
      const copied = { processes: readProcessList(facts.processes, true),
        ...(Object.hasOwn(facts, "caller") ? { caller: readProcess(facts.caller) } : {}) };
      fields(facts, ["processes", ...(copied.caller ? ["caller"] : [])]);
      await physical({ kind: "retire", expected, facts: copied });
    },
    /** 仅转接现有根与execute；作用域结束后仍由协调器核资源释放结果。 */
    async acquireOwner(timeoutMs) {
      const { root, identity } = await resolveBoundRoot();
      const acquired = await acquireShellUpdateFileOwner({ root, dev: identity.dev.toString(), ino: identity.ino.toString() }, execute, timeoutMs);
      ownerScope = acquired;
      return {
        assertActive: acquired.assertActive,
        /** 成功或失败都保留release结果，仅解除本store的作用域引用。 */
        async release() {
          try { await acquired.release(); }
          finally { if (ownerScope === acquired) ownerScope = undefined; }
        },
      };
    },
    /** 只有真实根有效且固定文件确认不存在才返回 null。 */
    async read() {
      return await physical({ kind: "read" });
    },
    /** 在首次 await 前复制严格输入，按预期快照发布并用同一 reader 读回。 */
    async replace(expectedInput, nextInput) {
      let expected: ShellUpdateAttempt | null, next: ShellUpdateAttempt;
      let requestId: string | undefined;
      try {
        expected = expectedInput === null ? null : readAttempt(expectedInput);
        next = readAttempt(nextInput);
        requestId = next.requestId;
        if (expected && expected.schemaVersion >= 4 && next.schemaVersion === expected.schemaVersion) {
          if (!("controlRevision" in expected) || !("controlRevision" in next)) invalid();
          if (next.controlRevision !== expected.controlRevision) invalid();
          assertTransition(expected, next);
          next = readAttempt({ ...next, controlRevision: next.revision });
        } else assertTransition(expected, next);
      } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
      return await physical({ kind: "replace", expected, next }) as ShellUpdateAttempt;
    },
    /** 首await前快照；新周期只接受充分终态及已核稳定目录、完整最终INI。 */
    async startNext(expectedInput, freshInput) {
      let expected: ShellUpdateAttempt, fresh: ShellUpdateAttempt;
      let requestId: string | undefined;
      try {
        expected = readAttempt(expectedInput);
        fresh = readAttempt(freshInput);
        requestId = fresh.requestId;
        if (fresh.schemaVersion !== 2 || expected.schemaVersion === 5 || fresh.target !== null || fresh.candidateState !== null) invalid();
        assertNextCycle(expected, fresh); assertTransition(null, fresh);
      } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
      return await physical({ kind: "replace", expected, next: fresh }) as ShellUpdateAttempt;
    },
    /** 新周期只接受充分终态或显式人工失败证据；首await前核完整库存与新请求。 */
    async beginPreparation(expectedInput, freshInput, factsInput) {
      let expected: ShellUpdateAttempt | null, next: ShellUpdatePreparationAttemptV5;
      let requestId: string | undefined;
      try {
        expected = expectedInput === null ? null : readAttempt(expectedInput);
        const fresh = readAttempt(freshInput), input = fields(factsInput, undefined);
        const hasFailure = Object.hasOwn(input, "failure");
        const facts = fields(input, ["main", "client", "readyRequestId", "processes", ...(hasFailure ? ["failure"] : [])]);
        requestId = fresh.requestId;
        if (fresh.schemaVersion !== 2 || fresh.target !== null || fresh.candidateState !== null) invalid();
        assertTransition(null, fresh);
        if (hasFailure) assertManualFailureCycle(expected, fresh, facts.failure);
        else assertNextCycle(expected, fresh);
        const main = readProcess(facts.main), client = readProcess(facts.client), processes = readProcessList(facts.processes, true);
        readRequestId(facts.readyRequestId);
        if (main.executable !== shellExecutable(fresh, fresh.originalState.activeShellId) || client.parentPid !== main.pid
          || !processes.some(item => sameIdentity(item, main)) || !processes.some(item => sameIdentity(item, client))) invalid();
        const inventory = createProcessInventory({ owned: [], roots: [main], processes, observer: main, revision: 1 });
        if (!activeProcessInventory(inventory).some(item => sameIdentity(item, client))) invalid();
        if (hasFailure) {
          const previous = expected as ShellUpdatePreparationAttemptV5;
          if (!sameIdentity(previous.preparationMains.at(-1)!.identity, main)) invalid();
          assertShellUpdateInventoryReleased(previous, processes, [main, ...inventory.owned]);
        }
        next = readAttempt({ ...fresh, schemaVersion: 5, revision: 1, controlRevision: 1,
          preparationMains: [{ identity: main, boundAtRevision: 1 }], owned: inventory.owned, ownedLifecycle: inventory.lifecycle }) as ShellUpdatePreparationAttemptV5;
      } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
      return await physical({ kind: "replace", expected, next }) as ShellUpdatePreparationAttemptV5;
    },
    /** 新根与同次完整快照证明原子保存，旧根及proof只追加不改写。 */
    async bindPreparationMain(expectedInput, factsInput) {
      const { expected, next } = preparationNext("bind", expectedInput, factsInput);
      return await physical(equal(expected, next) ? { kind: "checkExpected", expected } : { kind: "replace", expected, next }) as ShellUpdatePreparationAttemptV5;
    },
    /** 零变化也经同队列核expected；不接受内存补造的消失历史。 */
    async observePreparationOwned(expectedInput, factsInput) {
      const { expected, next } = preparationNext("observe", expectedInput, factsInput);
      return await physical(equal(expected, next) ? { kind: "checkExpected", expected } : { kind: "replace", expected, next }) as ShellUpdatePreparationAttemptV5;
    },
    /** 双输入首次 await 前严格快照，沿同串行队列和物理替换入口迁移。 */
    async beginHandoff(expectedInput: unknown, factsInput: unknown) {
      let expected: ShellUpdatePreparationAttempt, next: ShellUpdateHandoffAttempt;
      let requestId: string | undefined;
      try {
        const previous = readAttempt(expectedInput), input = fields(factsInput, undefined);
        if (isPreparationV5(previous)) {
          expected = previous; requestId = previous.requestId; next = preparationHandoff(previous, factsInput);
        } else {
          const withOwned = Object.hasOwn(input, "processes") || Object.hasOwn(input, "knownOwned");
          const lifecycle = Object.hasOwn(input, "lifecycle");
          const facts = fields(factsInput, ["continuationId", "oldMain", "helper", ...(withOwned ? ["processes", "knownOwned"] : []), ...(lifecycle ? ["lifecycle"] : [])]);
          if (lifecycle && (facts.lifecycle !== true || !withOwned)) invalid();
          requestId = previous.requestId;
          if (previous.schemaVersion !== 2 || previous.phase !== "preparing" || previous.target === null || previous.network?.status !== "succeeded") invalid();
          expected = previous;
          const owned = withOwned ? readProcessList(facts.knownOwned) : undefined;
          const revision = expected.revision + 1, roots = [readProcess(facts.oldMain), readProcess(facts.helper)];
          const inventory = lifecycle ? createProcessInventory({ owned: owned!, roots, processes: readProcessList(facts.processes, true),
            observer: roots[1]!, revision }) : undefined;
          next = readAttempt({ ...expected, schemaVersion: lifecycle ? 4 : 3, revision, phase: "handoff",
            continuationId: facts.continuationId, oldMain: facts.oldMain, helper: facts.helper, ...(owned ? { owned } : {}),
            ...(inventory ? { owned: inventory.owned, ownedLifecycle: inventory.lifecycle, controlRevision: revision, recoveryHistory: [] } : {}),
            selectedMain: null, admission: null, terminalEvidence: null }) as ShellUpdateHandoffAttempt;
          if (owned) {
            const processes = readProcessList(facts.processes, true), roots = [next.oldMain, next.helper];
            if (!roots.every(root => processes.some(item => sameIdentity(item, root))) || !lifecycle && sampleOwned(owned, roots, processes).length !== owned.length) invalid();
          }
        }
      } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
      return await physical({ kind: "replace", expected, next }) as ShellUpdateHandoffAttempt;
    },
    /** 接收已采样归属历史，不改变准入/网络；有变化才写且原helper必须存活。 */
    async observeHandoffOwned(expected, facts) { return recover("handoff-owned", expected, facts); },
    /** 接管前严格核验单owner事实，不执行OS查询或签名认证。 */
    async beginRecovery(expected, facts) { return recover("claim", expected, facts); },
    /** 已释放controller后绑定当前helper的实际main。 */
    async bindRecoveryMain(expected, facts) { return recover("bind", expected, facts); },
    /** 合并当前owner真实采样历史与存活父链，拒绝历史遗漏及PID复用。 */
    async observeRecoveryOwned(expected, facts) { return recover("observe", expected, facts); },
    /** 不替换历史ready，新的started留在当前恢复快照。 */
    async completeRecovery(expected, evidence) { return recover("complete", expected, evidence); }
  } as ShellUpdateAttemptStore;
}

/** 仅判别已读取的交接版本，不替代严格 reader。 */
export function isShellUpdateHandoffAttempt(value: ShellUpdateAttempt): value is ShellUpdateHandoffAttempt {
  return value.schemaVersion === 3 || value.schemaVersion === 4 || value.schemaVersion === 5 && Object.hasOwn(value, "continuationId");
}

/** 严格reader后的准备5与交接5用整套交接字段区分，failed不另造状态。 */
function isPreparationV5(value: ShellUpdateAttempt): value is ShellUpdatePreparationAttemptV5 {
  return value.schemaVersion === 5 && !isShellUpdateHandoffAttempt(value);
}

/** IPC 精确绑定控制事实版本，普通库存持久化不改变许可版本。 */
export function shellUpdateHandoffRevision(attempt: ShellUpdateHandoffAttempt): number {
  return attempt.schemaVersion !== 3 ? attempt.controlRevision : attempt.revision;
}

/** 当前执行只返回未释放普通实例，停止权不能从历史数组派生。 */
export function shellUpdateOwnedInventory(attempt: InventoryAttempt): ProcessIdentity[] {
  if (attempt.schemaVersion === 3) return [...(attempt.recovery?.knownOwned ?? attempt.owned ?? [])];
  const current = isPreparationV5(attempt) ? undefined : attempt.recovery;
  return activeProcessInventory(current ? { owned: current.knownOwned, lifecycle: current.knownOwnedLifecycle }
    : { owned: attempt.owned, lifecycle: attempt.ownedLifecycle });
}

/** 唯一库存的执行边界保留原角色，历史执行不变成新的 owner。 */
function lifecycleInventories(attempt: LifecycleHandoffAttempt | ShellUpdatePreparationAttemptV5, includeRecovery = true): { roots: ProcessIdentity[]; inventory: ShellProcessInventory }[] {
  const result = [{ roots: lifecycleRoots(attempt),
    inventory: { owned: attempt.owned, lifecycle: attempt.ownedLifecycle } }];
  if (isPreparationV5(attempt)) return result;
  for (const execution of [...attempt.recoveryHistory, ...(includeRecovery && attempt.recovery ? [attempt.recovery] : [])]) {
    result.push({ roots: [execution.controller, execution.helper, ...(execution.main ? [execution.main] : [])],
      inventory: { owned: execution.knownOwned, lifecycle: execution.knownOwnedLifecycle } });
  }
  return result;
}

/** 完整历史供 recovery 下界校验；普通已释放 PID 多代可共存，角色冲突仍失败。 */
export function shellUpdateProcessHistory(attempt: InventoryAttempt, includeRecovery = true): ProcessIdentity[] {
  if (attempt.schemaVersion === 3) return recoveryInventory(includeRecovery ? attempt : { ...attempt, recovery: null });
  const executions = lifecycleInventories(attempt, includeRecovery), roles = [...executions.flatMap(item => item.roots), ...handoffEvidenceMains(attempt)];
  const values = [...roles, ...executions.flatMap(item => item.inventory.owned),
    ...(isShellUpdateHandoffAttempt(attempt) && attempt.admission ? [attempt.admission.main, attempt.admission.client] : []),
    ...(isShellUpdateHandoffAttempt(attempt) && attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main, attempt.terminalEvidence.ready.client] : [])];
  const result: ProcessIdentity[] = [];
  for (const value of values) {
    if (roles.some(role => role.pid === value.pid && !sameIdentity(role, value))) invalid();
    if (!result.some(item => sameIdentity(item, value))) result.push({ ...value });
  }
  return result;
}

/** 原角色与未释放普通库存构成查询上下文，已释放实例不再污染 PID 唯一门禁。 */
export function shellUpdateProcessInventory(attempt: InventoryAttempt, includeRecovery = true): ProcessIdentity[] {
  if (attempt.schemaVersion === 3) return recoveryInventory(includeRecovery ? attempt : { ...attempt, recovery: null });
  const executions = lifecycleInventories(attempt, includeRecovery), values = [...executions.flatMap(item => [...item.roots, ...activeProcessInventory(item.inventory)]), ...handoffEvidenceMains(attempt)];
  const result: ProcessIdentity[] = [];
  for (const value of values) {
    const previous = result.find(item => item.pid === value.pid);
    if (previous && !sameIdentity(previous, value)) invalid();
    if (!previous) result.push({ ...value });
  }
  return result;
}

/** 固定严格副本，所有执行完整历史先预检；额外已核身份只沿原known重查合同。 */
export function shellUpdateProcessSnapshotContext(attempt: InventoryAttempt, extraKnown: readonly ProcessIdentity[] = []): ProcessSnapshotContext {
  const value = readAttempt(attempt);
  if (!isShellUpdateHandoffAttempt(value) && !isPreparationV5(value)) invalid();
  const known = shellUpdateProcessInventory(value);
  for (const identity of readProcessList(extraKnown, false, true)) {
    const previous = known.find(item => item.pid === identity.pid);
    if (previous && !sameIdentity(previous, identity)) invalid();
    if (!previous) known.push(identity);
  }
  if (value.schemaVersion === 3) return { known };
  const executions = lifecycleInventories(value), history = shellUpdateProcessHistory(value);
  return { known, preflight: processes => {
    const pending: ProcessIdentity[] = [];
    for (const execution of executions) {
      for (const identity of preflightProcessInventory({ ...execution, processes, revision: value.revision, known })) {
        if (history.some(item => item.pid === identity.pid)) invalid();
        if (!pending.some(item => sameIdentity(item, identity))) pending.push(identity);
      }
    }
    return pending;
  } };
}

/** 所有执行共用保守释放核验，角色根不受普通库存释放豁免。 */
export function assertShellUpdateInventoryReleased(attempt: InventoryAttempt, processes: ProcessIdentity[], excluded: ProcessIdentity[] = [], includeRecovery = true): void {
  const snapshot = readProcessList(processes, true);
  if (attempt.schemaVersion === 3) { assertReleased(shellUpdateProcessInventory(attempt, includeRecovery), snapshot, excluded); return; }
  for (const item of lifecycleInventories(attempt, includeRecovery)) assertProcessInventoryReleased({ ...item, processes: snapshot, excluded });
  assertReleased(handoffEvidenceMains(attempt).filter(main => !excluded.some(identity => sameIdentity(identity, main))), snapshot, excluded);
}

/** 原始恢复 main 可位于 owned 历史中；取得证据后仍保留既有严格角色门禁。 */
function handoffEvidenceMains(attempt: InventoryAttempt): ProcessIdentity[] {
  if (isPreparationV5(attempt)) return [];
  return [...(attempt.admission ? [attempt.admission.main] : []), ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main] : [])];
}

/** 同控制版本核库存扩展；准备5仅专用交接入口可精确推进一次控制版本。 */
export function assertShellUpdateInventoryExtension(previous: InventoryAttempt, next: InventoryAttempt): void {
  if (previous.schemaVersion === 3 || next.schemaVersion === 3) { if (!equal(previous, next)) invalid(); return; }
  const before = readAttempt(previous), after = readAttempt(next);
  if (!(before.schemaVersion >= 4 && after.schemaVersion === before.schemaVersion) || after.revision < before.revision) invalid();
  if (!("ownedLifecycle" in before) || !("ownedLifecycle" in after)) invalid();
  if (isPreparationV5(before) && isShellUpdateHandoffAttempt(after)) {
    if (before.phase !== "preparing" || after.schemaVersion !== 5 || after.revision !== before.revision + 1 || after.handoffRevision !== after.revision
      || after.controlRevision !== after.revision || !equal(before.preparationMains, after.preparationMains)) invalid();
    const projected = { ...after } as Record<string, unknown>;
    for (const key of ["continuationId", "oldMain", "helper", "selectedMain", "admission", "terminalEvidence", "recoveryHistory", "handoffRevision"]) delete projected[key];
    const expectedProjection = { ...before, revision: after.revision, controlRevision: after.controlRevision, owned: after.owned, ownedLifecycle: after.ownedLifecycle, phase: after.phase };
    if (Object.keys(projected).length !== Object.keys(expectedProjection).length || Object.entries(expectedProjection).some(([key, value]) => !equal(value, projected[key]))
      || after.phase !== "handoff" || after.selectedMain !== null || after.admission !== null || after.terminalEvidence !== null || after.recoveryHistory.length) invalid();
    assertInventoryPrefix(before, after, after.helper);
    return;
  }
  /** 比较执行库存前缀，新增释放只可落在本次物理版本区间。 */
  function extension(left: ShellProcessInventory, right: ShellProcessInventory): void {
    if (right.owned.length < left.owned.length) invalid();
    for (let index = 0; index < right.owned.length; index++) {
      const old = left.lifecycle[index], current = right.lifecycle[index]!;
      if (old && (!sameIdentity(left.owned[index]!, right.owned[index]!) || old.key !== current.key || old.parentKey !== current.parentKey
        || old.release !== null && !equal(old.release, current.release))) invalid();
      if ((!old || old.release === null) && current.release && (current.release.revision <= before.revision || current.release.revision > after.revision)) invalid();
    }
  }
  extension({ owned: before.owned, lifecycle: before.ownedLifecycle }, { owned: after.owned, lifecycle: after.ownedLifecycle });
  const beforeRecovery = isPreparationV5(before) ? undefined : before.recovery, afterRecovery = isPreparationV5(after) ? undefined : after.recovery;
  if (Boolean(beforeRecovery) !== Boolean(afterRecovery)) invalid();
  if (beforeRecovery && afterRecovery) extension({ owned: beforeRecovery.knownOwned, lifecycle: beforeRecovery.knownOwnedLifecycle },
    { owned: afterRecovery.knownOwned, lifecycle: afterRecovery.knownOwnedLifecycle });
  /** 投影仅移除本入口允许变化的库存字段，控制版本仍精确比较。 */
  function control(attempt: LifecycleHandoffAttempt | ShellUpdatePreparationAttemptV5): unknown {
    const { revision: _revision, owned: _owned, ownedLifecycle: _lifecycle, ...rest } = attempt;
    return { ...rest, ...(!isPreparationV5(attempt) && attempt.recovery ? { recovery: { ...attempt.recovery, knownOwned: [], knownOwnedLifecycle: [] } } : {}) };
  }
  if (!equal(control(before), control(after)) || after.revision === before.revision && !equal(before, after)) invalid();
}

/** 新放行证据必须引用当前执行未释放的精确 Client；历史读取不使用此门禁。 */
function assertActiveClient(attempt: ShellUpdateHandoffAttempt, client: ProcessIdentity): void {
  if (attempt.schemaVersion !== 3 && !shellUpdateOwnedInventory(attempt).some(identity => sameIdentity(identity, client))) invalid();
}

/** 只分类完整 INI 事实；阶段、指针匹配均不能证明业务已就绪或已恢复。 */
export function classifyShellUpdateAttemptPosition(input: unknown, actualState: unknown): {
  position: "original" | "candidate"; requiresRuntimeVerification: true;
} {
  const attempt = readAttempt(input), actual = copyState(actualState);
  if (equal(actual, attempt.originalState)) return { position: "original", requiresRuntimeVerification: true };
  if (attempt.candidateState !== null && equal(actual, attempt.candidateState)) return { position: "candidate", requiresRuntimeVerification: true };
  throw Object.assign(new Error("DESKTOP_SHELL_UPDATE_ATTEMPT_POSITION_CONFLICT"), {
    code: "DESKTOP_SHELL_UPDATE_ATTEMPT_POSITION_CONFLICT", requestId: attempt.requestId, phase: "classify"
  });
}

/** 复用严格 reader 快照 held ready；不执行 IO 或改变 attempt、准入及终态。 */
export function snapshotShellUpdateReadyEvidence(attemptInput: unknown, evidence: unknown, role: "original" | "candidate"): ShellUpdateReadyEvidence {
  const attempt = readAttempt(attemptInput);
  if (!isShellUpdateHandoffAttempt(attempt) || !["original", "candidate"].includes(role)) invalid();
  if (attempt.recovery && (attempt.recovery.direction !== role || attempt.recovery.main === null)) invalid();
  const ready = readReadyEvidence(evidence, attempt, role, attempt.recovery ?? undefined);
  assertActiveClient(attempt, ready.client);
  return ready;
}

/** 纯恢复方向判定；不执行 IO/kill/continue，不把未知身份、状态或绑定当作已释放。 */
export function decideShellUpdateRecovery(attemptInput: unknown, factsInput: unknown): ShellUpdateRecoveryDecision {
  const attempt = readAttempt(attemptInput);
  if (!isShellUpdateHandoffAttempt(attempt)) return { action: "stop", reason: "handoff-required" };
  if (attempt.recovery) return { action: "stop", reason: "current-recovery-requires-control" };
  const value = fields(factsInput, ["caller", "owner", "oldMain", "selectedMain", "launchState", "binding", "profile", "ownedReleased"]);
  const caller = readProcess(value.caller), owner = readObservation(value.owner, attempt.helper), oldMain = readObservation(value.oldMain, attempt.oldMain);
  const selected = attempt.selectedMain === null ? readNotStarted(value.selectedMain) : readObservation(value.selectedMain, attempt.selectedMain);
  const launch = fields(value.launchState, undefined), binding = fields(value.binding, undefined), profile = fields(value.profile, undefined);
  if (launch.status === "unknown") fields(value.launchState, ["status"]); else fields(value.launchState, ["status", "value"]);
  if (binding.status === "matched") fields(value.binding, ["status", "value"]); else fields(value.binding, ["status"]);
  if (profile.status === "unknown") fields(value.profile, ["status"]); else fields(value.profile, ["status", "dataDir", "userDataDir", "sessionDataDir"]);
  if (!["verified", "pending", "unknown"].includes(value.ownedReleased as string)) invalid();
  if (owner === "unknown" || oldMain === "unknown" || selected === "unknown") return { action: "stop", reason: "identity-unknown-or-conflict" };
  if (launch.status !== "known" || binding.status !== "matched" || profile.status !== "known") return { action: "stop", reason: "facts-unavailable" };
  const actual = copyState(launch.value), actualBinding = readBinding(binding.value, attempt.originalState.baselineShellId);
  if (!equal(actualBinding, attempt.binding) || profile.dataDir !== attempt.dataDir || profile.userDataDir !== attempt.userDataDir
    || profile.sessionDataDir !== attempt.sessionDataDir) return { action: "stop", reason: "binding-or-profile-conflict" };
  const original = equal(actual, attempt.originalState), candidate = equal(actual, attempt.candidateState);
  if (!original && !candidate) return { action: "stop", reason: "launch-state-conflict" };
  if (attempt.phase === "restored" && !original) return { action: "stop", reason: "restored-requires-original" };
  const writer = sameIdentity(caller, attempt.helper);
  if (writer && owner !== "alive") return { action: "stop", reason: "writer-observation-conflict" };
  if (oldMain === "gone" && sameIdentity(caller, attempt.oldMain)
    || selected === "gone" && attempt.selectedMain !== null && sameIdentity(caller, attempt.selectedMain)) return { action: "stop", reason: "caller-observation-conflict" };
  if (!writer && owner === "alive") return { action: "wait-owner", reason: "owner-alive" };
  if (value.ownedReleased !== "verified") return { action: "stop", reason: "owned-processes-not-released" };
  if (attempt.admission !== null) {
    if (!candidate) return { action: "stop", reason: "admission-requires-candidate" };
    if (selected !== "gone" || oldMain !== "gone") return { action: "stop", reason: "admitted-instance-not-released" };
    return { action: "resume-candidate", reason: "admission-committed" };
  }
  if (selected === "alive") return { action: "stop", reason: "candidate-not-released" };
  return candidate ? { action: "restore-original", reason: "admission-not-committed" } : { action: "resume-original", reason: "original-state-verified" };
}

/** alive/gone 都必须关联被核实的原实例；PID复用或其他实例不能冒充原owner。 */
function readObservation(input: unknown, expected: ProcessIdentity): "alive" | "gone" | "unknown" {
  const value = fields(input, undefined);
  if (value.status === "unknown") { fields(input, ["status"]); return "unknown"; }
  fields(input, ["status", "identity"]);
  if (value.status !== "alive" && value.status !== "gone") invalid();
  return sameIdentity(readProcess(value.identity), expected) ? value.status : "unknown";
}

/** 未绑定候选不能用null或缺字段推断不存在，调用方必须显式陈述尚未启动。 */
function readNotStarted(input: unknown): "not-started" | "unknown" {
  const value = fields(input, ["status"]);
  if (value.status !== "not-started" && value.status !== "unknown") invalid();
  return value.status;
}

/** 映射唯一准备事实；schema3只开放候选启动前的当前切换授权，不升级旧格式或另存预算。 */
export function createShellUpdateAttemptNetworkAdapter(store: ShellUpdateAttemptStore): UpdateNetworkDurableAdapter {
  /** 每次读完整事实；失败槽可读取以明确失败，放行后不再开放网络。 */
  async function current(): Promise<ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt> {
    const observed = await store.read();
    if (observed === null || observed.schemaVersion === 1) throw adapterError("DESKTOP_SHELL_NETWORK_STATE_UNSUPPORTED", observed?.requestId);
    const attempt = readAttempt(observed) as ShellUpdatePreparationAttempt | ShellUpdateHandoffAttempt;
    if (isShellUpdateHandoffAttempt(attempt) && attempt.recovery) throw adapterError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", attempt.requestId);
    if (!(!isShellUpdateHandoffAttempt(attempt) ? attempt.phase === "preparing" : handoffNetworkOpen(attempt))
      && !(attempt.phase === "failed" && attempt.network?.status === "failed")) {
      throw adapterError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", attempt.requestId);
    }
    return attempt;
  }
  return {
    /** 只返回独立的网络投影，完整业务事实留在原 store。 */
    async read() { return networkState(await current()); },
    /** 首 await 前快照 expected/next，再核实际 phase、revision、计数和槽。 */
    async replace(expectedInput, nextInput) {
      const expected = snapshotUpdateNetworkDurableState(expectedInput);
      const value = fields(nextInput, ["retriesUsed", "network"]);
      const next = snapshotUpdateNetworkDurableState({ revision: expected.revision + 1, retriesUsed: value.retriesUsed, network: value.network });
      const attempt = await current();
      if (!(!isShellUpdateHandoffAttempt(attempt) ? attempt.phase === "preparing" : handoffNetworkOpen(attempt))
        || !equal(networkState(attempt), expected)) throw adapterError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", attempt.requestId);
      const result = await store.replace(attempt, { ...attempt, ...next, phase: next.network?.status === "failed" ? "failed" : attempt.phase });
      if (result.schemaVersion !== attempt.schemaVersion) throw adapterError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", attempt.requestId);
      return networkState(result);
    }
  };
}

/** 投影始终经共同严格 reader，返回值与原 attempt 没有可变引用。 */
function networkState(attempt: Pick<ShellUpdateAttemptV2, "revision" | "retriesUsed" | "network">): UpdateNetworkDurableState {
  return snapshotUpdateNetworkDurableState({ revision: attempt.revision, retriesUsed: attempt.retriesUsed, network: attempt.network });
}

/** adapter 自身分类保留 requestId，日志仍归实际处理边界。 */
function adapterError(code: string, requestId?: string): Error { return Object.assign(new Error(code), { code, requestId }); }

/** 临时文件独占写满、同步、核验并关闭后，才重核 expected 和替换唯一事实。 */
async function replaceCurrent(resolveRoot: () => Promise<{ root: string; identity: BigIntStats }>, expected: ShellUpdateAttempt | null, next: ShellUpdateAttempt): Promise<ShellUpdateAttempt> {
  let phase = "read-current", stateReplaced = false;
  let root: string | undefined, identity: BigIntStats | undefined, temporary: Temporary | undefined;
  try {
    ({ root, identity } = await resolveRoot());
    if (next.dataDir !== root || (expected !== null && expected.dataDir !== root)) invalid();
    if (!equal(await readCurrent(root, identity), expected)) invalid();
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
    if (bytes.byteLength > (next.schemaVersion >= 4 ? MAX_LIFECYCLE_BYTES : MAX_BYTES)) invalid();
    phase = "create-temp";
    await assertRoot(root, identity);
    const temporaryPath = path.join(root, `${FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const file = await fs.open(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporary = { path: temporaryPath, closed: false };
    let primary: { cause: unknown; phase: string } | undefined, written: BigIntStats | undefined;
    try {
      temporary.identity = await file.stat({ bigint: true });
      if (!sameOwnedFile(temporary.identity, temporary.identity)) invalid();
      phase = "write-temp";
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, offset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) invalid();
        offset += bytesWritten;
      }
      phase = "sync-temp";
      await file.sync();
      phase = "verify-temp";
      written = await file.stat({ bigint: true });
      if (!sameOwnedFile(temporary.identity, written) || written.size !== BigInt(bytes.byteLength)
        || !(await readBytes(file, next.schemaVersion >= 4 ? MAX_LIFECYCLE_BYTES : MAX_BYTES)).equals(bytes) || !sameMetadata(written, await file.stat({ bigint: true }))) invalid();
    } catch (cause) { primary = { cause, phase }; }
    try { await file.close(); temporary.closed = true; }
    catch (cause) {
      phase = primary?.phase ?? "close-temp";
      throw unreleasedClose(primary ? new AggregateError([primary.cause, cause], "DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED") : cause);
    }
    if (primary) { phase = primary.phase; throw primary.cause; }
    phase = "verify-temp";
    if (!written || !sameMetadata(written, await fs.lstat(temporaryPath, { bigint: true }))) invalid();
    phase = "check-expected";
    await assertRoot(root, identity);
    if (!equal(await readCurrent(root, identity), expected)) invalid();
    phase = "replace";
    await renameCurrent(root, identity, expected, temporaryPath, written, bytes);
    stateReplaced = true; temporary = undefined;
    phase = "verify-replaced";
    await assertRoot(root, identity);
    const observed = await readCurrent(root, identity);
    if (observed === null || !equal(observed, next)) invalid();
    return observed;
  } catch (cause) {
    let failure = cause;
    if (temporary) {
      try {
        if (!temporary.closed || !temporary.identity || !root || !identity) invalid();
        await assertRoot(root, identity);
        if (!sameOwnedFile(temporary.identity, await fs.lstat(temporary.path, { bigint: true }))) invalid();
        await fs.unlink(temporary.path);
      } catch (cleanup) { failure = new AggregateError([cause, cleanup], "DESKTOP_SHELL_UPDATE_ATTEMPT_CLEANUP_FAILED"); }
    }
    throw operationError("REPLACE", phase, stateReplaced, failure, next.requestId);
  }
}

/** 仅 Windows 原生 rename EPERM 有限重试；原 expected、临时实体和内容每轮重核。 */
async function renameCurrent(root: string, identity: BigIntStats, expected: ShellUpdateAttempt | null,
  temporary: string, written: BigIntStats, bytes: Buffer): Promise<void> {
  const target = path.join(root, FILENAME), started = performance.now(), budget = 1000;
  let first: Error | undefined, last: unknown, attempts = 0;
  /** 调度预算耗尽保留首因、末因及尝试数，不遗留未完成的 rename。 */
  function exhausted(): Error {
    return Object.assign(new Error("DESKTOP_SHELL_UPDATE_ATTEMPT_RENAME_RETRY_EXHAUSTED", { cause: first }),
      { attempts, elapsedMs: performance.now() - started, lastCause: last });
  }
  while (true) {
    if (first && performance.now() - started >= budget) throw exhausted();
    try {
      await assertRoot(root, identity);
      if (first) {
        if (!equal(await readCurrent(root, identity), expected)) invalid();
        await verifyRetryTemporary(temporary, written, bytes);
      }
      await assertRoot(root, identity);
      if (!sameMetadata(written, await fs.lstat(temporary, { bigint: true }))) invalid();
    } catch (cause) {
      throw first ? new AggregateError([first, cause], "DESKTOP_SHELL_UPDATE_ATTEMPT_RENAME_RECHECK_FAILED") : cause;
    }
    if (performance.now() - started >= budget) throw exhausted();
    attempts++;
    try { await fs.rename(temporary, target); return; }
    catch (cause) {
      if (!(process.platform === "win32" && cause instanceof Error && "code" in cause && cause.code === "EPERM"
        && "syscall" in cause && cause.syscall === "rename" && "path" in cause && cause.path === temporary
        && "dest" in cause && cause.dest === target)) {
        throw first ? new AggregateError([first, cause], "DESKTOP_SHELL_UPDATE_ATTEMPT_RENAME_RETRY_FAILED") : cause;
      }
      first ??= cause; last = cause;
    }
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0) throw exhausted();
    await delay(Math.min(10, remaining));
  }
}

/** 重试仅复用已写实体；内容、句柄及路径全部严格匹配，关闭成功后才允许替换。 */
async function verifyRetryTemporary(temporary: string, written: BigIntStats, bytes: Buffer): Promise<void> {
  const file = await fs.open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined;
  try {
    if (!sameMetadata(written, await file.stat({ bigint: true }))
      || !(await readBytes(file, bytes.byteLength)).equals(bytes)
      || !sameMetadata(written, await file.stat({ bigint: true }))
      || !sameMetadata(written, await fs.lstat(temporary, { bigint: true }))) invalid();
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); }
    catch (cause) { throw unreleasedClose(failure ? new AggregateError([failure.cause, cause], "DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED") : cause); }
  }
}

/** 以打开句柄核验有界快照；句柄内最终路径匹配为读取时点，close 后仍核根。 */
async function readCurrent(root: string, identity: BigIntStats): Promise<ShellUpdateAttempt | null> {
  await assertRoot(root, identity);
  const target = path.join(root, FILENAME);
  let before: BigIntStats;
  try { before = await fs.lstat(target, { bigint: true }); }
  catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    await assertRoot(root, identity); return null;
  }
  if (!sameOwnedFile(before, before) || before.size > BigInt(MAX_LIFECYCLE_BYTES)) invalid();
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failure: { cause: unknown } | undefined, result: ShellUpdateAttempt;
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameOwnedFile(opened, opened) || opened.size > BigInt(MAX_LIFECYCLE_BYTES)) invalid();
    const bytes = await readBytes(file, MAX_LIFECYCLE_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    result = readAttempt(JSON.parse(text));
    if (bytes.byteLength > (result.schemaVersion >= 4 ? MAX_LIFECYCLE_BYTES : MAX_BYTES)) invalid();
    if (result.dataDir !== root || !sameMetadata(opened, await file.stat({ bigint: true }))
      || !sameMetadata(opened, await fs.lstat(target, { bigint: true }))) invalid();
    await assertRoot(root, identity);
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); }
    catch (cause) { throw unreleasedClose(failure === undefined ? cause : new AggregateError([failure.cause, cause], "DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED")); }
  }
  await assertRoot(root, identity);
  return result;
}

/** 固定容量短读循环多取一字节识别超长，不按文件宣称大小放大分配。 */
async function readBytes(file: FileHandle, maximum = MAX_BYTES): Promise<Buffer> {
  const bytes = Buffer.alloc(maximum + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.byteLength - offset) invalid();
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximum) invalid();
  return bytes.subarray(0, offset);
}

/** 严格复制有限数据字段；不执行访问器，不采纳未知、继承或自定义原型值。 */
function readAttempt(input: unknown): ShellUpdateAttempt {
  const schemaVersion = fields(input, undefined).schemaVersion;
  if (schemaVersion === 5) return readPreparationLifecycleAttempt(input);
  if (schemaVersion === 3 || schemaVersion === 4) return readHandoffAttempt(input);
  const value = fields(input, schemaVersion === 2 ? [...FIELDS, "network"] : FIELDS);
  const originalState = copyState(value.originalState);
  const phase = value.phase;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || !(schemaVersion === 2 ? ["preparing", "handoff", "failed", "no-update"] : ["preparing", "handoff", "failed"]).includes(phase as string)) invalid();
  const revision = integer(value.revision, 0), retriesUsed = integer(value.retriesUsed, 0);
  if (retriesUsed > 3 || revision < retriesUsed || (revision === 0 && phase !== "preparing")) invalid();
  let selection: SelectedTarget | { target: null; candidateState: null };
  if (schemaVersion === 2 && value.target === null && value.candidateState === null) selection = { target: null, candidateState: null };
  else {
    const target = fields(value.target, ["shellId", "manifestSha256", "installerSha256", "installerSize"]), candidateState = copyState(value.candidateState);
    const shellId = readId(target.shellId);
    if (shellId === originalState.activeShellId || candidateState.activeShellId !== shellId
      || candidateState.previousShellId !== originalState.activeShellId || candidateState.baselineShellId !== originalState.baselineShellId) invalid();
    selection = { target: { shellId, manifestSha256: hash(target.manifestSha256), installerSha256: hash(target.installerSha256), installerSize: integer(target.installerSize, 1) }, candidateState };
  }
  const base = { requestId: readRequestId(value.requestId), revision,
    installationDir: readPath(value.installationDir), dataDir: readPath(value.dataDir),
    userDataDir: readPath(value.userDataDir), sessionDataDir: readPath(value.sessionDataDir),
    originalState, binding: readBinding(value.binding, originalState.baselineShellId), retriesUsed,
    phase: phase as ShellUpdateAttemptV2["phase"] };
  if (schemaVersion === 1) return { ...base, schemaVersion, ...selection } as ShellUpdateAttemptV1;
  const { network } = snapshotUpdateNetworkDurableState({ revision, retriesUsed, network: value.network });
  if (phase === "handoff" && (selection.target === null || network?.status === "dispatching" || network?.status === "waiting" || network?.status === "failed")) invalid();
  if (phase === "no-update" && (selection.target !== null || network?.status !== "succeeded" || network.evidence.kind !== "shell-manifest")) invalid();
  if (network?.status === "failed" && phase !== "failed") invalid();
  return { ...base, schemaVersion, ...selection, network };
}

/** 所有历史准备主进程始终为角色根，不从普通库存取得停止豁免。 */
function lifecycleRoots(attempt: LifecycleHandoffAttempt | ShellUpdatePreparationAttemptV5): ProcessIdentity[] {
  const mains = attempt.schemaVersion === 5 ? attempt.preparationMains.map(item => item.identity) : [attempt.oldMain];
  return isPreparationV5(attempt) ? mains : [...mains, attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : [])];
}

/** schema5保留准备根绑定版本，严格区分准备/整套交接字段，不自动升级旧格式。 */
function readPreparationLifecycleAttempt(input: unknown): ShellUpdatePreparationAttemptV5 | ShellUpdateHandoffAttemptV5 {
  const initial = fields(input, undefined), handoff = Object.hasOwn(initial, "continuationId");
  const extra = ["controlRevision", "preparationMains", "owned", "ownedLifecycle"];
  const handoffKeys = ["handoffRevision", "continuationId", "oldMain", "helper", "selectedMain", "admission", "terminalEvidence", "recoveryHistory",
    ...(Object.hasOwn(initial, "recovery") ? ["recovery"] : [])];
  const value = fields(input, [...FIELDS, "network", ...extra, ...(handoff ? handoffKeys : [])]);
  const baseInput = Object.fromEntries([...FIELDS, "network"].map(key => [key, value[key]]));
  const base = readAttempt({ ...baseInput, schemaVersion: 2, ...(handoff ? { phase: fields(value.network, undefined).status === "failed" ? "failed" : "preparing" } : {}) });
  if (base.schemaVersion !== 2 || !handoff && !["preparing", "no-update", "failed"].includes(base.phase)) invalid();
  const controlRevision = integer(value.controlRevision, 1);
  if (controlRevision > base.revision) invalid();
  if (!Array.isArray(value.preparationMains) || Object.getPrototypeOf(value.preparationMains) !== Array.prototype
    || !value.preparationMains.length || value.preparationMains.length > 1024
    || Reflect.ownKeys(value.preparationMains).length !== value.preparationMains.length + 1) invalid();
  const preparationMains: ShellPreparationMain[] = [];
  for (let index = 0; index < value.preparationMains.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.preparationMains, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    const item = fields(descriptor.value, ["identity", "boundAtRevision"]), identity = readProcess(item.identity), boundAtRevision = integer(item.boundAtRevision, 1);
    if (identity.executable !== shellExecutable(base, base.originalState.activeShellId) || boundAtRevision > controlRevision
      || (index === 0 ? boundAtRevision !== 1 : boundAtRevision <= preparationMains[index - 1]!.boundAtRevision)
      || preparationMains.some(previous => previous.identity.pid === identity.pid)) invalid();
    preparationMains.push({ identity, boundAtRevision });
  }
  const handoffRevision = handoff ? integer(value.handoffRevision, 2) : undefined;
  if (handoffRevision !== undefined && (handoffRevision > controlRevision || handoffRevision <= preparationMains.at(-1)!.boundAtRevision)) invalid();
  const roots = preparationMains.map(item => item.identity);
  const oldMain = handoff ? readProcess(value.oldMain) : undefined, helper = handoff ? readProcess(value.helper) : undefined;
  const selectedMain = handoff && value.selectedMain !== null ? readProcess(value.selectedMain) : null;
  if (handoff) {
    if (!sameIdentity(oldMain!, roots.at(-1)!) || roots.some(root => root.pid === helper!.pid)
      || selectedMain && [...roots, helper!].some(root => root.pid === selectedMain.pid)) invalid();
    roots.push(helper!, ...(selectedMain ? [selectedMain] : []));
  }
  const inventory = readProcessInventory(value.owned, value.ownedLifecycle, roots, base.revision);
  for (const item of inventory.lifecycle) if (item.release) {
    const release = item.release, index = preparationMains.findIndex(main => processInstanceKey(main.identity) === release.observerKey);
    if (index >= 0) {
      const lower = preparationMains[index]!.boundAtRevision, upper = preparationMains[index + 1]?.boundAtRevision ?? handoffRevision;
      if (release.revision < lower || upper !== undefined && release.revision >= upper) invalid();
    } else if (!helper || release.observerKey !== processInstanceKey(helper) || release.revision < handoffRevision!) invalid();
  }
  if (!handoff) return { ...base, schemaVersion: 5, controlRevision, preparationMains, owned: inventory.owned,
    ownedLifecycle: inventory.lifecycle } as ShellUpdatePreparationAttemptV5;
  const attempt = readHandoffAttempt(input) as ShellUpdateHandoffAttemptV5;
  return attempt;
}

/** 共用原startNext充分终态约束，活动请求不能借初始化重置网络预算。 */
function assertNextCycle(expected: ShellUpdateAttempt | null, fresh: ShellUpdateAttemptV2): void {
  if (expected === null) return;
  if (fresh.requestId === expected.requestId) invalid();
  if (isShellUpdateHandoffAttempt(expected)) {
    const complete = expected.recovery ? expected.recovery.terminalEvidence !== null : ["completed", "restored"].includes(expected.phase);
    if (!complete || ["installationDir", "dataDir", "userDataDir", "sessionDataDir"].some(key => expected[key as keyof AttemptBase] !== fresh[key as keyof AttemptBase])
      || !equal(fresh.originalState, expected.admission === null ? expected.originalState : expected.candidateState)) invalid();
  } else if (!(expected.schemaVersion === 2 || isPreparationV5(expected)) || expected.phase !== "no-update") invalid();
}

/** 失败重试保旧证据，限制在未交接的schema5终结网络失败且运行事实完全未变。 */
function assertManualFailureCycle(expected: ShellUpdateAttempt | null, fresh: ShellUpdateAttemptV2, evidence: unknown): void {
  assertDesktopUpdateFailureRecord(evidence);
  if (!expected || !isPreparationV5(expected) || expected.phase !== "failed" || expected.network?.status !== "failed"
    || fresh.requestId === expected.requestId || evidence.errorCode !== "DESKTOP_SHELL_UPDATE_FAILED"
    || evidence.requestId !== expected.requestId || evidence.shellId !== (expected.target?.shellId ?? null)
    || evidence.phase !== (expected.target ? "download" : "prepare") || evidence.recovery !== "not_needed"
    || ["installationDir", "dataDir", "userDataDir", "sessionDataDir", "originalState", "binding"]
      .some(key => !equal(expected[key as keyof ShellUpdatePreparationAttemptV5], fresh[key as keyof ShellUpdateAttemptV2]))) invalid();
}

/** 追加普通库存只保留完整前缀；新proof限当前合法观察者和本次物理版本。 */
function assertInventoryPrefix(before: ShellUpdatePreparationAttemptV5, after: ShellUpdateHandoffAttemptV5, observer: ProcessIdentity): void {
  if (after.owned.length < before.owned.length) invalid();
  for (let index = 0; index < after.owned.length; index++) {
    const prior = before.ownedLifecycle[index], item = after.ownedLifecycle[index]!;
    if (prior && (!sameIdentity(before.owned[index]!, after.owned[index]!) || prior.key !== item.key || prior.parentKey !== item.parentKey
      || prior.release !== null && !equal(prior.release, item.release))) invalid();
    if ((!prior || prior.release === null) && item.release && (item.release.revision !== after.revision || item.release.observerKey !== processInstanceKey(observer))) invalid();
  }
}

/** 准备期换根/观察首await前严格复制，所有失败保留原请求上下文。 */
function preparationNext(kind: "bind" | "observe", expectedInput: unknown, factsInput: unknown): { expected: ShellUpdatePreparationAttemptV5; next: ShellUpdatePreparationAttemptV5 } {
  let requestId: string | undefined;
  try {
    const expected = readAttempt(expectedInput); requestId = expected.requestId;
    if (!isPreparationV5(expected) || expected.phase === "failed" && expected.network?.status !== "failed") invalid();
    const input = fields(factsInput, kind === "bind" ? ["caller", "processes", "launchState", "binding", "profile"] : ["caller", "processes"]);
    const caller = readProcess(input.caller), processes = readProcessList(input.processes, true);
    const roots = expected.preparationMains.map(item => item.identity), current = roots.at(-1)!;
    if (caller.executable !== shellExecutable(expected, expected.originalState.activeShellId) || !processes.some(item => sameIdentity(item, caller))) invalid();
    if (kind === "bind") {
      const launch = fields(input.launchState, ["status", "value"]), binding = fields(input.binding, ["status", "value"]);
      const profile = fields(input.profile, ["status", "dataDir", "userDataDir", "sessionDataDir"]);
      if (launch.status !== "known" || !equal(copyState(launch.value), expected.originalState) || binding.status !== "matched"
        || !equal(readBinding(binding.value, expected.originalState.baselineShellId), expected.binding) || profile.status !== "known"
        || ["dataDir", "userDataDir", "sessionDataDir"].some(key => profile[key] !== expected[key as "dataDir"])) invalid();
    }
    const changingRoot = !sameIdentity(caller, current);
    if (kind === "observe" && changingRoot) invalid();
    if (changingRoot && (expected.preparationMains.length >= 1024 || roots.some(root => processes.some(item => item.pid === root.pid))
      || [...roots, ...expected.owned].some(item => item.pid === caller.pid))) invalid();
    const revision = expected.revision + 1;
    const mains = changingRoot ? [...expected.preparationMains, { identity: caller, boundAtRevision: revision }] : expected.preparationMains;
    const inventory = observeProcessInventory({ inventory: { owned: expected.owned, lifecycle: expected.ownedLifecycle },
      roots: mains.map(item => item.identity), processes, observer: caller, revision });
    if (kind === "bind" && !changingRoot) return { expected, next: expected };
    if (changingRoot && inventory.lifecycle.slice(0, expected.owned.length).some(item => item.release === null)) invalid();
    if (!changingRoot && equal(inventory, { owned: expected.owned, lifecycle: expected.ownedLifecycle })) return { expected, next: expected };
    const next = readAttempt({ ...expected, revision, ...(changingRoot ? { preparationMains: mains, controlRevision: revision } : {}),
      owned: inventory.owned, ownedLifecycle: inventory.lifecycle }) as ShellUpdatePreparationAttemptV5;
    return { expected, next };
  } catch (cause) { throw operationError("REPLACE", "input", false, cause, requestId); }
}

/** 原图原proof迁入5交接，只由新helper在该次快照观察，不回填内存历史。 */
function preparationHandoff(expected: ShellUpdatePreparationAttemptV5, factsInput: unknown): ShellUpdateHandoffAttemptV5 {
  const value = fields(factsInput, ["lifecycle", "continuationId", "oldMain", "helper", "processes"]);
  if (value.lifecycle !== true || expected.phase !== "preparing" || expected.target === null || expected.network?.status !== "succeeded") invalid();
  const oldMain = readProcess(value.oldMain), helper = readProcess(value.helper), processes = readProcessList(value.processes, true);
  const roots = lifecycleRoots(expected);
  if (!sameIdentity(oldMain, roots.at(-1)!) || [...roots, ...expected.owned].some(item => item.pid === helper.pid)
    || !processes.some(item => sameIdentity(item, oldMain)) || !processes.some(item => sameIdentity(item, helper))) invalid();
  const revision = expected.revision + 1, inventory = observeProcessInventory({ inventory: { owned: expected.owned, lifecycle: expected.ownedLifecycle },
    roots: [...roots, helper], processes, observer: helper, revision });
  const next = readAttempt({ ...expected, revision, controlRevision: revision, handoffRevision: revision, phase: "handoff", continuationId: value.continuationId,
    oldMain, helper, owned: inventory.owned, ownedLifecycle: inventory.lifecycle, selectedMain: null, admission: null, terminalEvidence: null, recoveryHistory: [] }) as ShellUpdateHandoffAttemptV5;
  assertShellUpdateInventoryExtension(expected, next);
  return next;
}

/** 原 binding 必须明确来自 active 或固定安装 baseline，并保存实际 Client 健康。 */
function readBinding(input: unknown, baseline: string): ShellUpdateAttemptBinding {
  const kind = fields(input, undefined).kind;
  const value = fields(input, kind === "active" ? ["kind", "releaseId", "packageSha256", "health"] : ["kind", "baselineShellId", "health"]);
  const health = readHealth(value.health);
  if (kind === "active") return { kind, releaseId: readId(value.releaseId), packageSha256: hash(value.packageSha256), health };
  if (kind !== "installation" || readId(value.baselineShellId) !== baseline) invalid();
  return { kind, baselineShellId: baseline, health };
}

/** 同一业务 binding 和 ready 复用既有实际 Client 健康校验。 */
function readHealth(input: unknown): DesktopClientHealth {
  const healthValue = fields(input, ["protocolVersion", "clientVersion", "dbSchemaVersion", "database"]);
  if (healthValue.protocolVersion !== 1 || healthValue.database !== "ready" || typeof healthValue.clientVersion !== "string"
    || !healthValue.clientVersion.trim() || healthValue.clientVersion.length > 128 || /[\x00-\x1f\x7f]/.test(healthValue.clientVersion)) invalid();
  return { protocolVersion: 1, clientVersion: healthValue.clientVersion,
    dbSchemaVersion: integer(healthValue.dbSchemaVersion, 1), database: "ready" };
}

/** 仅推进同一周期；无更新仅从准备期终结，普通替换不复活或重置预算。 */
function assertTransition(expected: ShellUpdateAttempt | null, next: ShellUpdateAttempt): void {
  if (expected === null) {
    if (isShellUpdateHandoffAttempt(next)) invalid();
    if (next.revision !== 0 || next.retriesUsed !== 0 || next.phase !== "preparing") invalid();
    if (next.schemaVersion === 2 && next.network !== null) invalid();
    return;
  }
  if (expected.phase === "no-update" || (next.phase === "no-update" && expected.phase !== "preparing")) invalid();
  if (next.revision !== expected.revision + 1 || !Number.isSafeInteger(next.revision)) invalid();
  if (next.schemaVersion !== expected.schemaVersion) invalid();
  if (expected.schemaVersion === 5 && (isShellUpdateHandoffAttempt(expected) !== isShellUpdateHandoffAttempt(next))) invalid();
  if (isShellUpdateHandoffAttempt(expected) && isShellUpdateHandoffAttempt(next)) { assertHandoffTransition(expected, next); return; }
  if (isPreparationV5(expected) && isPreparationV5(next)) {
    if (!equal(expected.preparationMains, next.preparationMains) || !equal(expected.owned, next.owned) || !equal(expected.ownedLifecycle, next.ownedLifecycle)) invalid();
    const before = readAttempt(Object.fromEntries([...FIELDS, "network" as const].map(key => [key, key === "schemaVersion" ? 2 : expected[key]])));
    const after = readAttempt(Object.fromEntries([...FIELDS, "network" as const].map(key => [key, key === "schemaVersion" ? 2 : next[key]])));
    assertTransition(before, after); return;
  }
  const mutable = new Set(["revision", "phase", "retriesUsed", ...(next.schemaVersion === 2 ? ["target", "candidateState"] : [])]);
  if (FIELDS.some(field => !mutable.has(field) && !equal(expected[field], next[field]))) invalid();
  if ((expected.phase === "handoff" && next.phase === "preparing") || (expected.phase === "failed" && next.phase !== "failed")) invalid();
  if (expected.schemaVersion === 2 && next.schemaVersion === 2) {
    if ((!equal(expected.target, next.target) || !equal(expected.candidateState, next.candidateState))
      && !(expected.phase === "preparing" && next.phase === "preparing" && expected.target === null && next.target !== null)) invalid();
    assertNetworkTransition(expected, next);
    return;
  }
  const increment = next.retriesUsed - expected.retriesUsed;
  if (increment !== 0 && !(increment === 1 && expected.phase === "preparing" && next.phase === "preparing")) invalid();
}

/** 唯一槽仅预约时扣次；未知发送不重放，成功后才允许下一动作。 */
function assertNetworkTransition(expected: Pick<ShellUpdateAttemptV2, "phase" | "network" | "retriesUsed">, next: Pick<ShellUpdateAttemptV2, "phase" | "network" | "retriesUsed">): void {
  const before = expected.network, after = next.network, increment = next.retriesUsed - expected.retriesUsed;
  if (equal(before, after)) { if (increment !== 0) invalid(); return; }
  if (expected.phase !== "preparing" || (next.phase !== "preparing" && !(next.phase === "failed" && after?.status === "failed")) || after === null) invalid();
  if (before === null) { if (after.status !== "dispatching" || increment !== 0) invalid(); return; }
  if (before.actionKey !== after.actionKey) { if (before.status !== "succeeded" || after.status !== "dispatching" || increment !== 0) invalid(); return; }
  if (before.requestSha256 !== after.requestSha256) invalid();
  if (before.status === "dispatching") {
    if (after.status === "waiting" && increment === 1) return;
    if ((after.status === "succeeded" || after.status === "failed") && increment === 0) return;
  }
  if (before.status === "waiting" && after.status === "dispatching" && increment === 0) return;
  invalid();
}

/** schema3 复用完整 schema2 准备事实；只严格读取交接证据，不迁移旧 reader。 */
function readHandoffAttempt(input: unknown): ShellUpdateHandoffAttempt {
  const inputFields = fields(input, undefined), hasRecovery = Object.hasOwn(inputFields, "recovery"), hasOwned = Object.hasOwn(inputFields, "owned");
  const lifecycle = inputFields.schemaVersion === 4 || inputFields.schemaVersion === 5, preparation = inputFields.schemaVersion === 5;
  const value = fields(input, [...FIELDS, "network", "continuationId", "oldMain", "helper", "selectedMain", "admission", "terminalEvidence",
    ...(hasRecovery ? ["recovery"] : []), ...(hasOwned ? ["owned"] : []), ...(lifecycle ? ["controlRevision", "ownedLifecycle", "recoveryHistory"] : []),
    ...(preparation ? ["preparationMains", "handoffRevision"] : [])]);
  const phase = value.phase;
  if (!["handoff", "admission-intent", "completed", "restored", "failed"].includes(phase as string)) invalid();
  const baseInput = Object.fromEntries([...FIELDS, "network"].map(key => [key, value[key]]));
  const base = readAttempt({ ...baseInput, schemaVersion: 2, phase: fields(value.network, undefined).status === "failed" ? "failed" : "preparing" });
  if (base.schemaVersion !== 2 || base.target === null || base.network === null || base.revision === 0) invalid();
  const continuationId = readContinuationId(value.continuationId), oldMain = readProcess(value.oldMain), helper = readProcess(value.helper);
  if (oldMain.executable !== shellExecutable(base, base.originalState.activeShellId) || helper.executable !== oldMain.executable
    || helper.parentPid !== oldMain.pid || helper.pid === oldMain.pid || helper.created < oldMain.created) invalid();
  const selectedMain = value.selectedMain === null ? null : readProcess(value.selectedMain);
  if (selectedMain && (selectedMain.executable !== shellExecutable(base, base.target.shellId) || selectedMain.parentPid !== helper.pid
    || selectedMain.created < helper.created || selectedMain.pid === helper.pid || selectedMain.pid === oldMain.pid)) invalid();
  const preparationMains = preparation ? (value.preparationMains as ShellPreparationMain[]).map(item => ({ identity: readProcess(item.identity), boundAtRevision: integer(item.boundAtRevision, 1) })) : undefined;
  const roots = [...(preparationMains ? preparationMains.map(item => item.identity) : [oldMain]), helper, ...(selectedMain ? [selectedMain] : [])];
  const inventory = lifecycle ? readProcessInventory(value.owned, value.ownedLifecycle, roots, base.revision) : undefined;
  if (inventory && !preparation) assertReleaseObserver(inventory.lifecycle, helper);
  const owned = inventory?.owned ?? (hasOwned ? readProcessList(value.owned) : undefined);
  if (owned && !lifecycle) {
    if (owned.some(identity => roots.some(root => root.pid === identity.pid))) invalid();
    assertOwnedGraph(owned, roots);
  }
  const controlRevision = lifecycle ? integer(value.controlRevision, 1) : undefined;
  if (controlRevision !== undefined && controlRevision > base.revision) invalid();
  const context = { ...base, schemaVersion: preparation ? 5 : lifecycle ? 4 : 3, phase: phase as ShellUpdateAttemptV3["phase"],
    continuationId, oldMain, helper, selectedMain, ...(owned ? { owned } : {}),
    ...(inventory ? { ownedLifecycle: inventory.lifecycle, controlRevision, recoveryHistory: [] } : {}),
    ...(preparationMains ? { preparationMains, handoffRevision: integer(value.handoffRevision, 2) } : {}) } as Omit<ShellUpdateHandoffAttempt, "admission" | "terminalEvidence">;
  const admission = value.admission === null ? null : readReadyEvidence(value.admission, context, "candidate");
  const terminalEvidence = value.terminalEvidence === null ? null : readTerminalEvidence(value.terminalEvidence, context, phase === "restored" ? "original" : "candidate");
  if (phase === "handoff" && admission !== null || ["admission-intent", "completed"].includes(phase as string) && admission === null
    || phase === "restored" && admission !== null) invalid();
  if (["completed", "restored"].includes(phase as string) ? terminalEvidence === null : terminalEvidence !== null) invalid();
  if (phase === "completed" && !equal(admission, terminalEvidence!.ready)) invalid();
  const authorizationRevision = switchActionRevision(base.network.actionKey);
  if (base.network.status !== "succeeded") {
    if (authorizationRevision === null || authorizationRevision >= base.revision || selectedMain !== null || admission !== null
      || (base.network.status === "failed" ? !["failed", "restored"].includes(phase as string) : phase !== "handoff" || terminalEvidence !== null)) invalid();
  }
  if (authorizationRevision !== null && (authorizationRevision >= base.revision
    || base.network.status === "succeeded" && base.network.evidence.kind !== "shell-switch-authorization")) invalid();
  const attempt = { ...context, admission, terminalEvidence } as ShellUpdateHandoffAttempt;
  if (attempt.schemaVersion !== 3) {
    if (!Array.isArray(value.recoveryHistory) || Object.getPrototypeOf(value.recoveryHistory) !== Array.prototype
      || Reflect.ownKeys(value.recoveryHistory).length !== value.recoveryHistory.length + 1 || value.recoveryHistory.length > 1024) invalid();
    for (let index = 0; index < value.recoveryHistory.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.recoveryHistory, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      attempt.recoveryHistory.push(readRecoveryExecution(descriptor.value, attempt) as ShellUpdateRecoveryExecutionV4);
    }
  }
  const result = hasRecovery ? { ...attempt, recovery: value.recovery === null ? null : readRecoveryExecution(value.recovery, attempt) } as ShellUpdateHandoffAttempt : attempt;
  if (result.schemaVersion !== 3) { shellUpdateProcessHistory(result); shellUpdateProcessInventory(result); }
  return result;
}

/** 放行前只接受同实例 held ready、实际完整状态/绑定/profile 和主 frame 证据。 */
function readReadyEvidence(input: unknown, attempt: Omit<ShellUpdateHandoffAttempt, "admission" | "terminalEvidence">, role: "original" | "candidate", recovery?: ShellUpdateRecoveryExecution): ShellUpdateReadyEvidence {
  const value = fields(input, ["role", "continuationId", "main", "client", "readyRequestId", "health", "binding", "launchState", "profile", "mainFrame", "startup"]);
  const main = readProcess(value.main), client = readProcess(value.client), state = copyState(value.launchState);
  const binding = readBinding(value.binding, attempt.originalState.baselineShellId), health = readHealth(value.health);
  const profile = fields(value.profile, ["dataDir", "userDataDir", "sessionDataDir"]), startup = fields(value.startup, ["continuationId", "admission"]);
  const helper = recovery?.helper ?? attempt.helper;
  if (value.role !== role || value.continuationId !== attempt.continuationId || startup.continuationId !== attempt.continuationId
    || startup.admission !== "paused" || value.mainFrame !== "loaded" || !equal(binding, attempt.binding) || !equal(health, attempt.binding.health)
    || !equal(state, role === "candidate" ? attempt.candidateState : attempt.originalState) || client.parentPid !== main.pid
    || client.pid === main.pid || client.pid === helper.pid || client.pid === attempt.helper.pid || client.pid === attempt.oldMain.pid
    || client.created < main.created || profile.dataDir !== attempt.dataDir
    || profile.userDataDir !== attempt.userDataDir || profile.sessionDataDir !== attempt.sessionDataDir) invalid();
  if (recovery) {
    if (role !== recovery.direction || recovery.main === null || !sameIdentity(main, recovery.main)
      || client.pid === recovery.controller.pid || !recovery.knownOwned.some(identity => sameIdentity(identity, client))) invalid();
  } else if (role === "candidate") { if (attempt.selectedMain === null || !sameIdentity(main, attempt.selectedMain)) invalid(); }
  else if (main.executable !== shellExecutable(attempt, attempt.originalState.activeShellId)
    || !sameIdentity(main, attempt.oldMain) && (main.parentPid !== attempt.helper.pid || main.created < attempt.helper.created)) invalid();
  if (!recovery && attempt.owned && !attempt.owned.some(identity => sameIdentity(identity, client))) invalid();
  return { role, continuationId: attempt.continuationId, main, client, readyRequestId: readRequestId(value.readyRequestId), health, binding, launchState: state,
    profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: attempt.continuationId, admission: "paused" } };
}

/** started 必须确认该 ready 的 continue、首次恢复和 application.start 全部完成。 */
function readTerminalEvidence(input: unknown, attempt: Omit<ShellUpdateHandoffAttempt, "admission" | "terminalEvidence">, role: "original" | "candidate", recovery?: ShellUpdateRecoveryExecution): ShellUpdateTerminalEvidence {
  const value = fields(input, ["ready", "startedRequestId", "continueRequestId", "startup", "application"]);
  if (value.startup !== "completed" || value.application !== "started") invalid();
  return { ready: readReadyEvidence(value.ready, attempt, role, recovery), startedRequestId: readRequestId(value.startedRequestId),
    continueRequestId: readRequestId(value.continueRequestId), startup: "completed", application: "started" };
}

/** admission 不可撤回；selectedMain 仅准备交接时单向绑定一次，终态需充分证据。 */
function assertHandoffTransition(expected: ShellUpdateHandoffAttempt, next: ShellUpdateHandoffAttempt): void {
  if (!equal(expected.owned, next.owned)) invalid();
  if (expected.schemaVersion !== 3 && next.schemaVersion !== 3
    && (!equal(expected.ownedLifecycle, next.ownedLifecycle) || !equal(expected.recoveryHistory, next.recoveryHistory))) invalid();
  if (expected.schemaVersion === 5 && next.schemaVersion === 5
    && (!equal(expected.preparationMains, next.preparationMains) || expected.handoffRevision !== next.handoffRevision)) invalid();
  if (!equal(expected.recovery, next.recovery) || expected.recovery && !equal({ ...expected, revision: next.revision }, next)) invalid();
  if (FIELDS.some(key => !["revision", "phase", "retriesUsed"].includes(key) && !equal(expected[key], next[key]))
    || expected.continuationId !== next.continuationId || !sameIdentity(expected.oldMain, next.oldMain) || !sameIdentity(expected.helper, next.helper)) invalid();
  if (!equal(expected.network, next.network) || expected.retriesUsed !== next.retriesUsed) {
    if (!handoffNetworkOpen(expected) || (!handoffNetworkOpen(next) && !(next.phase === "failed" && next.network.status === "failed"
      && next.selectedMain === null && next.admission === null && next.terminalEvidence === null))) invalid();
    const revision = switchActionRevision(next.network.actionKey);
    if (revision === null || next.network.actionKey !== expected.network.actionKey && revision !== expected.revision) invalid();
    assertNetworkTransition({ ...expected, phase: "preparing" }, { ...next, phase: next.phase === "failed" ? "failed" : "preparing" });
  }
  if (["completed", "restored"].includes(expected.phase)) invalid();
  if (!equal(expected.selectedMain, next.selectedMain) && !(expected.phase === "handoff" && next.phase === "handoff" && expected.selectedMain === null && next.selectedMain !== null)) invalid();
  if (expected.admission !== null && !equal(expected.admission, next.admission)) invalid();
  if (expected.phase === "handoff") {
    if (!["handoff", "admission-intent", "restored", "failed"].includes(next.phase)) invalid();
  } else if (expected.phase === "admission-intent") {
    if (!["completed", "failed"].includes(next.phase)) invalid();
  } else if (next.phase !== "failed" && !(expected.admission === null && next.phase === "restored")) invalid();
  if (expected.admission === null && next.admission !== null && !(expected.phase === "handoff" && next.phase === "admission-intent")) invalid();
  if (!equal(expected.admission, next.admission) && next.admission) assertActiveClient(next, next.admission.client);
  if (!equal(expected.terminalEvidence, next.terminalEvidence) && next.terminalEvidence) assertActiveClient(next, next.terminalEvidence.ready.client);
}

/** 只读取当前恢复执行；历史准入方向及原实体始终留在顶层。 */
function readRecoveryExecution(input: unknown, attempt: ShellUpdateHandoffAttempt): ShellUpdateRecoveryExecution | ShellUpdateRecoveryExecutionV4 {
  const lifecycle = attempt.schemaVersion !== 3;
  const value = fields(input, ["controller", "helper", "main", "direction", "claimedFromRevision", "knownOwned", "terminalEvidence", ...(lifecycle ? ["knownOwnedLifecycle"] : [])]);
  const controller = readProcess(value.controller), helper = readProcess(value.helper), main = value.main === null ? null : readProcess(value.main);
  const direction = attempt.admission === null ? "original" : "candidate", claimedFromRevision = integer(value.claimedFromRevision, 0);
  if (value.direction !== direction || claimedFromRevision >= attempt.revision || helper.parentPid !== controller.pid
    || helper.created < controller.created || helper.executable !== controller.executable
    || ![shellExecutable(attempt, attempt.originalState.activeShellId), shellExecutable(attempt, attempt.target.shellId)].includes(controller.executable)) invalid();
  const historical = [...(attempt.schemaVersion === 5 ? attempt.preparationMains.map(item => item.identity) : [attempt.oldMain]), attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : []),
    ...(attempt.admission ? [attempt.admission.client] : []), ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main, attempt.terminalEvidence.ready.client] : [])];
  if (attempt.schemaVersion !== 3) historical.push(...attempt.recoveryHistory.flatMap(item => [item.controller, item.helper, ...(item.main ? [item.main] : []), ...item.knownOwned]));
  if (historical.some(identity => identity.pid === controller.pid || identity.pid === helper.pid) || controller.pid === helper.pid) invalid();
  if (main && (main.parentPid !== helper.pid || main.created < helper.created || main.executable !== shellExecutable(attempt, direction === "candidate" ? attempt.target.shellId : attempt.originalState.activeShellId)
    || [...historical, controller, helper].some(identity => identity.pid === main.pid))) invalid();
  const roots = [controller, helper, ...(main ? [main] : [])];
  const inventory = lifecycle ? readProcessInventory(value.knownOwned, value.knownOwnedLifecycle, roots, attempt.revision) : undefined;
  if (inventory) assertReleaseObserver(inventory.lifecycle, helper, claimedFromRevision);
  const knownOwned = inventory?.owned ?? readProcessList(value.knownOwned);
  const roleRoots = lifecycle ? [...(attempt.schemaVersion === 5 ? attempt.preparationMains.map(item => item.identity) : [attempt.oldMain]), attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : []),
    ...attempt.recoveryHistory.flatMap(item => [item.controller, item.helper, ...(item.main ? [item.main] : [])])] : historical;
  if (knownOwned.some(identity => [...roleRoots, ...roots].some(root => root.pid === identity.pid))) invalid();
  if (!lifecycle) assertOwnedGraph(knownOwned, roots);
  const result: ShellUpdateRecoveryExecution | ShellUpdateRecoveryExecutionV4 = { controller, helper, main, direction, claimedFromRevision, knownOwned,
    ...(inventory ? { knownOwnedLifecycle: inventory.lifecycle } : {}), terminalEvidence: null };
  if (value.terminalEvidence !== null) {
    if (main === null) invalid();
    result.terminalEvidence = readTerminalEvidence(value.terminalEvidence, attempt, direction, result);
  }
  return result;
}

/** 释放只可由所属执行 helper 的成功观察生成，不接受任意角色摘要。 */
function assertReleaseObserver(lifecycle: ShellProcessLifecycle[], helper: ProcessIdentity, lowerRevision = 0): void {
  const observerKey = processInstanceKey(helper);
  if (lifecycle.some(item => item.release && (item.release.observerKey !== observerKey || item.release.revision <= lowerRevision))) invalid();
}

/** 原/当前已持久实例组成释放核验下界；重复身份合并，冲突PID不可忽略。 */
function recoveryInventory(attempt: ShellUpdateAttemptV3): ProcessIdentity[] {
  const current = attempt.recovery;
  const values = [attempt.oldMain, attempt.helper, ...(attempt.selectedMain ? [attempt.selectedMain] : []), ...(attempt.owned ?? []),
    ...(attempt.admission ? [attempt.admission.main, attempt.admission.client] : []),
    ...(attempt.terminalEvidence ? [attempt.terminalEvidence.ready.main, attempt.terminalEvidence.ready.client] : []),
    ...(current ? [current.controller, current.helper, ...(current.main ? [current.main] : []), ...current.knownOwned] : [])];
  const identities: ProcessIdentity[] = [];
  for (const identity of values) {
    const previous = identities.find(item => item.pid === identity.pid);
    if (previous && !sameIdentity(previous, identity)) invalid();
    if (!previous) identities.push(identity);
  }
  return identities;
}

/** 数组只接数据元素；查询known可重复同一实例，其他入口仍拒绝重复PID。 */
function readProcessList(input: unknown, system = false, allowIdenticalPid = false): ProcessIdentity[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_BYTES
    || Reflect.ownKeys(input).length !== input.length + 1) invalid();
  const values: ProcessIdentity[] = [], seen = new Set<number>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    let identity: ProcessIdentity;
    if (!system) identity = readProcess(descriptor.value);
    else {
      const value = fields(descriptor.value, ["pid", "parentPid", "created", "executable", "commandLine"]);
      if (typeof value.commandLine !== "string" || value.commandLine.includes("\0") || value.commandLine.length > 32768
        || Buffer.from(value.commandLine, "utf8").toString("utf8") !== value.commandLine) invalid();
      identity = { pid: integer(value.pid, 0), parentPid: integer(value.parentPid, 0), created: integer(value.created, 0),
        executable: value.executable === "" ? "" : readSystemPath(value.executable), commandLine: value.commandLine };
    }
    if (seen.has(identity.pid) && (!allowIdenticalPid || !values.some(item => sameIdentity(item, identity)))) invalid();
    seen.add(identity.pid); values.push(identity);
  }
  return values;
}

/** 归属库存只能沿已知父链扩展，不能添加陌生根或通过PID复用认领。 */
function assertOwnedGraph(identities: ProcessIdentity[], roots: ProcessIdentity[]): void {
  const known = [...roots], pending = [...identities];
  while (pending.length) {
    const index = pending.findIndex(item => known.some(parent => parent.pid === item.parentPid && item.created >= parent.created));
    if (index < 0) invalid();
    known.push(pending.splice(index, 1)[0]!);
  }
}

/** 沿实际活父链认领新后代；严格早于父实例的历史行不参与归属，冲突仍失败。 */
function sampleOwned(owned: ProcessIdentity[], roots: ProcessIdentity[], processes: ProcessIdentity[]): ProcessIdentity[] {
  const known = [...owned];
  for (const identity of [...roots, ...known]) {
    const actual = processes.find(item => item.pid === identity.pid);
    if (actual && !sameIdentity(actual, identity)) invalid();
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of processes) {
      if ([...roots, ...known].some(item => sameIdentity(item, identity))) continue;
      const parent = [...roots, ...known].find(item => item.pid === identity.parentPid);
      if (!parent) continue;
      if (Number.isSafeInteger(identity.created) && identity.created > 0 && identity.created < parent.created) continue;
      if (!processes.some(item => sameIdentity(item, parent))) invalid();
      const child = readProcess(identity);
      if (child.created < parent.created) invalid();
      known.push(child); changed = true;
    }
  }
  return known;
}

/** 显式历史必须完整、可归属且不含角色根；当前快照仍独立核PID冲突与新增子链。 */
function observedOwned(owned: ProcessIdentity[], roots: ProcessIdentity[], processes: ProcessIdentity[], history?: { value: unknown }, excluded: ProcessIdentity[] = []): ProcessIdentity[] {
  let known = owned;
  if (history) {
    const observed = readProcessList(history.value);
    if (observed.some(identity => [...roots, ...excluded].some(root => root.pid === identity.pid))
      || owned.some(identity => !observed.some(item => sameIdentity(identity, item)))) invalid();
    assertOwnedGraph(observed, roots);
    known = [...owned, ...observed.filter(identity => !owned.some(item => sameIdentity(identity, item)))];
  }
  const sampled = sampleOwned(known, roots, processes);
  if (sampled.some(identity => excluded.some(item => item.pid === identity.pid))) invalid();
  return sampled;
}

/** gone要求无该PID；严格早于父实例的历史行不归属，未知时间与新孤儿仍失败。 */
function assertReleased(identities: ProcessIdentity[], processes: ProcessIdentity[], excluded: ProcessIdentity[] = []): void {
  for (const identity of identities) {
    if (processes.some(item => item.pid === identity.pid)) invalid();
    if (processes.some(item => item.parentPid === identity.pid && !excluded.some(value => sameIdentity(value, item))
      && !(Number.isSafeInteger(item.created) && item.created > 0 && item.created < identity.created))) invalid();
  }
}

/** 运行时绑定/profile/INI事实严格相等，查询与签名认证仍归实际调用边界。 */
function readRecoveryRuntime(input: unknown, attempt: ShellUpdateHandoffAttempt, extras: string[] = []) {
  const value = fields(input, ["caller", "processes", "launchState", "binding", "profile", ...extras]);
  const caller = readProcess(value.caller), processes = readProcessList(value.processes, true);
  if (!processes.some(identity => sameIdentity(identity, caller))) invalid();
  const launch = fields(value.launchState, ["status", "value"]), binding = fields(value.binding, ["status", "value"]);
  const profile = fields(value.profile, ["status", "dataDir", "userDataDir", "sessionDataDir"]);
  if (launch.status !== "known" || binding.status !== "matched" || profile.status !== "known"
    || !equal(readBinding(binding.value, attempt.originalState.baselineShellId), attempt.binding)
    || profile.dataDir !== attempt.dataDir || profile.userDataDir !== attempt.userDataDir || profile.sessionDataDir !== attempt.sessionDataDir) invalid();
  const launchState = copyState(launch.value);
  if (!equal(launchState, attempt.originalState) && !equal(launchState, attempt.candidateState)) invalid();
  return { value, caller, processes, launchState };
}

/** 生命周期版本共用claim/observe，bind要求controller完整子树已持久释放。 */
function lifecycleNext(kind: "handoff-owned" | "claim" | "bind" | "observe" | "complete", expected: LifecycleHandoffAttempt, input: unknown): LifecycleHandoffAttempt {
  const revision = expected.revision + 1;
  if (kind === "handoff-owned") {
    if (expected.recovery) invalid();
    const hasHistory = Object.hasOwn(fields(input, undefined), "knownOwned");
    const value = fields(input, ["caller", "processes", ...(hasHistory ? ["knownOwned"] : [])]);
    const caller = readProcess(value.caller), processes = readProcessList(value.processes, true);
    if (!sameIdentity(caller, expected.helper)) invalid();
    for (const main of handoffEvidenceMains(expected)) {
      const actual = processes.find(identity => identity.pid === main.pid);
      if (actual && !sameIdentity(actual, main)) invalid();
    }
    const inventory = observeProcessInventory({ inventory: { owned: expected.owned, lifecycle: expected.ownedLifecycle },
      roots: lifecycleRoots(expected), processes, observer: caller, revision,
      ...(hasHistory ? { knownOwned: readHistoricalProcesses(value.knownOwned) } : {}) });
    if (equal(inventory, { owned: expected.owned, lifecycle: expected.ownedLifecycle })) return expected;
    return readAttempt({ ...expected, revision, owned: inventory.owned, ownedLifecycle: inventory.lifecycle }) as LifecycleHandoffAttempt;
  }
  if (kind === "claim") {
    const { value, caller, processes, launchState } = readRecoveryRuntime(input, expected,
      ["owner", "oldMain", "selectedMain", "ownedReleased", "helper", "knownOwned"]);
    const helper = readProcess(value.helper), known = fields(value.knownOwned, ["status", "identities"]);
    if (known.status !== "known" || value.ownedReleased !== "verified" || !processes.some(identity => sameIdentity(identity, helper))
      || caller.executable !== shellExecutable(expected, launchState.activeShellId)
        && !(expected.admission === null && caller.executable === shellExecutable(expected, expected.originalState.activeShellId))) invalid();
    const supplied = readHistoricalProcesses(known.identities), historical = shellUpdateProcessHistory(expected);
    if (historical.some(identity => !supplied.some(item => sameIdentity(item, identity)))
      || supplied.some(identity => !historical.some(item => sameIdentity(item, identity)))) invalid();
    assertShellUpdateInventoryReleased(expected, processes);
    if (readObservation(value.owner, expected.helper) !== "gone" || readObservation(value.oldMain, expected.oldMain) !== "gone"
      || (expected.selectedMain ? readObservation(value.selectedMain, expected.selectedMain) !== "gone" : readNotStarted(value.selectedMain) !== "not-started")
      || expected.admission !== null && !equal(launchState, expected.candidateState)) invalid();
    const inventory = createProcessInventory({ owned: [], roots: [caller, helper], processes, observer: caller, revision });
    const recovery: ShellUpdateRecoveryExecutionV4 = { controller: caller, helper, main: null,
      direction: expected.admission === null ? "original" : "candidate", claimedFromRevision: expected.revision,
      knownOwned: inventory.owned, knownOwnedLifecycle: inventory.lifecycle, terminalEvidence: null };
    return readAttempt({ ...expected, revision, controlRevision: revision,
      recoveryHistory: [...expected.recoveryHistory, ...(expected.recovery ? [expected.recovery] : [])], recovery }) as LifecycleHandoffAttempt;
  }
  const previous = expected.recovery;
  if (!previous || previous.terminalEvidence !== null) invalid();
  if (kind === "complete") {
    const terminalEvidence = readTerminalEvidence(input, expected, previous.direction, previous);
    assertActiveClient(expected, terminalEvidence.ready.client);
    return readAttempt({ ...expected, revision, controlRevision: revision, recovery: { ...previous, terminalEvidence } }) as LifecycleHandoffAttempt;
  }
  const hasHistory = kind === "observe" && Object.hasOwn(fields(input, undefined), "knownOwned");
  const { value, caller, processes, launchState } = readRecoveryRuntime(input, expected, kind === "bind" ? ["main"] : hasHistory ? ["knownOwned"] : []);
  const prebindObservation = kind === "observe" && previous.main === null;
  if (!sameIdentity(caller, previous.helper)) invalid();
  if ((!prebindObservation || previous.direction === "candidate")
    && !equal(launchState, previous.direction === "candidate" ? expected.candidateState : expected.originalState)) invalid();
  assertShellUpdateInventoryReleased({ ...expected, recovery: null }, processes, [previous.helper]);
  if (!prebindObservation) assertReleased([previous.controller], processes, [previous.helper]);
  for (const role of [previous.controller, previous.helper, ...(previous.main ? [previous.main] : [])]) {
    const actual = processes.find(identity => identity.pid === role.pid);
    if (actual && !sameIdentity(actual, role)) invalid();
  }
  if (kind === "bind") {
    const main = readProcess(value.main);
    if (previous.main !== null || !processes.some(identity => sameIdentity(identity, main))) invalid();
    // parentKey沿普通库存闭包，不越过helper角色根；缺少持久释放证明时拒绝绑定。
    const controllerKeys = new Set([processInstanceKey(previous.controller)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of previous.knownOwnedLifecycle) if (controllerKeys.has(item.parentKey) && !controllerKeys.has(item.key)) {
        controllerKeys.add(item.key); changed = true;
      }
    }
    if (previous.knownOwnedLifecycle.some(item => controllerKeys.has(item.key) && item.release === null)) invalid();
    assertProcessInventoryReleased({ inventory: { owned: previous.knownOwned, lifecycle: previous.knownOwnedLifecycle },
      roots: [previous.controller, previous.helper], processes,
      excluded: [previous.helper, main, ...previous.knownOwned.filter((_, index) => !controllerKeys.has(previous.knownOwnedLifecycle[index]!.key))] });
    return readAttempt({ ...expected, revision, controlRevision: revision, recovery: { ...previous, main } }) as LifecycleHandoffAttempt;
  }
  const inventory = observeProcessInventory({ inventory: { owned: previous.knownOwned, lifecycle: previous.knownOwnedLifecycle },
    roots: [previous.controller, previous.helper, ...(previous.main ? [previous.main] : [])], processes, observer: caller, revision,
    excluded: [...(prebindObservation ? [] : [previous.controller]), ...shellUpdateProcessInventory({ ...expected, recovery: null })],
    ...(hasHistory ? { knownOwned: readHistoricalProcesses(value.knownOwned) } : {}) });
  if (equal(inventory, { owned: previous.knownOwned, lifecycle: previous.knownOwnedLifecycle })) return expected;
  return readAttempt({ ...expected, revision, recovery: { ...previous, knownOwned: inventory.owned, knownOwnedLifecycle: inventory.lifecycle } }) as LifecycleHandoffAttempt;
}

/** schema4 全实例历史允许已释放 PID 多代，但拒绝重复实例与访问器。 */
function readHistoricalProcesses(input: unknown): ProcessIdentity[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_BYTES
    || Reflect.ownKeys(input).length !== input.length + 1) invalid();
  const result: ProcessIdentity[] = [], keys = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    const identity = readProcess(descriptor.value), key = processInstanceKey(identity);
    if (keys.has(key)) invalid();
    keys.add(key); result.push(identity);
  }
  return result;
}

/** 同一转换按准入限定恢复方向，合并真实归属历史，只改变revision和当前快照。 */
function recoveryNext(kind: "handoff-owned" | "claim" | "bind" | "observe" | "complete", expected: ShellUpdateAttemptV3, input: unknown): ShellUpdateAttemptV3 {
  if (kind === "handoff-owned") {
    if (expected.recovery || expected.owned === undefined) invalid();
    const hasHistory = Object.hasOwn(fields(input, undefined), "knownOwned");
    const value = fields(input, ["caller", "processes", ...(hasHistory ? ["knownOwned"] : [])]), caller = readProcess(value.caller), processes = readProcessList(value.processes, true);
    if (!sameIdentity(caller, expected.helper) || !processes.some(identity => sameIdentity(identity, caller))) invalid();
    const owned = observedOwned(expected.owned, [expected.oldMain, expected.helper, ...(expected.selectedMain ? [expected.selectedMain] : [])], processes,
      hasHistory ? { value: value.knownOwned } : undefined);
    return owned.length === expected.owned.length ? expected : readAttempt({ ...expected, revision: expected.revision + 1, owned }) as ShellUpdateAttemptV3;
  }
  let recovery: ShellUpdateRecoveryExecution;
  if (kind === "claim") {
    const { value, caller, processes, launchState } = readRecoveryRuntime(input, expected, ["owner", "oldMain", "selectedMain", "ownedReleased", "helper", "knownOwned"]);
    const helper = readProcess(value.helper), inventory = fields(value.knownOwned, ["status", "identities"]);
    if (inventory.status !== "known" || value.ownedReleased !== "verified" || !processes.some(identity => sameIdentity(identity, helper))
      || caller.executable !== shellExecutable(expected, launchState.activeShellId)
        && !(expected.admission === null && caller.executable === shellExecutable(expected, expected.originalState.activeShellId))
      || processes.some(identity => identity.parentPid === caller.pid && !sameIdentity(identity, helper) || identity.parentPid === helper.pid)) invalid();
    const knownOwned = readProcessList(inventory.identities), required = recoveryInventory(expected);
    if (required.some(identity => !knownOwned.some(item => sameIdentity(item, identity)))) invalid();
    assertOwnedGraph(knownOwned.filter(identity => !required.some(item => sameIdentity(item, identity))), required);
    assertReleased(knownOwned, processes);
    if (readObservation(value.owner, expected.helper) !== "gone" || readObservation(value.oldMain, expected.oldMain) !== "gone"
      || (expected.selectedMain ? readObservation(value.selectedMain, expected.selectedMain) !== "gone" : readNotStarted(value.selectedMain) !== "not-started")
      || expected.admission !== null && !equal(launchState, expected.candidateState)) invalid();
    recovery = { controller: caller, helper, main: null, direction: expected.admission === null ? "original" : "candidate",
      claimedFromRevision: expected.revision, knownOwned: [], terminalEvidence: null };
  } else {
    const previous = expected.recovery;
    if (!previous || previous.terminalEvidence !== null) invalid();
    recovery = previous;
    if (kind === "complete") {
      recovery = { ...previous, terminalEvidence: readTerminalEvidence(input, expected, previous.direction, previous) };
    } else {
      const hasHistory = kind === "observe" && Object.hasOwn(fields(input, undefined), "knownOwned");
      const { value, caller, processes, launchState } = readRecoveryRuntime(input, expected, kind === "bind" ? ["main"] : hasHistory ? ["knownOwned"] : []);
      if (!sameIdentity(caller, previous.helper) || !equal(launchState, previous.direction === "candidate" ? expected.candidateState : expected.originalState)) invalid();
      const historical = recoveryInventory({ ...expected, recovery: null });
      assertReleased([...historical, previous.controller], processes, [previous.helper]);
      for (const identity of [previous.helper, ...(previous.main ? [previous.main] : []), ...previous.knownOwned]) {
        const actual = processes.find(item => item.pid === identity.pid);
        if (actual && !sameIdentity(identity, actual)) invalid();
      }
      if (kind === "bind") {
        const main = readProcess(value.main);
        if (previous.main !== null || !processes.some(identity => sameIdentity(identity, main))) invalid();
        recovery = { ...previous, main };
      } else {
        if (previous.main === null) invalid();
        const excluded = [previous.controller, ...historical];
        const known = observedOwned(previous.knownOwned, [previous.helper, previous.main], processes,
          hasHistory ? { value: value.knownOwned } : undefined, excluded);
        if (known.length === previous.knownOwned.length) return expected;
        recovery = { ...previous, knownOwned: known };
      }
    }
  }
  return readAttempt({ ...expected, revision: expected.revision + 1, recovery }) as ShellUpdateAttemptV3;
}

/** 只在候选尚未启动和放行前开放同一网络槽，helper已接管的其他事实不变。 */
function handoffNetworkOpen(attempt: ShellUpdateHandoffAttempt): boolean {
  return !attempt.recovery && attempt.phase === "handoff" && attempt.selectedMain === null && attempt.admission === null && attempt.terminalEvidence === null;
}

/** 授权键必须完整匹配规范安全revision，拒绝相似前缀、前导零与未来动作身份。 */
function switchActionRevision(actionKey: string): number | null {
  const match = /^shell-authorize:(0|[1-9][0-9]{0,15})$/u.exec(actionKey);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

/** 进程字段沿唯一 Windows 身份结构，授权实例要求正 PID/创建时间和绝对 exe。 */
function readProcess(input: unknown): ProcessIdentity {
  const value = fields(input, ["pid", "parentPid", "created", "executable", "commandLine"]);
  if (typeof value.commandLine !== "string" || value.commandLine.length > 32768 || value.commandLine.includes("\0")
    || Buffer.from(value.commandLine, "utf8").toString("utf8") !== value.commandLine) invalid();
  const pid = integer(value.pid, 1), parentPid = integer(value.parentPid, 0);
  if (pid === parentPid) invalid();
  return { pid, parentPid, created: integer(value.created, 1), executable: readPath(value.executable), commandLine: value.commandLine };
}

/** continuationId 沿原 held 启动合同，不将 requestId 的额外字符放宽到许可身份。 */
function readContinuationId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input)) invalid();
  return input;
}

/** 复用现固定壳目录布局，只计算预期 exe，不触碰文件系统。 */
function shellExecutable(attempt: AttemptBase, shellId: string): string { return path.join(attempt.installationDir, "shells", shellId, "CodeFlowAI.exe"); }

/** 复用唯一 INI 严格规则，复制完整 S0/S1 而不复制启动或布局职责。 */
function copyState(input: unknown): ShellLaunchState {
  return parseShellLaunchState(Buffer.from(serializeShellLaunchState(input), "ascii"));
}

/** 读取自有数据描述符，保留 null 原型普通数据但拒绝自定义原型。 */
function fields(input: unknown, expected: readonly string[] | undefined): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string") || (expected && (keys.length !== expected.length || keys.some(key => !expected.includes(key as string))))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    result[key as string] = descriptor.value;
  }
  return result;
}

/** 路径只接受完整规范绝对值；真实 dataDir 由文件边界另核。 */
function readPath(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0") || !path.isAbsolute(input)
    || path.resolve(input) !== input || Buffer.from(input, "utf8").toString("utf8") !== input) invalid();
  return input;
}

/** 系统快照保留原始绝对路径，允许Windows返回尚未规范化的点段；相关身份仍走严格readPath。 */
function readSystemPath(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0") || !path.isAbsolute(input)
    || Buffer.from(input, "utf8").toString("utf8") !== input) invalid();
  return input;
}

/** 沿 shared 可移植 ID 规则并保持与壳 INI 相同的容量边界。 */
function readId(input: unknown): string {
  if (typeof input !== "string" || input.length > 128) invalid();
  return assertReleaseId(input);
}

/** requestId 复用桌面 HTTP 信封规则；它不是安装壳/发布 ID，允许冒号和加号。 */
function readRequestId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(input)) invalid();
  return input;
}

/** 摘要统一为完整小写 SHA256，不修正调用方身份。 */
function hash(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) invalid();
  return input;
}

/** 计数和尺寸必须为可精确持久化的有界整数。 */
function integer(input: unknown, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) invalid();
  return input;
}

/** 仅比较已经严格复制的数据，属性插入顺序不影响 expected 语义。 */
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** 真实根必须保持普通目录，不能把根异常当成空快照。 */
async function rootStat(root: string): Promise<BigIntStats> {
  const stat = await fs.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  return stat;
}

/** 文件发布和清理始终核同一真实根，不重解析被替换的别名。 */
async function assertRoot(root: string, expected: BigIntStats): Promise<void> {
  const current = await rootStat(root);
  if (current.dev !== expected.dev || current.ino !== expected.ino) invalid();
}

/** 临时 inode 仅在单链接普通文件身份确定时允许清理。 */
function sameOwnedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** 读写后同时比较高精度元数据，拒绝替换、改写或链接数变化。 */
function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return sameOwnedFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** 固定外层错误附上下文和真实根因，由未来拥有处理权的边界统一记录日志。 */
function operationError(operation: "READ" | "REPLACE", phase: string, stateReplaced: boolean, cause: unknown, requestId?: string): Error {
  const code = `DESKTOP_SHELL_UPDATE_ATTEMPT_${operation}_FAILED`;
  return Object.assign(new Error(code, { cause }), { code, phase, stateReplaced, ...(requestId ? { requestId } : {}) });
}

/** close 抛错不能证明句柄已释放；保留错误身份并封锁同根后续物理操作。 */
function unreleasedClose(cause: unknown): Error {
  return Object.assign(cause instanceof Error ? cause : new Error("DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED", { cause }), { resourcesReleased: false });
}

/** 无效事实显式失败，不修复、不推断完成、不返回默认值。 */
function invalid(): never {
  throw Object.assign(new Error("DESKTOP_SHELL_UPDATE_ATTEMPT_INVALID"), { code: "DESKTOP_SHELL_UPDATE_ATTEMPT_INVALID" });
}
