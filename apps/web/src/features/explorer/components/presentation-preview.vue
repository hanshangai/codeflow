<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  LeftOutlined,
  MinusOutlined,
  PlusOutlined,
  RightOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons-vue";
import type { PptxViewer, SlideHandle } from "@aiden0z/pptx-renderer";

defineOptions({ name: "PresentationPreview" });

const props = defineProps<{
  base64: string;
  filePath?: string | null;
}>();

const mainHost = ref<HTMLElement | null>(null);
const sidebarHost = ref<HTMLElement | null>(null);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const partialWarning = ref(false);
const thumbnailWarning = ref<string | null>(null);
const thumbnailErrors = ref<Record<number, string>>({});
const currentSlide = ref(0);
const slideCount = ref(0);
const zoomPercent = ref(100);
const thumbnailsVisible = ref(true);
const thumbnailHosts = new Map<number, HTMLElement>();
const thumbnailHandles = new Map<number, SlideHandle>();
let viewer: PptxViewer | null = null;
let thumbnailViewer: PptxViewer | null = null;
let thumbnailObserver: IntersectionObserver | null = null;
let loadController: AbortController | null = null;
let loadGeneration = 0;

const fileName = computed(() => {
  const path = String(props.filePath ?? "").trim();
  return path.split(/[\\/]/).pop() || "演示文稿";
});
const canGoPrevious = computed(() => currentSlide.value > 0);
const canGoNext = computed(() => currentSlide.value + 1 < slideCount.value);
const canZoomOut = computed(() => zoomPercent.value > 50);
const canZoomIn = computed(() => zoomPercent.value < 200);

/** 把文档接口返回的 base64 转为渲染器需要的 ArrayBuffer。 */
function decodeBase64(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** 记录缩略图挂载元素，供渲染器在 Vue 完成列表更新后写入内容。 */
function setThumbnailHost(index: number, element: Element | null): void {
  const previous = thumbnailHosts.get(index);
  if (previous && previous !== element) thumbnailObserver?.unobserve(previous);
  if (element instanceof HTMLElement) {
    thumbnailHosts.set(index, element);
    thumbnailObserver?.observe(element);
    return;
  }
  thumbnailHosts.delete(index);
}

/** 释放单页缩略图资源，保留列表占位元素供后续重新渲染。 */
function disposeThumbnail(index: number): void {
  thumbnailHandles.get(index)?.dispose();
  thumbnailHandles.delete(index);
  thumbnailHosts.get(index)?.replaceChildren();
}

/** 释放外部缩略图句柄，避免图表实例和 Blob URL 泄漏。 */
function disposeThumbnails(): void {
  for (const index of [...thumbnailHandles.keys()]) disposeThumbnail(index);
}

/** 中止当前解析并销毁渲染器拥有的 DOM、图表和媒体资源。 */
function disposeViewer(): void {
  loadController?.abort();
  loadController = null;
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  disposeThumbnails();
  thumbnailViewer?.destroy();
  thumbnailViewer = null;
  viewer?.destroy();
  viewer = null;
  mainHost.value?.replaceChildren();
}

/** 记录单页缩略图失败，不影响主画布和其他页面继续使用。 */
function markThumbnailFailed(index: number, error: unknown, generation: number): void {
  if (generation !== loadGeneration) return;
  disposeThumbnail(index);
  partialWarning.value = true;
  thumbnailErrors.value = {
    ...thumbnailErrors.value,
    [index]: error instanceof Error ? error.message : String(error || "缩略图渲染失败"),
  };
}

/** 按需渲染单页缩略图，并把同步及异步错误隔离在当前页。 */
async function renderThumbnail(activeViewer: PptxViewer, index: number, generation: number): Promise<void> {
  if (
    generation !== loadGeneration
    || activeViewer !== thumbnailViewer
    || thumbnailHandles.has(index)
    || thumbnailErrors.value[index]
  ) return;
  const host = thumbnailHosts.get(index);
  if (!host) return;

  let handle: SlideHandle | null = null;
  try {
    handle = activeViewer.renderThumbnailToContainer(index, host, { width: 132 });
    if (!handle) throw new Error("缩略图渲染器未返回页面内容");
    thumbnailHandles.set(index, handle);
    await handle.ready;
  } catch (error) {
    if (handle && thumbnailHandles.get(index) !== handle) return;
    markThumbnailFailed(index, error, generation);
  }
}

/** 建立缩略图可视区观察器，只保留当前视口及前后缓冲区内的页面资源。 */
async function setupThumbnailObserver(activeViewer: PptxViewer, generation: number): Promise<void> {
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  disposeThumbnails();
  await nextTick();
  if (generation !== loadGeneration || activeViewer !== thumbnailViewer) return;

  if (typeof IntersectionObserver === "undefined") {
    thumbnailWarning.value = "当前浏览器不支持缩略图懒加载，仅按需显示当前页缩略图。";
    await renderThumbnail(activeViewer, currentSlide.value, generation);
    return;
  }

  thumbnailObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.thumbnailIndex);
      if (!Number.isInteger(index)) continue;
      if (entry.isIntersecting) {
        void renderThumbnail(activeViewer, index, generation);
      } else if (index !== currentSlide.value) {
        disposeThumbnail(index);
      }
    }
  }, {
    root: sidebarHost.value,
    rootMargin: "320px 0px",
    threshold: 0.01,
  });
  for (const host of thumbnailHosts.values()) thumbnailObserver.observe(host);
}

/** 让当前页缩略图进入可视区域，并确保无观察器时也能按需渲染。 */
async function syncActiveThumbnail(index: number): Promise<void> {
  await nextTick();
  const activeThumbnailViewer = thumbnailViewer;
  if (!activeThumbnailViewer) return;
  const item = sidebarHost.value?.querySelector<HTMLElement>(`[data-thumbnail-item="${index}"]`);
  item?.scrollIntoView({ block: "nearest" });
  await renderThumbnail(activeThumbnailViewer, index, loadGeneration);
}

/** 加载并渲染当前 PPTX，旧请求结果通过 generation 和 AbortSignal 双重隔离。 */
async function loadPresentation(): Promise<void> {
  const generation = ++loadGeneration;
  disposeViewer();
  loading.value = true;
  errorMessage.value = null;
  partialWarning.value = false;
  thumbnailWarning.value = null;
  thumbnailErrors.value = {};
  currentSlide.value = 0;
  slideCount.value = 0;
  zoomPercent.value = 100;

  const controller = new AbortController();
  loadController = controller;
  try {
    await nextTick();
    const host = mainHost.value;
    if (!host) throw new Error("演示文稿预览容器未就绪");

    const { PptxViewer: Viewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
    if (controller.signal.aborted || generation !== loadGeneration) return;

    const activeViewer = await Viewer.open(decodeBase64(props.base64), host, {
      renderMode: "slide",
      fitMode: "contain",
      zoomPercent: zoomPercent.value,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      signal: controller.signal,
      onSlideChange: (index) => {
        if (generation === loadGeneration) currentSlide.value = index;
      },
      onSlideError: () => {
        if (generation === loadGeneration) partialWarning.value = true;
      },
      onNodeError: () => {
        if (generation === loadGeneration) partialWarning.value = true;
      },
    });
    if (controller.signal.aborted || generation !== loadGeneration) {
      activeViewer.destroy();
      return;
    }

    viewer = activeViewer;
    slideCount.value = activeViewer.slideCount;
    if (slideCount.value < 1) throw new Error("演示文稿没有可预览的幻灯片");
    const presentationData = activeViewer.presentationData;
    if (!presentationData) throw new Error("演示文稿解析结果不可用");
    thumbnailViewer = new Viewer(document.createElement("div"), {
      pdfjs: false,
      onSlideError: () => {
        if (generation === loadGeneration) partialWarning.value = true;
      },
      onNodeError: () => {
        if (generation === loadGeneration) partialWarning.value = true;
      },
    });
    thumbnailViewer.load(presentationData);
    await setupThumbnailObserver(thumbnailViewer, generation);
    await syncActiveThumbnail(currentSlide.value);
  } catch (error) {
    if (controller.signal.aborted || generation !== loadGeneration) return;
    errorMessage.value = error instanceof Error ? error.message : "演示文稿预览失败";
    disposeViewer();
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
      if (loadController === controller) loadController = null;
    }
  }
}

/** 跳转到指定幻灯片并显式展示渲染失败。 */
async function goToSlide(index: number): Promise<void> {
  const activeViewer = viewer;
  if (!activeViewer || index < 0 || index >= slideCount.value) return;
  try {
    await activeViewer.goToSlide(index);
    currentSlide.value = activeViewer.currentSlideIndex;
    await syncActiveThumbnail(currentSlide.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "切换幻灯片失败";
  }
}

/** 更新演示文稿缩放比例，范围限定为 50% 到 200%。 */
async function setZoom(next: number): Promise<void> {
  const activeViewer = viewer;
  if (!activeViewer) return;
  const normalized = Math.min(200, Math.max(50, Math.round(next / 10) * 10));
  try {
    await activeViewer.setZoom(normalized);
    zoomPercent.value = normalized;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "调整演示文稿缩放失败";
  }
}

watch(() => props.base64, () => void loadPresentation(), { immediate: true });
watch(thumbnailsVisible, (visible) => {
  if (visible) void syncActiveThumbnail(currentSlide.value);
});
onBeforeUnmount(() => {
  loadGeneration += 1;
  disposeViewer();
});
</script>

<template>
  <div class="presentation-preview">
    <div class="presentation-preview__toolbar">
      <a-tooltip :title="thumbnailsVisible ? '隐藏缩略图' : '显示缩略图'">
        <a-button
          class="presentation-preview__thumbnail-toggle"
          size="small"
          type="text"
          :aria-label="thumbnailsVisible ? '隐藏缩略图' : '显示缩略图'"
          @click="thumbnailsVisible = !thumbnailsVisible"
        >
          <UnorderedListOutlined />
        </a-button>
      </a-tooltip>
      <span class="presentation-preview__filename" :title="fileName">{{ fileName }}</span>
      <span class="presentation-preview__spacer" />
      <a-button size="small" type="text" title="上一页" :disabled="!canGoPrevious" @click="goToSlide(currentSlide - 1)">
        <LeftOutlined />
      </a-button>
      <span class="presentation-preview__page">{{ slideCount ? currentSlide + 1 : 0 }} / {{ slideCount }}</span>
      <a-button size="small" type="text" title="下一页" :disabled="!canGoNext" @click="goToSlide(currentSlide + 1)">
        <RightOutlined />
      </a-button>
      <span class="presentation-preview__divider" />
      <a-button size="small" type="text" title="缩小" :disabled="!canZoomOut" @click="setZoom(zoomPercent - 10)">
        <MinusOutlined />
      </a-button>
      <button type="button" class="presentation-preview__zoom" title="恢复 100%" @click="setZoom(100)">{{ zoomPercent }}%</button>
      <a-button size="small" type="text" title="放大" :disabled="!canZoomIn" @click="setZoom(zoomPercent + 10)">
        <PlusOutlined />
      </a-button>
    </div>

    <div v-if="!errorMessage && (thumbnailWarning || partialWarning)" class="presentation-preview__warning">
      {{ thumbnailWarning || "部分复杂元素未能完整渲染，下载原文件可查看完整内容。" }}
    </div>

    <div class="presentation-preview__body">
      <aside
        v-show="thumbnailsVisible && slideCount"
        ref="sidebarHost"
        class="presentation-preview__sidebar"
      >
        <button
          v-for="index in slideCount"
          :key="index"
          type="button"
          class="presentation-preview__thumbnail"
          :class="{ 'presentation-preview__thumbnail--active': currentSlide === index - 1 }"
          :data-thumbnail-item="index - 1"
          :aria-label="`查看第 ${index} 页`"
          @click="goToSlide(index - 1)"
        >
          <span class="presentation-preview__thumbnail-number">{{ index }}</span>
          <span
            v-if="thumbnailErrors[index - 1]"
            class="presentation-preview__thumbnail-error"
            :title="thumbnailErrors[index - 1]"
          >
            缩略图不可用
          </span>
          <span
            v-else
            :ref="(element) => setThumbnailHost(index - 1, element as Element | null)"
            class="presentation-preview__thumbnail-host"
            :data-thumbnail-index="index - 1"
          />
        </button>
      </aside>

      <main class="presentation-preview__stage">
        <div ref="mainHost" class="presentation-preview__render-host" />
        <div v-if="loading" class="presentation-preview__state">
          <a-spin size="large" />
          <span>正在解析演示文稿...</span>
        </div>
        <div v-else-if="errorMessage" class="presentation-preview__state presentation-preview__state--error">
          <strong>无法预览该演示文稿</strong>
          <span>{{ errorMessage }}</span>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.presentation-preview {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--app-bg, #f5f7fa);
}

.presentation-preview__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 40px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-border, #e5e7eb);
  background: var(--app-surface, #fff);
  flex: 0 0 auto;
}

.presentation-preview__filename {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  color: var(--app-text, #1f2937);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.presentation-preview__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.presentation-preview__page,
.presentation-preview__zoom {
  min-width: 52px;
  color: var(--app-text, #1f2937);
  font-size: 12px;
  text-align: center;
  white-space: nowrap;
}

.presentation-preview__zoom {
  height: 24px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.presentation-preview__zoom:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.presentation-preview__divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--app-border, #e5e7eb);
}

.presentation-preview__warning {
  padding: 5px 12px;
  border-bottom: 1px solid #ffe58f;
  background: #fffbe6;
  color: #8c6d1f;
  font-size: 12px;
  line-height: 1.5;
  flex: 0 0 auto;
}

.presentation-preview__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.presentation-preview__sidebar {
  width: 164px;
  padding: 10px;
  overflow: auto;
  border-right: 1px solid var(--app-border, #e5e7eb);
  background: var(--app-surface, #fff);
  flex: 0 0 164px;
}

.presentation-preview__thumbnail {
  position: relative;
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 5px;
  overflow: hidden;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

.presentation-preview__thumbnail:hover {
  border-color: #69b1ff;
}

.presentation-preview__thumbnail--active {
  border-color: #1677ff;
  box-shadow: 0 0 0 1px #1677ff;
}

.presentation-preview__thumbnail-number {
  position: absolute;
  z-index: 2;
  top: 4px;
  left: 4px;
  min-width: 18px;
  padding: 1px 4px;
  border-radius: 2px;
  background: rgba(17, 24, 39, 0.78);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
}

.presentation-preview__thumbnail-host {
  display: flex;
  justify-content: center;
  width: 132px;
  min-height: 74px;
  overflow: hidden;
  background: #fff;
}

.presentation-preview__thumbnail-error {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 132px;
  min-height: 74px;
  padding: 8px;
  background: #f5f5f5;
  color: #8c8c8c;
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
}

.presentation-preview__stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 16px;
  overflow: auto;
  background: #e9edf2;
}

.presentation-preview__render-host {
  width: 100%;
  min-width: 480px;
  min-height: 100%;
}

.presentation-preview__state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  background: rgba(245, 247, 250, 0.92);
  color: var(--app-muted, #6b7280);
  font-size: 12px;
  text-align: center;
}

.presentation-preview__state--error strong {
  color: #cf1322;
  font-size: 14px;
}

@media (max-width: 767px) {
  .presentation-preview__toolbar {
    padding-inline: 4px;
  }

  .presentation-preview__filename,
  .presentation-preview__divider,
  .presentation-preview__sidebar,
  .presentation-preview__thumbnail-toggle {
    display: none;
  }

  .presentation-preview__stage {
    padding: 8px;
  }

  .presentation-preview__render-host {
    min-width: 320px;
  }
}
</style>
