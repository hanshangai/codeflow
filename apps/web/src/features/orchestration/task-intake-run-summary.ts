import type {
  IntakeId,
  OrchestrationInstanceSummary,
  OrchestrationRunSummary,
} from "@codeflowai/shared";

export type IntakeRunTone = OrchestrationRunSummary["statusTone"];
export type IntakeRunSummary = OrchestrationRunSummary;

/** 选择某需求应展示的执行摘要：优先活跃执行，其次最新历史执行。 */
export function pickDisplayInstanceForIntake(
  intakeId: IntakeId,
  instances: OrchestrationInstanceSummary[],
): OrchestrationInstanceSummary | null {
  const matched = instances.filter((instance) => instance.intakeId === intakeId);
  if (!matched.length) return null;
  const active = matched
    .filter((instance) =>
      instance.status === "pending"
      || instance.status === "running"
      || instance.status === "paused"
      || instance.status === "waiting-start"
      || instance.status === "waiting-approval"
      || instance.status === "waiting-feedback")
    .sort(compareInstanceSummariesByUpdatedAt);
  if (active[0]) return active[0];
  return [...matched].sort(compareInstanceSummariesByUpdatedAt)[0] ?? null;
}

/** 从实例摘要列表派生需求卡片运行摘要，避免前端重复读取详情级快照。 */
export function deriveIntakeRunSummary(
  intakeId: IntakeId,
  instances: OrchestrationInstanceSummary[],
): IntakeRunSummary | null {
  return pickDisplayInstanceForIntake(intakeId, instances)?.runSummary ?? null;
}

/** 判断需求当前是否已流转到指定处理人负责的活跃节点。 */
export function isIntakePendingForAssignee(
  intakeId: IntakeId,
  instances: OrchestrationInstanceSummary[],
  userId: string | null | undefined,
): boolean {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) return false;
  const summary = pickDisplayInstanceForIntake(intakeId, instances)?.runSummary ?? null;
  if (!summary?.activeNodeId) return false;
  return (summary.activeNodeAssigneeUserIds ?? [])
    .some((assigneeUserId) => String(assigneeUserId).trim() === normalizedUserId);
}

function compareInstanceSummariesByUpdatedAt(left: OrchestrationInstanceSummary, right: OrchestrationInstanceSummary): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}
