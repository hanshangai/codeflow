import assert from "node:assert/strict";
import test from "node:test";

import { createEventFlowMonitor, type EventFlowSnapshot } from "../../apps/desktop/client/src/diagnostics/eventFlowMonitor.ts";

/** 构造 Codex raw 事件消息。 */
function rawMessage(wsType: "raw.event" | "raw.eventAck", seq: number | null, providerId?: string) {
  return {
    t: wsType,
    event: {
      ...(seq == null ? {} : { seq }),
      threadId: "thread-flow",
      clientTurnId: "turn-flow",
      type: "raw",
      data: {
        ...(providerId ? { id: providerId } : {}),
        method: "item/commandExecution/outputDelta",
        params: {
          turnId: "provider-turn",
          itemId: "provider-item",
          delta: "chunk",
        },
      },
    },
  };
}

test("event flow monitor aggregates provider/raw/ACK counts without fabricating notification ids", () => {
  const snapshots: EventFlowSnapshot[] = [];
  const monitor = createEventFlowMonitor({
    windowMs: 60_000,
    messageThreshold: 100,
    onFlush: (snapshot) => snapshots.push(snapshot),
  });
  try {
    monitor.recordOutbound(rawMessage("raw.event", null), 120);
    monitor.recordOutbound({
      t: "conversation.event",
      event: { threadId: "thread-flow", clientTurnId: "turn-flow", type: "item.tool.outputDelta" },
    }, 80);
    monitor.recordAck(rawMessage("raw.eventAck", 101), 130);
    monitor.recordAck(rawMessage("raw.eventAck", 101), 130);
    monitor.recordAck(rawMessage("raw.eventAck", 102, "provider-request-1"), 140);
    monitor.recordAck(rawMessage("raw.eventAck", 103, "provider-request-1"), 140);
    monitor.recordAck({
      t: "conversation.eventAck",
      event: { seq: 201, threadId: "thread-flow", clientTurnId: "turn-flow", type: "item.tool.outputDelta" },
    }, 90);
    monitor.recordDisconnect(7);
    monitor.recordReconnect();
    const reconnectSnapshot = monitor.flush();

    assert.equal(snapshots.length, 2, "disconnect 会先冲刷事件窗口，reconnect 单独进入下一窗口");
    const first = snapshots[0]!;
    assert.equal(first.reason, "disconnect");
    assert.equal(first.outboundRawEvents, 1);
    assert.equal(first.outboundCanonicalEvents, 1);
    assert.equal(first.rawAcks, 4);
    assert.equal(first.canonicalAcks, 1);
    assert.equal(first.uniqueRawAckSeqs, 3);
    assert.equal(first.duplicateRawAckSeqs, 1);
    assert.equal(first.uniqueCanonicalAckSeqs, 1);
    assert.equal(first.mappedProviderAcks, 2);
    assert.equal(first.unmappedProviderEvents, 1);
    assert.equal(first.providerSeqConflicts, 1);
    assert.equal(first.disconnects, 1);
    assert.equal(first.pendingEvidenceFramesAtDisconnect, 7);
    assert.ok(first.buckets.some((bucket) => (
      bucket.providerMethod === "item/commandExecution/outputDelta"
      && bucket.providerCorrelation === "unmapped"
    )));
    assert.equal(reconnectSnapshot?.reconnects, 1);
  } finally {
    monitor.dispose();
  }
});

test("event flow monitor flushes once at the bounded message threshold", () => {
  const snapshots: EventFlowSnapshot[] = [];
  const monitor = createEventFlowMonitor({
    windowMs: 60_000,
    messageThreshold: 2,
    onFlush: (snapshot) => snapshots.push(snapshot),
  });
  try {
    monitor.recordOutbound(rawMessage("raw.event", null), 10);
    monitor.recordOutbound(rawMessage("raw.event", null), 20);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.reason, "threshold");
    assert.equal(snapshots[0]?.messages, 2);
    assert.equal(snapshots[0]?.bytes, 30);
  } finally {
    monitor.dispose();
  }
});

test("event flow monitor keeps the threshold ACK inside the flushed window", () => {
  const snapshots: EventFlowSnapshot[] = [];
  const monitor = createEventFlowMonitor({
    windowMs: 60_000,
    messageThreshold: 2,
    onFlush: (snapshot) => snapshots.push(snapshot),
  });
  try {
    monitor.recordAck(rawMessage("raw.eventAck", 1), 10);
    monitor.recordAck(rawMessage("raw.eventAck", 2), 20);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.messages, 2);
    assert.equal(snapshots[0]?.rawAcks, 2);
    assert.equal(snapshots[0]?.uniqueRawAckSeqs, 2);
  } finally {
    monitor.dispose();
  }
});
