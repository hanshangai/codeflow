import test from "node:test";
import assert from "node:assert/strict";
import { formatClientStartupProgress, isClientConnectionReady, parseClientStartupSnapshot, redactClientStartupText, safeClientServerUrl } from "../../apps/desktop/client/src/startup/clientStartupStatus.ts";

const ready = { supervisorRunning: true, clientRunning: true, status: "running", initialConnection: "succeeded",
  snapshot: { stage: "ready" as const, updatedAt: new Date().toISOString(), clientId: "client-a", serverUrl: "wss://example.com/ws/client" } };

test("Client readiness requires a live worker, active handshake and ready stage together", () => {
  assert.equal(isClientConnectionReady(ready), true);
  for (const patch of [{ supervisorRunning: false }, { clientRunning: false }, { initialConnection: "pending" },
    { initialConnection: "failed" }, { snapshot: null }, ...["starting", "blocked", "cooldown", "restarting", "failed", "migrating"].map(status => ({ status }))]) {
    assert.equal(isClientConnectionReady({ ...ready, ...patch }), false);
  }
  for (const stage of ["connecting", "authenticating", "synchronizing", "disconnected", "stopping", "failed"] as const) {
    assert.equal(isClientConnectionReady({ ...ready, snapshot: { ...ready.snapshot, stage } }), false);
  }
});

test("startup display only contains safe server addresses and redacts keys", () => {
  assert.equal(safeClientServerUrl("wss://user:secret@example.com/ws/client?key=secret#secret"), "wss://example.com/ws/client");
  assert.equal(safeClientServerUrl("file:///secret"), null);
  assert.doesNotMatch(redactClientStartupText("Bearer secret codeflowai_1234567890abcdef1234 https://u:secret@example.com/?key=secret"), /secret|1234567890abcdef/);
  assert.match(formatClientStartupProgress("connecting", 5600), /5 秒.*正在连接服务器/);
});

test("legacy, corrupt and unknown startup states never become ready", () => {
  for (const value of [null, {}, { stage: "ready" }, { ...ready.snapshot, stage: "__proto__" }, { ...ready.snapshot, updatedAt: "invalid" }]) {
    assert.equal(parseClientStartupSnapshot(value), null);
  }
  assert.deepEqual(parseClientStartupSnapshot(ready.snapshot), ready.snapshot);
});

test("资产诊断文本移除认证头、JSON 秘密字段和数据库凭据", () => {
  const text = redactClientStartupText('sync failed password=plain-secret; {"access_token":"json-secret","apiKey":"key-secret"}; Basic basic-secret; postgresql://user:db-secret@db.invalid/app');
  assert.match(text, /sync failed/);
  assert.doesNotMatch(text, /plain-secret|json-secret|key-secret|basic-secret|db-secret/);
  assert.doesNotMatch(redactClientStartupText('authorization: "Bearer header-secret", cookie: "session=cookie-secret"'), /header-secret|cookie-secret/);
  assert.equal(redactClientStartupText("HTTPS://user:url-secret@example.test/sync?key=url-key#url-fragment"), "https://example.test/sync");
});
