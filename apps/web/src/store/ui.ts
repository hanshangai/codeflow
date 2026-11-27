import { normalizeThreadListSort, type FsSpreadsheetPreviewResponseBody, type ThreadListScope, type ThreadListSort, type WorkspaceId } from "@codeflowai/shared";
import { defineStore } from "pinia";

import { trackProductEvent } from "../analytics/analytics";
import type { OrchestrationEntry } from "../features/orchestration/orchestration-entry";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  normalizeLeftSidebarWidth,
} from "../layouts/desktop/desktop-panel-sizing";

export type MobileTabKey = "home" | "workspace" | "sessions" | "pending" | "orders" | "chat" | "debug" | "explorer";
export type MobileEntrySurface = "standard" | "h5";
export type MainView =
  | "chat"
  | "h5"
  | "orchestration"
  | "knowledge"
  | "office-h5"
  | "landing"
  | "best-practices"
  | "guide"
  | "download"
  | "desktop-migration"
  | "contact"
  | "upgrade"
  | "admin"
  | "auth"
  | "payment-verification"
  | "prototype-offline-notes-phase1";
export type ThemeMode = "light" | "dark" | "auto";
export type RightPanelMode = "inspector" | "explorer" | "terminal" | null;
export type ThreadFilterTab = ThreadListScope;
export type MobilePageType = "chat" | "thread-history" | "thread-preferences" | "debug" | "explorer-preview" | "settings" | "best-practices" | "contact" | "upgrade" | "admin";

export type MobilePageEntry = {
  type: MobilePageType;
  context?: Record<string, unknown>;
};

export type MobilePageNavigationOptions = { history?: "push" | "replace"; url?: string };

export type PreviewWindowType = "file" | "diff";

export type PreviewWindow = {
  id: string;
  workspaceId?: WorkspaceId | null;
  filePath: string;
  type: PreviewWindowType;
  previewType: "code" | "image" | "markdown" | "html" | "spreadsheet" | "pdf" | "word" | "presentation" | "binary" | "none";
  content: string | null;
  base64: string | null;
  mimeType: string | null;
  /** 编辑基线：打开时的大小、修改时间与截断/编码事实 */
  size?: number | null;
  mtimeMs?: number | null;
  truncated?: boolean | null;
  encoding?: "utf8" | "gb18030" | null;
  spreadsheet?: FsSpreadsheetPreviewResponseBody | null;
  diffOriginal: string | null;
  diffModified: string | null;
  diffStaged: boolean;
  diffVersionOld: string | null;
  diffVersionNew: string | null;
  cascadeIndex: number;
  zIndex: number;
};

export type MobileSessionsSubView = "threads";

export type UiState = {
  activeMobileTab: MobileTabKey;
  mobileSessionsSubView: MobileSessionsSubView;
  mainView: MainView;
  lastAppRoutePath: string;
  rightPanelMode: RightPanelMode;
  inspectorPanelWidth: number;
  explorerPanelWidth: number;
  terminalPanelWidth: number;
  leftSidebarWidth: number;
  leftSidebarCollapsed: boolean;
  explorerPreviewWindows: PreviewWindow[];
  threadFilterTab: ThreadFilterTab;
  threadListSort: ThreadListSort;
  lastOrchestrationEntry: OrchestrationEntry;
  themeMode: ThemeMode;
  mobilePageStack: MobilePageEntry[];
};

export type UiStore = ReturnType<typeof useUiStore>;

const MOBILE_HOME_TAB_MAIN_VIEW_SET = new Set<MainView>(["landing", "best-practices", "guide", "contact", "upgrade"]);
const MOBILE_APP_TAB_MAIN_VIEW_SET = new Set<MainView>(["chat", "h5", "office-h5"]);
const APP_MAIN_VIEW_SET = new Set<MainView>(["chat", "orchestration", "knowledge", "admin", "payment-verification"]);
const DEDICATED_H5_ENTRY_PREFIXES = ["/h5", "/office-h5"] as const;
export const INSPECTOR_PANEL_MIN_WIDTH = 280;
/** 拖拽写入与持久化收敛用的文件面板最小宽度；必须与 desktop-panel-sizing 的 RIGHT_PANEL_MIN_WIDTH.explorer 同值，否则拖到下限会被弹回。 */
export const EXPLORER_PANEL_MIN_WIDTH = 300;
export const TERMINAL_PANEL_MIN_WIDTH = 480;
const RIGHT_PANEL_MAX_WIDTH = 700;

const uiStorageErrorKeys = new Set<string>();

function reportUiStorageError(operation: string, error: unknown): void {
  const errorCode = error instanceof DOMException && error.name ? `UI_STORAGE_${error.name.toUpperCase()}` : "UI_STORAGE_ERROR";
  const key = `${operation}:${errorCode}`;
  if (uiStorageErrorKeys.has(key)) return;
  uiStorageErrorKeys.add(key);
  console.error("[ui-storage]", {
    errorCode,
    requestId: null,
    storageKey: "ui",
    operation,
    rootCause: error instanceof Error ? error.message.slice(0, 160) : "unknown storage failure",
  });
}

const memoryUiStorage = new Map<string, string>();
export const safeUiStorage = {
  getItem(key: string): string | null {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem(key) : memoryUiStorage.get(key) ?? null;
    } catch (error) {
      reportUiStorageError("getItem", error);
      return memoryUiStorage.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memoryUiStorage.set(key, value);
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(key, value);
    } catch (error) {
      reportUiStorageError("setItem", error);
    }
  },
  removeItem(key: string): void {
    memoryUiStorage.delete(key);
    try {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
    } catch (error) {
      reportUiStorageError("removeItem", error);
    }
  },
};

export function resolveMobileTabForMainView(mainView: MainView, currentTab: MobileTabKey): MobileTabKey {
  // `/`（landing）同时承载移动端工作台：用户已切到的会话/待办 Tab 不能被归一回首页，
  // 否则进入会话页后 watcher 会把 Tab 打回首页，表现为“点一次进不去、返回跳首页”。
  if (mainView === "landing" && currentTab !== "home") return currentTab;
  if (MOBILE_HOME_TAB_MAIN_VIEW_SET.has(mainView)) return "home";
  if (MOBILE_APP_TAB_MAIN_VIEW_SET.has(mainView) && (currentTab === "home" || currentTab === "pending")) return "sessions";
  return currentTab;
}

/** 待办整合到会话分类；移动 Web 继承订单等原 H5 导航。 */
export function resolveMobileTabForEntrySurface(surface: MobileEntrySurface, currentTab: MobileTabKey): MobileTabKey {
  if (surface === "standard" && currentTab === "pending") return "sessions";
  if (surface === "h5" && (currentTab === "home" || currentTab === "pending")) return "sessions";
  return currentTab;
}

/** Filters dedicated H5 routes out of the standard Web application entry. */
function normalizeStandardApplicationEntryPath(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return "";
  const pathname = normalized.split(/[?#]/, 1)[0] ?? "";
  const dedicatedH5Entry = DEDICATED_H5_ENTRY_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(prefix + "/")
  ));
  return dedicatedH5Entry ? "" : normalized;
}

/** Resolves the normal Web entry without resuming a dedicated H5 surface. */
export function resolveStandardApplicationEntryPath(input: {
  lastAppRoutePath?: string | null;
  homePath?: string | null;
}): string {
  return normalizeStandardApplicationEntryPath(input.lastAppRoutePath)
    || normalizeStandardApplicationEntryPath(input.homePath)
    || "/chat";
}

type RouteNameLike = string | symbol | null | undefined;

/** Allows mobile admin panel URL synchronization only on the admin route. */
export function shouldSyncMobileAdminPanelRoute(routeName: RouteNameLike): boolean {
  return String(routeName ?? "").trim() === "admin";
}

/** 判断普通移动端或 H5 是否需要从 threadId 深链恢复聊天页面栈。 */
export function shouldRestoreMobileChatPageForThreadRoute(opts: {
  routeName: RouteNameLike;
  requestedThreadId: string | null | undefined;
  currentPageType: MobilePageType | null | undefined;
  entrySurface?: MobileEntrySurface;
}): boolean {
  const expectedRouteName = opts.entrySurface === "h5" ? "h5" : "chat";
  if (String(opts.routeName ?? "").trim() !== expectedRouteName) return false;
  if (!String(opts.requestedThreadId ?? "").trim()) return false;
  return opts.currentPageType == null;
}

export const useUiStore = defineStore("ui", {
  state: (): UiState => ({
    activeMobileTab: "home",
    mobileSessionsSubView: "threads",
    mainView: "landing",
    lastAppRoutePath: "",
    rightPanelMode: "explorer",
    inspectorPanelWidth: 400,
    explorerPanelWidth: 400,
    terminalPanelWidth: 560,
    leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
    leftSidebarCollapsed: false,
    explorerPreviewWindows: [],
    threadFilterTab: "current",
    threadListSort: "activity_desc",
    lastOrchestrationEntry: "workspace",
    themeMode: "auto",
    mobilePageStack: [],
  }),
  persist: {
    storage: safeUiStorage,
    pick: [
      "activeMobileTab",
      "mobileSessionsSubView",
      "lastAppRoutePath",
      "rightPanelMode",
      "inspectorPanelWidth",
      "explorerPanelWidth",
      "terminalPanelWidth",
      "leftSidebarWidth",
      "leftSidebarCollapsed",
      "threadFilterTab",
      "threadListSort",
      "lastOrchestrationEntry",
      "themeMode",
    ],
  },
  getters: {
    /** 兼容现有消息详情展示逻辑，真相源仅为 rightPanelMode。 */
    inspectorVisible(): boolean {
      return this.rightPanelMode === "inspector";
    },
    /** 兼容现有文件入口展示逻辑，真相源仅为 rightPanelMode。 */
    explorerPanelVisible(): boolean {
      return this.rightPanelMode === "explorer";
    },
    currentMobilePage(): MobilePageEntry | null {
      const stack = this.mobilePageStack;
      return stack.length > 0 ? stack[stack.length - 1] : null;
    },
  },
  actions: {
    setActiveMobileTab(tab: MobileTabKey) {
      this.activeMobileTab = tab;
      trackProductEvent("mobile_tab_select", {
        mobile_tab: tab,
      });
    },
    setMobileSessionsSubView(view: MobileSessionsSubView) {
      this.mobileSessionsSubView = view;
      trackProductEvent("mobile_sessions_view_select", {
        sessions_view: view,
      });
    },
    pushMobilePage(entry: MobilePageEntry, _navigation?: MobilePageNavigationOptions) {
      this.mobilePageStack.push(entry);
      trackProductEvent("mobile_page_open", {
        page_type: entry.type,
        settings_tab: typeof entry.context?.tab === "string" ? entry.context.tab : null,
      });
    },
    popMobilePage() {
      this.mobilePageStack.pop();
    },
    clearMobilePages() {
      this.mobilePageStack = [];
    },
    _syncMainView(view: MainView) {
      this.mainView = view;
    },
    /** 仅记录应用主功能页路径，用于从首页返回时恢复原来的一级 Tab。 */
    rememberLastAppRoute(view: MainView, fullPath: string) {
      if (!APP_MAIN_VIEW_SET.has(view)) return;
      const normalized = String(fullPath ?? "").trim();
      if (!normalized.startsWith("/")) return;
      this.lastAppRoutePath = normalized;
    },
    /** 打开指定右侧面板；所有入口共用这一状态切换入口。 */
    openRightPanel(mode: Exclude<RightPanelMode, null>) {
      this.rightPanelMode = mode;
    },
    /** 再次点击当前面板时关闭，否则切换到目标面板。 */
    toggleRightPanel(mode: Exclude<RightPanelMode, null>) {
      this.rightPanelMode = this.rightPanelMode === mode ? null : mode;
      trackProductEvent("workbench_panel_toggle", {
        panel: mode,
        visible: this.rightPanelMode === mode,
      });
    },
    /** 关闭右侧面板，不影响面板承载的业务运行态。 */
    closeRightPanel() {
      this.rightPanelMode = null;
    },
    /** 分别保存各右侧面板宽度，避免切换内容时互相覆盖。 */
    setRightPanelWidth(mode: Exclude<RightPanelMode, null>, width: number) {
      const minWidth = mode === "terminal"
        ? TERMINAL_PANEL_MIN_WIDTH
        : mode === "explorer"
          ? EXPLORER_PANEL_MIN_WIDTH
          : INSPECTOR_PANEL_MIN_WIDTH;
      const normalized = Math.round(Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(minWidth, width)));
      if (mode === "terminal") this.terminalPanelWidth = normalized;
      else if (mode === "explorer") this.explorerPanelWidth = normalized;
      else this.inspectorPanelWidth = normalized;
    },
    setLeftSidebarWidth(width: number) {
      this.leftSidebarWidth = normalizeLeftSidebarWidth(width);
    },
    setLeftSidebarCollapsed(collapsed: boolean) {
      this.leftSidebarCollapsed = collapsed === true;
      trackProductEvent("workbench_left_sidebar_toggle", {
        collapsed: this.leftSidebarCollapsed,
      });
    },
    toggleLeftSidebar() {
      this.setLeftSidebarCollapsed(!this.leftSidebarCollapsed);
    },
    toggleInspector() {
      this.toggleRightPanel("inspector");
    },
    toggleExplorerPanel() {
      this.toggleRightPanel("explorer");
    },
    openPreviewWindow(win: PreviewWindow) {
      const maxZ = this.explorerPreviewWindows.reduce((m, w) => Math.max(m, w.zIndex), 0);
      win.zIndex = maxZ + 1;
      this.explorerPreviewWindows.push(win);
      trackProductEvent("file_preview_open", {
        preview_type: win.previewType,
        window_type: win.type,
        has_workspace: Boolean(win.workspaceId),
      });
    },
    closePreviewWindow(id: string) {
      this.explorerPreviewWindows = this.explorerPreviewWindows.filter((w) => w.id !== id);
    },
    closeAllPreviewWindows() {
      this.explorerPreviewWindows = [];
    },
    bringPreviewWindowToFront(id: string) {
      const maxZ = this.explorerPreviewWindows.reduce((m, w) => Math.max(m, w.zIndex), 0);
      const win = this.explorerPreviewWindows.find((w) => w.id === id);
      if (win && win.zIndex < maxZ) {
        win.zIndex = maxZ + 1;
      }
    },
    setThreadFilterTab(tab: ThreadFilterTab) {
      this.threadFilterTab = tab;
      trackProductEvent("thread_filter_select", {
        filter_tab: tab,
      });
    },
    /** 设置会话列表排序；非法历史值回落到最近活动倒序。 */
    setThreadListSort(sort: ThreadListSort) {
      this.threadListSort = normalizeThreadListSort(sort, "activity_desc");
      trackProductEvent("thread_sort_select", {
        sort: this.threadListSort,
      });
    },
    rememberOrchestrationEntry(entry: OrchestrationEntry) {
      this.lastOrchestrationEntry = entry;
    },
    setThemeMode(mode: ThemeMode) {
      this.themeMode = mode;
      trackProductEvent("theme_change", {
        theme_mode: this.themeMode,
      });
    },
    toggleThemeMode() {
      const modes: ThemeMode[] = ["light", "dark", "auto"];
      const currentIndex = modes.indexOf(this.themeMode);
      this.themeMode = modes[(currentIndex + 1) % modes.length];
      trackProductEvent("theme_change", {
        theme_mode: this.themeMode,
        source: "toggle",
      });
    },
  },
});

/** 在 Pinia 恢复前把旧布尔面板状态迁移为单一模式和独立宽度。 */
export function migrateUiRightPanelState(storage: Pick<Storage, "getItem" | "setItem"> | null = safeUiStorage): void {
  if (!storage) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem("ui");
  } catch (error) {
    reportUiStorageError("getItem", error);
  }
  // First install has no persisted UI record; leave Pinia's declared defaults intact.
  if (!raw) return;
  let persisted: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        persisted = parsed as Record<string, unknown>;
      } else {
        reportUiStorageError("parse", new Error("persisted UI state must be an object"));
        persisted = {};
      }
    } catch (error) {
      reportUiStorageError("parse", error);
    }
  }
  const legacyWidth = Number(persisted.inspectorWidth ?? 400);
  const normalizedLegacyWidth = Number.isFinite(legacyWidth) ? legacyWidth : 400;
  const validModes: RightPanelMode[] = ["inspector", "explorer", "terminal", null];
  persisted.rightPanelMode = validModes.includes(persisted.rightPanelMode as RightPanelMode)
    ? persisted.rightPanelMode
    : persisted.inspectorVisible === true
      ? "inspector"
      : persisted.explorerPanelVisible === true
        ? "explorer"
        : null;
  persisted.inspectorPanelWidth = normalizePersistedPanelWidth(persisted.inspectorPanelWidth, normalizedLegacyWidth, INSPECTOR_PANEL_MIN_WIDTH);
  persisted.explorerPanelWidth = normalizePersistedPanelWidth(persisted.explorerPanelWidth, normalizedLegacyWidth, EXPLORER_PANEL_MIN_WIDTH);
  persisted.terminalPanelWidth = normalizePersistedPanelWidth(persisted.terminalPanelWidth, 560, TERMINAL_PANEL_MIN_WIDTH);
  persisted.leftSidebarWidth = normalizeLeftSidebarWidth(persisted.leftSidebarWidth);
  persisted.leftSidebarCollapsed = persisted.leftSidebarCollapsed === true;
  delete persisted.inspectorVisible;
  delete persisted.explorerPanelVisible;
  delete persisted.inspectorWidth;
  try {
    storage.setItem("ui", JSON.stringify(persisted));
  } catch (error) {
    reportUiStorageError("setItem", error);
  }
}

/** 归一化迁移宽度，防止历史异常值撑破布局。 */
function normalizePanelWidth(width: number, minWidth: number): number {
  return Math.round(Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(minWidth, width)));
}

/** 将持久化宽度转换为有效数字，非法值回到对应面板默认宽度。 */
function normalizePersistedPanelWidth(value: unknown, fallback: number, minWidth: number): number {
  const parsed = Number(value);
  return normalizePanelWidth(Number.isFinite(parsed) ? parsed : fallback, minWidth);
}
