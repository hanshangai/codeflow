import crypto from "node:crypto";
import path from "node:path";

import {
  calculateOrchestrationCodeAttribution,
  ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RETENTION_WINDOWS,
  selectOrchestrationCodeAttributionMatches,
  type OrchestrationId,
  type OrchestrationMetricCodeAttributionCommitCollectRequest,
  type OrchestrationMetricCodeAttributionCommitCollectResponse,
  type OrchestrationMetricCodeAttributionCommitObservation,
  type OrchestrationMetricCodeAttributionExecutionRef,
  type OrchestrationMetricCodeAttributionIngestFact,
  type OrchestrationMetricCodeAttributionQualityReason,
  type OrchestrationMetricCodeAttributionQualityStatus,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import {
  hashCodeAttributionOutboxPayload,
  type CodeAttributionOutboxPayload,
} from "../db/repos/codeAttributionOutboxRepo.js";
import {
  readCommitAttributionSnapshot,
  type GitCommitAttributionFile,
  type GitCommitAttributionSnapshot,
} from "../git/gitService.js";
import {
  buildLocalCodeAttributionEvidence,
  type LocalCodeAttributionEvidenceIssue,
  type LocalCodeAttributionEvidenceResult,
} from "./codeAttributionEvidence.js";

const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** 显式提交归因分段读取与落库，Git等待不占同步数据库许可。 */
export async function collectCodeAttributionCommit(
  db: ClientDb,
  input: OrchestrationMetricCodeAttributionCommitCollectRequest,
  options?: { now?: number; withDatabase?: <T>(operation: () => T) => Promise<T> },
): Promise<OrchestrationMetricCodeAttributionCommitCollectResponse> {
  const now = requireTimestamp(options?.now ?? Date.now(), "now");
  /** 所有仓储访问共用调用方准入，未启用Writer时保持既有同步实现。 */
  const database = <T>(operation: () => T): Promise<T> => options?.withDatabase ? options.withDatabase(operation) : Promise.resolve(operation());
  const request = validateCollectRequest(input, now);
  const instance = await database(() => db.orchInstances.get(request.instanceId));
  if (!instance) throw serviceError("CODE_ATTRIBUTION_COMMIT_INSTANCE_NOT_FOUND", "编排实例不存在");
  if (String(instance.workspaceId) !== String(request.workspaceId)) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_ASSOCIATION_MISMATCH", "编排实例不属于所选工作区");
  }
  const workspace = await database(() => db.workspaces.get(request.workspaceId));
  if (!workspace) throw serviceError("CODE_ATTRIBUTION_COMMIT_WORKSPACE_NOT_FOUND", "工作区不存在");

  let commit: GitCommitAttributionSnapshot;
  try {
    commit = await readCommitAttributionSnapshot(workspace.path, request.commitSha, request.repositoryPath);
  } catch (cause) {
    throw new CodeAttributionCommitServiceError(
      "CODE_ATTRIBUTION_COMMIT_GIT_READ_FAILED",
      "无法读取指定的 Git commit，请确认仓库和 commit 后重试。",
      { cause },
    );
  }
  if (commit.parentShas.length <= 1 && commit.files.length === 0) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_NO_CODE_CHANGES", "该提交不包含可统计的代码变更。");
  }

  let payload: CodeAttributionOutboxPayload;
  let retentionSeeds: CodeAttributionRetentionSeed[] = [];
  if (commit.parentShas.length > 1) {
    payload = buildMergeExclusionPayload(request, commit);
  } else {
    let evidence: LocalCodeAttributionEvidenceResult;
    try {
      evidence = await database(() => buildLocalCodeAttributionEvidence(db, { instanceId: request.instanceId }));
    } catch (cause) {
      throw new CodeAttributionCommitServiceError(
        "CODE_ATTRIBUTION_COMMIT_EVIDENCE_FAILED",
        "无法生成该实例的 AI 变更证据，请检查实例运行证据后重试。",
        { cause },
      );
    }
    const built = buildCommitPayload(request, commit, evidence);
    payload = built.payload;
    retentionSeeds = built.retentionSeeds;
  }

  const contentSha256 = hashCodeAttributionOutboxPayload(payload);
  const identitySha256 = sha256([
    "codeflow_client",
    String(request.workspaceId),
    String(request.instanceId),
    commit.repository,
    commit.commitSha,
  ].join("\0"));
  const outboxId = `code-attribution:${identitySha256}`;
  let queued: ReturnType<ClientDb["codeAttributionOutbox"]["enqueue"]>;
  await database(() => db.db.transaction(() => {
    queued = db.codeAttributionOutbox.enqueue({
      id: outboxId,
      sourceBatchId: outboxId,
      workspaceId: String(request.workspaceId),
      instanceId: String(request.instanceId),
      repository: commit.repository,
      commitSha: commit.commitSha,
      payload,
      contentSha256,
      associationId: request.associationId,
      associationExpiresAt: request.associationExpiresAt,
      now,
    });
    for (const seed of retentionSeeds) {
      for (const windowDays of ORCHESTRATION_METRIC_CODE_ATTRIBUTION_RETENTION_WINDOWS) {
        const dueAt = commit.committedAt + windowDays * 24 * 60 * 60 * 1_000;
        if (!Number.isSafeInteger(dueAt)) throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", "留存观察时间越界");
        db.codeAttributionRetentionTasks.enqueue({
          id: `code-attribution-retention:${sha256(`${identitySha256}\0${seed.fileIdentitySha256}\0${windowDays}`)}`,
          workspaceId: String(request.workspaceId),
          instanceId: String(request.instanceId),
          repositoryPath: commit.repositoryPath,
          repository: commit.repository,
          commitSha: commit.commitSha,
          filePath: seed.filePath,
          fileIdentitySha256: seed.fileIdentitySha256,
          retainedLines: seed.retainedLines,
          retainedAiAddedLines: seed.retainedLines.length,
          windowDays,
          dueAt,
          now,
        });
      }
    }
  })());
  return {
    outboxId,
    sourceBatchId: outboxId,
    contentSha256,
    repository: commit.repository,
    commitSha: commit.commitSha,
    factCount: payload.facts.length,
    qualityStatus: payload.commit.qualityStatus,
    qualityReasons: payload.commit.qualityReasons,
    replayed: queued!.replayed,
  };
}

/** Builds a commit-level exclusion without inventing a file identity for merge topology. */
function buildMergeExclusionPayload(
  request: ValidatedCollectRequest,
  commit: GitCommitAttributionSnapshot,
): CodeAttributionOutboxPayload {
  return {
    commit: createCommitObservation(request, commit, {
      disposition: "excluded",
      qualityStatus: "unavailable",
      qualityReasons: ["merge_commit"],
    }),
    facts: [],
  };
}

/** Reconciles authoritative commit files with local AI candidates and emits only public counts. */
function buildCommitPayload(
  request: ValidatedCollectRequest,
  commit: GitCommitAttributionSnapshot,
  evidence: LocalCodeAttributionEvidenceResult,
): { payload: CodeAttributionOutboxPayload; retentionSeeds: CodeAttributionRetentionSeed[] } {
  if (String(evidence.workspaceId) !== String(request.workspaceId) || String(evidence.instanceId) !== String(request.instanceId)) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_ASSOCIATION_MISMATCH", "AI 变更证据与 commit 关联身份不一致");
  }
  const evidenceIndex = indexLocalEvidence(commit.repositoryPath, evidence);
  const facts = commit.files.map((file) => buildFileFact(request, commit, file, evidenceIndex));
  const retentionSeeds = buildRetentionSeeds(commit.files, facts, evidenceIndex);
  const completeCount = facts.filter((fact) => fact.qualityStatus === "complete").length;
  const reasons = uniqueSorted(facts.flatMap((fact) => fact.qualityReasons));
  const allExcluded = facts.length > 0 && facts.every((fact) => fact.qualityReasons.includes("binary_file"));
  const qualityStatus: OrchestrationMetricCodeAttributionQualityStatus = reasons.length === 0
    ? "complete"
    : completeCount > 0
      ? "partial"
      : "unavailable";
  return {
    payload: {
      commit: createCommitObservation(request, commit, {
        disposition: allExcluded ? "excluded" : reasons.length > 0 ? "partial" : "matched",
        qualityStatus,
        qualityReasons: reasons,
      }),
      facts,
    },
    retentionSeeds,
  };
}

type CodeAttributionRetentionSeed = {
  filePath: string;
  fileIdentitySha256: string;
  retainedLines: string[];
};

/** Keeps only complete file facts and their normalized adopted lines in the Client-local task queue. */
function buildRetentionSeeds(
  files: GitCommitAttributionFile[],
  facts: OrchestrationMetricCodeAttributionIngestFact[],
  evidence: IndexedLocalEvidence,
): CodeAttributionRetentionSeed[] {
  return files.flatMap((file, index) => {
    const fact = facts[index]!;
    if (fact.qualityStatus !== "complete") return [];
    const sourcePaths = file.previousPath ? [file.path, file.previousPath] : [file.path];
    const preferredPath = sourcePaths.find((candidatePath) => evidence.candidatesByPath.has(candidatePath)) ?? file.path;
    const candidate = evidence.candidatesByPath.get(preferredPath);
    const retainedLines = selectOrchestrationCodeAttributionMatches(candidate?.candidateAddedLines ?? [], file.addedLines);
    if (retainedLines.length !== fact.retainedAiAddedLines) {
      throw serviceError("CODE_ATTRIBUTION_COMMIT_EVIDENCE_FAILED", "代码归因留存种子与文件事实计数不一致");
    }
    return [{ filePath: file.path, fileIdentitySha256: fact.fileIdentitySha256, retainedLines }];
  });
}

type IndexedLocalEvidence = {
  candidatesByPath: Map<string, LocalCodeAttributionEvidenceResult["candidateFiles"][number]>;
  patchesByPath: Map<string, LocalCodeAttributionEvidenceResult["patches"]>;
  issuesByPath: Map<string, LocalCodeAttributionEvidenceIssue[]>;
  globalIssues: LocalCodeAttributionEvidenceIssue[];
};

/** Converts workspace-relative evidence paths into the selected repository namespace. */
function indexLocalEvidence(repositoryPath: string, evidence: LocalCodeAttributionEvidenceResult): IndexedLocalEvidence {
  const candidatesByPath = new Map<string, LocalCodeAttributionEvidenceResult["candidateFiles"][number]>();
  for (const candidate of evidence.candidateFiles) {
    const repositoryRelativePath = toRepositoryRelativePath(repositoryPath, candidate.path);
    if (repositoryRelativePath) candidatesByPath.set(repositoryRelativePath, candidate);
  }
  const patchesByPath = new Map<string, LocalCodeAttributionEvidenceResult["patches"]>();
  for (const patch of evidence.patches) {
    const repositoryRelativePath = toRepositoryRelativePath(repositoryPath, patch.path);
    if (!repositoryRelativePath) continue;
    const patches = patchesByPath.get(repositoryRelativePath) ?? [];
    patches.push(patch);
    patchesByPath.set(repositoryRelativePath, patches);
  }
  const issuesByPath = new Map<string, LocalCodeAttributionEvidenceIssue[]>();
  const globalIssues: LocalCodeAttributionEvidenceIssue[] = [];
  for (const issue of evidence.issues) {
    if (!issue.path) {
      globalIssues.push(issue);
      continue;
    }
    const repositoryRelativePath = toRepositoryRelativePath(repositoryPath, issue.path);
    if (!repositoryRelativePath) continue;
    const issues = issuesByPath.get(repositoryRelativePath) ?? [];
    issues.push(issue);
    issuesByPath.set(repositoryRelativePath, issues);
  }
  return { candidatesByPath, patchesByPath, issuesByPath, globalIssues };
}

/** Calculates one file fact and withholds attribution counts when its evidence is incomplete. */
function buildFileFact(
  request: ValidatedCollectRequest,
  commit: GitCommitAttributionSnapshot,
  file: GitCommitAttributionFile,
  evidence: IndexedLocalEvidence,
): OrchestrationMetricCodeAttributionIngestFact {
  const fileIdentitySha256 = sha256(`${commit.repository}\0${file.path}`);
  if (file.isBinary) {
    return createFactIdentity(request, commit, file, fileIdentitySha256, {
      aiGeneratedAddedLines: 0,
      aiCandidateAddedLines: 0,
      retainedAiAddedLines: 0,
      committedAddedLines: 0,
      eligibleCommittedAddedLines: 0,
      coveredCommittedAddedLines: 0,
      qualityStatus: "unavailable",
      qualityReasons: ["binary_file"],
      aiEvidenceSha256: null,
      executionRefs: [],
    });
  }

  const sourcePaths = file.previousPath ? [file.path, file.previousPath] : [file.path];
  const preferredPath = sourcePaths.find((candidatePath) => evidence.candidatesByPath.has(candidatePath)) ?? file.path;
  const candidate = evidence.candidatesByPath.get(preferredPath) ?? null;
  const patches = evidence.patchesByPath.get(preferredPath) ?? [];
  const issues = [
    ...evidence.globalIssues,
    ...sourcePaths.flatMap((candidatePath) => evidence.issuesByPath.get(candidatePath) ?? []),
  ];
  const qualityReasons = uniqueSorted(issues.map((issue) => issue.qualityReason));
  const executionRefs = buildExecutionRefs(patches);
  if (qualityReasons.length > 0) {
    return createFactIdentity(request, commit, file, fileIdentitySha256, {
      aiGeneratedAddedLines: 0,
      aiCandidateAddedLines: 0,
      retainedAiAddedLines: 0,
      committedAddedLines: countNonBlankLines(file.addedLines),
      eligibleCommittedAddedLines: countNonBlankLines(file.addedLines),
      coveredCommittedAddedLines: 0,
      qualityStatus: "unavailable",
      qualityReasons,
      aiEvidenceSha256: null,
      executionRefs,
    });
  }

  if (!candidate && patches.length === 0) {
    return createFactIdentity(request, commit, file, fileIdentitySha256, {
      aiGeneratedAddedLines: 0,
      aiCandidateAddedLines: 0,
      retainedAiAddedLines: 0,
      committedAddedLines: countNonBlankLines(file.addedLines),
      eligibleCommittedAddedLines: countNonBlankLines(file.addedLines),
      coveredCommittedAddedLines: 0,
      qualityStatus: "unavailable",
      qualityReasons: ["ai_trace_missing"],
      aiEvidenceSha256: null,
      executionRefs: [],
    });
  }

  const generatedLines = patches.flatMap((patch) => patch.addedLines);
  const candidateLines = candidate?.candidateAddedLines ?? [];
  const calculated = calculateOrchestrationCodeAttribution([{
    path: file.path,
    aiGeneratedAddedLines: generatedLines,
    aiCandidateAddedLines: candidateLines,
    committedAddedLines: file.addedLines,
  }]);
  const aiEvidenceSha256 = sha256(JSON.stringify({
    fileIdentitySha256,
    patchSha256: patches.map((patch) => patch.patchSha256).sort(),
    candidatePatchIds: candidate?.patchIds.slice().sort() ?? [],
  }));
  return createFactIdentity(request, commit, file, fileIdentitySha256, {
    ...calculated.counts,
    qualityStatus: "complete",
    qualityReasons: [],
    aiEvidenceSha256,
    executionRefs,
  });
}

/** Deduplicates direct Patch execution identities and binds each reference to its exact Patch digests. */
function buildExecutionRefs(
  patches: LocalCodeAttributionEvidenceResult["patches"],
): OrchestrationMetricCodeAttributionExecutionRef[] {
  const grouped = new Map<string, {
    reference: Omit<OrchestrationMetricCodeAttributionExecutionRef, "evidenceSha256">;
    patchSha256: string[];
  }>();
  for (const patch of patches) {
    const reference = {
      nodeId: patch.nodeId,
      attemptId: patch.attemptId,
      attemptNo: patch.attemptNo,
      promptSnapshotId: patch.promptSnapshotId,
      threadId: String(patch.threadId),
      turnId: String(patch.turnId),
    };
    const key = JSON.stringify(Object.values(reference));
    const current = grouped.get(key) ?? { reference, patchSha256: [] };
    current.patchSha256.push(patch.patchSha256);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map(({ reference, patchSha256 }) => ({
      ...reference,
      evidenceSha256: sha256(JSON.stringify({
        ...reference,
        patchSha256: [...new Set(patchSha256)].sort(),
      })),
    }))
    .sort((left, right) => {
      const leftKey = executionRefKey(left);
      const rightKey = executionRefKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

/** Produces the canonical sort and uniqueness key for one execution reference. */
function executionRefKey(reference: Omit<OrchestrationMetricCodeAttributionExecutionRef, "evidenceSha256">): string {
  return JSON.stringify([
    reference.nodeId,
    reference.attemptId,
    reference.attemptNo,
    reference.promptSnapshotId,
    reference.threadId,
    reference.turnId,
  ]);
}

/** Creates a strict public fact without any original file path or source line. */
function createFactIdentity(
  request: ValidatedCollectRequest,
  commit: GitCommitAttributionSnapshot,
  file: GitCommitAttributionFile,
  fileIdentitySha256: string,
  values: Pick<
    OrchestrationMetricCodeAttributionIngestFact,
    | "aiGeneratedAddedLines"
    | "aiCandidateAddedLines"
    | "retainedAiAddedLines"
    | "committedAddedLines"
    | "eligibleCommittedAddedLines"
    | "coveredCommittedAddedLines"
    | "qualityStatus"
    | "qualityReasons"
    | "aiEvidenceSha256"
    | "executionRefs"
  >,
): OrchestrationMetricCodeAttributionIngestFact {
  return {
    sourceWorkspaceId: String(request.workspaceId),
    sourceInstanceId: String(request.instanceId),
    repository: commit.repository,
    commitSha: commit.commitSha,
    fileIdentitySha256,
    language: detectLanguage(file.path),
    ...values,
    commitEvidenceSha256: file.commitEvidenceSha256,
    evidenceRef: `client-code-attribution:${sha256(`${commit.commitSha}\0${fileIdentitySha256}\0${file.commitEvidenceSha256}`)}`,
    executionRefs: values.executionRefs,
    observedAt: commit.committedAt,
  };
}

/** Builds the commit envelope shared by matched, partial, and excluded batches. */
function createCommitObservation(
  request: ValidatedCollectRequest,
  commit: GitCommitAttributionSnapshot,
  quality: Pick<OrchestrationMetricCodeAttributionCommitObservation, "disposition" | "qualityStatus" | "qualityReasons">,
): OrchestrationMetricCodeAttributionCommitObservation {
  return {
    sourceWorkspaceId: String(request.workspaceId),
    sourceInstanceId: String(request.instanceId),
    repository: commit.repository,
    commitSha: commit.commitSha,
    ...quality,
    commitEvidenceSha256: commit.commitEvidenceSha256,
    observedAt: commit.committedAt,
  };
}

type ValidatedCollectRequest = {
  workspaceId: WorkspaceId;
  repositoryPath: string | null;
  commitSha: string;
  instanceId: OrchestrationId;
  associationId: string;
  associationExpiresAt: number;
};

/** Validates the explicit RPC contract without accepting inferred identities. */
function validateCollectRequest(
  input: OrchestrationMetricCodeAttributionCommitCollectRequest,
  now: number,
): ValidatedCollectRequest {
  if (!input || typeof input !== "object") throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", "代码归因采集参数无效");
  const workspaceId = requireText(input.workspaceId, "workspaceId", 200) as WorkspaceId;
  const instanceId = requireText(input.instanceId, "instanceId", 200) as OrchestrationId;
  const commitSha = requireText(input.commitSha, "commitSha", 64).toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", "commitSha 必须是完整的 Git commit SHA");
  }
  const rawRepositoryPath = input.repositoryPath == null ? "" : String(input.repositoryPath).trim().replace(/\\/gu, "/");
  const normalizedRepositoryPath = rawRepositoryPath ? path.posix.normalize(rawRepositoryPath).replace(/^\.\//u, "") : "";
  if (
    /^[A-Za-z]:/u.test(rawRepositoryPath)
    || path.posix.isAbsolute(rawRepositoryPath)
    || normalizedRepositoryPath === ".."
    || normalizedRepositoryPath.startsWith("../")
    || /[\u0000-\u001f\u007f]/u.test(normalizedRepositoryPath)
  ) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", "repositoryPath 必须是规范的工作区相对路径");
  }
  const repositoryPath = normalizedRepositoryPath || null;
  const associationId = requireText(input.associationId, "associationId", 2_048);
  const associationExpiresAt = requireTimestamp(input.associationExpiresAt, "associationExpiresAt");
  if (associationExpiresAt <= now) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_ASSOCIATION_EXPIRED", "实例关联凭证已过期，请刷新后重试。");
  }
  return { workspaceId, repositoryPath, commitSha, instanceId, associationId, associationExpiresAt };
}

/** Removes the selected repository prefix from one workspace-relative evidence path. */
function toRepositoryRelativePath(repositoryPath: string, workspaceRelativePath: string): string | null {
  const normalizedRepository = repositoryPath.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const normalizedPath = workspaceRelativePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalizedRepository) return normalizedPath;
  const prefix = `${normalizedRepository}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null;
}

/** Counts the same non-empty line population used by the Shared attribution core. */
function countNonBlankLines(lines: string[]): number {
  return lines.filter((line) => line.replace(/\r$/u, "").replace(/^[ \t]+/u, "").length > 0).length;
}

/** Maps common source extensions to a stable language label without returning the path. */
function detectLanguage(filePath: string): string | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  const languageByExtension: Record<string, string> = {
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp", ".css": "css",
    ".go": "go", ".html": "html", ".java": "java", ".js": "javascript", ".jsx": "javascript",
    ".kt": "kotlin", ".php": "php", ".py": "python", ".rb": "ruby", ".rs": "rust",
    ".scss": "scss", ".sh": "shell", ".sql": "sql", ".swift": "swift", ".ts": "typescript",
    ".tsx": "typescript", ".vue": "vue",
  };
  return languageByExtension[extension] ?? null;
}

/** Returns unique reasons in deterministic code-point order. */
function uniqueSorted(reasons: OrchestrationMetricCodeAttributionQualityReason[]): OrchestrationMetricCodeAttributionQualityReason[] {
  return Array.from(new Set(reasons)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** Computes one lowercase SHA-256 digest. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Requires one canonical text identifier. */
function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", `${field} 无效`);
  }
  return value;
}

/** Requires one non-negative safe integer timestamp. */
function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw serviceError("CODE_ATTRIBUTION_COMMIT_INPUT_INVALID", `${field} 无效`);
  }
  return value;
}

export class CodeAttributionCommitServiceError extends Error {
  /** Creates one explicit collection input, association, Git, or evidence failure. */
  constructor(
    readonly code:
      | "CODE_ATTRIBUTION_COMMIT_INPUT_INVALID"
      | "CODE_ATTRIBUTION_COMMIT_WORKSPACE_NOT_FOUND"
      | "CODE_ATTRIBUTION_COMMIT_INSTANCE_NOT_FOUND"
      | "CODE_ATTRIBUTION_COMMIT_ASSOCIATION_MISMATCH"
      | "CODE_ATTRIBUTION_COMMIT_ASSOCIATION_EXPIRED"
      | "CODE_ATTRIBUTION_COMMIT_GIT_READ_FAILED"
      | "CODE_ATTRIBUTION_COMMIT_NO_CODE_CHANGES"
      | "CODE_ATTRIBUTION_COMMIT_EVIDENCE_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAttributionCommitServiceError";
  }
}

/** Creates one service failure without embedding local paths or source text. */
function serviceError(
  code: CodeAttributionCommitServiceError["code"],
  message: string,
): CodeAttributionCommitServiceError {
  return new CodeAttributionCommitServiceError(code, message);
}
