function trimWorkspaceId(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

const SHARED_WORKSPACE_SELECTION_PREFIX = "shared:";
const DERIVED_WORKSPACE_ID_HASH_LENGTH = 10;

export type SharedWorkspaceSelectionId = `shared:${string}`;

export function makeSharedWorkspaceSelectionId(sharedWorkspaceId: string): SharedWorkspaceSelectionId {
  return `${SHARED_WORKSPACE_SELECTION_PREFIX}${trimWorkspaceId(sharedWorkspaceId)}`;
}

export function isSharedWorkspaceSelectionId(value: string | null | undefined): value is SharedWorkspaceSelectionId {
  const trimmed = trimWorkspaceId(value);
  return trimmed.startsWith(SHARED_WORKSPACE_SELECTION_PREFIX) && trimmed.length > SHARED_WORKSPACE_SELECTION_PREFIX.length;
}

export function parseSharedWorkspaceSelectionId(value: string | null | undefined): string | null {
  if (!isSharedWorkspaceSelectionId(value)) return null;
  return trimWorkspaceId(value).slice(SHARED_WORKSPACE_SELECTION_PREFIX.length).trim() || null;
}

/** 生成本地 workspaceId 的历史别名链，用于兼容旧前缀和嵌套前缀。 */
export function workspaceIdAliasChain(value: string | null | undefined): string[] {
  const trimmed = trimWorkspaceId(value);
  if (!trimmed) return [];
  if (isSharedWorkspaceSelectionId(trimmed)) return [trimmed];

  const aliases: string[] = [];
  const seen = new Set<string>();
  let current = trimmed;
  while (current && !seen.has(current)) {
    aliases.push(current);
    seen.add(current);
    const colonIndex = current.indexOf(":");
    if (colonIndex <= 0 || colonIndex === current.length - 1) break;
    current = current.slice(colonIndex + 1).trim();
  }
  return aliases;
}

/** 判断本地 workspaceId 是否已经带有 client 命名空间前缀。 */
export function isNamespacedLocalWorkspaceId(value: string | null | undefined): boolean {
  const trimmed = trimWorkspaceId(value);
  if (!trimmed || isSharedWorkspaceSelectionId(trimmed)) return false;
  const colonIndex = trimmed.indexOf(":");
  return colonIndex > 0 && colonIndex < trimmed.length - 1;
}

/** 只给真正旧格式的本地 workspaceId 加 clientId 前缀，已命名空间化的 ID 保持原样。 */
export function prefixLocalWorkspaceId(clientId: string | null | undefined, workspaceId: string | null | undefined): string {
  const normalizedWorkspaceId = trimWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) return "";
  if (isSharedWorkspaceSelectionId(normalizedWorkspaceId) || isNamespacedLocalWorkspaceId(normalizedWorkspaceId)) return normalizedWorkspaceId;
  const normalizedClientId = trimWorkspaceId(clientId);
  if (!normalizedClientId) throw new Error("clientId 不能为空");
  return `${normalizedClientId}:${normalizedWorkspaceId}`;
}

/** 归一化路径派生 workspaceId 的输入；哈希由运行端按 SHA-256 计算。 */
export function normalizeWorkspacePathForDerivedId(workspacePath: string | null | undefined): string {
  return String(workspacePath ?? "").trim().replace(/[\\/]+$/g, "").toLowerCase();
}

/** 根据路径哈希生成稳定 workspaceId，供 Server/Client 共享同一包装口径。 */
export function makeWorkspaceIdFromPathDigest(digestHex: string | null | undefined): string {
  const digest = String(digestHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(digest) || digest.length < DERIVED_WORKSPACE_ID_HASH_LENGTH) {
    throw new Error("workspace path digest must contain at least 10 hex chars");
  }
  return `ws_${digest.slice(0, DERIVED_WORKSPACE_ID_HASH_LENGTH)}`;
}

export function workspaceIdsReferToSameWorkspace(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftId = trimWorkspaceId(left);
  const rightId = trimWorkspaceId(right);
  if (!leftId || !rightId) return false;
  if (leftId === rightId) return true;
  if (isSharedWorkspaceSelectionId(leftId) || isSharedWorkspaceSelectionId(rightId)) return false;

  const rightAliases = new Set(workspaceIdAliasChain(rightId));
  for (const alias of workspaceIdAliasChain(leftId)) {
    if (rightAliases.has(alias)) return true;
  }
  return false;
}

export function workspaceIdsContainMatch(workspaceIds: Iterable<string>, target: string | null | undefined): boolean {
  const targetId = trimWorkspaceId(target);
  if (!targetId) return false;
  for (const workspaceId of workspaceIds) {
    if (workspaceIdsReferToSameWorkspace(workspaceId, targetId)) return true;
  }
  return false;
}

export function resolveWorkspaceIdAlias(target: string | null | undefined, candidates: Iterable<string>): string | null {
  const targetId = trimWorkspaceId(target);
  if (!targetId) return null;

  const normalizedCandidates = Array.from(candidates, (candidate) => trimWorkspaceId(candidate)).filter(Boolean);
  if (normalizedCandidates.includes(targetId)) return targetId;

  const aliasMatches = normalizedCandidates.filter((candidate) => workspaceIdsReferToSameWorkspace(candidate, targetId));
  if (aliasMatches.length === 1) return aliasMatches[0] ?? null;
  return null;
}

export function pickPreferredWorkspaceId(
  candidates: Iterable<string>,
  onlineWorkspaceIds?: Iterable<string> | null,
  preferred?: string | null | undefined,
): string | null {
  const normalizedCandidates = Array.from(candidates, (candidate) => trimWorkspaceId(candidate)).filter(Boolean);
  if (!normalizedCandidates.length) return null;

  const preferredWorkspaceId = resolveWorkspaceIdAlias(preferred, normalizedCandidates);
  if (preferredWorkspaceId) return preferredWorkspaceId;

  const normalizedOnlineWorkspaceIds = Array.from(onlineWorkspaceIds ?? [], (workspaceId) => trimWorkspaceId(workspaceId)).filter(Boolean);
  for (const candidate of normalizedCandidates) {
    if (workspaceIdsContainMatch(normalizedOnlineWorkspaceIds, candidate)) {
      return candidate;
    }
  }

  return normalizedCandidates[0] ?? null;
}
