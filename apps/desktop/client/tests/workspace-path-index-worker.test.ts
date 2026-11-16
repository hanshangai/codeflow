import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { openWorkspacePathIndexDb } from "../src/fs/workspacePathIndexDb.ts";
import { isWorkspacePathIndexStorageRelPath } from "../src/fs/workspacePathIndexConfig.ts";

const settings = {
  configStamp: "worker-config-v1",
  excludeRulesStamp: "worker-ignore-v1",
  maxEntries: 1_000,
};

type WorkerResult = {
  messages: Array<Record<string, unknown>>;
  exitCode: number;
};

async function runIndexWorker(workerData: Record<string, unknown>): Promise<WorkerResult> {
  const require = createRequire(import.meta.url);
  const tsxApiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const workerUrl = pathToFileURL(path.resolve("src/fs/workspacePathIndexWorker.ts")).href;
  const bootstrapSource = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(workerUrl)}, import.meta.url);`,
  ].join("\n");
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrapSource)}`), {
    execArgv: ["--conditions", "development"],
    workerData,
  });
  const messages: Array<Record<string, unknown>> = [];
  worker.on("message", (message) => messages.push(message as Record<string, unknown>));
  const exitCode = await new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  return { messages, exitCode };
}

function createDirectoryLink(targetPath: string, linkPath: string): void {
  fs.symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

test("workspace path index worker writes batches directly to the reserved database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-"));
  const workspaceId = "local:worker:direct";
  let db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
  const generation = db.reserveBuild(settings, "worker");
  db.close();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "alpha.ts"), "alpha", "utf8");
    fs.writeFileSync(path.join(root, "src", "zeta.ts"), "zeta", "utf8");
    fs.writeFileSync(path.join(root, "src", "beta.ts"), "beta", "utf8");
    const expectedDirectoryOrder = fs.readdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "codeflowai"), { recursive: true });
    fs.writeFileSync(path.join(root, "codeflowai", "file-index.db-notes"), "business", "utf8");
    const result = await runIndexWorker({
      workspaceId,
      workspacePath: root,
      generation,
      includeHidden: true,
      maxEntries: settings.maxEntries,
      configStamp: settings.configStamp,
      excludeRulesStamp: settings.excludeRulesStamp,
      excludeDirNames: [],
      excludePathPrefixes: [],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.some((message) => message.type === "entries"), false);
    const done = result.messages.find((message) => message.type === "done");
    assert.ok(done);
    assert.equal(done?.partial, false);

    db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
    const published = db.publishBuild(generation, false);
    assert.equal(published.activeIndexedCount, Number(done?.indexedCount));
    assert.deepEqual(
      db.search("alpha", { limit: 10, offset: 0, includeHidden: true, kind: "all" }).entries.map((entry) => entry.path),
      ["src/alpha.ts"],
    );
    assert.deepEqual(
      db.searchDirectory("src", "", { limit: 10, offset: 0, includeHidden: true, kind: "all" }).entries.map((entry) => entry.name),
      expectedDirectoryOrder,
    );
    assert.deepEqual(
      db.search("file-index", { limit: 20, offset: 0, includeHidden: true, kind: "all" }).entries.map((entry) => entry.path),
      ["codeflowai/file-index-ignore.txt", "codeflowai/file-index.db-notes"].filter((relPath) => fs.existsSync(path.join(root, ...relPath.split("/")))),
    );
    assert.deepEqual(db.search("file-index.db-wal", { limit: 10, offset: 0, includeHidden: true, kind: "all" }).entries, []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index worker reports a stable storage code for an unsafe runtime directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-linked-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-external-"));
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

    const result = await runIndexWorker({
      workspaceId: "local:worker:linked-container",
      workspacePath: root,
      generation: 1,
      includeHidden: true,
      maxEntries: settings.maxEntries,
      configStamp: settings.configStamp,
      excludeRulesStamp: settings.excludeRulesStamp,
      excludeDirNames: [],
      excludePathPrefixes: [],
    });
    assert.equal(result.exitCode, 0);
    const failed = result.messages.find((message) => message.type === "failed");
    assert.ok(failed);
    assert.equal(failed?.storageCode, "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
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

test("workspace path index worker preserves Git storage rejection codes across the thread boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-git-"));
  const runGit = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit("init");
  const workspaceId = "local:worker:git-rejected";
  const db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
  const generation = db.reserveBuild(settings, "worker");
  db.close();
  try {
    runGit("add", "-f", "--", ".codeflowai/file-index.db");
    const result = await runIndexWorker({ workspaceId, workspacePath: root, generation, includeHidden: true, ...settings, excludeDirNames: [], excludePathPrefixes: [] });
    assert.equal(result.messages.find(message => message.type === "failed")?.storageCode, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
    assert.equal(result.messages.some(message => message.type === "done"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index worker rejects a cancelled generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-stale-"));
  const workspaceId = "local:worker:stale";
  const db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
  const generation = db.reserveBuild(settings, "worker");
  db.cancelBuild(generation, "stale", "cancelled");
  db.close();
  try {
    const result = await runIndexWorker({
      workspaceId,
      workspacePath: root,
      generation,
      includeHidden: true,
      maxEntries: settings.maxEntries,
      configStamp: settings.configStamp,
      excludeRulesStamp: settings.excludeRulesStamp,
      excludeDirNames: [],
      excludePathPrefixes: [],
    });
    const failed = result.messages.find((message) => message.type === "failed");
    assert.ok(failed);
    assert.match(String(failed?.message ?? ""), /generation 已过期/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index worker rejects invalid generation input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-invalid-"));
  try {
    await assert.rejects(
      runIndexWorker({
        workspaceId: "local:worker:invalid",
        workspacePath: root,
        generation: 0,
        includeHidden: true,
        maxEntries: settings.maxEntries,
        configStamp: settings.configStamp,
        excludeRulesStamp: settings.excludeRulesStamp,
        excludeDirNames: [],
        excludePathPrefixes: [],
      }),
      /generation 必须是正整数/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index worker reports truncation across multiple database batches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-index-worker-capacity-"));
  const workspaceId = "local:worker:capacity";
  let db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
  const generation = db.reserveBuild(settings, "worker");
  db.close();
  try {
    for (let index = 0; index < 1_001; index += 1) {
      fs.writeFileSync(path.join(root, `entry-${String(index).padStart(4, "0")}.txt`), "entry", "utf8");
    }
    const result = await runIndexWorker({
      workspaceId,
      workspacePath: root,
      generation,
      includeHidden: true,
      maxEntries: settings.maxEntries,
      configStamp: settings.configStamp,
      excludeRulesStamp: settings.excludeRulesStamp,
      excludeDirNames: [],
      excludePathPrefixes: [],
    });
    const done = result.messages.find((message) => message.type === "done");
    assert.ok(done);
    assert.equal(done?.indexedCount, 1_000);
    assert.equal(done?.partial, true);
    db = openWorkspacePathIndexDb({ workspaceId, workspacePath: root, settings });
    const published = db.publishBuild(generation, Boolean(done?.partial));
    assert.equal(published.status, "stale");
    assert.equal(published.activeIndexedCount, 1_000);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace path index storage helper excludes only database artifacts", () => {
  const excluded = [
    ".codeflowai/file-index.db",
    ".codeflowai/file-index.db-wal",
    ".codeflowai/file-index.db-shm",
    ".codeflowai/file-index.db-journal",
    ".codeflowai/file-index.db.recovery-token",
    "codeflowai/file-index.db",
    "codeflowai/file-index.db-wal",
    "codeflowai/file-index.db-shm",
    "codeflowai/file-index.db-journal",
    "codeflowai/file-index.db.recovery-20260823",
    "codeflowai/file-index.db.recovery-20260823-wal",
    "codeflowai\\file-index.db.recovery-token-shm",
  ];
  for (const relPath of excluded) assert.equal(isWorkspacePathIndexStorageRelPath(relPath), true, relPath);
  for (const relPath of [
    "codeflowai/codeflowai.json",
    "codeflowai/file-index-ignore.txt",
    "codeflowai/file-index.db-notes",
    ".codeflowai/file-index.db-notes",
    ".codeflowai/static-data.json",
    "docs/file-index.db",
  ]) assert.equal(isWorkspacePathIndexStorageRelPath(relPath), false, relPath);
});
