import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AccessMode, ExecutableToolDescriptor, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";

import { ManagedServiceRuntime, MANAGED_SERVICE_TOOL_ID } from "./managedServiceRuntime.js";
import { RuntimeEvidenceService } from "./runtimeEvidenceService.js";
import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import { assertSkillRuntimeWorkingDirectory, type SkillRuntimeExecutionContext } from "./skillRuntimePackage.js";
import { assertWorkspaceCodeflowaiDirectory, ensureWorkspaceCodeflowaiDirectory, isWorkspaceCodeflowaiFileDeviceMatch, type WorkspaceCodeflowaiDirectoryIdentity } from "../codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude } from "../git/workspacePrivateRuntimeGitExclude.js";

export type ToolExecutionResult =
  | {
      ok: true;
      toolId: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
      output: unknown;
    }
  | {
      ok: false;
      toolId: string;
      code:
        | "TOOL_NOT_FOUND"
        | "TOOL_INPUT_INVALID"
        | "TOOL_RUNTIME_UNSUPPORTED"
        | "TOOL_PERMISSION_DENIED"
        | "TOOL_EXECUTION_FAILED"
        | "TOOL_OUTPUT_INVALID"
        | "TOOL_TIMEOUT";
      message: string;
      stage: "validating" | "executing" | "parsing";
      retryable: boolean;
      stdout?: string | null;
      stderr?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    };

export class ToolRuntimeService {
  /** 固定持久工作区能力；内建工具保留原 owner，不要求仍存在父 thread。 */
  constructor(
    private readonly workspacePath: string,
    private readonly builtinRuntimes: {
      db: Pick<ClientDb, "workspaces" | "threads" | "orchInstances" | "writeWorkspaceLog">;
      workspaceId?: WorkspaceId | null;
      runtimeEvidence?: RuntimeEvidenceService | null;
      managedServices?: ManagedServiceRuntime | null;
      instanceId?: string | null;
      threadId?: string | null;
      nodeId?: string | null;
      attemptId?: string | null;
      withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
    },
  ) {}

  /** 工作区校验和失败诊断持同步许可，脚本进程等待由原执行 owner 承担。 */
  private async withDatabase<T>(requestId: string, operation: () => T): Promise<T> {
    return this.builtinRuntimes.withLegacyDatabase ? this.builtinRuntimes.withLegacyDatabase(requestId, operation) : operation();
  }

  /** 每次脚本在可信工作区独占运行树中准备；成功、失败均保留文件供手动清理。 */
  async execute(
    tool: ExecutableToolDescriptor,
    input: unknown,
    accessMode: AccessMode,
    context?: { requestId: string; turnId?: string },
  ): Promise<ToolExecutionResult> {
    const permissionError = this.validatePermissions(tool, accessMode);
    if (permissionError) return permissionError;
    const inputValidation = validateAgainstSchema(tool.inputSchema ?? null, input);
    if (!inputValidation.ok) {
      return {
        ok: false,
        toolId: tool.toolId,
        code: "TOOL_INPUT_INVALID",
        message: inputValidation.message,
        stage: "validating",
        retryable: false,
      };
    }
    if (tool.runtime === "prompt") {
      return {
        ok: false,
        toolId: tool.toolId,
        code: "TOOL_RUNTIME_UNSUPPORTED",
        message: `工具 ${tool.name} 仍是历史 prompt 型工具，不能作为真实执行工具运行`,
        stage: "validating",
        retryable: false,
      };
    }
    if (tool.runtime === "builtin") {
      const startedAt = Date.now();
      try {
        const toolId = String(tool.toolId ?? "");
        let output: unknown;
        if (toolId === MANAGED_SERVICE_TOOL_ID) {
          if (!this.builtinRuntimes.managedServices) {
            throw new Error(`当前上下文未挂载进程能力：${toolId}`);
          }
          if (!this.builtinRuntimes.threadId) {
            throw new Error(`当前上下文缺少聊天窗口 ID，无法执行进程工具：${toolId}`);
          }
          output = await this.builtinRuntimes.managedServices.executeBuiltinTool(tool, input, {
            workspacePath: this.workspacePath,
            instanceId: (this.builtinRuntimes.instanceId as any) ?? null,
            threadId: this.builtinRuntimes.threadId as any,
          });
        } else if (toolId.startsWith("runtime.")) {
          if (!this.builtinRuntimes.runtimeEvidence) {
            throw new Error(`当前上下文未挂载实例运行证据能力：${toolId}`);
          }
          output = await this.withDatabase(context?.requestId ?? `runtime-evidence:${toolId}`, () => this.builtinRuntimes.runtimeEvidence!.executeBuiltinTool(tool, input));
        } else {
          throw new Error(`未知内建工具：${toolId || "(empty)"}`);
        }
        return {
          ok: true,
          toolId: tool.toolId,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          output,
        };
      } catch (error) {
        return {
          ok: false,
          toolId: tool.toolId,
          code: "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          stage: "executing",
          retryable: false,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const requestId = `tool-runtime:${randomUUID()}`;
    const executionContext = { workspaceId: this.builtinRuntimes.workspaceId!, requestId,
      parentRequestId: context?.requestId ?? null, turnId: context?.turnId ?? null,
      instanceId: this.builtinRuntimes.instanceId ?? null, threadId: this.builtinRuntimes.threadId ?? null,
      nodeId: this.builtinRuntimes.nodeId ?? null, attemptId: this.builtinRuntimes.attemptId ?? null };
    let runtimeDirectory: string | null = null;
    let operationFailed = false;
    let operationError: unknown;
    let errorCode = "TOOL_RUNTIME_PREPARATION_FAILED";
    let phase = "prepare";
    let validatingWorkingDirectory = false;
    let pid: number | null = null;
    try {
      const workspaceIdentity = this.builtinRuntimes.withLegacyDatabase
        ? await this.withDatabase(requestId, () => this.assertScriptWorkspace()) : this.assertScriptWorkspace();
      validatingWorkingDirectory = true;
      const resolveDirectory = () => resolveWorkingDirectory(this.workspacePath, tool.workingDirectory, {
        db: this.builtinRuntimes.db, ...executionContext,
        toolId: tool.toolId,
        skillId: String(tool.toolsetId).startsWith("skill-toolset:") ? String(tool.toolsetId).slice("skill-toolset:".length) : null,
      });
      const cwd = this.builtinRuntimes.withLegacyDatabase ? await this.withDatabase(requestId, resolveDirectory) : resolveDirectory();
      validatingWorkingDirectory = false;
      const root = ensureWorkspaceCodeflowaiDirectory(this.workspacePath);
      if (toolRuntimePathKey(root.workspaceRoot) !== toolRuntimePathKey(path.resolve(this.workspacePath))
        || root.workspaceDev !== workspaceIdentity.dev || root.workspaceIno !== workspaceIdentity.ino) throw new Error("工具工作区在准备期间已被替换");
      const runName = randomUUID();
      ensureWorkspacePrivateRuntimeGitExclude(root.workspaceRoot, ["input.json", "tool.mjs", "tool.py", "tool.ps1", "tool.sh", "ToolMain.java", "ToolMain.class", "tool-java.ps1"].map(name => `tool-runtime/${runName}/${name}`));
      assertWorkspaceCodeflowaiDirectory(root);
      const parent = path.join(root.directoryPath, "tool-runtime");
      try { fs.mkdirSync(parent); } catch (error) {
        if (ownData(error, "code")?.value !== "EEXIST") throw error;
      }
      const parentIdentity = inspectToolRuntimeDirectory(parent);
      assertWorkspaceCodeflowaiDirectory(root);
      runtimeDirectory = path.join(parent, runName);
      fs.mkdirSync(runtimeDirectory);
      const directory: ToolRuntimeDirectory = { root, parent, parentIdentity, path: runtimeDirectory,
        identity: inspectToolRuntimeDirectory(runtimeDirectory), files: new Map() };
      assertToolRuntimeDirectory(directory);
      const inputPath = writeToolRuntimeFile(directory, "input.json", JSON.stringify(input ?? null, null, 2));
      const env = buildToolEnv({
        workspacePath: this.workspacePath,
        tool,
        input,
        inputPath,
      });
      const startedAt = Date.now();
      const command = buildCommand(tool, directory);
      assertToolRuntimeDirectory(directory);
      phase = "process_close";
      const execution = await executeCommand(command, {
        cwd,
        env,
        timeoutMs: Math.max(1_000, Number(tool.timeoutMs ?? 60_000)),
      });
      pid = execution.pid;
      const processFailure = execution.failure ? Object.assign(new Error(`${execution.failure.code} [requestId=${requestId}]`, { cause: execution.failure.cause }), {
        ...executionContext, code: execution.failure.code, toolId: tool.toolId, workspacePath: this.workspacePath,
        skillId: String(tool.toolsetId).startsWith("skill-toolset:") ? String(tool.toolsetId).slice("skill-toolset:".length) : null,
        pid, timedOut: execution.timedOut, stage: "executing", retryable: false, retainedDirectory: runtimeDirectory,
      }) : undefined;
      try { assertToolRuntimeDirectory(directory); } catch (identityFailure) {
        errorCode = "TOOL_RUNTIME_IDENTITY_FAILED";
        phase = "verify";
        if (processFailure) throw new AggregateError([processFailure, identityFailure], errorCode, { cause: processFailure });
        throw identityFailure;
      }
      if (processFailure) {
        errorCode = processFailure.code;
        throw processFailure;
      }
      const durationMs = Date.now() - startedAt;
      if (!execution.ok) {
        const failure: ToolExecutionResult = {
          ok: false,
          toolId: tool.toolId,
          code: "TOOL_EXECUTION_FAILED",
          message: `工具 ${tool.name} 执行失败${execution.exitCode == null ? "" : ` (exit=${execution.exitCode})`}`,
          stage: "executing",
          retryable: false,
          stdout: execution.stdout,
          stderr: execution.stderr,
          exitCode: execution.exitCode,
          durationMs,
        };
        operationFailed = true;
        operationError = Object.assign(new Error(failure.message), failure);
        errorCode = failure.code;
        phase = "execute";
        return failure;
      }
      const output = parseToolOutput(tool.outputSchema ?? null, execution.stdout);
      if (!output.ok) {
        const failure: ToolExecutionResult = {
          ok: false,
          toolId: tool.toolId,
          code: "TOOL_OUTPUT_INVALID",
          message: output.message,
          stage: "parsing",
          retryable: false,
          stdout: execution.stdout,
          stderr: execution.stderr,
          exitCode: execution.exitCode,
          durationMs,
        };
        operationFailed = true;
        operationError = Object.assign(new Error(failure.message), failure);
        errorCode = failure.code;
        phase = "parse";
        return failure;
      }
      return {
        ok: true,
        toolId: tool.toolId,
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        durationMs,
        output: output.output,
      };
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      if (operationFailed) {
        const context = { ...executionContext, toolId: tool.toolId,
          skillId: String(tool.toolsetId).startsWith("skill-toolset:") ? String(tool.toolsetId).slice("skill-toolset:".length) : null,
          workspacePath: this.workspacePath, pid,
          retainedDirectory: runtimeDirectory,
          stage: phase === "parse" ? "parsing" : "executing", retryable: false };
        try {
          // Skill 校验由原 owner 记录；运行树始终保留，不二次诊断。
          if (!(validatingWorkingDirectory && ["SKILL_RUNTIME_PACKAGE_INVALID", "SKILL_RUNTIME_FAILURE_LOG_FAILED"].includes(ownData(operationError, "code")?.value))) {
            const diagnostic = toToolFailureLogValue(operationError);
            (await this.withDatabase(requestId, () => this.builtinRuntimes.db.writeWorkspaceLog(executionContext.workspaceId, { level: "error", tag: "tool-runtime",
              message: "工具准备或执行失败；运行文件保留，勿自动重跑已执行的脚本", data: {
              ...context, code: errorCode, errorCode, phase,
              event: { category: "tool", action: phase, outcome: "fail" },
              operationCause: diagnostic, rootCause: diagnostic,
            } })));
          }
        } catch (loggingError) {
          throw Object.assign(new AggregateError([operationError, loggingError], `${errorCode} [requestId=${requestId}]`, { cause: operationError }), {
            code: errorCode, ...context,
          });
        }
      }
    }
  }

  /** 脚本副作用前校验持久归属和注册物理路径，返回后续复核所需的根身份。 */
  private assertScriptWorkspace(): fs.Stats {
    const { db, workspaceId, threadId, instanceId } = this.builtinRuntimes;
    const workspace = workspaceId ? db.workspaces.get(workspaceId) : null;
    const identity = fs.lstatSync(this.workspacePath);
    /** Windows 注册根比较忽略大小写，真实路径仍必须与执行根一致。 */
    const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!workspace || key(workspace.path) !== key(this.workspacePath) || key(fs.realpathSync.native(workspace.path)) !== key(this.workspacePath)
      || threadId && db.threads.get(threadId as any)?.workspaceId !== workspace.id
      || instanceId && db.orchInstances.get(instanceId as any)?.workspaceId !== workspace.id) {
      throw new Error("工具工作区与持久归属或注册物理路径不一致");
    }
    return identity;
  }

  /** 内建工具保持原权限入口，脚本只在允许访问模式下执行。 */
  private validatePermissions(tool: ExecutableToolDescriptor, accessMode: AccessMode): ToolExecutionResult | null {
    if (tool.runtime === "builtin") return null;
    if (accessMode === "read-only") {
      return {
        ok: false,
        toolId: tool.toolId,
        code: "TOOL_PERMISSION_DENIED",
        message: `当前节点是只读模式，不能执行工具 ${tool.name}`,
        stage: "validating",
        retryable: false,
      };
    }
    if (tool.permissions.requiresWrite && accessMode !== "full-access") {
      return {
        ok: false,
        toolId: tool.toolId,
        code: "TOOL_PERMISSION_DENIED",
        message: `工具 ${tool.name} 需要写入工作区，但当前访问模式是 ${accessMode}`,
        stage: "validating",
        retryable: false,
      };
    }
    return null;
  }
}

type ToolRuntimeDirectory = {
  root: WorkspaceCodeflowaiDirectoryIdentity;
  parent: string;
  parentIdentity: fs.Stats;
  path: string;
  identity: fs.Stats;
  files: Map<string, fs.Stats>;
};

/** 两级运行目录必须是原位置的普通物理目录；不扫描脚本产生的任意工件。 */
function inspectToolRuntimeDirectory(directory: string): fs.Stats {
  const current = fs.lstatSync(directory);
  if (current.isSymbolicLink() || !current.isDirectory() || toolRuntimePathKey(fs.realpathSync.native(directory)) !== toolRuntimePathKey(directory)) {
    throw new Error("工具运行目录不是原位置的普通目录");
  }
  return current;
}

/** 复核已捕获的根、父、本次目录及受管文件身份，拒绝链接、共享 inode 和替换。 */
function assertToolRuntimeDirectory(directory: ToolRuntimeDirectory): void {
  assertWorkspaceCodeflowaiDirectory(directory.root);
  for (const [target, expected] of [[directory.parent, directory.parentIdentity], [directory.path, directory.identity]] as const) {
    const current = inspectToolRuntimeDirectory(target);
    if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("工具运行目录在访问期间已被替换");
  }
  for (const [file, expected] of directory.files) assertToolRuntimeFile(file, fs.lstatSync(file), expected);
}

/** 文件必须是同位置的普通独占 inode；fd 与路径使用已有 Windows 设备号合同。 */
function assertToolRuntimeFile(file: string, current: fs.Stats, expected: fs.Stats): void {
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
    || !isWorkspaceCodeflowaiFileDeviceMatch(expected.dev, current.dev) || current.ino !== expected.ino
    || toolRuntimePathKey(fs.realpathSync.native(file)) !== toolRuntimePathKey(file)) {
    throw new Error("工具受管文件不是原位置的普通独占文件");
  }
}

/** 独占写入并保留双错；PS1 使用 UTF-8 BOM，避免 PowerShell 5.1 按系统代码页解码。 */
function writeToolRuntimeFile(directory: ToolRuntimeDirectory, name: string, content: string): string {
  assertToolRuntimeDirectory(directory);
  const file = path.join(directory.path, name);
  const fd = fs.openSync(file, "wx");
  let failed = false, failure: unknown;
  try {
    const opened = fs.fstatSync(fd);
    directory.files.set(file, opened);
    assertToolRuntimeFile(file, opened, opened);
    assertToolRuntimeDirectory(directory);
    fs.writeFileSync(fd, process.platform === "win32" && name.endsWith(".ps1") ? `\uFEFF${content}` : content, "utf8");
    assertToolRuntimeFile(file, fs.fstatSync(fd), opened);
    assertToolRuntimeDirectory(directory);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try { fs.closeSync(fd); } catch (closing) {
      if (failed) throw new AggregateError([failure, closing], "工具运行文件写入及关闭均失败", { cause: failure });
      throw closing;
    }
  }
  assertToolRuntimeDirectory(directory);
  return file;
}

/** Windows 路径比较忽略大小写，其他平台按原路径比较。 */
function toolRuntimePathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 限深保留主副因的系统字段；输入、脚本、输出和原始异常文案不进入日志。 */
function toToolFailureLogValue(error: unknown, depth = 0, budget = { remaining: 32 }): Record<string, unknown> {
  budget.remaining--;
  if (error === null || typeof error !== "object" && typeof error !== "function") return { name: "NonError" };
  /** 系统诊断字段仅取自有 data descriptor，反射异常交回外层保因。 */
  const value = (key: string) => ownData(error, key)?.value;
  const name = value("name"), code = value("code"), syscall = value("syscall"), errno = value("errno"), exitCode = value("exitCode"), stage = value("stage");
  const causes: Record<string, unknown>[] = [], errors = value("errors"), cause = ownData(error, "cause");
  if (depth < 4 && budget.remaining > 0 && Array.isArray(errors)) {
    const length = ownData(errors, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("工具错误数组长度无效");
    for (let index = 0; index < Math.min(8, length) && budget.remaining > 0; index++) causes.push(toToolFailureLogValue(ownData(errors, String(index))?.value, depth + 1, budget));
  } else if (depth < 4 && budget.remaining > 0 && cause) causes.push(toToolFailureLogValue(cause.value, depth + 1, budget));
  return { name: typeof name === "string" && ["Error", "AggregateError", "TypeError", "RangeError", "SystemError"].includes(name) ? name : "Error",
    ...(typeof code === "string" && ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EBUSY", "EIO", "EEXIST", "ENOTEMPTY", "EINVAL", "EMFILE", "ENFILE",
      "TOOL_EXECUTION_FAILED", "TOOL_OUTPUT_INVALID", "TOOL_TIMEOUT", "TOOL_RUNTIME_PREPARATION_FAILED", "TOOL_RUNTIME_IDENTITY_FAILED", "TOOL_RUNTIME_PROCESS_STOP_FAILED", "TOOL_RUNTIME_CLOSE_UNCONFIRMED",
      "TOOL_RUNTIME_STOP_FAILED", "TOOL_RUNTIME_STOP_REJECTED", "TOOL_RUNTIME_PROCESS_FAILED", "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE", "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED", "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED",
      "SKILL_RUNTIME_UNSAFE", "SKILL_RUNTIME_PACKAGE_INVALID", "SKILL_RUNTIME_FAILURE_LOG_FAILED"].includes(code) ? { code: redactClientStartupText(code) } : {}),
    ...(typeof syscall === "string" && /^(?:rm|open|close|read|write|stat|lstat|fstat|mkdir|rmdir|rename|realpath|unlink|scandir|spawn|kill)$/.test(syscall) ? { syscall } : {}),
    ...(typeof errno === "number" && Number.isFinite(errno) ? { errno } : {}),
    ...(typeof exitCode === "number" && Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(typeof stage === "string" && ["validating", "executing", "parsing"].includes(stage) ? { stage } : {}),
    ...(causes.length ? { causes } : {}) };
}

/** 未知异常只读取自有数据属性，访问器不执行，反射故障由日志边界保因。 */
function ownData(value: unknown, key: string): PropertyDescriptor | undefined {
  if (value === null || typeof value !== "object" && typeof value !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor : undefined;
}

function buildToolEnv(input: {
  workspacePath: string;
  tool: ExecutableToolDescriptor;
  input: unknown;
  inputPath: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = input.tool.envPolicy?.inheritWorkspaceEnv === false
    ? {}
    : buildClientChildProcessEnv(process.env);
  env.CODEFLOWAI_TOOL_INPUT_JSON = JSON.stringify(input.input ?? null);
  env.CODEFLOWAI_TOOL_INPUT_PATH = input.inputPath;
  env.CODEFLOWAI_TOOL_WORKSPACE_PATH = input.workspacePath;
  // Python 默认按系统代码页输出，Windows 下中文会乱码；统一按 UTF-8 传输。
  if (input.tool.runtime === "python") {
    env.PYTHONIOENCODING ??= "utf-8";
    env.PYTHONUTF8 ??= "1";
  }
  for (const [key, value] of Object.entries(input.tool.envPolicy?.extraEnv ?? {})) {
    env[key] = value;
  }
  return buildClientChildProcessEnv(env);
}

/** Skill 版本目录执行前只读复核；普通工具保持原工作区相对目录准备。 */
function resolveWorkingDirectory(workspacePath: string, workingDirectory: string | null | undefined, context: SkillRuntimeExecutionContext): string {
  const skillDirectory = assertSkillRuntimeWorkingDirectory(workspacePath, workingDirectory, context);
  if (skillDirectory) return skillDirectory;
  const rel = String(workingDirectory ?? "").trim();
  if (!rel) return workspacePath;
  const abs = path.resolve(workspacePath, rel);
  const relative = path.relative(path.resolve(workspacePath), abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`工具工作目录越界：${rel}`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** 受管源码与包装只写本次运行树；语言命令保持原 cwd 和输入契约。 */
function buildCommand(tool: ExecutableToolDescriptor, directory: ToolRuntimeDirectory): { command: string; args: string[] } {
  switch (tool.runtime) {
    case "shell": {
      if (process.platform === "win32") {
        const scriptPath = writeToolRuntimeFile(directory, "tool.ps1", String(tool.code ?? ""));
        return {
          command: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        };
      }
      const scriptPath = writeToolRuntimeFile(directory, "tool.sh", String(tool.code ?? ""));
      return {
        command: "bash",
        args: [scriptPath],
      };
    }
    case "python": {
      const scriptPath = writeToolRuntimeFile(directory, "tool.py", buildPythonSource(tool.code));
      return {
        command: "python",
        args: [scriptPath],
      };
    }
    case "node": {
      const scriptPath = writeToolRuntimeFile(directory, "tool.mjs", buildNodeSource(tool.code));
      return {
        command: "node",
        args: [scriptPath],
      };
    }
    case "java": {
      const sourcePath = writeToolRuntimeFile(directory, "ToolMain.java", String(tool.code ?? ""));
      if (process.platform === "win32") {
        const scriptPath = writeToolRuntimeFile(
          directory, "tool-java.ps1",
          [
            "$ErrorActionPreference = 'Stop'",
            `$source = ${toPowerShellLiteral(sourcePath)}`,
            `$classpath = ${toPowerShellLiteral(directory.path)}`,
            "& javac -d $classpath $source",
            "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
            "& java -cp $classpath ToolMain",
            "exit $LASTEXITCODE",
          ].join("\n"),
        );
        return {
          command: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        };
      }
      return {
        command: "bash",
        args: ["-lc", 'javac -d "$1" "$2" && java -cp "$1" ToolMain', "tool-java", directory.path, sourcePath],
      };
    }
    default:
      throw new Error(`暂不支持的运行时：${tool.runtime}`);
  }
}

function buildPythonSource(code: string): string {
  return [
    "import json",
    "import os",
    "INPUT = json.loads(os.environ.get('CODEFLOWAI_TOOL_INPUT_JSON', 'null'))",
    "def print_json(value):",
    "    print(json.dumps(value, ensure_ascii=False))",
    "",
    String(code ?? ""),
  ].join("\n");
}

function buildNodeSource(code: string): string {
  return [
    "const INPUT = JSON.parse(process.env.CODEFLOWAI_TOOL_INPUT_JSON ?? 'null');",
    "const printJson = (value) => process.stdout.write(JSON.stringify(value));",
    "",
    String(code ?? ""),
  ].join("\n");
}

function validateAgainstSchema(schemaText: string | null, input: unknown): { ok: true } | { ok: false; message: string } {
  const schema = parseSchema(schemaText);
  if (!schema) return { ok: true };
  return validateValue(schema, input, "$");
}

function parseToolOutput(schemaText: string | null, stdout: string): { ok: true; output: unknown } | { ok: false; message: string } {
  const trimmed = String(stdout ?? "").trim();
  const parsed = tryParseJson(trimmed);
  const output = parsed.parsed ? parsed.value : trimmed;
  const schema = parseSchema(schemaText);
  if (!schema) return { ok: true, output };
  const validated = validateValue(schema, output, "$");
  if (!validated.ok) return validated;
  return { ok: true, output };
}

function parseSchema(schemaText: string | null): any | null {
  const trimmed = String(schemaText ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function validateValue(schema: any, value: unknown, pathLabel: string): { ok: true } | { ok: false; message: string } {
  const type = String(schema?.type ?? "").trim();
  if (!type) return { ok: true };
  switch (type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, message: `${pathLabel} 必须是对象` };
      }
      const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          return { ok: false, message: `${pathLabel}.${key} 不能为空` };
        }
      }
      const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      for (const [key, childSchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const result = validateValue(childSchema, (value as Record<string, unknown>)[key], `${pathLabel}.${key}`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "array": {
      if (!Array.isArray(value)) return { ok: false, message: `${pathLabel} 必须是数组` };
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const result = validateValue(schema.items, value[index], `${pathLabel}[${index}]`);
          if (!result.ok) return result;
        }
      }
      return { ok: true };
    }
    case "string":
      return typeof value === "string" ? { ok: true } : { ok: false, message: `${pathLabel} 必须是字符串` };
    case "number":
      return typeof value === "number" ? { ok: true } : { ok: false, message: `${pathLabel} 必须是数字` };
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : { ok: false, message: `${pathLabel} 必须是布尔值` };
    default:
      return { ok: true };
  }
}

function tryParseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  if (!text) return { parsed: false };
  if (!(text.startsWith("{") || text.startsWith("["))) return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

function toPowerShellLiteral(value: string): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/** 仅 close 结算；失败保目录，结算后的管道继续排空但不再收集输出。 */
function executeCommand(input: {
  command: string;
  args: string[];
}, opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean;
  pid: number | null; failure?: { code: string; cause?: unknown } }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, {
        cwd: opts.cwd, env: opts.env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve({ ok: false, stdout, stderr, exitCode: null, timedOut, pid: null,
        failure: { code: "TOOL_EXECUTION_FAILED", cause } });
      return;
    }
    const pid = Number.isSafeInteger(child.pid) && child.pid! > 0 ? child.pid! : null;
    let settled = false, closed = false, sendingSignal = false;
    let exitCode: number | null = null;
    let processError: Error | undefined, stopError: unknown;
    let stopFailed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    /** 保原进程/停止异常；双故障不以最后一项覆盖前一项。 */
    const failureCause = (): unknown => processError && stopFailed
      ? new AggregateError([processError, stopError], "TOOL_RUNTIME_PROCESS_STOP_FAILED", { cause: processError })
      : processError ?? stopError;
    /** 结果只交付一次；未知关闭后的迟到事件不得改变已交付的失败。 */
    const finish = (closeUnconfirmed = false): void => {
      if (settled || sendingSignal) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      const code = closeUnconfirmed ? "TOOL_RUNTIME_CLOSE_UNCONFIRMED" : stopFailed ? "TOOL_RUNTIME_STOP_FAILED"
        : processError ? "TOOL_EXECUTION_FAILED" : timedOut ? "TOOL_TIMEOUT" : undefined;
      resolve({ ok: code === undefined && exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut, pid,
        ...(code ? { failure: { code, cause: failureCause() } } : {}) });
    };
    /** error/timeout 共享同一关闭预算，后续事件不能把等待期限重新延长。 */
    const waitForClose = (): void => {
      if (!closeTimer && !settled) closeTimer = setTimeout(() => finish(true), 5_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      sendingSignal = true;
      try {
        if (!child.kill()) { stopFailed = true; stopError = new Error("TOOL_RUNTIME_STOP_REJECTED"); }
      } catch (cause) {
        stopFailed = true;
        stopError = cause;
      } finally {
        sendingSignal = false;
      }
      if (closed) finish();
      else waitForClose();
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout!.on("data", (chunk) => {
      if (settled) return;
      stdout += String(chunk ?? "");
    });
    child.stderr!.on("data", (chunk) => {
      if (settled) return;
      stderr += String(chunk ?? "");
    });
    child.on("error", (error) => {
      if (settled) return;
      processError = processError ? new AggregateError([processError, error], "TOOL_RUNTIME_PROCESS_FAILED", { cause: processError }) : error;
      clearTimeout(timer);
      waitForClose();
    });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
  });
}
