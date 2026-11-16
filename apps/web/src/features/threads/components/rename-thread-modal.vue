<script setup lang="ts">
import { ref, watch } from "vue";
import { message } from "ant-design-vue";

defineOptions({ name: "RenameThreadModal" });

type Props = {
  open: boolean;
  saving: boolean;
  initialTitle: string;
};

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  (e: "confirm", payload: { title: string }): void;
}>();

const title = ref("");

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    title.value = String(props.initialTitle ?? "");
  },
);

const onOk = () => {
  const trimmed = title.value.trim();
  if (!trimmed) {
    message.error("请输入会话名称");
    return;
  }
  emit("confirm", { title: trimmed });
};
const onCancel = () => emit("update:open", false);
</script>

<template>
  <a-modal :open="open" title="重命名会话" :confirm-loading="saving" :mask-closable="false" ok-text="确定" cancel-text="取消" @ok="onOk" @cancel="onCancel">
    <a-form layout="vertical" autocomplete="off">
      <a-form-item label="会话名称">
        <a-input
          v-model:value="title"
          name="codeflow-thread-rename-title"
          autocomplete="new-password"
          placeholder="例如：修复登录页样式 / 排查接口超时"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

