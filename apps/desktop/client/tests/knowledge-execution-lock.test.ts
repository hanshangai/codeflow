import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../src/knowledge/knowledgeGenerationService.js";
import { knowledgeHash, knowledgeJson } from "../src/knowledge/knowledgeAssetFiles.js";
import { openClientDb } from "../src/db/clientDb.js";

/** 真实临时项目，生成器只替换模型；读取端刻意没有原生成会话。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-execution-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  db.workspaces.upsert({ id: "owner" as any, title: "拥有者", path: root });
  db.workspaces.upsert({ id: "reader" as any, title: "读取者", path: root });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 2, instructions: "", nodes: ["a", "b"].map(id => ({
    id, parentId: null, title: id, orderKey: id, summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "generated",
  })) }, null);
  const owner = new KnowledgeGenerationService(store, "owner", async input => {
    const result = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
      content: `# ${input.title}`, summary: "test", sources: [{ kind: "requirement", requirement: "test", relation: "test" }],
    }, accessMode: "read-only" });
    assert.equal(result.ok, true, JSON.stringify(result));
  }, "owner-request", () => ({ nodeId: null, activationVersion: 1 }), db);
  const reader = new KnowledgeGenerationService(new KnowledgeAssetStore(root), "reader", async () => { throw new Error("不得调用模型"); }, "reader-request", () => { throw new Error("没有原会话"); }, db);
  const run = owner.begin({ requestId: "test-run", mode: "batch", ownerThreadId: "old-owner", selectedNodeIds: ["a", "b"],
    includeDescendants: false, strategy: "all", prompt: "", treeHash: store.readTree().hash, engine: "codex", concurrency: 1,
    reviewConfig: { enabled: false, model: null, effort: null } });
  return { root, store, owner, reader, run };
}

/** 带超时、退出失败检测的 IPC，保证子进程故障不会让回归永久等待。 */
async function worker(t: test.TestContext, root: string, runId: string) {
  const child = fork(fileURLToPath(new URL("./fixtures/knowledge-execution-worker.ts", import.meta.url)), [root, runId], {
    execArgv: ["--conditions=development", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], ...{ windowsHide: true },
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  let sequence = 0;
  const messages: Array<{ event?: string; id?: number; ok?: boolean; error?: string }> = [];
  child.on("message", message => messages.push(message as typeof messages[number]));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  });
  /** 从缓存匹配已到达的事件或命令响应，异常退出直接使测试失败。 */
  const receive = async (match: (value: typeof messages[number]) => boolean) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(match);
      if (index !== -1) return messages.splice(index, 1)[0]!;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`worker IPC timeout: ${stderr}`);
  };
  const event = (name: string) => receive(value => value.event === name);
  /** 所有辅助进程命令必须显式成功，不能吞掉子进程错误。 */
  const command = async (name: string) => {
    const id = ++sequence;
    child.send({ id, command: name });
    const reply = await receive(value => value.id === id);
    assert.equal(reply.ok, true, reply.error);
  };
  await event("reserved");
  return { child, command, event };
}

/** 轮询真实执行终态，超时必须失败。 */
async function settle(service: KnowledgeGenerationService, id: string) {
  const deadline = Date.now() + 8000;
  while (service.view(id).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.view(id).active, false);
  return service.view(id);
}

test("Windows 遗留 PID 变为系统进程时任务仍可列出，确认失效后能续跑", { skip: process.platform !== "win32" }, async t => {
  const { store, owner, reader, run } = fixture(t);
  const pid = 2_000_000_000;
  const execution = `.codeflowai/knowledge-cache/execution/run-${knowledgeHash(`${store.root}/${run.id}`)}.json`;
  const stale = knowledgeJson({ pid, token: "4b06a7c5-d400-4355-801b-31b62fb3235f" });
  store.files.write(execution, stale);
  store.saveRun({ ...store.readRun(run.id), phase: "generating" });
  const plan = `${store.root}/runs/${run.id}/plan.json`, before = store.files.read(plan);
  const kill = process.kill;
  t.mock.method(process, "kill", (target: number, signal?: string | number) => {
    if (target === pid) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  t.mock.method(childProcess, "execFileSync", () => `"HPAudioAnalytics.exe","${pid}","Services","0","12 K"\n`);
  const view = reader.list({ hydrateReviews: false }).find(item => item.id === run.id)!;
  assert.equal(view.active, false);
  assert.equal(view.phase, "interrupted");
  assert.equal(reader.view(run.id).active, false);
  assert.equal(store.files.read(execution).toString("utf8"), stale, "只读状态检查不清除占用文件");
  assert.deepEqual(store.files.read(plan), before, "只读列表不改写任务记录");
  // 模拟短写锁同样遗留，恢复与执行占用复用相同核验规则。
  store.files.write(".codeflowai/knowledge-cache/execution/write.lock", knowledgeJson({ pid }));
  owner.start(run.id);
  assert.equal((await settle(owner, run.id)).phase, "completed");
  assert.equal(store.isRunExecuting(run.id), false);
  assert.equal(store.files.exists(".codeflowai/knowledge-cache/execution/write.lock"), false);
});

test("Windows 存活的其他 Client 即使 EPERM 仍禁止抢占执行和短写锁", { skip: process.platform !== "win32" }, t => {
  const { store, owner, reader, run } = fixture(t);
  const pid = 2_000_000_000;
  const execution = `.codeflowai/knowledge-cache/execution/run-${knowledgeHash(`${store.root}/${run.id}`)}.json`;
  const stale = knowledgeJson({ pid, token: "4b06a7c5-d400-4355-801b-31b62fb3235f" });
  store.files.write(execution, stale);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  t.mock.method(childProcess, "execFileSync", () => `"${path.basename(process.execPath)}","${pid}","Console","1","12 K"\n`);
  assert.equal(reader.list({ hydrateReviews: false })[0]!.active, true);
  assert.throws(() => owner.start(run.id), /仍在执行/);
  assert.equal(store.files.read(execution).toString("utf8"), stale);
  const lock = ".codeflowai/knowledge-cache/execution/write.lock", locked = knowledgeJson({ pid });
  store.files.write(lock, locked);
  let called = false;
  assert.throws(() => store.files.mutate(() => { called = true; }), { code: "KNOWLEDGE_ASSET_LOCKED" });
  assert.equal(called, false);
  assert.equal(store.files.read(lock).toString("utf8"), locked);
});

test("探测未知错误保留任务和写锁并停止副作用，恢复后可继续读取", t => {
  const { store, reader, run } = fixture(t);
  const pid = 2_000_000_000;
  const execution = `.codeflowai/knowledge-cache/execution/run-${knowledgeHash(`${store.root}/${run.id}`)}.json`;
  const stale = knowledgeJson({ pid, token: "4b06a7c5-d400-4355-801b-31b62fb3235f" });
  store.files.write(execution, stale);
  const failure = Object.assign(new Error("probe IO failed"), { code: "EIO" });
  const probe = t.mock.method(process, "kill", () => { throw failure; });
  assert.throws(() => reader.list({ hydrateReviews: false }), error => error instanceof Error && error.message.includes(run.id) && error.message.includes(String(pid)) && error.cause === failure);
  assert.throws(() => store.claimRunExecution(run.id), error => error instanceof Error && error.cause === failure);
  assert.equal(store.files.read(execution).toString("utf8"), stale);
  const lock = ".codeflowai/knowledge-cache/execution/write.lock", locked = knowledgeJson({ pid });
  store.files.write(lock, locked);
  let called = false;
  assert.throws(() => store.files.mutate(() => { called = true; }), error => error === failure);
  assert.equal(called, false);
  assert.equal(store.files.read(lock).toString("utf8"), locked);
  probe.mock.restore();
  // 清理仅限测试夹具，确认依赖恢复后同一读取入口可用。
  fs.unlinkSync(store.files.resolve(execution)); fs.unlinkSync(store.files.resolve(lock));
  assert.equal(reader.list({ hydrateReviews: false })[0]!.active, false);
});

test("双进程共享执行状态，结束后无原会话也能处理，旧 worker 不覆盖拒绝及采用回执", async t => {
  const { root, store, owner, reader, run } = fixture(t);
  const remote = await worker(t, root, run.id);
  assert.equal(reader.view(run.id).active, true, "预留和恢复阶段也已占用");
  await remote.event("blocked");
  assert.equal(reader.view(run.id).phase, "generating");
  assert.equal(reader.list({ hydrateReviews: false })[0]!.active, true);
  const revisionId = store.readRun(run.id).items[0]!.revisionId!;
  assert.ok(revisionId, "第一项已交付，第二项仍在真实执行");
  assert.throws(() => owner.startAsync(run.id), /仍在执行/);
  assert.throws(() => owner.start(run.id), /仍在执行/);
  assert.throws(() => owner.stop(run.id), /仍在执行/);
  assert.throws(() => reader.apply(run.id), /仍在执行/);
  await assert.rejects(reader.dismiss(run.id, "a", revisionId, "reader"), /仍在执行/);
  assert.throws(() => reader.cancelAdoption(run.id, "request", "reader"), /仍在执行/);

  // 模拟预检完成后才出现执行占用，三个写入边界仍须在项目锁内复查。
  const view = reader.view.bind(reader);
  reader.view = id => ({ ...view(id), active: false });
  const preview = reader.preview(run.id);
  const input = { requestId: "adopt", treeHash: preview.treeHash, planHash: preview.planHash, selections: [{ nodeId: "a", revisionId }] };
  assert.throws(() => reader.apply(run.id, input), /仍在执行/);
  await assert.rejects(reader.dismiss(run.id, "a", revisionId, "reader"), /仍在执行/);
  assert.throws(() => reader.cancelAdoption(run.id, "request", "reader"), /仍在执行/);
  reader.view = view;

  await remote.command("finish");
  assert.equal(reader.view(run.id).active, false);
  await reader.dismiss(run.id, "a", revisionId, "reader");
  await remote.command("save-stale");
  assert.equal(store.readRun(run.id).dismissals?.length, 1);
  assert.equal(store.detail("a").drafts.length, 0);
  const remaining = reader.preview(run.id);
  reader.apply(run.id, { requestId: "adopt-b", treeHash: remaining.treeHash, planHash: remaining.planHash,
    selections: remaining.items.filter(item => item.canApply).map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) });
  const applied = store.readRun(run.id);
  await remote.command("save-stale");
  assert.deepEqual(store.readRun(run.id).adoptions, applied.adoptions);
  assert.equal(store.readRun(run.id).appliedTreeHash, applied.appliedTreeHash);
  assert.equal(reader.preview(run.id).items.find(item => item.nodeId === "b")?.applied, true);
});

test("生成进程退出后回收占用，另一 Client 可以续跑且保留已拒绝的交付", async t => {
  const { root, store, owner, reader, run } = fixture(t);
  const remote = await worker(t, root, run.id);
  await remote.event("blocked");
  const exit = once(remote.child, "exit"); remote.child.kill(); await exit;
  assert.equal(reader.view(run.id).active, false);
  assert.equal(reader.view(run.id).phase, "interrupted");
  await reader.dismiss(run.id, "a", store.readRun(run.id).items[0]!.revisionId, "reader");
  owner.start(run.id);
  assert.equal((await settle(owner, run.id)).phase, "completed");
  assert.equal(store.readRun(run.id).dismissals?.length, 1);
  assert.equal(store.isRunExecuting(run.id), false);
});

test("旧快照不能撤销终止采用或恢复已关闭候选", async t => {
  const { store, owner, reader, run } = fixture(t);
  owner.start(run.id); await settle(owner, run.id);
  const before = store.readRun(run.id);
  const preview = reader.preview(run.id);
  const write = store.files.write.bind(store.files);
  let fail = true;
  store.files.write = (relative, content) => {
    if (fail && relative.endsWith("/assets/b/current.json")) { fail = false; throw new Error("模拟磁盘失败"); }
    write(relative, content);
  };
  // 采用由 owner 的 Store 写入，读取和终止仍使用没有原会话的 reader。
  assert.throws(() => owner.apply(run.id, { requestId: "partial", treeHash: preview.treeHash, planHash: preview.planHash,
    selections: preview.items.map(({ nodeId, revisionId }) => ({ nodeId, revisionId })) }), /模拟磁盘失败/);
  const incomplete = store.readRun(run.id);
  reader.cancelAdoption(run.id, "partial", "reader");
  const cancelled = store.readRun(run.id);
  store.saveRun(before); store.saveRun(incomplete);
  assert.deepEqual(store.readRun(run.id).adoptions, cancelled.adoptions);
  assert.deepEqual(store.readRun(run.id).dismissals, cancelled.dismissals);
  assert.equal(reader.preview(run.id).items.find(item => item.nodeId === "b")?.dismissed, true);
});

test("启动失败、预留停止和无剩余项均释放执行占用", async t => {
  const { store, owner, run } = fixture(t);
  assert.throws(() => owner.startAsync(run.id, { nodeIds: [] }), /明确选择/);
  assert.equal(store.isRunExecuting(run.id), false);
  owner.startAsync(run.id); owner.stop(run.id);
  assert.equal(store.isRunExecuting(run.id), true, "停止响应不能提前释放后台预留");
  assert.throws(() => owner.startAsync(run.id), /正在停止/);
  await settle(owner, run.id);
  assert.equal(store.isRunExecuting(run.id), false);
  const revisions = store.revisions.bind(store);
  store.revisions = () => { throw new Error("模拟恢复失败"); };
  owner.startAsync(run.id);
  assert.equal((await settle(owner, run.id)).phase, "failed");
  assert.equal(store.isRunExecuting(run.id), false);
  store.revisions = revisions;
  owner.start(run.id); await settle(owner, run.id);
  assert.equal(owner.start(run.id).active, false, "没有剩余工作时启动响应不显示仍在执行");
  assert.equal(store.isRunExecuting(run.id), false, "无执行项的同步返回也要释放");
});
