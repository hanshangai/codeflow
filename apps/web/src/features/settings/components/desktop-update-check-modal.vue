<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { CheckCircleFilled, CloseCircleFilled, ExportOutlined, InfoCircleOutlined } from "@ant-design/icons-vue";
import { describeUserFacingError, formatDesktopVersion, type DesktopUpdateDetails, type DesktopUpdateNotice, type DesktopUpdateProgress, type DesktopUpdateState } from "@codeflowai/shared";

import {
  checkDesktopForUpdates, DesktopUpdateServiceError, getDesktopUpdateCapabilities, getDesktopUpdateDetails,
  getDesktopUpdateState, reportDesktopUpdateError, restartDesktopForUpdate, subscribeDesktopUpdateCheckRequested, subscribeDesktopUpdateProgress,
  takeDesktopUpdateCheckRequest,
} from "../../../services/desktop";
import { desktopBundlePhaseLabels, desktopShellPhaseLabels, desktopUpdateResultLabels, formatDesktopCurrentVersion } from "../desktopUpdateLabels";
import { desktopUpdateCheckRequestTick } from "../desktopUpdateCheckRequest";
import { activeDesktopUpdateNotice, dismissDesktopUpdateNoticeLater, hideDesktopUpdateNotice } from "../desktopUpdateNoticeState";
import { openUpgradeNotes } from "../../../utils/upgradeNotes";

defineOptions({ name: "DesktopUpdateCheckModal" });
const router = useRouter();
/** 关闭更新弹窗后打开更新日志；桌面端交给系统浏览器。 */
function openNotes(): void { close(); openUpgradeNotes(router); }

type Outcome = { tone: "success" | "error" | "warning" | "info"; title: string; detail: string };

const capabilities = getDesktopUpdateCapabilities();
const open = ref(false);
const checking = ref(false);
const restarting = ref(false);
const state = ref<DesktopUpdateState | null>(null);
const details = ref<DesktopUpdateDetails | null>(null);
const error = ref("");
const snapshotError = ref("");
const updateProgress = ref<DesktopUpdateProgress>(null);
let unsubscribe: (() => void) | null = null;
let unsubscribeProgress: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollBusy = false;
let run = 0;
let disposed = false;

const currentRows = computed(() => [
  { label: "当前版本", value: formatDesktopCurrentVersion(details.value?.current ?? null) },
]);
/** 已取得可信目标后展示待更新版本；下载阶段即可见，不依赖准备完成。 */
const targetRows = computed(() => {
  const bundle = details.value?.bundle, shell = details.value?.shell;
  // same/failure/restored 时宿主仍保留目标快照，不能当成待安装的新版本展示。
  const active = (result: string | null | undefined) => result === "prepared" || result === "unknown";
  return [
    ...(bundle?.target && active(bundle.result) ? [{ label: "新版本（应用资源）", value: bundle.target.version }] : []),
    ...(shell?.target && active(shell.result) ? [{ label: "新版本（桌面壳）", value: shell.target.version }] : []),
  ];
});
const versionRows = computed(() => [...currentRows.value, ...targetRows.value]);
const prepared = computed(() => details.value?.bundle.result === "prepared" && !!details.value.bundle.target
  || details.value?.shell.result === "prepared" && !!details.value.shell.target);
const restartDisabled = computed(() => !prepared.value || !capabilities.restart || checking.value || restarting.value || !!snapshotError.value
  || !state.value || state.value.stoppingUpdates || state.value.shellOwned || state.value.operation === "exiting");

const phaseLabel = computed(() => {
  const bundlePhase = details.value?.bundle.phase;
  if (bundlePhase) return desktopBundlePhaseLabels[bundlePhase] ?? bundlePhase;
  const shellPhase = details.value?.shell.phase;
  return shellPhase ? desktopShellPhaseLabels[shellPhase] ?? shellPhase : "";
});

/** 下载阶段字节百分比；宿主未推送或已离开下载阶段时隐藏。 */
const downloadPercent = computed<number | null>(() => {
  const progress = updateProgress.value;
  if (!progress) return null;
  return Math.min(100, Math.max(0, Math.floor(progress.received * 100 / progress.total)));
});

/** macOS 桌面壳不参与自动更新，manual_required 是人工安装提示，不是失败。 */
const isMacDesktop = typeof window !== "undefined" && window.codeflowDesktop?.platform === "darwin";

/** 只展示结论，详细诊断仍由设置页持有。 */
const outcome = computed<Outcome | null>(() => {
  if (error.value) return { tone: "error", title: "更新未完成", detail: error.value };
  if (snapshotError.value) return { tone: "error", title: "更新状态读取失败", detail: snapshotError.value };
  if (!details.value) {
    // 旧壳只有基础状态：检查已结束但没有详情可展示，明确告知而不是停在“准备检查”。
    if (!checking.value && !capabilities.details) {
      return { tone: "info", title: "检查已完成", detail: "当前桌面壳不提供更新详情，请到更新设置查看。" };
    }
    return null;
  }
  if (checking.value) return null;
  const value = details.value;
  const failure = state.value?.updateCheckFailure ?? state.value?.shellUpdateFailure ?? value.bundle.failure ?? value.shell.failure;
  if (failure) return { tone: "error", title: "更新未完成", detail: describeUserFacingError(failure.rootCause, "更新未完成，请到更新设置查看诊断。") };
  const bundleLatest = value.bundle.result === "none" || value.bundle.result === "same";
  const shellLatest = value.shell.result === "none" || value.shell.result === "same";
  // 非 macOS 的本轮壳更新可能没有结果；应用资源最新时不把内部状态当成未完成。
  const shellNotApplicable = !isMacDesktop && value.shell.result === "unknown";
  if (isMacDesktop && bundleLatest && value.shell.result === "manual_required") {
    return { tone: "success", title: "应用资源已是最新", detail: "macOS 桌面壳请手动下载安装。" };
  }
  if (bundleLatest && shellLatest && !value.shell.target) {
    return { tone: "success", title: "当前已是最新版本", detail: "无需下载或安装更新" };
  }
  if (bundleLatest && shellNotApplicable && !value.shell.target) {
    return { tone: "success", title: "当前已是最新版本", detail: "应用资源已是最新版本" };
  }
  if (["failure", "manual_required", "unavailable", "revoked"].includes(value.bundle.result)
    || ["failure", "unavailable", ...(isMacDesktop ? [] : ["manual_required"])].includes(value.shell.result)) {
    return { tone: "error", title: "更新未完成", detail: "请到更新设置查看诊断。" };
  }
  if (value.bundle.result === "restored" || value.shell.result === "restored") {
    return { tone: "warning", title: "更新已回退", detail: "新版本未通过健康检查，已恢复原版本。" };
  }
  if (prepared.value) {
    const bundle = value.bundle.result === "prepared" ? value.bundle.target : null;
    const shell = value.shell.result === "prepared" ? value.shell.target : null;
    const version = formatDesktopVersion(shell?.version ?? value.current.shellVersion, bundle?.version ?? value.current.bundle?.version ?? null);
    return { tone: "success", title: "新版本已准备", detail: `版本 ${version}。重启更新，或下次正常启动时更新。` };
  }
  if (value.bundle.result === "healthy" || value.shell.result === "healthy") {
    return { tone: "success", title: "更新已生效", detail: "当前运行版本已通过健康检查。" };
  }
  if (value.bundle.target || value.shell.target) {
    const target = [
      value.bundle.target ? `版本 ${formatDesktopVersion(value.current.shellVersion, value.bundle.target.version)}` : "",
      value.shell.target ? `桌面壳 ${value.shell.target.version}` : "",
    ].filter(Boolean).join("；");
    return { tone: "info", title: "更新尚未准备完成", detail: `${target}。请稍后重新检查。` };
  }
  return { tone: "info", title: "检查完成", detail: `应用资源：${desktopUpdateResultLabels[value.bundle.result] ?? value.bundle.result}；桌面壳：${desktopUpdateResultLabels[value.shell.result] ?? value.shell.result}` };
});

/** 将桥错误映射为可读结论；原始异常正文只进日志，不直接展示 IPC 包装文本。 */
function failureText(cause: unknown): string {
  return describeUserFacingError(cause, "检查更新失败，请稍后重试。");
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function poll(owner: number): Promise<void> {
  if (pollBusy) return;
  pollBusy = true;
  try { await refreshSnapshots(owner); }
  finally { pollBusy = false; }
}

function startPolling(owner: number): void {
  stopPolling();
  pollTimer = setInterval(() => { void poll(owner); }, 800);
}

/** 快照失败明确阻止本轮后续检查，旧快照不能覆盖失败结论。 */
async function refreshSnapshots(owner: number): Promise<boolean> {
  if (disposed || owner !== run) return false;
  try {
    const [nextState, nextDetails] = await Promise.all([
      capabilities.state ? getDesktopUpdateState() : Promise.resolve(null),
      capabilities.details ? getDesktopUpdateDetails() : Promise.resolve(null),
    ]);
    if (disposed || owner !== run) return false;
    if (nextState) state.value = nextState;
    if (nextDetails) details.value = nextDetails;
    snapshotError.value = "";
    return true;
  } catch (cause) {
    if (disposed || owner !== run) return false;
    snapshotError.value = failureText(cause);
    console.error("[desktop_update_check_snapshot_failed]", {
      code: cause instanceof DesktopUpdateServiceError ? cause.code : "DESKTOP_UPDATE_CHECK_SNAPSHOT_FAILED",
      requestId: (cause as { requestId?: unknown } | null)?.requestId ?? null,
      rootCause: cause instanceof Error ? cause.message : String(cause),
    });
    void reportDesktopUpdateError({ phase: "discovery", code: "DESKTOP_UPDATE_CHECK_SNAPSHOT_FAILED",
      message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) });
    return false;
  }
}

/** 查询和准备均由原宿主入口拥有；快照失败时不继续派发副作用。 */
async function startCheck(): Promise<void> {
  if (checking.value || restarting.value || disposed) return;
  const owner = ++run;
  open.value = true;
  error.value = "";
  if (!await refreshSnapshots(owner)) return;
  if (disposed || owner !== run) return;
  if (!capabilities.check) { error.value = "当前桌面壳不支持检查并准备更新。"; return; }
  if (state.value?.transportConfigured === false) { error.value = "更新源尚未配置，当前无法检查并准备更新。"; return; }
  if (state.value?.stoppingUpdates || state.value?.shellOwned || state.value?.operation === "exiting") {
    error.value = "桌面应用正在停止或交接更新，请稍后重试。";
    return;
  }
  checking.value = true;
  startPolling(owner);
  try {
    await checkDesktopForUpdates();
  } catch (cause) {
    if (!disposed && owner === run) {
      error.value = failureText(cause);
      console.error("[desktop_update_check_failed]", {
        code: cause instanceof DesktopUpdateServiceError ? cause.code : "DESKTOP_UPDATE_CHECK_FAILED",
        requestId: (cause as { requestId?: unknown } | null)?.requestId ?? null,
        rootCause: cause instanceof Error ? cause.message : String(cause),
      });
      // 宿主已用真实 requestId 与阶段记录本次检查失败，页面不重复上报。
    }
  } finally {
    if (!disposed && owner === run) {
      checking.value = false;
      stopPolling();
      await refreshSnapshots(owner);
    }
  }
}

/** 重启只由用户发起；失败保留 prepared，允许原因处理后再次请求。 */
async function restart(): Promise<void> {
  if (disposed || restartDisabled.value) return;
  const owner = run;
  restarting.value = true;
  error.value = "";
  try { await restartDesktopForUpdate(); }
  catch (cause) {
    if (!disposed && owner === run) {
      error.value = failureText(cause);
      console.error("[desktop_update_restart_failed]", { code: cause instanceof DesktopUpdateServiceError ? cause.code : "DESKTOP_UPDATE_RESTART_FAILED",
        requestId: details.value?.bundle.result === "prepared" ? details.value.bundle.requestId : details.value?.shell.requestId ?? null, deviceId: state.value?.deviceId ?? null,
        rootCause: cause instanceof DesktopUpdateServiceError ? cause.code : "DESKTOP_HOST_RESTART_FAILED" });
      const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000);
      const shellTarget = details.value?.shell.result === "prepared" ? details.value.shell.target : null;
      const bundleTarget = details.value?.bundle.result === "prepared" ? details.value.bundle.target : null;
      void reportDesktopUpdateError(shellTarget && !bundleTarget
        ? { phase: details.value?.shell.phase ?? "handoff", target: "shell", shellId: shellTarget.shellId,
            code: "DESKTOP_UPDATE_RESTART_FAILED", requestId: details.value?.shell.requestId ?? null, message }
        : { phase: "restart-client", target: "bundle", code: "DESKTOP_UPDATE_RESTART_FAILED",
            requestId: details.value?.bundle.requestId ?? null, releaseId: bundleTarget?.releaseId ?? null, message });
    }
  } finally { restarting.value = false; }
}

function close(): void {
  open.value = false;
  ++run;
  stopPolling();
  checking.value = false;
  updateProgress.value = null;
}

/** 消费失败必须显示失败并停止，不能继续准备更新。 */
async function consumeCheckRequest(fromEvent = false): Promise<void> {
  try {
    const pending = await takeDesktopUpdateCheckRequest();
    if ((pending || fromEvent) && !disposed) await startCheck();
  } catch (cause) {
    if (disposed) return;
    open.value = true;
    error.value = failureText(cause);
    console.error("[desktop_update_check_take_failed]", { code: "DESKTOP_UPDATE_CHECK_TAKE_FAILED", requestId: null,
      rootCause: "DESKTOP_HOST_CHECK_TAKE_FAILED" });
    void reportDesktopUpdateError({ phase: "discovery", code: "DESKTOP_UPDATE_CHECK_TAKE_FAILED",
      message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) });
  }
}

/** 顶栏「应用更新」与托盘检查更新共用同一弹框和检查链路。 */
watch(desktopUpdateCheckRequestTick, () => {
  if (!disposed) void startCheck();
});

/** 打开检查弹框先隐藏提醒避免模态叠加，检查确认已准备后才持久关闭。 */
const pendingNotice = ref<DesktopUpdateNotice | null>(null);
watch(open, value => {
  if (!value) return;
  const notice = activeDesktopUpdateNotice.value;
  hideDesktopUpdateNotice();
  if (!notice) return;
  // 打开时已确认准备完成（上次检查结果）则立即关闭，否则等待本轮检查结果。
  if (prepared.value) dismissDesktopUpdateNoticeLater(notice);
  else pendingNotice.value = notice;
});
watch(prepared, value => {
  if (!value || !pendingNotice.value) return;
  const notice = pendingNotice.value;
  pendingNotice.value = null;
  dismissDesktopUpdateNoticeLater(notice);
});

onMounted(() => {
  unsubscribe = subscribeDesktopUpdateCheckRequested(() => { void consumeCheckRequest(true); });
  unsubscribeProgress = subscribeDesktopUpdateProgress(progress => { updateProgress.value = progress; });
  void consumeCheckRequest();
});

onBeforeUnmount(() => {
  disposed = true;
  ++run;
  stopPolling();
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeProgress?.();
  unsubscribeProgress = null;
});
</script>

<template>
  <a-modal :open="open" title="检查更新" :footer="null" :width="600" centered @cancel="close">
    <div class="update-check">
      <section class="update-check__versions" aria-label="版本">
        <div v-for="row in versionRows" :key="row.label" class="update-check__version">
          <span>{{ row.label }}</span>
          <strong :title="row.value">{{ row.value }}</strong>
        </div>
      </section>
      <div class="update-check__status" :class="`update-check__status--${outcome?.tone ?? 'checking'}`" role="status">
        <a-spin v-if="checking" size="small" />
        <CheckCircleFilled v-else-if="outcome?.tone === 'success'" class="update-check__icon" />
        <CloseCircleFilled v-else-if="outcome?.tone === 'error'" class="update-check__icon" />
        <InfoCircleOutlined v-else class="update-check__icon" />
        <div class="update-check__status-copy">
          <strong>{{ checking ? '正在检查并准备更新…' : outcome?.title ?? '准备检查更新' }}</strong>
          <span v-if="checking && phaseLabel">{{ phaseLabel }}<template v-if="downloadPercent !== null"> · {{ downloadPercent }}%</template></span>
          <span v-else-if="outcome?.detail">{{ outcome.detail }}</span>
        </div>
      </div>
      <div class="update-check__actions">
        <a-button type="link" @click="openNotes">
          <template #icon><ExportOutlined /></template>
          更新日志
        </a-button>
        <div class="update-check__action-buttons">
          <a-button :disabled="restarting" @click="close">{{ prepared ? '稍后' : '关闭' }}</a-button>
          <a-button v-if="prepared" type="primary" :loading="restarting" :disabled="restartDisabled" @click="restart">重启更新</a-button>
          <a-button v-else type="primary" :loading="checking" :disabled="!capabilities.check || restarting" @click="startCheck">重新检查</a-button>
        </div>
      </div>
      <p v-if="prepared && !capabilities.restart" class="update-check__hint">当前桌面壳不支持重启更新，请退出后重新启动应用。</p>
    </div>
  </a-modal>
</template>

<style scoped>
.update-check { display: grid; gap: 14px; }
.update-check__hint { margin: 0; color: var(--app-muted, #8b95a7); font-size: 12px; line-height: 1.5; }
.update-check__versions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px 16px; padding: 10px 12px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 10px; background: color-mix(in srgb, var(--app-text, #1f2937) 3%, transparent); }
.update-check__version { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.update-check__version span { color: var(--app-muted, #8b95a7); font-size: 11px; }
.update-check__version strong { overflow: hidden; color: var(--app-text, #1f2937); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.update-check__status { display: flex; align-items: flex-start; gap: 10px; padding: 14px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 10px; background: var(--app-panel-bg, #fff); }
.update-check__status--success { border-color: color-mix(in srgb, #16a34a 32%, var(--app-border, #e8e8e8)); }
.update-check__status--error { border-color: color-mix(in srgb, #dc2626 32%, var(--app-border, #e8e8e8)); }
.update-check__status--warning { border-color: color-mix(in srgb, #d97706 32%, var(--app-border, #e8e8e8)); }
.update-check__icon { margin-top: 1px; font-size: 18px; }
.update-check__status--success .update-check__icon { color: #16a34a; }
.update-check__status--error .update-check__icon { color: #dc2626; }
.update-check__status--warning .update-check__icon { color: #d97706; }
.update-check__status--info .update-check__icon, .update-check__status--checking .update-check__icon { color: var(--app-muted, #8b95a7); }
.update-check__status-copy { display: grid; gap: 4px; min-width: 0; font-size: 12px; color: var(--app-muted, #8b95a7); overflow-wrap: anywhere; }
.update-check__status-copy strong { color: var(--app-text, #1f2937); font-size: 14px; }
.update-check__actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.update-check__action-buttons { display: flex; gap: 8px; }
</style>
