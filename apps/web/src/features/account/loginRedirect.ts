import type { OfficePlatform } from "@codeflowai/shared";
import type { RouteLocationRaw, Router } from "vue-router";
import { resolveLegacyMobileRedirect } from "./legacyMobileRedirect";

const PRESERVED_LOGIN_REDIRECT_PREFIXES = [
  "/chat",
  "/h5",
  "/admin",
  "/orchestration",
  "/knowledge",
  "/payment/verification",
];
export type LoginSurface = "standard" | "h5";

function normalizeQueryValue(value: unknown): string {
  return String(value ?? "").trim();
}

/** 识别 H5 绑定管理回跳，兼容路由允许的尾斜杠，不接受其他页面。 */
export function resolveOfficeBindingLoginPlatform(redirect: unknown): OfficePlatform | null {
  const normalized = normalizeQueryValue(redirect);
  if (!normalized.startsWith("/")) return null;
  const queryIndex = normalized.indexOf("?");
  const path = queryIndex >= 0 ? normalized.slice(0, queryIndex) : normalized;
  if (path !== "/h5" && path !== "/h5/") return null;
  const query = new URLSearchParams(queryIndex >= 0 ? normalized.slice(queryIndex + 1) : "");
  if (query.get("openOfficeBindings") !== "1") return null;
  const platform = query.get("bindPlatform");
  return platform === "wecom" || platform === "dingtalk" ? platform : null;
}

function normalizeLoginRedirectPath(fullPath: string | null | undefined): string {
  const normalized = normalizeQueryValue(fullPath);
  if (!normalized.startsWith("/") || normalized.startsWith("/auth/")) return "";
  const pathname = normalized.split(/[?#]/, 1)[0] ?? "";
  const matched = PRESERVED_LOGIN_REDIRECT_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return matched ? normalized : "";
}

function buildFullPathLocation(fullPath: string, extras?: Record<string, unknown>): RouteLocationRaw {
  const normalized = normalizeQueryValue(fullPath) || "/chat";
  const hashIndex = normalized.indexOf("#");
  const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : "";
  const pathWithSearch = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
  const questionIndex = pathWithSearch.indexOf("?");
  const path = questionIndex >= 0 ? pathWithSearch.slice(0, questionIndex) : pathWithSearch;
  const search = questionIndex >= 0 ? pathWithSearch.slice(questionIndex + 1) : "";
  const query: Record<string, string> = {};

  if (search) {
    const params = new URLSearchParams(search);
    params.forEach((value, key) => {
      if (value) query[key] = value;
    });
  }

  for (const [key, rawValue] of Object.entries(extras ?? {})) {
    const value = normalizeQueryValue(rawValue);
    if (!value) continue;
    query[key] = value;
  }

  const location: RouteLocationRaw = { path };
  if (Object.keys(query).length > 0) {
    location.query = query;
  }
  if (hash) {
    location.hash = hash;
  }
  return location;
}

/** 兼容未编码 redirect=/chat?threadId=... 被路由解析成顶层 threadId 的登录回跳。 */
function collectPostLoginRedirectExtras(
  safeRedirect: string,
  query?: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const redirectPathname = safeRedirect.split(/[?#]/, 1)[0] ?? "";
  const hasThreadIdInRedirect = new URLSearchParams(safeRedirect.split("?", 2)[1]?.split("#", 1)[0] ?? "").has("threadId");
  const topLevelThreadId = normalizeQueryValue(query?.threadId);
  if (redirectPathname === "/chat" && !hasThreadIdInRedirect && topLevelThreadId) {
    extras.threadId = topLevelThreadId;
  }
  return extras;
}

export function buildLoginRouteLocation(
  currentFullPath: string | null | undefined,
  extras?: Record<string, unknown>,
  _surface: LoginSurface = "standard",
): RouteLocationRaw {
  const query: Record<string, string> = {};
  const loginPath = "/auth/login/";
  const redirect = normalizeLoginRedirectPath(currentFullPath);
  if (redirect) {
    query.redirect = redirect;
  }

  for (const [key, rawValue] of Object.entries(extras ?? {})) {
    const value = normalizeQueryValue(rawValue);
    if (!value) continue;
    query[key] = value;
  }

  if (Object.keys(query).length === 0) {
    return { path: loginPath };
  }
  return { path: loginPath, query };
}

export function pushLoginRoute(
  router: Router,
  opts?: {
    currentFullPath?: string | null | undefined;
    extras?: Record<string, unknown>;
    replace?: boolean;
    surface?: LoginSurface;
  },
) {
  const location = buildLoginRouteLocation(
    opts?.currentFullPath ?? router.currentRoute.value.fullPath,
    opts?.extras,
    opts?.surface,
  );
  if (opts?.replace) {
    return router.replace(location);
  }
  return router.push(location);
}

/** 仅恢复允许的登录回跳，未知路径使用默认目标。 */
export function resolvePostLoginTarget(
  defaultFullPath: string,
  query?: Record<string, unknown> | null | undefined,
): RouteLocationRaw {
  const safeRedirect = normalizeLoginRedirectPath(query?.redirect as string | null | undefined);
  if (/^\/h5\/?(?:\?|#|$)/.test(safeRedirect)) {
    return resolveLegacyMobileRedirect({ redirect: safeRedirect });
  }
  const extras: Record<string, unknown> = safeRedirect
    ? collectPostLoginRedirectExtras(safeRedirect, query)
    : {};
  return buildFullPathLocation(safeRedirect || defaultFullPath, extras);
}
