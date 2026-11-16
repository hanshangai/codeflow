import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import type { WorkspaceId } from "@codeflowai/shared";
import { searchPaths } from "../src/fs/fsService.js";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.js";
import { openWorkspacePathIndexDb } from "../src/fs/workspacePathIndexDb.js";
import { handleFsSearch } from "../src/app/handlers/fsHandlers.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { logger, type WorkspaceLogEntry } from "../src/logger.js";

/** 每例使用独立真实目录、SQLite 与目录链接，不接用户工作区。 */
function fixture(t: test.TestContext, privateName = ".codeflowai") {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cf-private-index-"));
  const root = path.join(base, "workspace");
  const privateRoot = path.join(root, privateName);
  fs.mkdirSync(privateRoot, { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(privateRoot, "secret.txt"), "PRIVATE_RUNTIME_BYTES", "utf8");
  fs.writeFileSync(path.join(root, "src", "visible.txt"), "public", "utf8");
  const services: WorkspacePathIndexService[] = [];
  t.after(async () => { for (const service of services) await service.dispose(); fs.rmSync(base, { recursive: true }); });
  return { base, root, privateRoot, workspaceId: "local:private:index" as WorkspaceId,
    /** 沿原 service 生命周期登记清理，不另开产品连接。 */
    service(options: Omit<ConstructorParameters<typeof WorkspacePathIndexService>[0], "writeWorkspaceLog"> = {}) {
      const service = new WorkspacePathIndexService({ warmupDelayMs: 0, ...options,
        writeWorkspaceLog: (_workspaceId, entry) => logger[entry.level](entry.tag, entry.message, entry.data) });
      services.push(service); return service;
    },
  };
}

/** Windows 使用无需符号链接权限的真实 junction，其他平台使用目录 symlink。 */
function link(target: string, alias: string): void {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}

/** 等待真实 Worker 发布；不以 failed/stale 充当成功构建。 */
async function ready(f: ReturnType<typeof fixture>, service: WorkspacePathIndexService, root = f.root): Promise<void> {
  service.scheduleWarmup(new Map([[f.workspaceId, root]]));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = service.search(f.workspaceId, root, "visible", { includeHidden: true });
    assert.notEqual(page.indexStatus, "failed", page.message ?? "");
    if (page.indexStatus === "ready") { assert.equal(page.results[0]?.path, "src/visible.txt"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("真实索引未在预算内 ready");
}

/** 未启动真实扫描的 Worker 只用于固定旧代际和构建中查询窗口。 */
class WaitingWorker extends EventEmitter {
  /** 复用原 terminate 完成语义释放 service 并发位。 */
  terminate(): Promise<number> { this.emit("exit", 0); return Promise.resolve(0); }
}

for (const query of ["secret", "public-cache/", ".codeflowai/", ""] as const) {
  test(`实时搜索在分页前排除私有真实目标：${query || "根目录"}`, t => {
    const f = fixture(t); link(f.privateRoot, path.join(f.root, "public-cache"));
    const page = searchPaths(f.root, query, { includeHidden: true, limit: 1 });
    assert.equal(page.results.some(item => item.path.startsWith("public-cache") || item.path.startsWith(".codeflowai")), false);
    if (query !== "") assert.deepEqual(page, { results: [], hasMore: false, nextCursor: null });
  });
}

test("真实 Worker 在根 junction 下排除大小写私有根及公开 alias", async t => {
  const f = fixture(t, ".CoDeFlOw");
  link(f.privateRoot, path.join(f.root, "public-cache"));
  const rootAlias = path.join(f.base, "root-alias"); link(f.root, rootAlias);
  const service = f.service(); await ready(f, service, rootAlias);
  assert.deepEqual(service.search(f.workspaceId, rootAlias, "public-cache", { includeHidden: true }).results, []);
  assert.deepEqual(service.search(f.workspaceId, rootAlias, ".CoDeFlOw/", { includeHidden: true }).results, []);
});

test("私有根自身为 junction 时实时隔离且启用索引明确拒绝，不影响正常工作区", async t => {
  const f = fixture(t);
  const physical = path.join(f.base, "private-physical"); fs.renameSync(f.privateRoot, physical);
  link(physical, f.privateRoot); link(physical, path.join(f.root, "public-cache"));
  assert.deepEqual(searchPaths(f.root, "secret", { includeHidden: true }).results, []);
  const service = f.service();
  for (let attempt = 0; attempt < 2; attempt += 1) assert.throws(() => service.search(f.workspaceId, f.root, "secret", { includeHidden: true }), error => ["WORKSPACE_FILE_INDEX_PATH_UNSAFE", "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE"].includes((error as { code: string }).code));
  assert.deepEqual(fs.readdirSync(physical), ["secret.txt"]);
  assert.equal(fs.readFileSync(path.join(physical, "secret.txt"), "utf8"), "PRIVATE_RUNTIME_BYTES");
  const disabled = f.service({ enabled: false });
  assert.throws(() => disabled.search(f.workspaceId, f.root, "secret", { includeHidden: true }), error => (error as { code: string }).code === "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
  const healthy = fixture(t);
  await ready({ ...healthy, workspaceId: "local:private:healthy" as WorkspaceId }, service);
});

for (const mode of ["disabled", "failed", "building"] as const) test(`实时回退保持私有隔离：${mode}`, t => {
  const f = fixture(t);
  if (mode === "failed") {
    fs.rmSync(f.privateRoot, { recursive: true });
    fs.writeFileSync(f.privateRoot, "not-directory", "utf8");
  } else link(f.privateRoot, path.join(f.root, "public-cache"));
  const service = f.service({ enabled: mode !== "disabled", workerFactory: () => new WaitingWorker() as unknown as Worker });
  if (mode === "failed") {
    assert.throws(() => service.search(f.workspaceId, f.root, "secret", { includeHidden: true }), /codeflowai.*普通目录/u);
    return;
  }
  const page = service.search(f.workspaceId, f.root, "secret", { includeHidden: true });
  assert.deepEqual(page.results, []);
  assert.equal(page.indexStatus, mode);
});

test("仅 policy 过期的现存 generation 不复用，alias 保留在旧代但不被搜索", async t => {
  const f = fixture(t), alias = path.join(f.root, "public-cache"); link(path.join(f.root, "src"), alias);
  const first = f.service(); await ready(f, first); first.dispose();
  const raw = new DatabaseSync(path.join(f.root, ".codeflowai", "file-index.db"));
  let settings;
  try {
    const row = raw.prepare("SELECT active_config_stamp AS configStamp, active_exclude_rules_stamp AS excludeRulesStamp, max_entries AS maxEntries FROM file_index_meta").get()!;
    settings = { configStamp: String(row.configStamp), excludeRulesStamp: String(row.excludeRulesStamp), maxEntries: Number(row.maxEntries), policyStamp: "workspace-path-index-policy-v1" };
  } finally { raw.close(); }
  const db = openWorkspacePathIndexDb({ workspaceId: f.workspaceId, workspacePath: f.root, settings });
  try {
    const generation = db.reserveBuild(settings, "legacy");
    db.writeBuildEntries(generation, [{ path: "public-cache/secret.txt", name: "secret.txt", isDir: false, hidden: false, parentEntryOrder: 0 }]);
    db.publishBuild(generation, false);
  } finally { db.close(); }
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  const service = f.service({ workerFactory: () => new WaitingWorker() as unknown as Worker });
  assert.deepEqual(service.search(f.workspaceId, f.root, "secret", { includeHidden: true }).results, []);
  const retained = new DatabaseSync(path.join(f.root, ".codeflowai", "file-index.db"), { readOnly: true });
  try { assert.equal(retained.prepare("SELECT count(*) AS count FROM file_index_entries WHERE path = 'public-cache/secret.txt'").get()?.count, 1); }
  finally { retained.close(); }
});

for (const query of ["public-alias", "public-alias/no-match"] as const) test(`ready alias 重指私有根后整次查询明确失败：${query}`, async t => {
  const f = fixture(t), alias = path.join(f.root, "public-alias"); link(path.join(f.root, "src"), alias);
  const service = f.service(); await ready(f, service);
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  assert.throws(() => service.search(f.workspaceId, f.root, query, { includeHidden: true }), error => {
    assert.equal((error as { code: string }).code, "INTERNAL_ERROR"); return true;
  });
  assert.equal(service.search(f.workspaceId, f.root, "visible").results[0]?.path, "src/visible.txt");
});

for (const type of ["upsert", "delete"] as const) test(`后代 ${type} 事件清除缺失叶路径的整个私有 alias 索引`, async t => {
  const f = fixture(t), alias = path.join(f.root, "public-alias"); link(path.join(f.root, "src"), alias);
  fs.writeFileSync(path.join(f.root, "src", "sibling.txt"), "public", "utf8");
  const service = f.service(); await ready(f, service);
  service.applyChanges(f.workspaceId, f.root, [
    { type: "upsert", path: "public-alias/visible.txt" }, { type: "upsert", path: "public-alias/sibling.txt" },
  ]);
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  service.applyChanges(f.workspaceId, f.root, [{ type, path: "public-alias/visible.txt" }]);
  assert.deepEqual(service.search(f.workspaceId, f.root, "public-alias", { includeHidden: true }).results, []);
  assert.equal(service.search(f.workspaceId, f.root, "visible").results[0]?.path, "src/visible.txt");
});

test("原 fs.search 边界只记录一次 ready 私有目标失败并保留上下文", async t => {
  const f = fixture(t), alias = path.join(f.root, "public-alias"); link(path.join(f.root, "src"), alias);
  const service = f.service(); await ready(f, service);
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  const errors: Array<Record<string, unknown>> = [], sent: Array<{ status: number; body: { ok: boolean; code?: string } }> = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  const ctx = { clientId: "private-index-client", workspaces: new Map([[f.workspaceId, f.root]]), workspacePathIndex: service,
    db: { writeWorkspaceLog: (_id: WorkspaceId, entry: WorkspaceLogEntry) => logger[entry.level](entry.tag, entry.message, entry.data) },
    send: (message: typeof sent[number]) => { sent.push(message); } } as unknown as ApiHandlerContext;
  const req = { t: "api.req", id: "private-index-request", method: "fs.search", body: { workspaceId: f.workspaceId, query: "public-alias" } } as ApiRequestMessage;
  handleFsSearch(ctx, req);
  assert.equal(sent.length, 1); assert.equal(sent[0]?.status, 500); assert.equal(sent[0]?.body.ok, false);
  assert.equal(sent[0]?.body.code, "INTERNAL_ERROR");
  assert.equal(errors.length, 1); assert.equal(errors[0]?.requestId, req.id); assert.equal(errors[0]?.workspaceId, f.workspaceId);
  assert.equal(errors[0]?.path, "public-alias"); assert.equal(typeof errors[0]?.generation, "number");
  assert.equal(errors[0]?.code, "WORKSPACE_FILE_INDEX_PRIVATE_TARGET");
  assert.equal(JSON.stringify(errors).includes("PRIVATE_RUNTIME_BYTES"), false);
});

test("合法内部链接和相近名字维持原行为，私有目录缺失不阻断搜索", async t => {
  const f = fixture(t); fs.rmSync(f.privateRoot, { recursive: true });
  for (const name of ["codeflow-docs", ".codeflow-docs", ".codeflowaix"]) {
    const target = path.join(f.root, name); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "normal.txt"), "public", "utf8");
    link(target, path.join(f.root, `public-${name.startsWith(".") ? "dot-" : ""}${name.replace(/^\./u, "")}`));
  }
  const page = searchPaths(f.root, "normal", { includeHidden: true });
  assert.equal(page.results.length, 3);
  assert.equal(page.results.some(item => item.path === "public-dot-codeflowaix/normal.txt"), true);
  const service = f.service(); await ready(f, service);
  service.applyChanges(f.workspaceId, f.root, [{ type: "upsert", path: "public-dot-codeflowaix/normal.txt" }]);
  assert.equal(service.search(f.workspaceId, f.root, "public-dot-codeflowaix/").results[0]?.path, "public-dot-codeflowaix/normal.txt");
});

for (const systemCode of ["EACCES", "EIO"] as const) test(`私有根身份检查失败不能返回成功搜索：${systemCode}`, t => {
  const f = fixture(t), original = fs.realpathSync.native.bind(fs.realpathSync);
  t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === f.privateRoot) throw Object.assign(new Error("UNSAFE_ERROR_BODY"), { code: systemCode });
    return original(target, options as never);
  }) as typeof fs.realpathSync.native);
  assert.throws(() => searchPaths(f.root, "visible"), error => {
    assert.equal((error as { code: string }).code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(error).includes("UNSAFE_ERROR_BODY"), false); return true;
  });
});

test("悬空目录链接明确失败，普通已删除索引项仍显示原 partial", async t => {
  const f = fixture(t), service = f.service(); await ready(f, service);
  fs.unlinkSync(path.join(f.root, "src", "visible.txt"));
  const missing = service.search(f.workspaceId, f.root, "visible");
  assert.equal(missing.partial, true); assert.equal(missing.results[0]?.path, "src/visible.txt");
  link(path.join(f.base, "missing-target"), path.join(f.root, "broken-alias"));
  assert.throws(() => searchPaths(f.root, "broken"), error => {
    assert.equal((error as { code: string }).code, "INTERNAL_ERROR"); return true;
  });
});

test("已排除或重建清除的私有 alias 目录补全返回空页", async t => {
  const f = fixture(t), alias = path.join(f.root, "public-alias"); link(path.join(f.root, "src"), alias);
  const service = f.service(); await ready(f, service);
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  assert.throws(() => service.search(f.workspaceId, f.root, "public-alias/no-match"));
  service.rebuildWorkspace(f.workspaceId, f.root); await ready(f, service);
  assert.deepEqual(service.search(f.workspaceId, f.root, "public-alias/no-match").results, []);
  assert.deepEqual(service.search(f.workspaceId, f.root, "public-alias/").results, []);
});

for (const operation of ["realpath", "stat"] as const) test(`ready 候选 ${operation} 失败不进入 fallback，故障解除后同索引可用`, async t => {
  const f = fixture(t), service = f.service(); await ready(f, service);
  const candidate = path.join(f.root, "src", "visible.txt");
  const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);
  const originalStat = fs.statSync.bind(fs);
  const fail = () => { throw Object.assign(new Error("PRIVATE_ERROR_BODY"), { code: "EIO" }); };
  const mocked = operation === "realpath"
    ? t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, options?: unknown) => path.resolve(String(target)) === candidate ? fail() : originalRealpath(target, options as never)) as typeof fs.realpathSync.native)
    : t.mock.method(fs, "statSync", ((target: fs.PathLike, options?: unknown) => path.resolve(String(target)) === candidate ? fail() : originalStat(target, options as never)) as typeof fs.statSync);
  assert.throws(() => service.search(f.workspaceId, f.root, "visible"), error => {
    assert.equal((error as { code: string }).code, "INTERNAL_ERROR");
    assert.equal((error as { generation: number }).generation > 0, true);
    assert.equal((error as Error).message.includes("PRIVATE_ERROR_BODY"), false); return true;
  });
  mocked.mock.restore();
  const page = service.search(f.workspaceId, f.root, "visible");
  assert.equal(page.indexStatus, "ready"); assert.equal(page.results[0]?.path, "src/visible.txt");
});

test("原API实时搜索的身份失败单次安全日志且恢复后正常响应", t => {
  const f = fixture(t), errors: Array<Record<string, unknown>> = [], sent: Array<{ status: number; body: { ok: boolean } }> = [];
  const original = fs.realpathSync.native.bind(fs.realpathSync);
  const mocked = t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === f.privateRoot) throw Object.assign(new Error("PRIVATE_ERROR_BODY"), { code: "EACCES" });
    return original(target, options as never);
  }) as typeof fs.realpathSync.native);
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  const ctx = { clientId: "private-index-client", workspaces: new Map([[f.workspaceId, f.root]]),
    db: { writeWorkspaceLog: (_id: WorkspaceId, entry: WorkspaceLogEntry) => logger[entry.level](entry.tag, entry.message, entry.data) },
    send: (message: typeof sent[number]) => { sent.push(message); } } as unknown as ApiHandlerContext;
  const req = { t: "api.req", id: "private-index-io", method: "fs.search", body: { workspaceId: f.workspaceId, query: "visible" } } as ApiRequestMessage;
  handleFsSearch(ctx, req);
  assert.equal(sent[0]?.status, 500); assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED");
  assert.equal(errors[0]?.systemCode, "EACCES"); assert.equal(errors[0]?.path, ".codeflowai");
  assert.equal(errors[0]?.requestId, req.id); assert.equal(errors[0]?.workspaceId, f.workspaceId);
  assert.equal(JSON.stringify([...sent, ...errors]).includes("PRIVATE_ERROR_BODY"), false);
  mocked.mock.restore(); handleFsSearch(ctx, { ...req, id: "private-index-restored" });
  assert.equal(sent[1]?.status, 200); assert.equal(sent[1]?.body.ok, true);
});

test("增量路径检查失败由原owner记录安全原因及路径，重建后恢复", async t => {
  const f = fixture(t), service = f.service(); await ready(f, service);
  const errors: Array<Record<string, unknown>> = [], original = fs.realpathSync.native.bind(fs.realpathSync);
  const mocked = t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.join(f.root, "src", "visible.txt")) throw Object.assign(new Error("PRIVATE_ERROR_BODY"), { code: "EIO" });
    return original(target, options as never);
  }) as typeof fs.realpathSync.native);
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  assert.throws(() => service.applyChanges(f.workspaceId, f.root, [{ type: "upsert", path: "src/visible.txt" }], { requestId: "private-incremental-io" }));
  assert.equal(errors.length, 1); assert.equal(errors[0]?.requestId, "private-incremental-io");
  assert.equal(errors[0]?.workspaceId, f.workspaceId); assert.equal(typeof errors[0]?.generation, "number");
  assert.equal(errors[0]?.path, "src/visible.txt"); assert.equal(errors[0]?.systemCode, "EIO");
  assert.equal(errors[0]?.diagnosticCode, "WORKSPACE_FILE_INDEX_PATH_CHECK_FAILED");
  assert.equal(JSON.stringify(errors).includes("PRIVATE_ERROR_BODY"), false);
  mocked.mock.restore(); service.rebuildWorkspace(f.workspaceId, f.root); await ready(f, service);
});

for (const aliasName of [" public-alias", "public-alias ", " public-alias "] as const) {
  test(`真实空格 alias 在实时搜索、目录补全与Worker均排除：${JSON.stringify(aliasName)}`, async t => {
    const f = fixture(t), alias = path.join(f.root, aliasName);
    link(f.privateRoot, process.platform === "win32" ? path.toNamespacedPath(alias) : alias);
    assert.equal(fs.readdirSync(f.root).includes(aliasName), true, "真实链接名必须保留空格");
    for (const query of ["secret", `${aliasName}/`, ""]) {
      const page = searchPaths(f.root, query, { includeHidden: true });
      assert.equal(page.results.some(item => item.path.startsWith(aliasName)), false);
      if (query !== "") assert.deepEqual(page.results, []);
    }
    const service = f.service(); await ready(f, service);
    assert.deepEqual(service.search(f.workspaceId, f.root, "public-alias", { includeHidden: true }).results, []);
  });
}

for (const name of [" public-alias", "public-alias ", " public-alias "] as const) for (const type of ["upsert", "delete"] as const) {
test(`合法空格路径保真及重指后代 ${type} 清理：${JSON.stringify(name)}`, async t => {
  const f = fixture(t), alias = path.toNamespacedPath(path.join(f.root, name));
  link(path.join(f.root, "src"), alias);
  const service = f.service(); await ready(f, service);
  const rootPage = service.search(f.workspaceId, f.root, "public-alias", { includeHidden: true });
  assert.deepEqual(rootPage.results.map(item => ({ path: item.path, name: item.name })), [{ path: name, name }]);
  service.applyChanges(f.workspaceId, f.root, [{ type: "upsert", path: `${name}/visible.txt` }]);
  const child = service.search(f.workspaceId, f.root, `${name}/`).results[0];
  assert.equal(child?.path, `${name}/visible.txt`);
  fs.unlinkSync(alias); link(f.privateRoot, alias);
  assert.throws(() => service.search(f.workspaceId, f.root, "public-alias"));
  service.applyChanges(f.workspaceId, f.root, [{ type, path: `${name}/visible.txt` }]);
  assert.deepEqual(service.search(f.workspaceId, f.root, "public-alias").results, []);
});
}

test("实时搜索递归合法尾空格目录时使用真实名称", t => {
  const f = fixture(t), directory = path.toNamespacedPath(path.join(f.root, "public-dir "));
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "nested.txt"), "public", "utf8");
  assert.equal(searchPaths(f.root, "nested").results[0]?.path, "public-dir /nested.txt");
});

test("合法尾空格和全空格文件名不被改写或与普通文件碰撞", async t => {
  const f = fixture(t);
  for (const name of ["note", "note ", " "]) fs.writeFileSync(path.toNamespacedPath(path.join(f.root, name)), name, "utf8");
  const service = f.service(); await ready(f, service);
  const rows = service.search(f.workspaceId, f.root, "", { includeHidden: true, limit: 100 }).results;
  for (const name of ["note", "note ", " "]) assert.ok(rows.some(item => item.path === name && item.name === name), `缺少真实文件名 ${JSON.stringify(name)}`);
  assert.deepEqual(service.search(f.workspaceId, f.root, "   ", { includeHidden: true, limit: 100 }).results, rows);
  assert.equal(service.search(f.workspaceId, f.root, "  visible  ").results[0]?.path, "src/visible.txt");
});
