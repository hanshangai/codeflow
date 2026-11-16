import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { migrateClientDb } from "../src/db/migrateClientDb.js";

import {
  WorkspaceMigrationFileClientError,
  WorkspaceMigrationFileWorkerClient,
} from "../src/workspace-migration/workspaceMigrationFileWorkerClient.ts";
import {
  copyWorkspaceMigrationTree,
  scanWorkspaceMigrationTree,
  WorkspaceMigrationFileError,
  probeWorkspaceMigrationTarget,
  verifyWorkspaceMigrationTrees,
  snapshotWorkspaceDatabase,
} from "../src/workspace-migration/workspaceMigrationFileOps.ts";
import { workspaceDbSnapshotTemporaryName } from "../src/workspace-migration/workspaceMigrationFileProtocol.js";

type Fixture = {
  root: string;
  source: string;
  targetParent: string;
  target: string;
  staging: string;
};

const TEST_TARGET_FILE_SYSTEM_TYPE = process.platform === "win32" ? "ntfs" : process.platform === "darwin" ? "apfs" : "ext4";
const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 创建源、目标父目录和自动清理的迁移测试夹具。 */
function createFixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-workspace-migration-"));
  const source = path.join(root, "source");
  const targetParent = path.join(root, "target-parent");
  fs.mkdirSync(source);
  fs.mkdirSync(targetParent);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    source,
    targetParent,
    target: path.join(targetParent, "target"),
    staging: path.join(targetParent, "staging"),
  };
}

/** 断言 Worker 返回指定业务错误码和内部原因。 */
async function expectWorkerError(
  promise: Promise<unknown>,
  code: WorkspaceMigrationFileClientError["code"],
  reason: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.code, code);
    assert.equal(error.details.reason, reason);
    return true;
  });
}

/** 构造带稳定 code 的文件系统测试错误。 */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** 断言直接文件操作返回指定业务原因。 */
async function expectFileOperationError(action: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileError);
    assert.equal(error.details.reason, reason);
    return true;
  });
}

/** 写入基础工作区内容，覆盖隐藏文件、空目录和 Git 普通目录。 */
function seedWorkspace(fixture: Fixture): void {
  fs.mkdirSync(path.join(fixture.source, "src"));
  fs.mkdirSync(path.join(fixture.source, "empty"));
  fs.mkdirSync(path.join(fixture.source, ".git"));
  fs.writeFileSync(path.join(fixture.source, "README.md"), "readme\n", "utf8");
  fs.writeFileSync(path.join(fixture.source, ".env"), "TOKEN=redacted\n", "utf8");
  fs.writeFileSync(path.join(fixture.source, "src", "index.ts"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(fixture.source, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
}

test("D18 snapshot 固定容器下真实 SQLite 复制保持数据与只读校验", async t => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.source, ".codeflow")); fs.mkdirSync(fixture.target);
  fs.mkdirSync(path.join(fixture.target, ".codeflow"));
  const source = openSqliteDb(path.join(fixture.source, ".codeflow", "workspace.db"));
  try { migrateClientDb(source, { scope: "workspace" }); source.prepare("INSERT INTO workspace_prefs VALUES ('ws','codex','general',1,88,NULL)").run(); }
  finally { source.close(); }
  const worker = new WorkspaceMigrationFileWorkerClient();
  const events: unknown[] = [];
  const watcher = worker.watch({ watchRoot: fixture.target, recursive: true, caseSensitive: process.platform !== "win32" }, {
    onChanged: event => { events.push(event); }, onError: error => { throw error; },
  });
  await watcher.ready;
  try {
    const context = { sourceRoot: fixture.source, targetRoot: fixture.target, operationId: "snapshot-fixture", workspaceId: "ws", requestId: "snapshot-fixture" };
    const result = await worker.snapshotWorkspaceDb(context).promise;
    assert.equal(result.evidence.state, "ready");
    await worker.verifyWorkspaceDb({ ...context, purpose: "precommit", evidence: result.evidence }).promise;
    const writable = openSqliteDb(path.join(fixture.target, ".codeflow", "workspace.db"), { fileMustExist: true });
    try { writable.prepare("UPDATE workspace_prefs SET context_window = 99").run(); }
    finally { writable.close(); }
    await worker.verifyWorkspaceDb({ ...context, purpose: "committed", evidence: result.evidence }).promise;
    await assert.rejects(worker.verifyWorkspaceDb({ ...context, purpose: "precommit", evidence: result.evidence }).promise);
    const target = openSqliteDb(path.join(fixture.target, ".codeflow", "workspace.db"), { readonly: true, fileMustExist: true });
    try { assert.equal((target.prepare("SELECT context_window FROM workspace_prefs").get() as { context_window: number }).context_window, 99); }
    finally { target.close(); }
    assert.ok(events.length > 0);
  } finally { await watcher.stop(); }
});

test("D18 snapshot 缺库只允许完整 absent，pending 未知副本禁止 cleanup", async t => {
  const fixture = createFixture(t); fs.mkdirSync(fixture.target); fs.mkdirSync(path.join(fixture.target, ".codeflow"));
  const worker = new WorkspaceMigrationFileWorkerClient();
  const context = { sourceRoot: fixture.source, targetRoot: fixture.target, operationId: "absent", workspaceId: "ws", requestId: "absent" };
  const result = await worker.snapshotWorkspaceDb(context).promise;
  assert.equal(result.evidence.state, "absent");
  await worker.verifyWorkspaceDb({ ...context, purpose: "precommit", evidence: result.evidence }).promise;
  fs.writeFileSync(path.join(fixture.target, ".codeflow", "workspace.db"), "unknown");
  await assert.rejects(worker.verifyWorkspaceDb({ ...context, purpose: "cleanup", evidence: { formatVersion: 1, state: "pending" } }).promise);
  assert.equal(fs.readFileSync(path.join(fixture.target, ".codeflow", "workspace.db"), "utf8"), "unknown");
});

test("D18 snapshot wx 竞态不得删除外来同名临时文件", async t => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.source, ".codeflow")); fs.mkdirSync(path.join(fixture.target, ".codeflow"), { recursive: true });
  const database = openSqliteDb(path.join(fixture.source, ".codeflow", "workspace.db"));
  try { migrateClientDb(database, { scope: "workspace" }); } finally { database.close(); }
  const temporary = path.join(fixture.target, ".codeflow", workspaceDbSnapshotTemporaryName("race"));
  const originalOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    if (String(args[0]) === temporary) fs.writeFileSync(temporary, "external-owner", "utf8");
    return await originalOpen(...args);
  });
  await assert.rejects(snapshotWorkspaceDatabase({ type: "workspace-db.snapshot", sourceRoot: fixture.source, targetRoot: fixture.target,
    operationId: "race", workspaceId: "ws", requestId: "race" }, { isCancelled: () => false }));
  assert.equal(fs.readFileSync(temporary, "utf8"), "external-owner");
});

test("D18 snapshot copy fsync 后 close 期间临时文件换代必须保留外来文件", async t => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.source, ".codeflow")); fs.mkdirSync(path.join(fixture.target, ".codeflow"), { recursive: true });
  const database = openSqliteDb(path.join(fixture.source, ".codeflow", "workspace.db"));
  try { migrateClientDb(database, { scope: "workspace" }); } finally { database.close(); }
  const temporary = path.join(fixture.target, ".codeflow", workspaceDbSnapshotTemporaryName("replace"));
  const originalOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === temporary) {
      const close = handle.close.bind(handle);
      handle.sync = async () => { throw fsError("EIO"); };
      handle.close = async () => { await close(); fs.renameSync(temporary, `${temporary}.owned`); fs.writeFileSync(temporary, "external-replacement"); };
    }
    return handle;
  });
  await assert.rejects(snapshotWorkspaceDatabase({ type: "workspace-db.snapshot", sourceRoot: fixture.source, targetRoot: fixture.target,
    operationId: "replace", workspaceId: "ws", requestId: "replace" }, { isCancelled: () => false }));
  assert.equal(fs.readFileSync(temporary, "utf8"), "external-replacement");
});

for (const secondary of ["close", "cleanup"] as const) {
  test(`D18 真实 Worker 保留 fsync 与 ${secondary} 安全双因且等待 exit`, async t => {
    const fixture = createFixture(t);
    fs.mkdirSync(path.join(fixture.source, ".codeflow")); fs.mkdirSync(path.join(fixture.target, ".codeflow"), { recursive: true });
    const database = openSqliteDb(path.join(fixture.source, ".codeflow", "workspace.db"));
    try { migrateClientDb(database, { scope: "workspace" }); } finally { database.close(); }
    const workerPath = path.join(fixture.root, "fault-worker.ts");
    fs.writeFileSync(path.join(fixture.root, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(workerPath, `import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(path.join(CLIENT_ROOT, "package.json"))});
const originalOpen = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).endsWith('.snapshot')) {
    handle.sync = async () => { throw Object.assign(new Error('private-path-secret'), { code: 'EIO' }); };
    if (${JSON.stringify(secondary)} === 'close') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw Object.assign(new Error('private-path-secret'), { code: 'EBUSY' }); };
    }
  }
  return handle;
};
if (${JSON.stringify(secondary)} === 'cleanup') fs.promises.unlink = async () => { throw Object.assign(new Error('private-path-secret'), { code: 'EACCES' }); };
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
await tsImport(${JSON.stringify(pathToFileURL(path.join(CLIENT_ROOT, "src/workspace-migration/workspaceMigrationFileWorker.ts")).href)}, import.meta.url);
`, "utf8");
    const task = new WorkspaceMigrationFileWorkerClient({ workerPath }).snapshotWorkspaceDb({ sourceRoot: fixture.source, targetRoot: fixture.target,
      operationId: secondary, workspaceId: "ws", requestId: `fault-${secondary}` });
    let closed = false; void task.closed!.then(() => { closed = true; });
    await assert.rejects(task.promise, (error: unknown) => {
      assert.ok(error instanceof WorkspaceMigrationFileClientError);
      const failures = error.details.failures as Array<Record<string, string>>;
      assert.ok(failures.some(failure => failure.stage === "copy.sync" && failure.osErrorCode === "EIO"));
      assert.ok(failures.some(failure => secondary === "close"
        ? failure.stage === "copy.target.close" && failure.osErrorCode === "EBUSY"
        : failure.stage === "snapshot.cleanup" && failure.osErrorCode === "EACCES"));
      assert.doesNotMatch(JSON.stringify(error.details), /private-path-secret/);
      assert.equal(error.details.requestId, `fault-${secondary}`);
      assert.equal(closed, true);
      return true;
    });
    const temporary = path.join(fixture.target, ".codeflow", workspaceDbSnapshotTemporaryName(secondary));
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.existsSync(path.join(fixture.target, ".codeflow", "workspace.db")), false);
    const source = openSqliteDb(path.join(fixture.source, ".codeflow", "workspace.db"), { fileMustExist: true });
    try { source.exec("BEGIN EXCLUSIVE"); source.exec("ROLLBACK"); } finally { source.close(); }
  });
}

for (const invalid of ["-wal", "-shm", "-journal", "bad-schema", "corrupt", "hardlink"] as const) {
  test(`D18 snapshot 拒绝源 ${invalid} 且保持源与目标事实`, async t => {
    const fixture = createFixture(t), sourceFile = path.join(fixture.source, ".codeflow", "workspace.db");
    fs.mkdirSync(path.dirname(sourceFile)); fs.mkdirSync(path.join(fixture.target, ".codeflow"), { recursive: true });
    const database = openSqliteDb(sourceFile);
    try { migrateClientDb(database, { scope: "workspace" }); if (invalid === "bad-schema") database.exec("DROP TABLE workspace_prefs"); }
    finally { database.close(); }
    if (invalid.startsWith("-")) fs.writeFileSync(`${sourceFile}${invalid}`, "sidecar");
    if (invalid === "corrupt") fs.writeFileSync(sourceFile, "invalid-sqlite");
    if (invalid === "hardlink") fs.linkSync(sourceFile, path.join(fixture.root, "linked.db"));
    const before = fs.readFileSync(sourceFile);
    const task = new WorkspaceMigrationFileWorkerClient().snapshotWorkspaceDb({ sourceRoot: fixture.source, targetRoot: fixture.target,
      operationId: invalid, workspaceId: "ws", requestId: `invalid-${invalid}` });
    await assert.rejects(task.promise); await task.closed;
    assert.deepEqual(fs.readFileSync(sourceFile), before);
    assert.deepEqual(fs.readdirSync(path.join(fixture.target, ".codeflow")), []);
  });
}

for (const invalid of ["missing", "replaced", "bad-schema", "corrupt", "hardlink"] as const) {
  test(`D18 committed 目标 ${invalid} 不能用源库或空库替代`, async t => {
    const fixture = createFixture(t), sourceFile = path.join(fixture.source, ".codeflow", "workspace.db"), targetFile = path.join(fixture.target, ".codeflow", "workspace.db");
    fs.mkdirSync(path.dirname(sourceFile)); fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    const database = openSqliteDb(sourceFile); try { migrateClientDb(database, { scope: "workspace" }); } finally { database.close(); }
    const worker = new WorkspaceMigrationFileWorkerClient();
    const context = { sourceRoot: fixture.source, targetRoot: fixture.target, operationId: invalid, workspaceId: "ws", requestId: `committed-${invalid}` };
    const result = await worker.snapshotWorkspaceDb(context).promise;
    const sourceBefore = fs.readFileSync(sourceFile);
    if (invalid === "missing") fs.unlinkSync(targetFile);
    if (invalid === "replaced") { fs.renameSync(targetFile, `${targetFile}.old`); fs.copyFileSync(sourceFile, targetFile); }
    if (invalid === "bad-schema") { const db = openSqliteDb(targetFile); try { db.exec("DROP TABLE workspace_prefs"); } finally { db.close(); } }
    if (invalid === "corrupt") fs.writeFileSync(targetFile, "invalid-sqlite");
    if (invalid === "hardlink") fs.linkSync(targetFile, path.join(fixture.root, "linked.db"));
    await assert.rejects(worker.verifyWorkspaceDb({ ...context, purpose: "committed", evidence: result.evidence }).promise);
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore);
    if (invalid === "missing") assert.equal(fs.existsSync(targetFile), false);
  });
}

test("D18 snapshot rename 失败只清本次副本并释放源库只读锁", async t => {
  const fixture = createFixture(t), sourceFile = path.join(fixture.source, ".codeflow", "workspace.db");
  fs.mkdirSync(path.dirname(sourceFile)); fs.mkdirSync(path.join(fixture.target, ".codeflow"), { recursive: true });
  const database = openSqliteDb(sourceFile); try { migrateClientDb(database, { scope: "workspace" }); } finally { database.close(); }
  t.mock.method(fs.promises, "rename", async () => { throw fsError("EACCES"); });
  await assert.rejects(snapshotWorkspaceDatabase({ type: "workspace-db.snapshot", sourceRoot: fixture.source, targetRoot: fixture.target,
    operationId: "rename", workspaceId: "ws", requestId: "rename" }, { isCancelled: () => false }), (error: unknown) => {
      assert.ok(error instanceof WorkspaceMigrationFileError);
      assert.ok((error.details.failures as Array<Record<string, string>>).some(failure => failure.stage === "snapshot.publish" && failure.osErrorCode === "EACCES"));
      return true;
    });
  assert.deepEqual(fs.readdirSync(path.join(fixture.target, ".codeflow")), []);
  const unlocked = openSqliteDb(sourceFile, { busyTimeoutMs: 0 }); try { unlocked.exec("BEGIN EXCLUSIVE; ROLLBACK"); } finally { unlocked.close(); }
});

test("文件 Worker 扫描隐藏内容、空目录并生成稳定清单", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const client = new WorkspaceMigrationFileWorkerClient();

  const first = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  const second = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  const lightweight = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: false,
    targetCaseSensitive: true,
  }).promise;

  assert.equal(first.summary.fileCount, 4);
  assert.equal(first.summary.directoryCount, 3);
  assert.equal(first.summary.linkCount, 0);
  assert.equal(first.summary.excludedDependencyDirectoryCount, 0);
  assert.deepEqual(first.summary.excludedDependencyDirectories, []);
  assert.match(first.summary.manifestHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(second.summary.manifestHash, first.summary.manifestHash);
  assert.equal(lightweight.summary.manifestHash, null);
  assert.equal(lightweight.summary.totalBytes, first.summary.totalBytes);
  assert.deepEqual(first.summary.metadataLimitations, [
    "acl",
    "extended_attributes",
    "alternate_data_streams",
    "hard_links",
    "sparse_layout",
  ]);
});

test("文件 Worker 在扫描复制和校验中统一排除工作区索引库文件", async (t) => {
  const fixture = createFixture(t);
  const codeflowaiDir = path.join(fixture.source, "codeflowai");
  fs.mkdirSync(codeflowaiDir);
  const runtimeDir = path.join(fixture.source, ".codeflow");
  fs.mkdirSync(runtimeDir);
  for (const name of [
    "file-index.db",
    "file-index.db-wal",
    "file-index.db-shm",
    "file-index.db-journal",
    "file-index.db.recovery-test",
    "file-index.db.recovery-test-wal",
  ]) {
    fs.writeFileSync(path.join(codeflowaiDir, name), name, "utf8");
    fs.writeFileSync(path.join(runtimeDir, name), name, "utf8");
  }
  for (const name of ["codeflowai.json", "file-index-ignore.txt", "file-index.db-notes"]) {
    fs.writeFileSync(path.join(codeflowaiDir, name), name, "utf8");
  }
  fs.writeFileSync(path.join(runtimeDir, "static-data.json"), "static", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "file-index.db-notes"), "business", "utf8");
  const client = new WorkspaceMigrationFileWorkerClient();
  const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: caseSensitive,
  }).promise;

  assert.equal(source.summary.fileCount, 5);
  const copied = await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: caseSensitive,
  }).promise;
  assert.equal(copied.sourceSummary.manifestHash, source.summary.manifestHash);
  assert.deepEqual(fs.readdirSync(path.join(fixture.staging, ".codeflow")).sort(), ["file-index.db-notes", "static-data.json"]);
  assert.equal(fs.readFileSync(path.join(fixture.staging, ".codeflow", "static-data.json"), "utf8"), "static");
  assert.equal(fs.existsSync(path.join(fixture.staging, "codeflowai", "file-index.db")), false);
  assert.equal(fs.existsSync(path.join(fixture.staging, "codeflowai", "file-index.db-wal")), false);
  assert.equal(fs.readFileSync(path.join(fixture.staging, "codeflowai", "codeflowai.json"), "utf8"), "codeflowai.json");
  assert.equal(fs.readFileSync(path.join(fixture.staging, "codeflowai", "file-index-ignore.txt"), "utf8"), "file-index-ignore.txt");
  assert.equal(fs.readFileSync(path.join(fixture.staging, "codeflowai", "file-index.db-notes"), "utf8"), "file-index.db-notes");

  const verified = await client.verify({
    sourceRoot: fixture.source,
    targetRoot: fixture.staging,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: caseSensitive,
  }).promise;
  assert.equal(verified.targetManifestHash, source.summary.manifestHash);
});

test("文件 Worker 按被遍历根而非目标 profile 判断索引库路径大小写", async (t) => {
  const fixture = createFixture(t);
  const differentlyCasedDir = path.join(fixture.source, "CodeFlowAI");
  fs.mkdirSync(differentlyCasedDir);
  fs.writeFileSync(path.join(differentlyCasedDir, "file-index.db"), "cache", "utf8");
  const sourceCaseSensitive = process.platform !== "win32" && process.platform !== "darwin";
  const client = new WorkspaceMigrationFileWorkerClient();
  const result = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: !sourceCaseSensitive,
  }).promise;

  assert.equal(result.summary.fileCount, sourceCaseSensitive ? 1 : 0);
  assert.equal(result.summary.directoryCount, sourceCaseSensitive ? 1 : 0);
});

test("文件 Worker 统一排除任意层级 node_modules，并保持复制与校验清单一致", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const dependencyRoot = path.join(fixture.source, "apps", "docs", "node_modules");
  fs.mkdirSync(path.join(dependencyRoot, "@multica"), { recursive: true });
  if (process.platform === "win32") {
    const packageTarget = path.join(fixture.root, "ui-package");
    fs.mkdirSync(packageTarget);
    fs.writeFileSync(path.join(packageTarget, "package.json"), "{}\n", "utf8");
    fs.symlinkSync(packageTarget, path.join(dependencyRoot, "@multica", "ui"), "junction");
  } else {
    fs.mkdirSync(path.join(dependencyRoot, "@multica", "ui"));
    fs.writeFileSync(path.join(dependencyRoot, "@multica", "ui", "package.json"), "{}\n", "utf8");
  }
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;

  assert.equal(source.summary.excludedDependencyDirectoryCount, 1);
  assert.deepEqual(source.summary.excludedDependencyDirectories, ["apps/docs/node_modules"]);
  const copied = await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  assert.equal(copied.sourceSummary.manifestHash, source.summary.manifestHash);
  assert.equal(copied.sourceSummary.excludedDependencyDirectoryCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.staging, "apps", "docs", "node_modules")), false);

  const verified = await client.verify({
    sourceRoot: fixture.source,
    targetRoot: fixture.staging,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  assert.equal(verified.targetManifestHash, source.summary.manifestHash);
  assert.equal(verified.sourceSummary.excludedDependencyDirectoryCount, 1);
  assert.equal(verified.targetSummary.excludedDependencyDirectoryCount, 0);
});

test("文件 Worker 按项目标识排除常见可重新生成目录并迁移无标识同名目录", async (t) => {
  const fixture = createFixture(t);
  const excludedFiles = [
    ["node", "node_modules", "package.json"],
    ["gradle", ".gradle", "cache.bin"],
    ["gradle", "build", "app.jar"],
    ["cmake", "build", "app.exe"],
    ["cmake", "cmake-build-debug", "app.pdb"],
    ["dotnet", "bin", "app.dll"],
    ["dotnet", "obj", "app.assets.json"],
    ["rust", "target", "app"],
    ["python", ".venv", "pyvenv.cfg"],
    ["python", "__pycache__", "main.pyc"],
    ["python", ".pytest_cache", "state"],
    ["python", ".mypy_cache", "state"],
    ["python", ".ruff_cache", "state"],
  ];
  fs.mkdirSync(path.join(fixture.source, "maven"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "maven", "pom.xml"), "<project />\n", "utf8");
  if (process.platform === "win32") {
    const mavenOutput = path.join(fixture.root, "maven-output");
    fs.mkdirSync(mavenOutput);
    fs.writeFileSync(path.join(mavenOutput, "app.jar"), "generated\n", "utf8");
    fs.symlinkSync(mavenOutput, path.join(fixture.source, "maven", "target"), "junction");
  } else {
    excludedFiles.push(["maven", "target", "app.jar"]);
  }
  fs.mkdirSync(path.join(fixture.source, "gradle"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "gradle", "build.gradle.kts"), "plugins {}\n", "utf8");
  fs.mkdirSync(path.join(fixture.source, "cmake"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "cmake", "CMakeLists.txt"), "project(test)\n", "utf8");
  fs.mkdirSync(path.join(fixture.source, "dotnet"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "dotnet", "App.csproj"), "<Project />\n", "utf8");
  fs.mkdirSync(path.join(fixture.source, "rust"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "rust", "Cargo.toml"), "[package]\nname='test'\n", "utf8");
  for (const parts of excludedFiles) {
    const filePath = path.join(fixture.source, ...parts);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "generated\n", "utf8");
  }
  for (const directoryName of ["build", "target", "bin", "obj", "cmake-build-debug"]) {
    const filePath = path.join(fixture.source, "plain", directoryName, "keep.txt");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${directoryName}\n`, "utf8");
  }
  fs.mkdirSync(path.join(fixture.source, "fake-maven", "pom.xml"), { recursive: true });
  fs.mkdirSync(path.join(fixture.source, "fake-maven", "target"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "fake-maven", "target", "keep.txt"), "keep\n", "utf8");
  fs.mkdirSync(path.join(fixture.source, "fake-dotnet", "App.csproj"), { recursive: true });
  fs.mkdirSync(path.join(fixture.source, "fake-dotnet", "bin"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "fake-dotnet", "bin", "keep.txt"), "keep\n", "utf8");
  fs.mkdirSync(path.join(fixture.source, "go", "bin"), { recursive: true });
  fs.mkdirSync(path.join(fixture.source, "go", "build"), { recursive: true });
  fs.writeFileSync(path.join(fixture.source, "go", "go.mod"), "module example.test/app\n", "utf8");
  fs.writeFileSync(path.join(fixture.source, "go", "bin", "tool.txt"), "keep\n", "utf8");
  fs.writeFileSync(path.join(fixture.source, "go", "build", "artifact.txt"), "keep\n", "utf8");

  const hooks = { isCancelled: () => false };
  const source = await scanWorkspaceMigrationTree({
    type: "scan",
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }, hooks);
  const excluded = new Set(source.summary.excludedDependencyDirectories);
  assert.equal(source.summary.excludedDependencyDirectoryCount, 14);
  for (const relativePath of [
    "node/node_modules",
    "maven/target",
    "gradle/.gradle",
    "gradle/build",
    "cmake/build",
    "cmake/cmake-build-debug",
    "dotnet/bin",
    "dotnet/obj",
    "rust/target",
    "python/.venv",
    "python/__pycache__",
    "python/.pytest_cache",
    "python/.mypy_cache",
    "python/.ruff_cache",
  ]) assert.equal(excluded.has(relativePath), true, relativePath);

  await copyWorkspaceMigrationTree({
    type: "copy",
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: process.platform !== "win32",
  }, hooks);
  for (const relativePath of excluded) assert.equal(fs.existsSync(path.join(fixture.staging, relativePath)), false, relativePath);
  for (const directoryName of ["build", "target", "bin", "obj", "cmake-build-debug"]) {
    assert.equal(fs.readFileSync(path.join(fixture.staging, "plain", directoryName, "keep.txt"), "utf8"), `${directoryName}\n`);
  }
  assert.equal(fs.readFileSync(path.join(fixture.staging, "go", "bin", "tool.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(fixture.staging, "go", "build", "artifact.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(fixture.staging, "fake-maven", "target", "keep.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(fixture.staging, "fake-dotnet", "bin", "keep.txt"), "utf8"), "keep\n");
  const verified = await verifyWorkspaceMigrationTrees({
    type: "verify",
    sourceRoot: fixture.source,
    targetRoot: fixture.staging,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: process.platform !== "win32",
  }, hooks);
  assert.equal(verified.targetManifestHash, source.summary.manifestHash);
});

test("Windows 正式扫描沿用预发现排除快照避免项目标识变化造成探针竞态", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows reparse point snapshot regression");
    return;
  }
  const fixture = createFixture(t);
  const projectRoot = path.join(fixture.source, "z-project");
  const generatedTarget = path.join(fixture.root, "generated-target");
  const markerPath = path.join(projectRoot, "pom.xml");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(generatedTarget);
  fs.writeFileSync(path.join(fixture.source, "a-trigger.txt"), "trigger\n", "utf8");
  fs.writeFileSync(markerPath, "<project />\n", "utf8");
  fs.writeFileSync(path.join(generatedTarget, "app.jar"), "generated\n", "utf8");
  fs.symlinkSync(generatedTarget, path.join(projectRoot, "target"), "junction");
  let markerRemoved = false;

  const result = await scanWorkspaceMigrationTree({
    type: "scan",
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: false,
  }, {
    isCancelled: () => false,
    onProgress: () => {
      if (markerRemoved) return;
      fs.rmSync(markerPath);
      markerRemoved = true;
    },
  });

  assert.equal(markerRemoved, true);
  assert.deepEqual(result.summary.excludedDependencyDirectories, ["z-project/target"]);
});

test("文件 Worker 迁移 node_modules 同名普通文件", async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.source, "node_modules"), "ordinary file\n", "utf8");
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;

  assert.equal(source.summary.fileCount, 1);
  assert.equal(source.summary.excludedDependencyDirectoryCount, 0);
  await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  assert.equal(fs.readFileSync(path.join(fixture.staging, "node_modules"), "utf8"), "ordinary file\n");
});

test("文件 Worker 安全清理扫描显式包含 node_modules", async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.source, "node_modules"));
  fs.writeFileSync(path.join(fixture.source, "node_modules", "external.txt"), "external\n", "utf8");
  const client = new WorkspaceMigrationFileWorkerClient();
  const normal = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  const cleanup = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    excludeDependencyDirectories: false,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;

  assert.equal(normal.summary.excludedDependencyDirectoryCount, 1);
  assert.equal(normal.summary.fileCount, 0);
  assert.equal(cleanup.summary.excludedDependencyDirectoryCount, 0);
  assert.equal(cleanup.summary.directoryCount, 1);
  assert.equal(cleanup.summary.fileCount, 1);
  assert.notEqual(cleanup.summary.manifestHash, normal.summary.manifestHash);
});

test("文件 Worker 流式复制、按平台保留链接文本并完成双端校验", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  if (process.platform !== "win32") fs.symlinkSync("index.ts", path.join(fixture.source, "src", "index-link.ts"));
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;

  const copy = await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: true,
  }).promise;
  assert.equal(copy.sourceSummary.manifestHash, source.summary.manifestHash);
  assert.equal(fs.readFileSync(path.join(fixture.staging, "src", "index.ts"), "utf8"), "export const value = 1;\n");
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(path.join(fixture.staging, "src", "index-link.ts")), "index.ts");
  }
  assert.equal(fs.statSync(path.join(fixture.staging, "empty")).isDirectory(), true);

  const verifyProgress: Array<{ processedFiles: number; processedDirectories: number; processedBytes: number }> = [];
  const verified = await client.verify({
    sourceRoot: fixture.source,
    targetRoot: fixture.staging,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: true,
  }, {
    onProgress: (progress) => verifyProgress.push(progress),
  }).promise;
  assert.equal(verified.targetManifestHash, source.summary.manifestHash);
  for (let index = 1; index < verifyProgress.length; index += 1) {
    assert.equal(verifyProgress[index]!.processedFiles >= verifyProgress[index - 1]!.processedFiles, true);
    assert.equal(verifyProgress[index]!.processedDirectories >= verifyProgress[index - 1]!.processedDirectories, true);
    assert.equal(verifyProgress[index]!.processedBytes >= verifyProgress[index - 1]!.processedBytes, true);
  }
});

test("文件 Worker 拒绝顶层 linked worktree，并在支持夹具的平台拒绝外部链接和大小写冲突", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  fs.writeFileSync(path.join(fixture.source, ".GIT"), "gitdir: ../external.git\n", "utf8");
  await expectWorkerError(
    client.scan({
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      includeContentHashes: false,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED",
    "top_level_git_file",
  );

  if (process.platform !== "win32") {
    fs.rmSync(path.join(fixture.source, ".GIT"));
    fs.symlinkSync("../../outside", path.join(fixture.source, "external-link"));
    await expectWorkerError(
      client.scan({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
        includeContentHashes: false,
        targetCaseSensitive: true,
      }).promise,
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "external_link",
    );

    fs.rmSync(path.join(fixture.source, "external-link"));
    fs.writeFileSync(path.join(fixture.source, "Readme"), "one", "utf8");
    fs.writeFileSync(path.join(fixture.source, "README"), "two", "utf8");
    await expectWorkerError(
      client.scan({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
        includeContentHashes: false,
        targetCaseSensitive: false,
      }).promise,
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "target_case_collision",
    );
  }
});

test("文件 Worker 拒绝无法真实解析的内部相对符号链接", async (t) => {
  if (process.platform === "win32") return;
  const fixture = createFixture(t);
  fs.symlinkSync("missing-target", path.join(fixture.source, "dangling-link"));
  const client = new WorkspaceMigrationFileWorkerClient();
  await expectWorkerError(
    client.scan({
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      includeContentHashes: false,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
    "dangling_link",
  );
});

test("Windows 文件 Worker 拒绝目录联接 reparse point", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  const inside = path.join(fixture.source, "inside");
  fs.mkdirSync(inside);
  fs.symlinkSync(inside, path.join(fixture.source, "junction"), "junction");
  const client = new WorkspaceMigrationFileWorkerClient();
  await assert.rejects(client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: false,
    targetCaseSensitive: false,
  }).promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.code, "WORKSPACE_MIGRATION_LINK_UNSUPPORTED");
    assert.equal(error.details.reason, "windows_reparse_unsupported");
    assert.equal(error.details.relativePath, "junction");
    assert.equal(String(error.details.reparseType).toLowerCase(), "junction");
    return true;
  });
});

test("Windows 文件 Worker 拒绝失效目录联接且不进入其目标", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  const junctionTarget = path.join(fixture.root, "removed-junction-target");
  const junctionPath = path.join(fixture.source, "dangling-junction");
  fs.mkdirSync(junctionTarget);
  fs.symlinkSync(junctionTarget, junctionPath, "junction");
  fs.rmSync(junctionTarget, { recursive: true });
  const client = new WorkspaceMigrationFileWorkerClient();
  await assert.rejects(client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: false,
    targetCaseSensitive: false,
  }).promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.code, "WORKSPACE_MIGRATION_LINK_UNSUPPORTED");
    assert.equal(error.details.reason, "windows_reparse_unsupported");
    assert.equal(error.details.relativePath, "dangling-junction");
    assert.equal(String(error.details.reparseType).toLowerCase(), "junction");
    return true;
  });
});

test("Windows reparse 探针启动失败保留首要错误原因", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  const previousSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(fixture.root, "missing-system-root");
  try {
    const client = new WorkspaceMigrationFileWorkerClient();
    await expectWorkerError(
      client.scan({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
        includeContentHashes: false,
        targetCaseSensitive: false,
      }).promise,
      "WORKSPACE_MIGRATION_LINK_UNSUPPORTED",
      "windows_reparse_probe_start_failed",
    );
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
  }
});

test("Windows reparse 探针非零退出保留限长 stderr 摘要", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  const previousSystemRoot = process.env.SystemRoot;
  const fakeSystemRoot = path.join(fixture.root, "fake-system-root");
  const fakePowerShell = path.join(fakeSystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  fs.mkdirSync(path.dirname(fakePowerShell), { recursive: true });
  fs.copyFileSync(process.execPath, fakePowerShell);
  process.env.SystemRoot = fakeSystemRoot;
  try {
    const client = new WorkspaceMigrationFileWorkerClient();
    await assert.rejects(client.scan({
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      includeContentHashes: false,
      targetCaseSensitive: false,
    }).promise, (error: unknown) => {
      assert.ok(error instanceof WorkspaceMigrationFileClientError);
      assert.equal(error.code, "WORKSPACE_MIGRATION_LINK_UNSUPPORTED");
      assert.equal(error.details.reason, "windows_reparse_probe_failed");
      assert.equal(typeof error.details.exitCode, "number");
      assert.equal(typeof error.details.stderrSummary, "string");
      assert.equal(String(error.details.stderrSummary).length > 0, true);
      assert.equal(String(error.details.stderrSummary).length <= 2_000, true);
      assert.equal(String(error.details.stderrSummary).includes(fixture.source), false);
      assert.doesNotMatch(String(error.details.stderrSummary), /(?:\\\\\?\\)?[a-z]:[\\/]/i);
      return true;
    });
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
  }
});

test("Windows reparse 探针失败摘要不泄露 PowerShell 截断后的源路径", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  let sourceRemoved = false;
  await assert.rejects(scanWorkspaceMigrationTree({
    type: "scan",
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: false,
    targetCaseSensitive: false,
  }, {
    isCancelled: () => false,
    onProgress: () => {
      if (sourceRemoved) return;
      sourceRemoved = true;
      fs.rmSync(fixture.source, { recursive: true, force: true });
    },
  }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileError);
    assert.equal(error.code, "WORKSPACE_MIGRATION_LINK_UNSUPPORTED");
    assert.equal(error.details.reason, "windows_reparse_probe_failed");
    const summary = String(error.details.stderrSummary ?? "");
    assert.match(summary, /probeErrorType=/);
    assert.doesNotMatch(summary, /(?:\\\\\?\\)?[a-z]:[\\/]/i);
    assert.equal(summary.includes(path.basename(fixture.root)), false);
    return true;
  });
});

test("Windows 文件 Worker 允许并复制内部文件和目录 SymbolicLink", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = createFixture(t);
  const inside = path.join(fixture.source, "inside");
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, "file.txt"), "content", "utf8");
  try {
    fs.symlinkSync("inside/file.txt", path.join(fixture.source, "file-link"), "file");
    fs.symlinkSync("inside", path.join(fixture.source, "directory-link"), "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前 Windows 未启用 SymbolicLink 创建权限");
      return;
    }
    throw error;
  }
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: false,
  }).promise;
  await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: false,
  }).promise;
  assert.equal(fs.readlinkSync(path.join(fixture.staging, "file-link")).replace(/\\/g, "/"), "inside/file.txt");
  assert.equal(fs.readlinkSync(path.join(fixture.staging, "directory-link")).replace(/\\/g, "/"), "inside");
});

test("文件 Worker 允许源和最终目标中都保持内部的嵌套 gitdir", async (t) => {
  const fixture = createFixture(t);
  const nested = path.join(fixture.source, "nested");
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(nested, "git-data"));
  fs.writeFileSync(path.join(nested, ".git"), "gitdir: git-data\n", "utf8");
  const client = new WorkspaceMigrationFileWorkerClient();

  const result = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  assert.equal(result.summary.fileCount, 1);
  assert.equal(result.summary.directoryCount, 2);
});

test("源清单在扫描后变化时复制显式失败，目标被修改后校验显式失败", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  fs.writeFileSync(path.join(fixture.source, "README.md"), "changed\n", "utf8");

  await expectWorkerError(
    client.copy({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      finalTargetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      expectedSourceManifestHash: source.summary.manifestHash!,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_SOURCE_CHANGED",
    "source_manifest_changed_during_copy",
  );

  fs.rmSync(fixture.staging, { recursive: true, force: true });
  const changedSource = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  await client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: changedSource.summary.manifestHash!,
    targetCaseSensitive: true,
  }).promise;
  fs.writeFileSync(path.join(fixture.staging, "README.md"), "target tampered\n", "utf8");
  await expectWorkerError(
    client.verify({
      sourceRoot: fixture.source,
      targetRoot: fixture.staging,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      expectedSourceManifestHash: changedSource.summary.manifestHash!,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_VERIFY_FAILED",
    "target_manifest_mismatch",
  );
});

test("复制拒绝已存在的 staging 和位于源工作区内的目标", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  fs.mkdirSync(fixture.staging);
  await expectWorkerError(
    client.copy({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      finalTargetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      expectedSourceManifestHash: source.summary.manifestHash!,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_COPY_FAILED",
    "staging_already_exists",
  );

  await expectWorkerError(
    client.copy({
      sourceRoot: fixture.source,
      stagingRoot: path.join(fixture.source, "staging"),
      finalTargetRoot: path.join(fixture.source, "target"),
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      expectedSourceManifestHash: source.summary.manifestHash!,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_TARGET_INVALID",
    "target_inside_source",
  );
});

test("POSIX 只读源目录仍可复制，目录 mode 在子项完成后尽力应用", async (t) => {
  if (process.platform === "win32") return;
  const fixture = createFixture(t);
  const readonlyDirectory = path.join(fixture.source, "readonly");
  fs.mkdirSync(readonlyDirectory);
  fs.writeFileSync(path.join(readonlyDirectory, "file.txt"), "content", "utf8");
  fs.chmodSync(readonlyDirectory, 0o555);
  const client = new WorkspaceMigrationFileWorkerClient();
  try {
    const source = await client.scan({
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      includeContentHashes: true,
      targetCaseSensitive: true,
    }).promise;
    await client.copy({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      finalTargetRoot: fixture.target,
      targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
      expectedSourceManifestHash: source.summary.manifestHash!,
      targetCaseSensitive: true,
    }).promise;
    assert.equal(fs.readFileSync(path.join(fixture.staging, "readonly", "file.txt"), "utf8"), "content");
    assert.equal(fs.statSync(path.join(fixture.staging, "readonly")).mode & 0o777, 0o555);
  } finally {
    fs.chmodSync(readonlyDirectory, 0o755);
    if (fs.existsSync(path.join(fixture.staging, "readonly"))) {
      fs.chmodSync(path.join(fixture.staging, "readonly"), 0o755);
    }
  }
});

test("目标文件系统 profile 在预检中拒绝不兼容文件名", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  fs.writeFileSync(path.join(fixture.source, "valid.txt"), "content", "utf8");
  await expectWorkerError(
    client.scan({
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      targetFileSystemType: "",
      includeContentHashes: false,
      targetCaseSensitive: true,
    }).promise,
    "WORKSPACE_MIGRATION_TARGET_INVALID",
    "target_filesystem_invalid",
  );
  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(fixture.source, "incompatible:name.txt"), "content", "utf8");
    await expectWorkerError(
      client.scan({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        targetFileSystemType: "exfat",
        includeContentHashes: false,
        targetCaseSensitive: false,
      }).promise,
      "WORKSPACE_MIGRATION_TARGET_INVALID",
      "target_name_invalid",
    );
  }
});

test("扫描报告硬链接和平台可识别的稀疏文件限制", async (t) => {
  const fixture = createFixture(t);
  const original = path.join(fixture.source, "original.bin");
  fs.writeFileSync(original, "linked-content", "utf8");
  fs.linkSync(original, path.join(fixture.source, "linked.bin"));
  const sparse = path.join(fixture.source, "sparse.bin");
  const handle = fs.openSync(sparse, "w");
  try {
    fs.writeSync(handle, Buffer.from([1]), 0, 1, 8 * 1024 * 1024);
  } finally {
    fs.closeSync(handle);
  }
  const sparseStat = fs.statSync(sparse);
  const sparseDetected = Number.isFinite(sparseStat.blocks) && sparseStat.blocks > 0 && sparseStat.blocks * 512 < sparseStat.size;
  const client = new WorkspaceMigrationFileWorkerClient();
  const result = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: false,
    targetCaseSensitive: true,
  }).promise;

  assert.equal(result.summary.hardLinkCount, 2);
  assert.equal(result.summary.sparseFileCount, sparseDetected ? 1 : 0);
  assert.equal(result.summary.metadataLimitations.includes("hard_links"), true);
  assert.equal(result.summary.metadataLimitations.includes("sparse_layout"), true);
});

test("共享内存取消标记可中止大文件复制", async (t) => {
  const fixture = createFixture(t);
  const largeFile = path.join(fixture.source, "large.bin");
  const handle = fs.openSync(largeFile, "w");
  try {
    fs.writeSync(handle, Buffer.alloc(1024 * 1024, 7), 0, 1024 * 1024, 63 * 1024 * 1024);
  } finally {
    fs.closeSync(handle);
  }
  const client = new WorkspaceMigrationFileWorkerClient();
  const source = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: true,
  }).promise;
  let task: ReturnType<WorkspaceMigrationFileWorkerClient["copy"]>;
  task = client.copy({
    sourceRoot: fixture.source,
    stagingRoot: fixture.staging,
    finalTargetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    expectedSourceManifestHash: source.summary.manifestHash!,
    targetCaseSensitive: true,
  }, {
    onProgress: (progress) => {
      if (progress.processedBytes > 0) task.cancel();
    },
  });
  await expectWorkerError(task.promise, "WORKSPACE_MIGRATION_FILE_CANCELLED", "operation_cancelled");
});

test("文件 Worker 在 Windows reparse 子进程启动后取消并等待 close", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const client = new WorkspaceMigrationFileWorkerClient();
  let task: ReturnType<WorkspaceMigrationFileWorkerClient["scan"]>;
  task = client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }, {
    onProgress: (progress) => {
      if (progress.processedFiles === 0 && progress.processedDirectories === 0 && progress.processedBytes === 0) {
        task.cancel();
      }
    },
  });
  if (process.platform !== "win32") task.cancel();
  await expectWorkerError(task.promise, "WORKSPACE_MIGRATION_FILE_CANCELLED", "operation_cancelled");
});

test("目标能力探测验证 rename、空间和清理，不遗留探测目录", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  const result = await client.probe({
    targetParent: fixture.targetParent,
    operationToken: "operation_test",
    requiresSymlink: process.platform !== "win32",
  }).promise;
  assert.equal(fs.statSync(result.realTargetParent).ino, fs.statSync(fixture.targetParent).ino);
  assert.equal(result.availableBytes > 0, true);
  assert.equal(typeof result.caseSensitive, "boolean");
  assert.equal(result.symlinkSupported, process.platform !== "win32");
  assert.deepEqual(fs.readdirSync(fixture.targetParent), []);
});

test("目标能力探测失败保留脱敏的底层错误码", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  await assert.rejects(client.probe({
    targetParent: path.join(fixture.root, "missing-parent"),
    operationToken: "operation_missing",
    requiresSymlink: false,
  }).promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.code, "WORKSPACE_MIGRATION_TARGET_INVALID");
    assert.equal(error.details.reason, "probe_parent_unavailable");
    assert.equal(error.details.osErrorCode, "ENOENT");
    assert.equal(Object.values(error.details).some((value) => String(value).includes(fixture.root)), false);
    return true;
  });
});

test("目标能力探测在文件 fsync 失败后清理探测项并显式失败", async (t) => {
  const fixture = createFixture(t);
  const originalOpen = fs.promises.open.bind(fs.promises);
  const mocked = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (path.basename(String(args[0])) !== "case-probe") return handle;
    return {
      writeFile: handle.writeFile.bind(handle),
      sync: async () => { throw fsError("EIO"); },
      close: handle.close.bind(handle),
    } as unknown as fs.promises.FileHandle;
  });
  await expectFileOperationError(probeWorkspaceMigrationTarget({
    type: "probe",
    targetParent: fixture.targetParent,
    operationToken: "operation_fsync",
    requiresSymlink: false,
  }, { isCancelled: () => false }), "probe_failed");
  mocked.mock.restore();
  assert.deepEqual(fs.readdirSync(fixture.targetParent), []);
});

test("目标能力探测在 rename 失败后清理 staging 并显式失败", async (t) => {
  const fixture = createFixture(t);
  const mocked = t.mock.method(fs.promises, "rename", async () => { throw fsError("EIO"); });
  await expectFileOperationError(probeWorkspaceMigrationTarget({
    type: "probe",
    targetParent: fixture.targetParent,
    operationToken: "operation_rename",
    requiresSymlink: false,
  }, { isCancelled: () => false }), "probe_failed");
  mocked.mock.restore();
  assert.deepEqual(fs.readdirSync(fixture.targetParent), []);
});

test("目标能力探测清理失败时不伪造成功", async (t) => {
  const fixture = createFixture(t);
  const mocked = t.mock.method(fs.promises, "rm", async () => { throw fsError("EACCES"); });
  await expectFileOperationError(probeWorkspaceMigrationTarget({
    type: "probe",
    targetParent: fixture.targetParent,
    operationToken: "operation_cleanup",
    requiresSymlink: false,
  }, { isCancelled: () => false }), "probe_cleanup_failed");
  mocked.mock.restore();
  assert.equal(fs.readdirSync(fixture.targetParent).length, 1);
});

test("文件监听在 ready 后上报变更并可显式停止", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  let resolveChanged!: (value: string | null) => void;
  const changed = new Promise<string | null>((resolve) => { resolveChanged = resolve; });
  const errors: WorkspaceMigrationFileClientError[] = [];
  const watcher = client.watch({
    watchRoot: fixture.source,
    recursive: true,
    caseSensitive: true,
  }, {
    onChanged: (event) => resolveChanged(event.relativePath),
    onError: (error) => errors.push(error),
  });
  await watcher.ready;
  fs.writeFileSync(path.join(fixture.source, "changed.txt"), "changed", "utf8");
  const relativePath = await Promise.race([
    changed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("watch change timed out")), 5_000)),
  ]);
  assert.equal(relativePath, "changed.txt");
  await watcher.stop();
  await watcher.closed;
  assert.deepEqual(errors, []);
});

test("文件监听转发 change 事件供内容清单复核", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  const events: Array<string | null> = [];
  const errors: WorkspaceMigrationFileClientError[] = [];
  let resolveEvent!: () => void;
  const eventObserved = new Promise<void>((resolve) => { resolveEvent = resolve; });
  fs.writeFileSync(path.join(fixture.source, "README.md"), "workspace\n", "utf8");
  const watcher = client.watch({
    watchRoot: fixture.source,
    recursive: true,
    caseSensitive: true,
  }, {
    onChanged: (event) => {
      events.push(event.relativePath);
      if (event.relativePath === "README.md") resolveEvent();
    },
    onError: (error) => errors.push(error),
  });
  await watcher.ready;
  fs.writeFileSync(path.join(fixture.source, "README.md"), "workspace changed\n", "utf8");
  await Promise.race([
    eventObserved,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("watch change timed out")), 5_000)),
  ]);
  await watcher.stop();
  assert.deepEqual(errors, []);
});

test("文件监听启动失败只上报一次错误并正常收敛 closed", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  const errors: WorkspaceMigrationFileClientError[] = [];
  const watcher = client.watch({
    watchRoot: path.join(fixture.root, "missing"),
    recursive: true,
    caseSensitive: true,
  }, {
    onChanged: () => assert.fail("启动失败的 watcher 不应上报变更"),
    onError: (error) => errors.push(error),
  });

  await expectWorkerError(watcher.ready, "WORKSPACE_MIGRATION_VERIFY_FAILED", "watch_start_failed");
  await watcher.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.details.reason, "watch_start_failed");
  await assert.rejects(watcher.stop(), (error: unknown) => error === errors[0]);

  const invalidFilterErrors: WorkspaceMigrationFileClientError[] = [];
  const invalidFilterWatcher = client.watch({
    watchRoot: fixture.source,
    recursive: true,
    caseSensitive: true,
    filterRelativePath: "/outside",
  }, {
    onChanged: () => assert.fail("过滤路径非法的 watcher 不应上报变更"),
    onError: (error) => invalidFilterErrors.push(error),
  });
  await expectWorkerError(invalidFilterWatcher.ready, "WORKSPACE_MIGRATION_VERIFY_FAILED", "watch_start_failed");
  await invalidFilterWatcher.closed;
  assert.equal(invalidFilterErrors.length, 1);
});

test("文件监听 Worker 异常退出只形成一个失败终态", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  const errors: WorkspaceMigrationFileClientError[] = [];
  const watcher = client.watch({
    watchRoot: fixture.source,
    recursive: true,
    caseSensitive: true,
  }, {
    onChanged: () => undefined,
    onError: (error) => errors.push(error),
  });
  await watcher.ready;
  await watcher.terminate();
  await watcher.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.details.reason, "worker_runtime_failed");
  await assert.rejects(watcher.stop(), (error: unknown) => error === errors[0]);
});

test("文件监听停止超时会终止 Worker 并只形成一个失败终态", async (t) => {
  const fixture = createFixture(t);
  const workerPath = path.join(fixture.root, "unresponsive-watch-worker.cjs");
  fs.writeFileSync(workerPath, [
    'const { parentPort, workerData } = require("node:worker_threads");',
    'parentPort.postMessage({ type: "watch.ready", taskId: workerData.taskId });',
    'parentPort.on("message", () => undefined);',
  ].join("\n"), "utf8");
  const client = new WorkspaceMigrationFileWorkerClient({ workerPath, watchStopTimeoutMs: 50 });
  const errors: WorkspaceMigrationFileClientError[] = [];
  const watcher = client.watch({
    watchRoot: fixture.source,
    recursive: true,
    caseSensitive: true,
  }, {
    onChanged: () => undefined,
    onError: (error) => errors.push(error),
  });
  await watcher.ready;
  await assert.rejects(watcher.stop(), (error: unknown) => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.details.reason, "watch_stop_timeout");
    assert.equal(error.details.timeoutMs, 50);
    return true;
  });
  await watcher.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.details.reason, "watch_stop_timeout");
});

test("目标父目录监听只转发未来目标名相关事件", async (t) => {
  const fixture = createFixture(t);
  const client = new WorkspaceMigrationFileWorkerClient();
  const events: Array<string | null> = [];
  const watcher = client.watch({
    watchRoot: fixture.targetParent,
    recursive: false,
    caseSensitive: true,
    filterRelativePath: "future-target",
  }, {
    onChanged: (event) => events.push(event.relativePath),
    onError: (error) => { throw error; },
  });
  await watcher.ready;
  fs.writeFileSync(path.join(fixture.targetParent, "unrelated.txt"), "ignore", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.mkdirSync(path.join(fixture.targetParent, "future-target"));
  const deadline = Date.now() + 5_000;
  while (!events.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  await watcher.stop();
  assert.deepEqual(events, ["future-target"]);
});

test("构建后的 CJS Worker 可执行真实扫描", async (t) => {
  const fixture = createFixture(t);
  seedWorkspace(fixture);
  const workerPath = path.join(fixture.root, "workspaceMigrationFileWorker.cjs");
  await build({
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node22"],
    minify: true,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    charset: "utf8",
    tsconfig: path.join(CLIENT_ROOT, "tsconfig.json"),
    mainFields: ["module", "main"],
    conditions: ["node", "import", "default"],
    logLevel: "silent",
    entryPoints: [path.join(CLIENT_ROOT, "src/workspace-migration/workspaceMigrationFileWorker.ts")],
    outfile: workerPath,
  });
  const client = new WorkspaceMigrationFileWorkerClient({ workerPath });
  const result = await client.scan({
    sourceRoot: fixture.source,
    targetRoot: fixture.target,
    targetFileSystemType: TEST_TARGET_FILE_SYSTEM_TYPE,
    includeContentHashes: true,
    targetCaseSensitive: process.platform !== "win32",
  }).promise;
  assert.equal(result.summary.fileCount, 4);
  assert.match(result.summary.manifestHash ?? "", /^[a-f0-9]{64}$/);
});
