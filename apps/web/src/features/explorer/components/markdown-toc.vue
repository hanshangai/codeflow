<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from "vue";
import { CloseOutlined } from "@ant-design/icons-vue";
import type { TocHeading } from "../../markdown/renderMarkdown";

defineOptions({ name: "MarkdownToc" });

const props = defineProps<{
  headings: TocHeading[];
  scrollContainer: HTMLElement | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "navigate"): void;
}>();

const activeSlug = ref("");

function scrollToHeading(slug: string) {
  if (!props.scrollContainer) return;
  const el = props.scrollContainer.querySelector(`#${CSS.escape(slug)}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    activeSlug.value = slug;
    // 移动端点击后自动关闭抽屉
    if (window.innerWidth <= 767) {
      emit("navigate");
    }
  }
}

// ── Scroll-spy：监听滚动，高亮当前可见标题 ──
let rafId = 0;

function onScroll() {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(updateActiveHeading);
}

function updateActiveHeading() {
  const container = props.scrollContainer;
  if (!container || props.headings.length === 0) return;

  const scrollTop = container.scrollTop;
  const offset = 40;

  let current = props.headings[0]?.slug ?? "";
  for (const h of props.headings) {
    const el = container.querySelector(`#${CSS.escape(h.slug)}`);
    if (!el) continue;
    const top = (el as HTMLElement).offsetTop - (container as HTMLElement).offsetTop;
    if (top <= scrollTop + offset) {
      current = h.slug;
    } else {
      break;
    }
  }
  activeSlug.value = current;
}

watch(
  () => [props.visible, props.scrollContainer] as const,
  ([vis, el]) => {
    if (vis && el) {
      el.addEventListener("scroll", onScroll, { passive: true });
      nextTick(updateActiveHeading);
    }
  },
  { immediate: true },
);

watch(
  () => props.scrollContainer,
  (_newEl, oldEl) => {
    if (oldEl) oldEl.removeEventListener("scroll", onScroll);
  },
);

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  props.scrollContainer?.removeEventListener("scroll", onScroll);
});

function indentClass(level: number) {
  return `toc-item--h${level}`;
}
</script>

<template>
  <!-- 桌面端：右侧边栏 -->
  <Transition name="toc-slide">
    <div v-if="visible && headings.length > 0" class="markdown-toc markdown-toc--desktop">
      <div class="markdown-toc__header">
        <span class="markdown-toc__title">目录</span>
        <button class="markdown-toc__close" type="button" @click="emit('close')">
          <CloseOutlined />
        </button>
      </div>
      <ul class="markdown-toc__list">
        <li
          v-for="h in headings"
          :key="h.slug"
          :class="['markdown-toc__item', indentClass(h.level), { 'markdown-toc__item--active': activeSlug === h.slug }]"
          @click="scrollToHeading(h.slug)"
        >
          {{ h.text }}
        </li>
      </ul>
    </div>
  </Transition>

  <!-- 移动端：底部抽屉 + 遮罩 -->
  <Teleport to="body">
    <Transition name="toc-mask">
      <div v-if="visible && headings.length > 0" class="markdown-toc__mask markdown-toc--mobile" @click="emit('close')" />
    </Transition>
    <Transition name="toc-drawer">
      <div v-if="visible && headings.length > 0" class="markdown-toc markdown-toc--mobile markdown-toc--drawer">
        <div class="markdown-toc__header">
          <span class="markdown-toc__title">目录</span>
          <button class="markdown-toc__close" type="button" @click="emit('close')">
            <CloseOutlined />
          </button>
        </div>
        <ul class="markdown-toc__list">
          <li
            v-for="h in headings"
            :key="h.slug"
            :class="['markdown-toc__item', indentClass(h.level), { 'markdown-toc__item--active': activeSlug === h.slug }]"
            @click="scrollToHeading(h.slug)"
          >
            {{ h.text }}
          </li>
        </ul>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── 桌面端：flex 侧边栏 ── */
.markdown-toc--desktop {
  width: 220px;
  flex-shrink: 0;
  height: 100%;
  overflow-y: auto;
  background: var(--app-bg, #fff);
  border-left: 1px solid var(--app-divider, #f0f0f0);
  display: flex;
  flex-direction: column;
}

/* ── 移动端：底部抽屉 ── */
.markdown-toc--drawer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  max-height: 60vh;
  background: var(--app-bg, #fff);
  border-top: 1px solid var(--app-divider, #f0f0f0);
  border-radius: 12px 12px 0 0;
  z-index: 2001;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
}

.markdown-toc__mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 2000;
}

.markdown-toc__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.markdown-toc__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}

.markdown-toc__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px;
  color: var(--app-muted);
  font-size: 12px;
  border-radius: 4px;
}

.markdown-toc__close:hover {
  color: var(--app-text);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.markdown-toc__list {
  list-style: none;
  margin: 0;
  padding: 8px 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.markdown-toc__item {
  padding: 4px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-left: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.markdown-toc__item:hover {
  color: var(--app-text);
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.markdown-toc__item--active {
  color: var(--app-accent, #c96442);
  border-left-color: var(--app-accent, #c96442);
  font-weight: 500;
}

.toc-item--h1 { padding-left: 12px; }
.toc-item--h2 { padding-left: 24px; }
.toc-item--h3 { padding-left: 36px; }
.toc-item--h4 { padding-left: 48px; }

/* ── 桌面端 slide transition ── */
.toc-slide-enter-active,
.toc-slide-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.toc-slide-enter-from,
.toc-slide-leave-to {
  width: 0 !important;
  opacity: 0;
}

/* ── 移动端 drawer transition ── */
.toc-drawer-enter-active,
.toc-drawer-leave-active {
  transition: transform 0.25s ease;
}

.toc-drawer-enter-from,
.toc-drawer-leave-to {
  transform: translateY(100%);
}

.toc-mask-enter-active,
.toc-mask-leave-active {
  transition: opacity 0.25s ease;
}

.toc-mask-enter-from,
.toc-mask-leave-to {
  opacity: 0;
}

/* ── 响应式：桌面隐藏移动端元素，移动端隐藏桌面元素 ── */
.markdown-toc--mobile {
  display: none;
}

@media (max-width: 767px) {
  .markdown-toc--desktop {
    display: none !important;
  }
  .markdown-toc--mobile {
    display: flex;
  }
  .markdown-toc__mask.markdown-toc--mobile {
    display: block;
  }
  .markdown-toc__header {
    padding: 12px 16px;
  }
  .markdown-toc__title {
    font-size: 14px;
  }
  .markdown-toc__close {
    font-size: 14px;
    padding: 4px;
  }
  .markdown-toc__item {
    padding: 8px 16px;
    font-size: 14px;
  }
  .toc-item--h1 { padding-left: 16px; }
  .toc-item--h2 { padding-left: 28px; }
  .toc-item--h3 { padding-left: 40px; }
  .toc-item--h4 { padding-left: 52px; }
}
</style>
