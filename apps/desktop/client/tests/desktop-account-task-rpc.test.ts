import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ScheduledTask, WorkspaceId } from "@codeflowai/shared";
import { executeDesktopAccountTaskRequest } from "../src/app/executeDesktopAccountTaskRequest.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import type { ClientConfig } from "../src/config.js";
import type { DesktopCloudAccount, DesktopCloudAccountOwner } from "../src/runtime/desktopCloudAccount.js";
import { logger } from "../src/logger.js";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";

/** 真实工作区SQLite和中央处理器；只控制已完成认证的云owner及Server任务响应。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-account-task-rpc-")); t.mock.method(os, "homedir", () => root);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "desktop:project" as WorkspaceId, other = "foreign:project" as WorkspaceId;
  const local = path.join(root, "local"), foreign = path.join(root, "foreign"); fs.mkdirSync(local); fs.mkdirSync(foreign);
  db.workspaces.upsert({ id: workspaceId, title: "local", path: local }); db.workspaces.upsert({ id: other, title: "foreign", path: foreign });
  const owner: DesktopCloudAccountOwner = { serverOrigin: "https://cloud.test", ownerUserId: "A", accountSessionId: "session-A", generation: 1 };
  const identity = { active: true }, sent: unknown[] = [], logs: unknown[][] = [], calls: unknown[][] = [];
  const cloud = { getOwner: () => identity.active ? { ...owner } : null,
    assertOwner(captured: DesktopCloudAccountOwner) { assert.equal(identity.active, true, "OWNER_REVOKED"); assert.deepEqual(captured, owner); } } as unknown as DesktopCloudAccount;
  const ctx = { db, clientId: "desktop", deviceId: "installation", localWorkspaceOnly: true,
    desktopCloudAccount: cloud, workspaces: new Map([[workspaceId, local], [other, foreign]]),
    sessions: { beginThreadOperation: () => () => {} } as unknown as ApiHandlerContext["sessions"],
    send(message) { sent.push(message); } } as ApiHandlerContext;
  t.mock.method(logger, "warn", (...args: unknown[]) => { logs.push(args); });
  const task: ScheduledTask = { id: "account-task", ownerUserId: "A", clientId: "desktop", deviceId: "installation", deviceKind: "desktop", configRevision: 1,
    clientNameSnapshot: "desktop", deviceLabelSnapshot: null, name: "account", description: null, taskType: "script", cronExpr: "0 0 1 1 *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo account-rpc", contextWorkspaceId: null },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000, nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "desktop", apiKey: "FORBIDDEN_LEGACY_KEY", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "installation", apiContext: ctx, localApiContext: ctx,
    captureAccountContext: () => identity.active ? { ...owner, clientId: "desktop", deviceId: "installation", assertCurrent() { cloud.assertOwner(owner); } } : null,
    requestAccountTasks: async (_owner, action, body) => { calls.push([action, body]); return action === "sync" ? { tasks: [task], configRevisionFloors: [{ taskId: task.id, localRevision: 0 }], serverNow: Date.now() } : { serverNow: Date.now() }; } });
  ctx.scheduledTaskScheduler = scheduler;
  t.after(async () => { try { await scheduler.stopAndDrain(); } finally { db.close(); fs.rmSync(root, { recursive: true }); } });
  /** 仅拼真实api.req信封，不复制任何产品校验或响应收集逻辑。 */
  const call = (method: string, body: unknown = {}) => executeDesktopAccountTaskRequest(ctx,
    { t: "api.req", id: "rpc-request", method, path: "/account-task", body } as ApiRequestMessage,
    { owner, clientVersion: "test", startedAt: 1 });
  return { root, db, ctx, owner, identity, sent, logs, calls, scheduler, task, workspaceId, other, call };
}

test("desktop 账号任务RPC沿原桌面过滤只返回本机W和真实流程", async t => {
  const f = fixture(t);
  const workspaces = await f.call("workspaces.list");
  assert.equal(workspaces.status, 200); assert.equal(workspaces.id, "rpc-request");
  assert.deepEqual((workspaces.body as any).workspaces.map((row: any) => row.id), [f.workspaceId]);
  const scoped = f.db.forWorkspace(f.workspaceId);
  scoped.orchWorkflows.upsert({ id: "workflow" as any, workspaceId: f.workspaceId, family: "feature-dev", name: "flow", description: "local", version: 1,
    nodes: [{ id: "start", type: "start", label: "start", position: { x: 0, y: 0 } }, { id: "end", type: "end", label: "end", position: { x: 1, y: 0 } }],
    edges: [{ id: "link", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }], kind: "custom", workflowKnowledgeBundleIds: [] });
  const workflows = await f.call("orch.workflows.list", { workspaceId: f.workspaceId });
  assert.equal(workflows.status, 200); assert.equal((workflows.body as any).workflows[0].id, "workflow");
  assert.equal((await f.call("orch.workflows.list", { workspaceId: f.other })).status, 400);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
});

test("desktop 账号任务RPC允许同账号远程只读方法", async t => {
  const f = fixture(t);
  const read = await f.call("fs.readFile", { workspaceId: f.workspaceId, path: "missing.txt" });
  assert.notEqual(read.status, 403);
});

test("desktop 账号任务RPC允许同账号远程读写会话工作流", async t => {
  const f = fixture(t), threadId = "thread-account-chat" as any;
  f.db.forWorkspace(f.workspaceId).threads.create({ id: threadId, workspaceId: f.workspaceId, engine: "codex", title: "account chat" });
  // Server 附带身份与执行范围，客户端校验身份一致后剔除，由本机重新解析。
  const snapshot = await f.call("orch.chat.get", { workspaceId: f.workspaceId, threadId, actorUserId: f.owner.ownerUserId });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.deepEqual((snapshot.body as any).tasks, []);
  const prepare = await f.call("orch.chat.prepare", { workspaceId: f.workspaceId, threadId, taskId: "missing", expectedVersion: 0, actorUserId: f.owner.ownerUserId });
  assert.equal(prepare.status, 404, JSON.stringify(prepare.body));
  assert.equal((prepare.body as any).code, "CHAT_WORKFLOW_TASK_NOT_FOUND");
  const action = await f.call("orch.chat.action", { workspaceId: f.workspaceId, threadId, taskId: "missing", action: "start",
    requestId: "req", expectedVersion: 0, actorUserId: f.owner.ownerUserId,
    executionProfileScope: { scopeType: "shared_workspace", scopeId: "forged" } });
  assert.equal(action.status, 404, JSON.stringify(action.body));
  assert.equal((action.body as any).code, "CHAT_WORKFLOW_TASK_NOT_FOUND");
  const forged = await f.call("orch.chat.get", { workspaceId: f.workspaceId, threadId, actorUserId: "other-user" });
  assert.equal(forged.status, 400);
});

test("desktop 云连接允许已认证账号查询已知本机工作区引擎状态", async t => {
  const f = fixture(t);
  initializeLocalEngineModelCatalog();
  t.after(resetEngineModelCatalogRuntimeForTest);
  const result = await f.call("engines.status", { workspaceId: f.workspaceId });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((result.body as { engines: Array<{ engineType: string }> }).engines.map(e => e.engineType), ["claude", "codex"]);
  for (const body of [{}, { workspaceId: f.other }, { workspaceId: "shared:joined" }, { workspaceId: f.workspaceId, apiKey: "forged" }]) {
    assert.ok((await f.call("engines.status", body)).status >= 400);
  }
  assert.deepEqual(f.sent, []);
});

test("desktop 账号任务RPC接受 Server 附带的一致账号身份并拒绝不一致身份", async t => {
  const f = fixture(t);
  // 只读线程列表要求工作区 Profile 已初始化；先按真实桌面路径打开一次。
  f.db.forWorkspace(f.workspaceId);
  const listed = await f.call("threads.list", { workspaceId: f.workspaceId, actorUserId: f.owner.ownerUserId });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal((listed.body as { ok?: boolean }).ok, true);
  const forged = await f.call("threads.list", { workspaceId: f.workspaceId, actorUserId: "other-user" });
  assert.equal(forged.status, 400);
  assert.equal((forged.body as { code?: string }).code, "BAD_REQUEST");
});

test("desktop 账号任务RPC允许 Client 历史清理并透传截止时间", async t => {
  const f = fixture(t);
  const status = await f.call("clientDb.cleanup.status", { clientId: "desktop" });
  assert.equal(status.status, 503, "缺少清理服务时应到达处理器而不是被账号任务过滤拒绝");
  const start = await f.call("clientDb.cleanup.start", { clientId: "desktop", inactiveBefore: Date.now() - 1_000 });
  assert.equal(start.status, 503);
  assert.notEqual((status.body as { code?: string }).code, "FORBIDDEN");
});

test("desktop 账号任务RPC将Key和模型列表交给统一桌面API处理器", async t => {
  const f = fixture(t);
  f.db.engineKeys.insert({ label: "personal", engine: "codex", providerId: "openai", apiKey: "account-owned-secret" });
  const keys = await f.call("engineKeys.list", { workspaceId: f.workspaceId });
  assert.equal(keys.status, 200, JSON.stringify(keys.body));
  assert.equal((keys.body as any).keys[0].apiKey, "account-owned-secret");
  const models = await f.call("engineCustomModels.list", { workspaceId: f.workspaceId });
  assert.equal(models.status, 200, JSON.stringify(models.body));
  assert.deepEqual(f.sent, []);
});

test("desktop 账号任务RPC将参数错误交给统一桌面API校验", async t => {
  const f = fixture(t);
  const result = await f.call("workspaces.delete", {});
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.notEqual((result.body as any).code, "FORBIDDEN");
  assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
  assert.equal(f.db.scheduledTaskConfigs.list({ clientId: "desktop", deviceId: "installation" }).length, 0);
});

test("desktop 账号任务RPC的未知方法由统一桌面API返回Not Found", async t => {
  const f = fixture(t), result = await f.call("client.exit");
  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.notEqual((result.body as any).code, "FORBIDDEN");
  assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
});

for (const body of [{ taskId: "account-task", ownerUserId: "B" }, { taskId: 1 }, {}, { taskId: " account-task" }, []]) {
  test(`desktop 账号任务RPC坏参数不派发：${JSON.stringify(body)}`, async t => {
    const f = fixture(t), result = await f.call("scheduledTasks.runNow", body);
    assert.equal(result.status, 400); assert.deepEqual(f.calls, []); assert.deepEqual(f.sent, []);
  });
}

test("desktop 账号任务RPC手动运行走原账号Scheduler和耐久回执，零本机运行记录", async t => {
  const f = fixture(t), result = await f.call("scheduledTasks.runNow", { taskId: f.task.id });
  assert.equal(result.status, 200); assert.equal((result.body as any).run.status, "success"); assert.match((result.body as any).run.outputExcerpt, /account-rpc/u);
  assert.equal(f.db.scheduledTaskRuns.list({}).total, 0);
  assert.ok(f.calls.some(([action, body]) => action === "report" && (body as any).run?.status === "success"));
  assert.deepEqual(f.sent, []);
});

test("desktop 账号任务RPC在await后重核原owner，旧响应不得落到新连接", async t => {
  const f = fixture(t); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.scheduler, "runNow", async () => { await pending; return { id: "run", taskId: f.task.id } as any; });
  const request = f.call("scheduledTasks.runNow", { taskId: f.task.id }), rejected = assert.rejects(request, /OWNER_REVOKED/u);
  await new Promise(setImmediate); f.identity.active = false; release(); await rejected;
  assert.deepEqual(f.sent, []);
  await assert.rejects(f.call("workspaces.list"), /OWNER_REVOKED/u);
});

test("desktop 账号任务RPC身份校验诊断失败保原错误且零派发", async t => {
  const f = fixture(t), cause = new Error("CONTROLLED_RPC_LOG_FAILURE");
  t.mock.method(logger, "warn", () => { throw cause; });
  await assert.rejects(f.call("threads.list", { workspaceId: f.workspaceId, actorUserId: "other-user" }), error => error === cause);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
});

test("desktop 账号任务RPC只读列表完成后注销也不返回旧数据", async t => {
  const f = fixture(t), list = f.db.workspaces.list.bind(f.db.workspaces);
  t.mock.method(f.db.workspaces, "list", (...args: Parameters<typeof list>) => { const result = list(...args); f.identity.active = false; return result; });
  await assert.rejects(f.call("workspaces.list"), /OWNER_REVOKED/u);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.calls, []);
});

/** 直接执行index原云回调；WS/HTTP不得另造白名单或通用转发路径。 */
function cloudCallbacks(ctx: ApiHandlerContext) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let object: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "createDesktopCloudAccount" && ts.isObjectLiteralExpression(node.arguments[0]!)) object = node.arguments[0] as ts.ObjectLiteralExpression;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(object);
  /** 只注入真实装配依赖，不复制产品方法的路由判断。 */
  const read = (name: string): (...args: any[]) => Promise<any> => {
    const property = object!.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(tree) === name);
    assert.ok(property && ts.isPropertyAssignment(property));
    const script = ts.transpileModule(`(${property.initializer.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function("env", `with(env) { return ${script}; }`)({ desktopCloudAccount: ctx.desktopCloudAccount, desktopApiHandlerContext: ctx,
      executeDesktopAccountTaskRequest, sendToServer: (message: unknown) => ctx.desktopCloudAccount!.send(message as any), selfVersion: "test", runtimeStartedAt: 1 });
  };
  return { onMessage: read("onMessage"), executeHostTask: read("executeHostTask") };
}

for (const transport of ["ws", "http"] as const) test(`index 桌面${transport}复用统一桌面API响应`, async t => {
  const f = fixture(t), replies: any[] = [];
  f.ctx.desktopCloudAccount!.send = ((message: unknown) => { replies.push(message); return { accepted: true }; }) as any;
  const handlers = cloudCallbacks(f.ctx);
  const request = { t: "api.req", id: "wire", method: "workspaces.list", path: "/workspaces/list", body: {} };
  if (transport === "ws") await handlers.onMessage(request, f.owner);
  else replies.push(...await handlers.executeHostTask({ operationId: "host-task", message: request }, f.owner));
  assert.equal(replies.length, 1); assert.equal(replies[0].status, 200); assert.equal(replies[0].id, "wire");
  assert.deepEqual(replies[0].body.workspaces.map((row: any) => row.id), [f.workspaceId]);
  replies.length = 0; request.method = "engineKeys.list";
  request.body = { workspaceId: f.workspaceId };
  if (transport === "ws") await handlers.onMessage(request, f.owner);
  else replies.push(...await handlers.executeHostTask({ operationId: "host-task", message: request }, f.owner));
  assert.equal(replies.length, 1); assert.equal(replies[0].status, 200);
});
