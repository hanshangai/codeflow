import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { openClientDb } from "../src/db/clientDb.js";
import { describeWorkspaceApiFailure } from "../src/app/handleApiRequest.js";
import { prepareTransportMessageFailure } from "../src/transport/transportMessageFailurePolicy.js";

/** 真实启动函数在隔离W执行，provider和安装器出口使用受控故障。 */
function methods(install: () => Promise<unknown>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["installBuiltinSkillPackagesForWorkspace", "deleteWorkspaceRawEventsBeforeSeq"];
  const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(declarations.length, names.length);
  const code = ts.transpileModule(declarations.map(node => node.getText(tree)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("ensureBuiltinSkillPackagesInstalled", "isWorkspaceWritePermissionError", "describeWorkspaceApiFailure",
    `${code}\nreturn { ${names.join(",")} };`)(install, () => false, describeWorkspaceApiFailure);
}

/** 执行真实启动配置的回调，避免测试另写一份失败处分。 */
function startupCallback(name: string, property: string, dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    let options: ts.Expression | undefined;
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      const constructor = ts.isConditionalExpression(node.initializer) ? node.initializer.whenTrue : node.initializer;
      assert.ok(ts.isNewExpression(constructor));
      options = constructor.arguments?.[2];
    } else if (ts.isNewExpression(node) && node.expression.getText(tree) === name) options = node.arguments?.[0];
    if (options) {
      assert.ok(ts.isObjectLiteralExpression(options));
      const entry = options.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(tree) === property);
      assert.ok(entry && ts.isPropertyAssignment(entry)); callback = entry.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(callback);
  const code = ts.transpileModule(`const callback = ${callback.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn callback;`)(...Object.values(dependencies));
}

/** 两个真实库同名实体用于检查首错停止和诊断落点。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-log-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaces = new Map<string, string>();
  for (const id of ["a", "b"]) {
    const directory = path.join(root, id); fs.mkdirSync(directory);
    db.workspaces.upsert({ id, title: id, path: directory }); workspaces.set(id, directory);
  }
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, workspaces };
}

test("内置Skill安装失败只写所属W；日志双错保原原因且成功日志失败不再重跑安装", async t => {
  const f = fixture(t), business = new Error("INSTALL_FAILED"); let installs = 0;
  const api = methods(async () => { installs++; throw business; });
  f.db.writeWorkspaceLog = () => { throw 0; };
  await assert.rejects(api.installBuiltinSkillPackagesForWorkspace({ db: f.db, workspaceId: "a", workspacePath: f.workspaces.get("a"), allowWorkspaceWriteFailure: false }), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [business, 0]); return true;
  });
  const success = methods(async () => { installs++; return { installed: ["skill"], skipped: [] }; });
  await assert.rejects(success.installBuiltinSkillPackagesForWorkspace({ db: f.db, workspaceId: "a", workspacePath: f.workspaces.get("a"), allowWorkspaceWriteFailure: false }), (error: unknown) => error === 0);
  assert.equal(installs, 2);
});

test("raw清理首W失败保诊断双因并停止B，不扩大到其他库", t => {
  const f = fixture(t), business = new Error("DELETE_FAILED"), api = methods(async () => ({})); let bCalls = 0;
  f.db.forWorkspace("a").rawEvents.deleteBeforeSeq = () => { throw business; };
  f.db.forWorkspace("b").rawEvents.deleteBeforeSeq = () => { bCalls++; return 0; };
  const written: string[] = [];
  f.db.writeWorkspaceLog = id => { written.push(id); throw false; };
  assert.throws(() => api.deleteWorkspaceRawEventsBeforeSeq({ db: f.db, workspaces: f.workspaces, gate: { getMigrationOperationId() { return null; } } }, 100, 10), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [business, false]); return true;
  });
  assert.deepEqual(written, ["a"]); assert.equal(bCalls, 0);
});

test("ACK处分读取失败保原始falsy双因，不字符串化改写", () => {
  const result = prepareTransportMessageFailure({ messageType: "raw.eventAck", error: false,
    event: { workspaceId: "a", threadId: "thread", clientTurnId: "turn" }, loadTurn() { throw 0; },
    flushConversationEvidence() {}, flushRawEvidence() {} });
  assert.equal(result.disposition, "shutdown_client");
  assert.ok(result.effectiveError instanceof AggregateError);
  assert.deepEqual(result.effectiveError.errors, [false, 0]); assert.equal(result.effectiveError.cause, false);
});

for (const worker of ["codeAttributionSyncWorker", "codeAttributionRetentionWorker"]) {
  test(`${worker}已记录的W失败仅投影未就绪，不重复应用日志或全机关停`, () => {
    const states: string[] = []; let diagnostics = 0, shutdowns = 0;
    const callback = startupCallback(worker, "onFatalError", {
      markCurrentClientDaemonStartup: (state: string) => states.push(state),
      logClientStep: () => { diagnostics++; }, shutdown: () => { shutdowns++; },
      config: { clientId: "client" }, toErrorLogValue: () => ({}),
    });
    callback(false);
    assert.deepEqual(states, ["degraded"]);
    assert.equal(diagnostics, 0); assert.equal(shutdowns, 0);
  });
}

test("关闭前已排队的索引预热回调不在排空后创建新DB任务", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "scheduleWorkspacePathIndexWarmup") declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(declaration?.initializer);
  const code = ts.transpileModule(`const schedule = ${declaration.initializer.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let callback!: () => void, work = 0;
  const dependencies = { setImmediate: (run: () => void) => { callback = run; return { unref() {} }; },
    runtime: { trackWork() { work++; } }, workspacePathIndex: {}, workspaces: new Map(), markCurrentClientDaemonStartup() {} };
  const scheduler = new Function(...Object.keys(dependencies), `let workspacePathIndexWarmupQueued = false, shutdownRequested = false;
    ${code}\nreturn { schedule, stop() { shutdownRequested = true; } };`)(...Object.values(dependencies));
  scheduler.schedule(); scheduler.stop(); callback();
  assert.equal(work, 0);
});

test("真实Reader诊断callback固定租约W；拒写原值抛出且不向应用补同条", t => {
  const f = fixture(t), application: unknown[] = [];
  const callback = startupCallback("ClientDbReaderService", "onDiagnostic", { db: f.db, config: { clientId: "client" }, logger: {
    info: (...values: unknown[]) => application.push(values), error: (...values: unknown[]) => application.push(values),
  } });
  const diagnostic = { operation: "listIntakes", outcome: "failed", commandId: "command", requestId: "read-request",
    workspaceId: "a", errorCode: "CLIENT_DB_READER_QUERY_FAILED", queueMs: 1, dbMs: 2 };
  callback(diagnostic);
  const directory = path.join(f.workspaces.get("a")!, ".codeflowai");
  const rows = fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  assert.equal(rows.length, 1); assert.equal(rows[0].workspaceId, "a"); assert.equal(rows[0].requestId, "read-request");
  assert.equal(rows[0].code, "CLIENT_DB_READER_QUERY_FAILED"); assert.deepEqual(application, []);
  f.db.writeWorkspaceLog = () => { throw false; };
  assert.throws(() => callback(diagnostic), error => error === false); assert.deepEqual(application, []);
  callback({ ...diagnostic, workspaceId: undefined }); assert.equal(application.length, 1);
});

test("卡片持久行中的异W身份在资产读取和删除前显式拒绝", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "listVisibleWorkflowIds") method = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(method);
  const code = ts.transpileModule(`const hooks = { ${method.getText(tree)} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let opened = 0;
  const hooks = new Function("workspaceId", "orchAssetRuntimeRead", `${code}\nreturn hooks;`)("a", {
    openWorkspace() { opened++; return { authorityMode: "server", listAssets: () => [] }; },
  });
  assert.throws(() => hooks.listVisibleWorkflowIds("b"), /CHAT_WORKFLOW_CARD_WORKSPACE_SCOPE_MISMATCH/);
  assert.equal(opened, 0);
  assert.deepEqual(hooks.listVisibleWorkflowIds("a"), new Set()); assert.equal(opened, 1);
});
