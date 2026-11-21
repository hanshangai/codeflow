import test from "node:test";
import assert from "node:assert/strict";

import { message } from "ant-design-vue";
import { createPinia, setActivePinia } from "pinia";

import { resolveWorkspaceClientInfo, resolveWorkspaceClientVersion } from "../src/composables/useAppShell.ts";
import { useConfigStore } from "../src/store/config.ts";
import { usePresenceStore } from "../src/store/presence.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import type { DesktopRuntimeState } from "@codeflowai/shared";
import {
  isWorkspaceClientOfflineError,
  notifyWorkspaceClientOffline,
  resolveWorkspaceRuntimeUnavailableMessage,
} from "../src/utils/clientOfflineNotice.ts";

test("桌面启动等待期间不采用云端离线快照，本机就绪后独立于云端在线", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState() {}, request() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), presence = usePresenceStore();
  config.workspaceId = "local:workspace";
  presence.applyPresenceEvent({ type: "presence.updated", ts: 1,
    payload: { onlineWebCount: 1, clientOnline: false, onlineClients: [] } });
  presence.captureActiveWorkspaceSnapshot(config.workspaceId, 1);
  for (const status of [null, "starting", "running", "ready", "draining"] as const) {
    config.desktopRuntime = status ? { status, requestId: "startup", releaseId: null, errorCode: null } : null;
    assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "unknown" }, `identity pending: ${status}`);
  }
  config.desktopRuntime = { status: "ready", requestId: "startup", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "local", name: "Local", version: "1.0.0", connectedAt: 1, workspaceIds: [config.workspaceId] };
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "online" });
  config.desktopClient = null;
  for (const status of ["failed", "stopped"] satisfies DesktopRuntimeState["status"][]) {
    config.desktopRuntime = { status, requestId: "startup", releaseId: null, errorCode: status === "failed" ? "CLIENT_BOOT_FAILED" : null };
    assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "offline" }, `real unavailable: ${status}`);
  }
});

test("远端工作区所属 Client 在线时，本机运行时未就绪不覆盖为离线", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState() {}, request() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), presence = usePresenceStore(), workspaces = useWorkspacesStore();
  config.workspaceId = "remote-client:repo";
  config.desktopRuntime = { status: "failed", requestId: "local", releaseId: null, errorCode: "CLIENT_BOOT_FAILED" };
  config.desktopClient = null;
  config.desktopClientId = "local-client";
  workspaces.workspaces = [{
    id: "remote-client:repo", title: "Remote Repo", path: "/remote/repo",
    ownerClientId: "remote-client", createdAt: 1, updatedAt: 1,
  }] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [{
        clientId: "remote-client",
        name: "Remote Client",
        version: "1.0.0",
        connectedAt: 1,
        workspaceIds: ["remote-client:repo"],
      }],
    },
  });

  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "online" });
  assert.equal(presence.isCurrentWorkspaceClientOnline, true);
});

test("陈旧的本机 Client presence 不能冒充远端在线", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState() {}, request() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const config = useConfigStore(), presence = usePresenceStore(), workspaces = useWorkspacesStore();
  config.workspaceId = "local-client:repo";
  config.desktopRuntime = { status: "failed", requestId: "local", releaseId: null, errorCode: "CLIENT_BOOT_FAILED" };
  config.desktopClient = null;
  config.desktopClientId = "local-client";
  workspaces.workspaces = [{
    id: "local-client:repo", title: "Local Repo", path: "/local/repo",
    ownerClientId: "local-client", createdAt: 1, updatedAt: 1,
  }] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [{
        clientId: "local-client",
        name: "Local Client",
        version: "1.0.0",
        connectedAt: 1,
        workspaceIds: ["local-client:repo"],
      }],
    },
  });

  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "offline" });
});

test("workspace Client offline errors are recognized and active notices are throttled", () => {
  assert.equal(isWorkspaceClientOfflineError(new Error("CLIENT_OFFLINE: 该工作区对应的 client 未连接")), true);
  assert.equal(isWorkspaceClientOfflineError(new Error("client 未连接")), true);
  assert.equal(isWorkspaceClientOfflineError(new Error("读取文件失败")), false);

  const originalInfo = message.info;
  const notices: unknown[] = [];
  message.info = ((config: unknown) => {
    notices.push(config);
    return (() => undefined) as any;
  }) as typeof message.info;
  try {
    notifyWorkspaceClientOffline("当前工作区 Client 未连接，请启动 Client 后重试。", 10_000);
    notifyWorkspaceClientOffline("当前工作区 Client 未连接，请启动 Client 后重试。", 15_000);
    notifyWorkspaceClientOffline("当前工作区 Client 未连接，请启动 Client 后重试。", 20_000);
    assert.equal(notices.length, 2);
  } finally {
    message.info = originalInfo;
  }
});

test("beginActiveWorkspaceSnapshot resolves immediately when presence state is already known", () => {
  setActivePinia(createPinia());
  const store = usePresenceStore();

  store.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-1",
          name: "Client 1",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["ws-1"],
        },
      ],
    },
  });

  const snapshot = store.beginActiveWorkspaceSnapshot("ws-1", 7);
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.state, "online");
  assert.equal(snapshot.clientId, "client-1");
  assert.equal(snapshot.epoch, 7);
});

test("beginActiveWorkspaceSnapshot stays unresolved before first presence update", () => {
  setActivePinia(createPinia());
  const store = usePresenceStore();

  const snapshot = store.beginActiveWorkspaceSnapshot("ws-1", 8);
  assert.equal(snapshot.resolved, false);
  assert.equal(snapshot.state, "unknown");
  assert.equal(snapshot.epoch, 8);
});

test("beginActiveWorkspaceSnapshot resolves offline immediately when presence is ready but workspace has no client", () => {
  setActivePinia(createPinia());
  const store = usePresenceStore();

  store.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-1",
          name: "Client 1",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["ws-1"],
        },
      ],
    },
  });

  const snapshot = store.beginActiveWorkspaceSnapshot("ws-2", 9);
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.state, "offline");
  assert.equal(snapshot.clientId, null);
  assert.equal(snapshot.epoch, 9);
});

test("empty workspace selection uses account client online state", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();

  config.workspaceId = "";
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "DESKTOP-D6I7DDB",
          name: "DESKTOP-D6I7DDB",
          version: "2026.06.19.03",
          connectedAt: 1,
          workspaceIds: [],
        },
      ],
    },
  });

  assert.equal(presence.isAnyClientOnline, true);
  assert.equal(presence.accountClientState, "online");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "none", status: "ready" });
  assert.equal(presence.activeWorkspaceClientState, "online");
  assert.equal(presence.isCurrentWorkspaceClientOnline, true);
});

test("local workspace can stay online when owner client is online but workspaceIds have not been reported yet", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  config.workspaceId = "ws-1";
  workspaces.workspaces = [
    {
      id: "ws-1",
      title: "Local Workspace",
      path: "/local/ws-1",
      kind: "local",
      ownerClientId: "client-1",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-1",
          name: "Client 1",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: [],
        },
      ],
    },
  });

  assert.equal(presence.clientForWorkspace("ws-1")?.clientId, "client-1");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "local", status: "online" });
  assert.equal(presence.isCurrentWorkspaceClientOnline, true);
});

test("account client stays online while selected shared workspace host is offline", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  config.workspaceId = "shared:sw-offline";
  workspaces.workspaces = [
    {
      id: "shared:sw-offline",
      title: "Shared Offline",
      path: "/shared/offline",
      kind: "shared",
      entryStatus: "host_offline",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "member-client",
          name: "Member Client",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: [],
        },
      ],
    },
  });

  assert.equal(presence.accountClientState, "online");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "offline" });
  assert.equal(presence.activeWorkspaceClientState, "offline");
  assert.equal(presence.isCurrentWorkspaceClientOnline, false);
});

test("shared workspace available resolves active workspace client state as online", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  config.workspaceId = "shared:sw-online";
  workspaces.workspaces = [
    {
      id: "shared:sw-online",
      title: "Shared Online",
      path: "/shared/online",
      kind: "shared",
      entryStatus: "available",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: false,
      onlineClients: [],
    },
  });

  assert.equal(presence.accountClientState, "offline");
  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "online" });
  assert.equal(presence.activeWorkspaceClientState, "online");
  assert.equal(presence.isCurrentWorkspaceClientOnline, true);
});

test("shared workspace host_unbound keeps a distinct runtime status", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  config.workspaceId = "shared:sw-unbound";
  workspaces.workspaces = [
    {
      id: "shared:sw-unbound",
      title: "Shared Unbound",
      path: "/shared/unbound",
      kind: "shared",
      entryStatus: "host_unbound",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: false,
      onlineClients: [],
    },
  });

  assert.deepEqual(presence.activeWorkspaceRuntimeState, { kind: "shared", status: "unbound" });
  assert.equal(presence.activeWorkspaceClientState, "offline");
});

test("workspace runtime unavailable messages never describe shared Host failures as local Client failures", () => {
  const messages = {
    local: "当前工作区 Client 未连接。",
    sharedOffline: "共享工作区 Host 当前离线。",
  };

  assert.equal(
    resolveWorkspaceRuntimeUnavailableMessage({ kind: "local", status: "offline" }, messages),
    messages.local,
  );
  assert.equal(
    resolveWorkspaceRuntimeUnavailableMessage({ kind: "shared", status: "offline" }, messages),
    messages.sharedOffline,
  );
  assert.equal(
    resolveWorkspaceRuntimeUnavailableMessage({ kind: "shared", status: "unbound" }, messages),
    "共享工作区尚未绑定执行主机，请联系工作区管理员处理。",
  );
  assert.equal(
    resolveWorkspaceRuntimeUnavailableMessage({ kind: "shared", status: "unknown" }, messages),
    "正在确认共享工作区 Host 状态，请稍后重试。",
  );
});

test("clientForWorkspace uses owner client instead of suffix alias matches", () => {
  setActivePinia(createPinia());
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  workspaces.workspaces = [
    {
      id: "client-a:root",
      title: "root",
      path: "/root",
      createdAt: 1,
      updatedAt: 1,
      ownerClientId: "client-a",
      ownerClientName: "Client A",
    },
  ] as any;

  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-b",
          name: "Client B",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["client-b:root"],
        },
        {
          clientId: "client-a",
          name: "Client A",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["client-a:root"],
        },
      ],
    },
  });

  const client = presence.clientForWorkspace("client-a:root");
  assert.equal(client?.clientId, "client-a");

  const snapshot = presence.beginActiveWorkspaceSnapshot("client-a:root", 10);
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.state, "online");
  assert.equal(snapshot.clientId, "client-a");
});

test("clientForWorkspace without owner only accepts exact workspace id matches", () => {
  setActivePinia(createPinia());
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  workspaces.workspaces = [
    {
      id: "client-a:root",
      title: "root",
      path: "/root",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;

  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-b",
          name: "Client B",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["client-b:root"],
        },
      ],
    },
  });

  const client = presence.clientForWorkspace("client-a:root");
  assert.equal(client, null);

  const snapshot = presence.beginActiveWorkspaceSnapshot("client-a:root", 11);
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.state, "offline");
  assert.equal(snapshot.clientId, null);
});

test("clientForWorkspace rejects owner client that no longer carries the workspace", () => {
  setActivePinia(createPinia());
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  workspaces.workspaces = [
    {
      id: "client-a:root",
      title: "root",
      path: "/root",
      createdAt: 1,
      updatedAt: 1,
      ownerClientId: "client-a",
      ownerClientName: "Client A",
    },
  ] as any;

  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [
        {
          clientId: "client-a",
          name: "Client A",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["client-a:other"],
        },
        {
          clientId: "client-b",
          name: "Client B",
          version: "1.0.0",
          connectedAt: 1,
          workspaceIds: ["client-b:root"],
        },
      ],
    },
  });

  const client = presence.clientForWorkspace("client-a:root");
  assert.equal(client, null);

  const snapshot = presence.beginActiveWorkspaceSnapshot("client-a:root", 12);
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.state, "offline");
  assert.equal(snapshot.clientId, null);
});

test("升级能力跟随当前工作区 Client，切换到安装版时恢复提醒", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const clients = [
    { clientId: "source", version: "1.0.0", workspaceIds: ["source:root"], capabilities: { selfUpgrade: false } },
    { clientId: "installed", version: "1.0.0", workspaceIds: ["installed:root"], capabilities: { selfUpgrade: true } },
  ];
  for (const client of clients) {
    const selected = resolveWorkspaceClientInfo({ workspaceId: client.workspaceIds[0]!, clients });
    assert.equal(selected, client);
    config.setClientVersionInfo({ clientVersion: selected!.version, latestClientVersion: "2.0.0", selfUpgrade: selected!.capabilities?.selfUpgrade });
    assert.equal(config.clientUpdateAvailable, client.clientId === "installed");
  }
  config.setClientVersionInfo({ clientVersion: "1.0.0", latestClientVersion: "2.0.0" });
  assert.equal(config.clientSelfUpgrade, null);
  assert.equal(config.clientUpdateAvailable, true);
});

test("resolveWorkspaceClientVersion does not fall back to another client when owner is offline", () => {
  const version = resolveWorkspaceClientVersion({
    workspaceId: "client-a:root",
    ownerClientId: "client-a",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "client-b", version: "2.0.0", workspaceIds: ["client-b:root"] },
    ],
  });

  assert.equal(version, null);
});

test("resolveWorkspaceClientVersion matches exact workspace without owner and rejects ambiguous misses", () => {
  const matched = resolveWorkspaceClientVersion({
    workspaceId: "client-a:root",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "client-b", version: "2.0.0", workspaceIds: ["client-b:root"] },
      { clientId: "client-a", version: "1.0.0", workspaceIds: ["client-a:root"] },
    ],
  });
  assert.equal(matched, "1.0.0");

  const unmatched = resolveWorkspaceClientVersion({
    workspaceId: "client-a:root",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "client-b", version: "2.0.0", workspaceIds: ["client-b:root"] },
      { clientId: "client-c", version: "3.0.0", workspaceIds: ["client-c:root"] },
    ],
  });
  assert.equal(unmatched, null);

  const fallbackWithoutWorkspace = resolveWorkspaceClientVersion({
    workspaceId: "",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "client-b", version: "2.0.0", workspaceIds: ["client-b:root"] },
    ],
  });
  assert.equal(fallbackWithoutWorkspace, "9.9.9");
});

test("resolveWorkspaceClientVersion matches shared host client before shared selection id", () => {
  const exactHost = resolveWorkspaceClientVersion({
    workspaceId: "shared:sw-1",
    hostClientId: "client-host",
    hostWorkspaceId: "host-root",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "client-other", version: "3.0.0", workspaceIds: ["client-other:host-root"] },
      { clientId: "client-host", version: "1.2.3", workspaceIds: ["client-host:host-root"] },
    ],
  });
  assert.equal(exactHost, "1.2.3");

  const reconnectedHost = resolveWorkspaceClientVersion({
    workspaceId: "shared:sw-1",
    hostClientId: "old-client-id",
    hostWorkspaceId: "host-root",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "new-client-id", version: "2.0.0", workspaceIds: ["new-client-id:host-root"] },
    ],
  });
  assert.equal(reconnectedHost, "2.0.0");

  const unavailableHost = resolveWorkspaceClientVersion({
    workspaceId: "shared:sw-1",
    hostClientId: "old-client-id",
    hostWorkspaceId: "host-root",
    fallbackClientVersion: "9.9.9",
    clients: [
      { clientId: "member-client", version: "4.0.0", workspaceIds: ["member-client:member-root"] },
    ],
  });
  assert.equal(unavailableHost, null);
});
test("runtimeStateForWorkspace resolves arbitrary local, shared selection and empty workspace scopes", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  workspaces.workspaces = [
    {
      id: "client-local:repo",
      title: "Local Repo",
      path: "/repo",
      ownerClientId: "client-local",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [{
        clientId: "client-local",
        name: "Local Client",
        version: "1.0.0",
        connectedAt: 1,
        workspaceIds: ["client-local:repo"],
      }],
    },
  });

  assert.deepEqual(presence.runtimeStateForWorkspace(null), { kind: "none", status: "ready" });
  assert.deepEqual(presence.runtimeStateForWorkspace("client-local:repo"), { kind: "local", status: "online" });
  assert.deepEqual(presence.runtimeStateForWorkspace("shared:missing"), { kind: "shared", status: "unknown" });

  config.workspaceId = "client-local:repo";
  assert.deepEqual(presence.activeWorkspaceRuntimeState, presence.runtimeStateForWorkspace("client-local:repo"));
});

test("shared Host state never replaces the account-level local Client state", () => {
  setActivePinia(createPinia());
  const presence = usePresenceStore();
  const workspaces = useWorkspacesStore();

  workspaces.workspaces = [
    {
      id: "shared:design",
      title: "Design Space",
      path: "/shared",
      kind: "shared",
      entryStatus: "host_offline",
      shared: { hostStatus: "offline" },
      createdAt: 1,
      updatedAt: 1,
    },
  ] as any;
  presence.applyPresenceEvent({
    type: "presence.updated",
    ts: 1,
    payload: {
      onlineWebCount: 1,
      clientOnline: true,
      onlineClients: [{
        clientId: "my-client",
        name: "My Client",
        version: "1.0.0",
        connectedAt: 1,
        workspaceIds: ["my-client:repo"],
      }],
    },
  });

  assert.deepEqual(presence.runtimeStateForWorkspace("shared:design"), { kind: "shared", status: "offline" });
  assert.equal(presence.accountClientState, "online");
});
