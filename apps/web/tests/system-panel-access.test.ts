import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createPinia, setActivePinia } from "pinia";

import {
  isLocalDesktopPanel,
  isPublicPanel,
  LOCAL_DESKTOP_PANELS,
  PUBLIC_PANELS,
  resolveAllowedSystemPanels,
  resolveAvailableSystemPanels,
  resolveFallbackSystemPanel,
  resolveRouteSystemPanel,
  resolveSystemGroupLabels,
  type SystemScope,
} from "../src/features/admin/systemPanelAccess.ts";
import type { AdminPanel } from "../src/store/admin.ts";
import { useConfigStore } from "../src/store/config.ts";

const adminLayoutSource = readFileSync(
  new URL("../src/features/admin/components/admin-layout.vue", import.meta.url),
  "utf8",
);

const SCOPES: SystemScope[] = ["super_admin", "enterprise_admin", "enterprise_member", "personal_user"];

test("system menu removes statistics group and places relay usage after engine keys", () => {
  setActivePinia(createPinia());

  for (const scope of SCOPES) {
    const labels = resolveSystemGroupLabels(scope);
    assert.equal(Object.values(labels).includes("统计分析"), false);

    const panels = resolveAvailableSystemPanels(scope, {
      relayManagementEnabled: scope === "super_admin",
    });
    const engineIndex = panels.findIndex((panel) => panel.key === "engine-keys");
    const relayUsageIndex = panels.findIndex((panel) => panel.key === "relay-self-usage");

    assert.ok(engineIndex >= 0, `${scope} 应展示模型配置`);
    assert.equal(relayUsageIndex, engineIndex + 1, `${scope} 的流量统计应紧跟模型配置`);
    assert.equal(panels[relayUsageIndex]?.group, "settings");
  }
});

test("workspace management is a settings menu immediately after basic settings", () => {
  setActivePinia(createPinia());

  for (const scope of SCOPES) {
    const panels = resolveAvailableSystemPanels(scope);
    const settingsIndex = panels.findIndex((panel) => panel.key === "settings");
    const workspacesIndex = panels.findIndex((panel) => panel.key === "workspaces");

    assert.ok(settingsIndex >= 0, `${scope} 应展示基础设置`);
    assert.equal(workspacesIndex, settingsIndex + 1, `${scope} 的工作区管理应紧跟基础设置`);
    assert.equal(panels[workspacesIndex]?.label, "工作区");
    assert.equal(panels[workspacesIndex]?.group, "settings");
  }
});

test("public settings never expose best-practice management", () => { for (const scope of SCOPES) assert.equal(resolveAvailableSystemPanels(scope).some(panel => panel.key === "best-practices"), false); });

test("builtin asset import is absent because the AI asset library is the only product entry", () => {
  setActivePinia(createPinia());

  for (const scope of SCOPES) {
    const panelKeys = resolveAvailableSystemPanels(scope).map((panel) => String(panel.key));
    assert.equal(panelKeys.includes("orchestration-assets"), false);
  }
});

test("platform users and Client management stay outside public settings", () => { for (const scope of SCOPES) { const keys = resolveAllowedSystemPanels(scope); assert.equal(keys.includes("user-management"), false); assert.equal(keys.includes("client-db-devices"), false); } });

// 企业权益页已随人月模式下线，只保留成员与 Token 管理入口。
test("enterprise member and token management use dedicated menus", () => {
  setActivePinia(createPinia());

  for (const scope of SCOPES) {
    const panels = resolveAvailableSystemPanels(scope);
    const memberIndex = panels.findIndex((panel) => panel.key === "enterprise-member-management");
    const enterpriseTokenIndex = panels.findIndex((panel) => panel.key === "enterprise-token");
    const shouldShow = scope === "enterprise_admin";

    assert.equal(panels.some((panel) => String(panel.key) === "enterprise-package-management"), false, `${scope} 不应再展示企业权益菜单`);
    assert.equal(memberIndex >= 0, shouldShow, `${scope} 成员管理菜单可见性不正确`);
    assert.equal(enterpriseTokenIndex >= 0, shouldShow, `${scope} 企业Token菜单可见性不正确`);
    if (shouldShow) {
      assert.equal(enterpriseTokenIndex, memberIndex + 1);
      assert.equal(panels[memberIndex]?.label, "企业成员");
      assert.equal(panels[enterpriseTokenIndex]?.label, "企业流量");
      assert.equal(panels[memberIndex]?.group, "enterprise");
      assert.equal(panels[enterpriseTokenIndex]?.group, "enterprise");
    }
  }
});

test("mobile settings combines notifications for all accounts and H5 only for admins", () => {
  setActivePinia(createPinia());
  for (const scope of SCOPES) {
    const panelKeys = resolveAvailableSystemPanels(scope).map((panel) => String(panel.key));
    assert.equal(panelKeys.includes("message-notifications"), true);
    assert.equal(panelKeys.includes("office-h5"), false);
  }
  assert.match(adminLayoutSource, /AdminMobileSettingsPanel/u);
  assert.match(adminLayoutSource, /resolveRouteSystemPanel/u);
});

test("every public account retains its own orders without platform payment management", () => { for (const scope of SCOPES) { const keys = resolveAllowedSystemPanels(scope); assert.ok(keys.includes("payment-orders")); assert.equal(keys.includes("payment-management"), false); assert.equal(keys.includes("invoice-management"), false); } });

test("legacy panel deep links keep working across account scopes", () => {
  setActivePinia(createPinia());

  const superAdminPanels = resolveAllowedSystemPanels("super_admin");
  assert.equal(resolveRouteSystemPanel("payment-orders", superAdminPanels), "payment-orders");
  assert.equal(resolveRouteSystemPanel("invoice-management", superAdminPanels), null);
  assert.equal(resolveRouteSystemPanel("office-h5", superAdminPanels), "message-notifications");

  for (const scope of ["enterprise_admin", "enterprise_member", "personal_user"] as SystemScope[]) {
    const allowedPanels = resolveAllowedSystemPanels(scope);
    assert.equal(resolveRouteSystemPanel("payment-orders", allowedPanels), "payment-orders", `${scope} 旧支付订单深链应回落原面板`);
    assert.equal(resolveRouteSystemPanel("invoice-management", allowedPanels), null, `${scope} 不应解析出不可见的发票管理面板`);
    assert.equal(resolveRouteSystemPanel("payment-management", allowedPanels), null, `${scope} 不应解析出不可见的支付管理面板`);
  }

  assert.equal(resolveRouteSystemPanel("not-a-panel" as AdminPanel, superAdminPanels), null);
});

test("public settings expose read-only prices without Token pricing management", () => { for (const scope of SCOPES) { const keys = resolveAllowedSystemPanels(scope); assert.ok(keys.includes("relay-price-config")); assert.equal(keys.includes("relay-recharge-pricing"), false); } });

test("purchased packages are visible and accessible only to enterprise admins", () => {
  setActivePinia(createPinia());

  for (const scope of SCOPES) {
    const expected = scope === "enterprise_admin";
    const allowedPanelKeys = resolveAllowedSystemPanels(scope).map(String);
    const visiblePanelKeys = resolveAvailableSystemPanels(scope).map((panel) => String(panel.key));

    assert.equal(allowedPanelKeys.includes("packages"), expected, `${scope} 已购套餐访问权限不正确`);
    assert.equal(visiblePanelKeys.includes("packages"), expected, `${scope} 已购套餐菜单可见性不正确`);
  }
});

test("relay usage stays visible in every scope", () => {
  setActivePinia(createPinia());
  for (const scope of SCOPES) {
    const panels = resolveAvailableSystemPanels(scope, { relayManagementEnabled: scope === "super_admin" });
    assert.ok(panels.some((panel) => panel.key === "relay-self-usage"), `${scope} 应保留流量统计入口`);
  }
});

test("personal scope exposes nine allowed panels while the sidebar keeps metrics in the topbar entry", () => {
  setActivePinia(createPinia());

  const expected = ["settings", "workspaces", "engine-keys", "relay-self-usage", "relay-price-config",
    "message-notifications", "scheduled-tasks", "orchestration-metrics", "payment-orders"];
  assert.deepEqual(resolveAllowedSystemPanels("personal_user"), expected);

  const menu = resolveAvailableSystemPanels("personal_user").map((panel) => panel.key);
  assert.deepEqual(menu, expected.filter((panel) => panel !== "orchestration-metrics"));
  assert.equal(menu.includes("client-db-devices"), false);
});

test("local desktop panels cover only server-free settings and tasks", () => {
  assert.deepEqual([...LOCAL_DESKTOP_PANELS], ["settings", "workspaces", "engine-keys", "scheduled-tasks"]);
  for (const panel of ["settings", "workspaces", "engine-keys", "scheduled-tasks"] as const) {
    assert.equal(isLocalDesktopPanel(panel), true);
  }
  for (const panel of ["relay-self-usage", "payment-orders", "orchestration-metrics", "marketplace"] as const) {
    assert.equal(isLocalDesktopPanel(panel), false);
  }
  assert.deepEqual([...PUBLIC_PANELS], ["settings", "workspaces", "engine-keys", "scheduled-tasks", "relay-price-config"]);
  for (const panel of PUBLIC_PANELS) assert.equal(isPublicPanel(panel), true);
  for (const panel of ["relay-self-usage", "payment-orders", "orchestration-metrics", "marketplace"] as const) {
    assert.equal(isPublicPanel(panel), false);
  }
});

test("fallback panel keeps the menu history when a server session exists", () => {
  const menuPanels = ["settings", "workspaces", "engine-keys"] as const;
  assert.equal(resolveFallbackSystemPanel({ menuPanels, allowedPanels: menuPanels, lastMenuPanel: "workspaces",
    activePanel: "settings", hasServerSession: true }), "workspaces");
  assert.equal(resolveFallbackSystemPanel({ menuPanels, allowedPanels: menuPanels, lastMenuPanel: "relay-self-usage",
    activePanel: "engine-keys", hasServerSession: true }), "engine-keys");
});

test("fallback panel without a session lands on a local desktop panel", () => {
  const menuPanels = ["settings", "workspaces", "engine-keys", "relay-self-usage", "scheduled-tasks"] as const;
  assert.equal(resolveFallbackSystemPanel({ menuPanels, allowedPanels: menuPanels, lastMenuPanel: "scheduled-tasks",
    activePanel: "relay-self-usage", hasServerSession: false }), "scheduled-tasks");
  assert.equal(resolveFallbackSystemPanel({ menuPanels, allowedPanels: menuPanels, lastMenuPanel: "relay-self-usage",
    activePanel: "relay-self-usage", hasServerSession: false }), "settings");
});

test("legacy deployment metadata cannot restore platform management", () => { setActivePinia(createPinia()); Object.assign(useConfigStore(), { deployment: { edition: "private" } }); for (const scope of SCOPES) { const keys = resolveAllowedSystemPanels(scope); assert.ok(keys.includes("relay-self-usage")); assert.ok(keys.includes("payment-orders")); assert.equal(keys.includes("packages"), scope === "enterprise_admin"); for (const key of ["user-management", "relay-recharge-pricing", "best-practices"] as const) assert.equal(keys.includes(key), false); } });
