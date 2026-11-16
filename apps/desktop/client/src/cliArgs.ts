export type ClientCliCommand =
  | { kind: "run"; apiKeyOverride?: string; apiKeyProvided?: boolean }
  | { kind: "daemon"; action: "start" | "stop" | "status" | "ready" | "connected"; apiKeyOverride?: string; apiKeyProvided?: boolean }
  | { kind: "update" }
  | { kind: "uninstall" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const FOREGROUND_FLAGS = new Set(["--foreground"]);
const UPDATE_FLAGS = new Set(["--update"]);
const UNINSTALL_FLAGS = new Set(["--uninstall"]);
const DAEMON_START_FLAGS = new Set(["--daemon", "--background"]);
const DAEMON_STOP_FLAGS = new Set(["--stop"]);
const DAEMON_STATUS_FLAGS = new Set(["--status"]);
const KEY_FLAG = "--key";

/** 解析 client CLI 参数，保持启动入口的行为集中可测。 */
export function parseClientCliArgs(argv: string[]): ClientCliCommand {
  const args = argv.map((arg) => String(arg ?? "").trim()).filter(Boolean);
  if (args.length === 0) return { kind: "daemon", action: "start" };

  for (const arg of args) {
    if (HELP_FLAGS.has(arg)) return { kind: "help" };
  }
  for (const arg of args) {
    if (VERSION_FLAGS.has(arg)) return { kind: "version" };
  }

  const keyResult = extractKeyArgument(args);
  if (keyResult.error) return { kind: "error", message: keyResult.error };
  const remaining = keyResult.args;
  const keyOptions = keyResult.apiKeyProvided
    ? { apiKeyOverride: keyResult.apiKeyOverride, apiKeyProvided: true as const }
    : {};

  if (remaining.length === 0) return { kind: "daemon", action: "start", ...keyOptions };

  if (remaining.some((arg) => FOREGROUND_FLAGS.has(arg))) {
    if (remaining.length > 1) {
      return { kind: "error", message: remaining.includes(KEY_FLAG) ? "不支持组合参数" : `不支持组合参数: ${remaining.join(" ")}` };
    }
    return { kind: "run", ...keyOptions };
  }

  if (remaining.some((arg) => UPDATE_FLAGS.has(arg))) {
    if (keyResult.apiKeyProvided) return { kind: "error", message: "--key 只能与启动命令组合使用" };
    if (remaining.length > 1) {
      return { kind: "error", message: `不支持组合参数: ${remaining.join(" ")}` };
    }
    return { kind: "update" };
  }

  if (remaining.some((arg) => UNINSTALL_FLAGS.has(arg))) {
    if (keyResult.apiKeyProvided) return { kind: "error", message: "--key 只能与启动命令组合使用" };
    if (remaining.length > 1) {
      return { kind: "error", message: `不支持组合参数: ${remaining.join(" ")}` };
    }
    return { kind: "uninstall" };
  }

  const daemonActions = remaining
    .map((arg) => resolveDaemonAction(arg))
    .filter((action): action is "start" | "stop" | "status" | "ready" | "connected" => Boolean(action));
  if (daemonActions.length > 1) {
    return { kind: "error", message: "后台启动参数不能组合使用" };
  }
  if (daemonActions.length === 1) {
    if (keyResult.apiKeyProvided && daemonActions[0] !== "start") {
      return { kind: "error", message: "--key 只能与启动命令组合使用" };
    }
    if (remaining.length > 1) {
      return { kind: "error", message: `不支持组合参数: ${remaining.filter((arg) => arg !== KEY_FLAG).join(" ")}` };
    }
    return { kind: "daemon", action: daemonActions[0]!, ...keyOptions };
  }

  const unknown = remaining.find((arg) => arg.startsWith("-")) ?? remaining[0];
  return { kind: "error", message: `不支持的参数: ${unknown}` };
}

type KeyArgumentResult = {
  args: string[];
  apiKeyOverride?: string;
  apiKeyProvided: boolean;
  error?: string;
};

/** 提取显式 key；值参数从错误文本中隔离，避免 shell 输入进入普通输出。 */
function extractKeyArgument(args: string[]): KeyArgumentResult {
  const remaining: string[] = [];
  let apiKeyOverride: string | undefined;
  let apiKeyProvided = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg !== KEY_FLAG) {
      if (arg.startsWith(`${KEY_FLAG}=`)) return { args: [], apiKeyProvided: false, error: "--key 必须使用独立值形式：--key <value>" };
      remaining.push(arg);
      continue;
    }
    if (apiKeyProvided) return { args: [], apiKeyProvided: false, error: "--key 只能传入一次" };
    apiKeyProvided = true;
    const value = args[index + 1];
    if (!value || value.startsWith("-")) return { args: [], apiKeyProvided: false, error: "--key 缺少值" };
    apiKeyOverride = value;
    index += 1;
  }
  return { args: remaining, apiKeyOverride, apiKeyProvided };
}

/** 将启动参数转换为后台子进程参数，避免子进程再次 daemonize。 */
export function toDaemonChildArgs(argv: string[]): string[] {
  const childArgs = argv
    .map((arg) => String(arg ?? "").trim())
    .filter((arg) => arg && !DAEMON_START_FLAGS.has(arg));
  return childArgs.some((arg) => FOREGROUND_FLAGS.has(arg)) ? childArgs : ["--foreground", ...childArgs];
}

/** 输出启动成功后展示的常用命令，避免用户再查 help。 */
export function formatClientCommonCommands(version: string | null): string {
  const resolvedVersion = String(version ?? "").trim() || "unknown";
  return [
    `CodeFlowAI Client CLI ${resolvedVersion}`,
    "",
    "常用命令:",
    ...clientUsageLines(),
  ].join("\n");
}

/** 输出面向用户的 CLI 帮助文本。 */
export function formatClientHelp(version: string | null): string {
  const resolvedVersion = String(version ?? "").trim() || "unknown";
  return [
    `CodeFlowAI Client CLI ${resolvedVersion}`,
    "",
    "用法:",
    ...clientUsageLines(),
    "",
    "常用环境变量:",
    "  CODEFLOWAI_API_KEY      Server 鉴权 key",
    "  --key 仅支持独立值形式，优先级高于 CODEFLOWAI_API_KEY 和 config.json",
    "  不支持 -k 短别名或 --key=<value> 形式",
    "  CODEFLOWAI_SERVER_WS    Server WebSocket 地址，如 wss://host/ws/client",
    "  CODEFLOWAI_WORKSPACES_JSON",
    "                          工作区 JSON 数组",
  ].join("\n");
}

/** 生成 CLI 命令说明列表，供 help 与启动提示共用。 */
function clientUsageLines(): string[] {
  return [
    "  codeflow                显示启动进度，连接就绪后转入后台",
    "  codeflow --foreground   前台启动 client（调试用，日志直接输出到当前窗口）",
    "  codeflow --key <value>  使用显式 key 启动 client（仅长参数）",
    "  codeflow --daemon       显示启动进度并在后台运行（显式写法）",
    "  codeflow --status       查看进程和服务器连接状态；就绪才返回成功",
    "  codeflow --ready        输出 JSON 完全就绪状态，包含资产状态",
    "  codeflow --connected    检查当前工作进程真实连接；JSON 会明确标注功能受限",
    "  codeflow --stop         停止后台 client",
    "  codeflow --update       检查并安装 client 更新",
    "  codeflow --uninstall    卸载 client，保留用户数据",
    "  codeflow --help         显示完整帮助",
    "  codeflow --version      显示当前 client 版本",
  ];
}

/** 识别 daemon 子命令，未命中时返回 null。 */
function resolveDaemonAction(arg: string): "start" | "stop" | "status" | "ready" | "connected" | null {
  if (DAEMON_START_FLAGS.has(arg)) return "start";
  if (DAEMON_STOP_FLAGS.has(arg)) return "stop";
  if (DAEMON_STATUS_FLAGS.has(arg)) return "status";
  if (arg === "--ready") return "ready";
  if (arg === "--connected") return "connected";
  return null;
}
