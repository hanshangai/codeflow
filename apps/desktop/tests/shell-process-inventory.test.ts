import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";

const source = fileURLToPath(new URL("../src/shellProcessInventory.ts", import.meta.url));
const module = existsSync(source) ? await import("../src/shellProcessInventory.js") : {};

/** 每例通过真实模块入口核验行为；缺模块给出有意义的合同失败。 */
function api(): typeof import("../src/shellProcessInventory.js") {
  assert.equal(typeof (module as Record<string, unknown>).createProcessInventory, "function", "persistent lifecycle inventory must exist");
  return module as typeof import("../src/shellProcessInventory.js");
}

/** 完整实例身份采用绝对路径，测试不触碰操作系统进程。 */
function identity(pid: number, parentPid: number, created = 1000 + pid): ProcessIdentity {
  return { pid, parentPid, created, executable: path.resolve("inventory-test.exe"), commandLine: `process-${pid}` };
}
const helper = identity(10, 1), roots = [helper], parent = identity(20, 10), child = identity(30, 20);

/** RED沿原严格入口复现行为；新预检只返回待采，不修改持久库存。 */
function preflight(input: { inventory: import("../src/shellProcessInventory.js").ShellProcessInventory; roots: ProcessIdentity[];
  processes: ProcessIdentity[]; revision: number; known: ProcessIdentity[]; excluded?: ProcessIdentity[] }): readonly ProcessIdentity[] {
  const core = api(), entry = (core as Record<string, unknown>).preflightProcessInventory;
  if (typeof entry === "function") return entry(input);
  core.assertProcessInventoryReleased({ ...input, excluded: [...input.roots, ...input.inventory.owned, ...(input.excluded ?? [])] });
  return [];
}

test("snapshot preflight returns only a new path-partial child without claiming or releasing", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const before = structuredClone(inventory), partial = { ...child, executable: "" }, grandchild = identity(40, child.pid);
  assert.deepEqual(preflight({ inventory, roots, processes: [helper, parent, partial, grandchild], revision: 2, known: [helper, parent] }), [partial]);
  assert.deepEqual(inventory, before);
  assert.throws(() => core.observeProcessInventory({ inventory, roots, processes: [helper, parent, partial], observer: helper, revision: 2 }));
});

test("system snapshot keeps an unrelated absolute path with dot segments", () => {
  const core = api(), helper = identity(10, 1), inventory = core.createProcessInventory({ owned: [], roots: [helper], processes: [helper], observer: helper, revision: 1 });
  const foreign = { ...helper, pid: 40, parentPid: 999, created: 1, executable: "D:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe", commandLine: "bash" };
  assert.doesNotThrow(() => core.assertProcessInventoryReleased({ inventory, roots: [helper], processes: [helper, foreign], excluded: [helper] }));
  assert.throws(() => core.processInstanceKey(foreign));
  assert.throws(() => core.createProcessInventory({ owned: [foreign], roots: [helper], processes: [helper, foreign], observer: helper, revision: 1 }));
  assert.throws(() => core.observeProcessInventory({ inventory, roots: [helper], processes: [helper, { ...foreign, parentPid: helper.pid, created: helper.created + 1 }], observer: helper, revision: 2 }));
  assert.throws(() => core.assertProcessInventoryReleased({ inventory, roots: [helper], processes: [{ ...helper, executable: foreign.executable }], excluded: [helper] }));
  for (const executable of ["relative.exe", "D:relative.exe", "D:\\bad\0.exe", "D:\\" + "x".repeat(4096), "D:\\bad\ud800.exe"]) {
    assert.throws(() => core.assertProcessInventoryReleased({ inventory, roots: [helper], processes: [helper, { ...foreign, executable }], excluded: [helper] }));
  }
  assert.deepEqual(inventory.owned, []);
});

test("snapshot preflight returns a new child with both text fields temporarily missing", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const before = structuredClone(inventory), partial = { ...child, executable: "", commandLine: "" };
  assert.deepEqual(preflight({ inventory, roots, processes: [helper, parent, partial], revision: 2, known: [helper, parent] }), [partial]);
  assert.deepEqual(inventory, before);
});

for (const field of ["executable", "commandLine"] as const) test(`snapshot preflight preserves known ${field} partial without promoting it`, () => {
  const inventory = api().createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const partial = { ...parent, [field]: "" };
  assert.deepEqual(preflight({ inventory, roots, processes: [helper, partial, child], revision: 2, known: [helper, parent] }), []);
  assert.deepEqual(inventory.owned, [parent]);
});

for (const defect of ["created", "missing-parent", "partial-parent", "role", "active", "released", "released-partial"] as const)
for (const reverse of [false, true]) test(`snapshot preflight rejects ${defect} before returning pending in ${reverse ? "reverse" : "forward"} order`, () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const inventory = defect.startsWith("released") ? core.observeProcessInventory({ inventory: first, roots, processes: [helper], observer: helper, revision: 2 }) : first;
  const pending = { ...identity(50, helper.pid), executable: "" }, invalidChild = { ...child, executable: "",
    ...(defect === "created" ? { created: 0 } : {}) };
  const processes = defect === "missing-parent" ? [helper, pending, invalidChild]
    : defect === "partial-parent" ? [helper, pending, { ...parent, executable: "" }, invalidChild]
      : defect === "role" ? [parent, pending, { ...helper, parentPid: parent.pid, created: parent.created + 1, executable: "" }]
        : defect === "active" ? [helper, pending, { ...parent, commandLine: "changed" }]
          : defect === "released" ? [helper, pending, parent]
            : defect === "released-partial" ? [helper, pending, { ...parent, created: parent.created + 1, executable: "" }]
              : [helper, parent, pending, invalidChild];
  assert.throws(() => preflight({ inventory, roots, processes: reverse ? processes.reverse() : processes, revision: 3, known: [helper, ...(defect.startsWith("released") ? [] : [parent])] }));
});

test("snapshot preflight rejects a historical PID as pending while keeping old proofs", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const before = structuredClone(inventory), reused = { ...parent, created: parent.created + 1, executable: "", commandLine: "new-instance" };
  assert.throws(() => preflight({ inventory, roots, processes: [helper, reused], revision: 2, known: [helper] }));
  assert.deepEqual(inventory, before);
});

test("snapshot preflight retains missing-parent old-row exclusion and returns independent pending copies", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const old = { ...identity(40, parent.pid, 1), executable: "", commandLine: "" }, partial = { ...identity(50, helper.pid), executable: "" };
  const pending = preflight({ inventory, roots, processes: [helper, old, partial], revision: 2, known: [helper] });
  assert.deepEqual(pending, [partial]);
  (pending[0] as ProcessIdentity).commandLine = "changed-result";
  assert.equal(partial.commandLine, "process-50");
});

test("snapshot preflight returns multiple pending rows without adopting their complete descendants", () => {
  const inventory = api().createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const first = { ...child, executable: "" }, second = { ...identity(50, parent.pid), executable: "" }, descendant = identity(60, first.pid);
  assert.deepEqual(preflight({ inventory, roots, processes: [helper, parent, descendant, second, first], revision: 2, known: [helper, parent] }), [second, first]);
  assert.deepEqual(inventory.owned, [parent]); assert.equal(inventory.lifecycle[0]!.release, null);
});

for (const field of ["created", "parentPid", "executable", "commandLine"] as const)
test(`snapshot preflight cannot retry a visible known ${field} conflict`, () => {
  const inventory = api().createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const actual = { ...parent, [field]: field === "created" ? parent.created + 1 : field === "parentPid" ? 999
    : field === "executable" ? path.resolve("foreign.exe") : "foreign-command" };
  assert.throws(() => preflight({ inventory, roots, processes: [helper, actual, { ...child, executable: "" }], revision: 2, known: [helper, parent] }));
});

test("snapshot preflight keeps reused released PID partial strict even when its active generation is known", () => {
  const core = api(), released = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const nextParent = { ...parent, created: 5000, commandLine: "next-parent" };
  const inventory = core.observeProcessInventory({ inventory: released, roots, processes: [helper, nextParent], observer: helper, revision: 2 });
  assert.throws(() => preflight({ inventory, roots, processes: [helper, { ...nextParent, executable: "" }], revision: 3, known: [helper, nextParent] }));
  assert.deepEqual(inventory.lifecycle[0], released.lifecycle[0]);
});

test("snapshot preflight cannot qualify a new child from a foreign parent generation", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const foreign = { ...parent, parentPid: 999, created: 5000, commandLine: "foreign-parent" };
  assert.throws(() => preflight({ inventory, roots, processes: [helper, foreign, { ...child, created: 6000, executable: "" }], revision: 2, known: [helper] }));
});

for (const defect of ["created", "predates", "role", "excluded", "partial"] as const) for (const reverse of [false, true])
test(`snapshot preflight checks new complete parent descendants for ${defect} in ${reverse ? "reverse" : "forward"} order`, () => {
  const historical = defect === "predates" ? [{ ...child, created: parent.created + 1 }] : [];
  const inventory = api().createProcessInventory({ owned: [parent, ...historical], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const pending = { ...identity(50, helper.pid), executable: "" }, excluded = identity(60, 999);
  const bad = { ...identity(defect === "role" ? helper.pid : defect === "excluded" ? excluded.pid : 40, child.pid),
    ...(defect === "created" ? { created: 0 } : defect === "predates" ? { created: child.created - 1 }
      : defect === "partial" ? { executable: "", commandLine: "" } : {}) };
  const processes = [helper, parent, child, bad, pending].filter((item, index, all) => !all.slice(index + 1).some(next => next.pid === item.pid));
  assert.throws(() => preflight({ inventory, roots, processes: reverse ? processes.reverse() : processes, revision: 2, known: [helper, parent], excluded: [excluded] }));
  assert.deepEqual(inventory.owned, [parent, ...historical]); assert.equal(inventory.lifecycle[0]!.release, null);
});

for (const reverse of [false, true]) test(`snapshot preflight checks descendants of complete extra known in ${reverse ? "reverse" : "forward"} order`, () => {
  const inventory = api().createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const pending = { ...identity(50, helper.pid), executable: "" }, bad = identity(40, child.pid, 0);
  const processes = [helper, parent, child, bad, pending];
  assert.throws(() => preflight({ inventory, roots, processes: reverse ? processes.reverse() : processes, revision: 2, known: [helper, parent, child] }));
});

test("preparation roots preserve parent keys and old proofs while a new observer releases the old tree", () => {
  const core = api(), nextMain = identity(50, 1, 5000);
  const first = core.createProcessInventory({ owned: [parent, child], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const rebound = core.observeProcessInventory({ inventory: first, roots: [helper, nextMain], processes: [nextMain], observer: nextMain, revision: 2 });
  assert.equal(rebound.lifecycle[0]!.parentKey, first.lifecycle[0]!.parentKey);
  assert.equal(rebound.lifecycle[0]!.release!.observerKey, core.processInstanceKey(nextMain));
  assert.deepEqual(rebound.lifecycle[1], first.lifecycle[1]);
  assert.throws(() => core.readProcessInventory(rebound.owned, rebound.lifecycle, [nextMain], 2));
  assert.throws(() => core.readProcessInventory(rebound.owned, rebound.lifecycle, [helper, nextMain, { ...parent, parentPid: 1, created: 6000 }], 2));
});

for (const reason of ["ACTIVE_IDENTITY_CHANGED", "RELEASED_IDENTITY_REAPPEARED", "UNKNOWN_PARENT_MISSING", "CHILD_PREDATES_PARENT"] as const)
test(`inventory failure identifies ${reason} without exposing process text`, () => {
  const core = api();
  const first = core.createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const released = core.observeProcessInventory({ inventory: first, roots, processes: [helper], observer: helper, revision: 2 });
  const foreign = { ...parent, parentPid: 999, created: 9000, commandLine: "private-inventory-command" };
  const processes = reason === "ACTIVE_IDENTITY_CHANGED" ? [helper, foreign]
    : reason === "RELEASED_IDENTITY_REAPPEARED" ? [helper, parent]
    : reason === "UNKNOWN_PARENT_MISSING" ? [helper, child] : [helper, foreign, child];
  const selected = reason === "ACTIVE_IDENTITY_CHANGED" ? first : released;
  const actual = reason === "ACTIVE_IDENTITY_CHANGED" ? foreign : reason === "RELEASED_IDENTITY_REAPPEARED" ? parent : child;
  assert.throws(() => core.observeProcessInventory({ inventory: selected, roots, processes, observer: helper, revision: 3 }), (error: any) => {
    assert.equal(error.code, "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID");
    assert.deepEqual(error.inventoryFailure, { reason, pid: actual.pid, parentPid: actual.parentPid, created: actual.created, instanceSha256: core.processInstanceKey(actual) });
    assert.equal(JSON.stringify(error.inventoryFailure).includes(actual.commandLine), false);
    assert.equal(JSON.stringify(error.inventoryFailure).includes(actual.executable), false);
    return true;
  });
});

for (const variant of ["released-created", "released-path", "foreign-child", "recursive-child"] as const)
test(`strict inventory read identifies ${variant} and preserves its original failure`, () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const foreign = { ...parent, parentPid: 999, created: 9000, commandLine: "private-foreign-command" };
  const nextChild = { ...child, created: 9001, commandLine: "private-child-command" };
  const incomplete = variant === "released-created" ? { ...foreign, created: 0 }
    : variant === "released-path" ? { ...foreign, executable: "" }
      : { ...nextChild, ...(variant === "recursive-child" ? { created: 0, parentPid: parent.pid } : { executable: "" }) };
  const processes = variant.startsWith("released") ? [helper, incomplete]
    : variant === "foreign-child" ? [helper, foreign, incomplete] : [helper, { ...parent, pid: 40 }, { ...incomplete, parentPid: 40 }];
  const actual = variant === "recursive-child" ? { ...incomplete, parentPid: 40 } : incomplete;
  const reason = variant.startsWith("released") ? "RELEASED_IDENTITY_INVALID" : variant === "foreign-child" ? "RELATED_IDENTITY_INVALID" : "CHILD_IDENTITY_INVALID";
  assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes, observer: helper, revision: 2 }), (error: any) => {
    assert.equal(error.code, "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID"); assert.equal(error.cause?.code, error.code);
    assert.deepEqual(error.inventoryFailure, { reason, pid: actual.pid, parentPid: actual.parentPid, created: actual.created,
      instanceSha256: crypto.createHash("sha256").update(JSON.stringify([actual.pid, actual.parentPid, actual.created, actual.executable, actual.commandLine]), "utf8").digest("hex") });
    assert.doesNotMatch(JSON.stringify(error.inventoryFailure), /private-|inventory-test/u); return true;
  });
});

for (const stage of ["new-parent", "known-parent"] as const) for (const incomplete of [false, true])
test(`ancestry excludes a ${incomplete ? "partial" : "complete"} unknown row older than its ${stage}`, () => {
  const core = api(), inventory = core.createProcessInventory({ owned: stage === "known-parent" ? [parent] : [], roots,
    processes: stage === "known-parent" ? [helper, parent] : [helper], observer: helper, revision: 1 });
  const old = { ...identity(40, parent.pid, 1), ...(incomplete ? { executable: "", commandLine: "" } : {}) };
  const descendant = identity(41, old.pid, parent.created + 10), legitimate = identity(42, parent.pid, parent.created + 1);
  const actual = core.observeProcessInventory({ inventory, roots, processes: [helper, old, descendant, parent, legitimate], observer: helper, revision: 2 });
  assert.deepEqual(actual.owned, [parent, legitimate]);
  assert.deepEqual(core.activeProcessInventory(actual), [parent, legitimate]);
  assert.ok(actual.lifecycle.every(item => item.release === null));
  const released = core.observeProcessInventory({ inventory: actual, roots, processes: [helper], observer: helper, revision: 3 });
  const foreign = { ...parent, parentPid: 999, created: 9000, commandLine: "foreign" };
  core.assertProcessInventoryReleased({ inventory: released, roots: [], processes: [foreign, old, descendant] });
  assert.deepEqual(inventory.owned, stage === "known-parent" ? [parent] : []);
});

test("ancestry excludes an old row before every historical parent generation", () => {
  const core = api(), released = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const next = { ...parent, created: 9000, commandLine: "new-owned" };
  const actual = core.observeProcessInventory({ inventory: released, roots, processes: [helper, next,
    { ...identity(40, parent.pid, 1), executable: "", commandLine: "" }], observer: helper, revision: 2 });
  assert.deepEqual(actual.owned, [parent, next]); assert.deepEqual(actual.lifecycle[0], released.lifecycle[0]);
  assert.equal(actual.lifecycle[1]!.release, null);
});

for (const current of ["owned", "foreign"] as const) test(`ancestry still rejects an unknown child between historical and ${current} parent generations`, () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const next = { ...parent, parentPid: current === "owned" ? helper.pid : 999, created: 9000, commandLine: "next-parent" };
  const actual = core.observeProcessInventory({ inventory, roots, processes: [helper, next], observer: helper, revision: 2 });
  const between = identity(40, parent.pid, 8000);
  assert.throws(() => core.observeProcessInventory({ inventory: actual, roots, processes: [helper, next, between], observer: helper, revision: 3 }));
  if (current === "foreign") assert.throws(() => core.assertProcessInventoryReleased({ inventory: actual, roots: [], processes: [next, between] }));
});

for (const stage of ["new-parent", "known-parent"] as const) for (const created of [0, parent.created, parent.created + 1])
test(`ancestry refuses partial unknown child created ${created} under a ${stage}`, () => {
  const core = api(), inventory = core.createProcessInventory({ owned: stage === "known-parent" ? [parent] : [], roots,
    processes: stage === "known-parent" ? [helper, parent] : [helper], observer: helper, revision: 1 });
  const unknown = { ...identity(40, parent.pid, created), executable: "", commandLine: "" };
  assert.throws(() => core.observeProcessInventory({ inventory, roots, processes: [helper, parent, unknown], observer: helper, revision: 2 }));
});

for (const defect of ["partial-parent", "active-conflict", "released-conflict", "released-reappeared", "root-conflict", "excluded-conflict"] as const)
test(`ancestry cannot bypass ${defect} with an old unknown row`, () => {
  const core = api(), released = defect.startsWith("released");
  const inventory = core.createProcessInventory({ owned: [parent], roots, processes: released ? [helper] : [helper, parent], observer: helper, revision: 1 });
  const old = { ...identity(40, parent.pid, 1), executable: "", commandLine: "" }, excluded = identity(50, 999);
  const processes = defect === "partial-parent" ? [helper, { ...parent, executable: "" }, old]
      : defect === "active-conflict" ? [helper, { ...parent, created: parent.created + 1 }, old]
        : defect === "released-conflict" ? [helper, { ...parent, created: 1, executable: "" }, old]
          : defect === "released-reappeared" ? [helper, parent, old]
            : defect === "root-conflict" ? [parent, { ...old, pid: helper.pid }]
              : [helper, parent, { ...old, pid: excluded.pid }];
  assert.throws(() => core.observeProcessInventory({ inventory, roots, processes, observer: helper, revision: 2,
    ...(defect === "excluded-conflict" ? { excluded: [excluded] } : {}) }));
});

for (const released of [false, true]) for (const partial of [false, true])
test(`missing-parent excludes an older ${partial ? "partial" : "complete"} row with ${released ? "released" : "active"} history`, () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots,
    processes: released ? [helper] : [helper, parent], observer: helper, revision: 1 });
  const old = { ...identity(40, parent.pid, 1), ...(partial ? { executable: "", commandLine: "" } : {}) };
  const descendant = identity(41, old.pid), processes = [helper, old, descendant];
  const actual = core.observeProcessInventory({ inventory: first, roots, processes, observer: helper, revision: 2 });
  assert.deepEqual(actual.owned, [parent]); assert.deepEqual(core.activeProcessInventory(actual), []);
  assert.equal(actual.lifecycle[0]!.parentKey, first.lifecycle[0]!.parentKey);
  if (released) assert.deepEqual(actual, first);
  else {
    assert.equal(actual.lifecycle[0]!.release!.revision, 2);
    assert.equal(actual.lifecycle[0]!.release!.observerKey, core.processInstanceKey(helper));
  }
  core.assertProcessInventoryReleased({ inventory: actual, roots, processes, excluded: roots });
  assert.equal(first.lifecycle[0]!.release?.revision ?? null, released ? 1 : null);
});

test("missing-parent uses every persisted parent generation without rewriting prior proof", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const next = { ...parent, created: 9000, commandLine: "next-parent" };
  const claimed = core.observeProcessInventory({ inventory: first, roots, processes: [helper, next], observer: helper, revision: 2 });
  const old = identity(40, parent.pid, 1);
  const released = core.observeProcessInventory({ inventory: claimed, roots, processes: [helper, old], observer: helper, revision: 3 });
  assert.deepEqual(released.owned, [parent, next]); assert.deepEqual(released.lifecycle[0], first.lifecycle[0]);
  assert.equal(released.lifecycle[1]!.release!.revision, 3);
  core.assertProcessInventoryReleased({ inventory: released, roots, processes: [helper, old], excluded: roots });
  for (const created of [0, parent.created, 8000, next.created, next.created + 1]) {
    const processes = [helper, identity(40, parent.pid, created)];
    for (const invoke of [() => core.observeProcessInventory({ inventory: released, roots, processes, observer: helper, revision: 4 }),
      () => core.assertProcessInventoryReleased({ inventory: released, roots, processes, excluded: roots })]) {
      assert.throws(invoke, (error: any) => error.inventoryFailure?.reason === "UNKNOWN_PARENT_MISSING");
    }
  }
});

test("missing-parent does not release a parent while its registered child is alive", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent, child], roots,
    processes: [helper, parent, child], observer: helper, revision: 1 });
  const old = identity(40, parent.pid, 1), processes = [helper, child, old];
  const pending = core.observeProcessInventory({ inventory: first, roots, processes, observer: helper, revision: 2 });
  assert.deepEqual(pending, first);
  assert.throws(() => core.assertProcessInventoryReleased({ inventory: pending, roots, processes, excluded: roots }));
  core.assertProcessInventoryReleased({ inventory: pending, roots, processes, excluded: [...roots, child] });
  const released = core.observeProcessInventory({ inventory: pending, roots, processes: [helper, old], observer: helper, revision: 3 });
  assert.ok(released.lifecycle.every(item => item.release?.revision === 3));
});

for (const role of ["root", "excluded"] as const)
test(`missing-parent old rows cannot bypass a ${role} PID conflict`, () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const excluded = identity(50, 999), old = identity(role === "root" ? helper.pid : excluded.pid, parent.pid, 1);
  const processes = role === "root" ? [old] : [helper, old];
  assert.throws(() => core.assertProcessInventoryReleased({ inventory: first, roots, processes, excluded: [helper, excluded] }));
  const observer = identity(60, 1, 5000);
  assert.throws(() => core.observeProcessInventory({ inventory: first, roots: [...roots, observer], processes: [...processes, observer],
    excluded: [excluded], observer, revision: 2 }));
});

test("missing-parent cannot infer ownership without any known parent generation", () => {
  const core = api(), first = core.createProcessInventory({ owned: [], roots, processes: [helper], observer: helper, revision: 1 });
  const processes = [helper, identity(40, 999, 1)];
  assert.deepEqual(core.observeProcessInventory({ inventory: first, roots, processes, observer: helper, revision: 2 }), first);
  core.assertProcessInventoryReleased({ inventory: first, roots, processes, excluded: roots });
});

test("ancestry still rejects a partial actual foreign parent before excluding its old child", () => {
  const core = api(), inventory = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const foreign = { ...parent, parentPid: 999, created: 9000, commandLine: "foreign", executable: "" };
  const old = { ...identity(40, parent.pid, 1), executable: "", commandLine: "" };
  assert.throws(() => core.assertProcessInventoryReleased({ inventory, roots: [], processes: [foreign, old] }));
});

test("inventory releases only after the entire concrete subtree is absent", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent, child], roots, processes: [helper, parent, child], observer: helper, revision: 1 });
  const pending = core.observeProcessInventory({ inventory: first, roots, processes: [helper, child], observer: helper, revision: 2 });
  assert.deepEqual(core.activeProcessInventory(pending), [parent, child]);
  const released = core.observeProcessInventory({ inventory: pending, roots, processes: [helper], observer: helper, revision: 3 });
  assert.deepEqual(core.activeProcessInventory(released), []); assert.deepEqual(released.owned, [parent, child]);
  assert.ok(released.lifecycle.every(item => item.release?.revision === 3));
});

test("inventory rejects reuse before release and ignores foreign reuse after persisted release", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper, parent], observer: helper, revision: 1 });
  const reused = { ...parent, parentPid: 999, created: 9000, commandLine: "foreign" };
  assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes: [helper, reused], observer: helper, revision: 2 }));
  const released = core.observeProcessInventory({ inventory: first, roots, processes: [helper], observer: helper, revision: 2 });
  const actual = core.observeProcessInventory({ inventory: released, roots, processes: [helper, reused], observer: helper, revision: 3 });
  assert.deepEqual(actual, released); core.assertProcessInventoryReleased({ inventory: actual, roots: [], processes: [reused] });
});

test("inventory preserves both instances when a released PID becomes a legitimate new child", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const next = { ...parent, created: 9000, commandLine: "new-owned" };
  const actual = core.observeProcessInventory({ inventory: first, roots, processes: [helper, next], observer: helper, revision: 2 });
  assert.deepEqual(actual.owned, [parent, next]); assert.deepEqual(core.activeProcessInventory(actual), [next]);
  assert.notEqual(actual.lifecycle[0]!.key, actual.lifecycle[1]!.key);
});

test("inventory refuses unknown orphans and a child older than a reused foreign parent", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes: [helper, child], observer: helper, revision: 2 }));
  const reused = { ...parent, parentPid: 999, created: 9000, commandLine: "foreign" };
  assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes: [helper, reused, child], observer: helper, revision: 2 }));
  const newChild = { ...child, created: 9001 };
  assert.deepEqual(core.observeProcessInventory({ inventory: first, roots, processes: [helper, reused, newChild], observer: helper, revision: 2 }), first);
});

test("inventory rejects released identity resurrection and incomplete or duplicate snapshots", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  for (const processes of [[helper, parent], [helper, helper], [helper, { ...parent, executable: "" }]]) {
    assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes, observer: helper, revision: 2 }));
  }
});

test("inventory refuses incomplete or backwards identities at a released historical PID", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent], roots, processes: [helper], observer: helper, revision: 1 });
  const foreign = { ...parent, parentPid: 999, created: 9000, commandLine: "foreign" };
  for (const identity of [{ ...foreign, executable: "" }, { ...foreign, created: 0 }, { ...foreign, commandLine: "" }, { ...foreign, created: parent.created - 1 }]) {
    assert.throws(() => core.observeProcessInventory({ inventory: first, roots, processes: [helper, identity], observer: helper, revision: 2 }));
  }
});

test("inventory reader rejects forged release observers, broken graphs and active duplicate PIDs", () => {
  const core = api(), first = core.createProcessInventory({ owned: [parent, child], roots, processes: [helper], observer: helper, revision: 1 });
  const forged = structuredClone(first); forged.lifecycle[0]!.release!.observerKey = "a".repeat(64);
  assert.throws(() => core.readProcessInventory(forged.owned, forged.lifecycle, roots, 1));
  const broken = structuredClone(first); broken.lifecycle[0]!.parentKey = broken.lifecycle[1]!.key;
  assert.throws(() => core.readProcessInventory(broken.owned, broken.lifecycle, roots, 1));
  assert.throws(() => core.readProcessInventory(first.owned, first.lifecycle, roots, 0));
});

test("inventory enforces an explicit bound without trimming history", () => {
  const core = api(), owned = Array.from({ length: 1025 }, (_, index) => identity(100 + index, helper.pid));
  assert.throws(() => core.createProcessInventory({ owned, roots, processes: [helper], observer: helper, revision: 1 }),
    (error: unknown) => (error as { code?: string }).code === "DESKTOP_SHELL_PROCESS_INVENTORY_CAPACITY");
});
