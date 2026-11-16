import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCancelledRequestError } from "../src/api/request.ts";
import {
  DEFAULT_THREAD_AUTO_CREATE_WAIT_LOG_INTERVAL_MS,
  clearDefaultThreadAutoCreateAttemptCache,
  hasDefaultThreadAutoCreateAttempted,
  markDefaultThreadAutoCreateAttempted,
  resolveDefaultThreadAutoCreateEngine,
  resolveDefaultThreadAutoCreateEnvironment,
  resolveDefaultThreadAutoCreateFailureMessage,
  resolveDefaultThreadAutoCreateMarkerKey,
  resolveDefaultThreadAutoCreatePrecheck,
  runDefaultThreadAutoCreate,
  sanitizeDefaultThreadAutoCreateReason,
  shouldLogDefaultThreadAutoCreateWait,
  type DefaultThreadAutoCreateMarkerInput,
  type DefaultThreadAutoCreatePrecheckInput,
  type DefaultThreadAutoCreateRunInput,
} from "../src/store/defaultThreadAutoCreate.ts";

const markerInput: DefaultThreadAutoCreateMarkerInput = {
  serverWsOrigin: "ws://example.test",
  userId: "user-1",
  workspaceId: "client-a:repo",
};

const readyPrecheck: DefaultThreadAutoCreatePrecheckInput = {
  isPublicView: false,
  isAccountSession: true,
  hasActiveSession: true,
  logoutInProgress: false,
  connected: true,
  workspaceId: "client-a:repo",
  workspaceKind: "local",
  clientStatus: "online",
  workspacePhase: "settled",
  activatedWorkspaceId: "client-a:repo",
  workspaceDegraded: false,
  keysPhase: "success",
  activeProviderIdsByEngine: { codex: ["openai"], claude: [] },
  disabledEngines: {},
};

test("真实本机运行态可启动默认会话评估且不会借用账号标记", () => {
  assert.deepEqual(resolveDefaultThreadAutoCreateEnvironment({ ...readyPrecheck, localReady: true,
    isAccountSession: false, hasActiveSession: false, connected: false }), { status: "ready" });
  assert.deepEqual(resolveDefaultThreadAutoCreateEnvironment({ ...readyPrecheck, localReady: false,
    isAccountSession: false, hasActiveSession: false, connected: false }), { status: "wait", reason: "no-session" });
  assert.notEqual(resolveDefaultThreadAutoCreateMarkerKey({ serverWsOrigin: "", userId: "", workspaceId: "desktop:project", desktopClientId: "desktop" }), null);
  assert.notEqual(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, desktopClientId: "desktop" }), resolveDefaultThreadAutoCreateMarkerKey(markerInput));
});

/** 用最小 window 替身驱动 localStorage 分支，返回还原函数。 */
function installFakeWindow(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }): () => void {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return () => {
    (globalThis as { window?: unknown }).window = original;
  };
}

/** 记录调用顺序的编排依赖，用于验证"消耗发生在创建之前"。 */
function createRunHarness(options: {
  precheck?: DefaultThreadAutoCreatePrecheckInput;
  environmentWaits?: boolean;
  attempted?: boolean;
  shouldApply?: boolean;
  /** 探测返回后作用域失效（模拟探测期间切换工作区）。 */
  dropScopeAfterProbe?: boolean;
  prepareThrows?: boolean;
  recheckWaits?: boolean;
  hasThreads?: boolean;
  probeThrows?: boolean;
  create?: () => Promise<string>;
} = {}) {
  const calls: string[] = [];
  let attempted = options.attempted ?? false;
  const input = options.precheck ?? readyPrecheck;
  const deps: DefaultThreadAutoCreateRunInput = {
    readAttempted: () => {
      calls.push("read");
      return attempted;
    },
    environment: () => {
      calls.push("environment");
      return options.environmentWaits
        ? { status: "wait", reason: "workspace-not-settled" } as const
        : resolveDefaultThreadAutoCreateEnvironment(input);
    },
    precheck: () => {
      calls.push("precheck");
      return options.recheckWaits
        ? { status: "wait", reason: "no-usable-engine" } as const
        : resolveDefaultThreadAutoCreatePrecheck(input);
    },
    shouldApply: () => {
      calls.push("apply");
      if (options.dropScopeAfterProbe && calls.includes("probe")) return false;
      return options.shouldApply ?? true;
    },
    prepareAvailability: async () => {
      calls.push("prepare");
      if (options.prepareThrows) throw new Error("prepare failed");
    },
    probeHasVisibleThreads: async () => {
      calls.push("probe");
      if (options.probeThrows) throw new Error("probe failed");
      return options.hasThreads ?? false;
    },
    markAttempted: () => {
      calls.push("mark");
      attempted = true;
    },
    createThread: async (engine) => {
      calls.push(`create:${engine}`);
      if (options.create) return await options.create() as never;
      return "thread-1" as never;
    },
  };
  return { deps, calls, hasAttempted: () => attempted };
}

test("marker key requires full account and workspace scope", () => {
  assert.equal(
    resolveDefaultThreadAutoCreateMarkerKey(markerInput),
    "codeflowai.default-thread.auto-create::ws%3A%2F%2Fexample.test::user-1::client-a%3Arepo",
  );
  assert.equal(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, serverWsOrigin: "" }), null);
  assert.equal(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, userId: " " }), null);
  assert.equal(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, workspaceId: "" }), null);
  // 不同账号/工作区/服务端必须互不干扰，否则会误吞别人的那一次机会。
  const base = resolveDefaultThreadAutoCreateMarkerKey(markerInput);
  assert.notEqual(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, userId: "user-2" }), base);
  assert.notEqual(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, workspaceId: "client-a:other" }), base);
  assert.notEqual(resolveDefaultThreadAutoCreateMarkerKey({ ...markerInput, serverWsOrigin: "ws://other.test" }), base);
});

test("marker read and write use localStorage while memory cache covers broken storage", () => {
  clearDefaultThreadAutoCreateAttemptCache();
  const stored = new Map<string, string>();
  const restore = installFakeWindow({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
  });
  try {
    assert.equal(hasDefaultThreadAutoCreateAttempted(markerInput), false);
    markDefaultThreadAutoCreateAttempted(markerInput);
    assert.equal(stored.get(resolveDefaultThreadAutoCreateMarkerKey(markerInput) ?? ""), "1");
    clearDefaultThreadAutoCreateAttemptCache();
    assert.equal(hasDefaultThreadAutoCreateAttempted(markerInput), true);
  } finally {
    restore();
    clearDefaultThreadAutoCreateAttemptCache();
  }
});

test("marker write failure still consumes the single chance", () => {
  clearDefaultThreadAutoCreateAttemptCache();
  const restore = installFakeWindow({
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  });
  try {
    markDefaultThreadAutoCreateAttempted(markerInput);
    assert.equal(hasDefaultThreadAutoCreateAttempted(markerInput), true);
  } finally {
    restore();
    clearDefaultThreadAutoCreateAttemptCache();
  }
});

test("environment waits on every unmet precondition and stays ready otherwise", () => {
  assert.deepEqual(resolveDefaultThreadAutoCreateEnvironment(readyPrecheck), { status: "ready" });
  const cases: Array<[Partial<DefaultThreadAutoCreatePrecheckInput>, string]> = [
    [{ isPublicView: true }, "public-view"],
    [{ isAccountSession: false }, "no-session"],
    [{ hasActiveSession: false }, "no-session"],
    [{ logoutInProgress: true }, "logging-out"],
    [{ connected: false }, "disconnected"],
    [{ workspaceId: "  " }, "no-workspace"],
    [{ workspaceKind: "unknown" }, "workspace-unknown"],
    [{ workspaceKind: "shared" }, "shared-workspace"],
    [{ clientStatus: "offline" }, "client-offline"],
    [{ clientStatus: "unknown" }, "client-offline"],
    [{ workspacePhase: "idle" }, "workspace-not-settled"],
    [{ workspacePhase: "critical" }, "workspace-not-settled"],
    [{ activatedWorkspaceId: "client-a:other" }, "workspace-not-settled"],
    [{ activatedWorkspaceId: null }, "workspace-not-settled"],
    [{ workspaceDegraded: true }, "workspace-degraded"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(
      resolveDefaultThreadAutoCreateEnvironment({ ...readyPrecheck, ...patch }),
      { status: "wait", reason },
      `patch=${JSON.stringify(patch)}`,
    );
  }
});

test("precheck adds key readiness and engine availability on top of the environment", () => {
  assert.deepEqual(resolveDefaultThreadAutoCreatePrecheck(readyPrecheck), { status: "ready", engine: "codex" });
  for (const keysPhase of ["unknown", "loading", "error"] as const) {
    assert.deepEqual(
      resolveDefaultThreadAutoCreatePrecheck({ ...readyPrecheck, keysPhase }),
      { status: "wait", reason: "keys-not-loaded" },
    );
  }
  assert.deepEqual(
    resolveDefaultThreadAutoCreatePrecheck({
      ...readyPrecheck,
      activeProviderIdsByEngine: { codex: [], claude: [] },
    }),
    { status: "wait", reason: "no-usable-engine" },
  );
});

test("engine selection prefers codex and only counts active keys outside disabled engines", () => {
  assert.equal(resolveDefaultThreadAutoCreateEngine({
    activeProviderIdsByEngine: { codex: ["openai"], claude: ["anthropic"] },
    disabledEngines: {},
  }), "codex");
  assert.equal(resolveDefaultThreadAutoCreateEngine({
    activeProviderIdsByEngine: { codex: [], claude: ["anthropic"] },
    disabledEngines: {},
  }), "claude");
  // codex 有 Key 但被新建弹窗判定为不可用：回落 claude，避免白烧那一次机会。
  assert.equal(resolveDefaultThreadAutoCreateEngine({
    activeProviderIdsByEngine: { codex: ["openai"], claude: ["anthropic"] },
    disabledEngines: { codex: "Codex 未启用" },
  }), "claude");
  assert.equal(resolveDefaultThreadAutoCreateEngine({
    activeProviderIdsByEngine: { codex: ["openai"], claude: ["anthropic"] },
    disabledEngines: { codex: "不可用", claude: "不可用" },
  }), null);
  assert.equal(resolveDefaultThreadAutoCreateEngine({
    activeProviderIdsByEngine: { codex: [], claude: [] },
    disabledEngines: {},
  }), null);
});

test("an already attempted scope is never retried automatically", async () => {
  const harness = createRunHarness({ attempted: true });
  assert.equal((await runDefaultThreadAutoCreate(harness.deps)).outcome, "already-attempted");
  assert.equal(harness.calls.includes("probe"), false);
  assert.equal(harness.calls.includes("create:codex"), false);
});

test("unmet preconditions and scope changes never consume the chance", async () => {
  const noEngine = createRunHarness({
    precheck: { ...readyPrecheck, activeProviderIdsByEngine: { codex: [], claude: [] } },
  });
  const noEngineResult = await runDefaultThreadAutoCreate(noEngine.deps);
  assert.deepEqual(noEngineResult, { outcome: "wait", reason: "no-usable-engine" });
  assert.equal(noEngine.calls.includes("probe"), false);
  assert.equal(noEngine.calls.includes("mark"), false);
  assert.equal(noEngine.hasAttempted(), false);

  // 环境不满足时不得触碰引擎/Key 状态，更不能消耗机会。
  const environmentWaits = createRunHarness({ environmentWaits: true });
  assert.deepEqual(await runDefaultThreadAutoCreate(environmentWaits.deps), {
    outcome: "wait",
    reason: "workspace-not-settled",
  });
  assert.equal(environmentWaits.calls.includes("prepare"), false);
  assert.equal(environmentWaits.calls.includes("probe"), false);
  assert.equal(environmentWaits.calls.includes("mark"), false);

  const stale = createRunHarness({ shouldApply: false });
  assert.deepEqual(await runDefaultThreadAutoCreate(stale.deps), { outcome: "wait", reason: "scope-changed" });
  assert.equal(stale.calls.includes("prepare"), false);
  assert.equal(stale.calls.includes("mark"), false);

  const prepareFailed = createRunHarness({ prepareThrows: true });
  assert.deepEqual(await runDefaultThreadAutoCreate(prepareFailed.deps), { outcome: "wait", reason: "prepare-failed" });
  assert.equal(prepareFailed.calls.includes("probe"), false);
  assert.equal(prepareFailed.calls.includes("mark"), false);

  const recheckWaits = createRunHarness({ recheckWaits: true });
  assert.deepEqual(await runDefaultThreadAutoCreate(recheckWaits.deps), { outcome: "wait", reason: "no-usable-engine" });
  assert.equal(recheckWaits.calls.includes("probe"), false);
  assert.equal(recheckWaits.calls.includes("mark"), false);
});

test("key readiness is rechecked after the availability refresh, not before it", async () => {
  // 冷启动时没有任何链路会预先拉取 Key 列表，先卡 keys-not-loaded 会让功能永远停在等待上。
  const harness = createRunHarness();
  const result = await runDefaultThreadAutoCreate(harness.deps);
  assert.equal(result.outcome, "created");
  assert.ok(harness.calls.indexOf("prepare") < harness.calls.indexOf("precheck"), harness.calls.join(">"));

  const neverLoaded = createRunHarness({ precheck: { ...readyPrecheck, keysPhase: "unknown" } });
  assert.deepEqual(await runDefaultThreadAutoCreate(neverLoaded.deps), { outcome: "wait", reason: "keys-not-loaded" });
  assert.equal(neverLoaded.calls.includes("mark"), false);
});

test("a failed visible-thread probe waits without consuming the chance", async () => {
  const harness = createRunHarness({ probeThrows: true });
  const result = await runDefaultThreadAutoCreate(harness.deps);
  assert.deepEqual(result, { outcome: "wait", reason: "probe-failed" });
  assert.equal(harness.calls.includes("mark"), false);
  assert.equal(harness.hasAttempted(), false);
});

test("a scope change during the visible-thread probe waits without consuming the chance", async () => {
  // 探测是 await 点：期间切换工作区后，既不能消耗标记，也不能用旧 workspaceId 建会话。
  const switched = createRunHarness({ dropScopeAfterProbe: true });
  const switchedResult = await runDefaultThreadAutoCreate(switched.deps);
  assert.equal(switchedResult.outcome, "wait");
  assert.equal(switched.calls.includes("mark"), false);
  assert.equal(switched.calls.some((call) => call.startsWith("create:")), false);
  assert.equal(switched.hasAttempted(), false);

  // 旧作用域的“已有会话”终局判定对新作用域无意义：同样不消耗、不据此收尾。
  const switchedWithThreads = createRunHarness({ dropScopeAfterProbe: true, hasThreads: true });
  const threadsResult = await runDefaultThreadAutoCreate(switchedWithThreads.deps);
  assert.deepEqual(threadsResult, { outcome: "wait", reason: "scope-changed" });
  assert.equal(switchedWithThreads.calls.includes("mark"), false);
  assert.equal(switchedWithThreads.hasAttempted(), false);
});

test("an existing visible thread consumes the chance without creating a second one", async () => {
  const harness = createRunHarness({ hasThreads: true });
  const result = await runDefaultThreadAutoCreate(harness.deps);
  assert.deepEqual(result, { outcome: "wait", reason: "threads-exist" });
  assert.equal(harness.calls.filter((call) => call === "mark").length, 1);
  assert.equal(harness.calls.some((call) => call.startsWith("create:")), false);
  assert.equal(harness.hasAttempted(), true);
});

test("the ready path probes, consumes once, then creates with the chosen engine", async () => {
  const harness = createRunHarness();
  const result = await runDefaultThreadAutoCreate(harness.deps);
  assert.deepEqual(result, { outcome: "created", engine: "codex", threadId: "thread-1" });
  assert.equal(harness.calls.filter((call) => call === "mark").length, 1);
  assert.ok(harness.calls.indexOf("probe") < harness.calls.indexOf("mark"), harness.calls.join(">"));
  assert.ok(harness.calls.indexOf("mark") < harness.calls.indexOf("create:codex"), harness.calls.join(">"));
  assert.equal(harness.hasAttempted(), true);
});

test("creation failures stay consumed and are reported with a sanitized reason", async () => {
  const failed = createRunHarness({
    create: () => Promise.reject(new Error("读取 https://relay.internal/api/threads 失败")),
  });
  const failedResult = await runDefaultThreadAutoCreate(failed.deps);
  assert.equal(failedResult.outcome, "failed");
  if (failedResult.outcome !== "failed") throw new Error("预期默认会话创建失败");
  assert.equal(failedResult.failure.codeGroup, "request_error");
  assert.equal(failedResult.failure.message, "读取 （地址已隐藏） 失败");
  assert.equal(failed.hasAttempted(), true);

  const cancelled = createRunHarness({ create: () => Promise.reject(createCancelledRequestError("scope-change")) });
  const cancelledResult = await runDefaultThreadAutoCreate(cancelled.deps);
  assert.deepEqual(cancelledResult, { outcome: "interrupted", engine: "codex" });
  assert.equal("failure" in cancelledResult ? cancelledResult.failure : undefined, undefined);
  assert.equal(cancelled.hasAttempted(), true);
});

test("failure classification covers the registered boundaries", () => {
  assert.equal(
    resolveDefaultThreadAutoCreateFailureMessage(new Error("CLIENT_OFFLINE 当前工作区 Client 未在线")),
    "当前工作区 Client 未在线",
  );
  assert.equal(resolveDefaultThreadAutoCreateFailureMessage(new Error("   ")), "默认会话创建失败");
});

test("failure reasons are masked and truncated", () => {
  assert.equal(
    sanitizeDefaultThreadAutoCreateReason("读取 https://relay.internal/api/threads 失败"),
    "读取 （地址已隐藏） 失败",
  );
  assert.match(sanitizeDefaultThreadAutoCreateReason("Key codeflowai_ABCDEFGHIJKLMNOP 无效"), /（Key 已隐藏）/u);
  assert.doesNotMatch(sanitizeDefaultThreadAutoCreateReason("Key codeflowai_E2E_DEFAULT_KEY_0123456789 无效"), /codeflowai_E2E/u);
  assert.doesNotMatch(sanitizeDefaultThreadAutoCreateReason("Key codeflowai_ab-cd_ef-12345678 无效"), /codeflowai_ab-cd/u);
  assert.equal(sanitizeDefaultThreadAutoCreateReason("   "), "");
  assert.ok(sanitizeDefaultThreadAutoCreateReason("长".repeat(400)).length <= 121);
});

test("auto creation is wired into the shell and stays inside the existing boundaries", () => {
  const shellSource = readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8");
  assert.match(shellSource, /useDefaultThreadAutoCreate\(\{ publicMainViews: PUBLIC_SITE_MAIN_VIEWS \}\)/u);
  const composableSource = readFileSync(new URL("../src/features/threads/useDefaultThreadAutoCreate.ts", import.meta.url), "utf8");
  // 复用唯一创建入口与既有引擎可用性判定，不新造并行机制。
  assert.match(composableSource, /chat\.createThread\(ctx\.value/u);
  assert.match(composableSource, /useCreateThreadEngineAvailability\(workspaceId\)/u);
  // 自动链路不得复用会弹用户可见提示的 refreshEngineAvailability，避免后台重试反复打扰。
  assert.doesNotMatch(composableSource, /refreshEngineAvailability\(\)/u);
  // 触发源不得包含被本链路自己改写的 Key 列表状态，否则会"刷新→再评估→再刷新"自我触发。
  assert.doesNotMatch(composableSource, /engineKeys\.lastUpdatedAt/u);
  const watchBlock = composableSource.slice(composableSource.indexOf("watch("), composableSource.indexOf("immediate: true"));
  assert.ok(watchBlock.length > 0, "watch 触发源必须存在");
  assert.doesNotMatch(watchBlock, /scopeSnapshot|keysPhase/u);
  // 只选本次自己创建的会话，绝不回退到"列表第一条"。
  assert.match(composableSource, /chat\.selectPrimaryThread\(threadId, \{ route: routeMode \}\)/u);
  assert.doesNotMatch(composableSource, /threads\[0\]/u);
  // 作用域失效时必须真正取消在飞探测：finally 里那次 abort 发生在 await 之后，是空操作。
  assert.match(composableSource, /function abortActiveRun\(kind: AbortKind\)/u);
  assert.match(composableSource, /abortActiveRun\("scope-change"\)/u);
  assert.match(composableSource, /abortActiveRun\("component-unmount"\)/u);
  assert.doesNotMatch(composableSource, /controller\.abort\(\)/u);
  // 本轮结论只对当轮作用域有效：上报前再过一次门禁（中间可插等待原因的诊断日志）。
  assert.match(composableSource, /if \(!shouldApply\(\)\) return;[\s\S]*reportOutcome\(result, runWorkspaceId\)/u);
  // 等待必须可诊断：三条等待路径都要留一条带原因与诊断维度的日志，且按窗口节流。
  assert.match(composableSource, /logWaitReason\(environment\.reason, "environment"\)/u);
  assert.match(composableSource, /logWaitReason\("already-attempted", "environment"\)/u);
  assert.match(composableSource, /logWaitReason\(result\.reason, "precheck"\)/u);
  assert.match(composableSource, /shouldLogDefaultThreadAutoCreateWait\(lastWaitLog, reason, currentWorkspaceId, now\)/u);
  // 安装向导已不再是前置条件：本链路不得再引用向导完成状态。
  assert.doesNotMatch(composableSource, /setupComplete|setup-incomplete/u);
});

test("wait logs are throttled per reason so waits stay diagnosable without spamming", () => {
  assert.equal(shouldLogDefaultThreadAutoCreateWait(null, "no-usable-engine", "client-a:repo", 1_000), true);
  const previous = { reason: "no-usable-engine", workspaceId: "client-a:repo", at: 1_000 };
  // 同工作区同原因在窗口内不重复记录。
  assert.equal(shouldLogDefaultThreadAutoCreateWait(previous, "no-usable-engine", "client-a:repo", 1_000 + 59_999), false);
  // 超出窗口或原因变化都要再记一条。
  assert.equal(shouldLogDefaultThreadAutoCreateWait(previous, "no-usable-engine", "client-a:repo", 1_000 + DEFAULT_THREAD_AUTO_CREATE_WAIT_LOG_INTERVAL_MS), true);
  assert.equal(shouldLogDefaultThreadAutoCreateWait(previous, "keys-not-loaded", "client-a:repo", 1_001), true);
  // 切到另一个同样卡住的工作区必须留一条，否则新工作区的卡点会被上一工作区的节流吞掉。
  assert.equal(shouldLogDefaultThreadAutoCreateWait(previous, "no-usable-engine", "client-a:other", 1_001), true);
});
