import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopUpdateDetails } from "@codeflowai/shared";
import * as desktop from "../src/services/desktop.ts";

const deviceId = "12345678-1234-4234-8234-123456789abc";

/** 未取得版本和轮次时保留空事实，不制造最新或更新成功。 */
function details(): DesktopUpdateDetails {
  return { deviceId, current: { shellVersion: "1.2.3", bundle: null, clientVersion: "1.0.0" },
    bundle: { requestId: null, target: null, phase: null, result: "unknown", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "unknown", failure: null } };
}

/** 只替换preload传输，实际service验证数据；禁止通用请求或网络旁路。 */
function fixture(t: test.TestContext, read?: () => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let calls = 0;
  const bridge = { getState: async () => ({}), request: async () => { throw new Error("unexpected request"); },
    ...(read ? { getUpdateDetails: async (...args: unknown[]) => { assert.deepEqual(args, []); calls++; return await read(); } } : {}) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  return { bridge, calls: () => calls };
}

test("详细更新查询仅经独立零参数能力，旧壳明确缺能力", async t => {
  fixture(t);
  assert.equal(desktop.getDesktopUpdateCapabilities().details, false);
  assert.equal(typeof desktop.getDesktopUpdateDetails, "function");
  await assert.rejects(desktop.getDesktopUpdateDetails(), /DESKTOP_UPDATE_DETAILS_UNAVAILABLE/u);
});

test("两个更新通道的可信版本与明确结果保持独立", async t => {
  const value = details();
  value.current.bundle = { releaseId: "release-1", version: "1.0.0", webVersion: "1.0.1", clientVersion: "1.0.2" };
  value.bundle = { requestId: "update:bundle-1", target: { releaseId: "release-2", version: "2.0.0", webVersion: "2.0.1", clientVersion: "2.0.2" },
    phase: "rollback", result: "restored", failure: { requestId: "update:bundle-1", rootCause: { name: "Error", code: "CLIENT_HEALTH_VERSION_MISMATCH" } } };
  value.shell = { requestId: "shell-1", target: { shellId: "shell-2", version: "2.0.0" }, phase: "download", result: "manual_required", failure: null };
  const f = fixture(t, async () => value);
  assert.equal(desktop.getDesktopUpdateCapabilities().details, true);
  assert.deepEqual(await desktop.getDesktopUpdateDetails(), value);
  assert.equal(f.calls(), 1);
});

test("prepared保持待激活事实，不冒充healthy或当前版本", async t => {
  const value = details();
  value.bundle = { requestId: "prepared:resource", target: { releaseId: "next", version: "2026.11.09.02", webVersion: "next-web", clientVersion: "next-client" },
    phase: "prepare", result: "prepared", failure: null };
  fixture(t, async () => value);
  const actual = await desktop.getDesktopUpdateDetails();
  assert.equal(actual.bundle.result, "prepared");
  assert.deepEqual(actual.current, { shellVersion: "1.2.3", bundle: null, clientVersion: "1.0.0" });
});

test("原宿主拒绝包括falsy值保持失败原值", async t => {
  let cause: unknown;
  fixture(t, async () => { throw cause; });
  for (cause of [new Error("original failure"), undefined, null, false, 0, ""]) {
    let rejected = false;
    try { await desktop.getDesktopUpdateDetails(); } catch (error) { rejected = true; assert.equal(error, cause); }
    assert.equal(rejected, true);
  }
});

test("详情拒绝私密字段、未知结果、错误阶段及不安全身份", async t => {
  let value: unknown;
  fixture(t, async () => value);
  const base = details();
  const invalid: unknown[] = [null, {}, { ...base, privatePath: "F:/private" }, { ...base, deviceId: "private/device" },
    { ...base, current: { ...base.current, shellVersion: " 1.0 " } },
    { ...base, current: { ...base.current, bundle: { releaseId: "r", version: "1", webVersion: null, clientVersion: "1" } } },
    { ...base, bundle: { ...base.bundle, result: "latest" } }, { ...base, bundle: { ...base.bundle, phase: "install" } },
    { ...base, shell: { ...base.shell, phase: "reload-web" } }, { ...base, shell: { ...base.shell, requestId: "update:/private" } },
    { ...base, bundle: { ...base.bundle, target: { releaseId: "r", version: "1", webVersion: "1", clientVersion: "1", signature: "secret" } } },
    { ...base, bundle: { ...base.bundle, failure: { requestId: "a", rootCause: { name: "Error", code: "EIO", message: "private" } } } }];
  for (value of invalid) await assert.rejects(desktop.getDesktopUpdateDetails(), /DESKTOP_UPDATE_DETAILS_INVALID/u);
});

test("详情不会求值响应访问器或调用对象强制转换", async t => {
  let reads = 0;
  let value: unknown = Object.defineProperty(details(), "bundle", { enumerable: true, get() { reads++; return {}; } });
  fixture(t, async () => value);
  await assert.rejects(desktop.getDesktopUpdateDetails(), /DESKTOP_UPDATE_DETAILS_INVALID/u);
  assert.equal(reads, 0);
  value = { ...details(), shell: { ...details().shell, phase: { toString() { reads++; return "health"; } } } };
  await assert.rejects(desktop.getDesktopUpdateDetails(), /DESKTOP_UPDATE_DETAILS_INVALID/u);
  assert.equal(reads, 0);
});

test("验签合同允许的版本文本不会被ID规则误拒，发布ID仍限制路径段", async t => {
  const value = details();
  value.current.shellVersion = "2.0 候选版";
  value.current.clientVersion = "构建版本-" + "a".repeat(300);
  value.current.bundle = { releaseId: "r".repeat(300), version: "应用 2.0", webVersion: "网页候选版", clientVersion: "客户端候选版" };
  value.shell.target = { shellId: "shell-2", version: "桌面壳候选版" };
  fixture(t, async () => value);
  assert.deepEqual(await desktop.getDesktopUpdateDetails(), value);
  for (const releaseId of ["r/invalid", "CON", "release.", "release+2"]) {
    value.current.bundle.releaseId = releaseId;
    await assert.rejects(desktop.getDesktopUpdateDetails(), /DESKTOP_UPDATE_DETAILS_INVALID/u);
  }
});
