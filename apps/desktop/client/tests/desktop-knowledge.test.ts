import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DesktopApiRequest, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { dispatchDesktopKnowledgeUpdate } from "../src/knowledge/knowledgeUpdateScheduler.js";
import { waitForKnowledgeUpdateCheck } from "../src/knowledge/knowledgeUpdateService.js";

/** 后台任务必须实际收口，超时即失败。 */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("规格库任务未收口");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** 独立本机工作区复用真实请求入口、SQLite 和项目文件。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-knowledge-")), workspaceId = "local:workspace" as WorkspaceId;
  const application = openClientDb({ dbPath: path.join(root, "client.db") });
  application.workspaces.upsert({ id: workspaceId, title: "本机规格库", path: root });
  const db = application.forWorkspace(workspaceId);
  initializeLocalEngineModelCatalog();
  const orchEngine = { forWorkspace: () => orchEngine, buildManagedServiceToolRegistry: () => null };
  const ctx = { db: application, workspaces: new Map([[workspaceId, root]]), clientId: "local", threads: new ThreadStore(),
    sessions: { hasActiveTurn: () => false, beginThreadOperation: () => () => {}, getActiveTurnId: () => null },
    orchEngine,
    send() { assert.fail("不得连接 Server"); },
  } as unknown as ApiHandlerContext;
  let sequence = 0, eventSeq = 0, rawSeq = 0;
  ctx.onBeforeEmitConversationEvent = event => {
    const turnId = (event.payload as any).turnId;
    db.conversationEvents.appendEnvelope({ ...event, seq: ++eventSeq } as any);
    if (event.type === "turn.started" && !db.turns.get(turnId)) db.turns.insertStarted({ workspaceId, threadId: event.threadId, turnId, engine: event.engine, startedAt: event.ts!, startEventSeq: eventSeq });
    if (event.type === "turn.completed" || event.type === "turn.error") db.turns.setEnded(turnId, { status: event.type === "turn.error" ? "error" : "completed", endedAt: event.ts!, endEventSeq: eventSeq });
  };
  ctx.send = message => {
    if (message.t === "raw.event") db.rawEvents.appendEnvelope({ ...message.event, seq: ++rawSeq } as any);
    else if (message.t !== "conversation.event") assert.fail(`不得连接 Server：${message.t}`);
  };
  t.after(() => { application.close(); resetEngineModelCatalogRuntimeForTest(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceId, db, ctx, store: new KnowledgeAssetStore(root),
    /** 仅替换模型，实际工具、授权与文件写入仍由生产服务执行。 */
    setProvider(send: (input: any, emitters: any) => Promise<void>) {
      ctx.sessions.getOrCreate = ((runtime: any) => {
        ctx.threads.setSessionId(runtime.threadId, "local-provider" as any);
        return { resolvePlatformToolTransport: () => "native-dynamic", hasActiveTurn: () => false, getSessionId: () => "local-provider",
          prepareAssistantTerminalEvents: async () => ({ events: [], latestAssistantText: null }),
          sendMessage: (input: any, emitters: any) => send({ ...input, threadId: runtime.threadId }, emitters), interrupt: async () => true,
        };
      }) as any;
    },
    /** 请求始终经桌面准入，不伪造业务成功。 */
    call(method: string, body: Record<string, unknown> = {}) {
      return executeDesktopApiRequest(ctx, { method, body: { workspaceId, ...body } } as DesktopApiRequest,
        { requestId: `knowledge-local-${++sequence}`, clientVersion: "test", startedAt: 1 });
    },
  };
}

test("单机规格库可读取默认目录、导入原文及创建连接结束知识会话", async t => {
  const f = fixture(t);
  const snapshot = await f.call("knowledge.assets.snapshot", { includeStates: "false" });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.equal((snapshot.body as any).data.canWrite, true);
  fs.writeFileSync(path.join(f.root, "资料.md"), "# 本机资料\n\n无需登录。", "utf8");
  const imports = await f.call("knowledge.assets.imports");
  assert.equal(imports.status, 200);
  const item = (imports.body as any).data.files.find((file: any) => file.path === "资料.md");
  const imported = await f.call("knowledge.assets.import", { path: item.path, contentHash: item.contentHash, parentId: null, treeHash: null, category: "product" });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const node = (imported.body as any).data.tree.nodes.find((item: any) => item.contentMode === "reference");
  const detail = await f.call("knowledge.assets.node", { nodeId: node.id });
  assert.equal((detail.body as any).data.reference.content, "# 本机资料\n\n无需登录。");
  const created = await f.call("knowledge.assets.conversation.create", { nodeId: null, engine: "codex" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const conversation = (created.body as any).data;
  assert.equal(conversation.createdByUserId, "local:local");
  assert.equal((await f.call("knowledge.assets.conversation.connect", { threadId: conversation.threadId })).status, 200);
  assert.equal((await f.call("knowledge.assets.conversation.list")).status, 200);
  assert.equal((await f.call("knowledge.assets.conversation.end", { threadId: conversation.threadId })).status, 200);
});

test("本机知识讨论和文件工作会话可保存偏好及草稿，隐藏复检不开放续聊", async t => {
  const f = fixture(t);
  for (const [threadType, threadSubtype] of [["chat", "knowledge-conversation"], ["orchestration", "knowledge-assets"]] as const) {
    const threadId = `local-${threadSubtype}` as ThreadId;
    f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, title: "规格会话", engine: "codex", threadType, threadSubtype });
    const response = await f.call("threads.updatePrefs", { threadId, prefs: { accessMode: "read-only" } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await f.call("threads.draft.save", { threadId, draft: { text: "继续核对", images: [], files: [] } })).status, 200);
  }
  const threadId = "review" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: f.workspaceId, title: "复检", engine: "codex", threadType: "orchestration", threadSubtype: "knowledge-review" });
  assert.equal((await f.call("threads.updatePrefs", { threadId, prefs: { accessMode: "full-access" } })).status, 400);
});

test("本机上传复用既有临时文件服务，越界和跨工作区上传明确失败", async t => {
  const f = fixture(t), content = Buffer.from("# 中文文档", "utf8");
  const begin = await f.call("fs.uploadBegin", { fileName: "说明.md", sizeBytes: content.length });
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const uploadId = (begin.body as any).uploadId;
  const other = "local:other" as WorkspaceId, otherRoot = path.join(f.root, "other"); fs.mkdirSync(otherRoot);
  f.ctx.db.workspaces.upsert({ id: other, title: "其他工作区", path: otherRoot }); f.ctx.workspaces.set(other, otherRoot);
  assert.equal((await f.call("fs.uploadChunk", { workspaceId: other, uploadId, offset: 0, base64: content.toString("base64") })).status, 403);
  assert.equal((await f.call("fs.uploadChunk", { uploadId, offset: 0, base64: content.toString("base64") })).status, 200);
  assert.equal((await f.call("fs.uploadComplete", { uploadId })).status, 200);
  assert.equal(fs.readFileSync(path.join(f.root, "说明.md"), "utf8"), content.toString("utf8"));
  assert.ok((await f.call("fs.uploadBegin", { fileName: "../outside.md", sizeBytes: 0 })).status >= 400);
  assert.ok((await f.call("knowledge.assets.snapshot", { workspaceId: "shared:team" })).status >= 400);
});

test("桌面分钟调度在无账号时仍执行项目自有规格更新，暂停时不执行", async t => {
  const f = fixture(t); let ticks = 0, paused = false;
  const scheduler = new ScheduledTaskScheduler({ config: { serverWsUrl: "ws://127.0.0.1:1", clientId: "local", apiKey: "" } as any,
    deviceId: "test", apiContext: f.ctx, localApiContext: f.ctx, captureAccountContext: () => null,
    isTaskAdmissionPaused: () => paused, tickProjectTasks: async () => { ticks++; },
  });
  await scheduler.syncAndTick("test");
  assert.equal(ticks, 1);
  paused = true; await scheduler.syncAndTick("paused");
  assert.equal(ticks, 1);
  await scheduler.waitForInFlightWork();
});

test("本机知识生成、采用及文件续聊走真实工具，结束协作后拒绝继续写入", async t => {
  const f = fixture(t);
  f.store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "feature", parentId: null, title: "功能规格", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  fs.writeFileSync(path.join(f.root, "feature.ts"), "export const enabled = true;", "utf8");
  let calls = 0;
  f.setProvider(async (input, emitters) => {
    calls++;
    const read = await input.executeHostTool({ toolId: "knowledge.source.read", toolInput: { path: "feature.ts", startLine: 1, count: 1 }, accessMode: "read-only" });
    assert.equal(read.ok, true, JSON.stringify(read));
    const submitted = await input.executeHostTool({ toolId: "knowledge.asset.submit", toolInput: {
      content: `# 功能规格\n\n本机版本 ${calls}`, summary: "核对真实实现", sources: [{ kind: "code", path: "feature.ts", contentHash: read.output.contentHash, startLine: 1, endLine: 1, relation: "功能实现" }],
    }, accessMode: "read-only" });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    emitters.raw({ ts: Date.now(), workspaceId: f.workspaceId, threadId: input.threadId, engine: "codex", source: "local-provider", data: { method: "item/completed" }, handled: true, action: "mapped", emittedTypes: [] });
  });
  const owner = (await f.call("knowledge.assets.conversation.create", { nodeId: null, engine: "codex" })).body as any;
  const generated = await f.call("knowledge.assets.generate", { requestId: "local-generation", mode: "batch", ownerThreadId: owner.data.threadId,
    selectedNodeIds: ["feature"], includeDescendants: false, strategy: "all", prompt: "", treeHash: f.store.readTree().hash, engine: "codex", model: null, effort: null, reviewConfig: { enabled: false, model: null, effort: null } });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  const runId = (generated.body as any).data.id;
  assert.equal((await f.call("knowledge.assets.run.start", { runId })).status, 200);
  await waitFor(() => !f.store.isRunExecuting(runId));
  const run = f.store.readRun(runId);
  assert.equal(run.items[0]?.status, "completed", JSON.stringify(run.error ?? run.items[0]?.error));
  const preview = (await f.call("knowledge.assets.run.preview", { runId })).body as any;
  const applied = await f.call("knowledge.assets.run.apply", { runId, requestId: "local-adoption", treeHash: preview.data.treeHash, planHash: preview.data.planHash,
    selections: preview.data.items.filter((item: any) => item.canApply).map((item: any) => ({ nodeId: item.nodeId, revisionId: item.revisionId })) });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.match(f.store.detail("feature").current!.content, /本机版本 1/);
  const threadId = run.items[0]!.executionThreadId!;
  const continued = await f.call("threads.sendMessage", { threadId, text: "再核对一次" });
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  await waitFor(() => Boolean(f.db.turns.get((continued.body as any).turnId) && f.db.turns.get((continued.body as any).turnId)?.status !== "started"));
  assert.equal(calls, 2, JSON.stringify(f.db.conversationEvents.listByThread(threadId as ThreadId).filter(event => event.type === "turn.error")));
  assert.equal(f.store.detail("feature").drafts.length, 1);
  assert.ok(f.db.rawEvents.listByThreadFromSeq(threadId as ThreadId, { fromSeqInclusive: 0 }).length > 0);
  assert.equal((await f.call("knowledge.assets.conversation.end", { threadId: owner.data.threadId })).status, 200);
  const denied = await f.call("threads.sendMessage", { threadId, text: "不应继续生成" });
  if (denied.status === 200) await waitFor(() => f.db.turns.get((denied.body as any).turnId)?.status === "error");
  else assert.ok(denied.status >= 400);
  assert.equal(calls, 2);
});

test("桌面定时规格检查直接进入本机服务，保留可读取的检查结果", async t => {
  const f = fixture(t);
  f.store.saveTree({ schemaVersion: 2, instructions: "", nodes: [{ id: "directory", parentId: null, title: "规格", contentMode: "directory", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  const saved = await f.call("knowledge.assets.update.save", { expectedHash: null, schedule: {
    enabled: true, cronExpr: "* * * * *", timezone: "UTC", selectedNodeIds: [], includeDescendants: true,
    engine: "codex", model: null, effort: null, concurrency: 1, prompt: "", reviewConfig: { enabled: true, model: null, effort: null, maxRounds: 2 },
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const result = await dispatchDesktopKnowledgeUpdate(f.ctx, f.workspaceId, Date.now());
  assert.equal(result.lastCheck?.outcome, "checking");
  await waitForKnowledgeUpdateCheck(f.root, { requestId: "test-update" });
  const view = await f.call("knowledge.assets.update.schedule");
  assert.equal((view.body as any).data.lastCheck.outcome, "unchanged");
  await assert.rejects(dispatchDesktopKnowledgeUpdate(f.ctx, "shared:team", Date.now()), /本机工作区/);
});
