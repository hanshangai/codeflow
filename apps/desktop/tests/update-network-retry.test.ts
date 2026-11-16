import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter, type ShellUpdateAttemptStore, type ShellUpdateAttemptV2 } from "../src/shellUpdateAttempt.js";
import { createUpdateNetworkRetry, preserveUpdateNetworkCancellation, type UpdateNetworkAction, type UpdateNetworkDurableAdapter, type UpdateNetworkDurableState } from "../src/updateNetworkRetry.js";
import { createDesktopUpdateTransport } from "../src/updateTransport.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";

let recoveryProcessNumber = 0;

for (const durableMode of [false, true]) test(`${durableMode ? "durable" : "transient"} exhaustion is observed only after the final retryable failure`, async () => {
  let state: UpdateNetworkDurableState = { revision: 0, retriesUsed: 0, network: null };
  const durable: UpdateNetworkDurableAdapter = { async read() { return structuredClone(state); },
    async replace(expected, next) { assert.deepEqual(expected, state); state = { ...state, ...next, revision: state.revision + 1 }; return structuredClone(state); } };
  const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  const observations: unknown[] = []; let sends = 0;
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, ...(durableMode ? { durable } : {}),
    onRetry() { assert.equal(observations.length, 0); }, onExhausted(error) { observations.push(error); } });
  await assert.rejects(retry.run(async () => { sends++; throw failure; }, durableMode ? durableAction() : undefined), error => error === failure);
  assert.equal(sends, 4); assert.deepEqual(observations, [failure]);
});

for (const cause of [undefined, false]) test(`exhaustion observer failure ${String(cause)} keeps the actual exhausted cause`, async () => {
  const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry() {}, onExhausted() { throw cause; } });
  await assert.rejects(retry.run(async () => { throw failure; }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [failure, cause]); return true;
  });
});

test("three earlier retries do not label a later permanent error as exhausted", async () => {
  const transient = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  const permanent = Object.assign(new Error("denied"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 403 });
  let calls = 0, exhausted = false;
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry() {}, onExhausted() { exhausted = true; } });
  await assert.rejects(retry.run(async () => { throw ++calls <= 3 ? transient : permanent; }), error => error === permanent);
  assert.equal(exhausted, false); assert.equal(calls, 4);
});

test("durable dispatch is persisted before sending and recovered unknown requests never replay", async () => {
  let state: UpdateNetworkDurableState = { revision: 0, retriesUsed: 0, network: null }, calls = 0;
  const durable: UpdateNetworkDurableAdapter = {
    async read() { return structuredClone(state); },
    async replace(expected: unknown, next: object) {
      assert.deepEqual(expected, state); state = { ...state, ...structuredClone(next), revision: state.revision + 1 }; return structuredClone(state);
    },
  };
  const action: UpdateNetworkAction<string> = { actionKey: "manifest", requestSha256: "a".repeat(64),
    async persistResult() { return { kind: "shell-manifest", sha256: "b".repeat(64) }; },
    async recoverResult() { return { status: "unknown" }; },
  };
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry() {}, durable });
  assert.equal(await retry.run(async () => { calls++; assert.equal(state.network?.status, "dispatching"); return "manifest"; }, action), "manifest");
  assert.equal((state.network as { status: string }).status, "succeeded");
  state = { revision: 1, retriesUsed: 0, network: { actionKey: "manifest", requestSha256: "a".repeat(64), status: "dispatching" } };
  await assert.rejects(retry.run(async () => { calls++; return "replayed"; }, action), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
  assert.equal(calls, 1);
});

test("durable mode requires action identity and a failed dispatch write sends nothing", async () => {
  let calls = 0;
  const failure = new Error("cannot persist dispatch");
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry() {}, durable: {
    async read() { return { revision: 0, retriesUsed: 0, network: null }; }, async replace() { throw failure; },
  } });
  await assert.rejects(retry.run(async () => { calls++; }), { code: "DESKTOP_SHELL_NETWORK_ACTION_INVALID" });
  await assert.rejects(retry.run(async () => { calls++; }, { actionKey: "manifest", requestSha256: "a".repeat(64),
    async persistResult() { assert.fail(); }, async recoverResult() { assert.fail(); } }), error => error === failure);
  assert.equal(calls, 0);
});

/** 每例保存真实 schema2，网络观察通过原 store 读回，不以 mock 代替耐久事实。 */
async function durableFixture(): Promise<{ directory: string; store: ShellUpdateAttemptStore; durable: UpdateNetworkDurableAdapter }> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-network-")));
  const store = createShellUpdateAttemptStore(directory);
  const attempt: ShellUpdateAttemptV2 = { schemaVersion: 2, requestId: "durable-request", revision: 0,
    installationDir: path.join(directory, "installation"), dataDir: directory,
    userDataDir: path.join(directory, "profile"), sessionDataDir: path.join(directory, "session"),
    originalState: { activeShellId: "old", previousShellId: "older", baselineShellId: "baseline" },
    binding: { kind: "installation", baselineShellId: "baseline", health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 1, database: "ready" } },
    target: null, candidateState: null, retriesUsed: 0, phase: "preparing", network: null };
  await store.replace(null, attempt);
  return { directory, store, durable: createShellUpdateAttemptNetworkAdapter(store) };
}

/** 测试动作默认无本地恢复工件，调用者必须显式提供可信恢复。 */
function durableAction(actionKey = "manifest"): UpdateNetworkAction<string> {
  return { actionKey, requestSha256: "a".repeat(64),
    async persistResult() { return { kind: "shell-manifest", sha256: "b".repeat(64) }; },
    async recoverResult() { return { status: "unknown" }; } };
}

/** 新进程复用真实文件；超时显式失败并保留 stdout/stderr 供排障。 */
function recoverInProcess(directory: string, body: string): Record<string, unknown> {
  const source = `import fs from 'node:fs/promises'; import path from 'node:path'; import { createHash } from 'node:crypto';
    import { createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter } from ${JSON.stringify(new URL("../src/shellUpdateAttempt.ts", import.meta.url).href)};
    import { createUpdateNetworkRetry } from ${JSON.stringify(new URL("../src/updateNetworkRetry.ts", import.meta.url).href)};
    const directory = ${JSON.stringify(directory)};
    const store = createShellUpdateAttemptStore(directory), durable = createShellUpdateAttemptNetworkAdapter(store);
    let calls = 0, retries = 0;
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { retries++; } });
    const action = { actionKey: 'manifest', requestSha256: 'a'.repeat(64), async persistResult() { return { kind: 'shell-manifest', sha256: 'b'.repeat(64) }; }, async recoverResult() { return { status: 'unknown' }; } };
    ${body}`;
  const prefix = `recovery-${++recoveryProcessNumber}`;
  const script = path.join(directory, `${prefix}.mjs`);
  writeFileSync(script, source, "utf8");
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15000,
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
  });
  writeFileSync(path.join(directory, `${prefix}.stdout.log`), result.stdout ?? "", "utf8");
  writeFileSync(path.join(directory, `${prefix}.stderr.log`), result.stderr ?? "", "utf8");
  writeFileSync(path.join(directory, `${prefix}-process.json`), JSON.stringify({ pid: result.pid, status: result.status, signal: result.signal, error: result.error?.message ?? null }), "utf8");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("real store shares three durable retry reservations across four different actions", async () => {
  const { store, durable } = await durableFixture();
  const reservations: number[] = [];
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry: event => { reservations.push(event.retry); } });
  const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  for (const key of ["register", "manifest", "installer"]) {
    let calls = 0;
    assert.equal(await retry.run(async () => {
      const disk = await store.read(); assert.equal(disk?.schemaVersion, 2);
      if (disk?.schemaVersion === 2) assert.equal(disk.network?.status, "dispatching");
      if (++calls === 1) throw failure; return key;
    }, durableAction(key)), key);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(retry.run(async () => { calls++; throw failure; }, durableAction("switch")), error => error === failure);
  assert.equal(calls, 1); assert.deepEqual(reservations, [1, 2, 3]);
  const disk = await store.read(); assert.equal(disk?.retriesUsed, 3); assert.equal(disk?.phase, "failed");
  await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, durableAction("other")));
  assert.equal(calls, 1);
});

test("cancelled waiting reservation survives a fresh process without charging or reporting twice", async () => {
  const { directory, durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit");
  const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" });
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { abort.abort(reason); } });
  await assert.rejects(retry.run(async () => { throw failure; }, durableAction()), error => error === reason);
  assert.equal((await durable.read()).network?.status, "waiting");
  const result = recoverInProcess(directory, `const value = await retry.run(async () => {
    calls++; const state = await durable.read(); if (state.network.status !== 'dispatching' || state.retriesUsed !== 1) throw new Error('dispatch ordering'); return 'restored';
  }, action); console.log(JSON.stringify({ value, calls, retries, state: await durable.read() }));`);
  assert.equal(result.value, "restored"); assert.equal(result.calls, 1); assert.equal(result.retries, 0);
  assert.equal((result.state as UpdateNetworkDurableState).retriesUsed, 1);
  assert.equal((result.state as UpdateNetworkDurableState).network?.status, "succeeded");
});

test("fresh process never replays dispatching at send-before-result and result-before-commit crash points", async () => {
  for (const localResult of [false, true]) {
    const { directory, durable } = await durableFixture();
    await durable.replace(await durable.read(), { retriesUsed: 0, network: { actionKey: "manifest", requestSha256: "a".repeat(64), status: "dispatching" } });
    if (localResult) await fs.writeFile(path.join(directory, "verified-result.txt"), "trusted-local-manifest", "utf8");
    const result = recoverInProcess(directory, `
      action.recoverResult = async evidence => {
        if (evidence !== null) throw new Error('unexpected evidence');
        ${localResult ? "const value = await fs.readFile(path.join(directory, 'verified-result.txt'), 'utf8'); if (value !== 'trusted-local-manifest') throw new Error('invalid artifact'); return { status: 'verified', value, evidence: { kind: 'shell-manifest', sha256: createHash('sha256').update(value).digest('hex') } };" : "return { status: 'unknown' };"}
      };
      let value, code; try { value = await retry.run(async () => { calls++; return 'replay'; }, action); }
      catch (error) { if (error.code !== 'DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN') throw error; code = error.code; }
      console.log(JSON.stringify({ value, code, calls, retries, state: await durable.read() }));`);
    assert.equal(result.calls, 0); assert.equal(result.retries, 0);
    assert.equal((result.state as UpdateNetworkDurableState).network?.status, localResult ? "succeeded" : "dispatching");
    if (localResult) assert.equal(result.value, "trusted-local-manifest");
    else assert.equal(result.code, "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN");
  }
});

test("succeeded recovery verifies the artifact again and refuses changed evidence or request materials", async () => {
  const { durable } = await durableFixture(), action = durableAction();
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  await retry.run(async () => "manifest", action);
  let calls = 0, recoveries = 0;
  action.recoverResult = async evidence => { recoveries++; assert.deepEqual(evidence, { kind: "shell-manifest", sha256: "b".repeat(64) }); return { status: "verified", value: "verified-local", evidence: evidence! }; };
  assert.equal(await retry.run(async () => { calls++; return "replay"; }, action), "verified-local");
  action.recoverResult = async () => ({ status: "verified", value: "forged", evidence: { kind: "shell-manifest", sha256: "c".repeat(64) } });
  await assert.rejects(retry.run(async () => { calls++; return "replay"; }, action), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  action.requestSha256 = "d".repeat(64);
  await assert.rejects(retry.run(async () => { calls++; return "replay"; }, action), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
  assert.equal(calls, 0); assert.equal(recoveries, 1);
});

test("succeeded recovery cannot mutate its input evidence to replace the persisted baseline", async () => {
  for (const mutation of ["sha256", "kind", "replacement", "mutate-and-replace"] as const) {
    const { directory, durable } = await durableFixture(), action = durableAction();
    const artifact = path.join(directory, "result.txt"); let sends = 0;
    action.persistResult = async value => {
      const file = await fs.open(artifact, "wx");
      try { await file.writeFile(value, "utf8"); await file.sync(); } finally { await file.close(); }
      return { kind: "shell-manifest", sha256: createHash("sha256").update(value).digest("hex") };
    };
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
    await retry.run(async () => { sends++; return "original-result"; }, action);
    const saved = await durable.read();
    if (mutation !== "kind") await fs.writeFile(artifact, "changed-result", "utf8");
    action.recoverResult = async evidence => {
      assert.ok(evidence);
      const value = await fs.readFile(artifact, "utf8");
      const sha256 = createHash("sha256").update(value).digest("hex");
      if (mutation === "sha256" || mutation === "mutate-and-replace") evidence.sha256 = sha256;
      if (mutation === "kind") evidence.kind = "shell-installer";
      return { status: "verified", value, evidence: mutation === "replacement" ? { ...evidence, sha256 } : mutation === "mutate-and-replace" ? { ...evidence } : evidence };
    };
    await assert.rejects(retry.run(async () => { sends++; return "forbidden-replay"; }, action), { code: "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" });
    assert.equal(sends, 1); assert.deepEqual(await durable.read(), saved);
  }
});

test("overflowing durable retry deadline explicitly fails without clamping or replaying", async () => {
  const { durable } = await durableFixture();
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { throw new Error("must not schedule invalid deadline"); } });
  let calls = 0;
  const root = new Error("gateway root cause");
  const failure = Object.assign(new Error("gateway", { cause: root }), { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId: "deadline-request", status: 503, retryAfter: String(Number.MAX_SAFE_INTEGER) });
  await assert.rejects(retry.run(async () => { calls++; throw failure; }, durableAction()), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], failure); assert.equal(error.errors[0].cause, root);
    assert.equal(error.errors[0].requestId, "deadline-request");
    assert.equal(error.errors[1].code, "DESKTOP_SHELL_NETWORK_STATE_INVALID"); return true;
  });
  assert.equal(calls, 1); assert.equal((await durable.read()).retriesUsed, 0); assert.equal((await durable.read()).network?.status, "dispatching");
});

test("retry calculation and reservation failures retain an undefined secondary cause", async () => {
  for (const boundary of ["calculation", "save"] as const) {
    const { durable } = await durableFixture(); let calls = 0, reports = 0;
    const root = new Error("gateway root cause"), failure = Object.assign(new Error("gateway", { cause: root }), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503 });
    if (boundary === "calculation") Object.defineProperty(failure, "retryAfter", { get() { throw undefined; } });
    const adapter: UpdateNetworkDurableAdapter = { read: durable.read, async replace(expected, next) {
      if (boundary === "save" && next.network?.status === "waiting") throw undefined;
      return durable.replace(expected, next);
    } };
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: adapter, onRetry() { reports++; } });
    await assert.rejects(retry.run(async () => { calls++; throw failure; }, durableAction()), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], failure); assert.equal(failure.cause, root);
      assert.deepEqual(error.errors, [failure, undefined]); return true;
    });
    assert.equal(calls, 1); assert.equal(reports, 0); const state = await durable.read();
    assert.equal(state.retriesUsed, 0); assert.equal(state.network?.status, "dispatching");
  }
});

test("durable waiting survives forward and backward clock jumps without shortening saved delay", async t => {
  for (const jump of [100000, -100000]) await t.test(String(jump), async subtest => {
    subtest.mock.timers.enable({ apis: ["setTimeout"] });
    let wallClock = 200000;
    subtest.mock.method(Date, "now", () => wallClock);
    let state: UpdateNetworkDurableState = { revision: 2, retriesUsed: 1, network: { actionKey: "manifest", requestSha256: "a".repeat(64), status: "waiting", delayMs: 1000, notBefore: 201000 } };
    const durable: UpdateNetworkDurableAdapter = { async read() { return structuredClone(state); }, async replace(expected, next) { assert.deepEqual(expected, state); state = { ...next, revision: state.revision + 1 }; return structuredClone(state); } };
    let calls = 0;
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
    const pending = retry.run(async () => { calls++; assert.equal(state.retriesUsed, 1); return "ok"; }, durableAction());
    await settle(); wallClock += jump;
    wallClock += 999; subtest.mock.timers.tick(999); await settle(); assert.equal(calls, 0);
    wallClock++; subtest.mock.timers.tick(1); await settle();
    if (jump < 0) { assert.equal(calls, 0); wallClock -= jump; subtest.mock.timers.tick(-jump); }
    assert.equal(await pending, "ok"); assert.equal(calls, 1);
  });
});

test("dispatch cancellation keeps the unknown slot and the exact reason", async () => {
  const { durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit");
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { abort.abort(reason); throw new DOMException("aborted", "AbortError"); }, durableAction()), error => error === reason);
  assert.equal((await durable.read()).network?.status, "dispatching"); assert.equal((await durable.read()).retriesUsed, 0);
});

for (const code of ["DESKTOP_UPDATE_TRANSPORT_FAILED", "DESKTOP_UPDATE_RESPONSE_INVALID", "DESKTOP_UPDATE_HTTP_FAILED"] as const) {
  for (const reasonKind of ["error", "scalar"] as const) test(`durable ${code} preserves wrapped ${reasonKind} cancellation without failing the attempt`, async () => {
    const { store, durable } = await durableFixture(), abort = new AbortController(), reason = reasonKind === "error" ? new Error("exit round") : "exit round";
    const wrapper = Object.assign(new Error(code, { cause: reason }), { code }), action = durableAction();
    const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail("cancel must not reserve a retry"); } });
    let calls = 0, rejected = false, observed: unknown;
    try { await retry.run(async () => { calls++; abort.abort(reason); throw wrapper; }, action); }
    catch (cause) { rejected = true; observed = cause; }
    assert.equal(rejected, true); assert.equal(observed, reason); assert.equal(calls, 1);
    assert.equal((await store.read())?.phase, "preparing"); assert.equal((await durable.read()).network?.status, "dispatching");
    assert.equal((await durable.read()).retriesUsed, 0);
    const resumed = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
    await assert.rejects(resumed.run(async () => { calls++; return "must not replay"; }, action), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
    assert.equal(calls, 1);
  });
}

for (const phase of ["fetch", "json"] as const) test(`the original signed transport ${phase} cancellation retains the durable unknown dispatch`, async t => {
  const { directory, store, durable } = await durableFixture(), identity = await loadOrCreateDeviceIdentity(directory), abort = new AbortController(), reason = new Error("exit round");
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options: RequestInit) => {
    sends++; assert.ok((options.headers as Record<string, string>)["x-codeflow-signature"]);
    if (phase === "fetch") { abort.abort(reason); throw new DOMException("cancelled", "AbortError"); }
    const response = new Response('{"ok":true}');
    t.mock.method(response, "json", async () => { abort.abort(reason); throw new DOMException("cancelled", "AbortError"); });
    return response;
  });
  const transport = createDesktopUpdateTransport({ dataDir: directory, identity, configuredServerOrigin: "http://127.0.0.1:39499" });
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => {
    await transport.requestJson({ method: "GET", path: "/api/software/desktop/json", requestId: "durable-cancel", signal: abort.signal });
    return "must not succeed";
  }, durableAction()), error => error === reason);
  assert.equal(sends, 1); assert.equal((await store.read())?.phase, "preparing");
  assert.equal((await durable.read()).network?.status, "dispatching"); assert.equal((await durable.read()).retriesUsed, 0);
});

for (const variant of ["aggregate-wrapper", "aggregate-cause", "different-cause", "unknown-wrapper", "not-aborted"] as const) {
  test(`durable ${variant} remains an explicit failure despite a cancellation-shaped cause`, async () => {
    const { store, durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit round"), failure = new Error("independent failure");
    const wrapper = Object.assign(variant === "aggregate-wrapper" ? new AggregateError([reason, failure], "cleanup failed", { cause: reason })
      : new Error("network failure", { cause: variant === "aggregate-cause" ? new AggregateError([reason, failure]) : variant === "different-cause" ? failure : reason }),
    { code: variant === "unknown-wrapper" ? "UNKNOWN_NETWORK_ERROR" : "DESKTOP_UPDATE_TRANSPORT_FAILED" });
    const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
    await assert.rejects(retry.run(async () => { if (variant !== "not-aborted") abort.abort(reason); throw wrapper; }, durableAction()), error => error === wrapper);
    assert.equal((await store.read())?.phase, "failed"); assert.equal((await durable.read()).network?.status, "failed");
    assert.equal((await durable.read()).retriesUsed, 0);
  });
}

test("persistResult and retry callback failures stay outside the network retry catch", async () => {
  for (const boundary of ["persist", "report"]) {
    const { durable } = await durableFixture(), failure = networkFailure(); let calls = 0;
    const action = durableAction(); if (boundary === "persist") action.persistResult = async () => { throw failure; };
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { throw failure; } });
    await assert.rejects(retry.run(async () => { calls++; if (boundary === "report") throw networkFailure(); return "ok"; }, action), error => error === failure);
    assert.equal(calls, 1); const state = await durable.read();
    assert.equal(state.network?.status, boundary === "persist" ? "dispatching" : "waiting"); assert.equal(state.retriesUsed, boundary === "persist" ? 0 : 1);
  }
});

test("failed-state write retains the primary cause including throw undefined", async () => {
  for (const primary of [undefined, networkFailure(), new AggregateError([networkFailure(), new Error("close")])]) {
    const { durable } = await durableFixture(), additional = new Error("save failed"); let calls = 0;
    const broken: UpdateNetworkDurableAdapter = { read: durable.read, async replace(expected, next) {
      if (next.network?.status === "failed" || next.network?.status === "waiting") throw additional;
      return durable.replace(expected, next);
    } };
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: broken, onRetry() { assert.fail(); } });
    await assert.rejects(retry.run(async () => { calls++; throw primary; }, durableAction()), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, additional]); return true;
    });
    assert.equal(calls, 1); assert.equal((await durable.read()).network?.status, "dispatching");
  }
});

test("one durable owner rejects concurrent and nested calls before another send", async () => {
  const { durable } = await durableFixture(); let release!: () => void, calls = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  const pending = retry.run(async () => { calls++; await hold; return "ok"; }, durableAction());
  await assert.rejects(retry.run(async () => { calls++; return "extra"; }, durableAction("other")), { code: "DESKTOP_SHELL_NETWORK_BUSY" });
  release(); await pending; assert.equal(calls, 1);
});

test("cancellation while reading or persisting a local result stops later side effects", async () => {
  for (const boundary of ["recover", "persist"] as const) {
    const { durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit");
    if (boundary === "recover") await durable.replace(await durable.read(), { retriesUsed: 0, network: { actionKey: "manifest", requestSha256: "a".repeat(64), status: "dispatching" } });
    const action = durableAction(); let calls = 0;
    if (boundary === "recover") action.recoverResult = async () => { abort.abort(reason); return { status: "verified", value: "local", evidence: { kind: "shell-manifest", sha256: "b".repeat(64) } }; };
    else action.persistResult = async () => { abort.abort(reason); return { kind: "shell-manifest", sha256: "b".repeat(64) }; };
    const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
    await assert.rejects(retry.run(async () => { calls++; return "manifest"; }, action), error => error === reason);
    assert.equal((await durable.read()).network?.status, "dispatching"); assert.equal(calls, boundary === "recover" ? 0 : 1);
  }
});

test("a transient failure racing cancellation preserves unknown dispatch without marking failed", async () => {
  const { durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit");
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { abort.abort(reason); throw networkFailure(); }, durableAction()), error => error === reason);
  assert.equal((await durable.read()).network?.status, "dispatching");
});

test("post-rename dispatch verification failure stops send and recovery sees the committed unknown", async t => {
  const { directory, durable } = await durableFixture(), rename = fs.rename, open = fs.open;
  const failure = new Error("readback failed"); let replaced = false, calls = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { await rename(...args); replaced = true; });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (replaced && String(args[0]) === path.join(directory, "shell-update-attempt.json")) { replaced = false; throw failure; }
    return open(...args);
  });
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { calls++; return "must not send"; }, durableAction()), error => {
    assert.equal((error as { stateReplaced: boolean }).stateReplaced, true); assert.equal((error as Error).cause, failure); return true;
  });
  await assert.rejects(retry.run(async () => { calls++; return "must not replay"; }, durableAction()), { code: "DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN" });
  assert.equal(calls, 0); assert.equal((await durable.read()).network?.status, "dispatching");
});

test("operation cleanup failure remains aggregate after cancellation and marks the action failed", async () => {
  const { store, durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit");
  const failure = new AggregateError([reason, new Error("close failed")]);
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { abort.abort(reason); throw failure; }, durableAction()), error => error === failure);
  assert.equal((await durable.read()).network?.status, "failed"); assert.equal((await store.read())?.phase, "failed");
});

test("durable action snapshots identity and hooks before read and rejects hostile input before IO", async () => {
  let reads = 0, calls = 0, getters = 0;
  const action = durableAction(), persisted: string[] = [];
  let state: UpdateNetworkDurableState = { revision: 0, retriesUsed: 0, network: null };
  const durable: UpdateNetworkDurableAdapter = { async read() { reads++; return structuredClone(state); }, async replace(expected, next) { assert.deepEqual(expected, state); state = { ...next, revision: state.revision + 1 }; return structuredClone(state); } };
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  const accessor = durableAction(); Object.defineProperty(accessor, "persistResult", { get() { getters++; return async () => ({}); } });
  for (const invalid of [undefined, null, {}, Object.create(action), { ...action, extra: true }, accessor, { ...action, requestSha256: "bad" }, { ...action, recoverResult: null }]) {
    await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, invalid as never), { code: "DESKTOP_SHELL_NETWORK_ACTION_INVALID" });
  }
  assert.equal(reads, 0); assert.equal(calls, 0); assert.equal(getters, 0);
  action.persistResult = async value => { persisted.push(value); return { kind: "shell-manifest", sha256: "b".repeat(64) }; };
  const pending = retry.run(async () => { calls++; return "manifest"; }, action);
  action.actionKey = "changed"; action.requestSha256 = "c".repeat(64); action.persistResult = async () => { assert.fail("mutated hook"); };
  assert.equal(await pending, "manifest"); assert.deepEqual(persisted, ["manifest"]); assert.equal(state.network?.actionKey, "manifest");
});

test("a succeeded action is verified from a real artifact in a fresh process", async () => {
  const { directory, durable } = await durableFixture(), action = durableAction();
  action.persistResult = async value => {
    const file = await fs.open(path.join(directory, "verified-result.txt"), "wx");
    try { await file.writeFile(value, "utf8"); await file.sync(); } finally { await file.close(); }
    return { kind: "shell-manifest", sha256: createHash("sha256").update(value).digest("hex") };
  };
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable, onRetry() { assert.fail(); } });
  await retry.run(async () => "trusted-artifact", action);
  const result = recoverInProcess(directory, `action.recoverResult = async evidence => {
    if (evidence?.kind !== 'shell-manifest') throw new Error('invalid evidence');
    const value = await fs.readFile(path.join(directory, 'verified-result.txt'), 'utf8');
    if (value !== 'trusted-artifact' || createHash('sha256').update(value).digest('hex') !== evidence.sha256) throw new Error('invalid artifact'); return { status: 'verified', value, evidence };
  }; const value = await retry.run(async () => { calls++; return 'forbidden'; }, action); console.log(JSON.stringify({ value, calls, state: await durable.read() }));`);
  assert.equal(result.value, "trusted-artifact"); assert.equal(result.calls, 0);
  await fs.writeFile(path.join(directory, "verified-result.txt"), "tampered-artifact", "utf8");
  const rejected = recoverInProcess(directory, `action.recoverResult = async evidence => {
    const value = await fs.readFile(path.join(directory, 'verified-result.txt'), 'utf8');
    if (createHash('sha256').update(value).digest('hex') !== evidence.sha256) throw Object.assign(new Error('artifact mismatch'), { code: 'TEST_ARTIFACT_INVALID' });
    return { status: 'verified', value, evidence };
  }; let code; try { await retry.run(async () => { calls++; return 'forbidden'; }, action); }
  catch (error) { if (error.code !== 'TEST_ARTIFACT_INVALID') throw error; code = error.code; }
  console.log(JSON.stringify({ code, calls }));`);
  assert.equal(rejected.code, "TEST_ARTIFACT_INVALID"); assert.equal(rejected.calls, 0);
});

test("fresh process repeats the complete saved nonzero delay before consuming its reservation", async () => {
  const { directory, durable } = await durableFixture();
  const identity = { actionKey: "manifest", requestSha256: "a".repeat(64) };
  await durable.replace(await durable.read(), { retriesUsed: 0, network: { ...identity, status: "dispatching" } });
  await durable.replace(await durable.read(), { retriesUsed: 1, network: { ...identity, status: "waiting", delayMs: 50, notBefore: Date.now() + 50 } });
  const result = recoverInProcess(directory, `const started = performance.now(); const value = await retry.run(async () => {
    calls++; const state = await durable.read(); if (state.retriesUsed !== 1 || state.network.status !== 'dispatching') throw new Error('unconsumed reservation'); return 'delayed';
  }, action); console.log(JSON.stringify({ value, calls, retries, elapsed: performance.now() - started, state: await durable.read() }));`);
  assert.equal(result.value, "delayed"); assert.equal(result.calls, 1); assert.equal(result.retries, 0);
  assert.ok((result.elapsed as number) >= 50); assert.equal((result.state as UpdateNetworkDurableState).retriesUsed, 1);
});

test("unconfirmed dispatch readback and succeeded-state save failures never trigger another network operation", async () => {
  for (const boundary of ["dispatching", "succeeded"] as const) {
    const { durable } = await durableFixture(), failure = networkFailure(); let calls = 0, reports = 0;
    const broken: UpdateNetworkDurableAdapter = { read: durable.read, async replace(expected, next) {
      const saved = await durable.replace(expected, next);
      if (next.network?.status === boundary) {
        if (boundary === "succeeded") throw failure;
        return { ...saved, revision: saved.revision + 1 };
      }
      return saved;
    } };
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, durable: broken, onRetry() { reports++; } });
    await assert.rejects(retry.run(async () => { calls++; return "manifest"; }, durableAction()), error => boundary === "dispatching"
      ? (error as { code: string }).code === "DESKTOP_SHELL_NETWORK_STATE_CONFLICT" : error === failure);
    assert.equal(calls, boundary === "dispatching" ? 0 : 1); assert.equal(reports, 0); assert.equal((await durable.read()).retriesUsed, 0);
  }
});

test("cancellation during the initial durable read prevents dispatch persistence", async () => {
  const { durable } = await durableFixture(), abort = new AbortController(), reason = new Error("exit"); let calls = 0;
  const delayed: UpdateNetworkDurableAdapter = { async read() { const state = await durable.read(); abort.abort(reason); return state; }, replace: durable.replace };
  const retry = createUpdateNetworkRetry({ signal: abort.signal, durable: delayed, onRetry() { assert.fail(); } });
  await assert.rejects(retry.run(async () => { calls++; return "forbidden"; }, durableAction()), error => error === reason);
  assert.equal(calls, 0); assert.equal((await durable.read()).network, null);
});

/** 模拟实际 transport 包装，避免把原生文件错误当成网络错误。 */
function networkFailure(code = "UND_ERR_SOCKET"): Error {
  return Object.assign(new Error("transport", { cause: new TypeError("fetch", {
    cause: Object.assign(new Error("socket"), { code }),
  }) }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: "retry-attempt" });
}

/** 使用真实事件循环清空异步链，不推进测试控制的定时器。 */
async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test("one network round shares three retries across successful and failing operations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: Array<{ retry: number; delayMs: number; error: unknown }> = [];
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: event => { events.push(event); } });
  let firstCalls = 0;
  const firstError = networkFailure();
  const first = retry.run(async () => { if (++firstCalls === 1) throw firstError; return "registered"; });
  await settle();
  assert.deepEqual(events, [{ retry: 1, delayMs: 1000, error: firstError }]);
  t.mock.timers.tick(999); await settle(); assert.equal(firstCalls, 1);
  t.mock.timers.tick(1); assert.equal(await first, "registered");
  let secondCalls = 0;
  const terminal = networkFailure("ECONNRESET");
  const second = assert.rejects(retry.run(async () => { secondCalls++; throw terminal; }), error => error === terminal);
  await settle(); t.mock.timers.tick(2000); await settle(); t.mock.timers.tick(4000); await second;
  assert.equal(secondCalls, 3);
  assert.deepEqual(events.map(event => [event.retry, event.delayMs]), [[1, 1000], [2, 2000], [3, 4000]]);
  await assert.rejects(retry.run(async () => { throw terminal; }), error => error === terminal);
  assert.equal(events.length, 3);
});

for (const status of [408, 429, 502, 503, 504]) {
  test(`ordinary HTTP ${status} can retry while preserving the original failure`, async () => {
    const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status, retryAfter: "0" });
    const events: unknown[] = [];
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: event => { events.push(event); } });
    let calls = 0;
    assert.equal(await retry.run(async () => { if (++calls === 1) throw failure; return "ok"; }), "ok");
    assert.deepEqual(events, [{ retry: 1, delayMs: 0, error: failure }]);
    assert.equal(calls, 2);
  });
}

test("only known transport wrappers permit transient socket or timeout roots", async t => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "timeout"]) {
    await t.test(code, async () => {
      const abort = new AbortController();
      const reason = new Error("stopped");
      const failure = code === "timeout" ? Object.assign(new Error("transport", { cause: new DOMException("timeout", "TimeoutError") }),
        { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" }) : networkFailure(code);
      let calls = 0, retries = 0;
      const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: event => {
        assert.equal(event.error, failure); retries++; abort.abort(reason);
      } });
      await assert.rejects(retry.run(async () => { calls++; throw failure; }), error => error === reason);
      assert.equal(calls, 1);
      assert.equal(retries, 1);
    });
  }
});

test("business, trust, storage, malformed JSON and aggregate failures never spend retry budget", async t => {
  const socket = networkFailure();
  const failures = [
    Object.assign(new Error("unavailable"), { code: "DESKTOP_UPDATE_UNAVAILABLE", status: 503, retryAfter: "0" }),
    Object.assign(new Error("throttled"), { code: "DESKTOP_UPDATE_THROTTLED", status: 429, retryAfter: "0" }),
    Object.assign(new Error("internal"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 500, retryAfter: "0" }),
    Object.assign(new Error("forbidden"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 403, retryAfter: "0" }),
    Object.assign(new Error("file pipe"), { code: "EPIPE" }),
    Object.assign(new Error("file timeout"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("untrusted", { cause: socket }), { code: "DESKTOP_RELEASE_SIGNATURE_INVALID" }),
    new Error("unknown wrapper", { cause: socket }),
    new DOMException("cancelled", "AbortError"),
    new DOMException("not transport", "TimeoutError"),
    Object.assign(new Error("invalid", { cause: new SyntaxError("JSON") }), { code: "DESKTOP_UPDATE_RESPONSE_INVALID" }),
    Object.assign(new Error("transport", { cause: Object.assign(new Error("TLS"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) }),
      { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" }),
    new AggregateError([socket, Object.assign(new Error("cleanup"), { code: "EIO" })]),
    Object.assign(new Error("transport", { cause: new AggregateError([socket]) }), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" }),
    Object.assign(new Error("HTTP", { cause: new AggregateError([socket]) }), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "0" }),
  ];
  for (const [index, failure] of failures.entries()) await t.test(String(index), async () => {
    let calls = 0, retries = 0;
    const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: () => { retries++; } });
    await assert.rejects(retry.run(async () => { calls++; throw failure; }), error => error === failure);
    assert.equal(calls, 1); assert.equal(retries, 0);
  });
});

test("Retry-After seconds and HTTP dates take priority while invalid values use backoff", async t => {
  for (const [header, delay] of [["0", 0], ["5", 5000], ["Wed, 21 Oct 2037 07:28:05 GMT", 5000],
    ["Wed, 21 Oct 2037 07:27:00 GMT", 0], ["1.5", 1000], ["-1", 1000], ["invalid", 1000], ["2037-10-21", 1000], [null, 1000]] as const) {
    await t.test(String(header), async subtest => {
      subtest.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("Wed, 21 Oct 2037 07:28:00 GMT") });
      let calls = 0;
      const events: number[] = [];
      const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: header });
      const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: event => { events.push(event.delayMs); } });
      const pending = retry.run(async () => { if (++calls === 1) throw failure; return "ok"; });
      await settle(); assert.deepEqual(events, [delay]);
      if (delay) { subtest.mock.timers.tick(delay - 1); await settle(); assert.equal(calls, 1); subtest.mock.timers.tick(1); }
      assert.equal(await pending, "ok");
    });
  }
});

test("long Retry-After waits are chunked, cancellable and retain the exact cancellation reason", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const reason = new Error("exit requested");
  const failure = Object.assign(new Error("gateway"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "4294968" });
  let calls = 0;
  const events: number[] = [];
  const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: event => { events.push(event.delayMs); } });
  const pending = assert.rejects(retry.run(async () => { calls++; throw failure; }), error => error === reason);
  await settle(); assert.deepEqual(events, [4294968000]);
  t.mock.timers.tick(2147483647); await settle(); assert.equal(calls, 1);
  abort.abort(reason); await pending;
  t.mock.timers.tick(4294968000); await settle(); assert.equal(calls, 1);
});

test("callback failure and cancellation before a call stop the original operation", async () => {
  const callbackFailure = new Error("state delivery failed");
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: () => { throw callbackFailure; } });
  await assert.rejects(retry.run(async () => { throw networkFailure(); }), error => error === callbackFailure);
  const abort = new AbortController(); const reason = new Error("already stopped"); abort.abort(reason);
  let calls = 0;
  const cancelled = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { assert.fail("unexpected retry"); } });
  await assert.rejects(cancelled.run(async () => { calls++; return "unexpected"; }), error => error === reason);
  assert.equal(calls, 0);
});

test("cancellation cannot replace an aggregate cleanup failure from the current operation", async () => {
  const abort = new AbortController();
  const reason = new Error("exit requested");
  const failure = new AggregateError([reason, Object.assign(new Error("close failed"), { code: "EIO" })]);
  const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { assert.fail("unexpected retry"); } });
  await assert.rejects(retry.run(async () => { abort.abort(reason); throw failure; }), error => error === failure);
});

test("a completed network action cannot return success after its round was cancelled", async () => {
  const abort = new AbortController();
  const reason = new Error("exit requested");
  const retry = createUpdateNetworkRetry({ signal: abort.signal, onRetry: () => { assert.fail("unexpected retry"); } });
  await assert.rejects(retry.run(async () => { abort.abort(reason); return "finished"; }), error => error === reason);
});

test("an asynchronous retry event failure stops before the next network attempt", async () => {
  const failure = new Error("state delivery failed");
  let calls = 0;
  const retry = createUpdateNetworkRetry({ signal: new AbortController().signal, onRetry: async () => { throw failure; } });
  await assert.rejects(retry.run(async () => { calls++; throw networkFailure(); }), error => error === failure);
  assert.equal(calls, 1);
});

test("network cancellation normalization preserves storage and aggregate causes after abort", () => {
  const abort = new AbortController();
  const reason = new Error("exit requested");
  const native = new DOMException("aborted", "AbortError");
  assert.equal(preserveUpdateNetworkCancellation(native, abort.signal), native);
  abort.abort(reason);
  assert.equal(preserveUpdateNetworkCancellation(native, abort.signal), reason);
  for (const cause of [reason, Object.assign(new Error("write failed"), { code: "EPIPE" }), new AggregateError([native, new Error("close failed")])]) {
    assert.equal(preserveUpdateNetworkCancellation(cause, abort.signal), cause);
  }
});
