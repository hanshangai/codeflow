import type { AccessMode, SessionId } from "@codeflowai/shared";
import type { ConversationProfile } from "../threadSession.js";
import {
  assertRuntimeEngineModelAvailable,
  getRuntimeEngineModelInfo,
} from "../engineModelCatalogRuntime.js";
import { normalizeThreadContextWindow } from "@codeflowai/shared";
import path from "node:path";

import { resolveWindowsNpmCli } from "../utils/windowsNpmCli.js";
import { privateCliEngineRoot, readPrivateCliRuntimeEntry } from "../../cli-runtime/privateCliPaths.js";

const CLAUDE_DEEPSEEK_V4_PRO_TRANSPORT_MODEL = "deepseek-v4-pro[1m]";
const CLAUDE_DEEPSEEK_FLASH_TRANSPORT_MODEL = "deepseek-flash[1m]";
const CLAUDE_SINGLE_MODEL_PROVIDER_PREFIXES = ["deepseek-flash", "deepseek-v4-flash", "kimi-", "glm-", "qwen"] as const;
const CLAUDE_REQUIRED_THINKING_MODELS = new Set([
  "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "glm-5.3", "glm-5.3-flash",
]);

/** 固定 Claude Code prompt cache 为 1h，并关闭所有已知冲突开关。 */
export const CLAUDE_FIXED_PROMPT_CACHING_ENV = {
  ENABLE_PROMPT_CACHING_1H: "1",
  FORCE_PROMPT_CACHING_5M: "0",
  DISABLE_PROMPT_CACHING: "0",
  DISABLE_PROMPT_CACHING_HAIKU: "0",
  DISABLE_PROMPT_CACHING_SONNET: "0",
  DISABLE_PROMPT_CACHING_OPUS: "0",
  DISABLE_PROMPT_CACHING_FABLE: "0",
  DISABLE_PROMPT_CACHING_MYTHOS: "0",
} as const;

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  // Pro 与视觉兼容入口固定为 1M；Flash 已按目录 1M 窗口自动补 [1m]（见 resolveClaudeLaunchModelId），无需别名。
  "deepseek-v4-pro": CLAUDE_DEEPSEEK_V4_PRO_TRANSPORT_MODEL,
  "deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision-exp[1m]",
  // 4.6 系列无日期后缀，短名即为正式 model ID，无需别名
};

/**
 * 解析 Claude CLI 的启动命令。
 *
 * 应用私有运行时记录存在时优先使用其中的原生二进制路径，即使文件缺失也照常返回，
 * 让后续检测边界显式失败而不是静默回退系统 CLI；runtime.json 非法时错误向上抛出。
 * 未安装私有运行时时保持 Windows 包内真实入口 / 非 Windows 裸命令的既有行为。
 */
export function resolveClaudeCli(env: NodeJS.ProcessEnv = process.env): { command: string; argsPrefix: string[]; label: string } {
  const runtimeRoot = String(env.CODEFLOWAI_CLI_RUNTIME_ROOT ?? "").trim();
  if (runtimeRoot) {
    const entry = readPrivateCliRuntimeEntry(runtimeRoot, "claude");
    if (entry) {
      return {
        command: path.resolve(privateCliEngineRoot(runtimeRoot, "claude"), entry.binPath),
        argsPrefix: [],
        label: "claude (private)",
      };
    }
  }
  if (process.platform === "win32") {
    const resolved = resolveWindowsNpmCli("claude", [
      // 旧版 npm 包：Node 入口脚本。
      "node_modules\\@anthropic-ai\\claude-code\\cli.js",
      // 新版 npm 包：postinstall 后的原生二进制。
      "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      // postinstall 未写回 bin 时，仍可通过 wrapper 直接定位原生包。
      "node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs",
    ]);
    return { command: resolved.command, argsPrefix: resolved.argsPrefix, label: "claude" };
  }
  return { command: "claude", argsPrefix: [], label: "claude" };
}

export function shouldClaudeUseInterceptablePermissions(
  conversationProfile: ConversationProfile | null | undefined,
): boolean {
  return conversationProfile === "orchestration";
}

export function resolveClaudePermissionLaunchMode(opts: {
  planMode: boolean;
  accessMode: AccessMode;
  conversationProfile?: ConversationProfile | null;
}): { permissionMode: "plan" | "default" | "acceptEdits" | null; dangerouslySkipPermissions: boolean } {
  if (opts.planMode) {
    return { permissionMode: "plan", dangerouslySkipPermissions: false };
  }
  if (opts.accessMode === "full-access") {
    return { permissionMode: null, dangerouslySkipPermissions: true };
  }
  if (opts.accessMode === "read-only" && shouldClaudeUseInterceptablePermissions(opts.conversationProfile)) {
    // Claude 当前没有“保留原生工具且强只读”的独立 permission mode。
    // 编排 read-only 节点只能退化为 default，并依赖 system prompt 继续强调只读纪律。
    return { permissionMode: "default", dangerouslySkipPermissions: false };
  }
  if (opts.accessMode === "read-only") {
    return { permissionMode: "plan", dangerouslySkipPermissions: false };
  }
  return { permissionMode: "acceptEdits", dangerouslySkipPermissions: false };
}

/** 归一化 Claude `--model`：兼容历史 short code 和 provider transport 标记。 */
export function resolveClaudeLaunchModelId(model: string | null | undefined, contextWindow?: number | null): string | null {
  const s = String(model ?? "").trim();
  if (!s) return null;
  assertRuntimeEngineModelAvailable("claude", s);
  const launchModel = CLAUDE_MODEL_ALIASES[s] || s;
  // 原生 1M 模型也显式标记窗口，确保网关接入不会仍按 200K 预算。
  const info = getRuntimeEngineModelInfo("claude", s);
  const window = Number(resolveClaudeContextWindow(s, contextWindow));
  if (!launchModel.endsWith("[1m]") && (
    info?.contextWindow === 1_000_000 || window === 1_000_000
    || (info?.providerId === "anthropic" && window > 200_000)
  )) {
    return `${launchModel}[1m]`;
  }
  return launchModel;
}

/** 生成本轮模型环境；单模型 provider 的主任务与子任务均使用所选模型。 */
export function resolveClaudeModelRuntimeEnv(model: string | null | undefined, contextWindow?: number | null): Record<string, string> {
  const launchModel = resolveClaudeLaunchModelId(model, contextWindow);
  if (!launchModel) return {};
  if (isSingleModelClaudeProviderModel(launchModel)) return buildSingleModelProviderRuntimeEnv(launchModel);
  if (launchModel !== CLAUDE_DEEPSEEK_V4_PRO_TRANSPORT_MODEL) return {};

  return {
    ...buildSingleModelProviderRuntimeEnv(launchModel),
    // Pro 仍受官方支持；后台快速任务改用正式 Flash ID，不再依赖退役别名。
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_DEEPSEEK_FLASH_TRANSPORT_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_DEEPSEEK_FLASH_TRANSPORT_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_DEEPSEEK_FLASH_TRANSPORT_MODEL,
  };
}

/** 判断是否为官方兼容层中按单模型接入 Claude Code 的 provider 模型。 */
function isSingleModelClaudeProviderModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return CLAUDE_SINGLE_MODEL_PROVIDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** 构造单模型兼容 provider 的 Claude Code 环境，避免子任务回落到 Anthropic 默认模型。 */
export function buildSingleModelProviderRuntimeEnv(model: string): Record<string, string> {
  return {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_REASONING_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/** 使用目录最大窗口，历史请求窗口不再覆盖模型能力。 */
function resolveClaudeContextWindow(model: string, requested?: number | null): number | null {
  const models = [getRuntimeEngineModelInfo("claude", model)].filter((item) => item != null);
  return normalizeThreadContextWindow("claude", model, requested, models);
}

/** 将模型窗口与强制思考要求同时注入进程和 flag settings，覆盖本地残留配置。 */
export function resolveClaudeModelSettingsEnv(model: string | null | undefined, contextWindow?: number | null): Record<string, string> {
  const launchModel = resolveClaudeLaunchModelId(model, contextWindow);
  if (!launchModel) return {};
  const env: Record<string, string> = {};
  const window = resolveClaudeContextWindow(String(model ?? "").trim(), contextWindow);
  if (window != null) {
    // Claude Code 的自动压缩窗口配置接受 100K–1M，实际值还会受模型上下文上限约束。
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(1_000_000, Math.max(100_000, window)));
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT = window <= 200_000 ? "1" : "0";
    if (!launchModel.startsWith("claude-")) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
  }
  const baseModel = launchModel.replace(/\[1m\]$/, "");
  if (CLAUDE_REQUIRED_THINKING_MODELS.has(baseModel)) {
    // 未识别模型默认输出上限为 32K；正预算开启思考，避免本地 0/关闭配置导致 K2.7 返回 400。
    env.MAX_THINKING_TOKENS = "31999";
    // Claude Code 2.1.268 的 Anthropic 兼容通道不读取 family 的 SUPPORTED_CAPABILITIES。
    // 使用实际 CLI 支持的逐模型能力覆盖：发送 enabled 思考，并阻止 K2.7 自动附带 effort。
    const hasEffort = Boolean(getRuntimeEngineModelInfo("claude", model)?.supportedReasoningEfforts?.length);
    env.CLAUDE_CODE_MODEL_CAPABILITIES = `${baseModel}=thinking,interleaved_thinking,-adaptive_thinking,-xhigh_effort,${hasEffort ? "effort,max_effort" : "-effort,-max_effort"}`;
    env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "0";
  }
  return env;
}

/** 显式 effort 优先，否则使用目录默认值；合法性由 Client 统一入口严格校验。 */
export function resolveClaudeLaunchEffort(model: string | null | undefined, effort: string | null | undefined): string | null {
  const s = String(effort ?? "").trim();
  if (s) return s;
  const modelId = String(model ?? "").trim();
  if (!modelId) return null;
  const info = getRuntimeEngineModelInfo("claude", modelId);
  return info?.defaultReasoningEffort ?? null;
}

/**
 * 构造 Claude 的长驻 stream-json 参数（支持 resume）。
 *
 * stream-json 会话由 Client 自己持有 stdin 生命周期，因此不使用 `-p`。
 * `-p` 是一次性 Print 模式，Desktop/Agent SDK 使用的是同一套交互协议。
 */
export function buildClaudeArgs(opts: {
  text: string;
  sessionId: SessionId | null;
  planMode: boolean;
  accessMode: AccessMode;
  conversationProfile?: ConversationProfile | null;
  model?: string | null;
  effort?: string | null;
  contextWindow?: number | null;
  inputFormat: "text" | "stream-json";
  autoCompactPct?: number | null;
  appendSystemPrompt?: string | null;
  appendSystemPromptFilePath?: string | null;
  mcpConfigPath?: string | null;
  strictMcpConfig?: boolean;
}): string[] {
  const args: string[] = [];
  if (opts.inputFormat === "stream-json") {
    // 真实内容持续从 stdin 写入；不要传 -p 或占位 prompt。
    args.push("--input-format", "stream-json");
  } else {
    args.push("-p");
    args.push(opts.text);
  }

  // Claude Code：stream-json 输出必须开启 verbose，才能得到完整事件流。
  args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  // 让追加输入在被 CLI 消费时回显 UUID，避免迟到的旧 result 提前关闭 stdin。
  if (opts.inputFormat === "stream-json") args.push("--replay-user-messages");

  const permissionLaunchMode = resolveClaudePermissionLaunchMode({
    planMode: opts.planMode,
    accessMode: opts.accessMode,
    conversationProfile: opts.conversationProfile,
  });

  if (permissionLaunchMode.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (permissionLaunchMode.permissionMode) {
    args.push("--permission-mode", permissionLaunchMode.permissionMode);
  }

  // stdio 权限通道：权限请求通过 stdout stream-json 输出，响应通过 stdin 写回（与 VS Code 扩展 / Agent SDK 同机制）。
  // AskUserQuestion 依赖这条双向通道；其他 permission request 也通过这里回写真实 allow/deny 结果。
  args.push("--permission-prompt-tool", "stdio");

  const model = resolveClaudeLaunchModelId(opts.model, opts.contextWindow);
  if (model) args.push("--model", model);
  const effort = resolveClaudeLaunchEffort(opts.model, opts.effort);
  if (effort) args.push("--effort", effort);
  if (opts.sessionId) args.push("--resume", opts.sessionId);

  // AIDT 模式规则注入：优先通过文件注入，避免 Windows 命令行长度限制。
  // 不污染 user message，避免对话历史中每条消息都重复规则块、浪费 token 并影响压缩效果。
  const sysPromptFilePath = String(opts.appendSystemPromptFilePath ?? "").trim();
  if (sysPromptFilePath) {
    args.push("--append-system-prompt-file", sysPromptFilePath);
  } else {
    const sysPrompt = String(opts.appendSystemPrompt ?? "").trim();
    if (sysPrompt) args.push("--append-system-prompt", sysPrompt);
  }

  const mcpConfigPath = String(opts.mcpConfigPath ?? "").trim();
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    if (opts.strictMcpConfig) args.push("--strict-mcp-config");
  }

  // Flag settings 晚于用户 settings.env 生效，确保缓存、模型能力与窗口不被本地配置改写。
  const settingsEnv: Record<string, string> = {
    ...CLAUDE_FIXED_PROMPT_CACHING_ENV,
    ...resolveClaudeModelRuntimeEnv(opts.model, opts.contextWindow),
    ...resolveClaudeModelSettingsEnv(opts.model, opts.contextWindow),
  };
  if (effort) settingsEnv.CLAUDE_CODE_EFFORT_LEVEL = effort;
  if (typeof opts.autoCompactPct === "number" && opts.autoCompactPct >= 50 && opts.autoCompactPct <= 99) {
    settingsEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(opts.autoCompactPct);
  }
  args.push("--settings", JSON.stringify({ env: settingsEnv }));

  return args;
}

/** 安全读取 uid/euid：仅用于判断 Unix 提权上下文，读取失败时按未知处理。 */
function safeReadUnixIdentity(read?: (() => number) | null): number | null {
  if (typeof read !== "function") return null;
  try {
    const value = read();
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** 判断是否需要为 Claude bypassPermissions 启动补齐 `IS_SANDBOX=1`。 */
export function shouldClaudeForceSandboxEnv(opts: {
  dangerouslySkipPermissions: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | null;
  geteuid?: (() => number) | null;
}): boolean {
  if (!opts.dangerouslySkipPermissions) return false;
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return false;

  const env = opts.env ?? process.env;
  if (String(env.IS_SANDBOX ?? "").trim()) return false;

  const uid = safeReadUnixIdentity(
    opts.getuid !== undefined
      ? opts.getuid
      : typeof process.getuid === "function"
        ? process.getuid.bind(process)
        : null,
  );
  const euid = safeReadUnixIdentity(
    opts.geteuid !== undefined
      ? opts.geteuid
      : typeof process.geteuid === "function"
        ? process.geteuid.bind(process)
        : null,
  );
  if (uid === 0 || euid === 0) return true;
  if (uid !== null || euid !== null) return false;

  return [
    env.SUDO_USER,
    env.SUDO_UID,
    env.SUDO_COMMAND,
  ].some((value) => Boolean(String(value ?? "").trim()));
}

