import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import * as requestApi from "../src/api/request.ts";
import * as threadApi from "../src/api/threads/index.ts";
import { createProcessDetailsLoader } from "../src/features/chat/processDetails.ts";
import * as renderNodes from "../src/features/messages/assistantRenderNodes.ts";
import * as prepareItems from "../src/features/messages/prepareConversationItems.ts";

type HostNode = { type: string; props: Record<string, any>; children: HostNode[]; style: Record<string, unknown>; parent?: HostNode };
const process = { kind: "process", id: "process:read", preview: "Read", itemCount: 3,
  statusCounts: { done: 2, running: 0, warning: 0, failed: 0 }, version: 10 };
const workspaceId = "desktop:inspector", threadId = "inspector-thread";
const apiContext = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };

/** 挂载真实 SFC 与模板，只隔离子组件及 DOM，不绕过响应式和事件处理。 */
function mountSfc(t: test.TestContext, file: string, props: Record<string, unknown>, modules: Record<string, unknown>) {
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(compileScript(parse(source).descriptor, { id: file, inlineTemplate: true }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: vue.Component } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return vue;
    if (Object.hasOwn(modules, id)) return id.endsWith(".vue") ? { default: modules[id] } : modules[id];
    if (id === "@ant-design/icons-vue") return new Proxy({}, { get: () => vue.defineComponent(() => () => null) });
    throw new Error(`unexpected SFC import: ${id}`);
  }, module, module.exports);
  const create = (type: string): HostNode => ({ type, props: {}, children: [], style: {} });
  const renderer = vue.createRenderer<HostNode, HostNode>({
    createElement: create, createText: () => create("text"), createComment: () => create("comment"),
    setText() {}, setElementText() {}, parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, next) => { node.props[key] = next; },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
  });
  const root = create("root"), app = renderer.createApp(module.exports.default, props);
  for (const tag of ["a-button", "a-space", "a-empty", "a-tag", "a-modal", "a-alert"]) {
    app.component(tag, vue.defineComponent({ setup: (_props, { slots, attrs }) => () => vue.h(tag, attrs, slots.default?.()) }));
  }
  app.mount(root);
  t.after(app.unmount);
  /** 从实际渲染结果查找节点，断言模板绑定而非源码字符串。 */
  const find = (type: string, node = root): HostNode[] => [
    ...(node.type === type ? [node] : []), ...node.children.flatMap(child => find(type, child)),
  ];
  return { find };
}

/** 调试页仍使用真实聊天 Store，过程明细接口留到展开时由 ProcessDetails 负责。 */
function inspector(t: test.TestContext) {
  setActivePinia(createPinia());
  const chat = useChatStore(), config = useConfigStore();
  config.workspaceId = workspaceId as never;
  chat.selectedThreadId = threadId as never;
  chat.threads = [{ id: threadId, title: "review", engine: "codex", createdAt: 1, updatedAt: 1 }] as never;
  chat.loadedThreads[threadId] = true;
  chat.ensureConversation(threadId as never).items.push(process as never);
  let eventMounts = 0;
  const ProcessDetails = vue.defineComponent({ props: { item: Object, workspaceId: String, threadId: String, apiContext: Object, toolsOnly: Boolean },
    setup: props => () => vue.h("process-details", { ...props }) });
  const mounted = mountSfc(t, "../src/features/inspector/components/inspector-panel.vue", {}, {
    "../../../store/chat": { useChatStore }, "../../../store/config": { useConfigStore },
    "../../../store/ui": { useUiStore: () => ({ toggleInspector() {} }) },
    "../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref(apiContext) }) },
    "../../messages/components/process-details.vue": ProcessDetails,
    "./engine-events-panel.vue": vue.defineComponent({ setup: () => { eventMounts++; return () => vue.h("engine-events"); } }),
  });
  return { ...mounted, eventMounts: () => eventMounts };
}

test("调试工具页保留过程入口并传递本机读取上下文", t => {
  const f = inspector(t), entries = f.find("process-details");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.props.item.id, "process:read");
  assert.equal(entries[0]!.props.toolsOnly, true);
  assert.equal(entries[0]!.props.workspaceId, workspaceId);
  assert.equal(entries[0]!.props.threadId, threadId);
});

test("工具页不会挂载原始事件页", t => {
  const f = inspector(t);
  assert.equal(f.eventMounts(), 0);
});

test("调试过程展开才读取，直接展示原始工具且保留分页", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: unknown[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }), request: async (request: unknown) => {
      requests.push(request);
      return { status: 200, body: { ok: true, version: 10, hasMore: true, nextCursor: "write", items: [
        { kind: "reasoning", id: "reason", content: "private" },
        { kind: "tool", id: "read", toolType: "Read", title: "Read", detail: '{"path":"src/a.ts"}', status: "completed" },
        { kind: "tool", id: "write", toolType: "Write", title: "Write", detail: "input", output: "output", status: "completed" },
      ] } };
    },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  const row = (type: string) => vue.defineComponent({ props: ["item"], setup: props => () => vue.h(type, { item: props.item }) });
  const f = mountSfc(t, "../src/features/messages/components/process-details.vue", { item: process, workspaceId, threadId, apiContext, toolsOnly: true }, {
    "../../../api/request": requestApi, "../../../api/threads": threadApi,
    "../../chat/processDetails": { createProcessDetailsLoader }, "../assistantRenderNodes": renderNodes, "../prepareConversationItems": prepareItems,
    "./items/tool-item.vue": row("tool-row"), "./items/reasoning-item.vue": row("reasoning-row"),
    "./items/diff-item.vue": row("diff-row"), "./items/review-item.vue": row("review-row"),
    "./items/explore-item.vue": row("explore-row"), "./items/subagent-item.vue": row("subagent-row"),
  });
  assert.equal(requests.length, 0);
  f.find("details")[0]!.props.onToggle({ target: { open: true } });
  await new Promise(resolve => setImmediate(resolve));
  await vue.nextTick();
  assert.equal(requests.length, 1);
  assert.deepEqual(f.find("tool-row").map(node => node.props.item.id), ["read", "write"]);
  assert.equal(f.find("reasoning-row").length, 0);
  assert.equal(f.find("explore-row").length, 0);
  assert.equal(f.find("a-button").length, 1, "仍可显式读取下一页");
});
