import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

/** 执行真实桌面API回调，只替换业务返回和投递资源，验证响应不附带云端扫描。 */
test("桌面只读API返回不唤醒或等待远程投递扫描", async () => {
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "desktopLifecycle.ready") {
      callback = node.arguments[2] as ts.ArrowFunction;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  let scans = 0;
  const response = { status: 200, body: { ok: true } };
  const sandbox = { desktopApiHandlerContext: {}, selfVersion: "test", runtimeStartedAt: 1,
    executeDesktopApiRequest: async () => response, flushLocalEventRelay() { scans++; } };
  const run = vm.runInNewContext(ts.transpileModule(`(${callback.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox) as (request: unknown, requestId: string) => Promise<unknown>;
  assert.equal(await run({ method: "runtime.info" }, "read-request"), response);
  assert.equal(scans, 0);
  const failure = new Error("API_FAILED");
  sandbox.executeDesktopApiRequest = async () => { throw failure; };
  await assert.rejects(run({ method: "threads.load" }, "failed-request"), error => error === failure);
  assert.equal(scans, 0);
});

test("本机会话事件的准入、前置索引和发送共用同步连接，拒绝后不发送", () => {
  const file = readFileSync(new URL("../src/app/handleApiRequest.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("handleApiRequest.ts", file, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "emitConversation");
  assert.ok(declaration);
  let depth = 0, sent = 0, scopes = 0;
  const ctx = { localWorkspaceOnly: true, db: { withWorkspaceCoreRepos(_id: string, operation: () => unknown) {
    scopes++; depth++; try { return operation(); } finally { depth--; }
  } }, onBeforeEmitConversationEvent() { assert.equal(depth, 1); }, send() { assert.equal(depth, 1); sent++; } };
  const emit = vm.runInNewContext(ts.transpileModule(`${declaration.getText(parsed)}\nemitConversation`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText) as (ctx: unknown, event: unknown, before?: () => boolean) => unknown;
  emit(ctx, { workspaceId: "workspace" }, () => { assert.equal(depth, 1); return true; });
  emit(ctx, { workspaceId: "workspace" }, () => false);
  assert.equal(sent, 1);
  assert.equal(scopes, 2);
  assert.equal(depth, 0);
});

/** 执行真实初始化回调，屏障通过仓储通知重启调度且兼容 relay 尚未初始化。 */
test("数据库屏障通知连接到同一relay调度，启动前不会访问未初始化实例", () => {
  let callback: ts.ArrowFunction | undefined;
  /** 只定位 openClientDb 的通知参数，避免副本测试遗漏真实装配。 */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "openClientDb") {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(ast) === "onRelayInvalidation");
        if (property && ts.isPropertyAssignment(property)) callback = property.initializer as ts.ArrowFunction;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const wakes: Array<[boolean, string]> = [];
  const sandbox: { localEventRelay: undefined | { scheduleFlush(restart: boolean, scopeKey: string): void } } = { localEventRelay: undefined };
  const notify = vm.runInNewContext(ts.transpileModule(`(${callback.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox) as (scopeKey: string) => void;
  notify("authorized-scope");
  sandbox.localEventRelay = { scheduleFlush(restart, scopeKey) { wakes.push([restart, scopeKey]); } };
  notify("authorized-scope");
  assert.deepEqual(wakes, [[true, "authorized-scope"]]);
});

/** 使用真实发送分流，仅 canonical 和清理屏障唤醒投递，raw仍执行本地提交。 */
test("原始事件和API响应不扫描canonical，清理唤醒重新检查屏障", () => {
  const start = source.indexOf("  const sendToServer = (message:"), end = source.indexOf("  const takeApiResponseDispatch", start);
  assert.ok(start > 0 && end > start);
  const wakes: unknown[] = [], persisted: string[] = [], remote: unknown[] = [];
  let scopeDepth = 0;
  const sandbox = {
    Buffer, Date, sanitizeClientToServerMessage: (value: unknown) => value, keepFullEventOutput: false,
    assertWorkspacePersistenceAvailable() {}, desktopLifecycle: { publishEvent() {} },
    localEventPersistence: { persist(value: { t: string }) { assert.equal(scopeDepth, 1); persisted.push(value.t); return value; } },
    config: { clientId: "local" }, workspaces: new Map(), db: { forWorkspace: () => ({}),
      withWorkspaceCoreRepos(_id: unknown, operation: () => unknown) { scopeDepth++; try { return operation(); } finally { scopeDepth--; } } },
    isDesktopLocalThreadAssetExecution: () => { assert.equal(scopeDepth, 1); return true; }, flushLocalEventRelay: (restart?: boolean) => wakes.push(restart),
    desktopCloudAccount: { send(value: unknown) { remote.push(value); return { accepted: true }; } },
  };
  const send = vm.runInNewContext(ts.transpileModule(`${source.slice(start, end)}\nsendToServer`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox) as (message: unknown, fromRelay?: boolean) => { accepted: boolean };
  const event = { workspaceId: "workspace", threadId: "thread" };
  assert.equal(send({ t: "raw.event", event }).accepted, true);
  assert.equal(send({ t: "api.res", id: "request", status: 200, body: { ok: true } }).accepted, true);
  assert.deepEqual(wakes, []);
  assert.equal(send({ t: "conversation.event", event }).accepted, true);
  assert.equal(wakes.length, 1);
  assert.equal(send({ t: "thread.history.cleaned", workspaceId: "workspace", threadId: "thread" }).accepted, true);
  assert.equal(wakes[1], true);
  assert.deepEqual(persisted, ["raw.event", "conversation.event"]);
  remote.length = 0;
  const wakeCount = wakes.length;
  let relayCallback: ts.Expression | undefined;
  /** 使用真实 relay 装配，避免只测试调用方手工传入的来源标记。 */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "createLocalEventRelay") {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(ast) === "send");
        if (property && ts.isPropertyAssignment(property)) relayCallback = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(relayCallback);
  const deliver = vm.runInNewContext(ts.transpileModule(`(${relayCallback.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, { sendToServer: send }) as (message: unknown) => { accepted: boolean };
  assert.equal(deliver({ t: "thread.history.cleaned", workspaceId: "workspace", threadId: "thread", sharedWorkspaceId: null }).accepted, true);
  assert.equal(remote.length, 1, "personal relay投递必须发给远程，不能被本地清理通知分支拦截");
  assert.equal(wakes.length, wakeCount);
});
