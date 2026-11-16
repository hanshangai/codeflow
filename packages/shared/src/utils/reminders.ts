import type { ReminderDisplayKind, ReminderItem } from "../types/http.js";

export function resolveReminderDisplayKind(
  item: Pick<ReminderItem, "displayKind" | "isActionRequired">,
): ReminderDisplayKind {
  if (item.displayKind === "action" || item.displayKind === "receipt" || item.displayKind === "status") {
    return item.displayKind;
  }
  return item.isActionRequired ? "action" : "receipt";
}

export function isReminderActionItem(
  item: Pick<ReminderItem, "displayKind" | "isActionRequired">,
): boolean {
  return resolveReminderDisplayKind(item) === "action";
}

export function isReminderReceiptItem(
  item: Pick<ReminderItem, "displayKind" | "isActionRequired">,
): boolean {
  return resolveReminderDisplayKind(item) === "receipt";
}

export function isReminderStatusItem(
  item: Pick<ReminderItem, "displayKind" | "isActionRequired">,
): boolean {
  return resolveReminderDisplayKind(item) === "status";
}

export function isReminderAttentionItem(
  item: Pick<ReminderItem, "displayKind" | "isActionRequired">,
): boolean {
  const kind = resolveReminderDisplayKind(item);
  return kind === "action" || kind === "receipt";
}

export function buildReminderAttentionSignature(
  items: Array<Pick<ReminderItem, "id" | "displayKind" | "isActionRequired">>,
): string {
  return items
    .filter((item) => isReminderAttentionItem(item))
    .map((item) => String(item.id ?? "").trim())
    .filter(Boolean)
    .join("|");
}
