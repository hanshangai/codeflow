import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspacePath } from "../src/fs/fsHelpers.ts";
import { diffFiles } from "../src/git/gitService.ts";

/** 创建带 sibling 目录的临时 workspace，用于验证路径前缀绕过。 */
function createWorkspaceFixture(): { root: string; workspace: string; sibling: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-path-boundary-"));
  const workspace = path.join(root, "work");
  const sibling = path.join(root, "work2");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  return {
    root,
    workspace,
    sibling,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("resolveWorkspacePath rejects sibling paths with the same string prefix", () => {
  const fixture = createWorkspaceFixture();
  try {
    const inside = path.join(fixture.workspace, "src", "index.ts");
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, "ok", "utf8");

    assert.equal(resolveWorkspacePath(fixture.workspace, "src/index.ts"), inside);
    assert.throws(
      () => resolveWorkspacePath(fixture.workspace, "../work2/secret.txt"),
      /非法路径（越界）/,
    );
    assert.throws(
      () => resolveWorkspacePath(fixture.workspace, path.join(fixture.sibling, "secret.txt")),
      /非法路径（越界）/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("git diffFiles rejects absolute paths outside workspace", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const outside = path.join(fixture.sibling, "secret.txt");
    fs.writeFileSync(outside, "secret", "utf8");

    await assert.rejects(
      () => diffFiles(fixture.workspace, outside, false),
      /非法路径（越界）/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("git diffFiles still reads files inside workspace", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const inside = path.join(fixture.workspace, "notes.txt");
    fs.writeFileSync(inside, "workspace content", "utf8");

    const result = await diffFiles(fixture.workspace, "notes.txt", false);

    assert.equal(result.modified, "workspace content");
  } finally {
    fixture.cleanup();
  }
});
