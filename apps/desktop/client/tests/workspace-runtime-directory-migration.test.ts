import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateLegacyWorkspaceRuntimeDirectory } from "../src/workspace-migration/workspaceRuntimeDirectoryMigration.ts";

/** 每个场景使用独占临时工作区，只清理本次创建的根。 */
function workspace(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-directory-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("旧运行目录递归合并到 .codeflowai 并删除空目录", t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".codeflow", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codeflow", "workspace.db"), "db");
  fs.writeFileSync(path.join(root, ".codeflow", "cache", "entry"), "cache");
  fs.mkdirSync(path.join(root, ".codeflowai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codeflowai", "codeflowai.json"), "{}");
  migrateLegacyWorkspaceRuntimeDirectory(root);
  assert.equal(fs.existsSync(path.join(root, ".codeflow")), false);
  assert.equal(fs.readFileSync(path.join(root, ".codeflowai", "workspace.db"), "utf8"), "db");
  assert.equal(fs.readFileSync(path.join(root, ".codeflowai", "cache", "entry"), "utf8"), "cache");
  assert.equal(fs.readFileSync(path.join(root, ".codeflowai", "codeflowai.json"), "utf8"), "{}");
});

test("同名冲突保留新目录内容并将旧文件改为 legacy 副本", t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".codeflow"));
  fs.mkdirSync(path.join(root, ".codeflowai"));
  fs.writeFileSync(path.join(root, ".codeflow", "workspace.db"), "old");
  fs.writeFileSync(path.join(root, ".codeflowai", "workspace.db"), "new");
  migrateLegacyWorkspaceRuntimeDirectory(root);
  assert.equal(fs.readFileSync(path.join(root, ".codeflowai", "workspace.db"), "utf8"), "new");
  const legacy = fs.readdirSync(path.join(root, ".codeflowai")).find(name => name.startsWith("workspace.db.legacy-"));
  assert.ok(legacy);
  assert.equal(fs.readFileSync(path.join(root, ".codeflowai", legacy), "utf8"), "old");
});

test("旧目录含符号链接时显式失败且不删除旧目录", t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, ".codeflow"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside", "keep"), "outside");
  fs.symlinkSync(path.join(root, "outside"), path.join(root, ".codeflow", "link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => migrateLegacyWorkspaceRuntimeDirectory(root), /WORKSPACE_RUNTIME_MIGRATION_UNSAFE/u);
  assert.equal(fs.existsSync(path.join(root, ".codeflow")), true);
  assert.equal(fs.readFileSync(path.join(root, "outside", "keep"), "utf8"), "outside");
});
