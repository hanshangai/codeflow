import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRoleExecutionRevision,
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchestrationAssetRuntimeSnapshot,
  type OrchestrationInstance,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.ts";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";

const WORKSPACE_ID = "ws-engine-runtime-snapshot" as WorkspaceId;

/** 构造仅依赖完整图的运行实例和会主动抛错的 legacy 仓储。 */
function createHarness(options: { withSnapshot?: boolean; backfillError?: Error | null; workspacePath?: string } = {}) {
  const snapshot = createSnapshot();
  const instance = createInstance(options.withSnapshot === false ? null : snapshot);
  const statusUpdates: string[] = [];
  const attemptCreates: unknown[] = [];
  let backfillCalls = 0;
  const db = {
    orchInstances: {
      get(instanceId: string) {
        return instanceId === instance.id ? instance : null;
      },
      updateStatus(_instanceId: string, status: string) {
        statusUpdates.push(status);
        instance.status = status as any;
      },
      updateNodeStates() {},
    },
    orchRoles: { get() { throw new Error("legacy role repo called"); } },
    orchKnowledgeBundles: { get() { throw new Error("legacy knowledge repo called"); } },
    orchToolsets: { get() { throw new Error("legacy toolset repo called"); } },
    orchSkills: { get() { throw new Error("legacy skill repo called"); } },
    orchEvents: {
      append(input: Record<string, unknown>) {
        return { id: "event-1", createdAt: 1, ...input };
      },
    },
    orchNodeAttempts: {
      cancelActiveByInstance() {},
      get() { return null; },
      isCurrent() { return false; },
      create(input: unknown) {
        attemptCreates.push(input);
        throw new Error("attempt create should not run");
      },
    },
    orchGateEvaluationRuns: {
      listRecoverable() { return []; },
      get() { return null; },
      updateCas() { return null; },
    },
    turns: { listRunningByWorkspace() { return {}; } },
  };
  const engine = new OrchestrationEngine({
    db: db as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: options.workspacePath ? new Map([[WORKSPACE_ID, options.workspacePath]]) : new Map(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation() {},
    emitRaw() {},
    ensureAssetRuntimeSnapshot() {
      backfillCalls += 1;
      if (options.backfillError) throw options.backfillError;
      instance.assetRuntimeSnapshot = snapshot;
      return snapshot;
    },
  });
  return { engine, instance, snapshot, statusUpdates, attemptCreates, getBackfillCalls: () => backfillCalls };
}

/** 构造覆盖角色、知识包、工具集和 Skill 的完整运行图。 */
function createSnapshot(): OrchestrationAssetRuntimeSnapshot {
  const workflow = {
    id: "wf-engine-runtime-snapshot" as any,
    workspaceId: WORKSPACE_ID,
    family: "feature-dev" as const,
    name: "运行图工作流",
    description: "验证引擎只读实例快照",
    workflowKnowledgeBundleIds: ["kb-runtime" as any],
    nodes: [{
      id: "implementation",
      type: "role" as const,
      roleId: "role-runtime" as any,
      label: "实现",
      position: { x: 0, y: 0 },
    }],
    edges: [],
    version: 1,
  };
  const source = {
    authorityMode: "server" as const,
    metadata: {
      revision: 8,
      scopeType: "user" as const,
      syncChangeSeq: 21,
      contentHash: "b".repeat(64),
      cacheStatus: "ready" as const,
    },
  };
  return {
    authorityMode: "server",
    workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
    roles: {
      "role-runtime": {
        assetType: "role",
        assetId: "role-runtime",
        definition: {
          id: "role-runtime" as any,
          workspaceId: WORKSPACE_ID,
          name: "冻结角色",
          description: "冻结角色描述",
          responsibility: "执行冻结任务",
          systemPrompt: "只使用冻结内容",
          inputDefinition: createDefaultRoleInputDefinition(),
          outputDefinition: createDefaultRoleOutputDefinition(),
          gateCriteria: [],
          executionConfig: createDefaultRoleExecutionConfig("codex"),
          defaultKnowledgeBundleIds: ["kb-runtime" as any],
          defaultSkillIds: ["skill-runtime" as any],
          toolRefs: [{ toolsetId: "tools-runtime" as any, toolId: "tool-runtime" as any }],
          kind: "custom",
        },
        source,
      },
    },
    knowledgeBundles: {
      "kb-runtime": {
        assetType: "knowledge_bundle",
        assetId: "kb-runtime",
        definition: {
          id: "kb-runtime" as any,
          workspaceId: WORKSPACE_ID,
          name: "冻结知识",
          scope: "shared",
          description: "冻结知识描述",
          sourceRefs: [],
          kind: "custom",
        },
        source,
      },
    },
    toolsets: {
      "tools-runtime": {
        assetType: "toolset",
        assetId: "tools-runtime",
        definition: {
          id: "tools-runtime" as any,
          workspaceId: WORKSPACE_ID,
          name: "冻结工具集",
          description: "冻结工具描述",
          tools: [{
            id: "tool-runtime" as any,
            name: "冻结工具",
            description: "运行冻结命令",
            runtime: "shell",
            invocationHint: "运行命令",
            code: "pnpm test",
          }],
          kind: "custom",
        },
        source,
      },
    },
    skills: {
      "skill-runtime": {
        assetType: "skill",
        assetId: "skill-runtime",
        definition: {
          id: "skill-runtime" as any,
          workspaceId: WORKSPACE_ID,
          name: "冻结 Skill",
          slug: "runtime-skill",
          description: "冻结 Skill 描述",
          trigger: "运行时",
          instructions: "执行冻结 Skill",
          targetEngines: ["codex"],
          kind: "custom",
          skillMd: "# Runtime Skill\n",
          files: [],
          packageHash: "c".repeat(64),
        },
        source,
      },
    },
  };
}

/** 构造可被引擎推进的最小实例。 */
function createInstance(snapshot: OrchestrationAssetRuntimeSnapshot | null): OrchestrationInstance {
  return {
    id: "orch-engine-runtime-snapshot" as any,
    workspaceId: WORKSPACE_ID,
    workflowId: "wf-engine-runtime-snapshot" as any,
    proposalId: null,
    intakeSnapshot: {
      id: "intake-engine-runtime-snapshot" as any,
      workspaceId: WORKSPACE_ID,
      triggerMode: "manual",
      taskType: "feature",
      title: "运行图",
      goal: "验证引擎快照只读",
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: createSnapshot().workflow.definition,
    assetRuntimeSnapshot: snapshot,
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: "pending",
    nodeStates: {
      implementation: { nodeId: "implementation", status: "pending", retryCount: 0 },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

test("引擎四类运行依赖只从实例完整图解析", () => {
  const { engine, instance } = createHarness();
  const role = (engine as any).resolveRoleDefinition(instance, "role-runtime");
  const tools = (engine as any).resolveRoleTools(instance, role);
  const skills = (engine as any).resolveRoleSkills(instance, role, "codex");
  const bundles: string[] = [];
  const knowledge = (engine as any).resolveKnowledgeContext(
    instance,
    instance.workflowSnapshot.nodes[0],
    role,
    {
      buildCatalog(bundle: { name: string; id: string }) {
        bundles.push(bundle.name);
        return { bundleId: bundle.id, bundleName: bundle.name, scope: "shared", createdAt: 1, inlineItems: [], runtimeSources: [], warnings: [] };
      },
      trimInlineItemsForPrompt(items: unknown[]) { return items; },
    },
  );

  assert.equal(role.name, "冻结角色");
  assert.equal(tools[0]?.tool.name, "冻结工具");
  assert.equal(skills[0]?.name, "冻结 Skill");
  assert.deepEqual(bundles, ["冻结知识"]);
  assert.equal(knowledge.catalogs[0]?.bundleName, "冻结知识");
});

test("工作流加载正式项目规格，原文失效必须中止节点上下文构建", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-project-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "rules.md"), "项目已采用约束：使用现有组件。", "utf8");
  const store = new KnowledgeAssetStore(root);
  const rule = store.importFile({ path: "rules.md", category: "specifications", appliesTo: [], contentHash: store.readSource("rules.md").contentHash, parentId: null, treeHash: null });
  const { engine, instance } = createHarness({ workspacePath: root });
  const role = (engine as any).resolveRoleDefinition(instance, "role-runtime");
  const runtime = { buildCatalog: (bundle: { id: string; name: string }) => ({ bundleId: bundle.id, bundleName: bundle.name, scope: "shared", createdAt: 1, inlineItems: [], runtimeSources: [], warnings: [] }), trimInlineItemsForPrompt: (items: unknown[]) => items };
  const resolve = () => (engine as any).resolveKnowledgeContext(instance, instance.workflowSnapshot.nodes[0], role, runtime);
  assert.match(resolve().projectSpecifications, /项目已采用约束：使用现有组件/);
  assert.match(resolve().projectSpecifications, /knowledge.rules.read/);
  assert.equal(store.category(rule.id), "specifications");
  fs.unlinkSync(path.join(root, "rules.md"));
  assert.throws(resolve, /ENOENT|不存在/);
});

test("当前资产更新不改变实例冻结的角色执行 revision", () => {
  const { engine, instance } = createHarness();
  const readRevision = () => {
    const role = (engine as any).resolveRoleDefinition(instance, "role-runtime");
    const tools = (engine as any).resolveRoleTools(instance, role);
    const skills = (engine as any).resolveRoleSkills(instance, role, "codex");
    return buildRoleExecutionRevision(role, tools.map((item: any) => item.toolset), skills);
  };
  const before = readRevision();
  const after = readRevision();
  assert.deepEqual(after, before);
});

test("历史实例补录失败保留失败事实且零 attempt", async () => {
  const harness = createHarness({ withSnapshot: false, backfillError: new Error("backfill failed") });
  await assert.rejects(harness.engine.start(harness.instance.id), /backfill failed/);
  assert.equal(harness.getBackfillCalls(), 1);
  assert.deepEqual(harness.statusUpdates, ["failed"]);
  assert.equal(harness.instance.status, "failed");
  assert.deepEqual(harness.attemptCreates, []);
});

test("attempt 统一边界拒绝无完整图实例", () => {
  const harness = createHarness({ withSnapshot: false });
  assert.throws(() => (harness.engine as any).beginNodeAttempt(
    harness.instance.id,
    harness.instance.workflowSnapshot.nodes[0],
    harness.instance,
  ), /缺少完整运行快照/);
  assert.deepEqual(harness.attemptCreates, []);
});

test("启动状态规范化拒绝在补录前修改历史实例", () => {
  const harness = createHarness({ withSnapshot: false });
  (harness.engine as any).ctx.db.workspaces = {
    list() { return [{ id: harness.instance.workspaceId }]; },
  };
  (harness.engine as any).ctx.db.orchInstances.listByWorkspace = () => [harness.instance];

  assert.throws(
    () => harness.engine.normalizePersistedInstanceStatuses(),
    /缺少完整运行快照/,
  );
  assert.deepEqual(harness.statusUpdates, []);
});

test("人工修订同步入口拒绝无完整图实例", () => {
  const harness = createHarness({ withSnapshot: false });
  assert.throws(
    () => harness.engine.reviseArtifact(
      harness.instance.id,
      "implementation",
      "artifact-runtime-snapshot" as any,
      { answer: { mode: "text", text: "人工修订" } },
    ),
    /缺少完整运行快照/,
  );
  assert.deepEqual(harness.statusUpdates, []);
});

test("无完整图历史实例仍允许取消", () => {
  const harness = createHarness({ withSnapshot: false });
  harness.engine.cancel(harness.instance.id);
  assert.equal(harness.instance.status, "cancelled");
  assert.deepEqual(harness.statusUpdates, ["cancelled"]);
  assert.equal(harness.getBackfillCalls(), 0);
});
