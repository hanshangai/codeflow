import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WsTransport,
  type WsCloseInfo,
  type WsDeliveryFailure,
  type WsInboundMessageFailure,
  type WsSendJsonResult,
  type WsTransportEvents,
} from "../../apps/desktop/client/src/transport/wsTransport.ts";

type SendCallback = (error?: Error) => void;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

class FakeSocket extends EventEmitter {
  readyState = WS_CONNECTING;
  bufferedAmount = 0;
  paused = false;
  pauseCount = 0;
  resumeCount = 0;
  readonly sent: string[] = [];
  maxConcurrentSends = 0;
  private activeSends = 0;
  private readonly callbacks: SendCallback[] = [];
  private nextSynchronousSendError: Error | null = null;

  /** 模拟底层连接建立。 */
  open(): void {
    assert.equal(this.readyState, WS_CONNECTING);
    this.readyState = WS_OPEN;
    this.emit("open");
  }

  /** 记录一次 send，并把完成时机交给测试显式控制。 */
  send(data: string, callback: SendCallback): void {
    assert.equal(this.readyState, WS_OPEN);
    if (this.nextSynchronousSendError) {
      const error = this.nextSynchronousSendError;
      this.nextSynchronousSendError = null;
      throw error;
    }
    this.activeSends += 1;
    this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this.activeSends);
    this.sent.push(String(data));
    this.callbacks.push(callback);
  }

  /** 让下一次底层 send 在交接前同步抛错。 */
  throwOnNextSend(error: Error): void {
    this.nextSynchronousSendError = error;
  }

  /** 完成最早的 send callback。 */
  completeNext(error?: Error): void {
    const callback = this.callbacks.shift();
    assert.ok(callback, "不存在待完成的 send callback");
    this.activeSends -= 1;
    callback(error);
  }

  /** 返回当前尚未完成的 send 数。 */
  pendingSendCount(): number {
    return this.callbacks.length;
  }

  /** 模拟收到一条 Server JSON 消息。 */
  receive(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }

  /** 模拟 ws.pause 入站背压。 */
  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  /** 模拟 ws.resume 解除入站背压。 */
  resume(): void {
    this.paused = false;
    this.resumeCount += 1;
  }

  /** 模拟本地 close。 */
  close(code = 1000, reason = ""): void {
    this.remoteClose(code, reason);
  }

  /** 模拟底层连接终止。 */
  terminate(): void {
    this.remoteClose(1006, "terminated");
  }

  /** 模拟远端关闭并保留尚未回调的 send。 */
  remoteClose(code: number, reason: string): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}

test("durable relay and cleanup frames are connection scoped while legacy relay stays queued", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  t.after(() => harness.transport.stop());
  const first = harness.sockets[0]!;
  first.open();
  first.completeNext();
  harness.transport.markReady();
  harness.transport.sendJson({ t: "raw.event", tag: "held-in-flight" });
  const delivery = { deliveryId: "delivery-a", scope: { bindingId: "binding-a" } };
  const relay = harness.transport.sendJson({ t: "conversation.event.relay", events: [], delivery });
  const cleanup = harness.transport.sendJson({ t: "thread.history.cleaned", throughSeq: 20, delivery });
  const legacy = harness.transport.sendJson({ t: "conversation.event.relay", events: [], tag: "legacy" });
  first.remoteClose(1006, "network reset");
  assert.equal(relay.accepted, false);
  assert.equal(cleanup.accepted, false);
  assert.equal(legacy.accepted, true);
  assert.equal(harness.deliveryFailures.filter((failure) => ["conversation.event.relay", "thread.history.cleaned"].includes(failure.messageType ?? "")).length, 2);
  t.mock.timers.tick(2_000);
  const second = harness.sockets[1]!;
  second.open();
  second.completeNext();
  harness.transport.markReady();
  drainSocket(second);
  assert.deepEqual(readMessages(second).map((message) => message.tag ?? message.t), ["client.hello", "legacy"]);
});

test("durable relay rejects an inactive connection instead of buffering remote scope state", (t) => {
  const harness = createHarness();
  t.after(() => harness.transport.stop());
  const result = harness.transport.sendJson({ t: "conversation.event.relay", events: [], delivery: { deliveryId: "scope-only" } });
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /current ready connection/);
});

type Harness = {
  transport: WsTransport;
  sockets: FakeSocket[];
  closes: WsCloseInfo[];
  deliveryFailures: WsDeliveryFailure[];
  diagnostics: string[];
  errors: string[];
  messageFailures: WsInboundMessageFailure[];
  inboundMessages: Array<Record<string, unknown>>;
  helloResults: WsSendJsonResult[];
};

/** 创建不自动 open 的可控传输测试夹具。 */
function createHarness(
  queueLimits?: { maxMessages?: number; maxBytes?: number },
  inboundLimits?: {
    batchMessages?: number;
    dispatchBudgetMs?: number;
    highWaterMessages?: number;
    highWaterBytes?: number;
    now?: () => number;
  },
  onMessage?: (data: unknown) => void | Promise<void>,
  onMessageFailure?: WsTransportEvents["onMessageFailure"],
  onDiagnostic?: WsTransportEvents["onDiagnostic"],
): Harness {
  const sockets: FakeSocket[] = [];
  const closes: WsCloseInfo[] = [];
  const deliveryFailures: WsDeliveryFailure[] = [];
  const diagnostics: string[] = [];
  const errors: string[] = [];
  const messageFailures: WsInboundMessageFailure[] = [];
  const inboundMessages: Array<Record<string, unknown>> = [];
  const helloResults: WsSendJsonResult[] = [];
  let transport!: WsTransport;
  transport = new WsTransport({
    url: "ws://transport.test/client",
    headers: { Authorization: "Bearer test" },
    queueLimits,
    inboundLimits,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as never;
    },
    events: {
      onOpen: () => {
        helloResults.push(transport.sendJson({ t: "client.hello", clientId: "client-test", workspaceIds: [] }));
      },
      onClose: (info) => closes.push(info),
      onMessage: onMessage ?? ((data) => {
        inboundMessages.push(
          typeof data === "string" ? JSON.parse(data) as Record<string, unknown> : data as Record<string, unknown>,
        );
      }),
      onMessageFailure: (failure) => { messageFailures.push(failure); return onMessageFailure?.(failure); },
      onError: (message) => errors.push(message),
      onDiagnostic: (level, message) => { diagnostics.push(message); onDiagnostic?.(level, message); },
      onDeliveryFailure: (failure) => deliveryFailures.push(failure),
    },
  });
  transport.start();
  return {
    transport,
    sockets,
    closes,
    deliveryFailures,
    diagnostics,
    errors,
    messageFailures,
    inboundMessages,
    helloResults,
  };
}

/** 打开首个 socket，并按需完成 hello/helloAck。 */
function openSocket(harness: Harness, markReady = true, index = 0): FakeSocket {
  const socket = harness.sockets[index];
  assert.ok(socket, `socket ${index} 尚未创建`);
  socket.open();
  assert.deepEqual(readTypes(socket), ["client.hello"]);
  socket.completeNext();
  if (markReady) harness.transport.markReady();
  return socket;
}

/** 完成 socket 上由传输层串行发起的所有 send。 */
function drainSocket(socket: FakeSocket, limit = 100_000): void {
  let completed = 0;
  while (socket.pendingSendCount() > 0) {
    socket.completeNext();
    completed += 1;
    assert.ok(completed <= limit, `send 数超过测试上限 ${limit}`);
  }
}

/** 解析 fake socket 已收到的 JSON 帧。 */
function readMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((encoded) => JSON.parse(encoded) as Record<string, unknown>);
}

/** 提取 fake socket 已收到的消息类型。 */
function readTypes(socket: FakeSocket): string[] {
  return readMessages(socket).map((message) => String(message.t));
}

/** 等待一次 setImmediate 调度轮次。 */
function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 读取夹具当前已分发消息的 seq，避免断言对可变数组做错误窄化。 */
function readInboundSeqs(harness: Harness): unknown[] {
  return harness.inboundMessages.map((message) => message.seq);
}

test("入站消息严格 FIFO 分批分发且不暂停公共 Server WS", async (t) => {
  const harness = createHarness(undefined, {
    batchMessages: 2,
    highWaterMessages: 3,
    highWaterBytes: 1024 * 1024,
  });
  t.after(() => harness.transport.stop());
  const socket = openSocket(harness);
  for (let seq = 1; seq <= 5; seq += 1) socket.receive({ t: "raw.eventAck", seq });

  assert.deepEqual(harness.inboundMessages, []);
  assert.equal(socket.pauseCount, 0);
  assert.ok(harness.diagnostics.some((message) => message.includes('"socketPaused":false')));
  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2]);
  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2, 3, 4]);
  assert.equal(socket.resumeCount, 0);
  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2, 3, 4, 5]);
});

test("入站分发达到 8ms 时间片后让出且保持 FIFO", async (t) => {
  let now = 0;
  const harness = createHarness(undefined, {
    batchMessages: 100,
    dispatchBudgetMs: 8,
    highWaterMessages: 100,
    highWaterBytes: 1024 * 1024,
    now: () => {
      now += 4;
      return now;
    },
  });
  t.after(() => harness.transport.stop());
  const socket = openSocket(harness);
  for (let seq = 1; seq <= 5; seq += 1) socket.receive({ t: "raw.eventAck", seq });

  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2]);
  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2, 3, 4]);
  await nextImmediate();
  assert.deepEqual(readInboundSeqs(harness), [1, 2, 3, 4, 5]);
  assert.equal(socket.pauseCount, 0);
});

test("入站压力快照包含类型、最老等待和活跃异步 handler", async (t) => {
  const invoked: number[] = [];
  const releases: Array<() => void> = [];
  const harness = createHarness(undefined, {
    batchMessages: 2,
    highWaterMessages: 10,
    highWaterBytes: 1024 * 1024,
  }, async (data) => {
    const message = data as { seq: number };
    invoked.push(message.seq);
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  t.after(() => harness.transport.stop());
  const socket = openSocket(harness);
  socket.receive({ t: "raw.eventAck", seq: 1 });
  socket.receive({ t: "conversation.eventAck", seq: 2 });
  socket.receive({ t: "raw.eventAck", seq: 3 });

  const queued = harness.transport.getInboundPressureSnapshot();
  assert.equal(queued.queuedMessages, 3);
  assert.equal(queued.messageTypes["raw.eventAck"]?.messages, 2);
  assert.equal(queued.messageTypes["conversation.eventAck"]?.messages, 1);
  await nextImmediate();
  assert.deepEqual(invoked, [1, 2]);
  const active = harness.transport.getInboundPressureSnapshot();
  assert.equal(active.activeHandlers, 2);
  assert.equal(active.queuedMessages, 1);
  releases.splice(0).forEach((release) => release());
  await Promise.resolve();
  await nextImmediate();
  releases.splice(0).forEach((release) => release());
  await nextImmediate();
  assert.deepEqual(invoked, [1, 2, 3]);
  assert.equal(harness.transport.getInboundPressureSnapshot().activeHandlers, 0);
});

test("异步入站 handler rejection 显式上报且不形成未处理 Promise", async (t) => {
  const harness = createHarness(undefined, undefined, async () => {
    throw new Error("injected async handler failure");
  });
  t.after(() => harness.transport.stop());
  const socket = openSocket(harness);
  socket.receive({ t: "api.req", id: "request-fail" });

  await nextImmediate();
  await Promise.resolve();

  assert.equal(harness.messageFailures.length, 1);
  assert.equal(harness.messageFailures[0]?.messageType, "api.req");
  assert.match(String((harness.messageFailures[0]?.error as Error)?.message), /injected async handler failure/);
  assert.ok(harness.errors.some((message) => message.includes("ws inbound handler failed")));
});

test("旧连接已排队的 helloAck 在断线后不再交给上层", async () => {
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.open();
  first.receive({ t: "client.helloAck" });
  first.remoteClose(1006, "network reset after helloAck receive");

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.inboundMessages.some((message) => message.t === "client.helloAck"), false);
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded stale client.helloAck")));
  harness.transport.stop();
});

test("旧连接只丢弃连接级命令并继续交付 ACK 与定价更新", async () => {
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.open();
  first.receive({ t: "client.helloAck" });
  first.receive({ t: "api.req", id: "stale-api" });
  first.receive({ t: "sharedWorkspace.command", requestId: "stale-command" });
  first.receive({ t: "engine.models.updated", catalog: { configVersion: 8 } });
  first.receive({ t: "raw.eventAck", seq: 7 });
  first.receive({ t: "relay.pricing.updated", version: 9 });
  first.remoteClose(1006, "network reset with queued messages");

  await nextImmediate();

  assert.deepEqual(harness.inboundMessages.map((message) => message.t), ["raw.eventAck", "relay.pricing.updated"]);
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded stale client.helloAck")));
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded stale api.req")));
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded stale sharedWorkspace.command")));
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded stale engine.models.updated")));
  harness.transport.stop();
});

test("停止传输前同步排空已接收的入站消息", () => {
  const harness = createHarness(undefined, {
    batchMessages: 1,
    highWaterMessages: 100,
    highWaterBytes: 1024 * 1024,
  });
  const socket = openSocket(harness);
  for (let seq = 1; seq <= 5; seq += 1) socket.receive({ t: "raw.eventAck", seq });

  harness.transport.stop();

  assert.deepEqual(harness.inboundMessages.map((message) => message.seq), [1, 2, 3, 4, 5]);
  assert.ok(harness.diagnostics.some((message) => message.includes("draining received inbound messages before stop count=5")));
});

test("stopAndDrain 等待全部异步入站处理并汇总失败", async () => {
  const releases: Array<() => void> = [];
  const harness = createHarness(undefined, undefined, async (data) => {
    const message = data as { seq: number };
    await new Promise<void>((resolve) => releases.push(resolve));
    if (message.seq === 1) throw new Error("injected drain failure");
  });
  const socket = openSocket(harness);
  socket.receive({ t: "raw.eventAck", seq: 1 });
  socket.receive({ t: "raw.eventAck", seq: 2 });
  await nextImmediate();

  let settled = false;
  const draining = harness.transport.stopAndDrain().finally(() => {
    settled = true;
  });
  releases[0]?.();
  await Promise.resolve();
  assert.equal(settled, false, "仍有 handler 执行时不得提前完成 drain");
  releases[1]?.();

  await assert.rejects(draining, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /failed during stop count=1/);
    assert.equal(error.errors.length, 1);
    assert.match(String((error.errors[0] as Error)?.message), /injected drain failure/);
    return true;
  });
  assert.equal(harness.transport.getInboundPressureSnapshot().activeHandlers, 0);
  assert.equal(harness.messageFailures.length, 1);
});

test("明确处理的工作区失败不触发应用副本或读取未知错误getter", async t => {
  let reads = 0;
  const original = Object.defineProperty(new Error("private"), "message", { get() { reads++; throw new Error("unsafe error getter"); } });
  const harness = createHarness(undefined, undefined, async () => { throw original; }, () => ({ handled: true }));
  t.after(() => harness.transport.stop());
  openSocket(harness).receive({ t: "api.req", id: "handled" });
  await nextImmediate(); await Promise.resolve();
  assert.equal(harness.messageFailures[0]?.error, original); assert.equal(reads, 0);
  assert.deepEqual(harness.errors, []);
  await harness.transport.stopAndDrain();
});

for (const asynchronous of [false, true]) {
  test(`入站${asynchronous ? "异步" : "同步"}失败回调的falsy拒绝保留到原owner排空`, async t => {
    const handlerFailure = false, callbackFailure = undefined;
    const harness = createHarness(undefined, undefined, () => {
      if (asynchronous) return Promise.reject(handlerFailure);
      throw handlerFailure;
    }, () => { throw callbackFailure; });
    t.after(() => harness.transport.stop());
    openSocket(harness).receive({ t: "api.req", id: "callback-rejected" });
    await nextImmediate(); await Promise.resolve();
    assert.equal(harness.transport.getInboundPressureSnapshot().activeHandlers, 0);
    assert.deepEqual(harness.errors, []);
    await assert.rejects(harness.transport.stopAndDrain(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
      const retained = error.errors[0]; assert.ok(retained instanceof AggregateError);
      assert.deepEqual(retained.errors, [handlerFailure, callbackFailure]); assert.equal(retained.cause, handlerFailure); return true;
    });
    await harness.transport.stopAndDrain();
  });
}

test("void失败回调保留原通知行为，多个排空者均观察未消费的原失败", async t => {
  const original = new Error("RETAINED_INBOUND_FAILURE");
  const harness = createHarness(undefined, undefined, async () => { throw original; });
  t.after(() => harness.transport.stop());
  openSocket(harness).receive({ t: "api.req", id: "legacy" });
  await nextImmediate(); await Promise.resolve();
  assert.ok(harness.errors.some(message => message.includes("ws inbound handler failed")));
  const assertFailure = (error: unknown) => error instanceof AggregateError && error.errors[0] === original;
  await Promise.all([assert.rejects(harness.transport.stopAndDrain(), assertFailure), assert.rejects(harness.transport.stopAndDrain(), assertFailure)]);
  await harness.transport.stopAndDrain();
});

for (const diagnosticPhase of ["draining", "stopped"] as const) {
  test(`停止${diagnosticPhase}诊断失败仍关闭socket并等待真实入站尾链`, async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const diagnosticFailure = new Error(`STOP_${diagnosticPhase}_DIAGNOSTIC_FAILED`);
    let throws = 0;
    const harness = createHarness(undefined, undefined, async () => { await pending; }, undefined, (_level, message) => {
      if (message.startsWith(`ws transport ${diagnosticPhase}`) && throws++ === 0) throw diagnosticFailure;
    });
    const socket = openSocket(harness);
    socket.receive({ t: "raw.eventAck", seq: 1 });
    if (diagnosticPhase === "stopped") await nextImmediate();
    let finished = false;
    const draining = harness.transport.stopAndDrain().finally(() => { finished = true; });
    const rejected = assert.rejects(draining, error => error === diagnosticFailure);
    try {
      await Promise.resolve();
      assert.equal(finished, false); assert.equal(socket.readyState, WS_CLOSED);
      assert.equal(harness.transport.getInboundPressureSnapshot().activeHandlers, 1);
    } finally { release(); await rejected; socket.close(); }
    assert.equal(harness.transport.getInboundPressureSnapshot().activeHandlers, 0);
  });
}

test("停止诊断和入站失败一起保留，单个关闭错误不覆盖在途原拒绝", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const diagnosticFailure = false, handlerFailure = undefined;
  const harness = createHarness(undefined, undefined, async () => { await pending; throw handlerFailure; }, undefined, (_level, message) => {
    if (message.startsWith("ws transport stopped")) throw diagnosticFailure;
  });
  const socket = openSocket(harness); socket.receive({ t: "raw.eventAck", seq: 1 }); await nextImmediate();
  const draining = harness.transport.stopAndDrain();
  const rejected = assert.rejects(draining, error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [diagnosticFailure, handlerFailure]);
    assert.equal(error.cause, diagnosticFailure); return true;
  });
  release(); await rejected; assert.equal(socket.readyState, WS_CLOSED);
});

test("10746 条入站洪峰保持 FIFO 且不暂停共享 socket", async (t) => {
  const harness = createHarness(undefined, {
    batchMessages: 100,
    highWaterMessages: 2_000,
    highWaterBytes: 32 * 1024 * 1024,
  });
  t.after(() => harness.transport.stop());
  const socket = openSocket(harness);
  const rawCount = 10_746;
  for (let seq = 1; seq <= rawCount; seq += 1) {
    socket.receive({ t: "raw.eventAck", seq });
    if (seq % 1_000 === 0) socket.receive({ t: "api.req", id: `rpc-${seq}` });
  }

  const expectedCount = rawCount + Math.floor(rawCount / 1_000);
  for (let turn = 0; harness.inboundMessages.length < expectedCount && turn < 200; turn += 1) {
    await nextImmediate();
  }
  assert.equal(harness.inboundMessages.length, expectedCount);
  assert.deepEqual(
    harness.inboundMessages.filter((message) => message.t === "raw.eventAck").map((message) => message.seq),
    Array.from({ length: rawCount }, (_, index) => index + 1),
  );
  assert.equal(socket.pauseCount, 0);
  assert.equal(socket.resumeCount, 0);
  assert.ok(harness.diagnostics.some((message) => message.includes('"phase":"high_water"')));
});

test("hello 优先且 helloAck 前不发送业务帧，512KiB 内交互响应走 priority", () => {
  const harness = createHarness();
  const socket = harness.sockets[0];
  assert.ok(socket);
  socket.open();

  const largeBody = "x".repeat(513 * 1024);
  const mediumBody = "m".repeat(300 * 1024);
  const results = [
    harness.transport.sendJson({ t: "sharedWorkspace.route.result", tag: "large-result", body: largeBody }),
    harness.transport.sendJson({ t: "raw.event", tag: "raw-1" }),
    harness.transport.sendJson({ t: "api.res", tag: "medium-api", body: mediumBody }),
    harness.transport.sendJson({ t: "sharedWorkspace.route.ack", tag: "small-ack" }),
    harness.transport.sendJson({ t: "sharedWorkspace.route.result", tag: "medium-result", body: mediumBody }),
    harness.transport.sendJson({ t: "api.res", tag: "large-api", body: largeBody }),
  ];
  assert.ok(results.every((result) => result.accepted));
  assert.deepEqual(readTypes(socket), ["client.hello"]);

  socket.completeNext();
  assert.deepEqual(readTypes(socket), ["client.hello"], "hello callback 后仍须等待 helloAck");
  harness.transport.markReady();
  drainSocket(socket);

  assert.deepEqual(
    readMessages(socket).map((message) => message.tag ?? message.t),
    ["client.hello", "medium-api", "small-ack", "medium-result", "raw-1", "large-result", "large-api"],
  );
  assert.equal(socket.maxConcurrentSends, 1);
  harness.transport.stop();
});

test("evidence 使用独立 FIFO，不被更早入队的大 bulk 帧阻塞", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  const largeBody = "b".repeat(513 * 1024);
  harness.transport.sendJson({ t: "sharedWorkspace.route.result", tag: "bulk-1", body: largeBody });
  harness.transport.sendJson({ t: "raw.event", evidenceSeq: 1 });
  harness.transport.sendJson({ t: "conversation.event", evidenceSeq: 2 });
  harness.transport.sendJson({ t: "conversation.event.relay", evidenceSeq: 3 });
  harness.transport.sendJson({ t: "orchestration.event", evidenceSeq: 4 });
  harness.transport.sendJson({ t: "raw.event", evidenceSeq: 5 });
  harness.transport.sendJson({ t: "conversation.event", evidenceSeq: 6 });

  harness.transport.markReady();
  drainSocket(socket);
  const business = readMessages(socket).slice(1);
  assert.deepEqual(
    business.map((message) => message.evidenceSeq ?? message.tag),
    [1, 2, 3, 4, "bulk-1", 5, 6],
  );
  assert.deepEqual(
    business.filter((message) => message.evidenceSeq).map((message) => message.evidenceSeq),
    [1, 2, 3, 4, 5, 6],
  );
  harness.transport.stop();
});

test("模型目录应用 ACK 可在 hello 就绪前发送并由确认帧释放业务队列", async () => {
  let harness!: Harness;
  harness = createHarness(undefined, undefined, (data) => {
    const message = typeof data === "string"
      ? JSON.parse(data) as Record<string, unknown>
      : data as Record<string, unknown>;
    if (message.t === "engine.models.appliedConfirmed") harness.transport.markReady();
  });
  const socket = openSocket(harness, false);
  const business = harness.transport.sendJson({ t: "api.req", id: "queued-before-catalog-confirmed" });
  const receipt = harness.transport.sendJson({
    t: "engine.models.applied",
    ack: {
      operationId: "hello-catalog-3",
      configVersion: 3,
      digest: "a".repeat(64),
      appliedAt: 1,
    },
  });

  assert.equal(business.accepted, true);
  assert.equal(receipt.accepted, true);
  assert.deepEqual(readTypes(socket), ["client.hello", "engine.models.applied"]);
  socket.completeNext();
  assert.deepEqual(
    readTypes(socket),
    ["client.hello", "engine.models.applied"],
    "Server 确认目录回执前不得释放业务队列",
  );

  socket.receive({
    t: "engine.models.appliedConfirmed",
    operationId: "hello-catalog-3",
    configVersion: 3,
    digest: "a".repeat(64),
  });
  await nextImmediate();
  drainSocket(socket);
  assert.deepEqual(readTypes(socket), ["client.hello", "engine.models.applied", "api.req"]);
  harness.transport.stop();
});

test("模型目录暂停 ACK 可在 hello 就绪前发送且不提前释放业务队列", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  const business = harness.transport.sendJson({ t: "api.req", id: "queued-before-dispatch-pause" });
  const receipt = harness.transport.sendJson({
    t: "engine.models.dispatchPaused",
    ack: {
      operationId: "catalog-pause-4",
      configVersion: 4,
      digest: "b".repeat(64),
      pausedAt: 2,
    },
  });

  assert.equal(business.accepted, true);
  assert.equal(receipt.accepted, true);
  assert.deepEqual(readTypes(socket), ["client.hello", "engine.models.dispatchPaused"]);
  socket.completeNext();
  assert.deepEqual(
    readTypes(socket),
    ["client.hello", "engine.models.dispatchPaused"],
    "暂停回执完成后仍须等待 hello 激活完成",
  );
  harness.transport.stop();
});

test("迁移激活快照在积压 evidence 前发送并完成握手门控", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  const evidence = harness.transport.sendJson({ t: "raw.event", tag: "queued-before-activation" });
  const activation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });

  assert.equal(evidence.accepted, true);
  assert.equal(activation.accepted, true);
  assert.deepEqual(readTypes(socket), [
    "client.hello",
    "client.workspaceDirectoryMigrationActivationSnapshot",
  ]);

  harness.transport.markReady();
  assert.deepEqual(readTypes(socket), [
    "client.hello",
    "client.workspaceDirectoryMigrationActivationSnapshot",
  ], "激活快照 send callback 前不得释放 evidence");
  drainSocket(socket);
  assert.deepEqual(readTypes(socket), [
    "client.hello",
    "client.workspaceDirectoryMigrationActivationSnapshot",
    "raw.event",
  ]);
  harness.transport.stop();
});

test("evidence 按 thread 轮转且各 thread 保持 raw/canonical 入队顺序", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  harness.transport.sendJson({ t: "raw.event", event: { threadId: "thread-a" }, tag: "a1" });
  harness.transport.sendJson({ t: "conversation.event", event: { threadId: "thread-a" }, tag: "a2" });
  harness.transport.sendJson({ t: "raw.event", event: { threadId: "thread-a" }, tag: "a3" });
  harness.transport.sendJson({ t: "raw.event", event: { threadId: "thread-b" }, tag: "b1" });
  harness.transport.sendJson({ t: "conversation.event", event: { threadId: "thread-b" }, tag: "b2" });

  harness.transport.markReady();
  drainSocket(socket);

  assert.deepEqual(
    readMessages(socket).slice(1).map((message) => message.tag),
    ["a1", "b1", "a2", "b2", "a3"],
  );
  assert.deepEqual(
    readMessages(socket).filter((message) => String(message.tag ?? "").startsWith("a")).map((message) => message.tag),
    ["a1", "a2", "a3"],
  );
  harness.transport.stop();
});

test("持续拥塞时按 8 priority : 4 evidence : 1 bulk 公平轮转", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  for (let index = 1; index <= 10; index += 1) {
    harness.transport.sendJson({ t: "api.res", tag: `p${index}` });
  }
  for (let index = 1; index <= 6; index += 1) {
    harness.transport.sendJson({ t: "raw.event", tag: `e${index}` });
  }
  harness.transport.sendJson({ t: "terminal.output", tag: "b1" });
  harness.transport.sendJson({ t: "terminal.output", tag: "b2" });

  harness.transport.markReady();
  drainSocket(socket);
  assert.deepEqual(
    readMessages(socket).slice(1).map((message) => message.tag),
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "e1", "e2", "e3", "e4", "b1", "p9", "p10", "e5", "e6", "b2"],
  );
  harness.transport.stop();
});

test("高水位暂停 evidence/bulk，但小响应仍可优先发送", () => {
  const harness = createHarness();
  const socket = openSocket(harness);
  const baseline = socket.sent.length;
  socket.bufferedAmount = 600 * 1024;
  harness.transport.sendJson({ t: "raw.event", tag: "evidence" });
  harness.transport.sendJson({ t: "terminal.output", tag: "bulk" });
  assert.equal(socket.sent.length, baseline, "高水位不应继续交付 evidence/bulk");

  harness.transport.sendJson({ t: "api.res", tag: "priority" });
  assert.equal(readMessages(socket).at(-1)?.tag, "priority");
  socket.bufferedAmount = 0;
  socket.completeNext();
  drainSocket(socket);
  assert.deepEqual(readMessages(socket).slice(baseline).map((message) => message.tag), ["priority", "evidence", "bulk"]);
  harness.transport.stop();
});

test("transient reconnect 先发送激活快照，再恢复未交给底层的 evidence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const first = openSocket(harness);
  first.bufferedAmount = 600 * 1024;
  harness.transport.sendJson({ t: "raw.event", tag: "e1" });
  harness.transport.sendJson({ t: "conversation.event", tag: "e2" });
  assert.equal(first.pendingSendCount(), 0);

  first.remoteClose(1006, "network reset");
  assert.equal(harness.closes.length, 1);
  assert.equal(harness.closes[0]?.diagnostic.queue.evidenceMessages, 2);
  assert.equal(harness.deliveryFailures.length, 0);
  t.mock.timers.tick(2_000);

  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  assert.deepEqual(readTypes(second), ["client.hello"]);
  second.completeNext();
  assert.deepEqual(readTypes(second), ["client.hello"]);
  const activation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  assert.equal(activation.accepted, true);
  assert.deepEqual(readTypes(second), ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot"]);
  harness.transport.markReady();
  assert.deepEqual(
    readTypes(second),
    ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot"],
    "激活快照 send callback 完成前不得释放 evidence",
  );
  second.completeNext();
  drainSocket(second);
  assert.deepEqual(
    readMessages(second).map((message) => message.tag ?? message.t),
    ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot", "e1", "e2"],
  );
  assert.equal(second.maxConcurrentSends, 1);
  harness.transport.stop();
});

test("断线清理未交底层的旧激活快照，但保留 evidence 等待新 helloAck", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.open();
  assert.deepEqual(readTypes(first), ["client.hello"]);

  const staleActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  harness.transport.sendJson({ t: "raw.event", tag: "retained" });
  first.remoteClose(1006, "network reset before hello handoff");

  assert.equal(staleActivation.accepted, false);
  assert.match(staleActivation.reason ?? "", /activation state will be rebuilt after reconnect/);
  assert.equal(harness.closes[0]?.diagnostic.queue.activationMessages, 1);
  assert.equal(harness.closes[0]?.diagnostic.queue.evidenceMessages, 1);
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded connection-scoped activation frames")));

  t.mock.timers.tick(2_000);
  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  assert.deepEqual(readTypes(second), ["client.hello"]);
  second.completeNext();
  assert.deepEqual(readTypes(second), ["client.hello"], "新 helloAck 前不得发送旧快照或 evidence");

  const freshActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  assert.equal(freshActivation.accepted, true);
  harness.transport.markReady();
  drainSocket(second);
  assert.deepEqual(
    readMessages(second).map((message) => message.tag ?? message.t),
    ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot", "retained"],
  );
  harness.transport.stop();
});

test("激活快照在途时断线不会终止 Client，evidence 等待新连接快照", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.open();
  first.completeNext();

  const staleActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  harness.transport.markReady();
  harness.transport.sendJson({ t: "raw.event", tag: "retained-after-in-flight-activation" });
  assert.deepEqual(readTypes(first), ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot"]);
  first.remoteClose(1006, "network reset during activation handoff");

  assert.equal(staleActivation.accepted, false);
  assert.match(staleActivation.reason ?? "", /activation state will be rebuilt after reconnect/);
  assert.equal(harness.deliveryFailures.length, 0);
  assert.equal(harness.closes[0]?.diagnostic.queue.inFlight?.lane, "activation");
  assert.equal(harness.closes[0]?.diagnostic.queue.evidenceMessages, 1);
  assert.ok(harness.diagnostics.some((message) => message.includes("discarded in-flight connection-scoped activation frame")));

  t.mock.timers.tick(2_000);
  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  second.completeNext();
  assert.deepEqual(readTypes(second), ["client.hello"]);

  const freshActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  assert.equal(freshActivation.accepted, true);
  harness.transport.markReady();
  drainSocket(second);
  assert.deepEqual(
    readMessages(second).map((message) => message.tag ?? message.t),
    ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot", "retained-after-in-flight-activation"],
  );
  harness.transport.stop();
});

test("激活快照 send callback 失败后重连重建，不上报致命投递失败", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.open();
  first.completeNext();

  const staleActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  harness.transport.markReady();
  harness.transport.sendJson({ t: "raw.event", tag: "retained-after-activation-callback-error" });
  first.completeNext(new Error("activation callback failed"));

  assert.equal(staleActivation.accepted, false);
  assert.equal(staleActivation.callbackError, "activation callback failed");
  assert.match(staleActivation.reason ?? "", /activation state will be rebuilt after reconnect/);
  assert.equal(harness.deliveryFailures.length, 0);
  assert.equal(harness.closes[0]?.diagnostic.queue.evidenceMessages, 1);

  t.mock.timers.tick(2_000);
  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  second.completeNext();
  const freshActivation = harness.transport.sendJson({
    t: "client.workspaceDirectoryMigrationActivationSnapshot",
    snapshot: {
      activeDirectoryMigrations: [],
      startFenceTombstones: [],
      directoryMigrationIndexStates: [],
    },
  });
  assert.equal(freshActivation.accepted, true);
  harness.transport.markReady();
  drainSocket(second);
  assert.deepEqual(
    readMessages(second).map((message) => message.tag ?? message.t),
    ["client.hello", "client.workspaceDirectoryMigrationActivationSnapshot", "retained-after-activation-callback-error"],
  );
  harness.transport.stop();
});

test("消息数溢出拒绝新帧并触发一次携带队列快照的失败事件", () => {
  const harness = createHarness({ maxMessages: 2, maxBytes: 1024 * 1024 });
  assert.equal(harness.transport.sendJson({ t: "raw.event", tag: "e1" }).accepted, true);
  assert.equal(harness.transport.sendJson({ t: "conversation.event", tag: "e2" }).accepted, true);
  const overflow = harness.transport.sendJson({ t: "orchestration.event", tag: "e3" });

  assert.equal(overflow.accepted, false);
  assert.match(overflow.reason ?? "", /queue overflow/);
  assert.equal(harness.deliveryFailures.length, 1);
  assert.equal(harness.deliveryFailures[0]?.phase, "queue_overflow");
  assert.equal(harness.deliveryFailures[0]?.queue.queuedMessages, 2);
  assert.equal(harness.deliveryFailures[0]?.queue.evidenceMessages, 2);
  assert.equal(harness.deliveryFailures[0]?.queue.maxQueuedMessages, 2);
  harness.transport.stop();
  assert.ok(harness.diagnostics.some((message) => message.includes("ws transport stopped queue=")));
});

test("字节数溢出不会驱逐既有帧", () => {
  const harness = createHarness({ maxMessages: 10, maxBytes: 180 });
  const first = harness.transport.sendJson({ t: "raw.event", tag: "kept" });
  const overflow = harness.transport.sendJson({ t: "raw.event", body: "x".repeat(200) });
  assert.equal(first.accepted, true);
  assert.equal(overflow.accepted, false);
  assert.equal(harness.deliveryFailures.length, 1);
  assert.equal(harness.deliveryFailures[0]?.queue.queuedMessages, 1);
  harness.transport.stop();
});

test("hello send 同步抛错后明确失败且重连可发送新 hello", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const first = harness.sockets[0];
  assert.ok(first);
  first.throwOnNextSend(new Error("injected synchronous hello failure"));
  first.open();

  assert.equal(harness.helloResults[0]?.accepted, false);
  assert.match(harness.helloResults[0]?.reason ?? "", /injected synchronous hello failure/);
  assert.deepEqual(readTypes(first), []);
  assert.equal(harness.closes[0]?.diagnostic.queue.helloMessages, 0);
  assert.equal(harness.deliveryFailures.some((failure) => failure.phase === "queue_overflow"), false);

  t.mock.timers.tick(2_000);
  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  assert.equal(harness.helloResults[1]?.accepted, true);
  assert.deepEqual(readTypes(second), ["client.hello"]);
  second.completeNext();
  harness.transport.stop();
});

test("send callback error 显式失败且重连后只恢复未交底层帧", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const socket = openSocket(harness);
  const failed: WsSendJsonResult = harness.transport.sendJson({ t: "raw.event", tag: "failed" });
  harness.transport.sendJson({ t: "conversation.event", tag: "queued" });
  assert.equal(socket.pendingSendCount(), 1);

  socket.completeNext(new Error("write failed"));
  assert.equal(failed.accepted, false);
  assert.equal(failed.callbackError, "write failed");
  assert.match(failed.reason ?? "", /send callback error/);
  assert.equal(harness.deliveryFailures.length, 1);
  assert.equal(harness.deliveryFailures[0]?.phase, "send_callback");
  assert.equal(harness.deliveryFailures[0]?.messageType, "raw.event");
  assert.equal(harness.deliveryFailures[0]?.queue.inFlight?.messageType, "raw.event");
  assert.equal(harness.deliveryFailures[0]?.queue.evidenceMessages, 1);
  assert.ok(harness.errors.some((message) => message.includes("write failed")));
  assert.deepEqual(readMessages(socket).map((message) => message.tag ?? message.t), ["client.hello", "failed"]);

  assert.equal(harness.closes[0]?.disposition, "reconnect");
  t.mock.timers.tick(2_000);
  const second = harness.sockets[1];
  assert.ok(second);
  second.open();
  assert.deepEqual(readTypes(second), ["client.hello"]);
  second.completeNext();
  harness.transport.markReady();
  drainSocket(second);
  assert.deepEqual(
    readMessages(second).map((message) => message.tag ?? message.t),
    ["client.hello", "queued"],
  );
  harness.transport.stop();
});

test("Client 连接投递失败不退出进程，队列溢出仍显式失败", () => {
  const source = readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("onDeliveryFailure: (failure) => {");
  const end = source.indexOf("onMessageFailure: (failure) => {", start);
  assert.ok(start >= 0 && end > start, "未找到 Client onDeliveryFailure 回调");
  const handler = source.slice(start, end);
  assert.match(handler, /"transport\.delivery_failed"/);
  assert.match(
    handler,
    /if \(failure\.phase === "queue_overflow"\) \{\s*shutdown\(/,
  );
  assert.equal(handler.match(/\bshutdown\s*\(/g)?.length, 1);
});

test("Client helloAck 在异步阶段前后按连接代际门控副作用", () => {
  const source = readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  const completionStart = source.indexOf("async function completeClientHelloConnection(");
  const completionEnd = source.indexOf("  transport = new WsTransport", completionStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);
  const completion = source.slice(completionStart, completionEnd);
  const fence = "if (shutdownRequested || !isCurrentClientHello(msg, messageConnectionGeneration)) return;";
  for (const awaited of ["await waitForEngineModelCatalogDispatchReady();", "await recoverCatalogDependentRuntime();"]) {
    const start = completion.indexOf(awaited);
    assert.ok(start >= 0);
    assert.ok(completion.slice(start + awaited.length).trimStart().startsWith(fence), "异步激活结果必须复核连接代际");
  }
  assert.ok(completion.includes("if (!shutdownRequested && isCurrentClientHello(msg, messageConnectionGeneration))"));
});

test("Client 基础激活按代次同步占位，并发时只放行一条", () => {
  const source = readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  const completionStart = source.indexOf("async function completeClientHelloConnection(");
  const completionEnd = source.indexOf("  transport = new WsTransport", completionStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart, "未找到 Client hello 连接完成边界");
  const completion = source.slice(completionStart, completionEnd);

  assert.match(source, /let baseActivationInFlightGeneration: number \| null = null;/,
    "缺少基础激活同代次并发占位标记");
  assert.match(completion, /const ownsBaseActivation = baseActivatedGeneration !== messageConnectionGeneration\s*\n\s*&& baseActivationInFlightGeneration !== messageConnectionGeneration;/,
    "基础激活认领条件必须同时校验已激活代次与在途占位");

  const claim = completion.indexOf("if (ownsBaseActivation) baseActivationInFlightGeneration = messageConnectionGeneration;");
  const snapshotSend = completion.indexOf("sendWorkspaceMigrationActivationState();");
  const generationAssign = completion.indexOf("baseActivatedGeneration = messageConnectionGeneration;");
  assert.ok(claim >= 0, "基础激活占位缺少同步认领");
  assert.ok(claim < snapshotSend, "基础激活占位必须在激活快照发送前认领，避免并发路径重复提交同代次快照被队列去重拒发");
  assert.ok(snapshotSend >= 0 && generationAssign > snapshotSend, "基础激活完成标记必须在激活快照发送之后");
  assert.match(completion, /\} finally \{\s*\n\s*baseActivationInFlightGeneration = null;\s*\n\s*\}/,
    "基础激活占位必须在异常路径释放，保留同代次重试能力");
});

test("Client shutdown 等待异步 owner 后再关闭数据库", () => {
  const source = readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function shutdownAndExit(");
  const end = source.indexOf("\n  }", start);
  assert.ok(start >= 0 && end > start, "未找到 Client shutdownAndExit");
  const shutdown = source.slice(start, end);

  const orchestrationStop = shutdown.indexOf('runCleanupStep("orchestration_stop"');
  const drains = shutdown.indexOf("await Promise.all([");
  const transportDrain = shutdown.indexOf('runAsyncCleanupStep("transport_drain"', drains);
  const schedulerDrain = shutdown.indexOf('runAsyncCleanupStep("scheduled_tasks_drain"', drains);
  const sessionDrain = shutdown.indexOf('runAsyncCleanupStep("thread_sessions_drain"', drains);
  const orchestrationDrain = shutdown.indexOf('runAsyncCleanupStep("orchestration_drain"', drains);
  const bufferDisposals = ["conversation_ack_buffer_dispose", "raw_ack_buffer_dispose", "thread_touch_buffer_dispose"]
    .map(step => shutdown.indexOf(`runCleanupStep("${step}"`, drains));
  const dbClose = shutdown.indexOf('runCleanupStep("db_close"', drains);

  assert.ok(orchestrationStop >= 0 && orchestrationStop < drains, "编排入口必须先于 drain 停止");
  assert.ok(transportDrain > drains, "Transport 必须加入并行 drain");
  assert.ok(schedulerDrain > drains, "Scheduler 必须加入并行 drain");
  assert.ok(sessionDrain > drains, "ThreadSessionManager 必须加入并行 drain");
  assert.ok(orchestrationDrain > drains, "OrchestrationEngine 必须加入并行 drain");
  assert.ok(bufferDisposals.every(position => position > orchestrationDrain), "DB buffer 只能在 owner drain 后释放");
  assert.ok(bufferDisposals.every(position => dbClose > position), "SQLite 只能在 DB buffer 释放后关闭");
});

test("压力队列保持单 send 在途、evidence FIFO 与控制帧低等待", () => {
  const harness = createHarness();
  const socket = openSocket(harness, false);
  const evidenceCount = 5_000;
  const priorityCount = 625;
  const bulkCount = 100;
  for (let index = 0; index < evidenceCount; index += 1) {
    harness.transport.sendJson({ t: index % 2 === 0 ? "raw.event" : "conversation.event", evidenceSeq: index });
  }
  for (let index = 0; index < bulkCount; index += 1) {
    harness.transport.sendJson({ t: "terminal.output", bulkSeq: index });
  }
  for (let index = 0; index < priorityCount; index += 1) {
    harness.transport.sendJson({ t: "api.res", prioritySeq: index });
  }

  harness.transport.markReady();
  drainSocket(socket, evidenceCount + priorityCount + bulkCount + 10);
  const business = readMessages(socket).slice(1);
  assert.equal(business.length, evidenceCount + priorityCount + bulkCount);
  assert.equal(business[0]?.prioritySeq, 0, "后入队的小响应不应排在 5000 条 evidence 之后");
  assert.equal(socket.maxConcurrentSends, 1);
  assert.deepEqual(
    business.filter((message) => message.evidenceSeq !== undefined).map((message) => message.evidenceSeq),
    Array.from({ length: evidenceCount }, (_, index) => index),
  );
  assert.deepEqual(
    business.filter((message) => message.prioritySeq !== undefined).map((message) => message.prioritySeq),
    Array.from({ length: priorityCount }, (_, index) => index),
  );
  assert.deepEqual(
    business.filter((message) => message.bulkSeq !== undefined).map((message) => message.bulkSeq),
    Array.from({ length: bulkCount }, (_, index) => index),
  );
  harness.transport.stop();
});
