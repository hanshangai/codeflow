import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationEventInput, WorkspaceId } from "../../packages/shared/src/index.ts";
import {
  applyCodexAppServerMessage,
  isCodexSyntheticTransportFault,
} from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerMessageMapper.ts";
import type { CodexAppServerMessage } from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerWorkspace.ts";

function createBaseMapperOptions(
  msg: CodexAppServerMessage,
  events: ConversationEventInput[],
  activeTurn: {
    clientTurnId: string;
    codexTurnId: string | null;
  } | null = null,
) {
  return {
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "ws-test" as WorkspaceId,
    threadId: "thread-test",
    msg,
    emit: (event: ConversationEventInput) => events.push(event),
    onAssistantDelta() {},
    ensureAssistantMessage() { return null; },
    appendAssistantDelta() { return null; },
    applyAssistantSnapshot() { return null; },
    completeAssistantMessage() { return null; },
    getActiveTurn() {
      if (!activeTurn) return null;
      return {
        ...activeTurn,
        resolve() {},
        reject() {},
      } as any;
    },
  };
}

test("Codex 文件和命令失败必须保留失败状态及原始证据", () => {
  for (const item of [
    { type: "fileChange", status: "failed" },
    { type: "fileChange", status: "declined" },
    { type: "commandExecution", status: "failed", exitCode: 1 },
    { type: "commandExecution", status: "completed", exitCode: 2 },
    { type: "commandExecution", status: "interrupted", exitCode: null },
    { type: "dynamicToolCall", status: "completed", success: false },
  ]) {
    const events: ConversationEventInput[] = [];
    const rawItem = { id: "failed-tool", ...item, changes: [{ path: "example.ts", kind: { type: "add" }, diff: "+example" }] };
    applyCodexAppServerMessage(createBaseMapperOptions({ method: "item/completed", params: { item: rawItem } }, events));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "item.tool.completed");
    const payload = events[0]!.payload as { status: string; output: unknown };
    assert.equal(payload.status, "failed", JSON.stringify(item));
    if (item.type === "fileChange") assert.deepEqual(payload.output, rawItem);
  }
});

test("Codex 成功文件变更与零退出码命令仍记录完成", () => {
  for (const item of [{ type: "fileChange", status: "completed" }, { type: "commandExecution", status: "completed", exitCode: 0 }]) {
    const events: ConversationEventInput[] = [];
    applyCodexAppServerMessage(createBaseMapperOptions({ method: "item/completed", params: { item: { id: "success-tool", ...item } } }, events));
    assert.equal((events[0]!.payload as { status: string }).status, "completed");
  }
});

test("Codex thread handler fault 使用统一 synthetic transport fault 路径", () => {
  assert.equal(isCodexSyntheticTransportFault("error", {
    error: { code: "codex_app_server_thread_handler_error" },
  }), true);
});

test("Codex empty aggregate diff still emits provider evidence", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "turn/diff/updated",
    params: { turnId: "engine-turn-empty", diff: "" },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "item.diff.created");
  assert.deepEqual(events[0]?.payload, {
    itemId: "diff_engine-turn-empty",
    title: "Diff",
    diff: "",
    engineTurnId: "engine-turn-empty",
  });
});

test("Codex aggregate diff binds matching provider and client turn ids", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "turn/diff/updated",
    params: { turnId: "engine-turn-match", diff: "diff --git a/a.txt b/a.txt\n" },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events, {
    clientTurnId: "client-turn-match",
    codexTurnId: "engine-turn-match",
  }));

  assert.deepEqual(events[0]?.payload, {
    itemId: "diff_client-turn-match",
    title: "Diff",
    diff: "diff --git a/a.txt b/a.txt\n",
    turnId: "client-turn-match",
    engineTurnId: "engine-turn-match",
  });
});

test("Codex aggregate diff mismatch does not bind the active client turn", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "turn/diff/updated",
    params: { turnId: "engine-turn-other", diff: "diff --git a/b.txt b/b.txt\n" },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events, {
    clientTurnId: "client-turn-active",
    codexTurnId: "engine-turn-active",
  }));

  assert.deepEqual(events[0]?.payload, {
    itemId: "diff_engine-turn-other",
    title: "Diff",
    diff: "diff --git a/b.txt b/b.txt\n",
    engineTurnId: "engine-turn-other",
  });
});

test("Codex aggregate diff does not bind while the active provider turn is unknown", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "turn/diff/updated",
    params: { turnId: "engine-turn-unconfirmed", diff: "" },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events, {
    clientTurnId: "client-turn-starting",
    codexTurnId: null,
  }));

  assert.deepEqual(events[0]?.payload, {
    itemId: "diff_engine-turn-unconfirmed",
    title: "Diff",
    diff: "",
    engineTurnId: "engine-turn-unconfirmed",
  });
});

test("Codex id-less terminal cannot settle an active turn with a provider binding", () => {
  const events: ConversationEventInput[] = [];
  let resolvedCount = 0;
  let rejectedCount = 0;
  const active = {
    clientTurnId: "client-turn-active" as any,
    codexTurnId: "engine-turn-active",
    resolve() { resolvedCount += 1; },
    reject() { rejectedCount += 1; },
  };
  const apply = (msg: CodexAppServerMessage) => {
    const opts = createBaseMapperOptions(msg, events, null);
    applyCodexAppServerMessage({
      ...opts,
      getActiveTurn: () => active,
    });
  };

  apply({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  apply({
    method: "turn/error",
    params: { error: { message: "late id-less error" } },
  });
  assert.equal(resolvedCount, 0);
  assert.equal(rejectedCount, 0);

  apply({
    method: "turn/completed",
    params: { turn: { id: "engine-turn-active", status: "completed" } },
  });
  assert.equal(resolvedCount, 1);
  assert.equal(rejectedCount, 0);
});

test("Codex nested turn id error settles only the matching active turn", () => {
  const events: ConversationEventInput[] = [];
  const state: { rejected: Error | null } = { rejected: null };
  const msg = {
    method: "turn/error",
    params: {
      turn: { id: "engine-turn-active" },
      error: { message: "nested provider failure" },
    },
  } satisfies CodexAppServerMessage;
  const opts = createBaseMapperOptions(msg, events, null);

  applyCodexAppServerMessage({
    ...opts,
    getActiveTurn: () => ({
      clientTurnId: "client-turn-active" as any,
      codexTurnId: "engine-turn-active",
      resolve() {},
      reject(error) { state.rejected = error; },
    }),
  });

  assert.match(String(state.rejected?.message ?? ""), /nested provider failure/);
});

test("Codex id-less terminal cannot settle an active turn before provider binding", () => {
  const events: ConversationEventInput[] = [];
  let settled = false;
  const msg = {
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  } satisfies CodexAppServerMessage;
  const opts = createBaseMapperOptions(msg, events, null);

  applyCodexAppServerMessage({
    ...opts,
    getActiveTurn: () => ({
      clientTurnId: "client-turn-compact" as any,
      codexTurnId: null,
      resolve() { settled = true; },
      reject() { settled = true; },
    }),
  });

  assert.equal(settled, false);
});

test("Codex token usage emits current last and native cumulative total", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: {
          totalTokens: 10_367_755,
          inputTokens: 10_330_931,
          cachedInputTokens: 9_248_512,
          outputTokens: 36_824,
          reasoningOutputTokens: 18_032,
        },
        last: {
          totalTokens: 178_043,
          inputTokens: 170_288,
          cachedInputTokens: 57_728,
          outputTokens: 7_755,
          reasoningOutputTokens: 4_988,
        },
        modelContextWindow: 258_400,
      },
    },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events));

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tokenUsage.updated");
  assert.equal(events[0]?.payload.source, "current");
  assert.deepEqual(events[0]?.payload.tokenUsage, {
    inputTokens: 170_288,
    outputTokens: 7_755,
    cachedInputTokens: 57_728,
    cacheCreationInputTokens: null,
    totalTokens: 178_043,
    reasoningOutputTokens: 4_988,
    modelContextWindow: 258_400,
  });
  assert.equal(events[1]?.type, "tokenUsage.updated");
  assert.equal(events[1]?.payload.source, "cumulative");
  assert.deepEqual(events[1]?.payload.tokenUsage, {
    inputTokens: 10_330_931,
    outputTokens: 36_824,
    cachedInputTokens: 9_248_512,
    cacheCreationInputTokens: null,
    totalTokens: 10_367_755,
    reasoningOutputTokens: 18_032,
    modelContextWindow: 258_400,
  });
});

test("Codex token_count maps last usage to current and total usage to cumulative", () => {
  const events: ConversationEventInput[] = [];
  const msg = {
    method: "token_count",
    params: {
      info: {
        total_token_usage: {
          total_tokens: 1_500,
          input_tokens: 1_200,
          cached_input_tokens: 200,
          output_tokens: 300,
          reasoning_output_tokens: 100,
        },
        last_token_usage: {
          total_tokens: 900,
          input_tokens: 750,
          cached_input_tokens: 50,
          output_tokens: 150,
          reasoning_output_tokens: 25,
        },
        model_context_window: 200_000,
      },
    },
  } satisfies CodexAppServerMessage;

  applyCodexAppServerMessage(createBaseMapperOptions(msg, events));

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tokenUsage.updated");
  assert.equal(events[0]?.payload.source, "current");
  assert.deepEqual(events[0]?.payload.tokenUsage, {
    inputTokens: 750,
    outputTokens: 150,
    cachedInputTokens: 50,
    cacheCreationInputTokens: null,
    totalTokens: 900,
    reasoningOutputTokens: 25,
    modelContextWindow: 200_000,
  });
  assert.equal(events[1]?.type, "tokenUsage.updated");
  assert.equal(events[1]?.payload.source, "cumulative");
  assert.deepEqual(events[1]?.payload.tokenUsage, {
    inputTokens: 1_200,
    outputTokens: 300,
    cachedInputTokens: 200,
    cacheCreationInputTokens: null,
    totalTokens: 1_500,
    reasoningOutputTokens: 100,
    modelContextWindow: 200_000,
  });
});
