import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";
import * as shared from "@codeflowai/shared";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

/** 执行真实 SFC setup，替换宿主与生命周期，验证提醒动作传参。 */
function setupComponent(t: test.TestContext, imports: Record<string, unknown>) {
  const file = new URL("../src/features/settings/components/desktop-update-notice-modal.vue", import.meta.url);
  const script = compileScript(parse(readFileSync(file, "utf8")).descriptor, { id: "update-notice-ui" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const unmount: Array<() => void> = [];
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onMounted() {}, onBeforeUnmount: (callback: () => void) => unmount.push(callback) };
    if (id === "@codeflowai/shared") return shared;
    if (id in imports) return imports[id];
    throw new Error(`unexpected component import: ${id}`);
  }, module, module.exports);
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  t.after(() => { unmount.forEach(callback => callback()); scope.stop(); });
  return bindings;
}

function fixture(t: test.TestContext) {
  const active = vue.ref<shared.DesktopUpdateNotice | null>(null);
  const dismissals: string[] = [];
  const toastErrors: unknown[] = [];
  let downloadPages = 0;
  const bindings = setupComponent(t, {
    "ant-design-vue": { message: { error: (value: unknown) => toastErrors.push(value) } },
    "../../../services/desktop": {
      DesktopUpdateServiceError: class DesktopUpdateServiceError extends Error {
        constructor(readonly code: string) { super(code); }
      },
      getDesktopUpdateCapabilities: () => ({ state: true, check: true, diagnostics: true, details: true, restart: true, notice: true }),
      getDesktopUpdateNotice: async () => null,
      dismissDesktopUpdateNotice: async (action: string) => { dismissals.push(action); },
      subscribeDesktopUpdateNotice: () => () => {},
      reportDesktopUpdateError: async () => {},
      restartDesktopForUpdate: async () => {},
    },
    "../../desktop/desktopDownloadEntry": { openDesktopDownloadPage: () => { downloadPages += 1; } },
    "../desktopUpdateNoticeState": {
      activeDesktopUpdateNotice: active,
      showDesktopUpdateNotice: (notice: shared.DesktopUpdateNotice) => { active.value = notice; },
      hideDesktopUpdateNotice: () => { active.value = null; },
    },
  });
  return { bindings, active, dismissals, toastErrors, downloadPages: () => downloadPages };
}

const notice: shared.DesktopUpdateNotice = { releaseId: "release-1", version: "2026.11.13.05", currentVersion: "2026.11.13.04", shellOnly: false };

test("提醒展示后稍后关闭按 24 小时节流提交", async t => {
  const f = fixture(t);
  f.bindings.applyNotice(notice);
  assert.equal(f.bindings.open.value, true);
  await f.bindings.close("later");
  assert.deepEqual(f.dismissals, ["later"]);
  assert.equal(f.bindings.open.value, false);
});

test("外部隐藏提醒后新版本到来仍重置本次不再提醒", async t => {
  const f = fixture(t);
  f.bindings.applyNotice(notice);
  f.bindings.suppressSession.value = true;
  f.active.value = null;
  f.bindings.applyNotice({ ...notice, releaseId: "release-2", version: "2026.11.13.06" });
  assert.equal(f.bindings.suppressSession.value, false);
});

test("勾选本次不再提醒后关闭提交 session 动作", async t => {
  const f = fixture(t);
  f.bindings.applyNotice(notice);
  f.bindings.suppressSession.value = true;
  await f.bindings.close("later");
  assert.deepEqual(f.dismissals, ["session"]);
});

test("壳更新直接打开安装包下载页并记录已提醒", async t => {
  const f = fixture(t);
  f.bindings.applyNotice({ ...notice, shellOnly: true });
  f.bindings.downloadInstaller();
  await Promise.resolve();
  assert.equal(f.downloadPages(), 1);
  assert.deepEqual(f.dismissals, ["later"]);
});

test("壳更新勾选本次不再提醒后下载安装包仍提交 session", async t => {
  const f = fixture(t);
  f.bindings.applyNotice({ ...notice, shellOnly: true });
  f.bindings.suppressSession.value = true;
  f.bindings.downloadInstaller();
  await Promise.resolve();
  assert.equal(f.downloadPages(), 1);
  assert.deepEqual(f.dismissals, ["session"]);
});

test("关闭动作失败显式提示且不重新打开提醒", async t => {
  const active = vue.ref<shared.DesktopUpdateNotice | null>(null);
  const toastErrors: unknown[] = [];
  const bindings = setupComponent(t, {
    "ant-design-vue": { message: { error: (value: unknown) => toastErrors.push(value) } },
    "../../../services/desktop": {
      DesktopUpdateServiceError: class DesktopUpdateServiceError extends Error {
        constructor(readonly code: string) { super(code); }
      },
      getDesktopUpdateCapabilities: () => ({ state: true, check: true, diagnostics: true, details: true, restart: true, notice: true }),
      getDesktopUpdateNotice: async () => null,
      dismissDesktopUpdateNotice: async () => { throw new Error("dismiss failed"); },
      subscribeDesktopUpdateNotice: () => () => {},
      reportDesktopUpdateError: async () => {},
      restartDesktopForUpdate: async () => {},
    },
    "../../desktop/desktopDownloadEntry": { openDesktopDownloadPage: () => {} },
    "../desktopUpdateNoticeState": {
      activeDesktopUpdateNotice: active,
      showDesktopUpdateNotice: (value: shared.DesktopUpdateNotice) => { active.value = value; },
      hideDesktopUpdateNotice: () => { active.value = null; },
    },
  });
  bindings.applyNotice(notice);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  await bindings.close("later");
  assert.equal(bindings.open.value, false);
  assert.equal(toastErrors.length, 1);
  assert.equal((logs[0]?.[1] as { releaseId?: string } | undefined)?.releaseId, "release-1");
});
