import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { compileFunction } from "node:vm";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const scriptUrl = new URL("./electron-uninstall-maintenance.smoke.mjs", import.meta.url);
const source = await fs.readFile(scriptUrl, "utf8"), prefix = "DESKTOP_UNINSTALL_MAINTENANCE";
const require = createRequire(new URL("../package.json", import.meta.url));
const builder = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>;
};
type Paths = { root: string; evidenceRoot: string; resourcesSource: string; buildRoot: string; mode: string;
  before: { nsisElevate?: string; build: Record<string, string> } };
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 执行原 preflight；真实文件与 ASAR 不替换，仅把仓库构建根移入独占夹具。 */
function preflight(repository: string, args: string[]): Promise<Paths> {
  const start = source.indexOf("function contains("), end = source.indexOf("/** 单次真实子进程", start);
  assert.ok(start >= 0 && end > start);
  const code = source.slice(start, end).replaceAll("import.meta.url", JSON.stringify(scriptUrl.href));
  const load = compileFunction(code + "\nreturn preflight(args);",
    ["assert", "crypto", "fs", "createReadStream", "path", "prefix", "repository", "createRequire", "process", "args"]);
  return load(assert, crypto, fs, createReadStream, path, prefix, repository, createRequire, { platform: "win32" }, args) as Promise<Paths>;
}

/** 小型真实工件含空格路径；不读公共 dist，不启动 Electron 或 builder。 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(process.env.CF_D16_INPUT_TEST_ROOT ?? os.tmpdir(), "maintenance-input-"));
  if (!process.env.CF_D16_INPUT_TEST_ROOT) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository"), artifact = path.join(root, "Program Files", "win-unpacked");
  const evidence = path.join(root, "evidence"), resources = path.join(root, "resource baseline"), output = path.join(evidence, "new run");
  const files: Record<string, string> = {
    "repository/apps/desktop/client/dist/index.cjs": "client", "repository/apps/desktop/client/dist/desktopUninstallWorker.cjs": "worker",
    "resource baseline/client/dist/index.cjs": "client", "resource baseline/client/dist/desktopUninstallWorker.cjs": "worker",
    "resource baseline/web/index.html": "web", "Program Files/win-unpacked/CodeFlowAI.exe": "fixture-exe",
    "baseline/elevate.exe": "explicit-helper",
    "repository/package.json": '{"type":"module"}', "repository/tsconfig.base.json": '{}',
    "repository/apps/desktop/client/package.json": '{"type":"module"}', "repository/apps/desktop/client/tsconfig.json": '{}',
    "repository/packages/shared/package.json": '{"type":"module","exports":{".":"./src/index.ts","./node-logger":"./src/nodeLogger.ts"}}',
    "repository/packages/shared/tsconfig.json": '{}', "repository/packages/shared/src/index.ts": 'export {};',
    "repository/packages/shared/src/nodeLogger.ts": 'export {};',
  };
  for (const file of ["db/clientDb.ts", "db/sqliteDb.ts", "db/migrateClientDb.ts", "db/repos/engineKeyRepo.ts", "db/repos/scheduledTaskRuntimeStateRepo.ts"]) {
    files["repository/apps/desktop/client/src/" + file] = "export {};";
  }
  for (const app of ["apps/desktop/client", "packages/shared"]) for (const dependency of ["pino", "pino-roll", "tsx"]) {
    files[`repository/${app}/node_modules/${dependency}/package.json`] = '{"main":"index.js"}';
    files[`repository/${app}/node_modules/${dependency}/index.js`] = 'module.exports = {};';
  }
  for (const name of ["main.js", "desktopMaintenanceRecord.js", "deviceIdentity.js", "desktopStorageLocation.js"]) {
    files["repository/apps/desktop/dist/" + name] = "// " + name;
    files["asar/dist/" + name] = "// " + name;
  }
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value, "utf8");
  }
  await fs.mkdir(evidence); await fs.cp(resources, path.join(artifact, "resources"), { recursive: true });
  await fs.mkdir(path.join(repository, "apps/desktop/client/node_modules/@codeflowai"));
  await fs.symlink(path.join(repository, "packages/shared"), path.join(repository, "apps/desktop/client/node_modules/@codeflowai/shared"), "junction");
  await asar.createPackage(path.join(root, "asar"), path.join(artifact, "resources/app.asar"));
  const executable = path.join(artifact, "CodeFlowAI.exe"), helper = path.join(root, "baseline/elevate.exe");
  const args = [executable, output, "--evidence-root", evidence, "--resources", resources];
  return { root, repository, artifact, evidence, resources, output, executable, helper, args };
}

/** 比较所有目录/文件和链接本身；失败不允许悄悄创建输出或修改输入。 */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isSymbolicLink()) result[item.name] = "link:" + await fs.readlink(file);
    else if (item.isDirectory()) {
      result[item.name] = "directory";
      for (const [name, value] of Object.entries(await snapshot(file))) result[item.name + "/" + name] = value;
    } else result[item.name] = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  }
  return result;
}

/** 每个反例必须在原预检失败且整组夹具零写。 */
async function rejected(f: Fixture, args: string[], error: RegExp) {
  const before = await snapshot(f.root);
  await assert.rejects(preflight(f.repository, args), error);
  assert.deepEqual(await snapshot(f.root), before);
}

test("maintenance preflight accepts explicit baselines outside old evidence roots without writing", async t => {
  const f = await fixture(t), before = await snapshot(f.root), result = await preflight(f.repository, f.args);
  assert.equal(result.root, f.output); assert.equal(result.evidenceRoot, f.evidence); assert.equal(result.resourcesSource, f.resources);
  assert.equal(result.mode, "keep"); assert.deepEqual(await snapshot(f.root), before);
});

/** 独立冻结根保留原六个构建文件，公共构建可随后变化。 */
async function frozenBuild(f: Fixture) {
  const root = path.join(f.root, "frozen build");
  const sourceShared = path.join(f.repository, "apps/desktop/client/node_modules/@codeflowai/shared");
  await fs.cp(f.repository, root, { recursive: true, filter: source => source !== sourceShared });
  const shared = path.join(root, "apps/desktop/client/node_modules/@codeflowai/shared");
  await fs.symlink(path.join(root, "packages/shared"), shared, "junction");
  return root;
}

test("maintenance preflight binds an explicit frozen build while the public build differs", async t => {
  const f = await fixture(t), buildRoot = await frozenBuild(f);
  await fs.writeFile(path.join(f.repository, "apps/desktop/client/dist/index.cjs"), "new public client", "utf8");
  const before = await snapshot(f.root), result = await preflight(f.repository, [...f.args, "--build-root", buildRoot]);
  assert.equal(result.buildRoot, await fs.realpath(buildRoot));
  assert.ok(Object.keys(result.before.build).length > 6);
  assert.equal(result.before.build["apps/desktop/client/dist/index.cjs"], crypto.createHash("sha256").update("client").digest("hex"));
  assert.deepEqual(await snapshot(f.root), before);
  await rejected(f, f.args, /_STALE_CLIENT/u);
});

test("maintenance preflight keeps the current repository as the default build baseline", async t => {
  const f = await fixture(t), result = await preflight(f.repository, f.args);
  assert.equal(result.buildRoot, await fs.realpath(f.repository));
  assert.ok(Object.keys(result.before.build).length > 6);
});

test("maintenance preflight inventories frozen fixture sources and rejects cross-root shared resolution", async t => {
  const f = await fixture(t), buildRoot = await frozenBuild(f), result = await preflight(f.repository, [...f.args, "--build-root", buildRoot]);
  assert.equal(result.before.build["apps/desktop/client/src/db/migrateClientDb.ts"], crypto.createHash("sha256").update("export {};").digest("hex"));
  assert.ok(result.before.build["packages/shared/src/nodeLogger.ts"]);
  const shared = path.join(buildRoot, "apps/desktop/client/node_modules/@codeflowai/shared");
  await fs.rm(shared, { recursive: true }); await fs.symlink(path.join(f.repository, "packages/shared"), shared, "junction");
  await rejected(f, [...f.args, "--build-root", buildRoot], /_FIXTURE_SHARED_ROOT/u);
});

test("maintenance preflight rejects missing fixture sources before writing", async t => {
  const f = await fixture(t), buildRoot = await frozenBuild(f);
  await fs.unlink(path.join(buildRoot, "apps/desktop/client/src/db/clientDb.ts"));
  await rejected(f, [...f.args, "--build-root", buildRoot], /ENOENT/u);
});

test("maintenance preflight accepts shared hardlinked tool entries and package descriptions", async t => {
  const f = await fixture(t), store = path.join(f.root, "tool store");
  await fs.mkdir(store);
  for (const name of ["index.js", "package.json"]) {
    const file = path.join(f.repository, "apps/desktop/client/node_modules/pino", name);
    await fs.link(file, path.join(store, name));
    assert.equal((await fs.lstat(file)).nlink, 2);
  }
  const before = await snapshot(f.root), result = await preflight(f.repository, f.args);
  for (const name of ["index.js", "package.json"]) {
    const file = await fs.realpath(path.join(f.repository, "apps/desktop/client/node_modules/pino", name));
    const key = Object.keys(result.before.build).find(key => key.endsWith(":" + file));
    assert.ok(key); assert.equal(result.before.build[key], crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"));
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("maintenance data program imports every fixture module from the selected build root", () => {
  const start = source.indexOf("function dataProgram("), end = source.indexOf("\n/**", start);
  const program = compileFunction(source.slice(start, end) + "\nreturn dataProgram(root);", ["root", "repository", "path", "pathToFileURL", "assert", "prefix"])(
    "E:/isolated frozen build", "D:/unrelated-current", path, pathToFileURL, assert, prefix) as string;
  for (const relative of ["db/clientDb.ts", "db/sqliteDb.ts", "db/migrateClientDb.ts", "db/repos/engineKeyRepo.ts", "db/repos/scheduledTaskRuntimeStateRepo.ts"]) {
    assert.ok(program.includes(pathToFileURL(path.join("E:/isolated frozen build/apps/desktop/client/src", relative)).href));
  }
  assert.equal(program.includes("unrelated-current"), false);
});

/** 执行原 Inspector 注入模板；依赖解析仍使用夹具包的真实 Node 规则。 */
function threadInstrumentation(resources: string): string {
  const marker = "expression: `(() => {const originalArguments=", start = source.indexOf(marker);
  const end = source.indexOf("})()` });", start);
  assert.ok(start >= 0 && end > start);
  return compileFunction("return " + source.slice(start + "expression: ".length, end + "})()`".length),
    ["path", "paths", "createRequire"])(path, { resources }, createRequire) as string;
}

for (const layout of ["flat", "nested"] as const) test(`maintenance thread injection resolves ${layout} pino dependencies and preserves Worker options`, { timeout: 15_000 }, async t => {
  const f = await fixture(t), resources = path.join(f.artifact, "resources"), modules = path.join(resources, "client/node_modules");
  const threadRoot = path.join(modules, layout === "nested" ? "pino/node_modules/thread-stream" : "thread-stream");
  const target = path.join(threadRoot, "lib/worker.js"), unrelated = path.join(f.root, "unrelated-worker.js");
  const program = "const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({execArgv:process.execArgv,marker:workerData.marker});";
  const files = new Map([
    [path.join(modules, "pino/package.json"), '{"main":"pino.js"}'], [path.join(modules, "pino/pino.js"), "module.exports={};"],
    [path.join(threadRoot, "package.json"), '{"main":"index.js"}'], [path.join(threadRoot, "index.js"), "module.exports={};"],
    [target, program], [unrelated, program],
  ]);
  for (const [file, value] of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value, "utf8"); }
  const probe = new Worker(`
    const assert=require('node:assert/strict'),{parentPort,workerData}=require('node:worker_threads'),threads=require('node:worker_threads');
    process.execArgv.splice(0,process.execArgv.length,'--inspect-brk=127.0.0.1:0','--no-warnings');
    const original=threads.Worker;
    /** 等待真实线程结果并确保失败时也终止当前测试线程。 */
    async function observe(filename,options){const child=new threads.Worker(filename,options);try{
      return await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);
        child.once('exit',code=>{if(code!==0)reject(new Error('THREAD_PROBE_EXIT_'+code));});});
    }finally{await child.terminate();}}
    void(async()=>{const injected=eval(workerData.expression);try{
      assert.equal(globalThis.__keepThreadInstrumentation.target,workerData.target);
      const unrelatedDefault=await observe(workerData.unrelated,{workerData:{marker:'unrelated-default'}});
      const unrelated=await observe(workerData.unrelated,{execArgv:['--trace-warnings'],workerData:{marker:'unrelated'}});
      const explicit=await observe(workerData.target,{execArgv:['--no-deprecation'],workerData:{marker:'explicit'}});
      assert.equal(globalThis.__keepThreadInstrumentation.hits.length,0);
      const inherited=await observe(workerData.target,{workerData:{marker:'inherited'}});
      parentPort.postMessage({injected,unrelatedDefault,unrelated,explicit,inherited,instrumentation:globalThis.__keepThreadInstrumentation,
        restored:threads.Worker===original,parentArguments:process.execArgv});
    }finally{clearInterval(globalThis.__keepExitHold);}})();
  `, { eval: true, execArgv: [], workerData: { expression: threadInstrumentation(resources), target, unrelated } });
  t.after(async () => { await probe.terminate(); });
  type ThreadResult = { execArgv: string[]; marker: string };
  const result = await new Promise<{ injected: { originalArguments: string[] }; parentArguments: string[]; restored: boolean;
    unrelatedDefault: ThreadResult; unrelated: ThreadResult; explicit: ThreadResult; inherited: ThreadResult;
    instrumentation: { hits: { filename: string }[] } }>((resolve, reject) => { probe.once("message", resolve); probe.once("error", reject); });
  assert.deepEqual(result.injected.originalArguments, ["--inspect-brk=127.0.0.1:0", "--no-warnings"]);
  assert.deepEqual(result.parentArguments, result.injected.originalArguments);
  assert.deepEqual(result.unrelatedDefault, { execArgv: [], marker: "unrelated-default" });
  assert.deepEqual(result.unrelated, { execArgv: ["--trace-warnings"], marker: "unrelated" });
  assert.deepEqual(result.explicit, { execArgv: ["--no-deprecation"], marker: "explicit" });
  assert.deepEqual(result.inherited, { execArgv: ["--no-warnings"], marker: "inherited" });
  assert.equal(result.instrumentation.hits.length, 1); assert.equal(result.restored, true);
  assert.equal(result.instrumentation.hits[0].filename, target);
});

test("maintenance thread injection rejects missing packaged pino instead of guessing a target", async t => {
  const f = await fixture(t);
  assert.throws(() => threadInstrumentation(path.join(f.artifact, "resources")), /Cannot find module 'pino'/u);
});

for (const file of ["main.js", "desktopMaintenanceRecord.js", "deviceIdentity.js", "desktopStorageLocation.js", "index.cjs", "desktopUninstallWorker.cjs"]) {
  test(`maintenance preflight rejects changed frozen build ${file} before writing`, async t => {
    const f = await fixture(t), buildRoot = await frozenBuild(f);
    const relative = path.join("apps", "desktop", ...(file.endsWith(".cjs") ? ["client"] : []), "dist", file);
    await fs.writeFile(path.join(buildRoot, relative), "changed frozen input", "utf8");
    await rejected(f, [...f.args, "--build-root", buildRoot], /_STALE_ASAR|_STALE_CLIENT/u);
  });
}

for (const [name, change, error] of [
  ["drive root", (f: Fixture) => path.parse(f.root).root, /_BUILD_ROOT/u],
  ["missing root", (f: Fixture) => path.join(f.root, "missing build"), /ENOENT/u],
  ["file root", (f: Fixture) => f.executable, /_BUILD_ROOT/u],
  ["artifact overlap", (f: Fixture) => f.artifact, /_OVERLAP/u],
  ["artifact ancestor overlap", (f: Fixture) => path.dirname(f.artifact), /_OVERLAP/u],
  ["artifact descendant overlap", (f: Fixture) => path.join(f.artifact, "resources"), /_OVERLAP/u],
  ["resource overlap", (f: Fixture) => f.resources, /_OVERLAP/u],
  ["resource descendant overlap", (f: Fixture) => path.join(f.resources, "client"), /_OVERLAP/u],
  ["output overlap", (f: Fixture) => f.evidence, /_OVERLAP/u],
] as const) test(`maintenance preflight rejects frozen ${name} before writing`, async t => {
  const f = await fixture(t); await rejected(f, [...f.args, "--build-root", change(f)], error);
});

for (const kind of ["missing", "directory", "link", "hardlink"] as const) test(`maintenance preflight rejects ${kind} build files before writing`, async t => {
  const f = await fixture(t), buildRoot = await frozenBuild(f), target = path.join(buildRoot, "apps/desktop/client/dist/index.cjs");
  await fs.unlink(target);
  if (kind === "directory") await fs.mkdir(target);
  if (kind === "link") await fs.symlink(f.resources, target, "junction");
  if (kind === "hardlink") await fs.link(path.join(f.repository, "apps/desktop/client/dist/index.cjs"), target);
  await rejected(f, [...f.args, "--build-root", buildRoot], /ENOENT|_LINK|_PRIVATE_FILE_REQUIRED/u);
});

test("maintenance preflight rejects linked build roots and intermediate directories before writing", async t => {
  const f = await fixture(t), buildRoot = await frozenBuild(f), link = path.join(f.root, "linked build");
  await fs.symlink(buildRoot, link, "junction");
  await rejected(f, [...f.args, "--build-root", link], /_LINK/u);
  const client = path.join(buildRoot, "apps/desktop/client"), moved = path.join(f.root, "client baseline");
  await fs.rename(client, moved); await fs.symlink(moved, client, "junction");
  await rejected(f, [...f.args, "--build-root", buildRoot], /_LINK/u);
});

test("maintenance preflight accepts remove and exactly matched explicit NSIS helper", async t => {
  const f = await fixture(t); await fs.copyFile(f.helper, path.join(f.artifact, "resources/elevate.exe"));
  const result = await preflight(f.repository, [...f.args, "--mode", "remove", "--nsis-elevate", f.helper]);
  assert.equal(result.mode, "remove");
  assert.equal(result.before.nsisElevate, crypto.createHash("sha256").update("explicit-helper").digest("hex"));
});

for (const [name, change] of [
  ["missing evidence root", (f: Fixture) => [f.executable, f.output, "--resources", f.resources]],
  ["missing resources", (f: Fixture) => [f.executable, f.output, "--evidence-root", f.evidence]],
  ["unknown option", (f: Fixture) => [...f.args, "--other", "value"]],
  ["duplicate option", (f: Fixture) => [...f.args, "--resources", f.resources]],
  ["missing option value", (f: Fixture) => [...f.args, "--mode"]],
  ["option used as value", (f: Fixture) => [...f.args, "--mode", "--resources"]],
  ["unknown mode", (f: Fixture) => [...f.args, "--mode", "other"]],
  ["duplicate build root", (f: Fixture) => [...f.args, "--build-root", f.repository, "--build-root", f.repository]],
  ["missing build root value", (f: Fixture) => [...f.args, "--build-root"]],
  ["build root option as value", (f: Fixture) => [...f.args, "--build-root", "--resources"]],
] as const) test(`maintenance preflight rejects ${name} before writing`, async t => {
  const f = await fixture(t); await rejected(f, change(f), /用法：/u);
});

for (const [name, output, code] of [
  ["equal evidence root", (f: Fixture) => f.evidence, "OUTPUT_SCOPE"],
  ["sibling prefix", (f: Fixture) => f.evidence + "-other", "OUTPUT_SCOPE"],
  ["artifact overlap", (f: Fixture) => path.join(f.artifact, "run"), "OVERLAP"],
  ["resource overlap", (f: Fixture) => path.join(f.resources, "run"), "OVERLAP"],
  ["repository overlap", (f: Fixture) => path.join(f.repository, "run"), "OVERLAP"],
] as const) test(`maintenance preflight rejects ${name} without writing`, async t => {
  const f = await fixture(t), target = output(f);
  const evidence = code === "OVERLAP" ? f.root : f.evidence;
  await rejected(f, [f.executable, target, "--resources", f.resources, "--evidence-root", evidence], new RegExp(prefix + "_" + code));
});

test("maintenance preflight preserves an existing output and rejects linked output ancestors", async t => {
  const f = await fixture(t); await fs.mkdir(f.output); await fs.writeFile(path.join(f.output, "preserved"), "keep", "utf8");
  await rejected(f, f.args, /_OUTPUT_EXISTS/u);
  const link = path.join(f.evidence, "linked"); await fs.symlink(f.resources, link, "junction");
  await rejected(f, [f.executable, path.join(link, "run"), ...f.args.slice(2)], /_LINK/u);
});

for (const [name, setup, extra] of [
  ["unknown additional resource", async (f: Fixture) => { await fs.writeFile(path.join(f.artifact, "resources/extra.bin"), "extra"); }, () => []],
  ["changed business resource", async (f: Fixture) => { await fs.writeFile(path.join(f.artifact, "resources/web/index.html"), "changed"); }, () => []],
  ["unacknowledged helper", async (f: Fixture) => { await fs.copyFile(f.helper, path.join(f.artifact, "resources/elevate.exe")); }, () => []],
  ["changed helper", async (f: Fixture) => { await fs.writeFile(path.join(f.artifact, "resources/elevate.exe"), "changed"); }, (f: Fixture) => ["--nsis-elevate", f.helper]],
  ["unused helper baseline", async () => {}, (f: Fixture) => ["--nsis-elevate", f.helper]],
] as const) test(`maintenance preflight rejects ${name} without writing`, async t => {
  const f = await fixture(t); await setup(f); await rejected(f, [...f.args, ...extra(f)], /_RESOURCES_MISMATCH|_NSIS_HELPER/u);
});

test("maintenance preflight rejects helper aliases and linked input baselines", async t => {
  const f = await fixture(t); await fs.copyFile(f.helper, path.join(f.artifact, "resources/elevate.exe"));
  await rejected(f, [...f.args, "--nsis-elevate", path.join(f.artifact, "resources/elevate.exe")], /_NSIS_HELPER_OVERLAP/u);
  const link = path.join(f.root, "linked resources"); await fs.symlink(f.resources, link, "junction");
  await rejected(f, [f.executable, f.output, "--evidence-root", f.evidence, "--resources", link], /_LINK/u);
  const helperLink = path.join(f.root, "linked helper"); await fs.symlink(path.dirname(f.helper), helperLink, "junction");
  await rejected(f, [...f.args, "--nsis-elevate", path.join(helperLink, "elevate.exe")], /_LINK/u);
});

type NativeRow = { pid: number; parentPid: number; created: number; executable: string; commandLine: string };
const debugExe = "C:\\Program Files\\CodeFlowAI\\CodeFlowAI.exe", debugProfile = "F:\\evidence files\\profile\\";
const inspectorArgument = "--inspect-brk=127.0.0.1:0", profileArgument = "--user-data-dir=" + debugProfile;
const nativeLine = '"C:\\Program Files\\CodeFlowAI\\CodeFlowAI.exe" --inspect-brk=127.0.0.1:0 "--user-data-dir=F:\\evidence files\\profile\\\\" --codeflow-uninstall-maintenance fixture-1 keep';
const encodedQuery = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$result=@(Get-CimInstance Win32_Process)\nConvertTo-Json -InputObject $result -Compress", "utf16le").toString("base64")];

/** 执行完整原注入；系统及Electron边界替身保参数/拒绝，观测文件真实落盘。 */
async function instrument(t: TestContext, maintenance = true, options: { fault?: string } = {}, browserFailure?: Error) {
  const root = await fs.mkdtemp(path.join(process.env.CF_D16_INPUT_TEST_ROOT ?? os.tmpdir(), "maintenance-debug-"));
  if (!process.env.CF_D16_INPUT_TEST_ROOT) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = { profile: debugProfile, root, data: path.join(root, "data"), requestId: "fixture-1", mode: "keep", location: { deviceId: "fixture-device" } };
  const state = { pid: 10001, ppid: 10000, execPath: debugExe, argv: [debugExe, inspectorArgument, profileArgument, "--codeflow-uninstall-maintenance", "fixture-1", "keep"], on() {} };
  const row: NativeRow = { pid: state.pid, parentPid: state.ppid, created: Date.now() - 1000, executable: debugExe, commandLine: nativeLine };
  const other: NativeRow = { pid: 10002, parentPid: state.pid, created: row.created, executable: debugExe,
    commandLine: debugExe + " --type=utility " + inspectorArgument + " " + profileArgument };
  type BrowserValue = { snapshotAdaptationError?: { message: string }; order: number; clearData: number; clearStorageData: number; clearAuthCache: number;
    clearDataOrder: number; clearDataDoneOrder: number; clearStorageDataOrder: number; clearStorageDataDoneOrder: number;
    clearAuthCacheOrder: number; clearAuthCacheDoneOrder: number; clearStorageDataDone?: boolean;
    clearStorageDataArguments: { argumentCount: number; optionsValid: boolean; origin?: string }[] };
  const globals: { __keep?: { value: BrowserValue } } = {};
  const paths: Record<string, string> = { userData: debugProfile, sessionData: debugProfile };
  const browserCalls: { method: string; args: unknown[] }[] = [];
  const session = { defaultSession: {
    /** 记录宽域清理的原生调用，不模拟产品编排。 */
    async clearData(...args: unknown[]) { browserCalls.push({ method: "clearData", args }); },
    /** 保参数引用并透传受控原生拒绝。 */
    async clearStorageData(...args: unknown[]) { browserCalls.push({ method: "clearStorageData", args }); if (browserFailure) throw browserFailure; },
    /** 记录认证清理，仅由实际调用驱动。 */
    async clearAuthCache(...args: unknown[]) { browserCalls.push({ method: "clearAuthCache", args }); },
  } };
  const electron = { app: { getPath: (name: string) => paths[name], setPath: (name: string, value: string) => { paths[name] = value; },
    exit() {}, requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), isPackaged: true },
    session, dialog: { showErrorBox() {} }, ipcMain: { handle() {} } };
  let queryResult: { error: Error | null; stdout: string; stderr: string };
  const cp = { execFile: (_executable: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(queryResult.error, queryResult.stdout, queryResult.stderr); return "query-handle";
  } };
  const modules: Record<string, unknown> = { electron, "node:fs": { ...fsSync }, "node:fs/promises": { ...fs }, "node:child_process": cp,
    "node:module": { syncBuiltinESMExports() {} }, "node:diagnostics_channel": { channel: () => ({ subscribe() {} }) } };
  const start = source.indexOf("function instrumentation("), end = source.indexOf("/** 观测只读", start);
  const expression = compileFunction(source.slice(start, end) + "\nreturn instrumentation(context, maintenance, options, root);",
    ["context", "maintenance", "options", "root", "path", "recordName", "locatorName", "reappearedContent"])(context, maintenance, options, root, path,
    "desktop-uninstall-result.json", "desktop-data-location.json", "fixture");
  compileFunction("return " + expression, ["require", "process", "globalThis"])((name: string) => {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  }, state, globals);
  await Promise.resolve();
  return { row, other, globals, root, browser: session.defaultSession, browserCalls,
    /** 原回调必须只调用一次，查询错误与 stderr 原样保留。 */
    async query(stdout: string, error: Error | null = null, args = encodedQuery) {
      queryResult = { stdout, error, stderr: "fixture-stderr" };
      let calls = 0;
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        assert.equal(cp.execFile("powershell.exe", args, {}, (failure, text, stderr) => { calls++; resolve({ error: failure, stdout: text, stderr }); }), "query-handle");
      });
      assert.equal(calls, 1); assert.equal(result.stderr, "fixture-stderr"); return result;
    },
  };
}

test("maintenance browser instrumentation observes the fixed origin and preserves actual call order", async t => {
  const f = await instrument(t), options = { origin: "codeflow://desktop" };
  await f.browser.clearData(); await f.browser.clearStorageData(options); await f.browser.clearAuthCache();
  const value = f.globals.__keep!.value;
  assert.equal(value.clearData, 1); assert.equal(value.clearStorageData, 1); assert.equal(value.clearAuthCache, 1);
  assert.ok(value.clearDataOrder < value.clearDataDoneOrder && value.clearDataDoneOrder < value.clearStorageDataOrder);
  assert.ok(value.clearStorageDataOrder < value.clearStorageDataDoneOrder && value.clearStorageDataDoneOrder < value.clearAuthCacheOrder);
  assert.ok(value.clearAuthCacheOrder < value.clearAuthCacheDoneOrder);
  assert.deepEqual(value.clearStorageDataArguments, [{ argumentCount: 1, optionsValid: true, origin: "codeflow://desktop" }]);
  assert.equal(f.browserCalls[1]!.args[0], options);
});

test("maintenance browser instrumentation injects storage failure before native side effects and a new process retries", async t => {
  const failed = await instrument(t, true, { fault: "clearStorageData" });
  await failed.browser.clearData();
  await assert.rejects(async () => { await failed.browser.clearStorageData({ origin: "codeflow://desktop" }); await failed.browser.clearAuthCache(); },
    { message: "D16_BROWSER_FAILED", code: "D16_BROWSER_FAILED" });
  const value = failed.globals.__keep!.value;
  assert.equal(value.clearStorageData, 1); assert.equal(value.clearStorageDataDone, undefined); assert.equal(value.clearAuthCache, 0);
  assert.deepEqual(failed.browserCalls.map(call => call.method), ["clearData"]);
  const retry = await instrument(t);
  await retry.browser.clearData(); await retry.browser.clearStorageData({ origin: "codeflow://desktop" }); await retry.browser.clearAuthCache();
  assert.equal(retry.globals.__keep!.value.clearStorageDataDone, true);
  assert.equal(retry.globals.__keep!.value.clearAuthCache, 1);
});

test("maintenance browser instrumentation preserves native storage rejection and never marks completion", async t => {
  const cause = new Error("CONTROLLED_STORAGE_FAILURE"), f = await instrument(t, true, {}, cause);
  await assert.rejects(f.browser.clearStorageData({ origin: "codeflow://desktop" }), error => error === cause);
  assert.equal(f.globals.__keep!.value.clearStorageData, 1);
  assert.equal(f.globals.__keep!.value.clearStorageDataDone, undefined);
  assert.equal(f.globals.__keep!.value.clearAuthCache, 0);
});

test("maintenance browser instrumentation records invalid scope safely without changing native arguments", async t => {
  const f = await instrument(t), options = { origin: "private-origin-marker", secret: "private-option-marker" };
  await f.browser.clearStorageData(options);
  assert.deepEqual(f.globals.__keep!.value.clearStorageDataArguments, [{ argumentCount: 1, optionsValid: false }]);
  assert.equal(f.browserCalls[0]!.args[0], options);
  for (const name of await fs.readdir(f.root)) {
    const text = await fs.readFile(path.join(f.root, name), "utf8");
    assert.equal(text.includes("private-origin-marker"), false); assert.equal(text.includes("private-option-marker"), false);
  }
});

test("maintenance remove matrix retries storage failure from started with its worker enabled", async () => {
  const calls: { context: { name: string }; name: string; options: { fault?: string; phase?: string; skipWorker?: boolean } }[] = [];
  const start = source.indexOf("async function removeMatrix("), end = source.indexOf("\n/**", start);
  const matrix = compileFunction(source.slice(start, end) + "\nreturn removeMatrix;", ["fixture", "launch", "checkpoint"])(
    async (_paths: unknown, name: string) => ({ name }),
    async (_paths: unknown, context: { name: string }, name: string, options = {}) => { calls.push({ context, name, options }); return { status: "passed" }; },
    async () => {}) as (paths: unknown, report: { scenarios: unknown[] }) => Promise<void>;
  const report = { scenarios: [] }; await matrix({}, report);
  const storage = calls.filter(call => call.context.name === "fault-clearStorageData");
  assert.deepEqual(storage.map(call => ({ name: call.name, options: call.options })), [
    { name: "failed", options: { fault: "clearStorageData", failure: true, phase: "started" } },
    { name: "retry", options: { skipWorker: false } },
  ]);
  assert.equal(report.scenarios.length, 17);
  assert.deepEqual(calls.filter(call => call.context.name === "fault-database").map(call => call.options), [
    { fault: "database", failure: true, phase: "data_action_authorized" }, { skipWorker: true },
  ]);
});

test("maintenance instrumentation strips only two complete self arguments with spaces and trailing backslashes", async t => {
  const f = await instrument(t), original = JSON.stringify([f.other, f.row]);
  const result = await f.query("\uFEFF" + original);
  assert.equal(result.error, null);
  const rows = JSON.parse(result.stdout) as NativeRow[];
  assert.deepEqual(rows[0], f.other);
  assert.equal(rows[1]!.commandLine, '"C:\\Program Files\\CodeFlowAI\\CodeFlowAI.exe"   --codeflow-uninstall-maintenance fixture-1 keep');
  assert.deepEqual(rows[1], { ...f.row, commandLine: rows[1]!.commandLine });
});

for (const [name, mutate] of [
  ["missing self", (rows: NativeRow[]) => rows.splice(1, 1)],
  ["duplicate self", (rows: NativeRow[]) => rows.push({ ...rows[1]! })],
  ["reordered debug arguments", (rows: NativeRow[]) => { rows[1]!.commandLine = '"C:\\Program Files\\CodeFlowAI\\CodeFlowAI.exe" "--user-data-dir=F:\\evidence files\\profile\\\\" --inspect-brk=127.0.0.1:0 --codeflow-uninstall-maintenance fixture-1 keep'; }],
  ["debug argument before argv executable", (rows: NativeRow[]) => { rows[1]!.commandLine = '--inspect-brk=127.0.0.1:0 "C:\\Program Files\\CodeFlowAI\\CodeFlowAI.exe" "--user-data-dir=F:\\evidence files\\profile\\\\" --codeflow-uninstall-maintenance fixture-1 keep'; }],
  ["different parent", (rows: NativeRow[]) => { rows[1]!.parentPid++; }],
  ["different executable", (rows: NativeRow[]) => { rows[1]!.executable += ".other"; }],
  ["unknown creation", (rows: NativeRow[]) => { rows[1]!.created = 0; }],
  ["future creation", (rows: NativeRow[]) => { rows[1]!.created = Date.now() + 60_000; }],
  ["different argv executable", (rows: NativeRow[]) => { rows[1]!.commandLine = rows[1]!.commandLine.replace("Program Files", "Other Files"); }],
  ["duplicate inspector", (rows: NativeRow[]) => { rows[1]!.commandLine += " " + inspectorArgument; }],
  ["duplicate profile", (rows: NativeRow[]) => { rows[1]!.commandLine += ' "--user-data-dir=F:\\evidence files\\profile\\\\"'; }],
  ["missing inspector", (rows: NativeRow[]) => { rows[1]!.commandLine = rows[1]!.commandLine.replace(inspectorArgument, ""); }],
  ["inspector inside another argument", (rows: NativeRow[]) => { rows[1]!.commandLine = rows[1]!.commandLine.replace(inspectorArgument, "other=" + inspectorArgument); }],
  ["extra native argument", (rows: NativeRow[]) => { rows[1]!.commandLine += " --extra"; }],
  ["bad quote", (rows: NativeRow[]) => { rows[1]!.commandLine += ' "'; }],
  ["NUL", (rows: NativeRow[]) => { rows[1]!.commandLine += "\0"; }],
  ["overlong command line", (rows: NativeRow[]) => { rows[1]!.commandLine += " ".repeat(32768); }],
] as const) test(`maintenance instrumentation fails explicitly for ${name} and preserves raw query`, async t => {
  const f = await instrument(t), rows = [f.other, f.row]; mutate(rows);
  const original = JSON.stringify(rows), result = await f.query(original);
  assert.ok(result.error); assert.match(result.error.message, /^D16_DEBUG_/u); assert.equal(result.stdout, original);
  assert.equal(f.globals.__keep?.value.snapshotAdaptationError?.message, result.error.message);
});

test("maintenance instrumentation preserves query errors and unrelated queries without adaptation", async t => {
  const f = await instrument(t), cause = new Error("QUERY_FAILED"), raw = JSON.stringify([f.other, f.row]);
  const failed = await f.query(raw, cause); assert.equal(failed.error, cause); assert.equal(failed.stdout, raw);
  const unrelated = await f.query(raw, null, ["-EncodedCommand", Buffer.from("Get-Process", "utf16le").toString("base64")]);
  assert.equal(unrelated.error, null); assert.equal(unrelated.stdout, raw);
});

test("ordinary instrumentation leaves native snapshots and debug arguments intact", async t => {
  const f = await instrument(t, false), raw = JSON.stringify([f.other, f.row]), result = await f.query(raw);
  assert.equal(result.error, null); assert.equal(result.stdout, raw);
});

test("maintenance instrumentation reports malformed JSON without recording query content", async t => {
  const f = await instrument(t), raw = "private-query-marker not JSON", result = await f.query(raw);
  assert.ok(result.error); assert.equal(result.error.message, "D16_DEBUG_SNAPSHOT_INVALID");
  assert.ok(result.error.cause instanceof SyntaxError); assert.equal(result.stdout, raw);
  assert.equal(f.globals.__keep?.value.snapshotAdaptationError?.message, "D16_DEBUG_SNAPSHOT_INVALID");
  for (const file of await fs.readdir(f.root)) assert.equal((await fs.readFile(path.join(f.root, file), "utf8")).includes("private-query-marker"), false);
});

for (const outcome of ["success", "identity", "artifact", "build", "source", "build-success"] as const) test(`maintenance run binds the build baseline through ${outcome}`, async t => {
  const f = await fixture(t), state: { exitCode?: number } = {}, messages: unknown[] = [];
  const child = { pid: 10001, parentPid: 10000, created: "2026-01-01T00:00:00.000Z", executable: f.executable,
    commandLineSha256: crypto.createHash("sha256").update("").digest("hex") };
  const initial = Object.assign(new Error(prefix + "_PROCESS_IDENTITY"), { childIdentity: child,
    missingFields: ["commandLine"], observedAt: "2026-01-01T00:00:01.000Z" });
  const expected = { child, missingFields: ["commandLine"], observedAt: "2026-01-01T00:00:01.000Z" };
  let before: unknown;
  const helpers = source.slice(source.indexOf("function contains("), source.indexOf("/** 首次写入前"));
  const diagnostics = source.slice(source.indexOf("function processIdentityFailure("), source.indexOf("/** CIM 未登记"));
  const start = source.indexOf("export async function run("), end = source.indexOf("\nif (process.argv[1]", start);
  const code = helpers + diagnostics + source.slice(start, end).replace("export async", "async") + "\nreturn { inventory, buildInventory, run };";
  const { inventory, buildInventory, run } = compileFunction(code, ["assert", "crypto", "fs", "createReadStream", "path", "prefix", "process", "console", "createRequire", "preflight", "fixture", "failure", "removeMatrix"])(
    assert, crypto, fs, createReadStream, path, prefix, state, { log: (value: unknown) => messages.push(value) }, createRequire,
    async () => ({ executable: f.executable, artifact: f.artifact, resourcesSource: f.resources, buildRoot: f.repository, root: f.output,
      mode: outcome === "success" || outcome === "build-success" ? "remove" : "keep", before }),
    async () => {
      if (outcome === "artifact") await fs.writeFile(path.join(f.artifact, "resources/web/index.html"), "changed during failed query", "utf8");
      if (outcome === "build") await fs.writeFile(path.join(f.repository, "apps/desktop/client/dist/index.cjs"), "changed during failed query", "utf8");
      if (outcome === "source") await fs.writeFile(path.join(f.repository, "apps/desktop/client/src/db/migrateClientDb.ts"), "changed migration source", "utf8");
      throw new AggregateError([initial], "INITIAL_CLEANUP_FAILED");
    }, (error: Error) => ({ name: error.name, message: error.message }),
    async () => {
      if (outcome === "build-success") await fs.writeFile(path.join(f.repository, "apps/desktop/dist/main.js"), "changed after successful matrix", "utf8");
    }) as {
      inventory: (directory: string) => Promise<Record<string, string>>;
      buildInventory: (directory: string) => Promise<Record<string, string>>;
      run: (args: string[]) => Promise<{ status: string; buildRoot: string; processIdentityFailure?: unknown; inputsUnchanged?: boolean; failure?: { message: string } }>;
    };
  before = { artifact: await inventory(f.artifact), resources: await inventory(f.resources), build: await buildInventory(f.repository) };
  const result = await run([]);
  assert.equal(state.exitCode, outcome === "success" ? undefined : 1);
  assert.equal(result.status, outcome === "success" ? "passed" : "failed"); assert.equal(messages.length, 1);
  assert.equal(result.buildRoot, f.repository);
  const written = JSON.parse(await fs.readFile(path.join(f.output, "verification.json"), "utf8"));
  assert.equal(written.buildRoot, f.repository);
  if (outcome === "identity" || outcome === "artifact" || outcome === "build" || outcome === "source") assert.deepEqual(written.processIdentityFailure, expected);
  const changed = outcome === "artifact" || outcome === "build" || outcome === "source" || outcome === "build-success";
  assert.equal(result.inputsUnchanged, changed ? undefined : true);
  if (changed) assert.equal(result.failure?.message, prefix + "_INPUT_CHANGED");
});

for (const initial of [undefined, false, 0]) for (const changed of [false, true]) {
  test(`maintenance run preserves falsy rejection ${String(initial)} with build drift ${changed}`, async t => {
    const f = await fixture(t), state: { exitCode?: number } = {};
    let before: unknown, failureInput: unknown;
    const helpers = source.slice(source.indexOf("function contains("), source.indexOf("/** 首次写入前"));
    const diagnostics = source.slice(source.indexOf("function processIdentityFailure("), source.indexOf("/** CIM 未登记"));
    const start = source.indexOf("export async function run("), end = source.indexOf("\nif (process.argv[1]", start);
    const code = helpers + diagnostics + source.slice(start, end).replace("export async", "async") + "\nreturn { inventory, buildInventory, run };";
    const { inventory, buildInventory, run } = compileFunction(code,
      ["assert", "crypto", "fs", "createReadStream", "path", "prefix", "process", "console", "createRequire", "preflight", "fixture", "failure"])(
      assert, crypto, fs, createReadStream, path, prefix, state, { log() {} }, createRequire,
      async () => ({ executable: f.executable, artifact: f.artifact, resourcesSource: f.resources, buildRoot: f.repository,
        root: f.output, mode: "keep", before }),
      async () => {
        if (changed) await fs.writeFile(path.join(f.repository, "apps/desktop/client/dist/index.cjs"), "changed after falsy rejection", "utf8");
        throw initial;
      }, (error: unknown) => {
        failureInput = error;
        return { message: error instanceof Error ? error.message : String(error) };
      }) as {
        inventory: (directory: string) => Promise<Record<string, string>>;
        buildInventory: (directory: string) => Promise<Record<string, string>>;
        run: (args: string[]) => Promise<{ status: string; inputsUnchanged?: boolean; failure?: { message: string } }>;
      };
    before = { artifact: await inventory(f.artifact), resources: await inventory(f.resources), build: await buildInventory(f.repository) };
    const result = await run([]);
    assert.equal(result.status, "failed"); assert.equal(state.exitCode, 1);
    assert.equal(result.inputsUnchanged, changed ? undefined : true);
    if (changed) {
      assert.ok(failureInput instanceof AggregateError);
      assert.equal(failureInput.errors.length, 2); assert.equal(failureInput.errors[0], initial);
      assert.ok(failureInput.errors[1] instanceof assert.AssertionError);
      assert.equal(Object.hasOwn(failureInput, "cause"), true); assert.equal(failureInput.cause, initial);
    } else assert.equal(failureInput, initial);
    const written = JSON.parse(await fs.readFile(path.join(f.output, "verification.json"), "utf8"));
    assert.equal(written.status, "failed");
    assert.equal(written.failure.message, changed ? prefix + "_INPUT_CHANGED" : String(initial));
  });
}

/** 执行三个原进程 owner；仅替换外部 I/O，验证拒绝后的收口与禁止后续副作用。 */
async function rejectedOwner(layer: "launch" | "fixture" | "dataOperation", initial: unknown, secondary: boolean, stage: "discover" | "inspector" = "discover") {
  const actions: string[] = [], reports: Record<string, unknown>[] = [];
  const cleanup = new Error("CONTROLLED_CLEANUP_FAILURE");
  let discoveries = 0, reads = 0, seeds = 0, browserReads = 0, observedFailure: unknown, spawnedCwd: string | undefined;
  const stream = Object.assign(new EventEmitter(), { setEncoding() { return this; }, destroy() {}, end() {},
    on(event: string, listener: (value: string) => void) {
      if (stage === "inspector" && event === "data") listener("Debugger listening on ws://fixture");
      return this;
    } });
  const child = Object.assign(new EventEmitter(), { pid: 10001, stdout: stream, stderr: stream, stdin: stream, unref() {} });
  const owner = { records: new Map(), excluded: new Map(), didClose: false,
    /** 首次模拟业务拒绝，第二次模拟清理快照失败；调用顺序可检索。 */
    async discover() {
      actions.push("discover"); discoveries++;
      if (stage === "discover" && discoveries === 1) throw initial;
      if (stage === "discover" && secondary) throw cleanup;
    } };
  const modules = {
    assert, path, crypto, prefix, repository: "fixture-repository", process: { execPath: "fixture-node" },
    fs: { async mkdir() {}, async writeFile() {} },
    spawn: (_executable: string, _args: string[], options: { cwd: string }) => { spawnedCwd = options.cwd; return child; }, ownership: () => owner,
    waitUntil: async () => {}, inspectorAt: async () => ({
      async call() { actions.push("inspector.call"); throw initial; },
      async close() { actions.push("inspector.close"); if (secondary) throw cleanup; },
    }),
    async stopOwned() { actions.push("stopOwned"); },
    async stopUnregisteredChild() { actions.push("stopUnregisteredChild"); },
    async json(_file: string, value?: Record<string, unknown>) {
      if (arguments.length === 2) { reports.push(value!); return; }
      reads++; return { clientId: "fixture-client", deviceId: "fixture-device", staleOutput: true };
    },
    failure(error: unknown) { observedFailure = error; return { message: String(error) }; },
    processIdentityFailure: () => undefined,
    launchPackagedApp: async () => ({ child, application: {} }),
    inventory: async () => ({}), isolatedEnvironment: async () => ({}),
    persistedBrowserMarkers: async () => { browserReads++; return {}; }, digest: async () => "identity",
    dataOperation: async () => { seeds++; return { keys: [{ hasSecret: true }], configSecretCleared: false, configs: [{}], runtime: [{}], runs: [{}] }; },
    locatorName: "locator", dataProgram: () => "unused",
  };
  const start = source.indexOf(`async function ${layer}(`), next = source.indexOf("\n/**", start);
  assert.ok(start >= 0 && next > start);
  const execute = compileFunction(source.slice(start, next) + `\nreturn ${layer};`, Object.keys(modules))(...Object.values(modules)) as (...args: unknown[]) => Promise<unknown>;
  const paths = { root: "fixture-root", executable: "fixture.exe", mode: "keep", buildRoot: "selected-build" }, context = { root: "fixture-root", profile: "profile", data: "data", buildRoot: "selected-build",
    env: {}, requestId: "fixture-request", mode: "keep", location: { clientId: "client", deviceId: "device" } };
  let threw = false, thrown: unknown;
  try { await execute(...(layer === "launch" ? [paths, context, "failure"] : layer === "fixture" ? [paths, "failure"] : [context, "observe", "failure"])); }
  catch (error) { threw = true; thrown = error; }
  return { actions, reports, cleanup, reads, seeds, browserReads, observedFailure, threw, thrown, spawnedCwd };
}

test("maintenance data operation starts in the selected build package", async () => {
  const result = await rejectedOwner("dataOperation", new Error("controlled-discovery"), false);
  assert.equal(result.spawnedCwd, path.join("selected-build", "apps/desktop/client"));
});

for (const layer of ["launch", "fixture", "dataOperation"] as const) for (const initial of [undefined, false, 0]) for (const secondary of [false, true]) {
  test(`maintenance ${layer} preserves falsy ${String(initial)} and cleanup failure ${secondary}`, async () => {
    const result = await rejectedOwner(layer, initial, secondary);
    assert.equal(result.threw, true);
    assert.deepEqual(result.actions, ["discover", "discover", "stopOwned", "stopUnregisteredChild"]);
    assert.equal(result.reads, 0); assert.equal(result.seeds, 0); assert.equal(result.browserReads, 0);
    if (secondary) {
      assert.ok(result.thrown instanceof AggregateError);
      assert.deepEqual(result.thrown.errors, [initial, result.cleanup]);
      assert.equal(Object.hasOwn(result.thrown, "cause"), true); assert.equal(result.thrown.cause, initial);
    } else assert.equal(result.thrown, initial);
    if (layer === "fixture") assert.equal(result.reports.length, 0);
    else {
      assert.equal(result.reports.length, 1); assert.equal(result.observedFailure, result.thrown);
      if (layer === "launch") assert.equal(result.reports[0]!.status, "failed");
      assert.ok(result.reports[0]!.failure);
    }
  });
}

for (const initial of [undefined, false, 0]) for (const secondary of [false, true]) {
  test(`maintenance launch preserves inspector falsy ${String(initial)} and close failure ${secondary}`, async () => {
    const result = await rejectedOwner("launch", initial, secondary, "inspector");
    assert.equal(result.threw, true);
    assert.deepEqual(result.actions, ["discover", "inspector.call", "inspector.close", "discover", "stopOwned", "stopUnregisteredChild"]);
    if (secondary) {
      assert.ok(result.thrown instanceof AggregateError);
      assert.deepEqual(result.thrown.errors, [initial, result.cleanup]);
      assert.equal(Object.hasOwn(result.thrown, "cause"), true); assert.equal(result.thrown.cause, initial);
    } else assert.equal(result.thrown, initial);
    assert.equal(result.reports.length, 1); assert.equal(result.reports[0]!.status, "failed");
    assert.equal(result.observedFailure, result.thrown);
  });
}
