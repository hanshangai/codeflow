import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { WorkspaceApiRequestFailure, handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { dispatchWorkspaceApiRequestFailure } from "../src/transport/transportMessageFailurePolicy.js";
import { WsTransport } from "../src/transport/wsTransport.js";
import { openClientDb } from "../src/db/clientDb.js";
import ts from "typescript";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { createRawEventAckBuffer } from "../src/diagnostics/rawEventAckBuffer.js";
import { createThreadTouchBuffer } from "../src/diagnostics/threadTouchBuffer.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { logger } from "../src/logger.js";
import { indexCodexProviderTurnStarted } from "../src/eventIndex/codexProviderTurnStarted.js";
import { applyThreadStartedBinding, prepareThreadStartedBindingAck, resolveThreadStartedBinding } from "../src/eventIndex/threadStartedBinding.js";
import { extractThreadPrefsPatchFromConversationEvent, mergeThreadPrefs } from "@codeflowai/shared";

/** 只在原响应尚未尝试时补一条失败，不重复运行请求。 */
function failure(responseAttempted = false, responseDelivered = false) {
  return new WorkspaceApiRequestFailure([undefined, 0], { code: "WORKSPACE_API_REQUEST_LOG_FAILED",
    requestId: "request", workspaceId: "workspace", method: "orch.intakes.create", responseAttempted, responseDelivered });
}

test("请求日志失败经原传输边界补明确500，原业务和日志原因保持", () => {
  const original = failure(), responses: any[] = [];
  const result = dispatchWorkspaceApiRequestFailure({ error: original, requestId: "request", send(message) {
    responses.push(message); return { accepted: true };
  } });
  assert.equal(result?.error, original);
  assert.equal(result?.response, "accepted");
  assert.deepEqual(original.errors, [undefined, 0]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 500);
  assert.equal(responses[0].body.requestId, "request");
});

test("已尝试或已接受的响应均不重复投递，未知或不匹配异常仍归原策略", () => {
  let calls = 0;
  const send = () => { calls++; return { accepted: true }; };
  for (const delivered of [false, true]) {
    const original = failure(true, delivered);
    assert.deepEqual(dispatchWorkspaceApiRequestFailure({ error: original, requestId: "request", send }),
      { error: original, response: "already_attempted" });
  }
  assert.equal(dispatchWorkspaceApiRequestFailure({ error: failure(), requestId: "other", send }), null);
  assert.equal(dispatchWorkspaceApiRequestFailure({ error: new Error("unknown"), requestId: "request", send }), null);
  assert.equal(calls, 0);
});

test("失败响应拒绝或falsy异常保留原请求聚合，不伪造已接受", () => {
  for (const reject of [false, true]) {
    const original = failure();
    const rejected = { accepted: false, reason: "queue_full", readyState: 1 };
    const result = dispatchWorkspaceApiRequestFailure({ error: original, requestId: "request", send() {
      if (reject) throw undefined;
      return rejected;
    } });
    assert.equal(result?.response, "rejected");
    assert.equal(result?.error.cause, original);
    assert.equal(result?.error.errors[0], original);
    if (reject) assert.equal(result?.error.errors[1], undefined);
    else assert.equal(result?.error.errors[1], rejected);
  }
});

test("真实WS请求诊断失败返回500且连接存活，下一工作区请求仍可读取", { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-api-transport-"));
  const directory = path.join(root, "workspace");
  fs.mkdirSync(directory);
  const db = openClientDb({ dbPath: path.join(root, "app.db") });
  db.workspaces.upsert({ id: "workspace", title: "工作区", path: directory });
  db.forWorkspace("workspace").orchIntakes.create = () => { throw undefined; };
  db.writeWorkspaceLog = () => { throw 0; };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let connected!: (socket: import("ws").WebSocket) => void;
  const connection = new Promise<import("ws").WebSocket>(resolve => { connected = resolve; });
  server.once("connection", connected);
  const failures: unknown[] = [], responses: any[] = [], applicationErrors: string[] = [];
  let receive!: () => void;
  const nextResponse = () => new Promise<void>(resolve => { receive = resolve; });
  const ctx = { db, clientId: "client", workspaces: new Map([["workspace", directory]]),
    send: (message: unknown) => transport.sendJson(message) } as ApiHandlerContext;
  const transport = new WsTransport({ url: `ws://127.0.0.1:${address.port}`, headers: {}, events: {
    onOpen() { transport.markReady(); }, onClose() {},
    async onMessage(data) { await handleApiRequest(ctx, data as ApiRequestMessage); },
    onMessageFailure(failed) {
      failures.push(failed.error);
      const request = failed.data as ApiRequestMessage;
      const result = dispatchWorkspaceApiRequestFailure({ error: failed.error, requestId: request.id,
        send: message => transport.sendJson(message) });
      assert.equal(result?.response, "accepted");
      return { handled: true };
    },
    onError(message) { applicationErrors.push(message); },
  } });
  t.after(async () => {
    await transport.stopAndDrain();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  transport.start();
  const socket = await connection;
  socket.on("message", data => { responses.push(JSON.parse(String(data))); receive(); });
  let received = nextResponse();
  socket.send(JSON.stringify({ t: "api.req", id: "bad-request", method: "orch.intakes.create", body: { workspaceId: "workspace", intake: { title: "需求" } } }));
  await received;
  assert.equal(responses[0].status, 500);
  assert.ok(failures[0] instanceof WorkspaceApiRequestFailure);
  assert.deepEqual(failures[0].errors, [undefined, 0]);
  received = nextResponse();
  socket.send(JSON.stringify({ t: "api.req", id: "next-request", method: "orch.intakes.list", body: { workspaceId: "workspace" } }));
  await received;
  assert.equal(responses[1].status, 200);
  assert.equal(responses[1].body.ok, true);
  assert.equal(failures.length, 1);
  assert.deepEqual(applicationErrors, []);
});

/** 使用index实际callback和ACK装配闭包，避免另写测试分发逻辑漏掉内层catch。 */
function indexAckCallbacks(dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["assertWorkspacePersistenceAvailable", "applyConversationEventAck", "applyRawEventAck"];
  const declarations = new Map<string, ts.VariableDeclaration>();
  let events: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) declarations.set(node.name.text, node);
    if (ts.isNewExpression(node) && node.expression.getText(tree) === "WsTransport") {
      const options = node.arguments?.[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(tree) === "events");
        if (property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) events = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.equal(declarations.size, names.length); assert.ok(events);
  const functions = ["persistConversationEventAck", "persistRawEventAck", "isUrgentThreadTouchEvent", "persistThreadPrefsEvent",
    "applyTurnIndexEvent", "applyFileChangeIndexEvent", "maybeKickThreadQueueAtActiveTurnBoundary"];
  const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? ""));
  assert.equal(selected.length, functions.length);
  const callbacks = events.properties.filter(item => ts.isPropertyAssignment(item) && ["onMessage", "onMessageFailure"].includes(item.name.getText(tree)));
  assert.equal(callbacks.length, 2);
  const code = ts.transpileModule(`${selected.map(node => node.getText(tree)).join("\n")}\n${names.map(name => `const ${declarations.get(name)!.getText(tree)};`).join("\n")}
    const callbacks = { ${callbacks.map(node => node.getText(tree)).join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ...callbacks, setShuttingDown() { shutdownRequested = true; } };`)(...Object.values(dependencies)) as {
    onMessage(data: unknown, meta: { bytes: number }): Promise<void>; onMessageFailure(failure: unknown): { handled: true } | void;
    setShuttingDown(): void;
  };
}

for (const kind of ["raw", "canonical", "touch"] as const) {
  test(`真实WS ${kind}失败ACK经过index实际callback隔离A，B保留共享缓冲合同且显式恢复`, { timeout: 30_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-ack-assembly-"));
    const db = openClientDb({ dbPath: path.join(root, "app.db") }), workspaces = new Map<string, string>();
    for (const id of ["a", "b"]) {
      const directory = path.join(root, id); fs.mkdirSync(directory); workspaces.set(id, directory);
      db.workspaces.upsert({ id, title: id, path: directory });
      db.forWorkspace(id).threads.create({ id: "thread", workspaceId: id, title: id, engine: "claude" });
    }
    const conversationEventAckBuffer = createConversationEventAckBuffer(db, { flushDelayMs: 60_000 });
    const rawEventAckBuffer = createRawEventAckBuffer(db, { flushDelayMs: 60_000 });
    const threadTouchBuffer = createThreadTouchBuffer(db, { flushDelayMs: 60_000 });
    const buffer = kind === "raw" ? rawEventAckBuffer : kind === "canonical" ? conversationEventAckBuffer : threadTouchBuffer;
    const event = (workspaceId: string, seq: number): any => ({ schema: 1, seq, ts: seq, workspaceId, threadId: "thread", engine: "claude",
      ...(kind === "raw" ? { source: "claude.stream-json.stdout", data: {}, handled: true, action: "mapped", emittedTypes: [] }
        : { type: "system.notice", payload: { level: "info", text: "ACK evidence" } }) });
    if (kind === "touch") threadTouchBuffer.enqueue("thread", 1, { workspaceId: "a" });
    else (buffer as typeof rawEventAckBuffer).enqueue(event("a", 1));
    const repo = kind === "raw" ? db.forWorkspace("a").rawEvents : kind === "canonical" ? db.forWorkspace("a").conversationEvents : db.forWorkspace("a").threads;
    const original = false;
    const failure = t.mock.method(repo as any, kind === "touch" ? "touchMany" : "appendEnvelopes", () => { throw original; });
    let retained: unknown;
    assert.throws(() => buffer.flush(), error => { retained = error; return (error as Error).cause === original; });
    const applicationLogs: unknown[] = [], transportErrors: string[] = [], shutdowns: unknown[] = [], dispatchFailures: unknown[] = [];
    for (const level of ["info", "warn", "error"] as const) t.mock.method(logger, level, (...args) => { applicationLogs.push(args); });
    let observed!: () => void;
    const nextDispatch = () => new Promise<void>(resolve => { observed = resolve; });
    const callbacks = indexAckCallbacks({ db, workspaces, conversationEventAckBuffer, rawEventAckBuffer, threadTouchBuffer,
      serverMessageConnectionGeneration: 1, shutdownRequested: false, desktopLifecycle: null,
      eventFlowMonitor: { recordAck() {} }, safeParse: (data: unknown) => typeof data === "string" ? JSON.parse(data) : data,
      serverMessageHelloReadyFence: { async waitUntilReady() { return true; }, isCurrent() { return true; } },
      threads: new ThreadStore(), runtime: { activeTurnByThreadId: new Map(), pendingCodexProviderTurnByClientTurnId: new Map() },
      orchEngine: { forWorkspace() { return this; } }, queueDispatcher: { forWorkspace() { return this; } },
      markReminderDirty() {}, reminderCompletionNotifier: {}, rollbackEvidenceFence: { acceptAck() {}, rejectAck() {} },
      indexCodexProviderTurnStarted, applyThreadStartedBinding, prepareThreadStartedBindingAck, resolveThreadStartedBinding,
      extractThreadPrefsPatchFromConversationEvent, mergeThreadPrefs,
      handleTransportMessageFailure(...args: unknown[]) { shutdowns.push(args); },
      dispatchWorkspaceApiRequestFailure, isWorkspaceApiRequestFailure: (error: unknown) => error instanceof WorkspaceApiRequestFailure,
      logClientStep(...args: unknown[]) { applicationLogs.push(args); }, logger,
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    let connected!: (socket: import("ws").WebSocket) => void;
    const connection = new Promise<import("ws").WebSocket>(resolve => { connected = resolve; }); server.once("connection", connected);
    const transport = new WsTransport({ url: `ws://127.0.0.1:${address.port}`, headers: {}, events: {
      onOpen() { transport.markReady(); }, onClose() {},
      async onMessage(data, meta) { try { await callbacks.onMessage(data, meta); } finally { observed(); } },
      onMessageFailure(failed) { dispatchFailures.push(failed.error); return callbacks.onMessageFailure(failed); },
      onError(message) { transportErrors.push(message); },
    } });
    t.after(async () => {
      failure.mock.restore(); await transport.stopAndDrain();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      conversationEventAckBuffer.dispose(); rawEventAckBuffer.dispose(); threadTouchBuffer.dispose(); db.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    transport.start(); const socket = await connection;
    let dispatched = nextDispatch(); socket.send(JSON.stringify({ t: kind === "raw" ? "raw.eventAck" : "conversation.eventAck", event: event("a", 2) }));
    await dispatched; await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(shutdowns, []); assert.deepEqual(transportErrors, []); assert.deepEqual(applicationLogs, []);
    assert.equal(dispatchFailures[0], retained); assert.equal(buffer.getPendingCount(), 1);
    dispatched = nextDispatch(); socket.send(JSON.stringify({ t: kind === "raw" ? "raw.eventAck" : "conversation.eventAck", event: event("b", 3) }));
    await dispatched; await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(shutdowns, []); assert.equal(dispatchFailures.length, 1); assert.equal(buffer.getPendingCount(), 2);
    assert.equal(db.forWorkspace("b").conversationEvents.listByThread("thread", { limit: 10 }).length, 0);
    assert.equal(db.forWorkspace("b").rawEvents.pageByThread("thread", { limit: 10 }).events.length, 0);
    callbacks.setShuttingDown();
    dispatched = nextDispatch(); socket.send(JSON.stringify({ t: kind === "raw" ? "raw.eventAck" : "conversation.eventAck", event: event("a", 4) }));
    await dispatched; await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(shutdowns, []); assert.deepEqual(applicationLogs, []); assert.deepEqual(transportErrors, []);
    assert.equal(dispatchFailures[1], retained); assert.equal(buffer.getPendingCount(), 2);
    failure.mock.restore(); conversationEventAckBuffer.flush(); rawEventAckBuffer.flush(); threadTouchBuffer.flush();
    assert.equal(buffer.getPendingCount(), 0); assert.doesNotThrow(() => buffer.assertNoFailure("a"));
    if (kind === "raw") assert.deepEqual(db.forWorkspace("b").rawEvents.pageByThread("thread", { limit: 10 }).events.map(item => item.seq), [3]);
    else assert.deepEqual(db.forWorkspace("b").conversationEvents.listByThread("thread", { limit: 10 }).map(item => item.seq), [3]);
    const logs = fs.readdirSync(path.join(workspaces.get("a")!, ".codeflowai")).filter(name => /^client-.*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(workspaces.get("a")!, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean));
    assert.equal(logs.length, 1); assert.equal(JSON.parse(logs[0]!).workspaceId, "a");
  });
}
