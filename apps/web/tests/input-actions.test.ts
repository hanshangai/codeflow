import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createPinia, setActivePinia } from "pinia";
import { isThreadInputActionEnabled, type ThreadInputAction } from "@codeflowai/shared";

import { findLatestOptimisticUserMessageByContent } from "../src/features/chat/engineEventReducerHelpers.ts";
import { applyEngineEventToConversation } from "../src/features/chat/engineEventReducer.ts";
import {
  buildCodexSlashInputActions,
  filterComposerInputActions,
  findCodexResumeTarget,
  isComposerInputActionsEnabled,
  resolveComposerInputSubmission,
  resolveEditedComposerInputKind,
  reconcileComposerInputContract,
  validateComposerActionSubmission,
} from "../src/features/composer/input-actions.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useThreadQueueStore } from "../src/store/threadQueue.ts";
import type { ApiRequestContext } from "../src/api/request.ts";

const SKILL_ID = `csk_${"A".repeat(43)}`;
const originalFetch = globalThis.fetch;
const composerSource = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

/** 构造不依赖浏览器登录态的本地 API 上下文。 */
function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-input-actions",
    webSessionId: "web-input-actions",
    ensureSession: async () => "session-input-actions",
    clearSession() {},
  };
}

/** 返回统一 API 成功响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 取指定 token 的动作候选；缺失时直接失败，避免可选链把断言目标缺失也当通过。 */
function requireAction(actions: ThreadInputAction[], token: string): ThreadInputAction {
  const found = actions.find((action) => action.token === token);
  assert.ok(found, `未找到 ${token} 候选`);
  return found;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("input actions are limited to the default ordinary chat composer", () => {
  assert.equal(isComposerInputActionsEnabled({ surface: "default", threadType: "chat", threadSubtype: null }), true);
  assert.equal(isComposerInputActionsEnabled({ surface: "default", threadType: null, threadSubtype: null }), false);
  assert.equal(isComposerInputActionsEnabled({ surface: "h5", threadType: "chat", threadSubtype: null }), false);
  assert.equal(isComposerInputActionsEnabled({ surface: "default", threadType: "orchestration", threadSubtype: null }), false);
  assert.equal(isComposerInputActionsEnabled({ surface: "default", threadType: "chat", threadSubtype: "node" }), false);
});

test("actual edits classify only wire-sensitive input", () => {
  assert.equal(resolveEditedComposerInputKind({
    enabled: true,
    engine: "claude",
    rawText: "/compact keep args  ",
  }), "provider-slash");
  assert.equal(resolveEditedComposerInputKind({
    enabled: true,
    engine: "claude",
    rawText: "  /compact",
  }), "message");
  assert.equal(resolveEditedComposerInputKind({ enabled: true, engine: "claude", rawText: "$skill" }), undefined);
  assert.equal(resolveEditedComposerInputKind({ enabled: true, engine: "codex", rawText: "/unknown" }), "message");
  assert.equal(resolveEditedComposerInputKind({
    enabled: true,
    engine: "codex",
    rawText: "use $alpha",
    skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 4, end: 10 }],
  }), "message");
});

test("reconciles stale input contracts when engine or raw prefix changes", () => {
  assert.deepEqual(reconcileComposerInputContract({
    enabled: true,
    engine: "codex",
    rawText: "/unknown",
    inputKind: "provider-slash",
  }), { inputKind: "message" });
  assert.deepEqual(reconcileComposerInputContract({
    enabled: true,
    engine: "claude",
    rawText: "hello",
    inputKind: "provider-slash",
  }), {});
  assert.deepEqual(reconcileComposerInputContract({
    enabled: true,
    engine: "claude",
    rawText: "  /unknown",
  }), { inputKind: "message" });
  assert.deepEqual(reconcileComposerInputContract({
    enabled: false,
    engine: "codex",
    rawText: "use $alpha",
    inputKind: "message",
    skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 4, end: 10 }],
  }), {});
});

test("submission keeps raw Claude Slash and maps exact Codex CLI commands", () => {
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/compact",
  }), { mode: "host-action", action: "compact", rawText: "/compact" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/compact ",
  }), { mode: "host-action", action: "compact", rawText: "/compact " });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "/compact keep args  ",
    inputKind: "provider-slash",
  }), { mode: "provider-slash", text: "/compact keep args  ", inputKind: "provider-slash" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "/typed-before-watch",
  }), { mode: "provider-slash", text: "/typed-before-watch", inputKind: "provider-slash" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "/compact",
    inputKind: "message",
  }), { mode: "message", text: "/compact", inputKind: "message" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/unknown",
  }), { mode: "message", text: "/unknown", inputKind: "message" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "  /unknown",
  }), { mode: "message", text: "/unknown", inputKind: "message" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "hello",
    inputKind: "provider-slash",
  }), { mode: "message", text: "hello" });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "hello",
    inputKind: "provider-slash",
  }), { mode: "message", text: "hello" });
});

test("submission trims Codex display text and rebases opaque binding offsets", () => {
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "  use $alpha  ",
    inputKind: "message",
    skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 6, end: 12 }],
  }), {
    mode: "message",
    text: "use $alpha",
    inputKind: "message",
    skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 4, end: 10 }],
  });
});

test("catalog filtering is case-insensitive without rewriting Provider tokens", () => {
  const actions: ThreadInputAction[] = [
    {
      kind: "codex-skill",
      token: "$Alpha",
      name: "Alpha",
      skillId: SKILL_ID,
      sourceLabel: "repo",
    },
    {
      kind: "slash",
      token: "/Compact",
      source: "claude",
      delivery: "provider-slash",
      providerName: "Compact",
      isSkill: false,
      enabled: true,
    },
  ];
  assert.deepEqual(filterComposerInputActions(actions, "alp").map((item) => item.token), ["$Alpha"]);
  assert.deepEqual(filterComposerInputActions(actions, "comp").map((item) => item.token), ["/Compact"]);
});

test("Codex Slash filtering follows exact then prefix order and rejects arbitrary substrings", () => {
  const actions = buildCodexSlashInputActions({
    hasConversationHistory: true,
    runningTurnId: null,
    queueLength: 0,
  });
  assert.deepEqual(filterComposerInputActions(actions, "mo").map((item) => item.token), ["/model"]);
  assert.deepEqual(filterComposerInputActions(actions, "ac").map((item) => item.token), []);
  assert.deepEqual(filterComposerInputActions(actions, "stop").map((item) => item.token), ["/stop"]);
  assert.deepEqual(filterComposerInputActions(actions, "clean").map((item) => item.token), ["/stop"]);
});

test("Codex picker follows CLI alias visibility while retaining alias lookup", () => {
  const actions = buildCodexSlashInputActions({
    hasConversationHistory: true,
    runningTurnId: null,
    queueLength: 0,
  });
  const empty = filterComposerInputActions(actions, "").map((item) => item.token);
  assert.equal(empty.includes("/quit"), false);
  assert.equal(empty.includes("/btw"), false);
  assert.equal(empty.includes("/exit"), true);
  assert.equal(empty.includes("/side"), true);
  assert.deepEqual(filterComposerInputActions(actions, "qui").map((item) => item.token), ["/quit"]);
  assert.deepEqual(filterComposerInputActions(actions, "btw").map((item) => item.token), ["/btw"]);
  assert.ok(empty.length > 1);
});

test("local compact candidate and action conflicts reflect live execution boundaries", () => {
  const emptyHistoryActions = buildCodexSlashInputActions({
    hasConversationHistory: false,
    runningTurnId: null,
    queueLength: 0,
  });
  assert.equal(isThreadInputActionEnabled(requireAction(emptyHistoryActions, "/compact")), false);
  const historyActions = buildCodexSlashInputActions({
    hasConversationHistory: true,
    runningTurnId: null,
    queueLength: 0,
  });
  assert.equal(isThreadInputActionEnabled(requireAction(historyActions, "/compact")), true);

  const providerSlash = resolveComposerInputSubmission({
    enabled: true,
    engine: "claude",
    rawText: "/status",
    inputKind: "provider-slash",
  });
  assert.match(validateComposerActionSubmission({
    submission: providerSlash,
    hasRole: true,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    skillMentionCount: 0,
    runningTurnId: null,
    queueLength: 0,
  }) ?? "", /不能同时携带角色/u);
  assert.match(validateComposerActionSubmission({
    submission: { mode: "provider-slash", text: "/status\nnext", inputKind: "provider-slash" },
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    skillMentionCount: 0,
    runningTurnId: null,
    queueLength: 0,
  }) ?? "", /仅支持单行/u);
  const resume = resolveComposerInputSubmission({ enabled: true, engine: "codex", rawText: "/resume" });
  assert.match(validateComposerActionSubmission({
    submission: resume,
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    skillMentionCount: 0,
    runningTurnId: "turn-1",
    queueLength: 0,
  }) ?? "", /不能在 AI 回合运行中执行/u);
});

test("Codex picker exposes the complete CLI directory with executable public commands", () => {
  const actions = buildCodexSlashInputActions({
    hasConversationHistory: true,
    runningTurnId: null,
    queueLength: 0,
  });
  assert.ok(actions.some((action) => action.token === "/model"));
  assert.ok(actions.some((action) => action.token === "/subagents"));
  assert.equal(actions.some((action) => action.token === "/plan"), false);
  assert.equal(actions.some((action) => action.token === "/mode"), false);
  assert.equal(actions.every((action) => action.kind === "slash" && action.source === "codeflow" && action.webSupport === "supported"), true);
  assert.equal(isThreadInputActionEnabled(requireAction(actions, "/fork")), true);
  assert.equal(isThreadInputActionEnabled(requireAction(actions, "/compact")), true);
});

test("Codex host submissions carry inline args and canonical clean action", () => {
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/review custom",
  }), {
    mode: "host-action",
    action: "review",
    rawText: "/review custom",
    args: " custom",
    trimmedArgs: "custom",
  });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/fast on",
  }), {
    mode: "message",
    text: "/fast on",
    inputKind: "message",
  });
  assert.deepEqual(resolveComposerInputSubmission({
    enabled: true,
    engine: "codex",
    rawText: "/clean",
  }), {
    mode: "host-action",
    action: "stop",
    rawText: "/clean",
  });
  const fork = resolveComposerInputSubmission({ enabled: true, engine: "codex", rawText: "/fork" });
  assert.equal(validateComposerActionSubmission({
    submission: fork,
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    skillMentionCount: 0,
    runningTurnId: null,
    queueLength: 0,
  }), null);
});

test("Codex resume target prefers exact ID, then title, and excludes current thread", () => {
  const candidates = [
    { id: "current", title: "当前", engine: "codex" as const },
    { id: "thread-a", title: "API 修复", engine: "codex" as const },
    { id: "thread-b", title: "API 修复后续", engine: "codex" as const },
    { id: "claude-a", title: "API 修复", engine: "claude" as const },
  ];
  assert.equal(findCodexResumeTarget(candidates, "thread-a", "current")?.id, "thread-a");
  assert.equal(findCodexResumeTarget(candidates, "API 修复", "current")?.id, "thread-a");
  assert.equal(findCodexResumeTarget(candidates, "后续", "current")?.id, "thread-b");
  assert.equal(findCodexResumeTarget(candidates, "current", "current"), null);
  assert.equal(findCodexResumeTarget(candidates, "claude-a", "current"), null);
});

test("pending draft epochs distinguish input kind and Skill binding", () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const threadId = "thread-input-actions-draft" as any;
  const base = { text: "$alpha", images: [], files: [], pathReferences: [] };
  const legacyEpoch = chat.setPendingLocalThreadDraft(threadId, base);
  const messageEpoch = chat.setPendingLocalThreadDraft(threadId, { ...base, inputKind: "message" });
  const binding = { skillId: SKILL_ID, name: "alpha", start: 0, end: 6 };
  const bindingEpoch = chat.setPendingLocalThreadDraft(threadId, {
    ...base,
    inputKind: "message",
    skillMentions: [binding],
  });

  assert.notEqual(messageEpoch, legacyEpoch);
  assert.notEqual(bindingEpoch, messageEpoch);
  binding.name = "mutated";
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.skillMentions?.[0]?.name, "alpha");
});

test("optimistic reconciliation distinguishes same text with different input contracts", () => {
  const state = {
    items: [{
      kind: "message",
      id: "local_user_turn-1",
      role: "user",
      turnId: "turn-1",
      text: "$alpha",
      inputKind: "message",
      skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 0, end: 6 }],
    }],
    _indexById: new Map(),
  } as any;

  assert.equal(findLatestOptimisticUserMessageByContent(state, {
    text: "$alpha",
    inputKind: "message",
    skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 0, end: 6 }],
  })?.id, "local_user_turn-1");
  assert.equal(findLatestOptimisticUserMessageByContent(state, {
    text: "$alpha",
    inputKind: "provider-slash",
  }), null);
});

test("canonical user messages retain input kind and opaque Skill binding", () => {
  const state = { items: [], _indexById: new Map() } as any;
  applyEngineEventToConversation(state, {
    schema: 1,
    seq: 1,
    ts: 1,
    workspaceId: "workspace-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.userMessage.created",
    payload: {
      turnId: "turn-1" as any,
      itemId: "item-1" as any,
      text: "$alpha",
      inputKind: "message",
      skillMentions: [{ skillId: SKILL_ID, name: "alpha", start: 0, end: 6 }],
    },
  });
  assert.equal(state.items[0]?.inputKind, "message");
  assert.equal(state.items[0]?.skillMentions?.[0]?.skillId, SKILL_ID);
});

test("queue append forwards explicit message semantics and opaque binding", async () => {
  setActivePinia(createPinia());
  const queue = useThreadQueueStore();
  let requestBody!: Record<string, unknown>;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  const binding = { skillId: SKILL_ID, name: "alpha", start: 0, end: 6 };

  await queue.append(createApiContext(), "workspace-1" as any, "thread-1" as any, {
    text: "$alpha",
    inputKind: "message",
    skillMentions: [binding],
    images: [],
    files: [],
    pathReferences: [],
    sendOptions: {
      workMode: "general",
      roleId: null,
      planMode: false,
      accessMode: "current",
      model: null,
      effort: null,
      contextWindow: null,
      autoCompactPct: 95,
      serviceTier: null,
    },
  });

  assert.equal(requestBody?.inputKind, "message");
  assert.deepEqual(requestBody?.skillMentions, [binding]);
});

test("direct send optimistic message keeps explicit input semantics", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const threadId = "thread-optimistic-input-actions" as any;
  chat.upsertThreadSummary({
    id: threadId,
    workspaceId: "workspace-1",
    engine: "codex",
    title: "Input actions",
    threadType: "chat",
    threadSubtype: null,
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    model: null,
    effort: null,
    accessMode: "current",
    planMode: false,
    autoCompactPct: null,
    contextWindow: null,
  } as any);
  chat.ensureConversation(threadId);
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    turnId: "turn-optimistic-input-actions",
    dispatchMode: "chat_turn",
  })) as typeof fetch;
  const binding = { skillId: SKILL_ID, name: "alpha", start: 0, end: 6 };

  await chat.sendMessage(createApiContext(), {
    workspaceId: "workspace-1" as any,
    threadId,
    text: "$alpha",
    inputKind: "message",
    skillMentions: [binding],
    images: [],
    files: [],
  });

  const optimistic = chat.conversations[String(threadId)]?.items.find((item) => item.kind === "message");
  assert.equal(optimistic?.kind === "message" ? optimistic.inputKind : null, "message");
  assert.deepEqual(optimistic?.kind === "message" ? optimistic.skillMentions : null, [binding]);
});

test("composer guards catalog requests and carries contracts through draft and queue paths", () => {
  assert.match(composerSource, /new AbortController\(\)/u);
  assert.match(composerSource, /inputActionRequestGeneration/u);
  assert.match(composerSource, /currentInputActionScopeKey\(\) === scopeKey/u);
  assert.match(composerSource, /skillMentions: skillMentions\.value\.map/u);
  assert.match(composerSource, /\.\.\.\(sendInputKind \? \{ inputKind: sendInputKind \} : \{\}\)/u);
  assert.match(composerSource, /surface: props\.surface/u);
  assert.match(composerSource, /Codex CLI 命令/u);
  assert.match(composerSource, /engine\.value === "claude" \? "\/ 命令或技能" : "\/ 命令, \$ 技能"/u);
  assert.match(composerSource, /:placeholder="composerPlaceholder"/u);
  assert.match(composerSource, /恢复 Codex 会话/u);
});

test("model host action waits for draft watchers and controls the existing select", () => {
  assert.match(composerSource, /const modelSelectOpen = ref\(false\)/u);
  assert.match(composerSource, /:open="modelSelectOpen"/u);
  assert.match(composerSource, /modelSelectOpen\.value = open/u);
  assert.match(composerSource, /focusHostActionSelect\(modelSelectRef, modelSelectOpen, "模型"\)/u);
  assert.match(composerSource, /const send = async \(\) => \{[\s\S]{0,200}?\/\/[^\n]+\s*await nextTick\(\);/u);
  assert.doesNotMatch(composerSource, /instance\?\.\$el|element\.click\(\)/u);

  const postClearIndex = composerSource.indexOf("if (postClear && clearDraft)");
  const successNoticeIndex = composerSource.indexOf("if (successMessage)", postClearIndex);
  assert.ok(postClearIndex >= 0 && successNoticeIndex > postClearIndex);
});
