import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createDesktopCloudAccount } from "../src/runtime/desktopCloudAccount.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { listenLoopbackHttpServer } from "./helpers/listenLoopbackHttpServer.js";

const user = (id: string) => ({ userId: id, email: `${id}@example.test`, fullName: id, phone: "", avatarUrl: null, accountRole: "personal_normal" as const, status: "active" as const, enterpriseId: null, enterpriseName: null });

test("auto Key diagnostic logs preserve safe root metadata without exception body or secrets", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function toBuiltInRelayFailureLogValue(");
  const end = source.indexOf("/** 仅识别工作区写入", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ESNext });
  const serialize = new Function(code + "\nreturn toBuiltInRelayFailureLogValue;")();
  const nested = Object.assign(new Error("secret-sentinel-response-body"), { code: "EACCES", errno: -13, syscall: "open" });
  const error = Object.assign(new TypeError("secret-sentinel-top", { cause: nested }), { code: "SQLITE_READONLY", status: 503, details: { rawKey: "secret-sentinel" } });
  const result = serialize(error);
  assert.deepEqual(result, { name: "TypeError", code: "SQLITE_READONLY", status: 503, cause: { name: "Error", code: "EACCES", errno: -13, syscall: "open" } });
  assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
  assert.deepEqual(serialize("secret-sentinel"), { name: "UnknownError" });
  const cyclic = new Error("secret-sentinel"); cyclic.cause = cyclic;
  assert.deepEqual(serialize(cyclic), { name: "Error", cause: { name: "Error", cause: { name: "Error" } } });
});

/** 真实 loopback WS/HTTP 记录请求，默认只提供测试 ensure，不接触用户服务。 */
async function fixture(t: test.TestContext) {
  const hellos: any[] = [];
  const sockets = new Map<string, WebSocket>();
  const httpRequests: any[] = [];
  let httpFailure: { status: number; body?: unknown; rawBody?: string } | undefined;
  let httpHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;
  const server = http.createServer((req, res) => {
    httpRequests.push({ url: req.url, authorization: req.headers.authorization });
    if (httpHandler) { httpHandler(req, res); return; }
    res.setHeader("content-type", "application/json");
    if (httpFailure) { res.statusCode = httpFailure.status; res.end(httpFailure.rawBody ?? JSON.stringify(httpFailure.body)); return; }
    res.end(JSON.stringify({ ok: true, key: { providerId: "codeflow", keyId: "relay-A", ownerUserId: "A", rawKey: "test-secret-A", baseUrl: "http://127.0.0.1/relay" } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, req) => {
    const token = req.headers.authorization!.slice(7); sockets.set(token, socket);
    socket.on("message", raw => hellos.push({ token, message: JSON.parse(String(raw)) }));
  });
  const port = await listenLoopbackHttpServer(server);
  const invalidated: any[] = [];
  const delivered: any[] = [];
  const failures: Error[] = [];
  const failureReports: Array<{ error: Error; context: { generation: number; serverOrigin: string | null } }> = [];
  let expectDrainFailure = false;
  let expectedDrainCause: Error | undefined;
  let credentialCleanupFailed = false;
  let linkedHandler: ((owner: any) => Promise<any>) | undefined;
  let handler: ((message: any, owner: any) => Promise<void>) | undefined;
  let hostHandler: ((task: any, owner: any) => Promise<any[]>) | undefined;
  let hostAuthorized: ((message: any) => boolean) | undefined;
  const runtime = createDesktopCloudAccount({ clientId: "local-device", deviceId: "device-id", clientVersion: "1.0.0", timeoutMs: 500, getWorkspaceIds: () => [],
    onHello: async () => {}, onMessage: async (message, owner) => { delivered.push({ message, owner }); await handler?.(message, owner); },
    onOwnerInvalidated: owner => { invalidated.push(owner); },
    /** 保留原失败与所属代次，验证延迟清理不会借用后续账号上下文。 */
    onFailure(error, context) { failures.push(error); failureReports.push({ error, context }); },
    getCredentialCleanupErrorCode: () => credentialCleanupFailed ? "DESKTOP_CREDENTIAL_RELEASE_FAILED" : null,
    onLinked: async owner => await linkedHandler?.(owner),
    isHostCommandAuthorized: message => hostAuthorized?.(message) ?? true,
    executeHostTask: async (task, owner) => await hostHandler?.(task, owner) ?? [],
  });
  t.after(async () => {
    try {
      if (expectDrainFailure) await assert.rejects(runtime.stopAndDrain(), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /DRAIN|CLEANUP/u);
        if (expectedDrainCause) {
          /** 聚合包装可以重复保因，但不能吞掉或替换预期的原始入站错误。 */
          const causes = (value: unknown): unknown[] => value instanceof AggregateError ? value.errors.flatMap(causes) : [value];
          const failures = causes(error);
          assert.ok(failures.length > 0);
          for (const failure of failures) assert.equal(failure, expectedDrainCause);
        }
        return true;
      });
      else await runtime.stopAndDrain();
    }
    finally { for (const socket of sockets.values()) socket.terminate(); await new Promise<void>((resolve, reject) => ws.close(error => error ? reject(error) : resolve())); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  const origin = `http://127.0.0.1:${port}`;
  /** 有界等待测试 WS 的实际消息，不使用固定睡眠冒充握手。 */
  const waitHello = async (token: string) => {
    const end = Date.now() + 2000;
    while (!hellos.some(item => item.token === token)) { if (Date.now() > end) throw new Error("test hello timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
    return sockets.get(token)!;
  };
  /** 由真实 Server socket 发出握手，可启用隔离HTTP轮询核验失败诊断。 */
  const ack = (socket: WebSocket, id: string, hostRpc = false) => socket.send(JSON.stringify({ t: "client.helloAck", keyHash: `key-${id}`, serverNow: Date.now(), userSummary: user(id), accountSessionId: `session-${id}`, capabilities: { desktopLocalRuntimeV1: true,
    ...(hostRpc ? { hostRpcHttpLongPoll: true, hostRpcHttpSessionId: "host-session" } : {}) } }));
  return { runtime, origin, hellos, delivered, failures, failureReports, httpRequests, invalidated, waitHello, ack, setHandler(value: typeof handler) { handler = value; },
    /** 精确控制当前scope授权及真实HTTP任务执行边界。 */
    setHostHandler(check: NonNullable<typeof hostAuthorized>, execute: NonNullable<typeof hostHandler>) { hostAuthorized = check; hostHandler = execute; },
    /** 仅在此隔离服务控制真实 HTTP 正文和完成顺序。 */
    setHttpHandler(value: typeof httpHandler) { httpHandler = value; },
    /** 控制真实 hello 后自动 Key 的完成顺序及显式结果。 */
    setLinkedHandler(value: typeof linkedHandler) { linkedHandler = value; },
    /** 真实旧请求失败必须在统一停机边界保持可见，可进一步核对原错误身份。 */
    expectFailedDrain(cause?: Error) { expectDrainFailure = true; expectedDrainCause = cause; },
    /** 模拟原持久失败集合的只读投影，不改变当前认证主体。 */
    failCredentialCleanup() { credentialCleanupFailed = true; },
    /** 仅设置本隔离 HTTP 服务的显式失败响应。 */
    setHttpFailure(status: number, body: unknown) { httpFailure = { status, body }; },
    /** 损坏正文仅用于验证解析边界不会外泄 Server 原文。 */
    setMalformedHttpBody(status: number, rawBody: string) { httpFailure = { status, rawBody }; },
  };
}

test("HTTP共享回填先到时等待WS当前授权，授权应用完成前不执行且保持云连接", { timeout: 3_000 }, async t => {
  const f = await fixture(t);
  let authorized = false, executed = 0, polls = 0, entered!: () => void, applied!: () => void;
  const checked = new Promise<void>(resolve => { entered = resolve; });
  const applying = new Promise<void>(resolve => { applied = resolve; });
  const envelope = { hostBindingId: "binding", hostScopeEpoch: 7, localWorkspaceId: "workspace", sharedWorkspaceId: "shared",
    routeEventId: "route", operationId: "operation", operationKey: "context.list" };
  f.setHostHandler(() => { entered(); return authorized; }, async () => {
    executed++; return [{ t: "sharedWorkspace.route.result", message: { routeEventId: "route", operationId: "operation", status: "succeeded", completedAt: Date.now(), result: {} } }];
  });
  let posted!: () => void;
  const resultPosted = new Promise<void>(resolve => { posted = resolve; });
  f.setHttpHandler((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { req.resume(); res.end('{}'); posted(); return; }
    if (++polls === 1) res.end(JSON.stringify({ operationId: "http-operation", message: { t: "sharedWorkspace.command", envelope } }));
    else { res.writeHead(204); res.end(); }
  });
  f.setHandler(async message => { if (message.t === "conversation.event.relayScopes") { await applying; authorized = true; } });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A", true); await pending;
  await Promise.race([checked, resultPosted]);
  assert.equal(executed, 0); assert.equal(f.runtime.snapshot().status, "linked");
  socket.send(JSON.stringify({ t: "conversation.event.relayScopes", scopes: [] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed, 0);
  applied(); await resultPosted;
  assert.equal(executed, 1); assert.deepEqual(f.failures, []); assert.equal(f.runtime.snapshot().status, "linked");
});

test("WS共享命令等待授权期间退出账号，迟到范围不能执行旧命令", { timeout: 3_000 }, async t => {
  const f = await fixture(t);
  let checked!: () => void, authorized = false;
  const waiting = new Promise<void>(resolve => { checked = resolve; });
  f.setHostHandler(() => { checked(); return authorized; }, async () => []);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  socket.send(JSON.stringify({ t: "sharedWorkspace.command", envelope: { hostBindingId: "old", localWorkspaceId: "workspace" } }));
  await waiting;
  await f.runtime.unlink(); authorized = true;
  assert.equal(f.delivered.some(value => value.message.t === "sharedWorkspace.command"), false);
  assert.equal(f.runtime.snapshot().status, "unlinked");
});

test("HTTP共享命令等待授权期间退出不污染排空，旧命令不执行不提交", { timeout: 3_000 }, async t => {
  const f = await fixture(t);
  let checked!: () => void, polls = 0, executed = 0, posts = 0;
  const waiting = new Promise<void>(resolve => { checked = resolve; });
  f.setHostHandler(() => { checked(); return false; }, async () => { executed++; return []; });
  f.setHttpHandler((req, res) => {
    if (req.method === "POST") { posts++; req.resume(); res.end('{}'); return; }
    if (++polls === 1) res.end(JSON.stringify({ operationId: "cancelled-http", message: { t: "sharedWorkspace.command", envelope: { hostBindingId: "old", localWorkspaceId: "workspace" } } }));
    else { res.writeHead(204); res.end(); }
  });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A", true); await pending; await waiting;
  await f.runtime.unlink();
  assert.equal(executed, 0); assert.equal(posts, 0); assert.equal(f.runtime.snapshot().status, "unlinked");
});

test("共享范围从未确认时有界失败，不执行命令或返回成功", { timeout: 3_000 }, async t => {
  const f = await fixture(t);
  f.setHostHandler(() => false, async () => { assert.fail("未授权不得执行"); });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  socket.send(JSON.stringify({ t: "sharedWorkspace.command", envelope: { hostBindingId: "missing", localWorkspaceId: "workspace" } }));
  const deadline = Date.now() + 2_000;
  while (!f.failures.length) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.equal((f.failures[0] as Error & { code: string }).code, "DESKTOP_CLOUD_HOST_SCOPE_REQUIRED");
  assert.equal(f.delivered.some(value => value.message.t === "sharedWorkspace.command"), false);
  f.expectFailedDrain();
});

test("桌面归因仅在显式调用时上传，旧账号 transport 不能借用新会话", async t => {
  const f = await fixture(t);
  f.setHttpHandler((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, associationId: "association-A", expiresAt: Date.now() + 300_000 }));
  });
  const linked = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  f.ack(await f.waitHello("token-A"), "A");
  await linked;
  const owner = f.runtime.getOwner()!;
  const transport = f.runtime.createCodeAttributionTransport(owner);
  assert.equal(f.httpRequests.length, 0);
  assert.equal("token" in owner, false);
  assert.equal((await transport.renewAssociation!({ associationId: "old-association", sourceWorkspaceId: "ws-A", sourceInstanceId: "instance-A" })).associationId, "association-A");
  await f.runtime.unlink();
  await assert.rejects(transport.renewAssociation!({ associationId: "old-association", sourceWorkspaceId: "ws-A", sourceInstanceId: "instance-A" }), /OWNER_STALE/u);
  assert.equal(f.httpRequests.length, 1);
});

test("desktop scheduled task transport fixes account target and keeps tokens inside the original Attempt", async t => {
  const f = await fixture(t), requests: Array<{ url: string | undefined; body: unknown; requestId: string | undefined }> = [];
  f.setHttpHandler((req, res) => {
    let body = ""; req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => { requests.push({ url: req.url, body: JSON.parse(body), requestId: req.headers["x-request-id"] as string | undefined });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, serverNow: 100, ...(req.url?.endsWith("/sync") ? { tasks: [] } : {}) })); });
  });
  const link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  const runtime = f.runtime as any, owner = f.runtime.getOwner()!;
  assert.deepEqual(await runtime.requestScheduledTasks(owner, "sync", {}, "sync-A"), { tasks: [], serverNow: 100 });
  const run = { id: "run-A", taskId: "task-A" };
  assert.deepEqual(await runtime.requestScheduledTasks(owner, "report", { run, nextRuns: [], clientId: "spoof", deviceId: "spoof" }, "report-A"), { serverNow: 100 });
  assert.deepEqual(requests, [
    { url: "/api/client/scheduled-tasks/sync", body: { clientId: "local-device", deviceId: "device-id" }, requestId: "sync-A" },
    { url: "/api/client/scheduled-tasks/report", body: { run, nextRuns: [], clientId: "local-device", deviceId: "device-id" }, requestId: "report-A" },
  ]);
  assert.deepEqual(f.httpRequests.map(item => item.authorization), ["Bearer token-A", "Bearer token-A"]);
  assert.equal(JSON.stringify(f.runtime.snapshot()).includes("token-A"), false);
  await f.runtime.unlink();
  await assert.rejects(runtime.requestScheduledTasks(owner, "sync", {}, "stale-A"), /STALE_OR_UNAVAILABLE/u);
  assert.equal(requests.length, 2);
});

test("desktop task sync preserves complete revision floors and projects only their public fields", async t => {
  const f = await fixture(t), link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  const tasks = [{ id: "first-task" }, { id: "second-task" }];
  f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, serverNow: 100, tasks, configRevisionFloors: [
      { taskId: "first-task", localRevision: 0, privateValue: "private-floor-body" }, { taskId: "second-task", localRevision: Number.MAX_SAFE_INTEGER },
    ] })); });
  const response = await f.runtime.requestScheduledTasks(f.runtime.getOwner()!, "sync", {}, "valid-config-floors");
  assert.deepEqual(response, { tasks, serverNow: 100, configRevisionFloors: [
    { taskId: "first-task", localRevision: 0 }, { taskId: "second-task", localRevision: Number.MAX_SAFE_INTEGER },
  ] });
  assert.doesNotMatch(JSON.stringify(response), /private-floor-body/u);
  f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, serverNow: 101, tasks: [], configRevisionFloors: [] })); });
  assert.deepEqual(await f.runtime.requestScheduledTasks(f.runtime.getOwner()!, "sync", {}, "empty-config-floors"),
    { tasks: [], serverNow: 101, configRevisionFloors: [] });
});

test("desktop task sync rejects invalid incomplete and duplicate revision floors instead of defaulting", async t => {
  const f = await fixture(t), link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  for (const floors of [null, {}, [], [{ taskId: "task-A", localRevision: -1 }], [{ taskId: "task-A", localRevision: 1.5 }],
    [{ taskId: "task-A", localRevision: "1" }], [{ taskId: "task-A", localRevision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ taskId: "task-A" }], [{ taskId: "foreign", localRevision: 1 }],
    [{ taskId: "task-A", localRevision: 1 }, { taskId: "task-A", localRevision: 2 }], [{ taskId: ["task-A"], localRevision: 1 }]]) {
    f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, serverNow: 100, tasks: [{ id: "task-A" }], configRevisionFloors: floors })); });
    await assert.rejects(f.runtime.requestScheduledTasks(f.runtime.getOwner()!, "sync", {}, "invalid-config-floors"),
      { code: "SCHEDULED_TASK_API_FAILED", reason: "invalid_ack" });
  }
  f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, serverNow: 100, tasks: [{ id: "task-A" }, { id: "task-A" }],
      configRevisionFloors: [{ taskId: "task-A", localRevision: 1 }, { taskId: "other", localRevision: 2 }] })); });
  await assert.rejects(f.runtime.requestScheduledTasks(f.runtime.getOwner()!, "sync", {}, "duplicate-config-task"), { reason: "invalid_ack" });
  assert.equal(f.runtime.snapshot().status, "linked");
});

test("desktop config writeback uses the original account and projects only the revision contract", async t => {
  const f = await fixture(t), requests: unknown[] = [];
  f.setHttpHandler((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += String(chunk); });
    req.on("end", () => { const body = JSON.parse(raw); requests.push({ url: req.url, body });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, taskId: body.taskId, localRevision: body.localRevision,
        expectedConfigRevision: body.expectedConfigRevision, deleted: true, task: null })); });
  });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" }), socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  const revision = { taskId: "task-A", localRevision: 4, expectedConfigRevision: 2, operation: "delete" };
  const response = await (f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config",
    { ...revision, ownerUserId: "forged", clientId: "forged", deviceId: "forged", run: { id: "not-config" } }, "config-A");
  assert.deepEqual(response, { taskId: "task-A", localRevision: 4, expectedConfigRevision: 2, deleted: true, task: null });
  assert.deepEqual(requests, [{ url: "/api/client/scheduled-tasks/config", body: { ...revision, clientId: "local-device", deviceId: "device-id" } }]);
  assert.deepEqual(f.httpRequests.map(item => item.authorization), ["Bearer token-A"]);
});

test("desktop config writeback validates the exact ACK and exposes only a known rejection code", async t => {
  const f = await fixture(t), pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  const revision = { taskId: "task-A", localRevision: 4, expectedConfigRevision: 2, operation: "delete" };
  const ack = { ok: true, taskId: "task-A", localRevision: 4, expectedConfigRevision: 2, deleted: true, task: null };
  for (const changed of [{ taskId: "foreign" }, { localRevision: 3 }, { expectedConfigRevision: 1 }, { deleted: false, task: {} }]) {
    f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...ack, ...changed })); });
    await assert.rejects((f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config", revision, "bad-config"), { reason: "invalid_ack" });
  }
  f.setHttpHandler((_req, res) => { res.writeHead(409, { "content-type": "application/json", "x-request-id": "upstream-config" });
    res.end(JSON.stringify({ ok: false, code: "CONFLICT", message: "private-config-body token-secret" })); });
  await assert.rejects((f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config", revision, "rejected-config"), (error: any) => {
    assert.equal(error.reason, "rejected_response"); assert.equal(error.httpStatus, 409); assert.equal(error.upstreamCode, "CONFLICT");
    assert.doesNotMatch(JSON.stringify(error), /private-config-body|token-secret/u); return true;
  });
  assert.equal(f.runtime.snapshot().status, "linked"); await f.runtime.unlink();
});

test("desktop config writeback cancellation cannot acknowledge an old revision to the next account", async t => {
  const f = await fixture(t), pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  let entered!: () => void, response: http.ServerResponse | undefined; const received = new Promise<void>(resolve => { entered = resolve; });
  f.setHttpHandler((_req, res) => { response = res; res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,'); entered(); });
  const request = (f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config",
    { taskId: "task-A", localRevision: 1, expectedConfigRevision: 1, operation: "delete" }, "old-config");
  const rejected = assert.rejects(request, /STALE_OR_UNAVAILABLE/u);
  try {
    await received; const next = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" }); await rejected;
    const nextSocket = await f.waitHello("token-B"); f.ack(nextSocket, "B"); await next;
    assert.equal(f.runtime.getOwner()!.ownerUserId, "B"); assert.equal(f.httpRequests.length, 1);
  } finally { response?.end(); }
});

test("desktop config writeback keeps rejection codes scalar and binds ACK to the transmitted revision", async t => {
  const f = await fixture(t), pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  const revision = { taskId: "task-A", localRevision: 4, expectedConfigRevision: 2, operation: "delete" };
  f.setHttpHandler((_req, res) => { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, code: ["CONFLICT"] })); });
  await assert.rejects((f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config", revision, "array-code"), (error: any) => {
    assert.equal(error.upstreamCode, undefined); return true;
  });
  f.setHttpHandler((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += String(chunk); });
    req.on("end", () => { const sent = JSON.parse(raw); revision.localRevision = 5; revision.operation = "update";
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, taskId: sent.taskId, localRevision: sent.localRevision,
        expectedConfigRevision: sent.expectedConfigRevision, deleted: true, task: null })); });
  });
  const response = await (f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "config", revision, "fixed-revision");
  assert.equal(response.localRevision, 4); assert.equal(response.deleted, true);
});

for (const transition of ["unlink", "relink"] as const) {
  test(`desktop scheduled task transport cancels an unfinished response body on ${transition}`, async t => {
    const f = await fixture(t);
    const link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
    const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
    let entered!: () => void, oldResponse: http.ServerResponse | undefined;
    const received = new Promise<void>(resolve => { entered = resolve; });
    f.setHttpHandler((_req, res) => { oldResponse = res; res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,'); entered(); });
    const pending = (f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "sync", {}, "old-body");
    const rejected = assert.rejects(pending, /STALE_OR_UNAVAILABLE/u);
    try {
      await received;
      const next = transition === "unlink" ? f.runtime.unlink() : f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
      await rejected;
      if (transition === "relink") { const nextSocket = await f.waitHello("token-B"); f.ack(nextSocket, "B"); }
      await next;
      oldResponse!.end('"tasks":[],"serverNow":100}');
      assert.equal(f.runtime.getOwner()?.ownerUserId ?? null, transition === "relink" ? "B" : null);
      assert.equal(f.failures.length, 0);
    } finally { oldResponse?.end(); }
  });
}

test("desktop scheduled task transport rejects HTTP protocol and ACK failures without poisoning unlink", async t => {
  const f = await fixture(t), link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  const runtime = f.runtime as any, owner = f.runtime.getOwner()!;
  const cases = [
    { status: 403, body: { ok: false, message: "secret-response-marker" }, reason: "rejected_response" },
    { status: 200, raw: "secret-response-marker", reason: "invalid_json" },
    { status: 200, body: { ok: true, serverNow: "100" }, reason: "invalid_ack" },
    { status: 200, body: { ok: true, serverNow: 100 }, reason: "invalid_ack" },
  ];
  for (const [index, value] of cases.entries()) {
    f.setHttpHandler((_req, res) => { res.writeHead(value.status, { "content-type": "application/json", "x-request-id": "upstream-A" });
      res.end(value.raw ?? JSON.stringify(value.body)); });
    await assert.rejects(runtime.requestScheduledTasks(owner, "sync", {}, "failure-" + index), (error: any) => {
      assert.equal(error.code, "SCHEDULED_TASK_API_FAILED"); assert.equal(error.httpStatus, value.status);
      assert.equal(error.reason, value.reason); assert.equal(error.upstreamRequestId, "upstream-A");
      assert.equal(error.ownerUserId, "A"); assert.equal(error.requestId, "failure-" + index);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /secret-response-marker|token-A/u); return true;
    });
  }
  assert.equal(f.httpRequests.length, cases.length);
  assert.equal(f.runtime.snapshot().status, "linked");
  assert.equal((await f.runtime.unlink()).status, "unlinked");
});

test("desktop scheduled task transport bounds an unfinished body and preserves its I/O cause", async t => {
  const f = await fixture(t), link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  let response: http.ServerResponse | undefined;
  f.setHttpHandler((_req, res) => { response = res; res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,'); });
  try {
    await assert.rejects((f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "sync", {}, "body-timeout"), (error: any) => {
      assert.equal(error.reason, "transport_failed"); assert.equal(error.httpStatus, 200);
      assert.equal(error.cause?.name, "TimeoutError"); return true;
    });
    assert.equal(f.runtime.snapshot().status, "linked");
    assert.equal((await f.runtime.unlink()).status, "unlinked");
  } finally { response?.end(); }
});

test("desktop scheduled task transport denies unlinked owners and redirects without sending a second request", async t => {
  const f = await fixture(t), runtime = f.runtime as any;
  const fake = { serverOrigin: f.origin, ownerUserId: "A", accountSessionId: "session-A", generation: 1 };
  await assert.rejects(runtime.requestScheduledTasks(fake, "sync", {}, "not-linked"), /STALE_OR_UNAVAILABLE/u);
  assert.equal(f.httpRequests.length, 0);
  const link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  f.setHttpHandler((_req, res) => { res.writeHead(307, { location: "/redirect-target" }); res.end(); });
  await assert.rejects(runtime.requestScheduledTasks(f.runtime.getOwner(), "sync", {}, "redirect"), (error: any) => {
    assert.equal(error.reason, "transport_failed"); return true;
  });
  assert.deepEqual(f.httpRequests.map(item => item.url), ["/api/client/scheduled-tasks/sync"]);
});

test("desktop scheduled task transport rechecks owner at the final return boundary", async t => {
  const f = await fixture(t), link = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await link;
  f.setHttpHandler((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, tasks: [], serverNow: 100 })); });
  const original = Response.prototype.text;
  let unlink: Promise<unknown> | undefined;
  // 真实正文完成后安排注销，覆盖内部检查通过到外层await返回之间的窗口。
  t.mock.method(Response.prototype, "text", function (this: Response) {
    const pending = original.call(this);
    void pending.then(() => { queueMicrotask(() => { unlink = f.runtime.unlink(); }); });
    return pending;
  });
  try {
    await assert.rejects((f.runtime as any).requestScheduledTasks(f.runtime.getOwner(), "sync", {}, "final-return"), /STALE_OR_UNAVAILABLE/u);
    assert.equal(f.runtime.snapshot().status, "unlinked");
  } finally { t.mock.restoreAll(); await unlink; }
});

test("desktop cloud link requires real authenticated hello and sends no local workspace inventory", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A");
  assert.equal(f.runtime.snapshot().status, "linking");
  assert.equal(f.runtime.getOwner(), null);
  assert.deepEqual(f.hellos[0].message.workspaceIds, []);
  assert.equal(f.hellos[0].message.capabilities.desktopLocalRuntimeV1, true);
  assert.equal(f.hellos[0].message.capabilities.desktopAccountScheduledTasksV1, true);
  assert.equal(f.hellos[0].message.capabilities.threadInputActionsV1, true);
  f.ack(socket, "A");
  const state = await pending;
  assert.equal(state.status, "linked"); assert.equal(state.userSummary?.userId, "A");
  assert.equal(f.runtime.getOwner()?.accountSessionId, "session-A");
  assert.equal(JSON.stringify(state).includes("token-A"), false);
});

test("account switch revokes old owner before drain and rejects late hello and ACK", async t => {
  const f = await fixture(t);
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  const oldOwner = f.runtime.getOwner()!;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  assert.throws(() => f.runtime.assertOwner(oldOwner), /STALE|UNAVAILABLE/u);
  assert.equal(f.invalidated.length, 1);
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b;
  assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
  await f.runtime.unlink(); assert.equal(f.runtime.snapshot().status, "unlinked");
  assert.equal(f.runtime.getOwner(), null);
});

test("old credential cleanup failure stays visible without replacing the new authenticated owner", async t => {
  const f = await fixture(t);
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b;
  f.failCredentialCleanup();
  assert.equal(f.runtime.snapshot().status, "linked");
  assert.equal(f.runtime.snapshot().errorCode, "DESKTOP_CREDENTIAL_RELEASE_FAILED");
  assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
  f.runtime.assertOwner(f.runtime.getOwner()!);
});

test("explicit auto Key failure preserves authenticated link and reports a separate failure", async t => {
  const f = await fixture(t);
  f.setLinkedHandler(async () => ({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" }));
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A");
  const state = await pending;
  assert.equal(state.status, "linked");
  assert.equal((state as any).builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  assert.equal(state.errorCode, null);
  const owner = f.runtime.getOwner()!; f.runtime.assertOwner(owner);
  assert.equal(owner.ownerUserId, "A");
  assert.equal(f.failures.length, 0); assert.equal(f.invalidated.length, 0);
  f.runtime.markBuiltInRelayReady(owner);
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, null);
});

test("actual builtin bridge clears only an available current-owner Codex retry and preserves failures", async t => {
  const f = await fixture(t);
  f.setLinkedHandler(async () => ({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" }));
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let available = false; let failure: Error | undefined;
  let release!: () => void; let entered!: () => void;
  let gate: Promise<void> | undefined;
  const ctx = { clientId: "local-device", desktopCloudAccount: f.runtime,
    workspaces: new Map([["local-device:ws", process.cwd()]]),
    db: { workspaces: { get: () => ({ path: process.cwd() }) } },
    sessions: { restartCodexProcesses: async () => {} },
    builtInRelayCredentials: {
      ensure: async (request: any) => { if (gate) { entered(); await gate; } if (failure) throw failure; return { id: "test-key", engine: request.engine, providerId: request.providerId, source: "builtin", apiKey: "", secretRef: "private-ref" }; },
      isAvailable: () => available,
    },
  } as unknown as ApiHandlerContext;
  /** 运行真实桥分支，仅隔离外部签发及秘密存储边界。 */
  const ensure = (engine: "codex" | "claude", providerId: string) => executeDesktopApiRequest(ctx,
    { method: "engineKeys.builtInRelay.ensure", body: { workspaceId: "local-device:ws", engine, providerId, intent: "manual" } },
    { requestId: "retry-test", clientVersion: "1", startedAt: 1 });
  await ensure("codex", "openai");
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  available = true; await ensure("claude", "anthropic");
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  failure = new Error("retry failed"); await assert.rejects(ensure("codex", "openai"), /retry failed/u);
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  failure = undefined; const ready = await ensure("codex", "openai");
  assert.equal(ready.status, 200); assert.equal(JSON.stringify(ready).includes("private-ref"), false);
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, null);
  const started = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise(resolve => { release = resolve; });
  const late = ensure("codex", "openai"); const rejected = assert.rejects(late, /STALE|UNAVAILABLE/u); await started;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b; release(); await rejected;
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
});

test("a successful manual Key enable cannot erase an unpersisted auto-enable marker failure", async t => {
  const f = await fixture(t);
  f.setLinkedHandler(async () => ({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED" }));
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  f.runtime.markBuiltInRelayReady(f.runtime.getOwner()!);
  assert.equal(f.runtime.snapshot().status, "linked");
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED");
});

test("actual builtin activation clears auto Key failure only after current-owner success", async t => {
  const f = await fixture(t);
  f.setLinkedHandler(async () => ({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" }));
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let available = false; let failure: Error | undefined; let gate: Promise<void> | undefined;
  let entered!: () => void; let release!: () => void;
  const key = { id: "builtin-test", engine: "codex", providerId: "openai", source: "builtin", apiKey: "", secretRef: "secret-reference" };
  const ctx = { clientId: "local-device", desktopCloudAccount: f.runtime,
    workspaces: new Map([["local-device:ws", process.cwd()]]),
    db: { workspaces: { get: () => ({ path: process.cwd() }) }, engineKeys: { get: () => key },
      /** 真实中央错误边界必须把本次激活诊断写入所属工作区。 */
      writeWorkspaceLog(workspaceId: string) { assert.equal(workspaceId, "local-device:ws"); },
    },
    send: () => {}, builtInRelayCredentials: {
      activate: async () => { if (gate) { entered(); await gate; } if (failure) throw failure; return key; },
      isAvailable: () => available,
    },
  } as unknown as ApiHandlerContext;
  /** 沿现役 handler 接收实际 activation 响应，外部签发使用隔离替身。 */
  const activate = () => executeDesktopApiRequest(ctx, { method: "engineKeys.activate", body: { workspaceId: "local-device:ws", id: key.id } }, { requestId: "activation-test", clientVersion: "1", startedAt: 1 });
  await activate(); assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  failure = Object.assign(new Error("activation denied"), { code: "CONFLICT" });
  assert.equal((await activate()).status, 409);
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  failure = undefined; available = true; assert.equal((await activate()).status, 200);
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, null);
  const started = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise(resolve => { release = resolve; });
  const late = activate(); const rejected = assert.rejects(late, /STALE|UNAVAILABLE/u); await started;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b; release(); await rejected;
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
});

test("unexpected post-hello callback failure still revokes the cloud owner", async t => {
  const f = await fixture(t);
  const failure = new Error("unexpected post-hello failure");
  f.expectFailedDrain(failure);
  f.setLinkedHandler(async () => { throw failure; });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const rejected = assert.rejects(pending, error => error === failure);
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await rejected;
  assert.equal(f.runtime.snapshot().status, "failed"); assert.equal(f.runtime.getOwner(), null);
  assert.equal(f.failures.length, 1);
});

test("completed hello does not time out while the independent auto Key attempt is pending", async t => {
  const f = await fixture(t);
  let release!: (value: any) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setLinkedHandler(async () => await new Promise(resolve => { release = resolve; entered(); }));
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await started;
  await new Promise(resolve => setTimeout(resolve, 550));
  release({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" });
  const result = await outcome;
  assert.ok("value" in result, "the completed hello cannot be failed by a Key attempt timeout");
  assert.equal(f.runtime.snapshot().status, "linked");
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
});

test("late auto Key failure and retry completion cannot overwrite the next owner", async t => {
  const f = await fixture(t);
  let release!: (value: any) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setLinkedHandler(async owner => owner.ownerUserId === "A" ? await new Promise(resolve => { release = resolve; entered(); }) : undefined);
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const rejectedA = assert.rejects(a, /SUPERSEDED/u);
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await started;
  const oldOwner = f.runtime.getOwner()!;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  release({ builtInRelayErrorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" }); await rejectedA;
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b;
  assert.equal(f.runtime.snapshot().builtInRelayErrorCode, null);
  assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
  assert.throws(() => f.runtime.markBuiltInRelayReady(oldOwner), /STALE|UNAVAILABLE/u);
});

test("old owner cancellation drains without preventing the next authenticated account", async t => {
  const f = await fixture(t);
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setHandler(async (_message, owner) => { entered(); await gate; f.runtime.assertOwner(owner); });
  socketA.send(JSON.stringify({ t: "relay.pricing.updated", catalog: {} })); await started;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const result = b.then(value => ({ value }), error => ({ error }));
  release();
  const socketB = await f.waitHello("token-B"); f.ack(socketB, "B");
  assert.equal((await result as any).value?.status, "linked");
  assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
});

test("real old handler failure is not treated as owner cancellation", async t => {
  const f = await fixture(t);
  f.expectFailedDrain();
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setHandler(async () => { entered(); await gate; throw new Error("real-database-failure"); });
  socketA.send(JSON.stringify({ t: "relay.pricing.updated", catalog: {} })); await started;
  const next = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const rejected = assert.rejects(next, /DESKTOP_CLOUD_LINK_FAILED/u); release(); await rejected;
  assert.equal(f.hellos.filter(item => item.token === "token-B").length, 0);
  assert.equal(f.runtime.snapshot().status, "failed");
});

for (const transition of ["unlink", "relink"] as const) test(`delayed old drain failure keeps its original account context after ${transition}`, async t => {
  const f = await fixture(t);
  f.expectFailedDrain();
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const drainFailure = new Error("original-account-drain-failure");
  f.setHandler(async () => { entered(); await gate; throw drainFailure; });
  socketA.send(JSON.stringify({ t: "relay.pricing.updated", catalog: {} })); await started;
  let unlinked: Promise<void> | undefined;
  try {
    f.runtime.disconnect(new Error("original-account-disconnected"));
    if (transition === "unlink") {
      unlinked = assert.rejects(f.runtime.unlink(), /DRAIN/u);
      assert.equal(f.runtime.snapshot().status, "unlinked");
    } else {
      const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
      const socketB = await f.waitHello("token-B"); f.ack(socketB, "B"); await b;
      assert.equal(f.runtime.getOwner()?.ownerUserId, "B");
    }
    assert.equal(f.runtime.snapshot().generation, 2);
  } finally { release(); }
  await unlinked;
  await assert.rejects(f.runtime.stopAndDrain(), /DRAIN|CLEANUP/u);
  const report = f.failureReports.find(item => item.error.message === "DESKTOP_CLOUD_DRAIN_FAILED");
  assert.ok(report);
  assert.deepEqual(report.context, { generation: 1, serverOrigin: f.origin });
});

test("three account transitions cannot skip an earlier real drain failure", async t => {
  const f = await fixture(t);
  f.expectFailedDrain();
  const a = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socketA = await f.waitHello("token-A"); f.ack(socketA, "A"); await a;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setHandler(async () => { entered(); await gate; throw new Error("real-three-owner-database-failure"); });
  socketA.send(JSON.stringify({ t: "relay.pricing.updated", catalog: {} })); await started;
  const b = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-B" });
  const cancelled = assert.rejects(b, /SUPERSEDED/u);
  const c = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-C" });
  const rejected = assert.rejects(c, /DESKTOP_CLOUD_LINK_FAILED/u);
  release(); await cancelled; await rejected;
  assert.equal(f.hellos.some(item => item.token === "token-C"), false);
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.ok(f.failures.length > 0);
  const retry = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-D" });
  const socketD = await f.waitHello("token-D"); f.ack(socketD, "D");
  assert.equal((await retry).userSummary?.userId, "D");
  await assert.rejects(f.runtime.stopAndDrain(), /DRAIN|CLEANUP/u);
});

test("云连接关闭码保留在安全诊断字段，原关闭原因不进入错误正文", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.equal(error.code, "DESKTOP_CLOUD_CONNECTION_CLOSED");
    assert.equal(error.cause.code, "WS_CLOSE_1008");
    assert.equal(String(error).includes("secret-close-reason"), false);
    return true;
  });
  const socket = await f.waitHello("token-A");
  socket.close(1008, "secret-close-reason");
  await rejected;
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.equal(f.failureReports.length, 1);
});

test("Host RPC认证403显式终止云关联并保留安全状态及上游错误码", async t => {
  const f = await fixture(t);
  f.setHttpFailure(403, { ok: false, code: "FORBIDDEN", message: "secret-response-body" });
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A", true);
  await pending;
  for (let attempt = 0; !f.failures.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.failures.length, 1);
  const error = f.failures[0] as Error & { code: string; status: number; cause: Error & { code: string } };
  assert.equal(error.code, "DESKTOP_CLOUD_HOST_RPC_FAILED");
  assert.equal(error.status, 403);
  assert.equal(error.cause.code, "FORBIDDEN");
  assert.equal(String(error).includes("secret-response-body"), false);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function toBuiltInRelayFailureLogValue(");
  const end = source.indexOf("/** 仅识别工作区写入", start);
  assert.ok(start >= 0 && end > start);
  const serialize = new Function(ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ESNext }) + "\nreturn toBuiltInRelayFailureLogValue;")();
  const diagnostic = serialize(error);
  assert.equal(diagnostic.code, "DESKTOP_CLOUD_HOST_RPC_FAILED");
  assert.equal(diagnostic.status, 403);
  assert.equal(diagnostic.cause.code, "FORBIDDEN");
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-response-body|token-A/u);
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.equal(f.runtime.getOwner(), null);
});

test("untrusted hello and link timeout fail explicitly without a linked owner", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const rejected = assert.rejects(pending, /HELLO|TIMEOUT/u);
  const socket = await f.waitHello("token-A");
  socket.send(JSON.stringify({ t: "client.helloAck", keyHash: "fake", serverNow: Date.now(), userSummary: user("A") }));
  await rejected; assert.equal(f.runtime.snapshot().status, "failed"); assert.equal(f.runtime.getOwner(), null);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0]!.message, "DESKTOP_CLOUD_HELLO_INVALID");
  assert.equal((f.failures[0] as Error & { code: string }).code, "DESKTOP_CLOUD_HELLO_INVALID");
  f.expectFailedDrain(f.failures[0]!);
});

test("invalid cloud WS JSON fails without recording response body text", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A");
  const rejected = assert.rejects(pending, error => {
    assert.equal((error as Error).message, "DESKTOP_CLOUD_MESSAGE_INVALID");
    assert.equal(String(error).includes("secret-ws-body-marker"), false); return true;
  });
  socket.send("secret-ws-body-marker");
  await rejected;
  assert.equal(f.runtime.snapshot().status, "failed");
  assert.equal(f.failures.some(error => String(error).includes("secret-ws-body-marker")), false);
  assert.equal(f.failures.length, 1);
  f.expectFailedDrain(f.failures[0]!);
});

test("ensure binds session and client identity and rejects stale owner before HTTP", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  const owner = f.runtime.getOwner()!;
  const key = await f.runtime.requestEnsure(owner, { providerId: "codeflow", requestId: "request-ensure" });
  assert.equal(key.keyId, "relay-A"); assert.equal(key.ownerUserId, "A");
  assert.equal(f.httpRequests.length, 1); assert.match(f.httpRequests[0].url, /clientId=local-device/u);
  await f.runtime.unlink();
  await assert.rejects(f.runtime.requestEnsure(owner, { providerId: "codeflow", requestId: "stale" }), /STALE|UNAVAILABLE/u);
  assert.equal(f.httpRequests.length, 1);
});

test("ensure preserves HTTP domain failure without forwarding response secrets", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  f.setHttpFailure(409, { ok: false, code: "RELAY_MISCONFIGURED", message: "secret-server-message",
    details: { reason: "provider_group_missing", providerId: "openai", rawKey: "secret-key", nested: { token: "secret-token" } } });
  await assert.rejects(f.runtime.requestEnsure(f.runtime.getOwner()!, { providerId: "openai", requestId: "ensure-domain-error" }), error => {
    const failure = error as Error & { status: number; code: string; details: unknown };
    assert.equal(failure.status, 409); assert.equal(failure.code, "RELAY_MISCONFIGURED");
    assert.deepEqual(failure.details, { reason: "provider_group_missing", providerId: "openai" });
    assert.equal(JSON.stringify(failure).includes("secret-"), false);
    assert.equal(failure.message.includes("secret-"), false); return true;
  });
  assert.equal(f.runtime.snapshot().status, "linked");
});

test("ensure rejects malformed JSON with safe status and no response body", async t => {
  const f = await fixture(t);
  const pending = f.runtime.link({ serverOrigin: f.origin, sessionToken: "token-A" });
  const socket = await f.waitHello("token-A"); f.ack(socket, "A"); await pending;
  for (const status of [200, 409]) {
    f.setMalformedHttpBody(status, "secret-body-marker");
    await assert.rejects(f.runtime.requestEnsure(f.runtime.getOwner()!, { providerId: "openai", requestId: "ensure-invalid-json" }), error => {
      const failure = error as Error & { status: number; code: string };
      assert.equal(failure.status, status === 200 ? 502 : status);
      assert.equal(failure.code, "DESKTOP_BUILTIN_ENSURE_RESPONSE_INVALID");
      assert.equal(failure.message.includes("secret-body-marker"), false);
      assert.equal(JSON.stringify(failure).includes("secret-body-marker"), false); return true;
    });
  }
});
