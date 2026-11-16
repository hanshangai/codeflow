<script setup lang="ts">
import { computed } from "vue";
import { InboxOutlined, LoadingOutlined } from "@ant-design/icons-vue";

const props = withDefaults(defineProps<{ loading?: boolean; text?: string }>(), { loading: false, text: "" });
const label = computed(() => props.text || (props.loading ? "加载中" : "暂无内容"));
</script>

<template>
  <div class="explorer-panel-state" :class="{ 'explorer-panel-state--loading': loading }">
    <LoadingOutlined v-if="loading" spin class="explorer-panel-state__icon" />
    <InboxOutlined v-else class="explorer-panel-state__icon" />
    <span class="explorer-panel-state__text">{{ label }}</span>
  </div>
</template>

<style scoped>
.explorer-panel-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 100%;
  padding: 32px 16px;
  box-sizing: border-box;
  color: var(--app-muted);
  font-size: 13px;
  text-align: center;
}

.explorer-panel-state__icon {
  font-size: 30px;
}

.explorer-panel-state--loading .explorer-panel-state__icon {
  color: var(--app-accent);
}

.explorer-panel-state__text {
  line-height: 1.5;
}
</style>
