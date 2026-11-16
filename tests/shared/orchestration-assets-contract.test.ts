import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCH_ASSET_TYPES,
  WORKFLOW_FAMILIES,
  isOrchAssetType,
  orchAssetGroupTypeFromType,
  orchAssetTypeFromGroupType,
  orchAssetTypeFromSharedAudit,
} from "../../packages/shared/src/index.ts";
import type {
  ApiErrorCode,
  OrchAssetDefinitionByType,
  OrchAssetBundlesImportRequestBody,
  OrchAssetBundlesImportResponseBody,
  OrchAssetListMetadata,
  OrchAssetGroupsAssignResponseBody,
  OrchAssetGroupsCreateResponseBody,
  OrchAssetGroupsDeleteResponseBody,
  OrchAssetGroupsRenameResponseBody,
  OrchAssetSkillMutationFile,
  OrchKnowledgeBundlesListResponseBody,
  OrchKnowledgeBundlesDeleteRequestBody,
  OrchKnowledgeBundlesDeleteResponseBody,
  OrchKnowledgeBundlesUpsertRequestBody,
  OrchKnowledgeBundlesUpsertResponseBody,
  OrchRolesDeleteRequestBody,
  OrchRolesDeleteResponseBody,
  OrchRolesListResponseBody,
  OrchRolesUpsertRequestBody,
  OrchRolesUpsertResponseBody,
  OrchSkillsDeleteRequestBody,
  OrchSkillsDeleteResponseBody,
  OrchSkillsListResponseBody,
  OrchSkillsUpsertRequestBody,
  OrchSkillsUpsertResponseBody,
  OrchToolsetsDeleteRequestBody,
  OrchToolsetsDeleteResponseBody,
  OrchToolsetsListResponseBody,
  OrchToolsetsUpsertRequestBody,
  OrchToolsetsUpsertResponseBody,
  OrchWorkflowsDeleteRequestBody,
  OrchWorkflowsDeleteResponseBody,
  OrchWorkflowsListResponseBody,
  OrchWorkflowsUpsertRequestBody,
  OrchWorkflowsUpsertResponseBody,
} from "../../packages/shared/src/index.ts";

const ownerMutationErrorCodes = [
  "MUTATION_REQUEST_INVALID",
  "MUTATION_LIMIT_EXCEEDED",
  "MUTATION_DUPLICATE_ASSET",
  "ASSET_REVISION_CONFLICT",
  "ASSET_DEPENDENCY_MISSING",
  "ASSET_DEPENDENCY_IN_USE",
  "ASSET_IDEMPOTENCY_CONFLICT",
] as const satisfies readonly ApiErrorCode[];

const assetGroupErrorCodes = [
  "ASSET_GROUP_ASSIGNMENT_INVALID",
  "ASSET_GROUP_NAME_CONFLICT",
  "ASSET_GROUP_NAME_INVALID",
  "ASSET_GROUP_NOT_FOUND",
  "ASSET_GROUP_REQUEST_INVALID",
] as const satisfies readonly ApiErrorCode[];

const assetBundleImportErrorCodes = [
  "ASSET_BUNDLE_INVALID",
  "ASSET_BUNDLE_LIMIT_EXCEEDED",
  "ASSET_COPY_TARGET_CONFLICT",
] as const satisfies readonly ApiErrorCode[];

const textMutationFile: OrchAssetSkillMutationFile = {
  relPath: "SKILL.md", kind: "skill-md", contentType: "text/markdown", sizeBytes: 0, sha256: "0", contentText: "",
};
const binaryMutationFile: OrchAssetSkillMutationFile = {
  relPath: "assets/empty.bin", kind: "asset", contentType: "application/octet-stream", sizeBytes: 0, sha256: "0", contentBase64: "",
};
// @ts-expect-error Skill mutation files require exactly one body field.
const missingBodyMutationFile: OrchAssetSkillMutationFile = { relPath: "assets/missing", kind: "asset", contentType: "application/octet-stream", sizeBytes: 0, sha256: "0" };
// @ts-expect-error Skill mutation files cannot contain both body fields.
const duplicateBodyMutationFile: OrchAssetSkillMutationFile = { relPath: "assets/both", kind: "asset", contentType: "application/octet-stream", sizeBytes: 0, sha256: "0", contentText: "x", contentBase64: "eA==" };
const roleListMetadata: OrchAssetListMetadata<"role"> = {
  assetType: "role",
  assetId: "role-1",
  revision: 3,
  scopeType: "user",
  contentHash: "a".repeat(64),
};
const typedAssetListResponses = {
  role: { roles: [], assetMetadata: [roleListMetadata] } satisfies OrchRolesListResponseBody,
  workflow: { workflows: [], assetMetadata: [listMetadata("workflow")] } satisfies OrchWorkflowsListResponseBody,
  knowledge_bundle: { bundles: [], assetMetadata: [listMetadata("knowledge_bundle")] } satisfies OrchKnowledgeBundlesListResponseBody,
  toolset: { toolsets: [], assetMetadata: [listMetadata("toolset")] } satisfies OrchToolsetsListResponseBody,
  skill: { skills: [], assetMetadata: [listMetadata("skill")] } satisfies OrchSkillsListResponseBody,
};
const legacyRoleListResponse = { roles: [] } satisfies OrchRolesListResponseBody;
const mismatchedRoleListResponse: OrchRolesListResponseBody = {
  roles: [],
  assetMetadata: [{
    // @ts-expect-error Role list metadata cannot describe a workflow.
    assetType: "workflow",
    assetId: "workflow-1",
    revision: 1,
    scopeType: "builtin",
    contentHash: "b".repeat(64),
  }],
};
const typedSingleMutationContracts = {
  role: {
    upsertRequest: {
      workspaceId: "workspace-1" as OrchRolesUpsertRequestBody["workspaceId"],
      role: {} as OrchRolesUpsertRequestBody["role"],
      clientRequestId: "client-role-upsert",
      expectedRevision: null,
    } satisfies OrchRolesUpsertRequestBody,
    upsertResponse: {
      role: {} as OrchRolesUpsertResponseBody["role"],
      changeSeq: 1,
      cacheStatus: "pending",
      assetMetadata: listMetadata("role"),
    } satisfies OrchRolesUpsertResponseBody,
    deleteRequest: {
      workspaceId: "workspace-1" as OrchRolesDeleteRequestBody["workspaceId"],
      roleId: "role-1" as OrchRolesDeleteRequestBody["roleId"],
      clientRequestId: "client-role-delete",
      expectedRevision: 1,
    } satisfies OrchRolesDeleteRequestBody,
    deleteResponse: { changeSeq: 2, cacheStatus: "pending" } satisfies OrchRolesDeleteResponseBody,
  },
  workflow: {
    upsertRequest: {
      workspaceId: "workspace-1" as OrchWorkflowsUpsertRequestBody["workspaceId"],
      workflow: {} as OrchWorkflowsUpsertRequestBody["workflow"],
      clientRequestId: "client-workflow-upsert",
      expectedRevision: null,
    } satisfies OrchWorkflowsUpsertRequestBody,
    upsertResponse: {
      workflow: {} as OrchWorkflowsUpsertResponseBody["workflow"],
      changeSeq: 1,
      cacheStatus: "pending",
      assetMetadata: listMetadata("workflow"),
    } satisfies OrchWorkflowsUpsertResponseBody,
    deleteRequest: {
      workspaceId: "workspace-1" as OrchWorkflowsDeleteRequestBody["workspaceId"],
      workflowId: "workflow-1" as OrchWorkflowsDeleteRequestBody["workflowId"],
      clientRequestId: "client-workflow-delete",
      expectedRevision: 1,
    } satisfies OrchWorkflowsDeleteRequestBody,
    deleteResponse: { changeSeq: 2, cacheStatus: "pending" } satisfies OrchWorkflowsDeleteResponseBody,
  },
  knowledge_bundle: {
    upsertRequest: {
      workspaceId: "workspace-1" as OrchKnowledgeBundlesUpsertRequestBody["workspaceId"],
      bundle: {} as OrchKnowledgeBundlesUpsertRequestBody["bundle"],
      clientRequestId: "client-knowledge-upsert",
      expectedRevision: null,
    } satisfies OrchKnowledgeBundlesUpsertRequestBody,
    upsertResponse: {
      bundle: {} as OrchKnowledgeBundlesUpsertResponseBody["bundle"],
      changeSeq: 1,
      cacheStatus: "pending",
      assetMetadata: listMetadata("knowledge_bundle"),
    } satisfies OrchKnowledgeBundlesUpsertResponseBody,
    deleteRequest: {
      workspaceId: "workspace-1" as OrchKnowledgeBundlesDeleteRequestBody["workspaceId"],
      bundleId: "knowledge_bundle-1" as OrchKnowledgeBundlesDeleteRequestBody["bundleId"],
      clientRequestId: "client-knowledge-delete",
      expectedRevision: 1,
    } satisfies OrchKnowledgeBundlesDeleteRequestBody,
    deleteResponse: { changeSeq: 2, cacheStatus: "pending" } satisfies OrchKnowledgeBundlesDeleteResponseBody,
  },
  toolset: {
    upsertRequest: {
      workspaceId: "workspace-1" as OrchToolsetsUpsertRequestBody["workspaceId"],
      toolset: {} as OrchToolsetsUpsertRequestBody["toolset"],
      clientRequestId: "client-toolset-upsert",
      expectedRevision: null,
    } satisfies OrchToolsetsUpsertRequestBody,
    upsertResponse: {
      toolset: {} as OrchToolsetsUpsertResponseBody["toolset"],
      changeSeq: 1,
      cacheStatus: "pending",
      assetMetadata: listMetadata("toolset"),
    } satisfies OrchToolsetsUpsertResponseBody,
    deleteRequest: {
      workspaceId: "workspace-1" as OrchToolsetsDeleteRequestBody["workspaceId"],
      toolsetId: "toolset-1" as OrchToolsetsDeleteRequestBody["toolsetId"],
      clientRequestId: "client-toolset-delete",
      expectedRevision: 1,
    } satisfies OrchToolsetsDeleteRequestBody,
    deleteResponse: { changeSeq: 2, cacheStatus: "pending" } satisfies OrchToolsetsDeleteResponseBody,
  },
  skill: {
    upsertRequest: {
      workspaceId: "workspace-1" as OrchSkillsUpsertRequestBody["workspaceId"],
      skill: {} as OrchSkillsUpsertRequestBody["skill"],
      clientRequestId: "client-skill-upsert",
      expectedRevision: null,
    } satisfies OrchSkillsUpsertRequestBody,
    upsertResponse: {
      skill: {} as OrchSkillsUpsertResponseBody["skill"],
      changeSeq: 1,
      cacheStatus: "pending",
      assetMetadata: listMetadata("skill"),
    } satisfies OrchSkillsUpsertResponseBody,
    deleteRequest: {
      workspaceId: "workspace-1" as OrchSkillsDeleteRequestBody["workspaceId"],
      skillId: "skill-1" as OrchSkillsDeleteRequestBody["skillId"],
      clientRequestId: "client-skill-delete",
      expectedRevision: 1,
    } satisfies OrchSkillsDeleteRequestBody,
    deleteResponse: { changeSeq: 2, cacheStatus: "pending" } satisfies OrchSkillsDeleteResponseBody,
  },
};
const legacyRoleUpsertRequest = {
  workspaceId: "workspace-1" as OrchRolesUpsertRequestBody["workspaceId"],
  role: {} as OrchRolesUpsertRequestBody["role"],
} satisfies OrchRolesUpsertRequestBody;
const legacyRoleUpsertResponse = {
  role: {} as OrchRolesUpsertResponseBody["role"],
} satisfies OrchRolesUpsertResponseBody;
const mismatchedRoleMutationResponse: OrchRolesUpsertResponseBody = {
  role: {} as OrchRolesUpsertResponseBody["role"],
  assetMetadata: {
    // @ts-expect-error Role mutation metadata cannot describe a workflow.
    assetType: "workflow",
    assetId: "workflow-1",
    revision: 1,
    scopeType: "user",
    contentHash: "c".repeat(64),
  },
};
const groupMutationResponses = {
  create: {
    group: {
      id: "group-1",
      workspaceId: "workspace-1",
      assetType: "role",
      name: "Reviewers",
      createdAt: 1,
      updatedAt: 1,
    },
    changeSeq: 3,
    cacheStatus: "pending",
  } satisfies OrchAssetGroupsCreateResponseBody,
  rename: {
    group: {
      id: "group-1",
      workspaceId: "workspace-1",
      assetType: "role",
      name: "Senior Reviewers",
      createdAt: 1,
      updatedAt: 2,
    },
    changeSeq: 4,
    cacheStatus: "pending",
  } satisfies OrchAssetGroupsRenameResponseBody,
  delete: {
    removedAssignmentCount: 2,
    changeSeq: 5,
    cacheStatus: "pending",
  } satisfies OrchAssetGroupsDeleteResponseBody,
  assign: {
    groupId: "group-1",
    changed: true,
    changeSeq: 6,
    cacheStatus: "pending",
  } satisfies OrchAssetGroupsAssignResponseBody,
};
const serverBundleImportRequest = {
  workspaceId: "workspace-1" as OrchAssetBundlesImportRequestBody["workspaceId"],
  bundle: {} as OrchAssetBundlesImportRequestBody["bundle"],
  importMode: "copy",
  clientRequestId: "web_bundle-import",
} satisfies OrchAssetBundlesImportRequestBody;
const serverBundleImportResponse = {
  imported: {
    roles: [{} as OrchAssetBundlesImportResponseBody["imported"]["roles"][number]],
    knowledgeBundles: [],
    skills: [],
    toolsets: [],
    workflows: [],
    warnings: [],
    overwritten: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    copied: { roles: 1, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
  },
  changeSeq: 7,
  cacheStatus: "pending",
  assetMetadata: [listMetadata("role")],
} satisfies OrchAssetBundlesImportResponseBody;
const legacyBundleImportRequest = {
  workspaceId: "workspace-1" as OrchAssetBundlesImportRequestBody["workspaceId"],
  bundle: {} as OrchAssetBundlesImportRequestBody["bundle"],
} satisfies OrchAssetBundlesImportRequestBody;
const legacyBundleImportResponse = {
  imported: serverBundleImportResponse.imported,
} satisfies OrchAssetBundlesImportResponseBody;

test("orchestration asset contract exposes only canonical Server types", () => {
  assert.deepEqual(ORCH_ASSET_TYPES, ["role", "workflow", "knowledge_bundle", "toolset", "skill"]);
  for (const assetType of ORCH_ASSET_TYPES) assert.equal(isOrchAssetType(assetType), true);
  for (const alias of ["agent", "knowledge", "knowledgeBundle", "knowledge-bundle", "custom"]) {
    assert.equal(isOrchAssetType(alias), false);
  }
});

test("owner mutation failures are stable public API error codes", () => {
  assert.deepEqual(ownerMutationErrorCodes, [
    "MUTATION_REQUEST_INVALID",
    "MUTATION_LIMIT_EXCEEDED",
    "MUTATION_DUPLICATE_ASSET",
    "ASSET_REVISION_CONFLICT",
    "ASSET_DEPENDENCY_MISSING",
    "ASSET_DEPENDENCY_IN_USE",
    "ASSET_IDEMPOTENCY_CONFLICT",
  ]);
});

test("asset group failures and rolling mutation metadata are public HTTP contracts", () => {
  assert.equal(assetGroupErrorCodes.length, 5);
  assert.equal(groupMutationResponses.create.group.assetType, "role");
  assert.equal(groupMutationResponses.rename.changeSeq, 4);
  assert.equal(groupMutationResponses.delete.removedAssignmentCount, 2);
  assert.equal(groupMutationResponses.assign.changed, true);
});

test("bundle import exposes rolling request, result metadata, and stable public failures", () => {
  assert.deepEqual(assetBundleImportErrorCodes, [
    "ASSET_BUNDLE_INVALID",
    "ASSET_BUNDLE_LIMIT_EXCEEDED",
    "ASSET_COPY_TARGET_CONFLICT",
  ]);
  assert.equal(serverBundleImportRequest.clientRequestId, "web_bundle-import");
  assert.equal(serverBundleImportResponse.changeSeq, 7);
  assert.equal(serverBundleImportResponse.assetMetadata[0]?.assetType, "role");
  assert.equal(Object.hasOwn(legacyBundleImportRequest, "clientRequestId"), false);
  assert.equal(Object.hasOwn(legacyBundleImportResponse, "changeSeq"), false);
});

test("legacy asset vocabularies map only through explicit adapters", () => {
  assert.equal(orchAssetTypeFromGroupType("knowledge"), "knowledge_bundle");
  assert.equal(orchAssetGroupTypeFromType("knowledge_bundle"), "knowledge");
  assert.equal(orchAssetTypeFromSharedAudit("agent"), "role");
  assert.equal(orchAssetTypeFromGroupType("workflow"), "workflow");
  assert.equal(orchAssetGroupTypeFromType("skill"), "skill");
});

test("workflow family contract includes every current built-in family", () => {
  assert.deepEqual(WORKFLOW_FAMILIES, ["feature-dev", "generic-kb", "bugfix", "analysis"]);
});

test("Skill mutation file contract carries exactly one complete body", () => {
  assert.equal(textMutationFile.contentText, "");
  assert.equal(binaryMutationFile.contentBase64, "");
  assert.equal(missingBodyMutationFile.relPath, "assets/missing");
  assert.equal(duplicateBodyMutationFile.relPath, "assets/both");
});

test("five list responses expose typed metadata without requiring it from legacy paths", () => {
  assert.deepEqual(Object.keys(typedAssetListResponses), [
    "role", "workflow", "knowledge_bundle", "toolset", "skill",
  ]);
  assert.equal(typedAssetListResponses.role.assetMetadata[0]?.revision, 3);
  assert.equal(typedAssetListResponses.skill.assetMetadata[0]?.assetType, "skill");
  assert.equal(Object.hasOwn(legacyRoleListResponse, "assetMetadata"), false);
  assert.equal(mismatchedRoleListResponse.assetMetadata?.[0]?.assetType, "workflow");
});

test("five legacy single-asset write contracts carry rolling Server mutation metadata", () => {
  assert.deepEqual(Object.keys(typedSingleMutationContracts), [
    "role", "workflow", "knowledge_bundle", "toolset", "skill",
  ]);
  for (const contract of Object.values(typedSingleMutationContracts)) {
    assert.equal(contract.upsertRequest.expectedRevision, null);
    assert.equal(contract.upsertResponse.cacheStatus, "pending");
    assert.equal(contract.deleteRequest.expectedRevision, 1);
    assert.equal(contract.deleteResponse.changeSeq, 2);
  }
  assert.equal(Object.hasOwn(legacyRoleUpsertRequest, "clientRequestId"), false);
  assert.equal(Object.hasOwn(legacyRoleUpsertResponse, "changeSeq"), false);
  assert.equal(mismatchedRoleMutationResponse.assetMetadata?.assetType, "workflow");
});

/** Builds one correctly discriminated list metadata fixture. */
function listMetadata<T extends OrchAssetListMetadata["assetType"]>(assetType: T): OrchAssetListMetadata<T> {
  return {
    assetType,
    assetId: `${assetType}-1`,
    revision: 1,
    scopeType: "builtin",
    contentHash: "b".repeat(64),
  };
}
