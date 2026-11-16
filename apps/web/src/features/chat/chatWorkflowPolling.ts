import { CHAT_WORKFLOW_ACTIVE_STATUSES, type ChatWorkflowSnapshot } from "@codeflowai/shared";

/** 页面后台和升级拒绝暂停；空闲降频，失败按次数退避。 */
export function chatWorkflowPollDelay(input: {
  visible: boolean;
  snapshot: ChatWorkflowSnapshot;
  errorCode: string | null;
  failures: number;
}): number | null {
  if (!input.visible || input.errorCode === "CLIENT_UPGRADE_REQUIRED") return null;
  if (input.failures) return Math.min(60_000, 10_000 * 2 ** Math.min(input.failures - 1, 3));
  const active = input.snapshot.tasks.some(view => view.task.state === "starting"
    || (view.status && CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status))
    || view.continuation?.status === "pending" || view.continuation?.status === "sending");
  return active ? 4_000 : 30_000;
}
