import { defineStore } from "pinia";

import { isCancelledRequestError } from "../api/request";
import { CODEX_KEY_SWITCH_CONFLICT_REASONS } from "@codeflowai/shared";
import { buildMarkerKey, clearOneShotMarkerCache, hasOneShotMarker, markOneShotMarker } from "../utils/oneShotMarker";
import { useConfigStore } from "./config";
import type { EngineKeysScopePhase } from "./engineKeys";

/** 自动启用内置中转 Key 的一次性标记前缀；每次自动尝试只消耗一次。 */
export const BUILT_IN_RELAY_AUTO_ENABLE_STORAGE_PREFIX = "codeflowai.relay.auto-enable";
/** 当前只自动启用 Codex(openai) 分组；其余 provider 仍需用户手动启用。 */
export const BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID = "openai";
export const BUILT_IN_RELAY_AUTO_ENABLE_TARGET_LABEL = "Codex";
const REASON_MAX_LENGTH = 120;

export type BuiltInRelayAutoEnableMarkerInput = {
  serverWsOrigin: string;
  userId: string;
  workspaceId: string;
  providerId: string;
};

/** 自动启用前的同步前置条件输入；全部来自已有 store 的原始值。 */
export type BuiltInRelayAutoEnablePrecheckInput = {
  isPublicView: boolean;
  isAccountSession: boolean;
  hasActiveSession: boolean;
  logoutInProgress: boolean;
  connected: boolean;
  isDesktop?: boolean;
  desktopCloudAccountLinked?: boolean;
  workspaceId: string;
  workspaceKind: "local" | "shared" | "unknown";
  clientStatus: "online" | "offline" | "unknown";
  keysPhase: EngineKeysScopePhase;
  hasActiveKey: boolean;
  /** 目标内置中转 Key 行是否已存在（无论启用与否）：存在即说明用户已做过决定，不再自动介入。 */
  hasTargetRelayKey: boolean;
};

export type BuiltInRelayAutoEnableWaitReason =
  | "public-view"
  | "no-session"
  | "logging-out"
  | "disconnected"
  | "account-unlinked"
  | "no-workspace"
  | "workspace-unknown"
  | "shared-workspace"
  | "client-offline"
  | "keys-not-loaded"
  | "built-in-key-exists"
  | "active-key-exists";

export type BuiltInRelayAutoEnablePrecheckResult =
  | { status: "wait"; reason: BuiltInRelayAutoEnableWaitReason }
  | { status: "ready" };

/** 只做形状判定，避免 store 反向依赖 features 下的 composable 类型。 */
export type BuiltInRelayAvailabilityInput = {
  available: boolean;
  publicBaseUrl?: string;
  providerGroupsConfigured?: Partial<Record<string, boolean>>;
};

export type BuiltInRelayAutoEnableRunFailure = { message: string; codeGroup: string };

export type BuiltInRelayAutoEnableRunInput = {
  readAttempted: () => boolean;
  markAttempted: () => void;
  probeRelayReady: () => Promise<boolean>;
  /** 内置中转确认可用后再补齐 Key 列表；未就绪时不得调用。 */
  prepareKeys: () => Promise<void>;
  issueEnable: () => Promise<unknown>;
  shouldApply: () => boolean;
  recheckPrecheck: () => boolean;
};

export type BuiltInRelayAutoEnableRunOutcome = "wait" | "already-attempted" | "issued" | "failed" | "cancelled";

export type BuiltInRelayAutoEnableRunResult = {
  outcome: BuiltInRelayAutoEnableRunOutcome;
  failure?: BuiltInRelayAutoEnableRunFailure;
};

export type BuiltInRelayAutoEnableNotice = { kind: "success" | "failure"; message: string };

/** 生成一次性标记键；账号、工作区或 provider 缺失时返回 null，避免写入无法归属的脏键。 */
export function resolveBuiltInRelayAutoEnableMarkerKey(input: BuiltInRelayAutoEnableMarkerInput): string | null {
  return buildMarkerKey(BUILT_IN_RELAY_AUTO_ENABLE_STORAGE_PREFIX, [
    input.serverWsOrigin,
    input.userId,
    input.workspaceId,
    input.providerId,
  ]);
}

/** 生成跨组件共享提示的作用域键（不含 webSessionId：重连会换值，会导致提示丢失）。 */
export function resolveBuiltInRelayAutoEnableScopeKey(input: {
  serverWsOrigin?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
}): string | null {
  const serverWsOrigin = String(input.serverWsOrigin ?? "").trim();
  const userId = String(input.userId ?? "").trim();
  const workspaceId = String(input.workspaceId ?? "").trim();
  if (!serverWsOrigin || !userId || !workspaceId) return null;
  return [serverWsOrigin, userId, workspaceId].map((part) => encodeURIComponent(part)).join("::");
}

/** 读取一次性标记；内存集合用于存储不可用场景。 */
export function hasBuiltInRelayAutoEnableAttempted(input: BuiltInRelayAutoEnableMarkerInput): boolean {
  return hasOneShotMarker(resolveBuiltInRelayAutoEnableMarkerKey(input));
}

/** 标记本次自动启用机会已被消耗；写失败也必须视作已消耗，避免循环重试。 */
export function markBuiltInRelayAutoEnableAttempted(input: BuiltInRelayAutoEnableMarkerInput): void {
  markOneShotMarker(resolveBuiltInRelayAutoEnableMarkerKey(input));
}

/** 清空本前缀的内存消耗记录；仅供单测隔离使用，不影响 localStorage。 */
export function clearBuiltInRelayAutoEnableAttemptCache(): void {
  clearOneShotMarkerCache(BUILT_IN_RELAY_AUTO_ENABLE_STORAGE_PREFIX);
}

/**
 * 判定环境类前置条件（与 Key 列表无关）。
 * 只有这里就绪才值得继续探测内置中转，避免中转未启用时改动 Key 列表状态。
 */
export function resolveBuiltInRelayAutoEnableEnvironment(
  input: BuiltInRelayAutoEnablePrecheckInput,
): BuiltInRelayAutoEnablePrecheckResult {
  if (input.isPublicView) return { status: "wait", reason: "public-view" };
  if (!input.isAccountSession || !input.hasActiveSession) return { status: "wait", reason: "no-session" };
  if (input.logoutInProgress) return { status: "wait", reason: "logging-out" };
  if (input.isDesktop && !input.desktopCloudAccountLinked) return { status: "wait", reason: "account-unlinked" };
  if (!input.isDesktop && !input.connected) return { status: "wait", reason: "disconnected" };
  if (!String(input.workspaceId ?? "").trim()) return { status: "wait", reason: "no-workspace" };
  if (input.workspaceKind === "unknown") return { status: "wait", reason: "workspace-unknown" };
  if (input.workspaceKind === "shared") return { status: "wait", reason: "shared-workspace" };
  if (input.clientStatus !== "online") return { status: "wait", reason: "client-offline" };
  return { status: "ready" };
}

/**
 * 判定完整前置条件：环境 + Key 列表已加载且当前没有任何启用中的 Key。
 * 不满足一律“等待”，调用方不得因此消耗一次性机会。
 */
export function resolveBuiltInRelayAutoEnablePrecheck(
  input: BuiltInRelayAutoEnablePrecheckInput,
): BuiltInRelayAutoEnablePrecheckResult {
  const environment = resolveBuiltInRelayAutoEnableEnvironment(input);
  if (environment.status === "wait") return environment;
  if (input.keysPhase !== "success") return { status: "wait", reason: "keys-not-loaded" };
  // 内置中转 Key 已存在（含被用户停用）时不再自动改写，避免把用户手动停用又自动打开。
  if (input.hasTargetRelayKey) return { status: "wait", reason: "built-in-key-exists" };
  if (input.hasActiveKey) return { status: "wait", reason: "active-key-exists" };
  return { status: "ready" };
}

/**
 * 判断是否为可重试的瞬时竞态：Key 列表正被并发刷新时，
 * syncBuiltInRelayKey 会在自有刷新后看到 loading 并抛错，此时不应把唯一机会算作失败。
 */
export function isBuiltInRelayAutoEnableRetryableError(error: unknown): boolean {
  const text = sanitizeBuiltInRelayAutoEnableReason(error instanceof Error ? error.message : error);
  return text.includes("本地 Key 列表刷新未完成");
}

/** 内置中转真正就绪：可用状态已含 enabled 与公开地址，这里再要求目标 provider 分组已配置。 */
export function isBuiltInRelayReadyForProvider(
  availability: BuiltInRelayAvailabilityInput,
  providerId: string,
): boolean {
  if (!availability.available) return false;
  if (!String(availability.publicBaseUrl ?? "").trim()) return false;
  return availability.providerGroupsConfigured?.[providerId] === true;
}

/** 脱敏并截断失败原因：只保留可读文本，遮蔽地址与 Key 形态片段。 */
export function sanitizeBuiltInRelayAutoEnableReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const text = raw
    .replace(/https?:\/\/[^\s"'）)，。]+/gu, "（地址已隐藏）")
    .replace(/codeflowai_[A-Za-z0-9_-]{8,}/gu, "（Key 已隐藏）")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_MAX_LENGTH)}…` : text;
}

/** 归类失败用于埋点；只区分已登记的冲突原因与通用失败边界。 */
export function classifyBuiltInRelayAutoEnableFailure(failure: unknown): string {
  const record = (failure && typeof failure === "object" ? failure : {}) as { code?: unknown; details?: unknown };
  if (record.code === "CONFLICT") return "codex_turn_conflict";
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : null;
  if (details?.reason === CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired) return "codex_turn_conflict";
  if (typeof record.code === "string" && record.code.trim()) return "request_rejected";
  const text = failure instanceof Error ? failure.message : String(failure ?? "");
  if (/CLIENT_OFFLINE|Client 未在线|Client 未连接/u.test(text)) return "client_offline";
  return "request_error";
}

/** 生成用户可见的失败原因：先映射已登记原因，再回落到脱敏文本。 */
export function resolveBuiltInRelayAutoEnableFailureMessage(failure: unknown): string {
  const details = (failure as { details?: unknown } | null)?.details;
  const reason = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>).reason
    : undefined;
  if (reason === CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired) return "有 Codex 回合正在运行，已跳过自动切换";
  if (reason === CODEX_KEY_SWITCH_CONFLICT_REASONS.controlledExperimentRunning) return "有受控实验正在运行，已跳过自动切换";
  if (reason === CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsStopFailed) return "Codex 回合停止失败，已跳过自动切换";
  const sanitized = sanitizeBuiltInRelayAutoEnableReason(failure);
  if (/CLIENT_OFFLINE|Client 未在线|Client 未连接/u.test(sanitized)) return "当前工作区 Client 未在线";
  return sanitized || "内置中转 Key 写入失败";
}

/** 组装失败提示：明确告知不再自动重试，并指向同页手动启用入口。 */
export function buildBuiltInRelayAutoEnableFailureNotice(reason: string): BuiltInRelayAutoEnableNotice {
  const text = String(reason ?? "").trim() || "内置中转 Key 写入失败";
  return {
    kind: "failure",
    message: `自动启用内置中转 Key 失败：${text}。本次自动启用机会已使用，不会自动重试；可在下方「CodeFlow 内置中转」卡片点击「启用」。`,
  };
}

export function buildBuiltInRelayAutoEnableSuccessNotice(): BuiltInRelayAutoEnableNotice {
  return { kind: "success", message: `已自动启用内置中转 Key（${BUILT_IN_RELAY_AUTO_ENABLE_TARGET_LABEL}），无需手动配置。` };
}

/**
 * 执行一次自动启用编排：前置与就绪判定都在消耗标记之前完成，
 * 只有真正发起写请求才消耗那一次机会，之后的失败不回滚、不重试。
 */
export async function runBuiltInRelayAutoEnable(
  input: BuiltInRelayAutoEnableRunInput,
): Promise<BuiltInRelayAutoEnableRunResult> {
  if (input.readAttempted()) return { outcome: "already-attempted" };

  let ready = false;
  try {
    ready = await input.probeRelayReady();
  } catch {
    // 就绪状态读取失败按“未就绪”处理：不消耗机会、不产生用户可见失败。
    return { outcome: "wait" };
  }
  if (!ready) return { outcome: "wait" };
  if (!input.shouldApply()) return { outcome: "wait" };
  try {
    await input.prepareKeys();
  } catch {
    // Key 列表刷新失败已由 store 记录，按“未就绪”等待，不消耗机会。
    return { outcome: "wait" };
  }
  if (!input.shouldApply()) return { outcome: "wait" };
  if (!input.recheckPrecheck()) return { outcome: "wait" };

  input.markAttempted();
  try {
    await input.issueEnable();
    return { outcome: "issued" };
  } catch (error) {
    if (isCancelledRequestError(error)) return { outcome: "cancelled" };
    return {
      outcome: "failed",
      failure: { message: resolveBuiltInRelayAutoEnableFailureMessage(error), codeGroup: classifyBuiltInRelayAutoEnableFailure(error) },
    };
  }
}

/** 自动启用结果提示：跨组件共享，供向导模型步骤与设置页共用的 Key 面板读取。 */
export const useBuiltInRelayAutoEnableStore = defineStore("builtInRelayAutoEnable", {
  state: (): { noticeByScopeKey: Record<string, BuiltInRelayAutoEnableNotice | undefined> } => ({
    noticeByScopeKey: {},
  }),
  getters: {
    /** 读取指定工作区在当前账号作用域下的自动启用结果提示。 */
    noticeForWorkspace: (state) => (workspaceId: string | null | undefined): BuiltInRelayAutoEnableNotice | null => {
      const config = useConfigStore();
      const scopeKey = resolveBuiltInRelayAutoEnableScopeKey({
        serverWsOrigin: config.serverWsOrigin,
        userId: config.userSummary?.userId,
        workspaceId,
      });
      if (!scopeKey) return null;
      return state.noticeByScopeKey[scopeKey] ?? null;
    },
  },
  actions: {
    publishNotice(scopeKey: string, notice: BuiltInRelayAutoEnableNotice): void {
      this.noticeByScopeKey = { ...this.noticeByScopeKey, [scopeKey]: notice };
    },
    dismissNotice(scopeKey: string): void {
      if (!this.noticeByScopeKey[scopeKey]) return;
      const next = { ...this.noticeByScopeKey };
      delete next[scopeKey];
      this.noticeByScopeKey = next;
    },
    reset(): void {
      this.noticeByScopeKey = {};
    },
  },
});
