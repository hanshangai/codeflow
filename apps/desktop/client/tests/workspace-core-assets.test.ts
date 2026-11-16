import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition,
  type OrchAssetBundle, type RoleDefinition, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { installDesktopBuiltinAssets } from "../src/orchestration/desktopBuiltinAssetService.js";
import { createClientDbOrchAssetLegacyRuntimeReader, OrchAssetAuthorityRuntimeReadService } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";

/** 每例创建三个真实工作区文件，避免多个注册共用物理库掩盖隔离问题。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-assets-"));
  const dbPath = path.join(root, "application.db");
  const db = openClientDb({ dbPath });
  const resources: Array<() => void> = [];
  const workspaces = new Map<WorkspaceId, string>();
  for (const name of ["a", "b", "c"]) {
    const id = `asset-client:${name}` as WorkspaceId, directory = path.join(root, name);
    fs.mkdirSync(directory);
    db.workspaces.upsert({ id, title: name, path: directory });
    workspaces.set(id, directory);
  }
  t.after(() => { for (const close of resources) close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, dbPath, workspaces, resources, ids: [...workspaces.keys()] };
}

/** 保留角色和知识依赖的真实内置包，覆盖清理与版本更新。 */
function bundle(version = 1): OrchAssetBundle {
  return { schemaVersion: "orch-asset-bundle/v1", bundleId: "workspace-core", bundleVersion: version,
    title: "工作区内置", generatedAt: 1, source: { kind: "server-default" }, skills: [], toolsets: [], workflows: [],
    knowledgeBundles: [{ sourceId: "knowledge", knowledgeBundle: { name: `知识${version}`, scope: "role", description: "知识", sourceRefs: [] } }],
    roles: [{ sourceId: "role", role: { name: `角色${version}`, description: "角色", systemPrompt: "执行", kind: "builtin",
      inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
      executionConfig: createDefaultRoleExecutionConfig("codex"), gateCriteria: [], defaultKnowledgeBundleIds: ["knowledge" as never] } }],
  };
}

/** 简单完整角色用于验证同 ID 跨工作区隔离。 */
function role(workspaceId: WorkspaceId, name = "工作区角色"): Omit<RoleDefinition, "createdAt" | "updatedAt"> {
  return { id: "same-role" as RoleDefinition["id"], workspaceId, name, description: "", systemPrompt: "执行",
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
    executionConfig: createDefaultRoleExecutionConfig("codex"), gateCriteria: [], defaultKnowledgeBundleIds: [],
    defaultSkillIds: [], toolRefs: [], kind: "custom", builtinGroup: null };
}

/** 核物理工作区当前定义，失败时整组必须恢复。 */
function snapshot(db: ClientDb) {
  return ["orch_roles", "orch_knowledge_bundles"].map(table => db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** 存储边界保留cause；断言真实业务失败而非外层展示文案。 */
function rootCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? rootCause(error.cause) : error;
}

test("内置资产整组只写各自工作区库，应用库没有定义副本", t => {
  const f = fixture(t);
  installDesktopBuiltinAssets({ db: f.db, bundles: [bundle()], workspaces: f.workspaces });
  assert.equal(f.db.applicationDb.prepare("SELECT COUNT(*) AS count FROM orch_roles").get()?.count, 0);
  for (const workspaceId of f.ids) {
    const view = f.db.forWorkspace(workspaceId);
    assert.equal(view.orchRoles.listByWorkspace(workspaceId)[0]?.name, "角色1");
  }
});

test("内置准备在B失败时保留A提交、回滚B并停止C", t => {
  const f = fixture(t);
  installDesktopBuiltinAssets({ db: f.db, bundles: [bundle()], workspaces: f.workspaces });
  const [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
  const beforeB = snapshot(f.db.forWorkspace(b)), beforeC = snapshot(f.db.forWorkspace(c));
  f.db.forWorkspace(b).db.exec("CREATE TRIGGER fail_builtin BEFORE UPDATE ON orch_roles BEGIN SELECT RAISE(ABORT, 'INJECTED_BUILTIN_WRITE'); END;");
  assert.throws(() => installDesktopBuiltinAssets({ db: f.db, bundles: [bundle(2)], workspaces: f.workspaces }), error =>
    rootCause(error) instanceof Error && (rootCause(error) as Error).message.includes("INJECTED_BUILTIN_WRITE"));
  assert.equal(f.db.forWorkspace(a).orchRoles.listByWorkspace(a)[0]?.name, "角色2");
  assert.deepEqual(snapshot(f.db.forWorkspace(b)), beforeB);
  assert.deepEqual(snapshot(f.db.forWorkspace(c)), beforeC);
});

test("所有包先校验，后续包无效时首工作区也不发生变更", t => {
  const f = fixture(t);
  installDesktopBuiltinAssets({ db: f.db, bundles: [bundle()], workspaces: f.workspaces });
  const before = f.ids.map(id => snapshot(f.db.forWorkspace(id)));
  const invalid = { ...bundle(2), bundleId: "invalid", knowledgeBundles: [] };
  assert.throws(() => installDesktopBuiltinAssets({ db: f.db, bundles: [bundle(2), invalid], workspaces: f.workspaces }), /依赖/);
  assert.deepEqual(f.ids.map(id => snapshot(f.db.forWorkspace(id))), before);
});

test("历史云端接管数据保留但不再冻结本机资产，离线安装与读取不访问网络", t => {
  const f = fixture(t), workspaceId = f.ids[0]!;
  f.db.applicationDb.exec("CREATE TABLE IF NOT EXISTS orch_asset_legacy_authority_state (workspace_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL)");
  f.db.applicationDb.prepare("INSERT INTO orch_asset_legacy_authority_state VALUES (?, ?)").run(workspaceId, 1);
  t.mock.method(globalThis, "fetch", () => { throw new Error("UNEXPECTED_ASSET_NETWORK_REQUEST"); });
  installDesktopBuiltinAssets({ db: f.db, bundles: [bundle()], workspaces: f.workspaces });
  const view = f.db.forWorkspace(workspaceId);
  view.orchRoles.upsert(role(workspaceId, "离线个人角色"));
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.db));
  assert.equal(reader.openWorkspace(workspaceId).getAsset("role", "same-role")?.definition.name, "离线个人角色");
  assert.equal(f.db.applicationDb.prepare("SELECT recorded_at FROM orch_asset_legacy_authority_state WHERE workspace_id = ?").get(workspaceId)?.recorded_at, 1);
});

test("新应用库不创建退役的资产缓存与迁移表", t => {
  const f = fixture(t);
  assert.deepEqual(f.db.applicationDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'orch_asset_cache_%' OR name IN ('orch_asset_migration_lock_state', 'orch_asset_legacy_authority_state'))").all(), []);
});

test("工作区资产整组失败回滚定义，普通事务支持嵌套资产写入", t => {
  const f = fixture(t), workspaceId = f.ids[0]!;
  const failure = new Error("INJECTED_ASSET_GROUP");
  assert.throws(() => f.db.withWorkspaceAssetWrite(workspaceId, view => {
    view.orchRoles.upsert(role(workspaceId));
    throw failure;
  }), error => rootCause(error) === failure);
  const view = f.db.forWorkspace(workspaceId);
  assert.deepEqual(view.orchRoles.listByWorkspace(workspaceId), []);
  view.db.transaction(() => view.orchRoles.upsert(role(workspaceId)))();
  assert.equal(view.orchRoles.get("same-role" as never)?.name, "工作区角色");
});

test("legacy运行读取按W固定资产和快照，同ID不会读应用或其他W", t => {
  const f = fixture(t), [a, b] = f.ids as [WorkspaceId, WorkspaceId];
  f.db.forWorkspace(a).orchRoles.upsert(role(a, "角色A"));
  f.db.forWorkspace(b).orchRoles.upsert(role(b, "角色B"));
  const reader = new OrchAssetAuthorityRuntimeReadService(createClientDbOrchAssetLegacyRuntimeReader(f.db));
  assert.equal(reader.openWorkspace(a).getAsset("role", "same-role")?.definition.name, "角色A");
  assert.equal(reader.openWorkspace(b).getAsset("role", "same-role")?.definition.name, "角色B");
  const contender = openSqliteDb(path.join(f.workspaces.get(a)!, ".codeflowai", "workspace.db"), { busyTimeoutMs: 0 });
  f.resources.push(() => contender.close());
  reader.withWorkspace(a, session => {
    assert.equal(session.listAssets("role")[0]?.definition.name, "角色A");
    assert.throws(() => contender.prepare("UPDATE orch_roles SET name='changed' WHERE id='same-role'").run(),
      error => (error as { errcode?: number }).errcode === 5);
    assert.equal(session.getAsset("role", "same-role")?.definition.name, "角色A");
  });
  contender.prepare("UPDATE orch_roles SET name='changed' WHERE id='same-role'").run();
});
