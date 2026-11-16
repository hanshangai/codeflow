import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchAssetBundle,
  type OrchAssetType,
  type WorkspaceId,
} from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import * as service from "../src/orchestration/assetBundleService.ts";

const WORKSPACE = "local-copy:workspace" as WorkspaceId;

/** 真实仓储提供完整五类依赖图；测试只清理本次独占目录。 */
function setup(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-personal-copy-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: WORKSPACE, title: "Copy", path: directory });
  const knowledge = db.orchKnowledgeBundles.upsert({ id: "knowledge-1" as any, workspaceId: WORKSPACE,
    name: "知识", description: "完整知识", scope: "role", sourceRefs: [], kind: "builtin" });
  const toolset = db.orchToolsets.upsert({ id: "toolset-1" as any, workspaceId: WORKSPACE,
    name: "工具", description: "完整工具", kind: "builtin", tools: [{ id: "tool-1" as any,
      name: "read", description: "read", runtime: "prompt", invocationHint: "read", code: "读取" }] });
  const skill = db.orchSkills.upsert({ id: "skill-1" as any, workspaceId: WORKSPACE,
    name: "技能", description: "完整技能", trigger: "when needed", instructions: "执行", targetEngines: ["codex"],
    kind: "builtin", skillMd: "# 技能\n", scripts: [{ id: "run", name: "Run", description: "run",
      scriptPath: "scripts/run.mjs", runtime: "node" }], files: [
      { relPath: "SKILL.md", kind: "skill-md", contentText: "# 技能\n", sizeBytes: 0, sha256: "" },
      { relPath: "scripts/run.mjs", kind: "script", contentText: "export const value = 1;\n", sizeBytes: 0, sha256: "" },
      { relPath: "assets/image.bin", kind: "asset", contentBase64: "AAECAw==", sizeBytes: 0, sha256: "" },
    ] });
  const role = db.orchRoles.upsert({ id: "role-1" as any, workspaceId: WORKSPACE,
    name: "角色", description: "完整角色", systemPrompt: "执行角色任务", kind: "builtin", builtinGroup: "knowledge",
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
    executionConfig: createDefaultRoleExecutionConfig("codex"), gateCriteria: [],
    defaultKnowledgeBundleIds: [knowledge.id], defaultSkillIds: [skill.id],
    toolRefs: [{ toolsetId: toolset.id, toolId: "tool-1" as any }] });
  const workflow = db.orchWorkflows.upsert({ id: "workflow-1" as any, workspaceId: WORKSPACE,
    name: "流程", description: "完整流程", kind: "builtin", version: 1, workflowKnowledgeBundleIds: [knowledge.id],
    nodes: [{ id: "node-1", type: "role", label: "执行", roleId: role.id, position: { x: 0, y: 0 },
      knowledgeOverrideBundleIds: [knowledge.id] }], edges: [] });
  return { db, directory, knowledge, toolset, skill, role, workflow };
}

/** 快照所有资产行和包正文，检测失败或复制时是否修改了原件。 */
function snapshot(db: ClientDb) {
  return ["orch_roles", "orch_workflows", "orch_knowledge_bundles", "orch_toolsets", "orch_skills", "orch_skill_files"]
    .map(table => db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** 所有根类型走相同业务入口，不在测试中重复依赖映射。 */
function copy(input: { db: ClientDb; directory: string }, assetType: OrchAssetType, assetId: string) {
  return service.copyPersonalOrchAsset({
    db: input.db, workspaceId: WORKSPACE, workspacePath: input.directory, assetType, assetId,
  });
}

test("strict apply rejects missing dependencies before any asset write", (t) => {
  const h = setup(t);
  const bundle = service.exportWorkflowDependencyBundle({ db: h.db, workspaceId: WORKSPACE, workflowIds: [h.workflow.id] });
  bundle.knowledgeBundles = [];
  const before = snapshot(h.db);
  assert.throws(() => service.applyOrchAssetBundle({ db: h.db, workspaceId: WORKSPACE, workspacePath: h.directory,
    bundle, importMode: "copy", strictDependencies: true }), /依赖/);
  assert.deepEqual(snapshot(h.db), before);
});

test("personal workflow copy creates one independent editable graph and leaves originals unchanged", (t) => {
  const h = setup(t);
  const originals = snapshot(h.db);
  const result = copy(h, "workflow", h.workflow.id);
  assert.deepEqual(result.copied, { roles: 1, workflows: 1, knowledgeBundles: 1, toolsets: 1, skills: 1 });
  assert.equal(result.rootAssetId, result.workflows[0]?.id);
  const [role] = result.roles;
  const [workflow] = result.workflows;
  const [knowledge] = result.knowledgeBundles;
  const [skill] = result.skills;
  const [toolset] = result.toolsets;
  for (const [original, duplicate] of [[h.role, role], [h.workflow, workflow], [h.knowledge, knowledge],
    [h.skill, skill], [h.toolset, toolset]] as const) {
    assert.ok(duplicate);
    assert.notEqual(duplicate.id, original.id);
    assert.equal(duplicate.kind, "custom");
    assert.equal(duplicate.name, `${original.name}_复制`);
  }
  assert.equal(role!.builtinGroup, null);
  assert.deepEqual(role!.defaultKnowledgeBundleIds, [knowledge!.id]);
  assert.deepEqual(role!.defaultSkillIds, [skill!.id]);
  assert.deepEqual(role!.toolRefs, [{ toolsetId: toolset!.id, toolId: "tool-1" }]);
  assert.deepEqual(workflow!.workflowKnowledgeBundleIds, [knowledge!.id]);
  assert.equal(workflow!.nodes[0]?.roleId, role!.id);
  assert.deepEqual(workflow!.nodes[0]?.knowledgeOverrideBundleIds, [knowledge!.id]);
  assert.deepEqual(skill!.files, h.skill.files);
  assert.deepEqual(skill!.scripts, h.skill.scripts);
  assert.equal(fs.existsSync(path.join(h.directory, ".codeflowai")), false);
  assert.equal(fs.existsSync(path.join(h.directory, "codeflowai")), false);
  const after = snapshot(h.db);
  originals.forEach((rows, index) => assert.deepEqual(after[index]!.slice(0, rows.length), rows));
  h.db.orchRoles.upsert({ ...role!, name: "独立修改" });
  assert.equal(h.db.orchRoles.get(h.role.id)?.name, "角色");
});

for (const [assetType, assetId, expectedCounts] of [
  ["role", "role-1", [1, 0, 1, 1, 1]],
  ["knowledge_bundle", "knowledge-1", [0, 0, 1, 0, 0]],
  ["skill", "skill-1", [0, 0, 0, 0, 1]],
  ["toolset", "toolset-1", [0, 0, 0, 1, 0]],
] as const) {
  test(`personal copy accepts ${assetType} roots without unrelated assets`, (t) => {
    const h = setup(t);
    const result = copy(h, assetType, assetId);
    assert.deepEqual([result.roles.length, result.workflows.length, result.knowledgeBundles.length,
      result.toolsets.length, result.skills.length], expectedCounts);
    assert.notEqual(result.rootAssetId, assetId);
  });
}

test("personal copy appends _复制 until existing and same-batch names are free", (t) => {
  const h = setup(t);
  h.db.orchRoles.upsert({ ...h.role, id: "role-existing" as any, name: "角色_复制", kind: "custom" });
  const second = h.db.orchRoles.upsert({ ...h.role, id: "role-second" as any });
  h.db.orchWorkflows.upsert({ ...h.workflow, nodes: [...h.workflow.nodes,
    { ...h.workflow.nodes[0]!, id: "node-2", roleId: second.id }] });
  const first = copy(h, "workflow", h.workflow.id);
  assert.deepEqual(first.roles.map(role => role.name), ["角色_复制_复制", "角色_复制_复制_复制"]);
  const next = copy(h, "workflow", h.workflow.id);
  assert.deepEqual(next.roles.map(role => role.name), ["角色_复制_复制_复制_复制", "角色_复制_复制_复制_复制_复制"]);
});

for (const mutation of ["missing-root", "foreign-root", "missing-knowledge", "foreign-role", "missing-skill", "missing-tool"] as const) {
  test(`personal copy fails atomically for ${mutation}`, (t) => {
    const h = setup(t);
    let rootId: string = h.workflow.id;
    if (mutation === "missing-root") rootId = "not-found";
    if (mutation === "foreign-root") {
      h.db.workspaces.upsert({ id: "other:workspace" as WorkspaceId, title: "Other", path: h.directory });
      rootId = h.db.orchWorkflows.upsert({ ...h.workflow, id: "foreign-workflow" as any,
        workspaceId: "other:workspace" as WorkspaceId }).id;
    }
    if (mutation === "missing-knowledge") h.db.orchKnowledgeBundles.delete(h.knowledge.id);
    if (mutation === "foreign-role") {
      h.db.workspaces.upsert({ id: "other:workspace" as WorkspaceId, title: "Other", path: h.directory });
      h.db.db.prepare("UPDATE orch_roles SET workspace_id = ? WHERE id = ?").run("other:workspace", h.role.id);
    }
    if (mutation === "missing-skill") h.db.orchSkills.delete(h.skill.id);
    if (mutation === "missing-tool") h.db.orchToolsets.upsert({ ...h.toolset, tools: [] });
    const before = snapshot(h.db);
    assert.throws(() => copy(h, "workflow", rootId), /不存在|工作区|依赖|工具|身份/);
    assert.deepEqual(snapshot(h.db), before);
  });
}

for (const mutation of ["missing-skill-md", "missing-script", "wrong-file-hash", "wrong-package-hash"] as const) {
  test(`strict copy preserves invalid Skill evidence and fails for ${mutation}`, (t) => {
    const h = setup(t);
    if (mutation === "missing-skill-md") h.db.db.prepare("DELETE FROM orch_skill_files WHERE skill_id = ? AND rel_path = 'SKILL.md'").run(h.skill.id);
    if (mutation === "missing-script") h.db.db.prepare("DELETE FROM orch_skill_files WHERE skill_id = ? AND rel_path = 'scripts/run.mjs'").run(h.skill.id);
    if (mutation === "wrong-file-hash") h.db.db.prepare("UPDATE orch_skill_files SET sha256 = ? WHERE skill_id = ? AND rel_path = 'SKILL.md'")
      .run("0".repeat(64), h.skill.id);
    if (mutation === "wrong-package-hash") {
      const row = h.db.db.prepare("SELECT definition_json FROM orch_skills WHERE id = ?").get(h.skill.id) as { definition_json: string };
      h.db.db.prepare("UPDATE orch_skills SET definition_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...JSON.parse(row.definition_json), packageHash: "0".repeat(64) }), h.skill.id);
    }
    const before = snapshot(h.db);
    assert.throws(() => copy(h, "workflow", h.workflow.id), /Skill/);
    assert.deepEqual(snapshot(h.db), before);
  });
}

test("strict apply rejects repeated source identities and unknown tool IDs without partial writes", (t) => {
  const h = setup(t);
  const bundle = service.exportWorkflowDependencyBundle({ db: h.db, workspaceId: WORKSPACE, workflowIds: [h.workflow.id] });
  const before = snapshot(h.db);
  const duplicate: OrchAssetBundle = { ...bundle, roles: [...bundle.roles, bundle.roles[0]!] };
  assert.throws(() => service.applyOrchAssetBundle({ db: h.db, workspaceId: WORKSPACE, workspacePath: h.directory,
    bundle: duplicate, strictDependencies: true }), /重复/);
  bundle.roles[0]!.role.toolRefs![0]!.toolId = "unknown-tool" as any;
  assert.throws(() => service.applyOrchAssetBundle({ db: h.db, workspaceId: WORKSPACE, workspacePath: h.directory,
    bundle, strictDependencies: true }), /工具/);
  assert.deepEqual(snapshot(h.db), before);
});

test("strict apply rejects a standalone toolset with a missing tool list before writing", (t) => {
  const h = setup(t);
  const bundle = service.exportToolsetDependencyBundle({ db: h.db, workspaceId: WORKSPACE, toolsetIds: [h.toolset.id] });
  delete (bundle.toolsets[0]!.toolset as Partial<typeof h.toolset>).tools;
  const before = snapshot(h.db);
  assert.throws(() => service.applyOrchAssetBundle({ db: h.db, workspaceId: WORKSPACE, workspacePath: h.directory,
    bundle, strictDependencies: true }), /工具/);
  assert.deepEqual(snapshot(h.db), before);
});

test("strict copy rejects a duplicated Skill file manifest without hiding the unlisted file", (t) => {
  const h = setup(t);
  const row = h.db.db.prepare("SELECT definition_json FROM orch_skills WHERE id = ?").get(h.skill.id) as { definition_json: string };
  const definition = JSON.parse(row.definition_json);
  definition.files[1] = { ...definition.files[0] };
  h.db.db.prepare("UPDATE orch_skills SET definition_json = ? WHERE id = ?").run(JSON.stringify(definition), h.skill.id);
  const before = snapshot(h.db);
  assert.throws(() => copy(h, "workflow", h.workflow.id), /Skill/);
  assert.deepEqual(snapshot(h.db), before);
});

for (const [table, id, mutation] of [
  ["orch_roles", "role-1", "bad-json"],
  ["orch_workflows", "workflow-1", "bad-json"],
  ["orch_knowledge_bundles", "knowledge-1", "bad-json"],
  ["orch_toolsets", "toolset-1", "bad-json"],
  ["orch_roles", "role-1", "foreign-id"],
  ["orch_workflows", "workflow-1", "foreign-workspace"],
  ["orch_knowledge_bundles", "knowledge-1", "foreign-id"],
  ["orch_toolsets", "toolset-1", "foreign-workspace"],
  ["orch_skills", "skill-1", "foreign-id"],
  ["orch_roles", "role-1", "invalid-refs"],
  ["orch_workflows", "workflow-1", "missing-nodes"],
  ["orch_knowledge_bundles", "knowledge-1", "missing-sources"],
  ["orch_toolsets", "toolset-1", "missing-tools"],
] as const) {
  test(`strict copy rejects raw ${table} ${mutation} before normalized fallback`, (t) => {
    const h = setup(t);
    const row = h.db.db.prepare(`SELECT definition_json FROM ${table} WHERE id = ?`).get(id) as { definition_json: string };
    const definition = JSON.parse(row.definition_json);
    if (mutation === "foreign-id") definition.id = "foreign-id";
    if (mutation === "foreign-workspace") definition.workspaceId = "other:workspace";
    if (mutation === "invalid-refs") definition.defaultKnowledgeBundleIds = {};
    if (mutation === "missing-nodes") delete definition.nodes;
    if (mutation === "missing-sources") delete definition.sourceRefs;
    if (mutation === "missing-tools") delete definition.tools;
    h.db.db.prepare(`UPDATE ${table} SET definition_json = ? WHERE id = ?`)
      .run(mutation === "bad-json" ? "{broken" : JSON.stringify(definition), id);
    const before = snapshot(h.db);
    assert.throws(() => copy(h, "workflow", h.workflow.id));
    assert.deepEqual(snapshot(h.db), before);
  });
}

test("a late repository failure rolls back the entire personal copy", (t) => {
  const h = setup(t);
  h.db.db.exec(`CREATE TRIGGER reject_copy BEFORE INSERT ON orch_workflows
    WHEN NEW.id <> 'workflow-1' BEGIN SELECT RAISE(ABORT, 'copy-write-failed'); END`);
  const before = snapshot(h.db);
  assert.throws(() => copy(h, "workflow", h.workflow.id), /copy-write-failed/);
  assert.deepEqual(snapshot(h.db), before);
});
