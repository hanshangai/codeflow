import type { EngineType } from "./types/engine.js";
import type { ThreadId, WorkspaceId } from "./types/ids.js";

export type ThreadInputKind = "message" | "provider-slash";
export type EffectiveThreadInputKind = "legacy-auto" | ThreadInputKind;

export type CodexSkillMentionBinding = {
  skillId: string;
  name: string;
  /** UTF-16 range in the sibling text field. */
  start: number;
  end: number;
};

export type ListThreadInputActionsRequestBody = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  trigger: "/" | "$";
};

/** Codex CLI 内建 Slash 命令名；`plan`/`mode` 刻意不在此合同中。 */
export type CodexSlashCommandName =
  | "model"
  | "ide"
  | "permissions"
  | "keymap"
  | "vim"
  | "setup-default-sandbox"
  | "sandbox-add-read-dir"
  | "experimental"
  | "approve"
  | "memories"
  | "skills"
  | "import"
  | "hooks"
  | "review"
  | "rename"
  | "new"
  | "archive"
  | "delete"
  | "resume"
  | "fork"
  | "app"
  | "init"
  | "compact"
  | "goal"
  | "agent"
  | "side"
  | "btw"
  | "copy"
  | "raw"
  | "diff"
  | "mention"
  | "status"
  | "usage"
  | "debug-config"
  | "title"
  | "statusline"
  | "theme"
  | "pets"
  | "mcp"
  | "apps"
  | "plugins"
  | "logout"
  | "quit"
  | "exit"
  | "feedback"
  | "ps"
  | "stop"
  | "clear"
  | "personality"
  | "subagents";

export type CodexSlashCommandVisibility = "public" | "debug";
export type CodexSlashCommandWebSupport = "supported" | "unsupported";

export type CodexSlashCommandDescriptor = {
  command: CodexSlashCommandName;
  token: `/${string}`;
  description: string;
  supportsInlineArgs: boolean;
  availableDuringTask: boolean;
  webSupport: CodexSlashCommandWebSupport;
  visibility?: CodexSlashCommandVisibility;
  aliases?: readonly string[];
  /** CLI 默认空过滤列表中隐藏，但仍可通过完整 token 匹配的别名命令。 */
  hiddenInDefaultPicker?: boolean;
};

type CodexCliDebugSlashCommandDescriptor = Omit<CodexSlashCommandDescriptor, "command"> & {
  command: "rollout" | "test-approval" | "debug-m-drop" | "debug-m-update";
  visibility: "debug";
};

/**
 * Codex CLI 0.146.0 的公开 Slash 命令目录（保持 CLI 的展示顺序）。
 * `/mode`、`/plan` 与 `/fast` 由 Web 现有工具栏或会话模式承接，不加入目录；Web 不实现 `!cmd`。
 */
export const CODEX_CLI_SLASH_COMMANDS: readonly CodexSlashCommandDescriptor[] = [
  { command: "model", token: "/model", description: "选择模型和思考强度", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "ide", token: "/ide", description: "包含 IDE 当前选区、打开文件等上下文", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "permissions", token: "/permissions", description: "选择 Codex 的权限模式", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "keymap", token: "/keymap", description: "重新映射 TUI 快捷键", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported" },
  { command: "vim", token: "/vim", description: "切换 Composer 的 Vim 模式", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "setup-default-sandbox", token: "/setup-default-sandbox", description: "设置默认沙箱", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "sandbox-add-read-dir", token: "/sandbox-add-read-dir", description: "把目录加入沙箱只读范围", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported" },
  { command: "experimental", token: "/experimental", description: "切换实验性功能", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "approve", token: "/approve", description: "批准最近一次自动审查拒绝的重试", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "memories", token: "/memories", description: "配置记忆功能", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "skills", token: "/skills", description: "浏览并选择 Codex Skill", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "import", token: "/import", description: "从 Claude Code 导入设置、项目和近期会话", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "hooks", token: "/hooks", description: "查看和管理生命周期 Hooks", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "review", token: "/review", description: "检查当前变更并查找问题", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported" },
  { command: "rename", token: "/rename", description: "重命名当前会话", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "new", token: "/new", description: "在当前会话中开始一个新聊天", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported" },
  { command: "archive", token: "/archive", description: "归档当前会话并退出", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "delete", token: "/delete", description: "永久删除当前会话并退出", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "resume", token: "/resume", description: "恢复已保存的会话", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "fork", token: "/fork", description: "派生当前会话", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "app", token: "/app", description: "在桌面 App 中继续当前会话", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "init", token: "/init", description: "在工作区生成 AGENTS.md 指南", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "compact", token: "/compact", description: "压缩当前会话上下文", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "goal", token: "/goal", description: "设置或查看长期任务目标", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "agent", token: "/agent", description: "切换当前 Agent 会话", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "side", token: "/side", description: "在临时派生会话中开始旁支对话", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "btw", token: "/btw", description: "在临时派生会话中开始旁支对话", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported", hiddenInDefaultPicker: true },
  { command: "copy", token: "/copy", description: "复制上一条回答（Markdown）", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "raw", token: "/raw", description: "切换便于终端复制的原始滚屏模式", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "diff", token: "/diff", description: "显示当前工作区差异", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "mention", token: "/mention", description: "插入文件引用", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "status", token: "/status", description: "显示当前会话配置和 Token 用量", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "usage", token: "/usage", description: "查看账户用量或使用额度重置帮助", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "debug-config", token: "/debug-config", description: "显示配置层和来源", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "title", token: "/title", description: "配置终端标题显示内容", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "statusline", token: "/statusline", description: "配置状态栏显示内容", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "theme", token: "/theme", description: "选择语法高亮主题", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "pets", token: "/pets", description: "选择或隐藏终端宠物", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported", aliases: ["pet"] },
  { command: "mcp", token: "/mcp", description: "查看已配置的 MCP 工具", supportsInlineArgs: true, availableDuringTask: true, webSupport: "supported" },
  { command: "apps", token: "/apps", description: "管理应用连接器", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "plugins", token: "/plugins", description: "浏览插件", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "logout", token: "/logout", description: "退出 Codex 登录", supportsInlineArgs: false, availableDuringTask: false, webSupport: "supported" },
  { command: "quit", token: "/quit", description: "退出 Codex", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported", hiddenInDefaultPicker: true },
  { command: "exit", token: "/exit", description: "退出 Codex", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "feedback", token: "/feedback", description: "向维护者发送反馈", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "ps", token: "/ps", description: "列出后台进程", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "stop", token: "/stop", description: "停止后台进程", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported", aliases: ["clean"] },
  { command: "clear", token: "/clear", description: "清空终端并开始新对话", supportsInlineArgs: true, availableDuringTask: false, webSupport: "supported" },
  { command: "personality", token: "/personality", description: "选择 Codex 沟通风格", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
  { command: "subagents", token: "/subagents", description: "切换多 Agent 会话", supportsInlineArgs: false, availableDuringTask: true, webSupport: "supported" },
];

/** CLI 仅在 debug 构建中暴露的命令，保留供对照但不进入 Web 生产候选。 */
export const CODEX_CLI_DEBUG_SLASH_COMMANDS: readonly CodexCliDebugSlashCommandDescriptor[] = [
  { command: "rollout", token: "/rollout", description: "输出当前 rollout 文件路径", supportsInlineArgs: false, availableDuringTask: true, webSupport: "unsupported", visibility: "debug" },
  { command: "test-approval", token: "/test-approval", description: "测试审批请求", supportsInlineArgs: false, availableDuringTask: true, webSupport: "unsupported", visibility: "debug" },
  { command: "debug-m-drop", token: "/debug-m-drop", description: "内部记忆维护（仅调试）", supportsInlineArgs: false, availableDuringTask: false, webSupport: "unsupported", visibility: "debug" },
  { command: "debug-m-update", token: "/debug-m-update", description: "内部记忆维护（仅调试）", supportsInlineArgs: false, availableDuringTask: false, webSupport: "unsupported", visibility: "debug" },
];

/** 返回公开命令目录的副本；默认不把 CLI debug 命令暴露给用户。 */
export function listCodexCliSlashCommands(opts?: { includeDebug?: boolean }): CodexSlashCommandDescriptor[] {
  const commands = opts?.includeDebug
    ? [...CODEX_CLI_SLASH_COMMANDS, ...CODEX_CLI_DEBUG_SLASH_COMMANDS]
    : [...CODEX_CLI_SLASH_COMMANDS];
  return commands as CodexSlashCommandDescriptor[];
}

export type ParsedCodexSlashCommand = {
  command: CodexSlashCommandName;
  token: string;
  canonicalToken: `/${CodexSlashCommandName}`;
  args: string;
  trimmedArgs: string;
  rawText: string;
};

export type ThreadInputAction =
  | {
    kind: "slash";
    token: `/${string}`;
    source: "codeflow";
    delivery: "host-action";
    description?: string | null;
    /** Codex CLI canonical name; absent on legacy persisted catalog rows. */
    command?: CodexSlashCommandName;
    supportsInlineArgs?: boolean;
    availableDuringTask?: boolean;
    webSupport?: CodexSlashCommandWebSupport;
    /** CLI 显示名之外的可解析别名，例如 `/clean`。 */
    aliases?: readonly string[];
    /** CLI 默认空过滤列表中隐藏的重复别名（例如 `/quit`、`/btw`）。 */
    hiddenInDefaultPicker?: boolean;
    enabled: boolean;
    disabledReason?: string | null;
  }
  | {
    kind: "slash";
    token: `/${string}`;
    source: "claude";
    delivery: "provider-slash";
    providerName: string;
    description?: string | null;
    isSkill: boolean;
    enabled: boolean;
    disabledReason?: string | null;
  }
  | {
    kind: "codex-skill";
    token: `$${string}`;
    name: string;
    displayName?: string | null;
    skillId: string;
    scope?: string | null;
    sourceLabel: string;
    description?: string | null;
  };

export type ListThreadInputActionsResponseBody = {
  engine: EngineType;
  actions: ThreadInputAction[];
  providerCatalog: {
    state: "ready" | "unavailable";
    observedAt: number | null;
    providerVersion?: string | null;
    message?: string | null;
  };
};

/**
 * Projects the shared Codex CLI directory into host-action DTOs.
 * Runtime state only controls availability; it never removes a command.
 */
export function buildCodexCliSlashInputActions(input: {
  hasConversationHistory?: boolean;
  runningTurnId?: string | null;
  queueLength?: number;
  compactFirst?: boolean;
}): ThreadInputAction[] {
  const descriptors = listCodexCliSlashCommands();
  // CLI 的弹层顺序就是注册表顺序；旧版 Web 曾把 compact 强行置顶，导致
  // 用户误以为候选只有一项。仅在显式传入时保留兼容排序开关。
  if (input.compactFirst === true) {
    descriptors.sort((left, right) => Number(right.command === "compact") - Number(left.command === "compact"));
  }
  return descriptors.map((descriptor) => {
    let disabledReason: string | null = null;
    if (input.runningTurnId && !descriptor.availableDuringTask) {
      disabledReason = "当前 AI 回合运行中不可用";
    }
    if (!disabledReason && Number(input.queueLength ?? 0) > 0 && !descriptor.availableDuringTask) {
      disabledReason = "消息队列清空后才能执行";
    }
    if (!disabledReason && descriptor.command === "resume" && (input.runningTurnId || Number(input.queueLength ?? 0) > 0)) {
      // CLI 将 /resume 视为运行时可发现命令，但在已有 turn 或待发送队列时仍拒绝执行。
      disabledReason = "当前 AI 回合或消息队列未结束，暂不能恢复会话";
    }
    if (descriptor.command === "compact") {
      if (input.hasConversationHistory === false) disabledReason = "当前会话还没有可压缩的上下文";
      else if (input.runningTurnId) disabledReason = "当前 AI 回合结束后才能压缩";
      else if (Number(input.queueLength ?? 0) > 0) disabledReason = "消息队列清空后才能压缩";
    }
    return {
      kind: "slash",
      token: descriptor.token,
      source: "codeflow",
      delivery: "host-action",
      command: descriptor.command,
      supportsInlineArgs: descriptor.supportsInlineArgs,
      availableDuringTask: descriptor.availableDuringTask,
      webSupport: descriptor.webSupport,
      ...(descriptor.aliases?.length ? { aliases: descriptor.aliases } : {}),
      ...(descriptor.hiddenInDefaultPicker ? { hiddenInDefaultPicker: true } : {}),
      description: descriptor.description,
      enabled: disabledReason == null,
      disabledReason,
    };
  });
}

export const CODEX_SKILL_NAME_PATTERN = /^[A-Za-z0-9_:-]+$/u;
export const CODEX_SKILL_ID_PATTERN = /^csk_[A-Za-z0-9_-]{43}$/u;
export const MAX_CODEX_SKILL_MENTIONS = 64;

export type ThreadInputContractErrorCode =
  | "BAD_REQUEST"
  | "CODEX_SKILL_BINDING_INVALID"
  | "PROVIDER_SLASH_CONFLICT";

/** Carries a stable, transport-safe input contract failure. */
export class ThreadInputContractError extends Error {
  readonly name = "ThreadInputContractError";

  constructor(
    readonly code: ThreadInputContractErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type NormalizedThreadInputContract = {
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
};

/** Normalizes only explicitly present wire fields; missing inputKind remains legacy-auto. */
export function normalizeThreadInputContract(
  value: unknown,
  text: string,
): NormalizedThreadInputContract {
  const record = requireRecord(value, "输入合同必须是对象");
  const hasInputKind = Object.prototype.hasOwnProperty.call(record, "inputKind");
  const hasSkillMentions = Object.prototype.hasOwnProperty.call(record, "skillMentions");
  const inputKind = hasInputKind ? normalizeExplicitInputKind(record.inputKind) : undefined;
  const skillMentions = hasSkillMentions
    ? normalizeCodexSkillMentionBindings(record.skillMentions, text)
    : undefined;

  if (skillMentions?.length && inputKind !== "message") {
    throw new ThreadInputContractError(
      "CODEX_SKILL_BINDING_INVALID",
      "Skill binding 必须显式使用 message 输入类型",
    );
  }
  return {
    ...(inputKind ? { inputKind } : {}),
    ...(skillMentions?.length ? { skillMentions } : {}),
  };
}

/** Validates a wire inputKind without treating null or unknown values as missing. */
export function normalizeExplicitInputKind(value: unknown): ThreadInputKind {
  if (value === "message" || value === "provider-slash") return value;
  throw new ThreadInputContractError("BAD_REQUEST", "inputKind 只允许 message 或 provider-slash");
}

/** Validates opaque bindings against the exact sibling text and token boundaries. */
export function normalizeCodexSkillMentionBindings(
  value: unknown,
  text: string,
): CodexSkillMentionBinding[] | undefined {
  if (!Array.isArray(value)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "skillMentions 必须是数组");
  }
  if (value.length === 0) return undefined;
  if (value.length > MAX_CODEX_SKILL_MENTIONS) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 数量超过限制");
  }

  const normalized = value.map((item, index) => normalizeBinding(item, text, index));
  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index]!.start < normalized[index - 1]!.end) {
      throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 范围不能重叠");
    }
  }
  return normalized;
}

/** Resolves the old missing-field behavior from the final provider text and images. */
export function resolveLegacyEffectiveInputKind(
  providerText: string,
  images: readonly unknown[],
): Exclude<EffectiveThreadInputKind, "legacy-auto"> {
  return String(providerText).trim().startsWith("/") && images.length === 0
    ? "provider-slash"
    : "message";
}

export type RawSlashToken = {
  start: 0;
  end: number;
  token: string;
  query: string;
};

/**
 * Parses one complete, single-line Codex CLI Slash invocation.
 * Unknown commands, excluded `/plan`/`/mode`/`/fast`, and invalid inline arguments
 * intentionally return null so the caller can keep the normal prompt path.
 */
export function parseCodexSlashCommand(text: string): ParsedCodexSlashCommand | null {
  const rawText = String(text ?? "");
  if (!rawText || rawText[0] !== "/" || /[\r\n]/u.test(rawText)) return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(rawText);
  if (!match) return null;
  const entered = match[1]!;
  const descriptor = findCodexSlashCommandDescriptor(entered);
  if (!descriptor || descriptor.visibility === "debug") return null;
  const args = match[2] ?? "";
  // CLI 会把只包含尾随空白的参数视为裸命令；真正的参数仍按命令声明校验。
  if (args.trim().length > 0 && !descriptor.supportsInlineArgs) return null;
  return {
    command: descriptor.command,
    token: `/${entered}`,
    canonicalToken: descriptor.token as `/${CodexSlashCommandName}`,
    args,
    trimmedArgs: args.trim(),
    rawText,
  };
}

/** 判断候选是否可由鼠标或键盘执行；Skill binding 本身没有 enabled 字段。 */
export function isThreadInputActionEnabled(action: ThreadInputAction): boolean {
  return action.kind === "codex-skill" || action.enabled;
}

/** 返回第一个可执行候选的索引；没有可执行项时返回 -1。 */
export function findFirstEnabledThreadInputActionIndex(actions: readonly ThreadInputAction[]): number {
  return actions.findIndex((action) => isThreadInputActionEnabled(action));
}

/** 在候选列表中循环移动，并跳过 disabled 项；没有可执行项时保留当前索引。 */
export function moveThreadInputActionSelection(
  actions: readonly ThreadInputAction[],
  currentIndex: number,
  delta: number,
): number {
  if (!actions.length || !actions.some((action) => isThreadInputActionEnabled(action))) return currentIndex;
  const direction = delta < 0 ? -1 : 1;
  let index = Number.isInteger(currentIndex) ? currentIndex : findFirstEnabledThreadInputActionIndex(actions);
  for (let step = 0; step < actions.length; step += 1) {
    index = (index + direction + actions.length) % actions.length;
    if (isThreadInputActionEnabled(actions[index]!)) return index;
  }
  return currentIndex;
}

/** Returns the canonical command for an exact local invocation. */
export function resolveCodexHostInputAction(text: string): CodexSlashCommandName | null {
  return parseCodexSlashCommand(text)?.command ?? null;
}

/** Looks up a CLI command or its canonical `/clean` alias. */
export function findCodexSlashCommandDescriptor(command: string): CodexSlashCommandDescriptor | null {
  const normalized = String(command ?? "").replace(/^\//u, "");
  const direct = CODEX_CLI_SLASH_COMMANDS.find((item) => item.command === normalized);
  if (direct) return direct;
  const alias = CODEX_CLI_SLASH_COMMANDS.find((item) => item.aliases?.includes(normalized));
  if (alias) return alias;
  // CLI 为 `/goal` 保留了可拉长的 `goooal` 兼容拼写；只接受 ASCII `o`，
  // 避免把其他未知 Slash 误判成本地动作。
  if (/^go+al$/u.test(normalized)) {
    return CODEX_CLI_SLASH_COMMANDS.find((item) => item.command === "goal") ?? null;
  }
  return null;
}

/** Reads the first raw single-line Slash token without trimming the input. */
export function findRawSlashToken(text: string, cursor = text.length): RawSlashToken | null {
  if (text[0] !== "/" || text.includes("\n") || text.includes("\r")) return null;
  const firstWhitespace = text.search(/\s/u);
  const end = firstWhitespace < 0 ? text.length : firstWhitespace;
  const boundedCursor = clampCursor(cursor, text.length);
  if (boundedCursor < 1 || boundedCursor > end) return null;
  const token = text.slice(0, end);
  return { start: 0, end, token, query: text.slice(1, boundedCursor) };
}

export type CodexSkillPickerToken = {
  start: number;
  end: number;
  query: string;
};

/** Locates the whitespace-delimited $ token containing the textarea cursor. */
export function findCodexSkillPickerToken(
  text: string,
  cursor = text.length,
): CodexSkillPickerToken | null {
  const boundedCursor = clampCursor(cursor, text.length);
  let start = boundedCursor - 1;
  while (start >= 0 && !/\s/u.test(text[start]!)) start -= 1;
  start += 1;
  if (text[start] !== "$") return null;
  if (start > 0 && !/\s/u.test(text[start - 1]!)) return null;

  let end = start + 1;
  while (end < text.length && CODEX_SKILL_NAME_PATTERN.test(text[end]!)) end += 1;
  if (boundedCursor < start + 1 || boundedCursor > end) return null;
  const query = text.slice(start + 1, boundedCursor);
  // 与 Codex CLI 的 shell 参数判定保持一致：纯数字是 `$1`/`$100` 等位置参数，
  // 但包含字母的数字开头名称仍可能是合法 Skill（例如 `$1password`）。
  if (text[start + 1] === "{" || /^\d+$/u.test(query)) return null;
  if (query && !CODEX_SKILL_NAME_PATTERN.test(query)) return null;
  return { start, end, query };
}

/** Re-bases bindings through one textarea edit and drops any touched token. */
export function rebaseCodexSkillMentionsAfterEdit(
  previousText: string,
  nextText: string,
  bindings: readonly CodexSkillMentionBinding[] | undefined,
): CodexSkillMentionBinding[] | undefined {
  if (!bindings?.length) return undefined;
  const prefix = commonPrefixLength(previousText, nextText);
  const suffix = commonSuffixLength(previousText, nextText, prefix);
  const previousEditEnd = previousText.length - suffix;
  const nextEditEnd = nextText.length - suffix;
  const delta = nextEditEnd - previousEditEnd;

  const rebased: CodexSkillMentionBinding[] = [];
  for (const binding of bindings) {
    let candidate: CodexSkillMentionBinding | null = null;
    if (previousEditEnd <= binding.start) {
      candidate = { ...binding, start: binding.start + delta, end: binding.end + delta };
    } else if (prefix >= binding.end) {
      candidate = { ...binding };
    }
    if (candidate && isBindingValid(candidate, nextText)) rebased.push(candidate);
  }
  return rebased.length ? rebased : undefined;
}

/** Replaces a picker token and records the selected opaque binding. */
export function insertCodexSkillMention(input: {
  text: string;
  bindings?: readonly CodexSkillMentionBinding[];
  replaceStart: number;
  replaceEnd: number;
  skillId: string;
  name: string;
}): { text: string; caret: number; skillMentions: CodexSkillMentionBinding[] } {
  const replaceStart = clampCursor(input.replaceStart, input.text.length);
  const replaceEnd = clampCursor(input.replaceEnd, input.text.length);
  if (replaceEnd < replaceStart || !CODEX_SKILL_NAME_PATTERN.test(input.name)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill mention 插入参数非法");
  }
  if (!CODEX_SKILL_ID_PATTERN.test(input.skillId)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 标识非法");
  }
  const token = `$${input.name}`;
  const nextText = `${input.text.slice(0, replaceStart)}${token}${input.text.slice(replaceEnd)}`;
  const rebased = rebaseCodexSkillMentionsAfterEdit(input.text, nextText, input.bindings) ?? [];
  rebased.push({
    skillId: input.skillId,
    name: input.name,
    start: replaceStart,
    end: replaceStart + token.length,
  });
  const normalized = normalizeCodexSkillMentionBindings(rebased, nextText);
  if (!normalized) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill mention 插入结果为空");
  }
  return { text: nextText, caret: replaceStart + token.length, skillMentions: normalized };
}

/** Trims ordinary message text and shifts bindings to the final display-text range. */
export function trimThreadTextWithSkillMentions(
  text: string,
  bindings?: readonly CodexSkillMentionBinding[],
): { text: string; skillMentions?: CodexSkillMentionBinding[] } {
  const trimmed = text.trim();
  if (!bindings?.length) return { text: trimmed };
  const leading = text.length - text.trimStart().length;
  const shifted = bindings.map((binding) => ({
    ...binding,
    start: binding.start - leading,
    end: binding.end - leading,
  }));
  return {
    text: trimmed,
    skillMentions: normalizeCodexSkillMentionBindings(shifted, trimmed),
  };
}

function normalizeBinding(item: unknown, text: string, index: number): CodexSkillMentionBinding {
  const record = requireRecord(item, `skillMentions[${index}] 必须是对象`);
  const skillId = String(record.skillId ?? "");
  const name = String(record.name ?? "");
  const start = record.start;
  const end = record.end;
  if (!CODEX_SKILL_ID_PATTERN.test(skillId)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 标识非法");
  }
  if (!name || name.length > 128 || !CODEX_SKILL_NAME_PATTERN.test(name)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 名称非法");
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 范围必须是整数");
  }
  const binding = { skillId, name, start: Number(start), end: Number(end) };
  if (!isBindingValid(binding, text)) {
    throw new ThreadInputContractError("CODEX_SKILL_BINDING_INVALID", "Skill binding 与正文不匹配");
  }
  return binding;
}

function isBindingValid(binding: CodexSkillMentionBinding, text: string): boolean {
  if (binding.start < 0 || binding.end <= binding.start || binding.end > text.length) return false;
  if (text.slice(binding.start, binding.end) !== `$${binding.name}`) return false;
  if (binding.start > 0 && !/\s/u.test(text[binding.start - 1]!)) return false;
  const next = text[binding.end];
  return next == null || !CODEX_SKILL_NAME_PATTERN.test(next);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadInputContractError("BAD_REQUEST", message);
  }
  return value as Record<string, unknown>;
}

function clampCursor(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : max));
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const max = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < max && left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1;
  return length;
}
