import type {
  ListThreadInputActionsResponseBody,
  SessionId,
  ThreadInputAction,
} from "@codeflowai/shared";

export type ClaudeInputActionCatalogSnapshot = {
  sessionId: SessionId;
  generation: number;
  response: ListThreadInputActionsResponseBody;
};

export type ClaudeProviderSlashFinalResult =
  | { kind: "pending" }
  | { kind: "success"; resultText: string }
  | { kind: "failure"; subtype: string; reason: string };

/** Strictly projects one real system.init event into a path-free Slash catalog. */
export function parseClaudeInputActionCatalog(
  value: unknown,
  generation: number,
  observedAt = Date.now(),
): ClaudeInputActionCatalogSnapshot | null {
  const init = asRecord(value);
  if (init?.type !== "system" || init.subtype !== "init") return null;
  const sessionId = normalizeRequiredString(init.session_id, 200);
  const slashCommands = normalizeProviderNames(init.slash_commands);
  const skills = normalizeProviderNames(init.skills);
  if (!sessionId || !slashCommands || !skills || !Number.isSafeInteger(generation) || generation < 0) {
    return null;
  }

  const skillTokens = new Set(skills.map(toSlashToken));
  const seenTokens = new Set<string>();
  const actions: ThreadInputAction[] = [];
  for (const providerName of slashCommands) {
    const token = toSlashToken(providerName);
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    actions.push({
      kind: "slash",
      token,
      source: "claude",
      delivery: "provider-slash",
      providerName: stripSlashPrefix(providerName),
      isSkill: skillTokens.has(token),
      enabled: true,
      disabledReason: null,
    });
  }

  const providerVersion = normalizeOptionalString(init.claude_code_version, 80);
  return {
    sessionId: sessionId as SessionId,
    generation,
    response: {
      engine: "claude",
      actions,
      providerCatalog: {
        state: "ready",
        observedAt,
        providerVersion,
        message: null,
      },
    },
  };
}

/** Strictly classifies a no-pending Provider Slash result without exposing Provider error text. */
export function inspectClaudeProviderSlashFinalResult(
  value: unknown,
  pendingInteractiveCount: number,
): ClaudeProviderSlashFinalResult | null {
  const result = asRecord(value);
  if (result?.type !== "result") return null;
  if (pendingInteractiveCount > 0) return { kind: "pending" };

  const subtype = sanitizeResultSubtype(result.subtype);
  if (!subtype || typeof result.is_error !== "boolean") {
    return { kind: "failure", subtype: subtype || "invalid", reason: "invalid_result_shape" };
  }
  if (subtype === "success" && result.is_error === false && typeof result.result === "string") {
    return { kind: "success", resultText: result.result.trim() };
  }
  if (subtype === "success" && result.is_error === true) {
    return { kind: "failure", subtype, reason: "success_is_error_conflict" };
  }
  if (subtype !== "success" && result.is_error === false) {
    return { kind: "failure", subtype, reason: "subtype_is_error_conflict" };
  }
  return { kind: "failure", subtype, reason: "provider_reported_error" };
}

/** Builds the Client-internal typed terminal error for a failed Provider Slash result. */
export function createClaudeProviderSlashResultError(input: {
  subtype: string;
  reason: string;
}): Error & {
  code: "claude_result_failed";
  requestMethod: "result";
  terminationKind: "error";
  additionalDetails: { subtype: string; reason: string };
} {
  return Object.assign(
    new Error(`Claude Provider Slash 执行失败（subtype=${input.subtype}, reason=${input.reason}）`),
    {
      code: "claude_result_failed" as const,
      requestMethod: "result" as const,
      terminationKind: "error" as const,
      additionalDetails: { subtype: input.subtype, reason: input.reason },
    },
  );
}

/** Extracts visible local-command output from compatible Claude SDK event shapes. */
export function extractClaudeLocalCommandOutput(value: unknown): string | null {
  const event = asRecord(value);
  if (!event) return null;
  if (event.type === "system" && event.subtype === "local_command_output") {
    return normalizeVisibleText(event.content);
  }
  if (event.type !== "user") return null;
  const message = asRecord(event.message);
  if (typeof message?.content !== "string") return null;
  const tagged = extractLocalCommandTags(message.content);
  return tagged ? normalizeVisibleText(tagged) : null;
}

/** Returns a log-safe Slash command name without retaining its arguments. */
export function extractSafeClaudeSlashCommandName(text: string): string {
  const match = /^\/([^\s]{1,80})/u.exec(String(text ?? ""));
  if (!match) return "invalid";
  const command = match[1]!;
  return /^[A-Za-z0-9_.:-]+$/u.test(command) ? command : "invalid";
}

function normalizeProviderNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry !== entry.trim()) return null;
    const name = stripSlashPrefix(entry);
    if (!name || name.length > 128 || /[\s/\u0000-\u001f\u007f]/u.test(name)) return null;
    result.push(entry);
  }
  return result;
}

function toSlashToken(value: string): `/${string}` {
  return `/${stripSlashPrefix(value)}`;
}

function stripSlashPrefix(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function extractLocalCommandTags(text: string): string {
  const outputs: string[] = [];
  const pattern = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/gu;
  for (const match of text.matchAll(pattern)) outputs.push(match[1] ?? "");
  return outputs.join("\n");
}

function normalizeVisibleText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").trim();
  return text || null;
}

function sanitizeResultSubtype(value: unknown): string {
  if (typeof value !== "string") return "";
  const subtype = value.trim();
  return /^[A-Za-z0-9_-]{1,80}$/u.test(subtype) ? subtype : "";
}

function normalizeRequiredString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maxChars ? text : "";
}

function normalizeOptionalString(value: unknown, maxChars: number): string | null {
  if (value == null) return null;
  return normalizeRequiredString(value, maxChars) || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
