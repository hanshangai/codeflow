<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getDesktopDownload, type DesktopDownloadInfo, type DesktopDownloadPackage } from "../../../api/desktopDownload";
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
const windowsPackage = computed<DesktopDownloadPackage | null>(() => info.value?.packages.find(
  item => item.platform === "win32" && item.arch === "x64") ?? null);
const macPackages = computed<Array<DesktopDownloadPackage | null>>(() => (["arm64", "x64"] as const).map(arch => info.value?.packages.find(
  item => item.platform === "darwin" && item.arch === arch) ?? null));

/** 下载地址只由服务端登记的相对路径拼接。 */
function downloadUrl(item: DesktopDownloadPackage): string {
  return `${wsOriginToHttpOrigin(config.serverWsOrigin)}${item.downloadPath}`;
}
/** 保留服务端真实展示号；缺少事实时只展示资源号。 */
function versionLabel(item: DesktopDownloadPackage): string {
  return item.displayVersion ? `版本 ${item.displayVersion}` : `应用版本未标记（资源版本 ${item.version}）`;
}
/** 卡片内的版本、日期与大小使用同一格式。 */
function packageMeta(item: DesktopDownloadPackage): string {
  return `${versionLabel(item)} · ${formatDate(item.publishedAt)} · ${(item.size / 1024 / 1024).toFixed(1)} MB`;
}

type DownloadPlatform = "windows" | "macos" | "other";
/** 仅用于排序和“当前设备”标记，不改变下载接口；Safari 无法可靠区分 Mac 芯片架构。 */
const currentPlatform = computed<DownloadPlatform>(() => {
  if (typeof navigator === "undefined") return "other";
  const userAgent = navigator.userAgent || "";
  if (/Macintosh|Mac OS X/iu.test(userAgent)) return "macos";
  if (/Windows/iu.test(userAgent)) return "windows";
  return "other";
});

/** 统一展示日期，避免不同地区格式不一致。 */
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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
function trackDownload(item: DesktopDownloadPackage): void {
  trackProductEvent("desktop_download_clicked", { source: "download_page", platform: item.platform, arch: item.arch, download_type: "full_installer" });
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
      <article :class="{ 'desktop-download__package--current': currentPlatform === 'windows' }">
        <header class="desktop-download__platform-head">
          <h2>Windows</h2>
          <span v-if="currentPlatform === 'windows'" class="desktop-download__current">当前设备</span>
        </header>
        <p>Windows x64 · 完整安装包</p>
        <a-spin v-if="loading" tip="读取可用版本..." />
        <template v-else-if="windowsPackage">
          <p>{{ packageMeta(windowsPackage) }}</p>
          <a-button type="primary" size="large" :href="downloadUrl(windowsPackage)" @click="trackDownload(windowsPackage)">下载 Windows 桌面版（x64）</a-button>
        </template>
        <template v-else>
          <a-alert type="warning" show-icon :message="error || 'Windows 安装包准备中'" />
          <a-button v-if="error" @click="load">重新获取安装包</a-button>
        </template>
      </article>
      <article :class="{ 'desktop-download__package--current': currentPlatform === 'macos' }">
        <header class="desktop-download__platform-head">
          <h2>macOS</h2>
          <span v-if="currentPlatform === 'macos'" class="desktop-download__current">当前设备</span>
        </header>
        <p>完整安装包 · 支持 Apple Silicon 与 Intel</p>
        <div class="desktop-download__arch-list">
          <div v-for="(item, index) in macPackages" :key="index" class="desktop-download__arch-row">
            <div>
              <strong>{{ index === 0 ? "Apple Silicon" : "Intel" }}</strong>
              <span>{{ index === 0 ? "M1 / M2 / M3 及后续芯片" : "Intel 芯片 Mac" }}</span>
              <small v-if="item">{{ packageMeta(item) }}</small>
              <small v-else-if="loading">读取中…</small>
              <small v-else-if="error">读取失败</small>
            </div>
            <a-button v-if="item" type="primary" :href="downloadUrl(item)" @click="trackDownload(item)">
              下载 {{ index === 0 ? "Apple Silicon" : "Intel" }} 版
            </a-button>
            <a-button v-else disabled>{{ loading ? "读取中" : error ? "读取失败" : "准备中" }}</a-button>
          </div>
        </div>
        <p class="desktop-download__arch-hint">不确定芯片类型：苹果菜单 → 关于本机 → 芯片。Apple Silicon 也可通过 Rosetta 运行 Intel 版本。</p>
      </article>
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
.desktop-download__content { padding: 16px max(24px, calc((100vw - 1080px) / 2)) 72px; }
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
.desktop-download__package--current { border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border)); }
.desktop-download__packages h2, .desktop-download__steps h2 { margin: 0 0 10px; font-size: 22px; }
.desktop-download__packages article > p:first-of-type { margin-top: 0; }
.desktop-download__platform-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.desktop-download__current {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-accent);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.desktop-download__arch-list { display: grid; gap: 10px; margin: 4px 0 12px; }
.desktop-download__arch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
}
.desktop-download__arch-row > div { display: grid; gap: 2px; min-width: 0; }
.desktop-download__arch-row strong { font-size: 14px; }
.desktop-download__arch-row span { color: var(--app-muted); font-size: 12px; }
.desktop-download__arch-row small { color: var(--app-muted); font-size: 12px; }
.desktop-download__arch-hint { margin: 0; font-size: 12px; }
.desktop-download__steps { margin-top: 24px; scroll-margin-top: 24px; }
@media (max-width: 720px) {
  .desktop-download__content { padding-top: 16px; }
  .desktop-download__packages { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .desktop-download__arch-row { flex-direction: column; align-items: stretch; }
  .desktop-download__arch-row .ant-btn { width: 100%; }
}
</style>
