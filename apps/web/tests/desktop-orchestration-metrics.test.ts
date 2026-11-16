/// <reference path="../../desktop/client/src/types/word-extractor.d.ts" />
import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult, DesktopApiRequest, OrchestrationMetricCollectResponse, OrchestrationMetricTraceFact } from "@codeflowai/shared";

import { createDesktopMetricsReader, createDesktopMetricsState, readDesktopMetricToken, summarizeDesktopMetrics } from "../src/features/orchestration-metrics/desktopOrchestrationMetrics.ts";
import { requestDesktopApi } from "../src/services/desktop.ts";
import { handleOrchMetricsCollect } from "../../desktop/client/src/app/handlers/orchMetricsHandlers.ts";
import type { ApiHandlerContext } from "../../desktop/client/src/app/handleApiRequest.ts";
import { migrateClientDb } from "../../desktop/client/src/db/migrateClientDb.ts";
import { openSqliteDb } from "../../desktop/client/src/db/sqliteDb.ts";
import { tryExtractTokenUsage } from "../../desktop/client/src/engines/claude/claudeJson.ts";

/** 用完整采集响应固定空页边界，避免测试把缺失字段当成功。 */
function page(workspaceId = "client:local", overrides: Partial<OrchestrationMetricCollectResponse> = {}): OrchestrationMetricCollectResponse {
  return {
    metricSchemaVersion: 12, metricDefinitionVersion: "test", collectedAt: 100, sourceWorkspaceId: workspaceId,
    instances: [], nodes: [], qualityEvents: [], stateSegments: [], traceFacts: [], hasMore: false, nextCursor: null,
    coverage: { sourceCount: 1, onlineSourceCount: 1, offlineSourceCount: 0, instanceCount: 0, missingStartedAtCount: 0,
      missingCompletedAtCount: 0, missingValidationCount: 0, missingRawTraceCount: 0, invalidPayloadCount: 0, truncatedSourceCount: 0 },
    ...overrides,
  };
}

/** 建立不含凭据与计价估算的 Trace 事实，Token 为人工核对值。 */
function trace(id: string, overrides: Partial<OrchestrationMetricTraceFact> = {}): OrchestrationMetricTraceFact {
  return {
    sourceInstanceId: "run-1", nodeId: "node-1", nodeExecutionId: "exec-1", attemptNo: 1, promptSnapshotId: id,
    workflowSnapshotHash: "workflow", roleId: "role", roleSnapshotHash: "role-hash", promptDefinitionHash: "definition",
    promptHash: "prompt", threadId: "thread", turnId: id, engine: "codex", startedAt: 100, completedAt: 500,
    durationMs: 400, modelCallCount: 1, inputTokens: 10, outputTokens: 5, cachedInputTokens: 3,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 2, totalTokens: 15, toolCallCount: 0,
    tokenUsageCoverage: { inputTokens: true, outputTokens: true, totalTokens: true },
    toolSuccessCount: 0, toolFailureCount: 0, costStatus: "unavailable", evidenceStatus: "complete",
    evidenceReasons: [], sourceFingerprint: id, ...overrides,
  };
}

/** 将原始用量写入真实 SQLite，再走本机或云端原采集入口。 */
function collectTokenUsages(usages: Array<Record<string, unknown>>, localWorkspaceOnly = true): OrchestrationMetricCollectResponse {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db);
    db.prepare("INSERT INTO workspaces(id,title,path,created_at,updated_at) VALUES (?,?,?,?,?)").run("client:local", "本机", "/local", 1, 1);
    db.prepare("INSERT INTO threads(id,workspace_id,title,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("thread", "client:local", "测试", "claude", 1, 1);
    db.prepare(`INSERT INTO orch_instances(id,workspace_id,workflow_id,workflow_snapshot_json,intake_snapshot_json,status,node_states_json,created_at,updated_at)
      VALUES ('run','client:local','flow','{"name":"流程","nodes":[],"edges":[]}','{}','completed','{}',1,500)`).run();
    db.prepare(`INSERT INTO thread_turns(thread_id,turn_id,workspace_id,engine,status,started_at,ended_at,start_event_seq,end_event_seq)
      VALUES ('thread','turn','client:local','claude','completed',100,500,1,?)`).run(usages.length);
    db.prepare(`INSERT INTO orch_prompt_snapshots(id,instance_id,node_id,thread_id,turn_id,engine,prompt_envelope_json,system_message,user_message,rendered_input_preview,runtime_policy_json,artifact_input_json,created_at)
      VALUES ('prompt','run','node','thread','turn','claude','{}','','','','{}','{}',100)`).run();
    const insert = db.prepare(`INSERT INTO conversation_events(seq,thread_id,workspace_id,engine,type,event_json,ts)
      VALUES (?,'thread','client:local','claude','tokenUsage.updated',?,200)`);
    usages.forEach((tokenUsage, index) => insert.run(index + 1, JSON.stringify({ payload: { tokenUsage, source: "current", usagePhase: "final" } })));
    let result: ApiResult<OrchestrationMetricCollectResponse> | undefined;
    handleOrchMetricsCollect({ db: { db }, workspaces: new Map([["client:local", {}]]), localWorkspaceOnly,
      send(response: Parameters<ApiHandlerContext["send"]>[0]) {
        assert.equal(response.t, "api.res");
        if (response.t !== "api.res") throw new Error("采集处理器返回了非 API 消息");
        result = response.body as ApiResult<OrchestrationMetricCollectResponse>;
      },
    } as unknown as ApiHandlerContext, { t: "api.req", id: "token-coverage", method: "orch.metrics.collect", path: "/api/orch/metrics/collect",
      body: { workspaceId: "client:local", scope: { scopeKind: "mine", scopeId: null }, limit: 50 } });
    assert.ok(result?.ok);
    return result;
  } finally { db.close(); }
}

test("真实 Claude 用量缺少总量时保留输入输出事实，总量显示未知", () => {
  const usage = tryExtractTokenUsage({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 } } });
  assert.ok(usage);
  const result = collectTokenUsages([usage]);
  assert.deepEqual(summarizeDesktopMetrics([result]).tokens, { input: 10, output: 5, total: null, measuredTraces: 0, missingTraces: 1 });
  assert.deepEqual(result.traceFacts?.[0]?.tokenUsageCoverage, { inputTokens: true, outputTokens: true, totalTokens: false });
  const local = result.traceFacts![0]!;
  assert.equal(readDesktopMetricToken(local, "inputTokens"), 10);
  assert.equal(readDesktopMetricToken(local, "outputTokens"), 5);
  assert.equal(readDesktopMetricToken(local, "totalTokens"), null);
  const cloud = collectTokenUsages([usage], false).traceFacts![0]!;
  assert.equal("tokenUsageCoverage" in cloud, false);
  const { sourceFingerprint: localFingerprint, tokenUsageCoverage, ...localFields } = result.traceFacts![0]!;
  const { sourceFingerprint: cloudFingerprint, ...cloudFields } = cloud;
  assert.deepEqual(localFields, cloudFields);
  assert.notEqual(localFingerprint, cloudFingerprint);
});

test("同 Trace 有一条用量缺字段时，不能把该字段的部分和当完整事实", () => {
  const result = collectTokenUsages([{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, { inputTokens: 20 }]);
  assert.deepEqual(summarizeDesktopMetrics([result]).tokens, { input: 30, output: null, total: null, measuredTraces: 0, missingTraces: 1 });
  assert.deepEqual(result.traceFacts?.[0]?.tokenUsageCoverage, { inputTokens: true, outputTokens: false, totalTokens: false });
});

test("完整覆盖的真实零用量显示零，旧事实没有覆盖标记时保持未知", () => {
  const result = collectTokenUsages([{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }]);
  assert.deepEqual(summarizeDesktopMetrics([result]).tokens, { input: 0, output: 0, total: 0, measuredTraces: 1, missingTraces: 0 });
  assert.equal(readDesktopMetricToken(result.traceFacts![0]!, "totalTokens"), 0);
  assert.deepEqual(summarizeDesktopMetrics([collectTokenUsages([])]).tokens,
    { input: null, output: null, total: null, measuredTraces: 0, missingTraces: 1 });
  assert.deepEqual(summarizeDesktopMetrics([page("client:local", { traceFacts: [trace("legacy", { tokenUsageCoverage: undefined })] })]).tokens,
    { input: null, output: null, total: null, measuredTraces: 0, missingTraces: 1 });
});

test("本机读取复用真实 collect 的过滤与分页，下一页按原 cursor 请求", async () => {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db);
    db.prepare("INSERT INTO workspaces (id,title,path,created_at,updated_at) VALUES (?,?,?,?,?)").run("client:local", "本机", "/local", 1, 1);
    db.prepare("INSERT INTO workspaces (id,title,path,created_at,updated_at) VALUES (?,?,?,?,?)").run("client:other", "其他", "/other", 1, 1);
    const insert = db.prepare(`INSERT INTO orch_instances
      (id,workspace_id,workflow_id,workflow_snapshot_json,intake_snapshot_json,status,node_states_json,created_at,updated_at)
      VALUES (?,?,?,'{"name":"流程","nodes":[],"edges":[]}','{}',?,'{}',?,?)`);
    insert.run("run-1", "client:local", "flow", "completed", 100, 500);
    insert.run("run-2", "client:local", "flow", "completed", 100, 600);
    insert.run("run-outside", "client:local", "flow", "completed", 100, 800);
    insert.run("run-running", "client:local", "flow", "running", 100, 550);
    insert.run("run-other", "client:other", "flow", "completed", 100, 550);
    const requests: DesktopApiRequest[] = [];
    const state = createDesktopMetricsState();
    const reader = createDesktopMetricsReader(async request => {
      requests.push(request);
      assert.equal(request.method, "orch.metrics.collect");
      let body: ApiResult<OrchestrationMetricCollectResponse> | undefined;
      handleOrchMetricsCollect({ db: { db }, workspaces: new Map([["client:local", {}]]),
        send: (response: Parameters<ApiHandlerContext["send"]>[0]) => {
          assert.equal(response.t, "api.res");
          if (response.t !== "api.res") throw new Error("采集处理器返回了非 API 消息");
          body = response.body as ApiResult<OrchestrationMetricCollectResponse>;
        },
      } as unknown as ApiHandlerContext, { t: "api.req", id: "real-collect", method: request.method, path: "/api/orch/metrics/collect", body: request.body });
      assert.ok(body);
      return body;
    }, state, { pageSize: 1 });
    reader.select("client:local", { from: 400, to: 700, statuses: ["completed"] });
    await reader.load("first");
    assert.deepEqual(state.pages.flatMap(item => item.instances.map(run => run.sourceInstanceId)), ["run-2"]);
    assert.equal(state.pages[0]?.hasMore, true);
    assert.equal(requests[0]?.body?.snapshotId ?? null, null);
    assert.ok(state.pages[0]?.snapshotId, "首屏响应必须提供冻结快照身份");
    insert.run("run-late", "client:local", "flow", "completed", 100, 650);
    await reader.load("next");
    assert.deepEqual(state.pages.flatMap(item => item.instances.map(run => run.sourceInstanceId)), ["run-2", "run-1"]);
    assert.equal(requests[1]?.body?.cursor, "1");
    assert.equal(requests[1]?.body?.snapshotId, state.pages[0]?.snapshotId);
    assert.equal(state.pages[1]?.snapshotId, state.pages[0]?.snapshotId);
    assert.deepEqual(requests[1]?.body?.filters, { from: 400, to: 700, statuses: ["completed"] });
    assert.equal(state.pages[1]?.hasMore, false);
    assert.equal(summarizeDesktopMetrics(state.pages).durationMs, 900);
  } finally { db.close(); }
});

test("Token 只累加有用量证据的 Trace，缺失耗时和用量保持未知且不重复计数", () => {
  const first = page("client:local", { traceFacts: [trace("a"), trace("b", { inputTokens: 20, outputTokens: 7, totalTokens: 27, durationMs: null })] });
  const second = page("client:local", { traceFacts: [trace("a"), trace("missing", { modelCallCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, tokenUsageCoverage: { inputTokens: false, outputTokens: false, totalTokens: false }, evidenceStatus: "incomplete", evidenceReasons: ["missing_token_usage"] })] });
  const summary = summarizeDesktopMetrics([first, second]);
  assert.equal(summary.traces.length, 3);
  assert.deepEqual(summary.tokens, { input: 30, output: 12, total: 42, measuredTraces: 2, missingTraces: 1 });
  assert.equal(summary.durationMs, null);
  assert.equal(summary.incompleteTraceCount, 1);
  assert.equal(summarizeDesktopMetrics([page()]).tokens.total, null);
});

test("分页响应快照变化时保留已展示事实并显式失败", async () => {
  const state = createDesktopMetricsState();
  let calls = 0;
  const reader = createDesktopMetricsReader(async () => ({ ok: true, ...page("client:local", {
    snapshotId: ++calls === 1 ? "first-snapshot" : "changed-snapshot", hasMore: calls === 1, nextCursor: calls === 1 ? "1" : null,
  }) }), state);
  reader.select("client:local");
  await reader.load("first");
  await assert.rejects(reader.load("changed"), { code: "DESKTOP_METRICS_RESPONSE_INVALID" });
  assert.equal(state.pages.length, 1);
  assert.equal(state.error?.requestId, "changed");
});

test("分页失败显式失败并停止继续加载，刷新才重新开始", async () => {
  let calls = 0;
  const state = createDesktopMetricsState();
  const reader = createDesktopMetricsReader(async () => {
    calls += 1;
    if (calls === 2) return { ok: false, code: "INTERNAL_ERROR", message: "采集失败" };
    return { ok: true, ...page("client:local", { hasMore: calls === 1, nextCursor: calls === 1 ? "1" : null }) };
  }, state);
  reader.select("client:local");
  await reader.load("one");
  await assert.rejects(reader.load("two"), /采集失败/u);
  assert.equal(state.error?.requestId, "two");
  assert.equal(state.error?.workspaceId, "client:local");
  await assert.rejects(reader.load("three"), /刷新/u);
  assert.equal(calls, 2);
  assert.equal(state.pages.length, 1);
  reader.select("client:local");
  await reader.load("refresh");
  assert.equal(calls, 3);
  assert.equal(state.error, null);
  assert.equal(state.pages.length, 1);
});

test("工作区切换取消旧请求，迟到失败不能覆盖新工作区", async () => {
  let resolveOld!: (response: ApiResult<OrchestrationMetricCollectResponse>) => void;
  const old = new Promise<ApiResult<OrchestrationMetricCollectResponse>>(resolve => { resolveOld = resolve; });
  const state = createDesktopMetricsState();
  const reader = createDesktopMetricsReader(async request => request.body?.workspaceId === "client:old" ? old : { ok: true, ...page("client:new") }, state);
  reader.select("client:old");
  const oldLoad = reader.load("old");
  const oldRejected = assert.rejects(oldLoad, error => error instanceof Error && error.name === "AbortError");
  reader.select("client:new");
  await reader.load("new");
  resolveOld({ ok: false, code: "INTERNAL_ERROR", message: "旧工作区失败" });
  await oldRejected;
  assert.equal(state.workspaceId, "client:new");
  assert.equal(state.pages[0]?.sourceWorkspaceId, "client:new");
  assert.equal(state.error, null);
  assert.equal(state.loading, false);
});

test("迟到成功不能污染新工作区，取消后不继续读取后续页", async () => {
  let resolveOld!: (response: ApiResult<OrchestrationMetricCollectResponse>) => void;
  const old = new Promise<ApiResult<OrchestrationMetricCollectResponse>>(resolve => { resolveOld = resolve; });
  const state = createDesktopMetricsState();
  const reader = createDesktopMetricsReader(async request => request.body?.workspaceId === "client:old" ? old : { ok: true, ...page("client:new") }, state);
  reader.select("client:old");
  const pending = reader.load("old-success");
  const rejected = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  reader.select("client:new");
  await reader.load("new-success");
  resolveOld({ ok: true, ...page("client:old", { hasMore: true, nextCursor: "50" }) });
  await rejected;
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0]?.sourceWorkspaceId, "client:new");
});

test("未登录和 Server 断连时采集直接使用桌面桥，不触发网络或认证", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests += 1;
      assert.equal(request.method, "orch.metrics.collect");
      assert.equal(request.body?.workspaceId, "client:local");
      return { status: 200, body: { ok: true, ...page() } };
    },
  } } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机度量不得访问 Server"); });
  const state = createDesktopMetricsState();
  const reader = createDesktopMetricsReader(requestDesktopApi<OrchestrationMetricCollectResponse>, state);
  reader.select("client:local");
  await reader.load("offline");
  assert.equal(requests, 1);
  assert.equal(state.pages[0]?.sourceWorkspaceId, "client:local");
  assert.equal(state.error, null);
});

test("取消与错误工作区响应均不提交事实", async () => {
  const state = createDesktopMetricsState();
  const reader = createDesktopMetricsReader(async () => ({ ok: true, ...page("client:wrong") }), state);
  reader.select("client:local");
  await assert.rejects(reader.load("wrong"), /工作区/u);
  assert.equal(state.pages.length, 0);
  reader.select("client:local");
  const pending = reader.load("cancel");
  reader.cancel();
  await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  assert.equal(state.pages.length, 0);
});
