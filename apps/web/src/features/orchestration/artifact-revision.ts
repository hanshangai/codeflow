import {
  getArtifactRevisionMetadata,
  type Artifact,
  type AttachmentFormat,
  type AttachmentKind,
  type NodeExecutionAttachment,
  type NodeExecutionEnvelope,
  type NodeExecutionFile,
} from "@codeflowai/shared";

export type EditableArtifactFileDraft = {
  id: string;
  key?: string | null;
  path: string;
  content: string;
  summary: string | null;
  kind?: AttachmentKind | null;
  format?: AttachmentFormat | null;
  language?: string | null;
};

export type EditableArtifactDraft =
  | { mode: "text"; summary: string | null; text: string; fields?: Record<string, unknown> | null; attachments?: EditableArtifactFileDraft[] }
  | { mode: "structured"; summary: string | null; jsonText: string; fields?: Record<string, unknown> | null; attachments?: EditableArtifactFileDraft[] }
  | { mode: "file"; summary: string | null; file: EditableArtifactFileDraft; fields?: Record<string, unknown> | null; attachments?: EditableArtifactFileDraft[] }
  | { mode: "file-set"; summary: string | null; files: EditableArtifactFileDraft[]; fields?: Record<string, unknown> | null; attachments?: EditableArtifactFileDraft[] };

export type ArtifactRevisionSubmission = {
  answer: NodeExecutionEnvelope;
  workspaceFiles: Array<{
    path: string;
    content: string;
  }> | null;
};

export function parseArtifactEnvelope(artifact: Pick<Artifact, "contentJson">): NodeExecutionEnvelope {
  try {
    const parsed = JSON.parse(String(artifact.contentJson ?? "{}")) as Record<string, any>;
    const mode = String(parsed.mode ?? "").trim();
    if (mode === "structured") {
      return {
        mode: "structured",
        data: parsed.data ?? {},
        summary: nullableString(parsed.summary),
        changedFiles: normalizeStringArray(parsed.changedFiles),
        fields: normalizeRecord(parsed.fields),
        attachments: normalizeAttachments(parsed.attachments),
      };
    }
    if (mode === "file") {
      return {
        mode: "file",
        file: {
          key: nullableString(parsed.file?.key),
          path: String(parsed.file?.path ?? "result.md"),
          content: String(parsed.file?.content ?? ""),
          summary: nullableString(parsed.file?.summary),
        },
        summary: nullableString(parsed.summary),
        changedFiles: normalizeStringArray(parsed.changedFiles),
        fields: normalizeRecord(parsed.fields),
        attachments: normalizeAttachments(parsed.attachments),
      };
    }
    if (mode === "file-set") {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      return {
        mode: "file-set",
        files: files.map((file, index) => ({
          key: nullableString(file?.key),
          path: String(file?.path ?? `result-${index + 1}.md`),
          content: String(file?.content ?? ""),
          summary: nullableString(file?.summary),
        })),
        summary: nullableString(parsed.summary),
        changedFiles: normalizeStringArray(parsed.changedFiles),
        fields: normalizeRecord(parsed.fields),
        attachments: normalizeAttachments(parsed.attachments),
      };
    }
    if (mode === "text") {
      return {
        mode: "text",
        text: String(parsed.text ?? parsed.content ?? ""),
        summary: nullableString(parsed.summary),
        changedFiles: normalizeStringArray(parsed.changedFiles),
        fields: normalizeRecord(parsed.fields),
        attachments: normalizeAttachments(parsed.attachments),
      };
    }
  } catch {
    // Fall through to text envelope.
  }

  return {
    mode: "text",
    text: String(artifact.contentJson ?? ""),
    summary: null,
    changedFiles: null,
  };
}

export function buildEditableArtifactDraft(artifact: Artifact): EditableArtifactDraft {
  const envelope = parseArtifactEnvelope(artifact);
  const summary = nullableString(envelope.summary);
  const fields = normalizeRecord(envelope.fields);
  const attachments = (envelope.attachments ?? []).map((file, index) => toEditableAttachmentDraft(file, index));

  if (envelope.mode === "structured") {
    return {
      mode: "structured",
      summary,
      jsonText: JSON.stringify(envelope.data ?? {}, null, 2),
      fields,
      attachments,
    };
  }

  if (envelope.mode === "file") {
    return {
      mode: "file",
      summary,
      file: toEditableFileDraft(envelope.file, 0),
      fields,
      attachments,
    };
  }

  if (envelope.mode === "file-set") {
    return {
      mode: "file-set",
      summary,
      files: envelope.files.map((file, index) => toEditableFileDraft(file, index)),
      fields,
      attachments,
    };
  }

  return {
    mode: "text",
    summary,
    text: envelope.text,
    fields,
    attachments,
  };
}

export function buildArtifactRevisionSubmission(
  draft: EditableArtifactDraft,
  options?: { previousDraft?: EditableArtifactDraft | null },
): ArtifactRevisionSubmission {
  if (draft.mode === "text") {
    return {
      answer: appendEnvelopeExtras({
        mode: "text",
        text: draft.text,
        summary: nullableString(draft.summary),
        changedFiles: null,
      }, draft),
      workspaceFiles: null,
    };
  }

  if (draft.mode === "structured") {
    const jsonText = draft.jsonText.trim();
    if (!jsonText) {
      throw new Error("结构化结果不能为空");
    }
    try {
      return {
        answer: appendEnvelopeExtras({
          mode: "structured",
          data: JSON.parse(jsonText),
          summary: nullableString(draft.summary),
          changedFiles: null,
        }, draft),
        workspaceFiles: null,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? `JSON 解析失败：${error.message}` : "JSON 解析失败");
    }
  }

  if (draft.mode === "file") {
    const filePath = String(draft.file.path ?? "").trim();
    if (!filePath) {
      throw new Error("文件路径不能为空");
    }
    return {
      answer: appendEnvelopeExtras({
        mode: "file",
        file: {
          ...fileKeyPatch(draft.file.key),
          path: filePath,
          summary: nullableString(draft.file.summary),
        },
        summary: nullableString(draft.summary),
        changedFiles: [filePath],
      }, draft),
      workspaceFiles: [{
        path: filePath,
        content: draft.file.content,
      }],
    };
  }

  const files = draft.files
    .map((file) => ({
      key: nullableString(file.key),
      path: String(file.path ?? "").trim(),
      summary: nullableString(file.summary),
      content: file.content,
    }))
    .filter((file) => file.path);
  if (!files.length) {
    throw new Error("至少要保留一个文件");
  }
  const previousDraft = options?.previousDraft ?? null;
  const previousByPath = buildPreviousFileContentMap(previousDraft);
  const changedFilePaths = resolveChangedFilePathsForFileSet(files, previousDraft);
  const changedWorkspaceFiles = files.filter((file) => previousByPath.get(file.path) !== file.content);
  const workspaceFiles = changedWorkspaceFiles.length
    ? changedWorkspaceFiles
    : files.slice(0, 1);
  return {
    answer: appendEnvelopeExtras({
      mode: "file-set",
      files: files.map((file) => ({
        ...fileKeyPatch(file.key),
        path: file.path,
        summary: file.summary,
      })),
      summary: nullableString(draft.summary),
      changedFiles: changedFilePaths.length ? changedFilePaths : null,
    }, draft),
    workspaceFiles: workspaceFiles.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

export function createEmptyEditableArtifactFileDraft(index: number): EditableArtifactFileDraft {
  return {
    id: buildDraftFileId(index, `new-file-${index + 1}.md`),
    key: null,
    path: `new-file-${index + 1}.md`,
    content: "",
    summary: null,
    format: null,
  };
}

export function cloneEditableArtifactDraft(draft: EditableArtifactDraft): EditableArtifactDraft {
  if (draft.mode === "file") {
    return {
      ...draft,
      file: { ...draft.file },
      attachments: draft.attachments?.map((file) => ({ ...file })),
    };
  }
  if (draft.mode === "file-set") {
    return {
      ...draft,
      files: draft.files.map((file) => ({ ...file })),
      attachments: draft.attachments?.map((file) => ({ ...file })),
    };
  }
  return {
    ...draft,
    attachments: draft.attachments?.map((file) => ({ ...file })),
  };
}

export function formatArtifactRevisionCaption(artifact: Artifact): string | null {
  const revision = getArtifactRevisionMetadata(artifact);
  if (!revision) return null;
  if (revision.source === "human") {
    const note = formatRevisionNoteForDisplay(String(revision.note ?? "").trim());
    const basedOn = revision.basedOnVersion ? `基于 v${revision.basedOnVersion}` : "人工修订";
    return note ? `${basedOn} · ${note}` : basedOn;
  }
  return null;
}

export function buildDefaultArtifactRevisionNote(
  draft: EditableArtifactDraft,
  options?: { previousDraft?: EditableArtifactDraft | null; changedFiles?: string[] | null },
): string {
  if (draft.mode === "file") {
    const filePath = String(draft.file.path ?? "").trim();
    const fileName = toDisplayFileName(filePath);
    return filePath
      ? `人工直接修改了文件 ${fileName}，请以后续最新版本为准。`
      : "人工直接修改了当前交付文件，请以后续最新版本为准。";
  }
  if (draft.mode === "file-set") {
    const changedFromAnswer = normalizeStringArray(options?.changedFiles);
    const changedByCompare = resolveChangedFilePathsForFileSet(
      draft.files.map((file) => ({
        path: String(file.path ?? "").trim(),
        content: file.content,
      })).filter((file) => file.path),
      options?.previousDraft ?? null,
    );
    const filePaths = changedFromAnswer ?? changedByCompare;
    if (!filePaths.length) {
      return "人工确认了当前交付文件，未发现内容变化，请以后续最新版本为准。";
    }
    const visible = filePaths.slice(0, 3).map(toDisplayFileName).join("、");
    const suffix = filePaths.length > 3 ? ` 等 ${filePaths.length} 个文件` : "";
    return `人工直接修改了交付文件 ${visible}${suffix}，请以后续最新版本为准。`;
  }
  return "人工直接修改了当前交付内容，请以后续最新版本为准。";
}

function toEditableFileDraft(file: NodeExecutionFile, index: number): EditableArtifactFileDraft {
  return {
    id: buildDraftFileId(index, file.path),
    key: nullableString(file.key),
    path: String(file.path ?? ""),
    content: String(file.content ?? ""),
    summary: nullableString(file.summary),
    format: null,
  };
}

/** 将附件保存为独立草稿项，避免人工修订时混入正式交付物 files。 */
function toEditableAttachmentDraft(file: NodeExecutionAttachment, index: number): EditableArtifactFileDraft {
  return {
    id: buildDraftFileId(index, file.path),
    key: nullableString(file.key),
    path: String(file.path ?? ""),
    content: String(file.content ?? ""),
    summary: nullableString(file.summary),
    kind: normalizeAttachmentKind(file.kind),
    format: normalizeAttachmentFormat(file.format),
    language: nullableString(file.language),
  };
}

function buildDraftFileId(index: number, path: string): string {
  const normalizedPath = String(path ?? "").trim().replace(/[^a-zA-Z0-9._/-]/g, "_");
  return normalizedPath ? `file_${index}_${normalizedPath}` : `file_${index}`;
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return items.length ? items : null;
}

function normalizeAttachments(raw: unknown): NodeExecutionAttachment[] | null {
  if (!Array.isArray(raw)) return null;
  const attachments = raw.map((file, index) => ({
    key: nullableString(file?.key),
    path: String(file?.path ?? `attachment-${index + 1}.txt`),
    content: String(file?.content ?? ""),
    summary: nullableString(file?.summary),
    kind: normalizeAttachmentKind(file?.kind),
    format: normalizeAttachmentFormat(file?.format),
    language: nullableString(file?.language),
  }));
  return attachments.length ? attachments : null;
}

function normalizeRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : null;
}

function nullableString(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value ? value : null;
}

function fileKeyPatch(key: unknown): { key?: string } {
  const value = nullableString(key);
  return value ? { key: value } : {};
}

function appendEnvelopeExtras<T extends NodeExecutionEnvelope>(
  answer: T,
  draft: { fields?: Record<string, unknown> | null; attachments?: EditableArtifactFileDraft[] },
): T {
  const fields = normalizeRecord(draft.fields);
  const attachments = toExecutionAttachments(draft.attachments);
  return {
    ...answer,
    ...(fields ? { fields } : {}),
    ...(attachments.length ? { attachments } : {}),
  } as T;
}

function toExecutionAttachments(raw: EditableArtifactFileDraft[] | null | undefined): NodeExecutionAttachment[] {
  const attachments: NodeExecutionAttachment[] = [];
  for (const file of raw ?? []) {
    const filePath = String(file.path ?? "").trim();
    if (!filePath) continue;
    attachments.push({
      ...fileKeyPatch(file.key),
      path: filePath,
      summary: nullableString(file.summary),
      kind: normalizeAttachmentKind(file.kind),
      format: normalizeAttachmentFormat(file.format),
      language: nullableString(file.language),
    });
  }
  return attachments;
}

const ATTACHMENT_KINDS = new Set<AttachmentKind>([
  "source",
  "document",
  "data",
  "image",
  "diff",
  "patch",
  "log",
  "archive",
  "binary",
  "unknown",
]);

const ATTACHMENT_FORMATS = new Set<AttachmentFormat>([
  "markdown",
  "json",
  "yaml",
  "text",
  "html",
  "javascript",
  "css",
  "sql",
  "image",
  "source",
  "diff",
  "patch",
  "log",
  "binary",
  "archive",
  "unknown",
]);

/** 归一化人工修订附件用途；未知值不写回，交给提交校验返回明确错误。 */
function normalizeAttachmentKind(input: unknown): AttachmentKind | null {
  const value = nullableString(input);
  return value && ATTACHMENT_KINDS.has(value as AttachmentKind) ? value as AttachmentKind : null;
}

/** 归一化人工修订附件兼容格式；未知值不写回，交给提交校验返回明确错误。 */
function normalizeAttachmentFormat(input: unknown): AttachmentFormat | null {
  const value = nullableString(input);
  return value && ATTACHMENT_FORMATS.has(value as AttachmentFormat) ? value as AttachmentFormat : null;
}

function buildPreviousFileContentMap(previousDraft: EditableArtifactDraft | null): Map<string, string> {
  if (!previousDraft || previousDraft.mode !== "file-set") return new Map();
  const map = new Map<string, string>();
  for (const file of previousDraft.files) {
    const filePath = String(file.path ?? "").trim();
    if (!filePath || map.has(filePath)) continue;
    map.set(filePath, String(file.content ?? ""));
  }
  return map;
}

function resolveChangedFilePathsForFileSet(
  currentFiles: Array<{ path: string; content: string }>,
  previousDraft: EditableArtifactDraft | null,
): string[] {
  const changed: string[] = [];
  const changedSet = new Set<string>();
  const previousFiles = previousDraft?.mode === "file-set" ? previousDraft.files : [];
  const previousByPath = buildPreviousFileContentMap(previousDraft);
  const currentByPath = new Map<string, string>();

  for (const file of currentFiles) {
    const filePath = String(file.path ?? "").trim();
    if (!filePath) continue;
    if (!currentByPath.has(filePath)) {
      currentByPath.set(filePath, String(file.content ?? ""));
    }
    const previousContent = previousByPath.get(filePath);
    if (previousContent !== String(file.content ?? "")) {
      pushUniqueChangedPath(changed, changedSet, filePath);
    }
  }

  for (const previous of previousFiles) {
    const filePath = String(previous.path ?? "").trim();
    if (!filePath || currentByPath.has(filePath)) continue;
    pushUniqueChangedPath(changed, changedSet, filePath);
  }

  return changed;
}

function pushUniqueChangedPath(changed: string[], changedSet: Set<string>, filePath: string): void {
  if (!filePath || changedSet.has(filePath)) return;
  changedSet.add(filePath);
  changed.push(filePath);
}

function toDisplayFileName(filePath: string): string {
  const normalized = String(filePath ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "未命名文件";
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function formatRevisionNoteForDisplay(note: string): string {
  const normalizedNote = String(note ?? "").trim();
  if (!normalizedNote) return "";
  const commonSuffix = "，请以后续最新版本为准。";

  const singlePrefix = "人工直接修改了文件 ";
  if (normalizedNote.startsWith(singlePrefix) && normalizedNote.endsWith(commonSuffix)) {
    const filePath = normalizedNote.slice(singlePrefix.length, normalizedNote.length - commonSuffix.length).trim();
    return `${singlePrefix}${toDisplayFileName(filePath)}${commonSuffix}`;
  }

  const multiPrefix = "人工直接修改了交付文件 ";
  if (normalizedNote.startsWith(multiPrefix) && normalizedNote.endsWith(commonSuffix)) {
    const payload = normalizedNote.slice(multiPrefix.length, normalizedNote.length - commonSuffix.length).trim();
    const match = payload.match(/^(.*?)( 等 \d+ 个文件)?$/u);
    const namesPart = String(match?.[1] ?? payload).trim();
    const countSuffix = String(match?.[2] ?? "").trim();
    const names = namesPart
      .split("、")
      .map((item) => toDisplayFileName(item))
      .filter(Boolean);
    const visible = names.join("、");
    const suffix = countSuffix ? ` ${countSuffix}` : "";
    return `${multiPrefix}${visible}${suffix}${commonSuffix}`;
  }

  return normalizedNote;
}

