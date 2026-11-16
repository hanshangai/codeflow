import type { SessionId, TokenUsageSnapshot } from "@codeflowai/shared";

export type ClaudeCliEvent = Record<string, any>;

/** 安全解析一行 JSON（解析失败返回 null）。 */
export function safeJson(line: string): any | null {
  const s = String(line ?? "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 尝试从 Claude 输出事件中提取 sessionId（用于 resume）。 */
export function maybeExtractSessionId(event: ClaudeCliEvent): SessionId | null {
  const t = event?.type;
  if (t !== "system" && t !== "result" && t !== "assistant") return null;
  const sid = extractString(event, ["session_id", "sessionId"]) ?? extractString(event?.result, ["session_id", "sessionId"]);
  if (!sid || sid === "pending") return null;
  return sid as SessionId;
}

/** 尝试提取 token usage 快照，并按当前 turn 模型精确匹配 contextWindow。 */
export function tryExtractTokenUsage(
  event: ClaudeCliEvent,
  preferredModelId?: string | null,
): TokenUsageSnapshot | null {
  // 兼容 Claude stream_event 的嵌套 usage；部分兼容层（如 GLM）只在末条嵌套事件提供真实计数。
  const usageCandidates = [
    event?.usage,
    event?.message?.usage,
    event?.result?.usage,
    event?.event?.usage,
    event?.event?.message?.usage,
    event?.event?.message_delta?.usage,
    event?.event?.delta?.usage,
  ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object"));
  if (usageCandidates.length === 0) return null;

  const inputTokens = readUsageNum(usageCandidates, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = readUsageNum(usageCandidates, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const cachedInputTokens =
    readUsageNum(usageCandidates, ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens"]);
  const cacheCreationInputTokens =
    readUsageNum(usageCandidates, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);

  // modelContextWindow：优先从 usage 取；回退到 result.modelUsage（Claude CLI 的 result 事件在此字段携带 contextWindow）。
  let modelContextWindow =
    readUsageNum(usageCandidates, ["model_context_window", "modelContextWindow", "context_window", "contextWindow"]);
  if (modelContextWindow === null) {
    const resolvedModelId = extractEventModelId(event) ?? normalizeModelId(preferredModelId);
    modelContextWindow = extractContextWindowFromModelUsage(
      event?.modelUsage ?? event?.result?.modelUsage,
      resolvedModelId,
    ) ?? null;
  }

  if (inputTokens === null && outputTokens === null && cachedInputTokens === null && cacheCreationInputTokens === null && modelContextWindow === null) return null;
  return { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, modelContextWindow };
}

/** 从多个兼容层 usage 节点合并字段；优先保留非零值，避免外层零占位覆盖嵌套真实值。 */
function readUsageNum(candidates: Record<string, unknown>[], keys: string[]): number | null {
  let first: number | null = null;
  let latestNonZero: number | null = null;
  for (const candidate of candidates) {
    const value = readNum(candidate, keys);
    if (value === null) continue;
    if (first === null) first = value;
    if (value !== 0) latestNonZero = value;
  }
  return latestNonZero ?? first;
}

/** 从 result.modelUsage（按模型 key 存储）提取当前模型对应的 contextWindow。 */
function extractContextWindowFromModelUsage(
  modelUsage: unknown,
  preferredModelId?: string | null,
): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  const normalizedPreferredModelId = normalizeModelId(preferredModelId);
  if (normalizedPreferredModelId) {
    const matched = entries.find(([modelId]) => normalizeModelId(modelId) === normalizedPreferredModelId);
    if (matched?.[1] && typeof matched[1] === "object") {
      const cw = readNum(matched[1] as Record<string, unknown>, ["contextWindow", "context_window"]);
      if (cw && cw > 0) return cw;
    }
  }

  if (entries.length !== 1) return null;
  const onlyValue = entries[0]?.[1];
  if (onlyValue && typeof onlyValue === "object") {
    const cw = readNum(onlyValue as Record<string, unknown>, ["contextWindow", "context_window"]);
    if (cw && cw > 0) return cw;
  }
  return null;
}

/** 从 Claude 事件中读取当前模型 id。 */
function extractEventModelId(event: ClaudeCliEvent): string | null {
  return normalizeModelId(
    extractString(event, ["model"])
    ?? extractString(event?.message, ["model"])
    ?? extractString(event?.result, ["model"]),
  );
}

/** 统一归一化 model id，避免空白字符串影响 modelUsage 精确匹配。 */
function normalizeModelId(modelId: string | null | undefined): string | null {
  const normalized = String(modelId ?? "").trim();
  return normalized || null;
}

function extractString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function readNum(obj: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}


