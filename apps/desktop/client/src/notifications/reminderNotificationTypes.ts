import type { ReminderSourceType, WorkspaceId } from "@codeflowai/shared";

/** Client 上报给 Server 的外部通知收件人路由信息。 */
export type ReminderNotificationRecipientRouting = {
  sharedWorkspaceId?: string | null;
  recipientUserIds?: string[] | null;
};

export type ReminderCompletionNotification = ReminderNotificationRecipientRouting & {
  notificationKey: string;
  sourceType: ReminderSourceType;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  title: string;
  summary: string;
  targetId: string;
  completedAt: number;
};

export type ReminderActionNotification = ReminderNotificationRecipientRouting & {
  notificationKey: string;
  sourceType: ReminderSourceType;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  title: string;
  summary: string;
  targetId: string;
  statusLabel: string;
  actionLabel?: string | null;
  occurredAt: number;
};

export type ReminderCompletionNotifier = {
  notifyCompletion: (input: ReminderCompletionNotification) => Promise<void>;
  notifyAction: (input: ReminderActionNotification) => Promise<void>;
};

/** 组合多个待办通知器；逐个尝试发送，任一失败则整体失败便于调用方记录上下文。 */
export function createCompositeReminderCompletionNotifier(notifiers: ReminderCompletionNotifier[]): ReminderCompletionNotifier {
  return {
    async notifyCompletion(input) {
      const results = await Promise.allSettled(notifiers.map((notifier) => notifier.notifyCompletion(input)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (!failures.length) return;
      const message = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join("; ");
      throw new Error(`reminder completion notification failed: ${message}`);
    },
    async notifyAction(input) {
      const results = await Promise.allSettled(notifiers.map((notifier) => notifier.notifyAction(input)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (!failures.length) return;
      const message = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join("; ");
      throw new Error(`reminder action notification failed: ${message}`);
    },
  };
}
