import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import type { ApiRequestContext } from "../src/api/request.ts";
import { useOrchestrationStore } from "../src/store/orchestration.ts";

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const ctx: ApiRequestContext = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "synthetic", webSessionId: "test",
  ensureSession: async () => "synthetic", clearSession() {} };

/** 构造列表摘要，完整旧快照只在兼容场景中额外注入。 */
function proposal(id: string, workspaceId = "ws") {
  return { id, workspaceId, intakeId: "intake", status: "draft", createdAt: 1, updatedAt: 1,
    draftWorkflow: { id: "workflow", name: "测试流程" } };
}

/** 返回模拟 HTTP JSON，不执行 Server 或 Client 副作用。 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("proposal refresh commits all summary pages once and preserves execution target", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  const urls: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(store.proposals.length, 0);
    return json({ ok: true, proposals: [proposal(urls.length === 1 ? "first" : "second")], hasMore: urls.length === 1,
      nextCursor: urls.length === 1 ? "[1,\"first\"]" : null });
  }) as typeof fetch;
  await store.refreshProposals(ctx, "ws" as any, { onlyRelatedToMe: true });
  assert.deepEqual(store.proposals.map(p => p.id), ["first", "second"]);
  assert.equal(urls[0]!.searchParams.get("summaryOnly"), "true");
  assert.equal(urls[0]!.searchParams.get("limit"), "200");
  assert.equal(urls[1]!.searchParams.get("cursor"), "[1,\"first\"]");
  store.selectedProposalId = "first" as any;
  assert.equal(store.selectedProposal?.draftWorkflow.id, "workflow");
});

test("proposal refresh fails explicitly on a repeated cursor and preserves the previous list", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  store.proposals = [proposal("previous")] as any;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return json({ ok: true, proposals: [proposal("new")], hasMore: true, nextCursor: "same" }); }) as typeof fetch;
  await assert.rejects(store.refreshProposals(ctx, "ws" as any), /游标/u);
  assert.equal(calls, 2);
  assert.equal(store.proposals[0]?.id, "previous");
  assert.equal(store.proposalsLoading, false);
});

test("proposal refresh rejects a later page failure without committing a partial list", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? json({ ok: true, proposals: [proposal("new")], hasMore: true, nextCursor: "next" })
    : json({ ok: false, code: "CLIENT_OFFLINE", message: "Client 已离线" }, 503)) as typeof fetch;
  await assert.rejects(store.refreshProposals(ctx, "ws" as any));
  assert.deepEqual(store.proposals, []);
});

test("proposal refresh discards a late page after workspace switch", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  let release!: (response: Response) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; markStarted(); })) as typeof fetch;
  const pending = store.refreshProposals(ctx, "ws" as any);
  await started;
  store.resetForWorkspace("other" as any);
  release(json({ ok: true, proposals: [proposal("old")], hasMore: true, nextCursor: "next" }));
  await pending;
  assert.deepEqual(store.proposals, []);
  assert.equal(store.proposalsLoading, false);
});

test("legacy Client full proposal lists are accepted and stored as summaries", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  globalThis.fetch = (async () => json({ ok: true, proposals: [{ ...proposal("legacy"), intakeSnapshot: { goal: "large" },
    draftWorkflow: { id: "role:legacy", name: "单角色", nodes: [{ systemPrompt: "large" }] } }] })) as typeof fetch;
  await store.refreshProposals(ctx, "ws" as any);
  assert.equal(store.proposals.length, 1);
  assert.equal("intakeSnapshot" in store.proposals[0]!, false);
  assert.equal("nodes" in store.proposals[0]!.draftWorkflow, false);
});

test("proposal summaries preserve shared readonly context", async () => {
  setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
  globalThis.fetch = (async () => json({ ok: true, proposals: [{ ...proposal("readonly"), readOnly: true,
    sharedContext: { resourceId: "intake", readOnly: true } }], hasMore: false, nextCursor: null })) as typeof fetch;
  await store.refreshProposals(ctx, "ws" as any);
  assert.equal(store.proposals[0]?.readOnly, true);
  assert.equal(store.proposals[0]?.sharedContext?.resourceId, "intake");
});

test("proposal refresh rejects malformed pagination metadata", async () => {
  for (const metadata of [{ hasMore: "false" }, { hasMore: true }, { hasMore: true, nextCursor: 42 }]) {
    setActivePinia(createPinia()); const store = useOrchestrationStore(); store.resetForWorkspace("ws" as any);
    globalThis.fetch = (async () => json({ ok: true, proposals: [proposal("new")], ...metadata })) as typeof fetch;
    await assert.rejects(store.refreshProposals(ctx, "ws" as any), /分页/u);
    assert.deepEqual(store.proposals, []);
    assert.equal(store.proposalsLoading, false);
  }
});
