import crypto from "node:crypto";

import {
  formatByteSize,
  formatWorkspacePathMention,
  INLINE_ATTACHMENT_LIMITS,
  measureTextFileAttachmentBytes,
  normalizeWorkspacePathReferenceList,
  type TextFileAttachment,
} from "@codeflowai/shared";

type PromptTextFileLike = {
  name: string;
  text: string;
};

/**
 * 组装“发送给引擎”的最终 prompt 文本。
 * - `text`：用户输入（调用方自行 `trim()`）
 * - `files`：文本文件附件（以 fenced code block 方式追加）
 * - `pathReferences`：工作区路径引用，只声明路径边界，不读取或内联文件正文
 */
export function buildPromptText(opts: { text: string; files: PromptTextFileLike[]; pathReferences?: unknown }): string {
  const base = String(opts.text ?? "").trim();
  const files = Array.isArray(opts.files) ? opts.files : [];
  const pathReferences = normalizeWorkspacePathReferenceList(opts.pathReferences);
  if (!files.length && !pathReferences.length) return base;

  const parts: string[] = [];
  if (base) parts.push(base);

  for (const f of files) {
    const fence = pickFence(f.text);
    const lang = guessLangFromName(f.name);
    parts.push(`\n\n---\n[附件：${f.name}]\n${fence}${lang}\n${String(f.text ?? "")}\n${fence}`);
  }

  if (pathReferences.length > 0) {
    const lines = pathReferences.map((ref) => `- ${formatWorkspacePathMention(ref.path)} (${ref.kind})`);
    parts.push([
      "\n\n---",
      "[工作区路径引用]",
      "用户通过 @ 引用了以下工作区路径，正文未内联。需要内容时请使用当前引擎可用的 Read、Glob、Bash 等原生能力读取。",
      ...lines,
    ].join("\n"));
  }

  return parts.join("");
}

function guessLangFromName(name: string): string {
  const m = String(name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "";
  const ext = String(m[1] ?? "").trim();
  return ext ? ext : "";
}

function pickFence(content: string): string {
  const matches = String(content ?? "").match(/`{3,}/g) ?? [];
  const maxLen = matches.reduce((acc, s) => Math.max(acc, s.length), 2);
  const len = Math.max(3, maxLen + 1);
  return "`".repeat(len);
}

/** 规范化 Web 传入的文本文件附件（不允许截断；超限直接拒绝）。 */
export function normalizeTextFiles(input: unknown[]): TextFileAttachment[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length > INLINE_ATTACHMENT_LIMITS.maxTextFileCount) {
    throw new Error(`最多只能上传 ${INLINE_ATTACHMENT_LIMITS.maxTextFileCount} 个文本文件附件`);
  }

  const out: TextFileAttachment[] = [];
  let total = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid text file attachment");
    const r = raw as Record<string, unknown>;

    const id = String(r.id ?? "").trim() || `file_${crypto.randomUUID()}`;
    const name = String(r.name ?? "").trim() || "file";
    const displayName = String(r.displayName ?? "").trim() || null;
    const mime = String(r.mime ?? "").trim();
    const size = Math.max(0, Math.floor(Number(r.size ?? 0) || 0));

    const truncated = Boolean(r.truncated ?? false);
    if (truncated) throw new Error(`不支持截断文本文件：${name}（请重新选择；超限文件会被拒绝）`);
    if (size > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
      throw new Error(`文本文件过大：${name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}）`);
    }

    const text = typeof r.text === "string" ? r.text : String(r.text ?? "");
    if (!text.trim()) throw new Error(`文本文件内容为空：${name}`);

    const bytes = measureTextFileAttachmentBytes({ text, size });
    if (bytes > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
      throw new Error(`文本文件过大：${name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}）`);
    }
    if (total + bytes > INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes) {
      throw new Error(`文本附件总大小超过上限（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes)}）`);
    }

    out.push({ id, name, displayName, mime, size, text });
    total += bytes;
  }

  return out;
}


