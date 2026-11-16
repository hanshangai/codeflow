import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readReleaseBundleFiles, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { buildShellInstaller } from "../scripts/build-shell-installer.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";
import { failure } from "./electron-packaged-protocol.smoke.mjs";
import { bounded } from "./support/packaged-app.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const prefix = "DESKTOP_CANDIDATE_INSTALL_SMOKE";
const shellId = "d13-candidate-install-20261027-01";
const sourceDeviceId = "11111111-1111-4111-8111-111111111111";
const launcherSha256 = "dd8ca3e11ebf58e8d8960153d06fa20f0038f680e6e2362c2e3f10e1e131fba2";
let commandTemp;
const pendingChildren = new Map();

/** 输入与输出双向分离，禁止向原工件或仓库写入证据。 */
function separate(left, right) {
  for (const relative of [path.relative(left, right), path.relative(right, left)]) {
    assert.ok(relative && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)), prefix + "_PATH_OVERLAP");
  }
}

/** 只接受全新仓库外输出和已展开的原签名活动包。 */
async function preflight(args) {
  assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
  assert.ok(args.length === 5 && args.every(value => typeof value === "string" && value.trim()),
    "用法：electron-candidate-shell-install.smoke.mjs <候选目录> <基线resources> <展开签名包目录> <冻结固定启动器> <新输出目录>");
  const [candidateDirectory, baseline, bundle] = await Promise.all(args.slice(0, 3).map(value => fs.realpath(path.resolve(value))));
  const launcher = await fs.realpath(path.resolve(args[3]));
  const requested = path.resolve(args[4]), root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  for (const input of [candidateDirectory, baseline, bundle]) {
    separate(input, root); separate(input, requested); separate(await fs.realpath(repository), input);
    assert.equal((await fs.lstat(input)).isDirectory(), true);
  }
  separate(launcher, root); separate(launcher, requested); separate(await fs.realpath(repository), launcher);
  assert.ok((await fs.lstat(launcher)).isFile()); assert.equal(await digest(launcher), launcherSha256, prefix + "_LAUNCHER_FREEZE_MISMATCH");
  separate(repository, root); separate(repository, requested);
  await assert.rejects(fs.lstat(root), { code: "ENOENT" });
  for (const file of ["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"]) {
    assert.equal((await fs.lstat(path.join(candidateDirectory, file))).isFile(), true);
  }
  for (const file of ["client/dist/index.cjs", "web/index.html", "release-trust.json"]) {
    assert.equal((await fs.lstat(path.join(baseline, file))).isFile(), true);
  }
  assert.deepEqual((await fs.readdir(bundle)).sort(), ["client", "manifest.json", "web"]);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path.join(bundle, "manifest.json"))));
  const trust = JSON.parse(await fs.readFile(path.join(candidateDirectory, "resources/release-trust.json"), "utf8"));
  verifyReleaseBundleSignature(manifest, trust); assert.equal(manifest.platform, "win32"); assert.equal(manifest.arch, "x64");
  assert.deepEqual(await readReleaseBundleFiles(bundle), manifest.files);
  return { candidateDirectory, baseline, bundle, launcher, root, manifest };
}

/** 摘要只读取普通物理文件，不保存业务正文或密钥。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 完整库存独立于构建器返回值，链接、硬链接及别名均显式拒绝。 */
async function inventory(root) {
  const result = [], directories = [root], spellings = new Map();
  while (directories.length) {
    const directory = directories.pop(), stat = await fs.lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), prefix + "_DIRECTORY_INVALID");
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name), relative = path.relative(root, file).replaceAll("\\", "/");
      const key = relative.toLowerCase(); assert.equal(spellings.has(key), false, prefix + "_PATH_ALIAS"); spellings.set(key, relative);
      const item = await fs.lstat(file); assert.equal(item.isSymbolicLink(), false, prefix + "_LINK_REJECTED");
      if (item.isDirectory()) directories.push(file);
      else {
        assert.ok(item.isFile() && item.nlink === 1, prefix + "_FILE_INVALID");
        result.push({ path: relative, size: item.size, sha256: await digest(file) });
      }
    }
  }
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** 保护多棵输入树和唯一固定入口文件，任何读取错误均停止验收。 */
async function inventories(roots) {
  const result = {};
  for (const [label, root] of Object.entries(roots)) {
    const stat = await fs.lstat(root);
    if (stat.isDirectory()) result[label] = await inventory(root);
    else {
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, prefix + "_INPUT_FILE_INVALID");
      result[label] = [{ path: path.basename(root), size: stat.size, sha256: await digest(root) }];
    }
  }
  return result;
}

/** 从 spawn 起登记未关闭的 PID，查询失败时也不能误报无残留。 */
function observeClose(child) {
  if (Number.isSafeInteger(child.pid)) pendingChildren.set(child.pid, child.spawnfile);
  let spawnError;
  return new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, signal) => { pendingChildren.delete(child.pid); resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) }); });
  });
}

/** CIM 失败仅用原子进程句柄清理，否则核已登记身份；各路径都等待真实 close。 */
async function closeAfterFailure(child, observed, close) {
  let knownError;
  try {
    if (observed === undefined) {
      if (pendingChildren.has(child.pid) && !child.kill()) throw new Error(prefix + "_CHILD_HANDLE_TERMINATE_FAILED");
    } else await stopOwned(observed);
  } catch (error) { knownError = error; }
  let exit;
  try {
    exit = await bounded(close, 15_000, prefix + "_CLEANUP_CLOSE_TIMEOUT"); if (exit.error) throw exit.error;
  } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_CLEANUP_CLOSE_FAILED"); }
  if (knownError) throw knownError;
  return exit;
}

/** 非交互 PowerShell 通过编码参数传脚本，不经过 shell 拼接路径。 */
async function powershell(script, timeoutMs = 30_000) {
  const source = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " + script;
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
    { windowsHide: true, env: { ...process.env, TEMP: commandTemp, TMP: commandTemp, TMPDIR: commandTemp },
      cwd: commandTemp, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const close = observeClose(child);
  let observed;
  try {
    if (!Number.isSafeInteger(child.pid)) { const exit = await close; throw exit.error ?? new Error(prefix + "_PROCESS_PID_INVALID"); }
    observed = await queryProcesses([child.pid]);
    const exit = await bounded(close, timeoutMs, prefix + "_POWERSHELL_TIMEOUT");
    if (exit.error) throw exit.error;
    assert.deepEqual(exit, { code: 0, signal: null }, prefix + "_POWERSHELL_FAILED: " + stderr);
    return stdout.trim();
  } catch (error) {
    try { await closeAfterFailure(child, observed, close); } catch (cleanup) { throw new AggregateError([error, cleanup], prefix + "_POWERSHELL_CLEANUP_FAILED"); }
    throw error;
  } finally { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
}

/** 固定脚本中的字符串使用 PowerShell 单引号规则转义。 */
function literal(value) { return "'" + value.replaceAll("'", "''") + "'"; }

/** 只读真实卸载项、协议键和快捷方式，正文仅存摘要，缺项明确记 absent。 */
async function externalSnapshot() {
  return JSON.parse(await powershell(`
    $result = [ordered]@{ registry = @(); shortcuts = @() }
    foreach ($hiveName in @('CurrentUser', 'LocalMachine')) {
      foreach ($viewName in @('Registry32', 'Registry64')) {
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hiveName, [Microsoft.Win32.RegistryView]::$viewName)
        try {
          $paths = @('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'Software\\CodeFlowAI', 'Software\\CodeFlow')
          $classes = $hive.OpenSubKey('Software\\Classes', $false)
          if ($null -ne $classes) { try { $paths += @($classes.GetSubKeyNames() | Where-Object { $_ -like 'codeflow*' } | ForEach-Object { 'Software\\Classes\\' + $_ }) } finally { $classes.Dispose() } }
          foreach ($keyPath in $paths) {
            $pending = [System.Collections.Generic.Stack[string]]::new(); $pending.Push($keyPath)
            while ($pending.Count -gt 0) {
              $current = $pending.Pop(); $key = $hive.OpenSubKey($current, $false)
              if ($null -eq $key) { $result.registry += [ordered]@{ hive = $hiveName; view = $viewName; path = $current; present = $false }; continue }
              try {
                $values = @($key.GetValueNames() | Sort-Object | ForEach-Object { [ordered]@{ name = $_; kind = $key.GetValueKind($_).ToString(); value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } })
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $values -Depth 20 -Compress)); $hash = [System.Security.Cryptography.SHA256]::Create()
                try { $sha = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
                $result.registry += [ordered]@{ hive = $hiveName; view = $viewName; path = $current; present = $true; sha256 = $sha }
                foreach ($name in ($key.GetSubKeyNames() | Sort-Object -Descending)) { $pending.Push($current + '\\' + $name) }
              } finally { $key.Dispose() }
            }
          }
        } finally { $hive.Dispose() }
      }
    }
    foreach ($folder in @('DesktopDirectory', 'CommonDesktopDirectory', 'StartMenu', 'CommonStartMenu')) {
      $directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
      if (-not $directory) { throw 'SHORTCUT_KNOWN_FOLDER_UNAVAILABLE' }
      $exists = Test-Path -LiteralPath $directory -PathType Container
      $files = @(); if ($exists) { $files = @(Get-ChildItem -LiteralPath $directory -File -Recurse -Filter '*.lnk' -ErrorAction Stop | Sort-Object FullName | ForEach-Object { [ordered]@{ path = $_.FullName; size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }) }
      $result.shortcuts += [ordered]@{ folder = $folder; directory = $directory; present = $exists; files = $files }
    }
    ConvertTo-Json -InputObject $result -Depth 25 -Compress
  `));
}

/** 读取实际进程令牌，管理员令牌与标准用户验收明确区分。 */
async function tokenSnapshot(pid) {
  return JSON.parse(await powershell(`
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class InstallSmokeToken {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  // Preserve token-read and all handle-close failures together.
  public static object[] Read(uint pid) {
    IntPtr process=OpenProcess(0x1000,false,pid); if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr token=IntPtr.Zero; object[] value=new object[3]; List<Exception> failures=new List<Exception>();
    try { if(!OpenProcessToken(process,8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr data=Marshal.AllocHGlobal(4); try { uint needed;
        if(!GetTokenInformation(token,18,data,4,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); value[0]=Marshal.ReadInt32(data);
        if(!GetTokenInformation(token,20,data,4,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); value[1]=Marshal.ReadInt32(data);
        using(WindowsIdentity identity=new WindowsIdentity(token)) { value[2]=identity.User.Value; }
      } finally { Marshal.FreeHGlobal(data); }
    } catch(Exception error) { failures.Add(error); }
    if(token!=IntPtr.Zero && !CloseHandle(token)) failures.Add(new Win32Exception(Marshal.GetLastWin32Error()));
    if(!CloseHandle(process)) failures.Add(new Win32Exception(Marshal.GetLastWin32Error()));
    if(failures.Count>0) throw new AggregateException("TOKEN_READ_FAILED",failures); return value;
  }
}
'@
    $values = [InstallSmokeToken]::Read(${pid}); $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try { $principal = [System.Security.Principal.WindowsPrincipal]::new($identity); ConvertTo-Json -Compress -InputObject ([ordered]@{ pid = ${pid}; elevationType = $values[0]; elevated = [bool]$values[1]; sid = $values[2]; observerSid = $identity.User.Value; observerAdministrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) }) } finally { $identity.Dispose() }
  `));
}

/** 从实际 PE manifest 资源读取运行级别，不以源码文本代替无提权请求证据。 */
async function installerExecutionLevel(file) {
  return JSON.parse(await powershell(`
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class InstallSmokeManifest {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
  // Load PE resources as data without executing the installer.
  public static byte[] Read(string file) {
    IntPtr module=LoadLibraryExW(file,IntPtr.Zero,0x22); if(module==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    byte[] bytes=null; List<Exception> failures=new List<Exception>();
    try { IntPtr resource=FindResourceW(module,new IntPtr(1),new IntPtr(24)); if(resource==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint length=SizeofResource(module,resource); if(length==0 || length>1048576) throw new InvalidOperationException("MANIFEST_SIZE_INVALID");
      IntPtr loaded=LoadResource(module,resource); if(loaded==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr data=LockResource(loaded); if(data==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      bytes=new byte[length]; Marshal.Copy(data,bytes,0,(int)length);
    } catch(Exception error) { failures.Add(error); }
    if(!FreeLibrary(module)) failures.Add(new Win32Exception(Marshal.GetLastWin32Error()));
    if(failures.Count>0) throw new AggregateException("MANIFEST_READ_FAILED",failures); return bytes;
  }
}
'@
    $bytes = [InstallSmokeManifest]::Read(${literal(file)})
    $encoding = [System.Text.UTF8Encoding]::new($false, $true); [xml]$manifest = $encoding.GetString($bytes).Trim([char]0).TrimStart([char]0xfeff)
    $entry = $manifest.SelectSingleNode("//*[local-name()='requestedExecutionLevel']"); if ($null -eq $entry) { throw 'MANIFEST_EXECUTION_LEVEL_MISSING' }
    ConvertTo-Json -Compress -InputObject ([ordered]@{ level = $entry.GetAttribute('level'); uiAccess = $entry.GetAttribute('uiAccess') })
  `));
}

/** 安装器子进程只继承系统启动变量，临时文件全部指向本次场景根。 */
async function installerEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|systemdrive|number_of_processors|processor_architecture|logonserver|userdomain|username)$/iu.test(key)));
  for (const key of ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    env[key] = path.join(root, key.toLowerCase()); await fs.mkdir(env[key]);
  }
  const homeRoot = path.parse(env.USERPROFILE).root;
  env.HOMEDRIVE = homeRoot.slice(0, -1); env.HOMEPATH = path.sep + path.relative(homeRoot, env.USERPROFILE);
  return env;
}

/** 安装器必须真实 close；超时只清理已登记身份，清理成功仍保留原失败。 */
async function executeInstaller(paths, name, args, inspectToken = false) {
  const root = path.join(paths.root, name); await fs.mkdir(root);
  const env = await installerEnvironment(root), child = spawn(paths.installer, args,
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const close = observeClose(child);
  let knownError, exit, token, observed;
  try {
    if (!Number.isSafeInteger(child.pid)) { const failed = await close; throw failed.error ?? new Error(prefix + "_PROCESS_PID_INVALID"); }
    observed = await queryProcesses([child.pid]);
    if (inspectToken) token = await tokenSnapshot(child.pid);
    exit = await bounded(close, 180_000, prefix + "_INSTALLER_TIMEOUT"); if (exit.error) throw exit.error;
  } catch (error) {
    knownError = error;
    try { exit = await closeAfterFailure(child, observed, close); } catch (cleanup) { knownError = new AggregateError([knownError, cleanup], prefix + "_INSTALLER_CLEANUP_FAILED"); }
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  const result = { pid: child.pid, args, exit, token, stdout, stderr, temporaryFiles: await inventory(root), ...(knownError ? { failure: failure(knownError) } : {}) };
  await fs.writeFile(path.join(root, "process.json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (knownError) throw knownError;
  assert.equal((await queryProcesses([child.pid])).length, 0, prefix + "_INSTALLER_PROCESS_REMAINED");
  return result;
}

/** 只有固定结构和精确阶段原因才算预期失败，不接受任意非零退出。 */
function assertRejection(result, expected) {
  assert.deepEqual(result.exit, { code: 1, signal: null });
  assert.equal(result.stdout.trim(), "");
  const rows = result.stderr.trim().split(/\r?\n/u).map(line => JSON.parse(line)); assert.equal(rows.length, 1);
  const fields = ["errorCode", "requestId", "rootCause", "shellId", "stage", "win32Error"];
  assert.deepEqual(Object.keys(rows[0]).filter(key => key !== "cleanupWin32Error").sort(), fields);
  if (Object.hasOwn(rows[0], "cleanupWin32Error")) {
    assert.ok(Number.isSafeInteger(rows[0].cleanupWin32Error) && rows[0].cleanupWin32Error > 0);
    throw Object.assign(new Error(prefix + "_INSTALLER_CLEANUP_DIAGNOSTIC"), { diagnostic: rows[0] });
  }
  assert.equal(rows[0].errorCode, "DESKTOP_SHELL_INSTALL_FAILED"); assert.equal(rows[0].shellId, shellId);
  assert.equal(rows[0].stage, expected.stage); assert.equal(rows[0].rootCause, expected.rootCause);
  assert.equal(rows[0].win32Error, expected.win32Error);
  assert.equal(rows[0].requestId, expected.requestId);
  return rows[0];
}

/** 合成旧壳哨兵只用于失败反例，不冒称其可运行业务。 */
async function negativeFixture(root, launcher) {
  const installation = path.join(root, "installation"); await fs.mkdir(path.join(installation, "shells"), { recursive: true });
  await fs.copyFile(launcher, path.join(installation, "CodeFlowAI.exe"));
  for (const role of ["baseline", "active"]) {
    const directory = path.join(installation, "shells", role); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "old-shell-sentinel.txt"), role + " must remain byte-identical\n", { encoding: "utf8", flag: "wx" });
  }
  await fs.writeFile(path.join(installation, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=active\r\nprevious=baseline\r\nbaseline=baseline\r\n", { encoding: "ascii", flag: "wx" });
  return installation;
}

/** ACL 仅用于全新反例 shells；恢复原 DACL，恢复失败与业务失败一起向上保留。 */
async function withDeniedWrite(directory, mode, operation) {
  await powershell(`$acl = Get-Acl -LiteralPath ${literal(directory)}; Set-Acl -LiteralPath ${literal(directory)} -AclObject $acl`);
  const original = await powershell(`(Get-Acl -LiteralPath ${literal(directory)}).Sddl`);
  const previous = JSON.parse(await powershell(`$entries = @(${literal(directory)}) + @(Get-ChildItem -LiteralPath ${literal(directory)} -Recurse -Force -ErrorAction Stop | ForEach-Object { $_.FullName }); ConvertTo-Json -Compress -InputObject @($entries | Sort-Object | ForEach-Object { [ordered]@{ path = $_; sddl = (Get-Acl -LiteralPath $_).Sddl } })`));
  let knownError, result;
  try {
    await powershell(`$acl = Get-Acl -LiteralPath ${literal(directory)}; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rights = [System.Security.AccessControl.FileSystemRights]::${mode === "create" ? "CreateDirectories" : "CreateFiles"}
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::${mode === "create" ? "None" : "ContainerInherit"}
      $propagation = [System.Security.AccessControl.PropagationFlags]::${mode === "create" ? "None" : "InheritOnly"}
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Deny)
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath ${literal(directory)} -AclObject $acl`);
    result = await operation();
  } catch (error) { knownError = error; }
  try {
    await powershell(`$acl = Get-Acl -LiteralPath ${literal(directory)}; $acl.SetSecurityDescriptorSddlForm(${literal(original)}, [System.Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath ${literal(directory)} -AclObject $acl`);
    assert.equal(await powershell(`(Get-Acl -LiteralPath ${literal(directory)}).Sddl`), original, prefix + "_ACL_RESTORE_MISMATCH");
    const actual = JSON.parse(await powershell(`$entries = @(${previous.map(entry => literal(entry.path)).join(",")}); ConvertTo-Json -Compress -InputObject @($entries | Sort-Object | ForEach-Object { [ordered]@{ path = $_; sddl = (Get-Acl -LiteralPath $_).Sddl } })`));
    assert.deepEqual(actual, previous, prefix + "_INHERITED_ACL_RESTORE_MISMATCH");
  } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_ACL_RESTORE_FAILED"); }
  if (knownError) throw knownError;
  return { result, originalSddl: original, originalAclEntries: previous, restored: true };
}

/** 在专属反例根验证参数、已有版本、父链 junction 与真实 Win32 写失败。 */
async function negativeScenarios(paths, report) {
  const root = path.join(paths.root, "negative"); await fs.mkdir(root);
  const installation = await negativeFixture(root, paths.launcher), before = await inventory(installation);
  const protectedFixtures = new Map([[installation, { before, allowCandidate: false }]]);
  let knownError;
  try {
  const requestId = crypto.randomUUID(), valid = ["--codeflow-candidate-install", "--installation-root", installation, "--request-id", requestId];
  for (const [name, args] of [["missing", []], ["unknown", [...valid, "--unknown"]], ["extra", [...valid, "unexpected"]],
    ["duplicate", [...valid, "--request-id", requestId]], ["legacy-D", [...valid, "/D=" + installation]]]) {
    const result = await executeInstaller(paths, name, args);
    const diagnostic = assertRejection(result, { stage: "arguments", rootCause: "ARGUMENTS_INVALID", win32Error: 0, requestId: "" });
    assert.deepEqual(await inventory(installation), before, prefix + "_ARGUMENTS_CHANGED_OLD_SHELL");
    report.scenarios.push({ name, status: "passed", diagnostic });
  }
  const target = path.join(installation, "shells", shellId); await fs.mkdir(target);
  for (const name of ["existing-empty", "existing-partial"]) {
    if (name === "existing-partial") await fs.writeFile(path.join(target, "partial-sentinel.txt"), "do not resume or overwrite\n", { encoding: "utf8", flag: "wx" });
    const pristine = await inventory(installation);
    protectedFixtures.set(installation, { before: pristine, allowCandidate: false });
    const result = await executeInstaller(paths, name, valid);
    const diagnostic = assertRejection(result, { stage: "create-target", rootCause: "TARGET_CREATE_FAILED", win32Error: 183, requestId });
    assert.deepEqual(await inventory(installation), pristine, prefix + "_EXISTING_TARGET_CHANGED");
    report.scenarios.push({ name, status: "passed", diagnostic });
  }
  const alias = path.join(root, "junction-parent"); await fs.symlink(root, alias, "junction");
  const aliasArgs = [...valid]; aliasArgs[2] = path.join(alias, "installation");
  const pristine = await inventory(installation), junction = await executeInstaller(paths, "junction-parent", aliasArgs);
  const diagnostic = assertRejection(junction, { stage: "root", rootCause: "PATH_REPARSE", win32Error: 0, requestId });
  assert.deepEqual(await inventory(installation), pristine, prefix + "_JUNCTION_CHANGED_TARGET");
  report.scenarios.push({ name: "junction-parent", status: "passed", diagnostic, retainedAlias: alias });
  for (const mode of ["create", "extract"]) {
    const directory = path.join(root, "denied-" + mode); await fs.mkdir(directory);
    const fixture = await negativeFixture(directory, paths.launcher), previous = await inventory(fixture), rejectedRequestId = crypto.randomUUID();
    protectedFixtures.set(fixture, { before: previous, allowCandidate: mode === "extract" });
    const result = await withDeniedWrite(path.join(fixture, "shells"), mode, async () => {
      const process = await executeInstaller(paths, "denied-" + mode,
        ["--codeflow-candidate-install", "--installation-root", fixture, "--request-id", rejectedRequestId]);
      return assertRejection(process, { stage: mode === "create" ? "create-target" : "extract",
        rootCause: mode === "create" ? "TARGET_CREATE_FAILED" : "PAYLOAD_WRITE_FAILED", win32Error: 5, requestId: rejectedRequestId });
    });
    const partial = path.join(fixture, "shells", shellId);
    let retainedFiles = [];
    if (mode === "create") await assert.rejects(fs.lstat(partial), { code: "ENOENT" });
    else { assert.equal((await fs.lstat(partial)).isDirectory(), true); retainedFiles = await inventory(partial); assert.deepEqual(retainedFiles, []); }
    const after = (await inventory(fixture)).filter(file => !file.path.startsWith("shells/" + shellId + "/"));
    assert.deepEqual(after, previous, prefix + "_WRITE_FAILURE_CHANGED_OLD_SHELL");
    const retainedDirectories = mode === "extract" ? JSON.parse(await powershell(`ConvertTo-Json -Compress -InputObject @(Get-ChildItem -LiteralPath ${literal(partial)} -Directory -Recurse -Force -ErrorAction Stop | Sort-Object FullName | ForEach-Object { $_.FullName })`)) : [];
    report.scenarios.push({ name: "denied-" + mode, status: "passed", acl: result, partialDirectoryRetained: mode === "extract", retainedFiles, retainedDirectories });
  }
  } catch (error) { knownError = error; }
  report.negativeProtection = [];
  for (const [directory, expected] of protectedFixtures) {
    try {
      const after = (await inventory(directory)).filter(file => !expected.allowCandidate || !file.path.startsWith("shells/" + shellId + "/"));
      assert.deepEqual(after, expected.before, prefix + "_NEGATIVE_OLD_SHELL_CHANGED");
      report.negativeProtection.push({ directory, oldShellsUnchanged: true });
    } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_NEGATIVE_SOURCE_CHECK_FAILED"); }
  }
  if (knownError) throw knownError;
}

/** 数据库只作本次合成任务哨兵，关闭错误不能覆盖原业务错误。 */
function database(file, options, operation) {
  const db = new DatabaseSync(file, options); let knownError, result;
  try { result = operation(db); } catch (error) { knownError = error; }
  try { db.close(); } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_DB_CLOSE_FAILED"); }
  if (knownError) throw knownError;
  return result;
}

/** 旧基线及活动绑定来自只读冻结包，源身份和任务仅使用合成哨兵。 */
async function healthyFixture(paths) {
  const installation = path.join(paths.root, "healthy-installation"), shells = path.join(installation, "shells");
  await fs.mkdir(shells, { recursive: true });
  await fs.copyFile(paths.launcher, path.join(installation, "CodeFlowAI.exe"));
  for (const role of ["baseline", "active"]) {
    await fs.cp(paths.candidateDirectory, path.join(shells, role), { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(await inventory(path.join(shells, role)), paths.files, prefix + "_OLD_SHELL_COPY_MISMATCH");
  }
  const baselineFiles = new Map((await inventory(path.join(shells, "baseline/resources"))).map(file => [file.path, file]));
  for (const file of await inventory(paths.baseline)) assert.deepEqual(baselineFiles.get(file.path), file, prefix + "_BASELINE_BINDING_MISMATCH");
  await fs.writeFile(path.join(installation, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=active\r\nprevious=baseline\r\nbaseline=baseline\r\n", { encoding: "ascii", flag: "wx" });
  const source = path.join(paths.root, "source-data"); await fs.mkdir(source);
  await fs.writeFile(path.join(source, "config.json"), JSON.stringify({ apiKey: "synthetic-must-not-use", serverWs: "ws://127.0.0.1:1", clientId: "source-sentinel" }) + "\n", { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(source, "device-identity.json"), JSON.stringify({ deviceId: sourceDeviceId, createdAt: "2026-10-27T00:00:00.000Z" }) + "\n", { encoding: "utf8", flag: "wx" });
  database(path.join(source, "codeflowai.db"), {}, db => {
    db.exec("PRAGMA user_version=92; CREATE TABLE scheduled_task_configs(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, payload_json TEXT NOT NULL)");
    db.prepare("INSERT INTO scheduled_task_configs VALUES(?, ?, ?)").run("must-not-run", 1, JSON.stringify({ command: "must-never-execute-source-task" }));
  });
  const releaseDir = path.join(source, "releases", paths.manifest.releaseId); await fs.mkdir(releaseDir, { recursive: true });
  for (const name of ["client", "web"]) await fs.cp(path.join(paths.bundle, name), path.join(releaseDir, name), { recursive: true, errorOnExist: true, force: false });
  await fs.copyFile(path.join(paths.bundle, "manifest.json"), path.join(releaseDir, "manifest.json"));
  for (const name of ["active-release.json", "previous-release.json"]) {
    await fs.writeFile(path.join(source, name), JSON.stringify({ releaseId: paths.manifest.releaseId }) + "\n", { encoding: "utf8", flag: "wx" });
  }
  return { installation, source, releaseDir };
}

/** 旧活动壳只运行 Node 持活哨兵，不启动应用、Client、数据库或真实任务。 */
async function oldShellSentinel(paths, fixture) {
  const root = path.join(paths.root, "old-shell-sentinel"); await fs.mkdir(root);
  const env = await installerEnvironment(root); env.ELECTRON_RUN_AS_NODE = "1";
  const script = "const timer=setInterval(()=>{},1000);process.stdin.once('data',()=>{clearInterval(timer);process.stdin.pause();});process.stdout.write('OLD_SHELL_READY\\n');";
  const child = spawn(path.join(fixture.installation, "shells/active/CodeFlowAI.exe"), ["-e", script],
    { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  const close = observeClose(child).then(exit => { closed = true; return exit; });
  const ready = new Promise(resolve => { child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("OLD_SHELL_READY\n")) resolve(); }); });
  child.stderr.on("data", chunk => { stderr += chunk; });
  let knownError, observed;
  try {
    if (!Number.isSafeInteger(child.pid)) { const failed = await close; throw failed.error ?? new Error(prefix + "_PROCESS_PID_INVALID"); }
    observed = await queryProcesses([child.pid]);
    await bounded(Promise.race([ready, close.then(exit => { throw Object.assign(new Error(prefix + "_OLD_SHELL_EXITED_EARLY"), { exit }); })]),
      30_000, prefix + "_OLD_SHELL_READY_TIMEOUT");
    assert.equal(observed.length, 1); assert.equal(closed, false);
  } catch (error) {
    knownError = error;
    try { await closeAfterFailure(child, observed, close); } catch (cleanup) { knownError = new AggregateError([knownError, cleanup], prefix + "_OLD_SHELL_START_CLEANUP_FAILED"); }
  }
  if (knownError) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw knownError; }
  return {
    observed,
    /** 同一创建时刻和父链必须在安装后仍存活。 */
    async assertAlive() {
      assert.equal(closed, false, prefix + "_OLD_SHELL_WAS_STOPPED");
      assert.deepEqual(await queryProcesses([child.pid]), observed, prefix + "_OLD_SHELL_IDENTITY_CHANGED");
    },
    /** 先身份核验再通过专用 stdin 关闭；异常才清理已登记身份。 */
    async stop() {
      let failure, exit;
      try {
        assert.deepEqual(await queryProcesses([child.pid]), observed, prefix + "_OLD_SHELL_STOP_IDENTITY_CHANGED");
        child.stdin.end("stop\n"); exit = await bounded(close, 10_000, prefix + "_OLD_SHELL_STOP_TIMEOUT");
        assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(stderr, "");
      } catch (error) {
        failure = error;
        try { exit = await closeAfterFailure(child, observed, close); } catch (cleanup) { failure = new AggregateError([failure, cleanup], prefix + "_OLD_SHELL_STOP_FAILED"); }
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (failure) throw failure;
      return { observed, exit, stdout, stderr, remainedAliveAcrossInstall: true };
    },
  };
}

/** 实际安装后的完整库存先验签校验，再执行原候选健康，始终保留旧启动状态。 */
async function healthyScenario(paths, report) {
  const fixture = await healthyFixture(paths), before = await inventories({ installation: fixture.installation, source: fixture.source });
  const candidate = path.join(fixture.installation, "shells", shellId);
  let knownError, installed, sentinel;
  try {
  sentinel = await oldShellSentinel(paths, fixture);
  const requestId = crypto.randomUUID(), processResult = await executeInstaller(paths, "healthy-process",
    ["--codeflow-candidate-install", "--installation-root", fixture.installation, "--request-id", requestId], true);
  assert.deepEqual(processResult.exit, { code: 0, signal: null }); assert.equal(processResult.stderr.trim(), ""); assert.equal(processResult.stdout.trim(), "");
  await sentinel.assertAlive();
  assert.equal(processResult.token.elevationType, report.token.elevationType); assert.equal(processResult.token.elevated, report.token.elevated);
  assert.equal(processResult.token.sid, report.token.sid);
  assert.deepEqual(await inventory(candidate), paths.files, prefix + "_EXTRACTED_INVENTORY_MISMATCH");
  const manifest = paths.shellManifest;
  const { verifyShellReleaseArtifact } = await import("../src/shellReleaseArtifact.ts");
  assert.deepEqual(await verifyShellReleaseArtifact({ manifest, trustedKeys: paths.trustedShellKeys, installerPath: paths.installer, candidateDirectory: candidate }), manifest);
  installed = await inventories({ installation: fixture.installation, source: fixture.source });
  assert.deepEqual(installed.source, before.source, prefix + "_INSTALL_CHANGED_SOURCE");
  assert.deepEqual(installed.installation.filter(file => !file.path.startsWith("shells/" + shellId + "/")), before.installation, prefix + "_INSTALL_CHANGED_OLD_SHELL");
  const temporaryParentDir = path.join(paths.root, "health-runs"); await fs.mkdir(temporaryParentDir);
  const { runCandidateShellHealth } = await import("../src/candidateShellHealth.ts");
  const health = await runCandidateShellHealth({ candidateExecutablePath: path.join(candidate, "CodeFlowAI.exe"), installationDir: fixture.installation,
    sourceDataDir: fixture.source, temporaryParentDir, timeoutMs: 90_000 });
  assert.equal(health.status, "passed"); assert.equal(health.candidateShellId, shellId);
  assert.deepEqual(health.checks.map(check => check.role), ["baseline", "active"]);
  assert.equal(path.resolve(health.checks[0].releaseDir), path.join(fixture.installation, "shells/baseline/resources"));
  assert.equal(health.checks[1].releaseId, paths.manifest.releaseId); assert.equal(path.resolve(health.checks[1].releaseDir), fixture.releaseDir);
  const databases = [];
  for (const [index, check] of health.checks.entries()) {
    assert.equal(check.childClosed, true); assert.equal(check.native.credentialsAccessed, false); assert.equal(check.native.ptyCreated, false);
    assert.equal(check.health.database, "ready"); assert.equal(check.health.dbSchemaVersion, 92); assert.equal(check.database.integrity, "ok"); assert.equal(check.database.schemaVersion, 92);
    assert.ok(check.web.files.length > 0);
    for (const name of ["keyring.win32-x64-msvc.node", "pty.node", "conpty.node", "conpty_console_list.node"]) assert.ok(check.native.loaded.some(file => path.basename(file) === name));
    for (const file of check.native.loaded) {
      const relative = path.relative(path.join(check.releaseDir, "client/node_modules"), file);
      assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), prefix + "_NATIVE_OUTSIDE_PACKAGE");
    }
    const data = path.join(health.temporaryRoot, "client-" + index), original = await inventory(data);
    const counts = database(path.join(data, "codeflowai.db"), { readOnly: true }, db => ({ tasks: db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_configs").get().count,
      runs: db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_runs").get().count, schema: db.prepare("PRAGMA user_version").get().user_version }));
    assert.deepEqual(counts, { tasks: 0, runs: 0, schema: 92 }); assert.deepEqual(await inventory(data), original);
    const identity = JSON.parse(await fs.readFile(path.join(data, "device-identity.json"), "utf8"));
    assert.equal(identity.schemaVersion, 1);
    assert.match(identity.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.notEqual(identity.deviceId, sourceDeviceId); assert.ok(!databases.some(item => item.deviceId === identity.deviceId));
    databases.push({ counts, deviceId: identity.deviceId });
  }
  report.scenarios.push({ name: "healthy-installed-candidate", status: "passed", requestId, process: processResult, manifest, health, databases, sourceUnchanged: true });
  } catch (error) { knownError = error; }
  if (sentinel) {
    try { report.oldShellSentinel = await sentinel.stop(); }
    catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_OLD_SHELL_FINALIZE_FAILED"); }
  }
  try {
    const after = await inventories({ installation: fixture.installation, source: fixture.source });
    assert.deepEqual(after.source, before.source, prefix + "_HEALTH_CHANGED_SOURCE");
    assert.deepEqual(after.installation.filter(file => !file.path.startsWith("shells/" + shellId + "/")), before.installation, prefix + "_OLD_SHELL_CHANGED");
    if (installed) assert.deepEqual(after, installed, prefix + "_HEALTH_CHANGED_INSTALLATION");
    report.healthyProtection = { sourceUnchanged: true, oldShellsUnchanged: true, installation: fixture.installation, source: fixture.source };
  } catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_HEALTH_SOURCE_CHECK_FAILED"); }
  if (knownError) throw knownError;
}

/** 本次根内残留先核父链，清理后仍失败，禁止影响未知用户进程。 */
async function assertNoProcesses(root) {
  if (pendingChildren.size) throw Object.assign(new Error(prefix + "_PROCESS_OWNERSHIP_UNKNOWN"), { processes: [...pendingChildren] });
  const matches = (await queryProcesses()).filter(item => {
    if (!item.executable) return false;
    const relative = path.relative(root, item.executable); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  });
  if (!matches.length) return;
  const error = Object.assign(new Error(prefix + "_OWNED_PROCESS_REMAINED"), { processes: matches });
  if (matches.some(item => item.parentPid !== process.pid && !matches.some(parent => parent.pid === item.parentPid))) {
    throw new AggregateError([error, new Error(prefix + "_PROCESS_OWNERSHIP_UNKNOWN")], prefix + "_CLEANUP_BLOCKED");
  }
  try { await stopOwned(matches); } catch (cleanup) { throw new AggregateError([error, cleanup], prefix + "_CLEANUP_FAILED"); }
  throw error;
}

/** 真实完整 NSIS 安装只发生在本次临时根；失败留现场且收尾错误显式聚合。 */
export async function run(args) {
  const paths = await preflight(args), roots = { candidate: paths.candidateDirectory, baseline: paths.baseline, bundle: paths.bundle, launcher: paths.launcher };
  const sourceBefore = await inventories(roots); await fs.mkdir(paths.root);
  commandTemp = path.join(paths.root, "command-temp"); await fs.mkdir(commandTemp);
  const report = { status: "running", requestId: crypto.randomUUID(), shellId, root: paths.root, sourceBefore, scenarios: [],
    boundary: "unsigned local NSIS; actual extraction only into fresh temporary installation roots; synthetic negative old-shell sentinels; no activation, real application installation, uninstallation or production",
    limitations: ["administrator session is not standard-user acceptance", "path checks do not promise a same-user hostile-race sandbox", "NSIS plugins may write only within isolated process TEMP/TMP; no claim of process-wide zero writes before validation"] };
  let knownError;
  try {
    report.externalBefore = await externalSnapshot(); report.token = await tokenSnapshot(process.pid);
    const temp = path.join(paths.root, "build-temp"); await fs.mkdir(temp);
    const saved = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map(key => [key, process.env[key]]));
    let built;
    try {
      for (const key of Object.keys(saved)) process.env[key] = temp;
      built = await buildShellInstaller({ candidateDirectory: paths.candidateDirectory, shellId,
        outputDir: path.join(paths.root, "installer-output"), cacheDir: path.join(paths.root, "installer-cache") });
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    assert.equal(built.shellId, shellId); assert.deepEqual(built.files, sourceBefore.candidate);
    paths.installer = built.executablePath; paths.files = built.files;
    report.build = { ...built, installerSha256: await digest(built.executablePath) };
    report.executionLevel = await installerExecutionLevel(built.executablePath);
    assert.deepEqual(report.executionLevel, { level: "asInvoker", uiAccess: "false" });
    assert.deepEqual(await inventories(roots), sourceBefore, prefix + "_BUILD_CHANGED_INPUT");
    const keys = crypto.generateKeyPairSync("ed25519"), stat = await fs.lstat(paths.installer);
    paths.shellManifest = signShellReleaseManifest({ schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId, version: "1.0.0-smoke",
      platform: "win32", arch: "x64", installerSha256: report.build.installerSha256, installerSize: stat.size, files: paths.files,
      createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-27T00:00:00.000Z", keyId: "smoke-temporary" }, keys.privateKey);
    paths.trustedShellKeys = { "smoke-temporary": keys.publicKey.export({ format: "pem", type: "spki" }).toString() };
    await fs.writeFile(path.join(paths.root, "shell-manifest.json"), JSON.stringify(paths.shellManifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(paths.root, "shell-trust.json"), JSON.stringify(paths.trustedShellKeys, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await healthyScenario(paths, report);
    await negativeScenarios(paths, report);
  } catch (error) { knownError = error; }
  try { report.sourceAfter = await inventories(roots); assert.deepEqual(report.sourceAfter, sourceBefore, prefix + "_INPUT_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_INPUT_CHECK_FAILED"); }
  try { report.externalAfter = await externalSnapshot(); assert.deepEqual(report.externalAfter, report.externalBefore, prefix + "_REGISTRY_OR_SHORTCUT_CHANGED"); }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_EXTERNAL_CHECK_FAILED"); }
  try { await assertNoProcesses(paths.root); report.ownedProcesses = 0; }
  catch (error) { knownError = new AggregateError([...(knownError ? [knownError] : []), error], prefix + "_PROCESS_CHECK_FAILED"); }
  report.status = knownError ? "failed" : "passed"; if (knownError) report.failure = failure(knownError);
  await fs.writeFile(path.join(paths.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ code: prefix, status: report.status, report: path.join(paths.root, "verification.json") }));
  if (knownError) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv.slice(2));
