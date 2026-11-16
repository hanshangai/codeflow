import crypto from "node:crypto";

import {
  CONTROLLED_EXPERIMENT_CONTRACT_VERSION,
  extractTurnErrorMetadata,
  normalizeEngineKeyProviderId,
  type ControlledExperimentFreezeRpcRequest,
  type ControlledExperimentFreezeRpcResponse,
  type ControlledExperimentRunRpcFailureResponse,
  type ControlledExperimentRunRpcResponse,
  type ControlledExperimentRunRpcResult,
  type ControlledExperimentRunStartRpcRequest,
  type ControlledExperimentRunStatusRpcRequest,
  type ControlledExperimentVariantConfig,
  type ControlledExperimentVariantKey,
  type ConversationEventInput,
  type EngineModelProviderId,
  type RawEngineEventInput,
  type SessionId,
  type ThreadId,
  type TurnId,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type {
  ControlledExperimentLocalRun,
  ControlledExperimentLocalSnapshot,
  ControlledExperimentRunUsage,
} from "../db/repos/controlledExperimentRepo.js";
import { ControlledExperimentRunConflictError } from "../db/repos/controlledExperimentRepo.js";
import { EngineTimeoutError } from "../engines/turnTimeoutController.js";
import { assertClientReasoningEffortSupported } from "../engines/engineModelCapabilities.js";
import type {
  CodexDanglingTurnReconcileResult,
  IsolatedThreadSessionHandle,
  ThreadSessionManager,
} from "../engines/threadSessionManager.js";
import { logger } from "../logger.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import { buildPromptDefinitionHash } from "../orchestration/promptDefinitionHash.js";
import {
  getActiveEngineModelCatalogSnapshot,
  resolveRuntimeEngineModelProviderId,
} from "../engines/engineModelCatalogRuntime.js";

type ControlledExperimentSessionRuntime = Pick<ThreadSessionManager,
  "createIsolatedSession" | "getWorkspacePath" | "interruptCodexTurnByEngineIds" | "reconcileCodexDanglingTurn">;

const NO_PRICE_SNAPSHOT_SHA256 = "0".repeat(64);

type ActiveRun = {
  handle: IsolatedThreadSessionHandle;
  sideEffectBlocked: boolean;
  interruption?: Promise<PromiseSettledResult<void>>;
};

type ExecutorErrorCode =
  | "CONTROLLED_EXPERIMENT_CONFLICT"
  | "FREEZE_EVIDENCE_INVALID"
  | "LOCAL_EVIDENCE_MISSING"
  | "DESKTOP_UPDATE_IN_PROGRESS";

export class ControlledExperimentExecutorError extends Error {
  /** 构造可安全返回给 Server 的稳定实验错误。 */
  constructor(
    readonly status: number,
    readonly code: ExecutorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlledExperimentExecutorError";
  }
}

/** Client 受控实验唯一执行器，负责冻结、隔离调用、状态查询、取消和重启对账。 */
export class ControlledExperimentExecutor {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly launchingRuns = new Set<string>();
  private readonly inFlightRuns = new Map<string, Promise<PromiseSettledResult<void>>>();
  private readonly workspaceExecutors = new Map<WorkspaceId, ControlledExperimentExecutor>();
  private disposed = false;

  /** 根 owner 保应用身份与生命周期，每个工作区子 owner 只持固定仓储视图。 */
  constructor(private readonly deps: {
    db: ClientDb;
    workspaces: Map<WorkspaceId, string>;
    sessions: ControlledExperimentSessionRuntime;
    now?: () => number;
    onFatalError?: (error: Error) => void;
    isTaskAdmissionPaused?: () => boolean;
    /** 同步仓储短段由唯一Writer准入，provider与释放等待保持在许可外。 */
    withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  }) {}

  /** 复用既有执行owner，只协调其同步数据库读取、写入及诊断。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.deps.withLegacyDatabase ? this.deps.withLegacyDatabase("controlled-experiment", operation) : operation();
  }

  /** 沿可信承载工作区创建子执行器，隔离同名 Run 与异步回调。 */
  forWorkspace(workspaceId: WorkspaceId): ControlledExperimentExecutor {
    if (this.disposed) throw new Error("CONTROLLED_EXPERIMENT_EXECUTOR_DISPOSED");
    if (!this.deps.workspaces.has(workspaceId)) throw invalidFreeze("目标本地工作区不存在或已删除");
    if (this.deps.db.workspaceId === workspaceId) return this;
    if (this.deps.db.workspaceId) throw invalidFreeze("实验工作区与当前执行作用域不匹配");
    const existing = this.workspaceExecutors.get(workspaceId);
    if (existing) return existing;
    const executor = new ControlledExperimentExecutor({ ...this.deps, db: this.deps.db.forWorkspace(workspaceId) });
    this.workspaceExecutors.set(workspaceId, executor);
    return executor;
  }

  /** Run RPC 必须携工作区或由已选定入口调用，禁止按裸 Run ID 扫描定位。 */
  private requestExecutor(request: { workspaceId?: string }): ControlledExperimentExecutor {
    const workspaceId = normalizeOptionalText(request.workspaceId) as WorkspaceId | null;
    if (workspaceId) return this.forWorkspace(workspaceId);
    if (this.deps.db.workspaceId === null) throw new ControlledExperimentExecutorError(400, "LOCAL_EVIDENCE_MISSING", "受控实验请求缺少工作区作用域");
    return this;
  }

  /** 冻结整批 Prompt、Variant 和 Provider 证据，任一不完整则整批不落库。 */
  freeze(request: ControlledExperimentFreezeRpcRequest): ControlledExperimentFreezeRpcResponse {
    const executor = this.requestExecutor(request);
    if (executor !== this) return executor.freeze(request);
    this.assertContract(request.contractVersion);
    const activeCatalog = requireActiveCatalog();
    const experimentId = requireText(request.experimentId, "experimentId");
    const workspaceId = requireText(request.workspaceId, "workspaceId") as WorkspaceId;
    if (!this.deps.workspaces.has(workspaceId)) throw invalidFreeze("目标本地工作区不存在或已删除");
    if (!Number.isSafeInteger(request.freezeRevision) || request.freezeRevision < 1) throw invalidFreeze("冻结 revision 无效");
    if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 200) {
      throw invalidFreeze("冻结样本数必须在 1 到 200 之间");
    }
    const ordinals = new Set(request.items.map((item) => item.ordinal));
    if (ordinals.size !== request.items.length || [...ordinals].some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0)) {
      throw invalidFreeze("冻结样本顺序无效或重复");
    }
    const existing = this.deps.db.controlledExperiments.listSnapshotsByFreeze(experimentId, request.freezeRevision);
    if (existing.length > 0) {
      if (existing.some((snapshot) => snapshot.catalogVersion !== activeCatalog.configVersion)) {
        throw invalidFreeze("模型目录版本已变化，请使用新的 freeze revision 重新冻结实验");
      }
      return this.restoreFreezeResponse(request, existing);
    }

    const baselineConfig = normalizeVariantConfig(request.baselineCohort);
    const candidateConfig = normalizeVariantConfig(request.candidate);
    assertClientReasoningEffortSupported(
      this.deps.db,
      baselineConfig.engine,
      baselineConfig.model,
      baselineConfig.effort,
    );
    assertClientReasoningEffortSupported(
      this.deps.db,
      candidateConfig.engine,
      candidateConfig.model,
      candidateConfig.effort,
    );
    const createdAt = this.now();
    const candidateProviderId = this.requireCandidateProvider(candidateConfig);
    const prepared: ControlledExperimentLocalSnapshot[] = [];
    const sampleResponses: ControlledExperimentFreezeRpcResponse["samples"] = [];
    const variantEvidence = new Map<ControlledExperimentVariantKey, {
      config: ControlledExperimentVariantConfig;
      configSha256: string;
      promptDefinitionSha256: string;
    }>();

    for (const item of request.items.slice().sort((left, right) => left.ordinal - right.ordinal)) {
      const source = this.deps.db.orchPromptSnapshots.get(requireText(item.promptSnapshotId, "promptSnapshotId"));
      if (!source || source.contentLoaded === false) throw invalidFreeze(`Prompt Snapshot 不完整：${item.promptSnapshotId}`);
      if (String(source.instanceId) !== requireText(item.sourceInstanceId, "sourceInstanceId")
        || source.nodeId !== requireText(item.nodeId, "nodeId")) {
        throw invalidFreeze(`Prompt Snapshot 来源不匹配：${item.promptSnapshotId}`);
      }
      if (source.engine !== baselineConfig.engine || normalizeText(source.model) !== baselineConfig.model
        || normalizeOptionalText(source.effort) !== baselineConfig.effort) {
        throw invalidFreeze(`Prompt Snapshot 基线执行配置漂移：${item.promptSnapshotId}`);
      }
      assertNoRuntimeDependencies(source.promptEnvelope, source.artifactInput, item.promptSnapshotId);
      const inputSha256 = sha256Json({
        promptEnvelope: source.promptEnvelope,
        systemMessage: source.systemMessage,
        developerMessage: source.developerMessage ?? null,
        userMessage: source.userMessage,
      });
      if (inputSha256 !== requireSha256(item.expectedPromptSha256, "expectedPromptSha256")) {
        throw invalidFreeze(`Prompt Snapshot 输入摘要漂移：${item.promptSnapshotId}`);
      }
      const promptDefinitionSha256 = buildPromptDefinitionHash(
        source.promptEnvelope as unknown as Record<string, unknown>,
        requireText(request.baselineCohort.workflowSnapshotHash, "workflowSnapshotHash"),
        requireText(request.baselineCohort.nodeId, "baseline nodeId"),
        requireText(request.baselineCohort.roleSnapshotHash, "roleSnapshotHash"),
      );
      if (promptDefinitionSha256 !== requireSha256(request.baselineCohort.promptDefinitionHash, "promptDefinitionHash")) {
        throw invalidFreeze(`Prompt Snapshot 定义摘要漂移：${item.promptSnapshotId}`);
      }
      const baselineProviderId = this.requireBaselineProvider(source.promptEnvelope, baselineConfig, item.promptSnapshotId);
      const sampleId = deterministicId("omcs", experimentId, requireText(item.evaluationItemId, "evaluationItemId"));
      for (const [variantKey, config, providerId] of [
        ["baseline", baselineConfig, baselineProviderId],
        ["candidate", candidateConfig, candidateProviderId],
      ] as const) {
        const configSha256 = buildVariantConfigSha(config, providerId);
        const existingVariant = variantEvidence.get(variantKey);
        if (existingVariant && (existingVariant.configSha256 !== configSha256
          || existingVariant.promptDefinitionSha256 !== promptDefinitionSha256)) {
          throw invalidFreeze(`同一 Variant 的冻结证据不一致：${variantKey}`);
        }
        variantEvidence.set(variantKey, {
          config,
          configSha256,
          promptDefinitionSha256,
        });
        prepared.push({
          id: deterministicId("omcls", experimentId, String(request.freezeRevision), sampleId, variantKey),
          experimentId,
          freezeRevision: request.freezeRevision,
          freezeDigest: "",
          workspaceId,
          sampleId,
          evaluationItemId: requireText(item.evaluationItemId, "evaluationItemId"),
          sourceInstanceId: String(source.instanceId),
          nodeId: source.nodeId,
          promptSnapshotId: source.id,
          ordinal: item.ordinal,
          variantKey,
          ...config,
          catalogVersion: activeCatalog.configVersion,
          promptEnvelope: source.promptEnvelope,
          systemMessage: source.systemMessage,
          developerMessage: source.developerMessage ?? null,
          userMessage: source.userMessage,
          artifactInput: source.artifactInput,
          inputSha256,
          configSha256,
          promptDefinitionSha256,
          priceSnapshot: null,
          priceSnapshotSha256: NO_PRICE_SNAPSHOT_SHA256,
          perRunTimeoutMs: request.budget.perRunTimeoutMs,
          createdAt,
        });
      }
      sampleResponses.push({
        id: sampleId,
        evaluationItemId: item.evaluationItemId,
        promptSnapshotId: source.id,
        inputSha256,
        ordinal: item.ordinal,
        localSnapshotId: deterministicId("omcls", experimentId, String(request.freezeRevision), sampleId, "baseline"),
      });
    }

    const variants = (["baseline", "candidate"] as const).map((variantKey) => {
      const evidence = variantEvidence.get(variantKey);
      if (!evidence) throw invalidFreeze(`冻结 Variant 缺失：${variantKey}`);
      return { variantKey, ...evidence.config, configSha256: evidence.configSha256,
        promptDefinitionSha256: evidence.promptDefinitionSha256 };
    });
    const freezeDigest = sha256Json({
      contractVersion: CONTROLLED_EXPERIMENT_CONTRACT_VERSION,
      experimentId,
      freezeRevision: request.freezeRevision,
      workspaceId,
      catalogVersion: activeCatalog.configVersion,
      variants,
      samples: sampleResponses.map(({ localSnapshotId, ...sample }) => ({ ...sample, localSnapshotId })),
    });
    const committed = this.deps.db.controlledExperiments.commitFreeze({
      experimentId,
      freezeRevision: request.freezeRevision,
      freezeDigest,
      snapshots: prepared.map((snapshot) => ({ ...snapshot, freezeDigest })),
    });
    if (committed.snapshots.length !== prepared.length) throw invalidFreeze("冻结事务提交后证据数量不一致");
    return { ok: true, experimentId, freezeRevision: request.freezeRevision, freezeDigest, variants, samples: sampleResponses };
  }

  /** 持久化 dispatch 后异步启动一次隔离模型调用；重复请求不创建第二次调用。 */
  start(request: ControlledExperimentRunStartRpcRequest): ControlledExperimentRunRpcResult {
    const executor = this.requestExecutor(request);
    if (executor !== this) return executor.start(request);
    this.assertContract(request.contractVersion);
    this.assertTaskAdmission(request.runId);
    const snapshot = this.requireMatchingSnapshot(request);
    const now = this.now();
    let created: ReturnType<ClientDb["controlledExperiments"]["createDispatchedRun"]>;
    try {
      created = this.deps.db.controlledExperiments.createDispatchedRun({
        id: requireText(request.runId, "runId"),
        experimentId: requireText(request.experimentId, "experimentId"),
        assignmentId: requireText(request.assignmentId, "assignmentId"),
        sampleId: requireText(request.sampleId, "sampleId"),
        variantKey: request.variantKey,
        attemptNo: requireAttemptNo(request.attemptNo),
        snapshotId: snapshot.id,
        dispatchTokenSha256: sha256Text(requireText(request.dispatchToken, "dispatchToken")),
        clientTurnId: deterministicId("omct", request.runId) as TurnId,
        engine: snapshot.engine,
        deadlineAt: requirePositiveInteger(request.deadlineAt, "deadlineAt"),
        now,
      });
    } catch (cause) {
      if (cause instanceof ControlledExperimentRunConflictError) {
        throw new ControlledExperimentExecutorError(409, "CONTROLLED_EXPERIMENT_CONFLICT", "重复 dispatch 身份冲突", { cause });
      }
      throw this.notifyFatalPersistenceFailure(request.runId, "dispatch 无法落库", cause);
    }
    if (!isTerminal(created.run.status) && !this.activeRuns.has(created.run.id)) this.launchRun(created.run.id);
    return this.toRpcResult(created.run);
  }

  /** 查询 token 绑定的当前状态；重启后的 Codex Run 会先做一次权威对账。 */
  async status(request: ControlledExperimentRunStatusRpcRequest): Promise<ControlledExperimentRunRpcResult> {
    const executor = await this.withDatabase(() => this.requestExecutor(request));
    if (executor !== this) return executor.status(request);
    this.assertContract(request.contractVersion);
    let run = await this.withDatabase(() => this.requireTokenBoundRun(request));
    if (!isTerminal(run.status) && !this.activeRuns.has(run.id) && !this.launchingRuns.has(run.id)) {
      if (run.status === "dispatched") {
        if (!this.deps.isTaskAdmissionPaused?.()) await this.withDatabase(() => this.launchRun(run.id));
      } else run = await this.reconcilePersistedRun(run);
    }
    return this.toRpcResult(await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(run.id)) ?? run);
  }

  /** 请求取消 token 绑定的 Run；活跃会话必须先中断再由执行路径收敛。 */
  async cancel(request: ControlledExperimentRunStatusRpcRequest): Promise<ControlledExperimentRunRpcResult> {
    const executor = await this.withDatabase(() => this.requestExecutor(request));
    if (executor !== this) return executor.cancel(request);
    this.assertContract(request.contractVersion);
    let run = await this.withDatabase(() => this.requireTokenBoundRun(request));
    run = await this.withDatabase(() => this.deps.db.controlledExperiments.requestCancel(run.id));
    const active = this.activeRuns.get(run.id);
    if (active) {
      const result = await this.interruptActiveRun(run, active);
      if (result.status === "rejected") throw result.reason;
    } else if (!isTerminal(run.status)) {
      run = await this.reconcilePersistedRun(run, true);
    }
    return this.toRpcResult(await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(run.id)) ?? run);
  }

  /** Client 启动时恢复可证明尚未调用的 dispatch，并对账其余非终态 Run。 */
  async recoverOnStartup(): Promise<void> {
    if (this.deps.db.workspaceId === null) {
      for (const workspaceId of this.deps.workspaces.keys()) await (await this.withDatabase(() => this.forWorkspace(workspaceId))).recoverOnStartup();
      return;
    }
    for (const run of await this.withDatabase(() => this.deps.db.controlledExperiments.listRecoverableRuns())) {
      if (run.status === "dispatched") {
        if (!this.deps.isTaskAdmissionPaused?.()) await this.withDatabase(() => this.launchRun(run.id));
        continue;
      }
      await this.reconcilePersistedRun(run, run.status === "cancel_requested");
    }
  }

  /** 只投影已有执行 owner；持久化的 detached Run 仍由原仓储活动查询负责。 */
  hasInFlightWork(): boolean {
    return this.activeRuns.size > 0 || this.launchingRuns.size > 0
      || [...this.workspaceExecutors.values()].some(executor => executor.hasInFlightWork());
  }

  /** 更新在统一准入冻结后调用；取消原 Run 并等待真实调用、清理及持久终态。 */
  async stopForUpdate(input: { requestId: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!input.requestId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("DESKTOP_UPDATE_EXPERIMENT_INPUT_INVALID");
    if (this.deps.db.workspaceId === null) {
      const results = await Promise.allSettled([...this.deps.workspaces.keys()].map(async workspaceId => {
        const executor = await this.withDatabase(() => this.forWorkspace(workspaceId));
        await executor.stopForUpdate(input);
      }));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "受控实验工作区停止失败");
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let current: ControlledExperimentLocalRun | null = null;
    let workspaceId: string | null = null;
    /** 所有异步步骤共用一次停止预算，超时不删除仍在途的 owner。 */
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("等待受控实验停止超时"), { code: "DESKTOP_UPDATE_EXPERIMENT_STOP_TIMEOUT" })), Math.max(0, deadline - Date.now()));
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    try {
      const ids = new Set([...await this.withDatabase(() => this.deps.db.controlledExperiments.listRecoverableRuns().map(run => run.id)), ...this.inFlightRuns.keys(), ...this.activeRuns.keys()]);
      for (const runId of ids) {
        current = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
        if (!current) throw new Error(`更新停止缺少受控实验 Run：runId=${runId}`);
        const snapshotId = current.snapshotId;
        workspaceId = (await this.withDatabase(() => this.deps.db.controlledExperiments.getSnapshot(snapshotId)))?.workspaceId ?? null;
        const execution = this.inFlightRuns.get(runId);
        const active = this.activeRuns.get(runId);
        if (!isTerminal(current.status)) current = await this.withDatabase(() => this.deps.db.controlledExperiments.requestCancel(runId));
        if (execution && !this.launchingRuns.has(runId)) {
          const result = await wait(execution);
          if (result.status === "rejected") {
            if (!active && !isTerminal(current.status) && this.inFlightRuns.get(runId) === execution) this.inFlightRuns.delete(runId);
            throw result.reason;
          }
        }
        if (active) {
          const interrupted = await wait(this.interruptActiveRun(current, active));
          if (interrupted.status === "rejected") throw interrupted.reason;
        }
        if (execution) {
          const result = await wait(execution);
          if (result.status === "rejected") {
            if (!active && !isTerminal(current.status) && this.inFlightRuns.get(runId) === execution) this.inFlightRuns.delete(runId);
            throw result.reason;
          }
        }
        current = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
        if (!current) throw new Error(`更新停止后缺少受控实验 Run：runId=${runId}`);
        if (!isTerminal(current.status)) {
          const run = current;
          const reconciliation = this.trackRunOperation(runId, async () => {
            const latest = await this.reconcilePersistedRun(run, true, input.requestId);
            if (!isTerminal(latest.status)) throw new Error(`受控实验停止尚未确认：runId=${runId}`);
          });
          const result = await wait(reconciliation);
          if (result.status === "rejected") {
            this.inFlightRuns.delete(runId);
            throw result.reason;
          }
          current = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
          if (!current) throw new Error(`更新对账后缺少受控实验 Run：runId=${runId}`);
        }
        if (!isTerminal(current.status)) throw new Error(`受控实验停止尚未确认：runId=${runId}`);
      }
    } catch (error) {
      await this.withDatabase(() => this.logFailure(error, input.requestId, current, "update_stop", workspaceId));
      throw error;
    }
  }

  /** 关闭前中断所有本进程隔离会话，确保 DB 关闭后不会继续写入。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const failures: Error[] = [];
    for (const [workspaceId, executor] of this.workspaceExecutors) {
      try { await executor.dispose(); }
      catch (cause) { failures.push(new Error(`受控实验工作区关闭失败：workspaceId=${workspaceId}`, { cause })); }
    }
    for (const [runId, active] of [...this.activeRuns]) {
      try {
        const run = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
        if (!run) throw new Error(`关闭时缺少受控实验 Run：runId=${runId}`);
        const result = await this.interruptActiveRun(run, active);
        if (result.status === "rejected") throw result.reason;
      } catch (cause) {
        failures.push(new Error(`受控实验隔离会话中断失败：runId=${runId}`, { cause }));
      }
    }
    const settlements = await Promise.all([...this.inFlightRuns.values()]);
    settlements.forEach((settlement, index) => {
      if (settlement.status === "rejected") {
        failures.push(new Error(`受控实验后台 Run 收敛失败：index=${index}`, { cause: settlement.reason }));
      }
    });
    if (failures.length) throw new AggregateError(failures, "受控实验隔离会话关闭失败");
  }

  /** 串行调度单个本地 Run，launching gate 防止重复 RPC 形成双调用。 */
  private launchRun(runId: string): void {
    if (this.disposed) throw new Error(`受控实验执行器已关闭，拒绝启动 Run：runId=${runId}`);
    this.assertTaskAdmission(runId);
    if (this.launchingRuns.has(runId) || this.activeRuns.has(runId)) return;
    if (this.launchingRuns.size > 0 || this.activeRuns.size > 0) return;
    this.trackRunOperation(runId, () => this.executeRun(runId), true);
  }

  /** 实际调用与 provider 对账共用原 owner，超时后仍能等待同一异步操作。 */
  private trackRunOperation(runId: string, operation: () => Promise<void>, settleFailure = false): Promise<PromiseSettledResult<void>> {
    const existing = this.inFlightRuns.get(runId);
    if (existing) return existing;
    this.launchingRuns.add(runId);
    const execution = Promise.resolve().then(operation)
      .then<PromiseSettledResult<void>, PromiseSettledResult<void>>(() => ({ status: "fulfilled", value: undefined }), async error => {
        if (settleFailure) {
          try { await this.withDatabase(() => this.settleUnexpectedExecutionFailure(runId, error)); }
          catch (settlementError) { return { status: "rejected", reason: new AggregateError([error, settlementError], "受控实验失败状态未保存") }; }
        }
        return { status: "rejected", reason: error };
      })
      .then(result => {
        this.launchingRuns.delete(runId);
        if (result.status === "fulfilled") this.inFlightRuns.delete(runId);
        return result;
      });
    this.inFlightRuns.set(runId, execution);
    return execution;
  }

  /** 执行一次全新隔离会话，并在释放成功后写入唯一终态。 */
  private async executeRun(runId: string): Promise<void> {
    const initialRun = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
    if (!initialRun || isTerminal(initialRun.status)) return;
    let run: ControlledExperimentLocalRun = initialRun;
    if (this.deps.isTaskAdmissionPaused?.() && run.status === "dispatched") return;
    const snapshot = await this.withDatabase(() => this.deps.db.controlledExperiments.getSnapshot(run.snapshotId));
    if (!snapshot) {
      await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
      return;
    }
    if (run.status === "cancel_requested") {
      await this.withDatabase(() => this.finishRun(run, "cancelled", null, null, "RUN_CANCELLED"));
      return;
    }
    try {
      await this.withDatabase(() => this.assertSnapshotRuntimeEvidence(snapshot));
    } catch (error) {
      await this.withDatabase(() => this.writeLog("error", "frozen provider evidence drifted", {
        code: "FREEZE_EVIDENCE_INVALID", requestId: `experiment:${runId}`,
        experimentId: run.experimentId,
        runId,
        sampleId: run.sampleId,
        workspaceId: snapshot.workspaceId,
        rootCause: redactClientStartupText(error instanceof Error ? error.message : String(error)),
      }));
      await this.withDatabase(() => this.finishFatal(run, "FREEZE_EVIDENCE_INVALID"));
      return;
    }
    const now = this.now();
    if (run.deadlineAt <= now) {
      await this.withDatabase(() => this.finishRun(run, "timed_out", null, zeroUsage(), "RUN_TIMEOUT"));
      return;
    }
    run = await this.withDatabase(() => this.deps.db.controlledExperiments.markRunning(run.id, now));
    if (run.status !== "running") return;

    let handle: IsolatedThreadSessionHandle | null = null;
    let responseText: string | null = null;
    const executionErrors: unknown[] = [], interruptionErrors: unknown[] = [], cleanupErrors: unknown[] = [];
    let captured: Promise<PromiseSettledResult<void>> = Promise.resolve({ status: "fulfilled", value: undefined });
    /** provider回调同步准入原尾链，按接收顺序逐段落库，首错阻断后续写入。 */
    const capture = (operation: () => void): void => {
      captured = captured.then(async previous => {
        if (previous.status === "rejected") return previous;
        try { await this.withDatabase(operation); return { status: "fulfilled" as const, value: undefined }; }
        catch (reason) { return { status: "rejected" as const, reason }; }
      });
    };
    /** 发送与终态共用同一捕获屏障，失败必须交回实际调用owner。 */
    const flushCapture = async (): Promise<void> => {
      const result = await captured;
      if (result.status === "rejected") throw result.reason;
    };
    try {
      await this.withDatabase(() => this.assertTaskAdmission(runId));
      handle = await this.withDatabase(() => this.deps.sessions.createIsolatedSession({
        sessionKey: deterministicId("omcsession", snapshot.workspaceId, run.id),
        workspaceId: snapshot.workspaceId as WorkspaceId,
        engine: snapshot.engine,
        onSessionId: (sessionId) => {
          capture(() => this.deps.db.controlledExperiments.bindProviderIds(runId, { engineSessionId: sessionId }));
        },
        onSessionBindingDropped: () => {
          throw new Error(`受控实验 provider session 失效：runId=${runId}`);
        },
      }));
      this.activeRuns.set(runId, { handle, sideEffectBlocked: false });
      const timeoutMs = Math.max(1, Math.min(snapshot.perRunTimeoutMs, run.deadlineAt - this.now()));
      const result = await handle.session.sendMessage({
        turnId: run.clientTurnId as TurnId,
        userItemId: deterministicId("omcui", run.id) as any,
        text: snapshot.userMessage,
        userMessage: snapshot.userMessage,
        systemMessage: snapshot.systemMessage,
        developerMessage: snapshot.developerMessage,
        toolRegistryJson: null,
        toolRegistry: null,
        executeHostTool: null,
        platformToolTransportRequirement: "optional",
        responseFormat: "text",
        providerNativeToolPolicy: "deny",
        conversationProfile: "orchestration",
        planMode: false,
        images: [],
        assistantItemId: deterministicId("omcai", run.id),
        reasoningItemId: deterministicId("omcri", run.id),
        accessMode: "read-only",
        model: snapshot.model,
        effort: snapshot.effort,
        timeoutPolicy: {
          mode: "legacy-turn",
          timeoutMs,
          startupTimeoutMs: Math.min(30_000, timeoutMs),
        },
      }, {
        conversation: (event) => {
          if (event.type === "item.tool.started") this.activeRuns.get(runId)!.sideEffectBlocked = true;
          capture(() => this.captureConversationEvent(runId, event));
        },
        raw: (event) => capture(() => this.captureRawEvent(runId, event)),
        flush: flushCapture,
      });
      responseText = result.responseText;
    } catch (error) {
      executionErrors.push(error);
    }
    try { await flushCapture(); } catch (error) { executionErrors.push(error); }
    const interruption = this.activeRuns.get(runId)?.interruption;
    if (interruption) {
      const result = await interruption;
      if (result.status === "rejected") interruptionErrors.push(result.reason);
    }

    if (handle) {
      try {
        await handle.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const activeBeforeDelete = this.activeRuns.get(runId);
    if (activeBeforeDelete?.interruption && activeBeforeDelete.interruption !== interruption) {
      const result = await activeBeforeDelete.interruption;
      if (result.status === "rejected") interruptionErrors.push(result.reason);
    }
    if (cleanupErrors.length === 0) this.activeRuns.delete(runId);
    const failures = new Set([...executionErrors, ...interruptionErrors, ...cleanupErrors]);
    let strictFailure = cleanupErrors.length > 0 || interruptionErrors.length > 0;
    try {
      const latest = await this.withDatabase(() => this.deps.db.controlledExperiments.getRun(runId));
      if (!latest) throw new Error(`执行收口缺少受控实验 Run：runId=${runId}`);
      run = latest;
      const usage = await this.withDatabase(() => this.resolveCompleteUsage(run, snapshot));
      const sideEffectBlocked = activeBeforeDelete?.sideEffectBlocked
        ?? run.eventLog.some((item) => isToolStartedLog(item));
      if (cleanupErrors.length) {
        if (!usage) await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
        else await this.withDatabase(() => this.finishRun(run, "failed", null, usage, "ENGINE_SESSION_DISPOSE_FAILED"));
      } else if (interruptionErrors.length) {
        await this.withDatabase(() => this.finishRun(run, "failed", null, usage, "ENGINE_EXECUTION_FAILED"));
      } else if (sideEffectBlocked) {
        await this.withDatabase(() => this.finishFatal(run, "SIDE_EFFECT_BLOCKED", usage));
        strictFailure = executionErrors.length > 0;
      } else if (run.status === "cancel_requested") {
        strictFailure = executionErrors.some(error => extractTurnErrorMetadata(error).terminationKind !== "manual_interrupt");
        await this.withDatabase(() => this.finishRun(run, strictFailure ? "failed" : "cancelled", null, usage, strictFailure ? "ENGINE_EXECUTION_FAILED" : "RUN_CANCELLED"));
      } else if (executionErrors.length) {
        if (!usage) await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
        else if (executionErrors.some(error => error instanceof EngineTimeoutError) || this.now() >= run.deadlineAt) await this.withDatabase(() => this.finishRun(run, "timed_out", null, usage, "RUN_TIMEOUT"));
        else await this.withDatabase(() => this.finishRun(run, "failed", null, usage, "ENGINE_EXECUTION_FAILED"));
        await this.withDatabase(() => this.logFailure(this.combineFailures(failures), `experiment:${runId}`, run, "execution", snapshot.workspaceId));
      } else if (!usage || responseText == null) {
        await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
      } else {
        await this.withDatabase(() => this.finishRun(run, "succeeded", responseText, usage, null));
      }
    } catch (persistenceError) {
      failures.add(persistenceError);
      throw this.combineFailures(failures);
    }
    if (strictFailure) throw this.combineFailures(failures);
  }

  /** 集合记录捕获事实，保留 undefined/null/NaN 拒绝及每个不同根因。 */
  private combineFailures(failures: Set<unknown>): unknown {
    const errors = [...failures];
    return errors.length === 1 ? errors[0] : new AggregateError(errors, "受控实验执行、停止或收口失败");
  }

  /** 记录统一 conversation 事件，同时识别工具尝试和累计 Token。 */
  private captureConversationEvent(runId: string, event: ConversationEventInput): void {
    const active = this.activeRuns.get(runId);
    if (!active) throw new Error(`受控实验 active Run 不存在：runId=${runId}`);
    if (event.type === "item.tool.started") active.sideEffectBlocked = true;
    this.deps.db.controlledExperiments.appendEvent(runId, { kind: "conversation", event });
  }

  /** 记录原始引擎事件，并即时持久化 Codex provider turn 身份。 */
  private captureRawEvent(runId: string, event: RawEngineEventInput): void {
    const run = this.deps.db.controlledExperiments.getRun(runId);
    if (!run) throw new Error(`受控实验 Run 不存在：runId=${runId}`);
    const providerTurnId = extractProviderTurnId(event, run.clientTurnId);
    if (providerTurnId) this.deps.db.controlledExperiments.bindProviderIds(runId, { engineTurnId: providerTurnId });
    this.deps.db.controlledExperiments.appendEvent(runId, { kind: "raw", event });
  }

  /** 对账重启后不在内存中的 Run；恢复错误保留原 Run，仅消费 provider 明确终态或中断 ACK。 */
  private async reconcilePersistedRun(run: ControlledExperimentLocalRun, requestCancel = false, updateRequestId?: string): Promise<ControlledExperimentLocalRun> {
    if (isTerminal(run.status)) return run;
    if (run.status === "cancel_requested" && run.startedAt === null && !run.engineSessionId && !run.engineTurnId) {
      return await this.withDatabase(() => this.finishRun(run, "cancelled", null, null, "RUN_CANCELLED"));
    }
    const snapshot = await this.withDatabase(() => this.deps.db.controlledExperiments.getSnapshot(run.snapshotId));
    if (updateRequestId && (!snapshot || snapshot.engine !== "codex" || !run.engineSessionId || !run.engineTurnId)) throw new Error(`无法证明受控实验 provider 已停止：runId=${run.id}`);
    if (!snapshot) return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
    if (run.status === "dispatched") {
      await this.withDatabase(() => this.launchRun(run.id));
      return run;
    }
    if (snapshot.engine !== "codex" || !run.engineSessionId || !run.engineTurnId) {
      return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
    }
    const workspacePath = this.deps.sessions.getWorkspacePath(snapshot.workspaceId as WorkspaceId);
    if (updateRequestId && !workspacePath) throw new Error(`受控实验停止缺少工作区路径：runId=${run.id}`);
    if (!workspacePath) return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
    const sideEffectBlocked = run.eventLog.some((item) => isToolStartedLog(item));
    let reconcileEngineTurnId = run.engineTurnId;
    let interruptTerminal: CodexDanglingTurnReconcileResult | null = null;
    if (requestCancel || run.status === "cancel_requested" || sideEffectBlocked) {
      const interruptResult = await this.deps.sessions.interruptCodexTurnByEngineIds({
        threadId: deterministicId("omcsession", snapshot.workspaceId, run.id) as ThreadId,
        workspaceId: snapshot.workspaceId as WorkspaceId,
        workspacePath,
        turnId: run.clientTurnId as TurnId,
        engineSessionId: run.engineSessionId as SessionId,
        engineTurnId: run.engineTurnId,
        exactProviderTurn: true,
      });
      if (interruptResult.kind !== "ready" && interruptResult.kind !== "terminal") {
        if (updateRequestId) throw new Error(`受控实验 provider 中断未获确认：runId=${run.id}, code=${interruptResult.code}`, { cause: interruptResult });
        await this.withDatabase(() => this.writeLog("warn", "persisted run interrupt was not acknowledged; preserving run", {
          requestId: `experiment:${run.id}`,
          experimentId: run.experimentId,
          runId: run.id,
          sampleId: run.sampleId,
          workspaceId: snapshot.workspaceId,
          resultKind: interruptResult.kind,
          code: interruptResult.code,
          rootCause: redactClientStartupText(interruptResult.message),
        }));
        return run;
      }
      reconcileEngineTurnId = interruptResult.actualEngineTurnId;
      interruptTerminal = interruptResult.kind === "terminal" ? interruptResult.reconciled : null;
      if (reconcileEngineTurnId !== run.engineTurnId) {
        const previousEngineTurnId = run.engineTurnId;
        run = await this.withDatabase(() => this.deps.db.controlledExperiments.rebindProviderTurnId(run.id, {
          expectedEngineTurnId: previousEngineTurnId,
          actualEngineTurnId: reconcileEngineTurnId,
        }));
        reconcileEngineTurnId = run.engineTurnId!;
        await this.withDatabase(() => this.writeLog("info", "recovered persisted run provider turn mapping for terminal reconcile", {
          requestId: `experiment:${run.id}`, workspaceId: snapshot.workspaceId,
          experimentId: run.experimentId,
          runId: run.id,
          sampleId: run.sampleId,
          previousEngineTurnId,
          actualEngineTurnId: reconcileEngineTurnId,
        }));
      }
      if (interruptResult.kind === "ready") {
        const usage = await this.withDatabase(() => this.resolveCompleteUsage(run, snapshot));
        if (sideEffectBlocked) return await this.withDatabase(() => this.finishFatal(run, "SIDE_EFFECT_BLOCKED", usage));
        if (run.status === "cancel_requested") {
          return await this.withDatabase(() => this.finishRun(run, "cancelled", null, usage, "RUN_CANCELLED"));
        }
        return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING", usage));
      }
    }
    const outcome = interruptTerminal ?? await this.deps.sessions.reconcileCodexDanglingTurn({
      threadId: deterministicId("omcsession", snapshot.workspaceId, run.id) as ThreadId,
      workspaceId: snapshot.workspaceId as WorkspaceId,
      workspacePath,
      turnId: run.clientTurnId as TurnId,
      engineSessionId: run.engineSessionId as SessionId,
      engineTurnId: reconcileEngineTurnId,
      exactProviderTurn: true,
    });
    if (outcome.kind === "pending") {
      if (updateRequestId) throw new Error(`受控实验 provider 仍在运行：runId=${run.id}`);
      return run;
    }
    const providerTerminal = outcome.kind === "error"
      && (outcome as { providerTerminal?: unknown }).providerTerminal === true;
    if (outcome.kind === "error" && !providerTerminal) {
      if (updateRequestId) throw new Error(`受控实验 provider 终态未获确认：runId=${run.id}, code=${outcome.code}`, { cause: outcome });
      await this.withDatabase(() => this.writeLog("warn", "persisted run recovery error is not a provider terminal; preserving run", {
        requestId: `experiment:${run.id}`,
        experimentId: run.experimentId,
        runId: run.id,
        sampleId: run.sampleId,
        workspaceId: snapshot.workspaceId,
        code: outcome.code,
        rootCause: redactClientStartupText(outcome.message),
      }));
      return run;
    }
    const usage = await this.withDatabase(() => this.resolveCompleteUsage(run, snapshot));
    if (sideEffectBlocked) return await this.withDatabase(() => this.finishFatal(run, "SIDE_EFFECT_BLOCKED", usage));
    if (run.status === "cancel_requested") return await this.withDatabase(() => this.finishRun(run, "cancelled", null, usage, "RUN_CANCELLED"));
    if (!usage) return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
    if (outcome.kind !== "completed") return await this.withDatabase(() => this.finishRun(run, "failed", null, usage, outcome.code));
    if (outcome.responseText == null) return await this.withDatabase(() => this.finishFatal(run, "LOCAL_EVIDENCE_MISSING"));
    return await this.withDatabase(() => this.finishRun(run, "succeeded", outcome.responseText, usage, null));
  }

  /** 按 cumulative 事件口径聚合隔离 Run 的完整 Token 用量。 */
  private resolveCompleteUsage(
    run: ControlledExperimentLocalRun,
    snapshot: ControlledExperimentLocalSnapshot,
  ): ControlledExperimentRunUsage | null {
    let aggregate: {
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      cacheCreationInputTokens: number | null;
      totalTokens: number | null;
    } | null = null;
    for (const entry of run.eventLog) {
      const record = asRecord(entry);
      const event = asRecord(record.event);
      const payload = asRecord(event.payload);
      if (record.kind !== "conversation" || event.type !== "tokenUsage.updated" || payload.source !== "cumulative") continue;

      const usage = asRecord(payload.tokenUsage);
      const mode = payload.cumulativeMode === "delta" ? "delta" : "snapshot";
      const inputTokens = readNonNegativeInteger(usage.inputTokens);
      const outputTokens = readNonNegativeInteger(usage.outputTokens);
      const cachedInputTokens = usage.cachedInputTokens == null ? 0 : readNonNegativeInteger(usage.cachedInputTokens);
      const cacheCreationInputTokens = usage.cacheCreationInputTokens == null ? 0 : readNonNegativeInteger(usage.cacheCreationInputTokens);
      if ([inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens].some((value) => value == null)) return null;

      const explicitTotal = usage.totalTokens == null ? null : readNonNegativeInteger(usage.totalTokens);
      if (usage.totalTokens != null && explicitTotal == null) return null;
      if (!aggregate || mode === "snapshot") {
        aggregate = { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, totalTokens: explicitTotal };
        continue;
      }

      const nextInputTokens: number = aggregate.inputTokens! + inputTokens!;
      const nextOutputTokens: number = aggregate.outputTokens! + outputTokens!;
      const nextCachedInputTokens: number = aggregate.cachedInputTokens! + cachedInputTokens!;
      const nextCacheCreationInputTokens: number = aggregate.cacheCreationInputTokens! + cacheCreationInputTokens!;
      // 任一 delta 缺少显式 total 时，最终 total 必须按已聚合字段推导，不能用 0 补齐后再接受后续 partial total。
      const nextTotalTokens: number | null = aggregate.totalTokens == null || explicitTotal == null
        ? null
        : aggregate.totalTokens + explicitTotal;
      if (![nextInputTokens, nextOutputTokens, nextCachedInputTokens, nextCacheCreationInputTokens]
        .every((value) => Number.isSafeInteger(value))
        || (nextTotalTokens != null && !Number.isSafeInteger(nextTotalTokens))) return null;
      aggregate = {
        inputTokens: nextInputTokens,
        outputTokens: nextOutputTokens,
        cachedInputTokens: nextCachedInputTokens,
        cacheCreationInputTokens: nextCacheCreationInputTokens,
        totalTokens: nextTotalTokens,
      };
    }

    if (!aggregate) return null;
    const inputTokens = aggregate.inputTokens;
    const outputTokens = aggregate.outputTokens;
    const cachedInputTokens = aggregate.cachedInputTokens ?? 0;
    const cacheCreationInputTokens = aggregate.cacheCreationInputTokens ?? 0;
    if (inputTokens == null || outputTokens == null) return null;
    const totalTokens = aggregate.totalTokens ?? (snapshot.engine === "codex"
      ? inputTokens + outputTokens + cacheCreationInputTokens
      : inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens);
    if (!Number.isSafeInteger(totalTokens)) return null;
    return { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, totalTokens };
  }

  /** 校验 run.start 的冻结摘要，并返回唯一 Variant 快照。 */
  private requireMatchingSnapshot(request: ControlledExperimentRunStartRpcRequest): ControlledExperimentLocalSnapshot {
    if (request.variantKey !== "baseline" && request.variantKey !== "candidate") {
      throw new ControlledExperimentExecutorError(400, "LOCAL_EVIDENCE_MISSING", "variantKey 无效");
    }
    const snapshot = this.deps.db.controlledExperiments.getLatestSnapshot(
      requireText(request.experimentId, "experimentId"),
      requireText(request.sampleId, "sampleId"),
      request.variantKey,
    );
    if (!snapshot || snapshot.inputSha256 !== requireSha256(request.inputSha256, "inputSha256")
      || snapshot.configSha256 !== requireSha256(request.configSha256, "configSha256")) {
      throw new ControlledExperimentExecutorError(409, "LOCAL_EVIDENCE_MISSING", "冻结 Run 证据不存在或摘要不匹配");
    }
    this.assertSnapshotRuntimeEvidence(snapshot);
    return snapshot;
  }

  /** 校验状态请求的实验、Run 和 token 摘要三元绑定。 */
  private requireTokenBoundRun(request: ControlledExperimentRunStatusRpcRequest): ControlledExperimentLocalRun {
    const runId = requireText(request.runId, "runId");
    const run = this.deps.db.controlledExperiments.getRun(runId);
    if (!run || run.experimentId !== requireText(request.experimentId, "experimentId")) {
      throw new ControlledExperimentExecutorError(404, "LOCAL_EVIDENCE_MISSING", "本地 Run 证据不存在");
    }
    if (run.dispatchTokenSha256 !== requireSha256(request.dispatchTokenSha256, "dispatchTokenSha256")) {
      throw new ControlledExperimentExecutorError(409, "CONTROLLED_EXPERIMENT_CONFLICT", "dispatch token 摘要不匹配");
    }
    return run;
  }

  /** 将本地 Run 投影为公开 RPC；不可恢复错误使用显式失败合同。 */
  private toRpcResult(run: ControlledExperimentLocalRun): ControlledExperimentRunRpcResult {
    if (run.errorCode === "LOCAL_EVIDENCE_MISSING" || run.errorCode === "SIDE_EFFECT_BLOCKED"
      || run.errorCode === "FREEZE_EVIDENCE_INVALID") {
      return {
        ok: false,
        experimentId: run.experimentId,
        runId: run.id,
        code: run.errorCode,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        usageAccountingStatus: run.usageAccountingStatus,
      };
    }
    return {
      ok: true,
      experimentId: run.experimentId,
      runId: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      totalTokens: run.totalTokens,
      usageAccountingStatus: run.usageAccountingStatus,
      outputSha256: run.outputSha256,
      errorCode: run.errorCode,
    } satisfies ControlledExperimentRunRpcResponse;
  }

  /** 写入普通终态并计算输出摘要。 */
  private finishRun(
    run: ControlledExperimentLocalRun,
    status: "succeeded" | "failed" | "timed_out" | "cancelled",
    outputText: string | null,
    usage: ControlledExperimentRunUsage | null,
    errorCode: string | null,
  ): ControlledExperimentLocalRun {
    return this.deps.db.controlledExperiments.finishRun(run.id, {
      status,
      completedAt: this.now(),
      outputText,
      outputSha256: outputText == null ? null : sha256Text(outputText),
      usage,
      errorCode,
    });
  }

  /** 写入不可恢复失败，供 Server 立即终止实验而非重试或猜测用量。 */
  private finishFatal(
    run: ControlledExperimentLocalRun,
    code: ControlledExperimentRunRpcFailureResponse["code"],
    usage: ControlledExperimentRunUsage | null = null,
  ): ControlledExperimentLocalRun {
    return this.finishRun(run, "failed", null, usage, code);
  }

  /** 后台执行出现未覆盖异常时尽力持久化失败，并记录完整业务主键。 */
  private settleUnexpectedExecutionFailure(runId: string, error: unknown): void {
    let run: ControlledExperimentLocalRun | null;
    try {
      run = this.deps.db.controlledExperiments.getRun(runId);
    } catch (lookupError) {
      throw this.notifyFatalPersistenceFailure(runId, "查询异常 Run 失败", lookupError);
    }
    this.logFailure(error, `experiment:${runId}`, run, "execution");
    if (!run || isTerminal(run.status)) return;
    try {
      this.finishFatal(run, "LOCAL_EVIDENCE_MISSING");
    } catch (settlementError) {
      throw this.notifyFatalPersistenceFailure(runId, "异常执行无法持久化失败", settlementError);
    }
  }

  /** 实际创建隔离调用前复查统一更新准入，读取失败原样上抛。 */
  private assertTaskAdmission(runId: string): void {
    if (this.deps.isTaskAdmissionPaused?.()) {
      const error = new ControlledExperimentExecutorError(409, "DESKTOP_UPDATE_IN_PROGRESS", `更新期间暂停新实验：runId=${runId}`);
      this.logFailure(error, `experiment:${runId}`, this.deps.db.controlledExperiments.getRun(runId), "admission");
      throw error;
    }
  }

  /** 同一活跃调用只派发一次中断，严格等待者和执行收口共享其失败事实。 */
  private interruptActiveRun(run: ControlledExperimentLocalRun, active: ActiveRun): Promise<PromiseSettledResult<void>> {
    active.interruption ??= Promise.resolve().then(() => active.handle.session.interrupt(run.clientTurnId as TurnId))
      .then<PromiseSettledResult<void>, PromiseSettledResult<void>>(acknowledged => acknowledged === false
        ? { status: "rejected", reason: new Error(`受控实验中断未获确认：runId=${run.id}`) }
        : { status: "fulfilled", value: undefined }, reason => ({ status: "rejected", reason }));
    return active.interruption;
  }

  /** 失败边界保留脱敏后的聚合根因，关联本次停止或原 Run。 */
  private logFailure(error: unknown, requestId: string, run: ControlledExperimentLocalRun | null, operation: string, workspaceId: string | null = null): void {
    let remaining = 20;
    /** 有界展开标准错误树，避免嵌套 cause 丢失或无限循环。 */
    const describe = (cause: unknown, depth = 0): unknown => {
      remaining--;
      return {
        name: cause instanceof Error ? cause.name : typeof cause,
        message: redactClientStartupText(cause instanceof Error ? cause.message : typeof (cause as { message?: unknown } | null)?.message === "string" ? String((cause as { message: string }).message) : String(cause)).slice(0, 1000),
        ...(depth < 3 && remaining > 0 && cause instanceof AggregateError ? { errors: cause.errors.slice(0, 10).map(item => remaining > 0 ? describe(item, depth + 1) : { truncated: true }) } : {}),
        ...(depth < 3 && remaining > 0 && cause instanceof Error && cause.cause !== undefined ? { cause: describe(cause.cause, depth + 1) } : {}),
      };
    };
    const code = operation === "update_stop" ? "DESKTOP_UPDATE_EXPERIMENT_STOP_FAILED" : operation === "admission" ? "DESKTOP_UPDATE_IN_PROGRESS" : "CONTROLLED_EXPERIMENT_EXECUTION_FAILED";
    const data = { code, requestId, runId: run?.id ?? null, experimentId: run?.experimentId ?? null,
      workspaceId: workspaceId ?? this.deps.db.workspaceId, snapshotId: run?.snapshotId ?? null, operation, rootCause: describe(error) };
    try { this.writeLog("error", "controlled experiment operation failed", data); }
    catch (logError) { throw new AggregateError([error, logError], "受控实验错误日志持久化失败", { cause: error }); }
  }

  /** 已知作用域的执行日志直接进入原工作区日志入口，写入失败继续向上抛出。 */
  private writeLog(level: "info" | "warn" | "error", message: string, data: Record<string, unknown>): void {
    const workspaceId = this.deps.db.workspaceId ?? data.workspaceId;
    if (typeof workspaceId === "string" && workspaceId) {
      this.deps.db.writeWorkspaceLog(workspaceId as WorkspaceId, { level, tag: "controlled-experiment", message, data });
    } else logger[level]("controlled-experiment", message, data);
  }

  /** 通知进程级强一致故障处理器，并返回必须继续向上抛出的错误。 */
  private notifyFatalPersistenceFailure(runId: string, action: string, cause: unknown): Error {
    const fatal = new Error(`受控实验${action}：runId=${runId}`, { cause });
    if (!this.deps.onFatalError) throw fatal;
    this.deps.onFatalError(fatal);
    return fatal;
  }

  /** 从已提交快照重放原冻结响应，并拒绝同 revision 的不同请求。 */
  private restoreFreezeResponse(
    request: ControlledExperimentFreezeRpcRequest,
    snapshots: ControlledExperimentLocalSnapshot[],
  ): ControlledExperimentFreezeRpcResponse {
    if (snapshots.length !== request.items.length * 2) throw invalidFreeze("已冻结证据数量与重试请求不一致");
    const baselineConfig = normalizeVariantConfig(request.baselineCohort);
    const candidateConfig = normalizeVariantConfig(request.candidate);
    const requestByOrdinal = new Map(request.items.map((item) => [item.ordinal, item]));
    const freezeDigest = snapshots[0]!.freezeDigest;
    if (snapshots.some((snapshot) => snapshot.freezeDigest !== freezeDigest
      || snapshot.perRunTimeoutMs !== request.budget.perRunTimeoutMs)) {
      throw invalidFreeze("已冻结批次证据损坏或预算不匹配");
    }
    for (const snapshot of snapshots) {
      const item = requestByOrdinal.get(snapshot.ordinal);
      const expectedConfig = snapshot.variantKey === "baseline" ? baselineConfig : candidateConfig;
      if (!item || snapshot.evaluationItemId !== item.evaluationItemId
        || snapshot.sourceInstanceId !== item.sourceInstanceId
        || snapshot.nodeId !== item.nodeId
        || snapshot.promptSnapshotId !== item.promptSnapshotId
        || snapshot.inputSha256 !== requireSha256(item.expectedPromptSha256, "expectedPromptSha256")
        || snapshot.engine !== expectedConfig.engine || snapshot.model !== expectedConfig.model
        || snapshot.effort !== expectedConfig.effort
        || snapshot.promptDefinitionSha256 !== requireSha256(request.baselineCohort.promptDefinitionHash, "promptDefinitionHash")) {
        throw invalidFreeze("同一冻结 revision 已绑定不同请求");
      }
    }
    const variants = (["baseline", "candidate"] as const).map((variantKey) => {
      const first = snapshots.find((snapshot) => snapshot.variantKey === variantKey);
      if (!first) throw invalidFreeze(`已冻结 Variant 缺失：${variantKey}`);
      if (snapshots.some((snapshot) => snapshot.variantKey === variantKey
        && (snapshot.configSha256 !== first.configSha256
          || snapshot.promptDefinitionSha256 !== first.promptDefinitionSha256))) {
        throw invalidFreeze(`已冻结 Variant 证据不一致：${variantKey}`);
      }
      return { variantKey, engine: first.engine, model: first.model, effort: first.effort,
        configSha256: first.configSha256, promptDefinitionSha256: first.promptDefinitionSha256 };
    });
    const samples = request.items.slice().sort((left, right) => left.ordinal - right.ordinal).map((item) => {
      const baseline = snapshots.find((snapshot) => snapshot.ordinal === item.ordinal && snapshot.variantKey === "baseline");
      if (!baseline) throw invalidFreeze(`已冻结样本缺失：ordinal=${item.ordinal}`);
      return { id: baseline.sampleId, evaluationItemId: baseline.evaluationItemId,
        promptSnapshotId: baseline.promptSnapshotId, inputSha256: baseline.inputSha256,
        ordinal: baseline.ordinal, localSnapshotId: baseline.id };
    });
    return { ok: true, experimentId: request.experimentId, freezeRevision: request.freezeRevision,
      freezeDigest, variants, samples };
  }

  /** 校验共享合同版本，未知版本拒绝执行。 */
  private assertContract(version: unknown): void {
    if (version !== CONTROLLED_EXPERIMENT_CONTRACT_VERSION) {
      throw new ControlledExperimentExecutorError(409, "CONTROLLED_EXPERIMENT_CONFLICT", "受控实验合同版本不匹配");
    }
  }

  /** 返回注入时钟，测试和生产共用同一时间入口。 */
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 冻结 candidate 当前唯一的 Provider 与可执行中转凭据。 */
  private requireCandidateProvider(config: ControlledExperimentVariantConfig): EngineModelProviderId {
    const providerId = this.resolveVariantProvider(config);
    if (!providerId || !this.deps.db.engineKeys.getActive(config.engine, providerId)) {
      throw invalidFreeze("candidate 未配置可用的 CodeFlow 中转凭据");
    }
    return providerId;
  }

  /** 校验 baseline 的历史中转身份和当前可执行凭据。 */
  private requireBaselineProvider(
    envelope: ControlledExperimentLocalSnapshot["promptEnvelope"],
    config: ControlledExperimentVariantConfig,
    promptSnapshotId: string,
  ): EngineModelProviderId {
    const billing = envelope.meta.billingContext;
    if (!billing || billing.credentialSource !== "codeflow_key") {
      throw invalidFreeze(`baseline 不是 CodeFlow 中转调用：${promptSnapshotId}`);
    }
    const providerId = normalizeEngineKeyProviderId(config.engine, billing.providerId) as EngineModelProviderId | null;
    if (!providerId || !this.deps.db.engineKeys.getActive(config.engine, providerId)) {
      throw invalidFreeze(`baseline 当前缺少可执行的中转凭据：${promptSnapshotId}`);
    }
    const currentProviderId = this.resolveVariantProvider(config);
    if (currentProviderId !== providerId) throw invalidFreeze(`baseline 当前 Provider 归属已漂移：${promptSnapshotId}`);
    return providerId;
  }

  /** Resolves the same current provider identity used by the engine model catalog. */
  private resolveVariantProvider(config: ControlledExperimentVariantConfig): EngineModelProviderId | null {
    return normalizeEngineKeyProviderId(
      config.engine,
      resolveRuntimeEngineModelProviderId(config.engine, config.model),
    );
  }

  /** Rejects model calls when the current Provider or credential differs from frozen evidence. */
  private assertSnapshotRuntimeEvidence(snapshot: ControlledExperimentLocalSnapshot): void {
    const activeCatalog = requireActiveCatalog();
    if (snapshot.catalogVersion !== activeCatalog.configVersion) {
      throw new Error(
        `冻结模型目录版本已过期：frozen=${snapshot.catalogVersion}, active=${activeCatalog.configVersion}`,
      );
    }
    assertClientReasoningEffortSupported(this.deps.db, snapshot.engine, snapshot.model, snapshot.effort);
    const config = { engine: snapshot.engine, model: snapshot.model, effort: snapshot.effort };
    const providerId = this.resolveVariantProvider(config);
    if (!providerId || !this.deps.db.engineKeys.getActive(snapshot.engine, providerId)) {
      throw new Error("冻结 Provider 或 CodeFlow Key 已失效");
    }
    if (buildVariantConfigSha(config, providerId) !== snapshot.configSha256) {
      throw new Error("冻结 Provider 归属已漂移");
    }
  }
}

/** 拒绝需要在回放期间重新读取工作区的 Prompt 证据。 */
function assertNoRuntimeDependencies(
  envelope: ControlledExperimentLocalSnapshot["promptEnvelope"],
  artifactInput: ControlledExperimentLocalSnapshot["artifactInput"],
  promptSnapshotId: string,
): void {
  if (envelope.knowledge.catalogs.some((catalog) => catalog.runtimeSources.length > 0)) {
    throw invalidFreeze(`Prompt Snapshot 含运行时知识路径：${promptSnapshotId}`);
  }
  const hasWorkspaceArtifact = artifactInput.artifacts.some((artifact) =>
    (artifact.workspaceFiles?.length ?? 0) > 0
    || (artifact.workspaceFileRefs?.length ?? 0) > 0
    || (artifact.workspaceAttachmentRefs?.length ?? 0) > 0
  );
  if (hasWorkspaceArtifact) throw invalidFreeze(`Prompt Snapshot 含工作区文件型 Artifact：${promptSnapshotId}`);
}

/** 从显式归属当前 Run 的 started 事件提取 provider turn ID；generic ACK 不参与绑定。 */
function extractProviderTurnId(event: RawEngineEventInput, expectedClientTurnId: string): string | null {
  if (event.engine !== "codex" || event.source !== "codex.app-server.msg") return null;
  if (String(event.clientTurnId ?? "") !== expectedClientTurnId) return null;
  const data = asRecord(event.data);
  const params = asRecord(data.params);
  if (data.method === "turn/started") {
    const turn = asRecord(params.turn);
    return normalizeOptionalText(turn.id ?? params.turnId);
  }
  if (data.method !== "item/started" && data.method !== "item/completed") return null;
  const item = asRecord(params.item);
  if (item.type !== "userMessage") return null;
  return normalizeOptionalText(params.turnId ?? params.turn_id);
}

/** 判断事件日志项是否记录过任意工具启动。 */
function isToolStartedLog(value: unknown): boolean {
  const record = asRecord(value);
  const event = asRecord(record.event);
  return record.kind === "conversation" && event.type === "item.tool.started";
}

/** 规范化 Variant 配置并拒绝未知引擎或空模型。 */
function normalizeVariantConfig(value: ControlledExperimentVariantConfig): ControlledExperimentVariantConfig {
  if (value.engine !== "claude" && value.engine !== "codex") throw invalidFreeze("Variant 引擎无效");
  const model = requireText(value.model, "model");
  const effort = normalizeOptionalText(value.effort);
  return { engine: value.engine, model, effort };
}

/** 构造零调用时可证明的完整零用量。 */
function zeroUsage(): ControlledExperimentRunUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0,
    totalTokens: 0 };
}

/** 判断本地 Run 是否已经进入不可覆盖终态。 */
function isTerminal(status: ControlledExperimentLocalRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out" || status === "cancelled";
}

/** 构造稳定的本地实验 ID。 */
function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Text(parts.join("\u0000")).slice(0, 32)}`;
}

/** 计算 JSON 证据摘要，保持与现有度量的序列化口径一致。 */
function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

/** 计算 UTF-8 文本 SHA-256。 */
function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Binds the visible Variant configuration to the resolved Provider identity. */
function buildVariantConfigSha(config: ControlledExperimentVariantConfig, providerId: EngineModelProviderId): string {
  return sha256Json({ ...config, providerId });
}

/** 校验并返回 SHA-256 小写文本。 */
function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new ControlledExperimentExecutorError(400, "FREEZE_EVIDENCE_INVALID", `${label} 不是 SHA-256`);
  return text;
}

/** 校验 1/2 两次 Attempt 范围。 */
function requireAttemptNo(value: unknown): number {
  const attemptNo = Number(value);
  if (attemptNo !== 1 && attemptNo !== 2) throw new ControlledExperimentExecutorError(400, "LOCAL_EVIDENCE_MISSING", "attemptNo 无效");
  return attemptNo;
}

/** 校验正安全整数。 */
function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ControlledExperimentExecutorError(400, "LOCAL_EVIDENCE_MISSING", `${label} 无效`);
  return parsed;
}

/** 读取非负安全整数；缺失或非法时返回 null。 */
function readNonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** 要求非空文本。 */
function requireText(value: unknown, label: string): string {
  const text = normalizeText(value);
  if (!text) throw new ControlledExperimentExecutorError(400, "FREEZE_EVIDENCE_INVALID", `${label} 不能为空`);
  return text;
}

/** 归一化普通文本。 */
function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

/** 归一化可空文本。 */
function normalizeOptionalText(value: unknown): string | null {
  return normalizeText(value) || null;
}

/** 将未知值收窄为普通记录。 */
function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** 构造冻结证据无效错误。 */
function invalidFreeze(message: string): ControlledExperimentExecutorError {
  return new ControlledExperimentExecutorError(409, "FREEZE_EVIDENCE_INVALID", message);
}

function requireActiveCatalog() {
  const catalog = getActiveEngineModelCatalogSnapshot();
  if (!catalog) throw invalidFreeze("动态模型目录尚未同步完成，暂不能冻结或执行实验");
  return catalog;
}
