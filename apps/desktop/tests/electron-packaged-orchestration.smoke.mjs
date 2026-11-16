import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";

const report = { requestId: randomUUID(), status: "running", phase: "preflight", runs: [],
  scope: "windows_packaged_controlled_provider_orchestration", paidProviderExercised: false };
const observedPids = new Set();
let root, reportPath, env, application, child, page, verificationError;
const { _electron: electron, expect: baseExpect } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
const expect = baseExpect.configure({ timeout: 30_000 });
const title = "最终工件编排验收";
const answer = "本机编排产物：已收到原生审批、原生输入和业务反馈。";
const feedback = "业务验收确认，可以正式交付。";

/** 外部操作逐项限时，超时交由顶层显式失败并清理本片进程。 */
async function bounded(operation, milliseconds, code) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** 只把 ESRCH 判为退出；查询错误保留 PID 和未知事实。 */
function processState(pid) {
  try { process.kill(pid, 0); return { pid, state: "alive" }; }
  catch (error) {
    if (error.code === "ESRCH") return { pid, state: "absent" };
    return { pid, state: "unknown", error: failure(error) };
  }
}

/** 错误链保留原因及聚合清理错误，不输出环境或凭据。 */
function failure(error, depth = 0) {
  return { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 4000),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.cause && depth < 5 ? { cause: failure(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError && depth < 5 ? { errors: [...error.errors].map(item => failure(item, depth + 1)) } : {}) };
}

/** 用户、引擎与缓存目录全部隔离，PATH 只含 fixture 和必要 Windows 目录。 */
async function isolatedEnvironment(providerPath) {
  const allowed = /^(?:pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const systemRoot = result.SystemRoot ?? result.SYSTEMROOT;
  assert.ok(systemRoot, "DESKTOP_ORCH_SYSTEM_ROOT_REQUIRED");
  result.PATH = [providerPath, path.join(systemRoot, "System32"), systemRoot].join(path.delimiter);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "TMPDIR"]) {
    result[key] = path.join(root, key.toLowerCase());
    await bounded(fs.mkdir(result[key]), 5_000, "DESKTOP_ORCH_ISOLATION_MKDIR_TIMEOUT");
  }
  result.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(root, "runtime");
  return result;
}

/** 通过正式受限 preload 请求；非成功响应停止后续业务操作。 */
async function request(method, body = {}) {
  const response = await bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, body }),
    35_000, `DESKTOP_ORCH_REQUEST_TIMEOUT: ${method}`);
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(response)}`);
  assert.equal(response.body.ok, true, `${method}: ${JSON.stringify(response)}`);
  return response.body;
}

/** 审计只取 fixture 已知 PID；文件缺失仅表示尚未启动 provider。 */
async function providerAudit() {
  let text;
  try { text = await bounded(fs.readFile(path.join(root, "provider", "audit.jsonl"), "utf8"), 5_000, "DESKTOP_ORCH_AUDIT_READ_TIMEOUT"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const rows = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  for (const row of rows) if (Number.isInteger(row.pid) && row.pid > 0) observedPids.add(row.pid);
  return rows;
}

/** 采集壳、Client、Electron metrics 和 provider，保留每次运行的进程归属。 */
async function collectProcesses() {
  const metrics = await bounded(application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type }))),
    10_000, "DESKTOP_ORCH_METRICS_TIMEOUT");
  for (const metric of metrics) observedPids.add(metric.pid);
  await providerAudit();
  return metrics;
}

/** 显式退出后逐 PID 确认；未知存活始终保留为失败。 */
async function waitStopped() {
  const deadline = Date.now() + 5_000;
  let states;
  do {
    states = [...observedPids].map(processState);
    report.processes = states;
    if (states.some(item => item.state === "unknown")) throw new Error("DESKTOP_ORCH_PID_STATE_UNKNOWN");
    if (states.every(item => item.state === "absent")) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`DESKTOP_ORCH_PROCESSES_REMAIN: ${states.filter(item => item.state !== "absent").map(item => item.pid).join(",")}`);
}

/** 正常关闭只走产品 exit IPC；页面内异步拒绝由 pageerror 断言捕获。 */
async function exit(run) {
  run.finalMetrics = await collectProcesses();
  await Promise.all([application.waitForEvent("close", { timeout: 40_000 }),
    bounded(page.evaluate(() => { void window.codeflowDesktop.exit(); }), 5_000, "DESKTOP_ORCH_EXIT_REQUEST_TIMEOUT")]);
  await waitStopped();
  assert.equal(child.exitCode, 0, "DESKTOP_ORCH_EXIT_FAILED");
  assert.deepEqual(run.rendererErrors, []);
  run.exitCode = child.exitCode;
  run.processes = report.processes;
  application = undefined;
}

/** 失败时只终止本片观测进程树；所有清理错误与未知 PID 均写回报告并抛出。 */
async function cleanup() {
  const errors = [];
  if (root) {
    try { await bounded(providerAudit(), 5_000, "DESKTOP_ORCH_AUDIT_CLEANUP_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  for (const pid of observedPids) {
    const state = processState(pid);
    if (state.state === "absent") continue;
    if (state.state === "unknown") { errors.push(new Error(`DESKTOP_ORCH_PID_STATE_UNKNOWN: ${JSON.stringify(state)}`)); continue; }
    const killed = spawnSync(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf8" });
    if (killed.error || killed.status !== 0) errors.push(killed.error ?? new Error(`DESKTOP_ORCH_KILL_FAILED: pid=${pid}, status=${killed.status}, ${killed.stderr}`));
  }
  if (application) {
    try { await bounded(application.close(), 5_000, "DESKTOP_ORCH_CONNECTION_CLOSE_TIMEOUT"); }
    catch (error) { errors.push(error); }
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  const states = [...observedPids].map(processState);
  report.cleanup = { status: errors.length || states.some(item => item.state !== "absent") ? "failed" : "stopped", processes: states };
  if (states.some(item => item.state !== "absent")) errors.push(new Error("DESKTOP_ORCH_CLEANUP_PROCESS_STATE_UNCONFIRMED"));
  if (errors.length) throw new AggregateError(errors, "DESKTOP_ORCH_CLEANUP_FAILED");
}

/** 启动既有最终工件，核对生产资源、沙箱及隔离 Client。 */
async function launch(executable, attempt) {
  application = await bounded(electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(root, "profile")}`],
    env, cwd: root, timeout: 60_000 }), 65_000, "DESKTOP_ORCH_LAUNCH_TIMEOUT");
  child = application.process();
  observedPids.add(child.pid);
  const run = { attempt, pid: child.pid, rendererErrors: [], stdout: "", stderr: "" };
  report.runs.push(run);
  child.stdout.setEncoding("utf8").on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-16_384); });
  child.stderr.setEncoding("utf8").on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-16_384); });
  page = await application.firstWindow({ timeout: 60_000 });
  run.facts = await bounded(application.evaluate(({ app, BrowserWindow }) => {
    const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), execPath: process.execPath,
      userData: app.getPath("userData"), preferences: { sandbox, contextIsolation, nodeIntegration },
      env: { nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH, path: process.env.PATH,
        codeflow: Object.keys(process.env).filter(key => key.startsWith("CODEFLOWAI_")) } };
  }), 15_000, "DESKTOP_ORCH_MAIN_FACTS_TIMEOUT");
  assert.equal(run.facts.isPackaged, true);
  assert.equal(run.facts.execPath, executable);
  assert.equal(run.facts.appPath, path.join(path.dirname(executable), "resources", "app.asar"));
  assert.equal(run.facts.userData, path.join(root, "profile"));
  assert.deepEqual(run.facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(run.facts.env.nodeOptions, undefined);
  assert.equal(run.facts.env.nodePath, undefined);
  assert.equal(run.facts.env.path, env.PATH);
  assert.deepEqual(run.facts.env.codeflow, ["CODEFLOWAI_DESKTOP_DATA_DIR"]);
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on("pageerror", error => run.rendererErrors.push(failure(error)));
  page.on("console", message => { if (message.type() === "error") run.rendererErrors.push({ name: "ConsoleError", message: message.text() }); });
  await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
  await expect.poll(async () => (await bounded(page.evaluate(() => window.codeflowDesktop.getState()),
    10_000, "DESKTOP_ORCH_READY_QUERY_TIMEOUT")).status).toBe("ready");
  run.state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, "DESKTOP_ORCH_STATE_TIMEOUT");
  assert.equal(run.state.health.database, "ready");
  assert.ok(Number.isInteger(run.state.pid) && run.state.pid > 0);
  observedPids.add(run.state.pid);
  const view = await bounded(page.evaluate(() => ({ require: typeof require, assets: [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map(element => element.src || element.href) })),
    10_000, "DESKTOP_ORCH_VIEW_TIMEOUT");
  assert.equal(view.require, "undefined");
  assert.ok(view.assets.length && view.assets.every(asset => asset.startsWith("codeflow://desktop/")));
  run.metrics = await collectProcesses();
  const runtime = await request("runtime.info");
  assert.ok(typeof runtime.client.clientId === "string" && runtime.client.clientId.trim());
  run.clientId = runtime.client.clientId;
  return run;
}

/** 默认角色定义由包内现有 shared 入口生成，页面不导入任何开发源码。 */
async function createAssets(workspaceId) {
  const defaults = await bounded(application.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const shared = createRequire(`${app.getAppPath()}/package.json`)("@codeflowai/shared");
    return { executionConfig: shared.createDefaultRoleExecutionConfig("codex"), inputDefinition: shared.createDefaultRoleInputDefinition(), outputDefinition: shared.createDefaultRoleOutputDefinition() };
  }), 10_000, "DESKTOP_ORCH_DEFAULTS_TIMEOUT");
  const { role } = await request("orch.roles.upsert", { workspaceId, role: { ...defaults, name: "工件验收角色", description: "单节点业务验收",
    systemPrompt: "提交实际验收结果。", gateCriteria: [], defaultKnowledgeBundleIds: [], defaultSkillIds: [], toolRefs: [] } });
  const { workflow } = await request("orch.workflows.upsert", { workspaceId, workflow: { name: "工件最小验收流程", description: "受控协议验收", version: 1,
    nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "verify", type: "role", label: "工件验收节点", roleId: role.id, approvalMode: "auto", position: { x: 250, y: 0 } },
      { id: "end", type: "end", label: "完成", position: { x: 500, y: 0 } }],
    edges: [{ id: "start-verify", sourceNodeId: "start", targetNodeId: "verify", dataMappings: [] },
      { id: "verify-end", sourceNodeId: "verify", targetNodeId: "end", dataMappings: [] }] } });
  const { intake } = await request("orch.intakes.create", { workspaceId, intake: { title, goal: "验证最终 Windows 工件业务闭环", background: "受控 JSON-RPC 集成验收",
    acceptanceCriteria: [{ text: "生成可回读的本机验收结果" }] } });
  return { roleId: role.id, workflowId: workflow.id, intakeId: intake.id };
}

/** 从正式需求入口选择需求并打开原监控图，不修改前端状态。 */
async function openIntake() {
  await page.goto("codeflow://desktop/orchestration/workspace");
  await bounded(page.evaluate(() => {
    window.packagedOrchestrationMessages = [];
    new MutationObserver(() => {
      for (const element of document.querySelectorAll(".ant-message-notice-content")) {
        const text = element.textContent;
        if (text && !window.packagedOrchestrationMessages.includes(text)) window.packagedOrchestrationMessages.push(text);
      }
    }).observe(document.body, { subtree: true, childList: true });
  }), 5_000, "DESKTOP_ORCH_UI_OBSERVER_TIMEOUT");
  await expect(page.getByRole("button", { name: /切换工作区，当前 工件流程验收/ })).toBeVisible();
  await page.locator(".ant-segmented-item").filter({ hasText: "需求编排" }).click();
  const card = page.locator(".task-sidebar__card").filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.click();
}

/** 产物只报告稳定 ID、长度与正文摘要，重启前后必须完全一致。 */
function artifactSummary(artifacts) {
  assert.ok(artifacts.some(item => item.contentJson.includes(answer)), "DESKTOP_ORCH_DELIVERY_BODY_ABSENT");
  return artifacts.map(item => ({ id: item.id, nodeId: item.nodeId, length: item.contentJson.length,
    sha256: createHash("sha256").update(item.contentJson).digest("hex") })).sort((left, right) => left.id.localeCompare(right.id));
}

/** 正常退出后以只读 SQLite 验证同实例、节点线程、分层提示和正式交付事实。 */
function persistedEvidence(ids) {
  const db = new DatabaseSync(path.join(root, "runtime", "codeflowai.db"), { readOnly: true, timeout: 5_000 });
  let result, operationError;
  try {
    const instance = db.prepare("SELECT workspace_id, status, node_states_json FROM orch_instances WHERE id = ?").get(ids.instanceId);
    assert.equal(instance?.workspace_id, ids.workspaceId);
    assert.equal(instance.status, "completed");
    assert.equal(JSON.parse(instance.node_states_json).verify.threadId, ids.nodeThreadId);
    const count = table => Number(db.prepare(`SELECT count(*) AS total FROM ${table} WHERE thread_id = ? AND workspace_id = ?`).get(ids.nodeThreadId, ids.workspaceId).total);
    const canonical = count("conversation_events"), raw = count("raw_engine_events");
    assert.ok(canonical > 0 && raw > 0);
    const turns = db.prepare("SELECT turn_id AS id, status FROM thread_turns WHERE thread_id = ? ORDER BY started_at, turn_id").all(ids.nodeThreadId);
    assert.ok(turns.length >= 2 && turns.every(turn => turn.status === "completed"));
    const prompts = db.prepare("SELECT id, node_id, thread_id, system_message, developer_message, user_message FROM orch_prompt_snapshots WHERE instance_id = ? ORDER BY id").all(ids.instanceId);
    assert.ok(prompts.length >= 2);
    assert.ok(prompts.every(prompt => prompt.node_id === "verify" && prompt.thread_id === ids.nodeThreadId));
    assert.ok(prompts.some(prompt => prompt.system_message.trim() && prompt.developer_message?.includes("runtime.submitNodeResult") && prompt.user_message.includes(title)));
    const artifacts = db.prepare("SELECT id, node_id AS nodeId, content_json AS contentJson FROM orch_artifacts WHERE instance_id = ? ORDER BY id").all(ids.instanceId);
    const feedbackRows = db.prepare("SELECT id, action, payload_json FROM orch_feedback_records WHERE instance_id = ? AND node_id = 'verify' ORDER BY id").all(ids.instanceId);
    assert.ok(feedbackRows.some(item => item.action === "resume_with_input" && item.payload_json.includes(feedback)));
    const events = db.prepare("SELECT id, type FROM orch_events WHERE instance_id = ? ORDER BY id").all(ids.instanceId);
    assert.ok(events.some(event => event.type === "orchestration.completed"));
    const rawText = db.prepare("SELECT event_json FROM raw_engine_events WHERE thread_id = ?").all(ids.nodeThreadId).map(row => row.event_json).join("\n");
    assert.ok(rawText.includes("aidt_runtime_submitNodeResult"));
    result = { canonical, raw, turns, promptIds: prompts.map(item => item.id), artifacts: artifactSummary(artifacts),
      feedbackIds: feedbackRows.map(item => item.id), events, clientId: db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get().value };
  } catch (error) { operationError = error; }
  try { db.close(); }
  catch (error) { throw new AggregateError([...(operationError ? [operationError] : []), error], "DESKTOP_ORCH_SQLITE_CLOSE_FAILED"); }
  if (operationError) throw operationError;
  return result;
}

try {
  const [input, evidenceRoot, ...extra] = process.argv.slice(2);
  if (!input || !evidenceRoot || extra.length) throw new Error("用法：electron-packaged-orchestration.smoke.mjs <工件 exe> <独占证据目录>");
  const base = await bounded(fs.realpath(path.resolve(evidenceRoot)), 5_000, "DESKTOP_ORCH_EVIDENCE_PATH_TIMEOUT");
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const baseRelative = path.relative(repository, base);
  assert.ok(baseRelative.startsWith(`..${path.sep}`) || path.isAbsolute(baseRelative), "DESKTOP_ORCH_EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
  const executable = await bounded(fs.realpath(path.resolve(input)), 5_000, "DESKTOP_ORCH_EXE_PATH_TIMEOUT");
  assert.ok(process.platform === "win32" && path.extname(executable).toLowerCase() === ".exe", "DESKTOP_ORCH_WINDOWS_EXE_REQUIRED");
  const relative = path.relative(repository, executable);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "DESKTOP_ORCH_EXE_MUST_BE_OUTSIDE_REPOSITORY");
  // 写入前排除工件目录及其祖先，真实路径同时覆盖目录链接。
  const artifactDirectory = path.dirname(executable);
  const overlapsArtifact = [path.relative(artifactDirectory, base), path.relative(base, artifactDirectory)]
    .some(relative => relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
  assert.equal(overlapsArtifact, false, "DESKTOP_ORCH_EVIDENCE_ARTIFACT_OVERLAP");
  for (const entry of ["app.asar", "client/dist/index.cjs", "web/index.html"]) await bounded(fs.access(path.join(path.dirname(executable), "resources", entry)), 5_000, "DESKTOP_ORCH_RESOURCE_ACCESS_TIMEOUT");
  root = await bounded(fs.mkdtemp(path.join(base, "run-")), 5_000, "DESKTOP_ORCH_EVIDENCE_MKDIR_TIMEOUT");
  report.root = root;
  reportPath = path.join(root, "verification.json");
  report.executable = executable;
  report.exeSha256 = createHash("sha256").update(await bounded(fs.readFile(executable), 30_000, "DESKTOP_ORCH_EXE_READ_TIMEOUT")).digest("hex");
  const providerPath = path.join(root, "provider"), project = path.join(root, "project");
  await bounded(prepareProvider(providerPath), 5_000, "DESKTOP_ORCH_PROVIDER_PREPARE_TIMEOUT");
  await bounded(fs.mkdir(project), 5_000, "DESKTOP_ORCH_PROJECT_MKDIR_TIMEOUT");
  env = await isolatedEnvironment(providerPath);
  report.phase = "launch";
  const first = await launch(executable, 1);
  report.phase = "ui-workspace";
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await create.locator('input[name="codeflow-workspace-title"]').fill("工件流程验收");
  await create.locator('input[name="codeflow-workspace-path"]').fill(project);
  await create.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole("button", { name: /切换工作区，当前 工件流程验收/ })).toBeVisible();
  const { workspaces } = await request("workspaces.list");
  const workspace = workspaces.find(item => item.path === project);
  assert.ok(workspace?.id);
  const workspaceId = workspace.id;
  report.phase = "bridge-assets";
  const assets = await createAssets(workspaceId);
  report.entities = { workspaceId, ...assets };
  await bounded(fs.writeFile(path.join(providerPath, "fixture.json"), JSON.stringify(assets), "utf8"), 5_000, "DESKTOP_ORCH_FIXTURE_WRITE_TIMEOUT");
  report.phase = "ui-execute";
  await openIntake();
  report.engines = await request("engines.status", { workspaceId });
  await page.locator(".task-detail__planner-field").filter({ has: page.locator("span", { hasText: /^流程模板$/ }) }).locator("select").selectOption(assets.workflowId);
  await bounded(page.evaluate(() => {
    window.packagedOrchestrationEvents = [];
    window.codeflowDesktop.onEvent(value => { if (value.t === "orchestration.event") window.packagedOrchestrationEvents.push(value.event); });
  }), 5_000, "DESKTOP_ORCH_EVENT_OBSERVER_TIMEOUT");
  await page.getByRole("button", { name: "立即执行", exact: true }).click();
  await expect.poll(async () => (await request("orch.instances.list", { workspaceId })).instances.length).toBe(1);
  const { instances } = await request("orch.instances.list", { workspaceId });
  const instanceId = instances[0].id;
  report.entities.instanceId = instanceId;
  await expect.poll(async () => (await request("orch.instances.get", { workspaceId, instanceId })).instance.nodeStates.verify?.threadId).toBeTruthy();
  const { instance } = await request("orch.instances.get", { workspaceId, instanceId });
  assert.equal(instance.intakeSnapshot.id, assets.intakeId);
  assert.equal(instance.workflowSnapshot.id, assets.workflowId);
  const nodeThreadId = instance.nodeStates.verify.threadId;
  report.entities.nodeThreadId = nodeThreadId;
  report.phase = "ui-native-interactions";
  await page.goto(`codeflow://desktop/chat?threadId=${encodeURIComponent(nodeThreadId)}`);
  const approval = page.locator(".msg--approval").filter({ hasText: "local-smoke" });
  await expect(approval.getByRole("button", { name: /^同\s*意$/ })).toBeEnabled();
  await approval.getByRole("button", { name: /^同\s*意$/ }).click();
  const userInput = page.locator(".msg--user-input");
  await expect(userInput.getByRole("button", { name: /^(?:回\s*答|填\s*写)$/ })).toBeEnabled();
  await userInput.getByRole("button", { name: /^(?:回\s*答|填\s*写)$/ }).click();
  const inputDialog = page.getByRole("dialog", { name: "需要您补充输入", exact: true });
  await inputDialog.getByRole("radio", { name: /确认本机验收/ }).check();
  await inputDialog.getByRole("button", { name: /^提\s*交$/ }).click();
  await expect(inputDialog).toBeHidden();
  report.phase = "ui-business-feedback";
  await expect.poll(async () => (await request("orch.instances.get", { workspaceId, instanceId })).instance.nodeStates.verify.status).toBe("waiting-feedback");
  await openIntake();
  await bounded(page.evaluate(() => {
    window.packagedOrchestrationEvents = [];
    window.codeflowDesktop.onEvent(value => { if (value.t === "orchestration.event") window.packagedOrchestrationEvents.push(value.event); });
  }), 5_000, "DESKTOP_ORCH_EVENT_OBSERVER_TIMEOUT");
  const graphNode = page.locator('.task-detail__monitor .vue-flow__node[data-id="verify"]');
  await graphNode.click();
  await page.getByRole("button", { name: "查看节点详情", exact: true }).click();
  const feedbackPanel = page.locator(".feedback-dialog");
  await expect(feedbackPanel.locator("textarea")).toBeVisible();
  await feedbackPanel.locator("textarea").fill(feedback);
  await feedbackPanel.getByRole("button", { name: "提交", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect.poll(async () => (await request("orch.instances.get", { workspaceId, instanceId })).instance.status).toBe("completed");
  await expect(graphNode.locator(".wf-graph-node__status")).toHaveText("已完成");
  await expect.poll(async () => bounded(page.evaluate(id => window.packagedOrchestrationEvents.some(event => event.instanceId === id && event.type === "orchestration.completed"), instanceId), 5_000, "DESKTOP_ORCH_COMPLETED_EVENT_QUERY_TIMEOUT")).toBe(true);
  report.phase = "delivery";
  const { artifacts } = await request("orch.artifacts.list", { workspaceId, instanceId, includeContent: true });
  report.artifacts = artifactSummary(artifacts);
  const audit = await providerAudit();
  for (const method of ["approval.accepted", "input.accepted", "aidt_runtime_submitNodeResult", "thread/resume"]) assert.ok(audit.some(item => item.method === method), `DESKTOP_ORCH_METHOD_ABSENT: ${method}`);
  assert.ok(!audit.some(item => item.method === "fixture.failed"));
  const providerThreadIds = [...new Set(audit.filter(item => item.method === "aidt_runtime_submitNodeResult").map(item => item.threadId))];
  assert.equal(providerThreadIds.length, 1);
  const providerThread = JSON.parse(await bounded(fs.readFile(path.join(providerPath, `${providerThreadIds[0]}.json`), "utf8"), 5_000, "DESKTOP_ORCH_PROVIDER_THREAD_READ_TIMEOUT"));
  assert.ok(providerThread.dynamicTools.some(tool => tool.name === "aidt_runtime_submitNodeResult"));
  assert.equal(providerThread.turns.length, 2);
  assert.ok(providerThread.turns.every(turn => turn.status === "completed"));
  report.provider = { methods: audit, threadId: providerThread.id, dynamicToolNames: providerThread.dynamicTools.map(tool => tool.name) };
  await page.goto(`codeflow://desktop/chat?threadId=${encodeURIComponent(nodeThreadId)}`);
  await expect(page.getByText("本机节点正式交付完成。", { exact: true }).first()).toBeVisible();
  report.phase = "first-exit-sqlite";
  await exit(first);
  report.persisted = persistedEvidence(report.entities);
  assert.equal(report.persisted.clientId, first.clientId);
  assert.deepEqual(report.persisted.artifacts, report.artifacts);
  report.phase = "restart-recovery";
  const second = await launch(executable, 2);
  assert.equal(second.clientId, first.clientId);
  const restored = await request("orch.instances.get", { workspaceId, instanceId });
  assert.equal(restored.instance.status, "completed");
  assert.equal(restored.instance.intakeSnapshot.id, assets.intakeId);
  assert.equal(restored.instance.nodeStates.verify.threadId, nodeThreadId);
  assert.ok((await request("workspaces.list")).workspaces.some(item => item.id === workspaceId && item.path === project));
  assert.ok((await request("orch.roles.list", { workspaceId })).roles.some(item => item.id === assets.roleId));
  assert.ok((await request("orch.workflows.list", { workspaceId })).workflows.some(item => item.id === assets.workflowId));
  assert.ok((await request("orch.intakes.list", { workspaceId })).intakes.some(item => item.id === assets.intakeId && item.title === title));
  assert.deepEqual(artifactSummary((await request("orch.artifacts.list", { workspaceId, instanceId, includeContent: true })).artifacts), report.artifacts);
  await openIntake();
  await expect(page.locator('.task-detail__monitor .vue-flow__node[data-id="verify"] .wf-graph-node__status')).toHaveText("已完成");
  await page.goto(`codeflow://desktop/chat?threadId=${encodeURIComponent(nodeThreadId)}`);
  await expect(page.getByText("本机节点正式交付完成。", { exact: true }).first()).toBeVisible();
  report.phase = "second-exit";
  await exit(second);
  assert.deepEqual(persistedEvidence(report.entities), report.persisted);
  report.cleanup = { status: "stopped", processes: report.processes };
  report.status = "passed";
} catch (error) {
  report.failedPhase = report.phase;
  if (page && !page.isClosed() && root) {
    try {
      report.uiMessages = await bounded(page.evaluate(() => window.packagedOrchestrationMessages), 5_000, "DESKTOP_ORCH_UI_MESSAGES_TIMEOUT");
      await bounded(fs.writeFile(path.join(root, "failed-ui.txt"), await bounded(page.locator("body").innerText(), 5_000, "DESKTOP_ORCH_UI_READ_TIMEOUT"), "utf8"), 5_000, "DESKTOP_ORCH_UI_WRITE_TIMEOUT");
    }
    catch (diagnosticError) { error = new AggregateError([error, diagnosticError], "DESKTOP_ORCH_DIAGNOSTIC_FAILED"); }
  }
  try { await cleanup(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "DESKTOP_ORCH_VERIFICATION_AND_CLEANUP_FAILED"); }
  verificationError = error;
  report.status = "failed";
  report.failure = failure(error);
  process.exitCode = 1;
}
if (reportPath) {
  try { await bounded(fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"), 5_000, "DESKTOP_ORCH_REPORT_WRITE_TIMEOUT"); }
  catch (error) {
    report.status = "failed";
    report.failure = failure(new AggregateError([...(verificationError ? [verificationError] : []), error], "DESKTOP_ORCH_REPORT_WRITE_FAILED"));
    process.exitCode = 1;
  }
}
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_ORCH_${report.status.toUpperCase()}`, requestId: report.requestId,
  reportPath, ...(report.failure ? { failedPhase: report.failedPhase, failure: report.failure, cleanup: report.cleanup } : {}) }));
