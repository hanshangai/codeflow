import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition,
  type OrchAssetBundle, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import * as service from "../src/orchestration/desktopBuiltinAssetService.ts";
import { copyPersonalOrchAsset } from "../src/orchestration/assetBundleService.ts";

const FIRST = "local-device:first" as WorkspaceId;
const SECOND = "local-device:second" as WorkspaceId;
const THIRD = "local-device:third" as WorkspaceId;

/** 每例使用真实 SQLite 和独占包目录，避免读取日常数据。 */
function setup(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-builtin-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const bundlesDir = path.join(directory, "orchestration-builtin");
  fs.mkdirSync(bundlesDir);
  const paths = new Map([FIRST, SECOND, THIRD].map(id => [id, path.join(directory, id.split(":")[1]!)]));
  for (const workspacePath of paths.values()) fs.mkdirSync(workspacePath);
  return { db, get view() { return db.forWorkspace(FIRST); }, directory, bundlesDir, paths };
}

/** 小型静态包保留真实角色到知识依赖，覆盖换版和图校验。 */
function bundle(version = 1): OrchAssetBundle {
  return {
    schemaVersion: "orch-asset-bundle/v1", bundleId: "desktop-test", bundleVersion: version,
    title: "桌面内置", generatedAt: 1, source: { kind: "server-default" }, skills: [], toolsets: [], workflows: [],
    knowledgeBundles: [{ sourceId: "kb", knowledgeBundle: { name: `知识${version}`, scope: "role", description: "知识", sourceRefs: [] } }],
    roles: [{ sourceId: "role", role: { name: `角色${version}`, description: "角色", systemPrompt: "执行",
      kind: "builtin", inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
      executionConfig: createDefaultRoleExecutionConfig("codex"), gateCriteria: [], defaultKnowledgeBundleIds: ["kb" as any] } }],
  };
}

/** 可按工作区核完整定义和文件，避免前项提交掩盖失败项变化。 */
function snapshot(db: ClientDb, workspaceId?: WorkspaceId) {
  db = db.forWorkspace(workspaceId ?? FIRST);
  return ["orch_roles", "orch_workflows", "orch_knowledge_bundles", "orch_skills", "orch_skill_files", "orch_toolsets"]
    .map(table => workspaceId === undefined
      ? db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      : table === "orch_skill_files"
        ? db.db.prepare("SELECT * FROM orch_skill_files WHERE skill_id IN (SELECT id FROM orch_skills WHERE workspace_id = ?) ORDER BY rowid").all(workspaceId)
        : db.db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(workspaceId));
}

test("package loader reads actual builtin bytes and refuses missing, empty and invalid packages", (t) => {
  const h = setup(t);
  assert.throws(() => service.readDesktopBuiltinAssetBundles(path.join(h.directory, "missing")), /ENOENT/);
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /DESKTOP_BUILTIN_BUNDLE_EMPTY/);
  const file = path.join(h.bundlesDir, "builtin.json");
  fs.writeFileSync(file, JSON.stringify(bundle()), "utf8");
  assert.deepEqual(service.readDesktopBuiltinAssetBundles(h.bundlesDir), [bundle()]);
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /builtin.json/);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /builtin.json/);
});

test("package loader rejects incomplete graphs, duplicate identities and untrusted sources", (t) => {
  const h = setup(t);
  const file = path.join(h.bundlesDir, "builtin.json");
  const invalid = bundle();
  invalid.knowledgeBundles = [];
  fs.writeFileSync(file, JSON.stringify(invalid), "utf8");
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /依赖/);
  fs.writeFileSync(file, JSON.stringify(bundle()), "utf8");
  fs.writeFileSync(path.join(h.bundlesDir, "duplicate.json"), JSON.stringify(bundle()), "utf8");
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /重复/);
  fs.unlinkSync(path.join(h.bundlesDir, "duplicate.json"));
  invalid.knowledgeBundles = bundle().knowledgeBundles;
  invalid.roles.push(invalid.roles[0]!);
  fs.writeFileSync(file, JSON.stringify(invalid), "utf8");
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /重复/);
  fs.writeFileSync(file, JSON.stringify({ ...bundle(), source: { kind: "workspace-export" } }), "utf8");
  assert.throws(() => service.readDesktopBuiltinAssetBundles(h.bundlesDir), /来源/);
});

test("current package replaces builtins on upgrade and downgrade while personal assets survive", (t) => {
  const h = setup(t);
  h.db.workspaces.upsert({ id: FIRST, title: "first", path: h.paths.get(FIRST)! });
  const workspaces = new Map([[FIRST, h.paths.get(FIRST)!]]);
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces });
  const original = h.view.orchRoles.listByWorkspace(FIRST)[0]!;
  h.view.orchRoles.upsert({ ...original, id: "personal-role" as any, kind: "custom", name: "个人副本" });
  const personal = h.view.orchRoles.get("personal-role" as any);
  const personalSkill = h.view.orchSkills.upsert({ id: "personal-skill" as any, workspaceId: FIRST, name: "个人技能", kind: "custom",
    description: "包文件", trigger: "when needed", instructions: "执行", targetEngines: ["codex"], files: [
      { relPath: "SKILL.md", kind: "skill-md", contentText: "# 个人技能\n", sizeBytes: 0, sha256: "" },
      { relPath: "assets/data.bin", kind: "asset", contentBase64: "AAECAw==", sizeBytes: 0, sha256: "" },
    ] });
  const newer = bundle(2);
  newer.knowledgeBundles.push({ sourceId: "new-kb", knowledgeBundle: { name: "新增", description: "新增", scope: "role", sourceRefs: [] } });
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [newer], workspaces });
  assert.equal(h.view.orchRoles.get(original.id)?.name, "角色2");
  assert.equal(h.view.orchKnowledgeBundles.listByWorkspace(FIRST).length, 2);
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces });
  assert.equal(h.view.orchRoles.get(original.id)?.name, "角色1");
  assert.equal(h.view.orchKnowledgeBundles.listByWorkspace(FIRST).length, 1);
  assert.deepEqual(h.view.orchRoles.get("personal-role" as any), personal);
  assert.deepEqual(h.view.orchSkills.get(personalSkill.id), personalSkill);
  h.view.orchRoles.upsert({ ...h.view.orchRoles.get(original.id)!, name: "被外部改写" });
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces });
  assert.equal(h.view.orchRoles.get(original.id)?.name, "角色1");
  assert.equal(fs.existsSync(path.join(h.paths.get(FIRST)!, ".codeflowai", "codeflowai.json")), false);
  assert.equal(fs.existsSync(path.join(h.paths.get(FIRST)!, "codeflowai", "codeflowai.json")), false);
});

test("新工作区安装遇到既有 v1 展示索引时原位升级，不阻断资产安装或改写会话", t => {
  const h = setup(t);
  h.db.workspaces.upsert({ id: FIRST, title: "existing", path: h.paths.get(FIRST)! });
  const existing = h.db.forWorkspace(FIRST);
  existing.threads.create({ id: "existing-thread", workspaceId: FIRST, engine: "codex", title: "保留会话" });
  existing.conversationEvents.appendEnvelope({ schema: 1, seq: 1, ts: 1, workspaceId: FIRST, threadId: "existing-thread",
    engine: "codex", type: "item.agentMessage.completed", payload: { itemId: "answer", text: "保留正文" } });
  const canonical = existing.db.prepare("SELECT * FROM conversation_events").all();
  existing.db.transaction(() => {
    existing.db.exec("ALTER TABLE conversation_presentations DROP COLUMN build_id");
    existing.db.prepare("UPDATE meta SET value = '1' WHERE key = 'conversation_presentation_schema_version'").run();
  })();
  h.db.workspaces.upsert({ id: SECOND, title: "new", path: h.paths.get(SECOND)! });
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces: new Map([
    [FIRST, h.paths.get(FIRST)!], [SECOND, h.paths.get(SECOND)!],
  ]) });
  for (const id of [FIRST, SECOND]) assert.equal(h.db.forWorkspace(id).orchRoles.listByWorkspace(id).length, 1);
  assert.deepEqual(existing.db.prepare("SELECT * FROM conversation_events").all(), canonical);
  assert.equal(existing.threads.get("existing-thread")?.title, "保留会话");
});

test("a later workspace write failure retains earlier commits, rolls back its workspace and stops the rest", (t) => {
  const h = setup(t);
  for (const id of [FIRST, SECOND, THIRD]) h.db.workspaces.upsert({ id, title: id, path: h.paths.get(id)! });
  const workspaces = new Map([[FIRST, h.paths.get(FIRST)!], [SECOND, h.paths.get(SECOND)!], [THIRD, h.paths.get(THIRD)!]]);
  const previous = bundle();
  previous.knowledgeBundles.push({ sourceId: "retired-kb", knowledgeBundle: { name: "将被移除", description: "旧包", scope: "role", sourceRefs: [] } });
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [previous], workspaces });
  const personal = h.view.orchSkills.upsert({ id: "retained-personal" as any, workspaceId: FIRST, name: "个人技能", kind: "custom",
    description: "独立文件", trigger: "manual", instructions: "执行", targetEngines: ["codex"], files: [
      { relPath: "SKILL.md", kind: "skill-md", contentText: "# 保留个人技能\n", sizeBytes: 0, sha256: "" },
      { relPath: "assets/data.bin", kind: "asset", contentBase64: "AAECAw==", sizeBytes: 0, sha256: "" },
    ] });
  const beforeSecond = snapshot(h.db, SECOND), beforeThird = snapshot(h.db, THIRD);
  const originals = new Map([...workspaces.keys()].map(id => [id, h.db.forWorkspace(id).orchRoles.upsert.bind(h.db.forWorkspace(id).orchRoles)]));
  const failure = new Error("INJECTED_ROLE_WRITE_FAILED");
  const touched: WorkspaceId[] = [];
  for (const id of workspaces.keys()) {
    /** 精确注入各W仓储，第二W在先前知识写入后失败。 */
    h.db.forWorkspace(id).orchRoles.upsert = input => {
      touched.push(input.workspaceId);
      if (input.workspaceId === SECOND) throw failure;
      return originals.get(id)!(input);
    };
  }
  assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle(2)], workspaces }), error => error === failure);
  assert.deepEqual(touched, [FIRST, SECOND]);
  assert.equal(h.view.orchRoles.listByWorkspace(FIRST)[0]!.name, "角色2");
  assert.equal(h.view.orchKnowledgeBundles.listByWorkspace(FIRST).length, 1);
  assert.deepEqual(snapshot(h.db, SECOND), beforeSecond);
  assert.deepEqual(snapshot(h.db, THIRD), beforeThird);
  assert.deepEqual(h.view.orchSkills.get(personal.id), personal);
  for (const id of workspaces.keys()) h.db.forWorkspace(id).orchRoles.upsert = originals.get(id)!;
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle(2)], workspaces });
  for (const id of workspaces.keys()) {
    assert.equal(h.db.forWorkspace(id).orchRoles.listByWorkspace(id)[0]!.name, "角色2");
    assert.equal(h.db.forWorkspace(id).orchKnowledgeBundles.listByWorkspace(id).length, 1);
  }
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [previous], workspaces });
  for (const id of workspaces.keys()) {
    assert.equal(h.db.forWorkspace(id).orchRoles.listByWorkspace(id)[0]!.name, "角色1");
    assert.equal(h.db.forWorkspace(id).orchKnowledgeBundles.listByWorkspace(id).length, 2);
  }
  assert.deepEqual(h.view.orchSkills.get(personal.id), personal);
});

test("all input bundles are validated before the first workspace is changed", (t) => {
  const h = setup(t);
  h.db.workspaces.upsert({ id: FIRST, title: "first", path: h.paths.get(FIRST)! });
  const workspaces = new Map([[FIRST, h.paths.get(FIRST)!]]);
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces });
  const before = snapshot(h.db);
  const invalid = { ...bundle(2), bundleId: "invalid-second" };
  invalid.knowledgeBundles = [];
  assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle(2), invalid], workspaces }), /依赖/);
  assert.deepEqual(snapshot(h.db), before);
});

for (const phase of ["second-bundle", "prune"] as const) {
  test(`${phase} failure rolls back every change in that workspace while retaining earlier workspaces`, (t) => {
    const h = setup(t);
    for (const id of [FIRST, SECOND, THIRD]) h.db.workspaces.upsert({ id, title: id, path: h.paths.get(id)! });
    const workspaces = new Map([[FIRST, h.paths.get(FIRST)!], [SECOND, h.paths.get(SECOND)!], [THIRD, h.paths.get(THIRD)!]]);
    const second = { ...bundle(), bundleId: "second-bundle" };
    const previous = bundle();
    previous.knowledgeBundles.push({ sourceId: "retired-kb", knowledgeBundle: { name: "旧知识", description: "待清理", scope: "role", sourceRefs: [] } });
    service.installDesktopBuiltinAssets({ db: h.db, bundles: [previous, second], workspaces });
    const beforeSecond = snapshot(h.db, SECOND), beforeThird = snapshot(h.db, THIRD);
    const secondDb = h.db.forWorkspace(SECOND);
    const originalUpsert = secondDb.orchRoles.upsert.bind(secondDb.orchRoles);
    const originalDelete = secondDb.orchKnowledgeBundles.delete.bind(secondDb.orchKnowledgeBundles);
    const failure = new Error(`INJECTED_${phase}`);
    let roleWrites = 0;
    /** 第二包写入后失败，验证整组定义回滚。 */
    secondDb.orchRoles.upsert = input => {
      const value = originalUpsert(input);
      if (phase === "second-bundle" && ++roleWrites === 2) throw failure;
      return value;
    };
    /** Deleting the old knowledge really occurs before the injected failure. */
    secondDb.orchKnowledgeBundles.delete = (id) => {
      const item = secondDb.orchKnowledgeBundles.get(id);
      originalDelete(id);
      if (phase === "prune" && item?.workspaceId === SECOND) throw failure;
    };
    assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle(2), { ...second, bundleVersion: 2 }], workspaces }), error => error === failure);
    assert.equal(h.view.orchKnowledgeBundles.listByWorkspace(FIRST).length, 2);
    assert.deepEqual(snapshot(h.db, SECOND), beforeSecond);
    assert.deepEqual(snapshot(h.db, THIRD), beforeThird);
  });
}

test("zero-workspace installation still rejects an incomplete or empty package", (t) => {
  const h = setup(t);
  const invalid = bundle();
  invalid.knowledgeBundles = [];
  assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [invalid], workspaces: new Map() }), /依赖/);
  assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [], workspaces: new Map() }), /DESKTOP_BUILTIN_BUNDLE_EMPTY/);
});

test("installation selects exact hosted local workspace identity without alias fallback", () => {
  const workspaces = new Map([[FIRST, "project"], ["other-device:first" as WorkspaceId, "remote"]]);
  assert.equal(service.isDesktopLocalAssetWorkspace("local-device", workspaces, FIRST), true);
  for (const id of ["first", "other-device:first", "local-device:first:extra", "shared:first", "local-device:missing"]) {
    assert.equal(service.isDesktopLocalAssetWorkspace("local-device", workspaces, id), false);
  }
});

test("a custom asset occupying a deterministic builtin ID stops replacement without data loss", (t) => {
  const h = setup(t);
  h.db.workspaces.upsert({ id: FIRST, title: "first", path: h.paths.get(FIRST)! });
  const workspaces = new Map([[FIRST, h.paths.get(FIRST)!]]);
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle()], workspaces });
  const role = h.view.orchRoles.listByWorkspace(FIRST)[0]!;
  h.view.orchRoles.upsert({ ...role, kind: "custom", name: "必须保留" });
  const before = snapshot(h.db);
  assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [bundle(2)], workspaces }), /DESKTOP_BUILTIN_TARGET_CONFLICT/);
  assert.deepEqual(snapshot(h.db), before);
});

/** 补齐可执行五类图，Skill 使用仓储现有算法生成合法包摘要。 */
function referenceBundle(db: ClientDb, version: number): OrchAssetBundle {
  db = db.forWorkspace(FIRST);
  const value = bundle(version);
  const { id: _id, workspaceId: _workspaceId, createdAt: _createdAt, updatedAt: _updatedAt, ...skill } = db.orchSkills.upsert({
    id: "personal-fixture-skill" as any, workspaceId: FIRST, name: "个人技能原件", kind: "custom", description: "完整包",
    trigger: "when needed", instructions: "执行", targetEngines: ["codex"], skillMd: "# 完整技能\n",
  });
  value.skills = [{ sourceId: "skill", skill }];
  value.toolsets = [{ sourceId: "tools", toolset: { name: "工具", description: "内置工具", kind: "builtin", tools: [
    { id: "read" as any, name: "读取", description: "读取", runtime: "prompt", invocationHint: "read", code: "读取" },
  ] } }];
  value.roles[0]!.role.defaultSkillIds = ["skill" as any];
  value.roles[0]!.role.toolRefs = [{ toolsetId: "tools" as any, toolId: "read" as any }];
  value.workflows = [{ sourceId: "workflow", workflow: { name: "内置流程", description: "完整图", version: 1, kind: "builtin",
    workflowKnowledgeBundleIds: ["kb" as any], nodes: [{ id: "run", type: "role", label: "执行", roleId: "role" as any,
      position: { x: 0, y: 0 }, knowledgeOverrideBundleIds: ["kb" as any] }], edges: [] } }];
  return value;
}

for (const direction of ["upgrade", "downgrade"] as const) {
  for (const dependency of ["role", "role-knowledge", "workflow-knowledge", "node-knowledge", "skill", "toolset", "tool"] as const) {
    test(`${direction} rejects removal of builtin ${dependency} referenced by a custom asset`, (t) => {
      const h = setup(t);
      h.db.workspaces.upsert({ id: FIRST, title: "first", path: h.paths.get(FIRST)! });
      h.db.workspaces.upsert({ id: SECOND, title: "second", path: h.paths.get(SECOND)! });
      const workspaces = new Map([[SECOND, h.paths.get(SECOND)!], [FIRST, h.paths.get(FIRST)!]]);
      const previous = referenceBundle(h.db, direction === "upgrade" ? 1 : 2);
      service.installDesktopBuiltinAssets({ db: h.db, bundles: [previous], workspaces });
      const role = h.view.orchRoles.listByWorkspace(FIRST)[0]!;
      const workflow = h.view.orchWorkflows.listByWorkspace(FIRST)[0]!;
      if (dependency === "role" || dependency === "workflow-knowledge" || dependency === "node-knowledge") {
        h.view.orchWorkflows.upsert({ ...workflow, id: "custom-workflow" as any, kind: "custom",
          workflowKnowledgeBundleIds: dependency === "workflow-knowledge" ? workflow.workflowKnowledgeBundleIds : [],
          nodes: workflow.nodes.map(node => ({ ...node, roleId: dependency === "role" ? node.roleId : null,
            knowledgeOverrideBundleIds: dependency === "node-knowledge" ? node.knowledgeOverrideBundleIds : [] })) });
      } else {
        h.view.orchRoles.upsert({ ...role, id: "custom-role" as any, kind: "custom", defaultKnowledgeBundleIds: dependency === "role-knowledge" ? role.defaultKnowledgeBundleIds : [],
          defaultSkillIds: dependency === "skill" ? role.defaultSkillIds : [], toolRefs: dependency === "tool" || dependency === "toolset" ? role.toolRefs : [] });
      }
      const next = referenceBundle(h.db, direction === "upgrade" ? 2 : 1);
      if (dependency === "role") { next.roles = []; next.workflows[0]!.workflow.nodes[0]!.roleId = null; }
      if (dependency.endsWith("knowledge")) {
        next.knowledgeBundles = []; next.roles[0]!.role.defaultKnowledgeBundleIds = [];
        next.workflows[0]!.workflow.workflowKnowledgeBundleIds = [];
        next.workflows[0]!.workflow.nodes[0]!.knowledgeOverrideBundleIds = [];
      }
      if (dependency === "skill") { next.skills = []; next.roles[0]!.role.defaultSkillIds = []; }
      if (dependency === "toolset") { next.toolsets = []; next.roles[0]!.role.toolRefs = []; }
      if (dependency === "tool") { next.toolsets[0]!.toolset.tools = []; next.roles[0]!.role.toolRefs = []; }
      const beforeFirst = snapshot(h.db, FIRST);
      assert.throws(() => service.installDesktopBuiltinAssets({ db: h.db, bundles: [next], workspaces }), /DESKTOP_BUILTIN_CUSTOM_DEPENDENCY_REMOVED/);
      assert.deepEqual(snapshot(h.db, FIRST), beforeFirst);
      assert.equal(h.db.forWorkspace(SECOND).orchRoles.listByWorkspace(SECOND).length, next.roles.length);
      assert.equal(h.db.forWorkspace(SECOND).orchKnowledgeBundles.listByWorkspace(SECOND).length, next.knowledgeBundles.length);
      assert.equal(h.db.forWorkspace(SECOND).orchSkills.listByWorkspace(SECOND).length, next.skills!.length);
      assert.equal(h.db.forWorkspace(SECOND).orchToolsets.listByWorkspace(SECOND).length, next.toolsets.length);
    });
  }
}

test("independent personal copies remain usable when the package removes their original builtin graph", (t) => {
  const h = setup(t);
  h.db.workspaces.upsert({ id: FIRST, title: "first", path: h.paths.get(FIRST)! });
  const workspaces = new Map([[FIRST, h.paths.get(FIRST)!]]);
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [referenceBundle(h.db, 2)], workspaces });
  const workflow = h.view.orchWorkflows.listByWorkspace(FIRST)[0]!;
  const copied = h.db.withWorkspaceAssetWrite(FIRST, db => copyPersonalOrchAsset({ db, workspaceId: FIRST,
    workspacePath: h.paths.get(FIRST)!, assetType: "workflow", assetId: workflow.id }));
  const next = bundle();
  next.roles = []; next.knowledgeBundles = [];
  service.installDesktopBuiltinAssets({ db: h.db, bundles: [next], workspaces });
  for (const asset of copied.roles) assert.deepEqual(h.view.orchRoles.get(asset.id), asset);
  for (const asset of copied.workflows) assert.deepEqual(h.view.orchWorkflows.get(asset.id), asset);
  for (const asset of copied.knowledgeBundles) assert.deepEqual(h.view.orchKnowledgeBundles.get(asset.id), asset);
  for (const asset of copied.skills) assert.deepEqual(h.view.orchSkills.get(asset.id), asset);
  for (const asset of copied.toolsets) assert.deepEqual(h.view.orchToolsets.get(asset.id), asset);
  const retained = h.view.orchWorkflows.get(copied.rootAssetId as any)!;
  const role = h.view.orchRoles.get(retained.nodes[0]!.roleId!)!;
  assert.equal(role.kind, "custom");
  assert.equal(h.view.orchKnowledgeBundles.get(role.defaultKnowledgeBundleIds![0]!)?.kind, "custom");
  assert.equal(h.view.orchSkills.get(role.defaultSkillIds![0]!)?.packageHash, copied.skills[0]!.packageHash);
  assert.equal(h.view.orchToolsets.get(role.toolRefs![0]!.toolsetId)?.tools[0]!.id, "read");
});

/** 在独占小仓库运行真实构建脚本，校验逻辑仍来自实际源码。 */
function buildFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-builtin-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, "apps", "desktop", "client");
  const source = path.join(client, "assets", "orchestration-builtin");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(client, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
  fs.writeFileSync(path.join(client, "tsconfig.json"), "{}", "utf8");
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules"), path.join(client, "node_modules"), "junction");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../scripts/build-bundle.mjs"), path.join(client, "scripts", "build-bundle.mjs"));
  const entries = ["index.ts", "clientDaemonSupervisor.ts", "fs/workspacePathIndexWorker.ts", "fs/documentAttachmentWorker.ts",
    "db/clientDbReaderWorker.ts", "orchestration/orchAssetBundleValidation.ts", "workspace-migration/workspaceMigrationFileWorker.ts",
    "desktopUninstallWorker.ts", "legacy-migration/legacyClientMigrationWorker.ts"];
  for (const file of entries) {
    const target = path.join(client, "src", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const fixture = true;", "utf8");
  }
  fs.writeFileSync(path.join(client, "src", "orchestration", "orchAssetBundleValidation.ts"),
    `export * from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/orchestration/orchAssetBundleValidation.ts"))};`, "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
  return { client, source, env, script: path.join(client, "scripts", "build-bundle.mjs") };
}

test("Client build copies the original builtin bytes into its payload", (t) => {
  const h = buildFixture(t);
  const bytes = Buffer.from(`${JSON.stringify(bundle(), null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(h.source, "builtin.json"), bytes);
  const result = spawnSync(process.execPath, [h.script], { cwd: h.client, env: h.env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(path.join(h.client, "dist", "orchestration-builtin", "builtin.json")), bytes);
  assert.equal(fs.existsSync(path.join(h.client, "dist", "orchAssetBundleValidation.cjs")), true);
});

test("Client build fails on a dangling builtin dependency before producing a runtime entry", (t) => {
  const h = buildFixture(t);
  const invalid = bundle();
  invalid.knowledgeBundles = [];
  fs.writeFileSync(path.join(h.source, "builtin.json"), JSON.stringify(invalid), "utf8");
  const result = spawnSync(process.execPath, [h.script], { cwd: h.client, env: h.env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /依赖/);
  assert.equal(fs.existsSync(path.join(h.client, "dist", "index.cjs")), false);
});
