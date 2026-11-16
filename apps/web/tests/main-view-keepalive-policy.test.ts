import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import { createPinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import { createApp } from "vue";
import * as vue from "vue";
import ts from "typescript";

import {
  DESKTOP_TABLET_KEPT_ALIVE_COMPONENT_NAMES,
  DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEWS,
  isDesktopTabletMainViewKeptAlive,
  resolveDesktopTabletPrimaryPane,
} from "../src/layouts/main-view-keepalive.ts";
import {
  resolvePrimaryThreadFallbackForRoute,
  shouldClearPrimarySelectionForThreadUrlChange,
  shouldUseThreadOnlyActivationForRouteChange,
} from "../src/features/threads/primary-thread-selection.ts";
import {
  resolveOrchestrationEntryForTopLevelNavigation,
  resolveOrchestrationEntryFromRouteName,
} from "../src/features/orchestration/orchestration-entry.ts";
import { resolveAccountH5DeepLink } from "../src/features/office-h5/accountH5DeepLink.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useOrchestrationStore } from "../src/store/orchestration.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useAdminStore } from "../src/store/admin.ts";
import * as systemPanelAccess from "../src/features/admin/systemPanelAccess.ts";
import {
  resolveMobileTabForEntrySurface,
  resolveMobileTabForMainView,
  resolveStandardApplicationEntryPath,
  shouldRestoreMobileChatPageForThreadRoute,
  shouldSyncMobileAdminPanelRoute,
  useUiStore,
} from "../src/store/ui.ts";

test("desktop/tablet keepAlive policy is explicitly limited to chat, orchestration, and admin", () => {
  assert.deepEqual(DESKTOP_TABLET_KEPT_ALIVE_MAIN_VIEWS, ["chat", "orchestration", "admin"]);
  assert.deepEqual(DESKTOP_TABLET_KEPT_ALIVE_COMPONENT_NAMES, ["ChatPanel", "OrchestrationLayout", "AdminLayout"]);

  assert.equal(isDesktopTabletMainViewKeptAlive("chat"), true);
  assert.equal(isDesktopTabletMainViewKeptAlive("orchestration"), true);
  assert.equal(isDesktopTabletMainViewKeptAlive("admin"), true);
  assert.equal(isDesktopTabletMainViewKeptAlive("landing"), false);
  assert.equal(isDesktopTabletMainViewKeptAlive("guide"), false);
  assert.equal(isDesktopTabletMainViewKeptAlive("auth"), false);
  assert.equal(isDesktopTabletMainViewKeptAlive("payment-verification"), false);
});

test("public site page instances stay alive across top-level navigation", () => {
  // 公开站点页面与 KeepAlive 块挂在 StandardApp（App.vue 仅剩 Suspense 分发），故读取 standard-app.vue。
  const appSource = fs.readFileSync("apps/web/src/standard-app.vue", "utf8");
  const keepAliveBlock = appSource.match(/<KeepAlive v-if="isPublicSiteViewActive">([\s\S]*?)<\/KeepAlive>/u)?.[1] ?? "";

  assert.notEqual(keepAliveBlock, "");
  for (const componentName of [
    "LandingPage",
    "BestPracticePage",
    "ContactPage",
    "UpgradePage",
    "DataSecurityCommitmentPage",
  ]) {
    assert.match(keepAliveBlock, new RegExp(`<${componentName}\\b`, "u"));
  }
  assert.doesNotMatch(keepAliveBlock, /Auth|Payment|ProjectKnowledge|layoutNode/u);
  assert.match(appSource, /const isPublicSiteViewActive = computed\(\(\) => \([\s\S]*?PUBLIC_SITE_MAIN_VIEWS\.has\(shell\.ui\.mainView\)/u);
});

/** 运行管理壳的真实 setup 与 watcher，仅隔离子面板加载和未使用的外部服务。 */
function adminLayoutFixture(t: test.TestContext) {
  setActivePinia(createPinia());
  const config = useConfigStore(), admin = useAdminStore(), ui = useUiStore();
  ui._syncMainView("chat");
  const route = vue.reactive<{ query: Record<string, string> }>({ query: { panel: "engine-keys" } });
  const replacements: Record<string, string>[] = [];
  const router = { replace: async ({ query }: { query: Record<string, string> }) => {
    replacements.push(query);
    route.query = { ...query };
  } };
  const adminLayoutSource = fs.readFileSync("apps/web/src/features/admin/components/admin-layout.vue", "utf8");
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = ts.transpileModule(compileScript(parse(adminLayoutSource).descriptor, { id: "admin-keepalive" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => unknown } } };
  new Function("require", "module", "exports", script)((id: string) => {
    if (id === "vue") return vue;
    if (id === "vue-router") return { useRoute: () => route, useRouter: () => router };
    if (id === "../../../store/config") return { useConfigStore };
    if (id === "../../../store/admin") return { useAdminStore };
    if (id === "../../../store/ui") return { useUiStore };
    if (id === "../../../composables/useApiContext") return { useApiContext: () => ({ ctx: vue.ref({}) }) };
    if (id === "../systemPanelAccess") return systemPanelAccess;
    if (id === "@ant-design/icons-vue" || id.endsWith(".vue") || id.endsWith(".css")) return {};
    if (id === "../../../api/account" || id === "../composables/useAdminApi" || id === "ant-design-vue") {
      return new Proxy({}, { get: () => { throw new Error(`保活导航测试不得调用外部服务：${id}`); } });
    }
    throw new Error(`unexpected admin layout import: ${id}`);
  }, module, module.exports);
  const scope = vue.effectScope();
  scope.run(() => module.exports.default.setup({}, { expose() {} }));
  t.after(() => { scope.stop(); config.$dispose(); admin.$dispose(); ui.$dispose(); });
  return { admin, ui, route, replacements };
}

test("desktop admin panel sync reruns when the kept-alive view becomes active", async t => {
  const f = adminLayoutFixture(t);
  assert.equal(f.admin.activePanel, "settings", "离开管理视图时不得同步后台路由");
  assert.deepEqual(f.replacements, []);
  f.ui._syncMainView("admin");
  await vue.nextTick();
  assert.equal(f.admin.activePanel, "engine-keys");
  assert.equal(f.admin.lastMenuPanel, "engine-keys");

  f.ui._syncMainView("chat");
  await vue.nextTick();
  f.route.query = {};
  f.admin.activePanel = "orchestration-metrics";
  await vue.nextTick();
  assert.equal(f.admin.activePanel, "orchestration-metrics");
  f.ui._syncMainView("admin");
  await vue.nextTick();
  assert.equal(f.admin.activePanel, "engine-keys", "返回设置时恢复最近可见菜单");
  assert.equal(f.route.query.panel, "engine-keys");

  f.route.query = { panel: "user-management" };
  await vue.nextTick();
  assert.equal(f.admin.activePanel, "settings", "个人范围拒绝管理员深链并回退设置");
  assert.equal(f.route.query.panel, "settings");
});

/** 从真实 SFC 的语法树执行轮询职责及原始生命周期回调，仅隔离外部请求和时钟。 */
function executionMonitorFixture() {
  const source = fs.readFileSync("apps/web/src/features/orchestration/components/task-intake-panel.vue", "utf8");
  const { parse } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = ts.createSourceFile("task-intake-panel.ts", parse(source).descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Set([
    "errorDiagnosticContext", "shouldPollExecutionMonitor", "clearExecutionMonitorSyncTimer",
    "handleExecutionMonitorVisibilityChange", "isOrchestrationViewActive", "canPollExecutionMonitor",
    "buildExecutionMonitorSyncKey", "scheduleExecutionMonitorSync", "syncExecutionMonitorFromServer",
  ]);
  const variables = new Set([
    "EXECUTION_MONITOR_SYNC_INTERVAL_MS", "executionMonitorSyncTimer", "executionMonitorSyncInFlight",
    "executionMonitorSyncBlockedKey", "executionMonitorViewActive", "metricReviewRequestVersion",
  ]);
  const hooks: Record<string, (() => void)[]> = { onMounted: [], onActivated: [], onDeactivated: [], onBeforeUnmount: [] };
  const statements = script.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return Boolean(node.name && functions.has(node.name.text));
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && variables.has(item.name.text));
    return ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text in hooks;
  });
  assert.equal(statements.filter(ts.isFunctionDeclaration).length, functions.size);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, () => void>();
  let timerId = 0;
  const ui = { mainView: "orchestration" };
  const document = {
    hidden: false,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const instance = vue.ref({ id: "instance-a", status: "running", updatedAt: 1 });
  const requests: unknown[][] = [], details: unknown[][] = [], errors: unknown[][] = [], notices: string[] = [];
  const patch = { run: async () => {} };
  const scope: Record<string, any> = {
    Error, ref: vue.ref, ui, document, props: { workspaceId: "client-a:main" }, ctx: vue.ref({}),
    selectedMonitorInstance: instance, selectedMonitorInstanceId: vue.ref("instance-a"),
    selectedIntake: vue.ref({ id: "intake-a" }), showExecutionMonitor: vue.ref(true),
    window: {
      setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: (id: number) => timers.delete(id), addEventListener() {}, removeEventListener() {},
    },
    orch: {
      loadTrackedInstanceRuntimePatch: async (...args: unknown[]) => { requests.push(args); await patch.run(); },
      ensureSelectedInstanceDetails: async (...args: unknown[]) => { details.push(args); },
    },
    console: { error: (...args: unknown[]) => errors.push(args) }, message: { error: (text: string) => notices.push(text) },
    syncRequirementDetailModalViewportHeight() {}, schedulePlannerDataHydration() {},
    reconcileAssigneePlanSelection() {}, reconcileSharedWorkspaceMembers() {},
  };
  for (const name of Object.keys(hooks)) scope[name] = (callback: () => void) => hooks[name].push(callback);
  const code = statements.map(node => node.getText(script)).join("\n");
  vm.runInNewContext(ts.transpileModule(code + "\nglobalThis.actions = { scheduleExecutionMonitorSync, syncExecutionMonitorFromServer };", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, scope);
  for (const name of Object.keys(hooks)) assert.equal(hooks[name].length, 1, `缺少真实生命周期：${name}`);
  return { scope, hooks, timers, listeners, document, ui, instance, requests, details, patch, errors, notices };
}

test("kept-alive orchestration monitor clears polling and rejects late work while inactive or hidden", async () => {
  const f = executionMonitorFixture();
  f.hooks.onMounted[0]();
  f.hooks.onActivated[0]();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 30_000);
  let resolvePatch!: () => void;
  f.patch.run = () => new Promise<void>(resolve => { resolvePatch = resolve; });
  const pending = f.scope.actions.syncExecutionMonitorFromServer("instance-a");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][1], "client-a:main");
  assert.equal(f.requests[0][2], "instance-a");
  f.hooks.onDeactivated[0]();
  assert.equal(f.timers.size, 0);
  f.instance.value.status = "completed";
  resolvePatch();
  await pending;
  assert.equal(f.details.length, 0, "迟到结果不能派生详情请求");
  assert.equal(f.timers.size, 0);
  f.instance.value.status = "running";
  await f.scope.actions.syncExecutionMonitorFromServer("instance-a");
  assert.equal(f.requests.length, 1, "停用后不能继续轮询");
  f.hooks.onActivated[0]();
  assert.equal(f.timers.size, 1);
  f.document.hidden = true;
  f.listeners.get("visibilitychange")!();
  assert.equal(f.timers.size, 0);
  await f.scope.actions.syncExecutionMonitorFromServer("instance-a");
  assert.equal(f.requests.length, 1, "隐藏时不能继续轮询");
  f.document.hidden = false;
  f.listeners.get("visibilitychange")!();
  assert.equal(f.timers.size, 1);
  f.ui.mainView = "chat";
  f.scope.actions.scheduleExecutionMonitorSync();
  assert.equal(f.timers.size, 0, "离开编排主视图后不能调度");
  f.ui.mainView = "orchestration";
  f.hooks.onActivated[0]();
  f.hooks.onBeforeUnmount[0]();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.errors, []);
});

test("orchestration polling failure stops automatic retries for the same runtime state", async () => {
  const f = executionMonitorFixture();
  f.patch.run = async () => { throw Object.assign(new Error("runtime unavailable"), { code: "RUNTIME_UNAVAILABLE", requestId: "request-a" }); };
  await f.scope.actions.syncExecutionMonitorFromServer("instance-a");
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.notices, ["runtime unavailable"]);
  assert.equal(f.errors.length, 1);
  assert.equal((f.errors[0][1] as any).requestId, "request-a");
  assert.equal((f.errors[0][1] as any).errorCode, "RUNTIME_UNAVAILABLE");
  f.scope.actions.scheduleExecutionMonitorSync();
  assert.equal(f.timers.size, 0);
  f.instance.value.updatedAt = 2;
  f.scope.actions.scheduleExecutionMonitorSync();
  assert.equal(f.timers.size, 1, "新运行态解除原状态的失败停机");
  f.hooks.onBeforeUnmount[0]();
});

test("kept-alive orchestration hydration and planner edits keep their visibility boundaries", () => {
  const layoutSource = fs.readFileSync("apps/web/src/features/orchestration/components/orchestration-layout.vue", "utf8");
  const source = fs.readFileSync("apps/web/src/features/orchestration/components/task-intake-panel.vue", "utf8");
  const monitorSource = fs.readFileSync("apps/web/src/features/orchestration/components/orchestration-monitor.vue", "utf8");
  const storeSource = fs.readFileSync("apps/web/src/store/orchestration.ts", "utf8");
  const wsSource = fs.readFileSync("apps/web/src/services/ws.ts", "utf8");

  assert.match(layoutSource, /onActivated\(\(\) => \{/u);
  assert.match(layoutSource, /onDeactivated\(\(\) => \{/u);
  assert.match(layoutSource, /ui\.mainView === "orchestration"/u);
  assert.match(layoutSource, /function buildVisibleHydrationKey\(\)/u);
  assert.match(layoutSource, /if \(visibleHydrationInFlightKey === hydrationKey\) return;/u);
  assert.match(layoutSource, /if \(shouldHydrateQueuedScope\) scheduleVisibleOrchestrationHydration\(\);/u);
  assert.match(layoutSource, /activeAssetTab,[\s\S]*?\(\) => orch\.intakeListOnlyRelatedToMe,[\s\S]*?\(\) => analysis\.sessionListOnlyRelatedToMe,[\s\S]*?scheduleVisibleOrchestrationHydration\(\);/u);
  assert.doesNotMatch(layoutSource, /orch\.selectedIntakeId = orch\.intakes\[0\]\?\.id/u);
  assert.match(source, /onDeactivated\(\(\) => \{[\s\S]*?clearExecutionMonitorSyncTimer\(\);[\s\S]*?\}\);/u);
  assert.match(source, /onActivated\(\(\) => \{[\s\S]*?scheduleExecutionMonitorSync\(\);[\s\S]*?\}\);/u);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleExecutionMonitorVisibilityChange\)/u);
  assert.match(source, /if \(!canPollExecutionMonitor\(\)\) return;/u);
  assert.match(source, /ui\.mainView === "orchestration"/u);
  assert.match(source, /function isOrchestrationViewActive\(\)/u);
  assert.match(source, /return sharedWorkspaceId\.value \? orch\.intakeListOnlyRelatedToMe : null;/u);
  assert.match(source, /function buildPlannerDataHydrationKey\(\)/u);
  assert.match(source, /watch\(buildPlannerDataHydrationKey, \(\) => \{/u);
  assert.match(source, /plannerDataHydratedKey === hydrationKey/u);
  assert.match(source, /plannerExecutionPlanAppliedKey === applyKey/u);
  assert.match(source, /applyHydratedPlannerDraftIfCurrent\([\s\S]*?applyExecutionPlanFromIntake\(intake\)/u);
  assert.match(source, /function markPlannerDraftEdited\(\)[\s\S]*?plannerDraftEditVersion \+= 1;/u);
  for (const field of ["executionTargetType", "workflowId", "roleId", "workflowRunMode", "executionEngineStrategy"]) {
    assert.match(source, new RegExp(`<select[^>]*v-model="${field}"[^>]*@change="markPlannerDraftEdited"`, "u"));
  }
  assert.match(source, /v-model="roleExecutionOverrideDrafts\[row\.roleId\]\.enabled"[^>]*@change="markPlannerDraftEdited"/u);
  assert.match(source, /<select[^>]*v-model="roleExecutionOverrideDrafts\[row\.roleId\]\.model"[^>]*@change="onRoleOverrideModelChanged\(row\.roleId\)"/u);
  assert.match(source, /v-model="roleExecutionOverrideDrafts\[row\.roleId\]\.effort"[\s\S]*?@change="markPlannerDraftEdited"/u);
  assert.doesNotMatch(source, /v-model(?:\.number)?="roleExecutionOverrideDrafts\[row\.roleId\]\.contextWindow"/u);
  assert.match(source, /v-model\.number="roleExecutionOverrideDrafts\[row\.roleId\]\.autoCompactPct"[\s\S]*?@input="markPlannerDraftEdited"/u);
  assert.match(source, /function setRoleOverrideEngine\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function onRoleOverrideModelChanged\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function setSkippedNodeDraft\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function clearSkippedNodeDrafts\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function setNodeAssigneeDraftValue\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function assignAllNodesToCurrentUser\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /function clearAllNodeAssignees\([\s\S]*?markPlannerDraftEdited\(\);/u);
  assert.match(source, /savedEditVersion = plannerDraftEditVersion[\s\S]*?plannerDraftEditVersion === savedEditVersion[\s\S]*?plannerDraftCleanVersion = savedEditVersion/u);
  assert.match(source, /assigneePlanSelectionKey,[\s\S]*?executionMonitorViewActive,[\s\S]*?\(\) => ui\.mainView,[\s\S]*?reconcileAssigneePlanSelection/u);
  assert.match(source, /sharedWorkspaceId,[\s\S]*?activeSharedMembers,[\s\S]*?executionMonitorViewActive,[\s\S]*?\(\) => ui\.mainView,[\s\S]*?reconcileSharedWorkspaceMembers/u);
  assert.match(source, /function requestSharedMembersForSelectedIntake\(sharedId: string\)[\s\S]*?if \(!selectedIntake\.value \|\| !isOrchestrationViewActive\(\)\) return;/u);
  assert.match(source, /function refreshAssigneeTemplatesForCurrentWorkflow\(\)[\s\S]*?if \(!selectedIntake\.value \|\| !isOrchestrationViewActive\(\)\) return;/u);
  assert.match(source, /executionMonitorSyncBlockedKey = attemptKey[\s\S]*?ORCH_EXECUTION_MONITOR_SYNC_FAILED[\s\S]*?scheduleExecutionMonitorSync\(\);/u);
  assert.doesNotMatch(source, /execution monitor sync failed:", error/u);
  assert.match(source, /relatedInstances,[\s\S]*?executionMonitorViewActive,[\s\S]*?\(\) => ui\.mainView,[\s\S]*?if \(!isOrchestrationViewActive\(\)\) return;[\s\S]*?automatic instance hydration failed/u);
  assert.match(source, /EXECUTION_MONITOR_SYNC_INTERVAL_MS = 30000/u);
  assert.match(monitorSource, /onActivated\(\(\) => \{/u);
  assert.match(monitorSource, /onDeactivated\(\(\) => \{/u);
  assert.match(monitorSource, /function canHydrateMonitorInstance\(\)/u);
  assert.match(monitorSource, /requestMonitorInstanceHydration\(id, \{ refreshRuntimePatch: true \}\);/u);
  assert.match(monitorSource, /onActivated\(\(\) => \{[\s\S]*?requestMonitorInstanceHydration\(props\.instanceId, \{ refreshRuntimePatch: true \}\);[\s\S]*?\}\);/u);
  assert.match(monitorSource, /cachedBeforeLoad[\s\S]*?orch\.loadInstance\([\s\S]*?loadTrackedInstanceRuntimePatch/u);
  assert.match(monitorSource, /selectedNodeThreadId,[\s\S]*?monitorViewActive,[\s\S]*?\(\) => ui\.mainView,[\s\S]*?if \(!canHydrateMonitorInstance\(\)\) return;/u);
  assert.match(monitorSource, /pending interaction hydration failed/u);
  assert.doesNotMatch(monitorSource, /if \(id\) void orch\.loadInstance\(/u);
  assert.match(storeSource, /const allowNetworkHydration = \(\) => \{/u);
  assert.match(storeSource, /allowNetworkHydration\(\) && isScheduledTaskInstanceStartedEvent/u);
  assert.match(storeSource, /allowNetworkHydration\(\) && artifactId/u);
  assert.match(storeSource, /allowNetworkHydration\(\) && promptSnapshotId/u);
  assert.match(storeSource, /resolveNetworkHydrationGuard\(options\.allowNetworkHydration\)/u);
  assert.match(wsSource, /allowNetworkHydration: \(\) => !deps\.ui \|\| deps\.ui\.mainView === "orchestration"/u);
  for (const componentSource of [layoutSource, source, monitorSource]) {
    assert.match(componentSource, /errorCode:/u);
    assert.match(componentSource, /requestId:/u);
  }
});

test("AI requirement analysis adds workflow and role assets to visible hydration", () => {
  const layoutSource = fs.readFileSync("apps/web/src/features/orchestration/components/orchestration-layout.vue", "utf8");
  const visibleHydrationSource = layoutSource.match(
    /async function refreshVisibleOrchestrationData\(\): Promise<void> \{[\s\S]*?\r?\n\}\r?\n\r?\n\/\*\* 标识当前可见刷新范围/u,
  )?.[0] ?? "";
  const analysisAssetLoads = visibleHydrationSource.match(
    /const analysisAssetLoads = analysis\.viewMode === "analysis"[\s\S]*?: \[\];/u,
  )?.[0] ?? "";
  const hydrationKeySource = layoutSource.match(
    /function buildVisibleHydrationKey\(\): string \{[\s\S]*?\r?\n\}\r?\n\r?\n\/\*\* 合并同一激活窗口/u,
  )?.[0] ?? "";
  const analysisModeWatchSource = layoutSource.match(
    /watch\(\(\) => analysis\.viewMode, \(viewMode\) => \{[\s\S]*?\r?\n\}\);/u,
  )?.[0] ?? "";

  assert.notEqual(analysisAssetLoads, "");
  assert.match(analysisAssetLoads, /orch\.ensureAssetListLoaded\(ctx\.value, workspaceId, "workflow", "execution"\)/u);
  assert.match(analysisAssetLoads, /orch\.ensureAssetListLoaded\(ctx\.value, workspaceId, "role", "execution"\)/u);
  assert.match(visibleHydrationSource, /\.\.\.analysisAssetLoads,/u);
  assert.match(hydrationKeySource, /analysis\.viewMode,/u);
  assert.match(analysisModeWatchSource, /if \(viewMode !== "analysis"\) return;/u);
  assert.match(analysisModeWatchSource, /scheduleVisibleOrchestrationHydration\(\);/u);
});

test("desktop/tablet primary pane keeps chat as the stable fallback outside orchestration", () => {
  assert.equal(resolveDesktopTabletPrimaryPane("chat"), "chat");
  assert.equal(resolveDesktopTabletPrimaryPane("orchestration"), "orchestration");
  assert.equal(resolveDesktopTabletPrimaryPane("admin"), "chat");
  assert.equal(resolveDesktopTabletPrimaryPane("landing"), "chat");
});

test("orchestration intake selection stays session-local across cold entry", () => {
  const storeSource = fs.readFileSync("apps/web/src/store/orchestration.ts", "utf8");
  const persistedValues = new Map<string, string>([
    ["orchestration", JSON.stringify({
      activeTab: "assets",
      selectedIntakeId: "legacy-intake-selection",
      selectedWorkflowId: "persisted-workflow",
    })],
  ]);
  const persistedStorage = {
    getItem: (key: string) => persistedValues.get(key) ?? null,
    setItem: (key: string, value: string) => persistedValues.set(key, value),
  };
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage: persistedStorage }));
  createApp({}).use(pinia);
  const orchestration = useOrchestrationStore(pinia);

  assert.doesNotMatch(storeSource, /persist:\s*\{\s*pick:\s*\[[^\]]*"selectedIntakeId"/u);
  assert.equal(orchestration.selectedIntakeId, null);
  assert.equal(orchestration.selectedWorkflowId, "persisted-workflow");
  orchestration.$persist();
  assert.equal(
    Object.prototype.hasOwnProperty.call(JSON.parse(persistedValues.get("orchestration") ?? "{}"), "selectedIntakeId"),
    false,
  );
});

test("switching mainView does not clear the currently selected thread", () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ui = useUiStore();

  chat.selectThread("thread-keepalive-demo" as any);
  assert.equal(chat.selectedThreadId, "thread-keepalive-demo");

  ui._syncMainView("orchestration");
  assert.equal(ui.mainView, "orchestration");
  assert.equal(chat.selectedThreadId, "thread-keepalive-demo");

  ui._syncMainView("admin");
  assert.equal(ui.mainView, "admin");
  assert.equal(chat.selectedThreadId, "thread-keepalive-demo");

  ui._syncMainView("chat");
  assert.equal(ui.mainView, "chat");
  assert.equal(chat.selectedThreadId, "thread-keepalive-demo");
});

test("首页类路由归一回首页，但移动端 landing 保留用户已切的 Tab", () => {
  setActivePinia(createPinia());
  const ui = useUiStore();

  assert.equal(ui.activeMobileTab, "home");
  // `/`（landing）同时承载移动端工作台：已切到会话/待办时不能被归一回首页，否则会“点一次进不去、返回跳首页”。
  assert.equal(resolveMobileTabForMainView("landing", "sessions"), "sessions");
  assert.equal(resolveMobileTabForMainView("landing", "pending"), "pending");
  assert.equal(resolveMobileTabForMainView("landing", "home"), "home");
  assert.equal(resolveMobileTabForMainView("guide", "workspace"), "home");
  assert.equal(resolveMobileTabForMainView("best-practices", "sessions"), "home");
  assert.equal(resolveMobileTabForMainView("contact", "explorer"), "home");
  assert.equal(resolveMobileTabForMainView("contact", "sessions"), "home");
  assert.equal(resolveMobileTabForMainView("upgrade", "sessions"), "home");
  assert.equal(resolveMobileTabForMainView("chat", "sessions"), "sessions");
  assert.equal(resolveMobileTabForMainView("admin", "workspace"), "workspace");
});

test("mobile H5 tab state stays isolated from the standard mobile entry", () => {
  assert.equal(resolveMobileTabForEntrySurface("standard", "pending"), "sessions");
  assert.equal(resolveMobileTabForEntrySurface("standard", "home"), "home");
  assert.equal(resolveMobileTabForEntrySurface("h5", "home"), "sessions");
  assert.equal(resolveMobileTabForEntrySurface("h5", "pending"), "sessions");
  assert.equal(resolveMobileTabForEntrySurface("h5", "explorer"), "explorer");
});

test("application mobile routes normalize stale home tabs and preserve working tabs", () => {
  for (const view of ["chat", "h5", "office-h5"] as const) {
    for (const tab of ["home", "pending"] as const) {
      const normalized = resolveMobileTabForMainView(view, tab);
      assert.equal(normalized, "sessions");
      assert.equal(resolveMobileTabForMainView(view, normalized), normalized);
    }
  }
  assert.equal(resolveMobileTabForMainView("chat", "explorer"), "explorer");
  for (const tab of ["orders", "explorer", "workspace"] as const) {
    assert.equal(resolveMobileTabForMainView("h5", tab), tab);
  }
  // landing 承载移动端工作台：已切到会话时不归一，其余首页类路由仍归回首页。
  assert.equal(resolveMobileTabForMainView("landing", "sessions"), "sessions");
});

test("account H5 notification deep links select safe workspace and target state", () => {
  assert.deepEqual(resolveAccountH5DeepLink({
    workspaceId: "ws-a",
    tab: "pending",
    targetId: "instance-a",
  }), { workspaceId: "ws-a", tab: "pending", threadId: "", targetId: "instance-a" });
  assert.deepEqual(resolveAccountH5DeepLink({
    workspaceId: ["ws-b", "ws-c"],
    tab: "pending",
    threadId: "thread-a",
  }), { workspaceId: "ws-b", tab: "sessions", threadId: "thread-a", targetId: "" });
  assert.deepEqual(resolveAccountH5DeepLink({ targetId: "instance-b" }), {
    workspaceId: "",
    tab: "pending",
    threadId: "",
    targetId: "instance-b",
  });
  assert.deepEqual(resolveAccountH5DeepLink({
    workspaceId: "ws\u0000bad",
    threadId: "t".repeat(257),
    targetId: "node\u0007bad",
    tab: "unknown",
  }), { workspaceId: "", tab: "sessions", threadId: "", targetId: "" });
});

test("standard application entry does not resume dedicated H5 routes", () => {
  assert.equal(resolveStandardApplicationEntryPath({
    lastAppRoutePath: "/chat?threadId=thread-a",
    homePath: "/admin",
  }), "/chat?threadId=thread-a");
  assert.equal(resolveStandardApplicationEntryPath({
    lastAppRoutePath: "/h5?workspaceId=ws-a",
    homePath: "/chat",
  }), "/chat");
  assert.equal(resolveStandardApplicationEntryPath({
    lastAppRoutePath: "/office-h5/wecom?corpId=corp-a",
    homePath: "/admin?panel=settings",
  }), "/admin?panel=settings");
  assert.equal(resolveStandardApplicationEntryPath({
    lastAppRoutePath: "/h5",
    homePath: "/office-h5/dingtalk",
  }), "/chat");

  setActivePinia(createPinia());
  const ui = useUiStore();
  ui.rememberLastAppRoute("chat", "/chat?threadId=thread-a");
  ui.rememberLastAppRoute("h5", "/h5");
  assert.equal(ui.lastAppRoutePath, "/chat?threadId=thread-a");
});

test("mobile admin panel route sync is isolated from H5 and authentication deep links", () => {
  assert.equal(shouldSyncMobileAdminPanelRoute("admin"), true);
  assert.equal(shouldSyncMobileAdminPanelRoute("h5"), false);
  assert.equal(shouldSyncMobileAdminPanelRoute("auth-login"), false);
  assert.equal(shouldSyncMobileAdminPanelRoute(null), false);
});

test("mobile thread deep links restore the chat page stack only when no mobile page is open", () => {
  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "chat",
    requestedThreadId: "thread-a",
    currentPageType: null,
  }), true);

  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "chat",
    requestedThreadId: "",
    currentPageType: null,
  }), false);

  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "chat",
    requestedThreadId: "thread-a",
    currentPageType: "debug",
  }), false);

  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "admin",
    requestedThreadId: "thread-a",
    currentPageType: null,
  }), false);

  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "h5",
    requestedThreadId: "thread-h5",
    currentPageType: null,
    entrySurface: "h5",
  }), true);
  assert.equal(shouldRestoreMobileChatPageForThreadRoute({
    routeName: "chat",
    requestedThreadId: "thread-h5",
    currentPageType: null,
    entrySurface: "h5",
  }), false);
});

test("thread url change clears primary selection only on chat or H5 thread routes", () => {
  assert.equal(shouldClearPrimarySelectionForThreadUrlChange({
    routeName: "chat",
    requestedThreadId: "thread-b" as any,
    selectedThreadId: "thread-a" as any,
  }), true);

  assert.equal(shouldClearPrimarySelectionForThreadUrlChange({
    routeName: "chat",
    requestedThreadId: null,
    selectedThreadId: "thread-a" as any,
  }), false);

  assert.equal(shouldClearPrimarySelectionForThreadUrlChange({
    routeName: "h5",
    requestedThreadId: "thread-b" as any,
    selectedThreadId: "thread-a" as any,
  }), true);

  assert.equal(shouldClearPrimarySelectionForThreadUrlChange({
    routeName: "orchestration-workspace",
    requestedThreadId: null,
    selectedThreadId: "thread-a" as any,
  }), false);
});

test("chat and H5 routes can fall back to preserved primary selection, but off-thread routes do not", () => {
  assert.equal(resolvePrimaryThreadFallbackForRoute({
    routeName: "chat",
    selectedThreadId: "thread-a" as any,
    hasSelectedThreadSummary: true,
  }), "thread-a");

  assert.equal(resolvePrimaryThreadFallbackForRoute({
    routeName: "chat",
    selectedThreadId: "thread-a" as any,
    hasSelectedThreadSummary: false,
  }), null);

  assert.equal(resolvePrimaryThreadFallbackForRoute({
    routeName: "h5",
    selectedThreadId: "thread-h5" as any,
    hasSelectedThreadSummary: true,
  }), "thread-h5");

  assert.equal(resolvePrimaryThreadFallbackForRoute({
    routeName: "admin",
    selectedThreadId: "thread-a" as any,
    hasSelectedThreadSummary: true,
  }), null);
});

test("same-workspace mainView route changes use thread-only activation instead of full workspace hydration", () => {
  assert.equal(shouldUseThreadOnlyActivationForRouteChange({
    previousConnected: true,
    previousWorkspaceId: "ws-demo",
    workspaceId: "ws-demo",
    hydrationTick: 2,
    previousHydrationTick: 2,
    previousRequestedThreadId: "thread-a" as any,
    requestedThreadId: null,
    previousRouteName: "chat",
    routeName: "orchestration-workspace",
  }), true);

  assert.equal(shouldUseThreadOnlyActivationForRouteChange({
    previousConnected: true,
    previousWorkspaceId: "ws-demo",
    workspaceId: "ws-demo",
    hydrationTick: 2,
    previousHydrationTick: 2,
    previousRequestedThreadId: null,
    requestedThreadId: null,
    previousRouteName: "admin",
    routeName: "chat",
  }), true);

  assert.equal(shouldUseThreadOnlyActivationForRouteChange({
    previousConnected: true,
    previousWorkspaceId: "ws-prev",
    workspaceId: "ws-demo",
    hydrationTick: 2,
    previousHydrationTick: 2,
    previousRequestedThreadId: "thread-a" as any,
    requestedThreadId: "thread-a" as any,
    previousRouteName: "chat",
    routeName: "chat",
  }), false);
});

test("top-level orchestration navigation returns to the last visited orchestration entry", () => {
  assert.equal(resolveOrchestrationEntryFromRouteName("orchestration-assets"), "assets");
  assert.equal(resolveOrchestrationEntryFromRouteName("orchestration-workspace"), "workspace");
  assert.equal(resolveOrchestrationEntryFromRouteName("chat"), null);

  assert.equal(resolveOrchestrationEntryForTopLevelNavigation({
    routeName: "chat",
    lastVisitedEntry: "assets",
  }), "assets");

  assert.equal(resolveOrchestrationEntryForTopLevelNavigation({
    routeName: "orchestration-workspace",
    lastVisitedEntry: "assets",
  }), "workspace");

  setActivePinia(createPinia());
  const ui = useUiStore();
  ui.rememberOrchestrationEntry("assets");
  ui._syncMainView("chat");
  assert.equal(ui.lastOrchestrationEntry, "assets");
});

/** 防止退役Office授权重新接入标准登录，保留现行移动壳和延迟加载合同。 */
test("standard mobile login keeps responsive shell and active navigation contracts", () => {
  const authSource = fs.readFileSync("apps/web/src/features/account/components/auth-login-page.vue", "utf8");
  const authShellSource = fs.readFileSync("apps/web/src/features/account/components/auth-shell.vue", "utf8");
  const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");
  const chatSource = fs.readFileSync("apps/web/src/features/chat/components/chat-panel.vue", "utf8");
  const appSource = fs.readFileSync("apps/web/src/App.vue", "utf8");
  const routerSource = fs.readFileSync("apps/web/src/router/index.ts", "utf8");

  assert.doesNotMatch(authSource, /getOfficeH5LoginOptions|startOfficeH5OAuth|bindingLoginPlatform/u);
  assert.equal(authSource.includes('const loginShellVariant = computed(() => mode.value === "mobile" ? "mobile-login" : "default")'), true);
  assert.equal(authSource.includes(':variant="loginShellVariant"'), true);
  assert.equal(authShellSource.includes("auth-shell--mobile-login"), true);
  const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const compiled = compileTemplate({ source: parse(appSource).descriptor.template!.content, filename: "App.vue", id: "mobile-standard-entry",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name }) as (context: object, cache: unknown[]) => vue.VNode;
  /** 只遍历当前显示的默认插槽，排除 Suspense 的加载占位。 */
  const visibleTags = (node: vue.VNode): string[] => {
    const slots = node.children as { default?: () => vue.VNode[] } | null;
    const children = Array.isArray(node.children) ? node.children : slots?.default?.() ?? [];
    return [...(typeof node.type === "string" ? [node.type] : []), ...children.filter(vue.isVNode).flatMap(visibleTags)];
  };
  assert.equal(visibleTags(render({ desktopStartupReady: true, hasMigrationStartup: false, shellFailed: null }, [])).includes("StandardApp"), true);
  assert.doesNotMatch(appSource, /H5App/u);
  assert.equal(routerSource.includes('const explicitAccountSwitch = String(to.query.switchAccount ?? "") === "1";'), true);
  assert.equal(routerSource.includes('&& !explicitAccountSwitch'), true);
  assert.equal(layoutSource.includes('import AdminAuditPanel from "../../features/admin/components/admin-audit-panel.vue"'), false);
  assert.equal(layoutSource.includes('import EnterpriseAuditPanel from "../../features/admin/components/enterprise-audit-panel.vue"'), false);
  assert.equal(layoutSource.includes('const AdminAuditPanel = defineAsyncComponent(() => import("../../features/admin/components/admin-audit-panel.vue"))'), false);
  assert.equal(layoutSource.includes('const EnterpriseAuditPanel = defineAsyncComponent(() => import("../../features/admin/components/enterprise-audit-panel.vue"))'), true);
  assert.equal(layoutSource.includes('import ExplorerPanel from "../../features/explorer/components/explorer-panel.vue"'), false);
  assert.equal(layoutSource.includes('const ExplorerPanel = defineAsyncComponent(() => import("../../features/explorer/components/explorer-panel.vue"))'), true);
  assert.equal(layoutSource.includes('v-if="isH5Surface && activeTab === \'pending\'"'), false);
  assert.equal(layoutSource.includes('v-if="!isH5Surface || activeTab === \'explorer\'"'), true);
  assert.equal(layoutSource.includes('v-if="!isH5Surface" v-show="activeTab === \'workspace\'"'), true);
  assert.equal(chatSource.includes('import FileChangesPanel from "./file-changes-panel.vue"'), false);
  assert.equal(chatSource.includes('const FileChangesPanel = defineAsyncComponent(() => import("./file-changes-panel.vue"))'), true);
});
