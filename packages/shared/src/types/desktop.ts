import type { ServerToWebMessage, TerminalApiMethod, TerminalRuntimeEventMessage } from "./rpc.js";
import type { AccountLoginResponseBody, AccountUserSummary } from "./account.js";
import type { KnowledgeAssetAction } from "./knowledgeAssets.js";
import type { DesktopUpdateFailureRecord } from "../desktopUpdateFailure.js";

/** 当前设备的脱敏更新失败历史；reported 只表示 Server 已精确确认。 */
export type DesktopUpdateDiagnostics = {
  deviceId: string;
  failures: Array<{ record: DesktopUpdateFailureRecord; reported: boolean }>;
};

/** 原应用闭包的即时事实；空故障或idle不代表已是最新。 */
export type DesktopUpdateState = {
  deviceId: string;
  operation: "idle" | "starting" | "exiting" | "checking" | "updating" | "downloading" | "flushing";
  checking: boolean;
  transportConfigured: boolean;
  automaticUpdates: boolean;
  updatesSuppressed: boolean;
  stoppingUpdates: boolean;
  shellOwned: boolean;
  updateCheckFailure: DesktopUpdateStateFailure | null;
  shellUpdateFailure: DesktopUpdateStateFailure | null;
  updateReceiptFailure: DesktopUpdateStateFailure | null;
  updateFailureFailure: DesktopUpdateStateFailure | null;
};

/** 故障仅复用现有公开诊断映射，不携带原始异常正文。 */
export type DesktopUpdateStateFailure = { requestId: string; rootCause: DesktopUpdateFailureRecord["rootCause"] };

/** 仅投影已验签整组清单的版本，不携带资源、签名或下载路径。 */
export type DesktopBundleVersion = { releaseId: string; version: string; webVersion: string; clientVersion: string };
/** 壳目标只取原验签清单，不代表安装或切换已经完成。 */
export type DesktopShellVersion = { shellId: string; version: string };
/** 原 owner 的明确结果；unknown 不能按空闲或 void 推成成功。 */
export type DesktopUpdateResult = "unknown" | "none" | "same" | "prepared" | "postponed" | "revoked" | "failure" | "healthy"
  | "restored" | "unavailable" | "manual_required" | "cancelled";
export type DesktopBundleUpdatePhase = "discovery" | "download" | "prepare" | "read-active" | "verify" | "compatibility"
  | "prepare-directory" | "drain" | "restart-client" | "reload-web" | "health" | "activate" | "rollback";
export type DesktopShellUpdatePhase = "prepare" | "download" | "install" | "health" | "handoff" | "admission-intent" | "recovery";
/** 本宿主已观察的更新事实；重启未读到的阶段为 null/unknown，历史由诊断能力提供。 */
export type DesktopUpdateDetails = {
  deviceId: string;
  current: { shellVersion: string | null; bundle: DesktopBundleVersion | null; clientVersion: string | null };
  bundle: { requestId: string | null; target: DesktopBundleVersion | null; phase: DesktopBundleUpdatePhase | null;
    result: DesktopUpdateResult; failure: DesktopUpdateStateFailure | null };
  shell: { requestId: string | null; target: DesktopShellVersion | null; phase: DesktopShellUpdatePhase | null;
    result: DesktopUpdateResult; failure: DesktopUpdateStateFailure | null };
};

/** 应用资源下载进度；null 表示当前不在下载阶段。 */
export type DesktopUpdateProgress = { received: number; total: number } | null;

/** 页面侧更新操作失败上报；只携带固定阶段与去敏错误码，不传路径或凭据。 */
export type DesktopUpdateClientErrorReport = {
  phase: "discovery" | "download" | "prepare" | "read-active" | "verify" | "compatibility" | "prepare-directory"
    | "drain" | "restart-client" | "reload-web" | "health" | "activate" | "install" | "handoff" | "admission-intent" | "recovery";
  code: string;
  target?: "bundle" | "shell";
  shellId?: string | null;
  requestId?: string | null;
  releaseId?: string | null;
  message?: string;
};

/** 下载完成后的更新提醒；只暴露展示所需字段，不携带路径或签名。 */
export type DesktopUpdateNotice = {
  releaseId: string;
  version: string;
  currentVersion: string | null;
  /** true 表示 macOS 壳需手动安装，不能由应用直接重启完成。 */
  shellOnly: boolean;
};

/** 提醒关闭方式；later 表示 24 小时后再提醒，session 表示本次运行不再提醒。 */
export type DesktopUpdateNoticeDismissAction = "later" | "session";


/** 云端关联是当前认证连接事实，与本地运行就绪独立。 */
export type DesktopCloudAccountState = {
  status: "unlinked" | "linking" | "linked" | "failed";
  generation: number;
  serverOrigin: string | null;
  userSummary: AccountUserSummary | null;
  errorCode: string | null;
  /** 内置 Key 失败独立于真实账号关联；旧壳可省略该投影。 */
  builtInRelayErrorCode?: "DESKTOP_BUILTIN_AUTO_ENABLE_FAILED" | "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED" | null;
};

/** 桌面 Client 完成本地初始化后的实际健康信息，不代表 Server 已连接。 */
export type DesktopClientHealth = {
  protocolVersion: 1;
  clientVersion: string;
  dbSchemaVersion: number;
  database: "ready";
};

export type DesktopClientReadyMessage = {
  t: "desktop.ready";
  requestId: string;
  health: DesktopClientHealth;
  startup?: { continuationId: string; admission: "paused" };
};

/** 候选启动复用原任务围栏，只有受信父进程可放行首次恢复。 */
export type DesktopStartupMode = { mode: "automatic" } | { mode: "held"; continuationId: string };

/** 复制受信启动输入；访问器、未知字段或半空身份必须显式拒绝。 */
export function snapshotDesktopStartupMode(value: unknown): DesktopStartupMode {
  if (value === undefined) return { mode: "automatic" };
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("DESKTOP_STARTUP_INPUT_INVALID");
  const keys = Reflect.ownKeys(value), mode = Object.getOwnPropertyDescriptor(value, "mode"), id = Object.getOwnPropertyDescriptor(value, "continuationId");
  if (!mode || !("value" in mode) || (id && !("value" in id)) || keys.some(key => key !== "mode" && key !== "continuationId")
    || keys.length !== (mode.value === "held" ? 2 : 1)) throw new Error("DESKTOP_STARTUP_INPUT_INVALID");
  if (mode.value === "automatic" && !id) return { mode: "automatic" };
  if (mode.value === "held" && typeof id?.value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id.value)) return { mode: "held", continuationId: id.value };
  throw new Error("DESKTOP_STARTUP_INPUT_INVALID");
}

/** held就绪只接受同身份的真实暂停事实，不把旧ready或附加字段当能力证明。 */
export function snapshotDesktopStartupReady(value: unknown, continuationId: string): NonNullable<DesktopClientReadyMessage["startup"]> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2) throw new Error("DESKTOP_STARTUP_READY_INVALID");
  const id = Object.getOwnPropertyDescriptor(value, "continuationId"), admission = Object.getOwnPropertyDescriptor(value, "admission");
  if (!id || !("value" in id) || id.value !== continuationId || !admission || !("value" in admission) || admission.value !== "paused") throw new Error("DESKTOP_STARTUP_READY_INVALID");
  return { continuationId, admission: "paused" };
}

/** 本地桥接仅开放已接入的业务；共享和云端身份不由渲染器提供。 */
export type DesktopApiMethod =
  | "runtime.builtinAssets.list"
  | "engineCustomModels.list"
  | "engineCustomModels.upsert"
  | "engineCustomModels.delete"
  | "quickPhrases.list"
  | "quickPhrases.create"
  | "quickPhrases.update"
  | "quickPhrases.delete"
  | "quickPhrases.reorder"
  | "runtime.info"
  | "runtime.activity"
  | "scheduledTasks.local.list"
  | "scheduledTasks.local.create"
  | "scheduledTasks.local.update"
  | "scheduledTasks.local.setEnabled"
  | "scheduledTasks.local.delete"
  | "scheduledTasks.local.runNow"
  | "scheduledTasks.local.runs"
  | "scheduledTasks.local.cronPreview"
  | "scheduledTasks.account.list"
  | "scheduledTasks.account.update"
  | "scheduledTasks.account.delete"
  | "scheduledTasks.account.sync"
  | "scheduledTasks.account.runNow"
  | "scheduledTasks.account.runs"
  | "runtime.cloudAccount.link"
  | "runtime.cloudAccount.unlink"
  | "runtime.cloudAccount.status"
  | "codeflowai.config.get"
  | "codeflowai.config.set"
  | "software.update.status"
  | "software.npm.install"
  | "workspaceDirectoryMigration.prepare"
  | "workspaceDirectoryMigration.get"
  | "workspaceDirectoryMigration.prepareStart"
  | "workspaceDirectoryMigration.executeStart"
  | "workspaceDirectoryMigration.fenceStart"
  | "workspaceDirectoryMigration.cancel"
  | "workspaceDirectoryMigration.recover"
  | "engineKeys.builtInRelay.ensure"
  | "engines.status"
  | "engineKeys.list"
  | "engineKeys.upsert"
  | "engineKeys.test"
  | "engineKeys.delete"
  | "engineKeys.activate"
  | "engineKeys.deactivate"
  | "workspaces.list"
  | "workspaces.upsert"
  | "workspaces.delete"
  | "reminders.workspaceSummaries"
  | "reminders.items"
  | "reminders.markRead"
  | "reminders.ignore"
  | "clientFs.directoryTree"
  | "workspaceExecutionProfile.get"
  | "workspaceExecutionProfile.update"
  | "workspaceExecutionProfile.status"
  | "threads.list"
  | "threads.create"
  | "threads.rename"
  | "threads.archive"
  | "threads.delete"
  | "approvals.respond"
  | "userInput.respond"
  | "threads.sendMessage"
  | "threads.updatePrefs"
  | "threads.draft.get"
  | "threads.draft.save"
  | "threads.draft.clear"
  | "threads.queue.append"
  | "threads.queue.list"
  | "threads.queue.move"
  | "threads.queue.remove"
  | "threads.queue.clear"
  | "threads.queue.resume"
  | "threads.queue.pause"
  | "turns.interrupt"
  | "threads.load"
  | "threads.presentation"
  | "threads.process"
  | "threads.events"
  | "threads.summary"
  | "threads.prefs"
  | "threads.latestPrefs"
  | "threads.groups.list"
  | "threads.groups.create"
  | "threads.groups.rename"
  | "threads.groups.delete"
  | "threads.group.assign"
  | "threads.pin"
  | "threads.clear"
  | "threads.compact"
  | "clientDb.cleanup.status"
  | "clientDb.cleanup.start"
  | "threads.restartCodexAppServer"
  | "threads.managedServices.list"
  | "threads.managedServices.stop"
  | "threads.inputActions.list"
  | "threads.fileChanges.list"
  | "threads.fileChanges.diff"
  | "threads.fileChanges.accept"
  | "threads.fileChanges.undo"
  | "threads.rollback"
  | "threads.rollback.preview"
  | "threads.messages.delete"
  | "orch.chat.get"
  | "orch.chat.settings"
  | "orch.chat.prepare"
  | "orch.chat.action"
  | "orch.chat.natural"
  | "orch.chat.rework"
  | "orch.chat.delete"
  | "workspacePrefs.get"
  | "workspacePrefs.save"
  | "orch.roles.list"
  | "orch.roles.upsert"
  | "orch.roles.delete"
  | "orch.workflows.list"
  | "orch.workflows.upsert"
  | "orch.workflows.delete"
  | "orch.knowledgeBundles.list"
  | "orch.knowledgeBundles.upsert"
  | "orch.knowledgeBundles.delete"
  | "orch.toolsets.list"
  | "orch.toolsets.upsert"
  | "orch.toolsets.delete"
  | "orch.skills.list"
  | "orch.skills.upsert"
  | "orch.skills.delete"
  | "skills.suites"
  | "skills.install"
  | "skills.uninstall"
  | "mcp.install"
  | "mcp.enable"
  | "mcp.update"
  | "mcp.test"
  | "mcp.import"
  | "mcp.uninstall"
  | "mcp.configure"
  | "mcp.unconfigure"
  | "orch.assets.copy"
  | "orch.assetDrafts.generate"
  | "orch.assetDrafts.get"
  | "orch.assetDrafts.apply"
  | "orch.assetDrafts.reject"
  | "orch.assetDraftJobs.list"
  | "orch.assetDraftJobs.get"
  | "orch.assetDraftJobs.delete"
  | "orch.assetDraftJobs.resume"
  | "orch.assetGroups.list"
  | "orch.assetGroups.create"
  | "orch.assetGroups.rename"
  | "orch.assetGroups.delete"
  | "orch.assetGroups.assign"
  | "orch.requirementAnalysis.sessions.list"
  | "orch.requirementAnalysis.sessions.create"
  | "orch.requirementAnalysis.sessions.get"
  | "orch.requirementAnalysis.createIntakes"
  | "orch.intakes.list"
  | "orch.intakes.create"
  | "orch.intakes.upsert"
  | "orch.intakes.delete"
  | "orch.proposals.list"
  | "orch.proposals.get"
  | "orch.proposals.create"
  | "orch.proposals.confirm"
  | "orch.instances.list"
  | "orch.instances.get"
  | "orch.instances.runtimePatch"
  | "orch.instances.start"
  | "orch.instances.pause"
  | "orch.instances.resume"
  | "orch.instances.cancel"
  | "orch.instances.feedback"
  | "orch.instances.rerunFromNode"
  | "orch.nodes.start"
  | "orch.nodes.skip"
  | "orch.nodes.cancel"
  | "orch.artifacts.list"
  | "orch.artifacts.get"
  | "orch.artifacts.revise"
  | "orch.artifactFiles.list"
  | "orch.events.list"
  | "orch.promptSnapshots.list"
  | "orch.promptSnapshots.get"
  | "orch.nodeWorkItems.list"
  | "orch.nodeWorkItemEvents.list"
  | "orch.workflowExecutionDefaults.get"
  | "orch.workflowExecutionDefaults.upsert"
  | "orch.workflowExecutionDefaults.delete"
  | "orch.assigneeTemplates.list"
  | "orch.assigneeTemplates.upsert"
  | "orch.assigneeTemplates.delete"
  | "orch.assetBundles.export"
  | "orch.assetBundles.import"
  | "orch.experiments.freeze"
  | "orch.experiments.run.start"
  | "orch.experiments.run.cancel"
  | "orch.experiments.run.status"
  | "orch.instances.discussionThread.ensure"
  | "orch.instances.reassignNode"
  | "orch.metrics.collect"
  | "orch.pendingMine.list"
  | "orch.requirementAnalysis.messages.send"
  | "orch.requirementAnalysis.sessions.archive"
  | "orch.runtimeEvidence.get"
  | "orch.skills.install"
  | "orch.skills.installStatus"
  | "orch.skills.uninstall"
  | "fs.tree"
  | "fs.search"
  | "fs.reindex"
  | "fs.stat"
  | "fs.downloadFile"
  | "fs.readFile"
  | "fs.spreadsheetPreview"
  | "fs.documentPreview"
  | "fs.extractAttachment"
  | "fs.uploadBegin"
  | "fs.uploadChunk"
  | "fs.uploadComplete"
  | "fs.uploadCancel"
  | "terminal.shells.list"
  | "terminal.actions.list"
  | "terminal.actions.save"
  | TerminalApiMethod
  | "git.status"
  | "git.diff"
  | "git.diffFiles"
  | "git.stage"
  | "git.unstage"
  | "git.discard"
  | "git.commit"
  | "git.log"
  | "git.show"
  | "git.showFileDiff"
  | "git.branch.list"
  | "git.branch.create"
  | "git.branch.switch"
  | "git.branch.delete"
  | `knowledge.assets.${KnowledgeAssetAction}`;

export type DesktopApiRequest = {
  method: DesktopApiMethod;
  body?: Record<string, unknown>;
};

/** 仅桌面父进程控制更新，渲染器业务桥不接收该请求。 */
export type DesktopUpdateControlRequest = {
  method: "runtime.update.prepare" | "runtime.update.cancel" | "runtime.update.interrupt";
  body?: never;
};

/** 首次恢复只接受本次启动身份，不进入渲染器业务白名单。 */
export type DesktopStartupControlRequest = { method: "runtime.startup.continue"; body: { continuationId: string } };

export type DesktopRuntimeRequest = DesktopApiRequest | DesktopUpdateControlRequest | DesktopStartupControlRequest;

export type DesktopApiResponse = { status: number; body: unknown };

export type DesktopApiRequestMessage = {
  t: "desktop.api.req";
  requestId: string;
  id: string;
  request: DesktopRuntimeRequest;
};

export type DesktopApiResponseMessage = {
  t: "desktop.api.res";
  requestId: string;
  id: string;
  response: DesktopApiResponse;
};

/** 本机终端事件复用 desktop.event 通道；clientId 与工作区归属由 Client 注入。 */
export type DesktopTerminalEvent = TerminalRuntimeEventMessage;

/** 本机推送承载已提交 canonical、队列/提醒脏标记与终端事实；raw 由 Inspector 分页读取。 */
export type DesktopEvent = Extract<ServerToWebMessage, { t: "conversation.event" | "conversation.changed" | "thread.queue.changed" | "orchestration.event" | "engineKeys.changed" | "reminders.changed" }>
  | DesktopTerminalEvent;

/** 严格识别本机终端事件形状；未知类型和缺失归属一律拒绝。 */
export function isDesktopTerminalEvent(value: unknown): value is DesktopTerminalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const nonEmpty = (input: unknown): input is string => typeof input === "string" && Boolean(input.trim());
  if (!nonEmpty(event.clientId)) return false;
  if (event.t === "terminal.created") {
    const terminal = event.terminal as Record<string, unknown> | undefined;
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) return false;
    return nonEmpty(terminal.id) && nonEmpty(terminal.workspaceId) && nonEmpty(terminal.label)
      && (terminal.status === "running" || terminal.status === "stopped" || terminal.status === "exited")
      && Number.isSafeInteger(terminal.createdAt)
      && (event.requestId === undefined || nonEmpty(event.requestId));
  }
  if (!nonEmpty(event.workspaceId)) return false;
  if (event.t === "terminal.output") return nonEmpty(event.terminalId) && typeof event.data === "string";
  if (event.t === "terminal.exited") return nonEmpty(event.terminalId) && (event.exitCode === null || Number.isSafeInteger(event.exitCode));
  if (event.t === "terminal.closed") return nonEmpty(event.terminalId);
  if (event.t === "terminal.renamed") return nonEmpty(event.terminalId) && nonEmpty(event.label);
  if (event.t === "terminal.foregroundChanged") return nonEmpty(event.terminalId)
    && (event.foregroundProcess === null || nonEmpty(event.foregroundProcess));
  if (event.t === "terminal.error") return nonEmpty(event.message)
    && (event.terminalId === undefined || nonEmpty(event.terminalId))
    && (event.requestId === undefined || nonEmpty(event.requestId));
  if (event.t !== "terminal.listed") return false;
  return (event.requestId === undefined || nonEmpty(event.requestId))
    && Array.isArray(event.terminals)
    && event.terminals.every((terminal: unknown) => {
      if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) return false;
      const item = terminal as Record<string, unknown>;
      return nonEmpty(item.id) && item.workspaceId === event.workspaceId && nonEmpty(item.label)
        && (item.status === "running" || item.status === "stopped" || item.status === "exited")
        && Number.isSafeInteger(item.createdAt) && (item.scrollback === undefined || typeof item.scrollback === "string");
    });
}

export type DesktopEventMessage = {
  t: "desktop.event";
  requestId: string;
  event: DesktopEvent;
};

export type DesktopRuntimeStatus = "starting" | "running" | "ready" | "draining" | "stopped" | "failed";

export type DesktopRuntimeState = {
  status: DesktopRuntimeStatus;
  requestId: string | null;
  releaseId: string | null;
  errorCode: string | null;
};

export type DesktopWindowState = { maximized: boolean };

/** 启动迁移的脱敏事实；数量来自 Worker，凭据不进入状态或事件。 */
export type DesktopMigrationState = {
  status: "checking" | "available" | "running" | "failed" | "ready";
  canDefer?: boolean;
  migrationId: string | null;
  candidateId: string | null;
  workspaceCount: number;
  stage: string;
  completed: number;
  total: number | null;
  errorCode: string | null;
  message: string | null;
  account: {
    status: "not_requested" | "restoring" | "restored" | "failed" | "cancelled";
    errorCode: string | null;
    message: string | null;
  };
};

/** 真实账号会话仅经可信桥交给现有账号 store，不携带来源 Client Key。 */
export type DesktopMigrationAccount = { serverOrigin: string; session: AccountLoginResponseBody };

/** 无边框窗口的自定义窗口控制；旧壳不提供时 Web 不渲染控制按钮。 */
export type DesktopWindowControls = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<DesktopWindowState>;
  close(): Promise<void>;
  getState(): Promise<DesktopWindowState>;
  onStateChange(listener: (state: DesktopWindowState) => void): () => void;
};

/** 窗口只能调用声明的桌面操作，不能访问任意 IPC、文件或进程。 */
export type DesktopBridgeApi = {
  getState(): Promise<DesktopRuntimeState>;
  getMigrationState?: () => Promise<DesktopMigrationState>;
  startMigration?: (candidateId: string) => Promise<void>;
  deferMigration?: () => Promise<void>;
  retryMigrationAccount?: () => Promise<void>;
  takeMigrationAccount?: () => Promise<DesktopMigrationAccount | null>;
  acknowledgeMigrationAccount?: () => Promise<void>;
  cancelMigrationAccount?: () => Promise<void>;
  onMigrationState?: (listener: (state: DesktopMigrationState) => void) => () => void;
  /** 只读当前设备诊断；旧壳缺能力时不提供，页面不能指定身份或路径。 */
  getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics>;
  /** 只读原更新事实；旧壳缺能力时省略。 */
  getUpdateState?: () => Promise<DesktopUpdateState>;
  /** 只读本宿主详细观察；旧壳省略，旧粗状态合同保持原形状。 */
  getUpdateDetails?: () => Promise<DesktopUpdateDetails>;
  /** 页面启动补查待展示的更新提醒；旧壳缺能力时不启用提醒。 */
  getUpdateNotice?: () => Promise<DesktopUpdateNotice | null>;
  /** 关闭提醒；只接受固定动作，旧壳省略。 */
  dismissUpdateNotice?: (action: DesktopUpdateNoticeDismissAction) => Promise<void>;
  /** 下载完成提醒推送；旧壳缺能力时不订阅。 */
  onUpdateNotice?: (listener: (notice: DesktopUpdateNotice) => void) => () => void;
  /** 应用资源下载进度推送；旧壳缺能力时不订阅。 */
  onUpdateProgress?: (listener: (progress: DesktopUpdateProgress) => void) => () => void;
  /** 页面侧更新操作失败上报；旧壳缺能力时页面只保留控制台记录。 */
  reportUpdateError?: (input: DesktopUpdateClientErrorReport) => Promise<void>;
  /** 有运行中会话时的退出确认请求；固定无参，旧壳省略时主进程回退系统确认框。 */
  onQuitConfirmRequested?: (listener: () => void) => () => void;
  /** 回传退出确认结果；只接受布尔值。 */
  respondQuitConfirm?: (confirmed: boolean) => Promise<void>;
  /** 只进入原检查入口；正常结算不证明无包或安装完成。 */
  checkForUpdates?: () => Promise<void>;
  /** 用户明确选择重启，已准备资源仍在下次启动复核授权。 */
  restartForUpdate?: () => Promise<void>;
  /** 托盘「检查更新」请求；旧壳缺能力时不提供。 */
  onUpdateCheckRequested?: (listener: () => void) => () => void;
  /** 取走尚未消费的托盘检查请求；旧壳省略。 */
  takeUpdateCheckRequest?: () => Promise<boolean>;
  /** 托盘「意见反馈」请求；旧壳省略。 */
  onFeedbackRequested?: (listener: () => void) => () => void;
  /** 取走尚未消费的托盘反馈请求；旧壳省略。 */
  takeFeedbackRequest?: () => Promise<boolean>;
  /** 本机系统目录选择；仅允许选择文件夹，取消返回 null，失败拒绝。 */
  selectDirectory?: (initialPath?: string) => Promise<string | null>;
  request(request: DesktopApiRequest): Promise<DesktopApiResponse>;
  /** 旧壳缺少该能力时由 Web 显式拒绝，不能假装已有实时事件流。 */
  onEvent?: (listener: (event: DesktopEvent) => void) => () => void;
  openWindow(): Promise<void>;
  exit(): Promise<void>;
  /** 宿主平台；旧壳缺省时页面按非 macOS 处理。 */
  platform?: "win32" | "darwin" | "linux";
  windowControls?: DesktopWindowControls;
};
