<script setup lang="ts">
import { ref, watch } from "vue";

defineOptions({ name: "AddMemberModal" });

const COPY = {
  title: "添加企业成员",
  emailLabel: "成员邮箱",
  emailPlaceholder: "请输入完整邮箱，例如 name@company.com",
  cancel: "取消",
  confirm: "添加",
} as const;

const props = defineProps<{
  open: boolean;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "add", email: string): void;
}>();

const email = ref("");

watch(
  () => props.open,
  (open) => {
    if (!open) email.value = "";
  },
);

function close() {
  emit("update:open", false);
}

function submit() {
  const value = email.value.trim();
  if (!value) return;
  emit("add", value);
}
</script>

<template>
  <a-modal
    :open="open"
    :title="COPY.title"
    :footer="null"
    width="560px"
    @cancel="close"
  >
    <div class="add-member-modal">
      <a-form layout="vertical" :colon="false">
        <a-form-item :label="COPY.emailLabel">
          <a-input
            v-model:value="email"
            :placeholder="COPY.emailPlaceholder"
            autocomplete="email"
            @press-enter="submit"
          />
        </a-form-item>
      </a-form>

      <div class="add-member-modal__actions">
        <a-button @click="close">{{ COPY.cancel }}</a-button>
        <a-button type="primary" :loading="submitting" :disabled="!email.trim()" @click="submit">{{ COPY.confirm }}</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.add-member-modal {
  display: grid;
  gap: 16px;
}

.add-member-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
