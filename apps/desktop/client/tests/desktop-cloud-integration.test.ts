import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConversationEventEnvelope, DesktopApiRequest, DesktopApiResponse } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { createLocalEventDatabaseIndex } from "../src/runtime/localEventIndex.js";
import { createLocalEventPersistence, type LocalEventBatch } from "../src/runtime/localEventPersistence.js";

/** 有界等待实际观察结果，超时必须让联调失败。 */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const result = read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("DESKTOP_CLOUD_INTEGRATION_TIMEOUT");
}

test("real desktop runtime links A/B with same-account RPC and keeps session tokens out of config", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d15-runtime-"));
  await fs.writeFile(path.join(root, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const builtin = path.join(root, "package"); await fs.mkdir(builtin);
  await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), path.join(builtin, "defaultAssetBundle.v1.json"));
  const relayRequests: string[] = [];
  const server = http.createServer((req, res) => {
    relayRequests.push(req.url ?? "");
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, code: "RELAY_MISCONFIGURED" }));
  });
  const wss = new WebSocketServer({ server });
  const sockets = new Map<string, WebSocket>(); const received: any[] = [];
  const catalog = { schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [{ catalogItemId: "codex-default", engine: "codex", providerId: "openai", providerLabel: "OpenAI", modelId: "gpt-6.1-sol", displayName: "Codex", description: "test", inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native", transportModelId: null, fastTaskModelId: null, subagentModelId: null }] };
  catalog.rows.push({ ...catalog.rows[0]!, catalogItemId: "claude-default", engine: "claude", providerId: "anthropic", providerLabel: "Anthropic", modelId: "claude-fable-5", displayName: "Claude" });
  const summary = (id: string) => ({ userId: id, email: `${id}@example.test`, fullName: id, phone: "", avatarUrl: null, accountRole: "personal_normal", status: "active", enterpriseId: null, enterpriseName: null });
  wss.on("connection", (socket, req) => {
    const id = req.headers.authorization!.slice(7); sockets.set(id, socket);
    socket.on("message", raw => {
      const message = JSON.parse(String(raw)); received.push({ id, message });
      if (message.t === "client.hello") socket.send(JSON.stringify({ t: "client.helloAck", keyHash: `hash-${id}`, serverNow: Date.now(), accountSessionId: `session-${id}`, userSummary: summary(id), engineModelCatalog: { ...catalog, configVersion: id === "A" ? 7 : 1 }, capabilities: { desktopLocalRuntimeV1: true, localCanonicalRelayV1: true, localCanonicalRelayOnDemandV1: true, remoteDataDemandV1: true } }));
      if (message.t === "engine.models.applied") {
        socket.send(JSON.stringify({ t: "engine.models.appliedConfirmed", ...message.ack }));
        socket.send(JSON.stringify({ t: "conversation.event.relayScopes", scopes: [] }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
  const parentId = crypto.randomUUID();
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], { execArgv: ["--conditions=development", "--import", "tsx"], env: { ...env, CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEFLOWAI_VERSION: "1.0.0", CODEFLOWAI_DESKTOP_REQUEST_ID: parentId, CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: builtin, CODEFLOWAI_SERVER_WS: `ws://127.0.0.1:${port}/ws/client`, CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(root, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: path.join(root, "client.db"), CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: any[] = []; let stderr = ""; let stdout = ""; let exitCode: number | null | undefined; let completed = false;
  child.on("message", message => { messages.push(message); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); }); child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.on("exit", code => { exitCode = code; });
  t.after(async () => {
    const failures: unknown[] = [];
    try { if (exitCode === undefined) { child.send({ t: "desktop.shutdown", requestId: parentId }); await waitFor(() => exitCode === undefined ? undefined : true); assert.equal(exitCode, 0, stderr); } }
    catch (error) { failures.push(error); child.kill(); }
    for (const socket of sockets.values()) socket.terminate();
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (completed && failures.length === 0) await fs.rm(root, { recursive: true, force: true });
    else t.diagnostic(`retained evidence: ${root}`);
    if (failures.length) throw new AggregateError(failures, "desktop integration cleanup failed");
  });
  await waitFor(() => { if (exitCode !== undefined) throw new Error(`early exit ${exitCode}: ${stderr}; ${stdout}`); return messages.find(message => message.t === "desktop.ready"); });
  assert.equal(messages.some(message => message.t.startsWith("desktop.orchAsset.")), false);
  /** 真实 IPC 请求只接受本父进程关联和精确请求 ID。 */
  const request = async (value: DesktopApiRequest): Promise<DesktopApiResponse> => {
    const id = crypto.randomUUID(); child.send({ t: "desktop.api.req", requestId: parentId, id, request: value });
    return (await waitFor(() => messages.find(message => message.t === "desktop.api.res" && message.id === id))).response;
  };
  const project = path.join(root, "private-project"); await fs.mkdir(project);
  const created = await request({ method: "workspaces.upsert", body: { title: "本机私有项目", path: project } }); assert.equal(created.status, 200, JSON.stringify(created.body));
  const workspaceId = (created.body as any).workspace.id;
  const linkedA = await request({ method: "runtime.cloudAccount.link", body: { serverOrigin: `http://127.0.0.1:${port}`, sessionToken: "A" } });
  assert.equal(linkedA.status, 200, JSON.stringify(linkedA.body)); assert.equal((linkedA.body as any).account.userSummary.userId, "A");
  assert.equal((linkedA.body as any).account.status, "linked");
  assert.equal((linkedA.body as any).account.builtInRelayErrorCode, "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED");
  assert.equal(relayRequests.filter(url => url.startsWith("/api/client/relay/key/ensure")).length, 1);
  assert.equal((await request({ method: "engineKeys.upsert", body: { workspaceId, engine: "codex", providerId: "openai", label: "local", apiKey: "isolated-test-key" } })).status, 200);
  assert.deepEqual(received.find(item => item.message.t === "client.hello").message.workspaceIds, [workspaceId]);
  sockets.get("A")!.send(JSON.stringify({ t: "api.req", id: "private-list", method: "threads.list", path: "/api/threads", body: { workspaceId } }));
  const listedThreads = await waitFor(() => received.find(item => item.message.id === "private-list")); assert.equal(listedThreads.message.status, 200);
  sockets.get("A")!.send(JSON.stringify({ t: "api.req", id: "account-control", method: "runtime.cloudAccount.status", path: "/test", body: {} }));
  const denied = await waitFor(() => received.find(item => item.message.id === "account-control")); assert.equal(denied.message.status, 403);
  assert.equal(JSON.stringify(received).includes("本机私有项目"), false);
  assert.equal((await request({ method: "runtime.cloudAccount.unlink" })).status, 200);
  const linkedB = await request({ method: "runtime.cloudAccount.link", body: { serverOrigin: `http://127.0.0.1:${port}`, sessionToken: "B" } });
  assert.equal(linkedB.status, 200, JSON.stringify(linkedB.body)); assert.equal((linkedB.body as any).account.userSummary.userId, "B");
  const listed = await request({ method: "workspaces.list" }); assert.equal((listed.body as any).workspaces[0].id, workspaceId);
  const config = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
  assert.equal(config.apiKey, ""); assert.equal(config.sessionToken, undefined);
  assert.equal(received.filter(item => ["raw.event", "conversation.event", "conversation.event.relay", "orchestration.event"].includes(item.message.t)).length, 0);
  child.send({ t: "desktop.shutdown", requestId: parentId });
  await waitFor(() => exitCode === undefined ? undefined : true); assert.equal(exitCode, 0, stderr);
  const logFiles = await fs.readdir(path.join(root, "logs"));
  const logs = (await Promise.all(logFiles.map(name => fs.readFile(path.join(root, "logs", name), "utf8")))).join("\n");
  const cloudErrors = logs.split(/\r?\n/u).filter(line => line.includes("DESKTOP_BUILTIN_AUTO_ENABLE_FAILED"));
  assert.equal(cloudErrors.length, 1, "auto Key failure is logged once at its handling boundary");
  for (const field of ["requestId", "clientId", "accountSessionId", "userId", "providerId", "rootCause", "RELAY_MISCONFIGURED"]) assert.ok(cloudErrors[0]!.includes(field), field);
  completed = true;
});

for (const pendingType of ["turn.started", "turn.completed"] as const) {
  test(`real desktop restart recovers pending ${pendingType} before finalizing dangling turns`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-pending-runtime-"));
    const workspaceId = "pending:workspace", threadId = "pending-thread", turnId = "pending-turn";
    const workspacePath = path.join(root, "workspace"), dbPath = path.join(root, "client.db");
    await fs.mkdir(workspacePath);
    await fs.writeFile(path.join(root, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
    const builtin = path.join(root, "package");
    await fs.mkdir(builtin);
    await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), path.join(builtin, "defaultAssetBundle.v1.json"));
    const seed = openClientDb({ dbPath, localCanonicalEvents: true });
    let pendingSeq: number;
    try {
      seed.workspaces.upsert({ id: workspaceId, title: "恢复测试", path: workspacePath });
      const scoped = seed.forWorkspace(workspaceId);
      scoped.threads.create({ id: threadId, workspaceId, engine: "claude", title: "恢复测试" });
      const apply = createLocalEventDatabaseIndex();
      const persistence = createLocalEventPersistence({ db: seed,
        /** 种子仅使用普通聊天的 canonical 索引，原始引擎事件不属于本场景。 */
        applyConversation(event) { apply(scoped, { t: "conversation.event", event }); },
        applyRaw() { throw new Error("UNEXPECTED_RESTART_SEED_RAW_EVENT"); },
      });
      const started: LocalEventBatch = { batchId: "seed-started", workspaceId, ownerGeneration: 0, turnId,
        events: [{ t: "conversation.event", event: { ts: Date.now(), workspaceId, threadId, engine: "claude", type: "turn.started", payload: { turnId } } }] };
      if (pendingType === "turn.completed") {
        persistence.persistBatch(started);
        assert.equal(scoped.turns.get(turnId)?.status, "started");
      }
      const pending: LocalEventBatch = pendingType === "turn.started" ? started : {
        batchId: "seed-completed", workspaceId, ownerGeneration: 0, turnId,
        events: [{ t: "conversation.event", event: { ts: Date.now(), workspaceId, threadId, engine: "claude", type: "turn.completed", payload: { turnId } } }],
      };
      const receipt = persistence.commitBatch(pending);
      pendingSeq = receipt.messages[0]!.event.seq;
      assert.equal(receipt.indexedCount, 0);
      assert.equal(persistence.readPendingBatch(workspaceId)?.batchId, pending.batchId);
      if (pendingType === "turn.started") assert.equal(scoped.turns.get(turnId), null);
    } finally { seed.close(); }
    await fs.writeFile(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }), "utf8");

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") && !/API_KEY|TOKEN|SECRET|PASSWORD/iu.test(key)));
    const parentId = crypto.randomUUID();
    const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
      execArgv: ["--conditions=development", "--import", "tsx"],
      env: { ...env, CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
        CODEFLOWAI_VERSION: "1.0.0", CODEFLOWAI_CLIENT_ID: "pending", CODEFLOWAI_DESKTOP_REQUEST_ID: parentId,
        CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: builtin, CODEFLOWAI_SERVER_WS: "ws://127.0.0.1:1/ws/client",
        CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ id: workspaceId, path: workspacePath, label: "恢复测试" }]),
        CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(root, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: dbPath,
        CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages: any[] = [];
    let stdout = "", stderr = "", exitCode: number | null | undefined, completed = false;
    child.on("message", message => { messages.push(message); });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("exit", code => { exitCode = code; });
    t.after(async () => {
      try {
        if (exitCode === undefined) {
          child.send({ t: "desktop.shutdown", requestId: parentId });
          await waitFor(() => exitCode === undefined ? undefined : true);
        }
        assert.equal(exitCode, 0, `${stderr}\n${stdout}`);
      } catch (error) {
        child.kill();
        t.diagnostic(`retained evidence: ${root}`);
        throw error;
      }
      if (completed) await fs.rm(root, { recursive: true, force: true });
      else t.diagnostic(`retained evidence: ${root}`);
    });
    await waitFor(() => {
      if (exitCode !== undefined) throw new Error(`early exit ${exitCode}: ${stderr}; ${stdout}`);
      return messages.find(message => message.t === "desktop.ready");
    });
    /** 恢复期间允许明确的未就绪响应；每次请求关联独立 ID，最终必须进入可读态。 */
    const readHistory = async (): Promise<DesktopApiResponse> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const id = crypto.randomUUID();
        child.send({ t: "desktop.api.req", requestId: parentId, id, request: { method: "threads.load", body: { workspaceId, threadId } } });
        const response: DesktopApiResponse = (await waitFor(() => {
          if (exitCode !== undefined) throw new Error(`early exit ${exitCode}: ${stderr}; ${stdout}`);
          return messages.find(message => message.t === "desktop.api.res" && message.id === id);
        })).response;
        if (response.status !== 503) return response;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("DESKTOP_RESTART_HISTORY_NOT_READY");
    };
    const response = await readHistory();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const events = (response.body as { events: ConversationEventEnvelope[] }).events;
    assert.equal((response.body as { running: unknown }).running, null);
    const terminal = events.filter(event => event.type === "turn.completed" || event.type === "turn.error").at(-1)!;
    assert.ok(terminal, JSON.stringify(events));
    assert.equal(terminal.type, pendingType === "turn.started" ? "turn.error" : "turn.completed");
    if (terminal.type === "turn.error") {
      assert.equal(terminal.payload.code, "client_restarted");
      assert.ok(terminal.seq > pendingSeq);
    } else assert.equal(terminal.seq, pendingSeq);
    assert.equal(events.some(event => event.type === "turn.error" && event.seq > terminal.seq), false);
    const published = messages.filter(message => message.t === "desktop.event" && message.event.t === "conversation.event")
      .map(message => message.event.event as ConversationEventEnvelope);
    assert.ok(published.some(event => event.seq === pendingSeq && event.type === pendingType), JSON.stringify(messages));
    assert.ok(published.some(event => event.seq === terminal.seq && event.type === terminal.type), JSON.stringify(messages));
    assert.ok(messages.findIndex(message => message.t === "desktop.ready") < messages.findIndex(message => message.t === "desktop.event"));
    child.send({ t: "desktop.shutdown", requestId: parentId });
    await waitFor(() => exitCode === undefined ? undefined : true);
    assert.equal(exitCode, 0, `${stderr}\n${stdout}`);
    const restored = openClientDb({ dbPath, existingOnly: true, localCanonicalEvents: true });
    try {
      const scoped = restored.forWorkspace(workspaceId, { readonly: true });
      assert.equal(scoped.turns.get(turnId)?.status, pendingType === "turn.started" ? "error" : "completed");
      assert.equal(scoped.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key='local_event_batch_pending'").get()?.count, 0);
      const receipts = scoped.db.prepare("SELECT value FROM meta WHERE key LIKE 'local_event_batch:%'").all() as { value: string }[];
      assert.ok(receipts.length > 0);
      assert.equal(receipts.filter(row => JSON.parse(row.value).confirmed !== true).length, 0);
    } finally { restored.close(); }
    const logFiles = await fs.readdir(path.join(root, "logs"));
    const logs = (await Promise.all(logFiles.map(name => fs.readFile(path.join(root, "logs", name), "utf8")))).join("\n");
    assert.doesNotMatch(`${logs}\n${stderr}\n${stdout}`, /LOCAL_EVENT_RECOVERY_FAILED|DESKTOP_EVENT_NOT_READY/u);
    completed = true;
  });
}

test("real desktop restart isolates corrupt workspace receipts while healthy workspace APIs remain available", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-isolated-recovery-"));
  const dbPath = path.join(root, "client.db"), builtin = path.join(root, "package");
  const badWorkspaceId = "isolated:bad", healthyWorkspaceId = "isolated:healthy";
  const badThreadId = "isolated-bad-thread", healthyThreadId = "isolated-healthy-thread";
  const badPath = path.join(root, "bad"), healthyPath = path.join(root, "healthy");
  await fs.mkdir(builtin);
  await fs.mkdir(badPath);
  await fs.mkdir(healthyPath);
  await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), path.join(builtin, "defaultAssetBundle.v1.json"));
  await fs.writeFile(path.join(root, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const seed = openClientDb({ dbPath, localCanonicalEvents: true });
  try {
    seed.workspaces.upsert({ id: badWorkspaceId, title: "坏回执项目", path: badPath });
    seed.workspaces.upsert({ id: healthyWorkspaceId, title: "正常项目", path: healthyPath });
    const bad = seed.forWorkspace(badWorkspaceId), healthy = seed.forWorkspace(healthyWorkspaceId);
    bad.threads.create({ id: badThreadId, workspaceId: badWorkspaceId, engine: "claude", title: "不可用历史" });
    healthy.threads.create({ id: healthyThreadId, workspaceId: healthyWorkspaceId, engine: "claude", title: "正常历史" });
    bad.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("local_event_batch_pending", "missing-receipt");
    const persistence = createLocalEventPersistence({ db: seed, applyConversation() {}, applyRaw() {} });
    persistence.commitBatch({ batchId: "healthy-pending-started", workspaceId: healthyWorkspaceId, ownerGeneration: 0, turnId: "healthy-pending-turn",
      events: [{ t: "conversation.event", event: { ts: Date.now(), workspaceId: healthyWorkspaceId, threadId: healthyThreadId,
        engine: "claude", type: "turn.started", payload: { turnId: "healthy-pending-turn" } } }] });
  } finally { seed.close(); }
  await fs.writeFile(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }), "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") && !/API_KEY|TOKEN|SECRET|PASSWORD/iu.test(key)));
  const parentId = crypto.randomUUID();
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
    execArgv: ["--conditions=development", "--import", "tsx"],
    env: { ...env, CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      CODEFLOWAI_VERSION: "1.0.0", CODEFLOWAI_CLIENT_ID: "isolated", CODEFLOWAI_DESKTOP_REQUEST_ID: parentId,
      CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: builtin, CODEFLOWAI_SERVER_WS: "ws://127.0.0.1:1/ws/client",
      CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ id: badWorkspaceId, path: badPath, label: "坏回执项目" }, { id: healthyWorkspaceId, path: healthyPath, label: "正常项目" }]),
      CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(root, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: dbPath,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: any[] = [];
  let stdout = "", stderr = "", exitCode: number | null | undefined, completed = false;
  child.on("message", message => { messages.push(message); });
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  child.on("exit", code => { exitCode = code; });
  t.after(async () => {
    try {
      if (exitCode === undefined) {
        child.send({ t: "desktop.shutdown", requestId: parentId });
        await waitFor(() => exitCode === undefined ? undefined : true);
      }
      assert.ok(exitCode === 0 || exitCode === 1, `${stderr}\n${stdout}`);
    } catch (error) { child.kill(); t.diagnostic(`retained evidence: ${root}`); throw error; }
    if (completed) await fs.rm(root, { recursive: true, force: true });
    else t.diagnostic(`retained evidence: ${root}`);
  });
  await waitFor(() => {
    if (exitCode !== undefined) throw new Error(`early exit ${exitCode}: ${stderr}; ${stdout}`);
    return messages.find(message => message.t === "desktop.ready");
  });
  /** IPC请求等待启动接续结束，工作区故障必须作为失败响应暴露，不能终止进程。 */
  const request = async (value: DesktopApiRequest): Promise<DesktopApiResponse> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const id = crypto.randomUUID();
      child.send({ t: "desktop.api.req", requestId: parentId, id, request: value });
      const response: DesktopApiResponse = (await waitFor(() => {
        if (exitCode !== undefined) throw new Error(`early exit ${exitCode}: ${stderr}; ${stdout}`);
        return messages.find(message => message.t === "desktop.api.res" && message.id === id);
      })).response;
      if (response.status !== 503 || (response.body as { code?: string }).code !== "DESKTOP_RUNTIME_NOT_READY") return response;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("ISOLATED_WORKSPACE_RECOVERY_NOT_READY");
  };
  const history = await request({ method: "threads.load", body: { workspaceId: healthyWorkspaceId, threadId: healthyThreadId } });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const events = (history.body as { events: ConversationEventEnvelope[] }).events;
  assert.ok(events.some(event => event.type === "turn.started" && event.payload.turnId === "healthy-pending-turn"), JSON.stringify(events));
  assert.ok(events.some(event => event.type === "turn.error" && event.payload.code === "client_restarted"), JSON.stringify(events));
  const created = await request({ method: "threads.create", body: { workspaceId: healthyWorkspaceId, threadId: "healthy-created", engine: "claude", title: "故障隔离后仍可写入" } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await request({ method: "threads.load", body: { workspaceId: healthyWorkspaceId, threadId: "healthy-created" } })).status, 200);
  const unavailable = await request({ method: "threads.load", body: { workspaceId: badWorkspaceId, threadId: badThreadId } });
  assert.equal(unavailable.status, 500, JSON.stringify(unavailable.body));
  assert.equal((unavailable.body as { ok?: boolean }).ok, false);
  assert.equal(exitCode, undefined, "单工作区失败不能终止Client");
  assert.equal((await request({ method: "threads.load", body: { workspaceId: healthyWorkspaceId, threadId: healthyThreadId } })).status, 200);
  child.send({ t: "desktop.shutdown", requestId: parentId });
  await waitFor(() => exitCode === undefined ? undefined : true);
  assert.ok(exitCode === 0 || exitCode === 1, `${stderr}\n${stdout}`);
  const logFiles = await fs.readdir(path.join(root, "logs"));
  const logs = (await Promise.all(logFiles.map(name => fs.readFile(path.join(root, "logs", name), "utf8")))).join("\n");
  const recoveryErrors = logs.split(/\r?\n/u).filter(line => line.includes("LOCAL_EVENT_RECOVERY_FAILED"));
  assert.equal(recoveryErrors.length, 1, recoveryErrors.join("\n"));
  for (const field of [badWorkspaceId, "requestId", "rootCause", "LOCAL_EVENT_BATCH_RECEIPT_INVALID"]) assert.ok(recoveryErrors[0]!.includes(field), field);
  if (exitCode === 1) assert.ok(logs.split(/\r?\n/u).some(line => line.includes("shutdown.event_pipeline_close")
    && line.includes("LOCAL_EVENT_BATCH_RECEIPT_INVALID")), "非零退出必须关联已确认的坏工作区保存失败");
  assert.doesNotMatch(logs, /CLIENT_STARTUP_FATAL|DESKTOP_STARTUP_RECOVERY_FAILED/u);
  completed = true;
});
