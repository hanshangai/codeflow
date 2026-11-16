import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type ConversationEventInput,
  type EngineModelCatalogSnapshot,
  type RawEngineEventInput,
  type ThreadId,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ClientDbWriterService } from "../../apps/desktop/client/src/db/clientDbWriterService.ts";
import { createLocalEventPipeline } from "../../apps/desktop/client/src/runtime/localEventPersistence.ts";
import { AssetDraftService, AssetDraftServiceError, hasInFlightAssetDraftWork, stopAssetDraftJobsForUpdate } from "../../apps/desktop/client/src/orchestration/assetDraftService.ts";
import { flushClientLogger, resolveClientLogDir } from "../../apps/desktop/client/src/logger.ts";
import {
  applyEngineModelCatalogSnapshot,
  resetEngineModelCatalogRuntimeForTest,
} from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";

function buildToolSubmission(name: string, options?: { executionConfig?: ReturnType<typeof createDefaultRoleExecutionConfig> }) {
  const submission = {
    draft: {
      name,
      description: `${name} 描述`,
      responsibility: `${name} 职责`,
      systemPrompt: [
        `你是 ${name}。`,
        "职责：围绕真实用户路径执行 E2E、冒烟、回归与缺陷复现，输出可执行的验证结论。",
        "执行纪律：先理解需求边界，再制定验证方案，并明确记录风险与限制。",
        "边界限制：不要伪造测试结果；如果环境不支持浏览器自动化，必须说明降级验证方式和剩余风险。",
      ].join(" "),
      inputDefinition: createDefaultRoleInputDefinition(),
      outputDefinition: createDefaultRoleOutputDefinition(),
      gateCriteria: [],
      executionConfig: createDefaultRoleExecutionConfig("codex"),
      defaultKnowledgeBundleIds: [] as string[],
      toolRefs: [],
      kind: "custom",
    },
    rationale: {
      summary: "按当前上下文生成",
      keyDecisions: ["保留最小字段集合"],
      assumptions: [],
      risks: [],
    },
    referenceSummary: {
      roleIds: [],
      knowledgeBundleIds: [],
      toolsetIds: [],
      selectedPaths: [],
    },
  };
  if (options?.executionConfig) submission.draft.executionConfig = options.executionConfig;
  return submission;
}

function buildSkillToolSubmission(name: string, scriptText = "console.log('ok');") {
  const skillMd = [
    "---",
    `name: "${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}"`,
    `description: "${name} 描述"`,
    "---",
    "",
    `# ${name}`,
    "",
    "按说明执行 Skill，并输出结果与风险。",
  ].join("\n");
  return {
    draft: {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: `${name} 描述`,
      trigger: "当用户需要执行该技能时使用。",
      instructions: "先判断触发条件，再读取必要上下文并输出结构化结论。",
      targetEngines: ["codex"],
      tags: ["test"],
      skillMd,
      files: [
        {
          relPath: "SKILL.md",
          kind: "skill-md",
          contentText: skillMd,
        },
        {
          relPath: "scripts/check.mjs",
          kind: "script",
          contentText: scriptText,
        },
      ],
      scripts: [
        {
          id: "check",
          name: "检查脚本",
          description: "执行辅助检查。",
          scriptPath: "scripts/check.mjs",
          runtime: "node",
          inputSchema: "{\"type\":\"object\"}",
          outputSchema: "{\"type\":\"object\"}",
          exposeAsTool: true,
        },
      ],
      installTargets: ["codex"],
    },
    rationale: {
      summary: "按当前上下文生成 Skill",
      keyDecisions: ["保留 SKILL.md 和一个脚本入口"],
      assumptions: [],
      risks: [],
    },
    referenceSummary: {
      skillIds: [],
      selectedPaths: [],
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

/** 使用真实 ClientDb 与本地 provider 哨兵，所有工作区资源由 cleanup 回收。 */
function createHarness(options?: {
  onSendMessage?: (input: any, emitters: any, meta: { callIndex: number; workspaceId: WorkspaceId; threadId: ThreadId }) => Promise<{ responseText: string }>;
  catalog?: EngineModelCatalogSnapshot;
  localCanonicalEvents?: boolean;
}) {
  applyEngineModelCatalogSnapshot(options?.catalog ?? {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion: 1,
    capturedAt: 1,
    rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1),
  });
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-asset-draft-"));
  const workspaceId = "ws-asset-draft" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const db = openClientDb({ dbPath, localCanonicalEvents: options?.localCanonicalEvents });
  const threads = new ThreadStore();
  let conversationSeq = 0;
  let rawSeq = 0;
  let callIndex = 0;
  const prompts: string[] = [];
  const sendMessages: any[] = [];

  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  const workspaceDb = db.forWorkspace(workspaceId);

  const sessions = {
    getOrCreate(thread: { threadId: string }) {
      threads.setSessionId(thread.threadId as any, "engine-session-asset-draft" as any);
      const currentCall = callIndex++;
      return {
        resolvePlatformToolTransport() {
          return "native-dynamic";
        },
        hasActiveTurn() {
          return false;
        },
        async interrupt() {
          return true;
        },
        async prepareAssistantTerminalEvents() {
          return { events: [], latestAssistantText: null };
        },
        sendMessage: async (input: any, emitters: any) => {
          sendMessages.push(input);
          prompts.push(String(input.text ?? ""));
          if (options?.onSendMessage) {
            return await options.onSendMessage(input, emitters, {
              callIndex: currentCall,
              workspaceId,
              threadId: thread.threadId as any,
            });
          }

          throw new Error("missing test sendMessage handler");
        },
      };
    },
  } as any;

  const serviceDeps: ConstructorParameters<typeof AssetDraftService>[0] = {
    db: workspaceDb,
    workspaces: new Map([[workspaceId, workspacePath]]),
    threads,
    sessions,
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation: (event: ConversationEventInput) => {
      const ts = Number(event.ts ?? Date.now());
      workspaceDb.conversationEvents.appendEnvelope({
        ...event,
        ts,
        seq: ++conversationSeq,
      } as any);
      workspaceDb.threads.touch(event.threadId, ts);
    },
    emitRaw: (event: RawEngineEventInput) => {
      workspaceDb.rawEvents.appendEnvelope({
        ...event,
        ts: Number(event.ts ?? Date.now()),
        seq: ++rawSeq,
      } as any);
    },
  };
  const service = new AssetDraftService(serviceDeps);

  return {
    db: workspaceDb,
    service,
    serviceDeps,
    workspaceId,
    workspacePath,
    prompts,
    sendMessages,
    cleanup() {
      db.close();
      resetEngineModelCatalogRuntimeForTest();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

for (const assetKind of ["role", "skill"] as const) test(`资产${assetKind}草案在真实Writer下完成生成续跑，provider执行不持数据库许可`, async () => {
  const harness = createHarness({ localCanonicalEvents: true, onSendMessage: async (input, _emitters, meta) => {
    assert.throws(() => harness.db.orchAssetGenerationJobs.get("unused" as never), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
    assert.ok(await writer.withLegacyDatabase("verify-started-before-provider", () => harness.db.conversationEvents.getLatestSeqByThread(meta.threadId)) > 0);
    const result = await input.executeHostTool({ toolId: input.toolRegistry.tools[0].toolId,
      toolInput: assetKind === "role" ? buildToolSubmission("Writer 草案") : buildSkillToolSubmission("Writer Skill"), accessMode: input.accessMode });
    assert.equal(result.ok, true, JSON.stringify(result));
    return { responseText: "已提交" };
  } });
  const failures: unknown[] = [];
  const writer = new ClientDbWriterService({ dbPath: path.join(harness.workspacePath, "client.db"), db: harness.db,
    onFatalError: error => { failures.push(error); } });
  const pipeline = createLocalEventPipeline({ writer, apply() {}, publish() {}, onFailure: error => { failures.push(error); } });
  try {
    await writer.ready();
    harness.serviceDeps.withLegacyDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
    harness.serviceDeps.flushLocalEvents = (workspaceId, threadId) => pipeline.flush(workspaceId, threadId);
    harness.serviceDeps.emitConversation = event => pipeline.enqueue({ t: "conversation.event", event }, event.payload.turnId ?? null, 1);
    harness.serviceDeps.emitRaw = event => pipeline.enqueue({ t: "raw.event", event }, event.clientTurnId ?? null, 1);
    const started = await harness.service.generateAssetDraft({ workspaceId: harness.workspaceId, assetKind, mode: "create", prompt: "生成草案" });
    await waitFor(() => !hasInFlightAssetDraftWork(harness.db));
    const job = await writer.withLegacyDatabase("verify-draft", () => harness.db.orchAssetGenerationJobs.get(started.job.id));
    assert.equal(job?.status, "awaiting_review");
    assert.ok(job?.draftId);
    await harness.service.resumeAssetDraftJob({ workspaceId: harness.workspaceId, jobId: started.job.id, prompt: "继续细化草案" });
    await waitFor(() => !hasInFlightAssetDraftWork(harness.db));
    const resumed = await writer.withLegacyDatabase("verify-resumed", () => harness.db.orchAssetGenerationJobs.get(started.job.id));
    assert.equal(resumed?.status, "awaiting_review");
    assert.notEqual(resumed?.draftId, job.draftId);
    assert.deepEqual(failures, []);
  } finally { try { await pipeline.close(); } finally { await writer.close(); harness.cleanup(); } }
});

test("资产更新停止在真实Writer下中断原turn，排空生成后才写取消", async () => {
  let entered!: () => void, release!: () => void;
  const providerEntered = new Promise<void>(resolve => { entered = resolve; });
  const provider = new Promise<void>(resolve => { release = resolve; });
  const h = createHarness({ localCanonicalEvents: true, onSendMessage: async () => { entered(); await provider; return { responseText: "已停止" }; } });
  const failures: unknown[] = [];
  const writer = new ClientDbWriterService({ db: h.db, dbPath: path.join(h.workspacePath, "client.db"), onFatalError: error => { failures.push(error); } });
  const pipeline = createLocalEventPipeline({ writer, apply(message) {
    if (message.t !== "conversation.event" || message.event.type !== "turn.started") return;
    const event = message.event;
    h.db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
      turnId: event.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
  }, publish() {}, onFailure: error => { failures.push(error); } });
  try {
    await writer.ready();
    const withLegacyDatabase = <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation);
    h.serviceDeps.withLegacyDatabase = withLegacyDatabase;
    h.serviceDeps.flushLocalEvents = (workspaceId, threadId) => pipeline.flush(workspaceId, threadId);
    h.serviceDeps.emitConversation = event => pipeline.enqueue({ t: "conversation.event", event }, event.payload.turnId ?? null, 1);
    const started = await h.service.generateRoleDraft({ workspaceId: h.workspaceId, assetKind: "role", mode: "create", prompt: "停止验证" });
    await providerEntered;
    let interrupted = 0, disposed = 0;
    await stopAssetDraftJobsForUpdate(h.db, { requestId: "writer-stop", withLegacyDatabase,
      interruptTurn: async target => {
        interrupted += 1;
        assert.throws(() => h.db.turns.get(target.turnId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
        release();
        await withLegacyDatabase("stop-confirmed", () => h.db.turns.setEnded(target.turnId, { status: "error", endedAt: Date.now(), endEventSeq: 100 }));
      }, disposeThread: async () => { disposed += 1; },
    });
    assert.equal(interrupted, 1);
    assert.equal(disposed, 1);
    assert.equal(hasInFlightAssetDraftWork(h.db), false);
    assert.equal(await withLegacyDatabase("verify-cancelled", () => h.db.orchAssetGenerationJobs.get(started.job.id)?.status), "cancelled");
    assert.deepEqual(failures, []);
  } finally { release(); try { await pipeline.close(); } finally { await writer.close(); h.cleanup(); } }
});

test("AssetDraftService 在引擎请求补充信息时把 job 置为 awaiting_input，并允许 resume 后继续生成", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      if (meta.callIndex === 0) {
        emitters?.conversation?.({
          ts: Date.now(),
          workspaceId: meta.workspaceId,
          threadId: meta.threadId,
          engine: "codex",
          type: "userInput.requested",
          payload: {
            requestId: "req-1",
            request: { requestId: "req-1", params: { itemId: "input-1", threadId: meta.threadId, turnId: input.turnId, questions: [] } },
            header: "需要补充角色边界",
            prompt: "请补充这个角色应该重点负责什么。",
            questions: [
              {
                id: "focus",
                header: "重点职责",
                question: "请补充这个角色的重点职责",
              },
            ],
          },
        });
        throw new Error("turn interrupted");
      }

      assert.equal(input.providerNativeToolPolicy, "allow");
      assert.ok(input.toolRegistry?.tools?.length);
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission("补全后的角色"),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = "我已经按要求提交了角色草案，重点补全了测试职责和验证边界。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-assistant-message",
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });
  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "帮我生成一个新的测试工程师角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_input");
    const pendingJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(pendingJob?.status, "awaiting_input");
    assert.equal(pendingJob?.interactionRequest?.kind, "input");
    assert.equal(pendingJob?.interactionRequest?.reason, "clarification_required");
    assert.match(String(pendingJob?.interactionRequest?.prompt ?? ""), /补充这个角色/);
    assert.ok(String(pendingJob?.requestJson ?? "").includes("测试工程师"));

    const resumed = await harness.service.resumeRoleDraftJob({
      workspaceId: harness.workspaceId,
      jobId: start.job.id as any,
      prompt: "重点负责 E2E 回归、冒烟验证和缺陷复现。",
      selectedPaths: [],
      targetThreadId: pendingJob?.threadId ?? null,
      enginePreference: {
        engine: "codex",
        model: "gpt-5.6-terra",
        effort: "high",
        contextWindow: 372_000,
        autoCompactPct: 92,
        serviceTier: "fast",
      },
    });
    assert.equal(resumed.job.id, start.job.id);

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const completedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(completedJob?.status, "awaiting_review");
    assert.equal(completedJob?.interactionRequest ?? null, null);
    assert.ok(String(completedJob?.requestJson ?? "").includes("E2E 回归"));
    assert.deepEqual(JSON.parse(String(completedJob?.requestJson ?? "{}")).enginePreference, {
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: "high",
      contextWindow: 372_000,
      autoCompactPct: 92,
      serviceTier: "fast",
    });
    assert.equal(harness.sendMessages[1]?.model, "gpt-5.6-terra");
    assert.equal(harness.sendMessages[1]?.effort, "high");
    assert.equal(harness.sendMessages[1]?.contextWindow, 372_000);
    assert.equal(harness.sendMessages[1]?.autoCompactPct, 92);
    assert.equal(harness.sendMessages[1]?.serviceTier, "fast");

    const draft = completedJob?.draftId ? harness.db.orchAssetDrafts.get(completedJob.draftId) : null;
    assert.ok(draft);
    assert.equal(draft?.status, "awaiting_review");
    assert.match(String(draft?.payloadJson ?? ""), /补全后的角色/);
  } finally {
    harness.cleanup();
  }
});

/** 仅读实际工作区日志文件，不以 mock 调用代替物理归属断言。 */
function readAssetWorkspaceLogs(workspacePath: string): any[] {
  const directory = path.join(workspacePath, ".codeflowai");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client-\d{8}\.\d+\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

for (const assetKind of ["role", "skill"] as const) for (const resume of [false, true]) test(`资产工作区日志 ${assetKind} ${resume ? "resume" : "generate"} 公开失败只写可信 A`, async () => {
  const marker = `asset-w-log-${assetKind}-${resume}-中文🙂`;
  const business = new AssetDraftServiceError(503, "ENGINE_UNAVAILABLE", `${marker} token=asset-synthetic-secret password=asset-synthetic-password`);
  const other = createHarness({ onSendMessage: async () => { assert.fail("B 不应派发 provider"); } });
  const h = createHarness({ onSendMessage: async (_input, emitters, meta) => {
    if (resume && meta.callIndex === 0) {
      emitters.conversation({ workspaceId: meta.workspaceId, threadId: meta.threadId, engine: "codex", type: "userInput.requested", payload: {
        requestId: "input-log", prompt: "请补充", questions: [],
        request: { requestId: "input-log", params: { itemId: "input-log", threadId: meta.threadId, turnId: _input.turnId, questions: [] } },
      } });
      throw new Error("turn interrupted");
    }
    throw business;
  } });
  try {
    const request = { workspaceId: h.workspaceId, assetKind, mode: "create" as const, prompt: "公开消费者日志验证", clientRequestId: marker,
      contextOptions: { includeExistingAssets: false, includeNotes: false, includeWorkbenchDocs: false, includeWorkspaceFiles: false, maxContextChars: 8000, selectedPaths: [] },
      enginePreference: { engine: "codex" as const, model: null, effort: null } };
    const { job } = await h.service.generateAssetDraft(request);
    if (resume) {
      await waitFor(() => h.db.orchAssetGenerationJobs.get(job.id)?.status === "awaiting_input" && !hasInFlightAssetDraftWork(h.db));
      await h.service.resumeAssetDraftJob({ workspaceId: h.workspaceId, jobId: job.id, prompt: "继续", selectedPaths: [] });
    }
    await waitFor(() => !hasInFlightAssetDraftWork(h.db));
    const final = h.db.orchAssetGenerationJobs.get(job.id)!;
    assert.equal(final.status, "failed");
    assert.equal(h.sendMessages.length, resume ? 2 : 1);
    const lines = readAssetWorkspaceLogs(h.workspacePath).filter(row => row.requestId === marker);
    assert.equal(lines.length, 1, "A 必须实际落下一条后台失败日志");
    assert.equal(lines[0].workspaceId, h.workspaceId); assert.equal(lines[0].jobId, job.id);
    assert.equal(lines[0].threadId, final.threadId); assert.equal(lines[0].assetKind, assetKind);
    assert.deepEqual(lines[0].event, { category: "orch-asset-draft", action: "execution_failed", outcome: "fail" }); assert.equal(lines[0].errorCode, "ENGINE_UNAVAILABLE");
    const text = JSON.stringify(lines);
    assert.ok(text.includes("中文🙂")); assert.equal(text.includes("asset-synthetic"), false);
    assert.equal(readAssetWorkspaceLogs(other.workspacePath).some(row => row.requestId === marker), false);
    await flushClientLogger();
    const application = fs.existsSync(resolveClientLogDir()) ? fs.readdirSync(resolveClientLogDir()).filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(resolveClientLogDir(), name), "utf8")).join("\n") : "";
    assert.equal(application.includes(marker), false, "同条不能回补应用日志");
  } finally { h.cleanup(); other.cleanup(); }
});

test("资产工作区迟到 info 日志失败保留已提交 cancelled 与原执行对象", async t => {
  let release!: () => void, entered!: () => void, logs = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }), diagnostic = new Error("late-info-workspace-log-failed");
  const h = createHarness({ onSendMessage: async input => {
    entered(); await gate;
    await input.executeHostTool({ toolId: input.toolRegistry.tools[0].toolId, toolInput: buildToolSubmission("迟到草案不得提交"), accessMode: input.accessMode });
    return { responseText: "迟到提交" };
  } });
  const write = h.db.writeWorkspaceLog;
  t.mock.method(h.db, "writeWorkspaceLog", (workspace: WorkspaceId, entry: Parameters<typeof write>[1]) => { logs++; assert.equal(entry.level, "info"); assert.equal((entry.data as { terminalStatus: string }).terminalStatus, "cancelled"); throw diagnostic; });
  try {
    const { job } = await h.service.generateRoleDraft({ workspaceId: h.workspaceId, assetKind: "role", mode: "create", prompt: "迟到 info 诊断", enginePreference: { engine: "codex", model: null, effort: null },
      contextOptions: { includeExistingAssets: false, includeNotes: false, includeWorkbenchDocs: false, includeWorkspaceFiles: false, maxContextChars: 8000, selectedPaths: [] } });
    await ready;
    h.db.orchAssetGenerationJobs.patchIfStatus(job.id, ["generating"], { status: "cancelled", progress: { stage: "cancelled", headline: "已取消", percent: 100 } });
    release(); await waitFor(() => logs === 1); await new Promise(resolve => setImmediate(resolve));
    const input = { requestId: "late-info-stop", interruptTurn: async () => { assert.fail("没有未终止 turn"); }, disposeThread: async () => { assert.fail("诊断失败不得释放"); } };
    const [result] = await Promise.allSettled([stopAssetDraftJobsForUpdate(h.db, input)]); assert.ok(result.status === "rejected");
    assert.equal(result.reason.code, "ASSET_DRAFT_EXECUTION_LOG_FAILED"); assert.equal(result.reason.errors[1], diagnostic); assert.equal(result.reason.cause, result.reason.errors[0]); assert.equal(result.reason.errors[0].name, "AssetDraftRunObsoleteError");
    await assert.rejects(stopAssetDraftJobsForUpdate(h.db, input), error => error === result.reason);
    assert.equal(h.db.orchAssetGenerationJobs.get(job.id)?.status, "cancelled"); assert.equal(h.db.orchAssetDrafts.listByWorkspace(h.workspaceId).length, 0); assert.equal(h.sendMessages.length, 1); assert.equal(logs, 1); assert.equal(hasInFlightAssetDraftWork(h.db), true);
  } finally { release(); h.cleanup(); }
});

test("AssetDraftService 创建 Agent 草案时不把全量已有 Agent 注入提示词", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const userMessage = String(input.userMessage ?? input.text ?? "");
      const systemMessage = String(input.systemMessage ?? "");
      const developerMessage = String(input.developerMessage ?? "");
      assert.equal(input.text, input.userMessage);
      assert.match(systemMessage, /角色助手/);
      assert.match(developerMessage, /硬约束/);
      assert.match(developerMessage, /runtime\.submitRoleDraft/);
      assert.match(developerMessage, /"roleIds": \[\]/);
      assert.ok(userMessage.includes("## 新角色初始草案"));
      assert.ok(!userMessage.includes("## 当前待优化角色"));
      assert.ok(!userMessage.includes("## 现有角色摘要"));
      assert.ok(!userMessage.includes("已有参考角色 A"));
      assert.ok(!userMessage.includes("已有参考角色 B"));
      assert.ok(userMessage.includes("## 现有知识库摘要"));
      assert.ok(userMessage.includes("真实知识库"));
      assert.ok(userMessage.includes("## 现有工具集摘要"));
      assert.ok(userMessage.includes("真实工具集"));
      assert.ok(userMessage.includes("## 现有 Skills 摘要"));
      assert.ok(userMessage.includes("真实 Skill"));
      assert.ok(!userMessage.includes("硬约束"));
      assert.ok(!userMessage.includes("runtime.submitRoleDraft"));

      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission("收敛后的 Agent"),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = "已提交收敛后的 Agent 草案。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-agent-context-message",
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });
  try {
    for (const name of ["已有参考角色 A", "已有参考角色 B"]) {
      harness.db.orchRoles.upsert({
        ...buildToolSubmission(name).draft,
        id: name as any,
        workspaceId: harness.workspaceId,
      } as any);
    }
    harness.db.orchKnowledgeBundles.upsert({
      id: "knowledge-real" as any,
      workspaceId: harness.workspaceId,
      name: "真实知识库",
      scope: "shared",
      description: "用于验证 Agent 助手仍提供知识库候选。",
      sourceRefs: [],
      kind: "custom",
    } as any);
    harness.db.orchToolsets.upsert({
      id: "toolset-real" as any,
      workspaceId: harness.workspaceId,
      name: "真实工具集",
      description: "用于验证 Agent 助手仍提供工具候选。",
      tools: [{
        id: "runtime.realTool" as any,
        name: "真实工具",
        description: "测试工具",
        runtime: "builtin",
        invocationHint: "{}",
        code: "",
        inputSchema: "{}",
        outputSchema: "{}",
        timeoutMs: null,
        workingDirectory: null,
        requiresWrite: false,
        envPolicy: null,
      }],
      kind: "custom",
    } as any);
    harness.db.orchSkills.upsert({
      ...buildSkillToolSubmission("真实 Skill").draft,
      id: "skill-real" as any,
      workspaceId: harness.workspaceId,
      kind: "custom",
      packageHash: null,
    } as any);

    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "生成一个新 Agent",
      roleSnapshot: {
        ...buildToolSubmission("初始 Agent").draft,
        id: "" as any,
        workspaceId: harness.workspaceId,
      } as any,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    assert.ok(harness.prompts[0]);
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 新建角色草稿使用最新模型且允许自定义配置不发送 effort", async () => {
  const dynamicDefault = INITIAL_ENGINE_MODEL_CATALOG_V1.find((row) => row.engine === "codex" && !row.isDefault);
  assert.ok(dynamicDefault);
  const catalog: EngineModelCatalogSnapshot = {
    schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
    configVersion: 9,
    capturedAt: 9,
    rows: structuredClone(INITIAL_ENGINE_MODEL_CATALOG_V1).map((row) => row.engine === "codex"
      ? { ...row, isDefault: row.catalogItemId === dynamicDefault.catalogItemId }
      : row),
  };
  const customConfig = createDefaultRoleExecutionConfig("codex");
  customConfig.engineProfiles.codex = {
    enabled: true,
    mode: "custom",
    customConfig: {
      model: "vendor/no-effort",
      effort: "",
      accessMode: "current",
      maxRetries: 0,
      autoCompactPct: 90,
      contextWindow: 128_000,
    },
  };
  const harness = createHarness({
    catalog,
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission("无 Effort 角色", { executionConfig: customConfig }),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = "已提交无 effort 角色草稿。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-assistant-message",
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });
  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "生成一个不发送 reasoning effort 的角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const job = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const draft = job?.draftId ? harness.db.orchAssetDrafts.get(job.draftId) : null;
    assert.ok(draft);
    const payload = JSON.parse(String(draft?.payloadJson ?? "{}"));
    assert.equal(
      payload.draft.executionConfig.engineProfiles.codex.customConfig.model,
      dynamicDefault.modelId,
    );
    assert.equal(payload.draft.executionConfig.engineProfiles.codex.customConfig.effort, "");
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 拒绝 submitRoleDraft 绑定不存在的知识库", async () => {
  let lastToolResult: any = null;
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const submission = buildToolSubmission("错误知识库角色");
      submission.draft.defaultKnowledgeBundleIds = ["bundle-knowledge-missing" as any];
      lastToolResult = await input.executeHostTool({
        toolId,
        toolInput: submission,
        accessMode: input.accessMode,
      });
      assert.equal(lastToolResult.ok, false);
      assert.equal(lastToolResult.code, "SCHEMA_VALIDATION_FAILED");
      assert.match(String(lastToolResult.message ?? ""), /引用的知识库不存在/);
      const responseText = "我会修正知识库引用。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: `engine-assistant-message-invalid-${meta.callIndex}`,
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });
  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "生成一个错误绑定知识库的角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "failed");
    const failedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(failedJob?.draftId ?? null, null);
    assert.equal(harness.db.orchAssetDrafts.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(lastToolResult?.code, "SCHEMA_VALIDATION_FAILED");
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 读取历史草案时重新标记缺失知识库", () => {
  const harness = createHarness();
  try {
    const submission = buildToolSubmission("历史缺失知识库角色");
    submission.draft.defaultKnowledgeBundleIds = ["bundle-knowledge-missing" as any];
    const payload = {
      assetKind: "role",
      schemaVersion: "role-draft/v2",
      mode: "create",
      targetAssetId: null,
      baseVersionId: null,
      ...submission,
    };
    const job = harness.db.orchAssetGenerationJobs.create({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      status: "awaiting_review",
      targetAssetId: null,
      clientRequestId: null,
      baseVersionId: null,
      draftId: null,
      threadId: null,
      prompt: "历史草案",
      requestJson: null,
      interactionRequest: null,
      progress: null,
      failure: null,
    });
    const draft = harness.db.orchAssetDrafts.create({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      status: "awaiting_review",
      targetAssetId: null,
      baseVersionId: null,
      sourceJobId: job.id,
      prompt: "历史草案",
      payloadJson: JSON.stringify(payload),
      validationIssues: [],
      rationale: submission.rationale.summary,
      engineInfo: { engine: "codex", model: null, effort: null },
    });
    harness.db.orchAssetGenerationJobs.attachDraft(job.id, draft.id as any);

    const result = harness.service.getRoleDraft({ workspaceId: harness.workspaceId, draftId: draft.id as any });
    assert.ok(result.draft.validationIssues?.some((issue) => issue.code === "UNKNOWN_KNOWLEDGE_BUNDLE" && issue.blocking));
    const stored = harness.db.orchAssetDrafts.get(draft.id);
    assert.ok(stored?.validationIssues?.some((issue) => issue.code === "UNKNOWN_KNOWLEDGE_BUNDLE" && issue.blocking));
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 应用 create 草案后重新读取，回传 appliedRoleId 且不再误判重名", () => {
  const harness = createHarness();
  try {
    const submission = buildToolSubmission("应用后读取角色");
    const payload = {
      assetKind: "role",
      schemaVersion: "role-draft/v2",
      mode: "create",
      targetAssetId: null,
      baseVersionId: null,
      ...submission,
    };
    const job = harness.db.orchAssetGenerationJobs.create({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      status: "awaiting_review",
      targetAssetId: null,
      clientRequestId: null,
      baseVersionId: null,
      draftId: null,
      threadId: null,
      prompt: "应用草案",
      requestJson: null,
      interactionRequest: null,
      progress: null,
      failure: null,
    });
    const draft = harness.db.orchAssetDrafts.create({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      status: "awaiting_review",
      targetAssetId: null,
      baseVersionId: null,
      sourceJobId: job.id,
      prompt: "应用草案",
      payloadJson: JSON.stringify(payload),
      validationIssues: [],
      rationale: submission.rationale.summary,
      engineInfo: { engine: "codex", model: null, effort: null },
    });
    harness.db.orchAssetGenerationJobs.attachDraft(job.id, draft.id as any);

    const applied = harness.service.applyRoleDraft({
      workspaceId: harness.workspaceId,
      draftId: draft.id as any,
      expectedJobId: job.id,
      forceApplyWarnings: true,
    });
    assert.equal(applied.assetKind, "role");
    assert.ok(applied.roleId);

    // 重新读取已应用草案：应回传落地角色，且不再把它自己创建的同名角色判成重名。
    const result = harness.service.getRoleDraft({ workspaceId: harness.workspaceId, draftId: draft.id as any });
    assert.equal(result.appliedRoleId, applied.roleId);
    assert.equal(result.appliedVersionId, applied.versionId);
    assert.ok(!result.draft.validationIssues?.some((issue) => issue.code === "DUPLICATE_ROLE_NAME"));
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 应用 create 角色草案后允许继续优化正式角色", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const roleName = meta.callIndex === 0 ? "应用后续写角色" : "应用后续写角色二版";
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission(roleName),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = `${roleName} 已提交。`;
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: `engine-role-applied-resume-${meta.callIndex}`,
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });

  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "创建一个可持续优化的角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const firstJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const firstDraft = firstJob?.draftId ? harness.db.orchAssetDrafts.get(firstJob.draftId) : null;
    assert.ok(firstJob?.threadId);
    assert.ok(firstDraft);

    const applied = harness.service.applyRoleDraft({
      workspaceId: harness.workspaceId,
      draftId: firstDraft!.id as any,
      expectedJobId: firstJob!.id,
      forceApplyWarnings: true,
    });

    await harness.service.resumeRoleDraftJob({
      workspaceId: harness.workspaceId,
      jobId: firstJob!.id,
      prompt: "把风险输出整理成表格，并补充验证边界。",
      selectedPaths: [],
      targetThreadId: firstJob!.threadId,
    });

    await waitFor(() => {
      const job = harness.db.orchAssetGenerationJobs.get(start.job.id);
      return job?.status === "awaiting_review" && Boolean(job.draftId) && job.draftId !== firstDraft!.id;
    });
    const resumedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const resumedRequest = JSON.parse(String(resumedJob?.requestJson ?? "{}"));

    assert.equal(harness.db.orchAssetDrafts.get(firstDraft!.id)?.status, "applied");
    assert.equal(resumedRequest.mode, "revise");
    assert.equal(applied.assetKind, "role");
    assert.equal(resumedRequest.targetAssetId, applied.roleId);
    assert.equal(resumedRequest.roleSnapshot.id, applied.roleId);
    assert.equal(resumedRequest.baseVersionId, applied.versionId);
    assert.match(resumedRequest.prompt, /把风险输出整理成表格/);
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 在回合结束但未提交平台工具时，会回灌纠正提示并最终失败", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const responseText = meta.callIndex === 0
        ? "我已经整理好了角色 JSON。"
        : "我继续补充了一些说明，但这次还是先不给工具调用。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: `engine-assistant-message-${meta.callIndex}`,
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });

  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "帮我生成一个新的测试工程师角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "failed");
    const failedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob?.draftId ?? null, null);
    assert.equal(failedJob?.failure?.code, "TOOL_RESULT_REQUIRED");
    assert.match(String(failedJob?.failure?.message ?? ""), /没有调用平台工具 .*submitRoleDraft/);
    assert.equal(harness.prompts.length, 3);
    assert.match(harness.prompts[1] ?? "", /上一轮没有完成角色草案提交/);
    assert.doesNotMatch(harness.prompts[1] ?? "", /runtime\.submitRoleDraft/);
    assert.match(String(harness.sendMessages[1]?.developerMessage ?? ""), /runtime\.submitRoleDraft/);
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 在 submitRoleDraft accepted 后遇到迟到异常时，仍把 turn 收口为 completed", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission("迟到异常后的角色"),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-assistant-message-late-error",
          text: "角色草案已经提交。",
          revision: 0,
        },
      });
      throw new Error("late failure after draft submission");
    },
  });

  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "帮我生成一个新的测试工程师角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const completedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(completedJob?.status, "awaiting_review");
    assert.ok(completedJob?.draftId);
    assert.ok(completedJob?.threadId);

    await waitFor(() =>
      harness.db.conversationEvents
        .listByThread(completedJob!.threadId as any)
        .some((event) => event.type === "turn.completed"),
    );
    const events = harness.db.conversationEvents.listByThread(completedJob!.threadId as any);
    assert.ok(events.some((event) => event.type === "turn.completed"));
    assert.ok(!events.some((event) => event.type === "turn.error"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 支持创建 Skill 草案并应用为正式 Skill", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const userMessage = String(input.userMessage ?? input.text ?? "");
      const systemMessage = String(input.systemMessage ?? "");
      const developerMessage = String(input.developerMessage ?? "");
      assert.equal(input.text, input.userMessage);
      assert.match(systemMessage, /Skills 助手/);
      assert.match(developerMessage, /runtime\.submitSkillDraftPatch/);
      assert.match(developerMessage, /patches/);
      assert.ok(!userMessage.includes("硬约束"));
      assert.ok(!userMessage.includes("runtime.submitSkillDraftPatch"));
      const toolId = input.toolRegistry.tools[0].toolId;
      assert.equal(toolId, "runtime.submitSkillDraftPatch");
      assert.equal(typeof input.model, "string");
      assert.ok(input.model.length > 0);
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildSkillToolSubmission("Review Skill"),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = "已提交 Skill 草案。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-skill-message",
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });
  try {
    const start = await harness.service.generateSkillDraft({
      workspaceId: harness.workspaceId,
      assetKind: "skill",
      mode: "create",
      prompt: "生成一个 Review Skill",
      skillSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const job = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const draft = job?.draftId ? harness.db.orchAssetDrafts.get(job.draftId) : null;
    assert.ok(draft);
    const result = harness.service.getSkillDraft({ workspaceId: harness.workspaceId, draftId: draft!.id as any });
    assert.equal(result.payload.assetKind, "skill");
    assert.equal(result.payload.draft.files?.some((file) => file.relPath === "SKILL.md"), true);
    assert.equal(result.payload.draft.scripts?.[0]?.scriptPath, "scripts/check.mjs");

    const applied = harness.service.applySkillDraft({
      workspaceId: harness.workspaceId,
      draftId: draft!.id as any,
      expectedJobId: job!.id,
      forceApplyWarnings: true,
    });
    assert.equal(applied.assetKind, "skill");
    assert.equal(applied.assetKind, "skill");
    const saved = harness.db.orchSkills.get(applied.skillId);
    assert.equal(saved?.name, "Review Skill");
    assert.equal(saved?.scripts?.[0]?.id, "check");
    assert.ok(harness.db.orchAssetVersions.latestVersion(harness.workspaceId, "skill", applied.skillId));
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 应用 create Skill 草案后允许继续生成增量补丁", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolInput = meta.callIndex === 0
        ? buildSkillToolSubmission("Applied Resume Skill")
        : {
            patches: [
              {
                op: "set",
                path: "instructions",
                value: "继续优化后的 Skill 说明。",
              },
            ],
            rationale: {
              summary: "基于已应用 Skill 继续优化",
              keyDecisions: ["保留正式 Skill 作为 patch 基线"],
              assumptions: [],
              risks: [],
            },
            referenceSummary: {
              skillIds: [],
              selectedPaths: [],
            },
          };
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput,
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      const responseText = meta.callIndex === 0 ? "已提交初始 Skill 草案。" : "已提交继续优化 patch。";
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: `engine-skill-applied-resume-${meta.callIndex}`,
          text: responseText,
          revision: 0,
        },
      });
      return { responseText };
    },
  });

  try {
    const start = await harness.service.generateSkillDraft({
      workspaceId: harness.workspaceId,
      assetKind: "skill",
      mode: "create",
      prompt: "生成一个可持续优化的 Skill",
      skillSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const firstJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const firstDraft = firstJob?.draftId ? harness.db.orchAssetDrafts.get(firstJob.draftId) : null;
    assert.ok(firstJob?.threadId);
    assert.ok(firstDraft);

    const applied = harness.service.applySkillDraft({
      workspaceId: harness.workspaceId,
      draftId: firstDraft!.id as any,
      expectedJobId: firstJob!.id,
      forceApplyWarnings: true,
    });

    await harness.service.resumeAssetDraftJob({
      workspaceId: harness.workspaceId,
      jobId: firstJob!.id,
      prompt: "把说明改得更适合继续迭代。",
      selectedPaths: [],
      targetThreadId: firstJob!.threadId,
      enginePreference: {
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        contextWindow: 258_400,
        autoCompactPct: 93,
        serviceTier: "fast",
      },
    });

    await waitFor(() => {
      const job = harness.db.orchAssetGenerationJobs.get(start.job.id);
      return job?.status === "awaiting_review" && Boolean(job.draftId) && job.draftId !== firstDraft!.id;
    });
    const resumedJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const resumedDraft = resumedJob?.draftId ? harness.db.orchAssetDrafts.get(resumedJob.draftId) : null;
    const resumedRequest = JSON.parse(String(resumedJob?.requestJson ?? "{}"));
    const resumedPayload = JSON.parse(String(resumedDraft?.payloadJson ?? "{}"));

    assert.equal(harness.db.orchAssetDrafts.get(firstDraft!.id)?.status, "applied");
    assert.equal(resumedRequest.mode, "revise");
    assert.equal(applied.assetKind, "skill");
    assert.equal(resumedRequest.targetAssetId, applied.skillId);
    assert.equal(resumedRequest.skillSnapshot.id, applied.skillId);
    assert.equal(resumedRequest.workingDraft.name, "Applied Resume Skill");
    assert.equal(resumedRequest.baseVersionId, applied.versionId);
    assert.equal(resumedPayload.draft.instructions, "继续优化后的 Skill 说明。");
    assert.equal(harness.sendMessages[1]?.model, "gpt-5.6-sol");
    assert.equal(harness.sendMessages[1]?.effort, "xhigh");
    assert.equal(harness.sendMessages[1]?.contextWindow, 258_400);
    assert.equal(harness.sendMessages[1]?.autoCompactPct, 93);
    assert.equal(harness.sendMessages[1]?.serviceTier, "fast");
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 支持用 patch 增量更新 Skill 脚本内容", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: {
          patches: [
            {
              op: "upsert-script",
              script: {
                id: "check",
                name: "检查脚本",
                description: "更新后的辅助检查。",
                scriptPath: "scripts/check.mjs",
                runtime: "node",
                inputSchema: "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}",
                outputSchema: "{\"type\":\"object\"}",
                exposeAsTool: true,
              },
              contentText: "console.log('new script');",
            },
          ],
          rationale: {
            summary: "只更新脚本内容",
            keyDecisions: ["保留原 Skill 基础字段"],
            assumptions: [],
            risks: [],
          },
          referenceSummary: {
            skillIds: [],
            selectedPaths: [],
          },
        },
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-skill-patch-message",
          text: "已提交脚本增量更新。",
          revision: 0,
        },
      });
      return { responseText: "已提交脚本增量更新。" };
    },
  });
  try {
    const existing = harness.db.orchSkills.upsert({
      ...buildSkillToolSubmission("Patch Skill").draft,
      id: "" as any,
      workspaceId: harness.workspaceId,
      kind: "custom",
      packageHash: null,
    } as any);
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...skillSnapshot } = existing;
    const start = await harness.service.generateSkillDraft({
      workspaceId: harness.workspaceId,
      assetKind: "skill",
      mode: "revise",
      targetAssetId: existing.id,
      prompt: "只更新检查脚本",
      skillSnapshot,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");
    const job = harness.db.orchAssetGenerationJobs.get(start.job.id);
    const draft = job?.draftId ? harness.db.orchAssetDrafts.get(job.draftId) : null;
    assert.ok(draft);
    const result = harness.service.getSkillDraft({ workspaceId: harness.workspaceId, draftId: draft!.id as any });
    assert.equal(result.payload.assetKind, "skill");
    assert.equal(result.payload.draft.name, existing.name);
    const file = result.payload.draft.files?.find((item) => item.relPath === "scripts/check.mjs");
    assert.equal(file?.contentText, "console.log('new script');");

    const applied = harness.service.applySkillDraft({
      workspaceId: harness.workspaceId,
      draftId: draft!.id as any,
      expectedJobId: job!.id,
      expectedBaseVersionId: result.payload.baseVersionId ?? null,
      forceApplyWarnings: true,
    });
    assert.equal(applied.assetKind, "skill");
    const saved = harness.db.orchSkills.get(applied.skillId);
    assert.equal(saved?.files?.find((item) => item.relPath === "scripts/check.mjs")?.contentText, "console.log('new script');");
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 允许多个助手草案任务并存", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission(`并行角色 ${meta.callIndex + 1}`),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: `engine-parallel-${meta.callIndex}`,
          text: "已提交并行角色草案。",
          revision: 0,
        },
      });
      return { responseText: "已提交并行角色草案。" };
    },
  });
  try {
    const first = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "第一个角色草案",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });
    const second = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "第二个角色草案",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: "codex",
        model: null,
        effort: null,
      },
    });

    assert.notEqual(first.job.id, second.job.id);
    await waitFor(() => harness.db.orchAssetGenerationJobs.get(first.job.id)?.status === "awaiting_review");
    await waitFor(() => harness.db.orchAssetGenerationJobs.get(second.job.id)?.status === "awaiting_review");
    const list = harness.service.listAssetDraftJobs({ workspaceId: harness.workspaceId, limit: 10 });
    assert.equal(list.jobs.length, 2);
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 允许可重试失败任务在原会话继续生成", async () => {
  const harness = createHarness({
    onSendMessage: async (input, emitters, meta) => {
      if (meta.callIndex === 0) throw new Error("provider temporarily unavailable");
      const toolId = input.toolRegistry.tools[0].toolId;
      const toolResult = await input.executeHostTool({
        toolId,
        toolInput: buildToolSubmission("重启后恢复角色"),
        accessMode: input.accessMode,
      });
      assert.equal(toolResult.ok, true);
      emitters?.conversation?.({
        ts: Date.now(),
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        engine: "codex",
        type: "item.agentMessage.completed",
        payload: {
          itemId: input.assistantItemId as any,
          engineMessageId: "engine-retry-message",
          text: "已恢复并提交角色草案。",
          revision: 0,
        },
      });
      return { responseText: "已恢复并提交角色草案。" };
    },
  });
  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "创建一个支持重启恢复的角色",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: { engine: "codex", model: null, effort: null },
    });
    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "failed");
    const failed = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(failed?.failure?.retryable, true);

    await harness.service.resumeAssetDraftJob({
      workspaceId: harness.workspaceId,
      jobId: start.job.id,
      prompt: "请继续完成上一轮任务",
      selectedPaths: [],
      targetThreadId: failed?.threadId ?? null,
    });
    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "awaiting_review");

    const resumed = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(resumed?.failure, null);
    assert.ok(resumed?.draftId);
    assert.match(harness.prompts.at(-1) ?? "", /请继续完成上一轮任务/);
  } finally {
    harness.cleanup();
  }
});

test("AssetDraftService 不允许取消后的迟到工具回调重新写入草案", async () => {
  let releaseEngine!: () => void;
  let markEngineSettled: (() => void) | null = null;
  const engineGate = new Promise<void>((resolve) => { releaseEngine = resolve; });
  const engineSettled = new Promise<void>((resolve) => { markEngineSettled = resolve; });
  const harness = createHarness({
    onSendMessage: async (input) => {
      try {
        await engineGate;
        await input.executeHostTool({
          toolId: input.toolRegistry.tools[0].toolId,
          toolInput: buildToolSubmission("不应落库的迟到角色"),
          accessMode: input.accessMode,
        });
        return { responseText: "迟到提交" };
      } finally {
        markEngineSettled?.();
      }
    },
  });
  try {
    const start = await harness.service.generateRoleDraft({
      workspaceId: harness.workspaceId,
      assetKind: "role",
      mode: "create",
      prompt: "验证取消竞态",
      roleSnapshot: null,
      contextOptions: {
        includeExistingAssets: true,
        includeNotes: false,
        includeWorkbenchDocs: false,
        includeWorkspaceFiles: false,
        maxContextChars: 8_000,
        selectedPaths: [],
      },
      enginePreference: { engine: "codex", model: null, effort: null },
    });
    await waitFor(() => harness.db.orchAssetGenerationJobs.get(start.job.id)?.status === "generating");
    const cancelled = harness.db.orchAssetGenerationJobs.patchIfStatus(start.job.id, ["generating"], {
      status: "cancelled",
      progress: { stage: "cancelled", headline: "已取消", detail: null, percent: 100 },
    });
    assert.equal(cancelled?.current.status, "cancelled");

    releaseEngine();
    await engineSettled;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finalJob = harness.db.orchAssetGenerationJobs.get(start.job.id);
    assert.equal(finalJob?.status, "cancelled");
    assert.equal(finalJob?.draftId, null);
    assert.equal(harness.db.orchAssetDrafts.listByWorkspace(harness.workspaceId).length, 0);
    assert.equal(
      harness.db.orchAssetJobEvents.listByJob(start.job.id).some((event) => event.type === "orch.assetDraft.failed"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});
