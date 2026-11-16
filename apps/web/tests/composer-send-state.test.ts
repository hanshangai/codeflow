import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { computed, nextTick, reactive, ref } from "vue";

/** 执行真实提交与按钮计算，仅控制传输完成时机和无关输入资源。 */
function fixture() {
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("composer.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["sending", "sendingViaQueue", "sendButtonLabel", "send", "clearSubmittedDraftAfterSuccess"]);
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast))));
  let resolve!: () => void, reject!: (error: unknown) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const props = reactive({ allowQueue: true, runningTurnId: null as string | null, workspaceId: "workspace", threadId: "thread", disabled: false });
  const enqueueMode = computed(() => Boolean(props.runningTurnId));
  const draft = ref("分析项目"), errors: unknown[] = [], calls: string[] = [], cleared: string[] = [], notices: string[] = [];
  const context = vm.createContext({ ref, computed, nextTick, props, enqueueMode, text: draft,
    pendingReads: ref(false), draftScopeEpoch: 1, draftWorkspaceScopeToken: 1, draftEditSeq: 1,
    snapshotDraft: () => ({ text: draft.value }),
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
      clearPendingLocalThreadDraft() {}, async clearThreadDraft(_ctx: unknown, _workspace: string, thread: string) { cleared.push(thread); } },
    cancelDraftSave() {}, skipNextDraftWatch: false, draftDirty: true, currentDraftVersion: ref(1),
    preserveInputContractTextMutation: false, inputKind: ref(undefined),
    closeInputActionPicker() {}, closeImagePreview() {}, closeTextFilePreview() {}, clearAttachments() {},
    isApiResultError: () => false, describeWorkflowFailure: () => ({}),
    console: { error: (...args: unknown[]) => { errors.push(args); } },
    message: { error: (error: unknown) => { errors.push(error); }, warning: (notice: string) => { notices.push(notice); } },
    config: { workspaceId: "workspace", webSessionId: null }, localChatReady: ref(true), composerConnected: ref(true),
    isNodeExecutionThread: ref(false), engineCliMissing: ref(false),
    hasComposerPayload: computed(() => Boolean(draft.value)),
  });
  const code = ts.transpileModule(selected.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(`${code}\nglobalThis.runSend = send; globalThis.buttonLabel = () => sendButtonLabel.value; globalThis.isSending = () => sending.value;`, context);
  return { props, draft, errors, calls, cleared, notices, resolve, reject, send: () => context.runSend() as Promise<void>,
    /** 模拟既有切换 watcher 更新草稿代际，不触发任何真实传输。 */
    switchDraft(scope: "workspace" | "thread") {
      if (scope === "workspace") { props.workspaceId = "next-workspace"; context.draftWorkspaceScopeToken++; }
      props.threadId = "next-thread"; context.draftScopeEpoch++;
      draft.value = "新会话草稿"; context.currentClientItemId.value = "next-submission";
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

test("未收到受理回包时重复提交不会再次发送", async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.props.runningTurnId = "accepted-turn";
  await f.send();
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.draft.value, "分析项目");
  f.resolve(); await sending;
});

for (const scope of ["thread", "workspace"] as const) test(`发送等待期间切换 ${scope}，旧回包保留新草稿和幂等键`, async () => {
  const f = fixture(), sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  f.switchDraft(scope); f.resolve(); await sending;
  assert.equal(f.draft.value, "新会话草稿");
  assert.equal(f.submissionId(), "next-submission");
  assert.equal(f.sending(), false);
  assert.deepEqual(f.cleared, []);
  assert.equal(f.notices.length, 1);
});
