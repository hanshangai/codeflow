import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as vue from "vue";
import { isComposerInputActionsEnabled } from "../src/features/composer/input-actions.ts";
import { resolveSubmitPathReferences } from "../src/features/composer/path-reference-submit.ts";
import { createApiResultError, isApiResultError } from "../src/api/request.ts";

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const files = {
  composer: new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  panel: new URL("../src/features/chat/components/chat-panel.vue", import.meta.url),
};
type Component = keyof typeof files;
type TemplateNode = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>["children"][number];

/** 执行实际 SFC 中的声明，测试依赖边界，不复制业务条件。 */
function evaluate(component: Component, names: string[], context: Record<string, unknown>): Record<string, any> {
  const descriptor = parse(readFileSync(files[component], "utf8")).descriptor;
  const ast = ts.createSourceFile("capabilities.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = names.map(name => {
    const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
      ? statement.name?.text === name
      : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.ok(node, `缺少实际声明 ${name}`);
    return node.getText(ast);
  });
  const sandbox = { computed: vue.computed, ref: vue.ref, isComposerInputActionsEnabled, ...context, result: {} };
  vm.runInNewContext(ts.transpileModule(`${statements.join("\n")}\nglobalThis.result = { ${names.join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox);
  return sandbox.result;
}

/** 在真实模板 AST 中定位入口，保留原节点上的可见性和禁用条件。 */
function findNode(nodes: TemplateNode[], predicate: (node: Extract<TemplateNode, { type: 1 }>) => boolean): Extract<TemplateNode, { type: 1 }> | undefined {
  for (const node of nodes) {
    if (node.type !== 1) continue;
    if (predicate(node)) return node;
    const child = findNode(node.children, predicate);
    if (child) return child;
  }
}

/** 编译原模板子树并读取实际 VNode，避免源码字符串断言。 */
function renderEntry(component: Component, match: string, context: Record<string, unknown>): vue.VNode[] {
  const descriptor = parse(readFileSync(files[component], "utf8")).descriptor;
  const node = findNode(descriptor.template!.ast!.children, candidate => candidate.tag === match || candidate.props.some(prop =>
    prop.type === 6 && (prop.name === "class" || prop.name === "aria-label") && prop.value?.content === match));
  assert.ok(node, `缺少模板入口 ${match}`);
  const compiled = compileTemplate({ source: node.loc.source, filename: files[component].pathname, id: "desktop-chat-capabilities",
    compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: tag => !tag.startsWith("a-") } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name,
    renderSlot: () => vue.createVNode(vue.Fragment, {}, []) }) as (context: Record<string, unknown>, cache: unknown[]) => vue.VNode;
  const nodes: vue.VNode[] = [];
  /** 展开 Fragment 和元素子节点，保留入口自身 props。 */
  function visit(value: unknown): void {
    if (!vue.isVNode(value)) return;
    nodes.push(value);
    if (Array.isArray(value.children)) value.children.forEach(visit);
  }
  visit(render(context, []));
  return nodes;
}

test("本机离线普通会话开放附件、Slash/技能和文件提示，受控会话保持原边界", () => {
  const props = vue.reactive({ surface: "default", disabled: false });
  const thread = vue.ref({ threadType: "chat", threadSubtype: null as string | null });
  const blocked = vue.ref(false);
  const values = evaluate("composer", ["canAddAttachments", "inputActionsEnabled", "composerPlaceholder"], {
    props, thread, composerWriteBlocked: blocked, localChatReady: vue.ref(true), isKnowledgeSession: vue.ref(false), engine: vue.ref("codex"), isMobile: false,
  });
  assert.equal(values.canAddAttachments.value, true);
  assert.equal(values.inputActionsEnabled.value, true);
  assert.match(values.composerPlaceholder.value, /@ 文件/u);
  blocked.value = true;
  assert.equal(values.canAddAttachments.value, false);
  for (const subtype of ["node", "knowledge-assets", "requirement-analysis"]) {
    thread.value.threadSubtype = subtype;
    assert.equal(values.inputActionsEnabled.value, false);
  }
  thread.value.threadSubtype = null;
  props.surface = "h5";
  assert.equal(values.inputActionsEnabled.value, false);
  assert.equal(values.composerPlaceholder.value, "输入消息");
});

test("本机附件和上下文入口真实渲染，并保留只读与 H5 条件", () => {
  const base = { props: { surface: "default" }, localChatReady: true, composerWriteBlocked: false, handleOpenFilePicker() {},
    engine: "codex", stableTokenUsage: null, effectiveContextWindow: 200000, contextActionsDisabled: false, handleCompactContext() {}, handleResetContext() {} };
  assert.ok(renderEntry("composer", "添加附件", base).some(node => node.props?.["aria-label"] === "添加附件"));
  assert.ok(renderEntry("composer", "composer__context-bar", base).some(node => node.type === "ContextUsageBar"));
  assert.equal(renderEntry("composer", "添加附件", { ...base, composerWriteBlocked: true }).find(node => node.props?.["aria-label"] === "添加附件")?.props?.disabled, true);
  assert.equal(renderEntry("composer", "composer__context-bar", { ...base, props: { surface: "h5" } }).some(node => node.type === "ContextUsageBar"), false);
});

test("本机普通会话恢复 Spec/WorkFlow、文件变更与托管进程，节点和助手保持限制", () => {
  const props = vue.reactive({ surface: "default", assistantMode: false });
  const thread = vue.ref({ threadType: "chat", threadSubtype: null as string | null });
  const assistant = vue.ref(false), shared = vue.ref(false);
  const values = evaluate("panel", ["chatWorkflowVisible", "chatWorkflowToggleVisible", "chatKnowledgeToggleVisible", "fileChangeCount", "managedServicesVisible"], {
    props, thread, localChatReady: vue.ref(true), effectiveAssistantMode: assistant, isSharedWorkspace: shared,
    fileChangesState: vue.ref({ items: [{ path: "src/example.ts" }] }), managedServicesScope: vue.ref({ visible: true }),
  });
  assert.equal(values.chatWorkflowToggleVisible.value, true);
  assert.equal(values.chatKnowledgeToggleVisible.value, true);
  assert.equal(values.fileChangeCount.value, 1);
  assert.equal(values.managedServicesVisible.value, true);
  props.surface = "h5";
  assert.equal(values.chatWorkflowToggleVisible.value, false);
  props.surface = "default";
  thread.value.threadSubtype = "node";
  assert.equal(values.chatKnowledgeToggleVisible.value, false);
  assistant.value = true;
  assert.equal(values.managedServicesVisible.value, false);
  assistant.value = false;
  shared.value = true;
  assert.equal(values.managedServicesVisible.value, false);
});

test("本机 @ 文件输入会触发候选搜索，提交校验真实路径", async () => {
  const searches: string[] = [], stats: unknown[] = [];
  const values = evaluate("composer", ["refreshMentionStateAfterInput", "resolvePathReferencesForSubmit"], {
    localChatReady: vue.ref(true), props: { threadId: "thread" }, ctx: vue.ref({}), mentionTokenRange: vue.ref(null), closeMentionPicker() {},
    resolveActiveMentionToken: () => ({ start: 0, end: 14, query: "src/example.ts", quoted: false }),
    scheduleMentionSearch: (query: string) => searches.push(query), resolveSubmitPathReferences,
    fetchFsStat: async (_context: unknown, input: unknown) => { stats.push(input); return { ok: true, exists: true, isDir: false }; },
  });
  values.refreshMentionStateAfterInput({});
  assert.deepEqual(searches, ["src/example.ts"]);
  const references = await values.resolvePathReferencesForSubmit({ text: "检查 @src/example.ts", workspaceId: "local:ws", existingReferences: [] });
  assert.equal(stats.length, 1);
  assert.equal(references[0]?.path, "src/example.ts");
});

test("本机辅助面板加载调用原 store，保留共享工作区边界", async () => {
  const calls: string[] = [], shared = vue.ref(false);
  const values = evaluate("panel", ["prefetchFileChanges", "prefetchManagedServices"], {
    isSharedWorkspace: shared, localChatReady: vue.ref(true), props: { workspaceId: "local:ws" }, ctx: vue.ref({}),
    chat: { refreshThreadFileChanges: async () => { calls.push("files"); }, refreshThreadManagedServices: async () => { calls.push("services"); } },
  });
  await values.prefetchFileChanges("thread");
  await values.prefetchManagedServices("thread");
  assert.deepEqual(calls, ["files", "services"]);
  shared.value = true;
  await values.prefetchFileChanges("thread");
  await values.prefetchManagedServices("thread");
  assert.equal(calls.length, 2);
});

test("本机工作流开关经本机就绪加载", async () => {
  let reads = 0;
  const state = vue.ref(false);
  const values = evaluate("composer", ["refreshWorkflowPreference"], {
    workflowPrefVersion: 0, props: { workspaceId: "local:ws", threadId: "thread", workflowToggleVisible: true }, config: { connected: false },
    composerConnected: vue.ref(true), recommendationEnabled: state, ctx: vue.ref({}),
    getChatWorkflow: async () => { reads++; return { ok: true, recommendationEnabled: true }; },
  });
  await values.refreshWorkflowPreference();
  assert.equal(reads, 1);
  assert.equal(state.value, true);
});

test("本机常用提示词入口保留原账号能力，未登录明确禁用", () => {
  const base = { props: { surface: "default" }, localChatReady: true, composerWriteBlocked: false, composerWriteBlockedReason: "",
    insertQuickPhrase() {}, engine: "codex", selectedModelProviderId: "openai", hasSettingsContent: false, $slots: {},
    config: { authMode: "account", isAuthenticated: true }, quickPhrasesAvailable: true };
  assert.ok(renderEntry("composer", "composer__toolbar-secondary", base).some(node => node.type === "QuickPhrasePicker"));
  const anonymous = renderEntry("composer", "composer__toolbar-secondary", { ...base, quickPhrasesAvailable: false, config: { authMode: null, isAuthenticated: false } });
  assert.equal(anonymous.some(node => node.type === "QuickPhrasePicker"), false);
  const unavailable = anonymous.find(node => node.props?.["aria-label"] === "常用提示词");
  assert.equal(unavailable?.props?.disabled, true);
  assert.match(unavailable?.props?.title ?? "", /登录/u);
});

test("常用提示词可用状态由原账号登录和有效会话计算", () => {
  const config = vue.reactive({ isAccountSession: true, hasActiveSession: true, userSummary: { userId: "account" } as { userId: string } | null });
  const values = evaluate("composer", ["quickPhrasesAvailable"], { config });
  assert.equal(values.quickPhrasesAvailable.value, true);
  config.hasActiveSession = false;
  assert.equal(values.quickPhrasesAvailable.value, false);
  config.hasActiveSession = true;
  config.userSummary = null;
  assert.equal(values.quickPhrasesAvailable.value, false);
});

test("路径校验失败停止引用处理并保留 requestId，不发送残缺路径", async () => {
  const failure = createApiResultError({ ok: false, code: "CLIENT_ERROR", message: "读取路径失败", details: { requestId: "path-request" } });
  const logs: Record<string, unknown>[] = [];
  let stats = 0;
  const values = evaluate("composer", ["describeWorkflowFailure", "resolvePathReferencesForSubmit"], {
    props: { threadId: "thread" }, ctx: vue.ref({}), resolveSubmitPathReferences, isApiResultError, createApiResultError,
    fetchFsStat: async () => { stats++; throw failure; }, console: { error: (_label: string, details: Record<string, unknown>) => logs.push(details) },
  });
  await assert.rejects(values.resolvePathReferencesForSubmit({ text: "@src/first.ts @src/second.ts", workspaceId: "local:ws", existingReferences: [] }), error => error === failure);
  assert.equal(stats, 1);
  assert.equal(logs[0]?.requestId, "path-request");
  assert.equal(logs[0]?.threadId, "thread");
});

test("工作流偏好读取失败明确拒绝并提示，不把上次启用状态改为关闭", async () => {
  const failure = createApiResultError({ ok: false, code: "CLIENT_ERROR", message: "读取工作流失败", details: { requestId: "workflow-request" } });
  const errors: string[] = [], logs: Record<string, unknown>[] = [];
  const enabled = vue.ref(true);
  const values = evaluate("composer", ["describeWorkflowFailure", "refreshWorkflowPreference"], {
    workflowPrefVersion: 0, props: { workspaceId: "local:ws", threadId: "thread", workflowToggleVisible: true }, composerConnected: vue.ref(true),
    recommendationEnabled: enabled, ctx: vue.ref({}), createApiResultError, isApiResultError,
    getChatWorkflow: async () => { throw failure; }, message: { error: (value: string) => errors.push(value) },
    console: { warn: (_label: string, details: Record<string, unknown>) => logs.push(details) },
  });
  await assert.rejects(values.refreshWorkflowPreference(), error => error === failure);
  assert.equal(enabled.value, true);
  assert.equal(errors.length, 1);
  assert.equal(logs[0]?.requestId, "workflow-request");
});

test("辅助资源失败向上拒绝，零条数据时仍展示失败和重试入口", async () => {
  const failure = new Error("资源加载失败");
  const files = vue.ref({ items: [], error: "资源加载失败" });
  const services = vue.ref({ items: [], error: "资源加载失败" });
  const values = evaluate("panel", ["fileChangeCount", "prefetchFileChanges", "prefetchManagedServices"], {
    isSharedWorkspace: vue.ref(false), props: { workspaceId: "local:ws" }, ctx: vue.ref({}), fileChangesState: files,
    managedServicesState: services, managedServiceCount: vue.ref(0), managedServicesVisible: vue.ref(true),
    chat: { refreshThreadFileChanges: async () => { throw failure; }, refreshThreadManagedServices: async () => { throw failure; } },
  });
  await assert.rejects(values.prefetchFileChanges("thread"), error => error === failure);
  await assert.rejects(values.prefetchManagedServices("thread"), error => error === failure);
  assert.equal(values.fileChangeCount.value, 0);
  const context = { effectiveAssistantMode: false, fileChangeCount: 0, fileChangesState: files.value,
    managedServiceCount: 0, managedServicesVisible: true, managedServicesState: services.value, refreshFileChanges() {}, refreshManagedServices() {} };
  for (const label of ["文件变更加载失败", "进程加载失败"]) {
    const node = renderEntry("panel", label, context)[0]!;
    assert.equal(node.props?.message, "资源加载失败");
    const actions = node.children as { action: () => vue.VNode[] };
    const button = actions.action()[0]!;
    assert.equal(typeof button.props?.onClick, "function");
  }
});

test("本机消息维护入口恢复，助手和只读会话保持禁用", () => {
  const base = { props: { workspaceId: "local:ws" }, localChatReady: true, effectiveAssistantMode: false, canWrite: true,
    displayItems: [], thread: { engine: "codex" }, completedTurnIds: { message: "turn" }, listBusy: false, deletingMessageId: null,
    confirmMessageDelete() {}, confirmRollback() {}, closeSystemMessage() {} };
  const node = renderEntry("panel", "MessagesList", base).find(value => value.type === "MessagesList")!;
  assert.equal(node.props?.["can-delete"], true);
  assert.equal(node.props?.["completed-turn-ids"], base.completedTurnIds);
  assert.equal(renderEntry("panel", "MessagesList", { ...base, canWrite: false })[0]?.props?.["can-delete"], false);
  const assistant = renderEntry("panel", "MessagesList", { ...base, effectiveAssistantMode: true })[0]!;
  assert.equal(assistant.props?.["can-delete"], false);
  assert.equal(assistant.props?.["completed-turn-ids"], undefined);
});

test("本机进程详情在断云时沿原连接状态轮询", async () => {
  const descriptor = parse(readFileSync(files.panel, "utf8")).descriptor;
  const ast = ts.createSourceFile("poll.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const watcher = ast.statements.find(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(ast) === "watch" && statement.getText(ast).includes("managedServiceDetailPollTimer"));
  assert.ok(watcher);
  let tick: (() => void) | undefined;
  let refreshes = 0;
  const sandbox = {
    config: { connected: false }, chatConnected: vue.ref(true), activeThreadId: vue.ref("thread"), managedServicesScopeKey: vue.ref("thread"),
    managedServicesPanelVisible: vue.ref(true), managedServicesExpanded: vue.ref(true), managedServicesModalOpen: vue.ref(false),
    managedServicesHasLiveItems: vue.ref(true), selectedThreadSettled: vue.ref(true), effectiveAssistantMode: vue.ref(false),
    managedServiceDetailPollTimer: null, setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval() {},
    prefetchManagedServices: async () => { refreshes++; }, showAsyncError(error: unknown) { throw error; },
    watch: (source: () => unknown[], callback: (values: unknown[]) => void) => callback(source()),
  };
  vm.runInNewContext(ts.transpileModule(watcher.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  assert.ok(tick, "本机就绪应启动原进程详情轮询");
  tick();
  await Promise.resolve();
  assert.equal(refreshes, 1);
  sandbox.chatConnected.value = false;
  tick();
  assert.equal(refreshes, 1);
});

test("真实发送分支允许本机空云会话执行维护命令，远程仍要求 Web 会话", async () => {
  for (const localReady of [true, false]) {
    for (const action of ["compact", "new", "clear"]) {
      const commands: string[] = [], warnings: string[] = [];
      const values = evaluate("composer", ["send"], {
        props: { workspaceId: localReady ? "local:ws" : "remote:ws", threadId: "thread", allowQueue: true, runningTurnId: null },
        config: { webSessionId: null, connected: false }, localChatReady: vue.ref(localReady), nextTick: vue.nextTick,
        pendingReads: vue.ref(0), draftScopeEpoch: 1, draftWorkspaceScopeToken: "workspace", draftEditSeq: 1,
        snapshotDraft: () => ({ text: `/${action}` }), currentComposerInputSubmission: vue.ref({ mode: "host-action", action, rawText: `/${action}` }),
        imageAttachments: vue.ref([]), textFileAttachments: vue.ref([]), pathReferences: vue.ref([]), skillMentions: vue.ref([]),
        threadQueueStore: { itemCountFor: () => 0 }, resolveRoleIdForSend: () => null, validateComposerActionSubmission: () => null,
        composerWriteBlocked: vue.ref(false), composerWriteBlockedReason: vue.ref(""), sending: vue.ref(false), sendingViaQueue: vue.ref(false), currentClientItemId: vue.ref("draft"),
        executeCodexHostAction: async (submission: { action: string }) => { commands.push(submission.action); return { successMessage: "命令已执行" }; },
        clearSubmittedDraftAfterSuccess() {}, message: { warning: (value: string) => warnings.push(value), success() {}, error(error: unknown) { throw error; } },
      });
      await values.send();
      assert.deepEqual(commands, localReady ? [action] : [], `${localReady ? "本机" : "远程"} /${action}`);
      assert.equal(warnings.length, localReady ? 0 : 1);
    }
  }
});
