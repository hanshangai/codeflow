import type { RouteLocationRaw } from "vue-router";

const TARGET_KEYS = ["workspaceId", "threadId", "tab", "targetId"] as const;

/** Retire office OAuth URLs while preserving only same-site Web business targets. */
export function resolveLegacyMobileRedirect(query: Record<string, unknown>): RouteLocationRaw {
  const first = (value: unknown) => String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
  const redirect = first(query.redirect);
  const target = new URL("/chat", "https://codeflow.invalid");
  if (/^\/(?:h5|chat)\/?(?:\?|#|$)/.test(redirect) && !redirect.includes("\\")) {
    const nested = new URL(redirect, target.origin);
    for (const key of TARGET_KEYS) {
      const value = nested.searchParams.get(key);
      if (value) target.searchParams.set(key, value);
    }
  }
  for (const key of TARGET_KEYS) {
    const value = first(query[key]);
    if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return { path: "/chat", query: Object.fromEntries(target.searchParams) };
}
