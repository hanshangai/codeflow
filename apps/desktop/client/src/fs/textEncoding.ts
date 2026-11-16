import { TextDecoder } from "node:util";

export type TextFileEncoding = "utf8" | "gb18030";
export type FileSnapshotEncoding = TextFileEncoding | "binary";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const GB18030_DECODER = new TextDecoder("gb18030", { fatal: true });

/**
 * 解码文本内容：优先严格 UTF-8，失败后按 GB18030 兼容 GBK/GB18030 文件。
 */
export function decodeTextBuffer(
  input: Buffer,
  options?: { allowPartialTail?: boolean },
): { content: string; encoding: TextFileEncoding } {
  const buf = normalizeBuffer(input);
  const utf8 = tryDecode(UTF8_DECODER, buf, Boolean(options?.allowPartialTail));
  if (utf8 != null) return { content: utf8, encoding: "utf8" };

  const gb18030 = tryDecode(GB18030_DECODER, buf, Boolean(options?.allowPartialTail));
  if (gb18030 != null) return { content: gb18030, encoding: "gb18030" };

  throw new Error("无法按 UTF-8 或 GB18030 解码文本内容");
}

/**
 * 判定文件快照编码；无法确认是文本时返回 binary，避免把二进制内容写成可预览文本。
 */
export function guessTextSnapshotEncoding(input: Buffer): FileSnapshotEncoding {
  const buf = normalizeBuffer(input);
  if (hasNullByte(buf)) return "binary";
  if (tryDecode(UTF8_DECODER, buf, false) != null) return "utf8";
  return tryDecode(GB18030_DECODER, buf, false) != null ? "gb18030" : "binary";
}

/**
 * 按快照记录的编码还原预览文本；binary 返回 null，不做隐式兜底。
 */
export function decodeSnapshotText(input: Buffer, encoding: FileSnapshotEncoding, maxBytes: number): string | null {
  if (encoding !== "utf8" && encoding !== "gb18030") return null;
  const buf = normalizeBuffer(input);
  const content = encoding === "utf8"
    ? decodeWithEncoding(UTF8_DECODER, buf)
    : decodeWithEncoding(GB18030_DECODER, buf);
  return buf.byteLength > maxBytes ? `${content.slice(0, maxBytes)}\n…(truncated)` : content;
}

/** 规整调用方传入的二进制数据，保证 TextDecoder 输入稳定。 */
function normalizeBuffer(input: Buffer): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

/** 严格按指定编码解码，失败时向上抛出用于暴露快照元数据异常。 */
function decodeWithEncoding(decoder: TextDecoder, buf: Buffer): string {
  return decoder.decode(buf);
}

/** 尝试解码；允许截断预览时最多丢弃 4 个尾字节，避免 UTF-8/GB18030 半个字符误判。 */
function tryDecode(decoder: TextDecoder, buf: Buffer, allowPartialTail: boolean): string | null {
  try {
    return decoder.decode(buf);
  } catch {
    if (!allowPartialTail) return null;
  }

  const maxTrim = Math.min(4, Math.max(buf.byteLength - 1, 0));
  for (let trim = 1; trim <= maxTrim; trim += 1) {
    try {
      return decoder.decode(buf.subarray(0, buf.byteLength - trim));
    } catch {
      // 截断只允许修正尾部半个字符，最终是否降级由调用方决定。
    }
  }
  return null;
}

/** 检测 NUL 字节，作为二进制快照的保守判断。 */
function hasNullByte(buf: Buffer): boolean {
  return buf.includes(0);
}
