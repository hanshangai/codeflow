import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-d17c-"));
const reportPath = path.join(root, "verification.json");
const requestId = crypto.randomUUID();
const secrets = [crypto.randomBytes(32).toString("hex"), crypto.randomBytes(32).toString("hex")];
const credential = { service: `codeflowai-d17c-${requestId}`, account: crypto.randomUUID() };
const report = { requestId, status: "running", root, scope: "windows_packaged_keyring", credential, steps: [] };
let executable, probe, keyringRoot, env, verificationError, writeAttempted = false;

/** 诊断保留进程事实和脱敏根因；密码不进入命令、探针源码或报告。 */
function failure(error, sensitive, depth = 0) {
  const redact = value => {
    let text = String(value);
    for (const secret of sensitive) text = text.replaceAll(secret, "[REDACTED]");
    return text.slice(0, 4000);
  };
  return { name: redact(error?.name ?? "Error"), message: redact(error?.message ?? error),
    ...(error?.code ? { code: redact(error.code) } : {}),
    ...(error?.pid ? { pid: error.pid } : {}),
    ...(error?.processRemaining !== undefined ? { processRemaining: error.processRemaining } : {}),
    ...(error?.probeOutput ? { probeOutput: redact(error.probeOutput) } : {}),
    ...(error?.cause && depth < 5 ? { cause: failure(error.cause, sensitive, depth + 1) } : {}),
    ...(error instanceof AggregateError && depth < 5 ? { errors: [...error.errors].map(item => failure(item, sensitive, depth + 1)) } : {}) };
}

/** Windows PID 查询只有 ESRCH 表示已退出，其余错误必须显式失败。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** 每步只启动一个原生探针；退出未经确认时保留 unknown，阻止凭据清理。 */
function runProbe(phase, action) {
  report.phase = phase;
  let result, error, remaining = "unknown";
  try {
    result = spawnSync(executable, [probe], { cwd: root, env, windowsHide: true,
      input: JSON.stringify({ ...credential, action, keyringRoot, secrets }), encoding: "utf8",
      timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 65_536 });
    error = result.error;
    if (!error && result.status !== 0) error = new Error(`DESKTOP_NATIVE_PROBE_FAILED: ${phase}: status=${result.status}, signal=${result.signal}`);
    remaining = !!result.pid && alive(result.pid);
    if (remaining) {
      error = new AggregateError([...(error ? [error] : []), new Error(`DESKTOP_NATIVE_PROCESS_REMAINED: pid=${result.pid}`)],
        "DESKTOP_NATIVE_PROCESS_CLEANUP_REQUIRED");
      const killed = spawnSync(path.join(env.SystemRoot ?? env.SYSTEMROOT, "System32", "taskkill.exe"),
        ["/PID", String(result.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", encoding: "utf8" });
      const cleanupError = killed.error ?? (killed.status !== 0 ? new Error(`DESKTOP_NATIVE_KILL_FAILED: ${killed.status}`) : undefined);
      if (cleanupError) error.errors.push(cleanupError);
    }
    remaining = "unknown";
    remaining = !!result.pid && alive(result.pid);
    if (error) throw error;
    const verified = JSON.parse(result.stdout);
    if (verified.status !== "passed" || verified.action !== action || verified.pid !== result.pid) {
      throw new Error(`DESKTOP_NATIVE_PROBE_RESPONSE_INVALID: ${phase}`);
    }
    report.steps.push({ phase, action, pid: result.pid, exitCode: result.status, processRemaining: remaining,
      runtime: verified.runtime, nativeModules: verified.nativeModules });
  } catch (cause) {
    throw Object.assign(new Error(`DESKTOP_NATIVE_STEP_FAILED: ${phase}`), {
      cause: error && cause !== error ? new AggregateError([error, cause], "DESKTOP_NATIVE_PROBE_AND_PROCESS_CHECK_FAILED") : cause,
      pid: result?.pid, processRemaining: remaining,
      probeOutput: failure({ message: `${result?.stdout ?? ""}\n${result?.stderr ?? ""}` }, secrets).message,
    });
  }
}

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("用法：electron-packaged-native.smoke.mjs <工件 exe>");
  executable = await fs.realpath(path.resolve(input));
  if (process.platform !== "win32" || path.extname(executable).toLowerCase() !== ".exe") throw new Error("DESKTOP_NATIVE_WINDOWS_EXE_REQUIRED");
  const relative = path.relative(fileURLToPath(new URL("../../..", import.meta.url)), executable);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("DESKTOP_NATIVE_EXE_MUST_BE_OUTSIDE_REPOSITORY");
  keyringRoot = await fs.realpath(path.join(path.dirname(executable), "resources", "client", "node_modules"));
  const modulesRelative = path.relative(path.dirname(executable), keyringRoot);
  if (modulesRelative.startsWith("..") || path.isAbsolute(modulesRelative)) throw new Error("DESKTOP_NATIVE_MODULES_OUTSIDE_PACKAGE");
  await fs.access(path.join(keyringRoot, "@napi-rs", "keyring", "index.js"));
  report.executable = executable;
  report.exeSha256 = crypto.createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  report.keyringRoot = keyringRoot;
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture)$/i;
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR"]) {
    env[key] = path.join(root, key.toLowerCase());
    await fs.mkdir(env[key]);
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  probe = path.join(root, "credential-probe.cjs");
  await fs.writeFile(probe, `(${credentialProbe.toString()})(${failure.toString()});\n`, "utf8");
  runProbe("initial-missing", "missing");
  writeAttempted = true;
  for (const [phase, action] of [["write", "write"], ["cross-process-read", "read"], ["update", "update"],
    ["cross-process-updated-read", "read-updated"], ["delete", "delete"], ["deleted-missing", "missing"]]) runProbe(phase, action);
  report.cleanup = { status: "confirmed_absent" };
  report.status = "passed";
} catch (error) {
  report.failedPhase = report.phase ?? "preflight";
  if (writeAttempted && error.processRemaining === false) {
    try { runProbe("failure-cleanup", "cleanup"); report.cleanup = { status: "confirmed_absent" }; }
    catch (cleanupError) {
      report.cleanup = { status: "failed", credentialState: "unknown" };
      error = new AggregateError([error, cleanupError], "DESKTOP_NATIVE_VERIFICATION_AND_CLEANUP_FAILED");
    }
  } else report.cleanup = writeAttempted
    ? { status: "blocked_by_remaining_process", credentialState: "unknown", pid: error.pid,
      processRemaining: error.processRemaining ?? "unknown" }
    : { status: "write_not_attempted" };
  report.status = "failed";
  verificationError = error;
  report.failure = failure(error, secrets);
  process.exitCode = 1;
}
try { await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
catch (error) {
  report.status = "failed";
  report.failure = failure(new AggregateError([...(verificationError ? [verificationError] : []), error], "DESKTOP_NATIVE_REPORT_WRITE_FAILED"), secrets);
  process.exitCode = 1;
}
console[report.status === "passed" ? "log" : "error"](JSON.stringify({ code: `DESKTOP_NATIVE_${report.status.toUpperCase()}`,
  requestId, reportPath, ...(report.failure ? { failedPhase: report.failedPhase, failure: report.failure, cleanup: report.cleanup } : {}) }));

/** 探针只访问 stdin 指定的本次条目；所有值比较只返回布尔结论，不打印秘密。 */
async function credentialProbe(serializeFailure) {
  let input;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    let json = "";
    for await (const chunk of process.stdin) json += chunk;
    input = JSON.parse(json);
    const { action, service, account, secrets, keyringRoot } = input;
    if (!process.versions.electron || process.platform !== "win32" || process.arch !== "x64") throw new Error("DESKTOP_NATIVE_PACKAGED_ELECTRON_REQUIRED");
    const requireClient = createRequire(path.join(keyringRoot, "..", "package.json"));
    const modulePath = fs.realpathSync(requireClient.resolve("@napi-rs/keyring"));
    const relative = path.relative(keyringRoot, modulePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("DESKTOP_NATIVE_KEYRING_OUTSIDE_PACKAGE");
    const { Entry } = requireClient("@napi-rs/keyring");
    const nativeModules = Object.keys(require.cache).filter(file => file.endsWith(".node")).map(file => fs.realpathSync(file));
    if (!nativeModules.length || nativeModules.some(file => {
      const relative = path.relative(keyringRoot, file);
      return relative.startsWith("..") || path.isAbsolute(relative);
    })) throw new Error("DESKTOP_NATIVE_BINDING_OUTSIDE_PACKAGE");
    const entry = new Entry(service, account);
    if (action === "missing") {
      if (entry.getPassword() !== null) throw new Error("DESKTOP_NATIVE_EXPECTED_MISSING");
    } else if (action === "write") {
      if (entry.getPassword() !== null) throw new Error("DESKTOP_NATIVE_ENTRY_ALREADY_EXISTS");
      entry.setPassword(secrets[0]);
    } else if (action === "read" || action === "read-updated") {
      if (entry.getPassword() !== secrets[action === "read" ? 0 : 1]) throw new Error("DESKTOP_NATIVE_VALUE_MISMATCH");
    } else if (action === "update") {
      if (entry.getPassword() !== secrets[0]) throw new Error("DESKTOP_NATIVE_UPDATE_PRECONDITION_FAILED");
      entry.setPassword(secrets[1]);
    } else if (action === "delete") {
      if (entry.getPassword() !== secrets[1]) throw new Error("DESKTOP_NATIVE_DELETE_PRECONDITION_FAILED");
      if (entry.deletePassword() !== true) throw new Error("DESKTOP_NATIVE_DELETE_FAILED");
    } else if (action === "cleanup") {
      if (entry.getPassword() !== null && entry.deletePassword() !== true) throw new Error("DESKTOP_NATIVE_CLEANUP_DELETE_FAILED");
      if (entry.getPassword() !== null) throw new Error("DESKTOP_NATIVE_CREDENTIAL_REMAINED");
    } else throw new Error("DESKTOP_NATIVE_UNKNOWN_ACTION");
    console.log(JSON.stringify({ status: "passed", action, pid: process.pid, nativeModules,
      runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch } }));
  } catch (error) {
    console.error(JSON.stringify({ code: "DESKTOP_NATIVE_PROBE_FAILED", action: input?.action,
      failure: serializeFailure(error, input?.secrets ?? []) }));
    process.exitCode = 1;
  }
}
