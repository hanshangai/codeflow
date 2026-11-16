import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isFileMutationToolName, isWorkspaceMutatingToolName } from "../src/utils/toolActivity.ts";

const wsSource = readFileSync(new URL("../src/services/ws.ts", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../src/store/chat.ts", import.meta.url), "utf8");

/** 只有可能改动工作区（命令执行 / 写文件）的工具才需要刷新 Git 状态。 */
test("命令执行与文件写入工具才触发工作区刷新", () => {
  for (const name of ["Bash", "shell", "commandExecution", "fileChange", "file_change", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(isWorkspaceMutatingToolName(name), true, `${name} 应视为可能改动工作区`);
  }
  for (const name of ["Read", "Grep", "Glob", "WebFetch", "Task", "", null, undefined]) {
    assert.equal(isWorkspaceMutatingToolName(name as unknown as string), false, `${String(name)} 不应触发刷新`);
  }
});

/** 含 write 字样但不改工作区的工具必须排除，否则每个待办更新都会打一次 git status。 */
test("待办与计划更新不触发工作区刷新", () => {
  for (const name of ["todowrite", "TodoWrite", "todo_write", "update_plan"]) {
    assert.equal(isWorkspaceMutatingToolName(name), false, `${name} 不应触发刷新`);
  }
});

/** 文件变更计数与 Git 刷新共用同一份名单，避免第三套口径。 */
test("文件变更计数复用同一份工具名单", () => {
  assert.equal(isFileMutationToolName("MultiEdit"), true);
  assert.equal(isFileMutationToolName("fileChange"), true);
  assert.equal(isFileMutationToolName("todowrite"), false);
  assert.match(chatSource, /function isFileMutationTool\(toolName: unknown\): boolean \{\s*return isFileMutationToolName\(toolName\);/u);
});

/** 会话里执行 commit/push 等命令后，Git 状态要重新取数，且不能命中 60s 缓存。 */
test("会话工具完成后按需刷新 Git 状态，且绕过缓存", () => {
  assert.match(wsSource, /event\.type === "item\.tool\.completed" \? event\.payload\.toolName/u);
  assert.match(wsSource, /child\?\.innerEventType === "item\.tool\.completed"/u);
  assert.match(wsSource, /if \(isWorkspaceMutatingToolName\(toolName\)\) scheduleGitStatusRefresh\(isFileMutationToolName\(toolName\)\)/u);
  assert.match(wsSource, /event\.type === "turn\.completed" \|\| event\.type === "turn\.error"\) scheduleGitStatusRefresh\(\)/u);
  assert.match(wsSource, /target\.refreshGitView\(apiCtx\(\), workspaceId as WorkspaceId\)/u);
  assert.doesNotMatch(wsSource, /refreshGitStatusCached\(apiCtx\(\)/u);
});

/** 自动刷新不依赖当前视图；无已加载状态时跳过，仍受前台与在线态约束并去抖。 */
test("文件视图工具完成也刷新 Git 状态，且无数据时跳过", () => {
  assert.doesNotMatch(wsSource, /isGitViewActive/u);
  assert.match(wsSource, /const canRefreshBackground = \(\): boolean => \(typeof document === "undefined" \|\| !document\.hidden\)\s*\n\s*&& deps\.config\.connected && deps\.presence\.isCurrentWorkspaceClientOnline;/u);
  assert.match(wsSource, /if \(!explorer\.gitStatus && !treeRefreshPending\) return;/u);
  assert.match(wsSource, /if \(!workspaceId \|\| !target \|\| !canRefreshBackground\(\)\) return;/u);
  assert.match(wsSource, /GIT_STATUS_REFRESH_DEBOUNCE_MS/u);
  assert.match(wsSource, /if \(gitStatusRefreshTimer != null\) return;/u);
});

/** 文件写入工具才刷新文件树，只在文件视图可见时执行；命令类工具不重载树。 */
test("文件写入完成后刷新文件树，命令类工具不刷新", () => {
  assert.match(wsSource, /scheduleGitStatusRefresh\(isFileMutationToolName\(completed\.toolName\)\)/u);
  assert.match(wsSource, /const refreshTree = treeRefreshPending && target\.viewMode === "files";/u);
  assert.match(wsSource, /target\.loadTree\(apiCtx\(\), workspaceId as WorkspaceId\)/u);
});

/** 页面隐藏期间跳过的刷新在回到前台时补刷，断线时移除监听。 */
test("页面恢复可见时补刷，断开连接时移除监听", () => {
  assert.match(wsSource, /document\.addEventListener\("visibilitychange", onVisibilityRefresh\)/u);
  assert.match(wsSource, /document\.removeEventListener\("visibilitychange", onVisibilityRefresh\)/u);
  assert.match(wsSource, /if \(typeof document === "undefined" \|\| document\.hidden\) return;\s*\n\s*scheduleGitStatusRefresh\(\);/u);
});

/** 面板不可见时也要失效缓存，否则 60s 内切回会命中命令前的旧快照。 */
test("工具完成即失效 Git 状态缓存，不等面板可见", () => {
  assert.match(wsSource, /explorer\.invalidateGitStatus\(apiCtx\(\), currentWorkspaceId as WorkspaceId\)/u);
});

/** 失败日志必须带错误码与 requestId；非 Git 视图只记录不提示。 */
test("自动刷新失败日志带错误码与 requestId，非 Git 视图不提示", () => {
  assert.match(wsSource, /reportAutomaticRefreshError\(logKey, error, \{\s*workspaceId,\s*code:/u);
  assert.match(wsSource, /requestId: \(error as \{ details\?: \{ requestId\?: unknown; serverRequestId\?: unknown \} \}\)\?\.details\?\.requestId/u);
  assert.match(wsSource, /report\("gitStatusRefresh", error, target\.viewMode === "git" \|\| target\.viewMode === "log"\)/u);
  assert.match(wsSource, /if \(notifyUser\) deps\.onError\?\.\(detail\);/u);
});

/** 断线后不能留下待执行的刷新任务。 */
test("断线时取消待执行的 Git 刷新", () => {
  assert.match(wsSource, /clearEngineEventBuffer\(\);\s*\n\s*clearGitStatusRefreshTimer\(\);/u);
});

/** 自动刷新依赖 explorer store，必须由应用外壳注入。 */
test("应用外壳把 explorer store 注入 WebSocket 客户端", () => {
  assert.match(shellSource, /terminal: terminalStore,\s*\n\s*explorer,/u);
});
