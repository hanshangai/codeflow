import { resolveWorkspaceIdAlias, type WorkspaceId } from "@codeflowai/shared";

export type OfficeH5WorkspaceCandidate = {
  id: WorkspaceId | string | null | undefined;
  entryStatus?: string | null;
};

function normalizeWorkspaceId(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeOfficeH5PreferredWorkspaceId(value: unknown): string {
  const normalized = normalizeWorkspaceId(value);
  return normalized && normalized !== "default" ? normalized : "";
}

export function resolveOfficeH5WorkspaceSelection(input: {
  currentWorkspaceId?: string | null;
  routeWorkspaceId?: string | null;
  storedWorkspaceId?: string | null;
  resolvedCurrentWorkspaceId?: string | null;
  candidates: OfficeH5WorkspaceCandidate[];
}): WorkspaceId | null {
  const availableCandidates = input.candidates.filter((candidate) => candidate.entryStatus !== "client_offline");
  const candidates = availableCandidates
    .map((candidate) => normalizeWorkspaceId(candidate.id))
    .filter(Boolean);
  const preferred = normalizeOfficeH5PreferredWorkspaceId(input.currentWorkspaceId)
    || normalizeOfficeH5PreferredWorkspaceId(input.routeWorkspaceId)
    || normalizeOfficeH5PreferredWorkspaceId(input.storedWorkspaceId)
    || normalizeOfficeH5PreferredWorkspaceId(input.resolvedCurrentWorkspaceId);

  if (candidates.length) {
    const resolvedPreferred = preferred ? resolveWorkspaceIdAlias(preferred, candidates) : null;
    if (resolvedPreferred) return resolvedPreferred as WorkspaceId;
    return candidates[0] as WorkspaceId;
  }

  return preferred ? preferred as WorkspaceId : null;
}
