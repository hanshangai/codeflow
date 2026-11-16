<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import type { DesktopUpdateNotice } from "@codeflowai/shared";

import {
  DesktopUpdateServiceError,
  dismissDesktopUpdateNotice,
  getDesktopUpdateCapabilities,
  getDesktopUpdateNotice,
  reportDesktopUpdateError,
  restartDesktopForUpdate,
  subscribeDesktopUpdateNotice,
} from "../../../services/desktop";
import { requestDesktopUpdateCheck } from "../desktopUpdateCheckRequest";
import { activeDesktopUpdateNotice, hideDesktopUpdateNotice, showDesktopUpdateNotice } from "../desktopUpdateNoticeState";

defineOptions({ name: "DesktopUpdateNoticeModal" });

const capabilities = getDesktopUpdateCapabilities();
const notice = activeDesktopUpdateNotice;
const suppressSession = ref(false);
const restarting = ref(false);
let unsubscribe: (() => void) | null = null;
let disposed = false;

const open = computed(() => notice.value !== null);

/** 提醒相关失败保留固定代码、版本与真实原因，便于客户端日志检索。 */
function report(action: string, error: unknown, releaseId: string | null, shellOnly = false): void {
  const code = error instanceof DesktopUpdateServiceError ? error.code : "DESKTOP_UPDATE_NOTICE_FAILED";
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  console.error(`[desktop_update_notice_${action}]`, { code, releaseId, message });
  const shellRestart = action === "restart_failed" && shellOnly;
  void reportDesktopUpdateError({
    phase: shellRestart ? "handoff" : action === "restart_failed" ? "restart-client" : "discovery",
    code, message, ...(shellRestart ? { target: "shell" as const } : { releaseId }),
  });
}

/** 推送与补查共用同一状态；只有版本变化才重置“本次不再提醒”，外部隐藏也不影响。 */
let lastNoticeReleaseId: string | null = null;
function applyNotice(value: DesktopUpdateNotice): void {
  if (disposed) return;
  if (lastNoticeReleaseId !== null && lastNoticeReleaseId !== value.releaseId) suppressSession.value = false;
  lastNoticeReleaseId = value.releaseId;
  showDesktopUpdateNotice(value);
}

/** 勾选复选框时，稍后与关闭都按本次运行抑制处理。 */
async function close(action: "later" | "session"): Promise<void> {
  const current = notice.value;
  const effective = action === "session" || suppressSession.value ? "session" : "later";
  suppressSession.value = false;
  hideDesktopUpdateNotice();
  if (!current) return;
  try { await dismissDesktopUpdateNotice(effective); }
  catch (error) {
    report("dismiss_failed", error, current.releaseId);
    message.error("提醒状态保存失败，下次启动可能再次提示。");
  }
}

/** 资源更新直接进入现有重启流程；运行中会话仍由宿主确认。 */
async function updateNow(): Promise<void> {
  if (!notice.value || restarting.value) return;
  restarting.value = true;
  try { await restartDesktopForUpdate(); }
  catch (error) {
    report("restart_failed", error, notice.value?.releaseId ?? null, notice.value?.shellOnly === true);
    message.error("重启更新失败，请稍后重试。");
  } finally { restarting.value = false; }
}

/** macOS 壳需手动安装，转交检查更新弹窗展示说明与更新日志；勾选复选框同样生效。 */
function openCheck(): void {
  const current = notice.value;
  const effective = suppressSession.value ? "session" : "later";
  suppressSession.value = false;
  hideDesktopUpdateNotice();
  requestDesktopUpdateCheck();
  if (!current) return;
  void dismissDesktopUpdateNotice(effective).catch(error => report("dismiss_failed", error, current.releaseId));
}

onMounted(() => {
  if (!capabilities.notice) return;
  unsubscribe = subscribeDesktopUpdateNotice(applyNotice);
  void getDesktopUpdateNotice()
    .then(value => { if (value) applyNotice(value); })
    .catch(error => report("load_failed", error, activeDesktopUpdateNotice.value?.releaseId ?? null));
});

onBeforeUnmount(() => {
  disposed = true;
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <a-modal
    :open="open"
    :title="notice?.shellOnly ? '发现新版本（需手动安装）' : '发现新版本'"
    :footer="null"
    :width="440"
    centered
    :mask-closable="false"
    @cancel="close('later')"
  >
    <div class="update-notice">
      <p class="update-notice__lead">
        新版本 <strong>{{ notice?.version }}</strong>
        {{ notice?.shellOnly ? "已下载完成，请下载安装包手动安装。" : "已下载完成，重启应用后生效。" }}
      </p>
      <p v-if="notice?.currentVersion" class="update-notice__meta">当前版本 <strong>{{ notice.currentVersion }}</strong></p>
      <a-checkbox v-model:checked="suppressSession">本次不再提醒</a-checkbox>
      <div class="update-notice__actions">
        <a-button :disabled="restarting" @click="close('later')">稍后提醒</a-button>
        <a-button v-if="notice?.shellOnly" type="primary" @click="openCheck">查看更新方式</a-button>
        <a-button v-else type="primary" :loading="restarting" @click="updateNow">{{ restarting ? '正在应用更新…' : '立即更新' }}</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.update-notice { display: grid; gap: 12px; }
.update-notice__lead { margin: 0; color: var(--app-text, #1f2937); font-size: 14px; line-height: 1.6; }
.update-notice__meta { margin: 0; color: var(--app-muted, #8b95a7); font-size: 12px; }
.update-notice__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
