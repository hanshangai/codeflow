import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { readReleaseBundleFiles, verifyReleaseBundleSignature, computeReleaseDirectorySha256,
  computeReleasePackageSha256 } from "@codeflowai/shared/desktop-release-signing";
import { failure } from "./electron-packaged-protocol.smoke.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";
import { bounded } from "./support/packaged-app.mjs";

const prefix = "DESKTOP_CANDIDATE_HEALTH_SMOKE";
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

/** 输入、输出任一方向重叠均拒绝，先于创建任何目录。 */
function separate(left, right) {
  const outside = (parent, target) => { const relative = path.relative(parent, target); return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative); };
  assert.ok(outside(left, right) && outside(right, left), prefix + "_PATH_OVERLAP");
}

/** 第三参只接受完整展开签名包，使用原签名和库存入口核验，不重造归档。 */
async function preflight(args) {
  assert.equal(process.platform, "win32");
  assert.ok(args.length === 4 && args.every(value => typeof value === "string" && value.trim()),
    "用法：electron-candidate-shell-health.smoke.mjs <候选exe> <基线resources> <展开签名包目录> <新输出目录>");
  const [input, baselineInput, bundleInput, output] = args;
  const executable = await fs.realpath(path.resolve(input)), artifact = path.dirname(executable);
  const baseline = await fs.realpath(path.resolve(baselineInput)), bundle = await fs.realpath(path.resolve(bundleInput));
  const requested = path.resolve(output), root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  assert.equal(path.basename(executable).toLowerCase(), "codeflowai.exe");
  for (const source of [artifact, baseline, bundle]) { separate(source, root); separate(source, requested); separate(await fs.realpath(repository), source); }
  separate(await fs.realpath(repository), root); separate(repository, requested);
  let exists = true;
  try { await fs.lstat(root); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  assert.equal(exists, false, prefix + "_OUTPUT_EXISTS");
  for (const file of [executable, path.join(artifact, "resources/app.asar"), path.join(artifact, "resources/release-trust.json"),
    ...["client/dist/index.cjs", "web/index.html", "release-trust.json"].map(name => path.join(baseline, name))]) {
    assert.equal((await fs.lstat(file)).isFile(), true);
  }
  const entries = (await fs.readdir(bundle)).sort(); assert.deepEqual(entries, ["client", "manifest.json", "web"]);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path.join(bundle, "manifest.json"))));
  const trust = JSON.parse(await fs.readFile(path.join(artifact, "resources/release-trust.json"), "utf8"));
  verifyReleaseBundleSignature(manifest, trust); assert.equal(manifest.platform, "win32"); assert.equal(manifest.arch, "x64");
  const files = await readReleaseBundleFiles(bundle); assert.deepEqual(files, manifest.files);
  const web = computeReleaseDirectorySha256(files, "web"), client = computeReleaseDirectorySha256(files, "client");
  assert.equal(web, manifest.webSha256); assert.equal(client, manifest.clientSha256);
  assert.equal(computeReleasePackageSha256(web, client), manifest.packageSha256);
  return { executable, artifact, baseline, bundle, root, manifest };
}

/** 流式完整库存只接受普通文件，不以关键文件摘要代替载荷保护。 */
async function inventory(roots) {
  const result = {};
  for (const [label, root] of Object.entries(roots)) {
    const directories = [root];
    while (directories.length) {
      const current = directories.pop();
      for (const item of await fs.readdir(current, { withFileTypes: true })) {
        assert.equal(item.isSymbolicLink(), false, prefix + "_REPARSE_REJECTED");
        const file = path.join(current, item.name);
        if (item.isDirectory()) directories.push(file);
        else {
          assert.equal(item.isFile(), true);
          const hash = crypto.createHash("sha256");
          for await (const chunk of createReadStream(file)) hash.update(chunk);
          result[label + "/" + path.relative(root, file).replaceAll("\\", "/")] = hash.digest("hex");
        }
      }
    }
  }
  return result;
}

/** 操作和关闭均失败时保留两份根因，不以 finally 覆盖业务错误。 */
function withDatabase(file, options, operation) {
  const db = new DatabaseSync(file, options);
  let failure, result;
  try { result = operation(db); } catch (error) { failure = error; }
  try { db.close(); } catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], prefix + "_DB_CLOSE_FAILED"); }
  if (failure) throw failure;
  return result;
}

/** 源数据库只作为不可触碰的合成任务哨兵，不作为候选健康数据库。 */
async function makeSourceData(paths) {
  const directory = path.join(paths.root, "source-data"); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ apiKey: "source-fixture-must-not-be-used", serverWs: "ws://127.0.0.1:1", clientId: "source-sentinel-client" }) + "\n", { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: SOURCE_DEVICE_ID, createdAt: "2026-10-27T00:00:00.000Z" }) + "\n", { encoding: "utf8", flag: "wx" });
  withDatabase(path.join(directory, "codeflowai.db"), {}, db => {
    db.exec("PRAGMA user_version=92; CREATE TABLE scheduled_task_configs(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, payload_json TEXT NOT NULL); CREATE TABLE sentinel(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO scheduled_task_configs VALUES(?, ?, ?)").run("must-not-run", 1, JSON.stringify({ command: "must-never-execute-source-task" }));
    db.prepare("INSERT INTO sentinel VALUES(?, ?)").run("source", crypto.randomUUID());
  });
  const releaseDir = path.join(directory, "releases", paths.manifest.releaseId);
  await fs.mkdir(releaseDir, { recursive: true });
  for (const name of ["client", "web"]) await fs.cp(path.join(paths.bundle, name), path.join(releaseDir, name), { recursive: true, errorOnExist: true, force: false });
  await fs.copyFile(path.join(paths.bundle, "manifest.json"), path.join(releaseDir, "manifest.json"));
  for (const name of ["active-release.json", "previous-release.json"]) {
    await fs.writeFile(path.join(directory, name), JSON.stringify({ releaseId: paths.manifest.releaseId }) + "\n", { encoding: "utf8", flag: "wx" });
  }
  return { directory, releaseDir };
}

/** 所有候选进程必须属于当前全新工件根，运行后不允许残留。 */
async function assertNoProcesses(root) {
  const all = await queryProcesses();
  const matches = all.filter(item => item.executable && path.relative(root, item.executable).split(path.sep)[0] !== ".." && !path.isAbsolute(path.relative(root, item.executable)));
  if (!matches.length) return;
  const error = Object.assign(new Error(prefix + "_OWNED_PROCESS_REMAINED"), { processes: matches });
  const owned = matches.filter(item => item.parentPid === process.pid || matches.some(parent => parent.pid === item.parentPid));
  if (owned.length !== matches.length) throw new AggregateError([error, new Error(prefix + "_PROCESS_OWNERSHIP_UNKNOWN")], prefix + "_CLEANUP_BLOCKED");
  try { await stopOwned(matches); } catch (cleanup) { throw new AggregateError([error, cleanup], prefix + "_OWNED_PROCESS_CLEANUP_FAILED"); }
  throw error;
}

/** 只接受错误链中的精确领域原因，不按关键词把任意拒绝当预期结果。 */
function hasMessage(error, message) {
  return error?.message === message || (error?.cause && hasMessage(error.cause, message))
    || (error instanceof AggregateError && error.errors.some(item => hasMessage(item, message)));
}

/** 实际父 runner 启动候选 main；输入库存、源任务和退出全部属于验收。 */
export async function run(args) {
  const paths = await preflight(args), inputRoots = { artifact: paths.artifact, baseline: paths.baseline, bundle: paths.bundle };
  const before = await inventory(inputRoots);
  await fs.mkdir(paths.root);
  const report = { status: "running", requestId: crypto.randomUUID(), root: paths.root, sourceBefore: before, scenarios: [],
    boundary: "current candidate Desktop/shared with frozen real Client/Web/native; synthetic source-task sentinel; unsigned local Windows package; no installation or activation" };
  let knownError;
  try {
    const installation = path.join(paths.root, "installation"), candidate = path.join(installation, "shells/candidate");
    const baseline = path.join(installation, "shells/baseline");
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.cp(paths.artifact, candidate, { recursive: true, errorOnExist: true, force: false });
    await fs.mkdir(baseline); await fs.copyFile(paths.executable, path.join(baseline, "CodeFlowAI.exe"));
    await fs.cp(paths.baseline, path.join(baseline, "resources"), { recursive: true, errorOnExist: true, force: false });
    const statePath = path.join(installation, "shell-launch.ini");
    await fs.writeFile(statePath, "[shell]\r\nschema=1\r\nactive=baseline\r\nprevious=\r\nbaseline=baseline\r\n", { encoding: "ascii", flag: "wx" });
    const source = await makeSourceData(paths), temporaryParentDir = path.join(paths.root, "health-runs"); await fs.mkdir(temporaryParentDir);
    const context = { ...paths, installation, candidate, baseline, source, temporaryParentDir };
    const module = await import("../src/candidateShellHealth.ts");
    report.scenarios.push(await scenario(context, module.runCandidateShellHealth, "healthy"));
    for (const mode of ["signature", "web", "native", "ready", "exit"]) report.scenarios.push(await scenario(context, module.runCandidateShellHealth, mode));
    report.malformedRequest = await malformedScenario(context, module.createCandidateShellHealthEnvironment);
    report.invalidEnvironment = await malformedScenario(context, module.createCandidateShellHealthEnvironment, "environment");
    await assertNoProcesses(paths.root);
  } catch (error) { knownError = error; }
  try { await assertNoProcesses(paths.root); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_PROCESS_CHECK_FAILED"); }
  try { report.sourceAfter = await inventory(inputRoots); assert.deepEqual(report.sourceAfter, before, prefix + "_INPUT_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_INPUT_CHECK_FAILED"); }
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(paths.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ code: prefix, status: report.status, report: path.join(paths.root, "verification.json") }));
  if (knownError) process.exitCode = 1;
  return report;
}

/** 每次检查保护同一源状态；故意坏签名必须显式拒绝且不改原数据。 */
async function scenario(paths, runner, mode) {
  const pristine = await inventory({ source: paths.source.directory, installation: paths.installation });
  let target, original;
  if (mode === "signature") target = path.join(paths.source.releaseDir, "manifest.json");
  if (mode === "web") target = path.join(paths.baseline, "resources/web/index.html");
  if (mode === "ready" || mode === "exit") target = path.join(paths.baseline, "resources/client/dist/index.cjs");
  if (mode === "native") {
    target = path.join(paths.baseline, "resources/client/node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node");
  }
  if (target) {
    original = await fs.readFile(target);
    if (mode === "signature") { const manifest = JSON.parse(original); manifest.signature = Buffer.alloc(64).toString("base64"); await fs.writeFile(target, JSON.stringify(manifest), "utf8"); }
    if (mode === "web") await fs.writeFile(target, '<!doctype html><script src="/does-not-exist-d13.js"></script>', "utf8");
    if (mode === "native") await fs.writeFile(target, "invalid native fixture", "ascii");
    if (mode === "ready") await fs.writeFile(target, "process.exit(7);\n", "ascii");
    if (mode === "exit") await fs.writeFile(target, Buffer.concat([original, Buffer.from("\nprocess.on('exit', () => { process.exitCode = 7; });\n", "ascii")]));
  }
  const roots = { source: paths.source.directory, installation: paths.installation }, before = await inventory(roots);
  const result = { mode, status: "running" };
  let knownError;
  try {
    let rejection;
    try { result.product = await runner({ candidateExecutablePath: path.join(paths.candidate, "CodeFlowAI.exe"), installationDir: paths.installation,
      sourceDataDir: paths.source.directory, temporaryParentDir: paths.temporaryParentDir, timeoutMs: 90_000 }); }
    catch (error) { rejection = error; result.rejection = failure(error); }
    if (mode === "healthy") {
      if (rejection) throw rejection;
      assert.equal(result.product.schemaVersion, 1); assert.equal(result.product.status, "passed"); assert.equal(result.product.candidateShellId, "candidate");
      assert.deepEqual(result.product.checks.map(check => check.role), ["baseline", "active"]);
      assert.equal(result.product.checks[1].releaseId, paths.manifest.releaseId);
      assert.equal(path.resolve(result.product.checks[0].releaseDir), path.join(paths.baseline, "resources"));
      assert.equal(path.resolve(result.product.checks[1].releaseDir), paths.source.releaseDir);
      for (const check of result.product.checks) {
        assert.equal(check.health.database, "ready"); assert.equal(check.health.dbSchemaVersion, 92);
        assert.equal(check.childClosed, true); assert.equal(check.database.integrity, "ok"); assert.equal(check.database.schemaVersion, 92);
        assert.equal(check.native.credentialsAccessed, false); assert.equal(check.native.ptyCreated, false);
        assert.ok(check.native.loaded.some(file => file.endsWith("keyring.win32-x64-msvc.node")), prefix + "_KEYRING_NOT_LOADED");
        for (const module of ["pty.node", "conpty.node", "conpty_console_list.node"]) assert.ok(check.native.loaded.some(file => path.basename(file) === module), prefix + "_PTY_NATIVE_NOT_LOADED");
        assert.ok(check.native.loaded.every(file => !path.relative(path.join(check.releaseDir, "client/node_modules"), file).startsWith("..")), prefix + "_NATIVE_OUTSIDE_RELEASE");
        assert.ok(check.web.files.length > 0);
      }
      result.freshDatabases = [];
      for (let index = 0; index < result.product.checks.length; index++) {
        const data = path.join(result.product.temporaryRoot, "client-" + index), file = path.join(data, "codeflowai.db");
        const beforeDb = await inventory({ data });
        const counts = withDatabase(file, { readOnly: true }, db => ({
          tasks: db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_configs").get().count,
          runs: db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_runs").get().count,
          schema: db.prepare("PRAGMA user_version").get().user_version,
        }));
        assert.deepEqual(counts, { tasks: 0, runs: 0, schema: 92 });
        assert.deepEqual(await inventory({ data }), beforeDb, prefix + "_DATABASE_READ_CHANGED_DATA");
        const identity = JSON.parse(await fs.readFile(path.join(data, "device-identity.json"), "utf8"));
        assert.equal(identity.schemaVersion, 1); assert.match(identity.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        assert.notEqual(identity.deviceId, SOURCE_DEVICE_ID);
        assert.ok(!result.freshDatabases.some(item => item.deviceId === identity.deviceId), prefix + "_SHARED_TEMPORARY_IDENTITY");
        result.freshDatabases.push({ data, counts, deviceId: identity.deviceId });
      }
    } else if (mode === "signature") {
      assert.ok(rejection, prefix + "_SIGNATURE_NOT_REJECTED");
      assert.ok(hasMessage(rejection, "DESKTOP_RELEASE_SIGNATURE_INVALID: " + paths.manifest.releaseId), prefix + "_SIGNATURE_CAUSE_REQUIRED");
      assert.equal(rejection.code, "DESKTOP_SHELL_HEALTH_FAILED");
      result.parentFailure = JSON.parse(await fs.readFile(path.join(rejection.temporaryRoot, "parent-report.json"), "utf8"));
      assert.ok(hasSafeCode(result.parentFailure.error, "DESKTOP_RELEASE_SIGNATURE_INVALID"));
      await assert.rejects(fs.access(rejection.reportPath), { code: "ENOENT" });
    } else {
      assert.ok(rejection, prefix + "_BAD_INPUT_NOT_REJECTED");
      assert.equal(rejection.code, "DESKTOP_SHELL_HEALTH_FAILED");
      result.productFailure = JSON.parse(await fs.readFile(rejection.reportPath, "utf8"));
      assert.equal(result.productFailure.status, "failed"); assert.deepEqual(result.productFailure.checks, []);
      assert.equal(result.productFailure.phase, mode === "web" ? "baseline:web" : mode === "native" ? "baseline:native" : "baseline:client");
      if (mode === "web") assert.ok(hasSafeCode(result.productFailure.error, "ENOENT"), prefix + "_WEB_RESOURCE_CAUSE_REQUIRED");
      if (mode === "native") assert.ok(hasSafeCode(result.productFailure.error, "DESKTOP_SHELL_HEALTH_PROCESS_EXIT_FAILED"), prefix + "_NATIVE_FAILURE_CAUSE_REQUIRED");
      if (mode === "ready" || mode === "exit") assert.ok(hasSafeCode(result.productFailure.error, "CLIENT_EXIT_7"), prefix + "_CLIENT_EXIT_CAUSE_REQUIRED");
      const errors = (await fs.readFile(path.join(rejection.temporaryRoot, "health-errors.jsonl"), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
      assert.equal(errors.length, 1); assert.equal(errors[0].errorCode, "DESKTOP_SHELL_HEALTH_FAILED");
      assert.equal(errors[0].requestId, result.productFailure.requestId); assert.equal(errors[0].candidateShellId, "candidate");
    }
  } catch (error) { knownError = error; }
  try { assert.deepEqual(await inventory(roots), before, prefix + "_SOURCE_OR_INSTALLATION_CHANGED"); result.sourceUnchanged = true; }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_SOURCE_CHECK_FAILED"); }
  try { await assertNoProcesses(paths.root); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_PROCESS_CHECK_FAILED"); }
  if (target) {
    try { await fs.writeFile(target, original); }
    catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_FIXTURE_RESTORE_FAILED"); }
  }
  try { assert.deepEqual(await inventory({ source: paths.source.directory, installation: paths.installation }), pristine, prefix + "_FIXTURE_RESTORE_MISMATCH"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_RESTORED_SOURCE_CHECK_FAILED"); }
  result.status = knownError ? "failed" : "passed"; if (knownError) result.failure = failure(knownError);
  await fs.writeFile(path.join(paths.root, mode + ".json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (knownError) throw knownError;
  return result;
}

/** 脱敏报告保留 code 链，精确检查预期失败码。 */
function hasSafeCode(value, code) {
  return value?.code === code || (value?.cause && hasSafeCode(value.cause, code))
    || (Array.isArray(value?.errors) && value.errors.some(item => hasSafeCode(item, code)))
    || (value?.details && hasSafeCode(value.details, code));
}

/** 畸形候选参数在 ready 前显式拒绝，不得落入普通应用或留下进程。 */
async function malformedScenario(paths, createEnvironment, mode = "malformed") {
  const before = await inventory({ source: paths.source.directory, installation: paths.installation });
  const root = path.join(paths.root, mode); await fs.mkdir(root);
  const env = await createEnvironment(root), executable = path.join(paths.candidate, "CodeFlowAI.exe");
  let args = ["--codeflow-shell-health=invalid"], request;
  if (mode === "environment") {
    request = { schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId: "candidate", installationDir: paths.installation,
      sourceDataDir: paths.source.directory, candidateExecutablePath: executable, temporaryRoot: root, timeoutMs: 10_000 };
    const file = path.join(root, "request.json"); await fs.writeFile(file, JSON.stringify(request) + "\n", { encoding: "utf8", flag: "wx" });
    args = ["--codeflow-shell-health", file]; env.CODEFLOWAI_FORBIDDEN_FIXTURE = "not-allowed";
  }
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", knownError;
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => { child.once("error", error => resolve({ error })); child.once("close", (code, signal) => resolve({ code, signal })); });
  const observed = await queryProcesses([child.pid]);
  let exit;
  try {
    exit = await bounded(closed, 20_000, prefix + "_MALFORMED_EXIT_TIMEOUT"); if (exit.error) throw exit.error;
    assert.deepEqual(exit, { code: 1, signal: null });
    const rows = stderr.split(/\r?\n/u).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    assert.equal(rows.length, 1); assert.equal(rows[0].errorCode, "DESKTOP_SHELL_HEALTH_FAILED");
    assert.equal(rows[0].phase, mode === "environment" ? "bootstrap" : "request");
    assert.ok(hasSafeCode(rows[0].rootCause, mode === "environment" ? "DESKTOP_SHELL_HEALTH_ENVIRONMENT_INVALID" : "DESKTOP_SHELL_HEALTH_REQUEST_INVALID"));
    if (request) {
      const report = JSON.parse(await fs.readFile(path.join(root, "report.json"), "utf8"));
      assert.equal(report.requestId, request.requestId); assert.equal(rows[0].requestId, request.requestId);
      assert.equal(report.candidateShellId, "candidate"); assert.equal(report.temporaryRoot, root);
      assert.equal(report.status, "failed"); assert.equal(report.phase, "bootstrap"); assert.deepEqual(report.checks, []);
      assert.ok(hasSafeCode(report.error, "DESKTOP_SHELL_HEALTH_ENVIRONMENT_INVALID"));
    } else await assert.rejects(fs.access(path.join(root, "report.json")), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("client-")), []);
    assert.equal((await queryProcesses([child.pid])).length, 0);
    await assert.rejects(fs.access(path.join(root, "runtime")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(root, "user-data/runtime")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(root, "device-identity.json")), { code: "ENOENT" });
  } catch (error) { knownError = error; }
  try { assert.deepEqual(await inventory({ source: paths.source.directory, installation: paths.installation }), before, prefix + "_EARLY_SOURCE_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_EARLY_SOURCE_CHECK_FAILED"); }
  if (knownError) {
    try { await stopOwned(observed); } catch (cleanup) { knownError = new AggregateError([knownError, cleanup], prefix + "_MALFORMED_CLEANUP_FAILED"); }
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  const result = { status: knownError ? "failed" : "passed", pid: child.pid, exit, stdout, stderr, ...(knownError ? { error: failure(knownError) } : {}) };
  await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (knownError) throw knownError;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
