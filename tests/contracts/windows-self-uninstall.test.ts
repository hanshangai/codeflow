import test from "node:test";
import assert from "node:assert/strict";

import { DAEMON_CHILD_ENV, DAEMON_SUPERVISOR_TOKEN_ENV } from "../../apps/desktop/client/src/runtime/clientProcessEnv.ts";
import { resolveClientUninstallPlan } from "../../apps/desktop/client/src/update/clientUninstall.ts";
import {
  buildWindowsUninstallLauncher,
  buildWindowsUninstallLauncherEnv,
  buildWindowsUninstallScript,
} from "../../apps/desktop/client/src/update/windowsSelfUninstall.ts";

/** 私有 launcher 形态：包与启动器都落在 %LOCALAPPDATA%\CodeFlowAI 下，PATH 里另有一条 Git\cmd。 */
function buildPrivatePlan() {
  return resolveClientUninstallPlan({
    npmGlobalPrefix: "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm",
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
  });
}

test("buildWindowsUninstallScript stops the daemon and uninstalls the global package", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 43210, daemonWasRunning: true });

  assert.match(script, /\$parentPid = 43210/);
  assert.match(script, /\$daemonWasRunning = \$true/);
  assert.match(script, /Get-Command npm\.cmd -CommandType Application -ErrorAction Stop/);
  assert.match(script, /Get-Command codeflow\.cmd -CommandType Application -ErrorAction Stop/);
  assert.match(script, /Client 进程在 30 秒内未退出/);
  assert.match(script, /& \$codeflowCommand --stop/);
  assert.match(script, /后台 Client 仍在停止.*500ms 后重试/);
  assert.match(script, /等待 supervisor 停止超时/);
  assert.match(script, /& \$npmCommand uninstall -g @codeflowai\/client --no-audit --no-fund/);
  assert.match(script, /\$uninstallExitCode = 1/);
  assert.match(script, /\$uninstallTail\.Count -ge 20/);
  assert.match(script, /\$uninstallDetail\.Length -gt 1500/);
  assert.match(script, /\$previousErrorActionPreference = \$ErrorActionPreference/);
});

test("buildWindowsUninstallScript pins the npm prefix so a bypassed launcher still uninstalls", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 1, daemonWasRunning: false });

  // 绕过 launcher 直接 node 调用时 npm 会回落到 %APPDATA%\npm，必须显式固定回清单前缀。
  assert.match(script, /\$npmPrefix = 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm'/);
  assert.match(script, /if \(\$npmPrefix\) \{ \$env:npm_config_prefix = \$npmPrefix; \$env:NPM_CONFIG_PREFIX = \$npmPrefix \}/);
  assert.ok(
    script.indexOf("$env:npm_config_prefix = $npmPrefix") < script.indexOf("& $npmCommand uninstall"),
    "npm prefix 必须在执行 npm uninstall 之前固定",
  );
});

test("buildWindowsUninstallScript removes the private launcher and every managed PATH entry", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 1, daemonWasRunning: false });

  assert.match(script, /\$launcherPaths = @\('C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\bin\\codeflow\.cmd', 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\bin\\codeflow\.ps1'\)/);
  assert.match(script, /\$pathEntries = @\('C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\bin', 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\Git\\cmd', 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm'\)/);
  assert.match(script, /\$commandPaths = @\('C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm\\codeflow', 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm\\codeflow\.cmd', 'C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm\\codeflow\.ps1'\)/);
  assert.match(script, /\[Environment\]::SetEnvironmentVariable\('Path', \$nextPath, 'User'\)/);
  assert.match(script, /\[Environment\]::GetEnvironmentVariable\('Path', 'User'\)/);
  // 相对路径会被解析成当前目录，启动器目录删除必须限定为绝对路径。
  assert.match(script, /\[IO\.Path\]::IsPathRooted\(\$launcherDirectory\)/);
});

test("buildWindowsUninstallScript verifies leftovers and never restarts the daemon on success", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 1, daemonWasRunning: true });

  assert.match(script, /卸载后仍存在残留/);
  assert.match(script, /\$packageDirectory/);
  assert.match(script, /卸载完成，用户数据目录未改动/);
  assert.match(script, /CLIENT_UNINSTALL_FAILED/);
  assert.match(script, /codeflowai_\[A-Za-z0-9_\]\{16,128\}/);
  // 成功路径（卸载后不再需要 Client）不得重启 daemon，恢复分支只服务于包删除前的失败。
  const successPath = script.slice(script.indexOf("$exitCode = 0"), script.indexOf("} catch {"));
  assert.doesNotMatch(successPath, /--daemon/);
});

test("buildWindowsUninstallScript restores the daemon only before the package is removed", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 1, daemonWasRunning: true });

  assert.match(script, /if \(\$stoppedDaemon -and -not \$packageRemoved -and \$codeflowCommand\)/);
  assert.match(script, /\$stoppedDaemon = \$true/);
  assert.match(script, /\$packageRemoved = \$true/);
  assert.match(script, /Client 恢复启动失败/);
});

test("buildWindowsUninstallScript escapes a quote-bearing plan path", () => {
  const plan = buildPrivatePlan();
  const script = buildWindowsUninstallScript({
    plan: { ...plan, packageDir: "C:\\Users\\o'brien\\AppData\\Roaming\\npm\\node_modules\\@codeflowai\\client" },
    parentPid: 1,
    daemonWasRunning: false,
  });

  assert.match(script, /\$packageDirectory = 'C:\\Users\\o''brien\\AppData\\Roaming\\npm\\node_modules\\@codeflowai\\client'/);
});

test("buildWindowsUninstallScript emits CRLF line endings", () => {
  const script = buildWindowsUninstallScript({ plan: buildPrivatePlan(), parentPid: 1, daemonWasRunning: false });
  assert.equal(/[^\r]\n/u.test(script), false);
});

test("buildWindowsUninstallLauncher runs the script in a detached PowerShell window", () => {
  const launcher = buildWindowsUninstallLauncher({ powershellExe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", scriptPath: "C:\\Temp\\uninstall.ps1" });

  assert.equal(launcher.command, process.env.ComSpec || "cmd.exe");
  assert.deepEqual(launcher.args, [
    "/c", "start", "",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", "C:\\Temp\\uninstall.ps1",
  ]);
});

test("buildWindowsUninstallLauncherEnv drops daemon child markers", () => {
  const env = buildWindowsUninstallLauncherEnv({
    PATH: "C:\\Windows",
    [DAEMON_CHILD_ENV]: "1",
    [DAEMON_SUPERVISOR_TOKEN_ENV]: "token",
  });

  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env[DAEMON_CHILD_ENV], undefined);
  assert.equal(env[DAEMON_SUPERVISOR_TOKEN_ENV], undefined);
});
