<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

defineOptions({ name: "DesktopQuitConfirmModal" });
const pending = ref(false);
const responding = ref(false);
/** 主进程只在本机有运行中会话时请求确认；页面卸载后由主进程回退系统确认框。 */
const unsubscribe = typeof window !== "undefined"
  ? window.codeflowDesktop?.onQuitConfirmRequested?.(() => { pending.value = true; }) ?? null
  : null;
onBeforeUnmount(() => { unsubscribe?.(); });

/** 只回传用户明确选择；失败保留弹窗并记录可检索原因。 */
async function respond(confirmed: boolean): Promise<void> {
  if (responding.value) return;
  responding.value = true;
  try {
    await window.codeflowDesktop?.respondQuitConfirm?.(confirmed);
    pending.value = false;
  } catch (error) {
    console.error("[desktop_quit_confirm_failed]", {
      code: "DESKTOP_QUIT_CONFIRM_FAILED",
      rootCause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    responding.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="pending"
    title="退出 CodeFlow"
    :closable="false"
    :mask-closable="false"
    centered
    @cancel="respond(false)"
  >
    <p class="quit-confirm__message">当前有会话在执行，退出将终止会话。</p>
    <template #footer>
      <a-button :disabled="responding" @click="respond(false)">取消</a-button>
      <a-button type="primary" danger :loading="responding" @click="respond(true)">退出</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.quit-confirm__message { margin: 0; color: var(--app-text, #1f2937); font-size: 14px; line-height: 1.6; }
</style>
