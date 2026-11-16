import * as pty from "node-pty";
import path from "node:path";
import type { TerminalId, TerminalInfo, TerminalStatus, WorkspaceId } from "@codeflowai/shared";
import { toUpdateDiagnosticCause } from "@codeflowai/shared/desktop-update-failure";

import { logger, type WorkspaceLogEntry } from "../logger.js";
import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import {
  type ShellIntegrationState,
  detectShellType,
  getShellInitScript,
  getShellLaunchArgs,
  createShellIntegrationState,
  parseOsc133,
  applyOsc133Events,
} from "./shellIntegration.js";
import {
  repairNodePtyDarwinSpawnHelperExecutable,
  resolveMacOSProtectedTerminalCwdHint,
  resolveTerminalLaunchOptions,
} from "./terminalSecurityPolicy.js";

const SCROLLBACK_MAX_BYTES = 50 * 1024;
const OUTPUT_BATCH_INTERVAL_MS = 16;
/** 终端在此时间内有输出则视为"忙碌"。 */
const FG_OUTPUT_IDLE_MS = 3_000;
/** 检测到忙碌但无法识别具体进程名时的标记值。 */
const BUSY_MARKER = "\u2026"; // "…"

type TerminalEntry = {
  id: TerminalId;
  label: string;
  shell: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: number;
  workspaceId: string;
  ptyProcess: pty.IPty;
  scrollback: string;
  outputBuffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  foregroundProcess: string | null;
  fgPollTimer: ReturnType<typeof setInterval> | null;
  /** 最近一次收到 pty 输出的时间戳（用于判断终端是否有活动）。 */
  lastOutputAt: number;
  /** OSC 133 shell integration 状态。 */
  shellIntegration: ShellIntegrationState;
  /** shell init 脚本延迟注入定时器。 */
  shellInitTimer: ReturnType<typeof setTimeout> | null;
  commandTimer: ReturnType<typeof setTimeout> | null;
  failure: { reason: unknown } | null;
  handlingFailure: boolean;
};

export type TerminalConfigPersistence = {
  save: (config: { id: string; workspaceId: string; label: string; shell: string | null; cwd: string | null }) => void;
  remove: (id: string, workspaceId: string) => void;
  updateLabel: (id: string, label: string, workspaceId: string) => void;
  listByWorkspace: (workspaceId: string) => Array<{ id: string; label: string; shell: string | null; cwd: string | null }>;
};

export type TerminalManagerDeps = {
  workspaces: Map<string, string>;
  writeWorkspaceLog: (workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => void;
  onError: (error: unknown, terminal: TerminalInfo) => void;
  onOutput: (terminal: TerminalInfo, data: string) => void;
  onCreated: (terminal: TerminalInfo, requestId?: string) => void;
  onExited: (terminal: TerminalInfo, exitCode: number | null) => void;
  onForegroundProcessChanged?: (terminal: TerminalInfo, foregroundProcess: string | null) => void;
  persistence?: TerminalConfigPersistence;
  isTaskAdmissionPaused?: () => boolean;
};

export class TerminalManager {
  private entries = new Map<TerminalId, TerminalEntry>();
  private deps: TerminalManagerDeps;
  private nextId = 1;

  constructor(deps: TerminalManagerDeps) {
    this.deps = deps;
  }

  /** 在实际启动前检查更新准入，再创建受 workspace/shell 策略约束的终端。 */
  create(opts: { workspaceId: string; requestId?: string; label?: string; shell?: string; cwd?: string }): TerminalInfo {
    this.assertTaskAdmission(opts.workspaceId, opts.requestId ?? `terminal-create:${opts.workspaceId}:${this.nextId}`);
    return this.createAdmittedTerminal(opts);
  }

  /** 已检查准入后启动 PTY；仅将校验通过的 cwd 以工作区相对路径持久化。 */
  private createAdmittedTerminal(opts: { workspaceId: string; requestId?: string; label?: string; shell?: string; cwd?: string }): TerminalInfo {
    const workspacePath = this.deps.workspaces.get(opts.workspaceId) ?? null;
    let launch: { cwd: string; shell: string };
    try {
      launch = resolveTerminalLaunchOptions({ workspacePath, cwd: opts.cwd, shell: opts.shell });
    } catch (error) {
      this.writeLog(opts.workspaceId, "warn", "terminal create rejected", () => ({
        errorCode: "TERMINAL_CREATE_REJECTED", requestId: opts.requestId ?? `terminal-create:${opts.workspaceId}`,
        workspaceId: opts.workspaceId, rootCause: terminalDiagnosticCause(error),
      }), { reason: error }, this.deps.workspaces.has(opts.workspaceId));
      throw error;
    }
    const { cwd, shell } = launch;
    const label = opts.label || `Terminal ${this.nextId}`;
    const id = `term_${Date.now()}_${this.nextId++}` as TerminalId;
    this.writeLog(opts.workspaceId, "info", "terminal create accepted", () => ({
      requestId: opts.requestId ?? `terminal-create:${id}`,
      workspaceId: opts.workspaceId,
      terminalId: id,
      cwd,
      shell,
    }));

    const shellType = detectShellType(shell);
    const shellLaunchArgs = getShellLaunchArgs(shellType);
    let ptyProcess: pty.IPty;
    try {
      repairNodePtyDarwinSpawnHelperExecutable();
      ptyProcess = pty.spawn(shell, shellLaunchArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd,
        env: buildClientChildProcessEnv(process.env) as Record<string, string>,
      });
    } catch (error) {
      this.writeLog(opts.workspaceId, "warn", "terminal pty spawn failed", () => ({
        errorCode: "TERMINAL_SPAWN_FAILED", requestId: opts.requestId ?? `terminal-create:${id}`,
        workspaceId: opts.workspaceId, terminalId: id, rootCause: terminalDiagnosticCause(error),
      }), { reason: error });
      throw new Error(formatTerminalSpawnFailure(shell, cwd, "请检查本机 Shell 与工作目录", resolveMacOSProtectedTerminalCwdHint(cwd)), { cause: error });
    }

    const entry: TerminalEntry = {
      id,
      label,
      shell,
      cwd,
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      workspaceId: opts.workspaceId,
      ptyProcess,
      scrollback: "",
      outputBuffer: "",
      flushTimer: null,
      foregroundProcess: null,
      fgPollTimer: null,
      lastOutputAt: 0,
      shellIntegration: createShellIntegrationState(),
      shellInitTimer: null,
      commandTimer: null,
      failure: null,
      handlingFailure: false,
    };

    this.entries.set(id, entry);
    let setupPhase = "initialize";
    try {
      ptyProcess.onData((data: string) => {
        if (entry.failure) return;
        this.runEntryCallback(entry, "output", () => {
          // OSC 133 解析：在输出批处理之前提取事件，触发即时状态更新
          const osc133Events = parseOsc133(data);
          if (osc133Events.length > 0) {
            const phaseChanged = applyOsc133Events(entry.shellIntegration, osc133Events);
            if (phaseChanged) {
              const fg = entry.shellIntegration.phase === "busy" ? BUSY_MARKER : null;
              if (fg !== entry.foregroundProcess) {
                entry.foregroundProcess = fg;
                this.deps.onForegroundProcessChanged?.(toTerminalInfo(entry), fg);
              }
            }
          }

          appendScrollback(entry, data);
          entry.lastOutputAt = Date.now();
          entry.outputBuffer += data;
          if (!entry.flushTimer) {
            entry.flushTimer = setTimeout(() => {
              const batch = entry.outputBuffer;
              entry.outputBuffer = "";
              entry.flushTimer = null;
              if (batch) this.runEntryCallback(entry, "output_flush", () => this.deps.onOutput(toTerminalInfo(entry), batch));
            }, OUTPUT_BATCH_INTERVAL_MS);
          }
        });
      });

      ptyProcess.onExit(({ exitCode }) => {
        this.clearEntryTimers(entry);
        entry.status = "exited";
        entry.exitCode = exitCode;
        const failures: unknown[] = [];
        if (entry.outputBuffer) {
          const batch = entry.outputBuffer;
          entry.outputBuffer = "";
          try { this.deps.onOutput(toTerminalInfo(entry), batch); } catch (error) { failures.push(error); }
        }
        try { this.deps.onExited(toTerminalInfo(entry), exitCode); } catch (error) { failures.push(error); }
        if (failures.length) this.failEntry(entry, "exit", combineTerminalFailures(failures));
      });

      this.assertEntryHealthy(entry);

      // 前台进程轮询（2s 间隔）
      // shell integration 激活后降级为"进程名补充"模式，不再用输出启发式
      entry.fgPollTimer = setInterval(() => {
        if (entry.status !== "running") return;
        this.runEntryCallback(entry, "foreground_poll", () => {
          if (entry.shellIntegration.active) {
            // OSC 133 已激活：idle/busy 由 onData 中即时处理
            // 轮询仅在 busy 态尝试补充具体进程名（Linux/macOS 下 ptyProcess.process 可用时）
            if (entry.shellIntegration.phase === "busy") {
              const rawProc = entry.ptyProcess.process ?? null;
              const procName = classifyForegroundProcess(rawProc, entry.shell);
              const fg = procName ?? BUSY_MARKER;
              if (fg !== entry.foregroundProcess) {
                entry.foregroundProcess = fg;
                this.deps.onForegroundProcessChanged?.(toTerminalInfo(entry), fg);
              }
            }
          } else {
            // 兜底：shell integration 未激活（CMD、自定义 shell），沿用旧逻辑
            const rawProc = entry.ptyProcess.process ?? null;
            const procName = classifyForegroundProcess(rawProc, entry.shell);
            const recentOutput = entry.lastOutputAt > 0 && (Date.now() - entry.lastOutputAt) < FG_OUTPUT_IDLE_MS;
            const fg = procName ?? (recentOutput ? BUSY_MARKER : null);
            if (fg !== entry.foregroundProcess) {
              entry.foregroundProcess = fg;
              this.deps.onForegroundProcessChanged?.(toTerminalInfo(entry), fg);
            }
          }
        });
      }, 2_000);

      // 延迟 300ms 注入 shell integration init 脚本
      const initScript = getShellInitScript(shellType);
      if (initScript && shellLaunchArgs.length === 0) {
        entry.shellInitTimer = setTimeout(() => {
          entry.shellInitTimer = null;
          if (entry.status !== "running") return;
          this.runEntryCallback(entry, "shell_init", () => {
            const clearCmd = shellType === "powershell" || shellType === "pwsh" ? "cls" : "clear";
            const separator = shellType === "powershell" || shellType === "pwsh" ? "; " : "\n";
            entry.ptyProcess.write(`${initScript}${separator}${clearCmd}\r`);
          });
        }, 300);
      }

      setupPhase = "save";
      this.deps.persistence?.save({ id, workspaceId: opts.workspaceId, label, shell, cwd: path.relative(workspacePath!, cwd) || "." });
      this.assertEntryHealthy(entry);
      const info = toTerminalInfo(entry);
      setupPhase = "created_delivery";
      this.deps.onCreated(info, opts.requestId);
      return info;
    } catch (error) {
      const failures = [error];
      try { this.close(id); } catch (cleanupError) { failures.push(cleanupError); }
      const failure = combineTerminalFailures(failures);
      this.logEntryFailure(failure, setupPhase, entry, opts.requestId);
      throw failure;
    }
  }

  /** 同步输入沿原 entry 归属写诊断，失败后不伪造已发送。 */
  write(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.assertEntryHealthy(entry);
    if (entry.status !== "running") return;
    try { entry.ptyProcess.write(data); }
    catch (error) { this.logEntryFailure(error, "write", entry); throw error; }
  }

  /** 延迟动作附着现有 entry，关闭或失败即取消，不留 handler 孤儿 timer。 */
  scheduleCommand(terminalId: string, command: string, delayMs: number): void {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.status !== "running") throw new Error("TERMINAL_NOT_RUNNING");
    this.assertEntryHealthy(entry);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647 || entry.commandTimer) throw new Error("TERMINAL_COMMAND_SCHEDULE_INVALID");
    entry.commandTimer = setTimeout(() => {
      entry.commandTimer = null;
      if (entry.status === "running") this.runEntryCallback(entry, "scheduled_command", () => entry.ptyProcess.write(command + "\r"));
    }, delayMs);
  }

  /** 标签持久化成功后才更新内存；原条目携带真实工作区。 */
  rename(terminalId: string, label: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    this.assertEntryHealthy(entry);
    try { this.deps.persistence?.updateLabel(terminalId, label, entry.workspaceId); }
    catch (cause) { this.logEntryFailure(cause, "rename", entry); throw cause; }
    entry.label = label;
    return true;
  }

  /** 调整现有 PTY 尺寸，原生错误在所属工作区显式失败。 */
  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.assertEntryHealthy(entry);
    if (entry.status !== "running") return;
    try { entry.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows)); }
    catch (error) { this.logEntryFailure(error, "resize", entry); throw error; }
  }

  /** 停止及配置删除失败均保留 owner，禁止返回伪成功或猜测数据库归属。 */
  close(terminalId: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    this.clearEntryTimers(entry);
    if (entry.status === "running") {
      try { entry.ptyProcess.kill(); }
      catch (cause) {
        const failure = combineTerminalFailures(entry.failure ? [entry.failure.reason, cause] : [cause]);
        this.logEntryFailure(failure, "close_process", entry); throw failure;
      }
    }
    try { this.deps.persistence?.remove(terminalId, entry.workspaceId); }
    catch (cause) {
      const failure = combineTerminalFailures(entry.failure ? [entry.failure.reason, cause] : [cause]);
      this.logEntryFailure(failure, "remove", entry); throw failure;
    }
    entry.status = "stopped";
    this.entries.delete(terminalId);
    if (entry.failure) throw entry.failure.reason;
    return true;
  }

  /** 投影现有 PTY 运行事实，更新检查不另存活动状态。 */
  hasRunningTerminals(): boolean {
    return [...this.entries.values()].some(entry => entry.status === "running");
  }

  /** 准入冻结后停止全部终端；确认退出并清理配置后才释放管理引用。 */
  async stopAllForUpdate(input: { requestId: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!input.requestId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      const error = Object.assign(new Error("更新终端停止参数无效"), { code: "DESKTOP_UPDATE_TERMINAL_STOP_INVALID" });
      logger.error("terminal", "terminal update stop rejected", {
        event: { category: "terminal", action: "update_stop", outcome: "failed" }, errorCode: error.code,
        requestId: input.requestId, workspaceId: null, terminalId: null, rootCause: error.message,
      });
      throw error;
    }
    const deadline = Date.now() + timeoutMs;
    for (const entry of [...this.entries.values()]) {
      this.clearEntryTimers(entry);
      try {
        if (entry.status === "running") {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw Object.assign(new Error("等待更新终端退出超时"), { code: "DESKTOP_UPDATE_TERMINAL_EXIT_TIMEOUT" });
          await this.waitForUpdateExit(entry, remainingMs);
        }
        try { this.deps.persistence?.remove(entry.id, entry.workspaceId); }
        catch (cause) { throw Object.assign(new Error("更新终端配置清理失败", { cause }), { code: "DESKTOP_UPDATE_TERMINAL_CONFIG_FAILED" }); }
        entry.status = "stopped";
        this.entries.delete(entry.id);
        if (entry.failure) throw entry.failure.reason;
      } catch (error) {
        const failure = entry.failure && error !== entry.failure.reason ? combineTerminalFailures([entry.failure.reason, error]) : error;
        if (!entry.failure || error !== entry.failure.reason) this.writeLog(entry.workspaceId, "error", "terminal update stop failed", () => ({
          event: { category: "terminal", action: "update_stop", outcome: "failed" },
          errorCode: terminalUpdateStopCode(error),
          requestId: input.requestId, workspaceId: entry.workspaceId, terminalId: entry.id,
          rootCause: terminalDiagnosticCause(failure),
        }), { reason: failure });
        throw failure;
      }
    }
  }

  /** 先监听再请求 kill；超时或 kill 失败都保留仍由 Manager 管理的条目。 */
  private waitForUpdateExit(entry: TerminalEntry, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let subscription: pty.IDisposable | undefined;
      let settled = false;
      let killReturned = false;
      let exited = false;
      const finish = (failure?: { reason: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const failures = failure ? [failure.reason] : [];
        try { subscription?.dispose(); } catch (error) { failures.push(error); }
        failures.length ? reject(combineTerminalFailures(failures)) : resolve();
      };
      const timer = setTimeout(() => finish({ reason: Object.assign(new Error("等待更新终端退出超时"), { code: "DESKTOP_UPDATE_TERMINAL_EXIT_TIMEOUT" }) }), timeoutMs);
      try {
        subscription = entry.ptyProcess.onExit(() => { exited = true; if (killReturned) finish(); });
        entry.ptyProcess.kill();
        killReturned = true;
        if (exited) finish();
      } catch (cause) {
        finish({ reason: Object.assign(new Error("更新终端停止失败", { cause }), { code: "DESKTOP_UPDATE_TERMINAL_KILL_FAILED" }) });
      }
    });
  }

  list(workspaceId: string): Array<TerminalInfo & { scrollback?: string }> {
    const result: Array<TerminalInfo & { scrollback?: string }> = [];
    for (const entry of this.entries.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      result.push({ ...toTerminalInfo(entry), scrollback: entry.scrollback });
    }
    return result;
  }

  get(terminalId: string): TerminalInfo | null {
    const entry = this.entries.get(terminalId);
    return entry ? toTerminalInfo(entry) : null;
  }

  /** 恢复前及每项副作用前检查准入，暂停或检查失败时保留尚未恢复的配置。 */
  restoreAll(workspaceId: string): TerminalInfo[] {
    this.assertTaskAdmission(workspaceId, `terminal-restore:${workspaceId}`);
    let configs: ReturnType<TerminalConfigPersistence["listByWorkspace"]> | undefined;
    try { configs = this.deps.persistence?.listByWorkspace(workspaceId); }
    catch (error) {
      this.writeLog(workspaceId, "error", "terminal restore list failed", () => ({ errorCode: "TERMINAL_RESTORE_LIST_FAILED",
        requestId: `terminal-restore:${workspaceId}`, workspaceId, terminalId: null, rootCause: terminalDiagnosticCause(error) }), { reason: error }, this.deps.workspaces.has(workspaceId));
      throw error;
    }
    if (!configs?.length) return [];
    const restored: TerminalInfo[] = [];
    for (const cfg of configs) {
      this.assertTaskAdmission(workspaceId, `terminal-restore:${workspaceId}:${cfg.id}`, cfg.id);
      let created: TerminalInfo | undefined;
      try {
        created = this.createAdmittedTerminal({
          workspaceId,
          label: cfg.label,
          shell: cfg.shell ?? undefined,
          cwd: cfg.cwd ?? undefined,
        });
        this.deps.persistence?.remove(cfg.id, workspaceId);
        restored.push(created);
      } catch (error) {
        const failures = [error];
        if (created) { try { this.close(created.id); } catch (cleanupError) { failures.push(cleanupError); } }
        const failure = combineTerminalFailures(failures);
        this.writeLog(workspaceId, "error", "terminal restore failed", () => ({
          errorCode: "TERMINAL_CONFIG_RESTORE_FAILED", requestId: `terminal-restore:${workspaceId}:${cfg.id}`,
          workspaceId,
          terminalId: cfg.id,
          rootCause: terminalDiagnosticCause(failure),
        }), { reason: failure }, this.deps.workspaces.has(workspaceId));
        throw failure;
      }
    }
    return restored;
  }

  /** 描述与固定日志同一保因边界；未知工作区只保应用级拒绝诊断。 */
  private writeLog(workspaceId: string, level: WorkspaceLogEntry["level"], message: string,
    data: () => Record<string, unknown>, business?: { reason: unknown }, trustedWorkspace = true): void {
    try {
      const entry = { level, tag: "terminal", message, data: data() };
      if (trustedWorkspace) this.deps.writeWorkspaceLog(workspaceId as WorkspaceId, entry);
      else logger[level](entry.tag, entry.message, entry.data);
    } catch (error) {
      throw Object.assign(new AggregateError(business ? [business.reason, error] : [error], "终端诊断或固定日志失败",
        { cause: business ? business.reason : error }), { code: "TERMINAL_LOG_FAILED" });
    }
  }

  /** entry 已持有可信 W，日志不执行外部异常的 getter 或字符串转换。 */
  private logEntryFailure(error: unknown, operation: string, entry: TerminalEntry, requestId?: string): void {
    this.writeLog(entry.workspaceId, "error", "terminal operation failed", () => ({ errorCode: `TERMINAL_${operation.toUpperCase()}_FAILED`,
      requestId: requestId ?? `terminal:${operation}:${entry.id}`, workspaceId: entry.workspaceId,
      terminalId: entry.id, operation, rootCause: terminalDiagnosticCause(error) }), { reason: error });
  }

  /** 后台失败由原 entry 持有；同步入口必须向调用者显式失败。 */
  private assertEntryHealthy(entry: TerminalEntry): void {
    if (entry.failure) throw entry.failure.reason;
  }

  /** 所有自有定时器随原 entry 收口，包含延迟动作。 */
  private clearEntryTimers(entry: TerminalEntry): void {
    if (entry.fgPollTimer !== null) clearInterval(entry.fgPollTimer);
    for (const timer of [entry.shellInitTimer, entry.flushTimer, entry.commandTimer]) if (timer !== null) clearTimeout(timer);
    entry.fgPollTimer = null; entry.shellInitTimer = null; entry.flushTimer = null; entry.commandTimer = null;
  }

  /** timer/PTY 事件由原 owner 消费，禁止异常逃逸到全局 uncaught。 */
  private runEntryCallback(entry: TerminalEntry, operation: string, action: () => void): void {
    if (entry.failure) return;
    try { action(); } catch (error) { this.failEntry(entry, operation, error); }
  }

  /** 收齐异步业务、清理、诊断及通知失败，原关闭/停止入口仍须消费该失败。 */
  private failEntry(entry: TerminalEntry, operation: string, error: unknown): void {
    entry.failure = { reason: entry.failure ? combineTerminalFailures([entry.failure.reason, error]) : error };
    if (entry.handlingFailure) return;
    entry.handlingFailure = true;
    try {
      this.clearEntryTimers(entry);
      if (entry.status === "running") {
        try { entry.ptyProcess.kill(); }
        catch (cleanupError) { entry.failure = { reason: combineTerminalFailures([entry.failure.reason, cleanupError]) }; }
      }
      try { this.logEntryFailure(entry.failure.reason, operation, entry); }
      catch (logError) { entry.failure = { reason: logError }; }
      try { this.deps.onError(entry.failure.reason, toTerminalInfo(entry)); }
      catch (deliveryError) { entry.failure = { reason: combineTerminalFailures([entry.failure.reason, deliveryError]) }; }
    } finally { entry.handlingFailure = false; }
  }

  /** 读取统一暂停事实；记录上下文后显式拒绝，检查异常保留原始根因。 */
  private assertTaskAdmission(workspaceId: string, requestId: string, terminalId?: string): void {
    let paused: boolean | undefined;
    try {
      paused = this.deps.isTaskAdmissionPaused?.();
    } catch (error) {
      this.writeLog(workspaceId, "error", "terminal task admission check failed", () => ({
        event: { category: "terminal", action: "task_admission", outcome: "failed" },
        errorCode: "DESKTOP_UPDATE_TASK_ADMISSION_FAILED",
        requestId,
        workspaceId,
        terminalId: terminalId ?? null,
        rootCause: terminalDiagnosticCause(error),
      }), { reason: error }, this.deps.workspaces.has(workspaceId));
      throw error;
    }
    if (!paused) return;
    const error = Object.assign(new Error("正在等待更新，新的终端启动已暂停"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    this.writeLog(workspaceId, "warn", "terminal task admission rejected", () => ({
      event: { category: "terminal", action: "task_admission", outcome: "rejected" },
      errorCode: error.code,
      requestId,
      workspaceId,
      terminalId: terminalId ?? null,
      rootCause: error.message,
    }), { reason: error }, this.deps.workspaces.has(workspaceId));
    throw error;
  }

  /** 每项均尝试清理；只释放已停止 owner，失败及历史异步错误统一向关闭方抛出。 */
  dispose(): void {
    const failures: unknown[] = [];
    for (const entry of [...this.entries.values()]) {
      this.clearEntryTimers(entry);
      let stopped = true;
      if (entry.status === "running") {
        try { entry.ptyProcess.kill(); }
        catch (error) {
          stopped = false;
          try { this.logEntryFailure(error, "dispose", entry); failures.push(error); }
          catch (diagnosticError) { failures.push(diagnosticError); }
        }
      }
      if (entry.failure) failures.push(entry.failure.reason);
      if (stopped) { entry.status = "stopped"; this.entries.delete(entry.id); }
    }
    if (failures.length) throw combineTerminalFailures(failures);
  }
}

/** 单错保留原值，含 falsy 的多错按发生顺序组成唯一拒绝。 */
function combineTerminalFailures(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "终端执行或清理失败", { cause: errors[0] });
}

/** 仅取自有 data descriptor，不调用外部 getter/toString。 */
function terminalOwn(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" && typeof value !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** 只接受本停止入口自产的公开错误码，外部 code 不进入诊断正文。 */
function terminalUpdateStopCode(value: unknown): string {
  const code = terminalOwn(value, "code");
  return typeof code === "string" && ["DESKTOP_UPDATE_TERMINAL_EXIT_TIMEOUT", "DESKTOP_UPDATE_TERMINAL_KILL_FAILED", "DESKTOP_UPDATE_TERMINAL_CONFIG_FAILED"].includes(code)
    ? code : "DESKTOP_UPDATE_TERMINAL_STOP_FAILED";
}

/** 将安全投影交给已有更新脱敏器；反射再错由原日志边界保因。 */
function terminalDiagnosticCause(value: unknown): ReturnType<typeof toUpdateDiagnosticCause> {
  const message = terminalOwn(value, "message"), code = terminalOwn(value, "code");
  const projected = new Error(typeof message === "string" ? message : "");
  if (typeof code === "string") Object.assign(projected, { code });
  return toUpdateDiagnosticCause(projected);
}

function toTerminalInfo(entry: TerminalEntry): TerminalInfo {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    label: entry.label,
    shell: entry.shell,
    cwd: entry.cwd,
    status: entry.status,
    exitCode: entry.exitCode,
    createdAt: entry.createdAt,
    foregroundProcess: entry.foregroundProcess,
  };
}

function appendScrollback(entry: TerminalEntry, data: string): void {
  entry.scrollback += data;
  if (entry.scrollback.length > SCROLLBACK_MAX_BYTES) {
    entry.scrollback = entry.scrollback.slice(entry.scrollback.length - SCROLLBACK_MAX_BYTES);
  }
}

/** 生成终端启动失败提示，保留底层原因并补充可操作的 macOS 权限线索。 */
function formatTerminalSpawnFailure(shell: string, cwd: string, reason: string, macOSHint: string | null): string {
  const hint = macOSHint ? `；${macOSHint}` : "";
  return `终端启动失败：${shell}（cwd=${cwd}）：${reason}${hint}`;
}

/** pty 噪音名：终端类型名、conhost 等，不是真正的前台进程。 */
const PTY_NOISE = new Set(["xterm-256color", "xterm", "conhost.exe", "conhost", ""]);

/**
 * 将 ptyProcess.process 分类：
 * - 返回 null 表示 shell 自身在前台（待机）
 * - 返回进程短名表示有子进程在运行（忙碌）
 */
function classifyForegroundProcess(rawProc: string | null, shell: string): string | null {
  if (!rawProc) return null;
  const name = rawProc.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (PTY_NOISE.has(name) || PTY_NOISE.has(rawProc.toLowerCase())) return null;
  // 与 shell 可执行文件名对比：shell 自身视为待机
  const shellBase = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (name === shellBase || name === shellBase.replace(/\.exe$/i, "")) return null;
  // 返回不带 .exe 的短名
  return name.replace(/\.exe$/i, "");
}

