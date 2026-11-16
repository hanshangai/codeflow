import crypto from "node:crypto";

import type { ConversationEventInput, RawEngineEventInput } from "@codeflowai/shared";

import type { ClientToServerMessage } from "../protocol/messages.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";

const DEBUG_FULL_EVENT_OUTPUT_ENV = "CODEFLOWAI_DEBUG_FULL_EVENT_OUTPUT";
const TOOL_OUTPUT_OMITTED_TEXT = "[工具输出已省略，非 DEBUG 模式不保留全文]";
const RAW_OUTPUT_OMITTED_TEXT = "[原始输出已省略，非 DEBUG 模式不保留全文]";
const RAW_MAX_STRING_BYTES = 2 * 1024;
const PREVIEW_MAX_CHARS = 240;
const CODEX_SKILL_PATH_PLACEHOLDER = "[Codex Skill path omitted]";
const CODEX_SKILL_INSTRUCTIONS_PLACEHOLDER = "[Codex Skill instructions omitted]";

type SanitizeOptions = {
  keepFullOutput?: boolean;
};

type SanitizedValueMeta = {
  omitted: true;
  reason: "non-assistant-output";
  originalType: string;
  originalBytes: number;
  preview: string;
};

export function readKeepFullEventOutputFlag(): boolean {
  return isTruthyEnv(process.env[DEBUG_FULL_EVENT_OUTPUT_ENV]);
}

export function sanitizeClientToServerMessage(
  message: ClientToServerMessage,
  opts?: SanitizeOptions,
): ClientToServerMessage {
  const privacySafe = redactCodexSkillSecrets(message) as ClientToServerMessage;
  if (opts?.keepFullOutput) return privacySafe;
  if (privacySafe.t === "conversation.event") {
    const event = sanitizeConversationEvent(privacySafe.event, opts);
    return event === privacySafe.event ? privacySafe : { ...privacySafe, event };
  }
  if (privacySafe.t === "raw.event") {
    const event = sanitizeRawEvent(privacySafe.event, opts);
    return event === privacySafe.event ? privacySafe : { ...privacySafe, event };
  }
  return privacySafe;
}

export function sanitizeConversationEvent(
  event: ConversationEventInput,
  opts?: SanitizeOptions,
): ConversationEventInput {
  const privacySafe = redactCodexSkillSecrets(event) as ConversationEventInput;
  if (opts?.keepFullOutput) return privacySafe;
  const payload = sanitizeConversationPayload(privacySafe.type, privacySafe.payload);
  return payload === privacySafe.payload ? privacySafe : { ...privacySafe, payload: payload as any };
}

export function sanitizeRawEvent(
  event: RawEngineEventInput,
  opts?: SanitizeOptions,
): RawEngineEventInput {
  const privacySafe = redactCodexSkillSecrets(event) as RawEngineEventInput;
  if (opts?.keepFullOutput) return privacySafe;
  const data = sanitizeRawEventData(privacySafe);
  return data === privacySafe.data ? privacySafe : { ...privacySafe, data };
}

/** Recursively removes Codex Skill paths and full injected Skill instruction fragments. */
function redactCodexSkillSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const redacted = redactCodexSkillSecrets(entry);
      if (redacted !== entry) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    let redacted = redactCodexSkillSecrets(entry);
    if (record.type === "skill" && key === "path" && typeof entry === "string") {
      redacted = CODEX_SKILL_PATH_PLACEHOLDER;
    }
    next[key] = redacted;
    if (redacted !== entry) changed = true;
  }

  const method = String(record.method ?? "").trim();
  if (method === "rawResponseItem/completed") {
    const params = redactRawResponseSkillInstructions(next.params);
    if (params !== next.params) {
      next.params = params;
      changed = true;
    }
  }
  return changed ? next : value;
}

/** Replaces complete user-role <skill> instruction fragments in raw ResponseItem content. */
function redactRawResponseSkillInstructions(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const params = value as Record<string, unknown>;
  const item = params.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return value;
  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== "message" || itemRecord.role !== "user" || !Array.isArray(itemRecord.content)) {
    return value;
  }
  let changed = false;
  const content = itemRecord.content.map((rawContent) => {
    if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) return rawContent;
    const contentRecord = rawContent as Record<string, unknown>;
    if (contentRecord.type !== "input_text" || typeof contentRecord.text !== "string") return rawContent;
    const text = contentRecord.text.replace(
      /<skill>[\s\S]*?<\/skill>/gu,
      CODEX_SKILL_INSTRUCTIONS_PLACEHOLDER,
    );
    if (text === contentRecord.text) return rawContent;
    changed = true;
    return { ...contentRecord, text };
  });
  if (!changed) return value;
  return {
    ...params,
    item: {
      ...itemRecord,
      content,
    },
  };
}

/** 裁剪工具全文前保留失败诊断，并递归处理子任务事件。 */
function sanitizeConversationPayload(type: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  switch (type) {
    case "item.tool.outputDelta": {
      const delta = String((payload as any).delta ?? "");
      const mode = String((payload as any).mode ?? "append");
      if (delta === TOOL_OUTPUT_OMITTED_TEXT && mode === "replace") return payload;
      return { ...(payload as any), delta: TOOL_OUTPUT_OMITTED_TEXT, mode: "replace" };
    }
    case "item.tool.completed": {
      const next: Record<string, unknown> = { ...(payload as any) };
      let changed = false;

      const diagnostic = summarizeCommandFailure(next);
      if (diagnostic) {
        next.error = diagnostic;
        changed = true;
      }

      if (Object.prototype.hasOwnProperty.call(next, "output")) {
        const sanitizedOutput = sanitizeOpaqueOutputValue(next.output);
        if (sanitizedOutput !== next.output) {
          next.output = sanitizedOutput;
          changed = true;
        }
      }

      if (typeof next.error === "string") {
        const sanitizedError = sanitizeShortText(next.error);
        if (sanitizedError !== next.error) {
          next.error = sanitizedError;
          changed = true;
        }
      }

      return changed ? next : payload;
    }
    case "item.subagent.childEvent": {
      const innerType = String((payload as any).innerEventType ?? "").trim();
      const innerPayload = (payload as any).innerPayload;
      if (!innerType) return payload;
      const sanitizedInnerPayload = sanitizeConversationPayload(innerType, innerPayload);
      return sanitizedInnerPayload === innerPayload
        ? payload
        : { ...(payload as any), innerPayload: sanitizedInnerPayload };
    }
    default:
      return payload;
  }
}

function sanitizeRawEventData(event: RawEngineEventInput): unknown {
  if (event.engine === "codex" && event.source === "codex.app-server.msg") {
    return sanitizeCodexRawMessage(event.data);
  }
  if (event.engine === "claude" && event.source === "claude.stream-json.stdout") {
    return sanitizeClaudeRawMessage(event.data);
  }
  return sanitizeLargeRawStrings(event.data);
}

function sanitizeCodexRawMessage(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const msg = data as Record<string, unknown>;
  const method = String(msg.method ?? "").trim();
  const params = msg.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return data;
  }

  if (method === "turn/diff/updated") {
    const diff = String((params as any).diff ?? "");
    return {
      ...msg,
      params: {
        ...(params as Record<string, unknown>),
        diff: sanitizeRawOutputText(diff),
        diffSha256: crypto.createHash("sha256").update(diff).digest("hex"),
        diffBytes: measureBytes(diff),
      },
    };
  }

  if (
    method === "item/agentMessage/delta"
    || method === "item/reasoning/textDelta"
    || method === "item/reasoning/summaryTextDelta"
    || method === "item/reasoning/summaryPartAdded"
    || method === "turn/completed"
    || method === "turn/error"
    || method === "item/started"
  ) {
    return data;
  }

  if (method === "item/plan/delta") {
    return { ...msg, params: { ...(params as any), delta: sanitizeRawOutputText((params as any).delta) } };
  }

  if (method === "turn/plan/updated") {
    return { ...msg, params: sanitizeKnownNonAssistantOutputFields(params) };
  }

  if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
    return { ...msg, params: { ...(params as any), delta: sanitizeRawOutputText((params as any).delta) } };
  }

  if (method === "item/completed") {
    const item = (params as any).item;
    const itemType = String(item?.type ?? "").trim();
    if (itemType === "agentMessage" || itemType === "reasoning" || itemType === "userMessage") {
      return data;
    }
    return { ...msg, params: sanitizeKnownNonAssistantOutputFields(params) };
  }

  return data;
}

function sanitizeClaudeRawMessage(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const raw = data as Record<string, unknown>;
  const type = String(raw.type ?? "").trim();

  if (type === "assistant" || type === "user") {
    return sanitizeClaudeMessage(raw);
  }

  if (type === "stream_event") {
    const inner = raw.event;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
      return data;
    }
    const eventObj = inner as Record<string, unknown>;
    const innerType = String(eventObj.type ?? "").trim();
    if (innerType === "content_block_delta") {
      const delta = eventObj.delta;
      if (delta && typeof delta === "object" && !Array.isArray(delta)) {
        const deltaObj = delta as Record<string, unknown>;
        const deltaType = String(deltaObj.type ?? "").trim();
        if (deltaType === "tool_result") {
          return {
            ...raw,
            event: {
              ...eventObj,
              delta: {
                ...deltaObj,
                content: sanitizeOpaqueOutputValue(deltaObj.content),
              },
            },
          };
        }
      }
      return data;
    }
    if (innerType === "content_block_start") {
      const block = eventObj.content_block;
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const blockType = String((block as Record<string, unknown>).type ?? "").trim();
        if (blockType !== "tool_result") return data;
        return {
          ...raw,
          event: {
            ...eventObj,
            content_block: sanitizeClaudeContentBlock(block as Record<string, unknown>),
          },
        };
      }
      return data;
    }
    return data;
  }

  return data;
}

function sanitizeClaudeMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const message = raw.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return raw;
  }
  const messageObj = message as Record<string, unknown>;
  const content = messageObj.content;
  if (!Array.isArray(content)) {
    return raw;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const sanitized = sanitizeClaudeContentBlock(block as Record<string, unknown>);
    if (sanitized !== block) changed = true;
    return sanitized;
  });

  if (!changed) return raw;
  return {
    ...raw,
    message: {
      ...messageObj,
      content: nextContent,
    },
  };
}

function sanitizeClaudeContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  const blockType = String(block.type ?? "").trim();
  if (blockType === "tool_result") {
    return {
      ...block,
      content: sanitizeOpaqueOutputValue(block.content),
    };
  }
  return block;
}

function sanitizeLargeRawStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const bytes = measureBytes(value);
    return bytes > RAW_MAX_STRING_BYTES ? sanitizeRawOutputText(value) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = sanitizeLargeRawStrings(entry);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeLargeRawStrings(entry);
    out[key] = sanitized;
    if (sanitized !== entry) changed = true;
  }
  return changed ? out : value;
}

function sanitizeKnownNonAssistantOutputFields(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeRawOutputText(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = sanitizeKnownNonAssistantOutputFields(entry);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;

  const outputLikeKeys = new Set(["stdout", "stderr", "output", "content", "text", "delta"]);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    let sanitized = entry;
    if (typeof entry === "string" && outputLikeKeys.has(key)) {
      sanitized = sanitizeRawOutputText(entry);
    } else if (entry && typeof entry === "object") {
      sanitized = sanitizeKnownNonAssistantOutputFields(entry);
    }
    out[key] = sanitized;
    if (sanitized !== entry) changed = true;
  }
  return changed ? out : value;
}

/** 保留输出大小与脱敏预览，已裁剪的元信息保持幂等。 */
function sanitizeOpaqueOutputValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (isSanitizedMeta(value)) return value;
  return {
    omitted: true,
    reason: "non-assistant-output",
    originalType: detectValueType(value),
    originalBytes: measureUnknownBytes(value),
    preview: redactClientStartupText(extractPreview(value)),
  } satisfies SanitizedValueMeta;
}

/** 仅为明确失败的命令保留有界诊断；不推测可恢复性，也不改变退出状态。 */
function summarizeCommandFailure(payload: Record<string, unknown>): string | undefined {
  if (payload.status !== "failed" || payload.toolName !== "commandExecution") return undefined;
  const output = payload.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || isSanitizedMeta(output)) return undefined;
  const command = output as Record<string, unknown>;
  const exitCode = command.exitCode ?? command.exit_code;
  const parts = ["命令执行失败"];
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) parts.push(`退出码：${exitCode}`);
  if (typeof command.cwd === "string" && command.cwd.trim()) {
    const cwd = Array.from(redactClientStartupText(command.cwd).trim());
    parts.push(`工作目录：${cwd.length > 120 ? `${cwd.slice(0, 117).join("")}...` : cwd.join("")}`);
  }
  const detail = [payload.error, command.stderr, command.aggregatedOutput, command.aggregated_output, command.stdout]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  parts.push(summarizeFailedCommandOutput(detail ?? "引擎未提供命令输出，请结合命令与退出码核对原因；复合命令需逐条核对。"));
  return parts.join("\n");
}

/** 仅为失败诊断挑选错误行，保留首尾并脱敏；不据此推断命令状态。 */
function summarizeFailedCommandOutput(text: string): string {
  text = redactClientStartupText(text).trim();
  const characters = Array.from(text);
  if (characters.length <= 360) return text;
  const errorLines = text.split(/\r?\n/u).filter((line) =>
    /^(?:rg:|[\w.]*Error(?:\s+\[[^\]]+\])?:|[\w.]*Exception:|[A-Za-z]+-[A-Za-z]+\s*:|.*\berror TS\d+:|\s*\+\s*(?:CategoryInfo|FullyQualifiedErrorId)\s*:|Root cause:|Caused by:)/u.test(line),
  ).slice(0, 4);
  if (!errorLines.length) return `${characters.slice(0, 120).join("")}\n…\n${characters.slice(-240).join("")}`;
  const errors = Array.from(errorLines.join("\n")).slice(0, 190).join("");
  return `${characters.slice(0, 80).join("")}\n…\n${errors}\n…\n${characters.slice(-76).join("")}`;
}

function sanitizeRawOutputText(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return RAW_OUTPUT_OMITTED_TEXT;
  const preview = extractPreview(text, 160);
  const suffix = preview ? ` preview="${preview}"` : "";
  return `${RAW_OUTPUT_OMITTED_TEXT} bytes=${measureBytes(text)}${suffix}`;
}

/** 对保留的错误说明统一脱敏并限制存储大小。 */
function sanitizeShortText(text: string): string {
  text = redactClientStartupText(text);
  const bytes = measureBytes(text);
  if (bytes <= RAW_MAX_STRING_BYTES) return text;
  return `${RAW_OUTPUT_OMITTED_TEXT} bytes=${bytes} preview="${extractPreview(text, 160)}"`;
}

function extractPreview(value: unknown, maxChars = PREVIEW_MAX_CHARS): string {
  if (typeof value === "string") {
    return abbreviateText(value, maxChars);
  }
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const picked = pickUsefulText(value as Record<string, unknown>);
    if (picked) return abbreviateText(picked, maxChars);
    try {
      return abbreviateText(JSON.stringify(value), maxChars);
    } catch {
      return "";
    }
  }
  return abbreviateText(String(value), maxChars);
}

/** 优先预览实际输出，避免 Codex 命令只有 command 字段被展示。 */
function pickUsefulText(value: Record<string, unknown>): string {
  const queue: unknown[] = [
    value.preview,
    value.summary,
    value.message,
    value.error,
    value.stderr,
    value.aggregatedOutput,
    value.aggregated_output,
    value.stdout,
    value.text,
    value.result,
    value.content,
    value.command,
    value.cmd,
  ];
  for (const candidate of queue) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === "string" && entry.trim()) return entry;
        if (entry && typeof entry === "object") {
          const nested = pickUsefulText(entry as Record<string, unknown>);
          if (nested) return nested;
        }
      }
    }
    if (candidate && typeof candidate === "object") {
      const nested = pickUsefulText(candidate as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return "";
}

function abbreviateText(text: string, maxChars: number): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function detectValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function measureUnknownBytes(value: unknown): number {
  if (typeof value === "string") return measureBytes(value);
  try {
    return measureBytes(JSON.stringify(value));
  } catch {
    return measureBytes(String(value ?? ""));
  }
}

function measureBytes(text: string): number {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function isTruthyEnv(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSanitizedMeta(value: unknown): value is SanitizedValueMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean((value as any).omitted) && String((value as any).reason ?? "") === "non-assistant-output";
}
