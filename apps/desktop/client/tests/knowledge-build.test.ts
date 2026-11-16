import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KNOWLEDGE_ARCHITECTURE_DOCUMENTS, KNOWLEDGE_SPECIFICATION_DOCUMENTS, type KnowledgeAssetNode, type KnowledgeAssetSource, type KnowledgeGenerationPreview } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes, withKnowledgeDocumentDefaults } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import type { KnowledgeGenerationEngineInput, KnowledgeGenerationExecutor } from "../src/knowledge/knowledgeGenerationEngine.js";
import { KNOWLEDGE_ARCHITECTURE_POLICY, KNOWLEDGE_SOURCE_DISCOVERY_RULE, KNOWLEDGE_SPECIFICATION_POLICY } from "../src/knowledge/knowledgeAssetTools.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import { openClientDb } from "../src/db/clientDb.js";
import { connectKnowledgeConversation, createKnowledgeConversation, createKnowledgeConversationTurn, endKnowledgeConversation } from "../src/knowledge/knowledgeConversationService.js";

/** 默认构建夹具沿用标准文档名，自定义专题由具体用例显式声明。 */
function node(id: string, contentMode: KnowledgeAssetNode["contentMode"] = "generated", parentId: string | null = "knowledge-architecture"): KnowledgeAssetNode {
  const title = ({ a: "架构总览", b: "核心流程", original: "关键机制", ref: "关键机制" } as Record<string, string>)[id] ?? id;
  return { id, parentId, title, orderKey: id, summary: "", instructions: "", tags: [], sourceScope: ["src"], contentMode };
}
const architectureGaps = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map(document => `${document.title}：测试项目仅提供单个权限常量，缺少本专题的充分资料。`);
/** 测试使用真实项目文件和服务，只替换模型返回，不改实际工作区。 */
function fixture(t: test.TestContext, executor?: KnowledgeGenerationExecutor, empty = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-build-"));
  const beforeCleanup: Array<() => void> = [];
  const generationDb = openClientDb({ dbPath: path.join(root, "generation.db") });
  generationDb.workspaces.upsert({ id: "build-ws" as any, title: "规划", path: root });
  beforeCleanup.push(() => generationDb.close());
  t.after(() => { for (const close of beforeCleanup) close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (!empty) {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const allowed = true;\n", "utf8");
  }
  const store = new KnowledgeAssetStore(root);
  const saveTree = store.saveTree.bind(store);
  // 测试项目沿用同一三类根，模型只提交业务专题，避免把旧目录模板当作产品默认行为。
  store.saveTree = (value, expectedHash) => {
    const tree = value as { schemaVersion: number; nodes: KnowledgeAssetNode[] };
    return saveTree({ ...tree, schemaVersion: 3, nodes: [...new Map([...knowledgeCategoryNodes(), ...tree.nodes].map(node => [node.id, node])).values()] }, expectedHash);
  };
  let enabled = true;
  const service = new KnowledgeGenerationService(store, "build-ws", executor ?? (async () => {}), "build-request", () => {
    if (!enabled) throw new Error("权限已撤销");
    return { nodeId: null, activationVersion: 1 };
  }, generationDb);
  const begin = (extra: Partial<Parameters<typeof service.begin>[0]> = {}) => service.begin({ requestId: crypto.randomUUID(), mode: "build", ownerThreadId: "project-owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null }, ...extra });
  return { root, store, service, begin, beforeCleanup, revoke: () => { enabled = false; } };
}
/** 所有模型工具结果必须真实成功，避免测试把失败提交当成完整生成。 */
async function tool<T>(input: KnowledgeGenerationEngineInput, toolId: string, toolInput: unknown = {}): Promise<T> {
  const result = await input.execute({ toolId, toolInput, accessMode: "read-only" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.output as T;
}
async function source(input: KnowledgeGenerationEngineInput): Promise<KnowledgeAssetSource> {
  const read = await tool<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: "src/a.ts", count: 1 });
  return { kind: "code", ...read, startLine: 1, endLine: 1, relation: "权限实现" };
}
/** 规划与正文各自重新读取证据，复检保持独立上下文。 */
function engine(nodes: KnowledgeAssetNode[], generateIds = nodes.filter(node => node.contentMode === "generated").map(node => node.id)): KnowledgeGenerationExecutor {
  return async input => {
    const evidence = await source(input);
    if (input.purpose === "planning") await tool(input, "knowledge.plan.submit", { nodes, generateNodeIds: generateIds, decisions: generateIds.map(nodeId => ({ nodeId, question: "谁可以写入", whyGenerate: "跨模块边界需要归纳", sources: [evidence] })), rationale: "仅沉淀关键机制", gaps: architectureGaps.filter(gap => !nodes.some(node => gap.startsWith(`${node.title}：`))) });
    else if (input.purpose === "review") {
      await tool(input, "knowledge.review.read", { startLine: 1, count: 200 });
      await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对", sources: [evidence], issues: [] });
    } else await tool(input, "knowledge.asset.submit", { content: "# 权限\n允许写入。", summary: "关键机制", sources: [evidence] });
  };
}
async function settle(service: KnowledgeGenerationService, id: string) {
  const deadline = Date.now() + 8000;
  while (service.view(id).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const result = service.view(id);
  assert.equal(result.active, false);
  return result;
}
const adoption = (preview: KnowledgeGenerationPreview, nodeIds = preview.items.filter(item => item.canApply).map(item => item.nodeId), requestId = crypto.randomUUID()) => ({ requestId, treeHash: preview.treeHash, planHash: preview.planHash, selections: preview.items.filter(item => nodeIds.includes(item.nodeId)).map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });

test("空项目无需模型，空输出保持正式库未初始化", async t => {
  let calls = 0;
  const { service, store, begin } = fixture(t, async () => { calls++; }, true);
  const run = begin(); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  assert.equal(calls, 0);
  assert.deepEqual(service.preview(run.id).items, []);
  assert.equal(store.snapshot().initialized, false);
  assert.deepEqual(store.snapshot().tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes);
  assert.deepEqual(service.view(run.id).proposedTree!.nodes, store.snapshot().tree.nodes);
});

test("默认空分类可直接构建引用，规格和产品选区不生成架构正文且采用前不发布", async t => {
  for (const parentId of ["knowledge-specifications", "knowledge-product"]) {
    const { root, store, service, begin } = fixture(t, async input => {
      assert.equal(input.purpose, "planning");
      const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "GUIDE.md" });
      const directory = { ...node("documents", "directory", parentId), sourceScope: [] };
      const reference = { ...node("guide", "reference", "documents"), sourceScope: ["GUIDE.md"], reference: { path: "GUIDE.md", adoptedContentHash: read.contentHash } };
      await tool(input, "knowledge.plan.submit", { nodes: [directory, reference], generateNodeIds: [], decisions: [], rationale: "引用已确认资料", gaps: [] });
    });
    fs.writeFileSync(path.join(root, "GUIDE.md"), "# 项目约定\n修改应遵循现有接口。\n", "utf8");
    const run = begin({ selectedNodeIds: [parentId] }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(store.readTree().tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes);
    assert.equal(store.readTree().hash, null);
    assert.equal(store.files.exists(`${store.root}/tree.json`), false);
    const preview = service.preview(run.id);
    assert.ok(preview.items.some(item => item.nodeId === "guide" && item.canApply));
    service.apply(run.id, adoption(preview));
    assert.equal(store.category("guide"), parentId === "knowledge-specifications" ? "specifications" : "product");
    assert.equal(store.detail("guide").reference?.path, "GUIDE.md");
    assert.deepEqual(store.revisions("guide"), []);
  }
});

test("分类规划拒绝新建越界节点、借用已有ID和移出本类的目录", async t => {
  const { store, service, begin } = fixture(t, async input => {
    assert.equal(input.purpose, "planning");
    const evidence = await source(input);
    const reference = { ...node("new-reference", "reference", "knowledge-specifications"), reference: { path: evidence.path!, adoptedContentHash: evidence.contentHash! } };
    const plan = { nodes: [reference], generateNodeIds: [], decisions: [], rationale: "仅补充规格", gaps: [] };
    for (const nodes of [
      [{ ...reference, parentId: "knowledge-product" }],
      [{ ...reference, id: "outside", parentId: "knowledge-specifications", contentMode: "generated", reference: undefined }],
      [{ ...store.node("spec-directory"), parentId: "knowledge-product" }],
    ]) {
      const rejected = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { ...plan, nodes }, accessMode: "read-only" });
      assert.equal(rejected.ok, false);
      assert.match(JSON.stringify(rejected), /局部更新不能新增或修改选区外节点/);
    }
    const generated = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { ...plan, nodes: [], generateNodeIds: ["outside"], decisions: [{ nodeId: "outside", question: "架构职责是什么", whyGenerate: "越界尝试", sources: [evidence] }] }, accessMode: "read-only" });
    assert.equal(generated.ok, false);
    assert.match(JSON.stringify(generated), /生成节点超出局部任务范围/);
    await tool(input, "knowledge.plan.submit", plan);
  });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("spec-directory", "directory", "knowledge-specifications"), { ...node("outside"), title: "架构总览" }] }, null);
  const before = store.readTree();
  const run = begin({ selectedNodeIds: ["knowledge-specifications"] }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(store.readTree(), before);
  assert.equal(result.proposedTree!.nodes.find(node => node.id === "outside")?.parentId, "knowledge-architecture");
  assert.equal(result.proposedTree!.nodes.find(node => node.id === "spec-directory")?.parentId, "knowledge-specifications");
});

test("默认规格目录支持从明确长期要求生成正文，空来源不会误跳过", async t => {
  const requirement = "长期要求：修改接口必须保持兼容。";
  const evidence = { kind: "requirement", requirement, relation: "用户已确认的长期要求" };
  const phases: string[] = [];
  const { store, service, begin } = fixture(t, async input => {
    phases.push(input.purpose ?? "generation");
    if (input.purpose === "planning") await tool(input, "knowledge.plan.submit", {
      nodes: [{ ...node("compatibility", "generated", "knowledge-specifications"), sourceScope: [], instructions: requirement }],
      generateNodeIds: ["compatibility"], decisions: [{ nodeId: "compatibility", question: "接口修改遵守什么约束", whyGenerate: "用户明确要求且原文未覆盖", sources: [evidence] }], rationale: "保留明确长期要求", gaps: [],
    });
    else await tool(input, "knowledge.asset.submit", { content: `# 接口兼容约束\n${requirement}`, summary: "已确认的接口约束", sources: [evidence] });
  }, true);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...knowledgeCategoryNodes()[0]!, instructions: requirement }] }, null);
  const run = begin({ selectedNodeIds: ["knowledge-specifications"] }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(phases, ["planning", "generation"]);
  assert.equal(result.items[0]?.nodeId, "compatibility");
  assert.equal(store.rules().rules.length, 0);
  service.apply(run.id, adoption(service.preview(run.id)));
  assert.match(store.rules().rules[0]!.content, /修改接口必须保持兼容/);
});

test("空项目有普通生成提示但没有长期要求时可明确无需新增", async t => {
  const { service, begin } = fixture(t, async input => {
    assert.equal(input.purpose, "planning");
    await tool(input, "knowledge.plan.submit", { nodes: [], generateNodeIds: [], decisions: [], rationale: "项目无文本资料，用户也未提供长期要求", gaps: [] });
  }, true);
  const run = begin({ prompt: "请按默认策略判断是否需要构建知识" }); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
});

test("八份默认规格沿用内置名称和职责，明确要求生成后独立复检并集中采用", async t => {
  assert.deepEqual(KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => document.title), ["项目约定", "编码规范", "界面规范", "接口规范", "数据规范", "业务约束", "安全规范", "交付规范"]);
  const requirements = ["新增依赖前必须确认必要性。", "异步错误必须向调用方显式返回。", "空态与加载态必须保持相同的外层高度。", "接口参数必须在边界校验。", "涉及金额的写入必须使用事务。", "同一订单不得重复结算。", "日志禁止记录访问令牌。", "交付前必须验证实际变更范围。"];
  for (const selectedNodeIds of [[], ["knowledge-specifications"]]) {
    const documents = KNOWLEDGE_SPECIFICATION_DOCUMENTS.map((definition, index) => ({
      ...node(definition.id, "generated", "knowledge-specifications"), title: definition.title, summary: definition.summary, sourceScope: [], instructions: requirements[index]!,
    }));
    const evidence = requirements.map(requirement => ({ kind: "requirement" as const, requirement, relation: "用户确认的长期项目要求" }));
    const phases: string[] = [];
    const { store, service, begin } = fixture(t, async input => {
      phases.push(input.purpose ?? "generation");
      assert.ok(input.instructions.includes(input.purpose === "review" ? "规格" : KNOWLEDGE_SPECIFICATION_POLICY));
      if (input.purpose === "planning") {
        for (const document of documents) assert.ok(input.prompt.includes(JSON.stringify({ id: document.id, parentId: document.parentId, title: document.title })), "规划应直接获得已有默认文档身份，不能自行另造 ID");
        if (selectedNodeIds.length) assert.equal(input.prompt.includes('"id":"knowledge-architecture-overview"'), false, "选区外节点不进入规划身份清单");
        for (const definition of KNOWLEDGE_SPECIFICATION_DOCUMENTS) assert.ok(input.instructions.includes(`${definition.title}（${definition.summary}）`));
        await tool(input, "knowledge.plan.submit", { nodes: documents, generateNodeIds: documents.map(node => node.id), decisions: documents.map((node, index) => ({ nodeId: node.id, question: node.summary, whyGenerate: "用户明确要求长期保存，项目没有对应原文", sources: [evidence[index]] })), rationale: "按默认职责分别保存已确认要求，其他分类无资料", gaps: [] });
      } else {
        const index = documents.findIndex(document => document.title === input.title);
        assert.ok(index >= 0);
        if (input.purpose === "review") {
          await tool(input, "knowledge.review.read");
          await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对确认要求及适用范围", sources: [evidence[index]], issues: [] });
        } else {
          assert.ok(input.prompt.includes(documents[index]!.summary), "每个独立生成任务使用本篇内置职责");
          assert.match(input.prompt, /不把职责示例当作项目已有规则/);
          await tool(input, "knowledge.asset.submit", { content: `# ${input.title}\n${requirements[index]}`, summary: "已确认的项目要求", sources: [evidence[index]] });
        }
      }
    }, true);
    const run = begin({ selectedNodeIds, prompt: `将以下项目约束长期保存：\n${requirements.join("\n")}`, reviewConfig: undefined }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items.map(item => item.title), KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => document.title));
    assert.equal(phases.filter(phase => phase === "planning").length, 1);
    assert.equal(phases.filter(phase => phase === "generation").length, 8);
    assert.equal(phases.filter(phase => phase === "review").length, 8);
    assert.ok(result.items.every(item => item.review?.status === "passed"));
    assert.equal(store.rules().rules.length, 0);
    assert.equal(store.readTree().hash, null);
    service.apply(run.id, adoption(service.preview(run.id)));
    assert.deepEqual(store.rules().rules.map(rule => rule.title).sort(), KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => document.title).sort());
    assert.equal(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-architecture").length, 3);
    assert.ok(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-architecture").every(node => store.currentHash(node.id) === null));
  }
});

test("界面规范可规划集中视觉来源，生成与复检分别核对明暗主题且采用后才生效", async t => {
  const definition = KNOWLEDGE_SPECIFICATION_DOCUMENTS.find(document => document.id === "knowledge-spec-ui")!;
  const ui = { ...node(definition.id, "generated", "knowledge-specifications"), title: definition.title, summary: definition.summary, sourceScope: ["src/tokens.css"] };
  const phases: string[] = [];
  const { root, store, service, begin } = fixture(t, async input => {
    phases.push(input.purpose ?? "generation");
    if (input.purpose === "review") await tool(input, "knowledge.review.read");
    else assert.match(input.instructions, /既有视觉基线/);
    const read = await tool<{ contentHash: string; content: string }>(input, "knowledge.source.read", { path: "src/tokens.css", count: 2 });
    assert.match(read.content, /--app-accent/);
    const evidence = { kind: "code", path: "src/tokens.css", contentHash: read.contentHash, startLine: 1, endLine: 2, relation: "集中定义的明暗主题主色" };
    if (input.purpose === "planning") {
      assert.match(input.instructions, /配色与明暗主题/);
      await tool(input, "knowledge.plan.submit", { nodes: [ui], generateNodeIds: [ui.id],
        decisions: [{ nodeId: ui.id, question: "现有明暗主题的主色从哪里复用", whyGenerate: "补充已核验的集中视觉基线", sources: [evidence] }], rationale: "界面规范补充主题入口", gaps: [] });
    } else if (input.purpose === "review") {
      assert.match(input.instructions, /集中主题与设计令牌/);
      await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核验明暗主色及集中入口", sources: [evidence], issues: [] });
    } else {
      assert.match(input.prompt, /配色与明暗主题/);
      await tool(input, "knowledge.asset.submit", { content: "# 界面规范\n\n现有视觉基线：明暗主题主色由 src/tokens.css 的 --app-accent 集中定义。", summary: "明确主题主色的集中复用入口", sources: [evidence] });
    }
  });
  fs.writeFileSync(path.join(root, "src", "tokens.css"), ':root { --app-accent: #c96442; }\n:root[data-theme="dark"] { --app-accent: #d97757; }\n', "utf8");
  const run = begin({ selectedNodeIds: ["knowledge-specifications"], reviewConfig: undefined });
  service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
  assert.deepEqual(phases, ["planning", "generation", "review"]);
  assert.equal(result.items[0]!.review?.status, "passed");
  assert.equal(store.rules().rules.length, 0);
  service.apply(run.id, adoption(service.preview(run.id)));
  assert.deepEqual(store.node(ui.id).sourceScope, ["src/tokens.css"]);
  assert.match(store.detail(ui.id).current!.content, /现有视觉基线/);
  assert.equal(new KnowledgeReviewStore(store).list(ui.id)[0]!.stale, false);
});

test("同一权威原文按八份默认规格分别提取，独立核验来源且采用后才加载规则", async t => {
  const rules = ["新增依赖先确认。", "错误必须显式返回。", "空态保持内容区域高度。", "接口说明不得歧义。", "数据库迁移必须可追踪。", "订单不得重复结算。", "日志不得记录令牌。", "修改后执行相关验证。"];
  const documents = KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => ({ ...node(document.id, "generated", "knowledge-specifications"), title: document.title, sourceScope: ["AGENTS.md"] }));
  const { root, store, service, begin } = fixture(t, async input => {
    const index = documents.findIndex(document => document.title === input.title);
    if (input.purpose === "review") await tool(input, "knowledge.review.read");
    const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "AGENTS.md", startLine: index < 0 ? 1 : index + 1, count: index < 0 ? 8 : 1 });
    const evidence = (line: number) => ({ kind: "document", path: "AGENTS.md", contentHash: read.contentHash, startLine: line, endLine: line, relation: "本主题已确认规则" });
    if (input.purpose === "planning") {
      assert.match(input.instructions, /同一来源可以支撑多份文档/);
      await tool(input, "knowledge.plan.submit", { nodes: documents, generateNodeIds: documents.map(node => node.id),
        decisions: documents.map((node, index) => ({ nodeId: node.id, question: "本主题要遵守什么规则", whyGenerate: "从混合规范按职责提取，避免全文重复", sources: [evidence(index + 1)] })), rationale: "一份原文按职责提取为八份文档", gaps: architectureGaps });
    } else if (input.purpose === "review") await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对本篇规则与原文对应行", sources: [evidence(index + 1)], issues: [] });
    else await tool(input, "knowledge.asset.submit", { content: `# ${input.title}\n${rules[index]}`, summary: "本主题已确认规则", sources: [evidence(index + 1)] });
  });
  fs.writeFileSync(path.join(root, "AGENTS.md"), rules.join("\n"), "utf8");
  const run = begin({ selectedNodeIds: ["knowledge-specifications"], reviewConfig: undefined }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.equal(result.items.length, 8);
  assert.ok(result.items.every(item => item.review?.status === "passed"));
  assert.equal(result.proposedTree!.nodes.filter(node => node.parentId === "knowledge-specifications").length, 8);
  assert.equal(store.rules().rules.length, 0);
  service.apply(run.id, adoption(service.preview(run.id)));
  assert.deepEqual(documents.map(document => store.rules().rules.find(rule => rule.nodeId === document.id)?.content.split("\n")[1]), rules);
  for (const document of documents) assert.equal(store.detail(document.id).current!.sources[0]!.path, "AGENTS.md");
});

test("八份规格均可从代码和文档提取，旧AGENTS候选来源不阻断生成、复检与采用", async t => {
  const baselines = [
    ["package.json", '{"packageManager":"pnpm@10.0.0"}', "项目使用pnpm管理工作区依赖。"],
    ["src/errors.ts", "export function fail() { throw new Error('invalid'); }", "错误入口显式抛出失败。"],
    ["src/theme.css", ":root { --accent: #c96442; }", "主色从集中主题入口复用。"],
    ["src/api.ts", "export const response = { ok: true, data: {} };", "接口使用ok和data表达成功结果。"],
    ["src/schema.sql", "CREATE TABLE orders (id TEXT PRIMARY KEY);", "订单标识使用主键保证唯一。"],
    ["src/orders.ts", "export const transitions = { pending: ['paid'], paid: [] };", "已支付订单不能再次支付。"],
    ["src/security.ts", "export const redactedFields = ['token'];", "令牌字段在日志边界脱敏。"],
    ["scripts/check.mjs", "process.exitCode = 1;", "校验失败使用非零退出码。"],
  ];
  for (const mode of ["build", "batch"] as const) {
    const documents = KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => ({ ...node(document.id, "generated", "knowledge-specifications"), title: document.title, sourceScope: ["AGENTS.md"] }));
    const verified: string[] = [];
    const { root, store, service, begin } = fixture(t, async input => {
      assert.match(input.instructions, /不能限定只读AGENTS\.md/);
      if (input.purpose === "planning") {
        const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "docs/baselines.md", count: 8 });
        await tool(input, "knowledge.plan.submit", { nodes: documents, generateNodeIds: documents.map(document => document.id),
          decisions: documents.map((document, index) => ({ nodeId: document.id, question: "本专题有哪些稳定约束", whyGenerate: "结合代码和现行文档提取实现基线", sources: [{ kind: "document", path: "docs/baselines.md", contentHash: read.contentHash, startLine: index + 1, endLine: index + 1, relation: "专题基线说明" }] })), rationale: "按各篇职责提取项目规格", gaps: [] });
        return;
      }
      const index = documents.findIndex(document => document.title === input.title);
      const [sourcePath, , description] = baselines[index]!;
      if (input.purpose === "review") await tool(input, "knowledge.review.read");
      else {
        assert.match(input.prompt, /稳定实现基线/);
        if (mode === "build") assert.ok(input.prompt.includes("docs/baselines.md"), "规划线索不能被旧sourceScope过滤");
      }
      await tool(input, "knowledge.source.list");
      const code = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: sourcePath, count: 1 });
      const document = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "docs/baselines.md", startLine: index + 1, count: 1 });
      const sources = [
        { kind: "code", path: sourcePath, contentHash: code.contentHash, startLine: 1, endLine: 1, relation: "实际实现入口" },
        { kind: "document", path: "docs/baselines.md", contentHash: document.contentHash, startLine: index + 1, endLine: index + 1, relation: "现行文档对应说明" },
      ];
      verified.push(`${input.purpose ?? "generation"}:${input.title}`);
      if (input.purpose === "review") await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已独立核对文档与实现基线", sources, issues: [] });
      else await tool(input, "knowledge.asset.submit", { content: `# ${input.title}\n实现基线：${description}\n适用范围及复用入口：${sourcePath}`, summary: "有直接证据的项目基线", sources });
    });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "所有专题按直接证据核对。", "utf8");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs/baselines.md"), baselines.map(([, , description]) => description).join("\n"), "utf8");
    for (const [relative, content] of baselines) {
      fs.mkdirSync(path.dirname(path.join(root, relative!)), { recursive: true });
      fs.writeFileSync(path.join(root, relative!), content!, "utf8");
    }
    if (mode === "batch") store.saveTree({ schemaVersion: 3, instructions: "", nodes: documents }, null);
    const run = begin({ mode, selectedNodeIds: ["knowledge-specifications"], reviewConfig: undefined }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
    assert.equal(verified.length, 16);
    assert.ok(result.items.every(item => item.review?.status === "passed"));
    assert.equal(store.rules().rules.length, 0);
    service.apply(run.id, adoption(service.preview(run.id)));
    for (const [index, document] of documents.entries()) {
      assert.deepEqual(store.node(document.id).sourceScope, ["AGENTS.md"]);
      assert.deepEqual(store.detail(document.id).current!.sources.map(source => source.path), [baselines[index]![0], "docs/baselines.md"]);
      assert.equal(new KnowledgeReviewStore(store).list(document.id)[0]!.stale, false);
    }
  }
});

test("Codex、Claude、DeepSeek和GLM使用相同来源策略，可交叉读取其他工具规则且保留局部条件", async t => {
  const configurations = [
    { engine: "codex", model: null, entry: "CLAUDE.md" },
    { engine: "claude", model: null, entry: "AGENTS.md" },
    { engine: "claude", model: "deepseek-v4-pro", entry: ".claude/CLAUDE.md" },
    { engine: "claude", model: "glm-5.3", entry: "CLAUDE.md" },
  ] as const;
  for (const config of configurations) {
    const phases: string[] = [];
    const definition = KNOWLEDGE_SPECIFICATION_DOCUMENTS.find(document => document.id === "knowledge-spec-coding")!;
    const document = { ...node(definition.id, "generated", "knowledge-specifications"), title: definition.title, sourceScope: [config.entry], appliesTo: ["src"] };
    const content = "# 编码规范\n\n修改src内代码时，错误必须显式返回。\n使用Claude兼容工具修改src时，沿用模块既有格式。";
    const { root, store, service, begin } = fixture(t, async input => {
      phases.push(input.purpose ?? "generation");
      assert.equal(input.engine, config.engine);
      assert.equal(input.model, config.model);
      assert.ok(input.instructions.includes(KNOWLEDGE_SOURCE_DISCOVERY_RULE));
      if (input.purpose === "review") await tool(input, "knowledge.review.read");
      const rootListing = await tool<{ entries: Array<{ path: string }> }>(input, "knowledge.source.list");
      assert.equal(rootListing.entries.some(entry => entry.path === "AGENTS.md"), config.entry === "AGENTS.md");
      for (const directory of [".claude", ".claude/rules", "src"]) await tool(input, "knowledge.source.list", { directory });
      const sources: KnowledgeAssetSource[] = [];
      for (const sourcePath of [config.entry, ".claude/rules/module.md"]) {
        const read = await tool<{ path: string; contentHash: string; startLine: number; endLine: number }>(input, "knowledge.source.read", { path: sourcePath });
        sources.push({ kind: "document", path: read.path, contentHash: read.contentHash, startLine: read.startLine, endLine: read.endLine, relation: "项目规则及工具专属适用条件" });
      }
      sources.push(await source(input));
      if (input.purpose === "planning") await tool(input, "knowledge.plan.submit", { nodes: [document], generateNodeIds: [document.id],
        decisions: [{ nodeId: document.id, question: "模块错误处理和工具规则有什么约束", whyGenerate: "结合现有实现和分散规则保存适用条件", sources }], rationale: "规则来源不依赖本轮引擎和模型", gaps: [] });
      else if (input.purpose === "review") await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对共享要求和工具专属条件", sources, issues: [] });
      else await tool(input, "knowledge.asset.submit", { content, summary: "src编码要求及工具条件", sources });
    });
    fs.mkdirSync(path.join(root, ".claude/rules"), { recursive: true });
    fs.writeFileSync(path.join(root, config.entry), "# 项目规则\n修改src内代码时，错误必须显式返回。\n补充规则见 .claude/rules/module.md。", "utf8");
    fs.writeFileSync(path.join(root, ".claude/rules/module.md"), "---\npaths: src/**\n---\n使用Claude兼容工具修改src时，沿用模块既有格式。", "utf8");
    const run = begin({ engine: config.engine, model: config.model, selectedNodeIds: ["knowledge-specifications"], reviewConfig: undefined }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
    assert.deepEqual(phases, ["planning", "generation", "review"]);
    assert.equal(store.rules(["src/a.ts"]).rules.length, 0);
    service.apply(run.id, adoption(service.preview(run.id)));
    assert.equal(store.detail(document.id).current!.content, content);
    assert.deepEqual(store.detail(document.id).current!.sources.map(source => source.path), [config.entry, ".claude/rules/module.md", "src/a.ts"]);
    assert.equal(store.rules(["src/a.ts"]).rules.length, 1);
    assert.equal(store.rules(["docs/guide.md"]).rules.length, 0);
    assert.equal(new KnowledgeReviewStore(store).list(document.id)[0]!.stale, false);
  }
});

test("全项目与架构分类构建补齐三份默认文档，生成和复检保持独立且采用前不发布", async t => {
  for (const selectedNodeIds of [[], ["knowledge-architecture"]]) {
    const documents = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map((definition, index) => ({ ...node(definition.id), title: definition.title, orderKey: String(index) }));
    const phases: string[] = [];
    const execute = engine(documents);
    const { service, store, begin } = fixture(t, async input => {
      phases.push(input.purpose ?? "generation");
      if (input.purpose === "planning") assert.ok(input.instructions.includes(KNOWLEDGE_ARCHITECTURE_POLICY));
      if (!input.purpose) {
        assert.ok(input.prompt.includes(KNOWLEDGE_ARCHITECTURE_DOCUMENTS.find(document => document.title === input.title)!.summary));
        assert.ok(input.instructions.includes(KNOWLEDGE_ARCHITECTURE_POLICY));
      }
      await execute(input);
    });
    const initial = store.saveTree({ schemaVersion: 3, instructions: "", nodes: [] }, null);
    const run = begin({ selectedNodeIds, reviewConfig: { enabled: true, model: null, effort: null } }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items.map(item => item.title), ["架构总览", "核心流程", "关键机制"]);
    assert.equal(phases.filter(phase => phase === "planning").length, 1);
    assert.equal(phases.filter(phase => phase === "generation").length, 3);
    assert.equal(phases.filter(phase => phase === "review").length, 3);
    assert.ok(result.items.every(item => item.review?.status === "passed"));
    assert.equal(store.readTree().hash, initial.hash);
    assert.deepEqual(result.gaps, []);
    service.apply(run.id, adoption(service.preview(run.id)));
    assert.deepEqual(store.readTree().tree.nodes.filter(node => node.parentId === "knowledge-architecture").sort((a, b) => a.orderKey.localeCompare(b.orderKey)).map(node => node.title), ["架构总览", "核心流程", "关键机制"]);
  }
});

test("默认架构规划拒绝额外专题、重复文档及无说明的漏项，修正后可继续", async t => {
  const documents = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map((definition, index) => ({ ...node(`architecture-${index}`), title: definition.title }));
  const execute = engine(documents);
  const { service, begin } = fixture(t, async input => {
    if (input.purpose !== "planning") return execute(input);
    const evidence = await source(input);
    const submit = (nodes: KnowledgeAssetNode[], gaps: string[] = []) => input.execute({ toolId: "knowledge.plan.submit", accessMode: "read-only", toolInput: {
      nodes, generateNodeIds: nodes.map(node => node.id), decisions: nodes.map(node => ({ nodeId: node.id, question: "边界是什么", whyGenerate: "需要跨模块归纳", sources: [evidence] })), rationale: "补齐基础架构", gaps,
    } });
    const extra = await submit([{ ...node("custom"), title: "全量接口清单" }]);
    assert.equal(extra.ok, false); assert.match(JSON.stringify(extra), /其他专题请在知识协作对话中创建/);
    const duplicate = await submit([documents[0]!, { ...documents[0]!, id: "duplicate" }]);
    assert.equal(duplicate.ok, false); assert.match(JSON.stringify(duplicate), /不能重复创建/);
    const directory = await submit([node("extra-directory", "directory")]);
    assert.equal(directory.ok, false); assert.match(JSON.stringify(directory), /只在一级目录下新增/);
    const nested = await submit([node("extra-directory", "directory"), { ...documents[0]!, parentId: "extra-directory" }]);
    assert.equal(nested.ok, false); assert.match(JSON.stringify(nested), /只在一级目录下新增/);
    const missing = await submit([documents[0]!]);
    assert.equal(missing.ok, false); assert.match(JSON.stringify(missing), /核心流程尚未覆盖/);
    await execute(input);
  });
  const run = begin(); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
});

test("架构分类补齐不能借用规格或产品的已有节点ID改名移动", async t => {
  const documents = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map((definition, index) => ({ ...node(`architecture-${index}`), title: definition.title }));
  const execute = engine(documents);
  const { service, store, begin } = fixture(t, async input => {
    if (input.purpose !== "planning") return execute(input);
    for (const id of ["specification", "product-reference"]) {
      const result = await input.execute({ toolId: "knowledge.plan.submit", accessMode: "read-only", toolInput: {
        nodes: [{ ...store.node(id), parentId: "knowledge-architecture", title: "架构总览" }], generateNodeIds: [], decisions: [], rationale: "伪装默认架构文档", gaps: architectureGaps,
      } });
      assert.equal(result.ok, false); assert.match(JSON.stringify(result), /局部更新不能新增或修改选区外节点/);
    }
    await execute(input);
  });
  const protectedNodes = [node("specification", "generated", "knowledge-specifications"), { ...node("product-reference", "reference", "knowledge-product"), reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } }];
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: protectedNodes }, null);
  const run = begin({ selectedNodeIds: ["knowledge-architecture"] }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  for (const expected of protectedNodes) assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === expected.id), expected);
});

test("架构默认文档不能通过改名旧节点再新建ID替代人工正文", async t => {
  const { service, store, begin } = fixture(t, async input => {
    await source(input);
    const existing = store.node("original");
    const submit = (nodes: KnowledgeAssetNode[]) => input.execute({ toolId: "knowledge.plan.submit", accessMode: "read-only", toolInput: {
      nodes, generateNodeIds: [], decisions: [], rationale: "沿用已确认的架构总览", gaps: architectureGaps.slice(1),
    } });
    const replacement = { ...existing, id: "replacement" };
    const renamed = await submit([{ ...existing, title: "旧架构总览" }, replacement]);
    assert.equal(renamed.ok, false); assert.match(JSON.stringify(renamed), /保留名称、位置和节点 ID/);
    const duplicate = await submit([replacement]);
    assert.equal(duplicate.ok, false); assert.match(JSON.stringify(duplicate), /不能重复创建/);
    const nested = await submit([{ ...existing, parentId: "existing-directory" }]);
    assert.equal(nested.ok, false); assert.match(JSON.stringify(nested), /保留名称、位置和节点 ID/);
    await tool(input, "knowledge.plan.submit", { nodes: [], generateNodeIds: [], decisions: [], rationale: "保留人工架构总览", gaps: architectureGaps.slice(1) });
  });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("original"), title: "架构总览" }, node("existing-directory", "directory")] }, null);
  store.saveDocument({ nodeId: "original", expectedHash: null, content: "# 架构总览\n人工确认的架构说明。", origin: "manual", sources: [{ kind: "requirement", requirement: "已确认的架构", relation: "人工维护" }] });
  const currentHash = store.currentHash("original");
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items, []);
  assert.equal(store.currentHash("original"), currentHash);
  assert.equal(result.proposedTree!.nodes.find(node => node.id === "original")?.title, "架构总览");
});

test("目录纠正分类不能间接移走默认文档，非默认资料仍可整组归类", async t => {
  for (const defaultDocument of [true, false]) {
    const { service, store, begin } = fixture(t, async input => {
      await source(input);
      const plan = { nodes: [{ ...store.node("documents"), parentId: "knowledge-specifications" }], generateNodeIds: [], decisions: [], rationale: "纠正资料分类，保留原节点及人工正文", gaps: architectureGaps };
      const result = await input.execute({ toolId: "knowledge.plan.submit", toolInput: plan, accessMode: "read-only" });
      assert.equal(result.ok, !defaultDocument, JSON.stringify(result));
      if (defaultDocument) {
        assert.match(JSON.stringify(result), /保留名称、位置和节点 ID/);
        await tool(input, "knowledge.plan.submit", { ...plan, nodes: [] });
      }
    });
    const child = { ...node("child", "generated", "documents"), title: defaultDocument ? "架构总览" : "工程规范" };
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("documents", "directory"), child] }, null);
    store.saveDocument({ nodeId: child.id, content: "# 人工说明\n保留已确认内容。", sources: [], origin: "manual", expectedHash: null });
    const originalHash = store.currentHash(child.id);
    const run = begin(); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.equal(store.category(child.id, result.proposedTree!), defaultDocument ? "architecture" : "specifications");
    assert.equal(store.currentHash(child.id), originalHash);
    assert.equal(store.category(child.id), "architecture", "采用前正式分类不变");
  }
});

test("目录纠正规格分类校验有效后代同源引用，不受归档历史干扰", async t => {
  for (const variant of ["duplicate", "distinct", "archived"]) {
    const duplicate = variant === "duplicate", hiddenHistory = variant === "archived";
    const { service, store, root, begin } = fixture(t, async input => {
      await tool(input, "knowledge.source.read", { path: duplicate || hiddenHistory ? "AGENTS.md" : "STYLE.md" });
      const plan = { nodes: [{ ...store.node("documents"), parentId: "knowledge-specifications" }], generateNodeIds: [], decisions: [], rationale: "纠正规范目录分类，不重复收录同源规则", gaps: architectureGaps };
      const result = await input.execute({ toolId: "knowledge.plan.submit", toolInput: plan, accessMode: "read-only" });
      assert.equal(result.ok, !duplicate, JSON.stringify(result));
      if (duplicate) {
        assert.match(JSON.stringify(result), /复用节点 existing-rule/);
        await tool(input, "knowledge.plan.submit", { ...plan, nodes: [] });
      }
    });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# 工程规范\n修改后验证。", "utf8");
    fs.writeFileSync(path.join(root, "STYLE.md"), "# UI规范\n使用已有组件。", "utf8");
    // 构造同源和独立来源，检查仅提交父目录时后代也接受规格去重。
    const reference = (id: string, parentId: string, sourcePath: string) => ({ ...node(id, "reference", parentId), sourceScope: [sourcePath], reference: { path: sourcePath, adoptedContentHash: store.readSource(sourcePath).contentHash } });
    const existing = reference("existing-rule", "knowledge-specifications", hiddenHistory ? "STYLE.md" : "AGENTS.md");
    const nested = reference("nested-rule", "documents", duplicate || hiddenHistory ? "AGENTS.md" : "STYLE.md");
    const history = hiddenHistory ? [{ ...node("history", "directory", "documents"), archived: true }, reference("hidden-rule", "history", "AGENTS.md")] : [];
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [existing, node("documents", "directory"), nested, ...history] }, null);
    const run = begin(); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.equal(store.category(nested.id, result.proposedTree!), duplicate ? "architecture" : "specifications");
    assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === nested.id), nested);
    assert.equal(store.category(nested.id), "architecture", "采用前正式分类不变");
    for (const archived of history) assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === archived.id), archived);
  }
});

test("既有同名文档直接或随目录移入架构时仍须复用默认文档ID", async t => {
  for (const nested of [true, false]) {
    const { service, store, begin } = fixture(t, async input => {
      await source(input);
      const moving = store.node(nested ? "incoming-directory" : "incoming");
      const plan = { nodes: [{ ...moving, parentId: "knowledge-architecture" }], generateNodeIds: [], decisions: [], rationale: "已有架构总览须复用原 ID", gaps: architectureGaps.slice(1) };
      const result = await input.execute({ toolId: "knowledge.plan.submit", toolInput: plan, accessMode: "read-only" });
      assert.equal(result.ok, false); assert.match(JSON.stringify(result), /不能重复创建/);
      await tool(input, "knowledge.plan.submit", { ...plan, nodes: [] });
    });
    const incoming = { ...node("incoming", "generated", nested ? "incoming-directory" : "knowledge-specifications"), title: "架构总览" };
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("a"), node("incoming-directory", "directory", "knowledge-specifications"), incoming] }, null);
    for (const id of ["a", incoming.id]) store.saveDocument({ nodeId: id, content: "# 人工资料\n保留已确认的内容。", origin: "manual", sources: [], expectedHash: null });
    const run = begin(); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.equal(store.category(incoming.id, result.proposedTree!), "specifications");
    assert.equal(result.proposedTree!.nodes.find(node => node.id === "a")?.parentId, "knowledge-architecture");
    assert.deepEqual(result.items, []);
  }
});

test("同名导航目录不作为默认文档，也不阻碍补齐架构总览", async t => {
  const { service, store, begin } = fixture(t, engine([node("a")]));
  const directory = { ...node("same-name-directory", "directory"), title: "架构总览" };
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [directory] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items.map(item => item.nodeId), ["a"]);
  assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === directory.id), directory);
  assert.equal(result.proposedTree!.nodes.find(node => node.id === "a")?.title, directory.title);
  assert.equal(store.currentHash("a"), null, "统一采用前不发布默认正文");
});

test("归档目录下的同名默认文档不计有效覆盖，也不阻止新增可见文档", async t => {
  const documents = KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map((definition, index) => ({ ...node(`architecture-${index}`), title: definition.title }));
  const execute = engine(documents);
  const { service, store, begin } = fixture(t, async input => {
    if (input.purpose === "planning") {
      await source(input);
      const hidden = await input.execute({ toolId: "knowledge.plan.submit", accessMode: "read-only", toolInput: { nodes: [], generateNodeIds: [], decisions: [], rationale: "不能把归档文档当成已有覆盖", gaps: architectureGaps.slice(1) } });
      assert.equal(hidden.ok, false); assert.match(JSON.stringify(hidden), /架构总览尚未覆盖/);
    }
    await execute(input);
  });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("archived-directory", "directory"), archived: true }, { ...node("hidden", "reference", "archived-directory"), title: "架构总览", reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } }] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items.map(item => item.title), ["架构总览", "核心流程", "关键机制"]);
  assert.equal(result.proposedTree!.nodes.find(node => node.id === "hidden")?.parentId, "archived-directory");
});

test("架构分类只补缺失时保留已有正文，规划多列的已有文档不重复生成", async t => {
  const documents = [node("a"), node("b"), { ...node("mechanisms"), title: "关键机制" }];
  const phases: string[] = [];
  const execute = engine(documents);
  const { service, store, begin } = fixture(t, async input => { phases.push(input.purpose ?? "generation"); await execute(input); });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("a")] }, null);
  store.saveDocument({ nodeId: "a", expectedHash: null, content: "# 架构总览\n已有正式正文。", origin: "manual", sources: [{ kind: "requirement", requirement: "已确认架构", relation: "人工维护" }] });
  const currentHash = store.currentHash("a");
  const run = begin({ selectedNodeIds: ["knowledge-architecture"], strategy: "missing" }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items.map(item => item.title), ["核心流程", "关键机制"]);
  assert.deepEqual(phases, ["planning", "generation", "generation"]);
  assert.equal(store.currentHash("a"), currentHash);
});

test("旧库维护与规格限定规划不注入三份架构文档要求", async t => {
  for (const legacy of [false, true]) {
    const { service, store, begin } = fixture(t, async input => {
      assert.equal(input.purpose, "planning");
      assert.equal(input.instructions.includes(KNOWLEDGE_ARCHITECTURE_POLICY), false);
      await source(input);
      await tool(input, "knowledge.plan.submit", { nodes: [], generateNodeIds: [], decisions: [], rationale: "本轮无需新增架构内容", gaps: [] });
    });
    if (legacy) KnowledgeAssetStore.prototype.saveTree.call(store, { schemaVersion: 2, instructions: "", nodes: [node("legacy-root", "directory", null)] }, null);
    else store.saveTree({ schemaVersion: 3, instructions: "", nodes: [] }, null);
    const run = begin({ maintenance: true, selectedNodeIds: legacy ? [] : ["knowledge-specifications"] }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items, []);
    if (legacy) assert.deepEqual(result.proposedTree!.nodes.map(node => node.id), ["legacy-root"]);
  }
});

test("默认架构复用已有引用ID，证据不足逐项说明且不产生占位或正文任务", async t => {
  const { service, store, begin } = fixture(t, async input => {
    assert.equal(input.purpose, "planning");
    assert.ok(input.prompt.includes(JSON.stringify({ id: "original", parentId: "knowledge-architecture", title: "架构总览" })), "规划沿用历史节点的真实 ID");
    assert.equal(input.prompt.includes('"id":"knowledge-architecture-overview"'), false, "不能把已被历史节点替代的内置 ID 再交给模型");
    const evidence = await source(input);
    await tool(input, "knowledge.plan.submit", {
      nodes: [{ ...store.node("original"), title: "架构总览", reference: { path: evidence.path, adoptedContentHash: evidence.contentHash } }],
      generateNodeIds: [], decisions: [], rationale: "已有原文完整覆盖架构总览，其余缺少业务资料", gaps: architectureGaps.slice(1),
    });
  });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("original", "reference"), title: "架构总览", reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } }] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.gaps, architectureGaps.slice(1));
  assert.deepEqual(result.proposedTree!.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => node.id), ["original", "knowledge-architecture-core-flows", "knowledge-architecture-key-mechanisms"]);
  assert.deepEqual(service.preview(run.id).items, [], "未生成的默认节点不成为待采用变更");
});

test("默认架构引用核验当前可读正文，异常显式失败且实时变化正常覆盖", async t => {
  for (const variant of ["deleted", "empty", "invalid-utf8", "changed"]) {
    const { service, store, root, begin } = fixture(t, async input => {
      await source(input);
      const plan = { nodes: [], generateNodeIds: [], decisions: [], rationale: "保留已有架构引用，其余文档缺乏证据", gaps: architectureGaps.slice(1) };
      const result = await input.execute({ toolId: "knowledge.plan.submit", toolInput: plan, accessMode: "read-only" });
      assert.equal(result.ok, variant === "changed", "引用必须有当前可读的非空正文");
      if (variant === "changed") return;
      assert.match(JSON.stringify(result), /ENOENT|不存在|为空|utf-8/i);
      fs.writeFileSync(path.join(root, "src", "architecture.md"), "# 架构总览\n恢复的有效原文。", "utf8");
      const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "src/architecture.md" });
      await tool(input, "knowledge.plan.submit", { ...plan, nodes: [{ ...store.node("architecture-reference"), reference: { path: "src/architecture.md", adoptedContentHash: read.contentHash } }] });
    });
    const sourcePath = path.join(root, "src", "architecture.md");
    fs.writeFileSync(sourcePath, "# 架构总览\n已有有效资料。", "utf8");
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("architecture-reference", "reference"), title: "架构总览", reference: { path: "src/architecture.md", adoptedContentHash: store.readSource("src/architecture.md").contentHash } }] }, null);
    if (variant === "deleted") fs.unlinkSync(sourcePath);
    else if (variant === "invalid-utf8") fs.writeFileSync(sourcePath, Buffer.from([0xff, 0xfe]));
    else fs.writeFileSync(sourcePath, variant === "empty" ? "\n \t" : "# 架构总览\n实时更新的有效原文。", "utf8");
    const run = begin(); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.gaps, architectureGaps.slice(1));
    assert.equal(store.readReference("architecture-reference").state, "changed");
  }
});

test("显式选择自定义架构目录会更新后代，规划和直接更新均保留范围", async t => {
  for (const variant of ["direct", "changed", "with-defaults"]) {
    const phases: string[] = [];
    const execute = engine([], ["custom-topic"]);
    const { service, store, begin } = fixture(t, async input => { phases.push(input.purpose ?? "generation"); await execute(input); });
    const nodes = [node("custom-directory", "directory"), node("custom-topic", "generated", "custom-directory"), node("unselected-topic")];
    store.saveTree({ schemaVersion: 3, instructions: "", nodes }, null);
    for (const id of ["custom-topic", "unselected-topic"]) store.saveDocument({ nodeId: id, expectedHash: null, content: "# 人工专题\n保留已确认的内容。", origin: "manual", sources: [] });
    const originalHash = store.currentHash("custom-topic"), unselectedHash = store.currentHash("unselected-topic");
    const selectedNodeIds = variant === "with-defaults" ? ["knowledge-architecture", "custom-directory"] : ["custom-directory"];
    const run = begin({ selectedNodeIds, ...(variant === "changed" ? { changePaths: ["src/a.ts"] } : {}) }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.items.map(item => item.nodeId), ["custom-topic"]);
    assert.deepEqual(phases, variant === "direct" ? ["generation"] : ["planning", "generation"]);
    assert.equal(store.currentHash("custom-topic"), originalHash, "生成不覆盖人工正式正文");
    assert.equal(store.currentHash("unselected-topic"), unselectedHash);
  }
});

test("全项目默认构建保留自定义架构专题，显式选择该文件仍可更新", async t => {
  const phases: string[] = [];
  const execute = engine([]);
  const { service, store, begin } = fixture(t, async input => { phases.push(input.purpose ?? "generation"); await execute(input); });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("custom"), title: "专项集成机制" }] }, null);
  store.saveDocument({ nodeId: "custom", expectedHash: null, content: "# 专项机制\n已确认的人工正文。", origin: "manual", sources: [{ kind: "requirement", requirement: "用户要求专项说明", relation: "明确需求" }] });
  const currentHash = store.currentHash("custom");
  const initial = begin(); service.start(initial.id);
  assert.deepEqual((await settle(service, initial.id)).items, []);
  assert.equal(store.currentHash("custom"), currentHash);
  const selected = begin({ selectedNodeIds: ["custom"] }); service.start(selected.id);
  const result = await settle(service, selected.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items.map(item => item.nodeId), ["custom"]);
  assert.deepEqual(phases, ["planning", "generation"]);
  assert.equal(store.currentHash("custom"), currentHash);
});

test("知识协作对话可按用户要求提出默认清单之外的架构专题", t => {
  const { store, root, beforeCleanup } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [] }, null);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  beforeCleanup.push(() => db.db.close());
  db.workspaces.upsert({ id: "build-ws", title: "自定义架构", path: root });
  const actor = { userId: "owner", permissionScope: "account" as const };
  createKnowledgeConversation({ db, store, workspaceId: "build-ws", actor, nodeId: null, engine: "codex", reservedThreadId: "project-owner" });
  const turn = createKnowledgeConversationTurn({ db, store, workspaceId: "build-ws", threadId: "project-owner", turnId: "custom-architecture", engine: "codex", model: null, effort: null, prompt: "请补充专项集成机制", isActive: () => true, trustedActor: actor })!;
  assert.equal(turn.execute("knowledge.plan.submit", { nodes: [{ ...node("custom"), title: "专项集成机制" }], rationale: "用户明确要求补充专题", gaps: [] }).ok, true);
  turn.finish();
  assert.equal(store.readTree().tree.nodes.some(node => node.id === "custom"), false, "对话目录仍须统一预览采用");
});

test("维护规划只需引用时不扫描全库，正文生成前仍核验完整来源", async t => {
  for (const generated of [false, true]) {
    const calls: string[] = [];
    const execute = engine(generated ? [node("a")] : []);
    const { service, store, root, begin } = fixture(t, async input => { calls.push(input.purpose ?? "generation"); await execute(input); });
    store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("directory", "directory")] }, null);
    fs.writeFileSync(path.join(root, "src/z-broken.ts"), Buffer.from([0xff, 0xfe]));
    const run = begin({ maintenance: true }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.deepEqual(calls, ["planning"]);
    assert.equal(result.phase, generated ? "failed" : "completed");
    if (generated) assert.match(result.error?.message ?? "", /项目来源不是有效 UTF-8：src\/z-broken.ts/);
    assert.equal(store.readTree().tree.nodes.length, 15);
    assert.equal(store.currentHash("a"), null);
  }
});

test("已有库直接更新正文并独立复检，保留结构、引用及人工正式版本", async t => {
  const calls: string[] = [];
  const execute = engine([]);
  const { service, store, begin } = fixture(t, async input => { calls.push(input.purpose ?? "generation"); await execute(input); });
  const nodes = [node("directory", "directory"), node("a", "generated", "directory"), node("b"), { ...node("archived"), archived: true },
    { ...node("original", "reference"), reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } }];
  const saved = store.saveTree({ schemaVersion: 2, instructions: "", nodes }, null);
  store.saveDocument({ nodeId: "a", expectedHash: null, content: "# 人工正文", origin: "manual", sources: [{ kind: "requirement", requirement: "人工维护", relation: "边界" }] });
  const hash = store.currentHash("a");
  const run = begin({ selectedNodeIds: ["directory"], reviewConfig: { enabled: true, model: null, effort: null } }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(calls, ["generation", "review"]);
  assert.deepEqual(result.items.map(item => item.nodeId), ["a"]);
  assert.equal(result.items[0]?.review?.status, "passed");
  assert.equal(result.planningThreadId, undefined);
  assert.equal(store.currentHash("a"), hash);
  assert.equal(store.readTree().hash, saved.hash);
  assert.deepEqual(service.preview(run.id).items.map(item => item.nodeId), ["a"]);
});

test("沿用结构遵守补空白策略，已有待采用版本明确阻断重复生成", async t => {
  const { service, store, begin } = fixture(t, engine([]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a"), node("b")] }, null);
  store.saveDocument({ nodeId: "a", expectedHash: null, content: "# 已有正文", origin: "manual", sources: [{ kind: "requirement", requirement: "人工维护", relation: "边界" }] });
  const run = begin({ strategy: "missing", selectedNodeIds: ["a", "b"] }); service.start(run.id);
  assert.deepEqual((await settle(service, run.id)).items.map(item => item.nodeId), ["b"]);
  const duplicate = begin({ selectedNodeIds: ["a", "b"] }); service.start(duplicate.id);
  const failed = await settle(service, duplicate.id);
  assert.equal(failed.phase, "failed");
  assert.match(failed.error?.message ?? "", /已有待采用版本/);
});

test("维护规划扫描失败后不能改交空名单伪装无需生成", async t => {
  const { service, store, root, begin } = fixture(t, async input => {
    const evidence = await source(input);
    const plan = { nodes: [], generateNodeIds: ["a"], decisions: [{ nodeId: "a", question: "谁可以写入", whyGenerate: "边界变化", sources: [evidence] }], rationale: "核对关键机制", gaps: [] };
    const submit = (toolInput: unknown) => input.execute({ toolId: "knowledge.plan.submit", toolInput, accessMode: "read-only" });
    assert.equal((await submit(plan)).ok, false);
    assert.equal((await submit({ ...plan, generateNodeIds: [], decisions: [] })).ok, false);
  });
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  fs.writeFileSync(path.join(root, "src/z-broken.ts"), Buffer.from([0xff, 0xfe]));
  const run = begin({ maintenance: true }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "failed");
  assert.match(result.error?.message ?? "", /项目来源不是有效 UTF-8：src\/z-broken.ts/);
  assert.equal(store.currentHash("a"), null);
});

/** 可纠正的工具错误保持可见，但不能阻止补齐真实证据后的有效规划。 */
test("规划读错路径后拒绝无依据空计划，补读真实来源可继续生成", async t => {
  const calls: string[] = [];
  const generate = engine([]);
  const { service, store, begin } = fixture(t, async input => {
    calls.push(input.purpose ?? "generation");
    if (input.purpose !== "planning") return generate(input);
    const missing = await input.execute({ toolId: "knowledge.source.read", toolInput: { path: "src/missing.ts" }, accessMode: "read-only" });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "KNOWLEDGE_ASSET_NOT_FOUND");
    const empty = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { nodes: [], generateNodeIds: [], decisions: [], rationale: "没有新增知识", gaps: [] }, accessMode: "read-only" });
    assert.equal(empty.ok, false, "读取失败不能替代无需生成的真实依据");
    const evidence = await source(input);
    await tool(input, "knowledge.plan.submit", {
      nodes: [node("a")], generateNodeIds: ["a"],
      decisions: [{ nodeId: "a", question: "谁可以写入", whyGenerate: "跨模块授权需要归纳", sources: [evidence] }],
      rationale: "更正路径后已核对真实来源", gaps: architectureGaps,
    });
  });
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(calls, ["planning", "generation"]);
  assert.equal(result.items[0]?.status, "completed");
  assert.deepEqual(store.forRun(run.id).readRevision("a", result.items[0]!.revisionId!).sources.map(source => source.path), ["src/a.ts"]);
  assert.equal(store.currentHash("a"), null, "本轮结果仍等待统一采用");
});

test("连续生成和独立复检完成后统一采用，采用前正式树与正文均未发布", async t => {
  const { service, store, begin } = fixture(t, engine([node("a")]));
  const run = begin({ reviewConfig: { enabled: true, model: null, effort: null } }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.equal(result.items[0]?.review?.status, "passed");
  assert.equal(store.readTree().hash, null);
  assert.equal(store.currentHash("a"), null);
  const preview = service.preview(run.id);
  assert.ok(preview.items.every(item => item.canApply), JSON.stringify(preview.items));
  const input = adoption(preview, ["a"]);
  assert.equal(service.apply(run.id, input).adoptions?.[0]?.completed, true);
  assert.equal(store.readTree().tree.nodes.length, 14);
  assert.equal(store.detail("a").current?.revision.id, result.items[0]?.revisionId);
  assert.doesNotThrow(() => service.apply(run.id, input), "同请求幂等");
});

test("规划只读入口资料即可提交缺口，生成接收线索后与复检分别核验源码", async t => {
  const reads: Record<string, string[]> = {};
  const question = "写入权限由哪些边界共同保证？", whyGenerate = "入口资料只说明职责，尚缺跨模块授权边界。";
  const execute = engine([]);
  const { service, store, root, begin } = fixture(t, async input => {
    const purpose = input.purpose ?? "generation";
    reads[purpose] = [];
    const tracked = { ...input, execute: async (call: Parameters<typeof input.execute>[0]) => {
      if (call.toolId === "knowledge.source.read") reads[purpose]!.push((call.toolInput as { path: string }).path);
      return input.execute(call);
    } };
    if (input.purpose === "planning") {
      assert.match(input.instructions, /规划只判断资料和知识缺口/);
      assert.match(input.registry.tools.find(tool => tool.toolId === "knowledge.plan.submit")!.description, /不要求先核验实现细节/);
      const read = await tool<{ path: string; contentHash: string }>(tracked, "knowledge.source.read", { path: "README.md" });
      await tool(tracked, "knowledge.plan.submit", {
        nodes: [{ ...node("a"), sourceScope: ["src", "README.md"] }], generateNodeIds: ["a"],
        decisions: [{ nodeId: "a", question, whyGenerate, sources: [{ kind: "document", ...read, relation: "入口职责与覆盖范围" }] }],
        rationale: "只补充未覆盖的授权边界", gaps: [...architectureGaps, question],
      });
    } else {
      if (purpose === "generation") {
        assert.ok(input.prompt.includes(question) && input.prompt.includes(whyGenerate) && input.prompt.includes("README.md"));
        assert.match(input.prompt, /不代表已验证的实现结论/);
        assert.ok(!input.instructions.includes(question), "规划线索不改写长期要求");
      }
      await execute(tracked);
    }
  });
  fs.writeFileSync(path.join(root, "README.md"), "# 项目入口\nsrc 负责权限控制，本文未说明跨模块授权边界。\n", "utf8");
  const run = begin({ reviewConfig: { enabled: true, model: null, effort: null } }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(reads, { planning: ["README.md"], generation: ["src/a.ts"], review: ["src/a.ts"] });
  assert.equal(result.items[0]?.review?.status, "passed");
  assert.equal(result.planningDecisions?.[0]?.sources[0]?.kind, "document");
  const document = store.forRun(run.id).readRevision("a", result.items[0]!.revisionId!);
  assert.deepEqual(document.sources.map(source => source.path), ["src/a.ts"]);
  assert.ok(!document.revision.instructions.includes(question));
  assert.equal(store.currentHash("a"), null);
});

test("轻量规划仍拒绝未读取或指纹不符的资料依据", async t => {
  for (const invalid of ["unread", "hash"]) {
    const phases: string[] = [];
    const { service, store, root, begin } = fixture(t, async input => {
      phases.push(input.purpose ?? "generation");
      const read = await tool<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: "README.md" });
      const evidence = { kind: "document", path: invalid === "unread" ? "other.md" : read.path, contentHash: invalid === "hash" ? "0".repeat(64) : read.contentHash, relation: "资料覆盖范围" };
      const result = await input.execute({ toolId: "knowledge.plan.submit", accessMode: "read-only", toolInput: {
        nodes: [node("a")], generateNodeIds: ["a"], decisions: [{ nodeId: "a", question: "授权边界？", whyGenerate: "资料未覆盖", sources: [evidence] }], rationale: "补齐缺口", gaps: [],
      } });
      assert.equal(result.ok, false);
      assert.match(JSON.stringify(result), /价值依据必须包含本轮实际读取的直接来源/);
    });
    fs.writeFileSync(path.join(root, "README.md"), "# 项目入口\n", "utf8");
    fs.writeFileSync(path.join(root, "other.md"), "# 未读资料\n", "utf8");
    const run = begin(); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "failed");
    assert.deepEqual(phases, ["planning"]);
    assert.equal(store.currentHash("a"), null);
    assert.equal(store.readTree().hash, null);
  }
});

test("规格发现补充真实安全与局部规则引用，同源复用且条件不明只记录缺口", async t => {
  const calls: string[] = [];
  const files = ["AGENTS.md", "SECURITY.md", ".github/instructions/backend.instructions.md", ".claude/rules/ui.md", ".cursor/rules/tests.mdc"];
  const gap = "测试规则按 **/*.test.ts 匹配，当前文件/目录范围无法准确表达，待确认。";
  const { service, store, root, begin } = fixture(t, async input => {
    calls.push(input.purpose ?? "generation");
    assert.equal(input.purpose, "planning");
    assert.ok(input.instructions.includes(KNOWLEDGE_SPECIFICATION_POLICY));
    for (const directory of ["", ".github", ".github/instructions", ".claude", ".claude/rules", ".cursor", ".cursor/rules"]) {
      await tool(input, "knowledge.source.list", { directory });
    }
    const evidence = new Map<string, { path: string; contentHash: string }>();
    for (const path of files) evidence.set(path, await tool(input, "knowledge.source.read", { path }));
    const nodes = files.slice(0, -1).map((path, index) => ({
      ...node(index === 0 ? "existing-rule" : `rule-${index}`, "reference", "knowledge-specifications"), sourceScope: [path],
      reference: { path, adoptedContentHash: evidence.get(path)!.contentHash }, ...(index > 1 ? { appliesTo: ["src"] } : {}),
    }));
    const plan = { nodes, generateNodeIds: [], decisions: [], rationale: "补充已确认规范引用，保持原始适用范围", gaps: [...architectureGaps, gap] };
    const rejected = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { ...plan, nodes: [{ ...nodes[0]!, instructions: "只构建规格约束，其他分类保持空。" }, ...nodes.slice(1)] }, accessMode: "read-only" });
    assert.equal(rejected.ok, false, "本轮构建范围不能误存为长期规格要求");
    assert.match(JSON.stringify(rejected), /instructions 填空字符串/);
    assert.equal(store.readRun(input.runId).proposedTree, null, "错误计划不落候选树");
    await tool(input, "knowledge.plan.submit", plan);
  });
  const contents = ["# 工程规范\n错误须显式失败。\n", "# 安全规范\n日志禁止包含凭据。\n", "---\napplyTo: src/**\n---\n接口修改保持兼容。\n", "---\npaths: src/**\n---\n界面使用既有布局约束。\n", "---\nglobs: **/*.test.ts\nalwaysApply: false\n---\n测试不得依赖外部生产服务。\n"];
  for (const [index, file] of files.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents[index]!, "utf8");
  }
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...node("existing-rule", "reference", "knowledge-specifications"), sourceScope: ["AGENTS.md"], reference: { path: "AGENTS.md", adoptedContentHash: store.readSource("AGENTS.md").contentHash } }] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(calls, ["planning"]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.gaps, [...architectureGaps, gap]);
  const references = result.proposedTree!.nodes.filter(node => node.contentMode === "reference");
  assert.equal(references.length, 4);
  assert.deepEqual(references.filter(node => node.reference?.path === "AGENTS.md").map(node => node.id), ["existing-rule"]);
  assert.equal(store.rules().rules.length, 1, "采用前不改变正式规则");
  const preview = service.preview(run.id);
  service.apply(run.id, adoption(preview));
  assert.deepEqual(store.rules().rules.map(rule => rule.nodeId), ["existing-rule", "rule-1"]);
  assert.deepEqual(store.rules(["src/a.ts"]).rules.map(rule => rule.nodeId), ["existing-rule", "rule-1", "rule-2", "rule-3"]);
  assert.equal(store.rules().scoped.length, 2);
});

test("空项目的明确长期要求完成规划、生成和默认独立复检，采用后才生效", async t => {
  const requirement = "长期保存：发布知识前必须确认其适用范围。";
  const evidence = { kind: "requirement", requirement, relation: "本次明确要求长期保存" };
  const calls: string[] = [];
  const { service, store, begin } = fixture(t, async input => {
    calls.push(input.purpose ?? "generation");
    if (input.purpose === "planning") {
      assert.ok(input.instructions.includes(KNOWLEDGE_SPECIFICATION_POLICY));
      const plan = { nodes: [{ ...node("new-rule", "generated", "knowledge-specifications"), sourceScope: [], instructions: "发布知识前必须确认其适用范围。" }], generateNodeIds: ["new-rule"], decisions: [{ nodeId: "new-rule", question: "知识发布须遵守什么要求", whyGenerate: "用户明确要求长期保存，现有资料未覆盖", sources: [evidence] }], rationale: "保存已确认的项目约束", gaps: [] };
      const rejected = await input.execute({ toolId: "knowledge.plan.submit", toolInput: { ...plan, decisions: [{ ...plan.decisions[0], sources: [{ ...evidence, requirement: "发布无需任何审核" }] }] }, accessMode: "read-only" });
      assert.equal(rejected.ok, false);
      await tool(input, "knowledge.plan.submit", plan);
    } else if (input.purpose === "review") {
      assert.match(input.instructions, /现有代码尚未满足要求本身不代表规格错误/);
      const report = { outcome: "passed", summary: "已按用户原话核对规格及适用边界", sources: [evidence], issues: [] };
      const unread = await input.execute({ toolId: "knowledge.review.submit", toolInput: report, accessMode: "read-only" });
      assert.equal(unread.ok, false, "要求证据不能绕过正文全文阅读");
      const document = await tool<{ generationInstructions: string; nextLine: number | null }>(input, "knowledge.review.read");
      assert.ok(document.generationInstructions.includes(requirement));
      assert.equal(document.nextLine, null);
      const forged = await input.execute({ toolId: "knowledge.review.submit", toolInput: { ...report, sources: [{ ...evidence, requirement: "发布无需任何审核" }] }, accessMode: "read-only" });
      assert.equal(forged.ok, false, "未绑定的用户要求不能充当证据");
      await tool(input, "knowledge.review.submit", report);
    } else {
      assert.ok(input.instructions.includes(KNOWLEDGE_SPECIFICATION_POLICY));
      assert.ok(input.prompt.includes(requirement));
      await tool(input, "knowledge.asset.submit", { content: "# 知识发布约束\n发布知识前必须确认其适用范围。", summary: "用户确认的长期约束", sources: [evidence] });
    }
  }, true);
  const run = begin({ prompt: requirement, reviewConfig: undefined }); service.start(run.id);
  assert.equal(run.reviewConfig?.enabled, true);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.equal(result.items.length, 1);
  assert.deepEqual(calls, ["planning", "generation", "review"]);
  assert.equal(result.items[0]!.review?.status, "passed");
  assert.equal(store.rules().rules.length, 0);
  assert.equal(store.currentHash("new-rule"), null);
  assert.equal(store.forRun(run.id).readRevision("new-rule", result.items[0]!.revisionId!).sources[0]?.kind, "requirement");
  const reports = new KnowledgeReviewStore(store.forRun(run.id)).list("new-rule");
  assert.equal(reports[0]?.stale, false);
  assert.deepEqual(reports[0]?.sources, [evidence]);
  assert.ok(service.preview(run.id).items.every(item => item.canApply));
  service.apply(run.id, adoption(service.preview(run.id)));
  assert.equal(store.rules().rules.length, 1);
  assert.equal(new KnowledgeReviewStore(store).list("new-rule")[0]?.stale, false);
  const updatedRequirement = "长期保存：发布前同时确认审核人。";
  const adopted = store.readTree();
  store.saveTree({ ...adopted.tree, instructions: updatedRequirement }, adopted.hash);
  const latestReviews = new KnowledgeReviewStore(store);
  assert.equal(latestReviews.list("new-rule")[0]?.stale, true);
  const updatedSnapshot = latestReviews.snapshot("new-rule", result.items[0]!.revisionId!);
  assert.equal(latestReviews.requirementEvidence(updatedSnapshot, { ...evidence, requirement: updatedRequirement }).requirement, updatedRequirement);
});

test("规格规划拒绝同源新ID及glob范围，允许修正后复用既有引用", async t => {
  const { service, store, root, begin } = fixture(t, async input => {
    const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "AGENTS.md" });
    const reference = { ...node("existing-rule", "reference", "knowledge-specifications"), sourceScope: ["AGENTS.md"], reference: { path: "AGENTS.md", adoptedContentHash: read.contentHash } };
    const submit = (nodes: KnowledgeAssetNode[]) => ({ nodes, generateNodeIds: [], decisions: [], rationale: "原文足以覆盖规格", gaps: architectureGaps });
    const duplicate = await input.execute({ toolId: "knowledge.plan.submit", toolInput: submit([{ ...reference, id: "duplicate-rule" }]), accessMode: "read-only" });
    assert.equal(duplicate.ok, false);
    assert.match(JSON.stringify(duplicate), /复用节点 existing-rule/);
    const migration = await input.execute({ toolId: "knowledge.plan.submit", toolInput: submit([{ ...reference, id: "architecture-reference" }]), accessMode: "read-only" });
    assert.equal(migration.ok, false);
    assert.match(JSON.stringify(migration), /复用节点 existing-rule/);
    const glob = await input.execute({ toolId: "knowledge.plan.submit", toolInput: submit([{ ...reference, appliesTo: ["**/*.ts"] }]), accessMode: "read-only" });
    assert.equal(glob.ok, false);
    assert.match(JSON.stringify(glob), /glob/);
    await tool(input, "knowledge.plan.submit", submit([{ ...reference, appliesTo: ["src/[id]"] }]));
  });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# 工程规范\n修改后验证。", "utf8");
  fs.mkdirSync(path.join(root, "src", "[id]"));
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: ["existing-rule", "architecture-reference"].map(id => ({ ...node(id, "reference", id === "existing-rule" ? "knowledge-specifications" : "knowledge-architecture"), sourceScope: ["AGENTS.md"], reference: { path: "AGENTS.md", adoptedContentHash: store.readSource("AGENTS.md").contentHash } })) }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.proposedTree!.nodes.filter(node => node.parentId === "knowledge-specifications" && node.contentMode === "reference").map(node => node.id), ["existing-rule"]);
  assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === "existing-rule")?.appliesTo, ["src/[id]"]);
});

test("已有非默认架构资料可纠正归类为规格，保留节点和原文引用", async t => {
  const { service, store, root, begin } = fixture(t, async input => {
    const read = await tool<{ contentHash: string }>(input, "knowledge.source.read", { path: "AGENTS.md" });
    await tool(input, "knowledge.plan.submit", {
      nodes: [{ ...store.node("misclassified-rule"), parentId: "knowledge-specifications", reference: { path: "AGENTS.md", adoptedContentHash: read.contentHash } }],
      generateNodeIds: [], decisions: [], rationale: "工程规范应属于规格约束，保留原文引用和节点 ID", gaps: architectureGaps,
    });
  });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# 工程规范\n修改后验证。", "utf8");
  const existing = { ...node("misclassified-rule", "reference"), title: "工程规范", sourceScope: ["AGENTS.md"], reference: { path: "AGENTS.md", adoptedContentHash: store.readSource("AGENTS.md").contentHash } };
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [existing] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.proposedTree!.nodes.find(node => node.id === existing.id), { ...existing, parentId: "knowledge-specifications" });
  assert.equal(store.category(existing.id), "architecture", "采用前不修改正式分类");
});

test("规格生成和复检拒绝候选计划自拟要求，真实祖先要求仍可继承", async t => {
  const requirement = "长期保存：发布前必须确认适用范围。", invented = "发布无需审核。";
  const evidence: KnowledgeAssetSource = { kind: "requirement", requirement, relation: "已采用的规格根要求" };
  const fake = { ...evidence, requirement: invented };
  const { service, store, begin } = fixture(t, async input => {
    if (input.purpose === "planning") {
      const plan = { nodes: [{ ...node("new-rule", "generated", "knowledge-specifications"), instructions: invented }], generateNodeIds: ["new-rule"], decisions: [{ nodeId: "new-rule", question: "发布约束", whyGenerate: "保存已确认的长期要求", sources: [evidence] }], rationale: "沉淀已采用的要求", gaps: architectureGaps };
      const rejected = await input.execute({ toolId: "knowledge.plan.submit", toolInput: plan, accessMode: "read-only" });
      assert.equal(rejected.ok, false, "候选计划不能将自拟要求存入目录配置");
      await tool(input, "knowledge.plan.submit", { ...plan, nodes: [{ ...plan.nodes[0], instructions: "发布前必须确认适用范围。" }] });
    } else if (input.purpose === "review") {
      const read = await tool<{ confirmedRequirements: string[] }>(input, "knowledge.review.read");
      assert.ok(read.confirmedRequirements.some(text => text.includes(requirement)));
      assert.ok(read.confirmedRequirements.every(text => !text.includes(invented)));
      const report = { outcome: "passed", summary: "核对真实祖先要求", issues: [], sources: [fake] };
      const rejected = await input.execute({ toolId: "knowledge.review.submit", toolInput: report, accessMode: "read-only" });
      assert.equal(rejected.ok, false);
      await tool(input, "knowledge.review.submit", { ...report, sources: [evidence] });
    } else {
      const document = { content: "# 发布约束\n发布前必须确认适用范围。", summary: "真实要求", sources: [fake] };
      const rejected = await input.execute({ toolId: "knowledge.asset.submit", toolInput: document, accessMode: "read-only" });
      assert.equal(rejected.ok, false);
      assert.equal(store.forRun(input.runId).revisions("new-rule").length, 0);
      await tool(input, "knowledge.asset.submit", { ...document, sources: [evidence] });
    }
  });
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [{ ...knowledgeCategoryNodes()[0]!, instructions: requirement }] }, null);
  const run = begin({ reviewConfig: undefined }); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.equal(result.items[0]?.review?.status, "passed");
  const adoptedPreview = service.preview(run.id);
  service.apply(run.id, adoption(adoptedPreview));
  assert.equal(new KnowledgeReviewStore(store).list("new-rule")[0]?.stale, false);
  const reviews = new KnowledgeReviewStore(store.forRun(run.id));
  const snapshot = reviews.snapshot("new-rule", result.items[0]!.revisionId!);
  const report = { runId: run.id, engine: "codex" as const, model: null, effort: null, outcome: "passed" as const, summary: "核对已确认要求", issues: [], sources: [evidence] };
  const adopted = store.readTree();
  store.saveTree({ ...adopted.tree, instructions: "新的正式项目要求" }, adopted.hash);
  assert.throws(() => reviews.save(snapshot, report), /复检期间文档或生成要求已变化/);
  assert.equal(reviews.list("new-rule")[0]?.stale, true);
});

test("更新已采用规格可保留原用户来源，采用新版本不使同版复检过期", async t => {
  for (const replacing of [false, true]) {
    const original = "长期保存：发布前确认适用范围。", replacement = "长期保存：采用前确认审核人。";
    const requirement = replacing ? replacement : original;
    const evidence = { kind: "requirement", requirement, relation: "已确认的用户要求" };
    const { service, store, begin } = fixture(t, async input => {
      if (input.purpose === "review") {
        await tool(input, "knowledge.review.read");
        await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对原用户要求", sources: [evidence], issues: [] });
      } else await tool(input, "knowledge.asset.submit", { content: `# 发布要求\n${requirement}`, summary: "修订原规格", sources: [evidence] });
    });
    store.saveTree({ schemaVersion: 3, instructions: "", nodes: [node("rule", "generated", "knowledge-specifications")] }, null);
    store.saveDocument({ nodeId: "rule", content: `# 原规格\n${original}`, sources: [{ ...evidence, requirement: original }], expectedHash: null, origin: "manual" });
    const run = begin({ mode: "batch", selectedNodeIds: ["rule"], prompt: replacing ? replacement : "精简原规格并保留已确认要求", reviewConfig: undefined }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.items[0]?.review?.status, "passed", JSON.stringify(result));
    service.apply(run.id, adoption(service.preview(run.id)));
    assert.equal(new KnowledgeReviewStore(store).list("rule")[0]?.stale, false);
  }
});

test("规格工作会话补充的真实要求可在沿用原任务ID时独立复检", async t => {
  const initialRequirement = "长期保存：发布前确认适用范围。", followupRequirement = "长期保存：采用规格前补充审核人。";
  const originalEvidence = { kind: "requirement", requirement: initialRequirement, relation: "初次用户要求" };
  const followupEvidence = { ...originalEvidence, requirement: followupRequirement, relation: "用户在资产工作会话补充" };
  const { service, store, root, begin, beforeCleanup } = fixture(t, async input => {
    if (input.purpose === "planning") {
      await tool(input, "knowledge.plan.submit", { nodes: [node("rule", "generated", "knowledge-specifications")], generateNodeIds: ["rule"], decisions: [{ nodeId: "rule", question: "采用规则", whyGenerate: "用户明确长期保存", sources: [originalEvidence] }], rationale: "保存明确要求", gaps: [] });
    } else if (input.purpose === "review") {
      await tool(input, "knowledge.review.read");
      await tool(input, "knowledge.review.submit", { outcome: "passed", summary: "已核对补充要求", sources: [followupEvidence], issues: [] });
    } else {
      input.onThreadCreated("spec-execution");
      await tool(input, "knowledge.asset.submit", { content: "# 采用要求\n发布前确认适用范围。", summary: "初次要求", sources: [originalEvidence] });
    }
  });
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  beforeCleanup.push(() => db.db.close());
  db.workspaces.upsert({ id: "build-ws", title: "规格续写", path: root });
  const actor = { userId: "owner", permissionScope: "account" as const };
  createKnowledgeConversation({ db, store, workspaceId: "build-ws", actor, nodeId: null, engine: "codex", reservedThreadId: "project-owner" });
  const run = begin({ prompt: initialRequirement }); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  service.apply(run.id, adoption(service.preview(run.id)));
  db.threads.create({ id: "spec-execution", workspaceId: "build-ws", title: "规格执行", engine: "codex", threadType: "orchestration", threadSubtype: "knowledge-assets" });
  const turn = createKnowledgeConversationTurn({ db, store, workspaceId: "build-ws", threadId: "spec-execution", turnId: "spec-followup", engine: "codex", model: null, effort: null, prompt: followupRequirement, isActive: () => true, trustedActor: actor })!;
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "rule", expectedHash: store.currentHash("rule"), content: "# 采用要求\n采用规格前补充审核人。", summary: "补充要求", sources: [followupEvidence] }).ok, true);
  turn.finish();
  const draft = store.detail("rule").drafts[0]!;
  assert.equal(draft.runId, run.id);
  assert.equal(store.readRun(run.id).prompt, initialRequirement);
  const review = begin({ mode: "review", selectedNodeIds: ["rule"], prompt: "独立核对补充要求", reviewConfig: undefined }); service.start(review.id);
  assert.equal((await settle(service, review.id)).items[0]?.review?.status, "passed");
  assert.equal(new KnowledgeReviewStore(store).list("rule")[0]?.stale, false);
});

test("知识会话同轮提交目录计划和正文时，复检按正式要求追溯正文", t => {
  const { store, root, beforeCleanup } = fixture(t);
  store.saveTree({ schemaVersion: 3, instructions: "已采用的目录要求", nodes: [node("rule", "generated", "knowledge-specifications")] }, null);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  beforeCleanup.push(() => db.db.close());
  db.workspaces.upsert({ id: "build-ws", title: "规格会话", path: root });
  const actor = { userId: "owner", permissionScope: "account" as const };
  createKnowledgeConversation({ db, store, workspaceId: "build-ws", actor, nodeId: null, engine: "codex", reservedThreadId: "project-owner" });
  const requirement = "长期保存：采用前确认审核人。", proposed = "尚未采用的目录要求";
  const turn = createKnowledgeConversationTurn({ db, store, workspaceId: "build-ws", threadId: "project-owner", turnId: "plan-and-document", engine: "codex", model: null, effort: null, prompt: requirement, isActive: () => true, trustedActor: actor })!;
  const rootNode = store.node("knowledge-specifications");
  assert.equal(turn.execute("knowledge.plan.submit", { nodes: [{ ...rootNode, instructions: proposed }], rationale: "目录要求待用户确认", gaps: [] }).ok, true);
  const evidence = { kind: "requirement", requirement, relation: "本轮明确用户要求" };
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "rule", expectedHash: null, content: "# 采用要求\n采用前确认审核人。", summary: "保存本轮要求", sources: [evidence] }).ok, true);
  turn.finish();
  const reviews = new KnowledgeReviewStore(store), snapshot = reviews.snapshot("rule", store.detail("rule").drafts[0]!.id);
  assert.equal(reviews.requirementEvidence(snapshot, evidence).requirement, requirement);
  assert.throws(() => reviews.requirementEvidence(snapshot, { ...evidence, requirement: proposed }), /必须逐字引用/);
});

test("部分采用只发布所选分支，保留剩余候选与无关外部修改", async t => {
  const { service, store, begin } = fixture(t, engine([node("a"), node("b")]));
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const preview = service.preview(run.id);
  service.apply(run.id, adoption(preview, ["a"]));
  assert.deepEqual(store.readTree(false).tree.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => node.id), ["a"]);
  const current = store.readTree();
  store.saveTree({ ...current.tree, nodes: [...current.tree.nodes, node("unrelated", "directory")] }, current.hash);
  const next = service.preview(run.id);
  assert.equal(next.items.find(item => item.nodeId === "a")?.applied, true);
  assert.equal(next.items.find(item => item.nodeId === "b")?.canApply, true);
  service.apply(run.id, adoption(next, ["b"]));
  assert.deepEqual(store.readTree(false).tree.nodes.filter(node => node.parentId === "knowledge-architecture").map(node => node.id).sort(), ["a", "b", "knowledge-architecture-key-mechanisms", "unrelated"]);
  assert.equal(store.readTree().tree.nodes.filter(node => node.title === "核心流程").length, 1);
});

test("原文引用只采用关系，预览后来源漂移必须重新确认", async t => {
  const { service, store, root, begin } = fixture(t, async input => {
    const evidence = await source(input);
    await tool(input, "knowledge.plan.submit", { nodes: [{ ...node("original", "reference"), reference: { path: "src/a.ts", adoptedContentHash: evidence.contentHash } }], generateNodeIds: [], decisions: [], rationale: "已有原文足够", gaps: architectureGaps });
  });
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const preview = service.preview(run.id);
  fs.appendFileSync(path.join(root, "src", "a.ts"), "// 来源变化\n", "utf8");
  assert.throws(() => service.apply(run.id, adoption(preview)), /预览后/);
  const next = service.preview(run.id);
  service.apply(run.id, adoption(next));
  assert.equal(store.revisions("original").length, 0);
  assert.equal(store.detail("original").reference?.state, "unchanged");
});

test("整批只读检查不跨请求缓存，生成来源变化后预览阻断且旧预览不能采用", async t => {
  const { service, store, root, begin } = fixture(t, engine([node("a"), node("b")]));
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const preview = service.preview(run.id);
  assert.ok(preview.items.every(item => item.canApply));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const allowed = false;\n", "utf8");
  const changed = service.preview(run.id);
  assert.ok(changed.items.every(item => !item.canApply && item.reason?.includes("来源已变化")));
  assert.throws(() => service.apply(run.id, adoption(preview)), /预览后/);
  assert.equal(store.currentRevisionId("a"), null);
  assert.equal(store.currentRevisionId("b"), null);
});

test("采用校验确切版本，原生成会话失效不阻断项目维护入口", async t => {
  const { service, store, begin, revoke } = fixture(t, engine([node("a")]));
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const preview = service.preview(run.id), input = adoption(preview);
  assert.throws(() => service.apply(run.id, { ...input, selections: [{ nodeId: "a", revisionId: "other" }] }), /选择版本/);
  revoke();
  service.apply(run.id, input);
  assert.ok(store.readTree().hash);
});

test("默认规格采用写树失败时准备指针不加载为规则，取消后撤除指针并保留草稿", async t => {
  const definition = KNOWLEDGE_SPECIFICATION_DOCUMENTS[0], requirement = "新增依赖前必须确认必要性。";
  const evidence = { kind: "requirement", requirement, relation: "本轮用户确认要求" };
  const { service, store, begin } = fixture(t, async input => {
    if (input.purpose === "planning") await tool(input, "knowledge.plan.submit", { nodes: [], generateNodeIds: [definition.id],
      decisions: [{ nodeId: definition.id, question: "项目变更有哪些约定", whyGenerate: "保存用户确认要求", sources: [evidence] }], rationale: "只补项目约定", gaps: [] });
    else await tool(input, "knowledge.asset.submit", { content: `# 项目约定\n${requirement}`, summary: "项目变更要求", sources: [evidence] });
  });
  const run = begin({ selectedNodeIds: [definition.id], prompt: requirement }); service.start(run.id);
  assert.equal((await settle(service, run.id)).phase, "completed");
  const input = adoption(service.preview(run.id));
  const write = store.files.write.bind(store.files);
  store.files.write = (relative, content) => {
    if (relative.endsWith("/tree.json")) throw new Error("模拟正式树写入失败");
    write(relative, content);
  };
  assert.throws(() => service.apply(run.id, input), /模拟正式树写入失败/);
  assert.ok(store.currentRevisionId(definition.id));
  assert.equal(store.readTree(false).tree.nodes.length, 0);
  assert.deepEqual(store.rules(), { rules: [], scoped: [] });
  const cancelled = service.cancelAdoption(run.id, input.requestId, "owner");
  assert.equal(cancelled.adoptions?.[0]?.cancelled, true);
  assert.deepEqual(cancelled.adoptions?.[0]?.appliedNodeIds, []);
  assert.equal(store.currentRevisionId(definition.id), null);
  assert.equal(store.revisions(definition.id).length, 1);
  assert.deepEqual(store.rules(), { rules: [], scoped: [] });
});

test("采用中断保存回执并用原请求恢复，不重复写版本", async t => {
  const { service, store, begin } = fixture(t, engine([node("a"), node("b")]));
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const input = adoption(service.preview(run.id));
  const write = store.files.write.bind(store.files);
  let fail = true;
  store.files.write = (relative, content) => {
    if (fail && relative.endsWith("/assets/b/current.json")) { fail = false; throw new Error("模拟磁盘写入失败"); }
    write(relative, content);
  };
  assert.throws(() => service.apply(run.id, input), /模拟磁盘/);
  assert.equal(store.readRun(run.id).adoptions?.[0]?.completed, false);
  assert.ok(store.currentHash("a"));
  assert.equal(store.readTree().hash, null);
  assert.throws(() => service.apply(run.id, { ...input, requestId: "other-request" }), /未完成的采用/);
  assert.equal(service.apply(run.id, input).adoptions?.[0]?.completed, true);
  assert.deepEqual(service.preview(run.id).items.map(item => item.applied), [true, true]);
  assert.equal(store.revisions("a").length, 1);
});

test("跨任务复检不能不采用正在提交的版本，原请求仍可恢复或终止", async t => {
  for (const cancel of [false, true]) {
    const generated = [node("a"), node("b")];
    const { service, store, begin } = fixture(t, engine(generated));
    store.saveTree({ schemaVersion: 2, instructions: "", nodes: generated }, null);
    const run = begin({ mode: "batch", selectedNodeIds: ["a", "b"] });
    service.start(run.id); await settle(service, run.id);
    const input = adoption(service.preview(run.id));
    const write = store.files.write.bind(store.files);
    let failed = false;
    store.files.write = (file, content) => {
      if (!failed && file.endsWith("/assets/b/current.json")) { failed = true; throw new Error("模拟未写入项磁盘错误"); }
      write(file, content);
    };
    assert.throws(() => service.apply(run.id, input), /磁盘错误/);
    const review = begin({ mode: "review", selectedNodeIds: ["b"], prompt: "重点核对权限边界", reviewConfig: { enabled: true, model: null, effort: null } });
    service.start(review.id);
    assert.equal((await settle(service, review.id)).items[0]?.review?.status, "passed");
    const revisionId = store.readRun(review.id).items[0]!.revisionId!;
    await assert.rejects(service.dismiss(review.id, "b", revisionId, "owner"), /未完成采用/);
    assert.equal(store.readRun(review.id).dismissals?.length ?? 0, 0);
    assert.equal(store.readRun(run.id).dismissals?.length ?? 0, 0);
    if (cancel) {
      service.cancelAdoption(run.id, input.requestId, "owner");
      assert.equal(service.preview(review.id).items[0]?.dismissed, true);
      assert.equal(service.preview(run.id).items.find(item => item.nodeId === "a")?.applied, true);
      assert.equal(store.currentRevisionId("b"), null);
    } else {
      assert.equal(service.apply(run.id, input).adoptions?.[0]?.completed, true);
      assert.equal(store.currentRevisionId("b"), revisionId);
      assert.equal(service.preview(review.id).items[0]?.applied, true);
    }
  }
});

test("历史冲突回执不会恢复已拒绝版本，显式终止后可重新构建", async t => {
  for (const existing of [false, true]) {
    const generated = [node("a"), node("b")];
    const { service, store, begin } = fixture(t, engine(generated));
    if (existing) store.saveTree({ schemaVersion: 2, instructions: "", nodes: generated }, null);
    const run = begin();
    service.start(run.id); await settle(service, run.id);
    const input = adoption(service.preview(run.id));
    const write = store.files.write.bind(store.files);
    let failed = false;
    store.files.write = (file, content) => {
      if (!failed && file.endsWith(existing ? "/assets/b/current.json" : "/tree.json")) { failed = true; throw new Error("模拟正式发布磁盘错误"); }
      write(file, content);
    };
    assert.throws(() => service.apply(run.id, input), /磁盘错误/);
    assert.equal(store.currentRevisionId("b") !== null, !existing, "新节点仅写入准备指针");
    const item = store.readRun(run.id).items.find(item => item.nodeId === "b")!;
    // 模拟旧版本已经落盘的矛盾回执，不能让恢复请求反向采用已拒绝内容。
    store.updateRun(run.id, latest => {
      latest.dismissals = [{ nodeId: "b", revisionId: item.revisionId!, baseHash: item.expectedHash, fingerprint: item.maintenanceFingerprint!, userId: "owner", createdAt: Date.now() }];
    });
    assert.throws(() => service.apply(run.id, input), /已明确不采用/);
    assert.equal(service.cancelAdoption(run.id, input.requestId, "owner").adoptions?.[0]?.cancelled, true);
    assert.equal(store.currentRevisionId("b"), null);
    const next = begin(); service.start(next.id); await settle(service, next.id);
    assert.equal(service.apply(next.id, adoption(service.preview(next.id))).adoptions?.[0]?.completed, true);
  }
});

test("不采用只处理本版本，不吞掉生成之后的新来源变化", async t => {
  const { service, store, root, begin } = fixture(t, engine([node("a")]));
  const initial = store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const run = begin({ treeHash: initial.hash }); service.start(run.id);
  const result = await settle(service, run.id);
  const frozen = result.items[0]!.maintenanceFingerprint;
  fs.appendFileSync(path.join(root, "src", "a.ts"), "// 新变化\n", "utf8");
  await service.dismiss(run.id, "a", result.items[0]!.revisionId!, "owner");
  assert.equal(store.readRun(run.id).dismissals?.[0]?.fingerprint, frozen);
  assert.notEqual(await store.maintenanceFingerprint("a"), frozen);
  assert.equal(store.detail("a").drafts.length, 0);
  assert.equal(service.preview(run.id).items[0]?.dismissed, true);
});

test("未写入来源漂移后可终止采用，保留可见结果并解除项目采用门禁", async t => {
  for (const existing of [false, true]) {
    const generated = [node("a"), node("b")];
    const execute = engine(generated);
    const { service, store, root, begin } = fixture(t, async input => {
      if (input.purpose !== "planning" && input.purpose !== "review" && input.title === "核心流程") {
        const evidence = await tool<{ path: string; contentHash: string }>(input, "knowledge.source.read", { path: "src/b.ts", count: 1 });
        await tool(input, "knowledge.asset.submit", { content: "# 第二个机制", summary: "b", sources: [{ kind: "code", ...evidence, startLine: 1, endLine: 1, relation: "第二个机制" }] });
      } else await execute(input);
    });
    fs.writeFileSync(path.join(root, "src", "b.ts"), "export const other = true;\n", "utf8");
    if (existing) {
      store.saveTree({ schemaVersion: 2, instructions: "", nodes: generated }, null);
      for (const target of generated) store.saveDocument({ nodeId: target.id, expectedHash: null, content: "# 原正文", origin: "manual", sources: [{ kind: "requirement", requirement: "人工维护", relation: "原内容" }] });
    }
    const before = store.readTree().hash;
    const run = begin(); service.start(run.id); await settle(service, run.id);
    const input = adoption(service.preview(run.id));
    const write = store.files.write.bind(store.files);
    let failed = false;
    store.files.write = (file, content) => {
      if (!failed && file.endsWith("/assets/b/current.json")) { failed = true; throw new Error("模拟未写入项磁盘错误"); }
      write(file, content);
    };
    assert.throws(() => service.apply(run.id, input), /磁盘错误/);
    const aVersion = store.currentRevisionId("a");
    fs.appendFileSync(path.join(root, "src", "b.ts"), "// 仅未写入来源变化\n", "utf8");
    assert.throws(() => service.apply(run.id, input), /来源.*变化|来源已变化/);
    const result = service.cancelAdoption(run.id, input.requestId, "owner");
    assert.equal(result.adoptions?.[0]?.cancelled, true);
    assert.equal(result.adoptions?.[0]?.completed, false);
    assert.deepEqual(result.adoptions?.[0]?.appliedNodeIds, existing ? ["a"] : []);
    assert.equal(store.readTree().hash, before, "终止不发布候选树");
    assert.equal(store.currentRevisionId("a"), existing ? aVersion : null);
    assert.equal(store.revisions("a").length, existing ? 2 : 1, "历史版本仍保留");
    assert.throws(() => service.apply(run.id, input), /已终止/);
    assert.doesNotThrow(() => service.cancelAdoption(run.id, input.requestId, "owner"), "重复终止幂等");
    const retry = begin(); service.start(retry.id); await settle(service, retry.id);
    assert.equal(service.apply(retry.id, adoption(service.preview(retry.id))).adoptions?.[0]?.completed, true);
  }
});

test("默认架构引用可不采用，陈旧确认不生效且不发布分类根", async t => {
  const { service, store, begin } = fixture(t, async input => {
    const evidence = await source(input);
    if (input.purpose === "planning") await tool(input, "knowledge.plan.submit", { nodes: [{ ...node("ref", "reference"), reference: { path: "src/a.ts", adoptedContentHash: evidence.contentHash } }], generateNodeIds: [], decisions: [], rationale: "仅引用已有来源", gaps: architectureGaps });
  });
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const preview = service.preview(run.id);
  await assert.rejects(service.dismiss(run.id, "ref", null, "owner", "0".repeat(64)), /预览已变化/);
  await assert.rejects(service.dismiss(run.id, "ref", null, "owner"), /预览已变化/);
  await service.dismiss(run.id, "ref", null, "owner", preview.planHash);
  assert.equal(service.preview(run.id).items.every(item => item.dismissed && !item.canApply), true);
  assert.deepEqual(store.readRun(run.id).dismissals?.map(item => item.nodeId), ["ref"]);
  assert.equal(store.readTree().hash, null);
});

test("任务正文拒绝旧单篇与批量采用，旧已生效事实不会再次显示不采用", async t => {
  const { service, store, begin } = fixture(t, engine([node("a")]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id), revisionId = result.items[0]!.revisionId!;
  assert.throws(() => store.adopt("a", revisionId, null), /统一预览/);
  assert.throws(() => store.adoptMany(["a"]), /统一预览/);
  // 模拟升级前旧入口已写入的真实正式指针，读取必须承认历史事实。
  const revision = store.readRevision("a", revisionId).revision;
  const body = JSON.stringify(revision, null, 2) + "\n";
  store.files.write(`${store.root}/assets/a/current.json`, JSON.stringify({ revisionId, revisionHash: crypto.createHash("sha256").update(body).digest("hex") }));
  assert.equal(service.preview(run.id).items[0]?.applied, true);
  await assert.rejects(service.dismiss(run.id, "a", revisionId, "owner"), /尚未采用/);
});

test("默认架构草稿分别不采用，保留其余待处理项且全部不采用后退出待办", async t => {
  const { service, store, begin } = fixture(t, engine([node("a"), node("b")]));
  const run = begin(); service.start(run.id);
  const result = await settle(service, run.id);
  assert.equal(service.preview(run.id).items.every(item => item.canApply), true);
  await service.dismiss(run.id, "a", result.items.find(item => item.nodeId === "a")!.revisionId!, "owner");
  let preview = service.preview(run.id);
  assert.equal(preview.items.find(item => item.nodeId === "a")?.dismissed, true);
  assert.equal(preview.items.find(item => item.nodeId === "b")?.canApply, true);
  await service.dismiss(run.id, "b", result.items.find(item => item.nodeId === "b")!.revisionId!, "owner");
  preview = service.preview(run.id);
  assert.equal(preview.items.every(item => item.dismissed), true);
  assert.equal(preview.items.some(item => item.canApply || (!item.applied && !item.dismissed && item.reason !== "没有待采用子项")), false);
  assert.equal(store.readTree().hash, null);
});

test("生成后来源范围改变不能沿用旧候选的复检结论", async t => {
  const { service, store, root, begin } = fixture(t, engine([] , ["a"]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const run = begin({ reviewConfig: { enabled: true, model: null, effort: null } }); service.start(run.id);
  assert.equal((await settle(service, run.id)).items[0]?.review?.status, "passed");
  fs.mkdirSync(path.join(root, "extra"));
  const current = store.readTree();
  store.saveTree({ ...current.tree, nodes: current.tree.nodes.map(node => ({ ...node, sourceScope: ["src", "extra"] })) }, current.hash);
  const preview = service.preview(run.id);
  assert.equal(preview.items[0]?.canApply, false);
  assert.match(preview.items[0]!.reason!, /来源范围已变化/);
  assert.throws(() => service.apply(run.id, adoption(preview, ["a"])), /来源范围/);
});

test("单独复检的关注点不替代原文生成目标，通过后可统一采用确切草稿", async t => {
  const { service, store, begin } = fixture(t, engine([node("a")]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const generated = begin({ prompt: "重点解释权限边界" }); service.start(generated.id);
  const result = await settle(service, generated.id);
  const review = begin({ mode: "review", selectedNodeIds: ["a"], prompt: "核对失败恢复", reviewConfig: { enabled: true, model: null, effort: null } });
  service.start(review.id);
  assert.equal((await settle(service, review.id)).items[0]?.review?.status, "passed");
  const preview = service.preview(review.id);
  assert.equal(preview.items[0]?.canApply, true, JSON.stringify(preview));
  service.apply(review.id, adoption(preview));
  assert.equal(store.detail("a").current?.revision.id, result.items[0]?.revisionId);
  assert.equal(service.preview(generated.id).items[0]?.applied, true);
});

test("独立复检不采用同一确切草稿后，原任务和轻量草稿状态一致关闭", async t => {
  const { service, store, root, begin } = fixture(t, engine([node("a")]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const generated = begin(); service.start(generated.id);
  const result = await settle(service, generated.id), revisionId = result.items[0]!.revisionId!;
  fs.appendFileSync(path.join(root, "src", "a.ts"), "// 生成后的新变化\n", "utf8");
  assert.notEqual(await store.maintenanceFingerprint("a"), result.items[0]!.maintenanceFingerprint);
  const review = begin({ mode: "review", selectedNodeIds: ["a"], reviewConfig: { enabled: true, model: null, effort: null } }); service.start(review.id); await settle(service, review.id);
  await service.dismiss(review.id, "a", revisionId, "owner", service.preview(review.id).planHash);
  assert.equal(service.preview(generated.id).items[0]?.dismissed, true);
  assert.equal(service.preview(review.id).items[0]?.dismissed, true);
  assert.equal(store.detail("a").drafts.length, 0);
  assert.equal(store.snapshot().states[0]?.draftCount, 0);
  assert.equal(store.readRun(review.id).dismissals?.[0]?.fingerprint, result.items[0]!.maintenanceFingerprint);
  assert.equal(store.readRevision("a", revisionId).revision.id, revisionId, "版本历史仍保留");
  const newRun = begin(); service.start(newRun.id); await settle(service, newRun.id);
  assert.equal(service.preview(newRun.id).items[0]?.dismissed, false, "新版本不会被连带关闭");
});

test("自动项目发现遵守同来源不采用回执，人工重新构建仍可明确生成", async t => {
  const { service, store, begin } = fixture(t, engine([node("a")]));
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: [node("a")] }, null);
  const run = begin(); service.start(run.id);
  const first = await settle(service, run.id);
  await service.dismiss(run.id, "a", first.items[0]!.revisionId!, "owner");
  const automatic = begin({ maintenance: true, changePaths: ["src/a.ts"] }); service.start(automatic.id);
  assert.equal((await settle(service, automatic.id)).items.length, 0);
  const manual = begin(); service.start(manual.id);
  assert.equal((await settle(service, manual.id)).items[0]?.status, "completed");
  assert.equal(store.detail("a").current, null);
});

test("父目录来源范围变化不能使已有实时引用失效", async t => {
  for (const defaultDocument of [true, false]) {
    const directory = node("directory", "directory");
    const { service, store, root, begin } = fixture(t, engine([{ ...directory, sourceScope: ["other"] }], []));
    fs.mkdirSync(path.join(root, "other"));
    const reference = { ...node("ref", "reference", "directory"), title: defaultDocument ? "关键机制" : "已有专项资料", sourceScope: [], reference: { path: "src/a.ts", adoptedContentHash: store.readSource("src/a.ts").contentHash } };
    store.saveTree({ schemaVersion: 2, instructions: "", nodes: [directory, reference] }, null);
    const run = begin({ changePaths: ["src/a.ts"] }); service.start(run.id);
    const result = await settle(service, run.id);
    assert.equal(result.phase, "completed", JSON.stringify(result.error));
    const preview = service.preview(run.id);
    assert.equal(preview.items.find(item => item.nodeId === "directory")?.canApply, true);
    service.apply(run.id, adoption(preview, ["directory"]));
    assert.deepEqual(store.node("directory").sourceScope, ["other"]);
    assert.equal(store.detail("ref").reference?.state, "unchanged");
  }
});

test("部分采用后可以续跑剩余失败项，原规划基线仍保留", async t => {
  let failed = false;
  const execute = engine([node("a"), node("b")]);
  const { service, store, begin } = fixture(t, async input => {
    if (input.purpose !== "planning" && input.title === "核心流程" && !failed) { failed = true; throw new Error("首次失败"); }
    await execute(input);
  });
  const run = begin(); service.start(run.id);
  assert.equal((await settle(service, run.id)).items.find(item => item.nodeId === "b")?.status, "failed");
  service.apply(run.id, adoption(service.preview(run.id), ["a"]));
  service.start(run.id, { retryFailed: true });
  const result = await settle(service, run.id);
  assert.equal(result.items.find(item => item.nodeId === "b")?.status, "completed");
  assert.equal(store.readRun(run.id).treeHash, null);
  service.apply(run.id, adoption(service.preview(run.id), ["b"]));
  assert.equal(store.readTree().tree.nodes.length, 14);
});

test("正式结果全生效而回执失败后，来源继续变化仍能补记历史采用事实", async t => {
  const { service, store, root, begin } = fixture(t, engine([node("a")]));
  const run = begin(); service.start(run.id); await settle(service, run.id);
  const input = adoption(service.preview(run.id));
  const write = store.files.write.bind(store.files);
  let fail = true;
  store.files.write = (relative, content) => {
    if (fail && relative.endsWith("/plan.json") && JSON.parse(content).adoptions?.[0]?.completed) throw new Error("回执写入失败");
    write(relative, content);
  };
  assert.throws(() => service.apply(run.id, input), /回执写入失败/);
  assert.ok(store.readTree().hash);
  assert.ok(store.detail("a").current);
  assert.equal(store.readRun(run.id).adoptions?.[0]?.completed, false);
  fail = false;
  fs.appendFileSync(path.join(root, "src", "a.ts"), "// 后续正常变化\n", "utf8");
  assert.equal(service.apply(run.id, input).adoptions?.[0]?.completed, true);
  assert.equal(store.detail("a").freshness[0]?.state, "changed");
});

test("候选新节点的资产执行会话可继续修订，采用后再次修订按确切版本待处理", async t => {
  const execute = engine([node("a")]);
  const { service, store, root, begin, beforeCleanup } = fixture(t, async input => { if (input.purpose !== "planning") input.onThreadCreated("asset-execution"); await execute(input); });
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  beforeCleanup.push(() => db.db.close());
  db.workspaces.upsert({ id: "build-ws", title: "候选修订", path: root });
  const actor = { userId: "owner", permissionScope: "account" as const };
  const identity = { db, store, workspaceId: "build-ws", actor };
  createKnowledgeConversation({ ...identity, nodeId: null, engine: "codex", reservedThreadId: "project-owner" });
  const run = begin(); service.start(run.id); await settle(service, run.id);
  db.threads.create({ id: "asset-execution", workspaceId: "build-ws", title: "资产执行", engine: "codex", threadType: "orchestration", threadSubtype: "knowledge-assets" });
  const followup = (turnId: string) => createKnowledgeConversationTurn({ db, store, workspaceId: "build-ws", threadId: "asset-execution", turnId, engine: "codex", model: null, effort: null, prompt: "补充关键边界", isActive: () => true, trustedActor: actor })!;
  let turn = followup("before-adoption");
  assert.equal(turn.execute("knowledge.node.read", { nodeId: "a" }).ok, true);
  assert.throws(() => turn.execute("knowledge.plan.submit", {}), /未注册/);
  const evidence = { kind: "code", path: "src/a.ts", contentHash: store.readSource("src/a.ts").contentHash, startLine: 1, endLine: 1, relation: "实现" };
  fs.writeFileSync(path.join(root, "outside.md"), "补充的项目设计文档", "utf8");
  const read = turn.execute("knowledge.source.read", { path: "outside.md", count: 1 });
  assert.equal(read.ok, true);
  const outside = { ...evidence, kind: "document", path: "outside.md", contentHash: (read.output as { contentHash: string }).contentHash };
  const revisionCount = store.revisions("a").length;
  assert.throws(() => turn.execute("knowledge.asset.submit", { nodeId: "knowledge-architecture", expectedHash: null, content: "越界", summary: "", sources: [outside] }), /只能读写绑定知识/);
  assert.equal(store.revisions("a").length, revisionCount);
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "a", expectedHash: null, content: "# 第二稿", summary: "边界", sources: [outside] }).ok, true);
  turn.finish();
  const preview = service.preview(run.id);
  assert.equal(preview.items[0]?.canApply, true, JSON.stringify(preview));
  service.apply(run.id, adoption(preview));
  const first = store.detail("a").current!.revision.id;
  turn = followup("after-adoption");
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "a", expectedHash: store.currentHash("a"), content: "# 第三稿", summary: "继续修订", sources: [evidence] }).ok, true);
  turn.finish();
  const next = service.preview(run.id);
  assert.equal(next.items[0]?.applied, false);
  assert.equal(next.items[0]?.canApply, true, JSON.stringify(next));
  assert.notEqual(next.items[0]?.revisionId, first);
  assert.equal(store.detail("a").current!.revision.id, first);
  service.apply(run.id, adoption(next));
  assert.equal(store.detail("a").current!.content, "# 第三稿");
  turn = followup("dismiss-after-adoption");
  assert.equal(turn.execute("knowledge.asset.submit", { nodeId: "a", expectedHash: store.currentHash("a"), content: "# 第四稿", summary: "待判断的补充", sources: [evidence] }).ok, true);
  turn.finish();
  const fourth = service.preview(run.id).items[0]!;
  await service.dismiss(run.id, "a", fourth.revisionId!, "owner");
  assert.equal(service.preview(run.id).items[0]?.dismissed, true);
  assert.equal(store.detail("a").current!.content, "# 第三稿");
  assert.equal(store.detail("a").drafts.length, 0);
  const oldTurn = followup("before-owner-end");
  endKnowledgeConversation({ ...identity, threadId: "project-owner" });
  assert.throws(() => oldTurn.execute("knowledge.node.read", { nodeId: "a" }), /协作已结束/);
  connectKnowledgeConversation({ ...identity, threadId: "project-owner" });
  assert.throws(() => oldTurn.execute("knowledge.asset.submit", { nodeId: "a", expectedHash: store.currentHash("a"), content: "不应写入", summary: "", sources: [evidence] }), /旧执行回合失效/);
  oldTurn.finish();
});
