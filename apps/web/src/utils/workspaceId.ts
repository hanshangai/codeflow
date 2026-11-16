import type { WorkspaceSummary } from "@codeflowai/shared";
import {
  isSharedWorkspaceSelectionId,
  makeSharedWorkspaceSelectionId,
  pickPreferredWorkspaceId,
  parseSharedWorkspaceSelectionId,
  resolveWorkspaceIdAlias,
  workspaceIdsContainMatch,
  workspaceIdsReferToSameWorkspace,
} from "@codeflowai/shared";

export {
  isSharedWorkspaceSelectionId,
  makeSharedWorkspaceSelectionId,
  pickPreferredWorkspaceId,
  parseSharedWorkspaceSelectionId,
  resolveWorkspaceIdAlias,
  workspaceIdsContainMatch,
  workspaceIdsReferToSameWorkspace,
};

/** 判断工作区汇总是否为共享工作区（kind/shared 标记或共享选择 ID 任一命中）。 */
export function isSharedWorkspaceSummary(workspace: WorkspaceSummary | null): boolean {
  return Boolean(workspace && (workspace.kind === "shared" || workspace.shared || isSharedWorkspaceSelectionId(workspace.id)));
}

export function resolveWorkspaceSelectionAfterRefresh(
  currentWorkspaceId: string | null | undefined,
  candidates: Iterable<string>,
  options?: { authoritativeEmpty?: boolean; authoritativeCandidates?: boolean },
): string | null {
  const normalizedCurrentWorkspaceId = String(currentWorkspaceId ?? "").trim();
  if (!normalizedCurrentWorkspaceId) return null;

  const normalizedCandidates = Array.from(candidates, (candidate) => String(candidate ?? "").trim()).filter(Boolean);
  if (!normalizedCandidates.length) {
    if (options?.authoritativeEmpty) return null;
    // refresh 期间出现瞬时空列表时，保留用户当前选择，等待后续恢复链路纠正。
    return normalizedCurrentWorkspaceId;
  }

  const resolved = resolveCurrentWorkspaceCanonicalAlias(normalizedCurrentWorkspaceId, normalizedCandidates);
  if (resolved) return resolved;
  if (options?.authoritativeCandidates && !isSharedWorkspaceSelectionId(normalizedCurrentWorkspaceId)) return null;
  return normalizedCurrentWorkspaceId;
}

/** 解析自动恢复场景下的工作区选择；默认保留已有选择，只有首选缺失且允许回退时才自动改选。 */
export function resolveStickyWorkspaceSelection(input: {
  currentWorkspaceId: string | null | undefined;
  candidates: Iterable<string>;
  onlineWorkspaceIds?: Iterable<string> | null;
  allowFallbackForMissingCurrent?: boolean;
}): string | null {
  const currentWorkspaceId = String(input.currentWorkspaceId ?? "").trim();
  const candidateIds = Array.from(input.candidates, (candidate) => String(candidate ?? "").trim()).filter(Boolean);
  const onlineWorkspaceIds = Array.from(input.onlineWorkspaceIds ?? [], (workspaceId) => String(workspaceId ?? "").trim()).filter(Boolean);
  if (currentWorkspaceId) {
    const resolvedCurrent = resolveCurrentWorkspaceCanonicalAlias(currentWorkspaceId, candidateIds);
    if (resolvedCurrent) return resolvedCurrent;
    if (onlineWorkspaceIds.length) {
      const preferredOnlineWorkspaceId = pickPreferredWorkspaceId(candidateIds, onlineWorkspaceIds, currentWorkspaceId);
      if (preferredOnlineWorkspaceId) return preferredOnlineWorkspaceId;
    }
    if (!input.allowFallbackForMissingCurrent) return currentWorkspaceId;
  }

  return pickPreferredWorkspaceId(candidateIds, onlineWorkspaceIds, currentWorkspaceId);
}

/** 判断候选 ID 是否就是当前选择，或是当前短 ID 的唯一更完整形式。 */
export function workspaceIdMatchesCurrentSelection(
  currentWorkspaceId: string | null | undefined,
  candidateWorkspaceId: string | null | undefined,
): boolean {
  const current = String(currentWorkspaceId ?? "").trim();
  const candidate = String(candidateWorkspaceId ?? "").trim();
  if (!current || !candidate) return false;
  if (current === candidate) return true;
  if (isSharedWorkspaceSelectionId(current) || isSharedWorkspaceSelectionId(candidate)) return false;
  return candidate.endsWith(`:${current}`);
}

/**
 * 判断 Web 会话已建立的订阅是否覆盖当前选中的工作区。
 * 共享工作区按共享 topic 比对（订阅侧存的是共享选择 ID，见 ws.subscribeSharedWorkspace）；
 * 本地工作区按别名链比对，兼容短 ID 与 canonical ID。
 * 未选中工作区时视为无需订阅，返回 true。
 */
export function workspaceSubscriptionMatchesSelection(
  subscribedWorkspaceId: string | null | undefined,
  selectedWorkspaceId: string | null | undefined,
): boolean {
  const selected = String(selectedWorkspaceId ?? "").trim();
  if (!selected) return true;
  const subscribed = String(subscribedWorkspaceId ?? "").trim();
  if (!subscribed) return false;
  const sharedWorkspaceId = parseSharedWorkspaceSelectionId(selected);
  if (sharedWorkspaceId) return parseSharedWorkspaceSelectionId(subscribed) === sharedWorkspaceId;
  return workspaceIdsReferToSameWorkspace(subscribed, selected);
}

/** 只把旧/短 workspaceId 纠正为更完整 ID，避免跨 client 同名本地工作区互跳。 */
function resolveCurrentWorkspaceCanonicalAlias(currentWorkspaceId: string, candidates: string[]): string | null {
  const aliasMatches = candidates.filter((candidate) => workspaceIdMatchesCurrentSelection(currentWorkspaceId, candidate));
  if (aliasMatches.length === 1) return aliasMatches[0] ?? null;
  return null;
}
