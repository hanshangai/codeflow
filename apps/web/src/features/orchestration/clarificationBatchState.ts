import type { ClarificationItemInput } from "./clarificationDraftState";

export type ClarificationBatchCandidateInput = {
  candidateId: string;
  title: string;
  clarificationItems: ClarificationItemInput[];
};

export type StagedClarificationEntry = {
  candidateId: string;
  title: string;
  text: string;
  clarificationCount: number;
  candidateFingerprint: string;
  submittedAt: number;
};

export type StagedClarificationEntryMap = Record<string, StagedClarificationEntry>;

type NormalizedClarificationBatchCandidate = {
  candidateId: string;
  clarificationCount: number;
  fingerprint: string;
};

function normalizeClarificationBatchCandidates(
  candidates: ClarificationBatchCandidateInput[],
): NormalizedClarificationBatchCandidate[] {
  const seen = new Set<string>();
  const normalized: NormalizedClarificationBatchCandidate[] = [];
  for (const candidate of candidates) {
    const candidateId = String(candidate.candidateId ?? "").trim();
    if (!candidateId || seen.has(candidateId)) continue;
    const clarificationItems = Array.isArray(candidate.clarificationItems) ? candidate.clarificationItems : [];
    if (!clarificationItems.length) continue;
    seen.add(candidateId);
    normalized.push({
      candidateId,
      clarificationCount: clarificationItems.length,
      fingerprint: buildClarificationBatchCandidateFingerprint(candidateId, clarificationItems),
    });
  }
  return normalized;
}

function buildClarificationBatchCandidateFingerprint(candidateId: string, items: ClarificationItemInput[]): string {
  return JSON.stringify({
    candidateId: String(candidateId ?? "").trim(),
    items: items
      .map((item) => ({
        question: String(item.question ?? "").trim(),
        impact: String(item.impact ?? "").trim(),
        allowCustom: item.allowCustom !== false,
        options: [...item.options]
          .map((option) => ({
            id: String(option.id ?? "").trim(),
            recommended: Boolean(option.recommended),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.question.localeCompare(right.question)),
  });
}

function hasCompleteStagedClarification(
  candidate: NormalizedClarificationBatchCandidate,
  stagedEntries: StagedClarificationEntryMap,
): boolean {
  const staged = stagedEntries[candidate.candidateId];
  if (!staged) return false;
  return staged.clarificationCount >= candidate.clarificationCount && String(staged.text ?? "").trim().length > 0;
}

export function buildClarificationBatchFingerprint(candidates: ClarificationBatchCandidateInput[]): string {
  return JSON.stringify(
    [...normalizeClarificationBatchCandidates(candidates)]
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        clarificationCount: candidate.clarificationCount,
        fingerprint: candidate.fingerprint,
      })),
  );
}

export function findClarificationBatchCandidateFingerprint(
  candidates: ClarificationBatchCandidateInput[],
  candidateId: string,
): string | null {
  const normalizedCandidateId = String(candidateId ?? "").trim();
  if (!normalizedCandidateId) return null;
  return normalizeClarificationBatchCandidates(candidates)
    .find((candidate) => candidate.candidateId === normalizedCandidateId)
    ?.fingerprint ?? null;
}

export function pruneStagedClarificationEntries(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): StagedClarificationEntryMap {
  const normalizedCandidates = normalizeClarificationBatchCandidates(candidates);
  const candidateById = new Map(normalizedCandidates.map((candidate) => [candidate.candidateId, candidate] as const));
  const nextEntries: StagedClarificationEntryMap = {};
  for (const [candidateId, stagedEntry] of Object.entries(stagedEntries)) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) continue;
    if (String(stagedEntry.text ?? "").trim().length <= 0) continue;
    if (stagedEntry.clarificationCount < candidate.clarificationCount) continue;
    if (String(stagedEntry.candidateFingerprint ?? "").trim() !== candidate.fingerprint) continue;
    nextEntries[candidateId] = stagedEntry;
  }
  return nextEntries;
}

export function countStagedClarificationCandidates(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): number {
  return normalizeClarificationBatchCandidates(candidates)
    .filter((candidate) => hasCompleteStagedClarification(candidate, stagedEntries))
    .length;
}

export function countRemainingClarificationCandidates(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): number {
  const normalized = normalizeClarificationBatchCandidates(candidates);
  return Math.max(normalized.length - countStagedClarificationCandidates(candidates, stagedEntries), 0);
}

export function countRemainingClarificationItems(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): number {
  return normalizeClarificationBatchCandidates(candidates)
    .filter((candidate) => !hasCompleteStagedClarification(candidate, stagedEntries))
    .reduce((sum, candidate) => sum + candidate.clarificationCount, 0);
}

export function areAllClarificationsStaged(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): boolean {
  const normalized = normalizeClarificationBatchCandidates(candidates);
  return normalized.length > 0 && normalized.every((candidate) => hasCompleteStagedClarification(candidate, stagedEntries));
}

export function buildCombinedClarificationReply(
  candidates: ClarificationBatchCandidateInput[],
  stagedEntries: StagedClarificationEntryMap,
): string {
  const normalized = normalizeClarificationBatchCandidates(candidates);
  const blocks = normalized
    .map((candidate) => stagedEntries[candidate.candidateId])
    .filter((entry): entry is StagedClarificationEntry => Boolean(entry))
    .map((entry) => String(entry.text ?? "").trim())
    .filter(Boolean);
  if (!blocks.length) return "";
  return [
    "我已经补齐本轮所有待澄清候选，请统一更新当前需求分析结果：",
    ...blocks,
    "请基于以上全部澄清统一更新候选需求、推荐方案和需求大小评估；如果仍有未解决项，请继续列出待澄清事项和可选项。",
  ].join("\n\n");
}
