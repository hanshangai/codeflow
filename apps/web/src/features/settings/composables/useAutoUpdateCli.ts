import { watch } from "vue";
import type { ApiRequestContext } from "../../../api/request";

import { getSoftwareUpdateStatus, npmInstall } from "../../../api/software";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { isCliAutoUpdateEnabled } from "../cliAutoUpdate";
import { isPrivateInstallMode } from "../softwareInstallPresentation";
import { resolveSoftwareUpdateWorkspaceId } from "../softwareUpdateScope";
import { isDesktopWorkspace } from "../../../services/desktop";
import { softwareUpdateSnapshots } from "../components/softwareUpdateCache";

let autoUpdateRunning = false;

/** 桌面启动后按设置后台检查并更新已安装 CLI；失败只记录明确原因，不阻塞主流程。 */
async function updateInstalledClis(ctx: ApiRequestContext, workspaceId: string): Promise<void> {
  if (autoUpdateRunning) return;
  autoUpdateRunning = true;
  try {
    const status = await getSoftwareUpdateStatus(ctx, { forceRefresh: true }, workspaceId);
    if (!status.ok) {
      console.error("[CLI_AUTO_UPDATE_STATUS_FAILED]", { code: "CLI_AUTO_UPDATE_STATUS_FAILED", workspaceId, rootCause: status.message });
      return;
    }
    if (!isPrivateInstallMode(status.environment) && status.environment.npmGlobalInstallWritable === false) {
      console.warn("[CLI_AUTO_UPDATE_SKIPPED]", { code: "CLI_AUTO_UPDATE_PRIVILEGE_REQUIRED", workspaceId });
      return;
    }
    for (const item of status.items) {
      if (!item.installed || !item.updateAvailable) continue;
      const result = await npmInstall(ctx, { npmPackage: item.npmPackage, network: { mode: "auto", proxyUrl: null } }, workspaceId);
      if (!result.ok) {
        const code = (result as { code?: unknown }).code;
        if (code === "CONFLICT") {
          console.warn("[CLI_AUTO_UPDATE_SKIPPED]", { code: "CLI_AUTO_UPDATE_BUSY", workspaceId, npmPackage: item.npmPackage, rootCause: result.message });
          break;
        }
        console.error("[CLI_AUTO_UPDATE_FAILED]", { code: "CLI_AUTO_UPDATE_FAILED", workspaceId, npmPackage: item.npmPackage, rootCause: result.message });
        continue;
      }
      if (!result.success) {
        console.error("[CLI_AUTO_UPDATE_FAILED]", { code: "CLI_AUTO_UPDATE_FAILED", workspaceId,
          npmPackage: item.npmPackage, rootCause: result.message ?? result.error ?? "unknown" });
      }
    }
    softwareUpdateSnapshots.delete(workspaceId);
  } catch (error) {
    console.error("[CLI_AUTO_UPDATE_FAILED]", { code: "CLI_AUTO_UPDATE_FAILED", workspaceId,
      rootCause: error instanceof Error ? error.message : String(error) });
  } finally {
    autoUpdateRunning = false;
  }
}

/** 桌面本地运行就绪后触发一次自动更新；关闭设置时不重复执行。 */
export function useAutoUpdateCli(): void {
  const config = useConfigStore();
  const { ctx } = useApiContext();
  let scheduled = false;
  watch(
    () => [config.isDesktop, config.localRuntimeReady, config.connected, config.workspaceId] as const,
    ([isDesktop, ready, connected, workspaceId]) => {
      if (!isDesktop || !ready || scheduled || isSharedWorkspaceSelectionId(workspaceId)
        || !isCliAutoUpdateEnabled()) return;
      // 本机 Client 的 CLI 能力是全局的；连接 Server 时仍按原工作区执行。
      const targetWorkspaceId = resolveSoftwareUpdateWorkspaceId({
        connected, isDesktop, localRuntimeReady: ready, workspaceId: String(workspaceId ?? "").trim(),
        workspaceIsLocal: config.isDesktop && isDesktopWorkspace(config, String(workspaceId ?? "").trim()),
      });
      if (connected && !targetWorkspaceId) return;
      scheduled = true;
      // 同一窗口内只尝试一次；刷新页面不重复触发安装。
      if (sessionStorage.getItem("codeflowai.cli-auto-update.attempted") === "1") return;
      sessionStorage.setItem("codeflowai.cli-auto-update.attempted", "1");
      window.setTimeout(() => { void updateInstalledClis(ctx.value, targetWorkspaceId); }, 1_500);
    },
    { immediate: true },
  );
}
