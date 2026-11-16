import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import type { OnlineClientInfo } from "@codeflowai/shared";
import { resolveWorkspaceRuntimeDisplay } from "../src/utils/workspaceRuntimeDisplay.ts";

const { parse, compileScript, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const filename = new URL("../src/features/settings/components/client-management-modal.vue", import.meta.url);

/** 编译真实组件与模板，仅隔离传输、弹窗和 store 外部边界。 */
function fixture(t: test.TestContext, clients: OnlineClientInfo[] = []) {
  const config = vue.reactive({ workspaceId: "local:main", desktopClient: { clientId: "local:device" } });
  const presence = vue.reactive({ ready: true, online: { onlineClients: clients },
    activeWorkspaceRuntimeState: { kind: "local", status: "online" }, accountClientState: "online" });
  const workspaces = vue.reactive({ byId: new Map<string, any>([["local:main", { title: "研发工作区" }]]) });
  const descriptor = parse(readFileSync(filename, "utf8")).descriptor;
  const compiled = ts.transpileModule(compileScript(descriptor, { id: "device-status" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  const lifecycle: Array<() => void> = [];
  const imports: Record<string, unknown> = {
    "ant-design-vue": { Modal: { name: "Modal" }, message: {} },
    "@ant-design/icons-vue": {},
    "../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref({}) }) },
    "../../../api/request": { isCancelledRequestError: () => false, requestJson: () => { throw new Error("unexpected request"); } },
    "../../../store/config": { useConfigStore: () => config },
    "../../../store/presence": { usePresenceStore: () => presence },
    "../../../store/workspaces": { useWorkspacesStore: () => workspaces },
    "../../../utils/workspaceId": { isSharedWorkspaceSelectionId: (id: string) => id.startsWith("shared:") },
    "../../../utils/workspaceTitle": { resolveWorkspaceDisplayTitle: (id: string, lookup: (id: string) => string) => lookup(id) ?? id },
    "../../../utils/workspaceRuntimeDisplay": { resolveWorkspaceRuntimeDisplay },
    "./client-data-cleanup-modal.vue": {},
    "../../../analytics/analytics": { trackProductEvent() {} },
  };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onUnmounted: (callback: () => void) => lifecycle.push(callback) };
    assert.ok(id in imports, `unexpected import: ${id}`);
    return imports[id];
  }, module, module.exports);
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup({ open: true, embedded: false }, { expose() {}, emit() {} }))!;
  const template = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: "device-status",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(template.errors, []);
  const render = new Function("Vue", template.code)({ ...vue, resolveComponent: (name: string) => ({ name }) }) as (context: object, cache: unknown[]) => vue.VNode;
  t.after(() => { lifecycle.forEach(callback => callback()); scope.stop(); });
  return { config, presence, workspaces, bindings,
    tree: () => render(vue.proxyRefs({ ...bindings, open: true, embedded: false }), []) };
}

/** 展开真实 VNode 和组件插槽，包含用户可打开的操作菜单。 */
function nodes(node: vue.VNode): vue.VNode[] {
  const children = Array.isArray(node.children) ? node.children : node.children && typeof node.children === "object"
    ? Object.values(node.children).filter(value => typeof value === "function").flatMap(slot => slot()) : [];
  return [node, ...children.filter(vue.isVNode).flatMap(nodes)];
}

/** 读取渲染文本，避免依赖模板格式。 */
function text(node: vue.VNode): string {
  if (typeof node.children === "string") return node.children;
  if (Array.isArray(node.children)) return node.children.filter(vue.isVNode).map(text).join("");
  return node.children && typeof node.children === "object" && typeof node.children.default === "function"
    ? node.children.default().filter(vue.isVNode).map(text).join("") : "";
}

const local: OnlineClientInfo = { clientId: "local:device", version: "2026.10.19.01", connectedAt: 1, workspaceIds: ["local:main"], runtimeSource: "desktop" };

test("设备界面只展示名称、状态和工作区，不暴露内部版本与迁移宣传", t => {
  const f = fixture(t, [local]), tree = f.tree(), rendered = nodes(tree);
  assert.equal(tree.props!.title, "设备与运行状态");
  assert.match(rendered.map(text).join(" "), /本机.*关联工作区.*研发工作区/u);
  assert.ok(rendered.some(node => node.props?.text === "在线"));
  assert.doesNotMatch(rendered.map(text).join(" "), /Client|2026\.10\.19|local:device|连接时长|下载桌面版|迁移说明|更新日志/u);
});

test("更多菜单保留重命名与清理入口", t => {
  const f = fixture(t, [{ ...local, name: "工作电脑" }]);
  const entries = nodes(f.tree());
  const rename = entries.find(node => text(node) === "重命名" && node.props?.onClick);
  assert.ok(rename);
  rename.props!.onClick();
  assert.equal(f.bindings.editingNameClientId.value, local.clientId);
  f.bindings.cancelEditName();
  const cleanup = entries.find(node => text(node) === "清理数据" && node.props?.onClick);
  assert.ok(cleanup);
  cleanup.props!.onClick();
  assert.equal(f.bindings.cleanupClientId.value, local.clientId);
  assert.equal(f.bindings.cleanupOpen.value, true);
  assert.equal(entries.some(node => text(node) === "退出运行服务"), false);
});

test("加载和空设备列表有明确状态，不再提示旧版迁移", t => {
  const f = fixture(t);
  let rendered = nodes(f.tree()).map(text).join(" ");
  assert.match(rendered, /暂无在线设备/u);
  assert.doesNotMatch(rendered, /下载|迁移|Client/u);
  f.presence.ready = false;
  rendered = nodes(f.tree()).map(text).join(" ");
  assert.match(rendered, /正在读取设备状态/u);
  assert.doesNotMatch(rendered, /暂无在线设备|0 台在线/u);
});

test("共享工作区沿用真实运行态并移除 Host 内部版本", t => {
  const f = fixture(t);
  f.config.workspaceId = "shared:main";
  f.workspaces.byId.set("shared:main", { title: "项目协作", kind: "shared", shared: { hostLabel: "研发目录", hostOwnerName: "负责人甲" } });
  f.presence.activeWorkspaceRuntimeState = { kind: "shared", status: "online" };
  const rendered = nodes(f.tree()).map(text).join(" ");
  assert.match(rendered, /项目协作.*研发目录.*负责人甲/u);
  assert.doesNotMatch(rendered, /Host|Client|版本/u);
  assert.match(rendered, /不影响当前共享工作区/u);
});
