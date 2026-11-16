import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";
import * as desktop from "../src/services/desktop.ts";
import * as desktopUpdateLabels from "../src/features/settings/desktopUpdateLabels.ts";
import * as upgradeNotes from "../src/utils/upgradeNotes.ts";
import type { DesktopUpdateDetails, DesktopUpdateState } from "@codeflowai/shared";
import * as shared from "@codeflowai/shared";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const panelPath = new URL("../src/features/settings/components/desktop-update-panel.vue", import.meta.url);
const deviceId = "12345678-1234-4234-8234-123456789abc";
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** 固定旧快照不包含任何成功推断。 */
function state(): DesktopUpdateState {
  return { deviceId, operation: "idle", checking: false, transportConfigured: true, automaticUpdates: false, updatesSuppressed: true,
    stoppingUpdates: false, shellOwned: false, updateCheckFailure: null, shellUpdateFailure: null, updateReceiptFailure: null, updateFailureFailure: null };
}

/** 各通道的未知版本和结果必须原样保留。 */
function details(): DesktopUpdateDetails {
  return { deviceId, current: { shellVersion: "1", bundle: null, clientVersion: "1" },
    bundle: { requestId: null, target: null, phase: null, result: "unknown", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "unknown", failure: null } };
}

/** 仅排空有限渲染与Promise续体，不使用业务轮询。 */
async function settle() { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick(); }

/** 执行真实SFC和service，只替换preload及生命周期边界。 */
function fixture(t: test.TestContext, supported = true) {
  const script = compileScript(parse(readFileSync(panelPath, "utf8")).descriptor, { id: "update-details-test" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const states: Pending[] = [], reads: Pending[] = [], checks: Pending[] = [], unmount: Array<() => void> = [];
  /** 延迟结算真实固定桥请求，观察重复动作与迟到响应。 */
  const pending = (items: Pending[]) => (...args: unknown[]) => {
    assert.deepEqual(args, []);
    return new Promise((resolve, reject) => items.push({ resolve, reject }));
  };
  const bridge = { getState: async () => ({}), request: async () => { throw new Error("unexpected request"); },
    getUpdateState: pending(states), checkForUpdates: pending(checks), ...(supported ? { getUpdateDetails: pending(reads) } : {}) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
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
  const props = vue.reactive({ active: false }), scope = vue.effectScope();
  const panel = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!;
  t.after(async () => {
    unmount.forEach(callback => callback()); scope.stop();
    states.forEach(item => item.resolve(state())); reads.forEach(item => item.resolve(details())); checks.forEach(item => item.resolve(undefined));
    await settle();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  return { panel, props, states, reads, checks, unmount };
}

/** 激活后分别交付两种真实service快照。 */
async function ready(f: ReturnType<typeof fixture>) {
  f.props.active = true; await settle(); f.states[0].resolve(state()); f.reads[0]?.resolve(details()); await settle();
}

test("详情只在激活读取，未知Web版本和两个通道结果不被空闲快照替代", async t => {
  const f = fixture(t); await settle(); assert.equal(f.reads.length, 0);
  await ready(f); assert.equal(f.reads.length, 1); assert.deepEqual(f.panel.details.value, details());
  assert.equal(f.panel.details.value.current.bundle, null); assert.equal(f.checks.length, 0);
});

test("旧壳保留原状态检查能力，并明确没有详情能力", async t => {
  const f = fixture(t, false); await ready(f);
  assert.equal(f.panel.capabilities.value.details, false); assert.deepEqual(f.panel.state.value, state());
  assert.equal(f.panel.details.value, null); assert.equal(f.reads.length, 0);
});

test("详情刷新重复点击只读一次，拒绝时保留快照且显示失败", async t => {
  const f = fixture(t); await ready(f);
  const run = f.panel.loadDetails(), duplicate = f.panel.loadDetails();
  assert.equal(f.reads.length, 2); f.reads[1].reject(false); await Promise.all([run, duplicate]);
  assert.deepEqual(f.panel.details.value, details()); assert.ok(f.panel.detailsError.value); assert.equal(f.panel.detailsLoading.value, false);
  assert.equal(f.checks.length, 0);
});

test("重新激活后的详情不被旧响应覆盖，卸载后拒绝不发布", async t => {
  const f = fixture(t); f.props.active = true; await settle();
  f.props.active = false; await settle(); f.props.active = true; await settle();
  const newest = details(); newest.shell.result = "none";
  f.reads[1].resolve(newest); await settle(); f.reads[0].resolve(details()); await settle();
  assert.equal(f.panel.details.value.shell.result, "none");
  const late = f.panel.loadDetails(); f.unmount.forEach(callback => callback()); f.reads[2].reject(null); await late;
  assert.equal(f.panel.detailsError.value, null);
});

test("检查成功后先读原状态，再读详情，void不能合成成功结果", async t => {
  const f = fixture(t); await ready(f); const run = f.panel.retry();
  f.checks[0].resolve(undefined); await settle(); assert.equal(f.reads.length, 1);
  f.states[1].resolve(state()); await settle(); assert.equal(f.reads.length, 2);
  const observed = details(); observed.bundle.result = "same"; observed.shell.result = "postponed";
  f.reads[1].resolve(observed); await run; assert.deepEqual(f.panel.details.value, observed);
});

test("检查或状态刷新失败会停止派生详情读取", async t => {
  const f = fixture(t); await ready(f); const failed = f.panel.retry(); f.checks[0].reject(0); await failed;
  assert.equal(f.reads.length, 1); assert.ok(f.panel.actionError.value);
  const run = f.panel.retry(); f.checks[1].resolve(undefined); await settle(); f.states[1].reject(null); await run;
  assert.equal(f.reads.length, 1); assert.ok(f.panel.stateError.value);
});

test("检查结算后的新详情覆盖在途旧读取，旧结果不能覆盖新轮次", async t => {
  const f = fixture(t); await ready(f); const old = f.panel.loadDetails();
  const run = f.panel.retry(); f.checks[0].resolve(undefined); await settle(); f.states[1].resolve(state()); await settle();
  assert.equal(f.reads.length, 3);
  const latest = details(); latest.bundle.result = "healthy"; f.reads[2].resolve(latest); await run;
  f.reads[1].resolve(details()); await old; assert.equal(f.panel.details.value.bundle.result, "healthy");
});
