<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import * as monaco from "monaco-editor";
import { ensureMonacoEnv } from "../../../composables/useMonacoEnv";
import { useUiStore } from "../../../store/ui";

defineOptions({ name: "DiffViewer" });

type Props = {
  original: string;
  modified: string;
  /** 文件路径，用于推断语言高亮 */
  filePath?: string;
  /** side-by-side（默认）或 inline */
  inline?: boolean;
  /** 折叠无变化区域，只显示有差异的部分 */
  hideUnchanged?: boolean;
  /** 预览缩放比例（通过 Monaco 字体大小实现）。 */
  fontScale?: number;
};

const props = withDefaults(defineProps<Props>(), {
  filePath: "",
  inline: false,
  hideUnchanged: false,
  fontScale: 1,
});

const ui = useUiStore();

const isDark = computed(() => {
  if (ui.themeMode === "dark") return true;
  if (ui.themeMode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
});

const containerRef = ref<HTMLElement | null>(null);
const editorReady = ref(false);
let diffEditor: monaco.editor.IDiffEditor | null = null;
let diffSubscription: monaco.IDisposable | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let focusDisposables: monaco.IDisposable[] = [];
let resizeObserver: ResizeObserver | null = null;
let layoutFrame: number | null = null;

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    vue: "html", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    json: "json", jsonc: "json",
    md: "markdown",
    java: "java", kt: "kotlin",
    py: "python",
    sql: "sql",
    xml: "xml",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell",
    gradle: "groovy",
    properties: "ini",
  };
  return map[ext] || "plaintext";
}

/** 创建只读差异预览，关闭概览标记；差异计算与首次绘制完成后再展示。 */
function createEditor(): void {
  if (!containerRef.value || diffEditor) return;
  ensureMonacoEnv();

  const lang = guessLanguage(props.filePath);
  const isMobile = isMobileViewport();

  originalModel = monaco.editor.createModel(props.original, lang);
  modifiedModel = monaco.editor.createModel(props.modified, lang);

  diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
    dimension: { width: containerRef.value.clientWidth, height: containerRef.value.clientHeight },
    automaticLayout: true,
    readOnly: true,
    domReadOnly: isMobile,
    tabIndex: isMobile ? -1 : 0,
    renderSideBySide: !props.inline,
    // 空旧正文用原生行内渲染，避免把空模型的一行显示成删除占位。
    experimental: { useTrueInlineView: props.original.length === 0 },
    enableSplitViewResizing: true,
    fixedOverflowWidgets: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: Math.round((isMobile ? 12 : 13) * props.fontScale),
    lineHeight: Math.round((isMobile ? 18 : 20) * props.fontScale),
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    contextmenu: false,
    theme: isDark.value ? "vs-dark" : "vs",
    hideUnchangedRegions: { enabled: props.hideUnchanged },
    scrollbar: {
      useShadows: false,
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
  });

  diffSubscription = diffEditor.onDidUpdateDiff(scheduleEditorLayout);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  attachResizeObserver();
  scheduleEditorLayout();

  if (isMobile) {
    const blur = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      diffEditor?.getModifiedEditor().getDomNode()?.blur();
      diffEditor?.getOriginalEditor().getDomNode()?.blur();
    };
    focusDisposables = [
      diffEditor.getModifiedEditor().onDidFocusEditorText(blur),
      diffEditor.getModifiedEditor().onDidFocusEditorWidget(blur),
      diffEditor.getOriginalEditor().onDidFocusEditorText(blur),
      diffEditor.getOriginalEditor().onDidFocusEditorWidget(blur),
    ];
    setTimeout(blur, 0);
  }
}

/** 按容器尺寸重排；首屏完成差异计算和正文绘制后才结束加载。 */
function scheduleEditorLayout(): void {
  if (typeof window === "undefined" || layoutFrame != null) return;
  layoutFrame = window.requestAnimationFrame(() => {
    layoutFrame = null;
    const container = containerRef.value, editor = diffEditor;
    if (!container || !editor || !container.clientWidth || !container.clientHeight) return;
    editor.layout({ width: container.clientWidth, height: container.clientHeight });
    if (!editorReady.value && editor.getLineChanges() !== null) {
      editor.getOriginalEditor().render(true);
      editor.getModifiedEditor().render(true);
      editorReady.value = true;
    }
  });
}

/** 监听预览容器尺寸，避免 Monaco automaticLayout 漏掉弹框全屏切换。 */
function attachResizeObserver(): void {
  if (!containerRef.value || typeof ResizeObserver === "undefined") return;
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => scheduleEditorLayout());
  resizeObserver.observe(containerRef.value);
}

/** 清理 Monaco 尺寸监听，避免组件销毁后继续触发布局。 */
function detachResizeObserver(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (layoutFrame != null && typeof window !== "undefined") {
    window.cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
  }
}

/** 释放编辑器及监听，重建前恢复加载态，避免旧回调揭开新预览。 */
function destroyEditor(): void {
  editorReady.value = false;
  detachResizeObserver();
  diffSubscription?.dispose();
  diffSubscription = null;
  for (const d of focusDisposables) d.dispose();
  focusDisposables = [];
  diffEditor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
  diffEditor = null;
  originalModel = null;
  modifiedModel = null;
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 767;
}

onMounted(async () => {
  await nextTick();
  createEditor();
});

onUnmounted(() => {
  destroyEditor();
});

function goToNextDiff(): void {
  (diffEditor as any)?.goToDiff?.("next");
}

function goToPrevDiff(): void {
  (diffEditor as any)?.goToDiff?.("previous");
}

defineExpose({ goToNextDiff, goToPrevDiff });

// 内容变化时重建（通常是切换文件）
watch(
  () => [props.original, props.modified, props.filePath, props.inline, props.hideUnchanged, props.fontScale, isDark.value] as const,
  async () => {
    destroyEditor();
    await nextTick();
    createEditor();
  },
);
</script>

<template>
  <div class="diff-viewer" :aria-busy="!editorReady">
    <div ref="containerRef" class="diff-editor" :class="{ 'is-ready': editorReady }" />
    <a-spin v-if="!editorReady" class="diff-loading" />
  </div>
</template>

<style scoped>
.diff-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
}
/* Monaco 子节点会显式恢复 visibility，需用容器透明度一并隐藏正文与行号。 */
.diff-editor { position: absolute; inset: 0; visibility: hidden; opacity: 0; }
.diff-editor.is-ready { visibility: visible; opacity: 1; }
.diff-loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }

/* Monaco 无滑块圆角与局部配色选项，在组件内复用全局滚动条主题。 */
.diff-viewer :deep(.monaco-scrollable-element > .scrollbar > .slider) {
  border-radius: 999px;
  background: var(--app-scrollbar-thumb) !important;
}
.diff-viewer :deep(.monaco-scrollable-element > .scrollbar:hover > .slider),
.diff-viewer :deep(.monaco-scrollable-element > .scrollbar > .slider.active) {
  background: var(--app-scrollbar-thumb-hover) !important;
}

/* 关闭按钮去掉 Monaco 内置 top: 5px，与其他按钮对齐 */
.diff-viewer :deep(.find-widget > .button.codicon-widget-close) {
  top: 8px !important;
}

/*
 * Monaco tooltip（.context-view）的指针箭头会伸入按钮区域，导致
 * hover 闪烁循环。pointer-events: none 让 tooltip 不截获鼠标。
 */
.diff-viewer :deep(.context-view) {
  pointer-events: none !important;
}
</style>
