import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import type { ExecutableToolDescriptor, ManagedServiceSnapshot, OrchestrationId, ThreadId, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";

const MANAGED_SERVICE_TOOLSET_ID = "__runtime_managed_service__";
export const MANAGED_SERVICE_TOOL_ID = "runtime.manageBackgroundService";
const MAX_READINESS_BUFFER_CHARS = 4_000;
const TERMINAL_RECORD_TTL_MS = 24 * 60 * 60_000;
const MAX_TERMINAL_RECORDS_PER_THREAD = 20;
const MAX_TERMINAL_RECORDS_GLOBAL = 200;
const FAILURE_LOG_FAILED = "MANAGED_SERVICE_FAILURE_LOG_FAILED";

/** 只检查本运行时创建的失败外壳，不读取业务 cause 的属性。 */
function isDiagnosticFailure(error: unknown): boolean {
  return error instanceof Error && Object.getOwnPropertyDescriptor(error, "code")?.value === FAILURE_LOG_FAILED;
}

type ManagedServiceRecord = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId | null;
  threadId: ThreadId;
  serviceId: string;
  fingerprint: string;
  command: string;
  args: string[];
  workingDirectory: string;
  env: Record<string, string>;
  startupTimeoutMs: number;
  ready: ReadyConfig;
  status: ManagedServiceSnapshot["status"];
  pid: number | null;
  startedAt: number;
  readyAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  readySummary: string | null;
  readinessStdoutTail: string;
  readinessStderrTail: string;
  startPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  processFailure: Error | null;
  child: ReturnType<typeof spawn> | null;
  stopRequested: boolean;
  databaseWork: Promise<void> | null;
};

type ReadyConfig =
  | { kind: "url"; url: string }
  | { kind: "port"; port: number; host: string }
  | { kind: "stdout"; pattern: string }
  | { kind: "delay"; delayMs: number };

type EnsureInput = {
  action: "ensure";
  serviceId: string;
  command: string;
  args: string[];
  workingDirectory: string;
  env: Record<string, string>;
  startupTimeoutMs: number;
  reuseExisting: boolean;
  ready: ReadyConfig;
};

type StatusInput = {
  action: "status";
  serviceId: string;
};

type StopInput = {
  action: "stop";
  serviceId: string;
};

type ToolInput = EnsureInput | StatusInput | StopInput;

type ManagedServiceChangeReason =
  | "starting"
  | "ready"
  | "exited"
  | "stopped"
  | "startup-failed"
  | "reconfigured"
  | "instance-disposed"
  | "spawn-error"
  | "process-exit";

type ManagedServiceRuntimeOptions = {
  db: Pick<ClientDb, "threads" | "orchInstances" | "workspaces" | "writeWorkspaceLog">;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  onChanged?: (event: {
    instanceId: OrchestrationId | null;
    threadId: ThreadId;
    serviceId: string;
    status: ManagedServiceSnapshot["status"];
    reason: ManagedServiceChangeReason;
  }) => void;
};

export class ManagedServiceRuntime {
  private readonly servicesByThread = new Map<ThreadId, Map<string, ManagedServiceRecord>>();
  private readonly threadIdsByInstance = new Map<OrchestrationId, Set<ThreadId>>();

  constructor(private readonly options: ManagedServiceRuntimeOptions) {}

  /** 查询及诊断在同步短段内执行，进程存活和停止不占数据库许可。 */
  private async withDatabase<T>(requestId: string, operation: () => T): Promise<T> {
    return this.options.withLegacyDatabase ? this.options.withLegacyDatabase(requestId, operation) : operation();
  }

  /** 进程事件不能 await；尾链保留失败，由该 record 的公开操作显式交付。 */
  private scheduleDatabaseWork(record: ManagedServiceRecord, operation: () => void): void {
    const run = () => this.withDatabase(`managed-service:${record.threadId}:${record.serviceId}`, operation).catch(async error => {
      let failure = error;
      try {
        await this.withDatabase(`managed-service-database:${record.threadId}:${record.serviceId}`, () =>
          this.logProcessFailure(record, error, `managed-service-database:${record.threadId}:${record.serviceId}`, "database-callback"));
      } catch (diagnostic) { failure = diagnostic; }
      throw failure;
    });
    const pending = record.databaseWork ? record.databaseWork.then(run) : run();
    record.databaseWork = pending;
    void pending.then(() => {
      if (record.databaseWork === pending) record.databaseWork = null;
    }, error => {
      record.processFailure = error instanceof Error ? error : new Error("MANAGED_SERVICE_DATABASE_FAILED", { cause: error });
    });
  }

  /** 正常结果必须先交付已接收的生命周期数据库操作和错误。 */
  private async drainDatabaseWork(record: ManagedServiceRecord): Promise<void> {
    while (record.databaseWork) await record.databaseWork;
  }

  buildBuiltinTools(): ExecutableToolDescriptor[] {
    return [{
      toolsetId: MANAGED_SERVICE_TOOLSET_ID as any,
      toolsetName: "内建进程",
      toolId: MANAGED_SERVICE_TOOL_ID as any,
      name: "管理进程",
      alias: null,
      description: "按 serviceId 启动、复用、查询或停止当前聊天窗口级的本地长驻进程。适用于 mock server、dev server、watcher、端口监听等需要持续存活的进程。",
      runtime: "builtin",
      usageGuidance: "如果某个持续存活的本地进程需要被页面里的“进程”区统一查看、停止、跨刷新保留，优先用这个工具；如果只是当前回合内部的临时后台终端，不要求纳入页面统一管理，也可以继续使用引擎原生 Bash/commandExecution。",
      invocationHint: [
        "最常见是 ensure：",
        "{",
        '  "action": "ensure",',
        '  "serviceId": "mock-wechat",',
        '  "command": "node",',
        '  "args": ["codeflow-docs/.../mock-wechat-server.mjs"],',
        '  "env": { "MOCK_WECHAT_PORT": "40411" },',
        '  "ready": { "url": "http://127.0.0.1:40411/admin/orders" }',
        "}",
        "查询状态用 action=status，停止服务用 action=stop。",
      ].join("\n"),
      code: "",
      inputSchema: JSON.stringify({
        type: "object",
        required: ["action", "serviceId"],
        properties: {
          action: { type: "string" },
          serviceId: { type: "string" },
          command: { type: "string" },
          args: {
            type: "array",
            items: { type: "string" },
          },
          workingDirectory: { type: "string" },
          startupTimeoutMs: { type: "number" },
          reuseExisting: { type: "boolean" },
          env: { type: "object" },
          ready: {
            type: "object",
            properties: {
              url: { type: "string" },
              port: { type: "number" },
              host: { type: "string" },
              stdoutPattern: { type: "string" },
              delayMs: { type: "number" },
            },
          },
        },
      }),
      outputSchema: JSON.stringify({
        type: "object",
        required: ["action", "serviceId", "status"],
        properties: {
          action: { type: "string" },
          serviceId: { type: "string" },
          status: { type: "string" },
        },
      }),
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }];
  }

  /** 新启动核持久归属与注册根，已有资源的状态和清理由原 record 承接。 */
  async executeBuiltinTool(
    tool: ExecutableToolDescriptor,
    input: unknown,
    ctx: { workspacePath: string; threadId: ThreadId; instanceId: OrchestrationId | null },
  ): Promise<unknown> {
    if (String(tool.toolId ?? "") !== MANAGED_SERVICE_TOOL_ID) {
      throw new Error(`未知进程工具：${tool.toolId}`);
    }
    const parsed = this.parseInput(input, ctx.workspacePath);
    if (parsed.action === "status") {
      const record = this.servicesByThread.get(ctx.threadId)?.get(parsed.serviceId);
      if (record) await this.drainDatabaseWork(record);
      return this.describeService(ctx.threadId, parsed.serviceId, "status");
    }
    if (parsed.action === "stop") {
      return this.stopService(ctx.threadId, parsed.serviceId, "manual-stop");
    }
    const { thread, instance, workspace } = await this.withDatabase(`managed-service-scope:${ctx.threadId}`, () => {
      const thread = this.options.db.threads.get(ctx.threadId);
      const instance = ctx.instanceId ? this.options.db.orchInstances.get(ctx.instanceId) : null;
      const workspace = thread ? this.options.db.workspaces.get(thread.workspaceId) : null;
      return { thread, instance, workspace };
    });
    if (!thread || !workspace || (ctx.instanceId && (!instance || instance.workspaceId !== thread.workspaceId))
      || path.resolve(workspace.path) !== path.resolve(ctx.workspacePath)) {
      throw Object.assign(new Error("MANAGED_SERVICE_SCOPE_INVALID"), { code: "MANAGED_SERVICE_SCOPE_INVALID", threadId: ctx.threadId, instanceId: ctx.instanceId });
    }
    return this.ensureService(thread.workspaceId, ctx.threadId, ctx.instanceId, parsed);
  }

  /** 顺序释放实例服务，首个失败保留归属和其余服务供显式重试。 */
  async disposeInstanceServices(instanceId: OrchestrationId): Promise<void> {
    const threadIds = [...(this.threadIdsByInstance.get(instanceId) ?? new Set<ThreadId>())];
    for (const threadId of threadIds) {
      const bucket = this.servicesByThread.get(threadId);
      if (!bucket?.size) continue;
      const records = [...bucket.values()];
      for (const record of records) {
        await this.stopProcess(record, "instance-disposed");
      }
      const current = this.servicesByThread.get(threadId);
      if (![...(current?.values() ?? [])].some(record => record.instanceId === instanceId && (this.isAlive(record) || record.startPromise || record.stopPromise))) {
        this.threadIdsByInstance.get(instanceId)?.delete(threadId);
      }
    }
    if (!this.threadIdsByInstance.get(instanceId)?.size) this.threadIdsByInstance.delete(instanceId);
  }

  /** 收齐进程与启动尾链，复用已含停止诊断的最终对象，全部成功才删记录。 */
  async disposeThreadServices(threadId: ThreadId, reason = "thread-disposed"): Promise<void> {
    const bucket = this.servicesByThread.get(threadId);
    if (!bucket?.size) {
      this.forgetThreadOwner(threadId);
      return;
    }
    const records = [...bucket.values()];
    for (const record of records) {
      const starting = record.startPromise;
      const stopping = this.stopProcess(record, reason);
      const results = await Promise.allSettled(starting ? [starting, stopping] : [stopping]);
      const startupResult = starting ? results[0] : undefined, stopResult = results[starting ? 1 : 0];
      if (startupResult?.status === "rejected" && stopResult?.status === "rejected"
        && startupResult.reason === record.processFailure && isDiagnosticFailure(record.processFailure)) {
        const final = record.processFailure!, errors = Object.getOwnPropertyDescriptor(final, "errors")?.value;
        if (Object.getOwnPropertyDescriptor(final, "message")?.value === "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED"
          && Array.isArray(errors) && Object.getOwnPropertyDescriptor(errors, "1")?.value === stopResult.reason) throw final;
      }
      const failures: unknown[] = [];
      for (const result of results) if (result.status === "rejected" && !failures.some(error => Object.is(error, result.reason))) failures.push(result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "MANAGED_SERVICE_THREAD_DISPOSAL_FAILED", { cause: failures[0] });
    }
    const current = this.servicesByThread.get(threadId);
    for (const record of records) if (current?.get(record.serviceId) === record) current.delete(record.serviceId);
    if (!current?.size) {
      this.servicesByThread.delete(threadId);
      this.forgetThreadOwner(threadId);
    }
  }

  /** 关闭按已持有记录释放全部线程；各线程独立收口，失败保留原对象与记录。 */
  async disposeAllServices(reason = "client-shutdown"): Promise<void> {
    const results = await Promise.allSettled([...this.servicesByThread.keys()].map(threadId => this.disposeThreadServices(threadId, reason)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "MANAGED_SERVICES_DISPOSAL_FAILED", { cause: failures[0] });
  }

  /** 查询先交付原失败，再映射终态快照；prune 不得掩盖诊断失败。 */
  listThreadServices(threadId: ThreadId): ManagedServiceSnapshot[] {
    this.pruneTerminalRecords(threadId);
    const bucket = this.servicesByThread.get(threadId);
    if (!bucket?.size) return [];
    for (const record of bucket.values()) if (record.processFailure) throw record.processFailure;
    return [...bucket.values()]
      .map((record) => this.toManagedServiceSnapshot(record))
      .sort((left, right) => right.startedAt - left.startedAt || left.serviceId.localeCompare(right.serviceId));
  }

  /** 已存在的服务必须确认退出；未知服务返回 false，停止失败向上传递。 */
  async stopThreadService(threadId: ThreadId, serviceId: string): Promise<boolean> {
    const result = await this.stopService(threadId, serviceId, "manual-stop");
    return Boolean((result as { stopped?: unknown } | null)?.stopped);
  }

  private parseInput(input: unknown, workspacePath: string): ToolInput {
    const record = asRecord(input);
    const actionRaw = String(record.action ?? "ensure").trim().toLowerCase();
    const serviceId = readNonEmptyString(record.serviceId, "serviceId");
    if (actionRaw === "status") return { action: "status", serviceId };
    if (actionRaw === "stop") return { action: "stop", serviceId };
    if (actionRaw !== "ensure") {
      throw new Error(`参数错误：action 只支持 ensure / status / stop，收到 ${actionRaw || "(empty)"}`);
    }

    const command = readNonEmptyString(record.command, "command");
    const args = readStringArray(record.args, "args");
    const workingDirectory = resolveWorkspaceDirectory(workspacePath, String(record.workingDirectory ?? "").trim());
    const env = readStringMap(record.env, "env");
    const startupTimeoutMs = clampNumber(record.startupTimeoutMs, 1_000, 10 * 60_000, 90_000);
    const reuseExisting = record.reuseExisting == null ? true : Boolean(record.reuseExisting);
    const ready = parseReadyConfig(record.ready, workingDirectory);
    return {
      action: "ensure",
      serviceId,
      command,
      args,
      workingDirectory,
      env,
      startupTimeoutMs,
      reuseExisting,
      ready,
    };
  }

  /** 启动和复用依赖原服务的启动、停止结果，不复用正在退出的进程。 */
  private async ensureService(workspaceId: WorkspaceId, threadId: ThreadId, instanceId: OrchestrationId | null, input: EnsureInput): Promise<unknown> {
    const fingerprint = stableJson({
      command: input.command,
      args: input.args,
      workingDirectory: input.workingDirectory,
      env: input.env,
      startupTimeoutMs: input.startupTimeoutMs,
      ready: input.ready,
    });
    let bucket: Map<string, ManagedServiceRecord>;
    while (true) {
      bucket = this.getOrCreateBucket(threadId, instanceId);
      const existing = bucket.get(input.serviceId);
      if (existing?.startPromise) { await existing.startPromise; continue; }
      if (existing?.stopPromise) { await existing.stopPromise; continue; }
      if (existing?.databaseWork) { await existing.databaseWork; continue; }
      if (existing?.processFailure && (isDiagnosticFailure(existing.processFailure) || this.isAlive(existing))) throw existing.processFailure;
      if (!existing || !this.isAlive(existing)) break;
      if (!existing.stopRequested && input.reuseExisting && existing.fingerprint === fingerprint) {
        return this.describeService(threadId, input.serviceId, "ensure", true);
      }
      await this.stopProcess(existing, "reconfigured");
    }

    const env = buildClientChildProcessEnv({ ...process.env, ...input.env });
    const record: ManagedServiceRecord = {
      workspaceId,
      instanceId,
      threadId,
      serviceId: input.serviceId,
      fingerprint,
      command: input.command,
      args: [...input.args],
      workingDirectory: input.workingDirectory,
      env: input.env,
      startupTimeoutMs: input.startupTimeoutMs,
      ready: input.ready,
      status: "starting",
      pid: null,
      startedAt: Date.now(),
      readyAt: null,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      readySummary: null,
      readinessStdoutTail: "",
      readinessStderrTail: "",
      startPromise: null,
      stopPromise: null,
      processFailure: null,
      child: null,
      stopRequested: false,
      databaseWork: null,
    };

    const child = spawn(input.command, input.args, {
      cwd: input.workingDirectory,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    record.child = child;
    record.pid = typeof child.pid === "number" ? child.pid : null;

    bucket.set(input.serviceId, record);
    this.pruneTerminalRecords(threadId);

    const appendOutput = (field: "readinessStdoutTail" | "readinessStderrTail", chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      record[field] = appendReadinessTail(record[field], text);
    };

    child.stdout?.on("data", (chunk) => appendOutput("readinessStdoutTail", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("readinessStderrTail", chunk));
    child.on("error", (error) => {
      // 停止 owner 会显式交付 kill 错误，生命周期监听不能抢先伪装已经退出。
      if (record.child == null || record.stopPromise) return;
      record.readinessStderrTail = appendReadinessTail(record.readinessStderrTail, "managed service process error\n");
      this.recordEventFailure(record, Object.assign(new Error("MANAGED_SERVICE_PROCESS_FAILED", { cause: error }), { code: "MANAGED_SERVICE_PROCESS_FAILED" }), "process-error");
      if (typeof child.pid === "number" && child.exitCode == null && child.signalCode == null) return;
      try { this.finalizeTerminalRecord(record, record.stopRequested ? "stopped" : "exited", record.stopRequested ? "stopped" : "spawn-error"); }
      catch (failure) { this.recordEventFailure(record, failure, "spawn-error"); }
    });
    child.on("exit", (code, signal) => {
      record.exitCode = typeof code === "number" ? code : null;
      record.exitSignal = signal ?? null;
      record.exitedAt = Date.now();
      if (record.stopPromise) return;
      if (record.child == null && (record.status === "stopped" || record.status === "exited")) return;
      try { this.finalizeTerminalRecord(record, record.stopRequested ? "stopped" : "exited", record.stopRequested ? "stopped" : "process-exit"); }
      catch (failure) { this.recordEventFailure(record, failure, "process-exit"); }
    });

    record.startPromise = Promise.resolve().then(async () => {
      this.notifyChanged(record, "starting");
      await this.drainDatabaseWork(record);
      await this.waitUntilReady(record);
      this.assertStartupActive(record);
    }).catch(async (error) => {
      let failure = error;
      if (error !== record.processFailure) {
        try { await this.withDatabase(`managed-service-start:${threadId}:${input.serviceId}`, () => this.logProcessFailure(record, error, `managed-service-start:${threadId}:${input.serviceId}:${Date.now()}`, "startup-failed")); }
        catch (diagnostic) { failure = diagnostic; }
      }
      try { await this.stopProcess(record, "startup-failed"); }
      catch (cleanupError) {
        if (cleanupError === failure) throw failure;
        if (isDiagnosticFailure(failure)) throw cleanupError;
        const combined = new AggregateError([failure, cleanupError], "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED", { cause: failure });
        if (isDiagnosticFailure(record.processFailure)) record.processFailure = Object.assign(combined, { code: FAILURE_LOG_FAILED });
        throw combined;
      }
      throw failure;
    }).finally(() => {
      record.startPromise = null;
    });

    await record.startPromise;
    return this.describeService(threadId, input.serviceId, "ensure", false);
  }

  /** 只允许当前表中未停止且仍存活的原进程发布或返回就绪。 */
  private assertStartupActive(record: ManagedServiceRecord): void {
    if (record.processFailure) throw record.processFailure;
    if (record.stopRequested || this.servicesByThread.get(record.threadId)?.get(record.serviceId) !== record) {
      throw Object.assign(new Error(`进程 ${record.serviceId} 启动已被停止或替换`), { code: "MANAGED_SERVICE_STARTUP_INTERRUPTED" });
    }
    if (!this.isAlive(record)) throw new Error(this.buildStartupFailureMessage(record, "进程在达到就绪条件前已退出"));
  }

  /** 探针跨 await 后复核活动与归属，已停止服务不能被迟到结果复活。 */
  private async waitUntilReady(record: ManagedServiceRecord): Promise<void> {
    const deadline = Date.now() + record.startupTimeoutMs;
    while (Date.now() <= deadline) {
      this.assertStartupActive(record);
      const readySummary = await this.checkReady(record);
      this.assertStartupActive(record);
      if (readySummary) {
        record.status = "ready";
        record.readyAt = Date.now();
        record.readySummary = readySummary;
        this.notifyChanged(record, "ready");
        await this.drainDatabaseWork(record);
        return;
      }
      await delay(200);
    }
    throw new Error(this.buildStartupFailureMessage(record, `等待就绪超时（>${record.startupTimeoutMs}ms）`));
  }

  private async checkReady(record: ManagedServiceRecord): Promise<string | null> {
    if (record.ready.kind === "stdout") {
      const haystack = `${record.readinessStdoutTail}\n${record.readinessStderrTail}`;
      return haystack.includes(record.ready.pattern) ? `stdout matched: ${record.ready.pattern}` : null;
    }
    if (record.ready.kind === "port") {
      const reachable = await probePort(record.ready.host, record.ready.port);
      return reachable ? `port ready: ${record.ready.host}:${record.ready.port}` : null;
    }
    if (record.ready.kind === "url") {
      const reachable = await probeUrl(record.ready.url);
      return reachable ? `url ready: ${record.ready.url}` : null;
    }
    if (record.ready.kind === "delay") {
      return Date.now() - record.startedAt >= record.ready.delayMs ? `delay elapsed: ${record.ready.delayMs}ms` : null;
    }
    return null;
  }

  /** 停止沿用原服务记录，只有确认进程结束后才返回成功快照。 */
  private async stopService(threadId: ThreadId, serviceId: string, reason: string): Promise<unknown> {
    const bucket = this.servicesByThread.get(threadId);
    const record = bucket?.get(serviceId) ?? null;
    if (!record) {
      return {
        action: "stop",
        serviceId,
        status: "stopped",
        stopped: false,
        reason: "not-found",
      };
    }
    await this.stopProcess(record, reason);
    return {
      ...this.buildServiceSnapshot(record, "stop", false),
      status: "stopped",
      stopped: true,
      stopReason: reason,
    };
  }

  /** 同一服务共用有界停止，失败结算读取当前诊断，保留在途新增原因供重试清理。 */
  private async stopProcess(record: ManagedServiceRecord, reason: string): Promise<void> {
    if (record.stopPromise) return record.stopPromise;
    const previousFailure = isDiagnosticFailure(record.processFailure) ? record.processFailure : null;
    const child = record.child;
    if (!child && previousFailure) throw previousFailure;
    record.stopRequested = true;
    const requestId = `managed-service-stop:${record.threadId}:${record.serviceId}:${Date.now()}`;
    const pid = record.pid;
    const stopping = Promise.resolve().then(() => new Promise<void>((resolve, reject) => {
      if (!child || !this.isAlive(record)) {
        if (record.status !== "stopped") this.finalizeTerminalRecord(record, "stopped", reason);
        resolve();
        return;
      }
      let settled = false;
      let sendingSignal = false;
      let exited = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      /** 每个结果都解除本次临时监听和计时器，不影响进程自身生命周期监听。 */
      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        clearTimeout(escalationTimer);
        clearTimeout(timeoutTimer);
      };
      /** 操作失败保留原始 cause，不能触发终态清理。 */
      const fail = (code: string, cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Object.assign(new Error(code, { cause }), { code }));
      };
      /** 退出事件是成功依据；同步 kill 返回/抛错后再结算以保留信号错误。 */
      const onExit = () => {
        exited = true;
        if (sendingSignal || settled) return;
        settled = true;
        cleanup();
        try {
          if (!(record.child == null && record.status === "stopped")) this.finalizeTerminalRecord(record, "stopped", reason);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => fail("MANAGED_SERVICE_KILL_FAILED", error);
      /** 发送失败立即停止本次流程，不把 false 或异常当作进程退出。 */
      const sendSignal = (signal?: NodeJS.Signals) => {
        sendingSignal = true;
        try {
          if (!child.kill(signal)) {
            fail("MANAGED_SERVICE_KILL_FAILED", new Error("进程未接受停止信号"));
            return;
          }
        } catch (error) {
          fail("MANAGED_SERVICE_KILL_FAILED", error);
        } finally {
          sendingSignal = false;
        }
        if (exited && !settled) onExit();
      };
      child.once("exit", onExit);
      child.once("error", onError);
      if (child.exitCode != null || child.signalCode != null) { onExit(); return; }
      escalationTimer = setTimeout(() => sendSignal("SIGKILL"), 1_000);
      timeoutTimer = setTimeout(() => fail("MANAGED_SERVICE_EXIT_TIMEOUT", new Error("等待进程退出超时")), 2_000);
      sendSignal();
    })).catch(async error => {
      const currentFailure = isDiagnosticFailure(record.processFailure) ? record.processFailure : previousFailure;
      const failure = currentFailure && error !== currentFailure
        ? Object.assign(new AggregateError([currentFailure, error], FAILURE_LOG_FAILED, { cause: currentFailure }), { code: FAILURE_LOG_FAILED }) : error;
      if (currentFailure) record.processFailure = failure;
      await this.withDatabase(requestId, () => this.logProcessFailure(record, failure, requestId, reason, pid));
      throw failure;
    }).then(async () => {
      await this.drainDatabaseWork(record);
      if (isDiagnosticFailure(record.processFailure)) throw record.processFailure;
      record.processFailure = null;
    }).finally(() => { if (record.stopPromise === stopping) record.stopPromise = null; });
    record.stopPromise = stopping;
    await stopping;
    record.readySummary = record.readySummary ?? `stopped: ${reason}`;
  }

  /** emitter 不向全局抛错；完整失败交由原 record 与在途启动/停止公开入口消费。 */
  private recordEventFailure(record: ManagedServiceRecord, error: unknown, reason: string): void {
    if (this.options.withLegacyDatabase) {
      this.scheduleDatabaseWork(record, () => this.recordEventFailureInDatabase(record, error, reason));
      return;
    }
    this.recordEventFailureInDatabase(record, error, reason);
  }

  /** 原进程事件 owner 在持许可时记录根因并保留失败事实。 */
  private recordEventFailureInDatabase(record: ManagedServiceRecord, error: unknown, reason: string): void {
    const previous = isDiagnosticFailure(record.processFailure) ? record.processFailure : null;
    const failure = previous ? Object.assign(new AggregateError([previous, error], FAILURE_LOG_FAILED, { cause: previous }), { code: FAILURE_LOG_FAILED })
      : error;
    try {
      this.logProcessFailure(record, failure, `managed-service-process:${record.threadId}:${record.serviceId}:${Date.now()}`, reason);
      record.processFailure = failure instanceof Error ? failure : new Error("MANAGED_SERVICE_PROCESS_FAILED", { cause: failure });
    }
    catch (diagnostic) { record.processFailure = diagnostic as Error; }
    this.pruneTerminalRecords(record.threadId);
  }

  /** 固定 W 同步记录有界 data 根因；描述或写入失败均保留原对象和副错。 */
  private logProcessFailure(record: ManagedServiceRecord, error: unknown, requestId: string, reason: string, pid = record.pid): void {
    try {
      let remaining = 20;
      /** 只读自有数据字段，访问器和未知 toString 不参与诊断。 */
      const data = (value: unknown, key: string): unknown => {
        if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
      };
      /** 聚合及 cause 保留定位信息，同时限制循环引用和日志体积。 */
      const describeCause = (cause: unknown, depth = 0): Record<string, unknown> => {
        remaining--;
        const errors: Record<string, unknown>[] = [];
        const nested = data(cause, "cause"), aggregate = data(cause, "errors"), name = data(cause, "name"), message = data(cause, "message");
        if (depth < 3 && Array.isArray(aggregate)) {
          const length = data(aggregate, "length");
          if (typeof length === "number") for (let index = 0; index < Math.min(10, length) && remaining > 0; index++) errors.push(describeCause(data(aggregate, String(index)), depth + 1));
        }
        const primitive = cause === null || (typeof cause !== "object" && typeof cause !== "function");
        return {
          name: redactClientStartupText(typeof name === "string" ? name : cause instanceof Error ? "Error" : typeof cause).slice(0, 1000),
          message: redactClientStartupText(typeof message === "string" ? message : primitive ? String(cause) : "[non-data error]").slice(0, 1000),
          ...(errors.length ? { errors } : {}),
          ...(depth < 3 && remaining > 0 && nested !== undefined ? { cause: describeCause(nested, depth + 1) } : {}),
        };
      };
      const code = data(error, "code"), errorCode = typeof code === "string" ? redactClientStartupText(code).slice(0, 1000) : "MANAGED_SERVICE_STOP_FAILED";
      this.options.db.writeWorkspaceLog(record.workspaceId, { level: "error", tag: "managed-service", message: "managed service operation failed", data: {
        code: errorCode, errorCode, event: { category: "managed-service", action: reason, outcome: "fail" },
        requestId, workspaceId: record.workspaceId, instanceId: record.instanceId, threadId: record.threadId, serviceId: record.serviceId, pid, reason, rootCause: describeCause(error),
      } });
    } catch (diagnostic) {
      const failure = Object.assign(new AggregateError([error, diagnostic], FAILURE_LOG_FAILED, { cause: error }), { code: FAILURE_LOG_FAILED });
      record.processFailure = failure;
      throw failure;
    }
  }

  /** 查询不把有运行错误的服务伪装健康，停止入口仍可回收该进程。 */
  private describeService(
    threadId: ThreadId,
    serviceId: string,
    action: "ensure" | "status",
    reused = false,
  ): Record<string, unknown> {
    const bucket = this.servicesByThread.get(threadId);
    const record = bucket?.get(serviceId) ?? null;
    if (!record) {
      return {
        action,
        serviceId,
        status: "stopped",
        exists: false,
        reused,
      };
    }
    if (record.processFailure) throw record.processFailure;
    return this.buildServiceSnapshot(record, action, reused);
  }

  private buildServiceSnapshot(
    record: ManagedServiceRecord,
    action: "ensure" | "status" | "stop",
    reused: boolean,
  ): Record<string, unknown> {
    const snapshot = this.toManagedServiceSnapshot(record);
    return {
      action,
      serviceId: snapshot.serviceId,
      status: snapshot.status,
      exists: true,
      reused,
      pid: snapshot.pid,
      command: snapshot.command,
      args: snapshot.args,
      workingDirectory: snapshot.workingDirectory,
      startupTimeoutMs: snapshot.startupTimeoutMs,
      readySummary: snapshot.readySummary,
      startedAt: snapshot.startedAt,
      readyAt: snapshot.readyAt,
      exitedAt: snapshot.exitedAt,
      exitCode: snapshot.exitCode,
      exitSignal: snapshot.exitSignal,
    };
  }

  private toManagedServiceSnapshot(record: ManagedServiceRecord): ManagedServiceSnapshot {
    return {
      serviceId: record.serviceId,
      displayName: record.serviceId,
      source: "platform",
      stopSupported: true,
      status: record.status,
      pid: record.pid,
      command: record.command,
      args: [...record.args],
      workingDirectory: record.workingDirectory,
      startupTimeoutMs: record.startupTimeoutMs,
      readySummary: record.readySummary,
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
    };
  }

  private getOrCreateBucket(threadId: ThreadId, instanceId: OrchestrationId | null): Map<string, ManagedServiceRecord> {
    if (instanceId) this.registerThreadOwner(instanceId, threadId);
    let bucket = this.servicesByThread.get(threadId);
    if (!bucket) {
      bucket = new Map();
      this.servicesByThread.set(threadId, bucket);
    }
    return bucket;
  }

  private registerThreadOwner(instanceId: OrchestrationId, threadId: ThreadId): void {
    let owners = this.threadIdsByInstance.get(instanceId);
    if (!owners) {
      owners = new Set<ThreadId>();
      this.threadIdsByInstance.set(instanceId, owners);
    }
    owners.add(threadId);
  }

  private forgetThreadOwner(threadId: ThreadId): void {
    for (const [instanceId, owners] of this.threadIdsByInstance.entries()) {
      owners.delete(threadId);
      if (owners.size === 0) {
        this.threadIdsByInstance.delete(instanceId);
      }
    }
  }

  /** 真实退出不回滚；资源释放保留诊断和在途 owner，通知失败由调用边界交付。 */
  private finalizeTerminalRecord(
    record: ManagedServiceRecord,
    status: "exited" | "stopped",
    reason: ManagedServiceChangeReason | string,
  ): void {
    record.status = status;
    record.stopRequested = status === "stopped";
    record.readySummary = buildTerminalSummary(status, String(reason ?? ""));
    try {
      this.notifyChanged(record, this.normalizeChangeReason(reason, status));
      if (!isDiagnosticFailure(record.processFailure)) record.processFailure = null;
    }
    finally {
      record.child = null;
      record.pid = null;
      record.exitedAt = record.exitedAt ?? Date.now();
      this.compactTerminalRecord(record);
    }
  }

  private compactTerminalRecord(record: ManagedServiceRecord): void {
    record.fingerprint = "";
    record.ready = { kind: "delay", delayMs: 0 };
    record.env = {};
    record.readinessStdoutTail = "";
    record.readinessStderrTail = "";
  }

  /** TTL 与线程容量仅回收普通终态，诊断失败仍由原 record 持有。 */
  private pruneTerminalRecords(threadId: ThreadId): void {
    const bucket = this.servicesByThread.get(threadId);
    if (!bucket?.size) return;
    const now = Date.now();
    const terminalEntries = [...bucket.entries()]
      .filter(([, record]) => !record.databaseWork && !isDiagnosticFailure(record.processFailure) && (record.status === "stopped" || record.status === "exited"))
      .sort((left, right) => this.getTerminalSortTs(right[1]) - this.getTerminalSortTs(left[1]));

    for (let index = 0; index < terminalEntries.length; index += 1) {
      const [serviceId, record] = terminalEntries[index]!;
      const expired = now - this.getTerminalSortTs(record) > TERMINAL_RECORD_TTL_MS;
      const overflow = index >= MAX_TERMINAL_RECORDS_PER_THREAD;
      if (expired || overflow) {
        bucket.delete(serviceId);
      }
    }

    if (!bucket.size) {
      this.servicesByThread.delete(threadId);
      this.forgetThreadOwner(threadId);
    }
    this.pruneGlobalTerminalRecords();
  }

  private getTerminalSortTs(record: ManagedServiceRecord): number {
    return record.exitedAt ?? record.readyAt ?? record.startedAt;
  }

  /** 全局容量遵循相同保因边界，不能删除尚未明确处理的诊断。 */
  private pruneGlobalTerminalRecords(): void {
    const terminalEntries: Array<{ threadId: ThreadId; serviceId: string; record: ManagedServiceRecord }> = [];
    for (const [threadId, bucket] of this.servicesByThread.entries()) {
      for (const [serviceId, record] of bucket.entries()) {
        if (record.databaseWork || isDiagnosticFailure(record.processFailure) || (record.status !== "stopped" && record.status !== "exited")) continue;
        terminalEntries.push({ threadId, serviceId, record });
      }
    }
    terminalEntries.sort((left, right) => this.getTerminalSortTs(right.record) - this.getTerminalSortTs(left.record));
    for (let index = MAX_TERMINAL_RECORDS_GLOBAL; index < terminalEntries.length; index += 1) {
      const entry = terminalEntries[index]!;
      const bucket = this.servicesByThread.get(entry.threadId);
      bucket?.delete(entry.serviceId);
      if (bucket && bucket.size === 0) {
        this.servicesByThread.delete(entry.threadId);
        this.forgetThreadOwner(entry.threadId);
      }
    }
  }

  private normalizeChangeReason(
    reason: ManagedServiceChangeReason | string,
    fallbackStatus: "exited" | "stopped",
  ): ManagedServiceChangeReason {
    switch (reason) {
      case "starting":
      case "ready":
      case "exited":
      case "stopped":
      case "startup-failed":
      case "reconfigured":
      case "instance-disposed":
      case "spawn-error":
      case "process-exit":
        return reason;
      default:
        return fallbackStatus;
    }
  }

  private notifyChanged(record: ManagedServiceRecord, reason: ManagedServiceChangeReason): void {
    const notify = () => this.options.onChanged?.({
      instanceId: record.instanceId,
      threadId: record.threadId,
      serviceId: record.serviceId,
      status: record.status,
      reason,
    });
    if (this.options.withLegacyDatabase) this.scheduleDatabaseWork(record, notify);
    else notify();
  }

  /** killed 仅代表信号已发送；退出码或退出信号才说明 ChildProcess 已结束。 */
  private isAlive(record: ManagedServiceRecord): boolean {
    return Boolean(record.child && record.child.exitCode == null && record.child.signalCode == null && record.status !== "stopped" && record.status !== "exited");
  }

  private buildStartupFailureMessage(record: ManagedServiceRecord, reason: string): string {
    const stderr = trimForMessage(record.readinessStderrTail);
    const stdout = trimForMessage(record.readinessStdoutTail);
    return [
      `进程 ${record.serviceId} 启动失败：${reason}`,
      `command: ${record.command} ${record.args.join(" ")}`.trim(),
      `cwd: ${record.workingDirectory}`,
      record.ready.kind === "url" ? `ready: url=${record.ready.url}` : "",
      record.ready.kind === "port" ? `ready: port=${record.ready.host}:${record.ready.port}` : "",
      record.ready.kind === "stdout" ? `ready: stdoutPattern=${record.ready.pattern}` : "",
      record.ready.kind === "delay" ? `ready: delayMs=${record.ready.delayMs}` : "",
      stdout ? `stdout tail:\n${stdout}` : "",
      stderr ? `stderr tail:\n${stderr}` : "",
    ].filter(Boolean).join("\n\n");
  }
}

function buildTerminalSummary(
  status: "exited" | "stopped",
  reason: string,
): string {
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason || normalizedReason === status) return status;
  return `${status}: ${normalizedReason}`;
}

function parseReadyConfig(raw: unknown, workingDirectory: string): ReadyConfig {
  const record = asRecord(raw);
  const url = String(record.url ?? "").trim();
  if (url) return { kind: "url", url };
  const port = Number(record.port);
  if (Number.isFinite(port) && port > 0) {
    const host = String(record.host ?? "127.0.0.1").trim() || "127.0.0.1";
    return { kind: "port", port: Math.round(port), host };
  }
  const stdoutPattern = String(record.stdoutPattern ?? "").trim();
  if (stdoutPattern) return { kind: "stdout", pattern: stdoutPattern };
  const delayMs = clampNumber(record.delayMs, 100, 60_000, 500);
  return { kind: "delay", delayMs };
}

function resolveWorkspaceDirectory(workspacePath: string, workingDirectory: string): string {
  if (!workingDirectory) return workspacePath;
  const abs = path.resolve(workspacePath, workingDirectory);
  const relative = path.relative(path.resolve(workspacePath), abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`参数错误：workingDirectory 越界，收到 ${workingDirectory}`);
  }
  return abs;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown, fieldName: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`参数错误：${fieldName} 不能为空`);
  return text;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`参数错误：${fieldName} 必须是字符串数组`);
  return value.map((item, index) => {
    const text = String(item ?? "").trim();
    if (!text) throw new Error(`参数错误：${fieldName}[${index}] 不能为空`);
    return text;
  });
}

function readStringMap(value: unknown, fieldName: string): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`参数错误：${fieldName} 必须是对象`);
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) continue;
    result[normalizedKey] = String(raw ?? "");
  }
  return result;
}

function appendReadinessTail(current: string, nextChunk: string): string {
  const next = `${current}${nextChunk}`;
  return next.length > MAX_READINESS_BUFFER_CHARS ? next.slice(-MAX_READINESS_BUFFER_CHARS) : next;
}

function trimForMessage(text: string): string {
  const normalized = String(text ?? "").trim();
  return normalized.length > 4_000 ? normalized.slice(-4_000) : normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    timer.unref?.();
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.status >= 100;
  } catch {
    return false;
  }
}

async function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
