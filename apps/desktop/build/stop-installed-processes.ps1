param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [ValidateRange(0, 30)][int]$GracefulTimeoutSeconds = 8
)

$ErrorActionPreference = 'Stop'
$requestId = 'nsis-stop-' + [Guid]::NewGuid().ToString('N')
$owned = @{}
$root = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$rootExecutable = Join-Path $root 'CodeFlowAI.exe'
$shellPrefix = (Join-Path $root 'shells') + '\'
$encoding = New-Object Text.UTF8Encoding($false)

function Write-Diagnostic([string]$Code, [string]$Outcome, $ProcessId = $null, [string]$Cause = '') {
  $entry = @{ code = $Code; requestId = $requestId; stage = 'installation-process-stop'; outcome = $Outcome;
    installDirectory = $root; processId = $ProcessId; rootCause = $Cause }
  [IO.File]::AppendAllText($LogPath, (($entry | ConvertTo-Json -Compress) + [Environment]::NewLine), $encoding)
}

function Test-Root($Record) {
  if (-not $Record.ExecutablePath) { return $false }
  $executable = [string]$Record.ExecutablePath
  if ($executable.Equals($rootExecutable, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if (-not $executable.StartsWith($shellPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $relative = $executable.Substring($shellPrefix.Length)
  return $relative -match '^[^\\]+\\CodeFlowAI\.exe$'
}

function Add-Owned($Record) {
  $processId = [int]$Record.ProcessId
  $recordCreated = ([DateTimeOffset]$Record.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
  # A reused PID means the previous process exited; drop its handle and evaluate the new process.
  if ($owned.ContainsKey($processId)) {
    if ($owned[$processId].Created -eq $recordCreated) { return }
    $owned[$processId].Process.Dispose()
    $owned.Remove($processId)
  }
  $process = $null
  try {
    $process = [Diagnostics.Process]::GetProcessById($processId)
    $handle = $process.Handle
    if ($process.HasExited) { $process.Dispose(); return }
    $actualCreated = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    $actualPath = $process.MainModule.FileName
    # When the snapshot is stale, decide ownership from the live path so restarts neither fail nor kill unrelated processes.
    if ($actualCreated -ne $recordCreated -or -not $actualPath.Equals([string]$Record.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
      $Record = [PSCustomObject]@{ ExecutablePath = $actualPath }
      if (-not (Test-Root $Record)) { $process.Dispose(); return }
      $recordCreated = $actualCreated
    }
    $owned[$processId] = @{ Process = $process; Created = $recordCreated; IsRoot = (Test-Root $Record) }
  } catch {
    if ($process) {
      if ($process.HasExited) { $process.Dispose(); return }
      $process.Dispose()
    } elseif (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
    throw
  }
}

function Find-Owned {
  $snapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, Name)
  foreach ($record in $snapshot) {
    if ($record.Name -ieq 'CodeFlowAI.exe' -and -not $record.ExecutablePath) {
      $candidate = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
      if (-not $candidate) { continue }
      try {
        $handle = $candidate.Handle
        if ($candidate.HasExited) { continue }
        $record.ExecutablePath = $candidate.MainModule.FileName
        if (-not $record.ExecutablePath) { throw 'DESKTOP_INSTALL_PROCESS_PATH_UNAVAILABLE' }
      } catch {
        if ($candidate.HasExited) { continue }
        throw
      } finally { $candidate.Dispose() }
    }
    if (Test-Root $record) { Add-Owned $record }
  }
  do {
    $added = $false
    foreach ($record in $snapshot) {
      $parentId = [int]$record.ParentProcessId
      if ($owned.ContainsKey([int]$record.ProcessId) -or -not $owned.ContainsKey($parentId)) { continue }
      if ($record.Name -ieq 'CodeFlowAI.exe' -and -not (Test-Root $record)) { continue }
      $parent = $owned[$parentId]
      $childCreated = ([DateTimeOffset]$record.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
      if ($childCreated -lt $parent.Created) { continue }
      if ($parent.Process.HasExited -and $childCreated -ge ([DateTimeOffset]$parent.Process.ExitTime.ToUniversalTime()).ToUnixTimeMilliseconds()) { continue }
      $previousCount = $owned.Count
      Add-Owned $record
      if ($owned.Count -gt $previousCount) { $added = $true }
    }
  } while ($added)
}

try {
  Write-Diagnostic 'DESKTOP_INSTALL_PROCESS_STOP_STARTED' 'started'
  Find-Owned
  foreach ($entry in @($owned.Values)) {
    if (-not $entry.Process.HasExited -and $entry.IsRoot) { [void]$entry.Process.CloseMainWindow() }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($GracefulTimeoutSeconds)
  while (@($owned.Values | Where-Object { -not $_.Process.HasExited }).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  Find-Owned
  $targets = @($owned.Values | Sort-Object { if ($_.IsRoot) { 0 } else { 1 } })
  foreach ($entry in $targets) {
    $process = $entry.Process
    if ($process.HasExited) { continue }
    Write-Diagnostic 'DESKTOP_INSTALL_PROCESS_FORCED' 'started' $process.Id 'GRACEFUL_CLOSE_TIMEOUT'
    try { $process.Kill() } catch { if (-not $process.HasExited) { throw } }
  }
  foreach ($entry in $targets) {
    if (-not $entry.Process.WaitForExit(5000)) { throw 'DESKTOP_INSTALL_PROCESS_STOP_TIMEOUT' }
  }
  Find-Owned
  if (@($owned.Values | Where-Object { -not $_.Process.HasExited }).Count -gt 0) {
    throw 'DESKTOP_INSTALL_PROCESS_REMAINING'
  }
  Write-Diagnostic 'DESKTOP_INSTALL_PROCESSES_STOPPED' 'success'
  exit 0
} catch {
  try { Write-Diagnostic 'DESKTOP_INSTALL_PROCESS_STOP_FAILED' 'fail' $null $_.Exception.Message }
  catch { [Console]::Error.WriteLine('DESKTOP_INSTALL_PROCESS_STOP_DIAGNOSTIC_FAILED requestId=' + $requestId) }
  exit 1
} finally {
  foreach ($entry in $owned.Values) { $entry.Process.Dispose() }
}
