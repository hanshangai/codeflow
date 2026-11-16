import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import type { ThreadId, ThreadListScope, ThreadSummary, WorkspaceId } from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import {
  resolveKnowledgeConversationLocation,
  resolveKnowledgeThreadLocation,
  shouldClearPrimarySelectionForListFilter,
} from "../src/features/threads/thread-list-navigation.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useUiStore } from "../src/store/ui.ts";

function summary(id: string, threadSubtype: ThreadSummary["threadSubtype"] = null): ThreadSummary {
  return {
    id: id as ThreadId,
    title: id,
    threadType: "chat",
    threadSubtype,
    archived: false,
    engine: "codex",
    createdAt: 1,
    updatedAt: 2,
  };
}

test("规格讨论和文件工作会话直开主会话，归档历史仍可读取", () => {
  const knowledge = summary("knowledge-topic", "knowledge-conversation");
  const workspaceId = "client-a:project-a";
  assert.deepEqual(resolveKnowledgeConversationLocation(knowledge, workspaceId), {
    path: "/chat",
    query: { workspaceId, threadId: knowledge.id },
  });
  const archivedKnowledge: ThreadSummary = { ...knowledge, archived: true };
  assert.deepEqual(resolveKnowledgeConversationLocation(archivedKnowledge, workspaceId), {
    path: "/chat",
    query: { workspaceId, threadId: knowledge.id },
  });
  assert.equal(resolveKnowledgeConversationLocation(summary("development"), workspaceId), null);
  assert.equal(resolveKnowledgeConversationLocation(summary("flow", "node"), workspaceId), null);
  const execution = summary("knowledge-execution", "knowledge-assets");
  assert.deepEqual(resolveKnowledgeThreadLocation(execution, workspaceId), {
    path: "/chat",
    query: { workspaceId, threadId: execution.id },
  });
});

test("进入、离开知识筛选和知识工作台筛选保留原研发选择", () => {
  const selected = summary("development");
  const cases: Array<[ThreadListScope, ThreadListScope, boolean]> = [
    ["current", "knowledge", false],
    ["all", "knowledge", false],
    ["knowledge", "current", false],
    ["knowledge", "archived", false],
    ["current", "archived", true],
  ];
  for (const [currentScope, nextScope, knowledgePageActive] of cases) {
    assert.equal(shouldClearPrimarySelectionForListFilter({
      currentScope,
      nextScope,
      knowledgePageActive,
      selectedThreadId: selected.id,
      selectedThread: selected,
    }), false, `${currentScope} -> ${nextScope}`);
  }
});

test("普通筛选仍清理不匹配的主会话选择，同范围与全部筛选保持选择", () => {
  const selected = summary("development");
  const base = {
    currentScope: "current" as const,
    knowledgePageActive: false,
    selectedThreadId: selected.id,
    selectedThread: selected,
  };
  assert.equal(shouldClearPrimarySelectionForListFilter({ ...base, nextScope: "orchestration" }), true);
  assert.equal(shouldClearPrimarySelectionForListFilter({ ...base, nextScope: "archived" }), true);
  assert.equal(shouldClearPrimarySelectionForListFilter({ ...base, nextScope: "all" }), false);
  assert.equal(shouldClearPrimarySelectionForListFilter({ ...base, nextScope: "current" }), false);
});

test("真实列表刷新切入知识scope后，研发摘要、选择和未发出的草稿仍可恢复", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ui = useUiStore();
  const development = summary("development");
  const knowledge = summary("knowledge-topic", "knowledge-conversation");
  const workspaceId = "client-a:workspace-a" as WorkspaceId;
  const ctx: ApiRequestContext = {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "test-session",
    webSessionId: "test-web",
    ensureSession: async () => "test-session",
    clearSession() {},
  };
  const draft = {
    text: "未发出的研发草稿",
    images: [],
    files: [],
    version: 1,
    updatedAt: 2,
    updatedByWebSessionId: "test-web",
  };
  chat.threads = [development];
  chat.selectedThreadId = development.id;
  chat.threadDraftByThreadId[String(development.id)] = draft;
  const fetchedScopes: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/threads");
    const scope = url.searchParams.get("scope") ?? "";
    fetchedScopes.push(scope);
    return new Response(JSON.stringify({
      ok: true,
      threads: scope === "knowledge" ? [knowledge] : [development],
      hasMore: false,
      nextCursor: null,
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    ui.setThreadFilterTab("knowledge");
    await chat.refreshThreads(ctx, workspaceId);
    assert.deepEqual(chat.threads.map((item) => item.id), [knowledge.id]);
    assert.equal(chat.selectedThreadId, development.id);
    assert.deepEqual(chat.selectedThread, development);
    assert.deepEqual(chat.threadDraftByThreadId[String(development.id)], draft);
    ui.setThreadFilterTab("current");
    await chat.refreshThreads(ctx, workspaceId);
    assert.equal(chat.selectedThreadId, development.id);
    assert.deepEqual(chat.selectedThread, development);
    assert.deepEqual(chat.threadDraftByThreadId[String(development.id)], draft);
    assert.deepEqual(fetchedScopes, ["knowledge", "current"]);
    assert.equal(chat.extraThreadSummariesById[String(development.id)], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
