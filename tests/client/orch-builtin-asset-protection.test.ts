import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId, SkillDefinition } from "../../packages/shared/src/index.ts";
import { createDefaultRoleExecutionConfig } from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { listChatWorkflowCardIds, seedChatWorkflowCard } from "../support/chat-workflow-card-fixture.ts";
import {
  handleOrchKnowledgeBundlesDelete,
  handleOrchKnowledgeBundlesUpsert,
  handleOrchRolesDelete,
  handleOrchRolesUpsert,
  handleOrchSkillsUpsert,
  handleOrchToolsetsDelete,
  handleOrchWorkflowsDelete,
} from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";

function createHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-builtin-protect-"));
  const workspaceId = "ws-builtin-protect" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  let response: any = null;
  const ctx = {
    workspaces: new Map([[workspaceId, workspacePath]]),
    db,
    loadServerDefaultBundles: async () => [],
    send(message: unknown) {
      response = message;
    },
  } as any;
  return {
    ctx,
    db,
    workspaceId,
    getResponse() {
      return response;
    },
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("builtin orchestration assets cannot be deleted except orphaned knowledge bundles", async () => {
  const harness = createHarness();
  try {
    const role = harness.db.orchRoles.upsert({
      id: "role-builtin" as any,
      workspaceId: harness.workspaceId,
      name: "内置角色",
      description: "测试",
      responsibility: "测试",
      systemPrompt: "您负责测试。",
      inputDefinition: { instructions: "输入", requiredFields: [] },
      outputDefinition: {
        instructions: "",
        deliveryMode: "direct",
        format: "markdown",
        resultKey: null,
        filePathRule: null,
        requiredFields: [],
      },
      gateCriteria: [],
      executionConfig: createDefaultRoleExecutionConfig("codex"),
      defaultKnowledgeBundleIds: [],
      toolRefs: [],
      kind: "builtin",
    });
    const workflow = harness.db.orchWorkflows.upsert({
      id: "workflow-builtin" as any,
      workspaceId: harness.workspaceId,
      name: "内置流程",
      description: "测试",
      nodes: [
        { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "end", type: "end", label: "结束", position: { x: 160, y: 0 } },
      ],
      edges: [],
      version: 1,
      kind: "builtin",
    });
    const toolset = harness.db.orchToolsets.upsert({
      id: "toolset-builtin" as any,
      workspaceId: harness.workspaceId,
      name: "内置工具集",
      description: "测试",
      tools: [],
      kind: "builtin",
    });
    const bundle = harness.db.orchKnowledgeBundles.upsert({
      id: "knowledge-builtin" as any,
      workspaceId: harness.workspaceId,
      name: "内置知识库",
      scope: "shared",
      description: "测试",
      sourceRefs: [],
      kind: "builtin",
    });

    handleOrchRolesDelete(harness.ctx, {
      t: "api.req",
      id: "req-role-delete",
      method: "orch.roles.delete",
      path: "/orch/roles/delete",
      body: { workspaceId: harness.workspaceId, roleId: role.id },
    } as any);
    assert.equal(harness.getResponse()?.status, 403);
    assert.match(String(harness.getResponse()?.body?.message ?? ""), /内置角色不可删除/);
    assert.ok(harness.db.orchRoles.get(role.id));

    handleOrchWorkflowsDelete(harness.ctx, {
      t: "api.req",
      id: "req-workflow-delete",
      method: "orch.workflows.delete",
      path: "/orch/workflows/delete",
      body: { workspaceId: harness.workspaceId, workflowId: workflow.id },
    } as any);
    assert.equal(harness.getResponse()?.status, 403);
    assert.match(String(harness.getResponse()?.body?.message ?? ""), /内置流程模板不可删除/);
    assert.ok(harness.db.orchWorkflows.get(workflow.id));

    handleOrchToolsetsDelete(harness.ctx, {
      t: "api.req",
      id: "req-toolset-delete",
      method: "orch.toolsets.delete",
      path: "/orch/toolsets/delete",
      body: { workspaceId: harness.workspaceId, toolsetId: toolset.id },
    } as any);
    assert.equal(harness.getResponse()?.status, 403);
    assert.match(String(harness.getResponse()?.body?.message ?? ""), /内置工具集不可删除/);
    assert.ok(harness.db.orchToolsets.get(toolset.id));

    await handleOrchKnowledgeBundlesDelete(harness.ctx, {
      t: "api.req",
      id: "req-knowledge-delete",
      method: "orch.knowledgeBundles.delete",
      path: "/orch/knowledge-bundles/delete",
      body: { workspaceId: harness.workspaceId, bundleId: bundle.id },
    } as any);
    assert.equal(harness.getResponse()?.status, 200);
    assert.equal(harness.db.orchKnowledgeBundles.get(bundle.id), null);
  } finally {
    harness.cleanup();
  }
});

test("custom orchestration assets can still be deleted", () => {
  const harness = createHarness();
  try {
    const workflow = harness.db.orchWorkflows.upsert({
      id: "workflow-custom" as any,
      workspaceId: harness.workspaceId,
      name: "自定义流程",
      description: "测试",
      nodes: [
        { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "end", type: "end", label: "结束", position: { x: 160, y: 0 } },
      ],
      edges: [],
      version: 1,
      kind: "custom",
    });

    handleOrchWorkflowsDelete(harness.ctx, {
      t: "api.req",
      id: "req-custom-workflow-delete",
      method: "orch.workflows.delete",
      path: "/orch/workflows/delete",
      body: { workspaceId: harness.workspaceId, workflowId: workflow.id },
    } as any);

    assert.equal(harness.getResponse()?.status, 200);
    assert.equal(harness.db.orchWorkflows.get(workflow.id), null);
  } finally {
    harness.cleanup();
  }
});

test("deleting a custom workflow asset removes only the chat cards referencing it", () => {
  const harness = createHarness();
  try {
    const removed = harness.db.orchWorkflows.upsert({
      id: "workflow-cards-removed" as any,
      workspaceId: harness.workspaceId,
      name: "被删流程",
      description: "测试",
      nodes: [
        { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "end", type: "end", label: "结束", position: { x: 160, y: 0 } },
      ],
      edges: [],
      version: 1,
      kind: "custom",
    });
    const kept = harness.db.orchWorkflows.upsert({
      id: "workflow-cards-kept" as any,
      workspaceId: harness.workspaceId,
      name: "保留流程",
      description: "测试",
      nodes: [
        { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "end", type: "end", label: "结束", position: { x: 160, y: 0 } },
      ],
      edges: [],
      version: 1,
      kind: "custom",
    });
    const instance = harness.db.orchInstances.create({
      workspaceId: harness.workspaceId,
      workflowId: removed.id as any,
      workflowSnapshot: removed as any,
      intakeSnapshot: { id: "intake-cards-removed", workspaceId: harness.workspaceId, title: "需求", goal: "目标" } as any,
    });
    seedChatWorkflowCard(harness.db, { id: "card-removed", workspaceId: harness.workspaceId, workflowId: removed.id, instanceId: instance.id });
    seedChatWorkflowCard(harness.db, { id: "card-kept", workspaceId: harness.workspaceId, workflowId: kept.id });

    handleOrchWorkflowsDelete(harness.ctx, {
      t: "api.req",
      id: "req-workflow-delete-cards",
      method: "orch.workflows.delete",
      path: "/orch/workflows/delete",
      body: { workspaceId: harness.workspaceId, workflowId: removed.id },
    } as any);

    assert.equal(harness.getResponse()?.status, 200);
    assert.deepEqual(listChatWorkflowCardIds(harness.db), ["card-kept"]);
    // 删流程资产只清会话控制面，已有执行实例仍留在编排侧可查。
    assert.ok(harness.db.orchInstances.get(instance.id));
  } finally {
    harness.cleanup();
  }
});

test("builtin knowledge bundles and skills cannot be updated without server authorization", () => {
  const harness = createHarness();
  try {
    const bundle = harness.db.orchKnowledgeBundles.upsert({
      id: "knowledge-builtin-update" as any,
      workspaceId: harness.workspaceId,
      name: "内置知识库",
      scope: "shared",
      description: "测试",
      sourceRefs: [],
      kind: "builtin",
    });
    const skill = harness.db.orchSkills.upsert(createBuiltinSkill(harness.workspaceId, "skill-builtin-update"));

    handleOrchKnowledgeBundlesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-knowledge-upsert",
      method: "orch.knowledgeBundles.upsert",
      path: "/orch/knowledge-bundles/upsert",
      body: {
        workspaceId: harness.workspaceId,
        bundle: { ...bundle, name: "被普通用户改名" },
      },
    } as any);
    assert.equal(harness.getResponse()?.status, 403);
    assert.match(String(harness.getResponse()?.body?.message ?? ""), /内置知识库 仅超管可修改/);
    assert.equal(harness.db.orchKnowledgeBundles.get(bundle.id)?.name, "内置知识库");

    handleOrchSkillsUpsert(harness.ctx, {
      t: "api.req",
      id: "req-skill-upsert",
      method: "orch.skills.upsert",
      path: "/orch/skills/upsert",
      body: {
        workspaceId: harness.workspaceId,
        skill: { ...skill, name: "被普通用户改名" },
      },
    } as any);
    assert.equal(harness.getResponse()?.status, 403);
    assert.match(String(harness.getResponse()?.body?.message ?? ""), /内置 Skill 仅超管可修改/);
    assert.equal(harness.db.orchSkills.get(skill.id)?.name, "内置 Skill");
  } finally {
    harness.cleanup();
  }
});

test("server-authorized builtin knowledge bundle and skill updates are accepted by client host", () => {
  const harness = createHarness();
  try {
    const bundle = harness.db.orchKnowledgeBundles.upsert({
      id: "knowledge-builtin-authorized" as any,
      workspaceId: harness.workspaceId,
      name: "内置知识库",
      scope: "shared",
      description: "测试",
      sourceRefs: [],
      kind: "builtin",
    });
    const skill = harness.db.orchSkills.upsert(createBuiltinSkill(harness.workspaceId, "skill-builtin-authorized"));

    handleOrchKnowledgeBundlesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-knowledge-authorized",
      method: "orch.knowledgeBundles.upsert",
      path: "/orch/knowledge-bundles/upsert",
      body: {
        workspaceId: harness.workspaceId,
        allowBuiltinAssetUpdate: true,
        bundle: { ...bundle, name: "超管改名" },
      },
    } as any);
    assert.equal(harness.getResponse()?.status, 200);
    assert.equal(harness.db.orchKnowledgeBundles.get(bundle.id)?.name, "超管改名");

    handleOrchSkillsUpsert(harness.ctx, {
      t: "api.req",
      id: "req-skill-authorized",
      method: "orch.skills.upsert",
      path: "/orch/skills/upsert",
      body: {
        workspaceId: harness.workspaceId,
        allowBuiltinAssetUpdate: true,
        skill: { ...skill, name: "超管改名" },
      },
    } as any);
    assert.equal(harness.getResponse()?.status, 200);
    assert.equal(harness.db.orchSkills.get(skill.id)?.name, "超管改名");
  } finally {
    harness.cleanup();
  }
});

test("server-authorized builtin role updates preserve its system group when omitted", () => {
  const harness = createHarness();
  try {
    const role = harness.db.orchRoles.upsert({
      id: "role-builtin-group-preserved" as any,
      workspaceId: harness.workspaceId,
      name: "Loop 方案设计师（SOLUTION）",
      description: "原始描述",
      responsibility: "测试",
      systemPrompt: "原始提示词",
      inputDefinition: { instructions: "输入", requiredFields: [] },
      outputDefinition: {
        instructions: "",
        deliveryMode: "direct",
        format: "markdown",
        resultKey: null,
        filePathRule: null,
        requiredFields: [],
      },
      gateCriteria: [],
      executionConfig: createDefaultRoleExecutionConfig("codex"),
      defaultKnowledgeBundleIds: [],
      toolRefs: [],
      kind: "builtin",
      builtinGroup: "lightweight-loop",
    });
    const { builtinGroup: _omitted, ...roleWithoutGroup } = role;

    handleOrchRolesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-role-group-preserved",
      method: "orch.roles.upsert",
      path: "/orch/roles/upsert",
      body: {
        workspaceId: harness.workspaceId,
        allowBuiltinAssetUpdate: true,
        role: { ...roleWithoutGroup, description: "修改后的描述" },
      },
    } as any);

    assert.equal(harness.getResponse()?.status, 200);
    assert.equal(harness.db.orchRoles.get(role.id)?.builtinGroup, "lightweight-loop");
    assert.equal(harness.db.orchRoles.get(role.id)?.description, "修改后的描述");
  } finally {
    harness.cleanup();
  }
});

/** 构造最小内置 Skill 资产，用于 Host upsert 权限测试。 */
function createBuiltinSkill(workspaceId: WorkspaceId, id: string): Omit<SkillDefinition, "createdAt" | "updatedAt"> {
  return {
    id: id as any,
    workspaceId,
    name: "内置 Skill",
    slug: "builtin-skill",
    description: "测试",
    trigger: "测试",
    instructions: "测试",
    targetEngines: ["codex"],
    tags: [],
    kind: "builtin",
    packageVersion: 1,
    skillMd: "---\nname: builtin-skill\n---\n\n# Builtin Skill\n",
    files: [
      {
        relPath: "SKILL.md",
        kind: "skill-md",
        contentText: "---\nname: builtin-skill\n---\n\n# Builtin Skill\n",
        contentType: "text/markdown",
        sizeBytes: 45,
        sha256: "",
      },
    ],
    scripts: [],
    installTargets: ["codex"],
    packageHash: null,
  };
}
