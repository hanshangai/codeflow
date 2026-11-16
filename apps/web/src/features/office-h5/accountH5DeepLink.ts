export type AccountH5DeepLinkTab = "sessions" | "pending";

export type AccountH5DeepLink = {
  workspaceId: string;
  tab: AccountH5DeepLinkTab;
  threadId: string;
  targetId: string;
};

const MAX_WORKSPACE_ID_LENGTH = 512;
const MAX_TARGET_ID_LENGTH = 256;

/** 从 Vue Router 查询值中提取第一个非空字符串。 */
function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return typeof value === "string" ? value.trim() : "";
}

/** 过滤控制字符和异常长度，避免外部通知参数进入业务状态。 */
function normalizeDeepLinkIdentifier(value: unknown, maxLength: number): string {
  const normalized = firstQueryValue(value);
  if (!normalized || normalized.length > maxLength) return "";
  return /[\u0000-\u001f\u007f]/.test(normalized) ? "" : normalized;
}

/** 解析账号 H5 通知深链，并把无效参数归一为安全默认入口。 */
export function resolveAccountH5DeepLink(query: Record<string, unknown>): AccountH5DeepLink {
  const workspaceId = normalizeDeepLinkIdentifier(query.workspaceId, MAX_WORKSPACE_ID_LENGTH);
  const threadId = normalizeDeepLinkIdentifier(query.threadId, MAX_TARGET_ID_LENGTH);
  const targetId = normalizeDeepLinkIdentifier(query.targetId, MAX_TARGET_ID_LENGTH);
  const requestedTab = firstQueryValue(query.tab);
  const tab: AccountH5DeepLinkTab = threadId
    ? "sessions"
    : requestedTab === "pending"
      ? "pending"
      : requestedTab === "sessions"
        ? "sessions"
        : targetId
          ? "pending"
          : "sessions";
  return { workspaceId, tab, threadId, targetId };
}