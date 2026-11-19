import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildWindowsUpgradeLauncherEnv,
  buildWindowsUpgradeLauncher,
  buildWindowsUpgradeScript,
} from "../../apps/desktop/client/src/update/windowsSelfUpgrade.ts";

test("buildWindowsUpgradeScript stops daemon before replacing the global client", () => {
  const script = buildWindowsUpgradeScript({
    parentPid: 43210,
    installUrl: "https://codeflowai.cn/downloads/codeflowai-2026.04.05.01.tgz",
    npmPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
    daemonWasRunning: true,
    resultReport: {
      url: "https://codeflowai.cn/api/client/upgrade-result",
      upgradeId: "upgrade-1",
      token: "a".repeat(43),
      fromVersion: "2026.04.05.00",
      toVersion: "2026.04.05.01",
    },
  });

  assert.match(script, /\$parentPid = 43210/);
  assert.match(script, /\$daemonWasRunning = \$true/);
  assert.match(script, /Get-Command \$Name -CommandType Application -ErrorAction Stop \| Select-Object -First 1/);
  assert.match(script, /Resolve-UpgradeApplication -Name 'codeflow\.cmd' -Directory \$npmPrefix/);
  assert.match(script, /Resolve-UpgradeApplication -Name 'npm\.cmd'/);
  assert.match(script, /Test-Path -LiteralPath \$commandPath -PathType Leaf/);
  assert.doesNotMatch(script, /& \$codeflowCommand --status/);
  assert.match(script, /& \$codeflowCommand --stop/);
  assert.match(script, /Client 进程在 30 秒内未退出/);
  assert.match(script, /\$npmCommand install -g --force --registry=https:\/\/registry\.npmmirror\.com --replace-registry-host=never --include=optional --no-audit --no-fund \$installUrl/);
  assert.match(script, /\$previousErrorActionPreference = \$ErrorActionPreference/);
  assert.match(script, /\$installExitCode = 1/);
  assert.match(script, /\$installTail\.Count -ge 20/);
  assert.match(script, /\$installDetail\.Length -gt 1500/);
  assert.match(script, /后台 Client 仍在停止.*500ms 后重试/);
  assert.match(script, /等待 supervisor 停止超时/);
  assert.match(script, /& \$codeflowCommand --daemon/);
  assert.match(script, /正在尝试恢复启动原 Client/);
  assert.match(script, /if \(\$installCompleted\).*\$exitCode = 0/s);
  assert.match(script, /Invoke-RestMethod -Method Post/);
  assert.match(script, /X-Codeflow-Upgrade-Token/);
  assert.match(script, /\$attempt -le 3/);
  assert.doesNotMatch(script, /npm rm -g/);
  assert.doesNotMatch(script, /--disturl=/);

  const stopIndex = script.indexOf("& $codeflowCommand --stop");
  const preflightIndex = script.indexOf("$currentVersion = Invoke-CodeflowJsonCommand");
  const npmPreflightIndex = script.indexOf("$npmVersion = Invoke-CodeflowJsonCommand");
  const parentWaitIndex = script.indexOf("while ($parentPid -gt 0");
  const continuePreferenceIndex = script.indexOf('$ErrorActionPreference = "Continue"');
  const installIndex = script.indexOf("& $npmCommand install -g");
  const installExitCodeIndex = script.indexOf("$installExitCode = if ($LASTEXITCODE");
  const restorePreferenceIndex = script.indexOf("$ErrorActionPreference = $previousErrorActionPreference");
  const restartIndex = script.indexOf("& $codeflowCommand --daemon");
  const stopRetryIndex = script.indexOf("$stopDeadline = [DateTime]::UtcNow.AddSeconds(30)");
  const stopRetryLoopIndex = script.indexOf("} while ($stopExitCode -ne 0");
  assert.ok(parentWaitIndex >= 0 && parentWaitIndex < stopIndex);
  assert.ok(preflightIndex >= 0 && preflightIndex < parentWaitIndex, "停机前必须先验证唯一 Client 入口");
  assert.ok(npmPreflightIndex >= 0 && npmPreflightIndex < parentWaitIndex, "停机前必须先验证 npm 可执行");
  assert.ok(stopRetryIndex >= 0 && stopRetryIndex < stopIndex);
  assert.ok(stopIndex < stopRetryLoopIndex);
  assert.ok(stopRetryLoopIndex < installIndex);
  assert.ok(continuePreferenceIndex >= 0 && continuePreferenceIndex < installIndex);
  assert.ok(installIndex < installExitCodeIndex && installExitCodeIndex < restorePreferenceIndex);
  assert.ok(installIndex < restartIndex);
});

test("Windows 独立升级器显式固定 npm prefix，避免装进另一套安装", () => {
  const script = buildWindowsUpgradeScript({
    parentPid: 1,
    installUrl: "https://example.com/client.tgz",
    npmPrefix: "C:\\Users\\O'Hara\\AppData\\Roaming\\npm",
    daemonWasRunning: false,
  });

  // 绕过 launcher 直接运行时 npm 会回落到 %APPDATA%\npm，必须显式固定回判定命中的前缀。
  assert.match(script, /\$npmPrefix = 'C:\\Users\\O''Hara\\AppData\\Roaming\\npm'/);
  assert.match(script, /if \(\$npmPrefix\) \{ \$env:npm_config_prefix = \$npmPrefix; \$env:NPM_CONFIG_PREFIX = \$npmPrefix \}/);
  assert.ok(
    script.indexOf("$env:npm_config_prefix = $npmPrefix") < script.indexOf("& $npmCommand install"),
    "npm prefix 必须在执行 npm 安装之前固定",
  );
});

test("buildWindowsUpgradeScript escapes single quotes in installUrl", () => {
  const script = buildWindowsUpgradeScript({
    parentPid: 1,
    installUrl: "https://example.com/o'hara.tgz",
    npmPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
    daemonWasRunning: false,
  });

  assert.match(script, /\$installUrl = 'https:\/\/example\.com\/o''hara\.tgz'/);
  assert.match(script, /\$daemonWasRunning = \$false/);
  assert.match(script, /\$reportUrl = ''/);
});

test("buildWindowsUpgradeLauncher uses cmd start to open the visible upgrade window", () => {
  const launcher = buildWindowsUpgradeLauncher({
    powershellExe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    scriptPath: "C:\\Users\\O'Hara\\AppData\\Local\\Temp\\codeflow upgrade.ps1",
  });

  assert.match(launcher.command, /cmd\.exe$/i);
  assert.deepEqual(launcher.args.slice(0, 4), [
    "/c",
    "start",
    "",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);
  assert.deepEqual(launcher.args.slice(4), [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    "C:\\Users\\O'Hara\\AppData\\Local\\Temp\\codeflow upgrade.ps1",
  ]);
});

test("buildWindowsUpgradeLauncherEnv clears inherited daemon runtime markers", () => {
  const env = buildWindowsUpgradeLauncherEnv({
    CODEFLOWAI_TEST_MARKER: "1",
    CODEFLOWAI_DAEMON_CHILD: "1",
    CODEFLOWAI_DAEMON_SUPERVISOR: "1",
    CODEFLOWAI_DAEMON_SUPERVISOR_PID: "123",
    CODEFLOWAI_DAEMON_SUPERVISOR_TOKEN: "token",
    CODEFLOWAI_DAEMON_WORKER_ENTRY: "worker",
    CODEFLOWAI_RESTART_PARENT_PID: "456",
  });

  assert.equal(env.CODEFLOWAI_TEST_MARKER, "1");
  assert.equal(env.CODEFLOWAI_DAEMON_CHILD, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR_PID, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR_TOKEN, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_WORKER_ENTRY, undefined);
  assert.equal(env.CODEFLOWAI_RESTART_PARENT_PID, undefined);
});

test("buildWindowsUpgradeScript generates valid Windows PowerShell syntax", { skip: process.platform !== "win32" }, () => {
  const script = buildWindowsUpgradeScript({
    parentPid: 43210,
    installUrl: "https://codeflowai.cn/downloads/codeflowai-2026.04.05.01.tgz",
    npmPrefix: "C:\\Users\\测试 用户\\AppData\\Roaming\\npm",
    daemonWasRunning: true,
    resultReport: {
      url: "https://codeflowai.cn/api/client/upgrade-result",
      upgradeId: "upgrade-ast",
      token: "b".repeat(43),
      fromVersion: "2026.04.05.00",
      toVersion: "2026.04.05.01",
    },
  });
  const parserCommand = [
    "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$source = [Console]::In.ReadToEnd()",
    "$tokens = $null",
    "$errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
  ].join("; ");
  const parsed = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", parserCommand], {
    input: script,
    encoding: "utf8",
  });

  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

test("Windows 独立升级器核验版本和真实连接，恢复重启也不能绕过校验", () => {
  const script = buildWindowsUpgradeScript({ parentPid: 1, installUrl: "https://example.com/client.tgz",
    npmPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
    daemonWasRunning: true, targetVersion: "2026.09.12.04", previousClientPid: 789 });
  assert.match(script, /\$expectedVersion = '2026\.09\.12\.04'/);
  assert.match(script, /\$previousClientPid = 789/);
  assert.equal((script.match(/^\s+Assert-UpgradedClientConnection$/gm) || []).length, 2);
  assert.equal((script.match(/^\s+Assert-UpgradedClientVersion$/gm) || []).length, 2);
  assert.match(script, /code = 'CLIENT_UPGRADE_FAILED'; requestId = \$requestId/);
  assert.doesNotMatch(script, /& \$codeflowCommand --ready|& \$codeflowCommand --status/);
  // 捕获原生命令输出必须走 UTF-8 解码助手，且不得残留绕过助手的裸捕获。
  assert.match(script, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(script, /\[Console\]::OutputEncoding = \$previousOutputEncoding/);
  assert.match(script, /\$OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(script, /\$OutputEncoding = \$previousPipelineEncoding/);
  assert.match(script, /Invoke-CodeflowJsonCommand -CommandPath \$codeflowCommand -CommandArguments @\('--version'\)/);
  assert.match(script, /Invoke-CodeflowJsonCommand -CommandPath \$codeflowCommand -CommandArguments @\('--connected'\)/);
  assert.doesNotMatch(script, /& \$codeflowCommand --version|& \$codeflowCommand --connected/);
});

/** 提取升级脚本中验收函数段（到主 try 块之前），供真实 PowerShell 用例注入。 */
function extractUpgradeAssertionFunctions(source: string): string {
  const begin = source.indexOf("function Invoke-CodeflowJsonCommand");
  const end = source.indexOf("\r\ntry {", begin);
  assert.ok(begin > 0 && end > begin, "升级脚本验收函数段缺失");
  return source.slice(begin, end);
}

test("Windows 实际 PowerShell 验收拒绝假成功并允许显式 degraded", { skip: process.platform !== "win32" }, () => {
  const source = buildWindowsUpgradeScript({ parentPid: 1, installUrl: "https://example.com/client.tgz",
    npmPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm", daemonWasRunning: true });
  const functions = extractUpgradeAssertionFunctions(source);
  for (const [name, value, code, ok] of [
    ["ready", { schemaVersion: 1, connected: true, clientRunning: true, supervisorRunning: true, clientPid: 2, stage: "ready" }, 0, true],
    ["degraded", { schemaVersion: 1, connected: true, clientRunning: true, supervisorRunning: true, clientPid: 2, stage: "degraded" }, 0, true],
    ["old-worker", { schemaVersion: 1, connected: true, clientRunning: true, supervisorRunning: true, clientPid: 1, stage: "ready" }, 0, false],
    ["string-boolean", { schemaVersion: 1, connected: "true", clientRunning: true, supervisorRunning: true, clientPid: 2, stage: "ready" }, 0, false],
    ["missing-worker", { schemaVersion: 1, connected: true, clientRunning: false, supervisorRunning: true, clientPid: 2, stage: "ready" }, 0, false],
    ["exit-failure", { schemaVersion: 1, connected: true, clientRunning: true, supervisorRunning: true, clientPid: 2, stage: "ready" }, 1, false],
  ] as const) {
    const script = [
      "$ErrorActionPreference='Stop'", "$expectedVersion='2026.09.12.04'", "$previousClientPid=1", "$codeflowCommand='Invoke-FakeCodeflow'",
      "function Invoke-FakeCodeflow([string]$arg) { $global:LASTEXITCODE=" + code + "; if($arg -eq '--version') { '2026.09.12.04' } else { '" + JSON.stringify(value) + "' } }",
      functions, "Assert-UpgradedClientVersion", "Assert-UpgradedClientConnection",
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::InputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],
    { input: script, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status === 0, ok, name + ": " + result.stderr);
  }
});

test("Windows 升级器按 UTF-8 解码外部进程的连接 JSON，中文 message 不被 OEM 代码页破坏", { skip: process.platform !== "win32" }, () => {
  const source = buildWindowsUpgradeScript({ parentPid: 1, installUrl: "https://example.com/client.tgz",
    npmPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm", daemonWasRunning: true });
  // 用真实外部进程（.cmd + type）以 UTF-8 写管道，复现「已连接服务器，Client 已就绪」这类中文 message：
  // 这正是原报错场景——PS 5.1 默认按 OEM 代码页解码，尾字节会连 JSON 收尾引号一起吞掉。
  // 中文以 \u 转义写进夹具，使本用例自身不依赖源文件的编码。
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-upgrade-encoding-"));
  try {
    const message = "\u5df2\u8fde\u63a5\u670d\u52a1\u5668\uff0cClient \u5df2\u5c31\u7eea";
    fs.writeFileSync(path.join(tempDir, "connected.json"), JSON.stringify({
      schemaVersion: 1, ready: true, connected: true, clientRunning: true, supervisorRunning: true,
      clientPid: 2, stage: "ready", message,
    }), "utf8");
    // 夹具只含 ASCII，路径通过 %~dp0 取得，避免命令参数里的引号被 PS 5.1 拆断。
    fs.writeFileSync(path.join(tempDir, "codeflow-fake.cmd"), [
      "@echo off",
      'if "%~1"=="--version" (echo 2026.09.12.04) else (type "%~dp0connected.json")',
      "",
    ].join("\r\n"), "ascii");
    const commandPath = path.join(tempDir, "codeflow-fake.cmd").replace(/'/g, "''");

    const script = [
      "$ErrorActionPreference='Stop'",
      "$expectedVersion='2026.09.12.04'",
      "$previousClientPid=1",
      "$codeflowCommand='" + commandPath + "'",
      extractUpgradeAssertionFunctions(source),
      // 走真实验收函数：未按 UTF-8 捕获时 ConvertFrom-Json 直接抛错，本用例即失败。
      "Assert-UpgradedClientVersion",
      "Assert-UpgradedClientConnection",
      "$output = Invoke-CodeflowJsonCommand -CommandPath $codeflowCommand -CommandArguments @('--connected')",
      "$view = ($output -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop",
      "$messageBytes = [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes([string]$view.message)).Replace('-', '')",
      "if ($messageBytes -ne 'E5B7B2E8BF9EE68EA5E69C8DE58AA1E599A8EFBC8C436C69656E7420E5B7B2E5B0B1E7BBAA') { throw ('message bytes mismatch: ' + $messageBytes) }",
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::InputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],
    { input: script, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
