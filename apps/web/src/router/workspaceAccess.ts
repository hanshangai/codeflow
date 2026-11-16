import type { MainView } from "../store/ui";

const WORKSPACE_ACCESS_VIEWS = new Set<MainView>([
  "chat",
  "orchestration",
  "knowledge",
  "admin",
  "payment-verification",
  "desktop-migration",
]);

/** 桌面未登录仍可使用的纯本机视图；共享与支付类视图仍需 Server 或账号。 */
const DESKTOP_LOCAL_ACCESS_VIEWS = new Set<MainView>([
  "chat",
  "orchestration",
  "knowledge",
  "admin",
]);

/** 该视图是否需要工作区访问权限（浏览器未登录时据此跳转登录）。 */
export function requiresWorkspaceAccess(view: MainView | undefined): boolean {
  return Boolean(view && WORKSPACE_ACCESS_VIEWS.has(view));
}

/** 桌面本地工作区在未登录时可放行的视图；非桌面一律 false。 */
export function isDesktopLocalAccessView(desktop: boolean, view: MainView | undefined): boolean {
  return desktop && Boolean(view && DESKTOP_LOCAL_ACCESS_VIEWS.has(view));
}
