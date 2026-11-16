import type { KnowledgeBundleDefinition, RoleDefinition, SkillDefinition, ToolsetDefinition, WorkflowDefinition } from "../types/orchestration.js";

export const ORCH_ASSET_BUNDLE_SCHEMA_VERSION = "orch-asset-bundle/v1" as const;
export const ORCH_ASSET_BUNDLE_IMPORT_MODES = ["overwrite", "skip_existing", "copy"] as const;

export type OrchAssetBundleImportMode = typeof ORCH_ASSET_BUNDLE_IMPORT_MODES[number];

export type OrchAssetBundleImportCounts = {
  roles: number;
  knowledgeBundles: number;
  skills: number;
  toolsets: number;
  workflows: number;
};

export type OrchAssetBundleWarning = {
  code: "missing_dependency";
  ownerKind: "role" | "workflow";
  ownerSourceId: string;
  ownerName?: string | null;
  ownerNodeId?: string | null;
  dependencyKind: "role" | "knowledge" | "skill" | "toolset";
  dependencyId: string;
  message: string;
};

/** Normalize asset bundle import mode; blank input keeps legacy overwrite behavior. */
export function normalizeOrchAssetBundleImportMode(value: unknown): OrchAssetBundleImportMode {
  if (value == null || value === "") return "overwrite";
  if (value === "overwrite" || value === "skip_existing" || value === "copy") return value;
  throw new Error(`不支持的资产包导入方式：${String(value)}`);
}

export type EditableBundleRole = Omit<RoleDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">;
export type EditableBundleKnowledgeBundle = Omit<KnowledgeBundleDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">;
export type EditableBundleSkill = Omit<SkillDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">;
export type EditableBundleToolset = Omit<ToolsetDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">;
export type EditableBundleWorkflow = Omit<WorkflowDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">;

export type OrchAssetBundleRoleEntry = {
  sourceId: string;
  role: EditableBundleRole;
};

export type OrchAssetBundleKnowledgeEntry = {
  sourceId: string;
  knowledgeBundle: EditableBundleKnowledgeBundle;
};

export type OrchAssetBundleSkillEntry = {
  sourceId: string;
  skill: EditableBundleSkill;
};

export type OrchAssetBundleToolsetEntry = {
  sourceId: string;
  toolset: EditableBundleToolset;
};

export type OrchAssetBundleWorkflowEntry = {
  sourceId: string;
  workflow: EditableBundleWorkflow;
};

export type OrchAssetBundle = {
  schemaVersion: typeof ORCH_ASSET_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  bundleVersion: number;
  title: string;
  description?: string | null;
  generatedAt: number;
  source: {
    kind: "server-default" | "workspace-export";
    label?: string | null;
    workspaceId?: string | null;
  };
  roles: OrchAssetBundleRoleEntry[];
  knowledgeBundles: OrchAssetBundleKnowledgeEntry[];
  skills?: OrchAssetBundleSkillEntry[];
  toolsets: OrchAssetBundleToolsetEntry[];
  workflows: OrchAssetBundleWorkflowEntry[];
  warnings?: OrchAssetBundleWarning[];
};
