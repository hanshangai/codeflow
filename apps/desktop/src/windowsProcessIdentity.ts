import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export type ProcessIdentity = { pid: number; parentPid: number; created: number; executable: string; commandLine: string };
export type ProcessSnapshotContext = { known: readonly ProcessIdentity[]; timeoutMs?: number;
  preflight?: (processes: readonly ProcessIdentity[]) => readonly ProcessIdentity[] };

/** 暂缺字段共用原预算整次重查，完整样本返回前也核预算；待采实例消失或已见字段变化均失败。 */
export async function processSnapshot(context?: ProcessSnapshotContext): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32") throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_PLATFORM_UNSUPPORTED"), { code: "DESKTOP_SHELL_HEALTH_PLATFORM_UNSUPPORTED" });
  const known = new Map<number, ProcessIdentity>(), timeout = context?.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) invalid("IDENTITY_INVALID");
  for (const identity of structuredClone(context?.known ?? [])) {
    if (!validNumbers(identity, true) || !path.isAbsolute(identity.executable) || !identity.executable
      || typeof identity.commandLine !== "string" || known.has(identity.pid) && !sameIdentity(known.get(identity.pid)!, identity)) invalid("IDENTITY_INVALID");
    known.set(identity.pid, identity);
  }
  const deadline = Date.now() + timeout;
  const newPending = new Map<number, ProcessIdentity>();
  let pending: number[] = [];
  const script = "$ErrorActionPreference='Stop'\n$result=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and -not ($_.ParentProcessId -eq $PID -and $_.Name -ieq 'conhost.exe') } | ForEach-Object { $created=0;if($null -ne $_.CreationDate){$created=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()};@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$created;executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine} })\nConvertTo-Json -InputObject $result -Compress";
  while (true) {
    const queryTimeout = context ? deadline - Date.now() : 10_000;
    if (queryTimeout <= 0) queryIncomplete(pending, [...newPending.values()]);
    const result = await powershell(script, queryTimeout);
    let values: unknown;
    try { values = JSON.parse(result.replace(/^\uFEFF/u, "")); }
    catch (cause) { invalid("QUERY_INVALID", cause); }
    if (!Array.isArray(values) || values.length === 0) invalid("QUERY_INVALID");
    const seen = new Set<number>();
    for (const item of values) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !validNumbers(item, false)
        || typeof item.executable !== "string" || typeof item.commandLine !== "string" || seen.has(item.pid)) invalid("QUERY_INVALID");
      seen.add(item.pid);
    }
    pending = [];
    for (const identity of known.values()) {
      const actual = values.find(item => item.pid === identity.pid);
      if (!actual) continue;
      if (actual.parentPid !== identity.parentPid || actual.created !== identity.created
        || actual.executable && actual.executable !== identity.executable || actual.commandLine && actual.commandLine !== identity.commandLine) {
        const changedFields = ["parentPid", "created", "executable", "commandLine"].filter(field =>
          (field === "parentPid" || field === "created" || actual[field]) && actual[field] !== identity[field as keyof ProcessIdentity]);
        /** 错误诊断只暴露数值身份与原文哈希，比较条件仍由上方原入口负责。 */
        const project = (value: ProcessIdentity) => ({ parentPid: value.parentPid, created: value.created,
          executableSha256: createHash("sha256").update(value.executable, "utf8").digest("hex"),
          commandLineSha256: createHash("sha256").update(value.commandLine, "utf8").digest("hex") });
        throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED"), { code: "DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED", pid: identity.pid,
          processIdentityConflict: { pid: identity.pid, changedFields, expected: project(identity), actual: project(actual) } });
      }
      if (!actual.executable || identity.commandLine && !actual.commandLine) pending.push(identity.pid);
    }
    const candidates = context?.preflight?.(values) ?? [];
    for (const identity of newPending.values()) {
      const actual = values.find(item => item.pid === identity.pid);
      if (!actual) throw pendingFailure("PENDING_GONE", identity);
      if (actual.parentPid !== identity.parentPid || actual.created !== identity.created
        || identity.commandLine && actual.commandLine !== identity.commandLine
        || identity.executable && actual.executable !== identity.executable) throw pendingFailure("PENDING_CHANGED", actual);
      newPending.set(identity.pid, { ...actual });
    }
    for (const identity of candidates) if (!newPending.has(identity.pid)) newPending.set(identity.pid, { ...identity });
    pending.push(...[...newPending.values()].filter(identity => !identity.executable || !identity.commandLine).map(identity => identity.pid));
    const remaining = deadline - Date.now();
    if (remaining <= 0) queryIncomplete(pending, [...newPending.values()]);
    if (!pending.length) return values;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
}

/** 新待采错误沿既有库存诊断通道输出五字段摘要，不携带路径或命令原文。 */
function pendingFailure(reason: "PENDING_GONE" | "PENDING_CHANGED" | "PENDING_INCOMPLETE", identity: ProcessIdentity): Error {
  const code = `DESKTOP_SHELL_HEALTH_PROCESS_${reason}`;
  return Object.assign(new Error(code), { code, pid: identity.pid,
    inventoryFailure: { reason: "CHILD_IDENTITY_INVALID", pid: identity.pid, parentPid: identity.parentPid, created: identity.created,
      instanceSha256: createHash("sha256").update(JSON.stringify([identity.pid, identity.parentPid, identity.created, identity.executable, identity.commandLine]), "utf8").digest("hex") } });
}

/** 到期保留全部待采PID，并以原诊断链定位仍缺字段的新实例。 */
function queryIncomplete(pids: readonly number[], identities: readonly ProcessIdentity[]): never {
  const pending = identities.filter(identity => !identity.executable || !identity.commandLine);
  const cause = pending.length ? new AggregateError(pending.map(identity => pendingFailure("PENDING_INCOMPLETE", identity)), "DESKTOP_SHELL_HEALTH_PROCESS_PENDING_INCOMPLETE") : undefined;
  const code = "DESKTOP_SHELL_HEALTH_PROCESS_QUERY_INCOMPLETE";
  throw Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code, pids: [...pids] });
}

/** 停止前重核CIM与已持有句柄的创建时间；实例已消失可结束，PID复用必须失败。 */
export async function stopIdentity(identity: ProcessIdentity): Promise<void> {
  if (process.platform !== "win32") throw Object.assign(new Error("DESKTOP_SHELL_HEALTH_PLATFORM_UNSUPPORTED"), { code: "DESKTOP_SHELL_HEALTH_PLATFORM_UNSUPPORTED" });
  if (!identity || !validNumbers(identity, true) || typeof identity.executable !== "string" || !identity.executable
    || typeof identity.commandLine !== "string") invalid("IDENTITY_INVALID");
  const encoded = Buffer.from(JSON.stringify({ pid: identity.pid, parentPid: identity.parentPid, created: identity.created,
    executable: identity.executable, commandLine: identity.commandLine }), "utf8").toString("base64");
  await powershell("$ErrorActionPreference='Stop'\n$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'))|ConvertFrom-Json\n"
    + "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$r.pid)\nif($null -eq $p){exit 0}\n"
    + "if([int]$p.ParentProcessId -ne $r.parentPid -or ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $r.created -or $p.ExecutablePath -cne $r.executable -or $p.CommandLine -cne $r.commandLine){throw 'DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED'}\n"
    + "$owned=Get-Process -Id $r.pid\n$handle=$owned.Handle\nif(([DateTimeOffset]$owned.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $r.created){throw 'DESKTOP_SHELL_HEALTH_PROCESS_IDENTITY_CHANGED'}\n$owned.Kill()\nif(-not $owned.WaitForExit(5000)){throw 'DESKTOP_SHELL_HEALTH_PROCESS_CLEANUP_TIMEOUT'}");
}

/** 完整实例身份比较不放宽路径、父链、创建时间或命令行。 */
export function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.parentPid === right.parentPid && left.created === right.created
    && left.executable === right.executable && left.commandLine === right.commandLine;
}

/** 系统快照可含PID0；有副作用的停止请求必须有正PID和可验证创建时间。 */
function validNumbers(value: { pid?: unknown; parentPid?: unknown; created?: unknown }, stopping: boolean): boolean {
  return Number.isSafeInteger(value.pid) && (value.pid as number) >= (stopping ? 1 : 0)
    && Number.isSafeInteger(value.parentPid) && (value.parentPid as number) >= 0
    && Number.isSafeInteger(value.created) && (value.created as number) >= (stopping ? 1 : 0);
}

/** 系统工具调用有界，原错误交调用边界记录，不返回伪造的空结果。 */
async function powershell(script: string, timeout = 10_000): Promise<string> {
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return await new Promise<string>((resolve, reject) => execFile(executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout, maxBuffer: 4 * 1_048_576, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** 沿用候选健康已有错误码；共享边界仅补原因，不新增日志或清理策略。 */
function invalid(code: "QUERY_INVALID" | "IDENTITY_INVALID", cause?: unknown): never {
  const value = `DESKTOP_SHELL_HEALTH_PROCESS_${code}`;
  throw Object.assign(new Error(value, cause === undefined ? undefined : { cause }), { code: value });
}
