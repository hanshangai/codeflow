import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { _electron: electron, expect: playwrightExpect } = webRequire("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 30_000 });
const executablePath = createRequire(import.meta.url)("electron");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-electron-orchestration-"));
const workspacePath = path.join(root, "project");
const providerPath = path.join(root, "provider");
const fixturePath = path.join(providerPath, "fixture.json");
const sharedModulePath = `/@fs/${fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)).replaceAll("\\", "/")}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") && key !== "ELECTRON_RUN_AS_NODE"));
const nativePaths = ["auth.json", "config.toml"].map(name => path.join(os.homedir(), ".codex", name));
let application;
let stage = "prepare";

/** 只读比较原生配置字节；缺文件是合法状态，其他读取异常直接失败。 */
async function nativeConfigHashes() {
  return await Promise.all(nativePaths.map(async file => {
    try { return createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
    catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
  }));
}

/** 启动真实壳、preload、Client 和 Web；整个运行目录属于本脚本。 */
async function launch() {
  application = await electron.launch({ executablePath,
    args: [fileURLToPath(new URL("../dist/main.js", import.meta.url)), `--user-data-dir=${path.join(root, "profile")}`],
    env: { ...env, PATH: `${providerPath}${path.delimiter}${env.PATH ?? env.Path ?? ""}`,
      CODEFLOWAI_DESKTOP_DATA_DIR: path.join(root, "runtime"), CODEFLOWAI_DESKTOP_WEB_ENTRY: "http://localhost:39281" }, timeout: 60_000 });
  const page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("**/chat", { timeout: 60_000 });
  page.setDefaultTimeout(30_000);
  return page;
}

/** 调用真实关闭入口，退出完成后才允许读库或重启。 */
async function close() {
  if (!application) return;
  const current = application;
  await Promise.all([current.waitForEvent("close", { timeout: 30_000 }), current.evaluate(({ app }) => { app.quit(); })]);
  application = undefined;
}

/** 只调用 Vite 导出的正式 store/API，不注入业务状态或成功事件。 */
async function stores(page, action, args = {}) {
  return await page.evaluate(async ({ action, args, sharedModulePath }) => {
    const { useApiContext } = await import("/src/composables/useApiContext.ts");
    const { useChatStore } = await import("/src/store/chat.ts");
    const { useRequirementAnalysisStore } = await import("/src/store/requirementAnalysis.ts");
    const { useOrchestrationStore } = await import("/src/store/orchestration.ts");
    const { useConfigStore } = await import("/src/store/config.ts");
    const api = await import("/src/api/orchestration/index.ts");
    const shared = await import(sharedModulePath);
    const ctx = useApiContext().ctx.value;
    const config = useConfigStore();
    const chat = useChatStore();
    const analysis = useRequirementAnalysisStore();
    const orch = useOrchestrationStore();
    const workspaceId = args.workspaceId ?? config.workspaceId;
    if (action === "state") return { connected: config.connected, hasSession: Boolean(config.sessionToken), workspaceId, localReady: config.localRuntimeReady,
      clientId: config.desktopClient?.clientId ?? null,
      instance: orch.selectedInstance, candidates: analysis.candidates };
    if (action === "assets") {
      const executionConfig = shared.createDefaultRoleExecutionConfig("codex");
      const role = await api.upsertOrchRole(ctx, { workspaceId, role: { name: "本机验收角色", description: "最小本机验收", systemPrompt: "提交实际验收结果。",
        inputDefinition: shared.createDefaultRoleInputDefinition(), outputDefinition: shared.createDefaultRoleOutputDefinition(), executionConfig,
        gateCriteria: [], defaultKnowledgeBundleIds: [], defaultSkillIds: [], toolRefs: [] } });
      if (!role.ok) throw new Error(`role creation failed: ${role.message}`);
      const workflow = await api.upsertOrchWorkflow(ctx, { workspaceId, workflow: { name: "本机最小验收流程", description: "单一角色独立验收", version: 1,
        nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } },
          { id: "verify", type: "role", label: "本机验收节点", roleId: role.role.id, approvalMode: "auto", position: { x: 250, y: 0 } },
          { id: "end", type: "end", label: "完成", position: { x: 500, y: 0 } }],
        edges: [{ id: "start-verify", sourceNodeId: "start", targetNodeId: "verify", dataMappings: [] },
          { id: "verify-end", sourceNodeId: "verify", targetNodeId: "end", dataMappings: [] }] } });
      if (!workflow.ok) throw new Error(`workflow creation failed: ${workflow.message}`);
      return { roleId: role.role.id, workflowId: workflow.workflow.id };
    }
    if (action === "create-analysis") return await analysis.createSession(ctx, workspaceId, { title: "本机真实需求分析", engine: "codex" });
    if (action === "send") return await chat.sendMessage(ctx, { workspaceId, threadId: args.threadId, text: "请分析并创建本机编排闭环需求。", workMode: "general" });
    if (action === "analysis") { await analysis.loadSession(ctx, workspaceId, args.sessionId); return { session: analysis.selectedSession, candidates: analysis.candidates }; }
    if (action === "derive") return await analysis.createIntakes(ctx, workspaceId, [args.candidateId], [{ candidateId: args.candidateId, workflowId: args.workflowId }]);
    if (action === "edit") return await orch.saveIntake(ctx, workspaceId, { ...args.intake, title: "本机编排闭环已编辑", goal: "通过本机完整闭环并核对持久事实" });
    if (action === "proposal") {
      const proposal = await orch.createProposal(ctx, workspaceId, { intakeId: args.intakeId, workflowId: args.workflowId });
      await orch.confirmProposal(ctx, workspaceId, proposal.id);
      return proposal;
    }
    if (action === "start") return await orch.startProposal(ctx, workspaceId, args.proposalId);
    if (action === "load") return await orch.loadInstance(ctx, workspaceId, args.instanceId, { loadDetails: true });
    if (action === "pause") return await orch.pauseInstance(ctx, workspaceId, args.instanceId);
    if (action === "resume") return await orch.resumeInstance(ctx, workspaceId, args.instanceId);
    if (action === "cancel") return await orch.cancelInstance(ctx, workspaceId, args.instanceId);
    if (action === "rerun") return await orch.rerunInstanceFromNode(ctx, workspaceId, args.instanceId, "verify", "验证本机重跑与暂停恢复", { threadReusePolicy: "reuse-existing" });
    if (action === "feedback") return await orch.submitFeedback(ctx, workspaceId, args.instanceId, "verify", "resume_with_input", "业务验收确认，可以正式交付。");
    if (action === "evidence") {
      const artifacts = await api.listOrchArtifacts(ctx, { workspaceId, instanceId: args.instanceId, includeContent: true });
      const prompts = await api.listOrchPromptSnapshots(ctx, { workspaceId, instanceId: args.instanceId, includeContent: true });
      const events = await api.listOrchEvents(ctx, { workspaceId, instanceId: args.instanceId, limit: 200 });
      for (const value of [artifacts, prompts, events]) if (!value.ok) throw new Error(value.message ?? "evidence read failed");
      return { artifacts, prompts, events };
    }
    throw new Error(`unknown smoke action: ${action}`);
  }, { action, args, sharedModulePath });
}

/** 仅观察真实 preload 事件，不写业务 store，也不手动调用 reducer。 */
async function observeEvents(page) {
  await page.evaluate(() => {
    window.localOrchestrationSmokeEvents = [];
    window.codeflowDesktop.onEvent(value => {
      if (value.t === "orchestration.event") window.localOrchestrationSmokeEvents.push(value);
    });
  });
}

/** 每次导航等待原壳初始化完成，不伪造 ready 或覆盖配置。 */
async function waitReady(page, workspaceId) {
  await expect.poll(async () => {
    const state = await stores(page, "state");
    return Boolean(state.localReady && state.clientId && state.workspaceId === workspaceId);
  }, { timeout: 30_000 }).toBe(true);
}

/** 从正式需求卡片打开运行图，只读核对原页面展示的节点状态。 */
async function verifyGraph(page, title, expectedStatus = "已完成") {
  await page.goto("http://localhost:39281/orchestration/workspace");
  await expect(page.getByRole("button", { name: /切换工作区，当前 本机流程验收/ })).toBeVisible();
  await page.locator(".ant-segmented-item").filter({ hasText: "需求编排" }).click();
  const intakeCard = page.locator(".task-sidebar__card").filter({ hasText: title });
  await expect(intakeCard).toBeVisible();
  await intakeCard.click();
  const graphNode = page.locator('.task-detail__monitor .vue-flow__node[data-id="verify"]');
  await expect(graphNode).toBeVisible();
  await expect(graphNode.locator(".wf-graph-node__status")).toHaveText(expectedStatus);
}

/** 只读最终真实持久化记录，不准备、修补或注入业务事实。 */
function persistedEvidence(instanceId, analysisThreadId, nodeThreadId) {
  const db = new DatabaseSync(path.join(root, "runtime", "codeflowai.db"), { readOnly: true });
  try {
    const count = (table, column, id) => Number(db.prepare(`SELECT count(*) AS total FROM ${table} WHERE ${column} = ?`).get(id).total);
    const instance = db.prepare("SELECT status FROM orch_instances WHERE id = ?").get(instanceId);
    assert.equal(instance?.status, "completed");
    for (const threadId of [analysisThreadId, nodeThreadId]) {
      assert.ok(count("conversation_events", "thread_id", threadId) > 0, `canonical events absent: ${threadId}`);
      assert.ok(count("raw_engine_events", "thread_id", threadId) > 0, `raw events absent: ${threadId}`);
      assert.ok(db.prepare("SELECT count(*) AS total FROM thread_turns WHERE thread_id = ? AND status = 'completed'").get(threadId).total > 0);
    }
    for (const table of ["orch_artifacts", "orch_prompt_snapshots", "orch_events", "orch_feedback_records"]) assert.ok(count(table, "instance_id", instanceId) > 0, `${table} absent`);
    return { canonical: count("conversation_events", "thread_id", nodeThreadId), raw: count("raw_engine_events", "thread_id", nodeThreadId),
      artifacts: count("orch_artifacts", "instance_id", instanceId), prompts: count("orch_prompt_snapshots", "instance_id", instanceId) };
  } finally { db.close(); }
}

const nativeBefore = await nativeConfigHashes();
try {
  await fs.mkdir(workspacePath);
  await prepareProvider(providerPath);
  stage = "launch";
  let page = await launch();
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await create.locator('input[name="codeflow-workspace-title"]').fill("本机流程验收");
  await create.locator('input[name="codeflow-workspace-path"]').fill(workspacePath);
  await create.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole("button", { name: /切换工作区，当前 本机流程验收/ })).toBeVisible();
  const initial = await stores(page, "state");
  assert.equal(initial.connected, false, "smoke must run without Server connection");
  assert.equal(initial.hasSession, false, "smoke must run without account");
  const workspaceId = initial.workspaceId;
  stage = "assets";
  const assets = await stores(page, "assets", { workspaceId });
  await fs.writeFile(fixturePath, JSON.stringify(assets), "utf8");
  stage = "requirement-analysis";
  const session = await stores(page, "create-analysis", { workspaceId });
  await page.goto(`http://localhost:39281/chat?threadId=${encodeURIComponent(session.runtimeThreadId)}`);
  await waitReady(page, workspaceId);
  await stores(page, "send", { workspaceId, threadId: session.runtimeThreadId });
  await expect(page.getByText("已形成可独立验收的本机候选需求。", { exact: true }).first()).toBeVisible();
  const analysis = await stores(page, "analysis", { workspaceId, sessionId: session.id });
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0].readyToCreate, true);
  stage = "derive-edit-proposal";
  const derived = await stores(page, "derive", { workspaceId, candidateId: analysis.candidates[0].id, workflowId: assets.workflowId });
  assert.equal(derived.created.length, 1);
  const edited = await stores(page, "edit", { workspaceId, intake: derived.created[0].intake });
  assert.equal(edited.title, "本机编排闭环已编辑");
  const proposal = await stores(page, "proposal", { workspaceId, intakeId: edited.id, workflowId: assets.workflowId });
  assert.equal(proposal.intakeSnapshot.title, edited.title);
  stage = "start-native-interactions";
  await observeEvents(page);
  const instanceId = await stores(page, "start", { workspaceId, proposalId: proposal.id });
  await expect.poll(async () => await page.evaluate(id => window.localOrchestrationSmokeEvents.some(value => value.event.instanceId === id), instanceId)).toBe(true);
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId }))?.nodeStates.verify?.threadId).toBeTruthy();
  const running = await stores(page, "load", { workspaceId, instanceId });
  const nodeThreadId = running.nodeStates.verify.threadId;
  await page.goto(`http://localhost:39281/chat?threadId=${encodeURIComponent(nodeThreadId)}`);
  await waitReady(page, workspaceId);
  await observeEvents(page);
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
  stage = "business-feedback";
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId }))?.nodeStates.verify?.status).toBe("waiting-feedback");
  await stores(page, "feedback", { workspaceId, instanceId });
  await expect(page.getByText("本机节点正式交付完成。", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => await page.evaluate(id => window.localOrchestrationSmokeEvents.some(value => value.event.instanceId === id && value.event.type === "orchestration.completed"), instanceId)).toBe(true);
  await expect.poll(async () => (await stores(page, "state"))?.instance?.status).toBe("completed");
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId }))?.status).toBe("completed");
  stage = "rerun-pause-resume";
  await fs.writeFile(fixturePath, JSON.stringify({ ...assets, hold: true }), "utf8");
  await stores(page, "rerun", { workspaceId, instanceId });
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId }))?.nodeStates.verify?.status).toBe("running");
  await expect.poll(async () => (await fs.readFile(path.join(providerPath, "audit.jsonl"), "utf8")).includes('"method":"turn.held"')).toBe(true);
  await stores(page, "pause", { workspaceId, instanceId });
  assert.equal((await stores(page, "load", { workspaceId, instanceId })).status, "paused");
  await fs.writeFile(fixturePath, JSON.stringify(assets), "utf8");
  await stores(page, "resume", { workspaceId, instanceId });
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId }))?.status).toBe("completed");
  await verifyGraph(page, edited.title);
  stage = "cancel";
  await fs.writeFile(fixturePath, JSON.stringify({ ...assets, hold: true }), "utf8");
  const cancelProposal = await stores(page, "proposal", { workspaceId, intakeId: edited.id, workflowId: assets.workflowId });
  const cancelledInstanceId = await stores(page, "start", { workspaceId, proposalId: cancelProposal.id });
  await expect.poll(async () => (await stores(page, "load", { workspaceId, instanceId: cancelledInstanceId }))?.nodeStates.verify?.status).toBe("running");
  await stores(page, "cancel", { workspaceId, instanceId: cancelledInstanceId });
  assert.equal((await stores(page, "load", { workspaceId, instanceId: cancelledInstanceId })).status, "cancelled");
  await fs.writeFile(fixturePath, JSON.stringify(assets), "utf8");
  await stores(page, "load", { workspaceId, instanceId });
  const evidence = await stores(page, "evidence", { workspaceId, instanceId });
  assert.ok(JSON.stringify(evidence.artifacts).includes("本机编排产物"));
  assert.ok(evidence.prompts.snapshots.length >= 3);
  assert.ok(evidence.prompts.snapshots.some(snapshot => [snapshot.systemMessage, snapshot.developerMessage].join("\n").includes("runtime.submitNodeResult")
    && snapshot.userMessage.includes(edited.title) && snapshot.nodeId === "verify"));
  assert.ok(evidence.events.events.length > 0);
  const audit = (await fs.readFile(path.join(providerPath, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const method of ["aidt_runtime_submitRequirementAnalysisTurnResult", "aidt_runtime_submitNodeResult", "approval.accepted", "input.accepted", "thread/resume", "turn/interrupt"]) assert.ok(audit.some(row => row.method === method), `${method} was not exercised`);
  assert.ok(!audit.some(row => row.method === "fixture.failed"));
  stage = "restart-recovery";
  await close();
  const persisted = persistedEvidence(instanceId, session.runtimeThreadId, nodeThreadId);
  page = await launch();
  await page.goto(`http://localhost:39281/chat?threadId=${encodeURIComponent(nodeThreadId)}`);
  await waitReady(page, workspaceId);
  await expect(page.getByText("本机节点正式交付完成。", { exact: true }).first()).toBeVisible();
  const restored = await stores(page, "load", { workspaceId, instanceId });
  assert.equal(restored.status, "completed");
  assert.equal(restored.intakeSnapshot.title, "本机编排闭环已编辑");
  await verifyGraph(page, edited.title, "已取消");
  const recoveredAnalysis = await stores(page, "analysis", { workspaceId, sessionId: session.id });
  assert.equal(recoveredAnalysis.candidates[0].createdIntakeId, edited.id);
  assert.equal((await stores(page, "load", { workspaceId, instanceId: cancelledInstanceId })).status, "cancelled");
  await stores(page, "load", { workspaceId, instanceId });
  const recoveredEvidence = await stores(page, "evidence", { workspaceId, instanceId });
  assert.deepEqual(recoveredEvidence.artifacts.artifacts.map(value => value.id), evidence.artifacts.artifacts.map(value => value.id));
  await close();
  assert.deepEqual(persistedEvidence(instanceId, session.runtimeThreadId, nodeThreadId), persisted);
  console.log("Electron local orchestration smoke passed: real RA, dynamic tools, intake, proposal, native approval/input, feedback, artifacts, prompt/raw and restart recovery (controlled provider; no paid-model validation).");
} catch (error) {
  console.error(`Electron local orchestration smoke failed at ${stage}:`, error);
  try {
    const audit = await fs.readFile(path.join(providerPath, "audit.jsonl"), "utf8");
    console.error("Controlled provider method audit:", audit.trim().split("\n").map(line => JSON.parse(line)));
  } catch (diagnosticError) {
    if (diagnosticError.code !== "ENOENT") throw new AggregateError([error, diagnosticError], "Smoke failed and provider audit could not be read");
  }
  throw error;
} finally {
  try { await close(); }
  finally {
    try { assert.deepEqual(await nativeConfigHashes(), nativeBefore, "smoke changed native Codex files"); }
    finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  }
}
