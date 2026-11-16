import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { OrchInstanceSummaryProjectionReader } from "../src/db/orchInstanceSummaryProjection.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { OrchEventRepo } from "../src/db/repos/orchEventRepo.ts";
import { OrchIntakeListStateRepo } from "../src/db/repos/orchIntakeListStateRepo.ts";
import { ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { ThreadQueueStateRepo } from "../src/db/repos/threadQueueStateRepo.ts";
import * as runtime from "../src/orchestration/orchAssetAuthorityRuntimeReadService.ts";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.ts";
import { shouldRecoverPersistedOrchestrationInstance } from "../src/orchestration/orchestrationEngine.ts";
import { OrchInstanceRepo, OrchInstanceScopeError } from "../src/db/repos/orchInstanceRepo.ts";
import { OrchAssetLaunchSnapshotError } from "../src/orchestration/orchAssetLaunchSnapshotService.ts";

const workspaceId = "desktop-device:project" as WorkspaceId;

test("desktop execution authority requires exact local ownership and rejects every persisted shared marker", () => {
  const select = (runtime as any).isDesktopLocalAssetExecution;
  assert.equal(typeof select, "function");
  const workspaces = new Map([[workspaceId, "project"]]);
  const local = { workspaceId };
  assert.equal(select("desktop-device", workspaces, local), true);
  for (const target of [null, { workspaceId: "other:project" }, { workspaceId: "project" },
    { workspaceId: "desktop-device:project:extra" }, { ...local, sharedWorkspaceId: "shared" },
    { ...local, sharedContext: { sharedWorkspaceId: "shared" } },
    { ...local, intakeSnapshot: { sharedContext: { sharedWorkspaceId: "shared" } } },
    { ...local, runtimeConfig: { executionProfileScope: { scopeType: "shared_workspace", scopeId: "shared" } } }]) {
    assert.equal(select("desktop-device", workspaces, target), false);
  }
});

test("unprojected node threads use their live parent instance authority", () => {
  const select = (runtime as any).isDesktopLocalThreadAssetExecution;
  assert.equal(typeof select, "function");
  const workspaces = new Map([[workspaceId, "project"]]);
  const node = { workspaceId, threadSubtype: "node", sharedWorkspaceId: null };
  const parent = { id: "parent", workspaceId, intakeSnapshot: { workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } }, status: "running", nodeStates: { node: { threadId: "node-thread", status: "pending" } }, createdAt: 1, updatedAt: 1 };
  let current: any = { ...parent, intakeSnapshot: { sharedContext: { sharedWorkspaceId: "shared" } } };
  const db = { threads: { get: () => node }, orchInstances: { listByWorkspace: () => [current], get: () => current } };
  assert.equal(select("desktop-device", workspaces, db, "node-thread"), false);
  current = parent;
  assert.equal(select("desktop-device", workspaces, db, "node-thread"), true);
  current = { ...parent, status: "completed" };
  assert.equal(select("desktop-device", workspaces, db, "node-thread"), true);
  current = { ...parent, nodeStates: {} };
  assert.equal(select("desktop-device", workspaces, db, "node-thread"), false);
});

test("actual desktop canonical send boundary stores shared node events without publishing them to the personal renderer", (t) => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const start = source.indexOf("  const sendToServer = (message:");
  const end = source.indexOf("  const takeApiResponseDispatch", start);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(`${source.slice(start, end)}\nreturn sendToServer;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-private-events-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspace = new Map([[workspaceId, directory]]);
  db.workspaces.upsert({ id: workspaceId, title: "Private events", path: directory });
  const workflow = db.orchWorkflows.upsert({ workspaceId, name: "Private", description: "Private", version: 1,
    nodes: [{ id: "node", type: "start", label: "Node", position: { x: 0, y: 0 } }], edges: [] });
  for (const [threadId, shared] of [["shared-node", true], ["local-node", false]] as const) {
    db.threads.create({ id: threadId as any, workspaceId, engine: "codex", title: threadId, threadType: "orchestration", threadSubtype: "node" });
    const parent = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: {
      id: `intake-${threadId}`, workspaceId, triggerMode: "manual", taskType: "feature", title: "Private", goal: "Private", createdAt: 1, updatedAt: 1,
      workspaceScope: { scopeType: shared ? "shared_workspace" : "local_workspace", scopeId: shared ? "shared" : workspaceId },
      ...(shared ? { sharedContext: { sharedWorkspaceId: "shared" } } : {}),
    } as any });
    db.orchInstances.updateNodeStates(parent.id, { node: { ...parent.nodeStates.node!, threadId: threadId as any, status: "completed" } });
    db.orchInstances.updateStatus(parent.id, "completed");
  }
  const published: any[] = [];
  const createSend = new Function("sanitizeClientToServerMessage", "keepFullEventOutput", "desktopLifecycle", "localEventPersistence", "config", "workspaces", "db",
    "isDesktopLocalThreadAssetExecution", "flushLocalEventRelay", "logger", "toErrorLogValue", "desktopRequestId", "isDesktopLocalAssetExecution", "transport", "desktopCloudAccount", compiled);
  const send = createSend((value: any) => value, false, { publishEvent: (value: any) => published.push(value) },
    createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} }), { clientId: "desktop-device" }, workspace, db,
    runtime.isDesktopLocalThreadAssetExecution, () => {}, { error() {} }, (error: unknown) => String(error), "private-events", runtime.isDesktopLocalAssetExecution, null);
  const event = { t: "conversation.event", event: { threadId: "shared-node", workspaceId, engine: "codex", ts: Date.now(), type: "turn.completed", payload: { turnId: "turn-private" } } };
  assert.equal(send(event).accepted, true);
  assert.ok(db.conversationEvents.getLatestSeqByThread("shared-node" as any) > 0);
  assert.equal(published.length, 0);
  assert.equal(send({ ...event, event: { ...event.event, threadId: "local-node" } }).accepted, true);
  assert.equal(published.length, 1);
  const localInstance = db.orchInstances.listByWorkspace(workspaceId).find(instance => instance.nodeStates.node?.threadId === "local-node")!;
  const record = db.orchEvents.append({ instanceId: localInstance.id, nodeId: null, type: "orchestration.completed", payloadJson: "{}" });
  const countBefore = db.orchEvents.listByInstance(localInstance.id).length;
  assert.equal(send({ t: "orchestration.event", workspaceId, event: record }).accepted, true);
  assert.equal(published.at(-1).event.id, record.id);
  assert.equal(db.orchEvents.listByInstance(localInstance.id).length, countBefore, "投递不能重复持久化 Engine 的原编排事件");
  const sharedInstance = db.orchInstances.listByWorkspace(workspaceId).find(instance => instance.nodeStates.node?.threadId === "shared-node")!;
  const publishedBefore = published.length;
  assert.equal(send({ t: "orchestration.event", workspaceId, event: { ...record, instanceId: sharedInstance.id } }).accepted, false);
  assert.equal(published.length, publishedBefore);
  for (const [threadId, scopeType] of [["local-ra", "local_workspace"], ["shared-ra", "shared_workspace"], ["unknown-ra", null], ["missing-ra", undefined]] as const) {
    db.threads.create({ id: threadId as any, workspaceId, engine: "codex", title: threadId, threadSubtype: "requirement-analysis" });
    if (scopeType !== undefined) db.orchRequirementAnalysisSessions.create({ id: threadId as any, workspaceId, title: threadId, status: "active", phase: "discover", engine: "codex", runtimeThreadId: threadId as any,
      workspaceScope: scopeType ? { scopeType, scopeId: scopeType === "local_workspace" ? workspaceId : "shared" } : null });
    const count = published.length;
    assert.equal(send({ ...event, event: { ...event.event, threadId } }).accepted, true);
    assert.ok(db.conversationEvents.getLatestSeqByThread(threadId as any) > 0);
    assert.equal(published.length, count + (scopeType === "local_workspace" ? 1 : 0));
  }
  assert.throws(() => send({ ...event, event: { ...event.event, threadId: "unknown" } }));
  assert.equal(published.length, 3);
});

test("desktop runtime strict reader rejects damaged definitions before normalized repository reads hide them", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-runtime-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "Local", path: directory });
  const role = db.orchRoles.upsert({ workspaceId, name: "Role", description: "Role", systemPrompt: "Role",
    inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
    executionConfig: createDefaultRoleExecutionConfig("codex"), gateCriteria: [], defaultSkillIds: [] });
  const reader = runtime.createClientDbOrchAssetLegacyRuntimeReader(db, { requireCompleteDefinitions: true });
  assert.ok(reader.getAsset(workspaceId, "role", role.id));
  db.db.prepare("UPDATE orch_roles SET definition_json = ? WHERE id = ?").run(JSON.stringify({ name: "Minimal", systemPrompt: "" }), role.id);
  assert.ok(reader.getAsset(workspaceId, "role", role.id), "optional role fields keep their established defaults");
  db.db.prepare("UPDATE orch_roles SET definition_json = ? WHERE id = ?").run("{}", role.id);
  assert.throws(() => reader.getAsset(workspaceId, "role", role.id), /角色|定义/);
});

/** 观测子进程恢复时只读现有库，避免迁移修复与恢复事务争抢写锁。 */
function openRecoveryReader(dbPath: string) {
  const db = openSqliteDb(dbPath, { readonly: true, fileMustExist: true });
  const summaries = new OrchInstanceSummaryProjectionReader(db);
  const listStates = new OrchIntakeListStateRepo(db, summaries);
  return {
    db,
    threadMessageQueue: new ThreadMessageQueueRepo(db, new FileBlobRepo(db)),
    threadQueueStates: new ThreadQueueStateRepo(db),
    orchInstances: new OrchInstanceRepo(db, listStates, summaries),
    orchEvents: new OrchEventRepo(db),
    /** 释放本次观测连接。 */
    close: () => db.close(),
  };
}

/** 独立 Client 子进程验证恢复；坏冻结身份或配置必须在读取执行配置前隔离。 */
async function verifyDesktopStartupRecovery(t: test.TestContext, damagedRa = false, damagedFrozen = false, damagedProfile = false): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-desktop-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project");
  const bundles = path.join(directory, "builtins");
  fs.mkdirSync(project);
  fs.mkdirSync(bundles);
  fs.copyFileSync(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), path.join(bundles, "defaultAssetBundle.v1.json"));
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ clientId: "desktop-device", apiKey: "", serverWs: "ws://127.0.0.1:1/ws/client" }), "utf8");
  fs.writeFileSync(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const dbPath = path.join(directory, "client.db");
  fs.writeFileSync(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }), "utf8");
  const db = openClientDb({ dbPath });
  let localInstance: string;
  let sharedInstance: string;
  let damagedInstance: string;
  let unknownInstance: string;
  let localItem: string;
  let sharedItem: string;
  let sharedNodeItem: string;
  let localRaItem: string;
  let sharedRaItem: string;
  let unknownRaItem: string;
  let missingRaItem: string;
  let damagedRaItem: string;
  try {
    db.workspaces.upsert({ id: workspaceId, title: "Local", path: project });
    const workflow = db.orchWorkflows.upsert({ workspaceId, name: "Recovery", description: "Recovery",
      nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [], version: 1 });
    const intake = { id: "intake-recovery", workspaceId, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId }, title: "Recovery", goal: "Recovery", triggerMode: "manual", taskType: "feature", createdAt: 1, updatedAt: 1 } as any;
    const local = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
    const shared = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
      intakeSnapshot: { ...intake, id: "intake-shared", sharedContext: { sharedWorkspaceId: "shared-workspace" } } });
    const damaged = db.orchInstances.create({ workspaceId, workflowId: workflow.id,
      workflowSnapshot: damagedProfile ? workflow : { ...workflow, nodes: [{ id: "missing", type: "role", roleId: "missing-role", label: "Missing", position: { x: 0, y: 0 } }] } as any,
      intakeSnapshot: { ...intake, id: "intake-damaged" } });
    localInstance = local.id;
    sharedInstance = shared.id;
    damagedInstance = damaged.id;
    const unknown = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: { ...intake, id: "intake-unknown", workspaceScope: null } });
    unknownInstance = unknown.id;
    db.orchInstances.updateStatus(unknown.id, "running");
    if (damagedFrozen) db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...intake, id: "intake-damaged", workspaceId: "PRIVATE_STARTUP_FROZEN_BODY" }), damaged.id);
    if (damagedProfile) db.db.prepare("UPDATE orch_instances SET runtime_config_json = ? WHERE id = ?").run(JSON.stringify({ executionProfileScope: { scopeType: "local_workspace", scopeId: "other-device:PRIVATE_STARTUP_PROFILE" } }), damaged.id);
    for (const instance of [local, shared, damaged]) db.orchInstances.updateStatus(instance.id, "running");
    db.orchInstances.updateNodeStates(local.id, { start: { ...local.nodeStates.start!, status: "running", startedAt: 1 } });
    const queueOptions = { workMode: "general", planMode: false, model: "model-that-is-not-configured", effort: null, accessMode: null,
      contextWindow: null, autoCompactPct: null, serviceTier: null } as any;
    const addQueue = (id: string, sharedWorkspaceId: string | null): string => {
      db.db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, shared_workspace_id, created_at, updated_at) VALUES (?, ?, 'codex', 'Queue', 'chat', ?, 1, 1)")
        .run(id, workspaceId, sharedWorkspaceId);
      return db.threadMessageQueue.appendItem({ workspaceId, threadId: id as any, text: "Do not call a provider", images: [], files: [],
        sendOptions: queueOptions, originWebSessionId: null,
        executionProfileContext: { userId: "local:desktop-device", scope: { scopeType: "local_workspace", scopeId: workspaceId } } }).item.id;
    };
    localItem = addQueue("local-queue", null);
    sharedItem = addQueue("shared-queue", "shared-workspace");
    sharedNodeItem = addQueue("shared-unprojected-node", null);
    db.db.prepare("UPDATE threads SET thread_type = 'orchestration', thread_subtype = 'node' WHERE id = ?").run("shared-unprojected-node");
    db.orchInstances.updateNodeStates(shared.id, { start: { ...shared.nodeStates.start!, status: "pending", threadId: "shared-unprojected-node" as any } });
    for (const [id, scope] of [["local-ra", "local_workspace"], ["shared-ra", "shared_workspace"], ["unknown-ra", null], ["missing-ra", undefined]] as const) {
      const item = addQueue(id, null);
      db.db.prepare("UPDATE threads SET thread_subtype = 'requirement-analysis' WHERE id = ?").run(id);
      if (scope !== undefined) db.orchRequirementAnalysisSessions.create({ id: id as any, workspaceId, title: id, status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as any,
        workspaceScope: scope ? { scopeType: scope, scopeId: scope === "local_workspace" ? workspaceId : "shared" } : null });
      if (id === "local-ra") localRaItem = item;
      if (id === "shared-ra") sharedRaItem = item;
      if (id === "unknown-ra") unknownRaItem = item;
      if (id === "missing-ra") missingRaItem = item;
    }
    if (damagedRa) {
      damagedRaItem = addQueue("damaged-ra", null);
      db.db.prepare("UPDATE threads SET thread_subtype = 'requirement-analysis' WHERE id = 'damaged-ra'").run();
      db.orchRequirementAnalysisSessions.create({ id: "damaged-ra" as any, workspaceId, title: "Damaged", status: "active", phase: "discover", engine: "codex", runtimeThreadId: "damaged-ra" as any });
      db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = 'damaged-ra'").run("{PRIVATE_STARTUP_RA_BODY");
    }
  } finally { db.close(); }

  const requestId = crypto.randomUUID();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
    execArgv: ["--conditions=development", "--import", "tsx"],
    env: { ...env, CODEFLOWAI_DESKTOP_REQUEST_ID: requestId, CODEFLOWAI_VERSION: "1.0.0", CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: bundles,
      CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(directory, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: dbPath,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(directory, "logs") }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout!.setEncoding("utf8").on("data", value => { stdout = (stdout + value).slice(-12_000); });
  child.stderr!.setEncoding("utf8").on("data", value => { stderr += value; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DESKTOP_RECOVERY_READY_TIMEOUT: ${stderr}; ${stdout}`)), 15_000);
      child.on("message", (message: any) => { if (message?.t === "desktop.ready" && message.requestId === requestId) { clearTimeout(timer); resolve(); } });
      void exited.then(code => { clearTimeout(timer); reject(new Error(`Client exited: ${code}; ${stderr}`)); }, reject);
    });
    const reader = openRecoveryReader(dbPath);
    try {
      const until = Date.now() + 5_000;
      while (Date.now() < until && (reader.threadMessageQueue.getById(localItem!)?.status !== "failed"
        || reader.threadMessageQueue.getById(localRaItem!)?.status !== "failed"
        || !reader.orchEvents.listByInstance(localInstance! as any).some(event => event.type === "orchestration.recovered"))) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const item = reader.threadMessageQueue.getById(localItem!);
      assert.equal(item?.status, "failed");
      assert.equal(reader.threadMessageQueue.getById(sharedItem!)?.status, "pending");
      assert.equal(reader.threadMessageQueue.getById(sharedItem!)?.attemptCount, 0);
      assert.equal(reader.threadMessageQueue.getById(sharedNodeItem!)?.status, "pending");
      assert.equal(reader.threadMessageQueue.getById(sharedNodeItem!)?.attemptCount, 0);
      assert.equal(reader.threadMessageQueue.getById(localRaItem!)?.status, "failed", JSON.stringify({ item: reader.threadMessageQueue.getById(localRaItem!), state: reader.threadQueueStates.getState("local-ra" as any), stderr }));
      for (const item of [sharedRaItem!, unknownRaItem!, missingRaItem!]) {
        assert.equal(reader.threadMessageQueue.getById(item)?.status, "pending");
        assert.equal(reader.threadMessageQueue.getById(item)?.attemptCount, 0);
      }
      if (damagedRa) {
        const failed = reader.threadMessageQueue.getById(damagedRaItem!);
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.failureCode, "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
        assert.equal(failed?.attemptCount, 0);
        assert.equal(reader.threadQueueStates.getState("damaged-ra" as any).paused, true);
        const lines = fs.readdirSync(path.join(directory, "logs")).filter(name => name.endsWith(".log"))
          .flatMap(name => fs.readFileSync(path.join(directory, "logs", name), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
        const failures = lines.filter(entry => entry.errorCode === "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID" && entry.threadId === "damaged-ra");
        assert.equal(failures.length, 1);
        assert.equal(failures[0].workspaceId, workspaceId);
        assert.equal(failures[0].requestId, `queue-recovery:damaged-ra`);
        assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_STARTUP_RA_BODY/);
      }
      const restored = reader.orchInstances.get(localInstance! as any);
      assert.equal(restored?.assetRuntimeSnapshot?.authorityMode, "legacy");
      assert.ok(reader.orchEvents.listByInstance(localInstance! as any).some(event => event.type === "orchestration.recovered"),
        JSON.stringify({ status: restored?.status, nodes: restored?.nodeStates, events: reader.orchEvents.listByInstance(localInstance! as any) }));
      assert.equal(reader.orchInstances.get(sharedInstance! as any)?.assetRuntimeSnapshot, null);
      assert.equal(reader.orchInstances.get(sharedInstance! as any)?.status, "running");
      assert.equal(reader.orchInstances.get(unknownInstance! as any)?.assetRuntimeSnapshot, null);
      assert.equal(reader.orchInstances.get(unknownInstance! as any)?.status, "running");
      assert.equal(reader.orchInstances.get(damagedInstance! as any)?.status, "paused");
      assert.ok(reader.orchEvents.listByInstance(damagedInstance! as any).some(event => JSON.parse(event.payloadJson).code === (damagedFrozen || damagedProfile ? "ORCH_INSTANCE_SCOPE_INVALID" : "ORCHESTRATION_SNAPSHOT_BACKFILL_FAILED")));
      if (damagedProfile) {
        assert.equal((reader.db.prepare("SELECT runtime_config_json FROM orch_instances WHERE id = ?").get(damagedInstance!) as any).runtime_config_json,
          JSON.stringify({ executionProfileScope: { scopeType: "local_workspace", scopeId: "other-device:PRIVATE_STARTUP_PROFILE" } }));
        assert.equal(reader.orchInstances.get(damagedInstance! as any)?.assetRuntimeSnapshot, null);
        const events = reader.orchEvents.listByInstance(damagedInstance! as any);
        assert.equal(events.some(event => event.type === "orchestration.assetRuntimeSnapshotBackfilled" || event.type === "orchestration.recovered" || event.type === "orchestration.nodeStarted"), false);
        const failure = events.find(event => event.type === "orchestration.error")!;
        assert.equal(JSON.parse(failure.payloadJson).reason, "local_profile_workspace_mismatch");
        assert.doesNotMatch(JSON.stringify(events), /PRIVATE_STARTUP_PROFILE/);
      }
      if (damagedFrozen || damagedProfile) {
        const lines = fs.readdirSync(path.join(directory, "logs")).filter(name => name.endsWith(".log"))
          .flatMap(name => fs.readFileSync(path.join(directory, "logs", name), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
        assert.equal(lines.filter(entry => entry.errorCode === "ORCH_INSTANCE_SCOPE_INVALID" && entry.instanceId === damagedInstance).length, 1);
        assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_STARTUP_FROZEN_BODY|PRIVATE_STARTUP_PROFILE/);
      }
    } finally { reader.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const killTimer = setTimeout(() => child.kill(), 10_000);
      try { child.send({ t: "desktop.shutdown", requestId }); assert.equal(await exited, 0, stderr); }
      finally { clearTimeout(killTimer); }
    }
  }
  if (damagedRa || damagedFrozen) {
    const restarted = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
      execArgv: ["--conditions=development", "--import", "tsx"], env: { ...env,
        CODEFLOWAI_DESKTOP_REQUEST_ID: requestId, CODEFLOWAI_VERSION: "1.0.0", CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: bundles,
        CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(directory, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: dbPath,
        CODEFLOWAI_CLIENT_LOG_DIR: path.join(directory, "logs") }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let restartError = "";
    restarted.stderr!.setEncoding("utf8").on("data", value => { restartError += value; });
    const restartedExit = new Promise<number | null>((resolve, reject) => { restarted.once("error", reject); restarted.once("exit", resolve); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`DESKTOP_RA_RESTART_TIMEOUT: ${restartError}`)), 15_000);
        restarted.on("message", (message: any) => { if (message?.t === "desktop.ready" && message.requestId === requestId) { clearTimeout(timer); resolve(); } });
        void restartedExit.then(code => { clearTimeout(timer); reject(new Error(`Restart exited: ${code}; ${restartError}`)); }, reject);
      });
      const reader = openRecoveryReader(dbPath);
      try {
        if (damagedRa) {
          assert.equal(reader.threadMessageQueue.getById(damagedRaItem!)?.status, "failed");
          assert.equal(reader.threadQueueStates.getState("damaged-ra" as any).paused, true);
        }
        if (damagedFrozen) {
          assert.equal(reader.orchInstances.get(damagedInstance! as any)?.status, "paused");
          const lines = fs.readdirSync(path.join(directory, "logs")).filter(name => name.endsWith(".log"))
            .flatMap(name => fs.readFileSync(path.join(directory, "logs", name), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
          assert.equal(lines.filter(entry => entry.errorCode === "ORCH_INSTANCE_SCOPE_INVALID" && entry.instanceId === damagedInstance).length, 1);
          assert.equal(reader.orchEvents.listByInstance(damagedInstance! as any).filter(event => event.type === "orchestration.error" && JSON.parse(event.payloadJson).code === "ORCH_INSTANCE_SCOPE_INVALID").length, 1);
          assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_STARTUP_FROZEN_BODY/);
        }
        for (const item of [sharedRaItem!, unknownRaItem!, missingRaItem!]) {
          assert.equal(reader.threadMessageQueue.getById(item)?.status, "pending");
          assert.equal(reader.threadMessageQueue.getById(item)?.attemptCount, 0);
        }
      } finally { reader.close(); }
    } finally {
      if (restarted.exitCode === null && restarted.signalCode === null) {
        const timer = setTimeout(() => restarted.kill(), 10_000);
        try { restarted.send({ t: "desktop.shutdown", requestId }); assert.equal(await restartedExit, 0, restartError); }
        finally { clearTimeout(timer); }
      }
    }
  }
}

test("real desktop startup restores local snapshots and queues without activating shared work in the same workspace", t => verifyDesktopStartupRecovery(t));
test("real desktop startup isolates corrupt RA queue authority while other queues and Client remain available", t => verifyDesktopStartupRecovery(t, true));
test("real desktop startup isolates corrupt frozen instance while healthy recovery and Client remain available", t => verifyDesktopStartupRecovery(t, false, true));
test("real desktop startup rejects cross-workspace local profile before backfill or execution", t => verifyDesktopStartupRecovery(t, false, false, true));

test("actual preparation and recovery preserve remote candidates and propagate unclassified failures", async () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const recoveryStart = source.indexOf("  const recoverRunningOrchestrations = async");
  const recoveryEnd = source.indexOf("  let desktopHostScopes:", recoveryStart);
  const prepareStart = source.indexOf("  const preparePersistedOrchestrationInstances =");
  const prepareEnd = source.indexOf("  // 持久 ApiHandlerContext", prepareStart);
  assert.ok(recoveryStart > 0 && recoveryEnd > recoveryStart && prepareStart > 0 && prepareEnd > prepareStart);
  const compiled = ts.transpileModule(`${source.slice(recoveryStart, recoveryEnd)}\n${source.slice(prepareStart, prepareEnd)}\nreturn { recoverRunningOrchestrations, preparePersistedOrchestrationInstances };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const instances = [
    { id: "running", status: "running", nodeStates: {} },
    { id: "pending-node", status: "pending", nodeStates: { node: { status: "running" } } },
    { id: "untouched", status: "pending", nodeStates: {} },
    { id: "paused", status: "paused", nodeStates: { node: { status: "running" } } },
    { id: "completed", status: "completed", nodeStates: {} },
  ].map(instance => ({ ...instance, workspaceId }));
  const prepared: string[] = [], normalized: string[] = [], recovered: string[] = [];
  let failure: Error | null = null;
  const db = { db: { prepare(sql: string) { return { all() { return instances.filter(instance => !["completed", "failed", "cancelled", ...(sql.includes("'paused'") ? ["paused"] : [])].includes(instance.status)).map(instance => ({ id: instance.id })); } }; } },
    orchInstances: { get(id: string, options: any) { assert.equal(options.strictScope, false); return instances.find(instance => instance.id === id); } } };
  const make = new Function("db", "workspaces", "desktopLifecycle", "config", "orchRecoveryStarted", "orchEngine", "orchAssetLegacyInstanceBackfill", "desktopOrchAssetLegacyInstanceBackfill", "isDesktopLocalAssetExecution",
    "shouldRecoverPersistedOrchestrationInstance", "logClientStep", "logger", "OrchInstanceScopeError", "OrchAssetLaunchSnapshotError", "isolatePersistedInstanceFailure", compiled);
  const create = () => make(db, new Map([[workspaceId, "project"]]), null, { clientId: "desktop-device" }, new Set(),
    { normalizePersistedInstanceStatus(id: string) { normalized.push(id); }, async recover(id: string) { if (failure) throw failure; recovered.push(id); } },
    { ensureForExecution(id: string) { if (failure) throw failure; prepared.push(id); } }, null, runtime.isDesktopLocalAssetExecution, shouldRecoverPersistedOrchestrationInstance, () => {}, { info() {} }, OrchInstanceScopeError, OrchAssetLaunchSnapshotError, () => { throw new Error("UNEXPECTED_ISOLATION"); });
  const actual = create();
  assert.deepEqual(actual.preparePersistedOrchestrationInstances("server"), { candidateCount: 4, preparedCount: 4, failedCount: 0 });
  assert.deepEqual(prepared, ["running", "pending-node", "untouched", "paused"]);
  assert.deepEqual(normalized, prepared);
  await actual.recoverRunningOrchestrations("server");
  assert.deepEqual(recovered, ["running", "pending-node"]);
  failure = new Error("DATABASE_UNAVAILABLE");
  assert.throws(() => create().preparePersistedOrchestrationInstances("server"), /DATABASE_UNAVAILABLE/);
  await assert.rejects(create().recoverRunningOrchestrations("server"), /DATABASE_UNAVAILABLE/);
});
