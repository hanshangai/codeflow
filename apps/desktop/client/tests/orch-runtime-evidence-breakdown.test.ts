import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationId, RawEngineEventEnvelope, ThreadId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleOrchRuntimeEvidenceGet } from "../src/app/handlers/orchestrationHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";

const WORKSPACE_ID = "ws-breakdown" as WorkspaceId;
const INSTANCE_ID = "inst-breakdown" as OrchestrationId;
const NODE_ID = "e2e";
const NODE_THREAD = "orch-inst-breakdown-e2e-1" as ThreadId;

/** 构造一条真实客户端库格式的原始引擎事件（DB 里存的是整条 envelope 的 JSON）。 */
function envelope(seq: number, ts: number, data: unknown): RawEngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts,
    workspaceId: WORKSPACE_ID,
    threadId: NODE_THREAD,
    engine: "claude",
    source: "claude.stream-json.stdout",
    data,
    handled: true,
    action: "ignored",
    emittedTypes: [],
  };
}

/** 一条通过真实 SQLite 落盘、并带假实例与空提示快照的 handler 上下文。 */
function createHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orch-evidence-breakdown-"));
  const db = openClientDb({ dbPath: path.join(directory, "test.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: WORKSPACE_ID, title: "breakdown", path: directory });
  // 引擎事件对外键引用线程，必须先落一条会话行。
  db.threads.create({ id: NODE_THREAD, workspaceId: WORKSPACE_ID, engine: "claude", title: "E2E 节点" });

  db.rawEvents.appendEnvelopes([
    envelope(1, 1_000, { type: "system", subtype: "init" }),
    // 流式形态先到（input 为空），assistant 正文后到（带命令）——必须只计一次并保住命令摘要。
    envelope(2, 2_000, { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "call-bash", name: "Bash", input: {} } } }),
    envelope(3, 2_100, { type: "assistant", message: { content: [{ type: "tool_use", id: "call-bash", name: "Bash", input: { command: "pnpm -C apps/web test:e2e chat-workflow" } }] } }),
    envelope(4, 42_100, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-bash" }] } }),
    envelope(5, 43_000, { type: "assistant", message: { content: [{ type: "tool_use", id: "call-read", name: "Read", input: { file_path: "apps/web/src/a.vue" } }] } }),
    envelope(6, 44_000, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-read" }] } }),
  ]);

  const instance = {
    id: INSTANCE_ID,
    workspaceId: WORKSPACE_ID,
    masterThreadId: null,
    status: "running",
    workflowSnapshot: { nodes: [{ id: NODE_ID, type: "role", label: "E2E" }] },
    nodeStates: { [NODE_ID]: { nodeId: NODE_ID, status: "running", threadId: NODE_THREAD, previousThreadIds: [] } },
  };
  const sent: Array<{ id: string; status: number; body: Record<string, unknown> }> = [];
  const ctx = {
    workspaces: new Map([[WORKSPACE_ID, directory]]),
    db: {
      ...db,
      orchInstances: { get: (id: string) => (id === INSTANCE_ID ? instance : null) },
      orchPromptSnapshots: { get: () => null, listByNode: () => [], listByInstance: () => [] },
    },
    send(message: { t: string; id: string; status: number; body: Record<string, unknown> }) {
      sent.push({ id: message.id, status: message.status, body: message.body });
    },
  } as unknown as ApiHandlerContext;
  return { ctx, sent, db };
}

/** 发出一次运行证据请求并取回响应体。 */
function request(ctx: ApiHandlerContext, sent: Array<{ body: Record<string, unknown> }>, nodeId: string | null) {
  handleOrchRuntimeEvidenceGet(ctx, {
    id: "req-breakdown",
    method: "orch.runtimeEvidence.get",
    body: { workspaceId: WORKSPACE_ID, instanceId: INSTANCE_ID, nodeId },
  } as unknown as ApiRequestMessage);
  assert.equal(sent.length, 1);
  return sent[0]!.body as {
    ok: boolean;
    runtimeBreakdown: {
      toolCallCount: number;
      toolCallsByTool: Array<{ tool: string; count: number }>;
      testCommandCount: number;
      slowestCalls: Array<{ tool: string; seconds: number; detail: string }>;
      eventCount: number;
      heartbeatSeconds: number | null;
      maxSilenceSeconds: number;
    } | null;
  };
}

test("按节点查询运行证据时给出耗时分解（含去重、测试命令识别与最慢调用）", (t) => {
  const { ctx, sent } = createHarness(t);
  const body = request(ctx, sent, NODE_ID);

  assert.equal(body.ok, true);
  assert.ok(body.runtimeBreakdown, "节点级查询必须返回耗时分解");
  const breakdown = body.runtimeBreakdown!;
  assert.equal(breakdown.eventCount, 6);
  assert.equal(breakdown.toolCallCount, 2);
  assert.deepEqual(breakdown.toolCallsByTool, [
    { tool: "Bash", count: 1 },
    { tool: "Read", count: 1 },
  ]);
  assert.equal(breakdown.testCommandCount, 1);
  // 调用起点取最早观测到事件的时刻（流式 2_000，而非 assistant 的 2_100），故耗时为 40.1s。
  assert.deepEqual(breakdown.slowestCalls.map((call) => [call.tool, call.seconds, call.detail]), [
    ["Bash", 40.1, "pnpm -C apps/web test:e2e chat-workflow"],
    ["Read", 1, "apps/web/src/a.vue"],
  ]);
});

test("整实例查询不带耗时分解，避免把节点级聚合挂到全局查询上", (t) => {
  const { ctx, sent } = createHarness(t);
  const body = request(ctx, sent, null);

  assert.equal(body.ok, true);
  assert.equal(body.runtimeBreakdown, null);
});
