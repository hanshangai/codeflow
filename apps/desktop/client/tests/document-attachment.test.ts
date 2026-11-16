import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import * as XLSX from "xlsx";
import CFB from "cfb";
import { writePptContent } from "ppt-codec";
import {
  DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES, DOCUMENT_ATTACHMENT_LIMITS, INLINE_ATTACHMENT_LIMITS,
  resolveDocumentAttachmentTimeoutMs, resolveSharedWorkspaceEffectiveOperationPolicy,
  type ClientToServerMessage, type SharedWorkspaceCommandEnvelope,
} from "@codeflowai/shared";
import { decodeDocumentAttachment, extractDocumentAttachment } from "../src/fs/documentAttachmentExtractor.ts";
import { extractDocumentAttachmentInWorker } from "../src/fs/documentAttachmentWorkerClient.ts";
import { handleFsExtractAttachment } from "../src/app/handlers/fsHandlers.ts";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.ts";

/** 生成真实 ZIP 容器，测试直接解析文件字节而非模拟解析库。 */
function zipFiles(files: Record<string, string>, compression = false): Buffer {
  const archive = CFB.utils.cfb_new();
  for (const [name, value] of Object.entries(files)) CFB.utils.cfb_add(archive, name, Buffer.from(value));
  return Buffer.from(CFB.write(archive, { type: "buffer", fileType: "zip", compression }));
}

/** 生成包含正文和两列表格的最小 DOCX。 */
function docx(text = "中文合同 &amp; 条款", compression = false): Buffer {
  return zipFiles({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙方</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  }, compression);
}

/** 使用有效 xref 构造文字、中文映射或空白 PDF，不依赖网络和外部 Office。 */
function pdf(text = "Attachment PDF text", chinese = false): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td ${chinese ? "<010203>" : `(${text})`} Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${chinese ? "/ToUnicode 6 0 R" : ""} >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  if (chinese) {
    const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /TestUnicode def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 3 beginbfchar <01> <4e2d> <02> <6587> <03> <8868> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
    objects.push(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = value.length;
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}

test("DOCX 提取中文、实体和表格分隔", async () => {
  const text = await extractDocumentAttachment("合同.DOCX", docx());
  assert.match(text, /中文合同 & 条款/);
  assert.match(text, /甲方\t乙方/);
  assert.match(await extractDocumentAttachment("压缩.docx", docx("压缩中文正文", true)), /压缩中文正文/);
});

// word-extractor（MIT）test11.doc 的正文/表流，已移除作者等元数据。
const legacyDoc = "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";

test("旧版 DOC 提取真实中文正文，加密标志必须明确拒绝", async () => {
  const buffer = inflateSync(Buffer.from(legacyDoc, "base64"));
  assert.match(await extractDocumentAttachment("旧版.doc", buffer), /这是一个用来测试nodejs解析Word文档/);
  const archive = CFB.read(buffer, { type: "buffer" });
  const body = Buffer.from(CFB.find(archive, "WordDocument")!.content);
  body.writeUInt16LE(body.readUInt16LE(10) | 0x100, 10);
  CFB.utils.cfb_add(archive, "WordDocument", body);
  await assert.rejects(extractDocumentAttachment("加密.doc", Buffer.from(CFB.write(archive, { type: "buffer" }))), /加密 Word/);
});

for (const bookType of ["xls", "xlsx"] as const) {
  test(`${bookType} 保留多工作表、中文和显示值`, async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["姓名", "数量"], ["张三", 12]]), "销售");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["备注", "已确认"]]), "说明");
    const text = await extractDocumentAttachment(`数据.${bookType}`, XLSX.write(book, { type: "buffer", bookType }));
    assert.match(text, /工作表：销售\n姓名\t数量\n张三\t12/);
    assert.match(text, /工作表：说明\n备注\t已确认/);
  });
}

test("PPTX 按关系顺序读取页面、表格，不混入孤立幻灯片", async () => {
  const slide = (value: string) => `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><a:p><a:r><a:t>${value}</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>列一</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>列二</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:spTree></p:cSld></p:sld>`;
  const input = zipFiles({
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": slide("第二页"), "ppt/slides/slide2.xml": slide("第一页"), "ppt/slides/slide3.xml": slide("已删除页面"),
  });
  const text = await extractDocumentAttachment("方案.pptx", input);
  assert.ok(text.indexOf("第一页") < text.indexOf("第二页"));
  assert.match(text, /列一\s*\t列二/);
  assert.doesNotMatch(text, /已删除页面/);
});

test("旧版 PPT 解析有效的二进制页面正文", async () => {
  const bytes = writePptContent({ metadata: {}, slides: [{
    size: { widthPt: 720, heightPt: 540 }, notes: "",
    shapes: [{ frame: { xPt: 10, yPt: 10, widthPt: 400, heightPt: 100 },
      insetLeftPt: 0, insetRightPt: 0, insetTopPt: 0, insetBottomPt: 0, blocks: [
      { kind: "paragraph", runs: [{ text: "旧版中文演示文稿" }] },
    ] }],
  }] });
  assert.match(await extractDocumentAttachment("方案.ppt", Buffer.from(bytes)), /幻灯片 1\n旧版中文演示文稿/);
});

test("PDF 提取文字、页码，空白或扫描件不会凭页码伪造成功", async () => {
  assert.match(await extractDocumentAttachment("资料.pdf", pdf()), /第 1 页\nAttachment PDF text/);
  assert.match(await extractDocumentAttachment("中文.pdf", pdf("unicode", true)), /中文表/);
  await assert.rejects(extractDocumentAttachment("扫描件.pdf", pdf("")), /未提取到可读取的文字/);
});

test("文档预算、格式与损坏校验均显式失败，不截断", async () => {
  assert.throws(() => decodeDocumentAttachment("a.pdf", "not base64"), /base64/);
  assert.throws(() => decodeDocumentAttachment("a.zip", "YQ=="), /不支持/);
  const oversized = Buffer.alloc(DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes + 1);
  assert.throws(() => decodeDocumentAttachment("a.pdf", oversized.toString("base64")), /超过/);
  // 统一上限 20MB，超过 8MB 的文档仍可解码。
  const large = Buffer.alloc(DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES + 1);
  assert.equal(decodeDocumentAttachment("a.pdf", large.toString("base64")).length, large.length);
  assert.equal(resolveDocumentAttachmentTimeoutMs(DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES + 1), 60_000);
  assert.equal(resolveDocumentAttachmentTimeoutMs(1024), DOCUMENT_ATTACHMENT_LIMITS.timeoutMs);
  for (const extension of ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"]) {
    await assert.rejects(extractDocumentAttachment(`bad.${extension}`, Buffer.from("bad document")));
  }
  await assert.rejects(extractDocumentAttachment("太长.docx", docx("中".repeat(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes / 3 + 1))), /超过 200KB/);
});

test("Worker 错误可隔离，后续解析与 RPC 仍可用", async () => {
  await assert.rejects(extractDocumentAttachmentInWorker("坏文件.docx", Buffer.from("bad").toString("base64")), /有效的 ZIP/);
  assert.match(await extractDocumentAttachmentInWorker("合同.docx", docx().toString("base64")), /中文合同/);
  const replies: any[] = [];
  const logs: unknown[] = [];
  const ctx = { db: { writeWorkspaceLog: (_workspaceId: string, entry: unknown) => { logs.push(entry); } },
    clientId: "client", workspaces: new Map([["ws", "unused"]]), send: (value: unknown) => replies.push(value) } as any;
  await handleFsExtractAttachment(ctx, { id: "bad", method: "fs.extractAttachment", body: { workspaceId: "ws", fileName: "a.pdf", base64: "bad" } } as any);
  assert.equal(replies.at(-1).status, 400);
  assert.equal(replies.at(-1).body.ok, false);
  await handleFsExtractAttachment(ctx, { id: "ok", method: "fs.extractAttachment", body: { workspaceId: "ws", fileName: "合同.docx", base64: docx().toString("base64") } } as any);
  assert.equal(replies.at(-1).body.ok, true);
  assert.match(replies.at(-1).body.text, /中文合同/);
  assert.equal(logs.length, 1);
});

test("Worker 超时终止后释放并发名额，其他请求仍可解析", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = extractDocumentAttachmentInWorker("合同.docx", docx().toString("base64"));
  const rejected = assert.rejects(pending, (error: any) => error.code === "TIMEOUT");
  t.mock.timers.tick(DOCUMENT_ATTACHMENT_LIMITS.timeoutMs);
  await rejected;
  t.mock.timers.reset();
  assert.match(await extractDocumentAttachmentInWorker("合同.docx", docx().toString("base64")), /中文合同/);
});

test("并发解析有上限，拒绝的请求不影响已接受文件", async () => {
  const base64 = docx().toString("base64");
  const first = extractDocumentAttachmentInWorker("一.docx", base64);
  const second = extractDocumentAttachmentInWorker("二.docx", base64);
  await assert.rejects(extractDocumentAttachmentInWorker("三.docx", base64), (error: any) => error.code === "RATE_LIMITED");
  for (const text of await Promise.all([first, second])) assert.match(text, /中文合同/);
});

test("响应发送失败交回传输边界，不重复响应或重做解析", async () => {
  let sends = 0;
  const transportError = new Error("transport closed");
  const ctx = { clientId: "client", workspaces: new Map([["ws", "unused"]]), send: () => { sends++; throw transportError; } } as any;
  await assert.rejects(handleFsExtractAttachment(ctx, {
    id: "response", method: "fs.extractAttachment", body: { workspaceId: "ws", fileName: "合同.docx", base64: docx().toString("base64") },
  } as any), (error) => error === transportError);
  assert.equal(sends, 1);
});

test("Office 解压前拒绝膨胀过大及伪造大小的容器", async () => {
  for (const declared of [40 * 1024 * 1024, 1]) {
    const bytes = docx();
    const offset = bytes.indexOf(Buffer.from("504b0102", "hex"));
    bytes.writeUInt32LE(declared, offset + 24);
    await assert.rejects(extractDocumentAttachment("恶意.docx", bytes), /超过 32MB|大小或边界不一致/);
  }
  const corrupted = docx();
  const directory = corrupted.indexOf(Buffer.from("504b0102", "hex"));
  corrupted.writeUInt32LE(0, directory + 16);
  await assert.rejects(extractDocumentAttachment("损坏.docx", corrupted), /校验和不一致/);

  const compressed = zipFiles({ "word/document.xml": "A".repeat(1024 * 1024) }, true);
  const compressedDirectory = compressed.indexOf(Buffer.from("504b0102", "hex"));
  const local = compressed.readUInt32LE(compressedDirectory + 42);
  compressed.writeUInt32LE(1, compressedDirectory + 24);
  compressed.writeUInt32LE(1, local + 22);
  await assert.rejects(extractDocumentAttachment("伪造.pptx", compressed), (error: any) => error.code === "ERR_BUFFER_TOO_LARGE");
});

test("共享文档由 Host 解析并覆盖成员工作区 ID，失败不返回成功内容", async () => {
  const messages: ClientToServerMessage[] = [];
  const ctx = {
    db: { workspaceId: "workspace_host", forWorkspace() { return this; }, writeWorkspaceLog() {} },
    clientId: "host", workspaces: new Map([["workspace_host", "unused"]]),
    send: (message: ClientToServerMessage) => messages.push(message),
  } as any;
  const payload = {
    method: "fs.extractAttachment", workspaceId: "workspace_member",
    fileName: "合同.docx", base64: docx().toString("base64"),
  };
  const operationKey = "workspace.fs.read";
  const policy = resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload)!;
  const envelope: SharedWorkspaceCommandEnvelope = {
    sharedWorkspaceId: "sw_host", actorUserId: "user_member", actorRemoteSessionId: "session_member" as never,
    hostBindingId: "binding_host", routeEventId: "extract-route", localWorkspaceId: "workspace_host" as never,
    operationId: "extract", operationKey, policy: { ...policy, upgradedFromOperationId: null },
    authorization: { actorAssetRole: "member", authorizationResult: "allowed", authorizationReason: "",
      assetType: "unknown", assetId: "", assetAction: "update" },
    lockToken: null, lockVersion: null, payload, createdAt: Date.now(),
  };
  assert.equal(policy.effectiveLockRequired, false);
  await handleSharedWorkspaceCommand(ctx, envelope);
  const result = messages.find((message) => message.t === "sharedWorkspace.route.result");
  assert.ok(result && result.t === "sharedWorkspace.route.result");
  assert.equal(result.message.status, "succeeded");
  assert.match((result.message.result as { text: string }).text, /中文合同/);
  assert.equal(messages.filter((message) => message.t === "sharedWorkspace.route.result").length, 1);

  messages.length = 0;
  await handleSharedWorkspaceCommand(ctx, { ...envelope, payload: { ...payload, base64: "YmFk" } });
  const failure = messages.find((message) => message.t === "sharedWorkspace.route.result");
  assert.ok(failure && failure.t === "sharedWorkspace.route.result");
  assert.equal(failure.message.status, "failed");
  assert.equal(failure.message.result, undefined);
  assert.match(failure.message.error?.message ?? "", /有效的 ZIP/);

  messages.length = 0;
  await handleSharedWorkspaceCommand(ctx, { ...envelope, localWorkspaceId: "workspace_member" as never });
  const unavailable = messages.find((message) => message.t === "sharedWorkspace.route.result");
  assert.ok(unavailable && unavailable.t === "sharedWorkspace.route.result");
  assert.equal(unavailable.message.status, "failed");
  assert.equal(unavailable.message.error?.code, "SHARED_WORKSPACE_HOST_UNAVAILABLE");
  assert.equal(unavailable.message.result, undefined);
});
