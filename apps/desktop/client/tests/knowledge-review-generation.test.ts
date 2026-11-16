import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeAssetSource, KnowledgeReviewIssue } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import type { KnowledgeGenerationEngineInput, KnowledgeGenerationExecutor } from "../src/knowledge/knowledgeGenerationEngine.js";
import { openClientDb } from "../src/db/clientDb.js";

// 测试进程内固定并发预算，不修改实际 Client 的运行配置。
process.env.CODEFLOWAI_KNOWLEDGE_CONCURRENCY = "2";
const { KnowledgeGenerationService, knowledgeRepairInstructions } = await import("../src/knowledge/knowledgeGenerationService.js");
type Service = InstanceType<typeof KnowledgeGenerationService>;

const tool = (input: KnowledgeGenerationEngineInput, toolId: string, toolInput: unknown = {}) => input.execute({ toolId, toolInput, accessMode: "full-access" });
async function accepted<T>(input: KnowledgeGenerationEngineInput, toolId: string, toolInput: unknown = {}): Promise<T> {
  const result = await tool(input, toolId, toolInput);
  assert.equal(result.ok, true, `${toolId}: ${JSON.stringify(result)}`);
  assert.ok(result.ok);
  return result.output as T;
}

/** 复检与日志共享当前测试的真实工作区，结束后关闭自有 DB。 */
function fixture(t: TestContext, execute: KnowledgeGenerationExecutor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-review-pipeline-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: "review-workspace" as any, title: "复检", path: root });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "permissions.ts"), "export function allowed(role: string) {\n  return role === 'owner';\n}\n");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "明确写权限", nodes: [
    { id: "permissions", parentId: null, title: "权限规范", orderKey: "1", summary: "", tags: [], instructions: "说明允许的角色", sourceScope: ["src/permissions.ts"] },
  ] }, null);
  const service = new KnowledgeGenerationService(store, "review-workspace", execute, "request-review", () => ({ nodeId: null, activationVersion: 1 }), db);
  const begin = (extra: Partial<Parameters<Service["begin"]>[0]> = {}) => service.begin({ requestId: crypto.randomUUID(), mode: "batch", ownerThreadId: "knowledge-owner", selectedNodeIds: ["permissions"], includeDescendants: false, strategy: "missing", prompt: "核对权限实现", treeHash: store.readTree().hash, engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", ...extra });
  const source: KnowledgeAssetSource = { kind: "code", path: "src/permissions.ts", contentHash: store.readSource("src/permissions.ts").contentHash, startLine: 1, endLine: 3, relation: "角色权限实现" };
  return { root, store, service, begin, source, reviews: new KnowledgeReviewStore(store) };
}

async function settled(service: Service, runId: string) {
  const deadline = Date.now() + 12000;
  while (service.view(runId).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const run = service.view(runId);
  assert.equal(run.active, false, "知识任务应已结束");
  return run;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 12000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, message);
}

async function readSource(input: KnowledgeGenerationEngineInput): Promise<KnowledgeAssetSource> {
  const read = await accepted<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: "src/permissions.ts", startLine: 1, count: 3 });
  return { kind: "code", path: read.path, contentHash: read.contentHash, startLine: 1, endLine: 3, relation: "真实权限判断" };
}

async function generate(input: KnowledgeGenerationEngineInput, content = "# 权限\n\n仅 owner 可以写。") {
  const source = await readSource(input);
  return accepted<{ revisionId: string; adopted: boolean }>(input, "knowledge.asset.submit", { content, summary: "权限说明", sources: [source] });
}

async function readDocument(input: KnowledgeGenerationEngineInput) {
  let next: number | null = 1;
  let pages = 0;
  do {
    const page: { nextLine: number | null } = await accepted(input, "knowledge.review.read", { startLine: next, count: 200 });
    next = page.nextLine; pages++;
  } while (next !== null);
  return pages;
}

function issue(source: KnowledgeAssetSource): KnowledgeReviewIssue {
  return { id: "issue_owner", severity: "error", category: "factual", title: "角色权限错误", detail: "实现仅允许 owner，正文范围更大。", documentStartLine: 2, documentEndLine: 2, sources: [source], suggestion: "将可写角色限定为 owner。" };
}

function reportInput(source: KnowledgeAssetSource, outcome: "passed" | "issues" = "passed") {
  return { outcome, summary: outcome === "passed" ? "已核对角色判断与正文。" : "角色权限说明需要修订。", sources: [source], issues: outcome === "passed" ? [] : [issue(source)] };
}

async function review(input: KnowledgeGenerationEngineInput, outcome: "passed" | "issues" = "passed") {
  await readDocument(input);
  const source = await readSource(input);
  return accepted<{ reportId: string }>(input, "knowledge.review.submit", reportInput(source, outcome));
}

test("单独复检可从AGENTS候选来源之外补读代码和文档", async t => {
  const { root, store, service, begin, reviews } = fixture(t, async input => {
    if (input.purpose !== "review") { await generate(input); return; }
    assert.match(input.instructions, /不是读取白名单/);
    await readDocument(input);
    const code = await readSource(input);
    await accepted(input, "knowledge.source.list", { directory: "docs" });
    const read = await accepted<{ contentHash: string }>(input, "knowledge.source.read", { path: "docs/permissions.md", count: 1 });
    await accepted(input, "knowledge.review.submit", { ...reportInput(code), sources: [code, { kind: "document", path: "docs/permissions.md", contentHash: read.contentHash, startLine: 1, endLine: 1, relation: "权限设计说明" }] });
  });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "核对权限边界。", "utf8");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/permissions.md"), "仅owner可写。", "utf8");
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(node => ({ ...node, sourceScope: ["AGENTS.md"] })) }, tree.hash);
  const generation = begin({ reviewConfig: { enabled: false, model: null, effort: null } }); service.start(generation.id);
  assert.equal((await settled(service, generation.id)).phase, "completed");
  const reviewRun = begin({ mode: "review" }); service.start(reviewRun.id);
  const result = await settled(service, reviewRun.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
  assert.equal(result.items[0]!.review!.status, "passed");
  assert.deepEqual(reviews.list("permissions")[0]!.sources.map(source => source.path), ["src/permissions.ts", "docs/permissions.md"]);
});

test("生成和复检拒绝敏感目录链接及未采用知识草稿，失败后不能采用", async t => {
  for (const stage of ["generation", "review"] as const) for (const variant of ["linked", "candidate"] as const) {
    let sourcePath = "";
    let rejected: Awaited<ReturnType<typeof tool>> | undefined;
    const context = fixture(t, async input => {
      if ((input.purpose ?? "generation") !== stage) { await generate(input); return; }
      if (stage === "review") await readDocument(input);
      rejected = await tool(input, "knowledge.source.read", { path: sourcePath });
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
      if (!rejected.ok) throw new Error(rejected.message);
    });
    if (variant === "linked") {
      fs.mkdirSync(path.join(context.root, ".aws"));
      fs.writeFileSync(path.join(context.root, ".aws/config.md"), "测试占位内容，不是真实凭据。", "utf8");
      fs.mkdirSync(path.join(context.root, ".claude/rules"), { recursive: true });
      fs.symlinkSync(path.join(context.root, ".aws"), path.join(context.root, ".claude/rules/linked"), process.platform === "win32" ? "junction" : "dir");
      sourcePath = ".claude/rules/linked/config.md";
    } else {
      const tree = context.store.readTree();
      context.store.saveTree({ ...tree.tree, nodes: [...tree.tree.nodes, { ...tree.tree.nodes[0]!, id: "unadopted", title: "未采用的其他知识" }] }, tree.hash);
      const revision = context.store.saveDocument({ nodeId: "unadopted", content: "# 未核实的候选结论", sources: [], expectedHash: null, origin: "ai", adopt: false });
      sourcePath = context.store.readRevision("unadopted", revision.id).path;
    }
    const run = context.begin(); context.service.start(run.id);
    const result = await settled(context.service, run.id);
    assert.ok(rejected && !rejected.ok);
    assert.equal(rejected.code, "KNOWLEDGE_ASSET_PATH_INVALID");
    assert.equal(result.phase, "partial");
    assert.equal(result.items[0]!.status, stage === "generation" ? "failed" : "completed");
    if (stage === "review") assert.equal(result.items[0]!.review!.status, "failed");
    assert.equal(context.store.detail("permissions").current, null);
    assert.equal(context.store.detail("permissions").drafts.length, stage === "generation" ? 0 : 1);
    assert.deepEqual(context.reviews.list("permissions"), []);
    assert.equal(context.service.preview(run.id).items[0]!.canApply, false);
  }
});

test("生成后默认独立复检：冻结模型参数、真实读证据并保存项目报告，首份正文保留待采用", async t => {
  const calls: KnowledgeGenerationEngineInput[] = [];
  const { service, begin, store, reviews } = fixture(t, async input => {
    calls.push(input);
    input.onThreadCreated(`execution-${calls.length}`);
    if (input.purpose === "review") {
      assert.equal(input.reviewParent?.threadId, "execution-1");
      input.reviewParent!.onThreadCreated("execution-1");
      assert.equal(input.registry.tools.some(tool => tool.toolId === "knowledge.asset.submit"), false);
      assert.equal(input.registry.tools.some(tool => tool.toolId === "knowledge.plan.submit"), false);
      await review(input);
    } else {
      const submitted = await generate(input);
      assert.equal(submitted.adopted, false);
    }
  });
  const run = begin();
  assert.deepEqual(run.reviewConfig, { enabled: true, model: "gpt-5.6-sol", effort: "xhigh" });
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.purpose, "review");
  assert.equal(calls[1]!.model, "gpt-5.6-sol");
  assert.equal(calls[1]!.effort, "xhigh");
  assert.ok(calls.every(call => call.ownerThreadId === "knowledge-owner"));
  assert.equal(result.items[0]!.executionThreadId, "execution-1");
  assert.equal(result.items[0]!.review?.executionThreadId, "execution-2");
  assert.equal(result.items[0]!.review?.parentThreadId, "execution-1");
  assert.equal(result.items[0]!.status, "completed");
  assert.equal(result.items[0]!.review?.status, "passed");
  const report = reviews.list("permissions")[0]!;
  assert.equal(report.id, result.items[0]!.review?.reportId);
  assert.equal(report.revisionId, result.items[0]!.revisionId);
  assert.equal(report.stale, false);
  assert.equal(store.detail("permissions").current, null);
  assert.equal(store.detail("permissions").drafts.length, 1);
});

test("续跑复检的空模型继承本项生成配置，保留原复检策略", async t => {
  let firstReview = true;
  const calls: KnowledgeGenerationEngineInput[] = [];
  const { service, begin, store } = fixture(t, async input => {
    calls.push(input);
    input.onThreadCreated(`execution-${calls.length}`);
    if (input.purpose !== "review") { await generate(input); return; }
    if (firstReview) { firstReview = false; throw new Error("复检暂时失败"); }
    await review(input);
  });
  const run = begin({ reviewConfig: { enabled: true, model: "old-review-model", effort: "low", autoRepair: false, maxRounds: 3 } });
  const saved = store.readRun(run.id);
  saved.items[0]!.executionConfig = { model: "item-generation-model", effort: "high" };
  store.saveRun(saved);
  service.start(run.id);
  const failed = await settled(service, run.id);
  assert.equal(failed.items[0]!.review?.status, "failed");
  assert.equal(calls[1]!.model, "old-review-model");
  service.start(run.id, { nodeIds: ["permissions"], reviewConfig: { enabled: true, model: null, effort: null } });
  const resumed = await settled(service, run.id);
  assert.equal(resumed.phase, "completed");
  assert.equal(calls[2]!.model, "item-generation-model");
  assert.equal(calls[2]!.effort, "high");
  assert.deepEqual(resumed.items[0]!.reviewConfig, { enabled: true, model: "item-generation-model", effort: "high", autoRepair: false, maxRounds: 3 });
  assert.equal(resumed.items[0]!.revisionId, failed.items[0]!.revisionId);
});

test("复检已提交后引擎失败仍显式失败，不自动修订或伪造成功", async t => {
  let generated = 0;
  const { service, begin, reviews } = fixture(t, async input => {
    if (input.purpose !== "review") { generated++; await generate(input); return; }
    await review(input);
    throw new Error("模拟复检收尾失败");
  });
  const run = begin({ reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true } });
  assert.equal(run.reviewConfig?.model, run.model);
  assert.equal(run.reviewConfig?.effort, run.effort);
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "partial");
  assert.equal(result.items[0]!.review?.status, "failed");
  assert.match(result.items[0]!.review?.error?.message ?? "", /模拟复检收尾失败/);
  assert.equal(generated, 1);
  assert.equal(reviews.list("permissions").length, 1);
});

test("复检提交会用本轮唯一已读版本修正模型抄写的截短来源指纹", async t => {
  const { service, begin, source, reviews } = fixture(t, async input => {
    input.onThreadCreated(`execution-${input.purpose ?? "generation"}`);
    if (input.purpose !== "review") {
      await generate(input);
      return;
    }
    await readDocument(input);
    const read = await accepted<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: source.path!, startLine: 1, count: 3 });
    const typo = { ...source, path: read.path, contentHash: read.contentHash.slice(0, 60) };
    const result = await tool(input, "knowledge.review.submit", reportInput(typo));
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  const run = begin();
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(result.items[0]!.review?.status, "passed");
  assert.equal(reviews.list("permissions").length, 1);
  assert.equal(reviews.list("permissions")[0]!.sources[0]!.contentHash, source.contentHash);
});

test("规格要求证据支持问题定位和报告重读，要求变化后报告失效", async t => {
  const requirement = "发布前必须人工确认适用范围。";
  const evidence: KnowledgeAssetSource = { kind: "requirement", requirement, relation: "已采用的项目要求" };
  const { service, begin, store, reviews } = fixture(t, async input => {
    await readDocument(input);
    await accepted(input, "knowledge.review.submit", {
      outcome: "passed_with_warnings", summary: "已核对明确要求，保留一条表达建议", sources: [evidence],
      issues: [{ ...issue(evidence), severity: "warning", category: "coverage", title: "可补充确认示例", detail: "核心要求已覆盖，示例可选。", suggestion: "需要时补充示例。" }],
    });
  });
  const current = store.readTree();
  store.saveTree({ schemaVersion: 3, instructions: requirement, nodes: [...knowledgeCategoryNodes(), { ...current.tree.nodes[0]!, parentId: "knowledge-specifications" }] }, current.hash);
  store.saveDocument({ nodeId: "permissions", content: "# 发布约束\n发布前必须人工确认适用范围。", sources: [evidence], expectedHash: null, origin: "manual" });
  const run = begin({ mode: "review" }); service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  const report = reviews.list("permissions")[0]!;
  assert.equal(report.stale, false);
  assert.deepEqual(report.issues[0]!.sources, [evidence]);
  const snapshot = reviews.snapshot("permissions", report.revisionId);
  assert.throws(() => reviews.save(snapshot, { ...report, sources: [{ ...evidence, requirement: "无需确认即可发布" }] }), /必须逐字引用/);
  assert.throws(() => reviews.save(snapshot, { ...report, issues: [{ ...report.issues[0]!, sources: [{ ...evidence, requirement: "适用范围" }] }] }), /必须包含在本次核对/);
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, instructions: "发布前必须人工确认安全条件。" }, tree.hash);
  assert.equal(reviews.list("permissions")[0]?.stale, true);
});

test("人工采用的规格可直接按原始用户来源复检，无须复制到目录要求", async t => {
  const evidence: KnowledgeAssetSource = { kind: "requirement", requirement: "发布前必须人工确认适用范围。", relation: "人工录入的用户要求" };
  const context = fixture(t, async input => {
    const document = await accepted<{ confirmedRequirements: string[] }>(input, "knowledge.review.read", { startLine: 1, count: 200 });
    assert.ok(document.confirmedRequirements.includes(evidence.requirement!));
    await accepted(input, "knowledge.review.submit", reportInput(evidence));
  });
  const current = context.store.readTree();
  context.store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...current.tree.nodes[0]!, parentId: "knowledge-specifications", instructions: "" }] }, current.hash);
  context.store.saveDocument({ nodeId: "permissions", content: `# 发布约束\n${evidence.requirement}`, sources: [evidence], expectedHash: null, origin: "manual" });
  const run = context.begin({ mode: "review", prompt: "仅核对原始要求" }); context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.items[0]?.review?.status, "passed", JSON.stringify(result));
  assert.equal(context.reviews.list("permissions")[0]?.stale, false);
});

test("规格连续修订两轮可通过，系统修订说明始终不能充当用户要求", async t => {
  const evidence: KnowledgeAssetSource = { kind: "requirement", requirement: "采用前必须人工确认。", relation: "本批明确用户要求" };
  let generations = 0, reviewCount = 0, rejectedSystemEvidence = 0;
  const context = fixture(t, async input => {
    const item = context.store.readRun(input.runId).items[0]!;
    const systemEvidence: KnowledgeAssetSource | null = item.repairReportId && item.repairRevisionId
      ? { kind: "requirement", requirement: knowledgeRepairInstructions(item.repairReportId, item.repairRevisionId).trim(), relation: "系统修订说明不能成为用户要求" } : null;
    if (input.purpose === "review") {
      const document = await accepted<{ confirmedRequirements: string[] }>(input, "knowledge.review.read", { startLine: 1, count: 200 });
      assert.ok(document.confirmedRequirements.some(text => text.includes(evidence.requirement!)));
      assert.ok(document.confirmedRequirements.every(text => !text.includes("knowledge.review.report.read")));
      if (systemEvidence) {
        const rejected = await tool(input, "knowledge.review.submit", reportInput(systemEvidence));
        assert.equal(rejected.ok, false);
        assert.match(JSON.stringify(rejected), /必须逐字引用/);
        rejectedSystemEvidence++;
      }
      reviewCount++;
      await accepted(input, "knowledge.review.submit", reportInput(evidence, reviewCount < 3 ? "issues" : "passed"));
      return;
    }
    generations++;
    if (item.repairReportId) await accepted(input, "knowledge.review.report.read", { nodeId: item.nodeId, reportId: item.repairReportId, offset: 0 });
    if (systemEvidence) {
      const rejected = await tool(input, "knowledge.asset.submit", { content: "# 发布约束\n系统修订说明", summary: "不能保存系统要求", sources: [systemEvidence] });
      assert.equal(rejected.ok, false);
      assert.match(JSON.stringify(rejected), /必须逐字引用/);
      rejectedSystemEvidence++;
    }
    await accepted(input, "knowledge.asset.submit", { content: `# 发布约束\n${evidence.requirement}`, summary: "保存明确要求", sources: [evidence] });
  });
  const current = context.store.readTree();
  context.store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...current.tree.nodes[0]!, parentId: "knowledge-specifications", instructions: "" }] }, current.hash);
  const run = context.begin({ prompt: evidence.requirement, reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 3 } }); context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result));
  assert.equal(result.items[0]?.review?.status, "passed");
  assert.equal(generations, 3);
  assert.equal(reviewCount, 3);
  assert.equal(rejectedSystemEvidence, 4);
  assert.equal(context.reviews.list("permissions").filter(report => !report.stale && report.outcome === "passed").length, 1);
});

test("过期修订重试保留单项要求，并在重新复检时排除历史系统说明", async t => {
  let generations = 0, reviewCount = 0;
  const generationPrompts: string[] = [];
  const context = fixture(t, async input => {
    if (input.purpose === "review") {
      const document = await accepted<{ confirmedRequirements: string[] }>(input, "knowledge.review.read", { startLine: 1, count: 200 });
      assert.ok(document.confirmedRequirements.some(text => text.includes("OVERRIDE_BETA")));
      assert.ok(document.confirmedRequirements.every(text => !text.includes("knowledge.review.report.read")));
      const source = await readSource(input);
      reviewCount++;
      await accepted(input, "knowledge.review.submit", reportInput(source, reviewCount < 4 ? "issues" : "passed"));
      return;
    }
    generations++; generationPrompts.push(input.prompt);
    if (generations === 1 || generations === 4) throw new Error("injected generation failure");
    const item = context.store.readRun(input.runId).items[0]!;
    if (item.repairReportId) await accepted(input, "knowledge.review.report.read", { nodeId: item.nodeId, reportId: item.repairReportId, offset: 0 });
    await generate(input);
  });
  const current = context.store.readTree();
  context.store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { ...current.tree.nodes[0]!, parentId: "knowledge-specifications", instructions: "" }] }, current.hash);
  const run = context.begin({ prompt: "INITIAL_ALPHA", reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 3 } }); context.service.start(run.id);
  assert.equal((await settled(context.service, run.id)).items[0]?.status, "failed");
  context.service.start(run.id, { nodeIds: ["permissions"], retryFailed: true, prompt: "OVERRIDE_BETA" });
  const failedRepair = await settled(context.service, run.id);
  assert.equal(failedRepair.items[0]?.status, "failed");
  assert.equal(reviewCount, 2);
  fs.appendFileSync(path.join(context.root, "src/permissions.ts"), "// Changed source evidence.\n");
  context.service.start(run.id, { nodeIds: ["permissions"], retryFailed: true });
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result));
  assert.equal(result.items[0]?.review?.status, "passed");
  assert.equal(context.store.readRun(run.id).prompt, "INITIAL_ALPHA");
  assert.equal(generations, 5);
  assert.equal(reviewCount, 4);
  assert.ok(generationPrompts[4]!.includes("OVERRIDE_BETA"));
  assert.equal(generationPrompts[4]!.includes("INITIAL_ALPHA"), false);
});

test("架构事实不能仅用用户要求替代源码证据", async t => {
  const { service, begin, store, source, reviews } = fixture(t, async input => {
    await readDocument(input);
    const rejected = await tool(input, "knowledge.review.submit", reportInput({ kind: "requirement", requirement: "明确写权限", relation: "项目要求" }));
    assert.equal(rejected.ok, false);
    assert.match(JSON.stringify(rejected), /规格要求证据/);
    await accepted(input, "knowledge.review.submit", reportInput(await readSource(input)));
  });
  store.saveDocument({ nodeId: "permissions", content: "# 权限\n仅 owner 可写。", sources: [source], expectedHash: null, origin: "manual" });
  const run = begin({ mode: "review" }); service.start(run.id);
  assert.equal((await settled(service, run.id)).phase, "completed");
  assert.equal(reviews.list("permissions")[0]?.sources[0]?.kind, "code");
});

test("复检提交字段无效时返回具体字段错误，不使用模糊文本错误", async t => {
  let rejected: any;
  const context = fixture(t, async input => {
    if (input.purpose !== "review") { await generate(input); return; }
    await readDocument(input);
    const source = await readSource(input);
    rejected = await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "", issues: [], sources: [source] });
  });
  const run = context.begin();
  context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(rejected?.ok, false);
  assert.equal(rejected?.message, "复检摘要不能为空");
  assert.equal(result.items[0]!.review?.status, "failed");
});

test("复检发现问题会复用原资产工作会话自动修订，再继续复检", async t => {
  const calls: KnowledgeGenerationEngineInput[] = [];
  let reviewCount = 0;
  const context = fixture(t, async input => {
    calls.push(input);
    input.onThreadCreated(input.threadId ?? `execution-${calls.length}`);
    if (input.purpose === "review") {
      reviewCount++;
      await review(input, reviewCount === 1 ? "issues" : "passed");
      return;
    }
    if (input.threadId) {
      const report = context.reviews.list("permissions")[0]!;
      await accepted(input, "knowledge.review.report.read", { nodeId: "permissions", reportId: report.id, offset: 0 });
    }
    await generate(input, input.threadId ? "# 权限\n\n已按复检问题修正。" : undefined);
  });
  const run = context.begin(); context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(reviewCount, 2);
  assert.equal(calls.filter(call => call.purpose !== "review").length, 2);
  assert.equal(calls[0]!.threadId, null);
  assert.equal(calls[2]!.threadId, "execution-1");
  assert.equal(result.items[0]!.review?.status, "passed");
  assert.equal(result.items[0]!.review?.round, 2);
  assert.equal(context.store.revisions("permissions").length, 2);
});

test("自动修订遇到持续问题最多执行 5 轮并在报告处停止", async t => {
  let generations = 0, reviewsCount = 0;
  const context = fixture(t, async input => {
    input.onThreadCreated(input.threadId ?? `execution-${input.purpose}-${generations + reviewsCount + 1}`);
    if (input.purpose === "review") { reviewsCount++; await review(input, "issues"); return; }
    if (input.threadId) {
      const report = context.reviews.list("permissions")[0]!;
      await accepted(input, "knowledge.review.report.read", { nodeId: "permissions", reportId: report.id, offset: 0 });
    }
    generations++; await generate(input);
  });
  const run = context.begin(); context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(generations, 5);
  assert.equal(reviewsCount, 5);
  assert.equal(result.items[0]!.review?.status, "issues");
  assert.equal(result.items[0]!.review?.round, 5);
  assert.equal(result.items[0]!.review?.maxRounds, 5);
  assert.equal(context.store.revisions("permissions").length, 5);
});

test("复检最大轮次按任务配置生效，达到配置值后停止自动修订", async t => {
  let generations = 0, reviewsCount = 0;
  const context = fixture(t, async input => {
    input.onThreadCreated(input.threadId ?? `execution-${input.purpose}-${generations + reviewsCount + 1}`);
    if (input.purpose === "review") { reviewsCount++; await review(input, "issues"); return; }
    if (input.threadId) {
      const report = context.reviews.list("permissions")[0]!;
      await accepted(input, "knowledge.review.report.read", { nodeId: "permissions", reportId: report.id, offset: 0 });
    }
    generations++; await generate(input);
  });
  const run = context.begin({ reviewConfig: { enabled: true, model: "review-model", effort: "high", maxRounds: 2 } });
  assert.equal(run.reviewConfig?.maxRounds, 2);
  context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(generations, 2);
  assert.equal(reviewsCount, 2);
  assert.equal(result.items[0]!.review?.round, 2);
  assert.equal(result.items[0]!.review?.maxRounds, 2);
});

test("自动修订等待期间来源变化，重试失败项会先重新复检而不复用旧报告", async t => {
  let reviewCalls = 0, generationCalls = 0;
  const context = fixture(t, async input => {
    input.onThreadCreated(input.threadId ?? `execution-${input.purpose}-${reviewCalls + generationCalls + 1}`);
    if (input.purpose === "review") { reviewCalls++; await review(input, "issues"); return; }
    generationCalls++; await generate(input);
  });
  context.store.saveDocument({ nodeId: "permissions", content: "# 权限\n\n仅 owner 可以写。", sources: [context.source], expectedHash: null, origin: "manual" });
  const run = context.begin({ strategy: "all", reviewConfig: { enabled: true, model: null, effort: null, autoRepair: false, maxRounds: 2 } });
  context.service.start(run.id);
  const first = await settled(context.service, run.id);
  const report = context.reviews.list("permissions")[0]!;
  const persisted = context.store.readRun(run.id), item = persisted.items[0]!;
  item.repairReportId = report.id; item.repairRevisionId = report.revisionId; item.status = "failed";
  item.instructions += knowledgeRepairInstructions(report.id, report.revisionId);
  item.error = { code: "KNOWLEDGE_ASSET_CONFLICT", message: "旧修订待重试" };
  item.review = { ...item.review!, status: "failed", reportId: report.id, error: item.error };
  context.store.saveRun(persisted);
  fs.appendFileSync(path.join(context.root, "src", "permissions.ts"), "\nexport const changedAfterReview = true;\n");

  context.service.start(run.id, { retryFailed: true });
  const retried = await settled(context.service, run.id);
  assert.equal(first.items[0]!.review?.status, "issues");
  assert.equal(reviewCalls, 2);
  assert.equal(generationCalls, 1, "来源变化后只重新复检，不重写已生成正文");
  assert.equal(retried.items[0]!.review?.status, "issues");
  assert.equal(retried.items[0]!.review?.stale, false);
});

test("复检不能用已有指纹或原文引用伪造本轮阅读：未读正文、未读来源均拒绝通过", async t => {
  for (const omit of ["document", "source"] as const) {
    let rejected: Awaited<ReturnType<typeof tool>> | undefined;
    const context = fixture(t, async input => {
      if (input.purpose !== "review") { await generate(input); return; }
      if (omit !== "document") await readDocument(input);
      const source = omit === "source" ? context.source : await readSource(input);
      rejected = await tool(input, "knowledge.review.submit", reportInput(source));
    });
    const run = context.begin(); context.service.start(run.id);
    const result = await settled(context.service, run.id);
    assert.equal(rejected?.ok, false);
    assert.equal(result.phase, "partial");
    assert.equal(result.items[0]!.status, "completed");
    assert.equal(result.items[0]!.review?.status, "failed");
    assert.equal(result.items[0]!.review?.error?.code, "KNOWLEDGE_ASSET_NO_SUBMISSION");
    assert.equal(context.store.revisions("permissions").length, 1);
    assert.deepEqual(context.reviews.list("permissions"), []);
  }
});

test("正文必须分页读完，读取第一页不足以提交通过；补读后本轮可以继续提交", async t => {
  let earlyRejected = false;
  const { service, begin, reviews } = fixture(t, async input => {
    if (input.purpose !== "review") { await generate(input, Array.from({ length: 503 }, (_, index) => `第 ${index + 1} 行权限说明`).join("\n")); return; }
    await accepted(input, "knowledge.review.read", { startLine: 1, count: 200 });
    const source = await readSource(input);
    earlyRejected = !(await tool(input, "knowledge.review.submit", reportInput(source))).ok;
    await accepted(input, "knowledge.review.read", { startLine: 201, count: 200 });
    await accepted(input, "knowledge.review.read", { startLine: 401, count: 200 });
    await accepted(input, "knowledge.review.submit", reportInput(source));
  });
  const run = begin(); service.start(run.id);
  assert.equal((await settled(service, run.id)).phase, "completed");
  assert.equal(earlyRejected, true);
  assert.equal(reviews.list("permissions").length, 1);
});

test("停止复检拒绝迟到结果；继续仅重新复检，已生成版本不重写", async t => {
  const entered = deferred(), gate = deferred();
  let generations = 0, reviewsCount = 0, lateAccepted: boolean | undefined;
  const { service, begin, store, reviews } = fixture(t, async input => {
    if (input.purpose !== "review") { generations++; await generate(input); return; }
    reviewsCount++; input.onThreadCreated(`review-thread-${reviewsCount}`);
    await readDocument(input); const source = await readSource(input);
    if (reviewsCount === 1) { entered.resolve(); await gate.promise; lateAccepted = (await tool(input, "knowledge.review.submit", reportInput(source))).ok; }
    else await accepted(input, "knowledge.review.submit", reportInput(source));
  });
  const run = begin(); service.start(run.id);
  try {
    await entered.promise;
    assert.equal(service.view(run.id).activeStage, "reviewing");
    service.stop(run.id); gate.resolve();
    const interrupted = await settled(service, run.id);
    assert.equal(interrupted.phase, "interrupted");
    assert.equal(interrupted.items[0]!.status, "completed");
    assert.equal(interrupted.items[0]!.review?.status, "pending");
    assert.equal(lateAccepted, false);
    assert.deepEqual(reviews.list("permissions"), []);
    const revisionId = interrupted.items[0]!.revisionId;
    service.start(run.id);
    const result = await settled(service, run.id);
    assert.equal(result.phase, "completed");
    assert.equal(result.items[0]!.revisionId, revisionId);
    assert.equal(result.items[0]!.review?.executionThreadId, "review-thread-2");
    assert.equal(generations, 1); assert.equal(reviewsCount, 2);
    assert.equal(store.revisions("permissions").length, 1);
  } finally { gate.resolve(); if (service.view(run.id).active) { service.stop(run.id); await settled(service, run.id); } }
});

test("复检执行失败只重试复检，生成结果与生成参数保持不变", async t => {
  let generations = 0, reviewCalls = 0;
  const models: Array<[string | null, string | null]> = [];
  const { service, begin, store } = fixture(t, async input => {
    if (input.purpose !== "review") { generations++; await generate(input); return; }
    models.push([input.model, input.effort]);
    reviewCalls++;
    if (reviewCalls === 1) throw new Error("模拟复检引擎失败");
    await review(input);
  });
  const run = begin({ reviewConfig: { enabled: true, model: "review-model", effort: "high" } });
  service.start(run.id);
  const failed = await settled(service, run.id);
  assert.equal(failed.phase, "partial");
  assert.equal(failed.items[0]!.review?.status, "failed");
  service.start(run.id, { retryFailed: true });
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(result.items[0]!.revisionId, failed.items[0]!.revisionId);
  assert.deepEqual(models, [["review-model", "high"], ["review-model", "high"]]);
  assert.equal(generations, 1); assert.equal(reviewCalls, 2);
  assert.equal(store.revisions("permissions").length, 1);
});

test("单独复检已有文档只执行Reviewer，不生成正文或改变当前版本", async t => {
  const purposes: string[] = [];
  const { service, begin, store, source, reviews } = fixture(t, async input => { purposes.push(input.purpose ?? "generation"); await review(input); });
  const original = store.saveDocument({ nodeId: "permissions", content: "# 权限\n仅 owner 可写。", sources: [source], expectedHash: null, origin: "manual" });
  const originalHash = store.currentHash("permissions");
  const run = begin({ mode: "review", strategy: "all" });
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed");
  assert.deepEqual(purposes, ["review"]);
  assert.equal(store.currentHash("permissions"), originalHash);
  assert.equal(store.revisions("permissions").length, 1);
  assert.equal(reviews.list("permissions")[0]!.revisionId, original.id);
});

test("单独复检发现问题后可在续跑配置中开启自动修订并继续复检", async t => {
  let reviewCalls = 0;
  let generations = 0;
  let reportId = "";
  const context = fixture(t, async input => {
    if (input.purpose === "review") {
      reviewCalls++;
      await review(input, reviewCalls === 1 ? "issues" : "passed");
      reportId = context.reviews.list("permissions")[0]!.id;
      return;
    }
    generations++;
    if (reportId) await accepted(input, "knowledge.review.report.read", { nodeId: "permissions", reportId, offset: 0 });
    await generate(input, "# 权限\n\n已按复检问题修订。");
  });
  context.store.saveDocument({ nodeId: "permissions", content: "# 权限\n\n所有角色可写。", sources: [context.source], expectedHash: null, origin: "manual" });
  const run = context.begin({ mode: "review", strategy: "all", reviewConfig: { enabled: true, model: null, effort: null, autoRepair: false, maxRounds: 2 } });
  context.service.start(run.id);
  const reported = await settled(context.service, run.id);
  assert.equal(reported.items[0]!.review?.status, "issues");
  assert.equal(generations, 0);
  context.service.start(run.id, { nodeIds: ["permissions"], reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 2 } });
  const repaired = await settled(context.service, run.id);
  assert.equal(repaired.phase, "completed");
  assert.equal(reviewCalls, 2);
  assert.equal(generations, 1);
  assert.equal(repaired.items[0]!.review?.status, "passed");
  assert.equal(context.reviews.list("permissions").length, 2);
});

test("修订任务修改要求后仍通过真实工具分页读取全部问题，已有人工正文保留待用户采用", async t => {
  let generationPrompt = "", checkingOriginal = true, reportId = "";
  const readIssues: KnowledgeReviewIssue[] = [];
  const expectedIssueIds = ["issue_owner", "issue_role", "issue_failure"];
  const { service, begin, store, source, reviews } = fixture(t, async input => {
    if (input.purpose === "review") {
      if (!checkingOriginal) { await review(input); return; }
      await readDocument(input);
      const source = await readSource(input);
      await accepted(input, "knowledge.review.submit", {
        ...reportInput(source, "issues"),
        issues: expectedIssueIds.map((id, index) => ({ ...issue(source), id, title: `角色权限错误 ${index + 1}` })),
      });
      return;
    }
    generationPrompt = input.prompt;
    assert.ok(input.registry.tools.some(tool => tool.toolId === "knowledge.review.report.read"));
    let offset: number | null = 0;
    do {
      const page: { id: string; issues: KnowledgeReviewIssue[]; nextOffset: number | null; stale: boolean } = await accepted(input, "knowledge.review.report.read", { nodeId: "permissions", reportId, offset });
      assert.equal(page.id, reportId);
      assert.equal(page.issues.length, 1, "报告问题按单项分页，不整包注入提示词");
      assert.equal(page.stale, false);
      readIssues.push(...page.issues);
      offset = page.nextOffset;
    } while (offset !== null);
    await generate(input, "# 权限\n仅 owner 可写。");
  });
  const original = store.saveDocument({ nodeId: "permissions", content: "# 权限\n所有角色都可写。", sources: [source], expectedHash: null, origin: "manual" });
  const inspection = begin({ mode: "review", strategy: "all" }); service.start(inspection.id);
  const inspected = await settled(service, inspection.id);
  assert.equal(inspected.items[0]!.review?.status, "issues");
  const report = reviews.list("permissions")[0]!;
  reportId = report.id;
  checkingOriginal = false;
  const revision = begin({ strategy: "all", repairReports: [{ nodeId: "permissions", reportId: report.id }] });
  service.start(revision.id, { nodeIds: ["permissions"], prompt: "保留现有格式并修复角色范围" });
  const repaired = await settled(service, revision.id);
  assert.equal(repaired.phase, "completed");
  assert.ok(generationPrompt.includes(report.id));
  assert.ok(generationPrompt.includes(original.id));
  assert.match(generationPrompt, /保留现有格式并修复角色范围/);
  assert.match(generationPrompt, /knowledge\.review\.report\.read/);
  assert.doesNotMatch(generationPrompt, /角色权限错误/);
  assert.deepEqual(readIssues.map(issue => issue.id), expectedIssueIds);
  assert.ok(readIssues.every(issue => issue.sources[0]!.path === "src/permissions.ts"));
  assert.equal(store.detail("permissions").current?.revision.id, original.id);
  assert.equal(store.detail("permissions").current?.content, "# 权限\n所有角色都可写。");
  assert.equal(store.detail("permissions").drafts.length, 1);
  assert.equal(repaired.items[0]!.review?.status, "passed");
  assert.equal(reviews.list("permissions").find(item => item.id === report.id)?.stale, true);
});

test("已完成项报告损坏不会阻止查看任务或停止正在执行的后续资产", async t => {
  const gate = deferred();
  let activeSignal: AbortSignal | null = null, lateAccepted: boolean | undefined;
  const { store, service, begin } = fixture(t, async input => {
    if (input.title === "第二资产" && input.purpose !== "review") {
      activeSignal = input.signal;
      await gate.promise;
      const result = await tool(input, "knowledge.asset.submit", { content: "迟到正文", summary: "停止后不写入", sources: [] });
      lateAccepted = result.ok;
      return;
    }
    if (input.purpose === "review") await review(input); else await generate(input);
  });
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: [...tree.tree.nodes, { id: "second", parentId: null, title: "第二资产", orderKey: "2", summary: "", tags: [], instructions: "说明权限", sourceScope: ["src/permissions.ts"] }] }, tree.hash);
  const run = begin({ selectedNodeIds: ["permissions", "second"] }); service.start(run.id);
  try {
    await waitUntil(() => activeSignal !== null, "第一项复检完成后应启动第二项");
    const first = store.readRun(run.id).items.find(item => item.nodeId === "permissions")!;
    assert.equal(first.review?.status, "passed");
    assert.ok(first.review?.reportId);
    store.files.write(`${store.root}/assets/permissions/reviews/${first.review.reportId}.json`, "{broken report");
    const visible = service.view(run.id);
    assert.equal(visible.active, true);
    assert.equal(visible.ownerThreadId, "knowledge-owner");
    assert.equal(visible.items[0]!.review?.stale, true);
    assert.match(visible.items[0]!.review?.staleReasons?.join(" ") ?? "", /无法读取/);
    assert.equal(service.list().find(item => item.id === run.id)?.active, true);
    assert.doesNotThrow(() => service.stop(run.id));
    assert.equal((activeSignal as AbortSignal | null)?.aborted, true);
    gate.resolve();
    const stopped = await settled(service, run.id);
    assert.equal(stopped.phase, "interrupted");
    assert.equal(lateAccepted, false);
    assert.equal(store.revisions("second").length, 0);
    assert.equal(service.list().find(item => item.id === run.id)?.items[0]!.review?.stale, true);
  } finally {
    gate.resolve();
    if (service.view(run.id).active) { service.stop(run.id); await settled(service, run.id); }
  }
});

test("结果页任务摘要不读取全部复检报告，单个任务详情仍保留完整核验", async t => {
  const { store, service, begin } = fixture(t, async input => {
    if (input.purpose === "review") await review(input);
    else await generate(input);
  });
  const run = begin();
  service.start(run.id);
  await settled(service, run.id);
  const item = store.readRun(run.id).items[0]!;
  assert.ok(item.review?.reportId);
  const reportPath = path.join(store.files.root, store.root, "assets", item.nodeId, "reviews", `${item.review!.reportId}.json`);
  fs.writeFileSync(reportPath, "{broken report");

  // 结果页只读 plan.json 中的持久化状态，不被损坏的复检文件阻塞。
  assert.doesNotThrow(() => service.list({ hydrateReviews: false }));
  // 打开单个任务仍执行完整复检核验，并明确标记报告不可用。
  const detail = service.view(run.id);
  assert.equal(detail.items[0]!.review?.stale, true);
  assert.match(detail.items[0]!.review?.staleReasons?.join(" ") ?? "", /无法读取/);
});

test("显式续跑已通过但过期的报告只重新复检，默认继续不重复检查完成项", async t => {
  let generated = 0, reviewed = 0;
  const f = fixture(t, async input => {
    if (input.purpose !== "review") { generated++; await generate(input); return; }
    reviewed++;
    await readDocument(input);
    const source = await readSource(input);
    const extra = await accepted<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: "src/extra.ts", count: 1 });
    await accepted(input, "knowledge.review.submit", { ...reportInput(source), sources: [source, { kind: "code", ...extra, startLine: 1, endLine: 1, relation: "交叉核对" }] });
  });
  const tree = f.store.readTree();
  f.store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(node => ({ ...node, sourceScope: ["src"] })) }, tree.hash);
  fs.writeFileSync(path.join(f.root, "src/extra.ts"), "export const extra = true;\n", "utf8");
  const run = f.begin(); f.service.start(run.id);
  const first = await settled(f.service, run.id), original = first.items[0]!;
  fs.appendFileSync(path.join(f.root, "src/extra.ts"), "// 相关来源已变化\n", "utf8");
  assert.equal(f.service.view(run.id).items[0]!.review?.stale, true);
  f.service.start(run.id); await settled(f.service, run.id);
  assert.equal(reviewed, 1, "默认继续不扫描已完成项");
  f.service.start(run.id, { nodeIds: ["permissions"] });
  const latest = (await settled(f.service, run.id)).items[0]!;
  assert.equal(generated, 1);
  assert.equal(reviewed, 2);
  assert.equal(latest.revisionId, original.revisionId);
  assert.notEqual(latest.review?.reportId, original.review?.reportId);
  assert.equal(latest.review?.stale, false);
  assert.equal(latest.review?.status, "passed");
  assert.equal(f.service.preview(run.id).items[0]?.canApply, true);
});

test("多个工作区的生成和复检共用两个并发名额，取消排队项不会创建执行会话", async t => {
  const gate = deferred();
  let running = 0, maximum = 0;
  const entered: string[] = [];
  const executor = (label: string): KnowledgeGenerationExecutor => async input => {
    entered.push(label); running++; maximum = Math.max(maximum, running);
    input.onThreadCreated(`execution-${label}`);
    try {
      await gate.promise;
      if (input.purpose === "review") await review(input); else await generate(input);
    } finally { running--; }
  };
  const a = fixture(t, executor("review")), b = fixture(t, executor("generation")), c = fixture(t, executor("queued"));
  a.store.saveDocument({ nodeId: "permissions", content: "# 权限\n仅 owner 可写。", sources: [a.source], expectedHash: null, origin: "manual" });
  const ra = a.begin({ mode: "review" }), rb = b.begin({ reviewConfig: { enabled: false, model: null, effort: null } }), rc = c.begin({ reviewConfig: { enabled: false, model: null, effort: null } });
  a.service.start(ra.id); b.service.start(rb.id);
  try {
    await waitUntil(() => entered.length === 2, "前两个任务应先占用并发名额");
    c.service.start(rc.id);
    await waitUntil(() => entered.length === 2 && c.service.view(rc.id).activeStage === "queued", "第三个任务应在Client共享队列等待");
    assert.deepEqual(entered.sort(), ["generation", "review"]);
    assert.deepEqual(c.service.view(rc.id).scheduler, { limit: 2, running: 2, queued: 1 });
    assert.equal(c.service.view(rc.id).items[0]!.executionThreadId, null);
    c.service.stop(rc.id);
    assert.equal((await settled(c.service, rc.id)).phase, "interrupted");
    assert.equal(entered.includes("queued"), false);
    gate.resolve();
    assert.equal((await settled(a.service, ra.id)).phase, "completed");
    assert.equal((await settled(b.service, rb.id)).phase, "completed");
    assert.equal(maximum, 2);
    assert.equal(entered.includes("queued"), false);
    assert.equal(c.store.revisions("permissions").length, 0);
  } finally {
    gate.resolve();
    for (const [context, run] of [[a, ra], [b, rb], [c, rc]] as const) if (context.service.view(run.id).active) { context.service.stop(run.id); await settled(context.service, run.id); }
  }
});

test("待执行复检的文档已有新版本时不启动无效引擎会话，要求重新确认范围", async t => {
  let executions = 0;
  const { service, begin, store, source } = fixture(t, async () => { executions++; });
  store.saveDocument({ nodeId: "permissions", content: "原版本", sources: [source], expectedHash: null, origin: "manual" });
  const run = begin({ mode: "review", strategy: "all" });
  store.saveDocument({ nodeId: "permissions", content: "已修改的版本", sources: [source], expectedHash: store.currentHash("permissions"), origin: "manual", adopt: true });
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(executions, 0);
  assert.equal(result.items[0]?.review?.status, "failed");
  assert.match(result.items[0]?.review?.error?.message ?? "", /版本已变化/);
});

test("超长单行截断不算完整阅读，不能靠截断正文或源码提交通过", async t => {
  for (const truncated of ["document", "source"] as const) {
    let submitted = false;
    const context = fixture(t, async input => {
      if (input.purpose !== "review") { await generate(input, truncated === "document" ? "x".repeat(61000) : "# 权限\n仅 owner 可写。"); return; }
      const document = await tool(input, "knowledge.review.read", { startLine: 1, count: 500 });
      const sourceRead = await tool(input, "knowledge.source.read", { path: "src/permissions.ts", startLine: 1, count: 500 });
      // 允许工具明确拒绝超长内容；不能返回一个可被当作读完的截断结果。
      if (document.ok && sourceRead.ok) submitted = (await tool(input, "knowledge.review.submit", reportInput({ ...context.source, startLine: 1, endLine: truncated === "source" ? 1 : 3 }))).ok;
    });
    if (truncated === "source") {
      fs.writeFileSync(path.join(context.root, "src", "permissions.ts"), `export const rule = '${"x".repeat(61000)}';`);
      context.source.contentHash = context.store.readSource("src/permissions.ts").contentHash;
      context.source.startLine = 1; context.source.endLine = 1;
      // 为此用例预置一个带真实源码指纹的文档，只验证独立复检读取边界。
      context.store.saveDocument({ nodeId: "permissions", content: "# 权限\n仅 owner 可写。", sources: [context.source], expectedHash: null, origin: "manual" });
    }
    const run = context.begin(truncated === "source" ? { mode: "review" } : {}); context.service.start(run.id);
    const result = await settled(context.service, run.id);
    assert.equal(submitted, false, `${truncated} 截断时不应通过复检`);
    assert.equal(result.items[0]!.review?.status, "failed");
    assert.deepEqual(context.reviews.list("permissions"), []);
  }
});


test("review.read returns a terminal response for an out-of-range page after the document was read", async t => {
  let outOfRange: any;
  const context = fixture(t, async input => {
    if (input.purpose !== "review") { await generate(input); return; }
    await readDocument(input);
    outOfRange = await tool(input, "knowledge.review.read", { startLine: 201, count: 200 });
    assert.equal(outOfRange.ok, true, JSON.stringify(outOfRange));
    assert.equal(outOfRange.output.nextLine, null);
    await review(input);
  });
  const run = context.begin();
  context.service.start(run.id);
  const result = await settled(context.service, run.id);
  assert.equal(result.phase, "completed");
  assert.equal(result.items[0]!.review?.status, "passed");
});
