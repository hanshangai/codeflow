import crypto from "node:crypto";

import type {
  RequirementAnalysisMessage,
  RequirementAnalysisMessageId,
  RequirementAnalysisSessionId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

/** 需求分析助手消息仓储。 */
export class OrchRequirementAnalysisMessageRepo {
  constructor(private readonly db: SqliteDb) {}

  listBySession(sessionId: RequirementAnalysisSessionId): RequirementAnalysisMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, structured_payload_json, created_at
         FROM orch_requirement_analysis_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(String(sessionId)) as any[];
    return rows.map(rowToMessage);
  }

  append(input: Omit<RequirementAnalysisMessage, "id" | "createdAt"> & { createdAt?: number }): RequirementAnalysisMessage {
    const message: RequirementAnalysisMessage = {
      ...input,
      id: crypto.randomUUID() as RequirementAnalysisMessageId,
      createdAt: Number(input.createdAt ?? Date.now()),
    };
    this.db
      .prepare(
        `INSERT INTO orch_requirement_analysis_messages (
          id, session_id, role, content, structured_payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(message.id),
        String(message.sessionId),
        String(message.role),
        String(message.content ?? ""),
        nullableString(message.structuredPayloadJson),
        message.createdAt,
      );
    return message;
  }
}

function rowToMessage(row: any): RequirementAnalysisMessage {
  return {
    id: String(row.id) as RequirementAnalysisMessageId,
    sessionId: String(row.session_id) as RequirementAnalysisSessionId,
    role: row.role === "assistant" || row.role === "system" ? row.role : "user",
    content: String(row.content ?? ""),
    structuredPayloadJson: nullableString(row.structured_payload_json),
    createdAt: Number(row.created_at ?? 0),
  };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

