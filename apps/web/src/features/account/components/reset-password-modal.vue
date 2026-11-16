<script setup lang="ts">
import { reactive, watch } from "vue";

defineOptions({ name: "ResetPasswordModal" });

const props = defineProps<{
  open: boolean;
  targetLabel: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", payload: { newPassword: string; confirmPassword: string }): void;
}>();

const form = reactive({
  newPassword: "",
  confirmPassword: "",
});

function resetForm() {
  form.newPassword = "";
  form.confirmPassword = "";
}

watch(
  () => props.open,
  (open) => {
    if (!open) resetForm();
  },
);

function close() {
  emit("update:open", false);
}

function submit() {
  emit("confirm", {
    newPassword: form.newPassword,
    confirmPassword: form.confirmPassword,
  });
}
</script>

<template>
  <a-modal
    :open="open"
    :title="`重置密码 / ${targetLabel}`"
    :confirm-loading="loading"
    ok-text="提交"
    cancel-text="取消"
    @ok="submit"
    @cancel="close"
  >
    <a-alert type="warning" show-icon style="margin-bottom: 16px" message="新密码至少 6 位。" />
    <a-form layout="vertical">
      <a-form-item label="新密码">
        <a-input-password v-model:value="form.newPassword" placeholder="请输入新密码" />
      </a-form-item>
      <a-form-item label="确认新密码">
        <a-input-password v-model:value="form.confirmPassword" placeholder="请再次输入新密码" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
