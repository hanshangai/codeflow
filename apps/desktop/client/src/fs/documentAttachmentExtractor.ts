import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import CFB from "cfb";
import { SaxesParser } from "saxes";
import {
  DOCUMENT_ATTACHMENT_LIMITS, INLINE_ATTACHMENT_LIMITS, formatByteSize, isDocumentAttachmentName,
} from "@codeflowai/shared";

/** 校验完整文档输入；maxSourceBytes 由工作区策略传入。 */
export function decodeDocumentAttachment(
  fileName: string,
  base64: string,
  maxSourceBytes: number = DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes,
): Buffer {
  if (!fileName || fileName.length > 255) throw new Error("文档文件名为空或过长");
  if (!isDocumentAttachmentName(fileName)) throw new Error(`不支持的文档格式：${fileName}`);
  if (typeof base64 !== "string" || !base64.length) throw new Error(`文档为空：${fileName}`);
  if (base64.length > Math.ceil(maxSourceBytes / 3) * 4) {
    throw new Error(`文档超过 ${formatByteSize(maxSourceBytes)}：${fileName}`);
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64) throw new Error("文档内容不是有效的 base64");
  if (!buffer.length) throw new Error(`文档为空：${fileName}`);
  if (buffer.length > maxSourceBytes) throw new Error(`文档大小超过 ${formatByteSize(maxSourceBytes)}`);
  return buffer;
}

/** 在隔离 Worker 内提取完整文字；超限、损坏、加密或无文字均显式失败。 */
export async function extractDocumentAttachment(
  fileName: string,
  buffer: Buffer,
  maxSourceBytes: number = DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes,
): Promise<string> {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (!isDocumentAttachmentName(fileName)) throw new Error(`不支持的文档格式：${fileName}`);
  if (!buffer.length || buffer.length > maxSourceBytes) throw new Error("文档为空或过大");
  if (["docx", "xlsx", "pptx"].includes(extension)) validateOfficeArchive(buffer);
  if (["doc", "xls", "ppt"].includes(extension)) {
    if (!buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) throw new Error("文件内容与旧版 Office 格式不符");
    if (extension === "doc") {
      const archive = CFB.read(buffer, { type: "buffer" });
      const stream = CFB.find(archive, "WordDocument")?.content;
      if (!stream || stream.length < 12) throw new Error("Word 文档缺少有效正文流");
      if (Buffer.from(stream).readUInt16LE(10) & 0x8100) throw new Error("不支持加密 Word 文档，请先解密");
    }
  }
  if (extension === "pdf" && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("文件不是有效的 PDF");

  let text: string;
  if (extension === "doc" || extension === "docx") {
    const { default: WordExtractor } = await import("word-extractor");
    const document = await new WordExtractor().extract(buffer);
    text = [document.getBody(), document.getTextboxes(), document.getHeaders(), document.getFootnotes(), document.getEndnotes()]
      .filter((part) => part.trim()).join("\n\n");
  } else if (extension === "xls" || extension === "xlsx") {
    text = extractSpreadsheet(buffer);
  } else if (extension === "pptx") {
    text = extractPptx(buffer);
  } else if (extension === "ppt") {
    text = await extractLegacyPpt(buffer);
  } else {
    text = await extractPdf(buffer);
  }
  text = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!text) throw new Error("未提取到可读取的文字；不支持扫描件、图片识别或空白文档");
  assertTextBudget(text);
  return text;
}

/** Excel 保留所有工作表及非空单元格的显示值，不执行公式或宏。 */
function extractSpreadsheet(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!;
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 1_000_000) {
      throw new Error(`工作表范围过大，请拆分后重试：${name}`);
    }
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
    const content = rows.map((row) => row.map((value) => String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ")).join("\t")).join("\n");
    if (!content.trim()) continue;
    parts.push(`工作表：${name}\n${content}`);
    assertTextBudget(parts.join("\n\n"));
  }
  return parts.join("\n\n");
}

/** PPTX 根据 presentation 的关系与顺序读取幻灯片，避免混入已删除或排序不同的页面。 */
function extractPptx(buffer: Buffer): string {
  const archive = CFB.read(buffer, { type: "buffer" });
  const readEntry = (name: string): string => {
    const entry = CFB.find(archive, `/${name}`);
    if (!entry?.content) throw new Error(`演示文稿缺少必要条目：${name}`);
    return Buffer.from(entry.content).toString("utf8");
  };
  const relationships = new Map<string, string>();
  const relParser = new SaxesParser({ xmlns: true });
  relParser.on("opentag", (tag) => {
    if (tag.local !== "Relationship") return;
    const attrs = Object.fromEntries(Object.values(tag.attributes).map((attr) => [attr.local, attr.value]));
    if (attrs.Type?.endsWith("/slide") && attrs.TargetMode !== "External") {
      const target = attrs.Target ?? "";
      relationships.set(attrs.Id!, path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join("ppt", target)));
    }
  });
  relParser.write(readEntry("ppt/_rels/presentation.xml.rels")).close();
  const slides: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (tag.local !== "sldId") return;
    const relation = Object.values(tag.attributes).find((attr) => attr.local === "id" && attr.uri.endsWith("/relationships"));
    const target = relation && relationships.get(relation.value);
    if (!target || !target.startsWith("ppt/slides/")) throw new Error("演示文稿的幻灯片关系无效");
    slides.push(extractSlideXml(readEntry(target)));
  });
  parser.write(readEntry("ppt/presentation.xml")).close();
  return formatSlides(slides);
}

/** 只读取 DrawingML 文字，并保留段落、单元格和行边界。 */
function extractSlideXml(xml: string): string {
  const parts: string[] = [];
  let inText = false;
  let inCell = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (tag.local === "t") inText = true;
    if (tag.local === "tc") inCell = true;
  });
  parser.on("text", (text) => { if (inText) parts.push(text); });
  parser.on("closetag", (tag) => {
    if (tag.local === "t") inText = false;
    if (tag.local === "p" || tag.local === "br") parts.push(inCell ? " " : "\n");
    if (tag.local === "tr") parts.push("\n");
    if (tag.local === "tc") { parts.push("\t"); inCell = false; }
  });
  parser.write(xml).close();
  return parts.join("").trim();
}

/** 旧版 PPT 由专用解析器解析有效版本，禁止扫描二进制字符串冒充正文。 */
async function extractLegacyPpt(buffer: Buffer): Promise<string> {
  const { readPptContent } = await import("ppt-codec");
  const document = readPptContent(new Uint8Array(buffer));
  const slides = document.slides.map((slide) => slide.shapes.map((shape) => shape.blocks.map((block) => {
    if (block.kind === "paragraph") return block.runs.map((run) => run.text ?? "").join("");
    if (block.kind === "table") return block.rows.map((row) => row.cells.map((cell) => cell.blocks.map((paragraph) =>
      paragraph.kind === "paragraph" ? paragraph.runs.map((run) => run.text ?? "").join("") : "").join(" ")).join("\t")).join("\n");
    return "";
  }).join("\n")).join("\n"));
  return formatSlides(slides);
}

/** PDF 逐页提取文字并保留换行，不加载图片、不运行 OCR 或文档脚本。 */
async function extractPdf(buffer: Buffer): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { stopAtErrors: true, maxImageSize: 0 });
  try {
    if (pdf.numPages > 500) throw new Error("PDF 超过 500 页，请拆分后重试");
    const pages: string[] = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      if (text) pages.push(`第 ${index} 页\n${text}`);
      assertTextBudget(pages.join("\n\n"));
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** 只为包含文字的幻灯片增加页码，空白文件不得仅凭页码通过校验。 */
function formatSlides(slides: string[]): string {
  return slides.map((text, index) => text.trim() ? `幻灯片 ${index + 1}\n${text}` : "").filter(Boolean).join("\n\n");
}

/** 统一按 UTF-8 字节校验提取结果，不静默截断正文。 */
function assertTextBudget(text: string): void {
  if (Buffer.byteLength(text, "utf8") > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
    throw new Error(`文档提取后的文字超过 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}，请拆分后重试`);
  }
}

/** 限制 ZIP 声明总量并有界校验实际解压结果，防止解析库忽略损坏或伪造大小。 */
function validateOfficeArchive(buffer: Buffer): void {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw new Error("Office 文件不是有效的 ZIP 文档；加密文件请先解密");
  const count = buffer.readUInt16LE(end + 10);
  const directoryStart = buffer.readUInt32LE(end + 16);
  let cursor = directoryStart;
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count
    || directoryStart + buffer.readUInt32LE(end + 12) !== end) {
    throw new Error("Office 文档中央目录或分卷结构无效");
  }
  if (count === 0xffff || count > 10000) throw new Error("Office 文档条目过多或使用了不支持的 ZIP64");
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Office 文档中央目录损坏");
    const directoryFlags = buffer.readUInt16LE(cursor + 8);
    if (directoryFlags & 0x2041) throw new Error("不支持加密文档，请先解密");
    const size = buffer.readUInt32LE(cursor + 24);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    expanded += size;
    if (expanded > 32 * 1024 * 1024) throw new Error("Office 文档解压后超过 32MB，请拆分后重试");
    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > directoryStart || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("Office 文档条目头损坏");
    const flags = buffer.readUInt16LE(local + 6);
    const method = buffer.readUInt16LE(local + 8);
    if (flags !== directoryFlags || method !== buffer.readUInt16LE(cursor + 10) || (method !== 0 && method !== 8)) {
      throw new Error("Office 文档压缩方式或标志不一致");
    }
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const localSize = buffer.readUInt32LE(local + 22);
    const localCompressedSize = buffer.readUInt32LE(local + 18);
    if (dataStart + compressedSize > directoryStart
      || (localSize !== size && (!(flags & 8) || localSize !== 0))
      || (localCompressedSize !== compressedSize && (!(flags & 8) || localCompressedSize !== 0))) {
      throw new Error("Office 文档条目大小或边界不一致");
    }
    const checksum = buffer.readUInt32LE(cursor + 16);
    if (flags & 8) {
      let descriptor = dataStart + compressedSize;
      if (descriptor + 4 <= directoryStart && buffer.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > directoryStart || buffer.readUInt32LE(descriptor) !== checksum
        || buffer.readUInt32LE(descriptor + 4) !== compressedSize || buffer.readUInt32LE(descriptor + 8) !== size) {
        throw new Error("Office 文档数据描述符无效");
      }
    } else if (buffer.readUInt32LE(local + 14) !== checksum) {
      throw new Error("Office 文档条目校验和不一致");
    }
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }) : compressed;
    if (content.length !== size || crc32(content) !== checksum) {
      throw new Error("Office 文档解压大小或校验和不一致");
    }
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== end) throw new Error("Office 文档中央目录边界不一致");
}
