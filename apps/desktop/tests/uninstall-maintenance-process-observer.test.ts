import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileFunction } from "node:vm";

type Identity = { pid: number; parentPid: number; created: string; executable: string; commandLine: string };
type SafeIdentity = Omit<Identity, "commandLine"> & { commandLineSha256: string };
type IdentityFailure = Error & { childIdentity: SafeIdentity; parentIdentity?: SafeIdentity; missingFields?: string[]; observedAt: string };
type Child = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; spawnfile: string; kill: (signal: number) => boolean };
type Observer = { records: Map<number, Identity>; discover: () => Promise<void> };
type Details = { child: SafeIdentity; parent?: SafeIdentity; missingFields?: string[]; observedAt: string };

const source = await fs.readFile(new URL("./electron-uninstall-maintenance.smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf("function ownership("), end = source.indexOf("/** CIM 未登记", start);
assert.ok(start >= 0 && end > start, "the observer and diagnostic boundary must remain identifiable");
const load = compileFunction(source.slice(start, end) + "\nreturn { ownership, processIdentityFailure };",
  ["assert", "crypto", "path", "prefix", "queryProcesses"]);
const { ownership, processIdentityFailure } = load(assert, crypto, path, "DESKTOP_UNINSTALL_MAINTENANCE",
  () => { throw new Error("UNEXPECTED_SYSTEM_QUERY"); }) as {
    ownership: (child: Child, query: () => Promise<Identity[]>) => Observer;
    processIdentityFailure: (error: unknown) => Details | undefined;
  };

/** 只注入一次系统快照；不启动或终止真实进程。 */
function fixture() {
  const executable = path.resolve("observer-fixture/CodeFlowAI.exe");
  const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null, spawnfile: executable,
    kill: (signal: number) => { assert.equal(signal, 0); return true; } });
  const root: Identity = { pid: child.pid, parentPid: process.pid, created: "2020-01-01T00:00:00.000Z", executable, commandLine: "fixture-root private-value" };
  const candidate: Identity = { pid: 123457, parentPid: root.pid, created: "2020-01-01T00:00:01.000Z", executable: path.resolve("observer-fixture/child.exe"),
    commandLine: "fixture-child private-value" };
  const snapshot = [root, candidate];
  return { root, candidate, snapshot, owner: ownership(child, async () => snapshot) };
}

for (const missing of [["executable"], ["commandLine"], ["executable", "commandLine"]] as const) {
  test(`uninstall observer diagnoses incomplete candidate ${missing.join(" and ")} without granting ownership`, async () => {
    const f = fixture();
    for (const field of missing) f.candidate[field] = "";
    const earliest = Date.now();
    await assert.rejects(f.owner.discover(), (error: IdentityFailure) => {
      assert.equal(error.message, "DESKTOP_UNINSTALL_MAINTENANCE_PROCESS_IDENTITY");
      assert.deepEqual(error.missingFields, [...missing]);
      assert.equal(error.childIdentity.pid, f.candidate.pid);
      assert.equal(error.parentIdentity?.pid, f.root.pid);
      assert.equal(error.childIdentity.commandLineSha256, crypto.createHash("sha256").update(f.candidate.commandLine).digest("hex"));
      assert.ok(Date.parse(error.observedAt) >= earliest && Date.parse(error.observedAt) <= Date.now());
      assert.equal("commandLine" in error.childIdentity, false);
      assert.doesNotMatch(JSON.stringify({ child: error.childIdentity, parent: error.parentIdentity }), /private-value/u);
      const details = processIdentityFailure(new AggregateError([new Error("cleanup failed"), new AggregateError([error])], "verification failed"));
      assert.deepEqual(details, { child: error.childIdentity, parent: error.parentIdentity, observedAt: error.observedAt, missingFields: [...missing] });
      return true;
    });
    assert.equal(f.owner.records.size, 0, "a rejected discovery cannot publish even its complete root");
  });
}

test("uninstall observer keeps prior inventory after rejecting a new incomplete candidate", async () => {
  const f = fixture();
  f.snapshot.pop();
  await f.owner.discover();
  const before = [...f.owner.records];
  f.snapshot.push({ ...f.candidate, executable: "" });
  await assert.rejects(f.owner.discover(), { message: "DESKTOP_UNINSTALL_MAINTENANCE_PROCESS_IDENTITY" });
  assert.deepEqual([...f.owner.records], before);
});

test("uninstall observer diagnoses its incomplete root without inventing a parent identity", async () => {
  const f = fixture();
  f.root.commandLine = "";
  await assert.rejects(f.owner.discover(), (error: IdentityFailure) => {
    assert.equal(error.childIdentity.pid, f.root.pid);
    assert.equal(error.parentIdentity, undefined);
    assert.deepEqual(error.missingFields, ["commandLine"]);
    return true;
  });
  assert.equal(f.owner.records.size, 0);
});

test("uninstall observer attributes a nested incomplete candidate to its immediate parent", async () => {
  const f = fixture(), nested = { ...f.candidate, pid: 123458, parentPid: f.candidate.pid, commandLine: "" };
  f.snapshot.unshift(nested);
  await assert.rejects(f.owner.discover(), (error: IdentityFailure) => {
    assert.equal(error.childIdentity.pid, nested.pid);
    assert.equal(error.parentIdentity?.pid, f.candidate.pid);
    assert.deepEqual(error.missingFields, ["commandLine"]);
    return true;
  });
  assert.equal(f.owner.records.size, 0);
});

test("uninstall observer publishes a complete fresh inventory without modifying its snapshot", async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  await f.owner.discover();
  assert.deepEqual([...f.owner.records.values()], before);
  assert.deepEqual(f.snapshot, before);
});

test("uninstall observer does not invent identity details for unrelated failures", () => {
  assert.equal(processIdentityFailure(new AggregateError([new Error("query failed"), undefined, null], "cleanup failed")), undefined);
});
