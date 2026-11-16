import type {
  ConversationEventInput,
  EngineType,
  ThreadId,
  TurnErrorPayload,
  TurnId,
  TurnTerminationKind,
  WorkspaceId,
} from "@codeflowai/shared";
import {
  extractTurnErrorMetadata,
  type TurnRecoveryStrategy,
} from "@codeflowai/shared";

export type TurnErrorEventInput = Extract<ConversationEventInput, { type: "turn.error" }>;

/** 构造仅包含非空可选字段的 turn.error payload。 */
function createTurnErrorPayload(input: {
  turnId?: TurnId | null;
  error: string;
  code?: string | null;
  requestMethod?: string | null;
  additionalDetails?: string | null;
  providerErrorInfo?: string | null;
  providerThreadId?: string | null;
  recoveryReason?: string | null;
  preserveBinding?: boolean | null;
  userChoiceRequired?: boolean | null;
  recoveryStrategies?: TurnRecoveryStrategy[] | null;
  terminationKind: TurnTerminationKind;
}): TurnErrorPayload {
  const turnId = String(input.turnId ?? "").trim();
  const code = String(input.code ?? "").trim();
  const requestMethod = String(input.requestMethod ?? "").trim();
  const additionalDetails = String(input.additionalDetails ?? "").trim();
  const providerErrorInfo = String(input.providerErrorInfo ?? "").trim();
  const providerThreadId = String(input.providerThreadId ?? "").trim();
  const recoveryReason = String(input.recoveryReason ?? "").trim();
  const recoveryStrategies = normalizeTurnRecoveryStrategies(input.recoveryStrategies);
  return {
    turnId: turnId ? (turnId as TurnId) : undefined,
    error: String(input.error ?? ""),
    code: code || undefined,
    requestMethod: requestMethod || undefined,
    additionalDetails: additionalDetails || undefined,
    providerErrorInfo: providerErrorInfo || undefined,
    providerThreadId: providerThreadId || undefined,
    recoveryReason: recoveryReason || undefined,
    preserveBinding: typeof input.preserveBinding === "boolean" ? input.preserveBinding : undefined,
    userChoiceRequired: typeof input.userChoiceRequired === "boolean" ? input.userChoiceRequired : undefined,
    recoveryStrategies,
    terminationKind: input.terminationKind,
  };
}

/** 构造标准 canonical turn.error 事件。 */
export function createTurnErrorEventInput(input: {
  ts?: number;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
  turnId?: TurnId | null;
  error: string;
  code?: string | null;
  requestMethod?: string | null;
  additionalDetails?: string | null;
  providerErrorInfo?: string | null;
  providerThreadId?: string | null;
  recoveryReason?: string | null;
  preserveBinding?: boolean | null;
  userChoiceRequired?: boolean | null;
  recoveryStrategies?: TurnRecoveryStrategy[] | null;
  terminationKind: TurnTerminationKind;
}): TurnErrorEventInput {
  return {
    ts: Number(input.ts ?? Date.now()),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    type: "turn.error",
    payload: createTurnErrorPayload({
      turnId: input.turnId ?? null,
      error: input.error,
      code: input.code ?? null,
      requestMethod: input.requestMethod ?? null,
      additionalDetails: input.additionalDetails ?? null,
      providerErrorInfo: input.providerErrorInfo ?? null,
      providerThreadId: input.providerThreadId ?? null,
      recoveryReason: input.recoveryReason ?? null,
      preserveBinding: input.preserveBinding ?? null,
      userChoiceRequired: input.userChoiceRequired ?? null,
      recoveryStrategies: input.recoveryStrategies ?? null,
      terminationKind: input.terminationKind,
    }),
  };
}

/** 从未知错误提取结构化元数据并构造 turn.error 事件。 */
export function createTurnErrorEventInputFromError(input: {
  ts?: number;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
  turnId?: TurnId | null;
  error: unknown;
}): TurnErrorEventInput {
  const metadata = extractTurnErrorMetadata(input.error);
  return createTurnErrorEventInput({
    ts: input.ts,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    turnId: input.turnId ?? null,
    error: metadata.message,
    code: metadata.code,
    requestMethod: metadata.requestMethod ?? null,
    additionalDetails: metadata.additionalDetails ?? null,
    providerErrorInfo: metadata.providerErrorInfo ?? null,
    providerThreadId: metadata.providerThreadId ?? null,
    recoveryReason: metadata.recoveryReason ?? null,
    preserveBinding: metadata.preserveBinding ?? null,
    userChoiceRequired: metadata.userChoiceRequired ?? null,
    recoveryStrategies: metadata.recoveryStrategies ?? null,
    terminationKind: metadata.terminationKind,
  });
}

/** 事件边界再次窄化恢复策略，避免手工构造 payload 时写入未知值。 */
function normalizeTurnRecoveryStrategies(value: unknown): TurnRecoveryStrategy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strategies = Array.from(new Set(value.filter(
    (item): item is TurnRecoveryStrategy => item === "retry-existing" || item === "new-thread",
  )));
  return strategies.length ? strategies : undefined;
}
