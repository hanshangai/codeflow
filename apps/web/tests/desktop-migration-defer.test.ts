import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { renderToString } from "vue/server-renderer";
import type { DesktopMigrationState } from "@codeflowai/shared";

const requireTest = createRequire(import.meta.url);
const { compileScript, compileTemplate, parse } = requireTest("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

function loadModule(source: string, load: (id: string) => unknown) {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)(load, module, module.exports);
  return module.exports;
}

for (const scenario of ["allowed", "denied", "old-shell", "bound", "running", "unsafe"] as const) {
  test(`迁移失败页暂缓入口 ${scenario}：真实组件渲染与点击`, async t => {
    const source = fs.readFileSync(new URL("../src/features/desktop/components/desktop-migration-startup.vue", import.meta.url), "utf8");
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: "migration-defer" });
    const template = compileTemplate({ source: descriptor.template!.content, filename: "desktop-migration-startup.vue", id: "migration-defer",
      compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    const snapshot: DesktopMigrationState = { status: scenario === "running" ? "running" : "failed", stage: "discover",
      migrationId: scenario === "bound" ? "migration-1" : null, candidateId: null, workspaceCount: 0, completed: 0, total: null,
      errorCode: scenario === "unsafe" ? "SOURCE_PATH_UNSAFE" : "SOURCE_ACCOUNT_UNRESOLVED", message: "旧账号无法确认",
      account: { status: "not_requested", errorCode: null, message: null },
      ...(scenario === "old-shell" ? {} : { canDefer: scenario === "allowed" }) };
    let mounted!: () => Promise<void>;
    let deferrals = 0;
    let ready = 0;
    const config = vue.reactive({ serverWsOrigin: "ws://test-server.test:39280", isAccountSession: false, hasActiveSession: false });
    const bridge = { getMigrationState: async () => snapshot, deferMigration: async () => { deferrals++; }, onMigrationState: () => () => {} };
    const scope = vue.effectScope();
    t.after(() => scope.stop());
    const page = loadModule(script.content, id => {
      if (id === "vue") return { ...vue, inject: () => vue.ref(false), onMounted: (callback: typeof mounted) => { mounted = callback; }, onBeforeUnmount: () => {} };
      if (id === "ant-design-vue") return Object.fromEntries(["Alert", "Button", "ConfigProvider", "Progress", "Space"].map(name => [name,
        vue.defineComponent({ inheritAttrs: false, setup: (_props: unknown, { slots, attrs }: any) => () => name === "Alert"
          ? vue.h("div", String(attrs.message ?? "")) : vue.h(name === "Button" ? "button" : "div", attrs, slots.default?.()) })]));
      if (id.endsWith("services/desktop")) return { getDesktopBridge: () => bridge };
      if (id.endsWith("store/config")) return { useConfigStore: () => config };
      if (id.endsWith("desktopAuthPromptState")) return { desktopAuthModalOpen: vue.ref(false) };
      throw new Error(`unexpected migration page import: ${id}`);
    }).default;
    const state = scope.run(() => page.setup({}, { expose: () => {}, emit: (event: string) => { if (event === "ready") ready++; } }))!;
    await mounted();
    const render = loadModule(template.code, id => { assert.equal(id, "vue"); return vue; }).render;
    const app = vue.createSSRApp({ setup: () => () => render({}, [], {}, vue.proxyRefs(state), {}, {}) });
    const html = await renderToString(app);
    const allowed = scenario === "allowed";
    assert.equal(html.includes("暂不迁移，进入新桌面"), allowed, html);
    assert.equal(ready, 0, "未完成正常 Client 启动前不得开放主应用");
    assert.equal(deferrals, 0, "渲染页面不自动跳过");
    if (allowed) {
      assert.ok(html.includes("旧数据保持原样"), html);
      await state.perform("defer");
      assert.equal(deferrals, 1);
      assert.equal(config.serverWsOrigin, "ws://test-server.test:39280");
      assert.equal(config.hasActiveSession, false);
      assert.equal(ready, 0, "点击仅请求宿主，等待真实 runtimeReady");
    }
  });
}
