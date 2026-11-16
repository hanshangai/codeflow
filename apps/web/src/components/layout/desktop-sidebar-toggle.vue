<script setup lang="ts">
import { LeftOutlined, RightOutlined } from "@ant-design/icons-vue";

defineOptions({ name: "DesktopSidebarToggle" });

const props = withDefaults(defineProps<{
  collapsed: boolean;
  controls: string;
}>(), {
  controls: "desktop-left-sidebar-content",
});

const emit = defineEmits<{
  (event: "toggle"): void;
}>();

function toggle(): void {
  emit("toggle");
}
</script>

<template>
  <button
    class="desktop-sidebar-toggle"
    data-testid="desktop-sidebar-toggle"
    type="button"
    :aria-label="props.collapsed ? '展开左侧边栏' : '收起左侧边栏'"
    :title="props.collapsed ? '展开左侧边栏' : '收起左侧边栏'"
    :aria-expanded="!props.collapsed"
    :aria-controls="props.controls"
    @click="toggle"
  >
    <RightOutlined v-if="props.collapsed" aria-hidden="true" />
    <LeftOutlined v-else aria-hidden="true" />
  </button>
</template>

<style scoped>
.desktop-sidebar-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--app-divider, #e5e7eb);
  border-radius: 6px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-muted, #667085);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.1);
  cursor: pointer;
  line-height: 1;
  transition: color 180ms ease, border-color 180ms ease, background-color 180ms ease;
}

.desktop-sidebar-toggle:hover,
.desktop-sidebar-toggle:focus-visible {
  border-color: var(--app-accent, #c96442);
  background: var(--app-sidebar-hover-bg, #f7f8fa);
  color: var(--app-accent, #c96442);
}

.desktop-sidebar-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent, #c96442) 55%, transparent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-sidebar-toggle {
    transition-duration: 0ms;
  }
}
</style>
