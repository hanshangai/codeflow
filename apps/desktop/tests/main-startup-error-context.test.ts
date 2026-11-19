import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { describeUserFacingError } from "@codeflowai/shared";
import ts from "typescript";
import { DesktopStartupCleanupError } from "../src/desktopApplication.js";
import { snapshotShellHandoffErrorContext } from "../src/shellHandoff.js";
import { DesktopMaintenanceStartupError } from "../src/desktopMaintenanceRecord.js";

const startupId = "startup:current", attemptId = "attempt:original", continuationId = "continuation-original";

test("normal relaunch drops the completed shell handshake while preserving both profile arguments", async () => {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "relaunchDesktop");
  assert.ok(declaration, "normal relaunch must not reuse a completed updater pipe");
  const calls: unknown[] = [];
  const argv = ["CodeFlowAI.exe", "--user-data-dir=C:\\用户 空间", "--codeflow-session-data-dir=C:\\session", "--codeflow-shell-ready=a2b17190-9093-4f0b-b028-27c4fd87234d"];
  const context = vm.createContext({ process: { argv }, app: { relaunch: (input: unknown) => calls.push(JSON.parse(JSON.stringify(input))) } });
  vm.runInContext(ts.transpileModule(declaration.getFullText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  vm.runInContext("relaunchDesktop()", context);
  assert.deepEqual(calls, [{ args: ["--user-data-dir=C:\\用户 空间", "--codeflow-session-data-dir=C:\\session"] }]);
});

test("shell switch ready confirms a sandbox renderer before any business bootstrap and retains real request/PID", async () => {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "confirmShellSwitchReady");
  assert.ok(declaration, "shell-only readiness entry is required");
  const events: string[] = [], id = "a2b17190-9093-4f0b-b028-27c4fd87234d";
  let failRenderer = false, commitByte = 1;
  const context = vm.createContext({ process: { platform: "win32", pid: 12345 }, Buffer,
    app: { whenReady: async () => { events.push("app-ready"); } },
    BrowserWindow: class {
      webContents = { isDestroyed: () => false };
      constructor(input: { webPreferences: { sandbox: boolean; partition: string } }) {
        assert.equal(input.webPreferences.sandbox, true);
        assert.equal(input.webPreferences.partition, `codeflow-shell-ready-${id}`, "readiness must not initialize or lock the business session profile");
      }
      async loadURL(url: string) { assert.match(url, /^data:text\/html/u); if (failRenderer) throw new Error("RENDERER_FAILED"); events.push("renderer-ready"); }
      destroy() { events.push("destroyed"); }
    },
    fs: { openSync(file: string, flags: string) { assert.equal(file, `\\\\.\\pipe\\codeflow-shell-ready-${id}`); assert.equal(flags, "r+"); events.push("open"); return 42; },
      writeSync(fd: number, value: Buffer) { assert.equal(fd, 42); assert.equal(value.toString("ascii"), `${id}:12345\r\n`); events.push("ready"); return value.length; },
      readSync(fd: number, value: Buffer) { assert.equal(fd, 42); value[0] = commitByte; events.push("committed"); return 1; },
      closeSync(fd: number) { assert.equal(fd, 42); events.push("closed"); } } });
  vm.runInContext(ts.transpileModule(declaration.getFullText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await vm.runInContext("confirmShellSwitchReady([])", context);
  assert.deepEqual(events, [], "ordinary startup must have no update gate");
  await vm.runInContext(`confirmShellSwitchReady(['--codeflow-shell-ready=${id}'])`, context);
  assert.deepEqual(events, ["app-ready", "renderer-ready", "open", "ready", "committed", "closed", "destroyed"]);
  for (const failure of ["renderer", "commit"]) {
    events.length = 0; failRenderer = failure === "renderer"; commitByte = 0;
    await assert.rejects(vm.runInContext(`confirmShellSwitchReady(['--codeflow-shell-ready=${id}'])`, context),
      { code: "DESKTOP_SHELL_READY_FAILED", requestId: id });
    assert.equal(events.at(-1), "destroyed");
    if (failRenderer) assert.deepEqual(events, ["app-ready", "destroyed"]);
  }
  for (const argv of [["--codeflow-shell-ready=expired"], [`--codeflow-shell-ready=${id}`, `--codeflow-shell-ready=${id}`]]) {
    await assert.rejects(vm.runInContext(`confirmShellSwitchReady(${JSON.stringify(argv)})`, context), /DESKTOP_SHELL_READY_ARGUMENT_INVALID/u);
  }
  const bootstrap = source.slice(source.indexOf("void app.whenReady().then(async () =>"));
  assert.ok(bootstrap.indexOf("await confirmShellSwitchReady(process.argv)") < bootstrap.indexOf("resolveDesktopStorageLocation("));
});

/** 保留真实日志去重声明；测试不另造生产状态或去重实现。 */
function mainLogDeclarations(ast: ts.SourceFile): ts.VariableStatement[] {
  return ast.statements.filter(ts.isVariableStatement).filter(statement => statement.declarationList.declarations.some(declaration =>
    declaration.initializer && ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === "WeakSet"));
}

/** 执行真实main启动与日志分支；可选安装标记缺失，指定shellDirectory时读取实际壳元数据。 */
async function startupFailure(options: { attempt?: object; error?: Error; beforeHeld?: boolean; ordinary?: boolean; expectedLogCount?: number;
  environmentOrigin?: string; installedOrigin?: string; originError?: Error; packaged?: boolean; maintenance?: boolean;
  maintenanceRelease?: "active" | "baseline"; shellDirectory?: string; electronVersion?: string } = {}) {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = [...mainLogDeclarations(ast), ...ast.statements.filter(statement => ts.isIfStatement(statement)
    || ts.isFunctionDeclaration(statement) && statement.name?.text !== "assertNoDesktopClientProcess")];
  const compiled = ts.transpileModule(statements.map(statement => statement.getFullText(ast)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const logs: any[] = [], shown: string[] = [], titles: string[] = [], exits: number[] = [], received: unknown[] = [];
  const menuCalls: unknown[][] = [];
  const applicationShellVersions: string[] = [], captureShellVersions: string[] = [];
  const origins: Array<{ directory: string; environment: string | undefined }> = [], applicationOrigins: unknown[] = [], shellOrigins: unknown[] = [];
  const error = options.error ?? Object.assign(new Error("permit rejected"), { code: "DESKTOP_SHELL_HANDOFF_PERMIT_NOT_COMMITTED" });
  const attempt = options.attempt ?? { requestId: attemptId, continuationId, target: { shellId: "candidate" }, revision: 17, phase: "handoff" };
  let shownResolve!: () => void;
  const reported = new Promise<void>(resolve => { shownResolve = resolve; });
  const application = { async start() { received.push(error); throw error; } };
  vm.runInNewContext(compiled, {
    Error, AggregateError, Promise, Date, Object, Reflect, TextDecoder, path,
    currentDirectory: path.join(options.shellDirectory ?? path.resolve("desktop"), "dist"),
    process: { versions: { electron: "test" }, env: { CODEFLOWAI_DESKTOP_SERVER_ORIGIN: options.environmentOrigin },
      resourcesPath: path.resolve('installed-resources'), platform: options.maintenance ? "win32" : "linux",
      execPath: path.resolve("installation/CodeFlowAI.exe"), pid: 1, ppid: 2,
      argv: options.maintenance ? [path.resolve("installation/CodeFlowAI.exe"), "--codeflow-uninstall-maintenance", "nsis:audit", "keep", "--resume-pending"] : [] },
    crypto: { randomUUID: () => startupId },
    fs: { existsSync: () => false, mkdirSync() {},
      lstatSync(_file: string, input: { throwIfNoEntry?: boolean }) { assert.equal(input.throwIfNoEntry, false); return undefined; },
      readFileSync: options.shellDirectory ? readFileSync : () => Buffer.from('{"version":"7.8.9-fixture"}'),
      appendFileSync(_file: string, line: string) { logs.push(JSON.parse(line)); } },
    app: { isPackaged: options.packaged ?? Boolean(options.maintenance), getPath: (name: string) => path.resolve(name), setPath() {}, setAppUserModelId() {},
      requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), getVersion: () => options.electronVersion ?? "test",
      exit(code: number) { exits.push(code); } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    // 单独记录菜单调用，确保正常启动恰好以 null 清除一次原生菜单。
    Menu: { setApplicationMenu(...args: unknown[]) { menuCalls.push(args); } },
    dialog: { showErrorBox(title: string, message: string) { titles.push(title); shown.push(message); shownResolve(); } },
    readCandidateShellHealthRequest: () => null, DESKTOP_WEB_ENTRY: "codeflow://desktop/", createDesktopWebHandler: () => ({}),
    assertTrustedReleaseKeys: () => ({}),
    /** 崩溃捕获属于外部边界；本夹具只验证启动失败及日志归属。 */
    createDesktopCrashCapture: (input: { shellVersion: string }) => {
      captureShellVersions.push(input.shellVersion);
      return { initialize() {}, expectExit() {}, updateRuntimeFacts() {}, reportClientExit() {} };
    },
    readInstalledUpdateOrigin: (directory: string, environment: string | undefined) => {
      origins.push({ directory, environment }); if (options.originError) throw options.originError;
      return options.installedOrigin ?? environment;
    },
    readShellUpdateHostFacts: async (input: { configuredServerOrigin?: string }) => { shellOrigins.push(input.configuredServerOrigin); return undefined; },
    readShellHandoffStartup: async () => {
      if (options.beforeHeld) throw error;
      return options.ordinary || options.maintenanceRelease ? { kind: "ordinary" } : { kind: "held-candidate", attempt };
    },
    createShellHandoffContinuation: () => ({ continuation: {}, dispose() {}, started: async () => undefined }),
    createDesktopApplication: (input: { configuredServerOrigin?: string; shellVersion: string }) => {
      applicationOrigins.push(input.configuredServerOrigin); applicationShellVersions.push(input.shellVersion); return application;
    },
    DesktopStartupCleanupError, snapshotShellHandoffErrorContext, describeUserFacingError,
    DesktopMaintenanceStartupError,
    readDesktopMaintenanceStartup: async () => { if (options.maintenanceRelease) return null; throw error; },
    assertNoDesktopClientProcess: async () => undefined, resolveVersionedShellStartup: async () => null,
    beginDesktopMaintenance: async () => ({ phase: "started", requestId: "nsis:audit", mode: "keep", clientId: "client-original", oldDeviceId: "device-original" }),
    resolveActiveRelease: async () => { if (options.maintenanceRelease === "active") throw error; return null; },
    resolveBaselineRelease: async () => { throw error; },
    resolveDesktopStorageLocation: async () => ({ dataDir: path.resolve("userData/runtime"), clientId: "client-original", deviceId: "device-original" }),
    assertDesktopMaintenanceStartup: async () => undefined, persistDesktopStorageLocation: async () => undefined,
    prepareDesktopReinstall: async () => null,
    verifyDesktopStorageLocation: async () => undefined,
    appendDesktopStartupDiagnostic: (_directory: string, line: string) => { logs.push(JSON.parse(line)); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([reported, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MAIN_ERROR_NOT_REPORTED")), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(menuCalls, [[null]]);
  assert.equal(logs.length, options.expectedLogCount ?? 1); assert.equal(shown.length, 1);
  return { log: logs[0], exits, shown, titles, received, error, origins, applicationOrigins, shellOrigins, applicationShellVersions, captureShellVersions };
}

for (const packaged of [false, true]) test(`main uses its adjacent shell package version instead of Electron: packaged=${packaged}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "main-shell-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shellDirectory = path.join(root, packaged ? "resources/app.asar" : "desktop"), version = packaged ? "9.8.7-packaged" : "7.8.9-local";
  await fs.mkdir(shellDirectory, { recursive: true });
  await fs.writeFile(path.join(shellDirectory, "package.json"), JSON.stringify({ version }), "utf8");
  const f = await startupFailure({ ordinary: true, packaged, shellDirectory, electronVersion: "45.0.0" });
  assert.deepEqual(f.applicationShellVersions, [version]); assert.deepEqual(f.captureShellVersions, [version]);
});

for (const metadata of ['{}', '{"version":45}', '{"version":"bad version"}', '{broken', Buffer.from([0xc3, 0x28])]) {
  test(`main rejects invalid adjacent shell metadata ${Buffer.isBuffer(metadata) ? "UTF-8" : metadata} through its startup log`, async t => {
    const shellDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "main-shell-invalid-"));
    t.after(() => fs.rm(shellDirectory, { recursive: true, force: true }));
    await fs.writeFile(path.join(shellDirectory, "package.json"), metadata, "utf8");
    const f = await startupFailure({ ordinary: true, shellDirectory, electronVersion: "45.0.0" });
    assert.equal(f.log.errorCode, "DESKTOP_SHELL_VERSION_INVALID"); assert.equal(f.log.requestId, startupId);
    assert.deepEqual(f.applicationShellVersions, []); assert.deepEqual(f.captureShellVersions, []);
    assert.deepEqual(f.received, []); assert.deepEqual(f.exits, [1]);
  });
}

for (const [code, detail] of [["DESKTOP_RELEASE_BASELINE_MISSING", "baseline-release-manifest.json"],
  ["DESKTOP_UNINSTALL_WORKER_MISSING", "desktopUninstallWorker.cjs"], ["ENOENT", "文件或目录不存在"]]) {
  test(`maintenance ${code} reports uninstall context and a traceable failure without starting business`, async () => {
    const error = Object.assign(new Error(code), { code });
    const f = await startupFailure({ maintenance: true, error });
    assert.equal(f.titles[0], "CodeFlow 卸载失败"); assert.match(f.shown[0]!, new RegExp(detail!));
    assert.match(f.shown[0]!, /nsis:audit/u); assert.match(f.shown[0]!, /desktop-errors\.jsonl/u);
    assert.equal(f.log.maintenanceRequestId, "nsis:audit"); assert.equal(f.log.maintenanceStage, "startup");
    assert.equal(f.log.errorCode, code); assert.deepEqual(f.exits, [1]); assert.deepEqual(f.received, []);
  });
}

for (const maintenanceRelease of ["active", "baseline"] as const) for (const nativeCode of [undefined, "ENOENT", "DESKTOP_RELEASE_BASELINE_MISSING"]) test(`maintenance ${maintenanceRelease} integrity failure ${nativeCode ?? "digest"} directs repair before starting a worker`, async () => {
  const error = nativeCode ? Object.assign(new Error("missing release payload"), { code: nativeCode }) : new Error("Client payload SHA-256 不匹配");
  const f = await startupFailure({ maintenance: true, maintenanceRelease, error });
  assert.equal(f.titles[0], "CodeFlow 卸载失败"); assert.match(f.shown[0]!, /完整安装包修复安装/u);
  assert.equal(f.log.errorCode, nativeCode === "DESKTOP_RELEASE_BASELINE_MISSING" ? nativeCode : "DESKTOP_UNINSTALL_RELEASE_INVALID"); assert.equal(f.log.maintenanceStage, "release");
  assert.equal(f.log.maintenanceRequestId, "nsis:audit"); assert.deepEqual(f.exits, [1]); assert.deepEqual(f.received, []);
});

for (const packaged of [false, true]) test(`main reads the installed shell resources and shares one update origin: packaged=${packaged}`, async () => {
  const f = await startupFailure({ ordinary: true, packaged, environmentOrigin: 'https://environment.example', installedOrigin: 'https://installed.example' });
  assert.deepEqual(f.origins, [{ directory: path.resolve(packaged ? 'installed-resources' : 'desktop'), environment: 'https://environment.example' }]);
  assert.deepEqual(f.applicationOrigins, ['https://installed.example']); assert.deepEqual(f.shellOrigins, ['https://installed.example']);
});

test('main invalid installed configuration fails before shell facts with a Chinese message', async () => {
  const error = Object.assign(new Error('DESKTOP_UPDATE_CONFIG_INVALID'), { code: 'DESKTOP_UPDATE_CONFIG_INVALID' });
  const f = await startupFailure({ ordinary: true, originError: error });
  assert.deepEqual(f.applicationOrigins, []); assert.deepEqual(f.shellOrigins, []); assert.equal(f.received.length, 0);
  assert.equal(f.log.errorCode, 'DESKTOP_UPDATE_CONFIG_INVALID'); assert.deepEqual(f.exits, [1]);
  assert.match(f.shown[0] ?? "", /更新配置无效/u);
});

/** 执行真实更新错误回调及其窗口/通知闭包，只替换磁盘、弹框与不支持通知的平台边界。 */
async function updateErrorBoundary(failFirstWrite?: Error) {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: ts.Expression | undefined;
  let windowDeclaration: ts.VariableStatement | undefined, notification: ts.FunctionDeclaration | undefined;
  /** 从实际host配置定位回调，避免在夹具中镜像分支。 */
  const findCallback = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "onUpdateError") callback = node.initializer;
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "normalWindow")) windowDeclaration = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "notifyDesktopUpdate") notification = node;
    ts.forEachChild(node, findCallback);
  };
  findCallback(ast); assert.ok(callback); assert.ok(windowDeclaration); assert.ok(notification);
  const statements = [...mainLogDeclarations(ast), windowDeclaration, notification, ...ast.statements.filter(ts.isFunctionDeclaration)];
  const compiled = ts.transpileModule(statements.map(statement => statement.getFullText(ast)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const callbackCode = ts.transpileModule(`const updateError = ${callback.getText(ast)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const logs: any[] = [], shown: string[] = [];
  let writes = 0;
  const context = vm.createContext({ Error, AggregateError, WeakSet, Date, Object, Reflect, path,
    dataDir: path.resolve("main-log-fixture"), snapshotShellHandoffErrorContext, describeUserFacingError,
    crypto: { randomUUID: () => startupId },
    fs: { mkdirSync() {}, appendFileSync(_file: string, line: string) {
      if (writes++ === 0 && failFirstWrite) throw failFirstWrite;
      logs.push(JSON.parse(line));
    } },
    dialog: { showErrorBox(_title: string, message: string) { shown.push(message); } },
    Notification: { isSupported: () => false },
  });
  vm.runInContext(compiled + callbackCode, context);
  return { logs, shown,
    update: vm.runInContext("updateError", context) as (error: unknown, details: { requestId: string; deviceId: string; logOnly?: boolean }) => void,
    show: vm.runInContext("showDesktopError", context) as (dataDir: string, title: string, error: unknown) => void };
}

test("main prelogs an update failure without showing a dialog", async () => {
  const f = await updateErrorBoundary(), error = Object.assign(new Error("original"), { code: "DESKTOP_SHELL_OPERATION_FAILED" });
  f.update(error, { requestId: "prearm:original", deviceId: "device:original", logOnly: true });
  assert.equal(f.logs.length, 1); assert.equal(f.shown.length, 0);
  assert.equal(f.logs[0].requestId, "prearm:original"); assert.equal(f.logs[0].deviceId, "device:original");
  assert.equal(f.logs[0].errorCode, "DESKTOP_SHELL_OPERATION_FAILED"); assert.deepEqual(f.logs[0].causeCodes, ["DESKTOP_SHELL_OPERATION_FAILED"]);
});

test("更新网络失败弹框解释证书原因，原始代码和请求仍保留在日志", async () => {
  const f = await updateErrorBoundary();
  const tls = Object.assign(new Error("certificate failure"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  const error = Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: new TypeError("fetch failed", { cause: tls }) }),
    { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" });
  f.update(error, { requestId: "update:certificate", deviceId: "device:original" });
  assert.match(f.shown[0]!, /证书/);
  assert.doesNotMatch(f.shown[0]!, /DESKTOP_|UNABLE_TO_VERIFY|fetch failed/);
  assert.equal(f.logs[0].errorCode, error.code);
  assert.equal(f.logs[0].requestId, "update:certificate");
  assert.ok(f.logs[0].causeCodes.includes(tls.code));
});

test("聚合故障弹框不泄露错误代码且说明日志写入失败", async () => {
  const f = await updateErrorBoundary(new Error("DESKTOP_ERROR_LOG_WRITE_FAILED"));
  f.update(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED"), { requestId: "update:log", deviceId: "device:original" });
  assert.match(f.shown[0]!, /连接|网络/);
  assert.match(f.shown[0]!, /日志/);
  assert.doesNotMatch(f.shown[0]!, /DESKTOP_/);
});

test("main shows a prelogged same error without writing another log", async () => {
  const f = await updateErrorBoundary(), error = Object.assign(new Error("original"), { code: "DESKTOP_SHELL_OPERATION_FAILED" });
  const details = { requestId: "prearm:original", deviceId: "device:original" };
  f.update(error, { ...details, logOnly: true }); f.update(error, details);
  assert.equal(f.logs.length, 1); assert.equal(f.shown.length, 1);
  f.show(path.resolve("main-log-fixture"), "later", error);
  assert.equal(f.logs.length, 1); assert.equal(f.shown.length, 2);
});

test("main logs a new recovery error after prelogging its original cause", async () => {
  const f = await updateErrorBoundary();
  const original = Object.assign(new Error("original"), { code: "PREARM_ORIGINAL" });
  const cleanup = Object.assign(new Error("cleanup"), { code: "PREARM_RECOVERY_FAILED" });
  const failure = Object.assign(new Error("recovery", { cause: new AggregateError([original, cleanup]) }), { code: "DESKTOP_SHELL_OPERATION_FAILED" });
  const details = { requestId: "prearm:original", deviceId: "device:original" };
  f.update(original, { ...details, logOnly: true }); f.update(failure, details);
  assert.equal(f.logs.length, 2); assert.equal(f.shown.length, 1);
  assert.ok(f.logs[1].causeCodes.includes(original.code)); assert.ok(f.logs[1].causeCodes.includes(cleanup.code));
});

test("main keeps ordinary repeated error logging outside prelog deduplication", async () => {
  const f = await updateErrorBoundary(), error = new Error("ordinary"), details = { requestId: "ordinary:error", deviceId: "device:original" };
  f.update(error, details); f.update(error, details);
  assert.equal(f.logs.length, 2); assert.equal(f.shown.length, 2);
});

test("main propagates failed prelogging and only deduplicates a successful retry", async () => {
  const writeError = new Error("write failed"), f = await updateErrorBoundary(writeError), error = new Error("original");
  const details = { requestId: "prearm:original", deviceId: "device:original" };
  assert.throws(() => f.update(error, { ...details, logOnly: true }), cause => cause === writeError);
  assert.equal(f.logs.length, 0); assert.equal(f.shown.length, 0);
  f.update(error, { ...details, logOnly: true }); assert.equal(f.logs.length, 1); assert.equal(f.shown.length, 0);
  f.update(error, details); assert.equal(f.logs.length, 1); assert.equal(f.shown.length, 1);
});

test("held startup failure logs its original startup ID and verified shell correlation", async () => {
  const f = await startupFailure();
  assert.equal(f.log.requestId, startupId); assert.equal(f.log.shellAttemptRequestId, attemptId);
  assert.equal(f.log.continuationId, continuationId); assert.equal(f.log.shellId, "candidate");
  assert.equal(f.log.revision, 17); assert.equal(f.log.phase, "handoff");
  assert.deepEqual(f.log.causeCodes, ["DESKTOP_SHELL_HANDOFF_PERMIT_NOT_COMMITTED"]);
  assert.deepEqual(f.exits, [1]); assert.equal(f.received[0], f.error);
});

test("held startup keeps an existing error request ID while logging the separate attempt", async () => {
  const error = Object.assign(new Error("original failure"), { code: "ORIGINAL_STARTUP_FAILED", requestId: "startup:provided" });
  const f = await startupFailure({ error });
  assert.equal(f.log.requestId, "startup:provided"); assert.equal(f.log.shellAttemptRequestId, attemptId);
  assert.equal(f.received[0], error); assert.deepEqual(f.exits, [1]);
});

for (const mode of ["ordinary", "before-held"] as const) test(`${mode} startup failure does not infer shell correlation`, async () => {
  const f = await startupFailure({ ordinary: mode === "ordinary", beforeHeld: mode === "before-held" });
  assert.equal(f.log.requestId, startupId); assert.equal(f.log.shellAttemptRequestId, undefined);
  assert.equal(f.log.continuationId, undefined); assert.equal(f.log.shellId, undefined);
  assert.deepEqual(f.exits, [1]);
});

test("held diagnostic fields reject invalid IDs and do not evaluate accessors or disclose payload", async () => {
  let reads = 0;
  const attempt = { requestId: "invalid/request", continuationId: "invalid/continuation", target: { shellId: "invalid/shell" }, revision: -1, phase: "invalid phase",
    nonce: "private-nonce", commandLine: "private-command", environment: "private-environment" };
  Object.defineProperty(attempt, "requestId", { get() { reads++; throw new Error("GETTER_EVALUATED"); } });
  const f = await startupFailure({ attempt });
  assert.equal(reads, 0);
  for (const field of ["shellAttemptRequestId", "continuationId", "shellId", "revision", "phase"]) assert.equal(f.log[field], undefined);
  assert.doesNotMatch(JSON.stringify(f.log), /private-|invalid\//u); assert.deepEqual(f.exits, [1]);
});

test("held startup cleanup failure preserves both causes and keeps the original exit gate", async () => {
  const primary = Object.assign(new Error("permit rejected"), { code: "DESKTOP_SHELL_HANDOFF_PERMIT_NOT_COMMITTED" });
  const cleanup = Object.assign(new Error("client cleanup failed"), { code: "CLIENT_CLEANUP_FAILED" });
  const error = new DesktopStartupCleanupError(primary, cleanup), f = await startupFailure({ error });
  assert.equal(f.log.requestId, startupId); assert.equal(f.log.shellAttemptRequestId, attemptId);
  assert.ok(f.log.causeCodes.includes(primary.code)); assert.ok(f.log.causeCodes.includes(cleanup.code));
  assert.equal(f.received[0], error); assert.deepEqual(error.errors, [primary, cleanup]); assert.deepEqual(f.exits, []);
});

test("main error log retains nested process conflicts and the original failure without process text", async () => {
  const expected = { parentPid: 42, created: 1001, executableSha256: "a".repeat(64), commandLineSha256: "b".repeat(64) };
  const first = { pid: 81, changedFields: ["created"], expected, actual: { ...expected, created: 2001 } };
  const second = { pid: 82, changedFields: ["parentPid"], expected, actual: { ...expected, parentPid: 43 } };
  const original = Object.assign(new Error("private-command-and-environment"), {
    code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: first,
  });
  const additional = Object.assign(new Error("private-path-and-nonce"), {
    code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", processIdentityConflict: second,
  });
  const error = Object.assign(new Error("private-outer-message", { cause: new AggregateError([original, additional]) }), {
    code: "DESKTOP_SHELL_OPERATION_FAILED", requestId: "operation:identity", shellId: "candidate", revision: 7, phase: "preparing",
  });
  const f = await startupFailure({ error, ordinary: true });
  assert.deepEqual(f.log.processIdentityConflicts, [first, second]);
  assert.ok(f.log.causeCodes.includes(original.code)); assert.equal(f.log.requestId, error.requestId);
  assert.equal(f.log.shellId, "candidate"); assert.equal(f.log.revision, 7); assert.equal(f.log.phase, "preparing");
  assert.equal(f.received[0], error); assert.deepEqual(f.exits, [1]);
  assert.doesNotMatch(JSON.stringify(f.log), /private-/u);
});

for (const cleanupFailed of [false, true]) test(`main rejects invalid identity diagnostics and retains its ${cleanupFailed ? "cleanup" : "startup"} exit gate`, async () => {
  let reads = 0;
  const primary = Object.assign(new Error("original identity failure"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED" });
  Object.defineProperty(primary, "processIdentityConflict", { get() { reads++; throw new Error("UNTRUSTED_ACCESSOR_EVALUATED"); } });
  const error = cleanupFailed ? new DesktopStartupCleanupError(primary, new Error("original cleanup failure")) : primary;
  const f = await startupFailure({ error, expectedLogCount: 0 });
  assert.equal(reads, 0); assert.equal(f.log, undefined); assert.equal(f.received[0], error);
  assert.match(f.shown[0], /日志保存失败/u); assert.match(f.shown[0], /桌面壳/u);
  if (cleanupFailed) assert.match(f.shown[0], /停止运行环境/u);
  assert.doesNotMatch(f.shown[0], /DESKTOP_/u);
  if (error instanceof DesktopStartupCleanupError) assert.equal(error.errors[0], primary);
  assert.deepEqual(f.exits, cleanupFailed ? [] : [1]);
});

test("main logs nested inventory failures through the existing boundary without process text", async () => {
  const first = { reason: "UNKNOWN_PARENT_MISSING", pid: 201, parentPid: 200, created: 1201, instanceSha256: "a".repeat(64) };
  const second = { ...first, reason: "CHILD_PREDATES_PARENT", pid: 202 };
  const cause = Object.assign(new Error("private-command"), { code: "DESKTOP_SHELL_OPERATION_OWNED_IDENTITY_UNKNOWN", inventoryFailure: first });
  const other = Object.assign(new Error("private-path"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID", inventoryFailure: second });
  const error = Object.assign(new Error("private-wrapper", { cause: new AggregateError([cause, other]) }), { code: "DESKTOP_SHELL_OPERATION_FAILED", requestId: "operation:inventory" });
  const f = await startupFailure({ error });
  assert.deepEqual(f.log.inventoryFailures, [first, second]); assert.equal(f.log.requestId, error.requestId);
  assert.ok(f.log.causeCodes.includes(cause.code)); assert.ok(f.log.causeCodes.includes(other.code));
  assert.equal(f.received[0], error); assert.deepEqual(f.exits, [1]); assert.doesNotMatch(JSON.stringify(f.log), /private-/u);
});

for (const variant of ["getter", "unknown-reason", "extra-field", "invalid-hash"] as const)
test(`main inventory diagnostic rejects ${variant} with explicit failure and no getter execution`, async () => {
  const diagnostic = { reason: "UNKNOWN_PARENT_MISSING", pid: 201, parentPid: 200, created: 1201, instanceSha256: "a".repeat(64) };
  let reads = 0;
  if (variant === "getter") Object.defineProperty(diagnostic, "pid", { get() { reads++; throw new Error("UNTRUSTED_ACCESSOR_EVALUATED"); } });
  if (variant === "unknown-reason") diagnostic.reason = "private-reason";
  if (variant === "extra-field") Object.assign(diagnostic, { commandLine: "private-command" });
  if (variant === "invalid-hash") diagnostic.instanceSha256 = "private-hash";
  const error = Object.assign(new Error("original inventory failure"), { code: "DESKTOP_SHELL_OPERATION_OWNED_IDENTITY_UNKNOWN", inventoryFailure: diagnostic });
  const f = await startupFailure({ error, expectedLogCount: 0 });
  assert.equal(reads, 0); assert.equal(f.log, undefined); assert.equal(f.received[0], error); assert.deepEqual(f.exits, [1]);
  assert.match(f.shown[0], /日志保存失败/u);
  assert.doesNotMatch(f.shown[0], /DESKTOP_/u);
});

for (const reason of ["RELATED_IDENTITY_INVALID", "CHILD_IDENTITY_INVALID"] as const)
test(`main logs strict inventory ${reason} without hiding its original cause`, async () => {
  const diagnostic = { reason, pid: 201, parentPid: 200, created: 0, instanceSha256: "a".repeat(64) };
  const original = Object.assign(new Error("private-original"), { code: "DESKTOP_SHELL_PROCESS_INVENTORY_INVALID" });
  const error = Object.assign(new Error("private-wrapper", { cause: original }), { code: original.code, inventoryFailure: diagnostic });
  const f = await startupFailure({ error });
  assert.deepEqual(f.log.inventoryFailures, [diagnostic]); assert.equal(f.received[0], error); assert.equal(error.cause, original);
  assert.deepEqual(f.exits, [1]); assert.doesNotMatch(JSON.stringify(f.log), /private-/u);
});
