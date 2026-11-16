import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { ScheduledTask, ClientScheduledTaskReportRequestBody } from "@codeflowai/shared";
import { createDesktopCloudAccount } from "../src/runtime/desktopCloudAccount.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { openClientDb } from "../src/db/clientDb.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";

/** 同进程真实云握手、HTTP、SQLite和脚本，仅Server业务响应受控。 */
async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-d08-scheduler-transport-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const task: ScheduledTask = { id: "task", ownerUserId: "A", clientId: "desktop", deviceId: "installation",
    clientNameSnapshot: "desktop", deviceLabelSnapshot: null, name: "账号脚本", description: null,
    taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "cmd" : "sh", command: "echo transport-ok", contextWorkspaceId: null },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 10_000,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastSyncAt: null, createdAt: 1, updatedAt: 1 };
  const requests: { url: string; token: string; body: any }[] = [], sockets = new Map<string, WebSocket>();
  let respond: ((request: http.IncomingMessage, response: http.ServerResponse, body: any) => void) | undefined;
  const server = http.createServer((req, res) => {
    let text = ""; req.on("data", chunk => { text += String(chunk); });
    req.on("end", () => {
      const body = JSON.parse(text); requests.push({ url: req.url!, token: req.headers.authorization!, body });
      assert.equal(body.clientId, "desktop"); assert.equal(body.deviceId, "installation");
      if (respond) { respond(req, res, body); return; }
      if (body.run?.status === "success") {
        const owner = { serverOrigin: origin, ownerUserId: body.run.taskId === task.id ? task.ownerUserId : "unexpected", clientId: "desktop", deviceId: "installation" };
        assert.equal(db.getAccountScheduledTaskRun(body.run.id, owner)?.run.status, "success", "终态必须在HTTP ACK前耐久保存");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, serverNow: Date.now(), ...(req.url?.endsWith("/sync") ? { tasks: [task] } : {}) }));
    });
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, req) => { sockets.set(req.headers.authorization!, socket); socket.on("message", () => {}); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cloud = createDesktopCloudAccount({ clientId: "desktop", deviceId: "installation", clientVersion: "test", timeoutMs: 3_000,
    getWorkspaceIds: () => [],
    onHello: async () => {}, onMessage: async () => {}, onOwnerInvalidated() {}, onFailure(error) { throw error; } });
  /** 只用真实WS hello确认当前账号；测试无固定握手睡眠。 */
  const link = async (userId: string): Promise<void> => {
    const pending = cloud.link({ serverOrigin: origin, sessionToken: "token-" + userId });
    const deadline = Date.now() + 2_000;
    while (!sockets.has("Bearer token-" + userId)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    sockets.get("Bearer token-" + userId)!.send(JSON.stringify({ t: "client.helloAck", serverNow: Date.now(), keyHash: "key-" + userId,
      userSummary: { userId, email: userId + "@test.local", fullName: userId, accountRole: "personal_normal", enterpriseId: null },
      accountSessionId: "session-" + userId, capabilities: { desktopLocalRuntimeV1: true, localCanonicalRelayOnDemandV1: true } }));
    await pending;
  };
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "desktop", apiKey: "forbidden-legacy-key", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "installation", apiContext: { db, workspaces: new Map() } as ApiHandlerContext,
    captureAccountContext: () => { const owner = cloud.getOwner(); assert.ok(owner); return { ...owner, clientId: "desktop", deviceId: "installation", assertCurrent() { cloud.assertOwner(owner); } }; },
    requestAccountTasks: (owner, action, payload, requestId) => {
      owner.assertCurrent();
      const current = cloud.getOwner(); assert.ok(current);
      return cloud.requestScheduledTasks(current, action, payload, requestId);
    },
  });
  t.after(async () => {
    const results = await Promise.allSettled([scheduler.stopAndDrain(), cloud.stopAndDrain()]);
    for (const socket of sockets.values()) socket.terminate();
    await new Promise<void>((resolve, reject) => ws.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); fs.rmSync(root, { recursive: true });
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "scheduler transport fixture cleanup failed");
  });
  return { db, scheduler, cloud, origin, requests, task, link,
    /** 控制本隔离Server响应，不替换真实传输或SQLite持久化。 */
    setResponder(value: typeof respond) { respond = value; } };
}

test("desktop scheduler account transport sync and script receipts use the trusted session and persist before ACK", async t => {
  const f = await fixture(t); await f.link("A");
  const result = await f.scheduler.runNow(f.task.id);
  assert.equal(result.status, "success"); assert.match(result.outputExcerpt!, /transport-ok/u);
  const reports = f.requests.filter(item => item.url.endsWith("/report")).map(item => item.body as ClientScheduledTaskReportRequestBody);
  assert.ok(reports.some(item => item.nextRuns?.[0]?.taskId === f.task.id));
  assert.deepEqual(reports.filter(item => item.run).map(item => item.run!.status), ["running", "success"]);
  assert.ok(f.requests.every(item => item.token === "Bearer token-A"));
  assert.equal(f.db.getAccountScheduledTaskRun(result.id, { serverOrigin: f.origin, ownerUserId: "A", clientId: "desktop", deviceId: "installation" })?.run.reportSettlement, "acknowledged");
});

test("desktop scheduler account transport rejects the old response and can sync the next account", { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.link("A");
  let entered!: () => void, response: http.ServerResponse | undefined;
  const received = new Promise<void>(resolve => { entered = resolve; });
  f.setResponder((_req, res) => { response = res; res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,'); entered(); });
  const pending = f.scheduler.sync("old-A"), rejected = assert.rejects(pending);
  try { await Promise.race([received, pending]); await f.cloud.unlink(); await rejected; }
  finally { response?.end(); }
  f.setResponder(undefined); f.task.ownerUserId = "B"; await f.link("B"); await f.scheduler.sync("new-B");
  assert.ok(f.requests.slice(1).every(item => item.token === "Bearer token-B"));
});

test("desktop scheduler account transport fails explicitly without falling back to the legacy key", async t => {
  const f = await fixture(t); await f.link("A");
  f.setResponder((_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end('{"ok":false}'); });
  await assert.rejects(f.scheduler.sync("server-unavailable"));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.token, "Bearer token-A");
  f.setResponder(undefined);
  await f.scheduler.sync("server-recovered");
  assert.ok(f.requests.every(item => item.token === "Bearer token-A"));
});
