<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import * as monaco from "monaco-editor";
import { ensureMonacoEnv } from "../../../composables/useMonacoEnv";
import { useUiStore } from "../../../store/ui";

defineOptions({ name: "CodePreview" });

const props = defineProps<{
  content: string;
  filePath: string;
  fontScale?: number;
  /** 本地 UTF-8 文本可编辑；只读预览保持现有行为。 */
  editable?: boolean;
}>();
const emit = defineEmits<{
  (e: "change", value: string): void;
  (e: "save"): void;
}>();

const ui = useUiStore();

const isDark = computed(() => {
  if (ui.themeMode === "dark") return true;
  if (ui.themeMode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
});

const containerRef = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
let focusDisposables: monaco.IDisposable[] = [];
let resizeObserver: ResizeObserver | null = null;
let layoutFrame: number | null = null;
/** 外部重载内容或重建编辑器时不回传 change，避免把同步当成用户编辑。 */
let suppressChange = false;

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
    py: "python", sql: "sql",
    xml: "xml", yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell",
    gradle: "groovy", properties: "ini",
    rs: "rust", go: "go", rb: "ruby",
    c: "c", cpp: "cpp", h: "c",
    toml: "toml", diff: "plaintext", patch: "plaintext",
  };
  return map[ext] || "plaintext";
}

function createEditor(): void {
  if (!containerRef.value) return;
  ensureMonacoEnv();

  const lang = guessLanguage(props.filePath);
  model = monaco.editor.createModel(props.content, lang);

  const editable = props.editable === true && !isMobileViewport();
  editor = monaco.editor.create(containerRef.value, {
    model,
    readOnly: !editable,
    domReadOnly: !editable,
    tabIndex: editable ? 0 : -1,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: Math.round(13 * (props.fontScale ?? 1)),
    lineHeight: Math.round(20 * (props.fontScale ?? 1)),
    contextmenu: false,
    theme: isDark.value ? "vs-dark" : "vs",
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
  });
  attachResizeObserver();
  scheduleEditorLayout();
  editor.onDidChangeModelContent(() => {
    if (!suppressChange) emit("change", editor?.getValue() ?? "");
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (props.editable) emit("save");
  });

  if (isMobileViewport()) {
    const blur = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      editor?.getDomNode()?.blur();
    };
    focusDisposables = [
      editor.onDidFocusEditorText(blur),
      editor.onDidFocusEditorWidget(blur),
    ];
    setTimeout(blur, 0);
  }
}

/** 容器尺寸变化后调度 Monaco 重排，保证弹框全屏/还原后内容吃满高度。 */
function scheduleEditorLayout(): void {
  if (typeof window === "undefined" || layoutFrame != null) return;
  layoutFrame = window.requestAnimationFrame(() => {
    layoutFrame = null;
    editor?.layout();
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

function destroyEditor(): void {
  detachResizeObserver();
  for (const d of focusDisposables) {
    try { d.dispose(); } catch {}
  }
  focusDisposables = [];
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
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

watch(
  () => [props.filePath, props.fontScale ?? 1, isDark.value, props.editable === true] as const,
  async () => {
    destroyEditor();
    await nextTick();
    createEditor();
  },
);

/** 保留编辑光标：外部内容变化时只同步模型，不重建编辑器。 */
watch(() => props.content, (value) => {
  if (!model || model.getValue() === value) return;
  suppressChange = true;
  model.setValue(value);
  suppressChange = false;
});
</script>

<template>
  <div ref="containerRef" class="code-preview" />
</template>

<style scoped>
.code-preview {
  width: 100%;
  height: 100%;
  min-height: 300px;
}

/*
 * Monaco tooltip（.context-view）的指针箭头会伸入查找按钮区域，导致
 * hover 闪烁循环。pointer-events: none 让 tooltip 不截获鼠标。
 */
.code-preview :deep(.context-view) {
  pointer-events: none !important;
}
</style>
