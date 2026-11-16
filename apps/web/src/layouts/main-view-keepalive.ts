import type { MainView } from "../store/ui";

export const DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEWS = ["chat", "orchestration", "admin"] as const;
export const DESKTOP_TABLET_KEPT_ALIVE_COMPONENT_NAMES = [
  "ChatPanel",
  "OrchestrationLayout",
  "AdminLayout",
] as const;
export const DESKTOP_TABLET_KEPT_ALIVE_INCLUDE: string[] = [...DESKTOP_TABLET_KEPT_ALIVE_COMPONENT_NAMES];

export type DesktopTabletKeptAliveMainView = (typeof DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEWS)[number];
export type DesktopTabletPrimaryPane = "chat" | "orchestration";

const DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEW_SET = new Set<MainView>(DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEWS);

export function isDesktopTabletMainViewKeptAlive(mainView: MainView): mainView is DesktopTabletKeptAliveMainView {
  return DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEW_SET.has(mainView);
}

/**
 * desktop/tablet 主区只有会话面板和工作台两个 pane。
 * admin 会整页覆盖，但下层仍保留最近的主 pane；当前设计保持 chat 作为稳定回落值。
 */
export function resolveDesktopTabletPrimaryPane(mainView: MainView): DesktopTabletPrimaryPane {
  return mainView === "orchestration" ? "orchestration" : "chat";
}

/** 无工作区时只有会话保留整块空态；编排模块仍挂载，由自身渲染只读预览。 */
export function shouldRenderEmptyWorkspacePane(input: {
  hasWorkspace: boolean;
  primaryPane: DesktopTabletPrimaryPane;
}): boolean {
  return !input.hasWorkspace && input.primaryPane === "chat";
}
