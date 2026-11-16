import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupLegacyWorkspaceCodeflowaiDirectory,
  ensureWorkspaceCodeflowaiDirectory,
  inspectExistingWorkspaceCodeflowaiDirectory,
  assertWorkspaceCodeflowaiDirectory,
  isWorkspaceCodeflowaiFileDeviceMatch,
  readWorkspaceCodeflowaiFile,
  writeWorkspaceCodeflowaiFile,
} from "../src/codeflowai/workspaceCodeflowaiDirectory.ts";

test("Windows accepts an unavailable device id without accepting conflicting known devices", () => {
  assert.equal(isWorkspaceCodeflowaiFileDeviceMatch(0, 1_311_999_737, "win32"), true);
  assert.equal(isWorkspaceCodeflowaiFileDeviceMatch(10, 20, "win32"), false);
  assert.equal(isWorkspaceCodeflowaiFileDeviceMatch(0, 1_311_999_737, "darwin"), false);
});

test("private runtime directory shares the existing identity checks without changing the public default", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = ensureWorkspaceCodeflowaiDirectory(root, ".codeflow");
  assert.equal(directory.directoryPath, path.join(fs.realpathSync.native(root), ".codeflow"));
  assert.equal(ensureWorkspaceCodeflowaiDirectory(root).directoryPath, path.join(fs.realpathSync.native(root), ".codeflowai"));
  writeWorkspaceCodeflowaiFile(directory, "cache", "shared");
  assert.equal(readWorkspaceCodeflowaiFile(directory, "cache").toString(), "shared");
  fs.renameSync(directory.directoryPath, path.join(root, "original"));
  fs.mkdirSync(directory.directoryPath);
  assert.throws(() => assertWorkspaceCodeflowaiDirectory(directory), /替换/);
});

test("legacy control directory is removed only after copied files and index cache are safe", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-control-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = ensureWorkspaceCodeflowaiDirectory(root);
  writeWorkspaceCodeflowaiFile(current, "codeflowai.json", "{}");
  fs.writeFileSync(path.join(current.directoryPath, "file-index.db"), "");
  const legacy = path.join(root, "codeflowai");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "codeflowai.json"), "{}");
  fs.writeFileSync(path.join(legacy, "file-index.db"), "old-cache");
  fs.writeFileSync(path.join(legacy, "file-index.db-wal"), "old-wal");
  cleanupLegacyWorkspaceCodeflowaiDirectory(root);
  assert.equal(fs.existsSync(legacy), false);

  const kept = path.join(root, "codeflowai");
  fs.mkdirSync(kept);
  fs.writeFileSync(path.join(kept, "unknown.txt"), "keep");
  cleanupLegacyWorkspaceCodeflowaiDirectory(root);
  assert.equal(fs.existsSync(kept), true);
});

test("legacy control directory with different config keeps old bytes beside current config", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-control-directory-diff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = ensureWorkspaceCodeflowaiDirectory(root);
  writeWorkspaceCodeflowaiFile(current, "codeflowai.json", '{"current":true}');
  const legacy = path.join(root, "codeflowai");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "codeflowai.json"), '{"legacy":true}');
  cleanupLegacyWorkspaceCodeflowaiDirectory(root);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(readWorkspaceCodeflowaiFile(current, "codeflowai.json").toString("utf8"), '{"current":true}');
  const preserved = fs.readdirSync(current.directoryPath).find(name => name.startsWith("codeflowai.json.legacy-"));
  assert.ok(preserved);
  assert.equal(fs.readFileSync(path.join(current.directoryPath, preserved), "utf8"), '{"legacy":true}');
});

test("legacy control directory cleanup defers locked cache without failing the caller", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-control-directory-locked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = ensureWorkspaceCodeflowaiDirectory(root);
  writeWorkspaceCodeflowaiFile(current, "codeflowai.json", "{}");
  fs.writeFileSync(path.join(current.directoryPath, "file-index.db"), "");
  const legacy = path.join(root, "codeflowai");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "file-index.db"), "locked-cache");
  const busy = Object.assign(new Error("locked"), { code: "EBUSY" });
  t.mock.method(fs, "unlinkSync", () => { throw busy; });
  const deferred: unknown[] = [];
  cleanupLegacyWorkspaceCodeflowaiDirectory(root, error => { deferred.push(error); });
  assert.deepEqual(deferred, [busy]);
  assert.equal(fs.existsSync(legacy), true);
});

test("workspace control files remain writable when lstat and fstat expose different device ids", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-workspace-directory-"));
  try {
    const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
    writeWorkspaceCodeflowaiFile(directory, "config.json", "first");
    writeWorkspaceCodeflowaiFile(directory, "config.json", "second");

    assert.equal(readWorkspaceCodeflowaiFile(directory, "config.json").toString("utf8"), "second");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("removed workspace root has no existing control directory and is not recreated by inspection", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-workspace-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, "removed");
  assert.equal(inspectExistingWorkspaceCodeflowaiDirectory(missing), null);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => ensureWorkspaceCodeflowaiDirectory(missing), /WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE|无法确认工作区物理根/u);
});
