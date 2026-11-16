import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSharedWorkspaceHostRpcPayload,
  createDefaultRoleExecutionConfig,
  resolveSharedWorkspaceEffectiveOperationPolicy,
  type ClientToServerMessage,
  type SharedWorkspaceCommandEnvelope,
  type ThreadId,
  type WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { readOrchIntakeListSnapshot } from "../../apps/desktop/client/src/db/orchIntakeListSnapshot.ts";
import { handleSharedWorkspaceCommand } from "../../apps/desktop/client/src/app/handlers/sharedWorkspaceHandlers.ts";
import { handleThreadsCreate } from "../../apps/desktop/client/src/app/handlers/threadHandlers.ts";
import { SharedThreadAclWorkspaceMismatchError } from "../../apps/desktop/client/src/db/repos/threadRepo.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";
import { WorkspaceOperationGate } from "../../apps/desktop/client/src/workspace-migration/workspaceOperationGate.ts";
import { initializeLocalEngineModelCatalog, resetEngineModelCatalogRuntimeForTest } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { evaluateSharedWorkspaceProviderNativeToolPolicy } from "../../apps/desktop/client/src/app/sharedWorkspaceToolPolicy.ts";

type SharedWorkspaceRouteResultMessage = Extract<ClientToServerMessage, { t: "sharedWorkspace.route.result" }>;

test("共享异步回答从真实封套持久化权限，续聊不能丢失共享写限制", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-async-input-"));
  const app = openClientDb({ dbPath: path.join(root, "app.db") });
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspaceId = "workspace_host" as WorkspaceId, threadId = "shared_input" as ThreadId;
  app.workspaces.upsert({ id: workspaceId, title: "host", path: root });
  const db = app.forWorkspace(workspaceId), messages: ClientToServerMessage[] = [];
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "input", sharedAcl: sharedThreadAcl() });
  db.conversationEvents.appendEnvelope({ schema: 1, seq: 1, ts: 1, workspaceId, threadId, engine: "codex",
    type: "userInput.requested", payload: { request: { requestId: "async_shared", params: {
      workspaceId, threadId, turnId: "turn" as never, itemId: "async_shared" as never, delivery: "async",
      questions: [{ id: "q", header: "问题", question: "是否继续？" }],
    } } } });
  const ctx = { db, workspaces: new Map([[workspaceId, root]]), threads: new ThreadStore(),
    sessions: { beginThreadOperation: beginTestThreadOperation, hasActiveTurn: () => false },
    queueDispatcher: { kickIfIdle() {} }, send(message: ClientToServerMessage) { messages.push(message); },
  } as any;
  const envelope = makeEnvelope({ operationId: "shared-input", operationKey: "context.thread.user_input.respond",
    payload: { threadId, requestId: "async_shared", answers: { q: { answers: ["继续"] } } } });
  await handleSharedWorkspaceCommand(ctx, envelope);
  assert.equal(findRouteResult(messages, "shared-input")?.message.status, "succeeded");
  const queued = db.threadMessageQueue.listActiveByThread(threadId)[0]!;
  assert.ok(queued);
  const context = db.threadMessageQueue.getSharedWorkspaceToolContext(queued.id);
  assert.equal(context?.sharedWorkspaceId, envelope.sharedWorkspaceId);
  assert.equal(context?.operationId, envelope.operationId);
  assert.equal(context?.operationKey, envelope.operationKey);
  assert.equal(context?.lockToken, envelope.lockToken);
  assert.equal(evaluateSharedWorkspaceProviderNativeToolPolicy({ context, provider: "codex", toolName: "commandExecution" }).allowed, false);
  assert.equal(evaluateSharedWorkspaceProviderNativeToolPolicy({ context, provider: "codex", toolName: "requestUserInput" }).allowed, true);
});

test("shared RA 新线程通过真实封套持久可信scope，幂等重放不认领旧未知", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-ra-trusted-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "workspace_host" as WorkspaceId;
  const messages: ClientToServerMessage[] = [];
  initializeLocalEngineModelCatalog();
  const ctx = { workspaces: new Map([[workspaceId, directory]]), threads: new ThreadStore(),
    sessions: { beginThreadOperation: beginTestThreadOperation }, send: (message: ClientToServerMessage) => messages.push(message) } as any;
  try {
    db.workspaces.upsert({ id: workspaceId, title: "共享分析", path: directory });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "ra-new", operationKey: "context.thread.create",
      payload: { threadId: "ra-new", engine: "codex", title: "新分析", threadSubtype: "requirement-analysis", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } } }));
    assert.equal(findRouteResult(messages, "ra-new")?.message.status, "succeeded");
    assert.deepEqual(workspaceDb.orchRequirementAnalysisSessions.get("ra-new" as any)?.workspaceScope, { scopeType: "shared_workspace", scopeId: "sw_host" });
    workspaceDb.threads.create({ id: "ra-old" as any, workspaceId, engine: "codex", title: "旧分析", threadSubtype: "requirement-analysis", sharedAcl: sharedThreadAcl() });
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "ra-replay", operationKey: "context.thread.create",
      payload: { threadId: "ra-old", engine: "codex", title: "旧分析", threadSubtype: "requirement-analysis" } }));
    assert.equal(findRouteResult(messages, "ra-replay")?.message.status, "succeeded");
    assert.equal(workspaceDb.orchRequirementAnalysisSessions.get("ra-old" as any), null);
    workspaceDb.threads.create({ id: "ra-conflict" as any, workspaceId, engine: "codex", title: "冲突分析", threadSubtype: "requirement-analysis", sharedAcl: sharedThreadAcl() });
    workspaceDb.orchRequirementAnalysisSessions.create({ id: "ra-conflict" as any, workspaceId, title: "冲突分析", status: "active", phase: "discover", engine: "codex", runtimeThreadId: "ra-conflict" as any,
      workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "ra-conflict-replay", operationKey: "context.thread.create",
      payload: { threadId: "ra-conflict", engine: "codex", title: "冲突分析", threadSubtype: "requirement-analysis" } }));
    assert.equal(findRouteResult(messages, "ra-conflict-replay")?.message.status, "failed");
    assert.equal(ctx.threads.get("ra-conflict"), null);
  } finally { resetEngineModelCatalogRuntimeForTest(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

function makeEnvelope(input: {
  operationId: string;
  payload: unknown;
  operationKey?: SharedWorkspaceCommandEnvelope["operationKey"];
  lockToken?: string | null;
  lockVersion?: number | null;
  policy?: SharedWorkspaceCommandEnvelope["policy"];
  actorUserId?: string;
  actorAssetRole?: SharedWorkspaceCommandEnvelope["authorization"]["actorAssetRole"];
}): SharedWorkspaceCommandEnvelope {
  const operationKey = input.operationKey ?? "workspace.fs.write";
  const effectivePolicy = resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, input.payload);
  const policy = input.policy ?? (effectivePolicy ? { ...effectivePolicy, upgradedFromOperationId: null } : null);
  assert.ok(policy);
  return {
    sharedWorkspaceId: "sw_host",
    actorUserId: input.actorUserId ?? "user_member",
    actorRemoteSessionId: "session_member" as never,
    hostBindingId: "binding_host",
    routeEventId: `${input.operationId}-route`,
    localWorkspaceId: "workspace_host" as never,
    operationId: input.operationId,
    operationKey,
    policy: {
      ...policy,
    },
    authorization: {
      actorAssetRole: input.actorAssetRole ?? "workspace_admin",
      authorizationResult: "allowed",
      authorizationReason: policy.maintenanceDefinitionRequired ? "workspace_asset_admin" : "",
      assetType: "unknown",
      assetId: "",
      assetAction: "update",
    },
    lockToken: input.lockToken === undefined ? "lock-token" : input.lockToken,
    lockVersion: input.lockVersion === undefined ? 1 : input.lockVersion,
    payload: input.payload,
    createdAt: Date.now(),
  };
}

function sharedThreadAcl(ownerUserId = "user_member") {
  return {
    sharedWorkspaceId: "sw_host",
    ownerUserId,
    visibility: "participants" as const,
    participantUserIds: [],
    updatedAt: Date.now(),
  };
}

/** 为会话删除测试批量写入等量 canonical 与 raw 事件。 */
function seedThreadEvents(
  db: ReturnType<typeof openClientDb>,
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  count: number,
): void {
  db.conversationEvents.appendEnvelopes(Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    return {
      seq,
      threadId,
      workspaceId,
      engine: "codex",
      type: "thread.event",
      ts: seq,
      payload: { seq },
    } as any;
  }));
  db.rawEvents.appendEnvelopes(Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    return {
      seq,
      threadId,
      workspaceId,
      engine: "codex",
      source: "codex",
      ts: seq,
      payload: { seq },
    } as any;
  }));
}

/** 按 operationId 读取测试捕获的共享工作区路由结果。 */
function findRouteResult(
  messages: ClientToServerMessage[],
  operationId: string,
): SharedWorkspaceRouteResultMessage | undefined {
  return messages.find((message): message is SharedWorkspaceRouteResultMessage =>
    message.t === "sharedWorkspace.route.result" && message.message.operationId === operationId);
}

/** 创建测试所需的最小 thread-operation 释放函数。 */
function beginTestThreadOperation(): () => void {
  return () => undefined;
}

/** 构造共享路由测试 reader；无 DB 场景只接受明确的空资源范围。 */
function createTestOrchIntakeListReader(db?: ReturnType<typeof openClientDb>) {
  return {
    /** 生产使用 worker；测试只复用同一纯快照查询或空范围短路。 */
    async listIntakes(input: Parameters<typeof readOrchIntakeListSnapshot>[1]) {
      if (db) return readOrchIntakeListSnapshot(db.db, input);
      assert.deepEqual(input.allowedResourceIds, []);
      return {
        intakes: [],
        hasMore: false,
        nextCursor: null,
        statusCounts: [],
        totalCount: 0,
        listMetaById: {},
        listPageMeta: { totalCount: 0, cursorScope: "" },
      };
    },
  };
}

test("client shared workspace host handler writes only inside the bound local workspace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-write-ok",
      payload: { action: "write", path: "docs/result.txt", content: "hello from shared workspace" },
    }));

    assert.equal(fs.readFileSync(path.join(tempDir, "docs", "result.txt"), "utf8"), "hello from shared workspace");
    const result = findRouteResult(messages, "op-write-ok");
    assert.equal(result?.message.status, "succeeded");
    assert.deepEqual(result?.message.result, { ok: true, action: "write", bytes: 27 });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host command fails while local workspace is migrating", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-migration-gate-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const gate = new WorkspaceOperationGate();
  const release = await gate.acquireMigration(workspaceId, "operation-migration");
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      workspaceOperationGate: gate,
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-write-migration-blocked",
      payload: { action: "write", path: "docs/result.txt", content: "blocked" },
    }));

    const result = findRouteResult(messages, "op-write-migration-blocked");
    assert.equal(result?.message.status, "failed");
    assert.equal(result?.message.error?.code, "SHARED_WORKSPACE_HOST_UNAVAILABLE");
    assert.equal((result?.message.error?.detail as any)?.code, "WORKSPACE_MIGRATION_IN_PROGRESS");
    assert.equal(fs.existsSync(path.join(tempDir, "docs", "result.txt")), false);
  } finally {
    release();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler exposes terminal read and locked terminal actions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-terminal-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const created: unknown[] = [];
  const writes: Array<{ terminalId: string; data: string }> = [];
  const terminalManager = {
    list: () => created,
    restoreAll: () => [],
    create: (input: unknown) => {
      const terminal = { id: `term_${created.length + 1}`, label: (input as any).label ?? "Terminal", status: "running" };
      created.push(terminal);
      return terminal;
    },
    write: (terminalId: string, data: string) => writes.push({ terminalId, data }),
    resize: () => undefined,
    rename: () => true,
    close: () => true,
  };

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      terminalManager,
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-terminal-create",
      operationKey: "terminal.action",
      payload: { action: "create", label: "Shared terminal" },
    }));
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-terminal-read",
      operationKey: "terminal.session.read",
      payload: {},
      lockToken: null,
      lockVersion: null,
    }));
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-terminal-input",
      operationKey: "terminal.action",
      payload: { action: "input", terminalId: "term_1", data: "pwd\r" },
    }));

    const createResult = findRouteResult(messages, "op-terminal-create");
    const readResult = findRouteResult(messages, "op-terminal-read");
    const inputResult = findRouteResult(messages, "op-terminal-input");
    assert.equal(createResult?.message.status, "succeeded");
    assert.equal(readResult?.message.status, "succeeded");
    assert.equal(inputResult?.message.status, "succeeded");
    assert.deepEqual(writes, [{ terminalId: "term_1", data: "pwd\r" }]);
    assert.equal(((readResult?.message.result as any).terminals ?? []).length, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace personal AI route rejects write tool intent before host execution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-ai-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-personal-ai-write-tool",
      operationKey: "ai.thread.send.personal",
      payload: {
        threadId: "thread_1",
        text: "try editing",
        toolOperationKey: "workspace.fs.write",
      },
      lockToken: null,
      lockVersion: null,
    }));

    const result = findRouteResult(messages, "op-personal-ai-write-tool");
    assert.equal(result?.message.status, "failed");
    assert.equal(result?.message.error?.code, "SHARED_WORKSPACE_TOOL_LOCK_REQUIRED");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler accepts transient workflow reads and rejects forged write downgrades", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-workflow-policy-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchIntakeListReader: createTestOrchIntakeListReader(),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-workflow-transient-list",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.intakes.list",
        path: "/orch/intakes",
        action: "list",
        body: { allowedResourceIds: [] },
        assetType: "workflow",
      }),
      lockToken: null,
      lockVersion: null,
    }));
    const transientResult = findRouteResult(messages, "op-workflow-transient-list");
    assert.equal(transientResult?.message.status, "succeeded");
    assert.equal((transientResult?.message.result as any).ok, true);

    const forged = makeEnvelope({
      operationId: "op-workflow-forged-write",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.instances.start",
        path: "/orch/instances/start",
        action: "start",
        body: { proposalId: "proposal_1" },
        assetType: "workflow",
      }),
    });
    forged.policy = { ...forged.policy, usageRequired: false };
    await handleSharedWorkspaceCommand(ctx, forged);

    const forgedResult = findRouteResult(messages, "op-workflow-forged-write");
    assert.equal(forgedResult?.message.status, "failed");
    assert.equal(forgedResult?.message.error?.code, "SHARED_WORKSPACE_OPERATION_UNKNOWN");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler executes explicit role RPC and rejects methodless asset guessing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-role-rpc-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-role-rpc-upsert",
      operationKey: "orch.asset.write",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.roles.upsert",
        path: "/orch/roles/upsert",
        action: "update",
        assetType: "agent",
        assetId: "role_rpc",
        body: {
          role: {
            id: "role_rpc",
            name: "RPC Role",
            description: "",
            systemPrompt: "You are a role.",
            kind: "custom",
            executionConfig: createDefaultRoleExecutionConfig("codex"),
          },
        },
      }),
    }));
    const upsertResult = findRouteResult(messages, "op-role-rpc-upsert");
    assert.equal(upsertResult?.message.status, "succeeded");
    assert.equal(workspaceDb.orchRoles.get("role_rpc" as never)?.workspaceId, workspaceId);

    const memberAllowedEnvelope = makeEnvelope({
      operationId: "op-role-member-policy-upsert",
      operationKey: "orch.asset.write",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.roles.upsert",
        path: "/orch/roles/upsert",
        action: "update",
        assetType: "agent",
        assetId: "role_member_policy",
        body: {
          role: {
            id: "role_member_policy",
            name: "Member Policy Role",
            description: "",
            systemPrompt: "You are a role.",
            kind: "custom",
            executionConfig: createDefaultRoleExecutionConfig("codex"),
          },
        },
      }),
    });
    memberAllowedEnvelope.authorization = {
      actorAssetRole: "member",
      authorizationResult: "allowed",
      authorizationReason: "workspace_asset_admin",
      assetType: "agent",
      assetId: "role_member_policy",
      assetAction: "update",
    };
    await handleSharedWorkspaceCommand(ctx, memberAllowedEnvelope);
    const memberAllowedResult = findRouteResult(messages, "op-role-member-policy-upsert");
    assert.equal(memberAllowedResult?.message.status, "succeeded");
    assert.equal(workspaceDb.orchRoles.get("role_member_policy" as never)?.workspaceId, workspaceId);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-role-methodless-denied",
      operationKey: "orch.asset.write",
      payload: { assetType: "agent", action: "update", role: { id: "role_methodless", name: "Methodless" } },
    }));
    const methodlessResult = findRouteResult(messages, "op-role-methodless-denied");
    assert.equal(methodlessResult?.message.status, "failed");
    assert.equal(methodlessResult?.message.error?.code, "SHARED_WORKSPACE_OPERATION_UNKNOWN");
    assert.equal(methodlessResult?.message.error?.message, "共享工作区 Host RPC method 不能为空");

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-role-methodless-read-denied",
      operationKey: "orch.asset.read",
      payload: { assetType: "agent", action: "read" },
    }));
    const methodlessReadResult = findRouteResult(messages, "op-role-methodless-read-denied");
    assert.equal(methodlessReadResult?.message.status, "failed");
    assert.equal(methodlessReadResult?.message.error?.code, "SHARED_WORKSPACE_OPERATION_UNKNOWN");
    assert.equal(methodlessReadResult?.message.error?.message, "共享工作区 Host RPC method 不能为空");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler routes rollback preview into bound local workspace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-rollback-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: "thread_rollback" as never,
      workspaceId,
      engine: "codex",
      title: "rollback thread",
      sharedAcl: sharedThreadAcl(),
    });
    workspaceDb.turns.insertStarted({
      workspaceId,
      threadId: "thread_rollback" as never,
      engine: "codex",
      turnId: "turn_rollback" as never,
      startedAt: Date.now(),
      startEventSeq: 1,
    });
    workspaceDb.turns.setEnded("turn_rollback" as never, { status: "completed", endedAt: Date.now(), endEventSeq: 2 });
    workspaceDb.turns.setCodexProviderTurnId("turn_rollback" as never, {
      engineTurnId: "provider_turn_rollback",
      engineSessionId: "provider_session_rollback" as never,
      source: "turn.engineBound",
      eventSeq: 1,
      observedAt: Date.now(),
    });

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-rollback-preview",
      operationKey: "context.thread.rollback.preview",
      payload: {
        threadId: "thread_rollback",
        toTurnId: "turn_rollback",
      },
      lockToken: null,
      lockVersion: null,
    }));

    const result = findRouteResult(messages, "op-rollback-preview");
    assert.equal(result?.message.status, "succeeded");
    assert.equal((result?.message.result as any).droppedTurnCount, 1);
    assert.deepEqual((result?.message.result as any).files, []);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace context detail returns events only when requested and clamps history pages", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-detail-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_detail" as never;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "detail thread",
      sharedAcl: sharedThreadAcl(),
    });
    for (let seq = 1; seq <= 600; seq += 1) {
      workspaceDb.conversationEvents.appendEnvelope({
        schema: 1,
        seq,
        threadId,
        workspaceId,
        engine: "codex",
        type: "thread.event",
        ts: seq,
        payload: { seq },
      } as any);
    }

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-detail-no-events",
      operationKey: "context.detail.read",
      payload: { resourceType: "thread", resourceId: threadId, includeEvents: false },
      lockToken: null,
      lockVersion: null,
    }));

    const noEventsResult = findRouteResult(messages, "op-detail-no-events");
    assert.equal(noEventsResult?.message.status, "succeeded");
    assert.equal(Object.prototype.hasOwnProperty.call(noEventsResult?.message.result as any, "events"), false);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-detail-with-events",
      operationKey: "context.detail.read",
      payload: { resourceType: "thread", resourceId: threadId, includeEvents: true, limit: 2 },
      lockToken: null,
      lockVersion: null,
    }));

    const eventsResult = findRouteResult(messages, "op-detail-with-events");
    assert.equal(eventsResult?.message.status, "succeeded");
    assert.deepEqual((eventsResult?.message.result as any).events.map((event: any) => event.seq), [599, 600]);
    assert.equal((eventsResult?.message.result as any).hasMore, true);
    assert.equal((eventsResult?.message.result as any).oldestSeq, 599);
    assert.equal((eventsResult?.message.result as any).rawEventCount, 2);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-detail-large-limit",
      operationKey: "context.detail.read",
      payload: { resourceType: "thread", resourceId: threadId, includeEvents: true, includeThread: false, limit: 5_000 },
      lockToken: null,
      lockVersion: null,
    }));

    const largeLimitResult = findRouteResult(messages, "op-detail-large-limit");
    const largeLimitPayload = largeLimitResult?.message.result as any;
    assert.equal(largeLimitResult?.message.status, "succeeded");
    assert.equal(Object.prototype.hasOwnProperty.call(largeLimitPayload, "thread"), false);
    assert.equal(largeLimitPayload.events.length, 500);
    assert.equal(largeLimitPayload.oldestSeq, 101);
    assert.equal(largeLimitPayload.latestSeq, 600);
    assert.equal(largeLimitPayload.hasMore, true);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-detail-legacy-null-limit",
      operationKey: "context.detail.read",
      payload: { resourceType: "thread", resourceId: threadId, limit: null, beforeSeq: null },
      lockToken: null,
      lockVersion: null,
    }));

    const legacyNullLimitResult = findRouteResult(messages, "op-detail-legacy-null-limit");
    const legacyNullLimitPayload = legacyNullLimitResult?.message.result as any;
    assert.equal(legacyNullLimitResult?.message.status, "succeeded");
    assert.equal(legacyNullLimitPayload.events.length, 500);
    assert.equal(legacyNullLimitPayload.oldestSeq, 101);
    assert.equal(legacyNullLimitPayload.latestSeq, 600);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler deletes large thread event tables in yielding batches", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-delete-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_delete" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const disposedServices: string[] = [];
  const disposedSessions: string[] = [];
  const runtimeThreads: string[] = [];
  const deletionCalls: Array<{ table: "conversation" | "raw"; limit: number; yielded: boolean }> = [];
  let yieldedAfterFirstConversationBatch = false;
  let deletionLockHeld = false;
  let deletionReleaseCount = 0;
  let flushCount = 0;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "delete thread",
      sharedAcl: sharedThreadAcl(),
    });
    seedThreadEvents(workspaceDb, threadId, workspaceId, 1_001);
    runtimeThreads.push(threadId);

    const originalConversationDelete = workspaceDb.conversationEvents.deleteByThreadThroughSeq.bind(workspaceDb.conversationEvents);
    const originalRawDelete = workspaceDb.rawEvents.deleteByThreadThroughSeq.bind(workspaceDb.rawEvents);
    (workspaceDb.conversationEvents as any).deleteByThreadThroughSeq = (
      targetThreadId: ThreadId,
      throughSeq: number,
      limit: number,
    ) => {
      deletionCalls.push({ table: "conversation", limit, yielded: yieldedAfterFirstConversationBatch });
      const deleted = originalConversationDelete(targetThreadId, throughSeq, limit);
      if (deletionCalls.length === 1) setImmediate(() => {
        yieldedAfterFirstConversationBatch = true;
      });
      return deleted;
    };
    (workspaceDb.rawEvents as any).deleteByThreadThroughSeq = (
      targetThreadId: ThreadId,
      throughSeq: number,
      limit: number,
    ) => {
      deletionCalls.push({ table: "raw", limit, yielded: yieldedAfterFirstConversationBatch });
      return originalRawDelete(targetThreadId, throughSeq, limit);
    };

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchEngine: {
        forWorkspace: () => ctx.orchEngine,
        disposeManagedServicesForThread: async (threadId: string) => disposedServices.push(threadId),
      },
      sessions: {
        beginThreadDeletion: () => {
          assert.equal(deletionLockHeld, false);
          deletionLockHeld = true;
          return () => {
            deletionLockHeld = false;
            deletionReleaseCount += 1;
          };
        },
        disposeThreadWithOptions: async (threadId: string) => disposedSessions.push(threadId),
      },
      threads: {
        delete: (threadId: string) => {
          const index = runtimeThreads.indexOf(threadId);
          if (index >= 0) runtimeThreads.splice(index, 1);
        },
      },
      flushEventPersistence: () => {
        flushCount += 1;
      },
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));

    const result = findRouteResult(messages, "op-delete");
    assert.equal(result?.message.status, "succeeded");
    assert.deepEqual(result?.message.result, { ok: true });
    assert.deepEqual(deletionCalls.map((call) => call.table), ["conversation", "conversation", "raw", "raw"]);
    assert.equal(deletionCalls.every((call) => call.limit <= 1_000), true);
    assert.equal(deletionCalls[1]?.yielded, true);
    assert.equal(workspaceDb.conversationEvents.getLatestSeqByThread(threadId), 0);
    assert.equal(workspaceDb.rawEvents.getLatestSeqByThread(threadId), 0);
    assert.equal(workspaceDb.threads.get(threadId), null);
    assert.deepEqual(disposedServices, [threadId]);
    assert.deepEqual(disposedSessions, [threadId]);
    assert.deepEqual(runtimeThreads, []);
    assert.equal(flushCount, 2);
    assert.equal(deletionLockHeld, false);
    assert.equal(deletionReleaseCount, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace delete is idempotent only when the Host thread is absent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-delete-absent-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const otherWorkspaceId = "workspace_other" as WorkspaceId;
  const threadId = "thread_delete_absent" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const otherPath = path.join(tempDir, "other");
    fs.mkdirSync(otherPath, { recursive: true });
    db.workspaces.upsert({ id: otherWorkspaceId, title: "other", path: otherPath });
    const workspaceDb = db.forWorkspace(workspaceId);
    const otherWorkspaceDb = db.forWorkspace(otherWorkspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-absent",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));
    const absent = findRouteResult(messages, "op-delete-absent");
    assert.equal(absent?.message.status, "succeeded");
    assert.deepEqual(absent?.message.result, { ok: true, alreadyAbsent: true });

    otherWorkspaceDb.threads.create({
      id: threadId,
      workspaceId: otherWorkspaceId,
      engine: "codex",
      title: "other workspace thread",
      sharedAcl: sharedThreadAcl(),
    });
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-wrong-workspace",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));
    const otherWorkspaceDelete = findRouteResult(messages, "op-delete-wrong-workspace");
    assert.equal(otherWorkspaceDelete?.message.status, "succeeded");
    assert.deepEqual(otherWorkspaceDelete?.message.result, { ok: true, alreadyAbsent: true });
    assert.equal(workspaceDb.threads.get(threadId), null);
    assert.notEqual(otherWorkspaceDb.threads.get(threadId), null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler preserves thread after a failed event batch and resumes on retry", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-delete-retry-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_delete_retry" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const runtimeThreads = [String(threadId)];
  let deletionLockHeld = false;
  let deletionReleaseCount = 0;
  let flushCount = 0;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "delete retry thread",
      sharedAcl: sharedThreadAcl(),
    });
    seedThreadEvents(workspaceDb, threadId, workspaceId, 1_001);
    const originalRawDelete = workspaceDb.rawEvents.deleteByThreadThroughSeq.bind(workspaceDb.rawEvents);
    (workspaceDb.rawEvents as any).deleteByThreadThroughSeq = () => {
      throw new Error("injected raw event batch failure");
    };

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchEngine: {
        forWorkspace: () => ctx.orchEngine,
        disposeManagedServicesForThread: async () => undefined,
      },
      sessions: {
        beginThreadDeletion: () => {
          assert.equal(deletionLockHeld, false);
          deletionLockHeld = true;
          return () => {
            deletionLockHeld = false;
            deletionReleaseCount += 1;
          };
        },
        disposeThreadWithOptions: async () => undefined,
      },
      threads: {
        delete: (targetThreadId: string) => {
          const index = runtimeThreads.indexOf(targetThreadId);
          if (index >= 0) runtimeThreads.splice(index, 1);
        },
      },
      flushEventPersistence: () => {
        flushCount += 1;
      },
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-failed",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));

    const failed = findRouteResult(messages, "op-delete-failed");
    assert.equal(failed?.message.status, "failed");
    assert.match(failed?.message.error?.message ?? "", /injected raw event batch failure/);
    assert.equal(workspaceDb.conversationEvents.getLatestSeqByThread(threadId), 0);
    assert.equal(workspaceDb.rawEvents.getLatestSeqByThread(threadId), 1_001);
    assert.notEqual(workspaceDb.threads.get(threadId), null);
    assert.deepEqual(runtimeThreads, [threadId]);
    assert.equal(deletionLockHeld, false);
    assert.equal(deletionReleaseCount, 1);

    (workspaceDb.rawEvents as any).deleteByThreadThroughSeq = originalRawDelete;
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-retry",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));

    const retried = findRouteResult(messages, "op-delete-retry");
    assert.equal(retried?.message.status, "succeeded");
    assert.equal(workspaceDb.rawEvents.getLatestSeqByThread(threadId), 0);
    assert.equal(workspaceDb.threads.get(threadId), null);
    assert.deepEqual(runtimeThreads, []);
    assert.equal(flushCount, 4);
    assert.equal(deletionLockHeld, false);
    assert.equal(deletionReleaseCount, 2);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler skips unrelated malformed orchestration during thread deletion", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-delete-refs-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_delete_refs" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const runtimeThreads = [String(threadId)];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "delete referenced thread",
      sharedAcl: sharedThreadAcl(),
    });
    const insertInstance = workspaceDb.db.prepare(`
      INSERT INTO orch_instances (
        id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json,
        master_thread_id, status, node_states_json, created_at, updated_at
      ) VALUES (?, ?, 'workflow-delete-refs', '{}', '{}', ?, 'completed', ?, 1, 1)
    `);
    insertInstance.run("instance-unrelated-malformed", workspaceId, null, "{");
    insertInstance.run("instance-delete-refs", workspaceId, threadId, JSON.stringify({
      node: {
        threadId,
        discussionThreadId: threadId,
        previousThreadIds: [threadId],
      },
    }));
    workspaceDb.db.prepare(`
      INSERT INTO orch_node_attempts (
        id, instance_id, node_id, attempt_no, status, thread_id, turn_id, created_at, updated_at
      ) VALUES ('attempt-delete-refs', 'instance-delete-refs', 'node', 1, 'completed', ?, 'turn-delete-refs', 1, 1)
    `).run(threadId);
    workspaceDb.db.prepare(`
      INSERT INTO orch_asset_generation_jobs (
        id, workspace_id, asset_kind, mode, status, thread_id, prompt, created_at, updated_at
      ) VALUES ('asset-delete-refs', ?, 'role', 'create', 'failed', ?, 'cleanup', 1, 1)
    `).run(workspaceId, threadId);
    workspaceDb.db.prepare(`
      INSERT INTO orch_prompt_snapshots (
        id, instance_id, node_id, thread_id, turn_id, engine,
        system_message, user_message, rendered_input_preview, runtime_policy_json,
        artifact_input_json, created_at
      ) VALUES ('prompt-delete-refs', 'instance-delete-refs', 'node', ?, 'turn-delete-refs', 'codex', '', '', '', '{}', '{}', 1)
    `).run(threadId);

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchEngine: { forWorkspace: () => ctx.orchEngine, disposeManagedServicesForThread: async () => undefined },
      sessions: {
        beginThreadDeletion: () => () => undefined,
        disposeThreadWithOptions: async () => undefined,
      },
      threads: {
        delete: (targetThreadId: string) => {
          const index = runtimeThreads.indexOf(targetThreadId);
          if (index >= 0) runtimeThreads.splice(index, 1);
        },
      },
      flushEventPersistence: () => undefined,
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-refs",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));

    assert.equal(findRouteResult(messages, "op-delete-refs")?.message.status, "succeeded");
    assert.equal(workspaceDb.threads.get(threadId), null);
    assert.deepEqual(runtimeThreads, []);
    const unrelated = workspaceDb.db.prepare(
      "SELECT node_states_json FROM orch_instances WHERE id = 'instance-unrelated-malformed'",
    ).get() as { node_states_json: string } | undefined;
    assert.equal(unrelated?.node_states_json, "{");
    const instance = workspaceDb.db.prepare(
      "SELECT master_thread_id, node_states_json FROM orch_instances WHERE id = 'instance-delete-refs'",
    ).get() as { master_thread_id: string | null; node_states_json: string } | undefined;
    assert.equal(instance?.master_thread_id, null);
    assert.deepEqual(JSON.parse(instance?.node_states_json ?? "{}"), {
      node: { threadId: null, discussionThreadId: null, previousThreadIds: [] },
    });
    assert.deepEqual(
      workspaceDb.db.prepare("SELECT thread_id, turn_id FROM orch_node_attempts WHERE id = 'attempt-delete-refs'").get(),
      { thread_id: null, turn_id: null },
    );
    assert.deepEqual(
      workspaceDb.db.prepare("SELECT thread_id FROM orch_asset_generation_jobs WHERE id = 'asset-delete-refs'").get(),
      { thread_id: null },
    );
    assert.equal(
      (workspaceDb.db.prepare("SELECT COUNT(*) AS count FROM orch_prompt_snapshots WHERE id = 'prompt-delete-refs'").get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler preserves thread when a candidate orchestration is malformed", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-delete-malformed-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_delete_malformed" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const runtimeThreads = [String(threadId)];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "malformed orchestration thread",
      sharedAcl: sharedThreadAcl(),
    });
    workspaceDb.db.prepare(`
      INSERT INTO orch_instances (
        id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json,
        master_thread_id, status, node_states_json, created_at, updated_at
      ) VALUES ('instance-delete-malformed', ?, 'workflow-delete-malformed', '{}', '{}', ?, 'completed', '{', 1, 1)
    `).run(workspaceId, threadId);

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchEngine: { forWorkspace: () => ctx.orchEngine, disposeManagedServicesForThread: async () => undefined },
      sessions: {
        beginThreadDeletion: () => () => undefined,
        disposeThreadWithOptions: async () => undefined,
      },
      threads: {
        delete: (targetThreadId: string) => {
          const index = runtimeThreads.indexOf(targetThreadId);
          if (index >= 0) runtimeThreads.splice(index, 1);
        },
      },
      flushEventPersistence: () => undefined,
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-delete-malformed",
      operationKey: "context.thread.delete",
      payload: { threadId },
    }));

    const result = findRouteResult(messages, "op-delete-malformed");
    assert.equal(result?.message.status, "failed");
    assert.match(result?.message.error?.message ?? "", /无法解析编排节点状态/);
    assert.notEqual(workspaceDb.threads.get(threadId), null);
    assert.deepEqual(runtimeThreads, [threadId]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler routes thread maintenance into bound local workspace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-thread-ops-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const messages: ClientToServerMessage[] = [];
  const calls: string[] = [];
  const runtimeThread = {
    id: "thread_ops",
    workspaceId,
    engine: "codex",
    title: "ops thread",
    threadSubtype: null,
    sharedWorkspaceId: "sw_host",
    ownerUserId: "user_member",
    sharedVisibility: "participants",
    sharedParticipantUserIds: [],
    sharedAclUpdatedAt: Date.now(),
  };

  try {
    const ctx = {
      workspaces: new Map([[workspaceId, tempDir]]),
      db: {
        workspaceId,
        forWorkspace: () => ctx.db,
        ensureThreadPresentation: async () => undefined,
        conversationEvents: { readPresentation: () => ({ items: [] }) },
        writeWorkspaceLog: () => undefined,
        threads: {
          get: () => runtimeThread,
          rename: (_threadId: string, title: string) => calls.push(`rename:${title}`),
          setArchived: (_threadId: string, archived: boolean) => calls.push(`archive:${archived}`),
          setPinned: (_threadId: string, pinned: boolean) => {
            calls.push(`pin:${pinned}`);
            return pinned ? 123 : null;
          },
        },
        fileChanges: {
          listAggregatedByThread: () => [{
            path: "README.md",
            status: "modified",
            lastTurnId: "turn_ops",
            lastChangedAt: 1,
            baseBeforeExists: true,
            baseBeforeBlobId: "blob_before",
            stepKey: null,
            isAccepted: false,
            acceptedBlobId: null,
          }],
          acceptFileChange: (_threadId: string, filePath: string) => {
            calls.push(`accept:${filePath}`);
            return { accepted: true };
          },
        },
      },
      threads: {
        get: () => runtimeThread,
        create: () => runtimeThread,
        setTitle: (_threadId: string, title: string) => calls.push(`runtime-title:${title}`),
      },
      sessions: {
        beginThreadOperation: beginTestThreadOperation,
        getOrCreate: () => ({
          respondApproval: async (requestId: unknown, decision: string) => calls.push(`approval:${String(requestId)}:${decision}`),
          respondUserInput: async (requestId: unknown) => calls.push(`user-input:${String(requestId)}`),
          listInputActions: async () => ({
            engine: "codex",
            actions: [],
            providerCatalog: { state: "ready", observedAt: 123 },
          }),
        }),
      },
      orchEngine: {
        forWorkspace: () => ctx.orchEngine,
        listManagedServicesForThread: () => [{ serviceId: "svc_ops", status: "running" }],
        stopManagedServiceForThread: async (_threadId: string, serviceId: string) => {
          calls.push(`stop-service:${serviceId}`);
          return true;
        },
      },
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    const operations = [
      { id: "op-rename", operationKey: "context.thread.rename" as const, payload: { threadId: "thread_ops", title: "renamed" } },
      { id: "op-archive", operationKey: "context.thread.archive" as const, payload: { threadId: "thread_ops", archived: true } },
      { id: "op-pin", operationKey: "context.thread.pin" as const, payload: { threadId: "thread_ops", pinned: true } },
      { id: "op-input-actions", operationKey: "context.thread.input_actions.list" as const, payload: { threadId: "thread_ops", trigger: "$" } },
      { id: "op-file-list", operationKey: "context.thread.file_changes.list" as const, payload: { threadId: "thread_ops" } },
      { id: "op-file-accept", operationKey: "context.thread.file_changes.accept" as const, payload: { threadId: "thread_ops", paths: ["README.md"] } },
      { id: "op-managed-list", operationKey: "context.thread.managed_services.list" as const, payload: { threadId: "thread_ops" } },
      { id: "op-managed-stop", operationKey: "context.thread.managed_services.stop" as const, payload: { threadId: "thread_ops", serviceId: "svc_ops" } },
      { id: "op-approval", operationKey: "context.thread.approval.respond" as const, payload: { threadId: "thread_ops", requestId: "approval_1", decision: "accept" } },
      { id: "op-user-input", operationKey: "context.thread.user_input.respond" as const, payload: { threadId: "thread_ops", requestId: "input_1", answers: { ok: true } } },
    ];

    for (const operation of operations) {
      await handleSharedWorkspaceCommand(ctx, makeEnvelope({
        operationId: operation.id,
        operationKey: operation.operationKey,
        payload: operation.payload,
      }));
      const result = findRouteResult(messages, operation.id);
      assert.equal(result?.message.status, "succeeded", operation.id);
    }

    assert.deepEqual(calls, [
      "rename:renamed",
      "runtime-title:renamed",
      "archive:true",
      "pin:true",
      "accept:README.md",
      "stop-service:svc_ops",
      "approval:approval_1:accept",
      "user-input:input_1",
    ]);
    const fileList = findRouteResult(messages, "op-file-list");
    assert.equal((fileList?.message.result as any).items[0].path, "README.md");
    const managedList = findRouteResult(messages, "op-managed-list");
    assert.equal((managedList?.message.result as any).items[0].serviceId, "svc_ops");
    const inputActions = findRouteResult(messages, "op-input-actions");
    assert.deepEqual(inputActions?.message.result, {
      engine: "codex",
      actions: [],
      providerCatalog: { state: "ready", observedAt: 123 },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler preserves shared context for queued thread input", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-queue-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const skillId = `csk_${"s".repeat(43)}`;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    workspaceDb.threads.create({
      id: "thread_queue" as never,
      workspaceId,
      engine: "codex",
      title: "queue thread",
      sharedAcl: sharedThreadAcl("user_admin"),
    });

    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      sessions: {
        beginThreadOperation: beginTestThreadOperation,
        hasActiveTurn: () => true,
      },
      getActiveThreadTurn: () => ({ turnId: "turn_active_shared" }),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-draft-input-contract",
      operationKey: "context.thread.draft.save",
      payload: {
        threadId: "thread_queue",
        draft: {
          text: "use $review",
          inputKind: "message",
          skillMentions: [{ skillId, name: "review", start: 4, end: 11 }],
        },
        sharedThreadAcl: sharedThreadAcl(),
      },
    }));
    assert.equal(findRouteResult(messages, "op-draft-input-contract")?.message.status, "succeeded");
    assert.equal(workspaceDb.threadDrafts.get("thread_queue" as never)?.inputKind, "message");
    assert.deepEqual(workspaceDb.threadDrafts.get("thread_queue" as never)?.skillMentions, [
      { skillId, name: "review", start: 4, end: 11 },
    ]);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-queue-append",
      operationKey: "context.thread.queue.append",
      payload: {
        threadId: "thread_queue",
        text: "运行中使用 $review",
        inputKind: "message",
        skillMentions: [{ skillId, name: "review", start: 6, end: 13 }],
        sendOptions: {
          workMode: "general",
          planMode: false,
          accessMode: "current",
          model: "gpt-5-codex",
          effort: null,
          contextWindow: null,
          autoCompactPct: null,
          serviceTier: null,
        },
        originWebSessionId: "web_member",
        sharedThreadAcl: sharedThreadAcl(),
      },
    }));

    const result = findRouteResult(messages, "op-queue-append");
    assert.equal(result?.message.status, "succeeded");
    assert.equal(workspaceDb.threads.get("thread_queue" as never)?.ownerUserId, "user_member");

    const [item] = workspaceDb.threadMessageQueue.listActiveByThread("thread_queue" as never);
    assert.ok(item);
    assert.equal(item?.text, "运行中使用 $review");
    assert.equal(item?.inputKind, "message");
    assert.deepEqual(item?.skillMentions, [{ skillId, name: "review", start: 6, end: 13 }]);
    assert.equal(item?.workspaceId, workspaceId);
    assert.equal(item?.originWebSessionId, "web_member");

    const sharedContext = workspaceDb.threadMessageQueue.getSharedWorkspaceToolContext(item.id);
    assert.equal(sharedContext?.sharedWorkspaceId, "sw_host");
    assert.equal(sharedContext?.operationId, "op-queue-append");
    assert.equal(sharedContext?.operationKey, "context.thread.queue.append");
    assert.equal(sharedContext?.toolPolicyKey, "ai.shared.write");
    assert.equal(sharedContext?.lockToken, "lock-token");
    assert.equal(sharedContext?.lockVersion, 1);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-queue-provider-slash",
      operationKey: "context.thread.queue.append",
      payload: {
        threadId: "thread_queue",
        text: "/review",
        inputKind: "provider-slash",
        sendOptions: {
          workMode: "general",
          planMode: false,
          accessMode: "current",
        },
        sharedThreadAcl: sharedThreadAcl(),
      },
    }));
    const slashResult = findRouteResult(messages, "op-queue-provider-slash");
    assert.equal(slashResult?.message.status, "failed");
    assert.match(slashResult?.message.error?.message ?? "", /Provider Slash/);
    assert.equal(workspaceDb.threadMessageQueue.listActiveByThread("thread_queue" as never).length, 1);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler stores local thread ACL and lists without server allowed ids", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-thread-acl-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  initializeLocalEngineModelCatalog();
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      threads: new ThreadStore(),
      sessions: { beginThreadOperation: beginTestThreadOperation },
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-create-acl",
      operationKey: "context.thread.create",
      actorUserId: "user_owner",
      actorAssetRole: "member",
      payload: {
        threadId: "thread_owner",
        engine: "codex",
        title: "Owner thread",
      },
    }));
    const created = workspaceDb.threads.get("thread_owner" as never);
    assert.equal(created?.sharedWorkspaceId, "sw_host");
    assert.equal(created?.ownerUserId, "user_owner");
    assert.equal(created?.sharedVisibility, "participants");
    assert.deepEqual(created?.sharedParticipantUserIds, []);

    workspaceDb.threads.create({
      id: "thread_other" as never,
      workspaceId,
      engine: "codex",
      title: "Other thread",
    });
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-acl-sync",
      operationKey: "context.thread.acl.sync",
      payload: {
        resourceType: "thread",
        items: [
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_other",
            ownerUserId: "user_other",
            visibility: "participants",
            participantUserIds: [],
            updatedAt: 1234,
          },
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_missing",
            ownerUserId: "user_other",
            visibility: "participants",
            participantUserIds: [],
            updatedAt: 1234,
          },
        ],
      },
    }));
    const syncResult = findRouteResult(messages, "op-thread-acl-sync");
    assert.equal(syncResult?.message.status, "succeeded");
    assert.equal((syncResult?.message.result as any).updated, 1);
    assert.equal((syncResult?.message.result as any).skipped, 1);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-list-related",
      operationKey: "context.list",
      actorUserId: "user_owner",
      actorAssetRole: "member",
      payload: { resourceType: "thread", scope: "all", onlyRelatedToMe: true, limit: 20 },
    }));
    const relatedList = findRouteResult(messages, "op-thread-list-related");
    assert.equal(relatedList?.message.status, "succeeded");
    assert.deepEqual((relatedList?.message.result as any).threads.map((item: any) => item.id), ["thread_owner"]);
    assert.equal((relatedList?.message.result as any).threads[0].readOnly, false);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-list-all",
      operationKey: "context.list",
      actorUserId: "user_owner",
      actorAssetRole: "member",
      payload: { resourceType: "thread", scope: "all", onlyRelatedToMe: false, limit: 20 },
    }));
    const allList = findRouteResult(messages, "op-thread-list-all");
    assert.equal(allList?.message.status, "succeeded");
    const allThreads = (allList?.message.result as any).threads as Array<{ id: string; readOnly?: boolean }>;
    assert.deepEqual(allThreads.map((item) => item.id).sort(), ["thread_other", "thread_owner"]);
    assert.equal(allThreads.find((item) => item.id === "thread_other")?.readOnly, true);
  } finally {
    resetEngineModelCatalogRuntimeForTest();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared knowledge category preserves account isolation even for all scopes and admin list requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-knowledge-list-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const messages: ClientToServerMessage[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: root });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = { db: workspaceDb, workspaces: new Map([[workspaceId, root]]), threads: new ThreadStore(), send: (message: ClientToServerMessage) => messages.push(message) } as any;
    for (const [id, owner, participants] of [
      ["knowledge-own", "user_owner", []],
      ["knowledge-invited", "user_other", ["user_owner"]],
      ["knowledge-private", "user_other", []],
    ] as const) {
      workspaceDb.threads.create({ id: id as any, workspaceId, engine: "codex", title: id, threadSubtype: "knowledge-conversation",
        sharedAcl: { sharedWorkspaceId: "sw_host" as any, ownerUserId: owner, participantUserIds: [...participants], visibility: "private" },
      });
      workspaceDb.db.prepare("INSERT INTO knowledge_conversations (thread_id, created_by_user_id) VALUES (?, ?)").run(id, owner);
    }
    workspaceDb.threads.create({ id: "knowledge-execution" as any, workspaceId, engine: "codex", title: "资产执行", threadType: "orchestration", threadSubtype: "knowledge-assets",
      sharedAcl: { sharedWorkspaceId: "sw_host" as any, ownerUserId: "user_owner", participantUserIds: [], visibility: "private" },
    });
    for (const scope of ["knowledge", "all"] as const) {
      for (const actorAssetRole of ["member", "workspace_admin"] as const) {
        const operationId = `list-${scope}-${actorAssetRole}`;
        await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId, operationKey: "context.list", actorUserId: "user_owner", actorAssetRole,
          payload: { resourceType: "thread", scope, onlyRelatedToMe: false, limit: 20 },
        }));
        const result = findRouteResult(messages, operationId);
        assert.equal(result?.message.status, "succeeded");
        assert.deepEqual((result?.message.result as any).threads.map((t: any) => t.id).sort(), ["knowledge-execution", "knowledge-invited", "knowledge-own"]);
      }
    }
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "list-allowed-ids", operationKey: "context.list", actorUserId: "user_owner",
      payload: { resourceType: "thread", scope: "knowledge", allowedResourceIds: ["knowledge-own", "knowledge-invited", "knowledge-private"] },
    }));
    assert.deepEqual((findRouteResult(messages, "list-allowed-ids")?.message.result as any).threads.map((t: any) => t.id).sort(), ["knowledge-invited", "knowledge-own"]);
    workspaceDb.threads.setArchived("knowledge-own" as any, true);
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "list-archived", operationKey: "context.list", actorUserId: "user_owner",
      payload: { resourceType: "thread", scope: "archived", onlyRelatedToMe: false },
    }));
    assert.deepEqual((findRouteResult(messages, "list-archived")?.message.result as any).threads.map((t: any) => t.id), ["knowledge-own"]);
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "private-detail", operationKey: "context.detail.read", actorUserId: "user_owner",
      payload: { resourceType: "thread", resourceId: "knowledge-private", includeEvents: true },
    }));
    const denied = findRouteResult(messages, "private-detail");
    assert.equal(denied?.message.status, "failed");
    assert.equal(denied?.message.error?.code, "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("client shared thread create replays idempotently without reverting mutable state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-thread-create-replay-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const threadId = "thread_replayed" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const threads = new ThreadStore();
  const ctx = {
    workspaces: new Map([[workspaceId, tempDir]]),
    threads,
    sessions: { beginThreadOperation: beginTestThreadOperation },
    send: (message: ClientToServerMessage) => messages.push(message),
  } as any;

  initializeLocalEngineModelCatalog();
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-create-first",
      operationKey: "context.thread.create",
      actorUserId: "user_owner",
      actorAssetRole: "member",
      payload: { threadId, engine: "codex", title: "Original title" },
    }));
    const first = workspaceDb.threads.get(threadId);
    assert.ok(first);
    const firstCreatedAt = first.createdAt;
    const newerAclUpdatedAt = Date.now() + 10_000;
    workspaceDb.threads.rename(threadId, "Renamed title");
    workspaceDb.threads.setSessionId(threadId, "session_existing" as never);
    assert.equal(workspaceDb.threads.setSharedAcl(threadId, {
      sharedWorkspaceId: "sw_host",
      ownerUserId: "user_owner",
      visibility: "team",
      participantUserIds: ["user_participant"],
      updatedAt: newerAclUpdatedAt,
    }), true);
    threads.delete(threadId);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-thread-create-replay",
      operationKey: "context.thread.create",
      actorUserId: "user_owner",
      actorAssetRole: "member",
      payload: {
        threadId,
        engine: "codex",
        title: "Original title",
        initialPrefs: { model: "model-from-first-request" },
      },
    }));

    const replayResult = findRouteResult(messages, "op-thread-create-replay");
    assert.equal(replayResult?.message.status, "succeeded");
    assert.equal((replayResult?.message.result as any)?.idempotent, true);
    const afterReplay = workspaceDb.threads.get(threadId);
    assert.equal(afterReplay?.createdAt, firstCreatedAt);
    assert.equal(afterReplay?.title, "Renamed title");
    assert.equal(afterReplay?.sessionId, "session_existing");
    assert.equal(afterReplay?.sharedVisibility, "team");
    assert.deepEqual(afterReplay?.sharedParticipantUserIds, ["user_participant"]);
    assert.equal(afterReplay?.sharedAclUpdatedAt, newerAclUpdatedAt);
    assert.equal(threads.get(threadId)?.title, "Renamed title");
    assert.equal(threads.get(threadId)?.sessionId, "session_existing");
    assert.equal(messages.filter((message) => message.t === "conversation.event" && message.event.type === "thread.started").length, 1);
  } finally {
    resetEngineModelCatalogRuntimeForTest();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client threads.create rejects duplicate local or mismatched shared identities", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-thread-create-conflict-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const otherWorkspaceId = "workspace_other" as WorkspaceId;
  const threadId = "thread_identity" as ThreadId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: any[] = [];
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, tempDir], [otherWorkspaceId, tempDir]]),
    threads: new ThreadStore(),
    send: (message: unknown) => messages.push(message),
  } as any;
  const baseBody = {
    workspaceId,
    threadId,
    engine: "codex",
    title: "Identity thread",
    threadType: "chat",
    threadSubtype: null,
    sharedThreadAcl: {
      sharedWorkspaceId: "sw_host",
      ownerUserId: "user_owner",
      visibility: "participants",
      participantUserIds: [],
      updatedAt: Date.now(),
    },
  };
  const invoke = (id: string, body: Record<string, unknown>) => {
    handleThreadsCreate(ctx, {
      t: "api.req",
      id,
      method: "threads.create",
      path: "/threads/create",
      body,
    } as any);
    return [...messages].reverse().find((message: any) => message.t === "api.res" && message.id === id);
  };

  initializeLocalEngineModelCatalog();
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    db.workspaces.upsert({ id: otherWorkspaceId, title: "other", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    const firstResponse = invoke("create-first", baseBody);
    assert.equal(firstResponse.status, 200);
    const original = workspaceDb.threads.get(threadId);
    assert.ok(original);

    const conflicts = [
      { workspaceId: otherWorkspaceId },
      { engine: "claude" },
      { threadType: "orchestration" },
      { threadSubtype: "requirement-analysis" },
      { sharedThreadAcl: { ...baseBody.sharedThreadAcl, sharedWorkspaceId: "sw_other" } },
      { sharedThreadAcl: { ...baseBody.sharedThreadAcl, ownerUserId: "user_other" } },
    ];
    for (const [index, patch] of conflicts.entries()) {
      const response = invoke(`create-conflict-${index}`, { ...baseBody, ...patch });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "SHARED_THREAD_CREATE_IDEMPOTENCY_CONFLICT");
    }
    const localDuplicate = invoke("create-local-duplicate", { ...baseBody, sharedThreadAcl: undefined });
    assert.equal(localDuplicate.status, 409);

    workspaceDb.threads.rename(threadId, "Current title");
    const mutableReplay = invoke("create-mutable-replay", {
      ...baseBody,
      title: "Stale title",
      groupId: "stale-group",
      initialPrefs: { model: "stale-model", accessMode: "read-only" },
      sharedThreadAcl: {
        ...baseBody.sharedThreadAcl,
        visibility: "private",
        participantUserIds: ["stale-participant"],
        updatedAt: Number(baseBody.sharedThreadAcl.updatedAt) - 1,
      },
    });
    assert.equal(mutableReplay.status, 200);
    assert.equal(mutableReplay.body.idempotent, true);
    assert.equal(workspaceDb.threads.get(threadId)?.title, "Current title");
    assert.equal(workspaceDb.threads.get(threadId)?.createdAt, original.createdAt);
    assert.equal(messages.filter((message) => message.t === "conversation.event" && message.event.type === "thread.started").length, 1);
  } finally {
    resetEngineModelCatalogRuntimeForTest();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client threads.create recovers only exact thread id races and surfaces storage lookup failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-thread-create-storage-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: any[] = [];
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, tempDir]]),
    threads: new ThreadStore(),
    send: (message: unknown) => messages.push(message),
  } as any;
  const invoke = (id: string, threadId: ThreadId) => {
    handleThreadsCreate(ctx, {
      t: "api.req",
      id,
      method: "threads.create",
      path: "/threads/create",
      body: {
        workspaceId,
        threadId,
        engine: "codex",
        title: "Storage race thread",
        sharedThreadAcl: sharedThreadAcl("user_owner"),
      },
    } as any);
    return [...messages].reverse().find((message: any) => message.t === "api.res" && message.id === id);
  };
  let originalGet!: typeof db.threads.get;
  let originalCreate!: typeof db.threads.create;

  initializeLocalEngineModelCatalog();
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    originalGet = workspaceDb.threads.get.bind(workspaceDb.threads);
    originalCreate = workspaceDb.threads.create.bind(workspaceDb.threads);
    const racedThreadId = "thread_storage_race" as ThreadId;
    let racedLookupCount = 0;
    (workspaceDb.threads as any).get = (threadId: ThreadId) => {
      if (threadId === racedThreadId && racedLookupCount++ === 0) return null;
      return originalGet(threadId);
    };
    (workspaceDb.threads as any).create = (input: Parameters<typeof originalCreate>[0]) => {
      originalCreate(input);
      throw new Error("UNIQUE constraint failed: threads.id");
    };
    const racedResponse = invoke("create-storage-race", racedThreadId);
    assert.equal(racedResponse.status, 200);
    assert.equal(racedResponse.body.idempotent, true);
    assert.equal(workspaceDb.threads.get(racedThreadId)?.ownerUserId, "user_owner");
    assert.equal(ctx.threads.get(racedThreadId)?.workspaceId, workspaceId);

    (workspaceDb.threads as any).get = originalGet;
    (workspaceDb.threads as any).create = () => {
      throw new Error("FOREIGN KEY constraint failed");
    };
    const foreignKeyResponse = invoke("create-storage-foreign-key", "thread_storage_foreign_key" as ThreadId);
    assert.equal(foreignKeyResponse.status, 400);

    (workspaceDb.threads as any).get = () => {
      throw new Error("The database connection is not open");
    };
    const lookupFailureResponse = invoke("create-storage-lookup-failure", "thread_storage_lookup_failure" as ThreadId);
    assert.equal(lookupFailureResponse.status, 500);
    assert.equal(lookupFailureResponse.body.code, "THREAD_CREATE_STORAGE_ERROR");
  } finally {
    resetEngineModelCatalogRuntimeForTest();
    if (originalGet!) (db.forWorkspace(workspaceId).threads as any).get = originalGet;
    if (originalCreate!) (db.forWorkspace(workspaceId).threads as any).create = originalCreate;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler applies ACL batches atomically within workspace scopes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-acl-batch-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const otherWorkspaceId = "workspace_other" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const otherPath = path.join(tempDir, "other");
    fs.mkdirSync(otherPath, { recursive: true });
    db.workspaces.upsert({ id: otherWorkspaceId, title: "other", path: otherPath });
    const workspaceDb = db.forWorkspace(workspaceId);
    const otherWorkspaceDb = db.forWorkspace(otherWorkspaceId);
    for (const threadId of ["thread_batch_a", "thread_batch_b", "thread_foreign_shared"] as const) {
      workspaceDb.threads.create({
        id: threadId as never,
        workspaceId,
        engine: "codex",
        title: threadId,
      });
    }
    otherWorkspaceDb.threads.create({
      id: "thread_foreign_workspace" as never,
      workspaceId: otherWorkspaceId,
      engine: "codex",
      title: "thread_foreign_workspace",
    });
    for (const threadId of ["thread_batch_a", "thread_batch_b"] as const) {
      assert.equal(workspaceDb.threads.setSharedAcl(threadId as never, {
        sharedWorkspaceId: "sw_host" as never,
        ownerUserId: "owner_old",
        visibility: "participants",
        participantUserIds: [],
        updatedAt: 1000,
      }), true);
    }
    assert.equal(workspaceDb.threads.setSharedAcl("thread_foreign_shared" as never, {
      sharedWorkspaceId: "sw_other" as never,
      ownerUserId: "owner_old",
      visibility: "participants",
      participantUserIds: [],
      updatedAt: 1000,
    }), true);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir], [otherWorkspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-inline-acl-validation",
      operationKey: "context.list",
      payload: {
        resourceType: "thread",
        sharedThreadAclSyncItems: [
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_a",
            ownerUserId: "owner_new",
            visibility: "team",
            participantUserIds: [],
            updatedAt: 2000,
          },
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_b",
            ownerUserId: "owner_new",
            visibility: "invalid",
            participantUserIds: [],
            updatedAt: 2000,
          },
        ],
      },
    }));
    const validationResult = findRouteResult(messages, "op-inline-acl-validation");
    assert.equal(validationResult?.message.status, "failed");
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.ownerUserId, "owner_old");
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.sharedAclUpdatedAt, 1000);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-acl-chunk-rollback",
      operationKey: "context.thread.acl.sync",
      payload: {
        resourceType: "thread",
        items: [
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_a",
            ownerUserId: "owner_new",
            visibility: "team",
            participantUserIds: [],
            updatedAt: 2000,
          },
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_b",
            ownerUserId: "owner_conflict",
            visibility: "participants",
            participantUserIds: [],
            updatedAt: 1000,
          },
        ],
      },
    }));
    const rollbackResult = findRouteResult(messages, "op-acl-chunk-rollback");
    assert.equal(rollbackResult?.message.status, "failed");
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.ownerUserId, "owner_old");
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.sharedAclUpdatedAt, 1000);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-inline-acl-counts",
      operationKey: "context.list",
      payload: {
        resourceType: "thread",
        scope: "all",
        onlyRelatedToMe: false,
        sharedThreadAclSyncItems: [
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_a",
            ownerUserId: "owner_new",
            visibility: "team",
            participantUserIds: [],
            updatedAt: 1500,
          },
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_batch_b",
            ownerUserId: "stale_owner",
            visibility: "team",
            participantUserIds: [],
            updatedAt: 900,
          },
          {
            sharedWorkspaceId: "sw_host",
            threadId: "thread_missing",
            ownerUserId: "owner_missing",
            visibility: "participants",
            participantUserIds: [],
            updatedAt: 1500,
          },
        ],
      },
    }));
    const countsResult = findRouteResult(messages, "op-inline-acl-counts");
    assert.equal(countsResult?.message.status, "succeeded");
    assert.deepEqual((countsResult?.message.result as any).sharedThreadAclSync, {
      applied: true,
      processed: 3,
      updated: 1,
      missing: 1,
      stale: 1,
    });
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.ownerUserId, "owner_new");
    assert.equal(workspaceDb.threads.get("thread_batch_a" as never)?.sharedAclUpdatedAt, 1500);
    assert.equal(workspaceDb.threads.get("thread_batch_b" as never)?.ownerUserId, "owner_old");
    assert.equal(workspaceDb.threads.get("thread_batch_b" as never)?.sharedAclUpdatedAt, 1000);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-inline-workspace-boundary",
      operationKey: "context.list",
      payload: {
        resourceType: "thread",
        sharedThreadAclSyncItems: [{
          sharedWorkspaceId: "sw_host",
          threadId: "thread_foreign_workspace",
          ownerUserId: "owner_new",
          visibility: "participants",
          participantUserIds: [],
          updatedAt: 2000,
        }],
      },
    }));
    const foreignWorkspaceResult = findRouteResult(messages, "op-inline-workspace-boundary");
    assert.equal(foreignWorkspaceResult?.message.status, "succeeded");
    assert.equal((foreignWorkspaceResult?.message.result as any).sharedThreadAclSync.missing, 1);
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-inline-shared-boundary",
      operationKey: "context.list",
      payload: {
        resourceType: "thread",
        sharedThreadAclSyncItems: [{
          sharedWorkspaceId: "sw_host",
          threadId: "thread_foreign_shared",
          ownerUserId: "owner_new",
          visibility: "participants",
          participantUserIds: [],
          updatedAt: 2000,
        }],
      },
    }));
    const foreignSharedResult = findRouteResult(messages, "op-inline-shared-boundary");
    assert.equal(foreignSharedResult?.message.status, "failed");
    assert.equal(otherWorkspaceDb.threads.get("thread_foreign_workspace" as never)?.sharedWorkspaceId, null);
    assert.equal(workspaceDb.threads.get("thread_foreign_shared" as never)?.sharedWorkspaceId, "sw_other");
    assert.throws(
      () => otherWorkspaceDb.threads.setSharedAclMany({
        workspaceId,
        sharedWorkspaceId: "sw_host" as never,
        items: [{
          sharedWorkspaceId: "sw_host" as never,
          threadId: "thread_foreign_workspace" as never,
          ownerUserId: "owner_new",
          visibility: "participants",
          participantUserIds: [],
          updatedAt: 2000,
        }],
      }),
      (error) => error instanceof SharedThreadAclWorkspaceMismatchError
        && error.context.threadId === "thread_foreign_workspace"
        && error.context.expectedWorkspaceId === workspaceId
        && error.context.actualWorkspaceId === otherWorkspaceId
        && error.context.expectedSharedWorkspaceId === "sw_host"
        && error.context.actualSharedWorkspaceId === null
        && error.context.aclUpdatedAt === 2000,
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler rejects shared AI asset-maintenance child tools without authorization", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-ai-asset-"));
  const messages: ClientToServerMessage[] = [];

  try {
    const ctx = {
      workspaces: new Map([["workspace_host", tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    const assetMaintenanceEnvelope = makeEnvelope({
      operationId: "op-ai-asset-maintenance-denied",
      operationKey: "ai.thread.send.shared",
      payload: {
        threadId: "thread_1",
        text: "try maintaining asset",
        toolOperationKey: "orch.asset.write",
        assetType: "workflow",
        workflowId: "workflow_1",
        action: "update",
      },
    });
    assetMaintenanceEnvelope.authorization = {
      actorAssetRole: "member",
      authorizationResult: "denied",
      authorizationReason: "member_maintenance_denied",
      assetType: "workflow",
      assetId: "workflow_1",
      assetAction: "update",
    };
    await handleSharedWorkspaceCommand(ctx, assetMaintenanceEnvelope);

    const maintenanceResult = findRouteResult(messages, "op-ai-asset-maintenance-denied");
    assert.equal(maintenanceResult?.message.status, "failed");
    assert.equal(maintenanceResult?.message.error?.code, "SHARED_WORKSPACE_ASSET_MAINTENANCE_FORBIDDEN");

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-ai-private-clone-denied",
      operationKey: "ai.thread.send.shared",
      payload: {
        threadId: "thread_1",
        text: "try clone to private",
        toolOperationKey: "asset.clone_to_private",
        assetType: "skill",
        assetId: "skill_1",
      },
    }));

    const cloneResult = findRouteResult(messages, "op-ai-private-clone-denied");
    assert.equal(cloneResult?.message.status, "failed");
    assert.equal(cloneResult?.message.error?.code, "SHARED_WORKSPACE_PRIVATE_CLONE_DISABLED");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler rejects path traversal before touching filesystem", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const outsidePath = path.join(tempDir, "..", "outside-shared-workspace.txt");
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-write-traversal",
      payload: { action: "write", path: "../outside-shared-workspace.txt", content: "must not escape" },
    }));

    assert.equal(fs.existsSync(outsidePath), false);
    const result = findRouteResult(messages, "op-write-traversal");
    assert.equal(result?.message.status, "failed");
    assert.equal(result?.message.error?.code, "SHARED_WORKSPACE_PAYLOAD_REDACTED");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  }
});

test("shared intake creation persists envelope scope and edits cannot replace or backfill it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-intake-scope-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const ctx = { workspaces: new Map([[workspaceId, root]]), clientId: "scope-client",
    send(message: ClientToServerMessage) { messages.push(message); } } as any;
  /** 复用真实共享路由，正文伪造不能改变已验证封套的归属。 */
  async function call(method: "orch.intakes.create" | "orch.intakes.upsert", intake: Record<string, unknown>, sharedWorkspaceId = "sw_host") {
    const operationId = `scope-${messages.length}`;
    const envelope = makeEnvelope({ operationId, operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({ method, path: "/orch/intakes", action: "create", assetType: "workflow", body: { intake } }) });
    envelope.sharedWorkspaceId = sharedWorkspaceId;
    await handleSharedWorkspaceCommand(ctx, envelope);
    return findRouteResult(messages, operationId)!.message;
  }
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: root });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    const created = await call("orch.intakes.create", { title: "共享需求", goal: "记录归属", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
    assert.equal(created.status, "succeeded");
    const intake = (created.result as any).intake;
    assert.deepEqual(intake.workspaceScope, { scopeType: "shared_workspace", scopeId: "sw_host" });
    assert.deepEqual((workspaceDb.orchIntakes.get(intake.id) as any).workspaceScope, intake.workspaceScope);
    const updated = await call("orch.intakes.upsert", { ...intake, title: "已编辑", workspaceScope: null });
    assert.equal(updated.status, "succeeded");
    assert.deepEqual((updated.result as any).intake.workspaceScope, intake.workspaceScope);
    const rejected = await call("orch.intakes.upsert", { ...intake, title: "越界编辑" }, "sw_other");
    assert.equal(rejected.status, "failed");
    assert.equal(workspaceDb.orchIntakes.get(intake.id)?.title, "已编辑");
    const upserted = await call("orch.intakes.upsert", { id: "new-upsert", title: "新 upsert", goal: "新归属" });
    assert.equal(upserted.status, "succeeded");
    assert.deepEqual((upserted.result as any).intake.workspaceScope, intake.workspaceScope);
    const legacy = workspaceDb.orchIntakes.create({ workspaceId, title: "旧需求", goal: "未知", triggerMode: "manual", taskType: "feature" });
    const editedLegacy = await call("orch.intakes.upsert", { ...legacy, title: "旧需求编辑" });
    assert.equal(editedLegacy.status, "succeeded");
    assert.equal((workspaceDb.orchIntakes.get(legacy.id) as any).workspaceScope ?? null, null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared inline proposal derives scope from verified Host envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-proposal-scope-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const workflow = { id: "wf-scope", workspaceId, name: "共享流程", description: "范围继承", family: "feature-dev", version: 1,
    nodes: [{ id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }], edges: [] };
  const ctx = { db, workspaces: new Map([[workspaceId, root]]),
    orchAssetRuntimeRead: { openWorkspace: () => ({ getAsset: () => ({ assetType: "workflow", assetId: workflow.id, definition: workflow }), listAssets: () => [] }) },
    send(message: ClientToServerMessage) { messages.push(message); } } as any;
  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: root });
    const workspaceDb = db.forWorkspace(workspaceId);
    ctx.db = workspaceDb;
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({ operationId: "proposal-scope", operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({ method: "orch.proposals.create", path: "/orch/proposals", action: "create", assetType: "workflow",
        body: { workflowId: workflow.id, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId },
          intake: { triggerMode: "manual", taskType: "feature", title: "共享内联", goal: "继承封套归属",
            workspaceScope: { scopeType: "shared_workspace", scopeId: "sw-attacker" } } } }) }));
    const result = findRouteResult(messages, "proposal-scope")!.message;
    assert.equal(result.status, "succeeded");
    const proposal = (result.result as any).proposal;
    const scope = { scopeType: "shared_workspace", scopeId: "sw_host" };
    assert.deepEqual(workspaceDb.orchIntakes.get(proposal.intakeId)?.workspaceScope, scope);
    assert.deepEqual(workspaceDb.orchProposals.get(proposal.id)?.intakeSnapshot.workspaceScope, scope);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("client shared workspace workflow list keeps allowedResourceIds before host pagination", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-orch-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const allowed = db.orchIntakes.create({
      workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "Allowed",
      goal: "Allowed",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: { source: "ui" },
    });
    db.db.prepare("UPDATE orch_intakes SET updated_at = ?, created_at = ? WHERE id = ?").run(1, 1, allowed.id);
    for (let index = 0; index < 505; index += 1) {
      const intake = db.orchIntakes.create({
        workspaceId,
        triggerMode: "manual",
        taskType: "feature",
        title: `Other ${index}`,
        goal: "Other",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: { source: "ui" },
      });
      db.db.prepare("UPDATE orch_intakes SET updated_at = ?, created_at = ? WHERE id = ?").run(1000 + index, 1000 + index, intake.id);
    }

    const ctx = {
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchIntakeListReader: createTestOrchIntakeListReader(db),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-intakes-allowed-resource-ids",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.intakes.list",
        path: "/orch/intakes",
        action: "list",
        assetType: "workflow",
        body: { limit: 2, allowedResourceIds: [allowed.id] },
      }),
    }));

    const result = findRouteResult(messages, "op-orch-intakes-allowed-resource-ids");
    assert.equal(result?.message.status, "succeeded");
    assert.deepEqual((result?.message.result as any).intakes.map((item: any) => item.id), [allowed.id]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler authorizes orchestration reads with server contexts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-orch-read-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const workflow = {
      id: "workflow-read",
      workspaceId,
      name: "read workflow",
      description: "",
      nodes: [
        { id: "role", type: "role", label: "Role", roleId: "role-a", position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any;
    const teamInstance = workspaceDb.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: {
        id: "req_team",
        workspaceId,
        triggerMode: "manual",
        taskType: "test",
        title: "team intake",
        goal: "team",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
    });
    const privateInstance = workspaceDb.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: {
        id: "req_private",
        workspaceId,
        triggerMode: "manual",
        taskType: "test",
        title: "private intake",
        goal: "private",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
    });
    const allowedRequirementContexts = [{
      id: "ctx_req_team",
      sharedWorkspaceId: "sw_host",
      enterpriseId: "ent_1",
      hostWorkspaceId: workspaceId,
      resourceType: "requirement",
      resourceId: "req_team",
      ownerUserId: "user_b",
      visibility: "team",
      participantUserIds: [],
      titleSummary: "team intake",
      createdAt: 1,
      updatedAt: 1,
      relatedToMe: false,
      relatedReasons: [],
      readOnly: true,
    }];
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-read-team",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.instances.get",
        path: "/orch/instances/get",
        action: "get",
        assetType: "workflow",
        assetId: teamInstance.id,
        body: { instanceId: teamInstance.id, allowedRequirementContexts },
      }),
    }));
    const teamResult = findRouteResult(messages, "op-orch-read-team");
    assert.equal(teamResult?.message.status, "succeeded");
    assert.equal((teamResult?.message.result as any).instance.readOnly, true);
    assert.equal((teamResult?.message.result as any).instance.sharedContext.visibility, "team");

    workspaceDb.orchEvents.append({
      instanceId: teamInstance.id,
      nodeId: "role",
      type: "orchestration.nodeStateChanged",
      payloadJson: JSON.stringify({
        instanceId: teamInstance.id,
        nodeId: "role",
        nodeLabel: "Role",
        status: "completed",
        nodeState: { status: "completed", output: "x".repeat(50_000) },
      }),
    });
    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-events-team-summary",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.events.list",
        path: "/orch/events/list",
        action: "list",
        assetType: "workflow",
        assetId: teamInstance.id,
        body: { instanceId: teamInstance.id, allowedRequirementContexts, limit: 200 },
      }),
    }));
    const teamEventsResult = findRouteResult(messages, "op-orch-events-team-summary");
    assert.equal(teamEventsResult?.message.status, "succeeded");
    const eventPayloadJson = String((teamEventsResult?.message.result as any).events?.[0]?.payloadJson ?? "");
    assert.equal(eventPayloadJson.includes("nodeState"), false);
    assert.ok(eventPayloadJson.length < 1_000);

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-read-private-denied",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.instances.get",
        path: "/orch/instances/get",
        action: "get",
        assetType: "workflow",
        assetId: privateInstance.id,
        body: { instanceId: privateInstance.id, allowedRequirementContexts },
      }),
    }));
    const privateResult = findRouteResult(messages, "op-orch-read-private-denied");
    assert.equal(privateResult?.message.status, "failed");
    assert.equal(privateResult?.message.error?.code, "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN");

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-events-private-denied",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.events.list",
        path: "/orch/events/list",
        action: "list",
        assetType: "workflow",
        assetId: privateInstance.id,
        body: { instanceId: privateInstance.id, allowedRequirementContexts, limit: 200 },
      }),
    }));
    const privateEventsResult = findRouteResult(messages, "op-orch-events-private-denied");
    assert.equal(privateEventsResult?.message.status, "failed");
    assert.equal(privateEventsResult?.message.error?.code, "SHARED_WORKSPACE_CONTEXT_DETAIL_FORBIDDEN");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler routes orchestration node reassign", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-reassign-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const workflow = {
      id: "workflow-reassign",
      workspaceId,
      name: "reassign workflow",
      description: "",
      nodes: [
        { id: "role", type: "role", label: "Role", roleId: "role-a", position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any;
    const instance = workspaceDb.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: {
        id: "intake-reassign",
        workspaceId,
        triggerMode: "manual",
        taskType: "test",
        title: "reassign intake",
        goal: "reassign",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
    });
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-reassign-node",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.instances.reassignNode",
        path: "/orch/instances/reassign-node",
        action: "reassign",
        assetType: "workflow",
        assetId: instance.id,
        body: {
          instanceId: instance.id,
          nodeId: "role",
          assigneeUserIds: ["user-a"],
        },
      }),
    }));

    const result = findRouteResult(messages, "op-orch-reassign-node");
    assert.equal(result?.message.status, "succeeded");
    assert.deepEqual(workspaceDb.orchInstances.get(instance.id)?.nodeStates.role.assigneeUserIds, ["user-a"]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler routes orchestration feedback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-feedback-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];
  const feedbackCalls: any[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const workflow = {
      id: "workflow-feedback",
      workspaceId,
      name: "feedback workflow",
      description: "",
      nodes: [
        { id: "role", type: "role", label: "Role", roleId: "role-a", position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any;
    const instance = workspaceDb.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      intakeSnapshot: {
        id: "intake-feedback",
        workspaceId,
        triggerMode: "manual",
        taskType: "test",
        title: "feedback intake",
        goal: "feedback",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
    });
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      orchEngine: {
        forWorkspace: () => ctx.orchEngine,
        async submitFeedback(...args: any[]) {
          feedbackCalls.push(args);
        },
      },
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-feedback",
      operationKey: "orch.workflow.use",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.instances.feedback",
        path: "/orch/instances/feedback",
        action: "feedback",
        assetType: "workflow",
        assetId: instance.id,
        body: {
          instanceId: instance.id,
          nodeId: "role",
          action: "resume_with_input",
          feedback: "修改的子系统应该是 drs",
          artifactIds: [],
          targetNodeId: null,
          threadReusePolicy: "reuse-existing",
        },
      }),
    }));

    const result = findRouteResult(messages, "op-orch-feedback");
    assert.equal(result?.message.status, "succeeded");
    assert.equal(feedbackCalls.length, 1);
    assert.equal(feedbackCalls[0][0], instance.id);
    assert.equal(feedbackCalls[0][1], "role");
    assert.equal(feedbackCalls[0][2], "resume_with_input");
    assert.deepEqual(feedbackCalls[0][3], {
      feedback: "修改的子系统应该是 drs",
      artifactIds: null,
      targetNodeId: null,
      images: [],
    });
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client shared workspace host handler routes explicit assignee template list RPC", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-shared-workspace-host-template-list-"));
  const workspaceId = "workspace_host" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const messages: ClientToServerMessage[] = [];

  try {
    db.workspaces.upsert({ id: workspaceId, title: "host", path: tempDir });
    const workspaceDb = db.forWorkspace(workspaceId);
    const ctx = {
      db: workspaceDb,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (msg: ClientToServerMessage) => messages.push(msg),
    } as any;
    workspaceDb.orchAssigneeTemplates.upsert({
      id: "template-workflow-reassign",
      workspaceId,
      workflowId: "workflow-reassign" as never,
      name: "Shared assignees",
      status: "published",
      nodeAssigneeUserIdsByNodeId: { node_req: ["user_member"] },
    });

    await handleSharedWorkspaceCommand(ctx, makeEnvelope({
      operationId: "op-orch-assignee-template-list",
      operationKey: "orch.asset.read",
      payload: buildSharedWorkspaceHostRpcPayload({
        method: "orch.assigneeTemplates.list",
        path: "/orch/assignee-templates",
        action: "list",
        assetType: "workflow",
        assetId: "workflow-reassign",
        body: { workflowId: "workflow-reassign" },
      }),
    }));

    const result = findRouteResult(messages, "op-orch-assignee-template-list");
    assert.equal(result?.message.status, "succeeded");
    assert.equal((result?.message.result as any).templates[0].id, "template-workflow-reassign");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
