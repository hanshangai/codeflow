import { logger } from "../logger.js";
import type { WeComReminderNotificationRepo } from "../db/repos/weComReminderNotificationRepo.js";
import type { ReminderActionNotification, ReminderCompletionNotification, ReminderCompletionNotifier } from "./reminderNotificationTypes.js";

type WeComReminderConfig = {
  enabled: boolean;
  webhook: string;
  atMobiles: string[];
  atUserIds: string[];
  atAll: boolean;
  timeoutMs: number;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type WeComWebhookResponse = {
  errcode?: number | string;
  errmsg?: string;
};

const DEFAULT_TIMEOUT_MS = 8_000;

/** 创建待办企业微信通知器；未启用时返回无副作用实现。 */
export function createWeComReminderNotifier(input: {
  records: WeComReminderNotificationRepo;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 统一需求入口确认当前工作区存在有效提醒订阅。 */
  hasDemand?: (workspaceId: string) => boolean;
}): ReminderCompletionNotifier {
  const env = input.env ?? process.env;
  const config = readWeComReminderConfig(env);
  const now = input.now ?? (() => Date.now());
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));

  if (!config.enabled) {
    return {
      notifyCompletion: async () => undefined,
      notifyAction: async () => undefined,
    };
  }
  validateWeComReminderConfig(config);

  return {
    /** 无需求不触碰发送幂等记录。 */
    async notifyCompletion(notification) {
      if (input.hasDemand?.(notification.workspaceId) !== true) return;
      await sendOnce(input.records, notification, "completion", () => sendWeComWebhook({ config, notification, fetchImpl }), now);
    },
    /** 无需求不派发第三方待办。 */
    async notifyAction(notification) {
      if (input.hasDemand?.(notification.workspaceId) !== true) return;
      await sendOnce(input.records, notification, "action", () => sendWeComWebhook({ config, notification, fetchImpl }), now);
    },
  };
}

/** 从环境变量读取企业微信通知配置，兼容 CODEFLOWAI/AIDT 前缀。 */
export function readWeComReminderConfig(env: NodeJS.ProcessEnv = process.env): WeComReminderConfig {
  const enabled = readBooleanEnv(env, ["CODEFLOWAI_WECOM_REMINDER_ENABLED", "AIDT_WECOM_REMINDER_ENABLED"], false);
  if (!enabled) {
    return { enabled, webhook: "", atMobiles: [], atUserIds: [], atAll: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  return {
    enabled,
    webhook: readFirstEnv(env, ["CODEFLOWAI_WECOM_REMINDER_WEBHOOK", "AIDT_WECOM_REMINDER_WEBHOOK"]),
    atMobiles: readCsvEnv(env, ["CODEFLOWAI_WECOM_REMINDER_AT_MOBILES", "AIDT_WECOM_REMINDER_AT_MOBILES"]),
    atUserIds: readCsvEnv(env, ["CODEFLOWAI_WECOM_REMINDER_AT_USER_IDS", "AIDT_WECOM_REMINDER_AT_USER_IDS"]),
    atAll: readBooleanEnv(env, ["CODEFLOWAI_WECOM_REMINDER_AT_ALL", "AIDT_WECOM_REMINDER_AT_ALL"], false),
    timeoutMs: readTimeoutMs(readFirstEnv(env, ["CODEFLOWAI_WECOM_REMINDER_TIMEOUT_MS", "AIDT_WECOM_REMINDER_TIMEOUT_MS"])),
  };
}

/** 校验启用状态下的必要配置，避免启动后才暴露配置错误。 */
function validateWeComReminderConfig(config: WeComReminderConfig): void {
  const webhook = config.webhook.trim();
  if (!webhook) throw new Error("CODEFLOWAI_WECOM_REMINDER_WEBHOOK is required when WeCom reminder notification is enabled");
  let parsed: URL;
  try {
    parsed = new URL(webhook);
  } catch {
    throw new Error("CODEFLOWAI_WECOM_REMINDER_WEBHOOK must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("CODEFLOWAI_WECOM_REMINDER_WEBHOOK must use http or https");
  }
}

/** 调用企业微信群机器人 webhook，非 2xx 或 errcode 非 0 都视为发送失败。 */
async function sendWeComWebhook(input: {
  config: WeComReminderConfig;
  notification: ReminderCompletionNotification | ReminderActionNotification;
  fetchImpl: FetchLike;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  timeout.unref?.();
  try {
    const res = await input.fetchImpl(input.config.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWeComTextBody(input.config, input.notification)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WeCom webhook HTTP ${res.status}: ${truncate(text, 300)}`);
    }
    const parsed = parseWebhookResponse(text);
    const errcode = Number(parsed.errcode);
    if (!Number.isFinite(errcode)) {
      throw new Error("WeCom webhook response missing numeric errcode");
    }
    if (errcode !== 0) {
      throw new Error(`WeCom webhook error ${errcode}: ${parsed.errmsg ?? "unknown"}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** 构造企业微信 text 消息体，确保手机号/userId/@所有人可由机器人原生 @。 */
function buildWeComTextBody(config: WeComReminderConfig, notification: ReminderCompletionNotification | ReminderActionNotification): Record<string, unknown> {
  const sourceLabel = notification.sourceType === "orchestration" ? "编排任务" : "会话任务";
  const content = [
    `任务类型：${sourceLabel}`,
    notificationTitleLine(notification),
    `所属工作区：${sanitizeLine(notification.workspaceTitle || String(notification.workspaceId))}`,
    `任务状态：${notificationStatusText(notification)}`,
    formatSummaryLine(notification),
    notificationActionLine(notification),
    notificationTiming(notification),
  ].filter(Boolean).join("\n");

  return {
    msgtype: "text",
    text: {
      content,
      mentioned_list: config.atAll ? ["@all"] : config.atUserIds,
      mentioned_mobile_list: config.atMobiles,
    },
  };
}

/** 读取第一个非空环境变量。 */
function readFirstEnv(env: NodeJS.ProcessEnv, keys: string[]): string {
  for (const key of keys) {
    const value = String(env[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** 读取布尔环境变量，非法非空值显式失败。 */
function readBooleanEnv(env: NodeJS.ProcessEnv, keys: string[], fallback: boolean): boolean {
  const raw = readFirstEnv(env, keys).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid boolean WeCom reminder env value: ${raw}`);
}

/** 读取逗号分隔环境变量并去重。 */
function readCsvEnv(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  const seen = new Set<string>();
  for (const value of readFirstEnv(env, keys).split(",")) {
    const item = value.trim();
    if (item) seen.add(item);
  }
  return [...seen];
}

/** 读取请求超时时间；空值使用默认值，非法非空值显式失败。 */
function readTimeoutMs(raw: string): number {
  if (!raw.trim()) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000 || value > 60_000) {
    throw new Error("CODEFLOWAI_WECOM_REMINDER_TIMEOUT_MS must be between 1000 and 60000");
  }
  return Math.floor(value);
}

/** 生成标题行；编排任务展示任务名称，普通会话保持会话名称。 */
function notificationTitleLine(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  const label = notification.sourceType === "orchestration" ? "任务名称" : "会话名称";
  return `${label}：${sanitizeLine(notification.title)}`;
}

/** 生成通知摘要行；编排完成通知使用任务标题，避免群通知只展示泛化完成文案。 */
function formatSummaryLine(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  const summary = isCompletionNotification(notification) && notification.sourceType === "orchestration" ? notification.title : notification.summary;
  const text = sanitizeLine(summary);
  return text ? `任务摘要：${text}` : "";
}

/** 生成通知状态文案，兼容完成和人工待办两类通知。 */
function notificationStatusText(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  return isCompletionNotification(notification) ? "已完成，待查收" : sanitizeLine(notification.statusLabel);
}

/** 生成可选处理动作行；完成通知不展示。 */
function notificationActionLine(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  if (isCompletionNotification(notification)) return "";
  const text = sanitizeLine(notification.actionLabel);
  return text ? `处理动作：${text}` : "";
}

/** 生成时间行，按通知类型区分完成时间和提醒时间。 */
function notificationTiming(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  if (isCompletionNotification(notification)) return `完成时间：${formatLocalDateTime(notification.completedAt)}`;
  return `提醒时间：${formatLocalDateTime(notification.occurredAt)}`;
}

/** 区分完成通知和人工待办通知。 */
function isCompletionNotification(notification: ReminderCompletionNotification | ReminderActionNotification): notification is ReminderCompletionNotification {
  return Object.prototype.hasOwnProperty.call(notification, "completedAt");
}

/** 以 notificationKey 为幂等键发送一次通知并记录结果。 */
async function sendOnce(
  records: WeComReminderNotificationRepo,
  notification: ReminderCompletionNotification | ReminderActionNotification,
  kind: "completion" | "action",
  send: () => Promise<void>,
  now: () => number,
): Promise<void> {
  const existing = records.get(notification.notificationKey);
  if (existing?.status === "sent") return;

  records.beginAttempt({
    notificationKey: notification.notificationKey,
    workspaceId: notification.workspaceId,
    sourceType: notification.sourceType,
    targetId: notification.targetId,
    title: notification.title,
    now: now(),
  });

  try {
    await send();
    records.markSent(notification.notificationKey, now());
    logger.info("wecom", `reminder ${kind} notification sent`, {
      notificationKey: notification.notificationKey,
      workspaceId: notification.workspaceId,
      sourceType: notification.sourceType,
      targetId: notification.targetId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    records.markFailed(notification.notificationKey, message, now());
    logger.error("wecom", `reminder ${kind} notification failed`, {
      notificationKey: notification.notificationKey,
      workspaceId: notification.workspaceId,
      sourceType: notification.sourceType,
      targetId: notification.targetId,
      error: message,
    });
    throw error;
  }
}

/** 解析企业微信响应体；非 JSON 或空响应都视为外部接口异常。 */
function parseWebhookResponse(text: string): WeComWebhookResponse {
  if (!text.trim()) throw new Error("WeCom webhook returned empty response");
  try {
    return JSON.parse(text) as WeComWebhookResponse;
  } catch {
    throw new Error(`WeCom webhook returned non-JSON response: ${truncate(text, 300)}`);
  }
}

/** 将用户文案收敛到单行，避免破坏消息结构。 */
function sanitizeLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 格式化通知时间，输入异常时使用当前时间。 */
function formatLocalDateTime(ts: number): string {
  const value = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 截断外部响应摘要，防止日志过长。 */
function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}
