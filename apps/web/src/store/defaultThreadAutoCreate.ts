import { isCancelledRequestError } from "../api/request";
import type { EngineType, ThreadId } from "@codeflowai/shared";

import { buildMarkerKey, clearOneShotMarkerCache, hasOneShotMarker, markOneShotMarker } from "../utils/oneShotMarker";
import type { EngineKeysScopePhase } from "./engineKeys";

/** 自动创建「默认会话」的一次性标记前缀；每个（账号，工作区）只消耗一次。 */
export const DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX = "codeflowai.default-thread.auto-create";
/** 自动创建的会话标题固定，便于用户识别与后续排查。 */
export const DEFAULT_THREAD_AUTO_CREATE_TITLE = "默认会话";
/** 引擎优先级：优先 Codex，回落 Claude。 */
const ENGINE_ORDER: readonly EngineType[] = ["codex", "claude"];
const REASON_MAX_LENGTH = 120;

export type DefaultThreadAutoCreateMarkerInput = {
  serverWsOrigin: string;
  userId: string;
  workspaceId: string;
  desktopClientId?: string | null;
};

/** 自动创建前的同步前置条件输入；全部来自已有 store 的原始值。 */
export type DefaultThreadAutoCreateEnvironmentInput = {
  isPublicView: boolean;
  isAccountSession: boolean;
  hasActiveSession: boolean;
  logoutInProgress: boolean;
  connected: boolean;
  localReady?: boolean;
  workspaceId: string;
  workspaceKind: "local" | "shared" | "unknown";
  clientStatus: "online" | "offline" | "unknown";
  /** 工作区激活事务阶段；只有 settled 才说明会话列表已加载完成。 */
  workspacePhase: "idle" | "critical" | "settled";
  /** workspaceActivation 记录的工作区；与目标不一致说明仍停在上一轮激活结果上。 */
  activatedWorkspaceId: string | null;
  workspaceDegraded: boolean;
};

export type DefaultThreadAutoCreatePrecheckInput = DefaultThreadAutoCreateEnvironmentInput & {
  keysPhase: EngineKeysScopePhase;
  /** 各引擎当前启用中的 Key 供应商；空数组表示该引擎没有可用 Key。 */
  activeProviderIdsByEngine: Record<EngineType, string[]>;
  /** 复用新建会话弹窗的每引擎禁用原因，避免选中"弹框里本来就被禁用"的引擎。 */
  disabledEngines: Partial<Record<EngineType, string>>;
};

/**
 * 等待原因：前段来自门禁（环境与 Key 就绪判定），后段来自编排层（作用域失效/刷新失败/探测失败）。
 * 两者都对外表现为"这次没建会话，原因是 X"，因此共用一个联合类型，便于日志统一取值。
 */
export type DefaultThreadAutoCreateWaitReason =
  | "public-view"
  | "no-session"
  | "logging-out"
  | "disconnected"
  | "no-workspace"
  | "workspace-unknown"
  | "shared-workspace"
  | "client-offline"
  | "workspace-not-settled"
  | "workspace-degraded"
  | "keys-not-loaded"
  | "no-usable-engine"
  | "threads-exist"
  /** 编排层等待：作用域在探测前后失效 / 引擎与 Key 刷新失败 / 会话探测失败。 */
  | "scope-changed"
  | "prepare-failed"
  | "probe-failed";

export type DefaultThreadAutoCreateEnvironmentResult =
  | { status: "wait"; reason: DefaultThreadAutoCreateWaitReason }
  | { status: "ready" };

export type DefaultThreadAutoCreatePrecheckResult =
  | { status: "wait"; reason: DefaultThreadAutoCreateWaitReason }
  | { status: "ready"; engine: EngineType };

export type DefaultThreadAutoCreateRunFailure = { message: string; codeGroup: string };

export type DefaultThreadAutoCreateRunInput = {
  readAttempted: () => boolean;
  environment: () => DefaultThreadAutoCreateEnvironmentResult;
  precheck: () => DefaultThreadAutoCreatePrecheckResult;
  shouldApply: () => boolean;
  /** 刷新 Host Client 引擎状态与本地 Key 列表；未就绪时不得调用。 */
  prepareAvailability: () => Promise<void>;
  /** 探测当前工作区是否已有用户可见会话；返回 true 表示已有会话。 */
  probeHasVisibleThreads: () => Promise<boolean>;
  markAttempted: () => void;
  createThread: (engine: EngineType) => Promise<ThreadId>;
};

/** 编排结果：wait 必然带原因（每条等待路径都已具名），调用方据此可直接记录诊断日志。 */
export type DefaultThreadAutoCreateRunResult =
  | { outcome: "wait"; reason: DefaultThreadAutoCreateWaitReason }
  | { outcome: "already-attempted" }
  | { outcome: "created"; engine: EngineType; threadId: ThreadId }
  | { outcome: "interrupted"; engine: EngineType }
  | { outcome: "failed"; engine: EngineType; failure: DefaultThreadAutoCreateRunFailure };

/** 按真实账号或本机 Client 归属生成一次性标记，缺少工作区时不写入。 */
export function resolveDefaultThreadAutoCreateMarkerKey(input: DefaultThreadAutoCreateMarkerInput): string | null {
  if (input.desktopClientId) return buildMarkerKey(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX,
    ["desktop-local", input.desktopClientId, input.workspaceId]);
  return buildMarkerKey(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX, [
    input.serverWsOrigin,
    input.userId,
    input.workspaceId,
  ]);
}

/** 读取一次性标记；内存集合用于存储不可用场景。 */
export function hasDefaultThreadAutoCreateAttempted(input: DefaultThreadAutoCreateMarkerInput): boolean {
  return hasOneShotMarker(resolveDefaultThreadAutoCreateMarkerKey(input));
}

/** 标记本次自动创建机会已被消耗；写失败也必须视作已消耗，避免循环重试。 */
export function markDefaultThreadAutoCreateAttempted(input: DefaultThreadAutoCreateMarkerInput): void {
  markOneShotMarker(resolveDefaultThreadAutoCreateMarkerKey(input));
}

/** 清空本前缀的内存消耗记录；供单测隔离与 storage 事件失效缓存使用，不影响 localStorage。 */
export function clearDefaultThreadAutoCreateAttemptCache(): void {
  clearOneShotMarkerCache(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX);
}

/**
 * 判定环境类前置条件（与 Key 列表、会话探测无关）。
 * 只有这里就绪才值得刷新引擎/Key 状态并探测会话，避免在白屏或加载中浪费探测。
 */
export function resolveDefaultThreadAutoCreateEnvironment(
  input: DefaultThreadAutoCreateEnvironmentInput,
): DefaultThreadAutoCreateEnvironmentResult {
  if (input.isPublicView) return { status: "wait", reason: "public-view" };
  if (!input.localReady && (!input.isAccountSession || !input.hasActiveSession)) return { status: "wait", reason: "no-session" };
  if (input.logoutInProgress) return { status: "wait", reason: "logging-out" };
  if (!input.connected && !input.localReady) return { status: "wait", reason: "disconnected" };
  const workspaceId = String(input.workspaceId ?? "").trim();
  if (!workspaceId) return { status: "wait", reason: "no-workspace" };
  if (input.workspaceKind === "unknown") return { status: "wait", reason: "workspace-unknown" };
  if (input.workspaceKind === "shared") return { status: "wait", reason: "shared-workspace" };
  if (input.clientStatus !== "online") return { status: "wait", reason: "client-offline" };
  // 激活未完成（含切换中/加载失败）时会话列表可能是假空，必须等 settled 且归属当前工作区。
  if (input.workspacePhase !== "settled" || String(input.activatedWorkspaceId ?? "").trim() !== workspaceId) {
    return { status: "wait", reason: "workspace-not-settled" };
  }
  if (input.workspaceDegraded) return { status: "wait", reason: "workspace-degraded" };
  return { status: "ready" };
}

/** 选择自动创建使用的引擎：有启用中 Key 且未被新建弹窗判定为不可用。 */
export function resolveDefaultThreadAutoCreateEngine(input: {
  activeProviderIdsByEngine: Record<EngineType, string[]>;
  disabledEngines: Partial<Record<EngineType, string>>;
}): EngineType | null {
  for (const engine of ENGINE_ORDER) {
    if (!(input.activeProviderIdsByEngine[engine] ?? []).length) continue;
    if (input.disabledEngines[engine]) continue;
    return engine;
  }
  return null;
}

/**
 * 判定完整前置条件：环境 + Key 列表已加载 + 存在可用引擎。
 * 不满足一律“等待”，调用方不得因此消耗一次性机会。
 */
export function resolveDefaultThreadAutoCreatePrecheck(
  input: DefaultThreadAutoCreatePrecheckInput,
): DefaultThreadAutoCreatePrecheckResult {
  const environment = resolveDefaultThreadAutoCreateEnvironment(input);
  if (environment.status === "wait") return environment;
  if (input.keysPhase !== "success") return { status: "wait", reason: "keys-not-loaded" };
  const engine = resolveDefaultThreadAutoCreateEngine(input);
  if (!engine) return { status: "wait", reason: "no-usable-engine" };
  return { status: "ready", engine };
}

/** 脱敏并截断失败原因：只保留可读文本，遮蔽地址与 Key 形态片段。 */
export function sanitizeDefaultThreadAutoCreateReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const text = raw
    .replace(/https?:\/\/[^\s"'）)，。]+/gu, "（地址已隐藏）")
    .replace(/codeflowai_[A-Za-z0-9_-]{8,}/gu, "（Key 已隐藏）")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_MAX_LENGTH)}…` : text;
}

/** 归类失败用于埋点；只区分已登记的失败边界。 */
export function classifyDefaultThreadAutoCreateFailure(failure: unknown): string {
  const record = (failure && typeof failure === "object" ? failure : {}) as { code?: unknown };
  if (typeof record.code === "string" && record.code.trim()) return "request_rejected";
  const text = failure instanceof Error ? failure.message : String(failure ?? "");
  if (/CLIENT_OFFLINE|Client 未在线|Client 未连接/u.test(text)) return "client_offline";
  if (/模型目录|引擎状态|引擎不可用|未启用/u.test(text)) return "engine_unavailable";
  return "request_error";
}

/** 等待原因日志的节流窗口：同一原因不重复刷屏，原因变化或超过窗口才再记一条。 */
export const DEFAULT_THREAD_AUTO_CREATE_WAIT_LOG_INTERVAL_MS = 60_000;

export type DefaultThreadAutoCreateWaitLogState = { reason: string; workspaceId: string; at: number } | null;

/**
 * 判定本次等待是否需要留日志。
 * 等待分支此前完全静默，"装完没有默认会话"这类问题只能靠猜；同一工作区的同一原因按窗口节流，
 * 避免每次 watch 触发都刷一条，同时保证切换到另一个同样卡住的工作区时仍会留一条。
 */
export function shouldLogDefaultThreadAutoCreateWait(
  previous: DefaultThreadAutoCreateWaitLogState,
  reason: string,
  workspaceId: string,
  now: number,
): boolean {
  if (!previous) return true;
  if (previous.reason !== reason || previous.workspaceId !== workspaceId) return true;
  return now - previous.at >= DEFAULT_THREAD_AUTO_CREATE_WAIT_LOG_INTERVAL_MS;
}

/** 生成用户可见的失败原因：脱敏后回落固定文案。 */
export function resolveDefaultThreadAutoCreateFailureMessage(failure: unknown): string {
  const sanitized = sanitizeDefaultThreadAutoCreateReason(failure);
  if (/CLIENT_OFFLINE|Client 未在线|Client 未连接/u.test(sanitized)) return "当前工作区 Client 未在线";
  return sanitized || "默认会话创建失败";
}

/**
 * 执行一次自动创建编排：前置、可用性刷新与"是否已有会话"探测都在消耗标记之前完成。
 * 只有探测结论明确（已建/待建）才消耗那一次机会，之后的失败不回滚、不重试。
 *
 * 注意顺序：环境判定前置（不触碰引擎/Key），但"Key 列表已加载/引擎可用"必须放在
 * prepareAvailability 之后复核——冷启动时没有任何链路会自动拉取 Key 列表，
 * 先卡 keys-not-loaded 会让功能永远停在等待上，白等而不前进。
 */
export async function runDefaultThreadAutoCreate(
  input: DefaultThreadAutoCreateRunInput,
): Promise<DefaultThreadAutoCreateRunResult> {
  if (input.readAttempted()) return { outcome: "already-attempted" };

  const environment = input.environment();
  if (environment.status === "wait") return { outcome: "wait", reason: environment.reason };
  if (!input.shouldApply()) return { outcome: "wait", reason: "scope-changed" };
  try {
    await input.prepareAvailability();
  } catch {
    // 引擎/Key 状态刷新失败已由既有链路提示，按“未就绪”等待，不消耗机会。
    return { outcome: "wait", reason: "prepare-failed" };
  }
  if (!input.shouldApply()) return { outcome: "wait", reason: "scope-changed" };
  const precheck = input.precheck();
  if (precheck.status === "wait") return { outcome: "wait", reason: precheck.reason };

  let hasVisibleThreads = false;
  try {
    hasVisibleThreads = await input.probeHasVisibleThreads();
  } catch {
    // 探测失败无法判定是否已有会话，按“未就绪”等待，不消耗机会。
    return { outcome: "wait", reason: "probe-failed" };
  }
  // 探测是 await 点，期间可能已切换工作区：此处到 markAttempted/createThread 之间没有 await，
  // 这一道门禁同时保证“不再消耗标记”与“不用旧 workspaceId 建会话”。
  if (!input.shouldApply()) return { outcome: "wait", reason: "scope-changed" };
  if (hasVisibleThreads) {
    // 已有会话是终局判定：同样消耗机会，避免用户删光会话后刷新又冒出「默认会话」。
    input.markAttempted();
    return { outcome: "wait", reason: "threads-exist" };
  }

  const engine = precheck.engine;
  input.markAttempted();
  try {
    const threadId = await input.createThread(engine);
    return { outcome: "created", engine, threadId };
  } catch (error) {
    if (isCancelledRequestError(error)) return { outcome: "interrupted", engine };
    return {
      outcome: "failed",
      engine,
      failure: {
        message: resolveDefaultThreadAutoCreateFailureMessage(error),
        codeGroup: classifyDefaultThreadAutoCreateFailure(error),
      },
    };
  }
}
