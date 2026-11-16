import type { ReminderSourceType, WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type DingTalkReminderNotificationStatus = "pending" | "sent" | "failed";

export type DingTalkReminderNotificationRecord = {
  notificationKey: string;
  workspaceId: WorkspaceId;
  sourceType: ReminderSourceType;
  targetId: string;
  title: string;
  status: DingTalkReminderNotificationStatus;
  attempts: number;
  errorMessage: string;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type DingTalkReminderNotificationRow = {
  notification_key: string;
  workspace_id: string;
  source_type: string;
  target_id: string;
  title: string;
  status: string;
  attempts: number;
  error_message: string;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
};

/** 维护钉钉待办通知发送记录，用于幂等和失败排查。 */
export class DingTalkReminderNotificationRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按通知唯一键读取发送记录；不存在返回 null。 */
  get(notificationKey: string): DingTalkReminderNotificationRecord | null {
    const row = this.db.prepare(
      [
        "SELECT notification_key, workspace_id, source_type, target_id, title, status, attempts, error_message, sent_at, created_at, updated_at",
        "FROM dingtalk_reminder_notifications",
        "WHERE notification_key = ?",
      ].join("\n"),
    ).get(String(notificationKey)) as DingTalkReminderNotificationRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 创建或重置一次待发送尝试；已成功发送的记录保持不变。 */
  beginAttempt(input: {
    notificationKey: string;
    workspaceId: WorkspaceId;
    sourceType: ReminderSourceType;
    targetId: string;
    title: string;
    now?: number;
  }): DingTalkReminderNotificationRecord {
    const existing = this.get(input.notificationKey);
    if (existing?.status === "sent") return existing;

    const now = Number(input.now ?? Date.now());
    this.db.prepare(
      [
        "INSERT INTO dingtalk_reminder_notifications (",
        "  notification_key, workspace_id, source_type, target_id, title, status, attempts, error_message, sent_at, created_at, updated_at",
        ") VALUES (?, ?, ?, ?, ?, 'pending', 1, '', NULL, ?, ?)",
        "ON CONFLICT(notification_key) DO UPDATE SET",
        "  workspace_id = excluded.workspace_id,",
        "  source_type = excluded.source_type,",
        "  target_id = excluded.target_id,",
        "  title = excluded.title,",
        "  status = 'pending',",
        "  attempts = dingtalk_reminder_notifications.attempts + 1,",
        "  error_message = '',",
        "  updated_at = excluded.updated_at",
      ].join("\n"),
    ).run(
      String(input.notificationKey),
      String(input.workspaceId),
      String(input.sourceType),
      String(input.targetId),
      String(input.title),
      now,
      now,
    );

    const record = this.get(input.notificationKey);
    if (!record) throw new Error(`dingtalk notification record missing after begin: ${input.notificationKey}`);
    return record;
  }

  /** 标记通知已发送成功，并记录发送时间。 */
  markSent(notificationKey: string, sentAt?: number): DingTalkReminderNotificationRecord {
    const now = Number(sentAt ?? Date.now());
    this.db.prepare(
      [
        "UPDATE dingtalk_reminder_notifications",
        "SET status = 'sent', error_message = '', sent_at = ?, updated_at = ?",
        "WHERE notification_key = ?",
      ].join("\n"),
    ).run(now, now, String(notificationKey));
    const record = this.get(notificationKey);
    if (!record) throw new Error(`dingtalk notification record missing after sent: ${notificationKey}`);
    return record;
  }

  /** 标记通知发送失败，保留可检索错误原因。 */
  markFailed(notificationKey: string, errorMessage: string, failedAt?: number): DingTalkReminderNotificationRecord {
    const now = Number(failedAt ?? Date.now());
    this.db.prepare(
      [
        "UPDATE dingtalk_reminder_notifications",
        "SET status = 'failed', error_message = ?, updated_at = ?",
        "WHERE notification_key = ?",
      ].join("\n"),
    ).run(String(errorMessage).slice(0, 1000), now, String(notificationKey));
    const record = this.get(notificationKey);
    if (!record) throw new Error(`dingtalk notification record missing after failed: ${notificationKey}`);
    return record;
  }
}

/** Convert a SQLite row to the repository model and fail on persisted drift. */
function toRecord(row: DingTalkReminderNotificationRow): DingTalkReminderNotificationRecord {
  const status = toNotificationStatus(row.status);
  return {
    notificationKey: String(row.notification_key),
    workspaceId: row.workspace_id as WorkspaceId,
    sourceType: toReminderSourceType(row.source_type),
    targetId: String(row.target_id),
    title: String(row.title ?? ""),
    status,
    attempts: Number(row.attempts ?? 0),
    errorMessage: String(row.error_message ?? ""),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** Parse the persisted notification status and fail on drift. */
function toNotificationStatus(status: string): DingTalkReminderNotificationStatus {
  if (status === "pending" || status === "sent" || status === "failed") return status;
  throw new Error(`invalid dingtalk notification status: ${status}`);
}

/** Parse the persisted reminder source type and fail on drift. */
function toReminderSourceType(sourceType: string): ReminderSourceType {
  if (sourceType === "chat" || sourceType === "orchestration") return sourceType;
  throw new Error(`invalid dingtalk reminder source type: ${sourceType}`);
}
