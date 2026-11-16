import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import { CLIENT_NPM_PACKAGE_NAME } from "../app/clientInstallEntry.js";
import type { ClientUninstallPlan } from "./clientUninstall.js";

export type WindowsUninstallOptions = {
  /** 卸载删除清单，由调用方按当前平台与 npm prefix 解析。 */
  plan: ClientUninstallPlan;
  parentPid: number;
  daemonWasRunning: boolean;
};

export type WindowsUninstallLauncherOptions = {
  powershellExe: string;
  scriptPath: string;
};

function escapePowerShellSingleQuoted(text: string): string {
  return text.replace(/'/g, "''");
}

/** 构造独立卸载器环境，避免 daemon 子进程标记污染后续 codeflow --daemon。 */
export function buildWindowsUninstallLauncherEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildClientChildProcessEnv(baseEnv);
}

/**
 * 生成 Windows 自卸载脚本。
 * Windows 无法删除正在运行的文件，因此先等待 CLI 退出，再停止 daemon、卸载全局包、删启动器并清理 HKCU PATH。
 */
export function buildWindowsUninstallScript(opts: WindowsUninstallOptions): string {
  const parentPid = Number.isFinite(opts.parentPid) ? Math.max(0, Math.trunc(opts.parentPid)) : 0;
  const npmPrefix = escapePowerShellSingleQuoted(opts.plan.npmGlobalPrefix);
  const packageDir = escapePowerShellSingleQuoted(opts.plan.packageDir);
  const launcherDir = escapePowerShellSingleQuoted(path.dirname(opts.plan.launcherPaths[0] ?? ""));
  const launcherList = opts.plan.launcherPaths.map((value) => `'${escapePowerShellSingleQuoted(value)}'`).join(", ");
  const pathEntryList = opts.plan.pathEntries.map((value) => `'${escapePowerShellSingleQuoted(value)}'`).join(", ");
  const commandPathList = opts.plan.npmCommandPaths.map((value) => `'${escapePowerShellSingleQuoted(value)}'`).join(", ");
  return [
    '$ErrorActionPreference = "Stop"',
    `$parentPid = ${parentPid}`,
    `$daemonWasRunning = ${opts.daemonWasRunning ? "$true" : "$false"}`,
    `$npmPrefix = '${npmPrefix}'`,
    `$packageDirectory = '${packageDir}'`,
    `$launcherDirectory = '${launcherDir}'`,
    `$launcherPaths = @(${launcherList})`,
    `$pathEntries = @(${pathEntryList})`,
    `$commandPaths = @(${commandPathList})`,
    "$requestId = [guid]::NewGuid().ToString()",
    "$failureMessage = $null",
    "$exitCode = 1",
    "$uninstallStage = 'prepare'",
    "$npmCommand = $null",
    "$codeflowCommand = $null",
    "$stoppedDaemon = $false",
    "$packageRemoved = $false",
    "$uninstallExitCode = 1",
    "$uninstallTail = New-Object 'System.Collections.Generic.Queue[string]'",
    "",
    "# 从当前用户 PATH 中移除本安装器写入的目录；条目不存在时保持原值不动。",
    "function Remove-UserPathEntry([string]$PathEntry) {",
    "  $normalized = ([string]$PathEntry).Trim()",
    "  if (-not $normalized) { return }",
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  if (-not $userPath) { return }",
    "  $key = $normalized.TrimEnd('\\').ToLowerInvariant()",
    "  $kept = @(([string]$userPath -split ';') | Where-Object { $_.Trim() -and $_.Trim().TrimEnd('\\').ToLowerInvariant() -ne $key })",
    "  $nextPath = $kept -join ';'",
    "  if ($nextPath -eq $userPath) { return }",
    "  [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')",
    '  Write-Host "[codeflowai] 已从当前用户 PATH 移除：$normalized"',
    "}",
    "",
    "try {",
    "  try {",
    "    $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source",
    "    $deadline = [DateTime]::UtcNow.AddSeconds(30)",
    "    while ($parentPid -gt 0 -and (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {",
    "      Start-Sleep -Milliseconds 200",
    "    }",
    "    if ($parentPid -gt 0 -and (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {",
    "      throw \"Client 进程在 30 秒内未退出: pid=$parentPid\"",
    "    }",
    "    if ($daemonWasRunning) {",
    "      $uninstallStage = 'stop'",
    "      $codeflowCommand = (Get-Command codeflow.cmd -CommandType Application -ErrorAction Stop).Source",
    '      Write-Host "[codeflowai] 正在停止后台 Client，准备删除全局包..."',
    "      $stopExitCode = 1",
    "      $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)",
    "      do {",
    "        & $codeflowCommand --stop",
    "        $stopExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "        if ($stopExitCode -ne 0 -and [DateTime]::UtcNow -lt $stopDeadline) {",
    '          Write-Host "[codeflowai] 后台 Client 仍在停止（codeflow --stop 退出码: $stopExitCode），500ms 后重试..."',
    "          Start-Sleep -Milliseconds 500",
    "        }",
    "      } while ($stopExitCode -ne 0 -and [DateTime]::UtcNow -lt $stopDeadline)",
    "      if ($stopExitCode -ne 0) { throw \"codeflow --stop 退出码: $stopExitCode（等待 supervisor 停止超时）\" }",
    "      $stoppedDaemon = $true",
    "    }",
    "    Start-Sleep -Milliseconds 800",
    "    if (Test-Path Env:npm_config_disturl) { Remove-Item Env:npm_config_disturl }",
    "    if (Test-Path Env:npm_config_optional) { Remove-Item Env:npm_config_optional }",
    "    $uninstallStage = 'uninstall'",
    "    # 显式固定 prefix：绕过 launcher 直接运行时 npm 会回落到 %APPDATA%\\npm，卸载会打空。",
    "    if ($npmPrefix) { $env:npm_config_prefix = $npmPrefix; $env:NPM_CONFIG_PREFIX = $npmPrefix }",
    `    Write-Host "[codeflowai] 正在卸载全局包 ${CLIENT_NPM_PACKAGE_NAME}..."`,
    "    $previousErrorActionPreference = $ErrorActionPreference",
    "    try {",
    '      $ErrorActionPreference = "Continue"',
    `      & $npmCommand uninstall -g ${CLIENT_NPM_PACKAGE_NAME} --no-audit --no-fund 2>&1 | ForEach-Object {`,
    "        $line = [string]$_",
    "        Write-Host $line",
    "        if ($uninstallTail.Count -ge 20) { [void]$uninstallTail.Dequeue() }",
    "        $uninstallTail.Enqueue($line)",
    "      }",
    "      $uninstallExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "    } finally {",
    "      $ErrorActionPreference = $previousErrorActionPreference",
    "    }",
    "    if ($uninstallExitCode -ne 0) {",
    "      $uninstallDetail = ($uninstallTail.ToArray() -join \"`n\").Trim()",
    "      if ($uninstallDetail.Length -gt 1500) { $uninstallDetail = $uninstallDetail.Substring($uninstallDetail.Length - 1500) }",
    "      $uninstallFailure = \"npm uninstall 退出码: $uninstallExitCode\"",
    "      if ($uninstallDetail) { $uninstallFailure = \"$uninstallFailure`n$uninstallDetail\" }",
    "      throw $uninstallFailure",
    "    }",
    "    $packageRemoved = $true",
    "    $uninstallStage = 'cleanup'",
    "    foreach ($launcher in $launcherPaths) {",
    "      if (Test-Path -LiteralPath $launcher -PathType Leaf) { Remove-Item -LiteralPath $launcher -Force -ErrorAction Stop }",
    "    }",
    "    # 仅在确认是绝对路径的启动器目录、且已空时才删除，避免相对路径被解析成当前目录。",
    "    if ($launcherDirectory -and [IO.Path]::IsPathRooted($launcherDirectory) -and (Test-Path -LiteralPath $launcherDirectory -PathType Container)) {",
    "      $remaining = @(Get-ChildItem -LiteralPath $launcherDirectory -Force -ErrorAction SilentlyContinue)",
    "      if ($remaining.Count -eq 0) { [IO.Directory]::Delete($launcherDirectory, $false) }",
    "    }",
    "    foreach ($entry in $pathEntries) { Remove-UserPathEntry $entry }",
    "    $uninstallStage = 'verify'",
    "    $leftover = @()",
    "    foreach ($candidate in @($packageDirectory) + $commandPaths + $launcherPaths) {",
    "      if (Test-Path -LiteralPath $candidate) { $leftover += $candidate }",
    "    }",
    "    if ($leftover.Count -gt 0) { throw \"卸载后仍存在残留：$($leftover -join ', ')\" }",
    '    Write-Host "[codeflowai] 卸载完成，用户数据目录未改动。"',
    "    $exitCode = 0",
    "  } catch {",
    "    $failureMessage = $_.Exception.Message",
    '    Write-Host "[codeflowai] 卸载失败: $failureMessage" -ForegroundColor Red',
    "    if ($stoppedDaemon -and -not $packageRemoved -and $codeflowCommand) {",
    '      Write-Host "[codeflowai] 正在尝试恢复启动原 Client..."',
    "      try {",
    "        & $codeflowCommand --daemon",
    "        $recoveryExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "        if ($recoveryExitCode -ne 0) { throw \"退出码: $recoveryExitCode\" }",
    '        Write-Host "[codeflowai] 原 Client 已恢复启动。"',
    "      } catch {",
    "        $recoveryMessage = \"Client 恢复启动失败: $($_.Exception.Message)\"",
    "        $failureMessage = \"$failureMessage；$recoveryMessage\"",
    '        Write-Host "[codeflowai] $recoveryMessage" -ForegroundColor Red',
    "      }",
    "    }",
    "  }",
    "",
    "  if ($exitCode -ne 0) {",
    "    $safeCause = $failureMessage -replace 'codeflowai_[A-Za-z0-9_]{16,128}', '[REDACTED]' -replace '(?i)Bearer\\s+[^\\s]+', 'Bearer [REDACTED]'",
    "    Write-Host (@{ code = 'CLIENT_UNINSTALL_FAILED'; requestId = $requestId; stage = $uninstallStage; packageDir = $packageDirectory; cause = $safeCause } | ConvertTo-Json -Compress)",
    "  }",
    "} finally {",
    "  $selfPath = $MyInvocation.MyCommand.Path",
    "  if ($selfPath -and (Test-Path -LiteralPath $selfPath)) {",
    "    try {",
    "      Remove-Item -LiteralPath $selfPath -Force -ErrorAction Stop",
    "    } catch {",
    '      Write-Host "[codeflowai] 临时卸载脚本清理失败: $($_.Exception.Message)" -ForegroundColor Red',
    "    }",
    "  }",
    "}",
    "exit $exitCode",
    "",
  ].join("\r\n");
}

export function buildWindowsUninstallLauncher(opts: WindowsUninstallLauncherOptions): { command: string; args: string[] } {
  const powershellExe = opts.powershellExe || "powershell.exe";
  const cmdExe = process.env.ComSpec || "cmd.exe";

  return {
    command: cmdExe,
    args: ["/c", "start", "", powershellExe, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", opts.scriptPath],
  };
}

/** 启动独立 PowerShell 窗口执行 Windows 自卸载，并返回临时脚本路径。 */
export function launchWindowsDetachedUninstall(opts: WindowsUninstallOptions): string {
  const scriptPath = path.join(os.tmpdir(), `codeflowai-uninstall-${Date.now()}-${Math.max(0, Math.trunc(opts.parentPid))}.ps1`);
  fs.writeFileSync(scriptPath, `\uFEFF${buildWindowsUninstallScript(opts)}`, "utf8");

  const powershellExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const launcher = buildWindowsUninstallLauncher({ powershellExe, scriptPath });
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    env: buildWindowsUninstallLauncherEnv(process.env),
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  if (!child.pid || child.pid <= 0) {
    const launchError = new Error("Windows 卸载启动器未获得有效进程");
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([launchError, cleanupError], `Windows 卸载启动失败且临时脚本清理失败：${scriptPath}`);
    }
    throw launchError;
  }

  return scriptPath;
}
