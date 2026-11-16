/** 启动阶段是实际事件，不是估算百分比；ready 只能在 hello 激活完成后发布。 */
export const CLIENT_STARTUP_MESSAGES = {
  starting: "正在创建后台 Client 进程",
  config: "正在读取并检查 Client 配置",
  identity: "正在验证 Client 身份和本地数据目录",
  update: "正在检查 Client 版本",
  database: "正在准备本地数据库",
  services: "正在初始化本地服务和工作区",
  connecting: "正在连接服务器",
  authenticating: "连接已建立，正在等待服务器确认 Client 身份",
  synchronizing: "服务器已响应，正在完成必要的数据同步",
  ready: "已连接服务器，Client 已就绪",
  degraded: "已连接服务器，但部分模块异常，功能受限；请查看日志",
  disconnected: "与服务器连接已断开，正在等待重连",
  failed: "Client 启动或连接失败，请查看错误说明和日志",
  stopping: "Client 正在停止",
} as const;

export type ClientStartupStage = keyof typeof CLIENT_STARTUP_MESSAGES;
export type ClientStartupSnapshot = {
  stage: ClientStartupStage;
  updatedAt: string;
  clientId: string | null;
  serverUrl: string | null;
};

/** URL 只显示协议/主机/路径，绝不携带凭据、查询参数或片段。 */
export function safeClientServerUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? ""));
    if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return null; }
}

/** 读取兼容旧版的可选状态；未知/不完整状态不能被升级成 ready。 */
export function parseClientStartupSnapshot(raw: unknown): ClientStartupSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.stage !== "string" || !Object.hasOwn(CLIENT_STARTUP_MESSAGES, value.stage)) return null;
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  return {
    stage: value.stage as ClientStartupStage, updatedAt: value.updatedAt,
    clientId: typeof value.clientId === "string" ? redactClientStartupText(value.clientId).slice(0, 200) : null,
    serverUrl: safeClientServerUrl(value.serverUrl),
  };
}

/** 前台诊断也必须脱敏，避免错误文本或子进程输出泄漏 Key。 */
export function redactClientStartupText(raw: string): string {
  return raw.replace(/codeflowai_[A-Za-z0-9_]{16,128}/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, "$1 [REDACTED]")
    .replace(/(["']?\b(?:authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,}]+)/gi, "$1[REDACTED]")
    .replace(/(["']?\b(?:password|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/(?:wss?|https?):\/\/[^\s"'<>]+/gi, value => safeClientServerUrl(value) || "[REDACTED_URL]");
}

export function formatClientStartupProgress(stage: ClientStartupStage, elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `[codeflowai] 启动中（${seconds} 秒）：${CLIENT_STARTUP_MESSAGES[stage]}`;
}

/** 进程存活、旧成功记录或 TCP 已连接都不能单独构成就绪。 */
export function isClientConnectionReady(input: {
  supervisorRunning: boolean; clientRunning: boolean; status: string;
  initialConnection: string | null; snapshot: ClientStartupSnapshot | null;
}): boolean {
  return isClientServerConnected(input) && input.snapshot?.stage === "ready";
}

/** 基础服务完成当前连接的 hello 后才算在线；模块异常不等于断线或完全就绪。 */
export function isClientServerConnected(input: {
  supervisorRunning: boolean; clientRunning: boolean; status: string;
  initialConnection: string | null; snapshot: ClientStartupSnapshot | null;
}): boolean {
  return input.supervisorRunning && input.clientRunning && input.status === "running"
    && input.initialConnection === "succeeded" && (input.snapshot?.stage === "ready" || input.snapshot?.stage === "degraded");
}
