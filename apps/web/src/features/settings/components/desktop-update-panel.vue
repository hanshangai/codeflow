<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ExportOutlined } from "@ant-design/icons-vue";
import { describeUserFacingError, formatDesktopVersion, type DesktopUpdateDetails, type DesktopUpdateDiagnostics, type DesktopUpdateState } from "@codeflowai/shared";
import { checkDesktopForUpdates, reportDesktopUpdateError, restartDesktopForUpdate, DesktopUpdateServiceError, getDesktopUpdateCapabilities, getDesktopUpdateDetails, getDesktopUpdateDiagnostics, getDesktopUpdateState } from "../../../services/desktop";
import { desktopBundlePhaseLabels, desktopShellPhaseLabels, desktopUpdateOperationLabels, desktopUpdateResultLabels, formatDesktopCurrentVersion } from "../desktopUpdateLabels";
import { openUpgradeNotes } from "../../../utils/upgradeNotes";

const props = defineProps<{ active: boolean }>();
const router = useRouter();
/** 更新日志在桌面端交给系统浏览器，Web 端保持应用内路由。 */
function openNotes(): void { openUpgradeNotes(router); }
/** macOS 桌面壳不参与自动更新，界面明确引导人工安装。 */
const isMacDesktop = typeof window !== "undefined" && window.codeflowDesktop?.platform === "darwin";
const state = ref<DesktopUpdateState | null>(null);
const details = ref<DesktopUpdateDetails | null>(null);
const diagnostics = ref<DesktopUpdateDiagnostics | null>(null);
const capabilities = ref(getDesktopUpdateCapabilities());
const stateLoading = ref(false);
const detailsLoading = ref(false);
const checkingBusy = ref(false);
const restarting = ref(false);
const deferred = ref(false);
const diagnosticsLoading = ref(false);
const diagnosticsOpen = ref(false);
const stateError = ref<string | null>(null);
const detailsError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const diagnosticsError = ref<string | null>(null);
let disposed = false;
let activation = 0;
let stateRead = 0;
let detailsRead = 0;
let diagnosticsRead = 0;

const failureLabels = { updateCheckFailure: "更新检查", shellUpdateFailure: "桌面壳更新", updateReceiptFailure: "更新回执", updateFailureFailure: "失败诊断补报" } as const;
const currentFailures = computed(() => state.value ? Object.entries(failureLabels).flatMap(([key, label]) => {
  const failure = state.value![key as keyof typeof failureLabels];
  return failure ? [{ label, ...failure }] : [];
}) : []);
const retryDisabled = computed(() => !props.active || !capabilities.value.check || checkingBusy.value || restarting.value || stateLoading.value
  || state.value?.transportConfigured === false || state.value?.stoppingUpdates === true || state.value?.shellOwned === true || state.value?.operation === "exiting");

const showAdvanced = ref(false);
const currentRows = computed(() => [
  { label: "当前版本", value: formatDesktopCurrentVersion(details.value?.current ?? null) },
]);
const technicalRows = computed(() => [
  { label: "桌面壳", value: details.value?.current.shellVersion ?? "—" },
  { label: "应用资源", value: details.value?.current.bundle?.version ?? "—" },
  { label: "Web", value: details.value?.current.bundle?.webVersion ?? "—" },
  { label: "Client", value: details.value?.current.clientVersion ?? details.value?.current.bundle?.clientVersion ?? "—" },
]);
const preparedTargetText = computed(() => {
  const value = details.value;
  if (!value) return "";
  const bundle = value.bundle.result === "prepared" ? value.bundle.target : null;
  const shell = value.shell.result === "prepared" ? value.shell.target : null;
  return bundle || shell ? `版本 ${formatDesktopVersion(shell?.version ?? value.current.shellVersion, bundle?.version ?? value.current.bundle?.version ?? null)}` : "";
});
const restartDisabled = computed(() => !props.active || !capabilities.value.restart || !preparedTargetText.value || restarting.value || checkingBusy.value
  || stateLoading.value || detailsLoading.value || !!stateError.value || !!detailsError.value || !state.value
  || state.value.stoppingUpdates || state.value.shellOwned || state.value.operation === "exiting");
/** 只把用户需要立即知道的状态放进首屏。 */
const statusSummary = computed(() => {
  if (actionError.value) return "更新操作失败，请查看诊断。";
  if (stateError.value) return "更新状态读取失败，请稍后重试。";
  if (checkingBusy.value) return "正在检查更新…";
  if (!state.value) return stateLoading.value ? "正在读取更新状态…" : "尚未读取更新状态。";
  if (state.value.transportConfigured === false) return "更新源尚未配置，当前无法检查更新。";
  if (state.value.stoppingUpdates || state.value.shellOwned || state.value.operation === "exiting") return "桌面应用正在停止或交接更新。";
  if (preparedTargetText.value) return deferred.value ? "已保留待更新版本，下次正常启动时更新。" : "新版本已准备，重启应用后生效。";
  const current = details.value;
  if (current) {
    if (current.bundle.result === "healthy" || current.shell.result === "healthy") return "更新已生效，当前运行版本已通过健康检查。";
    const bundleLatest = current.bundle.result === "none" || current.bundle.result === "same";
    const shellLatest = current.shell.result === "none" || current.shell.result === "same";
    if (isMacDesktop && bundleLatest) return "应用资源已是最新；macOS 桌面壳请手动下载安装。";
    if (bundleLatest && shellLatest && !current.shell.target) return "当前已是最新版本。";
  }
  return "查看当前版本，按需检查并准备更新。";
});
const failureSummary = computed(() => {
  const first = currentFailures.value[0];
  if (first) return `${first.label} · 请求 ${first.requestId}`;
  if (details.value?.bundle.failure) return `应用资源 · 请求 ${details.value.bundle.failure.requestId}`;
  if (details.value?.shell.failure) return `桌面壳 · 请求 ${details.value.shell.failure.requestId}`;
  return "";
});
const capabilityNotice = computed(() => {
  const missing = [
    !capabilities.value.check && "更新检查",
    !capabilities.value.details && "版本详情",
    !capabilities.value.diagnostics && "诊断",
    !capabilities.value.restart && "重启更新",
  ].filter(Boolean);
  return missing.length ? `当前桌面壳不支持：${missing.join("、")}。` : "";
});

/** 故障摘要入口同时展开高级区并读取诊断；旧壳无诊断能力时不发起必败请求。 */
function openDiagnostics(): void {
  if (!capabilities.value.diagnostics) return;
  showAdvanced.value = true;
  void viewDiagnostics();
}

/** 局部序号只隔离展示竞态，不改变宿主更新轮次或取消在途检查。 */
function isCurrent(owner: number): boolean { return !disposed && props.active && owner === activation; }

/** 宿主原拒绝已在 IPC 记录；Web 校验失败仅记固定安全原因并返回显式失败文案。 */
function failureMessage(error: unknown, action: "state" | "details" | "check" | "restart" | "diagnostics"): string {
  // 只读快照失败已有界面提示，不伪造更新失败；检查失败由宿主按真实阶段记录，页面不重复。
  if (action === "restart") {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const shellTarget = details.value?.shell.result === "prepared" ? details.value.shell.target : null;
    const bundleTarget = details.value?.bundle.result === "prepared" ? details.value.bundle.target : null;
    void reportDesktopUpdateError(shellTarget && !bundleTarget
      ? { phase: details.value?.shell.phase ?? "handoff", target: "shell", shellId: shellTarget.shellId,
          code: "DESKTOP_UPDATE_RESTART_FAILED", requestId: details.value?.shell.requestId ?? null, message }
      : { phase: "restart-client", target: "bundle", code: "DESKTOP_UPDATE_RESTART_FAILED",
          requestId: details.value?.bundle.requestId ?? null, releaseId: bundleTarget?.releaseId ?? null, message });
  }
  if (error instanceof DesktopUpdateServiceError) {
    console.error("desktop_update_panel_failed", { errorCode: error.code, requestId: null, deviceId: state.value?.deviceId ?? null,
      action, rootCause: error.code });
    return error.code.endsWith("_UNAVAILABLE") ? "当前桌面壳缺少此更新能力，请使用支持该能力的桌面应用。" : "桌面更新响应无效，本次读取已失败。";
  }
  return describeUserFacingError(error, { state: "应用更新状态读取失败，请重新打开页面后查看。", details: "更新详情读取失败，请重新读取详情后重试。", check: "本次更新检查失败，后续状态查询已停止。", restart: "本次重启更新失败，请查看诊断后重试。", diagnostics: "应用更新诊断读取失败，请再次查看诊断。" }[action]);
}

/** 激活或检查结算后仅读即时快照；旧快照保留时同时明确显示刷新失败。 */
async function loadState(): Promise<void> {
  if (!props.active || disposed) return;
  const owner = activation, read = ++stateRead;
  stateLoading.value = true;
  stateError.value = null;
  try {
    const result = await getDesktopUpdateState();
    if (isCurrent(owner) && read === stateRead) state.value = result;
  } catch (error) {
    if (isCurrent(owner) && read === stateRead) stateError.value = failureMessage(error, "state");
  } finally {
    if (isCurrent(owner) && read === stateRead) stateLoading.value = false;
  }
}

/** 检查结算强制读取新快照；重复点击、失活和旧响应不能覆盖当前详情。 */
async function loadDetails(afterCheck = false): Promise<void> {
  if (!props.active || disposed || !capabilities.value.details || detailsLoading.value && !afterCheck) return;
  const owner = activation, read = ++detailsRead;
  detailsLoading.value = true;
  detailsError.value = null;
  try {
    const result = await getDesktopUpdateDetails();
    if (isCurrent(owner) && read === detailsRead) details.value = result;
  } catch (error) {
    if (isCurrent(owner) && read === detailsRead) detailsError.value = failureMessage(error, "details");
  } finally {
    if (isCurrent(owner) && read === detailsRead) detailsLoading.value = false;
  }
}

/** 只等待原检查入口；拒绝立即结束，void 结算且仍激活才重新查询状态。 */
async function retry(): Promise<void> {
  if (!props.active || disposed || checkingBusy.value || retryDisabled.value) return;
  const owner = activation;
  checkingBusy.value = true;
  actionError.value = null;
  deferred.value = false;
  try {
    await checkDesktopForUpdates();
    if (isCurrent(owner)) {
      await loadState();
      if (isCurrent(owner) && !stateError.value) await loadDetails(true);
    }
  } catch (error) {
    if (isCurrent(owner)) actionError.value = failureMessage(error, "check");
  } finally {
    checkingBusy.value = false;
  }
}

/** 用户确认后请求宿主重启；失败保留待更新事实，并允许处理原因后重试。 */
async function restart(): Promise<void> {
  if (disposed || restartDisabled.value) return;
  const owner = activation;
  restarting.value = true;
  actionError.value = null;
  try { await restartDesktopForUpdate(); }
  catch (error) { if (isCurrent(owner)) actionError.value = failureMessage(error, "restart"); }
  finally { restarting.value = false; }
}

/** 稍后仅收起提示，资源激活仍由宿主在下次正常启动处理。 */
function deferUpdate(): void { deferred.value = true; }

/** 诊断仅在用户点击时读取；停用后的结果不展开或更新旧页面。 */
async function viewDiagnostics(): Promise<void> {
  if (!props.active || disposed || diagnosticsLoading.value) return;
  const owner = activation, read = ++diagnosticsRead;
  diagnosticsOpen.value = true;
  diagnosticsLoading.value = true;
  diagnosticsError.value = null;
  try {
    const result = await getDesktopUpdateDiagnostics();
    if (isCurrent(owner) && read === diagnosticsRead) diagnostics.value = result;
  } catch (error) {
    if (isCurrent(owner) && read === diagnosticsRead) diagnosticsError.value = failureMessage(error, "diagnostics");
  } finally {
    if (isCurrent(owner) && read === diagnosticsRead) diagnosticsLoading.value = false;
  }
}

watch(() => props.active, active => {
  activation++;
  stateRead++;
  detailsRead++;
  diagnosticsRead++;
  stateLoading.value = false;
  detailsLoading.value = false;
  diagnosticsLoading.value = false;
  stateError.value = null;
  detailsError.value = null;
  actionError.value = null;
  diagnosticsError.value = null;
  diagnosticsOpen.value = false;
  deferred.value = false;
  if (active) {
    capabilities.value = getDesktopUpdateCapabilities();
    void loadState();
    void loadDetails();
  }
}, { immediate: true, flush: "sync" });
onUnmounted(() => { disposed = true; activation++; });
</script>

<template>
  <section class="desktop-update-panel" aria-label="应用更新" :aria-busy="stateLoading || detailsLoading || checkingBusy || restarting || diagnosticsLoading">
    <header class="desktop-update-panel__hero">
      <div>
        <h3>应用更新</h3>
        <p>{{ statusSummary }}</p>
      </div>
      <div class="desktop-update-panel__hero-actions">
        <a-button type="primary" :loading="checkingBusy" :disabled="retryDisabled" @click="retry">
          {{ checkingBusy ? "正在检查…" : "检查并准备更新" }}
        </a-button>
        <a-button
          type="link"
          size="small"
          :loading="detailsLoading"
          :disabled="!active || !capabilities.details || detailsLoading"
          @click="loadDetails()"
        >刷新版本</a-button>
        <a-button type="link" size="small" @click="openNotes">
          <template #icon><ExportOutlined /></template>
          更新日志
        </a-button>
      </div>
    </header>

    <div class="desktop-update-panel__versions" aria-label="当前版本">
      <div v-for="row in currentRows" :key="row.label" class="desktop-update-panel__version">
        <span>{{ row.label }}</span>
        <strong>{{ row.value }}</strong>
      </div>
      <div v-if="detailsLoading && !details" class="desktop-update-panel__version-loading" role="status">正在读取版本…</div>
    </div>

    <a-alert v-if="capabilityNotice" type="info" show-icon :message="capabilityNotice" />
    <a-alert v-if="detailsError" type="error" show-icon :message="detailsError" :description="details ? '下方保留上次读取的详情，本次刷新失败。' : undefined" />
    <a-alert v-if="actionError" type="error" show-icon :message="actionError">
      <template #action>
        <a-button size="small" :disabled="!capabilities.diagnostics" @click="openDiagnostics">查看诊断</a-button>
      </template>
    </a-alert>
    <a-alert v-if="stateError" type="error" show-icon :message="stateError" :description="state ? '下方保留的是上次读取的快照，本次刷新失败。' : undefined" />

    <div v-if="preparedTargetText && !deferred" class="desktop-update-panel__ready">
      <div>
        <strong>新版本已准备</strong>
        <span>{{ preparedTargetText }}</span>
      </div>
      <a-space wrap>
        <a-button :disabled="restarting" @click="deferUpdate">稍后</a-button>
        <a-button type="primary" :loading="restarting" :disabled="restartDisabled" @click="restart">重启更新</a-button>
      </a-space>
    </div>

    <div v-if="failureSummary" class="desktop-update-panel__failure-summary">
      <div>
        <strong>最近一次更新未完成</strong>
        <span>{{ failureSummary }}</span>
      </div>
      <a-button type="link" size="small" :disabled="!capabilities.diagnostics" @click="openDiagnostics">查看诊断</a-button>
    </div>

    <button type="button" class="desktop-update-panel__advanced-toggle" @click="showAdvanced = !showAdvanced">
      {{ showAdvanced ? "收起高级信息" : "高级信息与诊断" }}
    </button>

    <div v-if="showAdvanced" class="desktop-update-panel__advanced">
      <section aria-label="运行状态">
        <strong>运行状态</strong>
        <dl class="desktop-update-panel__facts">
          <template v-for="row in technicalRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template>
          <dt>当前操作</dt><dd>{{ state ? desktopUpdateOperationLabels[state.operation] : "—" }}</dd>
          <dt>更新检查在途</dt><dd>{{ state?.checking ? "是" : "否" }}</dd>
          <dt>更新源配置</dt><dd>{{ state?.transportConfigured ? "已配置" : "未配置" }}</dd>
          <dt>自动更新</dt><dd>{{ state?.automaticUpdates ? "已开启" : "未开启" }}</dd>
          <dt>自动检查抑制</dt><dd>{{ state?.updatesSuppressed ? "是" : "否" }}</dd>
          <dt>停止更新</dt><dd>{{ state?.stoppingUpdates ? "是" : "否" }}</dd>
          <dt>桌面壳已接管</dt><dd>{{ state?.shellOwned ? "是" : "否" }}</dd>
          <template v-if="details">
            <dt>应用资源目标</dt><dd>{{ details.bundle.target ? `${details.bundle.target.version}（${details.bundle.target.releaseId}）· Web ${details.bundle.target.webVersion} · Client ${details.bundle.target.clientVersion}` : "尚未取得可信目标" }}</dd>
            <dt>应用资源阶段</dt><dd>{{ details.bundle.phase ? desktopBundlePhaseLabels[details.bundle.phase] : "尚未取得阶段" }}</dd>
            <dt>应用资源结果</dt><dd>{{ desktopUpdateResultLabels[details.bundle.result] }}</dd>
            <dt>应用资源关联请求</dt><dd>{{ details.bundle.requestId ?? "尚未取得" }}</dd>
            <dt>桌面壳目标</dt><dd>{{ details.shell.target ? `${details.shell.target.version}（${details.shell.target.shellId}）` : "尚未取得可信目标" }}</dd>
            <dt>桌面壳阶段</dt><dd>{{ details.shell.phase ? desktopShellPhaseLabels[details.shell.phase] : "尚未取得阶段" }}</dd>
            <dt>桌面壳结果</dt><dd>{{ desktopUpdateResultLabels[details.shell.result] }}</dd>
            <dt>桌面壳关联请求</dt><dd>{{ details.shell.requestId ?? "尚未取得" }}</dd>
          </template>
        </dl>
        <a-button v-if="detailsError" type="link" size="small" @click="loadDetails()">重新读取详情</a-button>
        <a-button
          v-if="!diagnosticsOpen"
          type="link"
          size="small"
          :disabled="!capabilities.diagnostics"
          :loading="diagnosticsLoading"
          @click="openDiagnostics"
        >查看更新诊断</a-button>
      </section>

      <div v-for="failure in currentFailures" :key="failure.label" class="desktop-update-panel__failure">
        <strong>{{ failure.label }}故障</strong>
        <div>关联请求：{{ failure.requestId }}</div>
        <p>{{ describeUserFacingError(failure.rootCause) }}</p>
      </div>
      <div v-for="channel in (['bundle', 'shell'] as const)" :key="channel">
        <div v-if="details?.[channel].failure" class="desktop-update-panel__failure">
          <strong>{{ channel === 'bundle' ? '应用资源' : '桌面壳' }}本轮故障</strong>
          <div>关联请求：{{ details[channel].failure!.requestId }}</div>
          <p>{{ describeUserFacingError(details[channel].failure!.rootCause) }}</p>
        </div>
      </div>

      <section v-if="diagnosticsOpen" aria-label="更新诊断" class="desktop-update-panel__diagnostics">
        <strong>历史更新诊断</strong>
        <p class="desktop-update-panel__muted">“已确认”仅表示服务端精确确认该条诊断，不代表更新成功或可以安全重试。</p>
        <a-alert v-if="diagnosticsError" type="error" show-icon :message="diagnosticsError" :description="diagnostics ? '下方保留上次读取的诊断，本次刷新失败。' : undefined" />
        <div v-if="diagnosticsLoading" role="status">正在读取诊断…</div>
        <p v-else-if="diagnostics && !diagnostics.failures.length" class="desktop-update-panel__muted">暂无已记录的失败诊断。</p>
        <article v-for="item in diagnostics?.failures" :key="item.record.errorId" class="desktop-update-panel__failure">
          <strong>{{ item.record.errorCode === 'DESKTOP_SHELL_UPDATE_FAILED' ? '桌面壳更新失败' : '应用资源更新失败' }}</strong>
          <div>{{ item.record.at }} · {{ item.reported ? '已确认' : '未确认' }}</div>
          <div>阶段：{{ item.record.phase }} · 恢复记录：{{ item.record.recovery }}</div>
          <div>关联请求：{{ item.record.requestId }}</div>
          <div>诊断编号：{{ item.record.errorId }}</div>
          <p>{{ describeUserFacingError(item.record.rootCause) }}</p>
          <template v-if="item.record.rollbackError"><div>恢复故障</div><p>{{ describeUserFacingError(item.record.rollbackError) }}</p></template>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.desktop-update-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.desktop-update-panel__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.desktop-update-panel h3 {
  margin: 0;
  color: var(--app-text);
  font-size: 16px;
  font-weight: 600;
}

.desktop-update-panel p {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

.desktop-update-panel__hero-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.desktop-update-panel__versions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.desktop-update-panel__version {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-bg-secondary);
}

.desktop-update-panel__version span {
  color: var(--app-muted);
  font-size: 11px;
}

.desktop-update-panel__version strong {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.desktop-update-panel__version-loading {
  grid-column: 1 / -1;
  color: var(--app-muted);
  font-size: 12px;
}

.desktop-update-panel__ready {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg));
}

.desktop-update-panel__ready strong {
  display: block;
  color: var(--app-text);
  font-size: 13px;
}

.desktop-update-panel__ready span {
  display: block;
  margin-top: 2px;
  color: var(--app-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.desktop-update-panel__failure-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #d03050 30%, var(--app-border));
  border-radius: 12px;
  background: color-mix(in srgb, #d03050 6%, var(--app-panel-bg));
}

.desktop-update-panel__failure-summary strong {
  display: block;
  color: var(--app-text);
  font-size: 13px;
}

.desktop-update-panel__failure-summary span {
  display: block;
  margin-top: 2px;
  color: var(--app-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.desktop-update-panel__advanced-toggle {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.desktop-update-panel__advanced-toggle:hover {
  color: var(--app-text);
}

.desktop-update-panel__advanced {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border);
}

.desktop-update-panel__advanced section > strong {
  display: block;
  margin-bottom: 8px;
  color: var(--app-text);
  font-size: 13px;
}

.desktop-update-panel__facts {
  display: grid;
  grid-template-columns: minmax(0, 150px) minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
}

.desktop-update-panel__facts dt {
  color: var(--app-muted);
  font-size: 12px;
}

.desktop-update-panel__facts dd {
  margin: 0 0 4px;
  color: var(--app-text);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.desktop-update-panel__failure {
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-bg-secondary);
  color: var(--app-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.desktop-update-panel__failure strong {
  color: var(--app-text);
}

.desktop-update-panel__failure pre {
  max-height: 180px;
  overflow: auto;
  margin: 8px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.desktop-update-panel__diagnostics {
  display: grid;
  gap: 10px;
}

.desktop-update-panel__muted {
  color: var(--app-muted);
  font-size: 12px;
}
</style>
