import test from "node:test";
import assert from "node:assert/strict";

import { createPinia, setActivePinia } from "pinia";

import type { ApiRequestContext } from "../src/api/request.ts";
import type { ConversationMessage, EngineEventEnvelope } from "@codeflowai/shared";

import { useChatStore } from "../src/store/chat.ts";
import { compressConversationEvents } from "@codeflowai/shared";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const originalFetch = globalThis.fetch;

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildLoadThreadResponse(
  threadId: string,
  events: EngineEventEnvelope[],
) {
  return {
    ok: true,
    thread: {
      id: threadId,
      workspaceId: "client-a:ws-demo",
      engine: "codex",
      title: `会话 ${threadId}`,
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
    },
    hasRealTurnActivity: events.length > 0,
    managedServices: {
      visible: true,
      threadId,
    },
    running: null,
    events,
    hasMore: false,
    oldestSeq: events.length ? events[0]!.seq : null,
    latestSeq: events.length ? events[events.length - 1]!.seq : null,
    rawEventCount: events.length,
  };
}

function buildThreadEvent(
  threadId: string,
  type: EngineEventEnvelope["type"],
  seq: number,
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("展示快照实时尾部追加复用数组，迟到与重发仍逐序号去重", () => {
  setActivePinia(createPinia());
  const store = useChatStore(), threadId = "live-tail";
  store.threadPresentationVersionByThreadId[threadId] = 1;
  store.applyEngineEvent(buildThreadEvent(threadId, "item.agentMessage.delta", 3, { itemId: "reply", delta: "A" }));
  const tail = store.threadReplayEventsByThreadId[threadId];
  store.applyEngineEvent(buildThreadEvent(threadId, "item.agentMessage.delta", 4, { itemId: "reply", delta: "B" }));
  assert.equal(store.threadReplayEventsByThreadId[threadId], tail);
  store.applyEngineEvent(buildThreadEvent(threadId, "item.reasoning.delta", 2, { itemId: "late", delta: "L" }));
  store.applyEngineEvent(buildThreadEvent(threadId, "item.agentMessage.delta", 4, { itemId: "reply", delta: "duplicate" }));
  assert.deepEqual(tail.map(event => event.seq), [3, 4, 2]);
  assert.equal((store.conversations[threadId]?.items.find(item => item.id === "reply") as ConversationMessage)?.text, "AB");
});

test("递增事件去重增量维护高水位，迟到范围和数组替换仍真实检查", () => {
  const source = readFileSync(new URL("../src/store/chat.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("chat.ts", source, ts.ScriptTarget.Latest, true);
  const functions = new Set(["hasReplayEventSeq", "normalizeSeq", "maxReplayEventSeq"]);
  const parts = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.has(node.name?.text ?? "")
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "replayEventHighWaterByList"));
  const has = vm.runInNewContext(ts.transpileModule(`${parts.map(part => part.getText(ast)).join("\n")}\nhasReplayEventSeq`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText) as (events: EngineEventEnvelope[], seq: number) => boolean;
  let reads = 0;
  const events = Array.from({ length: 1000 }, (_, index) => ({ type: "thread.started", get seq() { reads++; return index + 1; } })) as EngineEventEnvelope[];
  assert.equal(has(events, 1001), false);
  reads = 0;
  for (let seq = 1001; seq <= 1100; seq++) {
    assert.equal(has(events, seq), false);
    events.push(buildThreadEvent("live-tail", "thread.started", seq, {}));
  }
  assert.ok(reads < 500, `递增100条不应反复扫描旧1000条：${reads}`);
  events.push(buildReviewDelta("live-tail", 1300, "child"));
  events[events.length - 1]!.replayFromSeq = 1200;
  assert.equal(has(events, 1250), true);
  assert.equal(has(events, 1150), false);
  assert.equal(has(events.slice(0, 10), 1000), false);
  events.splice(10);
  assert.equal(has(events, 1000), false);
});

/** 复检过程使用没有最终快照的增量，确保重复拼接不会被完成正文掩盖。 */
function buildReviewDelta(threadId: string, seq: number, delta: string, type = "item.reasoning.delta"): EngineEventEnvelope {
  return buildThreadEvent(threadId, "item.subagent.childEvent", seq, {
    itemId: "review", taskId: "task", innerEventType: type, innerPayload: { itemId: "reply", delta },
  });
}

for (const type of ["item.reasoning.delta", "item.agentMessage.delta"]) test(`重载压缩复检历史不重复追加，保留实时尾部：${type}`, async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = `thread-review-overlap-${type}`;
  const start = buildThreadEvent(threadId, "item.subagent.started", 1, { itemId: "review", taskId: "task", description: "复检" });
  const a = buildReviewDelta(threadId, 2, "A", type);
  const b = buildReviewDelta(threadId, 3, "B", type);
  const c = buildReviewDelta(threadId, 4, "C", type);
  const d = buildReviewDelta(threadId, 5, "D", type);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    const raw = requests === 1 ? [start, a] : [start, a, b, c];
    if (requests === 2) {
      store.applyEngineEvent(c);
      store.applyEngineEvent(d);
    }
    return jsonResponse({ ...buildLoadThreadResponse(threadId, raw), events: compressConversationEvents(raw) });
  }) as typeof fetch;
  const body = { workspaceId: "client-a:ws-demo" as any, threadId: threadId as any };
  await store.loadThread(ctx, body);
  store.applyEngineEvent(b);
  await store.loadThread(ctx, body);
  store.applyEngineEvent(a);
  store.applyEngineEvent(b);
  const review = store.conversations[threadId]!.items.find(item => item.kind === "subagent")!;
  assert.equal(review.kind, "subagent");
  if (review.kind !== "subagent") assert.fail("复检卡片应保留");
  const child = review.children![0]!;
  assert.equal(child.kind === "reasoning" ? child.content : child.kind === "message" ? child.text : "", "ABCD");
  const cache = store.threadReplayEventsByThreadId[threadId]!.filter(event => event.type === "item.subagent.childEvent");
  assert.deepEqual(cache.map(event => event.seq), [4, 5]);
  assert.equal(cache[0]!.replayFromSeq, 2);
});

test("复检历史补页和重载保留较早消息，子任务增量不跨窗口重复", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-review-history-pages";
  const old = [
    buildThreadEvent(threadId, "item.userMessage.created", 1, { itemId: "user", text: "生成规范" }),
    buildThreadEvent(threadId, "item.subagent.started", 2, { itemId: "review", taskId: "task", description: "复检" }),
    buildReviewDelta(threadId, 3, "A"),
  ];
  const current = [
    buildThreadEvent(threadId, "item.subagent.progress", 4, { itemId: "review", taskId: "task", description: "复检" }),
    buildReviewDelta(threadId, 5, "B"), buildReviewDelta(threadId, 6, "C"),
  ];
  let requests = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const paging = JSON.parse(String(init?.body)).beforeSeq != null;
    const raw = paging ? old : requests === 1 ? current : [...current, buildReviewDelta(threadId, 7, "D")];
    return jsonResponse({ ...buildLoadThreadResponse(threadId, raw), events: compressConversationEvents(raw), hasMore: !paging });
  }) as typeof fetch;
  const ctx = createApiContext();
  const body = { workspaceId: "client-a:ws-demo" as any, threadId: threadId as any };
  await store.loadThread(ctx, body);
  await store.loadThreadPage(ctx, body);
  await store.loadThread(ctx, body);
  const items = store.conversations[threadId]!.items;
  assert.ok(items.some(item => item.kind === "message" && item.role === "user" && item.text === "生成规范"));
  const review = items.find(item => item.kind === "subagent");
  assert.equal(review?.kind === "subagent" && review.children?.[0]?.kind === "reasoning" ? review.children[0].content : "", "ABCD");
});

test("rollbackThread drops stale replay cache before reloading trimmed history", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-rollback-replay";
  let rollbackMode = false;
  let draftSaveRequests = 0;
  let savedDraftPayload!: Record<string, unknown>;
  const restoredFile = {
    id: "file-1",
    name: "note.md",
    displayName: "note.md",
    mime: "text/markdown",
    size: 9,
    text: "file body",
  };

  const staleEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-1" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-1",
      itemId: "item-user-1",
      text: "第一轮",
      images: ["data:image/png;base64,AAA"],
      files: [restoredFile],
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-1" }),
    buildThreadEvent(threadId, "turn.started", 4, { turnId: "turn-2" }),
    buildThreadEvent(threadId, "item.userMessage.created", 5, {
      turnId: "turn-2",
      itemId: "item-user-2",
      text: "第二轮",
      images: [],
      files: [],
    }),
    buildThreadEvent(threadId, "turn.completed", 6, { turnId: "turn-2" }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, rollbackMode ? [] : staleEvents));
    }
    if (url.pathname === "/api/threads/rollback") {
      rollbackMode = true;
      return jsonResponse({
        ok: true,
        droppedTurnCount: 2,
        revertedFileCount: 0,
        skippedFileCount: 0,
        fileRollbackStatus: "not_requested",
        rollbackEventSeqBarrier: 6,
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      return jsonResponse({ ok: true, items: [] });
    }
    if (url.pathname === "/api/threads/draft/save") {
      draftSaveRequests += 1;
      savedDraftPayload = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        ok: true,
        version: 9,
        updatedAt: 90,
        updatedByWebSessionId: "web-demo",
      });
    }
    throw new Error(`unexpected request: ${url.pathname} body=${String(init?.body ?? "")}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 5000,
  });

  const beforeRollbackUserMessages = store.conversations[threadId]?.items.filter((item) => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(beforeRollbackUserMessages.length, 2);

  const rollbackResult = await store.rollbackThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    toTurnId: "turn-1" as any,
    rollbackFiles: false,
  });

  const afterRollbackConversation = store.conversations[threadId];
  assert.ok(afterRollbackConversation);
  const afterRollbackUserMessages = afterRollbackConversation?.items.filter((item) => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(afterRollbackUserMessages.length, 0);
  assert.deepEqual(store.threadReplayEventsByThreadId[threadId] ?? [], []);
  assert.equal(draftSaveRequests, 1);
  assert.deepEqual(savedDraftPayload?.draft, {
    text: "第一轮",
    images: [{ id: "rollback_img_0", name: "图片 1", dataUrl: "data:image/png;base64,AAA", size: 2 }],
    files: [restoredFile],
    pathReferences: [],
  });
  assert.equal(store.threadDraftByThreadId[threadId]?.text, "第一轮");
  assert.equal(store.threadDraftVersionByThreadId[threadId], 9);
  assert.equal(rollbackResult.fileRollbackStatus, "not_requested");
  assert.equal(rollbackResult.rollbackEventSeqBarrier, 6);

  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", 5, {
    turnId: "turn-2",
    itemId: "item-user-stale-late",
    text: "迟到旧消息",
  }));
  assert.deepEqual(store.threadReplayEventsByThreadId[threadId] ?? [], []);
  assert.equal(store.conversations[threadId]?.items.length, 0);

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 7, { turnId: "turn-new" }));
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-new");
});

test("rollbackThread rejects missing or mismatched file rollback status before local replay", async () => {
  const cases: Array<{
    name: string;
    rollbackFiles: boolean;
    responseStatus?: "not_requested" | "completed";
    expected: RegExp;
  }> = [
    { name: "missing status", rollbackFiles: true, expected: /实际 missing/u },
    { name: "files requested but not confirmed", rollbackFiles: true, responseStatus: "not_requested", expected: /期望 completed，实际 not_requested/u },
    { name: "history-only request reported file rollback", rollbackFiles: false, responseStatus: "completed", expected: /期望 not_requested，实际 completed/u },
    { name: "missing event barrier", rollbackFiles: true, responseStatus: "completed", expected: /缺少事件屏障/u },
  ];

  for (const scenario of cases) {
    setActivePinia(createPinia());
    const store = useChatStore();
    const requestedPaths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname !== "/api/threads/rollback") {
        throw new Error(`unexpected request for ${scenario.name}: ${url.pathname}`);
      }
      return jsonResponse({
        ok: true,
        droppedTurnCount: 1,
        revertedFileCount: 0,
        skippedFileCount: 0,
        ...(scenario.responseStatus ? { fileRollbackStatus: scenario.responseStatus } : {}),
      });
    }) as typeof fetch;

    await assert.rejects(
      store.rollbackThread(createApiContext(), {
        workspaceId: "client-a:ws-demo" as any,
        threadId: `thread-${scenario.name}` as any,
        toTurnId: "turn-1" as any,
        rollbackFiles: scenario.rollbackFiles,
      }),
      scenario.expected,
    );
    assert.deepEqual(requestedPaths, ["/api/threads/rollback"]);
  }
});

test("rollbackThread accepts a confirmed file rollback response", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-confirmed-file-rollback";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/rollback") {
      return jsonResponse({
        ok: true,
        droppedTurnCount: 1,
        revertedFileCount: 2,
        skippedFileCount: 0,
        fileRollbackStatus: "completed",
        rollbackEventSeqBarrier: 9,
      });
    }
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const result = await store.rollbackThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    toTurnId: "turn-1" as any,
    rollbackFiles: true,
  });

  assert.deepEqual(result, {
    droppedTurnCount: 1,
    revertedFileCount: 2,
    skippedFileCount: 0,
    fileRollbackStatus: "completed",
    rollbackEventSeqBarrier: 9,
  });
});

test("rollbackThread reports that rollback completed when canonical reload fails", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-rollback-load-failed";
  const requestedPaths: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname === "/api/threads/rollback") {
      return jsonResponse({
        ok: true,
        droppedTurnCount: 1,
        revertedFileCount: 0,
        skippedFileCount: 0,
        fileRollbackStatus: "not_requested",
        rollbackEventSeqBarrier: 8,
      });
    }
    if (url.pathname === "/api/threads/load") {
      return jsonResponse({ ok: false, message: "injected rollback load failure" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await assert.rejects(
    store.rollbackThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      toTurnId: "turn-1" as any,
      rollbackFiles: false,
    }),
    /回滚已完成，但会话历史刷新失败.*injected rollback load failure/u,
  );

  assert.deepEqual(requestedPaths, ["/api/threads/rollback", "/api/threads/load"]);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 8);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /回滚已完成.*injected rollback load failure/u);
});

test("rollbackThread reports that rollback completed when file changes refresh fails", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-rollback-file-refresh-failed";
  const requestedPaths: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname === "/api/threads/rollback") {
      return jsonResponse({
        ok: true,
        droppedTurnCount: 1,
        revertedFileCount: 1,
        skippedFileCount: 0,
        fileRollbackStatus: "completed",
        rollbackEventSeqBarrier: 9,
      });
    }
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      return jsonResponse({ ok: false, message: "injected file changes refresh failure" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await assert.rejects(
    store.rollbackThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      toTurnId: "turn-1" as any,
      rollbackFiles: true,
    }),
    /回滚已完成，但文件变更列表刷新失败.*injected file changes refresh failure/u,
  );

  assert.deepEqual(requestedPaths, [
    "/api/threads/rollback",
    "/api/threads/load",
    "/api/threads/file-changes/list",
  ]);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 9);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /回滚已完成.*injected file changes refresh failure/u);
});

test("sendMessage reloads reconciled history and does not duplicate the accepted user message", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-send-reconciled";
  let loadCount = 0;
  let fileChangesCount = 0;
  const staleEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-stale" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-stale",
      itemId: "item-user-stale",
      text: "旧消息",
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-stale" }),
  ];
  const reconciledEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 10, { turnId: "turn-new" }),
    buildThreadEvent(threadId, "item.userMessage.created", 11, {
      turnId: "turn-new",
      itemId: "item-user-new",
      text: "新消息",
      images: [],
      files: [],
      pathReferences: [],
    }),
  ];
  for (const event of reconciledEvents) event.ts = Date.now();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, loadCount === 1 ? staleEvents : reconciledEvents));
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-new",
        dispatchMode: "chat_turn",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 3,
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    text: "新消息",
    images: [],
  } as any);

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is ConversationMessage => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.deepEqual(userMessages.map((item) => item.text), ["新消息"]);
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.fileChangesByThreadId[threadId]?.stale, false);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 3);
});

test("compactThread reloads reconciled history and refreshes file changes", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-compact-reconciled";
  let loadCount = 0;
  let fileChangesCount = 0;
  const staleEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-stale" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-stale",
      itemId: "item-user-stale",
      text: "待裁剪旧消息",
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-stale" }),
  ];
  const reconciledEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 10, { turnId: "turn-compact" }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, loadCount === 1 ? staleEvents : reconciledEvents));
    }
    if (url.pathname === "/api/threads/compact") {
      return jsonResponse({ ok: true, turnId: "turn-compact", rollbackReconciled: true, rollbackEventSeqBarrier: 3 });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await store.compactThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  } as any);

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is ConversationMessage => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.equal(userMessages.length, 0);
  assert.equal(store.conversations[threadId]?.runningTurnId, "turn-compact");
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 3);
});

test("server rollback barrier reloads an already-open shared projection and rejects late old events", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-shared-rollback-invalidation";
  let loadCount = 0;
  let fileChangesCount = 0;
  const staleEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-stale" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-stale",
      itemId: "item-stale",
      text: "待回滚消息",
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-stale" }),
  ];
  const reconciledEvents: EngineEventEnvelope[] = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-retained" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-retained",
      itemId: "item-retained",
      text: "保留消息",
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-retained" }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, loadCount === 1 ? staleEvents : reconciledEvents));
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "shared:workspace-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await store.reconcileThreadRollbackFromServer(ctx, {
    workspaceId: "shared:workspace-demo" as any,
    threadId: threadId as any,
    rollbackEventSeqBarrier: 3,
  });
  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", 2, {
    turnId: "turn-late-old",
    itemId: "item-late-old",
    text: "迟到旧消息",
  }));

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is ConversationMessage => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.deepEqual(userMessages.map((item) => item.text), ["保留消息"]);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 3);
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
});

test("sendMessage reports partial success when reconciled history reloads without an event barrier", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-send-reconcile-missing-barrier";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-send-missing-barrier",
        dispatchMode: "chat_turn",
        rollbackReconciled: true,
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.sendMessage(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      text: "accepted without barrier",
      images: [],
    } as any),
    /消息已发送，但自动回滚响应缺少有效事件屏障/u,
  );

  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-send-missing-barrier");
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], undefined);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /缺少有效事件屏障/u);
});

test("compactThread reports partial success for an invalid barrier after reloading history", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-compact-reconcile-invalid-barrier";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/compact") {
      return jsonResponse({
        ok: true,
        turnId: "turn-compact-invalid-barrier",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 0,
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.compactThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
    } as any),
    /会话压缩已启动，但自动回滚响应缺少有效事件屏障.*事件屏障非法/u,
  );

  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-compact-invalid-barrier");
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], undefined);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /事件屏障非法/u);
});

test("sendMessage fails explicitly when reconciled history cannot be reloaded", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-send-reconcile-reload-failed";
  let loadCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return loadCount === 1
        ? jsonResponse(buildLoadThreadResponse(threadId, []))
        : jsonResponse({ ok: false, message: "injected reload failure" });
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-send-failed-reload",
        dispatchMode: "chat_turn",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 3,
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.sendMessage(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      text: "已发出的消息",
      images: [],
    } as any),
    /消息已发送，但自动回滚后的会话历史刷新失败.*injected reload failure/u,
  );
  assert.equal(loadCount, 2);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-send-failed-reload");
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /injected reload failure/u);
});

test("compactThread fails explicitly when reconciled history cannot be reloaded", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-compact-reconcile-reload-failed";
  let loadCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return loadCount === 1
        ? jsonResponse(buildLoadThreadResponse(threadId, []))
        : jsonResponse({ ok: false, message: "injected compact reload failure" });
    }
    if (url.pathname === "/api/threads/compact") {
      return jsonResponse({
        ok: true,
        turnId: "turn-compact-failed-reload",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 3,
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.compactThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
    } as any),
    /会话压缩已启动，但自动回滚后的历史刷新失败.*injected compact reload failure/u,
  );
  assert.equal(loadCount, 2);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-compact-failed-reload");
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /injected compact reload failure/u);
});

test("sendMessage consumes rollback metadata from ApiErr.details before reporting an active-turn conflict", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-send-error-reconciled";
  let loadCount = 0;
  let fileChangesCount = 0;
  let summaryCount = 0;
  const staleEvents = [
    buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-stale" }),
    buildThreadEvent(threadId, "item.userMessage.created", 2, {
      turnId: "turn-stale",
      itemId: "item-stale",
      text: "旧消息",
    }),
    buildThreadEvent(threadId, "turn.completed", 3, { turnId: "turn-stale" }),
  ];
  const retainedEvents = [
    buildThreadEvent(threadId, "turn.started", 4, { turnId: "turn-running" }),
    buildThreadEvent(threadId, "item.userMessage.created", 5, {
      turnId: "turn-running",
      itemId: "item-retained",
      text: "保留消息",
    }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, loadCount === 1 ? staleEvents : retainedEvents));
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: false,
        code: "CONFLICT",
        message: "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。",
        details: {
          rollbackReconciled: true,
          rollbackEventSeqBarrier: 3,
        },
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryCount += 1;
      return jsonResponse({
        ok: true,
        thread: {
          id: threadId,
          title: "冲突会话",
          engine: "codex",
          threadType: "chat",
          threadSubtype: null,
          archived: false,
          createdAt: 1,
          updatedAt: 2,
        },
        running: {
          runningTurnId: "turn-running",
          runningTurnStartedAt: 4,
        },
        visibility: { hidden: false, reason: null },
        managedServices: { visible: true, threadId },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.sendMessage(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      text: "不应乐观写入",
      images: [],
    } as any),
    /主请求失败，但自动回滚已完成（消息发送）.*当前线程仍有未完成/u,
  );

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is ConversationMessage => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.deepEqual(userMessages.map((item) => item.text), ["保留消息"]);
  assert.equal(store.threadPendingDispatchByThreadId[threadId], undefined);
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 3);
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(summaryCount, 1);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /主请求失败，但自动回滚已完成/u);
});

test("compactThread consumes rollback metadata from ApiErr.details before throwing", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-compact-error-reconciled";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/compact") {
      return jsonResponse({
        ok: false,
        code: "CLIENT_OFFLINE",
        message: "压缩启动事件未持久化",
        details: {
          rollbackReconciled: true,
          rollbackEventSeqBarrier: 8,
        },
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.compactThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
    } as any),
    /主请求失败，但自动回滚已完成（会话压缩）.*压缩启动事件未持久化/u,
  );

  assert.equal(store.threadPendingDispatchByThreadId[threadId], undefined);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 8);
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
});

test("sendMessage reports projection sync warning as a non-repeatable partial success", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-send-projection-warning";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, loadCount === 1 ? [] : [
        buildThreadEvent(threadId, "item.userMessage.created", 10, {
          turnId: "turn-warning",
          itemId: "item-warning",
          text: "已发送消息",
        }),
      ]));
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-warning",
        dispatchMode: "chat_turn",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 5,
        rollbackProjectionSyncWarning: "injected projection warning",
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.sendMessage(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      text: "已发送消息",
      images: [],
    } as any),
    /消息已发送.*共享投影同步失败.*injected projection warning.*主操作已经执行，请勿重复操作/u,
  );

  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-warning");
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /主操作已经执行，请勿重复操作/u);
});

test("compactThread reports projection sync warning after canonical reload", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-compact-projection-warning";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/compact") {
      return jsonResponse({
        ok: true,
        turnId: "turn-compact-warning",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 6,
        rollbackProjectionSyncWarning: "compact projection warning",
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });
  await assert.rejects(
    store.compactThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
    } as any),
    /会话压缩已启动.*compact projection warning.*请勿重复操作/u,
  );

  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-compact-warning");
});

test("rollbackThread reports projection sync warning after local reload and draft handling", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-rollback-projection-warning";
  let loadCount = 0;
  let fileChangesCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/rollback") {
      return jsonResponse({
        ok: true,
        droppedTurnCount: 1,
        revertedFileCount: 0,
        skippedFileCount: 0,
        fileRollbackStatus: "not_requested",
        rollbackEventSeqBarrier: 9,
        rollbackProjectionSyncWarning: "rollback projection warning",
      });
    }
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      return jsonResponse(buildLoadThreadResponse(threadId, []));
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await assert.rejects(
    store.rollbackThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      toTurnId: "turn-1" as any,
      rollbackFiles: false,
    }),
    /回滚已完成.*rollback projection warning.*主操作已经执行，请勿重复操作/u,
  );

  assert.equal(loadCount, 1);
  assert.equal(fileChangesCount, 1);
  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 9);
  assert.match(JSON.stringify(store.conversations[threadId]?.items ?? []), /回滚已完成.*请勿重复操作/u);
});
