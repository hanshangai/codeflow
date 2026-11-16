<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import NumericCaptchaField from "./numeric-captcha-field.vue";

defineOptions({ name: "CaptchaVerifyModal" });

type CaptchaFieldExpose = {
  refresh: () => void;
};

const props = defineProps<{
  open: boolean;
  confirmText?: string;
  loading?: boolean;
  autoSubmit?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", captchaToken: string): void;
}>();

const captchaFieldRef = ref<CaptchaFieldExpose | null>(null);
const captchaToken = ref("");

async function resetChallenge() {
  captchaToken.value = "";
  await nextTick();
  captchaFieldRef.value?.refresh();
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await resetChallenge();
      return;
    }
    captchaToken.value = "";
  },
);

watch(
  () => captchaToken.value,
  (value) => {
    if (!props.autoSubmit || !props.open || props.loading) return;
    if (!String(value ?? "").trim()) return;
    submit();
  },
);

function close() {
  emit("update:open", false);
}

function submit() {
  if (!captchaToken.value) return;
  emit("confirm", captchaToken.value);
}

defineExpose({ resetChallenge });
</script>

<template>
  <a-modal
    :open="open"
    title="请完成数字验证"
    wrap-class-name="captcha-verify-modal"
    :width="430"
    :footer="autoSubmit ? null : undefined"
    :ok-text="confirmText || '继续'"
    cancel-text="取消"
    :confirm-loading="loading"
    :ok-button-props="{ disabled: !captchaToken }"
    @ok="submit"
    @cancel="close"
  >
    <div class="captcha-verify-modal__field">
      <NumericCaptchaField ref="captchaFieldRef" v-model="captchaToken" />
    </div>
  </a-modal>
</template>

<style scoped>
.captcha-verify-modal__field {
  padding: 14px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 14%, var(--app-border));
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(248, 250, 252, 0.62)),
    color-mix(in srgb, var(--app-panel-bg) 96%, #f8fafc);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

:root[data-theme="dark"] .captcha-verify-modal__field {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02)),
    color-mix(in srgb, var(--app-panel-bg) 96%, #1a1918);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
</style>

<style>
.captcha-verify-modal .ant-modal-content {
  overflow: hidden;
  border-radius: 18px;
  box-shadow: 0 28px 70px rgba(15, 23, 42, 0.24);
}

.captcha-verify-modal .ant-modal-header {
  padding: 18px 22px 8px;
  border-bottom: 0;
}

.captcha-verify-modal .ant-modal-title {
  color: var(--app-text);
  font-size: 16px;
  font-weight: 650;
}

.captcha-verify-modal .ant-modal-body {
  padding: 12px 18px 18px;
}

.captcha-verify-modal .ant-modal-close {
  top: 12px;
  inset-inline-end: 12px;
}

:root[data-theme="dark"] .captcha-verify-modal .ant-modal-content {
  background: var(--app-panel-bg);
}

:root[data-theme="dark"] .captcha-verify-modal .ant-modal-title {
  color: var(--app-text);
}

:root[data-theme="dark"] .captcha-verify-modal .ant-modal-close {
  color: var(--app-muted);
}
</style>
