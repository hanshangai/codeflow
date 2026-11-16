<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConfigStore } from "../../store/config";
import { pushLoginRoute } from "../account/loginRedirect";
import DesktopOrchestrationMetricsPanel from "./DesktopOrchestrationMetricsPanel.vue";

const OrchestrationMetricsPanel = defineAsyncComponent(() => import("./OrchestrationMetricsPanel.vue"));
const config = useConfigStore();
const route = useRoute();
const router = useRouter();
const scope = ref<"local" | "cloud">("local");
const scopeOptions = [{ label: "本机工作区", value: "local" }, { label: "账号 / 企业云端分析", value: "cloud" }];

/** 云端分析沿现有登录入口进入，保留当前页面作为返回位置。 */
function login(): void {
  void pushLoginRoute(router, { currentFullPath: route.fullPath });
}
</script>

<template>
  <OrchestrationMetricsPanel v-if="!config.isDesktop" />
  <section v-else class="metrics-entry">
    <a-segmented v-model:value="scope" :options="scopeOptions" block aria-label="度量数据范围" />
    <div class="metrics-entry__content">
      <DesktopOrchestrationMetricsPanel v-if="scope === 'local'" />
      <OrchestrationMetricsPanel v-else-if="config.hasActiveSession" />
      <div v-else class="metrics-entry__login">
        <a-empty description="登录云账号后查看账号或企业汇总分析" />
        <a-button type="primary" @click="login">登录云账号</a-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.metrics-entry {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.metrics-entry__content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.metrics-entry__login {
  height: 100%;
  overflow: auto;
  display: grid;
  grid-auto-rows: max-content;
  align-content: center;
  justify-items: center;
  gap: 12px;
}
</style>
