import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import * as vue from "vue";
import { useConfigStore } from "../src/store/config.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";

const panelSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5SettingsPanel.vue", "utf8");
const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");
const homeSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5WorkbenchHome.vue", "utf8");
const accountDrawerSource = fs.readFileSync("apps/web/src/features/account/components/account-drawer.vue", "utf8");
const { parse, compileScript, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

/** 运行真实头像设置setup和完整模板，只隔离主题与工作区显示的无关store。 */
function profileFixture(t: test.TestContext, desktop: boolean) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = { getState: async () => ({ status: "ready" }), request: async () => { throw new Error("头像入口测试不得调用本机请求"); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: desktop ? bridge : undefined } });
  setActivePinia(createPinia());
  const config = useConfigStore(), events: unknown[][] = [];
  const descriptor = parse(panelSource).descriptor;
  const script = ts.transpileModule(compileScript(descriptor, { id: "profile-entry" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, unknown> } } };
  new Function("require", "module", "exports", script)((id: string) => {
    if (id === "vue") return vue;
    if (id === "lucide-vue-next") return {};
    if (id === "../../../store/config") return { useConfigStore };
    if (id === "../../../services/desktop") return { isDesktopWorkspace };
    if (id === "../../../store/ui") return { useUiStore: () => ({ setThemeMode() {} }) };
    if (id === "../../../store/workspaces") return { useWorkspacesStore: () => ({ byId: new Map() }) };
    if (id === "../../../utils/workspaceDisplay") return { getWorkspaceDisplayTitle: () => "fixture" };
    throw new Error(`unexpected profile import: ${id}`);
  }, module, module.exports);
  const setup = module.exports.default.setup({}, { expose: () => {}, emit: (...args: unknown[]) => events.push(args) });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: "H5SettingsPanel.vue", id: "profile-entry",
    compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: () => true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)(vue) as (context: Record<string, unknown>, cache: unknown[]) => vue.VNode;
  t.after(() => {
    config.$dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  return { config, events, tree: () => render(vue.proxyRefs({ ...setup, embedded: true }), []) };
}

/** 从完整渲染结果定位元素，保留外层 v-if 的可见性。 */
function findNodes(node: vue.VNode, tag: string): vue.VNode[] {
  const nested = Array.isArray(node.children) ? node.children.filter(vue.isVNode).flatMap(child => findNodes(child, tag)) : [];
  return node.type === tag ? [node, ...nested] : nested;
}

/** 只读取渲染文本，选择按钮时不复制其条件或导航逻辑。 */
function nodeText(node: vue.VNode): string {
  return typeof node.children === "string" ? node.children : Array.isArray(node.children) ? node.children.filter(vue.isVNode).map(nodeText).join("") : "";
}

test("桌面头像应用更新沿真实导航与返回层进入现有设置页", t => {
  const f = profileFixture(t, true), update = findNodes(f.tree(), "button").find(node => nodeText(node).includes("应用更新"));
  assert.ok(update, "实际头像设置必须提供应用更新");
  update.props!.onClick();
  assert.deepEqual(f.events, [["navigate", { type: "settings", context: { tab: "app-update", returnTo: "profile-settings" } }]]);
});

test("浏览器头像按工作台与个人中心顺序展示现行入口", t => {
  const f = profileFixture(t, false);
  assert.deepEqual(findNodes(f.tree(), "strong").map(nodeText),
    ["工作区管理", "模型与密钥", "流量统计", "支付订单", "消息通知", "个人信息"]);
});

test("头像Key与工作区继续发出原页面栈导航和返回目标", t => {
  const f = profileFixture(t, true);
  f.config.desktopRuntime = { status: "ready", requestId: "navigation", releaseId: null, errorCode: null };
  f.config.desktopClient = { clientId: "local", version: "1", connectedAt: 1, workspaceIds: ["local:ws"] };
  f.config.workspaceId = "local:ws";
  const buttons = findNodes(f.tree(), "button");
  for (const label of ["模型与密钥", "工作区管理"]) {
    const button = buttons.find(node => nodeText(node).includes(label))!;
    assert.ok(!button.props?.disabled);
    button.props!.onClick();
  }
  assert.deepEqual(f.events, [
    ["navigate", { type: "settings", context: { tab: "engine-keys", returnTo: "profile-settings" } }],
    ["navigate", { type: "settings", context: { tab: "workspaces", returnTo: "profile-settings" } }],
  ]);
});

test("H5 settings follows the confirmed mobile information architecture", () => {
  for (const label of ["工作区管理", "消息通知", "模型与密钥", "支付订单"]) {
    assert.match(panelSource, new RegExp(label, "u"));
  }
  assert.doesNotMatch(panelSource, /<h2>外观<\/h2>/u);
  assert.doesNotMatch(panelSource, /h5-settings__identity/u);
  assert.doesNotMatch(panelSource, /企业管理/u);
  assert.doesNotMatch(panelSource, /企业中心/u);
  assert.doesNotMatch(panelSource, /办公平台绑定|office-bindings/u);
});

test("H5 settings reuses theme and mobile page-stack owners", () => {
  assert.match(panelSource, /ui\.setThemeMode\(mode\)/u);
  assert.match(panelSource, /returnTo: "profile-settings"/u);
  assert.match(homeSource, /<H5SettingsPanel embedded/u);
  assert.doesNotMatch(panelSource, /系统设置|type: 'admin'/u);
  assert.match(panelSource, /流量统计/u);
  assert.match(layoutSource, /<AccountRelayUsagePanel[^>]+mobile/u);
  assert.match(layoutSource, /EngineKeysPanel[\s\S]+surface="isH5Surface \? 'h5' : 'default'"/u);
  assert.match(layoutSource, /MessageNotificationsPanel[\s\S]+surface="h5"/u);
  assert.match(layoutSource, /WorkspaceManager[\s\S]+surface="isH5Surface \? 'h5' : 'default'"/u);
});

test("H5 personal center opens profile through the account owner", async t => {
  const f = profileFixture(t, false);
  const button = findNodes(f.tree(), "button").find(node => nodeText(node).includes("个人信息"));
  assert.ok(button, "个人信息必须提供独立入口");
  button.props!.onClick();
  assert.deepEqual(f.events, [["account", "overview"]]);
  // 账户注销与密码安全入口已从移动版下线；资料入口继续由账号抽屉负责。
  assert.doesNotMatch(panelSource, /account-cancel|账户注销/u);
  assert.match(homeSource, /@account="openAccountSection"/u);
  assert.match(accountDrawerSource, /account-drawer-host--h5/u);
});

test("desktop profile keeps local entries first and one icon per settings row", t => {
  const f = profileFixture(t, true), tree = f.tree();
  assert.deepEqual(findNodes(tree, "strong").map(nodeText),
    ["定时任务", "应用更新", "工作区管理", "模型与密钥", "流量统计", "支付订单", "消息通知", "个人信息"]);
  const rows = findNodes(tree, "button").filter(node => findNodes(node, "strong").length > 0);
  for (const row of rows) {
    const icons = findNodes(row, "span").filter(node => String(node.props?.class ?? "").split(/\s+/u).includes("h5-settings__row-icon"));
    assert.equal(icons.length, 1, `${nodeText(row)}只能有一个入口图标`);
    assert.doesNotMatch(nodeText(row), /进入|›|»/u);
  }
  rows[0]!.props!.onClick();
  assert.deepEqual(f.events, [["navigate", { type: "settings", context: { tab: "scheduled-tasks", returnTo: "profile-settings" } }]]);
  assert.deepEqual(findNodes(tree, "button").filter(node => node.props?.["aria-pressed"] !== undefined).map(nodeText), ["亮色", "暗色", "自动"]);
  assert.match(panelSource, /grid-template-columns: 40px minmax\(0, 1fr\)/u);
  assert.match(panelSource, /from "lucide-vue-next"/u);
  assert.match(layoutSource, /orders: "支付订单"/u);
});

