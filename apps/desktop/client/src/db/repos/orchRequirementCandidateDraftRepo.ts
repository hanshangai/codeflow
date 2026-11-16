import type {
  RequirementCandidateDraft,
  RequirementCandidateId,
  RequirementAnalysisSessionId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import type { OrchRequirementAnalysisSessionRepo } from "./orchRequirementAnalysisSessionRepo.js";

/** 需求分析助手候选需求仓储。 */
export class OrchRequirementCandidateDraftRepo {
  constructor(private readonly db: SqliteDb, private readonly sessions?: OrchRequirementAnalysisSessionRepo) {}

  listBySession(sessionId: RequirementAnalysisSessionId): RequirementCandidateDraft[] {
    const rows = this.db
      .prepare(
        `SELECT id, candidate_json, created_at, updated_at
         FROM orch_requirement_candidate_drafts
         WHERE session_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(String(sessionId)) as any[];
    return rows
      .map((row) => rowToCandidate(row, sessionId))
      .sort(compareCandidateDraftsForDisplay);
  }

  get(sessionId: RequirementAnalysisSessionId, candidateId: RequirementCandidateId): RequirementCandidateDraft | null {
    const row = this.db
      .prepare(
        `SELECT id, candidate_json, created_at, updated_at
         FROM orch_requirement_candidate_drafts
         WHERE session_id = ? AND id = ?`,
      )
      .get(String(sessionId), String(candidateId)) as any | undefined;
    return row ? rowToCandidate(row, sessionId) : null;
  }

  replaceForSession(sessionId: RequirementAnalysisSessionId, candidates: RequirementCandidateDraft[]): RequirementCandidateDraft[] {
    const existingById = new Map(this.listBySession(sessionId).map((candidate) => [candidate.id, candidate] as const));
    const now = Date.now();
    const normalized: RequirementCandidateDraft[] = candidates.map((candidate) => ({
      ...candidate,
      sessionId,
      creationState: (candidate.creationState === "created" ? "created" : "draft") as RequirementCandidateDraft["creationState"],
      createdIntakeId: candidate.createdIntakeId ?? null,
      createdProposalId: candidate.createdProposalId ?? null,
      recommendedApproach: String(candidate.recommendedApproach ?? "").trim(),
      recommendedRoleIds: Array.isArray(candidate.recommendedRoleIds) ? candidate.recommendedRoleIds : [],
      recommendedKnowledgeBundleIds: Array.isArray(candidate.recommendedKnowledgeBundleIds) ? candidate.recommendedKnowledgeBundleIds : [],
      phasingAssessment: normalizePhasingAssessment(candidate.phasingAssessment),
      sizeAssessment: normalizeSizeAssessment(candidate.sizeAssessment),
      assetGaps: Array.isArray(candidate.assetGaps) ? candidate.assetGaps : [],
      assumptions: Array.isArray(candidate.assumptions) ? candidate.assumptions : [],
      openQuestions: Array.isArray(candidate.openQuestions) ? candidate.openQuestions : [],
      clarificationItems: normalizeClarificationItems(candidate),
      displayOrder: normalizeDisplayOrder(candidate.displayOrder),
      createdAt: existingById.get(candidate.id)?.createdAt ?? candidate.createdAt ?? now,
      updatedAt: candidate.updatedAt ?? now,
    }));
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_requirement_candidate_drafts WHERE session_id = ?").run(String(sessionId));
      const stmt = this.db.prepare(
        `INSERT INTO orch_requirement_candidate_drafts (
          id, session_id, title, ready_to_create, candidate_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const candidate of normalized) {
        stmt.run(
          String(candidate.id),
          String(sessionId),
          String(candidate.title ?? "").trim(),
          candidate.readyToCreate ? 1 : 0,
          JSON.stringify(candidate),
          candidate.createdAt,
          candidate.updatedAt,
        );
      }
      return normalized;
    });
    const result = tx();
    const session = this.sessions?.get(sessionId);
    if (session) this.sessions?.invalidateStatusCountCache(session.workspaceId);
    return result;
  }
}

function rowToCandidate(row: any, sessionId: RequirementAnalysisSessionId): RequirementCandidateDraft {
  const parsed = safeParseJson<RequirementCandidateDraft | null>(row.candidate_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      id: String(row.id) as RequirementCandidateId,
      sessionId,
      creationState: parsed.creationState === "created" ? "created" : "draft",
      createdIntakeId: parsed.createdIntakeId ?? null,
      createdProposalId: parsed.createdProposalId ?? null,
      recommendedApproach: String(parsed.recommendedApproach ?? "").trim(),
      recommendedRoleIds: Array.isArray(parsed.recommendedRoleIds) ? parsed.recommendedRoleIds : [],
      recommendedKnowledgeBundleIds: Array.isArray(parsed.recommendedKnowledgeBundleIds) ? parsed.recommendedKnowledgeBundleIds : [],
      phasingAssessment: normalizePhasingAssessment(parsed.phasingAssessment),
      sizeAssessment: normalizeSizeAssessment(parsed.sizeAssessment),
      assetGaps: Array.isArray(parsed.assetGaps) ? parsed.assetGaps : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
      clarificationItems: normalizeClarificationItems(parsed),
      displayOrder: normalizeDisplayOrder(parsed.displayOrder),
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
    };
  }
  throw new Error(`无效的候选需求记录：${String(row?.id ?? "")}`);
}

/** 按模型输出的显式展示序号读取候选，缺失序号的旧数据继续走原有时间兜底。 */
function compareCandidateDraftsForDisplay(left: RequirementCandidateDraft, right: RequirementCandidateDraft): number {
  const leftCreated = left.creationState === "created" ? 1 : 0;
  const rightCreated = right.creationState === "created" ? 1 : 0;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  const leftOrder = normalizeDisplayOrder(left.displayOrder);
  const rightOrder = normalizeDisplayOrder(right.displayOrder);
  if (leftOrder != null || rightOrder != null) {
    if (leftOrder == null) return 1;
    if (rightOrder == null) return -1;
    return leftOrder - rightOrder
      || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
      || String(left.id).localeCompare(String(right.id));
  }
  return Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
    || String(left.id).localeCompare(String(right.id));
}

function normalizeDisplayOrder(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 规范化阻塞澄清项；openQuestions 是非阻塞记录，不再兜底成待澄清项。 */
function normalizeClarificationItems(candidate: Partial<RequirementCandidateDraft>): RequirementCandidateDraft["clarificationItems"] {
  if (Array.isArray(candidate.clarificationItems) && candidate.clarificationItems.length > 0) {
    return candidate.clarificationItems
      .map((item, index) => ({
        question: String(item?.question ?? "").trim(),
        reason: String(item?.reason ?? "").trim() || "需要先补齐这项信息，才能继续确认流程和验收边界。",
        suggestion: String(item?.suggestion ?? "").trim() || "请直接补充这项信息，并尽量说明范围、输入输出和验收方式。",
        impact: item?.impact ?? "scope",
        options: Array.isArray(item?.options) && item.options.length > 0
          ? item.options
            .map((option, optionIndex) => ({
              id: String(option?.id ?? "").trim() || `option-${index + 1}-${optionIndex + 1}`,
              label: String(option?.label ?? option?.value ?? "").trim(),
              value: String(option?.value ?? option?.label ?? "").trim(),
              recommended: Boolean(option?.recommended),
            }))
            .filter((option) => option.label && option.value)
          : [{
            id: `direct-input-${index + 1}`,
            label: "直接补充",
            value: "我来直接补充这项信息：",
            recommended: true,
          }],
        allowCustom: item?.allowCustom !== false,
        answerPlaceholder: String(item?.answerPlaceholder ?? "").trim() || "直接补充您的选择、范围、字段或交互要求。",
      }))
      .filter((item) => item.question);
  }

  const blockingGap = Array.isArray(candidate.assetGaps)
    ? candidate.assetGaps.find((gap) => gap?.severity === "blocking" && String(gap?.message ?? "").trim())
    : null;
  if (!blockingGap) return [];

  return [{
    question: String(blockingGap.message ?? "").trim(),
    reason: "当前工作区仍缺少关键业务资料或可复用执行资产，暂时不能直接创建需求。",
    suggestion: String(blockingGap.suggestion ?? "").trim() || "请先补齐这部分业务资料或执行资产，必要时再新增相关流程、角色、知识库或工具集后继续。",
    impact: blockingGap.kind === "workflow" ? "workflow" : "assets",
    options: [{
      id: "follow-suggestion",
      label: "按 AI 建议补充",
      value: String(blockingGap.suggestion ?? "").trim() || "请先补齐这部分业务资料或执行资产，必要时再新增相关流程、角色、知识库或工具集后继续。",
      recommended: true,
    }],
    allowCustom: true,
    answerPlaceholder: "也可以直接补充业务资料、规则约束，或说明需要新增的流程、角色、知识库或工具信息。",
  }];
}

function normalizeSizeAssessment(candidate: Partial<RequirementCandidateDraft>["sizeAssessment"]): RequirementCandidateDraft["sizeAssessment"] {
  const rawSignals = (candidate?.signals ?? {}) as Partial<RequirementCandidateDraft["sizeAssessment"]["signals"]>;
  const rawLegacySignals = (candidate?.legacySignals ?? {}) as Partial<NonNullable<RequirementCandidateDraft["sizeAssessment"]["legacySignals"]>>;
  const signals = {
    functionalProcessCount: clampNonNegativeInt(rawSignals?.functionalProcessCount),
    domainEntityCount: clampNonNegativeInt(rawSignals?.domainEntityCount),
    stateTransitionCount: clampNonNegativeInt(rawSignals?.stateTransitionCount),
    interactionSurfaceCount: clampNonNegativeInt(rawSignals?.interactionSurfaceCount),
    externalIntegrationCount: clampNonNegativeInt(rawSignals?.externalIntegrationCount),
    asyncConsistencyRiskCount: clampNonNegativeInt(rawSignals?.asyncConsistencyRiskCount),
    clientSurfaceCount: Math.max(clampNonNegativeInt(rawSignals?.clientSurfaceCount), 1),
  };
  const legacySignals = hasLegacySizeSignals(rawLegacySignals)
    ? {
      menuCount: clampNonNegativeInt(rawLegacySignals?.menuCount),
      featurePointCount: clampNonNegativeInt(rawLegacySignals?.featurePointCount),
      businessFlowCount: clampNonNegativeInt(rawLegacySignals?.businessFlowCount),
      interactionPointCount: clampNonNegativeInt(rawLegacySignals?.interactionPointCount),
      integrationCount: clampNonNegativeInt(rawLegacySignals?.integrationCount),
      platformCount: Math.max(clampNonNegativeInt(rawLegacySignals?.platformCount), 1),
    }
    : null;
  const score = Number(candidate?.score ?? 0) > 0 ? Number(candidate?.score ?? 0) : 0;
  return {
    model: candidate?.model === "legacy-matrix-v1" || candidate?.model === "functional-size-v2"
      ? candidate.model
      : legacySignals
      ? "legacy-matrix-v1"
      : "functional-size-v2",
    size: candidate?.size === "small" || candidate?.size === "standard" || candidate?.size === "large"
      ? candidate.size
      : "unknown",
    score,
    summary: String(candidate?.summary ?? "").trim(),
    reasoning: String(candidate?.reasoning ?? "").trim(),
    signals,
    legacySignals,
  };
}

function normalizePhasingAssessment(
  candidate: Partial<RequirementCandidateDraft>["phasingAssessment"],
): RequirementCandidateDraft["phasingAssessment"] {
  const rawSignals = (candidate?.signals ?? {}) as Partial<RequirementCandidateDraft["phasingAssessment"]["signals"]>;
  return {
    model: candidate?.model === "mmf-phase-gate-v2" ? "mmf-phase-gate-v2" : "legacy-mmf-fallback-v1",
    scopeDecision: candidate?.scopeDecision === "needs-split" ? "needs-split" : "fit",
    deliverySlice: candidate?.deliverySlice === "phase-1" || candidate?.deliverySlice === "follow-up"
      ? candidate.deliverySlice
      : "single-phase",
    summary: String(candidate?.summary ?? "").trim(),
    reasoning: String(candidate?.reasoning ?? "").trim(),
    signals: {
      benefitHypothesisCount: Math.max(clampNonNegativeInt(rawSignals?.benefitHypothesisCount), 1),
      acceptanceLoopCount: Math.max(clampNonNegativeInt(rawSignals?.acceptanceLoopCount), 1),
      actorSurfaceCount: Math.max(clampNonNegativeInt(rawSignals?.actorSurfaceCount), 1),
      externalSystemCount: clampNonNegativeInt(rawSignals?.externalSystemCount),
      newCoreModelCount: clampNonNegativeInt(rawSignals?.newCoreModelCount),
    },
    outOfScope: Array.isArray(candidate?.outOfScope)
      ? candidate.outOfScope.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
  };
}

function hasLegacySizeSignals(
  raw: Partial<NonNullable<RequirementCandidateDraft["sizeAssessment"]["legacySignals"]>>,
): boolean {
  return clampNonNegativeInt(raw?.menuCount)
    + clampNonNegativeInt(raw?.featurePointCount)
    + clampNonNegativeInt(raw?.businessFlowCount)
    + clampNonNegativeInt(raw?.interactionPointCount)
    + clampNonNegativeInt(raw?.integrationCount)
    + clampNonNegativeInt(raw?.platformCount) > 0;
}

function clampNonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num);
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

