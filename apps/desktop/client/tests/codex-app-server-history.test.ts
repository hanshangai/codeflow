import assert from "node:assert/strict";
import test from "node:test";

import {
  readCodexThreadHistory,
  readCodexTurnHistoryPage,
} from "../src/engines/codex-app-server/codexAppServerHistory.ts";

/** Builds a provider turn whose tool outputs are not loaded. */
function turn(id: string, status = "completed", items: unknown[] = []) {
  return { id, status, items, itemsView: "notLoaded" };
}

test("state reconciliation pages all turn IDs without requesting history bodies", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false);
      return { thread: { id: "thread", status: { type: "idle" }, turns: [] } };
    }
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "notLoaded");
    assert.equal(params.sortDirection, "asc");
    return params.cursor
      ? { data: [turn("new")], nextCursor: null }
      : { data: [turn("old")], nextCursor: "second" };
  };

  const result = await readCodexThreadHistory(request, { threadId: "thread", includeTurns: true }, { itemTypes: [] }) as any;

  assert.deepEqual(result.thread.turns.map((entry: any) => entry.id), ["old", "new"]);
  assert.deepEqual(result.thread.status, { type: "idle" });
  assert.deepEqual(result.thread.turns.map((entry: any) => entry.items), [[], []]);
  assert.equal(calls.length, 3);
});

test("assistant compensation reads only target turn item pages and drops tool output", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "paginated", turns: [] } };
    if (method === "thread/turns/list") {
      return { data: [turn("old"), turn("target")], nextCursor: null };
    }
    assert.equal(method, "thread/items/list");
    assert.equal(params.turnId, "target");
    assert.equal(params.limit, 8);
    return params.cursor
      ? { data: [{ turnId: "target", item: { type: "agentMessage", id: "final", text: "正文" } }], nextCursor: null }
      : { data: [{ turnId: "target", item: { type: "commandExecution", id: "tool", aggregatedOutput: "large tool output" } }], nextCursor: "second-items" };
  };

  const result = await readCodexThreadHistory(request, { threadId: "thread", includeTurns: true }, {
    turnIds: ["target"],
    itemTypes: ["agentMessage"],
  }) as any;

  assert.deepEqual(result.thread.turns[0].items, []);
  assert.deepEqual(result.thread.turns[1].items, [{ type: "agentMessage", id: "final", text: "正文" }]);
  assert.equal(calls.filter((call) => call.method === "thread/items/list").length, 2);
});

test("ownership scans reuse summary user messages without loading a large turn", async () => {
  const user = { type: "userMessage", id: "user", clientId: "local-input", content: [] };
  const result = await readCodexTurnHistoryPage(async (method, params) => {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "summary");
    return { data: [turn("long-running-turn", "inProgress", [user])], nextCursor: null };
  }, { threadId: "thread", itemsView: "full", limit: 64 }, { itemTypes: ["userMessage"] }) as any;

  assert.deepEqual(result.data[0].items, [user]);
  assert.equal(result.data[0].status, "inProgress");
});

test("compact recovery excludes baseline turns from item hydration", async () => {
  const hydrated: unknown[] = [];
  const result = await readCodexTurnHistoryPage(async (method, params) => {
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "paginated" } };
    if (method === "thread/turns/list") return { data: [turn("baseline"), turn("compact")], nextCursor: null };
    hydrated.push(params.turnId);
    return { data: [{ turnId: "compact", item: { type: "contextCompaction", id: "compacted" } }], nextCursor: null };
  }, { threadId: "thread", itemsView: "full" }, {
    excludeTurnIds: ["baseline"], itemTypes: ["contextCompaction"],
  }) as any;

  assert.deepEqual(hydrated, ["compact"]);
  assert.equal(result.data[1].items[0].type, "contextCompaction");
});

test("repeated cursors fail rather than returning incomplete state", async () => {
  let pages = 0;
  await assert.rejects(readCodexThreadHistory(async (method) => {
    if (method === "thread/read") return { thread: { id: "thread" } };
    return { data: [turn(String(++pages))], nextCursor: "repeated" };
  }, { threadId: "thread" }, { itemTypes: [] }), /cursor is invalid/);
  assert.equal(pages, 2);
});

test("wrong-turn item pages fail explicitly", async () => {
  await assert.rejects(readCodexTurnHistoryPage(async (method) => {
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "paginated" } };
    if (method === "thread/turns/list") return { data: [turn("target")], nextCursor: null };
    return { data: [{ turnId: "foreign", item: { type: "agentMessage" } }], nextCursor: null };
  }, { threadId: "thread" }, { itemTypes: ["agentMessage"] }), /item page entry is invalid/);
});

test("provider failures propagate without a full-history fallback", async () => {
  const failure = new Error("provider item read failed");
  const calls: string[] = [];
  await assert.rejects(readCodexTurnHistoryPage(async (method) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "paginated" } };
    if (method === "thread/turns/list") return { data: [turn("target")], nextCursor: null };
    throw failure;
  }, { threadId: "thread" }, { itemTypes: ["agentMessage"] }), (error) => error === failure);
  assert.deepEqual(calls, ["thread/read", "thread/turns/list", "thread/items/list"]);
});

test("legacy assistant reads use single-turn pages without unsupported item RPCs", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const assistant = { type: "agentMessage", id: "final", text: "legacy final" };
  const result = await readCodexTurnHistoryPage(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "legacy" } };
    assert.equal(method, "thread/turns/list");
    if (params.itemsView === "full") {
      assert.equal(params.limit, 1);
      assert.equal(params.cursor, "older");
      return { data: [turn("target", "completed", [assistant])], nextCursor: null };
    }
    if (params.limit !== 1) return { data: [turn("target"), turn("newer")], nextCursor: null };
    return params.cursor
      ? { data: [turn("target")], nextCursor: null }
      : { data: [turn("newer")], nextCursor: "older" };
  }, { threadId: "thread", limit: 64, itemsView: "full" }, { turnIds: ["target"], itemTypes: ["agentMessage"] }) as any;

  assert.deepEqual(result.data[0].items, [assistant]);
  assert.deepEqual(result.data[1].items, []);
  assert.equal(calls.some((call) => call.method === "thread/items/list"), false);
});

test("unknown history storage fails instead of guessing a protocol", async () => {
  await assert.rejects(readCodexTurnHistoryPage(async (method) => {
    if (method === "thread/read") return { thread: { id: "thread", historyMode: "unknown" } };
    return { data: [turn("target")], nextCursor: null };
  }, { threadId: "thread" }, { itemTypes: ["agentMessage"] }), /mode is missing or unsupported/);
});
