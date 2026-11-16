import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition,
  type ClientToServerMessage, type DesktopApiRequest, type ThreadId, type WorkspaceId,
} from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { hasInFlightAssetDraftWork } from "../src/orchestration/assetDraftService.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 仅替换 AI 提供商，草案提交仍通过原动态工具和本地服务。 */
function submission(kind: "role" | "skill") {
  const name = kind === "role" ? "Local Agent" : "Local Skill";
  const skillMd = '---\nname: "local-skill"\ndescription: "本机验证技能"\n---\n\n# Local Skill\n\n读取必要上下文，执行检查并报告结果与风险。';
  return {
    draft: kind === "role" ? {
      name, description: "本机验证角色", responsibility: "检查代码与验证结果",
      systemPrompt: "你负责围绕真实用户路径执行测试与代码检查，先理解需求边界，再制定验证步骤。每次输出须包含实际证据、验证结论和风险；禁止伪造结果，遇到环境限制必须明确报告，禁止继续执行无法确认的副作用。",
      inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
      gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"), defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom",
    } : {
      name, slug: "local-skill", description: "本机验证技能", trigger: "需要执行本机代码检查时使用",
      instructions: "读取必要上下文，执行检查并报告结果与风险。", targetEngines: ["codex"], tags: ["test"],
      skillMd, files: [{ relPath: "SKILL.md", kind: "skill-md", contentText: skillMd }], scripts: [], installTargets: ["codex"],
    },
    rationale: { summary: "生成本机资产", keyDecisions: ["复用本机服务"], assumptions: [], risks: [] },
    referenceSummary: kind === "role" ? { roleIds: [], knowledgeBundleIds: [], toolsetIds: [], selectedPaths: [] } : { skillIds: [], selectedPaths: [] },
  };
}

/** 有界等待后台任务释放；失败由调用方核对真实任务结果。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("本机助手任务等待超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** 使用独立工作区和真实 SQLite；不提供账号、云连接或实际 AI 凭据。 */
function fixture(t: test.TestContext, kind: "role" | "skill" = "role") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-asset-assistant-"));
  const application = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "local-client:workspace" as WorkspaceId;
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: directory });
  const db = application.forWorkspace(workspaceId), threads = new ThreadStore();
  initializeLocalEngineModelCatalog();
  let conversationSeq = 0, rawSeq = 0, sequence = 0, providerCalls = 0;
  const sent: ClientToServerMessage[] = [];
  const orchEngine = { forWorkspace: () => orchEngine, disposeManagedServicesForThread: async () => {} };
  const ctx = { db, clientId: "local-client", workspaces: new Map([[workspaceId, directory]]), threads, orchEngine,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    sessions: {
      beginThreadOperation: () => () => {}, hasActiveTurn: () => false, disposeThreadWithOptions: async () => {},
      getOrCreate(thread: { threadId: ThreadId }) {
        threads.setSessionId(thread.threadId, "local-test-session" as any);
        return {
          resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false,
          interrupt: async () => true, prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
          async sendMessage(input: any, emitters: any) {
            providerCalls += 1;
            assert.equal(input.providerNativeToolPolicy, "allow");
            const result = await input.executeHostTool({ toolId: input.toolRegistry.tools[0].toolId, toolInput: submission(kind), accessMode: input.accessMode });
            assert.equal(result.ok, true, JSON.stringify(result));
            const event = { ts: Date.now(), workspaceId, threadId: thread.threadId, engine: "codex" };
            emitters.raw({ ...event, source: "local-provider", data: { method: "item/completed" }, handled: true, action: "mapped", emittedTypes: ["item.agentMessage.completed"] });
            emitters.conversation({ ...event, type: "item.agentMessage.completed", payload: { itemId: input.assistantItemId, engineMessageId: `message-${providerCalls}`, text: "草案已提交", revision: 0 } });
            return { responseText: "草案已提交" };
          },
        };
      },
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
      if (message.t === "conversation.event") db.conversationEvents.appendEnvelope({ ...message.event, ts: message.event.ts ?? Date.now(), seq: ++conversationSeq } as any);
      if (message.t === "raw.event") db.rawEvents.appendEnvelope({ ...message.event, ts: message.event.ts ?? Date.now(), seq: ++rawSeq } as any);
    },
  } as unknown as ApiHandlerContext;
  t.after(async () => {
    await waitFor(() => !hasInFlightAssetDraftWork(db));
    application.close(); resetEngineModelCatalogRuntimeForTest(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, ctx, workspaceId, sent, providerCalls: () => providerCalls,
    /** 走真实桌面入口，响应失败不转换成成功。 */
    call(method: DesktopApiRequest["method"], body: Record<string, unknown> = {}) {
      return executeDesktopApiRequest(ctx, { method, body: { workspaceId, ...body } }, { requestId: `assistant-${++sequence}`, startedAt: 1, clientVersion: "1" });
    },
    /** 读取已结束任务，超时和后台失败均使测试失败。 */
    async completed(jobId: string) {
      await waitFor(() => !hasInFlightAssetDraftWork(db));
      const job = db.orchAssetGenerationJobs.get(jobId as any);
      assert.equal(job?.status, "awaiting_review", JSON.stringify(job?.failure));
      assert.ok(job?.draftId); assert.ok(job?.threadId);
      return job;
    },
  };
}

for (const kind of ["role", "skill"] as const) {
  test(`desktop ${kind} assistant completes locally without login or Server`, async t => {
    const f = fixture(t, kind);
    const generated = await f.call("orch.assetDrafts.generate", { assetKind: kind, mode: "create", prompt: "创建本机验证资产", enginePreference: { engine: "codex" } });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const jobId = (generated.body as any).job.id;
    let job = await f.completed(jobId);
    const threadId = job.threadId!;
    assert.equal(f.db.threads.get(threadId)?.threadType, "orchestration");
    assert.equal(f.db.threads.get(threadId)?.threadSubtype, "asset-draft");
    const list = await f.call("orch.assetDraftJobs.list");
    assert.equal(list.status, 200); assert.equal((list.body as any).jobs[0].job.id, jobId);
    const fetched = await f.call("orch.assetDraftJobs.get", { jobId });
    assert.equal(fetched.status, 200); assert.equal((fetched.body as any).job.draftId, job.draftId);
    const preview = await f.call("orch.assetDrafts.get", { draftId: job.draftId });
    assert.equal(preview.status, 200); assert.equal((preview.body as any).payload.draft.name, submission(kind).draft.name);
    const applied = await f.call("orch.assetDrafts.apply", { draftId: job.draftId, expectedJobId: jobId, forceApplyWarnings: true });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const assetId = (applied.body as any)[kind === "role" ? "roleId" : "skillId"];
    const asset = kind === "role" ? f.db.orchRoles.get(assetId) : f.db.orchSkills.get(assetId);
    assert.equal(asset?.workspaceId, f.workspaceId); assert.equal(asset?.name, submission(kind).draft.name);
    assert.equal(f.db.orchAssetDrafts.get(job.draftId!)?.status, "applied");

    const continued = await f.call("threads.sendMessage", { threadId, text: "补充失败时停止的边界" });
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.equal((continued.body as any).dispatchMode, "orchestration_feedback");
    job = await f.completed(jobId);
    assert.equal(job.threadId, threadId);
    const resumed = await f.call("orch.assetDraftJobs.resume", { jobId, targetThreadId: threadId, prompt: "进一步明确输出证据" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    job = await f.completed(jobId);
    const rejected = await f.call("orch.assetDrafts.reject", { draftId: job.draftId, reason: "保留已应用版本" });
    assert.equal(rejected.status, 200); assert.equal(f.db.orchAssetDrafts.get(job.draftId!)?.status, "rejected");
    assert.equal(f.providerCalls(), 3);
    assert.ok(f.db.conversationEvents.listByThread(threadId).some(event => event.type === "item.agentMessage.completed"));
    assert.equal(f.db.rawEvents.listByThreadFromSeq(threadId, { fromSeqInclusive: 0 }).length, 3);
    assert.ok(f.sent.every(message => message.t === "conversation.event" || message.t === "raw.event"));
    const removed = await f.call("orch.assetDraftJobs.delete", { jobId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(f.db.orchAssetGenerationJobs.get(jobId), null); assert.equal(f.db.threads.get(threadId), null);
    assert.ok(kind === "role" ? f.db.orchRoles.get(assetId) : f.db.orchSkills.get(assetId));
  });
}

test("desktop assistant rejects forged scope and preserves builtin assets", async t => {
  const f = fixture(t);
  for (const workspaceId of ["foreign:workspace", "shared:team", "local-client:unknown"]) {
    const response = await f.call("orch.assetDraftJobs.list", { workspaceId });
    assert.ok(response.status >= 400, workspaceId);
  }
  for (const field of ["actorUserId", "sharedWorkspaceId", "serverOrigin"]) {
    assert.equal((await f.call("orch.assetDrafts.generate", { assetKind: "role", mode: "create", prompt: "不应执行", [field]: "forged" })).status, 400);
  }
  const role = f.db.orchRoles.upsert({ ...submission("role").draft, id: "builtin-role", workspaceId: f.workspaceId, kind: "builtin" } as any);
  const request = { assetKind: "role", mode: "revise", targetAssetId: role.id, prompt: "不应覆盖内置资产" };
  assert.equal((await f.call("orch.assetDrafts.generate", request)).status, 403);
  assert.equal((await f.call("orch.assetDrafts.generate", { ...request, targetAssetId: "missing-role" })).status, 404);
  assert.equal(f.providerCalls(), 0); assert.deepEqual(f.db.orchRoles.get(role.id), role);
});

test("desktop assistant rejects a missing draft and reports provider failure explicitly", async t => {
  const f = fixture(t);
  assert.equal((await f.call("orch.assetDrafts.apply", { draftId: "missing" })).status, 404);
  f.ctx.sessions.getOrCreate = () => { throw new Error("LOCAL_ENGINE_UNAVAILABLE"); };
  const response = await f.call("orch.assetDrafts.generate", { assetKind: "role", mode: "create", prompt: "验证引擎故障" });
  assert.equal(response.status, 200);
  await waitFor(() => !hasInFlightAssetDraftWork(f.db));
  const job = f.db.orchAssetGenerationJobs.get((response.body as any).job.id);
  assert.equal(job?.status, "failed"); assert.ok(job?.failure); assert.equal(job?.draftId, null);
  assert.deepEqual(f.db.orchRoles.listByWorkspace(f.workspaceId), []);
});

for (const kind of ["role", "skill"] as const) {
  test(`desktop ${kind} assistant checks the current draft target after applied-session continuation`, async t => {
    const f = fixture(t, kind);
    const generated = await f.call("orch.assetDrafts.generate", { assetKind: kind, mode: "create", prompt: "创建资产", enginePreference: { engine: "codex" } });
    assert.equal(generated.status, 200);
    const jobId = (generated.body as any).job.id;
    let job = await f.completed(jobId);
    const applied = await f.call("orch.assetDrafts.apply", { draftId: job.draftId, forceApplyWarnings: true });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const assetId = (applied.body as any)[kind === "role" ? "roleId" : "skillId"];
    assert.equal((await f.call("threads.sendMessage", { threadId: job.threadId, text: "继续优化" })).status, 200);
    job = await f.completed(jobId);
    assert.equal(f.db.orchAssetDrafts.get(job.draftId!)?.targetAssetId, assetId);
    // 模拟生成后资产来源变化，应用时必须重新验证只读边界。
    const asset = kind === "role" ? f.db.orchRoles.get(assetId)! : f.db.orchSkills.get(assetId)!;
    if (kind === "role") f.db.orchRoles.upsert({ ...asset, kind: "builtin" } as any);
    else f.db.orchSkills.upsert({ ...asset, kind: "builtin" } as any);
    assert.equal((await f.call("orch.assetDrafts.apply", { draftId: job.draftId, forceApplyWarnings: true })).status, 403);
    assert.equal(f.db.orchAssetDrafts.get(job.draftId!)?.status, "awaiting_review");
    assert.equal((kind === "role" ? f.db.orchRoles.get(assetId) : f.db.orchSkills.get(assetId))?.kind, "builtin");
  });
}
