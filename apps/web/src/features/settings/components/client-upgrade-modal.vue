<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from "vue";
import { Modal, message } from "ant-design-vue";

import { useApiContext } from "../../../composables/useApiContext";
import { isCancelledRequestError, requestJson } from "../../../api/request";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { resolveWorkspaceClientInfo } from "../../../composables/useAppShell";
import type { WorkspaceId } from "@codeflowai/shared";
import { getClientLatest, getClientUpgradeStatus, upgradeClient, type ClientPackageTarget } from "../../../api/software";
import { wsOriginToHttpOrigin } from "../../../api/request";
import { isClientUpgradeTargetReached } from "../clientUpgradePolicy";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "ClientUpgradeModal" });

const props = defineProps<{ open: boolean; embedded?: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const CLIENT_UPGRADE_RECONNECT_TIMEOUT_MS = 360_000;

const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();

type UpgradePhase = "idle" | "upgrading" | "restarting" | "success" | "manual_restart";

const phase = ref<UpgradePhase>("idle");
const loading = ref(false);
const downloadUrl = ref<string | null>(null);
const latestVersion = ref<string | null>(null);
const upgradeError = ref<string | null>(null);
const copied = ref(false);
const showManualCmd = ref(false);
const activeUpgradeId = ref<string | null>(null);
const confirmedVersion = ref<string | null>(null);
let activeUpgradeTarget: {
  workspaceId: string;
  clientId: string;
  version: string;
  context: typeof ctx.value;
} | null = null;

let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectStatusPolling = false;
let latestRequest = 0;

const canClose = computed(() => phase.value !== "upgrading" && phase.value !== "restarting");
const currentClientPlatform = computed(() => presence.clientForWorkspace(config.workspaceId)?.platform ?? "");
/** 判断当前 Client 平台的全局安装命令是否需要 sudo。 */
const clientUpgradeNeedsSudo = computed(() => {
  const platform = currentClientPlatform.value.toLowerCase();
  return platform === "darwin" || platform === "mac" || platform === "linux";
});

/** 生成当前 Client 平台对应的手动升级命令。 */
function installCommand(): string {
  if (!downloadUrl.value) return "";
  const httpBase = wsOriginToHttpOrigin(ctx.value.serverWsOrigin);
  return [
    `${clientUpgradeNeedsSudo.value ? "sudo " : ""}npm install -g --force`,
    "--registry=https://registry.npmmirror.com",
    "--replace-registry-host=never",
    "--include=optional --no-audit --no-fund",
    `"${httpBase}${downloadUrl.value}"`,
  ].join(" ");
}

function startCommand(): string {
  return "codeflow";
}

/** 拉取当前 workspace client 平台优先的最新安装包。 */
async function fetchLatest(): Promise<void> {
  const request = ++latestRequest, workspaceId = config.workspaceId;
  const context = { ...ctx.value };
  /** 仅当前查询和账号范围可写回安装包版本、URL及加载状态。 */
  const isCurrent = (): boolean => request === latestRequest && workspaceId === config.workspaceId
    && context.serverWsOrigin === ctx.value.serverWsOrigin && context.sessionToken === ctx.value.sessionToken;
  loading.value = true;
  latestVersion.value = null;
  downloadUrl.value = null;
  try {
    const res = await getClientLatest(context, resolveCurrentClientPackageTarget());
    if (!isCurrent()) return;
    if (res.ok) {
      latestVersion.value = res.version;
      downloadUrl.value = res.url;
    } else throw new Error(res.message ?? "查询最新 Client 安装包失败");
  } catch (error) {
    if (!isCurrent()) return;
    latestVersion.value = null;
    downloadUrl.value = null;
    upgradeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

/** 从当前 workspace 的在线 client 上报信息中解析平台包目标。 */
function resolveCurrentClientPackageTarget(): ClientPackageTarget | null {
  const client = presence.clientForWorkspace(config.workspaceId);
  if (!client?.platform || !client.arch) return null;
  return { platform: client.platform, arch: client.arch };
}

/** 启动当前工作区 Client 升级，并进入重连等待。 */
async function doUpgrade(): Promise<void> {
  let target: typeof activeUpgradeTarget = null;
  phase.value = "upgrading";
  upgradeError.value = null;
  trackProductEvent("client_upgrade_start", {
    source: "upgrade_modal",
    platform: currentClientPlatform.value || "unknown",
  });

  try {
    const workspaceId = config.workspaceId;
    const workspace = workspaces.byId.get(workspaceId as WorkspaceId);
    const client = resolveWorkspaceClientInfo({ workspaceId, ownerClientId: workspace?.ownerClientId,
      hostClientId: workspace?.shared?.hostClientId,
      hostWorkspaceId: workspace?.shared?.isHostOwner ? workspace.shared.hostLocalWorkspaceId : null,
      clients: presence.availableClients });
    if (!workspaceId || !client || !latestVersion.value) throw new Error("无法确认当前工作区的目标 Client 或升级版本，请刷新后重试");
    activeUpgradeTarget = { workspaceId, clientId: client.clientId, version: latestVersion.value, context: { ...ctx.value } };
    target = activeUpgradeTarget;
    const res = await upgradeClient(target.context, workspaceId);
    if (activeUpgradeTarget !== target) return;
    assertUpgradeScope();
    if (!res.ok) {
      phase.value = "idle";
      upgradeError.value = res.message ?? "请求失败";
      trackProductEvent("client_upgrade_failed", {
        source: "upgrade_modal",
        platform: currentClientPlatform.value || "unknown",
        error_code_group: "request_rejected",
      });
      return;
    }
    if (!res.upgraded && !res.upgradeStarted) {
      phase.value = "idle";
      upgradeError.value = res.error ?? "升级启动失败";
      trackProductEvent("client_upgrade_failed", {
        source: "upgrade_modal",
        platform: currentClientPlatform.value || "unknown",
        error_code_group: "start_failed",
      });
      return;
    }

    // 升级已下发或已完成，统一等待 client 重启后重连。
    activeUpgradeTarget.version = res.targetVersion ?? res.toVersion ?? activeUpgradeTarget.version;
    activeUpgradeId.value = res.upgradeId ?? null;
    phase.value = "restarting";
    waitForReconnect();
  } catch (e) {
    if (target && activeUpgradeTarget !== target) return;
    if (isCancelledRequestError(e)) {
      phase.value = "idle";
      return;
    }
    phase.value = "idle";
    upgradeError.value = e instanceof Error ? e.message : String(e);
    trackProductEvent("client_upgrade_failed", {
      source: "upgrade_modal",
      platform: currentClientPlatform.value || "unknown",
      error_code_group: "request_error",
    });
  }
}

/** 启动当前 Client 的重连轮询与超时控制。 */
function waitForReconnect(): void {
  clearTimers();

  // 只接受 Server 上报的实际版本，在线状态本身不能证明升级成功。
  void pollReconnectStatus();
  reconnectTimer = setInterval(() => {
    void pollReconnectStatus();
  }, 2000);

  // 升级安装可能跨网络下载，超时后提示用户手动启动。
  reconnectTimeout = setTimeout(() => {
    clearTimers();
    phase.value = "manual_restart";
    trackProductEvent("client_upgrade_reconnect_timeout", {
      source: "upgrade_modal",
      platform: currentClientPlatform.value || "unknown",
      error_code_group: "reconnect_timeout",
    });
  }, CLIENT_UPGRADE_RECONNECT_TIMEOUT_MS);
}

/** 使用 Server 返回的实际版本完成升级，禁止把目标版本直接写成当前版本。 */
function onReconnected(clientVersion: string, latestClientVersion: string | null): void {
  clearTimers();
  confirmedVersion.value = clientVersion;
  phase.value = "success";
  config.setClientVersionInfo({
    clientVersion,
    latestClientVersion: latestClientVersion ?? latestVersion.value ?? clientVersion,
  });
  trackProductEvent("client_upgrade_success", {
    source: "upgrade_modal",
    platform: currentClientPlatform.value || "unknown",
    client_version_major: clientVersion.split(".")[0] || "unknown",
  });
}

/** 重连只确认原工作区的原 Client，聚合版本不能作为成功证据。 */
async function pollReconnectStatus(): Promise<void> {
  if (reconnectStatusPolling || phase.value !== "restarting") return;
  const target = activeUpgradeTarget;
  reconnectStatusPolling = true;
  try {
    assertUpgradeScope();
    const upgradeFinished = await pollUpgradeInstallStatus();
    if (activeUpgradeTarget !== target) return;
    if (upgradeFinished) return;
    if (phase.value !== "restarting" || activeUpgradeTarget !== target) return;
    const res = await requestJson<{
      latestClientVersion: string | null;
      clients?: Array<{ clientId: string; version: string | null; workspaceIds: string[] }>;
    }>(target!.context, { method: "GET", path: "/api/status" });
    if (phase.value !== "restarting" || activeUpgradeTarget !== target) return;
    assertUpgradeScope();
    if (!res.ok) throw new Error(res.message ?? "查询 Client 重连状态失败");
    const client = resolveWorkspaceClientInfo({ workspaceId: target!.workspaceId, ownerClientId: target!.clientId, clients: res.clients });
    if (!client?.version || !isClientUpgradeTargetReached(client.version, target!.version)) return;
    onReconnected(client.version, res.latestClientVersion);
  } catch (error) {
    if (activeUpgradeTarget !== target || phase.value !== "restarting") return;
    clearTimers();
    phase.value = "idle";
    upgradeError.value = error instanceof Error ? error.message : String(error);
    const failure = error as { code?: string; requestId?: string; details?: { requestId?: string } };
    console.error("[CLIENT_UPGRADE_RECONNECT_FAILED]", { code: failure?.code ?? "CLIENT_UPGRADE_RECONNECT_FAILED",
      requestId: failure?.requestId ?? failure?.details?.requestId ?? null, clientId: target?.clientId,
      workspaceId: target?.workspaceId, upgradeId: activeUpgradeId.value, rootCause: upgradeError.value });
  } finally {
    if (activeUpgradeTarget === target) reconnectStatusPolling = false;
  }
}

/** 切换账号、Server 或工作区后停止原升级流程，避免跨作用域写回。 */
function assertUpgradeScope(): void {
  const target = activeUpgradeTarget;
  if (!target || config.workspaceId !== target.workspaceId
    || ctx.value.serverWsOrigin !== target.context.serverWsOrigin || ctx.value.sessionToken !== target.context.sessionToken) {
    throw new Error("账号、服务器或工作区已变化，请返回原工作区确认 Client 升级结果");
  }
}

/** 查询后台升级安装结果；失败时退出等待并展示原因。 */
async function pollUpgradeInstallStatus(): Promise<boolean> {
  if (!activeUpgradeId.value) return false;
  const target = activeUpgradeTarget;
  const res = await getClientUpgradeStatus(target!.context, activeUpgradeId.value);
  if (phase.value !== "restarting" || activeUpgradeTarget !== target) return true;
  assertUpgradeScope();
  if (!res.ok) {
    clearTimers();
    phase.value = "idle";
    upgradeError.value = res.message ?? "查询升级状态失败";
    trackProductEvent("client_upgrade_failed", {
      source: "upgrade_modal",
      platform: currentClientPlatform.value || "unknown",
      error_code_group: "status_query_failed",
    });
    return true;
  }
  if (res.phase === "pending") return false;
  if (res.phase === "failed") {
    clearTimers();
    phase.value = "idle";
    upgradeError.value = res.message ?? res.payload?.message ?? res.payload?.error ?? "Client 升级安装失败";
    trackProductEvent("client_upgrade_failed", {
      source: "upgrade_modal",
      platform: currentClientPlatform.value || "unknown",
      error_code_group: "install_failed",
    });
    return true;
  }
  return false;
}

function clearTimers(): void {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
}

async function copyCommand(): Promise<void> {
  const cmd = installCommand();
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    copied.value = true;
    message.success("已复制安装命令");
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    message.error("复制失败，请手动复制");
  }
}

function handleClose(): void {
  if (!canClose.value) return;
  emit("update:open", false);
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      phase.value = "idle";
      upgradeError.value = null;
      activeUpgradeId.value = null;
      activeUpgradeTarget = null;
      confirmedVersion.value = null;
      showManualCmd.value = false;
      reconnectStatusPolling = false;
      void fetchLatest();
    } else {
      clearTimers();
      latestRequest++;
      loading.value = false;
      activeUpgradeTarget = null;
      reconnectStatusPolling = false;
    }
  },
  { immediate: true },
);

/** 目标范围变化后作废安装包快照，打开状态重新读取，关闭状态不产生后台查询。 */
watch([() => config.workspaceId, () => ctx.value.serverWsOrigin, () => ctx.value.sessionToken], () => {
  latestRequest++;
  latestVersion.value = null;
  downloadUrl.value = null;
  loading.value = false;
  if (props.open && phase.value === "idle") void fetchLatest();
}, { flush: "sync" });

onUnmounted(() => { clearTimers(); activeUpgradeTarget = null; latestRequest++; });
</script>

<template>
  <component
    :is="embedded ? 'div' : Modal"
    v-bind="!embedded ? { open, title: '客户端版本升级', footer: null, width: 480, closable: canClose, maskClosable: canClose, keyboard: canClose, centered: true } : {}"
    v-on="!embedded ? { cancel: handleClose } : {}"
  >
    <div class="upgrade-modal">
      <!-- 版本对比（始终显示） -->
      <a-alert v-if="phase === 'idle'" type="warning" show-icon style="margin-bottom: 16px">
        <template #message>检测到客户端版本落后于服务端预期版本，建议升级以确保功能兼容。</template>
      </a-alert>

      <div class="upgrade-modal__versions">
        <div class="upgrade-modal__version-row">
          <span class="upgrade-modal__version-label">当前客户端版本</span>
          <code class="upgrade-modal__version-value upgrade-modal__version-value--old">{{ config.clientVersion ?? '未知' }}</code>
        </div>
        <div class="upgrade-modal__version-arrow">→</div>
        <div class="upgrade-modal__version-row">
          <span class="upgrade-modal__version-label">最新可用版本</span>
          <code class="upgrade-modal__version-value upgrade-modal__version-value--new">{{ latestVersion ?? config.latestClientVersion ?? '未知' }}</code>
        </div>
      </div>

      <!-- idle：一键升级按钮 + 错误提示 + 手动命令折叠区 -->
      <template v-if="phase === 'idle' && !loading">
        <a-alert v-if="upgradeError" type="error" show-icon style="margin-bottom: 12px" closable @close="upgradeError = null">
          <template #message>升级失败：{{ upgradeError }}</template>
        </a-alert>

        <div v-if="downloadUrl" class="upgrade-modal__actions">
          <a-button type="primary" block @click="doUpgrade">一键升级</a-button>

          <div class="upgrade-modal__manual-toggle">
            <a @click.prevent="showManualCmd = !showManualCmd">{{ showManualCmd ? '收起手动命令' : '手动升级命令' }}</a>
          </div>

          <div v-if="showManualCmd" class="upgrade-modal__install">
            <div class="upgrade-modal__install-label">在终端执行以下命令升级：</div>
            <div class="upgrade-modal__install-cmd">
              <code>{{ installCommand() }}</code>
              <a-button size="small" type="text" @click="copyCommand">{{ copied ? '已复制' : '复制' }}</a-button>
            </div>
            <div class="upgrade-modal__install-hint">升级完成后重启客户端即可生效。</div>
          </div>
        </div>

        <div v-else class="upgrade-modal__fallback">
          <div style="color: var(--app-muted); font-size: 12px">未找到可下载的安装包，请联系管理员确认服务端 downloads 目录配置。</div>
        </div>
      </template>

      <!-- upgrading：安装中 -->
      <div v-if="phase === 'upgrading'" class="upgrade-modal__progress">
        <a-spin />
        <span>正在安装新版本，请勿关闭页面...</span>
      </div>

      <!-- restarting：等待客户端重连 -->
      <div v-if="phase === 'restarting'" class="upgrade-modal__progress">
        <a-spin />
        <span>升级已下发，等待客户端重连...</span>
      </div>

      <!-- success：升级成功 -->
      <div v-if="phase === 'success'" class="upgrade-modal__result upgrade-modal__result--success">
        <div class="upgrade-modal__result-icon">✓</div>
        <div>升级成功 v{{ confirmedVersion }}</div>
      </div>

      <!-- manual_restart：超时未重连 -->
      <div v-if="phase === 'manual_restart'" class="upgrade-modal__result upgrade-modal__result--warn">
        <a-alert type="warning" show-icon>
          <template #message>未检测到客户端自动重连</template>
          <template #description>
            <div>请在终端手动启动客户端：</div>
            <div class="upgrade-modal__install-cmd" style="margin-top: 8px">
              <code>{{ startCommand() }}</code>
            </div>
          </template>
        </a-alert>
      </div>

      <a-spin v-if="loading && phase === 'idle'" style="display: block; text-align: center; padding: 20px 0" />
    </div>
  </component>
</template>

<style scoped>
.upgrade-modal {
  display: grid;
  gap: 16px;
}

.upgrade-modal__versions {
  display: flex;
  align-items: center;
  gap: 16px;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 10px;
}

.upgrade-modal__version-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.upgrade-modal__version-label {
  font-size: 12px;
  color: var(--app-muted);
}

.upgrade-modal__version-value {
  font-size: 16px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 6px;
}

.upgrade-modal__version-value--old {
  background: #fef2f2;
  color: #dc2626;
}

.upgrade-modal__version-value--new {
  background: #f0fdf4;
  color: #16a34a;
}

.upgrade-modal__version-arrow {
  font-size: 20px;
  color: var(--app-muted);
}

.upgrade-modal__actions {
  display: grid;
  gap: 12px;
}

.upgrade-modal__manual-toggle {
  text-align: center;
  font-size: 12px;
}

.upgrade-modal__manual-toggle a {
  color: var(--app-muted);
}

.upgrade-modal__install {
  display: grid;
  gap: 8px;
}

.upgrade-modal__install-label {
  font-size: 13px;
  font-weight: 500;
}

.upgrade-modal__install-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  font-size: 12px;
  overflow-x: auto;
}

.upgrade-modal__install-cmd code {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.upgrade-modal__install-hint {
  font-size: 12px;
  color: var(--app-muted);
}

.upgrade-modal__progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px 0;
  font-size: 14px;
  color: var(--app-muted);
}

.upgrade-modal__result {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  font-size: 15px;
  font-weight: 500;
}

.upgrade-modal__result--success {
  color: #16a34a;
}

.upgrade-modal__result-icon {
  font-size: 32px;
  line-height: 1;
}

.upgrade-modal__result--warn {
  padding: 0;
}

.upgrade-modal__fallback {
  text-align: center;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .upgrade-modal__versions { background: rgba(255, 255, 255, 0.04); }
  :root:not([data-theme]) .upgrade-modal__version-value--old { background: rgba(239, 68, 68, 0.15); color: #f87171; }
  :root:not([data-theme]) .upgrade-modal__version-value--new { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  :root:not([data-theme]) .upgrade-modal__install-cmd { background: rgba(255, 255, 255, 0.06); }
  :root:not([data-theme]) .upgrade-modal__result--success { color: #4ade80; }
}
:root[data-theme="dark"] .upgrade-modal__versions { background: rgba(255, 255, 255, 0.04); }
:root[data-theme="dark"] .upgrade-modal__version-value--old { background: rgba(239, 68, 68, 0.15); color: #f87171; }
:root[data-theme="dark"] .upgrade-modal__version-value--new { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
:root[data-theme="dark"] .upgrade-modal__install-cmd { background: rgba(255, 255, 255, 0.06); }
:root[data-theme="dark"] .upgrade-modal__result--success { color: #4ade80; }
</style>
