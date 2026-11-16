import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

/** 只等待真实协议事实；退出或超时都保留明确失败。 */
async function observe<T>(read: () => T | undefined, alive: () => void): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    alive(); const result = read(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("CLIENT_ON_DEMAND_TIMEOUT");
}

test("普通Client无订阅本地保存，需求握手后仅上传新事件，撤销后停止", { timeout: 45_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-daemon-demand-")), workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const received: any[] = [];
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
    req.url === "/api/client-db/startup-context" ? { ok: true, accountNamespace: "acct_demand_fixture" } : { ok: true, tasks: [], serverNow: Date.now() })));
  const wss = new WebSocketServer({ server }); let socket: WebSocket | undefined;
  const row = { catalogItemId: "codex-default", engine: "codex", providerId: "openai", providerLabel: "OpenAI", modelId: "gpt-6.1-sol", displayName: "Codex", description: "test", inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native", transportModelId: null, fastTaskModelId: null, subagentModelId: null };
  wss.on("connection", current => {
    socket = current;
    current.on("message", raw => {
      const message = JSON.parse(String(raw)); received.push(message);
      if (message.t === "client.hello") current.send(JSON.stringify({ t: "client.helloAck", keyHash: "fixture", serverNow: Date.now(), accountSessionId: "fixture-session",
        userSummary: { userId: "fixture-user", email: "fixture@example.test", fullName: "fixture", phone: "", avatarUrl: null, accountRole: "personal_normal", status: "active", enterpriseId: null, enterpriseName: null },
        engineModelCatalog: { schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [row, { ...row, catalogItemId: "claude-default", engine: "claude", providerId: "anthropic", providerLabel: "Anthropic", modelId: "claude-fable-5" }] },
        capabilities: { localCanonicalRelayV1: true, localCanonicalRelayOnDemandV1: true, remoteDataDemandV1: true } }));
      if (message.t === "engine.models.applied") current.send(JSON.stringify({ t: "engine.models.appliedConfirmed", ...message.ack }));
      if (message.t === "conversation.event.relay") current.send(JSON.stringify({ t: "conversation.eventRelayAck", delivery: message.delivery, seqs: message.events.map((event: any) => event.seq) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") && !/TOKEN|PASSWORD|SECRET|API_KEY/iu.test(key)));
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
    execArgv: ["--conditions=development", "--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...env, CODEFLOWAI_API_KEY: "isolated-fixture", CODEFLOWAI_CLIENT_ID: "demand", CODEFLOWAI_VERSION: "1.0.0",
      CODEFLOWAI_SERVER_WS: `ws://127.0.0.1:${port}/ws/client`, CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(root, "config.json"),
      CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ id: "workspace", path: workspace, label: "fixture" }]),
      CODEFLOWAI_CLIENT_DB_PATH: path.join(root, "client.db"), CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs"),
      CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude") },
  });
  let output = "", exitCode: number | null | undefined;
  child.stdout!.on("data", value => { output += String(value); }); child.stderr!.on("data", value => { output += String(value); });
  child.once("exit", code => { exitCode = code; });
  const alive = (): void => { if (exitCode !== undefined) throw new Error(`CLIENT_EXITED:${exitCode}:${output}`); };
  let completed = false;
  t.after(async () => {
    if (exitCode === undefined) child.kill();
    socket?.terminate(); await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (completed) await fs.rm(root, { recursive: true, force: true }); else t.diagnostic(`evidence: ${root}\n${output}`);
  });
  const hello = await observe(() => received.find(message => message.t === "client.hello"), alive);
  assert.equal(hello.capabilities.localCanonicalRelayOnDemandV1, true);
  await observe(() => received.find(message => message.t === "engine.models.applied"), alive);
  let requestSeq = 0;
  /** 实际WS请求使用独立身份，响应必须对应当前请求且成功。 */
  const request = async (method: string, body: Record<string, unknown> = {}, expectedStatus = 200) => {
    const id = `request-${++requestSeq}`;
    socket!.send(JSON.stringify({ t: "api.req", id, method, path: "/fixture", body }));
    const response = await observe(() => received.find(message => message.t === "api.res" && message.id === id), alive);
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body)); return response.body;
  };
  const workspaceId = hello.workspaceIds[0];
  await request("threads.create", { workspaceId, threadId: "first", engine: "claude", title: "无人查看" });
  const firstId = "first";
  const firstHistory = await request("threads.load", { workspaceId, threadId: firstId });
  assert.ok(firstHistory.events.some((event: any) => event.type === "thread.started"));
  assert.equal(received.filter(message => ["conversation.event", "raw.event", "conversation.event.relay"].includes(message.t)).length, 0);
  const scope = { kind: "personal", userId: "fixture-user", enterpriseId: null, clientId: "demand", workspaceId };
  const demand = { requestId: "subscribe", demandId: "demand-1", generation: 1, scope, kind: "conversation", recipientUserIds: ["fixture-user"] };
  socket!.send(JSON.stringify({ t: "conversation.event.relayScopes", scopes: [scope] }));
  socket!.send(JSON.stringify({ t: "conversation.event.relayDemand", demand, active: true }));
  const ready = await observe(() => received.find(message => message.t === "conversation.event.relayReady"), alive);
  assert.equal(ready.ready.ok, true, JSON.stringify(ready));
  await request("threads.create", { workspaceId, threadId: "second", engine: "claude", title: "正在查看" });
  await observe(() => received.find(message => message.t === "conversation.event.relay" && message.events.some((event: any) => event.threadId === "second")), alive);
  assert.equal(received.filter(message => message.t === "conversation.event.relay").flatMap(message => message.events).some(event => event.threadId === firstId), false);
  socket!.send(JSON.stringify({ t: "conversation.event.relayDemand", demand, active: false }));
  await request("threads.create", { workspaceId, threadId: "third", engine: "claude", title: "已离开" });
  await request("threads.load", { workspaceId, threadId: "third" });
  assert.equal(received.filter(message => message.t === "conversation.event.relay").flatMap(message => message.events).some(event => event.threadId === "third"), false);
  await request("threads.clear", { workspaceId, threadId: "third" });
  await request("threads.load", { workspaceId, threadId: "third" });
  await request("clientDb.cleanup.start", { clientId: "demand", inactiveBefore: Date.now() - 1 }, 202);
  let cleanup: any;
  const cleanupDeadline = Date.now() + 10_000;
  do {
    const summary = await request("clientDb.cleanup.status", { clientId: "demand" });
    cleanup = summary.storage.cleanup;
    assert.notEqual(cleanup.status, "failed", JSON.stringify(cleanup));
    if (cleanup.status !== "completed") await new Promise(resolve => setTimeout(resolve, 10));
  } while (cleanup.status !== "completed" && Date.now() < cleanupDeadline);
  assert.equal(cleanup.status, "completed");
  assert.ok(cleanup.processedThreadCount > 0, "必须实际清理一个会话，不能用空任务证明零发送");
  assert.equal(received.filter(message => message.t === "thread.history.cleaned").length, 0, "无人订阅时删除失效仅本地保存，不能走legacy旁路");
  assert.equal(received.some(message => message.t === "conversation.event" || message.t === "raw.event"), false);
  await request("client.exit", { clientId: "demand" });
  await observe(() => exitCode === undefined ? undefined : true, () => {});
  assert.equal(exitCode, 0, output); completed = true;
});
