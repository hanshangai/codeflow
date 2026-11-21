import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

import { resolveDesktopRuntimeStatusHint } from "../src/components/app-shell/desktopLocalClientStatus.ts";

const { parse, compileScript, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const filename = new URL("../src/components/app-shell/ClientStartupBanner.vue", import.meta.url);

type RuntimeState = { kind: "local"; status: "offline" | "online" };

/** 编译真实组件与模板，仅隔离 store 和路由边界。 */
function fixture() {
  const config = vue.reactive({
    isDesktop: true,
    localRuntimeReady: false,
    workspaceId: "remote-client:repo",
    desktopRuntime: { status: "failed", requestId: "local", releaseId: null, errorCode: "CLIENT_BOOT_FAILED" },
    desktopError: "CLIENT_BOOT_FAILED",
  });
  const admin = vue.reactive({ setPanel() {} });
  const workspaces = vue.reactive({ byId: new Map([["remote-client:repo", { ownerClientId: "remote-client" }]]) });
  const descriptor = parse(readFileSync(filename, "utf8")).descriptor;
  const compiled = ts.transpileModule(compileScript(descriptor, { id: "client-startup-banner" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  const imports: Record<string, unknown> = {
    "vue-router": { useRouter: () => ({ push() {} }) },
    "../../store/admin": { useAdminStore: () => admin },
    "../../store/config": { useConfigStore: () => config },
    "../../store/workspaces": { useWorkspacesStore: () => workspaces },
    "./desktopLocalClientStatus": { resolveDesktopRuntimeStatusHint },
  };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return vue;
    assert.ok(id in imports, `unexpected import: ${id}`);
    return imports[id];
  }, module, module.exports);
  const props = vue.reactive({ runtimeState: { kind: "local", status: "offline" } as RuntimeState });
  const bindings = module.exports.default.setup(props, { expose() {}, emit() {} })!;
  const template = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: "client-startup-banner",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(template.errors, []);
  const render = new Function("Vue", template.code)({ ...vue, resolveComponent: (name: string) => ({ name }) }) as (context: object, cache: unknown[]) => vue.VNode;
  return { props, bindings,
    tree: () => render(vue.proxyRefs({ ...bindings, runtimeState: props.runtimeState }), []) };
}

/** 展开真实 VNode 和组件插槽。 */
function nodes(node: vue.VNode): vue.VNode[] {
  const children = Array.isArray(node.children) ? node.children : node.children && typeof node.children === "object"
    ? Object.values(node.children).filter(value => typeof value === "function").flatMap(slot => (slot as () => vue.VNode[])()) : [];
  return [node, ...children.filter(vue.isVNode).flatMap(nodes)];
}

/** 读取渲染文本，避免依赖模板格式。 */
function text(node: vue.VNode): string {
  if (typeof node.children === "string") return node.children;
  if (Array.isArray(node.children)) return node.children.filter(vue.isVNode).map(text).join("");
  return node.children && typeof node.children === "object" && typeof (node.children as { default?: () => vue.VNode[] }).default === "function"
    ? (node.children as { default: () => vue.VNode[] }).default().filter(vue.isVNode).map(text).join("") : "";
}

test("本机运行时失败提示可关闭，状态变化后重新显示", () => {
  const f = fixture();
  assert.equal(f.bindings.visible.value, true);
  const rendered = nodes(f.tree());
  assert.ok(rendered.map(text).join(" ").includes("本机运行环境启动失败或连接已中断"));

  const close = rendered.find(node => node.type === "button" && node.props?.["aria-label"] === "关闭提示");
  assert.ok(close);
  (close.props!.onClick as () => void)();
  assert.equal(f.bindings.visible.value, false);

  f.props.runtimeState = { kind: "local", status: "online" };
  assert.equal(f.bindings.visible.value, true);
});
