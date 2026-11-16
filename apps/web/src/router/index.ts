import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { message } from "ant-design-vue";

import { pinia } from "../store/pinia";
import { useConfigStore } from "../store/config";
import { buildLoginRouteLocation, resolvePostLoginTarget } from "../features/account/loginRedirect";
import { resolveOrchestrationEntryFromRouteName } from "../features/orchestration/orchestration-entry";
import { useUiStore, type MainView } from "../store/ui";
import { trackProductEvent } from "../analytics/analytics";
import { applyPageSeo } from "../seo/pageSeo";
import { resolveLegacyMobileRedirect } from "../features/account/legacyMobileRedirect";
import { getDesktopBridge } from "../services/desktop";
import { isDesktopLocalAccessView, requiresWorkspaceAccess } from "./workspaceAccess";
import { getDesktopMigrationRedirect, markDesktopMigrationShown, shouldShowDesktopMigration } from "../features/desktop/desktopMigrationGuidance";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "landing", component: { render: () => null }, meta: { mainView: "landing" satisfies MainView } },
  { path: "/best-practices", name: "best-practices", component: { render: () => null }, meta: { mainView: "best-practices" satisfies MainView } },
  { path: "/best-practices/:slug", name: "best-practice-detail", component: { render: () => null }, meta: { mainView: "best-practices" satisfies MainView } },
  { path: "/guide", name: "guide", redirect: "/download#migration" },
  { path: "/download", name: "desktop-download", component: { render: () => null }, meta: { mainView: "download" satisfies MainView } },
  { path: "/desktop-migration", name: "desktop-migration", component: { render: () => null }, meta: { mainView: "desktop-migration" satisfies MainView } },
  { path: "/contact", name: "contact", component: { render: () => null }, meta: { mainView: "contact" satisfies MainView } },
  { path: "/upgrade", name: "upgrade", component: { render: () => null }, meta: { mainView: "upgrade" satisfies MainView } },
  { path: "/data-security-commitment", name: "data-security-commitment", component: { render: () => null }, meta: { mainView: "guide" satisfies MainView } },
  { path: "/auth/login", name: "auth-login", component: { render: () => null }, meta: { mainView: "auth" satisfies MainView } },
  { path: "/h5/login", redirect: (to) => ({ path: "/auth/login", query: { redirect: router.resolve(resolveLegacyMobileRedirect(to.query)).fullPath } }) },
  { path: "/auth/register", name: "auth-register", component: { render: () => null }, meta: { mainView: "auth" satisfies MainView } },
  { path: "/auth/forgot", name: "auth-forgot", component: { render: () => null }, meta: { mainView: "auth" satisfies MainView } },
  { path: "/chat", name: "chat", component: { render: () => null }, meta: { mainView: "chat" satisfies MainView } },
  { path: "/h5", redirect: (to) => resolveLegacyMobileRedirect(to.query) },
  { path: "/office-h5/:platform(wecom|dingtalk)", redirect: (to) => resolveLegacyMobileRedirect(to.query) },
  { path: "/payment/verification", name: "payment-verification", component: { render: () => null }, meta: { mainView: "payment-verification" satisfies MainView } },
  { path: "/orchestration", redirect: "/orchestration/workspace" },
  {
    path: "/orchestration/workspace",
    name: "orchestration-workspace",
    component: { render: () => null },
    meta: { mainView: "orchestration" satisfies MainView },
  },
  {
    path: "/orchestration/assets",
    name: "orchestration-assets",
    component: { render: () => null },
    meta: { mainView: "orchestration" satisfies MainView },
  },
  {
    path: "/knowledge",
    name: "project-knowledge",
    component: { render: () => null },
    meta: { mainView: "knowledge" satisfies MainView },
  },
  { path: "/admin", name: "admin", component: { render: () => null }, meta: { mainView: "admin" satisfies MainView } },
];

if (import.meta.env.DEV) {
  routes.push({
    path: "/prototype/offline-notes-phase1",
    name: "prototype-offline-notes-phase1",
    component: { render: () => null },
    meta: { mainView: "prototype-offline-notes-phase1" satisfies MainView },
  });
}

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from) => {
  const config = useConfigStore(pinia);
  const desktop = Boolean(getDesktopBridge());
  if (desktop && to.path === "/") return { path: "/chat" };
  // Route mobile root through the existing chat login guard and return to /chat after authentication.
  if (to.path === "/" && window.innerWidth < 768) {
    return { path: "/chat" };
  }
  const view = to.meta.mainView as MainView | undefined;

  // 显式切换账号时保留登录表单，成功后由新账号会话覆盖当前会话。
  const explicitAccountSwitch = String(to.query.switchAccount ?? "") === "1";
  if (to.meta.mainView === "auth" && config.authMode === "account" && config.hasActiveSession && !explicitAccountSwitch) {
    return resolvePostLoginTarget(config.homePath || "/chat", to.query as Record<string, unknown>);
  }

  if (to.name === "desktop-migration" && (desktop || window.innerWidth < 768 || /Android|iPhone|iPad|Mobile|MicroMessenger|wxwork|DingTalk/iu.test(navigator.userAgent))) {
    return getDesktopMigrationRedirect(to.query.redirect);
  }
  if (requiresWorkspaceAccess(view) && !config.canConnectServer && !isDesktopLocalAccessView(desktop, view)) {
    return buildLoginRouteLocation(to.fullPath);
  }
  const entry = { serverOrigin: config.serverWsOrigin, userId: config.authMode === "account" && config.hasActiveSession ? config.userSummary?.userId ?? "" : "",
    desktop, mobile: window.innerWidth < 768, userAgent: navigator.userAgent, to: to.fullPath, from: from.fullPath, now: new Date() };
  try {
    // 延迟读取存储，保证后台、办公与移动入口不受浏览器存储权限影响。
    if (shouldShowDesktopMigration(entry, {
      getItem: key => window.localStorage.getItem(key),
    })) {
      markDesktopMigrationShown(entry, window.localStorage);
      trackProductEvent("desktop_migration_shown", { source: "research_entry" });
      return { path: "/desktop-migration", query: { redirect: to.fullPath } };
    }
  } catch (cause) {
    console.error("[DESKTOP_MIGRATION_STORAGE_FAILED]", { errorCode: "DESKTOP_MIGRATION_STORAGE_FAILED", requestId: `migration-entry-${Date.now()}`,
      userId: entry.userId, serverOrigin: entry.serverOrigin, rootCause: cause instanceof Error ? cause.message : String(cause) });
    // 存储不可用只跳过本次引导，不能阻断首屏挂载或后续导航。
    message.warning("无法记录桌面迁移引导，已跳过本次引导。请检查浏览器存储权限。");
  }
});

router.afterEach((to) => {
  applyPageSeo(to.path);
  const ui = useUiStore(pinia);
  const nextView = to.meta.mainView as MainView | undefined;
  if (nextView) {
    ui._syncMainView(nextView);
    ui.rememberLastAppRoute(nextView, to.fullPath);
  }
  const orchestrationEntry = resolveOrchestrationEntryFromRouteName(to.name);
  if (orchestrationEntry) ui.rememberOrchestrationEntry(orchestrationEntry);
  trackProductEvent("page_view", {
    route_name: typeof to.name === "string" ? to.name : null,
    main_view: nextView ?? null,
    path: to.path,
  });
});

export default router;
