<script setup lang="ts">
import { useDesktopWindowControls } from "../../composables/useDesktopWindowControls";
import AppWindowControls from "./window-controls.vue";

const { controls, maximized, minimize, toggleMaximize, close } = useDesktopWindowControls();
/** macOS 使用原生红绿灯，保留拖拽区但不渲染 Web 窗口按钮。 */
const isMacDesktop = typeof window !== "undefined" && window.codeflowDesktop?.platform === "darwin";
</script>

<template>
  <!-- 顶部栏在公共页/窄窗口被隐藏时，仍需为无边框窗口保留拖拽区与窗口控制。 -->
  <div v-if="controls" class="desktop-window-bar" :class="{ 'desktop-window-bar--mac': isMacDesktop }">
    <div class="desktop-window-bar__drag">
      <img src="/favicon.svg" alt="" class="desktop-window-bar__logo" />
      <span>CodeFlow</span>
    </div>
    <AppWindowControls
      v-if="!isMacDesktop"
      :maximized="maximized"
      @minimize="minimize"
      @toggle="toggleMaximize"
      @close="close"
    />
  </div>
</template>
