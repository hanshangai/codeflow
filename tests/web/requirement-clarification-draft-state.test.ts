import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClarificationDraftFingerprint,
  createClarificationDraftAnswer,
  createClarificationDraftAnswers,
} from "../../apps/web/src/features/orchestration/clarificationDraftState.ts";

test("createClarificationDraftAnswer prefers the recommended option", () => {
  const state = createClarificationDraftAnswer({
    question: "支付范围是什么？",
    reason: "需要先确认范围。",
    suggestion: "建议先锁定最小闭环。",
    impact: "scope",
    options: [
      { id: "all", label: "全部", value: "全部覆盖" },
      { id: "core", label: "主链路", value: "先做主链路", recommended: true },
    ],
    allowCustom: true,
    answerPlaceholder: "直接补充范围。",
  });

  assert.deepEqual(state, {
    optionId: "core",
    customText: "",
  });
});

test("createClarificationDraftAnswers initializes every clarification item", () => {
  const answers = createClarificationDraftAnswers([
    {
      question: "Q1",
      reason: "R1",
      suggestion: "S1",
      impact: "scope",
      options: [{ id: "a", label: "A", value: "A", recommended: true }],
      allowCustom: true,
      answerPlaceholder: "P1",
    },
    {
      question: "Q2",
      reason: "R2",
      suggestion: "S2",
      impact: "assets",
      options: [{ id: "b", label: "B", value: "B" }],
      allowCustom: true,
      answerPlaceholder: "P2",
    },
  ]);

  assert.deepEqual(answers, {
    Q1: { optionId: "a", customText: "" },
    Q2: { optionId: null, customText: "" },
  });
});

test("buildClarificationDraftFingerprint changes when same candidate keeps the same item count but question content changes", () => {
  const first = buildClarificationDraftFingerprint("candidate-1", [{
    question: "订单页是列表还是详情？",
    reason: "影响页面范围",
    suggestion: "先锁定列表页",
    impact: "scope",
    options: [{ id: "list", label: "列表", value: "先做列表", recommended: true }],
    allowCustom: true,
    answerPlaceholder: "补充页面范围",
  }]);
  const second = buildClarificationDraftFingerprint("candidate-1", [{
    question: "支付链路是否包含退款？",
    reason: "影响业务范围",
    suggestion: "先锁定支付主链路",
    impact: "scope",
    options: [{ id: "pay", label: "支付主链路", value: "先做支付主链路", recommended: true }],
    allowCustom: true,
    answerPlaceholder: "补充支付范围",
  }]);

  assert.notEqual(first, second);
});
