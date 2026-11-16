<script setup lang="ts">
defineOptions({ name: "AppWindowControls" });

withDefaults(defineProps<{ maximized?: boolean }>(), { maximized: false });

defineEmits<{
  (e: "minimize"): void;
  (e: "toggle"): void;
  (e: "close"): void;
}>();
</script>

<template>
  <div class="app-titlebar__controls" aria-label="窗口控制">
    <button type="button" class="app-titlebar__control" title="最小化" aria-label="最小化" data-testid="window-minimize" @click="$emit('minimize')">
      <svg class="app-titlebar__control-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6h9" /></svg>
    </button>
    <button
      type="button"
      class="app-titlebar__control"
      :title="maximized ? '还原' : '最大化'"
      :aria-label="maximized ? '还原' : '最大化'"
      data-testid="window-maximize"
      @click="$emit('toggle')"
    >
      <svg v-if="!maximized" class="app-titlebar__control-icon" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.2" />
      </svg>
      <svg v-else class="app-titlebar__control-icon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 1.5h6v6" />
        <rect x="1.5" y="4.5" width="6" height="6" rx="1.2" />
      </svg>
    </button>
    <button type="button" class="app-titlebar__control app-titlebar__control--close" title="关闭" aria-label="关闭" data-testid="window-close" @click="$emit('close')">
      <svg class="app-titlebar__control-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
    </button>
  </div>
</template>
