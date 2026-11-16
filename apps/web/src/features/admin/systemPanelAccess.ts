import type { AccountRole } from "@codeflowai/shared";

import type { AdminPanel } from "../../store/admin";
import { wsOriginToHttpOrigin } from "../../api/request";

export type SystemScope = "super_admin" | "enterprise_admin" | "enterprise_member" | "personal_user";
export type SystemPanelGroup = "settings" | "enterprise" | "platform" | "analytics";

export type SystemPanelMeta = {
  key: AdminPanel;
  label: string;
  group: SystemPanelGroup;
};

export type SystemPanelAvailability = {
  relayManagementEnabled?: boolean;
};

/** 桌面未登录时仍由本机数据驱动的面板，其余面板需要 Server 账号数据。 */
export const LOCAL_DESKTOP_PANELS = ["settings", "workspaces", "engine-keys", "scheduled-tasks"] as const;

/** 面板是否属于桌面本机能力范围。 */
export function isLocalDesktopPanel(panel: AdminPanel): boolean {
  return (LOCAL_DESKTOP_PANELS as readonly AdminPanel[]).includes(panel);
}

/** 未登录也可查看的面板：本机数据驱动，或走公开接口只读展示。 */
export const PUBLIC_PANELS = [...LOCAL_DESKTOP_PANELS, "relay-price-config"] as const;

/** 面板是否无需账号会话即可展示。 */
export function isPublicPanel(panel: AdminPanel): boolean {
  return (PUBLIC_PANELS as readonly AdminPanel[]).includes(panel);
}

const PANEL_META: Partial<Record<AdminPanel, SystemPanelMeta>> = {
  settings: { key: "settings", label: "基础设置", group: "settings" },
  workspaces: { key: "workspaces", label: "工作区", group: "settings" },
  "engine-keys": { key: "engine-keys", label: "模型配置", group: "settings" },
  "scheduled-tasks": { key: "scheduled-tasks", label: "定时任务", group: "settings" },
  "relay-self-usage": { key: "relay-self-usage", label: "流量统计", group: "settings" },
  "message-notifications": { key: "message-notifications", label: "待办通知", group: "settings" },
  "orchestration-metrics": { key: "orchestration-metrics", label: "编排度量", group: "settings" },
  sessions: { key: "sessions", label: "会话管理", group: "enterprise" },
  packages: { key: "packages", label: "已购套餐", group: "platform" },
  "payment-orders": { key: "payment-orders", label: "支付订单", group: "platform" },
  "relay-price-config": { key: "relay-price-config", label: "模型价格", group: "settings" },
  "enterprise-member-management": { key: "enterprise-member-management", label: "企业成员", group: "enterprise" },
  "enterprise-token": { key: "enterprise-token", label: "企业流量", group: "enterprise" },
  "shared-workspaces": { key: "shared-workspaces", label: "共享空间", group: "enterprise" },
  "enterprise-audit": { key: "enterprise-audit", label: "操作审计", group: "enterprise" },
};

const PANELS_BY_SCOPE: Record<Exclude<SystemScope, "super_admin">, AdminPanel[]> = {
  enterprise_admin: ["settings", "workspaces", "engine-keys", "relay-self-usage", "relay-price-config", "message-notifications", "scheduled-tasks", "orchestration-metrics", "enterprise-member-management", "enterprise-token", "shared-workspaces", "sessions", "packages", "payment-orders", "enterprise-audit"],
  enterprise_member: ["settings", "workspaces", "engine-keys", "relay-self-usage", "relay-price-config", "message-notifications", "scheduled-tasks", "orchestration-metrics", "shared-workspaces", "payment-orders"],
  personal_user: ["settings", "workspaces", "engine-keys", "relay-self-usage", "relay-price-config", "message-notifications", "scheduled-tasks", "orchestration-metrics", "payment-orders"],
};

const BASE_SYSTEM_GROUP_LABELS: Record<SystemPanelGroup, string> = {
  settings: "基础设置",
  enterprise: "企业管理",
  platform: "平台管理",
  analytics: "系统运营",
};

/** Resolve the label for the current official account scope. */
export function resolveSystemGroupLabel(scope: SystemScope, group: SystemPanelGroup): string {
  if (group === "platform") {
    return "订单信息";
  }
  return BASE_SYSTEM_GROUP_LABELS[group];
}

export function resolveSystemGroupLabels(scope: SystemScope): Record<SystemPanelGroup, string> {
  return {
    settings: resolveSystemGroupLabel(scope, "settings"),
    enterprise: resolveSystemGroupLabel(scope, "enterprise"),
    platform: resolveSystemGroupLabel(scope, "platform"),
    analytics: resolveSystemGroupLabel(scope, "analytics"),
  };
}

export function resolveSystemScope(input: {
  accountRole: AccountRole | null;
  enterpriseId: string | null | undefined;
}): SystemScope {
  if (input.accountRole === "super_admin") return "super_admin";
  if (input.accountRole === "enterprise_admin" && input.enterpriseId) return "enterprise_admin";
  if (input.enterpriseId) return "enterprise_member";
  return "personal_user";
}

/** 按账号范围和功能开关返回可见系统面板。 */
export function resolveAllowedSystemPanels(scope: SystemScope, availability: SystemPanelAvailability = {}): AdminPanel[] {
  return [...PANELS_BY_SCOPE[scope === "super_admin" ? "personal_user" : scope]];
}

/** 仅保留旧管理深链标识；企业及个人面板继续使用公开实现。 */
const MIGRATED_ADMIN_PANELS = [
  "account-settings", "feedback", "contact-info", "dashboard", "desktop-crash-reports", "tls-certificates", "email",
  "user-management", "payment-management", "redemption-codes", "invitations", "invoice-management", "relay-config",
  "relay-recharge-pricing", "relay-management", "relay-mapping", "best-practices", "in-app-notices", "wechat-official-account",
  "audit", "client-db-devices", "sessions", "enterprise-member-management", "enterprise-token", "enterprise-audit", "packages", "shared-workspaces",
] as const;

/** 只对超管显式访问已迁出的旧管理面板显示控制台入口。 */
export function isMigratedAdminPanel(scope: SystemScope, panel: unknown): boolean {
  const key = Array.isArray(panel) ? panel[0] : panel;
  return scope === "super_admin" && typeof key === "string" && (MIGRATED_ADMIN_PANELS as readonly string[]).includes(key);
}

/** 桌面和浏览器都使用当前 Server 的固定控制台路径，丢弃查询与令牌。 */
export function resolveAdminConsoleUrl(serverWsOrigin: string): string {
  return new URL("/console/", wsOriginToHttpOrigin(serverWsOrigin)).toString();
}

/**
 * 返回菜单展示所需元数据，过滤规则与 activePanel 兜底保持同源。
 * 设置菜单不展示独立度量入口；顶栏度量入口仍按原路由进入。
 */
export function resolveAvailableSystemPanels(
  scope: SystemScope,
  availability: SystemPanelAvailability = {},
): SystemPanelMeta[] {
  return resolveAllowedSystemPanels(scope, availability)
    .filter((panel) => panel !== "orchestration-metrics" && panel !== "client-db-devices")
    .map((panel) => PANEL_META[panel]!);
}

/** 旧面板 key 到新 key 的兼容别名；按候选顺序取第一个对当前范围可见的 key。 */
type LegacySystemPanel = "office-h5";

const LEGACY_SYSTEM_PANEL_ALIASES: Partial<Record<AdminPanel | LegacySystemPanel, AdminPanel>> = {
  "office-h5": "message-notifications",
  "invoice-management": "payment-management",
  "payment-orders": "payment-management",
};

/**
 * 解析 URL 中的面板 key：优先取别名，别名不在当前可见列表时回落到原 key。
 * 返回 null 表示该 key 对当前范围不可见，调用方应走默认面板兜底。
 */
export function resolveRouteSystemPanel(panel: AdminPanel | LegacySystemPanel, allowedPanels: readonly AdminPanel[]): AdminPanel | null {
  const alias = LEGACY_SYSTEM_PANEL_ALIASES[panel];
  if (alias && allowedPanels.includes(alias)) return alias;
  return panel !== "office-h5" && allowedPanels.includes(panel) ? panel : null;
}

/**
 * 省缺面板参数时的兜底：有会话沿用上次菜单 → 当前面板 → 首个菜单；
 * 无会话只落到可见且本机可用的面板，避免进入服务端面板触发账号请求。
 */
export function resolveFallbackSystemPanel(input: {
  menuPanels: readonly AdminPanel[];
  allowedPanels: readonly AdminPanel[];
  lastMenuPanel: AdminPanel;
  activePanel: AdminPanel;
  hasServerSession: boolean;
}): AdminPanel {
  const isVisible = (panel: AdminPanel) => input.menuPanels.includes(panel);
  if (input.hasServerSession) {
    if (isVisible(input.lastMenuPanel)) return input.lastMenuPanel;
    if (isVisible(input.activePanel)) return input.activePanel;
    return input.menuPanels[0] ?? input.allowedPanels[0]!;
  }
  if (isVisible(input.lastMenuPanel) && isLocalDesktopPanel(input.lastMenuPanel)) return input.lastMenuPanel;
  return input.menuPanels.find(isLocalDesktopPanel) ?? input.menuPanels[0] ?? input.allowedPanels[0]!;
}
