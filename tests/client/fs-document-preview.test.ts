import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readDocumentPreview, readFile } from "../../apps/desktop/client/src/fs/fsService.ts";
import { getMimeType, isBinaryFile, isDocumentPreviewFile } from "../../apps/desktop/client/src/fs/fsHelpers.ts";

test("PPTX document preview returns the original file as presentation base64", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-pptx-preview-"));
  const filePath = path.join(workspacePath, "demo.pptx");
  const content = Buffer.from("PK\u0003\u0004codeflowai-pptx-test", "binary");
  fs.writeFileSync(filePath, content);

  try {
    assert.equal(isDocumentPreviewFile(filePath), true);
    assert.equal(getMimeType(filePath), "application/vnd.openxmlformats-officedocument.presentationml.presentation");

    const preview = readDocumentPreview(workspacePath, "demo.pptx");
    assert.equal(preview.kind, "presentation");
    assert.equal(preview.mimeType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(preview.base64, content.toString("base64"));
    assert.equal(preview.content, undefined);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("legacy PPT remains a binary download-only format", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-legacy-ppt-"));
  const filePath = path.join(workspacePath, "legacy.ppt");
  fs.writeFileSync(filePath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));

  try {
    assert.equal(isDocumentPreviewFile(filePath), false);
    assert.equal(isBinaryFile(filePath), true);
    assert.equal(getMimeType(filePath), "application/vnd.ms-powerpoint");

    const preview = readFile(workspacePath, "legacy.ppt");
    assert.equal(preview.isBinary, true);
    assert.equal(preview.content, null);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
