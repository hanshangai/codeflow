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
function setupComponent(t: test.TestContext, file: string, imports: Record<string, unknown>, props: object = {}) {
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
  const bindings = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  t.after(() => { unmount.forEach(callback => callback()); scope.stop(); });
  return bindings;
}

/** 完整宿主事实区分当前资源与未激活目标，检查调用不会自行变更版本。 */
function modalFixture(t: test.TestContext, canRestart = true, platform: "win32" | "darwin" = "win32") {
  const state: DesktopUpdateState = { deviceId, operation: "idle", checking: false, transportConfigured: true, automaticUpdates: true,
    updatesSuppressed: false, stoppingUpdates: false, shellOwned: false, updateCheckFailure: null, shellUpdateFailure: null,
    updateReceiptFailure: null, updateFailureFailure: null };
  const details: DesktopUpdateDetails = { deviceId,
    current: { shellVersion: "1.0.0", bundle: { releaseId: "current", version: "2026.11.08.01", webVersion: "current", clientVersion: "current" }, clientVersion: "current" },
    bundle: { requestId: "prepare:1", target: { releaseId: "next", version: "2026.11.09.02", webVersion: "next", clientVersion: "next" }, phase: "prepare", result: "prepared", failure: null },
    shell: { requestId: null, target: null, phase: null, result: "same", failure: null } };
  let checks = 0;
  const bridge = { platform, getState: async () => ({}), request: async () => { throw new Error("unexpected request"); },
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

/** 设置页复用同一宿主快照，停用自动读取以单独验证首屏结论。 */
function settingsFixture(t: test.TestContext, platform: "win32" | "darwin" = "win32") {
  const f = modalFixture(t, true, platform);
  const props = vue.reactive({ active: false });
  const panel = setupComponent(t, "../src/features/settings/components/desktop-update-panel.vue", {
    "../../../services/desktop": desktop, "../desktopUpdateLabels": labels,
    "@ant-design/icons-vue": { ExportOutlined: {} },
    "../../../utils/upgradeNotes": { openUpgradeNotes() {} },
  }, props);
  panel.state.value = structuredClone(f.state);
  panel.details.value = structuredClone(f.details);
  return { ...panel, props, hostState: f.state, hostDetails: f.details, bridge: f.bridge };
}

for (const bundle of ["none", "same"] as const) for (const shell of ["none", "same"] as const)
test(`检查完成无更新时忽略历史目标，弹框和设置页一致：${bundle}/${shell}`, async t => {
  const f = modalFixture(t);
  f.details.bundle.result = bundle;
  f.details.shell.result = shell;
  f.details.shell.target = { shellId: "historical-shell", version: "1.0.0" };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.title, "当前已是最新版本");
  assert.equal(f.panel.presentation.value.detail, "当前版本 1.0.1108");
  assert.deepEqual(f.panel.targetRows.value, []);
  assert.equal(f.panel.primaryAction.value.kind, "close");
  assert.equal(f.panel.restartDisabled.value, true);
  const settings = settingsFixture(t);
  settings.details.value = structuredClone(f.details);
  assert.equal(settings.statusSummary.value, "当前已是最新版本。");
});

test("检查已返回但目标未取得准备结果时明确失败，不暗示仍在下载", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "unknown";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "error");
  assert.equal(f.panel.outcome.value.title, "检查更新失败");
  assert.match(f.panel.outcome.value.detail, /结果不完整/u);
  assert.deepEqual(f.panel.targetRows.value, []);
  assert.equal(f.panel.primaryAction.value.label, "重试");
});

for (const result of ["cancelled", "postponed", "revoked", "restored"] as const)
test(`更新结束原因明确展示且不把旧目标当作可安装更新：${result}`, async t => {
  const f = modalFixture(t);
  f.details.bundle.result = result;
  await f.panel.startCheck();
  const reason = { cancelled: /取消/u, postponed: /暂缓/u, revoked: /撤回/u, restored: /恢复原版本/u }[result];
  assert.match(f.panel.outcome.value.detail, reason);
  assert.notEqual(f.panel.outcome.value.title, "当前已是最新版本");
  assert.deepEqual(f.panel.targetRows.value, []);
  assert.equal(f.panel.restartDisabled.value, true);
});

test("宿主检查仍在进行时显示真实阶段，不能因当前调用已返回而显示结果不完整", async t => {
  const f = modalFixture(t);
  f.state.checking = true;
  f.state.operation = "downloading";
  f.details.bundle.result = "unknown";
  f.details.bundle.phase = "download";
  await f.panel.startCheck();
  assert.equal(f.panel.presentation.value.title, "正在下载更新");
  assert.equal(f.panel.primaryAction.value.kind, "close");
  assert.equal(f.panel.restartDisabled.value, true);
  const settings = settingsFixture(t);
  settings.state.value = structuredClone(f.state);
  settings.details.value = structuredClone(f.details);
  assert.match(settings.statusSummary.value, /正在下载更新/u);
  assert.equal(settings.restartDisabled.value, true);
  f.state.checking = false;
  f.state.operation = "idle";
  f.details.bundle.result = "prepared";
  await f.panel.poll(1);
  assert.equal(f.panel.presentation.value.title, "新版本已下载，重启后生效");
  assert.equal(f.panel.restartDisabled.value, false);
});

for (const phase of ["discovery", "download", "verify"] as const)
test(`失败按实际阶段显示原因且设置页不报告成功：${phase}`, async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "failure";
  f.details.bundle.phase = phase;
  await f.panel.startCheck();
  const titles = { discovery: "检查更新失败", download: "下载更新失败", verify: "更新校验失败" };
  assert.equal(f.panel.outcome.value.title, titles[phase]);
  assert.equal(f.panel.primaryAction.value.label, "重试");
  const settings = settingsFixture(t);
  settings.details.value = structuredClone(f.details);
  assert.ok(settings.statusSummary.value.startsWith(titles[phase]));
});

test("同轮慢轮询迟到不能覆盖检查结束后读到的已下载结果", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "unknown";
  f.details.bundle.phase = "download";
  f.state.checking = true;
  let entered!: () => void, finish!: () => void, finishPoll!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const check = new Promise<void>(resolve => { finish = resolve; });
  const gate = new Promise<void>(resolve => { finishPoll = resolve; });
  f.bridge.checkForUpdates = async () => { entered(); await check; };
  const work = f.panel.startCheck();
  await started;
  const oldState = structuredClone(f.state), oldDetails = structuredClone(f.details);
  let stateReads = 0, detailReads = 0;
  f.bridge.getUpdateState = async () => { if (++stateReads === 1) { await gate; return oldState; } return structuredClone(f.state); };
  f.bridge.getUpdateDetails = async () => { if (++detailReads === 1) { await gate; return oldDetails; } return structuredClone(f.details); };
  const poll = f.panel.poll(1);
  try {
    f.state.checking = false;
    f.details.bundle.result = "prepared";
    finish(); await work;
    assert.equal(f.panel.restartDisabled.value, false);
    finishPoll(); await poll;
    assert.equal(f.panel.presentation.value.title, "新版本已下载，重启后生效");
    assert.equal(f.panel.restartDisabled.value, false);
  } finally { finish(); finishPoll(); await Promise.all([work, poll]); }
});

test("后台更新快照读取失败时显示重试，旧在途快照不能掩盖失败操作", async t => {
  const f = modalFixture(t);
  f.state.checking = true;
  await f.panel.startCheck();
  f.bridge.getUpdateState = async () => { throw new Error("SNAPSHOT_FAILED"); };
  await f.panel.poll(1);
  assert.equal(f.panel.presentation.value.tone, "error");
  assert.equal(f.panel.primaryAction.value.kind, "check");
  assert.equal(f.panel.primaryAction.value.label, "重试");
});

test("下载进度在进入校验阶段后隐藏，不能让旧字节进度覆盖真实阶段", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "unknown";
  f.details.bundle.phase = "verify";
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.bridge.checkForUpdates = async () => { entered(); await gate; };
  const work = f.panel.startCheck(); await started;
  try {
    f.panel.updateProgress.value = { received: 100, total: 100 };
    assert.equal(f.panel.downloadPercent.value, null);
    assert.equal(f.panel.presentation.value.title, "正在校验更新");
  } finally { finish(); await work; }
});

test("资源尚未取得阶段时展示壳实际下载阶段", async t => {
  const f = modalFixture(t);
  f.state.checking = true;
  f.details.bundle.result = "unknown";
  f.details.bundle.phase = null;
  f.details.shell.result = "unknown";
  f.details.shell.phase = "download";
  await f.panel.startCheck();
  assert.equal(f.panel.presentation.value.title, "正在下载更新");
});

test("设置页稍后后发生另一通道失败，保留失败原因而非用下次启动提示覆盖", t => {
  const panel = settingsFixture(t);
  panel.deferUpdate();
  panel.state.value.shellUpdateFailure = { requestId: "shell-failed", rootCause: toUpdateDiagnosticCause(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED")) };
  assert.match(panel.statusSummary.value, /网络|连接/u);
});

test("一通道下载时保留另一通道的失败说明，不被普通进度提示覆盖", async t => {
  const f = modalFixture(t);
  f.state.checking = true;
  f.details.bundle.result = "failure";
  f.state.updateCheckFailure = { requestId: "resource-failed", rootCause: toUpdateDiagnosticCause(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED")) };
  f.details.shell.result = "unknown";
  f.details.shell.phase = "download";
  await f.panel.startCheck();
  assert.equal(f.panel.presentation.value.title, "正在下载更新");
  assert.equal(f.panel.presentation.value.tone, "warning");
  assert.match(f.panel.presentation.value.detail, /网络|连接/u);
  assert.match(f.panel.presentation.value.detail, /仍在继续/u);
});

for (const failed of ["bundle", "shell"] as const)
test(`一通道失败另一通道已下载时保留错误和可用重启入口：${failed}`, async t => {
  const f = modalFixture(t);
  const prepared = failed === "bundle" ? "shell" : "bundle";
  f.details[failed].result = "failure";
  f.details[prepared].result = "prepared";
  if (prepared === "shell") f.details.shell.target = { shellId: "prepared-shell", version: "2.0.0" };
  await f.panel.startCheck();
  assert.equal(f.panel.presentation.value.tone, "error");
  assert.equal(f.panel.primaryAction.value.kind, "restart");
  assert.equal(f.panel.restartDisabled.value, false);
  let restarts = 0;
  f.bridge.restartForUpdate = async () => { restarts++; };
  await f.panel.performPrimaryAction();
  assert.equal(restarts, 1);
});

test("设置页后台更新结束后刷新版本同步收敛在途状态并开放重启", async t => {
  const panel = settingsFixture(t);
  panel.hostState.checking = true;
  panel.hostDetails.bundle.result = "unknown";
  panel.props.active = true;
  await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(panel.restartDisabled.value, true);
  panel.hostState.checking = false;
  panel.hostDetails.bundle.result = "prepared";
  await panel.loadDetails();
  assert.equal(panel.state.value.checking, false);
  assert.equal(panel.restartDisabled.value, false);
  assert.match(panel.statusSummary.value, /重启后生效/u);
});

test("托盘弹框展示实际单一版本，prepared可重启，healthy已生效", async t => {
  const f = modalFixture(t);
  await f.panel.startCheck();
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
  assert.equal(f.panel.outcome.value.title, "新版本已下载，重启后生效");
  assert.match(f.panel.outcome.value.detail, /重启后.*检查桌面壳/u);
  assert.equal(f.panel.targetRows.value[0].value, "1.0.1109.2");
  assert.equal(f.panel.restartDisabled.value, false);
  f.details.bundle.result = "healthy";
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.title, /已生效/u);
  assert.equal(f.panel.restartDisabled.value, true);
});

for (const target of ["bundle", "shell", "both"] as const) test(`更新弹框${target}目标显示统一对外新版本`, async t => {
  const f = modalFixture(t);
  f.state.checking = target !== "shell";
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

test("更新检测尚无任何目标时不展示新版本占位", async t => {
  const f = modalFixture(t);
  f.state.checking = true;
  f.details.bundle.target = null;
  f.details.bundle.result = "unknown";
  f.details.shell.target = null;
  f.details.shell.result = "unknown";
  await f.panel.startCheck();
  assert.deepEqual(f.panel.targetRows.value, []);
  assert.deepEqual(f.panel.versionRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
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

test("应用资源和桌面壳均已检查才显示最新结论", async t => {
  const f = modalFixture(t);
  f.details.bundle = { requestId: null, target: null, phase: null, result: "none", failure: null };
  f.details.shell = { requestId: null, target: null, phase: null, result: "same", failure: null };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "success");
  assert.equal(f.panel.outcome.value.title, "当前已是最新版本");
  assert.equal(f.panel.outcome.value.detail, "无需下载或安装更新");
  f.details.shell = { requestId: null, target: null, phase: null, result: "unknown", failure: null };
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "error");
  assert.match(f.panel.outcome.value.detail, /桌面壳尚未检查/u);
  assert.match(f.panel.outcome.value.detail, /结果不完整/u);
  assert.equal(f.panel.primaryAction.value.kind, "check");
  assert.doesNotMatch(f.panel.outcome.value.title, /最新版本/u);
});

test("资源已生效但桌面壳未检查时不能显示整个更新已完成", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "healthy";
  f.details.shell.result = "unknown";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "error");
  assert.match(f.panel.outcome.value.detail, /应用内容已更新.*桌面壳尚未检查/u);
  assert.match(f.panel.outcome.value.detail, /结果不完整/u);
  assert.equal(f.panel.primaryAction.value.kind, "check");
});

test("资源已生效但桌面壳失败时保留部分成功与失败结论", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "healthy";
  f.details.shell.result = "failure";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "error");
  assert.match(f.panel.outcome.value.detail, /应用内容已更新.*桌面壳更新未完成/u);
  assert.equal(f.panel.primaryAction.value.label, "重试");
  f.state.shellUpdateFailure = { requestId: "shell:failed", rootCause: toUpdateDiagnosticCause(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED")) };
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.detail, /应用内容已更新.*网络|应用内容已更新.*连接/u);
});

test("资源与桌面壳都已完成才显示更新已生效", async t => {
  const f = modalFixture(t);
  f.details.bundle.result = "healthy";
  f.details.shell.result = "healthy";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "success");
  assert.equal(f.panel.outcome.value.title, "更新已生效");
  f.details.bundle.result = "unknown";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "error");
  assert.doesNotMatch(f.panel.outcome.value.title, /已生效/u);
});

test("macOS 资源准备及生效保留桌面壳人工安装提示", async t => {
  const f = modalFixture(t, true, "darwin");
  f.details.shell.result = "manual_required";
  await f.panel.startCheck();
  assert.equal(f.panel.primaryAction.value.kind, "restart");
  assert.doesNotMatch(f.panel.outcome.value.detail, /检查桌面壳/u);
  f.details.bundle.result = "healthy";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.tone, "info");
  assert.match(f.panel.outcome.value.detail, /应用内容已更新.*完整安装包/u);
  f.details.bundle.result = "same";
  await f.panel.startCheck();
  assert.equal(f.panel.outcome.value.title, "需要手动安装更新");
});

for (const result of ["unknown", "failure"] as const) test(`设置页资源已生效但桌面壳${result}时明确后续待处理`, t => {
  const panel = settingsFixture(t);
  panel.details.value.bundle.result = "healthy";
  panel.details.value.shell.result = result;
  assert.match(panel.statusSummary.value, result === "unknown" ? /应用内容已更新.*桌面壳尚未检查/u : /应用内容已更新.*桌面壳更新未完成/u);
  assert.doesNotMatch(panel.statusSummary.value, /更新已生效/u);
});

test("设置页壳故障快照不能被成功详情遮住", t => {
  const panel = settingsFixture(t);
  panel.details.value.bundle.result = "healthy";
  panel.state.value.shellUpdateFailure = { requestId: "shell:failed", rootCause: toUpdateDiagnosticCause(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED")) };
  assert.match(panel.statusSummary.value, /应用内容已更新.*桌面壳更新未完成/u);
});

test("设置页准备资源后说明重启还会继续检查桌面壳", t => {
  const panel = settingsFixture(t);
  assert.match(panel.statusSummary.value, /重启.*检查桌面壳/u);
});

test("设置页仅壳已生效不能代替资源完成事实", t => {
  const panel = settingsFixture(t);
  panel.details.value.bundle.result = "unknown";
  panel.details.value.shell.result = "healthy";
  assert.doesNotMatch(panel.statusSummary.value, /更新已生效/u);
  panel.details.value.bundle.result = "healthy";
  assert.match(panel.statusSummary.value, /更新已生效/u);
});

test("设置页 macOS 资源已生效仍提示人工安装桌面壳", t => {
  const panel = settingsFixture(t, "darwin");
  panel.details.value.bundle.result = "healthy";
  panel.details.value.shell.result = "manual_required";
  assert.match(panel.statusSummary.value, /应用内容已更新.*macOS.*手动/u);
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
  assert.equal(f.panel.outcome.value.title, "新版本已下载，重启后生效");
  assert.equal(f.panel.targetRows.value[0].value, "2.0.1108");
  assert.equal(f.panel.restartDisabled.value, false);
  assert.deepEqual(f.panel.currentRows.value, [{ label: "当前版本", value: "1.0.1108" }]);
});

test("资源和壳都准备完成时提示一次重启即可完成两项更新", async t => {
  const f = modalFixture(t);
  f.details.bundle = { requestId: "bundle:prepared", target: { releaseId: "bundle-next", version: "2026.11.25.01",
    webVersion: "2026.11.25.01", clientVersion: "2026.11.25.01" }, phase: "prepare", result: "prepared", failure: null };
  f.details.shell = { requestId: "shell:prepared", target: { shellId: "shell-next", version: "1.2" }, phase: "download", result: "prepared", failure: null };
  await f.panel.startCheck();
  assert.match(f.panel.outcome.value.detail, /资源和桌面壳.*一次重启/u);
  assert.equal(f.panel.primaryAction.value.label, "重启并更新");
  assert.equal(f.panel.restartDisabled.value, false);
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

test("重启等待过久允许关闭提示但不重复派发，迟到结果仍由原请求收口", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = modalFixture(t);
  let calls = 0, resolve!: () => void;
  f.bridge.restartForUpdate = () => { calls++; return new Promise<void>(done => { resolve = done; }); };
  await f.panel.startCheck();
  const pending = f.panel.restart();
  t.mock.timers.tick(60_000);
  assert.equal(f.panel.presentation.value.title, "重启更新尚未完成");
  assert.equal(f.panel.restartDelayed.value, true);
  assert.equal(f.panel.canClose.value, true);
  f.panel.close();
  await f.panel.restart();
  await f.panel.startCheck();
  assert.equal(calls, 1);
  assert.equal(f.checks(), 1);
  resolve();
  await pending;
  assert.equal(f.panel.restartDelayed.value, false);
  assert.equal(f.panel.restarting.value, false);
});

test("重启失败后重新读取宿主事实，禁止按旧 prepared 再次更新", async t => {
  const f = modalFixture(t);
  await f.panel.startCheck();
  f.bridge.restartForUpdate = async () => {
    f.state.shellOwned = true;
    f.state.operation = "exiting";
    throw new Error("RESTART_FAILED");
  };
  await f.panel.restart();
  assert.equal(f.panel.state.value.shellOwned, true);
  assert.equal(f.panel.restartDisabled.value, true);
  assert.equal(f.panel.restarting.value, false);
  assert.ok(f.panel.error.value);
});

test("上次重启计时器不能提前改变下一次重启提示", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = modalFixture(t);
  await f.panel.startCheck();
  await f.panel.restart();
  t.mock.timers.tick(30_000);
  let resolve!: () => void;
  f.bridge.restartForUpdate = () => new Promise<void>(done => { resolve = done; });
  const pending = f.panel.restart();
  t.mock.timers.tick(30_000);
  assert.equal(f.panel.restartDelayed.value, false);
  assert.equal(f.panel.canClose.value, false);
  t.mock.timers.tick(30_000);
  assert.equal(f.panel.canClose.value, true);
  resolve();
  await pending;
});

test("重启失败后快照也失败时保留错误并阻止再次重启", async t => {
  const f = modalFixture(t);
  await f.panel.startCheck();
  f.bridge.restartForUpdate = async () => { throw new Error("RESTART_FAILED"); };
  f.bridge.getUpdateState = async () => { throw new Error("SNAPSHOT_FAILED"); };
  await f.panel.restart();
  assert.ok(f.panel.error.value);
  assert.ok(f.panel.snapshotError.value);
  assert.equal(f.panel.restartDisabled.value, true);
  assert.equal(f.panel.canClose.value, true);
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
