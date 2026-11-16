<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import NumericCaptchaField from "./numeric-captcha-field.vue";

defineOptions({ name: "CaptchaVerifyPopover" });

type CaptchaFieldExpose = {
  refresh: () => void;
};

type Placement =
  | "top"
  | "topLeft"
  | "topRight"
  | "bottom"
  | "bottomLeft"
  | "bottomRight"
  | "left"
  | "right";

const props = withDefaults(
  defineProps<{
    open: boolean;
    placement?: Placement;
    /** 为 true 时拦截外部 trigger 触发的打开请求，仅允许父组件主动设为 open=true */
    disabled?: boolean;
  }>(),
  {
    placement: "top",
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", captchaToken: string): void;
}>();

const captchaFieldRef = ref<CaptchaFieldExpose | null>(null);
const captchaToken = ref("");

/** 清空内部状态并请求一份新的数字验证码。 */
async function resetChallenge() {
  captchaToken.value = "";
  await nextTick();
  captchaFieldRef.value?.refresh();
}

/** 由 a-popover 的 trigger 或外部点击触发的开闭事件 */
function handleOpenChange(next: boolean) {
  if (props.disabled && next) return;
  emit("update:open", next);
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
    if (!props.open) return;
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return;
    emit("confirm", trimmed);
  },
);

defineExpose({ resetChallenge });
</script>

<template>
  <a-popover
    :open="open"
    :placement="placement"
    trigger="click"
    overlay-class-name="captcha-verify-popover"
    @open-change="handleOpenChange"
  >
    <template #title>
      <span class="captcha-verify-popover__title">请完成数字验证</span>
    </template>
    <template #content>
      <div class="captcha-verify-popover__field">
        <NumericCaptchaField ref="captchaFieldRef" v-model="captchaToken" />
      </div>
    </template>
    <slot />
  </a-popover>
</template>

<style scoped>
.captcha-verify-popover__title {
  color: var(--app-text);
  font-size: 14px;
  font-weight: 650;
}

.captcha-verify-popover__field {
  width: min(84vw, 390px);
}
</style>

<style>
.captcha-verify-popover .ant-popover-inner {
  border-radius: 16px;
  box-shadow: 0 20px 52px rgba(15, 23, 42, 0.22);
}

.captcha-verify-popover .ant-popover-title {
  padding: 14px 16px 4px;
  border-bottom: 0;
}

.captcha-verify-popover .ant-popover-inner-content {
  padding: 10px 14px 14px;
}

:root[data-theme="dark"] .captcha-verify-popover .ant-popover-inner {
  background: var(--app-panel-bg);
}

:root[data-theme="dark"] .captcha-verify-popover .ant-popover-title {
  color: var(--app-text);
}
</style>
