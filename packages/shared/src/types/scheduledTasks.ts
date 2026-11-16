import type { OrchestrationId, WorkflowId, WorkspaceId } from "./ids";
import type { NodeExecutionProfileScope, OrchestrationInteractionMode, OrchestrationStatus } from "./orchestration";

export type ScheduledTaskType = "workflow" | "script";
/** 设备登记域由Server固定，缺省沿普通Client合同，不是用户可选项。 */
export type ScheduledTaskDeviceKind = "client" | "desktop";
export type ScheduledTaskConcurrencyPolicy = "skip_if_running" | "queue_one";
export type ScheduledTaskMissedPolicy = "skip_missed" | "run_once_on_reconnect";
export type ScheduledTaskRunStatus = "queued" | "running" | "success" | "failed" | "skipped" | "timeout";
export type ScheduledTaskTriggerSource = "schedule" | "manual";
export type ScheduledTaskWorkflowVersionPolicy = "latest";
export type ScheduledTaskScriptShell = "powershell" | "cmd" | "bash" | "sh";

export const SCHEDULED_TASK_WORKFLOW_STATUSES = [
  "pending",
  "running",
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly OrchestrationStatus[];

export const SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES = [
  "pending",
  "running",
  "paused",
  "waiting-start",
  "waiting-approval",
  "waiting-feedback",
] as const satisfies readonly OrchestrationStatus[];

export const SCHEDULED_TASK_WORKFLOW_STRICT_SKIP_STATUSES = [
  ...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES,
  "failed",
  "cancelled",
] as const satisfies readonly OrchestrationStatus[];

export type ScheduledTaskWorkflowPayload = {
  workflowId: WorkflowId;
  contextWorkspaceId: WorkspaceId;
  workflowVersionPolicy?: ScheduledTaskWorkflowVersionPolicy | null;
  intake?: Record<string, unknown> | null;
  runMode?: "normal" | null;
  approvalMode?: "default" | null;
  /** 工作流实例级交互策略；缺省 guided 保留节点自身人工门禁。 */
  interactionMode?: OrchestrationInteractionMode | null;
  skipWhenPreviousInstanceStatuses?: OrchestrationStatus[] | null;
};

export type ScheduledTaskScriptPayload = {
  shell: ScheduledTaskScriptShell;
  command: string;
  contextWorkspaceId?: WorkspaceId | null;
  cwdRelative?: string | null;
  envRefs?: string[] | null;
};

export type ScheduledTaskPayload =
  | ScheduledTaskWorkflowPayload
  | ScheduledTaskScriptPayload;

export type ScheduledTask = {
  id: string;
  ownerUserId: string;
  clientId: string;
  deviceId: string;
  deviceKind?: ScheduledTaskDeviceKind;
  /** 账号配置版本，独立于本机revision和运行事实；普通旧Client可缺省。 */
  configRevision?: number;
  clientNameSnapshot: string;
  deviceLabelSnapshot: string | null;
  name: string;
  description: string | null;
  taskType: ScheduledTaskType;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  payload: ScheduledTaskPayload;
  concurrencyPolicy: ScheduledTaskConcurrencyPolicy;
  missedPolicy: ScheduledTaskMissedPolicy;
  timeoutMs: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledTaskRunStatus | null;
  lastSyncAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** 本机配置复用任务参数，不含账号归属、云端同步或运行态字段。 */
export type LocalScheduledTaskConfigInput = Pick<ScheduledTask,
  | "id" | "clientId" | "deviceId" | "name" | "description" | "taskType"
  | "cronExpr" | "timezone" | "enabled" | "payload" | "concurrencyPolicy" | "missedPolicy" | "timeoutMs"
> & {
  source: "local";
  workspaceScope: (Pick<NodeExecutionProfileScope, "scopeId"> & { scopeType: "local_workspace" }) | null;
};

/** 修订号约束配置写入；删除保留配置证据，不能恢复为可调度记录。 */
export type LocalScheduledTaskConfig = LocalScheduledTaskConfigInput & {
  revision: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** Renderer 只提供可编辑配置，来源、设备、ID 与工作区归属由 Host 装配。 */
export type LocalScheduledTaskCreateRequestBody = Omit<LocalScheduledTaskConfigInput, "id" | "clientId" | "deviceId" | "source" | "workspaceScope">;
export type LocalScheduledTaskUpdateRequestBody = LocalScheduledTaskCreateRequestBody & { taskId: string; expectedRevision: number };
export type LocalScheduledTaskSetEnabledRequestBody = { taskId: string; expectedRevision: number; enabled: boolean };
export type LocalScheduledTaskDeleteRequestBody = { taskId: string; expectedRevision: number };
export type LocalScheduledTaskListQuery = { taskType?: ScheduledTaskType; enabled?: boolean; offset?: number; limit?: number };
export type LocalScheduledTaskRunsQuery = { taskId?: string; offset?: number; limit?: number };
export type LocalScheduledTaskConfigResponseBody = { task: LocalScheduledTaskConfig };
export type LocalScheduledTaskListResponseBody = { items: LocalScheduledTaskConfig[]; total: number };
export type LocalScheduledTaskDeleteResponseBody = { deleted: true; task: LocalScheduledTaskConfig };
export type LocalScheduledTaskRunsResponseBody = { items: LocalScheduledTaskRun[]; total: number };

export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  clientId: string;
  deviceId: string;
  deviceKind?: ScheduledTaskDeviceKind;
  workspaceId: WorkspaceId | null;
  workflowInstanceId: OrchestrationId | null;
  workflowNameSnapshot: string | null;
  workflowVersion: number | null;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: ScheduledTaskRunStatus;
  triggerSource: ScheduledTaskTriggerSource;
  attempt: number;
  durationMs: number | null;
  summary: string | null;
  errorMessage: string | null;
  outputExcerpt: string | null;
  createdAt: number;
};

/** 本机运行沿用原结果字段，仅固定创建时的配置修订和名称，不复制 payload。 */
export type LocalScheduledTaskRun = ScheduledTaskRun & {
  source: "local";
  configRevision: number;
  taskNameSnapshot: string;
};

export type ScheduledTaskDeviceOption = {
  clientId: string;
  deviceId: string;
  clientName: string;
  deviceLabel: string | null;
  platform: string | null;
  arch: string | null;
  version: string | null;
  connectedAt: number;
  workspaceIds: WorkspaceId[];
};

export type ScheduledTaskWorkspaceOption = {
  workspaceId: WorkspaceId;
  title: string;
  path: string;
};

export type ScheduledTaskWorkflowOption = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  workflowName: string;
  workflowVersion: number;
};

export type ScheduledTaskDeviceAssets = {
  device: ScheduledTaskDeviceOption;
  workspaces: ScheduledTaskWorkspaceOption[];
  workflows: ScheduledTaskWorkflowOption[];
};

export type ScheduledTaskListQuery = {
  clientId?: string | null;
  deviceId?: string | null;
  taskType?: ScheduledTaskType | null;
  enabled?: boolean | null;
  offset?: number | null;
  limit?: number | null;
};

export type ScheduledTaskUpsertInput = {
  clientId: string;
  deviceId: string;
  name: string;
  description?: string | null;
  taskType: ScheduledTaskType;
  cronExpr: string;
  timezone?: string | null;
  enabled?: boolean | null;
  payload: ScheduledTaskPayload;
  concurrencyPolicy?: ScheduledTaskConcurrencyPolicy | null;
  missedPolicy?: ScheduledTaskMissedPolicy | null;
  timeoutMs?: number | null;
};

export type ScheduledTaskListResponseBody = {
  items: ScheduledTask[];
  total: number;
};

export type ScheduledTaskDevicesResponseBody = {
  devices: ScheduledTaskDeviceOption[];
};

export type ScheduledTaskDeviceAssetsResponseBody = ScheduledTaskDeviceAssets;
export type ScheduledTaskCreateRequestBody = ScheduledTaskUpsertInput;
export type ScheduledTaskCreateResponseBody = { task: ScheduledTask };
export type ScheduledTaskUpdateRequestBody = ScheduledTaskUpsertInput & { expectedConfigRevision?: number };
export type ScheduledTaskUpdateResponseBody = { task: ScheduledTask };
export type ScheduledTaskDeleteResponseBody = { deleted: boolean };
export type ScheduledTaskRunNowResponseBody = { run: ScheduledTaskRun };
export type ScheduledTaskRunsResponseBody = { items: ScheduledTaskRun[]; total: number };

export type ScheduledTaskCronPreviewRequestBody = {
  cronExpr: string;
  timezone?: string | null;
  count?: number | null;
  afterMs?: number | null;
};

export type ScheduledTaskCronPreviewResponseBody = {
  valid: boolean;
  message: string | null;
  nextRunAts: number[];
};

export type ClientScheduledTaskSyncRequestBody = {
  clientId: string;
  deviceId: string;
};

/** 同一账号/设备/任务已占用的本地配置修订，新修订必须大于此值。 */
export type ClientScheduledTaskConfigRevisionFloor = { taskId: string; localRevision: number };

export type ClientScheduledTaskSyncResponseBody = {
  tasks: ScheduledTask[];
  serverNow: number;
  /** 仅桌面账号同步提供，含停用任务；无回执为0，不替代配置CAS版本。 */
  configRevisionFloors?: ClientScheduledTaskConfigRevisionFloor[];
};

/** 原账号既有任务的本地修订；设备和owner只由可信连接确定，不允许新增或改绑。 */
export type ClientScheduledTaskConfigWritebackRequestBody = {
  clientId: string;
  deviceId: string;
  taskId: string;
  localRevision: number;
  expectedConfigRevision: number;
  operation: "update" | "delete";
  config?: Omit<ScheduledTaskUpsertInput, "clientId" | "deviceId">;
};

/** 精确绑定本地修订与基线，删除ACK不携带已删除配置正文。 */
export type ClientScheduledTaskConfigWritebackResponseBody = {
  taskId: string;
  localRevision: number;
  expectedConfigRevision: number;
} & ({ deleted: true; task: null } | { deleted: false; task: ScheduledTask });

/** 桌面账号配置只投影本地CAS和同步状态，不把持久owner当执行许可。 */
export type DesktopAccountScheduledTaskConfig = { task: ScheduledTask; localRevision: number; pending: boolean; stopIntent: "disabled" | "deleted" | null };
/** 空列表也携带可信Host设备，身份不从renderer或任务首行推断。 */
export type DesktopAccountScheduledTaskListResponseBody = { clientId: string; deviceId: string; items: DesktopAccountScheduledTaskConfig[] };
export type DesktopAccountScheduledTaskEdit = Pick<ScheduledTask, "name" | "description" | "taskType" | "cronExpr" | "timezone" | "enabled"
  | "payload" | "concurrencyPolicy" | "missedPolicy" | "timeoutMs">;
export type DesktopAccountScheduledTaskMutation = { taskId: string; expectedLocalRevision: number };
/** 当前账号本机历史仅暴露运行与名称，不下发持久owner或投递内部状态。 */
export type DesktopAccountScheduledTaskRun = ScheduledTaskRun & { source: "account"; taskNameSnapshot: string };
export type DesktopAccountScheduledTaskRunsQuery = { taskId?: string; offset?: number; limit?: number };
export type DesktopAccountScheduledTaskRunsResponseBody = { items: DesktopAccountScheduledTaskRun[]; total: number };

export type ClientScheduledTaskNextRunReport = {
  taskId: string;
  nextRunAt: number | null;
};

export type ClientScheduledTaskRunReport = {
  id: string;
  taskId: string;
  clientId: string;
  deviceId: string;
  workspaceId?: WorkspaceId | null;
  workflowInstanceId?: OrchestrationId | null;
  workflowNameSnapshot?: string | null;
  workflowVersion?: number | null;
  scheduledAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  status: ScheduledTaskRunStatus;
  triggerSource: ScheduledTaskTriggerSource;
  attempt?: number | null;
  durationMs?: number | null;
  summary?: string | null;
  errorMessage?: string | null;
  outputExcerpt?: string | null;
};

export type ClientScheduledTaskReportRequestBody = {
  clientId: string;
  deviceId: string;
  nextRuns?: ClientScheduledTaskNextRunReport[] | null;
  run?: ClientScheduledTaskRunReport | null;
};

export type ClientScheduledTaskReportResponseBody = {
  serverNow: number;
};

export type ScheduledTaskRunNowClientRequestBody = {
  taskId: string;
};

export type ScheduledTaskRunNowClientResponseBody = {
  run: ScheduledTaskRun;
};

export type CronValidationResult =
  | { ok: true }
  | { ok: false; message: string };

type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

type ParsedCronField = {
  any: boolean;
  values: Set<number>;
};

type ParsedCronExpression = {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

const CRON_FIELD_RULES: Record<CronFieldName, { min: number; max: number; label: string }> = {
  minute: { min: 0, max: 59, label: "minute" },
  hour: { min: 0, max: 23, label: "hour" },
  dayOfMonth: { min: 1, max: 31, label: "day-of-month" },
  month: { min: 1, max: 12, label: "month" },
  dayOfWeek: { min: 0, max: 7, label: "day-of-week" },
};

const CRON_MAX_SCAN_MINUTES = 366 * 24 * 60;

/** 判断是否为可配置的工作流实例状态。 */
export function isScheduledTaskWorkflowSkipStatus(value: unknown): value is OrchestrationStatus {
  return SCHEDULED_TASK_WORKFLOW_STATUSES.includes(value as OrchestrationStatus);
}

/** 规范化工作流定时任务的跳过状态；缺失时使用默认“未结束则跳过”。 */
export function normalizeScheduledTaskWorkflowSkipStatuses(value: unknown): OrchestrationStatus[] {
  if (value == null) return [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES];
  if (!Array.isArray(value)) return [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES];
  const out: OrchestrationStatus[] = [];
  const seen = new Set<OrchestrationStatus>();
  for (const item of value) {
    if (!isScheduledTaskWorkflowSkipStatus(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 校验五段 crontab 表达式，失败时返回面向界面的错误文案。 */
export function validateCronExpression(cronExpr: string): CronValidationResult {
  try {
    parseCronExpression(cronExpr);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 在原 366 天分钟区间找下一次触发，按 UTC 日排除不可能匹配的日期。 */
export function computeNextCronTimeMs(
  cronExpr: string,
  afterMs: number,
  timezone = "Asia/Shanghai",
): number {
  const parsed = parseCronExpression(cronExpr);
  assertValidTimeZone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  let cursor = floorToMinute(afterMs) + 60_000;
  if (!Number.isFinite(new Date(cursor).getTime())) {
    throw Object.assign(new RangeError("Invalid time value"), { code: "SCHEDULED_TASK_CRON_TIME_INVALID" });
  }
  const end = cursor + CRON_MAX_SCAN_MINUTES * 60_000;
  const dayMs = 86_400_000;
  while (cursor < end) {
    const utcDay = Math.floor(cursor / dayMs) * dayMs;
    const dayEnd = Math.min(utcDay + dayMs, end);
    // 时区偏移小于一天，本地日期只可能落在相邻三个 UTC 日期内。
    const possibleDay = [-1, 0, 1].some(offset => {
      const date = new Date(utcDay + offset * dayMs);
      return !Number.isFinite(date.getTime()) || matchesCronDate(parsed,
        { month: date.getUTCMonth() + 1, dayOfMonth: date.getUTCDate(), dayOfWeek: date.getUTCDay() });
    });
    if (!possibleDay) {
      cursor = dayEnd;
      continue;
    }
    for (; cursor < dayEnd; cursor += 60_000) {
      if (matchesParsedCron(parsed, getTimeZoneDateParts(cursor, formatter))) return cursor;
    }
  }
  throw Object.assign(new Error("cron 未来一年内没有可执行时间"), { code: "SCHEDULED_TASK_CRON_NO_EXECUTION_TIME" });
}

/** 生成多个下一次执行时间，用于保存前预览。 */
export function computeNextCronTimeMsList(
  cronExpr: string,
  afterMs: number,
  timezone = "Asia/Shanghai",
  count = 5,
): number[] {
  const limit = Math.max(1, Math.min(10, Math.floor(Number(count) || 5)));
  const result: number[] = [];
  let cursor = afterMs;
  for (let i = 0; i < limit; i += 1) {
    const next = computeNextCronTimeMs(cronExpr, cursor, timezone);
    result.push(next);
    cursor = next;
  }
  return result;
}

/** 解析五段 crontab；仅支持数字、星号、列表、范围和步长。 */
export function parseCronExpression(cronExpr: string): ParsedCronExpression {
  const parts = String(cronExpr ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("cron 必须是五段格式：minute hour day-of-month month day-of-week");
  }
  return {
    minute: parseCronField(parts[0]!, "minute"),
    hour: parseCronField(parts[1]!, "hour"),
    dayOfMonth: parseCronField(parts[2]!, "dayOfMonth"),
    month: parseCronField(parts[3]!, "month"),
    dayOfWeek: normalizeDayOfWeekField(parseCronField(parts[4]!, "dayOfWeek")),
  };
}

/** 仅将 Intl 构造器的非法时区 RangeError 标记为输入失败，未知故障原样抛出。 */
export function assertValidTimeZone(timezone: string): void {
  const normalized = String(timezone ?? "").trim() || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw Object.assign(new Error("timezone 无效：" + normalized, { cause }), { code: "SCHEDULED_TASK_CRON_TIMEZONE_INVALID" });
  }
}

function parseCronField(raw: string, fieldName: CronFieldName): ParsedCronField {
  const rule = CRON_FIELD_RULES[fieldName];
  const text = String(raw ?? "").trim();
  if (!text) throw new Error(`cron ${rule.label} 不能为空`);
  const values = new Set<number>();
  const chunks = text.split(",");
  for (const chunk of chunks) {
    parseCronChunk(chunk, rule, values);
  }
  if (!values.size) throw new Error(`cron ${rule.label} 没有有效取值`);
  return {
    any: text === "*",
    values,
  };
}

function parseCronChunk(
  raw: string,
  rule: { min: number; max: number; label: string },
  values: Set<number>,
): void {
  const chunk = String(raw ?? "").trim();
  if (!chunk) throw new Error(`cron ${rule.label} 含空列表项`);
  const [base = "", stepText] = chunk.split("/");
  if (chunk.split("/").length > 2) throw new Error(`cron ${rule.label} 步长格式无效`);
  const step = stepText == null ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step <= 0) throw new Error(`cron ${rule.label} 步长无效`);

  const range = parseCronRange(base, rule);
  for (let value = range.start; value <= range.end; value += step) {
    values.add(value);
  }
}

function parseCronRange(
  base: string,
  rule: { min: number; max: number; label: string },
): { start: number; end: number } {
  if (base === "*") return { start: rule.min, end: rule.max };
  if (base.includes("-")) {
    const [startText = "", endText = ""] = base.split("-");
    if (base.split("-").length > 2) throw new Error(`cron ${rule.label} 范围格式无效`);
    const start = parseCronNumber(startText, rule);
    const end = parseCronNumber(endText, rule);
    if (start > end) throw new Error(`cron ${rule.label} 范围起点不能大于终点`);
    return { start, end };
  }
  const value = parseCronNumber(base, rule);
  return { start: value, end: value };
}

function parseCronNumber(raw: string, rule: { min: number; max: number; label: string }): number {
  if (!/^\d+$/.test(raw)) throw new Error(`cron ${rule.label} 只支持数字`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`cron ${rule.label} 取值范围是 ${rule.min}-${rule.max}`);
  }
  return value;
}

function normalizeDayOfWeekField(field: ParsedCronField): ParsedCronField {
  if (!field.values.has(7)) return field;
  const values = new Set(field.values);
  values.delete(7);
  values.add(0);
  return { ...field, values };
}

function floorToMinute(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(Date.now() / 60_000) * 60_000;
  return Math.floor(numeric / 60_000) * 60_000;
}

/** 分钟与小时匹配后复用同一日期规则，保持原候选时间轴顺序。 */
function matchesParsedCron(
  parsed: ParsedCronExpression,
  parts: { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number },
): boolean {
  if (!parsed.minute.values.has(parts.minute)) return false;
  if (!parsed.hour.values.has(parts.hour)) return false;
  return matchesCronDate(parsed, parts);
}

/** 月份必须命中；日与星期沿 crontab 原有 OR 语义。 */
function matchesCronDate(
  parsed: ParsedCronExpression,
  parts: { dayOfMonth: number; month: number; dayOfWeek: number },
): boolean {
  if (!parsed.month.values.has(parts.month)) return false;

  const domMatch = parsed.dayOfMonth.values.has(parts.dayOfMonth);
  const dowMatch = parsed.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = parsed.dayOfMonth.any && parsed.dayOfWeek.any
    ? true
    : parsed.dayOfMonth.any
      ? dowMatch
      : parsed.dayOfWeek.any
        ? domMatch
        : domMatch || dowMatch;
  return dayMatches;
}

/** 同一次 cron 扫描复用时区格式器，避免按候选分钟反复构造。 */
function getTimeZoneDateParts(ms: number, formatter: Intl.DateTimeFormat): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const map = new Map(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const year = Number(map.get("year"));
  const month = Number(map.get("month"));
  const day = Number(map.get("day"));
  const hour = Number(map.get("hour"));
  const minute = Number(map.get("minute"));
  return {
    minute,
    hour,
    dayOfMonth: day,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}
