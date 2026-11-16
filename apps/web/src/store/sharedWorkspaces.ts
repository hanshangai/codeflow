import { defineStore } from "pinia";
import type {
  BindSharedWorkspaceHostRequestBody,
  CreateSharedWorkspaceRequestBody,
  InviteSharedWorkspaceMembersRequestBody,
  SharedWorkspaceAssetMaintenanceAuthorizedMember,
  SharedWorkspaceInviteCandidate,
  SharedWorkspaceAssetMaintenancePolicy,
  SharedWorkspaceFileTransfersQuery,
  SharedWorkspaceFileTransferPolicy,
  SharedWorkspaceListItem,
  SharedWorkspaceMemberItem,
  SharedWorkspaceTopicEvent,
  UpdateSharedWorkspaceAssetMaintenancePolicyRequestBody,
  UpdateSharedWorkspaceFileTransferPolicyRequestBody,
  UpdateSharedWorkspaceRequestBody,
  WorkspaceFileTransferEventItem,
} from "@codeflowai/shared";

import { useApiContext } from "../composables/useApiContext";
import { trackProductEvent } from "../analytics/analytics";
import * as api from "../api/sharedWorkspaces";
import { useWorkspacesStore } from "./workspaces";

type SharedWorkspaceListQuery = Record<string, string | number | boolean | undefined | null>;

const pendingMemberLoads = new Map<string, ReturnType<typeof api.listSharedWorkspaceMembers>>();

export const useSharedWorkspacesStore = defineStore("sharedWorkspaces", {
  state: () => ({
    items: [] as SharedWorkspaceListItem[],
    total: 0,
    loading: false,
    saving: false,
    selectedWorkspaceId: null as string | null,
    membersByWorkspaceId: {} as Record<string, SharedWorkspaceMemberItem[]>,
    inviteCandidatesByWorkspaceId: {} as Record<string, { available: SharedWorkspaceInviteCandidate[]; unavailable: SharedWorkspaceInviteCandidate[] }>,
    assetMaintenancePoliciesByWorkspaceId: {} as Record<string, SharedWorkspaceAssetMaintenancePolicy>,
    assetMaintenanceAuthorizedMembersByWorkspaceId: {} as Record<string, SharedWorkspaceAssetMaintenanceAuthorizedMember[]>,
    fileTransferPoliciesByWorkspaceId: {} as Record<string, SharedWorkspaceFileTransferPolicy>,
    fileTransfersByWorkspaceId: {} as Record<string, { items: WorkspaceFileTransferEventItem[]; total: number }>,
    routeEventsByWorkspaceId: {} as Record<string, SharedWorkspaceTopicEvent[]>,
    lastListQuery: null as SharedWorkspaceListQuery | null,
    lastError: null as string | null,
  }),
  getters: {
    selectedWorkspace(state): SharedWorkspaceListItem | null {
      return state.items.find((item) => item.id === state.selectedWorkspaceId) ?? null;
    },
  },
  actions: {
    setSelectedWorkspace(id: string | null) {
      this.selectedWorkspaceId = id;
    },

    /** 加载共享工作区列表，query 由调用方提供以保留超管企业 scope。 */
    async loadList(query?: SharedWorkspaceListQuery) {
      const { ctx } = useApiContext();
      this.lastListQuery = query ? { ...query } : null;
      this.loading = true;
      this.lastError = null;
      try {
        const result = await api.listSharedWorkspaces(ctx.value, query);
        if (result.ok) {
          this.items = result.items;
          this.total = result.total;
          if (!this.selectedWorkspaceId && result.items.length) this.selectedWorkspaceId = result.items[0]!.id;
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.loading = false;
      }
    },

    /** 创建共享工作区，并按当前列表 scope 刷新。 */
    async create(body: CreateSharedWorkspaceRequestBody, reloadQuery?: SharedWorkspaceListQuery) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.createSharedWorkspace(ctx.value, body);
        if (result.ok) {
          this.selectedWorkspaceId = result.sharedWorkspace.id;
          await this.loadList(reloadQuery ?? (body.enterpriseId ? { enterpriseId: body.enterpriseId } : undefined));
          trackProductEvent("shared_workspace_change", { action: "create" });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    /** 删除共享关系，并按当前列表 scope 刷新。 */
    async deleteWorkspace(sharedWorkspaceId: string, reloadQuery?: SharedWorkspaceListQuery) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.deleteSharedWorkspace(ctx.value, sharedWorkspaceId, reloadQuery);
        if (result.ok) {
          if (this.selectedWorkspaceId === sharedWorkspaceId) this.selectedWorkspaceId = null;
          await this.loadList(reloadQuery);
          trackProductEvent("shared_workspace_change", { action: "delete" });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    /** 绑定共享工作区 Host，并在成功后刷新列表。 */
    async bindHost(sharedWorkspaceId: string, body: BindSharedWorkspaceHostRequestBody) {
      const { ctx } = useApiContext();
      const result = await api.bindSharedWorkspaceHost(ctx.value, sharedWorkspaceId, body);
      if (result.ok) {
        await this.loadList();
        trackProductEvent("shared_workspace_change", { action: "bind_host" });
      }
      else this.lastError = result.message;
      return result;
    },

    /** 取消共享工作区 Host 绑定，并刷新列表状态。 */
    async unbindHost(sharedWorkspaceId: string) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.unbindSharedWorkspaceHost(ctx.value, sharedWorkspaceId);
        if (result.ok) {
          await this.loadList();
          trackProductEvent("shared_workspace_change", { action: "unbind_host" });
        }
        else this.lastError = result.message;
        return result;
      } finally {
        this.saving = false;
      }
    },

    async loadMembers(sharedWorkspaceId: string) {
      const normalizedWorkspaceId = String(sharedWorkspaceId ?? "").trim();
      if (!normalizedWorkspaceId) return { ok: false, message: "共享工作区 ID 不能为空" } as const;
      const pending = pendingMemberLoads.get(normalizedWorkspaceId);
      if (pending) return pending;
      const { ctx } = useApiContext();
      const request = api.listSharedWorkspaceMembers(ctx.value, normalizedWorkspaceId)
        .then((result) => {
          if (result.ok) this.membersByWorkspaceId[normalizedWorkspaceId] = result.members;
          else this.lastError = result.message;
          return result;
        })
        .finally(() => {
          if (pendingMemberLoads.get(normalizedWorkspaceId) === request) pendingMemberLoads.delete(normalizedWorkspaceId);
        });
      pendingMemberLoads.set(normalizedWorkspaceId, request);
      return request;
    },

    async loadInviteCandidates(sharedWorkspaceId: string, search?: string) {
      const { ctx } = useApiContext();
      const result = await api.listSharedWorkspaceInviteCandidates(ctx.value, sharedWorkspaceId, { search });
      if (result.ok) {
        this.inviteCandidatesByWorkspaceId[sharedWorkspaceId] = {
          available: result.available,
          unavailable: result.unavailable,
        };
      } else {
        this.lastError = result.message;
      }
      return result;
    },

    /** 邀请共享成员，并同步成员、候选人与列表计数。 */
    async inviteMembers(sharedWorkspaceId: string, body: InviteSharedWorkspaceMembersRequestBody) {
      const { ctx } = useApiContext();
      const result = await api.inviteSharedWorkspaceMembers(ctx.value, sharedWorkspaceId, body);
      if (result.ok) {
        await Promise.all([this.loadMembers(sharedWorkspaceId), this.loadInviteCandidates(sharedWorkspaceId), this.loadList()]);
        trackProductEvent("shared_workspace_member_change", {
          action: "invite",
          member_count: result.invited.length,
        });
      } else {
        this.lastError = result.message;
      }
      return result;
    },

    /** 当前用户退出共享工作区，并刷新可见列表。 */
    async leave(sharedWorkspaceId: string) {
      const { ctx } = useApiContext();
      const result = await api.leaveSharedWorkspace(ctx.value, sharedWorkspaceId);
      if (result.ok) {
        await this.loadList();
        trackProductEvent("shared_workspace_member_change", { action: "leave", member_count: 1 });
      }
      else this.lastError = result.message;
      return result;
    },

    /** 移除共享工作区普通成员，并同步成员、候选人和列表计数。 */
    async removeMember(sharedWorkspaceId: string, memberId: string) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.removeSharedWorkspaceMember(ctx.value, sharedWorkspaceId, memberId);
        if (result.ok) {
          await Promise.all([this.loadMembers(sharedWorkspaceId), this.loadInviteCandidates(sharedWorkspaceId), this.loadList()]);
          trackProductEvent("shared_workspace_member_change", { action: "remove", member_count: 1 });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    async loadFileTransferPolicy(sharedWorkspaceId: string) {
      const { ctx } = useApiContext();
      const result = await api.getSharedWorkspaceFileTransferPolicy(ctx.value, sharedWorkspaceId);
      if (result.ok) this.fileTransferPoliciesByWorkspaceId[sharedWorkspaceId] = result.policy;
      else this.lastError = result.message;
      return result;
    },

    /** 保存共享文件传输策略并回填本地策略缓存。 */
    async updateFileTransferPolicy(sharedWorkspaceId: string, body: UpdateSharedWorkspaceFileTransferPolicyRequestBody) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.updateSharedWorkspaceFileTransferPolicy(ctx.value, sharedWorkspaceId, body);
        if (result.ok) {
          this.fileTransferPoliciesByWorkspaceId[sharedWorkspaceId] = result.policy;
          const item = this.items.find((entry) => entry.id === sharedWorkspaceId);
          if (item) item.fileTransferPolicy = result.policy;
          trackProductEvent("shared_workspace_policy_change", {
            policy: "file_transfer",
            upload_enabled: result.policy.uploadEnabled,
            download_enabled: result.policy.downloadEnabled,
          });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    /** 加载共享工作区资产维护策略，用于后台开关回填。 */
    async loadAssetMaintenancePolicy(sharedWorkspaceId: string) {
      const { ctx } = useApiContext();
      const result = await api.getSharedWorkspaceAssetMaintenancePolicy(ctx.value, sharedWorkspaceId);
      if (result.ok) {
        this.assetMaintenancePoliciesByWorkspaceId[sharedWorkspaceId] = result.policy;
        this.assetMaintenanceAuthorizedMembersByWorkspaceId[sharedWorkspaceId] = result.authorizedMembers;
      }
      else this.lastError = result.message;
      return result;
    },

    /** 修改共享工作区名称，并按当前列表作用域刷新。 */
    async updateWorkspace(sharedWorkspaceId: string, body: UpdateSharedWorkspaceRequestBody, reloadQuery?: SharedWorkspaceListQuery) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.updateSharedWorkspace(ctx.value, sharedWorkspaceId, body, reloadQuery);
        if (result.ok) {
          const updatedWorkspace = result.sharedWorkspace;
          this.items = this.items.map((item) => (
            item.id === sharedWorkspaceId
              ? { ...item, name: updatedWorkspace.name, updatedAt: updatedWorkspace.updatedAt }
              : item
          ));
          useWorkspacesStore().applySharedWorkspaceRename(sharedWorkspaceId, updatedWorkspace.name, updatedWorkspace.updatedAt);
          await this.loadList(reloadQuery);
          trackProductEvent("shared_workspace_change", { action: "rename" });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    /** 保存资产维护策略并回填本地策略缓存。 */
    async updateAssetMaintenancePolicy(sharedWorkspaceId: string, body: UpdateSharedWorkspaceAssetMaintenancePolicyRequestBody) {
      const { ctx } = useApiContext();
      this.saving = true;
      try {
        const result = await api.updateSharedWorkspaceAssetMaintenancePolicy(ctx.value, sharedWorkspaceId, body);
        if (result.ok) {
          this.assetMaintenancePoliciesByWorkspaceId[sharedWorkspaceId] = result.policy;
          this.assetMaintenanceAuthorizedMembersByWorkspaceId[sharedWorkspaceId] = result.authorizedMembers;
          const item = this.items.find((entry) => entry.id === sharedWorkspaceId);
          if (item) item.assetMaintenancePolicy = result.policy;
          trackProductEvent("shared_workspace_policy_change", {
            policy: "asset_maintenance",
            mode: result.policy.mode,
            authorized_member_count: result.policy.authorizedMemberUserIds.length,
          });
        } else {
          this.lastError = result.message;
        }
        return result;
      } finally {
        this.saving = false;
      }
    },

    async loadFileTransfers(sharedWorkspaceId: string, query?: SharedWorkspaceFileTransfersQuery) {
      const { ctx } = useApiContext();
      const result = await api.listSharedWorkspaceFileTransfers(ctx.value, sharedWorkspaceId, query);
      if (result.ok) this.fileTransfersByWorkspaceId[sharedWorkspaceId] = { items: result.items, total: result.total };
      else this.lastError = result.message;
      return result;
    },

    applyTopicEvent(event: SharedWorkspaceTopicEvent) {
      const sharedWorkspaceId = event.sharedWorkspaceId;
      const events = this.routeEventsByWorkspaceId[sharedWorkspaceId] ?? [];
      this.routeEventsByWorkspaceId[sharedWorkspaceId] = [event, ...events].slice(0, 80);
      if (event.type === "sharedWorkspace.host.status.changed") {
        const item = this.items.find((entry) => entry.id === sharedWorkspaceId);
        if (item) {
          item.hostStatus = event.payload.hostStatus;
          item.host = event.payload.host;
        }
        useWorkspacesStore().applySharedWorkspaceHostStatus(
          sharedWorkspaceId,
          event.payload.hostStatus,
          event.payload.host,
        );
      }
      if (event.type === "sharedWorkspace.host.maintenance.changed") {
        const item = this.items.find((entry) => entry.id === sharedWorkspaceId);
        if (item && shouldApplyHostMaintenance(item.hostMaintenance ?? null, event.payload)) {
          item.hostMaintenance = { ...event.payload };
        }
        useWorkspacesStore().applySharedWorkspaceHostMaintenance(sharedWorkspaceId, event.payload);
      }
      if (event.type === "sharedWorkspace.member.changed") {
        void this.loadMembers(sharedWorkspaceId);
      }
      if (event.type === "sharedWorkspace.assetMaintenancePolicy.changed") {
        this.assetMaintenancePoliciesByWorkspaceId[sharedWorkspaceId] = event.payload.policy;
        const item = this.items.find((entry) => entry.id === sharedWorkspaceId);
        if (item) item.assetMaintenancePolicy = event.payload.policy;
        void this.loadAssetMaintenancePolicy(sharedWorkspaceId);
        void this.loadList(this.lastListQuery ?? undefined);
        const { ctx } = useApiContext();
        void useWorkspacesStore().refresh(ctx.value);
      }
    },
  },
});

/** 按 maintenance epoch/version 收敛 Host 维护事件，阻止迟到事件恢复入口。 */
function shouldApplyHostMaintenance(
  current: SharedWorkspaceListItem["hostMaintenance"] | null,
  next: NonNullable<SharedWorkspaceListItem["hostMaintenance"]>,
): boolean {
  if (!current) return true;
  if (current.maintenanceEpoch === next.maintenanceEpoch) {
    return next.maintenanceVersion > current.maintenanceVersion;
  }
  return next.updatedAt >= current.updatedAt;
}
