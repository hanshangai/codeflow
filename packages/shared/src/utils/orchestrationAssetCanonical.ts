import type { OrchAssetType } from "../types/orchestrationAssets.js";
import type { SkillPackageFileKind } from "../types/orchestration.js";

export type OrchSkillPackageHashFile = {
  relPath: string;
  kind: SkillPackageFileKind;
  contentType?: string | null;
  sha256: string;
};

export type OrchAssetContentHashFile = OrchSkillPackageHashFile & {
  sizeBytes: number;
};

/** Serializes JSON with recursively sorted object keys and stable array order. */
export function canonicalizeOrchAssetJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value, "$"));
}

/** Builds the established Skill installation hash payload without including non-SKILL.md bodies. */
export function buildOrchSkillPackageHashPayload(input: {
  definition: Record<string, unknown>;
  skillMd: string;
  files: readonly OrchSkillPackageHashFile[];
}): Record<string, unknown> {
  return {
    name: input.definition.name,
    slug: input.definition.slug,
    description: input.definition.description,
    trigger: input.definition.trigger,
    instructions: input.definition.instructions,
    targetEngines: input.definition.targetEngines,
    tags: input.definition.tags ?? [],
    skillMd: input.skillMd,
    scripts: normalizeJsonValue(input.definition.scripts ?? [], "$.scripts"),
    autoInstall: input.definition.autoInstall === true,
    files: input.files.map((file) => ({
      relPath: file.relPath,
      kind: file.kind,
      contentType: file.contentType ?? null,
      sha256: file.sha256,
    })),
  };
}

/** Builds the canonical asset content hash payload from one definition and verified file metadata. */
export function buildOrchAssetContentHashPayload(input: {
  assetType: OrchAssetType;
  definition: Record<string, unknown>;
  skillFiles: readonly OrchAssetContentHashFile[];
}): Record<string, unknown> {
  return {
    assetType: input.assetType,
    definition: input.definition,
    skillFiles: input.skillFiles.map((file) => ({
      relPath: file.relPath,
      kind: file.kind,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  };
}

/** Compares strings by Unicode code point for cross-language canonical ordering. */
export function compareOrchAssetCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Checks that a value is a plain JSON object. */
export function isPlainOrchAssetRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Converts one value into plain deterministic JSON or fails on unsupported input. */
function normalizeJsonValue(value: unknown, fieldPath: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${fieldPath} 必须是有限数字`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${fieldPath}[${index}]`));
  }
  if (!isPlainOrchAssetRecord(value)) throw new Error(`${fieldPath} 包含非 JSON 值`);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort(compareOrchAssetCodePoints)) {
    const child = value[key];
    if (child === undefined) continue;
    output[key] = normalizeJsonValue(child, `${fieldPath}.*`);
  }
  return output;
}
