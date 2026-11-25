import "./runtime/clientHttpRuntime.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { parse as parseYaml } from "yaml";
import {
  extractThreadPrefsPatchFromConversationEvent,
  isNamespacedLocalWorkspaceId,
  mergeThreadPrefs,
  prefixLocalWorkspaceId,
  requireRelayPricingCatalogSnapshot,
  selectLatestRelayPricingCatalogSnapshot,
} from "@codeflowai/shared";
import type {
  ConversationEventEnvelope,
  ConversationEventInput,
  EngineType,
  OrchAssetBundle,
  OrchestrationId,
  RawEngineEventEnvelope,
  RelayPricingCatalogSnapshot,
  SessionId,
  ThreadId,
  TurnExecutionOptionsSnapshot,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";

import { cleanupClientLogRetention, flushClientLogger, logger, resolveClientLogRetentionDays } from "./logger.js";
import { formatClientHelp, parseClientCliArgs } from "./cliArgs.js";
import { assertEngineKeySourceVerified } from "./db/repos/engineKeyRepo.js";
import {
  handleClientDaemonCommand,
  buildClientRestartEnv,
  isClientDaemonChild,
  readClientDaemonProcessSnapshot,
  markCurrentClientDaemonInitialConnection,
  markCurrentClientDaemonStartup,
  refreshCurrentClientDaemonState,
  spawnClientDaemonReplacementFromCurrentProcess,
  waitForClientRestartParentExit,
} from "./clientDaemon.js";
import { buildClientChildProcessEnv } from "./runtime/clientProcessEnv.js";
import { assertDesktopDbSchemaVersion, createDesktopLifecycle, readDesktopClientHealth, type DesktopUpdateOperation } from "./runtime/desktopLifecycle.js";
import { createDesktopStartupRecovery, readDesktopStartupMode } from "./runtime/desktopStartupRecovery.js";
import { createDesktopUpdateControl } from "./runtime/desktopUpdateControl.js";
import { interruptTurnBestEffort, getPendingTurnTerminalFailure } from "./app/turnInterrupt.js";
import { hasActiveKnowledgeGeneration, stopKnowledgeGenerationForUpdate } from "./knowledge/knowledgeGenerationService.js";
import { hasActiveKnowledgeUpdate, waitForKnowledgeUpdateCheck } from "./knowledge/knowledgeUpdateService.js";
import { hasInFlightAssetDraftWork, stopAssetDraftJobsForUpdate } from "./orchestration/assetDraftService.js";
import { createLocalEventPersistence, createLocalEventPipeline } from "./runtime/localEventPersistence.js";
import { resumeThreadDeletions } from "./app/handlers/threadHandlers.js";
import { hasLocalEventOwnerEffects } from "./runtime/localEventIndex.js";
import { createLocalEventRelay } from "./runtime/localEventRelay.js";
import { executeDesktopApiRequest } from "./app/executeDesktopApiRequest.js";
import { executeDesktopAccountTaskRequest } from "./app/executeDesktopAccountTaskRequest.js";
import { createDesktopCloudAccount, type DesktopCloudAccount, type DesktopCloudAccountOwner } from "./runtime/desktopCloudAccount.js";
import { createBuiltInRelayCredentialService } from "./security/builtInRelayCredentialService.js";
import { runPosixClientUpgrade, ClientUpgradeLifecycleError } from "./update/clientUpgradeLifecycle.js";
import {
  assertClientUninstallCompleted,
  buildClientUninstallCommand,
  clientUninstallManualHints,
  ClientUninstallError,
  ClientUninstallLifecycleError,
  resolveClientUninstallEntryVerdict,
  resolveClientUninstallPlan,
  runClientUninstallCleanup,
  runPosixClientUninstall,
  type ClientUninstallEntryCheck,
  type ClientUninstallPlan,
} from "./update/clientUninstall.js";
import { launchWindowsDetachedUninstall } from "./update/windowsSelfUninstall.js";
import {
  prepareClientUpgradePackage, cleanupClientUpgradePackage, verifyPreparedClientUpgradePackage,
  ClientUpgradePackageError, type PreparedClientUpgradePackage, type ClientUpgradePreparationProgress,
} from "./update/clientUpgradePackage.js";
import { redactClientStartupText, safeClientServerUrl } from "./startup/clientStartupStatus.js";
import { createConversationEventAckBuffer } from "./diagnostics/conversationEventAckBuffer.js";
import { backfillEventOutputOnce } from "./diagnostics/eventOutputBackfill.js";
import { startEventLoopLagMonitor, type EventLoopLagSnapshot } from "./diagnostics/eventLoopLagMonitor.js";
import { createEventFlowMonitor } from "./diagnostics/eventFlowMonitor.js";
import { readKeepFullEventOutputFlag, sanitizeClientToServerMessage } from "./diagnostics/eventOutputPolicy.js";
import { createRawEventAckBuffer } from "./diagnostics/rawEventAckBuffer.js";
import { createRawEventRetentionWorker } from "./diagnostics/rawEventRetention.js";
import { createThreadTouchBuffer } from "./diagnostics/threadTouchBuffer.js";
import { readClientConfig, readClientServerWsUrl, saveConfigFile } from "./config.js";
import { readSelfVersion, compareSemver } from "./version.js";
import { isClientSourceRun } from "./app/clientInstallEntry.js";
import { describeWorkspaceApiFailure, handleApiRequest, isWorkspaceApiRequestFailure, type ApiHandlerContext } from "./app/handleApiRequest.js";
import { emitQueueChanged } from "./app/handleThreadQueueRequest.js";
import { drainOrdinaryTurnExecutions } from "./app/ordinaryTurnExecution.js";
import { executeHostRpcHttpTask } from "./app/executeHostRpcHttpTask.js";
import { assertChatWorkflowDirectoryAvailable, waitForWorkspaceWriteAvailable } from "./orchestration/workspaceExecutionGuard.js";
import {
  clearActiveThreadTurnIfMatches,
  resolveTurnErrorIndexScope,
} from "./app/threadRunningState.js";
import { handleSharedWorkspaceCommand } from "./app/handlers/sharedWorkspaceHandlers.js";
import { listActiveRollbackMutationThreadIds } from "./app/handlers/rollbackHandlers.js";
import { SendIdempotencyCache } from "./app/sendIdempotencyCache.js";
import { createRollbackEvidenceFence } from "./app/rollbackEvidenceFence.js";
import { ThreadQueueDispatcher } from "./queue/threadQueueDispatcher.js";
import { readTurnExecutionOptionsSnapshot } from "./queue/threadQueueExecutionPolicy.js";
import {
  buildClientUpgradeCommand,
  buildClientOfflineUpgradeCommand,
  buildClientUpgradeNpmEnv,
  resolveNpmGlobalPrefixResult,
  resolveClientUpgradeInstallUrl,
  resolveClientUpgradeInstallTarget,
  pinClientUpgradeNpmPrefix,
  type NpmGlobalPrefixResult,
} from "./app/handlers/softwareUpdateHandlers.js";
import type { ClientToServerMessage, ServerToClientMessage } from "./protocol/messages.js";
import {
  THREAD_DELETION_IN_PROGRESS_CODE,
  THREAD_OPERATION_IN_PROGRESS_CODE,
  ThreadSessionManager,
} from "./engines/threadSessionManager.js";
import { getOrCreateThreadInputActionHmacKey } from "./engines/threadInputActions.js";
import {
  applyEngineModelCatalogSnapshot,
  clearDesktopCloudEngineModelCatalog,
  cancelEngineModelCatalogDispatchPause,
  confirmEngineModelCatalogApplied,
  getEngineModelCatalogDispatchPauseOperationId,
  getRuntimeEngineModelsIfReady,
  initializeLocalEngineModelCatalog,
  pauseEngineModelCatalogDispatch,
  pauseEngineModelCatalogDispatchForReconnect,
  resolveRuntimeEngineModelProviderId,
  setEngineModelCatalogCustomModels,
  waitForEngineModelCatalogDispatchReady,
} from "./engines/engineModelCatalogRuntime.js";
import { ThreadStore } from "./threads/threadStore.js";
import { prepareCodexKeySwitch } from "./app/handlers/engineKeyHandlers.js";
import { WsTransport } from "./transport/wsTransport.js";
import { HostRpcHttpTransport } from "./transport/hostRpcHttpTransport.js";
import { ServerMessageHelloReadyFence } from "./transport/serverMessageHelloReadyFence.js";
import { openClientDb, type ClientDb } from "./db/clientDb.js";
import { ChatWorkflowRepo } from "./db/repos/chatWorkflowRepo.js";
import { retireChatWorkflowCardsWithoutWorkflowAsset } from "./orchestration/chatWorkflowCardRetirement.js";
import { ClientDbReaderService } from "./db/clientDbReaderService.js";
import { ClientDbWriterService } from "./db/clientDbWriterService.js";
import { ClientDbCleanupService } from "./db/clientDbCleanupService.js";
import type { CodexProviderTurnMappingCandidate } from "./db/repos/codexProviderTurnMapping.js";
import {
  acquireClientProcessLock,
  assertClientIdOverrideAllowed,
  ensureStableClientId,
  readBoundClientId,
  selectStartupWorkspaces,
} from "./startup/clientStartupGuards.js";
import { readClaudeSessionFileByteLen, resolveClaudeSessionFilePath } from "./engines/claude/claudeSessionStore.js";
import { analyzeUnifiedDiffPaths, extractToolPaths, isFileChangeLikeTool, normalizeChanges, normalizeToolNameKey, normalizeWorkspaceRelativePosixPath } from "./engines/toolFilePaths.js";
import { TerminalManager } from "./terminal/terminalManager.js";
import { publishTerminalRuntimeMessage } from "./terminal/localTerminalEvents.js";
import { handleDesktopCloudTerminalMessage, handleTerminalMessage, handleTerminalActionsList, handleTerminalActionsSave } from "./app/handlers/terminalHandlers.js";
import {
  OrchestrationEngine,
  shouldRecoverPersistedOrchestrationInstance,
} from "./orchestration/orchestrationEngine.js";
import { installDesktopBuiltinAssets, isDesktopLocalAssetWorkspace, readDesktopBuiltinAssetBundles } from "./orchestration/desktopBuiltinAssetService.js";
import { ensureBuiltinSkillPackagesInstalled } from "./orchestration/skillPackageService.js";
import { createCodeAttributionHttpTransport } from "./orchestration/codeAttributionHttpTransport.js";
import { CodeAttributionSyncWorker } from "./orchestration/codeAttributionSyncWorker.js";
import { CodeAttributionRetentionWorker } from "./orchestration/codeAttributionRetentionWorker.js";
import {
  createClientDbOrchAssetLegacyRuntimeReader,
  isDesktopLocalAssetExecution,
  isDesktopLocalThreadAssetExecution,
  OrchAssetAuthorityRuntimeReadService,
} from "./orchestration/orchAssetAuthorityRuntimeReadService.js";
import { OrchAssetLaunchSnapshotError, OrchAssetLaunchSnapshotService } from "./orchestration/orchAssetLaunchSnapshotService.js";
import { OrchInstanceScopeError } from "./db/repos/orchInstanceRepo.js";
import { OrchAssetLegacyInstanceBackfillService } from "./orchestration/orchAssetLegacyInstanceBackfillService.js";
import { launchWindowsDetachedUpgrade } from "./update/windowsSelfUpgrade.js";
import type { WsSendJsonResult } from "./transport/wsTransport.js";
import { resolveServerConnectionHint } from "./transport/serverConnectionHint.js";
import { dispatchWorkspaceApiRequestFailure, prepareTransportMessageFailure } from "./transport/transportMessageFailurePolicy.js";
import { CLIENT_PROCESS_EXIT_CODE_BLOCKED } from "./processExitCodes.js";
import { finalizeDanglingTurnsOnStartup } from "./startup/danglingTurnReconciler.js";
import { reconcileAssetDraftJobsOnStartup } from "./startup/assetDraftJobReconciler.js";
import {
  BUILT_IN_RELAY_AUTO_ENABLE_FAILED_CODE,
  BUILT_IN_RELAY_AUTO_ENABLE_MARKER_FAILED_CODE,
  BUILT_IN_RELAY_AUTO_ENABLE_NOTIFY_FAILED_CODE,
  BUILT_IN_RELAY_PROVIDER_ID,
  enableBuiltInRelayOnStartup,
  requestBuiltInRelayKey,
  type BuiltInRelayAutoEnableOutcome,
} from "./startup/builtInRelayAutoEnable.js";
import {
  indexCodexProviderTurnStarted,
  persistOrStageCodexProviderTurn,
} from "./eventIndex/codexProviderTurnStarted.js";
import {
  applyThreadStartedBinding,
  prepareThreadStartedBindingAck,
  resolveThreadStartedBinding,
} from "./eventIndex/threadStartedBinding.js";
import { applyThreadReminderStateEvent } from "./eventIndex/threadReminderStateEvents.js";
import { captureFileChangeBeforeSnapshot, captureFileChangeAfterSnapshot, freezeFileBeforeSnapshot, freezeFileAfterSnapshot, type FrozenFileBeforeSnapshot, type FrozenFileAfterSnapshot } from "./eventIndex/fileChangeSnapshots.js";
import { installClientStdioDiagnostics } from "./runtime/clientStdioDiagnostics.js";
import { WorkspacePathIndexService } from "./fs/workspacePathIndexService.js";
import { createServerReminderNotifier, createReminderDeliveryOwner } from "./notifications/serverReminderNotifier.js";
import type { ReminderCompletionNotifier } from "./notifications/reminderNotificationTypes.js";
import { shouldSendThreadCompletionNotification } from "./notifications/threadCompletionNotificationPolicy.js";
import {
  confirmPlainClientDbInitialized,
  prepareClientDbSecurity,
  prepareClientDeviceIdentity,
  resolveClientDbStartupContext,
} from "./security/clientDbSecurity.js";
import { ScheduledTaskScheduler, toErrorLog as toScheduledTaskErrorLog, type ScheduledTaskAccountContext } from "./scheduled-tasks/scheduledTaskScheduler.js";
import { dispatchDesktopKnowledgeUpdate, dispatchKnowledgeUpdate, tickKnowledgeUpdates } from "./knowledge/knowledgeUpdateScheduler.js";
import { ControlledExperimentExecutor } from "./experiments/controlledExperimentExecutor.js";
import {
  recoverWorkspaceMigrationsBeforeMap,
  WorkspaceMigrationService,
} from "./workspace-migration/workspaceMigrationService.js";
import { WorkspaceOperationGate } from "./workspace-migration/workspaceOperationGate.js";
import { migrateLegacyWorkspaceRuntimeDirectories } from "./workspace-migration/workspaceRuntimeDirectoryMigration.js";
import { createWorkspaceMigrationRuntimeCallbacks } from "./workspace-migration/workspaceMigrationRuntimeCallbacks.js";
import { runClientAsyncCleanupStep, runClientCleanupStep } from "./runtime/clientCleanup.js";
import { WorkspaceMigrationActivityInspector } from "./workspace-migration/workspaceMigrationActivityInspector.js";
import { WorkspaceMigrationIndexCoordinatorService } from "./workspace-migration/workspaceMigrationIndexCoordinator.js";
import {
  buildWorkspaceDirectoryMigrationActivationSnapshot,
  toWorkspaceDirectoryMigrationChangedEvent,
} from "./workspace-migration/workspaceMigrationView.js";
import { installSuperpowersIfMissing } from "./skills/superpowersAutoInstaller.js";

sanitizeProcessEnvForClientRuntime();

type AidtStepKeyV1 = "PRD" | "UI" | "ARC" | "DGN" | "PLAN" | "DEV" | "E2E" | "GIT";
type ClientStepLogLevel = "info" | "warn" | "error";
type ClientStepOutcome = "start" | "success" | "fail" | "warn" | "skip";

const RAW_EVENT_RETENTION_MS = 72 * 60 * 60 * 1000;
const RAW_EVENT_RETENTION_CHECK_MS = 60 * 60 * 1000;
const RAW_EVENT_RETENTION_START_DELAY_MS = 60 * 1000;
const RAW_EVENT_RETENTION_BATCH_SIZE = 100;
const RAW_EVENT_RETENTION_BATCH_DELAY_MS = 25;

/** 统一记录 client 关键运行步骤，便于按 entry/event 检索排障。 */
function logClientStep(
  level: ClientStepLogLevel,
  action: string,
  outcome: ClientStepOutcome,
  message: string,
  details: Record<string, unknown> = {},
): void {
  logger[level]("client-runtime", message, {
    entry: "client.runtime",
    event: { category: "client_runtime", action, outcome },
    ...details,
  });
}

/** 将未知异常及有限 cause 链压缩成可检索摘要，保留结构化错误码与冲突详情。 */
function toErrorLogValue(
  error: unknown,
  depth = 0,
  seen = new Set<object>(),
): Record<string, unknown> {
  if (error instanceof Error) {
    if (seen.has(error)) return { name: error.name, message: error.message, circular: true };
    seen.add(error);
    const value: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 6).join("\n") : undefined,
    };
    const code = String((error as Error & { code?: unknown }).code ?? "").trim();
    if (code) value.code = code;
    const requestId = (error as Error & { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(requestId)) value.requestId = requestId;
    const details = (error as Error & { details?: unknown }).details;
    if (details != null) value.details = details;
    if (depth < 4 && error.cause != null) value.cause = toErrorLogValue(error.cause, depth + 1, seen);
    if (depth < 4 && error instanceof AggregateError) {
      value.errors = error.errors.slice(0, 4).map((nested) => toErrorLogValue(nested, depth + 1, seen));
    }
    return value;
  }
  return { message: String(error) };
}

/** 保留脱敏后的有限异常链，供异步排空失败定位原始任务原因。 */
function describeClientErrorTree(error: unknown, depth = 0, seen = new Set<object>()): Record<string, unknown> {
  const described = describeWorkspaceApiFailure(error);
  const result: Record<string, unknown> = { ...described.rootCause, message: described.message };
  if (depth >= 4 || error === null || typeof error !== "object" && typeof error !== "function") return result;
  if (seen.has(error)) return { ...result, circular: true };
  seen.add(error);
  const own = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const cause = own("cause");
  if (cause != null) result.cause = describeClientErrorTree(cause, depth + 1, seen);
  const errors = own("errors");
  if (Array.isArray(errors)) result.errors = errors.slice(0, 4).map(item => describeClientErrorTree(item, depth + 1, seen));
  return result;
}

/** 将自动 Key 根因限制为安全元数据；未知输入和 cause 最多读取两层，不输出正文或秘密。 */
function toBuiltInRelayFailureLogValue(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== "object") return { name: "UnknownError" };
  const source = error as { name?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; status?: unknown; cause?: unknown };
  const result: Record<string, unknown> = { name: typeof source.name === "string" && ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "AbortError", "TimeoutError"].includes(source.name) ? source.name : "Error" };
  if (typeof source.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(source.code)) result.code = source.code;
  if (typeof source.errno === "number" && Number.isSafeInteger(source.errno)) result.errno = source.errno;
  if (typeof source.syscall === "string" && ["open", "read", "write", "rename", "unlink", "mkdir", "stat", "fsync", "connect", "getaddrinfo"].includes(source.syscall)) result.syscall = source.syscall;
  if (typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599) result.status = source.status;
  if (depth < 2 && source.cause != null) result.cause = toBuiltInRelayFailureLogValue(source.cause, depth + 1);
  return result;
}

/** 仅识别工作区写入被系统拒绝；其他同步错误仍保持显式失败。 */
function isWorkspaceWritePermissionError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (current && typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
    }
    const code = String((current as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/\b(?:EACCES|EPERM|EROFS)\b/iu.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

/** 识别 Node 内置 sqlite 的已知实验提示；这是启动噪声，不代表数据库操作失败。 */
function isNodeSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning"
    && warning.message === "SQLite is an experimental feature and might change at any time"
    && typeof warning.stack === "string"
    && warning.stack.includes("node:sqlite");
}

/** 记录进程级异常/警告，覆盖未进入业务链路的 runtime 问题。 */
function installProcessDiagnostics(): void {
  installClientStdioDiagnostics({
    stdout: process.stdout,
    stderr: process.stderr,
    onError: (stream, error) => logClientStep("error", "runtime.stdio_write_failed", "fail", "client console output failed; runtime continues", {
      code: "CLIENT_STDIO_WRITE_FAILED",
      requestId: `client-stdio:${process.pid}:${stream}`,
      pid: process.pid, stream, disposition: "console_output_unavailable",
      error: toErrorLogValue(error),
    }),
  });
  process.on("warning", (warning) => {
    if (isNodeSqliteExperimentalWarning(warning)) return;
    logClientStep("warn", "runtime.process_warning", "warn", "process warning emitted", {
      warning: toErrorLogValue(warning),
    });
  });
  process.on("unhandledRejection", (reason) => {
    logClientStep("error", "runtime.unhandled_rejection", "fail", "unhandled promise rejection", {
      error: toErrorLogValue(reason),
    });
    process.exitCode = 1;
    setImmediate(() => {
      void exitAfterLogFlush(1);
    });
  });
  process.on("uncaughtExceptionMonitor", (error) => {
    logClientStep("error", "runtime.uncaught_exception", "fail", "uncaught exception", {
      error: toErrorLogValue(error),
      // 保留进程存活时长、内存与启动参数，便于关联崩溃前负载和复现环境。
      runtime: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()),
        rssBytes: process.memoryUsage().rss, execArgv: process.execArgv.slice(0, 8) },
    });
  });
}

installProcessDiagnostics();

/** 用户批准普通诊断失败不阻断退出；保存错误已由业务边界记录，日志失败补记 stderr。 */
async function exitAfterLogFlush(exitCode: number): Promise<never> {
  process.exitCode = exitCode;
  try {
    await flushClientLogger();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[codeflowai] client logger flush failed:", error instanceof Error ? error.message : String(error));
  }
  process.exit(exitCode);
}

function sanitizeProcessEnvForClientRuntime(): void {
  // Deploy/release variables may share the profile file but must not be inherited by tool processes.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DEPLOY_") || key.startsWith("RELEASE_")) {
      delete process.env[key];
    }
  }
}

type ClientCliPreludeResult = {
  handled: boolean;
  apiKeyOverride?: unknown;
  apiKeyProvided: boolean;
};

/** 处理无需进入 client 主循环的 CLI 子命令。 */
async function handleCliPrelude(): Promise<ClientCliPreludeResult> {
  const command = parseClientCliArgs(process.argv.slice(2));
  if (command.kind === "run") {
    return {
      handled: false,
      apiKeyOverride: command.apiKeyOverride,
      apiKeyProvided: Boolean(command.apiKeyProvided),
    };
  }

  if (command.kind === "help") {
    // eslint-disable-next-line no-console
    console.log(formatClientHelp(readSelfVersion()));
    return { handled: true, apiKeyProvided: false };
  }
  if (command.kind === "version") {
    // eslint-disable-next-line no-console
    console.log(readSelfVersion() ?? "unknown");
    return { handled: true, apiKeyProvided: false };
  }
  if (command.kind === "update") {
    process.exitCode = await handleClientUpdateCommand();
    return { handled: true, apiKeyProvided: false };
  }
  if (command.kind === "uninstall") {
    process.exitCode = await handleClientUninstallCommand();
    return { handled: true, apiKeyProvided: false };
  }
  if (command.kind === "daemon") {
    process.exitCode = await handleClientDaemonCommand(command);
    return { handled: true, apiKeyProvided: false };
  }

  // eslint-disable-next-line no-console
  console.error(`[codeflowai] ${command.message}`);
  // eslint-disable-next-line no-console
  console.error("");
  // eslint-disable-next-line no-console
  console.error(formatClientHelp(readSelfVersion()));
  process.exitCode = 1;
  return { handled: true, apiKeyProvided: false };
}

/** 初始化本机运行时；桌面经 IPC 复用业务，远程 Client 按原流程连接 Server。 */
async function main(options?: { apiKeyOverride?: unknown }) {
  const runtimeStartedAt = Date.now();
  const desktopRequestId = process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
  if (desktopRequestId) initializeLocalEngineModelCatalog();
  const desktopLifecycle = desktopRequestId ? createDesktopLifecycle(process, desktopRequestId, {
    startup: readDesktopStartupMode(process.env.CODEFLOWAI_DESKTOP_STARTUP_MODE, process.env.CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID),
    abortStartup: (reason) => {
      logClientStep("error", "desktop.startup_stop", "fail", "desktop parent stopped before Client initialization completed", {
        errorCode: "DESKTOP_STARTUP_STOP_TIMEOUT", requestId: desktopRequestId, reason, pid: process.pid,
      });
      void exitAfterLogFlush(1);
    },
  }) : null;
  if (desktopLifecycle) assertDesktopDbSchemaVersion(process.env.CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION);
  markCurrentClientDaemonStartup("config");
  const config = readClientConfig({ ...options, desktop: Boolean(desktopLifecycle) });
  markCurrentClientDaemonStartup("identity", { clientId: config.clientId, serverUrl: config.serverWsUrl });
  const selfVersion = readSelfVersion();
  let desktopBuiltinBundles: OrchAssetBundle[];
  {
    const entryPath = String(process.argv[1] ?? "").trim();
    if (!entryPath) throw new Error("DESKTOP_CLIENT_ENTRY_REQUIRED");
    const sourceEntry = /\.tsx?$/iu.test(entryPath) && isClientSourceRun(entryPath);
    // 源码运行与构建产物都只使用 Client 自带资产，不再回退 Server 源码目录。
    const builtinDirectory = sourceEntry
      ? process.env.CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR ?? path.resolve(path.dirname(entryPath), "../assets/orchestration-builtin")
      : path.join(typeof __dirname === "string" ? __dirname : path.dirname(path.resolve(entryPath)), "orchestration-builtin");
    if (!builtinDirectory || !path.isAbsolute(builtinDirectory)) throw new Error("DESKTOP_BUILTIN_SOURCE_DIRECTORY_REQUIRED");
    desktopBuiltinBundles = readDesktopBuiltinAssetBundles(builtinDirectory);
  }
  const selfUpgrade = !process.env.CODEFLOWAI_DESKTOP_REQUEST_ID && !isClientSourceRun();
  const keepFullEventOutput = readKeepFullEventOutputFlag();
  const dbStartupContext = await resolveClientDbStartupContext({ config, clientVersion: selfVersion, desktop: Boolean(desktopLifecycle) });
  const dbPath = dbStartupContext.dbPath;
  const logRetentionDays = resolveClientLogRetentionDays();
  const logCleanup = cleanupClientLogRetention();
  logClientStep("info", "startup.begin", "start", "client startup begin", {
    target: { clientId: config.clientId, dbPath },
    version: selfVersion ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    serverWsUrl: config.serverWsUrl,
    apiKeySource: config.apiKeySource,
    clientIdSource: config.clientIdSource,
    accountNamespace: dbStartupContext.accountNamespace,
    explicitDbPath: dbStartupContext.explicitDbPath,
    configuredWorkspaceCount: config.workspaces.length,
    keepFullEventOutput,
    logRetentionDays,
  });
  logClientStep(logCleanup.errors.length ? "warn" : "info", "startup.log_retention_cleanup", logCleanup.errors.length ? "warn" : "success", "client log retention cleanup finished", {
    target: { clientId: config.clientId },
    logDir: logCleanup.logDir,
    retentionDays: logCleanup.retentionDays,
    scanned: logCleanup.scanned,
    deleted: logCleanup.deleted,
    errors: logCleanup.errors,
  });
  assertClientIdOverrideAllowed({
    dbPath,
    clientIdSource: config.clientIdSource,
    allowOverride: config.allowClientIdOverride,
  });
  const clientProcessLock = acquireClientProcessLock({ dbPath, clientId: config.clientId });
  logClientStep("info", "startup.process_lock_acquired", "success", "client process lock acquired", {
    target: { clientId: config.clientId, dbPath },
  });
  try {
    if (isClientDaemonChild()) {
      await refreshCurrentClientDaemonState();
      logClientStep("info", "startup.daemon_child_refreshed", "success", "daemon child state refreshed", {
        target: { clientId: config.clientId },
      });
    }
  } catch (error) {
    logClientStep("error", "startup.daemon_child_refresh", "fail", "daemon child state refresh failed", {
      target: { clientId: config.clientId },
      error: toErrorLogValue(error),
    });
    clientProcessLock.release();
    throw error;
  }
  let firstConnect = true;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  let lastConsoleConnectionHintKey = "";
  let lastConsoleConnectionHintAt = 0;
  logClientStep("info", "startup.config_loaded", "success", "startup config loaded", {
    target: { clientId: config.clientId },
    serverWsUrl: config.serverWsUrl,
    keepFullEventOutput,
    configuredWorkspaces: config.workspaces.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      label: workspace.label ?? null,
    })),
  });

  // 启动前检查更新
  markCurrentClientDaemonStartup("update");
  if (selfUpgrade) await checkClientUpdateOrPrompt({ serverWsUrl: config.serverWsUrl, currentVersion: selfVersion });

  markCurrentClientDaemonStartup("database");
  logClientStep("info", "startup.db_storage_prepare", "start", "client DB storage prepare started", {
    target: { clientId: config.clientId, dbPath },
  });
  await prepareClientDbSecurity({
    config,
    dbPath,
    startupContext: dbStartupContext,
    clientVersion: selfVersion,
  });
  logClientStep("info", "startup.db_storage_prepare", "success", "client DB storage prepare finished", {
    target: { clientId: config.clientId, dbPath },
  });
  const workspaceOperationGate = new WorkspaceOperationGate();
  let db!: ClientDb;
  let dbOpened = false;
  let clientDbReader: ClientDbReaderService | null = null;
  let localEventRelay: ReturnType<typeof createLocalEventRelay> | undefined;
  try {
    try {
      logClientStep("info", "startup.db_open", "start", "client DB open started", {
        target: { clientId: config.clientId, dbPath },
      });
      db = openClientDb({ dbPath, resolveEngineModels: getRuntimeEngineModelsIfReady, localCanonicalEvents: true, workspaceOperationGate,
        // 事务中只排队，下一批按已提交事实复核；未激活范围不扫描。
        onRelayInvalidation: scopeKey => localEventRelay?.scheduleFlush(true, scopeKey) });
      dbOpened = true;
      // 工作区运行目录与配置目录合并；必须在任何工作区库打开前完成。
      try {
        migrateLegacyWorkspaceRuntimeDirectories(db.workspaces.list().map(workspace => workspace.path));
        logClientStep("info", "startup.workspace_runtime_migration", "success", "legacy workspace runtime directories merged", {
          target: { clientId: config.clientId }, workspaceCount: db.workspaces.list().length,
        });
      } catch (error) {
        logClientStep("error", "startup.workspace_runtime_migration", "fail", "workspace runtime directory migration failed", {
          target: { clientId: config.clientId }, error: toErrorLogValue(error),
        });
        throw error;
      }
      setEngineModelCatalogCustomModels([
        ...db.engineCustomModels.listEnabledByEngine("claude"),
        ...db.engineCustomModels.listEnabledByEngine("codex"),
      ]);
      confirmPlainClientDbInitialized({
        dbPath,
        accountNamespace: dbStartupContext.accountNamespace!,
        storageScope: dbStartupContext.storageScope,
      });
      logClientStep("info", "startup.db_open", "success", "client DB opened", {
        target: { clientId: config.clientId, dbPath },
      });
    } catch (error) {
      logClientStep("error", "startup.db_open", "fail", "client DB open failed", {
        target: { clientId: config.clientId, dbPath },
        error: toErrorLogValue(error),
      });
      throw error;
    }
    try {
      const boundClientId = readBoundClientId(db);
      if (boundClientId && boundClientId !== config.clientId && config.clientIdSource === "hostname") {
        logClientStep("warn", "startup.client_id_recovered", "warn", "client id recovered from local DB binding", {
          target: { clientId: boundClientId, dbPath },
          previousClientId: config.clientId,
          previousClientIdSource: config.clientIdSource,
        });
        config.clientId = boundClientId;
        config.clientIdSource = "db-meta";
      }
      ensureStableClientId(db, config.clientId);
      logClientStep("info", "startup.client_id_verified", "success", "stable client id verified", {
        target: { clientId: config.clientId, dbPath },
      });
    } catch (error) {
      logClientStep("error", "startup.client_id_verified", "fail", "stable client id verification failed", {
        target: { clientId: config.clientId, dbPath },
        error: toErrorLogValue(error),
      });
      throw error;
    }
    if (config.clientIdSource === "db-meta") {
      try {
        saveConfigFile({
          apiKey: config.apiKey,
          serverWs: config.serverWsUrl,
          clientId: config.clientId,
        }, { desktop: Boolean(desktopLifecycle) });
        logClientStep("info", "startup.client_id_config_saved", "success", "recovered client id saved to config", {
          target: { clientId: config.clientId, dbPath },
        });
      } catch (error) {
        logClientStep("error", "startup.client_id_config_saved", "fail", "recovered client id config save failed", {
          target: { clientId: config.clientId, dbPath },
          error: toErrorLogValue(error),
        });
        throw error;
      }
    }
    try {
      logClientStep("info", "startup.db_reader_open", "start", "client DB reader open started", {
        target: { clientId: config.clientId, dbPath },
      });
      clientDbReader = new ClientDbReaderService({
        acquireWorkspaceSource: workspaceId => db.acquireWorkspaceReaderSource(workspaceId),
        dbPath,
        /** 命令owner固定可信租约W；legacy应用查询保原全局诊断。 */
        onDiagnostic: (diagnostic) => {
          const level = diagnostic.outcome === "failed" ? "error" : "info";
          const data = { ...diagnostic, code: diagnostic.errorCode ?? "CLIENT_DB_READER_QUERY_COMPLETE", target: { clientId: config.clientId } };
          if (diagnostic.workspaceId) db.writeWorkspaceLog(diagnostic.workspaceId, { level, tag: "client-db-reader", message: "client DB reader query diagnostic", data });
          else logger[level]("client-db-reader", "client DB reader query diagnostic", data);
        },
        onFatalError: (error) => {
          logClientStep("error", "client_db_reader.fatal", "fail", "client DB reader entered fatal state", {
            target: { clientId: config.clientId },
            errorCode: error.code,
            requestId: typeof error.details.requestId === "string" ? error.details.requestId : null,
            errorDetails: error.details,
          });
        },
      });
      if (!clientDbReader) throw new Error("Client DB reader startup completed without a reader");
      await clientDbReader.ready();
      logClientStep("info", "startup.db_reader_open", "success", "client DB reader ready", {
        target: { clientId: config.clientId, dbPath },
      });
    } catch (error) {
      logClientStep("error", "startup.db_reader_open", "fail", "client DB reader open failed", {
        target: { clientId: config.clientId, dbPath },
        error: toErrorLogValue(error),
      });
      throw error;
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const readerToClose = clientDbReader as ClientDbReaderService | null;
    if (readerToClose) {
      try {
        await readerToClose.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        logClientStep("error", "startup.db_reader_close", "fail", "client DB reader cleanup failed", {
          target: { clientId: config.clientId, dbPath },
          error: toErrorLogValue(cleanupError),
        });
      }
    }
    if (dbOpened) {
      try {
        db.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        logClientStep("error", "startup.db_close", "fail", "client DB cleanup failed", {
          target: { clientId: config.clientId, dbPath },
          error: toErrorLogValue(cleanupError),
        });
      }
    }
    try {
      clientProcessLock.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
      logClientStep("error", "startup.process_lock_release", "fail", "client process lock cleanup failed", {
        target: { clientId: config.clientId, dbPath },
        error: toErrorLogValue(cleanupError),
      });
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Client startup cleanup failed", { cause: error });
    }
    throw error;
  }
  // 外层启动事务已在 reader.ready() 前校验非空；此处只固定成功生命周期引用。
  markCurrentClientDaemonStartup("services", { clientId: config.clientId });
  const openedClientDbReader = clientDbReader as ClientDbReaderService;
  let databaseWriter: ClientDbWriterService | undefined;
  let eventPipeline: ReturnType<typeof createLocalEventPipeline> | undefined;
  /** 启动期保留原同步入口；Writer就绪后所有旧DB短段交由唯一协调器。 */
  const withDatabase = async <T>(requestId: string, operation: () => T): Promise<T> =>
    databaseWriter ? databaseWriter.withLegacyDatabase(requestId, operation) : operation();
  const remoteDataDemands = new Map<string, import("@codeflowai/shared").RemoteDataDemand>();
  let authorizedRelayScopes: import("@codeflowai/shared").ConversationRelayScope[] = [];
  /** 仅匹配当前Server已准入的需求；本地提醒记录不依赖此云端发送条件。 */
  const hasRemoteDataDemand = (kind: import("@codeflowai/shared").RemoteDataDemandKind, workspaceId: string): boolean =>
    [...remoteDataDemands.values()].some(demand => demand.kind === kind && demand.scope.workspaceId === workspaceId);
  /** 授权与需求分别保存，旧scope/代次控制帧不能借新账号启动传输。 */
  const applyRemoteDataDemand = (demand: import("@codeflowai/shared").RemoteDataDemand, active: boolean): void => {
    if (!active) {
      const current = remoteDataDemands.get(demand.demandId);
      if (current?.generation === demand.generation) remoteDataDemands.delete(demand.demandId);
      return;
    }
    if (!demand.requestId || !demand.demandId || !Number.isSafeInteger(demand.generation) || demand.generation < 1
      || !["conversation", "metrics", "code-attribution", "reminders"].includes(demand.kind)
      || !Array.isArray(demand.recipientUserIds) || demand.recipientUserIds.some(id => typeof id !== "string" || !id)
      || !(authorizedRelayScopes.some(scope => Object.keys(scope).every(key => (demand.scope as any)[key] === (scope as any)[key]))
        || demand.scope.kind === "personal" && demand.scope.clientId === config.clientId
          && demand.scope.userId === currentClientHello?.userSummary?.userId
          && demand.scope.enterpriseId === currentClientHello?.userSummary?.enterpriseId && workspaces.has(demand.scope.workspaceId))) {
      throw new Error("REMOTE_DATA_DEMAND_SCOPE_INVALID");
    }
    remoteDataDemands.set(demand.demandId, structuredClone(demand));
  };
  const codeAttributionTransport = desktopLifecycle ? null : createCodeAttributionHttpTransport({ serverWsUrl: config.serverWsUrl, apiKey: config.apiKey });
  const codeAttributionSyncWorker = codeAttributionTransport ? new CodeAttributionSyncWorker(
    db,
    codeAttributionTransport,
    {
      leaseOwner: `code-attribution-sync:${config.clientId}:${process.pid}`,
      listWorkspaceIds: () => Array.from(workspaces.keys()).filter(id => hasRemoteDataDemand("code-attribution", id) && !workspaceOperationGate.getMigrationOperationId(id)),
      hasDemand: workspaceId => hasRemoteDataDemand("code-attribution", workspaceId),
      withDatabase: operation => withDatabase("code-attribution-sync", operation),
      logger: {
        info: (bindings, message) => logger.info("code-attribution-sync", message, bindings),
        warn: (bindings, message) => logger.warn("code-attribution-sync", message, bindings),
        error: (bindings, message) => logger.error("code-attribution-sync", message, bindings),
      },
      /** Worker 保留原失败及W诊断，关闭时由 stop 显式消费。 */
      onFatalError: () => { markCurrentClientDaemonStartup("degraded"); },
    },
  ) : null;
  const codeAttributionRetentionWorker = codeAttributionTransport ? new CodeAttributionRetentionWorker(
    db,
    codeAttributionTransport,
    {
      leaseOwner: `code-attribution-retention:${config.clientId}:${process.pid}`,
      listWorkspaceIds: () => Array.from(workspaces.keys()).filter(id => hasRemoteDataDemand("code-attribution", id) && !workspaceOperationGate.getMigrationOperationId(id)),
      hasDemand: workspaceId => hasRemoteDataDemand("code-attribution", workspaceId),
      withDatabase: operation => withDatabase("code-attribution-retention", operation),
      logger: {
        info: (bindings, message) => logger.info("code-attribution-retention", message, bindings),
        warn: (bindings, message) => logger.warn("code-attribution-retention", message, bindings),
        error: (bindings, message) => logger.error("code-attribution-retention", message, bindings),
      },
      /** Worker 保留原失败及W诊断，关闭时由 stop 显式消费。 */
      onFatalError: () => { markCurrentClientDaemonStartup("degraded"); },
    },
  ) : null;
  const deviceIdentity = await prepareClientDeviceIdentity({
    config,
    clientVersion: selfVersion,
    startupContext: dbStartupContext,
  });
  logClientStep("info", "startup.device_identity_ready", "success", "client device identity ready", {
    target: { clientId: config.clientId, deviceId: deviceIdentity.deviceId },
    authMode: deviceIdentity.authMode,
    clientIdSource: config.clientIdSource,
  });
  const threads = new ThreadStore();
  const runtime = createEventIndexRuntime();
  const frozenBeforeSnapshots = new WeakMap<ConversationEventInput, FrozenFileBeforeSnapshot[]>();
  const frozenAfterSnapshots = new WeakMap<ConversationEventInput, FrozenFileAfterSnapshot[]>();
  logClientStep("info", "startup.thread_store_ready", "success", "thread store initialized", {
    target: { clientId: config.clientId },
  });
  /** 原缓冲持有失败并阻断所属W；诊断已写W，此处只暴露运行时未就绪。 */
  const onPersistenceBufferError = (): void => {
    markCurrentClientDaemonStartup("degraded");
  };
  const conversationEventAckBuffer = createConversationEventAckBuffer(db, { onError: onPersistenceBufferError, withLegacyDatabase: withDatabase });
  const rawEventAckBuffer = createRawEventAckBuffer(db, { onError: onPersistenceBufferError, withLegacyDatabase: withDatabase });
  const threadTouchBuffer = createThreadTouchBuffer(db, { onError: onPersistenceBufferError, withLegacyDatabase: withDatabase });
  /** 真实请求与事件写入前观察原失败；不会扫描或打开其他工作区。 */
  const assertWorkspacePersistenceAvailable = (workspaceId: WorkspaceId): void => {
    eventPipeline?.assertNoFailure(workspaceId);
    conversationEventAckBuffer.assertNoFailure(workspaceId);
    rawEventAckBuffer.assertNoFailure(workspaceId);
    threadTouchBuffer.assertNoFailure(workspaceId);
  };
  let dbCleanup: ClientDbCleanupService | null = null;
  /** 严格排空一个持久化缓冲；无进展时显式失败。 */
  const flushPersistenceBuffer = async (
    label: string,
    buffer: { getPendingCount: () => number; flush: () => void | Promise<void> },
  ): Promise<void> => {
    while (buffer.getPendingCount() > 0) {
      const before = buffer.getPendingCount();
      await buffer.flush();
      const after = buffer.getPendingCount();
      if (after >= before) throw new Error(`${label} 队列无法同步排空`);
    }
  };
  /** 同步排空回滚依赖的 canonical/raw ACK 队列。 */
  const flushRollbackEvidence = async (): Promise<void> => {
    await eventPipeline?.flush();
    await flushPersistenceBuffer("conversation event ACK", conversationEventAckBuffer);
    await flushPersistenceBuffer("raw event ACK", rawEventAckBuffer);
  };
  /** 只排空 canonical ACK，避免隔离单类事件时牵连另一条证据队列。 */
  const flushConversationEventEvidence = async (): Promise<void> => {
    await eventPipeline?.flush();
    await flushPersistenceBuffer("conversation event ACK", conversationEventAckBuffer);
  };
  /** 只排空 raw ACK；索引失败可隔离，但原始证据必须先耐久化。 */
  const flushRawEventEvidence = async (): Promise<void> => {
    await eventPipeline?.flush();
    await flushPersistenceBuffer("raw event ACK", rawEventAckBuffer);
  };
  /** 同步排空会话删除和历史清理依赖的全部落库缓冲。 */
  const flushEventPersistence = async (): Promise<void> => {
    await flushRollbackEvidence();
    await flushPersistenceBuffer("thread touch", threadTouchBuffer);
  };
  logClientStep("info", "startup.diagnostics_ready", "success", "diagnostic buffers initialized", {
    target: { clientId: config.clientId },
    pendingConversationEventAcks: conversationEventAckBuffer.getPendingCount(),
    pendingRawEventAcks: rawEventAckBuffer.getPendingCount(),
    pendingThreadTouches: threadTouchBuffer.getPendingCount(),
  });
  let transport: WsTransport | null = null;
  let desktopCloudAccount: DesktopCloudAccount | undefined;
  const retiredCredentialDrains = new Set<Promise<void>>();
  const retiredCredentialFailures: unknown[] = [];
  let lastEventLoopLagSnapshot: EventLoopLagSnapshot | null = null;
  let lastEventLoopLagObservedAt = 0;
  /** 汇总 WS 入站与最近 lag，供两类后台清理共用同一压力口径。 */
  const getRuntimePressure = () => {
    const now = Date.now();
    const inbound = transport?.getInboundPressureSnapshot(now) ?? {
      capturedAt: now,
      queuedMessages: 0,
      queuedBytes: 0,
      oldestQueuedMs: 0,
      activeHandlers: 0,
      oldestActiveHandlerMs: 0,
      maxHandlerDurationMs: 0,
      overHighWater: false,
      messageTypes: {},
    };
    const lag = lastEventLoopLagSnapshot && now - lastEventLoopLagObservedAt <= 30_000
      ? lastEventLoopLagSnapshot
      : null;
    const reasons: string[] = [];
    if (inbound.queuedMessages > 0) reasons.push("ws_inbound_queued");
    if (inbound.activeHandlers > 0) reasons.push("ws_handler_active");
    if ((lag?.p99Ms ?? 0) >= 100 || (lag?.maxMs ?? 0) >= 250) reasons.push("event_loop_lag");
    return {
      shouldDefer: reasons.length > 0,
      reasons,
      inboundMessages: inbound.queuedMessages,
      inboundBytes: inbound.queuedBytes,
      activeHandlers: inbound.activeHandlers,
      eventLoopLagMaxMs: lag?.maxMs ?? 0,
      eventLoopLagP99Ms: lag?.p99Ms ?? 0,
    };
  };
  const rawEventRetention = createRawEventRetentionWorker({
    /** 全局维护沿当前可信源逐 W 删除，迁移独占库由原 owner 暂缓。 */
    deleteBeforeSeq: (cutoff, limit) => {
      return deleteWorkspaceRawEventsBeforeSeq({ db, workspaces, gate: workspaceOperationGate }, cutoff, limit);
    },
  }, {
    batchSize: RAW_EVENT_RETENTION_BATCH_SIZE,
    batchDelayMs: RAW_EVENT_RETENTION_BATCH_DELAY_MS,
    withLegacyDatabase: withDatabase,
    getRuntimePressure,
    onDeferred: ({ cutoffSeqExclusive, pressure }) => {
      logger.info("raw-events", "retention cleanup deferred for runtime pressure", {
        event: "cleanup_deferred_for_runtime_pressure",
        cleanupType: "raw_event_retention",
        cutoffSeqExclusive,
        pressure,
      });
    },
    onResumed: ({ cutoffSeqExclusive, pressure }) => {
      logger.info("raw-events", "retention cleanup resumed after runtime pressure", {
        event: "cleanup_resumed_after_runtime_pressure",
        cleanupType: "raw_event_retention",
        cutoffSeqExclusive,
        pressure,
      });
    },
    onComplete: (result) => {
      logger.info("raw-events", "retention cleanup completed", {
        event: "raw_event_retention_completed",
        ...result,
      });
    },
    onError: () => markCurrentClientDaemonStartup("degraded"),
  });
  /** 按服务端接收时间启动后台保留清理；运行中的重复触发会被去重。 */
  const triggerRawEventRetention = (): void => {
    runtime.trackWork(async () => {
      rawEventRetention.trigger(Date.now() - RAW_EVENT_RETENTION_MS);
      await rawEventRetention.waitIdle();
    }, () => markCurrentClientDaemonStartup("degraded"), "raw-event-retention");
  };
  let rawEventRetentionStartTimer: ReturnType<typeof setTimeout> | null = null;
  let rawEventRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let rawEventRetentionScheduled = false;
  /** 首次握手后错开启动清理，后续保持每小时触发并由 worker 去重。 */
  const scheduleRawEventRetention = (): void => {
    if (rawEventRetentionScheduled) return;
    rawEventRetentionScheduled = true;
    rawEventRetentionStartTimer = setTimeout(() => {
      rawEventRetentionStartTimer = null;
      triggerRawEventRetention();
      rawEventRetentionTimer = setInterval(triggerRawEventRetention, RAW_EVENT_RETENTION_CHECK_MS);
      rawEventRetentionTimer.unref?.();
    }, RAW_EVENT_RETENTION_START_DELAY_MS);
    rawEventRetentionStartTimer.unref?.();
    logClientStep("info", "startup.raw_event_retention", "success", "raw event retention cleanup scheduled after client ready", {
      target: { clientId: config.clientId },
      startDelayMs: RAW_EVENT_RETENTION_START_DELAY_MS,
      rawEventRetentionMs: RAW_EVENT_RETENTION_MS,
      batchSize: RAW_EVENT_RETENTION_BATCH_SIZE,
      batchDelayMs: RAW_EVENT_RETENTION_BATCH_DELAY_MS,
    });
  };
  logClientStep("info", "startup.raw_event_retention", "success", "raw event retention cleanup deferred until client ready", {
    target: { clientId: config.clientId },
    startDelayMs: RAW_EVENT_RETENTION_START_DELAY_MS,
    rawEventRetentionMs: RAW_EVENT_RETENTION_MS,
    batchSize: RAW_EVENT_RETENTION_BATCH_SIZE,
    batchDelayMs: RAW_EVENT_RETENTION_BATCH_DELAY_MS,
  });
  const stopEventLoopLagMonitor = startEventLoopLagMonitor({
    onSample: (snapshot) => {
      lastEventLoopLagSnapshot = snapshot;
      lastEventLoopLagObservedAt = Date.now();
    },
    onLag: (snapshot) => {
      logClientStep("warn", "runtime.event_loop_lag", "warn", "event loop lag detected", {
        target: { clientId: config.clientId },
        snapshot,
      });
      logger.warn("event-loop", "lag detected", snapshot);
    },
  });
  logClientStep("info", "startup.event_runtime_ready", "success", "event runtime initialized", {
    target: { clientId: config.clientId },
    rawEventRetentionMs: RAW_EVENT_RETENTION_MS,
    rawEventRetentionCheckMs: RAW_EVENT_RETENTION_CHECK_MS,
    keepFullEventOutput,
  });
  const eventFlowMonitor = createEventFlowMonitor({
    onFlush: (snapshot) => {
      logger.info("event-flow", "provider to ACK flow aggregated", {
        event: "provider_event_flow_window",
        ...snapshot,
        correlationBoundary: "provider notifications without native id remain unmapped",
      });
    },
  });
  const apiResponseDispatches = new Map<string, WsSendJsonResult>();
  let localEventPersistence: ReturnType<typeof createLocalEventPersistence> | undefined;
  /** 远程失败关闭本次投递并触发原连接重建，本地 canonical 提交不回滚。 */
  const failLocalEventRelay = (error: unknown, context?: { generation: number; delivery: unknown }): void => {
    logger.error("local-event-relay", "remote canonical delivery failed; reconnect required", {
      errorCode: "LOCAL_EVENT_RELAY_FAILED", requestId: desktopRequestId, clientId: config.clientId,
      connectionGeneration: context?.generation ?? serverMessageConnectionGeneration, delivery: context?.delivery ?? null,
      rootCause: toErrorLogValue(error),
    });
    localEventRelay?.disconnect(context?.generation ?? serverMessageConnectionGeneration);
    if (desktopCloudAccount) desktopCloudAccount.disconnect(new Error("LOCAL_EVENT_RELAY_FAILED", { cause: error }));
    else transport?.reconnect("Canonical relay reconciliation required");
  };
  /** 合并持久事实变化的唤醒，投递扫描不阻塞本机请求响应。 */
  const flushLocalEventRelay = (restart = false): void => {
    localEventRelay?.scheduleFlush(restart);
  };
  /** 提醒准入和发送共用当前账号的 Host 授权；省略共享 ID 仅用于工作区脏标记。 */
  const hasDesktopReminderScope = (workspaceId: WorkspaceId, sharedWorkspaceId?: string | null): boolean => {
    const owner = desktopCloudAccount?.getOwner();
    return Boolean(owner && desktopHostScopes.some(scope => scope.clientId === config.clientId && scope.userId === owner.ownerUserId
      && scope.workspaceId === workspaceId && (sharedWorkspaceId === undefined || scope.sharedWorkspaceId === sharedWorkspaceId)));
  };
  /** 桌面事实先本地提交；relay来源明确走远程投递，避免个人清理通知被本机分支截获。 */
  const sendToServer = (message: ClientToServerMessage, fromRelay = false): WsSendJsonResult => {
    const outbound = sanitizeClientToServerMessage(message, { keepFullOutput: keepFullEventOutput });
    if (outbound.t === "conversation.event" || outbound.t === "raw.event") assertWorkspacePersistenceAvailable(outbound.event.workspaceId);
    if (outbound.t === "conversation.event" || outbound.t === "raw.event") {
      try {
        if (!localEventPersistence) throw new Error("DESKTOP_EVENT_RUNTIME_NOT_READY");
        const persistence = localEventPersistence;
        const bytes = Buffer.byteLength(JSON.stringify(outbound), "utf8");
        if (eventPipeline) {
          const active = runtime.activeTurnByThreadId.get(outbound.event.threadId);
          const beforeSnapshots = message.t === "conversation.event" ? frozenBeforeSnapshots.get(message.event) : undefined;
          const afterSnapshots = message.t === "conversation.event" ? frozenAfterSnapshots.get(message.event) : undefined;
          const snapshotTurns = new Set([...(beforeSnapshots ?? []), ...(afterSnapshots ?? [])].map(snapshot => snapshot.turnId));
          if (snapshotTurns.size > 1) throw new Error("LOCAL_EVENT_SNAPSHOT_SCOPE_INVALID");
          const turnId = outbound.t === "raw.event" ? outbound.event.clientTurnId ?? active?.turnId ?? null
            : snapshotTurns.values().next().value ?? (String((outbound.event.payload as { turnId?: unknown }).turnId ?? active?.turnId ?? "") || null);
          eventPipeline.enqueue(outbound.t === "conversation.event" ? { ...outbound, beforeSnapshots, afterSnapshots } : outbound,
            turnId, threads.get(outbound.event.threadId)?.lifecycleVersion ?? 0);
          return { accepted: true, messageType: outbound.t, readyState: null, bufferedAmount: null, bytes, reason: null, queuedAt: Date.now(), callbackError: null };
        }
        return db.withWorkspaceCoreRepos(outbound.event.workspaceId, () => {
          const committed = persistence.persist(outbound);
          if (desktopLifecycle && committed.t === "conversation.event"
            && isDesktopLocalThreadAssetExecution(config.clientId, workspaces, db.forWorkspace(committed.event.workspaceId), committed.event.threadId)) {
            desktopLifecycle.publishEvent(committed);
          }
          if (committed.t === "conversation.event") flushLocalEventRelay();
          const result: WsSendJsonResult = { accepted: true, messageType: outbound.t, readyState: null,
            bufferedAmount: null, bytes, reason: null, queuedAt: Date.now(), callbackError: null };
          return result;
        });
      } catch (error) {
        try {
          db.writeWorkspaceLog(outbound.event.workspaceId, { level: "error", tag: "local-events", message: "local event processing failed", data: {
            code: "LOCAL_EVENT_PROCESSING_FAILED", requestId: desktopRequestId, clientId: config.clientId,
            workspaceId: outbound.event.workspaceId, threadId: outbound.event.threadId,
            messageType: outbound.t, eventType: outbound.t === "conversation.event" ? outbound.event.type : outbound.event.source,
            rootCause: describeWorkspaceApiFailure(error).rootCause,
          } });
        } catch (diagnosticError) { throw new AggregateError([error, diagnosticError], "LOCAL_EVENT_PROCESSING_LOG_FAILED", { cause: error }); }
        throw error;
      }
    }
    if (desktopLifecycle && outbound.t === "orchestration.event") {
      const instance = db.forWorkspace(outbound.workspaceId).orchInstances.get(outbound.event.instanceId, { strictScope: true });
      if (instance?.workspaceId === outbound.workspaceId && isDesktopLocalAssetExecution(config.clientId, workspaces, instance)) {
        desktopLifecycle.publishEvent(outbound);
        return { accepted: true, messageType: outbound.t, readyState: null, bufferedAmount: null,
          bytes: 0, reason: null, queuedAt: Date.now(), callbackError: null };
      }
    }
    if (desktopLifecycle && outbound.t === "thread.queue.changed"
      && isDesktopLocalThreadAssetExecution(config.clientId, workspaces, db.forWorkspace(outbound.workspaceId), outbound.threadId)) {
      desktopLifecycle.publishEvent(outbound);
      return { accepted: true, messageType: outbound.t, readyState: null, bufferedAmount: null,
        bytes: 0, reason: null, queuedAt: Date.now(), callbackError: null };
    }
    if (outbound.t === "thread.history.cleaned" && !outbound.delivery && !fromRelay) {
      // 删除屏障已与 SQLite 删除同事务记录；正文及失效只能由授权 pump 发出。
      flushLocalEventRelay(true);
      return { accepted: true, messageType: outbound.t, readyState: null, bufferedAmount: null,
        bytes: 0, reason: null, queuedAt: Date.now(), callbackError: null };
    }
    if (desktopLifecycle) {
      // 全局索引和脏标记也会发提醒，发送前统一核当前 Host 范围，避免旧账号数据串线。
      if (outbound.t === "reminder.completionNotification" || outbound.t === "reminder.actionNotification" || outbound.t === "reminders.changed") {
        const workspaceId = outbound.t === "reminders.changed" ? outbound.workspaceId : outbound.notification.workspaceId;
        const sharedWorkspaceId = outbound.t === "reminders.changed" ? undefined : outbound.notification.sharedWorkspaceId ?? null;
        if (!hasDesktopReminderScope(workspaceId, sharedWorkspaceId)) {
          return { accepted: false, messageType: outbound.t, readyState: null, bufferedAmount: null, bytes: 0,
            reason: "DESKTOP_HOST_REMINDER_SCOPE_REQUIRED", queuedAt: Date.now(), callbackError: null };
        }
      }
      if (desktopCloudAccount) return desktopCloudAccount.send(outbound);
      return { accepted: false, messageType: outbound.t, readyState: null, bufferedAmount: null, bytes: 0, reason: "desktop cloud unavailable", queuedAt: Date.now(), callbackError: null };
    }
    if (!transport) {
      return {
        accepted: false,
        messageType: outbound.t,
        readyState: null,
        bufferedAmount: null,
        bytes: 0,
        reason: "transport unavailable",
        queuedAt: Date.now(),
        callbackError: null,
      };
    }
    const result = transport.sendJson(outbound);
    if (result.accepted) eventFlowMonitor.recordOutbound(outbound, result.bytes);
    if (outbound.t === "api.res") {
      apiResponseDispatches.set(String(outbound.id), result);
    }
    return result;
  };
  const takeApiResponseDispatch = (id: string): WsSendJsonResult | null => {
    const existing = apiResponseDispatches.get(id) ?? null;
    apiResponseDispatches.delete(id);
    return existing;
  };
  const rollbackEvidenceFence = createRollbackEvidenceFence({ send: sendToServer });
  const reminderDelivery = createReminderDeliveryOwner({ send: sendToServer, timeoutMs: 30_000 });
  const reminderCompletionNotifier = createServerReminderNotifier({
    sendToServer,
    notifyOnServer: reminderDelivery.notify,
    canSend: notification => hasRemoteDataDemand("reminders", notification.workspaceId)
      && (!desktopLifecycle || hasDesktopReminderScope(notification.workspaceId, notification.sharedWorkspaceId ?? null)),
  });
  const pendingReminderDirtyWorkspaces = new Set<WorkspaceId>();
  let reminderDirtyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 提醒先通知本机；云副本失败只撤销云连接，不影响已提交的本机提醒。 */
  const flushReminderDirtyWorkspaces = (): void => {
    reminderDirtyTimer = null;
    const workspaceIds = [...pendingReminderDirtyWorkspaces];
    const invalidWorkspaces: Error[] = [];
    for (const workspaceId of workspaceIds) {
      if (desktopLifecycle) {
        if (!workspaceId.startsWith(`${config.clientId}:`) || !workspaces.has(workspaceId)) {
          pendingReminderDirtyWorkspaces.delete(workspaceId);
          const error = Object.assign(new Error("提醒目标工作区已失效"), { code: "DESKTOP_REMINDER_WORKSPACE_INVALID", workspaceId });
          invalidWorkspaces.push(error);
          logger.error("reminders", "dirty workspace is no longer available", { code: error.code, requestId: `reminders:${workspaceId}`,
            clientId: config.clientId, workspaceId, rootCause: error.message });
          continue;
        }
        desktopLifecycle.publishEvent({ t: "reminders.changed", workspaceId });
        pendingReminderDirtyWorkspaces.delete(workspaceId);
        if (!hasDesktopReminderScope(workspaceId)) continue;
      }
      if (!hasRemoteDataDemand("reminders", workspaceId)) {
        pendingReminderDirtyWorkspaces.delete(workspaceId);
        continue;
      }
      const result = sendToServer({ t: "reminders.changed", workspaceId } satisfies ClientToServerMessage);
      if (!result.accepted) {
        try {
          db.writeWorkspaceLog(workspaceId, { level: "error", tag: "reminders", message: "dirty notification dispatch rejected", data: {
            code: "REMINDER_DIRTY_DISPATCH_REJECTED", requestId: `reminders:${workspaceId}`, workspaceId, reason: result.reason, readyState: result.readyState,
          } });
        } catch (error) { throw new AggregateError([result, error], "REMINDER_DIRTY_DISPATCH_LOG_FAILED", { cause: result }); }
        if (desktopLifecycle && desktopCloudAccount) {
          desktopCloudAccount.disconnect(Object.assign(new Error("提醒云端通知未被接受"), { code: "REMINDER_DIRTY_DISPATCH_REJECTED", workspaceId, reason: result.reason }));
          continue;
        }
        throw result;
      }
      pendingReminderDirtyWorkspaces.delete(workspaceId);
    }
    if (invalidWorkspaces.length) throw new AggregateError(invalidWorkspaces, "DESKTOP_REMINDER_WORKSPACES_FAILED");
  };

  /** 标记某工作区提醒数据已变化，由真实提醒数据源调用。 */
  const markReminderDirty = (workspaceId: WorkspaceId): void => {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim() as WorkspaceId;
    if (!normalizedWorkspaceId) return;
    pendingReminderDirtyWorkspaces.add(normalizedWorkspaceId);
    if (reminderDirtyTimer) return;
    reminderDirtyTimer = setTimeout(() => runtime.trackWork(async () => flushReminderDirtyWorkspaces(), () => markCurrentClientDaemonStartup("degraded"), "reminder-dirty-flush"), 120);
    reminderDirtyTimer.unref?.();
  };

  // 统一给旧格式 workspaceId 加 clientId 前缀，已命名空间化的 ID 保持原样。
  const prefixWorkspaceId = (id: string) => {
    return prefixLocalWorkspaceId(config.clientId, id) as WorkspaceId;
  };

  // 数据迁移：给旧 workspaceId（无 clientId: 前缀的）批量加前缀
  migrateWorkspaceIdPrefix(db, config.clientId);

  if (db.workspaces.count() === 0) {
    if (!config.workspaces.length) {
      logger.info("client", "workspace store empty and startup config has no workspace; skipping seed");
      logClientStep("info", "startup.workspace_seed", "skip", "workspace seed skipped: no startup workspaces", {
        target: { clientId: config.clientId },
        workspaceCount: 0,
      });
    } else {
      logger.info("client", "workspace store empty; seeding from startup config", {
        workspaceCount: config.workspaces.length,
      });
      logClientStep("warn", "startup.workspace_seed", "start", "workspace store empty; seeding from startup config", {
        target: { clientId: config.clientId },
        workspaceCount: config.workspaces.length,
      });
      for (const w of config.workspaces) {
        const prefixedId = prefixWorkspaceId(w.id);
        db.workspaces.upsert({ id: prefixedId, title: w.label ?? String(w.id), path: w.path });
      }
      logClientStep("info", "startup.workspace_seed", "success", "workspace store seeded", {
        target: { clientId: config.clientId },
        workspaceCount: config.workspaces.length,
      });
    }
  }

  const workspaceMigrationRecovery = await recoverWorkspaceMigrationsBeforeMap({
    db,
    requestId: `startup-${process.pid}`,
  });
  const blockedWorkspaceIds = new Set(workspaceMigrationRecovery.blockedWorkspaceIds);
  for (const operation of db.workspaceDirectoryMigrations.listActive()) {
    workspaceOperationGate.restoreMigration(operation.workspaceId, operation.operationId);
  }
  logClientStep(
    blockedWorkspaceIds.size > 0 ? "warn" : "info",
    "startup.workspace_migrations_recovered",
    blockedWorkspaceIds.size > 0 ? "warn" : "success",
    "workspace directory migrations recovered before workspace map",
    {
      target: { clientId: config.clientId },
      recoveredOperationIds: workspaceMigrationRecovery.recoveredOperationIds,
      blockedWorkspaceIds: [...blockedWorkspaceIds],
    },
  );

  const startupWorkspaceSelection = await selectStartupWorkspaces(
    db.workspaces.list()
      .filter((workspace) => !blockedWorkspaceIds.has(workspace.id)),
  );
  // Approved degradation: only ENOENT roots are omitted from this process, limiting impact to that workspace.
  // The SQLite row remains for retry after restoring the path or explicit removal; search code=startup_workspace_root_missing_skipped.
  for (const missingWorkspace of startupWorkspaceSelection.missingWorkspaces) {
    logClientStep("warn", "startup.workspace_root", "skip", "missing workspace root skipped for this Client process", {
      code: "startup_workspace_root_missing_skipped",
      requestId: null,
      target: { clientId: config.clientId, workspaceId: missingWorkspace.workspaceId },
      workspacePath: missingWorkspace.workspacePath,
      rootCause: missingWorkspace.cause.message,
      causeCode: missingWorkspace.cause.code,
      recovery: "restore the workspace path and restart Client, or remove the persisted workspace",
    });
  }
  const workspaces = startupWorkspaceSelection.workspaces;
  db.configureWorkspaceLogResolver(workspaceId => workspaces.get(workspaceId) ?? null);
  // 目录恢复与可信工作区选择先完成，再打开运行库；被隔离工作区不创建或修复数据。
  for (const workspaceId of workspaces.keys()) {
    if (workspaceOperationGate.getMigrationOperationId(workspaceId)) continue;
    const scoped = db.forWorkspace(workspaceId);
    const recoveredTasks = new ChatWorkflowRepo(scoped.db).recoverStarts();
    if (recoveredTasks.length) db.writeWorkspaceLog(workspaceId, { level: "info", tag: "chat-workflow", message: "chat workflow starts reconciled", data: {
      code: "CHAT_WORKFLOW_STARTS_RECOVERED", requestId: `startup:${workspaceId}:card-recovery`, workspaceId, recoveredTasks,
    } });
    backfillEventOutputOnce(scoped, { keepFullOutput: keepFullEventOutput });
  }

  logger.info("client", "effective workspaces ready", {
    workspaceCount: workspaces.size,
    workspaces: Array.from(workspaces.entries()).map(([workspaceId, workspacePath]) => ({
      workspaceId,
      workspacePath,
    })),
  });
  logClientStep("info", "startup.workspaces_ready", "success", "effective workspaces ready", {
    target: { clientId: config.clientId },
    workspaceCount: workspaces.size,
    workspaces: Array.from(workspaces.entries()).map(([workspaceId, workspacePath]) => ({
      workspaceId,
      workspacePath,
    })),
  });
  // 启动补齐只操作本次固定集合；安装活动阻止目录迁移并发复制。
  const startupSkillWorkspaces = new Map(workspaces);
  const superpowersInstallTimer = setTimeout(() => {
    if (shutdownRequested) return;
    runtime.trackWork(async () => {
      try {
        for (const [workspaceId, workspacePath] of startupSkillWorkspaces) {
          const release = workspaceOperationGate.beginActivity(workspaceId, { type: "startup_skill_install", resourceId: `startup:${process.pid}` });
          try {
            const result = await installSuperpowersIfMissing({ workspaces: new Map([[workspaceId, workspacePath]]) });
            if (result.failed) throw Object.assign(new Error("启动技能安装未全部成功"), { code: "SUPERPOWERS_INSTALL_FAILED", workspaceId });
            logClientStep("info", "startup.superpowers_install", "success", "startup skills installation completed", {
              requestId: `startup:${process.pid}`, target: { clientId: config.clientId, workspaceId }, ...result,
            });
          } finally { release(); }
        }
      } catch (error) {
        logClientStep("error", "startup.superpowers_install", "fail", "superpowers skills silent install failed", {
          target: { clientId: config.clientId }, code: "SUPERPOWERS_SILENT_INSTALL_FAILED", error: toErrorLogValue(error),
        });
        throw error;
      }
    }, () => markCurrentClientDaemonStartup("degraded"), "superpowers-install");
  }, 30_000);
  superpowersInstallTimer.unref?.();
  const workspacePathIndex = new WorkspacePathIndexService({ ...config.workspacePathIndex, writeWorkspaceLog: (workspaceId, entry) => db.writeWorkspaceLog(workspaceId, entry) });
  let workspacePathIndexWarmupQueued = false;
  /** 预热失败保在原索引/事件尾链，标记未就绪并交关闭owner消费。 */
  const scheduleWorkspacePathIndexWarmup = (): void => {
    if (workspacePathIndexWarmupQueued) return;
    workspacePathIndexWarmupQueued = true;
    const immediate = setImmediate(() => {
      workspacePathIndexWarmupQueued = false;
      if (shutdownRequested) return;
      runtime.trackWork(async () => workspacePathIndex.scheduleWarmup(workspaces), () => markCurrentClientDaemonStartup("degraded"), "workspace-path-index-warmup");
    });
    immediate.unref?.();
  };
  const builtInRelayCredentials = createBuiltInRelayCredentialService({
    withLegacyDatabase: withDatabase,
    repo: db.engineKeys, getOwner: () => desktopCloudAccount?.getOwner() ?? null,
    assertOwner: owner => { if (!desktopCloudAccount) throw new Error("DESKTOP_CLOUD_ACCOUNT_REQUIRED"); desktopCloudAccount.assertOwner(owner); },
    requestEnsure: (owner, request) => { if (!desktopCloudAccount) throw new Error("DESKTOP_CLOUD_ACCOUNT_REQUIRED"); return desktopCloudAccount.requestEnsure(owner, request); },
    releaseOwnerSessions: (owner, keyId) => sessions.releaseInvalidatedBuiltInSessions(owner, keyId),
  });
  /** Session 回调沿原内存执行 owner 取可信工作区，禁止裸 ID 扫库。 */
  const requireRuntimeWorkspace = (threadId: ThreadId): WorkspaceId => {
    const workspaceId = threads.get(threadId)?.workspaceId;
    if (!workspaceId) throw new Error("SESSION_WORKSPACE_SCOPE_REQUIRED");
    return workspaceId;
  };
  const sessions = new ThreadSessionManager({
    withLegacyDatabase: withDatabase,
    waitForEventCapacity: workspaceId => eventPipeline?.waitForCapacity(workspaceId),
    writeWorkspaceLog: (workspaceId, entry) => db.writeWorkspaceLog(workspaceId, entry),
    ...(desktopLifecycle ? { builtInRelayCredentials } : {}),
    workspaces,
    threads,
    clearPersistedSessionBinding: (threadId, expectedSessionId, workspaceId) => {
      if (!workspaceId) throw new Error("SESSION_WORKSPACE_SCOPE_REQUIRED");
      if (expectedSessionId) return db.forWorkspace(workspaceId).threads.clearSessionBindingIfMatches(threadId, expectedSessionId);
      db.forWorkspace(workspaceId).threads.clearSessionId(threadId);
    },
    persistSessionBinding: (threadId, sessionId, sessionCapabilities, workspaceId) => {
      if (!workspaceId) throw new Error("SESSION_WORKSPACE_SCOPE_REQUIRED");
      db.forWorkspace(workspaceId).threads.setSessionBinding(threadId, sessionId, sessionCapabilities);
    },
    persistSessionCapabilitiesIfMatches: (threadId, expectedSessionId, sessionCapabilities, workspaceId) => {
      if (!workspaceId) throw new Error("SESSION_WORKSPACE_SCOPE_REQUIRED");
      return db.forWorkspace(workspaceId).threads.restoreSessionCapabilitiesIfMatches(threadId, expectedSessionId, sessionCapabilities);
    },
    persistCodexStartAttempt: (input) => {
      db.forWorkspace(input.workspaceId).turns.setCodexStartAttempt({
        workspaceId: input.workspaceId,
        threadId: input.threadId as ThreadId,
        turnId: input.clientTurnId,
        clientUserMessageId: input.clientUserMessageId,
        providerThreadId: input.providerThreadId,
        provisionalProviderTurnId: input.provisionalProviderTurnId,
        attemptId: input.attemptId,
        observedAt: input.observedAt,
      });
    },
    /** 旧 Client 与桌面共用来源门禁，空 Key 不能越过持久禁用意图。 */
    resolveCodexRuntimeConfig: () => {
      const active = db.engineKeys.getFirstActiveForEngine("codex");
      if (active) {
        assertEngineKeySourceVerified(active);
        if (desktopLifecycle) return builtInRelayCredentials.resolveCredentials(active);
        if (active.source === "builtin") throw Object.assign(new Error("内置中转凭据需要当前账号重验"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED", keyId: active.id } });
        return { apiKey: active.apiKey, baseUrl: active.baseUrl };
      }
      if (db.engineKeys.isNativeFallbackBlocked("codex") || db.engineKeys.list().some(key => key.engine === "codex" && key.source !== "user_configured")) throw Object.assign(new Error("已有凭据需重新核验，请明确配置凭据"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED" } });
      return null;
    },
    /** 只返回已核验配置，未重验内置材料不能作为旧 Client 的普通密钥。 */
    resolveClaudeCredentials: (providerId) => {
      const key = db.engineKeys.getActive("claude", providerId);
      if (key) {
        assertEngineKeySourceVerified(key);
        if (desktopLifecycle) return builtInRelayCredentials.resolveCredentials(key);
        if (key.source === "builtin") throw Object.assign(new Error("内置中转凭据需要当前账号重验"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED", keyId: key.id } });
        return { apiKey: key.apiKey, baseUrl: key.baseUrl };
      }
      if (db.engineKeys.isNativeFallbackBlocked("claude", providerId) || db.engineKeys.list().some(row => row.engine === "claude" && row.providerId === providerId && row.source !== "user_configured")) throw Object.assign(new Error("已有凭据需重新核验，请明确配置凭据"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED" } });
      return null;
    },
    resolveClaudeModelProvider: (model) => {
      return resolveRuntimeEngineModelProviderId("claude", model);
    },
    /** 状态探测不能把来源不明或失效内置行认作可用凭据。 */
    hasClaudeCredentials: (providerId) => {
      const key = db.engineKeys.getActive("claude", providerId);
      if (!key) {
        if (db.engineKeys.isNativeFallbackBlocked("claude", providerId) || db.engineKeys.list().some(row => row.engine === "claude" && row.providerId === providerId && row.source !== "user_configured")) throw Object.assign(new Error("已有凭据需重新核验，请明确配置凭据"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED" } });
        return false;
      }
      assertEngineKeySourceVerified(key);
      if (key.source === "builtin") {
        if (!desktopLifecycle) throw Object.assign(new Error("内置中转凭据需要当前账号重验"), { code: "CONFLICT", details: { reason: "BUILT_IN_RELAY_REVALIDATION_REQUIRED", keyId: key.id } });
        builtInRelayCredentials.resolveCredentials(key);
      }
      return Boolean(key.source === "builtin" || key.apiKey);
    },
    assertCodexMutationAllowed: (threadId) => {
      const unresolved = db.forWorkspace(requireRuntimeWorkspace(threadId)).rollbacks.findLatestUnresolvedByThread(threadId);
      if (!unresolved) return;
      throw Object.assign(
        new Error(
          `存在未确认的 Codex 历史回滚，拒绝启动新请求（threadId=${threadId}, rollbackId=${unresolved.id}, status=${unresolved.result}）`,
        ),
        { code: "rollback_reconciliation_required" },
      );
    },
    getThreadInputActionHmacKey: () => getOrCreateThreadInputActionHmacKey(db.db),
    sessionIdleCleanup: config.sessionIdleCleanup,
  });
  logClientStep("info", "startup.thread_sessions_ready", "success", "thread session manager initialized", {
    target: { clientId: config.clientId },
    workspaceCount: workspaces.size,
    sessionIdleCleanup: config.sessionIdleCleanup,
  });
  /** 发布失败写入原工作区日志并中止该终端，不伪造已送达。 */
  const publishLocalTerminalEvent = (event: import("@codeflowai/shared").DesktopTerminalEvent): void => {
    if (!desktopLifecycle) throw new Error("DESKTOP_TERMINAL_LOCAL_CHANNEL_REQUIRED");
    const workspaceId = event.t === "terminal.created" ? event.terminal.workspaceId : event.workspaceId;
    const terminalId = event.t === "terminal.created" ? event.terminal.id : "terminalId" in event ? event.terminalId ?? null : null;
    try { desktopLifecycle.publishEvent(event); }
    catch (cause) {
      try {
        db.writeWorkspaceLog(workspaceId as WorkspaceId, { level: "error", tag: "terminal", message: "terminal local event publish failed",
          data: { errorCode: "TERMINAL_LOCAL_EVENT_PUBLISH_FAILED", messageType: event.t, workspaceId, terminalId,
            requestId: "requestId" in event ? event.requestId ?? null : null, rootCause: toErrorLogValue(cause) } });
      } catch (logError) { throw new AggregateError([cause, logError], "TERMINAL_LOCAL_EVENT_PUBLISH_FAILED", { cause }); }
      throw Object.assign(new Error("终端本机事件发布失败", { cause }), { code: "TERMINAL_LOCAL_EVENT_PUBLISH_FAILED" });
    }
  };
  /** 桌面终端始终直达本机；云端副本失败通过既有账号边界断开并保留诊断。 */
  const publishDesktopTerminalMessage = (message: ClientToServerMessage): void => {
    const cloud = desktopCloudAccount?.getOwner() ? desktopCloudAccount : undefined;
    publishTerminalRuntimeMessage(message, { clientId: config.clientId, publishLocal: publishLocalTerminalEvent,
      ...(cloud ? { cloud: { send: sendToServer, fail(error: Error) {
        const failure = error as Error & { workspaceId: string; terminalId?: string; requestId?: string; code: string; reason?: string };
        cloud.disconnect(error);
        db.writeWorkspaceLog(failure.workspaceId as WorkspaceId, { level: "error", tag: "terminal", message: "terminal cloud event rejected",
          data: { errorCode: failure.code, requestId: failure.requestId ?? `terminal-cloud:${failure.terminalId ?? failure.workspaceId}`,
            clientId: config.clientId, workspaceId: failure.workspaceId, terminalId: failure.terminalId, reason: failure.reason, rootCause: toErrorLogValue(error) } });
      } } } : {}),
    });
  };
  /** 终端投递被拒绝时交还原 PTY owner，禁止把未接受的消息当成已发送。 */
  const sendTerminalMessage = (message: ClientToServerMessage, terminal: { id: string; workspaceId: string }): void => {
    if (desktopLifecycle) {
      publishDesktopTerminalMessage(message);
      return;
    }
    const result = sendToServer(message);
    if (!result.accepted) throw Object.assign(new Error("终端消息未被接受"), {
      code: "TERMINAL_MESSAGE_REJECTED", terminalId: terminal.id, workspaceId: terminal.workspaceId, reason: result.reason,
    });
  };
  const terminalManager = new TerminalManager({
    workspaces,
    writeWorkspaceLog: (workspaceId, entry) => db.writeWorkspaceLog(workspaceId as WorkspaceId, entry),
    onError: (error, terminal) => {
      try { sendTerminalMessage({ t: "terminal.error", terminalId: terminal.id, workspaceId: terminal.workspaceId,
        message: "终端执行失败，请重新创建终端" }, terminal); }
      catch (deliveryError) { throw new AggregateError([error, deliveryError], "终端失败通知未被接受", { cause: error }); }
    },
    isTaskAdmissionPaused: () => desktopLifecycle?.isTaskAdmissionPaused() ?? false,
    onOutput: (terminal, data) => sendTerminalMessage({ t: "terminal.output", terminalId: terminal.id, workspaceId: terminal.workspaceId, data }, terminal),
    onCreated: (terminal, requestId) => sendTerminalMessage({ t: "terminal.created", terminal, requestId }, terminal),
    onExited: (terminal, exitCode) => sendTerminalMessage({ t: "terminal.exited", terminalId: terminal.id, workspaceId: terminal.workspaceId, exitCode }, terminal),
    onForegroundProcessChanged: (terminal, foregroundProcess) => sendTerminalMessage({ t: "terminal.foregroundChanged", terminalId: terminal.id, workspaceId: terminal.workspaceId, foregroundProcess }, terminal),
    persistence: {
      save: (cfg) => db.forWorkspace(cfg.workspaceId).terminalConfigs.insert(cfg),
      remove: (id, wid) => db.forWorkspace(wid).terminalConfigs.delete(id),
      updateLabel: (id, label, wid) => db.forWorkspace(wid).terminalConfigs.updateLabel(id, label),
      listByWorkspace: (wid) => db.forWorkspace(wid).terminalConfigs.listByWorkspace(wid),
    },
  });
  logClientStep("info", "startup.terminal_ready", "success", "terminal manager initialized", {
    target: { clientId: config.clientId },
    workspaceCount: workspaces.size,
  });

  let relayPricingCatalog: RelayPricingCatalogSnapshot | null = null;
  /** 单调应用 Server 价格目录，拒绝旧消息回退或同版本内容冲突。 */
  const applyRelayPricingCatalog = (value: unknown): void => {
    const next = requireRelayPricingCatalogSnapshot(value);
    relayPricingCatalog = selectLatestRelayPricingCatalogSnapshot(relayPricingCatalog, next);
  };
  /** 统一发送编排事件到 Server，供引擎和 API 内部启动流程复用。 */
  const emitOrchestrationToServer: NonNullable<ApiHandlerContext["emitOrchestration"]> = (workspaceId, event) => {
    sendToServer({ t: "orchestration.event", workspaceId, event } satisfies ClientToServerMessage);
  };
  const controlledExperiments = new ControlledExperimentExecutor({
    db,
    withLegacyDatabase: withDatabase,
    workspaces,
    sessions,
    isTaskAdmissionPaused: () => desktopLifecycle?.isTaskAdmissionPaused() ?? false,
    onFatalError: (error) => {
      logClientStep("error", "controlled_experiment.persistence_failed", "fail", "controlled experiment run settlement failed; shutting down", {
        target: { clientId: config.clientId },
        error: toErrorLogValue(error),
      });
      shutdown("controlled_experiment_persistence_failed", 1);
    },
  });
  let orchAssetLegacyInstanceBackfill: OrchAssetLegacyInstanceBackfillService | null = null;
  let desktopOrchAssetLegacyInstanceBackfill: OrchAssetLegacyInstanceBackfillService | null = null;
  const orchEngine = new OrchestrationEngine({
    withLegacyDatabase: withDatabase,
    isTaskAdmissionPaused: () => desktopLifecycle?.isTaskAdmissionPaused() ?? false,
    /** 本地定义可执行；历史云端缓存快照始终拒绝恢复或新派发。 */
    assertAssetExecution(instance) {
      const authorization = instance.assetRuntimeSnapshot?.executionAuthorization ?? null;
      if (instance.assetRuntimeSnapshot?.authorityMode === "server" || authorization) {
        throw new OrchAssetLaunchSnapshotError("ASSET_CACHE_EXECUTION_REMOVED", "云端缓存资产执行已移除，请选择本地资产重新开始");
      }
      if (!desktopLifecycle) return;
      if (isDesktopLocalAssetExecution(config.clientId, workspaces, instance)) {
        desktopApiHandlerContext.assertAssetExecution!({ workspaceId: instance.workspaceId,
          root: { assetType: "workflow", assetId: instance.workflowId }, authorization });
      } else {
        apiHandlerContext.assertAssetExecution!({ workspaceId: instance.workspaceId,
          root: { assetType: "workflow", assetId: instance.workflowId }, ...(authorization ? { authorization } : {}) });
      }
    },
    assertWorkspaceWriteAvailable: (workspaceId, instanceId) => {
      assertWorkspacePersistenceAvailable(workspaceId);
      assertChatWorkflowDirectoryAvailable({ db, workspaces, sessions }, workspaceId, instanceId);
    },
    waitWorkspaceWriteAvailable: (workspaceId, instanceId, options) => waitForWorkspaceWriteAvailable({ db, workspaces, sessions, withLegacyDatabase: withDatabase }, workspaceId, instanceId, null, options),
    db,
    threads,
    sessions,
    workspaces,
    workspacePathIndex,
    timeoutPolicy: config.timeoutPolicy,
    emitConversation: (event) => {
      captureBeforeSnapshotOnEmit({ db, workspaces, runtime, deferredSnapshots: databaseWriter ? frozenBeforeSnapshots : undefined,
        deferredAfterSnapshots: databaseWriter ? frozenAfterSnapshots : undefined }, event);
      sendToServer({ t: "conversation.event", event } satisfies ClientToServerMessage);
    },
    emitRaw: (event) => {
      sendToServer({ t: "raw.event", event } satisfies ClientToServerMessage);
    },
    emitOrchestration: emitOrchestrationToServer,
    notifyReminderChanged: markReminderDirty,
    resolveChatWorkflowBinding: (instanceId, workspaceId) => {
      if (!workspaceId) throw new Error("ORCHESTRATION_WORKSPACE_SCOPE_REQUIRED");
      return new ChatWorkflowRepo(db.forWorkspace(workspaceId).db).findBindingByInstanceId(String(instanceId));
    },
    reminderCompletionNotifier,
    getRelayPricingCatalog: () => relayPricingCatalog,
    /** 按实例持久归属补录；本机不依赖 hello，共享实例仍走 Server 权威。 */
    async ensureAssetRuntimeSnapshot(instanceId, workspaceId) {
      if (!workspaceId) throw new Error("ORCHESTRATION_WORKSPACE_SCOPE_REQUIRED");
      return withDatabase("orchestration:runtime-snapshot", () => {
        const instance = db.forWorkspace(workspaceId).orchInstances.get(instanceId);
        const backfill = desktopLifecycle && isDesktopLocalAssetExecution(config.clientId, workspaces, instance)
          ? desktopOrchAssetLegacyInstanceBackfill : orchAssetLegacyInstanceBackfill;
        if (!backfill) throw new Error("历史实例资产运行快照补录服务未装配");
        return backfill.ensureForExecution(instanceId, workspaceId);
      });
    },
    beginWorkspaceActivity: (workspaceId, instanceId) => workspaceOperationGate.beginActivity(workspaceId, {
      type: "orchestration_instance",
      resourceId: instanceId,
    }),
  });
  sessions.setManagedServiceSnapshotProvider((threadId) => orchEngine.forWorkspace(requireRuntimeWorkspace(threadId)).listManagedServicesForThread(threadId));
  logClientStep("info", "startup.orchestration_ready", "success", "orchestration runtime initialized", {
    target: { clientId: config.clientId },
    workspaceCount: workspaces.size,
  });

  const orchRecoveryStarted = new Set<"desktop" | "server">();
  /** 从随包文件安装内置资产，失败保留工作区与包身份并显式中止。 */
  const installLocalBuiltinAssets = (): void => {
    if (!desktopBuiltinBundles) throw new Error("LOCAL_BUILTIN_CONTEXT_REQUIRED");
    const localWorkspaces = new Map([...workspaces]
      .filter(([workspaceId]) => isDesktopLocalAssetWorkspace(config.clientId, workspaces, workspaceId)));
    try {
      installDesktopBuiltinAssets({ db, bundles: desktopBuiltinBundles, workspaces: localWorkspaces });
    } catch (cause) {
      const failure = Object.assign(new Error("本地内置资产安装失败", { cause }), {
        code: "LOCAL_BUILTIN_ASSET_INSTALL_FAILED", requestId: desktopRequestId ?? "startup:" + config.clientId,
      });
      logClientStep("error", "startup.builtin_asset_install", "fail", "local builtin package installation failed", {
        errorCode: failure.code, requestId: failure.requestId, target: { clientId: config.clientId },
        workspaceIds: [...localWorkspaces.keys()],
        bundles: desktopBuiltinBundles.map(bundle => ({ bundleId: bundle.bundleId, bundleVersion: bundle.bundleVersion })),
        error: toErrorLogValue(cause),
      });
      throw failure;
    }
  };
  installLocalBuiltinAssets();
  let currentClientHello: Extract<ServerToClientMessage, { t: "client.helloAck" }> | null = null;
  /** 实例损坏只暂停所属实体；落库失败继续抛出，其他实例独立恢复。 */
  const isolatePersistedInstanceFailure = (workspaceId: WorkspaceId, instanceId: OrchestrationId, scope: "desktop" | "server", error: OrchInstanceScopeError | OrchAssetLaunchSnapshotError, phase: "prepare" | "recover") => {
    const code = error instanceof OrchInstanceScopeError ? error.code : phase === "prepare" ? "ORCHESTRATION_SNAPSHOT_BACKFILL_FAILED" : "ORCHESTRATION_RECOVERY_FAILED";
    const scoped = db.forWorkspace(workspaceId);
    const fact = scoped.db.prepare("SELECT workspace_id, status FROM orch_instances WHERE id = ?").get(String(instanceId)) as { workspace_id: string; status: string } | undefined;
    if (!fact || fact.workspace_id !== String(workspaceId)
      || error instanceof OrchInstanceScopeError && (error.details.instanceId !== String(instanceId) || error.details.workspaceId !== String(workspaceId))) throw error;
    if (fact.status === "paused" && scoped.orchEvents.listByInstance(instanceId).some(event => event.type === "orchestration.error" && JSON.parse(event.payloadJson).code === code)) return;
    const details = error instanceof OrchInstanceScopeError ? error.details : { reason: error.code };
    scoped.db.transaction(() => {
      if (error instanceof OrchInstanceScopeError) scoped.orchInstances.pauseAfterScopeFailure(error);
      else scoped.orchInstances.updateStatus(instanceId, "paused");
      scoped.orchEvents.append({ instanceId, nodeId: null, type: "orchestration.error", createdAt: Date.now(),
        payloadJson: JSON.stringify({ code, requestId: desktopRequestId ?? `startup:${config.clientId}`, instanceId, workspaceId: fact.workspace_id, scope, ...details }) });
    })();
    logClientStep("error", phase === "prepare" ? "startup.orchestration_instance_snapshot_backfill" : "startup.orchestration_instance_recovered", "fail", "persisted orchestration instance isolated", {
      errorCode: code, requestId: desktopRequestId ?? `startup:${config.clientId}`, instanceId, workspaceId: fact.workspace_id, scope, ...details,
      target: { clientId: config.clientId, deviceId: deviceIdentity.deviceId, instanceId }, rootCause: error instanceof OrchInstanceScopeError ? error.details.reason : error.code,
    });
  };
  /** 本机与 Server 分别恢复各自实例，避免本机先恢复后抢占共享恢复入口。 */
  const recoverRunningOrchestrations = async (scope: "desktop" | "server") => {
    if (orchRecoveryStarted.has(scope)) return;
    orchRecoveryStarted.add(scope);

    const recoverableInstanceIds = await withDatabase("orchestration:recovery-list", () => Array.from(workspaces.keys()).flatMap(workspaceId => db.forWorkspace(workspaceId).db.prepare(
      "SELECT id FROM orch_instances WHERE workspace_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'paused')",
    ).all(String(workspaceId)).map(row => ({ ...(row as { id: OrchestrationId }), workspaceId }))));
    if (!recoverableInstanceIds.length) {
      logClientStep("info", "startup.orchestration_recovery", "skip", "no orchestration instances require recovery", {
        target: { clientId: config.clientId },
      });
      return;
    }

    logClientStep("info", "startup.orchestration_recovery", "start", "orchestration recovery started", {
      target: { clientId: config.clientId },
      recoverableInstanceCount: recoverableInstanceIds.length,
      instanceIds: recoverableInstanceIds,
    });
    logger.info("orchestration", `recovering orchestration instances count=${recoverableInstanceIds.length}`);
    let recoveredCount = 0;
    let failedCount = 0;
    for (const { id: instanceId, workspaceId } of recoverableInstanceIds) {
      try {
        const engine = await withDatabase("orchestration:recovery-owner", () => {
          const instance = db.forWorkspace(workspaceId).orchInstances.get(instanceId, { strictScope: scope === "desktop" });
          if (!instance) throw new Error(`编排实例不存在：${instanceId}`);
          if ((Boolean(desktopLifecycle) && isDesktopLocalAssetExecution(config.clientId, workspaces, instance)) !== (scope === "desktop")
            || !shouldRecoverPersistedOrchestrationInstance(instance)) return undefined;
          return orchEngine.forWorkspace(workspaceId);
        });
        if (!engine) continue;
        await engine.recover(instanceId);
        recoveredCount += 1;
        logClientStep("info", "startup.orchestration_instance_recovered", "success", "orchestration instance recovered", {
          target: { clientId: config.clientId, instanceId },
        });
      } catch (error) {
        if (!(error instanceof OrchInstanceScopeError) && !(error instanceof OrchAssetLaunchSnapshotError)) throw error;
        failedCount += 1;
        await withDatabase("orchestration:recovery-isolate", () => isolatePersistedInstanceFailure(workspaceId, instanceId, scope, error, "recover"));
      }
    }
    logClientStep(failedCount > 0 ? "warn" : "info", "startup.orchestration_recovery", failedCount > 0 ? "warn" : "success", "orchestration recovery finished", {
      target: { clientId: config.clientId },
      recoverableInstanceCount: recoverableInstanceIds.length,
      recoveredCount,
      failedCount,
    });
  };

  let desktopHostScopes: Extract<import("@codeflowai/shared").ConversationRelayScope, { kind?: "shared" }>[] = [];
  const orchAssetRuntimeRead = new OrchAssetAuthorityRuntimeReadService(
    createClientDbOrchAssetLegacyRuntimeReader(db, { requireCompleteDefinitions: true }),
  );
  const orchAssetLaunchSnapshot = new OrchAssetLaunchSnapshotService(orchAssetRuntimeRead);
  orchAssetLegacyInstanceBackfill = new OrchAssetLegacyInstanceBackfillService(db, orchAssetLaunchSnapshot);

  /** 逐实例补录本地运行快照；无法恢复的历史实例局部暂停。 */
  const preparePersistedOrchestrationInstances = (scope: "desktop" | "server"): {
    candidateCount: number;
    preparedCount: number;
    failedCount: number;
  } => {
    if (!orchAssetLegacyInstanceBackfill) throw new Error("历史实例资产运行快照补录服务未装配");
    const candidates = Array.from(workspaces.keys()).flatMap(workspaceId => db.forWorkspace(workspaceId).db.prepare(
      "SELECT id FROM orch_instances WHERE workspace_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(String(workspaceId)).map(row => ({ ...(row as { id: OrchestrationId }), workspaceId })));
    let preparedCount = 0;
    let failedCount = 0;
    for (const { id: instanceId, workspaceId } of candidates) {
      try {
        const instance = db.forWorkspace(workspaceId).orchInstances.get(instanceId, { strictScope: scope === "desktop" });
        if (!instance) throw new Error(`编排实例不存在：${instanceId}`);
        if ((Boolean(desktopLifecycle) && isDesktopLocalAssetExecution(config.clientId, workspaces, instance)) !== (scope === "desktop")) continue;
        const backfill = scope === "desktop" ? desktopOrchAssetLegacyInstanceBackfill : orchAssetLegacyInstanceBackfill;
        if (!backfill) throw new Error("历史实例资产运行快照补录服务未装配");
        backfill.ensureForExecution(instance.id, workspaceId);
        orchEngine.forWorkspace(workspaceId).normalizePersistedInstanceStatus(instance.id);
      } catch (error) {
        if (!(error instanceof OrchInstanceScopeError) && !(error instanceof OrchAssetLaunchSnapshotError)) throw error;
        failedCount += 1;
        isolatePersistedInstanceFailure(workspaceId, instanceId, scope, error, "prepare");
        continue;
      }
      preparedCount += 1;
    }
    return { candidateCount: candidates.length, preparedCount, failedCount };
  };

  // 持久 ApiHandlerContext：所有 api.req 共享同一份；ThreadQueueDispatcher 单例挂在上面
  const apiHandlerContext: ApiHandlerContext = {
    ...(desktopLifecycle ? { builtInRelayCredentials } : {}),
    isTaskAdmissionPaused: () => desktopLifecycle?.isTaskAdmissionPaused() ?? false,
    db,
    /** 单次认证请求拥有归因扫描；不启动timer，取消需求后停止后续claim。 */
    async syncCodeAttribution(workspaceId, roundId) {
      if (!roundId) throw new Error("CODE_ATTRIBUTION_DEMAND_ROUND_REQUIRED");
      const demand = [...remoteDataDemands.values()].find(item => item.kind === "code-attribution"
        && item.scope.workspaceId === workspaceId && item.roundId === roundId);
      if (!demand) throw new Error("CODE_ATTRIBUTION_DEMAND_REQUIRED");
      const owner = desktopCloudAccount?.getOwner();
      const transport = owner ? desktopCloudAccount!.createCodeAttributionTransport(owner) : codeAttributionTransport;
      if (!transport) throw new Error("CODE_ATTRIBUTION_TRANSPORT_UNAVAILABLE");
      const demandActive = (candidate: string): boolean => {
        if (owner) desktopCloudAccount!.assertOwner(owner);
        return candidate === workspaceId && remoteDataDemands.get(demand.demandId) === demand;
      };
      const workerOptions = { listWorkspaceIds: () => [workspaceId], hasDemand: demandActive,
        withDatabase: <T>(operation: () => T) => withDatabase(`code-attribution:${roundId}`, operation),
        logger: { info: (data: Record<string, unknown>, message: string) => logger.info("code-attribution", message, data),
          warn: (data: Record<string, unknown>, message: string) => logger.warn("code-attribution", message, data),
          error: (data: Record<string, unknown>, message: string) => logger.error("code-attribution", message, data) },
        onFatalError: (error: unknown) => { throw error; },
      };
      const sync = new CodeAttributionSyncWorker(db, transport, { ...workerOptions, leaseOwner: `attribution:${roundId}` });
      const retention = new CodeAttributionRetentionWorker(db, transport, { ...workerOptions, leaseOwner: `retention:${roundId}` });
      const collectionCutoffAt = Date.now();
      const failures: unknown[] = [];
      try {
        for (const worker of [sync, retention]) {
          let exhausted = true;
          for (let count = 0; count < 512; count++) {
            if (!demandActive(workspaceId)) throw new Error("CODE_ATTRIBUTION_DEMAND_REVOKED");
            const result = await worker.runOnce();
            if (result === "failed") throw new Error("CODE_ATTRIBUTION_SYNC_FAILED");
            if (result === "idle") {
              if (!demandActive(workspaceId)) throw new Error("CODE_ATTRIBUTION_DEMAND_REVOKED");
              await withDatabase(`code-attribution:${roundId}:completion`, () => {
                const scoped = db.forWorkspace(workspaceId);
                if (worker === sync) scoped.codeAttributionOutbox.assertDrained({ throughCreatedAt: collectionCutoffAt });
                else scoped.codeAttributionRetentionTasks.assertDrained({ dueThrough: collectionCutoffAt });
              });
              exhausted = false; break;
            }
          }
          if (exhausted) throw new Error("CODE_ATTRIBUTION_DEMAND_BUDGET_EXCEEDED");
        }
      } catch (error) {
        const pending = error as { recordId?: string; status?: string; availableAt?: number; leaseExpiresAt?: number; lastErrorCode?: string };
        logger.error("code-attribution", "on-demand attribution collection failed", { code: "CODE_ATTRIBUTION_DEMAND_FAILED",
          requestId: demand.requestId, roundId, workspaceId, recordId: pending?.recordId, status: pending?.status,
          availableAt: pending?.availableAt, leaseExpiresAt: pending?.leaseExpiresAt, lastErrorCode: pending?.lastErrorCode, rootCause: toErrorLogValue(error) });
        failures.push(error);
      }
      for (const result of await Promise.allSettled([sync.stop(), retention.stop()])) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "CODE_ATTRIBUTION_DEMAND_FAILED", { cause: failures[0] });
    },
    orchIntakeListReader: openedClientDbReader,
    assertWorkspacePersistenceAvailable,
    workspaces,
    serverWsUrl: config.serverWsUrl,
    /** 内置包始终来自当前程序，不再读取 Server 同步接口。 */
    loadServerDefaultBundles: async () => desktopBuiltinBundles!,
    clientId: config.clientId,
    workspacePathIndex,
    /** 新工作区安装随包资产，目录变更通知继续沿现有连接发送。 */
    onWorkspacesChanged: async (reason) => {
      if (reason !== "migration") workspacePathIndex.syncWorkspaces(workspaces);
      logClientStep("info", "runtime.workspaces_changed", "success", "workspace list changed", {
        target: { clientId: config.clientId },
        reason: reason ?? null,
        workspaceCount: workspaces.size,
        workspaceIds: Array.from(workspaces.keys()),
      });
      if (reason !== "delete" && reason !== "migration") await withDatabase("workspace:builtin-install", installLocalBuiltinAssets);
      if (desktopLifecycle) {
        // 已关联账号时同步本机工作区清单，供同账号其他设备发现；未关联由下次 hello 携带。
        if (desktopCloudAccount?.snapshot().status === "linked") {
          const result = desktopCloudAccount.send({ t: "client.workspacesChanged", workspaceIds: Array.from(workspaces.keys()) } satisfies ClientToServerMessage);
          if (!result.accepted) {
            logger.warn("desktop-cloud", "workspace change notification rejected", {
              errorCode: "DESKTOP_CLOUD_WORKSPACES_CHANGED_REJECTED", clientId: config.clientId,
              reason: result.reason ?? null, workspaceCount: workspaces.size,
            });
          }
        }
        return;
      }
      sendToServer({ t: "client.workspacesChanged", workspaceIds: Array.from(workspaces.keys()) } satisfies ClientToServerMessage);
    },
    timeoutPolicy: config.timeoutPolicy,
    threads,
    sessions,
    controlledExperiments,
    terminalManager,
    orchEngine,
    orchAssetRuntimeRead,
    orchAssetLaunchSnapshot,
    workspaceOperationGate,
    send: (m) => sendToServer(m),
    emitOrchestration: emitOrchestrationToServer,
    requestShutdown: (reason) => shutdown(reason),
    onBeforeEmitConversationEvent: (event) => captureBeforeSnapshotOnEmit({ db, workspaces, runtime, deferredSnapshots: databaseWriter ? frozenBeforeSnapshots : undefined,
      deferredAfterSnapshots: databaseWriter ? frozenAfterSnapshots : undefined }, event),
    /** 运行态补查只读持久事实，避免历史加载旁路打开写库。 */
    getActiveThreadTurn: ({ workspaceId, threadId, includeDb }) => {
      const shouldIncludeDb = includeDb !== false;
      const sessionActiveTurnId = sessions.getActiveTurnId(threadId);
      const runtimeActive = runtime.activeTurnByThreadId.get(threadId);
      if (sessionActiveTurnId) {
        if (runtimeActive && String(runtimeActive.turnId) === String(sessionActiveTurnId)) {
          return {
            turnId: sessionActiveTurnId,
            startedAt: runtimeActive.startedAt,
            source: "runtime",
            execution: runtimeActive.execution,
          };
        }
        if (!shouldIncludeDb) {
          return {
            turnId: sessionActiveTurnId,
            startedAt: null,
            source: "runtime",
            execution: runtimeActive?.execution ?? null,
          };
        }
        const resolvedWorkspaceId = workspaceId ?? threads.get(threadId)?.workspaceId ?? null;
        const dbActive = resolvedWorkspaceId ? db.forWorkspace(resolvedWorkspaceId, { readonly: true }).turns.listRunningByWorkspace(resolvedWorkspaceId)[String(threadId)] ?? null : null;
        const startedAt = dbActive && String(dbActive.runningTurnId) === String(sessionActiveTurnId) ? dbActive.runningTurnStartedAt : null;
        return {
          turnId: sessionActiveTurnId,
          startedAt,
          source: "runtime",
          execution: readPersistedTurnExecutionOptions(db.forWorkspace(workspaceId ?? requireRuntimeWorkspace(threadId), { readonly: true }), threadId, sessionActiveTurnId),
        };
      }
      if (runtimeActive) {
        return {
          turnId: runtimeActive.turnId,
          startedAt: runtimeActive.startedAt,
          source: "runtime",
          execution: runtimeActive.execution,
        };
      }
      if (!shouldIncludeDb) return null;
      const resolvedWorkspaceId = workspaceId ?? threads.get(threadId)?.workspaceId ?? null;
      if (!resolvedWorkspaceId) return null;
      const dbActive = db.forWorkspace(resolvedWorkspaceId, { readonly: true }).turns.listRunningByWorkspace(resolvedWorkspaceId)[String(threadId)] ?? null;
      return dbActive
        ? {
            turnId: dbActive.runningTurnId,
            startedAt: dbActive.runningTurnStartedAt,
            source: "db",
            execution: readPersistedTurnExecutionOptions(db.forWorkspace(resolvedWorkspaceId, { readonly: true }), threadId, dbActive.runningTurnId),
          }
        : null;
    },
    getTurnFinalizationFailure: getPendingTurnTerminalFailure,
    withDatabase,
    trackApiTail: (work, context) => runtime.trackWork(() => work, () => markCurrentClientDaemonStartup("degraded"), `api-tail:${context.requestId}`),
    flushLocalEvents: (workspaceId, threadId) => eventPipeline?.flush(workspaceId, threadId) ?? Promise.resolve(),
    clearActiveThreadTurn: ({ threadId, turnId }) => {
      clearActiveThreadTurnIfMatches(runtime.activeTurnByThreadId, threadId, turnId);
    },
    flushRollbackEvidence,
    flushEventPersistence,
    fenceRollbackEvidence: rollbackEvidenceFence.request,
    takeApiResponseDispatch,
  };
  /** 复用现有单会话删除门禁，租约内重置引擎上下文并让其它会话继续工作。 */
  dbCleanup = new ClientDbCleanupService({
    db,
    dbPath,
    withLegacyDatabase: withDatabase,
    flushEventPersistence,
    getRuntimePressure,
    beginThreadCleanup: async (target, inactiveBefore) => {
      let releaseThread: () => void;
      try {
        releaseThread = sessions.beginThreadDeletion([target.threadId]);
      } catch (cause) {
        const code = String((cause as { code?: unknown } | null)?.code ?? "").trim();
        if (code === THREAD_DELETION_IN_PROGRESS_CODE || code === THREAD_OPERATION_IN_PROGRESS_CODE) return null;
        throw cause;
      }

      try {
        await flushEventPersistence();
        if (!await withDatabase("cleanup:thread-eligibility", () => db.forWorkspace(target.workspaceId).threads.isHistoryCleanupTargetEligible({
          threadId: target.threadId,
          workspaceId: target.workspaceId,
          inactiveBefore,
        }))) {
          releaseThread();
          return null;
        }
        if (await withDatabase("cleanup:active-turn", () => apiHandlerContext.getActiveThreadTurn?.({
          workspaceId: target.workspaceId,
          threadId: target.threadId,
        }))) {
          releaseThread();
          return null;
        }
        await sessions.disposeThreadWithOptions(target.threadId, { flushActiveTurn: false });
        await withDatabase("cleanup:clear-session", () => db.forWorkspace(target.workspaceId).threads.clearSessionId(target.threadId, { preserveUpdatedAt: true }));
        threads.clearSessionId(target.threadId, { preserveUpdatedAt: true });
        return releaseThread;
      } catch (cause) {
        releaseThread();
        throw cause;
      }
    },
    onThreadHistoryCleaned: (input) => {
      const currentThread = db.forWorkspace(input.workspaceId).threads.get(input.threadId);
      if (!currentThread || String(currentThread.workspaceId) !== String(input.workspaceId)) {
        throw Object.assign(
          new Error(`历史清理通知前会话元数据已变化：threadId=${input.threadId}`),
          { code: "client_db_cleanup_thread_changed" },
        );
      }
      const result = sendToServer({
        t: "thread.history.cleaned",
        workspaceId: currentThread.workspaceId,
        threadId: input.threadId,
        sharedWorkspaceId: currentThread.sharedWorkspaceId,
        throughSeq: input.throughSeq,
      } satisfies ClientToServerMessage);
      if (!result.accepted) {
        throw Object.assign(
          new Error(`历史清理失效通知发送失败：threadId=${input.threadId}, reason=${result.reason ?? "unknown"}`),
          { code: "client_db_cleanup_notification_rejected" },
        );
      }
    },
  });
  apiHandlerContext.dbCleanup = dbCleanup;
  apiHandlerContext.sendIdempotencyCache = new SendIdempotencyCache();
  /** 新执行只读本地资产；历史缓存授权保留原记录但不再可执行。 */
  const assertLocalAssetExecution: NonNullable<ApiHandlerContext["assertAssetExecution"]> = input => {
    const scoped = db.forWorkspace(input.workspaceId);
    const thread = input.threadId ? scoped.threads.get(input.threadId) : null;
    if (input.threadId && (!thread || thread.workspaceId !== input.workspaceId)) throw new Error("ASSET_EXECUTION_THREAD_MISMATCH");
    if (input.authorization || thread && scoped.turns.getAssetExecutionAuthorizations(thread.id, thread.sessionId).length) {
      throw Object.assign(new Error("云端缓存资产执行已移除，请选择本地资产重新开始"), { code: "ASSET_CACHE_EXECUTION_REMOVED" });
    }
  };
  apiHandlerContext.assertAssetExecution = input => {
    assertLocalAssetExecution(input);
    if (!desktopLifecycle) return;
    const owner = desktopCloudAccount?.getOwner();
    if (!owner || !desktopHostScopes.some(scope => scope.workspaceId === input.workspaceId && scope.userId === owner.ownerUserId)) {
      throw new Error("DESKTOP_SHARED_EXECUTION_REQUIRES_ONLINE_OWNER");
    }
  };
  const desktopApiHandlerContext: ApiHandlerContext = desktopLifecycle ? {
    ...apiHandlerContext,
    publishTerminalEvent: publishDesktopTerminalMessage,
    deviceId: deviceIdentity.deviceId,
    /** 本机执行不依赖账号；旧共享缓存授权不能转为本机权限。 */
    assertAssetExecution(input) {
      if (!isDesktopLocalAssetWorkspace(config.clientId, workspaces, input.workspaceId)) throw new Error("DESKTOP_ASSET_WORKSPACE_INVALID");
      assertLocalAssetExecution(input);
    },
  } : apiHandlerContext;
  if (desktopLifecycle) desktopOrchAssetLegacyInstanceBackfill = new OrchAssetLegacyInstanceBackfillService(db, orchAssetLaunchSnapshot);
  const queueDispatcher = new ThreadQueueDispatcher(apiHandlerContext, (threadId, workspaceId) => {
    if (!workspaceId) throw new Error("QUEUE_WORKSPACE_SCOPE_REQUIRED");
    const scopedDb = db.forWorkspace(workspaceId);
    const context = desktopLifecycle && isDesktopLocalThreadAssetExecution(config.clientId, workspaces, scopedDb, threadId)
      ? desktopApiHandlerContext : apiHandlerContext;
    return { ...context, db: scopedDb, orchEngine: orchEngine.forWorkspace(workspaceId) };
  }, (workspaceId, threadId) => {
    emitQueueChanged({ ...apiHandlerContext, db: db.forWorkspace(workspaceId) }, workspaceId, threadId, "paused");
  }, withDatabase);
  apiHandlerContext.queueDispatcher = queueDispatcher;
  desktopApiHandlerContext.queueDispatcher = queueDispatcher;
  const scheduledTaskScheduler = new ScheduledTaskScheduler({
    withLegacyDatabase: withDatabase,
    config,
    deviceId: deviceIdentity.deviceId,
    apiContext: desktopLifecycle ? { ...desktopApiHandlerContext, localWorkspaceOnly: true } : apiHandlerContext,
    captureAccountContext: captureScheduledTaskAccountContext,
    /** 只委托已捕获的原账号会话，不能借用新owner或旧Client Key。 */
    requestAccountTasks: desktopLifecycle ? (owner, action, payload, requestId) => {
      owner.assertCurrent();
      const current = desktopCloudAccount?.getOwner();
      if (!current || current.generation !== owner.generation || current.serverOrigin !== owner.serverOrigin || current.ownerUserId !== owner.ownerUserId
        || owner.clientId !== config.clientId || owner.deviceId !== deviceIdentity.deviceId) throw new Error("SCHEDULED_TASK_ACCOUNT_STALE");
      return desktopCloudAccount!.requestScheduledTasks(current, action, payload, requestId);
    } : undefined,
    localApiContext: desktopLifecycle ? { ...desktopApiHandlerContext, localWorkspaceOnly: true } : undefined,
    isTaskAdmissionPaused: () => desktopLifecycle?.isTaskAdmissionPaused() ?? false,
    // 桌面项目计划在本机执行；传统 Client 的共享计划继续经 Server 鉴权及锁。
    tickProjectTasks: () => desktopLifecycle
      ? tickKnowledgeUpdates({ context: { ...desktopApiHandlerContext, workspaces: new Map([...workspaces].filter(([id]) => isDesktopLocalAssetWorkspace(config.clientId, workspaces, id))) },
        dispatch: (workspaceId, scheduledAt) => dispatchDesktopKnowledgeUpdate(desktopApiHandlerContext, workspaceId, scheduledAt) })
      : currentClientHello
        ? tickKnowledgeUpdates({ context: apiHandlerContext, dispatch: (workspaceId, scheduledAt) => dispatchKnowledgeUpdate({ serverWsUrl: config.serverWsUrl, apiKey: config.apiKey, clientId: config.clientId, workspaceId, scheduledAt }) })
        : Promise.resolve(),
  });
  apiHandlerContext.scheduledTaskScheduler = scheduledTaskScheduler;
  desktopApiHandlerContext.scheduledTaskScheduler = scheduledTaskScheduler;
  const workspaceMigrationActivityInspector = new WorkspaceMigrationActivityInspector({
    db,
    gate: workspaceOperationGate,
    terminalManager,
    orchEngine,
    queueRuntime: queueDispatcher,
    scheduledTaskScheduler,
    dbCleanup,
    listActiveRollbackThreadIds: listActiveRollbackMutationThreadIds,
  });
  apiHandlerContext.workspaceMigrationActivityInspector = workspaceMigrationActivityInspector;
  desktopApiHandlerContext.workspaceMigrationActivityInspector = workspaceMigrationActivityInspector;
  /** 将 Client 迁移事实投影为 Server 事件；持久 notification_pending 负责完成态重发。 */
  const notifyWorkspaceMigrationChanged = (operation: Parameters<typeof toWorkspaceDirectoryMigrationChangedEvent>[0]): void => {
    const event = toWorkspaceDirectoryMigrationChangedEvent(operation, {
      db,
      workspaces,
      activityInspector: workspaceMigrationActivityInspector,
    });
    const result = sendToServer({
      t: "client.workspaceDirectoryMigrationChanged",
      event,
    } satisfies ClientToServerMessage);
    if (!result.accepted) {
      logger.warn("workspace-migration", "workspace migration change event queued for reconnect", {
        code: "workspace_migration_change_event_send_rejected",
        operationId: operation.operationId,
        workspaceId: operation.workspaceId,
        state: operation.state,
        stateVersion: operation.stateVersion,
        reason: result.reason,
      });
    }
  };
  const workspaceMigrationIndexCoordinator = new WorkspaceMigrationIndexCoordinatorService({
    db,
    withLegacyDatabase: withDatabase,
    pathIndex: workspacePathIndex,
    onOperationChanged: notifyWorkspaceMigrationChanged,
    onFatalError: (error) => {
      logClientStep("error", "workspace_migration.index_persistence", "fail", "workspace migration index persistence failed; shutting down", {
        target: { clientId: config.clientId },
        error: toErrorLogValue(error),
      });
      shutdown("workspace_migration_index_persistence_failed", 1);
    },
  });
  apiHandlerContext.workspaceMigrationIndexCoordinator = workspaceMigrationIndexCoordinator;
  desktopApiHandlerContext.workspaceMigrationIndexCoordinator = workspaceMigrationIndexCoordinator;
  let workspaceMigrationRuntimeReady = false;

  const migrationRuntimeCallbacks = createWorkspaceMigrationRuntimeCallbacks({ db, gate: workspaceOperationGate,
    withLegacyDatabase: withDatabase,
    sessions, pathIndex: workspacePathIndex, onWorkspacesChanged: reason => apiHandlerContext.onWorkspacesChanged?.(reason) });

  const workspaceMigrationService = new WorkspaceMigrationService({
    db,
    withLegacyDatabase: withDatabase,
    gate: workspaceOperationGate,
    activityInspector: workspaceMigrationActivityInspector,
    indexCoordinator: workspaceMigrationIndexCoordinator,
    workspaces,
    queueDispatcher: {
      resumeWorkspace: (workspaceId) => {
        if (workspaceMigrationRuntimeReady) queueDispatcher.resumeWorkspace(workspaceId);
      },
    },
    scheduledTaskScheduler: {
      resumeWorkspace: (workspaceId, operationId) => {
        if (workspaceMigrationRuntimeReady) scheduledTaskScheduler.resumeWorkspace(workspaceId, operationId);
      },
    },
    ...migrationRuntimeCallbacks,
    onOperationChanged: notifyWorkspaceMigrationChanged,
    onFatalError: (error) => {
      logClientStep("error", "workspace_migration.execution", "fail", "workspace migration execution failed; shutting down", {
        target: { clientId: config.clientId },
        error: toErrorLogValue(error),
      });
      shutdown("workspace_migration_execution_failed", 1);
    },
  });
  apiHandlerContext.workspaceMigrationService = workspaceMigrationService;
  desktopApiHandlerContext.workspaceMigrationService = workspaceMigrationService;
  workspaceMigrationService.restoreExclusiveLocks();

  const hostRpcHttpTransport = new HostRpcHttpTransport({
    serverWsUrl: config.serverWsUrl,
    apiKey: config.apiKey,
    clientId: config.clientId,
    execute: (task) => executeHostRpcHttpTask(apiHandlerContext, task),
    events: {
      onDiagnostic: (level, message, data) => logger[level]("host-rpc-http", message, data),
      onFatal: () => shutdown("host_rpc_http_failed", 1),
      onSessionInvalidated: () => transport?.reconnect("host_rpc_session_invalidated"),
    },
  });

  /** 复用 canonical 索引；本地已提交事件不再进入远程 ACK 缓冲。 */
  const applyConversationEventAck = (event: ConversationEventEnvelope, alreadyPersisted = false, databaseIndexed = false): void => {
    assertWorkspacePersistenceAvailable(event.workspaceId);
    persistConversationEventAck({
      db: db.forWorkspace(event.workspaceId),
      workspaces,
      threads,
      runtime,
      orchEngine: orchEngine.forWorkspace(event.workspaceId),
      threadTouchBuffer,
      conversationEventAckBuffer,
      queueDispatcher: queueDispatcher.forWorkspace(event.workspaceId),
      markReminderDirty,
      reminderCompletionNotifier,
      desktopCloudAccount,
      alreadyPersisted,
      databaseIndexed,
    }, event);
  };

  /** 复用 raw 索引并推进同一回滚 fence；本地提交不依赖 Server 回执。 */
  const applyRawEventAck = (event: RawEngineEventEnvelope, alreadyPersisted = false, databaseIndexed = false): void => {
    try {
      assertWorkspacePersistenceAvailable(event.workspaceId);
      if (!databaseIndexed) persistRawEventAck({ db, runtime, buffer: rawEventAckBuffer, alreadyPersisted }, event);
      if (!databaseIndexed) rollbackEvidenceFence.acceptAck(event);
    } catch (error) {
      rollbackEvidenceFence.rejectAck(event, error);
      throw error;
    }
  };
  localEventPersistence = createLocalEventPersistence({
      db,
      applyConversation: (event) => applyConversationEventAck(event, true),
      applyRaw: (event) => applyRawEventAck(event, true),
  });

  const pendingFinalizationIds = db.workspaceDirectoryMigrations.listActive()
    .filter((operation) => operation.state === "path_committed" || operation.state === "finalizing")
    .map((operation) => operation.operationId);
  workspaceMigrationService.resumeFinalization(`startup-${process.pid}`);
  await Promise.all(pendingFinalizationIds.map((operationId) => workspaceMigrationService.waitForIdle(operationId)));
  const unresolvedFinalizationIds = pendingFinalizationIds.filter((operationId) => {
    const state = db.workspaceDirectoryMigrations.require(operationId).state;
    return state === "path_committed" || state === "finalizing";
  });
  if (unresolvedFinalizationIds.length > 0) {
    throw new Error(`目录迁移启动前滚未完成：operationIds=${unresolvedFinalizationIds.join(",")}`);
  }
  logClientStep("info", "startup.workspace_migration_index_recovery", "start", "workspace migration index recovery started", {
    target: { clientId: config.clientId },
  });
  await workspaceMigrationIndexCoordinator.recoverPendingOnStartup();
  logClientStep("info", "startup.workspace_migration_index_recovery", "success", "workspace migration index recovery finished", {
    target: { clientId: config.clientId },
  });
  workspaceMigrationRuntimeReady = true;
  logClientStep("info", "startup.api_runtime_ready", "success", "api runtime initialized", {
    target: { clientId: config.clientId },
    workspaceCount: workspaces.size,
    queueDispatcherRecovered: false,
  });

  /** 握手后先提交激活快照，再重发 completed 后未 ACK 的终态通知。 */
  const sendWorkspaceMigrationActivationState = (): void => {
    const snapshotResult = sendToServer({
      t: "client.workspaceDirectoryMigrationActivationSnapshot",
      snapshot: buildWorkspaceDirectoryMigrationActivationSnapshot(db),
    } satisfies ClientToServerMessage);
    if (!snapshotResult.accepted) {
      logger.error("workspace-migration", "workspace migration activation snapshot send rejected", {
        code: "workspace_migration_activation_snapshot_send_rejected",
        requestId: null,
        clientId: config.clientId,
        messageType: snapshotResult.messageType,
        readyState: snapshotResult.readyState,
        reason: snapshotResult.reason,
        rootCause: snapshotResult.reason ?? "unknown",
      });
      throw new Error(`迁移激活快照发送失败：${snapshotResult.reason ?? "unknown"}`);
    }
    for (const operation of db.workspaceDirectoryMigrations.listNotificationPending()) {
      notifyWorkspaceMigrationChanged(operation);
    }
  };

  let firstHelloAck = true;
  const initialLinkRequired = Boolean(options && Object.prototype.hasOwnProperty.call(options, "apiKeyOverride"));
  let initialLinkSettled = false;
  let initialLinkTimer: NodeJS.Timeout | null = null;
  logClientStep("info", "transport.init", "success", "ws transport initialized", {
    target: { clientId: config.clientId },
    serverWsUrl: config.serverWsUrl,
    workspaceCount: workspaces.size,
  });
  const serverMessageHelloReadyFence = new ServerMessageHelloReadyFence();
  let serverMessageConnectionGeneration = 0;
  let baseActivatedGeneration: number | null = null;
  /** 账号任务固定当前握手身份；本机任务不依赖账号。 */
  function captureScheduledTaskAccountContext(): ScheduledTaskAccountContext | null {
    if (desktopLifecycle) {
      const cloud = desktopCloudAccount;
      const owner = cloud?.getOwner();
      if (!owner) return null;
      /** 精确session由原云模块核验；关闭与注销后的旧闭包不再执行副作用。 */
      const assertCurrent = (): void => {
        if (shutdownRequested || desktopCloudAccount !== cloud) throw Object.assign(new Error("SCHEDULED_TASK_ACCOUNT_NOT_READY"),
          { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
        cloud!.assertOwner(owner);
      };
      assertCurrent();
      return { serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId, clientId: config.clientId, deviceId: deviceIdentity.deviceId,
        generation: owner.generation, assertCurrent };
    }
    const generation = serverMessageConnectionGeneration;
    const url = new URL(config.serverWsUrl);
    if (url.username || url.password || !["ws:", "wss:", "http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("账号调度 Server 地址无效"), { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    const serverOrigin = url.origin;
    const ownerUserId = currentClientHello?.userSummary?.userId ?? null;
    /** 账号调度固定本次握手身份，不依赖资产同步状态。 */
    const assertCurrent = (): void => {
      const current = currentClientHello?.userSummary;
      if (desktopLifecycle || shutdownRequested || !ownerUserId || !ownerUserId.trim() || generation !== serverMessageConnectionGeneration
        || baseActivatedGeneration !== generation || !serverMessageHelloReadyFence.isCurrent(generation)
        || current?.userId !== ownerUserId) {
        throw Object.assign(new Error("账号调度连接未就绪或身份已变化"), { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
      }
      const currentUrl = new URL(config.serverWsUrl);
      currentUrl.protocol = currentUrl.protocol === "wss:" ? "https:" : currentUrl.protocol === "ws:" ? "http:" : currentUrl.protocol;
      if (currentUrl.username || currentUrl.password || currentUrl.origin !== serverOrigin) throw Object.assign(new Error("账号调度 Server 已变化"), { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
    };
    assertCurrent();
    return { serverOrigin, ownerUserId: ownerUserId!, clientId: config.clientId, deviceId: deviceIdentity.deviceId, generation, assertCurrent };
  }
  /** 同一连接只执行一次基础激活。 */
  let baseActivationInFlightGeneration: number | null = null;
  let catalogDependentRecovery: Promise<void> | null = null;
  /** 目录应用完成后才允许恢复任何可能触发模型调用的持久任务。 */
  async function recoverCatalogDependentRuntime(): Promise<void> {
    if (!catalogDependentRecovery) {
      catalogDependentRecovery = (async () => {
        await withDatabase("queue:catalog-recovery", () => queueDispatcher.recoverOnStartup((threadId, workspaceId) => !desktopLifecycle
          || !isDesktopLocalThreadAssetExecution(config.clientId, workspaces, db.forWorkspace(workspaceId!), threadId)));
        await controlledExperiments.recoverOnStartup();
        logClientStep("info", "startup.catalog_dependent_runtime_recovered", "success", "catalog dependent runtime recovered", {
          target: { clientId: config.clientId },
        });
      })();
    }
    await catalogDependentRecovery;
  }
  /** 同一 WebSocket 也可能收到新发布；旧重试不能覆盖新资产上下文的状态。 */
  function isCurrentClientHello(msg: Extract<ServerToClientMessage, { t: "client.helloAck" }>, generation: number): boolean {
    return currentClientHello === msg && serverMessageHelloReadyFence.isCurrent(generation);
  }

  /**
   * 首次启动为本地无 Key 的新账号补一把内置中转 Codex Key（只处理第一个工作区，用于日志归属）。
   * 一次性机会：门禁不满足只跳过；机会消耗后失败不回滚、不重试，且一律留可检索日志。
   * 中转未配置不阻断基础连接。
   */
  async function runBuiltInRelayAutoEnableOnStartup(): Promise<void> {
    const target = { clientId: config.clientId, workspaceId: workspaces.keys().next().value ?? null };
    const requestId = crypto.randomUUID();
    let result: BuiltInRelayAutoEnableOutcome;
    try {
      result = await enableBuiltInRelayOnStartup({
        target: db,
        withDatabase: operation => withDatabase("relay-auto-enable", operation),
        ...(desktopLifecycle ? { ensureCredential: async () => { await builtInRelayCredentials.ensure({ engine: "codex", providerId: "openai", requestId: crypto.randomUUID(), intent: "auto" }); } }
          : { requestKey: () => requestBuiltInRelayKey({ httpBase: toHttpBaseFromWsUrl(config.serverWsUrl), apiKey: config.apiKey }) }),
        notifyKeysChanged: notifyWebEngineKeysChanged,
      });
    } catch (error) {
      // 门禁读取失败等异常在消耗机会之前发生：本次未尝试，下次启动仍会重试。
      logClientStep("error", "relay_auto_enable", "fail", "built-in relay auto enable aborted before request", {
        code: BUILT_IN_RELAY_AUTO_ENABLE_FAILED_CODE,
        stage: "precheck",
        target,
        error: toErrorLogValue(error),
      });
      return;
    }
    if (result.outcome === "skipped") return;
    if (result.outcome === "success") {
      logClientStep("info", "relay_auto_enable", "success", "built-in relay Codex key auto enabled", {
        target,
        providerId: BUILT_IN_RELAY_PROVIDER_ID,
      });
      return;
    }
    logClientStep("error", "relay_auto_enable", "fail", "built-in relay Codex key auto enable failed", {
      code: result.stage === "marker" ? BUILT_IN_RELAY_AUTO_ENABLE_MARKER_FAILED_CODE : BUILT_IN_RELAY_AUTO_ENABLE_FAILED_CODE,
      requestId, stage: result.stage, target,
      retryable: false,
      rootCause: { ...toBuiltInRelayFailureLogValue(result.cause), message: result.message },
    });
  }

  /**
   * 通知 Web 刷新引擎 Key 列表：已打开的页面没有别的渠道能知道 Client 刚写入了 Key。
   * 发送失败只记录，不影响本次自动启用结果（页面下次自行刷新仍可收敛）。
   */
  function notifyWebEngineKeysChanged(): void {
    try {
      const sent = sendToServer({ t: "engineKeys.changed" } satisfies ClientToServerMessage);
      if (sent.accepted) return;
      logClientStep("warn", "relay_auto_enable", "warn", "engine keys changed broadcast rejected by transport", {
        code: BUILT_IN_RELAY_AUTO_ENABLE_NOTIFY_FAILED_CODE,
        target: { clientId: config.clientId },
        reason: sent.reason ?? null,
      });
    } catch (error) {
      logClientStep("warn", "relay_auto_enable", "warn", "engine keys changed broadcast failed", {
        code: BUILT_IN_RELAY_AUTO_ENABLE_NOTIFY_FAILED_CODE,
        target: { clientId: config.clientId },
        error: toErrorLogValue(error),
      });
    }
  }

  /** 握手只激活连接和模型目录，不等待资产网络同步。 */
  async function activateClientHello(msg: Extract<ServerToClientMessage, { t: "client.helloAck" }>, generation: number): Promise<void> {
    if (shutdownRequested || !isCurrentClientHello(msg, generation)) return;
    await completeClientHelloConnection(msg, generation);
  }

  /** 基础服务、模型目录和入站授权完成后发布连接就绪。 */
  async function completeClientHelloConnection(msg: Extract<ServerToClientMessage, { t: "client.helloAck" }>, messageConnectionGeneration: number): Promise<void> {
    if (shutdownRequested || !isCurrentClientHello(msg, messageConnectionGeneration)) return;
    const ownsBaseActivation = baseActivatedGeneration !== messageConnectionGeneration
      && baseActivationInFlightGeneration !== messageConnectionGeneration;
    if (ownsBaseActivation) baseActivationInFlightGeneration = messageConnectionGeneration;
    if (ownsBaseActivation) {
      try {
        if (!msg.engineModelCatalog) {
          throw Object.assign(new Error("Server 未提供动态模型目录，Client 无法进入就绪状态"), {
            code: "ENGINE_MODEL_CATALOG_UNAVAILABLE",
          });
        }
        const catalogOperationId = getEngineModelCatalogDispatchPauseOperationId()
          ?? `engine-model-catalog-hello-${messageConnectionGeneration}-${msg.engineModelCatalog.configVersion}`;
        const catalogAck = await withDatabase("client:model-catalog", () => applyEngineModelCatalogSnapshot(msg.engineModelCatalog!, Date.now(), catalogOperationId));
        const catalogAckResult = sendToServer({
          t: "engine.models.applied",
          ack: catalogAck,
        } satisfies ClientToServerMessage);
        if (!catalogAckResult.accepted) {
          throw Object.assign(new Error(`模型目录应用回执发送失败：${catalogAckResult.reason ?? "unknown"}`), {
            code: "ENGINE_MODEL_CATALOG_ACK_SEND_FAILED",
          });
        }
        await waitForEngineModelCatalogDispatchReady();
        if (shutdownRequested || !isCurrentClientHello(msg, messageConnectionGeneration)) return;
        localEventRelay?.dispose();
        localEventRelay = createLocalEventRelay({ db, serverUrl: config.serverWsUrl, ackTimeoutMs: config.timeoutPolicy.startupTimeoutMs,
          withDatabase: operation => withDatabase("conversation-relay", operation),
          readReadyThroughSeq: async workspaceId => {
            await eventPipeline?.flush(workspaceId);
            if (!databaseWriter) throw new Error("LOCAL_EVENT_WRITER_NOT_READY");
            return databaseWriter.readReadyThroughSeq(workspaceId);
          }, send: value => sendToServer(value, true), onError: failLocalEventRelay });
        await withDatabase("workspace:migration-activation", sendWorkspaceMigrationActivationState);
        transport?.markReady();
        await recoverCatalogDependentRuntime();
        if (shutdownRequested || !isCurrentClientHello(msg, messageConnectionGeneration)) return;
        scheduleWorkspacePathIndexWarmup();
        if (msg.capabilities?.hostRpcHttpLongPoll === true) {
          const hostRpcHttpSessionId = String(msg.capabilities.hostRpcHttpSessionId ?? "").trim();
          if (!hostRpcHttpSessionId) throw new Error("Server 启用了 Host RPC HTTP，但未签发连接 session");
          hostRpcHttpTransport.start(hostRpcHttpSessionId);
        }
        scheduleRawEventRetention();
        if (msg.relayPricingCatalog) applyRelayPricingCatalog(msg.relayPricingCatalog);
        else relayPricingCatalog = null;
        if (firstHelloAck) {
          firstHelloAck = false;
          firstConnect = false;
          // 首次握手成功：持久化配置并输出成功信息。
          try {
            saveConfigFile({
              apiKey: config.apiKey,
              serverWs: config.serverWsUrl,
              clientId: config.clientId,
            });
          } catch (error) {
            logClientStep("error", "transport.hello_ack", "fail", "client hello acknowledged but config save failed", {
              target: { clientId: config.clientId },
              error: toErrorLogValue(error),
            });
            throw error;
          }
          logClientStep("info", "transport.hello_ack", "success", "client hello acknowledged", {
            target: { clientId: config.clientId },
            serverWsUrl: config.serverWsUrl,
            workspaceCount: workspaces.size,
            savedConfig: true,
            firstHelloAck: true,
          });
        } else {
          logClientStep("info", "transport.hello_ack", "success", "client reconnect acknowledged", {
            target: { clientId: config.clientId },
            serverWsUrl: config.serverWsUrl,
            workspaceCount: workspaces.size,
            firstHelloAck: false,
          });
        }
        flushLocalEventRelay();
        baseActivatedGeneration = messageConnectionGeneration;
      } finally {
        baseActivationInFlightGeneration = null;
      }
    }
    if (shutdownRequested || !isCurrentClientHello(msg, messageConnectionGeneration)) return;
    if (ownsBaseActivation) {
      await withDatabase("queue:hello-recovery", () => queueDispatcher.recoverOnStartup((threadId, workspaceId) => !desktopLifecycle
        || !isDesktopLocalThreadAssetExecution(config.clientId, workspaces, db.forWorkspace(workspaceId!), threadId)));
      void runBuiltInRelayAutoEnableOnStartup();
      scheduledTaskScheduler.start();
      void scheduledTaskScheduler.syncAndTick("helloAck").catch((error) => {
        logClientStep("error", "scheduled_tasks.sync_after_hello", "fail", "scheduled task sync after hello failed", {
          target: { clientId: config.clientId, deviceId: deviceIdentity.deviceId },
          ...toScheduledTaskErrorLog(error),
        });
      });
      if (!orchRecoveryStarted.has("server")) {
        await withDatabase("orchestration:server-prepare", () => preparePersistedOrchestrationInstances("server"));
        void recoverRunningOrchestrations("server").catch((error) => {
          logClientStep("error", "startup.orchestration_recovery", "fail", "running orchestration recovery aborted", {
            target: { clientId: config.clientId, deviceId: deviceIdentity.deviceId },
            error: toErrorLogValue(error),
          });
          shutdown("orchestration_recovery_failed", 1);
        });
      }
    }
    if (!serverMessageHelloReadyFence.markReady(messageConnectionGeneration)) {
      logClientStep("warn", "transport.hello_ack", "skip", "stale hello completion did not release server messages", {
        target: { clientId: config.clientId },
        connectionGeneration: messageConnectionGeneration,
      });
    } else {
      // 只有当前连接的 hello 激活、配置持久化和入站门控均完成后才可发布 ready。
      if (!shutdownRequested && isCurrentClientHello(msg, messageConnectionGeneration)) {
        const initialSuccess = !initialLinkSettled;
        markInitialLinkSucceeded();
        markCurrentClientDaemonStartup("ready", { clientId: config.clientId, serverUrl: config.serverWsUrl });
        logClientStep("info", "client.ready", "success", "Client connection activation completed", {
          requestId: `client-startup-${process.pid}`, target: { clientId: config.clientId },
          serverWsUrl: safeClientServerUrl(config.serverWsUrl), connectionGeneration: messageConnectionGeneration,
        });
        console.log(`[codeflowai] ===== ${initialSuccess ? "启动成功" : "连接就绪"}：已连接服务器，Client 已就绪 =====`);
        console.log(`[codeflowai] Client=${redactClientStartupText(config.clientId)}，服务器=${safeClientServerUrl(config.serverWsUrl)}`);
      }
    }
    return;
  }

  if (desktopLifecycle) {
    /** 复用现有Host授权范围，不以认证连接本身代替共享工作区授权。 */
    const isDesktopHostCommandAuthorized = (message: Extract<ServerToClientMessage, { t: "sharedWorkspace.command" }>): boolean => {
      const envelope = message.envelope;
      return desktopHostScopes.some(scope => scope.bindingId === envelope.hostBindingId
        && scope.workspaceId === envelope.localWorkspaceId && scope.sharedWorkspaceId === envelope.sharedWorkspaceId);
    };
    /** 远程控制只接受已在本机确认的共享Host范围；等待由原云连接owner统一管理。 */
    const assertDesktopHostCommand = (message: Extract<ServerToClientMessage, { t: "sharedWorkspace.command" }>): void => {
      if (!isDesktopHostCommandAuthorized(message)) throw new Error("DESKTOP_CLOUD_HOST_SCOPE_REQUIRED");
    };
    /** 在途事件先本地提交；远程响应及新准入保持原 owner，禁止串入新账号。 */
    const desktopHostContext = (owner: DesktopCloudAccountOwner): ApiHandlerContext => ({
      ...apiHandlerContext, send: message => {
        if (message.t !== "conversation.event" && message.t !== "raw.event") desktopCloudAccount!.assertOwner(owner);
        return sendToServer(message);
      },
      isTaskAdmissionPaused: () => { desktopCloudAccount!.assertOwner(owner); return desktopLifecycle.isTaskAdmissionPaused(); },
    });
    /** 凭据资格同步撤销，已派发回合排空后才释放旧引擎，不阻塞下一账号握手。 */
    const retireDesktopOwner = (owner: DesktopCloudAccountOwner): void => {
      localEventRelay?.disconnect(owner.generation);
      localEventRelay?.dispose(); localEventRelay = undefined; currentClientHello = null;
      desktopHostScopes = [];
      reminderDelivery.disconnect(new Error("REMINDER_DELIVERY_CONNECTION_RETIRED"));
      authorizedRelayScopes = []; remoteDataDemands.clear();
      clearDesktopCloudEngineModelCatalog(); relayPricingCatalog = null;
      const draining = builtInRelayCredentials.invalidateOwner(owner).then(() => sessions.releaseInvalidatedBuiltInSessions(owner));
      const tracked = draining.then(() => { retiredCredentialDrains.delete(tracked); }, error => {
        retiredCredentialDrains.delete(tracked); retiredCredentialFailures.push(error);
        logger.error("desktop-cloud", "retired account credential release failed", { errorCode: "DESKTOP_CREDENTIAL_RELEASE_FAILED", requestId: desktopRequestId, clientId: config.clientId, accountSessionId: owner.accountSessionId, userId: owner.ownerUserId, rootCause: toErrorLogValue(error) });
      });
      retiredCredentialDrains.add(tracked);
    };
    desktopCloudAccount = createDesktopCloudAccount({
      clientId: config.clientId, deviceId: deviceIdentity.deviceId, clientVersion: selfVersion!, timeoutMs: config.timeoutPolicy.startupTimeoutMs,
      getWorkspaceIds: () => Array.from(workspaces.keys()),
      isHostCommandAuthorized: isDesktopHostCommandAuthorized,
      onOwnerInvalidated: retireDesktopOwner,
      getCredentialCleanupErrorCode: () => retiredCredentialFailures.length ? "DESKTOP_CREDENTIAL_RELEASE_FAILED" : null,
      onRequestCancelled: context => logger.info("desktop-cloud", "old account request cancelled after owner revocation", { code: "DESKTOP_CLOUD_OWNER_CANCELLED", requestId: desktopRequestId, clientId: config.clientId, ...context }),
      /** Key 失败显式投影并终止自动启用，已认证连接保持 linked。 */
      onLinked: async owner => {
        desktopCloudAccount!.assertOwner(owner);
        // 原Scheduler观察并保留扫描失败；关联回调不拥有云连接关闭权。
        void scheduledTaskScheduler.syncAndTick("desktop.accountLinked");
        const requestId = crypto.randomUUID();
        const result = await enableBuiltInRelayOnStartup({ target: db,
          withDatabase: operation => withDatabase(requestId, operation),
          ensureCredential: async () => { await builtInRelayCredentials.ensure({ engine: "codex", providerId: "openai", requestId, intent: "auto",
            prepareKeySwitch: async () => { await prepareCodexKeySwitch(apiHandlerContext, false); await sessions.restartCodexProcesses(); } }); },
          notifyKeysChanged: () => { desktopLifecycle.publishEvent({ t: "engineKeys.changed" }); },
        });
        desktopCloudAccount!.assertOwner(owner);
        if (result.outcome === "failed") {
          logger.error("desktop-cloud", "built-in relay auto enable failed", { errorCode: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED", requestId, clientId: config.clientId, accountSessionId: owner.accountSessionId, userId: owner.ownerUserId, providerId: "openai", stage: result.stage, markerPersisted: result.markerPersisted, rootCause: { ...toBuiltInRelayFailureLogValue(result.cause), message: result.message } });
          return { builtInRelayErrorCode: result.stage === "marker" ? "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED" as const : "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" as const };
        }
      },
      onFailure: (error, context) => { logger.error("desktop-cloud", "cloud account connection failed", { errorCode: "DESKTOP_CLOUD_CONNECTION_FAILED", requestId: desktopRequestId, clientId: config.clientId, ...context, rootCause: toBuiltInRelayFailureLogValue(error) }); },
      /** 只应用原模型目录和计价，不进入个人资产接管、恢复或定时任务入口。 */
      onHello: async (message, owner, activation) => {
        activation.assertCurrent();
        if (!message.engineModelCatalog) throw new Error("DESKTOP_CLOUD_MODEL_CATALOG_REQUIRED");
        const ack = await withDatabase("desktop-cloud:model-catalog", () => applyEngineModelCatalogSnapshot(message.engineModelCatalog!, Date.now(), `desktop-cloud-${owner.generation}-${message.engineModelCatalog!.configVersion}`));
        activation.assertCurrent();
        const sent = activation.send({ t: "engine.models.applied", ack });
        if (!sent.accepted) throw new Error("DESKTOP_CLOUD_MODEL_CATALOG_ACK_FAILED");
        if (message.relayPricingCatalog) applyRelayPricingCatalog(message.relayPricingCatalog);
        currentClientHello = message;
        apiHandlerContext.serverWsUrl = owner.serverOrigin.replace(/^http/u, "ws") + "/ws/client";
        localEventRelay = createLocalEventRelay({ db, serverUrl: owner.serverOrigin, ackTimeoutMs: config.timeoutPolicy.startupTimeoutMs,
          withDatabase: operation => withDatabase("conversation-relay", operation),
          readReadyThroughSeq: async workspaceId => {
            await eventPipeline?.flush(workspaceId);
            if (databaseWriter) return databaseWriter.readReadyThroughSeq(workspaceId);
            if (!localEventPersistence) throw new Error("DESKTOP_EVENT_RUNTIME_NOT_READY");
            return localEventPersistence.readReadyThroughSeq(workspaceId);
          }, send: value => sendToServer(value, true), onError: failLocalEventRelay });
      },
      /** 每帧沿 owner 栅栏进入原业务处理器，只有 Server 授权范围可激活投递。 */
      onMessage: async (message, owner) => {
        desktopCloudAccount!.assertOwner(owner);
        if (message.t === "conversation.event.relayScopes") {
          const identity = currentClientHello?.userSummary;
          if (!localEventRelay || !Array.isArray(message.scopes) || message.scopes.some(scope => scope.clientId !== config.clientId
            || scope.userId !== owner.ownerUserId || scope.enterpriseId !== identity?.enterpriseId
            || (scope.kind === "personal" && !workspaces.has(scope.workspaceId)))) throw new Error("DESKTOP_CLOUD_RELAY_SCOPE_INVALID");
          desktopHostScopes = message.scopes
            .filter((scope): scope is Extract<import("@codeflowai/shared").ConversationRelayScope, { kind?: "shared" }> => scope.kind !== "personal")
            .map(scope => ({ ...scope }));
          authorizedRelayScopes = message.scopes.map(scope => ({ ...scope }));
          for (const [id, demand] of remoteDataDemands) {
            if (!authorizedRelayScopes.some(scope => Object.keys(scope).every(key => (demand.scope as any)[key] === (scope as any)[key]))) remoteDataDemands.delete(id);
          }
          localEventRelay.activate(message.scopes, owner.generation); flushLocalEventRelay(); return;
        }
        if (message.t === "remote.data.demand") { applyRemoteDataDemand(message.demand, message.active); return; }
        if (message.t === "reminder.deliveryResult") { reminderDelivery.accept(message); return; }
        if (message.t === "conversation.event.relayDemand") {
          if (!localEventRelay || currentClientHello?.capabilities?.localCanonicalRelayOnDemandV1 !== true) throw new Error("CONVERSATION_RELAY_ON_DEMAND_REQUIRED");
          try {
            const ready = await localEventRelay.setDemand(message.demand, message.active, owner.generation);
            desktopCloudAccount!.assertOwner(owner);
            if (ready && !sendToServer({ t: "conversation.event.relayReady", ready }).accepted) throw new Error("CONVERSATION_RELAY_READY_REJECTED");
            if (ready?.ok) flushLocalEventRelay();
          } catch (cause) {
            const ready = { requestId: message.demand.requestId, demandId: message.demand.demandId, generation: message.demand.generation,
              scope: message.demand.scope, ok: false as const, errorCode: "CONVERSATION_RELAY_DEMAND_FAILED", message: "会话订阅未就绪" };
            if (!sendToServer({ t: "conversation.event.relayReady", ready }).accepted) throw new AggregateError([cause], "CONVERSATION_RELAY_FAILURE_RESPONSE_REJECTED", { cause });
            throw cause;
          }
          return;
        }
        if (message.t === "conversation.eventRelayAck" || message.t === "thread.history.cleanedAck") {
          if (!localEventRelay) throw new Error("DESKTOP_CLOUD_RELAY_UNAVAILABLE");
          if (await localEventRelay.acceptAck(message, owner.generation)) flushLocalEventRelay(); return;
        }
        if (message.t === "engine.models.appliedConfirmed") { confirmEngineModelCatalogApplied(message); return; }
        if (message.t === "engine.models.dispatchResume") { cancelEngineModelCatalogDispatchPause(message.operationId); return; }
        if (message.t === "engine.models.updated") {
          const ack = await withDatabase("desktop-cloud:model-catalog", () => applyEngineModelCatalogSnapshot(message.catalog, Date.now(), message.operationId ?? `desktop-cloud-${owner.generation}-${message.catalog.configVersion}`));
          if (!sendToServer({ t: "engine.models.applied", ack }).accepted) throw new Error("DESKTOP_CLOUD_MODEL_CATALOG_ACK_FAILED"); return;
        }
        if (message.t === "engine.models.dispatchPause") {
          const ack = await pauseEngineModelCatalogDispatch(message); desktopCloudAccount!.assertOwner(owner);
          if (!sendToServer({ t: "engine.models.dispatchPaused", ack }).accepted) throw new Error("DESKTOP_CLOUD_MODEL_PAUSE_ACK_FAILED"); return;
        }
        if (message.t === "relay.pricing.updated") { applyRelayPricingCatalog(message.catalog); return; }
        if (message.t.startsWith("terminal.")) {
          handleDesktopCloudTerminalMessage({ terminalManager, workspaces, workspaceOperationGate,
            assertOwner: () => desktopCloudAccount!.assertOwner(owner), send: publishDesktopTerminalMessage }, message);
          return;
        }
        if (message.t === "api.req") {
          const result = await executeDesktopAccountTaskRequest(desktopApiHandlerContext, message, { owner, clientVersion: selfVersion, startedAt: runtimeStartedAt });
          desktopCloudAccount!.assertOwner(owner);
          if (!desktopCloudAccount!.send(result).accepted) throw new Error("DESKTOP_ACCOUNT_TASK_RESPONSE_SEND_FAILED"); return;
        }
        if (message.t === "sharedWorkspace.command") {
          assertDesktopHostCommand(message); await handleSharedWorkspaceCommand(desktopHostContext(owner), message.envelope);
          desktopCloudAccount!.assertOwner(owner); flushLocalEventRelay(); return;
        }
        throw new Error(`DESKTOP_CLOUD_MESSAGE_NOT_AUTHORIZED: ${message.t}`);
      },
      executeHostTask: async (task, owner) => {
        desktopCloudAccount!.assertOwner(owner);
        if (task.message.t === "api.req") return [await executeDesktopAccountTaskRequest(desktopApiHandlerContext, task.message,
          { owner, clientVersion: selfVersion, startedAt: runtimeStartedAt })];
        assertDesktopHostCommand(task.message);
        const result = await executeHostRpcHttpTask(desktopHostContext(owner), task);
        desktopCloudAccount!.assertOwner(owner); flushLocalEventRelay(); return result;
      },
    });
    apiHandlerContext.desktopCloudAccount = desktopCloudAccount;
    desktopApiHandlerContext.desktopCloudAccount = desktopCloudAccount;
  }

  transport = new WsTransport({
    url: config.serverWsUrl,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    events: {
      onOpen: () => {
        currentClientHello = null;
        markCurrentClientDaemonStartup("authenticating");
        serverMessageConnectionGeneration = serverMessageHelloReadyFence.beginConnection();
        if (!firstConnect) eventFlowMonitor.recordReconnect();
        logClientStep("info", "transport.open", "success", "ws transport opened", {
          target: { clientId: config.clientId },
          serverWsUrl: config.serverWsUrl,
          workspaceCount: workspaces.size,
          firstConnect,
        });
        logger.info("client", `connected url=${config.serverWsUrl}`);
        const helloResult = sendToServer({
          t: "client.hello",
          clientId: config.clientId,
          deviceId: deviceIdentity.deviceId,
          version: selfVersion ?? undefined,
          platform: process.platform,
          arch: process.arch,
          workspaceIds: Array.from(workspaces.keys()),
          capabilities: {
            selfUpgrade,
            sharedThreadAclLocal: true,
            sharedThreadAclInlineList: true,
            sharedOrchestrationResourceAclLocal: true,
            hostRpcHttpLongPoll: true,
            workspaceDirectoryMigrationV1: true,
            threadInputActionsV1: true,
            engineModelCatalogV1: true,
            remoteDataDemandV1: true,
            localCanonicalRelayV1: true, localCanonicalRelayOnDemandV1: true,
          },
        } satisfies ClientToServerMessage);
        logClientStep(helloResult.accepted ? "info" : "warn", "transport.hello_sent", helloResult.accepted ? "success" : "fail", "client hello sent", {
          target: { clientId: config.clientId },
          version: selfVersion ?? undefined,
          workspaceCount: workspaces.size,
          bytes: helloResult.bytes,
          reason: helloResult.reason,
          readyState: helloResult.readyState,
        });
      },
      onError: (message) => {
        logClientStep("warn", "transport.error", "warn", "ws transport error", {
          target: { clientId: config.clientId },
          serverWsUrl: config.serverWsUrl,
          message,
          firstConnect,
        });
        const hint = resolveServerConnectionHint({
          serverWsUrl: config.serverWsUrl,
          message,
          code: null,
          reason: "",
          hasConnectedBefore: !firstConnect,
        });
        if (!hint) return;
        printConnectionHintOnce(hint, {
          force: firstConnect,
          keyRef: () => lastConsoleConnectionHintKey,
          setKey: (value) => { lastConsoleConnectionHintKey = value; },
          timeRef: () => lastConsoleConnectionHintAt,
          setTime: (value) => { lastConsoleConnectionHintAt = value; },
        });
      },
      /** 连接投递失败交由 Transport/onClose 处理；队列溢出保留显式退出。 */
      onDeliveryFailure: (failure) => {
        logClientStep("error", "transport.delivery_failed", "fail", "ws outbound delivery failed", {
          target: { clientId: config.clientId },
          failure,
        });
        if (failure.phase === "queue_overflow") {
          shutdown(`transport_delivery_failed:${failure.phase}:${failure.messageType ?? "unknown"}`, 1);
        }
      },
      onMessageFailure: (failure) => {
        if (conversationEventAckBuffer.isFailure(failure.error) || rawEventAckBuffer.isFailure(failure.error) || threadTouchBuffer.isFailure(failure.error)) return { handled: true };
        const msg = safeParse(failure.data);
        if (msg?.t === "api.req") {
          const result = dispatchWorkspaceApiRequestFailure({ error: failure.error, requestId: msg.id, send: sendToServer });
          if (result) {
            if (result.response === "rejected") throw result.error;
            return { handled: true };
          }
        }
        if (msg) {
          handleTransportMessageFailure(msg, failure.error);
          return { handled: true };
        }
        logClientStep("error", "transport.message_handler_rejected", "fail", "ws inbound handler rejected", {
          target: { clientId: config.clientId },
          messageType: failure.messageType,
          bytes: failure.bytes,
          queuedMs: Math.max(0, Date.now() - failure.queuedAt),
          handlerDurationMs: failure.handlerDurationMs,
          error: toErrorLogValue(failure.error),
        });
        if (!shutdownRequested) shutdown("transport_message_handler_failed:unparsed", 1);
        return { handled: true };
      },
      onClose: (info) => {
        localEventRelay?.disconnect(serverMessageConnectionGeneration);
        reminderDelivery.disconnect(new Error("REMINDER_DELIVERY_CONNECTION_RETIRED"));
        authorizedRelayScopes = []; remoteDataDemands.clear();
        if (!shutdownRequested && info.disposition === "reconnect") {
          pauseEngineModelCatalogDispatchForReconnect(
            `engine-model-catalog-reconnect-${serverMessageConnectionGeneration}`,
          );
        }
        currentClientHello = null;
        if (!shutdownRequested) markCurrentClientDaemonStartup(info.disposition === "reconnect" ? "disconnected" : "failed");
        serverMessageHelloReadyFence.closeConnection(serverMessageConnectionGeneration);
        if (initialLinkRequired && !initialLinkSettled && (info.disposition === "blocked" || info.disposition === "stop")) {
          failInitialLink(`transport_initial_close:${info.disposition}`, 1);
          return;
        }
        if (info.disposition === "reconnect") {
          eventFlowMonitor.recordDisconnect(info.diagnostic.queue.evidenceMessages);
        }
        rollbackEvidenceFence.rejectAll(new Error(`Client WebSocket 已关闭：code=${info.code}, reason=${info.reason}`));
        logClientStep("warn", "transport.close", info.disposition === "reconnect" ? "warn" : "fail", "ws transport closed", {
          target: { clientId: config.clientId },
          code: info.code,
          reason: info.reason,
          disposition: info.disposition,
          diagnostic: info.diagnostic,
          recentEventLoopLag: lastEventLoopLagSnapshot,
          pendingConversationEventAcks: conversationEventAckBuffer.getPendingCount(),
          pendingRawEventAcks: rawEventAckBuffer.getPendingCount(),
          pendingThreadTouches: threadTouchBuffer.getPendingCount(),
        });
        logger.warn("client", "disconnected", {
          code: info.code,
          reason: info.reason,
          disposition: info.disposition,
          diagnostic: info.diagnostic,
          recentEventLoopLag: lastEventLoopLagSnapshot,
          pendingConversationEventAcks: conversationEventAckBuffer.getPendingCount(),
          pendingRawEventAcks: rawEventAckBuffer.getPendingCount(),
          pendingThreadTouches: threadTouchBuffer.getPendingCount(),
        });
        const hint = resolveServerConnectionHint({
          serverWsUrl: config.serverWsUrl,
          message: info.diagnostic.lastSendFailure?.reason ?? null,
          code: info.code,
          reason: info.reason,
          hasConnectedBefore: !firstConnect,
        });
        if (hint) {
          printConnectionHintOnce(hint, {
            force: info.disposition !== "reconnect",
            keyRef: () => lastConsoleConnectionHintKey,
            setKey: (value) => { lastConsoleConnectionHintKey = value; },
            timeRef: () => lastConsoleConnectionHintAt,
            setTime: (value) => { lastConsoleConnectionHintAt = value; },
          });
        }
        if (isIncompatibleClientReason(info.reason)) {
          void printManualUpgradeHint(config.serverWsUrl);
        }
        if (info.disposition === "blocked") {
          logClientStep("error", "transport.blocked_close", "fail", "client connection blocked; supervisor will retry", {
            target: { clientId: config.clientId },
            code: info.code,
            reason: info.reason,
          });
          logger.error("client", `blocked close code=${info.code} (supervisor retry)`);
          shutdown(`blocked_close:${info.code}`, CLIENT_PROCESS_EXIT_CODE_BLOCKED);
        } else if (info.disposition === "stop") {
          logClientStep("info", "transport.stop_close", "success", "explicit ws stop received; exiting", {
            target: { clientId: config.clientId },
            code: info.code,
            reason: info.reason,
          });
          logger.info("client", `stop close code=${info.code} (exit)`);
          shutdown(`stop_close:${info.code}`, 0);
        }
      },
      onDiagnostic: (level, message) => {
        logger[level]("heartbeat", message);
      },
      /** 按连接代际门控入站消息并记录 ACK 流量；停机 drain 阶段仍保留 raw ACK 落库。 */
      onMessage: async (data, inboundMeta) => {
        const messageConnectionGeneration = serverMessageConnectionGeneration;
        let parsedMessage: ServerToClientMessage | null = null;
        try {
        const msg = safeParse(data);
        if (!msg) return;
        parsedMessage = msg;
        // 停机时 Transport 会先同步排空入站 FIFO，raw/canonical ACK 仍需完成落库。
        eventFlowMonitor.recordAck(msg, inboundMeta.bytes);
        if (
          shutdownRequested
          && msg.t !== "raw.eventAck"
          && msg.t !== "conversation.eventAck"
        ) return;
        const handlesCatalogConfirmationBeforeHelloReady = msg.t === "engine.models.appliedConfirmed";
        if (msg.t !== "client.helloAck" && !handlesCatalogConfirmationBeforeHelloReady && !shutdownRequested) {
          const helloReady = await serverMessageHelloReadyFence.waitUntilReady(messageConnectionGeneration);
          if (!helloReady || !serverMessageHelloReadyFence.isCurrent(messageConnectionGeneration)) {
            logClientStep("warn", "transport.message_before_hello_ready", "skip", "server message dropped because its connection did not finish hello activation", {
              target: { clientId: config.clientId },
              messageType: msg.t,
              connectionGeneration: messageConnectionGeneration,
            });
            return;
          }
        }
        if (msg.t === "client.helloAck") {
          currentClientHello = msg;
          await activateClientHello(msg, messageConnectionGeneration);
          return;
        }
        if (msg.t === "conversation.event.relayScopes") {
          if (!localEventRelay || currentClientHello?.capabilities?.localCanonicalRelayV1 !== true) {
            throw new Error("LOCAL_EVENT_RELAY_NOT_NEGOTIATED");
          }
          const identity = currentClientHello.userSummary;
          if (!Array.isArray(msg.scopes) || msg.scopes.some(scope => scope.clientId !== config.clientId
            || scope.userId !== identity?.userId || scope.enterpriseId !== identity?.enterpriseId)) {
            throw new Error("LOCAL_EVENT_RELAY_SCOPE_IDENTITY_INVALID");
          }
          localEventRelay.activate(msg.scopes, messageConnectionGeneration);
          authorizedRelayScopes = msg.scopes.map(scope => ({ ...scope }));
          flushLocalEventRelay();
          return;
        }
        if (msg.t === "remote.data.demand") { applyRemoteDataDemand(msg.demand, msg.active); return; }
        if (msg.t === "reminder.deliveryResult") { reminderDelivery.accept(msg); return; }
        if (msg.t === "conversation.event.relayDemand") {
          if (!localEventRelay || currentClientHello?.capabilities?.localCanonicalRelayOnDemandV1 !== true) throw new Error("CONVERSATION_RELAY_ON_DEMAND_REQUIRED");
          const ready = await localEventRelay.setDemand(msg.demand, msg.active, messageConnectionGeneration);
          if (!serverMessageHelloReadyFence.isCurrent(messageConnectionGeneration)) return;
          if (ready && !sendToServer({ t: "conversation.event.relayReady", ready }).accepted) throw new Error("CONVERSATION_RELAY_READY_REJECTED");
          if (ready?.ok) flushLocalEventRelay();
          return;
        }
        if (msg.t === "relay.pricing.updated") {
          applyRelayPricingCatalog(msg.catalog);
          return;
        }
        if (msg.t === "engine.models.dispatchPause") {
          const ack = await pauseEngineModelCatalogDispatch(msg);
          const ackResult = sendToServer({ t: "engine.models.dispatchPaused", ack } satisfies ClientToServerMessage);
          if (!ackResult.accepted) {
            throw Object.assign(new Error(`模型目录派发暂停回执发送失败：${ackResult.reason ?? "unknown"}`), {
              code: "ENGINE_MODEL_CATALOG_PAUSE_ACK_SEND_FAILED",
            });
          }
          return;
        }
        if (msg.t === "engine.models.dispatchResume") {
          cancelEngineModelCatalogDispatchPause(msg.operationId);
          return;
        }
        if (msg.t === "engine.models.updated") {
          const operationId = msg.operationId
            ?? getEngineModelCatalogDispatchPauseOperationId()
            ?? `engine-model-catalog-update-${msg.catalog.configVersion}-${messageConnectionGeneration}`;
          const ack = await withDatabase("client:model-catalog", () => applyEngineModelCatalogSnapshot(msg.catalog, Date.now(), operationId));
          const ackResult = sendToServer({ t: "engine.models.applied", ack } satisfies ClientToServerMessage);
          if (!ackResult.accepted) {
            throw Object.assign(new Error(`模型目录应用回执发送失败：${ackResult.reason ?? "unknown"}`), {
              code: "ENGINE_MODEL_CATALOG_ACK_SEND_FAILED",
            });
          }
          return;
        }
        if (msg.t === "engine.models.appliedConfirmed") {
          confirmEngineModelCatalogApplied(msg);
          return;
        }
        if (msg.t === "server.workspaceDirectoryMigrationAck") {
          if (!Number.isSafeInteger(msg.stateVersion) || !Number.isSafeInteger(msg.acknowledgedAt)) {
            throw new Error(`迁移通知 ACK 参数非法：operationId=${msg.operationId}`);
          }
          await withDatabase(`migration-ack:${msg.operationId}`, () => {
          const current = db.workspaceDirectoryMigrations.require(msg.operationId);
          const matched = current.notificationPending && current.notificationStateVersion === msg.stateVersion;
          db.workspaceDirectoryMigrations.acknowledgeNotification(
            msg.operationId,
            msg.stateVersion,
            msg.acknowledgedAt,
          );
          logger.info("workspace-migration", matched ? "workspace migration notification acknowledged" : "stale workspace migration notification ACK ignored", {
            code: matched ? "workspace_migration_notification_acknowledged" : "workspace_migration_notification_ack_ignored",
            operationId: msg.operationId,
            stateVersion: msg.stateVersion,
            currentStateVersion: current.stateVersion,
            notificationStateVersion: current.notificationStateVersion,
          });
          });
          return;
        }
        if (msg.t === "server.workspaceDirectoryMigrationStartFenceAck") {
          if (!Number.isSafeInteger(msg.stateVersion) || !Number.isSafeInteger(msg.acknowledgedAt)) {
            throw new Error(`迁移 start fence ACK 参数非法：operationId=${msg.operationId}`);
          }
          await withDatabase(`migration-fence-ack:${msg.operationId}`, () => {
          const current = db.workspaceDirectoryMigrations.require(msg.operationId);
          const matched = current.startFenceAckPending
            && current.startAttemptId === msg.startAttemptId
            && current.stateVersion === msg.stateVersion;
          db.workspaceDirectoryMigrations.acknowledgeStartFence(
            msg.operationId,
            msg.startAttemptId,
            msg.stateVersion,
            msg.acknowledgedAt,
          );
          logger.info("workspace-migration", matched ? "workspace migration start fence acknowledged" : "stale workspace migration start fence ACK ignored", {
            code: matched ? "workspace_migration_start_fence_acknowledged" : "workspace_migration_start_fence_ack_ignored",
            operationId: msg.operationId,
            startAttemptId: msg.startAttemptId,
            stateVersion: msg.stateVersion,
            currentStateVersion: current.stateVersion,
            currentStartAttemptId: current.startAttemptId,
          });
          });
          return;
        }
        if (msg.t === "conversation.eventAck") {
          throw new Error("CLIENT_REMOTE_EVENT_RENUMBERING_FORBIDDEN");
        }
        if (msg.t === "conversation.eventRelayAck") {
          if (!localEventRelay) throw new Error("LOCAL_EVENT_RELAY_NOT_ENABLED");
          if (await localEventRelay.acceptAck(msg, messageConnectionGeneration)) flushLocalEventRelay();
          return;
        }
        if (msg.t === "thread.history.cleanedAck") {
          if (!localEventRelay) throw new Error("LOCAL_EVENT_RELAY_NOT_ENABLED");
          if (await localEventRelay.acceptAck(msg, messageConnectionGeneration)) flushLocalEventRelay();
          return;
        }
        if (msg.t === "raw.eventAck") {
          throw new Error("CLIENT_REMOTE_EVENT_RENUMBERING_FORBIDDEN");
        }
        if (msg.t.startsWith("terminal.")) {
          await withDatabase("terminal:message", () => handleTerminalMessage(
            { terminalManager, workspaces, workspaceOperationGate, send: (m) => desktopLifecycle ? publishDesktopTerminalMessage(m) : sendToServer(m) },
            msg,
          ));
          return;
        }
        if (msg.t === "api.req") {
          await handleApiRequest(apiHandlerContext, msg);
          return;
        }
        if (msg.t === "sharedWorkspace.command") {
          logClientStep("info", "shared_workspace.command_received", "start", "shared workspace command received", {
            target: { clientId: config.clientId },
            workspaceId: msg.envelope.localWorkspaceId,
            operationId: msg.envelope.operationId,
            operationKey: msg.envelope.operationKey,
            auditAction: msg.envelope.policy.auditAction,
          });
          try {
            await handleSharedWorkspaceCommand(apiHandlerContext, msg.envelope);
            logClientStep("info", "shared_workspace.command_handled", "success", "shared workspace command handled", {
              target: { clientId: config.clientId },
              workspaceId: msg.envelope.localWorkspaceId,
              operationId: msg.envelope.operationId,
              operationKey: msg.envelope.operationKey,
              auditAction: msg.envelope.policy.auditAction,
            });
          } catch (error) {
            logClientStep("error", "shared_workspace.command_handled", "fail", "shared workspace command handling failed", {
              target: { clientId: config.clientId },
              workspaceId: msg.envelope.localWorkspaceId,
              operationId: msg.envelope.operationId,
              operationKey: msg.envelope.operationKey,
              auditAction: msg.envelope.policy.auditAction,
              error: toErrorLogValue(error),
            });
            throw error;
          }
        }
        } catch (error) {
          if (conversationEventAckBuffer.isFailure(error) || rawEventAckBuffer.isFailure(error) || threadTouchBuffer.isFailure(error)) throw error;
          if (parsedMessage?.t === "api.req" && isWorkspaceApiRequestFailure(error)) throw error;
          if (parsedMessage?.t === "client.helloAck") {
            serverMessageHelloReadyFence.closeConnection(messageConnectionGeneration);
          }
          if (parsedMessage) {
            handleTransportMessageFailure(parsedMessage, error);
            return;
          }
          logClientStep("error", "transport.message_dispatched", "fail", "server message dispatch failed; shutting down", {
            target: { clientId: config.clientId },
            error: toErrorLogValue(error),
          });
          shutdown("transport_message_dispatch_failed", 1);
        }
      },
    },
  });

  if (desktopLifecycle) {
    logClientStep("info", "transport.local_mode", "success", "local runtime initialized without a cloud connection", {
      requestId: desktopRequestId, target: { clientId: config.clientId }, cloudConnected: false,
    });
  }
  /** 统一释放本地资源；重复请求等待同一个清理结果。 */
  function shutdown(reason = "signal", exitCode = 0): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    markCurrentClientDaemonStartup(exitCode === 0 ? "stopping" : "failed");
    if (!initialLinkSettled) {
      initialLinkSettled = true;
      markCurrentClientDaemonInitialConnection("failed");
    }
    if (initialLinkTimer) {
      clearTimeout(initialLinkTimer);
      initialLinkTimer = null;
    }
    shutdownPromise = shutdownAndExit(reason, exitCode);
    return shutdownPromise;
  }

  function markInitialLinkSucceeded(): void {
    if (initialLinkSettled) return;
    initialLinkSettled = true;
    if (initialLinkTimer) {
      clearTimeout(initialLinkTimer);
      initialLinkTimer = null;
    }
    markCurrentClientDaemonInitialConnection("succeeded");
  }

  function failInitialLink(reason: string, exitCode: number): void {
    if (!initialLinkRequired || initialLinkSettled) return;
    initialLinkSettled = true;
    if (initialLinkTimer) {
      clearTimeout(initialLinkTimer);
      initialLinkTimer = null;
    }
    markCurrentClientDaemonInitialConnection("failed");
    try {
      transport?.stop();
    } catch {
      // shutdownAndExit 仍会释放剩余资源。
    }
    shutdown(reason, exitCode);
  }

  /** 消息处理失败时按证据层级隔离；旧终态映射冲突不得伤害当前 successor。 */
  function handleTransportMessageFailure(msg: ServerToClientMessage, error: unknown): void {
    if (localEventRelay && (msg.t === "conversation.event.relayScopes" || msg.t === "conversation.eventRelayAck" || msg.t === "thread.history.cleanedAck")) {
      failLocalEventRelay(error);
      return;
    }
    const event = (msg as any)?.event;
    const indexedTurnId = String(event?.payload?.turnId ?? event?.clientTurnId ?? "").trim() as TurnId;
    if (shutdownRequested) {
      logger.warn("transport", "message handler failed after shutdown started", {
        messageType: msg.t,
        threadId: String(event?.threadId ?? "").trim() || null,
        turnId: indexedTurnId || null,
        error: toErrorLogValue(error),
      });
      return;
    }
    const errorCode = String((error as { code?: unknown } | null)?.code ?? "");
    if (
      (msg.t === "engine.models.updated"
        || msg.t === "engine.models.dispatchPause"
        || msg.t === "engine.models.appliedConfirmed"
        || msg.t === "client.helloAck")
      && errorCode.startsWith("ENGINE_MODEL_CATALOG_")
    ) {
      logClientStep("warn", "transport.engine_model_catalog_message", "fail", "engine model catalog message rejected; reconnecting", {
        target: { clientId: config.clientId },
        messageType: msg.t,
        errorCode,
        error: toErrorLogValue(error),
      });
      transport?.reconnect("Engine model catalog reconciliation required");
      return;
    }
    const prepared = prepareTransportMessageFailure({
      messageType: msg.t,
      error,
      event: event ?? null,
      loadTurn: (turnId) => {
        if (!event?.workspaceId) throw new Error("EVENT_WORKSPACE_SCOPE_REQUIRED");
        return db.forWorkspace(event.workspaceId).turns.get(turnId as TurnId);
      },
      // 降级边界：被隔离的 ACK 必须已严格落库，后续回滚/恢复才能显式看到冲突并对账。
      flushConversationEvidence: flushConversationEventEvidence,
      flushRawEvidence: flushRawEventEvidence,
    });
    const disposition = prepared.disposition;
    const effectiveError = prepared.effectiveError;
    const eventSeq = Number(event?.seq ?? 0);
    const providerTurnId = String(event?.data?.params?.turn?.id ?? event?.data?.params?.turnId ?? "").trim() || null;
    const isolated = disposition !== "shutdown_client";
    const message = isolated ? "workspace event ACK failure isolated" : "server message handling failed; shutting down";
    const diagnostic = { code: "TRANSPORT_MESSAGE_HANDLED_FAILED", errorCode: "TRANSPORT_MESSAGE_HANDLED_FAILED", requestId: `inbound:${msg.t}:${eventSeq}`,
      workspaceId: event?.workspaceId ?? null, threadId: event?.threadId ?? null, clientTurnId: indexedTurnId || null,
      messageType: msg.t, providerTurnId, eventSeq: Number.isSafeInteger(eventSeq) && eventSeq > 0 ? eventSeq : null,
      failureDisposition: disposition, rootCause: describeWorkspaceApiFailure(effectiveError).rootCause };
    if (event?.workspaceId && workspaces.has(event.workspaceId)) {
      try { db.writeWorkspaceLog(event.workspaceId, { level: "error", tag: "transport", message, data: diagnostic }); }
      catch (diagnosticError) { throw new AggregateError([effectiveError, diagnosticError], "WORKSPACE_TRANSPORT_LOG_FAILED", { cause: effectiveError }); }
    } else logClientStep("error", "transport.message_handled", "fail", message, diagnostic);
    if (isolated) return;
    if (!shutdownRequested) shutdown(`transport_message_handler_failed:${msg.t}`, 1);
  }

  /** 停止接收新消息后释放本地资源，并在日志冲刷完成后退出进程。 */
  async function shutdownAndExit(reason = "signal", exitCode = 0): Promise<never> {
    shutdownRequested = true;
    const shutdownStartedAt = Date.now();
    const cleanupErrors: Array<{ step: string; error: unknown }> = [];
    let resourcesDrained = true;
    /** 每一步都保留诊断与清理错误，后续必要释放仍执行。 */
    const runCleanupStep = (step: string, action: () => void): void => {
      const startedAt = Date.now();
      try {
        runClientCleanupStep(action, (phase, error) => logClientStep(phase === "fail" ? "error" : "info", `shutdown.${step}`, phase,
          `shutdown ${step} ${phase}`, { target: { clientId: config.clientId }, requestId: `shutdown:${process.pid}`, reason, durationMs: Date.now() - startedAt,
            ...(phase === "fail" ? { errorCode: "CLIENT_CLEANUP_STEP_FAILED" } : {}),
            ...(phase === "fail" ? { errorMessage: describeWorkspaceApiFailure(error).message,
              rootCause: describeClientErrorTree(error) } : {}) }));
      } catch (error) {
        cleanupErrors.push({ step, error });
      }
    };
    /** 普通诊断单独降级；正文与资源清理继续由原失败边界处理。 */
    const runDiagnostic = (action: () => void): void => {
      runClientCleanupStep(() => {}, phase => { if (phase === "start") action(); });
    };
    runCleanupStep("workspace_migration_stop", () => workspaceMigrationService.stop());
    runDiagnostic(() => logClientStep("info", "shutdown.begin", "start", "client shutdown requested", {
      target: { clientId: config.clientId },
      reason,
      pendingConversationEventAcks: conversationEventAckBuffer.getPendingCount(),
      pendingRawEventAcks: rawEventAckBuffer.getPendingCount(),
      pendingThreadTouches: threadTouchBuffer.getPendingCount(),
      recentEventLoopLag: lastEventLoopLagSnapshot,
      requestedExitCode: exitCode,
    }));
    runDiagnostic(() => logger.info("client", "shutdown requested", { reason }));
    if (desktopLifecycle) {
      try { await desktopLifecycle.drainRequests(2_000, { keepEventPublishing: true }); }
      catch (error) {
        resourcesDrained = false;
        runCleanupStep("desktop_api_drain", () => { throw error; });
      }
    }
    runCleanupStep("host_rpc_http_stop", () => hostRpcHttpTransport.stop());
    runCleanupStep("transport_stop", () => transport?.stop());
    runCleanupStep("local_event_relay_stop", () => localEventRelay?.dispose());
    runCleanupStep("scheduled_tasks_stop", () => scheduledTaskScheduler.stop());
    runCleanupStep("orchestration_stop", () => orchEngine.stop());
    runCleanupStep("event_flow_monitor_stop", () => eventFlowMonitor.dispose());
    runCleanupStep("client_db_cleanup_stop", () => dbCleanup?.dispose());

    /** Client 自身保留清理预算；桌面宿主在 10 秒未关闭时统一强杀进程树。 */
    const shutdownDrainDeadline = shutdownStartedAt + 25_000;
    /** 关闭排空必须有界；超时保留资源未排空事实，但不允许进程永久挂起。 */
    const withShutdownTimeout = async <T>(step: string, run: () => Promise<T>, timeoutMs = shutdownDrainDeadline - Date.now()): Promise<T> => {
      if (timeoutMs <= 0) throw Object.assign(new Error(`${step} 关闭排空超过总预算`), { code: "CLIENT_CLEANUP_STEP_TIMEOUT" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${step} 关闭排空超时`), { code: "CLIENT_CLEANUP_STEP_TIMEOUT" })), timeoutMs);
      });
      try { return await Promise.race([run(), timeout]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    };

    /** 执行异步关闭步骤；每步受关闭总预算限制，失败进入统一 cleanupErrors 并阻止成功退出码。 */
    const runAsyncCleanupStep = async (step: string, action: () => Promise<void>): Promise<void> => {
      const startedAt = Date.now();
      try {
        await runClientAsyncCleanupStep(async () => {
          try { await withShutdownTimeout(step, action); }
          catch (error) { resourcesDrained = false; throw error; }
        }, (phase, error) => logClientStep(phase === "fail" ? "error" : "info", `shutdown.${step}`, phase,
          `shutdown ${step} ${phase}`, { target: { clientId: config.clientId }, requestId: `shutdown:${process.pid}`, reason, durationMs: Date.now() - startedAt,
            ...(phase === "fail" ? { errorCode: "CLIENT_CLEANUP_STEP_FAILED" } : {}),
            ...(phase === "fail" ? { errorMessage: describeWorkspaceApiFailure(error).message,
              rootCause: describeWorkspaceApiFailure(error).rootCause } : {}) }));
      } catch (error) {
        cleanupErrors.push({ step, error });
      }
    };

    runCleanupStep("event_loop_monitor_stop", () => stopEventLoopLagMonitor());
    await runAsyncCleanupStep("raw_event_retention_stop", async () => {
      if (rawEventRetentionStartTimer) clearTimeout(rawEventRetentionStartTimer);
      if (rawEventRetentionTimer) clearInterval(rawEventRetentionTimer);
      rawEventRetentionStartTimer = null;
      rawEventRetentionTimer = null;
      await rawEventRetention.dispose();
    });
    runCleanupStep("reminder_timer_stop", () => {
      if (reminderDirtyTimer) clearTimeout(reminderDirtyTimer);
      reminderDirtyTimer = null;
      pendingReminderDirtyWorkspaces.clear();
    });
    await Promise.all([
      runAsyncCleanupStep("desktop_cloud_drain", async () => { await desktopCloudAccount?.stopAndDrain(); }),
      runAsyncCleanupStep("host_rpc_http_drain", () => hostRpcHttpTransport.stopAndDrain()),
      runAsyncCleanupStep("transport_drain", async () => {
        await transport?.stopAndDrain();
      }),
      runAsyncCleanupStep("scheduled_tasks_drain", () => scheduledTaskScheduler.stopAndDrain()),
      runAsyncCleanupStep("controlled_experiments_dispose", () => controlledExperiments.dispose()),
      runAsyncCleanupStep("knowledge_drain", async () => {
        await Promise.all([...workspaces.values()].map(async workspacePath => {
          const requestId = `shutdown:${process.pid}`;
          await waitForKnowledgeUpdateCheck(workspacePath, { requestId });
          await stopKnowledgeGenerationForUpdate(workspacePath, { requestId });
        }));
      }),
      runAsyncCleanupStep("queue_dispatcher_drain", () => queueDispatcher.waitForIdle()),
      runAsyncCleanupStep("thread_sessions_drain", () => sessions.stopAndDrain()),
      runAsyncCleanupStep("orchestration_drain", () => orchEngine.stopAndDrain()),
    ]);
    await runAsyncCleanupStep("ordinary_turns_drain", () => drainOrdinaryTurnExecutions(sessions));
    await runAsyncCleanupStep("managed_services_drain", () => orchEngine.disposeManagedServices("client-shutdown"));
    await runAsyncCleanupStep("event_index_drain", () => runtime.waitForIdle());
    await runAsyncCleanupStep("desktop_credentials_drain", async () => {
      await Promise.all(retiredCredentialDrains);
      if (retiredCredentialFailures.length) throw new AggregateError(retiredCredentialFailures, "DESKTOP_CREDENTIAL_RELEASE_FAILED");
    });
    await runAsyncCleanupStep("event_pipeline_close", async () => { await eventPipeline?.close(); });
    await runAsyncCleanupStep("desktop_event_bridge_close", async () => { await desktopLifecycle?.drainRequests(2_000); });
    await runAsyncCleanupStep("conversation_ack_buffer_dispose", async () => { await conversationEventAckBuffer.dispose(); });
    await runAsyncCleanupStep("raw_ack_buffer_dispose", async () => { await rawEventAckBuffer.dispose(); });
    await runAsyncCleanupStep("thread_touch_buffer_dispose", async () => { await threadTouchBuffer.dispose(); });
    await runAsyncCleanupStep("workspace_migration_drain", () => workspaceMigrationService.stopAndDrain());
    await runAsyncCleanupStep("workspace_migration_index_dispose", () => workspaceMigrationIndexCoordinator.dispose());
    await runAsyncCleanupStep("workspace_path_index_dispose", () => workspacePathIndex.dispose());
    if (codeAttributionSyncWorker) await runAsyncCleanupStep("code_attribution_sync_stop", () => codeAttributionSyncWorker.stop());
    if (codeAttributionRetentionWorker) await runAsyncCleanupStep("code_attribution_retention_stop", () => codeAttributionRetentionWorker.stop());
    await runAsyncCleanupStep("client_db_reader_close", () => openedClientDbReader.close());
    await runAsyncCleanupStep("event_writer_close", async () => { await databaseWriter?.close(); });
    runCleanupStep("terminal_dispose", () => {
      try { terminalManager.dispose(); }
      catch (error) { resourcesDrained = false; throw error; }
    });
    // 未确认释放时保留连接与进程锁到失败退出，独立资源仍已逐项清理。
    runCleanupStep("db_close", () => {
      if (!resourcesDrained) throw Object.assign(new Error("Client 资源未确认排空，保留数据库和进程锁"), { code: "CLIENT_RESOURCES_NOT_DRAINED" });
      try { db.close(); }
      catch (error) { resourcesDrained = false; throw error; }
    });
    if (resourcesDrained) runCleanupStep("process_lock_release", () => clientProcessLock.release());

    const hasCleanupErrors = cleanupErrors.length > 0;
    runDiagnostic(() => logClientStep(hasCleanupErrors ? "error" : "info", "shutdown.complete", hasCleanupErrors ? "fail" : "success", "client shutdown cleanup finished", {
      target: { clientId: config.clientId },
      reason,
      durationMs: Date.now() - shutdownStartedAt,
      requestedExitCode: exitCode,
      failedSteps: cleanupErrors.map(failure => failure.step),
    }));
    // 显式桌面关闭遇到真实资源失败时保留父链，交给宿主超时强杀，避免先退出后遗留孤儿进程。
    if (reason === "desktop_exit" && desktopLifecycle && process.connected && !resourcesDrained) {
      await new Promise<void>(resolve => {
        process.once("disconnect", resolve);
        // 父进程失联后不再等待其强杀；沿原失败退出结束，避免永远等待不存在的宿主。
        if (!process.connected) { process.removeListener("disconnect", resolve); resolve(); }
      });
    }
    return exitAfterLogFlush(cleanupErrors.length ? 1 : exitCode);
  }
  // 本地启动不等于云端已授权；账号关联完成前不启动云端写回任务。
  // 归因仅由已认证的按需查询驱动，登录不启动后台扫描。
  logClientStep("info", "client.initialized", "success", "local client runtime initialized; awaiting server readiness", {
    target: { clientId: config.clientId },
    serverWsUrl: config.serverWsUrl,
    workspaceCount: workspaces.size,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (desktopLifecycle) {
    const preparation = preparePersistedOrchestrationInstances("desktop");
    logClientStep(preparation.failedCount ? "error" : "info", "desktop.orchestration_snapshot_backfill", preparation.failedCount ? "fail" : "success", "local orchestration preparation finished", {
      requestId: desktopRequestId, target: { clientId: config.clientId }, ...preparation,
    });
  }
  /** 更新沿原业务终态 owner 精确中断，不能把未确认的 provider 当作已经停止。 */
  const interruptForDesktopUpdate = async (target: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId }, operation?: DesktopUpdateOperation): Promise<void> => {
    await interruptTurnBestEffort(desktopApiHandlerContext, target, { ensureTerminalEvent: true });
    const settled = await withDatabase(operation?.requestId ?? "desktop-update:settled", () => db.forWorkspace(target.workspaceId).turns.get(target.turnId));
    if (!settled || (settled.status !== "completed" && settled.status !== "error") || settled.workspaceId !== target.workspaceId || settled.threadId !== target.threadId) {
      throw Object.assign(new Error("更新中断尚未取得精确回合终态"), { code: "DESKTOP_UPDATE_TURN_NOT_SETTLED", requestId: operation?.requestId ?? desktopRequestId, ...target });
    }
  };
  const desktopUpdateControl = desktopLifecycle ? createDesktopUpdateControl({
    context: desktopApiHandlerContext, requestId: desktopRequestId!, queueDispatcher, scheduledTaskScheduler, terminalManager,
    /** 后台文件事务等原安全边界；只等待，不在更新中另造恢复策略。 */
    hasBlockingTransaction: () => withDatabase("desktop-update:blocking", () => workspaceOperationGate.hasActiveWrites() || Boolean(dbCleanup?.isRunning()) || listActiveRollbackMutationThreadIds().length > 0
      || db.workspaceDirectoryMigrations.listActive().some(operation => operation.state !== "awaiting_confirmation" || operation.startDisposition === "prepared")
      || [...workspaces.entries()].some(([workspaceId, workspacePath]) => hasActiveKnowledgeUpdate(workspacePath)
        || workspaceOperationGate.listActivities(workspaceId).some(activity => activity.type !== "orchestration_instance" && activity.type !== "knowledge_update_dispatch"))),
    hasKnowledgeWork: () => [...workspaces.values()].some(workspacePath => hasActiveKnowledgeGeneration(workspacePath)),
    stopKnowledgeWork: async operation => {
      for (const workspacePath of workspaces.values()) {
        operation.signal.throwIfAborted();
        await stopKnowledgeGenerationForUpdate(workspacePath, { requestId: operation.requestId });
      }
    },
    hasAssetDraftWork: () => withDatabase("desktop-update:asset-work", () => [...workspaces.keys()].filter(id => !workspaceOperationGate.getMigrationOperationId(id)).some(id => {
      const scoped = db.forWorkspace(id);
      return hasInFlightAssetDraftWork(scoped) || scoped.orchAssetGenerationJobs.listByStatuses(["queued", "planning", "collecting_context", "generating", "validating", "awaiting_input", "awaiting_review"]).length > 0;
    })),
    stopAssetDraftWork: async operation => {
      for (const id of workspaces.keys()) {
        if (workspaceOperationGate.getMigrationOperationId(id)) continue;
        const scoped = await withDatabase(operation.requestId, () => db.forWorkspace(id));
        await stopAssetDraftJobsForUpdate(scoped, {
        requestId: operation.requestId, withLegacyDatabase: withDatabase, interruptTurn: turn => interruptForDesktopUpdate(turn, operation), disposeThread: threadId => sessions.disposeThread(threadId),
        });
      }
    },
    interruptTurn: interruptForDesktopUpdate,
  }) : undefined;
  {
    databaseWriter = new ClientDbWriterService({ dbPath, db, clientId: config.clientId, reader: openedClientDbReader, workspaceOperationGate,
      onFatalError(error) {
        markCurrentClientDaemonStartup("degraded");
        logger.error("event-writer", "event persistence module failed", { code: "CLIENT_DB_WRITER_FAILED", requestId: desktopRequestId,
          rootCause: describeWorkspaceApiFailure(error).rootCause });
      },
    });
    await databaseWriter.ready();
    if (!localEventPersistence) throw new Error("DESKTOP_EVENT_RUNTIME_NOT_READY");
    const persistence = localEventPersistence;
    const batchPublicationScopes = new Map<string, Set<ThreadId>>();
    eventPipeline = createLocalEventPipeline({ writer: databaseWriter,
      apply() { throw new Error("LOCAL_EVENT_BATCH_EFFECT_OWNER_REQUIRED"); },
      async applyBatch(receipt, workspaceId) {
        if (desktopLifecycle && !receipt.localThreadIds) throw new Error("LOCAL_EVENT_PUBLICATION_SCOPE_REQUIRED");
        const localThreads = new Set(receipt.localThreadIds ?? []);
        const hasEffects = receipt.indexedCount < receipt.messages.length && receipt.messages.some(hasLocalEventOwnerEffects);
        // 文件/进程副作用开始前取得排他锁，独立诊断读者只延迟准入，不触发业务重放。
        if (hasEffects) await databaseWriter!.withExclusiveWorkspaceDatabase(`event-effects:${receipt.batchId}`, workspaceId, () => {
          const scoped = db.forWorkspace(workspaceId);
          persistence.applyBatchEffects(workspaceId, receipt.batchId, message => {
            if (message.t === "conversation.event" && hasLocalEventOwnerEffects(message)) {
              applyConversationEventAck(message.event, true, true);
              if (message.event.type === "turn.started") resolveActiveStepKey({ db: scoped, workspaces, runtime }, message.event.threadId, message.event.payload.turnId);
            }
          }, true);
        }, receipt.batchId);
        batchPublicationScopes.set(receipt.batchId, localThreads);
      },
      publish() { throw new Error("LOCAL_EVENT_BATCH_PUBLISH_OWNER_REQUIRED"); },
      async publishBatch(messages, _workspaceId, batchId) {
        const localThreads = batchPublicationScopes.get(batchId);
        if (!localThreads) throw new Error("LOCAL_EVENT_PUBLICATION_SCOPE_REQUIRED");
        batchPublicationScopes.delete(batchId);
        for (const message of messages) {
          if (message.t === "raw.event") { rollbackEvidenceFence.acceptAck(message.event); continue; }
          if (desktopLifecycle && localThreads.has(message.event.threadId)) desktopLifecycle.publishEvent(message);
        }
        flushLocalEventRelay();
      },
      onFailure(error, batch) {
        batchPublicationScopes.delete(batch.batchId);
        markCurrentClientDaemonStartup("degraded");
        db.writeWorkspaceLog(batch.workspaceId, { level: "error", tag: "event-writer", message: "event batch failed; workspace persistence unavailable", data: {
          code: "LOCAL_EVENT_BATCH_FAILED", requestId: batch.batchId, workspaceId: batch.workspaceId,
          threadId: batch.events[0]?.event.threadId, turnId: batch.turnId, rootCause: describeWorkspaceApiFailure(error).rootCause,
          phase: (error as { phase?: unknown })?.phase, sqliteCode: (error as { sqliteCode?: unknown; errcode?: unknown })?.sqliteCode
            ?? (error as { errcode?: unknown })?.errcode,
        } });
      },
    });
  }
  /** 每W独立恢复原批次和索引；坏回执/坏库冻结所属W，其他W继续。 */
  const recoverLocalEvents = async (): Promise<void> => {
    if (!localEventPersistence || !eventPipeline) throw new Error("LOCAL_EVENT_RUNTIME_NOT_READY");
    const persistence = localEventPersistence, pipeline = eventPipeline;
    const recovery = (async () => {
      for (const workspaceId of workspaces.keys()) {
        if (workspaceOperationGate.getMigrationOperationId(workspaceId)) continue;
        let recoveryRequestId = `event-recovery:${workspaceId}`;
        try {
          for (;;) {
            const pending = await withDatabase(recoveryRequestId, () => persistence.readPendingBatch(workspaceId));
            if (!pending) break;
            recoveryRequestId = pending.batchId;
            await pipeline.recover(pending);
          }
          const scoped = await withDatabase("startup-turns:scope", () => db.forWorkspace(workspaceId));
          const reconciled = await finalizeDanglingTurnsOnStartup({ db: scoped,
            withDatabase: operation => withDatabase("startup-turns:finalize", operation) });
          for (const event of reconciled.events) {
            const turnId = String((event.payload as { turnId?: string }).turnId ?? "") as TurnId;
            clearActiveThreadTurnIfMatches(runtime.activeTurnByThreadId, event.threadId, turnId);
            runtime.pendingCodexProviderTurnByClientTurnId.delete(turnId);
            cleanupPendingTools(runtime, { threadId: event.threadId, turnId });
            if (desktopLifecycle) {
              const local = await withDatabase("startup-turns:publication", () => isDesktopLocalThreadAssetExecution(config.clientId, workspaces, scoped, event.threadId));
              if (local) desktopLifecycle.publishEvent({ t: "conversation.event", event });
            }
          }
          await withDatabase("startup-assets:reconcile", () => reconcileAssetDraftJobsOnStartup(scoped));
          await resumeThreadDeletions({ ...apiHandlerContext, db: scoped });
        } catch (error) {
          pipeline.failWorkspace(workspaceId, error);
          markCurrentClientDaemonStartup("degraded");
          logger.error("event-writer", "workspace event recovery failed", { code: "LOCAL_EVENT_RECOVERY_FAILED", requestId: recoveryRequestId,
            workspaceId, rootCause: describeWorkspaceApiFailure(error).rootCause, error: toErrorLogValue(error) });
        }
      }
    })();
    runtime.trackWork(() => recovery, () => markCurrentClientDaemonStartup("degraded"), "local-event-startup-recovery");
    await recovery;
  };
  if (desktopLifecycle) await desktopLifecycle.ready((reason, error) => {
    if (error && reason !== "desktop_startup_recovery_failed") logClientStep("error", "desktop.ready", "fail", "desktop runtime readiness failed", {
      errorCode: "DESKTOP_READY_FAILED", requestId: desktopRequestId, reason, error: toErrorLogValue(error),
    });
    return shutdown(reason, error ? 1 : 0);
  }, () => withDatabase("desktop-health", () => readDesktopClientHealth(db.db, selfVersion)), async (request, requestId) => {
    // 本机响应只等待业务执行；事件投递由持久事实变化自行唤醒。
    return await executeDesktopApiRequest(desktopApiHandlerContext, request, { requestId, clientVersion: selfVersion, startedAt: runtimeStartedAt });
  }, desktopUpdateControl, createDesktopStartupRecovery({
    recoverLocalEvents,
    scheduler: scheduledTaskScheduler,
    recoverQueue: () => withDatabase("queue-startup-recovery", () => queueDispatcher.recoverOnStartup((threadId, workspaceId) => isDesktopLocalThreadAssetExecution(config.clientId, workspaces, db.forWorkspace(workspaceId!), threadId))),
    recoverOrchestrations: () => recoverRunningOrchestrations("desktop"),
  }));
  else {
    await recoverLocalEvents();
    if (initialLinkRequired) initialLinkTimer = setTimeout(() => failInitialLink("transport_initial_timeout", 1), config.timeoutPolicy.startupTimeoutMs);
    markCurrentClientDaemonStartup("connecting");
    transport.start();
    logClientStep("info", "transport.start", "success", "ws transport start scheduled after local recovery", {
      target: { clientId: config.clientId }, serverWsUrl: config.serverWsUrl,
    });
  }
}

void (async () => {
  const prelude = await handleCliPrelude();
  if (!prelude.handled) {
    await waitForClientRestartParentExit();
    await main(prelude.apiKeyProvided ? { apiKeyOverride: prelude.apiKeyOverride } : undefined);
  }
})().catch((err) => {
  try {
    markCurrentClientDaemonStartup("failed");
    markCurrentClientDaemonInitialConnection("failed");
  } catch {
    // 状态文件可能已由 supervisor 清理；原始启动错误仍继续向上报告。
  }
  logClientStep("error", "startup.fatal", "fail", "client fatal error", {
    errorCode: "CLIENT_STARTUP_FATAL", requestId: process.env.CODEFLOWAI_DESKTOP_REQUEST_ID ?? `client-startup-${process.pid}`,
    error: toErrorLogValue(err),
  });
  logger.error("client", "fatal error", String(err));
  printFatalStartupHint(err);
  // eslint-disable-next-line no-console
  console.error(redactClientStartupText(err instanceof Error ? err.stack || err.message : String(err)));
  void exitAfterLogFlush(1);
});

/** 控制连接提示打印频率，避免重连期间刷屏。 */
function printConnectionHintOnce(
  hint: string,
  state: {
    force: boolean;
    keyRef: () => string;
    setKey: (value: string) => void;
    timeRef: () => number;
    setTime: (value: number) => void;
  },
): void {
  const now = Date.now();
  const normalized = hint.trim();
  const shouldSkip = !state.force
    && state.keyRef() === normalized
    && now - state.timeRef() < 15_000;
  if (shouldSkip) return;
  state.setKey(normalized);
  state.setTime(now);
  // eslint-disable-next-line no-console
  console.error(normalized);
}

/** 启动阶段配置错误时，补充更直接的控制台说明。 */
function printFatalStartupHint(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.trim();
  if (!text) return;
  if (text.includes("未配置 API Key")) {
    // eslint-disable-next-line no-console
    console.error("[codeflowai] 启动失败：未配置 API Key。请使用 --key <value> 或在 env/.env 中设置 CODEFLOWAI_API_KEY 后重试。");
    return;
  }
  if (text.includes("Invalid JSON in workspaces config")) {
    // eslint-disable-next-line no-console
    console.error("[codeflowai] 启动失败：工作区配置 JSON 不合法，请检查 CODEFLOWAI_WORKSPACES_JSON 或 workspaces.json。");
  }
}

/** 安全解析 server 消息；失败时记录摘要并返回 null。 */
function safeParse(raw: unknown): ServerToClientMessage | null {
  try {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ServerToClientMessage;
    const text = typeof raw === "string" ? raw : String(raw ?? "");
    return JSON.parse(text) as ServerToClientMessage;
  } catch (error) {
    logClientStep("warn", "transport.message_parse", "fail", "server message parse failed", {
      rawType: typeof raw,
      rawLength: typeof raw === "string" ? raw.length : null,
      error: toErrorLogValue(error),
    });
    return null;
  }
}

type EventIndexRuntime = {
  trackWork(run: () => Promise<void>, onFailure: (error: unknown) => void, label?: string): void;
  waitForIdle(): Promise<void>;
  activeTurnByThreadId: Map<ThreadId, {
    turnId: TurnId;
    engine: EngineType;
    startedAt: number;
    execution: TurnExecutionOptionsSnapshot | null;
  }>;
  pendingCodexProviderTurnByClientTurnId: Map<TurnId, CodexProviderTurnMappingCandidate>;
  pendingToolPathsByItemId: Map<string, { threadId: ThreadId; turnId: TurnId; engine: EngineType; paths: string[] }>;
  /** turn 级 stepKey 缓存：同一 turn 内多次文件变更只读一次 STATE YAML。 */
  stepKeyByTurnId: Map<TurnId, string | null>;
};

/** 索引原运行态持有异步尾链；成功释放，失败由关闭入口消费。 */
function createEventIndexRuntime(): EventIndexRuntime {
  const work = new Set<Promise<PromiseSettledResult<void>>>();
  return {
    /** 异步回调不逃向全局；业务与诊断双错保原值及顺序。 */
    trackWork(run, onFailure, label = "event-index") {
      const pending = Promise.resolve().then(run).then((): PromiseFulfilledResult<void> => {
        work.delete(pending);
        return { status: "fulfilled", value: undefined };
      }, (error): PromiseRejectedResult => {
        try {
          const described = describeWorkspaceApiFailure(error);
          logClientStep("error", "event_index.background", "fail", "event index background task failed", {
            errorCode: "EVENT_INDEX_BACKGROUND_FAILED",
            task: label,
            errorMessage: described.message,
            rootCause: describeClientErrorTree(error),
          });
        } catch (diagnosticError) {
          return { status: "rejected", reason: new AggregateError([error, diagnosticError], "EVENT_INDEX_BACKGROUND_DIAGNOSTIC_FAILED", { cause: error }) };
        }
        try { onFailure(error); }
        catch (diagnosticError) { return { status: "rejected", reason: new AggregateError([error, diagnosticError], "EVENT_INDEX_BACKGROUND_DIAGNOSTIC_FAILED", { cause: error }) }; }
        return { status: "rejected", reason: error };
      });
      work.add(pending);
    },
    /** 等待实际登记的尾链及其后续任务，不把已持久化终态当成功证明。 */
    async waitForIdle() {
      const failures: unknown[] = [];
      while (work.size) {
        const pending = [...work];
        const results = await Promise.all(pending);
        for (let index = 0; index < pending.length; index++) {
          work.delete(pending[index]);
          const result = results[index];
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "EVENT_INDEX_BACKGROUND_FAILED", { cause: failures[0] });
    },
    activeTurnByThreadId: new Map(),
    pendingCodexProviderTurnByClientTurnId: new Map(),
    pendingToolPathsByItemId: new Map(),
    stepKeyByTurnId: new Map(),
  };
}

/** 保留原显式只读容错选项；安装和诊断双错失败，成功日志不重入安装错误分支。 */
async function installBuiltinSkillPackagesForWorkspace(input: { db: ClientDb; workspaceId: WorkspaceId; workspacePath: string; allowWorkspaceWriteFailure: boolean }): Promise<void> {
  const { db, workspaceId, workspacePath } = input;
  let result: Awaited<ReturnType<typeof ensureBuiltinSkillPackagesInstalled>>;
  try { result = await ensureBuiltinSkillPackagesInstalled({ workspacePath, skills: db.forWorkspace(workspaceId).orchSkills.listByWorkspace(workspaceId) }); }
  catch (error) {
    let permissionDenied = false;
    try {
      permissionDenied = isWorkspaceWritePermissionError(error);
      db.writeWorkspaceLog(workspaceId, { level: "error", tag: "orchestration", message: "builtin skill package install failed", data: {
        code: permissionDenied ? "WORKSPACE_WRITE_PERMISSION_DENIED" : "BUILTIN_SKILL_PACKAGE_INSTALL_FAILED", requestId: `builtin:${workspaceId}`, workspaceId,
        rootCause: describeWorkspaceApiFailure(error).rootCause,
        ...(permissionDenied && input.allowWorkspaceWriteFailure ? { impact: "builtin Skill installation unavailable for this workspace", compensation: "grant write permission and explicitly retry builtin synchronization" } : {}),
      } });
    } catch (diagnosticError) { throw new AggregateError([error, diagnosticError], "BUILTIN_SKILL_PACKAGE_INSTALL_LOG_FAILED", { cause: error }); }
    if (permissionDenied && input.allowWorkspaceWriteFailure) return;
    throw Object.assign(new Error("工作区内置 Skill 自动安装失败", { cause: error }), { code: "BUILTIN_SKILL_PACKAGE_INSTALL_FAILED" });
  }
  if (result.installed.length || result.skipped.length) db.writeWorkspaceLog(workspaceId, { level: "info", tag: "orchestration", message: "builtin skill packages ensured", data: {
    code: "BUILTIN_SKILL_PACKAGES_ENSURED", requestId: `builtin:${workspaceId}`, workspaceId, installed: result.installed, skipped: result.skipped,
  } });
}

/** 全局保留清理仍逐W短提交；错误只写领取来源，首错停止后续W。 */
function deleteWorkspaceRawEventsBeforeSeq(input: { db: ClientDb; workspaces: Map<WorkspaceId, string>; gate: WorkspaceOperationGate }, cutoff: number, limit: number): number {
  let deleted = 0;
  for (const workspaceId of input.workspaces.keys()) {
    if (input.gate.getMigrationOperationId(workspaceId)) continue;
    try { deleted += input.db.forWorkspace(workspaceId).rawEvents.deleteBeforeSeq(cutoff, limit - deleted); }
    catch (error) {
      try {
        input.db.writeWorkspaceLog(workspaceId, { level: "error", tag: "raw-events", message: "workspace raw retention failed", data: {
          code: "WORKSPACE_RAW_RETENTION_FAILED", requestId: `raw-retention:${workspaceId}:${cutoff}`, workspaceId, cutoff, limit, deletedRows: deleted,
          rootCause: describeWorkspaceApiFailure(error).rootCause,
        } });
      } catch (diagnosticError) { throw new AggregateError([error, diagnosticError], "WORKSPACE_RAW_RETENTION_LOG_FAILED", { cause: error }); }
      throw error;
    }
    if (deleted >= limit) break;
  }
  return deleted;
}

/** 从 canonical turn.started 事件恢复 active turn 的模型参数快照。 */
function readPersistedTurnExecutionOptions(
  db: ClientDb,
  threadId: ThreadId,
  turnId: TurnId,
): TurnExecutionOptionsSnapshot | null {
  const events = db.conversationEvents.listByThreadType(threadId, "turn.started", { limit: 10 });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "turn.started") continue;
    if (String(event.payload.turnId) !== String(turnId)) continue;
    return readTurnExecutionOptionsSnapshot(event.payload.execution);
  }
  return null;
}

const STEP_KEY_ORDER: AidtStepKeyV1[] = ["PRD", "UI", "ARC", "DGN", "PLAN", "DEV", "E2E", "GIT"];

/**
 * 从 STATE YAML 解析当前 "doing" 阶段的 step_key。
 * - 同一 turn 内结果会被缓存（避免多次文件变更重复读 YAML）
 * - 没有绑定或阶段时返回 null；读取失败向原快照 owner 抛出。
 */
function resolveActiveStepKey(ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string>; runtime: EventIndexRuntime }, threadId: ThreadId, turnId: TurnId): string | null {
  if (ctx.runtime.stepKeyByTurnId.has(turnId)) {
    return ctx.runtime.stepKeyByTurnId.get(turnId) ?? null;
  }
  try {
    const binding = ctx.db.threadStateBindings.getByThreadId(threadId);
    if (!binding) {
      ctx.runtime.stepKeyByTurnId.set(turnId, null);
      return null;
    }
    const workspacePath = ctx.workspaces.get(binding.workspaceId) ?? null;
    if (!workspacePath) {
      ctx.runtime.stepKeyByTurnId.set(turnId, null);
      return null;
    }
    const stateAbsPath = path.resolve(workspacePath, binding.stateRelPath.split("/").join(path.sep));
    if (!fs.existsSync(stateAbsPath)) {
      ctx.runtime.stepKeyByTurnId.set(turnId, null);
      return null;
    }
    const text = fs.readFileSync(stateAbsPath, "utf8");
    const doc = parseYaml(text) as unknown;
    if (!doc || typeof doc !== "object") {
      ctx.runtime.stepKeyByTurnId.set(turnId, null);
      return null;
    }
    const steps = (doc as any).steps;
    if (!steps || typeof steps !== "object") {
      ctx.runtime.stepKeyByTurnId.set(turnId, null);
      return null;
    }
    let activeKey: string | null = null;
    for (const k of STEP_KEY_ORDER) {
      const st = String(steps[k]?.status ?? "").trim().toLowerCase();
      if (st === "doing") {
        activeKey = k;
        break;
      }
    }
    ctx.runtime.stepKeyByTurnId.set(turnId, activeKey);
    return activeKey;
  } catch (error) {
    throw error;
  }
}

/**
 * emit 时同步拍摄 before 快照，消除 server ack 往返竞态。
 *
 * 处理三种事件：
 * - `turn.started` → 提前写入 `runtime.activeTurnByThreadId`
 * - `item.tool.started` → 拍 before 快照，写 pending
 * - `item.subagent.childEvent` (innerType=item.tool.started) → 同上
 *
 * 文件读取保护哨兵由原快照入口保存；存储或诊断失败中止本次 emit。
 */
function captureBeforeSnapshotOnEmit(ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string>; runtime: EventIndexRuntime;
  deferredSnapshots?: WeakMap<ConversationEventInput, FrozenFileBeforeSnapshot[]>;
  deferredAfterSnapshots?: WeakMap<ConversationEventInput, FrozenFileAfterSnapshot[]> }, event: ConversationEventInput): void {
  if (ctx.deferredSnapshots && event.type !== "turn.started") {
    const payload = event.type === "item.subagent.childEvent" ? event.payload.innerPayload : event.payload;
    const type = event.type === "item.subagent.childEvent" ? event.payload.innerEventType : event.type;
    if (type === "item.tool.completed") {
      if (!ctx.deferredAfterSnapshots) throw new Error("LOCAL_EVENT_AFTER_SNAPSHOT_OWNER_REQUIRED");
      const data = payload as { toolName?: string; itemId?: string; output?: unknown; changes?: Parameters<typeof normalizeChanges>[0]; status?: string };
      const itemId = `${event.type === "item.subagent.childEvent" ? "sub_" : ""}${String(data?.itemId ?? "").trim()}`;
      const pending = ctx.runtime.pendingToolPathsByItemId.get(itemId);
      if (pending && (pending.threadId !== event.threadId || pending.engine !== event.engine)) throw new Error("LOCAL_EVENT_TOOL_SCOPE_INVALID");
      const workspacePath = ctx.workspaces.get(event.workspaceId);
      if (!workspacePath) throw new Error("LOCAL_EVENT_TOOL_WORKSPACE_MISSING");
      const changes = Array.isArray(data?.changes) ? data.changes : [];
      const toolName = String(data?.toolName ?? "");
      if (!pending && !toolName.trim()) throw new Error("LOCAL_EVENT_TOOL_IDENTITY_REQUIRED");
      const changedPaths = normalizeChanges(changes, workspacePath).map(change => change.path);
      const mutation = isFileChangeLikeTool(event.engine, normalizeToolNameKey(toolName));
      const paths = Array.from(new Set(changedPaths.length && mutation ? changedPaths
        : pending?.paths ?? extractToolPaths({ engine: event.engine, toolName, input: data?.output, workspacePath, mode: "mutation" }))).filter(Boolean);
      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId);
      const turnId = pending?.turnId ?? active?.turnId;
      if (paths.length && (!turnId || !data?.itemId)) throw new Error("LOCAL_EVENT_TOOL_TURN_REQUIRED");
      ctx.deferredAfterSnapshots.set(event, paths.map(path => freezeFileAfterSnapshot({ workspacePath, workspaceId: event.workspaceId,
        threadId: event.threadId, turnId: turnId!, path, capturedAt: event.ts, itemId,
        stepKey: ctx.runtime.stepKeyByTurnId.get(turnId!) ?? null, changeKind: pickKindForPath(changes, path),
        diffText: pickDiffForPath(changes, path), toolStatus: data.status })));
      ctx.runtime.pendingToolPathsByItemId.delete(itemId);
      return;
    }
    if (type !== "item.tool.started" && type !== "item.tool.inputUpdated") return;
    const active = ctx.runtime.activeTurnByThreadId.get(event.threadId);
    const workspacePath = ctx.workspaces.get(event.workspaceId);
    if (!active || !workspacePath || !payload) return;
    const data = payload as { toolName?: string; input?: unknown; itemId?: string };
    const paths = extractToolPaths({ engine: event.engine, toolName: String(data.toolName ?? ""), input: data.input, workspacePath, mode: "mutation" });
    const itemId = (event.type === "item.subagent.childEvent" ? "sub_" : "") + String(data.itemId ?? "");
    ctx.runtime.pendingToolPathsByItemId.set(itemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
    ctx.deferredSnapshots.set(event, paths.map(path => freezeFileBeforeSnapshot({ workspacePath, workspaceId: event.workspaceId,
      threadId: event.threadId, turnId: active.turnId, path, capturedAt: event.ts, stepKey: ctx.runtime.stepKeyByTurnId.get(active.turnId) ?? null })));
    return;
  }
  if (event.type !== "turn.started") ctx = { ...ctx, db: ctx.db.forWorkspace(event.workspaceId) };
  try {
    if (event.type === "turn.started") {
      const turnId = String((event.payload as any)?.turnId ?? "").trim() as TurnId;
      if (turnId) {
        ctx.runtime.activeTurnByThreadId.set(event.threadId, {
          turnId,
          engine: event.engine,
          startedAt: Number(event.ts ?? Date.now()),
          execution: readTurnExecutionOptionsSnapshot(event.payload.execution),
        });
      }
      return;
    }

    if (event.type === "item.tool.started") {
      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
      if (!active) return;
      const toolName = String((event.payload as any)?.toolName ?? "").trim();
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      if (!toolName || !itemId) return;

      const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
      const paths = extractToolPaths({ engine: event.engine, toolName, input: (event.payload as any)?.input, workspacePath, mode: "mutation" });
      if (!paths.length || !workspacePath) return;

      ctx.runtime.pendingToolPathsByItemId.set(itemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
      captureBeforeForPaths(ctx, {
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: active.turnId,
        paths,
        capturedAt: Number(event.ts ?? Date.now()),
      });
      return;
    }

    if (event.type === "item.tool.inputUpdated") {
      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
      if (!active) return;
      const toolName = String((event.payload as any)?.toolName ?? "").trim();
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      if (!toolName || !itemId) return;

      const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
      const paths = extractToolPaths({ engine: event.engine, toolName, input: (event.payload as any)?.input, workspacePath, mode: "mutation" });
      if (!paths.length || !workspacePath) return;

      ctx.runtime.pendingToolPathsByItemId.set(itemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
      captureBeforeForPaths(ctx, {
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: active.turnId,
        paths,
        capturedAt: Number(event.ts ?? Date.now()),
      });
      return;
    }

    if (event.type === "item.subagent.childEvent") {
      const innerType = String((event.payload as any)?.innerEventType ?? "");
      const inner = (event.payload as any)?.innerPayload;
      if (innerType !== "item.tool.started" && innerType !== "item.tool.inputUpdated") return;
      if (!inner) return;

      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
      if (!active) return;
      const toolName = String(inner.toolName ?? "").trim();
      const innerItemId = `sub_${String(inner.itemId ?? "").trim()}`;
      if (!toolName || innerItemId === "sub_") return;

      const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
      const paths = extractToolPaths({ engine: event.engine, toolName, input: inner.input, workspacePath, mode: "mutation" });
      if (!paths.length || !workspacePath) return;

      ctx.runtime.pendingToolPathsByItemId.set(innerItemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
      captureBeforeForPaths(ctx, {
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: active.turnId,
        paths,
        capturedAt: Number(event.ts ?? Date.now()),
      });
      return;
    }
  } catch (e) {
    try {
      ctx.db.writeWorkspaceLog(event.workspaceId, { level: "error", tag: "conversation-events", message: "before snapshot failed", data: {
        code: "CONVERSATION_BEFORE_SNAPSHOT_FAILED", requestId: `before-snapshot:${event.threadId}:${event.type}`,
        workspaceId: event.workspaceId, threadId: event.threadId, type: event.type, rootCause: describeWorkspaceApiFailure(e).rootCause,
      } });
    } catch (diagnosticError) { throw new AggregateError([e, diagnosticError], "会话快照及诊断失败", { cause: e }); }
    throw e;
  }
}

/** 首次为每个路径拍摄 before；单个文件读取失败留下不可回滚记录并继续其他路径。 */
function captureBeforeForPaths(
  ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string>; runtime: EventIndexRuntime },
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId; paths: string[]; capturedAt: number },
): void {
  const workspacePath = ctx.workspaces.get(input.workspaceId) ?? null;
  if (!workspacePath) return;
  const stepKey = resolveActiveStepKey(ctx, input.threadId, input.turnId);
  for (const p of input.paths) {
    captureFileChangeBeforeSnapshot({ ...input, db: ctx.db, workspacePath, path: p, stepKey });
  }
}

/** 仅为尚无 before 记录的路径补拍，已有有效或失败哨兵均保持不变。 */
function captureMissingBeforeForPaths(
  ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string>; runtime: EventIndexRuntime },
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId; paths: string[]; capturedAt: number },
): void {
  captureBeforeForPaths(ctx, input);
}

/** 复用 canonical 的绑定与业务索引；已本地提交时跳过 ACK 缓冲写入。 */
function persistConversationEventAck(
  ctx: {
    db: ClientDb;
    workspaces: Map<WorkspaceId, string>;
    threads: ThreadStore;
    runtime: EventIndexRuntime;
    orchEngine: OrchestrationEngine;
    queueDispatcher?: ThreadQueueDispatcher;
    markReminderDirty: (workspaceId: WorkspaceId) => void;
    reminderCompletionNotifier: ReminderCompletionNotifier;
    desktopCloudAccount?: DesktopCloudAccount;
    threadTouchBuffer: { enqueue: (threadId: ThreadId, updatedAt: number, opts?: { urgent?: boolean; workspaceId?: WorkspaceId }) => void };
    conversationEventAckBuffer: { enqueue: (event: ConversationEventEnvelope) => void };
    alreadyPersisted?: boolean;
    databaseIndexed?: boolean;
  },
  event: ConversationEventEnvelope,
): void {
  ctx = { ...ctx, db: ctx.db.forWorkspace(event.workspaceId) };
  try {
    const threadStartedBinding = ctx.alreadyPersisted ? resolveThreadStartedBinding(
      ctx.db, event, ctx.threads.get(event.threadId)?.sessionId ?? null,
    ) : prepareThreadStartedBindingAck(
      ctx.db,
      event,
      (canonicalEvent) => ctx.conversationEventAckBuffer.enqueue(canonicalEvent),
      ctx.threads.get(event.threadId)?.sessionId ?? null,
    );
    if (threadStartedBinding.kind === "missing_thread") {
      if (ctx.alreadyPersisted) throw new Error(`本地事件索引缺少会话：threadId=${event.threadId}, seq=${event.seq}`);
      ctx.db.writeWorkspaceLog(event.workspaceId, { level: "warn", tag: "conversation-events", message: "thread.started references missing local thread; canonical ACK skipped", data: {
        code: "thread_started_missing_thread",
        requestId: `event:${event.seq}:thread_started`,
        reason: "missing_thread",
        disposition: "log_only",
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        engine: event.engine,
        sessionId: threadStartedBinding.sessionId,
        eventSeq: Number(event.seq ?? 0) || null,
      } });
      return;
    }
    if (threadStartedBinding.kind === "stale_binding") {
      ctx.db.writeWorkspaceLog(event.workspaceId, { level: "warn", tag: "conversation-events", message: "stale Codex thread.started binding ignored", data: {
        code: "thread_started_binding_stale",
        requestId: `event:${event.seq}:thread_started`,
        reason: threadStartedBinding.reason,
        disposition: "canonical_evidence_only",
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        engine: event.engine,
        incomingSessionId: threadStartedBinding.sessionId,
        currentSessionId: threadStartedBinding.currentSessionId,
        eventSeq: Number(event.seq ?? 0) || null,
      } });
      return;
    }
    if (!ctx.databaseIndexed) ctx.threadTouchBuffer.enqueue(event.threadId, Number(event.ts ?? Date.now()), {
      urgent: isUrgentThreadTouchEvent(event.type),
      workspaceId: event.workspaceId,
    });
    if (!ctx.databaseIndexed) persistThreadPrefsEvent(ctx, event);
    if (!ctx.databaseIndexed) applyThreadStartedBinding(ctx.db, threadStartedBinding);

    const reminderWorkspaceId = applyTurnIndexEvent(ctx, event, ctx.databaseIndexed);
    if (reminderWorkspaceId) ctx.markReminderDirty(reminderWorkspaceId);
    applyFileChangeIndexEvent(ctx, event, ctx.databaseIndexed);
    maybeKickThreadQueueAtActiveTurnBoundary(ctx, event);
  } catch (cause) {
    throw new Error(
      `Conversation event ACK 索引失败：type=${event?.type}, threadId=${event?.threadId}`,
      { cause },
    );
  }
}

/** 在 active turn 的 assistant/tool 完成边界尝试注入等待队列。 */
function maybeKickThreadQueueAtActiveTurnBoundary(
  ctx: { queueDispatcher?: ThreadQueueDispatcher },
  event: ConversationEventEnvelope,
): void {
  if (event.type !== "item.agentMessage.completed" && event.type !== "item.tool.completed") return;
  ctx.queueDispatcher?.kickAtActiveTurnBoundary(event.threadId);
}

function isUrgentThreadTouchEvent(type: string): boolean {
  switch (String(type ?? "")) {
    case "thread.started":
    case "item.userMessage.created":
    case "turn.started":
    case "turn.completed":
    case "turn.error":
    case "approval.request":
    case "approval.resolved":
    case "approval.expired":
    case "userInput.requested":
    case "userInput.resolved":
    case "userInput.expired":
      return true;
    default:
      return false;
  }
}

function persistThreadPrefsEvent(ctx: { db: ClientDb }, event: ConversationEventEnvelope): void {
  const patch = extractThreadPrefsPatchFromConversationEvent(event);
  if (!patch) return;

  const current = ctx.db.threads.get(event.threadId);
  if (!current) return;

  ctx.db.threads.updatePrefs(
    event.threadId,
    mergeThreadPrefs(
      {
        model: current.model,
        effort: current.effort,
        accessMode: current.accessMode,
        planMode: current.planMode,
        autoCompactPct: current.autoCompactPct,
        contextWindow: current.contextWindow,
        serviceTier: current.serviceTier,
        roleId: current.roleId,
      },
      patch,
    ),
  );
}

/** 复用 raw 的 provider turn 映射；已本地提交时跳过 ACK 缓冲。 */
function persistRawEventAck(
  ctx: { db: ClientDb; runtime: EventIndexRuntime; buffer: { enqueue: (event: RawEngineEventEnvelope) => void }; alreadyPersisted?: boolean },
  event: RawEngineEventEnvelope,
): void {
  ctx = { ...ctx, db: ctx.db.forWorkspace(event.workspaceId) };
  if (!ctx.alreadyPersisted) ctx.buffer.enqueue(event);
  const result = indexCodexProviderTurnStarted(ctx, event);
  if (result.kind === "mapped" && result.localTurnStatus !== "started" && result.localTurnStatus !== "pending") {
    ctx.db.writeWorkspaceLog(event.workspaceId, { level: "warn", tag: "raw-events", message: "late Codex turn/started reconciled to terminal local turn", data: {
      code: "LATE_CODEX_TURN_RECONCILED", requestId: `event:${event.seq}:turn_started`,
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      clientTurnId: result.clientTurnId,
      providerTurnId: result.providerTurnId,
      localTurnStatus: result.localTurnStatus,
      eventSeq: event.seq,
    } });
  }
}

/** 更新 turn 相关索引，并返回提醒结果发生变化的 workspace。 */
function applyTurnIndexEvent(
  ctx: {
    db: ClientDb;
    runtime: EventIndexRuntime;
    workspaces: Map<WorkspaceId, string>;
    orchEngine: OrchestrationEngine;
    reminderCompletionNotifier: ReminderCompletionNotifier;
    desktopCloudAccount?: DesktopCloudAccount;
  },
  event: ConversationEventEnvelope,
  databaseIndexed = false,
): WorkspaceId | null {
  if (event.type === "turn.started") {
    const turnId = String(event.payload.turnId ?? "").trim() as TurnId;
    if (!turnId) return null;
    const startedAt = Number(event.ts ?? Date.now());
    if (!databaseIndexed) ctx.db.turns.insertStarted({
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      engine: event.engine,
      turnId,
      startedAt,
      startEventSeq: Number(event.seq ?? 0) || null,
    });
    if (!databaseIndexed) applyPendingCodexProviderTurnMapping(ctx, event, turnId);
    const indexedTurn = ctx.db.turns.get(turnId);
    const reminderChanged = indexedTurn?.status === "started"
      ? databaseIndexed || applyThreadReminderStateEvent(ctx.db, event)
      : false;
    const currentRuntimeTurn = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
    if (
      indexedTurn?.status === "started"
      && (!currentRuntimeTurn || currentRuntimeTurn.turnId === turnId || startedAt >= currentRuntimeTurn.startedAt)
    ) {
      ctx.runtime.activeTurnByThreadId.set(event.threadId, {
        turnId,
        engine: event.engine,
        startedAt,
        execution: readTurnExecutionOptionsSnapshot(event.payload.execution),
      });
    }
    return reminderChanged ? event.workspaceId : null;
  }

  if (event.type === "turn.engineBound") {
    if (event.engine !== "codex") throw new Error(`turn.engineBound 只能归属 Codex turn：threadId=${event.threadId}`);
    const turnId = String(event.payload.turnId ?? "").trim() as TurnId;
    const engineTurnId = String(event.payload.engineTurnId ?? "").trim();
    const engineSessionId = String(event.payload.engineSessionId ?? "").trim() as SessionId;
    if (!turnId || !engineTurnId || !engineSessionId) {
      throw new Error(`Codex turn.engineBound 参数不完整：threadId=${event.threadId}`);
    }
    const turn = ctx.db.turns.get(turnId);
    if (
      turn
      && (
        turn.workspaceId !== event.workspaceId
        || turn.threadId !== event.threadId
        || turn.engine !== "codex"
      )
    ) {
      throw new Error(`Codex turn.engineBound 无法归属到本地 turn：threadId=${event.threadId}, turnId=${turnId}`);
    }
    if (!databaseIndexed) persistOrStageCodexProviderTurn(ctx, turnId, {
      engineTurnId,
      engineSessionId,
      previousEngineTurnId: event.payload.previousEngineTurnId ?? null,
      source: "turn.engineBound",
      eventSeq: Number(event.seq ?? 0),
      observedAt: Number(event.ts ?? Date.now()),
    });
    return null;
  }

  if (event.type === "item.userMessage.created") {
    const turnId = String((event.payload as any)?.turnId ?? "").trim();
    if (!turnId) return null;
    // active turn 追加输入属于同一 turn 的后续用户消息，不覆盖 turn 首条用户索引。
    if (Boolean((event.payload as any)?.activeTurnAppend)) return null;
    if (!databaseIndexed) ctx.db.turns.setUserMessage(turnId as TurnId, { userItemId: event.payload.itemId, userText: String(event.payload.text ?? "") });
    return null;
  }

  if (event.type === "turn.completed") {
    const turnId = String(event.payload.turnId ?? "").trim() as TurnId;
    if (!turnId) throw new Error(`turn.completed 缺少本地 turnId：threadId=${event.threadId}`);
    const responseText = String((event.payload as any)?.result?.responseText ?? "").trim() || null;
    let reminderChanged = false;
    if (turnId) {
      if (!databaseIndexed) {
        ensureTerminalTurnRow(ctx, event, turnId);
        applyPendingCodexProviderTurnMapping(ctx, event, turnId);
        ctx.db.turns.setEnded(turnId, { status: "completed", endedAt: Number(event.ts ?? Date.now()), endEventSeq: Number(event.seq ?? 0) || null });
      }
      reminderChanged = databaseIndexed || applyThreadReminderStateEvent(ctx.db, event);
      if (reminderChanged) {
        notifyThreadCompletionReminder(ctx, event, turnId);
      }
      if (event.engine === "claude") {
        tryCaptureClaudeTurnCheckpoint(ctx, { threadId: event.threadId, workspaceId: event.workspaceId, turnId });
      }
    }
    if (turnId) clearActiveThreadTurnIfMatches(ctx.runtime.activeTurnByThreadId, event.threadId, turnId);
    if (turnId) ctx.runtime.pendingCodexProviderTurnByClientTurnId.delete(turnId);
    cleanupPendingTools(ctx.runtime, { threadId: event.threadId, turnId });
    ctx.runtime.trackWork(() => ctx.orchEngine.reconcileExecutionInterruptedTurnCompletion({
      threadId: event.threadId,
      turnId: turnId || null,
      responseText,
    }), (error) => {
      ctx.db.writeWorkspaceLog(event.workspaceId, { level: "error", tag: "orchestration", message: "failed to reconcile execution-interrupted completion after turn.completed", data: {
        code: "TURN_COMPLETION_RECONCILE_FAILED", errorCode: "TURN_COMPLETION_RECONCILE_FAILED", requestId: `turn:${turnId}:reconcile`, workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: turnId || null,
        rootCause: describeWorkspaceApiFailure(error).rootCause,
      } });
    }, "orch-reconcile");
    return reminderChanged ? event.workspaceId : null;
  }

  if (event.type === "turn.error") {
    const turnScope = resolveTurnErrorIndexScope((event.payload as any)?.turnId);
    if (turnScope.kind === "unscoped") {
      ctx.db.writeWorkspaceLog(event.workspaceId, { level: "warn", tag: "conversation-events", message: "turn.error has no local turnId; turn-scoped indexing skipped", data: {
        code: "turn_error_missing_turn_id",
        requestId: `event:${event.seq}:turn_error`,
        disposition: "canonical_evidence_only",
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        engine: event.engine,
        eventSeq: Number(event.seq ?? 0) || null,
        terminationKind: String((event.payload as any)?.terminationKind ?? "").trim() || null,
        errorCode: String((event.payload as any)?.code ?? "").trim() || null,
      } });
      return null;
    }
    const turnId = turnScope.turnId;
    let reminderChanged = false;
    if (!databaseIndexed) {
      ensureTerminalTurnRow(ctx, event, turnId);
      applyPendingCodexProviderTurnMapping(ctx, event, turnId);
      ctx.db.turns.setEnded(turnId, { status: "error", endedAt: Number(event.ts ?? Date.now()), endEventSeq: Number(event.seq ?? 0) || null });
    }
    reminderChanged = databaseIndexed || applyThreadReminderStateEvent(ctx.db, event);
    clearActiveThreadTurnIfMatches(ctx.runtime.activeTurnByThreadId, event.threadId, turnId);
    ctx.runtime.pendingCodexProviderTurnByClientTurnId.delete(turnId);
    cleanupPendingTools(ctx.runtime, { threadId: event.threadId, turnId });
    return reminderChanged ? event.workspaceId : null;
  }

  if (event.type === "approval.request") {
    return databaseIndexed || applyThreadReminderStateEvent(ctx.db, event) ? event.workspaceId : null;
  }

  if (event.type === "approval.resolved" || event.type === "approval.expired") {
    return databaseIndexed || applyThreadReminderStateEvent(ctx.db, event) ? event.workspaceId : null;
  }

  if (event.type === "userInput.requested") {
    return databaseIndexed || applyThreadReminderStateEvent(ctx.db, event) ? event.workspaceId : null;
  }

  if (event.type === "userInput.resolved" || event.type === "userInput.expired") {
    return databaseIndexed || applyThreadReminderStateEvent(ctx.db, event) ? event.workspaceId : null;
  }

  // Claude 自动压缩（compaction）会重写 session JSONL 文件，使之前所有 turn 存储的
  // sessionFileByteLen checkpoint 失效。在此检测 compact_boundary 事件，
  // 立即读取重写后的文件大小，并更新所有已完成 turn 的 checkpoint。
  if (event.type === "system.notice" && event.engine === "claude") {
    const action = (event.payload as any)?.action;
    if (action === "context.compacted") {
      tryUpdateClaudeTurnCheckpointsAfterCompaction(ctx, {
        threadId: event.threadId,
        workspaceId: event.workspaceId,
      });
    }
  }

  return null;
}

/** turn 行可写后应用此前暂存的 provider 映射，终态先到时也不得丢失。 */
function applyPendingCodexProviderTurnMapping(
  ctx: { db: ClientDb; runtime: EventIndexRuntime },
  event: ConversationEventEnvelope,
  turnId: TurnId,
): void {
  if (event.engine !== "codex") return;
  const pending = ctx.runtime.pendingCodexProviderTurnByClientTurnId.get(turnId) ?? null;
  if (!pending) return;
  ctx.db.turns.setCodexProviderTurnId(turnId, pending);
  ctx.runtime.pendingCodexProviderTurnByClientTurnId.delete(turnId);
}

/** 终态先到时补建 turn 行，防止迟到的 turn.started 把已结束回合复活。 */
function ensureTerminalTurnRow(
  ctx: { db: ClientDb; runtime: EventIndexRuntime },
  event: ConversationEventEnvelope,
  turnId: TurnId,
): void {
  const existing = ctx.db.turns.get(turnId);
  if (existing) {
    if (
      existing.workspaceId !== event.workspaceId
      || existing.threadId !== event.threadId
      || existing.engine !== event.engine
    ) {
      throw new Error(`turn 终态归属冲突：threadId=${event.threadId}, turnId=${turnId}`);
    }
    return;
  }
  const terminalAt = Number(event.ts ?? Date.now());
  const activeTurn = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
  const startedAt = activeTurn?.turnId === turnId ? activeTurn.startedAt : terminalAt;
  ctx.db.turns.insertStarted({
    workspaceId: event.workspaceId,
    threadId: event.threadId,
    engine: event.engine,
    turnId,
    startedAt,
    startEventSeq: null,
  });
}

type ThreadCompletionReminderRouting = {
  sharedWorkspaceId?: string | null;
  recipientUserIds?: string[] | null;
};

/** 普通会话首次派生待查收时上报 Server，由 Server 按目标用户配置发送外部通知。 */
function notifyThreadCompletionReminder(
  ctx: { db: ClientDb; reminderCompletionNotifier: ReminderCompletionNotifier; runtime: EventIndexRuntime;
    desktopCloudAccount?: { getOwner(): unknown } },
  event: ConversationEventEnvelope,
  turnId: TurnId,
): void {
  const thread = ctx.db.threads.get(event.threadId);
  const workspace = ctx.db.workspaces.get(event.workspaceId);
  if (!shouldSendThreadCompletionNotification(thread)) return;
  // 桌面未关联云端时没有 Server 通知收件人；跳过外部通知，不污染关闭排空。
  if (ctx.desktopCloudAccount && !ctx.desktopCloudAccount.getOwner()) {
    logger.info("reminder", "completion notification skipped without cloud account", {
      workspaceId: event.workspaceId, threadId: event.threadId, turnId,
    });
    return;
  }
  const title = String(thread?.title ?? "").trim() || "未命名会话";
  const routing = resolveThreadCompletionReminderRouting(ctx.db, thread, event);
  ctx.runtime.trackWork(() => ctx.reminderCompletionNotifier.notifyCompletion({
    notificationKey: `thread:${event.threadId}:receipt:${turnId}`,
    sourceType: "chat",
    workspaceId: event.workspaceId,
    workspaceTitle: workspace?.title ?? String(event.workspaceId),
    title,
    summary: "会话已完成，等待您查看结果。",
    targetId: String(event.threadId),
    completedAt: Number(event.ts ?? Date.now()),
    ...routing,
  }), (error) => {
    ctx.db.writeWorkspaceLog(event.workspaceId, { level: "error", tag: "reminder", message: "thread completion external notification failed", data: {
      code: "THREAD_COMPLETION_NOTIFICATION_FAILED", errorCode: "THREAD_COMPLETION_NOTIFICATION_FAILED", requestId: `turn:${turnId}:completion_notification`,
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      turnId,
      rootCause: describeWorkspaceApiFailure(error).rootCause,
    } });
  }, "reminder-completion");
}

/** 解析共享会话和编排节点会话的外部通知目标。 */
function resolveThreadCompletionReminderRouting(
  db: ClientDb,
  thread: ReturnType<ClientDb["threads"]["get"]>,
  event: ConversationEventEnvelope,
): ThreadCompletionReminderRouting {
  const isOrchestrationNodeThread = thread?.threadType === "orchestration" || thread?.threadSubtype === "node-discussion";
  if (isOrchestrationNodeThread) {
    const nodeRouting = resolveOrchestrationNodeThreadReminderRouting(db, event);
    if (nodeRouting) return nodeRouting;
  }
  const sharedWorkspaceId = String(thread?.sharedWorkspaceId ?? "").trim();
  const ownerUserId = String(thread?.ownerUserId ?? "").trim();
  if (sharedWorkspaceId && ownerUserId) {
    return { sharedWorkspaceId, recipientUserIds: [ownerUserId] };
  }
  if (sharedWorkspaceId) return { sharedWorkspaceId };
  return {};
}

/** 反查编排节点 thread 所属实例，节点会话完成时通知节点处理人。 */
function resolveOrchestrationNodeThreadReminderRouting(
  db: ClientDb,
  event: ConversationEventEnvelope,
): ThreadCompletionReminderRouting | null {
  for (const instance of db.orchInstances.listByWorkspace(event.workspaceId)) {
    const profileScope = instance.runtimeConfig?.executionProfileScope;
    const sharedWorkspaceId = String(instance.sharedContext?.sharedWorkspaceId ?? instance.intakeSnapshot.sharedContext?.sharedWorkspaceId ?? (profileScope?.scopeType === "shared_workspace" ? profileScope.scopeId : null) ?? "").trim();
    if (!sharedWorkspaceId) continue;
    for (const nodeState of Object.values(instance.nodeStates ?? {})) {
      if (String(nodeState?.threadId ?? "") !== String(event.threadId) && String(nodeState?.discussionThreadId ?? "") !== String(event.threadId)) continue;
      const assigneeUserIds = normalizeReminderRecipientUserIds(nodeState?.assigneeUserIds);
      if (assigneeUserIds.length) return { sharedWorkspaceId, recipientUserIds: assigneeUserIds };
      const initiatorUserIds = normalizeReminderRecipientUserIds([instance.runtimeConfig?.initiatorUserId]);
      if (initiatorUserIds.length) return { sharedWorkspaceId, recipientUserIds: initiatorUserIds };
      const ownerUserIds = normalizeReminderRecipientUserIds([instance.sharedContext?.ownerUserId ?? instance.intakeSnapshot.sharedContext?.ownerUserId]);
      return ownerUserIds.length ? { sharedWorkspaceId, recipientUserIds: ownerUserIds } : { sharedWorkspaceId };
    }
  }
  return null;
}

/** 清洗外部通知目标用户列表，保持顺序去重。 */
function normalizeReminderRecipientUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/**
 * 压缩后更新所有已完成 turn 的 checkpoint。
 *
 * Claude 自动压缩将 session 文件重写为「压缩摘要 + 保留的近期消息」，
 * 之前记录的字节偏移量全部指向旧文件，必须统一更新为压缩后的文件大小。
 *
 * 这样在回滚时，截断到该偏移量 = 保留完整的压缩摘要（去除后续 turn 的内容）。
 */
function tryUpdateClaudeTurnCheckpointsAfterCompaction(
  ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string> },
  input: { threadId: ThreadId; workspaceId: WorkspaceId },
): void {
  ctx = { ...ctx, db: ctx.db.forWorkspace(input.workspaceId) };
  let completed: { sessionId: SessionId; updated: number; byteLen: number } | null = null;
  try {
    const thread = ctx.db.threads.get(input.threadId);
    const sessionId = thread?.sessionId ?? null;
    if (!sessionId) return;
    const workspacePath = ctx.workspaces.get(input.workspaceId);
    if (!workspacePath) return;
    const sessionFile = resolveClaudeSessionFilePath({ workspacePath, sessionId: String(sessionId) });
    if (!sessionFile) return;
    const byteLen = readClaudeSessionFileByteLen(sessionFile);
    if (byteLen == null) return;

    const turns = ctx.db.turns.listByThread(input.threadId);
    let updated = 0;
    ctx.db.db.transaction(() => {
      for (const turn of turns) {
        if (turn.status !== "completed" && turn.status !== "error") continue;
        ctx.db.turns.setEngineCheckpoint(turn.turnId as TurnId, JSON.stringify({ sessionFileByteLen: byteLen }));
        updated += 1;
      }
    })();
    completed = { sessionId, updated, byteLen };
  } catch (e) {
    try { ctx.db.writeWorkspaceLog(input.workspaceId, { level: "error", tag: "claude", message: "compaction checkpoint update failed", data: {
      code: "CLAUDE_COMPACTION_CHECKPOINTS_FAILED", requestId: `compaction:${input.threadId}`, workspaceId: input.workspaceId,
      threadId: input.threadId, rootCause: describeWorkspaceApiFailure(e).rootCause,
    } }); }
    catch (diagnosticError) { throw new AggregateError([e, diagnosticError], "会话压缩检查点及诊断失败", { cause: e }); }
    throw e;
  }
  ctx.db.writeWorkspaceLog(input.workspaceId, { level: "info", tag: "claude", message: "compaction checkpoints updated", data: {
    code: "CLAUDE_COMPACTION_CHECKPOINTS_UPDATED", requestId: `compaction:${input.threadId}`, workspaceId: input.workspaceId,
    threadId: input.threadId, ...completed,
  } });
}

function tryCaptureClaudeTurnCheckpoint(
  ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string> },
  input: { threadId: ThreadId; workspaceId: WorkspaceId; turnId: TurnId },
): void {
  const thread = ctx.db.threads.get(input.threadId);
  const sessionId = thread?.sessionId ?? null;
  if (!sessionId) return;
  const workspacePath = ctx.workspaces.get(input.workspaceId);
  if (!workspacePath) return;
  const sessionFile = resolveClaudeSessionFilePath({ workspacePath, sessionId: String(sessionId) });
  if (!sessionFile) return;
  const byteLen = readClaudeSessionFileByteLen(sessionFile);
  if (byteLen == null) return;
  ctx.db.turns.setEngineCheckpoint(input.turnId, JSON.stringify({ sessionFileByteLen: byteLen }));
}

function applyFileChangeIndexEvent(ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string>; runtime: EventIndexRuntime }, event: ConversationEventEnvelope,
  databaseIndexed = false): void {
  // Writer已保存冻结文件证据；重放不能用当前磁盘覆盖历史before/after。
  if (databaseIndexed && (event.type === "item.tool.started" || event.type === "item.tool.inputUpdated" || event.type === "item.tool.completed"
    || event.type === "item.subagent.childEvent" && ["item.tool.started", "item.tool.inputUpdated", "item.tool.completed"].includes(event.payload.innerEventType))) return;
  if (event.type === "item.diff.created" && event.engine === "codex") {
    indexCodexTurnDiff(ctx, event);
    return;
  }

  if (event.type === "item.tool.started") {
    const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
    if (!active) return;
    const toolName = String((event.payload as any)?.toolName ?? "").trim();
    const itemId = String((event.payload as any)?.itemId ?? "").trim();
    if (!toolName || !itemId) return;

    const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
    const paths = extractToolPaths({ engine: event.engine, toolName, input: (event.payload as any)?.input, workspacePath, mode: "mutation" });
    if (!paths.length || !workspacePath) return;

    ctx.runtime.pendingToolPathsByItemId.set(itemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
    captureMissingBeforeForPaths(ctx, {
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      turnId: active.turnId,
      paths,
      capturedAt: Number(event.ts ?? Date.now()),
    });
    return;
  }

  if (event.type === "item.tool.inputUpdated") {
    const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
    if (!active) return;
    const toolName = String((event.payload as any)?.toolName ?? "").trim();
    const itemId = String((event.payload as any)?.itemId ?? "").trim();
    if (!toolName || !itemId) return;

    const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
    const paths = extractToolPaths({ engine: event.engine, toolName, input: (event.payload as any)?.input, workspacePath, mode: "mutation" });
    if (!paths.length || !workspacePath) return;

    ctx.runtime.pendingToolPathsByItemId.set(itemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
    captureMissingBeforeForPaths(ctx, {
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      turnId: active.turnId,
      paths,
      capturedAt: Number(event.ts ?? Date.now()),
    });
    return;
  }

  if (event.type === "item.tool.completed") {
    const itemId = String((event.payload as any)?.itemId ?? "").trim();
    if (!itemId) return;
    const pending = ctx.runtime.pendingToolPathsByItemId.get(itemId) ?? null;
    const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
    if (!workspacePath) {
      ctx.runtime.pendingToolPathsByItemId.delete(itemId);
      return;
    }

    const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
    const turnId = active?.turnId ?? pending?.turnId ?? null;
    if (!turnId) {
      ctx.runtime.pendingToolPathsByItemId.delete(itemId);
      return;
    }

    const completedToolName = String((event.payload as any)?.toolName ?? "").trim();
    const completedInput = (event.payload as any)?.output ?? null;
    const changes = Array.isArray((event.payload as any)?.changes) ? ((event.payload as any).changes as any[]) : [];

    const pathsFromChanges = normalizeChanges(changes, workspacePath).map((change) => change.path);
    // pathsFromChanges 来自 presentation(mode:display)，可能包含非写入工具（如 Read / Grep）的路径。
    // 仅对写入工具使用 pathsFromChanges，否则回退到 mode:mutation 过滤，避免只读工具的路径泄漏到变更列表。
    const isMutation = isFileChangeLikeTool(event.engine, normalizeToolNameKey(completedToolName));
    const paths = (pathsFromChanges.length && isMutation)
      ? pathsFromChanges
      : pending?.paths ?? extractToolPaths({ engine: event.engine, toolName: completedToolName, input: completedInput, workspacePath, mode: "mutation" });
    const uniq = Array.from(new Set(paths)).filter(Boolean);
    if (!uniq.length) {
      ctx.runtime.pendingToolPathsByItemId.delete(itemId);
      return;
    }

    const stepKey = resolveActiveStepKey(ctx, event.threadId, turnId);
    for (const p of uniq) {
      captureFileChangeAfterSnapshot({
        db: ctx.db, workspacePath, workspaceId: event.workspaceId,
        threadId: event.threadId, turnId, path: p, stepKey,
        capturedAt: Number(event.ts ?? Date.now()), eventSeq: event.seq, itemId,
        changeKind: pickKindForPath(changes, p), diffText: pickDiffForPath(changes, p),
        toolStatus: String(event.payload.status ?? ""),
      });
    }
    ctx.runtime.pendingToolPathsByItemId.delete(itemId);
  }

  // subagent 内部工具的文件变更：从 childEvent 中提取 innerPayload，复用 started/completed 逻辑。
  if (event.type === "item.subagent.childEvent") {
    const innerType = String((event.payload as any)?.innerEventType ?? "");
    const inner = (event.payload as any)?.innerPayload;
    if (!inner) return;
    // 使用 "sub_" 前缀避免与顶层工具的 itemId 冲突
    const innerItemId = `sub_${String(inner.itemId ?? "").trim()}`;
    if (!innerItemId || innerItemId === "sub_") return;

    if (innerType === "item.tool.started" || innerType === "item.tool.inputUpdated") {
      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
      if (!active) return;
      const toolName = String(inner.toolName ?? "").trim();
      if (!toolName) return;
      const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
      const paths = extractToolPaths({ engine: event.engine, toolName, input: inner.input, workspacePath, mode: "mutation" });
      if (!paths.length || !workspacePath) return;

      ctx.runtime.pendingToolPathsByItemId.set(innerItemId, { threadId: event.threadId, turnId: active.turnId, engine: event.engine, paths });
      captureMissingBeforeForPaths(ctx, {
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        turnId: active.turnId,
        paths,
        capturedAt: Number(event.ts ?? Date.now()),
      });
      return;
    }

    if (innerType === "item.tool.completed") {
      const pending = ctx.runtime.pendingToolPathsByItemId.get(innerItemId) ?? null;
      const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
      if (!workspacePath) { ctx.runtime.pendingToolPathsByItemId.delete(innerItemId); return; }
      const active = ctx.runtime.activeTurnByThreadId.get(event.threadId) ?? null;
      const turnId = active?.turnId ?? pending?.turnId ?? null;
      if (!turnId) { ctx.runtime.pendingToolPathsByItemId.delete(innerItemId); return; }

      const completedToolName = String(inner.toolName ?? "").trim();
      const changes = Array.isArray(inner.changes) ? (inner.changes as any[]) : [];
      const pathsFromChanges = normalizeChanges(changes, workspacePath).map((change) => change.path);
      const isMutation = isFileChangeLikeTool(event.engine, normalizeToolNameKey(completedToolName));
      const paths = (pathsFromChanges.length && isMutation)
        ? pathsFromChanges
        : pending?.paths ?? extractToolPaths({ engine: event.engine, toolName: completedToolName, input: inner.output, workspacePath, mode: "mutation" });
      const uniq = Array.from(new Set(paths)).filter(Boolean);
      if (!uniq.length) { ctx.runtime.pendingToolPathsByItemId.delete(innerItemId); return; }

      const stepKey = resolveActiveStepKey(ctx, event.threadId, turnId);
      for (const p of uniq) {
        captureFileChangeAfterSnapshot({
          db: ctx.db, workspacePath, workspaceId: event.workspaceId,
          threadId: event.threadId, turnId, path: p, stepKey,
          capturedAt: Number(event.ts ?? Date.now()), eventSeq: event.seq, itemId: innerItemId,
          changeKind: pickKindForPath(changes, p), diffText: pickDiffForPath(changes, p),
          toolStatus: String(inner.status ?? ""),
        });
      }
      ctx.runtime.pendingToolPathsByItemId.delete(innerItemId);
    }
  }
}

/** 索引最新 aggregate diff；同hash复用已验证路径，正文仍以canonical为准。 */
function indexCodexTurnDiff(
  ctx: { db: ClientDb; workspaces: Map<WorkspaceId, string> },
  event: Extract<ConversationEventEnvelope, { type: "item.diff.created" }>,
): void {
  const turnId = String((event.payload as any)?.turnId ?? "").trim() as TurnId;
  if (!turnId) return;

  const turn = ctx.db.turns.get(turnId);
  if (!turn || turn.threadId !== event.threadId || turn.engine !== "codex") {
    throw new Error(`Codex diff 无法归属到本地 turn：threadId=${event.threadId}, turnId=${turnId}`);
  }

  const workspacePath = ctx.workspaces.get(event.workspaceId) ?? null;
  if (!workspacePath) throw new Error(`Codex diff 对应 workspace 不存在：workspaceId=${event.workspaceId}`);

  const diff = String((event.payload as any)?.diff ?? "");
  const diffSha256 = crypto.createHash("sha256").update(diff).digest("hex");
  const eventSeq = Number(event.seq ?? 0);
  if (!Number.isFinite(eventSeq) || eventSeq <= 0) {
    throw new Error(`Codex diff 缺少有效 eventSeq：threadId=${event.threadId}, turnId=${turnId}`);
  }

  const currentCheckpoint = parseEngineCheckpointObject(turn.engineCheckpointJson, turnId);
  const current = currentCheckpoint.codexTurnDiff;
  let verifiedPaths: string[] | null = null;
  if (current != null) {
    if (typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Codex diff checkpoint 无效：threadId=${event.threadId}, turnId=${turnId}`);
    }
    const cachedDiff = current as Record<string, unknown>;
    const currentSeq = Number(cachedDiff.eventSeq ?? 0);
    const currentHash = String(cachedDiff.diffSha256 ?? "").trim();
    if (!Number.isFinite(currentSeq) || currentSeq <= 0 || !/^[a-f0-9]{64}$/i.test(currentHash)) {
      throw new Error(`Codex diff checkpoint 索引字段无效：threadId=${event.threadId}, turnId=${turnId}`);
    }
    if (currentSeq > eventSeq) return;
    if (currentSeq === eventSeq && currentHash !== diffSha256) {
      throw new Error(`Codex diff 同序号内容冲突：threadId=${event.threadId}, turnId=${turnId}, eventSeq=${eventSeq}`);
    }
    if (currentHash === diffSha256 && cachedDiff.v === 1 && cachedDiff.source === "turn/diff/updated"
      && cachedDiff.parseComplete === true && Array.isArray(cachedDiff.paths)
      && cachedDiff.paths.every((entry: unknown) => typeof entry === "string"
        && normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath: entry }) === entry)) {
      verifiedPaths = cachedDiff.paths;
    }
  }

  const analyzed = verifiedPaths ? { valid: true, paths: verifiedPaths } : analyzeUnifiedDiffPaths(workspacePath, diff);
  ctx.db.turns.mergeEngineCheckpoint(turnId, {
    codexTurnDiff: {
      v: 1,
      source: "turn/diff/updated",
      engineTurnId: String((event.payload as any)?.engineTurnId ?? "").trim() || null,
      eventSeq,
      diffSha256,
      paths: analyzed.paths,
      parseComplete: analyzed.valid,
      updatedAt: Number(event.ts ?? Date.now()),
    },
  });
}

/** 严格读取 checkpoint 根对象，避免证据索引覆盖损坏的历史值。 */
function parseEngineCheckpointObject(raw: string | null, turnId: TurnId): Record<string, unknown> {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`turn checkpoint JSON 无法解析：turnId=${turnId}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`turn checkpoint 必须是 JSON object：turnId=${turnId}`);
  }
  return parsed as Record<string, unknown>;
}

/** 仅清理指定 turn 的工具路径与 stepKey，终态事件不得退化为 thread 级清空。 */
function cleanupPendingTools(runtime: EventIndexRuntime, input: { threadId: ThreadId; turnId: TurnId }): void {
  for (const [itemId, info] of runtime.pendingToolPathsByItemId.entries()) {
    if (info.threadId !== input.threadId) continue;
    if (info.turnId !== input.turnId) continue;
    runtime.pendingToolPathsByItemId.delete(itemId);
  }
  // 清理 turn 级 stepKey 缓存
  runtime.stepKeyByTurnId.delete(input.turnId);
}

function pickDiffForPath(changes: any[], normPath: string): string | null {
  for (const c of changes) {
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath: null, rawPath: c?.path }) ?? String(c?.path ?? "").replace(/\\/g, "/");
    const tail = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath;
    if (tail === normPath || tail.endsWith(`/${normPath}`)) return typeof c?.diff === "string" ? c.diff : null;
  }
  return null;
}

/** 从 changes 数组中按 path 匹配提取 kind。 */
function pickKindForPath(changes: any[], normPath: string): string | null {
  for (const c of changes) {
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath: null, rawPath: c?.path }) ?? String(c?.path ?? "").replace(/\\/g, "/");
    const tail = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath;
    if (tail === normPath || tail.endsWith(`/${normPath}`)) return typeof c?.kind === "string" ? c.kind : null;
  }
  return null;
}

/** 将 ws:// / wss:// 转为对应的 HTTP Origin。 */
function toHttpBaseFromWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:39280";
  }
}

/** 严格转换 Server WS 地址，CLI 更新失败时必须把错误直接反馈给用户。 */
function resolveHttpBaseForClientUpdate(wsUrl: string): string {
  const raw = String(wsUrl ?? "").trim();
  if (!raw) {
    throw new Error("Server WS 地址为空");
  }
  const u = new URL(raw);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`Server WS 地址协议不支持：${u.protocol}`);
  }
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** 生成当前运行平台对应的 client 安装包查询串。 */
function currentClientPackageQuery(): string {
  const params = new URLSearchParams({ platform: process.platform, arch: process.arch });
  return `?${params.toString()}`;
}

/** Return the latest package fallback path for supported platform targets. */
function currentClientLatestDownloadPath(): string {
  const key = `${process.platform}-${process.arch}`;
  return key === "win32-x64" || key === "linux-x64"
    ? `/downloads/codeflowai-latest-${key}.tgz`
    : "/downloads/codeflowai-latest.tgz";
}

/** 非阻塞拉取 server 最新 client 版本（1200ms 超时，失败返回 null）。 */
async function tryFetchLatestClient(httpBase: string, timeoutMs = 1200): Promise<{ version: string; url: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${httpBase}/api/client/latest${currentClientPackageQuery()}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json() as any;
    if (body?.ok && body.version) return { version: body.version, url: body.url };
    return null;
  } catch {
    return null;
  }
}

/** 为 `codeflow --update` 拉取最新 client 包信息，失败原因必须可见。 */
async function fetchLatestClientForUpdate(serverWsUrl: string, timeoutMs = 10_000): Promise<{ version: string; url: string }> {
  const httpBase = resolveHttpBaseForClientUpdate(serverWsUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${httpBase}/api/client/latest${currentClientPackageQuery()}`, { signal: controller.signal });
    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = (await res.text()).trim();
      } catch (error) {
        bodyText = `响应正文读取失败：${error instanceof Error ? error.message : String(error)}`;
      }
      throw new Error(`查询最新版本失败：HTTP ${res.status}${bodyText ? ` ${bodyText.slice(0, 300)}` : ""}`);
    }
    const body = await res.json() as any;
    const version = String(body?.version ?? "").trim();
    const url = String(body?.url ?? "").trim();
    if (!body?.ok || !version || !url) {
      throw new Error("查询最新版本失败：响应缺少 version/url");
    }
    return { version, url };
  } finally {
    clearTimeout(timer);
  }
}

/** 启动前版本检查与升级提示。 */
async function checkClientUpdateOrPrompt(opts: { serverWsUrl: string; currentVersion: string | null }): Promise<void> {
  const startedAt = Date.now();
  if (!opts.currentVersion) {
    logClientStep("warn", "startup.update_check", "skip", "client update check skipped: current version missing", {
      serverWsUrl: opts.serverWsUrl,
    });
    return;
  }
  const httpBase = toHttpBaseFromWsUrl(opts.serverWsUrl);
  logClientStep("info", "startup.update_check", "start", "client update check started", {
    httpBase,
    currentVersion: opts.currentVersion,
  });
  const latest = await tryFetchLatestClient(httpBase);
  if (!latest) {
    logClientStep("warn", "startup.update_check", "skip", "client update check skipped: latest version unavailable", {
      httpBase,
      currentVersion: opts.currentVersion,
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  if (compareSemver(opts.currentVersion, latest.version) >= 0) {
    logClientStep("info", "startup.update_check", "success", "client already up to date", {
      httpBase,
      currentVersion: opts.currentVersion,
      latestVersion: latest.version,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl: opts.serverWsUrl,
    downloadPath: latest.url,
  });
  if (!installUrl) {
    logClientStep("warn", "startup.update_check", "warn", "client update found but trusted install url is unavailable", {
      httpBase,
      currentVersion: opts.currentVersion,
      latestVersion: latest.version,
      durationMs: Date.now() - startedAt,
    });
    // eslint-disable-next-line no-console
    console.warn("[codeflowai] 检测到新版本，但当前连接不是受信任的升级来源；自动升级已禁用。生产环境请使用 wss/https，本地开发可继续使用 localhost/私网 http。");
    return;
  }
  logClientStep("info", "startup.update_check", "success", "client update available", {
    httpBase,
    currentVersion: opts.currentVersion,
    latestVersion: latest.version,
    durationMs: Date.now() - startedAt,
  });
  // eslint-disable-next-line no-console
  console.log(`\n[codeflowai] 发现新版本: ${latest.version}（当前: ${opts.currentVersion}）`);
  const upgradeCommand = buildClientUpgradeCommand(installUrl);
  // eslint-disable-next-line no-console
  console.log(`[codeflowai] 升级命令: ${formatClientUpgradeManualCommand(upgradeCommand)}\n`);

  // TTY 环境：交互提示
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await askYesNo("是否立即升级？(y/n) ");
    if (answer) {
      const requestId = crypto.randomUUID();
      let prepared: PreparedClientUpgradePackage | null = null;
      let packageHandedOff = false;
      try {
        if (!/^https?:\/\//i.test(installUrl)) {
          throw new Error(`不合法的升级 URL: ${installUrl}`);
        }
        const upgradeEnv = buildClientUpgradeNpmEnv();
        const upgradeTargetPrefix = await resolveCurrentClientUpgradeTarget(upgradeEnv);
        prepared = await prepareClientUpgradePackage({ installUrl, onProgress: printClientUpgradePackageProgress });
        const offlineCommand = buildClientOfflineUpgradeCommand(prepared.archivePath);
        prepareClientUpgradePrivilege(offlineCommand);
        const previous = readClientDaemonProcessSnapshot();
        if (process.platform === "win32") {
          launchWindowsDetachedUpgrade({
            installUrl,
            npmPrefix: upgradeTargetPrefix,
            parentPid: process.pid,
            daemonWasRunning: previous.running,
            previousClientPid: previous.clientPid,
            targetVersion: latest.version,
            preparedPackage: prepared,
          });
          packageHandedOff = true;
          logClientStep("info", "startup.update_install", "start", "windows detached client update launched", {
            currentVersion: opts.currentVersion,
            latestVersion: latest.version,
            parentPid: process.pid,
          });
          // eslint-disable-next-line no-console
          console.log("[codeflowai] Windows 将在独立升级窗口中继续执行安装；当前 client 先退出释放全局文件锁。");
          process.exit(0);
        }

        // eslint-disable-next-line no-console
        console.log(`[codeflowai] 正在执行: ${formatCliCommand(offlineCommand.command, offlineCommand.args)}`);
        const installEnv = pinClientUpgradeNpmPrefix(upgradeEnv, upgradeTargetPrefix);
        const result = runPosixClientUpgrade({
          previous, expectedVersion: latest.version, verifyPackage: () => verifyPreparedClientUpgradePackage(prepared!),
          run: runClientUpgradeCommandWithProgress,
          install: () => {
            const installed = spawnSync(offlineCommand.command, offlineCommand.args, { stdio: "inherit", env: installEnv });
            if (installed.error) throw installed.error;
            if (installed.status !== 0) throw new Error(`npm 退出码: ${installed.status}`);
          },
        });
        // process.exit 不执行 finally；确认完成本地包清理后再退出当前交互入口。
        await releaseClientUpgradePackage(prepared, requestId); prepared = null;
        logClientStep("info", "startup.update_install", "success", "client update command finished", {
          currentVersion: opts.currentVersion,
          latestVersion: latest.version,
        });
        if (result.degraded) console.warn("[codeflowai] 新版已连接服务器，部分模块尚未就绪，请查看启动诊断。");
        const restartResult = result.restarted ? { ok: true as const, restarted: true } : restartCurrentClientAfterUpdate();
        const restartError = restartResult.ok ? null : restartResult.error;
        logClientStep(restartResult.ok ? "info" : "error", "startup.update_restart", restartResult.ok ? "success" : "fail", restartResult.ok ? "client restarted after update" : "client update restart failed", {
          currentVersion: opts.currentVersion,
          latestVersion: latest.version,
          error: restartError,
        });
        if (restartResult.ok) {
          // eslint-disable-next-line no-console
          console.log("[codeflowai] 升级完成，已自动重启 client。");
          process.exit(0);
        }
        // eslint-disable-next-line no-console
        console.error(`[codeflowai] 升级完成，但自动重启失败: ${restartResult.error ?? "unknown"}`);
        // eslint-disable-next-line no-console
        console.error(`[codeflowai] 请手动执行: ${formatPostUpgradeDaemonRestartCommand()}`);
        process.exit(1);
      } catch (e) {
        logClientStep("error", "startup.update_install", "fail", "client update command failed", {
          code: e instanceof ClientUpgradePackageError || e instanceof ClientUpgradeLifecycleError ? e.code : "CLIENT_UPGRADE_FAILED",
          requestId, stage: e instanceof ClientUpgradeLifecycleError ? e.stage : "prepare",
          currentVersion: opts.currentVersion,
          latestVersion: latest.version,
          error: clientUpgradeErrorContext(e),
        });
        // eslint-disable-next-line no-console
        console.error(`[codeflowai] 升级失败 requestId=${requestId}:`, redactClientStartupText(e instanceof Error ? e.message : String(e)));
      } finally {
        if (prepared && !packageHandedOff) await releaseClientUpgradePackage(prepared, requestId);
      }
    }
  }
}

/** 格式化日志中的 CLI 命令，确保 URL 等参数可直接复制执行。 */
function formatCliCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCliArg).join(" ");
}

/** 对包含特殊字符的参数做双引号转义。 */
function quoteCliArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

type ClientUpdateRestartResult = { ok: true; restarted: boolean } | { ok: false; restarted: false; error: string };
type ClientCommandResult = { error?: Error; status: number | null; stdout?: string };

/** Formats the manual non-Windows upgrade command so it restarts the daemon after install. */
function formatClientUpgradeManualCommand(upgradeCommand: { command: string; args: string[] }): string {
  const installCommand = formatCliCommand(upgradeCommand.command, upgradeCommand.args);
  if (process.platform === "win32") return installCommand;
  return `${installCommand} && ${formatPostUpgradeDaemonRestartCommand()}`;
}

/** Builds the post-upgrade daemon restart shell snippet; missing stop state should not block start. */
function formatPostUpgradeDaemonRestartCommand(): string {
  return "(codeflow --stop || true) && codeflow --daemon";
}

/** Resolves the current CLI entry so restart commands do not hit an older PATH shim. */
function resolveCurrentClientEntryPath(): string | null {
  const entryPath = String(process.argv[1] ?? "").trim();
  return entryPath ? path.resolve(entryPath) : null;
}

/** Runs a codeflow subcommand through the current Node and CLI entry. */
function runCurrentClientCommand(args: string[]): ClientCommandResult {
  const entryPath = resolveCurrentClientEntryPath();
  if (!entryPath) return { error: new Error("missing client entry path"), status: null };
  const capture = args[0] === "--version" || args[0] === "--connected";
  const result = spawnSync(process.execPath, [...process.execArgv, entryPath, ...args], {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8",
    timeout: capture ? 20000 : undefined, windowsHide: true, env: buildClientChildProcessEnv(process.env, process.execPath),
  });
  return { error: result.error, status: result.status, stdout: result.stdout || undefined };
}

/**
 * 按安装阶段同一份环境确认 npm 目录，阻止源码入口替换全局 Client。
 * 返回判定命中的前缀，供调用方钉住本次 npm 安装目标（Windows 由独立升级脚本钉住）。
 */
async function resolveCurrentClientUpgradeTarget(env: NodeJS.ProcessEnv): Promise<string> {
  const { prefix, error } = await resolveNpmGlobalPrefixResult(env);
  const target = resolveClientUpgradeInstallTarget({
    npmGlobalPrefix: prefix, prefixError: error, platform: process.platform, env, entryPath: process.argv[1] ?? null,
  });
  if (!target.allowed) throw new Error(target.message);
  return target.npmGlobalPrefix;
}

/** Restarts the current running client after self-upgrade before the old process exits. */
function restartCurrentClientAfterUpdate(): ClientUpdateRestartResult {
  try {
    if (isClientDaemonChild()) {
      spawnClientDaemonReplacementFromCurrentProcess();
      return { ok: true, restarted: true };
    }
    const entryPath = resolveCurrentClientEntryPath();
    if (!entryPath) return { ok: false, restarted: false, error: "missing client entry path" };
    const child = spawn(process.execPath, [...process.execArgv, entryPath, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: buildClientRestartEnv(process.env),
      windowsHide: true,
    });
    if (!child.pid) return { ok: false, restarted: false, error: "child pid is empty" };
    child.unref();
    return { ok: true, restarted: true };
  } catch (error) {
    return { ok: false, restarted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Prints the post-upgrade restart result and fails when auto restart failed. */
function printUpdateRestartResult(result: ClientUpdateRestartResult): number {
  if (result.ok && result.restarted) {
    console.log("[codeflowai] 升级完成，已自动重启后台 client。");
    return 0;
  }
  if (result.ok) {
    console.log("[codeflowai] 升级完成，未检测到正在运行的后台 client。");
    return 0;
  }
  console.error(`[codeflowai] 升级完成，但自动重启失败: ${result.error}`);
  console.error(`[codeflowai] 请手动执行: ${formatPostUpgradeDaemonRestartCommand()}`);
  return 1;
}

/** 执行显式 client 更新命令。 */
async function handleClientUpdateCommand(): Promise<number> {
  const serverWsUrl = readClientServerWsUrl();
  const currentVersion = readSelfVersion();
  const requestId = crypto.randomUUID();
  let targetVersion: string | null = null;
  let previous: ReturnType<typeof readClientDaemonProcessSnapshot> | null = null;
  let prepared: PreparedClientUpgradePackage | null = null;
  let packageHandedOff = false;
  try {
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 检查 client 更新：${serverWsUrl}`);
    const latest = await fetchLatestClientForUpdate(serverWsUrl);
    targetVersion = latest.version;
    if (currentVersion && compareSemver(currentVersion, latest.version) >= 0) {
      // eslint-disable-next-line no-console
      console.log(`[codeflowai] 当前已是最新版本：${currentVersion}`);
      return 0;
    }

    const installUrl = resolveClientUpgradeInstallUrl({
      serverWsUrl,
      downloadPath: latest.url,
    });
    if (!installUrl) {
      throw new Error("缺少可信的 client 安装地址；生产环境请使用 wss/https，本地开发可继续使用 localhost/私网 http。");
    }

    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 准备升级 client：${currentVersion ?? "unknown"} -> ${latest.version}`);
    const upgradeEnv = buildClientUpgradeNpmEnv();
    const upgradeTargetPrefix = await resolveCurrentClientUpgradeTarget(upgradeEnv);
    prepared = await prepareClientUpgradePackage({ installUrl, onProgress: printClientUpgradePackageProgress });
    const upgradeCommand = buildClientOfflineUpgradeCommand(prepared.archivePath);
    prepareClientUpgradePrivilege(upgradeCommand);
    previous = readClientDaemonProcessSnapshot();
    if (process.platform === "win32") {
      const scriptPath = launchWindowsDetachedUpgrade({
        installUrl,
        npmPrefix: upgradeTargetPrefix,
        parentPid: process.pid,
        daemonWasRunning: previous.running,
        previousClientPid: previous.clientPid,
        targetVersion: latest.version,
        preparedPackage: prepared,
      });
      packageHandedOff = true;
      // eslint-disable-next-line no-console
      console.log(`[codeflowai] Windows 升级已交给独立 PowerShell 执行：${scriptPath}`);
      return 0;
    }

    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 正在执行: ${formatCliCommand(upgradeCommand.command, upgradeCommand.args)}`);
    const result = runPosixClientUpgrade({
      previous, expectedVersion: latest.version,
      verifyPackage: () => verifyPreparedClientUpgradePackage(prepared!),
      run: runClientUpgradeCommandWithProgress,
      install: () => {
        const installed = spawnSync(upgradeCommand.command, upgradeCommand.args, {
          stdio: "inherit", env: pinClientUpgradeNpmPrefix(upgradeEnv, upgradeTargetPrefix),
        });
        if (installed.error) throw installed.error;
        if (installed.status !== 0) throw new Error(`npm 退出码: ${installed.status}`);
      },
    });
    if (result.degraded) console.warn("[codeflowai] 新版已连接服务器，部分模块尚未就绪，请查看启动诊断。");
    return printUpdateRestartResult({ ok: true, restarted: result.restarted });
  } catch (error) {
    const message = redactClientStartupText(error instanceof Error ? error.message : String(error));
    logClientStep("error", "client.update", "fail", "client upgrade failed", {
      code: error instanceof ClientUpgradeLifecycleError || error instanceof ClientUpgradePackageError ? error.code : "CLIENT_UPGRADE_FAILED",
      requestId, currentVersion, targetVersion, serverUrl: safeClientServerUrl(serverWsUrl),
      supervisorPid: previous?.supervisorPid ?? null, clientPid: previous?.clientPid ?? null,
      stage: error instanceof ClientUpgradeLifecycleError ? error.stage : "prepare",
      error: clientUpgradeErrorContext(error),
      recoveryError: error instanceof ClientUpgradeLifecycleError && error.recoveryError
        ? redactClientStartupText(String(error.recoveryError)) : undefined,
    });
    // eslint-disable-next-line no-console
    console.error(`[codeflowai] 升级失败 requestId=${requestId}:`, message);
    return 1;
  } finally {
    if (prepared && !packageHandedOff) await releaseClientUpgradePackage(prepared, requestId);
  }
}

/** 卸载 npm 阶段的兜底超时：本地卸载包应在秒级完成，超时按显式失败处理。 */
const CLIENT_UNINSTALL_NPM_TIMEOUT_MS = 600_000;

/** 执行显式 client 卸载命令：只删 Client 包与命令，用户数据目录原样保留。 */
async function handleClientUninstallCommand(): Promise<number> {
  const requestId = crypto.randomUUID();
  const currentVersion = readSelfVersion();
  const platform = process.platform;
  const uninstallEnv = buildClientUpgradeNpmEnv();
  const entryPath = process.argv[1] ?? null;
  let prefixResult: NpmGlobalPrefixResult | null = null;
  let entryCheck: ClientUninstallEntryCheck | null = null;
  let plan: ClientUninstallPlan | null = null;
  let previous: ReturnType<typeof readClientDaemonProcessSnapshot> | null = null;
  try {
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 准备卸载 CodeFlowAI Client ${currentVersion ?? "unknown"}`);
    prefixResult = await resolveNpmGlobalPrefixResult(uninstallEnv);
    // 判定与日志必须同源：用卸载环境的 env 与显式入口，避免日志字段与实际判定取值不一致。
    entryCheck = resolveClientUninstallEntryVerdict(prefixResult.prefix, prefixResult.error, platform, uninstallEnv, entryPath);
    // 判定失败时不再解析删除清单：prefix 不可信时清单本身就可能指向错误目录；阶段机 prepare 会再校验一次。
    if (!entryCheck.allowed) throw new ClientUninstallError(entryCheck.code, entryCheck.message);
    // 必须用判定命中的前缀（Windows 私有 launcher 被绕过时它才落在实际安装目录），否则会删错前缀并误报成功。
    plan = resolveClientUninstallPlan({ npmGlobalPrefix: entryCheck.npmGlobalPrefix, platform, env: process.env });
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 将删除全局包：${plan.packageDir}`);
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 将保留：${[...plan.preservedPaths, plan.dataDir].join("、")}`);
    if (plan.managedArtifactsSkipped) {
      // eslint-disable-next-line no-console
      console.log(`[codeflowai] 入口属于 ${plan.npmGlobalPrefix}，本次只处理该前缀下的安装；托管目录 ${plan.managedRoot} 下的启动器与 PATH 条目未改动。`);
    }
    const uninstallCommand = buildClientUninstallCommand(platform);
    previous = readClientDaemonProcessSnapshot();
    if (platform === "win32") {
      const scriptPath = launchWindowsDetachedUninstall({ plan, parentPid: process.pid, daemonWasRunning: previous.running });
      // eslint-disable-next-line no-console
      console.log(`[codeflowai] Windows 卸载已交给独立 PowerShell 执行：${scriptPath}`);
      return 0;
    }

    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 正在执行: ${formatCliCommand(uninstallCommand.command, uninstallCommand.args)}`);
    runPosixClientUninstall({
      entryCheck,
      daemonRunning: previous.running,
      preparePrivilege: () => prepareClientUninstallPrivilege(uninstallCommand),
      run: runClientUninstallCommandWithProgress,
      uninstall: () => {
        const result = spawnSync(uninstallCommand.command, uninstallCommand.args, {
          stdio: "inherit", timeout: CLIENT_UNINSTALL_NPM_TIMEOUT_MS,
          // 与 Windows 卸载脚本一致地钉住 prefix：否则 npm 会回落到被污染的 npm_config_prefix 或默认前缀。
          env: { ...uninstallEnv, npm_config_prefix: plan!.npmGlobalPrefix, NPM_CONFIG_PREFIX: plan!.npmGlobalPrefix },
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`npm 退出码: ${result.status}`);
      },
      cleanup: () => printClientUninstallCleanup(runClientUninstallCleanup(plan!)),
      verify: () => assertClientUninstallCompleted(plan!),
    });
    // eslint-disable-next-line no-console
    console.log("[codeflowai] 卸载完成，后台 client 不再启动。");
    for (const hint of clientUninstallManualHints(plan)) {
      // eslint-disable-next-line no-console
      console.log(`[codeflowai] ${hint}`);
    }
    return 0;
  } catch (error) {
    const message = redactClientStartupText(error instanceof Error ? error.message : String(error));
    logClientStep("error", "client.uninstall", "fail", "client uninstall failed", {
      code: error instanceof ClientUninstallError || error instanceof ClientUninstallLifecycleError ? error.code : "CLIENT_UNINSTALL_FAILED",
      requestId, currentVersion, platform,
      packageDir: plan?.packageDir ?? null,
      // 与升级路径同名字段对齐：用于区分「前缀漂移」与「源码运行」，并回放真实的 npm prefix 探测值。
      npmGlobalPrefix: prefixResult?.prefix ?? null,
      npmGlobalPrefixError: prefixResult?.error ?? null,
      entryPath,
      candidates: entryCheck && !entryCheck.allowed ? entryCheck.candidates : [],
      supervisorPid: previous?.supervisorPid ?? null, clientPid: previous?.clientPid ?? null,
      stage: error instanceof ClientUninstallLifecycleError ? error.stage : "prepare",
      error: clientUpgradeErrorContext(error),
      recoveryError: error instanceof ClientUninstallLifecycleError && error.recoveryError
        ? redactClientStartupText(String(error.recoveryError)) : undefined,
    });
    // eslint-disable-next-line no-console
    console.error(`[codeflowai] 卸载失败 requestId=${requestId}:`, message);
    if (error instanceof ClientUninstallLifecycleError && error.recoveryError) {
      // eslint-disable-next-line no-console
      console.error(`[codeflowai] 原 Client 恢复启动失败: ${redactClientStartupText(String(error.recoveryError))}`);
    }
    return 1;
  }
}

/** 卸载的 sudo 授权也在停机前完成，避免停止后才等待用户输密码。 */
function prepareClientUninstallPrivilege(command: { command: string }): void {
  if (command.command !== "sudo") return;
  // eslint-disable-next-line no-console
  console.log("[codeflowai] 正在确认系统卸载权限；此阶段不会停止现有 Client...");
  const result = spawnSync("sudo", ["-v"], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new ClientUninstallError("CLIENT_UNINSTALL_PRIVILEGE_DENIED", "系统卸载授权失败，未停止现有 Client");
}

function runClientUninstallCommandWithProgress(args: string[]): ClientCommandResult {
  // eslint-disable-next-line no-console
  if (args[0] === "--stop") console.log("[codeflowai] 正在停止后台 Client，准备删除全局包...");
  // eslint-disable-next-line no-console
  if (args[0] === "--daemon") console.log("[codeflowai] 卸载未完成，正在恢复启动原 Client...");
  return runCurrentClientCommand(args);
}

function printClientUninstallCleanup(report: ReturnType<typeof runClientUninstallCleanup>): void {
  for (const path of [...report.removedLaunchers, ...report.removedStableLinks]) {
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 已删除启动器：${path}`);
  }
  if (report.strippedProfiles.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[codeflowai] 已清理 PATH 配置：${report.strippedProfiles.join("、")}`);
  }
  if (report.rolledBackNpmrcPrefix) {
    // eslint-disable-next-line no-console
    console.log("[codeflowai] 已回滚 ~/.npmrc 中指向 Client 的 npm prefix。");
  }
  if (report.npmrcHint) {
    // eslint-disable-next-line no-console
    console.warn(`[codeflowai] ${report.npmrcHint}`);
  }
}

function printClientUpgradePackageProgress(progress: ClientUpgradePreparationProgress): void {
  if (progress.stage === "checksum") console.log("[codeflowai] 正在获取升级包校验信息；下载准备阶段不会停止现有 Client...");
  else if (progress.stage === "verified") console.log("[codeflowai] 升级包下载完成，SHA256 校验通过。");
  else {
    const size = (progress.downloadedBytes / 1024 / 1024).toFixed(1);
    const total = progress.totalBytes ? ` / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MiB` : " MiB";
    console.log(`[codeflowai] 正在下载升级包：${size}${total}（已用 ${Math.floor(progress.elapsedMs / 1000)} 秒）`);
  }
}

function runClientUpgradeCommandWithProgress(args: string[]): ClientCommandResult {
  if (args[0] === "--stop") console.log("[codeflowai] 升级包已就绪，正在停止旧 Client 并离线换包...");
  if (args[0] === "--daemon") console.log("[codeflowai] 换包完成，正在启动并核验服务器连接...");
  return runCurrentClientCommand(args);
}

/** 系统级安装的 sudo 授权也在停机前完成，避免停止后才等待用户输密码。 */
function prepareClientUpgradePrivilege(command: { command: string }): void {
  if (command.command !== "sudo") return;
  console.log("[codeflowai] 正在确认系统安装权限；此阶段不会停止现有 Client...");
  const result = spawnSync("sudo", ["-v"], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new ClientUpgradePackageError("CLIENT_UPGRADE_PRIVILEGE_DENIED", "系统安装授权失败，未停止现有 Client");
}

function clientUpgradeErrorContext(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redactClientStartupText(String(error)) };
  return {
    name: error.name, message: redactClientStartupText(error.message),
    code: typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : undefined,
    cause: error.cause && depth < 3 ? clientUpgradeErrorContext(error.cause, depth + 1) : undefined,
    errors: error instanceof AggregateError && depth < 3 ? error.errors.slice(0, 5).map(value => clientUpgradeErrorContext(value, depth + 1)) : undefined,
  };
}

/** 清理失败有独立日志，不覆盖升级本身的成功/失败结论。 */
async function releaseClientUpgradePackage(prepared: PreparedClientUpgradePackage, requestId: string): Promise<void> {
  try { await cleanupClientUpgradePackage(prepared); }
  catch (error) {
    logClientStep("warn", "client.update.cleanup", "fail", "client upgrade temporary package cleanup failed", {
      code: "CLIENT_UPGRADE_TEMP_CLEANUP_FAILED", requestId, stage: "cleanup", error: clientUpgradeErrorContext(error),
    });
    console.warn(`[codeflowai] 临时升级包清理失败 requestId=${requestId}：${redactClientStartupText(String(error))}`);
  }
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const onData = (data: Buffer) => {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

function isIncompatibleClientReason(reason: string): boolean {
  const text = String(reason ?? "").trim().toLowerCase();
  return text.includes("client version too old");
}

async function printManualUpgradeHint(serverWsUrl: string): Promise<void> {
  const httpBase = toHttpBaseFromWsUrl(serverWsUrl);
  const latest = await tryFetchLatestClient(httpBase, 2000);
  const installUrl = resolveClientUpgradeInstallUrl({
    serverWsUrl,
    downloadPath: latest?.url ?? currentClientLatestDownloadPath(),
  });
  // eslint-disable-next-line no-console
  console.error("[codeflowai] 当前 client 版本已被 server 拒绝，请手动升级后重试。");
  if (latest?.version) {
    // eslint-disable-next-line no-console
    console.error(`[codeflowai] 建议升级到版本: ${latest.version}`);
  }
  if (!installUrl) {
    // eslint-disable-next-line no-console
    console.error("[codeflowai] 当前连接不是受信任的升级来源，未生成自动升级命令。生产环境请使用 wss/https，本地开发可继续使用 localhost/私网 http。");
    return;
  }
  const upgradeCommand = buildClientUpgradeCommand(installUrl);
  // eslint-disable-next-line no-console
  console.error(`[codeflowai] 手动升级命令: ${formatClientUpgradeManualCommand(upgradeCommand)}`);
}

/** 只给真正旧格式 workspaceId 批量加 clientId 前缀，避免已命名空间 ID 被重复套前缀。 */
function migrateWorkspaceIdPrefix(db: ClientDb, clientId: string): void {
  const allWorkspaces = db.workspaces.list({ includeDeleted: true });
  const needsMigration = allWorkspaces.filter(w => !isNamespacedLocalWorkspaceId(String(w.id)));
  if (!needsMigration.length) {
    logClientStep("info", "startup.workspace_id_migration", "skip", "no legacy workspace ids to migrate", {
      target: { clientId },
      workspaceCount: allWorkspaces.length,
    });
    return;
  }

  logClientStep("info", "startup.workspace_id_migration", "start", "legacy workspace id migration started", {
    target: { clientId },
    workspaceCount: allWorkspaces.length,
    migrationCount: needsMigration.length,
  });
  logger.info("client", `migrating ${needsMigration.length} legacy workspace(s) to add clientId prefix`);

  let migratedCount = 0;
  for (const w of needsMigration) {
    const oldId = String(w.id);
    const newId = prefixLocalWorkspaceId(clientId, oldId) as WorkspaceId;
    if (!newId || newId === oldId) continue;
    db.workspaces.migrateWorkspaceId(oldId as WorkspaceId, newId);
    migratedCount += 1;
  }

  logClientStep("info", "startup.workspace_id_migration", "success", "legacy workspace id migration finished", {
    target: { clientId },
    workspaceCount: allWorkspaces.length,
    migrationCount: needsMigration.length,
    migratedCount,
  });
  logger.info("client", "workspace migration complete");
}

