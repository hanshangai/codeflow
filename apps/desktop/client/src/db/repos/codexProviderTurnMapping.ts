import type { SessionId } from "@codeflowai/shared";

export type CodexProviderTurnMappingCandidate = {
  engineTurnId: string;
  engineSessionId?: SessionId | null;
  previousEngineTurnId?: string | null;
  supersededEngineTurnIds?: string[];
  source: "turn.engineBound" | "turn/started";
  eventSeq: number;
  observedAt: number;
};

export type CodexProviderTurnMappingDecision =
  | { action: "keep" }
  | { action: "replace"; mapping: CodexProviderTurnMappingCandidate }
  | { action: "conflict" };

export const CODEX_PROVIDER_TURN_MAPPING_CONFLICT_CODE = "codex_provider_turn_mapping_conflict";

export type CodexProviderTurnMappingConflictDetails = {
  kind: "session_mismatch" | "turn_mismatch" | "lineage_conflict";
  clientTurnId: string;
  existingSessionId: string | null;
  incomingSessionId: string | null;
  existingProviderTurnId: string | null;
  incomingProviderTurnId: string;
};

/** 构造可跨 cause 链识别的 provider 映射冲突，供 ACK 层做窄隔离。 */
export function createCodexProviderTurnMappingConflictError(
  message: string,
  details: CodexProviderTurnMappingConflictDetails,
): Error {
  return Object.assign(new Error(message), {
    code: CODEX_PROVIDER_TURN_MAPPING_CONFLICT_CODE,
    details,
  });
}

/** 合并 raw/canonical provider turn 映射，并保留完整 replacement 祖先链。 */
export function decideCodexProviderTurnMapping(
  current: CodexProviderTurnMappingCandidate | null,
  incoming: CodexProviderTurnMappingCandidate,
): CodexProviderTurnMappingDecision {
  const normalizedIncoming = withCodexProviderTurnLineage(incoming);
  if (!normalizedIncoming) return { action: "conflict" };
  if (!current) return { action: "replace", mapping: normalizedIncoming };

  const normalizedCurrent = withCodexProviderTurnLineage(current);
  if (!normalizedCurrent) return { action: "conflict" };
  if (normalizedCurrent.engineTurnId === normalizedIncoming.engineTurnId) {
    if (normalizedCurrent.source === "turn.engineBound" || normalizedIncoming.source === "turn/started") {
      return { action: "keep" };
    }
    const promoted = withCodexProviderTurnLineage(
      normalizedIncoming,
      normalizedCurrent.supersededEngineTurnIds,
    );
    if (!promoted) return { action: "conflict" };
    return {
      action: "replace",
      mapping: promoted,
    };
  }

  if (
    normalizedIncoming.source === "turn.engineBound"
    && normalizedIncoming.previousEngineTurnId === normalizedCurrent.engineTurnId
    && normalizedIncoming.eventSeq > normalizedCurrent.eventSeq
    && !normalizedCurrent.supersededEngineTurnIds?.includes(normalizedIncoming.engineTurnId)
  ) {
    const replacement = withCodexProviderTurnLineage(normalizedIncoming, [
      ...(normalizedCurrent.supersededEngineTurnIds ?? []),
      normalizedCurrent.engineTurnId,
    ]);
    if (!replacement) return { action: "conflict" };
    return {
      action: "replace",
      mapping: replacement,
    };
  }

  if (
    normalizedCurrent.source === "turn.engineBound"
    && normalizedIncoming.source === "turn/started"
    && normalizedCurrent.supersededEngineTurnIds?.includes(normalizedIncoming.engineTurnId)
  ) {
    return { action: "keep" };
  }
  if (
    normalizedCurrent.source === "turn.engineBound"
    && normalizedIncoming.source === "turn.engineBound"
    && normalizedCurrent.engineSessionId != null
    && normalizedCurrent.engineSessionId === normalizedIncoming.engineSessionId
    && normalizedIncoming.eventSeq < normalizedCurrent.eventSeq
    && normalizedCurrent.supersededEngineTurnIds?.includes(normalizedIncoming.engineTurnId)
  ) {
    const currentLineage = normalizedCurrent.supersededEngineTurnIds ?? [];
    const incomingIndex = currentLineage.indexOf(normalizedIncoming.engineTurnId);
    if (
      incomingIndex > 0
      && normalizedIncoming.previousEngineTurnId !== currentLineage[incomingIndex - 1]
    ) {
      return { action: "conflict" };
    }
    const merged = withCodexProviderTurnLineage(normalizedCurrent, [
      ...(normalizedIncoming.supersededEngineTurnIds ?? []),
      normalizedIncoming.engineTurnId,
    ]);
    if (!merged) return { action: "conflict" };
    const mergedLineage = merged.supersededEngineTurnIds ?? [];
    return currentLineage.length === mergedLineage.length
      && currentLineage.every((turnId, index) => turnId === mergedLineage[index])
      ? { action: "keep" }
      : { action: "replace", mapping: merged };
  }
  return { action: "conflict" };
}

/** 严格规范化映射祖先链；自指、空值和非字符串证据均视为冲突。 */
function withCodexProviderTurnLineage(
  mapping: CodexProviderTurnMappingCandidate,
  inherited: readonly string[] = [],
): CodexProviderTurnMappingCandidate | null {
  const engineTurnId = String(mapping.engineTurnId ?? "").trim();
  const previousEngineTurnId = String(mapping.previousEngineTurnId ?? "").trim() || null;
  if (!engineTurnId || previousEngineTurnId === engineTurnId) return null;

  const ownLineage = mapping.supersededEngineTurnIds;
  if (ownLineage != null && !Array.isArray(ownLineage)) return null;
  const lineage = new Set<string>();
  for (const value of [
    ...inherited,
    ...(ownLineage ?? []),
  ]) {
    if (typeof value !== "string" || !value.trim()) return null;
    const turnId = value.trim();
    if (turnId === engineTurnId) return null;
    lineage.add(turnId);
  }
  if (previousEngineTurnId) lineage.add(previousEngineTurnId);
  const supersededEngineTurnIds = [...lineage];
  return supersededEngineTurnIds.length > 0
    ? { ...mapping, engineTurnId, previousEngineTurnId, supersededEngineTurnIds }
    : { ...mapping, engineTurnId, previousEngineTurnId, supersededEngineTurnIds: undefined };
}
