import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFile } from "../src/fs/fsService.ts";
import { diff, diffFiles, show, showFileDiff } from "../src/git/gitService.ts";
import { decodeSnapshotText, guessTextSnapshotEncoding } from "../src/fs/textEncoding.ts";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.ts";

/** 创建临时 workspace，测试结束后清理。 */
function createWorkspaceFixture(): { workspace: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-encoding-"));
  return {
    workspace,
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

/** 执行测试仓库内的 Git 命令，并固定提交身份避免依赖本机配置。 */
function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CodeFlowAI Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "CodeFlowAI Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

/** 构造 GBK 字节样本，避免测试依赖额外编码库。 */
function gbkRevisionBytes(revision: "old" | "new"): Buffer {
  return revision === "old"
    ? Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x47, 0x42, 0x4b, 0xbe, 0xc9, 0xb0, 0xe6])
    : Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x47, 0x42, 0x4b, 0xd0, 0xc2, 0xb0, 0xe6]);
}

test("readFile decodes GBK text files via GB18030 fallback", () => {
  const fixture = createWorkspaceFixture();
  try {
    const filePath = path.join(fixture.workspace, "gbk-preview-test.txt");
    const gbkBytes = Buffer.from([
      0xd6, 0xd0, 0xce, 0xc4, 0x47, 0x42, 0x4b, 0xb2, 0xe2, 0xca, 0xd4,
      0x0a,
      0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0,
    ]);
    fs.writeFileSync(filePath, gbkBytes);

    const result = readFile(fixture.workspace, "gbk-preview-test.txt");

    assert.equal(result.isBinary, false);
    assert.equal(result.encoding, "gb18030");
    assert.equal(result.content, "中文GBK测试\n第二行");
  } finally {
    fixture.cleanup();
  }
});

test("readFile keeps UTF-8 text files on UTF-8 decoding", () => {
  const fixture = createWorkspaceFixture();
  try {
    const filePath = path.join(fixture.workspace, "utf8-preview-test.txt");
    fs.writeFileSync(filePath, "中文 UTF-8 测试\n第二行", "utf8");

    const result = readFile(fixture.workspace, "utf8-preview-test.txt");

    assert.equal(result.isBinary, false);
    assert.equal(result.encoding, "utf8");
    assert.equal(result.content, "中文 UTF-8 测试\n第二行");
  } finally {
    fixture.cleanup();
  }
});

test("readFile keeps script and custom text extensions previewable without a suffix allowlist", () => {
  const fixture = createWorkspaceFixture();
  try {
    for (const name of ["procedure.prc", "package.pck", "package.pkb", "package.pks", "settings.custom-text", "Dockerfile"]) {
      const content = "-- 中文脚本\nselect 1;";
      fs.writeFileSync(path.join(fixture.workspace, name), content, "utf8");
      const result = readFile(fixture.workspace, name);
      assert.equal(result.isBinary, false, name);
      assert.equal(result.content, content, name);
    }
    for (const name of ["gbk-procedure.prc", "gbk-package.pck"]) {
      fs.writeFileSync(path.join(fixture.workspace, name), gbkRevisionBytes("old"));
      const result = readFile(fixture.workspace, name);
      assert.equal(result.isBinary, false, name);
      assert.equal(result.encoding, "gb18030", name);
      assert.equal(result.content, "中文GBK旧版", name);
    }
  } finally {
    fixture.cleanup();
  }
});

test("snapshot encoding keeps GBK files previewable in file change diffs", () => {
  const gbkBytes = Buffer.from([
    0xd6, 0xd0, 0xce, 0xc4, 0x47, 0x42, 0x4b, 0xbf, 0xec, 0xd5, 0xd5,
  ]);

  const encoding = guessTextSnapshotEncoding(gbkBytes);
  const text = decodeSnapshotText(gbkBytes, encoding, 200 * 1024);

  assert.equal(encoding, "gb18030");
  assert.equal(text, "中文GBK快照");
});

test("snapshot encoding keeps NUL byte files binary", () => {
  const bytes = Buffer.from([0x41, 0x00, 0x42]);

  const encoding = guessTextSnapshotEncoding(bytes);
  const text = decodeSnapshotText(bytes, encoding, 200 * 1024);

  assert.equal(encoding, "binary");
  assert.equal(text, null);
});

test("diffFiles decodes GBK working tree files", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const filePath = path.join(fixture.workspace, "git-gbk.txt");
    const gbkBytes = Buffer.from([
      0xd6, 0xd0, 0xce, 0xc4, 0x47, 0x42, 0x4b, 0xb9, 0xa4, 0xd7, 0xf7, 0xc7, 0xf8,
    ]);
    fs.writeFileSync(filePath, gbkBytes);

    const result = await diffFiles(fixture.workspace, "git-gbk.txt", false);

    assert.equal(result.original, "");
    assert.equal(result.modified, "中文GBK工作区");
  } finally {
    fixture.cleanup();
  }
});

test("diffFiles decodes GBK HEAD and working tree blobs", async () => {
  const fixture = createWorkspaceFixture();
  try {
    git(fixture.workspace, ["init", "-q"]);
    const filePath = path.join(fixture.workspace, "git-gbk-history.txt");
    fs.writeFileSync(filePath, gbkRevisionBytes("old"));
    git(fixture.workspace, ["add", "git-gbk-history.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "old"]);
    fs.writeFileSync(filePath, gbkRevisionBytes("new"));

    const result = await diffFiles(fixture.workspace, "git-gbk-history.txt", false);

    assert.equal(result.original, "中文GBK旧版");
    assert.equal(result.modified, "中文GBK新版");
  } finally {
    fixture.cleanup();
  }
});

test("diffFiles decodes GBK staged blobs", async () => {
  const fixture = createWorkspaceFixture();
  try {
    git(fixture.workspace, ["init", "-q"]);
    const filePath = path.join(fixture.workspace, "git-gbk-staged.txt");
    fs.writeFileSync(filePath, gbkRevisionBytes("old"));
    git(fixture.workspace, ["add", "git-gbk-staged.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "old"]);
    fs.writeFileSync(filePath, gbkRevisionBytes("new"));
    git(fixture.workspace, ["add", "git-gbk-staged.txt"]);

    const result = await diffFiles(fixture.workspace, "git-gbk-staged.txt", true);

    assert.equal(result.original, "中文GBK旧版");
    assert.equal(result.modified, "中文GBK新版");
  } finally {
    fixture.cleanup();
  }
});

test("showFileDiff decodes GBK commit blobs", async () => {
  const fixture = createWorkspaceFixture();
  try {
    git(fixture.workspace, ["init", "-q"]);
    const filePath = path.join(fixture.workspace, "git-gbk-commit.txt");
    fs.writeFileSync(filePath, gbkRevisionBytes("old"));
    git(fixture.workspace, ["add", "git-gbk-commit.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "old"]);
    fs.writeFileSync(filePath, gbkRevisionBytes("new"));
    git(fixture.workspace, ["add", "git-gbk-commit.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "new"]);
    const newHash = git(fixture.workspace, ["rev-parse", "HEAD"]);

    const result = await showFileDiff(fixture.workspace, newHash, "git-gbk-commit.txt");

    assert.equal(result.original, "中文GBK旧版");
    assert.equal(result.modified, "中文GBK新版");
  } finally {
    fixture.cleanup();
  }
});

test("diff decodes GBK patch text", async () => {
  const fixture = createWorkspaceFixture();
  try {
    git(fixture.workspace, ["init", "-q"]);
    const filePath = path.join(fixture.workspace, "git-gbk-patch.txt");
    fs.writeFileSync(filePath, gbkRevisionBytes("old"));
    git(fixture.workspace, ["add", "git-gbk-patch.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "old"]);
    fs.writeFileSync(filePath, gbkRevisionBytes("new"));

    const patch = await diff(fixture.workspace, "git-gbk-patch.txt", false);

    assert.match(patch, /中文GBK旧版/);
    assert.match(patch, /中文GBK新版/);
  } finally {
    fixture.cleanup();
  }
});

test("show decodes GBK commit patch text", async () => {
  const fixture = createWorkspaceFixture();
  try {
    git(fixture.workspace, ["init", "-q"]);
    const filePath = path.join(fixture.workspace, "git-gbk-show.txt");
    fs.writeFileSync(filePath, gbkRevisionBytes("old"));
    git(fixture.workspace, ["add", "git-gbk-show.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "old"]);
    fs.writeFileSync(filePath, gbkRevisionBytes("new"));
    git(fixture.workspace, ["add", "git-gbk-show.txt"]);
    git(fixture.workspace, ["commit", "-q", "-m", "new"]);
    const newHash = git(fixture.workspace, ["rev-parse", "HEAD"]);

    const result = await show(fixture.workspace, newHash);

    assert.match(result.diff, /中文GBK旧版/);
    assert.match(result.diff, /中文GBK新版/);
  } finally {
    fixture.cleanup();
  }
});

test("orchestration artifact workspace text decodes GBK files", () => {
  const fixture = createWorkspaceFixture();
  try {
    const relPath = "artifact-gbk.txt";
    const binaryRelPath = "artifact-binary.pdf";
    fs.writeFileSync(path.join(fixture.workspace, relPath), gbkRevisionBytes("new"));
    fs.writeFileSync(path.join(fixture.workspace, binaryRelPath), Buffer.from("%PDF-1.7\nbinary"));
    const engine = new OrchestrationEngine({
      db: {
        orchInstances: {
          get: () => ({ workspaceId: "workspace-gbk" }),
        },
        orchArtifactFiles: {
          listByArtifact: () => [
            {
              relPath,
              publishedPath: relPath,
              stagingPath: null,
            },
            {
              relPath: binaryRelPath,
              publishedPath: binaryRelPath,
              stagingPath: null,
            },
          ],
        },
      },
      threads: {},
      sessions: {},
      workspaces: new Map([["workspace-gbk", fixture.workspace]]),
      timeoutPolicy: { mode: "activity", startupTimeoutMs: 1, engineIdleTimeoutMs: 1 },
      emitConversation() {},
      emitRaw() {},
    } as any);

    const text = (engine as any).extractArtifactText({
      id: "artifact-gbk",
      instanceId: "instance-gbk",
      nodeId: "node-gbk",
      kind: "file-output",
      version: 1,
      title: "GBK artifact",
      status: "draft",
      contentJson: JSON.stringify({ mode: "file", file: { path: relPath, content: "" } }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.match(text, /# artifact-gbk\.txt/);
    assert.match(text, /中文GBK新版/);
    assert.doesNotMatch(text, /artifact-binary\.pdf/);
  } finally {
    fixture.cleanup();
  }
});
