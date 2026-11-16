import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import { createPinia, setActivePinia } from "pinia";
import { deriveOrchestrationInstanceSummary, type NodeExecutionState } from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import {
  applyHydratedPlannerDraftIfCurrent,
  useOrchestrationStore,
} from "../src/store/orchestration.ts";

const originalFetch = globalThis.fetch;

/** 执行原始 SFC 控制方法，仅替换弹窗和提示等浏览器边界。 */
function loadControlActions(component: string, names: string[], context: Record<string, unknown>): Record<string, (...args: any[]) => unknown> {
  const source = fs.readFileSync(new URL(`../src/features/orchestration/components/${component}.vue`, import.meta.url), "utf8")
    .replace(/^<script setup lang="ts">/u, "").split("</script>")[0]!;
  const ast = ts.createSourceFile("component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ["errorDiagnosticContext", ...names].map((name) => {
    const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `missing control action ${name}`);
    return declaration.getText(ast);
  }).join("\n");
  const sandbox = { ...context, Error, actions: {} };
  vm.runInNewContext(ts.transpileModule(`${code}\nglobalThis.actions = { ${names.join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox);
  return sandbox.actions;
}

for (const action of [
  { component: "orchestration-monitor", name: "onPause", path: "/api/orch/instances/pause" },
  { component: "orchestration-monitor", name: "onCancel", path: "/api/orch/instances/cancel" },
  { component: "orchestration-monitor", name: "onCancelSelectedNode", path: "/api/orch/nodes/cancel" },
  { component: "task-intake-panel", name: "pauseMonitorInstance", path: "/api/orch/instances/pause" },
  { component: "task-intake-panel", name: "confirmTerminateInstance", path: "/api/orch/instances/cancel" },
]) {
  test(`control failure at ${action.component}.${action.name} logs once and stops success effects`, async (t) => {
    const store = useOrchestrationStore(createPinia());
    const instance = buildInstance(`failure-${action.name}`);
    store.selectedInstanceId = instance.id as any;
    store.selectedInstance = instance as any;
    store.instances = [instance as any];
    const before = JSON.stringify(instance);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const errors: unknown[] = [];
    const successes: unknown[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    let confirm: { onOk: () => Promise<void> } | undefined;
    let afterSuccessCalls = 0;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse({ ok: false, code: "CONFLICT", requestId: "control-failed", message: "该操作已被拒绝" });
    }) as typeof fetch;
    const actions = loadControlActions(action.component, [action.name], {
      props: { workspaceId: instance.workspaceId, instanceId: instance.id, readOnly: false },
      orch: store,
      ctx: { value: createApiContext() },
      instance: { value: instance },
      selectedNodeId: { value: "analysis" },
      selectedMonitorInstanceId: { value: instance.id },
      selectedIntakeReadOnly: { value: false },
      getTaskIntakeTitle: () => instance.intakeSnapshot.title,
      canOperateNode: () => true,
      canCancelNode: () => true,
      nodeLabel: () => "需求分析",
      message: { error: (text: unknown) => errors.push(text), success: (text: unknown) => successes.push(text) },
      Modal: { confirm: (options: typeof confirm) => { confirm = options; } },
      console: { error: (label: string, context: Record<string, unknown>) => logs.push([label, context]) },
    });
    await actions[action.name]!(action.name === "onCancelSelectedNode" ? "analysis" : instance.id,
      instance.intakeSnapshot.title, { afterSuccess: () => { afterSuccessCalls += 1; } });
    if (confirm) await confirm.onOk();

    assert.equal(logs.length, 1);
    assert.equal(logs[0]![1].errorCode, "CONFLICT");
    assert.equal(logs[0]![1].requestId, "control-failed");
    assert.equal(logs[0]![1].workspaceId, instance.workspaceId);
    assert.equal(logs[0]![1].instanceId, instance.id);
    assert.equal(logs[0]![1].rootCause, "该操作已被拒绝");
    if (action.name === "onCancelSelectedNode") assert.equal(logs[0]![1].nodeId, "analysis");
    assert.deepEqual(errors, ["该操作已被拒绝"]);
    assert.equal(successes.length, 0);
    assert.equal(afterSuccessCalls, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.path, action.path);
    assert.equal(requests[0]!.body.instanceId, instance.id);
    if (action.name === "onCancelSelectedNode") assert.equal(requests[0]!.body.nodeId, "analysis");
    assert.equal(JSON.stringify(store.selectedInstance), before);
    assert.equal(JSON.stringify(store.instances[0]), before);
  });
}

for (const method of ["pauseInstance", "cancelInstance", "cancelNode"] as const) {
  test(`${method} rejects business failure before changing the tracked instance`, async (t) => {
    const store = useOrchestrationStore(createPinia());
    const instance = buildInstance(`failure-${method}`);
    store.selectedInstanceId = instance.id as any;
    store.selectedInstance = instance as any;
    store.instances = [instance as any];
    const before = JSON.stringify(store.selectedInstance);
    const requests: unknown[] = [];
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ok: false, code: "CONFLICT", requestId: "control-failed", message: "该操作已被拒绝" });
    }) as typeof fetch;
    await assert.rejects(() => store[method](createApiContext(), instance.workspaceId as any, instance.id as any, "analysis"), (error: Error & { code?: string; requestId?: string | null }) => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.requestId, "control-failed");
      assert.match(error.message, /该操作已被拒绝/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(store.selectedInstance), before);
    assert.equal(JSON.stringify(store.instances[0]), before);
  });
}

test("submitFeedback 普通请求不再携带会话恢复策略", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-recovery-contract-removed");
  instance.nodeStates.analysis = {
    ...instance.nodeStates.analysis,
    status: "waiting-feedback",
    humanActionSource: "execution",
    errorCode: "codex_thread_resume_unrecoverable",
    threadId: "thread-codeflow",
    providerThreadId: "thread-provider",
    preserveBinding: true,
    userChoiceRequired: true,
    recoveryStrategies: ["retry-existing", "new-thread"],
  } as any;
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  const requests: Array<{ body: any }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  await store.submitFeedback(
    createApiContext(),
    instance.workspaceId as any,
    instance.id as any,
    "analysis",
    "retry",
    "继续",
    [],
    null,
    null,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.body.action, "retry");
  assert.equal("recoveryStrategy" in requests[0]!.body, false);
  assert.equal("threadReusePolicy" in requests[0]!.body, false);
});

test("节点会话通过统一策略决定是否锁定自由文本", () => {
  const source = fs.readFileSync(
    new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
    "utf8",
  );

  assert.match(source, /requiresStructuredNodeThreadAction\(selectedNodeState\.value\)/u);
  assert.match(source, /function canAcceptFreeTextNodeInput\(/u);
  assert.match(source, /!canAcceptFreeTextNodeInput\(selectedNodeState\.value\)/u);
  assert.doesNotMatch(source, /requiresExplicitThreadRecoveryChoice/u);
  assert.doesNotMatch(source, /selectedNodeRequiresExplicitRecoveryChoice/u);
  assert.doesNotMatch(source, /当前节点会话只接受编排反馈/u);
  assert.doesNotMatch(source, /请进入讨论线程/u);
  assert.doesNotMatch(source, /当前节点线程仍由编排执行控制/u);
  assert.doesNotMatch(source, /请在编排面板继续/u);
  assert.match(source, /当前节点需要明确审批，不能用自由文本代替。/u);
  assert.match(source, /当前节点需要明确选择分支，不能用自由文本代替。/u);
  assert.match(source, /当前节点需要明确启动或跳过，不能用自由文本代替。/u);
  assert.match(source, /当前节点已不再接收输入；如需继续修改，请从节点详情发起重跑。/u);
});

test("历史不可恢复投影不再锁定从节点重跑入口", () => {
  const source = fs.readFileSync(
    new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
    "utf8",
  );
  assert.match(source, /return Boolean\(nodeState\);/u);
  assert.doesNotMatch(source, /原会话已确认无法恢复/u);
});

test("失效 AskUserQuestion 回填直接交由节点反馈入口裁决", () => {
  const source = fs.readFileSync(
    new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /requiresExecutionRecoveryConfirmation/u);
  assert.doesNotMatch(source, /原会话恢复状态尚未确认/u);
  assert.match(source, /await orch\.submitFeedback\(/u);
  assert.match(source, /"resume_with_input"/u);
});

test("节点会话界面不暴露内部调度入口或已删状态", () => {
  const source = fs.readFileSync(
    new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
    "utf8",
  );

  for (const internalText of ["讨论线程", "反馈面板", "入队", "编排面板"]) {
    assert.doesNotMatch(source, new RegExp(internalText, "u"));
  }
  assert.doesNotMatch(source, /\b(?:openDiscussionThread|isShowingDiscussionThread)\b/u);
  assert.match(source, /<span class="orch-monitor__thread-view-badge">节点会话<\/span>/u);
  assert.match(source, /<span>正在加载节点会话\.\.\.<\/span>/u);
});

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "sess-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "sess-demo",
    clearSession() {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildInstance(instanceId: string) {
  return {
    id: instanceId,
    workspaceId: "client-a:ws-demo",
    workflowId: "wf-demo",
    proposalId: "proposal-demo",
    intakeSnapshot: {
      id: "intake-demo",
      workspaceId: "client-a:ws-demo",
      triggerMode: "manual",
      taskType: "feature",
      title: "鲜花市场首页",
      goal: "做一个鲜花市场首页",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: {
      id: "wf-demo",
      workspaceId: "client-a:ws-demo",
      family: "feature-dev",
      name: "CodeFlow 标准功能开发",
      description: "demo",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "analysis", type: "role", roleId: "role-analysis", label: "需求分析", position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: "running",
    nodeStates: {
      // 标注为节点状态类型，否则 threadId 被推导成 string，buildStaleInstance 无法置空。
      analysis: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        threadId: "thread-analysis-demo",
      } as NodeExecutionState,
    },
    createdAt: 1,
    updatedAt: 10,
  };
}

function buildStaleInstance(instanceId: string) {
  const instance = buildInstance(instanceId);
  instance.nodeStates.analysis = {
    ...instance.nodeStates.analysis,
    threadId: null,
    renderedInput: null,
    promptSnapshotIds: null,
  };
  return instance;
}

function buildResetSnapshotInstance(
  instanceId: string,
  currentStatus: "artifact-writing" | "completed",
  updatedAt: number,
) {
  const instance = buildInstance(instanceId);
  instance.updatedAt = updatedAt;
  instance.artifactIndex = { analysis: ["artifact-output-demo" as any] } as any;
  instance.nodeStates.analysis = {
    nodeId: "analysis",
    status: currentStatus,
    retryCount: 0,
    startedAt: 30,
    completedAt: currentStatus === "completed" ? 40 : null,
    threadId: "thread-analysis-demo",
    discussionThreadId: "discussion-analysis-demo",
    renderedInput: "stale rendered input",
    output: "stale output",
    promptSnapshotIds: ["prompt-analysis-demo"],
    inputArtifactIds: ["artifact-demo" as any],
    outputArtifactIds: ["artifact-output-demo" as any],
    feedbackRecordIds: ["feedback-demo" as any],
    conclusion: {
      nextAction: "continue",
      reviewVerdict: "pass",
      summary: "stale summary",
      blockingIssues: null,
      acceptanceChecks: [],
      humanInput: null,
      rework: null,
      decidedBy: "model",
      decidedAt: 40,
    },
    error: null,
    gateResults: null,
    branchTaken: null,
  } as any;
  return instance;
}

function buildPendingRetryInstance(instanceId: string, updatedAt: number) {
  const instance = buildInstance(instanceId);
  instance.updatedAt = updatedAt;
  instance.nodeStates.analysis = {
    nodeId: "analysis",
    status: "pending",
    retryCount: 0,
    startedAt: null,
    completedAt: null,
    threadId: "thread-analysis-demo",
    renderedInput: null,
    inputArtifactIds: ["artifact-demo" as any],
    promptSnapshotIds: ["prompt-analysis-demo"],
    output: null,
    outputArtifactIds: null,
    conclusion: null,
    error: null,
    gateResults: null,
    branchTaken: null,
  } as any;
  return instance;
}

function buildHardResetPendingInstance(instanceId: string, updatedAt: number) {
  const instance = buildPendingRetryInstance(instanceId, updatedAt);
  instance.artifactIndex = {};
  instance.nodeStates.analysis = {
    ...instance.nodeStates.analysis,
    threadId: null,
    discussionThreadId: null,
    promptSnapshotIds: null,
    inputArtifactIds: null,
    feedbackRecordIds: null,
  } as any;
  return instance;
}

function buildReworkInstance(instanceId: string) {
  return {
    id: instanceId,
    workspaceId: "client-a:ws-demo",
    workflowId: "wf-demo",
    proposalId: "proposal-demo",
    intakeSnapshot: buildInstance(instanceId).intakeSnapshot,
    workflowSnapshot: {
      id: "wf-demo",
      workspaceId: "client-a:ws-demo",
      family: "feature-dev",
      name: "CodeFlow 小需求快交付",
      description: "demo",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "analysis", type: "role", roleId: "role-analysis", label: "需求分析", position: { x: 0, y: 0 } },
        { id: "dev", type: "role", roleId: "role-dev", label: "开发实现", position: { x: 320, y: 0 } },
        { id: "e2e", type: "role", roleId: "role-e2e", label: "测试验证", position: { x: 640, y: 0 } },
        { id: "git", type: "role", roleId: "role-git", label: "交付收口", position: { x: 960, y: 0 } },
      ],
      edges: [
        { id: "edge-analysis-dev", sourceNodeId: "analysis", targetNodeId: "dev" },
        { id: "edge-dev-e2e", sourceNodeId: "dev", targetNodeId: "e2e" },
        { id: "edge-e2e-git", sourceNodeId: "e2e", targetNodeId: "git" },
      ],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {
      dev: ["artifact-dev-demo" as any],
      e2e: ["artifact-e2e-demo" as any],
      git: ["artifact-git-demo" as any],
    },
    masterThreadId: null,
    status: "running",
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "completed",
        retryCount: 0,
        startedAt: 1,
        completedAt: 2,
        threadId: "thread-analysis-demo",
      },
      dev: {
        nodeId: "dev",
        status: "completed",
        retryCount: 0,
        startedAt: 3,
        completedAt: 4,
        threadId: "thread-dev-demo",
        renderedInput: "old dev input",
        output: "old dev output",
        outputArtifactIds: ["artifact-dev-demo" as any],
        conclusion: { nextAction: "continue", reviewVerdict: "pass" },
      },
      e2e: {
        nodeId: "e2e",
        status: "artifact-writing",
        retryCount: 0,
        startedAt: 5,
        threadId: "thread-e2e-demo",
        renderedInput: "old e2e input",
        output: "old e2e output",
        outputArtifactIds: ["artifact-e2e-demo" as any],
      },
      git: {
        nodeId: "git",
        status: "completed",
        retryCount: 0,
        startedAt: 6,
        completedAt: 7,
        threadId: "thread-git-demo",
        output: "old git output",
      },
    },
    createdAt: 1,
    updatedAt: 50,
  } as any;
}

function buildArtifact(instanceId: string, artifactId = "artifact-demo") {
  return {
    id: artifactId,
    workspaceId: "client-a:ws-demo",
    instanceId,
    nodeId: "analysis",
    title: "需求分析 输出 v1",
    kind: "analysis-report",
    status: "approved",
    payloadMode: "file-set",
    contentJson: null,
    stagingPath: null,
    publishedPath: "codeflow-docs/demo/analysis.md",
    workspaceBaseDir: "codeflow-docs/demo",
    metadata: {},
    version: 1,
    createdAt: 20,
    updatedAt: 20,
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("refreshWorkspaceData only requests requirement and scheduled-task intake summaries", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const requests: URL[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname !== "/api/orch/intakes") {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    return jsonResponse({
      ok: true,
      intakes: [],
      hasMore: false,
      nextCursor: null,
      statusCounts: [],
      totalCount: 0,
      listMetaById: {},
    });
  }) as typeof fetch;

  await store.refreshWorkspaceData(ctx, "client-a:ws-demo" as any);

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((url) => url.searchParams.get("sourceKind")).sort(),
    ["requirement", "scheduled_task"],
  );
  assert.equal(requests.every((url) => url.pathname === "/api/orch/intakes"), true);
});

test("refreshWorkspaceData rejects failed intake summary responses", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/intakes") {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    if (url.searchParams.get("sourceKind") === "requirement") {
      return jsonResponse({ ok: false, message: "需求摘要加载失败" });
    }
    return jsonResponse({
      ok: true,
      intakes: [],
      hasMore: false,
      nextCursor: null,
      statusCounts: [],
      totalCount: 0,
      listMetaById: {},
    });
  }) as typeof fetch;

  await assert.rejects(
    store.refreshWorkspaceData(ctx, "client-a:ws-demo" as any),
    /需求摘要加载失败/u,
  );
  assert.equal(store.intakesLoading, false);
  assert.equal(store.scheduledIntakesLoading, false);
});

test("orchestration event hydrates selectedInstance when selectedInstanceId already points to an unknown instance", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";

  store.selectedInstanceId = instanceId as any;
  store.$patch({ selectedInstance: null });
  store.instances = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: buildInstance(instanceId),
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-demo" as any,
    instanceId: instanceId as any,
    nodeId: "analysis",
    type: "orchestration.nodeStateChanged",
    payloadJson: JSON.stringify({
      instanceId,
      nodeId: "analysis",
      nodeLabel: "需求分析",
      status: "running",
      threadId: "thread-analysis-demo",
      nodeState: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        threadId: "thread-analysis-demo",
      },
    }),
    createdAt: 11,
  });

  assert.equal(store.selectedInstance?.id, instanceId);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-analysis-demo");
  assert.equal(store.instances[0]?.id, instanceId);
});

test("orchestration event does not hydrate an unknown instance when the orchestration view is inactive", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    throw new Error("unexpected orchestration instance request");
  }) as typeof fetch;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-background-demo" as any,
    instanceId: "instance-background-demo" as any,
    nodeId: "analysis",
    type: "orchestration.nodeStateChanged",
    payloadJson: JSON.stringify({
      instanceId: "instance-background-demo",
      nodeId: "analysis",
      status: "running",
    }),
    createdAt: 12,
  }, { hydrateUnknownInstance: false });

  assert.equal(requestCount, 0);
  assert.equal(store.instances.length, 0);
  assert.equal(store.selectedInstance, null);
});

test("refreshInstances updates summaries without replacing selectedInstance detail", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildStaleInstance(instanceId);
  const freshInstance = buildInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      if (url.searchParams.get("sourceKind") === "scheduled_task") {
        return jsonResponse({
          ok: true,
          instances: [],
          hasMore: false,
          nextCursor: null,
          totalCountByIntake: {},
        });
      }
      return jsonResponse({
        ok: true,
        instances: [deriveOrchestrationInstanceSummary(freshInstance as any)],
        hasMore: false,
        nextCursor: null,
        totalCountByIntake: { "intake-demo": 1 },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshInstances(ctx, "client-a:ws-demo" as any);

  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceTotalCountByIntake["intake-demo"], 1);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId ?? null, null);
  assert.equal(store.instances[0]?.nodeStates.analysis?.threadId ?? null, null);
});

test("refreshInstances derives summaries from legacy full-instance list responses", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [buildInstance(instanceId)],
        totalCountByIntake: { "intake-demo": 1 },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshInstances(ctx, "client-a:ws-demo" as any);

  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceSummaries[0]?.intakeId, "intake-demo");
  assert.equal(store.instanceSummaries[0]?.runSummary.statusLabel, "执行中");
  assert.equal("workflowSnapshot" in (store.instanceSummaries[0] as any), false);
  assert.equal("nodeStates" in (store.instanceSummaries[0] as any), false);
});

test("refreshInstances keeps latest intake summary without automatically selecting it", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-completed-from-meta";
  const completedInstance = buildInstance(instanceId);
  completedInstance.status = "completed";
  completedInstance.updatedAt = 40;
  completedInstance.nodeStates.analysis = {
    ...completedInstance.nodeStates.analysis,
    status: "completed",
    completedAt: 40,
  } as any;
  const latestInstance = deriveOrchestrationInstanceSummary(completedInstance as any);

  store.intakeListMetaById = {
    "intake-demo": {
      listStatus: "completed",
      listStatusLabel: "已完成",
      instanceCount: 1,
      latestInstance,
      progressText: "已完成 1/1 节点",
    },
  } as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [],
        hasMore: false,
        nextCursor: null,
        totalCountByIntake: {},
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshInstances(ctx, "client-a:ws-demo" as any);

  assert.equal(store.instanceSummaries.length, 1);
  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceSummaries[0]?.status, "completed");
  assert.equal(store.instanceSummaries[0]?.runSummary.statusLabel, "已完成");
  assert.equal(store.instanceTotalCountByIntake["intake-demo"], 1);
  assert.equal(store.selectedInstanceId, null);
});

test("refreshIntakes backfills latest instance after an empty instance refresh", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-completed-after-race";
  const completedInstance = buildInstance(instanceId);
  completedInstance.status = "completed";
  completedInstance.updatedAt = 40;
  completedInstance.nodeStates.analysis = {
    ...completedInstance.nodeStates.analysis,
    status: "completed",
    completedAt: 40,
  } as any;
  const latestInstance = deriveOrchestrationInstanceSummary(completedInstance as any);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [],
        hasMore: false,
        nextCursor: null,
        totalCountByIntake: {},
      });
    }
    if (url.pathname === "/api/orch/intakes") {
      return jsonResponse({
        ok: true,
        intakes: [completedInstance.intakeSnapshot],
        hasMore: false,
        nextCursor: null,
        statusCounts: [],
        totalCount: 1,
        listMetaById: {
          "intake-demo": {
            listStatus: "completed",
            listStatusLabel: "已完成",
            instanceCount: 1,
            latestInstance,
            progressText: "已完成 1/1 节点",
          },
        },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshInstances(ctx, "client-a:ws-demo" as any);
  assert.equal(store.instanceSummaries.length, 0);

  await store.refreshIntakes(ctx, "client-a:ws-demo" as any);

  assert.equal(store.instanceSummaries.length, 1);
  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceSummaries[0]?.status, "completed");
  assert.equal(store.instanceTotalCountByIntake["intake-demo"], 1);
});

test("orchestration events sync loaded intake list meta across runtime statuses", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-list-sync-demo";
  const instance = buildInstance(instanceId);
  instance.status = "pending";
  instance.nodeStates.analysis = {
    ...instance.nodeStates.analysis,
    status: "pending",
    threadId: null,
  } as any;

  store.intakes = [instance.intakeSnapshot] as any;
  store.intakeListMetaById = {
    "intake-demo": {
      listStatus: "not-started",
      listStatusLabel: "未启动",
      instanceCount: 0,
      latestInstance: null,
      progressText: null,
    },
  } as any;
  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  store.pendingMineItems = [
    {
      reminder: {
        id: `orch:${instanceId}:paused`,
        sourceType: "orchestration",
        workspaceId: "client-a:ws-demo",
        pendingMineStatus: "paused",
        displayKind: "action",
        title: "鲜花市场首页",
        statusLabel: "已暂停",
        tone: "warning",
        summary: "旧暂停提醒",
        updatedAt: 10,
        isActionRequired: true,
        readState: "unread",
        primaryActionKind: "open_orch_monitor",
        primaryActionLabel: "查看执行",
        ignoreMarker: `${instanceId}:paused:10`,
        routeTarget: { workspaceId: "client-a:ws-demo" as any, intakeId: "intake-demo" as any, instanceId: instanceId as any },
      },
      intake: instance.intakeSnapshot,
      listMeta: store.intakeListMetaById["intake-demo"],
      pendingMineStatus: "paused",
      pendingMineStatusLabel: "暂停待处理",
    },
  ] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-started-list-sync" as any,
    instanceId: instanceId as any,
    nodeId: null as any,
    type: "orchestration.started",
    payloadJson: JSON.stringify({ instanceId }),
    createdAt: 20,
  });

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-running-list-sync" as any,
    instanceId: instanceId as any,
    nodeId: "analysis",
    type: "orchestration.nodeStateChanged",
    payloadJson: JSON.stringify({
      instanceId,
      nodeId: "analysis",
      nodeState: {
        ...instance.nodeStates.analysis,
        status: "running",
        threadId: "thread-analysis-demo",
      },
    }),
    createdAt: 21,
  });

  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatus, "running");
  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatusLabel, "运行中");
  assert.equal(store.intakeListMetaById["intake-demo"]?.latestInstance?.status, "running");
  assert.equal(store.intakeListMetaById["intake-demo"]?.instanceCount, 1);
  assert.equal(store.pendingMineItems.length, 0);

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-completed-list-sync" as any,
    instanceId: instanceId as any,
    nodeId: null as any,
    type: "orchestration.completed",
    payloadJson: JSON.stringify({ instanceId, status: "completed" }),
    createdAt: 30,
  });

  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatus, "completed");
  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatusLabel, "已完成");
  assert.equal(store.intakeListMetaById["intake-demo"]?.latestInstance?.status, "completed");
  assert.equal(store.intakeListMetaById["intake-demo"]?.progressText, "1/1");

  store.pendingMineItems = [
    {
      reminder: {
        id: `orch:${instanceId}:receipt`,
        sourceType: "orchestration",
        workspaceId: "client-a:ws-demo",
        pendingMineStatus: "receipt",
        displayKind: "receipt",
        title: "鲜花市场首页",
        statusLabel: "待查收",
        tone: "success",
        summary: "旧待查收提醒",
        updatedAt: 30,
        isActionRequired: false,
        readState: "unread",
        primaryActionKind: "open_orch_artifacts",
        primaryActionLabel: "查看结果",
        ignoreMarker: instanceId,
        routeTarget: { workspaceId: "client-a:ws-demo" as any, intakeId: "intake-demo" as any, instanceId: instanceId as any },
      },
      intake: instance.intakeSnapshot,
      listMeta: store.intakeListMetaById["intake-demo"],
      pendingMineStatus: "receipt",
      pendingMineStatusLabel: "待查收",
    },
  ] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-error-list-sync" as any,
    instanceId: instanceId as any,
    nodeId: "analysis",
    type: "orchestration.error",
    payloadJson: JSON.stringify({ instanceId, nodeId: "analysis", error: "boom" }),
    createdAt: 40,
  });

  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatus, "failed");
  assert.equal(store.intakeListMetaById["intake-demo"]?.listStatusLabel, "已失败");
  assert.equal(store.intakeListMetaById["intake-demo"]?.latestInstance?.status, "failed");
  assert.equal(store.pendingMineItems[0]?.pendingMineStatus, "failed");
  assert.equal(store.pendingMineItems[0]?.reminder.statusLabel, "异常待处理");
});

test("loadTrackedInstance merges equal-updatedAt snapshots so selectedInstance does not keep a stale node thread", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildStaleInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: buildInstance(instanceId),
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-analysis-demo");
  assert.equal(store.instances[0]?.nodeStates.analysis?.threadId, "thread-analysis-demo");
});

test("loadTrackedInstance retains active instances and caps terminal instance details at twelve", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const selectedId = "instance-selected-terminal";
  const selected = buildInstance(selectedId);
  selected.status = "completed";
  selected.updatedAt = 1;
  const activeInstances = Array.from({ length: 13 }, (_, index) => {
    const instance = buildInstance(`instance-active-${index}`);
    instance.status = "running";
    instance.updatedAt = 100 + index;
    return instance;
  });
  const terminalInstances = Array.from({ length: 14 }, (_, index) => {
    const instance = buildInstance(`instance-terminal-${index}`);
    instance.status = "completed";
    instance.updatedAt = 200 + index;
    return instance;
  });
  const responses = [selected, ...activeInstances, ...terminalInstances];
  let requestIndex = 0;

  store.selectedInstanceId = selectedId as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/instances/get") {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    const instance = responses[requestIndex++];
    assert.ok(instance);
    return jsonResponse({ ok: true, instance });
  }) as typeof fetch;

  for (const instance of responses) {
    await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instance.id as any);
  }

  const retainedIds = new Set(store.instances.map((instance) => String(instance.id)));
  const retainedTerminal = store.instances.filter((instance) => instance.status === "completed");
  assert.equal(requestIndex, responses.length);
  assert.equal(store.instances.length, activeInstances.length + 12);
  assert.equal(retainedTerminal.length, 12);
  assert.equal(retainedIds.has(selectedId), true);
  assert.equal(activeInstances.every((instance) => retainedIds.has(instance.id)), true);
  assert.equal(retainedIds.has("instance-terminal-13"), true);
  assert.equal(retainedIds.has("instance-terminal-0"), false);

  activeInstances.forEach((instance, index) => {
    store.applyTrackedInstancePatch(instance.id as any, (tracked) => {
      tracked.status = "completed";
      tracked.updatedAt = 300 + index;
    });
  });
  assert.equal(store.instances.length, 12);
  assert.equal(store.instances.every((instance) => instance.status === "completed"), true);
  assert.equal(store.instances.some((instance) => instance.id === selectedId), true);
});

test("loadTrackedInstance merges richer server snapshots even when local selectedInstance carries a later updatedAt", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildStaleInstance(instanceId);
  staleInstance.updatedAt = 20;

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: buildInstance(instanceId),
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.updatedAt, 20);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-analysis-demo");
});

test("loadTrackedInstanceRuntimePatch merges lightweight runtime patch without clearing rich details", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const richInstance = buildInstance(instanceId);
  richInstance.updatedAt = 20;
  richInstance.roleSnapshots = { "role-analysis": { id: "role-analysis", name: "需求分析" } } as any;
  richInstance.artifactIndex = { analysis: ["artifact-output-demo" as any] };
  richInstance.nodeStates.analysis = {
    nodeId: "analysis",
    status: "running",
    attemptId: "attempt-old",
    nodeExecutionId: "attempt-old",
    attemptNo: 1,
    submissionId: null,
    parentExecutionId: null,
    retryCount: 0,
    startedAt: 20,
    completedAt: null,
    threadId: "thread-old",
    discussionThreadId: "discussion-old",
    renderedInput: "rich rendered input",
    output: "rich output",
    promptSnapshotIds: ["prompt-old"],
    inputArtifactIds: ["artifact-input-old" as any],
    outputArtifactIds: ["artifact-output-demo" as any],
    conclusion: {
      nextAction: "continue",
      reviewVerdict: "pass",
      summary: "rich conclusion",
      blockingIssues: null,
      acceptanceChecks: [],
      humanInput: null,
      rework: null,
      decidedBy: "model",
      decidedAt: 21,
    },
    error: null,
    gateResults: null,
    branchTaken: null,
  } as any;
  const summaryInstance = structuredClone(richInstance);
  summaryInstance.updatedAt = 30;
  summaryInstance.artifactIndex = { analysis: ["artifact-output-demo" as any, "artifact-output-v2" as any] };
  summaryInstance.nodeStates.analysis = {
    ...summaryInstance.nodeStates.analysis,
    retryCount: 1,
    threadId: "thread-new",
    discussionThreadId: "discussion-new",
    promptSnapshotIds: ["prompt-new"],
    inputArtifactIds: ["artifact-input-new" as any],
    outputArtifactIds: ["artifact-output-v2" as any],
    activeFeedbackRecordIds: ["feedback-active" as any],
    feedbackRecordIds: ["feedback-history" as any],
  } as any;
  const runtimePatch = {
    id: instanceId,
    workspaceId: "client-a:ws-demo",
    status: "running",
    runSummary: deriveOrchestrationInstanceSummary(summaryInstance as any).runSummary,
    artifactIndex: summaryInstance.artifactIndex,
    updatedAt: 30,
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        attemptId: "attempt-new",
        nodeExecutionId: "attempt-new",
        attemptNo: 2,
        submissionId: null,
        parentExecutionId: "attempt-old",
        humanActionSource: null,
        threadId: "thread-new",
        discussionThreadId: "discussion-new",
        promptSnapshotIds: ["prompt-new"],
        knowledgeWarnings: null,
        gateResults: null,
        retryCount: 1,
        startedAt: 20,
         completedAt: null,
         error: "原 provider 会话明确不可恢复",
         errorCode: "codex_thread_resume_unrecoverable",
         providerThreadId: "provider-thread-new",
         recoveryReason: "resume_unavailable_and_read_failed",
         preserveBinding: true,
         userChoiceRequired: true,
         recoveryStrategies: ["retry-existing", "new-thread"],
         branchTaken: null,
        inputArtifactIds: ["artifact-input-new"],
        outputArtifactIds: ["artifact-output-v2"],
        activeFeedbackRecordIds: ["feedback-active"],
        feedbackRecordIds: ["feedback-history"],
      },
    },
  };
  const requestPaths: string[] = [];

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = richInstance as any;
  store.instances = [structuredClone(richInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname === "/api/orch/instances/runtime-patch") {
      return jsonResponse({
        ok: true,
        patch: runtimePatch,
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      throw new Error("runtime patch refresh must not call full instance get");
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstanceRuntimePatch(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.deepEqual(requestPaths, ["/api/orch/instances/runtime-patch"]);
  assert.equal(store.selectedInstance?.updatedAt, 30);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-new");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.attemptId, "attempt-new");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.nodeExecutionId, "attempt-new");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.attemptNo, 2);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.parentExecutionId, "attempt-old");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.discussionThreadId, "discussion-new");
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.promptSnapshotIds, ["prompt-old", "prompt-new"]);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.inputArtifactIds, ["artifact-input-old", "artifact-input-new"]);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.outputArtifactIds, ["artifact-output-demo", "artifact-output-v2"]);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.activeFeedbackRecordIds, ["feedback-active"]);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.feedbackRecordIds, ["feedback-history"]);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.errorCode, "codex_thread_resume_unrecoverable");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.providerThreadId, "provider-thread-new");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.recoveryReason, "resume_unavailable_and_read_failed");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.preserveBinding, true);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.userChoiceRequired, true);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.recoveryStrategies, ["retry-existing", "new-thread"]);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.renderedInput, "rich rendered input");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.output, "rich output");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.conclusion?.summary, "rich conclusion");
  assert.equal((store.selectedInstance?.roleSnapshots as any)?.["role-analysis"]?.name, "需求分析");
  assert.deepEqual(store.selectedInstance?.artifactIndex, {
    analysis: ["artifact-output-demo", "artifact-output-v2"],
  });
  assert.equal(store.instances[0]?.nodeStates.analysis?.threadId, "thread-new");
  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceSummaries[0]?.runSummary.statusLabel, runtimePatch.runSummary.statusLabel);
});

test("loadTrackedInstanceRuntimePatch ignores stale artifact index from older patch", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-stale-runtime-patch";
  const currentInstance = buildInstance(instanceId);
  currentInstance.updatedAt = 40;
  currentInstance.artifactIndex = {};
  currentInstance.nodeStates.analysis = {
    ...currentInstance.nodeStates.analysis,
    status: "pending",
    threadId: null,
    outputArtifactIds: null,
  } as any;

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = currentInstance as any;
  store.instances = [structuredClone(currentInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/runtime-patch") {
      return jsonResponse({
        ok: true,
        patch: {
          id: instanceId,
          workspaceId: "client-a:ws-demo",
          status: "running",
          runSummary: deriveOrchestrationInstanceSummary(buildInstance(instanceId) as any).runSummary,
          artifactIndex: { analysis: ["artifact-old"] },
          updatedAt: 30,
          nodeStates: {
            analysis: {
              nodeId: "analysis",
              status: "completed",
              humanActionSource: null,
              threadId: "thread-old",
              discussionThreadId: null,
              promptSnapshotIds: null,
              knowledgeWarnings: null,
              gateResults: null,
              retryCount: 0,
              startedAt: 20,
              completedAt: 30,
              error: null,
              branchTaken: null,
              inputArtifactIds: null,
              outputArtifactIds: ["artifact-old"],
              activeFeedbackRecordIds: null,
              feedbackRecordIds: null,
            },
          },
        },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstanceRuntimePatch(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
  assert.deepEqual(store.instances[0]?.artifactIndex ?? {}, {});
  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
  assert.equal(store.selectedInstance?.updatedAt, 40);
});

test("loadTrackedInstanceRuntimePatch updates existing summary when full instance is not loaded", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-summary-demo";
  const currentInstance = buildInstance(instanceId);
  const completedInstance = buildInstance(instanceId);
  completedInstance.status = "completed";
  completedInstance.updatedAt = 50;
  completedInstance.nodeStates.analysis = {
    ...completedInstance.nodeStates.analysis,
    status: "completed",
    completedAt: 50,
  } as any;

  store.instanceSummaries = [deriveOrchestrationInstanceSummary(currentInstance as any)] as any;
  store.instances = [];
  store.selectedInstance = null;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/runtime-patch") {
      return jsonResponse({
        ok: true,
        patch: {
          id: instanceId,
          workspaceId: "client-a:ws-demo",
          status: "completed",
          runSummary: deriveOrchestrationInstanceSummary(completedInstance as any).runSummary,
          artifactIndex: {},
          updatedAt: 50,
          nodeStates: {
            analysis: {
              nodeId: "analysis",
              status: "completed",
              humanActionSource: null,
              threadId: "thread-analysis-demo",
              discussionThreadId: null,
              promptSnapshotIds: null,
              knowledgeWarnings: null,
              gateResults: null,
              retryCount: 0,
              startedAt: null,
              completedAt: 50,
              error: null,
              branchTaken: null,
              inputArtifactIds: null,
              outputArtifactIds: null,
              activeFeedbackRecordIds: null,
              feedbackRecordIds: null,
            },
          },
        },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstanceRuntimePatch(ctx, "client-a:ws-demo" as any, instanceId as any);

  assert.equal(store.instances.length, 0);
  assert.equal(store.instanceSummaries[0]?.id, instanceId);
  assert.equal(store.instanceSummaries[0]?.status, "completed");
  assert.equal(store.instanceSummaries[0]?.updatedAt, 50);
  assert.equal(store.instanceSummaries[0]?.runSummary.statusLabel, "已完成");
});

test("loadTrackedInstanceRuntimePatch clears rich node details when patch resets node lifecycle", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-reset-demo";
  const staleInstance = buildResetSnapshotInstance(instanceId, "completed", 20);
  const resetInstance = buildHardResetPendingInstance(instanceId, 30);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/runtime-patch") {
      return jsonResponse({
        ok: true,
        patch: {
          id: instanceId,
          workspaceId: "client-a:ws-demo",
          status: "running",
          runSummary: deriveOrchestrationInstanceSummary(resetInstance as any).runSummary,
          artifactIndex: { analysis: ["artifact-output-demo"] },
          updatedAt: 30,
          nodeStates: {
            analysis: {
              nodeId: "analysis",
              status: "pending",
              humanActionSource: null,
              threadId: null,
              discussionThreadId: null,
              promptSnapshotIds: null,
              knowledgeWarnings: null,
              gateResults: null,
              retryCount: 0,
              startedAt: null,
              completedAt: null,
              error: null,
              branchTaken: null,
              inputArtifactIds: null,
              outputArtifactIds: null,
              activeFeedbackRecordIds: null,
              feedbackRecordIds: null,
            },
          },
        },
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstanceRuntimePatch(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.renderedInput ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.output ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.conclusion ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.completedAt ?? null, null);
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
});

test("concurrent runtime patch callers apply syncSelection from their own options", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const instance = buildInstance("instance-runtime-option-isolation");
  const patchResponse = deferred<Response>();
  const runtimePatch = {
    id: instance.id,
    workspaceId,
    status: "running",
    runSummary: deriveOrchestrationInstanceSummary(instance as any).runSummary,
    artifactIndex: {},
    nodeStates: {
      analysis: {
        nodeId: "analysis",
        status: "running",
        retryCount: 0,
        threadId: "thread-runtime-option-isolation",
      },
    },
    updatedAt: 20,
  } as any;
  let requestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.instances = [instance as any];
  store.$patch({ selectedInstance: null });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/instances/runtime-patch") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    return await patchResponse.promise;
  }) as typeof fetch;

  const backgroundLoad = store.loadTrackedInstanceRuntimePatch(ctx, workspaceId, instance.id as any);
  const selectedLoad = store.loadTrackedInstanceRuntimePatch(ctx, workspaceId, instance.id as any, { syncSelection: true });
  patchResponse.resolve(jsonResponse({ ok: true, patch: runtimePatch }));

  await Promise.all([backgroundLoad, selectedLoad]);

  assert.equal(requestCount, 1);
  assert.equal(store.selectedInstance?.id, instance.id);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-runtime-option-isolation");
});

test("loadInstance hydrates selected instance artifacts when fetched snapshot exposes artifact refs", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const artifactId = "artifact-demo";
  const listedInstance = buildInstance(instanceId);
  listedInstance.status = "completed";
  listedInstance.artifactIndex = { analysis: [artifactId as any] };
  listedInstance.nodeStates.analysis = {
    ...listedInstance.nodeStates.analysis,
    status: "completed",
    outputArtifactIds: [artifactId as any],
  } as any;

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = buildStaleInstance(instanceId) as any;
  store.instances = [buildStaleInstance(instanceId)] as any;
  store.selectedInstanceArtifacts = [];
  store.selectedInstancePromptSnapshots = [];
  const artifactListBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [listedInstance],
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: listedInstance,
      });
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      artifactListBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({
        ok: true,
        artifacts: [buildArtifact(instanceId, artifactId)],
      });
    }
    if (url.pathname === "/api/orch/artifacts/get") {
      return jsonResponse({
        ok: true,
        artifact: {
          ...buildArtifact(instanceId, artifactId),
          contentJson: JSON.stringify({ mode: "text", text: "loaded on demand" }),
        },
      });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      return jsonResponse({ ok: true, files: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { force: true });
  await store.loadSelectedInstanceDetails(ctx, "client-a:ws-demo" as any, instanceId as any);

  assert.equal(store.selectedInstance?.status, "completed");
  assert.deepEqual(store.selectedInstance?.artifactIndex, { analysis: [artifactId] });
  assert.equal(store.selectedInstanceArtifacts.length, 1);
  assert.equal(store.selectedInstanceArtifacts[0]?.id, artifactId);
  assert.equal(store.selectedInstanceArtifacts[0]?.contentJson, JSON.stringify({ mode: "text", text: "loaded on demand" }));
  assert.equal(store.selectedArtifactId, artifactId);
  assert.equal(artifactListBodies[0]?.includeContent, false);
});

for (const staleStatus of ["artifact-writing", "completed"] as const) {
  test(`loadTrackedInstance prefers newer pending snapshots over richer local ${staleStatus} state during rework`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const instanceId = "instance-demo";
    const staleInstance = buildResetSnapshotInstance(instanceId, staleStatus, 10);
    const refreshedInstance = buildPendingRetryInstance(instanceId, 20);

    store.selectedInstanceId = instanceId as any;
    store.selectedInstance = staleInstance as any;
    store.instances = [structuredClone(staleInstance)] as any;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/orch/instances") {
        return jsonResponse({
          ok: true,
          instances: [refreshedInstance],
        });
      }
      if (url.pathname === "/api/orch/instances/get") {
        return jsonResponse({
          ok: true,
          instance: refreshedInstance,
        });
      }
      if (url.pathname === "/api/orch/artifacts/list") {
        return jsonResponse({ ok: true, artifacts: [] });
      }
      if (url.pathname === "/api/orch/events/list") {
        return jsonResponse({ ok: true, events: [] });
      }
      if (url.pathname === "/api/orch/prompt-snapshots/list") {
        return jsonResponse({ ok: true, snapshots: [] });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

    assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
    assert.equal(store.selectedInstance?.nodeStates.analysis?.renderedInput ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.output ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.completedAt ?? null, null);
    assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
    assert.equal(store.instances[0]?.nodeStates.analysis?.status, "pending");
  });
}

for (const staleStatus of ["artifact-writing", "completed"] as const) {
  test(`loadTrackedInstance keeps newer local pending state when server returns older ${staleStatus} snapshot`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const instanceId = "instance-demo";
    const newerPendingInstance = buildPendingRetryInstance(instanceId, 20);
    const staleServerInstance = buildResetSnapshotInstance(instanceId, staleStatus, 10);

    store.selectedInstanceId = instanceId as any;
    store.selectedInstance = newerPendingInstance as any;
    store.instances = [structuredClone(newerPendingInstance)] as any;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/orch/instances") {
        return jsonResponse({
          ok: true,
          instances: [staleServerInstance],
        });
      }
      if (url.pathname === "/api/orch/instances/get") {
        return jsonResponse({
          ok: true,
          instance: staleServerInstance,
        });
      }
      if (url.pathname === "/api/orch/artifacts/list") {
        return jsonResponse({ ok: true, artifacts: [] });
      }
      if (url.pathname === "/api/orch/events/list") {
        return jsonResponse({ ok: true, events: [] });
      }
      if (url.pathname === "/api/orch/prompt-snapshots/list") {
        return jsonResponse({ ok: true, snapshots: [] });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

    assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
    assert.equal(store.selectedInstance?.nodeStates.analysis?.renderedInput ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.output ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.completedAt ?? null, null);
    assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
    assert.equal(store.instances[0]?.nodeStates.analysis?.status, "pending");
  });
}

for (const staleStatus of ["artifact-writing", "completed"] as const) {
  test(`older ${staleStatus} nodeStateChanged payload does not overwrite newer local pending reset`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const instanceId = "instance-demo";
    const newerPendingInstance = buildHardResetPendingInstance(instanceId, 20);
    const staleNodeState = buildResetSnapshotInstance(instanceId, staleStatus, 10).nodeStates.analysis;

    store.selectedInstanceId = instanceId as any;
    store.selectedInstance = newerPendingInstance as any;
    store.instances = [structuredClone(newerPendingInstance)] as any;

    await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
      id: `event-stale-${staleStatus}` as any,
      instanceId: instanceId as any,
      nodeId: "analysis",
      type: "orchestration.nodeStateChanged",
      payloadJson: JSON.stringify({
        instanceId,
        nodeId: "analysis",
        nodeLabel: "需求分析",
        status: staleStatus,
        threadId: "thread-analysis-demo",
        nodeState: staleNodeState,
      }),
      createdAt: 10,
    });

    assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
    assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.discussionThreadId ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.promptSnapshotIds ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.inputArtifactIds ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.feedbackRecordIds ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.renderedInput ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.output ?? null, null);
    assert.equal(store.selectedInstance?.nodeStates.analysis?.completedAt ?? null, null);
    assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
    assert.equal(store.instances[0]?.nodeStates.analysis?.status, "pending");
  });
}

test("loadTrackedInstance honors explicit null reset fields from newer pending snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildResetSnapshotInstance(instanceId, "completed", 10);
  const refreshedInstance = buildHardResetPendingInstance(instanceId, 20);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [refreshedInstance],
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: refreshedInstance,
      });
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({ ok: true, artifacts: [] });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.discussionThreadId ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.promptSnapshotIds ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.inputArtifactIds ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.feedbackRecordIds ?? null, null);
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
});

test("artifactDiscarded does not reattach superseded artifact to pending node state", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-rework-demo";
  const instance = buildReworkInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-rework-demo" as any,
    instanceId: instanceId as any,
    nodeId: null as any,
    type: "orchestration.reworkRequested",
    payloadJson: JSON.stringify({
      instanceId,
      fromNodeId: "e2e",
      fromNodeLabel: "测试验证",
      targetNodeId: "dev",
      targetNodeLabel: "开发实现",
      artifactIds: ["artifact-e2e-demo"],
      reason: "回退到开发实现",
    }),
    createdAt: 60,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/artifacts/get") {
      return jsonResponse({
        ok: true,
        artifact: {
          ...buildArtifact(instanceId, "artifact-dev-demo"),
          nodeId: "dev",
          id: "artifact-dev-demo",
          status: "superseded",
        },
      });
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      return jsonResponse({ ok: true, files: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-discarded-demo" as any,
    instanceId: instanceId as any,
    nodeId: "dev",
    type: "orchestration.artifactDiscarded",
    payloadJson: JSON.stringify({
      instanceId,
      nodeId: "dev",
      nodeLabel: "开发实现",
      artifactId: "artifact-dev-demo",
      discardedPath: null,
    }),
    createdAt: 61,
  });

  assert.equal(store.selectedInstance?.nodeStates.dev?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.dev?.outputArtifactIds ?? null, null);
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
});

test("newer failed snapshot wins over older richer artifact-writing state", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildResetSnapshotInstance(instanceId, "artifact-writing", 10);
  const failedInstance = buildInstance(instanceId);
  failedInstance.updatedAt = 20;
  failedInstance.nodeStates.analysis = {
    nodeId: "analysis",
    status: "failed",
    retryCount: 0,
    startedAt: 30,
    completedAt: 40,
    threadId: "thread-analysis-demo",
    error: "node failed",
  } as any;

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [failedInstance],
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: failedInstance,
      });
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({ ok: true, artifacts: [] });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "failed");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.error, "node failed");
});

test("newer failed snapshot wins over older completed state in same terminal phase", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildResetSnapshotInstance(instanceId, "completed", 10);
  const failedInstance = buildInstance(instanceId);
  failedInstance.updatedAt = 20;
  failedInstance.nodeStates.analysis = {
    nodeId: "analysis",
    status: "failed",
    retryCount: 0,
    startedAt: 30,
    completedAt: 40,
    threadId: "thread-analysis-demo",
    error: "node failed after completion snapshot",
  } as any;

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [failedInstance],
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: failedInstance,
      });
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({ ok: true, artifacts: [] });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "failed");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.error, "node failed after completion snapshot");
});

test("equal updatedAt pending reset still wins over completed snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const staleInstance = buildResetSnapshotInstance(instanceId, "completed", 20);
  const refreshedInstance = buildHardResetPendingInstance(instanceId, 20);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = staleInstance as any;
  store.instances = [structuredClone(staleInstance)] as any;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances") {
      return jsonResponse({
        ok: true,
        instances: [refreshedInstance],
      });
    }
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({
        ok: true,
        instance: refreshedInstance,
      });
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({ ok: true, artifacts: [] });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadTrackedInstance(ctx, "client-a:ws-demo" as any, instanceId as any, { syncSelection: true });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId ?? null, null);
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
});

test("lightweight nodeStateChanged payload preserves canonical execution identity and clears threadId", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-demo";
  const instance = buildInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-thread-clear-demo" as any,
    instanceId: instanceId as any,
    nodeId: "analysis",
    type: "orchestration.nodeStateChanged",
    payloadJson: JSON.stringify({
      instanceId,
      nodeId: "analysis",
      nodeLabel: "需求分析",
      status: "pending",
      nodeExecutionId: "attempt-lightweight",
      attemptNo: 2,
      parentExecutionId: "attempt-lightweight-parent",
      threadId: null,
    }),
    createdAt: 20,
  });

  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.attemptId, "attempt-lightweight");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.nodeExecutionId, "attempt-lightweight");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.attemptNo, 2);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.parentExecutionId, "attempt-lightweight-parent");
  assert.equal(store.instances[0]?.nodeStates.analysis?.threadId ?? null, null);
});

test("reworkRequested immediately resets target node and downstream nodes to pending even without payload.nodeId", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-rework-demo";
  const instance = buildReworkInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-rework-demo" as any,
    instanceId: instanceId as any,
    nodeId: null as any,
    type: "orchestration.reworkRequested",
    payloadJson: JSON.stringify({
      instanceId,
      fromNodeId: "e2e",
      fromNodeLabel: "测试验证",
      targetNodeId: "dev",
      targetNodeLabel: "开发实现",
      artifactIds: ["artifact-e2e-demo"],
      reason: "回退到开发实现",
    }),
    createdAt: 60,
  });

  assert.equal(store.selectedInstance?.status, "running");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "completed");
  assert.equal(store.selectedInstance?.nodeStates.dev?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.e2e?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.git?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.dev?.output ?? null, null);
  assert.equal(store.selectedInstance?.nodeStates.e2e?.output ?? null, null);
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {});
  assert.deepEqual(store.instances[0]?.artifactIndex ?? {}, {});
});

test("reworkRequested honors the runtime exact affected node set", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const instanceId = "instance-rework-demo";
  const instance = buildReworkInstance(instanceId);

  store.selectedInstanceId = instanceId as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;

  await store.onOrchestrationEvent(ctx, "client-a:ws-demo" as any, {
    id: "event-exact-rework-demo" as any,
    instanceId: instanceId as any,
    nodeId: null as any,
    type: "orchestration.reworkRequested",
    payloadJson: JSON.stringify({
      instanceId,
      targetNodeId: "dev",
      affectedNodeIds: ["dev"],
      reason: "只重跑开发实现",
    }),
    createdAt: 61,
  });

  assert.equal(store.selectedInstance?.nodeStates.dev?.status, "pending");
  assert.equal(store.selectedInstance?.nodeStates.e2e?.status, "artifact-writing");
  assert.equal(store.selectedInstance?.nodeStates.git?.status, "completed");
  assert.deepEqual(store.selectedInstance?.artifactIndex ?? {}, {
    e2e: ["artifact-e2e-demo"],
    git: ["artifact-git-demo"],
  });
});

test("refreshIntakes ignores an old workspace response without closing the new workspace loading state", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceA = "client-a:workspace-a" as any;
  const workspaceB = "client-a:workspace-b" as any;
  const responseA = deferred<Response>();
  const responseB = deferred<Response>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/intakes") throw new Error(`unexpected request: ${url.pathname}`);
    return url.searchParams.get("workspaceId") === workspaceA ? responseA.promise : responseB.promise;
  }) as typeof fetch;

  store.resetForWorkspace(workspaceA);
  const requestA = store.refreshIntakes(ctx, workspaceA);
  await Promise.resolve();
  await Promise.resolve();
  store.resetForWorkspace(workspaceB);
  const requestB = store.refreshIntakes(ctx, workspaceB);
  await Promise.resolve();
  await Promise.resolve();

  responseA.resolve(jsonResponse({
    ok: true,
    intakes: [{ ...buildInstance("instance-a").intakeSnapshot, id: "intake-a", workspaceId: workspaceA, title: "旧工作区" }],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await requestA;
  assert.equal(store.intakesLoading, true);
  assert.equal(store.intakes.length, 0);

  responseB.resolve(jsonResponse({
    ok: true,
    intakes: [{ ...buildInstance("instance-b").intakeSnapshot, id: "intake-b", workspaceId: workspaceB, title: "新工作区" }],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await requestB;
  assert.equal(store.intakesLoading, false);
  assert.deepEqual(store.intakes.map((item) => item.id), ["intake-b"]);
});

test("refreshIntakes keeps the latest same-workspace filter response when requests finish out of order", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-filter-race" as any;
  const older = deferred<Response>();
  const newer = deferred<Response>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/intakes") throw new Error(`unexpected request: ${url.pathname}`);
    return url.searchParams.get("search") === "older" ? older.promise : newer.promise;
  }) as typeof fetch;

  store.resetForWorkspace(workspaceId);
  const olderRequest = store.refreshIntakes(ctx, workspaceId, { search: "older" });
  await Promise.resolve();
  const newerRequest = store.refreshIntakes(ctx, workspaceId, { search: "newer" });
  await Promise.resolve();

  older.resolve(jsonResponse({
    ok: true,
    intakes: [{ ...buildInstance("instance-older").intakeSnapshot, id: "intake-older", workspaceId, title: "旧筛选" }],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await olderRequest;
  assert.equal(store.intakes.length, 0);
  assert.equal(store.intakesLoading, true);

  newer.resolve(jsonResponse({
    ok: true,
    intakes: [{ ...buildInstance("instance-newer").intakeSnapshot, id: "intake-newer", workspaceId, title: "新筛选" }],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  }));
  await newerRequest;

  assert.deepEqual(store.intakes.map((item) => item.id), ["intake-newer"]);
  assert.equal(store.intakesLoading, false);
});

test("refreshIntakes clears a filtered-out selection and never falls back to the first result", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-filter-selection" as any;
  const selected = buildInstance("instance-selected");
  selected.intakeSnapshot.id = "intake-selected" as any;

  store.resetForWorkspace(workspaceId);
  store.intakes = [selected.intakeSnapshot as any];
  store.selectedIntakeId = selected.intakeSnapshot.id;
  store.selectedIntakeSnapshot = selected.intakeSnapshot as any;
  store.selectedInstanceId = selected.id as any;
  store.selectedInstance = selected as any;
  store.selectedInstanceArtifacts = [{ id: "artifact-stale" } as any];

  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    intakes: [{ ...selected.intakeSnapshot, id: "intake-other", title: "其他需求" }],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 1,
    listMetaById: {},
  })) as typeof fetch;

  await store.refreshIntakes(ctx, workspaceId, { search: "other" });

  assert.equal(store.selectedIntakeId, null);
  assert.equal(store.selectedIntakeSnapshot, null);
  assert.equal(store.selectedInstanceId, null);
  assert.equal(store.selectedInstance, null);
  assert.deepEqual(store.selectedInstanceArtifacts, []);
});

test("refreshIntakes preserves a later-page selection while the refreshed list has more rows", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-later-page-selection" as any;
  const first = buildInstance("instance-first-page");
  const selected = buildInstance("instance-later-page");
  first.intakeSnapshot.id = "intake-first-page" as any;
  selected.intakeSnapshot.id = "intake-later-page" as any;

  store.resetForWorkspace(workspaceId);
  store.intakes = [first.intakeSnapshot, selected.intakeSnapshot] as any;
  store.selectedIntakeId = selected.intakeSnapshot.id;
  store.selectedIntakeSnapshot = selected.intakeSnapshot as any;
  store.selectedInstanceId = selected.id as any;
  store.selectedInstance = selected as any;
  store.selectedInstanceArtifacts = [{ id: "artifact-later-page" } as any];

  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    intakes: [first.intakeSnapshot],
    hasMore: true,
    nextCursor: "next-page",
    statusCounts: [],
    totalCount: 51,
    listMetaById: {},
  })) as typeof fetch;

  await store.refreshIntakes(ctx, workspaceId);

  assert.deepEqual(store.intakes.map((item) => item.id), [first.intakeSnapshot.id]);
  assert.equal(store.selectedIntakeId, selected.intakeSnapshot.id);
  assert.equal(store.selectedIntakeSnapshot?.id, selected.intakeSnapshot.id);
  assert.equal(store.selectedInstanceId, selected.id);
  assert.equal(store.selectedInstance?.id, selected.id);
  assert.deepEqual(store.selectedInstanceArtifacts.map((item) => item.id), ["artifact-later-page"]);
});

test("refreshIntakes preserves a later-page scheduled selection while that list has more rows", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-later-scheduled-selection" as any;
  const scheduledFirst = buildInstance("instance-scheduled-first");
  const selected = buildInstance("instance-scheduled-later");
  scheduledFirst.intakeSnapshot.id = "intake-scheduled-first" as any;
  scheduledFirst.intakeSnapshot.requester = { source: "scheduled_task" } as any;
  selected.intakeSnapshot.id = "intake-scheduled-later" as any;
  selected.intakeSnapshot.requester = { source: "scheduled_task" } as any;

  store.resetForWorkspace(workspaceId);
  store.scheduledIntakes = [scheduledFirst.intakeSnapshot] as any;
  store.scheduledIntakesHasMore = true;
  store.selectedIntakeId = selected.intakeSnapshot.id;
  store.selectedIntakeSnapshot = selected.intakeSnapshot as any;
  store.selectedInstanceId = selected.id as any;
  store.selectedInstance = selected as any;

  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    intakes: [],
    hasMore: false,
    nextCursor: null,
    statusCounts: [],
    totalCount: 0,
    listMetaById: {},
  })) as typeof fetch;

  await store.refreshIntakes(ctx, workspaceId);

  assert.equal(store.selectedIntakeId, selected.intakeSnapshot.id);
  assert.equal(store.selectedIntakeSnapshot?.id, selected.intakeSnapshot.id);
  assert.equal(store.selectedInstanceId, selected.id);
  assert.equal(store.selectedInstance?.id, selected.id);
});

test("resetForWorkspace clears orchestration list metadata, counts, selections, details, and loading flags", () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-reset");

  store.intakes = [instance.intakeSnapshot as any];
  store.intakesLoading = true;
  store.intakesLoadingMore = true;
  store.intakesHasMore = true;
  store.intakesNextCursor = "intake-cursor";
  store.intakeStatusCounts = [{ status: "running", label: "运行中", count: 1 }] as any;
  store.intakeTotalCount = 9;
  store.intakeListMetaById = { [instance.intakeSnapshot.id]: { listStatus: "running" } } as any;
  store.scheduledIntakes = [instance.intakeSnapshot as any];
  store.scheduledIntakesLoading = true;
  store.scheduledIntakesLoadingMore = true;
  store.scheduledIntakeTotalCount = 7;
  store.scheduledIntakeListMetaById = { [instance.intakeSnapshot.id]: { listStatus: "running" } } as any;
  store.pendingMineItems = [{ reminder: { id: "reminder-reset" } }] as any;
  store.pendingMineLoading = true;
  store.pendingMineLoadingMore = true;
  store.pendingMineTotalCount = 5;
  store.rolesLoading = true;
  store.workflowsLoading = true;
  store.proposalsLoading = true;
  store.instancesLoading = true;
  store.selectedIntakeId = instance.intakeSnapshot.id;
  store.selectedIntakeSnapshot = instance.intakeSnapshot as any;
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.selectedInstanceArtifacts = [{ id: "artifact-reset" } as any];
  store.selectedInstanceEvents = [{ id: "event-reset" } as any];
  store.selectedInstancePromptSnapshots = [{ id: "prompt-reset" } as any];
  store.selectedArtifactFiles = [{ artifactId: "artifact-reset" } as any];
  store.selectedInstanceDetailsLoading = true;
  store.selectedInstanceDetailsLoadedAt = 999;

  store.resetForWorkspace("client-a:workspace-reset" as any);

  assert.equal(store.workspaceScopeId, "client-a:workspace-reset");
  assert.deepEqual(store.intakes, []);
  assert.equal(store.intakesLoading, false);
  assert.equal(store.intakesLoadingMore, false);
  assert.equal(store.intakesHasMore, false);
  assert.equal(store.intakesNextCursor, null);
  assert.deepEqual(store.intakeStatusCounts, []);
  assert.equal(store.intakeTotalCount, 0);
  assert.deepEqual(store.intakeListMetaById, {});
  assert.deepEqual(store.scheduledIntakes, []);
  assert.equal(store.scheduledIntakesLoading, false);
  assert.equal(store.scheduledIntakesLoadingMore, false);
  assert.equal(store.scheduledIntakeTotalCount, 0);
  assert.deepEqual(store.scheduledIntakeListMetaById, {});
  assert.deepEqual(store.pendingMineItems, []);
  assert.equal(store.pendingMineLoading, false);
  assert.equal(store.pendingMineLoadingMore, false);
  assert.equal(store.pendingMineTotalCount, 0);
  assert.equal(store.rolesLoading, false);
  assert.equal(store.workflowsLoading, false);
  assert.equal(store.proposalsLoading, false);
  assert.equal(store.instancesLoading, false);
  assert.equal(store.selectedIntakeId, null);
  assert.equal(store.selectedInstanceId, null);
  assert.equal(store.selectedInstance, null);
  assert.deepEqual(store.selectedInstanceArtifacts, []);
  assert.deepEqual(store.selectedInstanceEvents, []);
  assert.deepEqual(store.selectedInstancePromptSnapshots, []);
  assert.deepEqual(store.selectedArtifactFiles, []);
  assert.equal(store.selectedInstanceDetailsLoading, false);
  assert.equal(store.selectedInstanceDetailsLoadedAt, null);
});

test("loadInstance reuses a cached selected instance only when force is explicitly false", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-cache-hit" as any;
  const instance = buildInstance("instance-cache-hit");
  instance.status = "completed";
  let requestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  store.selectedInstanceArtifacts = [{ id: "artifact-cached" } as any];
  store.selectedInstanceEvents = [{ id: "event-cached" } as any];
  store.selectedInstancePromptSnapshots = [{ id: "prompt-cached" } as any];
  store.selectedInstanceDetailsLoadedAt = 123;
  globalThis.fetch = (async () => {
    requestCount += 1;
    throw new Error("cached loadInstance must not fetch");
  }) as typeof fetch;

  const loaded = await store.loadInstance(ctx, workspaceId, instance.id as any, { force: false });

  assert.equal(loaded?.id, instance.id);
  assert.equal(requestCount, 0);
  assert.equal(store.selectedInstanceDetailsLoadedAt, 123);
  assert.deepEqual(store.selectedInstanceArtifacts.map((item) => item.id), ["artifact-cached"]);
  assert.deepEqual(store.selectedInstanceEvents.map((item) => item.id), ["event-cached"]);
  assert.deepEqual(store.selectedInstancePromptSnapshots.map((item) => item.id), ["prompt-cached"]);
});

test("loadInstance aborts the previous instance request when selection changes", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-selection-abort" as any;
  const instanceA = buildInstance("instance-selection-a");
  const instanceB = buildInstance("instance-selection-b");
  const requestAStarted = deferred<void>();
  let requestASignal!: AbortSignal | null;

  store.resetForWorkspace(workspaceId);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/orch/instances/get");
    const body = JSON.parse(String(init?.body ?? "{}")) as { instanceId?: string };
    if (body.instanceId === instanceA.id) {
      requestASignal = init?.signal ?? null;
      requestAStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(requestASignal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (requestASignal?.aborted) abort();
        else requestASignal?.addEventListener("abort", abort, { once: true });
      });
    }
    assert.equal(body.instanceId, instanceB.id);
    return jsonResponse({ ok: true, instance: instanceB });
  }) as typeof fetch;

  const loadA = store.loadInstance(ctx, workspaceId, instanceA.id as any);
  await requestAStarted.promise;
  const loadedB = await store.loadInstance(ctx, workspaceId, instanceB.id as any);

  assert.equal(loadedB?.id, instanceB.id);
  assert.equal(requestASignal?.aborted, true);
  assert.equal(await loadA, null);
  assert.equal(store.selectedInstanceId, instanceB.id);
});

test("selected instance detail requests share the selection cancellation signal", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-detail-abort" as any;
  const instanceA = buildInstance("instance-detail-a");
  const instanceB = buildInstance("instance-detail-b");
  const detailRequestsStarted = deferred<void>();
  const detailSignals: AbortSignal[] = [];

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instanceA.id as any;
  store.selectedInstance = instanceA as any;
  store.instances = [structuredClone(instanceA)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/get") {
      return jsonResponse({ ok: true, instance: instanceB });
    }
    assert.ok([
      "/api/orch/artifacts/list",
      "/api/orch/events/list",
      "/api/orch/prompt-snapshots/list",
    ].includes(url.pathname));
    const signal = init?.signal;
    assert.ok(signal);
    detailSignals.push(signal);
    if (detailSignals.length === 3) detailRequestsStarted.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  const detailsLoad = store.loadSelectedInstanceDetails(ctx, workspaceId, instanceA.id as any);
  await detailRequestsStarted.promise;
  await store.loadInstance(ctx, workspaceId, instanceB.id as any);

  await detailsLoad;
  assert.equal(detailSignals.length, 3);
  assert.equal(detailSignals.every((signal) => signal.aborted), true);
  assert.equal(store.selectedInstanceId, instanceB.id);
  assert.deepEqual(store.selectedInstanceDetailErrors, {});
});

test("resyncSelectedInstance refreshes a cached instance from the server", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-authoritative-refresh" as any;
  const cached = buildInstance("instance-authoritative-refresh");
  cached.workspaceId = workspaceId;
  cached.status = "running";
  cached.updatedAt = 10;
  const refreshed = structuredClone(cached);
  refreshed.status = "completed";
  refreshed.updatedAt = 20;
  let requestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = cached.id as any;
  store.selectedInstance = cached as any;
  store.instances = [structuredClone(cached)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/orch/instances/get");
    requestCount += 1;
    return jsonResponse({ ok: true, instance: refreshed });
  }) as typeof fetch;

  await store.resyncSelectedInstance(ctx, workspaceId);

  assert.equal(requestCount, 1);
  assert.equal(store.selectedInstance?.status, "completed");
  assert.equal(store.selectedInstance?.updatedAt, 20);
});

test("hidden orchestration events patch cached state without artifact, prompt, or scheduled refresh requests", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-hidden-event" as any;
  const instance = buildInstance("instance-hidden-event");
  let requestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async () => {
    requestCount += 1;
    throw new Error("hidden orchestration event must not fetch");
  }) as typeof fetch;

  await store.onOrchestrationEvent(ctx, workspaceId, {
    id: "event-hidden-patch" as any,
    instanceId: instance.id as any,
    nodeId: "analysis",
    type: "orchestration.nodeStateChanged",
    payloadJson: JSON.stringify({
      instanceId: instance.id,
      nodeId: "analysis",
      status: "waiting-feedback",
      artifactId: "artifact-hidden",
      promptSnapshotId: "prompt-hidden",
      nodeState: {
        ...instance.nodeStates.analysis,
        status: "waiting-feedback",
        threadId: "thread-hidden-updated",
      },
    }),
    createdAt: 50,
  }, { allowNetworkHydration: false });
  await store.onOrchestrationEvent(ctx, workspaceId, {
    id: "event-hidden-scheduled" as any,
    instanceId: instance.id as any,
    nodeId: null as any,
    type: "orchestration.instanceStarted",
    payloadJson: JSON.stringify({ instanceId: instance.id, triggerSource: "scheduled_task" }),
    createdAt: 51,
  }, { allowNetworkHydration: false });

  assert.equal(requestCount, 0);
  assert.equal(store.selectedInstance?.nodeStates.analysis?.status, "waiting-feedback");
  assert.equal(store.selectedInstance?.nodeStates.analysis?.threadId, "thread-hidden-updated");
  assert.deepEqual(store.selectedInstanceArtifacts, []);
  assert.deepEqual(store.selectedInstancePromptSnapshots, []);
});

test("tracked event hydration rechecks visibility before deriving scheduled, artifact, or prompt requests", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-event-tracked-hidden" as any;
  const instance = buildInstance("instance-event-tracked-hidden");
  const instanceRequestStarted = deferred<void>();
  const instanceResponse = deferred<Response>();
  const requestPaths: string[] = [];
  let allowNetworkHydration = true;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname === "/api/orch/instances/get") {
      instanceRequestStarted.resolve(undefined);
      return await instanceResponse.promise;
    }
    throw new Error(`unexpected derived request: ${url.pathname}`);
  }) as typeof fetch;

  const pending = store.onOrchestrationEvent(ctx, workspaceId, {
    id: "event-tracked-then-hidden" as any,
    instanceId: instance.id as any,
    nodeId: "analysis",
    type: "orchestration.instanceStarted",
    payloadJson: JSON.stringify({
      instanceId: instance.id,
      nodeId: "analysis",
      triggerSource: "scheduled_task",
      artifactId: "artifact-tracked-then-hidden",
      promptSnapshotId: "prompt-tracked-then-hidden",
    }),
    createdAt: 60,
  }, { allowNetworkHydration: () => allowNetworkHydration });

  await instanceRequestStarted.promise;
  allowNetworkHydration = false;
  instanceResponse.resolve(jsonResponse({ ok: true, instance }));
  await pending;

  assert.deepEqual(requestPaths, ["/api/orch/instances/get"]);
  assert.equal(store.selectedInstance?.id, instance.id);
  assert.deepEqual(store.selectedInstanceArtifacts, []);
  assert.deepEqual(store.selectedInstancePromptSnapshots, []);
});

test("artifact event hydration rechecks visibility before deriving files or prompt requests", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-event-artifact-hidden" as any;
  const instance = buildInstance("instance-event-artifact-hidden");
  const artifact = buildArtifact(instance.id, "artifact-event-hidden");
  const artifactRequestStarted = deferred<void>();
  const artifactResponse = deferred<Response>();
  const requestPaths: string[] = [];
  let allowNetworkHydration = true;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname === "/api/orch/artifacts/get") {
      artifactRequestStarted.resolve(undefined);
      return await artifactResponse.promise;
    }
    throw new Error(`unexpected derived request: ${url.pathname}`);
  }) as typeof fetch;

  const pending = store.onOrchestrationEvent(ctx, workspaceId, {
    id: "event-artifact-then-hidden" as any,
    instanceId: instance.id as any,
    nodeId: "analysis",
    type: "orchestration.artifactCreated",
    payloadJson: JSON.stringify({
      instanceId: instance.id,
      nodeId: "analysis",
      artifactId: artifact.id,
      promptSnapshotId: "prompt-artifact-then-hidden",
    }),
    createdAt: 61,
  }, { allowNetworkHydration: () => allowNetworkHydration });

  await artifactRequestStarted.promise;
  allowNetworkHydration = false;
  artifactResponse.resolve(jsonResponse({ ok: true, artifact }));
  await pending;

  assert.deepEqual(requestPaths, ["/api/orch/artifacts/get"]);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.outputArtifactIds, [artifact.id]);
  assert.deepEqual(store.selectedInstancePromptSnapshots, []);
  assert.deepEqual(store.selectedArtifactFiles, []);
});

test("loadTrackedInstance ignores a full instance response from a reset workspace generation", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceA = "client-a:tracked-a" as any;
  const workspaceB = "client-a:tracked-b" as any;
  const responseA = deferred<Response>();
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/instances/get") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    return responseA.promise;
  }) as typeof fetch;

  store.resetForWorkspace(workspaceA);
  const pending = store.loadTrackedInstance(ctx, workspaceA, "instance-old-generation" as any);
  await Promise.resolve();
  await Promise.resolve();
  store.resetForWorkspace(workspaceB);
  responseA.resolve(jsonResponse({ ok: true, instance: buildInstance("instance-old-generation") }));

  assert.equal(await pending, null);
  assert.equal(requestCount, 1);
  assert.deepEqual(store.instances, []);
  assert.deepEqual(store.instanceSummaries, []);
  assert.equal(store.selectedInstance, null);
});

test("concurrent tracked instance callers apply syncSelection from their own options", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-tracked-option-isolation" as any;
  const instance = buildInstance("instance-tracked-option-isolation");
  const instanceResponse = deferred<Response>();
  let instanceRequestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/orch/instances/get") throw new Error(`unexpected request: ${url.pathname}`);
    instanceRequestCount += 1;
    return await instanceResponse.promise;
  }) as typeof fetch;

  const backgroundLoad = store.loadTrackedInstance(ctx, workspaceId, instance.id as any);
  const selectedLoad = store.loadTrackedInstance(ctx, workspaceId, instance.id as any, { syncSelection: true });
  instanceResponse.resolve(jsonResponse({ ok: true, instance }));

  await Promise.all([backgroundLoad, selectedLoad]);

  assert.equal(instanceRequestCount, 1);
  assert.equal(store.selectedInstance?.id, instance.id);
});

test("concurrent artifact callers apply attach and file options independently", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const instance = buildInstance("instance-artifact-option-isolation");
  const artifact = buildArtifact(instance.id, "artifact-option-isolation");
  const artifactResponse = deferred<Response>();
  let artifactRequestCount = 0;
  let artifactFileRequestCount = 0;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/artifacts/get") {
      artifactRequestCount += 1;
      return await artifactResponse.promise;
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      artifactFileRequestCount += 1;
      return jsonResponse({ ok: true, files: [{ path: "result.md", kind: "file" }] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const passiveLoad = store.loadArtifact(ctx, workspaceId, artifact.id as any, {
    attachToNodeState: false,
    loadFiles: false,
  });
  const activeLoad = store.loadArtifact(ctx, workspaceId, artifact.id as any, {
    attachToNodeState: true,
    loadFiles: true,
  });
  artifactResponse.resolve(jsonResponse({ ok: true, artifact }));

  await Promise.all([passiveLoad, activeLoad]);

  assert.equal(artifactRequestCount, 1);
  assert.equal(artifactFileRequestCount, 1);
  assert.deepEqual(store.selectedInstance?.nodeStates.analysis?.outputArtifactIds, [artifact.id]);
  assert.deepEqual(store.selectedInstance?.artifactIndex?.analysis, [artifact.id]);
  assert.deepEqual(store.selectedArtifactFiles, [{ path: "result.md", kind: "file" }]);
});

test("instance load business failures reject with code and requestId while null success bodies return null", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-instance-errors" as any;
  let responseBody: Record<string, unknown> = {
    ok: false,
    message: "实例读取失败",
    code: "ORCH_INSTANCE_READ_FAILED",
    requestId: "req-instance-failed",
  };

  store.resetForWorkspace(workspaceId);
  globalThis.fetch = (async () => jsonResponse(responseBody)) as typeof fetch;

  for (const load of [
    () => store.loadInstance(ctx, workspaceId, "instance-selected-error" as any),
    () => store.loadTrackedInstance(ctx, workspaceId, "instance-tracked-error" as any),
    () => store.loadTrackedInstanceRuntimePatch(ctx, workspaceId, "instance-runtime-error" as any),
  ]) {
    await assert.rejects(load, (error: any) => {
      assert.equal(error.code, "ORCH_INSTANCE_READ_FAILED");
      assert.equal(error.requestId, "req-instance-failed");
      return true;
    });
  }

  responseBody = { ok: true, instance: null, patch: null };
  assert.equal(await store.loadInstance(ctx, workspaceId, "instance-selected-null" as any), null);
  assert.equal(await store.loadTrackedInstance(ctx, workspaceId, "instance-tracked-null" as any), null);
  assert.equal(await store.loadTrackedInstanceRuntimePatch(ctx, workspaceId, "instance-runtime-null" as any), null);
});

test("concurrent plain instance load does not inherit detail failure and diagnostic fields stay paired", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-concurrent-detail-error" as any;
  const instance = buildInstance("instance-concurrent-detail-error");
  const instanceResponse = deferred<Response>();
  let instanceRequestCount = 0;

  store.resetForWorkspace(workspaceId);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/instances/get") {
      instanceRequestCount += 1;
      return await instanceResponse.promise;
    }
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({
        ok: false,
        message: "产物详情读取失败",
        code: "ORCH_ARTIFACT_DETAILS_FAILED",
      });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({
        ok: false,
        message: "事件详情读取失败",
        code: "ORCH_EVENT_DETAILS_FAILED",
        requestId: "req-event-details",
      });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const detailedLoad = store.loadInstance(ctx, workspaceId, instance.id as any, {
    force: true,
    loadDetails: true,
  });
  const detailedRejection = assert.rejects(detailedLoad, (error: any) => {
    assert.equal(error.code, "ORCH_ARTIFACT_DETAILS_FAILED");
    assert.equal(error.requestId, null);
    return true;
  });
  const plainLoad = store.loadInstance(ctx, workspaceId, instance.id as any);

  instanceResponse.resolve(jsonResponse({ ok: true, instance }));

  assert.equal((await plainLoad)?.id, instance.id);
  await detailedRejection;
  assert.equal(instanceRequestCount, 1);
  assert.equal(store.selectedInstance?.id, instance.id);
});

test("loadSelectedInstanceDetails keeps partial detail state and rejects with diagnostic fields", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-detail-errors" as any;
  const instance = buildInstance("instance-detail-errors");

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({
        ok: true,
        artifacts: [{
          ...buildArtifact(instance.id, "artifact-partial-success"),
          contentJson: JSON.stringify({ mode: "text", text: "partial success" }),
        }],
      });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({
        ok: false,
        message: "事件详情读取失败",
        code: "ORCH_EVENT_DETAILS_FAILED",
        requestId: "req-event-details",
      });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({
        ok: true,
        snapshots: [{
          id: "prompt-partial-success",
          workspaceId,
          instanceId: instance.id,
          nodeId: "analysis",
          contentLoaded: false,
          createdAt: 30,
        }],
      });
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      return jsonResponse({ ok: true, files: [{ path: "analysis.md", kind: "file" }] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await assert.rejects(
    store.loadSelectedInstanceDetails(ctx, workspaceId, instance.id as any),
    (error: any) => {
      assert.equal(error.code, "ORCH_EVENT_DETAILS_FAILED");
      assert.equal(error.requestId, "req-event-details");
      return true;
    },
  );
  assert.equal(store.selectedInstanceDetailErrors.events, "事件详情读取失败");
  assert.equal(store.selectedInstanceDetailErrors.artifacts, undefined);
  assert.equal(store.selectedInstanceDetailErrors.promptSnapshots, undefined);
  assert.equal(store.selectedInstanceArtifacts[0]?.id, "artifact-partial-success");
  assert.equal(store.selectedInstancePromptSnapshots[0]?.id, "prompt-partial-success");
  assert.equal(store.selectedInstance?.id, instance.id);
  assert.equal(store.selectedInstanceId, instance.id);
  assert.equal(store.selectedInstanceDetailsLoading, false);
  assert.equal(typeof store.selectedInstanceDetailsLoadedAt, "number");
});

test("stale detail hydration stops before deriving artifact file requests after a workspace reset", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceA = "client-a:ws-stale-artifact-a" as any;
  const workspaceB = "client-b:ws-stale-artifact-b" as any;
  const instance = buildInstance("instance-stale-artifact");
  const artifact = buildArtifact(instance.id, "artifact-stale-detail");
  const artifactBodyStarted = deferred<void>();
  const artifactBodyResponse = deferred<Response>();
  let artifactFileRequestCount = 0;

  store.resetForWorkspace(workspaceA);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/artifacts/list") {
      return jsonResponse({ ok: true, artifacts: [artifact] });
    }
    if (url.pathname === "/api/orch/events/list") {
      return jsonResponse({ ok: true, events: [] });
    }
    if (url.pathname === "/api/orch/prompt-snapshots/list") {
      return jsonResponse({ ok: true, snapshots: [] });
    }
    if (url.pathname === "/api/orch/artifacts/get") {
      artifactBodyStarted.resolve(undefined);
      return await artifactBodyResponse.promise;
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      artifactFileRequestCount += 1;
      return jsonResponse({ ok: true, files: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const pending = store.loadSelectedInstanceDetails(ctx, workspaceA, instance.id as any);
  await artifactBodyStarted.promise;
  store.resetForWorkspace(workspaceB);
  artifactBodyResponse.resolve(jsonResponse({
    ok: true,
    artifact: {
      ...artifact,
      contentJson: JSON.stringify({ mode: "text", text: "stale detail" }),
    },
  }));

  await pending;

  assert.equal(artifactFileRequestCount, 0);
  assert.equal(store.selectedInstance, null);
  assert.deepEqual(store.selectedInstanceArtifacts, []);
  assert.deepEqual(store.selectedArtifactFiles, []);
});

test("detail list hydration rechecks visibility before deriving artifact body or file requests", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-detail-hidden" as any;
  const instance = buildInstance("instance-detail-hidden");
  const artifact = buildArtifact(instance.id, "artifact-detail-hidden");
  const artifactListStarted = deferred<void>();
  const artifactListResponse = deferred<Response>();
  const requestPaths: string[] = [];
  let allowNetworkHydration = true;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    if (url.pathname === "/api/orch/artifacts/list") {
      artifactListStarted.resolve(undefined);
      return await artifactListResponse.promise;
    }
    if (url.pathname === "/api/orch/events/list") return jsonResponse({ ok: true, events: [] });
    if (url.pathname === "/api/orch/prompt-snapshots/list") return jsonResponse({ ok: true, snapshots: [] });
    throw new Error(`unexpected derived request: ${url.pathname}`);
  }) as typeof fetch;

  const pending = store.loadSelectedInstanceDetails(ctx, workspaceId, instance.id as any, {
    allowNetworkHydration: () => allowNetworkHydration,
  });
  await artifactListStarted.promise;
  allowNetworkHydration = false;
  artifactListResponse.resolve(jsonResponse({ ok: true, artifacts: [artifact] }));
  await pending;

  assert.deepEqual(new Set(requestPaths), new Set([
    "/api/orch/artifacts/list",
    "/api/orch/events/list",
    "/api/orch/prompt-snapshots/list",
  ]));
  assert.equal(requestPaths.length, 3);
  assert.equal(store.selectedArtifactId, artifact.id);
  assert.deepEqual(store.selectedArtifactFiles, []);
  assert.equal(typeof store.selectedInstanceDetailsLoadedAt, "number");
});

test("concurrent detail callers contribute their own dynamic hydration guards", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-detail-guard-isolation" as any;
  const instance = buildInstance("instance-detail-guard-isolation");
  const artifact = buildArtifact(instance.id, "artifact-detail-guard-isolation");
  const artifactListStarted = deferred<void>();
  const artifactListResponse = deferred<Response>();
  let artifactBodyRequestCount = 0;
  let artifactFileRequestCount = 0;
  let firstCallerAllowsHydration = true;
  let secondCallerAllowsHydration = true;

  store.resetForWorkspace(workspaceId);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.instances = [structuredClone(instance)] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/orch/artifacts/list") {
      artifactListStarted.resolve(undefined);
      return await artifactListResponse.promise;
    }
    if (url.pathname === "/api/orch/events/list") return jsonResponse({ ok: true, events: [] });
    if (url.pathname === "/api/orch/prompt-snapshots/list") return jsonResponse({ ok: true, snapshots: [] });
    if (url.pathname === "/api/orch/artifacts/get") {
      artifactBodyRequestCount += 1;
      return jsonResponse({ ok: true, artifact });
    }
    if (url.pathname === "/api/orch/artifact-files/list") {
      artifactFileRequestCount += 1;
      return jsonResponse({ ok: true, files: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const first = store.loadSelectedInstanceDetails(ctx, workspaceId, instance.id as any, {
    allowNetworkHydration: () => firstCallerAllowsHydration,
  });
  await artifactListStarted.promise;
  firstCallerAllowsHydration = false;
  const second = store.loadSelectedInstanceDetails(ctx, workspaceId, instance.id as any, {
    allowNetworkHydration: () => secondCallerAllowsHydration,
  });
  artifactListResponse.resolve(jsonResponse({ ok: true, artifacts: [artifact] }));

  await Promise.all([first, second]);

  assert.equal(firstCallerAllowsHydration, false);
  assert.equal(secondCallerAllowsHydration, true);
  assert.equal(artifactBodyRequestCount, 1);
  assert.equal(artifactFileRequestCount, 1);
});

test("artifact, artifact-file, and prompt loads reject business failures while null success bodies return null", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-detail-load-errors" as any;
  let responseBody: Record<string, unknown> = {
    ok: false,
    message: "详情正文读取失败",
    code: "ORCH_DETAIL_BODY_FAILED",
    requestId: "req-detail-body",
  };

  store.resetForWorkspace(workspaceId);
  store.selectedArtifactId = "artifact-file-error" as any;
  globalThis.fetch = (async () => jsonResponse(responseBody)) as typeof fetch;

  for (const load of [
    () => store.loadArtifact(ctx, workspaceId, "artifact-error" as any),
    () => store.loadPromptSnapshot(ctx, workspaceId, "prompt-error"),
    () => store.loadArtifactFiles(ctx, workspaceId, "artifact-file-error" as any),
  ]) {
    await assert.rejects(load, (error: any) => {
      assert.equal(error.code, "ORCH_DETAIL_BODY_FAILED");
      assert.equal(error.requestId, "req-detail-body");
      return true;
    });
  }
  assert.equal(store.selectedInstanceDetailErrors.artifactFiles, "详情正文读取失败");

  responseBody = { ok: true, artifact: null, snapshot: null, files: [] };
  assert.equal(await store.loadArtifact(ctx, workspaceId, "artifact-null" as any), null);
  assert.equal(await store.loadPromptSnapshot(ctx, workspaceId, "prompt-null"), null);
});

test("artifact metadata becomes available before slow event details finish", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-fast-artifact-list");
  const artifact = buildArtifact(instance.id, "artifact-fast-list");
  const events = deferred<Response>();
  let allowNetworkHydration = true;
  store.resetForWorkspace(instance.workspaceId as any);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/orch/artifacts/list") return jsonResponse({ ok: true, artifacts: [artifact] });
    if (path === "/api/orch/events/list") return await events.promise;
    if (path === "/api/orch/prompt-snapshots/list") return jsonResponse({ ok: true, snapshots: [] });
    throw new Error(`unexpected derived request: ${path}`);
  }) as typeof fetch;
  const pending = store.loadSelectedInstanceDetails(createApiContext(), instance.workspaceId as any, instance.id as any, {
    allowNetworkHydration: () => allowNetworkHydration,
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.selectedInstanceArtifacts[0]?.id, artifact.id);
    assert.equal(store.selectedInstanceDetailsLoading, true);
  } finally {
    allowNetworkHydration = false;
    events.resolve(jsonResponse({ ok: true, events: [] }));
    await pending;
  }
});

test("metadata refresh preserves loaded artifact bodies until their version or update time changes", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-body-cache");
  const artifact = buildArtifact(instance.id, "artifact-body-cache");
  const contentJson = JSON.stringify({ mode: "text", text: "cached body" });
  let updatedAt = artifact.updatedAt;
  let bodyRequests = 0;
  store.resetForWorkspace(instance.workspaceId as any);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.selectedInstanceArtifacts = [{ ...artifact, contentJson }] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/orch/artifacts/list") return jsonResponse({ ok: true, artifacts: [{ ...artifact, title: "latest metadata", updatedAt }] });
    if (path === "/api/orch/events/list") return jsonResponse({ ok: true, events: [] });
    if (path === "/api/orch/prompt-snapshots/list") return jsonResponse({ ok: true, snapshots: [] });
    if (path === "/api/orch/artifact-files/list") return jsonResponse({ ok: true, files: [] });
    if (path === "/api/orch/artifacts/get") {
      bodyRequests += 1;
      return jsonResponse({ ok: true, artifact: { ...artifact, updatedAt, contentJson: JSON.stringify({ mode: "text", text: "updated body" }) } });
    }
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  await store.loadSelectedInstanceDetails(createApiContext(), instance.workspaceId as any, instance.id as any);
  assert.equal(bodyRequests, 0);
  assert.equal(store.selectedInstanceArtifacts[0]?.contentJson, contentJson);
  assert.equal(store.selectedInstanceArtifacts[0]?.title, "latest metadata");
  updatedAt += 1;
  await store.loadSelectedInstanceDetails(createApiContext(), instance.workspaceId as any, instance.id as any, { force: true });
  assert.equal(bodyRequests, 1);
  assert.match(store.selectedInstanceArtifacts[0]!.contentJson!, /updated body/);
});

test("concurrent artifact file readers receive the same index from one request", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const workspaceId = "client-a:ws-index-share" as any;
  store.resetForWorkspace(workspaceId);
  const response = deferred<Response>();
  let requests = 0;
  globalThis.fetch = (async () => { requests += 1; return await response.promise; }) as typeof fetch;
  const first = store.loadArtifactFiles(createApiContext(), workspaceId, "artifact-shared-index" as any);
  const second = store.loadArtifactFiles(createApiContext(), workspaceId, "artifact-shared-index" as any);
  response.resolve(jsonResponse({ ok: true, files: [], fields: [] }));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.deepEqual(left, { files: [], fields: [] });
  assert.equal(left, right);
});

test("detail hydration reuses an already loaded file index for the same artifact revision", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-index-cache");
  const artifact = { ...buildArtifact(instance.id, "artifact-index-cache"), contentJson: JSON.stringify({ mode: "text", text: "body" }) };
  let fileRequests = 0;
  store.resetForWorkspace(instance.workspaceId);
  store.selectedInstanceId = instance.id;
  store.selectedInstance = instance as any;
  store.selectedInstanceArtifacts = [artifact] as any;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/orch/artifact-files/list") { fileRequests++; return jsonResponse({ ok: true, files: [], fields: [] }); }
    if (path === "/api/orch/artifacts/list") return jsonResponse({ ok: true, artifacts: [{ ...artifact, contentJson: "" }] });
    if (path === "/api/orch/events/list") return jsonResponse({ ok: true, events: [] });
    if (path === "/api/orch/prompt-snapshots/list") return jsonResponse({ ok: true, snapshots: [] });
    throw new Error(`unexpected request: ${path}`);
  }) as typeof fetch;
  const index = await store.loadArtifactFiles(createApiContext(), instance.workspaceId, artifact.id as any);
  await store.loadSelectedInstanceDetails(createApiContext(), instance.workspaceId, instance.id);
  assert.equal(fileRequests, 1);
  assert.equal(await store.loadArtifactFiles(createApiContext(), instance.workspaceId, artifact.id as any), index);
  assert.deepEqual(store.selectedArtifactFiles, []);
});

test("a newer artifact revision does not reuse or accept an older pending file index", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-index-revision");
  const artifact = buildArtifact(instance.id, "artifact-index-revision");
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let requests = 0;
  store.resetForWorkspace(instance.workspaceId);
  store.selectedInstanceArtifacts = [artifact] as any;
  store.selectedArtifactId = artifact.id as any;
  globalThis.fetch = (async () => await (++requests === 1 ? oldResponse.promise : newResponse.promise)) as typeof fetch;
  const first = store.loadArtifactFiles(createApiContext(), instance.workspaceId, artifact.id as any);
  store.selectedInstanceArtifacts = [{ ...artifact, updatedAt: artifact.updatedAt + 1 }] as any;
  const second = store.loadArtifactFiles(createApiContext(), instance.workspaceId, artifact.id as any);
  const freshFile = { id: "fresh-file", artifactId: artifact.id, publishedPath: "docs/new.md" };
  newResponse.resolve(jsonResponse({ ok: true, files: [freshFile] }));
  assert.deepEqual((await second)?.files, [freshFile]);
  oldResponse.resolve(jsonResponse({ ok: true, files: [{ id: "old-file", artifactId: artifact.id, stagingPath: "staging/old.md" }] }));
  assert.equal(await first, null);
  assert.equal(requests, 2);
  assert.deepEqual(store.selectedArtifactFiles, [freshFile]);
  assert.deepEqual((await store.loadArtifactFiles(createApiContext(), instance.workspaceId, artifact.id as any))?.files, [freshFile]);
  assert.equal(requests, 2);
});

test("failed file indexes can be retried and completed indexes expire on workspace reset", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const artifact = buildArtifact("instance-index-retry", "artifact-index-retry");
  const workspaceId = "client-a:ws-demo" as any;
  let requests = 0;
  store.resetForWorkspace(workspaceId);
  store.selectedInstanceArtifacts = [artifact] as any;
  globalThis.fetch = (async () => jsonResponse(++requests === 1
    ? { ok: false, code: "INDEX_FAILED", message: "index unavailable", requestId: "req-index-retry" }
    : { ok: true, files: [], fields: [] })) as typeof fetch;
  await assert.rejects(store.loadArtifactFiles(createApiContext(), workspaceId, artifact.id as any), /index unavailable/);
  assert.deepEqual(await store.loadArtifactFiles(createApiContext(), workspaceId, artifact.id as any), { files: [], fields: [] });
  assert.equal(requests, 2);
  store.resetForWorkspace(workspaceId);
  store.selectedInstanceArtifacts = [artifact] as any;
  await store.loadArtifactFiles(createApiContext(), workspaceId, artifact.id as any);
  assert.equal(requests, 3);
});

test("late artifact bodies cannot overwrite newer metadata from a refresh", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const instance = buildInstance("instance-body-revision-race");
  const artifact = buildArtifact(instance.id, "artifact-body-revision-race");
  const response = deferred<Response>();
  store.resetForWorkspace(instance.workspaceId as any);
  store.selectedInstanceId = instance.id as any;
  store.selectedInstance = instance as any;
  store.selectedInstanceArtifacts = [artifact] as any;
  globalThis.fetch = (async () => await response.promise) as typeof fetch;
  const pending = store.loadArtifact(createApiContext(), instance.workspaceId as any, artifact.id as any, {
    attachToNodeState: false, loadFiles: false,
  });
  store.selectedInstanceArtifacts = [{ ...artifact, updatedAt: artifact.updatedAt + 1 }] as any;
  response.resolve(jsonResponse({ ok: true, artifact: { ...artifact, contentJson: "old body" } }));
  assert.equal(await pending, null);
  assert.equal(store.selectedInstanceArtifacts[0]?.updatedAt, artifact.updatedAt + 1);
  assert.equal(store.selectedInstanceArtifacts[0]?.contentJson, artifact.contentJson);
});

test("planner hydration coordinator preserves a user edit made while hydration is pending", async () => {
  const hydration = deferred<void>();
  let draftRevision = 1;
  let draftValue = "saved value";
  let applyCount = 0;
  const startRevision = draftRevision;

  const pending = (async () => {
    await hydration.promise;
    return await applyHydratedPlannerDraftIfCurrent({
      active: true,
      startHydrationKey: "workspace::mine",
      currentHydrationKey: "workspace::mine",
      startIntakeId: "intake-a",
      currentIntakeId: "intake-a",
      startSelectionGeneration: 1,
      currentSelectionGeneration: 1,
      startDraftRevision: startRevision,
      currentDraftRevision: draftRevision,
    }, () => {
      applyCount += 1;
      draftValue = "server value";
    });
  })();

  draftValue = "user value";
  draftRevision += 1;
  hydration.resolve();
  assert.equal(await pending, false);
  assert.equal(applyCount, 0);
  assert.equal(draftValue, "user value");

  assert.equal(await applyHydratedPlannerDraftIfCurrent({
    active: true,
    startHydrationKey: "workspace::mine",
    currentHydrationKey: "workspace::mine",
    startIntakeId: "intake-a",
    currentIntakeId: "intake-a",
    startSelectionGeneration: 1,
    currentSelectionGeneration: 1,
    startDraftRevision: draftRevision,
    currentDraftRevision: draftRevision,
  }, () => {
    applyCount += 1;
    draftValue = "clean apply";
  }), true);
  assert.equal(applyCount, 1);
  assert.equal(draftValue, "clean apply");
});
