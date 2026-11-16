import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";

const PRIVATE_CONTENT = "# Private runtime trace\nNot a project source.\n";
const PUBLIC_CONTENT = "# Project rule\nKeep failures explicit.\n";
const PRIVATE_HASH = createHash("sha256").update(PRIVATE_CONTENT).digest("hex");
const PUBLIC_HASH = createHash("sha256").update(PUBLIC_CONTENT).digest("hex");
const FORBIDDEN = { code: "KNOWLEDGE_ASSET_PATH_INVALID", status: 403 };

/** Create real project files; every test owns and removes its temporary root. */
function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-private-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [".codeflow", "nested/.codeflow", "src", ".claude/rules", ".codeflow-design", ".codeflowai"]) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }
  for (const relative of [".codeflow/trace.md", "nested/.codeflow/trace.md"]) {
    fs.writeFileSync(path.join(root, relative), PRIVATE_CONTENT, "utf8");
  }
  for (const relative of ["src/rule.md", ".codeflow-design.md", ".codeflow-design/rule.md"]) {
    fs.writeFileSync(path.join(root, relative), PUBLIC_CONTENT, "utf8");
  }
  return { root, store: new KnowledgeAssetStore(root) };
}

/** Use a real internal directory alias without requiring Windows file symlink privileges. */
function directoryAlias(root: string, target: string, alias: string): void {
  fs.symlinkSync(path.join(root, target), path.join(root, alias), process.platform === "win32" ? "junction" : "dir");
}

test("source listings exclude private runtime directories at root and nested levels", t => {
  const { store } = project(t);
  assert.equal(store.listFiles().entries.some(entry => entry.path === ".codeflowai"), false);
  assert.deepEqual(store.listFiles("nested").entries, []);
});

test("source reads reject exact private runtime segments including case variants and missing files", t => {
  const { store } = project(t);
  for (const relative of [".codeflow/trace.md", "nested/.codeflow/trace.md", ".CODEFLOW/trace.md", ".codeflow/missing.md"]) {
    assert.throws(() => store.readSource(relative), FORBIDDEN, relative);
  }
  assert.throws(() => store.readSourceDirectory(".codeflowai"), FORBIDDEN);
});

for (const checkHash of [false, true]) {
  test(`source submissions reject private runtime traces with checkHash=${checkHash}`, t => {
    const { store } = project(t);
    assert.throws(() => store.parseSources([{
      kind: "document", path: ".codeflow/trace.md", contentHash: PRIVATE_HASH, relation: "Runtime trace",
    }], checkHash), FORBIDDEN);
  });
}

test("document discovery and imports reject private runtime content before publishing a tree", t => {
  const { root, store } = project(t);
  assert.equal(store.importFiles().directories.includes(".codeflowai"), false);
  for (const directory of [".codeflowai", "nested/.codeflow"]) {
    assert.throws(() => store.importFiles(directory), FORBIDDEN);
  }
  assert.throws(() => store.importFile({
    path: ".codeflow/trace.md", contentHash: PRIVATE_HASH, parentId: null, treeHash: null,
  }), FORBIDDEN);
  assert.equal(fs.existsSync(path.join(root, store.root)), false);
});

test("internal rule aliases cannot expose private runtime files through any source entry", t => {
  const { root, store } = project(t);
  directoryAlias(root, ".codeflow", ".claude/rules/runtime-alias");
  const directory = ".claude/rules/runtime-alias";
  const relative = `${directory}/trace.md`;
  assert.throws(() => store.listFiles(directory), FORBIDDEN);
  assert.throws(() => store.readSource(relative), FORBIDDEN);
  assert.throws(() => store.readSourceDirectory(directory), FORBIDDEN);
  for (const checkHash of [false, true]) {
    assert.throws(() => store.parseSources([{
      kind: "document", path: relative, contentHash: PRIVATE_HASH, relation: "Aliased runtime trace",
    }], checkHash), FORBIDDEN);
  }
  assert.throws(() => store.importFiles(directory), FORBIDDEN);
  assert.throws(() => store.importFile({ path: relative, contentHash: PRIVATE_HASH, parentId: null, treeHash: null }), FORBIDDEN);
});

test("ordinary sources and exact-name neighbors remain readable and importable", t => {
  const { store } = project(t);
  for (const relative of ["src/rule.md", ".codeflow-design.md", ".codeflow-design/rule.md"]) {
    assert.equal(store.readSource(relative).content, PUBLIC_CONTENT);
    const source = { kind: "document", path: relative, contentHash: PUBLIC_HASH, relation: "Project rule" };
    assert.deepEqual(store.parseSources([source], true), [source]);
  }
  assert.deepEqual(store.importFiles(".codeflow-design").files.map(file => file.path), [".codeflow-design/rule.md"]);
  assert.ok(store.listFiles().entries.some(entry => entry.path === ".codeflow-design.md"));
  const imported = store.importFile({ path: ".codeflow-design.md", contentHash: PUBLIC_HASH, parentId: null, treeHash: null });
  assert.equal(store.detail(imported.id).reference?.content, PUBLIC_CONTENT);
});

test("legitimate internal rule aliases retain source read, submission and import access", t => {
  const { root, store } = project(t);
  directoryAlias(root, "src", ".claude/rules/source-alias");
  const relative = ".claude/rules/source-alias/rule.md";
  assert.equal(store.readSource(relative).content, PUBLIC_CONTENT);
  assert.deepEqual(store.listFiles(".claude/rules/source-alias").entries.map(entry => entry.path), [relative]);
  const source = { kind: "document", path: relative, contentHash: PUBLIC_HASH, relation: "Linked project rule" };
  assert.deepEqual(store.parseSources([source], true), [source]);
  const imported = store.importFile({ path: relative, contentHash: PUBLIC_HASH, parentId: null, treeHash: null });
  assert.equal(store.detail(imported.id).reference?.content, PUBLIC_CONTENT);
});
