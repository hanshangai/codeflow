import type {
  OrchestrationMetricCodeAttributionExternalAdapterBatchInput,
  OrchestrationMetricCodeAttributionExternalCoverageState,
  OrchestrationMetricCodeAttributionExternalDeliveryCommitInput,
  OrchestrationMetricCodeAttributionExternalSourceSystem,
  OrchestrationMetricCodeAttributionIngestBatchInput,
  OrchestrationMetricCodeAttributionLineCounts,
  OrchestrationMetricCodeAttributionQualityReason,
  OrchestrationMetricCodeAttributionQualityStatus,
  OrchestrationMetricCodeAttributionRates,
  OrchestrationMetricCodeAttributionRetentionWindowDays,
  OrchestrationMetricDeliveryIngestEvent,
} from "../types/orchestrationMetrics.js";
import { ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX } from "../types/orchestrationMetrics.js";

const EXTERNAL_ADAPTER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const CODE_ATTRIBUTION_SOURCE_SYSTEM_MAX_LENGTH = 80;
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const EXTERNAL_DELIVERY_EVIDENCE_REF_PATTERN = /^external-delivery-evidence:[a-f0-9]{64}$/u;

export type OrchestrationCodeAttributionFileInput = {
  path: string;
  aiGeneratedAddedLines: readonly string[];
  aiCandidateAddedLines: readonly string[];
  committedAddedLines: readonly string[];
  /** Lines still attributed by Git lineage to the target commit, not all current file lines. */
  retentionObservedLines?: readonly string[] | null;
};

export type OrchestrationCodeAttributionCalculation = {
  fileCount: number;
  counts: OrchestrationMetricCodeAttributionLineCounts;
  rates: OrchestrationMetricCodeAttributionRates;
};

export type OrchestrationCodeAttributionPayload = Pick<
  OrchestrationMetricCodeAttributionIngestBatchInput,
  "commit" | "facts"
>;

/** Creates the only canonical source-system identity accepted from an external AI Hook adapter. */
export function buildOrchestrationCodeAttributionExternalSourceSystem(
  adapterId: string,
): OrchestrationMetricCodeAttributionExternalSourceSystem {
  if (typeof adapterId !== "string" || !EXTERNAL_ADAPTER_ID_PATTERN.test(adapterId)) {
    throw new Error("外部代码归因适配器标识必须是规范的小写标识");
  }
  const sourceSystem = `${ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX}${adapterId}` as const;
  if (sourceSystem.length > CODE_ATTRIBUTION_SOURCE_SYSTEM_MAX_LENGTH) {
    throw new Error("外部代码归因适配器标识过长");
  }
  return sourceSystem;
}

/** Checks the canonical external source namespace without accepting arbitrary source-system text. */
export function isOrchestrationCodeAttributionExternalSourceSystem(
  value: unknown,
): value is OrchestrationMetricCodeAttributionExternalSourceSystem {
  if (typeof value !== "string" || !value.startsWith(ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX)) {
    return false;
  }
  return value.length <= CODE_ATTRIBUTION_SOURCE_SYSTEM_MAX_LENGTH
    && EXTERNAL_ADAPTER_ID_PATTERN.test(value.slice(ORCHESTRATION_METRIC_CODE_ATTRIBUTION_EXTERNAL_SOURCE_PREFIX.length));
}

/** Maps one explicit external collection state to the shared quality contract. */
export function resolveOrchestrationCodeAttributionExternalCoverage(
  state: OrchestrationMetricCodeAttributionExternalCoverageState,
): { qualityStatus: OrchestrationMetricCodeAttributionQualityStatus; qualityReasons: OrchestrationMetricCodeAttributionQualityReason[] } {
  if (state === "complete") return { qualityStatus: "complete", qualityReasons: [] };
  const supported = new Set<OrchestrationMetricCodeAttributionExternalCoverageState>([
    "hook_not_installed",
    "unsupported_tool",
    "ai_trace_missing",
    "commit_diff_missing",
    "association_missing",
    "history_rewritten",
  ]);
  if (!supported.has(state)) throw new Error("外部代码归因覆盖状态无效");
  return { qualityStatus: "unavailable", qualityReasons: [state] };
}

/** Rebuilds one external adapter batch through the existing source-code-free payload whitelist. */
export function buildOrchestrationCodeAttributionExternalAdapterBatch(
  input: OrchestrationMetricCodeAttributionExternalAdapterBatchInput,
): OrchestrationMetricCodeAttributionIngestBatchInput {
  if (!input || typeof input !== "object") throw new Error("外部代码归因批次必须是对象");
  const payload = JSON.parse(serializeOrchestrationCodeAttributionPayload(input)) as OrchestrationCodeAttributionPayload;
  if (payload.facts.some((fact) => fact.executionRefs.length > 0)) {
    throw new Error("外部代码归因批次不能携带 CodeFlow 执行引用");
  }
  return {
    associationId: input.associationId,
    sourceSystem: buildOrchestrationCodeAttributionExternalSourceSystem(input.adapterId),
    sourceBatchId: input.sourceBatchId,
    sourceRecordCount: input.sourceRecordCount,
    sourceContentSha256: input.sourceContentSha256,
    ...payload,
  };
}

/** Maps authoritative commit identity to the established delivery event without carrying the diff body. */
export function buildOrchestrationCodeAttributionExternalDeliveryCommit(
  input: OrchestrationMetricCodeAttributionExternalDeliveryCommitInput,
): OrchestrationMetricDeliveryIngestEvent {
  if (!input || typeof input !== "object") throw new Error("外部权威提交映射必须是对象");
  if (!COMMIT_SHA_PATTERN.test(input.commitSha)) throw new Error("外部权威提交必须使用完整小写 commit SHA");
  if (!EXTERNAL_DELIVERY_EVIDENCE_REF_PATTERN.test(input.evidenceRef)) {
    throw new Error("外部权威提交必须使用受限差异证据引用");
  }
  if (!Number.isSafeInteger(input.committedAt) || input.committedAt <= 0) {
    throw new Error("外部权威提交时间无效");
  }
  return {
    associationId: requireExternalAdapterText(input.associationId, "associationId", 2_048),
    externalId: requireExternalAdapterText(input.externalId, "externalId", 200),
    sourceWorkspaceId: requireExternalAdapterText(input.sourceWorkspaceId, "sourceWorkspaceId", 200),
    sourceInstanceId: requireExternalAdapterText(input.sourceInstanceId, "sourceInstanceId", 200),
    kind: "commit",
    status: "succeeded",
    environment: null,
    repository: requireExternalAdapterText(input.repository, "repository", 300),
    commitSha: input.commitSha,
    pullRequestId: null,
    relatedExternalId: null,
    isRework: null,
    eventAt: input.committedAt,
    evidenceRef: input.evidenceRef,
  };
}

/** Serializes the public attribution payload with one cross-boundary field whitelist and stable order. */
export function serializeOrchestrationCodeAttributionPayload(
  payload: OrchestrationCodeAttributionPayload,
): string {
  return JSON.stringify({
    commit: {
      sourceWorkspaceId: payload.commit.sourceWorkspaceId,
      sourceInstanceId: payload.commit.sourceInstanceId,
      repository: payload.commit.repository,
      commitSha: payload.commit.commitSha,
      disposition: payload.commit.disposition,
      qualityStatus: payload.commit.qualityStatus,
      qualityReasons: payload.commit.qualityReasons,
      commitEvidenceSha256: payload.commit.commitEvidenceSha256,
      observedAt: payload.commit.observedAt,
    },
    facts: payload.facts.map((fact) => ({
      sourceWorkspaceId: fact.sourceWorkspaceId,
      sourceInstanceId: fact.sourceInstanceId,
      repository: fact.repository,
      commitSha: fact.commitSha,
      fileIdentitySha256: fact.fileIdentitySha256,
      language: fact.language,
      aiGeneratedAddedLines: fact.aiGeneratedAddedLines,
      aiCandidateAddedLines: fact.aiCandidateAddedLines,
      retainedAiAddedLines: fact.retainedAiAddedLines,
      committedAddedLines: fact.committedAddedLines,
      eligibleCommittedAddedLines: fact.eligibleCommittedAddedLines,
      coveredCommittedAddedLines: fact.coveredCommittedAddedLines,
      qualityStatus: fact.qualityStatus,
      qualityReasons: fact.qualityReasons,
      aiEvidenceSha256: fact.aiEvidenceSha256,
      commitEvidenceSha256: fact.commitEvidenceSha256,
      evidenceRef: fact.evidenceRef,
      executionRefs: fact.executionRefs.map((reference) => ({
        nodeId: reference.nodeId,
        attemptId: reference.attemptId,
        attemptNo: reference.attemptNo,
        promptSnapshotId: reference.promptSnapshotId,
        threadId: reference.threadId,
        turnId: reference.turnId,
        evidenceSha256: reference.evidenceSha256,
      })),
      observedAt: fact.observedAt,
    })),
  });
}

/** Normalizes one code line for attribution while excluding blank lines. */
export function normalizeOrchestrationCodeAttributionLine(line: string): string | null {
  if (typeof line !== "string") throw new Error("代码归因行必须是字符串");
  const normalized = line.replace(/\r$/u, "").replace(/^[ \t]+/u, "");
  return normalized.length ? normalized : null;
}

/** Counts a duplicate-preserving intersection without exposing source lines. */
export function countOrchestrationCodeAttributionMatches(
  candidateLines: readonly string[],
  targetLines: readonly string[],
): number {
  return sumLineCounts(intersectLineCounts(buildLineCounts(candidateLines), buildLineCounts(targetLines)));
}

/** Returns the normalized duplicate-preserving intersection for Client-local retention observation. */
export function selectOrchestrationCodeAttributionMatches(
  candidateLines: readonly string[],
  targetLines: readonly string[],
): string[] {
  const intersection = intersectLineCounts(buildLineCounts(candidateLines), buildLineCounts(targetLines));
  return [...intersection.entries()].flatMap(([line, count]) => Array<string>(count).fill(line));
}

/** Calculates complete-evidence attribution for one optional 7/30-day retention window. */
export function calculateOrchestrationCodeAttribution(
  files: readonly OrchestrationCodeAttributionFileInput[],
  retentionWindowDays: OrchestrationMetricCodeAttributionRetentionWindowDays | null = null,
): OrchestrationCodeAttributionCalculation {
  if (!Array.isArray(files)) throw new Error("代码归因文件集合必须是数组");
  ensureRetentionWindow(retentionWindowDays);
  for (const file of files) {
    const observed = file?.retentionObservedLines;
    if (observed !== undefined && observed !== null && !Array.isArray(observed)) {
      throw new Error("代码归因留存行集合必须是数组、null 或未提供");
    }
  }
  const hasRetentionObservation = files.some((file) => Array.isArray(file.retentionObservedLines));
  if (hasRetentionObservation && retentionWindowDays === null) {
    throw new Error("代码归因留存行必须绑定 7 天或 30 天观察窗口");
  }

  const paths = new Set<string>();
  const totals: OrchestrationMetricCodeAttributionLineCounts = {
    aiGeneratedAddedLines: 0,
    aiCandidateAddedLines: 0,
    retainedAiAddedLines: 0,
    committedAddedLines: 0,
    eligibleCommittedAddedLines: 0,
    coveredCommittedAddedLines: 0,
    stillPresentAiAddedLines: retentionWindowDays !== null
      && files.length > 0
      && files.every((file) => Array.isArray(file.retentionObservedLines))
      ? 0
      : null,
  };

  for (const file of files) {
    const path = normalizeRepositoryRelativePath(file.path);
    if (paths.has(path)) throw new Error(`代码归因文件路径重复：${path}`);
    paths.add(path);

    const generated = buildLineCounts(file.aiGeneratedAddedLines);
    const candidates = buildLineCounts(file.aiCandidateAddedLines);
    ensureLineCountsContained(candidates, generated, path);
    const committed = buildLineCounts(file.committedAddedLines);
    const retained = intersectLineCounts(candidates, committed);

    const generatedCount = sumLineCounts(generated);
    const candidateCount = sumLineCounts(candidates);
    const committedCount = sumLineCounts(committed);
    const retainedCount = sumLineCounts(retained);
    totals.aiGeneratedAddedLines += generatedCount;
    totals.aiCandidateAddedLines += candidateCount;
    totals.retainedAiAddedLines += retainedCount;
    totals.committedAddedLines += committedCount;
    totals.eligibleCommittedAddedLines += committedCount;
    totals.coveredCommittedAddedLines += committedCount;

    if (totals.stillPresentAiAddedLines !== null) {
      const observed = buildLineCounts(file.retentionObservedLines ?? []);
      totals.stillPresentAiAddedLines += sumLineCounts(intersectLineCounts(retained, observed));
    }
  }

  return {
    fileCount: paths.size,
    counts: totals,
    rates: calculateOrchestrationCodeAttributionRates(totals, retentionWindowDays),
  };
}

/** Derives aggregate ratios for one optional retention window after validating count invariants. */
export function calculateOrchestrationCodeAttributionRates(
  counts: OrchestrationMetricCodeAttributionLineCounts,
  retentionWindowDays: OrchestrationMetricCodeAttributionRetentionWindowDays | null = null,
): OrchestrationMetricCodeAttributionRates {
  ensureRetentionWindow(retentionWindowDays);
  const integerFields: Array<keyof Omit<OrchestrationMetricCodeAttributionLineCounts, "stillPresentAiAddedLines">> = [
    "aiGeneratedAddedLines",
    "aiCandidateAddedLines",
    "retainedAiAddedLines",
    "committedAddedLines",
    "eligibleCommittedAddedLines",
    "coveredCommittedAddedLines",
  ];
  for (const field of integerFields) ensureNonNegativeSafeInteger(counts[field], field);
  if (counts.stillPresentAiAddedLines !== null) ensureNonNegativeSafeInteger(counts.stillPresentAiAddedLines, "stillPresentAiAddedLines");

  if (counts.aiCandidateAddedLines > counts.aiGeneratedAddedLines) throw new Error("AI 候选新增行数不能超过 AI 生成新增行数");
  if (counts.retainedAiAddedLines > counts.aiCandidateAddedLines) throw new Error("AI 采纳新增行数不能超过 AI 候选新增行数");
  if (counts.retainedAiAddedLines > counts.coveredCommittedAddedLines) throw new Error("AI 采纳新增行数不能超过已覆盖提交新增行数");
  if (counts.eligibleCommittedAddedLines > counts.committedAddedLines) throw new Error("符合资格的提交新增行数不能超过提交新增行数");
  if (counts.coveredCommittedAddedLines > counts.eligibleCommittedAddedLines) throw new Error("已覆盖提交新增行数不能超过符合资格的提交新增行数");
  if (counts.stillPresentAiAddedLines !== null && counts.stillPresentAiAddedLines > counts.retainedAiAddedLines) {
    throw new Error("AI 留存行数不能超过提交时采纳行数");
  }
  if (counts.stillPresentAiAddedLines !== null && retentionWindowDays === null) {
    throw new Error("AI 留存行数必须绑定 7 天或 30 天观察窗口");
  }

  return {
    aiContributionShare: divideOrNull(counts.retainedAiAddedLines, counts.coveredCommittedAddedLines),
    aiOutputAdoptionRate: divideOrNull(counts.retainedAiAddedLines, counts.aiGeneratedAddedLines),
    aiCodeRetentionRate: counts.stillPresentAiAddedLines === null
      ? null
      : divideOrNull(counts.stillPresentAiAddedLines, counts.retainedAiAddedLines),
    collectionCoverageRate: divideOrNull(counts.coveredCommittedAddedLines, counts.eligibleCommittedAddedLines),
    retentionWindowDays,
  };
}

/** Canonicalizes and validates one Git repository-relative path without case folding. */
function normalizeRepositoryRelativePath(path: string): string {
  if (typeof path !== "string") throw new Error("代码归因文件路径必须是字符串");
  let normalized = path.replace(/\\/gu, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`代码归因文件路径必须是规范的仓库相对路径：${path}`);
  }
  return normalized;
}

/** Builds normalized line multiplicities and omits blank lines. */
function buildLineCounts(lines: readonly string[]): Map<string, number> {
  if (!Array.isArray(lines)) throw new Error("代码归因行集合必须是数组");
  const counts = new Map<string, number>();
  for (const line of lines) {
    const normalized = normalizeOrchestrationCodeAttributionLine(line);
    if (normalized === null) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

/** Returns the multiplicity intersection of two normalized line maps. */
function intersectLineCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): Map<string, number> {
  const intersection = new Map<string, number>();
  for (const [line, leftCount] of left) {
    const count = Math.min(leftCount, right.get(line) ?? 0);
    if (count > 0) intersection.set(line, count);
  }
  return intersection;
}

/** Rejects candidate attribution lines that have no corresponding AI generation evidence. */
function ensureLineCountsContained(candidates: ReadonlyMap<string, number>, generated: ReadonlyMap<string, number>, path: string): void {
  for (const [line, count] of candidates) {
    if ((generated.get(line) ?? 0) < count) throw new Error(`AI 候选新增行缺少生成证据：${path}`);
  }
}

/** Sums multiplicities without converting the map back to source lines. */
function sumLineCounts(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/** Validates persisted count inputs before any ratio is produced. */
function ensureNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`代码归因计数字段必须是非负安全整数：${field}`);
}

/** Rejects unsupported retention windows before they can be persisted or displayed. */
function ensureRetentionWindow(value: OrchestrationMetricCodeAttributionRetentionWindowDays | null): void {
  if (value !== null && value !== 7 && value !== 30) throw new Error("代码归因留存窗口只能是 7 天或 30 天");
}

/** Divides aggregate counts while preserving null for an empty denominator. */
function divideOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Requires exact bounded adapter text without trimming or coercing untrusted values. */
function requireExternalAdapterText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`外部代码归因字段无效：${field}`);
  }
  return value;
}
