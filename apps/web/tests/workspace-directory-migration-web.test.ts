import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceDirectoryMigrationChangedEvent,
  WorkspaceDirectoryMigrationOperation,
  WorkspaceDirectoryMigrationHostMaintenance,
  WorkspaceSummary,
} from "@codeflowai/shared";
import { createPinia, setActivePinia } from "pinia";

import {
  cancelWorkspaceDirectoryMigration,
  getWorkspaceDirectoryMigration,
  prepareWorkspaceDirectoryMigration,
  recoverWorkspaceDirectoryMigration,
  startWorkspaceDirectoryMigration,
} from "../src/api/workspaces/index.ts";
import { type ApiRequestContext } from "../src/api/request.ts";
import { startLocalWorkspaceDirectoryMigration } from "../src/features/workspaces/workspaceDirectoryMigrationLocal.ts";
import { registerWorkspaceDraftFlusher } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useSharedWorkspacesStore } from "../src/store/sharedWorkspaces.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import {
  getWorkspaceDirectoryMigrationDisabledReason,
  isWorkspaceDirectoryMigrationActionDisabled,
} from "../src/features/workspaces/workspaceDirectoryMigrationPolicy.ts";

const originalFetch = globalThis.fetch;

/** 创建固定登录态上下文，验证迁移 API 的路径、请求体和鉴权头。 */
function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-test",
    webSessionId: "web-test",
    ensureSession: async () => "session-test",
  };
}

/** 构造最小完整迁移操作，测试只覆盖 Store 需要的状态字段。 */
function createOperation(overrides: Partial<WorkspaceDirectoryMigrationOperation> = {}): WorkspaceDirectoryMigrationOperation {
  return {
    operationId: "op-1",
    workspaceId: "client-a:root",
    state: "scanning",
    stateVersion: 1,
    phase: "checking",
    sourcePath: "C:\\source",
    targetPath: "D:\\target",
    sourceFileCount: 2,
    sourceDirectoryCount: 1,
    sourceTotalBytes: 2048,
    excludedDependencyDirectoryCount: 0,
    excludedDependencyDirectories: [],
    copiedFiles: 0,
    copiedBytes: 0,
    progressPct: 0,
    canStart: false,
    canCancel: true,
    currentPath: "C:\\source",
    blockers: [],
    sharedBlockers: [],
    errorCode: null,
    errorMessage: null,
    errorDetails: null,
    warningCode: null,
    warningDetails: null,
    startAttemptId: null,
    startDisposition: null,
    indexRebuildGeneration: null,
    indexRebuildStatus: "not_started",
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
    ...overrides,
  };
}

/** 返回可被多个 API adapter 消费的成功 JSON 响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("directory migration API adapters preserve paths, bodies, and auth", async () => {
  const requests: Array<{ method: string; url: string; body: unknown; authorization: string | null }> = [];
  const operation = createOperation({ operationId: "op-api" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      method: String(init?.method ?? "GET"),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return jsonResponse({ ok: true, operation });
  }) as typeof fetch;

  const ctx = createApiContext();
  await prepareWorkspaceDirectoryMigration(ctx, "client-a:root", {
    idempotencyKey: "idem-1",
    targetParentPath: "D:\\workspaces",
    targetDirectoryName: "root-new",
  });
  await getWorkspaceDirectoryMigration(ctx, "client-a:root", "op-api");
  await startWorkspaceDirectoryMigration(ctx, "client-a:root", "op-api", {
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
  });
  await cancelWorkspaceDirectoryMigration(ctx, "client-a:root", "op-api", { reason: "user_cancelled" });
  await recoverWorkspaceDirectoryMigration(ctx, "client-a:root", "op-api");

  assert.deepEqual(requests.map(({ method, url, body, authorization }) => ({
    method,
    path: new URL(url).pathname,
    body,
    authorization,
  })), [
    {
      method: "POST",
      path: "/api/workspaces/client-a%3Aroot/directory-migrations",
      body: { idempotencyKey: "idem-1", targetParentPath: "D:\\workspaces", targetDirectoryName: "root-new" },
      authorization: "Bearer session-test",
    },
    {
      method: "GET",
      path: "/api/workspaces/client-a%3Aroot/directory-migrations/op-api",
      body: null,
      authorization: "Bearer session-test",
    },
    {
      method: "POST",
      path: "/api/workspaces/client-a%3Aroot/directory-migrations/op-api/start",
      body: { externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true },
      authorization: "Bearer session-test",
    },
    {
      method: "POST",
      path: "/api/workspaces/client-a%3Aroot/directory-migrations/op-api/cancel",
      body: { reason: "user_cancelled" },
      authorization: "Bearer session-test",
    },
    {
      method: "POST",
      path: "/api/workspaces/client-a%3Aroot/directory-migrations/op-api/recover",
      body: {},
      authorization: "Bearer session-test",
    },
  ]);
});

test("workspace migration events converge by alias, operation timestamp, and stateVersion", () => {
  setActivePinia(createPinia());
  const store = useWorkspacesStore();
  store.workspaces = [{
    id: "client-a:root",
    title: "Root",
    path: "C:\\source",
    kind: "local",
    createdAt: 1,
    updatedAt: 1,
  }] as WorkspaceSummary[];

  store.setMigrationOperation(createOperation({ workspaceId: "root", stateVersion: 5, updatedAt: 500 }));
  assert.equal(store.migrationForWorkspace("root")?.operationId, "op-1");

  const staleEvent: WorkspaceDirectoryMigrationChangedEvent = {
    operationId: "op-1",
    workspaceId: "client-a:root",
    state: "scanning",
    stateVersion: 4,
    phase: "checking",
    progressPct: 10,
    copiedBytes: 100,
    totalBytes: 2048,
    updatedAt: 499,
  };
  store.applyDirectoryMigrationChanged(staleEvent);
  assert.equal(store.migrationForWorkspace("client-a:root")?.stateVersion, 5);

  store.setMigrationOperation(createOperation({ operationId: "op-2", state: "copying", phase: "copying", updatedAt: 700 }));
  store.applyDirectoryMigrationChanged({
    ...staleEvent,
    state: "completed",
    phase: "completed",
    stateVersion: 99,
    updatedAt: 600,
  });
  assert.equal(store.migrationForWorkspace("client-a:root")?.operationId, "op-2");
  assert.equal(store.workspaces[0]?.activeDirectoryMigration?.operationId, "op-2");

  store.applyDirectoryMigrationChanged({
    ...staleEvent,
    operationId: "op-2",
    state: "completed",
    phase: "completed",
    stateVersion: 8,
    progressPct: 100,
    updatedAt: 800,
  });
  assert.equal(store.migrationForWorkspace("root")?.state, "completed");
  assert.equal(store.workspaces[0]?.activeDirectoryMigration, null);
});

test("migration event preserves Server workspace decorations and rejects same-version state changes", () => {
  setActivePinia(createPinia());
  const store = useWorkspacesStore();
  store.workspaces = [{
    id: "client-a:root",
    title: "Root",
    path: "C:\\source",
    kind: "local",
    ownerClientId: "client-a",
    hostedSharedCount: 2,
    hostedShared: { sharedWorkspaceId: "sw-1", displayName: "Shared One" },
    capabilities: { canUseAssets: true, canMaintainAssets: true },
    createdAt: 1,
    updatedAt: 1,
  }] as WorkspaceSummary[];
  store.setMigrationOperation(createOperation({ state: "copying", phase: "copying", stateVersion: 3 }));

  const sameVersionNeedsRefresh = store.applyDirectoryMigrationChanged({
    operationId: "op-1",
    workspaceId: "client-a:root",
    state: "completed",
    stateVersion: 3,
    phase: "completed",
    progressPct: 80,
    copiedBytes: 80,
    totalBytes: 100,
    updatedAt: 300,
    workspace: {
      id: "client-a:root",
      title: "Root",
      path: "D:\\target",
      createdAt: 1,
      updatedAt: 300,
     },
   });
  assert.equal(sameVersionNeedsRefresh, false);
  assert.equal(store.migrationForWorkspace("root")?.state, "copying");
  assert.equal(store.workspaces[0]?.path, "C:\\source");
  assert.equal(store.workspaces[0]?.hostedSharedCount, 2);
  assert.equal(store.workspaces[0]?.capabilities?.canMaintainAssets, true);

  store.setMigrationOperation(createOperation({
    state: "completed",
    phase: "completed",
    stateVersion: 3,
    updatedAt: 400,
    canStart: false,
    sharedBlockers: [{ code: "WORKSPACE_MIGRATION_SHARED_ACTIVITY", message: "共享活动未结束" }],
  }));
  assert.equal(store.migrationForWorkspace("root")?.state, "copying");
  assert.equal(store.migrationForWorkspace("root")?.sharedBlockers.length, 1);
  assert.equal(store.workspaces[0]?.activeDirectoryMigration?.state, "copying");

  const jumpedNeedsRefresh = store.applyDirectoryMigrationChanged({
    operationId: "op-1",
    workspaceId: "client-a:root",
    state: "completed",
    stateVersion: 6,
    phase: "completed",
    progressPct: 100,
    copiedBytes: 100,
    totalBytes: 100,
    updatedAt: 600,
    workspace: {
      id: "client-a:root",
      title: "Root",
      path: "D:\\target",
      createdAt: 1,
      updatedAt: 600,
    },
  });
  assert.equal(jumpedNeedsRefresh, true);
  assert.equal(store.workspaces[0]?.path, "D:\\target");
  assert.equal(store.workspaces[0]?.activeDirectoryMigration, null);
  assert.equal(store.workspaces[0]?.hostedSharedCount, 2);
});

test("shared Host maintenance ignores older epochs and updates shared/local projections", () => {
  setActivePinia(createPinia());
  const workspaces = useWorkspacesStore();
  const shared = useSharedWorkspacesStore();
  workspaces.workspaces = [{
    id: "shared:sw-1",
    title: "Shared",
    path: "",
    kind: "shared",
    shared: { sharedWorkspaceId: "sw-1", hostMaintenance: null },
    createdAt: 1,
    updatedAt: 1,
  }] as WorkspaceSummary[];
  shared.items = [{ id: "sw-1", hostMaintenance: null }] as never[];

  const active: WorkspaceDirectoryMigrationHostMaintenance = {
    active: true,
    maintenanceEpoch: "epoch-2",
    maintenanceVersion: 2,
    phase: "copying",
    progressPct: 40,
    updatedAt: 200,
  };
  shared.applyTopicEvent({
    type: "sharedWorkspace.host.maintenance.changed",
    sharedWorkspaceId: "sw-1",
    enterpriseId: "ent-1",
    seq: 2,
    ts: 200,
    payload: active,
  });
  assert.equal(shared.items[0]?.hostMaintenance?.active, true);
  assert.equal(workspaces.workspaces[0]?.hostMaintenance?.maintenanceVersion, 2);

  shared.applyTopicEvent({
    type: "sharedWorkspace.host.maintenance.changed",
    sharedWorkspaceId: "sw-1",
    enterpriseId: "ent-1",
    seq: 1,
    ts: 100,
    payload: { ...active, active: false, maintenanceVersion: 1, updatedAt: 100 },
  });
  assert.equal(shared.items[0]?.hostMaintenance?.active, true);
  assert.equal(workspaces.workspaces[0]?.hostMaintenance?.active, true);

  shared.applyTopicEvent({
    type: "sharedWorkspace.host.maintenance.changed",
    sharedWorkspaceId: "sw-1",
    enterpriseId: "ent-1",
    seq: 3,
    ts: 300,
    payload: { ...active, active: false, maintenanceVersion: 3, updatedAt: 300 },
  });
  assert.equal(shared.items[0]?.hostMaintenance?.active, false);
  assert.equal(workspaces.workspaces[0]?.hostMaintenance?.active, false);
});

test("shared workspace rename syncs shared and hosted workspace display caches", () => {
  setActivePinia(createPinia());
  const workspaces = useWorkspacesStore();
  workspaces.workspaces = [
    {
      id: "shared:sw-1",
      title: "旧共享名",
      path: "旧共享名",
      kind: "shared",
      shared: { sharedWorkspaceId: "sw-1", displayName: "旧共享名" } as never,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "client-a:root",
      title: "Local Root",
      path: "C:\\source",
      kind: "local",
      hostedShared: { sharedWorkspaceId: "sw-1", displayName: "旧共享名" } as never,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "shared:sw-2",
      title: "Host Label",
      path: "Host Path",
      kind: "shared",
      shared: { sharedWorkspaceId: "sw-2", displayName: "旧共享名", hostLabel: "Host Label" } as never,
      createdAt: 3,
      updatedAt: 3,
    },
  ] as WorkspaceSummary[];

  workspaces.applySharedWorkspaceRename("sw-1", "新共享名", 99);
  workspaces.applySharedWorkspaceRename("sw-2", "新共享名", 100);

  assert.equal(workspaces.workspaces[0]?.title, "新共享名");
  assert.equal(workspaces.workspaces[0]?.path, "新共享名");
  assert.equal(workspaces.workspaces[0]?.shared?.displayName, "新共享名");
  assert.equal(workspaces.workspaces[0]?.updatedAt, 99);
  assert.equal(workspaces.workspaces[1]?.title, "Local Root");
  assert.equal(workspaces.workspaces[1]?.hostedShared?.displayName, "新共享名");
  assert.equal(workspaces.workspaces[2]?.title, "Host Label");
  assert.equal(workspaces.workspaces[2]?.path, "Host Path");
  assert.equal(workspaces.workspaces[2]?.shared?.displayName, "新共享名");
});

test("migration action policy disables missing capability but allows active recovery", () => {
  const workspace = {
    id: "client-a:root",
    title: "Root",
    path: "C:\\source",
    createdAt: 1,
    updatedAt: 1,
  } as WorkspaceSummary;
  const client = {
    clientId: "client-a",
    version: "1.0.0",
    connectedAt: 1,
    workspaceIds: ["client-a:root"],
    capabilities: {},
  };

  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({ workspace, client, connected: true }), true);
  assert.equal(getWorkspaceDirectoryMigrationDisabledReason({ workspace, client, connected: true }), "请先升级工作区所属 Client");
  // 桌面本机工作区直连内置 Client：不要求 Server 会话，也不依赖 presence capability。
  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({ workspace, client, connected: false, localDesktop: true }), false);
  assert.equal(getWorkspaceDirectoryMigrationDisabledReason({ workspace, client: null, connected: false, localDesktop: true }), "工作区所属 Client 离线");
  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({ workspace, client, connected: false }), true);
  assert.equal(getWorkspaceDirectoryMigrationDisabledReason({ workspace, client, connected: false }), "当前未连接 Server");
  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({
    workspace: { ...workspace, activeDirectoryMigration: { operationId: "op-1" } as WorkspaceSummary["activeDirectoryMigration"] },
    client: null,
    connected: false,
  }), false);
  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({
    workspace: { ...workspace, directoryMigrationIndexState: { operationId: "op-1", stateVersion: 4, indexRebuildGeneration: 2, indexRebuildStatus: "failed", warningCode: "WORKSPACE_INDEX_REBUILD_FAILED", updatedAt: 4 } },
    client: { ...client, capabilities: { workspaceDirectoryMigrationV1: true } },
    connected: true,
  }), false);
  assert.equal(isWorkspaceDirectoryMigrationActionDisabled({
    workspace: { ...workspace, directoryMigrationIndexState: { operationId: "op-1", stateVersion: 4, indexRebuildGeneration: 2, indexRebuildStatus: "pending", warningCode: null, updatedAt: 4 } },
    client: { ...client, capabilities: { workspaceDirectoryMigrationV1: true } },
    connected: true,
  }), true);
});

test("desktop local migration start uses prepareStart then executeStart without Server", async (t) => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const originalWindow = globalThis.window;
  const accepted = createOperation({
    workspaceId: "client-a:root", state: "preparing", stateVersion: 4,
    startAttemptId: "start-attempt", startDisposition: "accepted",
  });
  globalThis.window = {
    codeflowDesktop: {
      getState: async () => ({ status: "ready", requestId: "runtime", releaseId: null, errorCode: null }),
      request: async (request: { method: string; body: Record<string, unknown> }) => {
        requests.push(structuredClone(request));
        if (request.method === "workspaceDirectoryMigration.prepareStart") {
          return { status: 200, body: { ok: true, operation: createOperation({
            workspaceId: "client-a:root", state: "awaiting_confirmation", stateVersion: 3,
            startAttemptId: String(request.body.startAttemptId), startDisposition: "prepared", canStart: true,
          }) } };
        }
        if (request.method === "workspaceDirectoryMigration.executeStart") {
          return { status: 200, body: { ok: true, operation: accepted } };
        }
        throw new Error(`UNEXPECTED_DESKTOP_METHOD: ${request.method}`);
      },
    },
  } as unknown as Window & typeof globalThis;
  t.after(() => {
    if (originalWindow) globalThis.window = originalWindow;
    else Reflect.deleteProperty(globalThis, "window");
  });

  const result = await startLocalWorkspaceDirectoryMigration("client-a:root", "op-1", {
    externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true,
  });
  assert.deepEqual(result, { ok: true, operation: accepted });
  assert.deepEqual(requests.map((request) => request.method), [
    "workspaceDirectoryMigration.prepareStart", "workspaceDirectoryMigration.executeStart",
  ]);
  assert.equal(requests[0]?.body.workspaceId, "client-a:root");
  assert.equal(requests[0]?.body.operationId, "op-1");
  assert.equal(requests[0]?.body.externalWritesPausedConfirmed, true);
  assert.equal(requests[1]?.body.startAttemptId, requests[0]?.body.startAttemptId);
  assert.equal(requests[1]?.body.expectedStateVersion, 3);
});

test("completed migration reloads only after drafts flush successfully", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const originalWindow = globalThis.window;
  let reloadCount = 0;
  globalThis.window = { location: { reload: () => { reloadCount += 1; } } } as unknown as Window & typeof globalThis;
  try {
    const order: string[] = [];
    const unregisterSuccess = registerWorkspaceDraftFlusher(async () => { order.push("draft"); });
    await config.reloadCurrentWorkspacePage(async () => { order.push("refresh"); });
    unregisterSuccess();
    assert.equal(reloadCount, 1);
    assert.deepEqual(order, ["draft", "refresh"]);

    let continueAfterDraft = true;
    const guardedOrder: string[] = [];
    const unregisterGuardedDraft = registerWorkspaceDraftFlusher(async () => {
      guardedOrder.push("draft");
      continueAfterDraft = false;
    });
    await config.reloadCurrentWorkspacePage(
      async () => { guardedOrder.push("refresh"); },
      () => continueAfterDraft,
    );
    unregisterGuardedDraft();
    assert.equal(reloadCount, 1);
    assert.deepEqual(guardedOrder, ["draft"]);

    let continueAfterRefresh = true;
    await config.reloadCurrentWorkspacePage(
      async () => { continueAfterRefresh = false; },
      () => continueAfterRefresh,
    );
    assert.equal(reloadCount, 1);

    const unregister = registerWorkspaceDraftFlusher(() => Promise.reject(new Error("草稿保存失败")));
    try {
      await assert.rejects(() => config.reloadCurrentWorkspacePage(), /草稿保存失败/u);
      assert.equal(reloadCount, 1);
    } finally {
      unregister();
    }
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: Window & typeof globalThis }).window;
    else globalThis.window = originalWindow;
  }
});
