<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowRightOutlined, CheckCircleFilled, CloseCircleFilled, DownloadOutlined, ExportOutlined, InfoCircleOutlined } from "@ant-design/icons-vue";
import { describeUserFacingError, type DesktopUpdateDetails, type DesktopUpdateNotice, type DesktopUpdateProgress, type DesktopUpdateState } from "@codeflowai/shared";

import {
  checkDesktopForUpdates, DesktopUpdateServiceError, getDesktopUpdateCapabilities, getDesktopUpdateDetails,
  getDesktopUpdateState, reportDesktopUpdateError, restartDesktopForUpdate, subscribeDesktopUpdateCheckRequested, subscribeDesktopUpdateProgress,
  takeDesktopUpdateCheckRequest,
} from "../../../services/desktop";
import { formatDesktopCurrentVersion } from "../desktopUpdateLabels";
import { desktopUpdateCheckRequestTick } from "../desktopUpdateCheckRequest";
import { activeDesktopUpdateNotice, dismissDesktopUpdateNoticeLater, hideDesktopUpdateNotice } from "../desktopUpdateNoticeState";
import { openUpgradeNotes } from "../../../utils/upgradeNotes";
import { formatFileSizeLabel } from "../../../utils/fileMetaPresentation";

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
/** 下载起按待更新目标与当前未更新部分合成对外版本，历史失败目标不参与展示。 */
const targetRows = computed(() => {
  const value = details.value;
  if (!value) return [];
  // same/failure/restored 时宿主仍保留目标快照，不能当成待安装的新版本展示。
  const active = (result: string | null | undefined) => result === "prepared" || result === "unknown";
  const bundle = active(value.bundle.result) ? value.bundle.target : null;
  const shell = active(value.shell.result) ? value.shell.target : null;
  if (!bundle && !shell) return [];
  return [{ label: "新版本", value: formatDesktopCurrentVersion({ ...value.current,
    shellVersion: shell?.version ?? value.current.shellVersion, bundle: bundle ?? value.current.bundle,
  }) }];
});
const versionRows = computed(() => [...currentRows.value, ...targetRows.value]);
const prepared = computed(() => details.value?.bundle.result === "prepared" && !!details.value.bundle.target
  || details.value?.shell.result === "prepared" && !!details.value.shell.target);
const restartDisabled = computed(() => !prepared.value || !capabilities.restart || checking.value || restarting.value || !!snapshotError.value
  || !state.value || state.value.stoppingUpdates || state.value.shellOwned || state.value.operation === "exiting");

/** 已准备的资源阶段不遮住随后进行的壳更新；只把活跃阶段翻译成用户动作。 */
const phaseLabel = computed(() => {
  const value = details.value;
  const phase = value?.bundle.result === "unknown" ? value.bundle.phase
    : value?.shell.result === "unknown" ? value.shell.phase : null;
  if (phase === "download") return "正在下载更新";
  if (phase === "verify" || phase === "compatibility" || phase === "health") return "正在校验更新";
  if (phase && phase !== "discovery" && phase !== "read-active") return "正在准备更新";
  return "正在检查更新";
});

/** 下载阶段字节百分比；宿主未推送或已离开下载阶段时隐藏。 */
const downloadPercent = computed<number | null>(() => {
  const progress = updateProgress.value;
  if (!checking.value || !progress) return null;
  return Math.min(100, Math.max(0, Math.floor(progress.received * 100 / progress.total)));
});
const downloadSize = computed(() => downloadPercent.value !== null && updateProgress.value
  ? `${formatFileSizeLabel(updateProgress.value.received)} / ${formatFileSizeLabel(updateProgress.value.total)}` : "");

/** macOS 桌面壳不参与自动更新，manual_required 是人工安装提示，不是失败。 */
const isMacDesktop = typeof window !== "undefined" && window.codeflowDesktop?.platform === "darwin";

/** 资源与壳均取得完成事实才报告整体成功，未检查不能推断为不适用。 */
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
  const bundleHealthy = value.bundle.result === "healthy";
  const shellFailure = state.value?.shellUpdateFailure ?? value.shell.failure;
  const failure = state.value?.updateCheckFailure ?? state.value?.shellUpdateFailure ?? value.bundle.failure ?? value.shell.failure;
  if (failure) return { tone: "error", title: "更新未完成", detail: (bundleHealthy && shellFailure ? "应用内容已更新，桌面壳更新未完成。" : "")
    + describeUserFacingError(failure.rootCause, "更新未完成，请到更新设置查看诊断。") };
  const bundleLatest = value.bundle.result === "none" || value.bundle.result === "same";
  const shellLatest = value.shell.result === "none" || value.shell.result === "same";
  if (isMacDesktop && (bundleLatest || bundleHealthy) && value.shell.result === "manual_required") {
    return { tone: "info", title: "需要手动安装更新", detail: `${bundleHealthy ? "应用内容已更新" : "应用内容已是最新"}，macOS 桌面应用请通过完整安装包更新。` };
  }
  if (bundleLatest && shellLatest && !value.shell.target) {
    return { tone: "success", title: "当前已是最新版本", detail: "无需下载或安装更新" };
  }
  if (["failure", "manual_required", "unavailable", "revoked"].includes(value.bundle.result)
    || ["failure", "unavailable", ...(isMacDesktop ? [] : ["manual_required"])].includes(value.shell.result)) {
    return { tone: "error", title: "更新未完成", detail: (bundleHealthy ? "应用内容已更新，桌面壳更新未完成。" : "") + "请到更新设置查看诊断。" };
  }
  if (value.bundle.result === "restored" || value.shell.result === "restored") {
    return { tone: "warning", title: "更新已回退", detail: "新版本未通过健康检查，已恢复原版本。" };
  }
  if (prepared.value) {
    if (!isMacDesktop && value.bundle.result === "prepared") {
      return { tone: "success", title: "重启并继续更新", detail: "应用内容已下载并校验完成。重启后将激活应用内容，并继续检查桌面壳更新。" };
    }
    return { tone: "success", title: "重启即可完成更新", detail: "更新已下载并校验完成。现在重启即可使用，也可以下次启动时更新。" };
  }
  if ((bundleLatest || bundleHealthy) && value.shell.result === "unknown") {
    return { tone: "info", title: "桌面壳尚未检查", detail: `${bundleHealthy ? "应用内容已更新" : "应用内容已是最新"}，桌面壳尚未检查，请重新检查。旧版安装可能需要通过完整安装包更新桌面壳。` };
  }
  if (bundleHealthy && shellLatest || (bundleLatest || bundleHealthy) && value.shell.result === "healthy") {
    return { tone: "success", title: "更新已生效", detail: "你正在使用更新后的版本。" };
  }
  if (value.bundle.target || value.shell.target) {
    return { tone: "info", title: "更新尚未准备完成", detail: "请重新检查，完成下载和校验后即可重启更新。" };
  }
  return { tone: "info", title: "暂未确认可用更新", detail: "尚未取得完整的更新结果，请稍后重新检查。" };
});

/** 展示直接派生自原检查、重启与错误事实，不维护另一套升级状态。 */
const presentation = computed<Outcome>(() => {
  if (error.value || snapshotError.value) return outcome.value!;
  if (restarting.value) return { tone: "info", title: "正在重启更新", detail: "应用将关闭并重新启动，请稍候。" };
  if (checking.value) return { tone: "info", title: downloadPercent.value !== null ? "正在下载更新" : phaseLabel.value,
    detail: "你可以继续使用 CodeFlow，更新会在后台准备。" };
  return outcome.value ?? { tone: "info", title: "正在读取更新状态", detail: "正在获取当前版本与可用更新。" };
});

/** 每种结果只突出一个下一步；准备完成前不提供重启操作。 */
const primaryAction = computed(() => {
  if (restarting.value) return { kind: "restart" as const, label: "正在重启…", disabled: true };
  if (checking.value) return { kind: "close" as const, label: "后台继续", disabled: false };
  if (presentation.value.tone === "error") return { kind: "check" as const, label: "重试", disabled: !capabilities.check };
  if (prepared.value && capabilities.restart) return { kind: "restart" as const, label: "重启并更新", disabled: restartDisabled.value };
  if (presentation.value.tone === "success" || prepared.value) return { kind: "close" as const, label: "完成", disabled: false };
  return { kind: "check" as const, label: "重新检查", disabled: !capabilities.check };
});

/** 主操作复用现有检查、重启和关闭入口，禁用时不派发。 */
async function performPrimaryAction(): Promise<void> {
  if (primaryAction.value.disabled) return;
  if (primaryAction.value.kind === "restart") await restart();
  else if (primaryAction.value.kind === "check") await startCheck();
  else close();
}

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

/** 从首次快照起防重复；快照失败不派发检查，宿主受理后再补查最终结果。 */
async function startCheck(): Promise<void> {
  if (checking.value || restarting.value || disposed) return;
  const owner = ++run;
  open.value = true;
  error.value = "";
  updateProgress.value = null;
  checking.value = true;
  let requested = false;
  try {
    if (!await refreshSnapshots(owner)) return;
    if (disposed || owner !== run) return;
    if (!capabilities.check) { error.value = "当前桌面壳不支持检查并准备更新。"; return; }
    if (state.value?.transportConfigured === false) { error.value = "更新源尚未配置，当前无法检查并准备更新。"; return; }
    if (state.value?.stoppingUpdates || state.value?.shellOwned || state.value?.operation === "exiting") {
      error.value = "桌面应用正在停止或交接更新，请稍后重试。";
      return;
    }
    startPolling(owner);
    requested = true;
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
      if (requested) await refreshSnapshots(owner);
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
  <a-modal :open="open" title="软件更新" :footer="null" :width="520" centered
    :closable="!restarting" :keyboard="!restarting" :mask-closable="false"
    :body-style="{ maxHeight: 'calc(100dvh - 160px)', overflowY: 'auto' }" @cancel="close">
    <div class="update-check">
      <section class="update-check__summary" :class="`update-check__summary--${presentation.tone}`" role="status" aria-live="polite">
        <div class="update-check__symbol" aria-hidden="true">
          <a-spin v-if="checking || restarting" />
          <CheckCircleFilled v-else-if="presentation.tone === 'success'" />
          <CloseCircleFilled v-else-if="presentation.tone === 'error'" />
          <InfoCircleOutlined v-else-if="presentation.tone === 'warning'" />
          <DownloadOutlined v-else />
        </div>
        <div class="update-check__copy">
          <h2>{{ presentation.title }}</h2>
          <p>{{ presentation.detail }}</p>
        </div>
      </section>
      <section class="update-check__versions" aria-label="版本">
        <template v-for="(row, index) in versionRows" :key="row.label">
          <ArrowRightOutlined v-if="index > 0" class="update-check__version-arrow" aria-hidden="true" />
          <div class="update-check__version" :class="{ 'update-check__version--target': index > 0 }">
            <span>{{ row.label }}</span>
            <strong :title="row.value">{{ row.value }}</strong>
          </div>
        </template>
      </section>
      <section v-if="downloadPercent !== null" class="update-check__download" aria-label="下载进度">
        <div class="update-check__download-meta">
          <span>已下载 {{ downloadSize }}</span>
          <strong>{{ downloadPercent }}%</strong>
        </div>
        <a-progress :percent="downloadPercent" :show-info="false" status="active" size="small"
          :stroke-color="'var(--app-accent)'" :trail-color="'var(--app-border)'" />
      </section>
      <p v-if="prepared && !capabilities.restart" class="update-check__hint">当前版本不支持直接重启更新，请退出并重新启动应用。</p>
      <div class="update-check__actions">
        <a-button type="link" :disabled="restarting" @click="openNotes">
          <template #icon><ExportOutlined /></template>
          更新日志
        </a-button>
        <div class="update-check__action-buttons">
          <a-button v-if="primaryAction.kind !== 'close'" :disabled="restarting" @click="close">{{ prepared ? '稍后' : '关闭' }}</a-button>
          <a-button v-else-if="!checking && capabilities.check" type="text" @click="startCheck">重新检查</a-button>
          <a-button :type="checking ? 'default' : 'primary'" :loading="restarting" :disabled="primaryAction.disabled" @click="performPrimaryAction">
            {{ primaryAction.label }}
          </a-button>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.update-check { display: grid; gap: 24px; padding-top: 12px; color: var(--app-text); }
.update-check__summary { display: flex; align-items: flex-start; gap: 16px; }
.update-check__symbol { display: grid; place-items: center; flex: 0 0 44px; height: 44px; border-radius: 14px; background: color-mix(in srgb, var(--app-accent) 10%, transparent); color: var(--app-accent); font-size: 23px; }
.update-check__summary--success .update-check__symbol { color: var(--app-success); background: color-mix(in srgb, var(--app-success) 10%, transparent); }
.update-check__summary--error .update-check__symbol { color: var(--app-danger); background: color-mix(in srgb, var(--app-danger) 10%, transparent); }
.update-check__summary--warning .update-check__symbol { color: var(--app-warning); background: color-mix(in srgb, var(--app-warning) 10%, transparent); }
.update-check__copy { min-width: 0; }
.update-check__copy h2 { margin: 0 0 8px; color: var(--app-text); font-size: 20px; font-weight: 600; line-height: 1.4; }
.update-check__copy p, .update-check__hint { margin: 0; color: var(--app-muted); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.update-check__versions { display: flex; align-items: center; gap: 20px; padding: 18px 20px; border: 1px solid var(--app-border); border-radius: 12px; background: var(--app-bg); }
.update-check__version { display: grid; flex: 1; gap: 6px; min-width: 0; }
.update-check__version span { color: var(--app-muted); font-size: 12px; }
.update-check__version strong { color: var(--app-text); font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.update-check__version--target strong { color: var(--app-accent); font-weight: 600; }
.update-check__version-arrow { flex: 0 0 auto; color: var(--app-muted); font-size: 16px; }
.update-check__download { display: grid; gap: 4px; }
.update-check__download-meta { display: flex; justify-content: space-between; gap: 12px; color: var(--app-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.update-check__download-meta strong { color: var(--app-accent); font-weight: 600; }
.update-check__actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 18px; border-top: 1px solid var(--app-border); }
.update-check__action-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 480px) {
  .update-check__versions { gap: 12px; padding: 16px; }
  .update-check__version strong { font-size: 16px; }
  .update-check__actions { align-items: flex-start; gap: 8px; }
}
</style>
