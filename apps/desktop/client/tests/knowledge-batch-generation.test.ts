import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { KnowledgeAssetNode } from "@codeflowai/shared";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeAssetError } from "../src/knowledge/knowledgeAssetFiles.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import type { KnowledgeGenerationEngineInput, KnowledgeGenerationExecutor } from "../src/knowledge/knowledgeGenerationEngine.js";
import { openClientDb } from "../src/db/clientDb.js";

const node = (id: string, parentId: string | null = null): KnowledgeAssetNode => ({ id, parentId, title: id, orderKey: id, summary: "", tags: [], instructions: `${id}要求`, sourceScope: [] });
const source = { kind: "requirement", requirement: "用户要求描述资产行为", relation: "本次写作要求" };
const submit = (input: KnowledgeGenerationEngineInput, content = `# ${input.title}`) => input.execute({ toolId: "knowledge.asset.submit", toolInput: { content, summary: "说明", sources: [source] } } as any);
/** 固定 writer 使用当前测试注册的真实工作区，收口后关闭自有 DB。 */
function fixture(execute: KnowledgeGenerationExecutor = async input => { await submit(input); }, guard = (_id: string): { nodeId: string | null; activationVersion: number } => ({ nodeId: null, activationVersion: 1 })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-batch-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: "ws" as any, title: "批任务", path: root });
  test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "项目要求", nodes: [node("root"), node("a", "root"), node("b", "root"), node("outside")] }, null);
  const service = new KnowledgeGenerationService(store, "ws", execute, "req", guard, db);
  const begin = (extra: Partial<Parameters<typeof service.begin>[0]> = {}) => service.begin({ requestId: `request-${crypto.randomUUID()}`, mode: "batch", ownerThreadId: "knowledge-owner", selectedNodeIds: ["root"], includeDescendants: true, strategy: "missing", prompt: "说明业务", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null }, ...extra });
  return { store, service, begin };
}
async function settle(service: KnowledgeGenerationService, id: string) {
  for (let i = 0; i < 200 && service.view(id).active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const run = service.view(id);
  assert.equal(run.active, false, "任务应已结束");
  return run;
}
/** 批量首稿也等待人工采用，来源断言读取本次实际交付的草稿。 */
function draft(store: KnowledgeAssetStore, nodeId: string) {
  assert.equal(store.detail(nodeId).current, null);
  return store.readRevision(nodeId, store.detail(nodeId).drafts[0]!.id);
}

test("目录展开范围显式控制，多选去重；批量不调用 AI 规划树", () => {
  let calls = 0;
  const { store, begin } = fixture(async () => { calls++; });
  store.saveDocument({ nodeId: "a", content: "已有说明", sources: [source], expectedHash: null, origin: "manual" });
  const direct = begin({ includeDescendants: false });
  assert.deepEqual(direct.items.map(i => i.nodeId), ["root"]);
  const missing = begin({ selectedNodeIds: ["a", "root", "root"] });
  assert.deepEqual(missing.items.map(i => i.nodeId), ["root", "b"]);
  assert.deepEqual(missing.selectedNodeIds, ["a", "root"]);
  assert.equal(missing.ownerThreadId, "knowledge-owner");
  assert.equal(missing.threadId, undefined);
  assert.equal(missing.phase, "planned");
  assert.equal(calls, 0);
  const all = begin({ strategy: "all" });
  assert.deepEqual(all.items.map(i => i.nodeId), ["root", "a", "b"]);
  assert.ok(all.items.find(i => i.nodeId === "a")?.expectedHash);
  assert.equal(all.items.find(i => i.nodeId === "a")?.inheritedInstructions, "项目要求\n\nroot要求\n\na要求");
});

test("批次并发参数会同时执行多个资产，并把并发度冻结到任务", async () => {
  let active = 0, maxActive = 0;
  const { service, begin } = fixture(async input => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    await submit(input);
    active--;
  });
  const run = begin({ concurrency: 2 });
  assert.equal(run.concurrency, 2);
  assert.equal(begin({ concurrency: 16 }).concurrency, 16, "批次并发目标允许用户填写高于 Client 全局额度的值并自动排队");
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed");
  assert.ok(maxActive >= 2, `预期至少两个资产同时执行，实际峰值 ${maxActive}`);
});

test("继续未完成项只恢复未完成资产，不扫描已经交付的资产", async () => {
  const { store, service, begin } = fixture();
  const run = begin();
  service.start(run.id);
  await settle(service, run.id);
  const saved = store.readRun(run.id);
  const pending = saved.items.find(item => item.nodeId === "b")!;
  pending.status = "pending";
  pending.error = null;
  saved.phase = "partial";
  store.saveRun(saved);

  let revisionReads = 0;
  const readRevisions = store.revisions.bind(store);
  store.revisions = ((nodeId: string) => { revisionReads++; return readRevisions(nodeId); }) as typeof store.revisions;
  service.start(run.id);
  await settle(service, run.id);
  assert.equal(revisionReads, 1, "续跑只能恢复仍未完成的 b");
});

test("run.start 先确认入队再后台恢复，重复请求不创建第二个任务", async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service, begin } = fixture(async input => {
    entered = true;
    await gate;
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  const accepted = service.startAsync(run.id);
  assert.equal(accepted.active, true);
  assert.equal(accepted.phase, "generating");
  assert.equal(entered, false, "Host RPC 响应返回时不能已经进入同步恢复/执行");
  const duplicate = service.startAsync(run.id);
  assert.equal(duplicate.id, run.id);
  assert.equal(duplicate.active, true);
  for (let index = 0; index < 200 && !entered; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(entered, true);
  service.stop(run.id);
  release();
  assert.equal((await settle(service, run.id)).phase, "interrupted");
});

test("run.start 立即返回清理后的失败状态投影", () => {
  const { store, service, begin } = fixture(async () => { await new Promise(() => {}); });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false, concurrency: 3 });
  const saved = store.readRun(run.id);
  saved.items[0]!.status = "failed";
  saved.items[0]!.error = { code: "TEST_FAILURE", message: "上次失败" };
  saved.phase = "partial";
  store.saveRun(saved);

  const accepted = service.startAsync(run.id);
  assert.equal(accepted.active, true);
  assert.equal(accepted.phase, "generating");
  assert.equal(accepted.concurrency, 3);
  assert.equal(accepted.items[0]?.status, "pending");
  assert.equal(accepted.items[0]?.error, null);
  service.stop(run.id);
});

test("模型服务 429 会按退避重新进入调度器，不把资产误标成失败", async () => {
  let attempts = 0;
  const { service, begin } = fixture(async input => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(result.items[0]?.status, "completed");
  assert.equal(attempts, 2);
});

test("资产文档提示根据当前正文状态自动选择修改或生成", async () => {
  const prompts: string[] = [];
  const { store, service, begin } = fixture(async input => { prompts.push(input.prompt); await submit(input); });
  store.saveDocument({ nodeId: "a", content: "旧正文", sources: [source], expectedHash: null, origin: "manual" });
  const run = begin({ selectedNodeIds: ["root", "a", "b"], includeDescendants: false, strategy: "all" });
  service.start(run.id);
  await settle(service, run.id);
  assert.ok(prompts.some(prompt => prompt.includes("已有正式正文")));
  assert.ok(prompts.some(prompt => prompt.includes("没有正式正文")));
  assert.ok(prompts.some(prompt => prompt.includes("子资产") && prompt.includes("不设置字数目标")));
  assert.ok(prompts.some(prompt => prompt.includes("本专题解决的具体问题")));
});

test("固定清单不吸收后来新增节点，生成更新保留已有正文与待采用版本", async () => {
  const contexts: KnowledgeGenerationEngineInput[] = [];
  const { store, service, begin } = fixture(async input => { contexts.push(input); input.onThreadCreated(`execution-${input.title}`); await submit(input); });
  store.saveDocument({ nodeId: "a", content: "旧正文", sources: [source], expectedHash: null, origin: "manual" });
  const run = begin({ strategy: "all" });
  const saved = store.readTree();
  store.saveTree({ ...saved.tree, nodes: [...saved.tree.nodes, node("new", "root")] }, saved.hash);
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed");
  assert.deepEqual(contexts.map(c => c.title), ["root", "a", "b"]);
  assert.ok(contexts.every(c => c.ownerThreadId === "knowledge-owner"));
  assert.ok(contexts.every(c => !c.registry.tools.some(t => t.toolId === "knowledge.plan.submit")));
  assert.deepEqual(result.items.map(i => i.executionThreadId), ["execution-root", "execution-a", "execution-b"]);
  assert.equal(store.detail("a").current?.content, "旧正文");
  assert.equal(store.detail("a").drafts.length, 1);
  assert.equal(store.detail("new").current, null);
});

test("补齐空白不重复生成已保存的待复检草稿，更新模式仍可明确选中", () => {
  const { store, begin } = fixture();
  store.saveDocument({ nodeId: "a", content: "待复检正文", sources: [source], expectedHash: null, origin: "ai", adopt: false });
  assert.deepEqual(begin().items.map(item => item.nodeId), ["root", "b"]);
  assert.deepEqual(begin({ selectedNodeIds: ["a"], includeDescendants: false, strategy: "all" }).items.map(item => item.nodeId), ["a"]);
});

test("停止拒绝迟到提交，继续未完成项会重试失败项并保留完成项", async () => {
  const calls: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const suspended = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const { service, begin, store } = fixture(async input => {
    calls.push(input.title);
    if (input.title === "a" && first) {
      first = false; entered(); await suspended;
      assert.equal((await submit(input)).ok, false);
      return;
    }
    if (input.title === "b") throw new Error("模拟某项失败");
    await submit(input);
  });
  const run = begin({ concurrency: 1 }); service.start(run.id); await ready;
  service.stop(run.id); release();
  assert.equal((await settle(service, run.id)).phase, "interrupted");
  assert.equal(draft(store, "root").content, "# root");
  assert.equal(store.detail("a").current, null);
  service.start(run.id, { nodeIds: ["b"] });
  assert.equal((await settle(service, run.id)).phase, "partial");
  const before = calls.length;
  service.start(run.id, { retryFailed: true });
  await settle(service, run.id);
  assert.deepEqual(calls.slice(before), ["b"]);
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.deepEqual(calls.slice(before), ["b", "a", "b"]);
  assert.equal(result.items.find(i => i.nodeId === "root")?.status, "completed");
  assert.equal(result.items.find(i => i.nodeId === "b")?.status, "failed");
});

test("调整要求必须明确选择未完成项，不改其余项或重新读取正文基线", async () => {
  const seen: string[] = [];
  const { store, service, begin } = fixture(async input => { seen.push(input.prompt); await submit(input); });
  const run = begin();
  service.start(run.id, { nodeIds: ["root"] }); await settle(service, run.id);
  assert.throws(() => service.start(run.id, { prompt: "新要求" }), /明确选择/);
  assert.throws(() => service.start(run.id, { nodeIds: ["root"], prompt: "新要求" }), /尚未完成/);
  assert.throws(() => service.start(run.id, { nodeIds: ["outside"], prompt: "新要求" }), /尚未完成/);
  const expectedHash = service.view(run.id).items.find(i => i.nodeId === "a")!.expectedHash;
  service.start(run.id, { nodeIds: ["a"], prompt: "只改 a 的要求" });
  const result = await settle(service, run.id);
  assert.equal(result.items.find(i => i.nodeId === "a")?.expectedHash, expectedHash);
  assert.match(result.items.find(i => i.nodeId === "a")!.instructions, /只改 a/);
  assert.doesNotMatch(result.items.find(i => i.nodeId === "b")!.instructions, /只改 a/);
  assert.equal(result.items.find(i => i.nodeId === "b")?.status, "pending");
  assert.equal(draft(store, "a").content, "# a");
  assert.equal(seen.length, 2);
});

test("续跑携带任务当前并发数不会被误判为配置调整", async () => {
  const { service, begin } = fixture();
  const run = begin({ concurrency: 3 });
  service.start(run.id, { concurrency: 3 });
  assert.equal((await settle(service, run.id)).phase, "completed");
});

test("批量模型参数冻结到任务并传给执行器，单项覆盖仅影响所选未完成项", async () => {
  const seen: Array<{ node: string; model: string | null; effort: string | null }> = [];
  const { store, service, begin } = fixture(async input => {
    seen.push({ node: input.title, model: input.model, effort: input.effort });
    await submit(input);
  });
  const run = begin({ model: "gpt-5.6-sol", effort: "xhigh" });
  assert.ok(run.items.every(item => item.executionConfig === undefined));
  service.start(run.id, { nodeIds: ["root"] }); await settle(service, run.id);
  const completed = service.view(run.id).items.find(item => item.nodeId === "root");
  const unselected = service.view(run.id).items.find(item => item.nodeId === "b");
  assert.throws(() => service.start(run.id, { model: "alternate-model" }), /明确选择/);
  assert.throws(() => service.start(run.id, { effort: null }), /明确选择/);
  assert.throws(() => service.start(run.id, { nodeIds: ["root"], model: "alternate-model" }), /尚未完成/);
  service.start(run.id, { nodeIds: ["a"], model: "alternate-model", effort: "high" });
  const adjusted = await settle(service, run.id);
  assert.deepEqual(adjusted.items.find(item => item.nodeId === "root"), completed);
  assert.deepEqual(adjusted.items.find(item => item.nodeId === "b"), unselected);
  service.start(run.id); await settle(service, run.id);
  assert.deepEqual(seen, [
    { node: "root", model: "gpt-5.6-sol", effort: "xhigh" },
    { node: "a", model: "alternate-model", effort: "high" },
    { node: "b", model: "gpt-5.6-sol", effort: "xhigh" },
  ]);
  const saved = store.readRun(run.id);
  assert.deepEqual(saved.items.map(item => {
    const { model, effort } = item.executionConfig ?? saved;
    return { node: item.nodeId, model, effort };
  }), seen);
  assert.deepEqual(saved.items.map(item => item.executionConfig), [undefined, { model: "alternate-model", effort: "high" }, undefined]);
  assert.equal(saved.model, "gpt-5.6-sol", "任务初始配置不覆盖各项历史");
  assert.equal(saved.effort, "xhigh");
});

test("清空模型配置使用引擎默认，省略字段与失败重试保留已冻结参数", async () => {
  const seen: Array<{ model: string | null; effort: string | null }> = [];
  let shouldFail = true;
  const { service, begin } = fixture(async input => {
    seen.push({ model: input.model, effort: input.effort });
    if (shouldFail) throw new Error("模拟可重试执行失败");
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false, model: "gpt-5.6-sol", effort: "xhigh" });
  service.start(run.id, { nodeIds: ["a"], model: null }); await settle(service, run.id);
  assert.deepEqual(seen[0], { model: null, effort: "xhigh" });
  service.start(run.id, { nodeIds: ["a"], effort: null }); await settle(service, run.id);
  assert.deepEqual(seen[1], { model: null, effort: null });
  shouldFail = false;
  service.start(run.id, { retryFailed: true });
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed");
  assert.deepEqual(seen[2], { model: null, effort: null });
  assert.deepEqual(result.items[0]?.executionConfig, { model: null, effort: null });
});

test("未提交文档的失败重试会丢弃旧资产执行线程", async () => {
  let attempts = 0;
  const executionThreads: Array<string | null | undefined> = [];
  const { service, begin } = fixture(async input => {
    executionThreads.push(input.threadId);
    input.onThreadCreated(`stale-or-fresh-${attempts}`);
    if (attempts++ === 0) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_NO_SUBMISSION", "模型未调用受控提交工具");
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  const failed = await settle(service, run.id);
  assert.equal(failed.items[0]?.error?.code, "KNOWLEDGE_ASSET_NO_SUBMISSION");
  assert.equal(failed.items[0]?.executionThreadId, null);

  service.start(run.id, { retryFailed: true });
  const retried = await settle(service, run.id);
  assert.equal(retried.phase, "completed");
  assert.deepEqual(executionThreads, [null, null]);
});

test("绑定范围与权限在运行和提交时复核，已完成项不因引擎后续失败被撤销", async () => {
  let allowed = true;
  const { store, service, begin } = fixture(async input => {
    allowed = false;
    assert.equal((await submit(input)).ok, false);
  }, () => {
    if (!allowed) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "会话已解绑", 403);
    return { nodeId: "root", activationVersion: 1 };
  });
  assert.throws(() => begin({ selectedNodeIds: ["outside"] }), /范围/);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).items[0]?.status, "failed");
  assert.equal(store.detail("a").current, null);
  assert.throws(() => service.start(run.id, { retryFailed: true }), /已解绑/);
  const second = fixture(async input => { await submit(input); throw new Error("提交后引擎失败"); });
  const accepted = second.begin({ selectedNodeIds: ["a"], includeDescendants: false }); second.service.start(accepted.id);
  assert.equal((await settle(second.service, accepted.id)).items[0]?.status, "completed");
});

test("任务恢复回读已落盘版本，正文或继承要求变化不会被静默覆盖", async () => {
  let calls = 0;
  const { store, service, begin } = fixture(async input => { calls++; await submit(input); });
  const run = begin({ selectedNodeIds: ["a", "b"], includeDescendants: false });
  store.saveDocument({ nodeId: "a", content: "已落盘", sources: [source], expectedHash: null, origin: "ai", instructions: run.items[0]!.instructions, runId: run.id });
  store.saveDocument({ nodeId: "b", content: "人工新正文", sources: [source], expectedHash: null, origin: "manual" });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.items[0]?.status, "completed");
  assert.equal(result.items[1]?.error?.code, "KNOWLEDGE_ASSET_CONFLICT");
  assert.equal(store.detail("b").current?.content, "人工新正文");
  assert.equal(calls, 0);
  const other = begin({ selectedNodeIds: ["root"], includeDescendants: false });
  const tree = store.readTree(); store.saveTree({ ...tree.tree, instructions: "已修改项目要求" }, tree.hash);
  service.start(other.id);
  assert.equal((await settle(service, other.id)).items[0]?.error?.code, "KNOWLEDGE_ASSET_CONFLICT");
  service.start(other.id, { nodeIds: ["root"], prompt: "明确应用新要求" });
  assert.equal((await settle(service, other.id)).phase, "completed");
});

test("结束后立即重连不能复活旧执行权限，显式续跑才使用新会话版本", async () => {
  let activationVersion = 1, first = true;
  const { store, service, begin } = fixture(async input => {
    if (first) {
      first = false; activationVersion += 2;
      const result = await submit(input);
      assert.equal(result.ok, false);
      return;
    }
    await submit(input);
  }, () => ({ nodeId: null, activationVersion }));
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id); await settle(service, run.id);
  assert.equal(store.detail("a").current, null);
  service.start(run.id, { retryFailed: true });
  assert.equal((await settle(service, run.id)).phase, "completed");
});

test("资产运行中归档后仍能停止，取消不依赖资产范围继续有效", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const { service, store, begin } = fixture(async input => {
    entered(); await gate;
    assert.equal(input.signal.aborted, true);
    assert.equal((await submit(input)).ok, false);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id); await ready;
  const tree = store.readTree(); store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(n => n.id === "a" ? { ...n, archived: true } : n) }, tree.hash);
  assert.doesNotThrow(() => service.stop(run.id));
  release();
  assert.equal((await settle(service, run.id)).phase, "interrupted");
});


test("生成提交会使用本轮 source.read 台账补齐漏抄的内容指纹", async () => {
  let sourceResult: any;
  const { store, service, begin } = fixture(async input => {
    sourceResult = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", startLine: 1, count: 20 } } as any);
    assert.equal(sourceResult.ok, true);
    const submitted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: "# a", summary: "说明", sources: [{ kind: "code", path: "src/feature.ts", relation: "实现" }],
    } } as any);
    assert.equal(submitted.ok, true);
  });
  fs.mkdirSync(path.join(store.files.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(draft(store, "a").sources[0]?.contentHash, sourceResult.output.contentHash);
});

test("生成提交会修正模型抄写的截短内容指纹", async () => {
  let sourceResult: any;
  const { store, service, begin } = fixture(async input => {
    sourceResult = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", startLine: 1, count: 20 } } as any);
    assert.equal(sourceResult.ok, true);
    const submitted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: "# a", summary: "说明", sources: [{ kind: "code", path: "src/feature.ts", contentHash: `${sourceResult.output.contentHash.slice(0, 62)}...`, relation: "实现" }],
    } } as any);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
  });
  fs.mkdirSync(path.join(store.files.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(draft(store, "a").sources[0]?.contentHash, sourceResult.output.contentHash);
});

test("旧上下文的截短指纹不能冒充本轮阅读，补读后可提交", async () => {
  let submitted: any;
  const { store, service, begin } = fixture(async input => {
    const fullHash = store.readSource("src/feature.ts").contentHash;
    submitted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: "# a", summary: "说明", sources: [{ kind: "code", path: "src/feature.ts", contentHash: `${fullHash.slice(0, 60)}...`, relation: "实现" }],
    } } as any);
    assert.equal(submitted.ok, false);
    assert.match(submitted.message, /本轮.*read/);
    assert.equal((await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts" } } as any)).ok, true);
    submitted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: "# a", summary: "说明", sources: [{ kind: "code", path: "src/feature.ts", contentHash: `${fullHash.slice(0, 60)}...`, relation: "实现" }],
    } } as any);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
  });
  fs.mkdirSync(path.join(store.files.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(draft(store, "a").sources[0]?.contentHash, store.readSource("src/feature.ts").contentHash);
});

/** 正确指纹只证明文件身份，不能替代本轮对直接来源的实际阅读。 */
test("生成提交携带正确完整指纹也须先读取来源，补读后可重试", async t => {
  const { store, service, begin } = fixture(async input => {
    const evidence = { kind: "code", path: "src/feature.ts", contentHash: store.readSource("src/feature.ts").contentHash, startLine: 1, endLine: 1, relation: "实现" };
    const document = { content: "# a\n功能边界。", summary: "说明", sources: [evidence] };
    const unread = await input.execute({ toolId: "knowledge.asset.submit", toolInput: document, accessMode: "read-only" });
    assert.equal(unread.ok, false);
    assert.match(unread.message ?? "", /本轮.*knowledge\.source\.read/);
    assert.deepEqual(store.detail("a").drafts, [], "拒绝提交不能留下正文版本");
    const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: evidence.path, count: 1 }, accessMode: "read-only" });
    assert.equal(read.ok, true, JSON.stringify(read));
    const accepted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: document, accessMode: "read-only" });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  });
  t.after(() => fs.rmSync(store.files.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(store.files.root, "src"));
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n", "utf8");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false }); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.deepEqual(draft(store, "a").sources.map(source => [source.path, source.startLine, source.endLine]), [["src/feature.ts", 1, 1]]);
});

/** 多个已读行段之间的空洞仍属未核对证据，补齐后才允许合并引用。 */
test("生成引用行段须由本轮阅读完整覆盖，补读空缺后可提交", async t => {
  const { store, service, begin } = fixture(async input => {
    for (const startLine of [1, 3]) {
      const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", startLine, count: 1 }, accessMode: "read-only" });
      assert.equal(read.ok, true, JSON.stringify(read));
    }
    const evidence = { kind: "document", path: "src/feature.ts", contentHash: store.readSource("src/feature.ts").contentHash, startLine: 1, endLine: 3, relation: "完整机制" };
    const document = { content: "# a\n三个环节共同保证边界。", summary: "机制", sources: [evidence] };
    const incomplete = await input.execute({ toolId: "knowledge.asset.submit", toolInput: document, accessMode: "read-only" });
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.message ?? "", /补读引用行段/);
    assert.deepEqual(store.detail("a").drafts, []);
    const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: evidence.path, startLine: 2, count: 1 }, accessMode: "read-only" });
    assert.equal(read.ok, true, JSON.stringify(read));
    const accepted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: document, accessMode: "read-only" });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  });
  t.after(() => fs.rmSync(store.files.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(store.files.root, "src"));
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const first = 1;\nexport const second = 2;\nexport const third = 3;", "utf8");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false }); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.deepEqual(draft(store, "a").sources.map(source => [source.startLine, source.endLine]), [[1, 3]]);
});

/** 提交来源必须有本回合实际读取记录，候选线索之外的文件也不能免验。 */
test("生成直接提交未读取来源即使指纹正确也不保存版本", async t => {
  let rejection: Awaited<ReturnType<KnowledgeGenerationEngineInput["execute"]>> | undefined;
  const { store, service, begin } = fixture(async input => {
    const read = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", count: 1 }, accessMode: "read-only" });
    assert.equal(read.ok, true, JSON.stringify(read));
    rejection = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: "# a\n越界结论。", summary: "说明", sources: [{ kind: "code", path: "outside.ts", contentHash: store.readSource("outside.ts").contentHash, startLine: 1, endLine: 1, relation: "范围外实现" }],
    }, accessMode: "read-only" });
  });
  t.after(() => fs.rmSync(store.files.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(store.files.root, "src"));
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n", "utf8");
  fs.writeFileSync(path.join(store.files.root, "outside.ts"), "export const outside = true;\n", "utf8");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(rejection?.ok, false);
  assert.equal(rejection?.code, "KNOWLEDGE_ASSET_INPUT_INVALID");
  assert.match(rejection?.message ?? "", /尚未通过本轮 knowledge\.source\.read 核对/);
  assert.equal(result.phase, "partial");
  assert.equal(result.items[0]?.status, "failed");
  assert.deepEqual(store.detail("a").drafts, []);
  assert.equal(store.currentHash("a"), null);
});

test("同一个只读调用连续失败时保留真实错误，不提前伪装成读取上限", async () => {
  const results: any[] = [];
  const { service, begin } = fixture(async input => {
    results.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "missing/file.ts" } } as any));
    results.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "missing/file.ts" } } as any));
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  await settle(service, run.id);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[1]?.ok, false);
  assert.equal(results[1]?.code, results[0]?.code);
  assert.notEqual(results[1]?.code, "KNOWLEDGE_ASSET_READ_LIMIT_REACHED");
});


test("同一来源改变分页参数后仍保留真实错误", async () => {
  const results: any[] = [];
  const { service, begin } = fixture(async input => {
    results.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "missing/file.ts", startLine: 1, count: 20 } } as any));
    results.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "missing/file.ts", startLine: 21, count: 40 } } as any));
    results.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "missing/file.ts", startLine: 61, count: 80 } } as any));
    await submit(input);
  });
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  await settle(service, run.id);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[1]?.ok, false);
  assert.equal(results[1]?.code, results[0]?.code);
  assert.equal(results[2]?.code, results[0]?.code);
  assert.notEqual(results[2]?.code, "KNOWLEDGE_ASSET_READ_LIMIT_REACHED");
});

test("同一文件已覆盖的不同分页直接复用来源证据", async () => {
  let sourceReads = 0;
  const { store, service, begin } = fixture(async input => {
    const first = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", startLine: 1, count: 20 } } as any);
    assert.equal(first.ok, true);
    const second = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/feature.ts", startLine: 3, count: 5 } } as any);
    assert.equal(second.ok, true);
    const page = second.output as { startLine: number; endLine: number };
    assert.equal(page.startLine, 3);
    assert.equal(page.endLine, 7);
    await submit(input, "# a\n\n已核对来源");
  });
  fs.mkdirSync(path.join(store.files.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), Array.from({ length: 20 }, (_, index) => "export const line" + (index + 1) + " = " + (index + 1) + ";").join("\n"));
  const originalRead = store.readSource.bind(store);
  store.readSource = ((...args: Parameters<typeof store.readSource>) => { sourceReads++; return originalRead(...args); }) as typeof store.readSource;
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(sourceReads, 1);
});


test("生成可以读取候选来源之外的项目文件并采用，仍拒绝项目外与敏感路径", async t => {
  let result: any;
  const denied: any[] = [];
  const { store, service, begin } = fixture(async input => {
    result = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "outside.ts", startLine: 1, count: 20 } } as any);
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const path of ["../outside.ts", ".env"]) denied.push(await input.execute({ toolId: "knowledge.source.read", toolInput: { path } } as any));
    const submitted = await input.execute({ toolId: "knowledge.asset.submit", toolInput: { content: "# a\n项目实现基线。", summary: "实现基线", sources: [{ kind: "code", path: "outside.ts", contentHash: result.output.contentHash, startLine: 1, endLine: 1, relation: "实际读取的项目实现" }] } } as any);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
  });
  t.after(() => fs.rmSync(store.files.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(store.files.root, "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "src/feature.ts"), "export const feature = true;\n");
  fs.writeFileSync(path.join(store.files.root, "outside.ts"), "export const outside = true;\n");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["src/feature.ts"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.ok(denied.every(result => !result.ok && result.code === "KNOWLEDGE_ASSET_PATH_INVALID"));
  const preview = service.preview(run.id);
  service.apply(run.id, { requestId: crypto.randomUUID(), treeHash: preview.treeHash, planHash: preview.planHash, selections: preview.items.map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });
  assert.equal(store.detail("a").current!.sources[0]!.path, "outside.ts");
});


test("source.list accepts an ancestor directory that leads to the asset scope", async () => {
  let listed: any;
  const { store, service, begin } = fixture(async input => {
    listed = await input.execute({ toolId: "knowledge.source.list", toolInput: { directory: "packages", offset: 0 } } as any);
    await submit(input);
  });
  fs.mkdirSync(path.join(store.files.root, "packages", "shared", "src"), { recursive: true });
  fs.writeFileSync(path.join(store.files.root, "packages", "shared", "src", "feature.ts"), "export const feature = true;\n");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(item => item.id === "a" ? { ...item, sourceScope: ["packages/shared/src"] } : item) }, tree.hash);
  const run = begin({ selectedNodeIds: ["a"], includeDescendants: false });
  service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(listed?.ok, true, JSON.stringify(listed));
  assert.ok(listed.output.entries.some((entry: { path: string }) => entry.path === "packages/shared"));
});
