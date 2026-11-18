import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { computed, nextTick, reactive, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "../src/store/chat.ts";

/** 执行真实提交与按钮计算，仅控制传输完成时机和无关输入资源。 */
function fixture(opts: { clearFailures?: number } = {}) {
  let clearFailures = opts.clearFailures ?? 0;
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("composer.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["sending", "sendingViaQueue", "sendButtonLabel", "send", "clearSubmittedDraftAfterSuccess", "clearRemoteDraftAfterSubmit"]);
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast))));
  let resolve!: () => void, reject!: (error: unknown) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const props = reactive({ allowQueue: true, runningTurnId: null as string | null, workspaceId: "workspace", threadId: "thread", disabled: false });
  const enqueueMode = computed(() => Boolean(props.runningTurnId));
  const draft = ref("分析项目"), errors: unknown[] = [], messageErrors: unknown[] = [], calls: string[] = [], cleared: string[] = [],
    notices: string[] = [], localDrafts: Array<[string, unknown]> = [];
  const pendingDrafts: Record<string, { text: string }> = {};
  const pendingDraftEpochs: Record<string, number> = {};
  const cachedDrafts: Record<string, { text: string } | null> = {};
  const context = vm.createContext({ ref, computed, nextTick, props, enqueueMode, text: draft,
    pendingReads: ref(false), draftScopeEpoch: 1, draftWorkspaceScopeToken: 1, draftEditSeq: 1,
    snapshotDraft: () => ({ text: draft.value }),
    sameThreadDraftPayloadContent: (left: { text: string }, right: { text: string }) => left.text === right.text,
    currentComposerInputSubmission: computed(() => ({ mode: "message", text: draft.value })),
    imageAttachments: ref([]), textFileAttachments: ref([]), pathReferences: ref([]), skillMentions: ref([]),
    threadQueueStore: { itemCountFor: () => 0, async append() { calls.push("enqueue"); await pending; } },
    resolveRoleIdForSend: () => null, validateComposerActionSubmission: () => null,
    flatModelOptions: ref([]), model: ref("model"), currentModelProviderIssue: ref(null), canSend: computed(() => !context.isSending()),
    workMode: ref("general"), planMode: ref(false), accessMode: ref("full-access"), effort: ref("high"),
    resolveContextWindowForSend: () => undefined, resolveAutoCompactPctForSend: () => 80,
    resolveCodexServiceTierForSend: () => null, relayBalanceReminderRef: ref(null),
    resolvePathReferencesForSubmit: async () => [], validateInlineThreadPayload: () => ({ ok: true }),
    ensureClientItemId: () => "submission", currentClientItemId: ref("submission"), ctx: ref({}),
    chat: { async sendMessage() { calls.push("send"); await pending; },
      isThreadDraftWorkspaceScopeCurrent: (token: number) => token === context.draftWorkspaceScopeToken,
      pendingLocalThreadDraftByThreadId: pendingDrafts,
      pendingLocalThreadDraftEpochByThreadId: pendingDraftEpochs,
      threadDraftByThreadId: cachedDrafts,
      clearPendingLocalThreadDraft(threadId: string, expectedEpoch?: number) {
        if (expectedEpoch != null && pendingDraftEpochs[threadId] !== expectedEpoch) return false;
        delete pendingDrafts[threadId];
        delete pendingDraftEpochs[threadId];
        return true;
      },
      setThreadDraft(threadId: string, value: unknown) { localDrafts.push([threadId, value]); },
      async clearThreadDraft(_ctx: unknown, _workspace: string, thread: string) {
        if (clearFailures > 0) { clearFailures -= 1; throw new Error("缺少 webSessionId（请先 WS 连接成功）"); }
        cleared.push(thread);
      } },
    cancelDraftSave() {}, skipNextDraftWatch: false, draftDirty: true, currentDraftVersion: ref(1),
    preserveInputContractTextMutation: false, inputKind: ref(undefined),
    closeInputActionPicker() {}, closeImagePreview() {}, closeTextFilePreview() {}, clearAttachments() {},
    isApiResultError: () => false, isCancelledRequestError: () => false, describeWorkflowFailure: () => ({}), settingsOpen: ref(false),
    console: { error: (...args: unknown[]) => { errors.push(args); }, warn: () => {} },
    message: { error: (error: unknown) => { errors.push(error); messageErrors.push(error); }, warning: (notice: string) => { notices.push(notice); } },
    setTimeout: (fn: () => void) => setImmediate(fn),
    config: { workspaceId: "workspace", webSessionId: null }, localChatReady: ref(true), composerConnected: ref(true),
    isNodeExecutionThread: ref(false), engineCliMissing: ref(false),
    hasComposerPayload: computed(() => Boolean(draft.value)),
  });
  const code = ts.transpileModule(selected.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(`${code}\nglobalThis.runSend = send; globalThis.buttonLabel = () => sendButtonLabel.value; globalThis.isSending = () => sending.value;`, context);
  return { props, draft, errors, messageErrors, calls, cleared, notices, localDrafts, pendingDrafts, pendingDraftEpochs, resolve, reject,
    send: () => context.runSend() as Promise<void>,
    /** 模拟既有切换 watcher 更新草稿代际，不触发任何真实传输。 */
    switchDraft(scope: "workspace" | "thread") {
      if (scope === "workspace") { props.workspaceId = "next-workspace"; context.draftWorkspaceScopeToken++; }
      else {
        pendingDraftEpochs["thread"] = 1;
        pendingDrafts["thread"] = { text: draft.value };
      }
      props.threadId = "next-thread"; context.draftScopeEpoch++;
      draft.value = "新会话草稿"; context.currentClientItemId.value = "next-submission";
    },
    reopenOriginalThread() {
      props.threadId = "thread"; context.draftScopeEpoch++;
      draft.value = "分析项目";
    },
    submissionId: () => context.currentClientItemId.value as string | null,
    label: () => context.buttonLabel() as string, sending: () => context.isSending() as boolean };
}

test("直发等待受理期间收到运行事件，文案保持发送中，回包后才清理草稿", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["send"]);
  f.props.runningTurnId = "accepted-turn";
  assert.equal(f.label(), "发送中");
  assert.equal(f.draft.value, "分析项目");
  f.resolve(); await sending;
  assert.equal(f.sending(), false);
  assert.equal(f.draft.value, "");
});

test("入队等待期间旧回合结束，文案保持入队中", async () => {
  const f = fixture(); f.props.runningTurnId = "running-turn";
  const sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["enqueue"]);
  f.props.runningTurnId = null;
  assert.equal(f.label(), "入队中");
  f.resolve(); await sending;
  assert.equal(f.sending(), false);
});

test("发送失败退出加载态并保留原草稿、错误日志与提示", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.reject(new Error("发送未受理")); await sending;
  assert.equal(f.sending(), false);
  assert.equal(f.draft.value, "分析项目");
  assert.equal(f.errors.length, 2);
});

test("发送成功后立即清本地草稿缓存，云端清理瞬时失败会重试成功", async () => {
  const f = fixture({ clearFailures: 1 }), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.resolve(); await sending;
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.draft.value, "");
  assert.deepEqual(f.localDrafts, [["thread", null]]);
  assert.deepEqual(f.cleared, ["thread"]);
  assert.equal(f.messageErrors.length, 0);
  assert.equal(f.notices.length, 0);
});

test("云端草稿清理持续失败只告警，不误报发送失败", async () => {
  const f = fixture({ clearFailures: 2 }), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.resolve(); await sending;
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.draft.value, "");
  assert.deepEqual(f.cleared, []);
  assert.equal(f.messageErrors.length, 0);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /草稿已在本机清除/u);
});

test("未收到受理回包时重复提交不会再次发送", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.props.runningTurnId = "accepted-turn";
  await f.send();
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.draft.value, "分析项目");
  f.resolve(); await sending;
});

test("发送等待期间切换 workspace，旧回包保留新草稿和幂等键", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.switchDraft("workspace"); f.resolve(); await sending;
  assert.equal(f.draft.value, "新会话草稿");
  assert.equal(f.submissionId(), "next-submission");
  assert.equal(f.sending(), false);
  assert.deepEqual(f.cleared, []);
  assert.equal(f.notices.length, 1);
});

test("发送等待期间切换 thread 后成功清除旧草稿并保留新输入和幂等键", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.switchDraft("thread"); f.resolve(); await sending;
  assert.equal(f.draft.value, "新会话草稿");
  assert.equal(f.submissionId(), "next-submission");
  assert.equal(f.sending(), false);
  assert.deepEqual(f.localDrafts, [["thread", null]]);
  assert.deepEqual(f.cleared, ["thread"]);
  assert.equal(f.notices.length, 0);
});

test("切走后旧会话草稿被修改时，成功回包不清除新草稿", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.switchDraft("thread");
  f.pendingDrafts.thread = { text: "旧会话后来输入的新草稿" };
  f.pendingDraftEpochs.thread = 2;
  f.resolve(); await sending;
  assert.equal(f.draft.value, "新会话草稿");
  assert.deepEqual(f.localDrafts, []);
  assert.deepEqual(f.cleared, []);
  assert.equal(f.pendingDrafts.thread.text, "旧会话后来输入的新草稿");
  assert.equal(f.notices.length, 1);
});

test("发送等待期间切走又切回，只有仍是已发送内容时才清除当前输入", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.switchDraft("thread");
  f.reopenOriginalThread();
  f.resolve(); await sending;
  assert.equal(f.draft.value, "");
  assert.deepEqual(f.localDrafts, [["thread", null]]);
  assert.deepEqual(f.cleared, ["thread"]);
});

test("输出保存失败仍可点击终止，已有保存中或断线状态保持禁用", async () => {
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  const ast = ts.createSourceFile("composer.ts", source.slice(source.indexOf(">") + 1, source.indexOf("</script>")), ts.ScriptTarget.Latest, true);
  const names = new Set(["primaryActionDisabled", "interrupt"]);
  const selected = ast.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast))));
  let calls = 0;
  const context = vm.createContext({ computed, props: { runningTurnId: "turn", workspaceId: "workspace", threadId: "thread" },
    primaryActionIsStop: ref(true), composerConnected: ref(true), interrupting: ref(false), turnDraining: ref(false), turnSaveFailed: ref(true),
    canSend: ref(false), ctx: ref({}), chat: { async interruptTurn() { calls++; } },
    message: { info() {}, success() {} }, console,
  });
  vm.runInContext(ts.transpileModule(selected.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText + "\nglobalThis.disabled = () => primaryActionDisabled.value; globalThis.stop = interrupt;", context);
  assert.equal(context.disabled(), false);
  await context.stop();
  assert.equal(calls, 1);
  context.turnDraining.value = true;
  assert.equal(context.disabled(), true);
  await context.stop();
  assert.equal(calls, 1);
  context.turnDraining.value = false; context.composerConnected.value = false;
  assert.equal(context.disabled(), true);
});

test("草稿清理排在旧保存后时，切换会话不取消远端清理", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const originalFetch = globalThis.fetch;
  const workspaceId = "client-a:submitted-draft" as any, threadId = "submitted-draft-thread" as any;
  const requests: string[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/threads/draft/save") {
      await saveGate;
      return Response.json({ ok: true, version: 1, updatedAt: 1 });
    }
    if (path === "/api/threads/draft/clear") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "test-web" };
    const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "已发送", images: [], files: [] });
    const saveSettled = saving.then(() => undefined, error => error);
    await new Promise(resolve => setImmediate(resolve));
    const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId);
    const clearSettled = clearing.then(() => undefined, error => error);
    chat.invalidateThreadScopes(threadId, { reason: "selection-change" });
    releaseSave();
    await saveSettled;
    await clearSettled;
    assert.deepEqual(requests, ["/api/threads/draft/save", "/api/threads/draft/clear"]);
  } finally {
    releaseSave();
    globalThis.fetch = originalFetch;
  }
});

test("清空会话会使此前排队的草稿写入失效", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const originalFetch = globalThis.fetch;
  const workspaceId = "client-a:clear-draft-queue" as any, threadId = "clear-draft-queue-thread" as any;
  const requests: string[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/threads/draft/save") {
      await saveGate;
      return Response.json({ ok: true, version: 1, updatedAt: 1 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "test-web" };
    const activeSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "在途写入", images: [], files: [] });
    const activeSettled = activeSave.then(() => undefined, error => error);
    await new Promise(resolve => setImmediate(resolve));
    const obsoleteSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "待清理写入", images: [], files: [] });
    const obsoleteSettled = obsoleteSave.then(() => undefined, error => error);
    chat.invalidateThreadScopes(threadId, { reason: "clear" });
    releaseSave();
    await activeSettled;
    await obsoleteSettled;
    assert.deepEqual(requests, ["/api/threads/draft/save"]);
  } finally {
    releaseSave();
    globalThis.fetch = originalFetch;
  }
});

test("rollback 失效屏障会取消此前排队的草稿写入", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const originalFetch = globalThis.fetch;
  const workspaceId = "client-a:rollback-draft-queue" as any, threadId = "rollback-draft-queue-thread" as any;
  const requests: string[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/threads/draft/save") {
      await saveGate;
      return Response.json({ ok: true, version: 1, updatedAt: 1 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "test-web" };
    const activeSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "在途写入", images: [], files: [] });
    const activeSettled = activeSave.then(() => undefined, error => error);
    await new Promise(resolve => setImmediate(resolve));
    const obsoleteSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "待回滚写入", images: [], files: [] });
    const obsoleteSettled = obsoleteSave.then(() => undefined, error => error);
    chat.prepareThreadRollbackHistoryReload(threadId, 1);
    releaseSave();
    await activeSettled;
    await obsoleteSettled;
    assert.deepEqual(requests, ["/api/threads/draft/save"]);
  } finally {
    releaseSave();
    globalThis.fetch = originalFetch;
  }
});

test("rollback 缺少事件屏障且本地无历史时也取消此前排队的草稿写入", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const originalFetch = globalThis.fetch;
  const originalLoadThread = chat.loadThread;
  const originalRefreshFileChanges = chat.refreshThreadFileChanges;
  const workspaceId = "client-a:rollback-missing-barrier" as any, threadId = "rollback-missing-barrier-thread" as any;
  const requests: string[] = [];
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/threads/draft/save") {
      await saveGate;
      return Response.json({ ok: true, version: 1, updatedAt: 1 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  chat.loadThread = async () => undefined;
  chat.refreshThreadFileChanges = async () => undefined;
  try {
    const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "test-web" };
    const activeSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "在途写入", images: [], files: [] });
    const activeSettled = activeSave.then(() => undefined, error => error);
    await new Promise(resolve => setImmediate(resolve));
    const obsoleteSave = chat.saveThreadDraft(ctx, workspaceId, threadId, { text: "屏障缺失前的旧写入", images: [], files: [] });
    const obsoleteSettled = obsoleteSave.then(() => undefined, error => error);
    await chat.reconcileMutationRollbackResponse(ctx, { workspaceId, threadId }, {
      rollbackReconciled: true, rollbackEventSeqBarrier: null, rollbackProjectionSyncWarning: null,
    });
    releaseSave();
    await activeSettled;
    await obsoleteSettled;
    assert.deepEqual(requests, ["/api/threads/draft/save"]);
  } finally {
    releaseSave();
    chat.loadThread = originalLoadThread;
    chat.refreshThreadFileChanges = originalRefreshFileChanges;
    globalThis.fetch = originalFetch;
  }
});
