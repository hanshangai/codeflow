import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { readDocumentPreview } from "../src/fs/fsService.ts";

/** 创建只包含单个文件的最小 ZIP，用于构造 DOCX fixture。 */
function zipSingleFile(fileName: string, content: string): Buffer {
  const fileNameBuffer = Buffer.from(fileName, "utf8");
  const contentBuffer = Buffer.from(content, "utf8");
  const compressed = deflateRawSync(contentBuffer);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(contentBuffer.length, 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);

  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt16LE(20, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt16LE(8, 10);
  centralDirectory.writeUInt32LE(compressed.length, 20);
  centralDirectory.writeUInt32LE(contentBuffer.length, 24);
  centralDirectory.writeUInt16LE(fileNameBuffer.length, 28);
  centralDirectory.writeUInt32LE(0, 42);

  const centralDirectoryOffset = localHeader.length + fileNameBuffer.length + compressed.length;
  const centralDirectorySize = centralDirectory.length + fileNameBuffer.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);

  return Buffer.concat([localHeader, fileNameBuffer, compressed, centralDirectory, fileNameBuffer, eocd]);
}

/** 创建临时 workspace 并在用例结束后删除。 */
function withWorkspace(fn: (workspace: string) => void): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-doc-preview-"));
  try {
    fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

for (const fileName of ["demo.pdf", "demo.docx"]) test(`文档预览拒绝外部目录链接：${fileName}`, () => {
  withWorkspace((workspace) => {
    withWorkspace((outside) => {
      for (const directory of [path.join(workspace, "documents"), outside]) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "demo.pdf"), Buffer.from("%PDF-1.7\npreview"));
        fs.writeFileSync(path.join(directory, "demo.docx"), zipSingleFile("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>内部文档</w:t></w:r></w:p></w:body></w:document>"));
      }
      fs.symlinkSync(outside, path.join(workspace, "external"), process.platform === "win32" ? "junction" : "dir");
      fs.symlinkSync(path.join(workspace, "documents"), path.join(workspace, "internal"), process.platform === "win32" ? "junction" : "dir");
      const linkedRoot = path.join(outside, "workspace");
      fs.symlinkSync(workspace, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      assert.throws(() => readDocumentPreview(workspace, `external/${fileName}`), { code: "FILE_TRANSFER_PATH_INVALID" });
      assert.equal(readDocumentPreview(linkedRoot, "internal/demo.pdf").kind, "pdf");
      assert.match(readDocumentPreview(linkedRoot, "internal/demo.docx").content ?? "", /内部文档/);
    });
  });
});

test("文档预览保留文件信息读取错误及原因", () => {
  withWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, "demo.pdf"), Buffer.from("%PDF-1.7"));
    const originalStatSync = fs.statSync;
    const failure = Object.assign(new Error("metadata unavailable"), { code: "EACCES" });
    try {
      fs.statSync = (() => { throw failure; }) as typeof fs.statSync;
      assert.throws(() => readDocumentPreview(workspace, "demo.pdf"), { code: "EACCES", cause: failure });
    } finally {
      fs.statSync = originalStatSync;
    }
  });
});

test("readDocumentPreview returns pdf base64 preview", () => {
  withWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, "demo.pdf"), Buffer.from("%PDF-1.7\npreview"));

    const result = readDocumentPreview(workspace, "demo.pdf");

    assert.equal(result.kind, "pdf");
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.base64, Buffer.from("%PDF-1.7\npreview").toString("base64"));
  });
});

test("readDocumentPreview converts docx text to safe html", () => {
  withWorkspace((workspace) => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      "<w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>&lt;script&gt;bad&lt;/script&gt;</w:t></w:r></w:p>",
      "</w:body></w:document>",
    ].join("");
    fs.writeFileSync(path.join(workspace, "demo.docx"), zipSingleFile("word/document.xml", xml));

    const result = readDocumentPreview(workspace, "demo.docx");

    assert.equal(result.kind, "word");
    assert.match(result.content ?? "", /<p>Hello &amp; world<\/p>/);
    assert.match(result.content ?? "", /&lt;script&gt;bad&lt;\/script&gt;/);
  });
});

test("readDocumentPreview preserves docx table structure", () => {
  withWorkspace((workspace) => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      "<w:p><w:r><w:t>合同信息</w:t></w:r></w:p>",
      "<w:tbl>",
      "<w:tr>",
      '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc>',
      "</w:tr>",
      "<w:tr>",
      "<w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc>",
      "<w:tc><w:p><w:r><w:t>&lt;b&gt;信泰&lt;/b&gt;</w:t></w:r></w:p></w:tc>",
      "</w:tr>",
      "</w:tbl>",
      "</w:body></w:document>",
    ].join("");
    fs.writeFileSync(path.join(workspace, "table.docx"), zipSingleFile("word/document.xml", xml));

    const result = readDocumentPreview(workspace, "table.docx");

    assert.equal(result.kind, "word");
    assert.match(result.content ?? "", /<table><tbody><tr><td colspan="2"><p>甲方<\/p><\/td><\/tr>/);
    assert.match(result.content ?? "", /<td><p>名称<\/p><\/td>/);
    assert.match(result.content ?? "", /&lt;b&gt;信泰&lt;\/b&gt;/);
  });
});
