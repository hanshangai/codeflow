import type { OrchAssetType } from "../types/orchestrationAssets.js";

import { isPlainOrchAssetRecord } from "./orchestrationAssetCanonical.js";

export type OrchAssetDependencyReference = {
  targetAssetId: string;
  targetAssetType: OrchAssetType;
  referencePath: string;
};

/** Extracts the typed dependency fields defined by the canonical asset contract. */
export function collectOrchAssetDependencyReferences(
  assetType: OrchAssetType,
  definition: Record<string, unknown>,
): OrchAssetDependencyReference[] {
  if (!isPlainOrchAssetRecord(definition)) throw new Error("definition 必须是普通对象");
  const dependencies: OrchAssetDependencyReference[] = [];
  if (assetType === "role") {
    addIdDependencies(dependencies, definition.defaultKnowledgeBundleIds, "knowledge_bundle", "defaultKnowledgeBundleIds");
    addIdDependencies(dependencies, definition.defaultSkillIds, "skill", "defaultSkillIds");
    for (const [index, value] of optionalArray(definition.toolRefs, "toolRefs").entries()) {
      if (!isPlainOrchAssetRecord(value)) throw new Error(`toolRefs[${index}] 必须是普通对象`);
      dependencies.push({
        targetAssetId: requiredId(value.toolsetId, `toolRefs[${index}].toolsetId`),
        targetAssetType: "toolset",
        referencePath: `toolRefs[${index}].toolsetId`,
      });
    }
  }
  if (assetType === "workflow") {
    addIdDependencies(dependencies, definition.workflowKnowledgeBundleIds, "knowledge_bundle", "workflowKnowledgeBundleIds");
    for (const [index, value] of requiredArray(definition.nodes, "nodes").entries()) {
      if (!isPlainOrchAssetRecord(value)) throw new Error(`nodes[${index}] 必须是普通对象`);
      if (value.roleId != null) {
        dependencies.push({
          targetAssetId: requiredId(value.roleId, `nodes[${index}].roleId`),
          targetAssetType: "role",
          referencePath: `nodes[${index}].roleId`,
        });
      }
      addIdDependencies(
        dependencies,
        value.knowledgeOverrideBundleIds,
        "knowledge_bundle",
        `nodes[${index}].knowledgeOverrideBundleIds`,
      );
    }
  }
  return dependencies;
}

/** Adds one dependency edge per unique normalized ID in an optional list. */
function addIdDependencies(
  output: OrchAssetDependencyReference[],
  value: unknown,
  targetAssetType: OrchAssetType,
  fieldPath: string,
): void {
  const ids = optionalArray(value, fieldPath);
  const seen = new Set<string>();
  for (const [index, raw] of ids.entries()) {
    const targetAssetId = requiredId(raw, `${fieldPath}[${index}]`);
    if (seen.has(targetAssetId)) throw new Error(`${fieldPath}[${index}] 不能重复`);
    seen.add(targetAssetId);
    output.push({ targetAssetId, targetAssetType, referencePath: `${fieldPath}[${index}]` });
  }
}

/** Reads an optional nullable array without coercing malformed values. */
function optionalArray(value: unknown, fieldPath: string): unknown[] {
  if (value == null) return [];
  return requiredArray(value, fieldPath);
}

/** Requires one array value. */
function requiredArray(value: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${fieldPath} 必须是数组`);
  return value;
}

/** Requires one already-normalized non-empty dependency ID. */
function requiredId(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${fieldPath} 必须是规范非空 ID`);
  }
  return value;
}
