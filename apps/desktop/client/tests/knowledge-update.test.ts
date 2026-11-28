import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { computeNextCronTimeMs, type KnowledgeAssetSource, type WorkspaceId } from "@codeflowai/shared";
import { resetEngineModelCatalogRuntimeForTest, setEngineModelCatalogCustomModels } from "../src/engines/engineModelCatalogRuntime.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { handleKnowledgeAssetRequest } from "../src/app/handlers/knowledgeAssetHandlers.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import type { SendMessageInput } from "../src/engines/threadSession.js";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeUpdateService } from "../src/knowledge/knowledgeUpdateService.js";
import { knowledgeRepairInstructions, KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import { tickKnowledgeUpdates, dispatchKnowledgeUpdate } from "../src/knowledge/knowledgeUpdateScheduler.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { KnowledgeGenerationEngineInput, KnowledgeGenerationExecutor } from "../src/knowledge/knowledgeGenerationEngine.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

test("定时派发未应答期间持有活动门禁，迟到失败写回后才释放", async t => {
  const f = fixture(t);
  f.save();
  const gate = new WorkspaceOperationGate();
  const workspaceId = "update-workspace" as WorkspaceId;
  let rejectDispatch!: (error: Error) => void;
  const waiting = new Promise<never>((_resolve, reject) => { rejectDispatch = reject; });
  t.mock.method(KnowledgeUpdateService.prototype, "dueAt", () => Date.now());
  const tick = tickKnowledgeUpdates({ context: { db: f.db, workspaces: new Map([[workspaceId, f.root]]), clientId: "client-update", workspaceOperationGate: gate }, dispatch: () => waiting });
  assert.equal(gate.listActivities(workspaceId)[0]!.type, "knowledge_update_dispatch");
  rejectDispatch(new Error("injected late dispatch failure"));
  await assert.rejects(tick, /定时知识更新失败/);
  assert.deepEqual(gate.listActivities(workspaceId), []);
  assert.equal(f.updates.view().lastCheck!.outcome, "failed");
  assert.match(f.updates.view().lastCheck!.error!.message, /injected late dispatch failure/);
});

/** 使用真实项目文件、生成与复检服务，仅替换模型执行。 */
function fixture(t: TestContext, executor?: KnowledgeGenerationExecutor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-updates-"));
  const generationDb = openClientDb({ dbPath: path.join(root, "generation.db") });
  generationDb.workspaces.upsert({ id: "update-workspace" as any, title: "维护", path: root });
  t.after(() => { generationDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const enabled = true;\n", "utf8");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "按真实代码写作", nodes: ["root", "changed", "same", "empty", "draft", "outside", "archived"].map(id => ({ id, title: id, parentId: ["root", "outside", "archived"].includes(id) ? null : "root", orderKey: id, summary: "", tags: [], instructions: "", sourceScope: ["src"], ...(id === "archived" ? { archived: true } : {}) })) }, null);
  const calls: KnowledgeGenerationEngineInput[] = [];
  let owners = 0;
  const generation = new KnowledgeGenerationService(store, "update-workspace", executor ?? (async input => {
    calls.push(input);
    input.onThreadCreated(`execution-${calls.length}`);
    const accepted = async (toolId: string, toolInput: unknown) => {
      const result = await input.execute({ toolId, toolInput, accessMode: "read-only" });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.ok ? result.output as Record<string, unknown> : {};
    };
    if (input.purpose === "review") await accepted("knowledge.review.read", { startLine: 1, count: 500 });
    const evidence = await accepted("knowledge.source.read", { path: "src/feature.ts", startLine: 1, count: 1 });
    const sources = [{ kind: "code", path: "src/feature.ts", contentHash: evidence.contentHash, startLine: 1, endLine: 1, relation: "功能状态" }];
    await accepted(input.purpose === "review" ? "knowledge.review.submit" : "knowledge.asset.submit", input.purpose === "review" ? { outcome: "passed", summary: "已对照代码确认", sources, issues: [] } : { content: `# ${input.title}\n\n功能已启用。`, summary: "功能说明", sources });
  }), "request-update", () => ({ nodeId: null, activationVersion: 1 }), generationDb);
  const updates = new KnowledgeUpdateService(store, "client-update", "update-workspace", generationDb);
  const settings = (extra: Record<string, unknown> = {}) => ({ enabled: true, cronExpr: "* * * * *", timezone: "UTC", selectedNodeIds: ["changed", "empty"], includeDescendants: false, engine: "codex", model: "generation-model", effort: "high", concurrency: 2, prompt: "", reviewConfig: { enabled: true, model: "review-model", effort: "low", maxRounds: 2 }, ...extra });
  const save = (extra: Record<string, unknown> = {}) => updates.save(settings(extra), updates.view().hash, "client-update:workspace");
  const source: KnowledgeAssetSource = { kind: "code", path: "src/feature.ts", contentHash: store.readSource("src/feature.ts").contentHash, startLine: 1, endLine: 1, relation: "功能实现" };
  const document = (nodeId: string, adopt = true, instructions = store.effectiveInstructions(nodeId)) => store.saveDocument({ nodeId, content: `# ${nodeId}`, sources: [source], expectedHash: store.currentHash(nodeId), origin: "manual", instructions, adopt });
  const start = (scheduledAt?: number) => updates.start({ requestId: "request-update", generation, createOwner: () => `owner-${++owners}`, ...(scheduledAt === undefined ? {} : { scheduledAt }) });
  return { root, db: generationDb, store, generation, updates, calls, settings, save, source, document, start, get owners() { return owners; } };
}

/** 等待后台检查及资产批次结算，超时必须明确失败。 */
async function settled(f: ReturnType<typeof fixture>) {
  const deadline = Date.now() + 10_000;
  let view = f.updates.view(f.generation);
  while ((view.lastCheck?.outcome === "checking" || view.run?.active) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    view = f.updates.view(f.generation);
  }
  assert.notEqual(view.lastCheck?.outcome, "checking");
  assert.ok(!view.run?.active);
  return view;
}

test("归类后的历史产品正文只观察原资料，变化不会重复生成或触发项目发现", async t => {
  const f = fixture(t);
  const current = f.store.readTree();
  f.store.saveTree({ ...current.tree, schemaVersion: 3, nodes: [...knowledgeCategoryNodes(), ...current.tree.nodes.map(node => ({ ...node, parentId: node.parentId ?? "knowledge-product" }))] }, current.hash);
  f.document("changed");
  f.save({ selectedNodeIds: [] });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: [], deferredCount: 0 });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(f.owners, 0);
  assert.equal(f.calls.length, 0);
});

test("计划保存在项目，执行绑定由当前 Client 决定，空库和错误配置显式拒绝", t => {
  const f = fixture(t);
  assert.equal(f.updates.view().schedule, null);
  const saved = f.save({ executorClientId: "forged-client", selectedWorkspaceId: "forged-workspace" });
  assert.equal(saved.schedule?.executorClientId, "client-update");
  assert.equal(saved.schedule?.selectedWorkspaceId, "client-update:workspace");
  assert.equal(saved.schedule?.reviewConfig.enabled, true);
  assert.equal(saved.schedule?.reviewConfig.autoRepair, true);
  assert.ok(fs.existsSync(path.join(f.root, f.store.root, "update-schedule.json")));
  assert.equal(new KnowledgeUpdateService(new KnowledgeAssetStore(f.root), "other-client", "update-workspace", f.db).dueAt(Date.now() + 120_000), null);
  assert.throws(() => f.updates.save(f.settings(), null, "ws"), /计划已变化/);
  assert.throws(() => f.save({ concurrency: 0 }), /并发数/);
  assert.throws(() => f.save({ cronExpr: "bad cron" }), /cron/);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-update-empty-"));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  const empty = new KnowledgeUpdateService(new KnowledgeAssetStore(emptyRoot), "client", "update-workspace", f.db);
  assert.equal(empty.view().schedule, null);
  assert.equal(fs.readdirSync(emptyRoot).length, 0);
  assert.throws(() => empty.save(f.settings(), null, "ws"), /先生成知识库目录/);
});

test("规格维护以现行长期要求建立基线，代码冲突只记录检查结论，权威要求变化才生成候选", async t => {
  const calls: string[] = [];
  const formalContent = "# 开关要求\n\n开关须启用。\n\n" + "历史说明\n".repeat(8_000) + "规格末尾。";
  let generatedContent = formalContent;
  const f = fixture(t, async input => {
    calls.push(input.purpose ?? "generation");
    const tool = (toolId: string, toolInput: unknown) => input.execute({ toolId, toolInput, accessMode: "read-only" });
    const accepted = async (toolId: string, toolInput: unknown) => {
      const result = await tool(toolId, toolInput);
      assert.ok(result.ok, JSON.stringify(result));
      return result.output as Record<string, unknown>;
    };
    const readCode = async () => {
      const code = await accepted("knowledge.source.read", { path: "src/feature.ts", count: 1 });
      return { kind: "code", path: code.path, contentHash: code.contentHash, startLine: 1, endLine: 1, relation: "开关实现" };
    };
    const submitPlan = (sources: unknown[], gaps: string[] = []) => tool("knowledge.plan.submit", {
      nodes: [], generateNodeIds: sources.length ? ["same"] : [], rationale: "核对开关要求", gaps,
      decisions: sources.length ? [{ nodeId: "same", question: "开关规则是否变化", whyGenerate: "核对开关默认值", sources }] : [],
    });
    if (input.purpose === "planning") {
      await accepted("knowledge.source.read", { path: "src/unrelated.md", count: 1 });
      assert.equal((await submitPlan([])).ok, false, "未读取正式规格时不能将核对收为无变更");
      if (calls.length === 1) {
        await readCode();
        await accepted("knowledge.source.read", { path: "src/notes.md", count: 1 });
        await accepted("knowledge.node.read", { nodeId: "same", offset: 80_000 });
        assert.equal((await submitPlan([])).ok, false, "读到空页不能算作读过正式正文");
      }
      const document = await accepted("knowledge.node.read", { nodeId: "same" });
      if (calls.length === 1) {
        assert.equal((await submitPlan([])).ok, false, "只读首屏不能结束规格核对");
      }
      await accepted("knowledge.node.read", { nodeId: "same", offset: document.nextOffset });
      if (calls.length === 1) {
        const source = await readCode();
        const notes = await accepted("knowledge.source.read", { path: "src/notes.md", count: 1 });
        assert.equal((await submitPlan([source])).ok, false, "代码变化本身不能授权生成规格候选");
        assert.equal((await submitPlan([{ ...source, kind: "document" }])).ok, false, "给代码改标签也不能作为规则文档");
        assert.equal((await submitPlan([{ ...source, kind: "document", path: notes.path, contentHash: notes.contentHash }])).ok, false, "普通说明的文件变化不能作为规格依据");
        assert.ok((await submitPlan([], ["实现与规格不一致：开关已关闭，现行规格仍要求启用。"])).ok);
      } else {
        assert.equal((await submitPlan([])).ok, false, "仅看无关资料和正式正文不能处理尚未读取的变更");
        const rules = await accepted("knowledge.source.read", { path: "src/AGENTS.md", count: 1 });
        const rule = { kind: "document", path: rules.path, contentHash: rules.contentHash, startLine: 1, endLine: 1, relation: "现行项目明确要求开关关闭" };
        assert.equal((await submitPlan([{ ...rule, startLine: 2, endLine: 2 }])).ok, false, "规则依据必须覆盖真实已读行段");
        assert.ok((await submitPlan([rule])).ok);
      }
      return;
    }
    const source = await readCode();
    await accepted("knowledge.source.read", { path: "src/AGENTS.md", count: 1 });
    if (input.purpose === "review") {
      await accepted("knowledge.review.read", { startLine: 1, count: 500 });
      await accepted("knowledge.review.submit", { outcome: "passed", summary: "已核对", sources: [source], issues: [] });
    } else {
      const rules = f.store.readSource("src/AGENTS.md", 1, 1);
      assert.equal((await tool("knowledge.asset.submit", { content: generatedContent, summary: "代码变化", sources: [source] })).ok, false);
      await accepted("knowledge.asset.submit", { content: generatedContent, summary: "核对开关要求",
        sources: [{ ...source, kind: "document", path: rules.path, contentHash: rules.contentHash, relation: "项目要求" }] });
    }
  });
  const rulesPath = path.join(f.root, "src", "AGENTS.md");
  fs.writeFileSync(rulesPath, "开关须启用。\n", "utf8");
  const notesPath = path.join(f.root, "src", "notes.md");
  fs.writeFileSync(notesPath, "本地演示。\n", "utf8");
  fs.writeFileSync(path.join(f.root, "src", "unrelated.md"), "示例。\n", "utf8");
  const current = f.store.readTree();
  f.store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(),
    ...current.tree.nodes.map(node => node.id === "same" ? { ...node, parentId: "knowledge-specifications", sourceScope: ["src/AGENTS.md", "src/notes.md"] }
      : { ...node, parentId: node.parentId ?? "knowledge-product" }),
  ] }, current.hash);
  const original = f.store.saveDocument({ nodeId: "same", content: formalContent, origin: "manual", expectedHash: null, adopt: true,
    instructions: "按上次复检报告修正一处引用路径", sources: [f.source,
      { ...f.source, kind: "document", path: "src/AGENTS.md", contentHash: f.store.readSource("src/AGENTS.md").contentHash, relation: "项目要求" }],
  });
  f.save({ selectedNodeIds: ["same"] });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.deepEqual(calls, []);

  fs.writeFileSync(path.join(f.root, "src", "feature.ts"), "export const enabled = false;\n", "utf8");
  fs.writeFileSync(notesPath, "本地演示可以关闭开关。\n", "utf8");
  f.start();
  const conflict = (await settled(f)).run!;
  assert.equal(conflict.phase, "completed");
  assert.match(conflict.gaps[0] ?? "", /实现与规格不一致/);
  assert.deepEqual(f.generation.preview(conflict.id).items, []);
  f.start();
  const next = await settled(f);
  assert.equal(next.lastCheck?.outcome, "unchanged");
  assert.equal(next.run?.id, conflict.id, "没有新的变更时仍可查看上次的冲突");
  assert.deepEqual(calls, ["planning"]);

  const observed = f.store.readTree();
  f.store.saveTree({ ...observed.tree, nodes: observed.tree.nodes.map(node => node.id === "same" ? { ...node, sourceScope: ["src"] } : node) }, observed.hash);
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged", "仅调整资料扫描范围没有改变规格要求");
  assert.deepEqual(calls, ["planning"]);

  fs.writeFileSync(rulesPath, "开关须启用。\n调整排版说明。\n", "utf8");
  f.start();
  const noChange = (await settled(f)).run!;
  assert.equal(noChange.phase, "completed");
  assert.deepEqual(noChange.items, []);
  assert.deepEqual(f.generation.preview(noChange.id).items, []);
  assert.equal(f.store.revisions("same").length, 1);

  fs.writeFileSync(rulesPath, "开关须关闭。\n第二条规则不变。\n", "utf8");
  generatedContent = "# 开关要求\n\n开关须关闭。";
  f.start();
  const update = (await settled(f)).run!;
  assert.deepEqual(calls, ["planning", "planning", "generation", "planning", "generation", "review"]);
  assert.ok(update.items[0]?.revisionId);
  assert.equal(f.generation.preview(update.id).items[0]?.canApply, true);
  assert.equal(f.store.detail("same").current?.revision.id, original.id);
});

test("维护摘要和领取不解析历史路径，后台完整校验分批让出且首错停止", async t => {
  const f = fixture(t);
  f.save();
  const scheduledAt = Date.now() - 120_000;
  const state = { scheduledAt, checkedAt: scheduledAt, outcome: "unchanged", runId: null, selectedCount: 0, deferredCount: 0, error: null,
    discovery: { schemaVersion: 1, files: Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`src/file-${index}.ts`, "a".repeat(64)])), pending: {}, requirements: {}, pendingRequirements: {} } };
  const stateFile = path.join(f.root, f.store.root, "update-state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  let checked = 0, checkedWhenYielded = 0;
  const sourcePath = t.mock.method(f.store, "sourcePath", (relative: string) => {
    checked++;
    if (checked === 1) setImmediate(() => { checkedWhenYielded = checked; });
    if (checked === 70) throw new Error("injected source validation failure");
    return relative;
  });
  const view = f.updates.view(f.generation);
  assert.equal(view.lastCheck?.outcome, "unchanged");
  assert.ok(!("discovery" in view.lastCheck!));
  assert.ok(f.updates.dueAt(Date.now() + 120_000));
  assert.equal(sourcePath.mock.callCount(), 0);
  assert.equal(f.start().lastCheck?.outcome, "checking");
  assert.equal(sourcePath.mock.callCount(), 0);
  const failed = await settled(f);
  assert.equal(failed.lastCheck?.outcome, "failed");
  assert.match(failed.lastCheck?.error?.message ?? "", /injected source validation failure.*request-update/);
  assert.equal(sourcePath.mock.callCount(), 70);
  assert.ok(checkedWhenYielded > 0 && checkedWhenYielded < 70);
  assert.equal(f.owners, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).discovery, state.discovery);
});

test("维护摘要拒绝损坏协议与越界路径，敏感来源在后台检查时失败且不生成", async t => {
  const f = fixture(t);
  f.save();
  const state = { scheduledAt: Date.now(), checkedAt: Date.now(), outcome: "unchanged", runId: null, selectedCount: 0, deferredCount: 0, error: null,
    discovery: { schemaVersion: 1, files: { "../escape.ts": "a".repeat(64) } as Record<string, string>, pending: {}, requirements: {}, pendingRequirements: {} } };
  const stateFile = path.join(f.root, f.store.root, "update-state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  assert.throws(() => f.updates.view(), /项目内的相对路径/);
  state.discovery.files = { "src/feature.ts": "invalid-hash" };
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  assert.throws(() => f.updates.view(), /项目发现基线损坏/);
  state.discovery.files = { "env/.env": "a".repeat(64) };
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  assert.equal(f.updates.view().lastCheck?.outcome, "unchanged");
  assert.equal(f.start().lastCheck?.outcome, "checking");
  const failed = await settled(f);
  assert.equal(failed.lastCheck?.outcome, "failed");
  assert.match(failed.lastCheck?.error?.message ?? "", /不属于可读取的知识证据范围/);
  assert.equal(f.owners, 0);
  assert.equal(f.calls.length, 0);
});

test("新增的默认架构空节点不触发定时生成，采用后继续按来源变化维护", async t => {
  const f = fixture(t);
  const current = f.store.readTree();
  f.store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(),
    ...current.tree.nodes.map(node => ({ ...node, parentId: node.parentId ?? "knowledge-product" })),
  ] }, current.hash);
  f.save({ selectedNodeIds: ["knowledge-architecture"], includeDescendants: true });
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: [], deferredCount: 0 });
  f.document("knowledge-architecture-overview");
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, []);
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["knowledge-architecture-overview"]);
});

test("增量检查覆盖来源变化、删除和要求变化，并暂缓草稿和归档范围", async t => {
  const f = fixture(t);
  f.document("root"); f.document("changed"); f.document("same"); f.document("draft", false);
  f.save({ selectedNodeIds: ["root", "archived"], includeDescendants: true });
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: ["empty"], deferredCount: 1 });
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["root", "changed", "same", "empty"]);
  fs.unlinkSync(path.join(f.root, "src/feature.ts"));
  assert.ok((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds.includes("changed"));
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = true;\n", "utf8");
  f.save({ selectedNodeIds: ["same"], prompt: "新增确认要求" });
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["same"]);
});

test("检查立即应答、重复点击合并，生成与复检沿用配置且绝不自动采用", async t => {
  const f = fixture(t);
  const original = f.document("changed");
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  f.save();
  const accepted = f.start();
  assert.equal(accepted.lastCheck?.outcome, "checking");
  assert.equal(f.calls.length, 0);
  f.start(); f.start();
  const result = await settled(f);
  assert.equal(f.owners, 1);
  assert.equal(result.run?.phase, "completed", JSON.stringify(result.lastCheck));
  assert.deepEqual(result.run?.items.map(item => item.nodeId), ["changed", "empty"]);
  assert.ok(result.run?.items.every(item => item.status === "completed" && item.review?.status === "passed"));
  assert.equal(result.run?.concurrency, 2);
  assert.equal(f.calls.filter(call => call.purpose !== "review").every(call => call.model === "generation-model" && call.effort === "high"), true);
  assert.equal(f.calls.filter(call => call.purpose === "review").every(call => call.model === "review-model" && call.effort === "low"), true);
  assert.equal(f.store.detail("changed").current?.revision.id, original.id);
  assert.equal(f.store.detail("empty").current, null);
  assert.equal(f.store.detail("empty").drafts.length, 1);
});

test("多轮自动修订采用后不因系统修订说明重复更新，用户要求变化仍会触发", async t => {
  let generated = 0, reviewed = 0;
  const f = fixture(t, async input => {
    const accepted = async (toolId: string, toolInput: unknown) => {
      const result = await input.execute({ toolId, toolInput, accessMode: "read-only" });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.ok ? result.output as Record<string, unknown> : {};
    };
    if (input.purpose === "review") await accepted("knowledge.review.read", { startLine: 1, count: 500 });
    else {
      generated++;
      const item = f.store.readRun(input.runId).items[0]!;
      if (item.repairReportId) await accepted("knowledge.review.report.read", { nodeId: item.nodeId, reportId: item.repairReportId, offset: 0 });
    }
    const read = await accepted("knowledge.source.read", { path: "src/feature.ts", count: 1 });
    const sources = [{ kind: "code", path: read.path, contentHash: read.contentHash, startLine: 1, endLine: 1, relation: "功能实现" }];
    if (input.purpose !== "review") await accepted("knowledge.asset.submit", { content: `# 功能\n\n修订版本 ${generated}`, summary: "功能机制", sources });
    else {
      const issues = ++reviewed < 3 ? [{ id: "factual", severity: "error", category: "factual", title: "功能范围错误", detail: "说明需要收窄", documentStartLine: 3, documentEndLine: 3, sources, suggestion: "按源码收窄保证" }] : [];
      await accepted("knowledge.review.submit", { outcome: issues.length ? "issues" : "passed", summary: "核对范围", sources, issues });
    }
  });
  f.save({ selectedNodeIds: ["empty"], reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 3 } });
  f.start();
  const run = (await settled(f)).run!;
  assert.equal(run.items[0]?.review?.status, "passed");
  assert.equal(generated, 3);
  const preview = f.generation.preview(run.id);
  f.generation.apply(run.id, { requestId: "adopt-repaired", treeHash: preview.treeHash, planHash: preview.planHash, selections: preview.items.map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: [], deferredCount: 0 });
  f.start(); assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(generated, 3);
  f.save({ selectedNodeIds: ["empty"], prompt: "补充新的业务要求" });
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["empty"]);
  const older = new KnowledgeReviewStore(f.store).list("empty").find(report => report.outcome === "issues" && report.id !== run.items[0]!.repairReportId)!;
  assert.ok(older);
  fs.unlinkSync(path.join(f.root, f.store.root, "assets/empty/reviews", `${older.id}.json`));
  await assert.rejects(f.updates.selectTargets(f.updates.schedule()!), error => error instanceof Error && error.message.includes("修订依据缺失或不一致") && error.message.includes(older.id));
});

test("单项续跑保留用户写入的真实历史报告说明，不把同格式用户要求当系统后缀删除", async t => {
  let generated = 0, reviewed = 0;
  const f = fixture(t, async input => {
    const accepted = async (toolId: string, toolInput: unknown) => {
      const result = await input.execute({ toolId, toolInput, accessMode: "read-only" });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.ok ? result.output as Record<string, unknown> : {};
    };
    if (input.purpose === "review") await accepted("knowledge.review.read", { startLine: 1, count: 500 });
    else {
      generated++;
      if (generated === 3) throw new Error("injected repair generation failure");
      const item = f.store.readRun(input.runId).items[0]!;
      if (item.repairReportId) await accepted("knowledge.review.report.read", { nodeId: item.nodeId, reportId: item.repairReportId, offset: 0 });
    }
    const read = await accepted("knowledge.source.read", { path: "src/feature.ts", count: 1 });
    const sources = [{ kind: "code", path: read.path, contentHash: read.contentHash, startLine: 1, endLine: 1, relation: "功能实现" }];
    if (input.purpose !== "review") await accepted("knowledge.asset.submit", { content: `# 功能\n\n修订版本 ${generated}`, summary: "功能机制", sources });
    else {
      const issues = ++reviewed < 3 ? [{ id: "factual", severity: "error", category: "factual", title: "功能范围错误", detail: "说明需要收窄", documentStartLine: 3, documentEndLine: 3, sources, suggestion: "按源码收窄保证" }] : [];
      await accepted("knowledge.review.submit", { outcome: issues.length ? "issues" : "passed", summary: "核对范围", sources, issues });
    }
  });
  f.save({ selectedNodeIds: ["empty"], reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 3 } });
  f.start();
  const failed = (await settled(f)).run!;
  assert.equal(failed.items[0]?.status, "failed");
  assert.equal(generated, 3);
  const older = new KnowledgeReviewStore(f.store).list("empty").find(report => report.outcome === "issues" && report.id !== failed.items[0]!.repairReportId)!;
  assert.ok(older);
  const prompt = `保留用户明确要求的历史核对说明。${knowledgeRepairInstructions(older.id, older.revisionId)}`;
  f.generation.start(failed.id, { nodeIds: ["empty"], retryFailed: true, prompt });
  const completed = (await settled(f)).run!;
  assert.equal(completed.items[0]?.review?.status, "passed");
  assert.equal(generated, 4);
  assert.equal(f.store.readRun(failed.id).prompt, "", "单项要求不改变整批初始要求");
  const preview = f.generation.preview(completed.id);
  f.generation.apply(completed.id, { requestId: "adopt-user-requirements", treeHash: preview.treeHash, planHash: preview.planHash, selections: preview.items.map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });
  f.save({ selectedNodeIds: ["empty"], prompt });
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: [], deferredCount: 0 });
  f.save({ selectedNodeIds: ["empty"], prompt: "保留用户明确要求的历史核对说明。" });
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["empty"], "移除用户要求的历史说明仍是有效要求变化");
});

test("普通 AI 版本没有系统修订后缀时不依赖原任务文件", async t => {
  const f = fixture(t);
  f.store.saveDocument({ nodeId: "same", content: "# 已有知识", sources: [f.source], expectedHash: null, origin: "ai", instructions: f.store.effectiveInstructions("same"), runId: "run_unavailable", adopt: true });
  f.save({ selectedNodeIds: ["same"] });
  t.mock.method(f.store, "readRun", () => { throw new Error("普通版本不应读取历史任务"); });
  assert.deepEqual(await f.updates.selectTargets(f.updates.schedule()!), { nodeIds: [], deferredCount: 0 });
});

test("无变化不创建模型会话，保存期间停用会让尚未启动的检查明确失败", async t => {
  const f = fixture(t);
  f.document("same"); f.save({ selectedNodeIds: ["same"] });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(f.owners, 0); assert.equal(f.calls.length, 0);
  f.save(); f.start(); f.save({ enabled: false });
  assert.match((await settled(f)).lastCheck?.error?.message ?? "", /计划发生变化/);
  assert.equal(f.owners, 0);
});

test("来源范围内未引用文件的变化生成修订，草稿期间的新变化在采用后继续处理", async t => {
  const f = fixture(t);
  const internal = path.join(f.root, "src/internal.ts");
  fs.writeFileSync(internal, "export const version = 1;\n", "utf8");
  f.document("changed"); f.save({ selectedNodeIds: ["changed"] });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  fs.writeFileSync(internal, "export const version = 2;\n", "utf8");
  f.start();
  assert.equal((await settled(f)).run?.phase, "completed");
  const draft = f.store.detail("changed").drafts[0]!;
  assert.equal(f.calls.length, 2);
  fs.writeFileSync(internal, "export const version = 3;\n", "utf8");
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "busy");
  assert.equal(f.calls.length, 2);
  const preview = f.generation.preview(draft.runId!);
  f.generation.apply(draft.runId!, { requestId: "adopt-changed-draft", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: "changed", revisionId: draft.id }] });
  f.start();
  assert.equal((await settled(f)).run?.phase, "completed");
  assert.equal(f.calls.length, 4);
});

test("同一来源变化由各受影响节点分别消费，不会因先完成一个节点而漏掉暂缓节点", async t => {
  const f = fixture(t);
  const internal = path.join(f.root, "src/internal.ts");
  fs.writeFileSync(internal, "export const version = 1;\n", "utf8");
  f.document("changed"); f.document("same");
  const oldDraft = f.document("same", false);
  f.save({ selectedNodeIds: ["changed", "same"] });
  f.start(); await settled(f);
  fs.writeFileSync(internal, "export const version = 2;\n", "utf8");
  f.start();
  assert.deepEqual((await settled(f)).run?.items.map(item => item.nodeId), ["changed"]);
  f.store.adopt("same", oldDraft.id, f.store.currentHash("same"));
  f.start();
  const result = await settled(f);
  assert.deepEqual(result.run?.items.map(item => item.nodeId), ["same"]);
  assert.equal(f.calls.filter(call => call.purpose !== "review" && call.purpose !== "planning").length, 2);
});

test("全项目发现被暂缓后改为局部维护，不会越过选区启动项目规划", async t => {
  const f = fixture(t);
  for (const node of f.store.readTree().tree.nodes.filter(node => !node.archived)) f.document(node.id);
  f.save({ selectedNodeIds: [], includeDescendants: true });
  f.start(); await settled(f);
  f.document("same", false);
  fs.mkdirSync(path.join(f.root, "newmodule"));
  fs.writeFileSync(path.join(f.root, "newmodule/new.ts"), "export const feature = true;\n", "utf8");
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "busy");
  f.save({ selectedNodeIds: ["changed"], includeDescendants: false });
  const begin = t.mock.method(f.generation, "begin", () => { throw new Error("局部维护不得派发项目规划"); });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(begin.mock.callCount(), 0);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, f.store.root, "update-state.json"), "utf8"));
  assert.equal(state.discovery.pending["newmodule/new.ts"].discovery, true);
});

test("来源范围自身变化会触发维护，失败后不推进该节点的已处理范围指纹", async t => {
  const f = fixture(t, async () => { throw new Error("injected generation failure"); });
  fs.mkdirSync(path.join(f.root, "other"));
  fs.writeFileSync(path.join(f.root, "other/b.ts"), "export const existing = true;\n", "utf8");
  f.document("same"); f.save({ selectedNodeIds: ["same"] });
  f.start(); await settled(f);
  const stateFile = path.join(f.root, f.store.root, "update-state.json");
  const baseline = JSON.parse(fs.readFileSync(stateFile, "utf8")).discovery.requirements.same;
  const snapshot = f.store.readTree();
  f.store.saveTree({ ...snapshot.tree, nodes: snapshot.tree.nodes.map(node => node.id === "same" ? { ...node, sourceScope: ["src", "other"] } : node) }, snapshot.hash);
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["same"]);
  f.start();
  assert.equal((await settled(f)).run?.items[0]?.status, "failed");
  f.start(); await settled(f);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.discovery.requirements.same, baseline);
  assert.notEqual(state.discovery.pendingRequirements.same, baseline);
  assert.deepEqual((await f.updates.selectTargets(f.updates.schedule()!)).nodeIds, ["same"]);
});

test("目录与实时引用不补写正文，原文变化只更新观察状态", async t => {
  const f = fixture(t);
  const source = path.join(f.root, "guide.md");
  fs.writeFileSync(source, "# 使用说明\n", "utf8");
  const originalHash = f.store.readSource("guide.md").contentHash;
  const snapshot = f.store.readTree();
  f.store.saveTree({ ...snapshot.tree, schemaVersion: 2, nodes: snapshot.tree.nodes.map(node => node.id === "same"
    ? { ...node, contentMode: "reference", sourceScope: ["guide.md"], reference: { path: "guide.md", adoptedContentHash: originalHash }, parentId: null }
    : { ...node, contentMode: "directory" }) }, snapshot.hash);
  f.save({ selectedNodeIds: ["same", "root"], includeDescendants: true });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  fs.writeFileSync(source, "# 最新使用说明\n", "utf8");
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(f.calls.length, 0);
  assert.equal(f.owners, 0);
  assert.equal(f.store.readReference("same").state, "changed");
  assert.equal(f.store.node("same").reference?.adoptedContentHash, originalHash);
  assert.equal(f.store.detail("same").drafts.length, 0);
});

test("项目发现覆盖已有来源范围之外的新模块，价值筛选无输出后不重复启动", async t => {
  const f = fixture(t);
  for (const node of f.store.readTree().tree.nodes.filter(node => !node.archived)) f.document(node.id);
  f.save({ selectedNodeIds: [], includeDescendants: true });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  fs.mkdirSync(path.join(f.root, "modules"));
  fs.writeFileSync(path.join(f.root, "modules/new.ts"), "export const newModule = true;\n", "utf8");
  const begin = f.generation.begin.bind(f.generation);
  let planningCalls = 0;
  t.mock.method(f.generation, "begin", (input: Parameters<typeof begin>[0]) => {
    planningCalls += 1;
    assert.equal(input.mode, "build");
    assert.equal(input.prompt, "");
    assert.deepEqual(input.selectedNodeIds, []);
    assert.deepEqual(input.changePaths, ["modules/new.ts"]);
    const run = begin({ ...input, mode: "batch", selectedNodeIds: ["same"] });
    f.store.saveRun({ ...run, mode: "build", phase: "completed", items: [], rationale: "当前变更无需新增长期知识" });
    return f.generation.view(run.id);
  });
  t.mock.method(f.generation, "startAsync", () => {});
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "started");
  assert.equal(planningCalls, 1);
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(planningCalls, 1);
  assert.equal(f.calls.length, 0);
});

test("历史引用候选冲突后明确不采用，解除后续项目发现的维护阻塞", async t => {
  const f = fixture(t);
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(f.root, `src/${name}.md`), `# ${name}`, "utf8");
  const guide = { ...f.store.node("root"), id: "guide", title: "原文引用", contentMode: "reference" as const, reference: { path: "src/a.md", adoptedContentHash: f.store.readSource("src/a.md").contentHash } };
  const original = f.store.readTree();
  f.store.saveTree({ ...original.tree, schemaVersion: 2, nodes: [...original.tree.nodes, guide] }, original.hash);
  for (const node of original.tree.nodes.filter(node => !node.archived)) f.document(node.id);
  f.save({ selectedNodeIds: [], includeDescendants: true });
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");

  const baseline = f.store.readTree();
  const old = f.generation.begin({ requestId: "old-reference-plan", mode: "build", ownerThreadId: "old-owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: baseline.hash, engine: "codex" });
  f.store.saveRun({ ...f.store.readRun(old.id), phase: "completed", proposedTree: { ...baseline.tree, nodes: baseline.tree.nodes.map(node => node.id === guide.id ? { ...guide, reference: { path: "src/b.md", adoptedContentHash: f.store.readSource("src/b.md").contentHash } } : node) } });
  const current = f.store.saveTree({ ...baseline.tree, nodes: baseline.tree.nodes.map(node => node.id === guide.id ? { ...guide, reference: { path: "src/c.md", adoptedContentHash: f.store.readSource("src/c.md").contentHash } } : node) }, baseline.hash);
  fs.mkdirSync(path.join(f.root, "modules"));
  fs.writeFileSync(path.join(f.root, "modules/new.ts"), "export const newModule = true;\n", "utf8");
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "busy");
  const preview = f.generation.preview(old.id);
  assert.equal(preview.items[0]?.canApply, false);
  assert.match(preview.items[0]?.reason ?? "", /其他操作修改/);
  await f.generation.dismiss(old.id, guide.id, null, "reviewer", preview.planHash);
  assert.equal(f.generation.preview(old.id).items[0]?.dismissed, true);
  assert.equal(f.store.readTree().hash, current.hash);

  const begin = f.generation.begin.bind(f.generation);
  let planningCalls = 0;
  t.mock.method(f.generation, "begin", (input: Parameters<typeof begin>[0]) => {
    planningCalls += 1;
    assert.equal(input.mode, "build");
    assert.deepEqual(input.changePaths, ["modules/new.ts"]);
    const run = begin(input);
    f.store.saveRun({ ...f.store.readRun(run.id), phase: "completed", proposedTree: current.tree, items: [] });
    return f.generation.view(run.id);
  });
  t.mock.method(f.generation, "startAsync", () => {});
  f.start();
  const resumed = await settled(f);
  assert.equal(resumed.lastCheck?.outcome, "started");
  assert.equal(resumed.lastCheck?.deferredCount, 0);
  assert.equal(planningCalls, 1);
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
  assert.equal(planningCalls, 1);
  assert.equal(f.calls.length, 0);
});

test("扫描失败不推进项目发现基线，也不启动后续生成", async t => {
  const f = fixture(t);
  f.document("same"); f.save({ selectedNodeIds: ["same"] });
  f.start(); await settled(f);
  const statePath = path.join(f.root, f.store.root, "update-state.json");
  const before = JSON.parse(fs.readFileSync(statePath, "utf8")).discovery;
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  t.mock.method(f.store, "listFiles", () => { throw Object.assign(new Error("injected scan permission denied"), { code: "EACCES" }); });
  f.start();
  const result = await settled(f);
  assert.equal(result.lastCheck?.outcome, "failed");
  assert.match(result.lastCheck?.error?.message ?? "", /scan permission denied/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).discovery, before);
  assert.equal(f.calls.length, 0);
});

test("失败摘要无法保存时保留可读失败态，修复存储后可以重新检查", async t => {
  const f = fixture(t);
  f.document("same"); f.save({ selectedNodeIds: ["same"] });
  const scanner = t.mock.method(f.store, "listFiles", () => { throw new Error("injected scan failure"); });
  const write = f.store.files.write.bind(f.store.files);
  const writer = t.mock.method(f.store.files, "write", (relative: string, body: string) => {
    if (relative.endsWith("update-state.json") && JSON.parse(body).outcome === "failed") throw new Error("injected summary write denied");
    return write(relative, body);
  });
  f.start();
  const failed = await settled(f);
  assert.equal(failed.lastCheck?.outcome, "failed");
  assert.equal(failed.lastCheck?.error?.code, "KNOWLEDGE_ASSET_STATE_WRITE_FAILED");
  assert.match(failed.lastCheck?.error?.message ?? "", /scan failure.*summary write denied.*仅保留在本次 Client/);
  assert.equal(f.calls.length, 0);
  scanner.mock.restore(); writer.mock.restore();
  f.start();
  assert.equal((await settled(f)).lastCheck?.outcome, "unchanged");
});

test("明确不采用的同一来源不再触发，后续来源变化可以重新评估", async t => {
  const f = fixture(t);
  f.document("same"); f.save({ selectedNodeIds: ["same"] });
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = false;\n", "utf8");
  f.start();
  const result = await settled(f);
  const run = f.store.readRun(result.run!.id);
  const item = run.items[0]!;
  f.store.saveRun({ ...run, dismissals: [{ nodeId: item.nodeId, revisionId: item.revisionId!, baseHash: f.store.currentHash(item.nodeId), fingerprint: await f.store.maintenanceFingerprint(item.nodeId), userId: "reviewer", createdAt: Date.now() }] });
  const updates = new KnowledgeUpdateService(new KnowledgeAssetStore(f.root), "client-update", "update-workspace", f.db);
  assert.deepEqual(await updates.selectTargets(updates.schedule()!), { nodeIds: [], deferredCount: 0 });
  fs.writeFileSync(path.join(f.root, "src/feature.ts"), "export const enabled = 'new behavior';\n", "utf8");
  assert.deepEqual(await updates.selectTargets(updates.schedule()!), { nodeIds: ["same"], deferredCount: 0 });
});

test("不采用判重仍跟踪扫描白名单外的正式引用来源，删除也会改变指纹", async t => {
  const f = fixture(t);
  const gradle = path.join(f.root, "build.gradle");
  fs.writeFileSync(gradle, "version = '1'\n", "utf8");
  f.store.saveDocument({ nodeId: "same", content: "# Gradle构建", sources: [{ kind: "code", path: "build.gradle", contentHash: f.store.readSource("build.gradle").contentHash, relation: "实际构建入口" }], expectedHash: null, origin: "manual", instructions: f.store.effectiveInstructions("same"), adopt: true });
  f.save({ selectedNodeIds: ["same"] });
  fs.writeFileSync(gradle, "version = '2'\n", "utf8");
  f.start();
  const result = await settled(f);
  const run = f.store.readRun(result.run!.id), item = run.items[0]!;
  const fingerprint = await f.store.maintenanceFingerprint("same");
  f.store.saveRun({ ...run, dismissals: [{ nodeId: "same", revisionId: item.revisionId!, baseHash: f.store.currentHash("same"), fingerprint, userId: "reviewer", createdAt: Date.now() }] });
  const updates = new KnowledgeUpdateService(new KnowledgeAssetStore(f.root), "client-update", "update-workspace", f.db);
  assert.deepEqual((await updates.selectTargets(updates.schedule()!)).nodeIds, []);
  fs.writeFileSync(gradle, "version = '3'\n", "utf8");
  assert.notEqual(await f.store.maintenanceFingerprint("same"), fingerprint);
  assert.deepEqual((await updates.selectTargets(updates.schedule()!)).nodeIds, ["same"]);
  fs.unlinkSync(gradle);
  assert.notEqual(await f.store.maintenanceFingerprint("same"), fingerprint);
  assert.deepEqual((await updates.selectTargets(updates.schedule()!)).nodeIds, ["same"]);
  fs.mkdirSync(gradle);
  await assert.rejects(f.store.maintenanceFingerprint("same"), /文件类型或大小不支持/);
});

test("项目扫描排除知识文件、依赖、产物、敏感文件和符号链接循环", async t => {
  const f = fixture(t);
  for (const directory of ["node_modules", "dist", ".next", ".tmp", ".playwright-mcp", "test-results", "playwright-report"]) {
    fs.mkdirSync(path.join(f.root, directory));
    fs.writeFileSync(path.join(f.root, directory, "ignored.ts"), Buffer.from([0xff, 0xfe]));
  }
  fs.writeFileSync(path.join(f.root, ".env"), "SAMPLE_SECRET=not-a-real-secret", "utf8");
  fs.writeFileSync(path.join(f.root, "credentials.json"), "{}", "utf8");
  fs.symlinkSync(f.root, path.join(f.root, "src/loop"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(Object.keys(await f.store.scanMaintenanceFiles()), ["src/feature.ts"]);
  const before = await f.store.maintenanceFingerprint("same");
  fs.writeFileSync(path.join(f.root, "src/unreferenced.ts"), "export const enabled = true;\n", "utf8");
  assert.notEqual(await f.store.maintenanceFingerprint("same"), before);
  assert.equal(typeof f.updates.view().defaultTimezone, "string");
});

test("空项目探测只读首个来源，完整扫描仍明确拒绝无效 UTF-8", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "src/z-broken.ts"), Buffer.from([0xff, 0xfe]));
  assert.deepEqual(Object.keys(await f.store.scanMaintenanceFiles({ firstOnly: true })), ["src/feature.ts"]);
  await assert.rejects(f.store.scanMaintenanceFiles(), /项目来源不是有效 UTF-8：src\/z-broken.ts/);
});

test("计划到点通过 Server 派发，离线周期合并且其他 Client/迁移工作区不重复运行", async t => {
  const f = fixture(t);
  f.save();
  const planFile = `${f.store.root}/update-schedule.json`;
  f.store.files.mutate(() => f.store.files.write(planFile, JSON.stringify({ ...f.updates.schedule(), updatedAt: Date.now() - 600_000 })));
  const now = Date.now();
  assert.ok(f.updates.dueAt(now));
  let dispatches = 0;
  const context = { db: f.db, workspaces: new Map([["update-workspace" as WorkspaceId, f.root]]), clientId: "client-update" };
  const dispatch = async (workspaceId: string, scheduledAt: number) => { dispatches++; assert.equal(workspaceId, "client-update:workspace"); return f.start(scheduledAt); };
  await tickKnowledgeUpdates({ context, dispatch });
  await tickKnowledgeUpdates({ context, dispatch });
  assert.equal(dispatches, 1);
  await settled(f);
  assert.equal(f.updates.dueAt(now), null);
  f.save({ enabled: false });
  assert.equal(f.updates.dueAt(now + 600_000), null);
  await tickKnowledgeUpdates({ context: { ...context, workspaceOperationGate: { getMigrationOperationId: () => "migration" } as any }, dispatch });
  assert.equal(dispatches, 1);
});

test("传输与鉴权失败写入可见失败摘要，不伪装成生成成功", async t => {
  const f = fixture(t); f.save();
  const planFile = `${f.store.root}/update-schedule.json`;
  f.store.files.mutate(() => f.store.files.write(planFile, JSON.stringify({ ...f.updates.schedule(), updatedAt: Date.now() - 120_000 })));
  await assert.rejects(tickKnowledgeUpdates({ context: { db: f.db, workspaces: new Map([["update-workspace" as WorkspaceId, f.root]]), clientId: "client-update" }, dispatch: async () => { throw new Error("Server denied request"); } }), AggregateError);
  assert.match(f.updates.view().lastCheck?.error?.message ?? "", /denied/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer test-key"); return new Response(JSON.stringify({ ok: false, message: "权限已撤销", code: "FORBIDDEN" }), { status: 403 }); };
  try { await assert.rejects(dispatchKnowledgeUpdate({ serverWsUrl: "ws://localhost:39280/ws/client", apiKey: "test-key", clientId: "client-update", workspaceId: "ws", scheduledAt: Date.now() }), /权限已撤销/); }
  finally { globalThis.fetch = originalFetch; }
});

test("检查已经被 Client 领取时，迟到的响应丢失不能覆盖真实任务状态", async t => {
  const f = fixture(t); f.save();
  const scheduledAt = Date.now();
  f.start(scheduledAt);
  f.updates.recordDispatchFailure(scheduledAt, { code: "CLIENT_TIMEOUT", message: "响应丢失" });
  assert.equal(f.updates.view().lastCheck?.outcome, "checking");
  const view = await settled(f);
  f.updates.recordDispatchFailure(scheduledAt, { code: "CLIENT_TIMEOUT", message: "迟到的失败" });
  assert.equal(f.updates.view().lastCheck?.runId, view.run?.id);
  assert.equal(f.updates.view().lastCheck?.outcome, "started");
});

test("项目检查复用现有分钟调度，关闭后不能启动引擎", async () => {
  let calls = 0;
  const context = { db: { listLocalScheduledTaskConfigs: () => [] } } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { serverWsUrl: "ws://localhost:39280" } as any, deviceId: "device",
    apiContext: context, localApiContext: context, tickProjectTasks: async () => { calls++; } });
  scheduler.start();
  await scheduler.syncAndTick("knowledge-only");
  assert.equal(calls, 1);
  scheduler.stop();
  assert.throws(() => scheduler.assertProjectTasksAccepting(), /正在关闭/);
  await assert.rejects(scheduler.syncAndTick("stopped"), /正在停止/);
});

test("项目计划失败不会阻挡独立账号任务，两种失败仍明确汇总返回", async () => {
  let accountTicks = 0;
  const scheduler = new ScheduledTaskScheduler({ config: { serverWsUrl: "ws://localhost:39280" } as any, deviceId: "device", apiContext: {} as any, tickProjectTasks: async () => { throw new Error("项目计划损坏"); } });
  Object.assign(scheduler, { syncExclusive: async () => {}, tick: async () => { accountTicks++; } });
  await assert.rejects(scheduler.syncAndTick("independent"), /项目计划损坏/);
  assert.equal(accountTicks, 1);
  scheduler.stop();
});

test("复用 cron 计算保留时区、每周与夏令时重复小时的语义", () => {
  assert.equal(new Date(computeNextCronTimeMs("0 3 * * 1", Date.parse("2026-10-15T04:00:00Z"), "UTC")).toISOString(), "2026-10-19T03:00:00.000Z");
  assert.equal(new Date(computeNextCronTimeMs("0 11 * * *", Date.parse("2026-10-15T02:59:00Z"), "Asia/Shanghai")).toISOString(), "2026-10-15T03:00:00.000Z");
  assert.equal(new Date(computeNextCronTimeMs("30 1 * * *", Date.parse("2026-11-01T05:40:00Z"), "America/New_York")).toISOString(), "2026-11-01T06:30:00.000Z");
});

test("真实 Client API 从保存计划到生成复检可闭环，专用会话进入本地知识列表", async t => {
  setEngineModelCatalogCustomModels(["generation-model", "review-model", "claude-model"].map((modelId, index) => ({
    id: `test:${modelId}`, engine: index === 2 ? "claude" : "codex", providerId: index === 2 ? "anthropic" : "openai", modelId, displayName: modelId,
    inputModalities: ["text"], supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: "high",
    contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false, enabled: true, createdAt: 1, updatedAt: 1,
  })));
  t.after(() => resetEngineModelCatalogRuntimeForTest());
  const f = fixture(t);
  const db = openClientDb({ dbPath: path.join(f.root, "client.db") });
  try {
    const workspaceId = "client-update:workspace" as WorkspaceId;
    db.workspaces.upsert({ id: workspaceId, title: "测试定时更新", path: f.root });
    const sent: Array<Record<string, any>> = [];
    const ctx = { db, clientId: "client-update", workspaces: new Map([[workspaceId, f.root]]), threads: new ThreadStore(), timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
      sessions: { getOrCreate() { return {
        getSessionId: () => null,
        resolvePlatformToolTransport: () => "native-dynamic",
        async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
        async sendMessage(input: SendMessageInput) {
          const accepted = async (toolId: string, toolInput: unknown) => { const result = await input.executeHostTool!({ toolId, toolInput, accessMode: "read-only" }); assert.equal(result.ok, true, JSON.stringify(result)); return result.ok ? result.output as Record<string, unknown> : {}; };
          const reviewing = input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.review.submit");
          if (reviewing) await accepted("knowledge.review.read", { startLine: 1, count: 500 });
          const source = await accepted("knowledge.source.read", { path: "src/feature.ts", startLine: 1, count: 1 });
          const sources = [{ kind: "code", path: source.path, contentHash: source.contentHash, startLine: 1, endLine: 1, relation: "功能代码" }];
          await accepted(reviewing ? "knowledge.review.submit" : "knowledge.asset.submit", reviewing ? { outcome: "passed", summary: "核对通过", issues: [], sources } : { content: "# 功能\n\n功能已启用。", summary: "真实工具提交", sources });
          return { responseText: "已提交" };
        },
      }; }, async disposeThread() {} }, send(message: Record<string, unknown>) { sent.push(message); },
    } as unknown as ApiHandlerContext;
    let requestSeq = 0;
    /** 通过正式分发边界调用，保留 Server 覆盖的可信 actor。 */
    const request = async (action: string, body: Record<string, unknown> = {}) => {
      const id = `request-api-${++requestSeq}`;
      await handleKnowledgeAssetRequest(ctx, { t: "api.req", id, method: `knowledge.assets.${action}`, path: `/knowledge/assets/${action}`, body: { workspaceId, actorContext: { userId: "update-user", accountRole: "personal_normal", enterpriseId: null, requestId: id, permissionScope: "account" }, ...body } } as ApiRequestMessage);
      const response = sent.find(message => message.t === "api.res" && message.id === id)!;
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.body.data;
    };
    await request("update.save", { expectedHash: null, schedule: f.settings({ selectedNodeIds: ["empty"] }) });
    const accepted = await request("update.run");
    assert.equal(accepted.lastCheck.outcome, "checking");
    let view = accepted;
    const deadline = Date.now() + 10_000;
    while ((view.lastCheck?.outcome === "checking" || view.run?.active) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15));
      view = await request("update.schedule");
    }
    assert.equal(view.run?.phase, "completed", JSON.stringify(view));
    assert.equal(view.run.items[0].review.status, "passed");
    const conversations = await request("conversation.list");
    assert.equal(conversations.length, 1);
    assert.match(conversations[0].title, /定时更新/);
    assert.equal(db.threads.get(view.run.items[0].executionThreadId)?.threadSubtype, "knowledge-assets");
    assert.equal(db.threads.get(view.run.items[0].review.executionThreadId)?.threadSubtype, "knowledge-review");
    assert.equal(view.run.items[0].review.parentThreadId, view.run.items[0].executionThreadId);
    assert.notEqual(view.run.items[0].executionThreadId, view.run.items[0].review.executionThreadId);
    assert.equal(f.store.detail("empty").current, null);
  } finally { db.db.close(); }
});
