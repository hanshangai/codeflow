export type AnalyticsTrackValue = string | number | boolean | null;
export type AnalyticsTrackData = Record<string, AnalyticsTrackValue>;

export type AnalyticsAccountContextInput = {
  email?: string | null;
  accountRole?: string | null;
  accessContext?: {
    identityType?: string | null;
    editionType?: string | null;
    editionStatus?: string | null;
    effectiveAccessScope?: string | null;
    enterpriseId?: string | null;
  } | null;
  enterpriseId?: string | null;
  workspaceSet?: boolean | null;
};

type BaiduCommand = [command: string, ...args: unknown[]];

type BaiduWindow = Window & {
  _hmt?: BaiduCommand[];
};

const TRACKER_SCRIPT_ID = "codeflowai-baidu-tracker";
const BAIDU_SCRIPT_URL = "https://hm.baidu.com/hm.js";
const CLICK_EVENT_NAME = "ui_click";
const MAX_LABEL_LENGTH = 160;
const MAX_EVENT_NAME_LENGTH = 80;
const MAX_VALUE_LENGTH = 160;
const EVENT_LABEL_KEYS = [
  "label",
  "action",
  "status",
  "error_code_group",
  "mode",
  "outcome",
  "code",
  "source",
  "target_scope",
  "backend",
  "platform",
  "entry_source",
  "surface",
  "target",
  "feature",
  "panel",
  "tab",
  "plan_type",
  "workspace_type",
  "asset_type",
  "kind",
  "direction",
  "route_name",
  "main_view",
  "download_type",
  "thread_type",
  "thread_subtype",
  "engine",
  "dispatch_mode",
  "settings_panel",
  "settings_action",
  "knowledge_stage",
  "oauth_provider",
  "amount_bucket",
  "client_version_major",
  "account_role",
  "identity_type",
  "edition_type",
  "edition_status",
  "effective_access_scope",
  "workspace_set",
] as const;
const BLOCKED_DATA_KEYS = new Set([
  "api_key",
  "authorization",
  "business_order_id",
  "content",
  "cookie",
  "email",
  "email_domain",
  "enterprise_id",
  "enterprise_name",
  "file",
  "file_name",
  "file_path",
  "filename",
  "full_name",
  "message",
  "name",
  "order_id",
  "out_trade_no",
  "password",
  "payment_id",
  "payment_order_id",
  "phone",
  "prompt",
  "raw",
  "secret",
  "text",
  "token",
]);

let trackingConfigured = false;
let clickTrackingInstalled = false;
let accountContext: AnalyticsTrackData = {};

/** 安装百度统计；未配置站点 ID 时保持统计关闭，显式参数用于测试。 */
export function installBaiduTracking(configuredSiteId = import.meta.env?.VITE_CODEFLOWAI_BAIDU_SITE_ID): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const siteId = configuredSiteId?.trim();
  if (!siteId) return;
  if (!/^[a-fA-F0-9]{32}$/.test(siteId)) {
    reportAnalyticsError("BAIDU_SITE_ID_INVALID", "site id must be 32 hexadecimal characters");
    return;
  }
  if (trackingConfigured) return;

  trackingConfigured = true;
  const queue = ensureBaiduQueue();
  queue.push(["_setAutoPageview", false]);
  loadBaiduScript(siteId);
  installClickTracking();
}

/** 更新百度统计使用的非敏感账号上下文。 */
export function setAnalyticsAccountContext(input: AnalyticsAccountContextInput): void {
  const accessContext = input.accessContext ?? null;
  accountContext = compactTrackData({
    account_role: normalizeCompactString(input.accountRole),
    identity_type: normalizeCompactString(accessContext?.identityType),
    edition_type: normalizeCompactString(accessContext?.editionType),
    edition_status: normalizeCompactString(accessContext?.editionStatus),
    effective_access_scope: normalizeCompactString(accessContext?.effectiveAccessScope),
    workspace_set: input.workspaceSet == null ? null : Boolean(input.workspaceSet),
  });
}

/** 清除登出或会话过期后的百度统计账号上下文。 */
export function clearAnalyticsAccountContext(): void {
  accountContext = {};
}

/** 上报一个百度统计事件；输入在入队前会过滤敏感字段。 */
export function trackProductEvent(eventName: string, data: AnalyticsTrackData = {}): void {
  if (!trackingConfigured || typeof window === "undefined") return;
  const normalizedEventName = normalizeEventName(eventName);
  if (!normalizedEventName) return;
  const payload = buildPayload(data);
  if (normalizedEventName === "page_view") {
    enqueueBaiduCommand(["_trackPageview", normalizePagePath(payload.path)]);
    return;
  }
  const label = resolveEventLabel(payload);
  const value = resolveEventValue(payload);
  const command: BaiduCommand = ["_trackEvent", "codeflow", normalizedEventName];
  if (label || value !== undefined) command.push(label);
  if (value !== undefined) command.push(value);
  enqueueBaiduCommand(command);
}

/** 兼容登录埋点调用，但不向百度发送用户邮箱。 */
export function trackProductEventWithEmail(eventName: string, _email: string | null | undefined, data: AnalyticsTrackData = {}): void {
  trackProductEvent(eventName, data);
}

/** 异步加载百度统计脚本；页面路由由应用自行上报。 */
function loadBaiduScript(siteId: string): void {
  if (document.getElementById(TRACKER_SCRIPT_ID)) {
    return;
  }
  const script = document.createElement("script");
  script.id = TRACKER_SCRIPT_ID;
  script.async = true;
  script.defer = true;
  script.src = `${BAIDU_SCRIPT_URL}?${encodeURIComponent(siteId)}`;
  script.addEventListener("error", () => {
    // 统计不可用不应中断产品操作；停止继续排队，修复网络后由页面刷新重试。
    trackingConfigured = false;
    script.remove();
    reportAnalyticsError("BAIDU_SCRIPT_LOAD_FAILED", "tracker script load event failed");
  });
  try {
    document.head.appendChild(script);
  } catch (error) {
    trackingConfigured = false;
    reportAnalyticsError("BAIDU_SCRIPT_INSERT_FAILED", resolveErrorCause(error));
  }
}

/** 取得百度全局命令队列，脚本加载前的事件由其自行消费。 */
function ensureBaiduQueue(): BaiduCommand[] {
  const target = window as BaiduWindow;
  if (!Array.isArray(target._hmt)) target._hmt = [];
  return target._hmt;
}

/** 将命令送入百度队列；统计故障记录后停止埋点，不影响业务流程。 */
function enqueueBaiduCommand(command: BaiduCommand): void {
  try {
    ensureBaiduQueue().push(command);
  } catch (error) {
    trackingConfigured = false;
    reportAnalyticsError("BAIDU_QUEUE_PUSH_FAILED", resolveErrorCause(error));
  }
}

/** 记录可检索且不包含请求参数或凭据的统计错误。 */
function reportAnalyticsError(errorCode: string, cause: string): void {
  console.error("[analytics_error]", {
    errorCode,
    requestId: null,
    tracker: "baidu",
    cause,
  });
}

/** 提取有限长度的异常原因，避免把动态内容写入浏览器日志。 */
function resolveErrorCause(error: unknown): string {
  const cause = error instanceof Error ? error.message : "unknown analytics error";
  return cause.slice(0, MAX_VALUE_LENGTH);
}

/** 将白名单稳定维度组合为百度事件标签，避免发送任意业务字段。 */
function resolveEventLabel(data: AnalyticsTrackData): string {
  const parts: string[] = [];
  for (const key of EVENT_LABEL_KEYS) {
    const value = data[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const label = normalizeLabel(String(value));
    if (!label) continue;
    const part = key === "label" ? label : `${key}=${label}`;
    if ([...parts, part].join("|").length > MAX_LABEL_LENGTH) break;
    parts.push(part);
  }
  return parts.join("|");
}

/** 读取可选的数值指标，避免把布尔或长文本作为百度事件值。 */
function resolveEventValue(data: AnalyticsTrackData): number | undefined {
  for (const key of ["value", "count", "duration_ms"] as const) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  }
  for (const [key, value] of Object.entries(data)) {
    if (!key.endsWith("_count") || typeof value !== "number" || !Number.isFinite(value)) continue;
    return Math.round(value);
  }
  return undefined;
}

/** 规范化百度页面路径，去掉查询参数和片段中的动态内容。 */
function normalizePagePath(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "/";
  const path = text.split(/[?#]/, 1)[0]?.trim() ?? "";
  return path.startsWith("/") ? path.slice(0, MAX_VALUE_LENGTH) || "/" : "/";
}

/** Capture explicit semantic clicks so dynamic content is not collected as labels. */
function installClickTracking(): void {
  if (clickTrackingInstalled) return;
  clickTrackingInstalled = true;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const clickable = target?.closest("button,a,[role='button'],.ant-btn");
    if (!(clickable instanceof HTMLElement)) return;
    const label = resolveClickLabel(clickable);
    if (!label) return;
    trackProductEvent(CLICK_EVENT_NAME, {
      label,
    });
  }, { capture: true });
}


/** Build a safe event payload with account context and current route path. */
function buildPayload(data: AnalyticsTrackData): AnalyticsTrackData {
  return sanitizeTrackData({
    ...accountContext,
    path: typeof window !== "undefined" ? window.location.pathname : null,
    ...data,
  });
}

/** 保留百度统计所需的基础字段，并过滤敏感数据。 */
function sanitizeTrackData(data: AnalyticsTrackData): AnalyticsTrackData {
  const next: AnalyticsTrackData = {};
  for (const [rawKey, rawValue] of Object.entries(data)) {
    const key = normalizeDataKey(rawKey);
    if (!key || isBlockedDataKey(key)) continue;
    const value = normalizeTrackValue(rawValue, key);
    if (value !== undefined && value !== null && value !== "") {
      next[key] = value;
    }
  }
  return next;
}

/** 删除账号上下文中的空值。 */
function compactTrackData(data: AnalyticsTrackData): AnalyticsTrackData {
  const next: AnalyticsTrackData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== "") next[key] = value;
  }
  return next;
}

/** 规范化百度事件名，避免产生不稳定的高基数字段。 */
function normalizeEventName(value: string): string {
  return normalizeCompactString(value)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, MAX_EVENT_NAME_LENGTH);
}

/** Normalize payload keys and convert camelCase to snake_case. */
function normalizeDataKey(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 60);
}

/** Block fields that commonly carry secrets or user-generated content. */
function isBlockedDataKey(key: string): boolean {
  return BLOCKED_DATA_KEYS.has(key)
    || /(?:^|_)(?:api_key|authorization|cookie|email|password|phone|prompt|secret|token)(?:_|$)/u.test(key);
}

/** 将埋点值限制为百度统计可接受的基础类型。 */
function normalizeTrackValue(value: AnalyticsTrackValue, key: string): AnalyticsTrackValue | undefined {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (key === "platform") return normalizeAnalyticsPlatform(value);
  if (key === "client_version_major") return normalizeClientVersionMajor(value);
  return normalizeCompactString(value);
}

/** 将平台维度收口到固定枚举，拒绝 Client 自报内容形成高基数标签。 */
function normalizeAnalyticsPlatform(value: unknown): string {
  const platform = String(value ?? "").trim().toLowerCase();
  if (platform === "windows" || platform === "win32") return "windows";
  if (platform === "mac" || platform === "macos" || platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "wecom" || platform === "dingtalk") return platform;
  if (!platform || platform === "unknown") return "unknown";
  return "other";
}

/** 从 Client 自报版本中只保留纯数字主版本，无法识别时统一归为 unknown。 */
function normalizeClientVersionMajor(value: unknown): string {
  const match = String(value ?? "").trim().match(/^v?(\d{1,6})(?:\.|$)/iu);
  return match?.[1] ?? "unknown";
}

/** Normalize arbitrary short strings without preserving large dynamic content. */
function normalizeCompactString(value: unknown): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > MAX_VALUE_LENGTH ? `${normalized.slice(0, MAX_VALUE_LENGTH)}...` : normalized;
}

/** Resolve a stable click label without reading visible dynamic text. */
function resolveClickLabel(element: HTMLElement): string {
  const explicit = element.dataset.analyticsEvent || element.dataset.analyticsLabel;
  return normalizeLabel(String(explicit || ""));
}

/** Keep labels compact and avoid leaking long dynamic content. */
function normalizeLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (mayContainSensitiveDynamicValue(normalized)) return "";
  return normalized.length > MAX_LABEL_LENGTH
    ? `${normalized.slice(0, MAX_LABEL_LENGTH - 3)}...`
    : normalized;
}

/** Reject labels that look like user data, paths, credentials, or URLs. */
function mayContainSensitiveDynamicValue(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return /[\\/@]/.test(value)
    || lower.includes("token")
    || lower.includes("password")
    || lower.includes("secret")
    || lower.includes("authorization")
    || lower.startsWith("http:")
    || lower.startsWith("https:");
}
