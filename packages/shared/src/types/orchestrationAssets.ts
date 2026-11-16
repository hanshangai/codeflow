import type {
  KnowledgeBundleDefinition,
  OrchAssetGroupType,
  RoleDefinition,
  SkillDefinition,
  SkillPackageFile,
  SkillPackageFileKind,
  ToolsetDefinition,
  WorkflowDefinition,
} from "./orchestration.js";

export const ORCH_ASSET_TYPES = ["role", "workflow", "knowledge_bundle", "toolset", "skill"] as const;
export type OrchAssetType = (typeof ORCH_ASSET_TYPES)[number];
export type OrchAssetScopeType = "builtin" | "user" | "shared_workspace";
export type OrchAssetAuthorityMode = "legacy" | "server";
export type OrchAssetActorType = "user" | "system";
export type OrchAssetDraftStatus = "active" | "deleted";
export type OrchAssetPublishedStatus = "unpublished" | "active" | "deleted";
export type OrchAssetSourceKind = "manual" | "import" | "ai_draft" | "migration" | "rollback";
export type OrchAssetCacheStatus = "ready" | "pending" | "stale" | "failed";

type StripRuntimeFields<T> = Omit<T, "workspaceId" | "createdAt" | "updatedAt">;

export type OrchAssetDefinitionByType = {
  role: StripRuntimeFields<RoleDefinition>;
  workflow: StripRuntimeFields<WorkflowDefinition>;
  knowledge_bundle: StripRuntimeFields<KnowledgeBundleDefinition>;
  toolset: StripRuntimeFields<ToolsetDefinition>;
  skill: Omit<StripRuntimeFields<SkillDefinition>, "skillMd" | "files">;
};

export type OrchAssetDefinition = OrchAssetDefinitionByType[OrchAssetType];

export type OrchAssetScopeRef =
  | { scopeType: "user"; ownerUserId: string }
  | { scopeType: "shared_workspace"; sharedWorkspaceId: string };

export type OrchAssetContext =
  | { kind: "personal"; userId: string }
  | { kind: "shared_workspace"; sharedWorkspaceId: string };

/** Describes where a shared Server asset is enabled without copying its definition. */
export type OrchAssetApplicationTarget =
  | { kind: "personal"; userId: string }
  | { kind: "shared_workspace"; sharedWorkspaceId: string }
  | { kind: "enterprise_shared_workspaces"; enterpriseId: string };

/** Public application binding metadata; the asset remains owned by its original scope. */
export type OrchAssetApplication = {
  assetId: string;
  target: OrchAssetApplicationTarget;
  appliedByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type OrchAssetApplicationRequest = {
  assetType: OrchAssetType;
  assetId: string;
  sourceContext: OrchAssetContext;
  targets: OrchAssetApplicationTarget[];
};

/** Carries revision metadata returned beside one legacy-compatible list definition. */
export type OrchAssetListMetadata<T extends OrchAssetType = OrchAssetType> = {
  assetType: T;
  assetId: string;
  revision: number;
  scopeType: OrchAssetScopeType;
  contentHash: string;
};

type OrchAssetSkillMutationFileBase = {
  relPath: string;
  kind: SkillPackageFileKind;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

/** Carries exactly one complete text or Base64 body for a Skill mutation. */
export type OrchAssetSkillMutationFile = OrchAssetSkillMutationFileBase & (
  | { contentText: string; contentBase64?: null }
  | { contentText?: null; contentBase64: string }
);

type OrchAssetUpsertOperation<T extends OrchAssetType> = {
    operation: "upsert";
    assetType: T;
    assetId: string;
    expectedRevision: number | null;
    definition: OrchAssetDefinitionByType[T];
  } & (T extends "skill" ? { skillFiles: OrchAssetSkillMutationFile[] } : { skillFiles?: never });

export type OrchAssetMutationOperation =
  | { [T in OrchAssetType]: OrchAssetUpsertOperation<T> }[OrchAssetType]
  | {
    operation: "delete";
    assetType: OrchAssetType;
    assetId: string;
    expectedRevision: number;
  };

export type OrchAssetMutationRequest = {
  clientRequestId: string;
  assetContext: OrchAssetContext;
  operations: OrchAssetMutationOperation[];
};

export type OrchAssetMutationResponse = {
  changeSeq: number;
  cacheStatus: OrchAssetCacheStatus;
  assets: Array<{ assetId: string; revision: number; contentHash: string }>;
};

/** Returns true only for canonical Server asset type values. */
export function isOrchAssetType(value: unknown): value is OrchAssetType {
  return typeof value === "string" && (ORCH_ASSET_TYPES as readonly string[]).includes(value);
}

/** Maps the legacy grouping vocabulary into the canonical Server vocabulary. */
export function orchAssetTypeFromGroupType(value: OrchAssetGroupType): OrchAssetType {
  return value === "knowledge" ? "knowledge_bundle" : value;
}

/** Maps a canonical Server type back to the existing grouping component boundary. */
export function orchAssetGroupTypeFromType(value: OrchAssetType): OrchAssetGroupType {
  return value === "knowledge_bundle" ? "knowledge" : value;
}

/** Maps the legacy shared audit type into the canonical Server vocabulary. */
export function orchAssetTypeFromSharedAudit(value: "agent" | "workflow" | "knowledge_bundle" | "toolset" | "skill"): OrchAssetType {
  return value === "agent" ? "role" : value;
}
