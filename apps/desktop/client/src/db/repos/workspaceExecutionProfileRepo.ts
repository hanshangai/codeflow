import crypto from "node:crypto";
import {
  normalizeWorkspaceExecutionProfileText,
  type ExecutionProfileScopeType,
  type WorkspaceExecutionProfile,
  type WorkspaceExecutionProfileScope,
  type WorkspaceExecutionProfileStatus,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

type Row = {
  scope_type: string;
  scope_id: string;
  user_id: string;
  profile_text: string;
  profile_hash: string;
  created_at: number;
  updated_at: number;
};

/** 工作区执行 Profile 仓储；按 scope + user 隔离纯文本 Profile。 */
export class WorkspaceExecutionProfileRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 读取指定用户在当前工作区范围内的 Profile；不存在返回 null。 */
  get(scope: WorkspaceExecutionProfileScope, userId: string): WorkspaceExecutionProfile | null {
    const row = this.getRow(scope, userId);
    return row ? rowToProfile(row) : null;
  }

  /** 保存或清空 Profile；空文本保留更新时间但对外视为 missing。 */
  upsert(input: {
    scope: WorkspaceExecutionProfileScope;
    userId: string;
    profileText: string;
  }): WorkspaceExecutionProfile {
    const text = normalizeWorkspaceExecutionProfileText(input.profileText);
    const now = Date.now();
    const existing = this.getRow(input.scope, input.userId);
    const hash = hashProfileText(text);
    this.db
      .prepare(
        `INSERT INTO workspace_execution_profiles
           (scope_type, scope_id, user_id, profile_text, profile_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id, user_id) DO UPDATE SET
           profile_text = excluded.profile_text,
           profile_hash = excluded.profile_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.scope.scopeType,
        input.scope.scopeId,
        input.userId,
        text,
        hash,
        existing?.created_at ?? now,
        now,
      );
    return toProfile(input.scope, input.userId, text, hash, now);
  }

  /** 查询多个用户的 Profile 状态；不会返回 Profile 全文。 */
  listStatuses(scope: WorkspaceExecutionProfileScope, userIds: string[]): WorkspaceExecutionProfileStatus[] {
    const uniqueUserIds = Array.from(new Set(userIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
    const checkedAt = Date.now();
    return uniqueUserIds.map((userId) => {
      const profile = this.get(scope, userId);
      const hasProfile = Boolean(profile?.profileText.trim());
      return {
        scope,
        userId,
        hasProfile,
        source: hasProfile ? "workspace" : "missing",
        profileHash: hasProfile ? profile?.profileHash ?? null : null,
        profileUpdatedAt: profile?.updatedAt ?? null,
        checkedAt,
      };
    });
  }

  /** 读取原始行，供保存时保留 created_at。 */
  private getRow(scope: WorkspaceExecutionProfileScope, userId: string): Row | null {
    const row = this.db
      .prepare(
        `SELECT scope_type, scope_id, user_id, profile_text, profile_hash, created_at, updated_at
         FROM workspace_execution_profiles
         WHERE scope_type = ? AND scope_id = ? AND user_id = ?`,
      )
      .get(scope.scopeType, scope.scopeId, userId) as Row | undefined;
    return row ?? null;
  }
}

function rowToProfile(row: Row): WorkspaceExecutionProfile {
  const scope: WorkspaceExecutionProfileScope = {
    scopeType: row.scope_type as ExecutionProfileScopeType,
    scopeId: String(row.scope_id ?? ""),
  };
  return toProfile(
    scope,
    String(row.user_id ?? ""),
    String(row.profile_text ?? ""),
    String(row.profile_hash ?? ""),
    Number(row.updated_at ?? 0) || null,
  );
}

function toProfile(
  scope: WorkspaceExecutionProfileScope,
  userId: string,
  profileText: string,
  profileHash: string | null,
  updatedAt: number | null,
): WorkspaceExecutionProfile {
  const hasProfile = Boolean(profileText.trim());
  return {
    scope,
    userId,
    profileText,
    source: hasProfile ? "workspace" : "missing",
    profileHash: hasProfile ? profileHash : null,
    updatedAt,
  };
}

function hashProfileText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
