import { isOrchestrationScopedThread, type ThreadSubtype, type ThreadType } from "@codeflowai/shared";

type ThreadCompletionNotificationPolicyInput = {
  threadType?: ThreadType | null;
  threadSubtype?: ThreadSubtype | null;
} | null | undefined;

/** 判断 thread 完成后是否应按普通会话发送外部完成通知。 */
export function shouldSendThreadCompletionNotification(thread: ThreadCompletionNotificationPolicyInput): boolean {
  if (!thread) return true;
  return !isOrchestrationScopedThread({
    threadType: thread.threadType ?? "chat",
    threadSubtype: thread.threadSubtype ?? null,
  });
}
