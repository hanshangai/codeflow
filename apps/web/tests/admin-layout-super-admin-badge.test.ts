import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse, compileTemplate } from "vue/compiler-sfc";
import * as vue from "vue";
import ts from "typescript";
import { resolveAdminConsoleUrl, isMigratedAdminPanel } from "../src/features/admin/systemPanelAccess.ts";

const adminLayoutSource = readFileSync(
  new URL("../src/features/admin/components/admin-layout.vue", import.meta.url),
  "utf8",
);

/** 执行真实模板的条件分支；子面板只保留组件标识，不加载各自 IO。 */
function visiblePanels(panel: string, role: "super_admin" | "enterprise_admin" = "super_admin", query: string = panel): string[] {
  const { descriptor } = parse(adminLayoutSource);
  const compiled = compileTemplate({ id: "public-settings", filename: "admin-layout.vue", source: descriptor.template!.content,
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name });
  const root = render({ admin: { activePanel: panel }, groupedMenuSections: [], adminGroupOpen: {},
    contentUsesInternalScroll: false, contentUsesCompactFlow: false, isMigratedSuperAdmin: isMigratedAdminPanel(role, query),
    activePanelNeedsLogin: false, config: { isDesktop: true }, hasServerSession: true, settingsPanelsScopeKey: "user",
    AccountOrderInfoPackagesPanel: "AccountOrderInfoPackagesPanel", AccountOrderInfoPaymentOrdersPanel: "AccountOrderInfoPaymentOrdersPanel" }, []);
  const visit = (node: vue.VNode): string[] => {
    const children = Array.isArray(node.children) ? node.children : (node.children as { default?: () => vue.VNode[] } | null)?.default?.() ?? [];
    return [...(typeof node.type === "string" ? [node.type] : []), ...children.filter(vue.isVNode).flatMap(visit)];
  };
  return visit(root);
}

test("超管普通设置照常渲染，旧管理深链仅显示迁移入口且不挂用户面板", () => {
  assert.ok(visiblePanels("settings").includes("AdminSettingsPanel"));
  const migrated = visiblePanels("settings", "super_admin", "user-management");
  assert.ok(migrated.includes("a-result")); assert.equal(migrated.includes("AdminSettingsPanel"), false);
  assert.equal(visiblePanels("settings", "enterprise_admin", "user-management").includes("a-result"), false);
});

test("企业成员、Token、审计、会话继续挂载各自公开组件", () => {
  for (const [panel, component] of [["enterprise-member-management", "EnterpriseManagementPanel"], ["enterprise-token", "EnterpriseTokenPanel"], ["enterprise-audit", "EnterpriseAuditPanel"], ["sessions", "AdminSessionsPanel"]]) {
    assert.ok(visiblePanels(panel!, "enterprise_admin").includes(component!), panel);
  }
});

test("真实控制台按钮使用Server地址并交现有window.open边界", () => {
  const { descriptor } = parse(adminLayoutSource), source = ts.createSourceFile("layout.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const handler = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "openAdminConsole"); assert.ok(handler);
  const calls: unknown[][] = [];
  const open = new Function("window", "config", "resolveAdminConsoleUrl", ts.transpile(handler.getText(source), { target: ts.ScriptTarget.ES2022 }) + "\nreturn openAdminConsole;")(
    { location: { origin: "http://127.0.0.1:40111" }, open: (...args: unknown[]) => calls.push(args) }, { serverWsOrigin: "ws://cloud.example.test:39280/ws" }, resolveAdminConsoleUrl);
  open(); assert.deepEqual(calls, [["http://cloud.example.test:39280/console/", "_blank", "noopener"]]);
});

test("桌面和移动路由同步保留已迁出的旧深链，不自动改回普通设置", () => {
  for (const [file, mobile] of [["../src/features/admin/components/admin-layout.vue", false], ["../src/layouts/mobile/mobile-layout.vue", true]] as const) {
    const { descriptor } = parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    const source = ts.createSourceFile("layout.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
    const watcher = source.statements.filter(ts.isExpressionStatement).map(node => node.expression).filter(ts.isCallExpression)
      .find(node => node.expression.getText(source) === "watch" && node.arguments[0]?.getText(source).includes(mobile ? "allowedAdminPanels" : "allowedPanels"));
    assert.ok(watcher);
    const events: unknown[] = [], context = { ui: { mainView: "admin" }, isMigratedSuperAdmin: { value: true },
      route: { query: { panel: "user-management" } }, admin: { activePanel: "settings", setPanel: (panel: string) => events.push(panel) },
      router: { replace: async (target: unknown) => events.push(target) }, shouldSyncMobileAdminPanelRoute: () => true,
      resolveRoutePanel: () => null, resolveRouteAdminPanel: () => null, resolveFallbackPanel: () => "settings", resolveFallbackAdminPanel: () => "settings" };
    const callback = new Function(...Object.keys(context), "return " + ts.transpile(watcher.arguments[1]!.getText(source), { target: ts.ScriptTarget.ES2022 }))(...Object.values(context));
    callback(mobile ? ["admin", ["settings"]] : [["settings"]]); assert.deepEqual(events, [], file);
  }
});
