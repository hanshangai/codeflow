import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopUpdateDiagnostics, DesktopUpdateState } from "@codeflowai/shared";
import * as desktop from "../src/services/desktop.ts";

const deviceId = "12345678-1234-4234-8234-123456789abc";

/** 完整冻结快照；本测试不派生宿主更新结论。 */
function state(): DesktopUpdateState {
  return { deviceId, operation: "idle", checking: false, transportConfigured: true, automaticUpdates: true,
    updatesSuppressed: false, stoppingUpdates: false, shellOwned: false, updateCheckFailure: null,
    shellUpdateFailure: null, updateReceiptFailure: null, updateFailureFailure: null };
}

/** 仅替换 preload；任何 HTTP 或通用请求回落都会失败。 */
function fixture(t: test.TestContext, methods: Record<string, unknown> = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: unknown[] = [], fetches: unknown[] = [], calls: Array<{ method: string; args: unknown[] }> = [];
  const bridge: Record<string, unknown> = { getState: async () => ({}),
    request: async (...args: unknown[]) => { requests.push(args); throw new Error("unexpected request"); }, ...methods };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => { fetches.push(args); throw new Error("unexpected fetch"); });
  t.after(() => { assert.deepEqual(requests, []); assert.deepEqual(fetches, []); if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  return { bridge, calls,
    /** 记录实际固定能力的参数，不替换 service。 */
    method(name: string, value: unknown) { bridge[name] = async (...args: unknown[]) => { calls.push({ method: name, args }); return value; }; },
  };
}

test("三个更新能力独立检测并只经固定零参数桥调用", async t => {
  const f = fixture(t);
  assert.equal(typeof desktop.getDesktopUpdateCapabilities, "function", "service must expose fixed update capabilities");
  assert.deepEqual(desktop.getDesktopUpdateCapabilities(), { state: false, check: false, diagnostics: false, details: false, restart: false, notice: false });
  f.method("getUpdateState", state());
  assert.deepEqual(desktop.getDesktopUpdateCapabilities(), { state: true, check: false, diagnostics: false, details: false, restart: false, notice: false });
  assert.deepEqual(await desktop.getDesktopUpdateState(), state());
  f.method("checkForUpdates", { privatePath: "must not escape" });
  assert.equal(await desktop.checkDesktopForUpdates(), undefined);
  f.method("getUpdateDiagnostics", { deviceId, failures: [] } satisfies DesktopUpdateDiagnostics);
  assert.deepEqual(await desktop.getDesktopUpdateDiagnostics(), { deviceId, failures: [] });
  assert.deepEqual(f.calls, [{ method: "getUpdateState", args: [] }, { method: "checkForUpdates", args: [] }, { method: "getUpdateDiagnostics", args: [] }]);
});

test("缺桥与缺单能力均显式拒绝，其他能力仍可用", async t => {
  const f = fixture(t, { getUpdateState: async () => state() });
  await assert.rejects(desktop.checkDesktopForUpdates(), /DESKTOP_UPDATE_CHECK_UNAVAILABLE/u);
  await assert.rejects(desktop.getDesktopUpdateDiagnostics(), /DESKTOP_UPDATE_DIAGNOSTICS_UNAVAILABLE/u);
  assert.deepEqual(await desktop.getDesktopUpdateState(), state());
  delete f.bridge.getUpdateState;
  await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_UNAVAILABLE/u);
  Reflect.deleteProperty(globalThis, "window");
  assert.deepEqual(desktop.getDesktopUpdateCapabilities(), { state: false, check: false, diagnostics: false, details: false, restart: false, notice: false });
  await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_UNAVAILABLE/u);
});

test("重启更新使用固定零参数能力，旧壳与宿主拒绝均显式失败", async t => {
  const f = fixture(t);
  const { restartDesktopForUpdate } = await import("../src/services/desktop.ts");
  assert.equal(typeof restartDesktopForUpdate, "function");
  await assert.rejects(restartDesktopForUpdate(), /DESKTOP_UPDATE_RESTART_UNAVAILABLE/u);
  f.method("restartForUpdate", { privatePath: "must not escape" });
  assert.equal(desktop.getDesktopUpdateCapabilities().restart, true);
  assert.equal(await restartDesktopForUpdate(), undefined);
  assert.deepEqual(f.calls, [{ method: "restartForUpdate", args: [] }]);
  const cause = new Error("RESTART_FAILED");
  f.bridge.restartForUpdate = async () => { throw cause; };
  await assert.rejects(restartDesktopForUpdate(), error => error === cause);
});

for (const cause of [new Error("original failure"), undefined, null, false, 0, ""]) {
  test(`原桥拒绝原样传播：${String(cause)}`, async t => {
    fixture(t, { getUpdateState: async () => { throw cause; }, checkForUpdates: async () => { throw cause; }, getUpdateDiagnostics: async () => { throw cause; } });
    for (const call of [desktop.getDesktopUpdateState, desktop.checkDesktopForUpdates, desktop.getDesktopUpdateDiagnostics]) {
      let rejected = false;
      try { await call(); } catch (error) { rejected = true; assert.equal(error, cause); }
      assert.equal(rejected, true);
    }
  });
}

test("坏状态、额外私密字段和访问器不能作为安全快照发布", async t => {
  const f = fixture(t);
  for (const invalid of [null, {}, { ...state(), checking: "false" }, { ...state(), operation: "latest" },
    { ...state(), privatePath: "C:/secret" }, { ...state(), deviceId: "C:/secret" },
    { ...state(), updateCheckFailure: { requestId: "request-1", rootCause: { name: "Error", code: "EIO", message: "private" } } }]) {
    f.method("getUpdateState", invalid);
    await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_INVALID/u);
  }
  let reads = 0;
  const invalid = Object.defineProperty(state(), "checking", { enumerable: true, get: () => { reads++; return false; } });
  f.method("getUpdateState", invalid);
  await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_INVALID/u);
  assert.equal(reads, 0);
  const coercion = { toString: () => { reads++; return "idle"; } };
  f.method("getUpdateState", { ...state(), operation: coercion });
  await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_INVALID/u);
  assert.equal(reads, 0);
});

test("状态故障关联沿宿主短ID合同接受冒号并拒绝路径与超长值", async t => {
  const f = fixture(t);
  for (const field of ["updateCheckFailure", "shellUpdateFailure", "updateReceiptFailure", "updateFailureFailure"] as const) {
    const value = { ...state(), [field]: { requestId: "update:receipt-1", rootCause: { name: "Error", code: "EIO" } } };
    f.method("getUpdateState", value);
    assert.deepEqual(await desktop.getDesktopUpdateState(), value);
    for (const requestId of ["update:/private", "x".repeat(257)]) {
      f.method("getUpdateState", { ...value, [field]: { ...value[field], requestId } });
      await assert.rejects(desktop.getDesktopUpdateState(), /DESKTOP_UPDATE_STATE_INVALID/u);
    }
  }
});

test("诊断安全字段与故障树可读取，坏历史不能变成空历史", async t => {
  const f = fixture(t);
  const record = { schemaVersion: 1, kind: "failure", deviceId, shellVersion: "1.0.0", currentReleaseId: "release-1", webVersion: "1", clientVersion: "1",
    errorId: "22345678-1234-4234-8234-123456789abc", at: "2026-11-02T00:00:00.000Z", errorCode: "DESKTOP_SHELL_UPDATE_FAILED", requestId: "request-1",
    shellId: null, phase: "health", recovery: "failed", rootCause: { name: "AggregateError", code: "UNCLASSIFIED_ERROR", causes: [{ name: "Error", code: "EIO" }] },
    rollbackError: null, payloadSha256: "a".repeat(64) };
  f.method("getUpdateDiagnostics", { deviceId, failures: [{ record, reported: true }] });
  assert.deepEqual(await desktop.getDesktopUpdateDiagnostics(), { deviceId, failures: [{ record, reported: true }] });
  const manyCauses = { ...record, rootCause: { name: "AggregateError", code: "UNCLASSIFIED_ERROR", causes: Array.from({ length: 11 }, () => ({ name: "Error", code: "EIO" })) } };
  f.method("getUpdateDiagnostics", { deviceId, failures: [{ record: manyCauses, reported: false }] });
  assert.deepEqual(await desktop.getDesktopUpdateDiagnostics(), { deviceId, failures: [{ record: manyCauses, reported: false }] });
  for (const invalid of [null, { deviceId }, { deviceId, failures: null }, { deviceId, failures: [{ record, reported: "true" }] },
    { deviceId, failures: [{ record: { ...record, message: "secret" }, reported: false }] },
    { deviceId, failures: [{ record: { ...record, deviceId: "32345678-1234-4234-8234-123456789abc" }, reported: false }] }]) {
    f.method("getUpdateDiagnostics", invalid);
    await assert.rejects(desktop.getDesktopUpdateDiagnostics(), /DESKTOP_UPDATE_DIAGNOSTICS_INVALID/u);
  }
});
