import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";

type ProcessIdentity = { pid: number; created: string; executable: string; parentPid: number; commandLine: string };
const { queryProcesses, stopOwned } = await import(new URL("./electron-packaged-storage-failure.smoke.mjs", import.meta.url).href) as {
  queryProcesses(pids: number[]): Promise<ProcessIdentity[]>;
  stopOwned(records: ProcessIdentity[]): Promise<void>;
};

const evidence = process.env.CF_SHELL_INSTALL_TEST_ROOT ?? "D:/cf-d13-shell-install-evidence-20261027-01/implementation";

/** 所有夹具保留在本片独占证据根，不触碰真实安装、用户入口或公共缓存。 */
async function fixture() {
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidence, "fixture-"));
  const candidateDirectory = path.join(root, "input $候选");
  const files = {
    "CodeFlowAI.exe": "not an executable; installation must never start it",
    "resources/app.asar": "physical asar bytes",
    "resources/release-trust.json": "{}",
    "resources/中文 $路径/quote' $(name) ${SHELL_ID}.txt": "完整载荷 $INSTDIR",
    "resources/empty.bin": "",
  };
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(candidateDirectory, relative)), { recursive: true });
    await fs.writeFile(path.join(candidateDirectory, relative), text, "utf8");
  }
  return { root, candidateDirectory, files };
}

/** 原导出必须存在，缺实现时以明确合同断言作为 RED。 */
async function builder() {
  const script = new URL("../scripts/build-shell-installer.mjs", import.meta.url);
  assert.equal(await fs.access(script).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  }), true, "candidate installer builder must exist");
  return await import(script.href) as {
    buildShellInstaller(input: { candidateDirectory: string; shellId: string; outputDir: string; cacheDir: string; fastCompress?: boolean }): Promise<{
      executablePath: string; shellId: string; files: Array<{ path: string; size: number; sha256: string }>;
    }>;
  };
}

/** 查询与 close 共用同一截止点；失败只清理完整身份或原句柄拥有的本次进程。 */
async function runInstaller(executable: string, args: string[], root: string, stderr = true, timeoutMs = 30_000,
  observe = queryProcesses) {
  const temporary = await fs.mkdtemp(path.join(root, "process-temp-"));
  const deadline = performance.now() + timeoutMs;
  const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, TEMP: temporary, TMP: temporary },
    stdio: ["ignore", "pipe", "pipe"] });
  if (!stderr) child.stderr.destroy();
  let output = "", errors = "", didClose = false, spawnError: Error | undefined;
  child.stdout?.on("data", chunk => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", chunk => { errors += chunk.toString("utf8"); });
  const closed = new Promise<{ code: number | null; stderr: string; stdout: string }>(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", code => { didClose = true; resolve({ code, stderr: errors, stdout: output }); });
  });
  let identities: ProcessIdentity[] = [];
  let timer: NodeJS.Timeout | undefined;
  const timeout = Object.assign(new Error("INSTALLER_TIMEOUT"), { pid: child.pid });
  try {
    identities = child.pid ? await observe([child.pid]) : [];
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeout;
    const result = await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout), remaining);
    })]);
    if (spawnError) throw spawnError;
    if (performance.now() >= deadline) throw timeout;
    return result;
  } catch (error) {
    clearTimeout(timer);
    const failures = [error];
    try {
      if (!didClose && identities.length === 0) {
        // 查询失败时只用 spawn 保留的原始进程句柄，不重新按未知 PID 寻找进程。
        assert.ok(child.kill(), "INSTALLER_OWNED_HANDLE_STOP_FAILED");
      } else {
        assert.ok(didClose || identities.length === 1 && identities[0].parentPid === process.pid, "INSTALLER_OWNERSHIP_UNKNOWN");
        await stopOwned(identities);
      }
    } catch (cleanup) { failures.push(cleanup); }
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("INSTALLER_CLOSE_TIMEOUT")), 10_000);
      })]);
    } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "INSTALLER_TIMEOUT_CLEANUP_FAILED");
    throw error;
  } finally { clearTimeout(timer); }
}

test("builds and actually installs a full small payload only into a new compiled shell directory", { timeout: 300_000 }, async () => {
  const f = await fixture(), { buildShellInstaller } = await builder();
  const built = await buildShellInstaller({ candidateDirectory: f.candidateDirectory, shellId: "fixture-01",
    outputDir: path.join(f.root, "output $候选 ${SHELL_ID}"), cacheDir: path.join(f.root, "cache") });
  assert.equal(built.shellId, "fixture-01");
  assert.deepEqual(built.files, Object.entries(f.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([file, content]) => ({ path: file, size: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") })));
  const installation = path.join(f.root, "installation $中文");
  await fs.mkdir(path.join(installation, "shells"), { recursive: true });
  await fs.writeFile(path.join(installation, "shell-launch.ini"), "unchanged", "utf8");
  const requestId = crypto.randomUUID();
  const args = ["--codeflow-candidate-install", "--installation-root", installation, "--request-id", requestId];
  const result = await runInstaller(built.executablePath, args, f.root);
  assert.deepEqual(result, { code: 0, stderr: "", stdout: "" });
  for (const [relative, content] of Object.entries(f.files)) {
    assert.equal(await fs.readFile(path.join(installation, "shells/fixture-01", relative), "utf8"), content);
  }
  assert.equal(await fs.readFile(path.join(installation, "shell-launch.ini"), "utf8"), "unchanged");
  // 逻辑盘表包含失联映射盘，未知盘夹具只使用未分配字母，不探测卷可用性。
  const logicalDrives = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; [System.Environment]::GetLogicalDrives()"], { encoding: "utf8", windowsHide: true })
    .trim().split(/\r?\n/u).map(value => value.trim().toUpperCase());
  assert.ok(logicalDrives.length > 0 && logicalDrives.every(value => /^[A-Z]:\\$/u.test(value)), "LOGICAL_DRIVE_QUERY_INVALID");
  const unavailableDrive = [..."ZYXWVUTSRQPONMLKJIHGFEDCBA"].map(letter => `${letter}:\\`)
    .find(drive => !logicalDrives.includes(drive));
  assert.ok(unavailableDrive, "UNKNOWN_DRIVE_FIXTURE_UNAVAILABLE");
  const unknownRoot = path.join(unavailableDrive, "codeflow-candidate-test");
  const unknownDrive = await runInstaller(built.executablePath, [args[0]!, args[1]!, unknownRoot, args[3]!, requestId], f.root);
  assert.equal(unknownDrive.code, 1);
  assert.deepEqual(JSON.parse(unknownDrive.stderr), { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId, shellId: "fixture-01",
    stage: "root", win32Error: 0, rootCause: "ROOT_DRIVE_UNSUPPORTED" });
  await assert.rejects(fs.access(unknownRoot), { code: "ENOENT" });
  const repeated = await runInstaller(built.executablePath, args, f.root);
  assert.equal(repeated.code, 1);
  assert.deepEqual(JSON.parse(repeated.stderr), { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId, shellId: "fixture-01",
    stage: "create-target", win32Error: 183, rootCause: "TARGET_CREATE_FAILED" });
  for (const invalid of [[], [...args, "--updated"], ["--wrong", ...args.slice(1)], [...args.slice(0, 4)],
    [args[0]!, args[1]!, installation, args[3]!, "invalid\"request"]]) {
    const rejected = await runInstaller(built.executablePath, invalid, f.root);
    assert.equal(rejected.code, 1);
    const diagnostic = JSON.parse(rejected.stderr);
    assert.equal(diagnostic.stage, "arguments");
    assert.equal(diagnostic.rootCause, "ARGUMENTS_INVALID");
    assert.equal(diagnostic.win32Error, 0);
    assert.equal(diagnostic.requestId, "");
  }
  const alias = path.join(f.root, "root-junction");
  await fs.symlink(installation, alias, "junction");
  const junction = await runInstaller(built.executablePath, [args[0]!, args[1]!, alias, args[3]!, requestId], f.root);
  assert.equal(junction.code, 1);
  assert.deepEqual(JSON.parse(junction.stderr), { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId, shellId: "fixture-01",
    stage: "root", win32Error: 0, rootCause: "PATH_REPARSE" });
  const noDiagnostic = await runInstaller(built.executablePath, [], f.root, false);
  assert.equal(noDiagnostic.code, 2);
  for (const root of ["relative", "\\\\localhost\\share", installation + "\\..", installation + "\\", installation + ":stream", installation + " ", installation + "\u0001"]) {
    const result = await runInstaller(built.executablePath, [args[0]!, args[1]!, root, args[3]!, requestId], f.root);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).rootCause, "ROOT_INVALID");
  }
});

test("timeout closes only the installer process owned by this test", { timeout: 30_000 }, async () => {
  const f = await fixture();
  await assert.rejects(runInstaller(process.execPath, ["-e", "setTimeout(()=>{},5000)"], f.root, true, 50), /INSTALLER_TIMEOUT/);
});

test("an installer that closes during a slow process query still exceeds the original deadline", { timeout: 10_000 }, async () => {
  const f = await fixture(), completed = path.join(f.root, "child-completed");
  let observedPid: number | undefined;
  await assert.rejects(runInstaller(process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], 'done')", completed], f.root, true, 50,
    async ([pid]) => {
      observedPid = pid;
      const limit = performance.now() + 5000;
      while (true) {
        try { await fs.access(completed); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        assert.ok(performance.now() < limit, "CHILD_COMPLETION_MARKER_TIMEOUT");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return [];
    }), (error: any) => {
      assert.equal(error.message, "INSTALLER_TIMEOUT");
      assert.equal(error.pid, observedPid);
      return true;
    });
  assert.equal(await fs.readFile(completed, "utf8"), "done");
});

test("an installer that closes within its original budget retains its real output and exit code", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const result = await runInstaller(process.execPath, ["-e", "process.stdout.write('finished');process.exitCode=7"], f.root,
    true, 5000, async () => []);
  assert.deepEqual(result, { code: 7, stdout: "finished", stderr: "" });
});

test("a process query rejection beyond the budget keeps its original cause", { timeout: 10_000 }, async () => {
  const f = await fixture(), original = new Error("PROCESS_QUERY_DELAYED_FAILURE");
  await assert.rejects(runInstaller(process.execPath, ["-e", "setTimeout(()=>{},5000)"], f.root, true, 50,
    async () => { await new Promise(resolve => setTimeout(resolve, 100)); throw original; }), error => error === original);
});

test("process query failure still closes the spawn-owned process handle", { timeout: 30_000 }, async () => {
  const f = await fixture();
  await assert.rejects(runInstaller(process.execPath, ["-e", "setTimeout(()=>{},15000)"], f.root, true, 50,
    async () => { throw new Error("PROCESS_QUERY_PROBE"); }), /PROCESS_QUERY_PROBE/);
});

test("rejects invalid inventory and intersecting output paths before creating build outputs", async () => {
  const f = await fixture(), { buildShellInstaller } = await builder();
  const cacheDir = path.join(f.root, "unused-cache");
  await assert.rejects(buildShellInstaller({ candidateDirectory: f.candidateDirectory, shellId: "fixture-01",
    outputDir: path.join(f.candidateDirectory, "output"), cacheDir }), /PATH_OVERLAP/);
  await assert.rejects(fs.access(cacheDir), { code: "ENOENT" });
  await fs.unlink(path.join(f.candidateDirectory, "resources/app.asar"));
  const outputDir = path.join(f.root, "rejected-output");
  await assert.rejects(buildShellInstaller({ candidateDirectory: f.candidateDirectory, shellId: "fixture-01", outputDir, cacheDir }), /PAYLOAD_INVALID/);
  await assert.rejects(fs.access(outputDir), { code: "ENOENT" });
  await assert.rejects(fs.access(cacheDir), { code: "ENOENT" });
});


test("test-only fast compression builds and installs the same candidate payload", { timeout: 300_000 }, async () => {
  const f = await fixture(), { buildShellInstaller } = await builder();
  const built = await buildShellInstaller({ candidateDirectory: f.candidateDirectory, shellId: "fixture-fast",
    outputDir: path.join(f.root, "fast-output"), cacheDir: path.join(f.root, "fast-cache"), fastCompress: true });
  assert.equal(built.shellId, "fixture-fast");
  assert.deepEqual(built.files, Object.entries(f.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([file, content]) => ({ path: file, size: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") })));
  const installation = path.join(f.root, "fast-installation");
  await fs.mkdir(path.join(installation, "shells"), { recursive: true });
  const requestId = crypto.randomUUID();
  const result = await runInstaller(built.executablePath, ["--codeflow-candidate-install", "--installation-root", installation,
    "--request-id", requestId], f.root);
  assert.deepEqual(result, { code: 0, stderr: "", stdout: "" });
  assert.equal(await fs.readFile(path.join(installation, "shells/fixture-fast/CodeFlowAI.exe"), "utf8"),
    f.files["CodeFlowAI.exe"]);
});
