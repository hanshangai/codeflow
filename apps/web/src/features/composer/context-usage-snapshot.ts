import type { TokenUsageState } from "@codeflowai/shared";

export function cloneTokenUsageState(usage: TokenUsageState): TokenUsageState {
  return {
    current: { ...usage.current },
    cumulative: { ...usage.cumulative },
    turnPeak: { ...usage.turnPeak },
  };
}

export function hasCurrentUsageData(usage: TokenUsageState | null | undefined): boolean {
  const cur = usage?.current;
  if (!cur) return false;
  return cur.inputTokens != null ||
    cur.outputTokens != null ||
    cur.cachedInputTokens != null ||
    cur.cacheCreationInputTokens != null ||
    cur.totalTokens != null ||
    cur.reasoningOutputTokens != null;
}

export function resolveStableTokenUsageOnContentChange(
  usage: TokenUsageState | null | undefined,
): TokenUsageState | null {
  if (!usage || !hasCurrentUsageData(usage)) return null;
  return cloneTokenUsageState(usage);
}

export function resolveNextStableTokenUsage(
  previous: TokenUsageState | null,
  usage: TokenUsageState | null | undefined,
): TokenUsageState | null {
  if (usage && hasCurrentUsageData(usage)) return cloneTokenUsageState(usage);
  if (!previous) return null;
  if (!usage) return cloneTokenUsageState(previous);

  const next = cloneTokenUsageState(previous);
  next.cumulative = { ...usage.cumulative };
  next.turnPeak = { ...usage.turnPeak };
  if (usage.current.modelContextWindow != null) next.current.modelContextWindow = usage.current.modelContextWindow;
  return next;
}
