import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ManagedServiceRuntime } from "../src/orchestration/managedServiceRuntime.js";
import { RequirementAnalysisService } from "../src/orchestration/requirementAnalysisService.js";
import { AiGateEvaluationService } from "../src/orchestration/aiGateEvaluationService.js";
import { ToolRuntimeService } from "../src/orchestration/toolRuntimeService.js";
import { ThreadSessionManager } from "../src/engines/threadSessionManager.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { createDefaultRoleExecutionConfig } from "@codeflowai/shared";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";

/** 真实W库和低层SQL许可断言；仅替换外部引擎，不伪造编排持久状态。 */
function fixture(t: test.TestContext, roleNode = false) {
  applyEngineModelCatalogSnapshot({ schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-db-coordination-"));
  const app = openClientDb({ dbPath: path.join(root, "app.db") });
  const workspaceId = "orch:coordinated";
  app.workspaces.upsert({ id: workspaceId, title: "编排许可", path: root });
  const db = app.forWorkspace(workspaceId);
  const role = { id: "role", workspaceId, name: "许可角色", description: "", responsibility: "验证", systemPrompt: "验证",
    inputDefinition: { instructions: "验证", requiredFields: [] },
    outputDefinition: { instructions: "", deliveryMode: "direct", format: "markdown", resultKey: "report", filePathRule: null, requiredFields: [] },
    gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig(), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" };
  const workflow = { id: "flow", workspaceId, family: "feature-dev", name: "短段验证", description: "", version: 1,
    nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "next", type: roleNode ? "role" : "end", label: "结束", position: { x: 1, y: 0 }, ...(roleNode ? { roleId: "role" } : {}) }],
    edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "next", conditionBranch: null, dataMappings: [] }], createdAt: 1, updatedAt: 1 };
  const instance = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow as any,
    intakeSnapshot: { id: "intake", workspaceId, triggerMode: "manual", taskType: "feature", title: "许可验证", goal: "许可验证",
      background: null, acceptanceCriteria: null, workbenchItemRefs: null, seedArtifactRefs: null, constraints: null, requester: null, createdAt: 1, updatedAt: 1 },
    assetRuntimeSnapshot: { authorityMode: "legacy", workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
      roles: roleNode ? { role: { assetType: "role", assetId: "role", definition: role, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 } } } : {}, knowledgeBundles: {}, toolsets: {}, skills: {} } as any });
  let permitted = false;
  let tail = Promise.resolve();
  const withLegacyDatabase = <T>(_requestId: string, operation: () => T): Promise<T> => {
    const run = tail.then(() => {
      permitted = true;
      try {
        const value = operation();
        assert.equal(Boolean(value && typeof (value as any).then === "function"), false, "数据库许可不得跨await");
        return value;
      } finally { permitted = false; }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  let sends = 0;
  const conversations: unknown[] = [];
  const sessions = { getActiveTurnId() { return null; }, releaseCodexRecoveryPending() { return false; },
    getOrCreate() { return { resolvePlatformToolTransport() { return "native-dynamic"; },
      async sendMessage() { assert.equal(permitted, false); sends++; await new Promise(resolve => setImmediate(resolve)); throw new Error("CONTROLLED_ENGINE_FAILURE"); },
      async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; } }; },
    async interrupt() { assert.equal(permitted, false); await new Promise(resolve => setImmediate(resolve)); return true; } };
  const engine = new OrchestrationEngine({ db, withLegacyDatabase, threads: new ThreadStore(), sessions: sessions as any,
    workspaces: new Map([[workspaceId, root]]), timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
    emitConversation(event) { conversations.push(event); }, emitRaw() {} });
  app.configureLegacyAccessGuard(() => { if (!permitted) throw new Error("TEST_ORCHESTRATION_DB_PERMISSION_REQUIRED"); });
  t.after(async () => { app.configureLegacyAccessGuard(null); await engine.stopAndDrain(); app.close(); resetEngineModelCatalogRuntimeForTest(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, db, engine, instance, root, withLegacyDatabase, sessions, conversations, sends: () => sends };
}

test("编排start与DAG完成阶段在低层guard启用时逐段写入", async t => {
  const f = fixture(t);
  await f.engine.start(f.instance.id);
  await f.engine.waitForInFlightWork();
  assert.equal(await f.withLegacyDatabase("verify", () => f.db.orchInstances.get(f.instance.id)?.status), "completed");
});

test("编排cancelAndWait在引擎等待前释放许可且终态持久化", async t => {
  const f = fixture(t, true);
  await f.withLegacyDatabase("stage", () => {
    const threadId = "running-thread", turnId = "running-turn";
    f.db.threads.create({ id: threadId, workspaceId: f.instance.workspaceId, engine: "claude", title: "运行中" });
    f.db.turns.insertStarted({ workspaceId: f.instance.workspaceId, threadId, turnId, engine: "claude", startedAt: 1, startEventSeq: null });
    const instance = f.db.orchInstances.get(f.instance.id)!;
    instance.nodeStates.next = { ...instance.nodeStates.next!, status: "running", threadId };
    f.db.orchInstances.updateNodeStates(instance.id, instance.nodeStates); f.db.orchInstances.updateStatus(instance.id, "running");
  });
  await f.engine.cancelAndWait(f.instance.id);
  assert.equal(await f.withLegacyDatabase("verify", () => f.db.orchInstances.get(f.instance.id)?.status), "cancelled");
});

test("角色节点准备和失败收尾持短许可，模型执行期间无数据库许可", async t => {
  const f = fixture(t, true);
  await f.engine.start(f.instance.id);
  await f.engine.waitForInFlightWork();
  assert.equal(f.sends(), 1);
  const instance = await f.withLegacyDatabase("verify-role", () => f.db.orchInstances.get(f.instance.id));
  assert.match(String(instance?.nodeStates.next?.error), /CONTROLLED_ENGINE_FAILURE/u);
});

test("角色结果提交和产物结算通过低层许可，已结束owner拒绝迟到输出", async t => {
  const f = fixture(t, true);
  let lateOutput!: () => void;
  (f.sessions as any).getOrCreate = () => ({
    resolvePlatformToolTransport() { return "native-dynamic"; },
    async sendMessage(input: any, emitters: any) {
      const event = { ts: Date.now(), workspaceId: f.instance.workspaceId, threadId: "unused", engine: "claude", type: "item.agentMessage.delta", payload: { text: "输出" } };
      emitters.conversation(event);
      lateOutput = () => emitters.conversation(event);
      const submitted = await input.executeHostTool({ toolId: "runtime.submitNodeResult", accessMode: "full-access", toolInput: {
        answer: { mode: "text", text: "许可内已完成" }, review: { verdict: "pass", summary: "完成", blockingIssues: null },
        control: { nextAction: "continue" }, acceptanceChecks: null, humanInput: null, rework: null,
      } });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      return { responseText: "许可内已完成" };
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  });
  await f.engine.start(f.instance.id);
  await f.engine.waitForInFlightWork();
  const final = await f.withLegacyDatabase("verify-result", () => ({
    instance: f.db.orchInstances.get(f.instance.id), artifacts: f.db.orchArtifacts.listByInstance(f.instance.id),
  }));
  assert.equal(final.instance?.status, "completed");
  assert.equal(final.artifacts.length, 1);
  const count = f.conversations.length;
  lateOutput();
  assert.equal(f.conversations.length, count);
});

test("需求分析准备在许可中校验线程，输入失败保留业务原因", async t => {
  const f = fixture(t);
  const threadId = "requirement-thread" as any;
  await f.withLegacyDatabase("stage-analysis", () => f.db.threads.create({ id: threadId, workspaceId: f.instance.workspaceId, engine: "claude", title: "需求", threadSubtype: "requirement-analysis" }));
  const service = new RequirementAnalysisService({ db: f.db, threads: new ThreadStore(), sessions: f.sessions,
    withLegacyDatabase: f.withLegacyDatabase, workspaces: new Map(), emitConversation() {}, emitRaw() {}, timeoutPolicy: {} } as any);
  await assert.rejects(service.sendMessage({ workspaceId: f.instance.workspaceId, sessionId: threadId, text: "" }), /请输入需求描述或补充信息/u);
});

test("托管服务的归属读取和生命周期回调经过许可，进程等待不持许可", async t => {
  const f = fixture(t), threadId = "managed-thread" as any;
  await f.withLegacyDatabase("stage-service", () => f.db.threads.create({ id: threadId, workspaceId: f.instance.workspaceId, engine: "claude", title: "服务" }));
  const changes: string[] = [];
  const runtime = new ManagedServiceRuntime({ db: f.db, withLegacyDatabase: f.withLegacyDatabase,
    onChanged: (event: any) => { f.db.threads.get(threadId); changes.push(event.status); } } as any);
  t.after(() => runtime.disposeThreadServices(threadId));
  const ctx = { workspacePath: f.root, threadId, instanceId: f.instance.id };
  const tool = runtime.buildBuiltinTools()[0]!;
  await runtime.executeBuiltinTool(tool, { action: "ensure", serviceId: "guarded", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], ready: { delayMs: 10 } }, ctx);
  await runtime.stopThreadService(threadId, "guarded");
  assert.ok(changes.includes("ready"));
  assert.ok(changes.includes("stopped"));
});

test("AI门禁准备、提交回调和结果回写在许可中，模型等待不持许可", async t => {
  const f = fixture(t), text = "验证";
  const sessions = { getOrCreate() { return {
    resolvePlatformToolTransport() { return "native-dynamic"; },
    async sendMessage(input: any) {
      await new Promise(resolve => setImmediate(resolve));
      const body = JSON.parse(input.toolRegistry.tools[0].invocationHint);
      body.results[0].evidence = [{ sourceId: "artifact-body", startOffset: 0, endOffset: 1, quote: "验" }];
      const result = await input.executeHostTool({ toolId: input.toolRegistry.tools[0].toolId, toolInput: body });
      assert.equal(result.ok, true, JSON.stringify(result));
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
  }; } };
  const events: string[] = [];
  const service = new AiGateEvaluationService({ db: f.db, gateRuns: f.db.orchGateEvaluationRuns, threads: new ThreadStore(),
    sessions, withLegacyDatabase: f.withLegacyDatabase, timeoutPolicy: {}, emitConversation() {}, emitRaw() {},
    createPromptSnapshot() { f.db.orchInstances.get(f.instance.id); return { id: "gate-prompt" }; },
    emitEvent(type: string) { f.db.orchInstances.get(f.instance.id); events.push(type); } } as any);
  const result = await service.evaluate({ requestId: "guard-gate", evaluationRunId: "gate-run", instanceId: f.instance.id,
    nodeId: "next", nodeLabel: "验收", nodeAttemptId: "gate-attempt", artifactId: "gate-artifact", workspaceId: f.instance.workspaceId,
    criteria: [{ id: "criterion", type: "ai", config: "验证", label: "标准", blocking: true }],
    artifactSources: [{ sourceId: "artifact-body", path: null, text, sha256: crypto.createHash("sha256").update(text).digest("hex") }],
    engine: "claude", model: null, effort: null, accessMode: "read-only", contextWindow: null, autoCompactPct: null,
    prompt: { promptEnvelope: {}, runtimePolicy: {}, artifactInput: {}, knowledgeCatalogs: [], knowledgeWarnings: [], systemMessage: "评估", developerMessage: "评估" },
  } as any);
  assert.equal(result.results[0]?.passed, true);
  assert.equal(await f.withLegacyDatabase("verify-gate", () => f.db.orchGateEvaluationRuns.get(result.evaluationRunId)?.status), "completed");
  assert.deepEqual(events, ["orchestration.gateEvaluationStarted", "orchestration.gateEvaluationCompleted"]);
});

test("脚本准备和失败日志在许可中，真实进程失败保持显式失败", async t => {
  const f = fixture(t);
  const runtime = new ToolRuntimeService(f.root, { db: f.db, workspaceId: f.instance.workspaceId, withLegacyDatabase: f.withLegacyDatabase });
  const result = await runtime.execute({ toolId: "guard-node", name: "Node", runtime: "node", code: "process.exit(17)", permissions: { requiresWrite: false } } as any,
    {}, "full-access", { requestId: "guard-script" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 17);
});

test("真实session manager发送、追加、交互、停止和释放沿短许可回写绑定", async t => {
  const f = fixture(t), threads = new ThreadStore(), threadId = "manager-thread" as any, turnId = "manager-turn" as any;
  await f.withLegacyDatabase("stage-manager", () => {
    f.db.threads.create({ id: threadId, workspaceId: f.instance.workspaceId, engine: "codex", title: "会话许可" });
    f.db.turns.insertStarted({ workspaceId: f.instance.workspaceId, threadId, turnId, engine: "codex", startedAt: 1, startEventSeq: null });
  });
  const runtime = threads.create({ threadId, workspaceId: f.instance.workspaceId, engine: "codex", title: "会话许可" });
  let onMessage!: (event: any) => void, released = 0;
  const ws = { async ensureStarted() {}, registerThread(_id: string, callback: typeof onMessage) { onMessage = callback; return () => {}; },
    async request(method: string) {
      if (method === "thread/start") return { thread: { id: "manager-provider" } };
      if (method === "turn/start" || method === "turn/steer") return { turn: { id: "manager-provider-turn" } };
      if (method === "turn/interrupt") {
        setImmediate(() => onMessage({ method: "turn/completed", params: { threadId: "manager-provider", turn: { id: "manager-provider-turn", status: "interrupted" } } }));
        return {};
      }
      assert.fail(`unexpected provider request: ${method}`);
    }, async respond() {} };
  const manager = new ThreadSessionManager({ threads, workspaces: new Map([[f.instance.workspaceId, f.root]]), withLegacyDatabase: f.withLegacyDatabase,
    writeWorkspaceLog: (workspaceId, entry) => f.db.writeWorkspaceLog(workspaceId, entry), sessionIdleCleanup: { enabled: false },
    builtInRelayCredentials: { acquire() { f.db.engineKeys.list(); return { config: null, owner: null, assertCurrent() {}, release() {} }; } } as any,
    resolveCodexRuntimeConfig() { f.db.engineKeys.list(); return null; },
    assertCodexMutationAllowed() { f.db.rollbacks.findLatestUnresolvedByThread(threadId); },
    persistSessionBinding: (id, sessionId, capabilities) => f.db.threads.setSessionBinding(id, sessionId, capabilities),
    persistCodexStartAttempt: input => f.db.turns.setCodexStartAttempt(input as any),
  });
  (manager as any).codexAppServer = { forThread() { return { getOrCreate() { return ws; } }; }, async releaseThread() { released++; } };
  t.after(() => manager.stopAndDrain());
  const session = await f.withLegacyDatabase("create-manager", () => manager.getOrCreate(runtime));
  const sending = session.sendMessage({ turnId, userItemId: "manager-user", text: "执行", images: [], assistantItemId: "manager-assistant", reasoningItemId: "manager-reasoning" } as any,
    { conversation() {}, raw() {} });
  const outcome = Promise.allSettled([sending]);
  for (let tick = 0; !(session as any).active && tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.ok((session as any).active);
  await manager.appendInput(threadId, { turnId, text: "补充", images: [] } as any);
  (session as any).pendingRequests.set("approval", { kind: "approval", id: "approval" });
  await (session as any).respondApproval("approval", "accept");
  (session as any).pendingRequests.set("question", { kind: "userInput", id: "question" });
  await (session as any).respondUserInput("question", {});
  assert.equal(await manager.interrupt(threadId, turnId), true);
  await outcome;
  assert.equal(await f.withLegacyDatabase("verify-manager", () => f.db.threads.get(threadId)?.sessionId), "manager-provider");
  await manager.disposeThread(threadId);
  assert.equal(released, 1);
});
