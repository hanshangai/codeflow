<script setup lang="ts">
import { ExclamationCircleOutlined, InfoCircleOutlined, CloseCircleOutlined, CheckCircleOutlined } from "@ant-design/icons-vue";
import type { ConversationSystemMessage } from "@codeflowai/shared";

defineOptions({ name: "SystemMessageItem" });

type Props = {
  item: ConversationSystemMessage;
};

const props = defineProps<Props>();
/** 点 ✕ 时把 item id 抛给上层，由上层记录「该提示已被用户关闭」。 */
const emit = defineEmits<{ (e: "close", id: string): void }>();

function getAlertType(type: ConversationSystemMessage["type"]): "info" | "warning" | "error" | "success" {
  return type;
}

function getIcon(type: ConversationSystemMessage["type"]) {
  switch (type) {
    case "info":
      return InfoCircleOutlined;
    case "warning":
      return ExclamationCircleOutlined;
    case "error":
      return CloseCircleOutlined;
    case "success":
      return CheckCircleOutlined;
    default:
      return InfoCircleOutlined;
  }
}
</script>

<template>
  <div class="system-message">
    <a-alert :type="getAlertType(item.type)" show-icon closable @close="emit('close', String(item.id))">
      <template #icon>
        <component :is="getIcon(item.type)" />
      </template>
      <template #message>
        <span>{{ item.text }}</span>
      </template>
    </a-alert>
  </div>
</template>

<style scoped>
.system-message {
  margin-bottom: 12px;
  margin-left: 38px;
}

@media (max-width: 767px) {
  .system-message {
    margin-left: 32px;
  }
}
</style>

