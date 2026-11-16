import type { ReminderItem } from "@codeflowai/shared";

/** Keep chat reminders only; orchestration reminders come from pending-mine. */
export function selectOfficeH5ChatReminderItems(items: ReminderItem[]): ReminderItem[] {
  return items
    .filter((item) => item.sourceType === "chat")
    .sort((left, right) => right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id)));
}
