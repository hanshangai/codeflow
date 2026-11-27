import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFile, writeFile } from "../src/fs/fsService.ts";

/** 每个用例使用独立工作区，结束后清理临时文件。 */
function fixture(t: test.TestContext): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-write-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test("writeFile 原子覆盖 UTF-8 文本并保留 BOM", t => {
  const workspace = fixture(t);
  const file = path.join(workspace, "settings.txt");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("旧内容\n")]));
  const before = readFile(workspace, "settings.txt");
  assert.equal(before.content, "旧内容\n");
  assert.equal(typeof before.mtimeMs, "number");

  const saved = writeFile(workspace, "settings.txt", "新内容\n第二行\n", { mtimeMs: before.mtimeMs, size: before.size });
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString("utf8"), "新内容\n第二行\n");
  assert.equal(saved.size, bytes.byteLength);
  assert.equal(readFile(workspace, "settings.txt").content, "新内容\n第二行\n");
});

test("writeFile 在大小或修改时间不符时拒绝覆盖", t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, "conflict.txt"), "原始\n", "utf8");
  const before = readFile(workspace, "conflict.txt");

  assert.throws(() => writeFile(workspace, "conflict.txt", "覆盖\n", { mtimeMs: before.mtimeMs, size: 1 }),
    error => error.code === "FS_WRITE_CONFLICT");
  assert.throws(() => writeFile(workspace, "conflict.txt", "覆盖\n", { mtimeMs: Number(before.mtimeMs) + 10_000, size: before.size }),
    error => error.code === "FS_WRITE_CONFLICT");
  assert.equal(fs.readFileSync(path.join(workspace, "conflict.txt"), "utf8"), "原始\n");
});

test("writeFile 拒绝 GB18030 文件、越界路径与符号链接目标", t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, "gbk.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.throws(() => writeFile(workspace, "gbk.txt", "中文"), error => error.code === "FS_WRITE_ENCODING_UNSUPPORTED");
  assert.throws(() => writeFile(workspace, "../escape.txt", "x"), error => error.code === "FILE_TRANSFER_PATH_INVALID");

  const link = path.join(workspace, "link.txt");
  try { fs.symlinkSync(path.join(workspace, "gbk.txt"), link); }
  catch (error) { if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) return; throw error; }
  assert.throws(() => writeFile(workspace, "link.txt", "x"), error => error.code === "FS_WRITE_TARGET_INVALID");
});
