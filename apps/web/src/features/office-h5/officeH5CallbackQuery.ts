import type { LocationQueryRaw } from "vue-router";

const CALLBACK_QUERY_KEYS = ["code", "authCode", "auth_code", "state"] as const;

type CallbackQueryKey = (typeof CALLBACK_QUERY_KEYS)[number];

function isCallbackQueryKey(key: string): key is CallbackQueryKey {
  return (CALLBACK_QUERY_KEYS as readonly string[]).includes(key);
}

/** 判断路由是否仍携带办公 H5 的一次性授权参数。 */
export function hasOfficeH5CallbackQuery(query: Record<string, unknown> | LocationQueryRaw | null | undefined): boolean {
  if (!query) return false;
  return Object.keys(query).some((key) => isCallbackQueryKey(key));
}

/** 清除办公 H5 回调的一次性参数，保留 corpId、redirect 和业务查询参数。 */
export function stripOfficeH5CallbackQuery(query: Record<string, unknown> | LocationQueryRaw | null | undefined): LocationQueryRaw {
  const cleaned: LocationQueryRaw = {};
  if (!query) return cleaned;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (isCallbackQueryKey(key)) continue;
    cleaned[key] = value as LocationQueryRaw[string];
  }
  return cleaned;
}
