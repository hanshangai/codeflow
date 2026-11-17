import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";
import * as desktop from "../src/services/desktop.ts";
import * as desktopUpdateLabels from "../src/features/settings/desktopUpdateLabels.ts";
import * as upgradeNotes from "../src/utils/upgradeNotes.ts";
import type { DesktopUpdateState } from "@codeflowai/shared";
import * as shared from "@codeflowai/shared";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const panelPath = new URL("../src/features/settings/components/desktop-update-panel.vue", import.meta.url);
const deviceId = "12345678-1234-4234-8234-123456789abc";
type Pending = { resolve: (value: any) => void; reject: (error: unknown) => void };

/** 保留冻结字段，粗状态不承诺更新成功。 */
function snapshot(operation: DesktopUpdateState["operation"] = "idle"): DesktopUpdateState {
  return { deviceId, operation, checking: false, transportConfigured: true, automaticUpdates: false, updatesSuppressed: true,
    stoppingUpdates: false, shellOwned: false, updateCheckFailure: null, shellUpdateFailure: null, updateReceiptFailure: null, updateFailureFailure: null };
}

/** 排空 Vue 与有限 Promise 续体，无计时器或网络等待。 */
async function settle() { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick(); }

/** 执行完整真实 setup，仅替换 preload 和生命周期边界。 */
function fixture(t: test.TestContext, active = false) {
  assert.equal(existsSync(panelPath), true, "desktop update panel must exist");
  const script = compileScript(parse(readFileSync(panelPath, "utf8")).descriptor, { id: "desktop-update-test" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const states: Pending[] = [], checks: Pending[] = [], restarts: Pending[] = [], diagnostics: Pending[] = [], logs: unknown[][] = [], unmount: Array<() => void> = [];
  /** 固定能力记录零参数事实，测试控制实际 IPC 结算时序。 */
  const pending = (items: Pending[]) => (...args: unknown[]) => {
    assert.deepEqual(args, []);
    return new Promise((resolve, reject) => items.push({ resolve, reject }));
  };
  const bridge = { getState: async () => ({}), request: async () => { throw new Error("unexpected request"); },
    getUpdateState: pending(states), checkForUpdates: pending(checks), restartForUpdate: pending(restarts), getUpdateDiagnostics: pending(diagnostics),
    reportUpdateError: async () => {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onUnmounted: (callback: () => void) => unmount.push(callback) };
    if (id === "vue-router") return { useRouter: () => ({ push: () => undefined }) };
    if (id === "../../../services/desktop") return desktop;
    if (id === "@codeflowai/shared") return shared;
    if (id === "@ant-design/icons-vue") return { ExportOutlined: {} };
    if (id === "../desktopUpdateLabels") return desktopUpdateLabels;
    if (id === "../../../utils/upgradeNotes") return upgradeNotes;
    throw new Error(`unexpected panel import: ${id}`);
  }, module, module.exports);
  const props = vue.reactive({ active }), scope = vue.effectScope();
  const panel = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!;
  t.after(async () => {
    unmount.forEach(callback => callback()); scope.stop();
    states.forEach(item => item.resolve(snapshot())); checks.forEach(item => item.resolve(undefined)); restarts.forEach(item => item.resolve(undefined)); diagnostics.forEach(item => item.resolve({ deviceId, failures: [] }));
    await settle();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  return { panel, props, states, checks, restarts, diagnostics, logs, unmount, bridge };
}

/** 激活并交付首个真实 service 状态查询。 */
async function ready(f: ReturnType<typeof fixture>) {
  f.props.active = true; await settle(); f.states.at(-1)!.resolve(snapshot()); await settle();
}

test("inactive 零读取，激活、重新激活及新实例只查询即时状态", async t => {
  const f = fixture(t); await settle(); assert.equal(f.states.length, 0); assert.equal(f.diagnostics.length, 0);
  await ready(f); assert.equal(f.states.length, 1); assert.deepEqual(f.panel.state.value, snapshot());
  f.props.active = false; await settle(); f.props.active = true; await settle();
  assert.equal(f.states.length, 2); assert.equal(f.checks.length, 0); assert.equal(f.diagnostics.length, 0);
  const fresh = fixture(t, true); await settle(); assert.equal(fresh.states.length, 1); assert.equal(fresh.checks.length, 0);
});

for (const outcome of ["success", "failure"] as const) test(`关闭后的旧状态${outcome}不能覆盖重新激活查询`, async t => {
  const f = fixture(t, true); await settle();
  f.props.active = false; await settle(); f.props.active = true; await settle();
  f.states[1].resolve(snapshot("flushing")); await settle();
  if (outcome === "success") f.states[0].resolve(snapshot("downloading")); else f.states[0].reject(new Error("private stale failure"));
  await settle(); assert.equal(f.panel.state.value.operation, "flushing"); assert.equal(f.panel.stateError.value, null); assert.deepEqual(f.logs, []);
});

test("同次激活查询乱序与卸载后的失败不发布旧结果", async t => {
  const f = fixture(t); await ready(f);
  const old = f.panel.loadState(), latest = f.panel.loadState();
  f.states[2].resolve(snapshot("checking")); await latest;
  f.states[1].resolve(snapshot("downloading")); await old;
  assert.equal(f.panel.state.value.operation, "checking");
  const late = f.panel.loadState(); f.unmount.forEach(callback => callback());
  f.states[3].reject(false); await late; assert.equal(f.panel.stateError.value, null);
});

test("重复点击只派一次，void 后只查状态且不读诊断", async t => {
  const f = fixture(t); await ready(f);
  const first = f.panel.retry(), duplicate = f.panel.retry(); await settle();
  assert.equal(f.checks.length, 1); assert.equal(f.panel.checkingBusy.value, true);
  f.checks[0].resolve(undefined); await settle(); assert.equal(f.states.length, 2);
  f.states[1].resolve(snapshot()); await Promise.all([first, duplicate]);
  assert.equal(f.panel.checkingBusy.value, false); assert.equal(f.panel.actionError.value, null); assert.equal(f.diagnostics.length, 0);
});

for (const cause of [new Error("private token C:/secret"), undefined, null, false, 0, ""]) test(`检查原拒绝显式失败且没有后续查询：${String(cause)}`, async t => {
  const f = fixture(t); await ready(f); const run = f.panel.retry(); f.checks[0].reject(cause); await run;
  assert.equal(f.states.length, 1); assert.equal(f.panel.checkingBusy.value, false); assert.ok(f.panel.actionError.value);
  assert.doesNotMatch(JSON.stringify(f.panel.actionError.value), /secret|private token/u); assert.deepEqual(f.logs, []);
});

test("检查后的状态刷新失败保持明确失败，旧快照不能盖过失败", async t => {
  const f = fixture(t); await ready(f); const run = f.panel.retry(); f.checks[0].resolve(undefined); await settle();
  f.states[1].reject(null); await run;
  assert.ok(f.panel.stateError.value); assert.deepEqual(f.panel.state.value, snapshot()); assert.equal(f.panel.stateLoading.value, false);
});

for (const outcome of ["success", "failure"] as const) test(`关闭期间检查${outcome}不派生查询或重发`, async t => {
  const f = fixture(t); await ready(f); const run = f.panel.retry();
  f.props.active = false; await settle();
  if (outcome === "success") f.checks[0].resolve(undefined); else f.checks[0].reject(false);
  await run; assert.equal(f.states.length, 1); assert.equal(f.panel.actionError.value, null);
  f.props.active = true; await settle(); assert.equal(f.states.length, 2); assert.equal(f.checks.length, 1);
});

test("诊断只按需读取并展开，失败明确可见且关闭后迟到无效", async t => {
  const f = fixture(t); await ready(f); assert.equal(f.diagnostics.length, 0);
  const read = f.panel.viewDiagnostics(); assert.equal(f.panel.diagnosticsOpen.value, true);
  f.diagnostics[0].resolve({ deviceId, failures: [] }); await read;
  assert.deepEqual(f.panel.diagnostics.value, { deviceId, failures: [] });
  const failed = f.panel.viewDiagnostics(); f.diagnostics[1].reject(0); await failed; assert.ok(f.panel.diagnosticsError.value);
  const late = f.panel.viewDiagnostics(); f.props.active = false; await settle(); f.diagnostics[2].reject(false); await late;
  assert.equal(f.panel.diagnosticsError.value, null);
});

test("缺单能力与坏响应明确展示并仅记录 Web 自有固定错误", async t => {
  const f = fixture(t); delete (f.bridge as Partial<typeof f.bridge>).getUpdateDiagnostics; await ready(f);
  assert.equal(f.panel.capabilities.value.check, true); assert.equal(f.panel.capabilities.value.diagnostics, false);
  await f.panel.viewDiagnostics(); assert.ok(f.panel.diagnosticsError.value);
  const read = f.panel.loadState(); f.states.at(-1)!.resolve({ ...snapshot(), privatePath: "C:/secret" }); await read;
  assert.ok(f.panel.stateError.value); assert.doesNotMatch(JSON.stringify(f.logs), /secret|privatePath/u); assert.equal(f.logs.length, 2);
});

test("动作禁用仅消费能力、busy 和明确配置/退出/交接事实", async t => {
  const f = fixture(t); await ready(f);
  f.panel.state.value = { ...snapshot(), operation: "downloading", checking: true, updateCheckFailure: { requestId: "request-1", rootCause: { name: "Error", code: "EIO" } } };
  assert.equal(f.panel.retryDisabled.value, false);
  for (const patch of [{ transportConfigured: false }, { stoppingUpdates: true }, { shellOwned: true }, { operation: "exiting" }]) {
    f.panel.state.value = { ...snapshot(), ...patch }; assert.equal(f.panel.retryDisabled.value, true);
  }
});

test("prepared与healthy区分待重启和已生效，当前版本只取实际运行资源", async t => {
  const f = fixture(t); await ready(f);
  f.panel.state.value = snapshot();
  const bundleTarget = { releaseId: "release-2", version: "2026.11.09.02", webVersion: "2.0.0", clientVersion: "2.0.0" };
  const base = {
    deviceId,
    current: { shellVersion: "1.0.0", bundle: { releaseId: "current", version: "2026.11.08.01", webVersion: "1", clientVersion: "1" }, clientVersion: "1.0.0" },
    bundle: { requestId: null, target: bundleTarget, phase: null, result: "failure" as const, failure: null },
    shell: { requestId: null, target: null, phase: null, result: "unknown" as const, failure: null },
  };
  f.panel.details.value = base;
  assert.equal(f.panel.preparedTargetText.value, "");
  assert.notEqual(f.panel.statusSummary.value, "当前已是最新版本。");

  f.panel.details.value = {
    ...base,
    bundle: { ...base.bundle, result: "prepared" },
    shell: { ...base.shell, result: "same" },
  };
  assert.match(f.panel.preparedTargetText.value, /1\.0\.1109\.2/u);
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
  assert.match(f.panel.statusSummary.value, /重启.*检查桌面壳/u);
  f.panel.details.value = { ...base, bundle: { ...base.bundle, result: "healthy" } };
  assert.equal(f.panel.preparedTargetText.value, "");
  assert.match(f.panel.statusSummary.value, /应用内容已更新.*桌面壳尚未检查/u);

  f.panel.details.value = {
    ...base,
    bundle: { ...base.bundle, target: null, result: "same" },
    shell: { ...base.shell, result: "same" },
  };
  assert.equal(f.panel.statusSummary.value, "当前已是最新版本。");
});

test("设置页的当前版本缺资源时明确未标记，壳版本仅留在诊断", t => {
  const f = fixture(t);
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "未知" }]);
  f.panel.details.value = { deviceId, current: { shellVersion: "1.0.0", bundle: null, clientVersion: "2026.10.19.01" },
    bundle: { requestId: "next", target: { releaseId: "next", version: "2026.11.09.02", webVersion: "web", clientVersion: "client" }, phase: "prepare", result: "prepared", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "same", failure: null } };
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "资源版本未标记" }]);
  assert.equal(f.panel.technicalRows.value.find((row: { label: string }) => row.label === "桌面壳").value, "1.0.0");
  f.panel.details.value.current.bundle = { releaseId: "current", version: "2026.11.09.01", webVersion: "web", clientVersion: "client" };
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1109" }]);
});

test("准备完成只在用户重启时调用固定能力，稍后保持当前资源并允许失败后重试", async t => {
  const f = fixture(t); await ready(f);
  f.panel.details.value = { deviceId, current: { shellVersion: "1.0.0", bundle: null, clientVersion: "1" },
    bundle: { requestId: "prepare:1", target: { releaseId: "next", version: "2026.11.09.01", webVersion: "1", clientVersion: "1" }, phase: "prepare", result: "prepared", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "unknown", failure: null } };
  assert.equal(f.restarts.length, 0);
  assert.equal(f.panel.restartDisabled.value, false);
  f.panel.deferUpdate();
  assert.equal(f.panel.deferred.value, true);
  assert.equal(f.restarts.length, 0);
  const first = f.panel.restart(), duplicate = f.panel.restart();
  assert.equal(f.restarts.length, 1);
  f.restarts[0].reject(new Error("restart failed"));
  await Promise.all([first, duplicate]);
  assert.ok(f.panel.actionError.value);
  assert.equal(f.panel.restartDisabled.value, false);
  const retry = f.panel.restart(); f.restarts[1].resolve(undefined); await retry;
  assert.equal(f.panel.actionError.value, null);
  assert.equal(f.panel.details.value.bundle.result, "prepared");
  delete (f.bridge as Partial<typeof f.bridge>).restartForUpdate;
  f.panel.capabilities.value = desktop.getDesktopUpdateCapabilities();
  assert.equal(f.panel.restartDisabled.value, true);
  assert.match(f.panel.capabilityNotice.value, /重启更新/u);
});

test("仅壳准备完成也提供重启入口，组合目标壳和实际资源版本", async t => {
  const f = fixture(t); await ready(f);
  f.panel.details.value = { deviceId,
    current: { shellVersion: "1.0.0", bundle: { releaseId: "current", version: "2026.11.08.01", webVersion: "1", clientVersion: "1" }, clientVersion: "1" },
    bundle: { requestId: null, target: null, phase: null, result: "same", failure: null },
    shell: { requestId: "shell:prepared", target: { shellId: "shell-next", version: "2.0.0" }, phase: "download", result: "prepared", failure: null } };
  assert.equal(f.panel.preparedTargetText.value, "版本 2.0.1108");
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
  assert.equal(f.panel.restartDisabled.value, false);
  const restart = f.panel.restart();
  assert.equal(f.restarts.length, 1);
  f.restarts[0].resolve(undefined); await restart;
});

test("桌面设置归一化只保留模型配置，浏览器仍允许工作区", () => {
  const source = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("useAppShell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pieces: string[] = [];
  /** 抽取真实 owner 的常量与方法执行，不复制归一化分支。 */
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ["AVAILABLE_SETTINGS_TABS", "defaultSettingsTab"].includes(node.name.getText(ast))) pieces.push(`const ${node.getText(ast)};`);
    if (ts.isFunctionDeclaration(node) && ["defaultSettingsTab", "normalizeSettingsTab"].includes(node.name?.text ?? "")) pieces.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(pieces.length, 3);
  const compiled = ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const desktopNormalize = new Function("config", `${compiled}; return normalizeSettingsTab;`)({ isDesktop: true, connected: false, hasActiveSession: false, workspaceId: null }) as (tab?: string) => string;
  const webNormalize = new Function("config", `${compiled}; return normalizeSettingsTab;`)({ isDesktop: false, connected: true, hasActiveSession: true }) as (tab?: string) => string;
  assert.equal(desktopNormalize(" app-update "), "engine-keys");
  assert.equal(desktopNormalize("workspaces"), "engine-keys");
  assert.equal(desktopNormalize("engine-keys"), "engine-keys");
  assert.equal(desktopNormalize("software-update"), "engine-keys");
  assert.equal(desktopNormalize("scheduled-tasks"), "engine-keys");
  assert.equal(desktopNormalize("codeflowai-config"), "engine-keys");
  assert.equal(webNormalize("app-update"), "workspaces");
  assert.equal(webNormalize("engine-keys"), "engine-keys");
  assert.equal(webNormalize("unknown"), "workspaces");
});
