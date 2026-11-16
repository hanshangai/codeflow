import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  beginUpload,
  cancelUpload,
  completeUpload,
  readFileChunkForDownload,
  statFileForDownload,
  writeUploadChunk,
} from "../src/fs/fsService.ts";

/** 创建文件传输测试工作区，并提供统一清理入口。 */
function createTransferFixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-transfer-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("upload session writes chunks and completes to target file", () => {
  const fixture = createTransferFixture();
  try {
    const content = Buffer.from("hello transfer");
    const begin = beginUpload(fixture.root, {
      targetDir: "docs",
      fileName: "hello.txt",
      sizeBytes: content.length,
      mimeType: "text/plain",
    });

    const first = content.subarray(0, 5);
    const second = content.subarray(5);
    assert.equal(writeUploadChunk({ uploadId: begin.uploadId, offset: 0, base64: first.toString("base64") }).receivedBytes, first.length);
    assert.equal(writeUploadChunk({ uploadId: begin.uploadId, offset: first.length, base64: second.toString("base64") }).receivedBytes, content.length);

    const completed = completeUpload(begin.uploadId);

    assert.equal(completed.path, "docs/hello.txt");
    assert.equal(completed.fileName, "hello.txt");
    assert.equal(completed.size, content.length);
    assert.equal(fs.readFileSync(path.join(fixture.root, "docs", "hello.txt"), "utf8"), "hello transfer");
  } finally {
    fixture.cleanup();
  }
});

test("upload refuses existing file unless overwrite is true", () => {
  const fixture = createTransferFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "docs", "same.txt"), "old", "utf8");

    assert.throws(
      () => beginUpload(fixture.root, { targetDir: "docs", fileName: "same.txt", sizeBytes: 3 }),
      /文件已存在/,
    );

    const begin = beginUpload(fixture.root, {
      targetDir: "docs",
      fileName: "same.txt",
      sizeBytes: 3,
      overwrite: true,
    });
    writeUploadChunk({ uploadId: begin.uploadId, offset: 0, base64: Buffer.from("new").toString("base64") });
    completeUpload(begin.uploadId);

    assert.equal(fs.readFileSync(path.join(fixture.root, "docs", "same.txt"), "utf8"), "new");
  } finally {
    fixture.cleanup();
  }
});

test("upload cancel removes temporary file without creating target file", () => {
  const fixture = createTransferFixture();
  try {
    const begin = beginUpload(fixture.root, {
      targetDir: "docs",
      fileName: "cancelled.txt",
      sizeBytes: 6,
    });
    writeUploadChunk({ uploadId: begin.uploadId, offset: 0, base64: Buffer.from("abc").toString("base64") });

    const cancelled = cancelUpload(begin.uploadId);

    assert.equal(cancelled.cancelled, true);
    assert.equal(fs.existsSync(path.join(fixture.root, "docs", "cancelled.txt")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "docs", ".codeflow-transfer-tmp", `${begin.uploadId}.part`)), false);
  } finally {
    fixture.cleanup();
  }
});

test("download stat and chunk read file without loading full content", () => {
  const fixture = createTransferFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "docs", "download.txt"), "abcdef", "utf8");

    const stat = statFileForDownload(fixture.root, "docs/download.txt");
    const chunk = readFileChunkForDownload(fixture.root, {
      path: "docs/download.txt",
      offset: 2,
      length: 3,
    });

    assert.equal(stat.fileName, "download.txt");
    assert.equal(stat.size, 6);
    assert.equal(chunk.offset, 2);
    assert.equal(chunk.bytesRead, 3);
    assert.equal(Buffer.from(chunk.base64, "base64").toString("utf8"), "cde");
    assert.equal(chunk.done, false);
  } finally {
    fixture.cleanup();
  }
});

test("transfer paths reject traversal outside workspace", () => {
  const fixture = createTransferFixture();
  try {
    assert.throws(
      () => beginUpload(fixture.root, { targetDir: "../outside", fileName: "x.txt", sizeBytes: 1 }),
      /工作区文件路径非法/,
    );
    assert.throws(
      () => statFileForDownload(fixture.root, "../outside.txt"),
      /工作区文件路径非法/,
    );
    assert.throws(
      () => readFileChunkForDownload(fixture.root, { path: "../outside.txt", offset: 0, length: 1 }),
      /工作区文件路径非法/,
    );
  } finally {
    fixture.cleanup();
  }
});
