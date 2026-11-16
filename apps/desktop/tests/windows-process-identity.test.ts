import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { processSnapshot, sameIdentity, stopIdentity } from "../src/windowsProcessIdentity.js";

const original = { pid: 401, parentPid: 400, created: 1_700_000_000_000,
  executable: "D:\\owned\\node.exe", commandLine: '"D:\\owned\\node.exe" probe.cjs' };

test("process query excludes its PowerShell helper and direct console host", async t => {
  let script = "";
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, args: unknown, _options: unknown, callback: Function) => {
    const values = args as string[]; script = Buffer.from(values[3]!, "base64").toString("utf16le");
    queueMicrotask(() => callback(null, JSON.stringify([original])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    await processSnapshot();
    assert.match(script, /Where-Object \{ \$_.ProcessId -ne \$PID -and -not \(\$_.ParentProcessId -eq \$PID -and \$_.Name -ieq 'conhost\.exe'\) \}/u);
    assert.doesNotMatch(script, /Where-Object \{ .*ParentProcessId -ne \$PID/u);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending child re-queries a whole complete observation", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const partial = { ...child, executable: "" };
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = queries++ === 0 ? [original, partial] : [original, child];
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid === child.pid && !row.executable) };
  try {
    assert.deepEqual(await processSnapshot(context), [original, child]);
    assert.equal(queries, 2);
    assert.deepEqual(context.known, [original]);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending child with both text fields missing accepts their later completion", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const samples = [[original, { ...child, executable: "", commandLine: "" }],
    [original, { ...child, commandLine: "" }], [original, child]];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid === child.pid && (!row.executable || !row.commandLine)) };
  try {
    assert.deepEqual(await processSnapshot(context), [original, child]);
    assert.equal(queries, 3);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending child cannot lose a field after it has completed", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const other = { ...original, pid: 403, parentPid: original.pid, created: original.created + 2 };
  const samples = [[original, { ...child, executable: "", commandLine: "" }, { ...other, executable: "" }],
    [original, { ...child, commandLine: "" }, { ...other, executable: "" }],
    [original, child, { ...other, executable: "" }], [original, { ...child, commandLine: "" }, other]];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => [child.pid, other.pid].includes(row.pid) && (!row.executable || !row.commandLine)) };
  try {
    await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_PENDING_CHANGED"); assert.equal(cause.pid, child.pid); return true;
    });
    assert.equal(queries, 4);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending children all complete in the same returned sample", async t => {
  const first = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const second = { ...first, pid: 403, created: first.created + 1 };
  const samples = [[original, { ...first, executable: "" }, { ...second, executable: "" }],
    [original, first, { ...second, executable: "" }], [original, first, second]];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid !== original.pid && !row.executable) };
  try {
    assert.deepEqual(await processSnapshot(context), [original, first, second]); assert.equal(queries, 3);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending child discovered during re-query must also complete", async t => {
  const first = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const second = { ...first, pid: 403, created: first.created + 1 };
  const samples = [[original, { ...first, executable: "" }],
    [original, first, { ...second, executable: "" }], [original, first, second]];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid !== original.pid && !row.executable) };
  try {
    assert.deepEqual(await processSnapshot(context), [original, first, second]); assert.equal(queries, 3);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const change of ["gone", "parentPid", "created", "commandLine", "commandLine-empty"] as const)
test(`new pending child rejects ${change} without another query`, async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const changed = { ...child, ...(change === "parentPid" ? { parentPid: child.parentPid + 1 }
    : change === "created" ? { created: child.created + 1 }
    : { commandLine: change === "commandLine-empty" ? "" : "private-pending-secret" }) };
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = queries++ === 0 ? [original, { ...child, executable: "" }] : change === "gone" ? [original] : [original, changed];
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid === child.pid && !row.executable) };
  try {
    await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, `DESKTOP_SHELL_HEALTH_PROCESS_PENDING_${change === "gone" ? "GONE" : "CHANGED"}`); assert.equal(cause.pid, child.pid);
      const evidence = change === "gone" ? { ...child, executable: "" } : changed;
      assert.deepEqual(cause.inventoryFailure, { reason: "CHILD_IDENTITY_INVALID", pid: child.pid,
        parentPid: evidence.parentPid, created: evidence.created,
        instanceSha256: createHash("sha256").update(JSON.stringify([evidence.pid, evidence.parentPid, evidence.created, evidence.executable, evidence.commandLine]), "utf8").digest("hex") });
      const serialized = JSON.stringify(cause);
      for (const secret of [original.executable, original.commandLine, "private-pending-secret"]) assert.equal(serialized.includes(secret), false);
      return true;
    });
    assert.equal(queries, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const executable of ["", "D:\\private-pending\\changed.exe"])
test(`completed pending child cannot lose or change its observed executable ${executable ? "changed" : "missing"}`, async t => {
  const first = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const second = { ...first, pid: 403, created: first.created + 1 };
  const samples = [[original, { ...first, executable: "" }, { ...second, executable: "" }],
    [original, first, { ...second, executable: "" }], [original, { ...first, executable }, second]];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid !== original.pid && !row.executable) };
  try {
    await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_PENDING_CHANGED"); assert.equal(cause.pid, first.pid);
      assert.equal(cause.inventoryFailure.reason, "CHILD_IDENTITY_INVALID");
      assert.equal(JSON.stringify(cause).includes("private-pending"), false); return true;
    });
    assert.equal(queries, 3);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const stage of ["first", "middle-gone", "middle-conflict", "middle-complete"] as const)
test(`preflight hard failure wins over pending handling in ${stage} sample`, async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const failure = Object.assign(new Error("inventory hard failure"), { code: "CONTROLLED_INVENTORY_FAILURE" });
  let queries = 0, preflights = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = queries++ === 0 ? [original, { ...child, executable: "" }] : stage === "middle-gone" ? [original]
      : [original, { ...child, ...(stage === "middle-conflict" ? { created: child.created + 1 } : {}) }];
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000, preflight: (rows: readonly typeof original[]) => {
    if (++preflights === (stage === "first" ? 1 : 2)) throw failure;
    return rows.filter(row => row.pid === child.pid && !row.executable);
  } };
  try {
    await assert.rejects(processSnapshot(context), cause => cause === failure);
    assert.equal(queries, stage === "first" ? 1 : 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("known visible conflict wins before the new child preflight", async t => {
  const failure = new Error("preflight must not hide known conflict");
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([{ ...original, executable: "", created: original.created + 1 }])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], preflight: () => { throw failure; } };
  try {
    await assert.rejects(processSnapshot(context), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED" });
    assert.equal(mocked.mock.callCount(), 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const next of ["full", "gone"] as const)
test(`preflight sees raw known partial and preserves its ${next} contract`, async t => {
  const system = { pid: 0, parentPid: 0, created: 0, executable: "", commandLine: "" };
  const partial = { ...original, executable: "", commandLine: "" };
  const samples = [[system, partial], next === "full" ? [system, original] : [system]];
  const observed: typeof original[][] = [];
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = samples[queries++]; assert.ok(rows);
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => { observed.push(structuredClone([...rows])); return []; } };
  try {
    assert.deepEqual(await processSnapshot(context), samples[1]);
    assert.deepEqual(observed, samples); assert.equal(queries, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("pending re-query system failure propagates without a later sample", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const failure = Object.assign(new Error("controlled re-query failure"), { code: "EACCES" });
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const first = queries++ === 0;
    queueMicrotask(() => callback(first ? null : failure, JSON.stringify([original, { ...child, executable: "" }])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 1000,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid === child.pid && !row.executable) };
  try {
    await assert.rejects(processSnapshot(context), cause => cause === failure); assert.equal(queries, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("expired new pending budget cannot start a complete later query", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  let now = 0, queries = 0;
  const clock = t.mock.method(Date, "now", () => now);
  const sleep = t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    now += delay; queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, options: { timeout: number }, callback: Function) => {
    assert.equal(options.timeout, 10);
    const rows = queries++ === 0 ? [original, { ...child, executable: "" }] : [original, child];
    now += 9; queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 10,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid === child.pid && !row.executable) };
  try {
    await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE"); assert.deepEqual(cause.pids, [child.pid]);
      assert.ok(cause.cause instanceof AggregateError);
      assert.equal(cause.cause.errors[0].inventoryFailure.reason, "CHILD_IDENTITY_INVALID");
      assert.equal(cause.cause.errors[0].inventoryFailure.pid, child.pid); return true;
    });
    assert.equal(queries, 1); assert.equal(now, 10);
  } finally { mocked.mock.restore(); clock.mock.restore(); sleep.mock.restore(); syncBuiltinESMExports(); }
});

test("new pending partials time out in one budget with every incomplete identity diagnosed", async t => {
  const first = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1, executable: "" };
  const second = { ...first, pid: 403, created: first.created + 1 };
  let now = 0, queries = 0;
  const clock = t.mock.method(Date, "now", () => now);
  const sleep = t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    now += delay; queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  const timeouts: number[] = [];
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, options: { timeout: number }, callback: Function) => {
    timeouts.push(options.timeout); queries++;
    queueMicrotask(() => callback(null, JSON.stringify([original, first, second])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = { known: [original], timeoutMs: 60,
    preflight: (rows: readonly typeof original[]) => rows.filter(row => row.pid !== original.pid && !row.executable) };
  try {
    await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE"); assert.deepEqual(cause.pids, [402, 403]);
      assert.ok(cause.cause instanceof AggregateError);
      assert.deepEqual(cause.cause.errors.map((failure: any) => failure.inventoryFailure.pid), [402, 403]);
      assert.equal(JSON.stringify(cause).includes(original.commandLine), false); return true;
    });
    assert.equal(now, 60); assert.equal(queries, 3); assert.deepEqual(timeouts, [60, 35, 10]);
  } finally { mocked.mock.restore(); clock.mock.restore(); sleep.mock.restore(); syncBuiltinESMExports(); }
});

test("no preflight keeps unknown partial rows in the returned system snapshot", async t => {
  const partial = { ...original, executable: "", commandLine: "" };
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([partial])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    assert.deepEqual(await processSnapshot(), [partial]); assert.equal(mocked.mock.callCount(), 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const next of ["full", "gone"] as const) test(`known partial snapshot re-queries a whole ${next} observation`, async t => {
  const system = { pid: 0, parentPid: 0, created: 0, executable: "", commandLine: "" };
  let queries = 0;
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    const rows = queries++ === 0 ? [system, { ...original, executable: "", commandLine: "" }]
      : next === "full" ? [system, original] : [system];
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    const actual = await Reflect.apply(processSnapshot, undefined, [{ known: [original], timeoutMs: 1000 }]);
    assert.deepEqual(actual, next === "full" ? [system, original] : [system]); assert.equal(queries, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const conflict of ["created", "parentPid", "executable", "commandLine"] as const)
test(`known partial snapshot rejects visible ${conflict} conflict without retry`, async t => {
  const value = original[conflict], changed = { ...original, executable: "", [conflict]: typeof value === "number" ? value + 1 : value + "-changed" };
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([changed])));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    await assert.rejects(Reflect.apply(processSnapshot, undefined, [{ known: [original] }]), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED" });
    assert.equal(mocked.mock.callCount(), 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const field of ["parentPid", "created", "executable", "commandLine", "all", "created-zero"] as const)
test(`identity conflict diagnostic records exact safe ${field} evidence`, async t => {
  const actual = { ...original, ...(field === "all" ? { parentPid: 399, created: original.created + 2,
    executable: "D:\\private-diagnostic\\other.exe", commandLine: "private-diagnostic-secret" }
    : field === "created-zero" ? { created: 0 } : { [field]: typeof original[field] === "number" ? (original[field] as number) + 1 : original[field] + "-private-diagnostic-secret" }) };
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([actual])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  /** 期望值从完整原始输入独立计算，断言日志投影不携带原文。 */
  const projected = (value: typeof original) => ({ parentPid: value.parentPid, created: value.created,
    executableSha256: createHash("sha256").update(value.executable, "utf8").digest("hex"),
    commandLineSha256: createHash("sha256").update(value.commandLine, "utf8").digest("hex") });
  try {
    await assert.rejects(processSnapshot({ known: [original] }), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED"); assert.equal(cause.pid, original.pid);
      assert.deepEqual(cause.processIdentityConflict, { pid: original.pid,
        changedFields: field === "all" ? ["parentPid", "created", "executable", "commandLine"] : [field === "created-zero" ? "created" : field],
        expected: projected(original), actual: projected(actual) });
      const serialized = JSON.stringify(cause.processIdentityConflict);
      for (const secret of [original.executable, original.commandLine, "private-diagnostic-secret", "private-diagnostic"]) assert.equal(serialized.includes(secret), false);
      return true;
    });
    assert.equal(mocked.mock.callCount(), 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("known partial snapshot timeout keeps identity context and does not return partial success", async t => {
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([{ ...original, commandLine: "" }])));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    await assert.rejects(Reflect.apply(processSnapshot, undefined, [{ known: [original], timeoutMs: 10 }]), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE"); assert.deepEqual(cause.pids, [original.pid]); return true;
    });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const next of ["full", "gone"] as const) test(`expired partial snapshot budget cannot start a later ${next} query`, async t => {
  let now = 0, queries = 0;
  const clock = t.mock.method(Date, "now", () => now);
  const sleep = t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    now += delay; queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, options: { timeout: number }, callback: Function) => {
    assert.equal(options.timeout, queries === 0 ? 10 : 1);
    const rows = queries++ === 0 ? [{ ...original, executable: "", commandLine: "" }] : next === "full" ? [original] : [{ pid: 0, parentPid: 0, created: 0, executable: "", commandLine: "" }];
    now += queries === 1 ? 9 : 1;
    queueMicrotask(() => callback(null, JSON.stringify(rows)));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    await assert.rejects(processSnapshot({ known: [original], timeoutMs: 10 }), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE"); assert.deepEqual(cause.pids, [original.pid]); return true;
    });
    assert.equal(queries, 1); assert.equal(now, 10);
  } finally { mocked.mock.restore(); clock.mock.restore(); sleep.mock.restore(); syncBuiltinESMExports(); }
});

test("known snapshot query failure propagates immediately and unknown partial remains visible", async t => {
  const failure = new Error("query failed"); let fail = false;
  const partial = { ...original, pid: 402, executable: "", commandLine: "" };
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(fail ? failure : null, JSON.stringify([original, partial])));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await Reflect.apply(processSnapshot, undefined, [{ known: [original] }]), [original, partial]);
    fail = true; await assert.rejects(Reflect.apply(processSnapshot, undefined, [{ known: [original] }]), cause => cause === failure);
    assert.equal(mocked.mock.callCount(), 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const [elapsed, scoped] of [[9, true], [10, true], [11, true], [10_000, false]] as const)
test(`snapshot deadline ${scoped ? "explicit" : "default"} budget rejects complete results at ${elapsed}ms only when expired`, async t => {
  const budget = scoped ? 10 : 10_000;
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, options: { timeout: number }, callback: Function) => {
    assert.equal(options.timeout, budget);
    queueMicrotask(() => { now = elapsed; callback(null, JSON.stringify([original])); });
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  const context = scoped ? { known: [original], timeoutMs: budget } : undefined;
  try {
    if (elapsed < budget) assert.deepEqual(await processSnapshot(context), [original]);
    else await assert.rejects(processSnapshot(context), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE");
      assert.deepEqual(cause.pids, []);
      return true;
    });
    if (context) assert.deepEqual(context.known, [original]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("snapshot deadline includes a later query that completes previously missing fields", async t => {
  const child = { ...original, pid: 402, parentPid: original.pid, created: original.created + 1 };
  const timeouts: number[] = [];
  let now = 0, queries = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    now += delay; queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, options: { timeout: number }, callback: Function) => {
    timeouts.push(options.timeout);
    const rows = queries++ === 0 ? [original, { ...child, executable: "" }] : [original, child];
    queueMicrotask(() => { now = queries === 1 ? 4 : 60; callback(null, JSON.stringify(rows)); });
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    await assert.rejects(processSnapshot({ known: [original], timeoutMs: 60,
      preflight: rows => rows.filter(row => row.pid === child.pid && !row.executable) }), (cause: any) => {
      assert.equal(cause.code, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE");
      assert.deepEqual(cause.pids, []);
      return true;
    });
    assert.equal(queries, 2);
    assert.deepEqual(timeouts, [60, 31]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("snapshot deadline includes preflight before declaring a complete sample successful", async t => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const query = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, JSON.stringify([original])));
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    await assert.rejects(processSnapshot({ known: [original], timeoutMs: 10,
      preflight: () => { now = 10; return []; } }), { code: "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE" });
    assert.equal(query.mock.callCount(), 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("snapshot deadline never replaces a query failure with a timeout", async t => {
  const failure = Object.freeze(Object.assign(new Error("controlled query failure"), { code: "EACCES" }));
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const query = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => { now = 10; callback(failure, "[]"); });
  }) as typeof childProcess.execFile); syncBuiltinESMExports();
  try {
    await assert.rejects(processSnapshot({ known: [original], timeoutMs: 10 }), cause => cause === failure);
    assert.equal(query.mock.callCount(), 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("process identity compares the complete instance instead of a reusable PID", async () => {
  assert.equal(sameIdentity(original, { ...original }), true);
  for (const changed of [{ pid: 402 }, { parentPid: 399 }, { created: original.created + 1 },
    { executable: "D:\\other\\node.exe" }, { commandLine: "different invocation" }]) {
    assert.equal(sameIdentity(original, { ...original, ...changed }), false);
  }
});

test("snapshot rejects incomplete, duplicate or malformed rows instead of declaring absence", async t => {
  let output = JSON.stringify([original]);
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(null, output));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await processSnapshot(), [original]);
    for (const value of [null, {}, [], [null], [original, original], [{ ...original, pid: -1 }],
      [{ ...original, parentPid: -1 }], [{ ...original, created: -1 }], [{ ...original, executable: null }],
      [{ pid: original.pid, parentPid: original.parentPid, created: original.created, executable: original.executable }]]) {
      output = JSON.stringify(value);
      await assert.rejects(processSnapshot(), /DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INVALID/u);
    }
    output = "not json";
    await assert.rejects(processSnapshot(), error => {
      assert.equal((error as Error).message, "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INVALID");
      assert.ok((error as Error).cause instanceof SyntaxError);
      return true;
    });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("a failed full process query preserves its root cause and never returns an empty snapshot", async t => {
  const failure = Object.assign(new Error("controlled CIM access failure"), { code: "EACCES" });
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(failure, "[]"));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try { await assert.rejects(processSnapshot(), error => error === failure); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("invalid stop identity fails before launching any system command", async t => {
  const mocked = t.mock.method(childProcess, "execFile", () => { throw new Error("system command must not run"); });
  syncBuiltinESMExports();
  try {
    for (const changed of [{ pid: 0 }, { pid: -1 }, { created: 0 }, { parentPid: -1 }, { executable: "" }]) {
      await assert.rejects(stopIdentity({ ...original, ...changed }), /DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_INVALID/u);
    }
    assert.equal(mocked.mock.callCount(), 0);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("exact stop errors propagate without retrying or hiding cleanup failures", async t => {
  const failure = Object.assign(new Error("controlled identity changed"), { code: 1 });
  const mocked = t.mock.method(childProcess, "execFile", ((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    queueMicrotask(() => callback(failure, ""));
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    await assert.rejects(stopIdentity(original), error => error === failure);
    assert.equal(mocked.mock.callCount(), 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("real Windows stop refuses changed identity and closes only the owned child", { skip: process.platform !== "win32" }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-d13-identity-owned-"));
  const script = path.join(root, "owned.cjs");
  await fsp.writeFile(script, "process.send({ready:true}); process.on('disconnect', () => process.exit(1)); setTimeout(() => process.exit(2), 60000);\n", "utf8");
  const child = childProcess.spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = once(child, "close");
  const errors: unknown[] = [];
  child.on("error", error => { errors.push(error); });
  let identity: Awaited<ReturnType<typeof processSnapshot>>[number] | undefined;
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(ready, { ready: true });
    identity = (await processSnapshot()).find(item => item.pid === child.pid);
    assert.ok(identity); assert.equal(identity.parentPid, process.pid);
    assert.ok(identity.commandLine.includes(script));
    for (const changed of [{ created: identity.created + 1 }, { executable: identity.executable + ".other" },
      { parentPid: identity.parentPid + 1 }, { commandLine: identity.commandLine + " other" }]) {
      await assert.rejects(stopIdentity({ ...identity, ...changed }));
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    }
    await stopIdentity(identity);
    await closed;
    const remaining = await processSnapshot();
    assert.equal(remaining.some(item => sameIdentity(item, identity!)), false);
    assert.deepEqual(errors, []);
    await fsp.writeFile(path.join(root, "result.json"), JSON.stringify({ status: "passed", identity, owned: 0 }, null, 2) + "\n", "utf8");
    process.stdout.write(`D13 process identity real evidence: ${root}\n`);
  } catch (failure) {
    const cleanup: unknown[] = [];
    if (child.exitCode === null && child.signalCode === null) {
      try { assert.ok(identity); await stopIdentity(identity); }
      catch (error) { cleanup.push(error); }
    }
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("OWNED_CHILD_CLOSE_TIMEOUT")), 65_000))]); }
    catch (error) { cleanup.push(error); }
    throw cleanup.length ? new AggregateError([failure, ...cleanup], "OWNED_CHILD_TEST_FAILED") : failure;
  }
});
