import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { effectScope, reactive, ref, watch } from "vue";

const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
const script = ts.createSourceFile("composer.ts", source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/u)![1]!, ts.ScriptTarget.Latest, true);
const switchWatch = script.statements.filter(statement =>
  ts.isExpressionStatement(statement)
  && statement.getText(script).startsWith("watch(")
  && statement.getText(script).includes("applyPendingLocalDraft(pendingDraft)")
  && statement.getText(script).includes("immediate: true"),
);
assert.equal(switchWatch.length, 1, "必须唯一定位会话切换草稿 watcher");
const code = ts.transpileModule(switchWatch[0]!.getText(script), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Applied = { kind: "draft" | "pending"; draft: unknown };

/** 执行真实切换 watcher，仅替换草稿读写依赖。 */
function createHarness(input: {
  pending?: Record<string, unknown>;
  cached?: Record<string, unknown>;
}) {
  const applied: Applied[] = [];
  const loads: string[] = [];
  const props = reactive({ workspaceId: "w", threadId: "a", disabled: false, activationManaged: false });
  const scope = effectScope();
  scope.run(() => vm.runInNewContext(code, {
    watch,
    props,
    ctx: { value: {} },
    chat: {
      pendingLocalThreadDraftByThreadId: input.pending ?? {},
      threadDraftByThreadId: input.cached ?? {},
      captureThreadDraftWorkspaceScopeToken: () => 1,
      setPendingLocalThreadDraft: () => 1,
    },
    composerConnected: ref(true),
    draftScopeHydrated: ref(false),
    currentDraftVersion: ref(null),
    draftDirty: false,
    draftWriteAuthorized: true,
    draftScopeEpoch: 0,
    draftWorkspaceScopeToken: 0,
    draftWorkspaceApiContext: {},
    draftAuthorizationWorkspaceId: "",
    draftAuthorizationThreadId: "",
    draftVersionReloadDeferred: false,
    draftLoadToken: 0,
    cancelDraftSave() {},
    snapshotDraft: () => ({ text: "", images: [], files: [] }),
    persistDraft: () => Promise.resolve(),
    applyDraft: (draft: unknown) => applied.push({ kind: "draft", draft }),
    applyPendingLocalDraft: (draft: unknown) => applied.push({ kind: "pending", draft }),
    loadThreadDraft: (_workspaceId: string, threadId: string) => { loads.push(threadId); return Promise.resolve(); },
    flushPendingPrefsForWorkspace: () => null,
    reportThreadPrefsSaveFailure() {},
    captureThreadPrefsSaveScope: () => ({}),
  }));
  return { props, applied, loads, stop: () => scope.stop() };
}

test("切换到有缓存草稿的会话时同步回填，不先清空", () => {
  const harness = createHarness({ cached: { b: { text: "缓存草稿", images: [], files: [] } } });
  try {
    assert.deepEqual(harness.applied.at(-1), { kind: "draft", draft: null }, "首次进入无缓存会话仍清空");
    harness.props.threadId = "b";
    assert.deepEqual(
      harness.applied.at(-1),
      { kind: "draft", draft: { text: "缓存草稿", images: [], files: [] } },
      "切换后应立即回填缓存草稿",
    );
    assert.deepEqual(harness.loads, ["a", "b"], "远端刷新仍按切换顺序发起");
  } finally {
    harness.stop();
  }
});

test("切换时优先回填未确认的本地草稿", () => {
  const harness = createHarness({
    pending: { b: { text: "本地草稿", images: [], files: [] } },
    cached: { b: { text: "过期缓存", images: [], files: [] } },
  });
  try {
    harness.props.threadId = "b";
    assert.deepEqual(harness.applied.at(-1), { kind: "pending", draft: { text: "本地草稿", images: [], files: [] } });
  } finally {
    harness.stop();
  }
});
