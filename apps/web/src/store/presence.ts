import { defineStore } from "pinia";
import type { OnlineClientInfo, OnlineState, PresenceEvent, WorkspaceId } from "@codeflowai/shared";

import { useConfigStore } from "./config";
import { useWorkspacesStore } from "./workspaces";
import { isSharedWorkspaceSelectionId, workspaceIdsContainMatch } from "../utils/workspaceId";

export type ActiveWorkspaceClientState = "online" | "offline" | "unknown";

export type ActiveWorkspaceRuntimeState =
  | { kind: "none"; status: "ready" }
  | { kind: "local"; status: ActiveWorkspaceClientState }
  | { kind: "shared"; status: "online" | "offline" | "unbound" | "forbidden" | "unknown" };

export type ActiveWorkspacePresenceSnapshot = {
  workspaceId: string;
  clientId: string | null;
  receivedAt: number;
  epoch: number;
  state: ActiveWorkspaceClientState;
  resolved: boolean;
};

export type PresenceState = {
  online: OnlineState;
  /** 是否已收到过至少一次 presence 事件（用于区分"未知"和"离线"）。 */
  ready: boolean;
  activeWorkspaceSnapshot: ActiveWorkspacePresenceSnapshot | null;
};

export type PresenceStore = ReturnType<typeof usePresenceStore>;

/** 解析共享工作区 Host 运行态；本地工作区返回 null。 */
function sharedWorkspaceRuntimeState(workspaceId: string | null | undefined): ActiveWorkspaceRuntimeState | null {
  const normalizedWorkspaceId = String(workspaceId ?? "").trim();
  if (!normalizedWorkspaceId) return null;

  const workspaces = useWorkspacesStore();
  const workspace = workspaces.byId.get(normalizedWorkspaceId as WorkspaceId) ?? null;
  const shared = workspace?.kind === "shared" || Boolean(workspace?.shared);
  if (!shared) return isSharedWorkspaceSelectionId(normalizedWorkspaceId) ? { kind: "shared", status: "unknown" } : null;

  const entryStatus = workspace?.entryStatus;
  if (entryStatus === "available") return { kind: "shared", status: "online" };
  if (entryStatus === "host_offline") return { kind: "shared", status: "offline" };
  if (entryStatus === "host_unbound") return { kind: "shared", status: "unbound" };
  if (entryStatus === "forbidden") return { kind: "shared", status: "forbidden" };

  const hostStatus = workspace?.shared?.hostStatus;
  if (hostStatus === "online") return { kind: "shared", status: "online" };
  if (hostStatus === "offline") return { kind: "shared", status: "offline" };
  if (hostStatus === "unbound") return { kind: "shared", status: "unbound" };
  return { kind: "shared", status: "unknown" };
}

/** 将详细运行态压缩为现有快照和业务可用性使用的三态。 */
function runtimeStateToClientState(runtime: ActiveWorkspaceRuntimeState): ActiveWorkspaceClientState {
  if (runtime.kind === "none") return "unknown";
  if (runtime.status === "online" || runtime.status === "unknown") return runtime.status;
  return "offline";
}

/** 按 workspace owner 精确定位在线 Client；owner 已明确时优先信任 owner 在线态，缺少 owner 时仅接受完全相同的 workspaceId。 */
function localClientForWorkspace(clients: OnlineClientInfo[], workspaceId: string | null | undefined): OnlineClientInfo | null {
  const normalizedWorkspaceId = String(workspaceId ?? "").trim();
  if (!normalizedWorkspaceId) return null;
  const config = useConfigStore();
  if (config.localRuntimeReady && config.desktopClient?.workspaceIds.includes(normalizedWorkspaceId)) return config.desktopClient;

  const workspaces = useWorkspacesStore();
  const workspace = workspaces.byId.get(normalizedWorkspaceId as WorkspaceId) ?? null;
  const ownerClientId = String(workspace?.ownerClientId ?? "").trim();
  if (ownerClientId) {
    const ownerClient = clients.find((item) => item.clientId === ownerClientId) ?? null;
    if (!ownerClient) return null;
    // owner 已在线时，workspaceIds 可能因上报延迟暂时为空；此处先按 owner 在线态兜底，避免误判离线。
    if (!ownerClient.workspaceIds.length) return ownerClient;
    return workspaceIdsContainMatch(ownerClient.workspaceIds, normalizedWorkspaceId) ? ownerClient : null;
  }

  // 旧 Server 未下发 owner 时只做精确匹配，避免不同 Client 的同名尾部 workspace 串台。
  return clients.find((item) => item.workspaceIds.includes(normalizedWorkspaceId)) ?? null;
}

/** 在线态与 Client 运行状态。 */
export const usePresenceStore = defineStore("presence", {
  state: (): PresenceState => ({
    online: { onlineWebCount: 0, clientOnline: false, onlineClients: [] },
    ready: false,
    activeWorkspaceSnapshot: null,
  }),
  getters: {
    /** 管理入口合并实际本机和云端在线 Client，不改写账号 presence。 */
    availableClients: (s): OnlineClientInfo[] => {
      const config = useConfigStore();
      const local = config.localRuntimeReady ? config.desktopClient : null;
      return local ? [local, ...s.online.onlineClients.filter((client) => client.clientId !== local.clientId)] : s.online.onlineClients;
    },
    /** 是否有任何 client 在线。 */
    isAnyClientOnline: (s) => s.online.onlineClients.length > 0,
    /** 账号级 Client 状态，不受当前工作区类型和 Host 状态影响。 */
    accountClientState(): ActiveWorkspaceClientState {
      if (!this.ready) return "unknown";
      return this.isAnyClientOnline ? "online" : "offline";
    },
    /** 按 workspaceId 查找对应的在线 client。 */
    clientForWorkspace() {
      return (workspaceId: string): OnlineClientInfo | null =>
        localClientForWorkspace(this.online.onlineClients, workspaceId);
    },
    /** 本机身份尚在读取时保持未知；失败或停止仍明确暴露不可用。 */
    runtimeStateForWorkspace() {
      return (workspaceId: string | null | undefined): ActiveWorkspaceRuntimeState => {
        const normalizedWorkspaceId = String(workspaceId ?? "").trim();
        const sharedRuntimeState = sharedWorkspaceRuntimeState(normalizedWorkspaceId);
        if (sharedRuntimeState) return sharedRuntimeState;
        if (!normalizedWorkspaceId) return { kind: "none", status: "ready" };
        const config = useConfigStore();
        if (config.isDesktop && !config.localRuntimeReady) {
          // 本机运行时未就绪时，仅采信其他 Client 的在线 presence；陈旧的本机 Client 不能冒充远端在线。
          const localClientId = String(config.desktopClientId ?? "").trim();
          const workspaceClient = this.ready && localClientId ? this.clientForWorkspace(normalizedWorkspaceId) : null;
          if (workspaceClient && workspaceClient.clientId !== localClientId) return { kind: "local", status: "online" };
          const status = config.desktopRuntime?.status;
          return { kind: "local", status: status === "failed" || status === "stopped" ? "offline" : "unknown" };
        }
        if (config.localRuntimeReady && config.desktopClient?.workspaceIds.includes(normalizedWorkspaceId)) {
          return { kind: "local", status: "online" };
        }
        if (this.activeWorkspaceSnapshot?.workspaceId === normalizedWorkspaceId) {
          return {
            kind: "local",
            status: this.activeWorkspaceSnapshot.resolved ? this.activeWorkspaceSnapshot.state : "unknown",
          };
        }
        if (!this.ready) return { kind: "local", status: "unknown" };
        return { kind: "local", status: this.clientForWorkspace(normalizedWorkspaceId) ? "online" : "offline" };
      };
    },
    /** 当前工作区真实运行态：本地看 Client，共享看 Host，无工作区时不制造离线态。 */
    activeWorkspaceRuntimeState(): ActiveWorkspaceRuntimeState {
      const config = useConfigStore();
      return this.runtimeStateForWorkspace(config.workspaceId);
    },
    /** 兼容现有业务可用性判断；无工作区时沿用账号级 Client 状态。 */
    activeWorkspaceClientState(): ActiveWorkspaceClientState {
      const runtime = this.activeWorkspaceRuntimeState;
      if (runtime.kind === "none") return this.accountClientState;
      return runtimeStateToClientState(runtime);
    },
    activeWorkspaceSnapshotReady(): boolean {
      const config = useConfigStore();
      return !!this.activeWorkspaceSnapshot
        && this.activeWorkspaceSnapshot.workspaceId === config.workspaceId
        && this.activeWorkspaceSnapshot.resolved;
    },
    activeWorkspaceSnapshotEpoch(): number | null {
      const config = useConfigStore();
      if (!this.activeWorkspaceSnapshot || this.activeWorkspaceSnapshot.workspaceId !== config.workspaceId) return null;
      return this.activeWorkspaceSnapshot.epoch;
    },
    activeWorkspaceSnapshotFor() {
      return (workspaceId: string, epoch: number): ActiveWorkspacePresenceSnapshot | null => {
        if (!this.activeWorkspaceSnapshot) return null;
        if (this.activeWorkspaceSnapshot.workspaceId !== workspaceId) return null;
        if (this.activeWorkspaceSnapshot.epoch !== epoch) return null;
        if (!this.activeWorkspaceSnapshot.resolved) return null;
        return this.activeWorkspaceSnapshot;
      };
    },
    /** 当前选中 workspace 的 client 是否在线。 */
    isCurrentWorkspaceClientOnline(): boolean {
      return this.activeWorkspaceClientState === "online";
    },
  },
  actions: {
    /** 应用 server 下发的 presence 事件。 */
    applyPresenceEvent(event: PresenceEvent, opts?: { activeWorkspaceId?: string | null; epoch?: number | null }) {
      if (event.type === "presence.updated") {
        this.online = event.payload;
        this.ready = true;
        if (opts?.activeWorkspaceId && opts.epoch != null) {
          this.captureActiveWorkspaceSnapshot(opts.activeWorkspaceId, opts.epoch);
        }
      }
    },

    /**
     * 开始跟踪当前 workspace 的 presence 快照：
     * - 已有可用 online 快照时直接解析，避免 subscribeAck 后再空等下一条 presence
     * - 仅在尚未收到任何 presence.updated 时才进入 unresolved 阶段
     */
    beginActiveWorkspaceSnapshot(workspaceId: string, epoch: number): ActiveWorkspacePresenceSnapshot {
      if (this.ready) {
        return this.captureActiveWorkspaceSnapshot(workspaceId, epoch);
      }
      return this.stageActiveWorkspaceSnapshot(workspaceId, epoch);
    },

    stageActiveWorkspaceSnapshot(workspaceId: string, epoch: number): ActiveWorkspacePresenceSnapshot {
      const snapshot: ActiveWorkspacePresenceSnapshot = {
        workspaceId,
        clientId: null,
        receivedAt: Date.now(),
        epoch,
        state: "unknown",
        resolved: false,
      };
      this.activeWorkspaceSnapshot = snapshot;
      return snapshot;
    },

    captureActiveWorkspaceSnapshot(workspaceId: string, epoch: number): ActiveWorkspacePresenceSnapshot {
      const sharedRuntimeState = sharedWorkspaceRuntimeState(workspaceId);
      const client = sharedRuntimeState ? null : localClientForWorkspace(this.online.onlineClients, workspaceId);
      const snapshot: ActiveWorkspacePresenceSnapshot = {
        workspaceId,
        clientId: client?.clientId ?? null,
        receivedAt: Date.now(),
        epoch,
        state: sharedRuntimeState
          ? runtimeStateToClientState(sharedRuntimeState)
          : (client ? "online" : (this.ready ? "offline" : "unknown")),
        resolved: true,
      };
      this.activeWorkspaceSnapshot = snapshot;
      return snapshot;
    },

    markActiveWorkspaceSnapshotDegraded(workspaceId: string, epoch: number): ActiveWorkspacePresenceSnapshot {
      const sharedRuntimeState = sharedWorkspaceRuntimeState(workspaceId);
      const client = sharedRuntimeState ? null : localClientForWorkspace(this.online.onlineClients, workspaceId);
      const snapshot: ActiveWorkspacePresenceSnapshot = {
        workspaceId,
        clientId: client?.clientId ?? null,
        receivedAt: Date.now(),
        epoch,
        state: sharedRuntimeState
          ? runtimeStateToClientState(sharedRuntimeState)
          : (client ? "online" : (this.ready ? "offline" : "unknown")),
        resolved: true,
      };
      this.activeWorkspaceSnapshot = snapshot;
      return snapshot;
    },
  },
});
