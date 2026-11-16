import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODEX_KEY_SWITCH_CONFLICT_REASONS } from "@codeflowai/shared";

import { createCancelledRequestError } from "../src/api/request.ts";
import {
  buildBuiltInRelayAutoEnableFailureNotice,
  buildBuiltInRelayAutoEnableSuccessNotice,
  classifyBuiltInRelayAutoEnableFailure,
  clearBuiltInRelayAutoEnableAttemptCache,
  hasBuiltInRelayAutoEnableAttempted,
  isBuiltInRelayAutoEnableRetryableError,
  isBuiltInRelayReadyForProvider,
  markBuiltInRelayAutoEnableAttempted,
  resolveBuiltInRelayAutoEnableEnvironment,
  resolveBuiltInRelayAutoEnableFailureMessage,
  resolveBuiltInRelayAutoEnableMarkerKey,
  resolveBuiltInRelayAutoEnablePrecheck,
  resolveBuiltInRelayAutoEnableScopeKey,
  runBuiltInRelayAutoEnable,
  sanitizeBuiltInRelayAutoEnableReason,
  type BuiltInRelayAutoEnableMarkerInput,
  type BuiltInRelayAutoEnablePrecheckInput,
  type BuiltInRelayAutoEnableRunInput,
} from "../src/store/builtInRelayAutoEnable.ts";

const markerInput: BuiltInRelayAutoEnableMarkerInput = {
  serverWsOrigin: "ws://example.test",
  userId: "user-1",
  workspaceId: "client-a:repo",
  providerId: "openai",
};

const readyPrecheck: BuiltInRelayAutoEnablePrecheckInput = {
  isPublicView: false,
  isAccountSession: true,
  hasActiveSession: true,
  logoutInProgress: false,
  connected: true,
  workspaceId: "client-a:repo",
  workspaceKind: "local",
  clientStatus: "online",
  keysPhase: "success",
  hasActiveKey: false,
  hasTargetRelayKey: false,
};

test("desktop automatic relay waits for Client hello even when Web and local runtime are connected", () => {
  assert.deepEqual(resolveBuiltInRelayAutoEnableEnvironment({ ...readyPrecheck, isDesktop: true, desktopCloudAccountLinked: false }), { status: "wait", reason: "account-unlinked" });
  assert.deepEqual(resolveBuiltInRelayAutoEnableEnvironment({ ...readyPrecheck, isDesktop: true, connected: false, desktopCloudAccountLinked: true }), { status: "ready" });
});

/** 用最小 window 替身驱动 localStorage 分支，返回还原函数。 */
function installFakeWindow(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }): () => void {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return () => {
    (globalThis as { window?: unknown }).window = original;
  };
}

/** 记录调用顺序的编排依赖，用于验证"消耗发生在首个写请求之前"。 */
function createRunHarness(options: {
  ready?: boolean;
  attempted?: boolean;
  shouldApply?: boolean;
  recheck?: boolean;
  probeThrows?: boolean;
  prepareThrows?: boolean;
  issue?: () => Promise<unknown>;
} = {}) {
  const calls: string[] = [];
  let attempted = options.attempted ?? false;
  const deps: BuiltInRelayAutoEnableRunInput = {
    readAttempted: () => {
      calls.push("read");
      return attempted;
    },
    markAttempted: () => {
      calls.push("mark");
      attempted = true;
    },
    probeRelayReady: async () => {
      calls.push("probe");
      if (options.probeThrows) throw new Error("probe failed");
      return options.ready ?? true;
    },
    prepareKeys: async () => {
      calls.push("prepare");
      if (options.prepareThrows) throw new Error("prepare failed");
    },
    issueEnable: async () => {
      calls.push("issue");
      if (options.issue) await options.issue();
    },
    shouldApply: () => {
      calls.push("apply");
      return options.shouldApply ?? true;
    },
    recheckPrecheck: () => {
      calls.push("recheck");
      return options.recheck ?? true;
    },
  };
  return { deps, calls, hasAttempted: () => attempted };
}

test("marker key requires full account and workspace scope", () => {
  assert.equal(
    resolveBuiltInRelayAutoEnableMarkerKey(markerInput),
    "codeflowai.relay.auto-enable::ws%3A%2F%2Fexample.test::user-1::client-a%3Arepo::openai",
  );
  assert.equal(resolveBuiltInRelayAutoEnableMarkerKey({ ...markerInput, serverWsOrigin: "" }), null);
  assert.equal(resolveBuiltInRelayAutoEnableMarkerKey({ ...markerInput, userId: " " }), null);
  assert.equal(resolveBuiltInRelayAutoEnableMarkerKey({ ...markerInput, workspaceId: "" }), null);
  assert.equal(resolveBuiltInRelayAutoEnableMarkerKey({ ...markerInput, providerId: "" }), null);
});

test("marker read and write use localStorage while memory cache covers broken storage", () => {
  clearBuiltInRelayAutoEnableAttemptCache();
  const stored = new Map<string, string>();
  const restore = installFakeWindow({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
  });
  try {
    assert.equal(hasBuiltInRelayAutoEnableAttempted(markerInput), false);
    markBuiltInRelayAutoEnableAttempted(markerInput);
    assert.equal(stored.get(resolveBuiltInRelayAutoEnableMarkerKey(markerInput) ?? ""), "1");
    clearBuiltInRelayAutoEnableAttemptCache();
    assert.equal(hasBuiltInRelayAutoEnableAttempted(markerInput), true);
  } finally {
    restore();
    clearBuiltInRelayAutoEnableAttemptCache();
  }
});

test("marker write failure still consumes the single chance", () => {
  clearBuiltInRelayAutoEnableAttemptCache();
  const restore = installFakeWindow({
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  });
  try {
    markBuiltInRelayAutoEnableAttempted(markerInput);
    assert.equal(hasBuiltInRelayAutoEnableAttempted(markerInput), true);
  } finally {
    restore();
    clearBuiltInRelayAutoEnableAttemptCache();
  }
});

test("precheck waits on every unmet precondition and stays ready otherwise", () => {
  assert.deepEqual(resolveBuiltInRelayAutoEnablePrecheck(readyPrecheck), { status: "ready" });
  const cases: Array<[Partial<BuiltInRelayAutoEnablePrecheckInput>, string]> = [
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
    [{ keysPhase: "unknown" }, "keys-not-loaded"],
    [{ keysPhase: "loading" }, "keys-not-loaded"],
    [{ keysPhase: "error" }, "keys-not-loaded"],
    [{ hasTargetRelayKey: true }, "built-in-key-exists"],
    [{ hasActiveKey: true }, "active-key-exists"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(
      resolveBuiltInRelayAutoEnablePrecheck({ ...readyPrecheck, ...patch }),
      { status: "wait", reason },
      `patch=${JSON.stringify(patch)}`,
    );
  }
});

test("relay readiness requires the target provider group on top of availability", () => {
  const base = { available: true, publicBaseUrl: "https://relay.example.test", providerGroupsConfigured: { openai: true } };
  assert.equal(isBuiltInRelayReadyForProvider(base, "openai"), true);
  assert.equal(isBuiltInRelayReadyForProvider({ ...base, providerGroupsConfigured: { openai: false } }, "openai"), false);
  assert.equal(isBuiltInRelayReadyForProvider({ ...base, providerGroupsConfigured: {} }, "openai"), false);
  assert.equal(isBuiltInRelayReadyForProvider({ ...base, providerGroupsConfigured: undefined }, "openai"), false);
  assert.equal(isBuiltInRelayReadyForProvider({ ...base, publicBaseUrl: "   " }, "openai"), false);
  assert.equal(isBuiltInRelayReadyForProvider({ ...base, available: false }, "openai"), false);
});

test("environment gate ignores key list state while the full precheck does not", () => {
  assert.deepEqual(resolveBuiltInRelayAutoEnableEnvironment(readyPrecheck), { status: "ready" });
  // 环境就绪但 Key 列表未加载：环境判定放行，完整判定仍等待（用于"中转就绪后才补刷 Key"）。
  assert.deepEqual(
    resolveBuiltInRelayAutoEnableEnvironment({ ...readyPrecheck, keysPhase: "unknown", hasActiveKey: true }),
    { status: "ready" },
  );
  assert.deepEqual(
    resolveBuiltInRelayAutoEnablePrecheck({ ...readyPrecheck, keysPhase: "unknown" }),
    { status: "wait", reason: "keys-not-loaded" },
  );
  assert.deepEqual(
    resolveBuiltInRelayAutoEnableEnvironment({ ...readyPrecheck, clientStatus: "offline" }),
    { status: "wait", reason: "client-offline" },
  );
});

test("ready run prepares the key list and consumes the chance before the first write request", async () => {
  const harness = createRunHarness();
  const result = await runBuiltInRelayAutoEnable(harness.deps);
  assert.equal(result.outcome, "issued");
  assert.equal(harness.calls.filter((call) => call === "mark").length, 1);
  assert.ok(harness.calls.indexOf("prepare") > harness.calls.indexOf("probe"), harness.calls.join(">"));
  assert.ok(harness.calls.indexOf("mark") < harness.calls.indexOf("issue"), harness.calls.join(">"));
  assert.equal(harness.hasAttempted(), true);
});

test("key list is never touched when the relay is not ready", async () => {
  const notReady = createRunHarness({ ready: false });
  assert.equal((await runBuiltInRelayAutoEnable(notReady.deps)).outcome, "wait");
  assert.equal(notReady.calls.includes("prepare"), false);
  assert.equal(notReady.calls.includes("mark"), false);
  assert.equal(notReady.calls.includes("issue"), false);
});

test("a failed key list refresh waits without consuming the chance", async () => {
  const harness = createRunHarness({ prepareThrows: true });
  assert.equal((await runBuiltInRelayAutoEnable(harness.deps)).outcome, "wait");
  assert.equal(harness.calls.includes("mark"), false);
  assert.equal(harness.hasAttempted(), false);
});

test("unmet preconditions never consume the chance", async () => {
  const notReady = createRunHarness({ ready: false });
  assert.equal((await runBuiltInRelayAutoEnable(notReady.deps)).outcome, "wait");
  assert.equal(notReady.calls.includes("mark"), false);
  assert.equal(notReady.calls.includes("issue"), false);
  assert.equal(notReady.hasAttempted(), false);

  const probeFailed = createRunHarness({ probeThrows: true });
  assert.equal((await runBuiltInRelayAutoEnable(probeFailed.deps)).outcome, "wait");
  assert.equal(probeFailed.calls.includes("mark"), false);

  const staleScope = createRunHarness({ shouldApply: false });
  assert.equal((await runBuiltInRelayAutoEnable(staleScope.deps)).outcome, "wait");
  assert.equal(staleScope.calls.includes("mark"), false);

  const changedPrecheck = createRunHarness({ recheck: false });
  assert.equal((await runBuiltInRelayAutoEnable(changedPrecheck.deps)).outcome, "wait");
  assert.equal(changedPrecheck.calls.includes("mark"), false);
});

test("an attempted scope is never retried automatically", async () => {
  const harness = createRunHarness({ attempted: true });
  assert.equal((await runBuiltInRelayAutoEnable(harness.deps)).outcome, "already-attempted");
  assert.equal(harness.calls.includes("probe"), false);
  assert.equal(harness.calls.includes("issue"), false);
});

test("failure keeps the chance consumed and reports a sanitized reason", async () => {
  const harness = createRunHarness({
    issue: () => Promise.reject({ code: "CONFLICT", message: "有 Codex 回合运行中", details: { reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired } }),
  });
  const result = await runBuiltInRelayAutoEnable(harness.deps);
  assert.equal(result.outcome, "failed");
  assert.equal(harness.calls.filter((call) => call === "issue").length, 1);
  assert.equal(harness.hasAttempted(), true);
  assert.equal(result.failure?.codeGroup, "codex_turn_conflict");
  assert.equal(result.failure?.message, "有 Codex 回合正在运行，已跳过自动切换");
});

test("cancelled run stays silent", async () => {
  const harness = createRunHarness({ issue: () => Promise.reject(createCancelledRequestError("scope-change")) });
  const result = await runBuiltInRelayAutoEnable(harness.deps);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.failure, undefined);
  assert.equal(harness.hasAttempted(), true);
});

test("failure reasons are masked and truncated", () => {
  assert.equal(
    sanitizeBuiltInRelayAutoEnableReason("读取 https://relay.internal/api/sub2api 失败"),
    "读取 （地址已隐藏） 失败",
  );
  assert.match(sanitizeBuiltInRelayAutoEnableReason("Key codeflowai_ABCDEFGHIJKLMNOP 无效"), /（Key 已隐藏）/u);
  // 含下划线/连字符的 Key 形态同样必须脱敏（mock 与部分历史 Key 都是这种写法）。
  assert.doesNotMatch(sanitizeBuiltInRelayAutoEnableReason("Key codeflowai_E2E_RELAY_KEY_0123456789 无效"), /codeflowai_E2E/u);
  assert.doesNotMatch(sanitizeBuiltInRelayAutoEnableReason("Key codeflowai_ab-cd_ef-12345678 无效"), /codeflowai_ab-cd/u);
  assert.equal(sanitizeBuiltInRelayAutoEnableReason("   "), "");
  assert.ok(sanitizeBuiltInRelayAutoEnableReason("长".repeat(400)).length <= 121);
});

test("failure classification covers registered conflicts and generic boundaries", () => {
  const conflict = { code: "CONFLICT", message: "有回合", details: { reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired } };
  assert.equal(classifyBuiltInRelayAutoEnableFailure(conflict), "codex_turn_conflict");
  assert.equal(resolveBuiltInRelayAutoEnableFailureMessage(conflict), "有 Codex 回合正在运行，已跳过自动切换");
  assert.equal(
    resolveBuiltInRelayAutoEnableFailureMessage({ code: "CONFLICT", details: { reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.controlledExperimentRunning } }),
    "有受控实验正在运行，已跳过自动切换",
  );
  assert.equal(classifyBuiltInRelayAutoEnableFailure(new Error("CLIENT_OFFLINE 当前工作区 Client 未在线")), "client_offline");
  assert.equal(resolveBuiltInRelayAutoEnableFailureMessage(new Error("CLIENT_OFFLINE 当前工作区 Client 未在线")), "当前工作区 Client 未在线");
  assert.equal(classifyBuiltInRelayAutoEnableFailure({ code: "BAD_REQUEST", message: "参数错误" }), "request_rejected");
  assert.equal(classifyBuiltInRelayAutoEnableFailure(new Error("boom")), "request_error");
});

test("only the key list refresh race counts as retryable", () => {
  assert.equal(isBuiltInRelayAutoEnableRetryableError(new Error("本地 Key 列表刷新未完成，请重试")), true);
  assert.equal(isBuiltInRelayAutoEnableRetryableError(new Error("CLIENT_OFFLINE 当前工作区 Client 未在线")), false);
  assert.equal(isBuiltInRelayAutoEnableRetryableError({ code: "INTERNAL_ERROR", message: "内置中转未启用或配置不完整" }), false);
});

test("notices state the outcome and that no retry follows", () => {
  const failure = buildBuiltInRelayAutoEnableFailureNotice("有 Codex 回合正在运行，已跳过自动切换");
  assert.equal(failure.kind, "failure");
  assert.match(failure.message, /不会自动重试/u);
  assert.match(failure.message, /CodeFlow 内置中转/u);
  assert.equal(buildBuiltInRelayAutoEnableFailureNotice("  ").message.includes("内置中转 Key 写入失败"), true);
  const success = buildBuiltInRelayAutoEnableSuccessNotice();
  assert.equal(success.kind, "success");
  assert.match(success.message, /Codex/u);
});

test("scope key isolates account and workspace without session ids", () => {
  assert.equal(
    resolveBuiltInRelayAutoEnableScopeKey({ serverWsOrigin: "ws://example.test", userId: "user-1", workspaceId: "client-a:repo" }),
    "ws%3A%2F%2Fexample.test::user-1::client-a%3Arepo",
  );
  assert.notEqual(
    resolveBuiltInRelayAutoEnableScopeKey({ serverWsOrigin: "ws://example.test", userId: "user-1", workspaceId: "client-a:repo" }),
    resolveBuiltInRelayAutoEnableScopeKey({ serverWsOrigin: "ws://example.test", userId: "user-1", workspaceId: "client-a:other" }),
  );
  assert.equal(resolveBuiltInRelayAutoEnableScopeKey({ serverWsOrigin: "ws://example.test", userId: "", workspaceId: "client-a:repo" }), null);
});

test("auto path is wired into the shell, the panel notice and the manual fallback", () => {
  const shellSource = readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8");
  assert.match(shellSource, /useBuiltInRelayAutoEnable\(\{ publicMainViews: PUBLIC_SITE_MAIN_VIEWS \}\)/u);
  const panelSource = readFileSync(new URL("../src/features/settings/components/engine-keys-panel.vue", import.meta.url), "utf8");
  assert.match(panelSource, /autoEnable\.noticeForWorkspace\(effectiveWorkspaceId\.value\)/u);
  assert.match(panelSource, /@close="dismissAutoEnableNotice"/u);
  const composableSource = readFileSync(new URL("../src/features/settings/composables/useBuiltInRelayAutoEnable.ts", import.meta.url), "utf8");
  assert.match(composableSource, /syncBuiltInRelayKey\(CODEX_RELAY_TARGET, runWorkspaceId, shouldApply\)/u);
  // 自动路径不得强制停止正在运行的 Codex 回合，冲突只能转为可见失败。
  assert.doesNotMatch(composableSource, /stopRunningTurns/u);
});

test("an unlisted write is told apart from a scope change in the auto path", () => {
  const composableSource = readFileSync(new URL("../src/features/settings/composables/useBuiltInRelayAutoEnable.ts", import.meta.url), "utf8");
  // 写成功但本地列表被并发刷新顶掉读不回时按成功收敛，只有作用域变化才静默取消；
  // 一律当失败会留下一张消不掉的假失败卡（Key 其实已装好并已激活）。
  assert.match(composableSource, /const written = await issueEnableWithBoundedRetry\(runWorkspaceId, shouldApply\)/u);
  assert.match(composableSource, /if \(!shouldApply\(\)\) throw createCancelledRequestError\("scope-change"\)/u);
  assert.match(composableSource, /\[BUILT_IN_RELAY_AUTO_ENABLE_KEY_UNLISTED\]/u);
  assert.doesNotMatch(composableSource, /createBuiltInRelayAutoEnableUnconfirmedError/u);
  // 上报前再过一次门禁，避免把旧工作区的提示塞进 Key 面板。
  assert.match(composableSource, /if \(!shouldApply\(\)\) return;\s*reportOutcome\(result, scopeKey\)/u);
});
