import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import { createPinia, setActivePinia } from "pinia";
import { message } from "ant-design-vue";
import type { ConversationItem, EngineEventEnvelope, GitStatusResult, ThreadDraftPayload, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { installBaiduTracking } from "../src/analytics/analytics.ts";
import { buildServerWsWebUrl, createApiResultError, createCancelledRequestError, isApiResultError, isCancelledRequestError, normalizeServerWsOrigin, requestJson, wsOriginToHttpOrigin, type ApiRequestContext } from "../src/api/request.ts";
import { createWebSocketClient } from "../src/services/ws.ts";
import { useAccountStore } from "../src/store/account.ts";
import { registerWorkspaceDraftFlusher, useChatStore } from "../src/store/chat.ts";
import { useConfigStore, WORKSPACE_URL_SYNC_EVENT } from "../src/store/config.ts";
import { useEngineStore } from "../src/store/engine.ts";
import { useExplorerStore } from "../src/store/explorer.ts";
import { usePresenceStore } from "../src/store/presence.ts";
import { useThreadQueueStore } from "../src/store/threadQueue.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const explorerSidebarSource = readFileSync(new URL("../src/features/explorer/components/explorer-sidebar.vue", import.meta.url), "utf8");
const explorerPanelSource = readFileSync(new URL("../src/features/explorer/components/explorer-panel.vue", import.meta.url), "utf8");
const explorerRightPanelSource = readFileSync(new URL("../src/features/explorer/components/explorer-right-panel.vue", import.meta.url), "utf8");
const nodeExecutionDetailSource = readFileSync(new URL("../src/features/orchestration/components/node-execution-detail.vue", import.meta.url), "utf8");
const configStoreSource = readFileSync(new URL("../src/store/config.ts", import.meta.url), "utf8");

function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

test("退出期间统一请求层将认证失败视为断开取消", async () => {
  const context: ApiRequestContext = {
    ...createApiContext(),
    isLogoutInProgress: () => true,
    ensureSession: async () => {
      throw new Error("Web 端仅支持账号登录，请先登录账号");
    },
  };

  await assert.rejects(
    requestJson(context, { method: "GET", path: "/api/account/me/summary" }),
    (error) => isCancelledRequestError(error) && error.kind === "disconnect",
  );

  const originalFetchForTest = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ ok: false, code: "UNAUTHORIZED", message: "账号会话已过期，请重新登录" }, 401)) as typeof fetch;
  try {
    const activeContext: ApiRequestContext = {
      ...createApiContext(),
      isLogoutInProgress: () => true,
    };
    await assert.rejects(
      requestJson(activeContext, { method: "GET", path: "/api/account/me/summary" }),
      (error) => isCancelledRequestError(error) && error.kind === "disconnect",
    );
  } finally {
    globalThis.fetch = originalFetchForTest;
  }
});

/** 构造测试用 JSON Response，并允许覆盖 HTTP 状态。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造指定仓库的 Git 状态成功响应。 */
function buildGitStatusResponse(repositoryPath: string, branch: string) {
  return {
    ok: true,
    isRepo: true,
    repositoryPath,
    repositories: [
      { path: "alpha", name: "alpha" },
      { path: "beta", name: "beta" },
    ],
    branch,
    tracking: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    merging: false,
    rebasing: false,
    headCommit: null,
  };
}

function buildAccountSummaryResponse(suffix: string) {
  return {
    ok: true,
    userId: `user-${suffix}`,
    email: `user-${suffix}@codeflow.test`,
    fullName: `User ${suffix}`,
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    accessContext: { identityType: "PERSONAL", canAccessAdmin: false, canAccessEnterpriseAdmin: false },
    enterpriseSummary: null,
    pendingEnterpriseInvitations: [],
    keySummary: null,
    securitySummary: { lastPasswordChangedAt: null, failedAttempts: 0, lockedUntil: null },
  };
}

function buildLoadThreadResponse(
  threadId: string,
  opts?: {
    hasRealTurnActivity?: boolean;
    events?: EngineEventEnvelope[];
    latestSeq?: number | null;
    oldestSeq?: number | null;
    running?: { runningTurnId: string; runningTurnStartedAt: number; runningSource?: "runtime" | "db" } | null;
    threadType?: "chat" | "orchestration";
    threadSubtype?: string | null;
  },
) {
  const events = opts?.events ?? [];
  const latestSeq = opts?.latestSeq ?? (events.length ? events[events.length - 1]!.seq : null);
  const oldestSeq = opts?.oldestSeq ?? (events.length ? events[0]!.seq : null);
  return {
    ok: true,
    thread: {
      id: threadId,
      workspaceId: "client-a:ws-demo",
      engine: "codex",
      title: `会话 ${threadId}`,
      threadType: opts?.threadType ?? "chat",
      threadSubtype: opts?.threadSubtype ?? null,
      sessionId: null,
      createdAt: 1,
      updatedAt: 1,
      model: null,
      effort: null,
      accessMode: "current",
      planMode: false,
      autoCompactPct: null,
      contextWindow: null,
    },
    hasRealTurnActivity: Boolean(opts?.hasRealTurnActivity),
    managedServices: {
      visible: true,
      threadId,
    },
    running: opts?.running ?? null,
    events,
    hasMore: false,
    oldestSeq,
    latestSeq,
    rawEventCount: events.length,
  };
}

function buildThreadSummaryResponse(
  threadId: string,
  opts?: {
    running?: { runningTurnId: string; runningTurnStartedAt: number; runningSource?: "runtime" | "db" } | null;
    threadType?: "chat" | "orchestration";
    threadSubtype?: string | null;
  },
) {
  return {
    ok: true,
    thread: {
      id: threadId,
      title: `会话 ${threadId}`,
      threadType: opts?.threadType ?? "chat",
      threadSubtype: opts?.threadSubtype ?? null,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      engine: "codex",
    },
    running: opts?.running ?? null,
    visibility: { hidden: false, reason: null },
    managedServices: {
      visible: true,
      threadId,
    },
  };
}

function buildEvent(type: EngineEventEnvelope["type"], seq: number, payload: Record<string, unknown>): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-buffered-live" as any,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

function buildThreadEvent(
  threadId: string,
  type: EngineEventEnvelope["type"],
  seq: number,
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    engine: "codex",
    type,
    payload,
  } as EngineEventEnvelope;
}

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

test("server origin helpers normalize historical ws/web values", () => {
  const rawOrigin = "wss://example.com/base/ws/web?ticket=demo#fragment";
  assert.equal(normalizeServerWsOrigin(rawOrigin), "wss://example.com/base");
  assert.equal(buildServerWsWebUrl(rawOrigin), "wss://example.com/base/ws/web");
  assert.equal(wsOriginToHttpOrigin(rawOrigin), "https://example.com/base");
});

test("Explorer 仅在 Git 面板可见时自动刷新，且不监听 focus/visibility", () => {
  assert.doesNotMatch(explorerSidebarSource, /addEventListener\(["']focus/u);
  assert.doesNotMatch(explorerSidebarSource, /addEventListener\(["']visibilitychange/u);
  assert.doesNotMatch(explorerSidebarSource, /onMounted\(/u);
  assert.match(explorerSidebarSource, /const GIT_AHEAD_REFRESH_INTERVAL_MS = 60_000;/u);
  assert.match(explorerSidebarSource, /mode !== "git" && mode !== "log"/u);
  assert.doesNotMatch(explorerPanelSource, /refreshGitStatus/u);
  assert.doesNotMatch(explorerRightPanelSource, /refreshGitStatus/u);
});

test("NodeExecutionDetail 仅在结果视图刷新真实 workspace Git 路径并带短 TTL 缓存", () => {
  assert.match(nodeExecutionDetailSource, /activeView\.value !== "result"/u);
  assert.match(nodeExecutionDetailSource, /OUTPUT_GIT_STATUS_CACHE_TTL_MS = 15_000;/u);
  assert.match(nodeExecutionDetailSource, /outputPreviewWorkspaceGitPath\(file: ArtifactPresentationFile\): string/u);
  assert.match(nodeExecutionDetailSource, /normalizeWorkspaceRelativePath\(file\.workspacePreviewPath\)/u);
  assert.doesNotMatch(nodeExecutionDetailSource, /workspacePreviewPath \?\? file\.filePath/u);
});

/** 手动完成读取，验证并发派发与迟到响应的真实状态。 */
function previewDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 保留真实 Store 和请求层，仅控制外部文件读取的返回时机。 */
function explorerPreviewFixture() {
  setActivePinia(createPinia());
  const reads: Array<{ body: { workspaceId: string; path: string }; response: ReturnType<typeof previewDeferred<Response>> }> = [];
  globalThis.fetch = (async (_url, init) => {
    const response = previewDeferred<Response>();
    reads.push({ body: JSON.parse(String(init?.body)), response });
    return response.promise;
  }) as typeof fetch;
  return { store: useExplorerStore(), ctx: createApiContext(), reads };
}

/** 构造普通文本预览，内容直接标识请求归属。 */
function previewResponse(path: string, content = path): Response {
  return jsonResponse({ ok: true, path, content, isBinary: false, size: content.length, base64: null, mimeType: "text/plain" });
}

test("Explorer 旧文件响应不能清除新选择的 loading 或写回内容", async () => {
  const f = explorerPreviewFixture();
  const old = f.store.selectFile(f.ctx, "client-a:preview" as WorkspaceId, "old.txt");
  const current = f.store.selectFile(f.ctx, "client-a:preview" as WorkspaceId, "current.txt");
  await tick(0);
  f.reads[0]!.response.resolve(previewResponse("old.txt"));
  await old;
  assert.equal(f.store.previewLoading, true);
  assert.equal(f.store.preview, null);
  f.reads[1]!.response.resolve(previewResponse("current.txt"));
  await current;
  assert.equal(f.store.preview?.content, "current.txt");
  assert.equal(f.store.selectedPath, "current.txt");
  assert.equal(f.store.previewLoading, false);
});

test("Explorer 快速切换后迟到文件响应不能覆盖已经展示的新文件", async () => {
  const f = explorerPreviewFixture();
  const old = f.store.selectFile(f.ctx, "client-a:preview" as WorkspaceId, "old.txt");
  const current = f.store.loadPreview(f.ctx, "client-a:preview" as WorkspaceId, "current.txt");
  await tick(0);
  f.reads[1]!.response.resolve(previewResponse("current.txt"));
  await current;
  f.reads[0]!.response.resolve(previewResponse("old.txt"));
  await old;
  assert.equal(f.store.preview?.content, "current.txt");
});

test("Explorer 切工作区后相同文件路径也不能接收旧预览", async () => {
  const f = explorerPreviewFixture();
  const old = f.store.loadPreview(f.ctx, "client-a:old" as WorkspaceId, "same.txt");
  f.store.resetForWorkspace();
  const current = f.store.loadPreview(f.ctx, "client-a:new" as WorkspaceId, "same.txt");
  await tick(0);
  f.reads[0]!.response.resolve(previewResponse("same.txt", "old workspace"));
  await old;
  assert.equal(f.store.preview, null);
  assert.equal(f.store.previewLoading, true);
  f.reads[1]!.response.resolve(previewResponse("same.txt", "new workspace"));
  await current;
  assert.equal(f.store.preview?.content, "new workspace");
});

test("Explorer 相同作用域仅合并在途预览，完成后再次打开仍重新读取", async () => {
  const f = explorerPreviewFixture();
  const workspaceId = "client-a:preview" as WorkspaceId;
  const first = f.store.selectFile(f.ctx, workspaceId, "same.txt");
  const duplicate = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  await tick(0);
  assert.equal(f.reads.length, 1);
  f.reads[0]!.response.resolve(previewResponse("same.txt", "first"));
  await Promise.all([first, duplicate]);
  const next = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  await tick(0);
  assert.equal(f.reads.length, 2);
  f.reads[1]!.response.resolve(previewResponse("same.txt", "updated"));
  await next;
  assert.equal(f.store.preview?.content, "updated");
});

test("Explorer 不同 Web 会话的同路径预览不会合并", async () => {
  const f = explorerPreviewFixture();
  const workspaceId = "client-a:preview" as WorkspaceId;
  const old = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  const current = f.store.loadPreview({ ...f.ctx, webSessionId: "another-session" }, workspaceId, "same.txt");
  await tick(0);
  assert.equal(f.reads.length, 2);
  f.reads[1]!.response.resolve(previewResponse("same.txt", "current session"));
  await current;
  f.reads[0]!.response.resolve(previewResponse("same.txt", "old session"));
  await old;
  assert.equal(f.store.preview?.content, "current session");
});

test("Explorer 同一 Web 会话更换 token 后不合并预览且保留新身份结果", async () => {
  const f = explorerPreviewFixture();
  const workspaceId = "client-a:preview" as WorkspaceId;
  const old = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  const current = f.store.loadPreview({ ...f.ctx, sessionToken: "another-session-token" }, workspaceId, "same.txt");
  await tick(0);
  assert.equal(f.reads.length, 2);
  f.reads[1]!.response.resolve(previewResponse("same.txt", "current identity"));
  await current;
  f.reads[0]!.response.resolve(previewResponse("same.txt", "old identity"));
  await old;
  assert.equal(f.store.preview?.content, "current identity");
});

test("Explorer 工作表迟到响应不能覆盖新选择的普通文件", async () => {
  const f = explorerPreviewFixture();
  const workspaceId = "client-a:preview" as WorkspaceId;
  const sheet = f.store.loadSpreadsheetSheet(f.ctx, workspaceId, "sheet.xlsx", "Sheet2");
  const current = f.store.selectFile(f.ctx, workspaceId, "current.txt");
  await tick(0);
  f.reads[0]!.response.resolve(jsonResponse({ ok: true, path: "sheet.xlsx", sheetName: "Sheet2", sheets: [], rows: [] }));
  await sheet;
  assert.equal(f.store.previewLoading, true);
  assert.equal(f.store.spreadsheetPreview, null);
  f.reads[1]!.response.resolve(previewResponse("current.txt"));
  await current;
  assert.equal(f.store.previewType, "code");
  assert.equal(f.store.preview?.content, "current.txt");
});

test("Explorer 预览失败显式拒绝且相同选择允许重试", async () => {
  const f = explorerPreviewFixture();
  const workspaceId = "client-a:preview" as WorkspaceId;
  const failed = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  const rejection = assert.rejects(failed, /read failed/u);
  await tick(0);
  f.reads[0]!.response.resolve(jsonResponse({ ok: false, code: "CLIENT_ERROR", message: "read failed" }));
  await rejection;
  assert.equal(f.store.previewLoading, false);
  const retry = f.store.loadPreview(f.ctx, workspaceId, "same.txt");
  await tick(0);
  f.reads[1]!.response.resolve(previewResponse("same.txt", "retried"));
  await retry;
  assert.equal(f.store.preview?.content, "retried");
});

/** 执行右侧面板真实处理函数，替换网络与窗口/提示展示边界。 */
function rightPreviewFixture() {
  const script = explorerRightPanelSource.split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
  const ast = ts.createSourceFile("preview.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variables = new Set(["_winIdCounter", "NON_TEXT_DIFF_PREVIEW_TYPES", "PREVIEW_OPEN_DEDUPE_MS", "openingPreviewKeys", "recentlyOpenedPreviewAt"]);
  const source = ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => variables.has(declaration.name.getText(ast))))
    .map(statement => statement.getText(ast)).join("\n");
  const diff = previewDeferred<{ ok: boolean; code?: string; message?: string; original?: string; modified?: string }>();
  const preview = previewDeferred<{ preview: { content: string }; spreadsheet: null; previewType: string }>();
  const reads: string[] = [], errors: string[] = [], warnings: string[] = [], windows: Array<{ content: string; diffOriginal: string }> = [];
  const fetchDiff = () => { reads.push("diff"); return diff.promise; };
  const sandbox = { Error, props: { workspaceId: "client-a:preview" }, ctx: { value: createApiContext() },
    explorer: { selectedPath: null, gitStatus: { headCommit: "1234567890" },
      gitCommitDetail: { entry: { hash: "1234567890", hashShort: "1234567", parents: ["abcdef0"] } },
      gitRequestScope: (workspaceId: string) => ({ workspaceId }) },
    ui: { explorerPreviewWindows: windows, openPreviewWindow: (win: typeof windows[number]) => windows.push(win) },
    message: { error: (text: string) => errors.push(text), warning: (text: string) => warnings.push(text) },
    fetchGitDiffFiles: fetchDiff, fetchGitShowFileDiff: fetchDiff, createApiResultError,
    loadWorkspaceFilePreview: () => { reads.push("preview"); return preview.promise; } };
  const handlers = vm.runInNewContext(ts.transpileModule(`${source}\n({ onSelectGitFile, onSelectCommitFile });`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox) as {
      onSelectGitFile: (path: string, staged: boolean) => Promise<void>;
      onSelectCommitFile: (path: string) => Promise<void>;
    };
  return { ...handlers, diff, preview, reads, errors, warnings, windows, props: sandbox.props, ctx: sandbox.ctx };
}

for (const kind of ["working", "commit"] as const) {
  for (const changed of ["workspaceId", "serverWsOrigin", "webSessionId", "desktopClientId", "sessionToken"] as const) {
    test(`Explorer ${kind} ${changed} 切换后忽略旧预览且不提示错误`, async () => {
      const f = rightPreviewFixture();
      const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
      if (changed === "workspaceId") f.props.workspaceId = "client-b:another";
      else f.ctx.value[changed] = "another-identity";
      f.diff.resolve({ ok: true, original: "old identity", modified: "old content" });
      f.preview.resolve({ preview: { content: "old identity" }, spreadsheet: null, previewType: "code" });
      await opening;
      assert.equal(f.windows.length, 0);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.warnings, []);
    });
  }

  test(`Explorer ${kind} 作用域切换后旧读取失败也不提示当前会话`, async () => {
    const f = rightPreviewFixture();
    const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
    f.props.workspaceId = "client-b:another";
    f.diff.reject(new Error("old diff failed"));
    f.preview.reject(new Error("old preview failed"));
    await opening;
    assert.equal(f.windows.length, 0);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.warnings, []);
  });

  test(`Explorer ${kind} diff 与预览并发读取后打开正确窗口`, async () => {
    const f = rightPreviewFixture();
    const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
    assert.deepEqual(f.reads, ["diff", "preview"]);
    f.preview.resolve({ preview: { content: "current" }, spreadsheet: null, previewType: "code" });
    f.diff.resolve({ ok: true, original: "before", modified: "after" });
    await opening;
    assert.equal(f.windows.length, 1);
    assert.equal(f.windows[0]!.content, "current");
    assert.equal(f.windows[0]!.diffOriginal, "before");
    assert.deepEqual(f.errors, []);
  });

  test(`Explorer ${kind} diff 失败不以文件预览伪造成功`, async () => {
    const f = rightPreviewFixture();
    const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
    f.diff.resolve({ ok: false, code: "CLIENT_ERROR", message: "diff failed" });
    f.preview.resolve({ preview: { content: "current" }, spreadsheet: null, previewType: "code" });
    await opening;
    assert.equal(f.windows.length, 0);
    assert.deepEqual(f.errors, ["diff failed"]);
  });

  test(`Explorer ${kind} 两项读取均拒绝时只显示 diff 失败且不打开窗口`, async () => {
    const f = rightPreviewFixture();
    const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
    f.diff.reject(new Error("diff rejected"));
    f.preview.reject(new Error("preview rejected"));
    await opening;
    assert.equal(f.windows.length, 0);
    assert.deepEqual(f.errors, ["diff rejected"]);
    assert.deepEqual(f.warnings, []);
  });

  test(`Explorer ${kind} 保留 diff 成功时文件预览失败的既有警告`, async () => {
    const f = rightPreviewFixture();
    const opening = kind === "working" ? f.onSelectGitFile("file.txt", false) : f.onSelectCommitFile("file.txt");
    f.diff.resolve({ ok: true, original: "before", modified: "after" });
    await tick(0);
    f.preview.reject(new Error("preview failed"));
    await opening;
    assert.equal(f.windows.length, 1);
    assert.equal(f.windows[0]!.diffOriginal, "before");
    assert.deepEqual(f.warnings, ["文件预览加载失败：preview failed"]);
    assert.deepEqual(f.errors, []);
  });
}

test("Git status 同作用域复用请求，切换 workspace/repository 后旧响应不覆盖新状态", async () => {
  setActivePinia(createPinia());
  const store = useExplorerStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:ws-old-git" as WorkspaceId;
  const newWorkspaceId = "client-a:ws-new-git" as WorkspaceId;
  const requestScopes: string[] = [];
  const responders = new Map<string, (response: Response) => void>();

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/git/status") throw new Error(`unexpected request: ${url.pathname}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { workspaceId: string; repositoryPath?: string | null };
    const scopeKey = JSON.stringify([body.workspaceId, body.repositoryPath ?? null]);
    requestScopes.push(scopeKey);
    return new Promise<Response>((resolve) => responders.set(scopeKey, resolve));
  }) as typeof fetch;

  const oldScopeKey = JSON.stringify([String(oldWorkspaceId), null]);
  const oldFirst = store.refreshGitStatus(ctx, oldWorkspaceId);
  const oldSecond = store.refreshGitStatus(ctx, oldWorkspaceId);
  await tick(0);
  assert.deepEqual(requestScopes, [oldScopeKey]);
  assert.equal(store.gitStatusLoading, true);

  store.resetForWorkspace();
  const newScopeKey = JSON.stringify([String(newWorkspaceId), "beta"]);
  const newRequest = store.selectGitRepository(ctx, newWorkspaceId, "beta");
  await tick(0);
  assert.deepEqual(requestScopes, [oldScopeKey, newScopeKey]);

  const resolveOld = responders.get(oldScopeKey);
  assert.ok(resolveOld);
  resolveOld(jsonResponse(buildGitStatusResponse("alpha", "old-branch")));
  await Promise.all([oldFirst, oldSecond]);
  assert.equal(store.gitStatusLoading, true);
  assert.equal<GitStatusResult | null>(store.gitStatus, null);
  assert.equal(store.selectedGitRepositoryPath, "beta");

  const resolveNew = responders.get(newScopeKey);
  assert.ok(resolveNew);
  resolveNew(jsonResponse(buildGitStatusResponse("beta", "new-branch")));
  await newRequest;
  assert.equal(store.gitStatusLoading, false);
  assert.equal(store.gitStatus?.branch, "new-branch");
  assert.equal(store.selectedGitRepositoryPath, "beta");
});

test("Git status 相同仓库作用域不会跨 Web 会话复用在途请求", async () => {
  setActivePinia(createPinia());
  const store = useExplorerStore();
  const workspaceId = "client-a:ws-session-isolation" as WorkspaceId;
  const firstCtx = createApiContext();
  const secondCtx = { ...createApiContext(), webSessionId: "web-other" };
  let requestCount = 0;
  let releaseRequests: (() => void) | null = null;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/git/status") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    await requestGate;
    return jsonResponse(buildGitStatusResponse("alpha", "main"));
  }) as typeof fetch;

  const first = store.refreshGitStatus(firstCtx, workspaceId);
  const second = store.refreshGitStatus(secondCtx, workspaceId);
  await tick(0);
  assert.equal(requestCount, 2);

  assert.ok(releaseRequests);
  (releaseRequests as () => void)();
  await Promise.all([first, second]);
  assert.equal(store.gitStatusLoading, false);
  assert.equal(store.gitStatus?.branch, "main");
});

test("Git status 自动刷新在短 TTL 内复用缓存，手动刷新绕过缓存", async () => {
  setActivePinia(createPinia());
  const store = useExplorerStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-git-cache" as WorkspaceId;
  let now = 1_000;
  let requestCount = 0;
  const requestedRepositoryPaths: Array<string | null> = [];
  Date.now = () => now;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/git/status") throw new Error(`unexpected request: ${url.pathname}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { repositoryPath?: string | null };
    requestedRepositoryPaths.push(body.repositoryPath ?? null);
    requestCount += 1;
    return jsonResponse(buildGitStatusResponse("alpha", `cached-main-${requestCount}`));
  }) as typeof fetch;

  await store.refreshGitStatus(ctx, workspaceId);
  assert.equal(requestCount, 1);
  assert.equal(store.gitStatus?.branch, "cached-main-1");

  await store.refreshGitStatusCached(ctx, workspaceId);
  await store.refreshGitStatusCached(ctx, workspaceId);
  assert.equal(requestCount, 1);
  assert.equal(store.gitStatus?.branch, "cached-main-1");

  await store.refreshGitStatus(ctx, workspaceId);
  assert.equal(requestCount, 2);
  assert.equal(store.gitStatus?.branch, "cached-main-2");

  now += 60_001;
  await store.refreshGitStatusCached(ctx, workspaceId);
  assert.equal(requestCount, 3);
  assert.equal(store.gitStatus?.branch, "cached-main-3");
  assert.deepEqual(requestedRepositoryPaths, [null, "alpha", "alpha"]);
});

test("Git status 请求失败会显式失败并清理 singleflight 供同作用域重试", async () => {
  setActivePinia(createPinia());
  const store = useExplorerStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-git-retry" as WorkspaceId;
  const expectedError = new Error("git status transport failed");
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/git/status") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    if (requestCount === 1) throw expectedError;
    return jsonResponse(buildGitStatusResponse("alpha", "retry-main"));
  }) as typeof fetch;

  await assert.rejects(store.refreshGitStatus(ctx, workspaceId), (error) => error === expectedError);
  assert.equal(store.gitStatusLoading, false);
  await store.refreshGitStatus(ctx, workspaceId);

  assert.equal(requestCount, 2);
  assert.equal(store.gitStatusLoading, false);
  assert.equal(store.gitStatus?.branch, "retry-main");
});

test("Git status 同作用域并发 API 失败会全部显式失败并允许重试", async () => {
  setActivePinia(createPinia());
  const store = useExplorerStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-git-api-retry" as WorkspaceId;
  let requestCount = 0;
  let releaseFirstRequest: (() => void) | null = null;
  const firstRequestGate = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/git/status") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    if (requestCount === 1) {
      await firstRequestGate;
      return jsonResponse({ ok: false, code: "CLIENT_OFFLINE", message: "Client 离线" }, 503);
    }
    return jsonResponse(buildGitStatusResponse("alpha", "retry-after-api-error"));
  }) as typeof fetch;

  const first = store.refreshGitStatus(ctx, workspaceId);
  const second = store.refreshGitStatus(ctx, workspaceId);
  const settled = Promise.allSettled([first, second]);
  await tick(0);
  assert.equal(requestCount, 1);
  assert.equal(store.gitStatusLoading, true);

  assert.ok(releaseFirstRequest);
  (releaseFirstRequest as () => void)();
  const failures = await settled;
  assert.deepEqual(failures.map((result) => result.status), ["rejected", "rejected"]);
  for (const failure of failures) {
    assert.equal(failure.status, "rejected");
    assert.equal(isApiResultError(failure.reason), true);
    assert.equal(failure.reason.code, "CLIENT_OFFLINE");
  }
  assert.equal(store.gitStatusLoading, false);

  await store.refreshGitStatus(ctx, workspaceId);

  assert.equal(requestCount, 2);
  assert.equal(store.gitStatusLoading, false);
  assert.equal(store.gitStatus?.branch, "retry-after-api-error");
});

test("rapid manual workspace switches share the dirty draft flush and apply only the latest target", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "client-a:ws-old";
  let releaseFlush: (() => void) | null = null;
  let flushCount = 0;
  let reloadCount = 0;
  const replacedUrls: string[] = [];
  const dispatchedEvents: Event[] = [];
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  const unregister = registerWorkspaceDraftFlusher(() => {
    flushCount += 1;
    return flushGate;
  });
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    location: {
      href: "http://localhost:39281/chat?threadId=thread-old",
      pathname: "/chat",
      search: "?threadId=thread-old",
      hash: "",
      reload: () => {
        reloadCount += 1;
      },
    },
    history: {
      state: { source: "test" },
      replaceState(_state: unknown, _title: string, url: string) {
        replacedUrls.push(url);
      },
    },
    dispatchEvent(event: Event) {
      dispatchedEvents.push(event);
      return true;
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
  };

  try {
    config.switchWorkspace("client-a:ws-first", { reloadPage: true });
    config.switchWorkspace("client-a:ws-latest", { reloadPage: true });
    config.switchWorkspace("client-a:ws-automatic", { preservePrimaryThreadUrl: true });
    assert.equal(config.workspaceId, "client-a:ws-old");
    assert.equal(flushCount, 1);
    assert.equal(reloadCount, 0);

    assert.ok(releaseFlush);
    (releaseFlush as () => void)();
    await tick(0);

    assert.equal(config.workspaceId, "client-a:ws-latest");
    assert.equal(reloadCount, 1);
    // 主动切工作区还会把地址栏同步到新工作区，并清掉旧会话目标。
    assert.deepEqual(replacedUrls, ["/chat", "http://localhost:39281/chat?workspaceId=client-a%3Aws-latest"]);
    assert.equal(dispatchedEvents.length, 1);
  } finally {
    unregister();
    (globalThis as any).window = originalWindow;
  }
});

test("manual in-app switch waits for drafts, emits URL sync and applies the callback once", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "client-a:ws-old-inapp";
  let releaseFlush: (() => void) | null = null;
  let flushCount = 0;
  let reloadCount = 0;
  const events: Event[] = [];
  const applied: string[] = [];
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  const unregister = registerWorkspaceDraftFlusher(() => {
    flushCount += 1;
    return flushGate;
  });
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    location: {
      href: "http://localhost:39281/chat?threadId=thread-old",
      pathname: "/chat",
      search: "?threadId=thread-old",
      hash: "",
      reload: () => {
        reloadCount += 1;
      },
    },
    history: {
      state: { source: "test" },
      replaceState() {},
    },
    dispatchEvent(event: Event) {
      events.push(event);
      return true;
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
  };

  try {
    config.switchWorkspace("client-a:ws-new-inapp", {
      flushDrafts: true,
      source: "workspace_selector",
      onApplied: (workspaceId) => applied.push(workspaceId),
    });
    assert.equal(config.workspaceId, "client-a:ws-old-inapp");
    assert.equal(flushCount, 1);
    assert.equal(reloadCount, 0);
    assert.deepEqual(applied, []);

    assert.ok(releaseFlush);
    (releaseFlush as () => void)();
    await tick(0);

    assert.equal(config.workspaceId, "client-a:ws-new-inapp");
    assert.equal(reloadCount, 0);
    assert.deepEqual(applied, ["client-a:ws-new-inapp"]);
    assert.equal(events.filter((event) => event.type === WORKSPACE_URL_SYNC_EVENT).length, 1);
  } finally {
    unregister();
    (globalThis as any).window = originalWindow;
  }
});

test("automatic workspace switch keeps its synchronous contract and does not wait for draft flushers", () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "client-a:ws-old-auto";
  let flushCount = 0;
  const unregister = registerWorkspaceDraftFlusher(() => {
    flushCount += 1;
    return new Promise<void>(() => {});
  });

  try {
    config.switchWorkspace("client-a:ws-new-auto", { preservePrimaryThreadUrl: true });

    assert.equal(config.workspaceId, "client-a:ws-new-auto");
    assert.equal(flushCount, 0);
  } finally {
    unregister();
  }
});

test("cancelled draft flush does not report a manual workspace switch failure", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = "client-a:ws-old-cancelled";
  const errors: string[] = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalMessageError = message.error;
  let scriptErrorListener: (() => void) | null = null;
  const analyticsQueue: Array<[string, ...unknown[]]> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/chat" }, _hmt: analyticsQueue },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: () => null,
      createElement: () => ({
        id: "",
        async: false,
        defer: false,
        src: "",
        addEventListener(type: string, listener: () => void) {
          if (type === "error") scriptErrorListener = listener;
        },
        remove() {},
      }),
      addEventListener() {},
      head: { appendChild() {} },
    },
  });
  installBaiduTracking("0123456789abcdef0123456789abcdef");
  message.error = ((content: unknown) => {
    errors.push(String(content));
  }) as typeof message.error;
  const unregister = registerWorkspaceDraftFlusher(() => Promise.reject(createCancelledRequestError("scope-change")));

  try {
    config.switchWorkspace("client-a:ws-new-cancelled", { reloadPage: true });
    await tick(0);

    assert.equal(config.workspaceId, "client-a:ws-old-cancelled");
    assert.deepEqual(errors, []);
    assert.equal(analyticsQueue.some((command) => command[0] === "_trackEvent" && command[2] === "workspace_switch"), false);
  } finally {
    unregister();
    message.error = originalMessageError;
    const originalConsoleError = console.error;
    console.error = () => {};
    (scriptErrorListener as (() => void) | null)?.();
    console.error = originalConsoleError;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test("pending local thread draft cache is independent from the authoritative remote version", () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const threadId = "thread-pending-local-draft" as any;
  const draft = { text: "尚未保存", images: [], files: [], pathReferences: [] };

  chat.setThreadDraftVersion(threadId, 7);
  const firstEpoch = chat.setPendingLocalThreadDraft(threadId, draft);
  draft.text = "外部修改";
  const secondEpoch = chat.setPendingLocalThreadDraft(threadId, { ...draft, text: "较新草稿" });

  assert.equal(chat.threadDraftVersionByThreadId[String(threadId)], 7);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, "较新草稿");
  assert.equal(chat.clearPendingLocalThreadDraft(threadId, firstEpoch ?? undefined), false);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, "较新草稿");
  assert.equal(chat.clearPendingLocalThreadDraft(threadId, secondEpoch ?? undefined), true);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
});

test("late draft save response cannot clear a newer pending local draft", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-late-draft-save" as any;
  let releaseSave: (() => void) | null = null;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    await saveGate;
    return jsonResponse({ ok: true, version: 8, updatedAt: 123, updatedByWebSessionId: "web-old" });
  }) as typeof fetch;

  const oldDraft = { text: "旧草稿", images: [], files: [], pathReferences: [] };
  const oldEpoch = chat.setPendingLocalThreadDraft(threadId, oldDraft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, oldDraft, { pendingEpoch: oldEpoch ?? undefined });
  await tick(0);
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: oldDraft.text,
    images: [],
    files: [],
    pathReferences: [{ id: "path-new", path: "src/new.ts", kind: "file", source: "mention" }],
  });

  assert.ok(releaseSave);
  (releaseSave as () => void)();
  await saving;

  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.pathReferences?.[0]?.path, "src/new.ts");
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);
});

test("older draft save response cannot overwrite a newer remote draft signal", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-remote-signal-after-save" as any;
  let releaseSave: (() => void) | null = null;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    await saveGate;
    return jsonResponse({ ok: true, version: 2, updatedAt: 234, updatedByWebSessionId: "web-owner" });
  }) as typeof fetch;

  chat.setThreadDraft(threadId, {
    text: "初始草稿",
    images: [],
    files: [],
    pathReferences: [],
    version: 1,
    updatedAt: 1,
    updatedByWebSessionId: "web-owner",
  });
  const draft = { text: "较早保存", images: [], files: [], pathReferences: [] };
  const pendingEpoch = chat.setPendingLocalThreadDraft(threadId, draft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, draft, { pendingEpoch: pendingEpoch ?? undefined });
  await tick(0);
  chat.setThreadDraftVersion(threadId, 3, "web-other");

  assert.ok(releaseSave);
  (releaseSave as () => void)();
  await saving;

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftVersionByThreadId[String(threadId)], 3);
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);
});

test("duplicate pending draft keeps its epoch so the matching save acknowledgement clears it", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-duplicate-pending-draft" as any;
  let releaseSave: (() => void) | null = null;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    await saveGate;
    return jsonResponse({ ok: true, version: 9, updatedAt: 456, updatedByWebSessionId: "web-owner" });
  }) as typeof fetch;

  const draft: ThreadDraftPayload = {
    text: "保存中的草稿",
    images: [{ id: "image-1", name: "image.png", dataUrl: "data:image/png;base64,AA==", size: 1 }],
    files: [{ id: "file-1", name: "note.txt", mime: "text/plain", size: 4, text: "note" }],
    pathReferences: [{ id: "path-1", path: "src/index.ts", kind: "file", source: "mention" }],
  };
  const saveEpoch = chat.setPendingLocalThreadDraft(threadId, draft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, draft, { pendingEpoch: saveEpoch ?? undefined });
  await tick(0);
  const duplicateEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: draft.text,
    images: draft.images.map((item) => ({ ...item })),
    files: draft.files.map((item) => ({ ...item })),
    pathReferences: draft.pathReferences?.map((item) => ({ ...item })),
  });

  assert.equal(duplicateEpoch, saveEpoch);
  chat.setThreadDraftVersion(threadId, 9, "web-owner");
  assert.ok(releaseSave);
  (releaseSave as () => void)();
  await saving;

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.text, draft.text);
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.version, 9);
});

test("workspace reset cannot reuse a pending epoch for an older draft response", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-reset-pending-draft" as any;
  let releaseSave: (() => void) | null = null;
  let requestCount = 0;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    await saveGate;
    return jsonResponse({ ok: true, version: 10, updatedAt: 789, updatedByWebSessionId: "web-old" });
  }) as typeof fetch;

  const oldDraft = { text: "切换前草稿", images: [], files: [], pathReferences: [] };
  const oldEpoch = chat.setPendingLocalThreadDraft(threadId, oldDraft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, oldDraft, { pendingEpoch: oldEpoch ?? undefined });
  await tick(0);
  const queuedDraft = { text: "切换前排队草稿", images: [], files: [], pathReferences: [] };
  const queuedEpoch = chat.setPendingLocalThreadDraft(threadId, queuedDraft);
  const queuedSaving = chat.saveThreadDraft(ctx, workspaceId, threadId, queuedDraft, { pendingEpoch: queuedEpoch ?? undefined });
  await tick(0);
  assert.equal(requestCount, 1);
  chat.resetForWorkspace();
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: "切换后草稿",
    images: [],
    files: [],
    pathReferences: [],
  });

  assert.notEqual(newEpoch, oldEpoch);
  assert.ok(releaseSave);
  (releaseSave as () => void)();
  const results = await Promise.allSettled([saving, queuedSaving]);

  assert.equal(results.every((result) => result.status === "rejected" && isCancelledRequestError(result.reason)), true);
  assert.equal(requestCount, 1);
  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, "切换后草稿");
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);
});

test("stale composer workspace scope can preserve its remote draft without projecting into the new workspace", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:ws-old" as any;
  const newWorkspaceId = "client-a:ws-new" as any;
  const threadId = "thread-same-id-across-workspaces" as any;
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    return jsonResponse({ ok: true, version: 1, updatedAt: 1, updatedByWebSessionId: "web-new" });
  }) as typeof fetch;

  const oldWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
  chat.resetForWorkspace();
  const newWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
  const newDraft = { text: "新工作区草稿", images: [], files: [], pathReferences: [] };
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, newDraft, {
    workspaceScopeToken: newWorkspaceScopeToken,
  });
  if (newEpoch == null) throw new Error("new workspace draft scope unexpectedly expired");

  const staleEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: "旧工作区迟到草稿",
    images: [],
    files: [],
    pathReferences: [],
  }, { workspaceScopeToken: oldWorkspaceScopeToken });
  const staleClear = chat.clearPendingLocalThreadDraft(threadId, undefined, {
    workspaceScopeToken: oldWorkspaceScopeToken,
  });
  await assert.rejects(
    chat.saveThreadDraft(ctx, oldWorkspaceId, threadId, { text: "旧工作区迟到草稿", images: [], files: [], pathReferences: [] }, {
      workspaceScopeToken: oldWorkspaceScopeToken,
    }),
    (error: unknown) => isCancelledRequestError(error),
  );

  assert.equal(staleEpoch, null);
  assert.equal(staleClear, false);
  assert.equal(requestCount, 0);
  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, newDraft.text);

  await chat.saveThreadDraft(ctx, oldWorkspaceId, threadId, {
    text: "旧工作区迟到草稿",
    images: [],
    files: [],
    pathReferences: [],
  }, {
    workspaceScopeToken: oldWorkspaceScopeToken,
    allowStaleWorkspaceRemoteMutation: true,
  });

  assert.equal(requestCount, 1);
  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, newDraft.text);
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);

  await chat.saveThreadDraft(ctx, newWorkspaceId, threadId, newDraft, {
    pendingEpoch: newEpoch,
    workspaceScopeToken: newWorkspaceScopeToken,
  });

  assert.equal(requestCount, 2);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.text, newDraft.text);
});

test("stale workspace remote-only clear cannot erase the new workspace pending draft", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const oldWorkspaceId = "client-a:ws-old-clear" as any;
  const threadId = "thread-same-id-clear-across-workspaces" as any;
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/clear") throw new Error(`unexpected request: ${url.pathname}`);
    requestCount += 1;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const oldWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
  chat.resetForWorkspace();
  const newWorkspaceScopeToken = chat.captureThreadDraftWorkspaceScopeToken();
  const newDraft = { text: "新工作区待确认草稿", images: [], files: [], pathReferences: [] };
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, newDraft, {
    workspaceScopeToken: newWorkspaceScopeToken,
  });

  await chat.clearThreadDraft(ctx, oldWorkspaceId, threadId, {
    workspaceScopeToken: oldWorkspaceScopeToken,
    allowStaleWorkspaceRemoteMutation: true,
  });

  assert.equal(requestCount, 1);
  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, newDraft.text);
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);
});

test("duplicate empty pending draft keeps its epoch so the matching clear acknowledgement clears it", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-duplicate-pending-clear" as any;
  let releaseClear: (() => void) | null = null;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/clear") throw new Error(`unexpected request: ${url.pathname}`);
    await clearGate;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const emptyDraft = { text: "", images: [], files: [], pathReferences: [] };
  const clearEpoch = chat.setPendingLocalThreadDraft(threadId, emptyDraft);
  const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId, { pendingEpoch: clearEpoch ?? undefined });
  await tick(0);
  const duplicateEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: "",
    images: [],
    files: [],
    pathReferences: [],
  });

  assert.equal(duplicateEpoch, clearEpoch);
  chat.setThreadDraftVersion(threadId, null, "web-demo");
  assert.ok(releaseClear);
  (releaseClear as () => void)();
  await clearing;

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftByThreadId[String(threadId)], null);
});

test("older draft clear response cannot overwrite a newer remote draft signal", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-remote-signal-after-clear" as any;
  let releaseClear: (() => void) | null = null;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/clear") throw new Error(`unexpected request: ${url.pathname}`);
    await clearGate;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  chat.setThreadDraft(threadId, {
    text: "待清除草稿",
    images: [],
    files: [],
    pathReferences: [],
    version: 5,
    updatedAt: 5,
    updatedByWebSessionId: "web-demo",
  });
  const emptyDraft = { text: "", images: [], files: [], pathReferences: [] };
  const pendingEpoch = chat.setPendingLocalThreadDraft(threadId, emptyDraft);
  const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId, { pendingEpoch: pendingEpoch ?? undefined });
  await tick(0);
  chat.setThreadDraftVersion(threadId, 1, "web-other");

  assert.ok(releaseClear);
  (releaseClear as () => void)();
  await clearing;

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftVersionByThreadId[String(threadId)], 1);
  assert.equal(chat.threadDraftByThreadId[String(threadId)], undefined);
});

test("draft mutation without an explicit epoch cannot clear a pending draft created in flight", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-no-epoch-clear" as any;
  let releaseClear: (() => void) | null = null;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/clear") throw new Error(`unexpected request: ${url.pathname}`);
    await clearGate;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  chat.setThreadDraft(threadId, {
    text: "已确认草稿",
    images: [],
    files: [],
    pathReferences: [],
    version: 4,
    updatedAt: 4,
    updatedByWebSessionId: "web-demo",
  });
  const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId);
  await tick(0);
  const pendingEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: "请求发出后新建的草稿",
    images: [],
    files: [],
    pathReferences: [],
  });

  assert.ok(releaseClear);
  (releaseClear as () => void)();
  await clearing;

  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], pendingEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, "请求发出后新建的草稿");
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.version, 4);
});

test("queued no-epoch clear captures pending state when it is enqueued", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-queued-no-epoch-clear" as any;
  let releaseSave: (() => void) | null = null;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === "/api/threads/draft/save") {
      await saveGate;
      return jsonResponse({ ok: true, version: 1, updatedAt: 1, updatedByWebSessionId: "web-demo" });
    }
    if (url.pathname === "/api/threads/draft/clear") return jsonResponse({ ok: true });
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const oldDraft = { text: "占用队列的草稿", images: [], files: [], pathReferences: [] };
  const oldEpoch = chat.setPendingLocalThreadDraft(threadId, oldDraft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, oldDraft, { pendingEpoch: oldEpoch ?? undefined });
  await tick(0);
  chat.clearPendingLocalThreadDraft(threadId, oldEpoch ?? undefined);
  const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId);
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, {
    text: "clear 入队后创建的草稿",
    images: [],
    files: [],
    pathReferences: [],
  });

  assert.ok(releaseSave);
  (releaseSave as () => void)();
  await Promise.all([saving, clearing]);

  assert.deepEqual(requests, ["/api/threads/draft/save", "/api/threads/draft/clear"]);
  assert.equal(chat.pendingLocalThreadDraftEpochByThreadId[String(threadId)], newEpoch);
  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)]?.text, "clear 入队后创建的草稿");
});

test("draft saves are serialized so the newest request remains authoritative", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-serialized-draft-save" as any;
  const releases: Array<() => void> = [];
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    const requestIndex = requestCount++;
    await new Promise<void>((resolve) => releases.push(resolve));
    return jsonResponse({
      ok: true,
      version: requestIndex + 1,
      updatedAt: requestIndex + 1,
      updatedByWebSessionId: `web-${requestIndex + 1}`,
    });
  }) as typeof fetch;

  const oldDraft = { text: "旧草稿", images: [], files: [], pathReferences: [] };
  const oldEpoch = chat.setPendingLocalThreadDraft(threadId, oldDraft);
  const oldSaving = chat.saveThreadDraft(ctx, workspaceId, threadId, oldDraft, { pendingEpoch: oldEpoch ?? undefined });
  await tick(0);
  const newDraft = { text: "新草稿", images: [], files: [], pathReferences: [] };
  const newEpoch = chat.setPendingLocalThreadDraft(threadId, newDraft);
  const newSaving = chat.saveThreadDraft(ctx, workspaceId, threadId, newDraft, { pendingEpoch: newEpoch ?? undefined });
  await tick(0);

  assert.equal(requestCount, 1);
  releases[0]!();
  for (let attempt = 0; attempt < 20 && requestCount < 2; attempt += 1) await tick(0);
  assert.equal(requestCount, 2);
  releases[1]!();
  await Promise.all([oldSaving, newSaving]);

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.text, "新草稿");
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.version, 2);
});

test("queued draft mutations keep the authentication identity captured at enqueue time", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-frozen-draft-auth" as any;
  let dynamicSessionToken = "session-old";
  let clearSessionCalls = 0;
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const authorizations: string[] = [];
  let requestCount = 0;
  const ctx: ApiRequestContext = {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-old",
    webSessionId: "web-old",
    ensureSession: async () => dynamicSessionToken,
    clearSession: () => {
      clearSessionCalls += 1;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/draft/save") throw new Error(`unexpected request: ${url.pathname}`);
    authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
    const index = requestCount++;
    if (index === 0) {
      await firstGate;
      return jsonResponse({ ok: true, version: 1, updatedAt: 1, updatedByWebSessionId: "web-old" });
    }
    return jsonResponse({ ok: false, code: "UNAUTHORIZED", message: "old session expired" }, 401);
  }) as typeof fetch;

  const firstDraft = { text: "旧身份草稿一", images: [], files: [], pathReferences: [] };
  const firstEpoch = chat.setPendingLocalThreadDraft(threadId, firstDraft);
  const firstSaving = chat.saveThreadDraft(ctx, workspaceId, threadId, firstDraft, { pendingEpoch: firstEpoch ?? undefined });
  await tick(0);
  const secondDraft = { text: "旧身份草稿二", images: [], files: [], pathReferences: [] };
  const secondEpoch = chat.setPendingLocalThreadDraft(threadId, secondDraft);
  const secondSaving = chat.saveThreadDraft(ctx, workspaceId, threadId, secondDraft, { pendingEpoch: secondEpoch ?? undefined });
  await tick(0);
  dynamicSessionToken = "session-new";

  assert.ok(releaseFirst);
  (releaseFirst as () => void)();
  await firstSaving;
  await assert.rejects(secondSaving, /old session expired/);

  assert.deepEqual(authorizations, ["Bearer session-old", "Bearer session-old"]);
  assert.equal(clearSessionCalls, 0);
});

test("draft clear and save are serialized so a late clear cannot erase a newer draft", async () => {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as any;
  const threadId = "thread-serialized-draft-clear" as any;
  const requests: string[] = [];
  const releases: Array<() => void> = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    await new Promise<void>((resolve) => releases.push(resolve));
    if (url.pathname === "/api/threads/draft/clear") return jsonResponse({ ok: true });
    if (url.pathname === "/api/threads/draft/save") {
      return jsonResponse({ ok: true, version: 2, updatedAt: 2, updatedByWebSessionId: "web-new" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const emptyDraft = { text: "", images: [], files: [], pathReferences: [] };
  const clearEpoch = chat.setPendingLocalThreadDraft(threadId, emptyDraft);
  const clearing = chat.clearThreadDraft(ctx, workspaceId, threadId, { pendingEpoch: clearEpoch ?? undefined });
  await tick(0);
  const newDraft = { text: "清除后的新草稿", images: [], files: [], pathReferences: [] };
  const saveEpoch = chat.setPendingLocalThreadDraft(threadId, newDraft);
  const saving = chat.saveThreadDraft(ctx, workspaceId, threadId, newDraft, { pendingEpoch: saveEpoch ?? undefined });
  await tick(0);

  assert.deepEqual(requests, ["/api/threads/draft/clear"]);
  releases[0]!();
  for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) await tick(0);
  assert.deepEqual(requests, ["/api/threads/draft/clear", "/api/threads/draft/save"]);
  releases[1]!();
  await Promise.all([clearing, saving]);

  assert.equal(chat.pendingLocalThreadDraftByThreadId[String(threadId)], undefined);
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.text, "清除后的新草稿");
  assert.equal(chat.threadDraftByThreadId[String(threadId)]?.version, 2);
});

test("shared workspace subscription resolves only after server ack", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const chat = useChatStore();
  const presence = usePresenceStore();
  const engine = useEngineStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = {
    userId: "user-shared-sub",
    email: "user-shared-sub@codeflow.test",
    fullName: "User Shared Sub",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: "enterprise_shared_sub",
    enterpriseName: "Enterprise Shared Sub",
  } as any;
  config.sessionToken = "session-shared-sub";
  config.sessionExpiresAt = Date.now() + 60_000;

  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: any[] = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    sent: any[] = [];
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
    emit(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/ws-bridge") {
      return jsonResponse({ ok: true, bridgeToken: "bridge-shared-sub" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  (globalThis as any).window = {
    setTimeout,
    clearTimeout,
  };
  (globalThis as any).WebSocket = FakeWebSocket;

  try {
    const ws = createWebSocketClient({ config, chat, presence, engine });
    await ws.connect();
    const socket = sockets[0];
    assert.ok(socket);

    const pending = ws.subscribeSharedWorkspace("sw_subscribe_ack", { sinceSeq: 42 });
    assert.equal(chat.workspaceSubscriptionAckTick, 0);
    const sent = socket.sent.at(-1);
    assert.equal(sent.t, "sharedWorkspace.subscribe");
    assert.equal(sent.message.sharedWorkspaceId, "sw_subscribe_ack");
    assert.equal(sent.message.sinceSeq, 42);

    socket.emit({
      t: "sharedWorkspace.subscribeAck",
      ack: {
        requestId: sent.message.requestId,
        sharedWorkspaceId: "sw_subscribe_ack",
        topic: "sharedWorkspace:sw_subscribe_ack",
        sinceSeq: 42,
        bufferedCount: 3,
        serverSeq: 99,
        bootstrap: null,
      },
    });
    const resolved = await pending;

    assert.equal(resolved.sharedWorkspaceId, "sw_subscribe_ack");
    assert.equal(resolved.bufferedCount, 3);
    assert.equal(chat.workspaceSubscriptionAckTick, 1);
    assert.equal(config.lastBackfillCount, 3);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("disconnect followed by immediate reconnect ignores the late bridge result and opens a fresh WebSocket", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const chat = useChatStore();
  const presence = usePresenceStore();
  const engine = useEngineStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = {
    userId: "user-disconnect-bridge",
    email: "user-disconnect-bridge@codeflow.test",
    fullName: "User Disconnect Bridge",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: null,
    enterpriseName: null,
  } as any;
  config.sessionToken = "session-disconnect-bridge";
  config.sessionExpiresAt = Date.now() + 60_000;

  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: unknown[] = [];
  const bridgeResolvers: Array<(response: Response) => void> = [];
  const bridgeAuthorizations: string[] = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    constructor(public readonly url: string) {
      sockets.push(this);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/ws-bridge") {
      bridgeAuthorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""));
      return await new Promise<Response>((resolve) => {
        bridgeResolvers.push(resolve);
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = FakeWebSocket;

  try {
    const ws = createWebSocketClient({ config, chat, presence, engine });
    const staleConnecting = ws.connect();
    await tick(0);
    assert.equal(bridgeResolvers.length, 1);

    ws.disconnect();
    config.sessionToken = "session-reconnect-fresh";
    config.sessionExpiresAt = Date.now() + 60_000;
    const freshConnecting = ws.connect();
    bridgeResolvers[0]!(jsonResponse({ ok: false, message: "账号会话已过期，请重新登录" }, 401));
    for (let attempt = 0; attempt < 20 && bridgeResolvers.length < 2; attempt += 1) await tick(0);
    assert.equal(bridgeResolvers.length, 2);
    assert.equal(config.sessionToken, "session-reconnect-fresh");
    bridgeResolvers[1]!(jsonResponse({ ok: true, bridgeToken: "bridge-reconnect-fresh" }));
    await Promise.all([staleConnecting, freshConnecting]);

    assert.equal(sockets.length, 1);
    assert.match(String((sockets[0] as FakeWebSocket).url), /bridge-reconnect-fresh/);
    assert.deepEqual(bridgeAuthorizations, ["Bearer session-disconnect-bridge", "Bearer session-reconnect-fresh"]);
    assert.equal(config.connectionStatus, "connecting");
    assert.equal(config.webSessionId, null);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("conversation terminal event refreshes selected requirement-analysis session state", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const chat = useChatStore();
  const presence = usePresenceStore();
  const engine = useEngineStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = {
    userId: "user-requirement-refresh",
    email: "user-requirement-refresh@codeflow.test",
    fullName: "User Requirement Refresh",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: null,
    enterpriseName: null,
  } as any;
  config.sessionToken = "session-requirement-refresh";
  config.sessionExpiresAt = Date.now() + 60_000;

  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: any[] = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    sent: any[] = [];
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
    emit(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  const refreshCalls: Array<{ workspaceId: string; threadId: string; serverWsOrigin: string }> = [];
  const reportedErrors: string[] = [];
  let refreshError: Error | null = null;
  let refreshGate: Promise<void> | null = null;
  let releaseRefreshGate: (() => void) | null = null;
  let ws!: ReturnType<typeof createWebSocketClient>;
  const requirementAnalysis = {
    /** 测试替身：记录终局事件触发的需求助手业务态刷新。 */
    async refreshSelectedSessionForThread(ctx: ApiRequestContext, workspaceId: unknown, threadId: unknown) {
      refreshCalls.push({
        workspaceId: String(workspaceId),
        threadId: String(threadId),
        serverWsOrigin: ctx.serverWsOrigin,
      });
      if (refreshGate) await refreshGate;
      if (refreshError) throw refreshError;
      return true;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/ws-bridge") {
      return jsonResponse({ ok: true, bridgeToken: "bridge-requirement-refresh" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  (globalThis as any).window = {
    setTimeout,
    clearTimeout,
  };
  (globalThis as any).WebSocket = FakeWebSocket;

  try {
    ws = createWebSocketClient({
      config,
      chat,
      presence,
      engine,
      requirementAnalysis: requirementAnalysis as any,
      onError: (message) => reportedErrors.push(message),
    });
    await ws.connect();
    const socket = sockets[0];
    assert.ok(socket);

    const pending = ws.replaceWorkspaceSubscription("client-a:ws-demo" as any);
    const sent = socket.sent.at(-1);
    socket.emit({
      t: "web.subscribeAck",
      requestId: sent.requestId,
      workspaceId: "client-a:ws-demo",
      bufferedCount: 0,
    });
    await pending;

    socket.emit({ t: "error", message: "该工作区对应的 client 未连接" });
    await tick(0);
    assert.deepEqual(reportedErrors, []);

    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.started", 201, { turnId: "turn-201" }),
    });
    await tick(30);
    assert.equal(refreshCalls.length, 0);

    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 202, { turnId: "turn-201" }),
    });
    await tick(30);

    assert.deepEqual(refreshCalls, [{
      workspaceId: "client-a:ws-demo",
      threadId: "thread-requirement",
      serverWsOrigin: "ws://127.0.0.1:39280",
    }]);

    refreshError = new Error("该工作区对应的 client 未连接");
    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 203, { turnId: "turn-202" }),
    });
    await tick(30);
    assert.deepEqual(reportedErrors, []);

    refreshError = new Error("读取需求分析状态失败");
    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 204, { turnId: "turn-203" }),
    });
    await tick(30);
    assert.deepEqual(reportedErrors, ["需求分析状态刷新失败（threadId=thread-requirement）：读取需求分析状态失败"]);

    refreshError = new Error("Web 端仅支持账号登录，请先登录账号");
    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 205, { turnId: "turn-204" }),
    });
    await tick(30);
    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 206, { turnId: "turn-205" }),
    });
    await tick(30);
    assert.deepEqual(reportedErrors, [
      "需求分析状态刷新失败（threadId=thread-requirement）：读取需求分析状态失败",
      "需求分析状态刷新失败（threadId=thread-requirement）：Web 端仅支持账号登录，请先登录账号",
    ]);

    refreshGate = new Promise<void>((resolve) => {
      releaseRefreshGate = resolve;
    });
    socket.emit({
      t: "conversation.event",
      event: buildThreadEvent("thread-requirement", "turn.completed", 207, { turnId: "turn-206" }),
    });
    await tick(30);
    const reportedCountBeforeDisconnect = reportedErrors.length;
    ws.disconnect();
    (releaseRefreshGate as (() => void) | null)?.();
    await tick(30);
    assert.equal(reportedErrors.length, reportedCountBeforeDisconnect);

    refreshGate = null;
    await ws.connect();
    const secondSocket = sockets[1];
    assert.ok(secondSocket);
    secondSocket.emit({ t: "error", message: "账号会话已过期，请重新登录" });
    secondSocket.emit({ t: "error", message: "账号会话已过期，请重新登录" });
    await tick(0);
    assert.equal(reportedErrors.length, reportedCountBeforeDisconnect + 1);
    secondSocket.onclose?.({ code: 1008 });
    assert.equal(reportedErrors.length, reportedCountBeforeDisconnect + 1);
  } finally {
    ws.disconnect();
    (globalThis as any).window = originalWindow;
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("silent account summary refresh reuses fresh cache", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const account = useAccountStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = {
    userId: "user-account-cache",
    email: "user-account-cache@codeflow.test",
    fullName: "User Account Cache",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: null,
    enterpriseName: null,
  } as any;
  config.sessionToken = "session-account-cache";
  config.sessionExpiresAt = Date.now() + 60_000;
  let summaryRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/summary") {
      summaryRequests += 1;
      return jsonResponse(buildAccountSummaryResponse(String(summaryRequests)));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const first = await account.loadMeSummary(true, { silent: true, maxAgeMs: 120_000 });
  const second = await account.loadMeSummary(true, { silent: true, maxAgeMs: 120_000 });

  assert.equal(summaryRequests, 1);
  assert.equal(first?.userId, "user-1");
  assert.equal(second?.userId, "user-1");
});

test("workspace list refresh collapses concurrent same-scope requests into a single HTTP call", async () => {
  setActivePinia(createPinia());
  const store = useWorkspacesStore();
  const ctx = createApiContext();
  let workspaceRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/workspaces") {
      workspaceRequests += 1;
      await tick(25);
      return jsonResponse({ ok: true, workspaces: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await Promise.all([
    store.refresh(ctx),
    store.refresh(ctx),
  ]);

  assert.equal(workspaceRequests, 1);
  assert.equal(store.loading, false);
  assert.ok(store.lastLoadedAt > 0);
});

test("workspace list refresh keeps the cached list visible when silent", async () => {
  setActivePinia(createPinia());
  const store = useWorkspacesStore();
  const ctx = createApiContext();
  let workspaceRequests = 0;
  let resolveSilent!: (response: Response) => void;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/workspaces") throw new Error(`unexpected request: ${url.pathname}`);
    workspaceRequests += 1;
    if (workspaceRequests === 1) return jsonResponse({ ok: true, workspaces: [] });
    return new Promise<Response>((resolve) => { resolveSilent = resolve; });
  }) as typeof fetch;

  await store.refresh(ctx);
  assert.ok(store.lastLoadedAt > 0);

  const silent = store.refresh(ctx, { silent: true });
  assert.equal(store.loading, false, "已有缓存时后台刷新不能切回加载态");
  await tick(0);
  resolveSilent(jsonResponse({ ok: true, workspaces: [] }));
  await silent;
  assert.equal(workspaceRequests, 2);
  assert.equal(store.loading, false);
});

test("migrateConfigDefaults normalizes default server origin outside localhost", async () => {
  setActivePinia(createPinia());
  const sessionStorageMock = (() => {
    const map = new Map<string, string>();
    return {
      getItem(key: string) {
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        map.set(key, value);
      },
      removeItem(key: string) {
        map.delete(key);
      },
    };
  })();

  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    location: {
      hostname: "example.com",
      protocol: "https:",
      port: "39281",
      host: "example.com:39281",
    },
    sessionStorage: sessionStorageMock,
  };

  try {
    const { migrateConfigDefaults, useConfigStore } = await import("../src/store/config.ts");
    const store = useConfigStore();
    store.serverWsOrigin = "ws://127.0.0.1:39280/ws/web";

    migrateConfigDefaults();

    assert.equal(store.serverWsOrigin, "wss://example.com:39280");
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test("config store reads Vite env through statically replaceable property access", () => {
  assert.match(configStoreSource, /const viteEnv = import\.meta\.env as Record/u);
  assert.match(configStoreSource, /viteEnv\?\.VITE_CODEFLOWAI_SERVER_WS_ORIGIN/u);
  assert.match(configStoreSource, /viteEnv\?\.VITE_AIDT_CODE_SERVER_WS_ORIGIN/u);
  assert.doesNotMatch(configStoreSource, /readEnvValue|import\.meta\?\.env/u);
});

test("migrateConfigDefaults repairs persisted web port server origin on custom host", async () => {
  setActivePinia(createPinia());
  const sessionStorageMock = (() => {
    const map = new Map<string, string>();
    return {
      getItem(key: string) {
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        map.set(key, value);
      },
      removeItem(key: string) {
        map.delete(key);
      },
    };
  })();

  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = {
    location: {
      hostname: "test.hanshangai.com",
      protocol: "http:",
      port: "39281",
      host: "test.hanshangai.com:39281",
    },
    sessionStorage: sessionStorageMock,
  };

  try {
    const { migrateConfigDefaults, useConfigStore } = await import("../src/store/config.ts");
    const store = useConfigStore();
    store.serverWsOrigin = "ws://test.hanshangai.com:39281";

    migrateConfigDefaults();

    assert.equal(store.serverWsOrigin, "ws://test.hanshangai.com:39280");
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test("thread history load collapses concurrent same-thread requests into a single /api/threads/load call", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let loadRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      await tick(25);
      return jsonResponse(buildLoadThreadResponse("thread-demo"));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await Promise.all([
    store.loadThread(ctx, { workspaceId: "client-a:ws-demo" as any, threadId: "thread-demo" as any }),
    store.loadThread(ctx, { workspaceId: "client-a:ws-demo" as any, threadId: "thread-demo" as any }),
  ]);

  assert.equal(loadRequests, 1);
  assert.equal(store.loadedThreads["thread-demo"], true);
});

test("thread history load stores real-turn activity truth from server response", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse("thread-real-turn", { hasRealTurnActivity: true }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-real-turn" as any,
  });

  assert.equal(store.threadHasRealTurnActivityByThreadId["thread-real-turn"], true);
});

test("thread hydration skips standalone prefs read when initial history load already carries prefs", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let prefsRequests = 0;
  let loadRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/prefs") {
      prefsRequests += 1;
      await tick(20);
      return jsonResponse({ ok: true, prefs: {} });
    }
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      await tick(20);
      return jsonResponse(buildLoadThreadResponse("thread-hydrate-demo"));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await Promise.all([
    store.ensureThreadHydrated(ctx, { workspaceId: "client-a:ws-demo" as any, threadId: "thread-hydrate-demo" as any }),
    store.ensureThreadHydrated(ctx, { workspaceId: "client-a:ws-demo" as any, threadId: "thread-hydrate-demo" as any }),
  ]);

  assert.equal(prefsRequests, 0);
  assert.equal(loadRequests, 1);
  assert.equal(store.loadedThreads["thread-hydrate-demo"], true);
});

test("thread load response draft is reused by activation draft read", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let loadRequests = 0;
  let draftRequests = 0;
  const threadId = "thread-load-draft-cache";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      return jsonResponse({
        ...buildLoadThreadResponse(threadId),
        draft: {
          text: "cached draft",
          images: [],
          files: [],
          version: 7,
          updatedAt: 70,
          updatedByWebSessionId: "web-other",
        },
      });
    }
    if (url.pathname === "/api/threads/draft/get") {
      draftRequests += 1;
      throw new Error("cached activation draft should not hit remote draft API");
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.ensureThreadHydrated(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  });
  const draft = await store.getThreadDraft(ctx, "client-a:ws-demo" as any, threadId as any);

  assert.equal(loadRequests, 1);
  assert.equal(draftRequests, 0);
  assert.equal(draft?.text, "cached draft");
  assert.equal(store.threadDraftVersionByThreadId[threadId], 7);
});

test("loaded thread hydration refreshes prefs without replaying history", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let prefsRequests = 0;
  let loadRequests = 0;
  const threadId = "thread-loaded-prefs-refresh";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "已加载会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/prefs") {
      prefsRequests += 1;
      return jsonResponse({ ok: true, prefs: { model: "gpt-test" } });
    }
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      throw new Error("loaded thread hydration should not replay history");
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.ensureThreadHydrated(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  });

  assert.equal(prefsRequests, 1);
  assert.equal(loadRequests, 0);
  assert.equal(store.threadPrefsByThreadId[threadId]?.model, "gpt-test");
});

test("embedded thread activation converges on a settled runtime state", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/prefs") {
      return jsonResponse({ ok: true, prefs: {} });
    }
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse("thread-embedded-demo"));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.activateEmbeddedThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-embedded-demo" as any,
    key: "embedded:thread-embedded-demo",
    owner: "embedded",
  });

  const activation = store.threadActivationForThread("thread-embedded-demo" as any);
  assert.equal(activation.owner, "embedded");
  assert.equal(activation.phase, "settled");
  assert.equal(store.loadedThreads["thread-embedded-demo"], true);
});

test("已加载的嵌入节点线程重新打开时会用 summary 清理陈旧 runningTurnId", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let summaryRequests = 0;
  let loadRequests = 0;

  store.upsertThreadSummary({
    id: "thread-embedded-stale-running" as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads["thread-embedded-stale-running"] = true;
  const state = store.ensureConversation("thread-embedded-stale-running" as any);
  state.runningTurnId = "turn_stale_running" as any;
  state.runningTurnStartedAt = 123;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/prefs") {
      return jsonResponse({ ok: true, prefs: {} });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryRequests += 1;
      return jsonResponse(buildThreadSummaryResponse("thread-embedded-stale-running", {
        threadType: "orchestration",
        threadSubtype: "node",
        running: null,
      }));
    }
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      throw new Error("embedded reopen should not replay history when thread is already loaded");
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.activateEmbeddedThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-embedded-stale-running" as any,
    key: "embedded:thread-embedded-stale-running",
    owner: "embedded",
  });

  const activation = store.threadActivationForThread("thread-embedded-stale-running" as any);
  assert.equal(summaryRequests, 1);
  assert.equal(loadRequests, 0);
  assert.equal(activation.owner, "embedded");
  assert.equal(activation.phase, "settled");
  assert.equal(store.conversations["thread-embedded-stale-running"]?.runningTurnId, "turn_stale_running");
  assert.equal(store.threadDisplayRunningStateForThread("thread-embedded-stale-running" as any), null);
});

test("loadThread scope 失效后不会丢掉加载期间缓冲的 live terminal 事件", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let loadRequests = 0;
  let resolveFirstLoad: (() => void) | null = null;
  const firstLoadGate = new Promise<void>((resolve) => {
    resolveFirstLoad = resolve;
  });

  const staleHistory = buildLoadThreadResponse("thread-buffered-live", {
    hasRealTurnActivity: true,
    running: { runningTurnId: "turn-running", runningTurnStartedAt: 100 },
    events: [
      buildEvent("turn.started", 1, {
        turnId: "turn-running",
      }),
    ],
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      if (loadRequests === 1) {
        await firstLoadGate;
      }
      return jsonResponse(staleHistory);
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const firstLoad = store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-buffered-live" as any,
  });
  await tick();

  store.applyEngineEvent(buildEvent("turn.error", 2, {
    turnId: "turn-running",
    error: "turn interrupted",
    code: "turn_interrupted",
    terminationKind: "manual_interrupt",
  }));
  store.invalidateThreadScopes("thread-buffered-live" as any, { reason: "scope-change" });

  (resolveFirstLoad as (() => void) | null)?.();
  await firstLoad;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-buffered-live" as any,
  });

  const conversation = store.conversations["thread-buffered-live"];
  assert.ok(conversation);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(conversation?.completedTurnIds["turn-running"], true);
  assert.deepEqual(
    conversation?.items.filter((item) => item.kind === "systemMessage").map((item) => item.text),
    ["刚才那次请求已中止，可继续发送消息。"],
  );
  assert.equal(store.activeWorkspaceLastEventSeq, 2);
});

test("loadThread keeps runtime running state when replay already has terminal event", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-runtime-terminal";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, {
        hasRealTurnActivity: true,
        running: {
          runningTurnId: "turn-runtime-stuck",
          runningTurnStartedAt: 321,
          runningSource: "runtime",
        },
        events: [
          buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-runtime-stuck" }),
          buildThreadEvent(threadId, "turn.completed", 2, {
            turnId: "turn-runtime-stuck",
            result: { responseText: "done" },
          }),
        ],
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  });

  const conversation = store.conversations[threadId];
  assert.ok(conversation);
  assert.equal(conversation?.completedTurnIds["turn-runtime-stuck"], true);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-runtime-stuck");
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnStartedAt, 321);
});

test("loadThread prefers current runtime running state over stale replay running state", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-runtime-over-stale-replay";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, {
        hasRealTurnActivity: true,
        running: {
          runningTurnId: "turn-runtime-current",
          runningTurnStartedAt: 987,
          runningSource: "runtime",
        },
        events: [
          buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-replay-stale" }),
        ],
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  });

  assert.equal(store.conversations[threadId]?.runningTurnId, "turn-runtime-current");
  assert.equal(store.conversations[threadId]?.runningTurnStartedAt, 987);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-runtime-current");
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnStartedAt, 987);
});

for (const terminalType of ["turn.completed", "turn.error"] as const) {
  test(`late ${terminalType} from an older turn keeps the newer turn running`, () => {
    setActivePinia(createPinia());
    const store = useChatStore();
    const threadId = `thread-late-${terminalType}`;

    store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 1, { turnId: "turn-old" }));
    store.applyEngineEvent(buildThreadEvent(threadId, "turn.completed", 2, {
      turnId: "turn-old",
      result: { responseText: "first completion" },
    }));
    store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 3, { turnId: "turn-new" }));
    store.applyEngineEvent(buildThreadEvent(threadId, terminalType, 4, terminalType === "turn.error"
      ? { turnId: "turn-old", error: "late failure", code: "late_failure" }
      : { turnId: "turn-old", result: { responseText: "late completion" } }));

    assert.equal(store.conversations[threadId]?.runningTurnId, "turn-new");
    assert.equal(store.threadRunningHintByThreadId[threadId]?.running?.runningTurnId, "turn-new");
    assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-new");
  });
}

test("late terminal from an older turn keeps a newer pending dispatch", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-late-terminal-pending";

  store.setThreadPendingDispatch(threadId as any, "turn-new-pending");
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.completed", 1, {
    turnId: "turn-old",
    result: { responseText: "late completion" },
  }));

  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, "turn-new-pending");
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-new-pending");
});

test("buffered replay keeps a newer turn running when an older terminal arrives during replay", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-buffered-late-terminal";
  const replayEvents = Array.from({ length: 250 }, (_, index) => {
    const turnId = `turn-replay-${index + 1}`;
    return [
      buildThreadEvent(threadId, "turn.started", index * 2 + 1, { turnId }),
      buildThreadEvent(threadId, "turn.completed", index * 2 + 2, {
        turnId,
        result: { responseText: "done" },
      }),
    ];
  }).flat();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, {
        hasRealTurnActivity: true,
        events: replayEvents,
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const originalSetTimeout = globalThis.setTimeout;
  let injectedBufferedEvents = false;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (!injectedBufferedEvents && timeout === 0 && store.threadLoading?.stage === "replaying") {
      injectedBufferedEvents = true;
      store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 501, { turnId: "turn-new" }));
      store.applyEngineEvent(buildThreadEvent(threadId, "turn.completed", 502, {
        turnId: "turn-replay-250",
        result: { responseText: "late completion" },
      }));
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    await store.loadThread(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      limit: 1000,
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(injectedBufferedEvents, true);
  assert.equal(store.conversations[threadId]?.runningTurnId, "turn-new");
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-new");
});

test("节点线程发送时不会吃 ACK ghost turnId，而是同步 authoritative runningTurnId", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let summaryRequests = 0;

  store.upsertThreadSummary({
    id: "orch-node-thread" as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-ghost-running",
        dispatchMode: "chat_turn",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryRequests += 1;
      return jsonResponse(buildThreadSummaryResponse("orch-node-thread", {
        threadType: "orchestration",
        threadSubtype: "node",
        running: {
          runningTurnId: "turn_orch_authoritative_1",
          runningTurnStartedAt: 123,
        },
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const turnId = await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "orch-node-thread" as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  const conversation = store.conversations["orch-node-thread"];
  assert.equal(turnId, "turn-ghost-running");
  assert.ok(conversation);
  assert.equal(summaryRequests, 1);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread("orch-node-thread" as any)?.runningTurnId, "turn_orch_authoritative_1");
  assert.equal(store.threadDisplayRunningStateForThread("orch-node-thread" as any)?.runningTurnStartedAt, 123);
});

test("threads list running hint 不再直写 conversation.runningTurnId，但显示态仍可见", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads") {
      return jsonResponse({
        ok: true,
        threads: [
          {
            id: "thread-list-running",
            title: "列表线程",
            threadType: "chat",
            threadSubtype: null,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            engine: "codex",
          },
        ],
        runningByThreadId: {
          "thread-list-running": {
            runningTurnId: "turn-list-running-1",
            runningTurnStartedAt: 222,
          },
        },
        hasMore: false,
        nextCursor: null,
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshThreads(ctx, "client-a:ws-demo" as any);

  const conversation = store.conversations["thread-list-running"];
  assert.equal(conversation, undefined);
  assert.equal(store.threadDisplayRunningStateForThread("thread-list-running" as any)?.runningTurnId, "turn-list-running-1");
});

test("threads list 的 workflowByThreadId 写入会话工作流 overlay，缺失时清除旧标签", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let includeWorkflow = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads") {
      return jsonResponse({
        ok: true,
        threads: [
          {
            id: "thread-workflow-list",
            title: "工作流会话",
            threadType: "chat",
            threadSubtype: null,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            engine: "codex",
          },
        ],
        runningByThreadId: {},
        ...(includeWorkflow
          ? { workflowByThreadId: { "thread-workflow-list": { status: "waiting-approval", instanceId: "instance-1", taskId: "task-1" } } }
          : {}),
        hasMore: false,
        nextCursor: null,
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.refreshThreads(ctx, "client-a:ws-demo" as any);
  assert.deepEqual(store.threadWorkflowByThreadId["thread-workflow-list"], {
    status: "waiting-approval",
    instanceId: "instance-1",
    taskId: "task-1",
  });

  includeWorkflow = false;
  await store.refreshThreads(ctx, "client-a:ws-demo" as any);
  assert.equal(store.threadWorkflowByThreadId["thread-workflow-list"], undefined);
});

test("display conversation getter 只叠加显示态 running，不回写 canonical conversation", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-display-running";
  const conversation = store.ensureConversation(threadId as any);

  store.setThreadPendingDispatch(threadId as any, "turn-pending-running");
  let displayConversation = store.threadDisplayConversationForThread(threadId as any);
  assert.ok(displayConversation);
  assert.equal(displayConversation?.runningTurnId, "turn-pending-running");
  assert.equal(conversation.runningTurnId, null);

  store.setThreadRunningHint(threadId as any, {
    runningTurnId: "turn-authoritative-hint" as any,
    runningTurnStartedAt: 345,
  });
  displayConversation = store.threadDisplayConversationForThread(threadId as any);
  assert.ok(displayConversation);
  assert.equal(displayConversation?.runningTurnId, "turn-authoritative-hint");
  assert.equal(displayConversation?.runningTurnStartedAt, 345);
  assert.equal(conversation.runningTurnId, null);
  assert.equal(conversation.runningTurnStartedAt, null);
});

test("已 hydrate thread 不会被 list hint 覆盖 canonical running truth", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-hydrated-list-hint";
  const conversation = store.ensureConversation(threadId as any);

  store.loadedThreads[threadId] = true;
  conversation.runningTurnId = "turn-live-running" as any;
  conversation.runningTurnStartedAt = 321;

  store.setThreadRunningHint(threadId as any, null, { source: "list" });
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-live-running");

  store.setThreadRunningHint(threadId as any, {
    runningTurnId: "turn-stale-list-running" as any,
    runningTurnStartedAt: 999,
  }, { source: "list" });
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-live-running");

  conversation.runningTurnId = null;
  conversation.runningTurnStartedAt = null;
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
});

test("thread changed cleared/deleted 会清理 display running 辅助状态与 pending local message", () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const threadId = "thread-server-changed-cleanup";

  store.ensureConversation(threadId as any);
  store.setThreadRunningHint(threadId as any, {
    runningTurnId: "turn-running-before-clear" as any,
    runningTurnStartedAt: 111,
  });
  store.setThreadPendingDispatch(threadId as any, "turn-pending-before-clear");
  store.pendingLocalUserMessageByThreadId[threadId] = buildThreadEvent(threadId, "item.userMessage.created", 1, {
    turnId: "turn-pending-before-clear",
    itemId: "item-local-before-clear",
    text: "继续",
  });

  store.handleThreadChangedFromServer({
    threadId: threadId as any,
    kind: "cleared",
  });

  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);

  store.ensureConversation(threadId as any);
  store.setThreadRunningHint(threadId as any, {
    runningTurnId: "turn-running-before-delete" as any,
    runningTurnStartedAt: 222,
  });
  store.setThreadPendingDispatch(threadId as any, "turn-pending-before-delete");
  store.pendingLocalUserMessageByThreadId[threadId] = buildThreadEvent(threadId, "item.userMessage.created", 2, {
    turnId: "turn-pending-before-delete",
    itemId: "item-local-before-delete",
    text: "继续",
  });

  store.handleThreadChangedFromServer({
    threadId: threadId as any,
    kind: "deleted",
  });

  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
  assert.equal(store.conversations[threadId], undefined);
});

test("authoritative loadThread running=null 会清理 pending dispatch，避免显示态保留旧 spinner", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-load-clears-pending-dispatch";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;
  store.setThreadPendingDispatch(threadId as any, "turn-pending-before-load");

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, {
        events: [],
        running: null,
        hasRealTurnActivity: false,
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-pending-before-load");

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 200,
  });

  assert.equal(store.threadPendingDispatchByThreadId[threadId], undefined);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
});

test("authoritative summary running=null 会清理 pending dispatch，避免 reopen 后继续显示 ghost spinner", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-summary-clears-pending-dispatch";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.setThreadPendingDispatch(threadId as any, "turn-pending-before-summary");

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/summary") {
      return jsonResponse(buildThreadSummaryResponse(threadId, {
        threadType: "chat",
        threadSubtype: null,
        running: null,
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-pending-before-summary");

  await store.syncThreadSummaryState(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    waitForRunning: false,
  });

  assert.equal(store.threadPendingDispatchByThreadId[threadId], undefined);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
});

test("loadThreadPage 不会丢掉分页回放期间到达的 live terminal 事件", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-page-buffered-live";
  let resolveLoad: (() => void) | null = null;
  const loadGate = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });

  store.upsertThreadSummary({
    id: threadId as any,
    title: "分页线程",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;
  store.threadBasePrefsByThreadId[threadId] = {};
  store.threadLoadMetaByThreadId[threadId] = {
    limit: 200,
    loadedEvents: 1,
    hasMore: true,
    oldestLoadedSeq: 2,
    loadingMore: false,
  };

  const startedEvent = buildThreadEvent(threadId, "turn.started", 2, {
    turnId: "turn-page-live",
  });
  store.threadReplayEventsByThreadId[threadId] = [startedEvent];
  store.applyEngineEvent(startedEvent, { updateLastSeq: false });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.beforeSeq, 2);
      await loadGate;
      return jsonResponse(buildLoadThreadResponse(threadId, {
        hasRealTurnActivity: true,
        running: {
          runningTurnId: "turn-page-live",
          runningTurnStartedAt: 2,
        },
        oldestSeq: 1,
        latestSeq: 3,
        events: [
          buildThreadEvent(threadId, "item.userMessage.created", 1, {
            turnId: "turn-page-live",
            itemId: "item-user-page-1",
            text: "更早的消息",
          }),
        ],
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const pageLoad = store.loadThreadPage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
  });
  await tick();

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.error", 3, {
    turnId: "turn-page-live",
    error: "turn interrupted",
    code: "turn_interrupted",
    terminationKind: "manual_interrupt",
  }));

  (resolveLoad as (() => void) | null)?.();
  await pageLoad;

  const conversation = store.conversations[threadId];
  assert.ok(conversation);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(conversation?.completedTurnIds["turn-page-live"], true);
  assert.deepEqual(
    conversation?.items.filter((item) => item.kind === "systemMessage").map((item) => item.text),
    ["刚才那次请求已中止，可继续发送消息。"],
  );
});

test("clearThread 本地 reload 前会先清空 replay cache，避免旧历史被重新拼回当前页", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-clear-resets-replay";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "待清空会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.selectThread(threadId as any);
  store.loadedThreads[threadId] = true;
  store.threadLoadMetaByThreadId[threadId] = {
    limit: 200,
    loadedEvents: 1,
    hasMore: false,
    oldestLoadedSeq: 1,
    loadingMore: false,
  };
  const oldMessage = buildThreadEvent(threadId, "item.userMessage.created", 1, {
    turnId: "turn-old-history",
    itemId: "item-old-history",
    text: "旧历史",
  });
  store.threadReplayEventsByThreadId[threadId] = [oldMessage];
  store.applyEngineEvent(oldMessage, { updateLastSeq: false });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/clear") {
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/api/threads/load") {
      return jsonResponse(buildLoadThreadResponse(threadId, {
        events: [],
        running: null,
        hasRealTurnActivity: false,
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.clearThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    resetSession: true,
  });

  let conversation = store.conversations[threadId];
  assert.ok(conversation);
  assert.equal(conversation?.items.length ?? 0, 0);
  assert.deepEqual(store.threadReplayEventsByThreadId[threadId] ?? [], []);

  store.handleThreadChangedFromServer({
    threadId: threadId as any,
    kind: "cleared",
  });

  conversation = store.conversations[threadId];
  assert.ok(conversation);
  assert.equal(conversation?.items.length ?? 0, 0);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
});

test("已加载的节点线程 chat_turn 发送后会立即把用户消息写到当前页，并在真实 userMessage.created 到达后去重", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "orch-chat-turn-thread";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-orch-chat-turn-1",
        dispatchMode: "chat_turn",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      return jsonResponse(buildThreadSummaryResponse(threadId, {
        threadType: "orchestration",
        threadSubtype: "node",
        running: {
          runningTurnId: "turn_orch_authoritative_2",
          runningTurnStartedAt: 321,
        },
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const turnId = await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  let conversation = store.conversations[threadId];
  assert.equal(turnId, "turn-orch-chat-turn-1");
  assert.ok(conversation);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn_orch_authoritative_2");
  let userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.text, "继续");

  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", 1, {
    turnId: "turn_orch_authoritative_2",
    itemId: "item_user_authoritative_2",
    text: "继续",
  }));

  conversation = store.conversations[threadId];
  userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.id, "item_user_authoritative_2");
  assert.equal(userMessages[0]?.turnId, "turn_orch_authoritative_2");
});

test("权威 userMessage.created 先于 send ACK 到达时不会追加重复本地消息", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as WorkspaceId;
  const threadId = "thread-user-message-before-ack" as ThreadId;
  const eventSeq = Date.now();

  store.upsertThreadSummary({
    id: threadId,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/threads/send") throw new Error(`unexpected request: ${url.pathname}`);
    store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", eventSeq, {
      turnId: "turn-user-message-before-ack",
      itemId: "item-user-message-before-ack",
      text: "检查重复消息",
    }));
    return jsonResponse({
      ok: true,
      turnId: "turn-user-message-before-ack",
      dispatchMode: "chat_turn",
    });
  }) as typeof fetch;

  await store.sendMessage(ctx, {
    workspaceId,
    threadId,
    text: "检查重复消息",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.id, "item-user-message-before-ack");
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
});

test("已有相同权威消息且新 send ACK 先到时会保留当前本地消息", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as WorkspaceId;
  const threadId = "thread-repeated-user-message" as ThreadId;
  const eventSeq = Date.now();

  store.upsertThreadSummary({
    id: threadId,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;
  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", eventSeq - 1_000, {
    turnId: "turn-repeated-user-message-old",
    itemId: "item-repeated-user-message-old",
    text: "继续",
  }));

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    // 「继续」属工作流自然语言入口的判定范围，发送前会先问一次该接口；未命中再走普通发送。
    if (url.pathname === "/api/orch/chat/natural") return jsonResponse({ ok: true, handled: false });
    if (url.pathname !== "/api/threads/send") throw new Error(`unexpected request: ${url.pathname}`);
    return jsonResponse({
      ok: true,
      turnId: "turn-repeated-user-message-new",
      dispatchMode: "chat_turn",
    });
  }) as typeof fetch;

  await store.sendMessage(ctx, {
    workspaceId,
    threadId,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  let userMessages = store.conversations[threadId]?.items.filter(
    (item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.equal(userMessages.length, 2);
  assert.equal(userMessages[1]?.id, "local_user_turn-repeated-user-message-new");
  assert.ok(store.pendingLocalUserMessageByThreadId[threadId]);

  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", eventSeq + 1, {
    turnId: "turn-repeated-user-message-new",
    itemId: "item-repeated-user-message-new",
    text: "继续",
  }));

  userMessages = store.conversations[threadId]?.items.filter(
    (item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.equal(userMessages.length, 2);
  assert.equal(userMessages[1]?.id, "item-repeated-user-message-new");
  assert.equal(store.pendingLocalUserMessageByThreadId[threadId], undefined);
});

test("pending 本地 user message 会穿过 loadThread 回放，并兼容 engineCall.created 先到的时序", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "orch-chat-turn-replay-thread";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads[threadId] = true;
  store.threadLoadMetaByThreadId[threadId] = {
    limit: 200,
    loadedEvents: 0,
    hasMore: false,
    oldestLoadedSeq: null,
    loadingMore: false,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-orch-chat-turn-replay-1",
        dispatchMode: "chat_turn",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      return jsonResponse(buildThreadSummaryResponse(threadId, {
        threadType: "orchestration",
        threadSubtype: "node",
        running: {
          runningTurnId: "turn_orch_replay_authoritative_1",
          runningTurnStartedAt: 654,
        },
      }));
    }
    if (url.pathname === "/api/threads/load") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.threadId, threadId);
      return jsonResponse(buildLoadThreadResponse(threadId, {
        threadType: "orchestration",
        threadSubtype: "node",
        hasRealTurnActivity: true,
        running: {
          runningTurnId: "turn_orch_replay_authoritative_1",
          runningTurnStartedAt: 654,
        },
        events: [
          buildThreadEvent(threadId, "turn.started", 101, {
            turnId: "turn_orch_replay_authoritative_1",
          }),
        ],
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.engineCall.created", 1, {
    itemId: "item_user_enginecall_authoritative_1",
    call: {
      engineType: "codex",
      cwd: "Z:/code/test-role",
      model: "gpt-5.4",
    },
  }));

  let conversation = store.conversations[threadId];
  let userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.id, "item_user_enginecall_authoritative_1");

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 200,
  });

  conversation = store.conversations[threadId];
  userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.text, "继续");
  assert.equal(userMessages[0]?.id, "item_user_enginecall_authoritative_1");

  store.applyEngineEvent(buildThreadEvent(threadId, "item.userMessage.created", 102, {
    turnId: "turn_orch_replay_authoritative_1",
    itemId: "item_user_enginecall_authoritative_1",
    text: "继续",
  }));

  conversation = store.conversations[threadId];
  userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.id, "item_user_enginecall_authoritative_1");
  assert.equal(userMessages[0]?.turnId, "turn_orch_replay_authoritative_1");
});

test("节点线程 orchestration_feedback 发送后会轮询 summary 同步当前页 runningTurnId", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let summaryRequests = 0;

  store.upsertThreadSummary({
    id: "orch-feedback-thread" as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: null,
        dispatchMode: "orchestration_feedback",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryRequests += 1;
      if (summaryRequests < 3) {
        return jsonResponse(buildThreadSummaryResponse("orch-feedback-thread", {
          threadType: "orchestration",
          threadSubtype: "node",
          running: null,
        }));
      }
      return jsonResponse(buildThreadSummaryResponse("orch-feedback-thread", {
        threadType: "orchestration",
        threadSubtype: "node",
        running: {
          runningTurnId: "turn_orch_feedback_1",
          runningTurnStartedAt: 456,
        },
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const turnId = await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "orch-feedback-thread" as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  const conversation = store.conversations["orch-feedback-thread"];
  assert.equal(turnId, null);
  assert.ok(conversation);
  assert.equal(summaryRequests, 3);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread("orch-feedback-thread" as any)?.runningTurnId, "turn_orch_feedback_1");
  assert.equal(store.threadDisplayRunningStateForThread("orch-feedback-thread" as any)?.runningTurnStartedAt, 456);
});

test("sendMessage 遇到 active turn 冲突后同步权威 running 状态", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-active-conflict-sync";
  let summaryRequests = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: false,
        code: "CLIENT_ERROR",
        message: "当前线程仍有未完成的 AI 回合，请等待本轮完成后再发送。",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryRequests += 1;
      return jsonResponse(buildThreadSummaryResponse(threadId, {
        running: {
          runningTurnId: "turn-active-conflict",
          runningTurnStartedAt: 789,
        },
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await assert.rejects(
    () => store.sendMessage(ctx, {
      workspaceId: "client-a:ws-demo" as any,
      threadId: threadId as any,
      text: "继续",
      workMode: "general",
      planMode: false,
      accessMode: "current",
      model: null,
      effort: null,
      contextWindow: null,
      autoCompactPct: null,
      images: [],
      files: [],
    }),
    /当前线程仍有未完成的 AI 回合/,
  );

  assert.equal(summaryRequests, 1);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, "turn-active-conflict");
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnStartedAt, 789);
});

test("已加载的节点线程在 orchestration_feedback 发送后会立即回放用户消息到当前页", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  let summaryRequests = 0;
  let loadRequests = 0;
  store.threadContentEpochByThreadId["orch-feedback-loaded-thread"] = 7;

  store.upsertThreadSummary({
    id: "orch-feedback-loaded-thread" as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
  store.loadedThreads["orch-feedback-loaded-thread"] = true;
  store.threadLoadMetaByThreadId["orch-feedback-loaded-thread"] = {
    limit: 200,
    loadedEvents: 0,
    hasMore: false,
    oldestLoadedSeq: null,
    loadingMore: false,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: null,
        dispatchMode: "orchestration_feedback",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      summaryRequests += 1;
      return jsonResponse(buildThreadSummaryResponse("orch-feedback-loaded-thread", {
        threadType: "orchestration",
        threadSubtype: "node",
        running: {
          runningTurnId: "turn_orch_feedback_loaded_1",
          runningTurnStartedAt: 789,
        },
      }));
    }
    if (url.pathname === "/api/threads/load") {
      loadRequests += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.threadId, "orch-feedback-loaded-thread");
      assert.equal(body.limit, 200);
      return jsonResponse(buildLoadThreadResponse("orch-feedback-loaded-thread", {
        threadType: "orchestration",
        threadSubtype: "node",
        hasRealTurnActivity: true,
        running: {
          runningTurnId: "turn_orch_feedback_loaded_1",
          runningTurnStartedAt: 789,
        },
        events: [
          buildThreadEvent("orch-feedback-loaded-thread", "turn.started", 101, {
            turnId: "turn_orch_feedback_loaded_1",
          }),
          buildThreadEvent("orch-feedback-loaded-thread", "item.userMessage.created", 102, {
            turnId: "turn_orch_feedback_loaded_1",
            itemId: "item_user_feedback_loaded_1",
            text: "继续",
          }),
        ],
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const turnId = await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "orch-feedback-loaded-thread" as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  const conversation = store.conversations["orch-feedback-loaded-thread"];
  assert.equal(turnId, null);
  assert.ok(conversation);
  assert.equal(summaryRequests, 1);
  assert.equal(loadRequests, 1);
  assert.equal(conversation?.runningTurnId, "turn_orch_feedback_loaded_1");
  assert.equal(store.threadDisplayRunningStateForThread("orch-feedback-loaded-thread" as any)?.runningTurnId, "turn_orch_feedback_loaded_1");
  assert.equal(store.threadContentEpochByThreadId["orch-feedback-loaded-thread"], 7);
  const userMessages = conversation?.items.filter((item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user") ?? [];
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0]?.text, "继续");
});

test("普通 chat 线程发送时会把 ACK turnId 记为 pending dispatch，而不是直接写入 canonical running", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();

  store.upsertThreadSummary({
    id: "chat-thread" as any,
    title: "普通会话",
    engine: "codex",
    threadType: "chat",
    threadSubtype: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-chat-running",
        dispatchMode: "chat_turn",
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  const turnId = await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: "chat-thread" as any,
    text: "hi",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  const conversation = store.conversations["chat-thread"];
  assert.equal(turnId, "turn-chat-running");
  assert.ok(conversation);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread("chat-thread" as any)?.runningTurnId, "turn-chat-running");
});

test("interruptTurn 成功返回 running=null 后立即清理本地显示态", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-demo" as WorkspaceId;
  const threadId = "thread-interrupt-clears-running" as ThreadId;
  const staleTurnId = "turn-stale-before-interrupt" as TurnId;

  store.setThreadPendingDispatch(threadId, "turn-pending-before-interrupt");
  store.setThreadRunningHint(threadId, {
    runningTurnId: staleTurnId,
    runningTurnStartedAt: 123,
  });
  const conversation = store.ensureConversation(threadId);
  conversation.runningTurnId = staleTurnId;
  conversation.runningTurnStartedAt = 123;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/turns/interrupt") {
      return jsonResponse({ ok: true, running: null, alreadyTerminal: true });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.interruptTurn(ctx, {
    workspaceId,
    threadId,
    turnId: staleTurnId,
  });

  assert.equal(store.conversations[threadId]?.runningTurnId, null);
  assert.equal(store.conversations[threadId]?.runningTurnStartedAt, null);
  assert.equal(store.threadDisplayRunningStateForThread(threadId), null);
});

test("interruptTurn 的迟到 running 响应不能复活已收到终态的回合", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-interrupt-terminal-race" as ThreadId;
  const turnId = "turn-interrupt-terminal-race" as TurnId;
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 1, { turnId }));

  let respond!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  const stopping = store.interruptTurn(ctx, { workspaceId: "client-a:ws-demo" as WorkspaceId, threadId, turnId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(respond);

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.error", 2, {
    turnId, error: "turn interrupted", code: "turn_interrupted", terminationKind: "manual_interrupt",
  }));
  respond(jsonResponse({ ok: true, running: { runningTurnId: turnId, runningTurnStartedAt: 1, runningSource: "runtime" } }));
  await stopping;

  assert.equal(store.conversations[threadId]?.completedTurnIds[turnId], true);
  assert.equal(store.conversations[threadId]?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread(threadId), null);
});

test("interruptTurn 的旧响应不能清掉已启动的后继回合", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-interrupt-successor-race" as ThreadId;
  const oldTurnId = "turn-interrupt-old" as TurnId;
  const newTurnId = "turn-interrupt-new" as TurnId;
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 1, { turnId: oldTurnId }));

  let respond!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  const stopping = store.interruptTurn(ctx, { workspaceId: "client-a:ws-demo" as WorkspaceId, threadId, turnId: oldTurnId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(respond);

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.error", 2, {
    turnId: oldTurnId, error: "turn interrupted", code: "turn_interrupted", terminationKind: "manual_interrupt",
  }));
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 3, { turnId: newTurnId }));
  respond(jsonResponse({ ok: true, running: { runningTurnId: oldTurnId, runningTurnStartedAt: 1, runningSource: "runtime" } }));
  await stopping;

  assert.equal(store.conversations[threadId]?.runningTurnId, newTurnId);
  assert.equal(store.threadDisplayRunningStateForThread(threadId)?.runningTurnId, newTurnId);
});

test("interruptTurn 的旧响应保留后继待投递，不把它升级为真实运行回合", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-interrupt-pending-successor" as ThreadId;
  const oldTurnId = "turn-interrupt-old-pending" as TurnId;
  const pendingTurnId = "turn-interrupt-new-pending" as TurnId;
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 1, { turnId: oldTurnId }));

  let respond!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  const stopping = store.interruptTurn(ctx, { workspaceId: "client-a:ws-demo" as WorkspaceId, threadId, turnId: oldTurnId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(respond);

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.error", 2, {
    turnId: oldTurnId, error: "turn interrupted", code: "turn_interrupted", terminationKind: "manual_interrupt",
  }));
  store.setThreadPendingDispatch(threadId, pendingTurnId);
  respond(jsonResponse({ ok: true, running: { runningTurnId: oldTurnId, runningTurnStartedAt: 1, runningSource: "runtime" } }));
  await stopping;

  assert.equal(store.conversations[threadId]?.runningTurnId, null);
  assert.equal(store.threadPendingDispatchByThreadId[threadId]?.turnId, pendingTurnId);
  assert.equal(store.threadDisplayRunningStateForThread(threadId)?.runningTurnId, pendingTurnId);
});

test("节点线程 authoritative turn.started 后 manual_interrupt 能让当前页 processing 状态收口", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "orch-node-thread-live";

  store.upsertThreadSummary({
    id: threadId as any,
    title: "节点会话",
    engine: "codex",
    threadType: "orchestration",
    threadSubtype: "node",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-ghost-running",
        dispatchMode: "chat_turn",
      });
    }
    if (url.pathname === "/api/threads/summary") {
      return jsonResponse(buildThreadSummaryResponse(threadId, {
        threadType: "orchestration",
        threadSubtype: "node",
        running: null,
      }));
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    text: "继续",
    workMode: "general",
    planMode: false,
    accessMode: "current",
    model: null,
    effort: null,
    contextWindow: null,
    autoCompactPct: null,
    images: [],
    files: [],
  });

  let conversation = store.conversations[threadId];
  assert.ok(conversation);
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);

  const authoritativeTurnId = "turn_orch_live_1";
  store.applyEngineEvent(buildThreadEvent(threadId, "turn.started", 1, {
    turnId: authoritativeTurnId,
  }));

  conversation = store.conversations[threadId];
  assert.equal(conversation?.runningTurnId, authoritativeTurnId);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any)?.runningTurnId, authoritativeTurnId);

  store.applyEngineEvent(buildThreadEvent(threadId, "turn.error", 2, {
    turnId: authoritativeTurnId,
    error: "turn interrupted",
    code: "turn_interrupted",
    terminationKind: "manual_interrupt",
  }));

  conversation = store.conversations[threadId];
  assert.equal(conversation?.runningTurnId, null);
  assert.equal(conversation?.runningTurnStartedAt, null);
  assert.equal(store.threadDisplayRunningStateForThread(threadId as any), null);
  assert.deepEqual(
    conversation?.items.filter((item) => item.kind === "systemMessage").map((item) => item.text),
    ["刚才那次请求已中止，可继续发送消息。"],
  );
});

test("thread summary 后台更新保持当前列表顺序，避免活动事件造成跳动", () => {
  setActivePinia(createPinia());
  const store = useChatStore();

  store.threads = [
    {
      id: "thread-stable-a" as any,
      title: "A",
      engine: "codex",
      threadType: "chat",
      threadSubtype: null,
      archived: false,
      createdAt: 1,
      updatedAt: 10,
    },
    {
      id: "thread-stable-b" as any,
      title: "B",
      engine: "codex",
      threadType: "chat",
      threadSubtype: null,
      archived: false,
      createdAt: 2,
      updatedAt: 20,
    },
  ];

  const shouldHydrate = store.handleThreadChangedFromServer({
    threadId: "thread-stable-a" as any,
    kind: "updated",
    patch: { updatedAt: 999 },
  });

  assert.equal(shouldHydrate, false);
  assert.deepEqual(store.threads.map((thread) => String(thread.id)), ["thread-stable-a", "thread-stable-b"]);
  assert.equal(store.threads[0]?.updatedAt, 999);
});

test("HTTP send 与 WS 同 rollback barrier 复用 canonical reload，重复或更小 barrier 不重放", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-http-ws-rollback-dedup";
  let loadCount = 0;
  let fileChangesCount = 0;
  let releaseReload: (() => void) | null = null;
  let releaseFileChanges: (() => void) | null = null;
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const fileChangesGate = new Promise<void>((resolve) => {
    releaseFileChanges = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/threads/load") {
      loadCount += 1;
      if (loadCount === 2) await reloadGate;
      return jsonResponse(buildLoadThreadResponse(threadId, { events: [] }));
    }
    if (url.pathname === "/api/threads/send") {
      return jsonResponse({
        ok: true,
        turnId: "turn-http-ws-dedup",
        dispatchMode: "chat_turn",
        rollbackReconciled: true,
        rollbackEventSeqBarrier: 10,
      });
    }
    if (url.pathname === "/api/threads/file-changes/list") {
      fileChangesCount += 1;
      if (fileChangesCount === 1) await fileChangesGate;
      return jsonResponse({ ok: true, items: [] });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  await store.loadThread(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    limit: 500,
  });

  const httpMutation = store.sendMessage(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    text: "只保留一次",
    images: [],
  } as any);
  await tick(0);
  assert.equal(loadCount, 2);
  const wsReconcile = store.reconcileThreadRollbackFromServer(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    rollbackEventSeqBarrier: 10,
  });
  await tick(0);
  assert.equal(loadCount, 2);

  assert.ok(releaseReload);
  (releaseReload as () => void)();
  await tick(0);
  assert.equal(fileChangesCount, 1);
  assert.ok(releaseFileChanges);
  (releaseFileChanges as () => void)();
  await Promise.all([httpMutation, wsReconcile]);

  const userMessages = store.conversations[threadId]?.items.filter(
    (item): item is Extract<ConversationItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  ) ?? [];
  assert.deepEqual(userMessages.map((item) => item.text), ["只保留一次"]);
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);

  await store.reconcileThreadRollbackFromServer(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    rollbackEventSeqBarrier: 10,
  });
  await store.reconcileThreadRollbackFromServer(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    rollbackEventSeqBarrier: 9,
  });
  assert.equal(loadCount, 2);
  assert.equal(fileChangesCount, 1);

  await store.reconcileThreadRollbackFromServer(ctx, {
    workspaceId: "client-a:ws-demo" as any,
    threadId: threadId as any,
    rollbackEventSeqBarrier: 11,
  });
  assert.equal(loadCount, 3);
  assert.equal(fileChangesCount, 2);
});

test("共享 rollback 后台刷新遇到 Client 离线时保留待重载状态且不写本地 notice", async () => {
  setActivePinia(createPinia());
  const store = useChatStore();
  const ctx = createApiContext();
  const threadId = "thread-shared-rollback-offline";
  const offlineError = new Error("CLIENT_OFFLINE: 该工作区对应的 client 未连接");

  store.loadedThreads[threadId] = true;
  store.ensureConversation(threadId as any);
  (store as any).loadThread = async () => {
    throw offlineError;
  };

  await assert.rejects(
    store.reconcileThreadRollbackFromServer(ctx, {
      workspaceId: "shared:workspace-offline" as any,
      threadId: threadId as any,
      rollbackEventSeqBarrier: 12,
    }),
    (error) => error === offlineError,
  );

  assert.equal(store.threadRollbackEventSeqBarrierByThreadId[threadId], 12);
  assert.equal(store.loadedThreads[threadId], undefined);
  assert.deepEqual(
    store.conversations[threadId]?.items.filter((item) => item.kind === "systemMessage"),
    [],
  );
});

test("切换工作区后忽略旧工作区迟到的 rollback threads.changed", async () => {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const chat = useChatStore();
  const presence = usePresenceStore();
  const engine = useEngineStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.authMode = "account";
  config.accountRole = "personal_normal";
  config.userSummary = {
    userId: "user-late-rollback",
    email: "user-late-rollback@codeflow.test",
    fullName: "User Late Rollback",
    phone: "",
    avatarUrl: null,
    accountRole: "personal_normal",
    status: "active",
    enterpriseId: null,
    enterpriseName: null,
  } as any;
  config.sessionToken = "session-late-rollback";
  config.sessionExpiresAt = Date.now() + 60_000;

  const originalWindow = (globalThis as any).window;
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets: any[] = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    sent: any[] = [];
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
    emit(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  const reconciledWorkspaces: string[] = [];
  const reportedErrors: string[] = [];
  let reconcileError: Error | null = null;
  (chat as any).reconcileThreadRollbackFromServer = async (_ctx: ApiRequestContext, body: { workspaceId: string }) => {
    reconciledWorkspaces.push(String(body.workspaceId));
    if (reconcileError) throw reconcileError;
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/me/ws-bridge") {
      return jsonResponse({ ok: true, bridgeToken: "bridge-late-rollback" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = FakeWebSocket;

  let ws: ReturnType<typeof createWebSocketClient> | null = null;
  try {
    ws = createWebSocketClient({
      config,
      chat,
      presence,
      engine,
      onError: (message) => reportedErrors.push(message),
    });
    await ws.connect();
    const socket = sockets[0];
    assert.ok(socket);

    const subscribeA = ws.replaceWorkspaceSubscription("client-a:ws-a" as any);
    const requestA = socket.sent.at(-1);
    socket.emit({
      t: "web.subscribeAck",
      requestId: requestA.requestId,
      workspaceId: "client-a:ws-a",
      bufferedCount: 0,
    });
    await subscribeA;


    const subscribeB = ws.replaceWorkspaceSubscription("client-b:ws-b" as any);
    const requestB = socket.sent.at(-1);
    socket.emit({
      t: "threads.changed",
      workspaceId: "client-a:ws-a",
      threadId: "thread-late-a",
      kind: "updated",
      rollbackEventSeqBarrier: 7,
    });
    await tick(0);
    assert.deepEqual(reconciledWorkspaces, []);

    socket.emit({
      t: "web.subscribeAck",
      requestId: requestB.requestId,
      workspaceId: "client-b:ws-b",
      bufferedCount: 0,
    });
    await subscribeB;
    socket.emit({
      t: "threads.changed",
      workspaceId: "client-b:ws-b",
      threadId: "thread-current-b",
      kind: "updated",
      rollbackEventSeqBarrier: 8,
    });
    await tick(0);
    assert.deepEqual(reconciledWorkspaces, ["client-b:ws-b"]);

    reconcileError = new Error("CLIENT_OFFLINE: 该工作区对应的 client 未连接");
    socket.emit({
      t: "threads.changed",
      workspaceId: "client-b:ws-b",
      threadId: "thread-current-b",
      kind: "updated",
      rollbackEventSeqBarrier: 9,
    });
    await tick(0);
    assert.deepEqual(reconciledWorkspaces, ["client-b:ws-b", "client-b:ws-b"]);
    assert.deepEqual(reportedErrors, []);
  } finally {
    ws?.disconnect();
    (globalThis as any).window = originalWindow;
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("thread queue refresh merges concurrent events into one trailing request", async () => {
  setActivePinia(createPinia());
  const queue = useThreadQueueStore();
  const ctx = createApiContext();
  const workspaceId = "client-a:ws-queue-refresh" as WorkspaceId;
  const threadId = "thread-queue-refresh" as ThreadId;
  let requestCount = 0;
  let releaseFirst: (() => void) | null = null;
  const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/threads/queue/list");
    requestCount += 1;
    if (requestCount === 1) await firstRequest;
    return jsonResponse({
      ok: true,
      state: {
        threadId,
        workspaceId,
        paused: false,
        pausedReason: null,
        pausedAt: null,
        lastConsumedQueueId: null,
        lastConsumedTurnId: null,
      },
      items: [],
    });
  }) as typeof fetch;

  const first = queue.refresh(ctx, workspaceId, threadId);
  await tick(0);
  const second = queue.refresh(ctx, workspaceId, threadId);
  const third = queue.refresh(ctx, workspaceId, threadId);
  assert.equal(requestCount, 1);

  (releaseFirst as (() => void) | null)?.();
  await Promise.all([first, second, third]);
  assert.equal(requestCount, 2);
  assert.equal(queue.itemCountFor(threadId), 0);
});
