import type {
  ApiResult,
  DesktopAccountScheduledTaskConfig,
  DesktopAccountScheduledTaskEdit,
  DesktopAccountScheduledTaskListResponseBody,
  DesktopAccountScheduledTaskMutation,
  DesktopAccountScheduledTaskRunsQuery,
  DesktopAccountScheduledTaskRunsResponseBody,
  LocalScheduledTaskConfigResponseBody,
  LocalScheduledTaskCreateRequestBody,
  LocalScheduledTaskDeleteRequestBody,
  LocalScheduledTaskDeleteResponseBody,
  LocalScheduledTaskListQuery,
  LocalScheduledTaskListResponseBody,
  LocalScheduledTaskRunsQuery,
  LocalScheduledTaskRunsResponseBody,
  LocalScheduledTaskSetEnabledRequestBody,
  LocalScheduledTaskUpdateRequestBody,
  ScheduledTaskCreateRequestBody,
  ScheduledTaskCreateResponseBody,
  ScheduledTaskCronPreviewRequestBody,
  ScheduledTaskCronPreviewResponseBody,
  ScheduledTaskDeleteResponseBody,
  ScheduledTaskDeviceAssetsResponseBody,
  ScheduledTaskDevicesResponseBody,
  ScheduledTaskListResponseBody,
  ScheduledTaskRunNowResponseBody,
  ScheduledTaskRunsResponseBody,
  ScheduledTaskUpdateRequestBody,
  ScheduledTaskUpdateResponseBody,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";
import { requestDesktopApi } from "../../services/desktop";

/** 本机列表只经 preload，分页使用 Client 的真实总数。 */
export function listLocalScheduledTasks(body: LocalScheduledTaskListQuery = {}) {
  return requestDesktopApi<LocalScheduledTaskListResponseBody>({ method: "scheduledTasks.local.list", body });
}

/** 新建仅发送可编辑字段，身份与归属由 Host 装配。 */
export function createLocalScheduledTask(body: LocalScheduledTaskCreateRequestBody) {
  return requestDesktopApi<LocalScheduledTaskConfigResponseBody>({ method: "scheduledTasks.local.create", body });
}

/** 按编辑时的修订写入，不自动重试冲突。 */
export function updateLocalScheduledTask(body: LocalScheduledTaskUpdateRequestBody) {
  return requestDesktopApi<LocalScheduledTaskConfigResponseBody>({ method: "scheduledTasks.local.update", body });
}

/** 启停只更新启用位并校验原修订。 */
export function setLocalScheduledTaskEnabled(body: LocalScheduledTaskSetEnabledRequestBody) {
  return requestDesktopApi<LocalScheduledTaskConfigResponseBody>({ method: "scheduledTasks.local.setEnabled", body });
}

/** 删除保留 Client 返回的真实墓碑。 */
export function deleteLocalScheduledTask(body: LocalScheduledTaskDeleteRequestBody) {
  return requestDesktopApi<LocalScheduledTaskDeleteResponseBody>({ method: "scheduledTasks.local.delete", body });
}

/** 手动运行沿用 Client 的调度入口。 */
export function runLocalScheduledTaskNow(taskId: string) {
  return requestDesktopApi<ScheduledTaskRunNowResponseBody>({ method: "scheduledTasks.local.runNow", body: { taskId } });
}

/** 无 taskId 时包含已删除任务的本机历史。 */
export function listLocalScheduledTaskRuns(body: LocalScheduledTaskRunsQuery = {}) {
  return requestDesktopApi<LocalScheduledTaskRunsResponseBody>({ method: "scheduledTasks.local.runs", body });
}

/** 本机 Cron 预览不依赖账号服务。 */
export function previewLocalScheduledTaskCron(body: ScheduledTaskCronPreviewRequestBody) {
  return requestDesktopApi<ScheduledTaskCronPreviewResponseBody>({ method: "scheduledTasks.local.cronPreview", body });
}

/** 当前账号的快照和可信本设备只从 Client 读取，不触发同步。 */
export function listDesktopAccountScheduledTasks() {
  return requestDesktopApi<DesktopAccountScheduledTaskListResponseBody>({ method: "scheduledTasks.account.list", body: {} });
}

/** 明确重新同步沿 Client 原恢复入口，不在 Web 重建配置。 */
export function syncDesktopAccountScheduledTasks() {
  return requestDesktopApi<DesktopAccountScheduledTaskListResponseBody>({ method: "scheduledTasks.account.sync", body: {} });
}

/** 使用观察到的本地修订提交编辑，由 Client 持久化及回写。 */
export function updateDesktopAccountScheduledTask(body: DesktopAccountScheduledTaskMutation & { config: DesktopAccountScheduledTaskEdit }) {
  return requestDesktopApi<{ item: DesktopAccountScheduledTaskConfig }>({ method: "scheduledTasks.account.update", body });
}

/** 删除沿账号修订链处理，保留本地历史。 */
export function deleteDesktopAccountScheduledTask(body: DesktopAccountScheduledTaskMutation) {
  return requestDesktopApi<{ deleted: true }>({ method: "scheduledTasks.account.delete", body });
}

/** 手动运行沿原账号 Scheduler 入口，不转本机任务方法。 */
export function runDesktopAccountScheduledTaskNow(taskId: string) {
  return requestDesktopApi<ScheduledTaskRunNowResponseBody>({ method: "scheduledTasks.account.runNow", body: { taskId } });
}

/** 当前账号的本地历史支持已删除任务，分页由 Client 处理。 */
export function listDesktopAccountScheduledTaskRuns(body: DesktopAccountScheduledTaskRunsQuery = {}) {
  return requestDesktopApi<DesktopAccountScheduledTaskRunsResponseBody>({ method: "scheduledTasks.account.runs", body });
}

/** 读取当前账号可配置定时任务的在线 Client 设备。 */
export function listScheduledTaskDevices(ctx: ApiRequestContext): Promise<ApiResult<ScheduledTaskDevicesResponseBody>> {
  return requestJson(ctx, { method: "GET", path: "/api/account/scheduled-tasks/devices" });
}

/** 读取目标设备上的工作区和工作流配置。 */
export function getScheduledTaskDeviceAssets(
  ctx: ApiRequestContext,
  input: { clientId: string; deviceId: string },
): Promise<ApiResult<ScheduledTaskDeviceAssetsResponseBody>> {
  const query = new URLSearchParams({
    clientId: input.clientId,
    deviceId: input.deviceId,
  });
  return requestJson(ctx, { method: "GET", path: `/api/account/scheduled-tasks/device-assets?${query}` });
}

/** 分页读取定时任务配置；可按设备过滤。 */
export function listScheduledTasks(
  ctx: ApiRequestContext,
  input?: { limit: number; offset: number; clientId?: string; deviceId?: string },
): Promise<ApiResult<ScheduledTaskListResponseBody>> {
  const query = input ? `?${new URLSearchParams({
    limit: String(input.limit), offset: String(input.offset),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
  })}` : "";
  return requestJson(ctx, { method: "GET", path: `/api/account/scheduled-tasks${query}` });
}

/** 创建定时任务。 */
export function createScheduledTask(
  ctx: ApiRequestContext,
  body: ScheduledTaskCreateRequestBody,
): Promise<ApiResult<ScheduledTaskCreateResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/account/scheduled-tasks", body });
}

/** 更新定时任务。 */
export function updateScheduledTask(
  ctx: ApiRequestContext,
  taskId: string,
  body: ScheduledTaskUpdateRequestBody,
): Promise<ApiResult<ScheduledTaskUpdateResponseBody>> {
  return requestJson(ctx, { method: "POST", path: `/api/account/scheduled-tasks/${encodeURIComponent(taskId)}`, body });
}

/** 删除定时任务。 */
export function deleteScheduledTask(
  ctx: ApiRequestContext,
  taskId: string,
): Promise<ApiResult<ScheduledTaskDeleteResponseBody>> {
  return requestJson(ctx, { method: "DELETE", path: `/api/account/scheduled-tasks/${encodeURIComponent(taskId)}` });
}

/** 手动运行定时任务。 */
export function runScheduledTaskNow(
  ctx: ApiRequestContext,
  taskId: string,
): Promise<ApiResult<ScheduledTaskRunNowResponseBody>> {
  return requestJson(ctx, { method: "POST", path: `/api/account/scheduled-tasks/${encodeURIComponent(taskId)}/run` });
}

/** 读取任务运行记录。 */
export function listScheduledTaskRuns(
  ctx: ApiRequestContext,
  taskId: string,
  input?: { limit: number; offset: number },
): Promise<ApiResult<ScheduledTaskRunsResponseBody>> {
  const query = input ? `?${new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) })}` : "";
  return requestJson(ctx, { method: "GET", path: `/api/account/scheduled-tasks/${encodeURIComponent(taskId)}/runs${query}` });
}

/** 预览 cron 后续触发时间。 */
export function previewScheduledTaskCron(
  ctx: ApiRequestContext,
  body: ScheduledTaskCronPreviewRequestBody,
): Promise<ApiResult<ScheduledTaskCronPreviewResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/account/scheduled-tasks/cron-preview", body });
}
