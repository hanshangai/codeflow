import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeSearchIndex } from "../src/knowledge/knowledgeSearchIndex.js";
import { KnowledgeAssetError } from "../src/knowledge/knowledgeAssetFiles.js";
import { executeKnowledgeAssetReadTool } from "../src/knowledge/knowledgeAssetTools.js";

test("单文档超过 SQLite 参数上限的分块仍能检索，范围不能跨资产", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-many-chunks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = new KnowledgeSearchIndex(root);
  index.rebuild([{ nodeId: "doc", revisionId: "revision", contentHash: "hash", title: "文档", summary: "", tags: [], path: "docs/a.md", content: "# x\nx\n".repeat(33000) }], "manifest");
  assert.equal(index.search("x", ["doc"]).items.length, 50);
  assert.equal(index.search("x", ["other"]).items.length, 0);
});

test("项目知识使用 FTS5/BM25 与本地特征向量混合检索，并按目录过滤", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "members.ts"), "export function inviteMember() { return true; }\n", "utf8");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [
    { id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "团队成员操作", tags: ["邀请"], instructions: "", sourceScope: ["src"] },
    { id: "billing", parentId: null, title: "账单管理", orderKey: "2", summary: "订单与发票", tags: [], instructions: "", sourceScope: [] },
  ] }, null);
  const source = store.readSource("src/members.ts");
  store.saveDocument({ nodeId: "members", content: "# 成员管理\n\n邀请成员按钮调用 inviteMember。", sources: [{ kind: "code", path: "src/members.ts", symbol: "inviteMember", contentHash: source.contentHash, relation: "成员邀请实现" }], expectedHash: null, origin: "ai" });

  const result = store.search("邀请成员");
  assert.equal(result.backend, "hybrid_sqlite_fts5_vector");
  assert.equal(result.vectorBackend, "local_feature_hash_v1");
  assert.equal(result.items[0]?.nodeId, "members");
  assert.ok((result.items[0]?.keywordScore ?? 0) > 0);
  assert.ok((result.items[0]?.vectorScore ?? 0) > 0);

  const scoped = store.search("邀请成员", "billing");
  assert.equal(scoped.items.length, 0);
  assert.equal(fs.existsSync(path.join(root, ".codeflowai", "knowledge-search.sqlite")), true);
  assert.equal(fs.existsSync(path.join(root, ".codeflowai", "knowledge-cache", "knowledge-search.sqlite")), false);
});


test("资产树范围过滤在关键词候选超过限制时仍优先保留范围内结果", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-search-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodes = Array.from({ length: 205 }, (_, index) => ({
    id: `asset-${index}`,
    parentId: null,
    title: `资产 ${index}`,
    orderKey: String(index),
    summary: "精确关键词示例",
    tags: [],
    instructions: "",
    sourceScope: [],
  }));
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes }, null);
  store.saveDocument({ nodeId: "asset-204", content: "# 精确关键词", sources: [], expectedHash: null, origin: "ai" });

  const result = store.search("精确关键词", "asset-204");
  assert.equal(result.items[0]?.nodeId, "asset-204");
});

test("页面搜索可以查到待采用文档，普通知识检索仍只返回正式版本", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-search-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [
    { id: "office-h5", parentId: null, title: "办公 H5 连接", orderKey: "1", summary: "办公平台 H5 入口", tags: ["H5"], instructions: "", sourceScope: [] },
  ] }, null);
  store.saveDocument({ nodeId: "office-h5", content: "# H5 入口\n\n办公平台入口与企业隔离。", sources: [], expectedHash: null, origin: "ai", adopt: false });

  assert.equal(store.search("h5").items.length, 0);
  assert.equal(store.search("h5", null, true).items[0]?.nodeId, "office-h5");
});

/** 用真实正式知识文件触发索引；Git 夹具仅位于本测试的临时工作区。 */
function searchFixture(t: test.TestContext, git = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (git) execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "doc", parentId: null, title: "检索正文", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  store.saveDocument({ nodeId: "doc", content: "# 检索正文\n\n缓存从正式知识重建。", sources: [], expectedHash: null, origin: "manual" });
  return { root, store, runtime: path.join(root, ".codeflowai"), cache: path.join(root, ".codeflowai", "knowledge-search.sqlite") };
}

test("store 与 AI 搜索从正式知识重建新库且不接触旧缓存", t => {
  const fixture = searchFixture(t, true);
  const oldRoot = path.join(fixture.root, ".codeflowai", "knowledge-cache");
  fs.mkdirSync(oldRoot, { recursive: true });
  const old = Buffer.from("not a database: old cache must stay untouched");
  const oldCache = path.join(oldRoot, "knowledge-search.sqlite");
  fs.writeFileSync(oldCache, old);
  const oldLock = path.join(oldRoot, "execution", "lock.json");
  fs.mkdirSync(path.dirname(oldLock), { recursive: true });
  const lock = Buffer.from("old execution lock and recovery sentinel");
  fs.writeFileSync(oldLock, lock);
  assert.equal(fixture.store.search("检索正文").items[0]?.nodeId, "doc");
  assert.equal(executeKnowledgeAssetReadTool(fixture.store, "knowledge.search", { query: "检索正文" }).ok, true);
  assert.equal(fs.existsSync(fixture.cache), true);
  assert.deepEqual(fs.readFileSync(oldCache), old);
  assert.deepEqual(fs.readFileSync(oldLock), lock);
  execFileSync("git", ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"], { cwd: fixture.root, windowsHide: true });
  fs.renameSync(fixture.cache, `${fixture.cache}.closed`);
});

test("已暂存运行数据时明确拒绝搜索且正文仍可读", t => {
  const fixture = searchFixture(t, true);
  fs.mkdirSync(fixture.runtime, { recursive: true });
  fs.writeFileSync(path.join(fixture.runtime, "tracked.txt"), "keep");
  execFileSync("git", ["add", "--", ".codeflowai/tracked.txt"], { cwd: fixture.root, windowsHide: true });
  assert.throws(() => fixture.store.search("检索正文"), (error: unknown) => error instanceof KnowledgeAssetError && error.status === 409 && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.equal(fs.existsSync(fixture.cache), false);
  assert.equal(fixture.store.detail("doc").current?.content.includes("正式知识"), true);
  assert.equal(execFileSync("git", ["ls-files", "--cached", "--", ".codeflowai/tracked.txt"], { cwd: fixture.root, encoding: "utf8", windowsHide: true }).trim(), ".codeflowai/tracked.txt");
});

for (const subdirectory of [false, true]) {
  test(`SQLite 大小写已跟踪主库保持原字节：${subdirectory ? "子工作区祖先" : "根工作区"}`, { skip: process.platform !== "win32" && process.platform !== "darwin" }, t => {
    const fixture = searchFixture(t, true), relative = subdirectory ? "PROJECT/.CODEFLOWAI" : ".CODEFLOWAI";
    execFileSync("git", ["config", "core.ignorecase", "true"], { cwd: fixture.root, windowsHide: true });
    const trackedPath = path.join(fixture.root, relative, "knowledge-search.sqlite");
    fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
    const db = new DatabaseSync(trackedPath);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep')");
    db.close();
    execFileSync("git", ["add", "--", `${relative}/knowledge-search.sqlite`], { cwd: fixture.root, windowsHide: true });
    const indexPath = path.join(fixture.root, ".git", "index"), excludePath = path.join(fixture.root, ".git", "info", "exclude");
    const before = fs.readFileSync(trackedPath), beforeIndex = fs.readFileSync(indexPath), beforeExclude = fs.readFileSync(excludePath);
    const root = subdirectory ? path.join(fixture.root, "project") : fixture.root;
    assert.throws(() => new KnowledgeSearchIndex(root).hasManifest("manifest"), (error: unknown) => error instanceof KnowledgeAssetError && error.status === 409 && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
    assert.deepEqual(fs.readFileSync(trackedPath), before);
    assert.deepEqual(fs.readFileSync(indexPath), beforeIndex);
    assert.deepEqual(fs.readFileSync(excludePath), beforeExclude);
  });
}

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  test(`真实 rebuild 在工件未排除时不进入 SQLite：${suffix || "主库"}`, t => {
    const fixture = searchFixture(t, true);
    fs.writeFileSync(path.join(fixture.root, ".gitignore"), `!.codeflowai/\n.codeflowai/*\n!.codeflowai/knowledge-search.sqlite${suffix}\n`);
    assert.throws(() => new KnowledgeSearchIndex(fixture.root).rebuild([{ nodeId: "doc", revisionId: "r", contentHash: "h", title: "正文", summary: "", tags: [], content: "真实事务正文", path: null }], "manifest"), (error: unknown) => error instanceof KnowledgeAssetError && error.status === 500);
    assert.equal(fs.existsSync(fixture.cache), false);
  });
}

for (const artifact of ["knowledge-search.sqlite", "knowledge-search.sqlite-wal", "knowledge-search.sqlite-shm", "knowledge-search.sqlite-journal"]) {
  test(`拒绝索引工件目录冲突：${artifact}`, t => {
    const fixture = searchFixture(t);
    fs.mkdirSync(path.join(fixture.runtime, artifact), { recursive: true });
    assert.throws(() => fixture.store.search("检索正文"), (error: unknown) => error instanceof KnowledgeAssetError && error.status === 500);
    assert.equal(fs.statSync(path.join(fixture.runtime, artifact)).isDirectory(), true);
  });
}

test("主库不存在但 sidecar 存在时不新建或清理", t => {
  const fixture = searchFixture(t);
  fs.mkdirSync(fixture.runtime, { recursive: true });
  const sidecar = path.join(fixture.runtime, "knowledge-search.sqlite-wal");
  fs.writeFileSync(sidecar, "orphan");
  assert.throws(() => fixture.store.search("检索正文"), (error: unknown) => error instanceof KnowledgeAssetError && error.status === 500);
  assert.equal(fs.existsSync(fixture.cache), false);
  assert.equal(fs.readFileSync(sidecar, "utf8"), "orphan");
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`sidecar 硬链接不能被 SQLite 打开或修改：${suffix}`, t => {
    const fixture = searchFixture(t);
    const target = path.join(fixture.root, "outside-sidecar");
    fs.writeFileSync(target, "untouched");
    fs.mkdirSync(fixture.runtime, { recursive: true });
    fs.linkSync(target, `${fixture.cache}${suffix}`);
    assert.throws(() => new KnowledgeSearchIndex(fixture.root).hasManifest("manifest"), KnowledgeAssetError);
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
    assert.equal(fs.existsSync(fixture.cache), false);
  });
}

test("拒绝运行目录 junction 与主库硬链接", t => {
  const first = searchFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(first.runtime, { recursive: true, force: true });
  fs.symlinkSync(outside, first.runtime, "junction");
  assert.throws(() => first.store.search("检索正文"), KnowledgeAssetError);
  assert.deepEqual(fs.readdirSync(outside), []);
  const second = searchFixture(t);
  fs.rmSync(second.runtime, { recursive: true, force: true });
  fs.mkdirSync(second.runtime, { recursive: true });
  const target = path.join(outside, "target");
  fs.writeFileSync(target, "untouched");
  fs.linkSync(target, second.cache);
  assert.throws(() => second.store.search("检索正文"), KnowledgeAssetError);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});

test("两个工作区的索引互相隔离", t => {
  const first = searchFixture(t), second = searchFixture(t);
  assert.equal(first.store.search("检索正文").items[0]?.nodeId, "doc");
  assert.equal(second.store.search("检索正文").items[0]?.nodeId, "doc");
  assert.equal(fs.existsSync(first.cache), true);
  assert.equal(fs.existsSync(second.cache), true);
  assert.notEqual(fs.statSync(first.cache).ino, fs.statSync(second.cache).ino);
});

test("开库前运行目录被替换时显式失败", t => {
  const fixture = searchFixture(t);
  const lstat = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (!replaced && String(args[0]) === fixture.cache) {
      fs.renameSync(fixture.runtime, `${fixture.runtime}.original`);
      fs.mkdirSync(fixture.runtime, { recursive: true });
      replaced = true;
    }
    return lstat(...args);
  });
  assert.throws(() => new KnowledgeSearchIndex(fixture.root).hasManifest("manifest"), KnowledgeAssetError);
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(fixture.cache), false);
});

test("开库后 sidecar 被替换为目录时显式失败且连接关闭", t => {
  const fixture = searchFixture(t), prepare = DatabaseSync.prototype.prepare;
  let replaced = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (!replaced) {
      fs.mkdirSync(`${fixture.cache}-wal`);
      replaced = true;
    }
    return prepare.call(this, sql);
  });
  assert.throws(() => new KnowledgeSearchIndex(fixture.root).hasManifest("manifest"), KnowledgeAssetError);
  assert.equal(replaced, true);
  fs.renameSync(fixture.cache, `${fixture.cache}.closed`);
});

test("索引失败且关闭也失败时保留两个根因", t => {
  const fixture = searchFixture(t);
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "prepare", () => { throw new Error("schema-original-failure"); });
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { close.call(this); throw new Error("close-second-failure"); });
  assert.throws(() => new KnowledgeSearchIndex(fixture.root).hasManifest("manifest"), (error: unknown) => {
    assert.ok(error instanceof KnowledgeAssetError);
    assert.match(error.message, /schema-original-failure/);
    assert.match(error.message, /close-second-failure/);
    return true;
  });
});
