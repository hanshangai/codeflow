import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

import { isDesktopLocalAccessView, requiresWorkspaceAccess } from "../src/router/workspaceAccess.ts";
import { isPublicPanel } from "../src/features/admin/systemPanelAccess.ts";
import type { AdminPanel } from "../src/store/admin.ts";
import type { MainView } from "../src/store/ui.ts";

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const topbarFilename = new URL("../src/components/app-shell/app-topbar.vue", import.meta.url);
const topbarSource = readFileSync(topbarFilename, "utf8");
const adminLayoutSource = readFileSync(
  new URL("../src/features/admin/components/admin-layout.vue", import.meta.url),
  "utf8",
);

test("workspace access keeps browser login redirects and opens only local desktop views", () => {
  const localDesktop: MainView[] = ["chat", "orchestration", "knowledge", "admin"];
  const required: MainView[] = [...localDesktop, "payment-verification"];

  for (const view of required) {
    assert.equal(requiresWorkspaceAccess(view), true, `${view} 应要求工作区访问权限`);
  }
  for (const view of ["landing", "contact", "auth"] as MainView[]) {
    assert.equal(requiresWorkspaceAccess(view), false, `${view} 不应要求工作区访问权限`);
  }
  for (const view of required) {
    assert.equal(isDesktopLocalAccessView(true, view), localDesktop.includes(view), `桌面 ${view} 本地放行结果不正确`);
    assert.equal(isDesktopLocalAccessView(false, view), false, `浏览器 ${view} 不得本地放行`);
  }
});

const parsedTopbar = parse(topbarSource);
assert.deepEqual(parsedTopbar.errors, []);
const templateAst = parsedTopbar.descriptor.template!.ast as any;

/** 从真实模板 AST 中按可见文案定位系统入口按钮，返回其原始源码片段。 */
function buttonSource(label: string): string {
  function visit(node: any): any {
    if (!node) return null;
    if (node.type === 1 && node.tag === "button") {
      const text = (node.children ?? []).filter((child: any) => child.type === 2).map((child: any) => child.content).join("");
      if (text.includes(label)) return node;
    }
    for (const children of [node.children, ...(node.branches ?? []).map((branch: any) => branch.children)]) {
      for (const child of children ?? []) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  }
  const found = visit(templateAst);
  assert.ok(found, `${label}按钮必须存在于顶栏模板`);
  return found.loc.source as string;
}

/** 编译单个按钮片段并执行真实渲染函数，返回生成的 VNode。 */
function renderButton(source: string, context: Record<string, unknown>): unknown {
  const compiled = compileTemplate({ source, filename: topbarFilename.pathname, id: "topbar-system-entry",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)(vue) as (ctx: Record<string, unknown>, cache: unknown[]) => unknown;
  return render(context, []);
}

/** 从真实渲染结果读取可见文字。 */
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  return vue.isVNode(value) ? textContent(value.children) : "";
}

/** 按当前桌面/会话事实渲染两个系统入口，验证真实模板的显示结果。 */
function visibleSystemEntries(isDesktop: boolean, hasActiveSession: boolean): string[] {
  const context = {
    shell: { config: { isDesktop, hasActiveSession } },
    canOpenSystemViews: isDesktop || hasActiveSession,
    orchestrationMetricsEntryActive: false,
    systemEntryActive: false,
    openAdmin() {},
    openOrchestrationMetrics() {},
  };
  return ["设置", "度量"].filter((label) => textContent(renderButton(buttonSource(label), context)).includes(label));
}

test("desktop without a session renders settings and metrics entries, browser without a session hides both", (t) => {
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(visibleSystemEntries(true, false), ["设置", "度量"]);
  assert.deepEqual(visibleSystemEntries(false, false), []);
  assert.deepEqual(visibleSystemEntries(true, true), ["设置", "度量"]);
  assert.deepEqual(visibleSystemEntries(false, true), ["设置", "度量"]);
  assert.match(topbarSource, /const canOpenSystemViews = computed\(\(\) => props\.shell\.config\.isDesktop \|\| props\.shell\.config\.hasActiveSession\);/u);
});

/** 执行真实登录保护并渲染完整管理模板，子面板只保留其挂载边界。 */
function renderedAdminElements(isDesktop: boolean, hasActiveSession: boolean, activePanel: AdminPanel): vue.VNode[] {
  const descriptor = parse(adminLayoutSource).descriptor;
  const script = ts.createSourceFile("admin-layout.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const initializer = script.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(script) === "activePanelNeedsLogin")?.initializer;
  assert.ok(initializer, "管理壳必须拥有服务端面板的登录保护");
  const config = { isDesktop }, admin = { activePanel }, hasServerSession = vue.ref(hasActiveSession);
  const activePanelNeedsLogin = new Function("computed", "hasServerSession", "isPublicPanel", "config", "admin", `return ${initializer.getText(script)}`)(
    vue.computed, hasServerSession, isPublicPanel, config, admin,
  );
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: "admin-layout.vue", id: "admin-login",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name }) as (context: object, cache: unknown[]) => vue.VNode;
  const tree = render(vue.proxyRefs({ config, admin, hasServerSession, activePanelNeedsLogin, groupedMenuSections: [],
    settingsPanelsScopeKey: "test",
    showLayoutSuperAdminBadge: false, contentUsesInternalScroll: false, contentUsesCompactFlow: false }), []);
  const nodes: vue.VNode[] = [];
  const visit = (node: vue.VNode): void => {
    nodes.push(node);
    const defaultSlot = (node.children as { default?: () => vue.VNode[] } | null)?.default;
    const children = Array.isArray(node.children) ? node.children : typeof defaultSlot === "function" ? defaultSlot() : [];
    for (const child of children) if (vue.isVNode(child)) visit(child);
  };
  visit(tree);
  return nodes;
}

test("settings shell blocks cloud panels while desktop metrics and local tasks remain available", () => {
  for (const desktop of [false, true]) {
    const nodes = renderedAdminElements(desktop, false, "relay-self-usage");
    assert.ok(nodes.some(node => node.props?.class === "admin-layout__login-hint"));
    assert.equal(nodes.some(node => node.type === "AccountRelayUsagePanel"), false);
  }
  const browserMetrics = renderedAdminElements(false, false, "orchestration-metrics");
  assert.ok(browserMetrics.some(node => node.props?.class === "admin-layout__login-hint"));
  assert.equal(browserMetrics.some(node => node.type === "OrchestrationMetricsEntry"), false);
  for (const [desktop, session] of [[true, false], [true, true], [false, true]]) {
    const nodes = renderedAdminElements(desktop!, session!, "orchestration-metrics");
    assert.equal(nodes.some(node => node.props?.class === "admin-layout__login-hint"), false);
    assert.ok(nodes.some(node => node.type === "OrchestrationMetricsEntry"));
  }
  assert.ok(renderedAdminElements(true, false, "scheduled-tasks").some(node => node.type === "DesktopScheduledTasksPanel"));
  // 桌面端统一复用本机定时任务面板，登录后也由它合并账号任务。
  assert.ok(renderedAdminElements(true, true, "scheduled-tasks").some(node => node.type === "DesktopScheduledTasksPanel"));
  assert.ok(renderedAdminElements(false, true, "scheduled-tasks").some(node => node.type === "AdminScheduledTasksPanel"));
  assert.ok(renderedAdminElements(false, true, "relay-self-usage").some(node => node.type === "AccountRelayUsagePanel"));
});
