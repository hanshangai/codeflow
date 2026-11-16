import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeAssetNode, WorkspaceId } from "@codeflowai/shared";
import { defaultCodeflowaiConfig, readExistingCodeflowaiConfig, writeCodeflowaiConfig } from "../src/codeflowai/codeflowaiConfig.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeChangeStore } from "../src/knowledge/knowledgeChangeStore.js";
import { KnowledgeReviewStore } from "../src/knowledge/knowledgeReviewStore.js";
import { KnowledgeGenerationService, hasActiveKnowledgeGeneration } from "../src/knowledge/knowledgeGenerationService.js";
import { KnowledgeUpdateService, hasActiveKnowledgeUpdate } from "../src/knowledge/knowledgeUpdateService.js";
import { executeKnowledgeAssetReadTool } from "../src/knowledge/knowledgeAssetTools.js";
import { openClientDb } from "../src/db/clientDb.js";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.js";

const workspaceId = "knowledge-directory-test" as WorkspaceId;
const node: KnowledgeAssetNode = { id: "feature", parentId: null, title: "功能", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] };

/** 使用与控制目录一致的物理根，确保故障注入命中真实文件操作。 */
function fixture(t: TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-directory-")));
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "目录测试", path: root });
  writeCodeflowaiConfig(root, defaultCodeflowaiConfig());
  const responses: Array<{ id: string; status: number; body: any }> = [];
  const ctx = {
    db, workspaces: new Map([[workspaceId, root]]), workspaceOperationGate: gate,
    workspaceMigrationActivityInspector: new WorkspaceMigrationActivityInspector({ db, gate }),
    send(response: any) { if (response.t === "api.res") responses.push(response); },
  } as unknown as ApiHandlerContext;
  let seq = 0;
  const request = async (method: string, body: Record<string, unknown>) => {
    const id = `directory-${++seq}`;
    await handleApiRequest(ctx, { t: "api.req", id, method, path: `/${method}`, body: { workspaceId, ...body } } as ApiRequestMessage);
    const response = responses.find(item => item.id === id);
    assert.ok(response, "API 必须明确返回成功或失败");
    return response;
  };
  const save = (directory: string) => request("codeflowai.config.set", { config: { ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: directory } } });
  const store = new KnowledgeAssetStore(root);
  const initialize = () => store.saveTree({ schemaVersion: 1, instructions: "", nodes: [node] }, null);
  return { root, db, gate, store, request, save, initialize };
}

test("新项目默认使用规格知识库，读取不建目录，首次保存才生成文件", t => {
  const f = fixture(t);
  assert.equal(f.store.root, "codeflow-docs/规格知识库");
  assert.equal(f.store.snapshot().initialized, false);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
  f.initialize();
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs/规格知识库/tree.json")), true);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs/知识库")), false);
});

test("已有知识库继续读写原目录，版本和身份保持不变且不创建新库", t => {
  const f = fixture(t);
  f.initialize();
  const revision = f.store.saveDocument({ nodeId: node.id, content: "已有正文", sources: [], expectedHash: null, origin: "manual" });
  const before = f.store.snapshot();
  fs.renameSync(path.join(f.root, f.store.root), path.join(f.root, "codeflow-docs/知识库"));
  const legacy = new KnowledgeAssetStore(f.root);
  assert.equal(legacy.root, "codeflow-docs/知识库");
  assert.equal(legacy.snapshot().knowledgeId, before.knowledgeId);
  assert.equal(legacy.detail(node.id).current!.revision.id, revision.id);
  const draft = legacy.saveDocument({ nodeId: node.id, content: "旧项目继续修订", sources: [], expectedHash: legacy.currentHash(node.id), origin: "ai" });
  assert.equal(legacy.readRevision(node.id, draft.id).content, "旧项目继续修订");
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs/规格知识库")), false);
});

test("新旧知识目录并存明确失败，不选择任一目录或创建额外文件", t => {
  const f = fixture(t);
  f.initialize();
  const treePath = path.join(f.root, f.store.root, "tree.json");
  const before = fs.readFileSync(treePath);
  fs.mkdirSync(path.join(f.root, "codeflow-docs/知识库"));
  assert.throws(() => new KnowledgeAssetStore(f.root), /规格知识库与旧知识库目录同时存在/);
  assert.deepEqual(fs.readFileSync(treePath), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "codeflow-docs/知识库")), []);
});

test("旧库在默认文档根而配置已改名时仍要求迁移，迁移后沿用旧库名", async t => {
  const f = fixture(t);
  f.initialize();
  const before = f.store.snapshot();
  fs.renameSync(path.join(f.root, f.store.root), path.join(f.root, "codeflow-docs/知识库"));
  fs.writeFileSync(path.join(f.root, "codeflowai/codeflowai.json"), JSON.stringify({ ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "customer-docs" } }), "utf8");
  assert.throws(() => new KnowledgeAssetStore(f.root), /保存目录设置以完成迁移/);
  assert.equal((await f.save("customer-docs")).status, 200);
  const legacy = new KnowledgeAssetStore(f.root);
  assert.equal(legacy.root, "customer-docs/知识库");
  assert.equal(legacy.snapshot().knowledgeId, before.knowledgeId);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
  assert.equal(fs.existsSync(path.join(f.root, "customer-docs/规格知识库")), false);
});

test("迁移完整文档根后才切换配置，知识身份、版本基线、搜索和关联记录保持可用", async t => {
  const f = fixture(t);
  f.initialize();
  f.store.files.write("source.ts", "export const enabled = true;\n");
  const sources = [{ kind: "code" as const, path: "source.ts", contentHash: f.store.readSource("source.ts").contentHash, startLine: 1, endLine: 1, relation: "直接实现" }];
  const revision = f.store.saveDocument({ nodeId: node.id, content: "# 功能说明", sources, expectedHash: null, origin: "manual" });
  const baseline = f.store.currentHash(node.id);
  const before = f.store.snapshot();
  assert.ok(f.store.search("功能").items.length);
  f.store.files.write("codeflow-docs/工作流/说明.md", "工作流文档");
  const changes = new KnowledgeChangeStore(f.store);
  const proposal = changes.submit({ nodeId: node.id, expectedHash: baseline, content: "# 新功能", summary: "补充", sources }, { threadId: "thread", turnId: "turn", origin: "chat" });
  const reviews = new KnowledgeReviewStore(f.store);
  const report = reviews.save(reviews.snapshot(node.id, revision.id), { runId: "review", engine: "codex", model: null, effort: null, outcome: "passed", summary: "已核对", issues: [], sources });
  const updates = new KnowledgeUpdateService(f.store, "client", workspaceId, f.db);
  updates.save({ enabled: false, cronExpr: "* * * * *", timezone: "UTC", selectedNodeIds: [node.id], includeDescendants: false, engine: "codex", model: null, effort: null, concurrency: 1, prompt: "", reviewConfig: { enabled: false, model: null, effort: null } }, null, workspaceId);
  const generation = new KnowledgeGenerationService(f.store, workspaceId, async () => {}, "request", () => ({ nodeId: null, activationVersion: 1 }), f.db);
  const runInput = { requestId: "migration-run", mode: "batch" as const, ownerThreadId: "owner", selectedNodeIds: [node.id], includeDescendants: false, strategy: "all" as const, prompt: "", treeHash: before.treeHash, engine: "codex" as const, reviewConfig: { enabled: false, model: null, effort: null } };
  const run = generation.begin(runInput);

  const response = await f.save("customer-docs");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "customer-docs/工作流/说明.md"), "utf8"), "工作流文档");
  const moved = new KnowledgeAssetStore(f.root);
  assert.equal(moved.root, "customer-docs/规格知识库");
  assert.equal(moved.snapshot().knowledgeId, before.knowledgeId);
  assert.equal(moved.currentHash(node.id), baseline);
  assert.match(moved.detail(node.id).current!.path, /^customer-docs\//);
  const searchPath = moved.search("功能").items[0]!.path;
  assert.ok(searchPath);
  assert.match(searchPath, /^customer-docs\//);
  const toolResult = executeKnowledgeAssetReadTool(moved, "knowledge.tree.read", {});
  assert.equal(toolResult.ok, true);
  assert.equal((toolResult.output as { root: string }).root, moved.root);
  assert.equal(new KnowledgeReviewStore(moved).list(node.id)[0]!.id, report.id);
  assert.equal(new KnowledgeReviewStore(moved).list(node.id)[0]!.stale, false);
  assert.equal(new KnowledgeUpdateService(moved, "client", workspaceId, f.db).schedule()!.selectedWorkspaceId, workspaceId);
  assert.equal(new KnowledgeGenerationService(moved, workspaceId, async () => {}, "request", () => ({ nodeId: null, activationVersion: 1 }), f.db).begin(runInput).id, run.id);
  const movedChanges = new KnowledgeChangeStore(moved);
  movedChanges.review({ id: proposal.id, expectedHash: proposal.hash, decision: "approve", note: "确认", userId: "owner" });
  assert.equal(moved.detail(node.id).current!.content, "# 新功能");
  assert.throws(() => moved.importFiles(moved.root), /不能从项目知识目录/);
  assert.ok(!moved.importFiles("customer-docs").directories.includes(moved.root));
  assert.equal(f.gate.getMigrationOperationId(workspaceId), null);
});

test("文档迁移兼容系统临时目录的 Windows 短路径别名", t => {
  const f = fixture(t);
  f.initialize();
  const before = f.store.snapshot();
  const alias = path.join(os.tmpdir(), path.basename(f.root));
  assert.equal(fs.realpathSync.native(alias), f.root);
  writeCodeflowaiConfig(alias, { ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "aliased-docs" } });
  const moved = new KnowledgeAssetStore(alias);
  assert.equal(moved.root, "aliased-docs/规格知识库");
  assert.equal(moved.snapshot().knowledgeId, before.knowledgeId);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
});

test("全新项目可使用自定义嵌套目录，不创建默认根", async t => {
  const f = fixture(t);
  assert.equal((await f.save("manual\\project")).status, 200);
  const custom = new KnowledgeAssetStore(f.root);
  assert.equal(custom.root, "manual/project/规格知识库");
  custom.saveTree({ schemaVersion: 1, instructions: "", nodes: [node] }, null);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
});

test("迁移目录失败不保存新配置且释放门禁，恢复后可重试", async t => {
  const f = fixture(t);
  f.initialize();
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(source) === path.join(f.root, "codeflow-docs")) throw new Error("injected directory lock");
    return rename(source, target);
  });
  const failed = await f.save("customer-docs");
  assert.equal(failed.status, 400);
  assert.match(failed.body.message, /injected directory lock/);
  assert.equal(readExistingCodeflowaiConfig(f.root)!.config.paths!.workflowDocsRoot, "codeflow-docs");
  assert.equal(new KnowledgeAssetStore(f.root).snapshot().initialized, true);
  assert.equal(f.gate.getMigrationOperationId(workspaceId), null);
  mock.mock.restore();
  assert.equal((await f.save("customer-docs")).status, 200);
});

test("配置原子替换失败恢复目录，原配置字节保持不变", async t => {
  const f = fixture(t);
  f.initialize();
  const configPath = path.join(f.root, "codeflowai/codeflowai.json");
  const original = fs.readFileSync(configPath);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === configPath) throw new Error("injected config lock");
    return rename(source, target);
  });
  const failed = await f.save("customer-docs");
  assert.equal(failed.status, 400);
  assert.match(failed.body.message, /injected config lock/);
  assert.deepEqual(fs.readFileSync(configPath), original);
  assert.equal(new KnowledgeAssetStore(f.root).snapshot().initialized, true);
  assert.equal(fs.existsSync(path.join(f.root, "customer-docs")), false);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["codeflowai.json"]);
});

test("目标已存在、路径嵌套和控制目录均拒绝迁移，不覆盖原文件", async t => {
  const f = fixture(t);
  f.initialize();
  fs.mkdirSync(path.join(f.root, "existing"));
  fs.writeFileSync(path.join(f.root, "existing/keep.txt"), "保留", "utf8");
  for (const directory of ["existing", "codeflow-docs/child", ".", "codeflowai/docs", "../outside"]) {
    assert.equal((await f.save(directory)).status, 400, directory);
    assert.equal(new KnowledgeAssetStore(f.root).snapshot().initialized, true);
  }
  assert.equal(fs.readFileSync(path.join(f.root, "existing/keep.txt"), "utf8"), "保留");
});

test("工作区活动和真实 started turn 阻止改名，其他配置仍可保存", async t => {
  const f = fixture(t);
  f.initialize();
  const release = f.gate.beginActivity(workspaceId, { type: "knowledge", resourceId: "active" });
  assert.equal((await f.save("customer-docs")).status, 409);
  assert.equal((await f.save("codeflow-docs")).status, 200);
  release();
  const thread = "running-thread" as any;
  const turn = "running-turn" as any;
  const scoped = f.db.forWorkspace(workspaceId);
  scoped.threads.create({ id: thread, workspaceId, title: "执行中", engine: "codex" });
  scoped.turns.insertStarted({ workspaceId, threadId: thread, engine: "codex", turnId: turn, startedAt: Date.now(), startEventSeq: 1 });
  assert.equal((await f.save("customer-docs")).status, 409);
  scoped.turns.setEnded(turn, { status: "completed", endedAt: Date.now(), endEventSeq: 2 });
  assert.equal((await f.save("customer-docs")).status, 200);
});

test("迁移先阻止新写，等短事务退出后再移动目录", async t => {
  const f = fixture(t);
  f.initialize();
  const release = f.gate.beginWrite(workspaceId);
  const saving = f.save("customer-docs");
  assert.ok(f.gate.getMigrationOperationId(workspaceId));
  assert.throws(() => f.gate.beginWrite(workspaceId), /正在迁移/);
  assert.equal(fs.existsSync(path.join(f.root, "customer-docs")), false);
  release();
  assert.equal((await saving).status, 200);
});

test("知识任务启动预留和运行期间均拒绝改名，停止收口后可迁移", async t => {
  const f = fixture(t);
  f.initialize();
  let finish!: () => void;
  const engine = new Promise<void>(resolve => { finish = resolve; });
  const generation = new KnowledgeGenerationService(f.store, workspaceId, async () => engine, "request", () => ({ nodeId: null, activationVersion: 1 }), f.db);
  const run = generation.begin({ requestId: "queued-run", mode: "batch", ownerThreadId: "owner", selectedNodeIds: [node.id], includeDescendants: false, strategy: "missing", prompt: "", treeHash: f.store.readTree().hash, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
  generation.startAsync(run.id);
  try {
    assert.equal(hasActiveKnowledgeGeneration(f.root), true);
    assert.equal((await f.save("customer-docs")).status, 409);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.save("customer-docs")).status, 409);
  } finally {
    generation.stop(run.id);
    finish();
    const deadline = Date.now() + 5000;
    while (hasActiveKnowledgeGeneration(f.root) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(hasActiveKnowledgeGeneration(f.root), false);
  assert.equal((await f.save("customer-docs")).status, 200);
});

test("定时检查尚未建立生成任务时仍阻止改名，检查结束后恢复", async t => {
  const f = fixture(t);
  f.initialize();
  f.store.saveDocument({ nodeId: node.id, content: "已确认的文档", sources: [], expectedHash: null, origin: "manual", instructions: "" });
  const updates = new KnowledgeUpdateService(f.store, "client", workspaceId, f.db);
  updates.save({ enabled: false, cronExpr: "* * * * *", timezone: "UTC", selectedNodeIds: [node.id], includeDescendants: false, engine: "codex", model: null, effort: null, concurrency: 1, prompt: "", reviewConfig: { enabled: false, model: null, effort: null } }, null, workspaceId);
  let finish!: () => void;
  const waiting = new Promise<Record<string, string>>(resolve => { finish = () => resolve({}); });
  t.mock.method(f.store, "scanMaintenanceFiles", () => waiting);
  const generation = new KnowledgeGenerationService(f.store, workspaceId, async () => {}, "request", () => ({ nodeId: null, activationVersion: 1 }), f.db);
  updates.start({ requestId: "checking", generation, createOwner: () => "owner" });
  assert.equal(hasActiveKnowledgeUpdate(f.root), true);
  assert.equal((await f.save("customer-docs")).status, 409);
  finish();
  const deadline = Date.now() + 5000;
  while (hasActiveKnowledgeUpdate(f.root) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(hasActiveKnowledgeUpdate(f.root), false);
  assert.equal((await f.save("customer-docs")).status, 200);
});

test("配置已改名但旧知识仍在默认目录时显式要求迁移，保存后恢复读取", async t => {
  const f = fixture(t);
  f.initialize();
  fs.writeFileSync(path.join(f.root, "codeflowai/codeflowai.json"), JSON.stringify({ ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "customer-docs" } }), "utf8");
  assert.throws(() => new KnowledgeAssetStore(f.root), /保存目录设置以完成迁移/);
  assert.equal(fs.existsSync(path.join(f.root, "customer-docs")), false);
  assert.equal((await f.save("customer-docs")).status, 200);
  assert.equal(new KnowledgeAssetStore(f.root).snapshot().initialized, true);
});

test("API 复用的知识 Store 在目录改名后失效，不继续返回旧路径", async t => {
  const f = fixture(t);
  f.initialize();
  const actorContext = { userId: "owner", accountRole: "personal_normal", enterpriseId: null, requestId: "cache-root", permissionScope: "account" };
  const first = await f.request("knowledge.assets.snapshot", { actorContext });
  assert.equal(first.body.data.root, "codeflow-docs/规格知识库");
  assert.equal((await f.save("customer-docs")).status, 200);
  const second = await f.request("knowledge.assets.snapshot", { actorContext });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.root, "customer-docs/规格知识库");
  assert.equal(second.body.data.initialized, true);
  assert.equal(second.body.data.knowledgeId, first.body.data.knowledgeId);
});

test("配置切换和目录恢复同时失败时保留迁移记录，阻止空库写入且可重试恢复", async t => {
  const f = fixture(t);
  f.initialize();
  const id = f.store.snapshot().knowledgeId;
  const from = path.join(f.root, "codeflow-docs"), to = path.join(f.root, "customer-docs");
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === path.join(f.root, "codeflowai/codeflowai.json")) throw new Error("injected config lock");
    if (String(source) === to && String(target) === from) throw new Error("injected rollback lock");
    return rename(source, target);
  });
  const failed = await f.save("customer-docs");
  assert.equal(failed.status, 400);
  assert.match(failed.body.message, /目录恢复失败/);
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.existsSync(path.join(to, "规格知识库/tree.json")), true);
  assert.throws(() => new KnowledgeAssetStore(f.root), /迁移尚未完成/);
  assert.equal(fs.existsSync(from), false, "不能因读取知识库而创建第二套空目录");
  mock.mock.restore();
  assert.equal((await f.save("customer-docs")).status, 200);
  assert.equal(new KnowledgeAssetStore(f.root).snapshot().knowledgeId, id);
  assert.equal(fs.existsSync(path.join(f.root, "codeflowai/docs-root-migration.json")), false);
});

for (const committed of [false, true]) {
  test(`迁移${committed ? "已切换配置" : "尚未切换配置"}时异常退出，重新保存可恢复`, async t => {
    const f = fixture(t);
    f.initialize();
    const id = f.store.snapshot().knowledgeId;
    const from = path.join(f.root, "codeflow-docs"), to = path.join(f.root, "customer-docs");
    fs.writeFileSync(path.join(f.root, "codeflowai/docs-root-migration.json"), JSON.stringify({ from, to }), "utf8");
    fs.renameSync(from, to);
    if (committed) fs.writeFileSync(path.join(f.root, "codeflowai/codeflowai.json"), JSON.stringify({ ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "customer-docs" } }), "utf8");
    assert.throws(() => new KnowledgeAssetStore(f.root), /迁移尚未完成/);
    assert.equal((await f.save("customer-docs")).status, 200);
    assert.equal(new KnowledgeAssetStore(f.root).snapshot().knowledgeId, id);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.existsSync(path.join(f.root, "codeflowai/docs-root-migration.json")), false);
  });
}

test("迁移拒绝目录链中的符号链接，配置和知识均保持原状", async t => {
  const f = fixture(t);
  f.initialize();
  fs.mkdirSync(path.join(f.root, "actual"));
  fs.symlinkSync(path.join(f.root, "actual"), path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const response = await f.save("alias/docs");
  assert.equal(response.status, 400);
  assert.match(response.body.message, /符号链接/);
  assert.equal(new KnowledgeAssetStore(f.root).snapshot().initialized, true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "actual")), []);
});

test("工作区通过目录别名访问时仍按真实根迁移", t => {
  const f = fixture(t);
  f.initialize();
  const alias = path.join(f.root, "workspace-alias");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  writeCodeflowaiConfig(alias, { ...defaultCodeflowaiConfig(), paths: { workflowDocsRoot: "customer-docs" } });
  assert.equal(new KnowledgeAssetStore(alias).snapshot().initialized, true);
  assert.equal(fs.existsSync(path.join(f.root, "codeflow-docs")), false);
});
