import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";
import { failure } from "./electron-packaged-protocol.smoke.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const prefix = "DESKTOP_UNINSTALL_MAINTENANCE";
const recordName = "desktop-uninstall-result.json", locatorName = "desktop-data-location.json";
const removeFiles = ["shell-update-attempt.json", "config.json", "codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "codeflowai.db-shm", "codeflowai.db-journal",
  "active-release.json", "previous-release.json", "errors.jsonl", "update-receipts.jsonl", "crash-reports.jsonl", "crash-session.json",
  "crash-session.clean.json", "crash-session.retry.json", "legacy-client-migration-account.json", "legacy-client-migration-journal.json"];
const removeDirectories = ["releases", ".staging", "logs", "legacy-client-migration", "cli-runtime", ".shell-update-file-auth"];
const reappearedContent = "D16_FINAL_AWAIT_REAPPEARED_CONFIG\n";

/** 双向包含也算交叠，所有写入必须独占且在本片证据根内。 */
function contains(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** 拒绝链接祖先，防止证据或输入跨物理根。 */
async function noLinks(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    assert.equal((await fs.lstat(current)).isSymbolicLink(), false, prefix + "_LINK");
    if (path.dirname(current) === current) return;
  }
}

/** 只有 ENOENT 表示缺失，其他 I/O 错误不可降级。 */
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 大工件流式取 SHA256，不读取秘密正文进入报告。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

/** 完整普通文件库存验证源资源和项目逐字节保持。 */
async function inventory(root) {
  await noLinks(root);
  const result = {}, pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name), stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false, prefix + "_LINK");
      if (stat.isDirectory()) pending.push(file);
      else {
        assert.ok(stat.isFile() && stat.nlink === 1, prefix + "_PRIVATE_FILE_REQUIRED");
        result[path.relative(root, file).replaceAll("\\", "/")] = await digest(file);
      }
    }
  }
  return result;
}

/** JSON 严格按 UTF-8 读取；证据文件以 wx 独占落盘。 */
async function json(file, value) {
  if (arguments.length === 2) return await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file)));
}

/** 构建及数据夹具源码共用库存；业务依赖固定在同根，外部工具只绑定入口与包描述。 */
async function buildInventory(buildRoot) {
  await noLinks(buildRoot);
  assert.ok((await fs.lstat(buildRoot)).isDirectory() && buildRoot !== path.parse(buildRoot).root, prefix + "_BUILD_ROOT");
  const result = {};
  for (const [app, names] of [["desktop", ["main.js", "desktopMaintenanceRecord.js", "deviceIdentity.js", "desktopStorageLocation.js"]],
    ["desktop/client", ["index.cjs", "desktopUninstallWorker.cjs"]]]) {
    for (const name of names) {
      const relative = `apps/${app}/dist/${name}`, file = path.join(buildRoot, relative);
      await noLinks(file);
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile() && stat.nlink === 1, prefix + "_PRIVATE_FILE_REQUIRED");
      result[relative] = await digest(file);
    }
  }
  for (const relative of ["apps/desktop/client/src", "packages/shared/src"]) {
    const files = await inventory(path.join(buildRoot, relative));
    for (const [name, sha256] of Object.entries(files)) result[relative + "/" + name] = sha256;
  }
  for (const relative of ["package.json", "tsconfig.base.json", "apps/desktop/client/package.json", "apps/desktop/client/tsconfig.json",
    "packages/shared/package.json", "packages/shared/tsconfig.json", "apps/desktop/client/src/db/clientDb.ts", "apps/desktop/client/src/db/sqliteDb.ts",
    "apps/desktop/client/src/db/migrateClientDb.ts", "apps/desktop/client/src/db/repos/engineKeyRepo.ts", "apps/desktop/client/src/db/repos/scheduledTaskRuntimeStateRepo.ts"]) {
    const file = path.join(buildRoot, relative); await noLinks(file);
    const stat = await fs.lstat(file); assert.ok(stat.isFile() && stat.nlink === 1, prefix + "_PRIVATE_FILE_REQUIRED");
    result[relative] = await digest(file);
  }
  const clientRequire = createRequire(path.join(buildRoot, "apps/desktop/client/package.json"));
  const sharedRoot = await fs.realpath(path.join(buildRoot, "packages/shared"));
  assert.equal(await fs.realpath(path.join(buildRoot, "apps/desktop/client/node_modules/@codeflowai/shared")), sharedRoot, prefix + "_FIXTURE_SHARED_ROOT");
  for (const name of ["@codeflowai/shared", "@codeflowai/shared/node-logger"]) {
    const resolved = await fs.realpath(clientRequire.resolve(name));
    assert.ok(contains(sharedRoot, resolved), prefix + "_FIXTURE_SHARED_ROOT");
  }
  for (const app of ["apps/desktop/client", "packages/shared"]) {
    const from = createRequire(path.join(buildRoot, app, "package.json"));
    for (const name of app === "apps/desktop/client" ? ["pino", "tsx"] : ["pino", "pino-roll"]) {
      const packageRoot = await fs.realpath(path.join(buildRoot, app, "node_modules", name));
      const entry = await fs.realpath(from.resolve(name));
      const manifest = await fs.realpath(from.resolve(name + "/package.json"));
      assert.ok(contains(packageRoot, entry) && contains(packageRoot, manifest), prefix + "_FIXTURE_DEPENDENCY_ROOT");
      for (const [kind, file] of [["entry", entry], ["package", manifest]]) {
        const stat = await fs.lstat(file); assert.ok(stat.isFile(), prefix + "_FIXTURE_DEPENDENCY_FILE");
        result[`dependency/${app}/${name}/${kind}:${file}`] = await digest(file);
      }
    }
  }
  return result;
}

/** 首次写入前以所选构建根严格核壳和 Client/Worker；缺省仍绑定当前仓库。 */
async function preflight(args) {
  assert.equal(process.platform, "win32");
  const usage = "用法：electron-uninstall-maintenance.smoke.mjs <exe> <全新输出root> --evidence-root <现存父根> --resources <资源基线> [--build-root <冻结仓库构建根>] [--mode keep|remove] [--nsis-elevate <helper基线>]";
  assert.ok(args.length >= 6 && args.length % 2 === 0 && args.every(value => typeof value === "string" && value.trim()), usage);
  const options = new Map();
  for (let index = 2; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    assert.ok(["--evidence-root", "--resources", "--build-root", "--mode", "--nsis-elevate"].includes(option)
      && !options.has(option) && !value.startsWith("--"), usage);
    options.set(option, value);
  }
  const mode = options.get("--mode") ?? "keep";
  assert.ok(options.has("--evidence-root") && options.has("--resources") && ["keep", "remove"].includes(mode), usage);
  const requested = path.resolve(args[1]), input = path.resolve(args[0]);
  const requestedEvidence = path.resolve(options.get("--evidence-root")), requestedResources = path.resolve(options.get("--resources"));
  await noLinks(requestedEvidence); await noLinks(requestedResources);
  const evidenceRoot = await fs.realpath(requestedEvidence), resourcesSource = await fs.realpath(requestedResources);
  assert.ok((await fs.stat(evidenceRoot)).isDirectory() && evidenceRoot !== path.parse(evidenceRoot).root, prefix + "_OUTPUT_SCOPE");
  assert.ok(contains(evidenceRoot, requested) && requested !== evidenceRoot, prefix + "_OUTPUT_SCOPE");
  await noLinks(input); await noLinks(path.dirname(requested));
  const executable = await fs.realpath(input), artifact = path.dirname(executable);
  const root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  for (const source of [artifact, resourcesSource, repository]) assert.ok(!contains(source, root) && !contains(root, source), prefix + "_OVERLAP");
  const requestedBuild = path.resolve(options.get("--build-root") ?? repository);
  await noLinks(requestedBuild);
  const buildRoot = await fs.realpath(requestedBuild);
  assert.ok((await fs.lstat(buildRoot)).isDirectory() && buildRoot !== path.parse(buildRoot).root, prefix + "_BUILD_ROOT");
  for (const source of [root, ...(options.has("--build-root") ? [artifact, resourcesSource] : [])]) {
    assert.ok(!contains(source, buildRoot) && !contains(buildRoot, source), prefix + "_OVERLAP");
  }
  assert.ok(!contains(repository, artifact)); assert.equal(await exists(root), false, prefix + "_OUTPUT_EXISTS");
  assert.equal(path.basename(executable).toLowerCase(), "codeflowai.exe");
  const resources = path.join(artifact, "resources"), before = { artifact: await inventory(artifact), resources: await inventory(resourcesSource), build: await buildInventory(buildRoot) };
  const packaged = Object.fromEntries(Object.entries(before.artifact).filter(([key]) => key.startsWith("resources/")).map(([key, value]) => [key.slice(10), value]));
  delete packaged["app.asar"];
  for (const key of Object.keys(packaged).filter(key => key.startsWith("app.asar.unpacked/"))) delete packaged[key];
  let nsisElevate;
  if (options.has("--nsis-elevate")) {
    nsisElevate = path.resolve(options.get("--nsis-elevate")); await noLinks(nsisElevate);
    const stat = await fs.lstat(nsisElevate);
    assert.ok(stat.isFile() && stat.nlink === 1 && path.basename(nsisElevate).toLowerCase() === "elevate.exe", prefix + "_NSIS_HELPER_INVALID");
    assert.ok(!contains(root, nsisElevate) && !contains(artifact, nsisElevate) && !contains(resourcesSource, nsisElevate), prefix + "_NSIS_HELPER_OVERLAP");
    before.nsisElevate = await digest(nsisElevate);
    assert.equal(packaged["elevate.exe"], before.nsisElevate, prefix + "_NSIS_HELPER_MISMATCH");
    assert.equal(before.resources["elevate.exe"], undefined, prefix + "_NSIS_HELPER_OVERLAP");
    delete packaged["elevate.exe"];
  }
  assert.deepEqual(packaged, before.resources, prefix + "_RESOURCES_MISMATCH");
  const require = createRequire(new URL("../package.json", import.meta.url));
  const builder = createRequire(require.resolve("electron-builder"));
  const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar"), sources = {}, hashes = {};
  for (const name of ["main.js", "desktopMaintenanceRecord.js", "deviceIdentity.js", "desktopStorageLocation.js"]) {
    const local = await fs.readFile(path.join(buildRoot, "apps/desktop/dist", name));
    const bundled = asar.extractFile(path.join(resources, "app.asar"), "dist/" + name);
    assert.deepEqual(bundled, local, prefix + "_STALE_ASAR: " + name);
    sources[name] = new TextDecoder("utf-8", { fatal: true }).decode(local);
    hashes[name] = crypto.createHash("sha256").update(local).digest("hex");
    assert.equal(hashes[name], before.build["apps/desktop/dist/" + name], prefix + "_BUILD_INPUT_CHANGED");
  }
  for (const name of ["index.cjs", "desktopUninstallWorker.cjs"]) {
    hashes["client/" + name] = await digest(path.join(resources, "client/dist", name));
    assert.equal(hashes["client/" + name], before.build["apps/desktop/client/dist/" + name], prefix + "_STALE_CLIENT");
  }
  return { executable, artifact, resources, root, sources, hashes, before, mode, evidenceRoot, resourcesSource, buildRoot, nsisElevate };
}

/** 单次真实子进程使用完整创建身份登记，清理只接受本 owner 父链。 */
function ownership(child, query = queryProcesses) {
  const records = new Map(), excluded = new Map(); let didClose = false;
  child.once("close", () => { didClose = true; });
  return { records, excluded, get didClose() { return didClose; },
    /** 整组核验后才发布；不完整候选显式失败并保留父子安全诊断。 */
    async discover() {
      const all = await query(), current = new Map(all.map(item => [item.pid, item])), live = new Map(), pending = new Map();
      assert.equal(current.size, all.length, prefix + "_DUPLICATE_PROCESS");
      for (const [pid, known] of records) if (current.has(pid)) {
        assert.deepEqual(current.get(pid), known, prefix + "_PID_REUSED"); live.set(pid, current.get(pid));
      }
      const root = current.get(child.pid);
      if (!records.has(child.pid) && child.pid && child.exitCode === null && child.signalCode === null) {
        assert.ok(root && child.kill(0), prefix + "_ROOT_HANDLE_NOT_LIVE");
        assert.equal(root.parentPid, process.pid, prefix + "_ROOT_PARENT");
        assert.equal(path.resolve(root.executable).toLowerCase(), path.resolve(child.spawnfile).toLowerCase(), prefix + "_ROOT_EXECUTABLE");
        assert.ok(Date.parse(root.created) > 0 && Date.parse(root.created) <= Date.now(), prefix + "_ROOT_CREATION");
        live.set(root.pid, root); pending.set(root.pid, root);
      }
      let added = true;
      while (added) {
        added = false;
        for (const item of all) if (!live.has(item.pid) && !records.has(item.pid) && live.has(item.parentPid)) {
          const parent = live.get(item.parentPid);
          const created = Date.parse(item.created), parentCreated = Date.parse(parent.created);
          if (!(created > 0 && created <= Date.now())) {
            throw Object.assign(new Error(prefix + "_CHILD_CREATION"), { childIdentity: safeIdentity(item), parentIdentity: safeIdentity(parent), observedAt: new Date().toISOString() });
          }
          if (created < parentCreated) {
            const identity = { child: safeIdentity(item), parent: safeIdentity(parent) };
            excluded.set(JSON.stringify(identity), { reason: "CHILD_PREDATES_CURRENT_PARENT", ...identity }); continue;
          }
          live.set(item.pid, item); pending.set(item.pid, item); added = true;
        }
      }
      for (const item of pending.values()) {
        if (!(item.created && item.executable && item.commandLine)) {
          throw Object.assign(new Error(prefix + "_PROCESS_IDENTITY"), {
            childIdentity: safeIdentity(item), parentIdentity: live.has(item.parentPid) ? safeIdentity(live.get(item.parentPid)) : undefined,
            missingFields: ["created", "executable", "commandLine"].filter(field => !item[field]), observedAt: new Date().toISOString(),
          });
        }
      }
      for (const [pid, item] of pending) records.set(pid, item);
    },
  };
}

/** 未确认进程只记录身份摘要，不保存其命令行正文。 */
function safeIdentity(item) {
  return { pid: item.pid, parentPid: item.parentPid, created: item.created, executable: item.executable,
    commandLineSha256: crypto.createHash("sha256").update(item.commandLine ?? "").digest("hex") };
}

/** 从原异常树保留不完整字段及父子上下文，无关错误不伪造身份诊断。 */
function processIdentityFailure(error) {
  if (error?.childIdentity) return { child: error.childIdentity, parent: error.parentIdentity, observedAt: error.observedAt,
    ...(error.missingFields ? { missingFields: error.missingFields } : {}) };
  if (error instanceof AggregateError) for (const cause of error.errors) {
    const details = processIdentityFailure(cause); if (details) return details;
  }
  return undefined;
}

/** CIM 未登记时仅终止本次 spawn 返回的原 handle；必须观察实际 close，保主副错。 */
async function stopUnregisteredChild(child, records, didClose) {
  if (didClose || records.has(child.pid)) return;
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  if (child.pid && child.exitCode === null && child.signalCode === null) assert.equal(child.kill(), true, prefix + "_HANDLE_TERMINATE_FAILED");
  await bounded(closed, 10_000, prefix + "_HANDLE_CLOSE_TIMEOUT");
}

/** 关闭期不再认领进程；已知PID存在即等待，完整身份冲突明确失败且不终止。 */
async function awaitOwnedDisappearance(records, observed, query = queryProcesses) {
  const pids = [...new Set([...records.keys(), ...observed.map(item => item.pid).filter(Number.isSafeInteger)])];
  await waitUntil(async () => {
    const live = await query(pids);
    for (const item of live) {
      const known = records.get(item.pid);
      if (known && item.created && item.created !== known.created) throw new Error(prefix + "_EXIT_PID_REUSED");
      if (known && item.parentPid !== known.parentPid) throw new Error(prefix + "_EXIT_PARENT_CONFLICT");
      if (known && item.created && item.executable && item.commandLine) assert.deepEqual(item, known, prefix + "_EXIT_IDENTITY_CONFLICT");
    }
    return live.length === 0;
  }, 10_000, prefix + "_PROCESSES_REMAIN");
}

/** 只读残留必须满足本 root 的 OS 创建下界；身份未知仍失败，不认领或终止候选。 */
function lateProcessCandidates(all, records, observed, executable, profile, rootCreated) {
  const normalize = value => path.resolve(value).toLowerCase(), known = new Map(records);
  const rootTime = Date.parse(rootCreated); assert.ok(rootTime > 0 && rootTime <= Date.now(), prefix + "_LATE_ROOT_CREATION");
  for (const item of observed) if (item.pid && !known.has(item.pid)) known.set(item.pid, {});
  const result = new Map();
  for (const item of all) {
    const parent = known.get(item.parentPid), created = Date.parse(item.created);
    if (Number.isFinite(created) && created < rootTime) continue;
    if (parent && (!parent.created || !Number.isFinite(created) || created >= Date.parse(parent.created))) result.set(item.pid, item);
    const tokens = [...(item.commandLine ?? "").matchAll(/(?:^|\s)(?:"--user-data-dir=([^"]*)"|--user-data-dir=(?:"([^"]*)"|([^\s"]+)))(?=\s|$)/gu)];
    if (item.executable && normalize(item.executable) === normalize(executable) && (!Number.isFinite(created) || created >= rootTime)
      && tokens.some(match => normalize(match[1] ?? match[2] ?? match[3]) === normalize(profile))) result.set(item.pid, item);
  }
  let added = true;
  while (added) {
    added = false;
    for (const item of all) if (!result.has(item.pid) && result.has(item.parentPid)) {
      const parent = result.get(item.parentPid), created = Date.parse(item.created), parentCreated = Date.parse(parent.created);
      if (Number.isFinite(created) && created < rootTime) continue;
      if (!Number.isFinite(created) || !Number.isFinite(parentCreated) || created >= parentCreated) { result.set(item.pid, item); added = true; }
    }
  }
  return [...result.values()].map(safeIdentity);
}

/** Inspector 多暂停队列不丢事件；求值和传输失败均阻断测试。 */
async function inspectorAt(url) {
  const socket = new WebSocket(url), pending = new Map(), pauses = [], waiting = [];
  let next = 0, failure, closing = false;
  const fail = error => { failure = error; for (const call of pending.values()) call.reject(error); pending.clear(); for (const call of waiting.splice(0)) call.reject(error); };
  const opened = new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
  socket.addEventListener("message", event => {
    try {
      const message = JSON.parse(event.data);
      if (message.id) {
        const call = pending.get(message.id); assert.ok(call, prefix + "_INSPECTOR_UNKNOWN_REPLY"); pending.delete(message.id);
        message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
      } else if (message.method === "Debugger.paused") {
        if (waiting.length) waiting.shift().resolve(message.params); else pauses.push(message.params);
      }
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", event => fail(event.error ?? new Error(prefix + "_INSPECTOR_ERROR")));
  socket.addEventListener("close", () => { if (!closing) fail(new Error(prefix + "_INSPECTOR_CLOSED")); });
  await bounded(opened, 10_000, prefix + "_INSPECTOR_OPEN_TIMEOUT");
  return {
    /** 每个 RPC 有界，远端 exceptionDetails 必须失败。 */
    async call(method, params = {}) {
      if (failure) throw failure;
      const id = ++next, result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      try {
        socket.send(JSON.stringify({ id, method, params }));
        const response = await bounded(result, 10_000, prefix + "_INSPECTOR_RPC_TIMEOUT");
        assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response;
      } finally { pending.delete(id); }
    },
    /** 支持入口、真实响应和原子写三个暂停边界。 */
    async pause() { if (failure) throw failure; return pauses.length ? pauses.shift() : await bounded(new Promise((resolve, reject) => waiting.push({ resolve, reject })), 90_000, prefix + "_PAUSE_TIMEOUT"); },
    /** 所有 RPC 完成后断开，避免 debugger 阻止进程实际关闭。 */
    async close() { closing = true; assert.equal(pending.size, 0); socket.close(); await bounded(closed, 5_000, prefix + "_INSPECTOR_CLOSE_TIMEOUT"); },
  };
}

/** 隔离profile并观测三个清理边界；参数只记录固定应用origin，不保存任意正文。 */
function instrumentation(context, maintenance, options, observations) {
  return `(() => {
    const {app,dialog,session,ipcMain}=require('electron'),fs=require('node:fs'),promises=require('node:fs/promises');
    const rawArgv=[...process.argv],testArguments=['--inspect-brk=127.0.0.1:0',${JSON.stringify("--user-data-dir=" + context.profile)}];
    if(${maintenance}) {
      for(const argument of testArguments){if(process.argv.filter(item=>item===argument).length!==1)throw new Error('D16_DEBUG_ARG_COUNT');
        process.argv.splice(process.argv.indexOf(argument),1);}
      const expected=[process.execPath,'--codeflow-uninstall-maintenance',${JSON.stringify(context.requestId)},${JSON.stringify(context.mode)}];
      if(JSON.stringify(process.argv)!==JSON.stringify(expected))throw new Error('D16_MAINTENANCE_ARGV_CHANGED');
      app.setPath('userData',${JSON.stringify(context.profile)}); app.setPath('sessionData',${JSON.stringify(context.profile)});
    }
    const value={rawArgv,strippedTestArguments:${maintenance}?testArguments:[],maintenanceArgv:${maintenance}?process.argv:undefined,userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),
      children:[],order:0,phases:[],deletions:[],moves:[],d13Reads:0,databaseOpens:0,clearData:0,clearStorageData:0,clearStorageDataArguments:[],clearAuthCache:0,applicationStarts:0,windows:0,autoEnsure:0,dialogs:[]};
    let sequence=0;
    const save=()=>{const target=${JSON.stringify(observations)}+'/'+String(++sequence).padStart(8,'0')+'.json';
      fs.writeFileSync(target+'.tmp',JSON.stringify(value),{encoding:'utf8',flag:'wx'});fs.renameSync(target+'.tmp',target);};
    globalThis.__keep={value,save,promises};
    if(${maintenance}) {
      const cp=require('node:child_process'),execFile=cp.execFile,adapt=${adaptDebugSnapshot.toString()};
      cp.execFile=(executable,args,options,callback)=>{
        if(typeof callback!=='function')return execFile(executable,args,options,callback);
        return execFile(executable,args,options,(error,stdout,stderr)=>{
          if(error)return callback(error,stdout,stderr);
          try {
            if(Array.isArray(args)&&args.length===4&&args[0]==='-NoProfile'&&args[1]==='-NonInteractive'&&args[2]==='-EncodedCommand') {
              const query=Buffer.from(args[3],'base64').toString('utf16le');
              if(query.includes('$result=@(Get-CimInstance Win32_Process')&&query.includes('ConvertTo-Json -InputObject $result -Compress'))
                stdout=adapt(stdout,{pid:process.pid,parentPid:process.ppid,executable:process.execPath,argv:process.argv,rawArgv},testArguments);
            }
          }catch(cause){value.snapshotAdaptationError={message:cause.message};save();return callback(cause,stdout,stderr);}
          return callback(null,stdout,stderr);
        });
      };
      require('node:module').syncBuiltinESMExports();
    }
    const exit=app.exit.bind(app);app.exit=(code)=>{value.exitRequested={code,order:++value.order};save();return exit(code);};
    const lock=app.requestSingleInstanceLock.bind(app);app.requestSingleInstanceLock=(...args)=>{const acquired=lock(...args);value.lockAcquired=acquired;save();return acquired;};
    dialog.showErrorBox=(title,message)=>{value.dialogs.push({title,message});save();};
    app.on('browser-window-created',()=>{value.windows++;save();});
    const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(name,listener)=>handle(name,async(...args)=>{if(name==='desktop:request'&&args[1]?.method==='engineKeys.builtInRelay.ensure'){value.autoEnsure++;save();}return await listener(...args);});
    if(${Boolean(options.hold)}){const cp=require('node:child_process'),original=cp.spawn,sync=require('node:module').syncBuiltinESMExports;
      const entry=require('node:path').join(process.resourcesPath,'client/dist/desktopUninstallWorker.cjs');
      cp.spawn=(executable,args,options)=>{if(args?.length===1&&args[0]===entry){cp.spawn=original;sync();value.workerInspector=true;save();
        const child=original(executable,['--inspect-brk=127.0.0.1:0',...args],{...options,stdio:['ignore','pipe','pipe','ipc']});
        child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>{value.workerStderr=(value.workerStderr||'')+chunk.toString('utf8');save();process.stderr.write(chunk);});
        return child;}return original(executable,args,options);};sync();}
    require('node:diagnostics_channel').channel('child_process').subscribe(({process:child})=>{
      const item={};value.children.push(item);
      child.on('spawn',()=>{item.pid=child.pid;item.spawnedAt=Date.now();item.args=child.spawnargs;item.spawnOrder=++value.order;
        if(typeof child.send==='function'){const send=child.send.bind(child);child.send=(...args)=>{
          if(args[0]?.schemaVersion===1&&typeof args[0]?.dataDir==='string'){item.request=args[0];save();}return send(...args);};}save();});
      child.on('message',message=>{
        if(message?.schemaVersion===1&&typeof message.ok==='boolean'){item.response={requestId:message.requestId,ok:message.ok,result:message.result,errorCode:message.error?.code};save();
          if(${Boolean(options.hold)}&&message.ok&&message.result?.cleanedKeys!==undefined&&!value.held){value.held=true;save();}}
        if(message?.t==='desktop.ready'){item.ready={pid:child.pid,health:message.health};save();}
      });
      child.on('close',(code,signal)=>{item.close={code,signal};item.closeOrder=++value.order;save();});
    });
    app.whenReady().then(()=>{
      for(const method of ['clearData','clearStorageData','clearAuthCache']){const original=session.defaultSession[method].bind(session.defaultSession);
        session.defaultSession[method]=async(...args)=>{value[method]++;value[method+'Order']=++value.order;
          if(method==='clearStorageData'){const options=args[0],valid=args.length===1&&options!==null&&typeof options==='object'&&!Array.isArray(options)
            &&Reflect.ownKeys(options).length===1&&Object.getOwnPropertyDescriptor(options,'origin')?.value==='codeflow://desktop';
            value.clearStorageDataArguments.push({argumentCount:args.length,optionsValid:valid,...(valid?{origin:'codeflow://desktop'}:{})});}
          save();
          if(method===${JSON.stringify(options.fault)})throw Object.assign(new Error('D16_BROWSER_FAILED'),{code:'D16_BROWSER_FAILED'});
          await original(...args);value[method+'Done']=true;value[method+'DoneOrder']=++value.order;save();};}
    });
    const dataPrefix=${JSON.stringify(context.data + path.sep)},locator=${JSON.stringify(path.join(context.profile, locatorName))};
    const privateTarget=target=>typeof target==='string'&&(target.startsWith(dataPrefix)||target===locator||target.startsWith(locator+'.'));
    const rename=promises.rename;promises.rename=async(...args)=>{const record=args[1]===${JSON.stringify(path.join(context.profile, recordName))};
      const phase=record?JSON.parse(fs.readFileSync(args[0],'utf8')).phase:undefined;await rename(...args);
      if(record){value.phases.push({phase,order:++value.order});save();}
      else if(privateTarget(args[0])){value.moves.push({from:args[0],to:args[1],order:++value.order});save();}};
    const capturePrefix=${JSON.stringify(path.join(context.data, "device-identity.json.removing-" + context.location.deviceId.toLowerCase() + "-"))};
    for(const method of ['unlink','rmdir']){const original=promises[method];promises[method]=async(...args)=>{
      const identity=typeof args[0]==='string'&&args[0].startsWith(capturePrefix)
        &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$/u.test(args[0].slice(capturePrefix.length));
      const locatorCapture=typeof args[0]==='string'&&args[0].startsWith(locator+'.removing-');
      if(method==='unlink'&&((identity&&${JSON.stringify(options.fault)}==='unlink')||(locatorCapture&&${JSON.stringify(options.fault)}==='locator'))){
        value.unlinkInjected=true;save();throw Object.assign(new Error('D16_UNLINK_FAILED'),{code:'D16_UNLINK_FAILED'});}
      await original(...args);
      if(privateTarget(args[0])){value.deletions.push({method,target:args[0],order:++value.order});if(identity)value.identityUnlinkOrder=value.order;save();}
      if(method==='unlink'&&((args[0]===${JSON.stringify(path.join(context.data, "codeflowai.db"))}&&${JSON.stringify(options.fault)}==='database')
        ||(args[0]===${JSON.stringify(path.join(context.data, ".shell-update-file-auth/key"))}&&${JSON.stringify(options.fault)}==='auth-key'))){
        value.afterUnlinkInjected=args[0];save();throw Object.assign(new Error('D16_AFTER_UNLINK_FAILED'),{code:'D16_AFTER_UNLINK_FAILED'});}
    };}
    if(${JSON.stringify(options.fault)}==='final-await'){
      const open=promises.open,record=${JSON.stringify(path.join(context.profile, recordName))};let completedWritten=false,reads=0;
      promises.open=async(...args)=>{const file=await open(...args);
        if(args[0]===record&&completedWritten&&++reads===2){fs.writeFileSync(${JSON.stringify(path.join(context.data, "config.json"))},${JSON.stringify(reappearedContent)},{encoding:'utf8',flag:'wx'});
          value.finalAwaitInjected={reads,order:++value.order};save();}
        if(typeof args[0]!=='string'||!args[0].startsWith(record+'.'))return file;
        return new Proxy(file,{get(target,field){if(field==='writeFile')return async(...values)=>{
          completedWritten=JSON.parse(String(values[0])).phase==='completed';return await target.writeFile(...values);};
          const member=Reflect.get(target,field,target);return typeof member==='function'?member.bind(target):member;}});
      };
    }
    process.on('exit',code=>{value.nodeExit=code;save();});save();return{pid:process.pid,packaged:app.isPackaged};
  })()`;
}

/** 仅适配完整匹配的 self；按 Windows argv 规则删原始区间，不拆空格或改其他进程行。 */
function adaptDebugSnapshot(stdout, identity, testArguments) {
  let rows;
  try { rows = JSON.parse(stdout.replace(/^\uFEFF/u, "")); }
  catch (cause) { throw new Error("D16_DEBUG_SNAPSHOT_INVALID", { cause }); }
  if (!Array.isArray(rows)) throw new Error("D16_DEBUG_SNAPSHOT_INVALID");
  const selves = rows.filter(row => row?.pid === identity.pid);
  if (selves.length !== 1) throw new Error("D16_DEBUG_SELF_AMBIGUOUS");
  const self = selves[0], command = self.commandLine;
  if (self.parentPid !== identity.parentPid || typeof self.executable !== "string" || self.executable.toLowerCase() !== identity.executable.toLowerCase()
    || !Number.isSafeInteger(self.created) || self.created <= 0 || self.created > Date.now()) throw new Error("D16_DEBUG_SELF_IDENTITY");
  if (typeof command !== "string" || !command || command.length > 32768 || command.includes("\0")) throw new Error("D16_DEBUG_NATIVE_ARGUMENT_INVALID");
  const tokens = []; let position = 0;
  while (position < command.length) {
    while (command[position] === " " || command[position] === "\t") position++;
    if (position === command.length) break;
    const start = position; let value = "", quoted = false;
    while (position < command.length) {
      if (!quoted && (command[position] === " " || command[position] === "\t")) break;
      if (command[position] === "\\") {
        const slashStart = position;
        while (command[position] === "\\") position++;
        const count = position - slashStart;
        if (command[position] !== '"') { value += "\\".repeat(count); continue; }
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) { value += '"'; position++; continue; }
      }
      if (command[position] === '"') {
        if (quoted && command[position + 1] === '"') { value += '"'; position += 2; }
        else { quoted = !quoted; position++; }
      } else value += command[position++];
    }
    if (quoted) throw new Error("D16_DEBUG_NATIVE_ARGUMENT_INVALID");
    tokens.push({ value, start, end: position });
  }
  if (tokens[0]?.value.toLowerCase() !== identity.executable.toLowerCase() || tokens.length !== identity.rawArgv.length
    || tokens.slice(1).some((token, index) => token.value !== identity.rawArgv[index + 1])) throw new Error("D16_DEBUG_NATIVE_ARGUMENT_MISMATCH");
  const removed = testArguments.map(argument => {
    const matches = tokens.filter(token => token.value === argument);
    if (matches.length !== 1) throw new Error("D16_DEBUG_NATIVE_ARGUMENT_COUNT");
    return matches[0];
  });
  const remaining = tokens.filter(token => !removed.includes(token)).map(token => token.value);
  if (remaining[0]?.toLowerCase() !== identity.executable.toLowerCase() || remaining.length !== identity.argv.length
    || remaining.slice(1).some((value, index) => value !== identity.argv[index + 1])) throw new Error("D16_DEBUG_NATIVE_ARGUMENT_MISMATCH");
  let stripped = command;
  for (const token of removed.sort((left, right) => right.start - left.start)) stripped = stripped.slice(0, token.start) + stripped.slice(token.end);
  return JSON.stringify(rows.map(row => row === self ? { ...row, commandLine: stripped } : row));
}

/** 观测只读已原子发布的完整文件。 */
async function latest(directory) {
  const files = (await fs.readdir(directory)).filter(name => /^\d{8}\.json$/u.test(name)).sort();
  assert.ok(files.length, prefix + "_OBSERVATION_MISSING"); return await json(path.join(directory, files.at(-1)));
}

/** 只接受当前构建中的唯一精确源码行，避免旧断点假绿。 */
function lineOf(source, fragment) {
  const matches = source.split(/\r?\n/u).flatMap((line, index) => line.includes(fragment) ? [index] : []);
  assert.equal(matches.length, 1, fragment); return matches[0];
}

/** 真实维护/F4 共用观测；线程入口沿包内 pino 解析，任意拒绝均收口进程。 */
async function launch(paths, context, name, options = {}) {
  const root = path.join(context.root, name); await fs.mkdir(root);
  const observations = path.join(root, "observations"); await fs.mkdir(observations);
  const maintenance = !options.ordinary, report = { mode: name, status: "running", stdout: "", stderr: "" };
  const args = maintenance ? ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${context.profile}`, "--codeflow-uninstall-maintenance", context.requestId, context.mode]
    : ["--inspect-brk=127.0.0.1:0", `--user-data-dir=${context.profile}`];
  const child = spawn(paths.executable, args, { env: context.env, cwd: context.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const owner = ownership(child); let didClose = false, inspector, workerInspector, knownError, hasError = false;
  const closed = new Promise(resolve => { child.once("error", error => resolve({ error })); child.once("close", (code, signal) => { didClose = true; resolve({ code, signal }); }); });
  child.stdout.setEncoding("utf8").on("data", chunk => { report.stdout = (report.stdout + chunk).slice(-65_536); });
  child.stderr.setEncoding("utf8").on("data", chunk => { report.stderr = (report.stderr + chunk).slice(-65_536); });
  try {
    await owner.discover();
    await waitUntil(() => { if (didClose) throw new Error(prefix + "_EARLY_EXIT"); return /Debugger listening on (ws:\/\/[^\s]+)/u.test(report.stderr); }, 15_000, prefix + "_ADDRESS_TIMEOUT");
    inspector = await inspectorAt(report.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u)[1]);
    await inspector.call("Runtime.enable"); await inspector.call("Debugger.enable"); await inspector.call("Runtime.runIfWaitingForDebugger");
    assert.equal((await inspector.pause()).reason, "Break on start");
    const observed = await inspector.call("Runtime.evaluate", { expression: instrumentation(context, maintenance, options, observations), includeCommandLineAPI: true, returnByValue: true });
    assert.deepEqual(observed.result.value, { pid: child.pid, packaged: true });
    await inspector.call("Debugger.setBreakpointByUrl", { urlRegex: "[\\\\/]dist[\\\\/]main\\.js$",
      lineNumber: lineOf(paths.sources["main.js"], "application = createDesktopApplication({"),
      condition: "(globalThis.__keep.value.applicationStarts++,globalThis.__keep.save(),false)" });
    for (const [module, fragment, field] of [["main.js", "await readShellHandoffStartup(handoffInput)", "d13Reads"],
      ["desktopStorageLocation.js", "const db = new DatabaseSync(snapshot, { readOnly: true });", "databaseOpens"]]) {
      await inspector.call("Debugger.setBreakpointByUrl", { urlRegex: "[\\\\/]dist[\\\\/]" + module.replace(".", "\\.") + "$",
        lineNumber: lineOf(paths.sources[module], fragment), condition: `(globalThis.__keep.value.${field}++,globalThis.__keep.save(),false)` });
    }
    let breakpoint;
    if (["authorization", "completed"].includes(options.fault)) breakpoint = await inspector.call("Debugger.setBreakpointByUrl", {
      urlRegex: "[\\\\/]dist[\\\\/]desktopMaintenanceRecord\\.js$", lineNumber: lineOf(paths.sources["desktopMaintenanceRecord.js"], "await fs.rename(temporary, target)"),
      condition: `next.phase === ${JSON.stringify(options.fault === "authorization" ? "data_action_authorized" : "completed")}`,
    });
    await owner.discover();
    await inspector.call("Debugger.resume");
    if (options.hold) {
      let workerAddress;
      await waitUntil(async () => {
        const observed = await latest(observations);
        workerAddress = observed.workerStderr?.match(/Debugger listening on (ws:\/\/[^\s]+)/u)?.[1];
        return Boolean(workerAddress);
      }, 90_000, prefix + "_WORKER_INSPECTOR_TIMEOUT");
      await owner.discover();
      workerInspector = await inspectorAt(workerAddress);
      await workerInspector.call("Runtime.enable"); await workerInspector.call("Debugger.enable"); await workerInspector.call("Runtime.runIfWaitingForDebugger");
      assert.equal((await workerInspector.pause()).reason, "Break on start");
      const held = await workerInspector.call("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true,
        expression: `(() => {const originalArguments=[...process.execArgv],testArgument='--inspect-brk=127.0.0.1:0';
          if(originalArguments.filter(value=>value===testArgument).length!==1)throw new Error('D16_WORKER_DEBUG_ARGUMENTS');
          const execArgv=originalArguments.filter(value=>value!==testArgument),module=process.getBuiltinModule('node:worker_threads'),Worker=module.Worker,path=process.getBuiltinModule('node:path');
          const expected=${JSON.stringify(createRequire(createRequire(path.join(paths.resources, "client/dist/desktopUninstallWorker.cjs")).resolve("pino")).resolve("thread-stream/lib/worker.js"))};
          globalThis.__keepThreadInstrumentation={originalArguments,execArgv,target:expected,hits:[]};
          module.Worker=class extends Worker{constructor(filename,options){const actual=filename instanceof URL?process.getBuiltinModule('node:url').fileURLToPath(filename):filename;
            if(typeof actual==='string'&&path.resolve(actual).toLowerCase()===path.resolve(expected).toLowerCase()&&options?.execArgv===undefined){
              globalThis.__keepThreadInstrumentation.hits.push({filename:actual,execArgv,stack:new Error().stack});module.Worker=Worker;process.getBuiltinModule('node:module').syncBuiltinESMExports();
              super(filename,{...options,execArgv});}else super(filename,options);}};
          process.getBuiltinModule('node:module').syncBuiltinESMExports();globalThis.__keepExitHold=setInterval(()=>{},1000);return{pid:process.pid,originalArguments,execArgv};})()` });
      report.workerInstrumentation = held.result.value;
      await workerInspector.call("Debugger.resume");
      await waitUntil(async () => (await latest(observations)).held, 30_000, prefix + "_WORKER_RESPONSE_TIMEOUT");
      await owner.discover();
      report.beforeClose = await latest(observations);
      const lockBefore = await inspector.call("Runtime.evaluate", { expression: "require('electron').app.hasSingleInstanceLock()", includeCommandLineAPI: true, returnByValue: true });
      assert.equal(lockBefore.result.value, true); report.lockBeforeSecond = true;
      const worker = report.beforeClose.children.find(item => item.response?.result?.cleanedKeys !== undefined);
      assert.ok(worker && !worker.close); assert.equal(report.beforeClose.clearData, 0); assert.equal(report.beforeClose.clearStorageData, 0); assert.equal(report.beforeClose.clearAuthCache, 0);
      assert.equal((await json(path.join(context.profile, recordName))).phase, "started");
      assert.equal(await digest(path.join(context.data, "device-identity.json")), context.identityBefore);
      await options.onHeld();
      const lockAfter = await inspector.call("Runtime.evaluate", { expression: "require('electron').app.hasSingleInstanceLock()", includeCommandLineAPI: true, returnByValue: true });
      assert.equal(lockAfter.result.value, true); report.lockAfterSecond = true;
      await owner.discover();
      const released = await workerInspector.call("Runtime.evaluate", { expression: "clearInterval(globalThis.__keepExitHold);delete globalThis.__keepExitHold;globalThis.__keepThreadInstrumentation", returnByValue: true });
      report.workerThreadInstrumentation = released.result.value;
      assert.equal(report.workerThreadInstrumentation.hits.length, 1);
      await workerInspector.close(); workerInspector = undefined;
    }
    if (breakpoint) {
      const paused = await inspector.pause(); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId));
      await inspector.call("Debugger.evaluateOnCallFrame", { callFrameId: paused.callFrames[0].callFrameId, returnByValue: true,
        expression: `(() => { const original=globalThis.__keep.promises.rename,source=temporary,destination=target;
          globalThis.__keep.promises.rename=async(...args)=>{if(args[0]===source&&args[1]===destination){globalThis.__keep.promises.rename=original;
          throw Object.assign(new Error('D16_RECORD_RENAME_FAILED'),{code:'D16_RECORD_RENAME_FAILED'});}return await original(...args);};return true;})()` });
      await inspector.call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId }); await owner.discover(); await inspector.call("Debugger.resume");
    }
    if (options.ordinary) {
      await waitUntil(async () => {
        await owner.discover();
        const result = await inspector.call("Runtime.evaluate", { includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
          expression: `(() => {const window=require('electron').BrowserWindow.getAllWindows()[0];return window?.webContents.getURL().startsWith('codeflow://desktop/')?window.webContents.executeJavaScript('window.codeflowDesktop?.getState()'):null;})()` });
        report.state = result.result.value; return report.state?.status === "ready";
      }, 60_000, prefix + "_READY_TIMEOUT");
      const facts = await inspector.call("Runtime.evaluate", { includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
        expression: `require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(`(async()=>{const config=JSON.parse(localStorage.getItem('config')||'{}');const account=await window.codeflowDesktop.request({method:'runtime.cloudAccount.status'});return{hasToken:Boolean(config.sessionToken),hasOfficeResume:Object.keys(config.officeH5Resume||{}).length>0,account};})()` )})` });
      report.browser = facts.result.value; assert.equal(report.browser.hasToken, false); assert.equal(report.browser.hasOfficeResume, false);
      assert.equal(report.browser.account.status, 200); assert.equal(report.browser.account.body.ok, true);
      assert.equal(report.browser.account.body.account.status, "unlinked");
      await owner.discover();
      await inspector.call("Runtime.evaluate", { includeCommandLineAPI: true, awaitPromise: true,
        expression: "require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('void window.codeflowDesktop.exit()')" });
    }
    if (maintenance) await waitUntil(async () => (await latest(observations)).exitRequested, 90_000, prefix + "_EXIT_REQUEST_TIMEOUT");
    await inspector.close(); inspector = undefined;
    report.exit = await bounded(closed, 60_000, prefix + "_CLOSE_TIMEOUT"); if (report.exit.error) throw report.exit.error;
    assert.deepEqual(report.exit, { code: options.failure ? 1 : 0, signal: null });
    report.observation = await latest(observations);
    assert.equal(report.observation.userData, context.profile); assert.equal(report.observation.sessionData, context.profile);
    if (options.failure) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path.join(context.profile, "logs/desktop-errors.jsonl")));
      report.diagnostic = text.trim().split(/\r?\n/u).map(line => JSON.parse(line)).at(-1);
      assert.equal(report.diagnostic.maintenanceRequestId, context.requestId); assert.equal(report.diagnostic.mode, context.mode);
      assert.ok(report.diagnostic.requestId && report.diagnostic.requestId !== context.requestId);
      const injected = options.locked ? "DESKTOP_UNINSTALL_APP_RUNNING" : ["unlink", "locator"].includes(options.fault) ? "D16_UNLINK_FAILED"
        : ["authorization", "completed"].includes(options.fault) ? "D16_RECORD_RENAME_FAILED"
          : ["database", "auth-key"].includes(options.fault) ? "D16_AFTER_UNLINK_FAILED"
            : options.fault === "final-await" ? "DESKTOP_MAINTENANCE_REMOVE_INCOMPLETE" : "D16_BROWSER_FAILED";
      assert.ok(report.diagnostic.causeCodes.includes(injected), JSON.stringify(report.diagnostic));
    }
    const workers = report.observation.children.filter(item => item.args?.some(arg => arg.endsWith("desktopUninstallWorker.cjs")));
    const clients = report.observation.children.filter(item => item.ready);
    if (!options.ordinary) {
      assert.equal(report.observation.lockAcquired, !options.locked);
      assert.equal(report.observation.applicationStarts, 0); assert.equal(report.observation.windows, 0); assert.deepEqual(clients, []);
      assert.equal(report.observation.autoEnsure, 0);
      assert.equal(workers.length, options.skipWorker ? 0 : 1);
      if (workers.length) {
        assert.equal(workers[0].response.requestId, context.requestId); assert.deepEqual(workers[0].response.result, { cleanedKeys: 1 });
        assert.deepEqual(workers[0].request, { schemaVersion: 1, requestId: context.requestId, dataDir: context.data,
          clientId: context.location.clientId, deviceId: context.location.deviceId });
        assert.deepEqual(workers[0].close, { code: 0, signal: null });
        if (report.observation.clearData) assert.ok(workers[0].closeOrder < report.observation.clearDataOrder, prefix + "_BROWSER_BEFORE_CLOSE");
      }
      if (options.skipWorker) { assert.equal(report.observation.clearData, 0); assert.equal(report.observation.clearStorageData, 0); assert.equal(report.observation.clearAuthCache, 0); }
      else if (!options.locked) {
        assert.equal(report.observation.clearData, 1);
        assert.equal(report.observation.clearStorageData, options.fault === "clearData" ? 0 : 1);
        assert.equal(report.observation.clearAuthCache, ["clearData", "clearStorageData"].includes(options.fault) ? 0 : 1);
      }
      const storageArguments = report.observation.clearStorageDataArguments;
      assert.deepEqual(storageArguments, report.observation.clearStorageData ? [{ argumentCount: 1, optionsValid: true, origin: "codeflow://desktop" }] : []);
      if (report.observation.clearStorageData) {
        assert.equal(report.observation.clearDataDone, true);
        assert.ok(report.observation.clearDataDoneOrder < report.observation.clearStorageDataOrder);
        assert.equal(report.observation.clearStorageDataDone, options.fault === "clearStorageData" ? undefined : true);
      }
      if (report.observation.clearAuthCache) {
        assert.equal(report.observation.clearStorageDataDone, true);
        assert.ok(report.observation.clearStorageDataDoneOrder < report.observation.clearAuthCacheOrder);
      }
      if (["clearData", "clearStorageData", "clearAuthCache"].includes(options.fault)) {
        assert.equal(report.observation.phases.some(item => item.phase === "data_action_authorized" || item.phase === "completed"), false);
        assert.equal(await digest(path.join(context.data, "device-identity.json")), context.identityBefore);
      }
      report.record = await json(path.join(context.profile, recordName));
      assert.equal(report.record.phase, options.phase ?? "completed");
      if (!options.failure) assert.equal(await exists(path.join(context.data, "device-identity.json")), false);
      const authorized = report.observation.phases.find(item => item.phase === "data_action_authorized");
      if (authorized) assert.ok(report.observation.clearAuthCacheDoneOrder < authorized.order);
      if (report.observation.identityUnlinkOrder) {
        const completed = report.observation.phases.find(item => item.phase === "completed");
        if (authorized) assert.ok(authorized.order < report.observation.identityUnlinkOrder);
        if (completed) assert.ok(report.observation.identityUnlinkOrder < completed.order);
      }
      if (options.locked) assert.ok(report.observation.dialogs.some(item => item.message.includes("DESKTOP_UNINSTALL_APP_RUNNING")));
    } else {
      assert.equal(report.observation.applicationStarts, 1); assert.equal(workers.length, 1);
      assert.deepEqual(workers[0].response.result, { rebound: 1, unchanged: 0 });
      assert.deepEqual(workers[0].close, { code: 0, signal: null }); assert.ok(workers[0].closeOrder < clients[0].spawnOrder);
      assert.equal(clients.length, 1); assert.deepEqual(clients[0].close, { code: 0, signal: null });
      assert.equal(report.observation.autoEnsure, 0); assert.equal((await json(path.join(context.profile, recordName))).phase, "consumed");
      const location = await json(path.join(context.profile, locatorName));
      assert.equal(location.clientId, context.location.clientId); assert.equal(location.deviceId, context.completed.nextDeviceId);
    }
    assert.ok(report.observation.children.filter(item => item.pid).every(item => item.close), prefix + "_SPAWNED_CHILD_NOT_CLOSED");
    await awaitOwnedDisappearance(owner.records, report.observation.children);
    report.lateProcesses = lateProcessCandidates(await queryProcesses(), owner.records, report.observation.children,
      paths.executable, context.profile, owner.records.get(child.pid).created);
    assert.deepEqual(report.lateProcesses, [], prefix + "_LATE_PROCESSES_REMAIN");
    if (!options.locked && context.mode === "keep") {
      report.retained = await dataOperation(context, "observe", name + "-data");
      assertRetained(context, report.retained, options.ordinary);
    }
    if (context.mode === "remove") await assertRemoval(context, report, options);
    assert.deepEqual(await inventory(context.project), context.projectBefore, prefix + "_PROJECT_CHANGED");
  } catch (error) { knownError = error; hasError = true; if (didClose) report.exit = await closed; }
  const secondary = [];
  if (workerInspector) { try { await workerInspector.close(); } catch (error) { secondary.push(error); } }
  if (inspector) { try { await inspector.close(); } catch (error) { secondary.push(error); } }
  if (hasError) {
    try { await owner.discover(); } catch (error) { secondary.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { secondary.push(error); }
    try { await stopUnregisteredChild(child, owner.records, didClose); } catch (error) { secondary.push(error); }
  }
  if (secondary.length) {
    knownError = new AggregateError([...(hasError ? [knownError] : []), ...secondary], prefix + "_CLEANUP_FAILED", { cause: hasError ? knownError : secondary[0] });
    hasError = true;
  }
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  report.processes = [...owner.records.values()]; report.excludedProcesses = [...owner.excluded.values()]; report.status = hasError ? "failed" : "passed";
  if (hasError) {
    report.failure = failure(knownError);
    const identityFailure = processIdentityFailure(knownError);
    if (identityFailure) report.processIdentityFailure = identityFailure;
  }
  await json(path.join(root, "verification.json"), report);
  if (hasError) throw knownError;
  return report;
}

/** 初始应用就绪后才落盘夹具；任意启动拒绝先收口，退出成功后才种植维护秘密。 */
async function fixture(paths, name) {
  const root = path.join(paths.root, name); await fs.mkdir(root);
  const context = { root, buildRoot: paths.buildRoot, mode: paths.mode, profile: path.join(root, "profile"), data: path.join(root, "custom"), project: path.join(root, "project"), requestId: crypto.randomUUID() };
  await fs.mkdir(path.join(context.project, ".codeflow"), { recursive: true });
  await fs.writeFile(path.join(context.project, "project.marker"), "D16 keep project\n", { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(context.project, ".codeflow/knowledge.marker"), "D16 keep knowledge\n", { encoding: "utf8", flag: "wx" });
  context.projectBefore = await inventory(context.project);
  context.env = await isolatedEnvironment(path.join(root, "environment"), { CODEFLOWAI_DESKTOP_DATA_DIR: context.data });
  const pids = new Set(); let session, owner, knownError, hasError = false;
  try {
    session = await launchPackagedApp({ executablePath: paths.executable, userDataDir: context.profile, env: context.env, cwd: root, observedPids: pids });
    owner = ownership(session.child); await owner.discover();
    const page = await session.application.firstWindow({ timeout: 60_000 }); await page.waitForURL("codeflow://desktop/**");
    assert.equal((await page.evaluate(() => window.codeflowDesktop.getState())).status, "ready");
    await waitUntil(async () => (await json(path.join(context.profile, locatorName))).clientId !== null, 60_000, prefix + "_INITIAL_LOCATOR_TIMEOUT");
    const fixtureDocument = path.join(path.dirname(paths.executable), "resources/web/robots.txt");
    assert.ok((await fs.lstat(fixtureDocument)).isFile());
    await page.goto("codeflow://desktop/robots.txt");
    assert.equal(await page.evaluate(() => document.body.textContent), (await fs.readFile(fixtureDocument, "utf8")).replaceAll("\r\n", "\n"));
    assert.equal((await page.evaluate(() => window.codeflowDesktop.getState())).status, "ready");
    await page.evaluate(() => {
      const config = JSON.parse(localStorage.getItem("config") || "{}");
      localStorage.setItem("config", JSON.stringify({ ...config, sessionToken: "D16_FIXTURE_TOKEN", sessionExpiresAt: Date.now() + 3600000,
        authMode: "account", userSummary: { userId: "d16-fixture-user" }, officeH5Resume: { wecom: { corpId: "fixture-corp", credential: "D16_FIXTURE_OFFICE", expiresAt: Date.now() + 3600000 } } }));
      if (!JSON.parse(localStorage.getItem("config")).sessionToken) throw new Error("D16_BROWSER_FIXTURE_MISSING");
    });
    await session.application.evaluate(async ({ session }) => { await session.defaultSession.flushStorageData(); });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
    await page.evaluate(() => {
      const config = JSON.parse(localStorage.getItem("config") || "{}");
      if (config.sessionToken !== "D16_FIXTURE_TOKEN" || config.officeH5Resume?.wecom?.credential !== "D16_FIXTURE_OFFICE") {
        throw new Error("D16_BROWSER_FIXTURE_REPLACED_BEFORE_EXIT");
      }
    });
    await owner.discover();
    await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }), page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42000, prefix + "_INITIAL_EXIT_TIMEOUT");
    assert.equal(session.child.exitCode, 0);
    await waitUntil(async () => !(await queryProcesses([...owner.records.keys()])).length, 10000, prefix + "_INITIAL_PROCESSES_REMAIN");
  } catch (error) { knownError = error; hasError = true; }
  if (hasError && owner) {
    const secondary = [];
    try { await owner.discover(); } catch (error) { secondary.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { secondary.push(error); }
    try { await stopUnregisteredChild(session.child, owner.records, owner.didClose); } catch (error) { secondary.push(error); }
    if (secondary.length) knownError = new AggregateError([knownError, ...secondary], prefix + "_INITIAL_CLEANUP_FAILED", { cause: knownError });
  }
  if (session) { session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref(); }
  if (hasError) throw knownError;
  context.browserFixture = { ...await persistedBrowserMarkers(context.profile), document: "codeflow://desktop/robots.txt", flushStorageData: true };
  await json(path.join(context.root, "browser-fixture.json"), context.browserFixture);
  context.location = await json(path.join(context.profile, locatorName));
  context.identityBefore = await digest(path.join(context.data, "device-identity.json"));
  context.dataBefore = await dataOperation(context, "seed", "data-before");
  assert.equal(context.dataBefore.keys.length, 1); assert.equal(context.dataBefore.keys[0].hasSecret, true);
  assert.equal(context.dataBefore.configSecretCleared, false);
  assert.equal(context.dataBefore.configs.length, 1); assert.equal(context.dataBefore.runtime.length, 1); assert.equal(context.dataBefore.runs.length, 1);
  if (context.mode === "remove") await removalFixture(context);
  return context;
}

/** remove 种植固定私有树及默认工作区保留哨兵，不伪造指针或数据库伴随文件。 */
async function removalFixture(context) {
  for (const name of ["releases/remove-sentinel/nested/marker", ".staging/remove-sentinel/nested/marker", "logs/remove-sentinel/marker",
    "errors.jsonl", "update-receipts.jsonl", "cli-runtime/codex/runtime.json"]) {
    const file = path.join(context.data, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "D16 private remove sentinel\n", { encoding: "utf8", flag: "wx" });
  }
  for (const name of [".codeflowai/legacy.marker", ".codeflow/artifacts/output.marker"]) {
    const file = path.join(context.project, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "D16 preserved workspace\n", { encoding: "utf8", flag: "wx" });
  }
  context.projectBefore = await inventory(context.project);
  const protectedRoots = [path.join(context.data, "workspace"), path.join(context.root, "external"), path.join(context.root, "inherited-data"),
    path.join(context.profile, "user-owned"), ...[".codeflowai", ".codex", ".claude", "credential-store"].map(name => path.join(context.env.HOME, name)),
    context.env.CODEX_HOME, context.env.CLAUDE_CONFIG_DIR];
  context.protected = [];
  for (const root of protectedRoots) {
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "preserved.marker"), "D16 external preserved\n", { encoding: "utf8", flag: "wx" });
    context.protected.push({ root, before: await inventory(root) });
  }
  context.env.CODEFLOWAI_DESKTOP_DATA_DIR = path.join(context.root, "inherited-data");
  context.removalRoots = await removalRoots(context);
  context.locatorBefore = await digest(path.join(context.profile, locatorName));
  await json(path.join(context.root, "removal-fixture.json"), { removalRoots: context.removalRoots, locatorSha256: context.locatorBefore,
    identitySha256: context.identityBefore, privateFiles: await inventory(context.data), protected: context.protected });
}

/** 根身份仅取稳定 bigint 字段，不把随内容变化的时间或尺寸当成身份。 */
async function removalRoots(context) {
  const roots = {};
  for (const [name, directory] of [["dataDir", context.data], ["userDataDir", context.profile]]) {
    const stat = await fs.lstat(directory, { bigint: true }); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    roots[name] = Object.fromEntries(["dev", "ino", "birthtimeNs"].map(field => { assert.ok(stat[field] > 0n); return [field, String(stat[field])]; }));
  }
  return roots;
}

/** 删除数据库后只观察文件、捕获及根身份，禁止以 SQL 观察重新创建已删数据。 */
async function assertRemoval(context, report, options) {
  const value = report.observation, record = report.record, roots = await removalRoots(context);
  assert.deepEqual(roots, context.removalRoots); assert.equal(record.mode, "remove");
  assert.equal(record.requestId, context.requestId); assert.equal(record.clientId, context.location.clientId); assert.equal(record.oldDeviceId, context.location.deviceId);
  const dataFiles = await inventory(context.data), dataNames = (await fs.readdir(context.data)).sort();
  const privateNames = dataNames.filter(name => name !== "workspace");
  const locatorFamily = (await fs.readdir(context.profile)).filter(name => name.toLowerCase().startsWith(locatorName)).sort();
  report.files = { dataFiles, dataNames, locatorFamily, removalRoots: roots };
  for (const item of context.protected) assert.deepEqual(await inventory(item.root), item.before, prefix + "_PROTECTED_CHANGED");
  report.protectedUnchanged = true;
  const baseFields = ["schemaVersion", "appId", "requestId", "mode", "phase", "installRoot", "dataDir", "clientId", "oldDeviceId"];
  assert.deepEqual(Object.keys(record).sort(), [...baseFields, ...(record.phase === "data_action_authorized" ? ["authorizedPaths", "removalRoots"] : [])].sort());
  if (record.phase === "data_action_authorized") {
    assert.deepEqual(record.removalRoots, context.removalRoots);
    assert.deepEqual(record.authorizedPaths, [...removeFiles, ...removeDirectories].map(name => "dataDir/" + name).concat("userDataDir/" + locatorName));
  }
  if (options.skipWorker) assert.equal(value.databaseOpens, 0, prefix + "_AUTHORIZED_OPENED_DATABASE");
  assert.equal(value.d13Reads, options.completedReentry ? 0 : 1);
  if (options.completedReentry) {
    assert.deepEqual(value.deletions, []); assert.deepEqual(value.moves, []); assert.deepEqual(value.phases, []);
  }
  const authorized = value.phases.find(item => item.phase === "data_action_authorized"), completed = value.phases.find(item => item.phase === "completed");
  const identityPrefix = path.join(context.data, "device-identity.json"), locator = path.join(context.profile, locatorName);
  const fixedTarget = target => [...removeFiles, ...removeDirectories].some(name => contains(path.join(context.data, name), target));
  const removalTarget = target => fixedTarget(target) || target === identityPrefix || target.startsWith(identityPrefix + ".removing-")
    || target === locator || target.startsWith(locator + ".removing-");
  const deletions = value.deletions.filter(item => removalTarget(item.target)), moves = value.moves.filter(item => removalTarget(item.from));
  report.d13TemporaryOperations = [...value.deletions.filter(item => !deletions.includes(item)), ...value.moves.filter(item => !moves.includes(item))];
  if (authorized) for (const item of [...deletions, ...moves]) assert.ok(authorized.order < item.order, prefix + "_DELETE_BEFORE_AUTHORIZATION");
  for (const item of value.deletions) { assert.notEqual(item.target, identityPrefix); assert.notEqual(item.target, locator); }
  const business = deletions.filter(item => fixedTarget(item.target));
  const auth = business.filter(item => contains(path.join(context.data, ".shell-update-file-auth"), item.target));
  const ordinary = business.filter(item => !auth.includes(item));
  const locatorMoves = value.moves.filter(item => item.from === locator), identityMoves = value.moves.filter(item => item.from === identityPrefix);
  const locatorDeletes = value.deletions.filter(item => item.target.startsWith(locator + ".removing-"));
  const identityDeletes = value.deletions.filter(item => item.target.startsWith(identityPrefix + ".removing-"));
  if (ordinary.length && auth.length) assert.ok(ordinary.at(-1).order < auth[0].order);
  if (business.length && locatorMoves.length) assert.ok(business.at(-1).order < locatorMoves[0].order);
  if (locatorDeletes.length && identityMoves.length) assert.ok(locatorDeletes.at(-1).order < identityMoves[0].order);
  if (identityDeletes.length && completed) assert.ok(identityDeletes.at(-1).order < completed.order);
  if (!options.failure) { assert.deepEqual(privateNames, []); assert.deepEqual(locatorFamily, []); return; }
  const identityNames = dataNames.filter(name => name.toLowerCase().startsWith("device-identity.json"));
  if (["clearStorageData", "authorization", "database", "auth-key", "locator"].includes(options.fault)) {
    assert.deepEqual(identityNames, ["device-identity.json"]); assert.equal(await digest(identityPrefix), context.identityBefore);
  }
  if (["clearStorageData", "authorization", "database", "auth-key"].includes(options.fault)) {
    assert.deepEqual(locatorFamily, [locatorName]); assert.equal(await digest(locator), context.locatorBefore);
  }
  if (["clearStorageData", "authorization"].includes(options.fault)) {
    assert.deepEqual(deletions, []); assert.deepEqual(moves, []); assert.ok(await exists(path.join(context.data, "codeflowai.db")));
    report.retained = await dataOperation(context, "observe", options.fault + "-failed-data"); assertRetained(context, report.retained, false);
  }
  if (options.fault === "database") { assert.equal(await exists(path.join(context.data, "codeflowai.db")), false); assert.equal(value.afterUnlinkInjected, path.join(context.data, "codeflowai.db")); }
  if (options.fault === "auth-key") {
    assert.deepEqual(privateNames, [".shell-update-file-auth", "device-identity.json"]); assert.deepEqual(await fs.readdir(path.join(context.data, ".shell-update-file-auth")), []);
    assert.equal(value.afterUnlinkInjected, path.join(context.data, ".shell-update-file-auth/key"));
  }
  if (options.fault === "locator") {
    assert.deepEqual(privateNames, ["device-identity.json"]); assert.equal(locatorFamily.length, 1);
    const capturePrefix = locatorName + ".removing-" + crypto.createHash("sha256").update(context.requestId).digest("hex") + "-";
    assert.ok(locatorFamily[0].startsWith(capturePrefix)); assert.equal(await digest(path.join(context.profile, locatorFamily[0])), context.locatorBefore);
  }
  if (options.fault === "unlink") {
    assert.deepEqual(locatorFamily, []); assert.equal(privateNames.length, 1); assert.equal(identityNames.length, 1);
    assert.ok(identityNames[0].startsWith("device-identity.json.removing-" + context.location.deviceId.toLowerCase() + "-"));
    assert.equal(await digest(path.join(context.data, identityNames[0])), context.identityBefore);
  }
  if (options.fault === "completed") { assert.deepEqual(privateNames, []); assert.deepEqual(locatorFamily, []); }
  if (options.fault === "final-await") {
    assert.deepEqual(privateNames, ["config.json"]); assert.deepEqual(locatorFamily, []); assert.equal(value.finalAwaitInjected.reads, 2);
    assert.equal(await fs.readFile(path.join(context.data, "config.json"), "utf8"), reappearedContent);
    assert.equal(completed, undefined); report.reappearedContentPreserved = true;
  }
}

/** 退出后只读 Chromium LevelDB，确认两种存储编码下 fixture 确实持久化；不输出正文。 */
async function persistedBrowserMarkers(profile) {
  const directory = path.join(profile, "Local Storage/leveldb"); await noLinks(directory);
  const found = { sessionToken: false, officeH5Resume: false };
  for (const name of await fs.readdir(directory)) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    assert.ok(!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1, prefix + "_BROWSER_STORAGE_FILE");
    if (!/\.(?:ldb|log)$/u.test(name)) continue;
    const bytes = await fs.readFile(file);
    for (const [key, marker] of [["sessionToken", "D16_FIXTURE_TOKEN"], ["officeH5Resume", "D16_FIXTURE_OFFICE"]]) {
      found[key] ||= ["utf8", "utf16le"].some(encoding => bytes.includes(Buffer.from(marker, encoding)));
    }
  }
  assert.deepEqual(found, { sessionToken: true, officeH5Resume: true }, prefix + "_BROWSER_FIXTURE_NOT_PERSISTED");
  return found;
}

/** 仅消费所选冻结源码；任何数据写入前核 schema，准备与观察均保原 schema。 */
function dataProgram(buildRoot) {
  assert.ok(typeof buildRoot === "string" && buildRoot.trim(), prefix + "_FIXTURE_BUILD_ROOT_REQUIRED");
  return `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const input=JSON.parse(process.argv[2]);
    const {openClientDb}=await import(${JSON.stringify(pathToFileURL(path.join(buildRoot, "apps/desktop/client/src/db/clientDb.ts")).href)});
    const {openSqliteDb}=await import(${JSON.stringify(pathToFileURL(path.join(buildRoot, "apps/desktop/client/src/db/sqliteDb.ts")).href)});
    const {CLIENT_DB_SCHEMA_VERSION}=await import(${JSON.stringify(pathToFileURL(path.join(buildRoot, "apps/desktop/client/src/db/migrateClientDb.ts")).href)});
    const {EngineKeyRepo}=await import(${JSON.stringify(pathToFileURL(path.join(buildRoot, "apps/desktop/client/src/db/repos/engineKeyRepo.ts")).href)});
    const {scheduledTaskRuntimeKey}=await import(${JSON.stringify(pathToFileURL(path.join(buildRoot, "apps/desktop/client/src/db/repos/scheduledTaskRuntimeStateRepo.ts")).href)});
    /** 主操作和关闭均失败时保留两个原因。 */
    function using(db,operation){let failed=false,primary;try{return operation(db);}catch(error){failed=true;primary=error;throw error;}
      finally{try{db.close();}catch(error){throw failed?new AggregateError([primary,error],'D16_DATA_CLOSE_FAILED'):error;}}}
    const configFile=path.join(input.data,'config.json'),dbFile=path.join(input.data,'codeflowai.db');
    const originalSchema=using(new DatabaseSync(dbFile,{readOnly:true}),db=>db.prepare('PRAGMA user_version').get().user_version);
    assert.equal(originalSchema,CLIENT_DB_SCHEMA_VERSION,'D16_FIXTURE_SCHEMA_MISMATCH');
    if(input.action==='seed'){
      const config=JSON.parse(fs.readFileSync(configFile,'utf8'));assert.equal(config.clientId,input.clientId);
      fs.writeFileSync(configFile,JSON.stringify({...config,apiKey:'D16_FIXTURE_CONFIG_SECRET'})+'\\n','utf8');
      using(openClientDb({dbPath:dbFile,existingOnly:true}),db=>{
        assert.equal(db.db.prepare("SELECT value FROM meta WHERE key='client_id'").get().value,input.clientId);
        assert.deepEqual(db.engineKeys.list(),[]);
        db.engineKeys.insert({label:'D16 fixture',engine:'codex',providerId:'openai',apiKey:'D16_FIXTURE_KEY_SECRET',baseUrl:'https://fixture.invalid/v1'});
        db.withLocalScheduledTasks(null,repos=>{
          const id='d16-keep-disabled',at=1000;
          repos.configs.create({config:{id,source:'local',clientId:input.clientId,deviceId:input.deviceId,workspaceScope:null,
            name:'D16 retained task',description:'Only device ownership may change',taskType:'script',cronExpr:'0 0 1 1 *',timezone:'UTC',enabled:true,
            payload:{shell:'sh',command:'echo forbidden-smoke-execution'},concurrencyPolicy:'queue_one',missedPolicy:'skip_missed',timeoutMs:1000},at});
          repos.runs.create({expectedConfigRevision:1,run:{id:'history-'+id,taskId:id,clientId:input.clientId,deviceId:input.deviceId,
            workspaceId:null,workflowInstanceId:null,workflowNameSnapshot:null,workflowVersion:null,scheduledAt:at,startedAt:null,finishedAt:at,
            status:'skipped',triggerSource:'schedule',attempt:1,durationMs:null,summary:'old immutable run',errorMessage:null,outputExcerpt:null,createdAt:at}});
          repos.configs.setEnabled({taskId:id,expectedRevision:1,enabled:false,at:at+1});
          repos.runtime.markStarted({taskId:scheduledTaskRuntimeKey(id,'local'),clientId:input.clientId,deviceId:input.deviceId,scheduledAt:at+2,runId:'old-running-'+id,startedAt:at+3});
          repos.runtime.queueLocalConcurrency({taskId:id,clientId:input.clientId,deviceId:input.deviceId,runId:'old-running-'+id,scheduledAt:at+4,at:at+5});
        });
      });
    }
    const config=JSON.parse(fs.readFileSync(configFile,'utf8')),{apiKey,...retainedConfig}=config;
    const snapshot=using(openSqliteDb(dbFile,{readonly:true,fileMustExist:true}),db=>{
      const dbSchemaVersion=db.pragma('user_version',{simple:true});assert.equal(dbSchemaVersion,originalSchema,'D16_FIXTURE_SCHEMA_CHANGED');
      const repo=new EngineKeyRepo(db),keys=repo.list();
      assert.ok(keys.every(key=>key.source==='user_configured'&&key.secretRef===null),'D16_NO_KEYRING_REQUIRED');
      return{dbSchemaVersion,clientId:db.prepare("SELECT value FROM meta WHERE key='client_id'").get().value,config:retainedConfig,configSecretCleared:apiKey==='',
        keys:keys.map(({apiKey,...key})=>({...key,hasSecret:apiKey!=='',nativeFallbackBlocked:repo.isNativeFallbackBlocked(key.engine,key.providerId)})),
        configs:db.prepare('SELECT * FROM scheduled_task_configs ORDER BY id').all(),runtime:db.prepare('SELECT * FROM scheduled_task_runtime_states ORDER BY task_id').all(),
        runs:db.prepare('SELECT * FROM scheduled_task_runs ORDER BY id').all()};
    });
    fs.writeFileSync(input.output,JSON.stringify(snapshot,null,2)+'\\n',{encoding:'utf8',flag:'wx'});`;
}

/** 隔离 env 在 import 前建立；任意拒绝先收口原 owner，失败后不读取输出。 */
async function dataOperation(context, action, name) {
  assert.ok(typeof context.buildRoot === "string" && context.buildRoot.trim(), prefix + "_FIXTURE_BUILD_ROOT_REQUIRED");
  const output = path.join(context.root, name + ".json");
  const input = { action, output, data: context.data, clientId: context.location.clientId, deviceId: context.location.deviceId };
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-", JSON.stringify(input)], {
    cwd: path.join(context.buildRoot, "apps/desktop/client"), env: { ...context.env, CODEFLOWAI_CLIENT_LOG_DIR: path.join(context.root, "fixture-logs") },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const owner = ownership(child), result = { action, stdout: "", stderr: "" }; let didClose = false;
  const closed = new Promise(resolve => { child.once("error", error => resolve({ error })); child.once("close", (code, signal) => { didClose = true; resolve({ code, signal }); }); });
  child.stdout.setEncoding("utf8").on("data", chunk => { result.stdout = (result.stdout + chunk).slice(-65_536); });
  child.stderr.setEncoding("utf8").on("data", chunk => { result.stderr = (result.stderr + chunk).slice(-65_536); });
  let knownError, hasError = false;
  try { await owner.discover(); child.stdin.end(dataProgram(context.buildRoot)); result.exit = await bounded(closed, 60000, prefix + "_FIXTURE_TIMEOUT"); if (result.exit.error) throw result.exit.error; assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr); }
  catch (error) { knownError = error; hasError = true; }
  if (hasError) {
    const secondary = [];
    try { await owner.discover(); } catch (error) { secondary.push(error); }
    try { await stopOwned([...owner.records.values()]); } catch (error) { secondary.push(error); }
    try { await stopUnregisteredChild(child, owner.records, didClose); } catch (error) { secondary.push(error); }
    if (secondary.length) knownError = new AggregateError([knownError, ...secondary], prefix + "_FIXTURE_CLEANUP_FAILED", { cause: knownError });
  }
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  if (hasError) result.failure = failure(knownError); await json(path.join(context.root, name + "-process.json"), result);
  if (hasError) throw knownError;
  return await json(output);
}

/** 清秘密不改配置与旧历史；F4 仅将现有任务和 runtime 归属改为授权设备。 */
function assertRetained(context, actual, ordinary) {
  const before = context.dataBefore, nextDeviceId = ordinary ? context.completed.nextDeviceId : context.location.deviceId;
  assert.equal(actual.clientId, context.location.clientId); assert.deepEqual(actual.config, before.config); assert.equal(actual.configSecretCleared, true);
  assert.deepEqual(actual.keys, before.keys.map(key => ({ ...key, hasSecret: false, isActive: false, nativeFallbackBlocked: true })));
  assert.deepEqual(actual.configs, before.configs.map(row => ({ ...row, device_id: nextDeviceId })));
  assert.deepEqual(actual.runtime, before.runtime.map(row => ({ ...row, device_id: nextDeviceId })));
  assert.deepEqual(actual.runs, before.runs);
}

/** 每组独占状态快照保留已通过场景，主报告仍在结束时一次写入。 */
async function checkpoint(paths, report, group) {
  await json(path.join(paths.root, "status-" + String(report.scenarios.length).padStart(2, "0") + ".json"), {
    status: "running", mode: paths.mode, group, passed: report.scenarios.length,
    scenarios: report.scenarios.map(item => ({ mode: item.mode, status: item.status, exit: item.exit })),
  });
}

/** remove复用原故障/重试入口；浏览器失败保started，授权后不重开DB。 */
async function removeMatrix(paths, report) {
  const success = await fixture(paths, "success");
  report.scenarios.push(await launch(paths, success, "maintenance"));
  report.scenarios.push(await launch(paths, success, "completed-reentry", { skipWorker: true, completedReentry: true }));
  await checkpoint(paths, report, "success-and-completed-reentry");
  for (const fault of ["clearStorageData", "authorization", "database", "auth-key", "locator", "unlink", "completed", "final-await"]) {
    const context = await fixture(paths, "fault-" + fault), phase = ["clearStorageData", "authorization"].includes(fault) ? "started" : "data_action_authorized";
    report.scenarios.push(await launch(paths, context, "failed", { fault, failure: true, phase }));
    if (fault !== "final-await") report.scenarios.push(await launch(paths, context, "retry", { skipWorker: phase === "data_action_authorized" }));
    await checkpoint(paths, report, "fault-" + fault);
  }
}

/** keep/remove 共用严格库存；任意拒绝值都失败，复核异常保留原首因与身份诊断。 */
export async function run(args) {
  const paths = await preflight(args), before = paths.before;
  await fs.mkdir(paths.root);
  const report = { status: "running", mode: paths.mode, requestId: crypto.randomUUID(), executable: paths.executable,
    evidenceRoot: paths.evidenceRoot, resourcesSource: paths.resourcesSource, buildRoot: paths.buildRoot,
    nsisElevate: paths.nsisElevate, hashes: paths.hashes, sourceBefore: before, scenarios: [] };
  let knownError, hasError = false;
  try {
    if (paths.mode === "remove") await removeMatrix(paths, report);
    else {
    const success = await fixture(paths, "success");
    report.scenarios.push(await launch(paths, success, "maintenance", { hold: true, onHeld: async () => {
      report.scenarios.push(await launch(paths, success, "locked-denied", { failure: true, locked: true, skipWorker: true, phase: "started" }));
    } }));
    success.completed = await json(path.join(success.profile, recordName));
    report.scenarios.push(await launch(paths, success, "completed-reentry", { skipWorker: true }));
    report.scenarios.push(await launch(paths, success, "ordinary-f4", { ordinary: true }));
    await checkpoint(paths, report, "keep-success-lock-reentry-f4");
    for (const fault of ["clearData", "clearStorageData", "clearAuthCache", "authorization", "unlink", "completed"]) {
      const context = await fixture(paths, "fault-" + fault), phase = ["unlink", "completed"].includes(fault) ? "data_action_authorized" : "started";
      report.scenarios.push(await launch(paths, context, "failed", { fault, failure: true, phase }));
      const failed = await json(path.join(context.profile, recordName));
      if (fault === "unlink") {
        assert.equal(await exists(path.join(context.data, "device-identity.json")), false);
        const captures = (await fs.readdir(context.data)).filter(file => file.startsWith("device-identity.json.") && file.endsWith(".tmp"));
        assert.equal(captures.length, 1);
        assert.equal(await digest(path.join(context.data, captures[0])), context.identityBefore);
      } else if (fault !== "completed") assert.equal(await digest(path.join(context.data, "device-identity.json")), context.identityBefore);
      else assert.equal(await exists(path.join(context.data, "device-identity.json")), false);
      report.scenarios.push(await launch(paths, context, "retry", { skipWorker: phase === "data_action_authorized" }));
      const completed = await json(path.join(context.profile, recordName));
      if (failed.nextDeviceId) assert.equal(completed.nextDeviceId, failed.nextDeviceId);
      await checkpoint(paths, report, "fault-" + fault);
    }
    }
  } catch (error) { knownError = error; hasError = true; }
  try {
    report.sourceAfter = { artifact: await inventory(paths.artifact), resources: await inventory(paths.resourcesSource), build: await buildInventory(paths.buildRoot),
      ...(paths.nsisElevate ? { nsisElevate: await digest(paths.nsisElevate) } : {}) };
    assert.deepEqual(report.sourceAfter, before); report.inputsUnchanged = true;
  }
  catch (error) {
    knownError = new AggregateError([...(hasError ? [knownError] : []), error], prefix + "_INPUT_CHANGED", { cause: hasError ? knownError : error });
    hasError = true;
  }
  report.status = hasError ? "failed" : "passed";
  if (hasError) {
    report.failure = failure(knownError);
    const identityFailure = processIdentityFailure(knownError);
    if (identityFailure) report.processIdentityFailure = identityFailure;
  }
  await json(path.join(paths.root, "verification.json"), report);
  console.log(JSON.stringify({ code: prefix, status: report.status, report: path.join(paths.root, "verification.json") }));
  if (hasError) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(process.argv.slice(2)); } catch (error) { console.error(JSON.stringify({ code: prefix, status: "failed", failure: failure(error) })); process.exitCode = 1; }
}
