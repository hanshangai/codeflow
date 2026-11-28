import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { computed, reactive, ref, unref } from "vue";
import { createApiResultError, isApiResultError, isCancelledRequestError } from "../src/api/request.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { resolveEngineUnavailableIssue } from "../src/utils/engineAvailability.ts";
import { isSharedWorkspaceSelectionId } from "../src/utils/workspaceId.ts";

const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "web" };
const failure = Object.assign(new Error("engine status offline"), { requestId: "engine-status-request" });

/** 抽取真实 SFC 方法执行；只替换浏览器、计时器与网络边界。 */
function source(relative: string): string {
  return readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8").replace(/^<script setup lang="ts">/, "").split("</script>")[0]!;
}

/** 按语法节点选取业务函数，避免在测试里重写异常处理逻辑。 */
function functions(text: string, names: string[]): string {
  const ast = ts.createSourceFile("component.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name
      || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
    assert.ok(node, `missing business function ${name}`);
    return node.getText(ast).replace(/^export\s+/, "");
  }).join("\n");
}

/** 在真实 store 下制造网络失败，并在每例结束恢复全局网络边界。 */
function engineFixture(t: test.TestContext) {
  setActivePinia(createPinia());
  const engines = useEngineStore();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw failure; };
  t.after(() => { globalThis.fetch = original; });
  return engines;
}

/** 执行业务源码并显式导出测试需要的函数或状态。 */
function execute(code: string, context: Record<string, any>, exported: string): any {
  vm.runInNewContext(ts.transpileModule(`${code}\nglobalThis.boundary = ${exported};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context.boundary;
}

/** 返回真实引擎状态响应，恢复校验使用现有 store 的实际模型合并流程。 */
function engineResponse(): Response {
  return new Response(JSON.stringify({ ok: true, engines: [
    { engineType: "claude", installed: true, version: "test", binPath: "claude", features: {}, error: null,
      models: [{ id: "claude-test", displayName: "Claude Test", isDefault: true }] },
    { engineType: "codex", installed: true, version: "test", binPath: "codex", features: {}, error: null,
      models: [{ id: "codex-test", displayName: "Codex Test", isDefault: true }] },
  ] }), { headers: { "content-type": "application/json" } });
}

test("输入框展示当前工作区引擎读取根因，加载和空目录有各自状态", () => {
  const engines = reactive({ byWorkspaceId: { ws: { lastError: "引擎状态请求超时", loading: false, lastUpdatedAt: null as number | null } } });
  const context = { computed, engines, props: { workspaceId: "ws" }, modelCatalogReady: ref(false) };
  const issue = execute(functions(source("features/composer/components/chat-composer.vue"), ["currentModelProviderIssue"]), context, "currentModelProviderIssue");
  assert.match(issue.value, /引擎状态请求超时/);
  engines.byWorkspaceId.ws.lastError = "";
  engines.byWorkspaceId.ws.loading = true;
  assert.match(issue.value, /检测|加载/);
  assert.doesNotMatch(issue.value, /没有可用模型/);
  engines.byWorkspaceId.ws.loading = false;
  engines.byWorkspaceId.ws.lastUpdatedAt = 1;
  assert.match(issue.value, /没有可用模型/);
});

/** 执行设置面板真实 watcher，保留原 generation 与 fail 处理边界。 */
function updateHarness(engines: ReturnType<typeof useEngineStore>) {
  const text = source("features/project-knowledge/components/knowledge-update-settings.vue");
  const props = { open: true, workspaceId: "ws", context: ctx }, logs: any[] = [];
  let changed!: (value: [boolean, string]) => void;
  const context = { props, engines, AbortController, Error, createApiResultError, isApiResultError, isCancelledRequestError,
    view: ref(null), errorText: ref(""), loading: ref(false), saving: ref(false), checking: ref(false),
    busy: ref(false), requestKnowledgeAsset: async () => ({ ok: true, data: { schedule: null } }), fill() {},
    console: { error: (...args: any[]) => logs.push(args) }, clearTimeout() {},
    watch: (_read: unknown, callback: typeof changed) => { changed = callback; }, onBeforeUnmount() {} };
  const vmContext = vm.createContext(context);
  const code = "let generation = 0, controller = null, timer = null;\n" + functions(text, ["queueRefresh", "load", "fail", "release"])
    + text.slice(text.indexOf("watch(() => [props.open"));
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, vmContext);
  return { props, logs, context, changed: () => changed([props.open, props.workspaceId]) };
}

test("定时更新面板的目录失败进入原错误区域且只记录一次", async t => {
  const h = updateHarness(engineFixture(t));
  h.changed();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(h.context.errorText.value, /engine status offline/);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][1].code, "KNOWLEDGE_MODEL_CATALOG_FAILED");
  assert.equal(h.logs[0][1].requestId, "engine-status-request");
});

test("定时更新面板关闭后同工作区重开，旧 generation 失败不覆盖新面板", async t => {
  const engines = engineFixture(t), h = updateHarness(engines);
  let reopened = false;
  // store 已拒绝但 watcher 的 catch 尚未执行时，同一工作区关闭后重开。
  engines.$onAction(({ name, onError }) => {
    if (name === "refresh") onError(() => {
      if (reopened) return;
      reopened = true;
      h.props.open = false; h.changed();
      globalThis.fetch = async () => engineResponse();
      h.props.open = true; h.changed();
    });
  });
  h.changed();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reopened, true);
  assert.equal(h.context.errorText.value, "");
  assert.equal(h.logs.length, 0);
});

test("新建会话刷新失败保留异常契约、禁用旧引擎且不读取 Key", async t => {
  const engines = engineFixture(t), workspace = ref("ws");
  let keyReads = 0;
  const context = { computed, ref, unref, Error, isCancelledRequestError, isApiResultError, resolveEngineUnavailableIssue, isSharedWorkspaceSelectionId,
    useApiContext: () => ({ ctx: ref(ctx) }), useEngineStore: () => engines,
    useEngineKeysStore: () => ({ refresh: async () => { keyReads++; }, hasKeysForEngine: () => true, providerIdsForEngine: () => [] }),
    message: { warning() {} } };
  const create = execute(functions(source("features/threads/useCreateThreadEngineAvailability.ts"), ["useCreateThreadEngineAvailability"]), context, "useCreateThreadEngineAvailability");
  const availability = create(workspace);
  await assert.rejects(availability.refreshEngineAvailability(), /engine status offline/);
  assert.match(availability.disabledEngines.value.codex, /无法读取引擎状态/);
  assert.match(availability.disabledEngines.value.claude, /无法读取引擎状态/);
  assert.equal(keyReads, 0);
  globalThis.fetch = async () => engineResponse();
  await availability.refreshEngineAvailability();
  assert.equal(keyReads, 1);
  assert.doesNotMatch(availability.disabledEngines.value.codex ?? "", /无法读取引擎状态/);
});

test("新建会话的旧工作区读取失败不污染新作用域或继续 Key 读取", async t => {
  const engines = engineFixture(t), workspace = ref("ws");
  let reject!: (error: unknown) => void, keyReads = 0;
  globalThis.fetch = async () => await new Promise<Response>((_resolve, fail) => { reject = fail; });
  const context = { computed, ref, unref, Error, isCancelledRequestError, resolveEngineUnavailableIssue, isSharedWorkspaceSelectionId,
    useApiContext: () => ({ ctx: ref(ctx) }), useEngineStore: () => engines,
    useEngineKeysStore: () => ({ refresh: async () => { keyReads++; }, hasKeysForEngine: () => false, providerIdsForEngine: () => [] }),
    message: { warning() {} } };
  const create = execute(functions(source("features/threads/useCreateThreadEngineAvailability.ts"), ["useCreateThreadEngineAvailability"]), context, "useCreateThreadEngineAvailability");
  const availability = create(workspace), pending = availability.refreshEngineAvailability();
  const rejected = assert.rejects(pending, /engine status offline/);
  workspace.value = "other"; reject(failure);
  await rejected;
  assert.doesNotMatch(availability.disabledEngines.value.codex ?? "", /无法读取引擎状态/);
  assert.equal(keyReads, 0);
});

test("手动打开新会话收口可用性异常并保留弹窗禁用态", async () => {
  const logs: any[] = [], messages: string[] = [];
  const context = { Error, isApiResultError, isCancelledRequestError, canOperate: ref(true), canCreateThread: ref(true), config: { workspaceId: "ws" },
    createOpen: ref(false), refreshThreadGroupsForCurrentWorkspace() {}, refreshEngineAvailability: async () => { throw failure; },
    message: { error: (text: string) => messages.push(text) }, console: { error: (...args: any[]) => logs.push(args) } };
  const openCreate = execute(functions(source("features/threads/components/thread-list.vue"), ["openCreate"]), context, "openCreate");
  await openCreate();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(context.createOpen.value, true);
  assert.equal(messages.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].workspaceId, "ws");
});

for (const [component, action] of [["requirement-analysis-workspace", "createSessionAction"], ["task-entry-sidebar", "createRequirementDraft"]]) {
  test(`${action} 收口引擎读取失败并保持创建弹窗的失败态`, async () => {
    const logs: any[] = [], messages: string[] = [];
    const context = { Error, isApiResultError, isCancelledRequestError, engineAvailabilityRequestGeneration: 0,
      props: { workspaceId: "ws" }, createOpen: ref(false), draftCreateOpen: ref(false),
      presence: { isCurrentWorkspaceClientOnline: true }, isSharedWorkspace: ref(false), analysis: {},
      refreshEngineAvailability: async () => { throw failure; },
      message: { error: (text: string) => messages.push(text) }, console: { error: (...args: any[]) => logs.push(args) } };
    const open = execute(functions(source(`features/orchestration/components/${component}.vue`), [action!]), context, action!);
    await open();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].workspaceId, "ws");
  });
  test(`${action} 不把旧请求失败显示到新工作区或重开的弹窗`, async () => {
    const logs: any[] = [], messages: string[] = [], failures: Array<(cause: unknown) => void> = [];
    const context = { Error, isApiResultError, isCancelledRequestError, engineAvailabilityRequestGeneration: 0,
      props: { workspaceId: "ws" }, createOpen: ref(false), draftCreateOpen: ref(false),
      presence: { isCurrentWorkspaceClientOnline: true }, isSharedWorkspace: ref(false), analysis: {},
      refreshEngineAvailability: () => new Promise<void>((_resolve, reject) => failures.push(reject)),
      message: { error: (text: string) => messages.push(text) }, console: { error: (...args: any[]) => logs.push(args) } };
    const open = execute(functions(source(`features/orchestration/components/${component}.vue`), [action!]), context, action!);
    open(); context.props.workspaceId = "other"; failures.shift()!(failure);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(messages.length, 0);
    open(); open(); failures.shift()!(failure);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(messages.length, 0);
    failures.shift()!(failure);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.equal(logs[0][1].workspaceId, "other");
  });
}

/** 运行批任务原刷新及构建设置入口，错误由原 reportError 翻译。 */
function batchHarness(engines: ReturnType<typeof useEngineStore>) {
  const text = source("features/project-knowledge/components/project-knowledge-page.vue"), logs: any[] = [];
  let validations = 0;
  const context: Record<string, any> = { Error, isApiResultError, isCancelledRequestError, engines, scopeEpoch: 1, workspaceId: ref("ws"), ctx: () => ctx,
    isCurrent: (epoch: number, scope: string) => epoch === 1 && scope === context.workspaceId.value,
    batchCatalog: computed(() => engines.byWorkspaceId[context.workspaceId.value]),
    canWrite: ref(true), busy: ref(false), buildSettingsMode: ref(false), pendingBuildIds: ref(null),
    batchMode: ref("batch"), batchError: ref<string | null>(null), batchOpen: ref(false),
    knowledgeModelPrefs: ref({ engine: "codex", model: "old-model", effort: null }),
    batchEngine: ref("codex"), batchModelId: ref(""), batchEffort: ref(""), buildPrefsError: ref(null),
    buildEngineIssue: () => { validations++; return "stale engine validation"; },
    errorDiagnostics: ref(null), selectedId: ref(null), activeRun: ref(null), assistantThreadId: ref(null),
    console: { error: (...args: any[]) => logs.push(args) } };
  const boundary = execute(functions(text, ["errorMessage", "reportError", "refreshBatchModels", "openBuildSettings"]), context, "({ refreshBatchModels, openBuildSettings })");
  return { boundary, context, logs, validations: () => validations };
}

test("批模型刷新显式失败并保留原错误信息，构建设置停止后续旧状态校验", async t => {
  const h = batchHarness(engineFixture(t));
  assert.equal(await h.boundary.refreshBatchModels(), false);
  assert.match(h.context.batchError.value!, /engine status offline/);
  assert.equal(h.logs.length, 1);
  h.logs.length = 0;
  await assert.doesNotReject(h.boundary.openBuildSettings(["node"]));
  assert.match(h.context.batchError.value!, /engine status offline/);
  assert.equal(h.validations(), 0);
  assert.equal(h.logs.length, 1);
  globalThis.fetch = async () => engineResponse();
  assert.equal(await h.boundary.refreshBatchModels(), true);
  assert.equal(h.context.batchError.value, null);
});

test("批模型刷新在切换工作区后失败，不覆盖当前工作区错误", async t => {
  const engines = engineFixture(t), h = batchHarness(engines);
  let reject!: (error: unknown) => void;
  globalThis.fetch = async () => await new Promise<Response>((_resolve, fail) => { reject = fail; });
  const pending = h.boundary.refreshBatchModels();
  h.context.workspaceId.value = "other"; h.context.batchError.value = "current error";
  reject(failure);
  assert.equal(await pending, false);
  assert.equal(h.context.batchError.value, "current error");
  assert.equal(h.logs.length, 0);
});

test("构建引擎配置检查后的目录失败不会被通用确认文案覆盖或创建任务", async t => {
  const engines = engineFixture(t), h = batchHarness(engines);
  let reads = 0, creates = 0;
  globalThis.fetch = async () => {
    if (++reads === 1) return engineResponse();
    throw failure;
  };
  Object.assign(h.context, {
    snapshot: ref({ treeHash: "tree" }), buildStarting: ref(false), updatesBusy: ref(false), binding: ref(false),
    formalNodeIds: ref(new Set(["node"])),
    bindingReady: ref(true), taskList: ref([]), knowledgeModelPrefs: ref({ engine: "codex", model: null, effort: null }),
    pendingBuild: ref(null), dismissError() {},
    createTaskConversation: async () => { creates++; throw new Error("must not create task"); },
  });
  const text = source("features/project-knowledge/components/project-knowledge-page.vue");
  const startBuild = execute(functions(text, ["errorMessage", "reportError", "refreshBatchModels", "openBuildSettings", "startBuild"]), h.context, "startBuild");
  await startBuild(["node"]);
  assert.match(h.context.batchError.value!, /engine status offline/);
  assert.equal(h.context.buildStarting.value, false);
  assert.equal(creates, 0);
  assert.equal(h.logs.length, 1);
});

for (const ids of [["candidate"], ["node", "candidate"]]) test(`非正式选区 ${ids.join("+")} 在创建任务和读取引擎前明确失败`, async t => {
  const h = batchHarness(engineFixture(t));
  let reads = 0, creates = 0;
  globalThis.fetch = async () => { reads++; return engineResponse(); };
  Object.assign(h.context, {
    snapshot: ref({ treeHash: "tree" }), buildStarting: ref(false), updatesBusy: ref(false), binding: ref(false),
    bindingReady: ref(true), taskList: ref([]), formalNodeIds: ref(new Set(["node"])), errorText: ref(null),
    createTaskConversation: async () => { creates++; throw new Error("must not create task"); },
  });
  const text = source("features/project-knowledge/components/project-knowledge-page.vue");
  const startBuild = execute(functions(text, ["errorMessage", "reportError", "startBuild"]), h.context, "startBuild");
  await startBuild(ids);
  assert.match(h.context.errorText.value, /尚未采用/);
  assert.equal(h.context.buildStarting.value, false);
  assert.equal(reads, 0);
  assert.equal(creates, 0);
  assert.equal(h.logs[0][1].code, "KNOWLEDGE_BUILD_SCOPE_UNAVAILABLE");
});
