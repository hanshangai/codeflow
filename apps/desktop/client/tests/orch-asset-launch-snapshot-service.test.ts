import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchAssetType,
  type RoleDefinition,
  type SkillDefinition,
  type ToolsetDefinition,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import type {
  OrchAssetAuthorityRuntimeAsset,
  OrchAssetAuthorityRuntimeReadSession,
} from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";
import {
  OrchAssetLaunchSnapshotError,
  OrchAssetLaunchSnapshotService,
} from "../src/orchestration/orchAssetLaunchSnapshotService.ts";

type RuntimeRole = Omit<RoleDefinition, "createdAt" | "updatedAt">;
type RuntimeToolset = Omit<ToolsetDefinition, "createdAt" | "updatedAt">;
type RuntimeSkill = Omit<SkillDefinition, "createdAt" | "updatedAt">;

/** Builds a complete local asset graph and an observable fake Task 66 reader. */
function createHarness() {
  const workspaceId = "ws-launch-snapshot" as WorkspaceId;
  const role: RuntimeRole = {
    id: "role-dev" as any,
    workspaceId,
    name: "实现角色",
    description: "实现功能",
    responsibility: "完成编码",
    systemPrompt: "按需求完成实现",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: ["kb-role" as any],
    defaultSkillIds: ["skill-dev" as any],
    toolRefs: [
      { toolsetId: "tools-dev" as any, toolId: "tool-run" as any },
      { toolsetId: "tools-dev" as any, toolId: "tool-run" as any },
    ],
    kind: "custom",
  };
  const workflow: WorkflowRuntimeDefinition = {
    id: "wf-dev" as any,
    workspaceId,
    family: "feature-dev",
    name: "功能开发",
    description: "完整启动图",
    workflowKnowledgeBundleIds: ["kb-workflow" as any],
    nodes: [
      { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      {
        id: "dev-a",
        type: "role",
        roleId: role.id,
        label: "实现 A",
        position: { x: 0, y: 120 },
        knowledgeOverrideBundleIds: ["kb-node" as any],
      },
      { id: "dev-b", type: "role", roleId: role.id, label: "实现 B", position: { x: 0, y: 240 } },
      { id: "end", type: "end", label: "结束", position: { x: 0, y: 360 } },
    ],
    edges: [],
    version: 1,
  };
  const toolset: RuntimeToolset = {
    id: "tools-dev" as any,
    workspaceId,
    name: "开发工具",
    description: "启动图工具",
    tools: [{
      id: "tool-run" as any,
      name: "运行",
      description: "运行测试",
      runtime: "shell",
      invocationHint: "运行测试命令",
      code: "pnpm test",
    }],
    kind: "custom",
  };
  const skill: RuntimeSkill = {
    id: "skill-dev" as any,
    workspaceId,
    name: "开发 Skill",
    slug: "dev-skill",
    description: "执行开发流程",
    trigger: "开发任务",
    instructions: "先分析后实现",
    targetEngines: ["codex"],
    kind: "custom",
    packageVersion: 1,
    skillMd: "# Dev Skill\n",
    files: [{
      relPath: "SKILL.md",
      kind: "skill-md",
      contentText: "# Dev Skill\n",
      sizeBytes: 12,
      sha256: "a".repeat(64),
    }],
    packageHash: "b".repeat(64),
  };
  const definitions = new Map<string, object>([
    [`workflow:${workflow.id}`, workflow],
    [`role:${role.id}`, role],
    [`knowledge_bundle:kb-workflow`, createKnowledgeBundle(workspaceId, "kb-workflow")],
    [`knowledge_bundle:kb-node`, createKnowledgeBundle(workspaceId, "kb-node")],
    [`knowledge_bundle:kb-role`, createKnowledgeBundle(workspaceId, "kb-role")],
    [`toolset:${toolset.id}`, toolset],
    [`skill:${skill.id}`, skill],
  ]);
  const openCalls: WorkspaceId[] = [];
  const readCalls: string[] = [];
  const servedAssets = new Map<string, ReturnType<typeof createLocalAsset>>();
  let readError: { key: string; error: Error } | null = null;

  const reader = {
    /** Opens one observable local session around the fixture graph. */
    openWorkspace(runtimeWorkspaceId: WorkspaceId): OrchAssetAuthorityRuntimeReadSession {
      openCalls.push(runtimeWorkspaceId);
      return {
        authorityMode: "legacy",
        listAssets() { return []; },
        getAsset<T extends OrchAssetType>(assetType: T, assetId: string) {
          const key = `${assetType}:${assetId}`;
          readCalls.push(key);
          if (readError?.key === key) throw readError.error;
          const definition = definitions.get(key);
          if (!definition) return null;
          const asset = createLocalAsset(assetType, assetId, definition);
          servedAssets.set(key, asset);
          return asset as OrchAssetAuthorityRuntimeAsset<T>;
        },
      };
    },
  };

  return {
    workspaceId,
    workflow,
    role,
    toolset,
    skill,
    definitions,
    openCalls,
    readCalls,
    servedAssets,
    service: new OrchAssetLaunchSnapshotService(reader as any),
    failRead(key: string, error: Error) {
      readError = { key, error };
    },
  };
}

/** Creates one minimal runtime knowledge bundle fixture. */
function createKnowledgeBundle(workspaceId: WorkspaceId, id: string) {
  return {
    id,
    workspaceId,
    name: id,
    scope: "shared",
    description: `${id} 描述`,
    sourceRefs: [],
    kind: "custom",
  };
}

/** Wraps one fixture definition in detached-looking local source metadata. */
function createLocalAsset(assetType: OrchAssetType, assetId: string, definition: object) {
  return {
    assetType,
    assetId,
    definition,
    source: { authorityMode: "legacy" as const, createdAt: 1, updatedAt: 1 },
  };
}

test("已有工作流快照在一个会话内解析并去重完整依赖图", () => {
  const harness = createHarness();
  const snapshot = harness.service.createFromWorkflow(harness.workspaceId, harness.workflow);

  assert.deepEqual(harness.openCalls, [harness.workspaceId]);
  assert.equal(harness.readCalls.includes(`workflow:${harness.workflow.id}`), false);
  assert.equal(harness.readCalls.filter((key) => key === `role:${harness.role.id}`).length, 1);
  assert.equal(harness.readCalls.filter((key) => key === `toolset:${harness.toolset.id}`).length, 1);
  assert.equal(harness.readCalls.filter((key) => key === `skill:${harness.skill.id}`).length, 1);
  assert.deepEqual(Object.keys(snapshot.knowledgeBundles), ["kb-node", "kb-role", "kb-workflow"]);
  assert.equal(snapshot.workflow.source, null);
  assert.equal(snapshot.roles[harness.role.id]?.source?.authorityMode, "legacy");
  assert.equal(snapshot.skills[harness.skill.id]?.source?.authorityMode, "legacy");
  assert.equal(snapshot.skills[harness.skill.id]?.definition.skillMd, harness.skill.skillMd);
  assert.deepEqual(snapshot.skills[harness.skill.id]?.definition.files, harness.skill.files);
  assert.equal(snapshot.skills[harness.skill.id]?.definition.packageHash, harness.skill.packageHash);

  harness.role.name = "已污染会话夹具";
  harness.skill.files![0]!.contentText = "已污染 Skill 文件";
  harness.servedAssets.get(`role:${harness.role.id}`)!.source.updatedAt = 99;
  assert.equal(snapshot.roles[harness.role.id]?.definition.name, "实现角色");
  assert.equal(snapshot.skills[harness.skill.id]?.definition.files[0]?.contentText, "# Dev Skill\n");
  const roleSource = snapshot.roles[harness.role.id]?.source;
  assert.equal(roleSource?.authorityMode === "legacy" ? roleSource.updatedAt : null, 1);
});

test("定时工作流入口从同一会话读取工作流及全部依赖", () => {
  const harness = createHarness();
  const snapshot = harness.service.createFromWorkflowId(harness.workspaceId, harness.workflow.id);

  assert.deepEqual(harness.openCalls, [harness.workspaceId]);
  assert.equal(harness.readCalls.filter((key) => key === `workflow:${harness.workflow.id}`).length, 1);
  assert.equal(snapshot.workflow.source?.authorityMode, "legacy");
  assert.equal(snapshot.workflow.definition.name, harness.workflow.name);
});

test("缺失依赖会显式失败且不会返回部分启动图", () => {
  const harness = createHarness();
  harness.definitions.delete(`knowledge_bundle:kb-node`);

  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError
      && error.code === "ASSET_LAUNCH_DEPENDENCY_MISSING"
      && /kb-node/.test(error.message),
  );
});

test("工具集存在但角色引用工具缺失时拒绝启动图", () => {
  const harness = createHarness();
  harness.toolset.tools = [];

  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError
      && error.code === "ASSET_LAUNCH_GRAPH_INVALID"
      && /tool-run/.test(error.message),
  );
});

test("Skill 运行包缺少完整正文或 packageHash 时拒绝启动图", () => {
  const harness = createHarness();
  delete (harness.skill as any).packageHash;

  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError
      && error.code === "ASSET_LAUNCH_GRAPH_INVALID"
      && /Skill 运行包定义不完整/.test(error.message),
  );
});

test("底层本地读取错误原样传播且不回退", () => {
  const harness = createHarness();
  const readError = new Error("本地 Skill 定义不可用");
  harness.failRead(`skill:${harness.skill.id}`, readError);

  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error === readError,
  );
});

test("资产身份或工作区与会话不一致时拒绝启动图", () => {
  const harness = createHarness();
  const wrongRole = { ...harness.role, id: "role-other" };
  harness.definitions.set(`role:${harness.role.id}`, wrongRole);

  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError
      && error.code === "ASSET_LAUNCH_GRAPH_INVALID"
      && /身份不一致/.test(error.message),
  );

  harness.definitions.set(`role:${harness.role.id}`, {
    ...harness.role,
    workspaceId: "ws-other" as WorkspaceId,
  });
  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError
      && error.code === "ASSET_LAUNCH_GRAPH_INVALID"
      && /不属于运行工作区/.test(error.message),
  );
});

test("特殊资产 ID 仍作为可序列化自有键保留完整依赖", () => {
  const harness = createHarness();
  const specialId = "__proto__";
  const specialRole = {
    ...harness.role,
    id: specialId as any,
    toolRefs: [{ toolsetId: specialId as any, toolId: harness.toolset.tools[0]!.id }],
  };
  const specialToolset = { ...harness.toolset, id: specialId as any };
  const workflow = {
    ...harness.workflow,
    nodes: harness.workflow.nodes.map((node) => node.type === "role"
      ? { ...node, roleId: specialRole.id }
      : node),
  };
  harness.definitions.set(`role:${specialId}`, specialRole);
  harness.definitions.set(`toolset:${specialId}`, specialToolset);

  const snapshot = harness.service.createFromWorkflow(harness.workspaceId, workflow);

  assert.equal(Object.hasOwn(snapshot.roles, specialId), true);
  assert.equal(Object.hasOwn(snapshot.toolsets, specialId), true);
  const serialized = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  assert.equal(serialized.roles[specialId]?.assetId, specialId);
  assert.equal(serialized.toolsets[specialId]?.assetId, specialId);
});

test("结构兼容展示时间不会进入 proposal 或定时启动快照", () => {
  const harness = createHarness();
  for (const definition of harness.definitions.values()) {
    Object.assign(definition, { createdAt: 10, updatedAt: 20 });
  }

  const proposalSnapshot = harness.service.createFromWorkflow(harness.workspaceId, harness.workflow);
  const scheduledSnapshot = harness.service.createFromWorkflowId(harness.workspaceId, harness.workflow.id);

  for (const snapshot of [proposalSnapshot, scheduledSnapshot]) {
    const entries = [
      snapshot.workflow,
      ...Object.values(snapshot.roles),
      ...Object.values(snapshot.knowledgeBundles),
      ...Object.values(snapshot.toolsets),
      ...Object.values(snapshot.skills),
    ];
    for (const entry of entries) {
      assert.equal("createdAt" in entry.definition, false);
      assert.equal("updatedAt" in entry.definition, false);
    }
  }
  assert.deepEqual(harness.openCalls, [harness.workspaceId, harness.workspaceId]);
});

test("非法工作区和跨工作区 proposal 快照在打开会话前失败", () => {
  const harness = createHarness();
  const otherWorkflow = { ...harness.workflow, workspaceId: "ws-other" as WorkspaceId };

  assert.throws(
    () => harness.service.createFromWorkflow(" ws-invalid" as WorkspaceId, harness.workflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError && error.code === "ASSET_LAUNCH_INPUT_INVALID",
  );
  assert.throws(
    () => harness.service.createFromWorkflow(harness.workspaceId, otherWorkflow),
    (error) => error instanceof OrchAssetLaunchSnapshotError && error.code === "ASSET_LAUNCH_INPUT_INVALID",
  );
  assert.equal(harness.openCalls.length, 0);
});
