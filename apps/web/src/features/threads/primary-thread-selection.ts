import type { ThreadId } from "@codeflowai/shared";

type RouteNameLike = string | symbol | null | undefined;

const PRIMARY_THREAD_ROUTE_NAMES = new Set(["chat", "h5"]);

function normalizeRouteName(routeName: RouteNameLike): string {
  return String(routeName ?? "").trim();
}

function normalizeThreadId(threadId: ThreadId | null | undefined): string {
  return String(threadId ?? "").trim();
}

/** 判断路由是否承载主会话，包括标准会话页和账号 H5。 */
export function isPrimaryThreadRoute(routeName: RouteNameLike): boolean {
  return PRIMARY_THREAD_ROUTE_NAMES.has(normalizeRouteName(routeName));
}

/**
 * 只有在主会话路由显式切到另一条 threadId 时，才需要先清空当前主会话选择，
 * 这样 ChatPanel 才会进入“正在打开会话…”占位态，而不是短暂复用旧会话内容。
 */
export function shouldClearPrimarySelectionForThreadUrlChange(opts: {
  routeName: RouteNameLike;
  requestedThreadId: ThreadId | null;
  selectedThreadId: ThreadId | null;
}): boolean {
  if (!isPrimaryThreadRoute(opts.routeName)) return false;
  const requestedThreadId = normalizeThreadId(opts.requestedThreadId);
  if (!requestedThreadId) return false;
  return requestedThreadId !== normalizeThreadId(opts.selectedThreadId);
}

/**
 * 主会话路由没显式带 threadId 时，允许回退到当前 runtime 里仍然保留的主会话选择；
 * 但这个回退只对主会话面板生效，不会把工作台/管理页也强行绑定到某条主会话。
 */
export function resolvePrimaryThreadFallbackForRoute(opts: {
  routeName: RouteNameLike;
  selectedThreadId: ThreadId | null;
  hasSelectedThreadSummary: boolean;
}): ThreadId | null {
  if (!isPrimaryThreadRoute(opts.routeName)) return null;
  if (!opts.hasSelectedThreadSummary) return null;
  return normalizeThreadId(opts.selectedThreadId) ? opts.selectedThreadId : null;
}

/**
 * 同 workspace 内，只是路由/主视图切换，应该走轻量 thread activation，
 * 不应该重新做整轮 workspace hydration。
 */
export function shouldUseThreadOnlyActivationForRouteChange(opts: {
  previousConnected: boolean;
  previousWorkspaceId: string | null;
  workspaceId: string;
  hydrationTick: number;
  previousHydrationTick: number | null;
  previousRequestedThreadId: ThreadId | null;
  requestedThreadId: ThreadId | null;
  previousRouteName: RouteNameLike;
  routeName: RouteNameLike;
}): boolean {
  if (!opts.previousConnected) return false;
  if (opts.previousWorkspaceId !== opts.workspaceId) return false;
  if (opts.hydrationTick !== opts.previousHydrationTick) return false;
  return normalizeThreadId(opts.previousRequestedThreadId) !== normalizeThreadId(opts.requestedThreadId)
    || normalizeRouteName(opts.previousRouteName) !== normalizeRouteName(opts.routeName);
}
