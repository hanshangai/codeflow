import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateOrchestrationCodeAttribution,
  calculateOrchestrationCodeAttributionRates,
  countOrchestrationCodeAttributionMatches,
  normalizeOrchestrationCodeAttributionLine,
  selectOrchestrationCodeAttributionMatches,
  serializeOrchestrationCodeAttributionPayload,
} from "../../packages/shared/src/utils/orchestrationCodeAttribution.ts";

test("代码归因跨端摘要只保留固定公开字段", () => {
  const payload = {
    commit: {
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: "a".repeat(40),
      disposition: "matched" as const,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      commitEvidenceSha256: "b".repeat(64),
      observedAt: 100,
      localPath: "D:/secret/repo",
    },
    facts: [{
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: "a".repeat(40),
      fileIdentitySha256: "c".repeat(64),
      language: "typescript",
      aiGeneratedAddedLines: 3,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 1,
      committedAddedLines: 2,
      eligibleCommittedAddedLines: 2,
      coveredCommittedAddedLines: 2,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      aiEvidenceSha256: "d".repeat(64),
      commitEvidenceSha256: "e".repeat(64),
      evidenceRef: `client-code-attribution:${"f".repeat(64)}`,
      executionRefs: [],
      observedAt: 100,
      patch: "secret source",
    }],
  };
  const serialized = serializeOrchestrationCodeAttributionPayload(payload);
  assert.equal(serialized.includes("localPath"), false);
  assert.equal(serialized.includes("patch"), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), ["commit", "facts"]);
});

test("代码归因规范化只忽略行首缩进和纯空白行", () => {
  assert.equal(normalizeOrchestrationCodeAttributionLine("\t  return 42;\r"), "return 42;");
  assert.equal(normalizeOrchestrationCodeAttributionLine("return 42;  "), "return 42;  ");
  assert.equal(normalizeOrchestrationCodeAttributionLine(" \t "), null);
  assert.equal(normalizeOrchestrationCodeAttributionLine("Return 42;"), "Return 42;");
});

test("代码归因使用多重集保留重复行", () => {
  assert.equal(
    countOrchestrationCodeAttributionMatches(
      ["return null;", "  return null;", "return null;"],
      ["\treturn null;", "return null;"],
    ),
    2,
  );
});

test("代码归因留存种子返回规范化且保留重复次数的交集", () => {
  assert.deepEqual(
    selectOrchestrationCodeAttributionMatches(
      ["  repeat();", "repeat();", "repeat();", "candidate-only();"],
      ["\trepeat();", "repeat();", "manual();"],
    ),
    ["repeat();", "repeat();"],
  );
});

test("代码归因按文件隔离并从汇总分子分母计算比例", () => {
  const result = calculateOrchestrationCodeAttribution([
    {
      path: "src/a.ts",
      aiGeneratedAddedLines: ["const value = 1;", "return value;", "unused();"],
      aiCandidateAddedLines: ["const value = 1;", "return value;"],
      committedAddedLines: ["  const value = 1;", "return value;", "manual();"],
      retentionObservedLines: ["const value = 1;", "manual();"],
    },
    {
      path: "src/b.ts",
      aiGeneratedAddedLines: ["same();"],
      aiCandidateAddedLines: ["same();"],
      committedAddedLines: ["other();"],
      retentionObservedLines: ["same();"],
    },
  ], 7);

  assert.deepEqual(result.counts, {
    aiGeneratedAddedLines: 4,
    aiCandidateAddedLines: 3,
    retainedAiAddedLines: 2,
    committedAddedLines: 4,
    eligibleCommittedAddedLines: 4,
    coveredCommittedAddedLines: 4,
    stillPresentAiAddedLines: 1,
  });
  assert.deepEqual(result.rates, {
    aiContributionShare: 0.5,
    aiOutputAdoptionRate: 0.5,
    aiCodeRetentionRate: 0.5,
    collectionCoverageRate: 1,
    retentionWindowDays: 7,
  });
});

test("代码归因在留存观察不完整和零分母时返回 null", () => {
  const result = calculateOrchestrationCodeAttribution([
    {
      path: "src/empty.ts",
      aiGeneratedAddedLines: ["  ", "\t"],
      aiCandidateAddedLines: [],
      committedAddedLines: [""],
    },
  ]);
  assert.deepEqual(result.rates, {
    aiContributionShare: null,
    aiOutputAdoptionRate: null,
    aiCodeRetentionRate: null,
    collectionCoverageRate: null,
    retentionWindowDays: null,
  });
});

test("代码归因禁止跨文件匹配相同内容", () => {
  const result = calculateOrchestrationCodeAttribution([
    {
      path: "src/generated.ts",
      aiGeneratedAddedLines: ["same();"],
      aiCandidateAddedLines: ["same();"],
      committedAddedLines: [],
    },
    {
      path: "src/manual.ts",
      aiGeneratedAddedLines: [],
      aiCandidateAddedLines: [],
      committedAddedLines: ["same();"],
    },
  ]);
  assert.equal(result.counts.retainedAiAddedLines, 0);
  assert.equal(result.rates.aiContributionShare, 0);
});

test("代码归因留存行必须绑定窗口且畸形输入显式失败", () => {
  const file = {
    path: "src/a.ts",
    aiGeneratedAddedLines: ["a();"],
    aiCandidateAddedLines: ["a();"],
    committedAddedLines: ["a();"],
    retentionObservedLines: ["a();"],
  };
  assert.throws(() => calculateOrchestrationCodeAttribution([file]), /必须绑定 7 天或 30 天/u);
  assert.throws(
    () => calculateOrchestrationCodeAttribution([
      { ...file, retentionObservedLines: "a();" } as unknown as typeof file,
    ], 7),
    /必须是数组、null 或未提供/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttribution([file], 14 as 7),
    /只能是 7 天或 30 天/u,
  );
});

test("代码归因保留已到窗口但观察证据缺失的不可用状态", () => {
  const rates = calculateOrchestrationCodeAttributionRates({
    aiGeneratedAddedLines: 4,
    aiCandidateAddedLines: 3,
    retainedAiAddedLines: 2,
    committedAddedLines: 5,
    eligibleCommittedAddedLines: 5,
    coveredCommittedAddedLines: 5,
    stillPresentAiAddedLines: null,
  }, 30);
  assert.equal(rates.aiCodeRetentionRate, null);
  assert.equal(rates.retentionWindowDays, 30);
});

test("AI 证据缺失时降低覆盖率且不推断为人工代码", () => {
  const rates = calculateOrchestrationCodeAttributionRates({
    aiGeneratedAddedLines: 0,
    aiCandidateAddedLines: 0,
    retainedAiAddedLines: 0,
    committedAddedLines: 10,
    eligibleCommittedAddedLines: 10,
    coveredCommittedAddedLines: 0,
    stillPresentAiAddedLines: null,
  });
  assert.equal(rates.aiContributionShare, null);
  assert.equal(rates.aiOutputAdoptionRate, null);
  assert.equal(rates.collectionCoverageRate, 0);
});

test("代码归因拒绝重复路径和缺少生成证据的候选行", () => {
  assert.throws(
    () => calculateOrchestrationCodeAttribution([
      { path: "src/a.ts", aiGeneratedAddedLines: [], aiCandidateAddedLines: [], committedAddedLines: [] },
      { path: "./src\\a.ts", aiGeneratedAddedLines: [], aiCandidateAddedLines: [], committedAddedLines: [] },
    ]),
    /文件路径重复/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttribution([
      { path: "src/a.ts", aiGeneratedAddedLines: ["a"], aiCandidateAddedLines: ["b"], committedAddedLines: ["b"] },
    ]),
    /缺少生成证据/u,
  );
});

test("代码归因拒绝不可能的持久化计数", () => {
  assert.throws(
    () => calculateOrchestrationCodeAttributionRates({
      aiGeneratedAddedLines: 2,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 2,
      committedAddedLines: 2,
      eligibleCommittedAddedLines: 2,
      coveredCommittedAddedLines: 1,
      stillPresentAiAddedLines: 1,
    }),
    /采纳新增行数不能超过已覆盖/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttributionRates({
      aiGeneratedAddedLines: 2,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 1,
      committedAddedLines: 2,
      eligibleCommittedAddedLines: 2,
      coveredCommittedAddedLines: 2,
      stillPresentAiAddedLines: 2,
    }),
    /留存行数不能超过/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttributionRates({
      aiGeneratedAddedLines: 1,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 0,
      committedAddedLines: 1,
      eligibleCommittedAddedLines: 1,
      coveredCommittedAddedLines: 1,
      stillPresentAiAddedLines: null,
    }),
    /候选新增行数不能超过/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttributionRates({
      aiGeneratedAddedLines: 1,
      aiCandidateAddedLines: 1,
      retainedAiAddedLines: 1,
      committedAddedLines: 2,
      eligibleCommittedAddedLines: 1,
      coveredCommittedAddedLines: 2,
      stillPresentAiAddedLines: null,
    }),
    /已覆盖提交新增行数不能超过/u,
  );
  assert.throws(
    () => calculateOrchestrationCodeAttributionRates({
      aiGeneratedAddedLines: 1,
      aiCandidateAddedLines: 1,
      retainedAiAddedLines: 1,
      committedAddedLines: 1,
      eligibleCommittedAddedLines: 1,
      coveredCommittedAddedLines: 1,
      stillPresentAiAddedLines: 1,
    }),
    /留存行数必须绑定/u,
  );
});
