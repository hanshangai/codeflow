import { randomUUID } from "node:crypto";
import type { ClientToServerMessage, ServerToClientMessage } from "@codeflowai/shared";

import type { WsSendJsonResult } from "../transport/wsTransport.js";
import type { ReminderActionNotification, ReminderCompletionNotification, ReminderCompletionNotifier } from "./reminderNotificationTypes.js";

type NotificationMessage = Extract<ClientToServerMessage, { t: "reminder.completionNotification" | "reminder.actionNotification" }>;

/** 单连接通知回执owner；接收只表示入队，成功必须来自Server实际处理结果。 */
export function createReminderDeliveryOwner(input: { send(message: NotificationMessage): { accepted: boolean }; timeoutMs: number }) {
  const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("REMINDER_DELIVERY_TIMEOUT_INVALID");
  return {
    /** 固定请求身份后发送，传输拒绝、断线和实际发送失败均拒绝原Promise。 */
    notify(message: ClientToServerMessage): Promise<void> {
      if (message.t !== "reminder.completionNotification" && message.t !== "reminder.actionNotification") return Promise.reject(new Error("REMINDER_DELIVERY_MESSAGE_INVALID"));
      if (pending.size >= 256) return Promise.reject(new Error("REMINDER_DELIVERY_CAPACITY_EXCEEDED"));
      const requestId = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("REMINDER_DELIVERY_ACK_TIMEOUT")); }, input.timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try { if (!input.send({ ...message, requestId }).accepted) throw new Error("REMINDER_DELIVERY_DISPATCH_REJECTED"); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    },
    /** 只认本连接仍在途的requestId，重复及旧owner回执不改变当前任务。 */
    accept(message: Extract<ServerToClientMessage, { t: "reminder.deliveryResult" }>): boolean {
      const waiter = pending.get(message.requestId);
      if (!waiter) return false;
      pending.delete(message.requestId); clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve();
      else waiter.reject(Object.assign(new Error(message.errorCode), { code: message.errorCode, requestId: message.requestId }));
      return true;
    },
    /** 原连接退役即拒绝所有等待，不能将结果转给后来登录的账号。 */
    disconnect(error: Error): void {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      pending.clear();
    },
  };
}

/** 创建 Server 上报通知器，由 Server 按当前账号的用户级配置发送外部通知。 */
export function createServerReminderNotifier(input: {
  sendToServer: (message: ClientToServerMessage) => WsSendJsonResult;
  /** 由连接owner关联实际发送结果；socket排队成功不能代替通知完成。 */
  notifyOnServer?: (message: ClientToServerMessage) => Promise<void>;
  /** 由统一需求 owner 校验工作区、账号与订阅；缺少需求不发送。 */
  canSend?: (notification: ReminderCompletionNotification | ReminderActionNotification) => boolean;
}): ReminderCompletionNotifier {
  return {
    /** 仅派发当前有效需求期间产生的完成提醒。 */
    async notifyCompletion(notification: ReminderCompletionNotification): Promise<void> {
      if (input.canSend?.(notification) !== true) return;
      if (!input.notifyOnServer) throw new Error("REMINDER_DELIVERY_ACK_OWNER_UNAVAILABLE");
      await input.notifyOnServer({
        t: "reminder.completionNotification",
        notification,
      } satisfies ClientToServerMessage);
    },
    /** 仅派发当前有效需求期间产生的待办提醒。 */
    async notifyAction(notification: ReminderActionNotification): Promise<void> {
      if (input.canSend?.(notification) !== true) return;
      if (!input.notifyOnServer) throw new Error("REMINDER_DELIVERY_ACK_OWNER_UNAVAILABLE");
      await input.notifyOnServer({
        t: "reminder.actionNotification",
        notification,
      } satisfies ClientToServerMessage);
    },
  };
}
