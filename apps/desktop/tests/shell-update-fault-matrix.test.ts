import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  validateCandidateShellHealthReport,
  type CandidateShellHealthCheck,
  type CandidateShellHealthReport,
  type CandidateShellHealthRequest,
} from "../src/candidateShellHealth.js";
import {
  createUpdateNetworkRetry,
  preserveUpdateNetworkCancellation,
  snapshotUpdateNetworkDurableState,
} from "../src/updateNetworkRetry.js";

/**
 * D13 故障矩阵：网络重试分类、耐久状态畸形与健康报告身份错配。
 * 只调用现有导出，不修改产品代码；单片通过不代表真实换壳或跨重启恢复已验收。
 */

/** 构造固定包装码的网络错误；Retry-After 置 0 避免矩阵真实等待。 */
function networkFailure(code: string, cause?: unknown, status?: number): Error {
  return Object.assign(new Error(code, { cause }), { code, status, retryAfter: "0" });
}

/** 记录重试次数与延迟，并可在 onRetry 中提前中止，避免长等待。 */
function retryingOperation(error: Error, block = 4) {
  let attempts = 0;
  const delays: number[] = [];
  const controller = new AbortController();
  const retry = createUpdateNetworkRetry({
    signal: controller.signal,
    onRetry(context) {
      delays.push(context.delayMs);
      if (delays.length >= block) controller.abort(new Error("matrix-stop"));
    },
  });
  return { retry, attempts: () => attempts, delays, controller, operation: async () => { attempts++; throw error; } };
}

test("HTTP 503 retries three times with zero Retry-After then rethrows the original error", async () => {
  const error = networkFailure("DESKTOP_UPDATE_HTTP_FAILED", new Error("busy"), 503);
  const fixture = retryingOperation(error, Number.MAX_SAFE_INTEGER);
  await assert.rejects(() => fixture.retry.run(fixture.operation), candidate => candidate === error);
  assert.equal(fixture.attempts(), 4);
  assert.deepEqual(fixture.delays, [0, 0, 0]);
});

test("HTTP 400 and non-transient transport causes are not retried", async () => {
  for (const error of [networkFailure("DESKTOP_UPDATE_HTTP_FAILED", new Error("bad request"), 400),
    networkFailure("DESKTOP_UPDATE_TRANSPORT_FAILED", Object.assign(new Error("denied"), { code: "EACCES" }))]) {
    const fixture = retryingOperation(error, Number.MAX_SAFE_INTEGER);
    await assert.rejects(() => fixture.retry.run(fixture.operation), candidate => candidate === error);
    assert.equal(fixture.attempts(), 1);
  }
});

test("transport ECONNRESET is classified transient while AggregateError is never retried", async () => {
  const transient = retryingOperation(networkFailure("DESKTOP_UPDATE_TRANSPORT_FAILED", Object.assign(new Error("reset"), { code: "ECONNRESET" })), 2);
  await assert.rejects(() => transient.retry.run(transient.operation), /matrix-stop/u);
  assert.equal(transient.attempts(), 2);

  const aggregate = new AggregateError([networkFailure("DESKTOP_UPDATE_TRANSPORT_FAILED", Object.assign(new Error("reset"), { code: "ECONNRESET" }))], "AGGREGATE");
  const fixture = retryingOperation(aggregate, Number.MAX_SAFE_INTEGER);
  await assert.rejects(() => fixture.retry.run(fixture.operation), candidate => candidate === aggregate);
  assert.equal(fixture.attempts(), 1);
});

test("invalid Retry-After falls back to the first exponential delay", async () => {
  const error = Object.assign(networkFailure("DESKTOP_UPDATE_HTTP_FAILED", new Error("busy"), 503), { retryAfter: "not-a-date" });
  const fixture = retryingOperation(error, 1);
  await assert.rejects(() => fixture.retry.run(fixture.operation), /matrix-stop/u);
  assert.deepEqual(fixture.delays, [1_000]);
});

test("abort during retry wait preserves the caller reason", async () => {
  const reason = new Error("caller-abort");
  const controller = new AbortController();
  let attempts = 0;
  const retry = createUpdateNetworkRetry({ signal: controller.signal,
    onRetry() { controller.abort(reason); } });
  await assert.rejects(() => retry.run(async () => {
    attempts++;
    throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED"), { code: "DESKTOP_UPDATE_HTTP_FAILED", status: 503, retryAfter: "5" });
  }), candidate => candidate === reason);
  assert.equal(attempts, 1);
});

test("only DOMException AbortError maps to the signal reason", () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  assert.equal(preserveUpdateNetworkCancellation(new DOMException("aborted", "AbortError"), controller.signal), reason);
  const other = new Error("other");
  assert.equal(preserveUpdateNetworkCancellation(other, controller.signal), other);
});

test("durable state snapshot rejects malformed revisions, fields and slots", () => {
  assert.deepEqual(snapshotUpdateNetworkDurableState({ revision: 0, retriesUsed: 0, network: null }), { revision: 0, retriesUsed: 0, network: null });
  const invalid: unknown[] = [
    { revision: -1, retriesUsed: 0, network: null },
    { revision: 0, retriesUsed: 4, network: null },
    { revision: 0, retriesUsed: 0, network: null, extra: true },
    { revision: 0, retriesUsed: 0, network: { actionKey: "a", requestSha256: "0".repeat(64), status: "unknown" } },
    { revision: 0, retriesUsed: 0, network: { actionKey: "a", requestSha256: "0".repeat(64), status: "waiting" } },
    { revision: 0, retriesUsed: 0, network: { actionKey: "a", requestSha256: "0".repeat(64), status: "succeeded",
      evidence: { kind: "unknown", sha256: "0".repeat(64) } } },
    { revision: 0, retriesUsed: 0, network: { actionKey: "a", requestSha256: "0".repeat(64), status: "failed", errorCode: "lower" } },
  ];
  for (const value of invalid) assert.throws(() => snapshotUpdateNetworkDurableState(value), /DESKTOP_SHELL_NETWORK_STATE_INVALID/u);

  const hostile = Object.defineProperty({ retriesUsed: 0, network: null }, "revision", { enumerable: true, get: () => 0 });
  assert.throws(() => snapshotUpdateNetworkDurableState(hostile), /DESKTOP_SHELL_NETWORK_STATE_INVALID/u);
});

/** 构造满足严格字段的健康请求、选择与通过报告。 */
function healthFixture(): { request: CandidateShellHealthRequest; selections: Array<Pick<CandidateShellHealthCheck, "role" | "releaseId" | "releaseDir">>; report: CandidateShellHealthReport } {
  const request: CandidateShellHealthRequest = { schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId: "candidate-1",
    installationDir: "C:\\installation", sourceDataDir: "C:\\data", candidateExecutablePath: "C:\\installation\\CodeFlowAI.exe",
    temporaryRoot: "C:\\temp\\health-1", timeoutMs: 30_000 };
  const selections = [
    { role: "baseline" as const, releaseId: "installation", releaseDir: "C:\\installation\\shells\\baseline\\resources" },
    { role: "active" as const, releaseId: "binding-1", releaseDir: "C:\\data\\releases\\binding-1" },
  ];
  const checks: CandidateShellHealthCheck[] = selections.map(selected => ({ ...selected, childClosed: true,
    health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 92, database: "ready" },
    native: { loaded: ["a.node", "b.node", "c.node", "keyring.node"], credentialsAccessed: false, ptyCreated: false },
    web: { files: ["codeflow://desktop/"] }, database: { integrity: "ok", schemaVersion: 92 } }));
  return { request, selections, report: { schemaVersion: 1, requestId: request.requestId, candidateShellId: request.candidateShellId,
    temporaryRoot: request.temporaryRoot, status: "passed", checks, phase: "complete" } };
}

test("health report rejects request identity mismatch and missing failure evidence", () => {
  const f = healthFixture();
  assert.deepEqual(validateCandidateShellHealthReport(f.report, f.request, f.selections), f.report);
  const mutations: Array<(report: CandidateShellHealthReport) => void> = [
    report => { report.requestId = crypto.randomUUID(); },
    report => { report.candidateShellId = "candidate-2"; },
    report => { report.temporaryRoot = "C:\\temp\\other"; },
    report => { report.phase = "active:1"; },
    report => { report.checks = []; },
    report => { report.status = "failed"; delete report.error; },
  ];
  for (const mutate of mutations) {
    const report = structuredClone(f.report);
    mutate(report);
    assert.throws(() => validateCandidateShellHealthReport(report, f.request, f.selections), /DESKTOP_SHELL_HEALTH_REPORT_INVALID/u);
  }
});

test("health report rejects unclosed child and credential access claims", () => {
  const f = healthFixture();
  for (const mutate of [
    (check: CandidateShellHealthCheck) => { check.childClosed = false as true; },
    (check: CandidateShellHealthCheck) => { check.native.credentialsAccessed = true as false; },
  ]) {
    const report = structuredClone(f.report);
    mutate(report.checks[0]!);
    assert.throws(() => validateCandidateShellHealthReport(report, f.request, f.selections), /DESKTOP_SHELL_HEALTH_REPORT_INVALID/u);
  }
});
