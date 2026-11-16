import type {
  OrchestrationMetricCodeAttributionBatch,
  OrchestrationMetricCodeAttributionIngestBatchInput,
  OrchestrationMetricCodeAttributionRetentionIngestInput,
  OrchestrationMetricCodeAttributionRetentionIngestReceipt,
  OrchestrationMetricDeliveryAssociation,
} from "@codeflowai/shared";
import { ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RECONCILIATION_STATUSES } from "@codeflowai/shared";

import {
  createOrchAssetHttpJsonClient,
  type OrchAssetHttpFailure,
  type OrchAssetHttpFailureKind,
  type OrchAssetHttpFetch,
  type OrchAssetHttpJsonClientOptions,
  type OrchAssetHttpJsonClientPolicy,
} from "./orchAssetHttpJsonClient.js";

const UPLOAD_PATH = "/api/client/orchestration-metrics/code-attribution/batches";
const RETENTION_UPLOAD_PATH = "/api/client/orchestration-metrics/code-attribution/retention-observations";

export type CodeAttributionHttpEndpoint = "upload" | "retentionUpload" | "renewAssociation";
export type CodeAttributionHttpTransportErrorCode =
  | "CODE_ATTRIBUTION_SYNC_CONFIG_INVALID"
  | "CODE_ATTRIBUTION_SYNC_REQUEST_INVALID"
  | "CODE_ATTRIBUTION_SYNC_NETWORK_FAILED"
  | "CODE_ATTRIBUTION_SYNC_TIMEOUT"
  | "CODE_ATTRIBUTION_SYNC_RESPONSE_TOO_LARGE"
  | "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID"
  | "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED";

export type CodeAttributionHttpTransportOptions = OrchAssetHttpJsonClientOptions;
export type { OrchAssetHttpFetch as CodeAttributionHttpFetch };

const ERROR_CODES: Record<OrchAssetHttpFailureKind, CodeAttributionHttpTransportErrorCode> = {
  config_invalid: "CODE_ATTRIBUTION_SYNC_CONFIG_INVALID",
  request_invalid: "CODE_ATTRIBUTION_SYNC_REQUEST_INVALID",
  network_failed: "CODE_ATTRIBUTION_SYNC_NETWORK_FAILED",
  timeout: "CODE_ATTRIBUTION_SYNC_TIMEOUT",
  response_too_large: "CODE_ATTRIBUTION_SYNC_RESPONSE_TOO_LARGE",
  response_invalid: "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID",
  server_rejected: "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED",
};

export class CodeAttributionHttpTransportError extends Error {
  /** Creates one content-safe transport failure with Server correlation metadata. */
  constructor(
    readonly code: CodeAttributionHttpTransportErrorCode,
    readonly status: number | null,
    readonly serverCode: string | null,
    readonly requestId: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAttributionHttpTransportError";
  }
}

export type CodeAttributionHttpTransport = {
  renewAssociation?(input: { associationId: string; sourceWorkspaceId: string; sourceInstanceId: string }): Promise<OrchestrationMetricDeliveryAssociation>;
  upload(batch: OrchestrationMetricCodeAttributionIngestBatchInput): Promise<OrchestrationMetricCodeAttributionBatch>;
  uploadRetention(observation: OrchestrationMetricCodeAttributionRetentionIngestInput): Promise<OrchestrationMetricCodeAttributionRetentionIngestReceipt>;
};

const HTTP_POLICY: OrchAssetHttpJsonClientPolicy<CodeAttributionHttpEndpoint, CodeAttributionHttpTransportError> = {
  label: "代码归因同步",
  retainServerMessage: false,
  retainNetworkCauseMessage: false,
  /** Maps a generic HTTP failure into the stable code-attribution transport contract. */
  createError(failure) {
    return new CodeAttributionHttpTransportError(
      ERROR_CODES[failure.kind],
      failure.status,
      failure.serverCode,
      failure.requestId,
      failure.message,
      failure.cause ? { cause: failure.cause } : undefined,
    );
  },
  /** Prevents domain failures from being remapped as generic network errors. */
  isTransportError(error): error is CodeAttributionHttpTransportError {
    return error instanceof CodeAttributionHttpTransportError;
  },
};

/** Creates the authenticated Client-to-Server code-attribution transport. */
export function createCodeAttributionHttpTransport(
  config: { serverWsUrl: string; apiKey: string },
  options: CodeAttributionHttpTransportOptions = {},
): CodeAttributionHttpTransport {
  const client = createOrchAssetHttpJsonClient(config, options, HTTP_POLICY);
  return {
    /** 沿原签发服务重新验证当前账号与实例归属，续签不改变事实内容。 */
    async renewAssociation(input) {
      const response = await client.post("renewAssociation", "/api/client/orchestration-metrics/delivery/associations", input);
      const value = response.envelope as Partial<OrchestrationMetricDeliveryAssociation>;
      if (typeof value.associationId !== "string" || !value.associationId || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
        throw new CodeAttributionHttpTransportError("CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID", response.status, null, null, "关联续签回执无效");
      }
      return { associationId: value.associationId, expiresAt: value.expiresAt };
    },
    /** Uploads one leased batch and verifies the returned immutable receipt identity. */
    async upload(batch) {
      const response = await client.post("upload", UPLOAD_PATH, batch);
      return readReceipt(response.envelope, response.status, batch);
    },
    /** Uploads one due retention observation and verifies its full immutable identity. */
    async uploadRetention(observation) {
      const response = await client.post("retentionUpload", RETENTION_UPLOAD_PATH, observation);
      return readRetentionReceipt(response.envelope, response.status, observation);
    },
  };
}

/** Validates a retention receipt before deleting Client-local lineage evidence. */
function readRetentionReceipt(
  envelope: Record<string, unknown>,
  status: number,
  request: OrchestrationMetricCodeAttributionRetentionIngestInput,
): OrchestrationMetricCodeAttributionRetentionIngestReceipt {
  const qualityStatus = exactText(envelope.qualityStatus);
  const qualityReasons = Array.isArray(envelope.qualityReasons)
    ? envelope.qualityReasons.map((reason) => requiredText(reason, "qualityReasons"))
    : (() => { throw responseError(status, "代码留存同步响应质量原因无效", "retentionUpload"); })();
  const receipt = {
    id: requiredText(envelope.id, "id"),
    attributionFactId: requiredText(envelope.attributionFactId, "attributionFactId"),
    sourceWorkspaceId: requiredText(envelope.sourceWorkspaceId, "sourceWorkspaceId"),
    sourceInstanceId: requiredText(envelope.sourceInstanceId, "sourceInstanceId"),
    repository: requiredText(envelope.repository, "repository"),
    commitSha: requiredText(envelope.commitSha, "commitSha"),
    fileIdentitySha256: requiredText(envelope.fileIdentitySha256, "fileIdentitySha256"),
    windowDays: nonNegativeInteger(envelope.windowDays, "windowDays"),
    stillPresentAiAddedLines: envelope.stillPresentAiAddedLines === null
      ? null
      : nonNegativeInteger(envelope.stillPresentAiAddedLines, "stillPresentAiAddedLines"),
    qualityStatus,
    qualityReasons,
    retentionEvidenceSha256: envelope.retentionEvidenceSha256 === null
      ? null
      : requiredText(envelope.retentionEvidenceSha256, "retentionEvidenceSha256"),
    evidenceRef: envelope.evidenceRef === null ? null : requiredText(envelope.evidenceRef, "evidenceRef"),
    observedAt: envelope.observedAt === null ? null : nonNegativeInteger(envelope.observedAt, "observedAt"),
    createdAt: nonNegativeInteger(envelope.createdAt, "createdAt"),
  } as OrchestrationMetricCodeAttributionRetentionIngestReceipt;
  if (
    receipt.id !== request.observationId
    || receipt.sourceWorkspaceId !== request.sourceWorkspaceId
    || receipt.sourceInstanceId !== request.sourceInstanceId
    || receipt.repository !== request.repository
    || receipt.commitSha !== request.commitSha
    || receipt.fileIdentitySha256 !== request.fileIdentitySha256
    || receipt.windowDays !== request.windowDays
    || receipt.qualityStatus !== request.qualityStatus
    || receipt.stillPresentAiAddedLines !== request.stillPresentAiAddedLines
    || JSON.stringify(receipt.qualityReasons) !== JSON.stringify(request.qualityReasons)
    || receipt.retentionEvidenceSha256 !== request.retentionEvidenceSha256
    || receipt.evidenceRef !== request.evidenceRef
    || receipt.observedAt !== request.observedAt
  ) {
    throw responseError(status, "代码留存同步响应与请求身份不一致", "retentionUpload");
  }
  return receipt;
}

/** Validates the Server receipt before the outbox lease can be deleted. */
function readReceipt(
  envelope: Record<string, unknown>,
  status: number,
  request: OrchestrationMetricCodeAttributionIngestBatchInput,
): OrchestrationMetricCodeAttributionBatch {
  const scope = isRecord(envelope.scope) ? envelope.scope : null;
  const reconciliationStatus = exactText(envelope.reconciliationStatus);
  const scopeLabel = typeof scope?.label === "string" ? scope.label : null;
  const receipt: OrchestrationMetricCodeAttributionBatch = {
    id: requiredText(envelope.id, "id"),
    sourceSystem: requiredText(envelope.sourceSystem, "sourceSystem"),
    sourceBatchId: requiredText(envelope.sourceBatchId, "sourceBatchId"),
    scope: {
      scopeKind: requiredText(scope?.scopeKind, "scope.scopeKind") as OrchestrationMetricCodeAttributionBatch["scope"]["scopeKind"],
      scopeId: scope?.scopeId === null ? null : requiredText(scope?.scopeId, "scope.scopeId"),
      ...(scopeLabel ? { label: scopeLabel } : {}),
    },
    sourceRecordCount: nonNegativeInteger(envelope.sourceRecordCount, "sourceRecordCount"),
    acceptedRecordCount: nonNegativeInteger(envelope.acceptedRecordCount, "acceptedRecordCount"),
    sourceContentSha256: requiredText(envelope.sourceContentSha256, "sourceContentSha256"),
    contentSha256: requiredText(envelope.contentSha256, "contentSha256"),
    reconciliationStatus: reconciliationStatus as OrchestrationMetricCodeAttributionBatch["reconciliationStatus"],
    createdAt: nonNegativeInteger(envelope.createdAt, "createdAt"),
    updatedAt: nonNegativeInteger(envelope.updatedAt, "updatedAt"),
  };
  if (!ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RECONCILIATION_STATUSES.includes(receipt.reconciliationStatus)) {
    throw responseError(status, "代码归因同步响应对账状态无效");
  }
  if (
    receipt.sourceSystem !== request.sourceSystem
    || receipt.sourceBatchId !== request.sourceBatchId
    || receipt.sourceRecordCount !== request.sourceRecordCount
    || receipt.acceptedRecordCount !== request.facts.length
    || receipt.sourceContentSha256 !== request.sourceContentSha256
    || receipt.contentSha256 !== request.sourceContentSha256
  ) {
    throw responseError(status, "代码归因同步响应与请求身份不一致");
  }
  return receipt;
}

/** Requires one exact non-empty response string. */
function requiredText(value: unknown, field: string): string {
  const text = exactText(value);
  if (!text) throw responseError(200, `代码归因同步响应字段无效：${field}`);
  return text;
}

/** Reads exact text without coercing non-string response fields. */
function exactText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
}

/** Requires one non-negative safe integer response field. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw responseError(200, `代码归因同步响应字段无效：${field}`);
  }
  return value;
}

/** Checks a plain response object without accepting arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Creates one stable malformed-response error without retaining response content. */
function responseError(
  status: number,
  message: string,
  endpoint: CodeAttributionHttpEndpoint = "upload",
): CodeAttributionHttpTransportError {
  return HTTP_POLICY.createError({
    kind: "response_invalid",
    endpoint,
    status,
    serverCode: null,
    requestId: null,
    serverMessage: null,
    message,
  });
}
