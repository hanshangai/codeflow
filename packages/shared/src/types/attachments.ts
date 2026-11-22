import { normalizeWorkspacePathReferenceList } from "./pathReferences.js";

/** 文本文件附件：通过“把内容嵌入到 prompt 文本”方式传递。 */
export type TextFileAttachment = {
  /** 客户端生成的稳定/随机 ID（用于渲染 key 与去重）。 */
  id: string;
  name: string;
  /** 仅用于前端展示；为空时回退到 name。 */
  displayName?: string | null;
  /** MIME；未知时为空字符串。 */
  mime: string;
  /** 原始文件大小（字节）。 */
  size: number;
  /** 文件内容（不允许截断；超限应直接拒绝）。 */
  text: string;
};

/** 作为纯文本内联的常用扩展名；与图片、Office 文档分支互斥。 */
export const TEXT_FILE_ATTACHMENT_EXTENSIONS = [
  "md", "txt", "json", "jsonl", "ndjson", "csv", "tsv",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "properties", "env",
  "log", "out", "err", "trace",
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "css", "scss", "sass", "less", "html", "htm", "xml",
  "java", "kt", "kts", "scala", "groovy", "go", "py", "rb", "php", "rs", "cs", "fs",
  "c", "h", "cpp", "cc", "cxx", "hpp", "swift", "lua", "r", "pl", "dart",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
  "proto", "graphql", "gql", "tf", "tfvars", "hcl", "nix",
  "rst", "tex", "adoc", "gitignore", "dockerignore", "editorconfig",
] as const;
/** 无扩展名但属于纯文本的常见文件名。 */
export const TEXT_FILE_ATTACHMENT_FILE_NAMES = ["dockerfile", "makefile"] as const;

/** 按扩展名或文件名识别纯文本附件；调用方仍可额外接受 text/* MIME。 */
export function isTextFileAttachmentName(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  const baseName = lower.split(/[\\/]/u).pop() ?? lower;
  if ((TEXT_FILE_ATTACHMENT_FILE_NAMES as readonly string[]).includes(baseName)) return true;
  const extension = lower.split(".").pop();
  return typeof extension === "string" && (TEXT_FILE_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension);
}

/** 文档只提取文字，不传原始二进制给引擎；提取结果复用文本附件预算。 */
export const DOCUMENT_ATTACHMENT_EXTENSIONS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"] as const;
export const DOCUMENT_ATTACHMENT_LIMITS = { maxSourceBytes: 20 * 1024 * 1024, timeoutMs: 25_000 } as const;
/** 大文件解析阈值与超时；超过 8MB 的文档给更长的解析时间。 */
export const DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_ATTACHMENT_LARGE_FILE_TIMEOUT_MS = 60_000;
/** 按源文件大小选择解析超时，避免大文档被 25 秒默认值误杀。 */
export function resolveDocumentAttachmentTimeoutMs(sourceBytes: number): number {
  return sourceBytes > DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES
    ? DOCUMENT_ATTACHMENT_LARGE_FILE_TIMEOUT_MS
    : DOCUMENT_ATTACHMENT_LIMITS.timeoutMs;
}
/** 源文件大小覆盖：undefined 使用默认值。 */
export type AttachmentSourceFileSizeLimit = number | undefined;

export type ExtractDocumentAttachmentRequestBody = {
  workspaceId: string;
  fileName: string;
  base64: string;
};

export type ExtractDocumentAttachmentResponseBody = { text: string };

/** 按扩展名识别文档附件，兼容浏览器未提供或误报 MIME 的文件。 */
export function isDocumentAttachmentName(name: string): boolean {
  const extension = String(name).split(".").pop()?.toLowerCase();
  return DOCUMENT_ATTACHMENT_EXTENSIONS.some((item) => item === extension);
}

export type InlineImageAttachmentLike =
  | string
  | {
      id?: string | null;
      name?: string | null;
      dataUrl?: string | null;
      size?: number | null;
    };

export const INLINE_ATTACHMENT_LIMITS = {
  maxImageBytes: 2 * 1024 * 1024,
  maxImageSourceBytes: 12 * 1024 * 1024,
  maxImageTotalBytes: 8 * 1024 * 1024,
  maxImageCount: 10,
  maxTextFileBytes: 2 * 1024 * 1024,
  maxTextFileCount: 6,
  maxTextFileTotalBytes: 4 * 1024 * 1024,
  maxPathReferenceCount: 20,
  // 低于 server 默认 16MB bodyLimit，给 workspaceId/threadId/model 等元数据留余量。
  maxSerializedPayloadBytes: 12 * 1024 * 1024,
} as const;

export type InlineAttachmentBudgetErrorCode =
  | "too_many_images"
  | "image_too_large"
  | "images_total_too_large"
  | "too_many_text_files"
  | "text_file_too_large"
  | "text_files_total_too_large"
  | "text_file_empty"
  | "too_many_path_references"
  | "path_reference_invalid"
  | "payload_too_large";

export type InlineAttachmentBudgetValidationResult =
  | {
      ok: true;
      estimatedPayloadBytes: number;
    }
  | {
      ok: false;
      code: InlineAttachmentBudgetErrorCode;
      message: string;
    };

/**
 * 统一计算 UTF-8 字节数。这里不能依赖 Node Buffer，shared 需要同时跑在浏览器和 Node。
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(String(text ?? "")).length;
}

export function estimateJsonUtf8Bytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value ?? null) ?? "null");
}

export function formatByteSize(bytes: number): string {
  const n = Math.max(0, Math.floor(Number(bytes) || 0));
  const mb = 1024 * 1024;
  const kb = 1024;
  if (n >= mb) {
    const value = n / mb;
    return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}MB`;
  }
  if (n >= kb) {
    const value = n / kb;
    return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}KB`;
  }
  return `${n}B`;
}

export function estimateBinaryBytesFromDataUrl(dataUrl: string): number | null {
  const text = String(dataUrl ?? "");
  const commaIdx = text.indexOf(",");
  if (commaIdx < 0) return null;
  const meta = text.slice(0, commaIdx);
  const payload = text.slice(commaIdx + 1).replace(/\s+/g, "");
  if (!payload) return 0;
  if (!/;base64/i.test(meta)) return utf8ByteLength(payload);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function measureTextFileAttachmentBytes(file: Pick<TextFileAttachment, "text" | "size">): number {
  const declared = normalizeNonNegativeInt((file as { size?: unknown }).size);
  const actual = utf8ByteLength(String((file as { text?: unknown }).text ?? ""));
  if (declared == null) return actual;
  return Math.max(declared, actual);
}

export function validateInlineThreadPayload(
  input: {
    text?: string | null;
    images?: readonly InlineImageAttachmentLike[] | null;
    files?: readonly TextFileAttachment[] | null;
    pathReferences?: unknown;
  },
  opts?: { contextLabel?: string },
): InlineAttachmentBudgetValidationResult {
  const contextLabel = String(opts?.contextLabel ?? "").trim() || "当前内容";
  const images = Array.isArray(input.images) ? input.images : [];
  const files = Array.isArray(input.files) ? input.files : [];
  let pathReferences: ReturnType<typeof normalizeWorkspacePathReferenceList>;
  try {
    pathReferences = normalizeWorkspacePathReferenceList(input.pathReferences);
  } catch (error) {
    return {
      ok: false,
      code: "path_reference_invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (pathReferences.length > INLINE_ATTACHMENT_LIMITS.maxPathReferenceCount) {
    return {
      ok: false,
      code: "too_many_path_references",
      message: `最多只能引用 ${INLINE_ATTACHMENT_LIMITS.maxPathReferenceCount} 个工作区路径`,
    };
  }

  if (images.length > INLINE_ATTACHMENT_LIMITS.maxImageCount) {
    return {
      ok: false,
      code: "too_many_images",
      message: `最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxImageCount} 张图片`,
    };
  }

  for (let i = 0; i < images.length; i += 1) {
    const image = normalizeInlineImage(images[i], i);
    const imageBytes = resolveInlineImageBinaryBytes(image);
    if (imageBytes != null && imageBytes > INLINE_ATTACHMENT_LIMITS.maxImageBytes) {
      return {
        ok: false,
        code: "image_too_large",
        message: `图片文件过大：${image.name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxImageBytes)}）`,
      };
    }
  }
  const totalImageBytes = images.reduce((acc, image, index) => {
    const normalized = normalizeInlineImage(image, index);
    const imageBytes = resolveInlineImageBinaryBytes(normalized);
    return acc + Math.max(0, imageBytes ?? 0);
  }, 0);
  if (totalImageBytes > INLINE_ATTACHMENT_LIMITS.maxImageTotalBytes) {
    return {
      ok: false,
      code: "images_total_too_large",
      message: `图片总大小超过上限（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxImageTotalBytes)}）`,
    };
  }

  if (files.length > INLINE_ATTACHMENT_LIMITS.maxTextFileCount) {
    return {
      ok: false,
      code: "too_many_text_files",
      message: `最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxTextFileCount} 个文本文件`,
    };
  }

  let totalTextBytes = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const name = String(file.name ?? "").trim() || `file_${i + 1}`;
    const text = String(file.text ?? "");
    if (!text.trim()) {
      return {
        ok: false,
        code: "text_file_empty",
        message: `文本文件内容为空：${name}`,
      };
    }
    const bytes = measureTextFileAttachmentBytes(file);
    if (bytes > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
      return {
        ok: false,
        code: "text_file_too_large",
        message: `文本文件过大：${name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}）`,
      };
    }
    totalTextBytes += bytes;
    if (totalTextBytes > INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes) {
      return {
        ok: false,
        code: "text_files_total_too_large",
        message: `文本附件总大小超过上限（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes)}）`,
      };
    }
  }

  const estimatedPayloadBytes = estimateJsonUtf8Bytes({
    text: String(input.text ?? ""),
    images: images.map((image, index) => normalizeInlineImage(image, index)),
    files: files.map((file) => ({
      id: String(file.id ?? ""),
      name: String(file.name ?? ""),
      displayName: file.displayName ?? null,
      mime: String(file.mime ?? ""),
      size: normalizeNonNegativeInt(file.size) ?? 0,
      text: String(file.text ?? ""),
    })),
    pathReferences,
  });
  if (estimatedPayloadBytes > INLINE_ATTACHMENT_LIMITS.maxSerializedPayloadBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      message: `${contextLabel}过大（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxSerializedPayloadBytes)}，请减少图片数量、压缩图片或删减文本/附件）`,
    };
  }

  return {
    ok: true,
    estimatedPayloadBytes,
  };
}

function normalizeInlineImage(image: InlineImageAttachmentLike, index: number): {
  id: string;
  name: string;
  dataUrl: string;
  size: number | null;
} {
  if (typeof image === "string") {
    return {
      id: `img_${index}`,
      name: `图片 ${index + 1}`,
      dataUrl: image,
      size: estimateBinaryBytesFromDataUrl(image),
    };
  }
  return {
    id: String(image?.id ?? "").trim() || `img_${index}`,
    name: String(image?.name ?? "").trim() || `图片 ${index + 1}`,
    dataUrl: String(image?.dataUrl ?? ""),
    size: normalizeNonNegativeInt(image?.size) ?? estimateBinaryBytesFromDataUrl(String(image?.dataUrl ?? "")),
  };
}

function resolveInlineImageBinaryBytes(image: {
  dataUrl: string;
  size: number | null;
}): number | null {
  if (image.size != null) return image.size;
  return estimateBinaryBytesFromDataUrl(image.dataUrl);
}

function normalizeNonNegativeInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const num = Math.floor(parsed);
  return num >= 0 ? num : null;
}

