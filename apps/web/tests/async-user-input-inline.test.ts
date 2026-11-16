import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { renderToString } from "vue/server-renderer";

const { parse, compileScript, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

function loadModule(source: string, load: (id: string) => unknown) {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)(load, module, module.exports);
  return module.exports;
}

/** 编译并挂载真实 SFC setup；待处理卡片点击后使用 body 弹层。 */
function fixture() {
  const source = fs.readFileSync(new URL("../src/features/messages/components/items/user-input-request-item.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "async-input-inline" });
  const template = compileTemplate({ source: descriptor.template!.content, filename: "user-input-request-item.vue", id: "async-input-inline",
    compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const props = vue.reactive({ compact: true, item: { kind: "userInputRequest", id: "call", requestId: "call", threadId: "thread",
    workspaceId: "workspace", delivery: "async", state: "pending", header: "问题", prompt: "补充输入",
    questions: [{ id: "q", question: "选择范围", header: "范围" }] } });
  const config = { connected: true, webSessionId: "web", webInstanceId: "instance" };
  const modules: Record<string, unknown> = {
    vue: { ...vue, inject: () => null, onBeforeUnmount() {}, onDeactivated() {} },
    "ant-design-vue": { message: {}, Modal: {} },
    "@ant-design/icons-vue": Object.fromEntries(["RightOutlined", "DownOutlined", "CheckCircleFilled", "SyncOutlined", "ClockCircleOutlined", "CloseOutlined"]
      .map(name => [name, vue.defineComponent({ setup: () => () => null })])),
    "@/composables/useClipboard": { copyToClipboard() {} },
    "../../../../api/request": { createApiResultError: (result: any) => new Error(result.message) },
    "../../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref({}) }) },
    "../../../../api/interactions": { respondUserInput: async () => ({ ok: true }) },
    "../../../../services/desktop": { isDesktopWorkspace: () => true },
    "../../../../store/chat": { useChatStore: () => ({ selectedThreadId: "thread" }) }, "../../../../store/config": { useConfigStore: () => config },
    "../../../../store/ui": { useUiStore: () => ({ mainView: "chat", inspectorVisible: false }) },
  };
  const scope = vue.effectScope();
  const module = loadModule(script.content, id => {
    if (!(id in modules)) throw new Error(`Unexpected import: ${id}`);
    return modules[id];
  });
  const state = scope.run(() => module.default.setup(props, { expose() {} }))!;
  const render = loadModule(template.code, id => { assert.equal(id, "vue"); return vue; }).render;
  return { props, state, render, stop: () => scope.stop() };
}

/** Ant 组件在 SSR 中只验证结构，保留默认插槽。 */
function createApp(f: ReturnType<typeof fixture>) {
  const app = vue.createSSRApp({ setup: () => () => f.render({}, [], f.props, vue.proxyRefs(f.state), {}, {}) });
  for (const name of ["a-button", "a-checkbox-group", "a-checkbox", "a-radio-group", "a-radio", "a-space", "a-input", "a-textarea"]) {
    app.component(name, vue.defineComponent({ inheritAttrs: false, setup: (_props: unknown, { slots }: any) => () => vue.h("div", { class: `stub-${name}` }, slots.default?.()) }));
  }
  return app;
}

test("异步问题卡片不自动展开，打开后走 body 弹层", async t => {
  const f = fixture();
  t.after(f.stop);
  assert.equal(f.state.dialogOpen.value, false, "问题到达时不自动展开");
  const cardContext: { teleports?: Record<string, string> } = {};
  const cardHtml = await renderToString(createApp(f), cardContext);
  assert.ok(cardHtml.includes("填写"), "待处理卡片提供『填写』入口");
  assert.ok(!cardHtml.includes("uir-dialog-layer"), "待处理卡片不内联展开");

  f.state.dialogOpen.value = true;
  const dialogContext: { teleports?: Record<string, string> } = {};
  await renderToString(createApp(f), dialogContext);
  assert.ok(JSON.stringify(dialogContext.teleports ?? {}).includes("uir-dialog-layer"), "手动打开走 body 弹层");
});
