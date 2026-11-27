import { isSharedWorkspaceSelectionId, type ApiResult, type DesktopApiRequest, type DesktopBridgeApi, type DesktopEvent, type DesktopUpdateClientErrorReport, type DesktopUpdateDetails, type DesktopUpdateDiagnostics, type DesktopUpdateNotice, type DesktopUpdateNoticeDismissAction, type DesktopUpdateProgress, type DesktopUpdateState } from "@codeflowai/shared";
import { createApiResultError } from "../api/request";

declare global {
  interface Window { codeflowDesktop?: DesktopBridgeApi; }
}

/** 浏览器没有本机桥接；桌面仅使用沙箱 preload 暴露的固定入口。 */
export function getDesktopBridge(): DesktopBridgeApi | null {
  return typeof window !== "undefined" && typeof window.codeflowDesktop?.request === "function"
    && typeof window.codeflowDesktop.getState === "function" ? window.codeflowDesktop : null;
}

/** 固定能力分别检测，旧壳缺一项不会屏蔽其余入口。 */
export function getDesktopUpdateCapabilities(): { state: boolean; check: boolean; diagnostics: boolean; details: boolean; restart: boolean; notice: boolean } {
  const bridge = getDesktopBridge();
  return { state: typeof bridge?.getUpdateState === "function", check: typeof bridge?.checkForUpdates === "function",
    diagnostics: typeof bridge?.getUpdateDiagnostics === "function", details: typeof bridge?.getUpdateDetails === "function",
    restart: typeof bridge?.restartForUpdate === "function", notice: typeof bridge?.getUpdateNotice === "function" };
}

/** 标记 Web 自有边界失败，避免重复记录宿主已处理的原拒绝。 */
export class DesktopUpdateServiceError extends Error {
  /** code 仅由本文件固定能力与校验分支提供。 */
  constructor(readonly code: string) { super(code); }
}

/** 只接受纯数据描述符；坏投影不能执行访问器或夹带私有字段。 */
function isUpdateData(value: unknown, depth = 0): boolean {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
  if (!value || typeof value !== "object") return true;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (depth > 10 || (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)) return false;
  if (array && Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && "value" in descriptor && (descriptor.enumerable || array && key === "length")
      && isUpdateData(descriptor.value, depth + 1);
  });
}

/** 结构白名单只校验桥公开数据，不在 Web 重写宿主错误映射。 */
function hasUpdateKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}

const updateIdentity = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const updateToken = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;
const updateStateRequestId = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u;

/** 诊断只包含安全名称、代码和有界原因树，不显示任意异常正文。 */
function isUpdateCause(value: unknown, depth = 0): boolean {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const cause = value as Record<string, unknown>;
  return Object.keys(cause).every(key => ["name", "code", "causes"].includes(key))
    && typeof cause.name === "string" && ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "AbortError"].includes(cause.name)
    && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(cause.code)
    && (cause.causes === undefined || Array.isArray(cause.causes) && cause.causes.length > 0 && depth < 3 && cause.causes.every(item => isUpdateCause(item, depth + 1)));
}

/** 读取即时事实；失败原样交给展示边界，不回落通用请求或云端。 */
export async function getDesktopUpdateState(): Promise<DesktopUpdateState> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getUpdateState !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_STATE_UNAVAILABLE");
  const value = await bridge.getUpdateState();
  const flags = ["checking", "transportConfigured", "automaticUpdates", "updatesSuppressed", "stoppingUpdates", "shellOwned"] as const;
  const failures = ["updateCheckFailure", "shellUpdateFailure", "updateReceiptFailure", "updateFailureFailure"] as const;
  if (!isUpdateData(value) || !hasUpdateKeys(value, ["deviceId", "operation", ...flags, ...failures])
    || typeof value.deviceId !== "string" || !updateIdentity.test(value.deviceId)
    || typeof value.operation !== "string" || !["idle", "starting", "exiting", "checking", "updating", "downloading", "flushing"].includes(value.operation)
    || !flags.every(key => typeof value[key] === "boolean")
    || !failures.every(key => value[key] === null || hasUpdateKeys(value[key], ["requestId", "rootCause"])
      && typeof value[key].requestId === "string" && updateStateRequestId.test(value[key].requestId) && isUpdateCause(value[key].rootCause))) {
    throw new DesktopUpdateServiceError("DESKTOP_UPDATE_STATE_INVALID");
  }
  return value as DesktopUpdateState;
}

/** 版本沿验签合同保留非空原文本，不能套用发布ID的路径段限制。 */
function isUpdateVersionText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** 可信版本只接受公开字段；ID沿原可移植路径段规则，空值表示未知。 */
function isUpdateVersion(value: unknown, keys: string[]): boolean {
  return value === null || hasUpdateKeys(value, keys)
    && keys.every(key => isUpdateVersionText(value[key]) && (!key.endsWith("Id")
      || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value[key]) && !/[. ]$/u.test(value[key])
        && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value[key])));
}

/** 下载进度事件只接受安全整数且不超过总量；null 表示离开下载阶段。 */
function isUpdateProgress(value: unknown): boolean {
  if (value === null) return true;
  if (!hasUpdateKeys(value, ["received", "total"])) return false;
  const progress = value as { received: unknown; total: unknown };
  return Number.isSafeInteger(progress.received) && Number.isSafeInteger(progress.total)
    && (progress.received as number) >= 0 && (progress.total as number) > 0
    && (progress.received as number) <= (progress.total as number);
}

/** 两通道分别校验，阶段和结果只消费宿主公开事实。 */
function isUpdateChannel(value: unknown, versionKeys: string[], phases: string[]): boolean {
  return hasUpdateKeys(value, ["requestId", "target", "phase", "result", "failure"])
    && (value.requestId === null || typeof value.requestId === "string" && updateStateRequestId.test(value.requestId))
    && isUpdateVersion(value.target, versionKeys)
    && (value.phase === null || typeof value.phase === "string" && phases.includes(value.phase))
    && typeof value.result === "string" && ["unknown", "none", "same", "postponed", "revoked", "failure", "prepared", "healthy", "restored", "unavailable", "manual_required", "cancelled"].includes(value.result)
    && (value.failure === null || hasUpdateKeys(value.failure, ["requestId", "rootCause"])
      && typeof value.failure.requestId === "string" && updateStateRequestId.test(value.failure.requestId) && isUpdateCause(value.failure.rootCause));
}

/** 独立零参数查询；旧壳和坏响应显式失败，不旁路到通用请求或网络。 */
export async function getDesktopUpdateDetails(): Promise<DesktopUpdateDetails> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getUpdateDetails !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_DETAILS_UNAVAILABLE");
  const value = await bridge.getUpdateDetails();
  const bundleKeys = ["releaseId", "version", "webVersion", "clientVersion"];
  if (!isUpdateData(value) || !hasUpdateKeys(value, ["deviceId", "current", "bundle", "shell"])
    || typeof value.deviceId !== "string" || !updateIdentity.test(value.deviceId)
    || !hasUpdateKeys(value.current, ["shellVersion", "bundle", "clientVersion"])
    || ![value.current.shellVersion, value.current.clientVersion].every(version => version === null || isUpdateVersionText(version))
    || !isUpdateVersion(value.current.bundle, bundleKeys)
    || !isUpdateChannel(value.bundle, bundleKeys, ["discovery", "download", "prepare", "read-active", "verify", "compatibility", "prepare-directory", "drain", "restart-client", "reload-web", "health", "activate", "rollback"])
    || !isUpdateChannel(value.shell, ["shellId", "version"], ["prepare", "download", "install", "health", "handoff", "admission-intent", "recovery"])) {
    throw new DesktopUpdateServiceError("DESKTOP_UPDATE_DETAILS_INVALID");
  }
  return value as DesktopUpdateDetails;
}

/** 提醒只接受公开字段；null 表示当前没有待展示提醒。 */
function isUpdateNotice(value: unknown): value is DesktopUpdateNotice {
  return hasUpdateKeys(value, ["releaseId", "version", "currentVersion", "shellOnly"])
    && typeof value.releaseId === "string" && updateToken.test(value.releaseId)
    && typeof value.version === "string" && isUpdateVersionText(value.version)
    && (value.currentVersion === null || typeof value.currentVersion === "string" && isUpdateVersionText(value.currentVersion))
    && typeof value.shellOnly === "boolean";
}

/** 页面启动/刷新补查待展示提醒；旧壳缺能力时显式失败。 */
export async function getDesktopUpdateNotice(): Promise<DesktopUpdateNotice | null> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getUpdateNotice !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_NOTICE_UNAVAILABLE");
  const value = await bridge.getUpdateNotice();
  if (value === null) return null;
  if (!isUpdateData(value) || !isUpdateNotice(value)) throw new DesktopUpdateServiceError("DESKTOP_UPDATE_NOTICE_INVALID");
  return value;
}

/** 关闭提醒；宿主再次校验固定动作。 */
export async function dismissDesktopUpdateNotice(action: DesktopUpdateNoticeDismissAction): Promise<void> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.dismissUpdateNotice !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_NOTICE_DISMISS_UNAVAILABLE");
  await bridge.dismissUpdateNotice(action);
}

/** 订阅下载完成提醒；旧壳缺能力时只返回空清理函数。 */
export function subscribeDesktopUpdateNotice(listener: (notice: DesktopUpdateNotice) => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onUpdateNotice !== "function") return () => {};
  return bridge.onUpdateNotice(listener);
}

/** 订阅应用资源下载进度；旧壳缺能力时不启用，非法载荷显式丢弃并记录。 */
export function subscribeDesktopUpdateProgress(listener: (progress: DesktopUpdateProgress) => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onUpdateProgress !== "function") return () => {};
  return bridge.onUpdateProgress(progress => {
    if (!isUpdateProgress(progress)) {
      console.error("[desktop_update_progress_invalid]", {
        code: "DESKTOP_UPDATE_PROGRESS_INVALID",
        requestId: null,
        rootCause: "invalid progress payload",
      });
      void reportDesktopUpdateError({ phase: "download", code: "DESKTOP_UPDATE_PROGRESS_INVALID", message: "invalid progress payload" });
      return;
    }
    listener(progress);
  });
}

/** 高频进度/快照错误按固定窗口去重，避免轮询或坏载荷刷写耐久日志。 */
const reportedUpdateErrors = new Map<string, number>();
const UPDATE_ERROR_REPORT_INTERVAL_MS = 60_000;

/** 更新操作失败上报宿主失败日志；旧壳缺能力时保留控制台记录，不静默丢弃。 */
export async function reportDesktopUpdateError(input: DesktopUpdateClientErrorReport): Promise<void> {
  if (input.code === "DESKTOP_UPDATE_PROGRESS_INVALID" || input.code === "DESKTOP_UPDATE_CHECK_SNAPSHOT_FAILED") {
    const key = `${input.target ?? "bundle"}|${input.phase}|${input.code}`;
    const now = Date.now();
    if (now - (reportedUpdateErrors.get(key) ?? 0) < UPDATE_ERROR_REPORT_INTERVAL_MS) return;
    reportedUpdateErrors.set(key, now);
  }
  const bridge = getDesktopBridge();
  if (typeof bridge?.reportUpdateError !== "function") {
    console.error("[desktop_update_error_report_unavailable]", { code: input.code, phase: input.phase });
    return;
  }
  try { await bridge.reportUpdateError(input); }
  catch (cause) {
    console.error("[desktop_update_error_report_failed]", {
      code: input.code, phase: input.phase,
      rootCause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** 等待原检查入口；void 只代表该调用结算，不代表发现或安装更新。 */
export async function checkDesktopForUpdates(): Promise<void> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.checkForUpdates !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_CHECK_UNAVAILABLE");
  await bridge.checkForUpdates();
}

/** 用户选择重启后仅调用宿主固定入口；旧壳或宿主失败均显式交给展示边界。 */
export async function restartDesktopForUpdate(): Promise<void> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.restartForUpdate !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_RESTART_UNAVAILABLE");
  await bridge.restartForUpdate();
}

/** 订阅托盘「检查更新」请求；旧壳缺能力时只返回空清理函数。 */
export function subscribeDesktopUpdateCheckRequested(listener: () => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onUpdateCheckRequested !== "function") return () => {};
  return bridge.onUpdateCheckRequested(listener);
}

/** 取走尚未消费的托盘检查请求；旧壳返回 false。 */
export async function takeDesktopUpdateCheckRequest(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.takeUpdateCheckRequest !== "function") return false;
  return await bridge.takeUpdateCheckRequest();
}

/** 订阅托盘「意见反馈」请求；旧壳缺能力时只返回空清理函数。 */
export function subscribeDesktopFeedbackRequested(listener: () => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onFeedbackRequested !== "function") return () => {};
  return bridge.onFeedbackRequested(listener);
}

/** 取走尚未消费的托盘反馈请求；旧壳返回 false。 */
export async function takeDesktopFeedbackRequest(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.takeFeedbackRequest !== "function") return false;
  return await bridge.takeFeedbackRequest();
}

/** 历史只按需读取；校验公开结构，不复制 Node 侧摘要或错误投影器。 */
export async function getDesktopUpdateDiagnostics(): Promise<DesktopUpdateDiagnostics> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getUpdateDiagnostics !== "function") throw new DesktopUpdateServiceError("DESKTOP_UPDATE_DIAGNOSTICS_UNAVAILABLE");
  const value = await bridge.getUpdateDiagnostics();
  if (!isUpdateData(value) || !hasUpdateKeys(value, ["deviceId", "failures"])
    || typeof value.deviceId !== "string" || !updateIdentity.test(value.deviceId) || !Array.isArray(value.failures)
    || !value.failures.every(item => {
      if (!hasUpdateKeys(item, ["record", "reported"]) || typeof item.reported !== "boolean") return false;
      const record = item.record as Record<string, unknown>;
      const shell = record?.errorCode === "DESKTOP_SHELL_UPDATE_FAILED";
      const keys = ["schemaVersion", "kind", "deviceId", "shellVersion", "currentReleaseId", "webVersion", "clientVersion", "errorId", "at", "errorCode",
        "requestId", shell ? "shellId" : "releaseId", "phase", "recovery", "rootCause", "rollbackError", "payloadSha256"];
      return hasUpdateKeys(record, keys) && record.schemaVersion === 1 && record.kind === "failure" && record.deviceId === value.deviceId
        && typeof record.errorId === "string" && updateIdentity.test(record.errorId)
        && (shell || record.errorCode === "DESKTOP_RELEASE_FAILED")
        && ["shellVersion", "currentReleaseId", "webVersion", "clientVersion", "requestId", shell ? "shellId" : "releaseId"].every(key =>
          shell && key === "shellId" && record[key] === null || typeof record[key] === "string" && updateToken.test(record[key]))
        && typeof record.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.at) && Number.isFinite(Date.parse(record.at))
        && typeof record.phase === "string" && /^[a-z][a-z-]{0,63}$/u.test(record.phase)
        && typeof record.recovery === "string" && ["not_needed", "restored", "failed"].includes(record.recovery) && isUpdateCause(record.rootCause)
        && (record.rollbackError === null || isUpdateCause(record.rollbackError))
        && typeof record.payloadSha256 === "string" && /^[a-f0-9]{64}$/u.test(record.payloadSha256);
    })) throw new DesktopUpdateServiceError("DESKTOP_UPDATE_DIAGNOSTICS_INVALID");
  return value as DesktopUpdateDiagnostics;
}

/** JSON 快照隔离 reactive 草稿；不可序列化数据在派发前失败，缺桥不回落云端。 */
export async function requestDesktopApi<T extends object>(request: DesktopApiRequest): Promise<ApiResult<T>> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("DESKTOP_BRIDGE_REQUIRED");
  const snapshot = JSON.parse(JSON.stringify(request)) as DesktopApiRequest;
  const response = await bridge.request(snapshot);
  const body = response.body as ApiResult<T> | null;
  if (!body || typeof body !== "object" || typeof body.ok !== "boolean"
    || (body.ok && response.status >= 400)
    || (!body.ok && (typeof body.code !== "string" || typeof body.message !== "string"))) {
    throw new Error("DESKTOP_API_RESPONSE_INVALID");
  }
  return body;
}

/** 新 Web 明确要求壳具备事件桥；旧壳不伪装为可实时使用。 */
export function subscribeDesktopEvents(listener: (event: DesktopEvent) => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onEvent !== "function") throw new Error("DESKTOP_EVENT_BRIDGE_REQUIRED");
  return bridge.onEvent(listener);
}

/** 本机范围以实际运行时清单为准，不使用裸 ID 或共享工作区别名推断。 */
export function isDesktopWorkspace(config: { localRuntimeReady: boolean; desktopClient: { clientId: string; workspaceIds: string[] } | null }, workspaceId: string): boolean {
  return config.localRuntimeReady && Boolean(config.desktopClient?.workspaceIds.includes(workspaceId))
    && !isSharedWorkspaceSelectionId(workspaceId) && workspaceId.startsWith(`${config.desktopClient!.clientId}:`);
}

/** 本机终端按实际归属选路，账号关联不改变本机控制资格。 */
export function isLocalDesktopTerminalMode(config: {
  isDesktop: boolean;
  desktopCloudAccountLinked: boolean;
} & Parameters<typeof isDesktopWorkspace>[0], workspaceId: string): boolean {
  return config.isDesktop && isDesktopWorkspace(config, workspaceId);
}

/** 本机资产、Skill 和 MCP 请求复用 Client 入口；共享和其他机器继续走 Server。 */
export function resolveDesktopApiRequest(input: { method: string; path: string; body?: unknown }, localClientId?: string | null): DesktopApiRequest | null {
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
  const clientId = String(body.clientId ?? "").trim();
  const workspaceId = String(body.workspaceId ?? "").trim();
  if ((clientId && clientId !== localClientId) || isRemoteWorkspace(workspaceId, localClientId)) return null;
  const pathname = input.path.split("?")[0];
  const { clientId: _targetClient, ...localBody } = body;
  const customModels = /^\/api\/engine-keys\/models(?:\/(delete))?$/u.exec(pathname);
  if (customModels && ((input.method === "GET" && !customModels[1]) || input.method === "POST")) {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const target = String(query.workspaceId ?? "");
    if (!localClientId || !target.startsWith(`${localClientId}:`) || isRemoteWorkspace(target, localClientId)) return null;
    return { method: input.method === "GET" ? "engineCustomModels.list" : customModels[1] ? "engineCustomModels.delete" : "engineCustomModels.upsert",
      body: { ...localBody, workspaceId: target } };
  }
  if (input.method === "GET" && pathname === "/api/orch/builtin-assets" && localClientId) {
    return { method: "runtime.builtinAssets.list", body: Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? "")) };
  }
  const skillMcpMethods = {
    "/api/skills/suites": "skills.suites", "/api/skills/install": "skills.install", "/api/skills/uninstall": "skills.uninstall",
    "/api/mcp/install": "mcp.install", "/api/mcp/enable": "mcp.enable", "/api/mcp/update": "mcp.update",
    "/api/mcp/test": "mcp.test", "/api/mcp/import": "mcp.import", "/api/mcp/uninstall": "mcp.uninstall",
    "/api/mcp/configure": "mcp.configure", "/api/mcp/unconfigure": "mcp.unconfigure",
    "/api/orch/skills/install-status": "orch.skills.installStatus",
    "/api/orch/skills/install": "orch.skills.install", "/api/orch/skills/uninstall": "orch.skills.uninstall",
  } as const;
  if (Object.prototype.hasOwnProperty.call(skillMcpMethods, pathname)) {
    const method = skillMcpMethods[pathname as keyof typeof skillMcpMethods];
    if (input.method !== (method === "skills.suites" || method === "orch.skills.installStatus" ? "GET" : "POST")) return null;
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const target = String(body.workspaceId ?? query.workspaceId ?? "").trim();
    if (!target || isRemoteWorkspace(target, localClientId) || query.workspaceId && query.workspaceId !== target) return null;
    return { method, body: { ...localBody, ...query, workspaceId: target,
      ...(method === "skills.suites" ? { includeMcpStatus: query.includeMcpStatus === "true" } : {}) } };
  }
  const engineKeys = /^\/api\/engine-keys(?:\/(delete|activate|deactivate|test))?$/u.exec(pathname);
  if (engineKeys && ((input.method === "GET" && !engineKeys[1]) || input.method === "POST")) {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    if (!localClientId || !query.workspaceId?.startsWith(`${localClientId}:`) || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
    return { method: `engineKeys.${input.method === "GET" ? "list" : engineKeys[1] ?? "upsert"}` as DesktopApiRequest["method"],
      body: { ...localBody, ...query } };
  }
  if (input.method === "POST" && (pathname === "/api/software/update-status" || pathname === "/api/software/npm-install")) {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const target = String(query.workspaceId ?? "").trim();
    // CLI 安装属于本机 Client 全局能力；无工作区或失效工作区仍走本机，远程/共享工作区保留 Server 路由。
    if (!localClientId || target && (!target.startsWith(`${localClientId}:`) || isRemoteWorkspace(target, localClientId))) return null;
    return { method: pathname === "/api/software/update-status" ? "software.update.status" : "software.npm.install", body: localBody };
  }
  if ((input.method === "GET" || input.method === "POST") && pathname === "/api/codeflowai/config") {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const target = input.method === "GET" ? String(query.workspaceId ?? "").trim() : workspaceId;
    if (!localClientId || !target.startsWith(`${localClientId}:`) || isRemoteWorkspace(target, localClientId)) return null;
    return { method: input.method === "GET" ? "codeflowai.config.get" : "codeflowai.config.set",
      body: { ...localBody, workspaceId: target } };
  }
  if (input.method === "GET" && pathname === "/api/engines/status") {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    if (!localClientId || !query.workspaceId?.startsWith(`${localClientId}:`) || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
    return { method: "engines.status", body: query };
  }
  const groupsPath = /^\/api\/orch\/asset-groups(?:\/(create|rename|delete|assign))?$/u.exec(pathname);
  if (groupsPath) {
    if (input.method === "GET" && !groupsPath[1]) {
      const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
      if (!query.workspaceId || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
      return { method: "orch.assetGroups.list", body: query };
    }
    if (input.method === "POST" && groupsPath[1]) return { method: `orch.assetGroups.${groupsPath[1]}` as DesktopApiRequest["method"], body: localBody };
  }
  const assetPath = /^\/api\/orch\/(roles|workflows|knowledge-bundles|toolsets|skills)(?:\/(upsert|delete))?$/u.exec(pathname);
  if (assetPath) {
    const collection = assetPath[1] === "knowledge-bundles" ? "knowledgeBundles" : assetPath[1];
    if (input.method === "GET" && !assetPath[2]) {
      const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
      if (!query.workspaceId || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
      // purpose 仅选择 Server 读取来源；本机列表沿固定 workspaceId 合同派发。
      if ((collection === "roles" || collection === "workflows") && query.purpose === "execution") delete query.purpose;
      return { method: `orch.${collection}.list` as DesktopApiRequest["method"], body: query };
    }
    if (input.method === "POST" && assetPath[2]) {
      // Server 修订元数据由旧 store 生成；本机定义沿 SQLite 原入口保存，不伪造 Server 修订。
      const { clientRequestId: _requestId, expectedRevision: _revision, ...definitionBody } = localBody;
      return { method: `orch.${collection}.${assetPath[2]}` as DesktopApiRequest["method"], body: definitionBody };
    }
  }
  if (input.method === "POST" && pathname === "/api/orch/assets/copy") return { method: "orch.assets.copy", body: localBody };
  const orchestrationReads = {
    "/api/orch/intakes": "orch.intakes.list", "/api/orch/proposals": "orch.proposals.list", "/api/orch/instances": "orch.instances.list",
    "/api/orch/requirement-analysis/sessions": "orch.requirementAnalysis.sessions.list",
    "/api/orch/workflow-execution-default": "orch.workflowExecutionDefaults.get",
    "/api/orch/pending-mine": "orch.pendingMine.list",
  } as const;
  if (input.method === "GET" && Object.prototype.hasOwnProperty.call(orchestrationReads, pathname)) {
    const query: Record<string, unknown> = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    if (typeof query.workspaceId !== "string" || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
    if (query.limit !== undefined) query.limit = Number(query.limit);
    for (const key of ["onlyRelatedToMe", "summaryOnly"]) if (query[key] !== undefined) query[key] = query[key] === "true";
    if (typeof query.statuses === "string") query.statuses = query.statuses.split(",").filter(Boolean);
    return { method: orchestrationReads[pathname as keyof typeof orchestrationReads], body: query };
  }
  const orchestrationWrites = {
    "asset-drafts/generate": "assetDrafts.generate", "asset-drafts/get": "assetDrafts.get",
    "asset-drafts/apply": "assetDrafts.apply", "asset-drafts/reject": "assetDrafts.reject",
    "asset-drafts/jobs/list": "assetDraftJobs.list", "asset-drafts/jobs/get": "assetDraftJobs.get",
    "asset-drafts/jobs/delete": "assetDraftJobs.delete", "asset-drafts/jobs/resume": "assetDraftJobs.resume",
    "requirement-analysis/sessions/create": "requirementAnalysis.sessions.create", "requirement-analysis/sessions/get": "requirementAnalysis.sessions.get",
    "requirement-analysis/create-intakes": "requirementAnalysis.createIntakes",
    "intakes/create": "intakes.create", "intakes/upsert": "intakes.upsert", "intakes/delete": "intakes.delete",
    "proposals/get": "proposals.get", "proposals/create": "proposals.create", "proposals/confirm": "proposals.confirm",
    "instances/get": "instances.get", "instances/runtime-patch": "instances.runtimePatch", "instances/start": "instances.start",
    "instances/pause": "instances.pause", "instances/resume": "instances.resume", "instances/cancel": "instances.cancel",
    "instances/feedback": "instances.feedback", "instances/rerun-from-node": "instances.rerunFromNode",
    "nodes/start": "nodes.start", "nodes/skip": "nodes.skip", "nodes/cancel": "nodes.cancel",
    "artifacts/list": "artifacts.list", "artifacts/get": "artifacts.get", "artifacts/revise": "artifacts.revise", "artifact-files/list": "artifactFiles.list",
    "events/list": "events.list", "prompt-snapshots/list": "promptSnapshots.list", "prompt-snapshots/get": "promptSnapshots.get",
    "node-work-items/list": "nodeWorkItems.list", "node-work-item-events/list": "nodeWorkItemEvents.list",
    "workflow-execution-default/upsert": "workflowExecutionDefaults.upsert", "workflow-execution-default/delete": "workflowExecutionDefaults.delete",
    "asset-bundles/export": "assetBundles.export", "asset-bundles/import": "assetBundles.import",
    "runtime-evidence/get": "runtimeEvidence.get",
  } as const;
  const orchestrationAction = pathname.startsWith("/api/orch/") ? pathname.slice("/api/orch/".length) : "";
  if (input.method === "POST" && Object.prototype.hasOwnProperty.call(orchestrationWrites, orchestrationAction)) {
    return { method: `orch.${orchestrationWrites[orchestrationAction as keyof typeof orchestrationWrites]}`, body: localBody };
  }
  if (input.method === "GET" && (pathname === "/api/threads" || pathname === "/api/threads/groups")) {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const target = String(query.workspaceId ?? "").trim();
    if (!target || isRemoteWorkspace(target, localClientId)) return null;
    const queryBody: Record<string, unknown> = { ...query };
    if (query.limit !== undefined) queryBody.limit = Number(query.limit);
    if (query.onlyRelatedToMe !== undefined) queryBody.onlyRelatedToMe = query.onlyRelatedToMe === "true";
    return { method: pathname === "/api/threads" ? "threads.list" : "threads.groups.list", body: queryBody };
  }
  const threadExtraMethods = {
    "/api/threads/groups/create": "threads.groups.create", "/api/threads/groups/rename": "threads.groups.rename",
    "/api/threads/groups/delete": "threads.groups.delete", "/api/threads/group-assign": "threads.group.assign",
    "/api/threads/pin": "threads.pin", "/api/threads/clear": "threads.clear", "/api/threads/compact": "threads.compact",
    "/api/threads/restart-codex-app-server": "threads.restartCodexAppServer",
    "/api/threads/managed-services/list": "threads.managedServices.list",
    "/api/threads/managed-services/stop": "threads.managedServices.stop",
    "/api/threads/input-actions/list": "threads.inputActions.list",
    "/api/threads/file-changes/list": "threads.fileChanges.list", "/api/threads/file-changes/diff": "threads.fileChanges.diff",
    "/api/threads/file-changes/accept": "threads.fileChanges.accept", "/api/threads/file-changes/undo": "threads.fileChanges.undo",
    "/api/threads/rollback": "threads.rollback", "/api/threads/rollback/preview": "threads.rollback.preview",
    "/api/threads/messages/delete": "threads.messages.delete",
    "/api/orch/chat/get": "orch.chat.get", "/api/orch/chat/settings": "orch.chat.settings",
    "/api/orch/chat/action": "orch.chat.action", "/api/orch/chat/natural": "orch.chat.natural",
    "/api/orch/chat/rework": "orch.chat.rework", "/api/orch/chat/delete": "orch.chat.delete",
  } as const;
  if (input.method === "POST" && Object.prototype.hasOwnProperty.call(threadExtraMethods, pathname)) {
    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
    return { method: threadExtraMethods[pathname as keyof typeof threadExtraMethods], body: localBody };
  }
  const threadReads = {
    "/api/threads/create": "threads.create", "/api/threads/send": "threads.sendMessage", "/api/threads/update-prefs": "threads.updatePrefs",
    "/api/threads/rename": "threads.rename", "/api/threads/archive": "threads.archive", "/api/threads/delete": "threads.delete",
    "/api/approvals/respond": "approvals.respond", "/api/user-input/respond": "userInput.respond",
    "/api/fs/readFile": "fs.readFile", "/api/fs/spreadsheetPreview": "fs.spreadsheetPreview", "/api/fs/documentPreview": "fs.documentPreview",
    "/api/fs/extractAttachment": "fs.extractAttachment",
    "/api/git/status": "git.status", "/api/git/diff": "git.diff", "/api/git/diffFiles": "git.diffFiles",
    "/api/threads/draft/get": "threads.draft.get", "/api/threads/draft/save": "threads.draft.save", "/api/threads/draft/clear": "threads.draft.clear",
    "/api/threads/queue/append": "threads.queue.append", "/api/threads/queue/list": "threads.queue.list",
    "/api/threads/queue/move": "threads.queue.move", "/api/threads/queue/remove": "threads.queue.remove",
    "/api/threads/queue/clear": "threads.queue.clear", "/api/threads/queue/resume": "threads.queue.resume", "/api/threads/queue/pause": "threads.queue.pause",
    "/api/turns/interrupt": "turns.interrupt",
    "/api/threads/load": "threads.load", "/api/threads/events": "threads.events", "/api/threads/summary": "threads.summary",
    "/api/threads/presentation": "threads.presentation", "/api/threads/process": "threads.process",
    "/api/threads/prefs": "threads.prefs", "/api/threads/latest-prefs": "threads.latestPrefs",
  } as const;
  if (input.method === "POST" && Object.prototype.hasOwnProperty.call(threadReads, pathname)) {
    return { method: threadReads[pathname as keyof typeof threadReads], body: localBody };
  }
  const knowledgeAsset = /^\/api\/knowledge\/assets\/([^/]+)$/u.exec(pathname);
  if (knowledgeAsset) {
    const action = decodeURIComponent(knowledgeAsset[1]!);
    if (input.method === "GET") {
      const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
      if (!query.workspaceId || isRemoteWorkspace(query.workspaceId, localClientId)) return null;
      return { method: `knowledge.assets.${action}` as DesktopApiRequest["method"], body: query };
    }
    if (input.method === "POST") {
      const workspaceId = String(body.workspaceId ?? "").trim();
      if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
      return { method: `knowledge.assets.${action}` as DesktopApiRequest["method"], body: localBody };
    }
    return null;
  }
  const fsExtraMethods = {
    "/api/fs/tree": "fs.tree", "/api/fs/search": "fs.search", "/api/fs/reindex": "fs.reindex",
    "/api/fs/stat": "fs.stat", "/api/fs/downloadFile": "fs.downloadFile", "/api/fs/writeFile": "fs.writeFile",
    "/api/fs/uploadBegin": "fs.uploadBegin", "/api/fs/uploadChunk": "fs.uploadChunk",
    "/api/fs/uploadComplete": "fs.uploadComplete", "/api/fs/uploadCancel": "fs.uploadCancel",
  } as const;
  if (input.method === "POST" && Object.prototype.hasOwnProperty.call(fsExtraMethods, pathname)) {
    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
    return { method: fsExtraMethods[pathname as keyof typeof fsExtraMethods], body: localBody };
  }
  const gitExtraMethods = {
    "/api/git/stage": "git.stage", "/api/git/unstage": "git.unstage", "/api/git/discard": "git.discard",
    "/api/git/commit": "git.commit", "/api/git/log": "git.log", "/api/git/show": "git.show",
    "/api/git/showFileDiff": "git.showFileDiff", "/api/git/branch/list": "git.branch.list",
    "/api/git/branch/create": "git.branch.create", "/api/git/branch/switch": "git.branch.switch",
    "/api/git/branch/delete": "git.branch.delete",
  } as const;
  if (input.method === "POST" && Object.prototype.hasOwnProperty.call(gitExtraMethods, pathname)) {
    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
    return { method: gitExtraMethods[pathname as keyof typeof gitExtraMethods], body: localBody };
  }
  const terminalPath = /^\/api\/terminal\/(shells|actions)$/u.exec(pathname);
  if (terminalPath) {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const workspaceId = String(input.method === "POST" ? body.workspaceId ?? "" : query.workspaceId ?? "").trim();
    if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
    if (input.method === "GET") {
      return { method: terminalPath[1] === "shells" ? "terminal.shells.list" : "terminal.actions.list", body: query };
    }
    if (input.method === "POST" && terminalPath[1] === "actions") return { method: "terminal.actions.save", body: localBody };
    return null;
  }
  const reminderPath = /^\/api\/reminders\/(workspaces|items|mark-read|ignore)$/u.exec(pathname);
  if (reminderPath) {
    const action = reminderPath[1]!;
    if (input.method === "GET" && action === "workspaces") return { method: "reminders.workspaceSummaries", body: {} };
    if (input.method === "POST" && action !== "workspaces") {
      const workspaceId = String(body.workspaceId ?? "").trim();
      if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
      return { method: action === "items" ? "reminders.items" : action === "mark-read" ? "reminders.markRead" : "reminders.ignore", body: localBody };
    }
    return null;
  }
  if (pathname === "/api/workspaces/prefs") {
    const query = Object.fromEntries(new URLSearchParams(input.path.split("?")[1] ?? ""));
    const workspaceId = String(input.method === "POST" ? body.workspaceId ?? "" : query.workspaceId ?? "").trim();
    if (!workspaceId || isRemoteWorkspace(workspaceId, localClientId)) return null;
    return { method: input.method === "GET" ? "workspacePrefs.get" : "workspacePrefs.save", body: input.method === "POST" ? localBody : { workspaceId } };
  }
  if (input.method === "GET" && pathname === "/api/workspaces") return { method: "workspaces.list" };
  if (input.method === "POST" && pathname === "/api/workspaces/upsert") return { method: "workspaces.upsert", body: localBody };
  if (input.method === "POST" && pathname === "/api/workspaces/delete") return { method: "workspaces.delete", body: localBody };
  if (input.method === "POST" && pathname === "/api/client-fs/directory-tree") return { method: "clientFs.directoryTree", body: localBody };
  const profile = /^\/api\/workspaces\/([^/]+)\/(me\/execution-profile|execution-profile-status)$/u.exec(pathname);
  if (!profile) return null;
  const profileWorkspaceId = decodeURIComponent(profile[1]!);
  if (isRemoteWorkspace(profileWorkspaceId, localClientId)) return null;
  if (profile[2] === "me/execution-profile" && (input.method === "GET" || input.method === "POST")) {
    return { method: input.method === "GET" ? "workspaceExecutionProfile.get" : "workspaceExecutionProfile.update",
      body: { ...body, workspaceId: profileWorkspaceId } };
  }
  if (profile[2] === "execution-profile-status" && input.method === "GET") {
    return { method: "workspaceExecutionProfile.status", body: { workspaceId: profileWorkspaceId } };
  }
  return null;
}

/** 已命名空间化的工作区必须属于当前本机，不能用尾部别名跨机器匹配。 */
function isRemoteWorkspace(workspaceId: string, localClientId?: string | null): boolean {
  return isSharedWorkspaceSelectionId(workspaceId)
    || Boolean(workspaceId.includes(":") && (!localClientId || !workspaceId.startsWith(`${localClientId}:`)));
}
