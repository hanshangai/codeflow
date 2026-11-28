import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KNOWLEDGE_ARCHITECTURE_DOCUMENTS, KNOWLEDGE_SPECIFICATION_DOCUMENTS } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes, parseKnowledgeAssetTree, withKnowledgeDocumentDefaults } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import { executeKnowledgeAssetReadTool } from "../src/knowledge/knowledgeAssetTools.js";
import { splitKnowledgeDocument } from "../src/knowledge/knowledgeDocumentChunks.js";
import { resolveWorkspaceKnowledgeChatContext } from "../src/app/workspaceKnowledgeChatContext.js";
import { knowledgeHash, knowledgeJson } from "../src/knowledge/knowledgeAssetFiles.js";
import { openClientDb } from "../src/db/clientDb.js";

/** 每例独立真实文件树，不读取或改写仓库现有知识。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-policy-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: "ws" as any, title: "策略", path: root });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  return { root, db, store: new KnowledgeAssetStore(root) };
}
const asset = (id: string, parentId = "knowledge-architecture") => ({ id, parentId, title: id, orderKey: id, summary: "", instructions: "", tags: [], sourceScope: [] });
const architectureGaps = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map(document => `${document.title}：测试项目仅有单个常量，缺少本专题的充分资料。`);

/** 等待真实批任务终态，模型替身仍需实际提交工具结果。 */
async function settle(service: KnowledgeGenerationService, id: string) {
  const deadline = Date.now() + 5000;
  while (service.view(id).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.view(id).active, false);
  return service.view(id);
}

test("空库直接提供三个目录、八份规格和三份架构文档，读取不初始化文件", t => {
  const { root, store } = fixture(t);
  const snapshot = store.snapshot(true);
  assert.deepEqual(snapshot.tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes);
  assert.deepEqual(snapshot.tree.nodes.filter(node => node.parentId === "knowledge-specifications").map(node => node.title), KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => document.title));
  assert.deepEqual(snapshot.tree.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => node.title), ["架构总览", "核心流程", "关键机制"]);
  assert.deepEqual(store.rules(), { rules: [], scoped: [] });
  assert.equal(snapshot.tree.schemaVersion, 3);
  assert.equal(snapshot.initialized, false);
  assert.equal(snapshot.treeHash, null);
  assert.equal(snapshot.knowledgeId, null);
  const result = executeKnowledgeAssetReadTool(store, "knowledge.tree.read", { parentId: null });
  assert.equal(result.ok, true);
  assert.deepEqual((result.output as { nodes: unknown[] }).nodes, knowledgeCategoryNodes());
  for (const node of snapshot.tree.nodes) {
    assert.equal(store.detail(node.id).node.id, node.id);
    assert.deepEqual(store.revisions(node.id), []);
  }
  assert.equal(fs.existsSync(path.join(root, store.root)), false);
});

test("已有架构文档复用原ID，核心流程旧名兼容且读取不改写文件", t => {
  const { store } = fixture(t);
  const tree = { schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(),
    { ...asset("existing-overview"), title: "架构总览" },
    { ...asset("existing-flows"), title: "核心业务流程" },
  ] };
  store.files.write(`${store.root}/knowledge.json`, knowledgeJson({ schemaVersion: 3, id: "kb_existing_architecture" }));
  const bytes = knowledgeJson(tree);
  store.files.write(`${store.root}/tree.json`, bytes);
  const projected = store.readTree();
  assert.deepEqual(projected.tree.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => [node.id, node.title]), [
    ["existing-overview", "架构总览"], ["existing-flows", "核心流程"], ["knowledge-architecture-key-mechanisms", "关键机制"],
  ]);
  assert.equal(projected.hash, knowledgeHash(bytes));
  assert.equal(store.files.read(`${store.root}/tree.json`).toString("utf8"), bytes);
});

test("空库默认架构文档可以独立采用，其他默认节点保持空白且不作为规格生效", t => {
  const { store } = fixture(t);
  const drafts = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map(document => store.saveDocument({ nodeId: document.id,
    content: `# ${document.title}\n已核对实现。`, origin: "manual", sources: [], expectedHash: null, adopt: false }));
  assert.equal(store.readTree(false).hash, null);
  store.adoptMany(drafts.map(draft => draft.nodeId));
  assert.deepEqual(store.readTree(false).tree.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => node.id), drafts.map(draft => draft.nodeId));
  assert.ok(drafts.every(draft => store.currentRevisionId(draft.nodeId) === draft.id));
  assert.equal(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-specifications").length, 8);
  assert.deepEqual(store.rules(), { rules: [], scoped: [] });
});

test("空库手工编辑或独立采用默认规格后立即生效，保留其他草稿", t => {
  for (const mode of ["edit", "adopt", "batch", "failed-tree"] as const) {
    const { store } = fixture(t);
    const drafts = KNOWLEDGE_SPECIFICATION_DOCUMENTS.slice(0, 2).map(document => store.saveDocument({ nodeId: document.id, content: `# ${document.title}\n已确认要求。`, origin: "manual", sources: [], expectedHash: null, adopt: false }));
    assert.equal(store.readTree(false).hash, null);
    if (mode === "failed-tree") {
      const write = store.files.write.bind(store.files);
      store.files.write = (relative, content) => {
        if (relative.endsWith("/tree.json")) throw new Error("默认文档发布失败");
        write(relative, content);
      };
      assert.throws(() => store.saveDocument({ nodeId: drafts[0]!.nodeId, content: "修改草稿", origin: "manual", sources: [], expectedHash: null, adopt: true }), /默认文档发布失败/);
      assert.equal(store.currentRevisionId(drafts[0]!.nodeId), null);
      assert.equal(store.revisions(drafts[0]!.nodeId).length, 2);
      assert.equal(store.revisions(drafts[1]!.nodeId).length, 1);
      assert.equal(store.rules().rules.length, 0);
      continue;
    }
    if (mode === "edit") store.saveDocument({ nodeId: drafts[0]!.nodeId, content: "# 项目约定\n编辑后生效。", origin: "manual", sources: [], expectedHash: null, adopt: true });
    if (mode === "adopt") store.adopt(drafts[0]!.nodeId, drafts[0]!.id, null);
    if (mode === "batch") store.adoptMany(drafts.map(draft => draft.nodeId));
    const adopted = mode === "batch" ? 2 : 1;
    assert.equal(store.rules().rules.length, adopted);
    assert.equal(store.readTree(false).tree.nodes.filter(node => node.parentId === "knowledge-specifications").length, adopted);
    assert.equal(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-specifications").length, 8);
    assert.ok(store.revisions(drafts[1]!.nodeId).some(revision => revision.id === drafts[1]!.id));
  }
});

test("默认规格非法结构编辑在写入前失败，正文和适用范围仍可维护", t => {
  const { store } = fixture(t);
  const saved = store.saveTree(store.readTree().tree, null);
  const bytes = store.files.read(`${store.root}/tree.json`);
  for (const change of [{ title: "其他名称" }, { parentId: "knowledge-architecture" }, { contentMode: "directory" }, { archived: true }]) {
    assert.throws(() => store.saveTree({ ...saved.tree, nodes: saved.tree.nodes.map(node => node.id === "knowledge-spec-project" ? { ...node, ...change } : node) }, saved.hash), /默认规格文档须保留/);
    assert.deepEqual(store.files.read(`${store.root}/tree.json`), bytes);
    assert.equal(store.snapshot().treeHash, saved.hash);
  }
  const scoped = store.saveTree({ ...saved.tree, nodes: saved.tree.nodes.map(node => node.id === "knowledge-spec-project" ? { ...node, appliesTo: ["src"] } : node) }, saved.hash);
  assert.deepEqual(store.readTree().tree.nodes.find(node => node.id === "knowledge-spec-project")?.appliesTo, ["src"]);
  assert.equal(store.readTree().hash, scoped.hash);
});

test("默认规格继承分类范围，局部同名不占用全局默认文档", t => {
  const { store } = fixture(t);
  const roots = knowledgeCategoryNodes().map(node => node.category === "specifications" ? { ...node, appliesTo: ["src"] } : node);
  const custom = { ...asset("custom-project", "knowledge-specifications"), title: "项目约定", contentMode: "generated" as const };
  const saved = store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...roots, custom] }, null);
  const tree = store.readTree().tree;
  assert.equal(tree.nodes.filter(node => node.title === "项目约定").length, 1);
  assert.equal(tree.nodes.some(node => node.id === "knowledge-spec-project"), false);
  assert.equal(tree.nodes.find(node => node.id === "knowledge-spec-coding")?.appliesTo, undefined);
  store.saveTree(tree, saved.hash);
  store.saveDocument({ nodeId: "knowledge-spec-coding", content: "异步错误必须显式失败。", origin: "manual", sources: [], expectedHash: null });
  assert.equal(store.rules().rules.length, 0);
  assert.deepEqual(store.rules(["src/a.ts"]).rules[0]?.appliesTo, ["src"]);
  assert.equal(store.rules(["docs/a.md"]).rules.length, 0);
  const global = withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...custom, appliesTo: ["src"] }] });
  assert.equal(global.nodes.filter(node => node.title === "项目约定").length, 2);
  assert.ok(global.nodes.some(node => node.id === "knowledge-spec-project"));
  const reordered = withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: [
    ...knowledgeCategoryNodes().map(node => node.category === "specifications" ? { ...node, appliesTo: ["src", "docs"] } : node),
    { ...custom, appliesTo: ["docs", "src", "src"] },
  ] });
  assert.deepEqual(reordered.nodes.filter(node => node.title === "项目约定").map(node => node.id), [custom.id]);
});

test("历史三类候选采用保留同名真实ID，不与读取投影的默认节点重复", t => {
  const { store, db } = fixture(t);
  const saved = store.saveTree({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }, null);
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw new Error("历史候选不应调用模型"); }, "historical-spec", () => ({ nodeId: null, activationVersion: 1 }), db);
  const started = service.begin({ requestId: "historical-spec", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: saved.hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  const reference = { ...asset("custom-project", "knowledge-specifications"), title: "项目约定", contentMode: "reference" as const, reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } };
  const run = store.readRun(started.id);
  run.baseTree = saved.tree;
  run.proposedTree = { ...saved.tree, nodes: [...saved.tree.nodes, reference] };
  run.phase = "completed";
  store.saveRun(run);
  const preview = service.preview(run.id);
  assert.equal(preview.tree.nodes.filter(node => node.title === "项目约定").length, 1);
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0]?.canApply, true, JSON.stringify(preview.items));
  service.apply(run.id, { requestId: "historical-spec-apply", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: reference.id, revisionId: null }] });
  assert.deepEqual(store.readTree().tree.nodes.filter(node => node.title === "项目约定").map(node => node.id), [reference.id]);
  assert.equal(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-specifications").length, 8);
});

test("默认规格已落盘时，旧同名自定义候选须重新构建，不能重复采用", t => {
  const { store, db } = fixture(t);
  const saved = store.saveTree({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }, null);
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw new Error("历史候选不应调用模型"); }, "materialized-spec", () => ({ nodeId: null, activationVersion: 1 }), db);
  const started = service.begin({ requestId: "materialized-spec", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: saved.hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  const reference = { ...asset("custom-project", "knowledge-specifications"), title: "项目约定", contentMode: "reference" as const, reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } };
  const run = store.readRun(started.id);
  run.baseTree = saved.tree;
  run.proposedTree = { ...saved.tree, nodes: [...saved.tree.nodes, reference] };
  run.phase = "completed";
  store.saveRun(run);
  const materialized = store.saveTree(store.readTree().tree, saved.hash);
  const preview = service.preview(run.id);
  assert.equal(preview.items[0]?.canApply, false);
  assert.match(preview.items[0]?.reason ?? "", /同名默认规格文档已创建/);
  assert.throws(() => service.apply(run.id, { requestId: "duplicate-apply", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: reference.id, revisionId: null }] }), /同名默认规格文档已创建/);
  assert.equal(store.readTree().hash, materialized.hash);
  assert.equal(store.readTree().tree.nodes.filter(node => node.title === "项目约定").length, 1);
});

test("旧空树只补默认导航并保持文件基线，非空旧树保留原结构", t => {
  const { store } = fixture(t);
  const saved = store.saveTree({ schemaVersion: 2, instructions: "已确认的项目要求", nodes: [] }, null);
  const bytes = store.files.read(`${store.root}/tree.json`);
  assert.deepEqual(store.readTree().tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes);
  assert.equal(store.readTree().tree.instructions, "已确认的项目要求");
  assert.equal(store.readTree().hash, saved.hash);
  assert.deepEqual(store.files.read(`${store.root}/tree.json`), bytes);
  const old = { schemaVersion: 2, instructions: "已确认的项目要求", nodes: [{ ...asset("legacy"), parentId: null }] };
  store.saveTree(old, saved.hash);
  assert.deepEqual(new KnowledgeAssetStore(store.files.root).readTree().tree, old);
  const migrated = store.saveTree({ ...old, schemaVersion: 3, nodes: [...knowledgeCategoryNodes(), asset("legacy")] }, store.readTree().hash);
  assert.throws(() => store.saveTree(old, migrated.hash), /不能将知识库降为旧文件协议/);
  assert.throws(() => store.saveTree({ ...migrated.tree, nodes: knowledgeCategoryNodes() }, migrated.hash), /不能从树中直接删除/);
});

test("只有项目清单时提供默认目录，读取不补写知识树", t => {
  const { store } = fixture(t);
  const manifestPath = `${store.root}/knowledge.json`;
  store.files.write(manifestPath, knowledgeJson({ schemaVersion: 3, id: "kb_manifest_only" }));
  const bytes = store.files.read(manifestPath);
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes);
  assert.equal(snapshot.knowledgeId, "kb_manifest_only");
  assert.equal(snapshot.treeHash, null);
  assert.equal(snapshot.initialized, false);
  assert.equal(store.files.exists(`${store.root}/tree.json`), false);
  assert.deepEqual(store.files.read(manifestPath), bytes);
});

test("旧空库的待采用候选不因默认导航而失效，冻结协议仍可预览和采用", t => {
  const { store, db } = fixture(t);
  const saved = store.saveTree({ schemaVersion: 2, instructions: "", nodes: [] }, null);
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw new Error("历史候选不应调用模型"); }, "legacy-preview", () => ({ nodeId: null, activationVersion: 1 }), db);
  const started = service.begin({ requestId: "legacy-preview", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: saved.hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  const reference = { ...asset("legacy-reference"), parentId: null, contentMode: "reference" as const, reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } };
  const run = store.readRun(started.id);
  run.baseTree = saved.tree;
  run.proposedTree = { ...saved.tree, nodes: [reference] };
  run.phase = "completed";
  store.saveRun(run);
  assert.equal(store.readTree().tree.schemaVersion, 3);
  assert.equal(store.readTree(false).tree.schemaVersion, 2);
  assert.deepEqual(store.forRun(run.id).readTree().tree, run.proposedTree);
  const preview = service.preview(run.id);
  assert.equal(preview.treeHash, saved.hash);
  assert.equal(preview.items[0]?.canApply, true, JSON.stringify(preview.items));
  service.apply(run.id, { requestId: "legacy-adopt", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: reference.id, revisionId: null }] });
  assert.equal(store.readTree().tree.schemaVersion, 2);
  assert.equal(store.detail(reference.id).reference?.path, "src/a.ts");
});

test("版本3只有三个用途根，旧版本不能静默丢弃分类或适用范围", () => {
  const tree = { schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() };
  assert.equal(parseKnowledgeAssetTree(tree).nodes.length, 3);
  assert.throws(() => parseKnowledgeAssetTree({ ...tree, schemaVersion: 2 }), /版本 3/);
  assert.throws(() => parseKnowledgeAssetTree({ ...tree, nodes: [...tree.nodes, { ...asset("extra"), parentId: null }] }), /一级目录固定/);
  assert.throws(() => parseKnowledgeAssetTree({ ...tree, nodes: [...tree.nodes, { ...asset("wrong"), appliesTo: ["src"] }] }), /只有规格约束/);
  assert.throws(() => parseKnowledgeAssetTree({ ...tree, nodes: [...tree.nodes, { ...asset("nested"), category: "product" }] }), /一级目录/);
});

test("系统架构兼容旧分类名，读取保留文件指纹且历史候选不产生改名待办", t => {
  const { root, store, db } = fixture(t);
  const tree = { schemaVersion: 3 as const, instructions: "", nodes: knowledgeCategoryNodes() };
  store.saveTree(tree, null);
  const old = { ...tree, nodes: tree.nodes.map(node => node.category === "architecture" ? { ...node, title: "架构机制" } : node) };
  const legacyBytes = knowledgeJson(old), treePath = path.join(root, store.root, "tree.json");
  fs.writeFileSync(treePath, legacyBytes, "utf8");
  const reopened = new KnowledgeAssetStore(root), read = reopened.readTree();
  assert.equal(read.tree.nodes.find(node => node.id === "knowledge-architecture")?.title, "系统架构");
  assert.equal(read.hash, knowledgeHash(legacyBytes));
  assert.equal(fs.readFileSync(treePath, "utf8"), legacyBytes);
  const service = new KnowledgeGenerationService(reopened, "ws", async () => {}, "rename", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "rename", mode: "build", ownerThreadId: "owner", selectedNodeIds: ["knowledge-architecture"], includeDescendants: true, strategy: "all", prompt: "", treeHash: read.hash, engine: "codex" });
  reopened.saveRun({ ...run, baseTree: old, proposedTree: old, phase: "completed" });
  const preview = service.preview(run.id);
  assert.deepEqual(preview.items, []);
  assert.equal(preview.tree.nodes.find(node => node.id === "knowledge-architecture")?.title, "系统架构");
  assert.equal(preview.treeHash, read.hash);
  assert.equal(reopened.readRun(run.id).baseTree?.nodes.find(node => node.id === "knowledge-architecture")?.title, "架构机制");
  assert.throws(() => parseKnowledgeAssetTree({ ...old, nodes: old.nodes.map(node => node.category === "architecture" ? { ...node, title: "随意改名" } : node) }), /一级目录固定/);
});

test("旧名称的未完成采用按冻结回执续做，不改写目标指纹", t => {
  const { store, db } = fixture(t);
  const saved = store.saveTree({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }, null);
  const service = new KnowledgeGenerationService(store, "ws", async () => {}, "legacy-receipt", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "legacy-receipt", mode: "build", ownerThreadId: "owner", selectedNodeIds: ["knowledge-architecture"], includeDescendants: true, strategy: "all", prompt: "", treeHash: saved.hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  const candidate = parseKnowledgeAssetTree({ ...saved.tree, nodes: [...saved.tree.nodes, { ...asset("candidate"), contentMode: "generated" }] });
  const frozen = { ...candidate, nodes: candidate.nodes.map(node => node.category === "architecture" ? { ...node, title: "架构机制" } : node) };
  store.saveRun({ ...run, proposedTree: frozen });
  const revision = store.forRun(run.id).saveDocument({ nodeId: "candidate", content: "# 跨模块边界", sources: [], expectedHash: null, origin: "ai", runId: run.id, adopt: false });
  const selection = { nodeId: "candidate", revisionId: revision.id };
  const input = { requestId: "legacy-adoption", treeHash: saved.hash, planHash: "a".repeat(64), selections: [selection] };
  const targetTreeHash = knowledgeHash(knowledgeJson(frozen));
  store.updateRun(run.id, current => {
    current.phase = "completed";
    current.items = [{ id: "item", nodeId: "candidate", title: "candidate", expectedHash: null, inheritedInstructions: "", instructions: "", status: "completed", revisionId: revision.id, error: null }];
    current.adoptions = [{ ...input, targetTree: frozen, targetTreeHash, completed: false, error: null, writtenNodeIds: [], appliedNodeIds: [] }];
  });
  assert.equal(service.apply(run.id, input).adoptions?.[0]?.completed, true);
  assert.equal(store.readTree().hash, targetTreeHash);
  assert.equal(store.readTree().tree.nodes.find(node => node.id === "knowledge-architecture")?.title, "系统架构");
  assert.equal(store.currentRevisionId("candidate"), revision.id);
  assert.equal(store.readRun(run.id).adoptions?.[0]?.targetTreeHash, targetTreeHash);
});

test("规格确定加载且仅正式版本生效，适用范围独立于证据来源", t => {
  const { root, store } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/style.md"), "# 全局风格\n使用已有组件。", "utf8");
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(),
    { ...asset("global", "knowledge-specifications"), contentMode: "reference", sourceScope: ["docs/style.md"], reference: { path: "docs/style.md", adoptedContentHash: store.readSource("docs/style.md").contentHash } },
    { ...asset("frontend", "knowledge-specifications"), appliesTo: ["apps/web"] },
    { ...asset("draft", "knowledge-specifications"), appliesTo: ["apps/web"] },
  ] }, null);
  store.saveDocument({ nodeId: "frontend", content: "前端使用组件属性控制展示。", origin: "manual", sources: [], expectedHash: null });
  store.saveDocument({ nodeId: "draft", content: "未经采用的规则不能加载。", origin: "ai", sources: [], expectedHash: null, adopt: false });
  const global = store.rules();
  assert.deepEqual(global.rules.map(rule => rule.nodeId), ["global"]);
  assert.deepEqual(global.scoped.map(rule => rule.nodeId), ["frontend"]);
  assert.deepEqual(store.rules(["apps/web/src/a.vue"]).rules.map(rule => rule.nodeId), ["global", "frontend"]);
  assert.deepEqual(store.rules(["apps/server/src/a.ts"]).rules.map(rule => rule.nodeId), ["global"]);
  const prompt = resolveWorkspaceKnowledgeChatContext({ workspacePath: root, engine: "codex" });
  assert.match(prompt.systemRule!, /使用已有组件/);
  assert.doesNotMatch(prompt.systemRule!, /未经采用的规则/);
  assert.ok(prompt.knowledgeAssetTools?.tools.some(tool => tool.toolId === "knowledge.rules.read"));
  assert.equal(executeKnowledgeAssetReadTool(store, "knowledge.rules.read", { paths: ["apps/web"] }).ok, true);
  assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.rules.read", { paths: "bad" }), /数组/);
  fs.unlinkSync(path.join(root, "docs/style.md"));
  assert.throws(() => store.rules(), /ENOENT|不存在/);
  const degraded = resolveWorkspaceKnowledgeChatContext({ workspacePath: root, engine: "codex" });
  assert.equal(degraded.systemRule, null, "规格原文缺失时自动注入降级，普通会话继续");
  assert.equal(degraded.knowledgeAssetTools, undefined);
});

test("规格读取核验正式指针摘要，不能加载外部改写但未经采用的版本", t => {
  const { store } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), asset("rule", "knowledge-specifications")] }, null);
  const revision = store.saveDocument({ nodeId: "rule", content: "已采用约束", origin: "manual", sources: [], expectedHash: null });
  const content = "未经采用的外部改写";
  const revisionRoot = `${store.root}/assets/rule/revisions/${revision.id}`;
  store.files.write(`${revisionRoot}/content.md`, content);
  store.files.write(`${revisionRoot}/revision.json`, knowledgeJson({ ...revision, contentHash: knowledgeHash(content) }));
  assert.throws(() => store.detail("rule"), /版本元数据被外部修改/);
  assert.throws(() => store.rules(), /版本元数据被外部修改/);
});

test("导入按用途归类且原文实时更新，片段定位可回读，删除不能返回旧索引", t => {
  const { root, store } = fixture(t);
  const content = "# 产品介绍\n普通介绍。\n\n## 退款规则\n退款办理需要审核。\n";
  fs.writeFileSync(path.join(root, "docs/product.md"), content, "utf8");
  const imported = store.importFile({ path: "docs/product.md", contentHash: store.readSource("docs/product.md").contentHash, parentId: null, treeHash: null });
  assert.equal(store.category(imported.id), "product");
  assert.equal(store.detail(imported.id).current, null);
  assert.deepEqual(store.revisions(imported.id), []);
  const hit = store.search("退款办理").items[0]!;
  assert.equal(hit.heading, "产品介绍 / 退款规则");
  assert.equal(hit.path, "docs/product.md");
  assert.match(content.split("\n").slice(hit.startLine! - 1, hit.endLine).join("\n"), /退款办理/);
  fs.writeFileSync(path.join(root, "docs/product.md"), "# 产品介绍\n\n## 取消规则\n终止办理需要复核。\n", "utf8");
  assert.equal(store.detail(imported.id).reference?.state, "changed");
  const updated = store.search("终止办理").items[0]!;
  assert.notEqual(updated.contentHash, hit.contentHash);
  assert.doesNotMatch(updated.excerpt, /退款办理/);
  fs.unlinkSync(path.join(root, "docs/product.md"));
  assert.throws(() => store.search("退款办理"), /ENOENT|不存在/);
});

test("导入规格显式保存适用范围，证据路径不决定生效目录", t => {
  const { root, store } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/style.md"), "使用已有组件。", "utf8");
  const input = { path: "docs/style.md", contentHash: store.readSource("docs/style.md").contentHash, parentId: null, treeHash: null };
  const imported = store.importFile({ ...input, category: "specifications", appliesTo: ["src"] });
  assert.deepEqual(imported.appliesTo, ["src"]);
  assert.equal(store.rules().rules.length, 0);
  assert.equal(store.rules(["src/a.ts"]).rules[0]?.nodeId, imported.id);
  assert.equal(store.rules(["docs"]).rules.length, 0);
  assert.throws(() => store.importFile({ ...input, category: "product", appliesTo: ["src"], treeHash: store.readTree().hash }), /只有规格约束/);
});

test("分块保留标题及代码块语义，索引内容均来自原文行段", () => {
  const content = "# A\n说明。\n\n```md\n# 代码中的标题\n```\n\n## B\n其他内容。\n";
  const chunks = splitKnowledgeDocument(content, 30);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.equal(chunk.content, content.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n"));
  assert.equal(chunks.some(chunk => chunk.heading.includes("代码中的标题")), false);
  assert.equal(chunks.at(-1)?.heading, "A / B");
  const singleLine = "长行🙂".repeat(1500);
  const pieces = splitKnowledgeDocument(singleLine);
  assert.equal(pieces.map(piece => piece.content).join(""), singleLine);
  assert.ok(pieces.every(piece => piece.content.length <= 2000 && piece.startLine === 1 && piece.endLine === 1));
});

test("Setext 和 RST 标题保留章节链，代码围栏只由相同字符和足够长度关闭", () => {
  const markdown = "产品说明\n========\n介绍。\n\n退款规则\n--------\n需要复核。\n";
  const chunks = splitKnowledgeDocument(markdown);
  assert.deepEqual(chunks.map(chunk => chunk.heading), ["产品说明", "产品说明 / 退款规则"]);
  const rst = "总览\n****\n介绍。\n\n机制\n====\n说明。\n\n细节\n----\n证据。";
  const sections = splitKnowledgeDocument(rst, 2000, "docs/product.rst");
  assert.deepEqual(sections.map(chunk => chunk.heading), ["总览", "总览 / 机制", "总览 / 机制 / 细节"]);
  for (const chunk of sections) assert.equal(chunk.content, rst.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n"));
  const fenced = "# 正文\n````md\n```\n# 代码标题\n~~~\n代码中的下划线\n---\n````\n\n## 下一章\n真实内容。";
  const codeChunks = splitKnowledgeDocument(fenced, 30);
  assert.ok(codeChunks.every(chunk => !/代码标题|下划线/.test(chunk.heading)));
  assert.equal(codeChunks.at(-1)?.heading, "正文 / 下一章");
});

test("产品拒绝 AI 写入和历史草稿采用，批量冲突不得部分切换正文", t => {
  const { store, db } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), asset("moving"), asset("kept")] }, null);
  const revisions = new Map<string, string>();
  for (const id of ["moving", "kept"]) {
    store.saveDocument({ nodeId: id, content: "人工原文", origin: "manual", sources: [], expectedHash: null });
    revisions.set(id, store.saveDocument({ nodeId: id, content: "旧 AI 草稿", origin: "ai", sources: [], expectedHash: store.currentHash(id), adopt: false }).id);
  }
  const service = new KnowledgeGenerationService(store, "ws", async () => {}, "frozen", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "frozen", mode: "batch", ownerThreadId: "owner", selectedNodeIds: ["moving"], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex" });
  store.saveRun({ ...run, proposedTree: store.readTree().tree });
  const frozen = store.forRun(run.id);
  store.saveTree({ ...store.readTree().tree, nodes: store.readTree().tree.nodes.map(node => node.id === "moving" ? { ...node, parentId: "knowledge-product" } : node) }, store.readTree().hash);
  const hash = store.currentHash("moving"), keptHash = store.currentHash("kept");
  for (const target of [store, frozen]) assert.throws(() => target.saveDocument({ nodeId: "moving", content: "不允许改写", origin: "ai", sources: [], expectedHash: hash, adopt: false }), /产品文档/);
  assert.throws(() => store.adopt("moving", revisions.get("moving")!, hash), /产品文档/);
  assert.throws(() => store.adoptMany(["kept", "moving"]), /产品文档/);
  assert.equal(store.currentHash("moving"), hash);
  assert.equal(store.currentHash("kept"), keptHash);
  assert.equal(store.revisions("moving").length, 2);
  store.saveDocument({ nodeId: "moving", content: "人工更新原文", origin: "manual", sources: [], expectedHash: hash, adopt: true });
  assert.equal(store.detail("moving").current?.content, "人工更新原文");
});

test("产品复检通过不能采用历史 AI 草稿，统一写入边界同样拒绝", async t => {
  const { store, db } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), asset("old")] }, null);
  store.saveDocument({ nodeId: "old", content: "人工产品原文", origin: "manual", sources: [], expectedHash: null });
  const hash = store.currentHash("old");
  const draft = store.saveDocument({ nodeId: "old", content: "历史 AI 草稿", origin: "ai", sources: [], expectedHash: hash, adopt: false });
  store.saveTree({ ...store.readTree().tree, nodes: store.readTree().tree.nodes.map(node => node.id === "old" ? { ...node, parentId: "knowledge-product" } : node) }, store.readTree().hash);
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    assert.equal(input.purpose, "review");
    assert.equal((await input.execute({ toolId: "knowledge.review.read", toolInput: { startLine: 1, count: 500 }, accessMode: "read-only" })).ok, true);
    const source = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/a.ts" }, accessMode: "read-only" });
    assert.equal(source.ok, true);
    const submitted = await input.execute({ toolId: "knowledge.review.submit", toolInput: { outcome: "passed", summary: "已核验", issues: [], sources: [{ kind: "code", path: "src/a.ts", contentHash: (source.output as { contentHash: string }).contentHash, startLine: 1, endLine: 1, relation: "核验依据" }] }, accessMode: "read-only" });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
  }, "review-old-product", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "review-old-product", mode: "review", ownerThreadId: "owner", selectedNodeIds: ["old"], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex" });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.items[0]?.revisionId, draft.id);
  assert.equal(result.items[0]?.review?.status, "passed", JSON.stringify(result));
  const preview = service.preview(run.id);
  assert.equal(preview.items[0]?.canApply, false);
  assert.match(preview.items[0]?.reason ?? "", /产品文档/);
  const input = { requestId: "blocked-adoption", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: "old", revisionId: draft.id }] };
  assert.throws(() => service.apply(run.id, input), /产品文档/);
  assert.throws(() => store.applyRun(run.id, input, () => store.readTree().tree), /产品文档/);
  assert.equal(store.currentHash("old"), hash);
});

test("旧库在同一构建任务中归类，预览前保留原树和人工正文", async t => {
  const { store, db } = fixture(t);
  const old = { ...asset("legacy"), parentId: null };
  const archived = { ...asset("archived"), parentId: null, archived: true, contentMode: "reference" as const, reference: { path: "removed.txt", adoptedContentHash: "a".repeat(64) } };
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [old, asset("child", old.id), archived] }, null);
  store.saveDocument({ nodeId: "legacy", content: "# 人工机制说明", sources: [], origin: "manual", expectedHash: null });
  const originalHash = store.currentHash("legacy");
  store.saveDocument({ nodeId: "child", content: "# 人工子机制", sources: [], origin: "manual", expectedHash: null });
  const childHash = store.currentHash("child");
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    assert.equal(input.purpose, "planning");
    const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/a.ts" }, accessMode: "read-only" });
    assert.equal(read.ok, true);
    const submit = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { nodes: [{ ...old, parentId: "knowledge-architecture" }, { ...archived, parentId: "knowledge-architecture" }], generateNodeIds: [], decisions: [], rationale: "保留人工说明，只归类", gaps: architectureGaps }, accessMode: "read-only" });
    assert.equal(submit.ok, true, JSON.stringify(submit));
  }, "migration", () => ({ nodeId: null, activationVersion: 1 }), db);
  const historical = service.begin({ requestId: "historical", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex" });
  store.saveRun({ ...store.readRun(historical.id), phase: "completed", proposedTree: { ...store.readTree().tree, nodes: [...store.readTree().tree.nodes,
    { ...asset("pending"), parentId: null, contentMode: "reference", reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } }] } });
  const run = service.begin({ requestId: "migration", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(store.readTree().tree.schemaVersion, 2);
  const preview = service.preview(run.id);
  assert.equal(preview.items[0]?.canApply, true, JSON.stringify(preview));
  service.apply(run.id, { requestId: "adopt", treeHash: preview.treeHash, planHash: preview.planHash, selections: preview.items.filter(item => item.canApply).map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });
  assert.deepEqual(store.readTree().tree.nodes.filter(node => node.parentId === null).map(node => node.title), ["规格约束", "系统架构", "产品文档"]);
  assert.equal(store.node("legacy").parentId, "knowledge-architecture");
  assert.equal(store.currentHash("legacy"), originalHash);
  assert.equal(store.currentHash("child"), childHash);
  assert.equal(store.node("archived").archived, true);
  assert.equal(store.node("archived").parentId, "knowledge-architecture");
  const expired = service.preview(historical.id);
  assert.equal(expired.items.find(item => item.nodeId === "pending")?.canApply, false);
  assert.match(expired.items.find(item => item.nodeId === "pending")!.reason!, /旧结构候选已失效/);
  await service.dismiss(historical.id, "pending", null, "owner", expired.planHash);
  assert.equal(service.preview(historical.id).items.find(item => item.nodeId === "pending")?.dismissed, true);
});

test("产品文档不进入自动生成清单，旧库导入要求先显式归类", t => {
  const { store, root, db } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/a.md"), "# 文档", "utf8");
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ ...asset("old"), parentId: null }] }, null);
  assert.throws(() => store.importFile({ path: "docs/a.md", contentHash: store.readSource("docs/a.md").contentHash, parentId: null, treeHash: store.readTree().hash }), /先一键生成/);
  const tree = store.readTree();
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), asset("old"), asset("product", "knowledge-product")] }, tree.hash);
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw new Error("不得生成"); }, "req", () => ({ nodeId: null, activationVersion: 1 }), db);
  assert.throws(() => service.begin({ requestId: "product", mode: "batch", ownerThreadId: "owner", selectedNodeIds: ["knowledge-product"], includeDescendants: true, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex" }), /没有待生成/);
});

test("先导入产品资料后，全项目一键生成仍筛选规格和架构缺口", async t => {
  const { store, root, db } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/product.md"), "产品原始说明。", "utf8");
  const product = store.importFile({ path: "docs/product.md", contentHash: store.readSource("docs/product.md").contentHash, parentId: null, treeHash: null });
  let plans = 0;
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    assert.equal(input.purpose, "planning"); plans++;
    const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/a.ts" }, accessMode: "read-only" });
    assert.equal(read.ok, true);
    const result = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { nodes: [], generateNodeIds: [], decisions: [], rationale: "筛选后无需补充知识", gaps: architectureGaps }, accessMode: "read-only" });
    assert.equal(result.ok, true, JSON.stringify(result));
  }, "import-then-build", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "import-then-build", mode: "build", ownerThreadId: "owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(plans, 1);
  assert.equal(store.category(product.id), "product");
  assert.equal(store.revisions(product.id).length, 0);
});

test("旧任务归类为产品文档后继续生成须失败，不能启动模型或写入新版本", async t => {
  const { store, db } = fixture(t);
  const old = { ...asset("legacy"), parentId: null };
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [old] }, null);
  store.saveDocument({ nodeId: old.id, content: "原始产品内容", sources: [], origin: "manual", expectedHash: null });
  let calls = 0;
  const service = new KnowledgeGenerationService(store, "ws", async () => { calls++; }, "old-product", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "old-product", mode: "batch", ownerThreadId: "owner", selectedNodeIds: [old.id], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...old, parentId: "knowledge-product" }] }, store.readTree().hash);
  const hash = store.currentHash(old.id);
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.notEqual(result.phase, "completed");
  assert.equal(result.items[0]?.status, "failed");
  assert.match(result.items[0]?.error?.message ?? result.error?.message ?? "", /产品文档/);
  assert.equal(calls, 0);
  assert.equal(store.currentHash(old.id), hash);
  assert.equal(store.revisions(old.id).length, 1);
});

test("产品历史正文复检只报告问题，即使请求自动修订也不生成正文", async t => {
  const { store, db } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), asset("product", "knowledge-product")] }, null);
  store.saveDocument({ nodeId: "product", content: "# 产品原始内容", sources: [], origin: "manual", expectedHash: null });
  const calls: string[] = [];
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    calls.push(input.purpose ?? "generation");
    assert.equal(input.purpose, "review");
    const read = await input.execute({ toolId: "knowledge.review.read", toolInput: { startLine: 1, count: 500 }, accessMode: "read-only" });
    assert.equal(read.ok, true, JSON.stringify(read));
    const source = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/a.ts" }, accessMode: "read-only" });
    assert.equal(source.ok, true);
    const evidence = { kind: "code", path: "src/a.ts", contentHash: (source.output as { contentHash: string }).contentHash, startLine: 1, endLine: 1, relation: "核对实现" };
    const submit = await input.execute({ toolId: "knowledge.review.submit", toolInput: { outcome: "issues", summary: "原始资料需要更新", sources: [evidence], issues: [{ id: "outdated", severity: "error", category: "factual", title: "资料待更新", detail: "请核对原始资料", documentStartLine: 1, documentEndLine: 1, sources: [evidence], suggestion: "修改原始文档" }] }, accessMode: "read-only" });
    assert.equal(submit.ok, true, JSON.stringify(submit));
  }, "review-product", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "review-product", mode: "review", ownerThreadId: "owner", selectedNodeIds: ["product"], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: true, autoRepair: true, model: null, effort: null } });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.items[0]?.review?.status, "issues", JSON.stringify(result));
  assert.equal(result.items[0]?.reviewConfig?.autoRepair, false);
  assert.deepEqual(calls, ["review"]);
  assert.equal(store.revisions("product").length, 1);
});
