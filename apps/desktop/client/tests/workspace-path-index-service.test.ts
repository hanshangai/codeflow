import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Worker } from "node:worker_threads";

import type { WorkspaceId } from "@codeflowai/shared";
import {
  defaultCodeflowaiConfig,
  ensureCodeflowaiConfig,
  readExistingCodeflowaiConfig,
  writeCodeflowaiConfig,
} from "../src/codeflowai/codeflowaiConfig.ts";
import { WorkspaceCodeflowaiDirectoryError } from "../src/codeflowai/workspaceCodeflowaiDirectory.ts";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.ts";
import { openWorkspacePathIndexDb, WorkspacePathIndexDb, WorkspacePathIndexDbError } from "../src/fs/workspacePathIndexDb.ts";
import { logger } from "../src/logger.ts";

/** 既有单元测试显式提供日志边界；真实固定 writer 由独立集成用例验证。 */
function createIndexService(options: Omit<ConstructorParameters<typeof WorkspacePathIndexService>[0], "writeWorkspaceLog"> = {}): WorkspacePathIndexService {
  return new WorkspacePathIndexService({ ...options, writeWorkspaceLog: (_workspaceId, entry) => logger[entry.level](entry.tag, entry.message, entry.data) });
}

type Fixture = {
  root: string;
  workspaceId: WorkspaceId;
  cleanup: () => void;
};

class ControlledIndexWorker extends EventEmitter {
  private exited = false;
  terminateCalls = 0;
  terminateError: Error | null = null;

  constructor(
    readonly data: {
      workspaceId: WorkspaceId;
      generation: number;
      configStamp: string;
      excludeRulesStamp: string;
      policyStamp: string;
      maxEntries: number;
      excludeDirNames: string[];
      excludePathPrefixes: string[];
    },
    private readonly onExit: () => void,
  ) {
    super();
  }

  /** 发送构建完成消息，随后由 service 终止 worker。 */
  complete(): void {
    this.emit("message", {
      type: "done",
      workspaceId: this.data.workspaceId,
      generation: this.data.generation,
      indexedCount: 0,
      skippedDirCount: 0,
      partial: false,
    });
  }

  /** 模拟 Worker.terminate，并且只触发一次 exit。 */
  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.terminateError) return Promise.reject(this.terminateError);
    if (!this.exited) {
      this.exited = true;
      this.onExit();
      this.emit("exit", 0);
    }
    return Promise.resolve(0);
  }
}

/** 创建指定 ID 的临时 workspace，供索引 service 扫描。 */
function createFixture(workspaceId = "local:test:index" as WorkspaceId): Fixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "codeflowai-path-index-"));
  return {
    root,
    workspaceId,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createDirectoryLink(targetPath: string, linkPath: string): void {
  fs.symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function removeDirectoryLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    // 链接未创建或已由测试清理。
  }
}

/** 写入 workspace 文件索引排除配置。 */
function writeFileIndexIgnore(root: string, content: string): void {
  const dir = path.join(root, ".codeflowai");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "file-index-ignore.txt"), content, "utf8");
}

/** 写入 workspace 的 codeflowai.json 文件索引配置。 */
function writeCodeflowaiFileIndexConfig(root: string, maxEntries: number | null): void {
  const dir = path.join(root, ".codeflowai");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "codeflowai.json"), JSON.stringify({ fileIndex: { maxEntries } }, null, 2), "utf8");
}

/** 等待索引进入 ready/stale/failed 终态，失败时抛出当前状态。 */
async function waitForIndexed(
  service: WorkspacePathIndexService,
  fixture: Fixture,
  query: string,
): Promise<ReturnType<WorkspacePathIndexService["search"]>> {
  const deadline = Date.now() + 5000;
  let last = service.search(fixture.workspaceId, fixture.root, query, { limit: 20 });
  while (Date.now() < deadline) {
    if (last.indexStatus === "ready" || last.indexStatus === "stale" || last.indexStatus === "failed") return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = service.search(fixture.workspaceId, fixture.root, query, { limit: 20 });
  }
  throw new Error(`索引未完成：status=${last.indexStatus ?? "missing"} message=${last.message ?? ""}`);
}

/** 等待异步 worker 调度条件成立。 */
async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

for (const phase of ["reserve", "cancel", "start", "apply", "done", "failed", "error", "exit", "terminate"] as const) {
  test(`workspace storage protection stops ${phase} and repeated searches fail explicitly`, async (t) => {
    const fixture = createFixture(`local:test:storage:${phase}` as WorkspaceId);
    const workers: ControlledIndexWorker[] = [];
    const events: Array<{ type: string; generation: number }> = [];
    const service = createIndexService({
      warmupDelayMs: 0,
      workerFactory: (_workerPath, data) => {
        const worker = new ControlledIndexWorker(data, () => undefined);
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    service.subscribeLifecycle(event => events.push(event));
    const reservation = service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root, { requestId: `guard-${phase}` });
    assert.equal(reservation.kind, "reserved");
    if (reservation.kind !== "reserved") throw new Error("missing reservation");
    const running = ["apply", "done", "failed", "error", "exit", "terminate"].includes(phase);
    if (running) {
      service.startReservedWorkspaceRebuild(fixture.workspaceId, reservation.generation);
      await waitForCondition(() => workers.length === 1, "storage test worker missing");
    }
    const peer = path.join(fixture.root, "sentinel");
    const sidecar = path.join(fixture.root, ".codeflowai", "file-index.db-journal");
    fs.writeFileSync(peer, "untouched");
    fs.linkSync(peer, sidecar);
    const cancelBuild = WorkspacePathIndexDb.prototype.cancelBuild;
    const updateStatus = WorkspacePathIndexDb.prototype.updateStatus;
    let cancelCalls = 0;
    let statusCalls = 0;
    t.mock.method(WorkspacePathIndexDb.prototype, "cancelBuild", function (this: WorkspacePathIndexDb, ...args: Parameters<WorkspacePathIndexDb["cancelBuild"]>) { cancelCalls += 1; return cancelBuild.apply(this, args); });
    t.mock.method(WorkspacePathIndexDb.prototype, "updateStatus", function (this: WorkspacePathIndexDb, ...args: Parameters<WorkspacePathIndexDb["updateStatus"]>) { statusCalls += 1; return updateStatus.apply(this, args); });
    const protectionError = (error: unknown): boolean => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE";
    try {
      if (phase === "reserve") assert.throws(() => service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root), protectionError);
      if (phase === "cancel") assert.throws(() => service.cancelReservedWorkspaceRebuild(fixture.workspaceId, reservation.generation), protectionError);
      if (phase === "apply") assert.throws(() => service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "sentinel" }]), protectionError);
      if (phase === "terminate") await assert.rejects(service.terminateWorkspaceRebuild(fixture.workspaceId, reservation.generation, "stop"), protectionError);
      if (phase === "start") {
        service.startReservedWorkspaceRebuild(fixture.workspaceId, reservation.generation);
        await waitForCondition(() => events.some(event => event.type === "failed"), "start storage failure did not finish");
      }
      if (phase === "done") workers[0]!.complete();
      if (phase === "failed") workers[0]!.emit("message", { type: "failed", workspaceId: fixture.workspaceId, generation: reservation.generation, message: "scan failed", storageCode: "WORKSPACE_FILE_INDEX_PATH_UNSAFE" });
      if (phase === "error") workers[0]!.emit("error", new Error("native worker failed"));
      if (phase === "exit") workers[0]!.emit("exit", 2);
      for (let attempt = 0; attempt < 2; attempt += 1) assert.throws(() => service.search(fixture.workspaceId, fixture.root, "sentinel"), protectionError);
      assert.equal(cancelCalls, ["cancel", "terminate", "error", "exit"].includes(phase) ? 1 : 0, "保护失败后不再调用 cancel 补写");
      assert.equal(statusCalls, 0, "保护失败后不调用 updateStatus 补写");
      if (running && phase !== "exit") assert.ok(workers[0]!.terminateCalls > 0);
      if (["start", "done", "failed", "error", "exit"].includes(phase)) {
        assert.equal(events.filter(event => event.type === "failed").length, 1);
        workers[0]?.emit("message", { type: "heartbeat", workspaceId: fixture.workspaceId, generation: reservation.generation, indexedCount: 9 });
        workers[0]?.complete();
        workers[0]?.emit("error", new Error("late error"));
        assert.equal(events.filter(event => event.type === "failed").length, 1);
        assert.equal(events.some(event => event.type === "done" || event.type === "heartbeat"), false);
      }
      if (phase === "done") await assert.rejects(service.waitForIdle(), protectionError);
      assert.equal(fs.readFileSync(peer, "utf8"), "untouched");
      fs.unlinkSync(sidecar);
      assert.equal(service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root).kind, "reserved");
    } finally {
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      await service.dispose();
      fixture.cleanup();
    }
  });
}

test("workspace reserve reports the committed generation when its following metadata read fails", async (t) => {
  const fixture = createFixture();
  const service = createIndexService();
  const events: Array<{ type: string; generation: number }> = [];
  service.subscribeLifecycle(event => events.push(event));
  const first = service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root);
  assert.equal(first.kind, "reserved");
  if (first.kind !== "reserved") throw new Error("missing reservation");
  const reserveBuild = WorkspacePathIndexDb.prototype.reserveBuild;
  const getMeta = WorkspacePathIndexDb.prototype.getMeta;
  let reserved = false;
  t.mock.method(WorkspacePathIndexDb.prototype, "reserveBuild", function (this: WorkspacePathIndexDb, ...args: Parameters<WorkspacePathIndexDb["reserveBuild"]>) {
    const generation = reserveBuild.apply(this, args);
    reserved = true;
    return generation;
  });
  t.mock.method(WorkspacePathIndexDb.prototype, "getMeta", function (this: WorkspacePathIndexDb) {
    if (reserved) throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_PATH_UNSAFE", "post-reserve identity failed");
    return getMeta.call(this);
  });
  try {
    assert.throws(() => service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root), /post-reserve identity failed/);
    assert.deepEqual(events.filter(event => event.type === "failed").map(event => event.generation), [first.generation + 1]);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace terminate preserves storage and cleanup causes and retains the slot until real exit", async () => {
  const first = createFixture("local:terminate:first" as WorkspaceId);
  const second = createFixture("local:terminate:second" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  const service = createIndexService({ workerFactory: (_workerPath, data) => {
    const worker = new ControlledIndexWorker(data, () => undefined);
    workers.push(worker);
    return worker as unknown as Worker;
  } });
  const reservation = service.reserveWorkspaceRebuild(first.workspaceId, first.root);
  if (reservation.kind !== "reserved") throw new Error("missing reservation");
  service.startReservedWorkspaceRebuild(first.workspaceId, reservation.generation);
  await waitForCondition(() => workers.length === 1, "first worker missing");
  workers[0]!.terminateError = new Error("terminate rejected");
  const peer = path.join(first.root, "sentinel");
  const sidecar = path.join(first.root, ".codeflowai", "file-index.db-journal");
  fs.writeFileSync(peer, "outside");
  fs.linkSync(peer, sidecar);
  try {
    await assert.rejects(service.terminateWorkspaceRebuild(first.workspaceId, reservation.generation, "stop"), (error: unknown) => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE" && error.cause instanceof AggregateError && error.cause.errors.some(cause => cause instanceof Error && cause.message === "terminate rejected"));
    const next = service.reserveWorkspaceRebuild(second.workspaceId, second.root);
    if (next.kind !== "reserved") throw new Error("missing next reservation");
    service.startReservedWorkspaceRebuild(second.workspaceId, next.generation);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(workers.length, 1);
    workers[0]!.emit("exit", 1);
    await waitForCondition(() => workers.length === 2, "real exit did not release slot");
    await assert.rejects(service.waitForIdle(), error => error === workers[0]!.terminateError);
  } finally {
    fs.unlinkSync(sidecar);
    await service.dispose();
    first.cleanup();
    second.cleanup();
  }
});

test("workspace incremental failures preserve nested path diagnostics and storage causes after close fails", async (t) => {
  const fixture = createFixture();
  const service = createIndexService();
  service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root);
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => { if (data) logs.push(data); });
  const realpath = fs.realpathSync.native.bind(fs.realpathSync);
  t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.join(fixture.root, "visible.ts")) throw Object.assign(new Error("PRIVATE_PATH_IO_BODY"), { code: "EIO" });
    return realpath(target, options as never);
  }) as typeof fs.realpathSync.native);
  t.mock.method(WorkspacePathIndexDb.prototype, "updateStatus", () => { throw new WorkspacePathIndexDbError("WORKSPACE_FILE_INDEX_PATH_UNSAFE", "PRIVATE_STORAGE_IO_BODY", { cause: new WorkspacePathIndexDbError("WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED", "PRIVATE_GIT_IO_BODY") }); });
  const close = WorkspacePathIndexDb.prototype.close;
  t.mock.method(WorkspacePathIndexDb.prototype, "close", function (this: WorkspacePathIndexDb) { close.call(this); throw new Error("PRIVATE_CLOSE_IO_BODY"); });
  try {
    assert.throws(() => service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "visible.ts" }], { requestId: "nested-causes" }), error => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
    assert.equal(logs.length, 1);
    const log = logs[0]!;
    assert.equal(log.requestId, "nested-causes");
    assert.equal(log.workspaceId, fixture.workspaceId);
    assert.equal(log.diagnosticCode, "WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED");
    assert.equal(log.path, "visible.ts");
    assert.equal(log.systemCode, "EIO");
    assert.ok((log.causes as string[]).includes("WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED"));
    assert.ok((log.causes as string[]).includes("WORKSPACE_FILE_INDEX_PATH_UNSAFE"));
    assert.ok((log.causes as string[]).includes("WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED"));
    for (const privateBody of ["PRIVATE_PATH_IO_BODY", "PRIVATE_STORAGE_IO_BODY", "PRIVATE_GIT_IO_BODY", "PRIVATE_CLOSE_IO_BODY"]) assert.equal(JSON.stringify(logs).includes(privateBody), false);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

for (const entry of ["reserve", "warmup"] as const) test(`workspace unsafe open is logged once by its ${entry} handling boundary`, async (t) => {
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "index-open-outside-"));
  const runtime = path.join(fixture.root, ".codeflowai");
  createDirectoryLink(outside, runtime);
  const service = createIndexService();
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => { if (data) logs.push(data); });
  try {
    if (entry === "reserve") assert.throws(() => service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root, { requestId: "open-once" }), error => error instanceof WorkspaceCodeflowaiDirectoryError && error.code === "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
    else service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.workspaceId, fixture.workspaceId);
    assert.equal(logs[0]?.requestId, entry === "reserve" ? "open-once" : null);
    assert.equal(logs[0]?.code, "workspace_file_index_settings_read_failed");
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await service.dispose();
    fs.unlinkSync(runtime);
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("workspace query exposes the original failure and a connection close failure", async (t) => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "healthy.ts"), "healthy");
    await waitForIndexed(service, fixture, "healthy");
    t.mock.method(WorkspacePathIndexDb.prototype, "search", () => { throw new Error("query broken"); });
    const close = WorkspacePathIndexDb.prototype.close;
    const closeMock = t.mock.method(WorkspacePathIndexDb.prototype, "close", function (this: WorkspacePathIndexDb) {
      close.call(this);
      throw new Error("close broken");
    });
    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "healthy"), (error: unknown) => error instanceof Error && error.cause instanceof AggregateError && error.cause.errors.map(cause => cause.message).join("|") === "query broken|close broken");
    closeMock.mock.restore();
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace settings failure stops search before any realtime fallback", async () => {
  const fixture = createFixture();
  const service = createIndexService();
  service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root);
  // 关闭已打开的索引库后才能在同一控制目录内注入非法设置。
  service.deleteWorkspace(fixture.workspaceId);
  const controls = path.join(fixture.root, ".codeflowai");
  fs.renameSync(controls, path.join(fixture.root, "parked-controls"));
  fs.writeFileSync(controls, "invalid settings directory");
  try {
    let original: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) assert.throws(() => service.search(fixture.workspaceId, fixture.root, "peer"), error => {
      if (attempt === 0) original = error;
      assert.equal(error, original); assert.match((error as Error).message, /codeflowai.*普通目录/u); return true;
    });
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("迁移暂停取消已有warmup并阻止新构建，释放后沿原state恢复", async () => {
  const fixture = createFixture();
  const workers: ControlledIndexWorker[] = [];
  const service = createIndexService({ warmupDelayMs: 0, workerFactory: (_workerPath, data) => {
    const worker = new ControlledIndexWorker(data, () => {});
    workers.push(worker);
    return worker as unknown as Worker;
  } });
  try {
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const resume = await service.suspendWorkspace(fixture.workspaceId);
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers.length, 0);
    resume();
    await waitForCondition(() => workers.length === 1, "释放迁移暂停后未恢复原构建");
    const pauseActive = await service.suspendWorkspace(fixture.workspaceId);
    assert.equal(workers[0]!.terminateCalls, 1);
    pauseActive();
  } finally { await service.dispose(); fixture.cleanup(); }
});

test("workspace path index runs warmup workers one at a time", async () => {
  const first = createFixture("local:test:index:first" as WorkspaceId);
  const second = createFixture("local:test:index:second" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: (_workerPath, workerData) => {
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      const worker = new ControlledIndexWorker(workerData, () => {
        activeWorkers -= 1;
      });
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    service.scheduleWarmup(new Map([
      [first.workspaceId, first.root],
      [second.workspaceId, second.root],
    ]));

    await waitForCondition(() => workers.length === 1, "首个索引 worker 未启动");
    assert.equal(activeWorkers, 1);
    workers[0]?.complete();
    await waitForCondition(() => workers.length === 2, "第二个索引 worker 未在首个完成后启动");
    assert.equal(activeWorkers, 1);
    workers[1]?.complete();
    await waitForCondition(() => activeWorkers === 0, "索引 worker 未全部退出");
    assert.equal(maxActiveWorkers, 1);
  } finally {
    await service.dispose();
    first.cleanup();
    second.cleanup();
  }
});

test("workspace path index builds asynchronously and searches ready index", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "alpha-service.ts"), "alpha", "utf8");
    fs.writeFileSync(path.join(fixture.root, "README.md"), "readme", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const first = service.search(fixture.workspaceId, fixture.root, "alpha", { limit: 10 });
    assert.ok(first.indexStatus === "queued" || first.indexStatus === "building" || first.indexStatus === "ready");

    const ready = await waitForIndexed(service, fixture, "alpha");
    assert.notEqual(ready.indexStatus, "failed", ready.message ?? "");
    assert.ok(ready.results.some((item) => item.path === "src/alpha-service.ts"));
    assert.equal(ready.partial, ready.indexStatus === "stale");
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("new file after index ready is searchable without manual rebuild", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "alpha-service.ts"), "alpha", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "alpha");

    fs.writeFileSync(path.join(fixture.root, "src", "fresh-file.ts"), "fresh", "utf8");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = service.search(fixture.workspaceId, fixture.root, "fresh-file", { limit: 20 });
      if (result.results.some(item => item.path === "src/fresh-file.ts")) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("新写入文件未进入文件索引");
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index excludes dependency and build output directories", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "node_modules", "pkg"), { recursive: true });
    const git = spawnSync("git", ["init", fixture.root], { encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    fs.mkdirSync(path.join(fixture.root, "target"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "source-code", "hsurp-platform", "hsurp-server", "target"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "visible-target.ts"), "visible", "utf8");
    fs.writeFileSync(path.join(fixture.root, "node_modules", "pkg", "hidden-lib.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, ".git", "objects", "hidden-git.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "target", "hidden-build.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "source-code", "hsurp-platform", "hsurp-server", "target", "hidden-maven.ts"), "hidden", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "visible");
    const result = service.search(fixture.workspaceId, fixture.root, "hidden", { limit: 20 });
    const paths = result.results.map((item) => item.path);

    assert.deepEqual(paths, []);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index keeps language source bin directories", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src", "bin"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "bin", "tool-main.rs"), "tool", "utf8");
    fs.writeFileSync(path.join(fixture.root, "bin", "generated-tool"), "generated", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "tool");
    const result = service.search(fixture.workspaceId, fixture.root, "tool", { limit: 20 });
    const paths = result.results.map((item) => item.path);

    assert.ok(paths.includes("src/bin/tool-main.rs"));
    assert.ok(!paths.includes("bin/generated-tool"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index excludes hidden directories but keeps hidden files searchable", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, ".vscode"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, ".vscode", "hidden-vscode-task.json"), "{}", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", ".local-env"), "KEY=1", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", "visible-task.ts"), "visible", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "visible-task");
    const hiddenDirResult = service.search(fixture.workspaceId, fixture.root, "hidden-vscode-task", { limit: 20, includeHidden: true });
    const hiddenFileResult = service.search(fixture.workspaceId, fixture.root, "local-env", { limit: 20, includeHidden: true });

    assert.deepEqual(hiddenDirResult.results.map((item) => item.path), []);
    assert.ok(hiddenFileResult.results.some((item) => item.path === "src/.local-env"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index initializes codeflowai file-index-ignore.txt with examples", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "index-init-target.ts"), "init", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "index-init");
    const ignorePath = path.join(fixture.root, ".codeflowai", "file-index-ignore.txt");

    assert.ok(fs.existsSync(ignorePath));
    const content = fs.readFileSync(ignorePath, "utf8");
    assert.match(content, /CodeFlow 文件索引排除规则（本地工作区个性化规则）/);
    assert.match(content, /# data\/raw/);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index warmup does not block startup when ignore config cannot be initialized", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, ".codeflowai"), "blocks directory creation", "utf8");

    assert.doesNotThrow(() => {
      service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    });

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "anything"), /codeflowai.*普通目录|EEXIST|ENOTDIR/i);
    assert.equal(fs.readFileSync(path.join(fixture.root, ".codeflowai"), "utf8"), "blocks directory creation");
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index warmup isolates an explicit read-only workspace", async (t) => {
  const fixture = createFixture("local:test:index:readonly" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  t.mock.method(fs, "mkdirSync", ((target: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode) => {
    if (path.resolve(String(target)) === path.join(fixture.root, ".codeflowai")) {
      throw Object.assign(new Error("read-only workspace"), { code: "EACCES" });
    }
    return originalMkdirSync(target, options as any);
  }) as typeof fs.mkdirSync);
  try {
    assert.doesNotThrow(() => {
      service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    });

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "anything"), /read-only workspace|EACCES/i);
    assert.equal(fs.existsSync(path.join(fixture.root, ".codeflowai")), false);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("codeflowai config creates a missing file and backs up malformed content before repair", async () => {
  const fixture = createFixture("local:test:index:config-repair" as WorkspaceId);
  try {
    const first = ensureCodeflowaiConfig(fixture.root);
    assert.equal(fs.existsSync(first.path), true);
    assert.deepEqual(first.config, defaultCodeflowaiConfig());

    const malformed = "\u0000\u0000malformed-config";
    fs.writeFileSync(first.path, malformed, "utf8");
    const repaired = ensureCodeflowaiConfig(fixture.root);
    const directoryEntries = fs.readdirSync(path.dirname(first.path));
    const backupName = directoryEntries.find((name) => name.startsWith("codeflowai.json.bad."));

    assert.ok(backupName);
    assert.equal(fs.readFileSync(path.join(path.dirname(first.path), backupName), "utf8"), malformed);
    assert.deepEqual(repaired.config, defaultCodeflowaiConfig());
    assert.deepEqual(JSON.parse(fs.readFileSync(repaired.path, "utf8")), defaultCodeflowaiConfig());
  } finally {
    fixture.cleanup();
  }
});

test("codeflowai config read-only lookup neither creates nor rewrites workspace controls", async () => {
  const fixture = createFixture("local:test:index:config-read-only" as WorkspaceId);
  try {
    assert.equal(readExistingCodeflowaiConfig(fixture.root), null);
    assert.equal(fs.existsSync(path.join(fixture.root, ".codeflowai")), false);

    const directoryPath = path.join(fixture.root, ".codeflowai");
    const configPath = path.join(directoryPath, "codeflowai.json");
    const raw = JSON.stringify({ paths: { workflowDocsRoot: "custom-docs" } });
    fs.mkdirSync(directoryPath);
    fs.writeFileSync(configPath, raw, "utf8");

    const existing = readExistingCodeflowaiConfig(fixture.root);
    assert.equal(path.basename(existing?.path ?? ""), "codeflowai.json");
    assert.equal(fs.statSync(existing?.path ?? "").ino, fs.statSync(configPath).ino);
    assert.equal(existing?.config.paths?.workflowDocsRoot, "custom-docs");
    assert.equal(fs.readFileSync(configPath, "utf8"), raw);
    assert.deepEqual(fs.readdirSync(directoryPath), ["codeflowai.json"]);
  } finally {
    fixture.cleanup();
  }
});

test("workspace path index rejects an external codeflowai directory across service entry points", async (t) => {
  const fixture = createFixture("local:test:index:external-control-dir" as WorkspaceId);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-path-index-external-"));
  const linkedDirectory = path.join(fixture.root, ".codeflowai");
  const service = createIndexService({ warmupDelayMs: 0 });
  const errorLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    try {
      createDirectoryLink(externalRoot, linkedDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        t.skip(`当前平台无法创建目录链接：${code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(path.join(fixture.root, "fallback-visible.ts"), "visible", "utf8");

    assert.throws(() => readExistingCodeflowaiConfig(fixture.root), /codeflowai.*普通目录|直接子目录/u);
    assert.throws(() => ensureCodeflowaiConfig(fixture.root), /codeflowai.*普通目录|直接子目录/u);
    assert.throws(
      () => writeCodeflowaiConfig(fixture.root, defaultCodeflowaiConfig()),
      /codeflowai.*普通目录|直接子目录/u,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);

    assert.throws(
      () => service.upsertWorkspace(fixture.workspaceId, fixture.root, { requestId: "unsafe-upsert" }),
      /codeflowai.*普通目录|直接子目录/u,
    );
    const upsertLog = errorLogs.find((entry) => entry.code === "workspace_file_index_settings_read_failed");
    assert.equal(upsertLog?.requestId, "unsafe-upsert");
    assert.equal(upsertLog?.workspaceId, fixture.workspaceId);
    assert.equal(upsertLog?.generation, null);
    assert.equal(upsertLog?.indexPath, path.join(fixture.root, ".codeflowai", "file-index.db"));
    assert.match(String(upsertLog?.rootCause ?? ""), /codeflowai.*普通目录|直接子目录/u);
    assert.deepEqual(fs.readdirSync(externalRoot), []);

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "fallback-visible", { limit: 10 }, { requestId: "unsafe-search" }), /codeflowai.*普通目录|直接子目录/u);
    assert.deepEqual(fs.readdirSync(externalRoot), []);

    assert.throws(
      () => service.applyChanges(
        fixture.workspaceId,
        fixture.root,
        [{ type: "upsert", path: "fallback-visible.ts" }],
        { requestId: "unsafe-incremental" },
      ),
      /codeflowai.*普通目录|直接子目录/u,
    );
    assert.throws(
      () => service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root, { requestId: "unsafe-rebuild" }),
      /codeflowai.*普通目录|直接子目录/u,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
    assert.equal(fs.existsSync(path.join(externalRoot, "file-index.db")), false);
  } finally {
    await service.dispose();
    removeDirectoryLink(linkedDirectory);
    fixture.cleanup();
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index ignores forged external controls and isolates the unsafe workspace", async (t) => {
  const unsafe = createFixture("local:test:index:forged-external-controls" as WorkspaceId);
  const healthy = createFixture("local:test:index:healthy-control-dir" as WorkspaceId);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-path-index-forged-"));
  const linkedDirectory = path.join(unsafe.root, ".codeflowai");
  const forgedConfigPath = path.join(externalRoot, "codeflowai.json");
  const forgedIgnorePath = path.join(externalRoot, "file-index-ignore.txt");
  const forgedConfig = "\u0000\u0000forged-config";
  const forgedIgnore = "../outside\n";
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(forgedConfigPath, forgedConfig, "utf8");
    fs.writeFileSync(forgedIgnorePath, forgedIgnore, "utf8");
    try {
      createDirectoryLink(externalRoot, linkedDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        t.skip(`当前平台无法创建目录链接：${code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(path.join(unsafe.root, "unsafe-visible.ts"), "unsafe", "utf8");
    fs.writeFileSync(path.join(healthy.root, "healthy-visible.ts"), "healthy", "utf8");

    service.scheduleWarmup(new Map([
      [unsafe.workspaceId, unsafe.root],
      [healthy.workspaceId, healthy.root],
    ]));
    assert.throws(() => service.search(unsafe.workspaceId, unsafe.root, "unsafe-visible"), /codeflowai.*普通目录|直接子目录/u);
    const healthyResult = await waitForIndexed(service, healthy, "healthy-visible");

    assert.equal(healthyResult.indexStatus, "ready");
    assert.deepEqual(healthyResult.results.map((entry) => entry.path), ["healthy-visible.ts"]);
    assert.equal(fs.readFileSync(forgedConfigPath, "utf8"), forgedConfig);
    assert.equal(fs.readFileSync(forgedIgnorePath, "utf8"), forgedIgnore);
    assert.deepEqual(fs.readdirSync(externalRoot).sort(), ["codeflowai.json", "file-index-ignore.txt"]);
  } finally {
    await service.dispose();
    removeDirectoryLink(linkedDirectory);
    unsafe.cleanup();
    healthy.cleanup();
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index rejects a hard-linked ignore control without modifying its peer", async (t) => {
  const fixture = createFixture("local:test:index:hard-linked-ignore" as WorkspaceId);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-path-index-hardlink-"));
  const externalFile = path.join(externalRoot, "outside-ignore.txt");
  const indexDirectory = path.join(fixture.root, ".codeflowai");
  const ignorePath = path.join(indexDirectory, "file-index-ignore.txt");
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(indexDirectory);
    fs.writeFileSync(externalFile, "outside-content", "utf8");
    try {
      fs.linkSync(externalFile, ignorePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOSYS", "EXDEV"].includes(String(code))) {
        t.skip(`当前平台无法创建硬链接：${code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(path.join(fixture.root, "fallback-hardlink.ts"), "fallback", "utf8");

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "fallback-hardlink", { limit: 10 }, { requestId: "unsafe-hardlink" }), /普通文件.*file-index-ignore\.txt/u);
    assert.equal(fs.readFileSync(externalFile, "utf8"), "outside-content");
    assert.equal(fs.existsSync(path.join(indexDirectory, "file-index.db")), false);
  } finally {
    await service.dispose();
    fixture.cleanup();
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index rejects an external sqlite sidecar without poisoning other files", async (t) => {
  const fixture = createFixture("local:test:index:external-sidecar" as WorkspaceId);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-path-index-sidecar-"));
  const externalFile = path.join(externalRoot, "outside-wal");
  const indexDirectory = path.join(fixture.root, ".codeflowai");
  const sidecarPath = path.join(indexDirectory, "file-index.db-wal");
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(indexDirectory);
    fs.writeFileSync(externalFile, "outside-content", "utf8");
    try {
      fs.symlinkSync(externalFile, sidecarPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        t.skip(`当前平台无法创建文件链接：${code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(path.join(fixture.root, "fallback-sidecar.ts"), "fallback", "utf8");

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "fallback-sidecar", { limit: 10 }, { requestId: "unsafe-sidecar" }), error => error instanceof WorkspacePathIndexDbError && error.code === "WORKSPACE_FILE_INDEX_PATH_UNSAFE");
    assert.equal(fs.readFileSync(externalFile, "utf8"), "outside-content");
    assert.equal(fs.existsSync(path.join(indexDirectory, "file-index.db")), false);
  } finally {
    await service.dispose();
    try {
      fs.unlinkSync(sidecarPath);
    } catch {
      // 链接未创建或已清理。
    }
    fixture.cleanup();
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("workspace path index keeps env directories searchable by default", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "env"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "env", "sample-env-config.ts"), "env", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "sample-env");
    const result = service.search(fixture.workspaceId, fixture.root, "sample-env", { limit: 20 });

    assert.ok(result.results.some((item) => item.path === "env/sample-env-config.ts"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index applies workspace file index ignore exclusions", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    writeFileIndexIgnore(fixture.root, ["generated", "data/raw"].join("\n"));
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "generated"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "data", "raw"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "data", "curated"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "visible-custom.ts"), "visible", "utf8");
    fs.writeFileSync(path.join(fixture.root, "generated", "hidden-generated.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "data", "raw", "hidden-raw.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "data", "curated", "visible-curated.ts"), "visible", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "visible");
    const hidden = service.search(fixture.workspaceId, fixture.root, "hidden", { limit: 20 });
    const visible = service.search(fixture.workspaceId, fixture.root, "visible", { limit: 20 });

    assert.deepEqual(hidden.results.map((item) => item.path), []);
    assert.ok(visible.results.some((item) => item.path === "src/visible-custom.ts"));
    assert.ok(visible.results.some((item) => item.path === "data/curated/visible-curated.ts"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index rebuilds when file index ignore changes", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "generated"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "generated", "rebuild-hidden.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", "rebuild-visible.ts"), "visible", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "rebuild");
    assert.ok(service.search(fixture.workspaceId, fixture.root, "rebuild-hidden", { limit: 20 }).results.some((item) => item.path === "generated/rebuild-hidden.ts"));

    writeFileIndexIgnore(fixture.root, "generated\n");
    await waitForIndexed(service, fixture, "rebuild-visible");
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "rebuild-hidden", { limit: 20 }).results.map((item) => item.path), []);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index reports partial results when configured max entries is reached", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0, maxEntries: 1_000 });
  try {
    for (let index = 0; index < 1_005; index += 1) {
      fs.writeFileSync(path.join(fixture.root, `overflow-${String(index).padStart(4, "0")}.txt`), "overflow", "utf8");
    }

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const result = await waitForIndexed(service, fixture, "overflow");

    assert.equal(result.indexStatus, "stale");
    assert.equal(result.partial, true);
    assert.equal(result.indexedCount, 1_000);
    assert.match(result.message ?? "", /索引已达到上限/);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index lets codeflowai config override client default max entries", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 0, maxEntries: 2_000 });
  try {
    writeCodeflowaiFileIndexConfig(fixture.root, 1_000);
    for (let index = 0; index < 1_005; index += 1) {
      fs.writeFileSync(path.join(fixture.root, `workspace-limit-${String(index).padStart(4, "0")}.txt`), "overflow", "utf8");
    }

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const result = await waitForIndexed(service, fixture, "workspace-limit");

    assert.equal(result.indexStatus, "stale");
    assert.equal(result.partial, true);
    assert.equal(result.indexedCount, 1_000);
    assert.match(result.message ?? "", /索引已达到上限/);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index serves directory query fast path from sqlite", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 10_000 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "queued-result.ts"), "queued", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "queued-result");
    const result = service.search(fixture.workspaceId, fixture.root, "src/", { limit: 10 });

    assert.ok(result.indexStatus === "ready" || result.indexStatus === "stale");
    assert.deepEqual(result.results.map((item) => item.path), ["src/queued-result.ts"]);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index rejects invalid directory queries without poisoning ready sqlite state", async (t) => {
  const fixture = createFixture("local:test:index:invalid-directory-query" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 10_000 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "etc"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "sqlite-result.ts"), "sqlite", "utf8");
    fs.writeFileSync(path.join(fixture.root, "etc", "inside.txt"), "inside", "utf8");

    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const ready = await waitForIndexed(service, fixture, "sqlite-result");
    assert.equal(ready.indexStatus, "ready");

    const absoluteDirectoryQuery = `${path.join(fixture.root, "etc").replace(/\\/g, "/")}/`;
    for (const query of ["../x", "src/../x", absoluteDirectoryQuery]) {
      const invalid = service.search(fixture.workspaceId, fixture.root, query, { limit: 10 });
      assert.deepEqual(invalid.results, [], query);
      assert.equal(invalid.hasMore, false, query);
      assert.equal(invalid.nextCursor, null, query);
      assert.equal(invalid.indexStatus, "ready", query);
      assert.equal(invalid.partial, false, query);
    }

    const directoryCalls: string[] = [];
    const internalState = (service as unknown as {
      states: Map<WorkspaceId, { db: { searchDirectory: (...args: unknown[]) => unknown } | null }>;
    }).states.get(fixture.workspaceId);
    assert.ok(internalState?.db);
    const searchDirectory = internalState.db.searchDirectory.bind(internalState.db);
    t.mock.method(internalState.db, "searchDirectory", (...args: unknown[]) => {
      directoryCalls.push(String(args[0] ?? ""));
      return searchDirectory(...args);
    });
    const posixColonDirectory = service.search(fixture.workspaceId, fixture.root, "a:folder/", { limit: 10 });
    assert.deepEqual(posixColonDirectory.results, []);
    assert.equal(posixColonDirectory.indexStatus, "ready");
    const expectedDirectoryCalls = path.sep === "/" ? ["a:folder"] : [];
    assert.deepEqual(directoryCalls, expectedDirectoryCalls);

    const legal = service.search(fixture.workspaceId, fixture.root, "src/", { limit: 10 });
    assert.equal(legal.indexStatus, "ready");
    assert.equal(legal.partial, false);
    assert.deepEqual(legal.results.map((item) => item.path), ["src/sqlite-result.ts"]);
    assert.deepEqual(directoryCalls, [...expectedDirectoryCalls, "src"]);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index bounds oversized cursors without poisoning ready sqlite state", async () => {
  const fixture = createFixture("local:test:index:oversized-cursor" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 10_000 });
  try {
    fs.writeFileSync(path.join(fixture.root, "sqlite-cursor-result.ts"), "sqlite", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const ready = await waitForIndexed(service, fixture, "sqlite-cursor-result");
    assert.equal(ready.indexStatus, "ready");

    const oversized = service.search(fixture.workspaceId, fixture.root, "sqlite-cursor-result", {
      limit: 10,
      cursor: "9".repeat(100),
    });
    assert.deepEqual(oversized.results, []);
    assert.equal(oversized.hasMore, false);
    assert.equal(oversized.nextCursor, null);
    assert.equal(oversized.indexStatus, "ready");
    assert.equal(oversized.partial, false);

    const legal = service.search(fixture.workspaceId, fixture.root, "sqlite-cursor-result", { limit: 10, cursor: "0" });
    assert.deepEqual(legal.results.map((item) => item.path), ["sqlite-cursor-result.ts"]);
    assert.equal(legal.indexStatus, "ready");
    assert.equal(legal.partial, false);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index incremental updates skip hidden directories", async () => {
  const fixture = createFixture();
  const service = createIndexService({ warmupDelayMs: 10_000 });
  try {
    fs.mkdirSync(path.join(fixture.root, ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "src", ".generated"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, ".hidden", "secret.ts"), "secret", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", ".generated", "generated.ts"), "generated", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", ".env"), "env", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", "visible.ts"), "visible", "utf8");

    service.applyChanges(fixture.workspaceId, fixture.root, [
      { type: "upsert", path: ".hidden/secret.ts" },
      { type: "upsert", path: "src/.generated/generated.ts" },
      { type: "upsert", path: "src/.env" },
      { type: "upsert", path: "src/visible.ts" },
    ]);

    const hiddenRoot = service.search(fixture.workspaceId, fixture.root, "secret", { limit: 20, includeHidden: true });
    const nestedHidden = service.search(fixture.workspaceId, fixture.root, "generated", { limit: 20, includeHidden: true });
    const hiddenFile = service.search(fixture.workspaceId, fixture.root, "env", { limit: 20, includeHidden: true });

    assert.deepEqual(hiddenRoot.results.map((item) => item.path), []);
    assert.deepEqual(nestedHidden.results.map((item) => item.path), []);
    assert.ok(hiddenFile.results.some((item) => item.path === "src/.env"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index logs and rethrows incremental sqlite failures", async (t) => {
  const fixture = createFixture("local:test:index:incremental-failure" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  const errorLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") errorLogs.push(data as Record<string, unknown>);
  });
  try {
    fs.writeFileSync(path.join(fixture.root, "existing.ts"), "existing", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "existing");
    fs.writeFileSync(path.join(fixture.root, "new-entry.ts"), "new", "utf8");

    const internalState = (service as unknown as {
      states: Map<WorkspaceId, { db: { applyMutations: (...args: unknown[]) => unknown } | null }>;
    }).states.get(fixture.workspaceId);
    assert.ok(internalState?.db);
    t.mock.method(internalState.db, "applyMutations", () => {
      throw new Error("injected mutation failure");
    });

    assert.throws(
      () => service.applyChanges(
        fixture.workspaceId,
        fixture.root,
        [{ type: "upsert", path: "new-entry.ts" }],
        { requestId: "request-incremental-failure" },
      ),
      /injected mutation failure/,
    );
    const logged = errorLogs.find((entry) => entry.code === "workspace_file_index_incremental_update_failed");
    assert.equal(logged?.requestId, "request-incremental-failure");
    assert.equal(logged?.workspaceId, fixture.workspaceId);
    assert.equal(typeof logged?.generation, "number");
    assert.equal(
      logged?.indexPath,
      path.join(fs.realpathSync.native(fixture.root), ".codeflowai", "file-index.db"),
    );
    assert.equal(logged?.rootCause, "injected mutation failure");

    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "new-entry", { limit: 20 }), /injected mutation failure/);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index preserves requestId per generation and clears it for background rebuilds", async (t) => {
  const fixture = createFixture("local:test:index:generation-request" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  const warningLogs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_tag: string, _message: string, data?: Record<string, unknown>) => {
    if (data && typeof data === "object") warningLogs.push(data as Record<string, unknown>);
  });
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    const first = service.reserveWorkspaceRebuild(
      fixture.workspaceId,
      fixture.root,
      { requestId: "request-reindex-first" },
    );
    assert.equal(first.kind, "reserved");
    if (first.kind !== "reserved") return;
    service.startReservedWorkspaceRebuild(fixture.workspaceId, first.generation);
    await waitForCondition(() => workers.length === 1, "首个请求 generation 未启动");

    service.search(fixture.workspaceId, fixture.root, "anything", { limit: 10 }, { requestId: "request-search-later" });
    workers[0]?.emit("message", {
      type: "failed",
      workspaceId: fixture.workspaceId,
      generation: first.generation,
      message: "first build failed",
    });
    await waitForCondition(
      () => warningLogs.some((entry) => entry.rootCause === "first build failed"),
      "首个 generation 失败日志未写入",
    );
    assert.equal(
      warningLogs.find((entry) => entry.rootCause === "first build failed")?.requestId,
      "request-reindex-first",
    );

    const background = service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root);
    assert.equal(background.kind, "reserved");
    if (background.kind !== "reserved") return;
    service.startReservedWorkspaceRebuild(fixture.workspaceId, background.generation);
    await waitForCondition(() => workers.length === 2, "后台 generation 未启动");
    service.search(fixture.workspaceId, fixture.root, "anything", { limit: 10 }, { requestId: "request-search-newer" });
    workers[1]?.emit("message", {
      type: "failed",
      workspaceId: fixture.workspaceId,
      generation: background.generation,
      message: "background build failed",
    });
    await waitForCondition(
      () => warningLogs.some((entry) => entry.rootCause === "background build failed"),
      "后台 generation 失败日志未写入",
    );
    assert.equal(
      warningLogs.find((entry) => entry.rootCause === "background build failed")?.requestId,
      null,
    );
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index persists incremental add rename and delete across restart", async () => {
  const fixture = createFixture("local:test:index:incremental-restart" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "baseline.ts"), "baseline", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "baseline");

    fs.writeFileSync(path.join(fixture.root, "persisted-add.ts"), "add", "utf8");
    service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "persisted-add.ts" }]);
    fs.renameSync(path.join(fixture.root, "baseline.ts"), path.join(fixture.root, "renamed.ts"));
    const renamed = service.applyChanges(fixture.workspaceId, fixture.root, [{
      type: "rename",
      fromPath: "baseline.ts",
      toPath: "renamed.ts",
    }]);
    assert.equal(renamed.indexStatus, "ready");
    assert.equal(renamed.partial, false);
    fs.rmSync(path.join(fixture.root, "renamed.ts"));
    service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "delete", path: "renamed.ts" }]);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "baseline", { limit: 10 }).results, []);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "renamed", { limit: 10 }).results, []);
    assert.ok(service.search(fixture.workspaceId, fixture.root, "persisted-add", { limit: 10 }).results.some((item) => item.path === "persisted-add.ts"));
  } finally {
    await service.dispose();
  }

  const restarted = createIndexService({ warmupDelayMs: 10_000 });
  try {
    restarted.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const persisted = restarted.search(fixture.workspaceId, fixture.root, "persisted-add", { limit: 10 });
    assert.ok(persisted.results.some((item) => item.path === "persisted-add.ts"));
    assert.deepEqual(restarted.search(fixture.workspaceId, fixture.root, "renamed", { limit: 10 }).results, []);
  } finally {
    await restarted.dispose();
    fixture.cleanup();
  }
});

test("workspace path index marks directory rename stale and removes the old subtree", async () => {
  const fixture = createFixture("local:test:index:directory-rename" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "old-dir"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "old-dir", "child.ts"), "child", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "child");

    fs.renameSync(path.join(fixture.root, "old-dir"), path.join(fixture.root, "new-dir"));
    const status = service.applyChanges(fixture.workspaceId, fixture.root, [{
      type: "rename",
      fromPath: "old-dir",
      toPath: "new-dir",
    }]);
    assert.equal(status.indexStatus, "stale");
    assert.equal(status.partial, true);
    assert.match(status.message ?? "", /目录变更/);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "old-dir", { limit: 20 }).results, []);
    assert.ok(service.search(fixture.workspaceId, fixture.root, "new-dir", { limit: 20 }).results.some((item) => item.path === "new-dir"));
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "child", { limit: 20 }).results, []);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

async function assertDirectoryRenameRaceStaysStale(input: {
  id: string;
  toPath: string;
  ignoreContent?: string;
  mutateTarget?: (targetPath: string) => void;
  expectTargetIndexed: boolean;
}): Promise<void> {
  const fixture = createFixture(`local:test:index:directory-rename-${input.id}` as WorkspaceId);
  let service: WorkspacePathIndexService | null = createIndexService({ warmupDelayMs: 0 });
  let restarted: WorkspacePathIndexService | null = null;
  try {
    if (input.ignoreContent) writeFileIndexIgnore(fixture.root, input.ignoreContent);
    fs.mkdirSync(path.join(fixture.root, "old-dir"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "old-dir", "child.ts"), "child", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "child");

    const targetPath = path.join(fixture.root, ...input.toPath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(path.join(fixture.root, "old-dir"), targetPath);
    input.mutateTarget?.(targetPath);
    const status = service.applyChanges(fixture.workspaceId, fixture.root, [{
      type: "rename",
      fromPath: "old-dir",
      toPath: input.toPath,
    }]);

    assert.equal(status.indexStatus, "stale");
    assert.equal(status.partial, true);
    assert.match(status.message ?? "", /目录变更.*手工重建/);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "old-dir", { limit: 20 }).results, []);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "child.ts", { limit: 20 }).results, []);
    const targetResults = service.search(fixture.workspaceId, fixture.root, path.posix.basename(input.toPath), { limit: 20 }).results;
    assert.equal(targetResults.some((entry) => entry.path === input.toPath), input.expectTargetIndexed);

    await service.dispose();
    service = null;
    const reopened = openWorkspacePathIndexDb({
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.root,
      settings: { configStamp: "restart-check", excludeRulesStamp: "restart-check", maxEntries: 300_000 },
    });
    try {
      const persisted = reopened.getMeta();
      assert.equal(persisted.status, "stale");
      assert.equal(persisted.partial, true);
      assert.match(persisted.message ?? "", /目录变更.*手工重建/);
    } finally {
      reopened.close();
    }

    restarted = createIndexService({ warmupDelayMs: 10_000 });
    restarted.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const afterRestart = restarted.search(fixture.workspaceId, fixture.root, "child.ts", { limit: 20 });
    assert.equal(afterRestart.partial, true);
    assert.deepEqual(afterRestart.results, []);
    const restartedTarget = restarted.search(
      fixture.workspaceId,
      fixture.root,
      path.posix.basename(input.toPath),
      { limit: 20 },
    ).results;
    assert.equal(restartedTarget.some((entry) => entry.path === input.toPath), input.expectTargetIndexed);
  } finally {
    await service?.dispose();
    await restarted?.dispose();
    fixture.cleanup();
  }
}

test("workspace path index keeps directory rename stale when target disappears before the event", async () => {
  await assertDirectoryRenameRaceStaysStale({
    id: "missing-target",
    toPath: "new-dir",
    mutateTarget: (targetPath) => fs.rmSync(targetPath, { recursive: true, force: true }),
    expectTargetIndexed: false,
  });
});

test("workspace path index keeps directory rename stale when target becomes a file", async () => {
  await assertDirectoryRenameRaceStaysStale({
    id: "file-target",
    toPath: "new-entry",
    mutateTarget: (targetPath) => {
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.writeFileSync(targetPath, "replacement", "utf8");
    },
    expectTargetIndexed: true,
  });
});

test("workspace path index keeps directory rename stale when target enters a hidden directory", async () => {
  await assertDirectoryRenameRaceStaysStale({
    id: "hidden-target",
    toPath: ".hidden/new-dir",
    expectTargetIndexed: false,
  });
});

test("workspace path index keeps directory rename stale when target enters an ignored directory", async () => {
  await assertDirectoryRenameRaceStaysStale({
    id: "ignored-target",
    toPath: "ignored/new-dir",
    ignoreContent: "ignored\n",
    expectTargetIndexed: false,
  });
});

test("workspace path index keeps directory rename stale when target enters a default excluded directory", async () => {
  await assertDirectoryRenameRaceStaysStale({
    id: "default-excluded-target",
    toPath: "node_modules/pkg/new-dir",
    expectTargetIndexed: false,
  });
});

test("workspace path index applies worker exclusion rules to incremental paths", async () => {
  const fixture = createFixture("local:test:index:incremental-exclusion" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "visible.ts"), "visible", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "visible");
    fs.mkdirSync(path.join(fixture.root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "node_modules", "pkg", "incremental-hidden.ts"), "hidden", "utf8");
    service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "node_modules/pkg/incremental-hidden.ts" }]);
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "incremental-hidden", { limit: 20 }).results, []);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index preserves directory order for modify and appends new entries", async () => {
  const fixture = createFixture("local:test:index:incremental-order" as WorkspaceId);
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "src", "a.ts"), "a", "utf8");
    fs.writeFileSync(path.join(fixture.root, "src", "b.ts"), "b", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(service, fixture, "a.ts");
    const before = service.search(fixture.workspaceId, fixture.root, "src/", { limit: 20 }).results.map((item) => item.path);

    fs.writeFileSync(path.join(fixture.root, "src", "a.ts"), "modified", "utf8");
    service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "src/a.ts" }]);
    const afterModify = service.search(fixture.workspaceId, fixture.root, "src/", { limit: 20 }).results.map((item) => item.path);
    assert.deepEqual(afterModify, before);

    fs.writeFileSync(path.join(fixture.root, "src", "c.ts"), "c", "utf8");
    service.applyChanges(fixture.workspaceId, fixture.root, [{ type: "upsert", path: "src/c.ts" }]);
    const afterAdd = service.search(fixture.workspaceId, fixture.root, "src/", { limit: 20 }).results.map((item) => item.path);
    assert.deepEqual(afterAdd.slice(0, before.length), before);
    assert.equal(afterAdd.at(-1), "src/c.ts");
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index reuses active sqlite generation while background calibration runs", async () => {
  const fixture = createFixture("local:test:index:restart" as WorkspaceId);
  const firstService = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "persisted-alpha.ts"), "alpha", "utf8");
    firstService.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const firstReady = await waitForIndexed(firstService, fixture, "persisted-alpha");
    assert.ok(firstReady.results.some((item) => item.path === "persisted-alpha.ts"));
  } finally {
    await firstService.dispose();
  }

  fs.writeFileSync(path.join(fixture.root, "offline-beta.ts"), "beta", "utf8");
  const secondService = createIndexService({ warmupDelayMs: 10_000 });
  try {
    secondService.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const reused = secondService.search(fixture.workspaceId, fixture.root, "persisted-alpha", { limit: 10 });
    assert.ok(reused.indexStatus === "queued" || reused.indexStatus === "building");
    assert.equal(reused.partial, true);
    assert.ok(reused.results.some((item) => item.path === "persisted-alpha.ts"));

    const calibrated = await waitForIndexed(secondService, fixture, "offline-beta");
    assert.ok(calibrated.results.some((item) => item.path === "offline-beta.ts"));
  } finally {
    await secondService.dispose();
    fixture.cleanup();
  }
});

test("workspace path index does not query an active generation after ignore stamp changes", async () => {
  const fixture = createFixture("local:test:index:stamp-change" as WorkspaceId);
  writeFileIndexIgnore(fixture.root, "ignoredxx\n");
  const first = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.mkdirSync(path.join(fixture.root, "generated"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "generated", "old-visible.ts"), "old", "utf8");
    fs.writeFileSync(path.join(fixture.root, "still-visible.ts"), "visible", "utf8");
    first.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForIndexed(first, fixture, "old-visible");
  } finally {
    await first.dispose();
  }
  const ignorePath = path.join(fixture.root, ".codeflowai", "file-index-ignore.txt");
  const originalIgnoreStat = fs.statSync(ignorePath);
  assert.equal(Buffer.byteLength("ignoredxx\n"), Buffer.byteLength("generated\n"));
  writeFileIndexIgnore(fixture.root, "generated\n");
  fs.utimesSync(ignorePath, originalIgnoreStat.atime, originalIgnoreStat.mtime);

  const workers: ControlledIndexWorker[] = [];
  const second = createIndexService({
    warmupDelayMs: 10_000,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    second.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    const hidden = second.search(fixture.workspaceId, fixture.root, "old-visible", { limit: 20 });
    assert.ok(hidden.indexStatus === "queued" || hidden.indexStatus === "building");
    assert.equal(hidden.partial, true);
    assert.deepEqual(hidden.results, []);
    assert.match(hidden.message ?? "", /后台校准|实时搜索/);
    const visible = second.search(fixture.workspaceId, fixture.root, "still-visible", { limit: 20 });
    assert.ok(visible.results.some((item) => item.path === "still-visible.ts"));
  } finally {
    await second.dispose();
    fixture.cleanup();
  }
});

test("workspace path index hashes normalized ignore rules instead of formatting noise", async () => {
  const fixture = createFixture("local:test:index:normalized-ignore-stamp" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  writeFileIndexIgnore(fixture.root, "generated\ncache/tmp\n");
  const service = createIndexService({
    warmupDelayMs: 50,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    writeFileIndexIgnore(fixture.root, "# formatting only\ncache/tmp\ngenerated\ngenerated\n");
    await waitForCondition(() => workers.length === 1, "规范化规则对应的索引 worker 未启动");
    assert.equal(workers[0]?.data.generation, 1);
    assert.deepEqual(workers[0]?.data.excludeDirNames, ["generated"]);
    assert.deepEqual(workers[0]?.data.excludePathPrefixes, ["cache/tmp"]);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index detects same-size config changes after mtime is restored during build", async () => {
  const fixture = createFixture("local:test:index:config-content-stamp" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  writeCodeflowaiFileIndexConfig(fixture.root, 1_000);
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForCondition(() => workers.length === 1, "首个配置摘要 worker 未启动");
    const firstWorker = workers[0]!;
    const configPath = path.join(fixture.root, ".codeflowai", "codeflowai.json");
    const originalConfigStat = fs.statSync(configPath);
    const originalConfig = fs.readFileSync(configPath, "utf8");
    const changedConfig = originalConfig.replace('"maxEntries": 1000', '"maxEntries": 2000');
    assert.notEqual(changedConfig, originalConfig);
    assert.equal(Buffer.byteLength(changedConfig), Buffer.byteLength(originalConfig));
    fs.writeFileSync(configPath, changedConfig, "utf8");
    fs.utimesSync(configPath, originalConfigStat.atime, originalConfigStat.mtime);

    firstWorker.complete();
    await waitForCondition(() => workers.length === 2, "有效配置变化后的替代 worker 未启动");
    assert.equal(workers[1]?.data.generation, 2);
    assert.equal(workers[1]?.data.maxEntries, 2_000);
    assert.notEqual(workers[1]?.data.configStamp, firstWorker.data.configStamp);
    assert.match(workers[1]?.data.configStamp ?? "", /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index replaces a queued generation when ignore rules change before worker start", async () => {
  const fixture = createFixture("local:test:index:queued-stamp-change" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  const lifecycle: Array<{ type: string; generation: number }> = [];
  const service = createIndexService({
    warmupDelayMs: 50,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  const unsubscribe = service.subscribeLifecycle((event) => {
    lifecycle.push({ type: event.type, generation: event.generation });
  });
  try {
    fs.mkdirSync(path.join(fixture.root, "generated"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "generated", "queued-hidden.ts"), "hidden", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    writeFileIndexIgnore(fixture.root, "generated\n");

    await waitForCondition(() => workers.length === 1, "配置变化后的索引 worker 未启动");
    assert.equal(workers[0]?.data.generation, 2);
    assert.ok(workers[0]?.data.excludeDirNames.includes("generated"));
    assert.deepEqual(lifecycle, [{ type: "building", generation: 2 }]);

    workers[0]?.complete();
    await waitForCondition(() => lifecycle.some((event) => event.type === "done"), "替代 generation 未发布");
    assert.deepEqual(lifecycle.at(-1), { type: "done", generation: 2 });
  } finally {
    unsubscribe();
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index replaces a completed generation when ignore rules change during build", async () => {
  const fixture = createFixture("local:test:index:building-stamp-change" as WorkspaceId);
  const workers: ControlledIndexWorker[] = [];
  const lifecycle: Array<{ type: string; generation: number }> = [];
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  const unsubscribe = service.subscribeLifecycle((event) => {
    lifecycle.push({ type: event.type, generation: event.generation });
  });
  try {
    fs.mkdirSync(path.join(fixture.root, "generated"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, "generated", "building-hidden.ts"), "hidden", "utf8");
    fs.writeFileSync(path.join(fixture.root, "building-visible.ts"), "visible", "utf8");
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    await waitForCondition(() => workers.length === 1, "首个索引 worker 未启动");
    assert.equal(workers[0]?.data.generation, 1);

    writeFileIndexIgnore(fixture.root, "generated\n");
    workers[0]?.complete();
    await waitForCondition(() => workers.length === 2, "配置变化后的替代 worker 未启动");
    assert.equal(workers[1]?.data.generation, 2);
    assert.ok(workers[1]?.data.excludeDirNames.includes("generated"));
    assert.ok(!lifecycle.some((event) => event.type === "done" && event.generation === 1));

    const secondData = workers[1]!.data;
    const db = openWorkspacePathIndexDb({
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.root,
      settings: {
        configStamp: secondData.configStamp,
        excludeRulesStamp: secondData.excludeRulesStamp,
        policyStamp: secondData.policyStamp,
        maxEntries: secondData.maxEntries,
      },
    });
    try {
      assert.equal(db.writeBuildEntries(secondData.generation, [{
        path: "building-visible.ts",
        name: "building-visible.ts",
        isDir: false,
        hidden: false,
        parentEntryOrder: 0,
      }]), true);
    } finally {
      db.close();
    }
    workers[1]?.complete();
    await waitForCondition(
      () => lifecycle.some((event) => event.type === "done" && event.generation === 2),
      "替代 generation 未发布",
    );
    assert.ok(service.search(fixture.workspaceId, fixture.root, "building-visible", { limit: 20 }).results
      .some((item) => item.path === "building-visible.ts"));
    assert.deepEqual(service.search(fixture.workspaceId, fixture.root, "building-hidden", { limit: 20 }).results, []);
  } finally {
    unsubscribe();
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index isolates a corrupt database and rebuilds only that workspace", async () => {
  const damaged = createFixture("local:test:index:damaged" as WorkspaceId);
  const healthy = createFixture("local:test:index:healthy" as WorkspaceId);
  const first = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(damaged.root, "damaged-target.ts"), "damaged", "utf8");
    fs.writeFileSync(path.join(healthy.root, "healthy-target.ts"), "healthy", "utf8");
    first.scheduleWarmup(new Map([
      [damaged.workspaceId, damaged.root],
      [healthy.workspaceId, healthy.root],
    ]));
    await waitForIndexed(first, damaged, "damaged-target");
    await waitForIndexed(first, healthy, "healthy-target");
  } finally {
    await first.dispose();
  }
  fs.writeFileSync(path.join(damaged.root, ".codeflowai", "file-index.db"), "corrupt", "utf8");

  const restarted = createIndexService({ warmupDelayMs: 0 });
  try {
    restarted.scheduleWarmup(new Map([
      [damaged.workspaceId, damaged.root],
      [healthy.workspaceId, healthy.root],
    ]));
    const damagedReady = await waitForIndexed(restarted, damaged, "damaged-target");
    const healthyReady = await waitForIndexed(restarted, healthy, "healthy-target");
    assert.ok(damagedReady.results.some((item) => item.path === "damaged-target.ts"));
    assert.ok(healthyReady.results.some((item) => item.path === "healthy-target.ts"));
    const recoveryFiles = fs.readdirSync(path.join(damaged.root, ".codeflowai"))
      .filter((name) => name.startsWith("file-index.db.recovery-"));
    assert.ok(recoveryFiles.length >= 1);
    assert.deepEqual(
      fs.readdirSync(path.join(healthy.root, ".codeflowai")).filter((name) => name.startsWith("file-index.db.recovery-")),
      [],
    );
  } finally {
    await restarted.dispose();
    damaged.cleanup();
    healthy.cleanup();
  }
});

test("workspace path index fails closed for duplicate canonical roots and recovers after conflict removal", async () => {
  const fixture = createFixture("local:test:index:root-owner" as WorkspaceId);
  const conflictingId = "local:test:index:root-owner-alias" as WorkspaceId;
  const service = createIndexService({ warmupDelayMs: 0 });
  try {
    fs.writeFileSync(path.join(fixture.root, "owner-target.ts"), "owner", "utf8");
    service.scheduleWarmup(new Map([
      [fixture.workspaceId, fixture.root],
      [conflictingId, fixture.root],
    ]));
    const first = service.search(fixture.workspaceId, fixture.root, "owner-target", { limit: 10 });
    const second = service.search(conflictingId, fixture.root, "owner-target", { limit: 10 });
    assert.equal(first.indexStatus, "failed");
    assert.equal(second.indexStatus, "failed");
    assert.match(first.message ?? "", /多个工作区/);
    assert.ok(first.results.some((item) => item.path === "owner-target.ts"));
    assert.throws(
      () => service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root, { requestId: "conflicted-rebuild" }),
      /冲突解除前不能重建文件索引/u,
    );

    service.syncWorkspaces(new Map([[fixture.workspaceId, fixture.root]]));
    const recovered = await waitForIndexed(service, fixture, "owner-target");
    assert.ok(recovered.results.some((item) => item.path === "owner-target.ts"));
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index rejects a reserved generation that becomes root-conflicted before start", async () => {
  const fixture = createFixture("local:test:index:reserved-root-conflict" as WorkspaceId);
  const conflictingId = "local:test:index:reserved-root-conflict-alias" as WorkspaceId;
  const workers: ControlledIndexWorker[] = [];
  const service = createIndexService({
    warmupDelayMs: 10_000,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  try {
    const reservation = service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root, { requestId: "reserve-before-conflict" });
    assert.equal(reservation.kind, "reserved");
    if (reservation.kind !== "reserved") return;
    service.syncWorkspaces(new Map([
      [fixture.workspaceId, fixture.root],
      [conflictingId, fixture.root],
    ]));
    assert.throws(
      () => service.startReservedWorkspaceRebuild(fixture.workspaceId, reservation.generation),
      /物理根冲突/u,
    );
    assert.equal(workers.length, 0);
    assert.equal(service.search(fixture.workspaceId, fixture.root, "anything").indexStatus, "failed");
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index reserves generation before starting worker", async () => {
  const fixture = createFixture();
  const workers: ControlledIndexWorker[] = [];
  const lifecycle: Array<{ type: string; generation: number }> = [];
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: (_workerPath, workerData) => {
      const worker = new ControlledIndexWorker(workerData, () => undefined);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  const unsubscribe = service.subscribeLifecycle((event) => {
    lifecycle.push({ type: event.type, generation: event.generation });
  });
  try {
    const reservation = service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root);
    assert.equal(reservation.kind, "reserved");
    assert.equal(workers.length, 0);
    if (reservation.kind !== "reserved") return;
    assert.equal(reservation.generation, 1);

    service.startReservedWorkspaceRebuild(fixture.workspaceId, reservation.generation);
    await waitForCondition(() => workers.length === 1, "预留 generation 未启动 worker");
    assert.equal(workers[0]?.data.generation, reservation.generation);
    assert.deepEqual(lifecycle, [{ type: "building", generation: reservation.generation }]);

    workers[0]?.complete();
    await waitForCondition(() => lifecycle.some((event) => event.type === "done"), "索引完成事件未发布");
    assert.deepEqual(lifecycle.at(-1), { type: "done", generation: reservation.generation });
  } finally {
    unsubscribe();
    await service.dispose();
    fixture.cleanup();
  }
});

test("workspace path index clears persistent build generation when worker startup fails", async () => {
  const fixture = createFixture("local:test:index:worker-start-failed" as WorkspaceId);
  const service = createIndexService({
    warmupDelayMs: 0,
    workerFactory: () => {
      throw new Error("worker factory failed");
    },
  });
  try {
    service.scheduleWarmup(new Map([[fixture.workspaceId, fixture.root]]));
    assert.throws(() => service.search(fixture.workspaceId, fixture.root, "anything"), /worker factory failed/);
  } finally {
    await service.dispose();
  }

  const db = openWorkspacePathIndexDb({
    workspaceId: fixture.workspaceId,
    workspacePath: fixture.root,
    settings: { configStamp: "test", excludeRulesStamp: "test", maxEntries: 300_000 },
  });
  try {
    const meta = db.getMeta();
    assert.equal(meta.buildGeneration, null);
    assert.equal(meta.status, "failed");
  } finally {
    db.close();
    fixture.cleanup();
  }
});

test("workspace path index disabled mode returns not_applicable without worker", async () => {
  const fixture = createFixture();
  let workerCount = 0;
  const service = createIndexService({
    enabled: false,
    workerFactory: () => {
      workerCount += 1;
      throw new Error("disabled index must not start worker");
    },
  });
  try {
    assert.deepEqual(service.reserveWorkspaceRebuild(fixture.workspaceId, fixture.root), { kind: "not_applicable" });
    const result = service.search(fixture.workspaceId, fixture.root, "missing");
    assert.equal(result.indexStatus, "disabled");
    assert.equal(workerCount, 0);
  } finally {
    await service.dispose();
    fixture.cleanup();
  }
});
