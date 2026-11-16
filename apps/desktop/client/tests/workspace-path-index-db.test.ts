import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { openSqliteDb } from "../src/db/sqliteDb.ts";
import {
  openWorkspacePathIndexDb,
  recoverWorkspacePathIndexDbFiles,
  WorkspacePathIndexDbError,
} from "../src/fs/workspacePathIndexDb.ts";
import {
  WORKSPACE_PATH_INDEX_APPLICATION_ID,
  WORKSPACE_PATH_INDEX_SCHEMA_VERSION,
} from "../src/fs/workspacePathIndexConfig.ts";

const settings = {
  configStamp: "config-v1",
  excludeRulesStamp: "ignore-v1",
  maxEntries: 1_000,
};

function createWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-file-index-db-"));
}

function createDirectoryLink(targetPath: string, linkPath: string): void {
  fs.symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

test("workspace path index db creates isolated schema under each workspace", () => {
  const firstRoot = createWorkspace();
  const secondRoot = createWorkspace();
  const first = openWorkspacePathIndexDb({ workspaceId: "local:first", workspacePath: firstRoot, settings });
  const second = openWorkspacePathIndexDb({ workspaceId: "local:second", workspacePath: secondRoot, settings });
  try {
    assert.equal(first.indexPath, path.join(fs.realpathSync.native(firstRoot), ".codeflowai", "file-index.db"));
    assert.equal(second.indexPath, path.join(fs.realpathSync.native(secondRoot), ".codeflowai", "file-index.db"));
    assert.notEqual(first.indexPath, second.indexPath);

    const raw = openSqliteDb(first.indexPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(Number(raw.pragma("application_id", { simple: true })), WORKSPACE_PATH_INDEX_APPLICATION_ID);
      assert.equal(Number(raw.pragma("user_version", { simple: true })), WORKSPACE_PATH_INDEX_SCHEMA_VERSION);
      const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      assert.equal(tables.has("file_index_meta"), true);
      assert.equal(tables.has("file_index_entries"), true);
      assert.equal(tables.has("file_index_mutations"), true);
    } finally {
      raw.close();
    }
  } finally {
    first.close();
    second.close();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("workspace path index db leaves legacy artifacts untouched during open and recovery", () => {
  const root = createWorkspace();
  const legacyDirectory = path.join(root, "codeflowai");
  fs.mkdirSync(legacyDirectory);
  const names = ["file-index.db", "file-index.db-wal", "file-index.db-shm", "file-index.db-journal", "file-index.db.recovery-old"];
  const sentinels = names.map((name) => ({ name, bytes: Buffer.from(`legacy:${name}`) }));
  for (const { name, bytes } of sentinels) fs.writeFileSync(path.join(legacyDirectory, name), bytes);
  try {
    const db = openWorkspacePathIndexDb({ workspaceId: "local:legacy-sentinel", workspacePath: root, settings });
    const indexPath = db.indexPath;
    db.close();
    const recovery = recoverWorkspacePathIndexDbFiles(root);
    assert.equal(recovery.indexPath, path.join(fs.realpathSync.native(root), ".codeflowai", "file-index.db"));
    assert.ok(recovery.recoveredPaths.length > 0);
    assert.ok(recovery.recoveredPaths.every((entry) => path.dirname(entry) === path.dirname(indexPath)));
    for (const { name, bytes } of sentinels) assert.deepEqual(fs.readFileSync(path.join(legacyDirectory, name)), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db rejects an external runtime symlink or junction before creating sqlite files", (t) => {
  const root = createWorkspace();
  const externalRoot = createWorkspace();
  const linkedDirectory = path.join(root, ".codeflowai");
  try {
    try {
      createDirectoryLink(externalRoot, linkedDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOSYS"].includes(String(code))) {
        t.skip(`当前环境无法创建 symlink/junction：${code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => {
        const db = openWorkspacePathIndexDb({ workspaceId: "local:linked-container", workspacePath: root, settings });
        db.close();
      },
      (error: unknown) => (
        error instanceof WorkspacePathIndexDbError
        && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE"
      ),
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
  } finally {
    try {
      fs.unlinkSync(linkedDirectory);
    } catch {
      // 链接未创建或已清理。
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index db rejects a hard-linked database before opening it", (t) => {
  const root = createWorkspace();
  const externalRoot = createWorkspace();
  const created = openWorkspacePathIndexDb({ workspaceId: "local:hard-linked-db", workspacePath: root, settings });
  const indexPath = created.indexPath;
  created.close();
  const externalLink = path.join(externalRoot, "outside-index.db");
  try {
    try {
      fs.linkSync(indexPath, externalLink);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOSYS", "EXDEV"].includes(String(code))) {
        t.skip(`当前平台无法创建硬链接：${code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => openWorkspacePathIndexDb({ workspaceId: "local:hard-linked-db", workspacePath: root, settings }),
      (error: unknown) => (
        error instanceof WorkspacePathIndexDbError
        && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE"
      ),
    );
    assert.equal(fs.readFileSync(indexPath).equals(fs.readFileSync(externalLink)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index db rechecks every public write before touching unsafe sidecars", () => {
  const root = createWorkspace();
  const external = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:write-guard", workspacePath: root, settings });
  const generation = db.reserveBuild(settings, "guard");
  const before = db.getMeta();
  const sentinel = path.join(external, "sentinel");
  const sidecar = `${db.indexPath}-journal`;
  fs.writeFileSync(sentinel, "outside");
  fs.linkSync(sentinel, sidecar);
  try {
    const writes = [
      () => db.reserveBuild(settings, "unsafe"),
      () => db.markBuilding(generation),
      () => db.writeBuildEntries(generation, []),
      () => db.publishBuild(generation, false),
      () => db.cancelBuild(generation, "failed", "unsafe"),
      () => db.applyMutations([]),
      () => db.updateStatus("failed", true, "unsafe"),
    ];
    for (const write of writes) assert.throws(write, (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
    fs.unlinkSync(sidecar);
    assert.deepEqual(db.getMeta(), before);
  } finally {
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("workspace path index db rejects tracked runtime files after opening and permits writes after repair", () => {
  const root = createWorkspace();
  const runGit = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit("init");
  const db = openWorkspacePathIndexDb({ workspaceId: "local:tracked-write", workspacePath: root, settings });
  try {
    runGit("add", "-f", "--", ".codeflowai/file-index.db");
    assert.throws(() => db.reserveBuild(settings, "tracked"), (error: unknown) => (error as { code?: string }).code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
    runGit("rm", "--cached", "--", ".codeflowai/file-index.db");
    assert.ok(db.reserveBuild(settings, "repaired") > 0);
    const ignorePath = path.join(root, ".gitignore");
    fs.writeFileSync(ignorePath, "!.codeflowai/\n!.codeflowai/file-index.db-journal\n");
    assert.throws(() => db.updateStatus("stale", true, "rule changed"), (error: unknown) => (error as { code?: string }).code === "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED");
    fs.unlinkSync(ignorePath);
    assert.equal(db.updateStatus("stale", true, "repaired").status, "stale");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db rejects a replaced runtime directory on its long connection", (t) => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:directory-replaced", workspacePath: root, settings });
  const runtime = path.dirname(db.indexPath);
  const parked = path.join(root, "parked-runtime");
  try {
    try { fs.renameSync(runtime, parked); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows 禁止替换持有 SQLite 连接的目录");
        return;
      }
      throw error;
    }
    fs.mkdirSync(runtime);
    assert.throws(() => db.reserveBuild(settings, "replaced"), (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
    assert.deepEqual(fs.readdirSync(runtime), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db publishes generation atomically and queries persisted entries", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:publish", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "queued");
    assert.equal(db.markBuilding(generation), true);
    assert.equal(db.writeBuildEntries(generation, [
      { path: "src", name: "src", isDir: true, hidden: false, parentEntryOrder: 0 },
      { path: "src/alpha😀.ts", name: "alpha😀.ts", isDir: false, hidden: false, parentEntryOrder: 0 },
      { path: "src/alphabet.ts", name: "alphabet.ts", isDir: false, hidden: false, parentEntryOrder: 1 },
      { path: "src/aax.txt", name: "aax.txt", isDir: false, hidden: false, parentEntryOrder: 2 },
      { path: "src/😀x.txt", name: "😀x.txt", isDir: false, hidden: false, parentEntryOrder: 3 },
    ]), true);

    assert.equal(db.getMeta().activeGeneration, null);
    const published = db.publishBuild(generation, false);
    assert.equal(published.activeGeneration, generation);
    assert.equal(published.activeIndexedCount, 5);
    assert.equal(published.status, "ready");

    const page = db.search("alpha", { limit: 10, offset: 0, includeHidden: false, kind: "all" });
    assert.deepEqual(page.entries.map((entry) => entry.path), ["src/alpha😀.ts", "src/alphabet.ts"]);
    const directoryPage = db.searchDirectory("src", "", { limit: 10, offset: 0, includeHidden: false, kind: "all" });
    assert.deepEqual(directoryPage.entries.map((entry) => entry.path), [
      "src/alpha😀.ts",
      "src/alphabet.ts",
      "src/aax.txt",
      "src/😀x.txt",
    ]);
    assert.deepEqual(
      db.search("x", { limit: 10, offset: 0, includeHidden: false, kind: "file" }).entries.map((entry) => entry.path),
      ["src/aax.txt", "src/😀x.txt"],
      "UTF-16 code-unit 分数相同时应按稳定 path_key 排序",
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db keeps active generation when a later build is cancelled", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:atomic", workspacePath: root, settings });
  try {
    const firstGeneration = db.reserveBuild(settings, "first");
    db.writeBuildEntries(firstGeneration, [
      { path: "stable.txt", name: "stable.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    db.publishBuild(firstGeneration, false);

    const secondGeneration = db.reserveBuild(settings, "second");
    db.writeBuildEntries(secondGeneration, [
      { path: "unpublished.txt", name: "unpublished.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    assert.equal(db.cancelBuild(secondGeneration, "failed", "cancelled"), true);
    assert.equal(db.writeBuildEntries(secondGeneration, []), false);
    assert.equal(db.writeBuildEntries(0, [
      { path: "generation-zero.txt", name: "generation-zero.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]), false);
    assert.throws(
      () => db.publishBuild(0, false),
      (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_STALE_GENERATION",
    );
    assert.throws(
      () => db.publishBuild(secondGeneration, false),
      (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_STALE_GENERATION",
    );
    assert.equal(db.getMeta().activeGeneration, firstGeneration);
    assert.deepEqual(
      db.search("stable", { limit: 10, offset: 0, includeHidden: false, kind: "all" }).entries.map((entry) => entry.path),
      ["stable.txt"],
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db persists incremental mutations across reopen", () => {
  const root = createWorkspace();
  let db = openWorkspacePathIndexDb({ workspaceId: "local:restart", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "build");
    db.writeBuildEntries(generation, [
      { path: "old.txt", name: "old.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    db.publishBuild(generation, false);
    db.applyMutations([
      { type: "delete", path: "old.txt", recursive: true },
      { type: "upsert", entry: { path: "new.txt", name: "new.txt", isDir: false, hidden: false, parentEntryOrder: 1 } },
    ]);
    db.close();

    db = openWorkspacePathIndexDb({ workspaceId: "local:restart", workspacePath: root, settings });
    assert.equal(db.isActiveCompatible(settings), true);
    assert.deepEqual(db.search("old", { limit: 10, offset: 0, includeHidden: false, kind: "all" }).entries, []);
    assert.deepEqual(
      db.search("new", { limit: 10, offset: 0, includeHidden: false, kind: "all" }).entries.map((entry) => entry.path),
      ["new.txt"],
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db resolves rename source directory before mutation and journals stale", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:rename-source-directory", workspacePath: root, settings });
  try {
    const activeGeneration = db.reserveBuild(settings, "active");
    db.writeBuildEntries(activeGeneration, [
      { path: "old-dir", name: "old-dir", isDir: true, hidden: false, parentEntryOrder: 0 },
      { path: "old-dir/child.ts", name: "child.ts", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    db.publishBuild(activeGeneration, false);

    const buildGeneration = db.reserveBuild(settings, "calibration");
    db.writeBuildEntries(buildGeneration, [
      { path: "old-dir", name: "old-dir", isDir: true, hidden: false, parentEntryOrder: 0 },
      { path: "old-dir/child.ts", name: "child.ts", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    const updated = db.applyMutations([
      { type: "delete", path: "old-dir", recursive: true },
      {
        type: "upsert",
        entry: { path: "new-file", name: "new-file", isDir: false, hidden: false, parentEntryOrder: 1 },
      },
    ], { staleIfDirectoryPaths: ["old-dir"] });
    assert.equal(updated.partial, true);
    assert.match(updated.message ?? "", /目录变更/);

    db.writeBuildEntries(buildGeneration, [
      { path: "old-dir/late.ts", name: "late.ts", isDir: false, hidden: false, parentEntryOrder: 1 },
    ]);
    const published = db.publishBuild(buildGeneration, false);
    assert.equal(published.status, "stale");
    assert.equal(published.partial, true);
    assert.match(published.message ?? "", /目录变更/);
    assert.deepEqual(db.search("old-dir", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries, []);
    assert.deepEqual(db.search("late", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries, []);
    assert.deepEqual(
      db.search("new-file", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries.map((entry) => entry.path),
      ["new-file"],
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db bounds oversized offsets without poisoning the connection", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:offset-boundary", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "build");
    db.writeBuildEntries(generation, [
      { path: "src", name: "src", isDir: true, hidden: false, parentEntryOrder: 0 },
      { path: "src/healthy.ts", name: "healthy.ts", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    db.publishBuild(generation, false);

    assert.deepEqual(db.search("healthy", { limit: 10, offset: 1e36, includeHidden: false, kind: "all" }).entries, []);
    assert.deepEqual(db.searchDirectory("src", "", {
      limit: 10,
      offset: 1e36,
      includeHidden: false,
      kind: "all",
    }).entries, []);
    assert.deepEqual(
      db.search("healthy", { limit: 10, offset: 0, includeHidden: false, kind: "all" }).entries.map((entry) => entry.path),
      ["src/healthy.ts"],
    );
    assert.equal(db.getMeta().status, "ready");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db rejects another workspace id without reading its entries", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:owner", workspacePath: root, settings });
  db.close();
  try {
    assert.throws(
      () => openWorkspacePathIndexDb({ workspaceId: "local:other", workspacePath: root, settings }),
      (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_METADATA_MISMATCH",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db distinguishes an exact capacity build from a truncated update", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:capacity", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "capacity");
    for (let batch = 0; batch < 2; batch += 1) {
      db.writeBuildEntries(generation, Array.from({ length: 500 }, (_, index) => {
        const ordinal = batch * 500 + index;
        const name = `entry-${String(ordinal).padStart(4, "0")}.txt`;
        return { path: name, name, isDir: false, hidden: false, parentEntryOrder: ordinal };
      }));
    }
    const published = db.publishBuild(generation, false);
    assert.equal(published.activeIndexedCount, 1_000);
    assert.equal(published.status, "ready");
    assert.equal(published.partial, false);

    const updated = db.applyMutations([{
      type: "upsert",
      entry: { path: "overflow.txt", name: "overflow.txt", isDir: false, hidden: false, parentEntryOrder: 1_001 },
    }]);
    assert.equal(updated.activeIndexedCount, 1_000);
    assert.equal(updated.status, "stale");
    assert.equal(updated.partial, true);
    assert.match(updated.message ?? "", /索引已达到上限/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db persists build truncation when a worker batch exceeds capacity", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:build-capacity", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "capacity");
    for (let batch = 0; batch < 2; batch += 1) {
      const length = batch === 0 ? 500 : 501;
      db.writeBuildEntries(generation, Array.from({ length }, (_, index) => {
        const ordinal = batch * 500 + index;
        const name = `build-entry-${String(ordinal).padStart(4, "0")}.txt`;
        return { path: name, name, isDir: false, hidden: false, parentEntryOrder: ordinal };
      }));
    }
    const published = db.publishBuild(generation, false);
    assert.equal(published.activeIndexedCount, 1_000);
    assert.equal(published.status, "stale");
    assert.equal(published.partial, true);
    assert.match(published.message ?? "", /索引已达到上限/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db marks publish partial when mutation replay exceeds capacity", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:mutation-capacity", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "capacity");
    for (let batch = 0; batch < 2; batch += 1) {
      db.writeBuildEntries(generation, Array.from({ length: 500 }, (_, index) => {
        const ordinal = batch * 500 + index;
        const name = `mutation-base-${String(ordinal).padStart(4, "0")}.txt`;
        return { path: name, name, isDir: false, hidden: false, parentEntryOrder: ordinal };
      }));
    }
    db.applyMutations([{
      type: "upsert",
      entry: { path: "mutation-overflow.txt", name: "mutation-overflow.txt", isDir: false, hidden: false, parentEntryOrder: 1_001 },
    }]);
    const published = db.publishBuild(generation, false);
    assert.equal(published.activeIndexedCount, 1_000);
    assert.equal(published.status, "stale");
    assert.equal(published.partial, true);
    assert.match(published.message ?? "", /索引已达到上限/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db replays recursive delete after a late worker batch", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:late-delete", workspacePath: root, settings });
  try {
    const generation = db.reserveBuild(settings, "late-delete");
    db.writeBuildEntries(generation, [
      { path: "removed-dir", name: "removed-dir", isDir: true, hidden: false, parentEntryOrder: 0 },
      { path: "removed-dir/child.ts", name: "child.ts", isDir: false, hidden: false, parentEntryOrder: 0 },
    ]);
    db.applyMutations([{ type: "delete", path: "removed-dir", recursive: true }]);
    db.writeBuildEntries(generation, [
      { path: "removed-dir/late.ts", name: "late.ts", isDir: false, hidden: false, parentEntryOrder: 1 },
    ]);
    const published = db.publishBuild(generation, false);
    assert.equal(published.status, "ready");
    assert.deepEqual(db.search("removed-dir", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries, []);
    assert.deepEqual(db.search("late", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries, []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db keeps executing upserts after a capacity drop", () => {
  const root = createWorkspace();
  const smallSettings = { ...settings, maxEntries: 2 };
  const db = openWorkspacePathIndexDb({ workspaceId: "local:drop-sequence", workspacePath: root, settings: smallSettings });
  try {
    const first = db.reserveBuild(smallSettings, "first");
    db.writeBuildEntries(first, [
      { path: "a.txt", name: "a.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
      { path: "b.txt", name: "b.txt", isDir: false, hidden: false, parentEntryOrder: 1 },
    ]);
    db.publishBuild(first, false);
    const second = db.reserveBuild(smallSettings, "second");
    db.writeBuildEntries(second, [
      { path: "a.txt", name: "a.txt", isDir: false, hidden: false, parentEntryOrder: 0 },
      { path: "b.txt", name: "b.txt", isDir: false, hidden: false, parentEntryOrder: 1 },
    ]);
    db.applyMutations([
      ...Array.from({ length: 300 }, (_, index) => ({
        type: "upsert" as const,
        entry: {
          path: `overflow-${index}.txt`,
          name: `overflow-${index}.txt`,
          isDir: false,
          hidden: false,
          parentEntryOrder: index + 2,
        },
      })),
      { type: "delete", path: "b.txt", recursive: true },
      { type: "upsert", entry: { path: "d.txt", name: "d.txt", isDir: false, hidden: false, parentEntryOrder: 302 } },
      { type: "upsert", entry: { path: "a.txt", name: "a.txt", isDir: false, hidden: true, parentEntryOrder: 0 } },
    ]);
    const published = db.publishBuild(second, false);
    assert.equal(published.status, "stale");
    assert.equal(published.partial, true);
    assert.deepEqual(
      db.searchDirectory("", "", { limit: 10, offset: 0, includeHidden: false, kind: "all" }).entries.map((entry) => entry.path),
      ["d.txt"],
    );
    assert.deepEqual(
      db.searchDirectory("", "", { limit: 10, offset: 0, includeHidden: true, kind: "all" }).entries.map((entry) => entry.path),
      ["a.txt", "d.txt"],
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db rejects schema drift before queries", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:drift", workspacePath: root, settings });
  const indexPath = db.indexPath;
  db.close();
  const raw = openSqliteDb(indexPath);
  raw.exec("DROP INDEX idx_file_index_entries_parent");
  raw.close();
  try {
    assert.throws(
      () => openWorkspacePathIndexDb({ workspaceId: "local:drift", workspacePath: root, settings }),
      (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_SCHEMA_INCOMPATIBLE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index db classifies a malformed sqlite file as corrupt", () => {
  const root = createWorkspace();
  const db = openWorkspacePathIndexDb({ workspaceId: "local:corrupt", workspacePath: root, settings });
  const indexPath = db.indexPath;
  db.close();
  fs.writeFileSync(indexPath, "not a sqlite database", "utf8");
  try {
    assert.throws(
      () => openWorkspacePathIndexDb({ workspaceId: "local:corrupt", workspacePath: root, settings }),
      (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_CORRUPT",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
