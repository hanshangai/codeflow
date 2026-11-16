import { defineStore } from "pinia";
import type {
  SharedWorkspaceHostBindingPublicView,
  SharedWorkspaceHostStatus,
  PrepareWorkspaceDirectoryMigrationRequest,
  StartWorkspaceDirectoryMigrationRequest,
  UpsertWorkspaceRequestBody,
  WorkspaceDirectoryMigrationChangedEvent,
  WorkspaceDirectoryMigrationHostMaintenance,
  WorkspaceDirectoryMigrationOperation,
  WorkspaceDirectoryMigrationSummary,
  WorkspaceExecutionProfile,
  WorkspaceExecutionProfileStatus,
  WorkspaceId,
  WorkspaceSummary,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../api/request";
import { trackProductEvent } from "../analytics/analytics";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError, throwIfRequestCancelled } from "../api/request";
import {
  cancelWorkspaceDirectoryMigration,
  deleteWorkspace,
  getWorkspaceExecutionProfile,
  getWorkspaceExecutionProfileStatus,
  getWorkspaceDirectoryMigration,
  listWorkspaces,
  prepareWorkspaceDirectoryMigration,
  recoverWorkspaceDirectoryMigration,
  startWorkspaceDirectoryMigration,
  updateWorkspaceExecutionProfile,
  upsertWorkspace,
} from "../api/workspaces";
import { useConfigStore } from "./config";
import { captureAccountSession } from "./account";
import { parseSharedWorkspaceSelectionId, resolveWorkspaceSelectionAfterRefresh, workspaceIdsReferToSameWorkspace } from "../utils/workspaceId";

export type WorkspacesState = {
  workspaces: WorkspaceSummary[];
  loading: boolean;
  lastError: string | null;
  lastLoadedAt: number;
  migrationOperationsByWorkspaceId: Record<string, WorkspaceDirectoryMigrationOperation>;
};

export type WorkspacesStore = ReturnType<typeof useWorkspacesStore>;

/** 构建工作区列表刷新去重范围；包含当前选择以隔离离线占位请求。 */
export function buildWorkspacesRefreshScopeKey(
  ctx: Pick<ApiRequestContext, "serverWsOrigin" | "sessionToken">,
  currentWorkspaceId?: string | null,
): string {
  return [
    "workspaces",
    String(ctx.serverWsOrigin ?? "").trim(),
    String(ctx.sessionToken ?? "").trim(),
    String(currentWorkspaceId ?? "").trim(),
  ].join("::");
}

/** 没有历史选择时按创建时间倒序选择一个真实工作区作为初始入口。 */
export function pickInitialWorkspaceIdByCreatedAt(workspaces: Array<Pick<WorkspaceSummary, "id" | "createdAt">>): string | null {
  return workspaces
    .map((workspace, index) => {
      const createdAt = Number(workspace.createdAt ?? 0);
      return {
        id: String(workspace.id ?? "").trim(),
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        index,
      };
    })
    .filter((workspace) => workspace.id)
    .sort((a, b) => (b.createdAt - a.createdAt) || (a.index - b.index))[0]?.id ?? null;
}

let workspacesRefreshTask: {
  scopeKey: string;
  owner: ReturnType<typeof captureAccountSession>;
  controller: AbortController;
  promise: Promise<void>;
} | null = null;

/** workspace 列表（数据源：Client SQLite，经由 Server 转发）。 */
export const useWorkspacesStore = defineStore("workspaces", {
  state: (): WorkspacesState => ({
    workspaces: [],
    loading: false,
    lastError: null,
    lastLoadedAt: 0,
    migrationOperationsByWorkspaceId: {},
  }),
  getters: {
    byId: (s) => {
      const map = new Map<WorkspaceId, WorkspaceSummary>();
      for (const w of s.workspaces) map.set(w.id, w);
      return map;
    },
    /** 返回当前已加载的迁移详情，列表摘要不足时由弹窗主动查询。 */
    migrationForWorkspace: (s) => (workspaceId: string): WorkspaceDirectoryMigrationOperation | null => {
      const normalizedWorkspaceId = String(workspaceId ?? "").trim();
      if (!normalizedWorkspaceId) return null;
      const direct = s.migrationOperationsByWorkspaceId[normalizedWorkspaceId];
      if (direct) return direct;
      return Object.entries(s.migrationOperationsByWorkspaceId)
        .find(([cachedWorkspaceId]) => workspaceIdsReferToSameWorkspace(cachedWorkspaceId, normalizedWorkspaceId))?.[1] ?? null;
    },
  },
  actions: {
    /** 将共享 Host 实时状态同步到工作区直达入口，避免等待下一次列表刷新。 */
    applySharedWorkspaceHostStatus(
      sharedWorkspaceId: string,
      hostStatus: SharedWorkspaceHostStatus,
      host: SharedWorkspaceHostBindingPublicView | null,
    ): void {
      const normalizedSharedWorkspaceId = String(sharedWorkspaceId ?? "").trim();
      if (!normalizedSharedWorkspaceId) throw new Error("共享 Host 状态事件缺少 sharedWorkspaceId");

      const entryStatus = hostStatus === "online"
        ? "available"
        : hostStatus === "unbound"
          ? "host_unbound"
          : "host_offline";
      const disabledReason = hostStatus === "online"
        ? null
        : hostStatus === "unbound"
          ? "共享工作区尚未绑定 Host，暂不可进入资料区"
          : "执行主机离线，资料暂不可达";

      this.workspaces = this.workspaces.map((workspace) => {
        const directSharedWorkspaceId = String(
          workspace.shared?.sharedWorkspaceId
          ?? parseSharedWorkspaceSelectionId(String(workspace.id))
          ?? "",
        ).trim();
        if (directSharedWorkspaceId !== normalizedSharedWorkspaceId) return workspace;

        const shared = workspace.shared
          ? {
              ...workspace.shared,
              hostStatus,
              ...(workspace.shared.isHostOwner
                ? {
                    hostClientId: host?.hostClientId ?? null,
                    hostLocalWorkspaceId: host?.localWorkspaceId ?? null,
                    hostLabel: host?.localWorkspaceLabel ?? null,
                  }
                : {}),
            }
          : workspace.shared;
        if (workspace.entryStatus === "forbidden") return { ...workspace, shared };
        return { ...workspace, entryStatus, disabledReason, shared };
      });
    },

    /** 将共享工作区名称回写到列表缓存，避免切换入口仍显示旧名称。 */
    applySharedWorkspaceRename(sharedWorkspaceId: string, name: string, updatedAt?: number): void {
      const normalizedSharedWorkspaceId = String(sharedWorkspaceId ?? "").trim();
      if (!normalizedSharedWorkspaceId) throw new Error("共享工作区重命名事件缺少 sharedWorkspaceId");

      const normalizedName = String(name ?? "").trim();
      if (!normalizedName) throw new Error("共享工作区重命名事件缺少名称");

      this.workspaces = this.workspaces.map((workspace) => {
        const sharedWorkspaceMatch = String(workspace.shared?.sharedWorkspaceId ?? "").trim() === normalizedSharedWorkspaceId;
        const hostedSharedMatch = String(workspace.hostedShared?.sharedWorkspaceId ?? "").trim() === normalizedSharedWorkspaceId;
        if (!sharedWorkspaceMatch && !hostedSharedMatch) return workspace;

        const nextWorkspace: WorkspaceSummary = {
          ...workspace,
          ...(sharedWorkspaceMatch ? { updatedAt: updatedAt ?? workspace.updatedAt } : {}),
          shared: sharedWorkspaceMatch && workspace.shared
            ? { ...workspace.shared, displayName: normalizedName }
            : workspace.shared,
          hostedShared: hostedSharedMatch && workspace.hostedShared
            ? { ...workspace.hostedShared, displayName: normalizedName }
            : workspace.hostedShared,
        };
        if (sharedWorkspaceMatch && workspace.shared && !String(workspace.shared.hostLabel ?? "").trim()) {
          nextWorkspace.title = normalizedName;
          nextWorkspace.path = normalizedName;
        }
        return nextWorkspace;
      });
    },

    /** 刷新目录；首次本机启动可独立读取，提交前复核取消和账号归属。 */
    async refresh(
      ctx: ApiRequestContext,
      opts?: { signal?: AbortSignal; scopeKey?: string; silent?: boolean; localOnly?: boolean },
    ): Promise<void> {
      const config = useConfigStore();
      const currentWorkspaceId = String(config.workspaceId ?? "").trim();
      const scopeKey = (opts?.scopeKey ?? buildWorkspacesRefreshScopeKey(ctx, currentWorkspaceId)) + (opts?.localOnly ? ":local" : "");
      // 已有缓存时后台刷新不切换全局 loading，避免每次进入面板都闪一次加载态。
      const silent = Boolean(opts?.silent) && this.lastLoadedAt > 0;
      const owner = captureAccountSession(config, ctx);
      const existing = workspacesRefreshTask;
      if (existing) {
        if (existing.scopeKey === scopeKey && existing.owner.isCurrentResponse()) return existing.promise;
        existing.controller.abort(createCancelledRequestError("scope-change"));
      }

      const controller = new AbortController();
      /** 复用账号修订围栏；即使会话切换后恢复原值，旧请求也不能回填入口或清除新会话。 */
      const assertRefreshOwner = (): void => {
        owner.assertCurrent();
        throwIfRequestCancelled(controller.signal);
      };
      if (opts?.signal?.aborted) {
        controller.abort(opts.signal.reason);
      } else if (opts?.signal) {
        const onAbort = () => controller.abort(opts.signal?.reason);
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      let task!: Promise<void>;
      task = (async () => {
        if (!silent) this.loading = true;
        this.lastError = null;
        try {
          assertRefreshOwner();
          const res = await listWorkspaces(owner.requestContext, {
            signal: controller.signal,
            currentWorkspaceId,
            localOnly: opts?.localOnly,
          });
          throwIfRequestCancelled(controller.signal);
          if (!res.ok) { owner.assertResponseCurrent(); throw createApiResultError(res); }
          assertRefreshOwner();
          this.workspaces = res.workspaces;
          this.lastLoadedAt = Date.now();
          const latestWorkspaceId = String(config.workspaceId ?? "").trim();
          const authoritativeCandidates = Boolean(
            res.workspaceListAuthoritative
            && Number(res.activeClientCount ?? 0) === Number(res.workspaceListSuccessCount ?? 0)
            && Number(res.workspaceListFailureCount ?? 0) === 0,
          );
          const authoritativeEmpty = Boolean(authoritativeCandidates && this.workspaces.length === 0);
          if (!latestWorkspaceId) {
            const initialWorkspaceId = pickInitialWorkspaceIdByCreatedAt(this.workspaces);
            if (initialWorkspaceId) {
              config.switchWorkspace(initialWorkspaceId, { preservePrimaryThreadUrl: true });
            }
            return;
          }
          const resolvedCurrentWorkspaceId = String(res.resolvedCurrentWorkspaceId ?? "").trim();
          if (resolvedCurrentWorkspaceId && resolvedCurrentWorkspaceId !== latestWorkspaceId) {
            config.switchWorkspace(resolvedCurrentWorkspaceId, { preservePrimaryThreadUrl: true });
            return;
          }
          const resolvedWorkspaceId = resolveWorkspaceSelectionAfterRefresh(
            latestWorkspaceId,
            this.workspaces.map((workspace) => String(workspace.id)),
            { authoritativeEmpty, authoritativeCandidates },
          );
          if (!resolvedWorkspaceId && authoritativeEmpty) {
            config.switchWorkspace("", { preservePrimaryThreadUrl: true });
            return;
          }
          if (!resolvedWorkspaceId && authoritativeCandidates) {
            config.switchWorkspace(pickInitialWorkspaceIdByCreatedAt(this.workspaces) ?? "", { preservePrimaryThreadUrl: true });
            return;
          }
          if (resolvedWorkspaceId && resolvedWorkspaceId !== latestWorkspaceId) {
            config.switchWorkspace(resolvedWorkspaceId, { preservePrimaryThreadUrl: true });
            return;
          }
        } catch (error) {
          // 网络失败也可能在切换账号后才结算，先归一为作用域取消。
          if (isCancelledRequestError(error) || !owner.isCurrentResponse()) {
            if (opts?.localOnly) throw isCancelledRequestError(error) ? error : createCancelledRequestError("scope-change");
            return;
          }
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (workspacesRefreshTask?.promise === task) {
            workspacesRefreshTask = null;
            this.loading = false;
          } else if (!workspacesRefreshTask) {
            this.loading = false;
          }
        }
      })();

      workspacesRefreshTask = { scopeKey, owner, controller, promise: task };
      return task;
    },

    /** 创建/更新 workspace。 */
    async upsert(ctx: ApiRequestContext, body: UpsertWorkspaceRequestBody): Promise<WorkspaceSummary> {
      const action = body.workspaceId && this.workspaces.some((workspace) => workspace.id === body.workspaceId) ? "update" : "create";
      const shouldTrackClientBinding = action === "create" && Boolean(body.clientId);
      let bindingFailureTracked = false;
      try {
        const res = await upsertWorkspace(ctx, body);
        if (!res.ok) {
          if (shouldTrackClientBinding) {
            bindingFailureTracked = true;
            trackProductEvent("workspace_client_bind", { status: "failed", source: "workspace_manager", error_code_group: "request_rejected" });
          }
          throw new Error(res.message);
        }
        const idx = this.workspaces.findIndex((w) => w.id === res.workspace.id);
        if (idx >= 0) this.workspaces.splice(idx, 1, res.workspace);
        else this.workspaces.unshift(res.workspace);
        trackProductEvent("workspace_saved", { action, workspace_type: "local" });
        if (shouldTrackClientBinding) {
          trackProductEvent("workspace_client_bind", { status: "success", source: "workspace_manager" });
        }
        return res.workspace;
      } catch (error) {
        if (shouldTrackClientBinding && !bindingFailureTracked && !isCancelledRequestError(error)) {
          trackProductEvent("workspace_client_bind", { status: "failed", source: "workspace_manager", error_code_group: "request_error" });
        }
        throw error;
      }
    },

    /** 移除账号入口；在线 Client 先软删除，离线时由 Server 保留移除事实。 */
    async delete(ctx: ApiRequestContext, workspaceId: WorkspaceId): Promise<void> {
      const clientId = this.byId.get(workspaceId)?.ownerClientId ?? undefined;
      try {
        const res = await deleteWorkspace(ctx, { workspaceId, clientId });
        if (!res.ok) throw createApiResultError(res);
      } catch (error) {
        const details = error && typeof error === "object" ? (error as { details?: Record<string, unknown> }).details : undefined;
        console.error("[WORKSPACE_REMOVE_FAILED]", {
          code: "WORKSPACE_REMOVE_FAILED", requestId: details?.requestId ?? crypto.randomUUID(),
          userId: useConfigStore().userSummary?.userId ?? null, workspaceId, clientId,
          rootCause: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      // 取消移除前发出的旧列表请求，防止迟到响应重新插入已移除入口。
      if (workspacesRefreshTask?.scopeKey === buildWorkspacesRefreshScopeKey(ctx, useConfigStore().workspaceId)) {
        workspacesRefreshTask.controller.abort(createCancelledRequestError("delete"));
      }
      const idx = this.workspaces.findIndex((w) => w.id === workspaceId);
      if (idx >= 0) this.workspaces.splice(idx, 1);
      trackProductEvent("workspace_deleted", { workspace_type: "local" });
    },

    /** 读取当前工作区我的执行 Profile。 */
    async getExecutionProfile(ctx: ApiRequestContext, workspaceId: WorkspaceId): Promise<WorkspaceExecutionProfile> {
      const res = await getWorkspaceExecutionProfile(ctx, workspaceId);
      if (!res.ok) throw new Error(res.message);
      return res.profile;
    },

    /** 保存当前工作区我的执行 Profile。 */
    async updateExecutionProfile(ctx: ApiRequestContext, workspaceId: WorkspaceId, profileText: string): Promise<WorkspaceExecutionProfile> {
      const res = await updateWorkspaceExecutionProfile(ctx, workspaceId, { profileText });
      if (!res.ok) throw new Error(res.message);
      return res.profile;
    },

    /** 查询当前工作区成员 Profile 状态；不返回 Profile 全文。 */
    async getExecutionProfileStatus(ctx: ApiRequestContext, workspaceId: WorkspaceId, userIds?: string[]): Promise<WorkspaceExecutionProfileStatus[]> {
      const res = await getWorkspaceExecutionProfileStatus(ctx, workspaceId, userIds);
      if (!res.ok) throw new Error(res.message);
      return res.statuses;
    },

    /** 执行迁移预检并回填操作详情；失败保留统一 code/details 供 UI 展示。 */
    async prepareDirectoryMigration(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      body: PrepareWorkspaceDirectoryMigrationRequest,
    ): Promise<WorkspaceDirectoryMigrationOperation> {
      const res = await prepareWorkspaceDirectoryMigration(ctx, workspaceId, body);
      if (!res.ok) throw createApiResultError(res);
      this.setMigrationOperation(res.operation);
      return res.operation;
    },

    /** 查询迁移权威详情并同步列表摘要。 */
    async getDirectoryMigration(ctx: ApiRequestContext, workspaceId: WorkspaceId, operationId: string): Promise<WorkspaceDirectoryMigrationOperation> {
      const res = await getWorkspaceDirectoryMigration(ctx, workspaceId, operationId);
      if (!res.ok) throw createApiResultError(res);
      this.setMigrationOperation(res.operation);
      return res.operation;
    },

    /** 请求开始迁移并立即更新当前操作；实际进度通过 WS 事件和查询收敛。 */
    async startDirectoryMigration(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      operationId: string,
      body: StartWorkspaceDirectoryMigrationRequest,
    ): Promise<WorkspaceDirectoryMigrationOperation> {
      const res = await startWorkspaceDirectoryMigration(ctx, workspaceId, operationId, body);
      if (!res.ok) throw createApiResultError(res);
      this.setMigrationOperation(res.operation);
      return res.operation;
    },

    /** 取消可取消阶段并等待 Client 完成安全清理。 */
    async cancelDirectoryMigration(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      operationId: string,
    ): Promise<WorkspaceDirectoryMigrationOperation> {
      const res = await cancelWorkspaceDirectoryMigration(ctx, workspaceId, operationId, { reason: "user_cancelled" });
      if (!res.ok) throw createApiResultError(res);
      this.setMigrationOperation(res.operation);
      return res.operation;
    },

    /** 请求 Client 按持久证据重试 recovery_required 收敛。 */
    async recoverDirectoryMigration(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      operationId: string,
    ): Promise<WorkspaceDirectoryMigrationOperation> {
      const res = await recoverWorkspaceDirectoryMigration(ctx, workspaceId, operationId);
      if (!res.ok) throw createApiResultError(res);
      this.setMigrationOperation(res.operation);
      return res.operation;
    },

    /** 应用 Server 广播的迁移事件；版本跳跃或缺少详情时要求 WS 立即查询权威 operation。 */
    applyDirectoryMigrationChanged(event: WorkspaceDirectoryMigrationChangedEvent): boolean {
      const eventWorkspaceId = String(event.workspaceId ?? "").trim();
      if (!eventWorkspaceId) throw new Error("迁移事件缺少 workspaceId");
      const workspaceIndex = this.workspaces.findIndex((item) => workspaceIdsReferToSameWorkspace(item.id, eventWorkspaceId));
      const workspace = workspaceIndex >= 0 ? this.workspaces[workspaceIndex]! : null;
      let workspaceProjection = workspace;
      const cacheKey = String(workspace?.id ?? eventWorkspaceId);
      const current = this.migrationOperationsByWorkspaceId[cacheKey];
      if (current?.operationId === event.operationId && current.stateVersion > event.stateVersion) return false;
      if (current?.operationId !== event.operationId && current && current.updatedAt > event.updatedAt) return false;
      const sameVersion = current?.operationId === event.operationId && current.stateVersion === event.stateVersion;
      const versionJump = Boolean(
        current?.operationId === event.operationId
        && event.stateVersion > current.stateVersion + 1,
      );

      if (event.workspace && workspaceIndex >= 0 && !sameVersion) {
        workspaceProjection = mergeWorkspaceProjection(workspace, event.workspace);
        this.workspaces.splice(workspaceIndex, 1, workspaceProjection);
      } else if (workspace) {
        workspace.activeDirectoryMigration = isMigrationTerminalState(event.state)
          ? null
          : toMigrationSummary(event, current ?? null);
      }
      if (!current || current.operationId !== event.operationId) return true;
      this.migrationOperationsByWorkspaceId[cacheKey] = {
        ...mergeMigrationOperationFromEvent(current, event, { preserveState: sameVersion }),
      };
      if (workspaceProjection) {
        const effectiveState = sameVersion ? current.state : event.state;
        workspaceProjection.activeDirectoryMigration = isMigrationTerminalState(effectiveState)
          ? null
          : toMigrationSummary(
            sameVersion ? { ...event, state: current.state, phase: current.phase, stateVersion: current.stateVersion } : event,
            current,
          );
      }
      return versionJump;
    },

    /** 应用共享 Host 维护事件，不修改 Host 在线状态，只控制迁移期入口。 */
    applySharedWorkspaceHostMaintenance(
      sharedWorkspaceId: string,
      maintenance: WorkspaceDirectoryMigrationHostMaintenance,
    ): void {
      const normalizedId = String(sharedWorkspaceId ?? "").trim();
      if (!normalizedId) throw new Error("共享 Host 维护事件缺少 sharedWorkspaceId");
      this.workspaces = this.workspaces.map((workspace) => {
        const directId = String(workspace.shared?.sharedWorkspaceId ?? "").trim();
        const hostedId = String(workspace.hostedShared?.sharedWorkspaceId ?? "").trim();
        if (directId !== normalizedId && hostedId !== normalizedId) return workspace;
        const currentMaintenance = workspace.hostMaintenance
          ?? workspace.shared?.hostMaintenance
          ?? workspace.hostedShared?.hostMaintenance
          ?? null;
        if (!shouldApplyHostMaintenance(currentMaintenance, maintenance)) return workspace;
        return {
          ...workspace,
          hostMaintenance: { ...maintenance },
          shared: workspace.shared ? { ...workspace.shared, hostMaintenance: { ...maintenance } } : workspace.shared,
          hostedShared: workspace.hostedShared
            ? { ...workspace.hostedShared, hostMaintenance: { ...maintenance } }
            : workspace.hostedShared,
        };
      });
    },

    /** 将完整操作写入详情缓存，并把列表摘要保持为同一版本。 */
    setMigrationOperation(operation: WorkspaceDirectoryMigrationOperation): void {
      const operationWorkspaceId = String(operation.workspaceId ?? "").trim();
      if (!operationWorkspaceId) throw new Error("迁移操作缺少 workspaceId");
      const workspace = this.workspaces.find((item) => workspaceIdsReferToSameWorkspace(item.id, operationWorkspaceId));
      const cacheKey = String(workspace?.id ?? operationWorkspaceId);
      const current = this.migrationOperationsByWorkspaceId[cacheKey];
      if (current?.operationId === operation.operationId && current.stateVersion > operation.stateVersion) return;
      if (current?.operationId !== operation.operationId && current && current.updatedAt > operation.updatedAt) return;
      const storedOperation = current?.operationId === operation.operationId
        && current.stateVersion === operation.stateVersion
        ? mergeMigrationOperationSameVersion(current, operation)
        : operation;
      this.migrationOperationsByWorkspaceId[cacheKey] = storedOperation;
      if (!workspace) return;
      workspace.activeDirectoryMigration = isMigrationTerminalState(storedOperation.state)
        ? null
        : toMigrationSummary(storedOperation, null);
      workspace.directoryMigrationIndexState = {
        operationId: storedOperation.operationId,
        stateVersion: storedOperation.stateVersion,
        indexRebuildGeneration: storedOperation.indexRebuildGeneration,
        indexRebuildStatus: storedOperation.indexRebuildStatus,
        warningCode: storedOperation.warningCode,
        updatedAt: storedOperation.updatedAt,
      };
    },
  },
});

/** 判断迁移终态，终态不再占用工作区列表的 active 摘要。 */
function isMigrationTerminalState(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

/** 将事件或操作压缩为工作区列表使用的迁移摘要。 */
function toMigrationSummary(
  input: WorkspaceDirectoryMigrationChangedEvent | WorkspaceDirectoryMigrationOperation,
  previous: WorkspaceDirectoryMigrationOperation | null,
): WorkspaceDirectoryMigrationSummary {
  const hasStartFields = "startAttemptId" in input;
  return {
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    state: input.state,
    stateVersion: input.stateVersion,
    phase: input.phase,
    progressPct: input.progressPct,
    startAttemptId: hasStartFields ? input.startAttemptId : previous?.startAttemptId ?? null,
    startDisposition: hasStartFields ? input.startDisposition : previous?.startDisposition ?? null,
    updatedAt: input.updatedAt,
  };
}

/** 合并 Client workspace 事实字段，保留 Server 的入口、Owner、能力和维护投影。 */
function mergeWorkspaceProjection(
  current: WorkspaceSummary | null,
  incoming: WorkspaceSummary,
): WorkspaceSummary {
  if (!current) return incoming;
  return {
    ...current,
    ...incoming,
    kind: incoming.kind ?? current.kind,
    entryStatus: incoming.entryStatus ?? current.entryStatus,
    disabledReason: incoming.disabledReason ?? current.disabledReason,
    ownerClientId: incoming.ownerClientId ?? current.ownerClientId,
    ownerClientName: incoming.ownerClientName ?? current.ownerClientName,
    shared: incoming.shared ?? current.shared,
    hostedShared: incoming.hostedShared ?? current.hostedShared,
    hostedSharedCount: incoming.hostedSharedCount ?? current.hostedSharedCount,
    hostMaintenance: incoming.hostMaintenance ?? current.hostMaintenance,
    activeDirectoryMigration: incoming.activeDirectoryMigration ?? current.activeDirectoryMigration,
    directoryMigrationIndexState: incoming.directoryMigrationIndexState ?? current.directoryMigrationIndexState,
    capabilities: incoming.capabilities ?? current.capabilities,
    fileTransferPolicy: incoming.fileTransferPolicy ?? current.fileTransferPolicy,
    assetMaintenancePolicy: incoming.assetMaintenancePolicy ?? current.assetMaintenancePolicy,
  };
}

/** 同版本只刷新纯投影字段，禁止事件改变已提交的状态和阶段。 */
function mergeMigrationOperationFromEvent(
  current: WorkspaceDirectoryMigrationOperation,
  event: WorkspaceDirectoryMigrationChangedEvent,
  options: { preserveState: boolean },
): WorkspaceDirectoryMigrationOperation {
  return {
    ...current,
    ...(options.preserveState ? {} : {
      state: event.state,
      phase: event.phase,
      stateVersion: event.stateVersion,
    }),
    progressPct: event.progressPct,
    copiedBytes: event.copiedBytes,
    sourceTotalBytes: event.totalBytes,
    updatedAt: event.updatedAt,
    errorCode: event.errorCode ?? current.errorCode,
    errorMessage: event.errorMessage ?? current.errorMessage,
    warningCode: event.warningCode ?? current.warningCode,
    warningDetails: event.warningDetails ?? current.warningDetails,
  };
}

/** 同版本详情只更新可投影字段，保留当前状态机状态。 */
function mergeMigrationOperationSameVersion(
  current: WorkspaceDirectoryMigrationOperation,
  incoming: WorkspaceDirectoryMigrationOperation,
): WorkspaceDirectoryMigrationOperation {
  return {
    ...current,
    progressPct: incoming.progressPct,
    copiedBytes: incoming.copiedBytes,
    sourceTotalBytes: incoming.sourceTotalBytes,
    updatedAt: incoming.updatedAt,
    errorCode: incoming.errorCode ?? current.errorCode,
    errorMessage: incoming.errorMessage ?? current.errorMessage,
    warningCode: incoming.warningCode ?? current.warningCode,
    warningDetails: incoming.warningDetails ?? current.warningDetails,
    indexRebuildGeneration: incoming.indexRebuildGeneration ?? current.indexRebuildGeneration,
    indexRebuildStatus: incoming.indexRebuildStatus ?? current.indexRebuildStatus,
    canStart: incoming.canStart,
    canCancel: incoming.canCancel,
    blockers: incoming.blockers,
    sharedBlockers: incoming.sharedBlockers,
  };
}

/** 按 maintenance epoch/version 收敛 Host 维护事件，阻止迟到事件恢复入口。 */
function shouldApplyHostMaintenance(
  current: WorkspaceDirectoryMigrationHostMaintenance | null,
  next: WorkspaceDirectoryMigrationHostMaintenance,
): boolean {
  if (!current) return true;
  if (current.maintenanceEpoch === next.maintenanceEpoch) {
    return next.maintenanceVersion > current.maintenanceVersion;
  }
  return next.updatedAt >= current.updatedAt;
}

