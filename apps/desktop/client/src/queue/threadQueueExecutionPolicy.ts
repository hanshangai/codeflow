import type {
  ThreadQueueSendOptions,
  TurnExecutionOptionsSnapshot,
} from "@codeflowai/shared";

export const ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT = "ORCHESTRATION_NODE_EXECUTION_OPTIONS_CONFLICT";

export type ThreadQueueExecutionCompatibility = "same" | "different" | "unknown";

type ExecutionOptionsInput = Pick<
  ThreadQueueSendOptions,
  "model" | "effort" | "contextWindow" | "autoCompactPct" | "serviceTier"
>;

/** 固化 turn 启动时实际接收的模型参数，供运行中队列做权威比较。 */
export function buildTurnExecutionOptionsSnapshot(input: ExecutionOptionsInput): TurnExecutionOptionsSnapshot {
  return {
    model: normalizeNullableText(input.model),
    effort: normalizeNullableText(input.effort),
    contextWindow: normalizePositiveInteger(input.contextWindow),
    autoCompactPct: normalizeAutoCompactPct(input.autoCompactPct),
    serviceTier: input.serviceTier === "fast" ? "fast" : null,
  };
}

/** 严格读取持久化 turn 参数；旧事件或非法快照返回 null，让调用方安全阻断 active append。 */
export function readTurnExecutionOptionsSnapshot(raw: unknown): TurnExecutionOptionsSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const requiredKeys = ["model", "effort", "contextWindow", "autoCompactPct", "serviceTier"] as const;
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return null;

  const model = readNullableText(value.model);
  const effort = readNullableText(value.effort);
  const contextWindow = readNullablePositiveInteger(value.contextWindow);
  const autoCompactPct = readNullableAutoCompactPct(value.autoCompactPct);
  const serviceTier = readNullableServiceTier(value.serviceTier);
  if (model === undefined
    || effort === undefined
    || contextWindow === undefined
    || autoCompactPct === undefined
    || serviceTier === undefined) return null;
  return { model, effort, contextWindow, autoCompactPct, serviceTier };
}

/** 比较队列输入与 active turn 参数；显式 fresh-turn 标记直接判为不兼容。 */
export function compareThreadQueueExecutionOptions(
  activeExecution: unknown,
  pending: ThreadQueueSendOptions,
): ThreadQueueExecutionCompatibility {
  if (pending.forceNewTurn === true) return "different";
  const active = readTurnExecutionOptionsSnapshot(activeExecution);
  if (!active) return "unknown";
  const next = buildTurnExecutionOptionsSnapshot(pending);
  return active.model === next.model
    && active.effort === next.effort
    && active.contextWindow === next.contextWindow
    && active.autoCompactPct === next.autoCompactPct
    && active.serviceTier === next.serviceTier
    ? "same"
    : "different";
}

/** 生成人可理解的节点切模拒绝提示。 */
export function buildNodeExecutionOptionsConflictMessage(compatibility: ThreadQueueExecutionCompatibility): string {
  if (compatibility === "unknown") {
    return "节点正在执行，但当前 turn 的模型参数快照不可用；为避免把输入追加到错误模型，本次发送已拒绝，请等待节点进入可恢复状态后重试。";
  }
  return "节点正在执行，当前 turn 不能切换模型参数；请切回本轮参数补充内容，或等待节点进入可恢复状态后再发送。";
}

/** 将调用侧文本规整为去空白字符串或空值。 */
function normalizeNullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 将调用侧数值规整为正整数或空值。 */
function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 将调用侧压缩阈值规整为合法范围或空值。 */
function normalizeAutoCompactPct(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 50 && parsed <= 99 ? parsed : null;
}

/** 严格读取可空字符串字段。 */
function readNullableText(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

/** 严格读取可空正整数字段。 */
function readNullablePositiveInteger(value: unknown): number | null | undefined {
  if (value == null) return null;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** 严格读取可空压缩阈值字段。 */
function readNullableAutoCompactPct(value: unknown): number | null | undefined {
  if (value == null) return null;
  return Number.isSafeInteger(value) && Number(value) >= 50 && Number(value) <= 99
    ? Number(value)
    : undefined;
}

/** 严格读取可空 Codex 服务档位。 */
function readNullableServiceTier(value: unknown): "fast" | null | undefined {
  if (value === null) return null;
  return value === "fast" ? "fast" : undefined;
}
