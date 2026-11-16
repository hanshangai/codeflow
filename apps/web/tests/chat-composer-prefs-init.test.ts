import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { effectScope, watch } from "vue";

const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
const script = ts.createSourceFile("composer.ts", source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/u)![1]!, ts.ScriptTarget.Latest, true);
const statements = script.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text === "flushPendingPrefsForWorkspace";
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => declaration.name.getText(script) === "pendingPrefsSave");
  return ts.isExpressionStatement(statement) && statement.getText(script).startsWith("watch(")
    && statement.getText(script).includes("prevState")
    && statement.getText(script).includes("const prefsTask = flushPendingPrefsForWorkspace();")
    && statement.getText(script).includes("immediate: true");
});
assert.equal(statements.length, 3, "必须执行偏好保存状态、真实冲刷函数和首次会话 watcher");
const code = ts.transpileModule(statements.map(statement => statement.getText(script)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

/** 保留真实 setup 执行顺序与 immediate watcher，仅隔离草稿操作和偏好请求。 */
function initializeComposer(connected: boolean, pending: boolean): unknown[][] {
  const calls: unknown[][] = [];
  const scope = effectScope();
  try {
    scope.run(() => vm.runInNewContext(code, {
      watch,
      props: { workspaceId: "workspace", threadId: "thread", disabled: true },
      ctx: { value: { sessionToken: "test-session" } },
      composerConnected: { value: connected },
      chat: {
        pendingThreadPrefsByThreadId: pending ? { thread: { model: "test-model" } } : {},
        pendingLocalThreadDraftByThreadId: {},
        threadDraftByThreadId: {},
        captureThreadDraftWorkspaceScopeToken: () => 7,
        flushPendingThreadPrefs: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); },
      },
      cancelDraftSave() {},
      applyDraft() {},
      applyPendingLocalDraft() {},
      draftScopeEpoch: 0,
      draftWorkspaceScopeToken: 0,
      draftWorkspaceApiContext: {},
      draftAuthorizationWorkspaceId: "",
      draftAuthorizationThreadId: "",
      draftScopeHydrated: { value: false },
      draftVersionReloadDeferred: false,
      currentDraftVersion: { value: null },
    }));
    return calls;
  } finally {
    scope.stop();
  }
}

test("连接后携带待保存偏好首次挂载输入框，不访问未初始化的定时器", () => {
  const calls = initializeComposer(true, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1], "workspace");
  assert.equal((calls[0]![2] as { workspaceScopeToken: number }).workspaceScopeToken, 7);
});

test("离线或没有待保存偏好时首次挂载不发起保存请求", () => {
  assert.equal(initializeComposer(false, true).length, 0);
  assert.equal(initializeComposer(true, false).length, 0);
});
