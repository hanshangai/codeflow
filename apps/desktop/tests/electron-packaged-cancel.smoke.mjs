import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";

const [input, output, mode = "instance", ...extra] = process.argv.slice(2);
if (!input || !output || extra.length || !["instance", "node"].includes(mode)) {
  throw new Error("用法：electron-packaged-cancel.smoke.mjs <exe> <不存在的仓库外报告目录> [instance|node]");
}
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(output);
const report = { requestId: randomUUID(), status: "running", phase: "preflight", root, runs: [],
  mode, scope: mode === "node" ? "windows_packaged_controlled_provider_node_stop" : "windows_packaged_controlled_provider_instance_cancel",
  paidProviderExercised: false };
const observedPids = new Set(), providerPids = new Set();
let application, child, page, env, providerPrepared = false;
const title = "在途流程取消验收";
const providerPath = path.join(root, "provider"), project = path.join(root, "project");
const { _electron: electron, expect: baseExpect } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
const expect = baseExpect.configure({ timeout: 30_000 });

/** 真实输入及输出父目录均须在仓库外，已有输出不可覆盖。 */
function outsideRepository(target) {
  const relative = path.relative(repository, target);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_CANCEL_OUTSIDE_REPOSITORY_REQUIRED");
}
outsideRepository(root);
const actualRoot = path.join(await bounded(fs.realpath(path.dirname(root)), 5_000, "DESKTOP_CANCEL_OUTPUT_PATH_TIMEOUT"), path.basename(root));
outsideRepository(actualRoot);
const executable = await bounded(fs.realpath(path.resolve(input)), 5_000, "DESKTOP_CANCEL_EXE_TIMEOUT");
outsideRepository(executable);
assertDisjoint(path.dirname(executable), actualRoot);
await bounded(fs.mkdir(root), 5_000, "DESKTOP_CANCEL_OUTPUT_MKDIR_TIMEOUT");
const reportPath = path.join(root, "verification.json");

/** 输出和输入工件目录双向隔离，在创建任何目录前拒绝覆盖风险。 */
function assertDisjoint(artifact, evidence) {
  const outside = (parent, target) => {
    const relative = path.relative(parent, target);
    return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  assert.ok(outside(artifact, evidence) && outside(evidence, artifact), "DESKTOP_CANCEL_ARTIFACT_OUTPUT_OVERLAP");
}

/** 每项外部操作独立限时，超时不能冒充产品取消成功。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** predicate 本身也受剩余预算约束，原拒绝直接传播。 */
async function waitUntil(predicate, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(predicate), Math.max(1, deadline - Date.now()), code)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

/** 报告保留原始错误、错误码及全部 cause/聚合清理上下文。 */
function failure(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack,
    ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}) };
}

/** 只有 ESRCH 证明退出，其他查询失败保留为未知。 */
function processState(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "DESKTOP_CANCEL_PID_REQUIRED");
  try { process.kill(pid, 0); return { pid, state: "alive" }; }
  catch (error) { return error.code === "ESRCH" ? { pid, state: "absent" } : { pid, state: "unknown", error: failure(error) }; }
}

/** PATH 仅允许受控 provider 和 Windows；配置、凭据、缓存和数据全隔离。 */
async function isolatedEnvironment() {
  const allowed = /^(?:pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const systemRoot = result.SystemRoot ?? result.SYSTEMROOT;
  assert.ok(systemRoot, "DESKTOP_CANCEL_SYSTEM_ROOT_REQUIRED");
  result.PATH = [providerPath, path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "TMPDIR"]) {
    result[key] = path.join(root, key.toLowerCase());
    await bounded(fs.mkdir(result[key]), 5_000, "DESKTOP_CANCEL_ISOLATION_TIMEOUT");
  }
  result.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return result;
}

/** 工件前后四项指纹一致，不构建或改写输入。 */
async function artifactHashes(executable) {
  const resources = path.join(path.dirname(executable), "resources");
  const entries = { exe: executable, asar: path.join(resources, "app.asar"),
    client: path.join(resources, "client/dist/index.cjs"), web: path.join(resources, "web/index.html") };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([key, filename]) =>
    [key, createHash("sha256").update(await bounded(fs.readFile(filename), 30_000, "DESKTOP_CANCEL_HASH_READ_TIMEOUT")).digest("hex")])));
}

/** 只走原受限桥；HTTP 或正文失败立即停止后续业务副作用。 */
async function request(method, body = {}) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, body }),
    35_000, `DESKTOP_CANCEL_REQUEST_TIMEOUT: ${method}`);
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(response)}`);
  assert.equal(response.body?.ok, true, `${method}: ${JSON.stringify(response)}`);
  return response.body;
}

/** 审计预先建空文件；缺失、损坏或 fixture 失败均显式失败。 */
async function providerAudit() {
  const text = await bounded(fs.readFile(path.join(providerPath, "audit.jsonl"), "utf8"), 5_000, "DESKTOP_CANCEL_AUDIT_TIMEOUT");
  const rows = text.trim() ? text.trim().split(/\r?\n/u).map(line => JSON.parse(line)) : [];
  const failedIndex = rows.findIndex(row => row.method === "fixture.failed");
  if (failedIndex !== -1) throw new Error(`DESKTOP_CANCEL_FIXTURE_FAILED: index=${failedIndex}, reason=${rows[failedIndex].reason}`);
  for (const [index, row] of rows.entries()) {
    const method = typeof row.method === "string" ? row.method.slice(0, 120) : "invalid";
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0, `DESKTOP_CANCEL_PROVIDER_PID_REQUIRED: index=${index}, method=${method}`);
    // 历史 audit 跨重启保留；已确认退出的旧 provider PID 不再加入新一轮清理集。
    if (!providerPids.has(row.pid)) {
      providerPids.add(row.pid); observedPids.add(row.pid);
    }
  }
  return rows;
}

/** 只读 provider 实际 thread，返回取消所需身份、turn 和工具名事实。 */
async function providerThread(threadId) {
  assert.match(threadId, /^smoke-[a-f0-9-]+$/u);
  const thread = JSON.parse(await bounded(fs.readFile(path.join(providerPath, `${threadId}.json`), "utf8"), 5_000, "DESKTOP_CANCEL_PROVIDER_THREAD_TIMEOUT"));
  assert.equal(thread.id, threadId);
  return { id: thread.id, status: thread.status, turns: thread.turns, dynamicToolNames: thread.dynamicTools.map(tool => tool.name) };
}

/** 在正常退出前补齐已观测的 Electron 和 provider PID。 */
async function collectProcesses() {
  const metrics = await bounded(application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type }))),
    10_000, "DESKTOP_CANCEL_METRICS_TIMEOUT");
  for (const metric of metrics) {
    assert.ok(Number.isSafeInteger(metric.pid) && metric.pid > 0, "DESKTOP_CANCEL_METRIC_PID_REQUIRED");
    observedPids.add(metric.pid);
  }
  await providerAudit();
  return metrics;
}

/** 本轮 PID 必须全部退出；未知状态既不忽略，也不当作已退出。 */
async function waitStopped() {
  await waitUntil(() => {
    report.processes = [...observedPids].map(processState);
    assert.ok(!report.processes.some(item => item.state === "unknown"), JSON.stringify(report.processes));
    return report.processes.every(item => item.state === "absent");
  }, 5_000, "DESKTOP_CANCEL_PROCESSES_REMAINED");
}

/** 失败只清理本次观测进程，原错、查询未知与终止错误全部保留。 */
async function cleanup() {
  const errors = [];
  if (providerPrepared) {
    try { await providerAudit(); } catch (error) { errors.push(error); }
  }
  for (const pid of observedPids) {
    const state = processState(pid);
    if (state.state === "absent") continue;
    if (state.state === "unknown") { errors.push(new Error(`DESKTOP_CANCEL_PID_UNKNOWN: ${JSON.stringify(state)}`)); continue; }
    try {
      const killed = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
      if (killed.error || killed.status !== 0) throw killed.error ?? new Error(`DESKTOP_CANCEL_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`);
    } catch (error) { errors.push(error); }
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_CANCEL_CLOSE_TIMEOUT"); } catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  report.cleanup = { processes: [...observedPids].map(processState) };
  if (report.cleanup.processes.some(item => item.state !== "absent")) errors.push(new Error("DESKTOP_CANCEL_CLEANUP_UNCONFIRMED"));
  report.cleanup.status = errors.length ? "failed" : "stopped";
  if (errors.length) throw new AggregateError(errors, "DESKTOP_CANCEL_CLEANUP_FAILED");
}

/** 启动真实工件并核对隔离目录、沙箱、健康和稳定 Client 身份。 */
async function launch(executable, attempt) {
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(root, "profile")}`], env, cwd: root, timeout: 60_000 });
  child = application.process(); assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0); observedPids.add(child.pid);
  const run = { attempt, pid: child.pid, stderr: "", rendererErrors: [] }; report.runs.push(run);
  child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-65_536); });
  page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(30_000);
  page.on("pageerror", error => run.rendererErrors.push(failure(error)));
  page.on("console", message => { if (message.type() === "error") run.rendererErrors.push({ name: "ConsoleError", message: message.text() }); });
  await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
  run.facts = await bounded(application.evaluate(({ app, BrowserWindow }) => {
    const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, userData: app.getPath("userData"),
      preferences: { sandbox, contextIsolation, nodeIntegration }, path: process.env.PATH,
      nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH,
      codeflowEnv: Object.keys(process.env).filter(key => key.startsWith("CODEFLOWAI_")) };
  }), 15_000, "DESKTOP_CANCEL_FACTS_TIMEOUT");
  assert.equal(run.facts.packaged, true); assert.equal(run.facts.execPath, executable);
  assert.equal(run.facts.appPath, path.join(path.dirname(executable), "resources/app.asar"));
  assert.equal(run.facts.userData, path.join(root, "profile")); assert.equal(run.facts.path, env.PATH);
  assert.equal(run.facts.nodeOptions, undefined); assert.equal(run.facts.nodePath, undefined);
  assert.deepEqual(run.facts.codeflowEnv, ["CODEFLOWAI_DESKTOP_DATA_DIR"]);
  assert.deepEqual(run.facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  run.state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_CANCEL_STATE_TIMEOUT");
  assert.equal(run.state.status, "ready"); assert.equal(run.state.health.database, "ready");
  assert.ok(Number.isSafeInteger(run.state.pid) && run.state.pid > 0); observedPids.add(run.state.pid);
  run.metrics = await collectProcesses(); run.clientId = (await request("runtime.info")).client.clientId;
  assert.ok(typeof run.clientId === "string" && run.clientId.trim()); return run;
}

/** 壳必须保持 ready，经原退出 IPC 正常退出且观测 PID 全部消失。 */
async function exit(run) {
  run.finalState = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_CANCEL_FINAL_STATE_TIMEOUT");
  assert.equal(run.finalState.status, "ready"); assert.equal(run.finalState.pid, run.state.pid);
  run.finalMetrics = await collectProcesses();
  await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
    bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_CANCEL_EXIT_TIMEOUT")]);
  await waitStopped(); assert.equal(child.exitCode, 0); assert.deepEqual(run.rendererErrors, []);
  run.exitCode = child.exitCode; run.processes = report.processes;
  application = undefined; observedPids.clear();
}

/** 资产默认值从工件内 shared 生成，节点仅一角色，不造并行协议。 */
async function createAssets(workspaceId) {
  const defaults = await bounded(application.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const shared = createRequire(`${app.getAppPath()}/package.json`)("@codeflowai/shared");
    return { executionConfig: shared.createDefaultRoleExecutionConfig("codex"), inputDefinition: shared.createDefaultRoleInputDefinition(), outputDefinition: shared.createDefaultRoleOutputDefinition() };
  }), 10_000, "DESKTOP_CANCEL_DEFAULTS_TIMEOUT");
  const { role } = await request("orch.roles.upsert", { workspaceId, role: { ...defaults, name: "取消验收角色", description: "受控在途取消",
    systemPrompt: "等待取消验收，不提交产物。", gateCriteria: [], defaultKnowledgeBundleIds: [], defaultSkillIds: [], toolRefs: [] } });
  const { workflow } = await request("orch.workflows.upsert", { workspaceId, workflow: { name: "在途取消最小流程", description: "验证取消既有终态", version: 1,
    nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "verify", type: "role", label: "等待取消节点", roleId: role.id, approvalMode: "auto", position: { x: 250, y: 0 } },
      { id: "end", type: "end", label: "结束", position: { x: 500, y: 0 } }],
    edges: [{ id: "start-verify", sourceNodeId: "start", targetNodeId: "verify", dataMappings: [] },
      { id: "verify-end", sourceNodeId: "verify", targetNodeId: "end", dataMappings: [] }] } });
  const { intake } = await request("orch.intakes.create", { workspaceId, intake: { title, goal: "在途流程终止后不再推进",
    background: "隔离受控 JSON-RPC 取消验收", acceptanceCriteria: [{ text: "精确取消在途 turn，无成功产物或后续节点" }] } });
  return { roleId: role.id, workflowId: workflow.id, intakeId: intake.id };
}

/** 实例取消或节点停止严格按各自既定状态核验，end 均不得推进。 */
function assertCancelled(instance) {
  const expected = mode === "node" ? "waiting-feedback" : "cancelled";
  assert.equal(instance.status, expected); assert.equal(instance.nodeStates.verify.status, expected);
  if (mode === "node") assert.equal(instance.nodeStates.verify.humanActionSource, "execution");
  assert.equal(instance.nodeStates.end.status, "pending");
}

/** 只读核对中断事实；轮询仅允许终态尚未到达，已有坏事实立即失败。 */
function persistedEvidence(ids, allowPending = false) {
  const db = new DatabaseSync(path.join(root, "runtime/codeflowai.db"), { readOnly: true, timeout: 5_000 });
  let result, operationError;
  try {
    const instance = db.prepare("SELECT workspace_id,status,node_states_json FROM orch_instances WHERE id=?").get(ids.instanceId);
    assert.equal(instance.workspace_id, ids.workspaceId); assertCancelled({ status: instance.status, nodeStates: JSON.parse(instance.node_states_json) });
    const turns = db.prepare("SELECT turn_id,status,started_at,ended_at,end_event_seq FROM thread_turns WHERE thread_id=? ORDER BY started_at,turn_id").all(ids.nodeThreadId);
    assert.equal(turns.length, 1); assert.equal(turns[0].turn_id, ids.turnId);
    assert.ok(["started", "error"].includes(turns[0].status));
    if (turns[0].ended_at !== null) assert.ok(Number.isSafeInteger(turns[0].ended_at) && turns[0].ended_at >= turns[0].started_at);
    const canonical = db.prepare("SELECT event_json FROM conversation_events WHERE thread_id=? ORDER BY seq").all(ids.nodeThreadId).map(row => JSON.parse(row.event_json));
    const bindings = canonical.filter(event => event.type === "turn.engineBound" && event.payload?.turnId === ids.turnId);
    assert.ok(bindings.some(event => event.payload.engineTurnId === ids.providerTurnId && event.payload.engineSessionId === ids.providerThreadId));
    const terminals = canonical.filter(event => ["turn.completed", "turn.error"].includes(event.type));
    assert.ok(terminals.length <= 1);
    if (terminals.length) {
      assert.equal(terminals[0].payload?.turnId, ids.turnId);
      assert.equal(terminals[0].type, "turn.error"); assert.equal(terminals[0].payload.code, "turn_interrupted");
      assert.equal(terminals[0].payload.terminationKind, "manual_interrupt");
      assert.ok(Number.isSafeInteger(terminals[0].seq) && terminals[0].seq > 0);
    }
    if (turns[0].end_event_seq !== null) {
      assert.ok(Number.isSafeInteger(turns[0].end_event_seq) && turns[0].end_event_seq > 0);
      if (terminals.length) assert.equal(turns[0].end_event_seq, terminals[0].seq);
    }
    const raw = db.prepare("SELECT event_json FROM raw_engine_events WHERE thread_id=? ORDER BY seq").all(ids.nodeThreadId).map(row => JSON.parse(row.event_json));
    const rawTerminals = raw.filter(event => event.data?.method === "turn/completed");
    assert.ok(rawTerminals.length <= 1);
    if (rawTerminals.length) {
      assert.equal(rawTerminals[0].clientTurnId, ids.turnId);
      assert.equal(rawTerminals[0].data.params?.threadId, ids.providerThreadId);
      assert.equal(rawTerminals[0].data.params.turn?.id, ids.providerTurnId);
      assert.equal(rawTerminals[0].data.params.turn.status, "interrupted");
    }
    const attempts = db.prepare("SELECT id,node_id,status,thread_id,turn_id,artifact_id,submission_json,invalidated_at FROM orch_node_attempts WHERE instance_id=? ORDER BY node_id,id").all(ids.instanceId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].node_id, "start"); assert.equal(attempts[0].status, "completed");
    assert.equal(attempts[1].node_id, "verify"); assert.equal(attempts[1].status, mode === "node" ? "invalidated" : "cancelled");
    if (mode === "node") assert.ok(Number.isSafeInteger(attempts[1].invalidated_at) && attempts[1].invalidated_at > 0);
    assert.equal(attempts[1].thread_id, ids.nodeThreadId); assert.equal(attempts[1].turn_id, ids.turnId);
    assert.ok(attempts.every(attempt => attempt.artifact_id === null && attempt.submission_json === null));
    const artifacts = db.prepare("SELECT id FROM orch_artifacts WHERE instance_id=?").all(ids.instanceId); assert.deepEqual(artifacts, []);
    const events = db.prepare("SELECT id,type,payload_json FROM orch_events WHERE instance_id=? ORDER BY id").all(ids.instanceId);
    assert.equal(events.filter(event => event.type === "orchestration.cancelled").length, mode === "node" ? 0 : 1);
    if (mode === "node") {
      const feedback = events.filter(event => event.type === "orchestration.feedbackRequested").map(event => JSON.parse(event.payload_json));
      assert.equal(feedback.length, 1); assert.equal(feedback[0].nodeId, "verify"); assert.equal(feedback[0].source, "execution");
    }
    assert.ok(!events.some(event => ["orchestration.completed", "orchestration.error"].includes(event.type)));
    const ready = turns[0].status === "error" && turns[0].ended_at !== null && terminals.length === 1 && rawTerminals.length === 1
      && (mode !== "node" || turns[0].end_event_seq !== null);
    if (!allowPending) assert.ok(ready, "DESKTOP_CANCEL_TERMINAL_NOT_PERSISTED");
    result = ready ? { instance, turns, canonical, raw, attempts, artifacts, events, clientId: db.prepare("SELECT value FROM meta WHERE key='client_id'").get().value } : false;
  } catch (error) { operationError = error; }
  try { db.close(); } catch (error) { throw new AggregateError([...(operationError ? [operationError] : []), error], "DESKTOP_CANCEL_SQLITE_CLOSE_FAILED"); }
  if (operationError) throw operationError;
  return result;
}

try {
  assert.ok(process.platform === "win32" && path.extname(executable).toLowerCase() === ".exe", "DESKTOP_CANCEL_WINDOWS_EXE_REQUIRED");
  report.executable = executable; report.artifactBefore = await artifactHashes(executable);
  await bounded(prepareProvider(providerPath), 5_000, "DESKTOP_CANCEL_PROVIDER_PREPARE_TIMEOUT");
  await bounded(fs.writeFile(path.join(providerPath, "audit.jsonl"), "", "utf8"), 5_000, "DESKTOP_CANCEL_AUDIT_INIT_TIMEOUT"); providerPrepared = true;
  await bounded(fs.mkdir(project), 5_000, "DESKTOP_CANCEL_PROJECT_TIMEOUT"); env = await isolatedEnvironment();
  report.phase = "launch"; const first = await launch(executable, 1);
  report.phase = "assets";
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await dialog.locator('input[name="codeflow-workspace-title"]').fill("在途取消验收");
  await dialog.locator('input[name="codeflow-workspace-path"]').fill(project);
  await dialog.getByRole("button", { name: /^创\s*建$/ }).click(); await expect(dialog).toBeHidden();
  const workspace = (await request("workspaces.list")).workspaces.find(item => item.path === project); assert.ok(workspace?.id);
  const assets = await createAssets(workspace.id); report.entities = { workspaceId: workspace.id, ...assets };
  await bounded(fs.writeFile(path.join(providerPath, "fixture.json"), JSON.stringify({ ...assets, hold: true }), "utf8"), 5_000, "DESKTOP_CANCEL_FIXTURE_TIMEOUT");
  report.phase = "start-held-node";
  await page.goto("codeflow://desktop/orchestration/workspace");
  await page.locator(".ant-segmented-item").filter({ hasText: "需求编排" }).click();
  const card = page.locator(".task-sidebar__card").filter({ hasText: title }); await expect(card).toBeVisible(); await card.click();
  await page.locator(".task-detail__planner-field").filter({ has: page.locator("span", { hasText: /^流程模板$/ }) }).locator("select").selectOption(assets.workflowId);
  await page.getByRole("button", { name: "立即执行", exact: true }).click();
  await waitUntil(async () => (await request("orch.instances.list", { workspaceId: workspace.id })).instances.length === 1, 30_000, "DESKTOP_CANCEL_INSTANCE_TIMEOUT");
  const instanceId = (await request("orch.instances.list", { workspaceId: workspace.id })).instances[0].id; report.entities.instanceId = instanceId;
  await waitUntil(async () => (await request("orch.instances.get", { workspaceId: workspace.id, instanceId })).instance.nodeStates.verify?.status === "running"
    && (await providerAudit()).some(row => row.method === "turn.held"), 30_000, "DESKTOP_CANCEL_HELD_TIMEOUT");
  const running = (await request("orch.instances.get", { workspaceId: workspace.id, instanceId })).instance;
  assert.equal(running.status, "running"); assert.equal(running.workflowSnapshot.id, assets.workflowId); assert.equal(running.intakeSnapshot.id, assets.intakeId);
  const nodeThreadId = running.nodeStates.verify.threadId; assert.ok(nodeThreadId); report.entities.nodeThreadId = nodeThreadId;
  const summary = await request("threads.summary", { workspaceId: workspace.id, threadId: nodeThreadId }); assert.ok(summary.running?.runningTurnId);
  report.entities.turnId = summary.running.runningTurnId; report.running = { instance: running, thread: summary };
  const heldAudit = await providerAudit(), held = heldAudit.filter(row => row.method === "turn.held"); assert.equal(held.length, 1);
  report.entities.providerThreadId = held[0].threadId; report.entities.providerTurnId = held[0].turnId;
  const heldThread = await providerThread(held[0].threadId); assert.equal(heldThread.turns.length, 1); assert.equal(heldThread.turns[0].status, "inProgress");
  assert.equal(heldThread.turns[0].id, held[0].turnId); report.held = { audit: heldAudit, thread: heldThread };
  assert.ok(!heldAudit.some(row => row.method === "aidt_runtime_submitNodeResult"));
  assert.deepEqual((await request("orch.artifacts.list", { workspaceId: workspace.id, instanceId, includeContent: true })).artifacts, []);
  report.phase = `stop-${mode}`; const scope = { workspaceId: workspace.id, instanceId };
  await request(mode === "node" ? "orch.nodes.cancel" : "orch.instances.cancel", { ...scope, ...(mode === "node" ? { nodeId: "verify" } : {}) });
  await waitUntil(async () => (await request("orch.instances.get", scope)).instance.status === (mode === "node" ? "waiting-feedback" : "cancelled")
    && (await providerThread(held[0].threadId)).turns[0].status === "interrupted", 15_000, "DESKTOP_CANCEL_TERMINAL_TIMEOUT");
  const stopped = (await request("orch.instances.get", scope)).instance; assertCancelled(stopped);
  if (mode === "node") report.stopped = stopped; else report.cancelled = stopped;
  assert.deepEqual((await request("orch.artifacts.list", { ...scope, includeContent: true })).artifacts, []);
  const audit = await providerAudit(), interrupts = audit.filter(row => row.method === "turn/interrupt"); assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].threadId, held[0].threadId); assert.equal(interrupts[0].turnId, held[0].turnId);
  assert.equal(audit.filter(row => row.method === "turn/start").length, 1); assert.ok(!audit.some(row => row.method === "aidt_runtime_submitNodeResult"));
  const interruptedThread = await providerThread(held[0].threadId); assert.equal(interruptedThread.turns.length, 1);
  assert.equal(interruptedThread.turns[0].status, "interrupted"); assert.equal(interruptedThread.status.type, "idle");
  report.provider = { audit, thread: interruptedThread };
  report.phase = "pre-exit-terminal";
  await waitUntil(async () => {
    const persisted = persistedEvidence(report.entities, true); if (!persisted) return false;
    const thread = await request("threads.summary", { workspaceId: workspace.id, threadId: nodeThreadId });
    if (thread.running !== null) { assert.equal(thread.running?.runningTurnId, report.entities.turnId); return false; }
    report.preExit = { observedAt: Date.now(), persisted, thread }; return true;
  }, 15_000, "DESKTOP_CANCEL_PRE_EXIT_TERMINAL_TIMEOUT");
  report.phase = "first-exit"; await exit(first); report.persisted = persistedEvidence(report.entities);
  assert.deepEqual(report.persisted, report.preExit.persisted); assert.equal(report.persisted.clientId, first.clientId);
  report.phase = "restart"; const second = await launch(executable, 2); assert.equal(second.clientId, first.clientId);
  const restored = (await request("orch.instances.get", scope)).instance; assertCancelled(restored);
  assert.equal(restored.nodeStates.verify.threadId, nodeThreadId);
  assert.ok((await request("workspaces.list")).workspaces.some(item => item.id === workspace.id && item.path === project));
  assert.ok((await request("orch.roles.list", { workspaceId: workspace.id })).roles.some(item => item.id === assets.roleId));
  assert.ok((await request("orch.workflows.list", { workspaceId: workspace.id })).workflows.some(item => item.id === assets.workflowId));
  assert.ok((await request("orch.intakes.list", { workspaceId: workspace.id })).intakes.some(item => item.id === assets.intakeId));
  assert.deepEqual((await request("orch.artifacts.list", { ...scope, includeContent: true })).artifacts, []);
  assert.deepEqual(await providerAudit(), audit); assert.deepEqual(await providerThread(held[0].threadId), interruptedThread);
  report.phase = "second-exit"; await exit(second); assert.deepEqual(persistedEvidence(report.entities), report.persisted);
  assert.deepEqual(await providerAudit(), audit); report.artifactAfter = await artifactHashes(executable); assert.deepEqual(report.artifactAfter, report.artifactBefore);
  report.cleanup = { status: "stopped", processes: report.runs.flatMap(run => run.processes) }; report.status = "passed";
} catch (error) {
  report.failedPhase = report.phase;
  try { await cleanup(); } catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_CANCEL_VERIFICATION_AND_CLEANUP_FAILED"); }
  report.status = "failed"; report.failure = failure(error); process.exitCode = 1;
}
try { await bounded(fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"), 5_000, "DESKTOP_CANCEL_REPORT_TIMEOUT"); }
catch (error) { throw new AggregateError([...(report.failure ? [new Error(JSON.stringify(report.failure))] : []), error], "DESKTOP_CANCEL_REPORT_WRITE_FAILED"); }
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_CANCEL_${report.status.toUpperCase()}`, requestId: report.requestId,
  reportPath, ...(report.failure ? { failedPhase: report.failedPhase, failure: report.failure, cleanup: report.cleanup } : {}) }));
