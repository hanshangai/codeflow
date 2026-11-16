import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactOutputMode, NodePromptEnvelope, RoleDefinition } from "@codeflowai/shared";

import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.ts";
import { XmlNodePromptRenderer } from "../src/orchestration/promptRenderer.ts";
import { buildPromptDefinitionHash } from "../src/orchestration/promptDefinitionHash.js";
import type { SendMessageInput } from "../src/engines/threadSession.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { buildKnowledgeAssetReadTools, renderKnowledgeSpecificationRules } from "../src/knowledge/knowledgeAssetTools.js";
import { openClientDb } from "../src/db/clientDb.js";
import { createDefaultRoleExecutionConfig, createDefaultRoleExecutionCustomConfig } from "@codeflowai/shared";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { flushClientLogger } from "../src/logger.js";

/** 构造只覆盖渲染器必需字段的节点提示词信封。 */
function buildEnvelope(options: {
  outputMode?: ArtifactOutputMode;
  deliveryMode?: RoleDefinition["outputDefinition"]["deliveryMode"];
  files?: NonNullable<RoleDefinition["outputDefinition"]["files"]>;
} = {}): NodePromptEnvelope {
  const outputMode = options.outputMode ?? "text";
  return {
    schemaVersion: "node-prompt-envelope/v1",
    meta: {
      scene: "orchestration-node",
      instanceId: "instance-profile-test" as any,
      workflowId: "workflow-profile-test" as any,
      workflowName: "Profile Test Workflow",
      nodeId: "node-profile-test",
      nodeLabel: "Profile Node",
      intent: "execute",
      roleExecutionRevision: null,
    },
    role: {
      roleId: "role-profile-test" as any,
      name: "Profile Role",
      description: null,
      responsibility: "Use the workspace execution profile.",
      systemPrompt: null,
      formalTemplateName: "Profile Template",
      inputDefinition: { instructions: "", requiredFields: [] },
      outputDefinition: {
        deliveryMode: options.deliveryMode ?? "direct",
        format: "markdown",
        instructions: "Return a short result.",
        requiredFields: [],
        resultKey: null,
        filePathRule: null,
        files: options.files ?? [],
      },
    },
    task: {
      title: "Profile Task",
      titlePathSegment: "Profile Task",
      goal: "Verify profile rendering",
      background: null,
      acceptanceCriteria: null,
      renderedTaskInput: "Handle the task with profile context.",
      fieldBindings: {},
    },
    artifacts: { upstreamArtifacts: [] },
    knowledge: { catalogs: [], warnings: [] },
    review: { feedbackPatch: null, latestFeedbackPatch: null, latestAction: null },
    runtime: {
      runtimePolicy: {
        workflowId: "workflow-profile-test",
        workflowName: "Profile Test Workflow",
        nodeId: "node-profile-test",
        nodeLabel: "Profile Node",
        approvalMode: "auto",
        executionEngine: "codex",
        executionProfileMode: "auto",
        executionProfileLabel: "codex:auto",
        accessMode: "current",
        toolRuntimePolicy: { allowedToolIds: [], requiresWorkspaceWrite: false },
        artifactPolicy: {
          persistenceMode: outputMode === "file" || outputMode === "file-set" ? "dual-write" : "db-only",
          outputMode,
          primaryKind: outputMode,
        },
      },
      toolRegistry: null,
      executionProfiles: [
        {
          userId: "user-a",
          scope: { scopeType: "shared_workspace", scopeId: "shared-1" },
          profileText: "git.name=Alice\nUse branch prefix feature/alice.",
          profileHash: "hash-a",
          updatedAt: 123,
        },
        {
          userId: "user-b",
          scope: { scopeType: "shared_workspace", scopeId: "shared-1" },
          profileText: "git.name=Bob",
          profileHash: "hash-b",
          updatedAt: 456,
        },
      ],
    },
  };
}

test("恢复和首次执行都在规则层收到本次已采用项目规格", () => {
  const envelope = buildEnvelope();
  const hash = () => buildPromptDefinitionHash(envelope as unknown as Record<string, unknown>, "workflow", "node", "role");
  const legacy = hash();
  envelope.knowledge.projectSpecifications = null;
  assert.equal(hash(), legacy);
  envelope.knowledge.projectSpecifications = "UPDATED_GLOBAL_SPEC_123；修改文件前调用 knowledge.rules.read。";
  const updated = hash();
  assert.notEqual(updated, legacy);
  for (const intent of ["execute", "resume-interrupted-node"] as const) {
    envelope.meta.intent = intent;
    const rendered = new XmlNodePromptRenderer().render(envelope);
    assert.match(rendered.developerMessage!, /UPDATED_GLOBAL_SPEC_123/);
    assert.match(rendered.developerMessage!, /knowledge.rules.read/);
    assert.doesNotMatch(rendered.developerMessage!, /知识库是参考材料，不是额外读取协议/);
    if (intent === "resume-interrupted-node") assert.ok(rendered.continuationUserMessage);
  }
  envelope.meta.intent = "execute";
  envelope.knowledge.projectSpecifications = "DIFFERENT_GLOBAL_SPEC_456";
  assert.notEqual(hash(), updated);
});

/** 真实执行同一节点两轮，仅替换引擎发送；第二轮用哨兵异常结束，记录实际提示词及快照。 */
async function sendSpecificationTurns(root: string, mutate: () => void) {
  const envelope = buildEnvelope();
  envelope.knowledge.projectSpecifications = renderKnowledgeSpecificationRules(new KnowledgeAssetStore(root));
  const registry = buildKnowledgeAssetReadTools(true);
  envelope.runtime.toolRegistry = registry;
  const rendered = new XmlNodePromptRenderer().render(envelope);
  const inputs: SendMessageInput[] = [], snapshots: Array<{ promptEnvelope: NodePromptEnvelope; developerMessage: string; renderedInputPreview: string }> = [];
  const stop = new Error("STOP_AFTER_SECOND_SEND");
  const session = {
    resolvePlatformToolTransport: () => "native-dynamic",
    async sendMessage(input: SendMessageInput) {
      inputs.push(input);
      if (inputs.length === 1) { mutate(); return { responseText: "first pass" }; }
      throw stop;
    },
  };
  const engine = Object.create(OrchestrationEngine.prototype) as any;
  engine.ctx = { sessions: { getOrCreate: () => session }, workspaces: new Map([["w", root]]), db: { orchNodeAttempts: { bindExecution() {} } }, emitConversation() {}, emitRaw() {} };
  engine.resolveOrCreateNodeThread = () => ({ threadId: "t", thread: {}, reused: false });
  engine.resolveNodeBillingContext = () => null;
  engine.createPromptSnapshot = (_instance: unknown, _node: unknown, snapshot: typeof snapshots[number]) => snapshots.push(snapshot);
  engine.isTurnStillStarted = () => false;
  engine.buildNodeResultSubmissionRecoveryMessage = () => "continue";
  const prompt = { ...rendered, promptEnvelope: envelope, snapshots: { toolRegistry: registry, runtimePolicy: envelope.runtime.runtimePolicy, knowledgeCatalogs: [], knowledgeWarnings: [], artifactInput: { artifacts: [], fieldBindings: {} } } };
  let failure: unknown;
  try {
    await engine.executeSubThread({ id: "i", workspaceId: "w" }, { id: "n", label: "Node", type: "role" }, { outputDefinition: {} }, prompt, { engine: "codex", model: null, effort: null, accessMode: "read-only", autoCompactPct: null, contextWindow: null, serviceTier: null }, {}, [], "a");
  } catch (error) { failure = error; }
  return { inputs, snapshots, failure, stop };
}

test("同一工作流节点每轮发送和快照使用实时规格，原文失效阻止下一轮派发", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-live-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "rules.md");
  fs.writeFileSync(source, "RULE_VERSION_A", "utf8");
  const store = new KnowledgeAssetStore(root);
  store.importFile({ path: "rules.md", category: "specifications", appliesTo: [], contentHash: store.readSource("rules.md").contentHash, parentId: null, treeHash: null });
  const changed = await sendSpecificationTurns(root, () => fs.writeFileSync(source, "RULE_VERSION_B", "utf8"));
  assert.equal(changed.inputs.length, 2);
  assert.equal(changed.failure, changed.stop);
  assert.match(changed.inputs[0]!.developerMessage!, /RULE_VERSION_A/);
  assert.match(changed.inputs[1]!.developerMessage!, /RULE_VERSION_B/);
  assert.doesNotMatch(changed.inputs[1]!.developerMessage!, /RULE_VERSION_A/);
  assert.equal(changed.inputs[1]!.userMessage, "continue");
  assert.match(changed.snapshots[1]!.promptEnvelope.knowledge.projectSpecifications!, /RULE_VERSION_B/);
  assert.match(changed.snapshots[1]!.developerMessage, /RULE_VERSION_B/);
  assert.match(changed.snapshots[1]!.renderedInputPreview, /continue/);
  const missing = await sendSpecificationTurns(root, () => fs.unlinkSync(source));
  assert.equal(missing.inputs.length, 1);
  assert.equal(missing.snapshots.length, 1);
  assert.notEqual(missing.failure, missing.stop);
  assert.match(String(missing.failure), /ENOENT|不存在/);
});

test("node prompt renders execution profiles in developer layer with user attribution", () => {
  const rendered = new XmlNodePromptRenderer().render(buildEnvelope());
  const developer = rendered.developerMessage ?? "";

  assert.match(developer, /<execution_profiles>/);
  assert.match(developer, /<profile userId="user-a" scopeType="shared_workspace" scopeId="shared-1" profileHash="hash-a" updatedAt="123">/);
  assert.match(developer, /git\.name=Alice/);
  assert.match(developer, /<profile userId="user-b" scopeType="shared_workspace" scopeId="shared-1" profileHash="hash-b" updatedAt="456">git\.name=Bob<\/profile>/);
  assert.doesNotMatch(rendered.userMessage, /git\.name=Alice/);
});

test("file-set node prompt allows ask_human without placeholder formal files", () => {
  const rendered = new XmlNodePromptRenderer().render(buildEnvelope({
    outputMode: "file-set",
    deliveryMode: "file-set",
    files: [
      {
        key: "report",
        name: "正式报告",
        format: "markdown",
        allowedExtensions: null,
        pathRule: "codeflow-docs/{{feature}}/REPORT-{{feature}}.md",
        description: "正式报告",
        required: true,
      },
    ],
  }));
  const developer = (rendered.developerMessage ?? "").replace(/&quot;/g, "\"");

  assert.match(developer, /只有 control\.nextAction="continue" 时/);
  assert.match(developer, /answer\.mode="text"/);
  assert.match(developer, /不要把占位符替换成“待补充”或 xxx 伪路径/);
  assert.match(developer, /必须通过 answer\.attachments 提交路径/);
  assert.match(developer, /不要只在正文里写文件路径/);
  assert.match(developer, /当 control\.nextAction="ask_human" 时，必须同时填写 humanInput\.summary/);
});

test("text node prompt treats ask_human as decision instead of full delivery", () => {
  const rendered = new XmlNodePromptRenderer().render(buildEnvelope({ outputMode: "text" }));
  const developer = (rendered.developerMessage ?? "").replace(/&quot;/g, "\"");

  assert.match(developer, /只有 control\.nextAction="continue" 表示当前节点正式交付完成/);
  assert.match(developer, /ask_human\/rework\/stop 是决策型提交/);
  assert.match(developer, /不要展开完整 delivery_template/);
  assert.match(developer, /answer\.mode="text" 只需简要说明决策原因/);
  assert.match(developer, /必须通过 answer\.attachments 提交路径/);
});

test("structured node prompt allows ask_human without required_outputs", () => {
  const rendered = new XmlNodePromptRenderer().render(buildEnvelope({ outputMode: "structured" }));
  const developer = (rendered.developerMessage ?? "").replace(/&quot;/g, "\"");

  assert.match(developer, /若 control\.nextAction="ask_human"\/"rework"\/"stop"/);
  assert.match(developer, /不需要也不要提交完整结构化结果或 required_outputs/);
  assert.match(developer, /ask_human\/rework\/stop 决策可用 answer\.mode="text"/);
  assert.match(developer, /必须通过 answer\.attachments 提交路径/);
});

test("orchestration engine resolves assignee profiles from frozen shared scope", () => {
  const calls: Array<{ scopeType: string; scopeId: string; userId: string }> = [];
  const engine = new OrchestrationEngine({
    db: {
      withWorkspaceExecutionProfiles(workspaceId: string, operation: (repo: unknown) => unknown) {
        assert.equal(workspaceId, "host-local-workspace");
        return operation({
        get(scope: { scopeType: string; scopeId: string }, userId: string) {
          calls.push({ scopeType: scope.scopeType, scopeId: scope.scopeId, userId });
          return {
            scope,
            userId,
            profileText: `profile for ${userId}`,
            source: "workspace",
            profileHash: `hash-${userId}`,
            updatedAt: 100,
          };
        },
        });
      },
      orchInstances: { get: () => null },
    },
    threads: {},
    sessions: {},
    workspaces: new Map(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1, engineIdleTimeoutMs: 1 },
    emitConversation() {},
    emitRaw() {},
  } as any);

  const profiles = (engine as any).resolveNodeExecutionProfiles(
    {
      workspaceId: "host-local-workspace",
      runtimeConfig: {
        executionProfileScope: { scopeType: "shared_workspace", scopeId: "shared-1" },
        initiatorUserId: "initiator",
      },
      nodeStates: {
        node_req: { nodeId: "node_req", status: "pending", retryCount: 0, assigneeUserIds: ["user-a", "user-b"] },
      },
    },
    { id: "node_req" },
  );

  assert.deepEqual(calls, [
    { scopeType: "shared_workspace", scopeId: "shared-1", userId: "user-a" },
    { scopeType: "shared_workspace", scopeId: "shared-1", userId: "user-b" },
  ]);
  assert.deepEqual(profiles.map((profile: any) => profile.userId), ["user-a", "user-b"]);
});

/** 保留真实角色、builder、节点派发及快照仓储；只用哨兵 provider 结束单轮。 */
function profileNodeFixture(t: test.TestContext, options: { maxRetries?: number; failPolicy?: "skip" } = {}) {
  initializeLocalEngineModelCatalog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-profile-storage-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "physical-workspace" as any, scope = { scopeType: "shared_workspace" as const, scopeId: "business-shared" };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); resetEngineModelCatalogRuntimeForTest(); });
  db.workspaces.upsert({ id: workspaceId, title: "workspace", path: root });
  db.withWorkspaceExecutionProfiles(workspaceId, repo => repo.upsert({ scope, userId: "user-a", profileText: "actual workspace profile" }));
  const executionConfig = createDefaultRoleExecutionConfig("codex");
  executionConfig.engineProfiles.codex.mode = "custom";
  executionConfig.engineProfiles.codex.customConfig = { ...createDefaultRoleExecutionCustomConfig("codex"), model: "gpt-5.5", effort: "medium", accessMode: "read-only", maxRetries: options.maxRetries ?? 0 };
  const role = db.orchRoles.upsert({ id: "profile-role" as any, workspaceId, name: "Profile role", description: "profile", responsibility: "profile",
    systemPrompt: "Process the task", inputDefinition: { instructions: "{{requirement}}", requiredFields: [] },
    outputDefinition: { instructions: "Return result", deliveryMode: "direct", format: "markdown", resultKey: null, filePathRule: null, requiredFields: [] },
    gateCriteria: [], executionConfig, defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom" });
  const node = { id: "node", label: "Profile", roleId: role.id, type: "role" as const, position: { x: 0, y: 0 }, failPolicy: options.failPolicy };
  const workflow = { id: "profile-workflow" as any, workspaceId, family: "feature-dev" as const, name: "Profile workflow", description: "profile",
    workflowKnowledgeBundleIds: [], nodes: [node], edges: [], version: 1 };
  const instance = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
    roleSnapshots: { [role.id]: role }, runtimeConfig: { executionProfileScope: scope, initiatorUserId: "user-a" } as any,
    intakeSnapshot: { id: "profile-intake" as any, workspaceId, triggerMode: "manual", taskType: "feature", title: "Profile", goal: "Profile task",
      background: null, acceptanceCriteria: null, workbenchItemRefs: null, seedArtifactRefs: null, constraints: null, requester: null, createdAt: 1, updatedAt: 1 } });
  db.orchInstances.backfillAssetRuntimeSnapshot(instance.id, { authorityMode: "legacy",
    workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
    roles: { [role.id]: { assetType: "role", assetId: role.id, definition: role, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 1 } } },
    knowledgeBundles: {}, toolsets: {}, skills: {} });
  db.orchInstances.updateStatus(instance.id, "running");
  const sent: SendMessageInput[] = [], stop = new Error("PROFILE_PROVIDER_STOP");
  const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), sessions: {
    getOrCreate: () => ({ resolvePlatformToolTransport: () => "native-dynamic", async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
      async sendMessage(input: SendMessageInput) { sent.push(input); throw stop; } }),
  } as any, workspaces: new Map([[workspaceId, root]]),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1, engineIdleTimeoutMs: 1 }, emitConversation() {}, emitRaw() {} });
  const internal = engine as any;
  internal.runningInstances.set(instance.id, internal.createRunState());
  return { db, root, sent, engine, node, instance, workspaceId,
    execute: () => internal.executeRoleNode(instance.id, node, db.orchInstances.get(instance.id)) as Promise<void> };
}

test("node Profile consumer reaches real role builder, provider and persistent prompt snapshot", async t => {
  const f = profileNodeFixture(t);
  await f.execute();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.developerMessage ?? "", /actual workspace profile/);
  const snapshots = f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id);
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0]!.developerMessage ?? "", /actual workspace profile/);
  assert.equal(snapshots[0]!.promptEnvelope.runtime.executionProfiles?.[0]?.scope.scopeId, "business-shared");
  assert.equal(snapshots[0]!.systemMessage, f.sent[0]!.systemMessage);
});

test("node missing Profile still reaches provider and persistent snapshot without failure log", async t => {
  const f = profileNodeFixture(t);
  f.db.withWorkspaceExecutionProfiles(f.workspaceId, repo => repo.upsert({ scope: { scopeType: "shared_workspace", scopeId: "business-shared" }, userId: "user-a", profileText: "" }));
  await f.execute();
  assert.equal(f.sent.length, 1); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 1);
  assert.doesNotMatch(f.sent[0]!.developerMessage ?? "", /actual workspace profile/);
  t.diagnostic(JSON.stringify(profileNodeLogRows(path.join(f.root, ".codeflowai"))));
  assert.equal(profileNodeLogRows(path.join(f.root, ".codeflowai")).length, 0);
});

test("node Profile legal log filtering keeps the original retry policy without dispatch", async t => {
  const f = profileNodeFixture(t, { maxRetries: 2, failPolicy: "skip" });
  const damaged = new DatabaseSync(path.join(f.root, ".codeflowai/workspace.db"));
  try { damaged.exec("ALTER TABLE workspace_execution_profiles RENAME TO damaged_profiles"); } finally { damaged.close(); }
  const level = process.env.CODEFLOWAI_CLIENT_LOG_LEVEL; process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = "fatal";
  try { await f.execute(); } finally { if (level === undefined) delete process.env.CODEFLOWAI_CLIENT_LOG_LEVEL; else process.env.CODEFLOWAI_CLIENT_LOG_LEVEL = level; }
  const state = f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!;
  assert.equal(state.status, "ready"); assert.equal(state.retryCount, 1); assert.equal(state.attemptNo, 2);
  assert.equal(f.sent.length, 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
  assert.equal(profileNodeLogRows(path.join(f.root, ".codeflowai")).length, 0);
});

/** 只读真实应用与工作区日志，未创建目录时没有副作用。 */
function profileNodeLogRows(directory: string): Record<string, any>[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^client.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("node Profile real read failure writes only physical workspace and retains shared scope and failure policy", async t => {
  const f = profileNodeFixture(t, { failPolicy: "skip" });
  const other = path.join(f.root, "B"); fs.mkdirSync(other); f.db.workspaces.upsert({ id: "node-B" as any, title: "B", path: other });
  const damaged = new DatabaseSync(path.join(f.root, ".codeflowai/workspace.db"));
  try { damaged.exec("ALTER TABLE workspace_execution_profiles RENAME TO damaged_profiles"); } finally { damaged.close(); }
  await f.execute();
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
    await flushClientLogger();
    assert.equal(profileNodeLogRows(process.env.CODEFLOWAI_CLIENT_LOG_DIR!).filter(row => row.instanceId === f.instance.id).length, 0);
    const rows = profileNodeLogRows(path.join(f.root, ".codeflowai")); assert.equal(rows.length, 1);
    const payload = rows[0]!;
    assert.equal(payload.workspaceId, f.workspaceId); assert.deepEqual(payload.userIds, ["user-a"]);
    assert.equal(payload.scope.scopeId, "business-shared"); assert.ok(payload.requestId);
    assert.equal(payload.errorCode, "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED");
    assert.deepEqual(payload.event, { category: "workspace-profile", action: "node.execute", outcome: "fail" });
    assert.equal(payload.rootCause.cause.reason, "WORKSPACE_DB_SCHEMA_INVALID");
    assert.equal(JSON.stringify(payload).includes("actual workspace profile"), false);
    assert.equal(JSON.stringify(payload).includes("NODE_SECRET"), false);
    assert.equal(profileNodeLogRows(path.join(other, ".codeflowai")).length, 0);
    assert.equal(fs.existsSync(path.join(f.root, "business-shared")), false);
    assert.equal(f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!.status, "skipped");
});

test("node Profile unconfirmed close preserves both failures and skips retry and failure policy", async t => {
  const f = profileNodeFixture(t, { maxRetries: 2, failPolicy: "skip" }), nativeClose = DatabaseSync.prototype.close;
  const storage = new Error("PROFILE_BODY\nsecret");
  let blocked = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (blocked && (this.prepare("PRAGMA database_list").all() as Array<{ file: string }>).some(row => row.file.endsWith("workspace.db"))) throw storage;
    nativeClose.call(this);
  });
  try {
    await assert.rejects(f.execute(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
      assert.equal(error.errors[0].cause, storage); assert.equal(error.errors[1].cause, storage); return true;
    });
    assert.equal(f.sent.length, 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
    const state = f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!;
    assert.equal(state.status, "running"); assert.equal(state.retryCount, 0); assert.equal(state.attemptNo, 1);
    assert.equal(profileNodeLogRows(path.join(f.root, ".codeflowai")).length, 0);
    const b = path.join(f.root, "B"); fs.mkdirSync(b); const bId = "node-close-B" as any;
    f.db.workspaces.upsert({ id: bId, title: "B", path: b }); f.db.writeWorkspaceLog(bId, { level: "error", tag: "probe", message: "other workspace remains available" });
    assert.equal(profileNodeLogRows(path.join(b, ".codeflowai")).length, 1);
  } finally { blocked = false; }
});

test("node Profile unsafe registered root rejects logging before retry or failure policy", async t => {
  const f = profileNodeFixture(t, { maxRetries: 2, failPolicy: "skip" }), unsafe = path.join(f.root, "unsafe-root");
  fs.writeFileSync(unsafe, "not a directory", "utf8");
  f.db.workspaces.upsert({ id: f.workspaceId, title: "unsafe", path: unsafe });
  await assert.rejects(f.execute(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.message, "WORKSPACE_PROFILE_FAILURE_LOG_FAILED");
    assert.equal(error.cause, error.errors[0]); assert.equal(error.errors.length, 2); return true;
  });
  const state = f.db.orchInstances.get(f.instance.id)!.nodeStates[f.node.id]!;
  assert.equal(state.status, "running"); assert.equal(state.retryCount, 0); assert.equal(state.attemptNo, 1);
  assert.equal(f.sent.length, 0); assert.equal(f.db.orchPromptSnapshots.listByNode(f.instance.id, f.node.id).length, 0);
  assert.equal(profileNodeLogRows(path.join(f.root, ".codeflowai")).length, 0);
});
