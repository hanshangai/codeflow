import crypto from "node:crypto";

import type {
  OrchestrationMetricReviewReminderScanItem,
  ReminderItem,
  TaskIntake,
  TaskIntakeMetricCohortPairEvidenceRef,
} from "@codeflowai/shared";
import { getTaskIntakeTitle } from "@codeflowai/shared";

export type DueMetricReviewReminder = Omit<OrchestrationMetricReviewReminderScanItem, "workspaceTitle"> & {
  reminderId: string;
  ignoreMarker: string;
};

/** Derives due review reminders from persisted Intake facts without saving notification state. */
export function deriveDueMetricReviewReminders(intakes: TaskIntake[], now: number): DueMetricReviewReminder[] {
  if (!Number.isFinite(now) || now <= 0) throw new Error(`复评提醒扫描时间非法：${String(now)}`);
  const reminders: DueMetricReviewReminder[] = [];
  for (const intake of intakes) {
    for (const evidence of intake.metricEvidenceRefs ?? []) {
      if (evidence.kind !== "orchestration_evaluation_cohort_pair" || !evidence.observationWindow) continue;
      const reminder = derivePairReminder(intake, evidence, now);
      if (reminder) reminders.push(reminder);
    }
  }
  return reminders.sort((left, right) => right.observationEndedAt - left.observationEndedAt || left.notificationKey.localeCompare(right.notificationKey));
}

/** Converts one due fact into the existing in-app reminder contract. */
export function toMetricReviewReminderItem(reminder: DueMetricReviewReminder): ReminderItem {
  return {
    id: reminder.reminderId,
    sourceType: "orchestration",
    workspaceId: reminder.workspaceId,
    displayKind: "action",
    title: reminder.title,
    statusLabel: "待复评",
    tone: "warning",
    summary: "候选观察窗口已结束，等待复评。",
    updatedAt: reminder.observationEndedAt,
    isActionRequired: true,
    readState: "unread",
    primaryActionKind: "open_orch_metric_review",
    primaryActionLabel: "打开复评",
    ignoreMarker: reminder.ignoreMarker,
    routeTarget: {
      workspaceId: reminder.workspaceId,
      intakeId: reminder.intakeId,
    },
  };
}

/** Removes in-app-only fields before returning a Scheduler scan result. */
export function toMetricReviewReminderScanItem(reminder: DueMetricReviewReminder, workspaceTitle: string): OrchestrationMetricReviewReminderScanItem {
  return {
    notificationKey: reminder.notificationKey,
    workspaceId: reminder.workspaceId,
    workspaceTitle: String(workspaceTitle ?? "").trim() || String(reminder.workspaceId),
    intakeId: reminder.intakeId,
    title: reminder.title,
    requesterUserId: reminder.requesterUserId,
    observationEndedAt: reminder.observationEndedAt,
  };
}

/** Validates one cohort pair and returns its due reminder when no post-window review exists. */
function derivePairReminder(
  intake: TaskIntake,
  evidence: TaskIntakeMetricCohortPairEvidenceRef,
  now: number,
): DueMetricReviewReminder | null {
  const from = Number(evidence.observationWindow?.from);
  const to = Number(evidence.observationWindow?.to);
  const baselineKey = String(evidence.baseline?.cohortKey ?? "").trim();
  const candidateKey = String(evidence.candidate?.cohortKey ?? "").trim();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from || !baselineKey || !candidateKey || baselineKey === candidateKey) {
    throw new Error(`复评提醒证据损坏：workspaceId=${String(intake.workspaceId)}, intakeId=${String(intake.id)}`);
  }
  if (to > now) return null;
  const reviews = evidence.reviews ?? [];
  if (!Array.isArray(reviews)) {
    throw new Error(`复评提醒历史损坏：workspaceId=${String(intake.workspaceId)}, intakeId=${String(intake.id)}`);
  }
  let hasPostWindowReview = false;
  for (const review of reviews) {
    const evaluatedAt = Number(review?.evaluatedAt);
    if (!Number.isFinite(evaluatedAt) || evaluatedAt <= 0) {
      throw new Error(`复评提醒历史时间损坏：workspaceId=${String(intake.workspaceId)}, intakeId=${String(intake.id)}`);
    }
    if (evaluatedAt >= to) hasPostWindowReview = true;
  }
  if (hasPostWindowReview) return null;

  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([String(intake.id), baselineKey, candidateKey, to]))
    .digest("hex");
  const notificationKey = `orch:intake:${String(intake.id)}:metric-review:${digest}`;
  return {
    notificationKey,
    reminderId: notificationKey,
    ignoreMarker: notificationKey,
    workspaceId: intake.workspaceId,
    intakeId: intake.id,
    title: getTaskIntakeTitle(intake),
    requesterUserId: normalizeOptionalString(intake.requester?.userId),
    observationEndedAt: to,
  };
}

/** Normalizes an optional user identifier without inventing a recipient. */
function normalizeOptionalString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
