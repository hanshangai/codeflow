import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { KnowledgeAssetNode, KnowledgeAssetActorContext, KnowledgeAssetSource, WorkspaceId, ThreadId } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import { KNOWLEDGE_SPECIFICATION_POLICY } from "../src/knowledge/knowledgeAssetTools.js";
import { createKnowledgeConversation, connectKnowledgeConversation, endKnowledgeConversation, requireKnowledgeConversationOwner, createKnowledgeConversationTurn, settleKnowledgeConversationEvent } from "../src/knowledge/knowledgeConversationService.js";

import { openClientDb } from "../src/db/clientDb.js";
import { resolveClaudePermissionLaunchMode } from "../src/engines/claude/claudeCli.js";
import { resolveClaudeControlMode } from "../src/engines/claude/claudeApproval.js";

const cleanups: Array<() => void> = [];
after(() => { for (const cleanup of cleanups) cleanup(); });

const actor: KnowledgeAssetActorContext = { userId: "owner", accountRole: "personal_normal", enterpriseId: null, requestId: "req", permissionScope: "account" };
const node = (id: string, title = id, parentId: string | null = "knowledge-architecture"): KnowledgeAssetNode => ({ id, parentId, title, orderKey: id, summary: "", tags: [], instructions: "", sourceScope: [] });
function fixture(nodeId: string | null = null, shared = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-conversation-"));
  const store = new KnowledgeAssetStore(root);
  const saveTree = store.saveTree.bind(store);
  store.saveTree = (value, expectedHash) => {
    const tree = value as { nodes: KnowledgeAssetNode[] };
    return saveTree({ ...tree, schemaVersion: 3, nodes: [...new Map([...knowledgeCategoryNodes(), ...tree.nodes].map(node => [node.id, node])).values()] }, expectedHash);
  };
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: "ws" as WorkspaceId, title: "知识测试", path: root });
  if (nodeId) store.saveTree({ schemaVersion: 1, instructions: "", nodes: [node("a"), node("b")] }, null);
  const base = { db, store, workspaceId: "ws", actor: shared ? { ...actor, permissionScope: "shared_asset_admin" as const } : actor, sharedWorkspaceId: shared ? "shared" : null };
  const conversation = createKnowledgeConversation({ ...base, nodeId, engine: "codex" });
  const identity = { ...base, threadId: conversation.threadId };
  let active = true;
  const turn = (turnId: string) => createKnowledgeConversationTurn({ ...identity, turnId, engine: "codex", model: null, effort: null, prompt: "用户要求", isActive: () => active, trustedActor: identity.actor, sharedContext: shared ? { sharedWorkspaceId: "shared", operationId: "op", operationKey: "ai.thread.send.shared", toolPolicyKey: "ai.shared.write" } : null })!;
  return { store, identity, turn, stop: () => { active = false; }, service: new KnowledgeGenerationService(store, "ws", async () => { throw new Error("不得启动新会话"); }, "req", threadId => requireKnowledgeConversationOwner({ ...identity, threadId }), db) };
}

test("会话提取的规格只保存待采用版本，明确采用后才成为项目规则", () => {
  const { store, turn } = fixture();
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), node("rule", "编码要求", "knowledge-specifications")] }, null);
  const current = turn("capture-rule");
  assert.equal(resolveClaudePermissionLaunchMode({ planMode: false, accessMode: "read-only", conversationProfile: current.conversationProfile }).permissionMode, "default");
  assert.equal(resolveClaudePermissionLaunchMode({ planMode: true, accessMode: "read-only", conversationProfile: current.conversationProfile }).permissionMode, "plan");
  assert.ok(current.instructions.includes(KNOWLEDGE_SPECIFICATION_POLICY), "交互提取与后台生成使用相同的规格策略");
  const incomplete = { content: "未指定节点", summary: "不能隐式保存", sources: [{ kind: "requirement", requirement: "用户明确要求长期保存", relation: "本轮确认" }] };
  assert.throws(() => current.execute("knowledge.asset.submit", incomplete), /知识标识无效/);
  assert.throws(() => current.execute("knowledge.asset.submit", { ...incomplete, nodeId: "rule" }), /文本/);
  assert.equal(store.revisions("rule").length, 0);
  const result = current.execute("knowledge.asset.submit", { nodeId: "rule", expectedHash: null, content: "只保留必要知识。", summary: "长期要求", sources: [{ kind: "requirement", requirement: "用户明确要求长期保存", relation: "本轮确认" }] });
  assert.equal((result.output as { adopted: boolean }).adopted, false);
  current.finish();
  assert.equal(store.rules().rules.length, 0);
  const revision = store.detail("rule").drafts[0]!;
  store.adopt("rule", revision.id, null);
  assert.equal(store.rules().rules[0]?.content, "只保留必要知识。");
});

test("空库会话不能提交任意一级目录，产品资料不能由 AI 重写", () => {
  const { store, turn } = fixture();
  const planning = turn("category-boundary");
  assert.throws(() => planning.execute("knowledge.plan.submit", { nodes: [node("extra", "任意根", null)], rationale: "越过分类", gaps: [] }), /一级目录固定/);
  planning.finish();
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), node("product", "产品资料", "knowledge-product")] }, null);
  const document = turn("product-boundary");
  assert.throws(() => document.execute("knowledge.asset.submit", { nodeId: "product", expectedHash: null, content: "模型重写的产品资料", sources: [] }), /产品文档/);
  document.finish();
  assert.equal(store.revisions("product").length, 0);
});

test("同一会话连续调整目录计划，采用前不改变树；采用后文档有来源和可审阅版本", () => {
  const { store, turn, service } = fixture();
  const first = turn("turn-1");
  first.execute("knowledge.plan.submit", { nodes: [node("feature", "功能")], projectInstructions: "说明字段级规则", rationale: "第一版", gaps: [] });
  assert.equal(store.readTree().hash, null);
  first.finish();
  const followup = turn("turn-2");
  const previous = followup.execute("knowledge.plan.read", {});
  assert.equal((previous.output as { nodes: KnowledgeAssetNode[] }).nodes.find(node => node.id === "feature")?.title, "功能");
  assert.equal((previous.output as { projectInstructions: string }).projectInstructions, "说明字段级规则");
  followup.execute("knowledge.plan.submit", { nodes: [node("feature", "按钮行为")], rationale: "根据追加要求细化", gaps: [] });
  assert.equal((followup.execute("knowledge.plan.read", {}).output as { nodes: KnowledgeAssetNode[] }).nodes.find(node => node.id === "feature")?.title, "按钮行为");
  const plan = store.listRuns().find(r => r.rationale === "根据追加要求细化")!;
  assert.throws(() => service.apply(plan.id), /仍在执行/);
  followup.finish();
  service.apply(plan.id);
  assert.equal(store.node("feature").title, "按钮行为");
  assert.equal(store.readTree().tree.instructions, "说明字段级规则");
  const doc = turn("turn-3");
  assert.equal((doc.execute("knowledge.plan.read", {}).output as { runId: string | null }).runId, null);
  const payload = { nodeId: "feature", expectedHash: null, content: "# 按钮行为\n具体规则", summary: "按钮规则", sources: [{ kind: "requirement", requirement: "说明按钮", relation: "本轮要求" }] };
  doc.execute("knowledge.asset.submit", payload);
  doc.finish();
  const currentHash = store.currentHash("feature");
  assert.ok(currentHash);
  const adjust = turn("turn-4");
  assert.throws(() => adjust.execute("knowledge.asset.submit", payload), /正文已变化/);
  adjust.execute("knowledge.asset.submit", { ...payload, expectedHash: currentHash, content: "# 按钮行为\n补充禁用条件" });
  adjust.finish();
  assert.equal(store.detail("feature").current?.content, payload.content);
  assert.equal(store.detail("feature").drafts.length, 1);
  assert.ok(store.listRuns().every(r => r.ownerThreadId && r.threadId === r.ownerThreadId));
});

test("停止拒绝迟到写入，已提交资产保留，同会话无需重新创建任务才能对话", () => {
  const { store, identity, turn, stop } = fixture();
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [node("a"), node("b")] }, null);
  const task = turn("stop-turn");
  const payload = { nodeId: "a", expectedHash: null, content: "已完成", summary: "", sources: [{ kind: "requirement", requirement: "用户要求", relation: "目标" }] };
  task.execute("knowledge.asset.submit", payload);
  stop();
  assert.throws(() => task.execute("knowledge.asset.submit", { ...payload, nodeId: "b" }), /已停止/);
  task.finish(undefined, true);
  assert.equal(store.detail("a").current?.content, "已完成");
  assert.equal(store.detail("b").current, null);
  assert.equal(store.listRuns()[0]?.phase, "interrupted");
  endKnowledgeConversation(identity);
});

test("知识范围持久固定，结束后迟到提交和后续发送均被拒绝，重新进入保留原范围", () => {
  const { store, identity, turn } = fixture("a");
  const scoped = turn("scope-turn");
  assert.throws(() => scoped.execute("knowledge.plan.submit", { nodes: [node("b", "越界")], rationale: "不能改", gaps: [] }), /当前知识范围/);
  endKnowledgeConversation(identity);
  assert.throws(() => scoped.execute("knowledge.source.list", {}), /已停止/);
  scoped.finish(undefined, true);
  assert.throws(() => turn("ended"), /知识协作已结束/);
  assert.equal(connectKnowledgeConversation(identity).nodeId, "a");
  assert.equal(requireKnowledgeConversationOwner(identity).nodeId, "a");
  assert.throws(() => scoped.execute("knowledge.source.list", {}), /已停止/);
  assert.equal(store.node("b").title, "b");
});

test("专题目录被删除仍能结束协作，结束后迟到工具被撤权", () => {
  const { store, identity, turn } = fixture("a");
  const current = turn("deleted-scope");
  const initial = store.readTree();
  // 模拟切换项目文件版本后，原专题节点已不在当前资产树中。
  store.files.write(`${store.root}/tree.json`, JSON.stringify({ ...initial.tree, nodes: initial.tree.nodes.filter(n => n.id !== "a") }));
  assert.equal(requireKnowledgeConversationOwner(identity).nodeId, "a");
  assert.equal(endKnowledgeConversation(identity).active, false);
  assert.throws(() => current.execute("knowledge.source.list", {}), /已停止/);
  current.finish(undefined, true);
});

test("每回合重新检查共享维护身份，专属会话不能被其他成员借用", () => {
  const { identity } = fixture(null, true);
  const input = { ...identity, turnId: "shared", engine: "codex" as const, model: null, effort: null, prompt: "规划", isActive: () => true,
    sharedContext: { sharedWorkspaceId: "shared", operationId: "op", operationKey: "ai.thread.send.shared" as const, toolPolicyKey: "ai.shared.write" as const } };
  assert.throws(() => createKnowledgeConversationTurn({ ...input, trustedActor: { userId: "member", permissionScope: "shared_member" } }), /不能维护/);
  assert.throws(() => createKnowledgeConversationTurn({ ...input, trustedActor: { userId: "owner", permissionScope: "shared_member" } }), /不能维护/);
  assert.throws(() => createKnowledgeConversationTurn({ ...input, trustedActor: { userId: "other-admin", permissionScope: "shared_asset_admin" } }), /请选择/);
  assert.throws(() => createKnowledgeConversationTurn({ ...input, sharedContext: null, trustedActor: identity.actor }), /请选择/);
  const allowed = createKnowledgeConversationTurn({ ...input, trustedActor: identity.actor });
  assert.ok(allowed);
  allowed.finish();
});

test("普通问答没有强制提交，结束后不显示虚假产物或启动后台线程", () => {
  const { store, turn } = fixture();
  const discussion = turn("question-turn");
  discussion.finish();
  const run = store.listRuns()[0]!;
  assert.equal(run.phase, "completed");
  assert.equal(run.items.length, 0);
  assert.equal(run.proposedTree, null);
  assert.equal(store.readTree().hash, null);
  assert.match(run.rationale, /交流/);
});

test("资产工作会话和复检会话可以继续交互，资产工作会话能提交修订版本", () => {
  const { store, identity } = fixture();
  fs.writeFileSync(path.join(store.files.root, "AGENTS.md"), "按直接证据核对。", "utf8");
  fs.writeFileSync(path.join(store.files.root, "implementation.ts"), "export const allowed = true;", "utf8");
  fs.writeFileSync(path.join(store.files.root, "design.md"), "当前实现允许该操作。", "utf8");
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ ...node("asset"), sourceScope: ["AGENTS.md"] }] }, null);
  const executionThreadId = "knowledge-execution-thread" as ThreadId;
  identity.db.threads.create({ id: executionThreadId, workspaceId: "ws" as WorkspaceId, engine: "codex", title: "资产工作", threadType: "orchestration", threadSubtype: "knowledge-assets" });
  store.saveRun({
    schemaVersion: 1, id: "run-execution", createdAt: new Date().toISOString(), mode: "batch", nodeId: null,
    ownerThreadId: identity.threadId, selectedNodeIds: ["asset"], includeDescendants: false, strategy: "all", prompt: "生成资产", engine: "codex", model: null, effort: null,
    treeHash: store.readTree().hash, proposedTree: null, rationale: "", gaps: [], phase: "completed", error: null,
    items: [{ id: "item-execution", nodeId: "asset", title: "asset", expectedHash: null, instructions: "", inheritedInstructions: "", executionThreadId, status: "completed", revisionId: null, error: null }],
  });
  const turn = createKnowledgeConversationTurn({ ...identity, threadId: executionThreadId, turnId: "execution-turn", engine: "codex", model: null, effort: null, prompt: "请补充", isActive: () => true, trustedActor: identity.actor });
  assert.ok(turn);
  assert.equal(resolveClaudeControlMode({ planMode: false, accessMode: "read-only", conversationProfile: turn.conversationProfile }), "default");
  turn.execute("knowledge.source.list", {});
  const sources = (["implementation.ts", "design.md"] as const).map((path, index) => {
    const result = turn.execute("knowledge.source.read", { path, count: 1 });
    assert.equal(result.ok, true);
    return { kind: index === 0 ? "code" : "document", path, contentHash: (result.output as { contentHash: string }).contentHash, startLine: 1, endLine: 1, relation: "实际核对的代码和设计" };
  });
  const result = turn.execute("knowledge.asset.submit", { content: "# 修订后的资产", summary: "修订", sources });
  assert.equal(result.ok, true);
  turn.finish();
  assert.equal(store.detail("asset").current, null);
  assert.equal(store.readRevision("asset", store.detail("asset").drafts[0]!.id).content, "# 修订后的资产");
  assert.deepEqual(store.readRevision("asset", store.detail("asset").drafts[0]!.id).sources.map(source => source.path), ["implementation.ts", "design.md"]);
  const stale = createKnowledgeConversationTurn({ ...identity, threadId: executionThreadId, turnId: "execution-conflict", engine: "codex", model: null, effort: null, prompt: "继续修订", isActive: () => true, trustedActor: identity.actor })!;
  store.saveDocument({ nodeId: "asset", content: "其他操作已采用", origin: "manual", sources: [], expectedHash: null });
  const count = store.revisions("asset").length;
  assert.throws(() => stale.execute("knowledge.asset.submit", { content: "旧基线正文", summary: "不能覆盖新版本", sources: [{ kind: "requirement", requirement: "继续修订", relation: "本轮要求" }] }), /知识正文已变化/);
  assert.equal(store.revisions("asset").length, count);
  assert.equal(store.detail("asset").current?.content, "其他操作已采用");
  stale.finish();
});

test("自动修订后的工作会话可续写并复检，新旧版本分别保留真实用户要求", async () => {
  const { store, identity } = fixture();
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("rule", "发布约束", "knowledge-specifications")] }, null);
  const initial: KnowledgeAssetSource = { kind: "requirement", requirement: "INITIAL_REQUIREMENT", relation: "初次用户要求" };
  const followup: KnowledgeAssetSource = { kind: "requirement", requirement: "FOLLOWUP_REQUIREMENT", relation: "续写用户要求" };
  const executionThreadId = "specification-execution" as ThreadId;
  identity.db.threads.create({ id: executionThreadId, workspaceId: "ws" as WorkspaceId, engine: "codex", title: "规格工作会话", threadType: "orchestration", threadSubtype: "knowledge-assets" });
  let generated = 0, reviewed = 0;
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    /** 工具失败立即中止测试，避免把无效提交算作交付。 */
    const accepted = async <T,>(toolId: string, toolInput: unknown = {}): Promise<T> => {
      const result = await input.execute({ toolId, toolInput, accessMode: "read-only" });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.output as T;
    };
    if (input.purpose === "review") {
      const document = await accepted<{ generationInstructions: string; confirmedRequirements: string[] }>("knowledge.review.read", { startLine: 1, count: 200 });
      const evidence = document.generationInstructions.includes(followup.requirement!) ? followup : initial;
      assert.ok(document.confirmedRequirements.some(text => text.includes(evidence.requirement!)));
      assert.ok(document.confirmedRequirements.every(text => !text.includes("knowledge.review.report.read")));
      const issues = ++reviewed === 1 ? [{ id: "missing", severity: "error", category: "coverage", title: "缺少适用边界", detail: "需补充适用边界。", documentStartLine: 2, documentEndLine: 2, sources: [evidence], suggestion: "保留明确的用户要求。" }] : [];
      await accepted("knowledge.review.submit", { outcome: issues.length ? "issues" : "passed", summary: "已核对用户要求", sources: [evidence], issues });
      return;
    }
    generated++;
    input.onThreadCreated(executionThreadId);
    const item = store.readRun(input.runId).items[0]!;
    if (item.repairReportId) await accepted("knowledge.review.report.read", { nodeId: "rule", reportId: item.repairReportId, offset: 0 });
    await accepted("knowledge.asset.submit", { content: "# 发布约束\nINITIAL_REQUIREMENT", summary: "明确的发布要求", sources: [initial] });
  }, "request-followup", threadId => requireKnowledgeConversationOwner({ ...identity, threadId }), identity.db);
  /** 等待真实后台任务结束，超时保留状态供断言定位。 */
  const settle = async (id: string) => {
    const deadline = Date.now() + 12000;
    while (service.view(id).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const result = service.view(id);
    assert.equal(result.active, false, JSON.stringify(result));
    return result;
  };
  const run = service.begin({ requestId: "specification-followup", mode: "batch", ownerThreadId: identity.threadId, selectedNodeIds: ["rule"], includeDescendants: false, strategy: "all", prompt: initial.requirement!, treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 2 } });
  service.start(run.id);
  const completed = await settle(run.id);
  assert.equal(completed.items[0]?.review?.status, "passed");
  assert.equal(generated, 2);
  const repairedId = completed.items[0]!.revisionId!;
  assert.ok(completed.items[0]?.repairReportId);
  const turn = createKnowledgeConversationTurn({ ...identity, threadId: executionThreadId, turnId: "followup-after-repair", engine: "codex", model: null, effort: null, prompt: followup.requirement!, isActive: () => true, trustedActor: identity.actor })!;
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "rule", expectedHash: null, content: "# 发布约束\nFOLLOWUP_REQUIREMENT", summary: "用户补充要求", sources: [followup] }).ok, true);
  turn.finish();
  const updated = store.readRun(run.id).items[0]!;
  assert.equal(updated.repairReportId, undefined);
  assert.equal(updated.repairRevisionId, undefined);
  assert.equal(store.readRevision("rule", updated.revisionId!).revision.userInstructions, followup.requirement);
  const reviews = new KnowledgeReviewStore(store);
  const historical = reviews.snapshot("rule", repairedId);
  assert.equal(reviews.requirementEvidence(historical, initial).requirement, initial.requirement);
  assert.throws(() => reviews.requirementEvidence(historical, followup), /必须逐字引用/);
  const current = reviews.snapshot("rule", updated.revisionId!);
  assert.equal(reviews.requirementEvidence(current, followup).requirement, followup.requirement);
  service.start(run.id);
  const final = await settle(run.id);
  assert.equal(final.phase, "completed", JSON.stringify(final));
  assert.equal(final.items[0]?.review?.status, "passed");
  assert.equal(generated, 2, "续写后只重新复检，不重生成正文");
  assert.equal(reviewed, 3);
});

test("停止后等待引擎收口才可采用计划，重复终态不能复活已采用计划", () => {
  const { store, turn, service, stop } = fixture();
  const task = turn("late-finish");
  task.execute("knowledge.plan.submit", { nodes: [node("feature")], rationale: "计划", gaps: [] });
  const runId = store.listRuns()[0]!.id;
  stop();
  assert.throws(() => service.apply(runId), /仍在执行/);
  task.finish(undefined, true);
  service.apply(runId);
  task.finish(undefined, true);
  assert.equal(store.readRun(runId).proposedTree, null);
  assert.equal(store.readRun(runId).treeHash, store.readTree().hash);
  assert.equal(store.readRun(runId).phase, "completed");
});

test("手动中断保持已停止状态，其他回合的迟到终态不结算当前知识回合", () => {
  const { store, turn } = fixture();
  const task = turn("current-turn");
  settleKnowledgeConversationEvent(task, "current-turn", { type: "turn.completed", ts: Date.now(), threadId: "existing-thread", workspaceId: "ws", engine: "codex", payload: { turnId: "previous-turn" } });
  assert.equal(store.listRuns()[0]?.phase, "planning");
  settleKnowledgeConversationEvent(task, "current-turn", { type: "turn.error", ts: Date.now(), threadId: "existing-thread", workspaceId: "ws", engine: "codex", payload: { turnId: "current-turn", error: "用户停止", terminationKind: "manual_interrupt" } });
  assert.equal(store.listRuns()[0]?.phase, "interrupted");
  assert.equal(store.listRuns()[0]?.error, null);
});

test("生成期间目录要求变化时拒绝用新要求标注旧正文", () => {
  const { store, turn } = fixture();
  store.saveTree({ schemaVersion: 1, instructions: "旧要求", nodes: [node("feature")] }, null);
  const task = turn("changed-requirements");
  store.saveTree({ ...store.readTree().tree, instructions: "新要求" }, store.readTree().hash);
  assert.throws(() => task.execute("knowledge.asset.submit", { nodeId: "feature", expectedHash: null, content: "根据旧要求生成", summary: "", sources: [{ kind: "requirement", requirement: "旧要求", relation: "目标" }] }), /知识树已变化/);
  assert.equal(store.detail("feature").current, null);
  task.finish();
});

test("Provider 直接拒绝发送时按结构化中断根因结算，不能等待尚未写入的回合终态", () => {
  for (const fields of [{ terminationKind: "manual_interrupt" }, { code: "turn_interrupted" }]) {
    const { store, turn } = fixture();
    store.saveTree({ schemaVersion: 1, instructions: "", nodes: [node("a")] }, null);
    const task = turn("provider-rejected-interrupt");
    task.execute("knowledge.asset.submit", { nodeId: "a", expectedHash: null, content: "停止前已交付", summary: "", sources: [{ kind: "requirement", requirement: "用户要求", relation: "目标" }] });
    task.finish(Object.assign(new Error("turn interrupted"), fields));
    assert.equal(store.listRuns()[0]?.phase, "interrupted");
    assert.equal(store.listRuns()[0]?.error, null);
    assert.equal(store.detail("a").current?.content, "停止前已交付");
  }
  const { store, turn } = fixture();
  turn("unstructured-error").finish(new Error("turn interrupted"));
  assert.equal(store.listRuns()[0]?.phase, "failed", "普通错误文本不能伪装成手动中断");
});

test("采用调整后的计划后不会重新读取同会话的过期原计划", () => {
  const { store, turn, service } = fixture();
  const original = turn("original-plan");
  original.execute("knowledge.plan.submit", { nodes: [node("feature", "旧名称")], rationale: "初稿", gaps: [] });
  original.finish();
  const updated = turn("updated-plan");
  const updatedResult = updated.execute("knowledge.plan.submit", { nodes: [node("feature", "新名称")], rationale: "调整稿", gaps: [] });
  updated.finish();
  service.apply((updatedResult.output as { runId: string }).runId);
  const discussion = turn("after-adoption");
  assert.equal((discussion.execute("knowledge.plan.read", {}).output as { runId: string | null }).runId, null);
  assert.equal(store.node("feature").title, "新名称");
  discussion.finish();
});
