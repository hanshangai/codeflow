import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchestrationAssetRuntimeSnapshot,
  type OrchAssetExecutionAuthorization,
  type TaskIntake,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "../../../../packages/shared/src/index.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { OrchInstanceSummaryProjectionReader } from "../src/db/orchInstanceSummaryProjection.ts";
import { OrchIntakeListStateRepo } from "../src/db/repos/orchIntakeListStateRepo.ts";
import { OrchInstanceRepo } from "../src/db/repos/orchInstanceRepo.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "ws-runtime-snapshot" as WorkspaceId;
const SPECIAL_ROLE_ID = "__proto__";
const SKILL_MD = "# Runtime Skill\n";

/** Opens one migrated in-memory Client DB with the required workspace owner row. */
function createHarness(dbPath = ":memory:") {
  const db = openSqliteDb(dbPath);
  migrateClientDb(db);
  new WorkspaceRepo(db).upsert({ id: WORKSPACE_ID, title: "运行快照", path: "D:/runtime-snapshot" });
  const instanceSummaries = new OrchInstanceSummaryProjectionReader(db);
  const intakeListStates = new OrchIntakeListStateRepo(db, instanceSummaries);
  return { db, repo: new OrchInstanceRepo(db, intakeListStates, instanceSummaries) };
}

/** Builds one complete Server-authoritative graph with a special role ID and Skill package. */
function createFixture() {
  const workflow: WorkflowRuntimeDefinition = {
    id: "wf-runtime-snapshot" as any,
    workspaceId: WORKSPACE_ID,
    family: "feature-dev",
    name: "运行快照工作流",
    description: "持久化完整资产图",
    workflowKnowledgeBundleIds: ["kb-runtime" as any],
    nodes: [{
      id: "role-node",
      type: "role",
      roleId: SPECIAL_ROLE_ID as any,
      label: "实现",
      position: { x: 0, y: 0 },
    }],
    edges: [],
    version: 1,
  };
  const roles = Object.create(null);
  roles[SPECIAL_ROLE_ID] = {
    assetType: "role",
    assetId: SPECIAL_ROLE_ID,
    definition: {
      id: SPECIAL_ROLE_ID,
      workspaceId: WORKSPACE_ID,
      name: "特殊角色",
      description: "验证特殊映射键",
      responsibility: "实现任务",
      systemPrompt: "完成实现",
      inputDefinition: createDefaultRoleInputDefinition(),
      outputDefinition: createDefaultRoleOutputDefinition(),
      gateCriteria: [],
      executionConfig: createDefaultRoleExecutionConfig("codex"),
      defaultKnowledgeBundleIds: ["kb-runtime"],
      defaultSkillIds: ["skill-runtime"],
      toolRefs: [{ toolsetId: "tools-runtime", toolId: "tool-run" }],
      kind: "custom",
      createdAt: 10,
      updatedAt: 20,
    },
    source: serverSource(5),
  };
  const snapshot: OrchestrationAssetRuntimeSnapshot = {
    authorityMode: "server",
    workflow: {
      assetType: "workflow",
      assetId: workflow.id,
      definition: { ...workflow, createdAt: 10, updatedAt: 20 } as any,
      source: null,
    },
    roles,
    knowledgeBundles: {
      "kb-runtime": {
        assetType: "knowledge_bundle",
        assetId: "kb-runtime",
        definition: {
          id: "kb-runtime",
          workspaceId: WORKSPACE_ID,
          name: "运行知识",
          scope: "shared",
          description: "运行知识包",
          sourceRefs: [],
          kind: "custom",
          createdAt: 10,
          updatedAt: 20,
        } as any,
        source: serverSource(6),
      },
    },
    toolsets: {
      "tools-runtime": {
        assetType: "toolset",
        assetId: "tools-runtime",
        definition: {
          id: "tools-runtime",
          workspaceId: WORKSPACE_ID,
          name: "运行工具",
          description: "运行测试",
          tools: [{
            id: "tool-run",
            name: "运行",
            description: "执行命令",
            runtime: "shell",
            invocationHint: "执行测试",
            code: "pnpm test",
          }],
          kind: "custom",
          createdAt: 10,
          updatedAt: 20,
        } as any,
        source: serverSource(7),
      },
    },
    skills: {
      "skill-runtime": {
        assetType: "skill",
        assetId: "skill-runtime",
        definition: {
          id: "skill-runtime",
          workspaceId: WORKSPACE_ID,
          name: "运行 Skill",
          slug: "runtime-skill",
          description: "运行时完整包",
          trigger: "启动实例",
          instructions: "执行完整包",
          targetEngines: ["codex"],
          kind: "custom",
          packageVersion: 3,
          skillMd: SKILL_MD,
          files: [{
            relPath: "SKILL.md",
            kind: "skill-md",
            contentText: SKILL_MD,
            sizeBytes: 16,
            sha256: crypto.createHash("sha256").update(SKILL_MD, "utf8").digest("hex"),
          }, {
            relPath: "assets/runtime.bin",
            kind: "asset",
            contentBase64: "AAEC",
            contentType: "application/octet-stream",
            sizeBytes: 3,
            sha256: crypto.createHash("sha256").update(Buffer.from([0, 1, 2])).digest("hex"),
          }],
          packageHash: "b".repeat(64),
          createdAt: 10,
          updatedAt: 20,
        } as any,
        source: serverSource(8),
      },
    },
  };
  const intake: TaskIntake = {
    id: "intake-runtime-snapshot" as any,
    workspaceId: WORKSPACE_ID,
    triggerMode: "manual",
    taskType: "feature",
    title: "运行快照",
    goal: "验证完整启动资产图持久化",
    createdAt: 1,
    updatedAt: 1,
  };
  return { workflow, snapshot, intake };
}

/** Creates one detached Server source fixture. */
function serverSource(syncChangeSeq: number) {
  return {
    authorityMode: "server" as const,
    metadata: {
      revision: 3,
      scopeType: "user" as const,
      syncChangeSeq,
      contentHash: "c".repeat(64),
      cacheStatus: "ready" as const,
    },
  };
}

/** Persists one fixture graph through the production instance repo. */
function createInstance(repo: OrchInstanceRepo, fixture: ReturnType<typeof createFixture>) {
  return repo.create({
    workspaceId: WORKSPACE_ID,
    workflowId: fixture.workflow.id,
    workflowSnapshot: fixture.workflow,
    assetRuntimeSnapshot: fixture.snapshot,
    intakeSnapshot: fixture.intake,
  });
}

test("完整启动资产图可在 SQLite 往返并脱离调用方输入", () => {
  const harness = createHarness();
  try {
    const fixture = createFixture();
    const created = createInstance(harness.repo, fixture);
    const persisted = harness.repo.get(created.id);

    assert.ok(persisted?.assetRuntimeSnapshot);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.roles, SPECIAL_ROLE_ID), true);
    assert.equal(Object.getPrototypeOf(persisted.assetRuntimeSnapshot.roles), null);
    assert.equal(persisted.assetRuntimeSnapshot.skills["skill-runtime"]?.definition.packageHash, "b".repeat(64));
    assert.equal(
      persisted.assetRuntimeSnapshot.skills["skill-runtime"]?.definition.files[0]?.contentText,
      "# Runtime Skill\n",
    );
    assert.equal(persisted.assetRuntimeSnapshot.skills["skill-runtime"]?.definition.files[1]?.contentBase64, "AAEC");
    const skillSource = persisted.assetRuntimeSnapshot.skills["skill-runtime"]?.source;
    assert.equal(skillSource?.authorityMode === "server" ? skillSource.metadata.syncChangeSeq : null, 8);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.roles[SPECIAL_ROLE_ID]!.definition, "createdAt"), false);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.workflow.definition, "updatedAt"), false);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.knowledgeBundles["kb-runtime"]!.definition, "createdAt"), false);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.toolsets["tools-runtime"]!.definition, "updatedAt"), false);
    assert.equal(Object.hasOwn(persisted.assetRuntimeSnapshot.skills["skill-runtime"]!.definition, "createdAt"), false);

    (fixture.snapshot.skills["skill-runtime"]!.definition.files[0] as any).contentText = "已污染";
    (fixture.snapshot.skills["skill-runtime"]!.source as any).metadata.revision = 99;
    assert.equal(created.assetRuntimeSnapshot?.skills["skill-runtime"]?.definition.files[0]?.contentText, "# Runtime Skill\n");
    assert.equal(harness.repo.get(created.id)?.assetRuntimeSnapshot?.skills["skill-runtime"]?.definition.files[0]?.contentText, "# Runtime Skill\n");
  } finally {
    harness.db.close();
  }
});

test("共享缓存执行来源沿真实实例仓储重开且不能变为本机来源", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d14-instance-source-")), dbPath = path.join(root, "client.sqlite");
  let harness = createHarness(dbPath);
  try {
    const fixture = createFixture();
    const authorization: OrchAssetExecutionAuthorization = { serverOrigin: "https://example.test", userId: "owner", deviceId: "device",
      clientId: "client", hostBindingId: "binding", hostScopeEpoch: 1, sharedWorkspaceId: "shared", runtimeWorkspaceId: WORKSPACE_ID,
      contextKey: "context", authorityEpoch: 2, appliedChangeSeq: 8, revisionSetHash: "d".repeat(64), snapshotHash: "e".repeat(64) };
    fixture.snapshot.executionAuthorization = authorization;
    const created = createInstance(harness.repo, fixture);
    authorization.userId = "mutated";
    assert.equal(harness.repo.get(created.id)?.assetRuntimeSnapshot?.executionAuthorization?.userId, "owner");
    harness.db.close(); harness = createHarness(dbPath);
    assert.deepEqual(harness.repo.get(created.id)?.assetRuntimeSnapshot?.executionAuthorization, { ...authorization, userId: "owner" });
    for (const patch of [{ runtimeWorkspaceId: "foreign" }, { snapshotHash: "broken" }, { signature: "unexpected" }, { authorityEpoch: -1 },
      { serverOrigin: "https://example.test/path" }, { userId: " owner " }]) {
      const invalid = createFixture();
      invalid.snapshot.executionAuthorization = { ...authorization, ...patch };
      assert.throws(() => createInstance(harness.repo, invalid));
    }
    const legacy = createFixture();
    legacy.snapshot.authorityMode = "legacy"; legacy.snapshot.executionAuthorization = authorization;
    assert.throws(() => createInstance(harness.repo, legacy));
  } finally { harness.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("残缺运行定义或依赖图在写入前显式失败", () => {
  const harness = createHarness();
  try {
    const cases: Array<{ pattern: RegExp; mutate: (fixture: ReturnType<typeof createFixture>) => void }> = [
      { pattern: /缺少依赖.*role/, mutate: (fixture) => { delete fixture.snapshot.roles[SPECIAL_ROLE_ID]; } },
      { pattern: /缺少依赖.*knowledge_bundle/, mutate: (fixture) => { delete fixture.snapshot.knowledgeBundles["kb-runtime"]; } },
      { pattern: /缺少依赖.*skill/, mutate: (fixture) => { delete fixture.snapshot.skills["skill-runtime"]; } },
      { pattern: /缺少依赖.*toolset/, mutate: (fixture) => { delete fixture.snapshot.toolsets["tools-runtime"]; } },
      { pattern: /缺少角色工具/, mutate: (fixture) => { fixture.snapshot.toolsets["tools-runtime"]!.definition.tools = []; } },
      { pattern: /files 必须是数组/, mutate: (fixture) => { delete (fixture.snapshot.skills["skill-runtime"]!.definition as any).files; } },
      { pattern: /packageHash 非法/, mutate: (fixture) => { delete (fixture.snapshot.skills["skill-runtime"]!.definition as any).packageHash; } },
      { pattern: /skillMd 与 SKILL.md 文件不一致/, mutate: (fixture) => { fixture.snapshot.skills["skill-runtime"]!.definition.skillMd = "已损坏"; } },
      { pattern: /sizeBytes 与正文不一致/, mutate: (fixture) => { fixture.snapshot.skills["skill-runtime"]!.definition.files[0]!.sizeBytes += 1; } },
      { pattern: /sha256 与正文不一致/, mutate: (fixture) => { fixture.snapshot.skills["skill-runtime"]!.definition.files[0]!.sha256 = "d".repeat(64); } },
      { pattern: /sourceRefs 必须是数组/, mutate: (fixture) => { delete (fixture.snapshot.knowledgeBundles["kb-runtime"]!.definition as any).sourceRefs; } },
      { pattern: /executionConfig 必须是普通对象/, mutate: (fixture) => { delete (fixture.snapshot.roles[SPECIAL_ROLE_ID]!.definition as any).executionConfig; } },
      { pattern: /tools 必须是数组/, mutate: (fixture) => { delete (fixture.snapshot.toolsets["tools-runtime"]!.definition as any).tools; } },
    ];
    for (const item of cases) {
      const fixture = createFixture();
      item.mutate(fixture);
      assert.throws(() => createInstance(harness.repo, fixture), item.pattern);
    }
    assert.equal(Number((harness.db.prepare("SELECT COUNT(*) AS count FROM orch_instances").get() as { count: number }).count), 0);
  } finally {
    harness.db.close();
  }
});

test("旧实例保持 null 且工作流或来源不一致时零写入", () => {
  const harness = createHarness();
  try {
    const fixture = createFixture();
    const legacyInstance = harness.repo.create({
      workspaceId: WORKSPACE_ID,
      workflowId: fixture.workflow.id,
      workflowSnapshot: fixture.workflow,
      intakeSnapshot: fixture.intake,
    });
    assert.equal(harness.repo.get(legacyInstance.id)?.assetRuntimeSnapshot, null);

    const before = Number((harness.db.prepare("SELECT COUNT(*) AS count FROM orch_instances").get() as { count: number }).count);
    fixture.snapshot.workflow.definition.name = "不一致工作流";
    assert.throws(() => createInstance(harness.repo, fixture), /workflowSnapshot 内容不一致/);
    assert.equal(Number((harness.db.prepare("SELECT COUNT(*) AS count FROM orch_instances").get() as { count: number }).count), before);

    const missingSourceFixture = createFixture();
    missingSourceFixture.snapshot.roles[SPECIAL_ROLE_ID]!.source = null;
    assert.throws(() => createInstance(harness.repo, missingSourceFixture), /source 缺失/);
    assert.equal(Number((harness.db.prepare("SELECT COUNT(*) AS count FROM orch_instances").get() as { count: number }).count), before);

    const mismatchedAuthorityFixture = createFixture();
    mismatchedAuthorityFixture.snapshot.roles[SPECIAL_ROLE_ID]!.source = {
      authorityMode: "legacy",
      createdAt: 1,
      updatedAt: 1,
    };
    assert.throws(() => createInstance(harness.repo, mismatchedAuthorityFixture), /authorityMode 与快照权威不一致/);
    assert.equal(Number((harness.db.prepare("SELECT COUNT(*) AS count FROM orch_instances").get() as { count: number }).count), before);
  } finally {
    harness.db.close();
  }
});

test("损坏的持久化快照显式失败且 workspace 物理删除级联清理实例", () => {
  const harness = createHarness();
  try {
    const created = createInstance(harness.repo, createFixture());
    const row = harness.db.prepare("SELECT asset_runtime_snapshot_json FROM orch_instances WHERE id = ?")
      .get(created.id) as { asset_runtime_snapshot_json: string };
    const semanticCorruption = JSON.parse(row.asset_runtime_snapshot_json);
    delete semanticCorruption.skills["skill-runtime"].definition.files;
    harness.db.prepare("UPDATE orch_instances SET asset_runtime_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(semanticCorruption), created.id);
    assert.throws(() => harness.repo.get(created.id), new RegExp(`资产运行快照损坏：${created.id}`));

    harness.db.prepare("UPDATE orch_instances SET asset_runtime_snapshot_json = ? WHERE id = ?")
      .run("{broken", created.id);
    const listRows = harness.repo.listSummariesByIntakeIds(WORKSPACE_ID, [created.intakeSnapshot.id]);
    assert.equal(listRows.length, 1);
    assert.equal((listRows[0] as any)?.assetRuntimeSnapshot, undefined);
    assert.throws(() => harness.repo.get(created.id), new RegExp(`资产运行快照损坏：${created.id}`));

    harness.db.prepare("DELETE FROM workspaces WHERE id = ?").run(WORKSPACE_ID);
    assert.equal(harness.db.prepare("SELECT 1 FROM orch_instances WHERE id = ?").get(created.id), undefined);
  } finally {
    harness.db.close();
  }
});
