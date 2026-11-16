import type { ThreadId } from "@codeflowai/shared";

export type ThreadUrlUpdateMode = "replace" | "push";
export const THREAD_URL_CHANGED_EVENT = "codeflow-thread-urlchange";

export function getThreadIdFromUrl(): ThreadId | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("threadId");
  return id ? (id as ThreadId) : null;
}

export function buildThreadUrl(threadId: ThreadId | null): string {
  const url = new URL(window.location.href);
  if (threadId) {
    url.searchParams.set("threadId", threadId);
  } else {
    url.searchParams.delete("threadId");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function setThreadIdToUrl(threadId: ThreadId | null): void {
  updateThreadIdInUrl(threadId, { mode: "replace" });
}

export function pushThreadIdToUrl(threadId: ThreadId | null, historyState?: unknown): void {
  updateThreadIdInUrl(threadId, { mode: "push", historyState });
}

export function updateThreadIdInUrl(
  threadId: ThreadId | null,
  opts?: { mode?: ThreadUrlUpdateMode; historyState?: unknown },
): void {
  const mode = opts?.mode ?? "replace";
  const nextUrl = buildThreadUrl(threadId);
  if (mode === "push") {
    window.history.pushState(opts?.historyState ?? window.history.state, "", nextUrl);
    notifyThreadUrlChanged(threadId, mode);
    return;
  }
  window.history.replaceState(opts?.historyState ?? window.history.state, "", nextUrl);
  notifyThreadUrlChanged(threadId, mode);
}

function notifyThreadUrlChanged(threadId: ThreadId | null, mode: ThreadUrlUpdateMode): void {
  window.dispatchEvent(new CustomEvent(THREAD_URL_CHANGED_EVENT, {
    detail: {
      threadId,
      mode,
      href: window.location.href,
    },
  }));
}

