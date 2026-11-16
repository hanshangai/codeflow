export type SoftwareUpdateScope = {
  connected: boolean;
  isDesktop: boolean;
  localRuntimeReady: boolean;
  workspaceId: string;
  workspaceIsLocal?: boolean;
};

/** 桌面本机 Client 的 CLI 能力是全局的；未连接 Server 时不要求工作区或登录。 */
export function canLoadSoftwareUpdateStatus(scope: SoftwareUpdateScope): boolean {
  return scope.connected || scope.isDesktop && scope.localRuntimeReady;
}

/** 本机模式保留选中的本地工作区，失效或远程工作区回退为空，避免请求被送回 Server 鉴权。 */
export function resolveSoftwareUpdateWorkspaceId(scope: SoftwareUpdateScope): string {
  const workspaceId = String(scope.workspaceId ?? "").trim();
  if (scope.connected) return workspaceId;
  if (!scope.isDesktop || !scope.localRuntimeReady) return workspaceId;
  return scope.workspaceIsLocal === true ? workspaceId : "";
}
