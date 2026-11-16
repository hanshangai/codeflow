import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { TerminalShellOption } from "@codeflowai/shared";
import { resolveCreateRequireBase } from "../utils/createRequireBase.js";
import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";

const ALLOWED_SHELLS_ENV = "CODEFLOWAI_TERMINAL_ALLOWED_SHELLS";
const nodeRequire = createRequire(resolveCreateRequireBase());

type ShellSpec = {
  executable: string;
  aliases: string[];
};

export type TerminalShellProbeResult = { ok: true } | { ok: false; reason: string };
export type TerminalShellProbe = (shell: string, cwd: string) => TerminalShellProbeResult;
export type TerminalShellProbeFailure = { shell: string; reason: string };
export type TerminalShellOptionsResult = {
  shells: TerminalShellOption[];
  unavailableShells: TerminalShellProbeFailure[];
};
export type NodePtySpawnHelperRepairResult = {
  checked: string[];
  repaired: string[];
};

export type TerminalLaunchResolution = {
  shell: string;
  cwd: string;
};

/** 解析终端启动参数，统一限制 shell 与 cwd 的安全边界。 */
export function resolveTerminalLaunchOptions(input: {
  workspacePath: string | null | undefined;
  shell?: string | null;
  cwd?: string | null;
}): TerminalLaunchResolution {
  return {
    shell: resolveTerminalShell(input.shell),
    cwd: resolveTerminalCwd(input.workspacePath, input.cwd),
  };
}

/** 解析终端 cwd：空值使用 workspace，非空值必须落在 workspace 内。 */
export function resolveTerminalCwd(workspacePath: string | null | undefined, requestedCwd?: string | null): string {
  const root = normalizeWorkspaceRoot(workspacePath);
  const raw = String(requestedCwd ?? "").trim();
  const target = raw ? (path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)) : root;
  assertInsideWorkspace(root, target);
  assertDirectoryExists(target);
  return target;
}

/** 解析终端 shell：空值使用 Client 本机默认 shell，非空值必须命中允许列表。 */
export function resolveTerminalShell(requestedShell?: string | null): string {
  const raw = normalizeShellInput(requestedShell);
  const specs = buildAllowedShellSpecs();
  const selected = raw ? findMatchingShellSpec(raw, specs) : resolveDefaultShellSpec(specs);
  if (!selected) {
    throw new Error(`未找到可用终端 Shell，请在 Client 本机配置 ${ALLOWED_SHELLS_ENV}`);
  }
  return selected.executable;
}

/** 校验自定义终端操作的 shell/cwd 字段，不改变原始配置内容。 */
export function validateTerminalActionDefinition(workspacePath: string, raw: unknown, index: number): void {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  try {
    const cwd = obj.cwd != null ? String(obj.cwd) : null;
    const shell = obj.shell != null ? String(obj.shell) : null;
    resolveTerminalCwd(workspacePath, cwd);
    if (String(shell ?? "").trim()) resolveTerminalShell(shell);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`终端操作 #${index + 1} 配置不合法：${message}`);
  }
}

/** 读取当前 Client 允许的 shell，可用于测试和诊断。 */
export function listAllowedTerminalShells(): string[] {
  return buildAllowedShellSpecs().map((spec) => spec.executable);
}

/** 列出当前 Client 本机允许的终端 Shell 选项，仅验证路径存在且可执行。 */
export function listAllowedTerminalShellOptions(): TerminalShellOption[] {
  return buildAllowedShellSpecs().map((spec) => ({
    value: spec.executable,
    label: labelTerminalShell(spec.executable),
  }));
}

/** 基于 node-pty 实际启动探测，列出指定 cwd 下真正可创建的 Shell。 */
export function listLaunchableTerminalShellOptions(input: {
  cwd: string;
  probe?: TerminalShellProbe;
}): TerminalShellOptionsResult {
  const cwd = resolveProbeCwd(input.cwd);
  const probe = input.probe ?? probeTerminalShellSpawn;
  const shells: TerminalShellOption[] = [];
  const unavailableShells: TerminalShellProbeFailure[] = [];

  for (const spec of buildAllowedShellSpecs()) {
    if (!input.probe && !shouldProbeTerminalShellWithPty()) {
      shells.push({ value: spec.executable, label: labelTerminalShell(spec.executable) });
      continue;
    }
    let result: TerminalShellProbeResult;
    try {
      result = probe(spec.executable, cwd);
    } catch (error) {
      result = { ok: false, reason: stringifyError(error) };
    }
    if (result.ok) {
      shells.push({ value: spec.executable, label: labelTerminalShell(spec.executable) });
    } else {
      unavailableShells.push({ shell: spec.executable, reason: result.reason });
    }
  }

  return { shells, unavailableShells };
}

/** 判断列表阶段是否需要真实 pty 探测；Windows 使用可执行检测避免 ConPTY helper 残留。 */
function shouldProbeTerminalShellWithPty(): boolean {
  return os.platform() !== "win32";
}

/** 用真实 pty 创建/关闭验证 shell 是否能在当前运行时启动。 */
export function probeTerminalShellSpawn(shell: string, cwd: string): TerminalShellProbeResult {
  try {
    repairNodePtyDarwinSpawnHelperExecutable();
    const ptyProcess = pty.spawn(shell, terminalProbeArgs(shell), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: buildClientChildProcessEnv(process.env) as Record<string, string>,
    });
    ptyProcess.kill();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: stringifyError(error) };
  }
}

/** 修复 macOS node-pty spawn-helper 执行位；node-pty 1.1.0 的 darwin 预编译包可能缺失该权限。 */
export function repairNodePtyDarwinSpawnHelperExecutable(): NodePtySpawnHelperRepairResult {
  if (os.platform() !== "darwin") return { checked: [], repaired: [] };
  const checked = resolveNodePtyDarwinSpawnHelperPaths();
  if (checked.length === 0) {
    throw new Error("未找到 node-pty macOS spawn-helper，终端无法启动；请重新安装 CodeFlowAI Client");
  }

  const repaired: string[] = [];
  for (const helperPath of checked) {
    if (ensureExecutableFile(helperPath)) repaired.push(helperPath);
  }
  return { checked, repaired };
}

/** 返回 macOS 受保护 cwd 的终端权限提示；非相关路径返回 null。 */
export function resolveMacOSProtectedTerminalCwdHint(cwd: string): string | null {
  if (process.platform !== "darwin") return null;
  const home = os.homedir();
  if (!home) return null;
  const relative = path.relative(path.resolve(home), path.resolve(cwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const top = relative.split(path.sep)[0]?.toLowerCase();
  if (top !== "desktop" && top !== "documents" && top !== "downloads") return null;
  return "当前工作目录位于 macOS 隐私保护目录，请给启动 CodeFlow Client 的终端或 Node 完整磁盘访问权限，或把 workspace 放到非受保护目录后重试";
}

/** 规范化 workspace 根目录，未知 workspace 不允许创建终端。 */
function normalizeWorkspaceRoot(workspacePath: string | null | undefined): string {
  const root = String(workspacePath ?? "").trim();
  if (!root) throw new Error("未知 workspaceId：终端只能在已注册 workspace 内创建");
  return path.resolve(root);
}

/** 规范化探测 cwd，并确保目录存在。 */
function resolveProbeCwd(cwd: string): string {
  const target = path.resolve(String(cwd ?? "").trim() || process.cwd());
  assertDirectoryExists(target);
  return target;
}

/** 生成探测参数，避免读取用户交互式 shell 配置产生副作用。 */
function terminalProbeArgs(shell: string): string[] {
  const base = path.basename(shell).toLowerCase();
  if (base === "cmd.exe" || base === "cmd") return ["/d"];
  if (base === "powershell.exe" || base === "powershell" || base === "pwsh.exe" || base === "pwsh") {
    return ["-NoLogo", "-NoProfile", "-NoExit"];
  }
  if (base === "bash.exe" || base === "bash") return ["--noprofile", "--norc"];
  if (base === "zsh") return ["-f"];
  if (base === "fish") return ["--no-config"];
  return [];
}

/** 查找当前 node-pty 安装中的 macOS spawn-helper 候选路径。 */
function resolveNodePtyDarwinSpawnHelperPaths(): string[] {
  const packageJsonPath = nodeRequire.resolve("node-pty/package.json");
  const packageRoot = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
  ];
  const prebuildsDir = path.join(packageRoot, "prebuilds");
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue;
      candidates.push(path.join(prebuildsDir, entry.name, "spawn-helper"));
    }
  }
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** 确保文件对当前进程可执行，必要时补齐执行位。 */
function ensureExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return false;
  } catch {
    // continue with chmod
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`读取 node-pty spawn-helper 状态失败：${filePath}：${stringifyError(error)}`);
  }

  try {
    fs.chmodSync(filePath, stat.mode | 0o755);
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    throw new Error(`node-pty macOS spawn-helper 不可执行且自动修复失败：${filePath}：${stringifyError(error)}`);
  }
}

/** 判断目标路径是否仍位于 workspace 内，防止字符串前缀绕过。 */
function assertInsideWorkspace(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error("非法终端工作目录：必须位于 workspace 内");
  }
}

/** 确保终端 cwd 存在且是目录，避免 node-pty 抛出底层 spawn 错误。 */
function assertDirectoryExists(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`终端工作目录不存在：${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`终端工作目录不是目录：${target}`);
}

/** 去掉输入两端空白和成对引号，只接受单个 shell 可执行文件。 */
function normalizeShellInput(value: unknown): string {
  let raw = String(value ?? "").trim();
  if (
    (raw.startsWith("\"") && raw.endsWith("\""))
    || (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

/** 构建 shell 允许列表：内置安全候选 + Client 本机显式配置。 */
function buildAllowedShellSpecs(): ShellSpec[] {
  const specs: ShellSpec[] = [];
  addBuiltinShellSpecs(specs);
  for (const configured of readConfiguredShells()) {
    addConfiguredShellSpec(specs, configured);
  }
  return specs;
}

/** 添加平台内置 shell 候选，路径不存在时跳过。 */
function addBuiltinShellSpecs(specs: ShellSpec[]): void {
  if (os.platform() === "win32") {
    const systemRoot = String(process.env.SystemRoot ?? "C:\\Windows").trim() || "C:\\Windows";
    addShellSpec(specs, process.env.COMSPEC, ["cmd.exe", "cmd"], { requireExists: true });
    addShellSpec(specs, path.join(systemRoot, "System32", "cmd.exe"), ["cmd.exe", "cmd"], { requireExists: true });
    addShellSpec(
      specs,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["powershell.exe", "powershell"],
      { requireExists: true },
    );
    addShellSpec(specs, findOnPath("pwsh.exe") ?? "", ["pwsh.exe", "pwsh"], { requireExists: true });
    for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      addShellSpec(specs, programFiles ? path.join(programFiles, "Git", "bin", "bash.exe") : "", ["bash.exe", "bash", "git-bash"], { requireExists: true });
    }
    return;
  }

  addShellSpec(specs, process.env.SHELL, ["default"], { requireExists: true });
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/fish", "/usr/bin/fish", "/bin/sh", "/usr/bin/sh"]) {
    addShellSpec(specs, candidate, [path.basename(candidate)], { requireExists: true });
  }
}

/** 读取 Client 本机允许 shell 配置。 */
function readConfiguredShells(): string[] {
  const raw = String(process.env[ALLOWED_SHELLS_ENV] ?? "").trim();
  if (!raw) return [];
  return raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}

/** 添加 Client 显式配置的 shell，配置错误时显式失败。 */
function addConfiguredShellSpec(specs: ShellSpec[], configured: string): void {
  const shell = normalizeShellInput(configured);
  if (!shell) return;
  if (path.isAbsolute(shell)) {
    if (!fs.existsSync(shell)) throw new Error(`${ALLOWED_SHELLS_ENV} 中的 shell 不存在：${shell}`);
    if (!isExecutableFile(shell)) throw new Error(`${ALLOWED_SHELLS_ENV} 中的 shell 不可执行：${shell}`);
    addShellSpec(specs, shell, [path.basename(shell)], { requireExists: true });
    return;
  }
  if (hasPathSeparator(shell)) {
    throw new Error(`${ALLOWED_SHELLS_ENV} 中的 shell 必须是绝对路径或 PATH 命令：${shell}`);
  }
  const resolved = findOnPath(shell);
  if (!resolved) throw new Error(`${ALLOWED_SHELLS_ENV} 中的 shell 未在 PATH 中找到：${shell}`);
  addShellSpec(specs, resolved, [shell, path.basename(resolved)], { requireExists: true });
}

/** 添加一个 shell 候选，并按规范化路径去重。 */
function addShellSpec(specs: ShellSpec[], value: unknown, aliases: string[], options: { requireExists: boolean }): void {
  const raw = normalizeShellInput(value);
  if (!raw) return;
  const executable = path.resolve(raw);
  if (options.requireExists && !isExecutableFile(executable)) return;
  const key = pathKey(executable);
  if (specs.some((spec) => pathKey(spec.executable) === key)) return;
  const aliasSet = new Set<string>();
  for (const alias of aliases) {
    const normalized = normalizeAlias(alias);
    if (normalized) aliasSet.add(normalized);
  }
  const base = normalizeAlias(path.basename(executable));
  if (base) aliasSet.add(base);
  specs.push({ executable, aliases: [...aliasSet] });
}

/** 判断候选 Shell 是否存在且可执行，避免把不可 spawn 的路径暴露给用户。 */
function isExecutableFile(executable: string): boolean {
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 生成 Shell 下拉选项的用户可读名称。 */
function labelTerminalShell(executable: string): string {
  const normalized = executable.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  if (base === "cmd.exe" || base === "cmd") return "CMD";
  if (base === "powershell.exe" || base === "powershell") return "PowerShell";
  if (base === "pwsh.exe" || base === "pwsh") return "PowerShell 7";
  if (base === "bash.exe" && normalized.includes("/git/")) return "Git Bash";
  if (base === "bash.exe" || base === "bash") return "Bash";
  if (base === "zsh") return "Zsh";
  if (base === "fish") return "Fish";
  if (base === "sh") return "sh";
  return path.basename(executable).replace(/\.exe$/i, "");
}

/** 根据请求值匹配允许列表中的 shell。 */
function findMatchingShellSpec(raw: string, specs: ShellSpec[]): ShellSpec | null {
  const requestedPathKey = path.isAbsolute(raw) ? pathKey(path.resolve(raw)) : null;
  const requestedAlias = !hasPathSeparator(raw) ? normalizeAlias(raw) : "";
  for (const spec of specs) {
    if (requestedPathKey && pathKey(spec.executable) === requestedPathKey) return spec;
    if (requestedAlias && spec.aliases.includes(requestedAlias)) return spec;
  }
  throw new Error(`非法终端 Shell：${raw} 不在 Client 本机允许列表；如需自定义请配置 ${ALLOWED_SHELLS_ENV}`);
}

/** 选择 Client 默认 shell，并确保它也在允许列表内。 */
function resolveDefaultShellSpec(specs: ShellSpec[]): ShellSpec | null {
  const detected = os.platform() === "win32"
    ? String(process.env.COMSPEC ?? "").trim()
    : String(process.env.SHELL ?? readUserLoginShell()).trim();
  if (detected) {
    const requested = normalizeShellInput(detected);
    const matched = specs.find((spec) => pathKey(spec.executable) === pathKey(path.resolve(requested)));
    if (matched) return matched;
  }
  return specs[0] ?? null;
}

/** Finder 启动的 macOS 应用可能没有 SHELL；从系统用户信息读取登录 shell。 */
function readUserLoginShell(): string {
  try { return String(os.userInfo().shell ?? "").trim(); }
  catch { return ""; }
}

/** 按 PATH 查找裸命令，避免用终端 cwd 参与 Windows 可执行搜索。 */
function findOnPath(command: string): string | null {
  const pathEnv = String(process.env.PATH ?? "");
  if (!pathEnv.trim()) return null;
  const names = executableNames(command);
  for (const dir of pathEnv.split(path.delimiter)) {
    const root = dir.trim();
    if (!root || !path.isAbsolute(root)) continue;
    for (const name of names) {
      const candidate = path.resolve(root, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 生成当前平台可能的可执行文件名集合。 */
function executableNames(command: string): string[] {
  if (os.platform() !== "win32") return [command];
  const ext = path.extname(command);
  if (ext) return [command];
  const pathext = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((item) => item.trim()).filter(Boolean);
  return pathext.map((item) => `${command}${item.toLowerCase()}`);
}

/** 判断 shell 字符串是否包含路径分隔符。 */
function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** 规范化路径 key；Windows 下 shell 路径大小写不敏感。 */
function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return os.platform() === "win32" ? normalized.toLowerCase() : normalized;
}

/** 规范化 shell 别名。 */
function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

/** 将未知异常转成稳定字符串，供 API 响应和日志记录。 */
function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
