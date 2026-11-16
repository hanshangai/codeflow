<script setup lang="ts">
import { computed } from "vue";

defineOptions({ name: "VerificationRow" });

const props = defineProps<{
  email: string;
  cooldownSeconds: number;
  loading?: boolean;
  disabled?: boolean;
  idleLabel?: string;
}>();

const emit = defineEmits<{
  (e: "send"): void;
}>();

const buttonLabel = computed(() => {
  if (props.loading) return "发送中";
  if (props.cooldownSeconds > 0) return `${props.cooldownSeconds}s 后重试`;
  return props.idleLabel?.trim() || "发送验证码";
});
</script>

<template>
  <a-button
    class="verification-row__button"
    :loading="loading"
    :disabled="disabled || !email.trim() || cooldownSeconds > 0"
    @click="emit('send')"
  >
    {{ buttonLabel }}
  </a-button>
</template>

<style scoped>
.verification-row__button {
  width: 100%;
}
</style>
