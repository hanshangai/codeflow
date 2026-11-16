import type { InjectionKey } from "vue";

export type AppModals = {
  openDesktopAuth: () => void;
  openSettings: (tab?: string) => void;
  openFeedback: (source?: "user_menu" | "slash_command") => void;
  openClientUpgrade: () => void;
  openClientManagement: () => void;
  openWorkspaceManager: () => void;
  openTerminal: () => void;
  /** 使用 AppShell 的完整登出流程，确保 WebSocket 与本地状态一起清理。 */
  logout: () => Promise<void>;
  toggleTheme: () => void;
};

export const APP_MODALS_KEY: InjectionKey<AppModals> = Symbol("appModals");
