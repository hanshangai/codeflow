import type { DesktopApiRequest, DesktopApiResponse, DesktopEvent, DesktopWindowControls, DesktopUpdateDiagnostics, DesktopUpdateState, DesktopUpdateDetails, DesktopUpdateNotice, DesktopUpdateNoticeDismissAction, DesktopUpdateProgress, DesktopUpdateClientErrorReport, DesktopMigrationState, DesktopMigrationAccount } from "@codeflowai/shared";
import type { DesktopBridgeApi, DesktopRuntimeState } from "./contracts.js";

export type DesktopBridgeDeps = {
  getState: () => DesktopRuntimeState | Promise<DesktopRuntimeState>;
  getMigrationState?: () => Promise<DesktopMigrationState>;
  startMigration?: (candidateId: string) => Promise<void>;
  deferMigration?: () => Promise<void>;
  retryMigrationAccount?: () => Promise<void>;
  takeMigrationAccount?: () => Promise<DesktopMigrationAccount | null>;
  acknowledgeMigrationAccount?: () => Promise<void>;
  cancelMigrationAccount?: () => Promise<void>;
  onMigrationState?: (listener: (state: DesktopMigrationState) => void) => () => void;
  /** 可选固定无参诊断，身份由主进程确定。 */
  getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics>;
  /** 可选更新事实与原检查动作，均不接收页面参数。 */
  getUpdateState?: () => Promise<DesktopUpdateState>;
  /** 新详细能力独立可选，不能改变旧状态形状。 */
  getUpdateDetails?: () => Promise<DesktopUpdateDetails>;
  getUpdateNotice?: () => Promise<DesktopUpdateNotice | null>;
  dismissUpdateNotice?: (action: DesktopUpdateNoticeDismissAction) => Promise<void>;
  /** 下载完成提醒推送；页面关闭/刷新后由 getUpdateNotice 补查。 */
  onUpdateNotice?: (listener: (notice: DesktopUpdateNotice) => void) => () => void;
  /** 下载进度推送；独立于更新详情契约，旧页面不订阅时零影响。 */
  onUpdateProgress?: (listener: (progress: DesktopUpdateProgress) => void) => () => void;
  /** 页面侧更新错误上报；只接受固定阶段与去敏错误码。 */
  reportUpdateError?: (input: DesktopUpdateClientErrorReport) => Promise<void>;
  /** 退出确认请求与结果回传；页面未订阅时主进程回退系统框。 */
  onQuitConfirmRequested?: (listener: () => void) => () => void;
  respondQuitConfirm?: (confirmed: boolean) => Promise<void>;
  checkForUpdates?: () => Promise<void>;
  restartForUpdate?: () => Promise<void>;
  /** 托盘「检查更新」请求；只透传固定事件。 */
  onUpdateCheckRequested?: (listener: () => void) => () => void;
  onFeedbackRequested?: (listener: () => void) => () => void;
  /** 取走尚未消费的托盘检查请求，用于页面晚于事件挂载时补发。 */
  takeUpdateCheckRequest?: () => Promise<boolean>;
  takeFeedbackRequest?: () => Promise<boolean>;
  /** 固定的本机目录选择能力，不接受窗口或对话框配置。 */
  selectDirectory?: (initialPath?: string) => Promise<string | null>;
  openWindow: () => void | Promise<void>;
  exit: () => void | Promise<void>;
  platform?: "win32" | "darwin" | "linux";
  request: (request: DesktopApiRequest) => Promise<DesktopApiResponse>;
  onEvent: (listener: (event: DesktopEvent) => void) => () => void;
  /** 无边框壳提供窗口控制；旧壳缺省时 Web 不渲染控制按钮。 */
  windowControls?: DesktopWindowControls;
};

export type ContextBridgeLike = {
  exposeInMainWorld(name: string, api: DesktopBridgeApi): void;
};

/** 创建受限桌面操作桥接，业务请求仍由 Client 白名单校验。 */
export function createDesktopBridge(deps: DesktopBridgeDeps): DesktopBridgeApi {
  return Object.freeze({
    async getState(): Promise<DesktopRuntimeState> {
      return { ...(await deps.getState()) };
    },
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.getMigrationState ? {
      getMigrationState: async () => structuredClone(await deps.getMigrationState!()),
      startMigration: async (candidateId: string) => { await deps.startMigration!(candidateId); },
      deferMigration: async () => { await deps.deferMigration!(); },
      retryMigrationAccount: async () => { await deps.retryMigrationAccount!(); },
      takeMigrationAccount: async () => structuredClone(await deps.takeMigrationAccount!()),
      acknowledgeMigrationAccount: async () => { await deps.acknowledgeMigrationAccount!(); },
      cancelMigrationAccount: async () => { await deps.cancelMigrationAccount!(); },
      onMigrationState: (listener: (state: DesktopMigrationState) => void) => deps.onMigrationState!(listener),
    } : {}),
    ...(deps.getUpdateDiagnostics ? {
      /** 深复制脱敏快照，不向页面交出宿主引用。 */
      getUpdateDiagnostics: async (): Promise<DesktopUpdateDiagnostics> => structuredClone(await deps.getUpdateDiagnostics!()),
    } : {}),
    ...(deps.getUpdateState ? {
      /** 深复制即时事实，不把宿主故障对象引用交给页面。 */
      getUpdateState: async (): Promise<DesktopUpdateState> => structuredClone(await deps.getUpdateState!()),
    } : {}),
    ...(deps.getUpdateDetails ? {
      /** 复制安全版本和阶段观察，不共享宿主嵌套引用。 */
      getUpdateDetails: async (): Promise<DesktopUpdateDetails> => structuredClone(await deps.getUpdateDetails!()),
    } : {}),
    ...(deps.getUpdateNotice ? {
      /** 复制提醒快照，不向页面交出宿主引用。 */
      getUpdateNotice: async (): Promise<DesktopUpdateNotice | null> => {
        const notice = await deps.getUpdateNotice!();
        return notice ? structuredClone(notice) : null;
      },
    } : {}),
    ...(deps.dismissUpdateNotice ? {
      /** 固定动作由宿主再次校验；页面不能扩展关闭语义。 */
      dismissUpdateNotice: async (action: DesktopUpdateNoticeDismissAction): Promise<void> => { await deps.dismissUpdateNotice!(action); },
    } : {}),
    ...(deps.onUpdateNotice ? {
      /** 只透传固定提醒事件，不暴露 Electron 频道或参数。 */
      onUpdateNotice: (listener: (notice: DesktopUpdateNotice) => void): (() => void) => deps.onUpdateNotice!(listener),
    } : {}),
    ...(deps.onUpdateProgress ? {
      /** 只透传下载进度，不暴露 Electron 频道或参数。 */
      onUpdateProgress: (listener: (progress: DesktopUpdateProgress) => void): (() => void) => deps.onUpdateProgress!(listener),
    } : {}),
    ...(deps.reportUpdateError ? {
      /** 页面错误在宿主再次校验，并写入原更新失败日志。 */
      reportUpdateError: async (input: DesktopUpdateClientErrorReport): Promise<void> => { await deps.reportUpdateError!(input); },
    } : {}),
    ...(deps.onQuitConfirmRequested ? {
      /** 固定无参事件只表示宿主请求确认，不暴露 Electron 频道或参数。 */
      onQuitConfirmRequested: (listener: () => void): (() => void) => deps.onQuitConfirmRequested!(listener),
    } : {}),
    ...(deps.respondQuitConfirm ? {
      /** 固定布尔结果由宿主再次校验，页面不能扩展退出语义。 */
      respondQuitConfirm: async (confirmed: boolean): Promise<void> => { await deps.respondQuitConfirm!(confirmed); },
    } : {}),
    ...(deps.checkForUpdates ? {
      /** 固定无参且丢弃结果，防止完整资源清单或路径越界。 */
      checkForUpdates: async (): Promise<void> => { await deps.checkForUpdates!(); },
    } : {}),
    ...(deps.restartForUpdate ? {
      /** 固定无参入口只进入正常退出与重启，不接受资源或路径。 */
      restartForUpdate: async (): Promise<void> => { await deps.restartForUpdate!(); },
    } : {}),
    ...(deps.onUpdateCheckRequested ? {
      /** 只透传固定请求事件，不向页面暴露 Electron 频道或参数。 */
      onUpdateCheckRequested: (listener: () => void): (() => void) => deps.onUpdateCheckRequested!(listener),
    } : {}),
    ...(deps.takeUpdateCheckRequest ? {
      /** 一次性消费托盘请求，避免页面晚挂载时丢失检查。 */
      takeUpdateCheckRequest: async (): Promise<boolean> => await deps.takeUpdateCheckRequest!(),
    } : {}),
    ...(deps.onFeedbackRequested ? {
      onFeedbackRequested: (listener: () => void): (() => void) => deps.onFeedbackRequested!(listener),
    } : {}),
    ...(deps.takeFeedbackRequest ? {
      takeFeedbackRequest: async (): Promise<boolean> => await deps.takeFeedbackRequest!(),
    } : {}),
    ...(deps.selectDirectory ? {
      /** 只传初始目录；取消和失败保留宿主语义。 */
      selectDirectory: async (initialPath?: string): Promise<string | null> => await deps.selectDirectory!(initialPath),
    } : {}),
    /** 只透传统一请求契约，不提供底层 IPC 或 Server 身份字段入口。 */
    async request(request: DesktopApiRequest): Promise<DesktopApiResponse> {
      return await deps.request(request);
    },
    /** 订阅受限业务事件，不向页面暴露 Electron 事件或频道参数。 */
    onEvent(listener: (event: DesktopEvent) => void): () => void {
      return deps.onEvent(listener);
    },
    async openWindow(): Promise<void> {
      await deps.openWindow();
    },
    async exit(): Promise<void> {
      await deps.exit();
    },
    ...(deps.windowControls ? {
      windowControls: Object.freeze({
        minimize: () => deps.windowControls!.minimize(),
        toggleMaximize: () => deps.windowControls!.toggleMaximize(),
        close: () => deps.windowControls!.close(),
        getState: () => deps.windowControls!.getState(),
        onStateChange: (listener: (state: { maximized: boolean }) => void) => deps.windowControls!.onStateChange(listener),
      }) as DesktopWindowControls,
    } : {}),
  });
}

type FixedChannelIpc<T> = {
  on(channel: string, listener: (event: unknown, payload: T) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: T) => void): unknown;
};

/** 固定频道只透传 payload，注销必须移除完全相同的底层监听器。 */
export function subscribeFixedChannel<T>(ipc: FixedChannelIpc<T>, channel: string, listener: (payload: T) => void): () => void {
  const receive = (_event: unknown, payload: T): void => listener(payload);
  ipc.on(channel, receive);
  return () => { ipc.removeListener(channel, receive); };
}

/** 业务事件订阅固定使用 desktop:event 频道。 */
export function subscribeDesktopEvents(ipc: FixedChannelIpc<DesktopEvent>, listener: (event: DesktopEvent) => void): () => void {
  return subscribeFixedChannel(ipc, "desktop:event", listener);
}

/** 将受限桥接安装到页面唯一的全局入口。 */
export function exposeDesktopBridge(contextBridge: ContextBridgeLike, deps: DesktopBridgeDeps): void {
  contextBridge.exposeInMainWorld("codeflowDesktop", createDesktopBridge(deps));
}
