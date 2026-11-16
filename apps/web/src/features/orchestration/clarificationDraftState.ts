import type { RequirementCandidateDraft } from "@codeflowai/shared";

export type ClarificationItemInput = RequirementCandidateDraft["clarificationItems"][number];
export type ClarificationDraftAnswer = {
  optionId: string | null;
  customText: string;
};

export type ClarificationDraftAnswers = Record<string, ClarificationDraftAnswer>;

export function createClarificationDraftAnswer(item: ClarificationItemInput): ClarificationDraftAnswer {
  return {
    optionId: item.options.find((option) => option.recommended)?.id ?? null,
    customText: "",
  };
}

export function createClarificationDraftAnswers(items: ClarificationItemInput[]): ClarificationDraftAnswers {
  const draftAnswers: ClarificationDraftAnswers = {};
  for (const item of items) {
    draftAnswers[item.question] = createClarificationDraftAnswer(item);
  }
  return draftAnswers;
}

export function buildClarificationDraftFingerprint(candidateId: string, items: ClarificationItemInput[]): string {
  return JSON.stringify({
    candidateId: String(candidateId ?? "").trim(),
    items: items.map((item) => ({
      question: String(item.question ?? "").trim(),
      reason: String(item.reason ?? "").trim(),
      suggestion: String(item.suggestion ?? "").trim(),
      impact: String(item.impact ?? "").trim(),
      allowCustom: item.allowCustom !== false,
      answerPlaceholder: String(item.answerPlaceholder ?? "").trim(),
      options: item.options.map((option) => ({
        id: String(option.id ?? "").trim(),
        label: String(option.label ?? "").trim(),
        value: String(option.value ?? "").trim(),
        recommended: Boolean(option.recommended),
      })),
    })),
  });
}
