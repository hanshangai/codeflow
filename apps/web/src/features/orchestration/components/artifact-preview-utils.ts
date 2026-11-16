import type { Artifact, ArtifactFileEntry } from "@codeflowai/shared";

export type ArtifactPreviewRenderMode = "markdown" | "html" | "spreadsheet" | "document" | "raw";

export type ArtifactPresentationFile = {
  filePath: string;
  content: string;
  renderMode: ArtifactPreviewRenderMode;
  workspacePreviewPath: string | null;
  fileRole?: "contract" | "attachment";
  fileKey?: string | null;
  summary?: string | null;
  format?: string | null;
};

export type ArtifactPresentation = ArtifactPresentationFile & {
  files: ArtifactPresentationFile[];
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);
const SPREADSHEET_EXTS = new Set(["xlsx", "xlsm", "xls", "csv", "tsv"]);
const DOCUMENT_EXTS = new Set(["pdf", "docx", "pptx"]);

type ParsedArtifactFile = {
  key?: string | null;
  path?: string | null;
  content?: string | null;
  summary?: string | null;
  format?: string | null;
};

export function buildArtifactPresentation(
  artifact: Artifact | null,
  artifactFiles: ArtifactFileEntry[] = [],
): ArtifactPresentation {
  if (!artifact) {
    return {
      filePath: "result.md",
      content: "",
      renderMode: "markdown",
      workspacePreviewPath: null,
      files: [],
    };
  }

  try {
    const parsed = JSON.parse(String(artifact.contentJson ?? "{}")) as {
      mode?: string;
      text?: string;
      data?: unknown;
      file?: ParsedArtifactFile;
      files?: ParsedArtifactFile[];
      attachments?: ParsedArtifactFile[];
    };
    const attachmentFiles = buildAttachmentPresentationFiles(artifact, artifactFiles, parsed.attachments);

    if (parsed.mode === "structured") {
      const primary = {
        filePath: `${artifact.kind || "result"}.json`,
        content: JSON.stringify(parsed.data ?? {}, null, 2),
        renderMode: "raw" as const,
        workspacePreviewPath: null,
        fileRole: "contract" as const,
        fileKey: null,
        summary: null,
        format: "json",
      };
      return {
        ...primary,
        files: attachmentFiles.length ? [primary, ...attachmentFiles] : [],
      };
    }

    if (parsed.mode === "file-set") {
      const files = [
        ...(parsed.files ?? []).map((file, index) => buildPresentationFile(
          artifact,
          artifactFiles,
          String(file.path ?? `file-${index + 1}.txt`),
          String(file.content ?? ""),
          {
            fileRole: "contract",
            fileKey: nullableString(file.key),
            summary: nullableString(file.summary),
            format: nullableString(file.format),
          },
        )),
        ...attachmentFiles,
      ];
      const first = files[0] ?? buildPresentationFile(
        artifact,
        artifactFiles,
        `${artifact.kind || "result"}.txt`,
        "",
      );
      return {
        ...first,
        files,
      };
    }

    if (parsed.mode === "file") {
      const filePath = String(parsed.file?.path ?? artifact.publishedPath ?? artifact.stagingPath ?? `${artifact.kind || "result"}.md`);
      const primary = buildPresentationFile(
        artifact,
        artifactFiles,
        filePath,
        String(parsed.file?.content ?? ""),
        {
          fileRole: "contract",
          fileKey: nullableString(parsed.file?.key),
          summary: nullableString(parsed.file?.summary),
          format: nullableString(parsed.file?.format),
        },
      );
      return {
        ...primary,
        files: attachmentFiles.length ? [primary, ...attachmentFiles] : [],
      };
    }

    const primary = {
      filePath: `${artifact.kind || "result"}.md`,
      content: String(parsed.text ?? "") || String(artifact.contentJson ?? ""),
      renderMode: "markdown" as const,
      workspacePreviewPath: null,
      fileRole: "contract" as const,
      fileKey: null,
      summary: null,
      format: "markdown",
    };
    return {
      ...primary,
      files: attachmentFiles.length ? [primary, ...attachmentFiles] : [],
    };
  } catch {
    return {
      filePath: `${artifact.kind || "result"}.md`,
      content: String(artifact.contentJson ?? "").trim(),
      renderMode: "markdown",
      workspacePreviewPath: null,
      files: [],
    };
  }
}

export function inferArtifactRenderMode(filePath: string): ArtifactPreviewRenderMode {
  if (/\.(md|markdown|mdx)$/iu.test(filePath)) return "markdown";
  if (/\.(html|htm)$/iu.test(filePath)) return "html";
  if (/\.(xlsx|xlsm|xls|csv|tsv)$/iu.test(filePath)) return "spreadsheet";
  if (/\.(pdf|docx|pptx)$/iu.test(filePath)) return "document";
  return "raw";
}

export function isImageArtifactPath(filePath: string): boolean {
  const ext = normalizePath(filePath).split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/** 判断产物路径是否可按表格文件预览。 */
export function isSpreadsheetArtifactPath(filePath: string): boolean {
  const ext = normalizePath(filePath).split(".").pop()?.toLowerCase() ?? "";
  return SPREADSHEET_EXTS.has(ext);
}

/** 判断产物路径是否可按文档文件预览。 */
export function isDocumentArtifactPath(filePath: string): boolean {
  const ext = normalizePath(filePath).split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_EXTS.has(ext);
}

export function resolveArtifactWorkspacePreviewPath(
  artifact: Artifact,
  filePath: string,
  artifactFiles: ArtifactFileEntry[] = [],
): string | null {
  return resolveArtifactWorkspacePreviewPathInternal(artifact, filePath, artifactFiles, true);
}

function resolveArtifactWorkspacePreviewPathInternal(
  artifact: Artifact,
  filePath: string,
  artifactFiles: ArtifactFileEntry[],
  allowSingleFallback: boolean,
): string | null {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedBaseDir = normalizePath(artifact.workspaceBaseDir ?? "");
  const match = findArtifactFileEntry(artifact, filePath, artifactFiles, allowSingleFallback);

  if (match) {
    return match.publishedPath
      ?? match.stagingPath
      ?? joinPosix(normalizedBaseDir, match.relPath)
      ?? null;
  }

  if (allowSingleFallback && artifactFiles.length === 1) {
    const only = artifactFiles[0];
    return only.publishedPath
      ?? only.stagingPath
      ?? joinPosix(normalizedBaseDir, only.relPath)
      ?? null;
  }

  if (artifact.payloadMode === "file") {
    if (artifact.publishedPath) return artifact.publishedPath;
    if (artifact.stagingPath) return artifact.stagingPath;
  }

  if (!normalizedFilePath || normalizedFilePath.startsWith("..")) return null;
  if (normalizedBaseDir && normalizedFilePath.startsWith(`${normalizedBaseDir}/`)) {
    return normalizedFilePath;
  }
  return null;
}

function buildPresentationFile(
  artifact: Artifact,
  artifactFiles: ArtifactFileEntry[],
  filePath: string,
  content: string,
  fallback?: {
    fileRole?: "contract" | "attachment";
    fileKey?: string | null;
    summary?: string | null;
    format?: string | null;
  },
): ArtifactPresentationFile {
  const allowSingleFallback = fallback?.fileRole !== "attachment";
  const metadata = findArtifactFileEntry(artifact, filePath, artifactFiles, allowSingleFallback);
  return {
    filePath,
    content,
    renderMode: inferArtifactRenderMode(filePath),
    workspacePreviewPath: resolveArtifactWorkspacePreviewPathInternal(artifact, filePath, artifactFiles, allowSingleFallback),
    fileRole: fallback?.fileRole ?? metadata?.fileRole ?? "contract",
    fileKey: fallback?.fileKey ?? metadata?.fileKey ?? null,
    summary: fallback?.summary ?? metadata?.summary ?? null,
    format: fallback?.format ?? metadata?.format ?? null,
  };
}

/** 把动态附件转成可预览文件；附件不是角色 delivery_files 的正式交付物。 */
function buildAttachmentPresentationFiles(
  artifact: Artifact,
  artifactFiles: ArtifactFileEntry[],
  attachments: ParsedArtifactFile[] | null | undefined,
): ArtifactPresentationFile[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((file, index) => buildPresentationFile(
    artifact,
    artifactFiles,
    String(file.path ?? `attachment-${index + 1}.txt`),
    String(file.content ?? ""),
    {
      fileRole: "attachment",
      fileKey: nullableString(file.key),
      summary: nullableString(file.summary),
      format: nullableString(file.format),
    },
  ));
}

/** 按路径解析文件索引元数据；单文件旧数据允许回退到唯一索引。 */
function findArtifactFileEntry(
  artifact: Artifact,
  filePath: string,
  artifactFiles: ArtifactFileEntry[],
  allowSingleFallback: boolean,
): ArtifactFileEntry | null {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedBaseDir = normalizePath(artifact.workspaceBaseDir ?? "");
  const match = artifactFiles.find((entry) => {
    const relPath = normalizePath(entry.relPath);
    const publishedPath = normalizePath(entry.publishedPath ?? "");
    const stagingPath = normalizePath(entry.stagingPath ?? "");
    const baseJoinedPath = joinPosix(normalizedBaseDir, relPath) ?? "";
    return normalizedFilePath === relPath
      || normalizedFilePath === publishedPath
      || normalizedFilePath === stagingPath
      || normalizedFilePath === baseJoinedPath;
  });
  if (match) return match;
  return allowSingleFallback && artifactFiles.length === 1 ? artifactFiles[0] : null;
}

function normalizePath(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+/g, "/");
}

function nullableString(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value ? value : null;
}

function joinPosix(left: string, right: string | null | undefined): string | null {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (!normalizedLeft) return normalizedRight || null;
  if (!normalizedRight) return normalizedLeft || null;
  return `${normalizedLeft.replace(/\/$/u, "")}/${normalizedRight.replace(/^\/+/u, "")}`;
}
