import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ConversationEventEnvelope, DesktopClientHealth, DesktopEvent } from "@codeflowai/shared";
import { createDesktopLifecycle } from "../src/runtime/desktopLifecycle.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";

/** 用真实生命周期及发送队列观测跨进程负载。 */
async function fixture(handler?: Parameters<ReturnType<typeof createDesktopLifecycle>["ready"]>[2]) {
  const sent: any[] = [];
  const channel = Object.assign(new EventEmitter(), {
    send(message: unknown, callback: (error: Error | null) => void) { sent.push(message); callback(null); },
  });
  const lifecycle = createDesktopLifecycle(channel, "process-events", { abortStartup() { assert.fail("unexpected startup abort"); } });
  const health: DesktopClientHealth = { protocolVersion: 1, clientVersion: "test", database: "ready", dbSchemaVersion: CLIENT_DB_SCHEMA_VERSION };
  await lifecycle.ready(() => {}, () => health, handler);
  return { sent, channel, lifecycle };
}

/** 构造已提交事件，正文使用可检索标记。 */
function reasoning(seq: number): Extract<DesktopEvent, { t: "conversation.event" }> {
  return { t: "conversation.event", event: { schema: 1, seq, ts: 1, workspaceId: "workspace", threadId: "thread", engine: "codex",
    type: "item.reasoning.delta", payload: { itemId: "reasoning", delta: "PRIVATE_PROCESS_BODY" } } as ConversationEventEnvelope };
}

test("运行中折叠过程不发送正文，高频变更合并到最新版本且排空不丢通知", async () => {
  const { sent, lifecycle } = await fixture();
  for (let seq = 1; seq <= 100; seq++) lifecycle.publishEvent(reasoning(seq));
  await lifecycle.drainRequests();
  const events = sent.filter(message => message.t === "desktop.event");
  assert.deepEqual(events.map(message => message.event), [{ t: "conversation.changed", workspaceId: "workspace", threadId: "thread", version: 100 }]);
  assert.ok(!JSON.stringify(sent).includes("PRIVATE_PROCESS_BODY"));
});

test("正文和终态直接发送，终态之前刷新同会话的过程版本", async () => {
  const { sent, lifecycle } = await fixture();
  lifecycle.publishEvent(reasoning(1));
  const event = { ...reasoning(2).event, type: "turn.completed", payload: { turnId: "turn" } } as ConversationEventEnvelope;
  lifecycle.publishEvent({ t: "conversation.event", event });
  await lifecycle.drainRequests();
  assert.deepEqual(sent.filter(message => message.t === "desktop.event").map(message => message.event), [
    { t: "conversation.changed", workspaceId: "workspace", threadId: "thread", version: 1 },
    { t: "conversation.event", event },
  ]);
});

test("桥接拒绝缺少归属的版本通知", async () => {
  const { lifecycle } = await fixture();
  assert.throws(() => lifecycle.publishEvent({ t: "conversation.changed", workspaceId: "", threadId: "thread", version: 2 } as DesktopEvent), /DESKTOP_EVENT_INVALID/);
  await lifecycle.drainRequests();
});

test("排空期间已接纳请求产生的过程版本也必须发送", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => {
    await gate;
    f.lifecycle.publishEvent(reasoning(9));
    return { status: 200, body: { ok: true } };
  });
  f.channel.emit("message", { t: "desktop.api.req", requestId: "process-events", id: "pending-api", request: { method: "runtime.info" } });
  const draining = f.lifecycle.drainRequests();
  release();
  await draining;
  assert.equal(f.sent.filter(message => message.t === "desktop.event").at(-1)?.event.version, 9);
});
