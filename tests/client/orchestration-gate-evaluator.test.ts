import test from "node:test";
import assert from "node:assert/strict";

import { getThreadEntryVisibility, type GateCriterion } from "../../packages/shared/src/index.ts";
import { evaluateGates, hasBlockingFailure } from "../../apps/desktop/client/src/orchestration/gateEvaluator.ts";

function criterion(input: Partial<GateCriterion> & Pick<GateCriterion, "type" | "config">): GateCriterion {
  return {
    id: input.id ?? `gate-${input.type}`,
    label: input.label ?? "测试门禁",
    type: input.type,
    config: input.config,
    blocking: input.blocking ?? true,
  };
}

test("deterministic gates expose pass/fail outcomes", async () => {
  const criteria = [
    criterion({ id: "regex", type: "regex", config: "status", blocking: true }),
    criterion({ id: "schema", type: "json-schema", config: '{"type":"object","required":["status"]}', blocking: true }),
  ];

  const results = await evaluateGates('{"status":"ok"}', criteria);

  assert.deepEqual(results.map((item) => item.outcome), ["pass", "pass"]);
  assert.deepEqual(results.map((item) => item.evaluatorKind), ["deterministic", "deterministic"]);
  assert.equal(hasBlockingFailure(results, criteria), false);
});

test("invalid deterministic configuration is an evaluation error", async () => {
  const criteria = [criterion({ type: "regex", config: "[", blocking: true })];
  const [result] = await evaluateGates("output", criteria);

  assert.equal(result.passed, false);
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "INVALID_REGEX");
  assert.equal(hasBlockingFailure([result], criteria), true);
});

test("AI gate without evaluator fails closed with a classified error", async () => {
  const criteria = [criterion({ type: "ai", config: "必须包含回滚方案", blocking: false })];
  const [result] = await evaluateGates("部署方案", criteria);

  assert.equal(result.passed, false);
  assert.equal(result.outcome, "error");
  assert.equal(result.evaluatorKind, "ai");
  assert.equal(result.errorCode, "AI_GATE_EVALUATOR_NOT_CONFIGURED");
  assert.equal(hasBlockingFailure([result], criteria), true);
});

test("AI evaluator metadata and evidence are preserved", async () => {
  const criteria = [criterion({ id: "quality", type: "ai", config: "必须包含回滚方案", blocking: true })];
  const [result] = await evaluateGates("包含回滚方案", criteria, async () => ({
    passed: true,
    message: "符合要求",
    evidence: [{ sourceId: "artifact-body", startOffset: 2, endOffset: 6, quote: "回滚方案" }],
    evaluationRunId: "run-1",
    evaluationCallId: "call-1",
    evaluationThreadId: "thread-1",
    evaluationTurnId: "turn-1",
    promptSnapshotId: "snapshot-1",
  }));

  assert.equal(result.passed, true);
  assert.equal(result.outcome, "pass");
  assert.equal(result.evaluatorKind, "ai");
  assert.equal(result.evaluationRunId, "run-1");
  assert.equal(result.evaluationCallId, "call-1");
  assert.equal(result.evidence?.[0]?.quote, "回滚方案");
});

test("inconsistent AI evaluator results fail closed", async () => {
  const criteria = [criterion({ id: "quality", type: "ai", config: "必须完整", blocking: false })];
  const [result] = await evaluateGates("内容", criteria, async () => ({
    passed: true,
    outcome: "error",
    message: "模型调用异常",
  }));

  assert.equal(result.passed, false);
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "AI_GATE_RESULT_INCONSISTENT");
  assert.equal(hasBlockingFailure([result], criteria), true);
});

test("unknown gate type is an explicit blocking error", async () => {
  const unknown = criterion({ type: "future-type" as GateCriterion["type"], config: "" });
  const [result] = await evaluateGates("output", [unknown]);

  assert.equal(result.passed, false);
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "UNSUPPORTED_GATE_TYPE");
  assert.equal(hasBlockingFailure([result], [unknown]), true);
});

test("gate evaluation threads are internal orchestration threads", () => {
  assert.deepEqual(getThreadEntryVisibility({ threadType: "orchestration", threadSubtype: "gate-evaluation" }), {
    routeDeepLink: false,
    threadList: false,
    embeddedDetail: false,
    internalRestore: true,
  });
});
