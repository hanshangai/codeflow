import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRoleExecutionConfig, type DesktopApiRequest, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.ts";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { getRuntimeEngineModels, resolveRuntimeThreadPrefsWithCatalogDefaults, initializeLocalEngineModelCatalog } from "../src/engines/engineModelCatalogRuntime.ts";
import { buildLegacyBuiltinAssetId } from "../src/orchestration/assetBundleService.ts";

/** 临时应用库与工作区库保留真实路由、仓储和业务处理器。 */
async function fixture(t: test.TestContext) {
  initializeLocalEngineModelCatalog();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-independent-")), root = path.join(directory, "project");
  fs.mkdirSync(root);
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sent: unknown[] = [];
  const ctx = { db, clientId: "local-audit", workspaces: new Map<WorkspaceId, string>(), threads: new ThreadStore(),
    send: (message: unknown) => { sent.push(message); } } as unknown as ApiHandlerContext;
  let sequence = 0;
  const call = (request: DesktopApiRequest) => executeDesktopApiRequest(ctx, request, { requestId: `audit-${++sequence}`, clientVersion: "1.0.0", startedAt: 1 });
  const created = await call({ method: "workspaces.upsert", body: { path: root, title: "本机工作区" } });
  assert.equal(created.status, 200, JSON.stringify(created));
  const workspaceId = (created.body as any).workspace.id as WorkspaceId;
  const scoped = db.forWorkspace(workspaceId);
  return { ctx, db, scoped, workspaceId, call, sent, directory };
}

/** 保留完整角色定义，让测试只改变待验证的身份与依赖。 */
function createRole(f: Awaited<ReturnType<typeof fixture>>, id: string, extra: Record<string, unknown> = {}) {
  return f.scoped.orchRoles.upsert({ id, workspaceId: f.workspaceId, name: id, description: "", responsibility: "开发", systemPrompt: "实现需求",
    inputDefinition: { instructions: "{{requirement}}", requiredFields: [] }, outputDefinition: { instructions: "结果", deliveryMode: "direct", format: "markdown", requiredFields: [] },
    gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom", ...extra } as never);
}

test("desktop custom model CRUD writes the real local catalog without a cloud owner", async t => {
  const f = await fixture(t);
  const created = await f.call({ method: "engineCustomModels.upsert", body: { workspaceId: f.workspaceId, engine: "codex", providerId: "openai", modelId: "audit-model", displayName: "本机模型", contextWindow: 32000, maxContextWindow: 64000 } });
  assert.equal(created.status, 200, JSON.stringify(created));
  const model = (created.body as any).model;
  assert.equal(f.db.engineCustomModels.get(model.id)?.modelId, "audit-model");
  const listed = await f.call({ method: "engineCustomModels.list", body: { workspaceId: f.workspaceId } });
  assert.equal((listed.body as any).models[0].displayName, "本机模型");
  const updated = await f.call({ method: "engineCustomModels.upsert", body: { workspaceId: f.workspaceId, id: model.id, engine: "codex", providerId: "openai", modelId: "audit-model", displayName: "修改后" } });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.equal(f.db.engineCustomModels.get(model.id)?.displayName, "修改后");
  assert.equal((await f.call({ method: "engineCustomModels.delete", body: { workspaceId: f.workspaceId, id: model.id } })).status, 200);
  assert.equal(f.db.engineCustomModels.get(model.id), null);
  assert.equal((await f.call({ method: "engineCustomModels.list", body: { workspaceId: "other:project" } })).status, 400);
  assert.deepEqual(f.sent, []);
});

test("desktop asset exchange preserves personal assets and forbids forging builtin authority", async t => {
  const f = await fixture(t);
  const role = f.scoped.orchRoles.upsert({ id: "local-role", workspaceId: f.workspaceId, name: "开发", description: "", responsibility: "开发", systemPrompt: "实现需求",
    inputDefinition: { instructions: "{{requirement}}", requiredFields: [] }, outputDefinition: { instructions: "结果", deliveryMode: "direct", format: "markdown", requiredFields: [] },
    gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" } as never);
  const exported = await f.call({ method: "orch.assetBundles.export", body: { workspaceId: f.workspaceId, roleIds: [role.id] } });
  assert.equal(exported.status, 200, JSON.stringify(exported));
  const bundle = (exported.body as any).bundle;
  const imported = await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle, importMode: "copy" } });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  assert.equal((imported.body as any).imported.roles[0].kind, "custom");
  const forged = structuredClone(bundle); forged.source.kind = "server-default";
  assert.equal((await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle: forged, importMode: "overwrite" } })).status, 403);
});

test("desktop packaged preview needs no workspace or account and pending reads stay local", async t => {
  const f = await fixture(t);
  const pending = await f.call({ method: "orch.pendingMine.list", body: { workspaceId: f.workspaceId, limit: 10 } });
  assert.equal(pending.status, 200, JSON.stringify(pending));
  assert.deepEqual((pending.body as any).items, []);
  f.ctx.loadServerDefaultBundles = async () => [{ schemaVersion: 1, bundleVersion: 3, bundleId: "packaged", source: { kind: "server-default" },
    roles: [{ sourceId: "developer", role: { name: "role" } }], workflows: [{ sourceId: "flow", workflow: { name: "workflow" } }],
    skills: [{ sourceId: "skill", skill: { name: "skill" } }], knowledgeBundles: [{ sourceId: "knowledge", knowledgeBundle: { name: "knowledge_bundle" } }],
    toolsets: [{ sourceId: "tools", toolset: { name: "toolset" } }] } as never];
  for (const assetType of ["role", "workflow", "skill", "knowledge_bundle", "toolset"]) {
    const preview = await f.call({ method: "runtime.builtinAssets.list", body: { assetType } });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const item = (preview.body as any).items[0];
    assert.equal(item.definition.name, assetType);
    assert.equal(item.definition.kind, "builtin");
    assert.equal(item.assetType, assetType);
  }
  assert.equal((await f.call({ method: "runtime.builtinAssets.list", body: { assetType: "unknown" } })).status, 400);
});

test("废弃窗口配置接口显式拒绝请求，不再写入本机偏好", async t => {
  const f = await fixture(t);
  for (const method of ["modelContext.list", "modelContext.save", "modelContext.replace"]) {
    const result = await f.call({ method, body: { engine: "codex", modelId: "gpt-6-astra", contextWindow: 32000 } } as unknown as DesktopApiRequest);
    assert.equal(result.status, 404, JSON.stringify(result));
    assert.equal((result.body as any).ok, false);
  }
  assert.equal((f.db.applicationDb.prepare("SELECT count(*) AS total FROM local_model_context_preferences").get() as any).total, 0);
});

test("personal imports reject builtin kind and group metadata in every asset collection before writing", async t => {
  const f = await fixture(t), role = createRole(f, "safe-role");
  const exported = await f.call({ method: "orch.assetBundles.export", body: { workspaceId: f.workspaceId, roleIds: [role.id] } });
  const original = (exported.body as any).bundle;
  const definitions = [
    ["roles", "role", original.roles[0].role],
    ["workflows", "workflow", { name: "流程", nodes: [], edges: [] }],
    ["knowledgeBundles", "knowledgeBundle", { name: "知识", scope: "role", sourceRefs: [] }],
    ["toolsets", "toolset", { name: "工具", tools: [] }],
    ["skills", "skill", { name: "技能", skillMd: "# Skill", targetEngines: ["codex"] }],
  ] as const;
  for (const [collection, field, definition] of definitions) {
    for (const metadata of [{ kind: "builtin" }, { builtinGroup: "forged" }]) {
      const bundle = { ...structuredClone(original), bundleId: `forged-${collection}-${Object.keys(metadata)[0]}`,
        roles: [], workflows: [], knowledgeBundles: [], toolsets: [], skills: [] };
      bundle[collection] = [{ sourceId: "forged", [field]: { ...definition, ...metadata } }];
      const result = await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle, importMode: "copy" } });
      assert.equal(result.status, 403, `${collection}: ${JSON.stringify(metadata)} ${JSON.stringify(result)}`);
    }
  }
  assert.equal(f.scoped.orchRoles.listByWorkspace(f.workspaceId).length, 1);
  assert.equal(f.scoped.orchToolsets.listByWorkspace(f.workspaceId).length, 0);
});

test("copy import uses fresh IDs even when the stable overwrite target is builtin or cached", async t => {
  const f = await fixture(t), role = createRole(f, "copy-source");
  const exported = await f.call({ method: "orch.assetBundles.export", body: { workspaceId: f.workspaceId, roleIds: [role.id] } });
  const bundle = (exported.body as any).bundle;
  const targetId = buildLegacyBuiltinAssetId({ bundleId: bundle.bundleId, workspaceId: f.workspaceId, assetType: "role", sourceId: role.id });
  createRole(f, targetId, { kind: "builtin", name: "原内置" });
  const copied = await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle, importMode: "copy" } });
  assert.equal(copied.status, 200, JSON.stringify(copied));
  assert.notEqual((copied.body as any).imported.roles[0].id, targetId);
  assert.equal(f.scoped.orchRoles.get(targetId as never)?.name, "原内置");
  const overwritten = await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle, importMode: "overwrite" } });
  assert.equal(overwritten.status, 403);
  assert.equal(f.scoped.orchRoles.get(targetId as never)?.name, "原内置");
});

test("desktop export rejects a missing transitive dependency without trimming the original role", async t => {
  const f = await fixture(t), role = createRole(f, "broken-role", { defaultKnowledgeBundleIds: ["missing-knowledge"] });
  const result = await f.call({ method: "orch.assetBundles.export", body: { workspaceId: f.workspaceId, roleIds: [role.id] } });
  assert.equal(result.status, 400, JSON.stringify(result));
  assert.equal((result.body as any).ok, false);
  assert.deepEqual(f.scoped.orchRoles.get(role.id)?.defaultKnowledgeBundleIds, ["missing-knowledge"]);
});

test("desktop strict export preserves a complete role dependency closure and Skill file bytes", async t => {
  const f = await fixture(t);
  const tools = f.scoped.orchToolsets.upsert({ id: "local-tools", workspaceId: f.workspaceId, name: "工具", tools: [{ id: "read", name: "Read" }], kind: "custom" } as never);
  const knowledge = f.scoped.orchKnowledgeBundles.upsert({ id: "local-knowledge", workspaceId: f.workspaceId, name: "知识", scope: "role", sourceRefs: [], content: "本机知识", kind: "custom" } as never);
  const skill = f.scoped.orchSkills.upsert({ id: "local-skill", workspaceId: f.workspaceId, name: "Skill", skillMd: "# Skill\n本机技能", targetEngines: ["codex"], kind: "custom" } as never);
  const role = createRole(f, "complete-role", { defaultKnowledgeBundleIds: [knowledge.id], defaultSkillIds: [skill.id], toolRefs: [{ toolsetId: tools.id, toolId: "read" }] });
  const result = await f.call({ method: "orch.assetBundles.export", body: { workspaceId: f.workspaceId, roleIds: [role.id] } });
  assert.equal(result.status, 200, JSON.stringify(result));
  const bundle = (result.body as any).bundle;
  assert.deepEqual(bundle.roles[0].role.defaultKnowledgeBundleIds, [knowledge.id]);
  assert.deepEqual(bundle.roles[0].role.defaultSkillIds, [skill.id]);
  assert.equal(bundle.knowledgeBundles[0].sourceId, knowledge.id);
  assert.equal(bundle.toolsets[0].sourceId, tools.id);
  assert.equal(bundle.skills[0].skill.files[0].contentText, "# Skill\n本机技能");
  const imported = await f.call({ method: "orch.assetBundles.import", body: { workspaceId: f.workspaceId, bundle, importMode: "copy" } });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  const copied = (imported.body as any).imported;
  assert.deepEqual(copied.roles[0].defaultSkillIds, [copied.skills[0].id]);
  assert.deepEqual(copied.roles[0].defaultKnowledgeBundleIds, [copied.knowledgeBundles[0].id]);
  assert.deepEqual(copied.roles[0].toolRefs, [{ toolsetId: copied.toolsets[0].id, toolId: "read" }]);
});

test("历史本机窗口偏好不再压低目录及执行窗口", async t => {
  const f = await fixture(t);
  f.db.applicationDb.prepare("INSERT INTO local_model_context_preferences(engine, model_id, context_window, max_context_window) VALUES (?, ?, ?, ?)")
    .run("codex", "gpt-6-astra", 32000, 64000);
  const model = getRuntimeEngineModels("codex").find(item => item.id === "gpt-6-astra")!;
  assert.equal(model.maxContextWindow, 872000);
  assert.equal(resolveRuntimeThreadPrefsWithCatalogDefaults("codex", { model: model.id, contextWindow: 32000 }).contextWindow, 872000);

});
