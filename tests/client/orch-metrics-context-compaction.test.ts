import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationMetricTraceFact } from "@codeflowai/shared";

import {
  deriveContextCompactionFacts,
  type ContextCompactionEventEvidence,
  type ContextCompactionTurnEvidence,
} from "../../apps/desktop/client/src/app/handlers/orchMetricsHandlers.js";

/** Builds the minimal stable Trace identity needed by context-compaction derivation. */
function trace(turnId: string, promptSnapshotId: string, overrides: Partial<OrchestrationMetricTraceFact> = {}): OrchestrationMetricTraceFact {
  return {
    sourceInstanceId: "instance-1",
    nodeId: "node-1",
    nodeExecutionId: "execution-1",
    promptSnapshotId,
    threadId: "thread-1",
    turnId,
    engine: "claude",
    model: "claude-sonnet",
    sourceFingerprint: "trace-fingerprint",
    ...overrides,
  } as OrchestrationMetricTraceFact;
}

/** Builds one persisted canonical event row with its payload envelope. */
function event(
  seq: number,
  ts: number,
  engine: string,
  type: string,
  payload: Record<string, unknown>,
): ContextCompactionEventEvidence {
  return { seq, ts, engine, type, event_json: JSON.stringify({ payload }) };
}

/** Derives facts with one fixed instance, node, and thread identity. */
function derive(input: {
  traces: OrchestrationMetricTraceFact[];
  turns: ContextCompactionTurnEvidence[];
  events: ContextCompactionEventEvidence[];
}) {
  return deriveContextCompactionFacts({
    sourceInstanceId: "instance-1",
    nodeId: "node-1",
    threadId: "thread-1",
    observedThrough: 1_000,
    ...input,
  });
}

test("Claude 自动压缩使用同 Turn 的完成结果", () => {
  const facts = derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [event(15, 150, "claude", "system.notice", { action: "context.compacted" })],
  });

  assert.equal(facts.length, 1);
  assert.deepEqual({
    kind: facts[0]?.compactionKind,
    outcome: facts[0]?.postCompactionOutcome,
    outcomeTurnId: facts[0]?.outcomeTurnId,
    promptSnapshotId: facts[0]?.promptSnapshotId,
  }, {
    kind: "automatic",
    outcome: "completed",
    outcomeTurnId: "turn-1",
    promptSnapshotId: "prompt-1",
  });
  assert.match(facts[0]?.sourceFingerprint ?? "", /^[a-f0-9]{64}$/);
});

test("Claude 自动压缩保留同 Turn 错误结果", () => {
  const facts = derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "error", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [event(15, 150, "claude", "system.notice", { action: "context.compacted" })],
  });

  assert.equal(facts[0]?.postCompactionOutcome, "error");
  assert.equal(facts[0]?.outcomeAt, 200);
});

test("Claude 活动 Turn 保存未观测结果", () => {
  const facts = derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "running", startEventSeq: 10, endEventSeq: null, endedAt: null }],
    events: [event(15, 150, "claude", "system.notice", { action: "context.compacted" })],
  });

  assert.equal(facts[0]?.postCompactionOutcome, "not_observed");
  assert.equal(facts[0]?.outcomeTurnId, null);
  assert.equal(facts[0]?.promptSnapshotId, null);
});

test("Codex 手动压缩跳过压缩 Turn 并绑定下一普通 Turn", () => {
  const facts = derive({
    traces: [trace("turn-result", "prompt-result", { engine: "codex", model: "gpt-5" })],
    turns: [
      { turnId: "turn-compact", status: "completed", startEventSeq: 9, endEventSeq: 10, endedAt: 100 },
      { turnId: "turn-result", status: "completed", startEventSeq: 15, endEventSeq: 20, endedAt: 200 },
    ],
    events: [event(10, 100, "codex", "turn.completed", { turnId: "turn-compact", result: { compacted: true } })],
  });

  assert.equal(facts[0]?.postCompactionOutcome, "completed");
  assert.equal(facts[0]?.outcomeTurnId, "turn-result");
  assert.equal(facts[0]?.promptSnapshotId, "prompt-result");
});

test("连续 Codex 压缩共同绑定首个后续普通终态 Turn", () => {
  const facts = derive({
    traces: [trace("turn-result", "prompt-result", { engine: "codex", model: "gpt-5" })],
    turns: [
      { turnId: "turn-compact-1", status: "completed", startEventSeq: 9, endEventSeq: 10, endedAt: 100 },
      { turnId: "turn-compact-2", status: "completed", startEventSeq: 11, endEventSeq: 12, endedAt: 120 },
      { turnId: "turn-result", status: "error", startEventSeq: 15, endEventSeq: 20, endedAt: 200 },
    ],
    events: [
      event(10, 100, "codex", "turn.completed", { turnId: "turn-compact-1", result: { compacted: true } }),
      event(12, 120, "codex", "turn.completed", { turnId: "turn-compact-2", result: { compacted: true } }),
    ],
  });

  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((fact) => fact.outcomeTurnId), ["turn-result", "turn-result"]);
  assert.deepEqual(facts.map((fact) => fact.postCompactionOutcome), ["error", "error"]);
});

test("Codex 压缩没有后续 Turn 时保留未观测事实", () => {
  const facts = derive({
    traces: [trace("turn-before", "prompt-before", { engine: "codex", model: "gpt-5" })],
    turns: [
      { turnId: "turn-before", status: "completed", startEventSeq: 1, endEventSeq: 5, endedAt: 50 },
      { turnId: "turn-compact", status: "completed", startEventSeq: 9, endEventSeq: 10, endedAt: 100 },
    ],
    events: [event(10, 100, "codex", "turn.completed", { turnId: "turn-compact", result: { compacted: true } })],
  });

  assert.equal(facts[0]?.postCompactionOutcome, "not_observed");
  assert.equal(facts[0]?.promptSnapshotId, null);
});

test("压缩事实对重复事件序号显式失败", () => {
  assert.throws(() => derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [
      event(15, 150, "claude", "system.notice", { action: "context.compacted" }),
      event(15, 150, "claude", "turn.completed", { turnId: "turn-1" }),
    ],
  }), /事件序号重复/);
});

test("一个 Turn 绑定多个 Prompt Snapshot 时显式失败", () => {
  assert.throws(() => derive({
    traces: [trace("turn-1", "prompt-1"), trace("turn-1", "prompt-2")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [],
  }), /绑定多个 Prompt Snapshot/);
});

test("跨节点 Trace 归属显式失败", () => {
  assert.throws(() => derive({
    traces: [trace("turn-1", "prompt-1", { nodeId: "node-2" })],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [],
  }), /Trace 归属冲突/);
});

test("已观测结果缺少结束时间或时间倒置时显式失败", () => {
  const compacted = event(15, 150, "claude", "system.notice", { action: "context.compacted" });
  assert.throws(() => derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: null }],
    events: [compacted],
  }), /结果 Turn 边界无效/);
  assert.throws(() => derive({
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 149 }],
    events: [compacted],
  }), /结果 Turn 边界无效/);
});

test("其他引擎的同形事件不生成 Claude 或 Codex 压缩事实", () => {
  const facts = derive({
    traces: [trace("turn-1", "prompt-1", { engine: "custom" })],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [
      event(15, 150, "custom", "system.notice", { action: "context.compacted" }),
      event(20, 200, "custom", "turn.completed", { turnId: "turn-1", result: { compacted: true } }),
    ],
  });

  assert.deepEqual(facts, []);
});

test("采集上界之后结束的 Turn 不得成为压缩后结果", () => {
  const automatic = deriveContextCompactionFacts({
    sourceInstanceId: "instance-1",
    nodeId: "node-1",
    threadId: "thread-1",
    observedThrough: 180,
    traces: [trace("turn-1", "prompt-1")],
    turns: [{ turnId: "turn-1", status: "completed", startEventSeq: 10, endEventSeq: 20, endedAt: 200 }],
    events: [event(15, 150, "claude", "system.notice", { action: "context.compacted" })],
  });
  assert.equal(automatic[0]?.postCompactionOutcome, "not_observed");
  assert.equal(automatic[0]?.promptSnapshotId, null);

  const manual = deriveContextCompactionFacts({
    sourceInstanceId: "instance-1",
    nodeId: "node-1",
    threadId: "thread-1",
    observedThrough: 180,
    traces: [trace("turn-result", "prompt-result", { engine: "codex", model: "gpt-5" })],
    turns: [
      { turnId: "turn-compact", status: "completed", startEventSeq: 9, endEventSeq: 10, endedAt: 100 },
      { turnId: "turn-result", status: "completed", startEventSeq: 15, endEventSeq: 20, endedAt: 200 },
    ],
    events: [event(10, 100, "codex", "turn.completed", { turnId: "turn-compact", result: { compacted: true } })],
  });
  assert.equal(manual[0]?.postCompactionOutcome, "not_observed");
  assert.equal(manual[0]?.outcomeTurnId, null);
});
