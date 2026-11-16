import fs from "node:fs";
import path from "node:path";

import {
  ThreadInputContractError,
  resolveLegacyEffectiveInputKind,
  type ThreadInputKind,
} from "@codeflowai/shared";

type ClaudeStreamJsonMessageArray = {
  type: "user";
  message: {
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
    >;
  };
};

/** content 为纯字符串的简写格式 — CLI slash 命令（/compact 等）必须用此格式，否则解析器 .trim() 会崩溃。 */
type ClaudeStreamJsonMessageString = {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
};

/**
 * 构造 Claude Code `--input-format stream-json` 的 stdin 输入（单行 JSON）。
 *
 * **重要**：CLI 内建 slash 命令（`/compact`、`/model` 等）的解析器直接对 content 调用
 * `.trim().startsWith("/")`，因此 content 必须是 **纯字符串** 才能被正确拦截。
 * 如果用数组格式 `[{type:"text",text:"/compact"}]`，解析器会因 `.trim() is not a function`
 * 而静默失败，导致命令被当作普通消息发送给模型。
 *
 * - 参考 CodeMoss：图片统一转为 url 或 base64（本地图片读文件并编码）。
 * - 可选 UUID 用于关联 CLI 的原生输入回显。
 */
export function buildClaudeStreamJsonInput(opts: {
  text: string;
  images: string[];
  inputKind?: ThreadInputKind;
  uuid?: string;
}): string {
  const rawText = String(opts.text ?? "");
  const text = rawText.trim();
  const hasImages = opts.images.some((img) => String(img ?? "").trim().length > 0);
  const effectiveInputKind = opts.inputKind ?? resolveLegacyEffectiveInputKind(rawText, opts.images);

  // ── Provider Slash → 纯字符串格式，让 CLI 在本地命令边界处理 ──
  if (effectiveInputKind === "provider-slash") {
    const providerText = opts.inputKind === "provider-slash" ? rawText : text;
    if (hasImages || !providerText.startsWith("/")) {
      throw new ThreadInputContractError(
        "PROVIDER_SLASH_CONFLICT",
        "Provider Slash 必须以 / 开头且不能携带图片",
      );
    }
    const msg: ClaudeStreamJsonMessageString = { type: "user", message: { role: "user", content: providerText } };
    return JSON.stringify({ ...msg, ...(opts.uuid ? { uuid: opts.uuid } : {}) });
  }

  // ── 常规消息 → 数组格式（支持图片混排）──
  const content: ClaudeStreamJsonMessageArray["message"]["content"] = [];

  for (const img of opts.images) {
    const trimmed = String(img ?? "").trim();
    if (!trimmed) continue;

    const dataUrl = parseDataUrl(trimmed);
    if (dataUrl) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.base64Data },
      });
      continue;
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      content.push({ type: "image", source: { type: "url", url: trimmed } });
      continue;
    }

    const base64Data = readLocalFileAsBase64(trimmed);
    content.push({
      type: "image",
      source: { type: "base64", media_type: guessMediaTypeFromPath(trimmed), data: base64Data },
    });
  }

  if (text) content.push({ type: "text", text });

  if (!content.length) throw new Error("empty message: text/images required");

  const msg: ClaudeStreamJsonMessageArray = { type: "user", message: { role: "user", content } };
  return JSON.stringify({ ...msg, ...(opts.uuid ? { uuid: opts.uuid } : {}) });
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return null;
  const head = dataUrl.slice(5, idx);
  const base64Data = dataUrl.slice(idx + 1);
  if (!/;base64$/i.test(head)) return null;
  const mediaType = head.replace(/;base64$/i, "").trim() || "image/png";
  if (!base64Data.trim()) return null;
  return { mediaType, base64Data };
}

function readLocalFileAsBase64(filePath: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.toString("base64");
  } catch {
    throw new Error(`无法读取图片文件：${filePath}`);
  }
}

function guessMediaTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

