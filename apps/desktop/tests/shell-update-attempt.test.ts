import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { digestUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";
import { createUpdateNetworkRetry, type UpdateNetworkAction } from "../src/updateNetworkRetry.js";
import { createShellUpdateAttemptNetworkAdapter, type ShellUpdateAttempt as AnyAttempt, type ShellUpdateAttemptV1 as ShellUpdateAttempt, type ShellUpdateAttemptStore, type ShellUpdateAttemptV2, type ShellUpdateAttemptV3, type ShellUpdateReadyEvidence, type ShellUpdateRecoveryFacts } from "../src/shellUpdateAttempt.js";

const implementation = existsSync(fileURLToPath(new URL("../src/shellUpdateAttempt.ts", import.meta.url)))
  ? await import("../src/shellUpdateAttempt.js") : {} as typeof import("../src/shellUpdateAttempt.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-shell-attempt-"));
const filename = "shell-update-attempt.json";
after(() => { process.stdout.write(`D13 shell attempt evidence: ${root}\n`); });

/** 缺少真实入口时给出合同 RED，不替换产品实现。 */
function store(dataDir: string): ShellUpdateAttemptStore {
  const entry = (implementation as Record<string, unknown>).createShellUpdateAttemptStore;
  assert.equal(typeof entry, "function", "createShellUpdateAttemptStore must exist");
  return (entry as (directory: string) => ShellUpdateAttemptStore)(dataDir);
}

/** 每例使用独占真实目录，保留完整 S0 原 previous 和实际健康。 */
async function fixture(): Promise<{ directory: string; attempt: ShellUpdateAttempt }> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, "data-")));
  await store(directory).read();
  return { directory, attempt: { schemaVersion: 1, requestId: "request-1", revision: 0,
    installationDir: path.join(directory, "installation"), dataDir: directory,
    userDataDir: path.join(directory, "user-profile"), sessionDataDir: path.join(directory, "session-profile"),
    target: { shellId: "shell-new", manifestSha256: "a".repeat(64), installerSha256: "b".repeat(64), installerSize: 123 },
    originalState: { activeShellId: "shell-old", previousShellId: "shell-older", baselineShellId: "installation" },
    candidateState: { activeShellId: "shell-new", previousShellId: "shell-old", baselineShellId: "installation" },
    binding: { kind: "active", releaseId: "release-old", packageSha256: "c".repeat(64),
      health: { protocolVersion: 1, clientVersion: "1.2.3", dbSchemaVersion: 7, database: "ready" } },
    retriesUsed: 0, phase: "preparing" } };
}

test("an expired physical owner scope blocks a second store before any attempt replacement", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  const acquire = (owner as Partial<{ acquireOwner(timeoutMs: number): Promise<{ assertActive(): void; release(): Promise<void> }> }>).acquireOwner;
  const scope = acquire ? await acquire.call(owner, 10) : undefined;
  await new Promise(resolve => setTimeout(resolve, 30));
  try {
    await assert.rejects(store(directory).replace(attempt, next(attempt)), error => error instanceof Error
      && "code" in error && error.code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, filename), "utf8")), attempt);
  } finally {
    if (scope) await assert.rejects(scope.release(), error => error instanceof Error
      && "code" in error && error.code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
  }
});

/** 只复制测试数据，避免预期值引用被测对象。 */
function clone<T>(input: T): T { return structuredClone(input); }

/** 构造下一快照，默认只推进 revision。 */
function next<T extends AnyAttempt>(attempt: T, changes: Partial<T> = {}): T {
  return { ...clone(attempt), revision: attempt.revision + 1, ...changes };
}

test("same-store writer overtakes readers still waiting for an active reader close", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  let close!: () => void, opened!: () => void;
  const held = new Promise<void>(resolve => { close = resolve; });
  const reachedClose = new Promise<void>(resolve => { opened = resolve; });
  const open = fs.open.bind(fs); let captured = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (!captured && String(args[0]) === path.join(directory, filename)) {
      captured = true; const original = file.close.bind(file);
      t.mock.method(file, "close", async () => { opened(); await held; await original(); });
    }
    return file;
  });
  const active = owner.read(); await reachedClose;
  const queued = owner.read(), updated = next(attempt);
  const writing = owner.replace(attempt, updated), later = owner.read();
  await new Promise(resolve => setImmediate(resolve)); close();
  const results = await Promise.all([active, queued, writing, later]);
  assert.deepEqual(results, [attempt, updated, updated, updated]);
});

/** 固定外层错误只携带上下文，原生与清理副因从 cause 链追踪。 */
function failure(error: unknown, operation: "READ" | "REPLACE", phase: string, stateReplaced = false): asserts error is Error & {
  code: string; phase: string; stateReplaced: boolean; requestId?: string;
} {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: unknown }).code, `DESKTOP_SHELL_UPDATE_ATTEMPT_${operation}_FAILED`);
  assert.equal((error as { phase?: unknown }).phase, phase);
  assert.equal((error as { stateReplaced?: unknown }).stateReplaced, stateReplaced);
}

/** 保留错误对象身份，不按错误正文判定故障类型。 */
function causes(error: unknown): unknown[] {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ...(error instanceof Error && error.cause !== undefined ? causes(error.cause) : [])];
}

/** close 未证释放后只读保留现场，不能用已封锁 store 冒充恢复成功。 */
async function poisonedSnapshot(owner: ShellUpdateAttemptStore, directory: string, expected: AnyAttempt | null): Promise<void> {
  await assert.rejects(owner.read(), error => (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
  if (expected === null) await assert.rejects(fs.lstat(path.join(directory, filename)), error => (error as { code?: unknown }).code === "ENOENT");
  else assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, filename), "utf8")), expected);
}

/** 只构造完整本地初始事实，不伪造已选目标或远端资格。 */
function freshAttempt(attempt: AnyAttempt, requestId: string = crypto.randomUUID()): ShellUpdateAttemptV2 {
  return { ...clone(attempt), schemaVersion: 2, requestId, revision: 0, retriesUsed: 0,
    phase: "preparing", target: null, candidateState: null, network: null };
}

/** 沿真实 store 形成成功发现事实；调用方另负责复验结果后正常终结。 */
async function discoveredFixture(retries = 0): Promise<{ directory: string; owner: ShellUpdateAttemptStore; discovered: ShellUpdateAttemptV2 }> {
  const { directory, attempt } = await fixture(), owner = store(directory), initial = freshAttempt(attempt);
  await owner.replace(null, initial);
  const adapter = createShellUpdateAttemptNetworkAdapter(owner);
  const dispatching = { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" as const };
  await adapter.replace(await adapter.read(), { retriesUsed: 0, network: dispatching });
  for (let retry = 1; retry <= retries; retry++) {
    await adapter.replace(await adapter.read(), { retriesUsed: retry, network: { ...dispatching, status: "waiting", delayMs: 0, notBefore: 0 } });
    await adapter.replace(await adapter.read(), { retriesUsed: retry, network: dispatching });
  }
  await adapter.replace(await adapter.read(), { retriesUsed: retries, network: { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } });
  return { directory, owner, discovered: await owner.read() as ShellUpdateAttemptV2 };
}

/** 持久身份复用唯一进程模块的字段；本测试不查询或停止任何真实进程。 */
function handoffProcess(attempt: AnyAttempt, pid: number, parentPid: number, shellId = attempt.originalState.activeShellId): ProcessIdentity {
  return { pid, parentPid, created: 100000 + pid, executable: path.join(attempt.installationDir, "shells", shellId, "CodeFlowAI.exe"), commandLine: `shell-process-${pid}` };
}

/** 通过原网络成功槽和一次目标绑定产生真正可迁移的 schema2。 */
async function preparedHandoffFixture() {
  const { directory, owner, discovered } = await discoveredFixture(2), { attempt } = await fixture();
  const prepared = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, target: attempt.target, candidateState: attempt.candidateState });
  assert.ok(prepared.schemaVersion === 2 && prepared.target !== null);
  const oldMain = handoffProcess(prepared, 101, 1), helper = handoffProcess(prepared, 102, 101);
  const facts = { continuationId: "handoff-continuation", oldMain, helper };
  return { directory, owner, prepared, facts };
}

/** 新准备入口缺失时明确报告合同失败，不用内存库存替代持久事实。 */
async function preparationFixture() {
  const { directory, attempt } = await fixture(), owner = store(directory), fresh = freshAttempt(attempt);
  const main = handoffProcess(fresh, 101, 1), client = handoffProcess(fresh, 201, main.pid), ordinary = handoffProcess(fresh, 301, main.pid);
  assert.equal(typeof owner.beginPreparation, "function", "beginPreparation must persist schema5 before network");
  const prepared = await owner.beginPreparation(null, fresh, { main, client, readyRequestId: "initial-ready", processes: [main, client, ordinary] });
  return { directory, owner, fresh, prepared, main, client, ordinary };
}

/** 普通重启事实引用同一S0/profile，调用者身份由本次成功系统快照给出。 */
function preparationRuntime(attempt: AnyAttempt, caller: ProcessIdentity, processes: ProcessIdentity[]) {
  return { caller, processes, launchState: { status: "known" as const, value: attempt.originalState },
    binding: { status: "matched" as const, value: attempt.binding },
    profile: { status: "known" as const, dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir } };
}

test("schema5 preparation persists initial tree and releases before allowing ordinary PID reuse", async () => {
  const f = await preparationFixture();
  assert.equal(f.prepared.schemaVersion, 5); assert.equal(f.prepared.revision, 1); assert.equal(f.prepared.controlRevision, 1);
  assert.deepEqual(f.prepared.preparationMains, [{ identity: f.main, boundAtRevision: 1 }]);
  assert.deepEqual(f.prepared.owned, [f.client, f.ordinary]);
  const released = await f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main, f.client] });
  assert.equal(released.revision, 2); assert.equal(released.controlRevision, 1);
  assert.equal(released.ownedLifecycle[1]!.release!.revision, 2);
  const foreign = { ...f.ordinary, parentPid: 999, created: f.ordinary.created + 100, commandLine: "foreign" };
  assert.deepEqual(await f.owner.observePreparationOwned(released, { caller: f.main, processes: [f.main, f.client, foreign] }), released);
  assert.deepEqual(implementation.shellUpdateOwnedInventory(released), [f.client]);
  assert.deepEqual(await store(f.directory).read(), released);
});

test("schema5 preparation rejects reuse before release and role conflicts without writing", async () => {
  const f = await preparationFixture();
  for (const processes of [[f.main, f.client, { ...f.ordinary, created: 999999 }], [f.main, { ...f.client, executable: "" }]]) {
    await assert.rejects(f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes }));
    assert.deepEqual(await f.owner.read(), f.prepared);
  }
  const replacement = { ...f.main, created: f.main.created + 100 };
  await assert.rejects(f.owner.bindPreparationMain(f.prepared, preparationRuntime(f.prepared, replacement, [replacement])));
  assert.deepEqual(await f.owner.read(), f.prepared);
});

test("schema5 preparation atomically binds successive ordinary mains and preserves observer intervals", async () => {
  const f = await preparationFixture(), second = handoffProcess(f.prepared, 501, 1), third = handoffProcess(f.prepared, 601, 1);
  const bound = await store(f.directory).bindPreparationMain(f.prepared, preparationRuntime(f.prepared, second, [second]));
  assert.deepEqual(bound.preparationMains, [{ identity: f.main, boundAtRevision: 1 }, { identity: second, boundAtRevision: 2 }]);
  assert.ok(bound.ownedLifecycle.every(item => item.release?.revision === 2));
  const again = await store(f.directory).bindPreparationMain(bound, preparationRuntime(bound, third, [third]));
  assert.equal(again.preparationMains[2]!.boundAtRevision, 3); assert.deepEqual(again.ownedLifecycle, bound.ownedLifecycle);
  const invalid = clone(again); invalid.ownedLifecycle[0]!.release!.revision = 1;
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify(invalid), "utf8");
  await assert.rejects(store(f.directory).read());
});

for (const reason of ["old-main", "old-child", "unknown-child", "owned-pid", "wrong-state"] as const)
test(`schema5 preparation root bind rejects ${reason} atomically`, async () => {
  const f = await preparationFixture(), main = handoffProcess(f.prepared, 501, 1);
  const caller = reason === "owned-pid" ? { ...main, pid: f.ordinary.pid } : main;
  const processes = [caller, ...(reason === "old-main" ? [f.main] : reason === "old-child" ? [f.client]
    : reason === "unknown-child" ? [handoffProcess(f.prepared, 401, f.main.pid)] : [])];
  const facts = preparationRuntime(f.prepared, caller, processes);
  if (reason === "wrong-state") facts.launchState.value = { ...facts.launchState.value, previousShellId: "other" };
  await assert.rejects(f.owner.bindPreparationMain(f.prepared, facts)); assert.deepEqual(await f.owner.read(), f.prepared);
});

test("schema5 preparation keeps exact network revision and retry budget across observation", async () => {
  const f = await preparationFixture(), adapter = createShellUpdateAttemptNetworkAdapter(f.owner);
  const first = await adapter.read(), action = { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const sent = await adapter.replace(first, { retriesUsed: 0, network: action });
  const waiting = await adapter.replace(sent, { retriesUsed: 1, network: { ...action, status: "waiting", delayMs: 25, notBefore: 123 } });
  const before = await f.owner.read(); assert.ok(before?.schemaVersion === 5 && !implementation.isShellUpdateHandoffAttempt(before));
  const observed = await f.owner.observePreparationOwned(before, { caller: f.main, processes: [f.main, f.client] });
  assert.equal(observed.retriesUsed, 1); assert.deepEqual(observed.network, before.network);
  await assert.rejects(adapter.replace(waiting, { retriesUsed: 1, network: action }));
  assert.deepEqual(await f.owner.read(), observed);
});

/** 真网络槽及一次目标绑定后交接，可带缺父旧行核验准备proof不经重新建图。 */
async function preparationHandoffFixture(missingParentOld = false) {
  const f = await preparationFixture(), old = { ...handoffProcess(f.prepared, 801, f.ordinary.pid), created: 1, executable: "", commandLine: "" };
  const unrelated = missingParentOld ? [old] : [];
  const released = await f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main, f.client, ...unrelated] });
  const adapter = createShellUpdateAttemptNetworkAdapter(f.owner), state = await adapter.read();
  const action = { actionKey: "shell-installer", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const dispatch = await adapter.replace(state, { retriesUsed: 0, network: action });
  await adapter.replace(dispatch, { retriesUsed: 0, network: { ...action, status: "succeeded", evidence: { kind: "shell-installer", sha256: "e".repeat(64) } } });
  const current = await f.owner.read(); assert.ok(current?.schemaVersion === 5 && !implementation.isShellUpdateHandoffAttempt(current));
  const selected = await f.owner.replace(current, next(current, { target: { shellId: "shell-new", manifestSha256: "a".repeat(64), installerSha256: "b".repeat(64), installerSize: 123 },
    candidateState: { activeShellId: "shell-new", previousShellId: "shell-old", baselineShellId: "installation" } }));
  assert.ok(selected.schemaVersion === 5 && !implementation.isShellUpdateHandoffAttempt(selected));
  const helper = handoffProcess(selected, 401, f.main.pid);
  const handoff = await f.owner.beginHandoff(selected, { lifecycle: true, continuationId: "preparation-handoff", oldMain: f.main, helper,
    processes: [f.main, f.client, helper, ...unrelated] });
  return { ...f, released, helper, selected, handoff, unrelated };
}

test("schema5 missing-parent old row preserves preparation proof through handoff and recovery", async () => {
  const f = await preparationHandoffFixture(true);
  assert.deepEqual(f.released.owned, f.prepared.owned);
  assert.equal(f.released.ownedLifecycle[1]!.release!.revision, f.released.revision);
  assert.equal(f.released.ownedLifecycle[1]!.parentKey, f.prepared.ownedLifecycle[1]!.parentKey);
  assert.deepEqual(f.handoff.ownedLifecycle[1], f.released.ownedLifecycle[1]);
  const gone = await f.owner.observeHandoffOwned(f.handoff, { caller: f.helper, processes: [f.helper, ...f.unrelated] });
  const caller = handoffProcess(gone, 701, 1), helper = handoffProcess(gone, 702, caller.pid);
  const claimed = await f.owner.beginRecovery(gone, { ...preparationRuntime(gone, caller, [caller, helper, ...f.unrelated]), helper,
    owner: { status: "gone", identity: f.helper }, oldMain: { status: "gone", identity: f.main }, selectedMain: { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(gone) } });
  assert.deepEqual(claimed.ownedLifecycle, gone.ownedLifecycle);
  const observed = await f.owner.observeRecoveryOwned(claimed, preparationRuntime(claimed, helper, [helper, ...f.unrelated]));
  assert.deepEqual(observed.ownedLifecycle, gone.ownedLifecycle); assert.deepEqual(await f.owner.read(), observed);
});

for (const afterRename of [false, true])
test(`schema5 missing-parent observation reports ${afterRename ? "post" : "pre"}-rename failure without inventing rollback`, async t => {
  const f = await preparationFixture(), before = await fs.readFile(path.join(f.directory, filename)), rename = fs.rename, open = fs.open;
  const old = { ...handoffProcess(f.prepared, 801, f.ordinary.pid), created: 1, executable: "", commandLine: "" };
  const primary = new Error("missing-parent persistence failure"); let replaced = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!afterRename) throw primary;
    await rename(...args); replaced = true;
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (replaced && args[0] === path.join(f.directory, filename)) throw primary;
    return open(...args);
  });
  await assert.rejects(f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main, f.client, old] }), (error: any) => {
    assert.equal(error.cause, primary); assert.equal(error.stateReplaced, afterRename);
    assert.equal(error.phase, afterRename ? "verify-replaced" : "replace"); return true;
  });
  t.mock.restoreAll();
  if (!afterRename) assert.deepEqual(await fs.readFile(path.join(f.directory, filename)), before);
  else {
    const actual = await f.owner.read(); assert.ok(actual?.schemaVersion === 5 && !implementation.isShellUpdateHandoffAttempt(actual));
    assert.equal(actual.revision, f.prepared.revision + 1); assert.deepEqual(actual.owned, f.prepared.owned);
    assert.equal(actual.ownedLifecycle[1]!.release!.revision, actual.revision);
  }
});

test("schema5 preparation handoff preserves parent keys and proof then supports recovery", async () => {
  const f = await preparationHandoffFixture();
  assert.equal(f.handoff.schemaVersion, 5); assert.equal(f.handoff.handoffRevision, f.handoff.revision);
  assert.deepEqual(f.handoff.ownedLifecycle[1], f.released.ownedLifecycle[1]);
  const gone = await f.owner.observeHandoffOwned(f.handoff, { caller: f.helper, processes: [f.helper] });
  assert.equal(gone.ownedLifecycle[0]!.release!.revision, gone.revision);
  const caller = handoffProcess(gone, 701, 1), helper = handoffProcess(gone, 702, caller.pid);
  const claimed = await f.owner.beginRecovery(gone, { ...preparationRuntime(gone, caller, [caller, helper]), helper,
    owner: { status: "gone", identity: f.helper }, oldMain: { status: "gone", identity: f.main }, selectedMain: { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(gone) } });
  assert.equal(claimed.schemaVersion, 5); assert.deepEqual(claimed.preparationMains, f.handoff.preparationMains);
  assert.deepEqual(claimed.ownedLifecycle, gone.ownedLifecycle); assert.equal(claimed.recovery!.controller.pid, caller.pid);
  const observed = await f.owner.observeRecoveryOwned(claimed, { ...preparationRuntime(claimed, helper, [helper]) });
  assert.deepEqual(await f.owner.read(), observed);
});

test("schema5 preparation freezes proof and rejects partial handoff or illegal observer intervals", async () => {
  const f = await preparationHandoffFixture();
  await assert.rejects(f.owner.replace(f.handoff, { ...next(f.handoff), handoffRevision: f.handoff.handoffRevision + 1 }));
  const invalid = clone(f.handoff); invalid.ownedLifecycle[1]!.release!.revision = invalid.handoffRevision;
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify(invalid), "utf8"); await assert.rejects(store(f.directory).read());
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify({ ...f.prepared, continuationId: "partial" }), "utf8");
  await assert.rejects(store(f.directory).read());
});

test("schema5 preparation refuses preselected initialization and automatic legacy upgrade", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory), fresh = freshAttempt(attempt);
  const main = handoffProcess(fresh, 101, 1), client = handoffProcess(fresh, 201, main.pid);
  const facts = { main, client, readyRequestId: "ready", processes: [main, client] };
  await assert.rejects(owner.beginPreparation(null, { ...fresh, target: attempt.target, candidateState: attempt.candidateState }, facts));
  assert.equal(await owner.read(), null);
  const legacy = await owner.replace(null, fresh);
  await assert.rejects(owner.beginPreparation(legacy, freshAttempt(attempt), facts)); assert.deepEqual(await owner.read(), legacy);
});

test("schema5 preparation same-root startup checks expected without observing another stage", async () => {
  const f = await preparationFixture();
  const unchanged = await f.owner.bindPreparationMain(f.prepared, preparationRuntime(f.prepared, f.main, [f.main, f.client]));
  assert.deepEqual(unchanged, f.prepared); assert.deepEqual(await f.owner.read(), f.prepared);
});

test("schema5 preparation same-root startup rejects an unreleased identity conflict", async () => {
  const f = await preparationFixture(), foreign = { ...f.ordinary, parentPid: 999, created: 900000 };
  await assert.rejects(f.owner.bindPreparationMain(f.prepared, preparationRuntime(f.prepared, f.main, [f.main, f.client, foreign])));
  assert.deepEqual(await f.owner.read(), f.prepared);
});

test("schema5 preparation starts a new schema5 cycle only after a no-update terminal", async () => {
  const f = await preparationFixture(), adapter = createShellUpdateAttemptNetworkAdapter(f.owner);
  const action = { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const sent = await adapter.replace(await adapter.read(), { retriesUsed: 0, network: action });
  await adapter.replace(sent, { retriesUsed: 0, network: { ...action, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } });
  const latest = await f.owner.read(); assert.ok(latest);
  const terminal = await f.owner.replace(latest, next(latest, { phase: "no-update" }));
  const fresh = { ...f.fresh, requestId: "next-cycle" };
  const cycle = await f.owner.beginPreparation(terminal, fresh, { main: f.main, client: f.client, readyRequestId: "same-ready", processes: [f.main, f.client] });
  assert.equal(cycle.requestId, "next-cycle"); assert.equal(cycle.revision, 1); assert.equal(cycle.network, null);
  assert.deepEqual(cycle.owned, [f.client]); assert.deepEqual(cycle.preparationMains, [{ identity: f.main, boundAtRevision: 1 }]);
});

test("schema5 preparation snapshots initialization and observation facts before their first await", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory), fresh = freshAttempt(attempt);
  const main = handoffProcess(fresh, 101, 1), client = handoffProcess(fresh, 201, main.pid);
  const facts = { main: clone(main), client: clone(client), readyRequestId: "ready", processes: [clone(main), clone(client)] };
  const pending = owner.beginPreparation(null, fresh, facts); fresh.requestId = "changed-after-call"; facts.processes.length = 0; facts.main.created++;
  const initialized = await pending; assert.notEqual(initialized.requestId, fresh.requestId); assert.equal(initialized.preparationMains[0]!.identity.created, main.created);
  const observedFacts = { caller: clone(main), processes: [clone(main)] }, observed = owner.observePreparationOwned(initialized, observedFacts);
  observedFacts.caller.created++; observedFacts.processes.push(client);
  const released = await observed; assert.ok(released.ownedLifecycle[0]!.release); assert.deepEqual(await owner.read(), released);
});

test("schema5 preparation rejects ordinary replace inventory injection and released root PID promotion", async () => {
  const f = await preparationFixture();
  await assert.rejects(f.owner.replace(f.prepared, { ...next(f.prepared), owned: [], ownedLifecycle: [] }));
  const released = await f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main] });
  const promoted = { ...handoffProcess(released, f.ordinary.pid, 1), created: 900000 };
  await assert.rejects(f.owner.bindPreparationMain(released, preparationRuntime(released, promoted, [promoted])));
  assert.deepEqual(await f.owner.read(), released);
});

test("schema5 preparation reader rejects future root proofs and oversized root history", async () => {
  const f = await preparationFixture(), second = handoffProcess(f.prepared, 501, 1);
  const bound = await f.owner.bindPreparationMain(f.prepared, preparationRuntime(f.prepared, second, [second]));
  const invalid = clone(bound); invalid.ownedLifecycle[0]!.release!.observerKey = crypto.createHash("sha256").update(JSON.stringify([f.main.pid, f.main.parentPid, f.main.created, f.main.executable, f.main.commandLine])).digest("hex");
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify(invalid), "utf8"); await assert.rejects(store(f.directory).read());
  const oversized = { ...clone(bound), revision: 1025, controlRevision: 1025, owned: [], ownedLifecycle: [] };
  oversized.preparationMains = Array.from({ length: 1025 }, (_, index) => ({ identity: handoffProcess(bound, 2000 + index, 1), boundAtRevision: index + 1 }));
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify(oversized), "utf8"); await assert.rejects(store(f.directory).read());
});

test("schema5 preparation cannot enter handoff through ordinary replace", async () => {
  const f = await preparationHandoffFixture();
  await fs.writeFile(path.join(f.directory, filename), JSON.stringify(f.selected), "utf8");
  await assert.rejects(f.owner.replace(f.selected, { ...f.handoff, controlRevision: f.selected.controlRevision, handoffRevision: f.selected.revision }));
  assert.deepEqual(await f.owner.read(), f.selected);
});

test("schema5 preparation failed state permits ordinary root binding without reopening network", async () => {
  const f = await preparationFixture(), adapter = createShellUpdateAttemptNetworkAdapter(f.owner);
  const action = { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const sent = await adapter.replace(await adapter.read(), { retriesUsed: 0, network: action });
  await adapter.replace(sent, { retriesUsed: 0, network: { ...action, status: "failed", errorCode: "NETWORK_REFUSED" } });
  const failed = await f.owner.read(); assert.ok(failed?.schemaVersion === 5 && !implementation.isShellUpdateHandoffAttempt(failed));
  assert.equal(failed.phase, "failed");
  const main = handoffProcess(failed, 501, 1), bound = await f.owner.bindPreparationMain(failed, preparationRuntime(failed, main, [main]));
  assert.equal(bound.phase, "failed"); assert.deepEqual(bound.network, failed.network); assert.equal(bound.retriesUsed, failed.retriesUsed);
  await assert.rejects(adapter.replace(await adapter.read(), { retriesUsed: 0, network: action }));
  assert.deepEqual(await f.owner.read(), bound);
});

test("D13 store accepts only exact shell failure evidence and a complete current inventory for a new request", async () => {
  const f = await preparationFixture(), adapter = createShellUpdateAttemptNetworkAdapter(f.owner);
  const action = { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const sent = await adapter.replace(await adapter.read(), { retriesUsed: 0, network: action });
  await adapter.replace(sent, { retriesUsed: 0, network: { ...action, status: "failed", errorCode: "NETWORK_REFUSED" } });
  const failed = await f.owner.read(); assert.ok(failed);
  const journal = createUpdateFailureJournal(f.directory), evidence = journal.recordShell({ deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", shellVersion: "1",
    currentReleaseId: "installation", webVersion: "1", clientVersion: "1", requestId: failed.requestId, shellId: null,
    phase: "prepare", recovery: "not_needed", error: new Error("DESKTOP_SHELL_NETWORK_FAILED") });
  const fresh = { ...f.fresh, requestId: "manual-cycle" }, facts = { main: f.main, client: f.client, readyRequestId: "ready", processes: [f.main, f.client], failure: evidence };
  const before = await fs.readFile(path.join(f.directory, filename));
  for (const changes of [{ requestId: "foreign" }, { phase: "handoff" as const }, { recovery: "failed" as const }, { shellId: "other-shell" }]) {
    const { payloadSha256: _digest, ...payload } = { ...evidence, ...changes };
    await assert.rejects(f.owner.beginPreparation(failed, fresh, { ...facts, failure: { ...payload, payloadSha256: digestUpdateFailureRecord(payload) } }));
  }
  await assert.rejects(f.owner.beginPreparation(failed, { ...fresh, requestId: failed.requestId }, facts));
  const foreign = { ...f.ordinary, created: f.ordinary.created + 1, parentPid: 999 };
  await assert.rejects(f.owner.beginPreparation(failed, fresh, { ...facts, processes: [f.main, f.client, foreign] }));
  await assert.rejects(f.owner.beginPreparation(failed, { ...fresh, userDataDir: path.join(f.directory, "other") }, facts));
  assert.deepEqual(await fs.readFile(path.join(f.directory, filename)), before);
  const prepared = await f.owner.beginPreparation(failed, fresh, facts);
  assert.equal(prepared.requestId, "manual-cycle"); assert.equal(prepared.retriesUsed, 0); assert.equal(prepared.network, null);
  assert.deepEqual(prepared.owned, [f.client]); assert.equal(journal.shellFailures(evidence.deviceId, failed.requestId).length, 1);
});

test("schema5 preparation rejects capacity overflow and preserves the real file bytes", async () => {
  const f = await preparationFixture(), before = await fs.readFile(path.join(f.directory, filename));
  const children = Array.from({ length: 1023 }, (_, index) => handoffProcess(f.prepared, 1000 + index, f.main.pid));
  await assert.rejects(f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main, f.client, f.ordinary, ...children] }));
  const large = Array.from({ length: 40 }, (_, index) => ({ ...handoffProcess(f.prepared, 3000 + index, f.main.pid), commandLine: "x".repeat(32768) }));
  await assert.rejects(f.owner.observePreparationOwned(f.prepared, { caller: f.main, processes: [f.main, f.client, f.ordinary, ...large] }));
  assert.deepEqual(await fs.readFile(path.join(f.directory, filename)), before); assert.deepEqual(await f.owner.read(), f.prepared);
});

test("beginHandoff explicitly preserves the successful schema2 facts in the same schema3 file", async () => {
  const { directory, owner, prepared, facts } = await preparedHandoffFixture();
  const entry = (owner as ShellUpdateAttemptStore & { beginHandoff?: (expected: unknown, facts: unknown) => Promise<AnyAttempt> }).beginHandoff;
  assert.equal(typeof entry, "function", "beginHandoff must exist on the unique store");
  const handoff = await entry!(prepared, facts);
  assert.deepEqual(handoff, { ...prepared, schemaVersion: 3, revision: prepared.revision + 1, phase: "handoff", ...facts,
    selectedMain: null, admission: null, terminalEvidence: null });
  assert.deepEqual(await store(directory).read(), handoff); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
  assert.deepEqual(await createShellUpdateAttemptNetworkAdapter(owner).read(), { revision: handoff.revision, retriesUsed: handoff.retriesUsed, network: handoff.network });
});

test("schema4 handoff preserves gone history and proves release before allowing PID reuse", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture();
  const child = handoffProcess(prepared, 801, facts.helper.pid);
  const handoff = await owner.beginHandoff(prepared, { ...facts, lifecycle: true,
    processes: [facts.oldMain, facts.helper], knownOwned: [child] });
  assert.equal(handoff.schemaVersion, 4);
  const value = handoff as unknown as { revision: number; controlRevision: number; owned: ProcessIdentity[];
    ownedLifecycle: { release: { revision: number } | null }[]; recoveryHistory: unknown[] };
  assert.deepEqual(value.owned, [child]); assert.equal(value.controlRevision, value.revision);
  assert.equal(value.ownedLifecycle[0]!.release!.revision, value.revision); assert.deepEqual(value.recoveryHistory, []);
  const reused = { ...child, created: child.created + 100, parentPid: 999, commandLine: "foreign-reused" };
  const observed = await owner.observeHandoffOwned(handoff, { caller: facts.helper, processes: [facts.helper, reused] });
  assert.deepEqual(observed, handoff); assert.deepEqual(await owner.read(), handoff);
});

/** 新版 fixture 只通过真实交接入口生成，不直接伪造 schema4。 */
async function lifecycleFixture() {
  const item = await preparedHandoffFixture();
  const attempt = await item.owner.beginHandoff(item.prepared, { ...item.facts, lifecycle: true as const,
    processes: [item.facts.oldMain, item.facts.helper], knownOwned: [] });
  return { ...item, attempt };
}

/** 旧模块缺少上下文时仍观察真实活投影，RED断言待采行为而非导入存在性。 */
function snapshotContext(attempt: import("../src/shellUpdateAttempt.js").ShellUpdateHandoffAttempt | import("../src/shellUpdateAttempt.js").ShellUpdatePreparationAttemptV5,
  extraKnown: readonly ProcessIdentity[] = []): { known: readonly ProcessIdentity[]; preflight?: (processes: readonly ProcessIdentity[]) => readonly ProcessIdentity[] } {
  const entry = (implementation as Record<string, unknown>).shellUpdateProcessSnapshotContext;
  return typeof entry === "function" ? entry(attempt, extraKnown) : { known: implementation.shellUpdateProcessInventory(attempt) };
}

for (const version of [4, 5]) test(`snapshot context schema${version} returns pending without disk or inventory changes`, async () => {
  const f = version === 4 ? await lifecycleFixture() : await preparationFixture();
  const attempt = "attempt" in f ? f.attempt : f.prepared, main = "attempt" in f ? f.attempt.helper : f.main;
  const before = clone(attempt), bytes = await fs.readFile(path.join(f.directory, filename)), partial = { ...handoffProcess(attempt, 1200, main.pid), executable: "" };
  const context = snapshotContext(attempt);
  assert.deepEqual(context.preflight?.([main, partial]) ?? [], [partial]);
  assert.deepEqual(attempt, before); assert.ok((await fs.readFile(path.join(f.directory, filename))).equals(bytes));
  partial.commandLine = "changed-caller"; attempt.revision += 1;
  const fresh = { ...handoffProcess(before, 1200, main.pid), executable: "" };
  assert.deepEqual(context.preflight?.([main, fresh]), [fresh]);
});

test("snapshot context keeps extra known identities separate from fresh pending and rejects visible conflicts", async () => {
  const { attempt } = await lifecycleFixture(), extra = handoffProcess(attempt, 1200, attempt.helper.pid), partial = { ...extra, executable: "" };
  const context = snapshotContext(attempt, [extra]);
  assert.deepEqual(context.known, [...implementation.shellUpdateProcessInventory(attempt), extra]);
  assert.deepEqual(context.preflight?.([attempt.helper, partial]), []);
  assert.throws(() => context.preflight?.([attempt.helper, { ...partial, commandLine: "conflict" }]));
  assert.throws(() => snapshotContext(attempt, [{ ...attempt.helper, created: attempt.helper.created + 1 }]));
});

test("snapshot context scans released history even when another execution has a pending child", async () => {
  const f = await lifecycleRecoveryFixture(), claimed = await f.owner.beginRecovery(f.attempt, f.facts);
  const runtime = { ...f.runtime, caller: f.helper };
  const released = await f.owner.observeRecoveryOwned(claimed, { ...runtime, processes: [f.helper, f.helperChild, f.helperGrandchild] });
  const pending = { ...handoffProcess(released, 1300, f.helper.pid), executable: "" }, context = snapshotContext(released);
  assert.deepEqual(context.preflight?.([f.helper, f.helperChild, f.helperGrandchild, pending]), [pending]);
  for (const bad of [f.controllerChild, { ...f.controllerChild, created: f.controllerChild.created + 1, executable: "" }]) {
    assert.throws(() => context.preflight?.([f.helper, pending, bad]));
  }
  assert.deepEqual(await f.owner.read(), released);
});

test("snapshot context rejects a released PID partial from an older execution before new recovery pending", async () => {
  const { owner, attempt } = await lifecycleFixture(), oldChild = handoffProcess(attempt, 1400, attempt.helper.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, oldChild] });
  const released = await owner.observeHandoffOwned(observed, { caller: attempt.helper, processes: [attempt.helper] });
  const failed = await owner.replace(released, { ...released, revision: released.revision + 1, phase: "failed" }) as typeof attempt;
  const caller = handoffProcess(failed, 1500, 1), helper = handoffProcess(failed, 1501, caller.pid), runtime = preparationRuntime(failed, caller, [caller, helper]);
  const claimed = await owner.beginRecovery(failed, { ...runtime, helper, owner: { status: "gone", identity: failed.helper },
    oldMain: { status: "gone", identity: failed.oldMain }, selectedMain: { status: "not-started" }, ownedReleased: "verified",
    knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(failed) } });
  const context = snapshotContext(claimed), pending = { ...handoffProcess(claimed, 1600, helper.pid), executable: "" };
  assert.deepEqual(context.preflight?.([helper, pending]), [pending]);
  const reused = { ...oldChild, parentPid: helper.pid, created: helper.created + 1, commandLine: "new-recovery-query", executable: "" };
  for (const processes of [[helper, pending, reused], [reused, pending, helper], [helper, pending, oldChild]]) assert.throws(() => context.preflight?.(processes));
  assert.deepEqual(await owner.read(), claimed);
});

test("snapshot context schema3 preserves known-only sampling and strict input copying", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), attempt = await owner.beginHandoff(prepared, facts);
  const extra = handoffProcess(attempt, 1200, attempt.helper.pid), context = snapshotContext(attempt, [extra]);
  assert.equal(context.preflight, undefined); assert.deepEqual(context.known, [...implementation.shellUpdateProcessInventory(attempt), extra]);
  extra.commandLine = "changed-after-context"; attempt.helper.commandLine = "changed-after-context";
  assert.equal(context.known.find(item => item.pid === 1200)!.commandLine, "shell-process-1200");
  assert.equal(context.known.find(item => item.pid === facts.helper.pid)!.commandLine, facts.helper.commandLine);
});

test("snapshot context retains the existing exact-duplicate known contract", async () => {
  const { attempt } = await lifecycleFixture(), extra = handoffProcess(attempt, 1200, attempt.helper.pid);
  const context = snapshotContext(attempt, [extra, extra]);
  assert.deepEqual(context.known, [...implementation.shellUpdateProcessInventory(attempt), extra]);
  assert.throws(() => snapshotContext(attempt, [extra, { ...extra, commandLine: "conflicting-same-pid" }]));
});

test("schema4 ancestry persists a new parent without adopting an older incomplete system row", async () => {
  const { owner, attempt } = await lifecycleFixture(), parent = handoffProcess(attempt, 970, attempt.helper.pid);
  const old = { ...handoffProcess(attempt, 971, parent.pid), created: 1, executable: "", commandLine: "" };
  const descendant = handoffProcess(attempt, 972, old.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, old, descendant, parent] });
  assert.equal(observed.revision, attempt.revision + 1); assert.equal(observed.controlRevision, attempt.controlRevision);
  assert.deepEqual(observed.owned, [parent]); assert.equal(observed.ownedLifecycle[0]!.release, null);
  assert.deepEqual(await owner.read(), observed);
  const released = await owner.observeHandoffOwned(observed, { caller: attempt.helper, processes: [attempt.helper] });
  const foreign = { ...parent, parentPid: 999, created: parent.created + 100, commandLine: "foreign" };
  const unchanged = await owner.observeHandoffOwned(released, { caller: attempt.helper, processes: [attempt.helper, foreign, old, descendant] });
  assert.deepEqual(unchanged, released); assert.deepEqual(await owner.read(), released);
  assert.deepEqual(implementation.shellUpdateOwnedInventory(unchanged), []);
});

test("schema4 ancestry rejects an unknown row between parent generations without changing release evidence", async () => {
  const { owner, attempt } = await lifecycleFixture(), parent = handoffProcess(attempt, 970, attempt.helper.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, parent] });
  const released = await owner.observeHandoffOwned(observed, { caller: attempt.helper, processes: [attempt.helper] });
  const next = { ...parent, created: parent.created + 100, commandLine: "next-parent" };
  const current = await owner.observeHandoffOwned(released, { caller: attempt.helper, processes: [attempt.helper, next] });
  const between = { ...handoffProcess(attempt, 971, parent.pid), created: parent.created + 50 };
  await assert.rejects(owner.observeHandoffOwned(current, { caller: attempt.helper, processes: [attempt.helper, next, between] }));
  assert.deepEqual(await owner.read(), current); assert.deepEqual(current.ownedLifecycle[0], released.ownedLifecycle[0]);
  assert.equal(current.ownedLifecycle[1]!.release, null);
});

/** 恢复事实只包含旧执行历史；当前普通后代必须由真实快照推导。 */
async function lifecycleRecoveryFixture() {
  const { owner, attempt } = await lifecycleFixture();
  const caller = handoffProcess(attempt, 950, 1), helper = handoffProcess(attempt, 951, caller.pid);
  const controllerChild = handoffProcess(attempt, 952, caller.pid), controllerGrandchild = handoffProcess(attempt, 953, controllerChild.pid);
  const helperChild = handoffProcess(attempt, 954, helper.pid), helperGrandchild = handoffProcess(attempt, 955, helperChild.pid);
  const runtime = { launchState: { status: "known", value: attempt.originalState }, binding: { status: "matched", value: attempt.binding },
    profile: { status: "known", dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir } };
  const facts = { ...runtime, caller, helper, processes: [caller, helper, controllerGrandchild, helperGrandchild, helperChild, controllerChild],
    owner: { status: "gone", identity: attempt.helper }, oldMain: { status: "gone", identity: attempt.oldMain }, selectedMain: { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(attempt) } };
  return { owner, attempt, caller, helper, controllerChild, controllerGrandchild, helperChild, helperGrandchild, runtime, facts };
}

test("schema4 ancestry recovery excludes an old row without weakening historical orphan checks", async () => {
  const f = await lifecycleRecoveryFixture(), claimed = await f.owner.beginRecovery(f.attempt, f.facts);
  const runtime = { ...f.runtime, caller: f.helper }, parent = handoffProcess(claimed, 970, f.helper.pid);
  const old = { ...handoffProcess(claimed, 971, parent.pid), created: 1, executable: "", commandLine: "" };
  const observed = await f.owner.observeRecoveryOwned(claimed, { ...runtime, processes: [f.helper, parent, old] });
  assert.ok(observed.recovery!.knownOwned.some(item => item.pid === parent.pid));
  assert.ok(!observed.recovery!.knownOwned.some(item => item.pid === old.pid));
  assert.deepEqual(observed.owned, f.attempt.owned); assert.deepEqual(await f.owner.read(), observed);
  const orphan = { ...old, pid: 973, parentPid: f.controllerChild.pid, created: f.controllerChild.created + 1 };
  await assert.rejects(f.owner.observeRecoveryOwned(observed, { ...runtime, processes: [f.helper, parent, old, orphan] }));
  assert.deepEqual(await f.owner.read(), observed);
});

test("schema4 claim persists complete controller and helper subtrees without granting a main role", async () => {
  const f = await lifecycleRecoveryFixture(), claimed = await f.owner.beginRecovery(f.attempt, f.facts);
  assert.equal(claimed.controlRevision, f.attempt.revision + 1); assert.equal(claimed.recovery!.main, null);
  assert.equal(claimed.recovery!.terminalEvidence, null); assert.equal(claimed.admission, null);
  assert.deepEqual(claimed.recovery!.knownOwned.map(item => item.pid).sort((a, b) => a - b), [952, 953, 954, 955]);
  const { processInstanceKey } = await import("../src/shellProcessInventory.js");
  for (const identity of [f.controllerChild, f.controllerGrandchild, f.helperChild, f.helperGrandchild]) {
    const index = claimed.recovery!.knownOwned.findIndex(item => item.pid === identity.pid);
    const parent = f.facts.processes.find(item => item.pid === identity.parentPid)!;
    assert.deepEqual(claimed.recovery!.knownOwnedLifecycle[index], { key: processInstanceKey(identity), parentKey: processInstanceKey(parent), release: null });
  }
  assert.deepEqual(await f.owner.read(), claimed);
});

test("schema4 bind requires persisted release of the complete controller subtree while helper descendants survive", async () => {
  const f = await lifecycleRecoveryFixture(), claimed = await f.owner.beginRecovery(f.attempt, f.facts);
  const runtime = { ...f.runtime, caller: f.helper };
  const pending = await f.owner.observeRecoveryOwned(claimed, { ...runtime, processes: [f.helper, f.controllerGrandchild, f.helperGrandchild] });
  const main = handoffProcess(pending, 956, f.helper.pid);
  for (const processes of [[f.helper, main, f.controllerGrandchild, f.helperGrandchild], [f.helper, main, f.helperGrandchild]]) {
    await assert.rejects(f.owner.bindRecoveryMain(pending, { ...runtime, processes, main }));
    assert.deepEqual(await f.owner.read(), pending);
  }
  const released = await f.owner.observeRecoveryOwned(pending, { ...runtime, processes: [f.helper, f.helperGrandchild] });
  for (const pid of [952, 953]) {
    const index = released.recovery!.knownOwned.findIndex(item => item.pid === pid);
    assert.equal(released.recovery!.knownOwnedLifecycle[index]!.release!.revision, released.revision);
  }
  for (const revived of [f.controllerChild, f.controllerGrandchild]) await assert.rejects(f.owner.bindRecoveryMain(released,
    { ...runtime, processes: [f.helper, main, f.helperGrandchild, revived], main }));
  const bound = await f.owner.bindRecoveryMain(released, { ...runtime, processes: [f.helper, main, f.helperGrandchild], main });
  assert.deepEqual(bound.recovery!.main, main); assert.deepEqual(bound.recovery!.knownOwnedLifecycle, released.recovery!.knownOwnedLifecycle);
  assert.deepEqual(implementation.shellUpdateOwnedInventory(bound).map(item => item.pid).sort((a, b) => a - b), [954, 955]);
  assert.equal(bound.recovery!.terminalEvidence, null); assert.equal(bound.admission, null);
});

for (const variant of ["older", "older-partial", "same", "newer", "unknown"] as const)
test(`schema4 recovery bind keeps ${variant} controller rows within the instance boundary`, async () => {
  const f = await lifecycleRecoveryFixture(), claimed = await f.owner.beginRecovery(f.attempt, f.facts);
  const runtime = { ...f.runtime, caller: f.helper }, processes = [f.helper, f.helperChild, f.helperGrandchild];
  const released = await f.owner.observeRecoveryOwned(claimed, { ...runtime, processes });
  const main = handoffProcess(released, 956, f.helper.pid);
  const old = { ...handoffProcess(released, 971, f.caller.pid), created: variant.startsWith("older") ? 1
    : variant === "unknown" ? 0 : f.caller.created + (variant === "newer" ? 1 : 0),
    ...(variant === "older-partial" ? { executable: "", commandLine: "" } : {}) };
  const input = { ...runtime, processes: [...processes, main, old], main };
  if (variant.startsWith("older")) {
    const bound = await f.owner.bindRecoveryMain(released, input);
    assert.deepEqual(bound.recovery!.main, main);
    assert.deepEqual(bound.recovery!.knownOwned, released.recovery!.knownOwned);
    assert.deepEqual(bound.recovery!.knownOwnedLifecycle, released.recovery!.knownOwnedLifecycle);
  } else {
    await assert.rejects(f.owner.bindRecoveryMain(released, input));
    assert.deepEqual(await f.owner.read(), released);
  }
});

test("schema4 ancestry claim does not adopt an unknown row before all parent instances", async () => {
  const f = await lifecycleRecoveryFixture(), facts = clone(f.facts);
  facts.processes.find(item => item.pid === f.controllerGrandchild.pid)!.created = f.controllerChild.created - 1;
  const claimed = await f.owner.beginRecovery(f.attempt, facts);
  assert.deepEqual(claimed.recovery!.knownOwned.map(item => item.pid).sort((a, b) => a - b), [952, 954, 955]);
  assert.ok(claimed.recovery!.knownOwnedLifecycle.every(item => item.release === null));
  assert.deepEqual(await f.owner.read(), claimed); assert.deepEqual(claimed.owned, f.attempt.owned);
});

for (const defect of ["partial-child", "helper-parent", "role-conflict", "live-history", "missing-history", "supplied-current"] as const)
test(`schema4 claim rejects ${defect} without modifying the original attempt`, async () => {
  const f = await lifecycleRecoveryFixture(), facts = clone(f.facts);
  if (defect === "partial-child") facts.processes.find(item => item.pid === f.controllerChild.pid)!.executable = "";
  if (defect === "helper-parent") { facts.helper.parentPid = 999; facts.processes = facts.processes.map(item => item.pid === facts.helper.pid ? facts.helper : item); }
  if (defect === "role-conflict") facts.processes.push({ ...f.controllerChild, pid: f.attempt.oldMain.pid });
  if (defect === "live-history") facts.processes.push(f.attempt.helper);
  if (defect === "missing-history") facts.knownOwned.identities = [];
  if (defect === "supplied-current") facts.knownOwned.identities.push(f.controllerChild);
  await assert.rejects(f.owner.beginRecovery(f.attempt, facts)); assert.deepEqual(await f.owner.read(), f.attempt);
});

test("schema4 separates control revision from inventory observations across fresh Node reads", async () => {
  const { owner, attempt, facts, directory } = await lifecycleFixture(), child = handoffProcess(attempt, 811, facts.helper.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: facts.helper, processes: [facts.helper, child] });
  assert.equal(observed.revision, attempt.revision + 1); assert.equal(observed.controlRevision, attempt.controlRevision);
  implementation.assertShellUpdateInventoryExtension(attempt, observed);
  const controlled = await owner.replace(observed, { ...observed, revision: observed.revision + 1, phase: "failed" });
  assert.equal(controlled.schemaVersion, 4);
  assert.equal((controlled as typeof attempt).controlRevision, controlled.revision);
  await assert.rejects(owner.replace(controlled, { ...controlled, revision: controlled.revision + 1, controlRevision: 1 }));
  const script = path.join(directory, "fresh-control.mjs");
  await fs.writeFile(script, `import { createShellUpdateAttemptStore, shellUpdateHandoffRevision } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
const attempt=await createShellUpdateAttemptStore(${JSON.stringify(directory)}).read();
process.stdout.write(JSON.stringify({attempt,control:shellUpdateHandoffRevision(attempt)}));`, "utf8");
  const childProcess = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.ifError(childProcess.error); assert.equal(childProcess.status, 0, childProcess.stderr);
  const reread = JSON.parse(childProcess.stdout); assert.deepEqual(reread.attempt, controlled); assert.equal(reread.control, controlled.revision);
});

test("schema4 ordinary replacement cannot inject or undo releases and extension rejects forged observers", async () => {
  const { owner, attempt, facts } = await lifecycleFixture(), child = handoffProcess(attempt, 812, facts.helper.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: facts.helper, processes: [facts.helper, child] });
  const released = await owner.observeHandoffOwned(observed, { caller: facts.helper, processes: [facts.helper] });
  assert.equal(released.revision, observed.revision + 1); assert.equal(released.controlRevision, observed.controlRevision);
  implementation.assertShellUpdateInventoryExtension(observed, released);
  await assert.rejects(owner.replace(observed, { ...released, revision: observed.revision + 1 }));
  await assert.rejects(owner.replace(released, { ...released, revision: released.revision + 1, ownedLifecycle: observed.ownedLifecycle }));
  const forged = clone(released); forged.ownedLifecycle[0]!.release!.observerKey = "a".repeat(64);
  assert.throws(() => implementation.assertShellUpdateInventoryExtension(observed, forged));
  const wrongRole = clone(released);
  const { processInstanceKey } = await import("../src/shellProcessInventory.js");
  wrongRole.ownedLifecycle[0]!.release!.observerKey = processInstanceKey(facts.oldMain);
  assert.throws(() => implementation.assertShellUpdateInventoryExtension(observed, wrongRole));
  const premature = clone(released); premature.ownedLifecycle[0]!.release!.revision = observed.revision;
  assert.throws(() => implementation.assertShellUpdateInventoryExtension(observed, premature));
});

test("schema4 newly submitted ready rejects a released Client while its historical admission remains readable", async () => {
  const { owner, attempt, facts } = await lifecycleFixture(), main = handoffProcess(attempt, 813, facts.helper.pid, attempt.target.shellId);
  const bound = await owner.replace(attempt, { ...attempt, revision: attempt.revision + 1, selectedMain: main }) as typeof attempt;
  const client = handoffProcess(bound, 814, main.pid, attempt.target.shellId);
  const observed = await owner.observeHandoffOwned(bound, { caller: facts.helper, processes: [facts.helper, main, client] });
  const ready: ShellUpdateReadyEvidence = { role: "candidate", continuationId: attempt.continuationId, main, client, readyRequestId: "active-client-ready",
    health: clone(attempt.binding.health), binding: clone(attempt.binding), launchState: clone(attempt.candidateState),
    profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: attempt.continuationId, admission: "paused" } };
  const intended = await owner.replace(observed, { ...observed, revision: observed.revision + 1, phase: "admission-intent", admission: ready }) as typeof attempt;
  const released = await owner.observeHandoffOwned(intended, { caller: facts.helper, processes: [facts.helper, main] });
  assert.deepEqual((await owner.read() as typeof attempt).admission, ready);
  assert.throws(() => implementation.snapshotShellUpdateReadyEvidence(released, ready, "candidate"));
  await assert.rejects(owner.replace(released, { ...released, revision: released.revision + 1, phase: "completed", terminalEvidence: {
    ready, startedRequestId: "started", continueRequestId: "continued", startup: "completed", application: "started" } }));
});

test("schema4 repeated recovery preserves complete released execution histories", async () => {
  const { owner, attempt } = await lifecycleFixture();
  const failed = await owner.replace(attempt, { ...attempt, revision: attempt.revision + 1, phase: "failed" }) as typeof attempt;
  /** 真实 claim 的历史下界完整保留，模拟当前控制进程及其实际 helper。 */
  function claimFacts(previous: typeof attempt, controllerPid: number) {
    const caller = handoffProcess(previous, controllerPid, 1), helper = handoffProcess(previous, controllerPid + 1, caller.pid);
    return { caller, helper, processes: [caller, helper], owner: { status: "gone", identity: previous.helper }, oldMain: { status: "gone", identity: previous.oldMain },
      selectedMain: { status: "not-started" }, ownedReleased: "verified", launchState: { status: "known", value: clone(previous.originalState) },
      binding: { status: "matched", value: clone(previous.binding) }, profile: { status: "known", dataDir: previous.dataDir, userDataDir: previous.userDataDir, sessionDataDir: previous.sessionDataDir },
      knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(previous) } };
  }
  const facts = claimFacts(failed, 820), claimed = await owner.beginRecovery(failed, facts);
  assert.equal(claimed.controlRevision, failed.revision + 1); assert.equal(claimed.recovery!.claimedFromRevision, failed.revision);
  const main = handoffProcess(claimed, 822, facts.helper.pid), runtime = { caller: facts.helper,
    launchState: facts.launchState, binding: facts.binding, profile: facts.profile };
  const bound = await owner.bindRecoveryMain(claimed, { ...runtime, processes: [facts.helper, main], main });
  const child = handoffProcess(bound, 823, main.pid);
  const observed = await owner.observeRecoveryOwned(bound, { ...runtime, processes: [facts.helper, main, child] });
  const released = await owner.observeRecoveryOwned(observed, { ...runtime, processes: [facts.helper, main] });
  const again = await owner.beginRecovery(released, claimFacts(released, 830));
  assert.deepEqual(again.recoveryHistory, [released.recovery]); assert.deepEqual(again.recovery!.knownOwned, []);
  assert.ok(implementation.shellUpdateProcessHistory(again).some(identity => identity.pid === child.pid));
  assert.ok(!implementation.shellUpdateProcessInventory(again).some(identity => identity.pid === child.pid));
  assert.ok(implementation.shellUpdateProcessInventory(again, false).some(identity => identity.pid === facts.helper.pid));
  assert.ok(!implementation.shellUpdateProcessInventory(again, false).some(identity => identity.pid === again.recovery!.helper.pid));
  assert.throws(() => implementation.assertShellUpdateInventoryReleased(again, [facts.helper], [], false));
  assert.deepEqual(await owner.read(), again);
});

test("schema4 recovery new child may reuse a released ordinary PID from an earlier execution", async () => {
  const { owner, attempt } = await lifecycleFixture(), oldChild = handoffProcess(attempt, 840, attempt.helper.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, oldChild] });
  const released = await owner.observeHandoffOwned(observed, { caller: attempt.helper, processes: [attempt.helper] });
  const failed = await owner.replace(released, { ...released, revision: released.revision + 1, phase: "failed" }) as typeof attempt;
  const caller = handoffProcess(failed, 850, 1), helper = handoffProcess(failed, 851, caller.pid);
  const runtime = { launchState: { status: "known", value: failed.originalState }, binding: { status: "matched", value: failed.binding },
    profile: { status: "known", dataDir: failed.dataDir, userDataDir: failed.userDataDir, sessionDataDir: failed.sessionDataDir } };
  const claimed = await owner.beginRecovery(failed, { ...runtime, caller, helper, processes: [caller, helper],
    owner: { status: "gone", identity: failed.helper }, oldMain: { status: "gone", identity: failed.oldMain }, selectedMain: { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(failed) } });
  const main = handoffProcess(claimed, 852, helper.pid), bound = await owner.bindRecoveryMain(claimed, { ...runtime, caller: helper, processes: [helper, main], main });
  const child = { ...oldChild, parentPid: main.pid, created: main.created + 1, commandLine: "recovery-owned-reuse" };
  const current = await owner.observeRecoveryOwned(bound, { ...runtime, caller: helper, processes: [helper, main, child] });
  assert.deepEqual(current.owned, [oldChild]); assert.deepEqual(current.recovery!.knownOwned, [child]);
  assert.deepEqual(implementation.shellUpdateProcessHistory(current).filter(identity => identity.pid === oldChild.pid), [oldChild, child]);
  assert.deepEqual(implementation.shellUpdateOwnedInventory(current), [child]);
  await assert.rejects(owner.observeRecoveryOwned(current, { ...runtime, caller: helper,
    processes: [helper, main, { ...child, created: child.created + 1 }] }));
  await assert.rejects(owner.observeRecoveryOwned(current, { ...runtime, caller: helper,
    processes: [helper, main, { ...child, pid: attempt.oldMain.pid }] }));
});

test("schema4 keeps bounded history beyond the legacy byte limit and fails explicitly above one MiB", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture();
  const owned = Array.from({ length: 1024 }, (_, index) => handoffProcess(prepared, 2000 + index, facts.helper.pid));
  const attempt = await owner.beginHandoff(prepared, { ...facts, lifecycle: true as const, processes: [facts.oldMain, facts.helper], knownOwned: owned });
  assert.equal(attempt.owned.length, 1024); assert.ok(Buffer.byteLength(JSON.stringify(attempt), "utf8") > 64 * 1024);
  assert.deepEqual(await owner.read(), attempt);
  await assert.rejects(owner.observeHandoffOwned(attempt, { caller: facts.helper,
    processes: [facts.helper, handoffProcess(attempt, 4000, facts.helper.pid)] }), error => {
    assert.ok(causes(error).some(cause => (cause as { code?: string })?.code === "DESKTOP_SHELL_PROCESS_INVENTORY_CAPACITY")); return true;
  });
  assert.deepEqual(await owner.read(), attempt);
  const other = await preparedHandoffFixture(), huge = Array.from({ length: 34 }, (_, index) => ({
    ...handoffProcess(other.prepared, 5000 + index, other.facts.helper.pid), commandLine: "x".repeat(32768) }));
  await assert.rejects(other.owner.beginHandoff(other.prepared, { ...other.facts, lifecycle: true as const,
    processes: [other.facts.oldMain, other.facts.helper], knownOwned: huge }));
  assert.deepEqual(await other.owner.read(), other.prepared);
});

test("schema4 restored original main retains the legacy strict role gate after ordinary history release", async () => {
  const { owner, attempt } = await lifecycleFixture(), main = handoffProcess(attempt, 860, attempt.helper.pid);
  const client = handoffProcess(attempt, 861, main.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, main, client] });
  const ready: ShellUpdateReadyEvidence = { role: "original", continuationId: attempt.continuationId, main, client, readyRequestId: "original-ready",
    health: attempt.binding.health, binding: attempt.binding, launchState: attempt.originalState,
    profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: attempt.continuationId, admission: "paused" } };
  const restored = await owner.replace(observed, { ...observed, revision: observed.revision + 1, phase: "restored", terminalEvidence: {
    ready, startedRequestId: "original-started", continueRequestId: "original-continue", startup: "completed", application: "started" } }) as typeof attempt;
  const released = await owner.observeHandoffOwned(restored, { caller: attempt.helper, processes: [attempt.helper] });
  assert.ok(implementation.shellUpdateProcessInventory(released).some(identity => identity.pid === main.pid));
  assert.doesNotThrow(() => implementation.assertShellUpdateInventoryReleased(restored, [attempt.helper, main, client], [attempt.helper, main, client]));
  const foreign = { ...main, parentPid: 999, created: main.created + 1, commandLine: "foreign-main-reuse" };
  assert.throws(() => implementation.assertShellUpdateInventoryReleased(released, [foreign]));
  await assert.rejects(owner.observeHandoffOwned(released, { caller: attempt.helper, processes: [attempt.helper, foreign] }));
});

for (const variant of ["older", "older-partial", "same", "newer", "unknown", "reused-main"] as const)
test(`schema4 evidence main release keeps ${variant} rows within the instance boundary`, async () => {
  const { owner, attempt } = await lifecycleFixture(), main = handoffProcess(attempt, 860, attempt.helper.pid);
  const client = handoffProcess(attempt, 861, main.pid);
  const observed = await owner.observeHandoffOwned(attempt, { caller: attempt.helper, processes: [attempt.helper, main, client] });
  const ready: ShellUpdateReadyEvidence = { role: "original", continuationId: attempt.continuationId, main, client, readyRequestId: "original-ready",
    health: attempt.binding.health, binding: attempt.binding, launchState: attempt.originalState,
    profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: attempt.continuationId, admission: "paused" } };
  const restored = await owner.replace(observed, { ...observed, revision: observed.revision + 1, phase: "restored", terminalEvidence: {
    ready, startedRequestId: "original-started", continueRequestId: "original-continue", startup: "completed", application: "started" } }) as typeof attempt;
  const released = await owner.observeHandoffOwned(restored, { caller: attempt.helper, processes: [attempt.helper] });
  const old = { ...handoffProcess(released, variant === "reused-main" ? main.pid : 971, main.pid),
    created: variant.startsWith("older") ? 1 : variant === "unknown" ? 0 : main.created + (variant === "same" ? 0 : 1),
    ...(variant === "older-partial" ? { executable: "", commandLine: "" } : {}) };
  const check = () => implementation.assertShellUpdateInventoryReleased(released, [old]);
  if (variant.startsWith("older")) assert.doesNotThrow(check);
  else assert.throws(check);
  assert.deepEqual(await owner.read(), released);
});

for (const direction of ["original", "candidate"] as const) test(`schema4 ${direction} recovery persists prebind query history while controller is alive`, async () => {
  const { owner, attempt } = await lifecycleFixture();
  let previous = attempt;
  if (direction === "candidate") {
    const main = handoffProcess(attempt, 900, attempt.helper.pid, attempt.target.shellId);
    previous = await owner.replace(previous, { ...previous, revision: previous.revision + 1, selectedMain: main }) as typeof attempt;
    const client = handoffProcess(previous, 901, main.pid, attempt.target.shellId);
    previous = await owner.observeHandoffOwned(previous, { caller: attempt.helper, processes: [attempt.helper, main, client] });
    const ready: ShellUpdateReadyEvidence = { role: "candidate", continuationId: attempt.continuationId, main, client, readyRequestId: "prebind-ready",
      health: attempt.binding.health, binding: attempt.binding, launchState: attempt.candidateState,
      profile: { dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, mainFrame: "loaded",
      startup: { continuationId: attempt.continuationId, admission: "paused" } };
    previous = await owner.replace(previous, { ...previous, revision: previous.revision + 1, phase: "admission-intent", admission: ready }) as typeof attempt;
  }
  previous = await owner.replace(previous, { ...previous, revision: previous.revision + 1, phase: "failed" }) as typeof attempt;
  const caller = handoffProcess(previous, 910, 1, direction === "candidate" ? attempt.target.shellId : attempt.originalState.activeShellId);
  const helper = handoffProcess(previous, 911, caller.pid, direction === "candidate" ? attempt.target.shellId : attempt.originalState.activeShellId);
  const runtime = { launchState: { status: "known", value: attempt.candidateState }, binding: { status: "matched", value: attempt.binding },
    profile: { status: "known", dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir } };
  const claimed = await owner.beginRecovery(previous, { ...runtime, caller, helper, processes: [caller, helper],
    owner: { status: "gone", identity: attempt.helper }, oldMain: { status: "gone", identity: attempt.oldMain },
    selectedMain: previous.selectedMain ? { status: "gone", identity: previous.selectedMain } : { status: "not-started" },
    ownedReleased: "verified", knownOwned: { status: "known", identities: implementation.shellUpdateProcessHistory(previous) } });
  const query = handoffProcess(claimed, 920, helper.pid), console = handoffProcess(claimed, 921, query.pid);
  const observed = await owner.observeRecoveryOwned(claimed, { ...runtime, caller: helper, processes: [caller, helper, query, console] });
  assert.deepEqual(observed.recovery!.knownOwned, [query, console]); assert.equal(observed.recovery!.main, null);
  assert.equal(observed.controlRevision, claimed.controlRevision); assert.equal(observed.revision, claimed.revision + 1);
  assert.deepEqual(await owner.read(), observed);
  if (direction === "candidate") await assert.rejects(owner.observeRecoveryOwned(observed, { ...runtime, caller: helper,
    launchState: { status: "known", value: attempt.originalState }, processes: [caller, helper, query, console] }));
  const pending = await owner.observeRecoveryOwned(observed, { ...runtime, caller: helper, processes: [caller, helper, console] });
  assert.ok(pending.recovery!.knownOwnedLifecycle.every(item => item.release === null));
  await assert.rejects(owner.observeRecoveryOwned(pending, { ...runtime, caller: helper,
    processes: [{ ...caller, created: caller.created + 1 }, helper, console] }));
  const main = handoffProcess(pending, 930, helper.pid, direction === "candidate" ? attempt.target.shellId : attempt.originalState.activeShellId);
  const bindRuntime = { ...runtime, launchState: { status: "known", value: direction === "candidate" ? attempt.candidateState : attempt.originalState } };
  await assert.rejects(owner.bindRecoveryMain(pending, { ...bindRuntime, caller: helper, processes: [caller, helper, main, console], main }));
  const bound = await owner.bindRecoveryMain(pending, { ...bindRuntime, caller: helper, processes: [helper, main, console], main });
  assert.deepEqual(bound.recovery!.knownOwned, [query, console]); assert.deepEqual(bound.recovery!.knownOwnedLifecycle, pending.recovery!.knownOwnedLifecycle);
  assert.equal(bound.controlRevision, bound.revision);
  if (direction === "original") await assert.rejects(owner.observeRecoveryOwned(bound, { ...runtime, caller: helper, processes: [helper, main, console] }));
  const released = await owner.observeRecoveryOwned(bound, { ...bindRuntime, caller: helper, processes: [helper, main] });
  assert.ok(released.recovery!.knownOwnedLifecycle.every(item => item.release?.revision === released.revision));
  assert.deepEqual(implementation.shellUpdateOwnedInventory(released), []);
});

/** 授权动作固定于开启动作前的真实revision，恢复沿已保存键不生成另一动作。 */
function switchAction(revision: number): UpdateNetworkAction<string> {
  return { actionKey: `shell-authorize:${revision}`, requestSha256: "f".repeat(64),
    async persistResult() { return { kind: "shell-switch-authorization", sha256: "a".repeat(64) }; },
    async recoverResult() { return { status: "unknown" }; } };
}

test("schema3 handoff authorization shares the same durable budget and fails before a fourth reservation", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture();
  const handoff = await owner.beginHandoff(prepared, facts), durable = createShellUpdateAttemptNetworkAdapter(owner);
  let calls = 0; const reports: number[] = [], action = switchAction(handoff.revision);
  const transient = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry(event) { reports.push(event.retry); } });
  assert.equal(await retry.run(async () => { calls++; const disk = await owner.read() as ShellUpdateAttemptV3;
    assert.equal(disk.network.status, "dispatching"); if (calls === 1) throw transient; return "permitted";
  }, action), "permitted");
  assert.equal(calls, 2); assert.deepEqual(reports, [3]);
  const saved = await owner.read() as ShellUpdateAttemptV3;
  for (const field of ["originalState", "candidateState", "binding", "target", "oldMain", "helper", "continuationId", "requestId", "dataDir"] as const) assert.deepEqual(saved[field], handoff[field]);
  assert.equal(saved.retriesUsed, 3); assert.equal(saved.network.status, "succeeded");
  await assert.rejects(retry.run(async () => { calls++; throw transient; }, switchAction(saved.revision)), error => error === transient);
  const failed = await owner.read() as ShellUpdateAttemptV3; assert.equal(failed.phase, "failed"); assert.equal(failed.network.status, "failed");
  assert.equal(failed.retriesUsed, 3); assert.equal(failed.admission, null); assert.equal(calls, 3);
  await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, switchAction(failed.revision))); assert.equal(calls, 3);
});

test("a recovered schema3 dispatching authorization remains unknown and never replays", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture();
  const handoff = await owner.beginHandoff(prepared, facts), durable = createShellUpdateAttemptNetworkAdapter(owner), action = switchAction(handoff.revision);
  await durable.replace(await durable.read(), { retriesUsed: handoff.retriesUsed, network: { actionKey: action.actionKey, requestSha256: action.requestSha256, status: "dispatching" } });
  let calls = 0;
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, action), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
  assert.equal(calls, 0); assert.equal((await durable.read()).retriesUsed, handoff.retriesUsed);
});

test("schema3 handoff rejects every noncanonical or stale authorization action before send", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), handoff = await owner.beginHandoff(prepared, facts);
  const durable = createShellUpdateAttemptNetworkAdapter(owner), retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  let calls = 0;
  for (const actionKey of ["shell-register", "shell-discover", "shell-installer", "shell-authorize", "shell-authorize:", "shell-authorize:01",
    "shell-authorize:-1", "shell-authorize:1.5", "shell-authorize:9007199254740992", "shell-authorize:99999999999999999",
    `shell-authorize:${handoff.revision + 1}`, `shell-authorize:${handoff.revision - 1}`, `shell-authorize:${handoff.revision}:extra`, `other-shell-authorize:${handoff.revision}`]) {
    await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, { ...switchAction(handoff.revision), actionKey }));
    await assert.rejects(owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, network: { actionKey, requestSha256: "f".repeat(64), status: "dispatching" } }));
    assert.deepEqual(await owner.read(), handoff);
  }
  assert.equal(calls, 0);
});

test("schema3 authorization cannot change request materials, evidence kind or spend budget twice", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), handoff = await owner.beginHandoff(prepared, facts);
  const adapter = createShellUpdateAttemptNetworkAdapter(owner), action = switchAction(handoff.revision);
  const dispatching = { actionKey: action.actionKey, requestSha256: action.requestSha256, status: "dispatching" as const };
  const dispatched = await adapter.replace(await adapter.read(), { retriesUsed: 2, network: dispatching });
  for (const next of [{ retriesUsed: 3, network: dispatching }, { retriesUsed: 1, network: dispatching },
    { retriesUsed: 2, network: { ...dispatching, requestSha256: "a".repeat(64) } },
    { retriesUsed: 2, network: { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "a".repeat(64) } } }]) {
    await assert.rejects(adapter.replace(dispatched, next as never));
  }
  const waiting = await adapter.replace(dispatched, { retriesUsed: 3, network: { ...dispatching, status: "waiting", delayMs: 0, notBefore: 0 } });
  await assert.rejects(adapter.replace(waiting, { retriesUsed: 3, network: { ...dispatching, status: "waiting", delayMs: 1, notBefore: 0 } }));
  await assert.rejects(adapter.replace(waiting, { retriesUsed: 3, network: { ...dispatching, actionKey: `shell-authorize:${waiting.revision}` } }));
  const consumed = await adapter.replace(waiting, { retriesUsed: 3, network: dispatching });
  assert.equal(consumed.retriesUsed, 3);
});

test("selected or admitted schema3 phases cannot start another authorization", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready });
  const terminalEvidence = { ready, startedRequestId: "main-started", continueRequestId: "continue", startup: "completed", application: "started" };
  const completed = await owner.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence });
  for (const attempt of [bound, intended, completed]) {
    const adapter = createShellUpdateAttemptNetworkAdapter({ ...owner, async read() { return clone(attempt); } });
    let calls = 0;
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: adapter, onRetry() { assert.fail(); } });
    await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, switchAction(attempt.revision)), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
    assert.equal(calls, 0);
  }
});

test("failed authorization retains its slot while sufficient original recovery settles restored", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), handoff = await owner.beginHandoff(prepared, facts);
  const adapter = createShellUpdateAttemptNetworkAdapter(owner), action = switchAction(handoff.revision);
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: adapter, onRetry() { assert.fail(); } });
  const error = new Error("qualification revoked");
  await assert.rejects(retry.run(async () => { throw error; }, action), cause => cause === error);
  const failed = await owner.read() as ShellUpdateAttemptV3;
  const ready: ShellUpdateReadyEvidence = { role: "original", continuationId: failed.continuationId, main: failed.oldMain,
    client: handoffProcess(failed, 105, failed.oldMain.pid), readyRequestId: "original-ready", health: failed.binding.health, binding: failed.binding,
    launchState: failed.originalState, profile: { dataDir: failed.dataDir, userDataDir: failed.userDataDir, sessionDataDir: failed.sessionDataDir },
    mainFrame: "loaded", startup: { continuationId: failed.continuationId, admission: "paused" } };
  const restored = await owner.replace(failed, { ...failed, revision: failed.revision + 1, phase: "restored", terminalEvidence: {
    ready, startedRequestId: "restored-started", continueRequestId: "restored-continue", startup: "completed", application: "started" } }) as ShellUpdateAttemptV3;
  assert.deepEqual(restored.network, failed.network); assert.equal(restored.retriesUsed, failed.retriesUsed);
  await assert.rejects(createShellUpdateAttemptNetworkAdapter(owner).read(), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
});

test("fresh processes consume only the saved schema3 waiting reservation and never replay an unknown authorization", async () => {
  for (const waiting of [false, true]) {
    const { directory, owner, prepared, facts } = await preparedHandoffFixture(), handoff = await owner.beginHandoff(prepared, facts);
    const adapter = createShellUpdateAttemptNetworkAdapter(owner), action = switchAction(handoff.revision);
    const identity = { actionKey: action.actionKey, requestSha256: action.requestSha256 };
    await adapter.replace(await adapter.read(), { retriesUsed: 2, network: { ...identity, status: "dispatching" } });
    if (waiting) await adapter.replace(await adapter.read(), { retriesUsed: 3, network: { ...identity, status: "waiting", delayMs: 0, notBefore: 0 } });
    const script = path.join(root, `handoff-network-${crypto.randomUUID()}.mjs`), temporary = await fs.mkdtemp(path.join(root, "handoff-network-temp-"));
    await fs.writeFile(script, `import assert from 'node:assert/strict';
      import { createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
      import { createUpdateNetworkRetry } from ${JSON.stringify(new URL("../src/updateNetworkRetry.ts", import.meta.url).href)};
      const owner = createShellUpdateAttemptStore(${JSON.stringify(directory)}), durable = createShellUpdateAttemptNetworkAdapter(owner);
      let calls=0,reports=0,code;
      const action={...${JSON.stringify(identity)},async persistResult(){return {kind:'shell-switch-authorization',sha256:'a'.repeat(64)};},async recoverResult(){return {status:'unknown'};}};
      const retry=createUpdateNetworkRetry({signal:new AbortController().signal,durable,onRetry(){reports++;}});
      try { await retry.run(async()=>{calls++;const state=await durable.read();assert.equal(state.network.status,'dispatching');assert.equal(state.retriesUsed,3);return 'ack';},action); }
      catch(error){if(error.code!=='DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN')throw error;code=error.code;}
      console.log(JSON.stringify({calls,reports,code,state:await owner.read()}));`, "utf8");
    const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15000,
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
    await fs.writeFile(script + ".stdout.log", child.stdout ?? "", "utf8"); await fs.writeFile(script + ".stderr.log", child.stderr ?? "", "utf8");
    await fs.writeFile(script + ".process.json", JSON.stringify({ pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message ?? null }), "utf8");
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout); assert.equal(result.calls, waiting ? 1 : 0); assert.equal(result.reports, 0);
    assert.equal(result.state.retriesUsed, waiting ? 3 : 2); assert.equal(result.state.network.status, waiting ? "succeeded" : "dispatching");
    assert.deepEqual(result.state.oldMain, handoff.oldMain); assert.deepEqual(result.state.helper, handoff.helper);
  }
});

/** 已记录的真实候选只可绑定一次；ready只构造原门禁已核实的事实。 */
async function boundHandoffFixture() {
  const item = await preparedHandoffFixture();
  const handoff = await item.owner.beginHandoff(item.prepared, item.facts);
  const selectedMain = handoffProcess(handoff, 103, handoff.helper.pid, handoff.target.shellId);
  const bound = await item.owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, selectedMain }) as ShellUpdateAttemptV3;
  const ready: ShellUpdateReadyEvidence = { role: "candidate", continuationId: bound.continuationId, main: selectedMain,
    client: handoffProcess(bound, 104, selectedMain.pid, bound.target.shellId), readyRequestId: "client-ready-request", health: clone(bound.binding.health),
    binding: clone(bound.binding), launchState: clone(bound.candidateState),
    profile: { dataDir: bound.dataDir, userDataDir: bound.userDataDir, sessionDataDir: bound.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: bound.continuationId, admission: "paused" } };
  return { ...item, handoff, bound, ready };
}

test("strict ready snapshot accepts complete original and candidate evidence without changing the attempt", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const entry = (implementation as Record<string, unknown>).snapshotShellUpdateReadyEvidence;
  assert.equal(typeof entry, "function", "snapshotShellUpdateReadyEvidence must validate held ready before permit");
  const snapshot = entry as (attempt: unknown, evidence: unknown, role: "original" | "candidate") => ShellUpdateReadyEvidence;
  const original: ShellUpdateReadyEvidence = { ...clone(ready), role: "original", main: clone(bound.oldMain),
    client: handoffProcess(bound, 105, bound.oldMain.pid), launchState: clone(bound.originalState) };
  const result = snapshot(bound, original, "original");
  assert.deepEqual(result, original);
  assert.deepEqual(snapshot(bound, ready, "candidate"), ready);
  result.profile.userDataDir = path.join(bound.dataDir, "changed-result");
  result.health.dbSchemaVersion++;
  assert.equal(original.profile.userDataDir, bound.userDataDir);
  assert.deepEqual(original.health, bound.binding.health);
  assert.deepEqual(await owner.read(), bound);
});

test("strict ready snapshot rejects foreign original profile health and Client parent before permit", async t => {
  const { bound, ready } = await boundHandoffFixture();
  const original: ShellUpdateReadyEvidence = { ...clone(ready), role: "original", main: clone(bound.oldMain),
    client: handoffProcess(bound, 105, bound.oldMain.pid), launchState: clone(bound.originalState) };
  for (const [name, changes] of [
    ["profile", { profile: { ...original.profile, userDataDir: path.join(bound.dataDir, "foreign-profile") } }],
    ["health", { health: { ...original.health, dbSchemaVersion: original.health.dbSchemaVersion + 1 } }],
    ["Client parent", { client: { ...original.client, parentPid: bound.helper.pid } }],
  ] as const) await t.test(name, () => {
    const entry = (implementation as Record<string, unknown>).snapshotShellUpdateReadyEvidence;
    assert.equal(typeof entry, "function", "snapshotShellUpdateReadyEvidence must validate held ready before permit");
    const snapshot = entry as (attempt: unknown, evidence: unknown, role: "original" | "candidate") => ShellUpdateReadyEvidence;
    assert.throws(() => snapshot(bound, { ...original, ...changes }, "original"));
  });
});

/** 纯判定输入明确区分同实例已退出与未知，不能以空值猜测释放。 */
function recoveryFacts(attempt: ShellUpdateAttemptV3): ShellUpdateRecoveryFacts {
  return { caller: clone(attempt.helper), owner: { status: "alive", identity: clone(attempt.helper) },
    oldMain: { status: "gone", identity: clone(attempt.oldMain) },
    selectedMain: attempt.selectedMain === null ? { status: "not-started" } : { status: "gone", identity: clone(attempt.selectedMain) },
    launchState: { status: "known", value: clone(attempt.candidateState) }, binding: { status: "matched", value: clone(attempt.binding) },
    profile: { status: "known", dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir }, ownedReleased: "verified" };
}

type RecoveryAttempt = ShellUpdateAttemptV3 & { recovery: {
  controller: ProcessIdentity; helper: ProcessIdentity; main: ProcessIdentity | null; direction: "original" | "candidate";
  claimedFromRevision: number; knownOwned: ProcessIdentity[]; terminalEvidence: { ready: ShellUpdateReadyEvidence } | null;
} };

/** 缺少显式恢复入口即合同RED，不用普通replace伪造恢复事实。 */
function recoveryMethods(owner: ShellUpdateAttemptStore) {
  for (const key of ["beginRecovery", "bindRecoveryMain", "observeRecoveryOwned", "completeRecovery"]) assert.equal(typeof (owner as unknown as Record<string, unknown>)[key], "function", `${key} must exist`);
  return owner as unknown as Record<"beginRecovery" | "bindRecoveryMain" | "observeRecoveryOwned" | "completeRecovery", (expected: unknown, facts: unknown) => Promise<RecoveryAttempt>>;
}

/** 明确声明完整已知库存；未知/缺库存不替换为空，实际系统查询仍归运行时边界。 */
async function recoveryFixture(admitted = false) {
  const item = await boundHandoffFixture(), { owner, bound, ready } = item;
  const previous = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: admitted ? "admission-intent" : "failed",
    admission: admitted ? ready : null }) as ShellUpdateAttemptV3;
  const caller = handoffProcess(previous, 201, 1, previous.target.shellId), helper = handoffProcess(previous, 202, caller.pid, previous.target.shellId);
  const facts = { ...recoveryFacts(previous), caller, owner: { status: "gone" as const, identity: previous.helper },
    helper, processes: [caller, helper], knownOwned: { status: "known", identities: [previous.oldMain, previous.helper, previous.selectedMain!, ready.client] } };
  return { ...item, previous, facts, methods: recoveryMethods(owner) };
}

/** 新main必须是当前恢复helper真实子实例，状态由历史唯一admission方向决定。 */
function recoveryRuntime(attempt: RecoveryAttempt, main?: ProcessIdentity) {
  return { caller: clone(attempt.recovery.helper), processes: [clone(attempt.recovery.helper), ...(main ? [clone(main)] : [])],
    launchState: { status: "known", value: clone(attempt.recovery.direction === "candidate" ? attempt.candidateState : attempt.originalState) },
    binding: { status: "matched", value: clone(attempt.binding) },
    profile: { status: "known", dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir } };
}

test("explicit recovery preserves all historical authorization and budget while binding one new original main", async () => {
  const { owner, previous, facts, methods } = await recoveryFixture();
  const claimed = await methods.beginRecovery(previous, facts);
  assert.deepEqual(claimed, { ...previous, revision: previous.revision + 1, recovery: { controller: facts.caller, helper: facts.helper,
    main: null, direction: "original", claimedFromRevision: previous.revision, knownOwned: [], terminalEvidence: null } });
  await assert.rejects(owner.replace(claimed, { ...claimed, revision: claimed.revision + 1, recovery: null }));
  await assert.rejects(owner.replace(claimed, { ...claimed, revision: claimed.revision + 1, helper: facts.helper }));
  const main = handoffProcess(claimed, 203, facts.helper.pid), runtime = recoveryRuntime(claimed, main);
  const bound = await methods.bindRecoveryMain(claimed, { ...runtime, main });
  assert.deepEqual(bound.recovery.main, main); assert.deepEqual(bound.helper, previous.helper); assert.deepEqual(bound.selectedMain, previous.selectedMain);
  await assert.rejects(methods.bindRecoveryMain(bound, { ...runtime, main }));
  await assert.rejects(createShellUpdateAttemptNetworkAdapter(owner).read(), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
});

for (const shell of ["original", "candidate"] as const) test(`original restoration claim accepts a ${shell} controller without changing durable history`, async () => {
  const { previous, facts, methods } = await recoveryFixture();
  const caller = handoffProcess(previous, 201, 1, shell === "original" ? previous.originalState.activeShellId : previous.target.shellId);
  const helper = { ...facts.helper, executable: caller.executable };
  const claimed = await methods.beginRecovery(previous, { ...facts, caller, helper, processes: [caller, helper] });
  assert.deepEqual(claimed, { ...previous, revision: previous.revision + 1, recovery: { controller: caller, helper, main: null,
    direction: "original", claimedFromRevision: previous.revision, knownOwned: [], terminalEvidence: null } });
});

test("original restoration claim rejects original controller after admission and rejects unrelated shell controllers", async () => {
  for (const admitted of [false, true]) {
    const { directory, previous, facts, methods } = await recoveryFixture(admitted), before = await fs.readFile(path.join(directory, filename));
    for (const shell of ["unrelated", ...(admitted ? [previous.originalState.activeShellId] : [])]) {
      const caller = handoffProcess(previous, 201, 1, shell), helper = { ...facts.helper, executable: caller.executable };
      await assert.rejects(methods.beginRecovery(previous, { ...facts, caller, helper, processes: [caller, helper] }));
    }
    assert.deepEqual(await fs.readFile(path.join(directory, filename)), before);
  }
});

test("explicit recovery rejects alive unknown missing inventory and changed runtime facts without writing", async () => {
  const { directory, owner, previous, facts, methods } = await recoveryFixture();
  const before = await fs.readFile(path.join(directory, filename));
  for (const changes of [
    { owner: { status: "alive", identity: previous.helper }, processes: [...facts.processes, previous.helper] },
    { owner: { status: "unknown" } }, { knownOwned: { status: "unknown" } }, { knownOwned: { status: "known", identities: [] } },
    { processes: [...facts.processes, { ...previous.helper, created: previous.helper.created + 1 }] },
    { processes: [...facts.processes, handoffProcess(previous, 301, previous.selectedMain!.pid)] },
    { processes: [...facts.processes, handoffProcess(previous, 302, facts.caller.pid)] },
    { processes: [...facts.processes, handoffProcess(previous, 303, facts.helper.pid)] },
    { processes: [...facts.processes, facts.knownOwned.identities.at(-1)!] },
    { binding: { status: "unknown" } }, { binding: { status: "matched", value: { ...previous.binding, health: { ...previous.binding.health, dbSchemaVersion: 99 } } } },
    { profile: { ...facts.profile, userDataDir: path.join(previous.dataDir, "foreign") } },
    { launchState: { status: "known", value: { ...previous.candidateState, previousShellId: null } } },
    { helper: { ...facts.helper, parentPid: 1 } }, { ownedReleased: "unknown" },
  ]) await assert.rejects(methods.beginRecovery(previous, { ...facts, ...changes }));
  assert.deepEqual(await owner.read(), previous); assert.deepEqual(await fs.readFile(path.join(directory, filename)), before);
});

test("explicit recovery inventory is monotone attributable and writes only changed identities with current expected", async () => {
  const { directory, owner, previous, facts, methods } = await recoveryFixture();
  const claimed = await methods.beginRecovery(previous, facts), main = handoffProcess(claimed, 203, facts.helper.pid);
  const bound = await methods.bindRecoveryMain(claimed, { ...recoveryRuntime(claimed, main), main });
  const runtime = recoveryRuntime(bound, main), before = await fs.stat(path.join(directory, filename), { bigint: true });
  assert.deepEqual(await methods.observeRecoveryOwned(bound, runtime), bound);
  assert.equal((await fs.stat(path.join(directory, filename), { bigint: true })).mtimeNs, before.mtimeNs);
  const client = handoffProcess(bound, 204, main.pid), unrelated = handoffProcess(bound, 999, 1);
  const observed = await methods.observeRecoveryOwned(bound, { ...runtime, processes: [...runtime.processes, client, unrelated] });
  assert.deepEqual(observed.recovery.knownOwned, [client]); assert.equal(observed.revision, bound.revision + 1);
  await assert.rejects(methods.observeRecoveryOwned(bound, runtime));
  assert.deepEqual((await methods.observeRecoveryOwned(observed, runtime)).recovery.knownOwned, [client]);
  await assert.rejects(methods.observeRecoveryOwned(observed, { ...runtime, processes: [...runtime.processes, { ...client, created: client.created + 1 }] }));
  await assert.rejects(methods.observeRecoveryOwned(observed, { ...runtime, processes: [observed.recovery.helper, handoffProcess(observed, 205, main.pid)] }));
  assert.deepEqual(await owner.read(), observed);
});

test("explicit recovery completion validates current held ready while retaining committed admission", async () => {
  const { owner, previous, facts, methods } = await recoveryFixture(true);
  const claimed = await methods.beginRecovery(previous, facts), main = handoffProcess(claimed, 203, facts.helper.pid, claimed.target.shellId);
  const bound = await methods.bindRecoveryMain(claimed, { ...recoveryRuntime(claimed, main), main });
  const client = handoffProcess(bound, 204, main.pid, bound.target.shellId), runtime = recoveryRuntime(bound, main);
  const observed = await methods.observeRecoveryOwned(bound, { ...runtime, processes: [...runtime.processes, client] });
  const ready: ShellUpdateReadyEvidence = { ...clone(previous.admission!), main, client };
  const snapshot = (implementation as Record<string, unknown>).snapshotShellUpdateReadyEvidence as (attempt: unknown, evidence: unknown, role: "original" | "candidate") => ShellUpdateReadyEvidence;
  assert.deepEqual(snapshot(observed, ready, "candidate"), ready);
  assert.throws(() => snapshot(observed, previous.admission, "candidate"));
  const evidence = { ready, startedRequestId: "recovery-started", continueRequestId: "recovery-continue", startup: "completed", application: "started" };
  await assert.rejects(methods.completeRecovery(bound, evidence));
  for (const changes of [{ startup: "unknown" }, { application: "starting" }, { continueRequestId: "" },
    { ready: { ...ready, client: { ...client, parentPid: previous.helper.pid } } }, { ready: { ...ready, health: { ...ready.health, dbSchemaVersion: 99 } } },
    { ready: { ...ready, profile: { ...ready.profile, sessionDataDir: path.join(previous.dataDir, "foreign") } } },
    { ready: { ...ready, role: "original", launchState: previous.originalState } }]) await assert.rejects(methods.completeRecovery(observed, { ...evidence, ...changes }));
  const complete = await methods.completeRecovery(observed, evidence);
  assert.deepEqual(complete.recovery.terminalEvidence, evidence); assert.deepEqual(complete.admission, previous.admission);
  assert.equal(complete.phase, previous.phase); assert.equal(complete.retriesUsed, previous.retriesUsed); assert.deepEqual(complete.network, previous.network);
  await assert.rejects(methods.completeRecovery(complete, evidence));
  assert.deepEqual(await owner.read(), complete);
});

test("explicit recovery rejects invalid new main and oversized inventory without truncating or writing", async () => {
  const { directory, owner, previous, facts, methods } = await recoveryFixture();
  const claimed = await methods.beginRecovery(previous, facts), main = handoffProcess(claimed, 203, facts.helper.pid), runtime = recoveryRuntime(claimed, main);
  for (const changes of [{ parentPid: previous.helper.pid }, { executable: facts.helper.executable }, { created: facts.helper.created - 1 }]) {
    const invalid = { ...main, ...changes };
    await assert.rejects(methods.bindRecoveryMain(claimed, { ...runtime, main: invalid, processes: [facts.helper, invalid] }));
  }
  await assert.rejects(methods.bindRecoveryMain(claimed, { ...runtime, main, processes: [...runtime.processes, facts.caller] }));
  const bound = await methods.bindRecoveryMain(claimed, { ...runtime, main }), before = await fs.readFile(path.join(directory, filename));
  const children = Array.from({ length: 20 }, (_, index) => ({ ...handoffProcess(bound, 500 + index, main.pid), commandLine: "x".repeat(4000) }));
  await assert.rejects(methods.observeRecoveryOwned(bound, { ...recoveryRuntime(bound, main), processes: [facts.helper, main, ...children] }));
  assert.deepEqual(await owner.read(), bound); assert.deepEqual(await fs.readFile(path.join(directory, filename)), before);
});

test("explicit recovery reentry releases the previous owner inventory and preserves failed network budget", async () => {
  const { owner, previous, facts, methods } = await recoveryFixture();
  const claimed = await methods.beginRecovery(previous, facts), main = handoffProcess(claimed, 203, facts.helper.pid);
  const bound = await methods.bindRecoveryMain(claimed, { ...recoveryRuntime(claimed, main), main });
  const client = handoffProcess(bound, 204, main.pid), runtime = recoveryRuntime(bound, main);
  const observed = await methods.observeRecoveryOwned(bound, { ...runtime, processes: [...runtime.processes, client] });
  const caller = handoffProcess(observed, 401, 1), helper = handoffProcess(observed, 402, caller.pid);
  const retryFacts = { ...facts, caller, helper, processes: [caller, helper], launchState: { status: "known", value: observed.originalState },
    knownOwned: { status: "known", identities: [...facts.knownOwned.identities, observed.recovery.controller, observed.recovery.helper, main, client] } };
  await assert.rejects(methods.beginRecovery(observed, { ...retryFacts, processes: [...retryFacts.processes, observed.recovery.helper] }));
  await assert.rejects(methods.beginRecovery(observed, { ...retryFacts, knownOwned: facts.knownOwned }));
  const again = await methods.beginRecovery(observed, retryFacts);
  assert.equal(again.recovery.claimedFromRevision, observed.revision); assert.deepEqual(again.recovery.knownOwned, []);
  assert.deepEqual(again.helper, previous.helper); assert.deepEqual(again.admission, previous.admission);
  assert.equal(again.retriesUsed, previous.retriesUsed); assert.deepEqual(again.network, previous.network);
  const decide = (implementation as Record<string, unknown>).decideShellUpdateRecovery as (attempt: unknown, facts: unknown) => { action: string; reason: string };
  assert.deepEqual(decide(again, recoveryFacts(again)), { action: "stop", reason: "current-recovery-requires-control" });
});

test("explicit recovery persists original completion across a fresh Node process without rewriting historical terminal", async () => {
  const { directory, owner, previous, facts, methods, ready: historicalReady } = await recoveryFixture();
  const original: ShellUpdateReadyEvidence = { ...clone(historicalReady), role: "original", main: previous.oldMain,
    client: handoffProcess(previous, 106, previous.oldMain.pid), launchState: previous.originalState };
  const terminal = { ready: original, startedRequestId: "historical-started", continueRequestId: "historical-continue", startup: "completed", application: "started" };
  const restored = await owner.replace(previous, { ...previous, revision: previous.revision + 1, phase: "restored", terminalEvidence: terminal }) as ShellUpdateAttemptV3;
  const claimed = await methods.beginRecovery(restored, { ...facts, knownOwned: { status: "known", identities: [...facts.knownOwned.identities, original.client] } });
  const main = handoffProcess(claimed, 203, facts.helper.pid), bound = await methods.bindRecoveryMain(claimed, { ...recoveryRuntime(claimed, main), main });
  const client = handoffProcess(bound, 204, main.pid), runtime = recoveryRuntime(bound, main);
  const observed = await methods.observeRecoveryOwned(bound, { ...runtime, processes: [...runtime.processes, client] });
  const ready = { ...original, main, client }, complete = await methods.completeRecovery(observed, { ...terminal, ready, startedRequestId: "new-started" });
  assert.deepEqual(complete.terminalEvidence, terminal); assert.notDeepEqual(complete.recovery.terminalEvidence, terminal);
  const script = path.join(root, "recovery-readback.mjs"), stdout = path.join(root, "recovery-readback.stdout.log"), stderr = path.join(root, "recovery-readback.stderr.log");
  await fs.writeFile(script, `import { createShellUpdateAttemptStore } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
const attempt = await createShellUpdateAttemptStore(${JSON.stringify(directory)}).read();
if (attempt?.schemaVersion !== 3 || attempt.recovery?.terminalEvidence?.startedRequestId !== "new-started" || attempt.terminalEvidence?.startedRequestId !== "historical-started") throw new Error("recovery readback mismatch");
process.stdout.write(JSON.stringify({ pid: process.pid, parentPid: process.ppid, attempt }));\n`, "utf8");
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000, env: { ...process.env } });
  await fs.writeFile(stdout, child.stdout ?? "", "utf8"); await fs.writeFile(stderr, child.stderr ?? "", "utf8");
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).attempt, complete);
});

test("explicit recovery rejects hostile descriptors and snapshots inputs before await", async t => {
  const { owner, previous, facts, methods } = await recoveryFixture();
  let getters = 0, io = 0;
  const accessor = clone(facts); Object.defineProperty(accessor.helper, "pid", { get() { getters++; return 202; } });
  const array = clone(facts.processes); Object.defineProperty(array, 0, { get() { getters++; return facts.caller; } });
  const mock = t.mock.method(fs, "realpath", async () => { io++; assert.fail("invalid recovery must fail before IO"); });
  for (const invalid of [null, {}, Object.create(facts), { ...facts, extra: true }, accessor, { ...facts, processes: array },
    { ...facts, processes: [...facts.processes, facts.helper] }, { ...facts, knownOwned: { status: "known", identities: [facts.caller] } }]) await assert.rejects(methods.beginRecovery(previous, invalid));
  assert.equal(io, 0); assert.equal(getters, 0); mock.mock.restore();
  const expected = clone(previous), input = clone(facts), pending = methods.beginRecovery(expected, input);
  expected.binding.health.dbSchemaVersion = 99; input.helper.created++; input.processes.length = 0;
  const claimed = await pending; assert.equal(claimed.binding.health.dbSchemaVersion, previous.binding.health.dbSchemaVersion);
  assert.deepEqual(claimed.recovery.helper, facts.helper);
});

test("explicit recovery preserves undefined storage primary and close cleanup causes", async t => {
  const { directory, owner, previous, facts, methods } = await recoveryFixture();
  const nativeOpen = fs.open, closeCause = new Error("recovery-close-failed");
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "write", async () => { throw undefined; });
      t.mock.method(handle, "close", async () => { await close(); throw closeCause; });
    }
    return handle;
  });
  await assert.rejects(methods.beginRecovery(previous, facts), error => {
    failure(error, "REPLACE", "write-temp"); assert.ok(causes(error).includes(undefined)); assert.ok(causes(error).includes(closeCause)); return true;
  });
  mock.mock.restore(); await poisonedSnapshot(owner, directory, previous);
  const remaining = (await fs.readdir(directory)).filter(name => name.endsWith(".tmp")); assert.equal(remaining.length, 1);
});

/** 新周期只复制实际稳定上下文，不把旧交接/恢复字段带入schema2。 */
function freshAfterHandoff(attempt: ShellUpdateAttemptV3, requestId = crypto.randomUUID()): ShellUpdateAttemptV2 {
  return { schemaVersion: 2, requestId, revision: 0, retriesUsed: 0, phase: "preparing", network: null, target: null, candidateState: null,
    installationDir: attempt.installationDir, dataDir: attempt.dataDir, userDataDir: attempt.userDataDir, sessionDataDir: attempt.sessionDataDir,
    originalState: clone(attempt.admission === null ? attempt.originalState : attempt.candidateState), binding: clone(attempt.binding) };
}

/** 只经原helper显式采样入口扩展库存，旧缺库存不得偷偷初始化。 */
function handoffObserve(owner: ShellUpdateAttemptStore) {
  const entry = (owner as unknown as Record<string, unknown>).observeHandoffOwned;
  assert.equal(typeof entry, "function", "observeHandoffOwned must exist on the unique store");
  return entry as (expected: unknown, facts: unknown) => Promise<ShellUpdateAttemptV3 & { owned: ProcessIdentity[] }>;
}

/** 两个实际 observe 入口共用同一消失父实例场景，不把历史混入当前系统快照。 */
async function observedHistoryFixture(mode: "handoff" | "recovery") {
  if (mode === "handoff") {
    const { owner, prepared, facts } = await preparedHandoffFixture();
    const handoff = await owner.beginHandoff(prepared, { ...facts, processes: [facts.oldMain, facts.helper], knownOwned: [] });
    const main = handoffProcess(handoff, 501, facts.helper.pid, handoff.target.shellId);
    const expected = await owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, selectedMain: main }) as ShellUpdateAttemptV3;
    return { owner, expected, main, caller: facts.helper, runtime: { caller: facts.helper }, observe: handoffObserve(owner) };
  }
  const { owner, previous, facts, methods } = await recoveryFixture(), claimed = await methods.beginRecovery(previous, facts);
  const main = handoffProcess(claimed, 501, facts.helper.pid), runtime = recoveryRuntime(claimed, main);
  const expected = await methods.bindRecoveryMain(claimed, { ...runtime, main });
  return { owner, expected, main, caller: facts.helper, runtime, observe: methods.observeRecoveryOwned };
}

for (const mode of ["handoff", "recovery"] as const) for (const variant of ["older", "older-partial", "same", "newer", "unknown"] as const)
test(`legacy observed history ${mode} keeps ${variant} absent-parent rows within the instance boundary`, async () => {
  const { owner, expected, main, caller, runtime, observe } = await observedHistoryFixture(mode);
  const parent = mode === "handoff" ? expected.oldMain : expected.recovery!.controller;
  const old = { ...handoffProcess(expected, 971, parent.pid), created: variant.startsWith("older") ? 1
    : variant === "unknown" ? 0 : parent.created + (variant === "newer" ? 1 : 0),
    ...(variant === "older-partial" ? { executable: "", commandLine: "" } : {}) };
  const input = { ...runtime, caller, processes: [caller, main, old] };
  if (variant.startsWith("older")) assert.deepEqual(await observe(expected, input), expected);
  else await assert.rejects(observe(expected, input));
  assert.deepEqual(await owner.read(), expected);
});

for (const mode of ["handoff", "recovery"] as const) test(`observed history ${mode} retains a sampled parent after it exits before its child is persisted`, async () => {
  const { owner, expected, main, caller, runtime, observe } = await observedHistoryFixture(mode);
  const parent = handoffProcess(expected, 701, main.pid), child = handoffProcess(expected, 702, parent.pid);
  const knownOwned = [clone(parent), clone(child)], input = { ...runtime, caller, processes: [caller, main, child], knownOwned };
  const pending = observe(expected, input); knownOwned[0]!.parentPid = 1; knownOwned.length = 0;
  const actual = await pending, inventory = mode === "handoff" ? actual.owned : actual.recovery!.knownOwned;
  assert.deepEqual(inventory, [parent, child]); assert.equal(actual.revision, expected.revision + 1);
  assert.equal(actual.retriesUsed, expected.retriesUsed); assert.deepEqual(actual.network, expected.network); assert.deepEqual(actual.admission, expected.admission);
  assert.deepEqual(await owner.read(), actual);
  assert.deepEqual(await observe(actual, { ...runtime, caller, processes: [caller, main, child], knownOwned: [parent, child] }), actual);
  await assert.rejects(observe(actual, { ...runtime, caller, processes: [caller, main, child], knownOwned: [child] }));
});

for (const mode of ["handoff", "recovery"] as const) test(`observed history ${mode} rejects unrooted forged or conflicted inventories without writing`, async () => {
  const { owner, expected, main, caller, runtime, observe } = await observedHistoryFixture(mode), before = await fs.readFile(path.join(expected.dataDir, filename));
  const parent = handoffProcess(expected, 701, main.pid), child = handoffProcess(expected, 702, parent.pid);
  for (const knownOwned of [[child], [caller], [main, parent, child], [parent, parent], [{ ...parent, parentPid: 999 }],
    [parent, { ...child, created: parent.created - 1 }], [{ ...parent, pid: expected.oldMain.pid }]]) {
    await assert.rejects(observe(expected, { ...runtime, caller, processes: [caller, main, child], knownOwned }));
  }
  await assert.rejects(observe(expected, { ...runtime, caller, processes: [caller, main, { ...child, created: child.created + 1 }], knownOwned: [parent, child] }));
  await assert.rejects(observe(expected, { ...runtime, caller, processes: [caller, parent] }));
  assert.deepEqual(await fs.readFile(path.join(expected.dataDir, filename)), before); assert.deepEqual(await owner.read(), expected);
});

test("handoff owned inventory captures complete original descendants and tracks candidate Client after intent", async () => {
  const { directory, owner, prepared, facts } = await preparedHandoffFixture(), observe = handoffObserve(owner);
  const client = handoffProcess(prepared, 110, facts.oldMain.pid), chromium = handoffProcess(prepared, 111, client.pid);
  const handoff = await owner.beginHandoff(prepared, { ...facts, processes: [facts.oldMain, facts.helper, client, chromium], knownOwned: [client, chromium] });
  assert.deepEqual((handoff as { owned?: unknown }).owned, [client, chromium]);
  const before = await fs.stat(path.join(directory, filename), { bigint: true });
  assert.deepEqual(await observe(handoff, { caller: facts.helper, processes: [facts.oldMain, facts.helper, client, chromium] }), handoff);
  assert.equal((await fs.stat(path.join(directory, filename), { bigint: true })).mtimeNs, before.mtimeNs);
  const main = handoffProcess(handoff, 120, facts.helper.pid, handoff.target.shellId);
  const bound = await owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, selectedMain: main }) as ShellUpdateAttemptV3;
  const nextClient = handoffProcess(bound, 121, main.pid, bound.target.shellId), runtime = { caller: facts.helper, processes: [facts.helper, main, nextClient] };
  const ready: ShellUpdateReadyEvidence = { role: "candidate", continuationId: bound.continuationId, main, client: nextClient,
    readyRequestId: "owned-client-ready", health: clone(bound.binding.health), binding: clone(bound.binding), launchState: clone(bound.candidateState),
    profile: { dataDir: bound.dataDir, userDataDir: bound.userDataDir, sessionDataDir: bound.sessionDataDir }, mainFrame: "loaded",
    startup: { continuationId: bound.continuationId, admission: "paused" } };
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }));
  const observed = await observe(bound, runtime);
  assert.deepEqual(observed.owned, [client, chromium, nextClient]); assert.equal(observed.owned.some(identity => identity.pid === main.pid || identity.pid === facts.helper.pid), false);
  const intended = await owner.replace(observed, { ...observed, revision: observed.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const nextChromium = handoffProcess(intended, 122, nextClient.pid, intended.target.shellId);
  const monitored = await observe(intended, { ...runtime, processes: [...runtime.processes, nextChromium] });
  assert.deepEqual(monitored.admission, ready); assert.equal(monitored.phase, intended.phase); assert.deepEqual(monitored.network, intended.network);
  await assert.rejects(observe(intended, runtime));
  await assert.rejects(owner.replace(monitored, { ...monitored, revision: monitored.revision + 1, owned: [] }));
});

test("handoff owned inventory rejects missing evidence dead-parent strangers and role PID reuse", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), observe = handoffObserve(owner);
  const client = handoffProcess(prepared, 110, facts.oldMain.pid), live = [facts.oldMain, facts.helper, client];
  for (const changes of [{ processes: live }, { knownOwned: [client] }, { processes: live, knownOwned: [] },
    { processes: live, knownOwned: [facts.helper, client] }, { processes: live, knownOwned: [client, handoffProcess(prepared, 500, 1)] },
    { processes: [facts.oldMain, { ...facts.helper, created: 0 }, client], knownOwned: [client] }]) await assert.rejects(owner.beginHandoff(prepared, { ...facts, ...changes }));
  const handoff = await owner.beginHandoff(prepared, { ...facts, processes: live, knownOwned: [client] });
  await assert.rejects(observe(handoff, { caller: facts.oldMain, processes: live }));
  await assert.rejects(observe(handoff, { caller: facts.helper, processes: [facts.helper, { ...client, created: client.created + 1 }] }));
  await assert.rejects(observe(handoff, { caller: facts.helper, processes: [facts.helper, handoffProcess(handoff, 501, facts.oldMain.pid)] }));
  const stable = await observe(handoff, { caller: facts.helper, processes: [facts.helper, handoffProcess(handoff, 999, 1)] });
  assert.deepEqual(stable, handoff);
  const legacy = await preparedHandoffFixture(), old = await legacy.owner.beginHandoff(legacy.prepared, legacy.facts);
  await assert.rejects(handoffObserve(legacy.owner)(old, { caller: legacy.facts.helper, processes: [legacy.facts.helper] }));
  assert.deepEqual(await owner.read(), handoff);
});

test("handoff owned inventory remains a required recovery release lower bound", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), observe = handoffObserve(owner);
  const client = handoffProcess(prepared, 110, facts.oldMain.pid);
  const handoff = await owner.beginHandoff(prepared, { ...facts, processes: [facts.oldMain, facts.helper, client], knownOwned: [client] });
  const previous = await owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, phase: "failed" }) as ShellUpdateAttemptV3;
  const caller = handoffProcess(previous, 201, 1), helper = handoffProcess(previous, 202, caller.pid);
  const base = { ...recoveryFacts(previous), caller, helper, processes: [caller, helper], owner: { status: "gone", identity: facts.helper },
    launchState: { status: "known", value: previous.originalState },
    knownOwned: { status: "known", identities: [facts.oldMain, facts.helper] } };
  await assert.rejects(owner.beginRecovery(previous, base));
  await assert.rejects(owner.beginRecovery(previous, { ...base, knownOwned: { status: "known", identities: [...base.knownOwned.identities, client] }, processes: [...base.processes, client] }));
  const recovery = await owner.beginRecovery(previous, { ...base, knownOwned: { status: "known", identities: [...base.knownOwned.identities, client] } });
  await assert.rejects(observe(recovery, { caller: facts.helper, processes: [facts.helper] }));
});

test("schema3 startNext opens a fresh same-context cycle after completed and restored evidence", async () => {
  for (const role of ["candidate", "original"] as const) {
    const { directory, owner, bound, ready } = await boundHandoffFixture();
    const chosen = role === "candidate" ? ready : { ...ready, role, main: bound.oldMain, client: handoffProcess(bound, 106, bound.oldMain.pid), launchState: bound.originalState };
    const evidence = { ready: chosen, startedRequestId: "cycle-started", continueRequestId: "cycle-continue", startup: "completed", application: "started" };
    const intermediate = role === "candidate" ? await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3 : bound;
    const terminal = await owner.replace(intermediate, { ...intermediate, revision: intermediate.revision + 1, phase: role === "candidate" ? "completed" : "restored", terminalEvidence: evidence }) as ShellUpdateAttemptV3;
    const fresh = freshAfterHandoff(terminal);
    fresh.binding = { kind: "active", releaseId: "new-hot-release", packageSha256: "f".repeat(64), health: { ...fresh.binding.health, clientVersion: "2.0.0" } };
    assert.deepEqual(await owner.startNext(terminal, fresh), fresh); assert.deepEqual(await store(directory).read(), fresh);
    await assert.rejects(owner.startNext(terminal, freshAfterHandoff(terminal)));
  }
});

test("schema3 startNext rejects unfinished or wrong-context fresh cycles before IO", async t => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const terminal = await owner.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence: {
    ready, startedRequestId: "started", continueRequestId: "continue", startup: "completed", application: "started" } }) as ShellUpdateAttemptV3;
  const fresh = freshAfterHandoff(terminal);
  let io = 0; t.mock.method(fs, "realpath", async () => { io++; assert.fail("invalid next cycle before IO"); });
  for (const previous of [bound, intended, { ...intended, phase: "failed" }]) await assert.rejects(owner.startNext(previous, fresh));
  for (const changes of [{ requestId: terminal.requestId }, { revision: 1 }, { retriesUsed: 1, revision: 1 }, { originalState: terminal.originalState },
    { originalState: { ...fresh.originalState, previousShellId: null } }, { installationDir: path.join(fresh.installationDir, "other") },
    { dataDir: path.join(fresh.dataDir, "other") }, { userDataDir: path.join(fresh.userDataDir, "other") },
    { sessionDataDir: path.join(fresh.sessionDataDir, "other") }, { network: terminal.network }]) await assert.rejects(owner.startNext(terminal, { ...fresh, ...changes }));
  assert.equal(io, 0);
});

test("schema3 startNext accepts only completed current recovery and preserves the next context", async () => {
  const { directory, owner, previous, facts, methods } = await recoveryFixture(true);
  const claimed = await methods.beginRecovery(previous, facts), main = handoffProcess(claimed, 203, facts.helper.pid, claimed.target.shellId);
  const bound = await methods.bindRecoveryMain(claimed, { ...recoveryRuntime(claimed, main), main });
  await assert.rejects(owner.startNext(bound, freshAfterHandoff(bound)));
  const client = handoffProcess(bound, 204, main.pid, bound.target.shellId), runtime = recoveryRuntime(bound, main);
  const observed = await methods.observeRecoveryOwned(bound, { ...runtime, processes: [...runtime.processes, client] });
  const ready = { ...clone(previous.admission!), main, client };
  const complete = await methods.completeRecovery(observed, { ready, startedRequestId: "recovered-started", continueRequestId: "recovered-continue", startup: "completed", application: "started" });
  const fresh = freshAfterHandoff(complete);
  assert.deepEqual(await owner.startNext(complete, fresh), fresh); assert.deepEqual(await store(directory).read(), fresh);
});

test("handoff owned inventory snapshots inputs and returns a stable current expected after restart", async () => {
  const { directory, owner, prepared, facts } = await preparedHandoffFixture(), observe = handoffObserve(owner);
  const client = handoffProcess(prepared, 110, facts.oldMain.pid), input = { ...clone(facts), processes: [clone(facts.oldMain), clone(facts.helper), clone(client)], knownOwned: [clone(client)] };
  const pending = owner.beginHandoff(prepared, input); input.knownOwned[0]!.created++; input.processes.length = 0;
  const handoff = await pending;
  assert.deepEqual(handoff.owned, [client]);
  const chromium = handoffProcess(handoff, 111, client.pid), update = { caller: clone(facts.helper), processes: [clone(facts.helper), clone(client), clone(chromium)] };
  const reading = observe(handoff, update); update.processes.length = 0;
  const observed = await reading; assert.deepEqual(observed.owned, [client, chromium]);
  const script = path.join(root, "owned-readback.mjs");
  await fs.writeFile(script, `import { createShellUpdateAttemptStore } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
const owner = createShellUpdateAttemptStore(${JSON.stringify(directory)}), attempt = await owner.read();
const result = await owner.observeHandoffOwned(attempt, ${JSON.stringify({ caller: facts.helper, processes: [facts.helper] })});
process.stdout.write(JSON.stringify({ pid: process.pid, attempt: result }));\n`, "utf8");
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000, env: { ...process.env } });
  await fs.writeFile(path.join(root, "owned-readback.stdout.log"), child.stdout ?? "", "utf8");
  await fs.writeFile(path.join(root, "owned-readback.stderr.log"), child.stderr ?? "", "utf8");
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).attempt, observed);
});

test("handoff owned inventory rejects hostile snapshots and overflow while keeping the previous evidence", async t => {
  const { directory, owner, prepared, facts } = await preparedHandoffFixture(), observe = handoffObserve(owner);
  const handoff = await owner.beginHandoff(prepared, { ...facts, processes: [facts.oldMain, facts.helper], knownOwned: [] });
  const native = await fs.readFile(path.join(directory, filename)); let getters = 0, io = 0;
  const array = [facts.helper]; Object.defineProperty(array, 0, { get() { getters++; return facts.helper; } });
  const mock = t.mock.method(fs, "realpath", async () => { io++; assert.fail("invalid inventory before IO"); });
  for (const input of [{ caller: facts.helper, processes: array }, { caller: facts.helper, processes: [facts.helper, facts.helper] },
    { caller: facts.helper, processes: [facts.helper], extra: true }]) await assert.rejects(observe(handoff, input));
  assert.equal(io, 0); assert.equal(getters, 0); mock.mock.restore();
  const children = Array.from({ length: 20 }, (_, index) => ({ ...handoffProcess(handoff, 500 + index, facts.oldMain.pid), commandLine: "x".repeat(4000) }));
  await assert.rejects(observe(handoff, { caller: facts.helper, processes: [facts.oldMain, facts.helper, ...children] }));
  assert.deepEqual(await fs.readFile(path.join(directory, filename)), native); assert.deepEqual(await owner.read(), handoff);
});

test("admission-intent commits irreversibly and failed retains the same admission", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const entry = (implementation as Record<string, unknown>).decideShellUpdateRecovery;
  assert.equal(typeof entry, "function");
  const decide = entry as (attempt: unknown, facts: unknown) => { action: string };
  assert.equal(decide(intended, recoveryFacts(intended)).action, "resume-candidate");
  for (const changes of [{ phase: "restored", admission: null }, { phase: "handoff", admission: null }, { phase: "failed", admission: null },
    { admission: { ...ready, readyRequestId: "different-ready" } }, { selectedMain: { ...ready.main, created: ready.main.created + 1 } }, { retriesUsed: 0 }]) {
    await assert.rejects(owner.replace(intended, { ...intended, revision: intended.revision + 1, ...changes }));
  }
  const failed = await owner.replace(intended, { ...intended, revision: intended.revision + 1, phase: "failed" }) as ShellUpdateAttemptV3;
  assert.deepEqual(failed.admission, ready); assert.equal(decide(failed, recoveryFacts(failed)).action, "resume-candidate");
  const originalFacts = recoveryFacts(failed); originalFacts.launchState = { status: "known", value: failed.originalState };
  assert.equal(decide(failed, originalFacts).action, "stop");
});

test("beginHandoff rejects all unprepared versions and hostile handoff facts before IO", async t => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), { attempt: legacy } = await fixture();
  let io = 0, getters = 0;
  t.mock.method(fs, "realpath", async () => { io++; assert.fail("unexpected IO"); });
  for (const previous of [null, legacy, { ...prepared, phase: "failed" }, { ...prepared, phase: "handoff" },
    { ...prepared, target: null, candidateState: null }, { ...prepared, network: null },
    { ...prepared, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" } },
    { ...prepared, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "waiting", delayMs: 0, notBefore: 0 } }]) {
    await assert.rejects(owner.beginHandoff(previous, facts), error => { failure(error, "REPLACE", "input"); return true; });
  }
  const accessor = clone(facts); Object.defineProperty(accessor.helper, "pid", { get() { getters++; return 102; } });
  for (const invalid of [null, {}, { ...facts, extra: true }, Object.create(facts), accessor, { ...facts, continuationId: "with space" },
    { ...facts, oldMain: { ...facts.oldMain, created: 0 } }, { ...facts, helper: { ...facts.helper, parentPid: 1 } },
    { ...facts, helper: { ...facts.helper, executable: path.join(prepared.installationDir, "foreign.exe") } },
    { ...facts, helper: { ...facts.helper, pid: facts.oldMain.pid } }, { ...facts, helper: { ...facts.helper, commandLine: "bad\0command" } }]) {
    await assert.rejects(owner.beginHandoff(prepared, invalid), error => { failure(error, "REPLACE", "input"); return true; });
  }
  assert.equal(io, 0); assert.equal(getters, 0);
});

test("schema3 reader does not migrate old schemas or allow ordinary cross-version replacement", async () => {
  const { directory, owner, prepared, facts } = await preparedHandoffFixture();
  const raw = { ...prepared, schemaVersion: 3, revision: prepared.revision + 1, phase: "handoff", ...facts, selectedMain: null, admission: null, terminalEvidence: null };
  await assert.rejects(owner.replace(prepared, raw));
  await assert.rejects(owner.replace(null, raw));
  assert.deepEqual(await owner.read(), prepared); assert.equal((await owner.read())?.schemaVersion, 2);
  const handoff = await owner.beginHandoff(prepared, facts);
  assert.equal(handoff.network.status, "succeeded");
  assert.ok(handoff.network.status === "succeeded");
  await assert.rejects(owner.startNext(handoff, freshAttempt(handoff)));
  await assert.rejects(owner.beginHandoff(handoff, facts));
  for (const changes of [{ retriesUsed: 0 }, { binding: { ...handoff.binding, health: { ...handoff.binding.health, dbSchemaVersion: 99 } } },
    { originalState: { ...handoff.originalState, previousShellId: null } }, { requestId: "changed" }, { continuationId: "changed" },
    { network: { ...handoff.network, evidence: { ...handoff.network.evidence, sha256: "f".repeat(64) } } },
    { helper: { ...handoff.helper, created: handoff.helper.created + 1 } }]) {
    await assert.rejects(owner.replace(handoff, { ...handoff, revision: handoff.revision + 1, ...changes }));
  }
  assert.deepEqual(await owner.read(), handoff); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("admission validates exact held ready, binding, health, profile and selected instance", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  for (const changes of [{ role: "original" }, { continuationId: "other" }, { startup: { continuationId: bound.continuationId, admission: "running" } },
    { mainFrame: "loading" }, { readyRequestId: "" }, { health: { ...ready.health, dbSchemaVersion: 99 } },
    { binding: { ...ready.binding, health: { ...ready.binding.health, clientVersion: "changed" } } },
    { main: { ...ready.main, created: ready.main.created + 1 } }, { client: { ...ready.client, parentPid: bound.helper.pid } },
    { profile: { ...ready.profile, userDataDir: path.join(bound.dataDir, "foreign") } },
    { launchState: { ...ready.launchState, previousShellId: "wrong-previous" } }, { extra: true }]) {
    await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: { ...ready, ...changes } }));
  }
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, admission: ready }));
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent" }));
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, selectedMain: { ...ready.main, created: ready.main.created + 1 } }));
  assert.deepEqual(await owner.read(), bound);
});

test("completed requires matching started evidence and immutable admission instead of unknown continue", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const terminalEvidence = { ready, startedRequestId: "main-started", continueRequestId: "client-continue", startup: "completed", application: "started" };
  for (const evidence of [null, { ...terminalEvidence, startup: "unknown" }, { ...terminalEvidence, application: "starting" },
    { ...terminalEvidence, continueRequestId: "" }, { ...terminalEvidence, ready: { ...ready, readyRequestId: "other" } }]) {
    await assert.rejects(owner.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence: evidence }));
  }
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "completed", admission: ready, terminalEvidence }));
  const completed = await owner.replace(intended, { ...intended, revision: intended.revision + 1, phase: "completed", terminalEvidence });
  await assert.rejects(owner.replace(completed, { ...completed, revision: completed.revision + 1, phase: "failed", terminalEvidence: null }));
  assert.deepEqual(await owner.read(), completed);
});

test("restored requires complete original held startup evidence and can settle a failed pre-admission recovery", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const failed = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "failed" }) as ShellUpdateAttemptV3;
  const originalReady: ShellUpdateReadyEvidence = { ...ready, role: "original", main: failed.oldMain,
    client: handoffProcess(failed, 105, failed.oldMain.pid), launchState: failed.originalState };
  const terminalEvidence = { ready: originalReady, startedRequestId: "original-started", continueRequestId: "original-continue", startup: "completed", application: "started" };
  for (const evidence of [null, { ...terminalEvidence, ready }, { ...terminalEvidence, startup: "unknown" },
    { ...terminalEvidence, ready: { ...originalReady, launchState: { ...failed.originalState, previousShellId: null } } }]) {
    await assert.rejects(owner.replace(failed, { ...failed, revision: failed.revision + 1, phase: "restored", terminalEvidence: evidence }));
  }
  const restored = await owner.replace(failed, { ...failed, revision: failed.revision + 1, phase: "restored", terminalEvidence });
  assert.deepEqual(restored.originalState, failed.originalState);
  await assert.rejects(owner.replace(restored, { ...restored, revision: restored.revision + 1 }));
  const decide = (implementation as Record<string, unknown>).decideShellUpdateRecovery as (attempt: unknown, facts: unknown) => { action: string };
  assert.equal(decide(restored, recoveryFacts(restored as ShellUpdateAttemptV3)).action, "stop");
});

test("restored evidence cannot use the helper process as its supposedly ready Client", async () => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const originalReady = { ...ready, role: "original", main: bound.oldMain, client: bound.helper, launchState: bound.originalState };
  await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "restored", terminalEvidence: {
    ready: originalReady, startedRequestId: "started", continueRequestId: "continue", startup: "completed", application: "started" } }));
});

test("pure recovery matrix preserves admission direction and distinguishes the current writer", async t => {
  const { owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const decide = (implementation as Record<string, unknown>).decideShellUpdateRecovery as (attempt: unknown, facts: unknown) => { action: string };
  let io = 0; t.mock.method(fs, "realpath", async () => { io++; assert.fail("pure function performed IO"); });
  for (const attempt of [bound, intended]) {
    const facts = recoveryFacts(attempt), external = handoffProcess(attempt, 201, 1);
    assert.equal(decide(attempt, { ...facts, caller: external }).action, "wait-owner");
    assert.equal(decide(attempt, { ...facts, caller: external, owner: { status: "gone", identity: attempt.helper } }).action, attempt.admission ? "resume-candidate" : "restore-original");
    for (const changes of [{ owner: { status: "unknown" } }, { owner: { status: "gone", identity: attempt.helper } },
      { oldMain: { status: "unknown" } }, { selectedMain: { status: "unknown" } }, { selectedMain: { status: "alive", identity: attempt.selectedMain } },
      { launchState: { status: "unknown" } }, { launchState: { status: "known", value: { ...attempt.originalState, previousShellId: null } } },
      { binding: { status: "unknown" } }, { binding: { status: "mismatch" } },
      { binding: { status: "matched", value: { ...attempt.binding, health: { ...attempt.binding.health, dbSchemaVersion: 9 } } } },
      { profile: { status: "known", dataDir: attempt.dataDir, userDataDir: path.join(attempt.dataDir, "wrong"), sessionDataDir: attempt.sessionDataDir } },
      { ownedReleased: "pending" }, { ownedReleased: "unknown" },
      { owner: { status: "alive", identity: { ...attempt.helper, created: attempt.helper.created + 1 } } }]) {
      assert.equal(decide(attempt, { ...facts, ...changes }).action, "stop");
    }
  }
  const beforeFacts = recoveryFacts(bound); beforeFacts.oldMain = { status: "alive", identity: bound.oldMain };
  assert.equal(decide(bound, beforeFacts).action, "restore-original");
  beforeFacts.launchState = { status: "known", value: bound.originalState };
  assert.equal(decide(bound, beforeFacts).action, "resume-original");
  const afterFacts = recoveryFacts(intended); afterFacts.oldMain = { status: "alive", identity: intended.oldMain };
  assert.equal(decide(intended, afterFacts).action, "stop");
  const selfGone = recoveryFacts(intended); selfGone.caller = clone(intended.selectedMain!); selfGone.owner = { status: "gone", identity: intended.helper };
  assert.equal(decide(intended, selfGone).action, "stop");
  assert.equal(io, 0);
});

test("beginHandoff and admission snapshot their evidence before await and reject stale revisions", async () => {
  const { owner, prepared, facts } = await preparedHandoffFixture();
  const expected = clone(prepared), savedFacts = clone(facts), pending = owner.beginHandoff(prepared, facts);
  prepared.binding.health.clientVersion = "mutated"; facts.continuationId = "mutated"; facts.helper.commandLine = "mutated";
  const handoff = await pending; assert.deepEqual(handoff.binding, expected.binding); assert.equal(handoff.continuationId, savedFacts.continuationId);
  assert.deepEqual(handoff.helper, savedFacts.helper);
  await assert.rejects(owner.beginHandoff(expected, savedFacts), error => { failure(error, "REPLACE", "read-current"); return true; });
  const item = await boundHandoffFixture(), wanted = clone(item.ready);
  const next = { ...item.bound, revision: item.bound.revision + 1, phase: "admission-intent", admission: item.ready };
  const committing = item.owner.replace(item.bound, next);
  item.ready.main.created++; item.ready.binding.health.clientVersion = "mutated"; item.ready.profile.userDataDir = "mutated";
  const intended = await committing as ShellUpdateAttemptV3; assert.deepEqual(intended.admission, wanted);
  intended.admission!.main.commandLine = "mutated-result"; assert.deepEqual((await item.owner.read() as ShellUpdateAttemptV3).admission, wanted);
});

test("schema3 strict reader rejects malformed phase coupling and hostile descriptors", async t => {
  const { owner, bound, ready } = await boundHandoffFixture(); let getters = 0, io = 0;
  const accessor = clone(ready); Object.defineProperty(accessor.client, "created", { get() { getters++; return 1; } });
  t.mock.method(fs, "realpath", async () => { io++; assert.fail("unexpected IO"); });
  for (const candidate of [{ ...bound, selectedMain: undefined }, { ...bound, admission: ready }, { ...bound, phase: "completed" },
    { ...bound, phase: "restored" }, { ...bound, phase: "preparing" }, { ...bound, phase: "no-update" },
    { ...bound, phase: "admission-intent", admission: accessor }, { ...bound, phase: "admission-intent", admission: Object.create(ready) },
    { ...bound, helper: { ...bound.helper, extra: true } }, { ...bound, phase: "failed", admission: ready },
    { ...bound, terminalEvidence: { ready, startedRequestId: "started", continueRequestId: "continue", startup: "completed", application: "started" } }]) {
    await assert.rejects(owner.replace(bound, { ...candidate, revision: bound.revision + 1 }), error => { failure(error, "REPLACE", "input"); return true; });
  }
  assert.equal(getters, 0); assert.equal(io, 0);
});

for (const afterRename of [false, true]) {
  test(`admission ${afterRename ? "post-rename" : "pre-rename"} failure rereads the actual irreversible boundary`, async t => {
    const { owner, bound, ready } = await boundHandoffFixture(), open = fs.open, rename = fs.rename;
    const primary = new Error("admission publication failed"); let readback = false;
    const mock = afterRename ? t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { await rename(...args); readback = true; })
      : t.mock.method(fs, "rename", async () => { throw primary; });
    const readerMock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (readback && path.basename(String(args[0])) === filename) { readback = false; throw primary; }
      return open(...args);
    });
    await assert.rejects(owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }), error => {
      failure(error, "REPLACE", afterRename ? "verify-replaced" : "replace", afterRename); assert.equal(error.cause, primary); return true;
    });
    mock.mock.restore(); readerMock.mock.restore();
    const actual = await owner.read() as ShellUpdateAttemptV3;
    assert.equal(actual.admission !== null, afterRename);
    const decide = (implementation as Record<string, unknown>).decideShellUpdateRecovery as (attempt: unknown, facts: unknown) => { action: string };
    assert.equal(decide(actual, recoveryFacts(actual)).action, afterRename ? "resume-candidate" : "restore-original");
    if (afterRename) await assert.rejects(owner.replace(actual, { ...bound, revision: actual.revision + 1 }));
  });
}

test("beginHandoff retains undefined write and close causes without publishing schema3", async t => {
  const { owner, prepared, facts } = await preparedHandoffFixture(), open = fs.open, additional = new Error("helper state close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file); t.mock.method(file, "write", async () => { throw undefined; });
      t.mock.method(file, "close", async () => { await close(); throw additional; });
    }
    return file;
  });
  await assert.rejects(owner.beginHandoff(prepared, facts), error => {
    failure(error, "REPLACE", "write-temp");
    const combined = causes(error).find(item => item instanceof AggregateError && item.message === "DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED") as AggregateError;
    assert.ok(combined); assert.deepEqual(combined.errors, [undefined, additional]); return true;
  });
  await poisonedSnapshot(owner, prepared.dataDir, prepared);
});

test("fresh Node process rereads the unique admission and failed-admission facts without allowing original recovery", async () => {
  const { directory, owner, bound, ready } = await boundHandoffFixture();
  const intended = await owner.replace(bound, { ...bound, revision: bound.revision + 1, phase: "admission-intent", admission: ready }) as ShellUpdateAttemptV3;
  const script = path.join(root, `handoff-recovery-${crypto.randomUUID()}.mjs`), temporary = await fs.mkdtemp(path.join(root, "handoff-process-temp-"));
  await fs.writeFile(script, `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import { createShellUpdateAttemptStore, decideShellUpdateRecovery } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
    const directory = ${JSON.stringify(directory)}, owner = createShellUpdateAttemptStore(directory), wanted = ${JSON.stringify(intended)}, facts = ${JSON.stringify(recoveryFacts(intended))};
    const actual = await owner.read(); assert.deepEqual(actual, wanted); assert.equal(decideShellUpdateRecovery(actual, facts).action, 'resume-candidate');
    const failed = await owner.replace(actual, { ...actual, revision: actual.revision + 1, phase: 'failed' });
    assert.equal(decideShellUpdateRecovery(failed, facts).action, 'resume-candidate');
    facts.launchState.value = failed.originalState; assert.equal(decideShellUpdateRecovery(failed, facts).action, 'stop');
    assert.deepEqual(await fs.readdir(directory), ['.shell-update-file-auth', 'shell-update-attempt.json']); console.log(JSON.stringify({ revision: failed.revision, admissionRetained: failed.admission !== null }));`, "utf8");
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15000,
    env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
  await fs.writeFile(script + ".stdout.log", child.stdout ?? "", "utf8"); await fs.writeFile(script + ".stderr.log", child.stderr ?? "", "utf8");
  await fs.writeFile(script + ".process.json", JSON.stringify({ pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message ?? null }), "utf8");
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).admissionRetained, true);
  assert.equal((await owner.read() as ShellUpdateAttemptV3).phase, "failed");
});

test("schema2 terminates an unselected successful discovery as no-update and refuses adapter use", async () => {
  const { directory, owner, discovered } = await discoveredFixture(3);
  const finished = { ...discovered, revision: discovered.revision + 1, phase: "no-update" };
  assert.deepEqual(await owner.replace(discovered, finished), finished);
  assert.deepEqual(await store(directory).read(), finished);
  assert.equal((await owner.read())?.retriesUsed, 3);
  await assert.rejects(createShellUpdateAttemptNetworkAdapter(owner).read(), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  for (const changes of [{ phase: "preparing" }, { phase: "failed" }, { retriesUsed: 0 }, {}]) {
    await assert.rejects(owner.replace(finished, { ...finished, revision: finished.revision + 1, ...changes }));
  }
});

test("startNext replaces only the same no-update file with a distinct fresh schema2 cycle", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  const finished = { ...freshAttempt(attempt), revision: 3, phase: "no-update", network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } };
  await fs.writeFile(path.join(directory, filename), JSON.stringify(finished), "utf8");
  const startNext = (owner as ShellUpdateAttemptStore & { startNext?: (expected: unknown, fresh: unknown) => Promise<AnyAttempt> }).startNext;
  assert.equal(typeof startNext, "function", "startNext must exist on the existing store");
  const fresh = freshAttempt(attempt);
  fresh.originalState = { activeShellId: "new-current", previousShellId: "previous", baselineShellId: "new-baseline" };
  fresh.binding = { kind: "installation", baselineShellId: "new-baseline", health: { protocolVersion: 1, clientVersion: "2.0", dbSchemaVersion: 8, database: "ready" } };
  assert.deepEqual(await startNext!(finished, fresh), fresh);
  assert.deepEqual(await store(directory).read(), fresh);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("no-update requires the unchanged successful manifest slot and rejects schema1 or selected targets", async () => {
  const { directory, owner, discovered } = await discoveredFixture();
  assert.ok(discovered.network?.status === "succeeded");
  const { attempt: selected } = await fixture();
  const terminal = { ...discovered, revision: discovered.revision + 1, phase: "no-update" };
  for (const network of [null, { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" },
    { actionKey: "manifest", requestSha256: "d".repeat(64), status: "waiting", delayMs: 0, notBefore: 0 },
    { actionKey: "manifest", requestSha256: "d".repeat(64), status: "failed", errorCode: "FAILED" },
    ...["device-registration", "shell-installer", "shell-switch-authorization"].map(kind => ({ ...discovered.network, evidence: { kind, sha256: "e".repeat(64) } }))]) {
    await assert.rejects(owner.replace(discovered, { ...terminal, network }), error => { failure(error, "REPLACE", "input"); return true; });
  }
  for (const changes of [{ target: selected.target, candidateState: selected.candidateState }, { retriesUsed: 1 },
    { requestId: "changed" }, { originalState: { ...discovered.originalState, previousShellId: null } },
    { network: { ...discovered.network, evidence: { kind: "shell-manifest", sha256: "f".repeat(64) } } }]) {
    await assert.rejects(owner.replace(discovered, { ...terminal, ...changes }));
  }
  await assert.rejects(owner.replace(null, terminal));
  const legacy = { ...selected, revision: 1, phase: "no-update" };
  await assert.rejects(store(selected.dataDir).replace(null, legacy));
  await fs.writeFile(path.join(selected.dataDir, filename), JSON.stringify(legacy), "utf8");
  await assert.rejects(store(selected.dataDir).read(), error => { failure(error, "READ", "read"); return true; });
  assert.deepEqual(await owner.read(), discovered);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("only preparing can enter no-update and the adapter cannot send after normal termination", async () => {
  const { owner, discovered } = await discoveredFixture();
  const terminal = { ...discovered, revision: discovered.revision + 1, phase: "no-update" as const };
  const adapter = createShellUpdateAttemptNetworkAdapter(owner), expected = await adapter.read();
  await owner.replace(discovered, terminal);
  await assert.rejects(adapter.replace(expected, { retriesUsed: 0, network: { actionKey: "other", requestSha256: "a".repeat(64), status: "dispatching" } }), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  for (const phase of ["handoff", "failed"] as const) {
    const item = await fixture(), selected: ShellUpdateAttemptV2 = { ...item.attempt, schemaVersion: 2, network: null };
    const candidate = store(item.directory); await candidate.replace(null, selected);
    const final = { ...selected, revision: 1, phase }; await candidate.replace(selected, final);
    await assert.rejects(candidate.replace(final, { ...terminal, dataDir: item.directory, revision: 2 }));
    assert.deepEqual(await candidate.read(), final);
  }
});

test("pending discovery cannot bypass its durable success transition by closing the cycle", async () => {
  for (const status of ["dispatching", "waiting"] as const) {
    const { directory, attempt } = await fixture(), owner = store(directory), initial = freshAttempt(attempt);
    await owner.replace(null, initial);
    const adapter = createShellUpdateAttemptNetworkAdapter(owner), identity = { actionKey: "manifest", requestSha256: "d".repeat(64) };
    await adapter.replace(await adapter.read(), { retriesUsed: 0, network: { ...identity, status: "dispatching" } });
    if (status === "waiting") await adapter.replace(await adapter.read(), { retriesUsed: 1, network: { ...identity, status, delayMs: 0, notBefore: 0 } });
    const pending = await owner.read(); assert.ok(pending);
    await assert.rejects(owner.replace(pending, { ...pending, revision: pending.revision + 1, phase: "no-update",
      network: { ...identity, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } }));
    assert.deepEqual(await owner.read(), pending);
  }
});

test("startNext rejects nonterminal expected facts and nonfresh inputs before IO without refunding", async t => {
  const { owner, discovered } = await discoveredFixture(3);
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const fresh = freshAttempt(terminal), { attempt: selected } = await fixture();
  let io = 0, getters = 0;
  t.mock.method(fs, "realpath", async () => { io++; assert.fail("unexpected IO"); });
  for (const expected of [null, discovered, selected,
    { ...selected, schemaVersion: 2, network: null, revision: 1, phase: "handoff" },
    { ...selected, schemaVersion: 2, network: null, revision: 3, retriesUsed: 3, phase: "failed" }]) {
    await assert.rejects(owner.startNext(expected, fresh), error => { failure(error, "REPLACE", "input"); return true; });
  }
  const accessor = clone(fresh);
  Object.defineProperty(accessor.binding.health, "clientVersion", { get() { getters++; return "bad"; } });
  for (const candidate of [null, selected, { ...fresh, requestId: terminal.requestId }, { ...fresh, revision: 1 },
    { ...fresh, retriesUsed: 1 }, { ...fresh, phase: "failed", revision: 1 }, { ...fresh, phase: "handoff", revision: 1 },
    { ...fresh, phase: "no-update", revision: 1 }, { ...fresh, target: selected.target, candidateState: selected.candidateState },
    { ...fresh, target: selected.target }, { ...fresh, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" } },
    { ...fresh, originalState: undefined }, { ...fresh, binding: { ...fresh.binding, health: { ...fresh.binding.health, database: "unready" } } },
    { ...fresh, dataDir: "relative" }, { ...fresh, extra: true }, Object.create(fresh), accessor]) {
    await assert.rejects(owner.startNext(terminal, candidate), error => { failure(error, "REPLACE", "input"); return true; });
  }
  assert.equal(io, 0); assert.equal(getters, 0);
});

test("startNext snapshots all input facts before await and preserves the next owner's actual context", async () => {
  const { owner, discovered } = await discoveredFixture();
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const fresh = freshAttempt(terminal);
  fresh.installationDir = path.join(fresh.dataDir, "new-installation"); fresh.userDataDir = path.join(fresh.dataDir, "new-profile");
  fresh.sessionDataDir = path.join(fresh.dataDir, "new-session");
  fresh.originalState.previousShellId = "previous-at-new-cycle";
  fresh.binding.health.clientVersion = "2.0";
  const wanted = clone(fresh), pending = owner.startNext(terminal, fresh);
  terminal.requestId = "mutated-expected"; fresh.requestId = "mutated-fresh"; fresh.originalState.previousShellId = null;
  fresh.binding.health.clientVersion = "mutated-health"; fresh.dataDir = "mutated-root";
  const saved = await pending; assert.deepEqual(saved, wanted);
  saved.binding.health.clientVersion = "mutated-result"; assert.deepEqual(await owner.read(), wanted);
});

test("startNext serializes a single winner and stale expected or old ID cannot overwrite it", async () => {
  const { directory, owner, discovered } = await discoveredFixture();
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const fresh = freshAttempt(terminal), other = freshAttempt(terminal);
  const stale = { ...terminal, revision: terminal.revision + 1 };
  await assert.rejects(owner.startNext(stale, fresh), error => { failure(error, "REPLACE", "read-current"); return true; });
  await assert.rejects(owner.replace(terminal, fresh));
  const results = await Promise.allSettled([owner.startNext(terminal, fresh), owner.startNext(terminal, other)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") failure(results[1].reason, "REPLACE", "read-current");
  await assert.rejects(owner.startNext(terminal, freshAttempt(terminal, terminal.requestId)));
  await assert.rejects(store(directory).startNext(terminal, other));
  assert.deepEqual(await owner.read(), fresh); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("a fresh Node process starts and rereads the next cycle in the same unique file", async () => {
  const { directory, owner, discovered } = await discoveredFixture(3);
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const fresh = freshAttempt(terminal), script = path.join(root, `next-cycle-${crypto.randomUUID()}.mjs`);
  await fs.writeFile(script, `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import { createShellUpdateAttemptStore } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
    const directory = ${JSON.stringify(directory)}, expected = ${JSON.stringify(terminal)}, fresh = ${JSON.stringify(fresh)};
    const owner = createShellUpdateAttemptStore(directory); assert.deepEqual(await owner.read(), expected);
    const saved = await owner.startNext(expected, fresh); assert.deepEqual(saved, fresh);
    assert.deepEqual(await createShellUpdateAttemptStore(directory).read(), fresh);
    assert.deepEqual(await fs.readdir(directory), ['.shell-update-file-auth', 'shell-update-attempt.json']); console.log(JSON.stringify(saved));`, "utf8");
  const temporary = await fs.mkdtemp(path.join(root, "next-process-temp-"));
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8", timeout: 15000, env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
  await fs.writeFile(script + ".stdout.log", child.stdout ?? "", "utf8"); await fs.writeFile(script + ".stderr.log", child.stderr ?? "", "utf8");
  await fs.writeFile(script + ".process.json", JSON.stringify({ pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message ?? null }), "utf8");
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), fresh);
  assert.deepEqual(await owner.read(), fresh);
});

for (const phase of ["write-temp", "sync-temp", "close-temp", "replace"] as const) {
  test(`startNext preserves the prior terminal fact on ${phase} failure`, async t => {
    const { directory, owner, discovered } = await discoveredFixture();
    const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
    const fresh = freshAttempt(terminal), open = fs.open, primary = Object.assign(new Error("next-cycle native failure"), { code: "EIO" });
    if (phase === "replace") t.mock.method(fs, "rename", async () => { throw primary; });
    else t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (phase === "write-temp") t.mock.method(file, "write", async () => { throw primary; });
        if (phase === "sync-temp") t.mock.method(file, "sync", async () => { throw primary; });
        if (phase === "close-temp") {
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { await close(); throw primary; });
        }
      }
      return file;
    });
    await assert.rejects(owner.startNext(terminal, fresh), error => {
      failure(error, "REPLACE", phase); assert.ok(causes(error).includes(primary)); assert.equal(error.requestId, fresh.requestId); return true;
    });
    if (phase === "close-temp") await poisonedSnapshot(owner, directory, terminal);
    else assert.deepEqual(await owner.read(), terminal);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, phase === "close-temp" ? 1 : 0);
  });
}

test("startNext preserves a thrown undefined write cause and its close failure", async t => {
  const { owner, discovered } = await discoveredFixture();
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const open = fs.open, additional = new Error("next-cycle close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "write", async () => { throw undefined; });
      t.mock.method(file, "close", async () => { await close(); throw additional; });
    }
    return file;
  });
  await assert.rejects(owner.startNext(terminal, freshAttempt(terminal)), error => {
    failure(error, "REPLACE", "write-temp"); assert.ok(causes(error).includes(additional));
    const writeAndClose = causes(error).find(cause => cause instanceof AggregateError && cause.message === "DESKTOP_SHELL_UPDATE_ATTEMPT_CLOSE_FAILED") as AggregateError;
    assert.ok(writeAndClose); assert.deepEqual(writeAndClose.errors, [undefined, additional]); return true;
  });
  await poisonedSnapshot(owner, terminal.dataDir, terminal);
});

test("startNext rechecks expected after close without overwriting another cycle", async t => {
  const { directory, owner, discovered } = await discoveredFixture();
  const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
  const fresh = freshAttempt(terminal), foreign = freshAttempt(terminal), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); await fs.writeFile(path.join(directory, filename), JSON.stringify(foreign), "utf8"); });
    }
    return file;
  });
  await assert.rejects(owner.startNext(terminal, fresh), error => { failure(error, "REPLACE", "check-expected"); return true; });
  assert.deepEqual(await owner.read(), foreign); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

for (const mode of ["readback-failure", "foreign-fact"] as const) {
  test(`startNext reports stateReplaced on ${mode} and refuses to replay the old terminal`, async t => {
    const { directory, owner, discovered } = await discoveredFixture();
    const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
    const fresh = freshAttempt(terminal), foreign = freshAttempt(terminal), rename = fs.rename, open = fs.open;
    let failedRead = false;
    const primary = new Error("next-cycle post-rename failed");
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await rename(...args);
      if (mode === "readback-failure") failedRead = true;
      else await fs.writeFile(path.join(directory, filename), JSON.stringify(foreign), "utf8");
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (failedRead && args[0] === path.join(directory, filename)) { failedRead = false; throw primary; }
      return open(...args);
    });
    await assert.rejects(owner.startNext(terminal, fresh), error => {
      failure(error, "REPLACE", "verify-replaced", true); if (mode === "readback-failure") assert.equal(error.cause, primary); return true;
    });
    const observed = mode === "readback-failure" ? fresh : foreign;
    assert.deepEqual(await owner.read(), observed);
    await assert.rejects(owner.startNext(terminal, freshAttempt(terminal)), error => { failure(error, "REPLACE", "read-current"); return true; });
    assert.deepEqual(await owner.read(), observed); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
  });
}

for (const mode of ["alias", "root"] as const) {
  test(`startNext keeps the owner's real root identity after ${mode} replacement`, async () => {
    const { directory, owner, discovered } = await discoveredFixture();
    const terminal = await owner.replace(discovered, { ...discovered, revision: discovered.revision + 1, phase: "no-update" });
    const selected = mode === "alias" ? directory + ".alias" : directory;
    if (mode === "alias") await fs.symlink(directory, selected, "junction");
    const bound = store(selected); assert.deepEqual(await bound.read(), terminal);
    if (mode === "alias") {
      const foreign = await fixture(); await fs.unlink(selected); await fs.symlink(foreign.directory, selected, "junction");
    } else { await fs.rename(directory, directory + ".retained"); await fs.mkdir(directory); }
    await assert.rejects(bound.startNext(terminal, freshAttempt(terminal)), error => { failure(error, "REPLACE", "read-current"); return true; });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(mode === "root" ? directory + ".retained" : directory, filename), "utf8")), terminal);
    assert.equal(await store(mode === "root" ? directory : await fs.realpath(selected)).read(), null);
  });
}

test("schema2 persists an unselected discovery attempt and binds its target only once", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  const unselected = { ...attempt, schemaVersion: 2, target: null, candidateState: null, network: null };
  assert.deepEqual(await owner.replace(null, unselected), unselected);
  const selected = { ...unselected, revision: 1, target: attempt.target, candidateState: attempt.candidateState };
  assert.deepEqual(await owner.replace(unselected, selected), selected);
  await assert.rejects(owner.replace(selected, { ...unselected, revision: 2 }));
  await assert.rejects(owner.replace(selected, { ...selected, revision: 2, target: { ...attempt.target, installerSize: 456 } }));
});

test("schema2 network transitions reserve retries once and reject unresolved handoff", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  const initial = { ...attempt, schemaVersion: 2, network: null };
  await owner.replace(null, initial);
  const dispatching = { ...initial, revision: 1, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" } };
  await owner.replace(initial, dispatching);
  await assert.rejects(owner.replace(dispatching, { ...dispatching, revision: 2, phase: "handoff" }));
  const waiting = { ...dispatching, revision: 2, retriesUsed: 1, network: { ...dispatching.network, status: "waiting", delayMs: 1000, notBefore: 1234 } };
  await owner.replace(dispatching, waiting);
  await assert.rejects(owner.replace(waiting, { ...dispatching, revision: 3, retriesUsed: 2 }));
  assert.deepEqual(await owner.replace(waiting, { ...dispatching, revision: 3, retriesUsed: 1 }), { ...dispatching, revision: 3, retriesUsed: 1 });
});

test("durable adapter explicitly rejects schema1 without rewriting it", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory); await owner.replace(null, attempt);
  const entry = (implementation as Record<string, unknown>).createShellUpdateAttemptNetworkAdapter;
  assert.equal(typeof entry, "function", "durable adapter must exist");
  const adapter = (entry as (store: ShellUpdateAttemptStore) => { read(): Promise<unknown> })(owner);
  await assert.rejects(adapter.read(), { code: "DESKTOP_SHELL_NETWORK_STATE_UNSUPPORTED" });
  assert.deepEqual(await owner.read(), attempt);
});

test("schema2 rejects half selections and unsafe network fields before filesystem IO", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  const initial = { ...attempt, schemaVersion: 2, network: null };
  const dispatching = { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" };
  const accessor = { ...dispatching }; let getters = 0, io = 0;
  Object.defineProperty(accessor, "status", { get() { getters++; return "dispatching"; } });
  t.mock.method(fs, "realpath", async () => { io++; assert.fail("unexpected IO"); });
  for (const invalid of [
    { ...initial, target: null }, { ...initial, candidateState: null }, { ...initial, target: null, candidateState: null, phase: "handoff", revision: 1 },
    { ...initial, network: undefined }, { ...initial, network: accessor }, { ...initial, network: Object.create(dispatching) },
    ...[{ ...dispatching, actionKey: "" }, { ...dispatching, actionKey: "with space" }, { ...dispatching, requestSha256: "D".repeat(64) },
      { ...dispatching, status: "unknown" }, { ...dispatching, extra: true }, { ...dispatching, status: "waiting", delayMs: -1, notBefore: 10 },
      { ...dispatching, status: "waiting", delayMs: 10, notBefore: Infinity }, { ...dispatching, status: "waiting", delayMs: 1.5, notBefore: 10 },
      { ...dispatching, status: "succeeded", evidence: { kind: "unverified", sha256: "e".repeat(64) } },
      { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "short" } },
      { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64), extra: true } },
      { ...dispatching, status: "failed", errorCode: "bad code" }].map(network => ({ ...initial, revision: 2, network })),
  ]) await assert.rejects(owner.replace(null, invalid), error => { failure(error, "REPLACE", "input"); return true; });
  assert.equal(io, 0); assert.equal(getters, 0);
});

test("schema2 enforces action identity, immutable appointments, irreversible failure and handoff", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  let current: ShellUpdateAttemptV2 = { ...attempt, schemaVersion: 2, network: null };
  await owner.replace(null, current);
  const dispatching = { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" as const };
  const save = async (changes: object): Promise<void> => { current = await owner.replace(current, { ...current, revision: current.revision + 1, ...changes }) as ShellUpdateAttemptV2; };
  await assert.rejects(owner.replace(current, { ...current, revision: 1, retriesUsed: 1 }));
  await save({ network: dispatching });
  for (const network of [{ ...dispatching, actionKey: "other" }, { ...dispatching, requestSha256: "e".repeat(64) }, null,
    { ...dispatching, status: "waiting", delayMs: 1000, notBefore: 5000 }]) {
    await assert.rejects(owner.replace(current, { ...current, revision: 2, network }));
  }
  await save({ retriesUsed: 1, network: { ...dispatching, status: "waiting", delayMs: 1000, notBefore: 5000 } });
  for (const changes of [{ retriesUsed: 2 }, { network: { ...current.network, delayMs: 999 } }, { network: { ...current.network, notBefore: 0 } },
    { network: { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } }, { phase: "handoff" }]) {
    await assert.rejects(owner.replace(current, { ...current, revision: current.revision + 1, ...changes }));
  }
  await save({ network: dispatching });
  await save({ network: { ...dispatching, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } });
  await assert.rejects(owner.replace(current, { ...current, revision: current.revision + 1, network: { ...dispatching, status: "dispatching" } }));
  await save({ network: { ...dispatching, actionKey: "installer" } });
  await save({ phase: "failed", network: { ...dispatching, actionKey: "installer", status: "failed", errorCode: "VERIFY_FAILED" } });
  await assert.rejects(owner.replace(current, { ...current, revision: current.revision + 1, phase: "preparing" }));
  await assert.rejects(owner.replace(current, { ...current, revision: current.revision + 1, network: { ...dispatching, actionKey: "other" } }));
  assert.equal(current.retriesUsed, 1);
});

test("durable adapter snapshots expected and next before await and detects real revision conflicts", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  const initial: ShellUpdateAttemptV2 = { ...attempt, schemaVersion: 2, network: null };
  await owner.replace(null, initial);
  const adapter = createShellUpdateAttemptNetworkAdapter(owner), expected = await adapter.read();
  const changes = { retriesUsed: 0, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "dispatching" as const } };
  const pending = adapter.replace(expected, changes);
  expected.retriesUsed = 3; changes.network.actionKey = "mutated";
  const saved = await pending;
  assert.equal(saved.retriesUsed, 0); assert.equal(saved.network?.actionKey, "manifest");
  const disk = await owner.read(); assert.ok(disk && disk.schemaVersion === 2);
  assert.deepEqual(disk.originalState, initial.originalState); assert.deepEqual(disk.binding, initial.binding);
  assert.deepEqual(disk.target, initial.target); assert.equal(disk.requestId, initial.requestId);
  await owner.replace(disk, { ...disk, revision: disk.revision + 1 });
  await assert.rejects(adapter.replace(saved, { retriesUsed: 1, network: { actionKey: "manifest", requestSha256: "d".repeat(64), status: "waiting", delayMs: 1, notBefore: 1 } }), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
});

test("creates and rereads the unique attempt without losing the original previous shell", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  assert.equal(await owner.read(), null);
  assert.deepEqual(await owner.replace(null, attempt), attempt);
  assert.deepEqual(await store(directory).read(), attempt);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
  const handoff = next(attempt, { phase: "handoff" });
  assert.deepEqual(await owner.replace(attempt, handoff), handoff);
  assert.equal((await owner.read())?.originalState.previousShellId, "shell-older");
});

test("accepts an explicit installation binding with the fixed baseline and actual health", async () => {
  const { directory, attempt } = await fixture();
  attempt.binding = { kind: "installation", baselineShellId: "installation", health: clone(attempt.binding.health) };
  assert.deepEqual(await store(directory).replace(null, attempt), attempt);
});

test("preserves the existing HTTP request identity including colon and plus characters", async () => {
  for (const requestId of ["request:original+retry.1", "CON", "a".repeat(128)]) {
    const { directory, attempt } = await fixture();
    attempt.requestId = requestId;
    assert.deepEqual(await store(directory).replace(null, attempt), attempt);
    assert.equal((await store(directory).read())?.requestId, requestId);
  }
});

test("rejects request identity character and length boundaries before IO", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  let io = 0;
  t.mock.method(fs, "realpath", async () => { io++; throw new Error("unexpected IO"); });
  for (const requestId of ["", "a".repeat(129), "+starts", ":starts", "_starts", "-starts", ".starts", "with space", "a/b", "a\\b", "a\n", "中文"]) {
    await assert.rejects(owner.replace(null, { ...attempt, requestId }), error => { failure(error, "REPLACE", "input"); return true; });
  }
  assert.equal(io, 0);
});

test("copies all caller data before the first await and returns independent snapshots", async () => {
  const { directory, attempt } = await fixture(), expected = clone(attempt), owner = store(directory);
  const pending = owner.replace(null, attempt);
  attempt.target.shellId = "mutated"; attempt.binding.health.clientVersion = "mutated";
  attempt.originalState.previousShellId = "mutated"; attempt.dataDir = "mutated";
  const result = await pending;
  assert.deepEqual(result, expected);
  result.binding.health.clientVersion = "mutated-result";
  assert.deepEqual(await owner.read(), expected);
  const candidate = next(expected), pendingNext = owner.replace(expected, candidate);
  expected.requestId = "changed"; candidate.binding.health.clientVersion = "changed";
  assert.equal((await pendingNext).binding.health.clientVersion, "1.2.3");
});

test("rejects unknown fields, accessors, prototypes and invalid nested values before IO", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  let io = 0, getters = 0;
  t.mock.method(fs, "realpath", async () => { io++; throw new Error("unexpected IO"); });
  const accessor = clone(attempt);
  Object.defineProperty(accessor.target, "shellId", { get() { getters++; return "shell-new"; } });
  for (const invalid of [null, [], {}, { ...attempt, extra: true }, { ...attempt, [Symbol("extra")]: true },
    Object.create(attempt), accessor, { ...attempt, phase: "completed" }, { ...attempt, revision: 1 },
    { ...attempt, retriesUsed: 1 }, { ...attempt, dataDir: `${directory}${path.sep}..${path.sep}other` },
    { ...attempt, binding: { ...attempt.binding, health: { ...attempt.binding.health, database: "unknown" } } },
    { ...attempt, target: { ...attempt.target, installerSize: 0 } },
    { ...attempt, candidateState: { ...attempt.candidateState, previousShellId: "shell-older" } },
    { ...attempt, candidateState: { ...attempt.candidateState, baselineShellId: "other" } },
    { ...attempt, target: { ...attempt.target, shellId: "shell-old" } },
    { ...attempt, binding: { kind: "installation", baselineShellId: "other", health: attempt.binding.health } }]) {
    await assert.rejects(owner.replace(null, invalid), error => { failure(error, "REPLACE", "input"); return true; });
  }
  assert.equal(io, 0); assert.equal(getters, 0);
});

test("rejects a record whose data directory differs from the real store root", async () => {
  const { directory, attempt } = await fixture();
  attempt.dataDir = path.join(directory, "other");
  await assert.rejects(store(directory).replace(null, attempt), error => { failure(error, "REPLACE", "read-current"); return true; });
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth"]);
});

test("never treats a missing or replaced root as an empty attempt", async t => {
  const { directory } = await fixture();
  await assert.rejects(store(path.join(directory, "missing")).read(), error => { failure(error, "READ", "read"); return true; });
  const lstat = fs.lstat; let removed = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === path.join(directory, filename) && !removed) {
      removed = true; await fs.rename(directory, directory + ".retained"); await fs.mkdir(directory);
    }
    return await lstat(...args);
  });
  await assert.rejects(store(directory).read(), error => { failure(error, "READ", "read"); return true; });
});

for (const mode of ["retargeted-alias", "replaced-root"] as const) {
  for (const operation of ["read", "replace"] as const) {
    test(`keeps the owner's first real root on ${mode} before a later ${operation}`, async () => {
      const { directory, attempt } = await fixture();
      await store(directory).replace(null, attempt);
      const selected = mode === "retargeted-alias" ? directory + ".selected" : directory;
      if (mode === "retargeted-alias") await fs.symlink(directory, selected, "junction");
      const owner = store(selected);
      assert.deepEqual(await owner.read(), attempt);
      let foreign: ShellUpdateAttempt;
      if (mode === "retargeted-alias") {
        const other = await fixture(); foreign = { ...other.attempt, requestId: "foreign-request" };
        await store(other.directory).replace(null, foreign);
        await fs.unlink(selected); await fs.symlink(other.directory, selected, "junction");
      } else {
        await fs.rename(directory, directory + ".retained"); await fs.mkdir(directory);
        foreign = { ...attempt, requestId: "foreign-request" };
        await fs.writeFile(path.join(directory, filename), JSON.stringify(foreign), "utf8");
      }
      await assert.rejects(operation === "read" ? owner.read() : owner.replace(foreign, next(foreign)), error => {
        failure(error, operation === "read" ? "READ" : "REPLACE", operation === "read" ? "read" : "read-current"); return true;
      });
      assert.deepEqual(await store(foreign.dataDir).read(), foreign);
    });
  }
}

test("does not bind a missing root and can retry after that directory is created", async () => {
  const { directory, attempt } = await fixture(), selected = path.join(directory, "later-created"), owner = store(selected);
  await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
  await fs.mkdir(selected);
  assert.equal(await owner.read(), null);
  const real = await fs.realpath(selected), created = { ...attempt, dataDir: real };
  assert.deepEqual(await owner.replace(null, created), created);
});

test("can reread a repaired snapshot through the same bound owner", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await fs.writeFile(target, "invalid-json", "utf8");
  await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
  await fs.writeFile(target, JSON.stringify(attempt), "utf8");
  assert.deepEqual(await owner.read(), attempt);
});

test("preserves an existing attempt on expected conflicts and serializes one owner's concurrent calls", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  const first = next(attempt, { retriesUsed: 1 }), second = next(attempt, { phase: "handoff" });
  const results = await Promise.allSettled([owner.replace(attempt, first), owner.replace(attempt, second)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") failure(results[1].reason, "REPLACE", "read-current");
  await assert.rejects(owner.replace(null, attempt));
  assert.deepEqual(await owner.read(), first);
});

test("permits only revision steps, immutable identity and bounded preparing retry increments", async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  const mutations: Partial<ShellUpdateAttempt>[] = [
    { revision: 0 }, { revision: 2 }, { requestId: "other" }, { installationDir: path.join(directory, "other") },
    { userDataDir: path.join(directory, "other") }, { sessionDataDir: path.join(directory, "other") },
    { target: { ...attempt.target, manifestSha256: "d".repeat(64) } },
    { target: { ...attempt.target, installerSha256: "d".repeat(64) } }, { target: { ...attempt.target, installerSize: 124 } },
    { binding: { ...attempt.binding, health: { ...attempt.binding.health, dbSchemaVersion: 8 } } },
    { binding: { kind: "active", releaseId: "different", packageSha256: "c".repeat(64), health: attempt.binding.health } },
    { originalState: { ...attempt.originalState, previousShellId: null } }, { retriesUsed: -1 }, { retriesUsed: 2 },
    { phase: "handoff", retriesUsed: 1 }, { phase: "failed", retriesUsed: 1 }
  ];
  for (const changes of mutations) await assert.rejects(owner.replace(attempt, next(attempt, changes)), error => {
    failure(error, "REPLACE", "input"); return true;
  });
  let current: AnyAttempt = attempt;
  for (const retriesUsed of [1, 2, 3]) current = await owner.replace(current, next(current, { retriesUsed }));
  await assert.rejects(owner.replace(current, next(current, { retriesUsed: 4 })));
  await assert.rejects(owner.replace(current, next(current, { retriesUsed: 2 })));
  const handoff = await owner.replace(current, next(current, { phase: "handoff" }));
  await assert.rejects(owner.replace(handoff, next(handoff, { phase: "preparing" })));
  const failed = await owner.replace(handoff, next(handoff, { phase: "failed" }));
  await assert.rejects(owner.replace(failed, next(failed, { phase: "handoff" })));
  assert.deepEqual(await owner.replace(failed, next(failed)), next(failed));
});

test("classifies only exact original or candidate INI facts and always requires runtime verification", async () => {
  const { attempt } = await fixture();
  const entry = (implementation as Record<string, unknown>).classifyShellUpdateAttemptPosition;
  assert.equal(typeof entry, "function", "classifyShellUpdateAttemptPosition must exist");
  const classify = entry as (attempt: unknown, actual: unknown) => unknown;
  for (const phase of ["preparing", "handoff", "failed"] as const) {
    const snapshot = { ...attempt, revision: phase === "preparing" ? 0 : 1, phase };
    assert.deepEqual(classify(snapshot, attempt.originalState), { position: "original", requiresRuntimeVerification: true });
    assert.deepEqual(classify(snapshot, attempt.candidateState), { position: "candidate", requiresRuntimeVerification: true });
  }
  assert.throws(() => classify(attempt, { ...attempt.originalState, previousShellId: null }),
    error => error instanceof Error && "code" in error && error.code === "DESKTOP_SHELL_UPDATE_ATTEMPT_POSITION_CONFLICT");
});

test("rejects malformed UTF8, truncation, overlong bytes and unknown persisted fields", async () => {
  for (const mode of ["utf8", "truncated", "oversize", "unknown", "invalid-health"] as const) {
    const { directory, attempt } = await fixture(), owner = store(directory);
    await owner.replace(null, attempt);
    const content = mode === "utf8" ? Buffer.from([0xc3, 0x28]) : mode === "truncated" ? Buffer.from('{"schemaVersion":')
      : mode === "oversize" ? Buffer.alloc(65537, 0x20)
      : Buffer.from(JSON.stringify(mode === "unknown" ? { ...attempt, extra: true }
        : { ...attempt, binding: { ...attempt.binding, health: { ...attempt.binding.health, protocolVersion: 2 } } }));
    await fs.writeFile(path.join(directory, filename), content);
    await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
    assert.deepEqual(await fs.readFile(path.join(directory, filename)), content);
  }
});

test("rejects hard links and linked file metadata without treating them as empty", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await owner.replace(null, attempt); await fs.link(target, target + ".retained");
  await assert.rejects(owner.read()); await fs.unlink(target + ".retained");
  const lstat = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args); if (args[0] === target) stat.isSymbolicLink = () => true; return stat;
  });
  await assert.rejects(owner.read());
});

test("reads the valid opened entity after replacement between lstat and open", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await owner.replace(null, attempt);
  const open = fs.open, replacement = next(attempt, { phase: "failed" });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === target) { await fs.rename(target, target + ".retained"); await fs.writeFile(target, JSON.stringify(replacement), "utf8"); }
    return await open(...args);
  });
  assert.deepEqual(await owner.read(), replacement);
});

test("returns the verified snapshot when a valid replacement occurs during close", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await owner.replace(null, attempt);
  const open = fs.open, replacement = next(attempt, { phase: "failed" });
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === target) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        await close(); await fs.rename(target, target + ".retained");
        await fs.writeFile(target, JSON.stringify(replacement), "utf8");
      });
    }
    return file;
  });
  assert.deepEqual(await owner.read(), attempt);
  mock.mock.restore();
  assert.deepEqual(await owner.read(), replacement);
});

test("returns its verified snapshot before close damage and rejects that damage on the next read", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await owner.replace(null, attempt);
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === target) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); await fs.writeFile(target, Buffer.from([0xc3, 0x28])); });
    }
    return file;
  });
  assert.deepEqual(await owner.read(), attempt);
  mock.mock.restore();
  await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
});

for (const mode of ["entity", "content", "hardlink", "root"] as const) {
  test(`reader rejects ${mode} changes while its handle is being verified`, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
    await owner.replace(null, attempt);
    const open = fs.open, lstat = fs.lstat;
    let reading = false, changed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === target) {
        const read = file.read.bind(file);
        t.mock.method(file, "read", async (...input: Parameters<typeof file.read>) => { reading = true; return await read(...input); });
      }
      return file;
    });
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args) as BigIntStats;
      if (reading && !changed && args[0] === (mode === "root" ? directory : target)) {
        changed = true;
        if (mode === "entity" || mode === "root") Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
        else if (mode === "content") Object.defineProperty(stat, "mtimeNs", { value: stat.mtimeNs + 1n });
        else Object.defineProperty(stat, "nlink", { value: 2n });
      }
      return stat;
    });
    await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
    assert.equal(changed, true);
  });
}

test("reader still rejects root identity changes after a successful close", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), target = path.join(directory, filename);
  await owner.replace(null, attempt);
  const open = fs.open, lstat = fs.lstat;
  let closed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), close = file.close.bind(file);
    if (args[0] === target) t.mock.method(file, "close", async () => { await close(); closed = true; });
    return file;
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args) as BigIntStats;
    if (closed && args[0] === directory) Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
    return stat;
  });
  await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); return true; });
});

/** 原生 rename 的结构字段用于窄错误门禁，正文不参与分类。 */
function renameFailure(source: string, destination: string, code = "EPERM") {
  return Object.assign(new Error("native rename failure"), { code, errno: code === "EPERM" ? -4048 : -5, syscall: "rename", path: source, dest: destination });
}

test("Windows rename retries transient EPERM with the same temporary and expected snapshots", { skip: process.platform !== "win32" }, async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), rename = fs.rename;
  await owner.replace(null, attempt);
  const requested = next(attempt), sources: string[] = [];
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    sources.push(String(args[0]));
    if (sources.length < 3) throw renameFailure(String(args[0]), String(args[1]));
    await rename(...args);
  });
  assert.deepEqual(await owner.replace(attempt, requested), requested);
  assert.equal(sources.length, 3); assert.equal(new Set(sources).size, 1);
  assert.deepEqual(await owner.read(), requested); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("Windows rename exhausts its monotonic scheduling budget and preserves the first native cause", { skip: process.platform !== "win32" }, async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  let now = 0; const native: Error[] = [];
  t.mock.method(performance, "now", () => now);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const error = renameFailure(String(args[0]), String(args[1])); native.push(error); now += 400; throw error;
  });
  await assert.rejects(owner.replace(attempt, next(attempt)), error => {
    failure(error, "REPLACE", "replace"); assert.equal(error.requestId, attempt.requestId);
    assert.ok(error.cause instanceof Error);
    const exhausted = error.cause as Error & { attempts: number; elapsedMs: number; lastCause: unknown };
    assert.equal(exhausted.cause, native[0]); assert.equal(exhausted.attempts, 3);
    assert.equal(exhausted.elapsedMs, 1200); assert.equal(exhausted.lastCause, native[2]); return true;
  });
  assert.equal(native.length, 3); assert.deepEqual(await owner.read(), attempt);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("Windows rename validation time consumes the budget before another rename can start", { skip: process.platform !== "win32" }, async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), open = fs.open;
  await owner.replace(null, attempt);
  let now = 0, attempts = 0, validating = false;
  t.mock.method(performance, "now", () => now);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { attempts++; validating = true; throw renameFailure(String(args[0]), String(args[1])); });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (validating) now = 1000; return file;
  });
  await assert.rejects(owner.replace(attempt, next(attempt)), error => { failure(error, "REPLACE", "replace"); return true; });
  assert.equal(attempts, 1); assert.deepEqual(await owner.read(), attempt);
});

test("rename does not start its first attempt after initial validation has exhausted the scheduling budget", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), rename = fs.rename;
  await owner.replace(null, attempt);
  let clockReads = 0, attempts = 0;
  t.mock.method(performance, "now", () => ++clockReads === 1 ? 0 : 1000);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { attempts++; await rename(...args); });
  await assert.rejects(owner.replace(attempt, next(attempt)), error => {
    failure(error, "REPLACE", "replace");
    assert.equal((error.cause as Error & { attempts: number }).attempts, 0); return true;
  });
  assert.equal(attempts, 0); assert.deepEqual(await owner.read(), attempt);
});

for (const mode of ["code", "syscall", "source", "destination", "platform", "message"] as const) {
  test(`rename does not retry an unqualified ${mode} error`, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory);
    await owner.replace(null, attempt);
    let attempts = 0, primary: Error | undefined;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    if (mode === "platform") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        attempts++; const error = renameFailure(String(args[0]), String(args[1]), mode === "code" ? "EIO" : "EPERM");
        if (mode === "syscall") error.syscall = "open";
        if (mode === "source") error.path += ".foreign";
        if (mode === "destination") error.dest += ".foreign";
        primary = mode === "message" ? new Error("EPERM: operation not permitted, rename") : error; throw primary;
      });
      await assert.rejects(owner.replace(attempt, next(attempt)), error => {
        if (mode === "platform") assert.equal((error as { code?: unknown }).code, "DESKTOP_SHELL_UPDATE_COORDINATOR_PLATFORM_UNSUPPORTED");
        else { failure(error, "REPLACE", "replace"); assert.equal(error.cause, primary); }
        return true;
      });
      assert.equal(attempts, mode === "platform" ? 0 : 1);
      Object.defineProperty(process, "platform", platform); assert.deepEqual(await owner.read(), attempt);
    } finally { Object.defineProperty(process, "platform", platform); }
  });
}

for (const mode of ["expected", "root", "temporary-entity", "temporary-content", "temporary-hardlink", "temporary-bytes", "temporary-read", "temporary-close", "read", "close"] as const) {
  test(`Windows rename retry stops on changed ${mode} and preserves the original native error`, { skip: process.platform !== "win32" }, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory), open = fs.open, lstat = fs.lstat;
    await owner.replace(null, attempt);
    const target = path.join(directory, filename), third = { ...attempt, retriesUsed: 1 };
    let attempts = 0, retried = false, temporary = "", primary: Error | undefined;
    const additional = new Error(`retry ${mode} failed`);
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      attempts++; temporary = String(args[0]);
      if (mode === "expected") await fs.writeFile(target, JSON.stringify(third), "utf8");
      if (mode === "temporary-content") await fs.writeFile(temporary, "changed", "utf8");
      if (mode === "temporary-hardlink") await fs.link(temporary, temporary + ".retained");
      retried = true; primary = renameFailure(temporary, String(args[1])); throw primary;
    });
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args) as BigIntStats;
      if (retried && args[0] === (mode === "root" ? directory : mode === "temporary-entity" ? temporary : "")) Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
      return stat;
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (retried && args[0] === temporary && (mode === "temporary-read" || mode === "temporary-bytes")) {
        const read = file.read.bind(file);
        t.mock.method(file, "read", async (...input: Parameters<typeof file.read>) => {
          if (mode === "temporary-read") throw additional;
          const result = await read(...input);
          if (result.bytesRead > 0) { const buffer = result.buffer as Buffer; buffer[0] = buffer[0]! ^ 1; }
          return result;
        });
      }
      if (retried && args[0] === temporary && mode === "temporary-close") {
        const close = file.close.bind(file); t.mock.method(file, "close", async () => { await close(); throw additional; });
      }
      if (retried && args[0] === target && mode === "read") t.mock.method(file, "read", async () => { throw additional; });
      if (retried && args[0] === target && mode === "close") {
        const close = file.close.bind(file); t.mock.method(file, "close", async () => { await close(); throw additional; });
      }
      return file;
    });
    await assert.rejects(owner.replace(attempt, next(attempt)), error => {
      failure(error, "REPLACE", "replace"); assert.ok(causes(error).includes(primary));
      if (["read", "close", "temporary-read", "temporary-close"].includes(mode)) assert.ok(causes(error).includes(additional)); return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), mode === "expected" ? third : attempt);
  });
}

test("Windows retry preserves an unqualified later error and cleanup failure without another rename", { skip: process.platform !== "win32" }, async t => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  let attempts = 0, primary: Error | undefined;
  const later = new Error("later rename failure"), cleanup = new Error("retry cleanup failure");
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    attempts++; if (attempts === 1) { primary = renameFailure(String(args[0]), String(args[1])); throw primary; } throw later;
  });
  t.mock.method(fs, "unlink", async () => { throw cleanup; });
  await assert.rejects(owner.replace(attempt, next(attempt)), error => {
    failure(error, "REPLACE", "replace");
    for (const cause of [primary, later, cleanup]) assert.ok(causes(error).includes(cause)); return true;
  });
  assert.equal(attempts, 2); assert.deepEqual(await owner.read(), attempt);
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, 1);
});

test("Windows rename succeeds after a real reader releases its handle", { skip: process.platform !== "win32" }, async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  const reader = await fs.open(path.join(directory, filename), "r"), requested = next(attempt);
  const closing = new Promise<void>((resolve, reject) => setTimeout(() => reader.close().then(resolve, reject), 100));
  const [, observed] = await Promise.all([closing, owner.replace(attempt, requested)]);
  assert.deepEqual(observed, requested); assert.deepEqual(await owner.read(), requested);
});

test("Windows rename fails explicitly while a real reader remains locked throughout its budget", { skip: process.platform !== "win32" }, async () => {
  const { directory, attempt } = await fixture(), owner = store(directory);
  await owner.replace(null, attempt);
  const reader = await fs.open(path.join(directory, filename), "r"), started = performance.now();
  try {
    await assert.rejects(owner.replace(attempt, next(attempt)), error => {
      failure(error, "REPLACE", "replace"); assert.equal(error.requestId, attempt.requestId);
      const exhausted = error.cause as Error & { attempts: number; elapsedMs: number; lastCause: unknown };
      assert.equal((exhausted.cause as NodeJS.ErrnoException).code, "EPERM");
      assert.ok(exhausted.attempts > 1); assert.ok(exhausted.elapsedMs >= 1000);
      assert.equal((exhausted.lastCause as NodeJS.ErrnoException).syscall, "rename"); return true;
    });
  } finally { await reader.close(); }
  assert.ok(performance.now() - started >= 1000);
  assert.deepEqual(await owner.read(), attempt); assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("Windows retry marks replacement before a subsequent strict readback failure", { skip: process.platform !== "win32" }, async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), rename = fs.rename, open = fs.open;
  await owner.replace(null, attempt);
  let attempts = 0, replaced = false;
  const readFailure = new Error("retry post-rename read failure"), requested = next(attempt);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (++attempts === 1) throw renameFailure(String(args[0]), String(args[1]));
    await rename(...args); replaced = true;
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (replaced && args[0] === path.join(directory, filename)) throw readFailure;
    return await open(...args);
  });
  await assert.rejects(owner.replace(attempt, requested), error => {
    failure(error, "REPLACE", "verify-replaced", true); assert.equal(error.cause, readFailure); return true;
  });
  assert.equal(attempts, 2); assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, filename), "utf8")), requested);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("keeps the known requestId when a copied next snapshot violates transition rules", async () => {
  const { directory, attempt } = await fixture();
  await assert.rejects(store(directory).replace(attempt, next(attempt, { revision: 4 })), error => {
    failure(error, "REPLACE", "input"); assert.equal(error.requestId, attempt.requestId); return true;
  });
});

test("reads through short reads and completes short writes before sync, close and rename", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), open = fs.open, rename = fs.rename;
  const events: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), read = file.read.bind(file);
    t.mock.method(file, "read", async (bytes: Buffer, offset: number, length: number, position: number) =>
      await read(bytes, offset, Math.min(length, 7), position));
    if (String(args[0]).endsWith(".tmp")) {
      const write = file.write.bind(file), sync = file.sync.bind(file), close = file.close.bind(file);
      t.mock.method(file, "write", async (bytes: Buffer, offset: number, length: number, position: number) => {
        events.push("write"); return await write(bytes, offset, Math.min(length, 3), position);
      });
      t.mock.method(file, "sync", async () => { events.push("sync"); await sync(); });
      t.mock.method(file, "close", async () => { events.push("close"); await close(); });
    }
    return file;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { events.push("rename"); await rename(...args); });
  assert.deepEqual(await owner.replace(null, attempt), attempt);
  assert.ok(events.filter(event => event === "write").length > 1);
  assert.deepEqual(events.slice(-3), ["sync", "close", "rename"]);
});

for (const phase of ["write-temp", "sync-temp", "close-temp", "replace"] as const) {
  test(`keeps the prior snapshot and native cause on ${phase} failure`, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory);
    await owner.replace(null, attempt);
    const open = fs.open, native = Object.assign(new Error("private native failure"), { code: "EIO" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (phase === "write-temp") t.mock.method(file, "write", async () => { throw native; });
        if (phase === "sync-temp") t.mock.method(file, "sync", async () => { throw native; });
        if (phase === "close-temp") {
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { await close(); throw native; });
        }
      }
      return file;
    });
    if (phase === "replace") t.mock.method(fs, "rename", async () => { throw native; });
    await assert.rejects(owner.replace(attempt, next(attempt)), error => {
      failure(error, "REPLACE", phase); assert.equal(error.requestId, attempt.requestId);
      assert.ok(causes(error).includes(native)); assert.equal(error.message.includes("private native failure"), false); return true;
    });
    if (phase === "close-temp") await poisonedSnapshot(owner, directory, attempt);
    else assert.deepEqual(await owner.read(), attempt);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, phase === "close-temp" ? 1 : 0);
  });
}

for (const secondary of ["close", "cleanup"] as const) {
  test(`retains both write and ${secondary} failures`, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory), open = fs.open;
    const primary = Object.assign(new Error("primary"), { code: "ENOSPC" }), additional = Object.assign(new Error("secondary"), { code: "EBUSY" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        t.mock.method(file, "write", async () => { throw primary; });
        if (secondary === "close") {
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { await close(); throw additional; });
        }
      }
      return file;
    });
    if (secondary === "cleanup") t.mock.method(fs, "unlink", async () => { throw additional; });
    await assert.rejects(owner.replace(null, attempt), error => {
      failure(error, "REPLACE", "write-temp"); assert.ok(causes(error).includes(primary)); assert.ok(causes(error).includes(additional)); return true;
    });
    if (secondary === "close") await poisonedSnapshot(owner, directory, null);
    else assert.equal(await owner.read(), null);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, 1);
  });
}

test("preserves read and close causes at the reader boundary", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory); await owner.replace(null, attempt);
  const open = fs.open, primary = new Error("read failure"), additional = new Error("close failure");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), close = file.close.bind(file);
    t.mock.method(file, "read", async () => { throw primary; });
    t.mock.method(file, "close", async () => { await close(); throw additional; }); return file;
  });
  await assert.rejects(owner.read(), error => {
    failure(error, "READ", "read"); assert.ok(causes(error).includes(primary)); assert.ok(causes(error).includes(additional)); return true;
  });
});

for (const primary of [undefined, null, false]) {
  test(`preserves a thrown ${String(primary)} read cause together with a close failure`, async t => {
    const { directory, attempt } = await fixture(), owner = store(directory); await owner.replace(null, attempt);
    const open = fs.open, additional = new Error("secondary close failure");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args), close = file.close.bind(file);
      t.mock.method(file, "read", async () => { throw primary; });
      t.mock.method(file, "close", async () => { await close(); throw additional; }); return file;
    });
    await assert.rejects(owner.read(), error => {
      failure(error, "READ", "read");
      assert.ok(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [primary, additional]); return true;
    });
  });
}

test("keeps a standalone reader close failure as an explicit failure", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory); await owner.replace(null, attempt);
  const open = fs.open, additional = new Error("standalone close failure");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), close = file.close.bind(file);
    t.mock.method(file, "close", async () => { await close(); throw additional; }); return file;
  });
  await assert.rejects(owner.read(), error => { failure(error, "READ", "read"); assert.equal(error.cause, additional); return true; });
});

test("rejects zero-progress writes and changed temporary content before publication", async t => {
  const open = fs.open; let mode = "zero";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      if (mode === "zero") t.mock.method(file, "write", async () => ({ bytesWritten: 0 }));
      else { const sync = file.sync.bind(file); t.mock.method(file, "sync", async () => { await sync(); await fs.writeFile(args[0], "changed", "utf8"); }); }
    }
    return file;
  });
  for (mode of ["zero", "changed"]) {
    const { directory, attempt } = await fixture();
    await assert.rejects(store(directory).replace(null, attempt), error => {
      failure(error, "REPLACE", mode === "zero" ? "write-temp" : "verify-temp"); return true;
    });
    assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth"]);
  }
});

test("rechecks expected after close and preserves an externally written snapshot", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory); await owner.replace(null, attempt);
  const third = next(attempt, { phase: "failed" }), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); await fs.writeFile(path.join(directory, filename), JSON.stringify(third), "utf8"); });
    }
    return file;
  });
  await assert.rejects(owner.replace(attempt, next(attempt)), error => { failure(error, "REPLACE", "check-expected"); return true; });
  assert.deepEqual(await owner.read(), third);
  assert.deepEqual(await fs.readdir(directory), [".shell-update-file-auth", filename]);
});

test("never removes substituted or hard-linked temporary files", async t => {
  const open = fs.open; let mode = "substituted", temporary = "";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      temporary = String(args[0]);
      if (mode === "hardlink") await fs.link(temporary, temporary + ".retained");
      else { const close = file.close.bind(file); t.mock.method(file, "close", async () => {
        await close(); await fs.rename(temporary, temporary + ".retained"); await fs.writeFile(temporary, "foreign", "utf8");
      }); }
    }
    return file;
  });
  for (mode of ["substituted", "hardlink"]) {
    const { directory, attempt } = await fixture(); await assert.rejects(store(directory).replace(null, attempt));
    assert.equal(mode === "substituted" ? await fs.readFile(temporary, "utf8") : (await fs.stat(temporary)).nlink,
      mode === "substituted" ? "foreign" : 2);
  }
});

test("exclusive creation failure never deletes the preexisting temporary name", async t => {
  const { directory, attempt } = await fixture(), open = fs.open; let temporary = "";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".tmp")) { temporary = String(args[0]); await fs.writeFile(temporary, "preexisting", "utf8"); }
    return await open(...args);
  });
  await assert.rejects(store(directory).replace(null, attempt), error => { failure(error, "REPLACE", "create-temp"); return true; });
  assert.equal(await fs.readFile(temporary, "utf8"), "preexisting");
});

test("marks post-rename read failure and gives up ownership of the old temporary name", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), rename = fs.rename, open = fs.open;
  let committed = false, temporary = "";
  const native = new Error("post-rename read failure");
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); committed = true; temporary = String(args[0]); await fs.writeFile(temporary, "new foreign", "utf8");
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (committed && args[0] === path.join(directory, filename)) throw native; return await open(...args);
  });
  await assert.rejects(owner.replace(null, attempt), error => {
    failure(error, "REPLACE", "verify-replaced", true); assert.ok(causes(error).includes(native)); return true;
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, filename), "utf8")), attempt);
  assert.equal(await fs.readFile(temporary, "utf8"), "new foreign");
});

test("post-rename mismatch reports replacement without overwriting the observed third-party fact", async t => {
  const { directory, attempt } = await fixture(), owner = store(directory), rename = fs.rename;
  const third = next(attempt, { phase: "failed" });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); await fs.writeFile(path.join(directory, filename), JSON.stringify(third), "utf8");
  });
  await assert.rejects(owner.replace(null, attempt), error => { failure(error, "REPLACE", "verify-replaced", true); return true; });
  assert.deepEqual(await owner.read(), third);
});
