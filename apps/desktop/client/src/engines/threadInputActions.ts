import crypto from "node:crypto";

import {
  ThreadInputContractError,
  normalizeCodexSkillMentionBindings,
  normalizeExplicitInputKind,
  normalizeThreadInputContract,
  trimThreadTextWithSkillMentions,
  type CodexSkillMentionBinding,
  type EngineType,
  type NormalizedThreadInputContract,
  type ThreadInputKind,
} from "@codeflowai/shared";

import { buildPromptText } from "../app/utils/promptWithAttachments.js";
import type { SqliteDb } from "../db/sqliteTypes.js";

const INPUT_ACTION_HMAC_META_KEY = "thread_input_actions_hmac_v1";

export type PersistedThreadInputContract = {
  inputKind: string | null;
  skillMentionsJson: string;
};

/** Serializes a validated wire contract while preserving a truly missing inputKind as NULL. */
export function serializePersistedThreadInputContract(
  value: unknown,
  text: string,
): PersistedThreadInputContract {
  const normalized = normalizeThreadInputContract(value, text);
  return {
    inputKind: normalized.inputKind ?? null,
    skillMentionsJson: JSON.stringify(normalized.skillMentions ?? []),
  };
}

/** Strictly hydrates a persisted contract; malformed rows never become empty/default input. */
export function parsePersistedThreadInputContract(input: {
  inputKind: unknown;
  skillMentionsJson: unknown;
  text: string;
  entityLabel: string;
}): NormalizedThreadInputContract {
  const inputKind = input.inputKind == null
    ? undefined
    : normalizeExplicitInputKind(input.inputKind);
  let parsedMentions: unknown;
  try {
    parsedMentions = JSON.parse(String(input.skillMentionsJson ?? ""));
  } catch (cause) {
    throw persistedBindingError(input.entityLabel, "Skill binding JSON 无法解析", cause);
  }

  let skillMentions: CodexSkillMentionBinding[] | undefined;
  try {
    skillMentions = normalizeCodexSkillMentionBindings(parsedMentions, input.text);
  } catch (cause) {
    if (cause instanceof ThreadInputContractError) {
      throw persistedBindingError(input.entityLabel, cause.message, cause);
    }
    throw cause;
  }
  if (skillMentions?.length && inputKind !== "message") {
    throw persistedBindingError(input.entityLabel, "Skill binding 缺少显式 message 输入类型");
  }
  return {
    ...(inputKind ? { inputKind } : {}),
    ...(skillMentions?.length ? { skillMentions } : {}),
  };
}

/** Treats any non-canonical raw binding payload as fresh-turn work before strict claim hydration. */
export function rawQueueContractNeedsFreshTurn(inputKind: unknown, skillMentionsJson: unknown): boolean {
  return inputKind != null || String(skillMentionsJson ?? "") !== "[]";
}

/** Resolves a local 32-byte HMAC key from SQLite meta, creating it atomically on first use. */
export function getOrCreateThreadInputActionHmacKey(db: SqliteDb): Buffer {
  const create = db.transaction(() => {
    const generated = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run(INPUT_ACTION_HMAC_META_KEY, generated);
    return db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(INPUT_ACTION_HMAC_META_KEY) as { value?: unknown } | undefined;
  });
  const value = String((create() as { value?: unknown } | undefined)?.value ?? "");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) {
    throw new Error("Client 输入动作 HMAC key 无效");
  }
  return key;
}

/** Returns whether a payload explicitly opts into the V1 wire capability. */
export function hasExplicitThreadInputContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "inputKind")) return true;
  return Array.isArray(record.skillMentions) && record.skillMentions.length > 0;
}

/** 保留显式 Provider Slash 原文；普通消息继续执行既有 trim 与 binding 重映射。 */
export function normalizeClientThreadDisplayInput(input: {
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: readonly CodexSkillMentionBinding[];
}): { text: string; skillMentions?: CodexSkillMentionBinding[] } {
  if (input.inputKind === "provider-slash") return { text: input.text };
  return trimThreadTextWithSkillMentions(input.text, input.skillMentions);
}

/** 生成最终 Provider 文本；显式 Provider Slash 跳过附件组装器的 trim。 */
export function buildClientThreadPromptText(input: {
  text: string;
  inputKind?: ThreadInputKind;
  files: Array<{ name: string; text: string }>;
  pathReferences?: unknown;
}): string {
  if (input.inputKind === "provider-slash") return input.text;
  return buildPromptText({
    text: input.text,
    files: input.files,
    pathReferences: input.pathReferences,
  });
}

/** 在 Client mutation 前裁决 Provider Slash 的运行态与载荷冲突。 */
export function resolveProviderSlashPreflightConflict(input: {
  engine: EngineType;
  rawText: string;
  hasRole: boolean;
  imageCount: number;
  fileCount: number;
  pathReferenceCount: number;
  hasActiveTurn: boolean;
  hasQueuedInput: boolean;
}): string | null {
  if (input.engine !== "claude") return "当前引擎不支持 Provider Slash";
  if (input.rawText[0] !== "/") return "Provider Slash 必须从正文第一个字符开始";
  if (input.rawText.includes("\n") || input.rawText.includes("\r")) return "Provider Slash 仅支持单行输入";
  if (input.hasRole || input.imageCount > 0 || input.fileCount > 0 || input.pathReferenceCount > 0) {
    return "Provider Slash 不能携带角色、附件或路径引用";
  }
  if (input.hasActiveTurn) return "Provider Slash 不能在 AI 回合运行中执行";
  if (input.hasQueuedInput) return "Provider Slash 不能在消息队列非空时执行";
  return null;
}

/** Builds an own-property-preserving object for strict normalizers. */
export function projectThreadInputContractFields(value: {
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
}): Record<string, unknown> {
  return {
    ...(Object.prototype.hasOwnProperty.call(value, "inputKind") ? { inputKind: value.inputKind } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "skillMentions")
      ? { skillMentions: value.skillMentions }
      : {}),
  };
}

function persistedBindingError(entityLabel: string, reason: string, cause?: unknown): ThreadInputContractError {
  const error = new ThreadInputContractError(
    "CODEX_SKILL_BINDING_INVALID",
    `${entityLabel} 输入合同无效：${reason}`,
  );
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
