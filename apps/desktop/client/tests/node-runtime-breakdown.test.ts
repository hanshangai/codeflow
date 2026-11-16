import assert from "node:assert/strict";
import test from "node:test";

import { computeOrchNodeRuntimeBreakdown, type OrchThreadRuntimeFacts } from "../src/orchestration/nodeRuntimeBreakdown.ts";

/** 构造一条 claude stream-json 的 assistant 工具调用事件。 */
function toolUseEvent(ts: number, id: string, name: string, input: Record<string, unknown>): { ts: number; json: string } {
  return {
    ts,
    json: JSON.stringify({
      ts,
      engine: "claude",
      source: "claude.stream-json.stdout",
      data: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
    }),
  };
}

/** 构造一条流式形态的工具调用事件（与 assistant 形态共享同一个 tool_use id）。 */
function streamToolUseEvent(ts: number, id: string, name: string, input: Record<string, unknown>): { ts: number; json: string } {
  return {
    ts,
    json: JSON.stringify({
      ts,
      engine: "claude",
      source: "claude.stream-json.stdout",
      data: { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name, input } } },
    }),
  };
}

/** 构造一条工具结果事件；耗时由调用与结果的时间差决定。 */
function toolResultEvent(ts: number, id: string): { ts: number; json: string } {
  return {
    ts,
    json: JSON.stringify({
      ts,
      engine: "claude",
      source: "claude.stream-json.stdout",
      data: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "ok" }] }] } },
    }),
  };
}

/** 构造一条无工具调用的普通事件，仅用于铺时间线。 */
function plainEvent(ts: number): { ts: number; json: string } {
  return { ts, json: JSON.stringify({ ts, data: { type: "system", subtype: "status" } }) };
}

test("工具调用按 id 去重并配对结果，耗时排序只保留最慢的若干次", () => {
  const facts: OrchThreadRuntimeFacts = {
    eventTimestamps: [1_000, 2_000, 12_000, 30_000, 45_000],
    toolEvents: [
      // 同一 tool_use 同时以 assistant 与流式两种形态出现，必须只计一次。
      toolUseEvent(2_000, "call-a", "Bash", { command: "pnpm -C apps/web test:e2e chat-workflow" }),
      streamToolUseEvent(2_000, "call-a", "Bash", { command: "pnpm -C apps/web test:e2e chat-workflow" }),
      toolResultEvent(45_000, "call-a"),
      toolUseEvent(3_000, "call-b", "Read", { file_path: "D:/repo/apps/web/src/a.vue" }),
      toolResultEvent(12_000, "call-b"),
      toolUseEvent(4_000, "call-c", "Bash", { command: "git status --short" }),
      // call-c 没有结果：计入次数，但不进入耗时榜。
    ],
  };

  const breakdown = computeOrchNodeRuntimeBreakdown([facts], { now: () => 99 });

  assert.equal(breakdown.toolCallCount, 3);
  assert.deepEqual(breakdown.toolCallsByTool, [
    { tool: "Bash", count: 2 },
    { tool: "Read", count: 1 },
  ]);
  assert.deepEqual(breakdown.slowestCalls, [
    { tool: "Bash", seconds: 43, detail: "pnpm -C apps/web test:e2e chat-workflow", startedAt: 2_000 },
    { tool: "Read", seconds: 9, detail: "D:/repo/apps/web/src/a.vue", startedAt: 3_000 },
  ]);
  // 只有 Bash 命令里命中测试特征的那条计入测试命令数。
  assert.equal(breakdown.testCommandCount, 1);
  assert.equal(breakdown.threadCount, 1);
  assert.equal(breakdown.eventCount, 5);
  assert.equal(breakdown.startedAt, 1_000);
  assert.equal(breakdown.endedAt, 45_000);
  assert.equal(breakdown.computedAt, 99);
});

test("重复出现的长间隔被识别为心跳，真实静默取排除心跳后的最大空档", () => {
  // 铺一条时间线：三段 30 秒心跳 + 一段 300 秒真实卡顿，并记录卡顿起点。
  const timestamps = [0, 1_000];
  let cursor = 1_000;
  let stuckFrom = 0;
  for (const gap of [30_000, 1_000, 30_000, 1_000, 30_000, 300_000, 1_000]) {
    if (gap === 300_000) stuckFrom = cursor;
    cursor += gap;
    timestamps.push(cursor);
  }
  const breakdown = computeOrchNodeRuntimeBreakdown([{ eventTimestamps: timestamps, toolEvents: [] }]);

  assert.equal(breakdown.heartbeatSeconds, 30);
  assert.equal(breakdown.maxSilenceSeconds, 300);
  assert.equal(breakdown.maxSilenceStartedAt, stuckFrom);
});

test("长间隔只出现一次时不当作心跳，宁可报出可疑卡顿", () => {
  const breakdown = computeOrchNodeRuntimeBreakdown([{
    eventTimestamps: [0, 1_000, 121_000, 122_000],
    toolEvents: [],
  }]);

  assert.equal(breakdown.heartbeatSeconds, null);
  assert.equal(breakdown.maxSilenceSeconds, 120);
  assert.equal(breakdown.maxSilenceStartedAt, 1_000);
});

test("多线程合并统计调用次数与总时长，空输入返回零值而不是报错", () => {
  const breakdown = computeOrchNodeRuntimeBreakdown([
    {
      eventTimestamps: [5_000, 6_000],
      toolEvents: [toolUseEvent(5_000, "call-1", "Edit", { file_path: "a.ts" }), toolResultEvent(6_000, "call-1")],
    },
    { eventTimestamps: [20_000], toolEvents: [] },
  ]);

  assert.equal(breakdown.threadCount, 2);
  assert.equal(breakdown.toolCallCount, 1);
  assert.equal(breakdown.startedAt, 5_000);
  assert.equal(breakdown.endedAt, 20_000);

  const empty = computeOrchNodeRuntimeBreakdown([], { now: () => 7 });
  assert.deepEqual(empty, {
    threadCount: 0,
    eventCount: 0,
    startedAt: null,
    endedAt: null,
    toolCallCount: 0,
    toolCallsByTool: [],
    slowestCalls: [],
    testCommandCount: 0,
    heartbeatSeconds: null,
    maxSilenceSeconds: 0,
    maxSilenceStartedAt: null,
    computedAt: 7,
  });
});

test("流式形态先到时用后到的 assistant 正文补齐命令摘要", () => {
  // 真实顺序：content_block_start 先到（input 为空），assistant 正文后到（带完整 input）。
  const breakdown = computeOrchNodeRuntimeBreakdown([{
    eventTimestamps: [1_000, 2_000, 3_000],
    toolEvents: [
      streamToolUseEvent(1_000, "call-live", "Bash", {}),
      toolUseEvent(1_100, "call-live", "Bash", { command: "pnpm -C apps/web test:e2e chat-workflow" }),
      toolResultEvent(3_000, "call-live"),
    ],
  }]);

  assert.equal(breakdown.toolCallCount, 1);
  assert.equal(breakdown.testCommandCount, 1);
  assert.deepEqual(breakdown.slowestCalls, [{
    tool: "Bash",
    seconds: 2,
    detail: "pnpm -C apps/web test:e2e chat-workflow",
    startedAt: 1_000,
  }]);
});

test("损坏或不含工具块的事件被忽略，不影响其余统计", () => {
  const breakdown = computeOrchNodeRuntimeBreakdown([{
    eventTimestamps: [1_000, 2_000],
    toolEvents: [
      { ts: 1_000, json: "{ not json" },
      plainEvent(1_500),
      toolUseEvent(1_000, "call-ok", "Grep", { pattern: "ports" }),
      toolResultEvent(2_000, "call-ok"),
    ],
  }]);

  assert.equal(breakdown.toolCallCount, 1);
  assert.deepEqual(breakdown.slowestCalls.map((call) => call.tool), ["Grep"]);
});
