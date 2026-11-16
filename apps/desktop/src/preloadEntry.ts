import { contextBridge, ipcRenderer } from "electron";

import { exposeDesktopBridge, subscribeDesktopEvents, subscribeFixedChannel } from "./preload.js";

/** 声明或撤销页面的退出确认能力；失败只回退系统框，仍留下可检索原因。 */
function reportQuitConfirmReady(ready: boolean): void {
  void ipcRenderer.invoke(ready ? "desktop:quitConfirmReady" : "desktop:quitConfirmUnready").catch((error: unknown) => {
    console.warn(ready ? "[desktop_quit_confirm_ready_failed]" : "[desktop_quit_confirm_unready_failed]", {
      rootCause: error instanceof Error ? error.message : String(error),
    });
  });
}

exposeDesktopBridge(contextBridge, {
  platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
  getState: () => ipcRenderer.invoke("desktop:getState"),
  getMigrationState: () => ipcRenderer.invoke("desktop:getMigrationState"),
  startMigration: (candidateId) => ipcRenderer.invoke("desktop:startMigration", candidateId),
  deferMigration: () => ipcRenderer.invoke("desktop:deferMigration"),
  retryMigrationAccount: () => ipcRenderer.invoke("desktop:retryMigrationAccount"),
  takeMigrationAccount: () => ipcRenderer.invoke("desktop:takeMigrationAccount"),
  acknowledgeMigrationAccount: () => ipcRenderer.invoke("desktop:acknowledgeMigrationAccount"),
  cancelMigrationAccount: () => ipcRenderer.invoke("desktop:cancelMigrationAccount"),
  onMigrationState: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:migration-state", listener),
  getUpdateDiagnostics: () => ipcRenderer.invoke("desktop:getUpdateDiagnostics"),
  getUpdateState: () => ipcRenderer.invoke("desktop:getUpdateState"),
  getUpdateDetails: () => ipcRenderer.invoke("desktop:getUpdateDetails"),
  getUpdateNotice: () => ipcRenderer.invoke("desktop:getUpdateNotice"),
  dismissUpdateNotice: (action) => ipcRenderer.invoke("desktop:dismissUpdateNotice", action),
  onUpdateNotice: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:update-notice", listener),
  onUpdateProgress: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:update-progress", listener),
  reportUpdateError: (input) => ipcRenderer.invoke("desktop:reportUpdateError", input),
  /** 订阅即声明页面具备应用内确认能力；主进程据此决定是否回退系统框。 */
  onQuitConfirmRequested: (listener) => {
    reportQuitConfirmReady(true);
    const unsubscribe = subscribeFixedChannel(ipcRenderer, "desktop:quit-confirm-requested", listener);
    return () => { unsubscribe(); reportQuitConfirmReady(false); };
  },
  respondQuitConfirm: (confirmed) => ipcRenderer.invoke("desktop:respondQuitConfirm", confirmed),
  checkForUpdates: () => ipcRenderer.invoke("desktop:checkForUpdates"),
  restartForUpdate: () => ipcRenderer.invoke("desktop:restartForUpdate"),
  onUpdateCheckRequested: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:update-check-requested", listener),
  takeUpdateCheckRequest: () => ipcRenderer.invoke("desktop:takeUpdateCheckRequest"),
  onFeedbackRequested: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:feedback-requested", listener),
  takeFeedbackRequest: () => ipcRenderer.invoke("desktop:takeFeedbackRequest"),
  selectDirectory: (initialPath) => ipcRenderer.invoke("desktop:selectDirectory", initialPath),
  request: (request) => ipcRenderer.invoke("desktop:request", request),
  onEvent: (listener) => subscribeDesktopEvents(ipcRenderer, listener),
  openWindow: () => ipcRenderer.invoke("desktop:openWindow"),
  exit: () => ipcRenderer.invoke("desktop:exit"),
  windowControls: {
    minimize: () => ipcRenderer.invoke("desktop:windowControl.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop:windowControl.toggleMaximize"),
    close: () => ipcRenderer.invoke("desktop:windowControl.close"),
    getState: () => ipcRenderer.invoke("desktop:windowControl.state"),
    onStateChange: (listener) => subscribeFixedChannel(ipcRenderer, "desktop:window-state", listener),
  },
});
