import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import type { PreparedClientUpgradePackage } from "./clientUpgradePackage.js";

export type WindowsUpgradeOptions = {
  installUrl: string;
  parentPid: number;
  daemonWasRunning: boolean;
  targetVersion?: string;
  previousClientPid?: number | null;
  /** CLI 在旧 Client 仍运行时下载校验，独立升级器负责安装及最终清理。 */
  preparedPackage?: PreparedClientUpgradePackage;
  resultReport?: WindowsUpgradeResultReport | null;
  /** 判定命中的 npm 全局前缀；脚本据此显式固定安装目标，避免装到另一套安装。 */
  npmPrefix: string;
};

export type WindowsUpgradeResultReport = {
  url: string;
  upgradeId: string;
  token: string;
  fromVersion: string;
  toVersion: string;
};

export type WindowsUpgradeLauncherOptions = {
  powershellExe: string;
  scriptPath: string;
};

function escapePowerShellSingleQuoted(text: string): string {
  return text.replace(/'/g, "''");
}

/** 构造独立升级器环境，避免 daemon 子进程标记污染后续 codeflow --daemon。 */
export function buildWindowsUpgradeLauncherEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildClientChildProcessEnv(baseEnv);
}

/** 生成 Windows 自升级脚本，按调用方确认的 daemon 状态停止、安装、恢复并回报终态。 */
export function buildWindowsUpgradeScript(opts: WindowsUpgradeOptions): string {
  const parentPid = Number.isFinite(opts.parentPid) ? Math.max(0, Math.trunc(opts.parentPid)) : 0;
  const installUrl = escapePowerShellSingleQuoted(opts.installUrl);
  const reportUrl = escapePowerShellSingleQuoted(opts.resultReport?.url ?? "");
  const upgradeId = escapePowerShellSingleQuoted(opts.resultReport?.upgradeId ?? "");
  const reportToken = escapePowerShellSingleQuoted(opts.resultReport?.token ?? "");
  const fromVersion = escapePowerShellSingleQuoted(opts.resultReport?.fromVersion ?? "");
  const toVersion = escapePowerShellSingleQuoted(opts.resultReport?.toVersion ?? "");
  const expectedVersion = escapePowerShellSingleQuoted(opts.targetVersion ?? opts.resultReport?.toVersion ?? "");
  const npmPrefix = escapePowerShellSingleQuoted(opts.npmPrefix);
  const previousClientPid = Number.isInteger(opts.previousClientPid) && opts.previousClientPid! > 0 ? opts.previousClientPid : 0;
  const prepared = opts.preparedPackage;
  return [
    '$ErrorActionPreference = "Stop"',
    `$parentPid = ${parentPid}`,
    `$installUrl = '${installUrl}'`,
    `$daemonWasRunning = ${opts.daemonWasRunning ? "$true" : "$false"}`,
    `$npmPrefix = '${npmPrefix}'`,
    `$reportUrl = '${reportUrl}'`,
    `$upgradeId = '${upgradeId}'`,
    `$reportToken = '${reportToken}'`,
    `$fromVersion = '${fromVersion}'`,
    `$toVersion = '${toVersion}'`,
    "$exitCode = 1",
    "$expectedVersion = '" + expectedVersion + "'",
    "$previousClientPid = " + previousClientPid,
    "$requestId = [guid]::NewGuid().ToString()",
    "$failureMessage = $null",
    "$installCompleted = $false",
    "$stopAttempted = $false",
    "$upgradeStage = 'prepare'",
    `$hasPreparedPackage = ${prepared ? "$true" : "$false"}`,
    `$preparedDirectory = '${escapePowerShellSingleQuoted(prepared?.directory ?? "")}'`,
    `$preparedArchivePath = '${escapePowerShellSingleQuoted(prepared?.archivePath ?? "")}'`,
    `$preparedSha256 = '${escapePowerShellSingleQuoted(prepared?.sha256 ?? "")}'`,
    "$installTail = New-Object 'System.Collections.Generic.Queue[string]'",
    "$codeflowCommand = $null",
    "$npmCommand = $null",
    "$installExitCode = 1",
    "",
    "function Send-UpgradeResult {",
    "  param([string]$Phase, [string]$Message)",
    "  if (-not $reportUrl -or -not $upgradeId -or -not $reportToken) { return }",
    "  $body = @{ upgradeId = $upgradeId; phase = $Phase; message = $Message; fromVersion = $fromVersion; toVersion = $toVersion } | ConvertTo-Json -Compress",
    "  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  for ($attempt = 1; $attempt -le 3; $attempt++) {",
    "    try {",
    "      $response = Invoke-RestMethod -Method Post -Uri $reportUrl -Headers @{ 'X-Codeflow-Upgrade-Token' = $reportToken } -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec 10",
    "      if (-not $response.ok) { throw '升级结果回报未返回成功状态' }",
    "      return",
    "    } catch {",
    "      if ($attempt -ge 3) { throw }",
    "      Start-Sleep -Seconds 1",
    "    }",
    "  }",
    "}",
    "",
    "function Assert-PreparedClientPackagePath {",
    "  if (-not $hasPreparedPackage) { return }",
    "  if (-not [IO.Path]::IsPathRooted($preparedDirectory) -or -not [IO.Path]::IsPathRooted($preparedArchivePath)) { throw '升级临时包路径不是绝对路径' }",
    "  $directory = [IO.Path]::GetFullPath($preparedDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)",
    "  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)",
    "  if ([IO.Path]::GetDirectoryName($directory) -ne $tempRoot -or [IO.Path]::GetFileName($directory) -notmatch '^codeflow-client-upgrade-[a-zA-Z0-9]{6}$' -or [IO.Path]::GetFullPath($preparedArchivePath) -ne [IO.Path]::Combine($directory, 'client.tgz')) { throw '升级临时包路径不合法' }",
    "  foreach ($file in @($directory, $preparedArchivePath)) {",
    "    if (Test-Path -LiteralPath $file) {",
    "      if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时包路径不能是链接' }",
    "    }",
    "  }",
    "}",
    "",
    "function Assert-PreparedClientPackage {",
    "  if (-not $hasPreparedPackage) { return }",
    "  Assert-PreparedClientPackagePath",
    "  if (-not (Test-Path -LiteralPath $preparedArchivePath -PathType Leaf) -or $preparedSha256 -notmatch '^[a-f0-9]{64}$') { throw '升级包缺失或校验信息无效，未停止现有 Client' }",
    // 经 Node 从 PowerShell 7 启动 5.1 时可能继承不兼容的 PSModulePath；使用 .NET，不依赖 Get-FileHash 自动加载。
    "  $sha = [Security.Cryptography.SHA256]::Create()",
    "  $stream = $null",
    "  try {",
    "    $stream = [IO.File]::OpenRead($preparedArchivePath)",
    "    $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()",
    "  } finally {",
    "    if ($stream) { $stream.Dispose() }",
    "    $sha.Dispose()",
    "  }",
    "  if ($actual -ne $preparedSha256) { throw '升级包 SHA256 不匹配，未停止现有 Client' }",
    "  Write-Host '[codeflowai] 本地升级包 SHA256 校验通过，即将进入离线换包阶段。'",
    "}",
    "",
    "# 捕获原生命令输出必须显式按 UTF-8 解码：Node 以 UTF-8 写管道，而 PS 5.1 默认按 OEM 代码页",
    "# 解码，中文 message 会被误解并吞掉 JSON 的收尾引号，ConvertFrom-Json 随即报「传入的对象无效」。",
    "# 只在本次调用内生效，避免改变升级窗口自身的中文输出编码。",
    "function Invoke-CodeflowJsonCommand {",
    "  param([string]$CommandPath, [string[]]$CommandArguments)",
    "  $previousOutputEncoding = [Console]::OutputEncoding",
    "  $previousPipelineEncoding = $OutputEncoding",
    "  try {",
    "    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "    return (& $CommandPath @CommandArguments)",
    "  } finally {",
    "    [Console]::OutputEncoding = $previousOutputEncoding",
    "    $OutputEncoding = $previousPipelineEncoding",
    "  }",
    "}",
    "",
    "# 只选择一个真实应用路径；Client 固定到待升级 prefix，避免误停另一套安装。",
    "function Resolve-UpgradeApplication {",
    "  param([string]$Name, [string]$Directory = '')",
    "  if ($Directory) {",
    "    $commandPath = Join-Path $Directory $Name",
    "  } else {",
    "    $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1",
    "    $commandPath = [string]$command.Source",
    "  }",
    "  if (-not $commandPath -or -not [IO.Path]::IsPathRooted($commandPath) -or -not (Test-Path -LiteralPath $commandPath -PathType Leaf)) { throw \"升级命令路径无效: $Name\" }",
    "  return [IO.Path]::GetFullPath($commandPath)",
    "}",
    "",
    "function Assert-UpgradedClientVersion {",
    "  if (-not $codeflowCommand) { $script:codeflowCommand = Resolve-UpgradeApplication -Name 'codeflow.cmd' -Directory $npmPrefix }",
    "  if (-not $expectedVersion) { return }",
    "  $versionOutput = Invoke-CodeflowJsonCommand -CommandPath $codeflowCommand -CommandArguments @('--version')",
    "  if ($LASTEXITCODE -ne 0 -or (($versionOutput -join [Environment]::NewLine).Trim() -ne $expectedVersion)) { throw '升级后的 Client 版本与目标不一致' }",
    "}",
    "",
    "function Assert-UpgradedClientConnection {",
    "  $connectionOutput = Invoke-CodeflowJsonCommand -CommandPath $codeflowCommand -CommandArguments @('--connected')",
    "  if ($LASTEXITCODE -ne 0) { throw '升级后 Client 未确认连接服务器' }",
    "  $connection = ($connectionOutput -join [Environment]::NewLine) | ConvertFrom-Json",
    "  if ($connection.connected -isnot [bool] -or $connection.clientRunning -isnot [bool] -or $connection.supervisorRunning -isnot [bool] -or ($connection.clientPid -isnot [int] -and $connection.clientPid -isnot [long])) { throw '升级后连接状态字段类型无效' }",
    "  if ($connection.schemaVersion -ne 1 -or $connection.connected -ne $true -or $connection.clientRunning -ne $true -or $connection.supervisorRunning -ne $true -or $connection.clientPid -le 0 -or $connection.stage -notin @('ready', 'degraded')) { throw '升级后工作进程连接校验失败' }",
    "  if ($previousClientPid -gt 0 -and $connection.clientPid -eq $previousClientPid) { throw '升级后仍是原 Client 工作进程' }",
    "  if ($connection.stage -eq 'degraded') { Write-Host '[codeflowai] 新版已连接服务器，但部分模块异常；请查看 Client 日志。' }",
    "}",
    "",
    "try {",
    "  try {",
    "    Assert-PreparedClientPackage",
    "    if (-not [IO.Path]::IsPathRooted($npmPrefix)) { throw '升级目标 npm prefix 必须是绝对路径' }",
    "    $npmCommand = Resolve-UpgradeApplication -Name 'npm.cmd'",
    "    $npmVersion = Invoke-CodeflowJsonCommand -CommandPath $npmCommand -CommandArguments @('--version')",
    "    if ($LASTEXITCODE -ne 0 -or -not (($npmVersion -join [Environment]::NewLine).Trim())) { throw 'npm 命令验证失败，未停止后台 Client' }",
    "    if ($daemonWasRunning) {",
    "      $codeflowCommand = Resolve-UpgradeApplication -Name 'codeflow.cmd' -Directory $npmPrefix",
    "      $currentVersion = Invoke-CodeflowJsonCommand -CommandPath $codeflowCommand -CommandArguments @('--version')",
    "      if ($LASTEXITCODE -ne 0 -or -not (($currentVersion -join [Environment]::NewLine).Trim())) { throw '现有 Client 命令验证失败，未停止后台 Client' }",
    "    }",
    "    $deadline = [DateTime]::UtcNow.AddSeconds(30)",
    "    while ($parentPid -gt 0 -and (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {",
    "      Start-Sleep -Milliseconds 200",
    "    }",
    "    if ($parentPid -gt 0 -and (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {",
    "      throw \"Client 进程在 30 秒内未退出: pid=$parentPid\"",
    "    }",
    "    if ($daemonWasRunning) {",
    "      $upgradeStage = 'stop'",
    '      Write-Host "[codeflowai] 正在停止后台 Client，释放全局包文件锁..."',
    "      $stopExitCode = 1",
    "      $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)",
    "      do {",
    "        $stopAttempted = $true",
    "        & $codeflowCommand --stop",
    "        $stopExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "        if ($stopExitCode -ne 0 -and [DateTime]::UtcNow -lt $stopDeadline) {",
    '          Write-Host "[codeflowai] 后台 Client 仍在停止（codeflow --stop 退出码: $stopExitCode），500ms 后重试..."',
    "          Start-Sleep -Milliseconds 500",
    "        }",
    "      } while ($stopExitCode -ne 0 -and [DateTime]::UtcNow -lt $stopDeadline)",
    "      if ($stopExitCode -ne 0) { throw \"codeflow --stop 退出码: $stopExitCode（等待 supervisor 停止超时）\" }",
    "    }",
    "    Start-Sleep -Milliseconds 800",
    "    if (Test-Path Env:npm_config_disturl) { Remove-Item Env:npm_config_disturl }",
    "    if (Test-Path Env:npm_config_optional) { Remove-Item Env:npm_config_optional }",
    "    $upgradeStage = 'install'",
    "    # 显式固定 prefix：绕过 launcher 直接运行时 npm 会回落到 %APPDATA%\\npm，升级会装进另一套安装。",
    "    if ($npmPrefix) { $env:npm_config_prefix = $npmPrefix; $env:NPM_CONFIG_PREFIX = $npmPrefix }",
    "",
    prepared ? "    Write-Host '[codeflowai] 正在从已校验的本地包离线升级，不再下载 npm 依赖...'" : '    Write-Host "[codeflowai] 正在执行全局包原位升级..."',
    "    $previousErrorActionPreference = $ErrorActionPreference",
    "    try {",
    '      $ErrorActionPreference = "Continue"',
    "      & $npmCommand install -g --force --registry=https://registry.npmmirror.com --replace-registry-host=never --include=optional --no-audit --no-fund " + (prepared ? "--offline --ignore-scripts=false --update-notifier=false $preparedArchivePath" : "$installUrl") + " 2>&1 | ForEach-Object {",
    "        $line = [string]$_",
    "        Write-Host $line",
    "        if ($installTail.Count -ge 20) { [void]$installTail.Dequeue() }",
    "        $installTail.Enqueue($line)",
    "      }",
    "      $installExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "    } finally {",
    "      $ErrorActionPreference = $previousErrorActionPreference",
    "    }",
    "    if ($installExitCode -ne 0) {",
    "      $installDetail = ($installTail.ToArray() -join \"`n\").Trim()",
    "      if ($installDetail.Length -gt 1500) { $installDetail = $installDetail.Substring($installDetail.Length - 1500) }",
    "      $installFailure = \"npm install 退出码: $installExitCode\"",
    "      if ($installDetail) { $installFailure = \"$installFailure`n$installDetail\" }",
    "      throw $installFailure",
    "    }",
    "    $installCompleted = $true",
    "    $upgradeStage = 'version'",
    "    Assert-UpgradedClientVersion",
    "",
    "    if ($daemonWasRunning) {",
    "      $upgradeStage = 'restart'",
    '      Write-Host "[codeflowai] 正在启动升级后的后台 Client..."',
    "      & $codeflowCommand --daemon",
    "      $restartExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "      if ($restartExitCode -ne 0) { throw \"codeflow --daemon 退出码: $restartExitCode\" }",
    "      $upgradeStage = 'connection'",
    "      Assert-UpgradedClientConnection",
    "    }",
    '    Write-Host "[codeflowai] 升级完成。"',
    "    $exitCode = 0",
    "  } catch {",
    "    $failureMessage = $_.Exception.Message",
    '    Write-Host "[codeflowai] 升级失败: $failureMessage" -ForegroundColor Red',
    "    if ($stopAttempted -and $daemonWasRunning -and $codeflowCommand) {",
    '      Write-Host "[codeflowai] 正在尝试恢复启动原 Client..."',
    "      try {",
    "        & $codeflowCommand --daemon",
    "        $recoveryExitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 }",
    "        if ($recoveryExitCode -ne 0) { throw \"退出码: $recoveryExitCode\" }",
    "        if ($installCompleted) {",
    "          Assert-UpgradedClientVersion",
    "          Assert-UpgradedClientConnection",
    '          Write-Host "[codeflowai] 升级后的 Client 重试启动成功。"',
    "          $failureMessage = $null",
    "          $exitCode = 0",
    "        }",
    "      } catch {",
    "        $recoveryMessage = \"Client 恢复启动失败: $($_.Exception.Message)\"",
    "        $failureMessage = \"$failureMessage；$recoveryMessage\"",
    '        Write-Host "[codeflowai] $recoveryMessage" -ForegroundColor Red',
    "      }",
    "    }",
    "  }",
    "",
    "  try {",
    "    if ($exitCode -ne 0) {",
    "      $safeCause = $failureMessage -replace 'codeflowai_[A-Za-z0-9_]{16,128}', '[REDACTED]' -replace '(?i)Bearer\\s+[^\\s]+', 'Bearer [REDACTED]'",
    "      Write-Host (@{ code = 'CLIENT_UPGRADE_FAILED'; requestId = $requestId; upgradeId = $upgradeId; fromVersion = $fromVersion; toVersion = $expectedVersion; stage = $upgradeStage; cause = $safeCause } | ConvertTo-Json -Compress)",
    "    }",
    "    $reportPhase = if ($exitCode -eq 0) { 'success' } else { 'failed' }",
    "    $reportMessage = if ($exitCode -eq 0) { 'Client 升级完成' } else { $failureMessage }",
    "    Send-UpgradeResult -Phase $reportPhase -Message $reportMessage",
    "  } catch {",
    '    Write-Host "[codeflowai] 升级结果回报失败: $($_.Exception.Message)" -ForegroundColor Red',
    "    $exitCode = 1",
    "  }",
    "} finally {",
    "  if ($hasPreparedPackage) {",
    "    try {",
    "      Assert-PreparedClientPackagePath",
    "      if (Test-Path -LiteralPath $preparedArchivePath) { Remove-Item -LiteralPath $preparedArchivePath -Force -ErrorAction Stop }",
    "      if (Test-Path -LiteralPath $preparedDirectory) { [IO.Directory]::Delete($preparedDirectory, $false) }",
    "    } catch {",
    "      $cleanupCause = $_.Exception.Message -replace 'codeflowai_[A-Za-z0-9_]{16,128}', '[REDACTED]' -replace '(?i)Bearer\\s+[^\\s]+', 'Bearer [REDACTED]'",
    "      Write-Host (@{ code = 'CLIENT_UPGRADE_TEMP_CLEANUP_FAILED'; requestId = $requestId; toVersion = $expectedVersion; stage = 'cleanup'; cause = $cleanupCause } | ConvertTo-Json -Compress)",
    "    }",
    "  }",
    "  $selfPath = $MyInvocation.MyCommand.Path",
    "  if ($selfPath -and (Test-Path -LiteralPath $selfPath)) {",
    "    try {",
    "      Remove-Item -LiteralPath $selfPath -Force -ErrorAction Stop",
    "    } catch {",
    '      Write-Host "[codeflowai] 临时升级脚本清理失败: $($_.Exception.Message)" -ForegroundColor Red',
    "    }",
    "  }",
    "}",
    "exit $exitCode",
    "",
  ].join("\r\n");
}

export function buildWindowsUpgradeLauncher(opts: WindowsUpgradeLauncherOptions): { command: string; args: string[] } {
  const powershellExe = opts.powershellExe || "powershell.exe";
  const cmdExe = process.env.ComSpec || "cmd.exe";

  return {
    command: cmdExe,
    args: ["/c", "start", "", powershellExe, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", opts.scriptPath],
  };
}

/** 启动独立 PowerShell 窗口执行 Windows 自升级，并返回临时脚本路径。 */
export function launchWindowsDetachedUpgrade(opts: WindowsUpgradeOptions): string {
  const scriptPath = path.join(os.tmpdir(), `codeflowai-upgrade-${Date.now()}-${Math.max(0, Math.trunc(opts.parentPid))}.ps1`);
  fs.writeFileSync(scriptPath, `\uFEFF${buildWindowsUpgradeScript(opts)}`, "utf8");

  const powershellExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const launcher = buildWindowsUpgradeLauncher({ powershellExe, scriptPath });
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    env: buildWindowsUpgradeLauncherEnv(process.env),
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  if (!child.pid || child.pid <= 0) {
    const launchError = new Error("Windows 升级启动器未获得有效进程");
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([launchError, cleanupError], `Windows 升级启动失败且临时脚本清理失败：${scriptPath}`);
    }
    throw launchError;
  }

  return scriptPath;
}
