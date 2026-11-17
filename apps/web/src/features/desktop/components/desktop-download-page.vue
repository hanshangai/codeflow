<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatDesktopVersion } from "@codeflowai/shared";
import { version as desktopShellVersion } from "../../../../../desktop/package.json";
import { getDesktopDownload, type DesktopDownloadInfo } from "../../../api/desktopDownload";
import { wsOriginToHttpOrigin } from "../../../api/request";
import { trackProductEvent } from "../../../analytics/analytics";
import { useConfigStore } from "../../../store/config";
import LandingNav from "../../landing/components/LandingNav.vue";

defineOptions({ name: "DesktopDownloadPage" });
const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();
const config = useConfigStore();
const router = useRouter();
const route = useRoute();
const migrationSection = ref<HTMLElement | null>(null);
const info = ref<DesktopDownloadInfo | null>(null);
const loading = ref(false);
const error = ref("");
let request: AbortController | undefined;
const downloadUrl = computed(() => info.value ? `${wsOriginToHttpOrigin(config.serverWsOrigin)}${info.value.downloadPath}` : "");
const displayVersion = computed(() => info.value ? formatDesktopVersion(desktopShellVersion, info.value.version) : "");

/** 服务切换或重试均作废旧响应，失败在页面明确展示并记录请求归属。 */
async function load(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const origin = config.serverWsOrigin;
  const requestId = `desktop-download-${Date.now()}`;
  info.value = null; error.value = ""; loading.value = true;
  try {
    const result = await getDesktopDownload(origin, controller.signal);
    if (request === controller) info.value = result;
  } catch (cause) {
    if (controller.signal.aborted) return;
    error.value = cause instanceof Error ? cause.message : "桌面安装包信息读取失败";
    console.error("[DESKTOP_DOWNLOAD_LOAD_FAILED]", { errorCode: "DESKTOP_DOWNLOAD_LOAD_FAILED", requestId, serverOrigin: origin, rootCause: error.value });
  } finally {
    if (request === controller) loading.value = false;
  }
}

/** 仅记录下载点击，安装与迁移结果由桌面端真实流程决定。 */
function trackDownload(): void {
  trackProductEvent("desktop_download_clicked", { source: "download_page", platform: "win32", download_type: "full_installer" });
}
/** 异步页面挂载后定位内滚动区，兼容直达链接和旧 guide 重定向。 */
async function scrollToMigration(): Promise<void> {
  if (route.hash !== "#migration") return;
  await nextTick();
  migrationSection.value?.scrollIntoView({ block: "start" });
}
onMounted(scrollToMigration);
watch(() => route.hash, scrollToMigration, { flush: "post" });
watch(() => config.serverWsOrigin, load, { immediate: true });
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <div class="desktop-download">
    <LandingNav @open-settings="emit('open-settings')" @enter-app="emit('enter-app')" />
    <main class="desktop-download__content">
    <section class="desktop-download__packages" aria-label="桌面版下载">
      <article>
        <h2>Windows</h2><p>Windows x64 · 完整安装包</p>
        <a-spin v-if="loading" tip="读取可用版本..." />
        <template v-else-if="info">
          <p>版本 {{ displayVersion }} · {{ new Date(info.publishedAt).toLocaleDateString() }} · {{ (info.size / 1024 / 1024).toFixed(1) }} MB</p>
          <a-button type="primary" size="large" :href="downloadUrl" @click="trackDownload">下载 Windows 桌面版</a-button>
        </template>
        <template v-else>
          <a-alert type="warning" show-icon :message="error" />
          <a-button @click="load">重新获取安装包</a-button>
        </template>
      </article>
      <article><h2>macOS</h2><p>暂未提供可下载的完整安装包。</p><a-button disabled size="large">暂未提供</a-button></article>
    </section>
    <section class="desktop-download__steps"><h2>首次使用</h2><ol><li>下载完整安装包，按安装程序提示完成安装。</li><li>打开 CodeFlow 桌面版，创建工作区开始使用。</li><li>需要企业、Token 和云端功能时，使用原账号登录或注册账号。</li></ol></section>
    <section id="migration" ref="migrationSection" class="desktop-download__steps"><h2>从旧 Client 迁移</h2><ol><li>请在旧 Client 所在电脑、同一系统用户下安装桌面版。</li><li>首次启动后，桌面版会检测可迁移的旧工作区；确认“开始迁移”后执行。</li><li>迁移完成后核对工作区、会话和配置，再使用桌面版继续工作。</li></ol><a-alert type="info" show-icon message="迁移前请保留旧数据。自动检测不覆盖任意历史目录、其他账号数据或浏览器设置；未检测到时请查看迁移说明或联系支持。" /><a-button type="link" @click="router.push('/contact')">获取迁移帮助</a-button></section>
    </main>
  </div>
</template>

<style scoped>
.desktop-download {
  min-height: 100vh;
  overflow: auto;
  background:
    radial-gradient(1100px 420px at 50% -120px, rgba(217, 119, 87, 0.11), transparent 70%),
    var(--app-bg);
  color: var(--app-text);
}
.desktop-download__content { padding: 36px max(24px, calc((100vw - 1080px) / 2)) 72px; }
.desktop-download p, .desktop-download li { color: var(--app-muted); line-height: 1.8; }
.desktop-download__packages { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.desktop-download__packages article,
.desktop-download__steps {
  border: 1px solid var(--app-border);
  border-radius: 22px;
  padding: 28px;
  background: var(--app-panel-bg);
  box-shadow: 0 12px 30px rgba(92, 64, 38, 0.05);
}
.desktop-download__packages article { transition: transform 0.2s ease, box-shadow 0.2s ease; }
.desktop-download__packages article:hover { transform: translateY(-2px); box-shadow: 0 18px 40px rgba(92, 64, 38, 0.1); }
.desktop-download__packages article:first-child { border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border)); }
.desktop-download__packages h2, .desktop-download__steps h2 { margin: 0 0 10px; font-size: 22px; }
.desktop-download__packages article > p:first-of-type { margin-top: 0; }
.desktop-download__steps { margin-top: 24px; scroll-margin-top: 24px; }
@media (max-width: 720px) {
  .desktop-download__content { padding-top: 24px; }
  .desktop-download__packages { grid-template-columns: minmax(0, 1fr); gap: 16px; }
}
</style>
