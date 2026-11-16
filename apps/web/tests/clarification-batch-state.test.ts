import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  areAllClarificationsStaged,
  buildClarificationBatchFingerprint,
  buildCombinedClarificationReply,
  countRemainingClarificationCandidates,
  countRemainingClarificationItems,
  countStagedClarificationCandidates,
  findClarificationBatchCandidateFingerprint,
  pruneStagedClarificationEntries,
  type ClarificationBatchCandidateInput,
  type StagedClarificationEntryMap,
} from "../src/features/orchestration/clarificationBatchState.ts";

const workspaceSource = readFileSync(
  new URL("../src/features/orchestration/components/requirement-analysis-workspace.vue", import.meta.url),
  "utf8",
);

function buildCandidate(
  candidateId: string,
  title: string,
  questions: string[],
): ClarificationBatchCandidateInput {
  return {
    candidateId,
    title,
    clarificationItems: questions.map((question, index) => ({
      question,
      reason: `${title} 需要先补齐这项信息。`,
      suggestion: `${title} 建议优先确认 ${index + 1}`,
      impact: "scope",
      options: [{
        id: `${candidateId}-${index + 1}`,
        label: `选项 ${index + 1}`,
        value: `${title} 的选项 ${index + 1}`,
        recommended: true,
      }],
      allowCustom: true,
      answerPlaceholder: `补充 ${title}`,
    })),
  };
}

test("clarification batch state counts staged and remaining candidates/items", () => {
  const candidates = [
    buildCandidate("detail", "详情页首期", ["信息深度", "后续导向"]),
    buildCandidate("home", "首页首期", ["购物车入口"]),
  ];
  const stagedEntries: StagedClarificationEntryMap = {
    detail: {
      candidateId: "detail",
      title: "详情页首期",
      text: "关于候选需求「详情页首期」，我补充了两项澄清。",
      clarificationCount: 2,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(candidates, "detail")!,
      submittedAt: 1,
    },
  };

  assert.equal(countStagedClarificationCandidates(candidates, stagedEntries), 1);
  assert.equal(countRemainingClarificationCandidates(candidates, stagedEntries), 1);
  assert.equal(countRemainingClarificationItems(candidates, stagedEntries), 1);
  assert.equal(areAllClarificationsStaged(candidates, stagedEntries), false);
});

test("clarification batch state only treats fully staged candidates as complete", () => {
  const candidates = [
    buildCandidate("detail", "详情页首期", ["信息深度", "后续导向"]),
  ];
  const stagedEntries: StagedClarificationEntryMap = {
    detail: {
      candidateId: "detail",
      title: "详情页首期",
      text: "关于候选需求「详情页首期」，我只补充了一项。",
      clarificationCount: 1,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(candidates, "detail")!,
      submittedAt: 1,
    },
  };

  assert.equal(countStagedClarificationCandidates(candidates, stagedEntries), 0);
  assert.equal(countRemainingClarificationCandidates(candidates, stagedEntries), 1);
  assert.equal(countRemainingClarificationItems(candidates, stagedEntries), 2);
  assert.equal(areAllClarificationsStaged(candidates, stagedEntries), false);
});

test("clarification batch state builds one combined clarification reply in candidate order", () => {
  const candidates = [
    buildCandidate("detail", "详情页首期", ["信息深度"]),
    buildCandidate("home", "首页首期", ["购物车入口"]),
  ];
  const stagedEntries: StagedClarificationEntryMap = {
    home: {
      candidateId: "home",
      title: "首页首期",
      text: "关于候选需求「首页首期」，我补充：首页首期先不放购物车入口。",
      clarificationCount: 1,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(candidates, "home")!,
      submittedAt: 2,
    },
    detail: {
      candidateId: "detail",
      title: "详情页首期",
      text: "关于候选需求「详情页首期」，我补充：详情页首期先展示基础商品信息。",
      clarificationCount: 1,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(candidates, "detail")!,
      submittedAt: 1,
    },
  };

  assert.equal(areAllClarificationsStaged(candidates, stagedEntries), true);

  const combined = buildCombinedClarificationReply(candidates, stagedEntries);
  assert.match(combined, /^我已经补齐本轮所有待澄清候选/);
  assert.ok(combined.indexOf("详情页首期") < combined.indexOf("首页首期"));
  assert.match(combined, /统一更新候选需求、推荐方案和需求大小评估/);
});

test("clarification batch fingerprint changes when candidate clarification set changes", () => {
  const first = buildClarificationBatchFingerprint([
    buildCandidate("detail", "详情页首期", ["信息深度"]),
  ]);
  const second = buildClarificationBatchFingerprint([
    buildCandidate("detail", "详情页首期", ["信息深度", "后续导向"]),
  ]);

  assert.notEqual(first, second);
});

test("clarification batch fingerprint stays stable across candidate reorder and title copy tweaks", () => {
  const first = buildClarificationBatchFingerprint([
    buildCandidate("detail", "详情页首期", ["信息深度"]),
    buildCandidate("home", "首页首期", ["购物车入口"]),
  ]);
  const second = buildClarificationBatchFingerprint([
    buildCandidate("home", "首页首期（文案微调）", ["购物车入口"]),
    buildCandidate("detail", "详情页首期（文案微调）", ["信息深度"]),
  ]);

  assert.equal(first, second);
});

test("prune staged clarification entries keeps matching candidates and drops changed ones", () => {
  const originalCandidates = [
    buildCandidate("detail", "详情页首期", ["信息深度"]),
    buildCandidate("home", "首页首期", ["购物车入口"]),
  ];
  const stagedEntries: StagedClarificationEntryMap = {
    detail: {
      candidateId: "detail",
      title: "详情页首期",
      text: "关于候选需求「详情页首期」，我补充：详情页首期先展示基础商品信息。",
      clarificationCount: 1,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(originalCandidates, "detail")!,
      submittedAt: 1,
    },
    home: {
      candidateId: "home",
      title: "首页首期",
      text: "关于候选需求「首页首期」，我补充：首页首期先不放购物车入口。",
      clarificationCount: 1,
      candidateFingerprint: findClarificationBatchCandidateFingerprint(originalCandidates, "home")!,
      submittedAt: 2,
    },
  };

  const updatedCandidates = [
    buildCandidate("home", "首页首期（文案改名）", ["购物车入口"]),
    buildCandidate("detail", "详情页首期", ["信息深度", "后续导向"]),
  ];
  const pruned = pruneStagedClarificationEntries(updatedCandidates, stagedEntries);

  assert.deepEqual(Object.keys(pruned), ["home"]);
});

test("快捷澄清发送会透传 Claude 扩展上下文和 Codex Fast 档位", () => {
  assert.match(workspaceSource, /contextWindow: resolvedPrefs\.contextWindow \?\? undefined,/u);
  assert.match(workspaceSource, /serviceTier: resolvedPrefs\.serviceTier,/u);
});
