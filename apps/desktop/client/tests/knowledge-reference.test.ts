import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeAssetStore, parseKnowledgeAssetTree } from "../src/knowledge/knowledgeAssetStore.js";
import { knowledgeHash } from "../src/knowledge/knowledgeAssetFiles.js";
import { executeKnowledgeAssetReadTool } from "../src/knowledge/knowledgeAssetTools.js";
import { openClientDb } from "../src/db/clientDb.js";
import { createKnowledgeConversation, createKnowledgeConversationTurn } from "../src/knowledge/knowledgeConversationService.js";
import type { KnowledgeAssetDetail, WorkspaceId } from "@codeflowai/shared";

/** 独立项目验证实时引用；所有写入只发生在测试临时目录。 */
function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "README.md"), "# 导航\n初始引用内容", "utf8");
  const store = new KnowledgeAssetStore(root);
  const node = { id: "readme", parentId: null, title: "原文", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: ["README.md"], contentMode: "reference" as const, reference: { path: "README.md", adoptedContentHash: knowledgeHash(fs.readFileSync(path.join(root, "README.md"))) } };
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node] }, null);
  return { root, store, node };
}

test("引用实时回读原文，状态与检索更新且不产生正文修订", t => {
  const { root, store, node } = project(t);
  const adopted = store.readTree().hash;
  assert.equal(store.detail(node.id).reference?.state, "unchanged");
  assert.equal(store.search("初始引用内容").items[0]?.nodeId, node.id);
  fs.writeFileSync(path.join(root, "README.md"), "# 导航\n变更后的新机制", "utf8");
  const detail = store.detail(node.id);
  assert.equal(detail.reference?.state, "changed");
  assert.match(detail.reference!.content, /新机制/);
  assert.equal(detail.node.reference?.adoptedContentHash, node.reference.adoptedContentHash);
  assert.equal(store.readTree().hash, adopted);
  assert.equal(store.search("新机制").items[0]?.contentHash, detail.reference?.contentHash);
  assert.equal(store.snapshot().states[0]?.draftCount, 0);
  assert.deepEqual(store.revisions(node.id), []);
  assert.equal(fs.existsSync(path.join(root, store.root, "assets")), false);
  const tool = executeKnowledgeAssetReadTool(store, "knowledge.node.read", { nodeId: node.id });
  assert.equal((tool.output as typeof detail).reference?.content, detail.reference?.content);
});

test("候选来源不限制项目原文引用，丢失、越界和敏感路径仍显式失败", t => {
  const { root, store, node } = project(t);
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [{ ...node, sourceScope: ["src"] }] };
  assert.match(store.readReference(node.id, tree).content, /初始引用内容/);
  for (const path of ["../outside.md", ".env"]) {
    assert.throws(() => store.readReference(node.id, { ...tree, nodes: [{ ...node, reference: { ...node.reference, path } }] }), { code: "KNOWLEDGE_ASSET_PATH_INVALID" });
  }
  store.search("初始");
  fs.unlinkSync(path.join(root, "README.md"));
  assert.throws(() => store.detail(node.id), /ENOENT/);
  assert.throws(() => store.search("初始"), /ENOENT/);
  assert.throws(() => store.readReference(node.id, tree), /ENOENT/);
});

test("原文引用的链接改指向敏感目录后显式失败，不返回旧内容", t => {
  const { root, store, node } = project(t);
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# 正常原文", "utf8");
  const alias = path.join(root, "rules-link");
  fs.symlinkSync(path.join(root, "docs"), alias, process.platform === "win32" ? "junction" : "dir");
  const sourcePath = "rules-link/guide.md";
  const read = store.readSource(sourcePath);
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [{ ...node, sourceScope: [], reference: { path: sourcePath, adoptedContentHash: read.contentHash } }] }, store.readTree().hash);
  assert.match(store.detail(node.id).reference!.content, /正常原文/);
  store.search("正常原文");
  fs.mkdirSync(path.join(root, ".aws"));
  fs.writeFileSync(path.join(root, ".aws/guide.md"), "测试占位内容，不是真实凭据。", "utf8");
  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(root, ".aws"), alias, process.platform === "win32" ? "junction" : "dir");
  for (const read of [() => store.detail(node.id), () => store.search("正常原文"), () => executeKnowledgeAssetReadTool(store, "knowledge.node.read", { nodeId: node.id })]) {
    assert.throws(read, { code: "KNOWLEDGE_ASSET_PATH_INVALID" });
  }
});

test("局部检索不读取范围外引用，全库与目录切换均重建正确范围", t => {
  const { root, store, node } = project(t);
  fs.writeFileSync(path.join(root, "second.md"), "# 另一份引用内容", "utf8");
  const firstDirectory = { ...node, id: "first", title: "第一目录", contentMode: "directory" as const, reference: undefined, sourceScope: [] };
  const secondDirectory = { ...firstDirectory, id: "second", title: "第二目录" };
  const other = { ...node, id: "other", title: "另一原文", parentId: secondDirectory.id, sourceScope: ["second.md"], reference: { path: "second.md", adoptedContentHash: knowledgeHash(fs.readFileSync(path.join(root, "second.md"))) } };
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [firstDirectory, { ...node, parentId: firstDirectory.id }, secondDirectory, other] }, store.readTree().hash);

  assert.deepEqual(store.search("引用内容").items.map(hit => hit.nodeId).sort(), ["other", "readme"]);
  assert.deepEqual(store.search("引用内容", firstDirectory.id).items.map(hit => hit.nodeId), ["readme"]);
  assert.deepEqual(store.search("引用内容", secondDirectory.id).items.map(hit => hit.nodeId), ["other"]);
  assert.deepEqual(store.search("引用内容").items.map(hit => hit.nodeId).sort(), ["other", "readme"]);

  fs.unlinkSync(path.join(root, "second.md"));
  assert.deepEqual(store.search("引用内容", firstDirectory.id).items.map(hit => hit.nodeId), ["readme"]);
  assert.throws(() => store.search("引用内容"), /ENOENT/);
  assert.throws(() => store.search("引用内容", secondDirectory.id), /ENOENT/);
  assert.deepEqual(store.search("引用内容", firstDirectory.id).items.map(hit => hit.nodeId), ["readme"]);

  fs.writeFileSync(path.join(root, "second.md"), "# 恢复后的引用内容", "utf8");
  assert.deepEqual(store.search("引用内容").items.map(hit => hit.nodeId).sort(), ["other", "readme"]);
  assert.match(store.search("引用内容", secondDirectory.id).items[0]!.excerpt, /恢复后/);
});

test("采用前引用漂移失败，新格式不允许旧协议保存丢失字段", t => {
  const { root, store, node } = project(t);
  assert.equal(store.files.json<{ schemaVersion: number }>(`${store.root}/knowledge.json`).schemaVersion, 2);
  assert.throws(() => store.saveTree({ schemaVersion: 1, instructions: "", nodes: [] }, store.readTree().hash), /旧文件协议/);
  assert.throws(() => parseKnowledgeAssetTree({ schemaVersion: 1, instructions: "", nodes: [node] }), /版本 2/);
  fs.writeFileSync(path.join(root, "second.md"), "new", "utf8");
  assert.throws(() => store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node, { ...node, id: "second", sourceScope: [], reference: { path: "second.md", adoptedContentHash: node.reference.adoptedContentHash } }] }, store.readTree().hash), /引用已变化/);
  assert.equal(store.snapshot().tree.nodes.length, 1);
});

test("目录和引用均不能被正文保存接口补齐", t => {
  const { store, node } = project(t);
  assert.throws(() => store.saveDocument({ nodeId: node.id, content: "wrong", sources: [], expectedHash: null, origin: "ai" }), /不保存生成正文/);
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node, { ...node, id: "directory", contentMode: "directory", reference: undefined }] }, store.readTree().hash);
  assert.equal(store.detail("directory").current, null);
  assert.throws(() => store.saveDocument({ nodeId: "directory", content: "wrong", sources: [], expectedHash: null, origin: "ai" }), /不保存生成正文/);
  for (const contentMode of [["directory"], { toString: () => "directory" }]) assert.throws(() => parseKnowledgeAssetTree({ schemaVersion: 2, instructions: "", nodes: [{ ...node, contentMode }] }), /内容用途无效/);
});

test("引用失效不阻断无关正文保存，派生索引不在正式树写入后引入失败", t => {
  const { root, store, node } = project(t);
  const generated = { ...node, id: "generated", contentMode: "generated" as const, reference: undefined, sourceScope: [] };
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node, generated] }, store.readTree().hash);
  fs.unlinkSync(path.join(root, "README.md"));
  assert.doesNotThrow(() => store.saveDocument({ nodeId: generated.id, content: "正文", sources: [], expectedHash: null, origin: "manual" }));
  assert.throws(() => store.saveTree({ ...store.readTree().tree, instructions: "不能保存" }, store.readTree().hash), /不存在|ENOENT/);
  assert.equal(store.readTree().tree.instructions, "");
});

test("同一真实知识会话重复读取和检索均回读引用，删除后显式失败", t => {
  const { root, store, node } = project(t);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  try {
    const actor = { userId: "owner", accountRole: "personal_normal" as const, enterpriseId: null, requestId: "live-reference", permissionScope: "account" as const };
    const workspaceId = "ws" as WorkspaceId;
    db.workspaces.upsert({ id: workspaceId, title: "引用测试", path: root });
    const identity = { db, store, workspaceId, actor };
    const owner = createKnowledgeConversation({ ...identity, nodeId: null, engine: "codex" });
    const turn = createKnowledgeConversationTurn({ ...identity, threadId: owner.threadId, turnId: "live-turn", engine: "codex", model: null, effort: null, prompt: "读取引用", trustedActor: actor, isActive: () => true })!;
    assert.match((turn.execute("knowledge.node.read", { nodeId: node.id }).output as KnowledgeAssetDetail).reference!.content, /初始/);
    turn.execute("knowledge.search", { query: "引用" });
    fs.writeFileSync(path.join(root, "README.md"), "引用更新后的正文", "utf8");
    assert.match((turn.execute("knowledge.node.read", { nodeId: node.id }).output as KnowledgeAssetDetail).reference!.content, /更新后/);
    const results = turn.execute("knowledge.search", { query: "引用" }).output as { items: Array<{ excerpt: string }> };
    assert.match(results.items[0]!.excerpt, /更新后/);
    fs.unlinkSync(path.join(root, "README.md"));
    assert.throws(() => turn.execute("knowledge.node.read", { nodeId: node.id }), /ENOENT/);
    assert.throws(() => turn.execute("knowledge.search", { query: "引用" }), /ENOENT/);
    turn.finish();
  } finally { db.close(); }
});
