import type {
  CodexSkillMentionBinding,
  TextFileAttachment,
  ThreadDraft,
  ThreadDraftImageAttachment,
  ThreadId,
  ThreadInputKind,
  WorkspacePathReference,
  WorkspaceId,
} from "@codeflowai/shared";
import { normalizeWorkspacePathReferenceList } from "@codeflowai/shared";

import type { FileBlobRepo } from "./fileBlobRepo.js";
import type { SqliteDb } from "../sqliteTypes.js";
import {
  parsePersistedThreadInputContract,
  projectThreadInputContractFields,
  serializePersistedThreadInputContract,
} from "../../engines/threadInputActions.js";

type DraftRow = {
  thread_id: string;
  workspace_id: string;
  text: string;
  path_references_json: string;
  input_kind: string | null;
  skill_mentions_json: string;
  version: number;
  updated_at: number;
  updated_by_web_session_id: string | null;
};

type AttachmentRow = {
  thread_id: string;
  attachment_id: string;
  kind: string;
  order_index: number;
  name: string;
  display_name: string | null;
  mime: string | null;
  size: number;
  blob_id: string;
};

export type PersistedThreadDraft = ThreadDraft & {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
};

export class ThreadDraftRepo {
  private readonly getDraftStmt;
  private readonly listAttachmentsStmt;
  private readonly upsertDraftStmt;
  private readonly deleteDraftStmt;
  private readonly deleteAttachmentsStmt;
  private readonly insertAttachmentStmt;
  private readonly saveTx;

  constructor(
    private readonly db: SqliteDb,
    private readonly blobs: FileBlobRepo,
  ) {
    this.getDraftStmt = this.db.prepare(
      `SELECT thread_id, workspace_id, text, path_references_json, input_kind, skill_mentions_json,
              version, updated_at, updated_by_web_session_id
         FROM thread_drafts
        WHERE thread_id = ?`,
    );
    this.listAttachmentsStmt = this.db.prepare(
      `SELECT thread_id, attachment_id, kind, order_index, name, display_name, mime, size, blob_id
         FROM thread_draft_attachments
        WHERE thread_id = ?
        ORDER BY kind ASC, order_index ASC`,
    );
    this.upsertDraftStmt = this.db.prepare(
      `INSERT INTO thread_drafts (
         thread_id, workspace_id, text, path_references_json, input_kind, skill_mentions_json,
         version, updated_at, updated_by_web_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         text = excluded.text,
         path_references_json = excluded.path_references_json,
         input_kind = excluded.input_kind,
         skill_mentions_json = excluded.skill_mentions_json,
         version = excluded.version,
         updated_at = excluded.updated_at,
         updated_by_web_session_id = excluded.updated_by_web_session_id`,
    );
    this.deleteDraftStmt = this.db.prepare("DELETE FROM thread_drafts WHERE thread_id = ?");
    this.deleteAttachmentsStmt = this.db.prepare("DELETE FROM thread_draft_attachments WHERE thread_id = ?");
    this.insertAttachmentStmt = this.db.prepare(
      `INSERT INTO thread_draft_attachments (
         thread_id, attachment_id, kind, order_index, name, display_name, mime, size, blob_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.saveTx = this.db.transaction((input: {
      workspaceId: WorkspaceId;
      threadId: ThreadId;
      text: string;
      images: ThreadDraftImageAttachment[];
      files: TextFileAttachment[];
      pathReferences: WorkspacePathReference[];
      inputKind?: ThreadInputKind;
      skillMentions?: CodexSkillMentionBinding[];
      updatedByWebSessionId?: string | null;
    }) => {
      const current = this.getDraftStmt.get(String(input.threadId)) as DraftRow | undefined;
      const version = Number(current?.version ?? 0) + 1;
      const updatedAt = Date.now();
      const updatedByWebSessionId = nullableString(input.updatedByWebSessionId);
      const text = String(input.text ?? "");
      const pathReferences = normalizeWorkspacePathReferenceList(input.pathReferences);
      const inputContract = serializePersistedThreadInputContract(
        projectThreadInputContractFields(input),
        text,
      );
      const normalizedInputContract = parsePersistedThreadInputContract({
        inputKind: inputContract.inputKind,
        skillMentionsJson: inputContract.skillMentionsJson,
        text,
        entityLabel: `thread draft ${String(input.threadId)}`,
      });

      this.upsertDraftStmt.run(
        String(input.threadId),
        String(input.workspaceId),
        text,
        JSON.stringify(pathReferences),
        inputContract.inputKind,
        inputContract.skillMentionsJson,
        version,
        updatedAt,
        updatedByWebSessionId,
      );
      // 先收集老 attachment 的 blob_id，删除后批量 GC（事务内串行，无并发问题）
      const oldBlobIds = (this.listAttachmentsStmt.all(String(input.threadId)) as AttachmentRow[]).map((a) => String(a.blob_id ?? "")).filter(Boolean);
      this.deleteAttachmentsStmt.run(String(input.threadId));
      this.blobs.tryDeleteIfUnreferencedMany(oldBlobIds);

      input.images.forEach((image, index) => {
        const dataUrl = String(image.dataUrl ?? "");
        const blobId = this.blobs.put(Buffer.from(dataUrl, "utf8"), "utf8");
        this.insertAttachmentStmt.run(
          String(input.threadId),
          String(image.id ?? "").trim() || `img_${index}`,
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
          String(input.threadId),
          String(file.id ?? "").trim() || `file_${index}`,
          "text-file",
          index,
          String(file.name ?? "").trim() || "file",
          nullableString(file.displayName),
          String(file.mime ?? "").trim(),
          normalizeSize(file.size, textContent),
          blobId,
        );
      });

      return {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        text,
        ...normalizedInputContract,
        images: input.images.map(cloneImageAttachment),
        files: input.files.map(cloneTextFileAttachment),
        pathReferences,
        version,
        updatedAt,
        updatedByWebSessionId,
      } satisfies PersistedThreadDraft;
    });
  }

  get(threadId: ThreadId): PersistedThreadDraft | null {
    const row = this.getDraftStmt.get(String(threadId)) as DraftRow | undefined;
    if (!row) return null;

    const images: ThreadDraftImageAttachment[] = [];
    const files: TextFileAttachment[] = [];
    const attachmentRows = this.listAttachmentsStmt.all(String(threadId)) as AttachmentRow[];
    const text = String(row.text ?? "");
    const inputContract = parsePersistedThreadInputContract({
      inputKind: row.input_kind,
      skillMentionsJson: row.skill_mentions_json,
      text,
      entityLabel: `thread draft ${String(row.thread_id)}`,
    });
    for (const attachment of attachmentRows) {
      const blob = this.blobs.get(String(attachment.blob_id ?? ""));
      if (!blob) continue;
      const content = blob.data.toString("utf8");
      if (attachment.kind === "image") {
        images.push({
          id: String(attachment.attachment_id ?? ""),
          name: String(attachment.name ?? ""),
          dataUrl: content,
          size: Number(attachment.size ?? 0),
        });
        continue;
      }
      files.push({
        id: String(attachment.attachment_id ?? ""),
        name: String(attachment.name ?? ""),
        displayName: nullableString(attachment.display_name),
        mime: String(attachment.mime ?? ""),
        size: Number(attachment.size ?? 0),
        text: content,
      });
    }

    return {
      workspaceId: row.workspace_id as WorkspaceId,
      threadId: row.thread_id as ThreadId,
      text,
      ...inputContract,
      images,
      files,
      pathReferences: parsePathReferencesJson(row.path_references_json),
      version: Number(row.version ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      updatedByWebSessionId: nullableString(row.updated_by_web_session_id),
    };
  }

  save(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    text: string;
    images: ThreadDraftImageAttachment[];
    files: TextFileAttachment[];
    pathReferences: WorkspacePathReference[];
    inputKind?: ThreadInputKind;
    skillMentions?: CodexSkillMentionBinding[];
    updatedByWebSessionId?: string | null;
  }): PersistedThreadDraft {
    return this.saveTx(input) as PersistedThreadDraft;
  }

  clear(threadId: ThreadId): void {
    // 收集 attachment 的 blob_id 后再删 draft（FK cascade 会同时清 attachment 表）；
    // 删除完成后做引用计数 GC，避免 file_blobs 在 cancelled 后无限累积。
    const blobIds = (this.listAttachmentsStmt.all(String(threadId)) as AttachmentRow[])
      .map((a) => String(a.blob_id ?? ""))
      .filter(Boolean);
    this.deleteDraftStmt.run(String(threadId));
    if (blobIds.length > 0) this.blobs.tryDeleteIfUnreferencedMany(blobIds);
  }
}

function cloneImageAttachment(attachment: ThreadDraftImageAttachment): ThreadDraftImageAttachment {
  return {
    id: String(attachment.id ?? ""),
    name: String(attachment.name ?? ""),
    dataUrl: String(attachment.dataUrl ?? ""),
    size: Number(attachment.size ?? 0),
  };
}

function cloneTextFileAttachment(file: TextFileAttachment): TextFileAttachment {
  return {
    id: String(file.id ?? ""),
    name: String(file.name ?? ""),
    displayName: nullableString(file.displayName),
    mime: String(file.mime ?? ""),
    size: Number(file.size ?? 0),
    text: String(file.text ?? ""),
  };
}

function normalizeSize(size: unknown, fallbackText: string): number {
  const parsed = Number(size);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return Buffer.byteLength(String(fallbackText ?? ""), "utf8");
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 读取草稿路径引用 JSON；本地 DB 内容异常时显式失败，避免静默丢引用。 */
function parsePathReferencesJson(value: unknown): WorkspacePathReference[] {
  const raw = String(value ?? "[]").trim() || "[]";
  return normalizeWorkspacePathReferenceList(JSON.parse(raw));
}
