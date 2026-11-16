import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ApiErrorCode,
  ConversationEventInput,
  RawEngineEventInput,
  AssetDraft,
  AssetDraftId,
  AssetGenerationJob,
  AssetGenerationFailure,
  AssetGenerationInteractionRequest,
  AssetGenerationJobId,
  AssetGenerationJobStatus,
  AssetGenerationProgress,
  AssetJobContextCollectedPayload,
  AssetJobEngineInvokedPayload,
  AssetJobEventPayload,
  AssetJobEventRecord,
  AssetJobEventType,
  AssetJobEventView,
  AssetJobFailedPayload,
  AssetJobStatusChangedPayload,
  AssetJobValidationCompletedPayload,
  AssetValidationIssue,
  ExecutableToolRegistry,
  GateCriterion,
  KnowledgeBundleDefinition,
  KnowledgeBundleId,
  OrchAssetDraftApplyRequestBody,
  OrchAssetDraftApplyResponseBody,
  OrchAssetDraftContextOptions,
  OrchAssetDraftGenerateRequestBody,
  OrchAssetDraftGenerateResponseBody,
  OrchAssetDraftGetRequestBody,
  OrchAssetDraftGetResponseBody,
  OrchAssetDraftJobGetRequestBody,
  OrchAssetDraftJobGetResponseBody,
  OrchAssetDraftJobListItem,
  OrchAssetDraftJobSummary,
  OrchAssetDraftJobResumeRequestBody,
  OrchAssetDraftJobResumeResponseBody,
  OrchAssetDraftJobsListRequestBody,
  OrchAssetDraftJobsListResponseBody,
  OrchAssetDraftRejectRequestBody,
  OrchAssetDraftRejectResponseBody,
  RoleDefinition,
  RoleDraftComparison,
  RoleDraftDiffItem,
  RoleDraftDiffSection,
  RoleDraftPayload,
  RoleExecutionConfig,
  RoleFieldDefinition,
  RoleId,
  SkillDefinition,
  SkillDraftComparison,
  SkillDraftDiffSection,
  SkillDraftPayload,
  SkillId,
  SkillPackageFile,
  SkillPackageFileKind,
  SkillScriptEntrypoint,
  SkillTargetEngine,
  ThreadId,
  ToolDefinition,
  ToolRef,
  ToolsetDefinition,
  ToolsetId,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";
import { extractTurnErrorMetadata } from "@codeflowai/shared";
import { createTurnErrorEventInput } from "../errors/turnErrors.js";
import {
  createDefaultRoleExecutionConfig,
  isRoleExecutionEngineEnabled,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  normalizeRoleExecutionConfig,
  normalizeRoleFieldDefinitions,
  normalizeRoleInputDefinition,
  normalizeRoleOutputDefinition,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { assertClientReasoningEffortSupported } from "../engines/engineModelCapabilities.js";
import { resolveRuntimeRoleExecutionConfigForEngine } from "../engines/engineModelCatalogRuntime.js";
import { readExistingCodeflowaiConfig } from "../codeflowai/codeflowaiConfig.js";
import type { ThreadSessionManager } from "../engines/threadSessionManager.js";
import type { TurnTimeoutPolicy } from "../engines/threadSession.js";
import { emitTurnTerminalWithAssistantReconcile } from "../engines/turnTerminalEmitter.js";
import { readEngineConfig } from "../enginesConfig.js";
import { decodeTextBuffer } from "../fs/textEncoding.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import type { ThreadStore } from "../threads/threadStore.js";

type AssetDraftServiceDeps = {
  db: ClientDb;
  workspaces: Map<WorkspaceId, string>;
  threads: ThreadStore;
  sessions: ThreadSessionManager;
  timeoutPolicy: TurnTimeoutPolicy;
  emitConversation: (event: ConversationEventInput) => void;
  emitRaw: (event: RawEngineEventInput) => void;
  /** 仅读取桌面生命周期的统一暂停事实，不另持业务暂停状态。 */
  isTaskAdmissionPaused?: () => boolean;
  /** 任务状态、工具提交和诊断只持有短同步许可，provider等待在许可外。 */
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  /** 受理和终态必须等待正文及业务索引完成。 */
  flushLocalEvents?: (workspaceId: WorkspaceId, threadId?: ThreadId) => Promise<void>;
};

type RoleReferenceContext = {
  roles: RoleDefinition[];
  knowledgeBundles: KnowledgeBundleDefinition[];
  toolsets: ToolsetDefinition[];
  skills: SkillDefinition[];
  knowledgeBundleById: Map<KnowledgeBundleId, KnowledgeBundleDefinition>;
  toolsetById: Map<ToolsetId, ToolsetDefinition>;
};

type SkillReferenceContext = {
  skills: SkillDefinition[];
  skillById: Map<SkillId, SkillDefinition>;
};

type ValidationResult = {
  issues: AssetValidationIssue[];
  blockingIssueCount: number;
  warningCount: number;
  hasBlockingError: boolean;
};

type CollectedContext = {
  prompt: string;
  selectedPaths: string[];
  selectedPathCount: number;
  includedFileCount: number;
  totalChars: number;
  truncated: boolean;
};

type DraftPromptMessages = {
  systemMessage: string;
  developerMessage: string;
  userMessage: string;
};

type StoredRoleDraftJobRequest = OrchAssetDraftGenerateRequestBody & {
  prompt: string;
  clientRequestId?: string | null;
  baseVersionId?: string | null;
  contextOptions: {
    includeExistingAssets: boolean;
    includeWorkbenchDocs: boolean;
    includeWorkspaceFiles: boolean;
    maxContextChars: number;
    selectedPaths: string[];
  };
};

type StoredSkillDraftJobRequest = OrchAssetDraftGenerateRequestBody & {
  assetKind: "skill";
  prompt: string;
  targetAssetId?: SkillId | null;
  skillSnapshot?: Omit<SkillDefinition, "createdAt" | "updatedAt"> | null;
  workingDraft?: SkillDraftPayload["draft"] | null;
  clientRequestId?: string | null;
  baseVersionId?: string | null;
  contextOptions: StoredRoleDraftJobRequest["contextOptions"];
};

type RoleDraftRunOptions = {
  reuseThreadId?: ThreadId | null;
};

type RoleDraftEngineInvocation =
  | {
      kind: "submitted";
      engine: "claude" | "codex";
      model?: string | null;
      effort?: string | null;
      threadId: ThreadId;
      responseText: string;
      draftId: AssetDraftId;
    }
  | {
      kind: "awaiting_input";
      engine: "claude" | "codex";
      model?: string | null;
      effort?: string | null;
      threadId: ThreadId;
      interaction: AssetGenerationInteractionRequest;
    }
  | {
      kind: "no_submission";
      engine: "claude" | "codex";
      model?: string | null;
      effort?: string | null;
      threadId: ThreadId;
      responseText: string;
    };

const ROLE_DRAFT_SCHEMA_VERSION = "role-draft/v2";
const SKILL_DRAFT_SCHEMA_VERSION = "skill-draft/v1";
const ROLE_DRAFT_TOOLSET_ID = "__runtime_asset_draft__";
const ROLE_DRAFT_SUBMIT_TOOL_ID = "runtime.submitRoleDraft";
const SKILL_DRAFT_SUBMIT_TOOL_ID = "runtime.submitSkillDraftPatch";
const MAX_EVENT_FETCH = 20;
const DEFAULT_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_SELECTED_FILE_BYTES = 64 * 1024;
const MAX_WORKBENCH_DOCS = 6;
const ROLE_DRAFT_MAX_ATTEMPTS = 3;
const EXECUTING_JOB_STATUSES: readonly AssetGenerationJobStatus[] = [
  "queued",
  "planning",
  "collecting_context",
  "generating",
  "validating",
];
const UPDATE_STOP_JOB_STATUSES: AssetGenerationJobStatus[] = [...EXECUTING_JOB_STATUSES, "awaiting_input", "awaiting_review"];
type AssetDraftExecutionOwner = {
  job: AssetGenerationJob;
  stopping: boolean;
  execution: Promise<PromiseSettledResult<void>>;
  stop?: Promise<PromiseSettledResult<void>>;
  diagnosticFailure?: { value: unknown };
};
const assetDraftExecutions = new WeakMap<ClientDb, Map<AssetGenerationJobId, AssetDraftExecutionOwner>>();

/** 临时 API 服务实例共用同一数据库的后台资源 owner，不创建新的任务状态。 */
function assetDraftOwners(db: ClientDb): Map<AssetGenerationJobId, AssetDraftExecutionOwner> {
  let owners = assetDraftExecutions.get(db);
  if (!owners) { owners = new Map(); assetDraftExecutions.set(db, owners); }
  return owners;
}

/** 更新活动读取真实后台 owner；失败 owner 仍需明确处理，不能被当成空闲。 */
export function hasInFlightAssetDraftWork(db: ClientDb): boolean { return (assetDraftExecutions.get(db)?.size ?? 0) > 0; }

/** 仅取自有 data descriptor，不执行外来 getter 或 toString。 */
function assetFailureField(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** 保留原拒绝对象、顺序和 cause；诊断副错不再转成业务失败。 */
function assetDiagnosticFailure(error: unknown, diagnostic: unknown, code: "ASSET_DRAFT_EXECUTION_LOG_FAILED" | "ASSET_DRAFT_STOP_LOG_FAILED"): AggregateError {
  return Object.assign(new AggregateError([error, diagnostic], code, { cause: error }), { code });
}

/** 固定可信 W 同步记录有界根因；描述、脱敏和落盘任一步失败均显式保因。 */
function logAssetUpdateFailure(db: ClientDb, error: unknown, requestId: string, job: AssetGenerationJob, event = "stop_failed", terminalStatus?: string): void {
  try {
    let remaining = 20;
    /** 深度、总节点和聚合项都有界，循环也只按有限 data descriptor 展开。 */
    const describe = (cause: unknown, depth = 0): unknown => {
      remaining--;
      const name = assetFailureField(cause, "name"), message = assetFailureField(cause, "message"), nested = assetFailureField(cause, "cause"), errors = assetFailureField(cause, "errors");
      const primitive = cause === null || (typeof cause !== "object" && typeof cause !== "function");
      const result: Record<string, unknown> = { name: typeof name === "string" ? redactClientStartupText(name).slice(0, 1000) : cause instanceof Error ? "Error" : typeof cause,
        message: redactClientStartupText(typeof message === "string" ? message : primitive ? String(cause) : "[non-data error]").slice(0, 1000) };
      if (depth < 3 && remaining > 0 && Array.isArray(errors)) {
        const length = assetFailureField(errors, "length"), items: unknown[] = [];
        if (typeof length === "number") for (let index = 0; index < Math.min(10, length) && remaining > 0; index++) items.push(describe(assetFailureField(errors, String(index)), depth + 1));
        result.errors = items;
      }
      if (depth < 3 && remaining > 0 && nested !== undefined) result.cause = describe(nested, depth + 1);
      return result;
    };
    const errorCode = assetFailureField(error, "code");
    db.writeWorkspaceLog(job.workspaceId, { level: terminalStatus === undefined ? "error" : "info", tag: "orch-asset-draft", message: terminalStatus === undefined ? "asset draft execution or update stop failed" : "asset draft callback skipped after terminal transition", data: {
      code: event.startsWith("stop_") ? "DESKTOP_UPDATE_ASSET_STOP_FAILED" : "ASSET_DRAFT_EXECUTION_FAILED", errorCode: typeof errorCode === "string" ? redactClientStartupText(errorCode).slice(0, 1000) : "INTERNAL_ERROR",
      event: { category: "orch-asset-draft", action: event, outcome: terminalStatus === undefined ? "fail" : "info" }, requestId, workspaceId: job.workspaceId, jobId: job.id, threadId: job.threadId, assetKind: job.assetKind, ...(terminalStatus === undefined ? {} : { terminalStatus }), rootCause: describe(error),
    } });
  } catch (diagnostic) { throw assetDiagnosticFailure(error, diagnostic, event.startsWith("stop_") ? "ASSET_DRAFT_STOP_LOG_FAILED" : "ASSET_DRAFT_EXECUTION_LOG_FAILED"); }
}

/** 已确认更新后经可信 turn 中断入口停止任务；成功必须包括后台、终态和会话释放。 */
export async function stopAssetDraftJobsForUpdate(db: ClientDb, input: {
  requestId: string;
  timeoutMs?: number;
  interruptTurn: (target: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId }) => Promise<void>;
  disposeThread?: (threadId: ThreadId) => Promise<void>;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  /** 更新停止读取和结算分别准入，中断与等待原执行始终在许可外。 */
  const database = async <T>(operation: () => T): Promise<T> => input.withLegacyDatabase
    ? input.withLegacyDatabase(input.requestId, operation) : operation();
  if (!input.requestId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("DESKTOP_UPDATE_ASSET_STOP_INPUT_INVALID");
  const owners = assetDraftOwners(db);
  const jobs = new Map<AssetGenerationJobId, AssetGenerationJob>();
  // 先观察已有停止结果，失败任务落盘后也不能让重试先处理其他任务。
  for (const [jobId, owner] of owners) jobs.set(jobId, owner.job);
  // 已有诊断失败时只消费原owner，不能让新的数据库读取覆盖已保存根因。
  if (![...owners.values()].some(owner => owner.diagnosticFailure)) {
    const pendingJobs = input.withLegacyDatabase
      ? await database(() => db.orchAssetGenerationJobs.listByStatuses(UPDATE_STOP_JOB_STATUSES))
      : db.orchAssetGenerationJobs.listByStatuses(UPDATE_STOP_JOB_STATUSES);
    for (const job of pendingJobs) if (!jobs.has(job.id)) jobs.set(job.id, job);
  }
  const deadline = Date.now() + timeoutMs;
  for (const job of jobs.values()) {
    const owner = owners.get(job.id) ?? { job, stopping: true, execution: Promise.resolve<PromiseSettledResult<void>>({ status: "fulfilled", value: undefined }) };
    if (!owners.has(job.id)) owners.set(job.id, owner);
    owner.stopping = true;
    if (!owner.stop) owner.stop = (async (): Promise<PromiseSettledResult<void>> => {
      let observedDiagnostic: { value: unknown } | undefined;
      /** 每个等待返回后重读原 owner，执行或超时诊断失败均禁止下一步副作用。 */
      const assertDiagnostic = (): void => { if (owner.diagnosticFailure) { observedDiagnostic = owner.diagnosticFailure; throw observedDiagnostic.value; } };
      try {
        const currentJob = await database(() => db.orchAssetGenerationJobs.get(job.id));
        if (!currentJob) throw new Error(`更新停止缺少资产任务：jobId=${job.id}`);
        assertDiagnostic();
        const threadId = currentJob.threadId;
        if (threadId) {
          const thread = await database(() => db.threads.get(threadId));
          if (!thread || thread.workspaceId !== job.workspaceId) throw new Error(`资产任务执行线程归属无效：jobId=${job.id}, threadId=${threadId}`);
          const turns = await database(() => db.turns.listByThread(threadId).filter(turn => turn.status === "started"));
          for (const turn of turns) { assertDiagnostic(); await input.interruptTurn({ workspaceId: job.workspaceId, threadId, turnId: turn.turnId }); assertDiagnostic(); }
          if (await database(() => db.turns.listByThread(threadId).some(turn => turn.status === "started"))) throw Object.assign(new Error("资产执行 turn 尚未停止"), { code: "DESKTOP_UPDATE_ASSET_TURN_STILL_RUNNING" });
        }
        const execution = await owner.execution;
        assertDiagnostic();
        if (execution.status === "rejected") throw execution.reason;
        if (threadId) {
          if (!input.disposeThread) throw new Error("DESKTOP_UPDATE_ASSET_DISPOSE_UNAVAILABLE");
          await input.disposeThread(threadId);
          assertDiagnostic();
        }
        assertDiagnostic();
        const progress = makeProgress("cancelled", "生成任务已取消", "桌面更新已停止本轮生成，原任务与草案保留", 100);
        await database(() => db.db.transaction(() => {
          const transition = db.orchAssetGenerationJobs.patchIfStatus(job.id, UPDATE_STOP_JOB_STATUSES, { status: "cancelled", progress, failure: null, interactionRequest: null });
          if (transition) db.orchAssetJobEvents.append({ jobId: job.id, type: "orch.assetDraft.statusChanged", payloadJson: JSON.stringify({ from: transition.previous.status, to: "cancelled", headline: progress.headline, detail: progress.detail, percent: 100 }) });
          else if (db.orchAssetGenerationJobs.get(job.id)?.status !== "cancelled") throw new Error(`资产更新取消状态竞争失败：jobId=${job.id}`);
        })());
        assertDiagnostic();
        if (owners.get(job.id) === owner) owners.delete(job.id);
        return { status: "fulfilled", value: undefined };
      } catch (reason) {
        // 中断失败也须收齐已启动的后台结果，不能提前固化而丢失后续根因。
        const failures = new Set<unknown>();
        if (!observedDiagnostic || reason !== observedDiagnostic.value) failures.add(reason);
        const execution = await owner.execution;
        if (execution.status === "rejected") failures.add(execution.reason);
        if (owner.diagnosticFailure) failures.add(owner.diagnosticFailure.value);
        const causes = [...failures];
        let failure = causes.length === 1 ? causes[0] : new AggregateError(causes, "资产更新停止与后台执行失败", { cause: causes[0] });
        // 已失败的诊断不递归重记；独立停止故障才在所属边界增加上下文。
        if (!owner.diagnosticFailure) {
          let executionLogFailed: boolean;
          try { executionLogFailed = execution.status === "rejected" && assetFailureField(execution.reason, "code") === "ASSET_DRAFT_EXECUTION_LOG_FAILED"; }
          catch (diagnostic) { return { status: "rejected", reason: assetDiagnosticFailure(failure, diagnostic, "ASSET_DRAFT_STOP_LOG_FAILED") }; }
          if (!executionLogFailed) {
            try { await database(() => logAssetUpdateFailure(db, failure, input.requestId, owner.job)); }
            catch (diagnostic) { failure = diagnostic; }
          }
        }
        return { status: "rejected", reason: failure };
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([owner.stop, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        const error = Object.assign(new Error("等待资产生成停止超时"), { code: "DESKTOP_UPDATE_ASSET_STOP_TIMEOUT" });
        void database(() => logAssetUpdateFailure(db, error, input.requestId, owner.job, "stop_timeout")).then(() => reject(error), diagnostic => {
          const previous = owner.diagnosticFailure;
          owner.diagnosticFailure = { value: previous ? new AggregateError([previous.value, diagnostic], "资产停止超时诊断失败", { cause: previous.value }) : diagnostic };
          reject(diagnostic);
        });
      }, Math.max(1, deadline - Date.now())); })]);
      if (result.status === "rejected") throw result.reason;
    } finally { if (timer) clearTimeout(timer); }
  }
}

class AssetDraftRunObsoleteError extends Error {
  constructor(public readonly jobId: AssetGenerationJobId) {
    super(`资产草案任务已不再执行：${jobId}`);
    this.name = "AssetDraftRunObsoleteError";
  }
}

export class AssetDraftServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AssetDraftServiceError";
  }
}

/** 角色 AI 草案服务。 */
export class AssetDraftService {
  constructor(private readonly deps: AssetDraftServiceDeps) {}

  /** 沿唯一Writer协调旧仓储短段，不把引擎、文件异步读取或中断等待包入许可。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.deps.withLegacyDatabase ? this.deps.withLegacyDatabase("asset-draft", operation) : operation();
  }

  /** 新建或续跑受理前读取唯一更新围栏，暂停时不写入任务。 */
  private assertTaskAdmission(): void {
    if (this.deps.isTaskAdmissionPaused?.()) throw Object.assign(new Error("桌面正在准备更新，暂时不能启动资产生成"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
  }

  /** 停止已被接受的后台任务时拒绝迟到状态/草案写入及下一轮模型调用。 */
  private assertRunAccepting(jobId: AssetGenerationJobId): void {
    if (assetDraftOwners(this.deps.db).get(jobId)?.stopping) throw new AssetDraftRunObsoleteError(jobId);
  }

  /** 已受理轮次等待更新选择；稍后恢复，确认停止沿原 owner 退出。 */
  private async waitForRunAdmission(jobId: AssetGenerationJobId): Promise<void> {
    for (;;) {
      const owner = assetDraftOwners(this.deps.db).get(jobId);
      if (!owner) throw Object.assign(new Error(`资产任务执行 owner 已释放：jobId=${jobId}`), { code: "DESKTOP_UPDATE_ASSET_OWNER_MISSING" });
      if (owner.stopping) throw new AssetDraftRunObsoleteError(jobId);
      if (!this.deps.isTaskAdmissionPaused?.()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /** 四个创建/续跑入口共用实际后台 Promise，异步失败沿原任务边界落盘。 */
  private launchDraftRun(job: AssetGenerationJob, label: "角色" | "Skill", run: () => Promise<void>): void {
    const owners = assetDraftOwners(this.deps.db);
    if (owners.has(job.id)) throw serviceError(409, "CONFLICT", "资产任务上一轮执行尚未释放");
    const owner: AssetDraftExecutionOwner = { job, stopping: false, execution: undefined! };
    owners.set(job.id, owner);
    /** 执行诊断失败同步进入原门禁，保留早先 timer 原因和 execution 的原拒绝值。 */
    const rejectDiagnostic = (reason: unknown): PromiseRejectedResult => {
      const previous = owner.diagnosticFailure;
      owner.stopping = true;
      owner.diagnosticFailure = { value: previous ? new AggregateError([previous.value, reason], "资产执行诊断失败", { cause: previous.value }) : reason };
      return { status: "rejected", reason };
    };
    owner.execution = Promise.resolve().then(async (): Promise<PromiseSettledResult<void>> => {
      try { this.assertRunAccepting(job.id); await run(); return { status: "fulfilled", value: undefined }; }
      catch (reason) {
        try {
          if (owner.diagnosticFailure) return reason instanceof AssetDraftRunObsoleteError ? { status: "fulfilled", value: undefined } : { status: "rejected", reason };
          if (owner.stopping && (reason instanceof AssetDraftRunObsoleteError || extractTurnErrorMetadata(reason).terminationKind === "manual_interrupt")) return { status: "fulfilled", value: undefined };
          if (reason instanceof AggregateError || assetFailureField(reason, "code") === "DESKTOP_UPDATE_ASSET_INTERRUPT_FAILED") owner.stopping = true;
          await this.withDatabase(() => this.settleRunFailure(owner.job, reason, label));
        } catch (persistError) {
          owner.stopping = true;
          const failure = new AggregateError([reason, persistError], "资产任务失败状态未保存", { cause: reason });
          try { if (assetFailureField(persistError, "code") === "ASSET_DRAFT_EXECUTION_LOG_FAILED") return rejectDiagnostic(persistError); }
          catch (diagnostic) { return rejectDiagnostic(assetDiagnosticFailure(failure, diagnostic, "ASSET_DRAFT_EXECUTION_LOG_FAILED")); }
          try { await this.withDatabase(() => logAssetUpdateFailure(this.deps.db, failure, job.clientRequestId ?? `asset-job:${job.id}`, owner.job, "execution_settlement_failed")); }
          catch (diagnostic) { return rejectDiagnostic(diagnostic); }
          return { status: "rejected", reason: failure };
        }
        return owner.stopping ? { status: "rejected", reason } : { status: "fulfilled", value: undefined };
      } finally { if (!owner.stopping && owners.get(job.id) === owner) owners.delete(job.id); }
    });
  }

  /** 按资产类型启动助手草案任务，保留 Role 旧入口兼容现有调用。 */
  async generateAssetDraft(input: OrchAssetDraftGenerateRequestBody): Promise<OrchAssetDraftGenerateResponseBody> {
    return input.assetKind === "skill" ? this.generateSkillDraft(input) : this.generateRoleDraft(input);
  }

  /** 读取任意资产草案任务状态，供前端会话列表恢复。 */
  getAssetDraftJob(input: OrchAssetDraftJobGetRequestBody): OrchAssetDraftJobGetResponseBody {
    const job = this.requireJob(input.workspaceId, input.jobId);
    const draft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
    return {
      job,
      draft: summarizeAssetDraft(draft),
      events: this.deps.db.orchAssetJobEvents.listRecentByJob(job.id, MAX_EVENT_FETCH).map((event) => toAssetJobEventView(event)),
    };
  }

  /** 列出最近助手草案任务，允许 Role 与 Skill 多草稿并存。 */
  listAssetDraftJobs(input: OrchAssetDraftJobsListRequestBody): OrchAssetDraftJobsListResponseBody {
    const limit = clampListLimit(input.limit, 30, 100);
    const jobs = this.deps.db.orchAssetGenerationJobs
      .listByWorkspace(input.workspaceId, { limit })
      .filter((job) => job.assetKind === "role" || job.assetKind === "skill")
      .map((job): OrchAssetDraftJobListItem => ({
        job,
        draft: summarizeAssetDraft(job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null),
      }));
    return { jobs, hasMore: false, nextCursor: null };
  }

  /** 按任务资产类型继续生成草案，Skill 支持基于上一候选草案的增量补丁。 */
  async resumeAssetDraftJob(input: OrchAssetDraftJobResumeRequestBody): Promise<OrchAssetDraftJobResumeResponseBody> {
    const job = await this.withDatabase(() => this.requireJob(input.workspaceId, input.jobId));
    return job.assetKind === "skill" ? this.resumeSkillDraftJob(input, job) : this.resumeRoleDraftJob(input);
  }

  /** 读取任意资产草案详情并构造预览对比。 */
  getAssetDraft(input: OrchAssetDraftGetRequestBody): OrchAssetDraftGetResponseBody {
    const draft = this.requireDraft(input.workspaceId, input.draftId);
    return draft.assetKind === "skill" ? this.getSkillDraft(input) : this.getRoleDraft(input);
  }

  /** 应用任意资产草案到正式资产并记录版本。 */
  applyAssetDraft(input: OrchAssetDraftApplyRequestBody): OrchAssetDraftApplyResponseBody {
    const draft = this.requireDraft(input.workspaceId, input.draftId);
    return draft.assetKind === "skill" ? this.applySkillDraft(input) : this.applyRoleDraft(input);
  }

  /** 角色任务同步准入与持久化共用短许可，后台生成沿原owner启动。 */
  async generateRoleDraft(input: OrchAssetDraftGenerateRequestBody): Promise<OrchAssetDraftGenerateResponseBody> {
    return this.withDatabase(() => {
      this.assertTaskAdmission();
      if (input.assetKind !== "role") {
        throw serviceError(400, "BAD_REQUEST", "当前只支持 role 资产草案");
      }
      if (input.mode !== "create" && input.mode !== "revise") {
        throw serviceError(400, "BAD_REQUEST", "参数错误：mode");
      }
      if (input.mode === "revise" && !String(input.targetAssetId ?? "").trim()) {
        throw serviceError(400, "BAD_REQUEST", "优化角色时必须提供 targetAssetId");
      }
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt && !input.roleSnapshot) {
        throw serviceError(400, "BAD_REQUEST", "请先描述您希望生成或优化的角色");
      }
      const workspacePath = this.requireWorkspacePath(input.workspaceId);
      const selectedPaths = normalizeSelectedPaths(input.contextOptions?.selectedPaths);
      this.assertSelectedPathsValid(workspacePath, selectedPaths);

      const clientRequestId = nullableString(input.clientRequestId);
      if (clientRequestId) {
        const existing = this.deps.db.orchAssetGenerationJobs.findByClientRequestId(input.workspaceId, clientRequestId);
        if (existing) {
          return { reusedJob: true, job: existing };
        }
      }

      const targetRole = input.targetAssetId ? this.deps.db.orchRoles.get(input.targetAssetId) : null;
      if (input.mode === "revise" && (!targetRole || targetRole.workspaceId !== input.workspaceId)) {
        throw serviceError(404, "NOT_FOUND", `角色不存在：${String(input.targetAssetId ?? "")}`);
      }

      const baseVersion = input.targetAssetId
        ? this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "role", input.targetAssetId)
        : null;

      const storedRequest: StoredRoleDraftJobRequest = {
        ...input,
        prompt,
        clientRequestId,
        baseVersionId: baseVersion?.id ?? null,
        contextOptions: {
          includeExistingAssets: input.contextOptions?.includeExistingAssets !== false,
          includeWorkbenchDocs: Boolean(input.contextOptions?.includeWorkbenchDocs),
          includeWorkspaceFiles: input.contextOptions?.includeWorkspaceFiles !== false,
          maxContextChars: clampContextChars(input.contextOptions?.maxContextChars),
          selectedPaths,
        },
      };

      const job = this.deps.db.db.transaction(() => {
        const created = this.deps.db.orchAssetGenerationJobs.create({
          workspaceId: input.workspaceId,
          assetKind: "role",
          mode: input.mode,
          status: "queued",
          targetAssetId: input.targetAssetId ?? null,
          clientRequestId,
          baseVersionId: baseVersion?.id ?? null,
          draftId: null,
          threadId: null,
          prompt,
          requestJson: JSON.stringify(storedRequest),
          interactionRequest: null,
          progress: makeProgress("queued", "已排队，等待开始生成", "系统正在准备角色草案任务", 0),
          failure: null,
        });
        this.emitJobEvent(created.id, "orch.assetDraft.jobQueued", {
          from: null,
          to: "queued",
          headline: "已排队，等待开始生成",
          detail: "系统正在准备角色草案任务",
          percent: 0,
        } satisfies AssetJobStatusChangedPayload);
        return created;
      })();

      this.launchDraftRun(job, "角色", () => this.runGenerateRoleDraftJob(job.id, storedRequest));

      return { reusedJob: false, job };
    });
  }

  /** 启动 Skill 草案任务；支持 create/revise，并允许工具只提交字段级或脚本级 patch。 */
  async generateSkillDraft(input: OrchAssetDraftGenerateRequestBody): Promise<OrchAssetDraftGenerateResponseBody> {
    return this.withDatabase(() => {
      this.assertTaskAdmission();
      if (input.assetKind !== "skill") {
        throw serviceError(400, "BAD_REQUEST", "当前请求不是 skill 资产草案");
      }
      if (input.mode !== "create" && input.mode !== "revise") {
        throw serviceError(400, "BAD_REQUEST", "参数错误：mode");
      }
      if (input.mode === "revise" && !String(input.targetAssetId ?? "").trim()) {
        throw serviceError(400, "BAD_REQUEST", "优化 Skill 时必须提供 targetAssetId");
      }
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt && !input.skillSnapshot) {
        throw serviceError(400, "BAD_REQUEST", "请先描述您希望生成或优化的 Skill");
      }
      const workspacePath = this.requireWorkspacePath(input.workspaceId);
      const selectedPaths = normalizeSelectedPaths(input.contextOptions?.selectedPaths);
      this.assertSelectedPathsValid(workspacePath, selectedPaths);

      const clientRequestId = nullableString(input.clientRequestId);
      if (clientRequestId) {
        const existing = this.deps.db.orchAssetGenerationJobs.findByClientRequestId(input.workspaceId, clientRequestId);
        if (existing) {
          return { reusedJob: true, job: existing };
        }
      }

      const targetSkillId = nullableString(input.targetAssetId) as SkillId | null;
      const targetSkill = targetSkillId ? this.deps.db.orchSkills.get(targetSkillId) : null;
      if (input.mode === "revise" && (!targetSkill || targetSkill.workspaceId !== input.workspaceId)) {
        throw serviceError(404, "NOT_FOUND", `Skill 不存在：${String(input.targetAssetId ?? "")}`);
      }
      const promptSkill = normalizePromptSkillSnapshot(input.skillSnapshot, input.workspaceId) ?? targetSkill;
      const baseVersion = targetSkillId
        ? this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "skill", targetSkillId)
        : null;

      const storedRequest: StoredSkillDraftJobRequest = {
        ...input,
        assetKind: "skill",
        targetAssetId: targetSkillId,
        skillSnapshot: promptSkill ? stripRuntimeSkillFields(promptSkill) : null,
        workingDraft: promptSkill ? skillToDraftDefinition(promptSkill) : null,
        prompt,
        clientRequestId,
        baseVersionId: baseVersion?.id ?? null,
        contextOptions: {
          includeExistingAssets: input.contextOptions?.includeExistingAssets !== false,
          includeWorkbenchDocs: Boolean(input.contextOptions?.includeWorkbenchDocs),
          includeWorkspaceFiles: input.contextOptions?.includeWorkspaceFiles !== false,
          maxContextChars: clampContextChars(input.contextOptions?.maxContextChars),
          selectedPaths,
        },
      };

      const job = this.deps.db.db.transaction(() => {
        const created = this.deps.db.orchAssetGenerationJobs.create({
          workspaceId: input.workspaceId,
          assetKind: "skill",
          mode: input.mode,
          status: "queued",
          targetAssetId: targetSkillId,
          clientRequestId,
          baseVersionId: baseVersion?.id ?? null,
          draftId: null,
          threadId: null,
          prompt,
          requestJson: JSON.stringify(storedRequest),
          interactionRequest: null,
          progress: makeProgress("queued", "已排队，等待开始生成", "系统正在准备 Skill 草案任务", 0),
          failure: null,
        });
        this.emitJobEvent(created.id, "orch.assetDraft.jobQueued", {
          from: null,
          to: "queued",
          headline: "已排队，等待开始生成",
          detail: "系统正在准备 Skill 草案任务",
          percent: 0,
        } satisfies AssetJobStatusChangedPayload);
        return created;
      })();

      this.launchDraftRun(job, "Skill", () => this.runGenerateSkillDraftJob(job.id, storedRequest));

      return { reusedJob: false, job };
    });
  }

  getRoleDraftJob(input: OrchAssetDraftJobGetRequestBody): OrchAssetDraftJobGetResponseBody {
    const job = this.requireJob(input.workspaceId, input.jobId);
    const draft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
    return {
      job,
      draft: summarizeRoleDraft(draft),
      events: this.deps.db.orchAssetJobEvents.listRecentByJob(job.id, MAX_EVENT_FETCH).map((event) => toAssetJobEventView(event)),
    };
  }

  /** 列出最近的角色草案任务，用于助手会话列表刷新恢复。 */
  listRoleDraftJobs(input: OrchAssetDraftJobsListRequestBody): OrchAssetDraftJobsListResponseBody {
    const limit = clampListLimit(input.limit, 30, 100);
    const jobs = this.deps.db.orchAssetGenerationJobs
      .listByWorkspace(input.workspaceId, { limit })
      .filter((job) => job.assetKind === "role")
      .map((job): OrchAssetDraftJobListItem => ({
        job,
        draft: summarizeRoleDraft(job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null),
      }));
    return { jobs, hasMore: false, nextCursor: null };
  }

  /** 继续角色草案任务；已应用草案会以落地角色作为新一轮优化基线。 */
  async resumeRoleDraftJob(input: OrchAssetDraftJobResumeRequestBody): Promise<OrchAssetDraftJobResumeResponseBody> {
    return this.withDatabase(() => {
      this.assertTaskAdmission();
      const job = this.requireJob(input.workspaceId, input.jobId);
      if (!isContinuableDraftJob(job)) {
        throw serviceError(409, "CONFLICT", `当前任务状态不允许继续：${job.status}`);
      }
      const targetThreadId = nullableString(input.targetThreadId) as ThreadId | null;
      if (targetThreadId && targetThreadId !== nullableString(job.threadId)) {
        throw serviceError(409, "CONFLICT", "任务执行线程已经变化，请重新加载后再试");
      }
      const resumePrompt = String(input.prompt ?? "").trim();
      if (!resumePrompt) {
        throw serviceError(400, "BAD_REQUEST", "请先补充新的说明后再继续生成");
      }

      const request = parseStoredRoleDraftJobRequest(job.requestJson);
      const baseRequest = job.status === "applied" ? this.buildAppliedRoleResumeRequest(job, request) : request;
      const nextRequest: StoredRoleDraftJobRequest = {
        ...baseRequest,
        prompt: appendResumePrompt(baseRequest.prompt, resumePrompt),
        enginePreference: input.enginePreference
          ? { ...baseRequest.enginePreference, ...input.enginePreference }
          : baseRequest.enginePreference,
        contextOptions: {
          ...baseRequest.contextOptions,
          selectedPaths: normalizeSelectedPaths(input.selectedPaths?.length ? input.selectedPaths : baseRequest.contextOptions.selectedPaths),
        },
      };

      const currentDraft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
      this.prepareJobResume({
        job,
        currentDraft,
        requestJson: JSON.stringify(nextRequest),
        targetThreadId,
        progress: makeProgress("queued", "已恢复任务，等待继续生成", "系统正在基于新的补充信息重新生成角色草案", 0),
      });

      this.launchDraftRun(job, "角色", () => this.runGenerateRoleDraftJob(job.id, nextRequest, { reuseThreadId: targetThreadId }));

      return {
        job: this.requireJob(input.workspaceId, input.jobId),
      };
    });
  }

  /** 把已应用角色草案转换成 revise 请求，保留正式资产版本作为继续修改基线。 */
  private buildAppliedRoleResumeRequest(
    job: AssetGenerationJob,
    request: StoredRoleDraftJobRequest,
  ): StoredRoleDraftJobRequest {
    const currentDraft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
    const appliedVersion = currentDraft ? this.deps.db.orchAssetVersions.findBySourceDraftId(currentDraft.id) : null;
    const appliedRoleId = nullableString(appliedVersion?.assetId) as RoleId | null;
    const targetRoleId = appliedRoleId ?? (nullableString(request.targetAssetId) as RoleId | null);
    if (!targetRoleId) {
      throw serviceError(409, "CONFLICT", "已应用角色草案缺少落地资产，请重新打开正式 Agent 后再优化");
    }
    const targetRole = this.deps.db.orchRoles.get(targetRoleId);
    if (!targetRole || targetRole.workspaceId !== job.workspaceId) {
      throw serviceError(404, "NOT_FOUND", `角色不存在：${targetRoleId}`);
    }
    const latestVersion = this.deps.db.orchAssetVersions.latestVersion(job.workspaceId, "role", targetRole.id);
    return {
      ...request,
      mode: "revise",
      targetAssetId: targetRole.id,
      roleSnapshot: stripRuntimeRoleFields(targetRole),
      baseVersionId: latestVersion?.id ?? appliedVersion?.id ?? null,
    };
  }

  /** 继续 Skill 草案任务；若已有候选草案，新一轮工具 patch 会以该候选为基线。 */
  async resumeSkillDraftJob(
    input: OrchAssetDraftJobResumeRequestBody,
    loadedJob?: AssetGenerationJob,
  ): Promise<OrchAssetDraftJobResumeResponseBody> {
    return this.withDatabase(() => {
      this.assertTaskAdmission();
      const job = loadedJob ?? this.requireJob(input.workspaceId, input.jobId);
      if (job.assetKind !== "skill") {
        throw serviceError(409, "CONFLICT", "当前任务不是 Skill 草案任务");
      }
      if (!isContinuableDraftJob(job)) {
        throw serviceError(409, "CONFLICT", `当前任务状态不允许继续：${job.status}`);
      }
      const targetThreadId = nullableString(input.targetThreadId) as ThreadId | null;
      if (targetThreadId && targetThreadId !== nullableString(job.threadId)) {
        throw serviceError(409, "CONFLICT", "任务执行线程已经变化，请重新加载后再试");
      }
      const resumePrompt = String(input.prompt ?? "").trim();
      if (!resumePrompt) {
        throw serviceError(400, "BAD_REQUEST", "请先补充新的说明后再继续生成");
      }

      const request = parseStoredSkillDraftJobRequest(job.requestJson);
      const currentDraft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
      const appliedRequest = job.status === "applied" ? this.buildAppliedSkillResumeRequest(job, request) : null;
      const baseRequest = appliedRequest ?? request;
      const currentPayload = !appliedRequest && currentDraft ? parseSkillDraftPayload(currentDraft.payloadJson) : null;
      const nextRequest: StoredSkillDraftJobRequest = {
        ...baseRequest,
        prompt: appendResumePrompt(baseRequest.prompt, resumePrompt, "Skill"),
        enginePreference: input.enginePreference
          ? { ...baseRequest.enginePreference, ...input.enginePreference }
          : baseRequest.enginePreference,
        workingDraft: appliedRequest?.workingDraft ?? currentPayload?.draft ?? baseRequest.workingDraft ?? null,
        contextOptions: {
          ...baseRequest.contextOptions,
          selectedPaths: normalizeSelectedPaths(input.selectedPaths?.length ? input.selectedPaths : baseRequest.contextOptions.selectedPaths),
        },
      };

      this.prepareJobResume({
        job,
        currentDraft,
        requestJson: JSON.stringify(nextRequest),
        targetThreadId,
        progress: makeProgress("queued", "已恢复任务，等待继续生成", "系统正在基于新的补充信息重新生成 Skill 草案", 0),
      });

      this.launchDraftRun(job, "Skill", () => this.runGenerateSkillDraftJob(job.id, nextRequest, { reuseThreadId: targetThreadId }));

      return {
        job: this.requireJob(input.workspaceId, input.jobId),
      };
    });
  }

  /** 把已应用 Skill 草案转换成 revise 请求，后续 patch 以正式 Skill 为基线。 */
  private buildAppliedSkillResumeRequest(
    job: AssetGenerationJob,
    request: StoredSkillDraftJobRequest,
  ): StoredSkillDraftJobRequest {
    const currentDraft = job.draftId ? this.deps.db.orchAssetDrafts.get(job.draftId) : null;
    const appliedVersion = currentDraft ? this.deps.db.orchAssetVersions.findBySourceDraftId(currentDraft.id) : null;
    const appliedSkillId = nullableString(appliedVersion?.assetId) as SkillId | null;
    const targetSkillId = appliedSkillId ?? (nullableString(request.targetAssetId) as SkillId | null);
    if (!targetSkillId) {
      throw serviceError(409, "CONFLICT", "已应用 Skill 草案缺少落地资产，请重新打开正式 Skill 后再优化");
    }
    const targetSkill = this.deps.db.orchSkills.get(targetSkillId);
    if (!targetSkill || targetSkill.workspaceId !== job.workspaceId) {
      throw serviceError(404, "NOT_FOUND", `Skill 不存在：${targetSkillId}`);
    }
    const latestVersion = this.deps.db.orchAssetVersions.latestVersion(job.workspaceId, "skill", targetSkill.id);
    return {
      ...request,
      mode: "revise",
      targetAssetId: targetSkill.id,
      skillSnapshot: stripRuntimeSkillFields(targetSkill),
      workingDraft: skillToDraftDefinition(targetSkill),
      baseVersionId: latestVersion?.id ?? appliedVersion?.id ?? null,
    };
  }

  getRoleDraft(input: OrchAssetDraftGetRequestBody): OrchAssetDraftGetResponseBody {
    let draft = this.requireDraft(input.workspaceId, input.draftId);
    const payload = parseRoleDraftPayload(draft.payloadJson);
    const refs = this.loadRoleReferenceContext(input.workspaceId);
    // 草案落地后由资产版本反查正式角色：create 草案的 targetAssetId 始终为 null，否则重名校验会把它自己创建的角色判成重复。
    const appliedVersion = this.deps.db.orchAssetVersions.findBySourceDraftId(draft.id);
    const appliedRoleId = appliedVersion ? (appliedVersion.assetId as RoleId) : null;
    const selfRoleId = (payload.targetAssetId ?? appliedRoleId) ?? null;
    const baseRole = payload.targetAssetId ? this.deps.db.orchRoles.get(payload.targetAssetId) : null;
    const validation = validateRoleDraft(payload, refs, selfRoleId);
    if (!sameValidationIssues(draft.validationIssues ?? [], validation.issues)) {
      draft = this.deps.db.orchAssetDrafts.updateValidationIssues(draft.id, validation.issues) ?? draft;
    }
    const comparison = buildRoleDraftComparison(baseRole, payload, refs, validation.issues);
    const job = this.deps.db.orchAssetGenerationJobs.get(draft.sourceJobId);
    return { draft, payload, comparison, job, appliedRoleId, appliedSkillId: null, appliedVersionId: appliedVersion?.id ?? null };
  }

  /** 读取 Skill 草案详情，并重新校验脚本、文件和重名风险。 */
  getSkillDraft(input: OrchAssetDraftGetRequestBody): OrchAssetDraftGetResponseBody {
    let draft = this.requireDraft(input.workspaceId, input.draftId);
    const payload = parseSkillDraftPayload(draft.payloadJson);
    const refs = this.loadSkillReferenceContext(input.workspaceId);
    const appliedVersion = this.deps.db.orchAssetVersions.findBySourceDraftId(draft.id);
    const appliedSkillId = appliedVersion ? (appliedVersion.assetId as SkillId) : null;
    const selfSkillId = (payload.targetAssetId ?? appliedSkillId) ?? null;
    const baseSkill = payload.targetAssetId ? this.deps.db.orchSkills.get(payload.targetAssetId) : null;
    const validation = validateSkillDraft(payload, refs, selfSkillId);
    if (!sameValidationIssues(draft.validationIssues ?? [], validation.issues)) {
      draft = this.deps.db.orchAssetDrafts.updateValidationIssues(draft.id, validation.issues) ?? draft;
    }
    const comparison = buildSkillDraftComparison(baseSkill, payload, validation.issues);
    const job = this.deps.db.orchAssetGenerationJobs.get(draft.sourceJobId);
    return { draft, payload, comparison, job, appliedRoleId: null, appliedSkillId, appliedVersionId: appliedVersion?.id ?? null };
  }

  applyRoleDraft(input: OrchAssetDraftApplyRequestBody): OrchAssetDraftApplyResponseBody {
    const draft = this.requireDraft(input.workspaceId, input.draftId);
    const job = this.requireJob(input.workspaceId, draft.sourceJobId);
    if (input.expectedJobId && String(input.expectedJobId) !== job.id) {
      throw serviceError(409, "CONFLICT", "草案任务已经变化，请重新加载后再试");
    }
    if (draft.status === "rejected") {
      throw serviceError(409, "CONFLICT", "该草案已被拒绝，不能继续应用");
    }

    const existingVersion = this.deps.db.orchAssetVersions.findBySourceDraftId(draft.id);
    if (existingVersion) {
      return {
        assetKind: "role",
        roleId: existingVersion.assetId as RoleId,
        versionId: existingVersion.id,
        appliedDraftId: draft.id,
      };
    }

    const payload = parseRoleDraftPayload(draft.payloadJson);
    if (input.expectedBaseVersionId && nullableString(input.expectedBaseVersionId) !== nullableString(payload.baseVersionId)) {
      throw serviceError(409, "DRAFT_BASE_VERSION_STALE", "草案基线已经变化，请重新生成", {
        draftBaseVersionId: payload.baseVersionId ?? null,
      });
    }

    const refs = this.loadRoleReferenceContext(input.workspaceId);
    const validation = validateRoleDraft(payload, refs, payload.targetAssetId ?? null);
    if (validation.hasBlockingError) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "角色草案存在阻断性校验问题，暂不能应用", {
        issues: validation.issues,
      });
    }
    if (!input.forceApplyWarnings && validation.warningCount > 0) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "角色草案仍有警告，请确认后再应用", {
        issues: validation.issues,
      });
    }

    const currentLatest = payload.targetAssetId
      ? this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "role", payload.targetAssetId)
      : null;
    if (payload.mode === "revise" && nullableString(currentLatest?.id) !== nullableString(payload.baseVersionId)) {
      throw serviceError(409, "DRAFT_BASE_VERSION_STALE", "该草案基于的角色版本已经过期，请重新生成", {
        latestVersionId: currentLatest?.id ?? null,
        draftBaseVersionId: payload.baseVersionId ?? null,
      });
    }

    const tx = () => this.deps.db.db.transaction(() => {
      const savedRole = this.deps.db.orchRoles.upsert({
        ...payload.draft,
        id: payload.targetAssetId ?? ("" as RoleId),
        workspaceId: input.workspaceId,
      });
      const latestAfterSave = this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "role", savedRole.id);
      const version = this.deps.db.orchAssetVersions.create({
        workspaceId: input.workspaceId,
        assetKind: "role",
        assetId: savedRole.id,
        version: Number(latestAfterSave?.version ?? 0) + 1,
        sourceDraftId: draft.id,
        snapshotJson: JSON.stringify(savedRole),
      });
      this.deps.db.orchAssetDrafts.updateValidationIssues(draft.id, validation.issues);
      this.deps.db.orchAssetDrafts.updateStatus(draft.id, "applied");
      this.deps.db.orchAssetGenerationJobs.updateFailure(job.id, null);
      this.deps.db.orchAssetGenerationJobs.updateStatus(
        job.id,
        "applied",
        makeProgress("applied", "角色草案已应用", `正式角色「${savedRole.name}」已生成`, 100),
      );
      this.emitJobEvent(job.id, "orch.assetDraft.applied", {
        roleId: savedRole.id,
        versionId: version.id,
        draftId: draft.id,
        comment: nullableString(input.review?.comment),
        reviewedDiffHash: nullableString(input.review?.reviewedDiffHash),
      });
      return { savedRole, version };
    })();

    const result = tx();
    return {
      assetKind: "role",
      roleId: result.savedRole.id,
      versionId: result.version.id,
      appliedDraftId: draft.id,
    };
  }

  /** 应用 Skill 草案到正式 Skill 资产，并记录完整版本快照。 */
  applySkillDraft(input: OrchAssetDraftApplyRequestBody): OrchAssetDraftApplyResponseBody {
    const draft = this.requireDraft(input.workspaceId, input.draftId);
    const job = this.requireJob(input.workspaceId, draft.sourceJobId);
    if (job.assetKind !== "skill" || draft.assetKind !== "skill") {
      throw serviceError(409, "CONFLICT", "当前草案不是 Skill 草案");
    }
    if (input.expectedJobId && String(input.expectedJobId) !== job.id) {
      throw serviceError(409, "CONFLICT", "草案任务已经变化，请重新加载后再试");
    }
    if (draft.status === "rejected") {
      throw serviceError(409, "CONFLICT", "该草案已被拒绝，不能继续应用");
    }

    const existingVersion = this.deps.db.orchAssetVersions.findBySourceDraftId(draft.id);
    if (existingVersion) {
      return {
        assetKind: "skill",
        skillId: existingVersion.assetId as SkillId,
        versionId: existingVersion.id,
        appliedDraftId: draft.id,
      };
    }

    const payload = parseSkillDraftPayload(draft.payloadJson);
    if (input.expectedBaseVersionId && nullableString(input.expectedBaseVersionId) !== nullableString(payload.baseVersionId)) {
      throw serviceError(409, "DRAFT_BASE_VERSION_STALE", "草案基线已经变化，请重新生成", {
        draftBaseVersionId: payload.baseVersionId ?? null,
      });
    }

    const refs = this.loadSkillReferenceContext(input.workspaceId);
    const validation = validateSkillDraft(payload, refs, payload.targetAssetId ?? null);
    if (validation.hasBlockingError) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "Skill 草案存在阻断性校验问题，暂不能应用", {
        issues: validation.issues,
      });
    }
    if (!input.forceApplyWarnings && validation.warningCount > 0) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "Skill 草案仍有警告，请确认后再应用", {
        issues: validation.issues,
      });
    }

    const currentLatest = payload.targetAssetId
      ? this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "skill", payload.targetAssetId)
      : null;
    if (payload.mode === "revise" && nullableString(currentLatest?.id) !== nullableString(payload.baseVersionId)) {
      throw serviceError(409, "DRAFT_BASE_VERSION_STALE", "该草案基于的 Skill 版本已经过期，请重新生成", {
        latestVersionId: currentLatest?.id ?? null,
        draftBaseVersionId: payload.baseVersionId ?? null,
      });
    }

    const tx = () => this.deps.db.db.transaction(() => {
      const savedSkill = this.deps.db.orchSkills.upsert({
        ...payload.draft,
        id: payload.targetAssetId ?? ("" as SkillId),
        workspaceId: input.workspaceId,
      });
      const latestAfterSave = this.deps.db.orchAssetVersions.latestVersion(input.workspaceId, "skill", savedSkill.id);
      const version = this.deps.db.orchAssetVersions.create({
        workspaceId: input.workspaceId,
        assetKind: "skill",
        assetId: savedSkill.id,
        version: Number(latestAfterSave?.version ?? 0) + 1,
        sourceDraftId: draft.id,
        snapshotJson: JSON.stringify(savedSkill),
      });
      this.deps.db.orchAssetDrafts.updateValidationIssues(draft.id, validation.issues);
      this.deps.db.orchAssetDrafts.updateStatus(draft.id, "applied");
      this.deps.db.orchAssetGenerationJobs.updateFailure(job.id, null);
      this.deps.db.orchAssetGenerationJobs.updateStatus(
        job.id,
        "applied",
        makeProgress("applied", "Skill 草案已应用", `正式 Skill「${savedSkill.name}」已生成`, 100),
      );
      this.emitJobEvent(job.id, "orch.assetDraft.applied", {
        skillId: savedSkill.id,
        versionId: version.id,
        draftId: draft.id,
        comment: nullableString(input.review?.comment),
        reviewedDiffHash: nullableString(input.review?.reviewedDiffHash),
      });
      return { savedSkill, version };
    })();

    const result = tx();
    return {
      assetKind: "skill",
      skillId: result.savedSkill.id,
      versionId: result.version.id,
      appliedDraftId: draft.id,
    };
  }

  rejectDraft(input: OrchAssetDraftRejectRequestBody): OrchAssetDraftRejectResponseBody {
    const draft = this.requireDraft(input.workspaceId, input.draftId);
    const job = this.requireJob(input.workspaceId, draft.sourceJobId);
    if (draft.status === "applied") {
      throw serviceError(409, "CONFLICT", "该草案已经应用，不能再拒绝");
    }
    if (draft.status === "rejected") {
      return { draftId: draft.id, status: "rejected" };
    }

    const tx = this.deps.db.db.transaction(() => {
      this.deps.db.orchAssetDrafts.updateStatus(draft.id, "rejected");
      this.deps.db.orchAssetGenerationJobs.updateStatus(
        job.id,
        "rejected",
        makeProgress("rejected", "角色草案已拒绝", nullableString(input.reason) ?? "等待重新生成", 100),
      );
      this.emitJobEvent(job.id, "orch.assetDraft.rejected", {
        draftId: draft.id,
        reason: nullableString(input.reason),
        comment: nullableString(input.review?.comment),
        reviewedDiffHash: nullableString(input.review?.reviewedDiffHash),
      });
    });
    tx();
    return { draftId: draft.id, status: "rejected" };
  }

  private async runGenerateRoleDraftJob(
    jobId: AssetGenerationJobId,
    input: StoredRoleDraftJobRequest,
    options: RoleDraftRunOptions = {},
  ): Promise<void> {
    const targetRole = input.targetAssetId ? await this.withDatabase(() => this.deps.db.orchRoles.get(input.targetAssetId!)) : null;
    const promptBaseRole = normalizePromptRoleSnapshot(input.roleSnapshot, input.workspaceId) ?? targetRole;
    const refs = await this.withDatabase(() => this.loadRoleReferenceContext(input.workspaceId));
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "planning",
      makeProgress("planning", "正在分析角色目标", "准备角色草案上下文", 10),
      ["queued"],
    ));
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "collecting_context",
      makeProgress("collecting_context", "正在收集角色上下文", "读取已选择的资产与工作区资料", 30),
      ["planning"],
    ));

    const context = await this.collectRoleDraftContext(input.workspaceId, input.prompt, input.contextOptions, refs, promptBaseRole, input.mode);
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "generating",
      makeProgress("generating", "正在调用引擎生成角色", "引擎正在整理角色草案，并需要通过平台工具提交结果", 55),
      ["collecting_context"],
    ));
    await this.withDatabase(() => this.emitJobEvent(jobId, "orch.assetDraft.contextCollected", {
      selectedPathCount: context.selectedPathCount,
      includedFileCount: context.includedFileCount,
      totalChars: context.totalChars,
      truncated: context.truncated,
    } satisfies AssetJobContextCollectedPayload));

    let attemptNo = 1;
    let responseText = "";
    let retryReason: string | null = null;

    while (attemptNo <= ROLE_DRAFT_MAX_ATTEMPTS) {
      if (attemptNo > 1) {
        await this.withDatabase(() => this.updateJobStatus(
          jobId,
          "generating",
          makeProgress(
            "generating",
            `正在第 ${attemptNo} 次要求引擎重新提交`,
            "上一轮没有通过平台工具提交角色草案，系统正在把错误反馈给引擎",
            60 + (attemptNo - 2) * 10,
          ),
          ["generating"],
        ));
      }
      const engineInfo = await this.invokeRoleDraftEngine(
        jobId,
        input.workspaceId,
        attemptNo === 1
          ? buildRoleDraftPromptMessages(context.prompt, refs, promptBaseRole, input)
          : buildRoleDraftSubmissionRecoveryMessages({
              input,
              refs,
              targetRole: promptBaseRole,
              previousResponseText: responseText,
              retryReason,
            }),
        promptBaseRole,
        input,
        refs,
        options,
      );
      if (engineInfo.kind === "awaiting_input") {
        throw createAwaitingInputSignal(engineInfo.interaction);
      }
      responseText = engineInfo.responseText;
      if (engineInfo.kind === "submitted") {
        return;
      }

      retryReason = [
        `当前回合已经结束，但没有调用平台工具 ${ROLE_DRAFT_SUBMIT_TOOL_ID} 提交角色草案。`,
        "角色助手不再接受 assistant 文本里的 JSON，也不会把普通文本回退成草案结果。",
      ].join(" ");
      if (attemptNo >= ROLE_DRAFT_MAX_ATTEMPTS) {
        throw serviceError(409, "TOOL_RESULT_REQUIRED", retryReason, {
          toolId: ROLE_DRAFT_SUBMIT_TOOL_ID,
          responseText: responseText || null,
          userHint: "请让 AI 在同一轮里直接调用平台工具提交角色草案，而不是只输出文本或 JSON。",
        });
      }
      attemptNo += 1;
    }

    throw serviceError(500, "INTERNAL_ERROR", "角色生成流程未得到有效结果");
  }

  private async runGenerateSkillDraftJob(
    jobId: AssetGenerationJobId,
    input: StoredSkillDraftJobRequest,
    options: RoleDraftRunOptions = {},
  ): Promise<void> {
    const targetSkill = input.targetAssetId ? await this.withDatabase(() => this.deps.db.orchSkills.get(input.targetAssetId!)) : null;
    const promptBaseSkill = normalizePromptSkillSnapshot(input.skillSnapshot, input.workspaceId) ?? targetSkill;
    const refs = await this.withDatabase(() => this.loadSkillReferenceContext(input.workspaceId));
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "planning",
      makeProgress("planning", "正在分析 Skill 目标", "准备 Skill 草案上下文", 10),
      ["queued"],
    ));
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "collecting_context",
      makeProgress("collecting_context", "正在收集 Skill 上下文", "读取已选择的 Skill 与工作区资料", 30),
      ["planning"],
    ));

    const context = await this.collectSkillDraftContext(input.workspaceId, input.prompt, input.contextOptions, refs, promptBaseSkill, input.workingDraft ?? null);
    await this.withDatabase(() => this.updateJobStatus(
      jobId,
      "generating",
      makeProgress("generating", "正在调用引擎生成 Skill", "引擎正在整理 Skill 草案，并需要通过平台工具提交结果", 55),
      ["collecting_context"],
    ));
    await this.withDatabase(() => this.emitJobEvent(jobId, "orch.assetDraft.contextCollected", {
      selectedPathCount: context.selectedPathCount,
      includedFileCount: context.includedFileCount,
      totalChars: context.totalChars,
      truncated: context.truncated,
    } satisfies AssetJobContextCollectedPayload));

    let attemptNo = 1;
    let responseText = "";
    let retryReason: string | null = null;

    while (attemptNo <= ROLE_DRAFT_MAX_ATTEMPTS) {
      if (attemptNo > 1) {
        await this.withDatabase(() => this.updateJobStatus(
          jobId,
          "generating",
          makeProgress(
            "generating",
            `正在第 ${attemptNo} 次要求引擎重新提交`,
            "上一轮没有通过平台工具提交 Skill 草案，系统正在把错误反馈给引擎",
            60 + (attemptNo - 2) * 10,
          ),
          ["generating"],
        ));
      }
      const engineInfo = await this.invokeSkillDraftEngine(
        jobId,
        input.workspaceId,
        attemptNo === 1
          ? buildSkillDraftPromptMessages(context.prompt, refs, promptBaseSkill, input)
          : buildSkillDraftSubmissionRecoveryMessages({
              input,
              refs,
              targetSkill: promptBaseSkill,
              previousResponseText: responseText,
              retryReason,
            }),
        promptBaseSkill,
        input,
        refs,
        options,
      );
      if (engineInfo.kind === "awaiting_input") {
        throw createAwaitingInputSignal(engineInfo.interaction);
      }
      responseText = engineInfo.responseText;
      if (engineInfo.kind === "submitted") {
        return;
      }

      retryReason = [
        `当前回合已经结束，但没有调用平台工具 ${SKILL_DRAFT_SUBMIT_TOOL_ID} 提交 Skill 草案。`,
        "助手不接受 assistant 文本里的 JSON，也不会把普通文本回退成草案结果。",
      ].join(" ");
      if (attemptNo >= ROLE_DRAFT_MAX_ATTEMPTS) {
        throw serviceError(409, "TOOL_RESULT_REQUIRED", retryReason, {
          toolId: SKILL_DRAFT_SUBMIT_TOOL_ID,
          responseText: responseText || null,
          userHint: "请让 AI 在同一轮里直接调用平台工具提交 Skill 草案或增量补丁，而不是只输出文本或 JSON。",
        });
      }
      attemptNo += 1;
    }

    throw serviceError(500, "INTERNAL_ERROR", "Skill 生成流程未得到有效结果");
  }

  private persistSubmittedRoleDraft(input: {
    jobId: AssetGenerationJobId;
    request: StoredRoleDraftJobRequest;
    payload: RoleDraftPayload;
    validation: ValidationResult;
    engineInfo: {
      engine: "claude" | "codex";
      model?: string | null;
      effort?: string | null;
    };
  }): AssetDraft {
    this.assertRunAccepting(input.jobId);
    if (input.validation.hasBlockingError) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "角色草案存在阻断性校验问题，不能进入待确认", {
        issues: input.validation.issues,
      });
    }
    return this.deps.db.db.transaction(() => {
      const existingJob = this.deps.db.orchAssetGenerationJobs.get(input.jobId);
      if (existingJob?.draftId) {
        const existingDraft = this.deps.db.orchAssetDrafts.get(existingJob.draftId);
        if (existingDraft) return existingDraft;
      }
      const validatingProgress = makeProgress("validating", "正在校验角色草案", "检查字段、引用与阻断项", 90);
      const validating = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.jobId,
        ["generating"],
        { status: "validating", progress: validatingProgress },
      );
      if (!validating) throw new AssetDraftRunObsoleteError(input.jobId);
      this.emitStatusChangedEvent(input.jobId, validating.previous.status, "validating", validatingProgress);
      this.emitJobEvent(input.jobId, "orch.assetDraft.validationCompleted", {
        errorCount: input.validation.blockingIssueCount,
        warningCount: input.validation.warningCount,
      } satisfies AssetJobValidationCompletedPayload);

      const draft = this.deps.db.orchAssetDrafts.create({
        workspaceId: input.request.workspaceId,
        assetKind: "role",
        mode: input.payload.mode,
        status: "awaiting_review",
        targetAssetId: input.payload.targetAssetId ?? null,
        baseVersionId: input.payload.baseVersionId ?? null,
        sourceJobId: input.jobId,
        prompt: input.request.prompt,
        payloadJson: JSON.stringify(input.payload),
        validationIssues: input.validation.issues,
        rationale: input.payload.rationale.summary,
        engineInfo: {
          engine: input.engineInfo.engine,
          model: input.engineInfo.model,
          effort: input.engineInfo.effort,
        },
      });
      const readyProgress = makeProgress(
        "awaiting_review",
        "角色结果已提交",
        input.validation.warningCount > 0
          ? "平台工具已经接收角色草案，但仍有 warning，前端回填后请人工检查"
          : "平台工具已经接收角色草案，前端可直接回填表单",
        100,
      );
      const ready = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.jobId,
        ["validating"],
        { status: "awaiting_review", progress: readyProgress, draftId: draft.id, failure: null, interactionRequest: null },
      );
      if (!ready) throw new AssetDraftRunObsoleteError(input.jobId);
      this.emitJobEvent(input.jobId, "orch.assetDraft.draftCreated", { draftId: draft.id });
      this.emitStatusChangedEvent(input.jobId, ready.previous.status, "awaiting_review", readyProgress);
      return draft;
    })();
  }

  private persistSubmittedSkillDraft(input: {
    jobId: AssetGenerationJobId;
    request: StoredSkillDraftJobRequest;
    payload: SkillDraftPayload;
    validation: ValidationResult;
    engineInfo: {
      engine: "claude" | "codex";
      model?: string | null;
      effort?: string | null;
    };
  }): AssetDraft {
    this.assertRunAccepting(input.jobId);
    if (input.validation.hasBlockingError) {
      throw serviceError(409, "SCHEMA_VALIDATION_FAILED", "Skill 草案存在阻断性校验问题，不能进入待确认", {
        issues: input.validation.issues,
      });
    }
    return this.deps.db.db.transaction(() => {
      const existingJob = this.deps.db.orchAssetGenerationJobs.get(input.jobId);
      if (existingJob?.draftId) {
        const existingDraft = this.deps.db.orchAssetDrafts.get(existingJob.draftId);
        if (existingDraft) return existingDraft;
      }
      const validatingProgress = makeProgress("validating", "正在校验 Skill 草案", "检查字段、文件与脚本定义", 90);
      const validating = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.jobId,
        ["generating"],
        { status: "validating", progress: validatingProgress },
      );
      if (!validating) throw new AssetDraftRunObsoleteError(input.jobId);
      this.emitStatusChangedEvent(input.jobId, validating.previous.status, "validating", validatingProgress);
      this.emitJobEvent(input.jobId, "orch.assetDraft.validationCompleted", {
        errorCount: input.validation.blockingIssueCount,
        warningCount: input.validation.warningCount,
      } satisfies AssetJobValidationCompletedPayload);

      const draft = this.deps.db.orchAssetDrafts.create({
        workspaceId: input.request.workspaceId,
        assetKind: "skill",
        mode: input.payload.mode,
        status: "awaiting_review",
        targetAssetId: input.payload.targetAssetId ?? null,
        baseVersionId: input.payload.baseVersionId ?? null,
        sourceJobId: input.jobId,
        prompt: input.request.prompt,
        payloadJson: JSON.stringify(input.payload),
        validationIssues: input.validation.issues,
        rationale: input.payload.rationale.summary,
        engineInfo: {
          engine: input.engineInfo.engine,
          model: input.engineInfo.model,
          effort: input.engineInfo.effort,
        },
      });
      const readyProgress = makeProgress(
        "awaiting_review",
        "Skill 结果已提交",
        input.validation.warningCount > 0
          ? "平台工具已经接收 Skill 草案，但仍有 warning，请人工检查"
          : "平台工具已经接收 Skill 草案，可预览并确认应用",
        100,
      );
      const ready = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.jobId,
        ["validating"],
        { status: "awaiting_review", progress: readyProgress, draftId: draft.id, failure: null, interactionRequest: null },
      );
      if (!ready) throw new AssetDraftRunObsoleteError(input.jobId);
      this.emitJobEvent(input.jobId, "orch.assetDraft.draftCreated", { draftId: draft.id });
      this.emitStatusChangedEvent(input.jobId, ready.previous.status, "awaiting_review", readyProgress);
      return draft;
    })();
  }

  /** 加载 Agent 草案可绑定资产；已有 Agent 只用于服务端校验，不进入默认提示词。 */
  private loadRoleReferenceContext(workspaceId: WorkspaceId): RoleReferenceContext {
    const roles = this.deps.db.orchRoles.listByWorkspace(workspaceId);
    const knowledgeBundles = this.deps.db.orchKnowledgeBundles.listByWorkspace(workspaceId);
    const toolsets = this.deps.db.orchToolsets.listByWorkspace(workspaceId);
    const skills = this.deps.db.orchSkills.listByWorkspace(workspaceId);
    return {
      roles,
      knowledgeBundles,
      toolsets,
      skills,
      knowledgeBundleById: new Map(knowledgeBundles.map((item) => [item.id, item])),
      toolsetById: new Map(toolsets.map((item) => [item.id, item])),
    };
  }

  private loadSkillReferenceContext(workspaceId: WorkspaceId): SkillReferenceContext {
    const skills = this.deps.db.orchSkills.listByWorkspace(workspaceId);
    return {
      skills,
      skillById: new Map(skills.map((item) => [item.id, item])),
    };
  }

  /** 组装 Agent 草案提示词上下文，避免创建场景把全量 Agent 当作默认参考。 */
  private async collectRoleDraftContext(
    workspaceId: WorkspaceId,
    userPrompt: string,
    options: {
      includeExistingAssets: boolean;
      includeWorkbenchDocs: boolean;
      includeWorkspaceFiles: boolean;
      maxContextChars: number;
      selectedPaths: string[];
    },
    refs: RoleReferenceContext,
    targetRole: RoleDefinition | null,
    mode: "create" | "revise",
  ): Promise<CollectedContext> {
    const workspacePath = this.requireWorkspacePath(workspaceId);
    const parts: string[] = [];
    let totalChars = 0;
    let truncated = false;
    let includedFileCount = 0;

    const appendBlock = (title: string, content: string) => {
      const text = String(content ?? "").trim();
      if (!text) return;
      if (totalChars >= options.maxContextChars) {
        truncated = true;
        return;
      }
      const remaining = options.maxContextChars - totalChars;
      const block = `\n## ${title}\n${text}\n`;
      if (block.length > remaining) {
        parts.push(block.slice(0, remaining));
        totalChars += remaining;
        truncated = true;
        return;
      }
      parts.push(block);
      totalChars += block.length;
    };

    appendBlock("用户补充说明", userPrompt);
    appendBlock("当前工作区", workspacePath);
    if (targetRole) {
      appendBlock(mode === "revise" ? "当前待优化角色" : "新角色初始草案", JSON.stringify(sanitizeRoleDefinition(targetRole), null, 2));
    }

    if (options.includeExistingAssets) {
      appendBlock("现有知识库摘要", summarizeKnowledgeBundles(refs.knowledgeBundles));
      appendBlock("现有工具集摘要", summarizeToolsets(refs.toolsets));
      appendBlock("现有 Skills 摘要", summarizeSkills(refs.skills, null));
    }

    if (options.includeWorkbenchDocs) {
      for (const doc of listWorkbenchDocs(workspacePath).slice(0, MAX_WORKBENCH_DOCS)) {
        const content = readTextFileSafe(doc.absPath, MAX_SELECTED_FILE_BYTES);
        if (!content) continue;
        appendBlock(`工作台文档: ${doc.relPath}`, content);
        includedFileCount += 1;
      }
    }

    if (options.includeWorkspaceFiles && options.selectedPaths.length) {
      for (const relPath of options.selectedPaths) {
        const absPath = resolveWorkspacePath(workspacePath, relPath);
        if (!fs.existsSync(absPath)) {
          throw serviceError(400, "SOURCE_PATH_MISSING", `找不到选中的文件：${relPath}`, { path: relPath });
        }
        const content = readTextFileSafe(absPath, MAX_SELECTED_FILE_BYTES);
        if (!content) continue;
        appendBlock(`工作区文件: ${relPath}`, content);
        includedFileCount += 1;
      }
    }

    return {
      prompt: parts.join("\n").trim(),
      selectedPaths: options.selectedPaths,
      selectedPathCount: options.selectedPaths.length,
      includedFileCount,
      totalChars,
      truncated,
    };
  }

  private async collectSkillDraftContext(
    workspaceId: WorkspaceId,
    userPrompt: string,
    options: StoredSkillDraftJobRequest["contextOptions"],
    refs: SkillReferenceContext,
    targetSkill: SkillDefinition | null,
    workingDraft: SkillDraftPayload["draft"] | null,
  ): Promise<CollectedContext> {
    const workspacePath = this.requireWorkspacePath(workspaceId);
    const parts: string[] = [];
    let totalChars = 0;
    let truncated = false;
    let includedFileCount = 0;

    const appendBlock = (title: string, content: string) => {
      const text = String(content ?? "").trim();
      if (!text) return;
      if (totalChars >= options.maxContextChars) {
        truncated = true;
        return;
      }
      const remaining = options.maxContextChars - totalChars;
      const block = `\n## ${title}\n${text}\n`;
      if (block.length > remaining) {
        parts.push(block.slice(0, remaining));
        totalChars += remaining;
        truncated = true;
        return;
      }
      parts.push(block);
      totalChars += block.length;
    };

    appendBlock("用户补充说明", userPrompt);
    appendBlock("当前工作区", workspacePath);
    if (targetSkill) appendBlock("当前待优化 Skill", JSON.stringify(sanitizeSkillDefinition(targetSkill), null, 2));
    if (workingDraft) appendBlock("当前候选 Skill 草案", JSON.stringify(workingDraft, null, 2));
    if (options.includeExistingAssets) appendBlock("现有 Skills 摘要", summarizeSkills(refs.skills, targetSkill?.id ?? null));

    if (options.includeWorkbenchDocs) {
      for (const doc of listWorkbenchDocs(workspacePath).slice(0, MAX_WORKBENCH_DOCS)) {
        const content = readTextFileSafe(doc.absPath, MAX_SELECTED_FILE_BYTES);
        if (!content) continue;
        appendBlock(`工作台文档: ${doc.relPath}`, content);
        includedFileCount += 1;
      }
    }

    if (options.includeWorkspaceFiles && options.selectedPaths.length) {
      for (const relPath of options.selectedPaths) {
        const absPath = resolveWorkspacePath(workspacePath, relPath);
        if (!fs.existsSync(absPath)) {
          throw serviceError(400, "SOURCE_PATH_MISSING", `找不到选中的文件：${relPath}`, { path: relPath });
        }
        const content = readTextFileSafe(absPath, MAX_SELECTED_FILE_BYTES);
        if (!content) continue;
        appendBlock(`工作区文件: ${relPath}`, content);
        includedFileCount += 1;
      }
    }

    return {
      prompt: parts.join("\n").trim(),
      selectedPaths: options.selectedPaths,
      selectedPathCount: options.selectedPaths.length,
      includedFileCount,
      totalChars,
      truncated,
    };
  }

  /** 调用角色助手引擎，按真实 system/developer/user 三层传入草案生成上下文。 */
  private async invokeRoleDraftEngine(
    jobId: AssetGenerationJobId,
    workspaceId: WorkspaceId,
    promptMessages: DraftPromptMessages,
    targetRole: RoleDefinition | null,
    input: StoredRoleDraftJobRequest,
    refs: RoleReferenceContext,
    options: RoleDraftRunOptions = {},
  ): Promise<RoleDraftEngineInvocation> {
    await this.waitForRunAdmission(jobId);
    const reuseThreadId = nullableString(options.reuseThreadId) as ThreadId | null;
    const existingThread = reuseThreadId ? await this.withDatabase(() => this.deps.db.threads.get(reuseThreadId)) : null;
    if (reuseThreadId && !existingThread) {
      throw serviceError(404, "NOT_FOUND", `草案执行会话不存在：${reuseThreadId}`);
    }
    if (existingThread && existingThread.workspaceId !== workspaceId) {
      throw serviceError(409, "CONFLICT", "草案执行会话不属于当前工作区");
    }
    const engine = existingThread?.engine ?? resolveDraftEngine(targetRole, input);
    const executionBase = targetRole && isRoleExecutionEngineEnabled(targetRole.executionConfig, engine, targetRole.executionConfig.preferredEngine)
      ? targetRole.executionConfig
      : createDefaultRoleExecutionConfig(engine);
    const effectiveExecutionConfig = resolveRuntimeRoleExecutionConfigForEngine(
      executionBase,
      engine,
      engine,
    );
    const model = nullableString(input.enginePreference?.model) ?? effectiveExecutionConfig.model ?? null;
    const effort = nullableString(input.enginePreference?.effort) ?? effectiveExecutionConfig.effort ?? null;
    const contextWindow = input.enginePreference?.contextWindow ?? effectiveExecutionConfig.contextWindow ?? null;
    const autoCompactPct = input.enginePreference?.autoCompactPct ?? effectiveExecutionConfig.autoCompactPct ?? null;
    const serviceTier = input.enginePreference?.serviceTier ?? null;
    await this.withDatabase(() => assertClientReasoningEffortSupported(this.deps.db, engine, model, effort));
    const threadId = reuseThreadId ?? (`asset-draft-${crypto.randomUUID()}` as ThreadId);
    const title = existingThread?.title ?? (input.mode === "revise" ? "[角色草案] AI 优化角色" : "[角色草案] AI 创建角色");
    const turnId = `turn_${crypto.randomUUID()}` as TurnId;
    const userItemId = `item_user_${crypto.randomUUID()}`;
    const assistantItemId = `item_assistant_${crypto.randomUUID()}`;
    const reasoningItemId = `item_reasoning_${crypto.randomUUID()}`;
    await this.withDatabase(() => this.persistRunThread({ jobId, threadId, workspaceId, engine, title, model, effort, createThread: !existingThread }));
    const runtime = this.deps.threads.create({
      threadId,
      workspaceId,
      engine,
      title,
      sessionId: existingThread?.sessionId ?? undefined,
      sessionCapabilities: existingThread?.sessionCapabilities ?? undefined,
    });

    let interactionRequest: AssetGenerationInteractionRequest | null = null;
    let submittedDraftId: AssetDraftId | null = null;
    let responseText = "";
    let forwardedTerminalKind: "completed" | "error" | null = null;
    let interactionError: Error | null = null;
    const pendingInteractions: Promise<PromiseSettledResult<void>>[] = [];
    const interactionFailures: unknown[] = [];
    let executionFailure: { error: unknown } | undefined;
    let session: ReturnType<ThreadSessionManager["getOrCreate"]> | null = null;
    try {
      session = await this.withDatabase(() => this.deps.sessions.getOrCreate(runtime));
      const toolSession = session;
      const toolRegistry = buildRoleDraftSubmissionToolRegistry();
      const toolTransport = typeof toolSession.resolvePlatformToolTransport === "function"
        ? await this.withDatabase(() => toolSession.resolvePlatformToolTransport(toolRegistry, "required"))
        : "native-dynamic";
      if (toolTransport !== "native-dynamic") {
        throw serviceError(409, "TOOL_RESULT_REQUIRED", `当前 ${engine} 提供商未启用角色助手所需的真实工具提交流程，请检查该上游是否支持 dynamic tools。`);
      }

      this.deps.emitConversation({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        type: "turn.started",
        payload: { turnId },
      });
      this.deps.emitConversation({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        type: "item.userMessage.created",
        payload: {
          turnId,
          itemId: userItemId,
          text: promptMessages.userMessage,
        },
      });

      /** 保留交互中断真实结果，不用 finally 派生未处理拒绝。 */
      const trackInteraction = (promise: Promise<void>) => {
        pendingInteractions.push(promise.then(() => ({ status: "fulfilled", value: undefined }), reason => ({ status: "rejected", reason })));
      };
      /** 交互失败与中断失败分别保留，不能把中断失败改成正常等待。 */
      const abortOnInteractionError = async (error: Error) => {
        if (!interactionError) interactionError = error;
        try {
          const interrupted = await session!.interrupt(turnId);
          if (interrupted === false) throw new Error("资产交互中断未确认");
        } catch (cause) {
          throw Object.assign(new AggregateError([error, cause], "资产交互中断失败"), { code: "DESKTOP_UPDATE_ASSET_INTERRUPT_FAILED" });
        }
      };
      /** 等待已派发交互，失败作为同轮引擎失败向上交付。 */
      const waitForPendingInteractions = async () => {
        const results = await Promise.all(pendingInteractions.splice(0));
        for (const result of results) if (result.status === "rejected") interactionFailures.push(result.reason);
        if (interactionFailures.length) throw interactionFailures.length === 1 ? interactionFailures[0] : new AggregateError(interactionFailures, "资产交互处理失败");
      };

      await this.deps.flushLocalEvents?.(workspaceId, threadId);
      const result = await session!.sendMessage(
        {
          turnId,
          userItemId,
          text: promptMessages.userMessage,
          userMessage: promptMessages.userMessage,
          systemMessage: promptMessages.systemMessage,
          developerMessage: promptMessages.developerMessage,
          workMode: "general",
          images: [],
          assistantItemId,
          reasoningItemId,
          accessMode: "read-only",
          toolRegistryJson: JSON.stringify(toolRegistry),
          toolRegistry,
          platformToolTransportRequirement: "required",
          executeHostTool: async ({ toolId, toolInput }) => {
            if (String(toolId ?? "").trim() !== ROLE_DRAFT_SUBMIT_TOOL_ID) {
              return {
                ok: false,
                code: "TOOL_NOT_FOUND",
                message: `角色助手未注册工具：${toolId}`,
                output: {
                  toolId,
                  expectedToolId: ROLE_DRAFT_SUBMIT_TOOL_ID,
                },
              };
            }
            if (submittedDraftId) {
              return {
                ok: false,
                code: "TOOL_EXECUTION_FAILED",
                message: "当前任务已经成功提交过角色草案，不需要重复提交。",
                output: {
                  draftId: submittedDraftId,
                },
              };
            }

            try {
              this.assertRunAccepting(jobId);
              const payload = parseRoleDraftToolSubmission(toolInput, {
                mode: input.mode,
                targetAssetId: input.targetAssetId ?? null,
                baseVersionId: input.baseVersionId ?? null,
              });
              const validation = validateRoleDraft(payload, refs, payload.targetAssetId ?? null);
              if (validation.hasBlockingError) {
                return {
                  ok: false,
                  code: "SCHEMA_VALIDATION_FAILED",
                  message: [
                    "角色草案未通过平台校验。",
                    summarizeValidationIssues(validation.issues.filter((issue) => issue.blocking)),
                  ].join(" "),
                  output: {
                    issues: validation.issues,
                    blockingIssueCount: validation.blockingIssueCount,
                    warningCount: validation.warningCount,
                  },
                };
              }

              const draft = await this.withDatabase(() => this.persistSubmittedRoleDraft({
                jobId,
                request: input,
                payload,
                validation,
                engineInfo: { engine, model, effort },
              }));
              submittedDraftId = draft.id;
              return {
                ok: true,
                output: {
                  accepted: true,
                  draftId: draft.id,
                  warningCount: validation.warningCount,
                  warnings: validation.issues.filter((issue) => issue.severity === "warning"),
                },
              };
            } catch (error) {
              const normalized = error instanceof AssetDraftServiceError ? error : normalizeEngineError(error);
              return {
                ok: false,
                code: normalized.code,
                message: normalized.message,
                output: normalizeFailureDetails(normalized.details),
              };
            }
          },
          responseFormat: "text",
          model,
          effort,
          contextWindow,
          autoCompactPct,
          serviceTier,
          providerNativeToolPolicy: "allow",
          timeoutPolicy: this.deps.timeoutPolicy,
        },
        {
          flush: () => this.deps.flushLocalEvents?.(workspaceId, threadId) ?? Promise.resolve(),
          conversation: (event) => {
            const terminalKind = resolveTurnTerminalKind(event, turnId);
            if (terminalKind && assetDraftOwners(this.deps.db).get(jobId)?.stopping) return;
            if (terminalKind) {
              if (submittedDraftId && terminalKind === "error") {
                return;
              }
              if (forwardedTerminalKind) {
                return;
              }
              forwardedTerminalKind = terminalKind;
            }
            this.deps.emitConversation(event);
            if (event.type === "approval.request") {
              const approvalKind = String((event.payload as any)?.approvalKind ?? "").trim();
              if (approvalKind === "exitPlanMode") {
                trackInteraction(this.handleDraftApprovalRequest(session as any, event).catch(async (error) => {
                  const normalized = normalizeEngineError(error);
                  await abortOnInteractionError(normalized);
                  throw normalized;
                }));
              } else {
                const requestId = (event.payload as any)?.requestId;
                interactionRequest = {
                  kind: "approval",
                  reason: approvalKind === "enterPlanMode" ? "plan_mode_transition_required" : "approval_required",
                  requestId: requestId === undefined ? null : requestId,
                  header: approvalKind === "enterPlanMode" ? "需要退出计划模式后继续" : "需要人工确认后继续",
                  prompt: String((event.payload as any)?.message ?? "").trim() || "当前角色草案任务需要人工确认后才能继续。",
                  requestedAt: Date.now(),
                };
                trackInteraction((async () => {
                  await abortOnInteractionError(createAwaitingInputSignal(interactionRequest!));
                })());
              }
            } else if (event.type === "userInput.requested") {
              const payload = (event.payload as any) ?? {};
              const requestId = payload?.requestId;
              const questions = Array.isArray(payload?.questions) ? payload.questions as Array<Record<string, unknown>> : [];
              interactionRequest = {
                kind: "input",
                reason: questions.length > 0 ? "clarification_required" : "missing_user_input",
                requestId: requestId === undefined ? null : requestId,
                header: String(payload?.header ?? "需要补充信息").trim() || "需要补充信息",
                prompt: String(payload?.prompt ?? "").trim() || "请补充继续生成角色草案所需的信息。",
                requestedAt: Date.now(),
              };
              trackInteraction((async () => {
                await abortOnInteractionError(createAwaitingInputSignal(interactionRequest));
              })());
            }
          },
          raw: (event) => {
            this.deps.emitRaw(event);
          },
        },
      );
      await waitForPendingInteractions();
      this.assertRunAccepting(jobId);
      if (interactionRequest) {
        return {
          kind: "awaiting_input",
          engine,
          model,
          effort,
          threadId,
          interaction: interactionRequest,
        };
      }
      if (interactionError) {
        throw interactionError;
      }
      responseText = String(result?.responseText ?? "").trim();
      if (!forwardedTerminalKind) {
        forwardedTerminalKind = "completed";
        await emitTurnTerminalWithAssistantReconcile({
          session,
          turnId,
          outcome: "completed",
          emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
          buildTerminalEvent: (latestAssistantText) => ({
            ts: Date.now(),
            workspaceId,
            threadId,
            engine,
            type: "turn.completed",
            payload: {
              turnId,
              result: { responseText: latestAssistantText ?? responseText },
            },
          }),
        });
      }
      if (submittedDraftId) {
        return { kind: "submitted", engine, model, effort, threadId, responseText, draftId: submittedDraftId };
      }
      return { kind: "no_submission", engine, model, effort, threadId, responseText };
    } catch (error) {
      executionFailure = { error };
      const pending = await Promise.all(pendingInteractions.splice(0));
      for (const result of pending) if (result.status === "rejected") interactionFailures.push(result.reason);
      if (interactionFailures.length) throw new AggregateError([...new Set([error, ...interactionFailures])], "资产引擎或交互中断失败");
      if (assetDraftOwners(this.deps.db).get(jobId)?.stopping) throw error;
      if (interactionRequest && isTurnInterruptedError(error)) {
        return {
          kind: "awaiting_input",
          engine,
          model,
          effort,
          threadId,
          interaction: interactionRequest,
        };
      }
      if (submittedDraftId) {
        if (!forwardedTerminalKind) {
          forwardedTerminalKind = "completed";
          await emitTurnTerminalWithAssistantReconcile({
            session,
            turnId,
            outcome: "completed",
            emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
            buildTerminalEvent: (latestAssistantText) => ({
              ts: Date.now(),
              workspaceId,
              threadId,
              engine,
              type: "turn.completed",
              payload: {
                turnId,
                result: { responseText: latestAssistantText ?? responseText },
              },
            }),
          });
        }
        return {
          kind: "submitted",
          engine,
          model,
          effort,
          threadId,
          responseText,
          draftId: submittedDraftId,
        };
      }
      const normalized = normalizeEngineError(error);
      const metadata = extractTurnErrorMetadata(error);
      if (!forwardedTerminalKind) {
        forwardedTerminalKind = "error";
        await emitTurnTerminalWithAssistantReconcile({
          session,
          turnId,
          outcome: "error",
          emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
          buildTerminalEvent: () => createTurnErrorEventInput({
            ts: Date.now(),
            workspaceId,
            threadId,
            engine,
            turnId,
            error: normalized.message,
            code: normalized.code ?? metadata.code,
            terminationKind: metadata.terminationKind,
          }),
        });
      }
      throw normalized;
    } finally {
      try { await this.deps.flushLocalEvents?.(workspaceId, threadId); }
      catch (failure) { throw executionFailure ? new AggregateError([executionFailure.error, failure], "ASSET_DRAFT_EVENT_FLUSH_FAILED", { cause: executionFailure.error }) : failure; }
    }
  }

  /** 调用 Skill 助手引擎，按真实 system/developer/user 三层传入草案生成上下文。 */
  private async invokeSkillDraftEngine(
    jobId: AssetGenerationJobId,
    workspaceId: WorkspaceId,
    promptMessages: DraftPromptMessages,
    targetSkill: SkillDefinition | null,
    input: StoredSkillDraftJobRequest,
    refs: SkillReferenceContext,
    options: RoleDraftRunOptions = {},
  ): Promise<RoleDraftEngineInvocation> {
    await this.waitForRunAdmission(jobId);
    const reuseThreadId = nullableString(options.reuseThreadId) as ThreadId | null;
    const existingThread = reuseThreadId ? await this.withDatabase(() => this.deps.db.threads.get(reuseThreadId)) : null;
    if (reuseThreadId && !existingThread) {
      throw serviceError(404, "NOT_FOUND", `草案执行会话不存在：${reuseThreadId}`);
    }
    if (existingThread && existingThread.workspaceId !== workspaceId) {
      throw serviceError(409, "CONFLICT", "草案执行会话不属于当前工作区");
    }
    const engine = existingThread?.engine ?? resolveSkillDraftEngine(targetSkill, input);
    const defaultExecutionConfig = createDefaultRoleExecutionConfig(engine);
    const effectiveExecutionConfig = resolveRuntimeRoleExecutionConfigForEngine(
      defaultExecutionConfig,
      engine,
      engine,
    );
    const model = nullableString(input.enginePreference?.model) ?? effectiveExecutionConfig.model ?? null;
    const effort = nullableString(input.enginePreference?.effort) ?? effectiveExecutionConfig.effort ?? null;
    const contextWindow = input.enginePreference?.contextWindow ?? effectiveExecutionConfig.contextWindow ?? null;
    const autoCompactPct = input.enginePreference?.autoCompactPct ?? effectiveExecutionConfig.autoCompactPct ?? null;
    const serviceTier = input.enginePreference?.serviceTier ?? null;
    await this.withDatabase(() => assertClientReasoningEffortSupported(this.deps.db, engine, model, effort));
    const threadId = reuseThreadId ?? (`asset-draft-${crypto.randomUUID()}` as ThreadId);
    const title = existingThread?.title ?? (input.mode === "revise" ? "[Skill 草案] AI 优化 Skill" : "[Skill 草案] AI 创建 Skill");
    const turnId = `turn_${crypto.randomUUID()}` as TurnId;
    const userItemId = `item_user_${crypto.randomUUID()}`;
    const assistantItemId = `item_assistant_${crypto.randomUUID()}`;
    const reasoningItemId = `item_reasoning_${crypto.randomUUID()}`;
    await this.withDatabase(() => this.persistRunThread({ jobId, threadId, workspaceId, engine, title, model, effort, createThread: !existingThread }));
    const runtime = this.deps.threads.create({
      threadId,
      workspaceId,
      engine,
      title,
      sessionId: existingThread?.sessionId ?? undefined,
      sessionCapabilities: existingThread?.sessionCapabilities ?? undefined,
    });

    let interactionRequest: AssetGenerationInteractionRequest | null = null;
    let submittedDraftId: AssetDraftId | null = null;
    let responseText = "";
    let forwardedTerminalKind: "completed" | "error" | null = null;
    let interactionError: Error | null = null;
    const pendingInteractions: Promise<PromiseSettledResult<void>>[] = [];
    const interactionFailures: unknown[] = [];
    let executionFailure: { error: unknown } | undefined;
    let session: ReturnType<ThreadSessionManager["getOrCreate"]> | null = null;
    try {
      session = await this.withDatabase(() => this.deps.sessions.getOrCreate(runtime));
      const toolSession = session;
      const toolRegistry = buildSkillDraftSubmissionToolRegistry();
      const toolTransport = typeof toolSession.resolvePlatformToolTransport === "function"
        ? await this.withDatabase(() => toolSession.resolvePlatformToolTransport(toolRegistry, "required"))
        : "native-dynamic";
      if (toolTransport !== "native-dynamic") {
        throw serviceError(409, "TOOL_RESULT_REQUIRED", `当前 ${engine} 提供商未启用 Skill 助手所需的真实工具提交流程，请检查该上游是否支持 dynamic tools。`);
      }

      this.deps.emitConversation({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        type: "turn.started",
        payload: { turnId },
      });
      this.deps.emitConversation({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        type: "item.userMessage.created",
        payload: {
          turnId,
          itemId: userItemId,
          text: promptMessages.userMessage,
        },
      });

      /** Skill 与角色复用相同的交互结果收口合同。 */
      const trackInteraction = (promise: Promise<void>) => {
        pendingInteractions.push(promise.then(() => ({ status: "fulfilled", value: undefined }), reason => ({ status: "rejected", reason })));
      };
      /** 中断拒绝不能被人工等待请求覆盖。 */
      const abortOnInteractionError = async (error: Error) => {
        if (!interactionError) interactionError = error;
        try {
          const interrupted = await session!.interrupt(turnId);
          if (interrupted === false) throw new Error("资产交互中断未确认");
        } catch (cause) { throw Object.assign(new AggregateError([error, cause], "资产交互中断失败"), { code: "DESKTOP_UPDATE_ASSET_INTERRUPT_FAILED" }); }
      };
      /** 收齐所有已派发交互结果，不丢失提前完成的拒绝。 */
      const waitForPendingInteractions = async () => {
        const results = await Promise.all(pendingInteractions.splice(0));
        for (const result of results) if (result.status === "rejected") interactionFailures.push(result.reason);
        if (interactionFailures.length) throw interactionFailures.length === 1 ? interactionFailures[0] : new AggregateError(interactionFailures, "资产交互处理失败");
      };

      await this.deps.flushLocalEvents?.(workspaceId, threadId);
      const result = await session!.sendMessage(
        {
          turnId,
          userItemId,
          text: promptMessages.userMessage,
          userMessage: promptMessages.userMessage,
          systemMessage: promptMessages.systemMessage,
          developerMessage: promptMessages.developerMessage,
          workMode: "general",
          images: [],
          assistantItemId,
          reasoningItemId,
          accessMode: "read-only",
          toolRegistryJson: JSON.stringify(toolRegistry),
          toolRegistry,
          platformToolTransportRequirement: "required",
          executeHostTool: async ({ toolId, toolInput }) => {
            if (String(toolId ?? "").trim() !== SKILL_DRAFT_SUBMIT_TOOL_ID) {
              return {
                ok: false,
                code: "TOOL_NOT_FOUND",
                message: `Skill 助手未注册工具：${toolId}`,
                output: {
                  toolId,
                  expectedToolId: SKILL_DRAFT_SUBMIT_TOOL_ID,
                },
              };
            }
            if (submittedDraftId) {
              return {
                ok: false,
                code: "TOOL_EXECUTION_FAILED",
                message: "当前任务已经成功提交过 Skill 草案，不需要重复提交。",
                output: {
                  draftId: submittedDraftId,
                },
              };
            }

            try {
              this.assertRunAccepting(jobId);
              const payload = parseSkillDraftToolSubmission(toolInput, {
                mode: input.mode,
                targetAssetId: input.targetAssetId ?? null,
                baseVersionId: input.baseVersionId ?? null,
                baseDraft: input.workingDraft ?? (targetSkill ? skillToDraftDefinition(targetSkill) : null),
                selectedPaths: input.contextOptions.selectedPaths,
              });
              const validation = validateSkillDraft(payload, refs, payload.targetAssetId ?? null);
              if (validation.hasBlockingError) {
                return {
                  ok: false,
                  code: "SCHEMA_VALIDATION_FAILED",
                  message: [
                    "Skill 草案未通过平台校验。",
                    summarizeValidationIssues(validation.issues.filter((issue) => issue.blocking)),
                  ].join(" "),
                  output: {
                    issues: validation.issues,
                    blockingIssueCount: validation.blockingIssueCount,
                    warningCount: validation.warningCount,
                  },
                };
              }

              const draft = await this.withDatabase(() => this.persistSubmittedSkillDraft({
                jobId,
                request: input,
                payload,
                validation,
                engineInfo: { engine, model, effort },
              }));
              submittedDraftId = draft.id;
              return {
                ok: true,
                output: {
                  accepted: true,
                  draftId: draft.id,
                  warningCount: validation.warningCount,
                  warnings: validation.issues.filter((issue) => issue.severity === "warning"),
                },
              };
            } catch (error) {
              const normalized = error instanceof AssetDraftServiceError ? error : normalizeEngineError(error);
              return {
                ok: false,
                code: normalized.code,
                message: normalized.message,
                output: normalizeFailureDetails(normalized.details),
              };
            }
          },
          responseFormat: "text",
          model,
          effort,
          contextWindow,
          autoCompactPct,
          serviceTier,
          providerNativeToolPolicy: "allow",
          timeoutPolicy: this.deps.timeoutPolicy,
        },
        {
          flush: () => this.deps.flushLocalEvents?.(workspaceId, threadId) ?? Promise.resolve(),
          conversation: (event) => {
            const terminalKind = resolveTurnTerminalKind(event, turnId);
            if (terminalKind && assetDraftOwners(this.deps.db).get(jobId)?.stopping) return;
            if (terminalKind) {
              if (submittedDraftId && terminalKind === "error") {
                return;
              }
              if (forwardedTerminalKind) {
                return;
              }
              forwardedTerminalKind = terminalKind;
            }
            this.deps.emitConversation(event);
            if (event.type === "approval.request") {
              const approvalKind = String((event.payload as any)?.approvalKind ?? "").trim();
              if (approvalKind === "exitPlanMode") {
                trackInteraction(this.handleDraftApprovalRequest(session as any, event, "Skill").catch(async (error) => {
                  const normalized = normalizeEngineError(error);
                  await abortOnInteractionError(normalized);
                  throw normalized;
                }));
              } else {
                const requestId = (event.payload as any)?.requestId;
                interactionRequest = {
                  kind: "approval",
                  reason: approvalKind === "enterPlanMode" ? "plan_mode_transition_required" : "approval_required",
                  requestId: requestId === undefined ? null : requestId,
                  header: approvalKind === "enterPlanMode" ? "需要退出计划模式后继续" : "需要人工确认后继续",
                  prompt: String((event.payload as any)?.message ?? "").trim() || "当前 Skill 草案任务需要人工确认后才能继续。",
                  requestedAt: Date.now(),
                };
                trackInteraction((async () => {
                  await abortOnInteractionError(createAwaitingInputSignal(interactionRequest!));
                })());
              }
            } else if (event.type === "userInput.requested") {
              const payload = (event.payload as any) ?? {};
              const requestId = payload?.requestId;
              const questions = Array.isArray(payload?.questions) ? payload.questions as Array<Record<string, unknown>> : [];
              interactionRequest = {
                kind: "input",
                reason: questions.length > 0 ? "clarification_required" : "missing_user_input",
                requestId: requestId === undefined ? null : requestId,
                header: String(payload?.header ?? "需要补充信息").trim() || "需要补充信息",
                prompt: String(payload?.prompt ?? "").trim() || "请补充继续生成 Skill 草案所需的信息。",
                requestedAt: Date.now(),
              };
              trackInteraction((async () => {
                await abortOnInteractionError(createAwaitingInputSignal(interactionRequest));
              })());
            }
          },
          raw: (event) => {
            this.deps.emitRaw(event);
          },
        },
      );
      await waitForPendingInteractions();
      this.assertRunAccepting(jobId);
      if (interactionRequest) {
        return {
          kind: "awaiting_input",
          engine,
          model,
          effort,
          threadId,
          interaction: interactionRequest,
        };
      }
      if (interactionError) {
        throw interactionError;
      }
      responseText = String(result?.responseText ?? "").trim();
      if (!forwardedTerminalKind) {
        forwardedTerminalKind = "completed";
        await emitTurnTerminalWithAssistantReconcile({
          session,
          turnId,
          outcome: "completed",
          emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
          buildTerminalEvent: (latestAssistantText) => ({
            ts: Date.now(),
            workspaceId,
            threadId,
            engine,
            type: "turn.completed",
            payload: {
              turnId,
              result: { responseText: latestAssistantText ?? responseText },
            },
          }),
        });
      }
      if (submittedDraftId) {
        return { kind: "submitted", engine, model, effort, threadId, responseText, draftId: submittedDraftId };
      }
      return { kind: "no_submission", engine, model, effort, threadId, responseText };
    } catch (error) {
      executionFailure = { error };
      const pending = await Promise.all(pendingInteractions.splice(0));
      for (const result of pending) if (result.status === "rejected") interactionFailures.push(result.reason);
      if (interactionFailures.length) throw new AggregateError([...new Set([error, ...interactionFailures])], "资产引擎或交互中断失败");
      if (assetDraftOwners(this.deps.db).get(jobId)?.stopping) throw error;
      if (interactionRequest && isTurnInterruptedError(error)) {
        return {
          kind: "awaiting_input",
          engine,
          model,
          effort,
          threadId,
          interaction: interactionRequest,
        };
      }
      if (submittedDraftId) {
        if (!forwardedTerminalKind) {
          forwardedTerminalKind = "completed";
          await emitTurnTerminalWithAssistantReconcile({
            session,
            turnId,
            outcome: "completed",
            emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
            buildTerminalEvent: (latestAssistantText) => ({
              ts: Date.now(),
              workspaceId,
              threadId,
              engine,
              type: "turn.completed",
              payload: {
                turnId,
                result: { responseText: latestAssistantText ?? responseText },
              },
            }),
          });
        }
        return {
          kind: "submitted",
          engine,
          model,
          effort,
          threadId,
          responseText,
          draftId: submittedDraftId,
        };
      }
      const normalized = normalizeEngineError(error);
      const metadata = extractTurnErrorMetadata(error);
      if (!forwardedTerminalKind) {
        forwardedTerminalKind = "error";
        await emitTurnTerminalWithAssistantReconcile({
          session,
          turnId,
          outcome: "error",
          emitConversation: event => { this.assertRunAccepting(jobId); this.deps.emitConversation(event); },
          buildTerminalEvent: () => createTurnErrorEventInput({
            ts: Date.now(),
            workspaceId,
            threadId,
            engine,
            turnId,
            error: normalized.message,
            code: normalized.code ?? metadata.code,
            terminationKind: metadata.terminationKind,
          }),
        });
      }
      throw normalized;
    } finally {
      try { await this.deps.flushLocalEvents?.(workspaceId, threadId); }
      catch (failure) { throw executionFailure ? new AggregateError([executionFailure.error, failure], "ASSET_DRAFT_EVENT_FLUSH_FAILED", { cause: executionFailure.error }) : failure; }
    }
  }

  private requireWorkspacePath(workspaceId: WorkspaceId): string {
    const workspacePath = this.deps.workspaces.get(workspaceId);
    if (!workspacePath) throw serviceError(404, "NOT_FOUND", `未知 workspaceId：${workspaceId}`);
    return workspacePath;
  }

  private requireJob(workspaceId: WorkspaceId, jobId: AssetGenerationJobId): AssetGenerationJob {
    const job = this.deps.db.orchAssetGenerationJobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId) throw serviceError(404, "NOT_FOUND", `草案任务不存在：${jobId}`);
    return job;
  }

  private requireDraft(workspaceId: WorkspaceId, draftId: AssetDraftId): AssetDraft {
    const draft = this.deps.db.orchAssetDrafts.get(draftId);
    if (!draft || draft.workspaceId !== workspaceId) throw serviceError(404, "NOT_FOUND", `草案不存在：${draftId}`);
    return draft;
  }

  /** 原子准备下一轮请求；状态、请求快照、草案引用和事件必须一起提交。 */
  private prepareJobResume(input: {
    job: AssetGenerationJob;
    currentDraft: AssetDraft | null;
    requestJson: string;
    targetThreadId: ThreadId | null;
    progress: AssetGenerationProgress;
  }): void {
    this.assertTaskAdmission();
    if (assetDraftOwners(this.deps.db).has(input.job.id)) throw serviceError(409, "CONFLICT", "资产任务上一轮执行尚未释放");
    this.deps.db.db.transaction(() => {
      if (input.currentDraft?.status === "awaiting_review") {
        this.deps.db.orchAssetDrafts.updateStatus(input.currentDraft.id, "rejected");
      }
      const transition = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.job.id,
        [input.job.status],
        {
          status: "queued",
          progress: input.progress,
          draftId: null,
          requestJson: input.requestJson,
          interactionRequest: null,
          failure: null,
          threadId: input.targetThreadId,
        },
      );
      if (!transition) {
        throw serviceError(409, "CONFLICT", "任务状态已经变化，请重新加载后再试");
      }
      this.emitStatusChangedEvent(input.job.id, transition.previous.status, "queued", input.progress);
    })();
  }

  /** 原子创建或复用执行 thread，并把任务绑定到该 thread。 */
  private persistRunThread(input: {
    jobId: AssetGenerationJobId;
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    engine: "claude" | "codex";
    title: string;
    model: string | null;
    effort: string | null;
    createThread: boolean;
  }): void {
    this.assertRunAccepting(input.jobId);
    const job = this.deps.db.db.transaction(() => {
      if (input.createThread) {
        this.deps.db.threads.create({
          id: input.threadId,
          workspaceId: input.workspaceId,
          engine: input.engine,
          title: input.title,
          threadType: "orchestration",
          threadSubtype: "asset-draft",
        });
      }
      const transition = this.deps.db.orchAssetGenerationJobs.patchIfStatus(
        input.jobId,
        ["generating"],
        { threadId: input.threadId },
      );
      if (!transition) throw new AssetDraftRunObsoleteError(input.jobId);
      this.emitJobEvent(input.jobId, "orch.assetDraft.engineInvoked", {
        engine: input.engine,
        model: input.model,
        effort: input.effort,
        threadId: input.threadId,
      } satisfies AssetJobEngineInvokedPayload);
      return transition.current;
    })();
    const owner = assetDraftOwners(this.deps.db).get(input.jobId);
    if (owner) owner.job = job;
  }

  /** 把异步生成结果收口到待补充或失败；已取消任务只记录迟到回调，不覆盖终态。 */
  private settleRunFailure(job: AssetGenerationJob, error: unknown, assetLabel: "角色" | "Skill"): void {
    const jobId = job.id, requestId = job.clientRequestId ?? `asset-job:${jobId}`;
    if (error instanceof AssetDraftRunObsoleteError) {
      logAssetUpdateFailure(this.deps.db, error, requestId, job, "execution_stale", this.deps.db.orchAssetGenerationJobs.get(jobId)?.status ?? "deleted");
      return;
    }
    if (isAwaitingInputSignal(error)) {
      const interaction = parseAwaitingInputSignal(error);
      const progress = makeProgress("awaiting_input", interaction.header, interaction.prompt, 100);
      const transitioned = this.deps.db.db.transaction(() => {
        const result = this.deps.db.orchAssetGenerationJobs.patchIfStatus(jobId, EXECUTING_JOB_STATUSES, {
          status: "awaiting_input",
          progress,
          failure: null,
          interactionRequest: interaction,
        });
        if (!result) return false;
        this.emitStatusChangedEvent(jobId, result.previous.status, "awaiting_input", progress);
        return true;
      })();
      if (!transitioned) {
        logAssetUpdateFailure(this.deps.db, error, requestId, job, "execution_awaiting_input_stale", this.deps.db.orchAssetGenerationJobs.get(jobId)?.status ?? "deleted");
      }
      return;
    }

    logAssetUpdateFailure(this.deps.db, error, requestId, job, "execution_failed");
    const rawFailure = normalizeJobFailure(error);
    const failure = { ...rawFailure, message: redactClientStartupText(rawFailure.message) };
    const progress = makeProgress("failed", `${assetLabel}草案生成失败`, failure.message, 100);
    const transitioned = this.deps.db.db.transaction(() => {
      const result = this.deps.db.orchAssetGenerationJobs.patchIfStatus(jobId, EXECUTING_JOB_STATUSES, {
        status: "failed",
        progress,
        failure,
        interactionRequest: null,
      });
      if (!result) return false;
      this.emitStatusChangedEvent(jobId, result.previous.status, "failed", progress);
      this.emitJobEvent(jobId, "orch.assetDraft.failed", {
        code: failure.code,
        stage: failure.stage,
        retryable: failure.retryable,
        message: failure.message,
      } satisfies AssetJobFailedPayload);
      return true;
    })();
    if (!transitioned) {
      logAssetUpdateFailure(this.deps.db, error, requestId, job, "execution_failure_stale", this.deps.db.orchAssetGenerationJobs.get(jobId)?.status ?? "deleted");
    }
  }

  /** 按预期前态原子切换执行阶段；失败表示本轮已被取消或替换。 */
  private updateJobStatus(
    jobId: AssetGenerationJobId,
    status: AssetGenerationJobStatus,
    progress: AssetGenerationProgress,
    expectedStatuses: readonly AssetGenerationJobStatus[],
  ): void {
    this.assertRunAccepting(jobId);
    const transitioned = this.deps.db.db.transaction(() => {
      const result = this.deps.db.orchAssetGenerationJobs.patchIfStatus(jobId, expectedStatuses, { status, progress });
      if (!result) return false;
      this.emitStatusChangedEvent(jobId, result.previous.status, status, progress);
      return true;
    })();
    if (!transitioned) throw new AssetDraftRunObsoleteError(jobId);
  }

  /** 追加标准状态变更事件，调用方负责与状态写入置于同一事务。 */
  private emitStatusChangedEvent(
    jobId: AssetGenerationJobId,
    from: AssetGenerationJobStatus | null,
    to: AssetGenerationJobStatus,
    progress: AssetGenerationProgress,
  ): void {
    this.emitJobEvent(jobId, "orch.assetDraft.statusChanged", {
      from,
      to,
      headline: progress.headline,
      detail: progress.detail ?? null,
      percent: progress.percent ?? null,
    } satisfies AssetJobStatusChangedPayload);
  }

  private emitJobEvent(jobId: AssetGenerationJobId, type: AssetJobEventType, payload: AssetJobEventPayload | Record<string, unknown>): AssetJobEventRecord {
    return this.deps.db.orchAssetJobEvents.append({ jobId, type, payloadJson: JSON.stringify(payload ?? {}) });
  }

  private assertSelectedPathsValid(workspacePath: string, selectedPaths: string[]): void {
    for (const relPath of selectedPaths) resolveWorkspacePath(workspacePath, relPath);
  }

  private async handleDraftApprovalRequest(
    session: any,
    event: Extract<ConversationEventInput, { type: "approval.request" }>,
    assetLabel = "角色",
  ): Promise<void> {
    if (typeof session.respondApproval !== "function") {
      throw serviceError(502, "INTERNAL_ERROR", "当前引擎会话不支持 approval.respond");
    }
    const requestId = (event.payload as any)?.requestId;
    const approvalKind = String((event.payload as any)?.approvalKind ?? "").trim();
    if (approvalKind === "exitPlanMode") {
      await session.respondApproval(requestId, "accept", { choice: "yes-default-keep-context" });
      return;
    }
    await session.respondApproval(requestId, "decline", {
      note: `${assetLabel}草案生成需要在同一轮里直接调用平台工具提交结果，请不要进入计划模式或请求额外工具审批。`,
    });
  }
}

/** 构造角色助手三层消息，避免把平台协议和硬约束写入用户消息。 */
function buildRoleDraftPromptMessages(
  contextText: string,
  refs: RoleReferenceContext,
  targetRole: RoleDefinition | null,
  input: StoredRoleDraftJobRequest,
): DraftPromptMessages {
  return {
    systemMessage: buildRoleDraftSystemMessage(),
    developerMessage: buildRoleDraftDeveloperMessage(refs, targetRole, input),
    userMessage: buildRoleDraftUserMessage(contextText),
  };
}

/** 生成角色助手 system 层身份边界。 */
function buildRoleDraftSystemMessage(): string {
  return [
    "您是 CodeFlow 的角色助手。",
    "您负责帮助用户创建或优化软件工程 Agent/角色资产，并保持平台资产定义真实、可校验、可追溯。",
  ].join("\n");
}

/** 生成角色助手 developer 层执行契约、工具协议和提交骨架。 */
function buildRoleDraftDeveloperMessage(
  refs: RoleReferenceContext,
  targetRole: RoleDefinition | null,
  input: StoredRoleDraftJobRequest,
): string {
  const targetMessage = input.mode === "revise"
    ? `您正在优化已有角色${targetRole ? `「${targetRole.name}」` : ""}。请保留其核心职责，但让定义更清晰、更可执行。`
    : "您正在为一个软件工程工作区创建新角色。";
  return [
    "任务：根据上下文整理出一个完整的角色草案，并通过平台已注册的真实工具提交。",
    targetMessage,
    "硬约束：",
    `1. 当您准备好最终角色草案时，必须调用工具 ${ROLE_DRAFT_SUBMIT_TOOL_ID} 提交结果；不要把角色草案放在 assistant 文本里。`,
    "2. 如果信息不足，可以先请求用户补充；拿到补充信息后继续完成当前任务。",
    "3. draft 只能包含：name,description,responsibility,systemPrompt,inputDefinition,outputDefinition,gateCriteria,executionConfig,defaultKnowledgeBundleIds,toolRefs,kind。",
    "4. draft 中不能包含 id/workspaceId/createdAt/updatedAt；draft.kind 必须是 custom。",
    "5. inputDefinition / outputDefinition 必须使用统一新模型，不能输出 inputSchema/outputSchema/inputContracts/outputContracts。",
    "6. defaultKnowledgeBundleIds / toolRefs 只能引用上下文里真实存在的 ID；没有真实 ID 时必须留空，禁止沿用历史 ID 或编造 ID。",
    "7. 现有 Agent 不会作为默认参考；除正在优化的目标 Agent 外，不要在 referenceSummary.roleIds 填入 Agent ID。",
    "8. 如果认为需要新增知识库、工具集、Skill 或流程依赖，只能写入 rationale.keyDecisions/assumptions/risks 说明待创建内容，不要伪造 ID 或把建议内容写入正式依赖字段。",
    "9. inputDefinition.instructions 用自然语言写清规则；outputDefinition.instructions 只在 direct 交付时使用。requiredFields 只保留真正需要稳定字段名的项。",
    "10. 如果 outputDefinition.deliveryMode 是 file 或 file-set，必须把每个文件的内容要求或交付骨架写到 outputDefinition.files[*].description；filePathRule 只保留整体落地规则或旧角色兼容信息。",
    "11. executionConfig 必须一起给出 engine/model/accessMode；effort 仅在模型支持时填写，未知或不需要发送时可留空；Claude/Codex 角色都可选 autoCompactPct，上下文窗口由模型最大容量自动确定，不要配置 contextWindow。",
    "12. 新建 Agent 如果用户没有明确指定模型，必须保留上下文 executionConfig 中的最新默认模型，不要因为自身调用模型或历史经验改成旧模型；只有用户明确指定时才调整模型。优化已有 Agent 时保留用户当前模型。",
    "13. 允许您在成功调用工具后，再用一句自然语言总结这次角色草案的重点，但那只是补充说明，不算提交事实。",
    "",
    "提交工具时可参考下面的输入骨架：",
    JSON.stringify({
      draft: {
        name: "示例角色名",
        description: "角色简介",
        responsibility: "角色职责",
        systemPrompt: "系统提示词",
        inputDefinition: {
          instructions: "收到需求、上游方案和关键输入后，先提炼实现边界，再进入执行。",
          requiredFields: [
            {
              key: "designDocPath",
              label: "设计文档路径",
              valueType: "file-path",
              required: true,
              description: "开发前必须明确当前实现对应的设计文档位置",
              example: "docs/solution-plan.md",
            },
          ],
        },
        outputDefinition: {
          instructions: [
            "请输出 Markdown。",
            "必须交代修改文件、核心改动、验证结果和遗留风险。",
            "建议结构：",
            "# 修改文件",
            "# 实现说明",
            "# 测试结果",
            "# 风险与待确认项",
          ].join("\n"),
          deliveryMode: "direct",
          format: "markdown",
          resultKey: "implementation-report",
          filePathRule: null,
          files: [],
          requiredFields: [
            {
              key: "changedFiles",
              label: "修改文件清单",
              valueType: "text",
              required: true,
              description: "列出本轮真实修改过的文件",
              example: "src/index.ts, tests/index.test.ts",
            },
          ],
        },
        gateCriteria: [],
        executionConfig: createDefaultRoleExecutionConfig(targetRole?.executionConfig.preferredEngine ?? "codex"),
        defaultKnowledgeBundleIds: [],
        toolRefs: [],
        kind: "custom",
      },
      rationale: {
        summary: "为什么这样设计",
        keyDecisions: ["关键决策 1", "关键决策 2"],
        assumptions: [],
        risks: [],
      },
      referenceSummary: {
        roleIds: resolveRoleDraftReferenceRoleIds(input.mode, targetRole),
        knowledgeBundleIds: refs.knowledgeBundles.map((item) => item.id),
        toolsetIds: refs.toolsets.map((item) => item.id),
        selectedPaths: input.contextOptions?.selectedPaths ?? [],
      },
    }, null, 2),
  ].join("\n");
}

/** 生成角色助手 user 层上下文，只保留用户目标和可参考资产摘要。 */
function buildRoleDraftUserMessage(contextText: string): string {
  return [
    "请基于下面上下文生成或更新角色草案。",
    "",
    "上下文：",
    contextText || "(无补充上下文)",
  ].join("\n").trim();
}

/** 只把当前优化目标计入角色引用，避免创建 Agent 时把全量 Agent 当默认上下文。 */
function resolveRoleDraftReferenceRoleIds(mode: "create" | "revise", targetRole: RoleDefinition | null): RoleId[] {
  const targetRoleId = nullableString(targetRole?.id) as RoleId | null;
  return mode === "revise" && targetRoleId ? [targetRoleId] : [];
}

/** 生成角色助手重试消息，保留同一 developer 契约并只在 user 层说明失败上下文。 */
function buildRoleDraftSubmissionRecoveryMessages(input: {
  input: StoredRoleDraftJobRequest;
  refs: RoleReferenceContext;
  targetRole: RoleDefinition | null;
  previousResponseText: string;
  retryReason: string | null;
}): DraftPromptMessages {
  return {
    systemMessage: buildRoleDraftSystemMessage(),
    developerMessage: buildRoleDraftDeveloperMessage(input.refs, input.targetRole, input.input),
    userMessage: [
      "上一轮没有完成角色草案提交，请纠正后重试。",
      `当前模式：${input.input.mode}`,
      `失败原因：${input.retryReason ? "上一轮没有通过平台提交流程完成角色草案。" : "当前回合没有完成平台提交流程。"}`,
      "",
      "上一轮 assistant 文本：",
      input.previousResponseText || "(empty)",
    ].filter(Boolean).join("\n"),
  };
}

/** 构造 Skill 助手三层消息，支持完整草案和局部 patch 的同一提交契约。 */
function buildSkillDraftPromptMessages(
  contextText: string,
  refs: SkillReferenceContext,
  targetSkill: SkillDefinition | null,
  input: StoredSkillDraftJobRequest,
): DraftPromptMessages {
  return {
    systemMessage: buildSkillDraftSystemMessage(),
    developerMessage: buildSkillDraftDeveloperMessage(refs, targetSkill, input),
    userMessage: buildSkillDraftUserMessage(contextText),
  };
}

/** 生成 Skill 助手 system 层身份边界。 */
function buildSkillDraftSystemMessage(): string {
  return [
    "您是 CodeFlow 的 Skills 助手。",
    "您负责帮助用户创建或优化可复用 Skill，并保持 Skill 包结构、脚本入口和适用引擎可校验。",
  ].join("\n");
}

/** 生成 Skill 助手 developer 层执行契约、增量 patch 协议和提交骨架。 */
function buildSkillDraftDeveloperMessage(
  refs: SkillReferenceContext,
  targetSkill: SkillDefinition | null,
  input: StoredSkillDraftJobRequest,
): string {
  const targetMessage = input.mode === "revise"
    ? `您正在优化已有 Skill${targetSkill ? `「${targetSkill.name}」` : ""}。请优先用 patches 增量修改字段、文件或脚本。`
    : "您正在为软件工程工作区创建一个可复用 Skill。";
  return [
    "任务：根据上下文整理出 Skill 候选草案，并通过平台已注册的真实工具提交。",
    targetMessage,
    "硬约束：",
    `1. 当您准备好候选草案时，必须调用工具 ${SKILL_DRAFT_SUBMIT_TOOL_ID}；不要把草案放在 assistant 文本里。`,
    "2. 工具支持 draft 与 patches；只改局部字段、脚本或文件时优先提交 patches，平台会合并为完整候选草案。",
    "3. 允许生成 shell/node/python 脚本内容，但当前助手阶段只保存草案，不执行脚本。",
    "4. files 只能包含 SKILL.md、setup.mjs、requirements.txt、manifest.txt、templates/、providers/、scripts/、references/、assets/ 或 agents/openai.yaml；脚本入口必须指向 scripts/ 下的文件。",
    "5. inputSchema/outputSchema 如填写必须是合法 JSON 字符串。",
    "6. targetEngines/installTargets 只能使用 codex 或 claude。",
    "7. 如果信息不足，可以先请求用户补充；拿到补充信息后继续完成当前任务。",
    "",
    "提交工具示例：",
    JSON.stringify({
      draft: {
        name: "代码审查 Skill",
        slug: "code-review",
        description: "在代码变更后执行结构化审查。",
        trigger: "用户要求审查代码或提交前检查时使用。",
        instructions: "先读取变更，再按风险、缺陷和测试缺口输出结论。",
        targetEngines: ["codex"],
        tags: ["review"],
        skillMd: "---\nname: code-review\ndescription: Structured code review\n---\n# Code Review\n\nFollow repository rules and report findings first.",
        files: [{
          relPath: "SKILL.md",
          kind: "skill-md",
          contentText: "---\nname: code-review\ndescription: Structured code review\n---\n# Code Review",
        }],
        scripts: [],
        installTargets: ["codex"],
      },
      patches: [{
        op: "upsert-file",
        file: {
          relPath: "scripts/check.mjs",
          kind: "script",
          contentText: "console.log('check')",
        },
      }, {
        op: "upsert-script",
        script: {
          id: "check",
          name: "检查脚本",
          description: "执行 Skill 辅助检查",
          scriptPath: "scripts/check.mjs",
          runtime: "node",
          exposeAsTool: true,
        },
      }],
      rationale: {
        summary: "为什么这样设计",
        keyDecisions: ["关键决策 1"],
        assumptions: [],
        risks: [],
      },
      referenceSummary: {
        skillIds: refs.skills.map((item) => item.id),
        selectedPaths: input.contextOptions.selectedPaths ?? [],
      },
    }, null, 2),
  ].join("\n");
}

/** 生成 Skill 助手 user 层上下文，只保留用户目标和可参考 Skill 摘要。 */
function buildSkillDraftUserMessage(contextText: string): string {
  return [
    "请基于下面上下文生成或更新 Skill 草案。",
    "",
    "上下文：",
    contextText || "(无补充上下文)",
  ].join("\n").trim();
}

/** 生成 Skill 助手重试消息，保留同一 developer 契约并只在 user 层说明失败上下文。 */
function buildSkillDraftSubmissionRecoveryMessages(input: {
  input: StoredSkillDraftJobRequest;
  refs: SkillReferenceContext;
  targetSkill: SkillDefinition | null;
  previousResponseText: string;
  retryReason: string | null;
}): DraftPromptMessages {
  return {
    systemMessage: buildSkillDraftSystemMessage(),
    developerMessage: buildSkillDraftDeveloperMessage(input.refs, input.targetSkill, input.input),
    userMessage: [
      "上一轮没有完成 Skill 草案提交，请纠正后重试。",
      `当前模式：${input.input.mode}`,
      `失败原因：${input.retryReason ? "上一轮没有通过平台提交流程完成 Skill 草案。" : "当前回合没有完成平台提交流程。"}`,
      "",
      "上一轮 assistant 文本：",
      input.previousResponseText || "(empty)",
    ].filter(Boolean).join("\n"),
  };
}

function resolveTurnTerminalKind(
  event: { type?: string; payload?: unknown } | null | undefined,
  turnId: TurnId,
): "completed" | "error" | null {
  const type = String(event?.type ?? "").trim();
  if (type !== "turn.completed" && type !== "turn.error") return null;
  const eventTurnId = String((event?.payload as any)?.turnId ?? "").trim();
  if (eventTurnId && eventTurnId !== String(turnId)) return null;
  return type === "turn.completed" ? "completed" : "error";
}

function buildRoleDraftSubmissionToolRegistry(): ExecutableToolRegistry {
  return {
    tools: [{
      toolsetId: ROLE_DRAFT_TOOLSET_ID as ToolsetId,
      toolsetName: "内建角色助手",
      toolId: ROLE_DRAFT_SUBMIT_TOOL_ID as any,
      name: "提交角色草案",
      alias: null,
      description: "把当前轮整理好的角色草案正式提交给平台。平台会立即做结构和语义校验；通过后这份草案就会进入待审核/待回填状态。",
      runtime: "builtin",
      usageGuidance: "只有当角色草案已经完整可用时才调用。调用成功就代表业务结果已经提交；assistant 后续的自然语言总结只是附加说明，不会替代这次提交。",
      invocationHint: [
        "{",
        '  "draft": { "name": "测试工程师", "description": "..." },',
        '  "rationale": { "summary": "为什么这样设计", "keyDecisions": [], "assumptions": [], "risks": [] },',
        '  "referenceSummary": { "roleIds": [], "knowledgeBundleIds": [], "toolsetIds": [], "selectedPaths": [] }',
        "}",
      ].join("\n"),
      code: "",
      inputSchema: JSON.stringify({
        type: "object",
        required: ["draft"],
        properties: {
          draft: { type: "object" },
          rationale: { type: "object" },
          referenceSummary: { type: "object" },
        },
      }),
      outputSchema: JSON.stringify({
        type: "object",
        required: ["accepted", "draftId", "warningCount"],
        properties: {
          accepted: { type: "boolean" },
          draftId: { type: "string" },
          warningCount: { type: "number" },
        },
      }),
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: true,
    }],
  };
}

function buildSkillDraftSubmissionToolRegistry(): ExecutableToolRegistry {
  return {
    tools: [{
      toolsetId: ROLE_DRAFT_TOOLSET_ID as ToolsetId,
      toolsetName: "内建 Skills 助手",
      toolId: SKILL_DRAFT_SUBMIT_TOOL_ID as any,
      name: "提交 Skill 草案或增量补丁",
      alias: null,
      description: "把当前轮整理好的 Skill 草案或增量 patch 提交给平台。平台会合并 patch、校验文件和脚本入口，通过后进入待审核状态。",
      runtime: "builtin",
      usageGuidance: "只在 Skill 草案已经可用时调用。局部修改请提交 patches；脚本内容只保存为草案，不会在助手生成阶段执行。",
      invocationHint: [
        "{",
        '  "draft": { "name": "代码审查 Skill", "targetEngines": ["codex"] },',
        '  "patches": [{ "op": "set", "path": "instructions", "value": "..." }],',
        '  "rationale": { "summary": "为什么这样设计", "keyDecisions": [], "assumptions": [], "risks": [] },',
        '  "referenceSummary": { "skillIds": [], "selectedPaths": [] }',
        "}",
      ].join("\n"),
      code: "",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          draft: { type: "object" },
          patches: { type: "array" },
          rationale: { type: "object" },
          referenceSummary: { type: "object" },
        },
      }),
      outputSchema: JSON.stringify({
        type: "object",
        required: ["accepted", "draftId", "warningCount"],
        properties: {
          accepted: { type: "boolean" },
          draftId: { type: "string" },
          warningCount: { type: "number" },
        },
      }),
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: true,
    }],
  };
}

function parseRoleDraftToolSubmission(
  rawInput: unknown,
  overrides: { mode: "create" | "revise"; targetAssetId?: RoleId | null; baseVersionId?: string | null },
): RoleDraftPayload {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw serviceError(400, "BAD_REQUEST", "角色草案提交工具参数必须是对象");
  }
  const record = rawInput as Record<string, unknown>;
  assertNoExtraKeys(record, new Set(["draft", "rationale", "referenceSummary"]), "BAD_REQUEST", "角色草案提交工具参数含未知字段");
  const mode = overrides.mode;
  return {
    assetKind: "role",
    schemaVersion: ROLE_DRAFT_SCHEMA_VERSION,
    mode,
    targetAssetId: mode === "revise" ? (overrides.targetAssetId ?? null) : null,
    baseVersionId: mode === "revise" ? (nullableString(overrides.baseVersionId) ?? null) : null,
    draft: normalizeRoleDraftDefinition(record.draft, { defaultLatestModel: mode === "create" }),
    rationale: normalizeRationale(record.rationale),
    referenceSummary: normalizeReferenceSummary(record.referenceSummary),
  };
}

function parseRoleDraftPayload(
  rawText: string,
  overrides?: { mode?: "create" | "revise"; targetAssetId?: RoleId | null; baseVersionId?: string | null },
): RoleDraftPayload {
  const candidate = extractJsonObject(rawText);
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw serviceError(502, "STRUCTURED_PARSE_FAILED", "引擎返回内容不是合法 JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  assertNoExtraKeys(parsed, new Set([
    "assetKind",
    "schemaVersion",
    "mode",
    "targetAssetId",
    "baseVersionId",
    "draft",
    "rationale",
    "referenceSummary",
  ]), "STRUCTURED_PARSE_FAILED", "角色草案 JSON 含未知顶层字段");
  if (parsed?.assetKind !== "role") throw serviceError(502, "STRUCTURED_PARSE_FAILED", "角色草案 JSON 的 assetKind 必须为 role");
  if (parsed?.schemaVersion !== ROLE_DRAFT_SCHEMA_VERSION) throw serviceError(502, "STRUCTURED_PARSE_FAILED", "角色草案 JSON 的 schemaVersion 不正确");

  const mode = overrides?.mode ?? (parsed?.mode === "revise" ? "revise" : "create");
  return {
    assetKind: "role",
    schemaVersion: ROLE_DRAFT_SCHEMA_VERSION,
    mode,
    targetAssetId: mode === "revise" ? (overrides?.targetAssetId ?? nullableString(parsed?.targetAssetId)) : null,
    baseVersionId: mode === "revise" ? (nullableString(overrides?.baseVersionId) ?? nullableString(parsed?.baseVersionId)) : null,
    draft: normalizeRoleDraftDefinition(parsed?.draft, { defaultLatestModel: mode === "create" }),
    rationale: normalizeRationale(parsed?.rationale),
    referenceSummary: normalizeReferenceSummary(parsed?.referenceSummary),
  };
}

function parseSkillDraftToolSubmission(
  rawInput: unknown,
  overrides: {
    mode: "create" | "revise";
    targetAssetId?: SkillId | null;
    baseVersionId?: string | null;
    baseDraft?: SkillDraftPayload["draft"] | null;
    selectedPaths?: string[] | null;
  },
): SkillDraftPayload {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw serviceError(400, "BAD_REQUEST", "Skill 草案提交工具参数必须是对象");
  }
  const record = rawInput as Record<string, unknown>;
  assertNoExtraKeys(record, new Set(["draft", "patches", "rationale", "referenceSummary"]), "BAD_REQUEST", "Skill 草案提交工具参数含未知字段");
  const mode = overrides.mode;
  const base = overrides.baseDraft ?? createDefaultSkillDraftDefinition();
  const initial = normalizeSkillDraftDefinition({ ...base, ...(isPlainRecord(record.draft) ? record.draft : {}) });
  const patches = normalizeSkillDraftPatches(record.patches);
  const draft = normalizeSkillDraftDefinition(applySkillDraftPatches(initial, patches));
  return {
    assetKind: "skill",
    schemaVersion: SKILL_DRAFT_SCHEMA_VERSION,
    mode,
    targetAssetId: mode === "revise" ? (overrides.targetAssetId ?? null) : null,
    baseVersionId: mode === "revise" ? (nullableString(overrides.baseVersionId) ?? null) : null,
    draft,
    patches,
    rationale: normalizeSkillRationale(record.rationale),
    referenceSummary: normalizeSkillReferenceSummary(record.referenceSummary, overrides.selectedPaths ?? []),
  };
}

function parseSkillDraftPayload(rawText: string): SkillDraftPayload {
  const candidate = extractJsonObject(rawText);
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw serviceError(502, "STRUCTURED_PARSE_FAILED", "Skill 草案内容不是合法 JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  assertNoExtraKeys(parsed, new Set([
    "assetKind",
    "schemaVersion",
    "mode",
    "targetAssetId",
    "baseVersionId",
    "draft",
    "patches",
    "rationale",
    "referenceSummary",
  ]), "STRUCTURED_PARSE_FAILED", "Skill 草案 JSON 含未知顶层字段");
  if (parsed?.assetKind !== "skill") throw serviceError(502, "STRUCTURED_PARSE_FAILED", "Skill 草案 JSON 的 assetKind 必须为 skill");
  if (parsed?.schemaVersion !== SKILL_DRAFT_SCHEMA_VERSION) throw serviceError(502, "STRUCTURED_PARSE_FAILED", "Skill 草案 JSON 的 schemaVersion 不正确");
  const mode = parsed?.mode === "revise" ? "revise" : "create";
  return {
    assetKind: "skill",
    schemaVersion: SKILL_DRAFT_SCHEMA_VERSION,
    mode,
    targetAssetId: mode === "revise" ? (nullableString(parsed?.targetAssetId) as SkillId | null) : null,
    baseVersionId: mode === "revise" ? nullableString(parsed?.baseVersionId) : null,
    draft: normalizeSkillDraftDefinition(parsed?.draft),
    patches: normalizeSkillDraftPatches(parsed?.patches),
    rationale: normalizeSkillRationale(parsed?.rationale),
    referenceSummary: normalizeSkillReferenceSummary(parsed?.referenceSummary, []),
  };
}

function normalizeSkillDraftDefinition(raw: any): SkillDraftPayload["draft"] {
  const base = isPlainRecord(raw) ? raw : {};
  const name = String(base.name ?? "").trim();
  const description = String(base.description ?? "").trim();
  const trigger = String(base.trigger ?? "").trim();
  const instructions = String(base.instructions ?? "").trim();
  const slug = nullableString(base.slug) ?? normalizeSkillSlug(name || "skill");
  const targetEngines = normalizeSkillTargetEngines(base.targetEngines, ["codex"]);
  const skillMd = typeof base.skillMd === "string"
    ? base.skillMd.replace(/\r\n/g, "\n")
    : buildDefaultSkillMd({ name, slug, description, trigger, instructions });
  const files = normalizeSkillDraftFiles(base.files, { name, slug, description, trigger, instructions, skillMd });
  const normalizedSkillMd = files.find((file) => file.relPath === "SKILL.md")?.contentText ?? skillMd;
  const scripts = normalizeSkillDraftScripts(base.scripts, files);
  return {
    name,
    slug,
    description,
    trigger,
    instructions,
    targetEngines,
    tags: dedupeStrings(base.tags),
    packageVersion: Number.isFinite(Number(base.packageVersion)) ? Number(base.packageVersion) : 1,
    skillMd: normalizedSkillMd,
    files,
    scripts,
    installTargets: normalizeSkillTargetEngines(base.installTargets, targetEngines),
    kind: "custom",
    packageHash: null,
  };
}

function createDefaultSkillDraftDefinition(): SkillDraftPayload["draft"] {
  return normalizeSkillDraftDefinition({
    name: "新 Skill",
    slug: "new-skill",
    description: "",
    trigger: "",
    instructions: "",
    targetEngines: ["codex"],
    tags: [],
    files: [],
    scripts: [],
    installTargets: ["codex"],
  });
}

function applySkillDraftPatches(
  base: SkillDraftPayload["draft"],
  patches: NonNullable<SkillDraftPayload["patches"]>,
): SkillDraftPayload["draft"] {
  let next: SkillDraftPayload["draft"] = { ...base, files: [...(base.files ?? [])], scripts: [...(base.scripts ?? [])] };
  for (const patch of patches) {
    if (patch.op === "set") {
      next = normalizeSkillDraftDefinition({ ...next, [patch.path]: patch.value });
    } else if (patch.op === "unset") {
      const copy: Record<string, unknown> = { ...next };
      delete copy[patch.path];
      next = normalizeSkillDraftDefinition(copy);
    } else if (patch.op === "upsert-file") {
      const file = normalizeSkillDraftFile(patch.file);
      if (!file) continue;
      next = normalizeSkillDraftDefinition({
        ...next,
        skillMd: file.relPath === "SKILL.md" ? file.contentText ?? next.skillMd : next.skillMd,
        files: upsertByKey(next.files ?? [], file, (item) => item.relPath),
      });
    } else if (patch.op === "delete-file") {
      const relPath = normalizeSkillFilePath(patch.relPath, false);
      if (!relPath || relPath === "SKILL.md") continue;
      next = normalizeSkillDraftDefinition({
        ...next,
        files: (next.files ?? []).filter((file) => file.relPath !== relPath),
        scripts: (next.scripts ?? []).filter((script) => script.scriptPath !== relPath),
      });
    } else if (patch.op === "upsert-script") {
      const scriptPath = normalizeSkillFilePath(patch.script.scriptPath, true);
      if (!scriptPath) continue;
      const files = patch.contentText != null
        ? upsertByKey(next.files ?? [], createSkillTextFile(scriptPath, "script", patch.contentText), (item) => item.relPath)
        : next.files ?? [];
      const script = normalizeSkillDraftScript(patch.script, files);
      next = normalizeSkillDraftDefinition({
        ...next,
        files,
        scripts: script ? upsertByKey(next.scripts ?? [], script, (item) => item.id) : next.scripts,
      });
    } else if (patch.op === "delete-script") {
      const id = nullableString(patch.id);
      const scriptPath = nullableString(patch.scriptPath);
      next = normalizeSkillDraftDefinition({
        ...next,
        scripts: (next.scripts ?? []).filter((script) => {
          if (id && script.id === id) return false;
          if (scriptPath && script.scriptPath === scriptPath) return false;
          return true;
        }),
      });
    }
  }
  return next;
}

function normalizeSkillDraftPatches(raw: unknown): NonNullable<SkillDraftPayload["patches"]> {
  if (!Array.isArray(raw)) return [];
  const result: NonNullable<SkillDraftPayload["patches"]> = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const op = String(item.op ?? "").trim();
    if (op === "set") {
      const path = String(item.path ?? "").trim();
      if (isSkillSetPath(path)) result.push({ op, path, value: item.value });
    } else if (op === "unset") {
      const path = String(item.path ?? "").trim();
      if (isSkillUnsetPath(path)) result.push({ op, path });
    } else if (op === "upsert-file") {
      const file = normalizeSkillDraftFile(item.file);
      if (file) result.push({ op, file });
    } else if (op === "delete-file") {
      const relPath = normalizeSkillFilePath(item.relPath, false);
      if (relPath) result.push({ op, relPath });
    } else if (op === "upsert-script") {
      const rawScript = isPlainRecord(item.script) ? item.script : {};
      const scriptPath = normalizeSkillFilePath(rawScript.scriptPath, true);
      const script = normalizeSkillDraftScript({ ...rawScript, scriptPath }, []);
      if (script) result.push({ op, script, contentText: typeof item.contentText === "string" ? item.contentText : null });
    } else if (op === "delete-script") {
      result.push({ op, id: nullableString(item.id), scriptPath: nullableString(item.scriptPath) });
    }
  }
  return result;
}

function isSkillSetPath(pathValue: string): pathValue is "name" | "slug" | "description" | "trigger" | "instructions" | "targetEngines" | "tags" | "installTargets" | "skillMd" {
  return pathValue === "name"
    || pathValue === "slug"
    || pathValue === "description"
    || pathValue === "trigger"
    || pathValue === "instructions"
    || pathValue === "targetEngines"
    || pathValue === "tags"
    || pathValue === "installTargets"
    || pathValue === "skillMd";
}

function isSkillUnsetPath(pathValue: string): pathValue is "slug" | "tags" | "installTargets" | "skillMd" {
  return pathValue === "slug" || pathValue === "tags" || pathValue === "installTargets" || pathValue === "skillMd";
}

function normalizeSkillDraftFiles(
  raw: unknown,
  fallback: { name: string; slug: string; description: string; trigger: string; instructions: string; skillMd?: string | null },
): SkillPackageFile[] {
  const files = new Map<string, SkillPackageFile>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const file = normalizeSkillDraftFile(item);
      if (file) files.set(file.relPath, file);
    }
  }
  const skillMdText = String(fallback.skillMd ?? buildDefaultSkillMd(fallback)).replace(/\r\n/g, "\n");
  const currentSkillMd = files.get("SKILL.md");
  files.set("SKILL.md", currentSkillMd
    ? { ...currentSkillMd, kind: "skill-md", contentText: String(currentSkillMd.contentText ?? skillMdText), contentBase64: null, contentType: "text/markdown" }
    : createSkillTextFile("SKILL.md", "skill-md", skillMdText));
  return [...files.values()].sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function normalizeSkillDraftFile(raw: unknown): SkillPackageFile | null {
  if (!isPlainRecord(raw)) return null;
  const relPath = normalizeSkillFilePath(raw.relPath, false);
  if (!relPath) return null;
  const text = typeof raw.contentText === "string" ? raw.contentText.replace(/\r\n/g, "\n") : null;
  const base64 = typeof raw.contentBase64 === "string" && raw.contentBase64.trim() ? raw.contentBase64.trim() : null;
  const sizeBytes = text != null ? Buffer.byteLength(text, "utf8") : Buffer.byteLength(base64 ?? "", "base64");
  return {
    relPath,
    kind: normalizeSkillFileKind(raw.kind, relPath),
    contentText: text,
    contentBase64: text == null ? base64 : null,
    contentType: String(raw.contentType ?? inferSkillContentType(relPath)).trim() || inferSkillContentType(relPath),
    sizeBytes,
    sha256: hashSkillFileContent(text, base64),
  };
}

function normalizeSkillDraftScripts(raw: unknown, files: SkillPackageFile[]): SkillScriptEntrypoint[] {
  if (!Array.isArray(raw)) return [];
  const result: SkillScriptEntrypoint[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const script = normalizeSkillDraftScript(item, files);
    if (!script || seen.has(script.id)) continue;
    seen.add(script.id);
    result.push(script);
  }
  return result;
}

function normalizeSkillDraftScript(raw: unknown, files: SkillPackageFile[]): SkillScriptEntrypoint | null {
  void files;
  if (!isPlainRecord(raw)) return null;
  const scriptPath = normalizeSkillFilePath(raw.scriptPath, true);
  if (!scriptPath || !scriptPath.startsWith("scripts/")) return null;
  const id = normalizeSkillScriptId(raw.id ?? scriptPath);
  if (!id) return null;
  return {
    id,
    name: String(raw.name ?? id).trim() || id,
    description: String(raw.description ?? "").trim(),
    scriptPath,
    runtime: normalizeSkillScriptRuntime(raw.runtime, scriptPath),
    inputSchema: typeof raw.inputSchema === "string" ? raw.inputSchema.trim() || null : null,
    outputSchema: typeof raw.outputSchema === "string" ? raw.outputSchema.trim() || null : null,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) ? Math.max(1_000, Number(raw.timeoutMs)) : null,
    requiresWrite: Boolean(raw.requiresWrite),
    exposeAsTool: Boolean(raw.exposeAsTool),
  };
}

/** 规整 Skill 草案包文件路径，并按场景校验脚本入口目录。 */
function normalizeSkillFilePath(value: unknown, requireScript: boolean): string | null {
  const rel = String(value ?? "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw serviceError(400, "BAD_REQUEST", `Skill 文件路径非法：${rel}`);
  }
  const normalized = parts.join("/");
  if (!isAllowedSkillPackagePath(normalized)) {
    throw serviceError(400, "BAD_REQUEST", `Skill 文件只能位于 SKILL.md、setup.mjs、requirements.txt、manifest.txt、templates/、providers/、scripts/、references/、assets/ 或 agents/openai.yaml：${normalized}`);
  }
  if (requireScript && !normalized.startsWith("scripts/")) {
    throw serviceError(400, "BAD_REQUEST", `Skill 脚本入口必须位于 scripts/：${normalized}`);
  }
  return normalized;
}

/** 判断 Skill 草案包文件路径是否落在平台支持的安装包目录内。 */
function isAllowedSkillPackagePath(normalized: string): boolean {
  return normalized === "SKILL.md"
    || normalized === "setup.mjs"
    || normalized === "requirements.txt"
    || normalized === "manifest.txt"
    || normalized === "agents/openai.yaml"
    || normalized.startsWith("templates/")
    || normalized.startsWith("providers/")
    || normalized.startsWith("scripts/")
    || normalized.startsWith("references/")
    || normalized.startsWith("assets/");
}

/** 按文件路径补齐 Skill 草案包文件类型，避免候选草案缺少 kind。 */
function normalizeSkillFileKind(value: unknown, relPath: string): SkillPackageFileKind {
  const kind = String(value ?? "").trim();
  if (kind === "skill-md" || kind === "script" || kind === "reference" || kind === "asset" || kind === "metadata") return kind;
  if (relPath === "SKILL.md") return "skill-md";
  if (relPath === "setup.mjs") return "script";
  if (relPath.startsWith("scripts/")) return "script";
  if (relPath.startsWith("references/")) return "reference";
  if (relPath.startsWith("templates/") || relPath.startsWith("providers/")) return "reference";
  if (relPath.startsWith("assets/")) return "asset";
  return "metadata";
}

function normalizeSkillTargetEngines(raw: unknown, fallback: SkillTargetEngine[]): SkillTargetEngine[] {
  const source = Array.isArray(raw) ? raw : fallback;
  const result = [...new Set(source.map((item) => String(item).trim()).filter((item) => item === "codex" || item === "claude"))] as SkillTargetEngine[];
  return result.length ? result : fallback;
}

function normalizeSkillScriptRuntime(value: unknown, scriptPath: string): SkillScriptEntrypoint["runtime"] {
  const raw = String(value ?? "").trim();
  if (raw === "python" || raw === "node" || raw === "shell") return raw;
  if (scriptPath.endsWith(".py")) return "python";
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs") || scriptPath.endsWith(".cjs")) return "node";
  return "shell";
}

function normalizeSkillScriptId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^scripts\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function createSkillTextFile(relPath: string, kind: SkillPackageFileKind, content: string): SkillPackageFile {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  return {
    relPath,
    kind,
    contentText: text,
    contentBase64: null,
    contentType: inferSkillContentType(relPath),
    sizeBytes: Buffer.byteLength(text, "utf8"),
    sha256: hashSkillFileContent(text, null),
  };
}

function hashSkillFileContent(text: string | null | undefined, base64: string | null | undefined): string {
  const hash = crypto.createHash("sha256");
  if (text != null) hash.update(text, "utf8");
  else if (base64) hash.update(Buffer.from(base64, "base64"));
  return hash.digest("hex");
}

function inferSkillContentType(relPath: string): string {
  if (relPath.endsWith(".md")) return "text/markdown";
  if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) return "text/yaml";
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".py")) return "text/x-python";
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")) return "text/javascript";
  if (relPath.endsWith(".sh") || relPath.endsWith(".ps1")) return "text/x-shellscript";
  return "application/octet-stream";
}

function normalizeSkillRationale(raw: any): SkillDraftPayload["rationale"] {
  if (!raw || typeof raw !== "object") return { summary: "", keyDecisions: [], assumptions: [], risks: [] };
  return {
    summary: String(raw.summary ?? "").trim(),
    keyDecisions: Array.isArray(raw.keyDecisions) ? raw.keyDecisions.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
  };
}

function normalizeSkillReferenceSummary(raw: any, selectedPaths: string[]): SkillDraftPayload["referenceSummary"] {
  if (!raw || typeof raw !== "object") return { skillIds: [], selectedPaths };
  return {
    skillIds: dedupeStrings(raw.skillIds) as SkillId[],
    selectedPaths: dedupeStrings(raw.selectedPaths).length ? dedupeStrings(raw.selectedPaths) : selectedPaths,
  };
}

function upsertByKey<T>(items: T[], nextItem: T, keyOf: (item: T) => string): T[] {
  const key = keyOf(nextItem);
  const result = items.filter((item) => keyOf(item) !== key);
  result.push(nextItem);
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRoleDraftDefinition(raw: any, options?: { defaultLatestModel?: boolean }) {
  if (!raw || typeof raw !== "object") throw serviceError(502, "STRUCTURED_PARSE_FAILED", "角色草案缺少 draft 对象");
  assertNoExtraKeys(raw, new Set([
    "name",
    "description",
    "responsibility",
    "systemPrompt",
    "inputDefinition",
    "outputDefinition",
    "gateCriteria",
    "executionConfig",
    "defaultKnowledgeBundleIds",
    "toolRefs",
    "kind",
  ]), "STRUCTURED_PARSE_FAILED", "draft 中含未知字段");
  const executionConfig = sanitizeDraftExecutionConfig(normalizeExecutionConfig(raw.executionConfig));
  return {
    name: String(raw.name ?? "").trim(),
    description: String(raw.description ?? "").trim(),
    responsibility: nullableString(raw.responsibility),
    systemPrompt: String(raw.systemPrompt ?? "").trim(),
    inputDefinition: sanitizeDraftInputDefinition(normalizeRoleInputDefinition(raw.inputDefinition)),
    outputDefinition: sanitizeDraftOutputDefinition(normalizeRoleOutputDefinition(raw.outputDefinition)),
    gateCriteria: normalizeGateCriteria(raw.gateCriteria),
    executionConfig: options?.defaultLatestModel
      ? applyLatestModelToNewRoleExecutionConfig(executionConfig)
      : executionConfig,
    defaultKnowledgeBundleIds: dedupeStrings(raw.defaultKnowledgeBundleIds) as KnowledgeBundleId[],
    toolRefs: normalizeToolRefs(raw.toolRefs),
    kind: "custom" as const,
  };
}

function normalizeGateCriteria(raw: any): GateCriterion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const type = String(item?.type ?? "").trim();
    return {
      id: String(item?.id ?? `gate-${index + 1}`).trim() || `gate-${index + 1}`,
      label: String(item?.label ?? `门禁 ${index + 1}`).trim() || `门禁 ${index + 1}`,
      type: type === "ai" || type === "json-schema" ? type : "regex",
      config: String(item?.config ?? ""),
      blocking: item?.blocking !== false,
    };
  });
}

function normalizeExecutionConfig(raw: any): RoleExecutionConfig {
  return normalizeRoleExecutionConfig(raw, raw?.preferredEngine === "claude" ? "claude" : "codex");
}

/** 新建 Agent 使用当前目录默认模型；优化已有 Agent 时由调用方保留原配置。 */
function applyLatestModelToNewRoleExecutionConfig(config: RoleExecutionConfig): RoleExecutionConfig {
  const engineProfiles = { ...config.engineProfiles };
  for (const engine of ["claude", "codex"] as const) {
    const profile = engineProfiles[engine];
    const defaultModel = resolveRuntimeRoleExecutionConfigForEngine(
      createDefaultRoleExecutionConfig(engine),
      engine,
      engine,
    ).model;
    if (profile.mode !== "custom" || !profile.customConfig || !defaultModel) continue;
    engineProfiles[engine] = {
      ...profile,
      customConfig: { ...profile.customConfig, model: defaultModel },
    };
  }
  return { ...config, engineProfiles };
}

function normalizeToolRefs(raw: any): ToolRef[] {
  if (!Array.isArray(raw)) return [];
  const result: ToolRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const toolsetId = nullableString((item as Record<string, unknown>).toolsetId) as ToolsetId | null;
    const toolId = nullableString((item as Record<string, unknown>).toolId);
    if (!toolsetId || !toolId) continue;
    const key = `${toolsetId}::${toolId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ toolsetId, toolId });
  }
  return result;
}

function normalizeRationale(raw: any): RoleDraftPayload["rationale"] {
  if (!raw || typeof raw !== "object") return { summary: "", keyDecisions: [], assumptions: [], risks: [] };
  return {
    summary: String(raw.summary ?? "").trim(),
    keyDecisions: Array.isArray(raw.keyDecisions) ? raw.keyDecisions.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
  };
}

function normalizeReferenceSummary(raw: any): RoleDraftPayload["referenceSummary"] {
  if (!raw || typeof raw !== "object") return { roleIds: [], knowledgeBundleIds: [], toolsetIds: [], selectedPaths: [] };
  return {
    roleIds: dedupeStrings(raw.roleIds) as RoleId[],
    knowledgeBundleIds: dedupeStrings(raw.knowledgeBundleIds) as KnowledgeBundleId[],
    toolsetIds: dedupeStrings(raw.toolsetIds) as ToolsetId[],
    selectedPaths: dedupeStrings(raw.selectedPaths),
  };
}

function validateRoleDraft(payload: RoleDraftPayload, refs: RoleReferenceContext, targetRoleId: RoleId | null): ValidationResult {
  const issues: AssetValidationIssue[] = [];
  const draft = payload.draft;
  if (!draft.name) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.name", "角色名称不能为空", "请提供明确的角色名称"));
  if (!draft.description) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.description", "角色描述不能为空", "请补充角色简介"));
  if (!draft.systemPrompt) issues.push(blockingIssue("EMPTY_SYSTEM_PROMPT", "draft.systemPrompt", "系统提示词不能为空", "请补充该角色的系统提示词"));
  if (!draft.executionConfig.preferredEngine) {
    issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.executionConfig.preferredEngine", "默认执行引擎不能为空"));
  }
  const enabledEngines = Object.entries(draft.executionConfig.engineProfiles ?? {})
    .filter(([, profile]) => profile?.enabled)
    .map(([engine]) => engine);
  if (!enabledEngines.length) {
    issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.executionConfig.engineProfiles", "至少启用一个执行引擎"));
  }
  if (draft.executionConfig.preferredEngine && !enabledEngines.includes(draft.executionConfig.preferredEngine)) {
    issues.push(blockingIssue("INVALID_EXECUTION_CONFIG", "draft.executionConfig.preferredEngine", "默认执行引擎必须是已启用引擎"));
  }
  for (const engine of ["claude", "codex"] as const) {
    const profile = draft.executionConfig.engineProfiles?.[engine];
    if (!profile) {
      issues.push(blockingIssue("REQUIRED_FIELD_MISSING", `draft.executionConfig.engineProfiles.${engine}`, `缺少 ${engine} 引擎配置`));
      continue;
    }
    if (!profile.enabled || profile.mode !== "custom") continue;
    const custom = profile.customConfig;
    if (!custom) {
      issues.push(blockingIssue("REQUIRED_FIELD_MISSING", `draft.executionConfig.engineProfiles.${engine}.customConfig`, `缺少 ${engine} 自定义执行配置`));
      continue;
    }
    if (!custom.model?.trim()) {
      issues.push(blockingIssue("REQUIRED_FIELD_MISSING", `draft.executionConfig.engineProfiles.${engine}.customConfig.model`, "角色模型不能为空"));
    }
    if (!custom.accessMode) {
      issues.push(blockingIssue("REQUIRED_FIELD_MISSING", `draft.executionConfig.engineProfiles.${engine}.customConfig.accessMode`, "角色访问模式不能为空"));
    }
    if (custom.autoCompactPct != null) {
      if (custom.autoCompactPct < 50 || custom.autoCompactPct > 99) {
        issues.push(blockingIssue("INVALID_EXECUTION_CONFIG", `draft.executionConfig.engineProfiles.${engine}.customConfig.autoCompactPct`, "自动压缩阈值必须在 50 到 99 之间"));
      }
    }
    if (custom.contextWindow != null && custom.contextWindow <= 0) {
      issues.push(blockingIssue("INVALID_EXECUTION_CONFIG", `draft.executionConfig.engineProfiles.${engine}.customConfig.contextWindow`, "上下文窗口必须是正整数"));
    }
  }
  if (!draft.inputDefinition.instructions.trim() && draft.inputDefinition.requiredFields.length === 0) {
    issues.push(warningIssue("INPUT_DEFINITION_TOO_WEAK", "draft.inputDefinition", "输入定义过弱，角色可能拿不到稳定的输入约束"));
  }
  const outputFileConfigs = draft.outputDefinition.files ?? [];
  if (draft.outputDefinition.deliveryMode === "direct") {
    if (!draft.outputDefinition.instructions.trim() && draft.outputDefinition.requiredFields.length === 0) {
      issues.push(warningIssue("OUTPUT_DEFINITION_TOO_WEAK", "draft.outputDefinition", "直接输出缺少正文要求，角色结果可能缺少稳定格式或交付骨架"));
    }
  } else {
    if (!outputFileConfigs.length) {
      issues.push(warningIssue("OUTPUT_FILES_MISSING", "draft.outputDefinition.files", "文件交付未配置任何交付项，角色无法知道每个文件该交付什么"));
    } else if (!outputFileConfigs.some((item) => String(item.description ?? "").trim()) && draft.outputDefinition.requiredFields.length === 0) {
      issues.push(warningIssue("OUTPUT_FILE_DESCRIPTION_MISSING", "draft.outputDefinition.files", "文件交付缺少每个文件的内容要求或交付骨架，角色可能只知道路径不知道写什么"));
    }
  }
  if (draft.outputDefinition.deliveryMode === "file" && outputFileConfigs.length > 1) {
    issues.push(blockingIssue("SINGLE_FILE_OUTPUT_HAS_MULTIPLE_FILES", "draft.outputDefinition.files", "单文件交付不能同时配置多个交付项", "如果确实需要多份文件，请把 deliveryMode 改成 file-set"));
  }
  if (
    draft.outputDefinition.deliveryMode !== "direct"
    && !String(draft.outputDefinition.filePathRule ?? "").trim()
    && !outputFileConfigs.some((item) => String(item.pathRule ?? "").trim())
  ) {
    issues.push(warningIssue("OUTPUT_FILE_RULE_MISSING", "draft.outputDefinition.files", "文件输出未提供整体规则或单项路径规则，后续角色可能无法稳定生成落地路径"));
  }
  for (const gate of draft.gateCriteria) {
    if (!isValidGateType(gate.type)) issues.push(blockingIssue("INVALID_GATE_CRITERION_TYPE", `draft.gateCriteria.${gate.id}.type`, "门禁类型不合法"));
  }
  for (const bundleId of draft.defaultKnowledgeBundleIds) {
    if (!refs.knowledgeBundleById.has(bundleId)) {
      issues.push(blockingIssue("UNKNOWN_KNOWLEDGE_BUNDLE", "draft.defaultKnowledgeBundleIds", `引用的知识库不存在：${bundleId}`, "请选择当前工作区内已有的知识库"));
    }
  }
  for (const ref of draft.toolRefs) {
    const toolset = refs.toolsetById.get(ref.toolsetId);
    if (!toolset) {
      issues.push(blockingIssue("UNKNOWN_TOOLSET", "draft.toolRefs", `引用的工具集不存在：${ref.toolsetId}`, "请选择当前工作区内已有的工具集"));
      continue;
    }
    if (!toolset.tools.some((tool) => tool.id === ref.toolId)) {
      issues.push(blockingIssue("UNKNOWN_TOOL", "draft.toolRefs", `工具集 ${toolset.name} 中不存在工具：${ref.toolId}`, "请检查工具 ID 是否正确"));
    }
  }
  const normalizedName = draft.name.trim().toLowerCase();
  const duplicated = refs.roles.find((role) => role.id !== targetRoleId && role.name.trim().toLowerCase() === normalizedName);
  if (normalizedName && duplicated) {
    issues.push(blockingIssue("DUPLICATE_ROLE_NAME", "draft.name", `角色名称与现有角色重复：${duplicated.name}`, "请更换一个更明确的角色名称"));
  }
  const selectedTools = resolveSelectedTools(draft.toolRefs, refs.toolsetById);
  if (selectedTools.some(({ tool }) => tool.requiresWrite)) {
    issues.push(warningIssue("TOOL_REQUIREMENTS_BROAD", "draft.toolRefs", "角色绑定的工具包含工作区写入能力，请确认这是必要的"));
  }
  if (hasDuplicateRoleFields(draft.inputDefinition.requiredFields)) {
    issues.push(blockingIssue("DUPLICATE_INPUT_FIELD_KEY", "draft.inputDefinition.requiredFields", "输入定义里存在重复字段 key", "请为每个输入字段设置唯一 key"));
  }
  if (hasDuplicateRoleFields(draft.outputDefinition.requiredFields)) {
    issues.push(blockingIssue("DUPLICATE_OUTPUT_FIELD_KEY", "draft.outputDefinition.requiredFields", "输出定义里存在重复字段 key", "请为每个输出字段设置唯一 key"));
  }
  const blockingIssueCount = issues.filter((issue) => issue.blocking).length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return { issues, blockingIssueCount, warningCount, hasBlockingError: blockingIssueCount > 0 };
}

function validateSkillDraft(payload: SkillDraftPayload, refs: SkillReferenceContext, targetSkillId: SkillId | null): ValidationResult {
  const issues: AssetValidationIssue[] = [];
  const draft = payload.draft;
  if (!draft.name) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.name", "Skill 名称不能为空", "请提供明确的 Skill 名称"));
  if (!draft.description) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.description", "Skill 描述不能为空", "请补充 Skill 简介"));
  if (!draft.trigger) issues.push(warningIssue("TRIGGER_TOO_WEAK", "draft.trigger", "Skill 触发条件为空，运行时可能难以判断何时使用"));
  if (!draft.instructions) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.instructions", "Skill 指令不能为空", "请补充 Skill 的执行说明"));
  if (!draft.targetEngines.length) issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.targetEngines", "至少选择一个适用引擎"));
  const skillMdFile = (draft.files ?? []).find((file) => file.relPath === "SKILL.md");
  if (!skillMdFile || !String(skillMdFile.contentText ?? draft.skillMd ?? "").trim()) {
    issues.push(blockingIssue("REQUIRED_FIELD_MISSING", "draft.files.SKILL.md", "Skill 包必须包含 SKILL.md"));
  }
  const filePaths = new Set((draft.files ?? []).map((file) => file.relPath));
  for (const file of draft.files ?? []) {
    if (!file.relPath) issues.push(blockingIssue("INVALID_SKILL_FILE", "draft.files", "Skill 文件路径不能为空"));
    if (!isAllowedSkillPackagePath(file.relPath)) {
      issues.push(blockingIssue("INVALID_SKILL_FILE", "draft.files", `Skill 文件路径不合法：${file.relPath}`));
    }
  }
  const scriptIds = new Set<string>();
  for (const script of draft.scripts ?? []) {
    if (scriptIds.has(script.id)) {
      issues.push(blockingIssue("DUPLICATE_SCRIPT_ID", "draft.scripts", `脚本入口 ID 重复：${script.id}`));
    }
    scriptIds.add(script.id);
    if (!script.scriptPath.startsWith("scripts/") || !filePaths.has(script.scriptPath)) {
      issues.push(blockingIssue("UNKNOWN_SCRIPT_FILE", "draft.scripts", `脚本入口指向的文件不存在：${script.scriptPath}`, "请先通过 upsert-file 创建 scripts/ 下的脚本文件"));
    }
    if (script.inputSchema && !isValidJsonText(script.inputSchema)) {
      issues.push(blockingIssue("INVALID_JSON_SCHEMA", `draft.scripts.${script.id}.inputSchema`, `脚本 ${script.name} 的输入 Schema 不是合法 JSON`));
    }
    if (script.outputSchema && !isValidJsonText(script.outputSchema)) {
      issues.push(blockingIssue("INVALID_JSON_SCHEMA", `draft.scripts.${script.id}.outputSchema`, `脚本 ${script.name} 的输出 Schema 不是合法 JSON`));
    }
  }
  const normalizedName = draft.name.trim().toLowerCase();
  const normalizedSlug = String(draft.slug ?? "").trim().toLowerCase();
  const duplicated = refs.skills.find((skill) => {
    if (skill.id === targetSkillId) return false;
    const sameName = normalizedName && skill.name.trim().toLowerCase() === normalizedName;
    const sameSlug = normalizedSlug && String(skill.slug ?? "").trim().toLowerCase() === normalizedSlug;
    return sameName || sameSlug;
  });
  if (duplicated) {
    issues.push(blockingIssue("DUPLICATE_SKILL_NAME", "draft.name", `Skill 名称或 slug 与现有 Skill 重复：${duplicated.name}`, "请更换更明确的名称或 slug"));
  }
  const blockingIssueCount = issues.filter((issue) => issue.blocking).length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return { issues, blockingIssueCount, warningCount, hasBlockingError: blockingIssueCount > 0 };
}

function buildRoleDraftComparison(
  baseRole: RoleDefinition | null,
  payload: RoleDraftPayload,
  refs: RoleReferenceContext,
  issues: AssetValidationIssue[],
): RoleDraftComparison {
  const after = payload.draft;
  const sections: RoleDraftDiffSection[] = [
    makeDiffSection("basic", "基本", [
      diffPrimitive("draft.name", "角色名称", baseRole?.name ?? null, after.name, "text"),
      diffPrimitive("draft.description", "描述", baseRole?.description ?? null, after.description, "text"),
      diffPrimitive("draft.responsibility", "职责", baseRole?.responsibility ?? null, after.responsibility ?? null, "long-text"),
      diffPrimitive("draft.systemPrompt", "系统提示词", baseRole?.systemPrompt ?? null, after.systemPrompt, "long-text"),
    ]),
    makeDiffSection("io", "输入/输出", [
      diffJson("draft.inputDefinition", "输入定义", sanitizeDraftInputDefinition(baseRole?.inputDefinition), sanitizeDraftInputDefinition(after.inputDefinition)),
      diffJson("draft.outputDefinition", "输出定义", sanitizeDraftOutputDefinition(baseRole?.outputDefinition), sanitizeDraftOutputDefinition(after.outputDefinition)),
    ]),
    makeDiffSection("gates", "门禁", [
      diffJson("draft.gateCriteria", "门禁规则", baseRole?.gateCriteria ?? [], after.gateCriteria ?? []),
    ]),
    makeDiffSection("knowledge", "知识库", [
      diffRefList("draft.defaultKnowledgeBundleIds", "默认知识库", baseRole?.defaultKnowledgeBundleIds ?? [], after.defaultKnowledgeBundleIds ?? [], refs.knowledgeBundleById),
    ]),
    makeDiffSection("tools", "工具", [
      diffToolRefs("draft.toolRefs", "可用工具", baseRole?.toolRefs ?? [], after.toolRefs ?? [], refs.toolsetById),
    ]),
    makeDiffSection("config", "配置", [
      diffJson("draft.executionConfig", "执行配置", sanitizeExecutionConfig(baseRole?.executionConfig), sanitizeExecutionConfig(after.executionConfig)),
      diffPrimitive("draft.kind", "角色类型", baseRole?.kind ?? null, after.kind, "enum"),
    ]),
  ].filter((section) => section.items.length > 0);

  const summary = sections.reduce(
    (acc, section) => {
      for (const item of section.items) {
        if (item.changeType === "added") acc.added += 1;
        else if (item.changeType === "removed") acc.removed += 1;
        else if (item.changeType === "modified") acc.modified += 1;
      }
      return acc;
    },
    { added: 0, removed: 0, modified: 0, warnings: issues.filter((item) => item.severity === "warning").length },
  );

  return {
    mode: payload.mode,
    targetRoleId: payload.targetAssetId ?? null,
    baseVersionId: payload.baseVersionId ?? null,
    hasChanges: summary.added + summary.removed + summary.modified > 0,
    summary,
    sections,
  };
}

function buildSkillDraftComparison(
  baseSkill: SkillDefinition | null,
  payload: SkillDraftPayload,
  issues: AssetValidationIssue[],
): SkillDraftComparison {
  const after = payload.draft;
  const sections: SkillDraftDiffSection[] = [
    makeSkillDiffSection("overview", "概览", [
      diffPrimitive("draft.name", "Skill 名称", baseSkill?.name ?? null, after.name, "text"),
      diffPrimitive("draft.slug", "slug", baseSkill?.slug ?? null, after.slug ?? null, "text"),
      diffPrimitive("draft.description", "描述", baseSkill?.description ?? null, after.description, "text"),
      diffPrimitive("draft.trigger", "触发条件", baseSkill?.trigger ?? null, after.trigger, "long-text"),
      diffPrimitive("draft.instructions", "执行指令", baseSkill?.instructions ?? null, after.instructions, "long-text"),
    ]),
    makeSkillDiffSection("content", "SKILL.md", [
      diffPrimitive("draft.skillMd", "SKILL.md", baseSkill?.skillMd ?? null, after.skillMd ?? null, "long-text"),
    ]),
    makeSkillDiffSection("files", "文件", [
      diffJson("draft.files", "包文件", sanitizeSkillFiles(baseSkill?.files), sanitizeSkillFiles(after.files)),
    ]),
    makeSkillDiffSection("scripts", "脚本", [
      diffJson("draft.scripts", "脚本入口", baseSkill?.scripts ?? [], after.scripts ?? []),
    ]),
    makeSkillDiffSection("install", "安装", [
      diffJson("draft.targetEngines", "适用引擎", baseSkill?.targetEngines ?? [], after.targetEngines ?? []),
      diffJson("draft.installTargets", "安装目标", baseSkill?.installTargets ?? [], after.installTargets ?? []),
      diffJson("draft.tags", "标签", baseSkill?.tags ?? [], after.tags ?? []),
    ]),
  ].filter((section) => section.items.length > 0);

  const summary = sections.reduce(
    (acc, section) => {
      for (const item of section.items) {
        if (item.changeType === "added") acc.added += 1;
        else if (item.changeType === "removed") acc.removed += 1;
        else if (item.changeType === "modified") acc.modified += 1;
      }
      return acc;
    },
    { added: 0, removed: 0, modified: 0, warnings: issues.filter((item) => item.severity === "warning").length },
  );

  return {
    mode: payload.mode,
    targetSkillId: payload.targetAssetId ?? null,
    baseVersionId: payload.baseVersionId ?? null,
    hasChanges: summary.added + summary.removed + summary.modified > 0,
    summary,
    sections,
  };
}

function makeDiffSection(key: RoleDraftDiffSection["key"], label: string, items: Array<RoleDraftDiffItem | null>): RoleDraftDiffSection {
  const filtered = items.filter(Boolean) as RoleDraftDiffItem[];
  return {
    key,
    label,
    changeCount: filtered.filter((item) => item.changeType !== "unchanged").length,
    items: filtered,
  };
}

function makeSkillDiffSection(key: SkillDraftDiffSection["key"], label: string, items: Array<RoleDraftDiffItem | null>): SkillDraftDiffSection {
  const filtered = items.filter(Boolean) as RoleDraftDiffItem[];
  return {
    key,
    label,
    changeCount: filtered.filter((item) => item.changeType !== "unchanged").length,
    items: filtered,
  };
}

function diffPrimitive(
  fieldPath: string,
  label: string,
  beforeValue: unknown,
  afterValue: unknown,
  valueType: RoleDraftDiffItem["valueType"],
  beforeLabel?: string | null,
  afterLabel?: string | null,
): RoleDraftDiffItem | null {
  if (sameValue(beforeValue, afterValue) && sameValue(beforeLabel, afterLabel)) return null;
  return {
    path: fieldPath,
    label,
    valueType,
    changeType: diffType(beforeValue, afterValue),
    beforeValue,
    afterValue,
    beforeLabel: beforeLabel ?? null,
    afterLabel: afterLabel ?? null,
  };
}

function diffJson(fieldPath: string, label: string, beforeValue: unknown, afterValue: unknown): RoleDraftDiffItem | null {
  if (sameValue(beforeValue, afterValue)) return null;
  return {
    path: fieldPath,
    label,
    valueType: "json",
    changeType: diffType(beforeValue, afterValue),
    beforeValue,
    afterValue,
  };
}

function diffRefList<T extends { name: string }>(
  fieldPath: string,
  label: string,
  beforeIds: string[],
  afterIds: string[],
  refMap: Map<string, T>,
): RoleDraftDiffItem | null {
  if (sameValue(beforeIds, afterIds)) return null;
  return {
    path: fieldPath,
    label,
    valueType: "ref-list",
    changeType: diffType(beforeIds, afterIds),
    beforeValue: beforeIds,
    afterValue: afterIds,
    beforeLabel: beforeIds.map((id) => refMap.get(id)?.name ?? id).join(" / "),
    afterLabel: afterIds.map((id) => refMap.get(id)?.name ?? id).join(" / "),
  };
}

function diffToolRefs(
  fieldPath: string,
  label: string,
  beforeRefs: ToolRef[],
  afterRefs: ToolRef[],
  toolsetById: Map<ToolsetId, ToolsetDefinition>,
): RoleDraftDiffItem | null {
  if (sameValue(beforeRefs, afterRefs)) return null;
  return {
    path: fieldPath,
    label,
    valueType: "ref-list",
    changeType: diffType(beforeRefs, afterRefs),
    beforeValue: beforeRefs,
    afterValue: afterRefs,
    beforeLabel: beforeRefs.map((ref) => resolveToolRefLabel(ref, toolsetById)).join(" / "),
    afterLabel: afterRefs.map((ref) => resolveToolRefLabel(ref, toolsetById)).join(" / "),
  };
}

function toAssetJobEventView(event: AssetJobEventRecord): AssetJobEventView {
  return {
    id: event.id,
    jobId: event.jobId,
    type: event.type,
    payload: safeParseJson<AssetJobEventPayload>(event.payloadJson, {} as AssetJobEventPayload),
    createdAt: event.createdAt,
  };
}

function normalizeJobFailure(error: unknown): AssetGenerationFailure {
  if (error instanceof AssetDraftServiceError) {
    return {
      code: error.code,
      stage: inferFailureStage(error.code),
      message: error.message,
      userHint: extractUserHint(error.details),
      retryable: isRetryableError(error.code),
      details: normalizeFailureDetails(error.details),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL_ERROR",
    stage: "generating",
    message,
    userHint: null,
    retryable: false,
    details: null,
  };
}

function normalizeEngineError(error: unknown): AssetDraftServiceError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AssetDraftServiceError) return error;
  if ((error as { code?: unknown } | null)?.code === "dynamic_tool_transport_unsupported") {
    return serviceError(
      409,
      "TOOL_RESULT_REQUIRED",
      "当前 Codex 上游不支持 dynamic tools，角色助手又已禁用 JSON 文本回退，因此本次无法继续。请升级 api-relay/openai 以透传 tools，或切换到支持 tools 的 Codex provider。",
      {
        engineMessage: message || null,
        baseUrl: readEngineConfig("codex").baseUrl ?? null,
      },
    );
  }
  if (/timeout/i.test(message)) return serviceError(504, "ENGINE_TIMEOUT", "引擎生成角色草案超时", { engineMessage: message });
  return serviceError(503, "ENGINE_UNAVAILABLE", message || "引擎当前不可用");
}

function createAwaitingInputSignal(interaction: AssetGenerationInteractionRequest): AssetDraftServiceError {
  return serviceError(409, "CONFLICT", interaction.prompt || interaction.header, {
    awaitingInput: true,
    interaction,
  });
}

function isAwaitingInputSignal(error: unknown): boolean {
  return Boolean((error as { details?: { awaitingInput?: unknown } } | null)?.details?.awaitingInput);
}

function parseAwaitingInputSignal(error: unknown): AssetGenerationInteractionRequest {
  const interaction = (error as { details?: { interaction?: AssetGenerationInteractionRequest } } | null)?.details?.interaction;
  if (!interaction) {
    return {
      kind: "input",
      reason: "missing_user_input",
      requestId: null,
      header: "需要补充信息",
      prompt: "请补充继续生成角色草案所需的信息。",
      requestedAt: Date.now(),
    };
  }
  return interaction;
}

function isTurnInterruptedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /turn interrupted/i.test(message);
}

function parseStoredRoleDraftJobRequest(raw: string | null | undefined): StoredRoleDraftJobRequest {
  const parsed = safeParseJson<StoredRoleDraftJobRequest | null>(raw, null);
  if (!parsed || parsed.assetKind !== "role" || (parsed.mode !== "create" && parsed.mode !== "revise")) {
    throw serviceError(409, "CONFLICT", "当前任务缺少可恢复的请求快照，请重新发起角色助手");
  }
  return parsed;
}

function parseStoredSkillDraftJobRequest(raw: string | null | undefined): StoredSkillDraftJobRequest {
  const parsed = safeParseJson<StoredSkillDraftJobRequest | null>(raw, null);
  if (!parsed || parsed.assetKind !== "skill" || (parsed.mode !== "create" && parsed.mode !== "revise")) {
    throw serviceError(409, "CONFLICT", "当前任务缺少可恢复的请求快照，请重新发起 Skills 助手");
  }
  return parsed;
}

/** 判断草案任务是否允许接收用户补充并进入下一轮生成。 */
function isContinuableDraftJob(job: AssetGenerationJob): boolean {
  return job.status === "awaiting_input"
    || job.status === "awaiting_review"
    || job.status === "applied"
    || (job.status === "failed" && job.failure?.retryable === true);
}

function appendResumePrompt(basePrompt: string, extraPrompt: string, assetLabel = "角色"): string {
  const base = String(basePrompt ?? "").trim();
  const extra = String(extraPrompt ?? "").trim();
  if (!extra) return base;
  if (!base) return extra;
  return [
    base,
    "",
    `下面是用户最新补充或修订的信息，请以它为准继续当前${assetLabel}草案任务：`,
    extra,
  ].join("\n");
}

function extractJsonObject(rawText: string): string {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) throw serviceError(502, "ENGINE_RESPONSE_EMPTY", "引擎未返回任何内容");
  const noFence = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (noFence.startsWith("{") && noFence.endsWith("}")) return noFence;
  const first = noFence.indexOf("{");
  const last = noFence.lastIndexOf("}");
  if (first >= 0 && last > first) return noFence.slice(first, last + 1);
  throw serviceError(502, "STRUCTURED_PARSE_FAILED", "引擎返回内容中未找到 JSON 对象");
}

function assertNoExtraKeys(obj: Record<string, unknown>, allowedKeys: Set<string>, code: ApiErrorCode, message: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) throw serviceError(502, code, `${message}：${key}`);
  }
}

function normalizeSelectedPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(raw);
}

function dedupeStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveDraftEngine(targetRole: RoleDefinition | null, input: OrchAssetDraftGenerateRequestBody): "claude" | "codex" {
  const preferred = String(input.enginePreference?.engine ?? "").trim();
  if (preferred === "codex") return "codex";
  if (preferred === "claude") return "claude";
  if (input.roleSnapshot?.executionConfig?.preferredEngine === "codex") return "codex";
  return targetRole?.executionConfig.preferredEngine === "claude" ? "claude" : "codex";
}

function resolveSkillDraftEngine(targetSkill: SkillDefinition | null, input: StoredSkillDraftJobRequest): "claude" | "codex" {
  const preferred = String(input.enginePreference?.engine ?? "").trim();
  if (preferred === "codex") return "codex";
  if (preferred === "claude") return "claude";
  const snapshotEngine = input.skillSnapshot?.targetEngines?.includes("claude") ? "claude" : null;
  if (snapshotEngine) return snapshotEngine;
  return targetSkill?.targetEngines?.includes("claude") ? "claude" : "codex";
}

function makeProgress(stage: AssetGenerationJobStatus, headline: string, detail?: string | null, percent?: number | null): AssetGenerationProgress {
  return { stage, headline, detail: detail ?? null, percent: percent ?? null };
}

function serviceError(status: number, code: ApiErrorCode, message: string, details?: unknown): AssetDraftServiceError {
  return new AssetDraftServiceError(status, code, message, details);
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 生成草案列表/详情共用的轻量摘要，避免列表页解析完整草案内容。 */
function summarizeRoleDraft(draft: AssetDraft | null): OrchAssetDraftJobSummary | null {
  if (!draft) return null;
  const issues = draft.validationIssues ?? [];
  return {
    id: draft.id,
    status: draft.status,
    validationIssueCount: issues.length,
    blockingIssueCount: issues.filter((issue) => issue.blocking).length,
  };
}

/** 生成草案列表/详情共用摘要，支持 Role 与 Skill。 */
function summarizeAssetDraft(draft: AssetDraft | null): OrchAssetDraftJobSummary | null {
  return summarizeRoleDraft(draft);
}

/** 归一化列表页 limit，防止 UI 请求过大。 */
function clampListLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function blockingIssue(code: string, fieldPath: string, message: string, suggestion?: string | null): AssetValidationIssue {
  return { code, severity: "error", fieldPath, message, suggestion: suggestion ?? null, source: inferIssueSource(code), blocking: true };
}

function warningIssue(code: string, fieldPath: string, message: string, suggestion?: string | null): AssetValidationIssue {
  return { code, severity: "warning", fieldPath, message, suggestion: suggestion ?? null, source: inferIssueSource(code), blocking: false };
}

function inferIssueSource(code: string): AssetValidationIssue["source"] {
  if (code.startsWith("UNKNOWN_")) return "reference";
  if (code.startsWith("INVALID_") || code === "REQUIRED_FIELD_MISSING") return "schema";
  if (code === "TOOL_REQUIREMENTS_BROAD") return "tooling";
  return "quality";
}

function inferFailureStage(code: ApiErrorCode): AssetGenerationFailure["stage"] {
  switch (code) {
    case "INVALID_SELECTED_PATH":
    case "SOURCE_PATH_MISSING":
    case "CONTEXT_COLLECTION_FAILED":
      return "collecting_context";
    case "ENGINE_TIMEOUT":
    case "ENGINE_UNAVAILABLE":
    case "ENGINE_RESPONSE_EMPTY":
    case "TOOL_RESULT_REQUIRED":
      return "generating";
    case "STRUCTURED_PARSE_FAILED":
      return "parsing";
    case "SCHEMA_VALIDATION_FAILED":
    case "REFERENCE_VALIDATION_FAILED":
      return "validating";
    default:
      return "persisting";
  }
}

function isRetryableError(code: ApiErrorCode): boolean {
  return code === "ENGINE_TIMEOUT" || code === "ENGINE_UNAVAILABLE" || code === "ENGINE_RESPONSE_EMPTY" || code === "CONTEXT_COLLECTION_FAILED";
}

function extractUserHint(details: unknown): string | null {
  if (details && typeof details === "object" && "userHint" in (details as Record<string, unknown>)) {
    return nullableString((details as Record<string, unknown>).userHint);
  }
  return null;
}

function normalizeFailureDetails(details: unknown): Record<string, string | number | boolean | null> | null {
  if (!details || typeof details !== "object") return null;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

/** 比较草案校验结果，避免读取详情时无变化也刷新草案更新时间。 */
function sameValidationIssues(left: AssetValidationIssue[], right: AssetValidationIssue[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clampContextChars(raw: unknown): number {
  const value = Math.floor(Number(raw ?? DEFAULT_CONTEXT_CHARS));
  if (!Number.isFinite(value)) return DEFAULT_CONTEXT_CHARS;
  return Math.max(4_000, Math.min(MAX_CONTEXT_CHARS, value));
}

function resolveWorkspacePath(workspacePath: string, relPath: string): string {
  const normalized = String(relPath ?? "").trim().replace(/\\/g, "/");
  if (!normalized) throw serviceError(400, "INVALID_SELECTED_PATH", "选中的文件路径不能为空");
  const absPath = path.resolve(workspacePath, normalized);
  const wsRoot = path.resolve(workspacePath);
  const relative = path.relative(wsRoot, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw serviceError(400, "INVALID_SELECTED_PATH", `路径越界：${normalized}`, { path: normalized });
  }
  return absPath;
}

/** 读取可纳入草案上下文的文本文件，兼容 UTF-8 与 GBK，非文件或超限返回 null。 */
function readTextFileSafe(absPath: string, maxBytes: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw serviceError(400, "CONTEXT_COLLECTION_FAILED", `无法读取文本文件信息：${absPath}`, {
      path: absPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;
  try {
    return decodeTextBuffer(fs.readFileSync(absPath)).content;
  } catch (error) {
    throw serviceError(400, "CONTEXT_COLLECTION_FAILED", `无法读取文本文件：${absPath}`, {
      path: absPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function listWorkbenchDocs(workspacePath: string): Array<{ absPath: string; relPath: string }> {
  const defaultRoot = path.join(workspacePath, "codeflow-docs");
  let root = defaultRoot;
  try {
    const existing = readExistingCodeflowaiConfig(workspacePath);
    const rel = String(existing?.config.paths?.workflowDocsRoot ?? "").trim();
    if (rel) root = path.resolve(workspacePath, rel);
  } catch {
    root = defaultRoot;
  }
  if (!fs.existsSync(root)) return [];
  const result: Array<{ absPath: string; relPath: string }> = [];
  scanTextDocs(root, root, result, 0);
  return result;
}

function scanTextDocs(root: string, current: string, out: Array<{ absPath: string; relPath: string }>, depth: number): void {
  if (depth > 3 || out.length >= MAX_WORKBENCH_DOCS) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_WORKBENCH_DOCS) return;
    if (entry.name.startsWith(".")) continue;
    const absPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      scanTextDocs(root, absPath, out, depth + 1);
      continue;
    }
    if (!/\.(md|markdown|txt|ya?ml)$/i.test(entry.name)) continue;
    out.push({ absPath, relPath: path.relative(root, absPath).replace(/\\/g, "/") });
  }
}

function resolveSelectedTools(
  toolRefs: ToolRef[],
  toolsetById: Map<ToolsetId, ToolsetDefinition>,
): Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> {
  const resolved: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> = [];
  for (const ref of toolRefs) {
    const toolset = toolsetById.get(ref.toolsetId);
    if (!toolset) continue;
    const tool = toolset.tools.find((item) => item.id === ref.toolId);
    if (!tool) continue;
    resolved.push({ toolset, tool, ref });
  }
  return resolved;
}

function resolveToolRefLabel(ref: ToolRef, toolsetById: Map<ToolsetId, ToolsetDefinition>): string {
  const toolset = toolsetById.get(ref.toolsetId);
  if (!toolset) return `${ref.toolsetId}/${ref.toolId}`;
  const tool = toolset.tools.find((item) => item.id === ref.toolId);
  return tool ? `${toolset.name}/${tool.name}` : `${toolset.name}/${ref.toolId}`;
}

function summarizeKnowledgeBundles(bundles: KnowledgeBundleDefinition[]): string {
  if (!bundles.length) return "当前工作区没有知识库。";
  return bundles
    .map((bundle) => `- id: ${bundle.id}\n  name: ${bundle.name}\n  scope: ${bundle.scope}\n  description: ${bundle.description || "无"}\n  sourceCount: ${bundle.sourceRefs.length}`)
    .join("\n");
}

function summarizeToolsets(toolsets: ToolsetDefinition[]): string {
  if (!toolsets.length) return "当前工作区没有工具集。";
  return toolsets
    .map((toolset) => [
      `- id: ${toolset.id}`,
      `  name: ${toolset.name}`,
      `  description: ${toolset.description || "无"}`,
      `  tools: ${toolset.tools.length}`,
      ...toolset.tools.map((tool) => `    - ${tool.id}: ${tool.name} [${tool.runtime}] write=${Boolean(tool.requiresWrite)}`),
    ].join("\n"))
    .join("\n");
}

function summarizeSkills(skills: SkillDefinition[], targetSkillId: SkillId | null): string {
  if (!skills.length) return "当前工作区没有 Skills。";
  return skills
    .map((skill) => [
      `- id: ${skill.id}${skill.id === targetSkillId ? " (当前目标 Skill)" : ""}`,
      `  name: ${skill.name}`,
      `  slug: ${skill.slug || "无"}`,
      `  description: ${skill.description || "无"}`,
      `  trigger: ${skill.trigger || "无"}`,
      `  targetEngines: ${(skill.targetEngines ?? []).join(", ") || "[]"}`,
      `  files: ${(skill.files ?? []).map((file) => file.relPath).join(", ") || "[]"}`,
      `  scripts: ${(skill.scripts ?? []).map((script) => `${script.id}:${script.scriptPath}[${script.runtime}]`).join(", ") || "[]"}`,
    ].join("\n"))
    .join("\n");
}

function normalizePromptRoleSnapshot(
  raw: OrchAssetDraftGenerateRequestBody["roleSnapshot"],
  workspaceId: WorkspaceId,
): RoleDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    id: (raw.id ?? "") as RoleId,
    workspaceId,
    responsibility: nullableString(raw.responsibility),
    inputDefinition: normalizeRoleInputDefinition(raw.inputDefinition),
    outputDefinition: normalizeRoleOutputDefinition(raw.outputDefinition),
    executionConfig: normalizeRoleExecutionConfig(raw.executionConfig, raw.executionConfig?.preferredEngine === "claude" ? "claude" : "codex"),
    defaultKnowledgeBundleIds: dedupeStrings(raw.defaultKnowledgeBundleIds) as KnowledgeBundleId[],
    toolRefs: normalizeToolRefs(raw.toolRefs),
    kind: "custom",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 去除角色运行时字段，供已落地 Agent 继续优化时作为请求快照。 */
function stripRuntimeRoleFields(role: RoleDefinition): Omit<RoleDefinition, "createdAt" | "updatedAt"> {
  return {
    id: role.id,
    workspaceId: role.workspaceId,
    name: role.name,
    description: role.description,
    responsibility: role.responsibility ?? null,
    systemPrompt: role.systemPrompt,
    inputDefinition: normalizeRoleInputDefinition(role.inputDefinition),
    outputDefinition: normalizeRoleOutputDefinition(role.outputDefinition),
    gateCriteria: normalizeGateCriteria(role.gateCriteria),
    executionConfig: normalizeRoleExecutionConfig(role.executionConfig, role.executionConfig?.preferredEngine === "claude" ? "claude" : "codex"),
    defaultKnowledgeBundleIds: dedupeStrings(role.defaultKnowledgeBundleIds) as KnowledgeBundleId[],
    defaultSkillIds: dedupeStrings(role.defaultSkillIds) as SkillId[],
    toolRefs: normalizeToolRefs(role.toolRefs),
    kind: "custom",
  };
}

function normalizePromptSkillSnapshot(
  raw: OrchAssetDraftGenerateRequestBody["skillSnapshot"],
  workspaceId: WorkspaceId,
): SkillDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const draft = normalizeSkillDraftDefinition(raw);
  return {
    ...draft,
    id: (raw.id ?? "") as SkillId,
    workspaceId,
    kind: "custom",
    packageHash: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function stripRuntimeSkillFields(skill: SkillDefinition): Omit<SkillDefinition, "createdAt" | "updatedAt"> {
  return {
    id: skill.id,
    workspaceId: skill.workspaceId,
    name: skill.name,
    slug: skill.slug ?? null,
    description: skill.description,
    trigger: skill.trigger,
    instructions: skill.instructions,
    targetEngines: [...(skill.targetEngines ?? [])],
    tags: [...(skill.tags ?? [])],
    kind: "custom",
    packageVersion: skill.packageVersion ?? 1,
    skillMd: skill.skillMd ?? null,
    files: (skill.files ?? []).map((file) => ({ ...file })),
    scripts: (skill.scripts ?? []).map((script) => ({ ...script })),
    installTargets: [...(skill.installTargets ?? skill.targetEngines ?? [])],
    packageHash: skill.packageHash ?? null,
  };
}

function skillToDraftDefinition(skill: SkillDefinition): SkillDraftPayload["draft"] {
  return normalizeSkillDraftDefinition(stripRuntimeSkillFields(skill));
}

function sanitizeSkillDefinition(skill: SkillDefinition): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    slug: skill.slug ?? null,
    description: skill.description,
    trigger: skill.trigger,
    instructions: skill.instructions,
    targetEngines: skill.targetEngines,
    tags: skill.tags ?? [],
    skillMd: skill.skillMd ?? "",
    files: sanitizeSkillFiles(skill.files),
    scripts: skill.scripts ?? [],
    installTargets: skill.installTargets ?? skill.targetEngines,
  };
}

function sanitizeSkillFiles(files: SkillPackageFile[] | null | undefined): Array<Pick<SkillPackageFile, "relPath" | "kind" | "contentType" | "sizeBytes" | "sha256"> & { contentText?: string | null }> {
  return (files ?? []).map((file) => ({
    relPath: file.relPath,
    kind: file.kind,
    contentType: file.contentType ?? null,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    contentText: file.contentText ?? null,
  }));
}

function buildDefaultSkillMd(input: { name: string; slug: string; description: string; trigger: string; instructions: string }): string {
  return [
    "---",
    `name: ${yamlDoubleQuoted(input.slug || normalizeSkillSlug(input.name || "skill"))}`,
    `description: ${yamlDoubleQuoted(input.description || input.trigger || input.name || "CodeFlow Skill")}`,
    "---",
    "",
    `# ${input.name || input.slug || "Skill"}`,
    "",
    input.description ? input.description : "",
    input.trigger ? `## Trigger\n\n${input.trigger}` : "",
    input.instructions ? `## Instructions\n\n${input.instructions}` : "",
  ].filter((part) => part !== "").join("\n");
}

function normalizeSkillSlug(value: unknown): string {
  const base = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "skill";
}

function yamlDoubleQuoted(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function isValidJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function summarizeValidationIssues(issues: AssetValidationIssue[]): string {
  if (!issues.length) return "输出未通过校验";
  return issues
    .slice(0, 6)
    .map((issue) => `${issue.fieldPath}: ${issue.message}`)
    .join("；");
}

function sanitizeRoleDefinition(role: RoleDefinition): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    responsibility: role.responsibility ?? null,
    systemPrompt: role.systemPrompt,
    inputDefinition: sanitizeDraftInputDefinition(role.inputDefinition),
    outputDefinition: sanitizeDraftOutputDefinition(role.outputDefinition),
    gateCriteria: role.gateCriteria,
    executionConfig: sanitizeDraftExecutionConfig(sanitizeExecutionConfig(role.executionConfig)),
    defaultKnowledgeBundleIds: role.defaultKnowledgeBundleIds ?? [],
    toolRefs: role.toolRefs ?? [],
    kind: role.kind,
  };
}

function sanitizeExecutionConfig(config: RoleExecutionConfig | undefined | null): RoleExecutionConfig {
  return normalizeRoleExecutionConfig(config, config?.preferredEngine ?? "codex");
}

function sanitizeDraftInputDefinition(definition: RoleDefinition["inputDefinition"] | undefined | null): RoleDefinition["inputDefinition"] {
  const normalized = normalizeRoleInputDefinition(definition ?? createDefaultRoleInputDefinition());
  return {
    instructions: normalized.instructions.trim(),
    requiredFields: sanitizeRoleFields(normalized.requiredFields),
  };
}

function sanitizeDraftOutputDefinition(definition: RoleDefinition["outputDefinition"] | undefined | null): RoleDefinition["outputDefinition"] {
  const normalized = normalizeRoleOutputDefinition(definition ?? createDefaultRoleOutputDefinition());
  return {
    instructions: normalized.deliveryMode === "direct" ? normalized.instructions.trim() : "",
    deliveryMode: normalized.deliveryMode,
    format: normalized.format,
    resultKey: normalized.resultKey,
    filePathRule: normalized.filePathRule,
    files: sanitizeRoleOutputFiles(normalized.files),
    requiredFields: sanitizeRoleFields(normalized.requiredFields),
  };
}

function sanitizeDraftExecutionConfig(config: RoleExecutionConfig): RoleExecutionConfig {
  const normalized = sanitizeExecutionConfig(config);
  return {
    ...normalized,
    engineProfiles: {
      claude: sanitizeDraftExecutionProfile(normalized.engineProfiles.claude, "claude"),
      codex: sanitizeDraftExecutionProfile(normalized.engineProfiles.codex, "codex"),
    },
  };
}

function sanitizeDraftExecutionProfile(
  profile: RoleExecutionConfig["engineProfiles"]["claude"] | RoleExecutionConfig["engineProfiles"]["codex"],
  engine: "claude" | "codex",
) {
  if (profile.mode !== "custom" || !profile.customConfig) {
    return {
      enabled: profile.enabled,
      mode: profile.mode,
      customConfig: null,
    };
  }
  return {
    enabled: profile.enabled,
    mode: "custom" as const,
    customConfig: {
      ...profile.customConfig,
      autoCompactPct: profile.customConfig.autoCompactPct ?? null,
      contextWindow: profile.customConfig.contextWindow ?? null,
      maxRetries: profile.customConfig.maxRetries ?? 0,
    },
  };
}

function sanitizeRoleFields(fields: RoleFieldDefinition[] | null | undefined): RoleFieldDefinition[] {
  return normalizeRoleFieldDefinitions(fields).map((field) => ({
    key: field.key,
    label: field.label,
    valueType: field.valueType,
    required: field.required,
    description: field.description ?? null,
    example: field.example ?? null,
  }));
}

/** 清理角色交付文件配置，同时保留后续运行时需要的稳定 key 和后缀契约。 */
function sanitizeRoleOutputFiles(files: RoleDefinition["outputDefinition"]["files"] | undefined | null): NonNullable<RoleDefinition["outputDefinition"]["files"]> {
  return (files ?? []).map((file, index) => ({
    key: String(file?.key ?? "").trim() || null,
    name: String(file?.name ?? "").trim() || `交付项 ${index + 1}`,
    format: file?.format ?? null,
    allowedExtensions: Array.isArray(file?.allowedExtensions) ? file.allowedExtensions : null,
    pathRule: String(file?.pathRule ?? "").trim() || null,
    description: String(file?.description ?? "").trim() || null,
    required: file?.required !== false,
  }));
}

function hasDuplicateRoleFields(fields: RoleFieldDefinition[] | null | undefined): boolean {
  const seen = new Set<string>();
  for (const field of sanitizeRoleFields(fields)) {
    const key = field.key.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffType(beforeValue: unknown, afterValue: unknown): RoleDraftDiffItem["changeType"] {
  const beforeEmpty = beforeValue === null || beforeValue === undefined || beforeValue === "" || (Array.isArray(beforeValue) && beforeValue.length === 0);
  const afterEmpty = afterValue === null || afterValue === undefined || afterValue === "" || (Array.isArray(afterValue) && afterValue.length === 0);
  if (beforeEmpty && !afterEmpty) return "added";
  if (!beforeEmpty && afterEmpty) return "removed";
  if (sameValue(beforeValue, afterValue)) return "unchanged";
  return "modified";
}

function isValidGateType(type: string): boolean {
  return type === "ai" || type === "regex" || type === "json-schema";
}

