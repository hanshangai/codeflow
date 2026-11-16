import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrchAssetType,
  SkillPackageFile,
  WorkspaceId,
} from "@codeflowai/shared";

import {
  createClientDbOrchAssetLegacyRuntimeReader,
  OrchAssetAuthorityRuntimeReadError,
  OrchAssetAuthorityRuntimeReadService,
  type OrchAssetAuthorityRuntimeAsset,
} from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";

test("legacy ClientDb adapter maps all five canonical definitions without presentation timestamps", () => {
  const definitions = legacyDefinitions();
  const reader = createClientDbOrchAssetLegacyRuntimeReader(legacyDb(definitions) as never);
  const assetTypes = Object.keys(definitions) as OrchAssetType[];

  for (const assetType of assetTypes) {
    const listed = reader.listAssets("workspace-1" as WorkspaceId, assetType);
    const fetched = reader.getAsset("workspace-1" as WorkspaceId, assetType, `${assetType}-1`);
    assert.equal(listed.length, 1);
    assert.equal(fetched?.assetType, assetType);
    assert.equal(fetched?.definition.id, `${assetType}-1`);
    assert.equal(fetched?.definition.workspaceId, "workspace-1");
    assert.equal(Object.hasOwn(fetched?.definition ?? {}, "createdAt"), false);
    assert.equal(Object.hasOwn(fetched?.definition ?? {}, "updatedAt"), false);
    assert.deepEqual(fetched?.source, { authorityMode: "legacy", createdAt: 10, updatedAt: 20 });
  }

  const skill = reader.getAsset("workspace-1" as WorkspaceId, "skill", "skill-1");
  assert.equal(skill?.definition.skillMd, "# Skill\n");
  assert.deepEqual(skill?.definition.files, [skillFile()]);
  assert.notEqual(skill?.definition.files, definitions.skill.files);
});

test("legacy adapter rejects cross-workspace data instead of returning it", () => {
  const definitions = legacyDefinitions();
  definitions.role.workspaceId = "workspace-2";
  const reader = createClientDbOrchAssetLegacyRuntimeReader(legacyDb(definitions) as never);

  assert.throws(
    () => reader.getAsset("workspace-1" as WorkspaceId, "role", "role-1"),
    (error: unknown) => error instanceof OrchAssetAuthorityRuntimeReadError
      && error.code === "ASSET_LEGACY_RUNTIME_DATA_INVALID"
      && /不属于运行工作区/.test(error.message),
  );
});

test("legacy adapter rejects incomplete Skill packages", () => {
  for (const invalidSkill of [
    { ...legacyDefinitions().skill, skillMd: null },
    { ...legacyDefinitions().skill, files: null },
    { ...legacyDefinitions().skill, files: [] },
    { ...legacyDefinitions().skill, files: [skillFile(), { ...skillFile() }] },
    { ...legacyDefinitions().skill, files: [{ ...skillFile(), kind: "reference" }] },
    { ...legacyDefinitions().skill, files: [{ ...skillFile(), contentText: null }] },
    { ...legacyDefinitions().skill, skillMd: "# Other\n" },
  ]) {
    const definitions = { ...legacyDefinitions(), skill: invalidSkill };
    const reader = createClientDbOrchAssetLegacyRuntimeReader(legacyDb(definitions) as never);
    assert.throws(
      () => reader.getAsset("workspace-1" as WorkspaceId, "skill", "skill-1"),
      (error: unknown) => error instanceof OrchAssetAuthorityRuntimeReadError
        && error.code === "ASSET_LEGACY_RUNTIME_DATA_INVALID"
        && /(缺少完整运行包|SKILL\.md 不完整或正文不一致)/.test(error.message),
    );
  }
});

/** Builds representative normalized definitions for each legacy repository. */
function legacyDefinitions() {
  return {
    role: {
      id: "role-1",
      workspaceId: "workspace-1",
      name: "Reviewer",
      description: "Reviews changes",
      systemPrompt: "Review carefully",
      inputDefinition: { description: "", requiredFields: [] },
      outputDefinition: { description: "", requiredFields: [] },
      gateCriteria: [],
      executionConfig: { preferredEngine: "codex" },
      kind: "custom",
      createdAt: 10,
      updatedAt: 20,
    },
    workflow: {
      id: "workflow-1",
      workspaceId: "workspace-1",
      name: "Review flow",
      description: "Runs review",
      nodes: [],
      edges: [],
      kind: "custom",
      version: 1,
      createdAt: 10,
      updatedAt: 20,
    },
    knowledge_bundle: {
      id: "knowledge_bundle-1",
      workspaceId: "workspace-1",
      name: "Docs",
      scope: "shared",
      description: "Product docs",
      sourceRefs: [],
      kind: "custom",
      createdAt: 10,
      updatedAt: 20,
    },
    toolset: {
      id: "toolset-1",
      workspaceId: "workspace-1",
      name: "Build tools",
      description: "Build helpers",
      tools: [],
      kind: "custom",
      createdAt: 10,
      updatedAt: 20,
    },
    skill: {
      id: "skill-1",
      workspaceId: "workspace-1",
      name: "Review skill",
      description: "Reviews code",
      trigger: "review",
      instructions: "Review carefully",
      targetEngines: ["codex"],
      kind: "custom",
      skillMd: "# Skill\n",
      files: [skillFile()],
      createdAt: 10,
      updatedAt: 20,
    },
  };
}

/** Creates the canonical text SKILL.md fixture. */
function skillFile(): SkillPackageFile {
  return {
    relPath: "SKILL.md",
    kind: "skill-md",
    contentText: "# Skill\n",
    contentBase64: null,
    contentType: "text/markdown",
    sizeBytes: 8,
    sha256: "b".repeat(64),
  };
}

/** Adapts one definition per canonical type to the five existing ClientDb repository shapes. */
function legacyDb(definitions: Record<OrchAssetType, { id: string; workspaceId: string }>) {
  const repo = (definition: { id: string; workspaceId: string }) => ({
    listByWorkspace(workspaceId: WorkspaceId) {
      return definition.workspaceId === workspaceId ? [definition] : [];
    },
    get(assetId: string) {
      return definition.id === assetId ? definition : null;
    },
  });
  return {
    orchRoles: repo(definitions.role),
    orchWorkflows: repo(definitions.workflow),
    orchKnowledgeBundles: repo(definitions.knowledge_bundle),
    orchToolsets: repo(definitions.toolset),
    orchSkills: repo(definitions.skill),
  };
}

test("本地读取会话保持工作区身份，缺失与读取失败按原仓储返回", () => {
  const failure = new Error("LOCAL_ASSET_READ_FAILED");
  const service = new OrchAssetAuthorityRuntimeReadService({
    listAssets: () => { throw failure; },
    getAsset: (workspaceId, type, id) => id === "missing" ? null : {
      assetType: type, assetId: id, definition: { id, workspaceId } as never,
      source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 },
    },
  });
  const session = service.openWorkspace("workspace-1" as WorkspaceId);
  assert.equal(session.authorityMode, "legacy");
  assert.equal(session.getAsset("role", "role-1")?.definition.workspaceId, "workspace-1");
  assert.equal(session.getAsset("role", "missing"), null);
  assert.throws(() => session.listAssets("role"), error => error === failure);
  assert.throws(() => service.openWorkspace(" workspace-1 " as WorkspaceId), { code: "ASSET_RUNTIME_WORKSPACE_INVALID" });
});

test("本地 reader 方法只捕获一次且整图读取复用原事务接收者", () => {
  let lists = 0, gets = 0, snapshots = 0, inSnapshot = false;
  const reader = {
    get listAssets() { lists++; return () => []; },
    get getAsset() { gets++; return () => null; },
    withReadSnapshot<T>(read: () => T, workspaceId?: WorkspaceId): T {
      assert.equal(this, reader); assert.equal(workspaceId, "workspace-1");
      snapshots++; inSnapshot = true;
      try { return read(); } finally { inSnapshot = false; }
    },
  };
  const service = new OrchAssetAuthorityRuntimeReadService(reader);
  service.withWorkspace("workspace-1" as WorkspaceId, session => {
    assert.equal(inSnapshot, true);
    assert.deepEqual(session.listAssets("role"), []);
    assert.equal(session.getAsset("role", "missing"), null);
  });
  assert.deepEqual([lists, gets, snapshots], [1, 1, 1]);
});
