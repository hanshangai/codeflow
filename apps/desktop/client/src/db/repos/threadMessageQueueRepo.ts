import crypto from "node:crypto";

import type {
  CodexSkillMentionBinding,
  OrchAssetExecutionAuthorization,
  TextFileAttachment,
  ThreadDraftImageAttachment,
  ThreadId,
  ThreadInputKind,
  ThreadMessageQueueItem,
  ThreadMessageQueueItemStatus,
  ThreadQueueSharedWorkspaceContext,
  ThreadQueueSendOptions,
  TurnId,
  WorkspacePathReference,
  WorkspaceId,
  WorkspaceExecutionProfileScope,
} from "@codeflowai/shared";
import { normalizeWorkspacePathReferenceList, readOrchAssetExecutionAuthorization } from "@codeflowai/shared";
import { ThreadInputContractError } from "@codeflowai/shared";

import type { FileBlobRepo } from "./fileBlobRepo.js";
import type { SqliteDb } from "../sqliteTypes.js";
import { logger } from "../../logger.js";
import {
  parsePersistedThreadInputContract,
  projectThreadInputContractFields,
  rawQueueContractNeedsFreshTurn,
  serializePersistedThreadInputContract,
} from "../../engines/threadInputActions.js";

type ItemRow = {
  id: string;
  thread_id: string;
  workspace_id: string;
  position: number;
  status: string;
  text: string;
  attachments_json: string;
  path_references_json: string;
  input_kind: string | null;
  skill_mentions_json: string;
  send_options_json: string;
  origin_web_session_id: string | null;
  client_item_id: string | null;
  enqueued_at: number;
  updated_at: number;
  sent_turn_id: string | null;
  failure_reason: string | null;
  failure_code: string | null;
  attempt_count: number;
};

type AttachmentRow = {
  id: string;
  queue_item_id: string;
  kind: string;
  order_index: number;
  name: string | null;
  display_name: string | null;
  mime: string | null;
  size: number;
  blob_id: string;
};

const POSITION_GAP = 1024;
const ACTIVE_STATUSES = ["pending", "sending"] as const;
const SHARED_WORKSPACE_QUEUE_CONTEXT_KEY = "__sharedWorkspaceToolContext";
const EXECUTION_PROFILE_CONTEXT_KEY = "__executionProfileContext";
const ASSET_EXECUTION_AUTHORIZATION_KEY = "__assetExecutionAuthorization";
export type QueueExecutionProfileContext = { userId: string; scope: WorkspaceExecutionProfileScope };
export const ORCHESTRATION_RECOVERY_WAKE_POST_ACK_FAILURE_CODE = "orchestration_recovery_wake_post_ack_failed";
export const ORCHESTRATION_RECOVERY_WAKE_POST_ACK_COMPLETED_CODE = `${ORCHESTRATION_RECOVERY_WAKE_POST_ACK_FAILURE_CODE}_completed`;
/** 接收结果未知的输入保留幂等记录，禁止按普通失败重新投递。 */
export const ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE = "active_turn_append_outcome_unknown";
const NON_REPLAYABLE_FAILURE_CODES = [
  "active_turn_append_post_ack_failed",
  "active_turn_append_evidence_incomplete",
  "orchestration_pending_input_post_ack_failed",
  "orchestration_feedback_post_ack_failed",
  ORCHESTRATION_RECOVERY_WAKE_POST_ACK_FAILURE_CODE,
  ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE,
] as const;
const POST_ACK_COMPLETED_CODES = [
  "active_turn_append_post_ack_failed_completed",
  "orchestration_pending_input_post_ack_failed_completed",
  "orchestration_feedback_post_ack_failed_completed",
  ORCHESTRATION_RECOVERY_WAKE_POST_ACK_COMPLETED_CODE,
] as const;

export type AppendItemInput = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  text: string;
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
  images: ThreadDraftImageAttachment[];
  files: TextFileAttachment[];
  pathReferences?: WorkspacePathReference[];
  sendOptions: ThreadQueueSendOptions;
  originWebSessionId: string | null;
  sharedWorkspaceToolContext?: ThreadQueueSharedWorkspaceContext | null;
  /** 仅由可信 Host 调用设置；不进入 Web DTO。 */
  executionProfileContext?: QueueExecutionProfileContext | null;
  /** 固定入队时的缓存来源，不进入公开DTO，也不授予新的执行许可。 */
  assetExecutionAuthorization?: OrchAssetExecutionAuthorization | null;
  /** 可选幂等键：活跃项、ACK 后收尾项及接收结果未知项均返回原记录。 */
  clientItemId?: string | null;
};

export type AppendItemResult = {
  item: ThreadMessageQueueItem;
  /** 同 thread + clientItemId 命中活跃或禁止重发的记录时不创建新行。 */
  idempotent: boolean;
};

export type DispatcherQueueClaim =
  | { kind: "claimed"; item: ThreadMessageQueueItem }
  | {
    kind: "contract-invalid";
    queueItemId: string;
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    attemptCount: number;
    failureCode: "queue_input_contract_invalid";
    failureReason: string;
  };

/** 运行中输入队列：item + attachment 仓储。串行写入 (node:sqlite 同步事务) */
export class ThreadMessageQueueRepo {
  /** 防止同一缺失附件在列表轮询期间重复刷日志。 */
  private readonly loggedMissingAttachmentBlobKeys = new Set<string>();

  private readonly insertItemStmt;
  private readonly insertAttachmentStmt;
  private readonly listAttachmentsStmt;
  private readonly listAttachmentsByItemStmt;
  private readonly getByIdStmt;
  private readonly listActiveByThreadStmt;
  private readonly hasActiveByThreadStmt;
  private readonly findIdempotentByClientItemIdStmt;
  private readonly getSharedContextByIdStmt;
  private readonly peekNextPendingSharedContextStmt;
  private readonly peekNextPendingInputContractStmt;
  private readonly getMaxPositionStmt;
  private readonly listAdjacentActiveStmt;
  private readonly updatePositionStmt;
  private readonly markSentStmt;
  private readonly markFailedStmt;
  private readonly markPostAckPendingStmt;
  private readonly updatePostAckPendingReasonStmt;
  private readonly transitionPostAckCodeStmt;
  private readonly completePostAckStmt;
  private readonly markCancelledStmt;
  private readonly releaseClaimStmt;
  private readonly cancelActiveByThreadStmt;
  private readonly resetSendingStmt;
  private readonly deleteItemStmt;
  private readonly deleteActiveByThreadStmt;
  private readonly listThreadsWithPendingStmt;
  private readonly claimNextPendingTx;
  private readonly claimNextPendingForDispatchTx;
  private readonly appendItemTx;

  constructor(
    private readonly db: SqliteDb,
    private readonly blobs: FileBlobRepo,
  ) {
    this.insertItemStmt = this.db.prepare(
      `INSERT INTO thread_message_queue (
         id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
         input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
         sent_turn_id, failure_reason, failure_code, attempt_count
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
    );
    this.insertAttachmentStmt = this.db.prepare(
      `INSERT INTO thread_message_queue_attachments (
         id, queue_item_id, kind, order_index, name, display_name, mime, size, blob_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listAttachmentsStmt = this.db.prepare(
      `SELECT id, queue_item_id, kind, order_index, name, display_name, mime, size, blob_id
         FROM thread_message_queue_attachments
        WHERE queue_item_id IN (SELECT id FROM thread_message_queue WHERE thread_id = ?)
        ORDER BY queue_item_id ASC, kind ASC, order_index ASC`,
    );
    this.listAttachmentsByItemStmt = this.db.prepare(
      `SELECT id, queue_item_id, kind, order_index, name, display_name, mime, size, blob_id
         FROM thread_message_queue_attachments
        WHERE queue_item_id = ?
        ORDER BY kind ASC, order_index ASC`,
    );
    this.getByIdStmt = this.db.prepare(
      `SELECT id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
              input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
              sent_turn_id, failure_reason, failure_code, attempt_count
         FROM thread_message_queue
        WHERE id = ?`,
    );
    this.listActiveByThreadStmt = this.db.prepare(
      `SELECT id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
              input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
              sent_turn_id, failure_reason, failure_code, attempt_count
         FROM thread_message_queue
        WHERE thread_id = ? AND status IN ('pending','sending')
        ORDER BY position ASC`,
    );
    this.hasActiveByThreadStmt = this.db.prepare(
      "SELECT 1 AS found FROM thread_message_queue WHERE thread_id = ? AND status IN ('pending','sending') LIMIT 1",
    );
    this.findIdempotentByClientItemIdStmt = this.db.prepare(
      `SELECT id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
               input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
              sent_turn_id, failure_reason, failure_code, attempt_count
         FROM thread_message_queue
        WHERE thread_id = ? AND client_item_id = ?
          AND (
            status IN ('pending','sending')
            OR (status = 'failed' AND failure_code IN (${NON_REPLAYABLE_FAILURE_CODES.map(() => "?").join(",")}))
            OR (status = 'sent' AND failure_code IN (${POST_ACK_COMPLETED_CODES.map(() => "?").join(",")}))
          )
        ORDER BY CASE
                   WHEN status IN ('pending','sending') THEN 0
                   WHEN status = 'sent' THEN 1
                   ELSE 2
                 END,
                 updated_at DESC
        LIMIT 1`,
    );
    this.getSharedContextByIdStmt = this.db.prepare(
      `SELECT send_options_json
         FROM thread_message_queue
        WHERE id = ?
        LIMIT 1`,
    );
    this.peekNextPendingSharedContextStmt = this.db.prepare(
      `SELECT send_options_json
         FROM thread_message_queue
        WHERE thread_id = ? AND status = 'pending'
        ORDER BY position ASC
        LIMIT 1`,
    );
    this.peekNextPendingInputContractStmt = this.db.prepare(
      `SELECT input_kind, skill_mentions_json
         FROM thread_message_queue
        WHERE thread_id = ? AND status = 'pending'
        ORDER BY position ASC
        LIMIT 1`,
    );
    this.getMaxPositionStmt = this.db.prepare(
      `SELECT COALESCE(MAX(position), 0) AS max_pos
         FROM thread_message_queue
        WHERE thread_id = ? AND status IN ('pending','sending')`,
    );
    this.listAdjacentActiveStmt = this.db.prepare(
      `SELECT id, position FROM thread_message_queue
        WHERE thread_id = ? AND status = 'pending'
        ORDER BY position ASC`,
    );
    this.updatePositionStmt = this.db.prepare(
      `UPDATE thread_message_queue SET position = ?, updated_at = ? WHERE id = ?`,
    );
    this.markSentStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET status = 'sent', sent_turn_id = ?, failure_reason = NULL, failure_code = NULL, updated_at = ?
        WHERE id = ?`,
    );
    this.markFailedStmt = this.db.prepare(
      `UPDATE thread_message_queue SET status = 'failed', failure_code = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
    );
    this.markPostAckPendingStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET status = 'failed', sent_turn_id = ?, failure_code = ?, failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'sending' AND attempt_count = ?`,
    );
    this.updatePostAckPendingReasonStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'failed' AND failure_code = ? AND attempt_count = ?`,
    );
    this.transitionPostAckCodeStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET failure_code = ?, failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'failed' AND failure_code = ? AND attempt_count = ?`,
    );
    this.completePostAckStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET status = 'sent', sent_turn_id = ?, failure_code = ?, failure_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed' AND failure_code = ? AND attempt_count = ?`,
    );
    this.markCancelledStmt = this.db.prepare(
      `UPDATE thread_message_queue SET status = 'cancelled', failure_code = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
    );
    this.releaseClaimStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET status = 'pending', failure_code = NULL, failure_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND attempt_count = ?`,
    );
    this.cancelActiveByThreadStmt = this.db.prepare(
      `UPDATE thread_message_queue
          SET status = 'cancelled', failure_code = ?, failure_reason = ?, updated_at = ?
        WHERE thread_id = ? AND status IN ('pending','sending')`,
    );
    this.resetSendingStmt = this.db.prepare(
      `UPDATE thread_message_queue SET status = 'pending', updated_at = ? WHERE status = 'sending'`,
    );
    // remove 必须按 (thread_id, id) 双键删除：handler 透传的 threadId 是归属校验，
    // 防止跨 thread 误删 / 恶意构造（ws 多端时不同 web 都能触达 client）
    this.deleteItemStmt = this.db.prepare(`DELETE FROM thread_message_queue WHERE id = ? AND thread_id = ? AND status = 'pending'`);
    this.deleteActiveByThreadStmt = this.db.prepare(
      `DELETE FROM thread_message_queue WHERE thread_id = ? AND status = 'pending'`,
    );
    this.listThreadsWithPendingStmt = this.db.prepare(
      `SELECT DISTINCT thread_id FROM thread_message_queue WHERE status = 'pending'`,
    );

    /** 原子认领：把 thread 内 position 最小的 pending 项切到 sending；返回该项或 null。 */
    this.claimNextPendingTx = this.db.transaction((threadId: ThreadId): ThreadMessageQueueItem | null => {
      const row = this.db
        .prepare(
          `SELECT id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
                  input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
                  sent_turn_id, failure_reason, failure_code, attempt_count
             FROM thread_message_queue
            WHERE thread_id = ? AND status = 'pending'
            ORDER BY position ASC
            LIMIT 1`,
        )
        .get(String(threadId)) as ItemRow | undefined;
      if (!row) return null;
      const now = Date.now();
      this.db
        .prepare(`UPDATE thread_message_queue SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(now, row.id);
      return this.hydrateItem({ ...row, status: "sending", updated_at: now, attempt_count: row.attempt_count + 1 });
    });

    /** Dispatcher claim atomically terminates only typed persisted input-contract failures. */
    this.claimNextPendingForDispatchTx = this.db.transaction((threadId: ThreadId): DispatcherQueueClaim | null => {
      const row = this.db
        .prepare(
          `SELECT id, thread_id, workspace_id, position, status, text, attachments_json, path_references_json,
                  input_kind, skill_mentions_json, send_options_json, origin_web_session_id, client_item_id, enqueued_at, updated_at,
                  sent_turn_id, failure_reason, failure_code, attempt_count
             FROM thread_message_queue
            WHERE thread_id = ? AND status = 'pending'
            ORDER BY position ASC
            LIMIT 1`,
        )
        .get(String(threadId)) as ItemRow | undefined;
      if (!row) return null;
      const now = Date.now();
      const attemptCount = Number(row.attempt_count ?? 0) + 1;
      const claimed = this.db.prepare(
        `UPDATE thread_message_queue
            SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(now, row.id);
      if (Number(claimed.changes ?? 0) !== 1) return null;
      try {
        return {
          kind: "claimed",
          item: this.hydrateItem({ ...row, status: "sending", updated_at: now, attempt_count: attemptCount }),
        };
      } catch (cause) {
        if (!(cause instanceof ThreadInputContractError)) throw cause;
        const failureReason = "持久化输入合同无效，请重新编辑并发送";
        const failed = this.db.prepare(
          `UPDATE thread_message_queue
              SET status = 'failed', failure_code = 'queue_input_contract_invalid', failure_reason = ?, updated_at = ?
            WHERE id = ? AND status = 'sending' AND attempt_count = ?`,
        ).run(failureReason, Date.now(), row.id, attemptCount);
        if (Number(failed.changes ?? 0) !== 1) {
          throw new Error(`队列坏行终结 CAS 失败：queueItemId=${String(row.id)}`);
        }
        return {
          kind: "contract-invalid",
          queueItemId: String(row.id),
          threadId: String(row.thread_id) as ThreadId,
          workspaceId: String(row.workspace_id) as WorkspaceId,
          attemptCount,
          failureCode: "queue_input_contract_invalid",
          failureReason,
        };
      }
    });

    /** 入队事务：算 next position → 写 image/file blob → INSERT item + attachments。
     *  幂等：调用方应先检查 active/ACK 后待收尾项，命中则直接返回原 item。 */
    this.appendItemTx = this.db.transaction((input: AppendItemInput): ThreadMessageQueueItem => {
      const maxRow = this.getMaxPositionStmt.get(String(input.threadId)) as { max_pos: number } | undefined;
      const nextPosition = Number(maxRow?.max_pos ?? 0) + POSITION_GAP;
      const now = Date.now();
      const id = `queue_${crypto.randomUUID()}`;
      const sendOptionsJson = serializeQueueSendOptions(input.sendOptions, input.sharedWorkspaceToolContext ?? null, input.executionProfileContext ?? null, input.assetExecutionAuthorization ?? null);
      const pathReferences = normalizeWorkspacePathReferenceList(input.pathReferences);
      const clientItemId = nullableString(input.clientItemId);
      if (Object.prototype.hasOwnProperty.call(input, "inputKind") && input.inputKind !== "message") {
        throw new ThreadInputContractError("PROVIDER_SLASH_CONFLICT", "Provider Slash 不能进入消息队列");
      }
      const inputContract = serializePersistedThreadInputContract(
        projectThreadInputContractFields(input),
        String(input.text ?? ""),
      );

      // attachments_json 仅作为 audit 索引（保留 id/kind/order_index 以便排查）；
      // 查询路径必须走 thread_message_queue_attachments 表（hydrateItem 也走 attachment 表）；
      // 不要把它当作"无 join 快速 list"的来源——dataUrl/text 内容只在 file_blobs。
      const attachmentsIndex = [
        ...input.images.map((image, idx) => ({ id: String(image.id ?? "").trim() || `img_${idx}`, kind: "image", order_index: idx })),
        ...input.files.map((file, idx) => ({ id: String(file.id ?? "").trim() || `file_${idx}`, kind: "text-file", order_index: idx })),
      ];

      this.insertItemStmt.run(
        id,
        String(input.threadId),
        String(input.workspaceId),
        nextPosition,
        String(input.text ?? ""),
        JSON.stringify(attachmentsIndex),
        JSON.stringify(pathReferences),
        inputContract.inputKind,
        inputContract.skillMentionsJson,
        sendOptionsJson,
        nullableString(input.originWebSessionId),
        clientItemId,
        now,
        now,
      );

      input.images.forEach((image, index) => {
        const dataUrl = String(image.dataUrl ?? "");
        const blobId = this.blobs.put(Buffer.from(dataUrl, "utf8"), "utf8");
        this.insertAttachmentStmt.run(
          `qatt_${crypto.randomUUID()}`,
          id,
          "image",
          index,
          String(image.name ?? "").trim() || "image",
          null,
          "",
          normalizeSize(image.size, dataUrl),
          blobId,
        );
      });

      input.files.forEach((file, index) => {
        const textContent = String(file.text ?? "");
        const blobId = this.blobs.put(Buffer.from(textContent, "utf8"), "utf8");
        this.insertAttachmentStmt.run(
          `qatt_${crypto.randomUUID()}`,
          id,
          "text-file",
          index,
          String(file.name ?? "").trim() || "file",
          nullableString(file.displayName),
          String(file.mime ?? "").trim(),
          normalizeSize(file.size, textContent),
          blobId,
        );
      });

      const itemRow: ItemRow = {
        id,
        thread_id: String(input.threadId),
        workspace_id: String(input.workspaceId),
        position: nextPosition,
        status: "pending",
        text: String(input.text ?? ""),
        attachments_json: JSON.stringify(attachmentsIndex),
        path_references_json: JSON.stringify(pathReferences),
        input_kind: inputContract.inputKind,
        skill_mentions_json: inputContract.skillMentionsJson,
        send_options_json: sendOptionsJson,
        origin_web_session_id: nullableString(input.originWebSessionId),
        client_item_id: clientItemId,
        enqueued_at: now,
        updated_at: now,
        sent_turn_id: null,
        failure_reason: null,
        failure_code: null,
        attempt_count: 0,
      };
      return this.hydrateItem(itemRow);
    });
  }

  /** 同 clientItemId 的活跃、ACK 后收尾及结果未知项禁止重建；其他终态按既有规则入队。 */
  appendItem(input: AppendItemInput): AppendItemResult {
    const clientItemId = nullableString(input.clientItemId);
    if (clientItemId) {
      const item = this.findIdempotentItem(input.threadId, clientItemId);
      if (item) return { item, idempotent: true };
    }
    const item = this.appendItemTx(input) as ThreadMessageQueueItem;
    return { item, idempotent: false };
  }

  /** 复用原幂等口径区分新输入与ACK收尾，后者不得重新获取执行许可。 */
  findIdempotentItem(threadId: ThreadId, clientItemId: string): ThreadMessageQueueItem | null {
    const row = this.findIdempotentByClientItemIdStmt.get(String(threadId), clientItemId,
      ...NON_REPLAYABLE_FAILURE_CODES, ...POST_ACK_COMPLETED_CODES) as ItemRow | undefined;
    return row ? this.hydrateItem(row) : null;
  }

  /** 异步表单的回答终态也参与去重，避免事件回流前或重启后再次投递。 */
  findLatestByClientItemId(threadId: ThreadId, clientItemId: string): ThreadMessageQueueItem | null {
    const row = this.db.prepare(`SELECT id FROM thread_message_queue
      WHERE thread_id = ? AND client_item_id = ? ORDER BY enqueued_at DESC, rowid DESC LIMIT 1`)
      .get(String(threadId), clientItemId) as { id: string } | undefined;
    return row ? this.getById(row.id) : null;
  }

  /** 列出 thread 当前活跃项 (pending + sending)，按 position 升序。 */
  listActiveByThread(threadId: ThreadId): ThreadMessageQueueItem[] {
    const rows = this.listActiveByThreadStmt.all(String(threadId)) as ItemRow[];
    if (rows.length === 0) return [];
    const attachmentRows = this.listAttachmentsStmt.all(String(threadId)) as AttachmentRow[];
    const byItem = groupByItemId(attachmentRows);
    return rows.map((row) => this.hydrateItem(row, byItem.get(row.id) ?? []));
  }

  /** 仅判断 thread 是否存在 pending 或 sending 项，不读取队列正文和附件。 */
  hasActiveByThread(threadId: ThreadId): boolean {
    return Boolean(this.hasActiveByThreadStmt.get(String(threadId)));
  }

  getById(id: string): ThreadMessageQueueItem | null {
    const row = this.getByIdStmt.get(String(id)) as ItemRow | undefined;
    if (!row) return null;
    const attachmentRows = this.listAttachmentsByItemStmt.all(String(id)) as AttachmentRow[];
    return this.hydrateItem(row, attachmentRows);
  }

  /** 读取队列项隐藏的共享执行上下文；仅 dispatcher 消费用，不进入 Web DTO。 */
  getSharedWorkspaceToolContext(id: string): ThreadQueueSharedWorkspaceContext | null {
    const row = this.getSharedContextByIdStmt.get(String(id)) as { send_options_json?: string | null } | undefined;
    return parseSharedWorkspaceQueueContext(row?.send_options_json);
  }

  /** 仅消费端读取原冻结来源；损坏元数据显式失败，旧项保留null。 */
  getAssetExecutionAuthorization(id: string): OrchAssetExecutionAuthorization | null {
    const row = this.getSharedContextByIdStmt.get(String(id)) as { send_options_json?: string | null } | undefined;
    const holder = JSON.parse(row?.send_options_json || "{}");
    if (!Object.prototype.hasOwnProperty.call(holder, ASSET_EXECUTION_AUTHORIZATION_KEY)) return null;
    return readOrchAssetExecutionAuthorization(holder[ASSET_EXECUTION_AUTHORIZATION_KEY]);
  }

  getExecutionProfileContext(id: string): QueueExecutionProfileContext | null {
    const row = this.getSharedContextByIdStmt.get(String(id)) as { send_options_json?: string | null } | undefined;
    const context = JSON.parse(row?.send_options_json || "{}")[EXECUTION_PROFILE_CONTEXT_KEY];
    if (!context) return null;
    if (!context.userId || !context.scope?.scopeId || !["local_workspace", "shared_workspace"].includes(context.scope?.scopeType)) {
      throw new Error("队列执行身份上下文无效");
    }
    return { userId: String(context.userId), scope: { scopeId: String(context.scope.scopeId), scopeType: context.scope.scopeType } };
  }

  /** 查看下一条 pending 是否来自共享工作区，用于运行中阶段选择 defer 而不是 active append。 */
  peekNextPendingSharedWorkspaceContext(threadId: ThreadId): ThreadQueueSharedWorkspaceContext | null {
    const row = this.peekNextPendingSharedContextStmt.get(String(threadId)) as { send_options_json?: string | null } | undefined;
    return parseSharedWorkspaceQueueContext(row?.send_options_json);
  }

  /** Reads only the next pending row's persisted role selector for pre-claim fresh-turn routing. */
  peekNextPendingRoleId(threadId: ThreadId): string | null {
    const row = this.peekNextPendingSharedContextStmt.get(String(threadId)) as {
      send_options_json?: unknown;
    } | undefined;
    if (!row) return null;
    return nullableString(normalizeQueueSendOptions(JSON.parse(String(row.send_options_json ?? "{}"))).roleId);
  }

  /** Reads only raw input-contract columns so pre-claim routing never strict-hydrates a damaged row. */
  peekNextPendingNeedsFreshTurn(threadId: ThreadId): boolean {
    const row = this.peekNextPendingInputContractStmt.get(String(threadId)) as {
      input_kind?: unknown;
      skill_mentions_json?: unknown;
    } | undefined;
    return row ? rawQueueContractNeedsFreshTurn(row.input_kind, row.skill_mentions_json) : false;
  }

  /** 上移：仅 pending 项可与上一个 pending 项交换 position。返回是否发生交换。 */
  moveUp(threadId: ThreadId, queueItemId: string): boolean {
    return this.swapWithNeighbor(threadId, queueItemId, "up");
  }

  /** 下移：仅 pending 项可与下一个 pending 项交换 position。返回是否发生交换。 */
  moveDown(threadId: ThreadId, queueItemId: string): boolean {
    return this.swapWithNeighbor(threadId, queueItemId, "down");
  }

  /** 删除 pending 单项（硬删；attachment 行通过外键 cascade 自动清理；blob 引用计数 GC）。
   *  归属校验：必须 thread_id 匹配；不匹配返回 false（防跨 thread 误删 / 恶意构造）。 */
  remove(threadId: ThreadId, queueItemId: string): boolean {
    // 先收集本项 attachment 的 blob_id，删除主行后做 GC（cascade 删 attachment 行后引用计数变化）
    const attachmentRows = this.listAttachmentsByItemStmt.all(String(queueItemId)) as AttachmentRow[];
    const blobIds = attachmentRows.map((a) => String(a.blob_id ?? "")).filter(Boolean);
    const result = this.deleteItemStmt.run(String(queueItemId), String(threadId));
    const removed = Number(result.changes ?? 0) > 0;
    if (removed && blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
    return removed;
  }

  /** 清空 thread 全部 pending 项；返回被清空数量。sending 项必须等待终态收尾。 */
  clear(threadId: ThreadId): number {
    // 收集所有 pending 项 attachment 的 blob_id 后再批删（cascade 自动清 attachment）
    const blobIds = (this.db
      .prepare(
        `SELECT a.blob_id FROM thread_message_queue_attachments a
           JOIN thread_message_queue q ON a.queue_item_id = q.id
          WHERE q.thread_id = ? AND q.status = 'pending'`,
      )
      .all(String(threadId)) as Array<{ blob_id: string }>).map((r) => String(r.blob_id ?? "")).filter(Boolean);
    const result = this.deleteActiveByThreadStmt.run(String(threadId));
    const cleared = Number(result.changes ?? 0);
    if (cleared > 0 && blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
    return cleared;
  }

  /** 原子认领下一条：pending → sending；返回 hydrate 后的 item 或 null。 */
  claimNextPending(threadId: ThreadId): ThreadMessageQueueItem | null {
    return this.claimNextPendingTx(threadId) as ThreadMessageQueueItem | null;
  }

  /** Claims for dispatcher consumption and reports typed bad-row termination without rolling it back. */
  claimNextPendingForDispatch(threadId: ThreadId): DispatcherQueueClaim | null {
    return this.claimNextPendingForDispatchTx(threadId) as DispatcherQueueClaim | null;
  }

  /** 标记队列项已投递；编排反馈消费没有普通 turn，可保留 sent_turn_id 为空。 */
  markSent(id: string, turnId: TurnId | null): void {
    this.markSentStmt.run(nullableString(turnId), Date.now(), String(id));
  }

  markFailed(id: string, code: string, reason: string): void {
    this.markFailedStmt.run(String(code ?? "").trim() || "send_failed", String(reason ?? "").trim() || "send failed", Date.now(), String(id));
  }

  /** 业务/provider ACK 后按认领轮次建立屏障；只允许当前 sending attempt 写入。 */
  markPostAckPending(
    id: string,
    code: string,
    reason: string,
    turnId: TurnId | null,
    expectedAttemptCount: number,
  ): boolean {
    const result = this.markPostAckPendingStmt.run(
      nullableString(turnId),
      String(code ?? "").trim(),
      String(reason ?? "").trim(),
      Date.now(),
      String(id),
      Math.max(0, Math.trunc(expectedAttemptCount)),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 更新同一 ACK 屏障的根因；CAS 防止迟到回调污染后续 attempt。 */
  updatePostAckPendingReason(id: string, code: string, reason: string, expectedAttemptCount: number): boolean {
    const result = this.updatePostAckPendingReasonStmt.run(
      String(reason ?? "").trim(),
      Date.now(),
      String(id),
      String(code ?? "").trim(),
      Math.max(0, Math.trunc(expectedAttemptCount)),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 在同一 ACK attempt 内推进屏障阶段，保留 CAS 边界。 */
  transitionPostAckCode(
    id: string,
    fromCode: string,
    toCode: string,
    reason: string,
    expectedAttemptCount: number,
  ): boolean {
    const result = this.transitionPostAckCodeStmt.run(
      String(toCode ?? "").trim(),
      String(reason ?? "").trim(),
      Date.now(),
      String(id),
      String(fromCode ?? "").trim(),
      Math.max(0, Math.trunc(expectedAttemptCount)),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 将 ACK 屏障完成为可幂等命中的 sent 墓碑；调用方负责与消费指针同事务提交。 */
  completePostAck(
    id: string,
    code: string,
    turnId: TurnId | null,
    expectedAttemptCount: number,
  ): boolean {
    const result = this.completePostAckStmt.run(
      nullableString(turnId),
      `${String(code ?? "").trim()}_completed`,
      Date.now(),
      String(id),
      String(code ?? "").trim(),
      Math.max(0, Math.trunc(expectedAttemptCount)),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 释放尚未投递的认领；仅 sending 可原子退回 pending。 */
  releaseClaim(id: string, expectedAttemptCount: number): boolean {
    const result = this.releaseClaimStmt.run(Date.now(), String(id), Math.max(0, Math.trunc(expectedAttemptCount)));
    return Number(result.changes ?? 0) > 0;
  }

  /** 标记正在消费的队列项为 cancelled；仅 sending 状态会被收尾，返回是否生效。 */
  markCancelled(id: string, code: string, reason: string): boolean {
    const result = this.markCancelledStmt.run(
      String(code ?? "").trim() || "cancelled",
      String(reason ?? "").trim() || "cancelled",
      Date.now(),
      String(id),
    );
    return Number(result.changes ?? 0) > 0;
  }

  /** 取消某 thread 的所有活跃队列项（pending/sending），用于 workspace 移除等终止场景。 */
  cancelActiveByThread(threadId: ThreadId, code: string, reason: string): number {
    const result = this.cancelActiveByThreadStmt.run(
      String(code ?? "").trim() || "cancelled",
      String(reason ?? "").trim() || "cancelled",
      Date.now(),
      String(threadId),
    );
    return Number(result.changes ?? 0);
  }

  /** 启动恢复：把所有 sending 项重置为 pending（崩溃时残留）。返回重置数量。 */
  resetAllSending(): number {
    const result = this.resetSendingStmt.run(Date.now());
    return Number(result.changes ?? 0);
  }

  /** 列出所有有 pending 项的 thread id。 */
  listThreadsWithPending(): ThreadId[] {
    const rows = this.listThreadsWithPendingStmt.all() as Array<{ thread_id: string }>;
    return rows.map((r) => String(r.thread_id) as ThreadId);
  }

  // ===== private =====

  private swapWithNeighbor(threadId: ThreadId, queueItemId: string, direction: "up" | "down"): boolean {
    const tx = this.db.transaction(() => {
      const rows = this.listAdjacentActiveStmt.all(String(threadId)) as Array<{ id: string; position: number }>;
      const idx = rows.findIndex((r) => r.id === String(queueItemId));
      if (idx < 0) return false;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= rows.length) return false;
      const a = rows[idx];
      const b = rows[targetIdx];
      // 双 swap 需要避开唯一索引冲突：先把 a 移到一个不冲突的临时位置（负数）
      const now = Date.now();
      const tempPos = -Math.abs(a.position) - 1;
      this.updatePositionStmt.run(tempPos, now, a.id);
      this.updatePositionStmt.run(a.position, now, b.id);
      this.updatePositionStmt.run(b.position, now, a.id);
      return true;
    });
    return Boolean(tx());
  }

  private hydrateItem(row: ItemRow, attachmentRows?: AttachmentRow[]): ThreadMessageQueueItem {
    const atts = attachmentRows ?? (this.listAttachmentsByItemStmt.all(String(row.id)) as AttachmentRow[]);
    const images: ThreadDraftImageAttachment[] = [];
    const files: TextFileAttachment[] = [];
    for (const att of atts) {
      const blob = this.blobs.get(String(att.blob_id ?? ""));
      if (!blob) {
        const blobId = String(att.blob_id ?? "");
        const logKey = `${String(row.id)}:${String(att.id)}:${blobId}`;
        if (!this.loggedMissingAttachmentBlobKeys.has(logKey)) {
          this.loggedMissingAttachmentBlobKeys.add(logKey);
          logger.error("queue", "thread queue attachment blob missing", {
            code: "thread_queue_attachment_blob_missing",
            queueItemId: String(row.id),
            attachmentId: String(att.id),
            attachmentKind: String(att.kind),
            blobId,
          });
        }
        continue;
      }
      const content = blob.data.toString("utf8");
      if (att.kind === "image") {
        images.push({
          id: String(att.id ?? ""),
          name: String(att.name ?? "").trim() || "image",
          dataUrl: content,
          size: Number(att.size ?? 0),
        });
        continue;
      }
      files.push({
        id: String(att.id ?? ""),
        name: String(att.name ?? "").trim() || "file",
        displayName: nullableString(att.display_name),
        mime: String(att.mime ?? ""),
        size: Number(att.size ?? 0),
        text: content,
      });
    }
    let sendOptions: ThreadQueueSendOptions;
    try {
      sendOptions = normalizeQueueSendOptions(JSON.parse(String(row.send_options_json ?? "{}")));
    } catch {
      sendOptions = normalizeQueueSendOptions(null);
    }
    const text = String(row.text ?? "");
    const inputContract = parsePersistedThreadInputContract({
      inputKind: row.input_kind,
      skillMentionsJson: row.skill_mentions_json,
      text,
      entityLabel: `thread queue item ${String(row.id)}`,
    });
    return {
      id: String(row.id),
      threadId: String(row.thread_id) as ThreadId,
      workspaceId: String(row.workspace_id) as WorkspaceId,
      position: Number(row.position ?? 0),
      status: normalizeStatus(row.status),
      text,
      ...inputContract,
      images,
      files,
      pathReferences: parsePathReferencesJson(row.path_references_json),
      sendOptions,
      originWebSessionId: nullableString(row.origin_web_session_id),
      clientItemId: nullableString(row.client_item_id),
      enqueuedAt: Number(row.enqueued_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      sentTurnId: nullableString(row.sent_turn_id) as TurnId | null,
      failureReason: nullableString(row.failure_reason),
      failureCode: nullableString(row.failure_code),
      attemptCount: Number(row.attempt_count ?? 0),
    };
  }
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function optionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 序列化发送选项；共享上下文作为隐藏字段持久化，不参与公开 sendOptions 归一化。 */
function serializeQueueSendOptions(
  sendOptions: ThreadQueueSendOptions,
  sharedContext: ThreadQueueSharedWorkspaceContext | null,
  executionProfile: QueueExecutionProfileContext | null,
  assetAuthorization: OrchAssetExecutionAuthorization | null,
): string {
  return JSON.stringify({
    ...(sendOptions ?? {}),
    ...(sharedContext ? { [SHARED_WORKSPACE_QUEUE_CONTEXT_KEY]: sharedContext } : {}),
    ...(executionProfile ? { [EXECUTION_PROFILE_CONTEXT_KEY]: executionProfile } : {}),
    ...(assetAuthorization ? { [ASSET_EXECUTION_AUTHORIZATION_KEY]: assetAuthorization } : {}),
  });
}

/** 从 send_options_json 还原共享上下文；旧数据或字段不完整时视为普通队列项。 */
function parseSharedWorkspaceQueueContext(value: unknown): ThreadQueueSharedWorkspaceContext | null {
  const parsed = JSON.parse(String(value ?? "{}").trim() || "{}");
  const holder = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const raw = holder[SHARED_WORKSPACE_QUEUE_CONTEXT_KEY];
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const sharedWorkspaceId = nullableString(obj.sharedWorkspaceId);
  const operationId = nullableString(obj.operationId);
  const operationKey = nullableString(obj.operationKey);
  if (!sharedWorkspaceId || !operationId || !operationKey) return null;
  return {
    sharedWorkspaceId,
    operationId: operationId as ThreadQueueSharedWorkspaceContext["operationId"],
    routeEventId: nullableString(obj.routeEventId),
    operationKey: operationKey as ThreadQueueSharedWorkspaceContext["operationKey"],
    toolPolicyKey: nullableString(obj.toolPolicyKey) as ThreadQueueSharedWorkspaceContext["toolPolicyKey"],
    lockToken: nullableString(obj.lockToken),
    lockVersion: optionalNumber(obj.lockVersion),
    allowSharedUpgrade: typeof obj.allowSharedUpgrade === "boolean" ? obj.allowSharedUpgrade : null,
  };
}

function normalizeSize(size: unknown, fallbackText: string): number {
  const parsed = Number(size);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return Buffer.byteLength(String(fallbackText ?? ""), "utf8");
}

/** 读取队列项路径引用 JSON；本地 DB 异常时显式失败，避免消费时丢上下文。 */
function parsePathReferencesJson(value: unknown): WorkspacePathReference[] {
  const raw = String(value ?? "[]").trim() || "[]";
  return normalizeWorkspacePathReferenceList(JSON.parse(raw));
}

function normalizeStatus(s: unknown): ThreadMessageQueueItemStatus {
  const v = String(s ?? "pending");
  if (v === "pending" || v === "sending" || v === "sent" || v === "failed" || v === "cancelled") return v;
  return "pending";
}

/** 兼容老队列 JSON，补齐缺失发送选项并丢弃未知 Fast 档位。 */
function normalizeQueueSendOptions(raw: unknown): ThreadQueueSendOptions {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    workMode: obj.workMode === "general" ? "general" : null,
    planMode: Boolean(obj.planMode),
    accessMode: obj.accessMode === "read-only" || obj.accessMode === "current" || obj.accessMode === "full-access"
      ? obj.accessMode
      : null,
    model: typeof obj.model === "string" ? String(obj.model).trim() || null : null,
    effort: typeof obj.effort === "string" ? String(obj.effort).trim() || null : null,
    contextWindow: typeof obj.contextWindow === "number" && obj.contextWindow > 0 ? Math.round(obj.contextWindow) : null,
    autoCompactPct: typeof obj.autoCompactPct === "number" && obj.autoCompactPct >= 50 && obj.autoCompactPct <= 99
      ? Math.round(obj.autoCompactPct)
      : null,
    serviceTier: obj.serviceTier === "fast" ? "fast" : null,
    roleId: nullableString(obj.roleId) as ThreadQueueSendOptions["roleId"],
    forceNewTurn: obj.forceNewTurn === true,
  };
}

function groupByItemId(rows: AttachmentRow[]): Map<string, AttachmentRow[]> {
  const map = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const key = String(row.queue_item_id ?? "");
    const arr = map.get(key) ?? [];
    arr.push(row);
    map.set(key, arr);
  }
  return map;
}

void ACTIVE_STATUSES;
