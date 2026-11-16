import { computeNextCronTimeMs, isScheduledTaskWorkflowSkipStatus, type ClientScheduledTaskSyncResponseBody,
  type ScheduledTask, type ScheduledTaskScriptPayload, type ScheduledTaskWorkflowPayload, type DesktopAccountScheduledTaskEdit } from "@codeflowai/shared";

type Owner = Pick<ScheduledTask, "ownerUserId" | "clientId" | "deviceId">;

/** 完整同步严格校验后才能作为删除观察；桌面持久化还要求配置版本和设备域。 */
export function validateAccountTaskSnapshot(response: ClientScheduledTaskSyncResponseBody, owner: Owner, desktop = false): Map<string, ScheduledTask> {
  const invalid = (taskId = ""): never => { throw Object.assign(new Error("账号任务完整快照无效"), { code: "SCHEDULED_TASK_SYNC_INVALID", taskId }); };
  if (!response || !Array.isArray(response.tasks) || !time(response.serverNow)) invalid();
  const tasks = new Map<string, ScheduledTask>();
  for (const task of response.tasks) {
    if (!task || typeof task !== "object" || !text(task.id) || tasks.has(task.id) || task.ownerUserId !== owner.ownerUserId
      || task.clientId !== owner.clientId || task.deviceId !== owner.deviceId || !text(task.name) || !text(task.clientNameSnapshot)
      || !(task.description === null || typeof task.description === "string") || !(task.deviceLabelSnapshot === null || typeof task.deviceLabelSnapshot === "string")
      || typeof task.enabled !== "boolean" || !["workflow", "script"].includes(task.taskType) || !text(task.cronExpr) || !text(task.timezone)
      || !["skip_if_running", "queue_one"].includes(task.concurrencyPolicy) || !["skip_missed", "run_once_on_reconnect"].includes(task.missedPolicy)
      || !time(task.timeoutMs) || task.timeoutMs < 1 || task.timeoutMs > 86_400_000 || !time(task.createdAt) || !time(task.updatedAt)
      || ![task.nextRunAt, task.lastRunAt, task.lastSyncAt].every(value => value === null || time(value))
      || !(task.lastStatus === null || ["queued", "running", "success", "failed", "skipped", "timeout"].includes(task.lastStatus))
      || !record(task.payload)) invalid(text(task?.id) ? task.id : "");
    if (desktop && ("source" in task || "workspaceScope" in task || task.deviceKind !== "desktop" || !time(task.configRevision) || task.configRevision < 1
      || task.updatedAt < task.createdAt)) invalid(task.id);
    try { computeNextCronTimeMs(task.cronExpr, Date.now(), task.timezone); }
    catch (cause) { throw Object.assign(new Error("账号任务计划无效", { cause }), { code: "SCHEDULED_TASK_SYNC_INVALID", taskId: task.id }); }
    if (task.taskType === "script") {
      const payload = task.payload as ScheduledTaskScriptPayload;
      if (!["powershell", "cmd", "bash", "sh"].includes(payload.shell) || !text(payload.command)
        || !(payload.contextWorkspaceId == null || text(payload.contextWorkspaceId)) || !(payload.cwdRelative == null || typeof payload.cwdRelative === "string")
        || !(payload.envRefs == null || Array.isArray(payload.envRefs) && payload.envRefs.every(text))) invalid(task.id);
      if (desktop && payload.envRefs?.some(value => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) invalid(task.id);
    } else {
      const payload = task.payload as ScheduledTaskWorkflowPayload;
      if (!text(payload.workflowId) || !text(payload.contextWorkspaceId)) invalid(task.id);
      if (desktop && (!(payload.workflowVersionPolicy == null || payload.workflowVersionPolicy === "latest")
        || !(payload.intake == null || record(payload.intake)) || !(payload.runMode == null || payload.runMode === "normal")
        || !(payload.approvalMode == null || payload.approvalMode === "default")
        || !(payload.interactionMode == null || payload.interactionMode === "guided" || payload.interactionMode === "unattended")
        || !(payload.skipWhenPreviousInstanceStatuses == null || Array.isArray(payload.skipWhenPreviousInstanceStatuses)
          && payload.skipWhenPreviousInstanceStatuses.every(isScheduledTaskWorkflowSkipStatus)))) invalid(task.id);
    }
    tasks.set(task.id, task);
  }
  return tasks;
}

/** SQLite消费者必须有完整水位；缺失、重复或不安全整数均不能补0。 */
export function validateAccountConfigRevisionFloors(response: ClientScheduledTaskSyncResponseBody, tasks: ReadonlyMap<string, ScheduledTask>): Map<string, number> {
  const floors = new Map<string, number>();
  const invalid = (taskId = ""): never => { throw Object.assign(new Error("账号任务配置修订水位无效"), { code: "SCHEDULED_TASK_SYNC_INVALID", taskId }); };
  if (!Array.isArray(response.configRevisionFloors) || response.configRevisionFloors.length !== tasks.size) invalid();
  for (const floor of response.configRevisionFloors!) {
    if (!record(floor) || !text(floor.taskId) || !tasks.has(floor.taskId) || floors.has(floor.taskId) || !time(floor.localRevision)) invalid(text(floor?.taskId) ? floor.taskId : "");
    floors.set(floor.taskId, floor.localRevision);
  }
  return floors;
}

/** 编辑只接受完整业务字段，归属和设备不能通过正文改写。 */
export function applyAccountTaskEdit(task: ScheduledTask, config: DesktopAccountScheduledTaskEdit): ScheduledTask {
  const fields = ["name", "description", "taskType", "cronExpr", "timezone", "enabled", "payload", "concurrencyPolicy", "missedPolicy", "timeoutMs"];
  if (!record(config) || Object.keys(config).length !== fields.length || Object.keys(config).some(key => !fields.includes(key))) {
    throw Object.assign(new Error("账号任务编辑字段无效"), { code: "SCHEDULED_TASK_SYNC_INVALID", taskId: task.id });
  }
  const next = { ...task, ...config };
  validateAccountTaskSnapshot({ tasks: [next], serverNow: 0 }, task, true);
  if ((next.payload.contextWorkspaceId ?? null) !== (task.payload.contextWorkspaceId ?? null)) {
    throw Object.assign(new Error("任务工作区创建后不可更改"), { code: "SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", taskId: task.id });
  }
  return next;
}

/** 保留原文本，拒绝空白及隐式类型转换。 */
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** 时间、版本和水位都限定非负安全整数。 */
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** 配置对象不能是null或数组。 */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
