import type { OnlineClientInfo } from "@codeflowai/shared";

export function collectPresenceWorkspaceIds(clients: Array<Pick<OnlineClientInfo, "workspaceIds">>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const client of clients) {
    for (const workspaceId of Array.isArray(client.workspaceIds) ? client.workspaceIds : []) {
      const normalized = String(workspaceId ?? "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  ids.sort();
  return ids;
}

export function shouldRefreshWorkspacesForPresence(input: {
  loading: boolean;
  lastLoadedAt: number;
  knownWorkspaceIds: Iterable<string>;
  onlineClients: Array<Pick<OnlineClientInfo, "workspaceIds">>;
}): { shouldRefresh: boolean; reason: "loading" | "no-online-workspaces" | "baseline-missing" | "workspace-set-changed" | "unchanged" } {
  // presence 负责告诉我们“哪些 client / workspace 当前在线”，
  // 只有当这个在线 workspace 并集与当前 baseline 不一致时，才值得重拉 /api/workspaces。
  if (input.loading) {
    return { shouldRefresh: false, reason: "loading" };
  }

  const onlineWorkspaceIds = collectPresenceWorkspaceIds(input.onlineClients);
  if (!onlineWorkspaceIds.length) {
    return { shouldRefresh: false, reason: "no-online-workspaces" };
  }

  if (!(Number(input.lastLoadedAt) > 0)) {
    return { shouldRefresh: true, reason: "baseline-missing" };
  }

  const knownWorkspaceIds = Array.from(input.knownWorkspaceIds, (workspaceId) => String(workspaceId ?? "").trim())
    .filter(Boolean)
    .sort();

  if (knownWorkspaceIds.length !== onlineWorkspaceIds.length) {
    return { shouldRefresh: true, reason: "workspace-set-changed" };
  }

  for (let index = 0; index < onlineWorkspaceIds.length; index += 1) {
    if (onlineWorkspaceIds[index] !== knownWorkspaceIds[index]) {
      return { shouldRefresh: true, reason: "workspace-set-changed" };
    }
  }

  return { shouldRefresh: false, reason: "unchanged" };
}
