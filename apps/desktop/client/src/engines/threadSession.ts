import type {
  AccessMode,
  CodexSkillMentionBinding,
  CodexServiceTier,
  ConversationEventInput,
  EngineType,
  EngineCallTrace,
  ExecutableToolRegistry,
  ItemId,
  ListThreadInputActionsResponseBody,
  RawEngineEventInput,
  SessionId,
  ThreadId,
  ThreadInputKind,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";
import type { SharedWorkspaceToolExecutionContext } from "../app/sharedWorkspaceToolPolicy.js";
import { types } from "node:util";
import { createHash } from "node:crypto";
import type { WorkspaceLogEntry } from "../logger.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";

export type EngineWorkspaceLogWriter = (workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => void;
const engineWorkspaceLogFailure = Symbol("engine-workspace-log-failure");

/** 会话异步边界用自产标记区分诊断失败；保留包括 falsy 在内的原抛值。 */
export function createEngineWorkspaceLogFailure(reason: unknown): AggregateError {
  const failure = Object.assign(new AggregateError([reason], "引擎工作区诊断或固定日志失败", { cause: reason }), {
    code: "ENGINE_WORKSPACE_LOG_FAILED",
  });
  Object.defineProperty(failure, engineWorkspaceLogFailure, { value: true });
  return failure;
}

/** 外部同名 code 不视作本引擎诊断失败，避免绕过业务错误翻译。 */
export function isEngineWorkspaceLogFailure(value: unknown): boolean {
  return types.isNativeError(value) && Object.getOwnPropertyDescriptor(value, engineWorkspaceLogFailure)?.value === true;
}

/** 仅描述自有数据属性，不调用未知 getter/toString；异常私文只保留稳定指纹。 */
export function engineDiagnosticCause(reason: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { type: reason === null ? "null" : typeof reason };
  if ((typeof reason === "object" && reason !== null) || typeof reason === "function") {
    const fields = Object.getOwnPropertyDescriptors(reason);
    for (const key of ["name", "code", "syscall"]) {
      const field = fields[key];
      if (field && "value" in field && typeof field.value === "string") result[key] = redactClientStartupText(field.value).slice(0, 200);
    }
    const message = fields.message;
    if (message && "value" in message && typeof message.value === "string") result.fingerprint = createHash("sha256").update(message.value).digest("hex");
    return result;
  }
  if (typeof reason === "string") result.fingerprint = createHash("sha256").update(reason).digest("hex");
  return result;
}

/** 日志字段只读取自有数据值；访问器按未提供处理，原异常对象仍由错误 owner 保留。 */
export function engineDiagnosticField(reason: unknown, key: string): unknown {
  if (reason === null || typeof reason !== "object" && typeof reason !== "function") return undefined;
  const field = Object.getOwnPropertyDescriptor(reason, key);
  return field && "value" in field ? field.value : undefined;
}

/** 绑定调用方已核 W，描述、脱敏与固定写同处保因边界，绝不应用补同条。 */
export function writeEngineWorkspaceLog(
  writer: EngineWorkspaceLogWriter,
  workspaceId: WorkspaceId,
  build: () => WorkspaceLogEntry,
  business?: { reason: unknown },
): void {
  try {
    const entry = build();
    const data = sanitizeEngineLogData(entry.data) as Record<string, unknown> | null | undefined;
    writer(workspaceId, { ...entry, message: redactClientStartupText(entry.message), data: {
      ...data, workspaceId, requestId: data?.requestId ?? `engine:${workspaceId}`,
    } });
  } catch (error) {
    if (!business) throw error;
    const failure = Object.assign(new AggregateError([business.reason, error], "引擎工作区诊断或固定日志失败",
      { cause: business.reason }), { code: "ENGINE_WORKSPACE_LOG_FAILED" });
    Object.defineProperty(failure, engineWorkspaceLogFailure, { value: true });
    throw failure;
  }
}

/** 日志只读取有界自有 data 字段；正文与凭据不进入诊断，不触发 getter/toString。 */
function sanitizeEngineLogData(value: unknown, depth = 0, visited = new Set<unknown>()): unknown {
  if (typeof value === "string") return redactClientStartupText(value).slice(0, 2_000);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" && typeof value !== "function") return typeof value;
  if (depth >= 8 || visited.has(value)) return "[bounded]";
  visited.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = descriptors.length && "value" in descriptors.length ? Number(descriptors.length.value) : 0;
    for (let index = 0; index < Math.min(length, 50); index++) {
      const descriptor = descriptors[String(index)];
      result.push(descriptor && "value" in descriptor ? sanitizeEngineLogData(descriptor.value, depth + 1, visited) : "[accessor]");
    }
    visited.delete(value);
    return result;
  }
  const entries = Object.entries(descriptors).slice(0, 50);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of entries) {
    if (/^(?:password|secret|token|apiKey|authorization|cookie|credential|privateKey|args|stderr|stdout|raw|params|prompt|images|dataUrl|userMessage|systemMessage|developerMessage)$/i.test(key)) {
      result[key] = "[redacted]";
    } else if ("value" in descriptor) result[key] = sanitizeEngineLogData(descriptor.value, depth + 1, visited);
    else result[key] = "[accessor]";
  }
  visited.delete(value);
  return result;
}

export type ConversationEmitFn = (event: ConversationEventInput) => void;
export type RawEmitFn = (event: RawEngineEventInput) => void;
export type ProviderNativeToolPolicy = "allow" | "deny" | "interactive-only";
export type ConversationProfile = "default" | "orchestration";
export type PlatformToolTransportRequirement = "optional" | "required";
export type RequiredWorkspaceSkill = {
  name: string;
  /** 当前引擎应发现的 SKILL.md 绝对路径。 */
  expectedPath: string;
};
export type ThreadDisposeOptions = {
  flushActiveTurn?: boolean;
  /** 释放原因：idle 仅释放本地运行时资源，不清持久化 session 绑定。 */
  reason?: "thread-disposed" | "codex-restart" | "idle";
};
export const ACTIVE_TURN_CONFLICT_CODE = "active_turn_conflict";
export const ACTIVE_TURN_CONFLICT_MESSAGE = "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。";
export type ThreadEventEmitters = {
  conversation: ConversationEmitFn;
  raw: RawEmitFn;
  /** 等待本回合已接收事件及必要索引完成；失败必须保留给原运行 owner。 */
  flush?: () => Promise<void>;
};

export type ThreadInterruptOptions = { onStopConfirmed?: () => void };

/** 输出保存失败由原发送边界保留，不能伪装为正常停止或可继续的新回合。 */
export class ThreadEventFlushError extends AggregateError {
  readonly code = "TURN_EVENT_FLUSH_FAILED";
  constructor(errors: unknown[]) {
    super(errors, "TURN_EVENT_FLUSH_FAILED", { cause: errors.at(-1) });
  }
}

/** 原发送尾链承担持久化屏障，业务和保存同时失败时保留两段根因。 */
export async function withThreadEventFlush<T>(emitters: ThreadEventEmitters, run: () => Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await run() }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await emitters.flush?.(); }
  catch (error) {
    throw new ThreadEventFlushError(outcome.ok ? [error] : [outcome.error, error]);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export type HostToolExecutionResult =
  | {
      ok: true;
      output: unknown;
      durationMs?: number | null;
    }
  | {
      ok: false;
      message: string;
      code?: string | null;
      output?: unknown;
      durationMs?: number | null;
  };

/** 为平台工具失败计数生成稳定键，避免把不同参数的错误合并成同一轮重试。 */
export function platformToolFailureKey(
  toolId: string,
  toolInput: unknown,
  result: Pick<Extract<HostToolExecutionResult, { ok: false }>, "code" | "message">,
): string {
  return `${toolId}\0${JSON.stringify(toolInput ?? null)}\0${result.code ?? ""}\0${result.message}`;
}

/** 成功后清理同一工具的失败计数，下一次失败从第一轮重新开始。 */
export function clearPlatformToolFailureCounts(counts: Map<string, number>, toolId: string): void {
  const prefix = `${toolId}\0`;
  for (const key of counts.keys()) if (key.startsWith(prefix)) counts.delete(key);
}

export type HostToolExecutor = (input: {
  toolId: string;
  toolInput: unknown;
  accessMode: AccessMode;
}) => Promise<HostToolExecutionResult>;

export type TurnTimeoutPolicy =
  | {
      mode: "legacy-turn";
      /** 单轮硬超时（毫秒）。 */
      timeoutMs: number;
      /** 启动超时：首条 stdout/app-server 响应最长等待时间。 */
      startupTimeoutMs: number;
    }
  | {
      mode: "activity";
      /** 启动超时：首条 stdout/app-server 响应最长等待时间。 */
      startupTimeoutMs: number;
      /** 引擎级无活动超时：仅在当前没有 provider-native active tool/subagent 时生效。 */
      engineIdleTimeoutMs: number;
    };

export type PreparedCodexSkillInput = {
  kind: "codex-skills";
  reservationId: string;
  turnId: TurnId;
  userItemId: ItemId;
  processGeneration: number;
  skills: ReadonlyArray<{
    skillId: string;
    name: string;
    /** Client-local absolute SKILL.md path; never serialize this prepared value. */
    path: string;
  }>;
};

export type SendMessageInput = {
  turnId: TurnId;
  /** 对应的 user message itemId（用于将引擎调用追踪绑定到该条消息下展示）。 */
  userItemId: ItemId;
  text: string;
  /** 显式 Provider 输入语义；缺失时保留旧版自动判定。 */
  inputKind?: ThreadInputKind;
  /** Codex 发送前已完成 fresh resolve 并占位的 Client-local 输入。 */
  preparedInputActions?: PreparedCodexSkillInput | null;
  /** 可选：真正的 user message（未提供时回退到 text）。 */
  userMessage?: string | null;
  /** 可选：运行时装配后的 system message。 */
  systemMessage?: string | null;
  /** 可选：运行时装配后的 developer/runtime policy message。 */
  developerMessage?: string | null;
  /** 可选：供 provider adapter 记录/降级映射的工具注册表快照。 */
  toolRegistryJson?: string | null;
  /** 可选：当前回合真实可调用的平台工具清单。 */
  toolRegistry?: ExecutableToolRegistry | null;
  /** 可选：平台工具执行器。 */
  executeHostTool?: HostToolExecutor | null;
  /** 可选：共享工作区远程 AI 会话中的工具执行策略上下文。 */
  sharedWorkspaceToolContext?: SharedWorkspaceToolExecutionContext | null;
  /** 平台工具对于当前回合是可选增强，还是成立前提。 */
  platformToolTransportRequirement?: PlatformToolTransportRequirement;
  /** 可选：节点期望的响应格式。 */
  responseFormat?: "text" | "json";
  /**
   * Provider 原生工具策略：
   * - allow: 允许 Claude/Codex 使用各自的原生工具链（默认普通会话行为）
   * - deny: 禁止 provider 原生工具；若当前回合存在平台真实工具，只允许调用平台真实工具
   * - interactive-only: 仅允许 requestUserInput / approval 等交互型原生工具，禁止命令、文件修改等普通原生工具
   */
  providerNativeToolPolicy?: ProviderNativeToolPolicy;
  /** 本回合成立前必须由 provider 原生机制发现的工作区 Skill。 */
  requiredWorkspaceSkills?: RequiredWorkspaceSkill[] | null;
  /** 会话画像：普通聊天 / 编排节点执行。 */
  conversationProfile?: ConversationProfile | null;
  /** 工作模式：当前仅保留 general。 */
  workMode?: "general" | null;
  /**
   * Plan 模式：输入侧开关（与 todolist 工具产物区分）。
   * - Codex(app-server)：`turn/start.params.collaborationMode.mode = "plan" | "default"`
   * - Claude Code：`--permission-mode plan`
   */
  planMode?: boolean;
  images: string[];
  assistantItemId: string;
  reasoningItemId: string;
  accessMode?: AccessMode;
  model?: string | null;
  /**
   * 可选：思考强度（由模型配置决定支持档位；参数层仅透传）。
   */
  effort?: string | null;
  /** 可选：上下文窗口覆盖值（仅对支持该能力的引擎生效）。 */
  contextWindow?: number | null;
  /** 可选：自动压缩阈值百分比（50-99）。空值表示使用产品默认值 90%；Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
  /** Codex 专属：Fast mode 服务档位；null 表示显式回到标准档。 */
  serviceTier?: CodexServiceTier | null;
  /** 兼容旧字段：单次 turn 硬超时（毫秒）。 */
  timeoutMs?: number;
  /** 推荐：按活动性判定的超时策略。 */
  timeoutPolicy?: TurnTimeoutPolicy;
};

export type CompactThreadInput = {
  turnId: TurnId;
  /** 沿原provider工具策略限制共享缓存上下文，禁止compact恢复写工具。 */
  sharedWorkspaceToolContext?: SharedWorkspaceToolExecutionContext | null;
  /** 持久化模型仅用于目录准入与租约校验，不覆盖 provider 会话模型。 */
  catalogModel?: string | null;
  accessMode?: AccessMode | null;
  /** 可选：上下文窗口覆盖值（仅对支持该能力的引擎生效）。 */
  contextWindow?: number | null;
  /** 可选：自动压缩阈值百分比（50-99）。空值表示使用产品默认值 90%；Codex 会在运行时换算为 token 阈值。 */
  autoCompactPct?: number | null;
  /** Codex 专属：Fast mode 服务档位；当前仅用于保持压缩入口参数契约一致。 */
  serviceTier?: CodexServiceTier | null;
  /** 推荐：按活动性判定的超时策略。 */
  timeoutPolicy?: TurnTimeoutPolicy;
};

export type AppendTurnInput = {
  turnId: TurnId;
  /** 新追加用户消息的 canonical itemId，用于绑定 engineCall 追踪。 */
  userItemId: ItemId;
  text: string;
  /** 追加到引擎的真实用户文本；未提供时回退到 text。 */
  userMessage?: string | null;
  images: string[];
};

export type AppendTurnResult = {
  engineCall?: EngineCallTrace | null;
};

/** 凭据租约仅覆盖一次已接受引擎操作，终态后释放，不能持久化。 */
export type AcquireEngineCredential = (input: { model?: string | null; turnId?: string }) => import('../security/builtInRelayCredentialService.js').EngineCredentialLease;

/** 输入通道已关闭且尚未写入；队列可安全等待旧回合结束后重新投递。 */
export class ActiveTurnInputClosedError extends Error {
  readonly code = "active_turn_input_closed";
  readonly requestOutcomeUnknown = false;

  constructor() {
    super("当前回合输入通道已关闭，等待回合结束后投递");
  }
}

/** 每个 thread 绑定一个引擎会话（thread 创建后 engine 不可切换）。 */
export interface ThreadEngineSession {
  readonly engine: EngineType;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  getSessionId(): SessionId | null;
  hasActiveTurn(): boolean;
  /** 活跃回合是否仍接受追加输入；关闭输入通道不代表回合已经结束。 */
  canAppendInput?(): boolean;
  /** 返回当前 active turnId；无 active 或无法定位时返回 null。 */
  getActiveTurnId?(): TurnId | null;
  /** 读取当前 Provider 的安全输入目录；实现不得返回本地绝对路径。 */
  listInputActions?(trigger: "/" | "$"): Promise<ListThreadInputActionsResponseBody>;
  /** Fresh resolve Codex binding 并原子占用本次 starting turn。 */
  prepareInputActions?(input: {
    turnId: TurnId;
    userItemId: ItemId;
    text: string;
    skillMentions: readonly CodexSkillMentionBinding[];
  }): Promise<PreparedCodexSkillInput>;
  /** 仅释放仍未被 sendMessage 消费的同一 prepared reservation。 */
  releasePreparedInputActions?(prepared: PreparedCodexSkillInput): boolean;
  /** 判断当前 session 是否允许被 idle 回收。 */
  canIdleDispose?(): boolean;
  resolvePlatformToolTransport(
    toolRegistry: ExecutableToolRegistry | null,
    requirement?: PlatformToolTransportRequirement,
  ): "protocol" | "native-dynamic";
  /** 清理与当前回合工具集合不兼容的 Codex provider binding；不改变本地 thread 身份。 */
  resetDynamicToolBinding?(): boolean;
  /**
   * 在发出 turn terminal 事件前，补齐缺失的 assistant item completed。
   * 返回值中的事件必须先于 `turn.completed` / `turn.error` 发射。
   */
  prepareAssistantTerminalEvents(input: {
    turnId: TurnId;
    outcome: "completed" | "error";
  }): Promise<{ events: ConversationEventInput[]; latestAssistantText: string | null }>;
  stopManagedService?(serviceId: string): Promise<boolean>;
  sendMessage(input: SendMessageInput, emitters: ThreadEventEmitters): Promise<{ responseText: string }>;
  /** 向当前 active turn 追加用户输入；不创建新 turn。 */
  appendInput?(input: AppendTurnInput): Promise<AppendTurnResult>;
  compactThread?(input: CompactThreadInput, emitters: ThreadEventEmitters): Promise<void>;
  /**
   * 中断指定 turn（best-effort）。
   * @returns 是否命中“当前运行中的 turn”（命中才会真正执行中断）。
   */
  interrupt(turnId: TurnId, options?: ThreadInterruptOptions): Promise<boolean>;
  /** 从同一 session owner 的停止证明推导阶段；不创建第二套持久运行状态。 */
  getTurnPhase?(turnId: TurnId): "running" | "stopping" | "draining" | "failed" | null;
  /** 仅返回原 owner 已保留的安全失败码，缺失表示没有保存失败。 */
  getTurnFailure?(turnId: TurnId): string | null;
  /** 读取本地已确权的 provider 终态，供进程终止后的收尾保留真实完成结果。 */
  getObservedTurnTerminalStatus?(turnId: TurnId): string | null;
  /** 运行中应用用户显式修改的计划/执行模式；按会话真实状态推导，失败时显式抛出。 */
  applyPermissionPrefs?(patch: { planMode?: boolean | null; accessMode?: AccessMode | null }): Promise<void>;
  /** 真实引擎进程已终止后，停用旧 session 并唤醒未完成调用；保留持久化 binding。 */
  invalidateAfterProcessTermination?(): void;
  /** 释放资源（可选）：用于 thread 删除/清空后停止监听等。 */
  dispose?: (options?: ThreadDisposeOptions) => void | Promise<void>;
}

export function createActiveTurnConflictError(): Error & { code: typeof ACTIVE_TURN_CONFLICT_CODE } {
  const error = new Error(ACTIVE_TURN_CONFLICT_MESSAGE) as Error & { code: typeof ACTIVE_TURN_CONFLICT_CODE };
  error.code = ACTIVE_TURN_CONFLICT_CODE;
  return error;
}

export function isActiveTurnConflictError(error: unknown): boolean {
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : "";
  if (code === ACTIVE_TURN_CONFLICT_CODE) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(ACTIVE_TURN_CONFLICT_MESSAGE) || message.includes("当前 thread 有未完成的 turn");
}
