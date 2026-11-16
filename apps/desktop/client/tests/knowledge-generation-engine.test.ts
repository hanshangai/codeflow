import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION, MANUAL_TURN_INTERRUPT_CODE, type ConversationEventInput, type KnowledgeAssetSource } from "@codeflowai/shared";
import { createKnowledgeGenerationExecutor, type KnowledgeGenerationEngineInput } from "../src/knowledge/knowledgeGenerationEngine.js";
import { applyEngineModelCatalogSnapshot, getActiveEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeAssetError } from "../src/knowledge/knowledgeAssetFiles.js";
import { KnowledgeGenerationService, stopKnowledgeGenerationForUpdate } from "../src/knowledge/knowledgeGenerationService.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import { resolveClaudePermissionLaunchMode } from "../src/engines/claude/claudeCli.js";
import { flushClientLogger, logger } from "../src/logger.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

test.beforeEach(() => applyEngineModelCatalogSnapshot({
  schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1,
  rows: ["codex", "claude"].map(engine => ({
    catalogItemId: `test:${engine}`, engine, providerId: engine === "codex" ? "openai" : "anthropic",
    providerLabel: engine, modelId: engine === "codex" ? "model" : "claude-model", displayName: engine, description: "",
    inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "high", description: "高" }],
    defaultReasoningEffort: "high", contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false,
    supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native",
    transportModelId: null, fastTaskModelId: null, subagentModelId: null,
  })),
}));
test.afterEach(() => resetEngineModelCatalogRuntimeForTest());

test("知识执行器在真实Writer下创建与复用线程，provider与清理等待不持许可且终态排空", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-engine-writer-")), dbPath = path.join(root, "client.db");
  const application = openClientDb({ dbPath }), workspaceId = "knowledge:writer" as any;
  application.workspaces.upsert({ id: workspaceId, title: "知识", path: root });
  application.configureWorkspaceLogResolver(id => id === workspaceId ? root : null);
  const db = application.forWorkspace(workspaceId);
  db.threads.create({ id: "owner" as any, workspaceId, engine: "codex", title: "owner", threadType: "chat", threadSubtype: "knowledge-conversation" });
  const writer = new ClientDbWriterService({ db: application, dbPath, onFatalError(error) { assert.fail(error); } });
  const events: ConversationEventInput[] = [];
  let flushes = 0, sends = 0;
  const deps: any = { db, threads: { get: () => null, create: (value: unknown) => value }, timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
    withLegacyDatabase: (requestId: string, operation: () => unknown) => writer.withLegacyDatabase(requestId, operation),
    async flushLocalEvents() { flushes++; }, emitConversation(event: ConversationEventInput) { events.push(event); }, emitRaw() {},
    sessions: { getOrCreate() { db.threads.get("owner" as any); return {
      resolvePlatformToolTransport: () => "native-dynamic", async sendMessage(_input: unknown, sink: any) {
        assert.throws(() => db.threads.get("owner" as any), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/); sends++; await sink.flush(); return {};
      }, async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
    }; }, async disposeThread() { assert.throws(() => db.threads.get("owner" as any), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/); } },
  };
  try {
    await writer.ready();
    const executor = createKnowledgeGenerationExecutor(deps);
    const input: KnowledgeGenerationEngineInput = { workspaceId, runId: "writer-run", ownerThreadId: "owner", title: "验证", engine: "codex", model: "model", effort: "high",
      prompt: "验证数据库准入", instructions: "", registry: { tools: [] } as any, execute: async () => ({ ok: true } as any), signal: new AbortController().signal, onThreadCreated() {} };
    await executor(input);
    await executor({ ...input, purpose: "review", reviewParent: { threadId: null, model: "model", effort: "high", onThreadCreated() {}, completionSummary: () => "完成" } });
    assert.equal(sends, 2);
    assert.ok(flushes >= 8);
    assert.equal(events.filter(event => event.type === "turn.completed").length, 2);
    assert.ok(events.some(event => event.type === "item.subagent.completed"));
    fs.writeFileSync(path.join(root, "source.ts"), "export const enabled = true;\n", "utf8");
    const store = new KnowledgeAssetStore(root);
    store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "asset", title: "知识", parentId: null, orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
    deps.sessions.getOrCreate = () => ({ resolvePlatformToolTransport: () => "native-dynamic",
      async sendMessage(message: any, sink: any) {
        assert.throws(() => db.threads.get("owner" as any), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/);
        const source = await message.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "source.ts", count: 1 } });
        const result = await message.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: { content: "# 已验证知识", summary: "依据源码", sources: [{ kind: "code", path: "source.ts", contentHash: source.output.contentHash, startLine: 1, endLine: 1, relation: "实现" }] } });
        assert.equal(result.ok, true, JSON.stringify(result));
        await sink.flush(); return {};
      }, async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
    });
    const service = new KnowledgeGenerationService(store, workspaceId, executor, "writer-background", () => {
      assert.ok(db.threads.get("owner" as any));
      return { nodeId: null, activationVersion: 1 };
    }, db, (requestId, operation) => writer.withLegacyDatabase(requestId, operation));
    const run = await writer.withLegacyDatabase("writer-begin", () => service.begin({ requestId: "background", mode: "batch", ownerThreadId: "owner", selectedNodeIds: ["asset"], includeDescendants: false, strategy: "all", prompt: "按当前源码说明", treeHash: store.readTree().hash, engine: "codex", model: "model", effort: "high", reviewConfig: { enabled: false, model: null, effort: null } }));
    await writer.withLegacyDatabase("writer-start", () => service.startAsync(run.id));
    const deadline = Date.now() + 5000;
    let view;
    do {
      view = await writer.withLegacyDatabase("writer-view", () => service.view(run.id));
      if (!view.active) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    if (view.phase !== "completed") await stopKnowledgeGenerationForUpdate(root, { requestId: "writer-background-failure" });
    assert.equal(view.phase, "completed", JSON.stringify(view.error ?? view.items));
  } finally { await writer.close(); application.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

/** 按对象身份核对因果树，包含实际 falsy 拒绝值，不用文案猜原因。 */
function failureContains(value: unknown, expected: unknown): boolean {
  return Object.is(value, expected) || value instanceof AggregateError && value.errors.some(error => failureContains(error, expected));
}

test("知识任务等待数据库许可期间取消，不创建宿主或执行线程", async () => {
  for (const review of [false, true]) {
    const f = fixture(), controller = new AbortController();
    f.deps.withLegacyDatabase = async (_requestId: string, operation: () => unknown) => { controller.abort(); return operation(); };
    await assert.rejects(f.execute(input({ signal: controller.signal, ...(review ? { purpose: "review", reviewParent: { threadId: null, model: "model", effort: "high", onThreadCreated() {}, completionSummary: () => "" } } : {}) })), { code: "KNOWLEDGE_ASSET_INTERRUPTED" });
    assert.equal(f.created.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

for (const scalar of ["429 Too Many Requests", 429]) for (const diagnostic of [false, true]) test(`F1 标量 ${typeof scalar} 429 保留三次尝试，诊断拒写=${diagnostic}`, async t => {
  const { f, store, service, begin, db } = projectFixture(t), logError = new Error("scalar-429-log");
  let sends = 0;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => assert.fail("429 不额外中断"),
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    sendMessage: async () => { sends++; throw scalar; },
  });
  if (diagnostic) t.mock.method(db, "writeWorkspaceLog", () => { throw logError; });
  const run = begin({ selectedNodeIds: ["a"] }); service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(sends, diagnostic ? 1 : 3);
  assert.equal(f.disposed.length, sends);
  assert.equal(store.isRunExecuting(run.id), false);
  if (diagnostic) {
    assert.equal(result.phase, "failed");
    await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "scalar-diagnostic-stop" }), error => failureContains(error, logError));
  } else {
    assert.equal(result.items[0]!.status, "failed");
    assert.equal(result.items[0]!.error!.code, "KNOWLEDGE_ASSET_RATE_LIMITED");
  }
});

test("F2 扫描等待期间公开 view 诊断失败后零新 saveRun，已存报告与正文不回滚", async t => {
  const { f, store, service, begin, db } = projectFixture(t), logError = new Error("scan-view-log");
  const source: KnowledgeAssetSource = { kind: "code", path: "source.ts", contentHash: store.readSource("source.ts").contentHash, startLine: 1, endLine: 1, relation: "实现" };
  const revision = store.saveDocument({ nodeId: "a", content: "# 已保存正文😀", sources: [source], expectedHash: null, origin: "manual" });
  const run = begin({ reviewConfig: { enabled: true, model: "model", effort: "high" } });
  const reviews = new KnowledgeReviewStore(store);
  const report = reviews.save(reviews.snapshot("a", revision.id), { runId: run.id, engine: "codex", model: "model", effort: "high", outcome: "passed", summary: "已核验", issues: [], sources: [source] });
  const saved = store.readRun(run.id);
  saved.items[0] = { ...saved.items[0]!, status: "completed", revisionId: revision.id, review: { status: "passed", reportId: report.id, error: null } };
  store.saveRun(saved);
  const reportPath = `${store.root}/assets/a/reviews/${report.id}.json`, reportBytes = store.files.read(reportPath)!;
  let resume!: () => void, entered!: () => void, saves = 0;
  const held = new Promise<void>(resolve => { resume = resolve; }), scanning = new Promise<void>(resolve => { entered = resolve; });
  const scan = store.scanMaintenanceFiles.bind(store), save = store.saveRun.bind(store);
  t.mock.method(store, "scanMaintenanceFiles", async () => { entered(); await held; return scan(); });
  t.mock.method(store, "saveRun", (value: Parameters<typeof save>[0]) => { saves++; return save(value); });
  t.mock.method(db, "writeWorkspaceLog", () => { throw logError; });
  service.start(run.id); await scanning;
  let before = 0, planBytes: Buffer | null = null;
  try {
    store.files.write(reportPath, "{broken-report");
    assert.throws(() => service.view(run.id), error => failureContains(error, logError));
    before = saves; planBytes = store.files.read(`${store.root}/runs/${run.id}/plan.json`)!;
  } finally { store.files.write(reportPath, reportBytes.toString("utf8")); resume(); }
  await settled(service, run.id);
  assert.equal(saves - before, 0);
  assert.deepEqual(store.files.read(`${store.root}/runs/${run.id}/plan.json`), planBytes);
  assert.equal(store.readRevision("a", revision.id).revision.contentHash, revision.contentHash);
  assert.deepEqual(store.files.read(reportPath), reportBytes);
  assert.equal(f.sent.length, 0);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "scan-view-stop" }), error => failureContains(error, logError));
  assert.equal(store.isRunExecuting(run.id), false);
});

for (const boundary of ["scan", "fingerprint"] as const) test(`F2 规划 ${boundary} 等待期间另一工具诊断失败后拒绝晚提交且零新 saveRun`, async t => {
  const { f, store, service, begin, db } = projectFixture(t), logError = new Error(`plan-${boundary}-log`);
  let resume!: () => void, entered!: () => void, sends = 0, saves = 0;
  const held = new Promise<void>(resolve => { resume = resolve; }), paused = new Promise<void>(resolve => { entered = resolve; });
  const scan = store.scanMaintenanceFiles.bind(store), fingerprint = store.maintenanceFingerprint.bind(store), save = store.saveRun.bind(store);
  if (boundary === "scan") t.mock.method(store, "scanMaintenanceFiles", async (...args: Parameters<typeof scan>) => { entered(); await held; return scan(...args); });
  else t.mock.method(store, "maintenanceFingerprint", async (...args: Parameters<typeof fingerprint>) => { entered(); await held; return fingerprint(...args); });
  t.mock.method(store, "saveRun", (value: Parameters<typeof save>[0]) => { saves++; return save(value); });
  t.mock.method(db, "writeWorkspaceLog", () => { throw logError; });
  let executeTool!: (input: any) => Promise<any>, submitted: PromiseSettledResult<unknown> | undefined;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => assert.fail("诊断不额外中断"),
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    sendMessage: async (message: any) => {
      sends++; executeTool = message.executeHostTool;
      const read = await executeTool({ toolId: "knowledge.source.read", toolInput: { path: "source.ts", startLine: 1, count: 1 } });
      assert.equal(read.ok, true);
      const result = await Promise.allSettled([executeTool({ toolId: "knowledge.plan.submit", toolInput: {
        nodes: [], generateNodeIds: ["a"], decisions: [{ nodeId: "a", question: "实现边界是什么", whyGenerate: "依据当前代码说明边界", sources: [{ kind: "code", path: "source.ts", contentHash: read.output.contentHash, startLine: 1, endLine: 1, relation: "实现" }] }], rationale: "待提交的候选计划", gaps: [],
      } })]);
      submitted = result[0];
      if (submitted!.status === "rejected") throw submitted!.reason;
    },
  });
  const run = begin({ mode: "build", selectedNodeIds: [], maintenance: true }); service.start(run.id);
  await paused;
  const before = saves, planBytes = store.files.read(`${store.root}/runs/${run.id}/plan.json`)!;
  try {
    await assert.rejects(executeTool({ toolId: "knowledge.plan.submit", toolInput: {} }), error => failureContains(error, logError));
  } finally { resume(); }
  await settled(service, run.id);
  assert.equal(saves - before, 0);
  assert.equal(submitted!.status, "rejected");
  assert.deepEqual(store.files.read(`${store.root}/runs/${run.id}/plan.json`), planBytes);
  assert.equal(store.readRun(run.id).proposedTree, null); assert.equal(sends, 1); assert.equal(f.disposed.length, 1);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: `plan-${boundary}-stop` }), error => failureContains(error, logError));
  assert.equal(store.isRunExecuting(run.id), false);
});

for (const primary of [undefined, null, false, 0, NaN, ""]) test(`日志拒写保留业务 falsy ${String(primary)}，公开 stop 不丢原因`, async t => {
  const { store, begin, db } = projectFixture(t), logFailure = new Error("日志拒写");
  t.mock.method(db, "writeWorkspaceLog", () => { throw logFailure; });
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw primary; }, "falsy", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin({ selectedNodeIds: ["a"] }); service.start(run.id); await settled(service, run.id);
  let final: unknown;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "falsy-stop" }), error => {
    final = error; assert.ok(failureContains(error, primary)); assert.ok(failureContains(error, logFailure)); return true;
  });
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "falsy-repeat" }), error => error === final);
});

test("受理 info 拒写只保真实日志原因，release 再错不启动 executor", async t => {
  const { store, begin, db, f } = projectFixture(t), logFailure = new Error("accepted-log"), releaseFailure = new Error("accepted-release");
  const claim = store.claimRunExecution.bind(store);
  t.mock.method(store, "claimRunExecution", (id: string) => { const release = claim(id); return () => { release(); throw releaseFailure; }; });
  t.mock.method(db, "writeWorkspaceLog", () => { throw logFailure; });
  const service = new KnowledgeGenerationService(store, "ws", f.execute, "accepted", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin(); let final: unknown;
  assert.throws(() => service.startAsync(run.id), error => { final = error; return failureContains(error, logFailure) && failureContains(error, releaseFailure); });
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "accepted-stop" }), error => error === final);
  assert.equal(store.isRunExecuting(run.id), false); assert.equal(f.sent.length, 0);
  assert.equal(store.readRun(run.id).phase, "planned");
});

test("provider 接住工具 reject 后再次提交被原 guard 拒绝，stop 等实际在途及清理", async t => {
  const { f, db, store, begin, service } = projectFixture(t), logFailure = new Error("tool-log-429");
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
  let rejection: unknown, sends = 0, interrupts = 0;
  t.mock.method(db, "writeWorkspaceLog", () => { throw logFailure; });
  f.deps.sessions.getOrCreate = () => ({ resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => { interrupts++; },
    sendMessage: async (message: any) => {
      sends++;
      await assert.rejects(message.executeHostTool({ toolId: "knowledge.node.read", toolInput: { nodeId: "outside" } }), error => { rejection = error; return true; });
      await assert.rejects(message.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: { content: "不得保存", summary: "不得保存", sources: [{ kind: "requirement", requirement: "x", relation: "x" }] } }), error => error === rejection);
      ready(); await held;
    } });
  const run = begin({ selectedNodeIds: ["a"] }); service.start(run.id); await started;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "timeout", timeoutMs: 20 }), { code: "DESKTOP_UPDATE_KNOWLEDGE_STOP_TIMEOUT" });
  assert.equal(service.view(run.id).active, true); assert.equal(store.isRunExecuting(run.id), true);
  const stopped = Promise.allSettled([stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "wait" }), stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "concurrent" })]);
  release(); const results = await stopped;
  assert.equal(results.every(result => result.status === "rejected" && failureContains(result.reason, logFailure)), true);
  assert.equal(sends, 1); assert.equal(interrupts, 1); assert.equal(f.disposed.length, 1);
  assert.equal(store.detail("a").drafts.length, 0);
  assert.equal(service.view(run.id).active, false);
});

test("prepared info 交给同一 activity，失败后不提前释放或调用 provider", async t => {
  const { store, begin, db, f, service } = projectFixture(t), cause = new Error("prepared-log");
  const write = db.writeWorkspaceLog;
  t.mock.method(db, "writeWorkspaceLog", (workspaceId: any, entry: any) => { if (entry.data.code === "KNOWLEDGE_RUN_START_PREPARED") throw cause; write(workspaceId, entry); });
  const run = begin(); service.startAsync(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "failed"); assert.equal(f.sent.length, 0);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "prepared-stop" }), error => failureContains(error, cause));
  assert.equal(store.isRunExecuting(run.id), false);
});

test("binding 诊断在 dispose 完成前进入同 activity，并行 worker 禁止提交", async t => {
  const { store, begin, service, f } = projectFixture(t), logError = new Error("binding-log");
  t.mock.method(logger, "warn", () => { throw logError; });
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), disposing = new Promise<void>(resolve => { ready = resolve; });
  let late: unknown, rejected = false, sends = 0, bothReady!: () => void;
  const both = new Promise<void>(resolve => { bothReady = resolve; });
  f.deps.db.writeWorkspaceLog = () => { throw logError; };
  f.deps.sessions.disposeThread = async () => { ready(); await held; };
  f.deps.sessions.getOrCreate = (thread: any) => ({ resolvePlatformToolTransport: () => "native-dynamic", getSessionId: () => "provider-before", interrupt: async () => assert.fail("诊断失败不得主动中断"), resetDynamicToolBinding: () => true,
    sendMessage: async (message: any) => {
      sends++;
      if (sends === 2) bothReady();
      await both;
      if (f.created.find(item => item.id === thread.threadId)!.title.endsWith(" a")) throw Object.assign(new Error("binding-mismatch"), { code: "codex_thread_capability_incompatible" });
      await disposing;
      try { await message.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: { content: "不得保存", summary: "说明", sources: [{ kind: "requirement", requirement: "x", relation: "x" }] } }); }
      catch (error) { late = error; rejected = true; }
      finally { release(); }
    } });
  const run = begin({ concurrency: 2 }); service.start(run.id); await settled(service, run.id);
  assert.equal(rejected, true); assert.ok(failureContains(late, logError));
  assert.equal(store.detail("b").drafts.length, 0); assert.equal(sends, 2);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "binding-stop" }), error => failureContains(error, logError));
});

test("安全描述不执行未知 getter/toString/iterator，反射失败保新因且不重试429", async t => {
  const { store, begin, db } = projectFixture(t), reflection = new Error("descriptor-reflection"), releaseError = new Error("release-tail");
  let executed = 0, calls = 0;
  const business = new Proxy({ get message() { executed++; return "不得执行"; }, toString() { executed++; return "不得执行"; }, [Symbol.iterator]() { executed++; return [][Symbol.iterator](); } }, { getOwnPropertyDescriptor() { throw reflection; } });
  const service = new KnowledgeGenerationService(store, "ws", async () => { calls++; throw business; }, "safe", () => ({ nodeId: null, activationVersion: 1 }), db);
  const claim = store.claimRunExecution.bind(store);
  t.mock.method(store, "claimRunExecution", (id: string) => { const release=claim(id); return () => { release(); throw releaseError; }; });
  const run = begin({ selectedNodeIds: ["a"] }); service.start(run.id); await settled(service, run.id);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "safe-stop" }), error => failureContains(error, business) && failureContains(error, reflection) && failureContains(error, releaseError));
  assert.equal(executed, 0); assert.equal(calls, 1);
});

test("已保存正文和 trace 后 binding 日志及 terminal/dispose 再错保完整原因且不回滚", async t => {
  const { f, store, service, begin } = projectFixture(t);
  const mismatch = Object.assign(new Error("mismatch"), { code: "codex_thread_capability_incompatible" });
  const logError = new Error("log-tail"), terminalError = new Error("terminal-tail"), disposeError = new Error("dispose-tail");
  let savedHash = "", revisionId = "", sends = 0;
  f.deps.db.writeWorkspaceLog = () => { throw logError; };
  f.deps.emitConversation = (event: any) => { f.events.push(event); if (event.type === "turn.error") throw terminalError; };
  f.deps.sessions.disposeThread = async () => { throw disposeError; };
  f.deps.sessions.getOrCreate = () => ({ resolvePlatformToolTransport: () => "native-dynamic", prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }), getSessionId: () => "provider", resetDynamicToolBinding: () => true, interrupt: async () => assert.fail("不得额外中断"),
    sendMessage: async (message: any, sink: any) => {
      sends++;
      const result = await message.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: { content: "# 已保存😀", summary: "说明", sources: [{ kind: "requirement", requirement: "明确要求", relation: "依据" }] } });
      assert.equal(result.ok, true); revisionId = result.output.revisionId;
      savedHash = store.readRevision("a", revisionId).revision.contentHash;
      sink.raw({ workspaceId: "ws", threadId: "trace", payload: { marker: "trace-saved" } });
      throw mismatch;
    } });
  const run = begin({ selectedNodeIds: ["a"] }); service.start(run.id); await settled(service, run.id);
  let final: unknown;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "saved-stop" }), error => {
    final = error;
    for (const cause of [mismatch,logError,terminalError,disposeError]) assert.ok(failureContains(error,cause), `缺少原原因 ${cause.message}`);
    return true;
  });
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "saved-repeat" }), error => error === final);
  assert.equal(store.readRevision("a", revisionId).revision.contentHash, savedHash);
  assert.equal(store.detail("a").drafts.length, 1); assert.equal(sends, 1);
  assert.equal(store.readRun(run.id).items[0]!.revisionId, revisionId); assert.equal(f.raw.length, 1);
});

test("getter/数组反射安全与诊断通知自身失败均保原对象并完成清理", async () => {
  const f = fixture(), mismatch = Object.assign(new Error("mismatch"), { code: "codex_thread_capability_incompatible" });
  const notifyError = new Error("notify"), arrayError = new Error("array-reflection"); let executed = 0, notification: unknown;
  const hostile = new AggregateError([], "业务");
  Object.defineProperty(hostile, "message", { get() { executed++; return "不得执行"; } });
  Object.defineProperty(hostile, "errors", { value: new Proxy([], { getOwnPropertyDescriptor() { throw arrayError; } }) });
  f.deps.sessions.getOrCreate = () => ({ resolvePlatformToolTransport: () => "native-dynamic", getSessionId: () => "provider", resetDynamicToolBinding: () => { throw hostile; }, interrupt: async () => {}, sendMessage: async () => { throw mismatch; } });
  await assert.rejects(f.execute(input({ onDiagnosticFailure: error => { notification = error; throw notifyError; } })), error => [mismatch,hostile,arrayError,notifyError].every(cause => failureContains(error,cause)));
  assert.ok(notification); assert.equal(executed, 0); assert.equal(f.disposed.length, 1);
});

test("后台普通失败日志成功仍持久化，saveRun 与 release 后续失败完整保留", async t => {
  const { store, db, begin } = projectFixture(t), business = new Error("background-business"), saveError = new Error("save-tail"), releaseError = new Error("release-tail");
  const save = store.saveRun.bind(store), claim = store.claimRunExecution.bind(store);
  let saved = 0;
  const service = new KnowledgeGenerationService(store, "ws", async () => { throw business; }, "background", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin({ selectedNodeIds: ["a"] });
  t.mock.method(store, "scanMaintenanceFiles", async () => { throw business; });
  t.mock.method(store, "saveRun", (value: any) => { if (value.phase === "failed") { saved++; throw saveError; } return save(value); });
  t.mock.method(store, "claimRunExecution", (id: string) => { const release=claim(id); return () => { release(); throw releaseError; }; });
  service.start(run.id); await settled(service, run.id);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "background-stop" }), error => [business,saveError,releaseError].every(cause => failureContains(error,cause)));
  assert.ok(saved > 0); assert.equal(service.view(run.id).phase, "failed");
});

test("复检读取日志成功后才去重，诊断拒写再次读取仍显式失败", async t => {
  const { store, db, begin, service } = projectFixture(t), readError = new Error("review-read"), logError = new Error("review-log");
  const run = begin({ selectedNodeIds: ["a"] });
  run.items[0]!.review = { status: "passed", reportId: "missing", error: null };
  store.saveRun(run);
  t.mock.method(KnowledgeReviewStore.prototype, "list", () => { throw readError; });
  const write = db.writeWorkspaceLog; let attempts = 0;
  t.mock.method(db, "writeWorkspaceLog", (workspaceId: any, entry: any) => { attempts++; if (attempts === 1) throw logError; write(workspaceId,entry); });
  assert.throws(() => service.view(run.id), error => failureContains(error, readError) && failureContains(error, logError));
  assert.equal(service.view(run.id).items[0]!.review!.stale, true);
  service.view(run.id); assert.equal(attempts, 2);
});

test("后台恢复 info 拒写停止派发，保存事实保留且异工作区仍可执行", async t => {
  const a = projectFixture(t), b = projectFixture(t), cause = new Error("recovery-log");
  const write = a.db.writeWorkspaceLog;
  t.mock.method(a.db, "writeWorkspaceLog", (workspaceId: any, entry: any) => { if (entry.data.code === "KNOWLEDGE_RUN_RECOVERY_SCAN_COMPLETED") throw cause; write(workspaceId,entry); });
  const run = a.begin(); a.service.startAsync(run.id); await settled(a.service,run.id);
  assert.equal(a.f.sent.length,0); assert.equal(a.store.readRun(run.id).phase,"planned");
  await assert.rejects(stopKnowledgeGenerationForUpdate(a.store.files.root,{requestId:"recovery-stop"}),error=>failureContains(error,cause));
  const other = b.begin({ selectedNodeIds: ["a"] }); b.service.start(other.id); await settled(b.service,other.id);
  assert.equal(b.f.sent.length,1); assert.equal(b.service.view(other.id).active,false);
});

test("固定工作区日志通过真实 startAsync 和 executor 仅写 A，应用与 B 无同条", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kg-log-"));
  const a = path.join(root, "A"), b = path.join(root, "B");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: "ws" as any, title: "中文工作区😀", path: a });
  db.workspaces.upsert({ id: "other" as any, title: "B", path: b });
  db.threads.create({ id: "knowledge-owner" as any, workspaceId: "ws" as any, title: "归属", engine: "codex", threadSubtype: "knowledge-conversation" });
  const f = fixture(); f.deps.db = db;
  const execute = createKnowledgeGenerationExecutor(f.deps);
  const store = new KnowledgeAssetStore(a);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "a", parentId: null, title: "中文😀", orderKey: "a", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  const service = new KnowledgeGenerationService(store, "ws" as any, execute, "request-中文😀", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: "physical", mode: "batch", ownerThreadId: "knowledge-owner", selectedNodeIds: ["a"], includeDescendants: false, strategy: "all", prompt: "秘密正文不入日志", treeHash: store.readTree().hash, engine: "codex", model: "model", effort: "high", reviewConfig: { enabled: false, model: null, effort: null } });
  service.startAsync(run.id); await settled(service, run.id); await flushClientLogger();
  /** 回读真实文件，不以 writer 调用代替物理落点。 */
  const lines = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? lines(path.join(dir, entry.name)) : entry.name.includes(".log") ? fs.readFileSync(path.join(dir, entry.name), "utf8").split("\n") : []) : [];
  const target = "knowledge run start accepted asynchronously";
  const wa = lines(path.join(a, ".codeflowai")), wb = lines(path.join(b, ".codeflowai"));
  const app = lines(process.env.CODEFLOWAI_CLIENT_LOG_DIR!);
  assert.equal(wa.filter(line => line.includes(target)).length, 1);
  assert.equal(wb.filter(line => line.includes(target)).length, 0);
  assert.equal(app.filter(line => line.includes(target) && line.includes("request-中文😀")).length, 0);
  assert.ok(wa.some(line => line.includes("request-中文😀") && line.includes(run.id) && line.includes("knowledge-owner")));
  assert.equal(wa.some(line => line.includes("秘密正文不入日志")), false);
  assert.ok(f.sent.length > 0);
});

/** 模拟线程持久化投影，保留创建参数以核对配置与实际发送的一致性。 */
function fixture(ownerSubtype = "knowledge-conversation") {
  const created: any[] = [], sent: any[] = [], events: any[] = [], raw: any[] = [], disposed: string[] = [], logs: any[] = [];
  let interrupts = 0;
  const owner = { id: "knowledge-owner", workspaceId: "ws", threadSubtype: ownerSubtype, archived: false, sharedWorkspaceId: "shared-ws", ownerUserId: "user", sharedVisibility: "private", sharedParticipantUserIds: ["user"], sharedAclUpdatedAt: 100 };
  const deps: any = {
    db: { writeWorkspaceLog: (_workspaceId: string, entry: any) => { logs.push(entry); }, threads: {
      get: (id: string) => { const thread = created.find(thread => thread.id === id); return id === owner.id ? owner : thread ? { ...thread, ...thread.prefs, ...thread.sharedAcl } : null; },
      create: (value: any) => { created.push(value); return value; },
      updatePrefs: (id: string, prefs: any) => { const thread = created.find(thread => thread.id === id); assert.ok(thread); thread.prefs = { ...thread.prefs, ...prefs }; },
    } },
    threads: { get: () => null, create: (value: any) => value },
    sessions: {
      getOrCreate: (thread: any) => ({
        resolvePlatformToolTransport: () => "native-dynamic",
        interrupt: async () => { interrupts++; },
        sendMessage: async (input: any, sink: any) => {
          sent.push({ thread, input });
          sink.raw({ workspaceId: "ws", threadId: thread.threadId, payload: { type: "raw-proof" } });
          sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: input.turnId } });
        },
      }),
      disposeThread: async (id: string) => { disposed.push(id); },
    },
    timeoutPolicy: {}, emitConversation: (value: any) => events.push(value), emitRaw: (value: any) => raw.push(value),
  };
  return { execute: createKnowledgeGenerationExecutor(deps), deps, created, sent, events, raw, disposed, logs, owner, interrupts: () => interrupts };
}
function input(extra: Partial<KnowledgeGenerationEngineInput> = {}): KnowledgeGenerationEngineInput {
  return { workspaceId: "ws", runId: "batch", ownerThreadId: "knowledge-owner", title: "资产", engine: "codex", model: "model", effort: "high", prompt: "按来源说明", instructions: "项目规范", registry: { tools: [] }, execute: async () => ({ ok: true, output: {} }), signal: new AbortController().signal, onThreadCreated: () => {}, ...extra };
}

/** 使用真实文件和批服务，模型发送仍由上面的引擎会话夹具控制。 */
function projectFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-model-freeze-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: "ws" as any, title: "生成测试", path: root });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "source.ts"), "export const enabled = true;\n", "utf8");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: ["a", "b"].map(id => ({ id, title: id, parentId: null, orderKey: id, summary: "", tags: [], instructions: "", sourceScope: [] })) }, null);
  const f = fixture();
  const service = new KnowledgeGenerationService(store, "ws", f.execute, "req-freeze", () => ({ nodeId: null, activationVersion: 1 }), db);
  const begin = (extra: Partial<Parameters<typeof service.begin>[0]> = {}) => service.begin({ requestId: crypto.randomUUID(), mode: "batch", ownerThreadId: "knowledge-owner", selectedNodeIds: ["a", "b"], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", model: null, effort: null, concurrency: 1, reviewConfig: { enabled: false, model: null, effort: null }, ...extra });
  return { f, db, store, service, begin };
}

/** 替换默认模型时可同时下架旧项，模拟批次执行期间的真实目录更新。 */
function changeDefaultModel(removeOriginal = false): void {
  const snapshot = getActiveEngineModelCatalogSnapshot()!;
  const original = snapshot.rows.find(row => row.engine === "codex")!;
  applyEngineModelCatalogSnapshot({ ...snapshot, configVersion: snapshot.configVersion + 1, rows: [
    ...snapshot.rows.filter(row => !removeOriginal || row.engine !== "codex").map(row => row.engine === "codex" ? { ...row, isDefault: false } : row),
    { ...original, catalogItemId: "test:second", modelId: "model-b", displayName: "新默认模型", isDefault: true, sortOrder: removeOriginal ? 1 : 2 },
  ] });
}

/** 等待真实 worker 收口；超时显式失败，避免把排队状态当成结果。 */
async function settled(service: KnowledgeGenerationService, id: string) {
  const deadline = Date.now() + 12000;
  while (service.view(id).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const result = service.view(id);
  assert.equal(result.active, false, "知识执行应已结束");
  return result;
}

for (const [mode, concurrency] of [["batch", 1], ["batch", 2], ["review", 1]] as const) test(
  mode === "review" ? "单独复检自动修订沿用批次冻结模型，不随默认配置变化" : `并发${concurrency}生成与复检均冻结模型，原空模型请求仍可幂等重放`, async t => {
  const { f, store, service, begin } = projectFixture(t);
  const source: KnowledgeAssetSource = { kind: "code", path: "source.ts", contentHash: store.readSource("source.ts").contentHash, startLine: 1, endLine: 1, relation: "实现" };
  if (mode === "review") for (const nodeId of ["a", "b"]) store.saveDocument({ nodeId, content: "# 原文\n待修订结论。", expectedHash: null, origin: "manual", sources: [source] });
  const models: string[] = [], reportIds = new Map<string, string>(), reviewed = new Set<string>();
  let changed = false;
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
    sendMessage: async (message: any, sink: any) => {
      models.push(message.model);
      const nodeId = f.created.find(candidate => candidate.id === thread.threadId)!.title.split(" ").at(-1)!;
      const read = await message.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "source.ts", count: 1 } });
      assert.equal(read.ok, true);
      const sources = [{ kind: "code", path: "source.ts", contentHash: read.output.contentHash, startLine: 1, endLine: 1, relation: "实现" }];
      const reviewing = message.systemMessage.includes("独立的项目知识复检");
      if (reviewing) assert.equal((await message.executeHostTool({ toolId: "knowledge.review.read", toolInput: {} })).ok, true);
      else if (mode === "review") assert.equal((await message.executeHostTool({ toolId: "knowledge.review.report.read", toolInput: { nodeId, reportId: reportIds.get(nodeId) } })).ok, true);
      const issues = reviewing && mode === "review" && !reviewed.has(nodeId)
        ? [{ id: "incorrect", severity: "error", category: "factual", title: "结论有误", detail: "正文与来源不符。", suggestion: "按真实来源修订。", documentStartLine: 2, documentEndLine: 2, sources }] : [];
      const submitted = await message.executeHostTool({ toolId: reviewing ? "knowledge.review.submit" : "knowledge.asset.submit", toolInput: reviewing
        ? { outcome: issues.length ? "issues" : "passed", summary: "已核验", issues, sources } : { content: "# 已核验知识\n已核验的结论。", summary: "说明", sources } });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      if (reviewing) { reviewed.add(nodeId); reportIds.set(nodeId, submitted.output.reportId); }
      if (!reviewing && !changed) { changed = true; changeDefaultModel(); }
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
    },
  });
  const request = { requestId: "same-freeze-request", mode, concurrency, reviewConfig: { enabled: true, model: null, effort: null, autoRepair: true, maxRounds: 2 } };
  const run = begin(request); service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
  assert.deepEqual(models, Array(mode === "review" ? 6 : 4).fill("model"));
  assert.equal(result.model, "model");
  assert.equal(result.reviewConfig?.model, "model");
  for (const item of result.items) {
    assert.equal(item.review?.status, "passed");
    assert.equal(item.review?.parentThreadId, item.executionThreadId);
    assert.equal(f.created.find(thread => thread.id === item.review?.executionThreadId)?.threadSubtype, "knowledge-review");
    const parentEvents = f.events.filter(event => event.threadId === item.executionThreadId);
    assert.equal(parentEvents.filter(event => event.type === "item.subagent.started").length, mode === "review" ? 2 : 1);
    assert.equal(parentEvents.filter(event => event.type === "item.subagent.completed" && event.payload.status === "completed").length, mode === "review" ? 2 : 1);
    const reports = new KnowledgeReviewStore(store).list(item.nodeId);
    assert.equal(reports.length, mode === "review" ? 2 : 1);
    assert.ok(reports.every(report => report.model === "model" && report.effort === "high"));
  }
  assert.equal(begin(request).id, run.id);
  assert.throws(() => begin({ ...request, model: "model-b" }), /同一生成请求 ID 已用于不同要求/);
});

/** 显式清空配置只重算所选失败项，已完成版本不受旧模型下架影响。 */
test("失败项清空模型后使用新默认和新线程，已完成项不重验或重跑", async t => {
  const { f, service, store, begin } = projectFixture(t);
  let firstAttempt = true;
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
    sendMessage: async (message: any, sink: any) => {
      const nodeId = f.created.find(candidate => candidate.id === thread.threadId)!.title.split(" ").at(-1)!;
      f.sent.push({ thread, input: message, nodeId });
      if (firstAttempt && nodeId === "b") throw new Error("模拟单项引擎失败");
      const read = await message.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "source.ts", count: 1 } });
      assert.equal(read.ok, true);
      const submitted = await message.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: { content: "# 已核验知识", summary: "说明", sources: [{ kind: "code", path: "source.ts", contentHash: read.output.contentHash, startLine: 1, endLine: 1, relation: "实现" }] } });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
    },
  });
  const run = begin(); service.start(run.id);
  const failed = await settled(service, run.id);
  assert.equal(failed.phase, "partial");
  assert.deepEqual(failed.items.map(item => item.status), ["completed", "failed"]);
  const preservedRevision = failed.items[0]!.revisionId;
  const oldThread = failed.items[1]!.executionThreadId;
  changeDefaultModel(true); firstAttempt = false;
  service.start(run.id, { nodeIds: ["b"], model: null, effort: null });
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error ?? result.items));
  assert.deepEqual(f.sent.map(({ nodeId, input }) => [nodeId, input.model]), [["a", "model"], ["b", "model"], ["b", "model-b"]]);
  assert.notEqual(result.items[1]!.executionThreadId, oldThread);
  assert.deepEqual(result.items[1]!.executionConfig, { model: "model-b", effort: "high" });
  assert.equal(result.items[0]!.revisionId, preservedRevision);
  assert.equal(store.detail("a").drafts.length, 1);
});

/** 无资料且无长期要求时直接结束，不因运行时模型目录未同步失败。 */
test("空项目无需执行模型，目录未同步时仍可完成空构建", async t => {
  resetEngineModelCatalogRuntimeForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-empty-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KnowledgeAssetStore(root), f = fixture();
  const service = new KnowledgeGenerationService(store, "ws", f.execute, "req-empty", () => ({ nodeId: null, activationVersion: 1 }), f.deps.db);
  const run = service.begin({ requestId: "empty-no-model", mode: "build", ownerThreadId: "knowledge-owner", selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: null, engine: "codex", model: null, effort: null });
  service.start(run.id);
  const result = await settled(service, run.id);
  assert.equal(result.phase, "completed", JSON.stringify(result.error));
  assert.equal(result.model, null);
  assert.deepEqual(result.items, []);
  assert.deepEqual(f.created, []);
  assert.equal(store.snapshot().initialized, false);
});

test("每资产创建独立引擎上下文，归属会话不收执行消息，canonical和raw保留", async () => {
  const f = fixture(), executionIds: string[] = [];
  await f.execute(input({ onThreadCreated: id => executionIds.push(id) }));
  await f.execute(input({ onThreadCreated: id => executionIds.push(id) }));
  assert.equal(new Set(executionIds).size, 2);
  assert.ok(executionIds.every(id => id !== "knowledge-owner"));
  assert.deepEqual(f.disposed, executionIds);
  assert.equal(f.raw.length, 2);
  assert.ok(f.raw.every(event => executionIds.includes(event.threadId)));
  assert.ok(f.events.every(event => executionIds.includes(event.threadId)));
  assert.ok(f.sent.every(({ input }) => input.accessMode === "read-only" && input.model === "model" && input.effort === "high"));
  assert.match(f.sent[0]!.input.systemMessage, /knowledge\.asset\.submit/);
  assert.match(f.sent[0]!.input.systemMessage, /唯一资产交付工具/);
  assert.ok(f.created.every(thread => thread.prefs.model === "model" && thread.prefs.effort === "high" && thread.prefs.accessMode === "read-only"));
  assert.ok(f.created.every(thread => thread.threadSubtype === "knowledge-assets" && thread.sharedAcl.sharedWorkspaceId === "shared-ws"));
});

test("默认配置在规划、正文和复检前解析为真实模型并保存执行偏好", async () => {
  for (const engine of ["codex", "claude"] as const) for (const purpose of ["planning", "generation", "review"] as const) {
    const f = fixture();
    await f.execute(input({ engine, purpose, model: null, effort: null }));
    const expectedModel = engine === "codex" ? "model" : "claude-model";
    assert.equal(f.sent[0].input.model, expectedModel);
    assert.equal(f.sent[0].input.effort, "high");
    assert.equal(f.created[0].prefs.model, expectedModel);
    assert.equal(f.created[0].prefs.effort, "high");
  }
});

test("规划上下文只判断资料与缺口，生成和复检保留各自交付职责", async () => {
  const f = fixture();
  for (const purpose of ["planning", "generation", "review"] as const) await f.execute(input({ purpose }));
  const [planning, generation, review] = f.sent.map(({ input }) => input);
  assert.match(planning.systemMessage, /只判断可引用资料与必要知识缺口/);
  assert.match(planning.systemMessage, /实现细节.*留给生成和独立复检/);
  assert.match(planning.systemMessage, /knowledge\.plan\.submit/);
  assert.doesNotMatch(planning.systemMessage, /knowledge\.asset\.submit/);
  assert.match(generation.systemMessage, /真实项目证据.*knowledge\.asset\.submit/);
  assert.match(review.systemMessage, /重新读取绑定文档.*真实源码/);
  assert.ok(f.sent.every(({ input }) => input.providerNativeToolPolicy === "allow" && input.developerMessage.startsWith("项目规范\n")));
  for (const { input } of f.sent) {
    assert.match(input.developerMessage, /后台执行，不能等待人工审批或补充输入/);
    assert.match(input.developerMessage, /knowledge\.source\.list\/read/);
    assert.match(input.developerMessage, /无需审批的原生Glob\/Grep/);
    assert.equal(input.conversationProfile, "orchestration");
    assert.deepEqual(resolveClaudePermissionLaunchMode(input), { permissionMode: "default", dangerouslySkipPermissions: false });
  }
  assert.equal(f.raw.length, 3);
});

test("引擎审批中断保留补充输入根因，用户主动停止仍优先显示停止", async () => {
  for (const stopped of [false, true]) {
    const f = fixture(), controller = new AbortController();
    f.deps.sessions.getOrCreate = (thread: any) => ({
      resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
      sendMessage: async (message: any, sink: any) => {
        sink.conversation({ type: "approval.request", payload: { requestId: "approval", toolName: "ExitPlanMode", message: "等待实施审批" } });
        if (stopped) controller.abort();
        sink.conversation({ threadId: thread.threadId, type: "turn.error", payload: { turnId: message.turnId, error: "turn interrupted", code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" } });
        throw Object.assign(new Error("turn interrupted"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" });
      },
    });
    await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => error.code === (stopped ? "KNOWLEDGE_ASSET_INTERRUPTED" : "KNOWLEDGE_ASSET_INPUT_REQUIRED"));
    assert.equal(f.disposed.length, 1);
  }
});

test("更新询问冻结知识派发，解除后只创建并发送一次", async () => {
  const f = fixture();
  let paused = true, sessions = 0;
  f.deps.isTaskAdmissionPaused = () => paused;
  const getOrCreate = f.deps.sessions.getOrCreate;
  f.deps.sessions.getOrCreate = (thread: any) => { sessions++; return getOrCreate(thread); };
  const pending = f.execute(input());
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.created.length, 0);
  assert.equal(sessions, 0);
  assert.equal(f.sent.length, 0);
  paused = false;
  await pending;
  assert.equal(f.created.length, 1);
  assert.equal(sessions, 1);
  assert.equal(f.sent.length, 1);
});

test("更新询问期间复检不创建宿主和子线程，解除后恢复", async () => {
  const f = fixture();
  let paused = true;
  f.deps.isTaskAdmissionPaused = () => paused;
  const pending = f.execute(input({ purpose: "review", reviewParent: { threadId: null, model: "model", effort: "high", onThreadCreated: () => {}, completionSummary: () => "复检通过" } }));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  paused = false;
  await pending;
  assert.equal(f.created.length, 2);
  assert.equal(f.sent.length, 1);
});

test("确认更新中断冻结等待，不创建线程或发送", async () => {
  const f = fixture(), controller = new AbortController();
  f.deps.isTaskAdmissionPaused = () => true;
  const rejected = assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => error.code === "KNOWLEDGE_ASSET_INTERRUPTED");
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  await rejected;
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
});

test("线程准备后出现更新询问，冻结会话创建直到解除", async () => {
  const f = fixture();
  let paused = false, sessions = 0;
  f.deps.isTaskAdmissionPaused = () => paused;
  const getOrCreate = f.deps.sessions.getOrCreate;
  f.deps.sessions.getOrCreate = (thread: any) => { sessions++; return getOrCreate(thread); };
  const pending = f.execute(input({ onThreadCreated: () => { paused = true; } }));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.created.length, 1);
  assert.equal(sessions, 0);
  assert.equal(f.sent.length, 0);
  paused = false;
  await pending;
  assert.equal(sessions, 1);
  assert.equal(f.sent.length, 1);
});

test("会话准备后冻结实际发送，确认更新正常取消未派发回合", async () => {
  const f = fixture(), controller = new AbortController();
  let paused = false, sends = 0, interrupts = 0;
  f.deps.isTaskAdmissionPaused = () => paused;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => { paused = true; return "native-dynamic"; },
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { interrupts++; return false; },
    sendMessage: async () => { sends++; },
  });
  const rejected = assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => error.code === "KNOWLEDGE_ASSET_INTERRUPTED");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sends, 0);
  controller.abort();
  await rejected;
  assert.equal(interrupts, 0);
  assert.equal(f.disposed.length, 1);
});

test("异步绑定准备遇到更新询问，冻结旋转和重发直到解除", async () => {
  const f = fixture();
  let paused = false, sends = 0, resets = 0, ready!: () => void;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  f.deps.isTaskAdmissionPaused = () => paused;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", getSessionId: () => "old-provider",
    resetDynamicToolBinding: () => { resets++; return true; },
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => false,
    sendMessage: async () => {
      sends++;
      if (sends === 1) {
        await new Promise(resolve => setImmediate(resolve));
        paused = true; ready();
        throw Object.assign(new Error("工具绑定已失效"), { code: "codex_thread_capability_incompatible" });
      }
    },
  });
  const pending = f.execute(input());
  await prepared;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(sends, 1);
  assert.equal(resets, 0);
  paused = false;
  await pending;
  assert.equal(resets, 1);
  assert.equal(sends, 2);
});

test("绑定旋转期间出现更新询问，二次发送继续等待解除", async () => {
  const f = fixture();
  let paused = false, sends = 0, ready!: () => void;
  const rotated = new Promise<void>(resolve => { ready = resolve; });
  f.deps.isTaskAdmissionPaused = () => paused;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", getSessionId: () => "old-provider",
    resetDynamicToolBinding: () => { paused = true; ready(); return true; },
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => false,
    sendMessage: async () => {
      sends++;
      if (sends === 1) throw Object.assign(new Error("工具绑定已失效"), { code: "codex_thread_capability_incompatible" });
    },
  });
  const pending = f.execute(input());
  await rotated;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(sends, 1);
  paused = false;
  await pending;
  assert.equal(sends, 2);
});

test("更新询问不把已经派发的知识回合改成失败", async () => {
  const f = fixture();
  let paused = false, started!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.isTaskAdmissionPaused = () => paused;
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => true,
    sendMessage: async () => { started(); await gate; },
  });
  const pending = f.execute(input());
  await running; paused = true; release();
  await pending;
  assert.equal(f.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(f.events.some(event => event.type === "turn.error"), false);
});

for (const terminal of [false, true]) test(`知识中断未命中只接受已确权终态：terminal=${terminal}`, async () => {
  const f = fixture(), controller = new AbortController();
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    hasActiveTurn: () => !terminal,
    getObservedTurnTerminalStatus: () => terminal ? "completed" : null,
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => false,
    sendMessage: async (message: any, sink: any) => {
      if (terminal) sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
      controller.abort();
    },
  });
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => error.code === (terminal ? "KNOWLEDGE_ASSET_INTERRUPTED" : "KNOWLEDGE_ASSET_INTERRUPT_FAILED"));
  assert.equal(f.disposed.length, 1);
});

test("知识中断未命中可由确切provider终态核验", async () => {
  const f = fixture(), controller = new AbortController();
  let sentTurnId = "";
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false,
    getObservedTurnTerminalStatus: (turnId: string) => { assert.equal(turnId, sentTurnId); return "completed"; },
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => false,
    sendMessage: async (message: any) => { sentTurnId = message.turnId; controller.abort(); },
  });
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => error.code === "KNOWLEDGE_ASSET_INTERRUPTED");
  assert.equal(f.disposed.length, 1);
});

test("用户停止不能覆盖引擎中断失败，仍须释放会话", async () => {
  const f = fixture(), controller = new AbortController();
  const cause = new Error("provider-interrupt-failed");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { throw cause; },
    sendMessage: async () => { controller.abort(); },
  });
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => {
    assert.equal(error.code, "KNOWLEDGE_ASSET_INTERRUPT_FAILED");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(f.disposed.length, 1);
  assert.equal(f.events.some(event => event.type === "turn.completed"), false);
});

test("知识中断与会话释放双故障保留两项根因", async () => {
  const f = fixture(), controller = new AbortController();
  const interrupt = new Error("provider-root-failure"), cleanup = new Error("dispose-cleanup-failure");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { throw interrupt; },
    sendMessage: async () => { controller.abort(); },
  });
  f.deps.sessions.disposeThread = async () => { throw cleanup; };
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error.errors[0] as Error).cause, interrupt);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
});

test("终态协调期间迟到的中断失败不能发出完成事件", async () => {
  const f = fixture(), controller = new AbortController();
  const cause = new Error("late-provider-root-failure");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => { controller.abort(); return { events: [], latestAssistantText: null }; },
    interrupt: async () => { throw cause; },
    sendMessage: async () => {},
  });
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => {
    assert.equal(error.code, "KNOWLEDGE_ASSET_INTERRUPT_FAILED");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(f.events.some(event => event.type === "turn.completed"), false);
  assert.equal(f.disposed.length, 1);
});

test("取消之后的未知引擎错误保留原始失败", async () => {
  const f = fixture(), controller = new AbortController(), cause = new Error("provider-failed-after-abort");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => {},
    sendMessage: async () => { controller.abort(); throw cause; },
  });
  await assert.rejects(f.execute(input({ signal: controller.signal })), error => error === cause);
  assert.equal(f.disposed.length, 1);
});

for (const late of [false, true]) test(`知识执行、中断及清理组合失败完整保留根因：late=${late}`, async () => {
  const f = fixture(), controller = new AbortController();
  const execution = new Error("execution-combined-root"), interrupt = new Error("interrupt-combined-root"), cleanup = new Error("cleanup-combined-root");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => { if (late) controller.abort(); return { events: [], latestAssistantText: null }; },
    interrupt: async () => { throw interrupt; },
    sendMessage: async () => { if (!late) controller.abort(); throw execution; },
  });
  f.deps.sessions.disposeThread = async () => { f.disposed.push("cleanup"); if (late) throw cleanup; };
  await assert.rejects(f.execute(input({ signal: controller.signal })), (error: any) => {
    const seen = new Set<unknown>();
    /** 从返回的原错误树核对根因对象，不以聚合文案代替失败证据。 */
    const visit = (value: unknown): void => {
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof AggregateError) value.errors.forEach(visit);
      if (value instanceof Error && value.cause !== undefined) visit(value.cause);
    };
    visit(error);
    assert.ok(seen.has(execution));
    assert.ok(seen.has(interrupt));
    if (late) assert.ok(seen.has(cleanup));
    return true;
  });
  assert.equal(f.disposed.length, 1);
  assert.equal(f.events.some(event => event.type === "turn.completed"), false);
});

for (const stage of ["execution", "cleanup"] as const) for (const cause of [undefined, null, NaN]) test(`知识${stage}空值拒绝仍明确失败：${cause}`, async () => {
  const f = fixture();
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => {},
    sendMessage: async () => { if (stage === "execution") throw cause; },
  });
  f.deps.sessions.disposeThread = async () => { f.disposed.push("cleanup"); if (stage === "cleanup") throw cause; };
  let rejected = false;
  try { await f.execute(input()); }
  catch (error) {
    rejected = true;
    if (stage === "cleanup") { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cause]); }
    else assert.equal(error, cause);
  }
  assert.equal(rejected, true);
  assert.equal(f.disposed.length, 1);
});

test("批次停止保留中断失败而不写正常中断成功", async t => {
  const { f, service, begin } = projectFixture(t);
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { throw new Error("batch-interrupt-failed"); },
    sendMessage: async () => { service.stop(run.id); },
  });
  const run = begin();
  service.start(run.id);
  await settled(service, run.id);
  assert.equal(service.view(run.id).phase, "failed");
  assert.equal(service.view(run.id).error?.code, "KNOWLEDGE_ASSET_INTERRUPT_FAILED");
});

test("更新停止等待知识引擎和批次释放，失败保留原码", async t => {
  const { f, service, begin, store } = projectFixture(t);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { await gate; throw new Error("update-knowledge-interrupt-failed"); },
    sendMessage: async () => { started(); await gate; },
  });
  const run = begin();
  service.start(run.id);
  await running;
  let finished = false;
  const stopping = stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "update-knowledge", timeoutMs: 1000 });
  const rejected = assert.rejects(stopping, (error: any) => {
    assert.equal(error.code, "KNOWLEDGE_ASSET_INTERRUPT_FAILED");
    return true;
  }).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await rejected;
  assert.equal(service.view(run.id).active, false);
  assert.equal(service.view(run.id).phase, "failed");
  assert.equal(f.disposed.length, 1);
});

test("知识并发停止等待所有 worker，不能因首个完成提前释放活动", async t => {
  const { f, service, begin, store } = projectFixture(t);
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  let allStarted!: () => void;
  const running = new Promise<void>(resolve => { allStarted = resolve; });
  f.deps.sessions.getOrCreate = () => {
    const index = starts++;
    return {
      resolvePlatformToolTransport: () => "native-dynamic",
      prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
      interrupt: async () => { if (index === 1) await slow; },
      sendMessage: async (message: any) => {
        if (starts === 2) allStarted();
        await new Promise<void>(resolve => message.signal?.aborted ? resolve() : setTimeout(resolve, 20));
        if (index === 1) await slow;
      },
    };
  };
  const run = begin({ concurrency: 2 });
  service.start(run.id);
  await running;
  let done = false;
  const pending = stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "update-parallel", timeoutMs: 2000 }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(done, false);
  assert.equal(service.view(run.id).active, true);
  release();
  await pending;
  assert.equal(service.view(run.id).active, false);
  assert.equal(service.view(run.id).phase, "interrupted");
  assert.equal(f.disposed.length, 2);
});

test("知识更新停止覆盖尚未派发的预留，空项目可重复停止", async t => {
  const { f, service, begin, store } = projectFixture(t);
  await stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "empty" });
  const run = begin();
  service.startAsync(run.id);
  await stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "reserved" });
  assert.equal(service.view(run.id).active, false);
  assert.equal(store.readRun(run.id).phase, "interrupted");
  assert.equal(f.sent.length, 0);
  await stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "empty-again" });
});

test("知识停止超时明确失败并保留仍运行的批次", async t => {
  const { f, service, begin, store } = projectFixture(t);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => { await gate; },
    sendMessage: async () => { started(); await gate; },
  });
  const run = begin(); service.start(run.id); await running;
  try {
    await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "timeout", timeoutMs: 10 }), { code: "DESKTOP_UPDATE_KNOWLEDGE_STOP_TIMEOUT" });
    assert.equal(service.view(run.id).active, true);
  } finally { release(); await settled(service, run.id); }
});

test("并发知识中断保留每个失败，重复更新停止不得伪成功", async t => {
  const { store, db } = projectFixture(t);
  let started = 0;
  let ready!: () => void;
  const running = new Promise<void>(resolve => { ready = resolve; });
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    started++; if (started === 2) ready();
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPT_FAILED", `interrupt-${input.title}`);
  }, "parallel-failures", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = service.begin({ requestId: crypto.randomUUID(), mode: "batch", ownerThreadId: "knowledge-owner", selectedNodeIds: ["a", "b"], includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", concurrency: 2, reviewConfig: { enabled: false, model: null, effort: null } });
  service.start(run.id); await running;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "parallel-stop" }), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(value => value.message).sort(), ["interrupt-a", "interrupt-b"]);
    return true;
  });
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "repeat-stop" }));
});

for (const mode of ["worker", "reservation"] as const) test(`知识停止保留${mode}真实异常，重复停止仍失败`, async t => {
  const { store, begin, db } = projectFixture(t);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const cause = new Error(`${mode}-real-failure`);
  /** 在真实取消信号之后失败，验证不能仅凭 aborted 认定正常取消。 */
  const failAfterAbort = async (signal: AbortSignal): Promise<never> => {
    ready();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw cause;
  };
  const service = new KnowledgeGenerationService(store, "ws", input => failAfterAbort(input.signal), "stop-failure", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin();
  if (mode === "reservation") {
    (service as any).prepareRecovery = (_run: unknown, _input: unknown, signal: AbortSignal) => failAfterAbort(signal);
    service.startAsync(run.id);
  } else service.start(run.id);
  await started;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "first-stop" }), error => error === cause);
  assert.equal(service.view(run.id).phase, "failed");
  assert.ok(service.view(run.id).error);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "repeat-stop" }));
});

test("知识停止日志保留聚合根因并脱敏，重复失败保留原因", async t => {
  const { store, begin, db } = projectFixture(t);
  const logs: unknown[] = [];
  const write = db.writeWorkspaceLog;
  t.mock.method(db, "writeWorkspaceLog", (workspaceId: any, entry: any) => { logs.push(entry.data); write(workspaceId, entry); });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const cause = Object.assign(new AggregateError([
    new Error("worker-unique-root token=d09h-synthetic-secret-token"),
    new Error("cleanup-unique-root password=d09h-synthetic-secret-password", { cause: new Error("nested-unique-root apiKey=d09h-synthetic-secret-key") }),
  ], "knowledge-stop-aggregate"), { code: "KNOWLEDGE_ASSET_INTERRUPT_FAILED" });
  const service = new KnowledgeGenerationService(store, "ws", async input => {
    ready();
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw cause;
  }, "stop-log", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin(); service.start(run.id); await started;
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "stop-log-request" }), error => error === cause);
  const serialized = JSON.stringify(logs);
  for (const root of ["worker-unique-root", "cleanup-unique-root", "nested-unique-root"]) assert.ok(serialized.includes(root));
  assert.equal(serialized.includes("d09h-synthetic-secret"), false);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "repeat-log-request" }), error => error === cause);
});

test("知识执行占用释放失败后每次更新停止均明确失败", async t => {
  const { store, begin, db } = projectFixture(t);
  const cause = new Error("release-unique-failure");
  const claim = store.claimRunExecution.bind(store);
  store.claimRunExecution = (id: string) => {
    const release = claim(id);
    return () => { release(); throw cause; };
  };
  const service = new KnowledgeGenerationService(store, "ws", async () => {}, "release-stop", () => ({ nodeId: null, activationVersion: 1 }), db);
  const run = begin(); service.startAsync(run.id);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "first-release-stop" }), error => error === cause);
  await assert.rejects(stopKnowledgeGenerationForUpdate(store.files.root, { requestId: "repeat-release-stop" }), error => error === cause);
  assert.equal(service.view(run.id).phase, "failed");
  assert.deepEqual(Object.keys(service.view(run.id).error!).sort(), ["code", "message"]);
});

test("后台只读命令触发审批时保留工具和原因，真实失败不会伪装完成", async () => {
  const f = fixture();
  let interrupts = 0;
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    interrupt: async () => { interrupts++; },
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    sendMessage: async (message: any, sink: any) => {
      sink.conversation({ threadId: thread.threadId, type: "approval.request", payload: { requestId: "shell-approval", toolName: "Bash", message: "Contains simple_expansion" } });
    },
  });
  await assert.rejects(f.execute(input({ engine: "claude", model: "claude-model" })), (error: any) => {
    assert.equal(error.code, "KNOWLEDGE_ASSET_INPUT_REQUIRED");
    assert.match(error.message, /后台知识任务.*Bash.*交互审批/);
    assert.match(error.message, /Contains simple_expansion/);
    return true;
  });
  assert.equal(interrupts, 1);
  assert.equal(f.events.filter(event => event.type === "turn.error").length, 1);
  assert.equal(f.events.filter(event => event.type === "turn.completed").length, 0);
  assert.equal(f.disposed.length, 1);
});

test("通用turn错误事件不覆盖引擎抛出的具体失败原因", async () => {
  const f = fixture(), cause = new Error("provider HTTP 502: upstream unavailable");
  f.deps.sessions.getOrCreate = () => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
    sendMessage: async (message: any, sink: any) => {
      sink.conversation({ type: "turn.error", payload: { turnId: message.turnId, error: cause.message } });
      throw cause;
    },
  });
  await assert.rejects(f.execute(input()), error => error === cause);
});

test("模型目录未就绪时明确失败，不创建执行线程", async () => {
  resetEngineModelCatalogRuntimeForTest();
  const f = fixture();
  await assert.rejects(f.execute(input({ model: null, effort: null })), /动态模型目录尚未同步/);
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
});

test("显式模型或思考强度已失效时拒绝执行，不静默使用默认项", async () => {
  for (const extra of [{ model: "removed" }, { effort: "xhigh" }]) {
    const f = fixture();
    await assert.rejects(f.execute(input(extra)), /已从当前目录移除|不支持思考强度/);
    assert.equal(f.created.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test("修订默认配置沿用线程实际模型，显式调整后同步保存偏好", async () => {
  const f = fixture();
  let threadId = "";
  await f.execute(input({ model: null, effort: null, onThreadCreated: id => { threadId = id; } }));
  const catalog = { schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 2, capturedAt: 2,
    rows: ["codex", "claude"].flatMap(engine => [false, true].map(isDefault => ({
      catalogItemId: `${engine}:${isDefault}`, engine, providerId: engine === "codex" ? "openai" : "anthropic", providerLabel: engine,
      modelId: isDefault ? `${engine}-new` : engine === "codex" ? "model" : "claude-model", displayName: engine, description: "",
      inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "high", description: "高" }], defaultReasoningEffort: "high",
      contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false, isDefault,
      sortOrder: isDefault ? 2 : 1, runtimeProfileId: "native", transportModelId: null, fastTaskModelId: null, subagentModelId: null,
    }))),
  };
  applyEngineModelCatalogSnapshot(catalog);
  await f.execute(input({ threadId, model: null, effort: null }));
  assert.equal(f.sent[1].input.model, "model");
  assert.equal(f.created[0].prefs.model, "model");
  await f.execute(input({ threadId, model: "codex-new", effort: null }));
  assert.equal(f.sent[2].input.model, "codex-new");
  assert.equal(f.created[0].prefs.model, "codex-new");
});

test("资产修订会话复用原执行线程并保留同一引擎上下文", async () => {
  const f = fixture(), executionIds: string[] = [];
  await f.execute(input({ onThreadCreated: id => executionIds.push(id) }));
  await f.execute(input({ threadId: executionIds[0], onThreadCreated: id => executionIds.push(id) }));
  assert.equal(executionIds.length, 2);
  assert.equal(executionIds[1], executionIds[0]);
  assert.equal(f.created.length, 1);
  assert.equal(new Set(f.sent.map(item => item.thread.threadId)).size, 1);
  assert.deepEqual(f.disposed, [executionIds[0], executionIds[0]]);
});

test("研发会话不能充当批量归属，创建前停止不会启动引擎", async () => {
  const ordinary = fixture("chat");
  await assert.rejects(ordinary.execute(input()), /所属知识会话已失效/);
  assert.equal(ordinary.created.length, 0);
  const stopped = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(stopped.execute(input({ signal: controller.signal })), /已停止/);
  assert.equal(stopped.created.length, 0);
});

test("复检独立于生成上下文，执行线程和系统指令明确标记复检", async () => {
  const f = fixture();
  await f.execute(input({ purpose: "review" }));
  assert.equal(f.created[0].title, "[知识复检] 资产");
  assert.equal(f.sent[0].thread.title, "[知识复检] 资产");
  assert.match(f.sent[0].input.systemMessage, /独立的项目知识复检工程师/);
  assert.match(f.sent[0].input.systemMessage, /重新读取/);
  assert.equal(f.created[0].threadSubtype, "knowledge-assets");
  assert.equal(f.raw.length, 1);
  assert.deepEqual(f.disposed, [f.created[0].id]);
});

test("Codex 动态工具绑定过期时旋转 provider binding，并在同一资产线程重试", async () => {
  const f = fixture();
  let sends = 0;
  let resets = 0;
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic",
    resetDynamicToolBinding: () => { resets++; return true; },
    getSessionId: () => null,
    getActiveTurnId: () => null,
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    interrupt: async () => undefined,
    sendMessage: async (message: any, sink: any) => {
      sends++;
      if (sends === 1) throw Object.assign(new Error("动态工具绑定不一致"), { code: "codex_thread_capability_incompatible" });
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
    },
  });
  await f.execute(input({ registry: { tools: [{ toolId: "knowledge.asset.submit" }] as any } }));
  assert.equal(sends, 2);
  assert.equal(resets, 1);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.disposed, [f.created[0].id]);
});

for (const outcome of ["completed", "provider-error", "invalid-report", "stopped", "cleanup-error"] as const) test(`复检子任务保留独立 trace 并向文件会话收口：${outcome}`, async () => {
  const f = fixture();
  let parentId = "", childId = "";
  await f.execute(input({ onThreadCreated: id => { parentId = id; } }));
  const controller = new AbortController();
  const cause = new Error(`review-${outcome}`);
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
    prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
    sendMessage: async (message: any, sink: any) => {
      assert.notEqual(thread.threadId, parentId);
      sink.raw({ workspaceId: "ws", threadId: thread.threadId, payload: { type: "review-proof" } });
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "item.agentMessage.completed", payload: { itemId: "review-output", engineMessageId: "review-output", revision: 1, text: "已核对真实来源" } });
      if (outcome === "provider-error") throw cause;
      if (outcome === "stopped") controller.abort();
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
    },
  });
  if (outcome === "cleanup-error") f.deps.sessions.disposeThread = async () => { throw cause; };
  const execution = f.execute(input({ purpose: "review", signal: controller.signal, onThreadCreated: id => { childId = id; },
    reviewParent: { threadId: parentId, model: "model", effort: "high", onThreadCreated: id => assert.equal(id, parentId),
      completionSummary: () => { if (outcome === "invalid-report") throw cause; return "复检通过：已核对"; } },
  }));
  if (outcome === "completed") await execution;
  else await assert.rejects(execution, outcome === "stopped" ? /知识任务已停止/ : error => {
    if (outcome !== "cleanup-error") return error === cause;
    assert.ok(error instanceof AggregateError);
    assert.equal((error as AggregateError & { code: string }).code, "KNOWLEDGE_ASSET_INTERRUPT_FAILED");
    assert.deepEqual(error.errors, [cause]);
    return true;
  });
  assert.notEqual(childId, parentId);
  assert.equal(f.created.find(thread => thread.id === childId)?.threadSubtype, "knowledge-review");
  assert.ok(f.raw.some(event => event.threadId === childId && event.payload.type === "review-proof"));
  assert.ok(f.events.some(event => event.threadId === childId && event.type === "item.agentMessage.completed"));
  const parentEvents = f.events.filter(event => event.threadId === parentId && event.type.startsWith("item.subagent."));
  assert.deepEqual(parentEvents.map(event => event.type), ["item.subagent.started", "item.subagent.childEvent", "item.subagent.childEvent", "item.subagent.completed"]);
  assert.equal(new Set(parentEvents.map(event => event.payload.taskId)).size, 1);
  assert.ok(parentEvents.some(event => event.type === "item.subagent.childEvent" && event.payload.innerEventType === "item.agentMessage.completed" && event.payload.innerPayload.text === "已核对真实来源"));
  assert.equal(parentEvents.at(-1).payload.status, outcome === "completed" ? "completed" : outcome === "stopped" ? "stopped" : "failed");
  assert.equal(f.events.filter(event => event.threadId === parentId && event.type === "turn.started").length, 1);
});

test("单独复检从确切版本复用原生成会话，不受最近任务列表上限影响", async t => {
  const { f, store, service, begin } = projectFixture(t);
  const sentThreads: string[] = [];
  f.deps.sessions.getOrCreate = (thread: any) => ({
    resolvePlatformToolTransport: () => "native-dynamic", interrupt: async () => {},
    sendMessage: async (message: any, sink: any) => {
      sentThreads.push(thread.threadId);
      const read = await message.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "source.ts", count: 1 } });
      assert.equal(read.ok, true);
      const sources = [{ kind: "code", path: "source.ts", contentHash: read.output.contentHash, startLine: 1, endLine: 1, relation: "真实实现" }];
      const reviewing = message.systemMessage.includes("独立的项目知识复检");
      if (reviewing) assert.equal((await message.executeHostTool({ toolId: "knowledge.review.read", toolInput: {} })).ok, true);
      const submitted = await message.executeHostTool({ toolId: reviewing ? "knowledge.review.submit" : "knowledge.asset.submit", toolInput: reviewing
        ? { outcome: "passed", summary: "已核验", issues: [], sources } : { content: "# 说明\n真实实现。", summary: "说明", sources } });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      sink.conversation({ workspaceId: "ws", threadId: thread.threadId, type: "turn.completed", payload: { turnId: message.turnId } });
    },
  });
  const generation = begin({ selectedNodeIds: ["a"] });
  service.start(generation.id);
  const generated = await settled(service, generation.id);
  assert.equal(generated.phase, "completed", JSON.stringify(generated.error ?? generated.items));
  const original = generated.items[0]!;
  for (let i = 0; i < 51; i++) store.saveRun({ ...store.readRun(generation.id), id: `later-${i}`, createdAt: "2099-01-01T00:00:00.000Z", items: [] });
  assert.equal(store.listRuns().some(run => run.id === generation.id), false);
  const inspection = begin({ mode: "review", selectedNodeIds: ["a"], reviewConfig: { enabled: true, model: null, effort: null } });
  service.start(inspection.id);
  const reviewed = await settled(service, inspection.id);
  assert.equal(reviewed.phase, "completed", JSON.stringify(reviewed.error ?? reviewed.items));
  assert.equal(reviewed.items[0]!.revisionId, original.revisionId);
  assert.equal(reviewed.items[0]!.executionThreadId, original.executionThreadId);
  assert.equal(reviewed.items[0]!.review?.parentThreadId, original.executionThreadId);
  assert.notEqual(sentThreads[1], original.executionThreadId);
  assert.deepEqual(f.created.map(thread => thread.threadSubtype), ["knowledge-assets", "knowledge-review"]);
  assert.ok(f.events.some(event => event.threadId === original.executionThreadId && event.type === "item.subagent.completed"));
});

for (const mismatch of ["missing", "archived", "workspace", "engine", "owner", "shared-workspace", "subtype"] as const) test(`复检版本来源会话不符合复用范围时建立宿主：${mismatch}`, async () => {
  const f = fixture();
  let sourceId = "", workId = "";
  await f.execute(input({ onThreadCreated: id => { sourceId = id; } }));
  const source = f.created[0]!;
  if (mismatch === "missing") sourceId = "another-client-thread";
  if (mismatch === "archived") source.archived = true;
  if (mismatch === "workspace") source.workspaceId = "other-workspace";
  if (mismatch === "engine") source.engine = "claude";
  if (mismatch === "owner") source.sharedAcl.ownerUserId = "other-user";
  if (mismatch === "shared-workspace") source.sharedAcl.sharedWorkspaceId = "other-shared-workspace";
  if (mismatch === "subtype") source.threadSubtype = "knowledge-conversation";
  await f.execute(input({ purpose: "review", reviewParent: {
    threadId: null, sourceThreadId: sourceId, model: "model", effort: "high", onThreadCreated: id => { workId = id; }, completionSummary: () => "复检通过",
  } }));
  assert.notEqual(workId, sourceId);
  assert.equal(f.created.length, 3);
  assert.equal(f.created[1].threadSubtype, "knowledge-assets");
  assert.ok(f.events.some(event => event.threadId === workId && event.type === "item.subagent.started"));
  assert.equal(f.events.some(event => event.threadId === sourceId && event.type === "item.subagent.started"), false);
});

test("复检子任务拒绝无效父会话，创建前停止不产生线程或事件", async () => {
  for (const stopped of [false, true]) {
    const f = fixture(), controller = new AbortController();
    if (stopped) controller.abort();
    await assert.rejects(f.execute(input({ purpose: "review", signal: controller.signal,
      reviewParent: { threadId: "unknown", model: "model", effort: "high", onThreadCreated: () => assert.fail("无效父会话不可回写"), completionSummary: () => "通过" },
    })), stopped ? /知识任务已停止/ : /文件工作会话已失效/);
    assert.equal(f.created.length, 0);
    assert.equal(f.events.length, 0);
  }
  const other = fixture();
  let parentId = "";
  await other.execute(input({ onThreadCreated: id => { parentId = id; } }));
  other.created[0].sharedAcl.ownerUserId = "other-user";
  await assert.rejects(other.execute(input({ purpose: "review", reviewParent: {
    threadId: parentId, model: "model", effort: "high", onThreadCreated: () => assert.fail("不得连接其他用户的工作会话"), completionSummary: () => "通过",
  } })), /文件工作会话已失效/);
  assert.equal(other.created.length, 1);
});
