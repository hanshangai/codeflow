import type {
  AcceptThreadFileChangesRequestBody,
  AcceptThreadFileChangesResponseBody,
  ApiResult,
  ArchiveThreadRequestBody,
  ClearThreadRequestBody,
  CompactThreadRequestBody,
  CompactThreadResponseBody,
  ClearThreadDraftRequestBody,
  ClearThreadDraftResponseBody,
  CreateThreadRequestBody,
  CreateThreadGroupRequestBody,
  CreateThreadGroupResponseBody,
  CreateThreadResponseBody,
  AssignThreadGroupRequestBody,
  AssignThreadGroupResponseBody,
  ClientId,
  GetClientDbCleanupStatusResponseBody,
  DeleteThreadRequestBody,
  DeleteThreadMessageRequestBody,
  DeleteThreadMessageResponseBody,
  DeleteThreadGroupRequestBody,
  DeleteThreadGroupResponseBody,
  GetThreadDraftRequestBody,
  GetThreadDraftResponseBody,
  GetThreadSummaryRequestBody,
  GetThreadSummaryResponseBody,
  GetThreadPrefsRequestBody,
  GetThreadPrefsResponseBody,
  GetLatestThreadPrefsRequestBody,
  GetLatestThreadPrefsResponseBody,
  GetThreadFileChangeDiffRequestBody,
  GetThreadFileChangeDiffResponseBody,
  InterruptTurnRequestBody,
  InterruptTurnResponseBody,
  ListThreadsResponseBody,
  ListThreadGroupsResponseBody,
  ListThreadFileChangesRequestBody,
  ListThreadFileChangesResponseBody,
  ListThreadInputActionsRequestBody,
  ListThreadInputActionsResponseBody,
  ListThreadEventsRequestBody,
  ListThreadEventsResponseBody,
  ListThreadsRequestQuery,
  LoadThreadRequestBody,
  LoadThreadResponseBody,
  ReadThreadPresentationRequestBody,
  ReadThreadPresentationResponseBody,
  LoadThreadProcessRequestBody,
  LoadThreadProcessResponseBody,
  ManagedServiceSnapshot,
  PreviewRollbackRequestBody,
  PreviewRollbackResponseBody,
  PinThreadRequestBody,
  PinThreadResponseBody,
  RenameThreadGroupRequestBody,
  RenameThreadGroupResponseBody,
  RenameThreadRequestBody,
  RestartCodexAppServerRequestBody,
  RestartCodexAppServerResponseBody,
  RollbackThreadRequestBody,
  RollbackThreadResponseBody,
  SendMessageRequestBody,
  SendMessageResponseBody,
  SaveThreadDraftRequestBody,
  SaveThreadDraftResponseBody,
  StartClientDbCleanupRequestBody,
  StartClientDbCleanupResponseBody,
  UndoThreadFileChangesRequestBody,
  UndoThreadFileChangesResponseBody,
  UpdateThreadPrefsRequestBody,
  UpdateThreadPrefsResponseBody,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { requestJson } from "../request";

/** 删除单条聊天记录；引擎上下文与当前执行保持独立。 */
export function deleteThreadMessage(ctx: ApiRequestContext, body: DeleteThreadMessageRequestBody): Promise<ApiResult<DeleteThreadMessageResponseBody>> {
  return requestJson<DeleteThreadMessageResponseBody>(ctx, { method: "POST", path: "/api/threads/messages/delete", body });
}

type ListThreadManagedServicesRequestBody = { workspaceId: WorkspaceId; threadId: string };
type ListThreadManagedServicesResponseBody = { items: ManagedServiceSnapshot[] };
type StopThreadManagedServiceRequestBody = { workspaceId: WorkspaceId; threadId: string; serviceId: string };
type RequestOptions = { signal?: AbortSignal };

/** 创建 thread（创建后 engine 不可切换）。 */
export function createThread(ctx: ApiRequestContext, body: CreateThreadRequestBody): Promise<ApiResult<CreateThreadResponseBody>> {
  return requestJson<CreateThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/create", body });
}

/** 拉取会话摘要列表；search 由服务端按标题过滤，并支持游标分页。 */
export function listThreads(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: Omit<ListThreadsRequestQuery, "workspaceId">,
  requestOpts?: RequestOptions,
): Promise<ApiResult<ListThreadsResponseBody>> {
  let path = `/api/threads?workspaceId=${encodeURIComponent(String(workspaceId))}`;
  const search = String(opts?.search ?? "").trim();
  if (opts?.scope) path += `&scope=${encodeURIComponent(String(opts.scope))}`;
  if (opts?.sort) path += `&sort=${encodeURIComponent(String(opts.sort))}`;
  if (opts?.groupId) path += `&groupId=${encodeURIComponent(String(opts.groupId))}`;
  if (opts?.onlyRelatedToMe != null) path += `&onlyRelatedToMe=${encodeURIComponent(String(Boolean(opts.onlyRelatedToMe)))}`;
  if (search) path += `&search=${encodeURIComponent(search)}`;
  if (opts?.limit != null) path += `&limit=${encodeURIComponent(String(opts.limit))}`;
  if (opts?.cursor) path += `&cursor=${encodeURIComponent(String(opts.cursor))}`;
  return requestJson<ListThreadsResponseBody>(ctx, { method: "GET", path, signal: requestOpts?.signal });
}

/** 拉取当前工作区会话分组；没有工作区时直接返回空分组，不发无归属请求。 */
export function listThreadGroups(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: RequestOptions,
): Promise<ApiResult<ListThreadGroupsResponseBody>> {
  if (!String(workspaceId ?? "").trim()) return Promise.resolve({ ok: true, groups: [] });
  const path = `/api/threads/groups?workspaceId=${encodeURIComponent(String(workspaceId))}`;
  return requestJson<ListThreadGroupsResponseBody>(ctx, { method: "GET", path, signal: opts?.signal });
}

/** 创建会话分组。 */
export function createThreadGroup(ctx: ApiRequestContext, body: CreateThreadGroupRequestBody): Promise<ApiResult<CreateThreadGroupResponseBody>> {
  return requestJson<CreateThreadGroupResponseBody>(ctx, { method: "POST", path: "/api/threads/groups/create", body });
}

/** 重命名会话分组。 */
export function renameThreadGroup(ctx: ApiRequestContext, body: RenameThreadGroupRequestBody): Promise<ApiResult<RenameThreadGroupResponseBody>> {
  return requestJson<RenameThreadGroupResponseBody>(ctx, { method: "POST", path: "/api/threads/groups/rename", body });
}

/** 删除会话分组，并把会话回到未分组。 */
export function deleteThreadGroup(ctx: ApiRequestContext, body: DeleteThreadGroupRequestBody): Promise<ApiResult<DeleteThreadGroupResponseBody>> {
  return requestJson<DeleteThreadGroupResponseBody>(ctx, { method: "POST", path: "/api/threads/groups/delete", body });
}

/** 移动自建会话到指定分组；groupId 为空表示未分组。 */
export function assignThreadGroup(ctx: ApiRequestContext, body: AssignThreadGroupRequestBody): Promise<ApiResult<AssignThreadGroupResponseBody>> {
  return requestJson<AssignThreadGroupResponseBody>(ctx, { method: "POST", path: "/api/threads/group-assign", body });
}

/** 读取单个会话的轻量概况（用于地址栏直达解析）。 */
export function getThreadSummary(
  ctx: ApiRequestContext,
  body: GetThreadSummaryRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<GetThreadSummaryResponseBody>> {
  return requestJson<GetThreadSummaryResponseBody>(ctx, { method: "POST", path: "/api/threads/summary", body, signal: opts?.signal });
}

/** 重命名 thread。 */
export function renameThread(ctx: ApiRequestContext, body: RenameThreadRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/threads/rename", body });
}

/** 归档/取消归档 thread。 */
export function archiveThread(ctx: ApiRequestContext, body: ArchiveThreadRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/threads/archive", body });
}

/** 置顶/取消置顶 thread。 */
export function pinThread(ctx: ApiRequestContext, body: PinThreadRequestBody): Promise<ApiResult<PinThreadResponseBody>> {
  return requestJson<PinThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/pin", body });
}

/** 清空 thread 历史（默认重置 session）。 */
export function clearThread(ctx: ApiRequestContext, body: ClearThreadRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/threads/clear", body });
}

/** 终止旧 Codex app-server；下一次请求沿用原 binding 启动新进程。 */
export function restartCodexAppServer(
  ctx: ApiRequestContext,
  body: RestartCodexAppServerRequestBody,
): Promise<ApiResult<RestartCodexAppServerResponseBody>> {
  return requestJson<RestartCodexAppServerResponseBody>(ctx, { method: "POST", path: "/api/threads/restart-codex-app-server", body, requireWebSession: true });
}

/** 触发 Codex 会话压缩。 */
export function compactThread(
  ctx: ApiRequestContext,
  body: CompactThreadRequestBody,
): Promise<ApiResult<CompactThreadResponseBody>> {
  return requestJson<CompactThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/compact", body, requireWebSession: true });
}

/** 删除 thread（含事件）。 */
export function deleteThread(ctx: ApiRequestContext, body: DeleteThreadRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/threads/delete", body });
}

/** 读取当前普通聊天会话的 Provider 输入动作目录。 */
export function listThreadInputActions(
  ctx: ApiRequestContext,
  body: ListThreadInputActionsRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<ListThreadInputActionsResponseBody>> {
  return requestJson<ListThreadInputActionsResponseBody>(ctx, {
    method: "POST",
    path: "/api/threads/input-actions/list",
    body,
    signal: opts?.signal,
  });
}

/** 读取 Client 数据库历史清理任务及逻辑空间状态。 */
export function getClientDbCleanupStatus(
  ctx: ApiRequestContext,
  clientId: ClientId,
  opts?: RequestOptions,
): Promise<ApiResult<GetClientDbCleanupStatusResponseBody>> {
  const path = `/api/client-db/cleanup?clientId=${encodeURIComponent(String(clientId))}`;
  return requestJson<GetClientDbCleanupStatusResponseBody>(ctx, { method: "GET", path, signal: opts?.signal });
}

/** 按最后活动截止时间发起 Client 数据库后台历史清理。 */
export function startClientDbCleanup(
  ctx: ApiRequestContext,
  body: StartClientDbCleanupRequestBody,
): Promise<ApiResult<StartClientDbCleanupResponseBody>> {
  return requestJson<StartClientDbCleanupResponseBody>(ctx, { method: "POST", path: "/api/client-db/cleanup", body });
}

/** 发送消息。 */
export function sendMessage(
  ctx: ApiRequestContext,
  body: SendMessageRequestBody,
): Promise<ApiResult<SendMessageResponseBody>> {
  return requestJson<SendMessageResponseBody>(ctx, { method: "POST", path: "/api/threads/send", body, requireWebSession: true });
}

/** 中断 turn 并返回中断后的权威 running 状态。 */
export function interruptTurn(ctx: ApiRequestContext, body: InterruptTurnRequestBody): Promise<ApiResult<InterruptTurnResponseBody>> {
  return requestJson<InterruptTurnResponseBody>(ctx, { method: "POST", path: "/api/turns/interrupt", body });
}

/** 加载 thread 历史（从 Client SQLite 读取事件用于回放）。 */
export function loadThread(
  ctx: ApiRequestContext,
  body: LoadThreadRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<LoadThreadResponseBody>> {
  return requestJson<LoadThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/load", body, signal: opts?.signal });
}

/** 只读取正文、过程摘要和必要状态，不读取过程详情。 */
export function getThreadPresentation(
  ctx: ApiRequestContext, body: ReadThreadPresentationRequestBody, opts?: RequestOptions,
): Promise<ApiResult<ReadThreadPresentationResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/threads/presentation", body, signal: opts?.signal });
}

/** 按过程及固定版本分页读取完整条目快照，后续使用 afterSeq 补读。 */
export function getThreadProcess(
  ctx: ApiRequestContext,
  body: LoadThreadProcessRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<LoadThreadProcessResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/threads/process", body, signal: opts?.signal });
}

/** 分页加载 thread 事件（用于调试面板）。 */
export function listThreadEvents(
  ctx: ApiRequestContext,
  body: ListThreadEventsRequestBody,
): Promise<ApiResult<ListThreadEventsResponseBody>> {
  return requestJson<ListThreadEventsResponseBody>(ctx, { method: "POST", path: "/api/threads/events", body });
}

/** 列出 thread 的聚合文件变更。 */
export function listThreadFileChanges(
  ctx: ApiRequestContext,
  body: ListThreadFileChangesRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<ListThreadFileChangesResponseBody>> {
  return requestJson<ListThreadFileChangesResponseBody>(ctx, { method: "POST", path: "/api/threads/file-changes/list", body, signal: opts?.signal });
}

/** 列出 thread 绑定的后台服务。 */
export function listThreadManagedServices(
  ctx: ApiRequestContext,
  body: ListThreadManagedServicesRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<ListThreadManagedServicesResponseBody>> {
  return requestJson<ListThreadManagedServicesResponseBody>(ctx, { method: "POST", path: "/api/threads/managed-services/list", body, signal: opts?.signal });
}

/** 停止 thread 绑定的后台服务。 */
export function stopThreadManagedService(
  ctx: ApiRequestContext,
  body: StopThreadManagedServiceRequestBody,
): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/threads/managed-services/stop", body, requireWebSession: true });
}

/** 获取某文件的快照差异（基线/当前）。 */
export function getThreadFileChangeDiff(
  ctx: ApiRequestContext,
  body: GetThreadFileChangeDiffRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<GetThreadFileChangeDiffResponseBody>> {
  return requestJson<GetThreadFileChangeDiffResponseBody>(ctx, { method: "POST", path: "/api/threads/file-changes/diff", body, signal: opts?.signal });
}

/** 接受 thread 的文件变更（推进 diff 基准，只读元数据操作）。 */
export function acceptThreadFileChanges(
  ctx: ApiRequestContext,
  body: AcceptThreadFileChangesRequestBody,
): Promise<ApiResult<AcceptThreadFileChangesResponseBody>> {
  return requestJson<AcceptThreadFileChangesResponseBody>(ctx, { method: "POST", path: "/api/threads/file-changes/accept", body });
}

/** 撤销 thread 的文件变更（写操作）。 */
export function undoThreadFileChanges(
  ctx: ApiRequestContext,
  body: UndoThreadFileChangesRequestBody,
): Promise<ApiResult<UndoThreadFileChangesResponseBody>> {
  return requestJson<UndoThreadFileChangesResponseBody>(ctx, { method: "POST", path: "/api/threads/file-changes/undo", body, requireWebSession: true });
}

/** 预览回滚：查看受影响文件及冲突状态（只读）。 */
export function previewRollback(
  ctx: ApiRequestContext,
  body: PreviewRollbackRequestBody,
): Promise<ApiResult<PreviewRollbackResponseBody>> {
  return requestJson<PreviewRollbackResponseBody>(ctx, { method: "POST", path: "/api/threads/rollback/preview", body });
}

/** 回滚 thread 到指定 turn（写操作）。 */
export function rollbackThread(
  ctx: ApiRequestContext,
  body: RollbackThreadRequestBody,
): Promise<ApiResult<RollbackThreadResponseBody>> {
  return requestJson<RollbackThreadResponseBody>(ctx, { method: "POST", path: "/api/threads/rollback", body, requireWebSession: true });
}

/** 更新 thread 的会话级偏好（model/effort/accessMode/planMode）。 */
export function updateThreadPrefs(ctx: ApiRequestContext, body: UpdateThreadPrefsRequestBody): Promise<ApiResult<UpdateThreadPrefsResponseBody>> {
  return requestJson<UpdateThreadPrefsResponseBody>(ctx, { method: "POST", path: "/api/threads/update-prefs", body });
}

/** 读取 thread 的共享草稿（文本 + 附件）。 */
export function getThreadDraft(
  ctx: ApiRequestContext,
  body: GetThreadDraftRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<GetThreadDraftResponseBody>> {
  return requestJson<GetThreadDraftResponseBody>(ctx, { method: "POST", path: "/api/threads/draft/get", body, signal: opts?.signal });
}

/** 保存 thread 的共享草稿。 */
export function saveThreadDraft(
  ctx: ApiRequestContext,
  body: SaveThreadDraftRequestBody,
): Promise<ApiResult<SaveThreadDraftResponseBody>> {
  return requestJson<SaveThreadDraftResponseBody>(ctx, { method: "POST", path: "/api/threads/draft/save", body, requireWebSession: true });
}

/** 清空 thread 的共享草稿。 */
export function clearThreadDraft(
  ctx: ApiRequestContext,
  body: ClearThreadDraftRequestBody,
): Promise<ApiResult<ClearThreadDraftResponseBody>> {
  return requestJson<ClearThreadDraftResponseBody>(ctx, { method: "POST", path: "/api/threads/draft/clear", body, requireWebSession: true });
}

/** 读取 thread 的会话级偏好（打开会话时用于刷新 UI 配置）。 */
export function getThreadPrefs(
  ctx: ApiRequestContext,
  body: GetThreadPrefsRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<GetThreadPrefsResponseBody>> {
  return requestJson<GetThreadPrefsResponseBody>(ctx, { method: "POST", path: "/api/threads/prefs", body, signal: opts?.signal });
}

/** 查询同引擎最近会话的偏好配置（用于新建会话时继承）。 */
export function getLatestThreadPrefs(
  ctx: ApiRequestContext,
  body: GetLatestThreadPrefsRequestBody,
  opts?: RequestOptions,
): Promise<ApiResult<GetLatestThreadPrefsResponseBody>> {
  return requestJson<GetLatestThreadPrefsResponseBody>(ctx, { method: "POST", path: "/api/threads/latest-prefs", body, signal: opts?.signal });
}

