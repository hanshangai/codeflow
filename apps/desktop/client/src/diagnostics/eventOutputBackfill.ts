import type { ConversationEventEnvelope, RawEngineEventEnvelope } from "@codeflowai/shared";
import { randomUUID } from "node:crypto";

import type { ClientDb } from "../db/clientDb.js";
import { engineDiagnosticCause, engineDiagnosticField, writeEngineWorkspaceLog } from "../engines/threadSession.js";
import { sanitizeConversationEvent, sanitizeRawEvent } from "./eventOutputPolicy.js";

const EVENT_OUTPUT_BACKFILL_META_KEY = "event_output_backfill_v2_tool_only";
const BACKFILL_BATCH_SIZE = 200;
const RAW_SOURCE_CODEX = "codex.app-server.msg";
const RAW_SOURCE_CLAUDE = "claude.stream-json.stdout";

export type EventOutputBackfillSummary = {
  applied: boolean;
  skippedReason?: "already_done" | "debug_full_output";
  conversation: { scanned: number; updated: number };
  raw: { scanned: number; updated: number };
};

/** 根入口逐W保留原批次事务和各自完成标记；任一失败即停止后续W。 */
export function backfillEventOutputOnce(
  db: ClientDb,
  opts?: { keepFullOutput?: boolean },
): EventOutputBackfillSummary {
  if (opts?.keepFullOutput) {
    return {
      applied: false,
      skippedReason: "debug_full_output",
      conversation: { scanned: 0, updated: 0 },
      raw: { scanned: 0, updated: 0 },
    };
  }

  if (db.forWorkspace && !db.workspaceId) {
    const summary: EventOutputBackfillSummary = { applied: false, conversation: { scanned: 0, updated: 0 }, raw: { scanned: 0, updated: 0 } };
    for (const workspace of db.workspaces.list()) {
      const result = backfillEventOutputOnce(db.forWorkspace(workspace.id), opts);
      summary.applied ||= result.applied;
      summary.conversation.scanned += result.conversation.scanned;
      summary.conversation.updated += result.conversation.updated;
      summary.raw.scanned += result.raw.scanned;
      summary.raw.updated += result.raw.updated;
    }
    if (!summary.applied) summary.skippedReason = "already_done";
    return summary;
  }

  const startedAt = Date.now();
  const requestId = `event-output-backfill:${process.pid}:${randomUUID()}`;
  let metaValue: string | null;
  try { metaValue = getMetaValue(db, EVENT_OUTPUT_BACKFILL_META_KEY); }
  catch (cause) { logBackfillFailure(db, requestId, cause); throw cause; }
  if (metaValue) {
    return {
      applied: false,
      skippedReason: "already_done",
      conversation: { scanned: 0, updated: 0 },
      raw: { scanned: 0, updated: 0 },
    };
  }

  if (db.workspaceId === null) throw new Error("EVENT_OUTPUT_BACKFILL_WORKSPACE_REQUIRED");
  const workspaceId = db.workspaceId;
  writeEngineWorkspaceLog(db.writeWorkspaceLog, workspaceId, () => ({
    level: "info", tag: "event-output-backfill", message: "startup backfill started", data: {
      code: "EVENT_OUTPUT_BACKFILL_STARTED", requestId,
      metaKey: EVENT_OUTPUT_BACKFILL_META_KEY, batchSize: BACKFILL_BATCH_SIZE,
    },
  }));

  let summary: EventOutputBackfillSummary;
  try {
    const conversation = backfillConversationEvents(db);
    const raw = backfillRawEvents(db);

    summary = { applied: true, conversation, raw };
    setMetaValue(db, EVENT_OUTPUT_BACKFILL_META_KEY, JSON.stringify({
      completedAt: new Date().toISOString(), conversation, raw,
    }));
  } catch (cause) {
    logBackfillFailure(db, requestId, cause);
    throw cause;
  }
  // 完成标记已提交；诊断失败直接拒绝，不伪装成业务回滚或自动重跑。
  writeEngineWorkspaceLog(db.writeWorkspaceLog, workspaceId, () => ({
    level: "info", tag: "event-output-backfill", message: "startup backfill finished", data: {
      code: "EVENT_OUTPUT_BACKFILL_FINISHED", requestId, metaKey: EVENT_OUTPUT_BACKFILL_META_KEY,
      durationMs: Date.now() - startedAt, conversation: summary.conversation, raw: summary.raw,
    },
  }));
  return summary;
}

/** 只描述自有字段；诊断与固定写同处保因边界，绝不输出历史事件正文。 */
function logBackfillFailure(db: ClientDb, requestId: string, cause: unknown): void {
  if (db.workspaceId === null) throw new Error("EVENT_OUTPUT_BACKFILL_WORKSPACE_REQUIRED", { cause });
  writeEngineWorkspaceLog(db.writeWorkspaceLog, db.workspaceId, () => {
    const code = engineDiagnosticField(cause, "code");
    const table = engineDiagnosticField(cause, "table");
    const seq = engineDiagnosticField(cause, "seq");
    const rootCause = engineDiagnosticField(cause, "cause");
    return { level: "error", tag: "event-output-backfill", message: "startup backfill failed", data: {
      code: typeof code === "string" ? code : "EVENT_OUTPUT_BACKFILL_FAILED", requestId,
      table: typeof table === "string" ? table : null, seq: typeof seq === "number" ? seq : null,
      rootCause: engineDiagnosticCause(cause), persistedEventCause: engineDiagnosticCause(rootCause),
    } };
  }, { reason: cause });
}

/** 保留原有有界分页和每批原子更新，解析失败不得标记整库完成。 */
function backfillConversationEvents(db: ClientDb): { scanned: number; updated: number } {
  const selectStmt = db.db.prepare(
    [
      "SELECT seq, event_json",
      "FROM conversation_events",
      "WHERE seq > ?",
      "  AND type IN ('item.tool.outputDelta', 'item.tool.completed', 'item.subagent.childEvent')",
      "ORDER BY seq ASC",
      "LIMIT ?",
    ].join("\n"),
  );
  const updateStmt = db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE seq = ?");
  const updateManyTx = db.db.transaction((rows: Array<{ seq: number; eventJson: string }>) => {
    for (const row of rows) {
      updateStmt.run(row.eventJson, row.seq);
    }
  });

  let scanned = 0;
  let updated = 0;
  let cursor = 0;
  while (true) {
    const rows = selectStmt.all(cursor, BACKFILL_BATCH_SIZE) as Array<{ seq: number; event_json: string }>;
    if (!rows.length) break;

    const changed: Array<{ seq: number; eventJson: string }> = [];
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.seq ?? 0));
      scanned += 1;
      const next = sanitizeConversationRow(row.event_json, Number(row.seq));
      if (next !== row.event_json) {
        changed.push({ seq: Number(row.seq), eventJson: next });
      }
    }

    if (changed.length) {
      updateManyTx(changed);
      updated += changed.length;
    }
  }

  return { scanned, updated };
}

/** 原始trace沿同一W分页，任意损坏行显式中止本轮。 */
function backfillRawEvents(db: ClientDb): { scanned: number; updated: number } {
  const selectStmt = db.db.prepare(
    [
      "SELECT seq, event_json",
      "FROM raw_engine_events",
      "WHERE seq > ?",
      "  AND source IN (?, ?)",
      "ORDER BY seq ASC",
      "LIMIT ?",
    ].join("\n"),
  );
  const updateStmt = db.db.prepare("UPDATE raw_engine_events SET event_json = ? WHERE seq = ?");
  const updateManyTx = db.db.transaction((rows: Array<{ seq: number; eventJson: string }>) => {
    for (const row of rows) {
      updateStmt.run(row.eventJson, row.seq);
    }
  });

  let scanned = 0;
  let updated = 0;
  let cursor = 0;
  while (true) {
    const rows = selectStmt.all(cursor, RAW_SOURCE_CODEX, RAW_SOURCE_CLAUDE, BACKFILL_BATCH_SIZE) as Array<{ seq: number; event_json: string }>;
    if (!rows.length) break;

    const changed: Array<{ seq: number; eventJson: string }> = [];
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.seq ?? 0));
      scanned += 1;
      const next = sanitizeRawRow(row.event_json, Number(row.seq));
      if (next !== row.event_json) {
        changed.push({ seq: Number(row.seq), eventJson: next });
      }
    }

    if (changed.length) {
      updateManyTx(changed);
      updated += changed.length;
    }
  }

  return { scanned, updated };
}

/** 持久事件损坏时保留主键和cause，禁止跳过后写入成功标记。 */
function sanitizeConversationRow(eventJson: string, seq: number): string {
  try {
    const envelope = JSON.parse(String(eventJson ?? "")) as ConversationEventEnvelope;
    const sanitized = sanitizeConversationEvent(envelope as any) as unknown as ConversationEventEnvelope;
    return JSON.stringify(sanitized);
  } catch (cause) {
    throw Object.assign(new Error("EVENT_OUTPUT_BACKFILL_ROW_INVALID", { cause }), {
      code: "EVENT_OUTPUT_BACKFILL_ROW_INVALID", table: "conversation_events", seq,
    });
  }
}

/** 原始事件损坏遵循同一失败边界，诊断不包含正文。 */
function sanitizeRawRow(eventJson: string, seq: number): string {
  try {
    const envelope = JSON.parse(String(eventJson ?? "")) as RawEngineEventEnvelope;
    const sanitized = sanitizeRawEvent(envelope as any) as unknown as RawEngineEventEnvelope;
    return JSON.stringify(sanitized);
  } catch (cause) {
    throw Object.assign(new Error("EVENT_OUTPUT_BACKFILL_ROW_INVALID", { cause }), {
      code: "EVENT_OUTPUT_BACKFILL_ROW_INVALID", table: "raw_engine_events", seq,
    });
  }
}

/** 仅从当前物理W读取一次性整理标记，缺失表示尚未执行。 */
function getMetaValue(db: ClientDb, key: string): string | null {
  const row = db.db.prepare("SELECT value FROM meta WHERE key = ?").get(String(key)) as { value?: string | null } | undefined;
  if (!row) return null;
  const value = String(row.value ?? "").trim();
  return value || null;
}

/** 全部批次成功后才持久标记，不提前宣布完成。 */
function setMetaValue(db: ClientDb, key: string, value: string): void {
  db.db
    .prepare(
      [
        "INSERT INTO meta(key, value) VALUES (?, ?)",
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ].join("\n"),
    )
    .run(String(key), String(value));
}

