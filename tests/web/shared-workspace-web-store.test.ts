import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "../support/web-pinia.ts";

import type { AccountUserSummary, SharedWorkspaceTopicEvent } from "../../packages/shared/src/index.ts";
import { makeSharedWorkspaceSelectionId } from "../../packages/shared/src/index.ts";
import { useConfigStore } from "../../apps/web/src/store/config.ts";
import { usePresenceStore } from "../../apps/web/src/store/presence.ts";
import { useSharedWorkspacesStore } from "../../apps/web/src/store/sharedWorkspaces.ts";
import { useWorkspacesStore } from "../../apps/web/src/store/workspaces.ts";

const originalFetch = globalThis.fetch;

/** 构造 JSON 响应，供 store 测试拦截领域 API。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 配置账号会话，确保测试走真实 requestJson 鉴权上下文。 */
function configureAccountSession(accountRole: AccountUserSummary["accountRole"] = "super_admin"): void {
  const config = useConfigStore();
  const userSummary: AccountUserSummary = {
    userId: "user_store_scope",
    email: "store-scope@test.local",
    fullName: "Store Scope",
    phone: "",
    avatarUrl: null,
    accountRole,
    status: "active",
    enterpriseId: accountRole === "enterprise_admin" ? "enterprise_scope" : null,
    enterpriseName: accountRole === "enterprise_admin" ? "Enterprise Scope" : null,
  };
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.webSessionId = "web-store-scope";
  config.authMode = "account";
  config.accountRole = accountRole;
  config.userSummary = userSummary;
  config.setSession({ token: "session-store-scope", expiresAt: Date.now() + 60_000 });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("web shared workspace store reduces host and route topic events without exposing host path hints", () => {
  setActivePinia(createPinia());
  const store = useSharedWorkspacesStore();
  store.items = [{
    id: "sw_web",
    enterpriseId: "enterprise_web",
    name: "Web workspace",
    description: "",
    createdByUserId: "user_creator",
    workspaceAdminUserId: "user_host",
    lifecycleStatus: "active",
    hostStatus: "offline",
    memberCount: 2,
    createdAt: 1,
    updatedAt: 1,
    currentUserRole: "member",
    host: null,
  }];

  const hostEvent: SharedWorkspaceTopicEvent = {
    type: "sharedWorkspace.host.status.changed",
    sharedWorkspaceId: "sw_web",
    enterpriseId: "enterprise_web",
    seq: 1,
    ts: 10,
    payload: {
      hostStatus: "online",
      reason: "registered",
      host: {
        id: "binding_web",
        sharedWorkspaceId: "sw_web",
        enterpriseId: "enterprise_web",
        hostUserId: "user_host",
        hostClientId: "client_host",
        localWorkspaceId: "workspace_host",
        localWorkspaceLabel: "Host workspace",
        capabilitySnapshot: { fs: true, capturedAt: 10 },
        status: "online",
        lastSeenAt: 10,
        heartbeatExpiresAt: 20,
        boundAt: 1,
        updatedAt: 10,
      },
    },
  };
  store.applyTopicEvent(hostEvent);

  assert.equal(store.items[0]?.hostStatus, "online");
  assert.equal(store.items[0]?.host?.hostClientId, "client_host");
  assert.equal(Object.hasOwn(store.items[0]?.host ?? {}, "hostKeyHash"), false);
  assert.equal(Object.hasOwn(store.items[0]?.host ?? {}, "localWorkspacePathHint"), false);

  store.applyTopicEvent({
    type: "sharedWorkspace.route.event.changed",
    sharedWorkspaceId: "sw_web",
    enterpriseId: "enterprise_web",
    seq: 3,
    ts: 12,
    payload: {
      routeEvent: {
        id: "route_web",
        sharedWorkspaceId: "sw_web",
        enterpriseId: "enterprise_web",
        actorUserId: "user_member",
        actorRemoteSessionId: "session_member" as never,
        hostBindingId: "binding_web",
        operationId: "op_web",
        policyKey: "workspace.fs.read",
        toolPolicyKey: null,
        operationType: "fs.read",
        lockRequired: false,
        effectiveLockRequired: false,
        usageRequired: false,
        auditAction: "shared_workspace.fs_read",
        handlerId: "fs.read",
        upgradedFromOperationId: null,
        lockVersion: null,
        assetType: "unknown",
        assetId: "",
        assetAction: "read",
        actorAssetRole: "member",
        authorizationResult: "not_applicable",
        authorizationReason: "",
        status: "succeeded",
        payloadSummary: { path: "README.md" },
        errorCode: null,
        errorMessage: null,
        createdAt: 12,
        routedAt: 12,
        completedAt: 12,
        updatedAt: 12,
      },
    },
  });
  assert.equal(store.routeEventsByWorkspaceId.sw_web?.[0]?.type, "sharedWorkspace.route.event.changed");
});

test("shared host topic event updates direct workspace runtime without a list refresh", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const sharedWorkspaces = useSharedWorkspacesStore();
  const workspaces = useWorkspacesStore();
  const sharedWorkspaceId = "sw_runtime_sync";
  const selectionId = makeSharedWorkspaceSelectionId(sharedWorkspaceId);

  config.workspaceId = selectionId;
  workspaces.workspaces = [{
    id: selectionId,
    title: "Runtime sync",
    path: "Runtime sync",
    createdAt: 1,
    updatedAt: 1,
    kind: "shared",
    entryStatus: "host_offline",
    disabledReason: "执行主机离线，资料暂不可达",
    shared: {
      sharedWorkspaceId: sharedWorkspaceId as never,
      displayName: "Runtime sync",
      currentUserRole: "member",
      effectiveAssetRole: "member",
      hostStatus: "offline",
      hostClientId: "client_old" as never,
      hostLocalWorkspaceId: "workspace_old" as never,
      hostLabel: "Old host",
      isHostOwner: true,
      assetPermissions: {
        effectiveAssetRole: "member",
        maintenanceScope: "workspace_all",
        canReadAssets: true,
        canUseAssets: true,
        canMaintainAssets: false,
        canCloneToPrivate: false,
        canAcquireAssetMaintenanceLock: false,
      },
    },
  }];

  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "offline" });

  sharedWorkspaces.applyTopicEvent({
    type: "sharedWorkspace.host.status.changed",
    sharedWorkspaceId,
    enterpriseId: "enterprise_runtime_sync",
    seq: 1,
    ts: 2,
    payload: {
      hostStatus: "online",
      reason: "registered",
      host: {
        id: "binding_runtime_sync" as never,
        sharedWorkspaceId: sharedWorkspaceId as never,
        enterpriseId: "enterprise_runtime_sync",
        hostUserId: "user_runtime_host",
        hostClientId: "client_runtime_host" as never,
        localWorkspaceId: "workspace_runtime_host" as never,
        localWorkspaceLabel: "Runtime host",
        capabilitySnapshot: { fs: true, capturedAt: 2 },
        status: "online",
        lastSeenAt: 2,
        heartbeatExpiresAt: 10,
        boundAt: 1,
        updatedAt: 2,
      },
    },
  });

  assert.equal(workspaces.workspaces[0]?.entryStatus, "available");
  assert.equal(workspaces.workspaces[0]?.disabledReason, null);
  assert.equal(workspaces.workspaces[0]?.shared?.hostStatus, "online");
  assert.equal(workspaces.workspaces[0]?.shared?.hostClientId, "client_runtime_host");
  assert.equal(workspaces.workspaces[0]?.shared?.hostLocalWorkspaceId, "workspace_runtime_host");
  assert.equal(workspaces.workspaces[0]?.shared?.hostLabel, "Runtime host");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "online" });

  sharedWorkspaces.applyTopicEvent({
    type: "sharedWorkspace.host.status.changed",
    sharedWorkspaceId,
    enterpriseId: "enterprise_runtime_sync",
    seq: 2,
    ts: 3,
    payload: {
      hostStatus: "unbound",
      reason: "deleted",
      host: null,
    },
  });

  assert.equal(workspaces.workspaces[0]?.entryStatus, "host_unbound");
  assert.equal(workspaces.workspaces[0]?.shared?.hostClientId, null);
  assert.equal(workspaces.workspaces[0]?.shared?.hostLocalWorkspaceId, null);
  assert.equal(workspaces.workspaces[0]?.shared?.hostLabel, null);
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "unbound" });

  workspaces.workspaces = workspaces.workspaces.map((workspace) => ({
    ...workspace,
    entryStatus: "forbidden",
    disabledReason: "当前账号无权进入",
  }));
  sharedWorkspaces.applyTopicEvent({
    type: "sharedWorkspace.host.status.changed",
    sharedWorkspaceId,
    enterpriseId: "enterprise_runtime_sync",
    seq: 3,
    ts: 4,
    payload: {
      hostStatus: "offline",
      reason: "disconnect",
      host: null,
    },
  });

  assert.equal(workspaces.workspaces[0]?.entryStatus, "forbidden");
  assert.equal(workspaces.workspaces[0]?.disabledReason, "当前账号无权进入");
  assert.equal(workspaces.workspaces[0]?.shared?.hostStatus, "offline");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "forbidden" });
});

test("web shared workspace store preserves scoped list query after create, rename and delete", async () => {
  setActivePinia(createPinia());
  configureAccountSession();
  const store = useSharedWorkspacesStore();
  const requests: Array<{ method: string; pathname: string; search: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    requests.push({ method, pathname: url.pathname, search: url.search });

    if (url.pathname === "/api/account/enterprise/shared-workspaces" && method === "POST") {
      return jsonResponse({
        ok: true,
        sharedWorkspace: {
          id: "sw_created",
          enterpriseId: "enterprise_scope",
          name: "Created workspace",
          description: "",
          createdByUserId: "user_store_scope",
          workspaceAdminUserId: "user_workspace_admin",
          lifecycleStatus: "pending_host",
          hostStatus: "unbound",
          memberCount: 1,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          host: null,
        },
      });
    }

    if (url.pathname === "/api/account/enterprise/shared-workspaces" && method === "GET") {
      return jsonResponse({ ok: true, items: [], total: 0 });
    }

    if (url.pathname === "/api/account/enterprise/shared-workspaces/sw_created" && method === "DELETE") {
      return jsonResponse({ ok: true, message: "共享关系已删除，host 本地资料未删除" });
    }

    if (url.pathname === "/api/account/enterprise/shared-workspaces/sw_created" && method === "PATCH") {
      return jsonResponse({
        ok: true,
        sharedWorkspace: {
          id: "sw_created",
          enterpriseId: "enterprise_scope",
          name: "Renamed workspace",
        },
      });
    }

    throw new Error(`unexpected request: ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  const query = { enterpriseId: "enterprise_scope", hostStatus: "online" };
  const createResult = await store.create({
    enterpriseId: "enterprise_scope",
    name: "Created workspace",
    workspaceAdminUserId: "user_workspace_admin",
  }, query);
  assert.equal(createResult.ok, true);

  const updateResult = await store.updateWorkspace("sw_created", { name: "Renamed workspace" }, query);
  assert.equal(updateResult.ok, true);

  const deleteResult = await store.deleteWorkspace("sw_created", query);
  assert.equal(deleteResult.ok, true);

  const listRequests = requests.filter((request) =>
    request.method === "GET" && request.pathname === "/api/account/enterprise/shared-workspaces"
  );
  assert.equal(listRequests.length, 3);
  for (const request of listRequests) {
    const params = new URLSearchParams(request.search);
    assert.equal(params.get("enterpriseId"), "enterprise_scope");
    assert.equal(params.get("hostStatus"), "online");
  }

  const updateRequest = requests.find((request) => request.method === "PATCH");
  assert.ok(updateRequest);
  const updateParams = new URLSearchParams(updateRequest.search);
  assert.equal(updateParams.get("enterpriseId"), "enterprise_scope");
  assert.equal(updateParams.get("hostStatus"), "online");

  const deleteRequest = requests.find((request) => request.method === "DELETE");
  assert.ok(deleteRequest);
  const deleteParams = new URLSearchParams(deleteRequest.search);
  assert.equal(deleteParams.get("enterpriseId"), "enterprise_scope");
  assert.equal(deleteParams.get("hostStatus"), "online");
});

test("web shared workspace store refreshes policy details after asset policy topic event", async () => {
  setActivePinia(createPinia());
  configureAccountSession();
  const store = useSharedWorkspacesStore();
  const workspaceId = "sw_asset_policy_event";
  const requests: string[] = [];

  store.items = [{
    id: workspaceId,
    enterpriseId: "enterprise_scope",
    name: "Asset policy event",
    description: "",
    createdByUserId: "user_creator",
    workspaceAdminUserId: "user_admin",
    lifecycleStatus: "active",
    hostStatus: "online",
    memberCount: 2,
    createdAt: 1,
    updatedAt: 1,
    currentUserRole: "workspace_admin",
    host: null,
    assetMaintenancePolicy: {
      mode: "selected_members",
      authorizedMemberUserIds: [],
      memberAssetMaintenanceEnabled: false,
    },
  }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === `/api/account/enterprise/shared-workspaces/${workspaceId}/asset-maintenance-policy`) {
      return jsonResponse({
        ok: true,
        sharedWorkspaceId: workspaceId,
        enterpriseId: "enterprise_scope",
        policy: {
          mode: "selected_members",
          authorizedMemberUserIds: ["user_member"],
          memberAssetMaintenanceEnabled: false,
        },
        authorizedMembers: [{
          userId: "user_member",
          displayName: "Member",
          email: "member@test.local",
          role: "member",
          status: "active",
          effective: true,
          disabledReason: null,
        }],
      });
    }
    if (url.pathname === "/api/account/enterprise/shared-workspaces") {
      return jsonResponse({
        ok: true,
        items: store.items,
        total: store.items.length,
      });
    }
    if (url.pathname === "/api/workspaces") {
      return jsonResponse({ ok: true, workspaces: [], total: 0 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadList({ enterpriseId: "enterprise_scope" });

  const event: SharedWorkspaceTopicEvent = {
    type: "sharedWorkspace.assetMaintenancePolicy.changed",
    sharedWorkspaceId: workspaceId,
    enterpriseId: "enterprise_scope",
    seq: 1,
    ts: 2,
    payload: {
      policy: {
        mode: "selected_members",
        authorizedMemberUserIds: ["user_member"],
        memberAssetMaintenanceEnabled: false,
      },
    },
  };
  store.applyTopicEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(store.assetMaintenancePoliciesByWorkspaceId[workspaceId]?.authorizedMemberUserIds, ["user_member"]);
  assert.equal(store.assetMaintenanceAuthorizedMembersByWorkspaceId[workspaceId]?.[0]?.effective, true);
  assert.equal(requests.includes(`/api/account/enterprise/shared-workspaces/${workspaceId}/asset-maintenance-policy`), true);
  assert.equal(requests.includes("/api/workspaces"), true);
});
