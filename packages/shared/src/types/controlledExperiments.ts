import type { EngineType } from "./engine.js";

export const CONTROLLED_EXPERIMENT_CONTRACT_VERSION = 1 as const;

export const CONTROLLED_EXPERIMENT_STATUSES = [
  "draft",
  "ready",
  "running",
  "cancel_requested",
  "completed",
  "cancelled",
  "failed",
] as const;
export type ControlledExperimentStatus = (typeof CONTROLLED_EXPERIMENT_STATUSES)[number];

export const CONTROLLED_EXPERIMENT_RUN_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type ControlledExperimentRunStatus = (typeof CONTROLLED_EXPERIMENT_RUN_STATUSES)[number];

export type ControlledExperimentVariantKey = "baseline" | "candidate";
export type ControlledExperimentUsageAccountingStatus = "pending" | "complete";

export type ControlledExperimentBudget = {
  perRunTimeoutMs: number;
  experimentDeadlineMs: number;
  maxTotalTokens: number;
};

export type ControlledExperimentVariantConfig = {
  engine: EngineType;
  model: string;
  effort: string | null;
};

export type ControlledExperimentVariant = ControlledExperimentVariantConfig & {
  id: string;
  variantKey: ControlledExperimentVariantKey;
  configSha256: string;
  promptDefinitionSha256: string;
  frozenAt: number;
};

export type ControlledExperimentSample = {
  id: string;
  evaluationItemId: string;
  promptSnapshotId: string;
  inputSha256: string;
  ordinal: number;
};

export type ControlledExperimentRun = {
  id: string;
  assignmentId: string;
  sampleId: string;
  variantId: string;
  variantKey: ControlledExperimentVariantKey;
  attemptNo: number;
  status: ControlledExperimentRunStatus;
  startedAt: number | null;
  completedAt: number | null;
  deadlineAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageAccountingStatus: ControlledExperimentUsageAccountingStatus;
  outputSha256: string | null;
  evaluationFactId: string | null;
  errorCode: string | null;
};

export type ControlledExperimentSummary = {
  id: string;
  contractVersion: typeof CONTROLLED_EXPERIMENT_CONTRACT_VERSION;
  name: string;
  workspaceId: string;
  evaluationSetId: string;
  status: ControlledExperimentStatus;
  statusVersion: number;
  sampleCount: number;
  completedPairCount: number;
  runCounts: Record<ControlledExperimentRunStatus, number>;
  budget: ControlledExperimentBudget;
  totalTokens: number | null;
  usageAccountingStatus: ControlledExperimentUsageAccountingStatus;
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type ControlledExperimentDetail = ControlledExperimentSummary & {
  freezeRevision: number;
  freezeDigest: string | null;
  variants: ControlledExperimentVariant[];
  samples: ControlledExperimentSample[];
  runs: ControlledExperimentRun[];
};

export type ControlledExperimentCreateRequest = {
  name: string;
  workspaceId: string;
  evaluationSetId: string;
  candidate: ControlledExperimentVariantConfig;
  budget: ControlledExperimentBudget;
  idempotencyKey: string;
};

export type ControlledExperimentListResponse = {
  items: ControlledExperimentSummary[];
  total: number;
  page: number;
  pageSize: number;
};

export type ControlledExperimentFreezeRpcItem = {
  evaluationItemId: string;
  sourceInstanceId: string;
  nodeId: string;
  promptSnapshotId: string;
  expectedPromptSha256: string;
  ordinal: number;
};

export type ControlledExperimentFreezeRpcRequest = {
  contractVersion: typeof CONTROLLED_EXPERIMENT_CONTRACT_VERSION;
  experimentId: string;
  freezeRevision: number;
  workspaceId: string;
  baselineCohort: {
    workflowSnapshotHash: string;
    nodeId: string;
    roleSnapshotHash: string;
    promptDefinitionHash: string;
    engine: EngineType;
    model: string;
    effort: string | null;
  };
  candidate: ControlledExperimentVariantConfig;
  budget: ControlledExperimentBudget;
  items: ControlledExperimentFreezeRpcItem[];
};

export type ControlledExperimentFrozenVariant = ControlledExperimentVariantConfig & {
  variantKey: ControlledExperimentVariantKey;
  configSha256: string;
  promptDefinitionSha256: string;
};

export type ControlledExperimentFreezeRpcResponse = {
  ok: true;
  experimentId: string;
  freezeRevision: number;
  freezeDigest: string;
  variants: ControlledExperimentFrozenVariant[];
  samples: Array<ControlledExperimentSample & { localSnapshotId: string }>;
};

export type ControlledExperimentRunStartRpcRequest = {
  contractVersion: typeof CONTROLLED_EXPERIMENT_CONTRACT_VERSION;
  /** Server 固定冻结工作区；旧单库调用仅可由已选定工作区入口省略。 */
  workspaceId?: string;
  experimentId: string;
  runId: string;
  assignmentId: string;
  sampleId: string;
  variantKey: ControlledExperimentVariantKey;
  attemptNo: number;
  dispatchToken: string;
  inputSha256: string;
  configSha256: string;
  deadlineAt: number;
};

export type ControlledExperimentRunStatusRpcRequest = {
  contractVersion: typeof CONTROLLED_EXPERIMENT_CONTRACT_VERSION;
  /** 状态与取消沿冻结工作区定位，禁止根据裸 runId 反查。 */
  workspaceId?: string;
  experimentId: string;
  runId: string;
  dispatchTokenSha256: string;
};

export type ControlledExperimentRunCancelRpcRequest = ControlledExperimentRunStatusRpcRequest;

export type ControlledExperimentRunRpcResponse = {
  ok: true;
  experimentId: string;
  runId: string;
  status: ControlledExperimentRunStatus;
  startedAt: number | null;
  completedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageAccountingStatus: ControlledExperimentUsageAccountingStatus;
  outputSha256: string | null;
  errorCode: string | null;
};

export type ControlledExperimentRunRpcFailureResponse = {
  ok: false;
  experimentId: string;
  runId: string;
  code: "LOCAL_EVIDENCE_MISSING" | "SIDE_EFFECT_BLOCKED" | "FREEZE_EVIDENCE_INVALID";
} & Pick<
  ControlledExperimentRunRpcResponse,
  "inputTokens" | "outputTokens" | "totalTokens" | "usageAccountingStatus"
>;

export type ControlledExperimentRunRpcResult = ControlledExperimentRunRpcResponse | ControlledExperimentRunRpcFailureResponse;

/** Returns whether an experiment can no longer accept control-plane transitions. */
export function isControlledExperimentTerminal(status: ControlledExperimentStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

/** Returns whether a Run outcome is immutable except for pending usage reconciliation. */
export function isControlledExperimentRunTerminal(status: ControlledExperimentRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled";
}
