import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_CATEGORIES, type KnowledgeAssetNode, type KnowledgeGenerationRunView, type KnowledgeGenerationItem } from "@codeflowai/shared";
import { knowledgeDocumentSession, knowledgeLibraryTree, knowledgePendingWorkTree, knowledgeResultRuns, knowledgeResultWorkTree, knowledgeWorkTree } from "../src/features/project-knowledge/knowledgeWorkTreeModel.js";
const node = (id: string, parentId: string | null = null): KnowledgeAssetNode => ({ id, parentId, title: id, orderKey: id, summary: "", instructions: "", sourceScope: [], tags: [] });
const nodes = [node("root"), node("pending", "root"), node("done", "root"), node("irrelevant")];
const item = (nodeId: string, status: KnowledgeGenerationItem["status"]): KnowledgeGenerationItem => ({ id: nodeId, nodeId, title: nodeId, status, expectedHash: null, inheritedInstructions: "", instructions: "", revisionId: status === "completed" ? `revision-${nodeId}` : null, error: null });
const run = (items: KnowledgeGenerationItem[], date = "2026-09-24"): KnowledgeGenerationRunView => ({ schemaVersion: 1, id: date, createdAt: date, mode: "batch", nodeId: null, engine: "codex", model: null, effort: null, prompt: "", treeHash: null, proposedTree: null, rationale: "", gaps: [], phase: "completed", active: false, activeItemId: null, items, error: null });

test("文件会话按确切候选和版本映射，多候选未选择时不猜测", () => {
  const first = { ...run([{ ...item("pending", "completed"), revisionId: "r1", executionThreadId: "work-1" }]), id: "run-1" };
  const second = { ...run([{ ...item("pending", "completed"), revisionId: "r2", executionThreadId: "work-2" }]), id: "run-2" };
  assert.equal(knowledgeDocumentSession([first, second], { nodeId: "pending", runId: null, revisionId: null }), null);
  assert.equal(knowledgeDocumentSession([first, second], { nodeId: "pending", runId: "run-1", revisionId: "r1" })?.threadId, "work-1");
  assert.equal(knowledgeDocumentSession([first, second], { nodeId: "pending", runId: null, revisionId: "r2" })?.threadId, "work-2");
  assert.equal(knowledgeDocumentSession([first, second], { nodeId: "pending", runId: "run-1", revisionId: "r2" }), null);
  assert.equal(knowledgeDocumentSession([first], { nodeId: "done", runId: null, revisionId: "r1" }), null);
  const legacy = { ...run([{ ...item("pending", "completed"), review: { status: "passed" as const, reportId: "report", executionThreadId: "legacy-review", error: null } }]), mode: "review" as const };
  assert.equal(knowledgeDocumentSession([legacy], { nodeId: "pending", runId: null, revisionId: null })?.kind, "复检会话");
  legacy.items[0]!.review!.parentThreadId = "work-parent";
  assert.equal(knowledgeDocumentSession([legacy], { nodeId: "pending", runId: null, revisionId: null })?.threadId, "work-parent");
  const discussed = { ...run([item("done", "completed")]), mode: "conversation" as const, threadId: "discussion-work" };
  assert.equal(knowledgeDocumentSession([discussed], { nodeId: "done", runId: null, revisionId: "revision-done" })?.threadId, "discussion-work");
});

test("人工编辑正式版本只回溯实际来源版本的会话，不匹配较新候选", () => {
  const adopted = { ...run([{ ...item("done", "completed"), revisionId: "adopted-revision", executionThreadId: "adopted-work" }]), id: "adopted-run", createdAt: "2026-09-24" };
  const newerCandidate = { ...run([{ ...item("done", "completed"), revisionId: "newer-candidate", executionThreadId: "candidate-work" }]), id: "candidate-run", createdAt: "2026-09-25" };
  assert.equal(knowledgeDocumentSession([adopted, newerCandidate], { nodeId: "done", runId: null, revisionId: "manual-revision", sourceRevision: { runId: "adopted-run", revisionId: "adopted-revision" } })?.threadId, "adopted-work");
  assert.equal(knowledgeDocumentSession([adopted, newerCandidate], { nodeId: "done", runId: "candidate-run", revisionId: "newer-candidate" })?.threadId, "candidate-work");
  assert.equal(knowledgeDocumentSession([adopted, newerCandidate], { nodeId: "done", runId: null, revisionId: "manual-revision" }), null);
  assert.equal(knowledgeDocumentSession([adopted, newerCandidate], { nodeId: "done", runId: null, revisionId: "manual-revision", sourceRevision: null }), null);
  assert.equal(knowledgeDocumentSession([adopted, newerCandidate], { nodeId: "done", runId: null, revisionId: "manual-revision", sourceRevision: { runId: "candidate-run", revisionId: "adopted-revision" } }), null);
  const review = { ...run([{ ...item("done", "completed"), revisionId: "manual-revision", review: { status: "passed" as const, reportId: "report", executionThreadId: "review-work", error: null } }]), id: "review-run", mode: "review" as const, createdAt: "2026-09-26" };
  assert.equal(knowledgeDocumentSession([adopted, review], { nodeId: "done", runId: null, revisionId: "manual-revision", sourceRevision: { runId: "adopted-run", revisionId: "adopted-revision" } })?.threadId, "adopted-work");
  const conversation = { ...run([{ ...item("done", "completed"), revisionId: "adopted-revision" }]), id: "conversation-run", mode: "conversation" as const, threadId: "conversation-work" };
  assert.equal(knowledgeDocumentSession([conversation, adopted], { nodeId: "done", runId: null, revisionId: "manual-revision", sourceRevision: { runId: "conversation-run", revisionId: "adopted-revision" } })?.threadId, "conversation-work");
  const unordered = [conversation, newerCandidate, adopted];
  assert.equal(knowledgeDocumentSession(unordered, { nodeId: "done", runId: "conversation-run", revisionId: "adopted-revision" })?.threadId, "conversation-work");
  assert.deepEqual(unordered.map(entry => entry.id), ["conversation-run", "candidate-run", "adopted-run"]);
});

test("统一目录保留全部正式文件，候选改名和移动在采用前不影响导航", () => {
  const official = [{ ...node("root"), contentMode: "directory" as const }, node("document", "root"), node("unchanged", "root")];
  const proposed = [{ ...node("new-root"), contentMode: "directory" as const }, { ...official[1]!, title: "候选名称", parentId: "new-root" }];
  const result = knowledgeLibraryTree(official, [], [{ ...run([item("document", "completed")]), proposedTree: { schemaVersion: 3, instructions: "", nodes: proposed } }], []);
  assert.deepEqual(result.nodes.find(node => node.id === "document"), official[1]);
  assert.ok(result.nodes.some(node => node.id === "unchanged"));
  assert.equal(result.documentCount, 1);
  assert.equal(result.structureCount, 2);
  assert.deepEqual(result.newIds, ["new-root"]);
});

test("统一目录保留同文件多版本，仅相同正文且结构上下文一致才归并", () => {
  const first = run([{ ...item("pending", "completed"), revisionId: "r1" }], "2026-09-22");
  const second = run([{ ...item("pending", "completed"), revisionId: "r2" }], "2026-09-23");
  const review = { ...second, id: "review", mode: "review" as const, createdAt: "2026-09-24" };
  const result = knowledgeLibraryTree(nodes, [], [first, second, review], []);
  assert.deepEqual(result.updates.map(update => update.revisionId), ["r2", "r1"]);
  assert.equal(result.aliases.get(`${second.id}:pending`), "review:pending");
  assert.equal(result.aliases.get("review:pending"), "review:pending");
  assert.equal(result.aliases.get(`${first.id}:pending`), `${first.id}:pending`);
  assert.equal(result.documentCount, 1);
  const moved = { ...second, id: "moved", proposedTree: { schemaVersion: 3 as const, instructions: "", nodes: [node("pending")] } };
  const differentStructure = knowledgeLibraryTree(nodes, [], [second, moved], []);
  assert.equal(differentStructure.updates.length, 2);
  assert.notEqual(differentStructure.aliases.get(`${second.id}:pending`), differentStructure.aliases.get("moved:pending"));
});

test("不采用最后新文档后候选目录退出，正式文件和默认空节点保留", () => {
  const directory = { ...node("new-root"), contentMode: "directory" as const };
  const candidate = { ...run([item("new-doc", "completed")]), proposedTree: { schemaVersion: 3 as const, instructions: "", nodes: [directory, node("new-doc", directory.id)] }, dismissals: [{ nodeId: "new-doc", revisionId: "revision-new-doc", baseHash: null, fingerprint: "dismissed", userId: "user", createdAt: 1 }] };
  const result = knowledgeLibraryTree(nodes, [], [candidate], []);
  assert.deepEqual(result.nodes, nodes);
  assert.equal(result.targetCount, 0);
});

test("同一文件只显示最后保存的候选，采用或不采用后旧版本不会补位", () => {
  const previous = run([{ ...item("pending", "completed"), revisionId: "previous" }], "2026-09-24");
  const latest = run([{ ...item("pending", "completed"), revisionId: "latest" }], "2026-09-23");
  const revisions = { pending: "latest" };
  assert.deepEqual(knowledgeLibraryTree(nodes, [], [previous, latest], [], revisions).updates.map(update => update.revisionId), ["latest"]);
  const published = [{ nodeId: "pending", revisionId: "latest", draftCount: 1, error: null }];
  assert.equal(knowledgeLibraryTree(nodes, published, [previous, latest], [], revisions).targetCount, 0);
  latest.dismissals = [{ nodeId: "pending", revisionId: "latest", baseHash: null, fingerprint: "latest", userId: "user", createdAt: 1 }];
  assert.equal(knowledgeLibraryTree(nodes, [], [previous, latest], [], revisions).targetCount, 0);
  assert.deepEqual(knowledgeLibraryTree(nodes, [], [previous, latest], [], { pending: "previous" }).updates.map(update => update.revisionId), ["previous"]);
});

test("建议和生成共同计文档数，纯结构更新仍有独立数量和处理入口", () => {
  const directory = { ...node("root"), contentMode: "directory" as const };
  const candidate = { ...run([]), baseTree: { schemaVersion: 3 as const, instructions: "", nodes: [directory] }, proposedTree: { schemaVersion: 3 as const, instructions: "", nodes: [{ ...directory, summary: "新的目录说明" }] } };
  const onlyStructure = knowledgeLibraryTree([directory], [], [candidate], []);
  assert.equal(onlyStructure.documentCount, 0);
  assert.equal(onlyStructure.structureCount, 1);
  assert.equal(onlyStructure.targetCount, 1);
  assert.equal(onlyStructure.documentCounts.root ?? 0, 0);
  assert.equal(onlyStructure.structureCounts.root, 1);
  const mixed = knowledgeLibraryTree(nodes, [], [run([item("pending", "completed")])], [{ nodeId: "pending", title: "pending", count: 2 }]);
  assert.equal(mixed.documentCount, 1);
  assert.equal(mixed.documentCounts.root, 1);
  assert.equal(mixed.nodes.length, nodes.length);
});

test("正式正文已相同时保留结构差异，只有改名的文档不误计正文", () => {
  const document = node("document"), tree = { schemaVersion: 3 as const, instructions: "", nodes: [document] };
  const candidate = { ...run([{ ...item(document.id, "completed"), revisionId: "r1" }]), baseTree: tree, proposedTree: { ...tree, nodes: [{ ...document, title: "候选名称" }] } };
  for (const proposal of [candidate, { ...candidate, items: [] }]) {
    const result = knowledgeLibraryTree([document], [{ nodeId: document.id, revisionId: "r1", draftCount: 0, error: null }], [proposal], []);
    assert.equal(result.updates.length, 1);
    assert.equal(result.documentCount, 0);
    assert.equal(result.structureCount, 1);
    assert.equal(result.nodes[0]?.title, document.title);
  }
});

test("正文和结构同时变化时分别保留两类待办标记", () => {
  const document = node("document"), baseTree = { schemaVersion: 3 as const, instructions: "", nodes: [document] };
  const candidate = { ...run([{ ...item(document.id, "completed"), revisionId: "r2" }]), baseTree,
    proposedTree: { ...baseTree, nodes: [{ ...document, title: "候选名称", parentId: null }] } };
  const result = knowledgeLibraryTree([document], [{ nodeId: document.id, revisionId: "r1", draftCount: 0, error: null }], [candidate], []);
  assert.equal(result.updates[0]?.body, true);
  assert.equal(result.updates[0]?.structure, true);
  assert.equal(result.documentCount, 1);
  assert.equal(result.structureCount, 1);
});

test("新增正文和引用同时标记文档与结构待办", () => {
  const directory = { ...node("root"), contentMode: "directory" as const };
  const generated = { ...node("generated", directory.id), contentMode: "generated" as const };
  const reference = { ...node("reference", directory.id), contentMode: "reference" as const };
  const candidate = { ...run([{ ...item(generated.id, "completed"), revisionId: "r-generated" }]), baseTree: { schemaVersion: 3 as const, instructions: "", nodes: [] },
    proposedTree: { schemaVersion: 3 as const, instructions: "", nodes: [directory, generated, reference] } };
  const result = knowledgeLibraryTree([], [], [candidate], []);
  const generatedUpdate = result.updates.find(update => update.nodeId === generated.id);
  const referenceUpdate = result.updates.find(update => update.nodeId === reference.id);
  assert.deepEqual(generatedUpdate && { body: generatedUpdate.body, structure: generatedUpdate.structure }, { body: true, structure: true });
  assert.deepEqual(referenceUpdate && { body: referenceUpdate.body, structure: referenceUpdate.structure }, { body: true, structure: true });
});

test("归档和移除文件的建议保留处理数量，不作为待新增文件进入正常目录", () => {
  const archived = { ...node("archived"), archived: true };
  const result = knowledgeLibraryTree([...nodes, archived], [], [], [{ nodeId: archived.id, title: archived.title, count: 1 }, { nodeId: "removed", title: "已移除", count: 1 }]);
  assert.deepEqual(result.nodes, nodes);
  assert.deepEqual(result.newIds, []);
  assert.equal(result.documentCount, 2);
});

test("跨任务确切正文已采用后不会因其他草稿或后续正式版本重新出现", () => {
  const document = node("document");
  const applied = { ...run([{ ...item(document.id, "completed"), revisionId: "r1" }], "2026-09-22"), adoptions: [{ requestId: "adopted", treeHash: null, planHash: "plan", selections: [{ nodeId: document.id, revisionId: "r1" }], targetTree: { schemaVersion: 3 as const, instructions: "", nodes: [document] }, targetTreeHash: "tree", completed: true, error: null }] };
  const reviewed = { ...run(applied.items), mode: "review" as const };
  const result = knowledgeLibraryTree([document], [{ nodeId: document.id, revisionId: "r2", draftCount: 1, error: null }], [applied, reviewed], []);
  assert.equal(result.updates.length, 0);
});

test("工作会话新旧修订归回原构建，不遮蔽原任务的复检待办", () => {
  const generated = { ...run([{ ...item("done", "completed"), executionThreadId: "work-thread", review: { status: "pending" as const, reportId: null, error: null } }], "2026-09-22"), mode: "build" as const };
  const discussion = { ...run([item("done", "completed")]), mode: "conversation" as const, threadId: "work-thread" };
  const olderRevision = { ...discussion, id: "old-discussion", items: [{ ...item("done", "completed"), revisionId: "old-revision" }] };
  const projected = knowledgeResultRuns([discussion, olderRevision, generated]);
  assert.deepEqual(projected.map(run => run.items.length), [0, 0, 1]);
  assert.equal(discussion.items.length, 1);
  assert.equal(generated.items[0]!.review?.status, "pending");
  const states = [{ nodeId: "done", revisionId: "revision-done", draftCount: 0, error: null }];
  assert.deepEqual(knowledgeResultWorkTree(nodes, states, [discussion, olderRevision, generated]).targets.map(item => item.nodeId), ["done"]);
  const failed = { ...discussion, error: { code: "GENERATION_FAILED", message: "修订失败" }, phase: "failed" as const };
  assert.equal(knowledgeResultRuns([failed, generated])[0]!.error?.code, "GENERATION_FAILED");
});

test("旧记录按确切版本归并，独立讨论、混合交付与历史目录计划仍保留", () => {
  const generated = run([item("done", "completed")], "2026-09-22");
  const discussion = { ...run([item("done", "completed"), item("pending", "completed")]), mode: "conversation" as const };
  assert.deepEqual(knowledgeResultRuns([discussion, generated])[0]!.items.map(item => item.nodeId), ["pending"]);
  const independent = { ...discussion, items: [{ ...item("done", "completed"), revisionId: "independent" }] };
  assert.strictEqual(knowledgeResultRuns([independent, generated])[0], independent);
  const plan = { ...discussion, proposedTree: { schemaVersion: 1 as const, instructions: "", nodes } };
  assert.strictEqual(knowledgeResultRuns([plan, generated])[0], plan);
  assert.strictEqual(knowledgeResultRuns([discussion])[0], discussion);
});

test("待处理树固定保留三个分类根，空目录不计待办，无关子知识仍隐藏", () => {
  const roots: KnowledgeAssetNode[] = KNOWLEDGE_CATEGORIES.map(category => ({ ...node(category.id), title: category.title, contentMode: "directory", category: category.category }));
  const rule = node("rule", "knowledge-specifications"), unrelated = node("unrelated", "knowledge-architecture");
  const allNodes = [...roots, rule, unrelated];
  const empty = knowledgePendingWorkTree(allNodes, [], [], []);
  assert.deepEqual(empty.nodes, roots.map(root => ({ ...root, archived: false })));
  assert.equal(empty.targetCount, 0);
  assert.deepEqual(empty.counts, {});
  for (const result of [
    knowledgePendingWorkTree(allNodes, [], [run([item(rule.id, "failed")])], []),
    knowledgePendingWorkTree(allNodes, [], [], [{ nodeId: rule.id, title: rule.title, count: 2 }]),
  ]) {
    assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set([...roots.map(node => node.id), rule.id]));
    assert.equal(result.targetCount, 1);
    assert.equal(result.counts["knowledge-architecture"], undefined);
    assert.equal(result.counts["knowledge-product"], undefined);
    assert.equal(result.nodes.find(node => node.id === rule.id)?.parentId, "knowledge-specifications");
  }
});

test("待处理树只保留命中节点及祖先，聚合数量并保留已移除资产的处理入口", () => {
  const result = knowledgeWorkTree(nodes, [{ nodeId: "pending", title: "待处理", count: 2 }, { nodeId: "removed", title: "已移除", count: 1 }]);
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(["root", "pending", "removed"]));
  assert.deepEqual(result.counts, { pending: 2, root: 2, removed: 1 });
  assert.equal(result.nodes.find(node => node.id === "pending")?.parentId, "root");
  assert.equal(result.targetCount, 2);
});

test("已采用且复检通过的结果退出树，待复检、失败和待采用结果保留", () => {
  const states = nodes.map(node => ({ nodeId: node.id, revisionId: `revision-${node.id}`, draftCount: node.id === "pending" ? 1 : 0, error: null }));
  const result = knowledgeResultWorkTree(nodes, states, [run([item("pending", "completed"), item("done", "completed")])]);
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(["root", "pending"]));
  const issue = { ...item("done", "completed"), review: { status: "issues" as const, reportId: "report", error: null } };
  assert.ok(knowledgeResultWorkTree(nodes, states, [run([issue])]).nodes.some(node => node.id === "done"));
  assert.equal(knowledgeResultWorkTree(nodes, states, [run([{ ...issue, reviewConfig: { enabled: false, model: null, effort: null } }])]).targetCount, 0);
});

test("新的成功交付取代旧失败；未采用的目录计划也能从树定位", () => {
  const states = [{ nodeId: "done", revisionId: "revision-done", draftCount: 0, error: null }];
  assert.equal(knowledgeResultWorkTree(nodes, states, [run([item("done", "failed")], "2026-09-23"), run([item("done", "completed")])]).targetCount, 0);
  const plan = { ...run([]), proposedTree: { schemaVersion: 1 as const, instructions: "", nodes: [node("new-root"), node("new-child", "new-root")] } };
  assert.deepEqual(new Set(knowledgeResultWorkTree(nodes, states, [plan]).nodes.map(node => node.id)), new Set(["new-root", "new-child"]));
});

test("统一待处理树聚合两类来源，节点去重且祖先不重复计数", () => {
  const result = knowledgePendingWorkTree(nodes, [], [run([item("pending", "failed")])], [
    { nodeId: "pending", title: "pending", count: 2 }, { nodeId: "done", title: "done", count: 1 },
  ]);
  assert.equal(result.targetCount, 2);
  assert.deepEqual(result.counts, { pending: 3, root: 4, done: 1 });
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(["root", "pending", "done"]));
});

test("本次不采用退出待处理，但其他任务的未处理版本保留入口", () => {
  const recent = { ...run([item("pending", "completed")]), dismissals: [{ nodeId: "pending", revisionId: "revision-pending", baseHash: null, fingerprint: "fingerprint", userId: "user", createdAt: 1 }] };
  assert.equal(knowledgeResultWorkTree(nodes, [], [recent]).targetCount, 0);
  const older = run([{ ...item("pending", "completed"), revisionId: "older-revision" }], "2026-09-23");
  assert.equal(knowledgeResultWorkTree(nodes, [], [recent, older]).targetCount, 1);
});

test("部分采用只移除已生效候选，保留剩余引用和目录路径", () => {
  const proposedTree = { schemaVersion: 2 as const, instructions: "", nodes: [{ ...node("root"), contentMode: "directory" as const }, { ...node("new-ref", "root"), contentMode: "reference" as const, reference: { path: "README.md", adoptedContentHash: "hash" } }] };
  const partial = { ...run([]), mode: "build" as const, proposedTree, appliedTreeHash: "partial-tree", adoptions: [{ requestId: "request", treeHash: null, planHash: "plan", selections: [{ nodeId: "root", revisionId: null }], targetTree: proposedTree, targetTreeHash: "hash", completed: true, error: null }] };
  const result = knowledgeResultWorkTree([proposedTree.nodes[0]!], [], [partial]);
  assert.equal(result.targetCount, 1);
  assert.deepEqual(result.targets.map(item => item.nodeId), ["new-ref"]);
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set(["root", "new-ref"]));
});

test("仅引用两分支部分采用后，未采用的目录及引用继续留在待处理树", () => {
  const adoptedNodes = [{ ...node("root"), contentMode: "directory" as const }, { ...node("first", "root"), contentMode: "reference" as const, reference: { path: "README.md", adoptedContentHash: "first" } }];
  const proposedTree = { schemaVersion: 2 as const, instructions: "", nodes: [...adoptedNodes, { ...node("remaining-dir", "root"), contentMode: "directory" as const }, { ...node("remaining-ref", "remaining-dir"), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "remaining" } }] };
  const partial = { ...run([]), mode: "build" as const, proposedTree, appliedTreeHash: "partial-tree", adoptions: [{ requestId: "request", treeHash: null, planHash: "plan", selections: [{ nodeId: "root", revisionId: null }, { nodeId: "first", revisionId: null }], targetTree: proposedTree, targetTreeHash: "hash", completed: true, error: null }] };
  const result = knowledgeResultWorkTree(adoptedNodes, [], [partial]);
  assert.deepEqual(new Set(result.targets.map(item => item.nodeId)), new Set(["remaining-dir", "remaining-ref"]));
  assert.deepEqual(new Set(result.nodes.map(item => item.id)), new Set(["root", "remaining-dir", "remaining-ref"]));
});

test("同任务采用旧正文后提交新修订，新版本继续显示待处理", () => {
  const draft = { ...item("pending", "completed"), revisionId: "r2", review: { status: "passed" as const, reportId: "report", error: null } };
  const adopted = { ...run([draft]), adoptions: [{ requestId: "request", treeHash: null, planHash: "plan", selections: [{ nodeId: "pending", revisionId: "r1" }], targetTree: { schemaVersion: 1 as const, instructions: "", nodes }, targetTreeHash: "tree", completed: true, error: null }] };
  const result = knowledgeResultWorkTree(nodes, [{ nodeId: "pending", revisionId: "r1", draftCount: 1, error: null }], [adopted]);
  assert.equal(result.targetCount, 1);
  assert.deepEqual(result.targets.map(item => item.nodeId), ["pending"]);
});

test("最后正文不采用后纯新目录链退出待处理，未处理内容与旧目录结构保留", () => {
  const root = { ...node("new-root"), contentMode: "directory" as const }, nested = { ...node("new-nested", "new-root"), contentMode: "directory" as const };
  const document = { ...node("new-doc", "new-nested"), contentMode: "generated" as const };
  const candidate = { ...run([item("new-doc", "completed")]), mode: "build" as const, proposedTree: { schemaVersion: 2 as const, instructions: "", nodes: [root, nested, document] }, dismissals: [{ nodeId: "new-doc", revisionId: "revision-new-doc", baseHash: null, fingerprint: "fingerprint", userId: "user", createdAt: 1 }] };
  assert.equal(knowledgeResultWorkTree([], [], [candidate]).targetCount, 0);
  for (const status of ["failed", "pending"] as const) {
    const unfinished = { ...candidate, items: [item("new-doc", status)], dismissals: [] };
    assert.deepEqual(new Set(knowledgeResultWorkTree([], [], [unfinished]).nodes.map(node => node.id)), new Set(["new-root", "new-nested", "new-doc"]));
  }
  const reference = { ...node("reference", "new-nested"), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "hash" } };
  assert.deepEqual(new Set(knowledgeResultWorkTree([], [], [{ ...candidate, proposedTree: { ...candidate.proposedTree, nodes: [...candidate.proposedTree.nodes, reference] } }]).nodes.map(node => node.id)), new Set(["new-root", "new-nested", "reference"]));
  const existing = { ...root, title: "原目录" };
  assert.deepEqual(knowledgeResultWorkTree([existing], [], [candidate]).targets.map(item => item.nodeId), ["new-root"]);
});

test("已有引用或正文移入候选新目录时，按候选父链保留新祖先待办", () => {
  const directory = { ...node("new-dir"), contentMode: "directory" as const };
  for (const contentMode of ["reference", "generated"] as const) {
    const existing = { ...node("existing"), contentMode, ...(contentMode === "reference" ? { reference: { path: "guide.md", adoptedContentHash: "hash" } } : {}) };
    const moved = { ...existing, parentId: "new-dir" };
    const proposal = { ...run(contentMode === "generated" ? [item("existing", "completed")] : []), mode: "build" as const, proposedTree: { schemaVersion: 2 as const, instructions: "", nodes: [directory, moved] } };
    const result = knowledgeResultWorkTree([existing], [{ nodeId: "existing", revisionId: "old", draftCount: 1, error: null }], [proposal]);
    assert.deepEqual(new Set(result.targets.map(item => item.nodeId)), new Set(["new-dir", "existing"]));
    assert.equal(result.nodes.find(node => node.id === "existing")?.parentId, "new-dir");
    const unified = knowledgePendingWorkTree([existing], [{ nodeId: "existing", revisionId: "old", draftCount: 1, error: null }], [proposal], []);
    assert.equal(unified.nodes.find(node => node.id === "existing")?.parentId, "new-dir");
    assert.equal(unified.counts["new-dir"], 2);
  }
});

test("候选快照中未改动的旧节点不因正式树后来变化而产生幽灵待办", () => {
  const original = { ...node("root"), contentMode: "directory" as const };
  const document = { ...node("document", "root"), contentMode: "generated" as const };
  const current = { ...original, title: "最新正式名称" };
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [original, document] };
  const candidate = { ...run([item("document", "completed")]), mode: "build" as const, baseTree: tree, proposedTree: tree };
  const states = [{ nodeId: "document", revisionId: "old", draftCount: 1, error: null }];
  const result = knowledgeResultWorkTree([current, document], states, [candidate]);
  assert.deepEqual(result.targets.map(item => item.nodeId), ["document"]);
  assert.equal(result.nodes.find(node => node.id === "root")?.title, current.title);
  assert.equal(knowledgeResultWorkTree([current, document], [], [{ ...candidate, items: [] }]).targetCount, 0);
});

test("更新任务完整快照不覆盖另一个任务尚未采用的真实结构差异", () => {
  const existing = { ...node("existing"), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "hash" } };
  const directory = { ...node("new-directory"), contentMode: "directory" as const };
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [existing] };
  const changed = { ...run([], "2026-09-23"), mode: "build" as const, baseTree: tree, proposedTree: { ...tree, nodes: [directory, { ...existing, parentId: directory.id }] } };
  const recent = { ...run([]), mode: "build" as const, baseTree: tree, proposedTree: tree };
  const result = knowledgeResultWorkTree([existing], [], [changed, recent]);
  assert.deepEqual(new Set(result.targets.map(item => item.nodeId)), new Set([directory.id, existing.id]));
  assert.equal(result.nodes.find(node => node.id === existing.id)?.parentId, directory.id);
});

test("多任务修改同一节点时导航采用较新待处理差异，未选祖先保持正式事实", () => {
  const root = { ...node("root"), contentMode: "directory" as const };
  const existing = { ...node("existing", "root"), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "hash" } };
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [root, existing] };
  const older = { ...run([], "2026-09-23"), mode: "build" as const, baseTree: tree, proposedTree: { ...tree, nodes: [root, { ...existing, title: "旧提案" }] } };
  const recent = { ...run([]), mode: "build" as const, baseTree: tree, proposedTree: { ...tree, nodes: [root, { ...existing, title: "新提案" }] } };
  const result = knowledgeResultWorkTree([{ ...root, title: "正式目录新名" }, existing], [], [older, recent]);
  assert.deepEqual(result.targets.map(item => item.nodeId), [existing.id]);
  assert.equal(result.nodes.find(node => node.id === existing.id)?.title, "新提案");
  assert.equal(result.nodes.find(node => node.id === root.id)?.title, "正式目录新名");
});

test("取消采用仅关闭未生效选择，保留未选候选并按已生效事实展示祖先", () => {
  const root = { ...node("root"), contentMode: "directory" as const };
  const reference = (id: string) => ({ ...node(id, root.id), contentMode: "reference" as const, reference: { path: `${id}.md`, adoptedContentHash: "hash" } });
  const first = reference("first"), cancelled = reference("cancelled"), unselected = reference("unselected");
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [root, first, cancelled, unselected] };
  const candidate = {
    ...run([]), mode: "build" as const, baseTree: { ...tree, nodes: [] }, proposedTree: tree,
    adoptions: [{ requestId: "request", treeHash: null, planHash: "plan", selections: [root, first, cancelled].map(node => ({ nodeId: node.id, revisionId: null })), targetTree: tree, targetTreeHash: "tree", completed: false, cancelled: true, appliedNodeIds: [root.id, first.id], error: null }],
    dismissals: [{ nodeId: cancelled.id, revisionId: null, baseHash: null, fingerprint: "structure", userId: "user", createdAt: 1 }],
  };
  const result = knowledgeResultWorkTree([{ ...root, title: "最新正式目录" }, first], [], [candidate]);
  assert.deepEqual(result.targets.map(item => item.nodeId), [unselected.id]);
  assert.deepEqual(new Set(result.nodes.map(node => node.id)), new Set([root.id, unselected.id]));
  assert.equal(result.nodes.find(node => node.id === root.id)?.title, "最新正式目录");
});

test("目录与引用结构不采用回执退出待办，正文回执仍精确绑定版本", () => {
  const root = { ...node("root"), contentMode: "directory" as const };
  const reference = { ...node("reference", root.id), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "hash" } };
  const document = { ...node("document", root.id), contentMode: "generated" as const };
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [root, reference, document] };
  const candidate: KnowledgeGenerationRunView = {
    ...run([{ ...item(document.id, "completed"), revisionId: "r2" }]), mode: "build" as const,
    baseTree: { ...tree, nodes: [] }, proposedTree: tree,
    dismissals: [root, reference].map(node => ({ nodeId: node.id, revisionId: null, baseHash: null, fingerprint: "structure", userId: "user", createdAt: 1 })),
  };
  candidate.dismissals!.push({ nodeId: document.id, revisionId: "r1", baseHash: null, fingerprint: "document", userId: "user", createdAt: 1 });
  assert.deepEqual(knowledgeResultWorkTree([], [], [candidate]).targets.map(item => item.nodeId), [document.id]);
  candidate.dismissals!.push({ nodeId: document.id, revisionId: "r2", baseHash: null, fingerprint: "document", userId: "user", createdAt: 2 });
  assert.equal(knowledgeResultWorkTree([], [], [candidate]).targetCount, 0);
});

test("旧整体目录计划采用完成后，后续正式调整不会重新生成待办", () => {
  const original = node("root");
  const plan = { ...run([]), mode: "tree" as const, proposedTree: { schemaVersion: 1 as const, instructions: "", nodes: [original] }, appliedTreeHash: "adopted" };
  assert.equal(knowledgeResultWorkTree([{ ...original, title: "后续正式调整" }], [], [plan]).targetCount, 0);
});

test("目录级联不采用关闭未交付正文，后续确切新版本仍保留待办", () => {
  const directory = { ...node("directory"), contentMode: "directory" as const };
  const document = { ...node("document", directory.id), contentMode: "generated" as const };
  const tree = { schemaVersion: 2 as const, instructions: "", nodes: [directory, document] };
  const candidate: KnowledgeGenerationRunView = {
    ...run([]), mode: "build", baseTree: { ...tree, nodes: [] }, proposedTree: tree,
    dismissals: tree.nodes.map(node => ({ nodeId: node.id, revisionId: null, baseHash: null, fingerprint: "structure", userId: "user", createdAt: 1 })),
  };
  for (const status of ["failed", "pending"] as const) {
    candidate.items = [item(document.id, status)];
    assert.equal(knowledgeResultWorkTree([], [], [candidate]).targetCount, 0);
  }
  candidate.items = [{ ...item(document.id, "completed"), revisionId: "new-revision" }];
  assert.deepEqual(knowledgeResultWorkTree([], [], [candidate]).targets.map(item => item.nodeId), [document.id]);
});

test("复检不采用同一确切正文后原生成任务也退出，不关闭另一版本或其他任务结构", () => {
  const first = { ...item("pending", "completed"), revisionId: "r1" };
  const generated = run([first], "2026-09-22");
  const reviewed = { ...run([first], "2026-09-23"), mode: "review" as const, dismissals: [{ nodeId: first.nodeId, revisionId: first.revisionId, baseHash: null, fingerprint: "version", userId: "user", createdAt: 1 }] };
  assert.equal(knowledgeResultWorkTree(nodes, [], [generated, reviewed]).targetCount, 0);
  const second = run([{ ...first, revisionId: "r2" }]);
  assert.deepEqual(knowledgeResultWorkTree(nodes, [], [generated, reviewed, second]).targets.map(item => item.nodeId), [first.nodeId]);

  const reference = { ...node("reference"), contentMode: "reference" as const, reference: { path: "guide.md", adoptedContentHash: "hash" } };
  const proposal = { ...run([]), mode: "build" as const, proposedTree: { schemaVersion: 2 as const, instructions: "", nodes: [reference] } };
  const dismissedProposal = { ...proposal, createdAt: "2026-09-23", dismissals: [{ nodeId: reference.id, revisionId: null, baseHash: null, fingerprint: "structure", userId: "user", createdAt: 1 }] };
  assert.deepEqual(knowledgeResultWorkTree([], [], [proposal, dismissedProposal]).targets.map(item => item.nodeId), [reference.id]);
});

test("活动候选显示生成中并与待确认版本分开计数", () => {
  const root = { ...node("root"), contentMode: "directory" as const };
  const document = { ...node("document", root.id), contentMode: "generated" as const };
  const states = [{ nodeId: document.id, revisionId: "formal", draftCount: 2, error: null }];
  const active = { ...run([{ ...item(document.id, "completed"), revisionId: "reviewing-revision", review: { status: "pending" as const, reportId: null, error: null } }], "2026-09-26"),
    id: "active-run", phase: "generating" as const, active: true, activeItemId: null, activeItemIds: [], activeItemStages: [] };
  const waiting = { ...run([{ ...item(document.id, "completed"), revisionId: "waiting-revision" }], "2026-09-25"), id: "waiting-run" };
  const result = knowledgeLibraryTree([root, document], states, [active, waiting], []);

  assert.equal(result.updates.find(update => update.runId === active.id)?.generating, true);
  assert.equal(result.updates.find(update => update.runId === waiting.id)?.generating, false);
  assert.equal(result.generatingCount, 1);
  assert.equal(result.generatingCounts[document.id], 1);
  assert.equal(result.generatingCounts[root.id], 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.targetCount, 1);
  assert.equal(result.documentCounts[document.id], 1);

  const onlyActive = knowledgeLibraryTree([root, document], states, [active], []);
  assert.equal(onlyActive.generatingCount, 1);
  assert.equal(onlyActive.pendingCount, 0);
  assert.equal(onlyActive.documentCount, 0);

  const stageOnly = { ...active, id: "stage-run", activeItemStages: [{ itemId: document.id, stage: "generating" as const }],
    items: [{ ...active.items[0]!, review: { status: "passed" as const, reportId: "report", error: null } }] };
  assert.equal(knowledgeLibraryTree([root, document], states, [stageOnly], []).updates[0]?.generating, true);

  const queued = { ...run([item(document.id, "pending")], "2026-09-27"), id: "queued-run", phase: "generating" as const, active: true };
  const queuedResult = knowledgeLibraryTree([root, document], states, [queued], []);
  assert.equal(queuedResult.updates[0]?.generating, true);
  assert.equal(queuedResult.generatingCount, 1);
  assert.equal(queuedResult.pendingCount, 0);
});
