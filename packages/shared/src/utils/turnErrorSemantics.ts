import type { TurnTerminationKind } from "../types/events.js";

export type TurnRecoveryStrategy = "retry-existing" | "new-thread";

const TRANSIENT_TURN_ERROR_CODES = new Set([
  "client_restarted",
  "codex_interrupted",
  "codex_cancelled",
]);

export type TurnErrorSemanticsKind = TurnTerminationKind;
export const MANUAL_TURN_INTERRUPT_CODE = "turn_interrupted";

export function isTransientTurnErrorCode(code: string | null | undefined): boolean {
  return TRANSIENT_TURN_ERROR_CODES.has(String(code ?? "").trim());
}

/** 手动中断在界面上的中文表达，跟随 MANUAL_TURN_INTERRUPT_CODE 的语义。 */
export const MANUAL_TURN_INTERRUPT_USER_MESSAGE = "本次请求已中止，可继续发送消息。";

/** 引擎落库的英文原文，仅用于展示层识别，不对外导出。 */
const MANUAL_TURN_INTERRUPT_RAW_MESSAGE = "turn interrupted";

/**
 * 把引擎透出的 turn 错误转换为展示文案。
 * 输入：引擎原始 message（可能为空）；输出：手动中断返回中文，空值返回 null，其他诊断原样返回以保留排障信息。
 * 边界：只按固定文案识别手动中断；nodeState.error 等落库字段仍保留原始英文。
 */
export function humanizeTurnErrorMessage(message: string | null | undefined): string | null {
  const text = String(message ?? "").trim();
  if (!text) return null;
  return text.toLowerCase() === MANUAL_TURN_INTERRUPT_RAW_MESSAGE ? MANUAL_TURN_INTERRUPT_USER_MESSAGE : text;
}

export function classifyTurnErrorSemantics(input: {
  terminationKind?: TurnTerminationKind | null;
  error?: string | null;
  code?: string | null;
}): TurnErrorSemanticsKind {
  if (input.terminationKind === "manual_interrupt" || input.terminationKind === "transient_cleanup" || input.terminationKind === "error") {
    return input.terminationKind;
  }
  if (String(input.code ?? "").trim() === MANUAL_TURN_INTERRUPT_CODE) {
    return "manual_interrupt";
  }
  if (isTransientTurnErrorCode(input.code)) return "transient_cleanup";
  return "error";
}

export function isTransientTurnError(input: {
  terminationKind?: TurnTerminationKind | null;
  error?: string | null;
  code?: string | null;
}): boolean {
  const kind = classifyTurnErrorSemantics(input);
  return kind === "manual_interrupt" || kind === "transient_cleanup";
}

/** 提取可安全写入 turn.error 的稳定错误字段。 */
export function extractTurnErrorMetadata(error: unknown): {
  message: string;
  code?: string;
  requestMethod?: string;
  additionalDetails?: string;
  providerErrorInfo?: string;
  providerThreadId?: string;
  recoveryReason?: string;
  preserveBinding?: boolean;
  userChoiceRequired?: boolean;
  recoveryStrategies?: TurnRecoveryStrategy[];
  terminationKind: TurnTerminationKind;
} {
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown } | null)?.message === "string"
      ? String((error as { message: string }).message)
      : String(error ?? "");
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : undefined;
  const requestMethodRaw = (error as { requestMethod?: unknown; method?: unknown } | null)?.requestMethod
    ?? (error as { method?: unknown } | null)?.method;
  const requestMethod = typeof requestMethodRaw === "string"
    ? normalizeOptionalText(requestMethodRaw)
    : undefined;
  const additionalDetails = normalizeOptionalText(
    (error as { additionalDetails?: unknown } | null)?.additionalDetails,
  );
  const providerErrorInfo = normalizeOptionalText(
    (error as { providerErrorInfo?: unknown; provider_error_info?: unknown } | null)?.providerErrorInfo
    ?? (error as { provider_error_info?: unknown } | null)?.provider_error_info,
  );
  const providerThreadIdRaw = (error as { providerThreadId?: unknown } | null)?.providerThreadId;
  const providerThreadId = typeof providerThreadIdRaw === "string"
    ? normalizeOptionalText(providerThreadIdRaw)
    : undefined;
  const recoveryReasonRaw = (error as { reason?: unknown } | null)?.reason;
  const recoveryReason = typeof recoveryReasonRaw === "string"
    ? normalizeOptionalText(recoveryReasonRaw)
    : undefined;
  const preserveBinding = normalizeOptionalBoolean(
    (error as { preserveBinding?: unknown } | null)?.preserveBinding,
  );
  const userChoiceRequired = normalizeOptionalBoolean(
    (error as { userChoiceRequired?: unknown } | null)?.userChoiceRequired,
  );
  const recoveryStrategies = normalizeTurnRecoveryStrategies(
    (error as { recoveryStrategies?: unknown } | null)?.recoveryStrategies,
  );
  const terminationKindRaw = typeof (error as { terminationKind?: unknown } | null)?.terminationKind === "string"
    ? String((error as { terminationKind: string }).terminationKind)
    : null;
  const terminationKind = classifyTurnErrorSemantics({
    terminationKind: terminationKindRaw as TurnTerminationKind | null,
    error: message,
    code,
  });
  return {
    message,
    code,
    requestMethod,
    additionalDetails,
    providerErrorInfo,
    providerThreadId,
    recoveryReason,
    preserveBinding,
    userChoiceRequired,
    recoveryStrategies,
    terminationKind,
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/** 仅接受真实 boolean，避免字符串真值误触发恢复选择。 */
function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 严格保留已知恢复策略，并按原顺序去重。 */
function normalizeTurnRecoveryStrategies(value: unknown): TurnRecoveryStrategy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strategies = Array.from(new Set(value.filter(
    (item): item is TurnRecoveryStrategy => item === "retry-existing" || item === "new-thread",
  )));
  return strategies.length ? strategies : undefined;
}
