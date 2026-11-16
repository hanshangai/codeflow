import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { backfillEventOutputOnce } from "../../apps/desktop/client/src/diagnostics/eventOutputBackfill.ts";

test("startup event-output backfill sanitizes stored tool output once and keeps AI reasoning", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-event-output-backfill-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-backfill" as any;
    const threadId = "thread-backfill" as any;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({ id: threadId, workspaceId, engine: "codex", title: "tmp" });

    workspaceDb.conversationEvents.appendEnvelopes([
      {
        schema: 1,
        seq: 1,
        ts: 1,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.reasoning.delta",
        payload: {
          itemId: "reasoning-1" as any,
          delta: "keep reasoning",
        },
      },
      {
        schema: 1,
        seq: 2,
        ts: 2,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.tool.outputDelta",
        payload: {
          itemId: "tool-1" as any,
          toolName: "commandExecution",
          delta: "huge tool output",
        },
      },
      {
        schema: 1,
        seq: 3,
        ts: 3,
        workspaceId,
        threadId,
        engine: "claude",
        type: "item.subagent.childEvent",
        payload: {
          itemId: "subagent-1" as any,
          taskId: "task-1",
          innerEventType: "item.tool.completed",
          innerPayload: {
            itemId: "tool-2" as any,
            toolName: "Bash",
            output: { stdout: "nested tool output" },
            status: "completed",
          },
        },
      },
    ]);

    workspaceDb.rawEvents.appendEnvelopes([
      {
        schema: 1,
        seq: 1,
        ts: 1,
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: {
          type: "assistant",
          message: {
            id: "assistant-1",
            content: [
              { type: "text", text: "assistant body" },
              { type: "thinking", thinking: "keep thinking" },
              { type: "tool_result", content: "tool output" },
            ],
          },
        },
        handled: true,
        action: "mapped",
        emittedTypes: ["item.agentMessage.completed"],
      },
      {
        schema: 1,
        seq: 2,
        ts: 2,
        workspaceId,
        threadId,
        engine: "codex",
        source: "codex.app-server.msg",
        data: {
          method: "item/reasoning/textDelta",
          params: { itemId: "reasoning-1", delta: "keep codex reasoning" },
        },
        handled: true,
        action: "mapped",
        emittedTypes: ["item.reasoning.delta"],
      },
    ]);

    const summary = backfillEventOutputOnce(workspaceDb);
    assert.equal(summary.applied, true);
    assert.equal(summary.conversation.updated, 2);
    assert.equal(summary.raw.updated, 1);

    const conversation = workspaceDb.conversationEvents.listByThread(threadId, { limit: 10 });
    assert.equal((conversation[0] as any).payload.delta, "keep reasoning");
    assert.equal((conversation[1] as any).payload.delta, "[工具输出已省略，非 DEBUG 模式不保留全文]");
    assert.deepEqual(((conversation[2] as any).payload.innerPayload as any).output, {
      omitted: true,
      reason: "non-assistant-output",
      originalType: "object",
      originalBytes: Buffer.byteLength(JSON.stringify({ stdout: "nested tool output" }), "utf8"),
      preview: "nested tool output",
    });

    const raw = workspaceDb.rawEvents.listByThreadFromSeq(threadId, { fromSeqInclusive: 1, limit: 10 });
    assert.equal((raw[0] as any).data.message.content[0].text, "assistant body");
    assert.equal((raw[0] as any).data.message.content[1].thinking, "keep thinking");
    assert.deepEqual((raw[0] as any).data.message.content[2].content, {
      omitted: true,
      reason: "non-assistant-output",
      originalType: "string",
      originalBytes: Buffer.byteLength("tool output", "utf8"),
      preview: "tool output",
    });
    assert.equal((raw[1] as any).data.params.delta, "keep codex reasoning");

    const metaRow = workspaceDb.db.prepare("SELECT value FROM meta WHERE key = ?").get("event_output_backfill_v2_tool_only") as { value?: string } | undefined;
    assert.ok(metaRow?.value);

    const second = backfillEventOutputOnce(workspaceDb);
    assert.equal(second.applied, false);
    assert.equal(second.skippedReason, "already_done");
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("startup event-output backfill skips when debug full output is enabled", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-event-output-backfill-debug-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const result = backfillEventOutputOnce(db, { keepFullOutput: true });
    assert.equal(result.applied, false);
    assert.equal(result.skippedReason, "debug_full_output");
    const metaRow = db.db.prepare("SELECT value FROM meta WHERE key = ?").get("event_output_backfill_v2_tool_only") as { value?: string } | undefined;
    assert.equal(metaRow, undefined);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

