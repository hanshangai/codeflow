import crypto from "node:crypto";
import path from "node:path";

import {
  CODEX_SKILL_NAME_PATTERN,
  ThreadInputContractError,
  normalizeCodexSkillMentionBindings,
  type CodexSkillMentionBinding,
  type ListThreadInputActionsResponseBody,
  type ThreadInputAction,
  type WorkspaceId,
} from "@codeflowai/shared";

const CODEX_SKILLS_LIST_REQUEST_TIMEOUT_MS = 10_000;
const SAFE_DISPLAY_NAME_MAX_CHARS = 80;
const SAFE_DESCRIPTION_MAX_CHARS = 240;
const SKILL_PATH_PLACEHOLDER = "[Codex Skill path]";

type CodexSkillsRequester = {
  request(
    method: string,
    params: unknown,
    opts?: {
      timeoutMs?: number;
      trackLateSettlement?: boolean;
      expectedProcessGeneration?: number;
    },
  ): Promise<unknown>;
};

export type ResolvedCodexSkillInput = {
  skillId: string;
  name: string;
  path: string;
};

type CodexSkillCatalogEntry = ResolvedCodexSkillInput & {
  comparisonPath: string;
  displayName: string | null;
  scope: string;
  description: string | null;
};

type ParsedCodexSkillCatalog = {
  entries: CodexSkillCatalogEntry[];
  providerErrorCount: number;
  skippedSkillCount: number;
};

/** Reads one fresh Codex Skill catalog and returns only path-free Web DTOs. */
export async function listCodexSkillInputActions(input: {
  requester: CodexSkillsRequester;
  workspaceId: WorkspaceId;
  workspacePath: string;
  hmacKey: Buffer;
  expectedProcessGeneration?: number;
}): Promise<ListThreadInputActionsResponseBody> {
  const observedAt = Date.now();
  const catalog = await requestCodexSkillCatalog(input);
  const duplicateNameScopes = countNameScopes(catalog.entries);
  const actions: ThreadInputAction[] = catalog.entries.map((entry) => ({
    kind: "codex-skill",
    token: `$${entry.name}`,
    name: entry.name,
    displayName: entry.displayName,
    skillId: entry.skillId,
    scope: entry.scope,
    sourceLabel: duplicateNameScopes.get(nameScopeKey(entry))! > 1
      ? `${entry.scope} · ${entry.skillId.slice(-6)}`
      : entry.scope,
    description: entry.description,
  }));
  return {
    engine: "codex",
    actions,
    providerCatalog: {
      state: "ready",
      observedAt,
      message: buildCatalogWarning(catalog),
    },
  };
}

/** Re-resolves opaque bindings against a fresh enabled Skill catalog. */
export async function resolveCodexSkillMentionBindings(input: {
  requester: CodexSkillsRequester;
  workspaceId: WorkspaceId;
  workspacePath: string;
  hmacKey: Buffer;
  text: string;
  bindings: readonly CodexSkillMentionBinding[];
  expectedProcessGeneration: number;
}): Promise<ResolvedCodexSkillInput[]> {
  const bindings = normalizeCodexSkillMentionBindings(input.bindings, input.text);
  if (!bindings?.length) {
    throw new ThreadInputContractError(
      "CODEX_SKILL_BINDING_INVALID",
      "Codex Skill binding 不能为空",
    );
  }

  const catalog = await requestCodexSkillCatalog(input);
  const entryById = new Map(catalog.entries.map((entry) => [entry.skillId, entry]));
  const selected: ResolvedCodexSkillInput[] = [];
  const selectedPaths = new Set<string>();
  for (const binding of bindings) {
    const entry = entryById.get(binding.skillId) ?? null;
    if (!entry || entry.name !== binding.name) {
      throw new ThreadInputContractError(
        "CODEX_SKILL_BINDING_INVALID",
        `Codex Skill binding 已失效：${binding.name}`,
      );
    }
    if (selectedPaths.has(entry.comparisonPath)) continue;
    selectedPaths.add(entry.comparisonPath);
    selected.push({
      skillId: entry.skillId,
      name: entry.name,
      path: entry.path,
    });
  }
  return selected;
}

/** Computes the Client-local opaque Skill handle from normalized provider facts. */
export function buildCodexSkillId(input: {
  hmacKey: Buffer;
  workspaceId: WorkspaceId;
  name: string;
  scope: string;
  normalizedAbsolutePath: string;
}): string {
  const payload = [
    "codex-skill:v1",
    String(input.workspaceId),
    input.name,
    input.scope,
    input.normalizedAbsolutePath,
  ].join("\0");
  const digest = crypto.createHmac("sha256", input.hmacKey).update(payload, "utf8").digest("base64url");
  return `csk_${digest}`;
}

/** Normalizes the real provider path while preserving filesystem casing for turn/start. */
export function normalizeCodexSkillPath(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  const normalized = path.normalize(path.resolve(raw));
  if (path.basename(normalized).toLowerCase() !== "skill.md") return null;
  return normalized;
}

/** Converts a catalog transport or shape failure into a path-free typed error. */
export function createCodexInputActionCatalogError(reason: string): Error {
  return Object.assign(new Error(`Codex Skill 目录读取失败：${reason}`), {
    code: "THREAD_INPUT_ACTION_CATALOG_FAILED",
    requestMethod: "skills/list",
    terminationKind: "error" as const,
  });
}

async function requestCodexSkillCatalog(input: {
  requester: CodexSkillsRequester;
  workspaceId: WorkspaceId;
  workspacePath: string;
  hmacKey: Buffer;
  expectedProcessGeneration?: number;
}): Promise<ParsedCodexSkillCatalog> {
  let result: unknown;
  try {
    result = await input.requester.request(
      "skills/list",
      { cwds: [input.workspacePath], forceReload: true },
      {
        timeoutMs: CODEX_SKILLS_LIST_REQUEST_TIMEOUT_MS,
        ...(input.expectedProcessGeneration == null
          ? {}
          : { expectedProcessGeneration: input.expectedProcessGeneration }),
      },
    );
  } catch {
    throw createCodexInputActionCatalogError("Provider 请求失败");
  }
  return parseCodexSkillCatalog(result, input);
}

/** Strictly parses the one-cwd skills/list response without exporting raw metadata. */
function parseCodexSkillCatalog(
  result: unknown,
  input: { workspaceId: WorkspaceId; workspacePath: string; hmacKey: Buffer },
): ParsedCodexSkillCatalog {
  const root = asRecord(result);
  if (!Array.isArray(root?.data) || root.data.length !== 1) {
    throw createCodexInputActionCatalogError("Provider 响应结构非法");
  }
  const group = asRecord(root.data[0]);
  if (!group || normalizePathForComparison(group.cwd) !== normalizePathForComparison(input.workspacePath)) {
    throw createCodexInputActionCatalogError("Provider 工作区分组不匹配");
  }
  if (!Array.isArray(group.skills) || !Array.isArray(group.errors)) {
    throw createCodexInputActionCatalogError("Provider 目录字段非法");
  }

  const knownPaths = collectKnownAbsolutePaths(group.skills);
  const entries: CodexSkillCatalogEntry[] = [];
  const seenSkillIds = new Set<string>();
  let skippedSkillCount = 0;
  for (const rawSkill of group.skills) {
    const skill = asRecord(rawSkill);
    const name = typeof skill?.name === "string" ? skill.name.trim() : "";
    const scope = typeof skill?.scope === "string" ? skill.scope.trim() : "";
    const normalizedAbsolutePath = normalizeCodexSkillPath(skill?.path);
    if (
      !skill
      || skill.enabled !== true
      || !name
      || name.length > 128
      || !CODEX_SKILL_NAME_PATTERN.test(name)
      || !isCodexSkillScope(scope)
      || !normalizedAbsolutePath
    ) {
      skippedSkillCount += 1;
      continue;
    }
    const comparisonPath = normalizePathForComparison(normalizedAbsolutePath);
    const skillId = buildCodexSkillId({
      hmacKey: input.hmacKey,
      workspaceId: input.workspaceId,
      name,
      scope,
      normalizedAbsolutePath: comparisonPath,
    });
    if (seenSkillIds.has(skillId)) {
      skippedSkillCount += 1;
      continue;
    }
    seenSkillIds.add(skillId);
    const skillInterface = asRecord(skill.interface);
    const displayName = sanitizeMetadataText(skillInterface?.displayName, knownPaths, SAFE_DISPLAY_NAME_MAX_CHARS);
    const description = sanitizeMetadataText(
      skillInterface?.shortDescription ?? skill.shortDescription ?? skill.description,
      knownPaths,
      SAFE_DESCRIPTION_MAX_CHARS,
    );
    entries.push({
      skillId,
      name,
      path: normalizedAbsolutePath,
      comparisonPath,
      scope,
      displayName,
      description,
    });
  }

  if (entries.length === 0 && group.errors.length > 0) {
    throw createCodexInputActionCatalogError(`Provider 发现失败（${group.errors.length} 项）`);
  }
  return {
    entries,
    providerErrorCount: group.errors.length,
    skippedSkillCount,
  };
}

function collectKnownAbsolutePaths(skills: unknown[]): string[] {
  const values = new Set<string>();
  for (const rawSkill of skills) {
    const rawPath = String(asRecord(rawSkill)?.path ?? "").trim();
    if (!rawPath || !path.isAbsolute(rawPath)) continue;
    values.add(rawPath);
    values.add(path.normalize(path.resolve(rawPath)));
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function sanitizeMetadataText(value: unknown, knownPaths: readonly string[], maxChars: number): string | null {
  if (typeof value !== "string") return null;
  let text = value;
  for (const knownPath of knownPaths) text = replaceExactPath(text, knownPath, SKILL_PATH_PLACEHOLDER);
  text = text.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return text.slice(0, maxChars);
}

function replaceExactPath(text: string, target: string, replacement: string): string {
  if (!target) return text;
  if (process.platform !== "win32") return text.split(target).join(replacement);
  const lowerText = text.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let cursor = 0;
  let next = "";
  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerTarget, cursor);
    if (index < 0) return `${next}${text.slice(cursor)}`;
    next += `${text.slice(cursor, index)}${replacement}`;
    cursor = index + target.length;
  }
  return next;
}

function buildCatalogWarning(catalog: ParsedCodexSkillCatalog): string | null {
  const warnings: string[] = [];
  if (catalog.providerErrorCount > 0) warnings.push(`Provider 有 ${catalog.providerErrorCount} 项发现错误`);
  if (catalog.skippedSkillCount > 0) warnings.push(`已跳过 ${catalog.skippedSkillCount} 个不可用候选`);
  return warnings.length ? warnings.join("；") : null;
}

function countNameScopes(entries: readonly CodexSkillCatalogEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = nameScopeKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function nameScopeKey(entry: Pick<CodexSkillCatalogEntry, "name" | "scope">): string {
  return JSON.stringify([entry.name, entry.scope]);
}

function normalizePathForComparison(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = path.normalize(path.resolve(raw));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCodexSkillScope(value: string): boolean {
  return value === "user" || value === "repo" || value === "system" || value === "admin";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
