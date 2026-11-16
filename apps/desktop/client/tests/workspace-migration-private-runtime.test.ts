import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { WorkspacePrefsRepo } from "../src/db/repos/workspacePrefsRepo.js";
import { handleWorkspacePrefsGet } from "../src/app/handlers/workspacePrefsHandlers.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";

import {
  WorkspaceMigrationFileClientError,
  WorkspaceMigrationFileWorkerClient,
} from "../src/workspace-migration/workspaceMigrationFileWorkerClient.ts";

const TARGET_PROFILE = {
  targetFileSystemType: process.platform === "win32" ? "ntfs" : process.platform === "darwin" ? "apfs" : "ext4",
  targetCaseSensitive: process.platform !== "win32" && process.platform !== "darwin",
};

type Fixture = {
  sourceRoot: string;
  targetRoot: string;
  stagingRoot: string;
  files: Map<string, Buffer>;
  client: WorkspaceMigrationFileWorkerClient;
};

/** 创建已关闭的静态字节夹具，不代表在线 SQLite 或最终存储布局。 */
function createFixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-migration-private-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const targetParent = path.join(root, "destination");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetParent);
  const files = new Map([
    ["README.md", Buffer.from("project\n")],
    [".codeflow/workspace.sqlite", Buffer.from([0, 255, 1, 128, 2, 0])],
    [".codeflow/workspace.sqlite-wal", Buffer.from([255, 0, 3, 129])],
    [".codeflow/workspace.sqlite-shm", Buffer.from([4, 0, 254, 130])],
    [".codeflow/workspace.sqlite-journal", Buffer.from([5, 253, 0, 131])],
    [".codeflow/events/raw.jsonl", Buffer.from('{"seq":1}\n')],
    [".codeflow/cache/search.sqlite", Buffer.from([252, 6, 0, 132])],
    [".codeflow/state.json", Buffer.alloc(0)],
  ]);
  for (const [relativePath, bytes] of files) {
    const filePath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  }
  return {
    sourceRoot,
    targetRoot: path.join(targetParent, "final"),
    stagingRoot: path.join(targetParent, "staging"),
    files,
    client: new WorkspaceMigrationFileWorkerClient(),
  };
}

/** 通过真实 Worker 取得含内容摘要的源清单。 */
async function scanSource(fixture: Fixture) {
  const { summary } = await fixture.client.scan({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.targetRoot,
    ...TARGET_PROFILE,
    includeContentHashes: true,
  }).promise;
  assert.ok(summary.manifestHash);
  return { ...summary, manifestHash: summary.manifestHash };
}

/** 使用预检摘要复制到本夹具独占的 staging，不发布最终目录。 */
async function copySource(fixture: Fixture, expectedSourceManifestHash: string) {
  return fixture.client.copy({
    sourceRoot: fixture.sourceRoot,
    stagingRoot: fixture.stagingRoot,
    finalTargetRoot: fixture.targetRoot,
    ...TARGET_PROFILE,
    expectedSourceManifestHash,
  }).promise;
}

/** 保持长度不变地改动一个字节，避免仅靠文件大小发现变化。 */
function changeByte(filePath: string): Buffer {
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length > 0);
  bytes[0] = bytes[0]! ^ 0xff;
  fs.writeFileSync(filePath, bytes);
  return bytes;
}

/** 核对跨 Worker 的稳定错误及相对路径诊断。 */
function expectMigrationError(code: WorkspaceMigrationFileClientError["code"], reason: string, changedPath?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WorkspaceMigrationFileClientError);
    assert.equal(error.code, code);
    assert.equal(error.details.reason, reason);
    if (changedPath) {
      const paths = code === "WORKSPACE_MIGRATION_SOURCE_CHANGED"
        ? error.details.sourceChangedPaths
        : error.details.targetChangedPaths;
      assert.deepEqual(paths, [changedPath]);
    }
    return true;
  };
}

test("D18 新模式仅排除固定 workspace.db 工件，旧模式完整 hash 保持", async t => {
  const fixture = createFixture(t);
  const db = path.join(fixture.sourceRoot, ".codeflowai", "workspace.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, "managed-one");
  const scan = (manifestMode: { operationId: string } | null) => fixture.client.scan({ sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.targetRoot, ...TARGET_PROFILE, includeContentHashes: true, manifestMode }).promise;
  const oldBefore = await scan(null), managedBefore = await scan({ operationId: "managed-fixture" });
  fs.writeFileSync(db, "managed-two");
  assert.notEqual((await scan(null)).summary.manifestHash, oldBefore.summary.manifestHash);
  assert.equal((await scan({ operationId: "managed-fixture" })).summary.manifestHash, managedBefore.summary.manifestHash);
  changeByte(path.join(fixture.sourceRoot, ".codeflow", "workspace.sqlite"));
  assert.notEqual((await scan({ operationId: "managed-fixture" })).summary.manifestHash, managedBefore.summary.manifestHash);
});

for (const container of [".CODEFLOWAI", ".CoDeFlOwAi", ".codeflowai"]) {
  test(`D18 F1 ${container} 静态容器保持拼写并完成真实 copy 与 verify`, async t => {
    const fixture = createFixture(t);
    fs.renameSync(path.join(fixture.sourceRoot, ".codeflow"), path.join(fixture.sourceRoot, "rename-container"));
    fs.renameSync(path.join(fixture.sourceRoot, "rename-container"), path.join(fixture.sourceRoot, container));
    fs.writeFileSync(path.join(fixture.sourceRoot, container, "other.txt"), "static-content\n");
    fs.writeFileSync(path.join(fixture.sourceRoot, container, "workspace.db"), "managed-main");
    fs.writeFileSync(path.join(fixture.sourceRoot, container, "workspace.db-wal"), "managed-sidecar");
    const manifestMode = { operationId: "case-container" };
    const input = { sourceRoot: fixture.sourceRoot, targetRoot: fixture.targetRoot, manifestMode, ...TARGET_PROFILE };
    const sourceTask = fixture.client.scan({ ...input, includeContentHashes: true });
    const source = await sourceTask.promise; await sourceTask.closed;
    assert.ok(source.summary.manifestHash);
    const managedContainer = container === ".codeflowai" || !TARGET_PROFILE.targetCaseSensitive;
    assert.equal(source.summary.fileCount, fixture.files.size + (managedContainer ? 1 : 3));
    const copyTask = fixture.client.copy({ ...input, stagingRoot: fixture.stagingRoot, finalTargetRoot: fixture.targetRoot,
      expectedSourceManifestHash: source.summary.manifestHash });
    const copied = await copyTask.promise; await copyTask.closed;
    assert.equal(copied.sourceSummary.manifestHash, source.summary.manifestHash);
    assert.ok(fs.readdirSync(fixture.stagingRoot).includes(container));
    assert.equal(fs.readFileSync(path.join(fixture.stagingRoot, container, "other.txt"), "utf8"), "static-content\n");
    assert.equal(fs.existsSync(path.join(fixture.stagingRoot, container, "workspace.db")), !managedContainer);
    assert.equal(fs.existsSync(path.join(fixture.stagingRoot, container, "workspace.db-wal")), !managedContainer);
    const verifyTask = fixture.client.verify({ ...input, targetRoot: fixture.stagingRoot,
      expectedSourceManifestHash: source.summary.manifestHash, expectedTargetManifestHash: source.summary.manifestHash });
    const verified = await verifyTask.promise; await verifyTask.closed;
    assert.equal(verified.targetManifestHash, source.summary.manifestHash);
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, container, "other.txt"), "utf8"), "static-content\n");
  });
}

for (const sourceContainer of ["absent", "managed-only"] as const) {
  test(`D18 F1 ${sourceContainer} 仍准备快照容器且不复制受管工件`, async t => {
    const fixture = createFixture(t);
    fs.rmSync(path.join(fixture.sourceRoot, ".codeflow"), { recursive: true, force: false });
    fs.rmSync(path.join(fixture.sourceRoot, ".codeflowai"), { recursive: true, force: true });
    if (sourceContainer === "managed-only") {
      fs.mkdirSync(path.join(fixture.sourceRoot, ".codeflowai"));
      fs.writeFileSync(path.join(fixture.sourceRoot, ".codeflowai", "workspace.db"), "managed-main");
    }
    const input = { sourceRoot: fixture.sourceRoot, targetRoot: fixture.targetRoot, manifestMode: { operationId: "container-preparation" }, ...TARGET_PROFILE };
    const scanTask = fixture.client.scan({ ...input, includeContentHashes: true });
    const scanned = await scanTask.promise; await scanTask.closed;
    assert.ok(scanned.summary.manifestHash);
    assert.equal(scanned.summary.fileCount, 1); assert.equal(scanned.summary.directoryCount, 0);
    const copyTask = fixture.client.copy({ ...input, stagingRoot: fixture.stagingRoot, finalTargetRoot: fixture.targetRoot,
      expectedSourceManifestHash: scanned.summary.manifestHash });
    await copyTask.promise; await copyTask.closed;
    assert.deepEqual(fs.readdirSync(path.join(fixture.stagingRoot, ".codeflowai")), []);
    const verifyTask = fixture.client.verify({ ...input, targetRoot: fixture.stagingRoot, expectedSourceManifestHash: scanned.summary.manifestHash });
    const verified = await verifyTask.promise; await verifyTask.closed;
    assert.equal(verified.targetManifestHash, scanned.summary.manifestHash);
  });
}

test("工作区迁移将 .codeflow 静态运行文件计入清单并逐字节复制校验", async t => {
  const fixture = createFixture(t);
  const source = await scanSource(fixture);
  const repeated = await scanSource(fixture);
  const lightweight = await fixture.client.scan({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.targetRoot,
    ...TARGET_PROFILE,
    includeContentHashes: false,
  }).promise;
  const totalBytes = [...fixture.files.values()].reduce((total, bytes) => total + bytes.length, 0);

  assert.equal(source.fileCount, fixture.files.size);
  assert.equal(source.directoryCount, 3);
  assert.equal(source.totalBytes, totalBytes);
  assert.equal(source.excludedDependencyDirectoryCount, 0);
  assert.deepEqual(source.excludedDependencyDirectories, []);
  assert.match(source.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(repeated.manifestHash, source.manifestHash);
  assert.equal(lightweight.summary.manifestHash, null);
  assert.equal(lightweight.summary.fileCount, source.fileCount);
  assert.equal(lightweight.summary.totalBytes, totalBytes);

  const copied = await copySource(fixture, source.manifestHash);
  assert.equal(copied.sourceSummary.manifestHash, source.manifestHash);
  for (const [relativePath, bytes] of fixture.files) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.sourceRoot, relativePath)), bytes, relativePath);
    assert.deepEqual(fs.readFileSync(path.join(fixture.stagingRoot, relativePath)), bytes, relativePath);
  }
  const verified = await fixture.client.verify({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.stagingRoot,
    ...TARGET_PROFILE,
    expectedSourceManifestHash: source.manifestHash,
  }).promise;
  assert.equal(verified.sourceSummary.manifestHash, source.manifestHash);
  assert.equal(verified.targetManifestHash, source.manifestHash);
  assert.equal(verified.targetSummary.fileCount, fixture.files.size);
  assert.equal(verified.targetSummary.totalBytes, totalBytes);
  assert.equal(fs.existsSync(fixture.targetRoot), false);
});

test("扫描后 .codeflow 静态文件等长变化时复制显式失败", async t => {
  const fixture = createFixture(t);
  const source = await scanSource(fixture);
  const filePath = path.join(fixture.sourceRoot, ".codeflow/workspace.sqlite");
  const changed = changeByte(filePath);

  await assert.rejects(
    copySource(fixture, source.manifestHash),
    expectMigrationError("WORKSPACE_MIGRATION_SOURCE_CHANGED", "source_manifest_changed_during_copy"),
  );
  assert.deepEqual(fs.readFileSync(filePath), changed);
  assert.equal(fs.existsSync(fixture.targetRoot), false);
});

test("复制后仅源 .codeflow 静态 WAL 字节变化时校验显式失败", async t => {
  const fixture = createFixture(t);
  const source = await scanSource(fixture);
  await copySource(fixture, source.manifestHash);
  const relativePath = ".codeflow/workspace.sqlite-wal";
  const sourceFile = path.join(fixture.sourceRoot, relativePath);
  const changed = changeByte(sourceFile);

  await assert.rejects(fixture.client.verify({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.stagingRoot,
    ...TARGET_PROFILE,
    expectedSourceManifestHash: source.manifestHash,
  }).promise, expectMigrationError("WORKSPACE_MIGRATION_SOURCE_CHANGED", "source_manifest_changed", relativePath));
  assert.deepEqual(fs.readFileSync(sourceFile), changed);
  assert.deepEqual(fs.readFileSync(path.join(fixture.stagingRoot, relativePath)), fixture.files.get(relativePath));
  assert.equal(fs.existsSync(fixture.targetRoot), false);
});

test("仅目标 .codeflow 静态缓存字节被篡改时校验显式失败", async t => {
  const fixture = createFixture(t);
  const source = await scanSource(fixture);
  await copySource(fixture, source.manifestHash);
  const relativePath = ".codeflow/cache/search.sqlite";
  const targetFile = path.join(fixture.stagingRoot, relativePath);
  const changed = changeByte(targetFile);

  await assert.rejects(fixture.client.verify({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.stagingRoot,
    ...TARGET_PROFILE,
    expectedSourceManifestHash: source.manifestHash,
  }).promise, expectMigrationError("WORKSPACE_MIGRATION_VERIFY_FAILED", "target_manifest_mismatch", relativePath));
  assert.deepEqual(fs.readFileSync(targetFile), changed);
  assert.deepEqual(fs.readFileSync(path.join(fixture.sourceRoot, relativePath)), fixture.files.get(relativePath));
  assert.equal(fs.existsSync(fixture.targetRoot), false);
});

test("原 prefs 失败日志沿静态清单逐字节迁移、校验并在目标续写", async t => {
  const fixture = createFixture(t), db = openClientDb({ dbPath: path.join(path.dirname(fixture.sourceRoot), "application.db") });
  const workspaceId = "client:log-migration" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "log", path: fixture.sourceRoot });
  try {
    t.mock.method(WorkspacePrefsRepo.prototype, "listByWorkspace", () => { throw new Error("private-prefs-cause"); });
    const responses: any[] = [];
    const ctx = { db, workspaces: new Map([[workspaceId, "untrusted"]]), send: (response: unknown) => { responses.push(response); } } as unknown as ApiHandlerContext;
    const request = { t: "api.req", id: "before-migration", method: "workspacePrefs.get", body: { workspaceId } } as ApiRequestMessage;
    handleWorkspacePrefsGet(ctx, request); assert.equal(responses[0].status, 500);
    const logName = fs.readdirSync(path.join(fixture.sourceRoot, ".codeflowai")).find(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name));
    assert.ok(logName);
    const before = fs.readFileSync(path.join(fixture.sourceRoot, ".codeflowai", logName));
    const input = { sourceRoot: fixture.sourceRoot, targetRoot: fixture.targetRoot, ...TARGET_PROFILE, manifestMode: { operationId: "log-consumer" } };
    const scan = fixture.client.scan({ ...input, includeContentHashes: true }); const source = await scan.promise; await scan.closed;
    assert.ok(source.summary.manifestHash);
    const copy = fixture.client.copy({ ...input, stagingRoot: fixture.stagingRoot, finalTargetRoot: fixture.targetRoot, expectedSourceManifestHash: source.summary.manifestHash });
    await copy.promise; await copy.closed;
    assert.deepEqual(fs.readFileSync(path.join(fixture.stagingRoot, ".codeflowai", logName)), before);
    const verify = fixture.client.verify({ ...input, targetRoot: fixture.stagingRoot, expectedSourceManifestHash: source.summary.manifestHash });
    const checked = await verify.promise; await verify.closed; assert.equal(checked.targetManifestHash, source.summary.manifestHash);
    db.workspaces.upsert({ id: workspaceId, title: "log", path: fixture.stagingRoot });
    handleWorkspacePrefsGet(ctx, { ...request, id: "after-migration" }); assert.equal(responses[1].status, 500);
    const targetLogs = fs.readdirSync(path.join(fixture.stagingRoot, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name));
    const rows = targetLogs.flatMap(name => fs.readFileSync(path.join(fixture.stagingRoot, ".codeflowai", name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    assert.deepEqual(rows.map(row => row.requestId), ["before-migration", "after-migration"]);
    assert.deepEqual(fs.readFileSync(path.join(fixture.sourceRoot, ".codeflowai", logName)), before);
  } finally { db.close(); }
});
