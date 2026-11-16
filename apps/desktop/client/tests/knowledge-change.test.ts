import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationEventInput } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeChangeStore } from "../src/knowledge/knowledgeChangeStore.js";
import { createKnowledgeSuggestionTurn } from "../src/knowledge/knowledgeChangeTools.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";

function project(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-change-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "source.ts"), "export const retries = 3;\n");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "retry", title: "重试策略", parentId: null, orderKey: "1", instructions: "", summary: "", tags: [], sourceScope: [] }] }, null);
  store.saveDocument({ nodeId: "retry", content: "# 重试\n重试 2 次。", expectedHash: null, origin: "manual", sources: [] });
  const sources = [{ kind: "code", path: "source.ts", contentHash: store.readSource("source.ts").contentHash, relation: "重试次数定义" }];
  return { root, store, changes: new KnowledgeChangeStore(store), proposal: { nodeId: "retry", expectedHash: store.currentHash("retry"), summary: "依据源码将 2 次改为 3 次", content: "# 重试\n重试 3 次。", sources } };
}
test("普通会话立即保存修改建议并提示审核入口，无审批阻塞事件，跨 Client 可读取", t => {
  const { root, store, proposal } = project(t);
  const events: ConversationEventInput[] = [];
  let active = true;
  const turn = createKnowledgeSuggestionTurn({ store, workspaceId: "ws-test", threadId: "chat-test", turnId: "turn-test", engine: "codex", origin: "chat", canPropose: true, isActive: () => active, emit: e => events.push(e) });
  const result = turn.execute("knowledge.change.propose", proposal);
  assert.equal(result.ok, true);
  const other = new KnowledgeChangeStore(new KnowledgeAssetStore(root));
  assert.equal(other.list().items.length, 1);
  assert.equal(other.list().items[0]?.status, "pending");
  assert.equal(store.detail("retry").current?.content, "# 重试\n重试 2 次。");
  assert.equal(store.detail("retry").drafts.length, 0);
  assert.deepEqual(events.map(e => e.type), ["item.agentMessage.completed"]);
  assert.match(JSON.stringify(events), /规格知识库 → 待确认更新.*view=approvals/);
  turn.execute("knowledge.change.propose", { ...proposal, content: "# 重试\n最多重试 3 次。" });
  assert.equal(other.list().items.length, 1);
  active = false;
  assert.throws(() => turn.execute("knowledge.change.propose", proposal), /回合已停止/);
});
test("人工批准切换正式版本，拒绝保持原文，重复审核与并发覆盖被拒绝", t => {
  const { store, changes, proposal } = project(t);
  const a = changes.submit(proposal, { threadId: "chat", turnId: "a", origin: "chat" });
  const b = changes.submit(proposal, { threadId: "workflow", turnId: "b", origin: "workflow" });
  const rejected = changes.review({ id: a.id, expectedHash: a.hash, decision: "reject", note: "不采用", userId: "reviewer" });
  assert.equal(rejected.status, "rejected");
  assert.equal(store.currentHash("retry"), proposal.expectedHash);
  assert.throws(() => changes.review({ id: b.id, expectedHash: b.hash, decision: "approve", note: "x".repeat(4001), userId: "reviewer" }), /文本为空、过长或格式无效/);
  assert.equal(store.currentHash("retry"), proposal.expectedHash);
  assert.equal(changes.detail(b.id).status, "pending");
  const approved = changes.review({ id: b.id, expectedHash: b.hash, decision: "approve", note: "已核对源码", userId: "reviewer" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "reviewer");
  assert.equal(store.detail("retry").current?.content, proposal.content);
  assert.throws(() => changes.review({ id: b.id, expectedHash: b.hash, decision: "approve", note: "", userId: "reviewer" }), /已变化或已被审核/);
});

test("人工批准的规格提案可追溯要求并复检，不把提案 ID 当生成任务", t => {
  const { store, changes, proposal } = project(t);
  const requirement = "发布前必须人工确认适用范围。";
  const evidence = { kind: "requirement" as const, requirement, relation: "人工批准的项目要求" };
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...store.node("retry"), parentId: "knowledge-specifications" }] }, store.readTree().hash);
  const pending = changes.submit({ ...proposal, content: `# 发布约束\n${requirement}`, sources: [evidence] }, { threadId: "chat", turnId: "specification", origin: "chat" });
  const approved = changes.review({ id: pending.id, expectedHash: pending.hash, decision: "approve", note: "确认保存为项目约束", userId: "reviewer" });
  assert.equal(approved.status, "approved");
  assert.equal(store.detail("retry").current?.revision.runId, approved.id);
  const reviews = new KnowledgeReviewStore(store), snapshot = reviews.snapshot("retry", approved.revisionId!);
  assert.equal(reviews.requirementEvidence(snapshot, evidence).requirement, requirement);
  const report = reviews.save(snapshot, { runId: "run_spec_review", engine: "codex", model: null, effort: null, outcome: "passed", summary: "已核对人工批准的要求", issues: [], sources: [evidence] });
  assert.equal(reviews.list("retry").find(item => item.id === report.id)?.stale, false);
});
test("来源或正式版本漂移后不能批准；修改建议更改后旧预览不能审核", t => {
  const { root, store, changes, proposal } = project(t);
  const input = { threadId: "chat", turnId: "a", origin: "chat" as const };
  const first = changes.submit(proposal, input);
  const updated = changes.submit({ ...proposal, summary: "更新理由" }, input);
  assert.throws(() => changes.review({ id: first.id, expectedHash: first.hash, decision: "approve", note: "", userId: "u" }), /已变化/);
  fs.writeFileSync(path.join(root, "source.ts"), "export const retries = 4;");
  assert.equal(changes.detail(updated.id).stale, true);
  assert.throws(() => changes.review({ id: updated.id, expectedHash: updated.hash, decision: "approve", note: "", userId: "u" }), /重新核对/);
  assert.equal(store.currentHash("retry"), proposal.expectedHash);
});

test("产品分类拒绝新修改建议，旧建议不能批准但可拒绝清理", t => {
  const { store, changes, proposal } = project(t);
  const pending = changes.submit(proposal, { threadId: "chat", turnId: "before-move", origin: "chat" });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...store.node("retry"), parentId: "knowledge-product" }] }, store.readTree().hash);
  const hash = store.currentHash("retry");
  for (const origin of ["chat", "workflow"] as const) {
    assert.throws(() => changes.submit(proposal, { threadId: origin, turnId: "after-move", origin }), /产品文档/);
  }
  const stale = changes.detail(pending.id);
  assert.equal(stale.stale, true);
  assert.match(stale.staleReasons.join("；"), /产品文档/);
  assert.throws(() => changes.review({ id: pending.id, expectedHash: stale.hash, decision: "approve", note: "", userId: "reviewer" }), /产品文档/);
  assert.equal(store.currentHash("retry"), hash);
  assert.equal(store.revisions("retry").length, 1);
  assert.equal(changes.review({ id: pending.id, expectedHash: stale.hash, decision: "reject", note: "保留原文", userId: "reviewer" }).status, "rejected");
});
test("缺少可信身份不能提交，首份文档的建议也不能提前成为正式知识", t => {
  const { store, changes } = project(t);
  store.saveTree({ ...store.readTree().tree, nodes: [...store.readTree().tree.nodes, { id: "empty", title: "新资产", parentId: null, orderKey: "2", summary: "", tags: [], instructions: "", sourceScope: [] }] }, store.readTree().hash);
  const input = { nodeId: "empty", expectedHash: null, content: "# 新说明", summary: "补齐空白", sources: [{ kind: "requirement", requirement: "已确认需求", relation: "需求依据" }] };
  const turn = createKnowledgeSuggestionTurn({ store, workspaceId: "ws", threadId: "t", turnId: "turn", engine: "codex", origin: "chat", canPropose: false, isActive: () => true, emit: () => {} });
  assert.throws(() => turn.execute("knowledge.change.propose", input), /可信身份/);
  const result = changes.submit(input, { threadId: "t", turnId: "turn", origin: "workflow" });
  assert.equal(result.status, "pending");
  assert.equal(store.detail("empty").current, null);
});

test("审批树索引覆盖分页后的全部待审批资产，目录筛选包含后代且不读取正文", t => {
  const { store, changes, proposal } = project(t);
  store.saveTree({ ...store.readTree().tree, nodes: [...store.readTree().tree.nodes,
    { id: "child", parentId: "retry", title: "子资产", orderKey: "1", instructions: "", summary: "", tags: [], sourceScope: [] },
    { id: "other", parentId: null, title: "其他资产", orderKey: "2", instructions: "", summary: "", tags: [], sourceScope: [] },
  ] }, store.readTree().hash);
  changes.submit(proposal, { threadId: "t", turnId: "turn", origin: "chat" });
  const summary = changes.list().items[0]!;
  for (let i = 0; i < 52; i++) {
    const id = `indexed_${i}`, nodeId = i === 51 ? "other" : "child";
    store.files.write(`${store.root}/changes/${id}/summary.json`, JSON.stringify({ ...summary, id, nodeId, title: nodeId }));
  }
  store.files.write(`${store.root}/changes/rejected/summary.json`, JSON.stringify({ ...summary, id: "rejected", nodeId: "other", status: "rejected" }));
  const first = changes.list(0, { nodeId: "retry", status: "pending" });
  assert.equal(first.items.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(changes.list(50, { nodeId: "retry", status: "pending" }).items.length, 2);
  assert.deepEqual(new Map(first.pendingNodes.map(node => [node.nodeId, node.count])), new Map([["retry", 1], ["child", 51], ["other", 1]]));
  assert.deepEqual(changes.list(0, { nodeId: "other", status: "rejected" }).items.map(item => item.id), ["rejected"]);
  assert.throws(() => changes.list(0, { status: "invalid" }), /审批状态无效/);
});
