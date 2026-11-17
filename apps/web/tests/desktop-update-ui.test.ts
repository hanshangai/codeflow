import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";
import * as shared from "@codeflowai/shared";
import type { DesktopUpdateDetails, DesktopUpdateState } from "@codeflowai/shared";
import { toUpdateDiagnosticCause } from "@codeflowai/shared/desktop-update-failure";
import * as desktop from "../src/services/desktop.ts";
import * as labels from "../src/features/settings/desktopUpdateLabels.ts";
import * as fileMeta from "../src/utils/fileMetaPresentation.ts";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const deviceId = "12345678-1234-4234-8234-123456789abc";

/** 执行真实 SFC setup，替换宿主、生命周期和计时器以验证可见状态与操作。 */
function setupComponent(t: test.TestContext, file: string, imports: Record<string, unknown>) {
  const script = compileScript(parse(readFileSync(new URL(file, import.meta.url), "utf8")).descriptor, { id: "update-ui" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const unmount: Array<() => void> = [];
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", "setInterval", "clearInterval", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onMounted() {}, onUnmounted: (callback: () => void) => unmount.push(callback), onBeforeUnmount: (callback: () => void) => unmount.push(callback) };
    if (id === "vue-router") return { useRouter: () => ({ push: () => undefined }) };
    if (id === "@codeflowai/shared") return shared;
    if (id in imports) return imports[id];
    throw new Error(`unexpected component import: ${id}`);
  }, module, module.exports, () => 1, () => {});
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  t.after(() => { unmount.forEach(callback => callback()); scope.stop(); });
  return bindings;
}

/** 完整宿主事实区分当前资源与未激活目标，检查调用不会自行变更版本。 */
function modalFixture(t: test.TestContext, canRestart = true) {
  const state: DesktopUpdateState = { deviceId, operation: "idle", checking: false, transportConfigured: true, automaticUpdates: true,
    updatesSuppressed: false, stoppingUpdates: false, shellOwned: false, updateCheckFailure: null, shellUpdateFailure: null,
    updateReceiptFailure: null, updateFailureFailure: null };
  const details: DesktopUpdateDetails = { deviceId,
    current: { shellVersion: "1.0.0", bundle: { releaseId: "current", version: "2026.11.08.01", webVersion: "current", clientVersion: "current" }, clientVersion: "current" },
    bundle: { requestId: "prepare:1", target: { releaseId: "next", version: "2026.11.09.02", webVersion: "next", clientVersion: "next" }, phase: "prepare", result: "prepared", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "same", failure: null } };
  let checks = 0;
  const bridge = { getState: async () => ({}), request: async () => { throw new Error("unexpected request"); },
    getUpdateState: async () => structuredClone(state), getUpdateDetails: async () => structuredClone(details), checkForUpdates: async () => { checks++; },
    ...(canRestart ? { restartForUpdate: async () => {} } : {}) };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(console, "error", () => {});
  const panel = setupComponent(t, "../src/features/settings/components/desktop-update-check-modal.vue", {
    "../../../services/desktop": desktop, "../desktopUpdateLabels": labels,
    "../desktopUpdateCheckRequest": { desktopUpdateCheckRequestTick: vue.ref(0) },
    "../desktopUpdateNoticeState": { suppressDesktopUpdateNotice: () => {}, activeDesktopUpdateNotice: { value: null },
      hideDesktopUpdateNotice: () => {}, dismissDesktopUpdateNoticeLater: () => {} },
    "@ant-design/icons-vue": { ArrowRightOutlined: {}, CheckCircleFilled: {}, CloseCircleFilled: {}, DownloadOutlined: {}, ExportOutlined: {}, InfoCircleOutlined: {} },
    "../../../utils/upgradeNotes": { openUpgradeNotes() {} },
    "../../../utils/fileMetaPresentation": fileMeta,
  });
  return { panel, bridge, state, details, checks: () => checks };
}

test("托盘弹框展示实际单一版本，prepared可重启，healthy已生效", async t => {
  const f = modalFixture(t);
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
  assert.equal(f.panel.outcome.value.title, "重启即可完成更新");
  assert.equal(f.panel.targetRows.value[0].value, "1.0.1109.2");
  assert.equal(f.panel.restartDisabled.value, false);
  f.details.bundle.result = "healthy";
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.title, /已生效/u);
  assert.equal(f.panel.restartDisabled.value, true);
});

for (const target of ["bundle", "shell", "both"] as const) test(`更新弹框${target}目标显示统一对外新版本`, async t => {
  const f = modalFixture(t);
  f.details.current.bundle!.version = "2026.11.17.01";
  if (target !== "shell") {
    f.details.bundle.target!.version = "2026.11.17.02";
    f.details.bundle.result = "unknown";
    f.details.bundle.phase = "download";
  } else {
    f.details.bundle.result = "same";
  }
  if (target !== "bundle") {
    f.details.shell.target = { shellId: "next-shell", version: "2.1.0" };
    f.details.shell.result = "prepared";
  }
  await f.panel.startCheck();
  const expected = target === "bundle" ? "1.0.1117.2" : target === "shell" ? "2.1.1117" : "2.1.1117.2";
  assert.deepEqual(f.panel.versionRows.value, [
    { label: "当前版本", value: "1.0.1117" }, { label: "新版本", value: expected },
  ]);
});

test("更新弹框不把失败或已生效的历史目标显示为新版本", async t => {
  const f = modalFixture(t);
  f.details.shell.target = { shellId: "old-target", version: "2.0.0" };
  for (const result of ["same", "failure", "restored", "healthy"] as const) {
    f.details.bundle.result = result;
    f.details.shell.result = result;
    await f.panel.startCheck();
    assert.deepEqual(f.panel.targetRows.value, []);
  }
});

test("升级弹框下载显示真实进度和大小，关闭只隐藏界面，任务由宿主继续", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "unknown";
  f.details.bundle.phase = "download";
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const downloading = new Promise<void>(resolve => { release = resolve; });
  f.bridge.checkForUpdates = async () => { entered(); await downloading; };
  const work = f.panel.startCheck();
  await started;
  try {
    assert.equal(f.panel.presentation.value.title, "正在下载更新");
    assert.equal(f.panel.downloadPercent.value, null);
    f.panel.updateProgress.value = { received: 5 * 1024 * 1024, total: 20 * 1024 * 1024 };
    assert.equal(f.panel.downloadPercent.value, 25);
    assert.equal(f.panel.downloadSize.value, "5.0 MB / 20.0 MB");
    assert.equal(f.panel.primaryAction.value.label, "后台继续");
    await f.panel.performPrimaryAction();
    assert.equal(f.panel.open.value, false);
  } finally { release(); await work; }
});

test("升级弹框准备完成才主推重启，最新版本主操作为完成，失败可重试", async t => {
  const f = modalFixture(t);
  await f.panel.startCheck();
  assert.equal(f.panel.primaryAction.value.kind, "restart");
  assert.equal(f.panel.primaryAction.value.label, "重启并更新");
  f.details.bundle.result = "same";
  await f.panel.startCheck();
  assert.equal(f.panel.primaryAction.value.kind, "close");
  assert.equal(f.panel.primaryAction.value.label, "完成");
  await f.panel.performPrimaryAction();
  assert.equal(f.panel.open.value, false);
  f.bridge.checkForUpdates = async () => { throw new Error("DESKTOP_UPDATE_TRANSPORT_FAILED"); };
  await f.panel.startCheck();
  assert.equal(f.panel.presentation.value.tone, "error");
  assert.equal(f.panel.primaryAction.value.kind, "check");
  assert.equal(f.panel.primaryAction.value.label, "重试");
});

test("升级弹框新一轮检查清除旧下载进度，准备资源后优先展示壳的当前阶段", async t => {
  const f = modalFixture(t);
  f.panel.updateProgress.value = { received: 9, total: 10 };
  f.details.shell = { requestId: "shell-download", target: { shellId: "next", version: "2.0.0" },
    phase: "download", result: "unknown", failure: null };
  let progress: number | null | undefined, title: string | undefined;
  f.bridge.checkForUpdates = async () => {
    progress = f.panel.downloadPercent.value;
    title = f.panel.presentation.value.title;
  };
  await f.panel.startCheck();
  assert.equal(progress, null);
  assert.equal(title, "正在下载更新");
  assert.equal(f.panel.updateProgress.value, null);
});

test("读取初始快照期间即显示检查中，重复点击不重复派发", async t => {
  const f = modalFixture(t);
  let release!: () => void;
  const snapshot = new Promise<void>(resolve => { release = resolve; });
  f.bridge.getUpdateState = async () => { await snapshot; return structuredClone(f.state); };
  const work = f.panel.startCheck();
  try {
    assert.equal(f.panel.checking.value, true);
    assert.equal(f.panel.presentation.value.title, "正在检查更新");
    await f.panel.startCheck();
    assert.equal(f.checks(), 0);
  } finally { release(); await work; }
  assert.equal(f.checks(), 1);
  assert.equal(f.panel.checking.value, false);
});

for (const failed of [false, true]) test(`后台继续后重开，旧检查${failed ? "失败" : "完成"}不覆盖新一轮结果`, async t => {
  const f = modalFixture(t);
  let entered!: () => void, finish!: () => void, fail!: (error: Error) => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const oldCheck = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  f.bridge.checkForUpdates = async () => { if (++calls === 1) { entered(); await oldCheck; } };
  const oldRun = f.panel.startCheck();
  await started;
  await f.panel.performPrimaryAction();
  f.details.bundle.target!.version = "2026.11.17.03";
  await f.panel.startCheck();
  try {
    if (failed) fail(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED"));
    else finish();
    await oldRun;
    assert.equal(f.panel.open.value, true);
    assert.equal(f.panel.checking.value, false);
    assert.equal(f.panel.error.value, "");
    assert.equal(f.panel.targetRows.value[0].value, "1.0.1117.3");
    assert.equal(f.panel.primaryAction.value.kind, "restart");
  } finally { finish(); await oldRun; }
});

test("更新弹窗的桥异常及快照故障都展示原因而非错误码", async t => {
  const f = modalFixture(t);
  f.bridge.checkForUpdates = async () => { throw new Error("Error invoking remote method: Error: DESKTOP_UPDATE_TRANSPORT_FAILED"); };
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.detail, /网络|连接/);
  assert.doesNotMatch(f.panel.outcome.value.detail, /DESKTOP_|remote method/);
  f.bridge.checkForUpdates = async () => {};
  f.state.updateCheckFailure = { requestId: "update:certificate", rootCause: toUpdateDiagnosticCause(
    new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate failure"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    }) })) };
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.detail, /证书/);
  assert.doesNotMatch(f.panel.outcome.value.detail, /DESKTOP_|UNABLE_TO_VERIFY/);
});

test("托盘当前版本缺少资源时不能冒用壳、Client或待更新日期", async t => {
  const f = modalFixture(t);
  f.details.current.bundle = null;
  f.details.current.clientVersion = "2026.10.19.01";
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "资源版本未标记" }]);
  f.details.current.bundle = { releaseId: "current", version: "2026.11.09.01", webVersion: "web", clientVersion: "client" };
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1109" }]);
  f.details.current.bundle.version = "2026.11.09.02";
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1109.2" }]);
  f.details.current.shellVersion = null;
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "桌面壳版本未标记" }]);
});

test("仅发现目标和未知结果不能显示准备完成或最新，旧壳缺能力禁用重启", async t => {
  const f = modalFixture(t, false);
  for (const result of ["unknown", "postponed", "failure"] as const) {
    f.details.bundle.result = result;
    await f.panel.startCheck();
    assert.doesNotMatch(f.panel.outcome.value.title, /已准备|最新版本/u);
  }
  f.details.bundle.result = "prepared";
  await f.panel.startCheck();
  assert.equal(f.panel.restartDisabled.value, true);
});

test("应用资源最新且桌面壳无结果时显示绿色最新结论，不暴露内部状态", async t => {
  const f = modalFixture(t);
  f.details.bundle = { requestId: null, target: null, phase: null, result: "none", failure: null };
  f.details.shell = { requestId: null, target: null, phase: null, result: "same", failure: null };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "success");
  assert.equal(f.panel.outcome.value.title, "当前已是最新版本");
  assert.equal(f.panel.outcome.value.detail, "无需下载或安装更新");
  f.details.shell = { requestId: null, target: null, phase: null, result: "unknown", failure: null };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "success");
  assert.equal(f.panel.outcome.value.title, "当前已是最新版本");
  assert.equal(f.panel.outcome.value.detail, "无需下载或安装更新");
});

test("已安装同包的检查结果显示最新版本并禁用重启更新", async t => {
  const f = modalFixture(t);
  f.details.current.bundle = { releaseId: "desktop-2026.11.12.04", version: "2026.11.12.04", webVersion: "2026.11.12.04", clientVersion: "2026.11.12.04" };
  f.details.bundle = { requestId: "same-package", target: { ...f.details.current.bundle }, phase: "verify", result: "same", failure: null };
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1112.4" }]);
  assert.equal(f.panel.outcome.value.title, "当前已是最新版本");
  assert.equal(f.panel.prepared.value, false);
  assert.equal(f.panel.restartDisabled.value, true);
});

test("托盘只准备壳更新时可重启，并展示将运行的组合版本", async t => {
  const f = modalFixture(t);
  f.details.bundle = { requestId: null, target: null, phase: null, result: "same", failure: null };
  f.details.shell = { requestId: "shell:prepared", target: { shellId: "shell-next", version: "2.0.0" }, phase: "download", result: "prepared", failure: null };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.title, "重启即可完成更新");
  assert.equal(f.panel.targetRows.value[0].value, "2.0.1108");
  assert.equal(f.panel.restartDisabled.value, false);
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
});

test("托盘重启只调用一次，失败保持明确错误并允许后续重试", async t => {
  const f = modalFixture(t);
  let calls = 0, reject!: (cause: unknown) => void;
  f.bridge.restartForUpdate = () => { calls++; return new Promise<void>((_resolve, fail) => { reject = fail; }); };
  await f.panel.startCheck();
  const first = f.panel.restart(), duplicate = f.panel.restart();
  assert.equal(calls, 1);
  reject(new Error("RESTART_FAILED"));
  await Promise.all([first, duplicate]);
  assert.ok(f.panel.error.value);
  assert.equal(f.panel.restartDisabled.value, false);
  f.bridge.restartForUpdate = async () => { calls++; };
  await f.panel.restart();
  assert.equal(calls, 2);
  assert.equal(f.panel.error.value, "");
});

test("状态读取失败显式结束，不能继续发起更新检查", async t => {
  const f = modalFixture(t);
  f.bridge.getUpdateState = async () => { throw new Error("SNAPSHOT_FAILED"); };
  await f.panel.startCheck();
  assert.equal(f.checks(), 0);
  assert.match(f.panel.outcome.value.title, /状态读取失败/u);
});

test("公开更新页忽略服务端草稿，只有已发布版本才构成内容", async t => {
  let payload: unknown = { ok: true, items: [], draft: { hasContent: true, content: "PRIVATE_DRAFT" } };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload), { status: 200 }));
  const page = setupComponent(t, "../src/features/landing/components/upgrade-page.vue", {
    "vue-router": { useRouter: () => ({}) },
    "../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref({ serverWsOrigin: "ws://localhost:39280" }) }) },
    "../../../api/request": { wsOriginToHttpOrigin: () => "http://localhost:39280" },
    "./LandingNav.vue": {}, "./LandingRecords.vue": {}, "../../markdown/MarkdownContent.vue": {},
  });
  await page.loadSummaries();
  assert.equal(page.hasAnyContent.value, false);
  assert.equal(page.isEmpty.value, true);
  payload = { ok: true, items: [{ version: "2026.11.09.01", releasedAt: "2026-11-09", title: "已发布" }], note: { content: "PUBLIC_NOTE" },
    draft: { hasContent: true, content: "PRIVATE_DRAFT" } };
  await page.loadSummaries();
  assert.equal(page.hasAnyContent.value, true);
  assert.deepEqual(page.visibleSummaries.value.map((item: { version: string }) => item.version), ["2026.11.09.01"]);
  assert.deepEqual([...page.loadedDetails.value.values()], ["PUBLIC_NOTE"]);
});
