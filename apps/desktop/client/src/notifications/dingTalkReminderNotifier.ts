import crypto from "node:crypto";

import { logger } from "../logger.js";
import type { DingTalkReminderNotificationRepo } from "../db/repos/dingTalkReminderNotificationRepo.js";
import type { ReminderActionNotification, ReminderCompletionNotification, ReminderCompletionNotifier } from "./reminderNotificationTypes.js";

type DingTalkReminderConfig = {
  enabled: boolean;
  webhook: string;
  secret: string;
  keyword: string;
  atMobiles: string[];
  atUserIds: string[];
  atAll: boolean;
  timeoutMs: number;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type DingTalkWebhookResponse = {
  errcode?: number | string;
  errmsg?: string;
};

const DEFAULT_TIMEOUT_MS = 8_000;

/** 创建待办钉钉通知器；未启用时返回无副作用实现。 */
export function createDingTalkReminderNotifier(input: {
  records: DingTalkReminderNotificationRepo;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 统一需求入口确认当前工作区存在有效提醒订阅。 */
  hasDemand?: (workspaceId: string) => boolean;
}): ReminderCompletionNotifier {
  const env = input.env ?? process.env;
  const config = readDingTalkReminderConfig(env);
  const now = input.now ?? (() => Date.now());
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));

  if (!config.enabled) {
    return {
      notifyCompletion: async () => undefined,
      notifyAction: async () => undefined,
    };
  }
  validateDingTalkReminderConfig(config);

  return {
    /** 无需求不触碰发送幂等记录。 */
    async notifyCompletion(notification) {
      if (input.hasDemand?.(notification.workspaceId) !== true) return;
      await sendOnce(input.records, notification, "completion", () => sendDingTalkWebhook({ config, notification, fetchImpl, now }), now);
    },
    /** 无需求不派发第三方待办。 */
    async notifyAction(notification) {
      if (input.hasDemand?.(notification.workspaceId) !== true) return;
      await sendOnce(input.records, notification, "action", () => sendDingTalkWebhook({ config, notification, fetchImpl, now }), now);
    },
  };
}

/** 从环境变量读取钉钉通知配置，兼容 CODEFLOWAI/AIDT 前缀。 */
export function readDingTalkReminderConfig(env: NodeJS.ProcessEnv = process.env): DingTalkReminderConfig {
  const enabled = readBooleanEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_ENABLED", "AIDT_DINGTALK_REMINDER_ENABLED"], false);
  if (!enabled) {
    return { enabled, webhook: "", secret: "", keyword: "", atMobiles: [], atUserIds: [], atAll: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  return {
    enabled,
    webhook: readFirstEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_WEBHOOK", "AIDT_DINGTALK_REMINDER_WEBHOOK"]),
    secret: readFirstEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_SECRET", "AIDT_DINGTALK_REMINDER_SECRET"]),
    keyword: readFirstEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_KEYWORD", "AIDT_DINGTALK_REMINDER_KEYWORD"]),
    atMobiles: readCsvEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_AT_MOBILES", "AIDT_DINGTALK_REMINDER_AT_MOBILES"]),
    atUserIds: readCsvEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_AT_USER_IDS", "AIDT_DINGTALK_REMINDER_AT_USER_IDS"]),
    atAll: readBooleanEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_AT_ALL", "AIDT_DINGTALK_REMINDER_AT_ALL"], false),
    timeoutMs: readTimeoutMs(readFirstEnv(env, ["CODEFLOWAI_DINGTALK_REMINDER_TIMEOUT_MS", "AIDT_DINGTALK_REMINDER_TIMEOUT_MS"])),
  };
}

/** 校验启用状态下的必要配置，避免启动后才吞掉通知失败。 */
function validateDingTalkReminderConfig(config: DingTalkReminderConfig): void {
  const webhook = config.webhook.trim();
  if (!webhook) throw new Error("CODEFLOWAI_DINGTALK_REMINDER_WEBHOOK is required when DingTalk reminder notification is enabled");
  let parsed: URL;
  try {
    parsed = new URL(webhook);
  } catch {
    throw new Error("CODEFLOWAI_DINGTALK_REMINDER_WEBHOOK must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("CODEFLOWAI_DINGTALK_REMINDER_WEBHOOK must use http or https");
  }
}

/** 调用钉钉机器人 webhook，非 2xx 或 errcode 非 0 都视为发送失败。 */
async function sendDingTalkWebhook(input: {
  config: DingTalkReminderConfig;
  notification: ReminderCompletionNotification | ReminderActionNotification;
  fetchImpl: FetchLike;
  now: () => number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  timeout.unref?.();
  try {
    const res = await input.fetchImpl(buildWebhookUrl(input.config, input.now), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDingTalkMarkdownBody(input.config, input.notification)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`DingTalk webhook HTTP ${res.status}: ${truncate(text, 300)}`);
    }
    const parsed = parseWebhookResponse(text);
    const errcode = Number(parsed.errcode);
    if (!Number.isFinite(errcode)) {
      throw new Error("DingTalk webhook response missing numeric errcode");
    }
    if (errcode !== 0) {
      throw new Error(`DingTalk webhook error ${errcode}: ${parsed.errmsg ?? "unknown"}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** 生成带签名参数的 webhook URL；未配置 secret 时保留原 URL。 */
function buildWebhookUrl(config: DingTalkReminderConfig, now: () => number): string {
  const url = new URL(config.webhook);
  if (!config.secret) return url.toString();
  const timestamp = String(now());
  const signText = `${timestamp}\n${config.secret}`;
  const sign = crypto.createHmac("sha256", config.secret).update(signText).digest("base64");
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("sign", sign);
  return url.toString();
}

/** 构造钉钉 markdown 消息体，包含可选关键词与 @ 目标。 */
function buildDingTalkMarkdownBody(config: DingTalkReminderConfig, notification: ReminderCompletionNotification | ReminderActionNotification): Record<string, unknown> {
  const atText = buildAtText(config);
  const sourceLabel = notification.sourceType === "orchestration" ? "编排任务" : "会话任务";
  const title = "CodeFlow 待办通知";
  const timing = notificationTiming(notification, "- ");
  const lines = [
    `- 任务类型：${sourceLabel}`,
    notificationTitleLine(notification, "- "),
    `- 所属工作区：${sanitizeLine(notification.workspaceTitle || String(notification.workspaceId))}`,
    `- 任务状态：${notificationStatusText(notification)}`,
    formatSummaryLine(notification, "- "),
    notificationActionLine(notification, "- "),
    timing,
    atText,
  ].filter(Boolean);
  return {
    msgtype: "markdown",
    markdown: {
      title,
      text: lines.join("\n"),
    },
    at: {
      atMobiles: config.atMobiles,
      atUserIds: config.atUserIds,
      isAtAll: config.atAll,
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

/** Read a boolean env value and fail on invalid non-empty input. */
function readBooleanEnv(env: NodeJS.ProcessEnv, keys: string[], fallback: boolean): boolean {
  const raw = readFirstEnv(env, keys).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid boolean DingTalk reminder env value: ${raw}`);
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

/** Read the webhook timeout; empty uses default and invalid non-empty input fails. */
function readTimeoutMs(raw: string): number {
  if (!raw.trim()) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000 || value > 60_000) {
    throw new Error("CODEFLOWAI_DINGTALK_REMINDER_TIMEOUT_MS must be between 1000 and 60000");
  }
  return Math.floor(value);
}

/** 生成 markdown 中的 @ 文本；钉钉要求 markdown 正文同时包含 @ 目标。 */
function buildAtText(config: DingTalkReminderConfig): string {
  if (config.atAll) return "@所有人";
  return [...config.atMobiles, ...config.atUserIds].map((item) => `@${item}`).join(" ");
}

/** 生成标题行；编排任务展示任务名称，普通会话保持会话名称。 */
function notificationTitleLine(notification: ReminderCompletionNotification | ReminderActionNotification, prefix = ""): string {
  const label = notification.sourceType === "orchestration" ? "任务名称" : "会话名称";
  return `${prefix}${label}：${sanitizeLine(notification.title)}`;
}

/** 生成通知摘要行；编排完成通知使用任务标题，避免群通知只展示泛化完成文案。 */
function formatSummaryLine(notification: ReminderCompletionNotification | ReminderActionNotification, prefix = ""): string {
  const summary = isCompletionNotification(notification) && notification.sourceType === "orchestration" ? notification.title : notification.summary;
  const text = sanitizeLine(summary);
  return text ? `${prefix}任务摘要：${text}` : "";
}

/** 生成通知状态文案，兼容完成和人工待办两类通知。 */
function notificationStatusText(notification: ReminderCompletionNotification | ReminderActionNotification): string {
  return isCompletionNotification(notification) ? "已完成，待查收" : sanitizeLine(notification.statusLabel);
}

/** 生成可选处理动作行；完成通知不展示。 */
function notificationActionLine(notification: ReminderCompletionNotification | ReminderActionNotification, prefix = ""): string {
  if (isCompletionNotification(notification)) return "";
  const text = sanitizeLine(notification.actionLabel);
  return text ? `${prefix}处理动作：${text}` : "";
}

/** 生成时间行，按通知类型区分完成时间和提醒时间。 */
function notificationTiming(notification: ReminderCompletionNotification | ReminderActionNotification, prefix = ""): string {
  if (isCompletionNotification(notification)) return `${prefix}完成时间：${formatLocalDateTime(notification.completedAt)}`;
  return `${prefix}提醒时间：${formatLocalDateTime(notification.occurredAt)}`;
}

/** 区分完成通知和人工待办通知。 */
function isCompletionNotification(notification: ReminderCompletionNotification | ReminderActionNotification): notification is ReminderCompletionNotification {
  return Object.prototype.hasOwnProperty.call(notification, "completedAt");
}

/** 以 notificationKey 为幂等键发送一次通知并记录结果。 */
async function sendOnce(
  records: DingTalkReminderNotificationRepo,
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
    logger.info("dingtalk", `reminder ${kind} notification sent`, {
      notificationKey: notification.notificationKey,
      workspaceId: notification.workspaceId,
      sourceType: notification.sourceType,
      targetId: notification.targetId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    records.markFailed(notification.notificationKey, message, now());
    logger.error("dingtalk", `reminder ${kind} notification failed`, {
      notificationKey: notification.notificationKey,
      workspaceId: notification.workspaceId,
      sourceType: notification.sourceType,
      targetId: notification.targetId,
      error: message,
    });
    throw error;
  }
}

/** Parse the DingTalk response; empty or non-JSON bodies are external API failures. */
function parseWebhookResponse(text: string): DingTalkWebhookResponse {
  if (!text.trim()) throw new Error("DingTalk webhook returned empty response");
  try {
    return JSON.parse(text) as DingTalkWebhookResponse;
  } catch {
    throw new Error(`DingTalk webhook returned non-JSON response: ${truncate(text, 300)}`);
  }
}

/** 将用户文案收敛到单行，避免破坏 markdown 结构。 */
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
