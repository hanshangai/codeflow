import test from "node:test";
import assert from "node:assert/strict";

import type { TaskIntake, TaskIntakeMetricCohortPairEvidenceRef } from "@codeflowai/shared";
import {
  deriveDueMetricReviewReminders,
  toMetricReviewReminderItem,
} from "../../apps/desktop/client/src/reminders/orchestrationMetricReviewReminder.ts";

const NOW = 1_800_000_000_000;

/** Builds the minimum valid cohort-pair evidence needed by the reminder policy. */
function makePair(overrides: Partial<TaskIntakeMetricCohortPairEvidenceRef> = {}): TaskIntakeMetricCohortPairEvidenceRef {
  const cohort = (cohortKey: string) => ({
    cohortKey,
    criterion: "primary_success",
    evaluatorId: "eval-1",
    evaluatorVersion: "1",
    workflowSnapshotHash: "workflow-hash",
    roleSnapshotHash: "role-hash",
    nodeId: "node-1",
    promptDefinitionHash: "prompt-hash",
    engine: "codex",
    model: "gpt-5",
    effort: "medium",
    current: null,
    comparison: null,
    conclusion: null,
  });
  return {
    kind: "orchestration_evaluation_cohort_pair",
    scopeKind: "mine",
    currentPeriod: { from: NOW - 40_000, to: NOW - 30_000 },
    comparisonPeriod: { from: NOW - 60_000, to: NOW - 50_000 },
    baseline: cohort("baseline"),
    candidate: cohort("candidate"),
    observationWindow: { from: NOW - 20_000, to: NOW },
    reviews: [],
    createdAt: NOW - 70_000,
    ...overrides,
  };
}

/** Builds one local Intake around the supplied evidence list. */
function makeIntake(metricEvidenceRefs: TaskIntake["metricEvidenceRefs"]): TaskIntake {
  return {
    id: "intake-1" as TaskIntake["id"],
    workspaceId: "workspace-1" as TaskIntake["workspaceId"],
    triggerMode: "manual",
    taskType: "unknown",
    title: "验证候选版本",
    goal: "验证候选版本是否改善",
    metricEvidenceRefs,
    requester: { userId: "requester-1", source: "ui" },
    createdAt: NOW - 80_000,
    updatedAt: NOW - 70_000,
  };
}

test("metric review reminder is due at the window boundary and maps to review action", () => {
  const reminders = deriveDueMetricReviewReminders([makeIntake([makePair()])], NOW);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0]!.requesterUserId, "requester-1");
  assert.match(reminders[0]!.notificationKey, /^orch:intake:intake-1:metric-review:[a-f0-9]{64}$/);

  const item = toMetricReviewReminderItem(reminders[0]!);
  assert.equal(item.primaryActionKind, "open_orch_metric_review");
  assert.equal(item.statusLabel, "待复评");
  assert.equal(item.routeTarget.intakeId, "intake-1");
});

test("metric review reminder excludes future, legacy and post-window reviewed evidence", () => {
  const future = makePair({ observationWindow: { from: NOW + 1, to: NOW + 10_000 } });
  const reviewed = makePair({
    candidate: { ...makePair().candidate, cohortKey: "candidate-reviewed" },
    reviews: [{ evaluatedAt: NOW + 1 } as any],
  });
  const legacy = { kind: "orchestration_evaluation_cohort" } as any;
  assert.deepEqual(deriveDueMetricReviewReminders([makeIntake([future, reviewed, legacy])], NOW), []);
});

test("candidate or observation change produces a new stable notification key", () => {
  const first = deriveDueMetricReviewReminders([makeIntake([makePair()])], NOW)[0]!;
  const changedCandidate = deriveDueMetricReviewReminders([makeIntake([makePair({
    candidate: { ...makePair().candidate, cohortKey: "candidate-v2" },
  })])], NOW)[0]!;
  const changedWindow = deriveDueMetricReviewReminders([makeIntake([makePair({
    observationWindow: { from: NOW - 10_000, to: NOW - 1 },
  })])], NOW)[0]!;
  assert.notEqual(changedCandidate.notificationKey, first.notificationKey);
  assert.notEqual(changedWindow.notificationKey, first.notificationKey);
});

test("damaged due evidence fails instead of disappearing", () => {
  const damaged = makePair({ observationWindow: { from: NOW, to: NOW } });
  assert.throws(
    () => deriveDueMetricReviewReminders([makeIntake([damaged])], NOW),
    /复评提醒证据损坏.*intakeId=intake-1/,
  );
});

test("all review history entries are validated even after a post-window review", () => {
  const damagedHistory = makePair({ reviews: [{ evaluatedAt: NOW + 1 } as any, { evaluatedAt: Number.NaN } as any] });
  assert.throws(
    () => deriveDueMetricReviewReminders([makeIntake([damagedHistory])], NOW),
    /复评提醒历史时间损坏.*intakeId=intake-1/,
  );
});
