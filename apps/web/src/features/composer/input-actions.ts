import {
  buildCodexCliSlashInputActions,
  findCodexSlashCommandDescriptor,
  parseCodexSlashCommand,
  trimThreadTextWithSkillMentions,
  type CodexSkillMentionBinding,
  type CodexSlashCommandName,
  type EngineType,
  type ThreadInputAction,
  type ThreadInputKind,
} from "@codeflowai/shared";

export type ComposerInputSubmission =
  | {
    mode: "host-action";
    action: CodexSlashCommandName;
    rawText: string;
    /** 保留 CLI inline args 的原始空白；无参数命令省略该字段。 */
    args?: string;
    trimmedArgs?: string;
  }
  | { mode: "provider-slash"; text: string; inputKind: "provider-slash" }
  | {
    mode: "message";
    text: string;
    inputKind?: ThreadInputKind;
    skillMentions?: CodexSkillMentionBinding[];
  };

export type CodexResumeCandidate = {
  id: string | number;
  title?: string | null;
  engine?: EngineType | null;
};

export type ComposerInputContractState = {
  inputKind?: ThreadInputKind;
  skillMentions?: CodexSkillMentionBinding[];
};

/** 限定 V1 输入动作只在主 Web 的普通聊天会话启用。 */
export function isComposerInputActionsEnabled(input: {
  surface: "default" | "h5";
  threadType?: string | null;
  threadSubtype?: string | null;
}): boolean {
  return input.surface === "default"
    && Boolean(input.threadType)
    && input.threadType !== "orchestration"
    && input.threadSubtype == null;
}

/** 用户实际编辑后重算显式 wire 语义，普通无歧义输入继续省略字段。 */
export function resolveEditedComposerInputKind(input: {
  enabled: boolean;
  engine: EngineType;
  rawText: string;
  skillMentions?: readonly CodexSkillMentionBinding[];
}): ThreadInputKind | undefined {
  if (!input.enabled) return undefined;
  if (input.rawText[0] === "/") return input.engine === "claude" ? "provider-slash" : "message";
  // 保留原始首字符语义：trim 后像 Slash 的文本必须显式标记为普通消息，
  // 防止旧 Client 的 legacy resolver 再次把它升级为 Provider Slash。
  if (input.rawText.trimStart().startsWith("/")) return "message";
  if (input.engine === "codex" && input.skillMentions?.length) return "message";
  return undefined;
}

/** Reconciles persisted input fields with the current engine, scope and raw text. */
export function reconcileComposerInputContract(input: {
  enabled: boolean;
  engine: EngineType;
  rawText: string;
  inputKind?: ThreadInputKind;
  skillMentions?: readonly CodexSkillMentionBinding[];
}): ComposerInputContractState {
  if (!input.enabled) return {};

  const rawText = String(input.rawText ?? "");
  const leadingTrimmedSlash = rawText[0] !== "/" && rawText.trimStart().startsWith("/");
  let inputKind = input.inputKind;
  let skillMentions = input.engine === "codex" && input.skillMentions?.length
    ? input.skillMentions.map((binding) => ({ ...binding }))
    : undefined;

  if (input.engine === "codex") {
    // Provider Slash 只属于 Claude；过期字段不能随 Codex 草稿继续透传。
    if (inputKind === "provider-slash") inputKind = undefined;
    if (rawText[0] === "/" || leadingTrimmedSlash || skillMentions?.length) inputKind = "message";
  } else {
    // Claude 的 provider-slash 只能由原始首字符 `/` 触发。
    if (inputKind === "provider-slash" && rawText[0] !== "/") inputKind = undefined;
    if (rawText[0] === "/" && inputKind !== "message") inputKind = "provider-slash";
    if (leadingTrimmedSlash) inputKind = "message";
    skillMentions = undefined;
  }

  return {
    ...(inputKind ? { inputKind } : {}),
    ...(skillMentions?.length ? { skillMentions } : {}),
  };
}

/** 冻结最终显示正文与输入合同，并在普通发送前识别 Codex CLI 本地命令。 */
export function resolveComposerInputSubmission(input: {
  enabled: boolean;
  engine: EngineType;
  rawText: string;
  inputKind?: ThreadInputKind;
  skillMentions?: readonly CodexSkillMentionBinding[];
}): ComposerInputSubmission {
  const contract = reconcileComposerInputContract(input);
  if (input.enabled && input.engine === "codex") {
    const parsed = parseCodexSlashCommand(input.rawText);
    if (parsed) {
      return {
        mode: "host-action",
        action: parsed.command,
        rawText: input.rawText,
        ...(parsed.trimmedArgs
          ? { args: parsed.args, trimmedArgs: parsed.trimmedArgs }
          : {}),
      };
    }
  }
  if (input.enabled && input.engine === "claude" && contract.inputKind === "provider-slash") {
    return { mode: "provider-slash", text: input.rawText, inputKind: "provider-slash" };
  }

  const normalized = trimThreadTextWithSkillMentions(
    input.rawText,
    contract.skillMentions,
  );
  const inputKind = normalized.skillMentions?.length ? "message" : contract.inputKind;
  return {
    mode: "message",
    text: normalized.text,
    ...(inputKind ? { inputKind } : {}),
    ...(normalized.skillMentions?.length ? { skillMentions: normalized.skillMentions } : {}),
  };
}

/** 构造完整 Codex CLI Slash 目录，并投影当前 Web 可执行状态。 */
export function buildCodexSlashInputActions(input: {
  hasConversationHistory: boolean;
  runningTurnId: string | null;
  queueLength: number;
}): ThreadInputAction[] {
  return buildCodexCliSlashInputActions(input);
}

/** 按 Codex CLI 的 exact→prefix 顺序过滤 Slash；Skill/Provider 候选保留子串搜索。 */
export function filterComposerInputActions(
  actions: readonly ThreadInputAction[],
  query: string,
): ThreadInputAction[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    // Codex CLI 的空过滤列表隐藏重复别名（/quit、/btw），但输入别名字符后仍可检索。
    return actions.filter((action) => !(
      action.kind === "slash"
      && action.source === "codeflow"
      && action.hiddenInDefaultPicker
    ));
  }
  const exact: ThreadInputAction[] = [];
  const prefix: ThreadInputAction[] = [];
  const contains: ThreadInputAction[] = [];
  for (const action of actions) {
    const aliases = action.kind === "slash" && action.source === "codeflow" ? action.aliases ?? [] : [];
    const values = [action.token.slice(1), ...aliases].map((value) => value.toLocaleLowerCase());
    const isExact = values.some((value) => value === normalizedQuery);
    const isPrefix = values.some((value) => value.startsWith(normalizedQuery));
    const isContains = values.some((value) => value.includes(normalizedQuery));
    if (isExact) exact.push(action);
    else if (isPrefix) prefix.push(action);
    else if (action.kind === "codex-skill" && isContains) contains.push(action);
  }
  return [...exact, ...prefix, ...contains];
}

/** 按 Codex CLI 的恢复选择习惯匹配 ID、标题精确值，再回退到标题模糊匹配。 */
export function findCodexResumeTarget<T extends CodexResumeCandidate>(
  candidates: readonly T[],
  query: string,
  currentThreadId?: string | number | null,
): T | null {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) return null;
  const currentId = currentThreadId == null ? null : String(currentThreadId);
  const available = candidates.filter((candidate) => (
    (candidate.engine == null || candidate.engine === "codex")
    && (currentId == null || String(candidate.id) !== currentId)
  ));
  const exactId = available.find((candidate) => String(candidate.id) === normalizedQuery);
  if (exactId) return exactId;
  const normalizedTitle = normalizedQuery.toLocaleLowerCase();
  const exactTitle = available.find((candidate) => String(candidate.title ?? "").trim().toLocaleLowerCase() === normalizedTitle);
  if (exactTitle) return exactTitle;
  return available.find((candidate) => String(candidate.title ?? "").trim().toLocaleLowerCase().includes(normalizedTitle)) ?? null;
}

/** 返回候选来源标签，同名 Skill 依靠 Client 给出的 sourceLabel 区分。 */
export function describeComposerInputAction(action: ThreadInputAction): string {
  if (action.kind === "codex-skill") return action.sourceLabel;
  if (action.source === "codeflow") return action.enabled ? "Codex CLI" : "Codex CLI · 不可用";
  return action.isSkill ? "Claude Skill" : "Claude 命令";
}

/** 对 host action 与 Provider Slash 做可即时判断的无副作用冲突预检。 */
export function validateComposerActionSubmission(input: {
  submission: ComposerInputSubmission;
  hasRole: boolean;
  imageCount: number;
  fileCount: number;
  pathReferenceCount: number;
  skillMentionCount: number;
  runningTurnId: string | null;
  queueLength: number;
}): string | null {
  if (input.submission.mode === "message") return null;
  const actionLabel = input.submission.mode === "host-action" ? "该本地命令" : "Provider Slash";
  // Codex 公开命令均由 Composer 映射到 Web 行为；运行态冲突在下方统一裁决。
  if (input.submission.mode === "provider-slash"
    && (input.submission.text.includes("\n") || input.submission.text.includes("\r"))) {
    return "Provider Slash 仅支持单行输入";
  }
  if (input.hasRole
    || input.imageCount > 0
    || input.fileCount > 0
    || input.pathReferenceCount > 0
    || input.skillMentionCount > 0) {
    return `${actionLabel}不能同时携带角色、附件、路径引用或 Skill binding`;
  }
  if (input.runningTurnId) {
    const command = input.submission.mode === "host-action"
      ? findCodexSlashCommandDescriptor(input.submission.action)
      : null;
    if (command?.command === "resume") return `${actionLabel}不能在 AI 回合运行中执行`;
    if (!command?.availableDuringTask) return `${actionLabel}不能在 AI 回合运行中执行`;
  }
  if (input.queueLength > 0) {
    const command = input.submission.mode === "host-action"
      ? findCodexSlashCommandDescriptor(input.submission.action)
      : null;
    if (command?.command === "resume") return `${actionLabel}不能在消息队列非空时执行`;
    if (!command?.availableDuringTask) return `${actionLabel}不能在消息队列非空时执行`;
  }
  return null;
}
