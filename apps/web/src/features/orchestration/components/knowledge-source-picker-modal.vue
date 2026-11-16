<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons-vue";
import type { FsDocumentPreviewResponseBody, FsReadFileResponseBody, FsSpreadsheetPreviewResponseBody, FsTreeNode, WorkspaceId } from "@codeflowai/shared";

import { fetchFsDocumentPreview, fetchFsReadFile, fetchFsSpreadsheetPreview, fetchFsStat, fetchFsTree } from "../../../api/fs";
import { useApiContext } from "../../../composables/useApiContext";
import PdfPreview from "../../explorer/components/pdf-preview.vue";
import PresentationPreview from "../../explorer/components/presentation-preview.vue";
import SpreadsheetPreview from "../../explorer/components/spreadsheet-preview.vue";
import WordPreview from "../../explorer/components/word-preview.vue";
import { isDocumentPreviewPath, isSpreadsheetPreviewPath } from "../../explorer/workspaceFilePreview";

defineOptions({ name: "KnowledgeSourcePickerModal" });

type PickerMode = "workspace-file" | "workspace-dir" | "workbench-doc" | "workbench-dir";

type TreeItem = {
  key: string;
  title: string;
  isLeaf: boolean;
  selectable: boolean;
  fsNode: FsTreeNode;
  children?: TreeItem[];
};

const props = defineProps<{
  open: boolean;
  workspaceId: WorkspaceId;
  mode: PickerMode;
  workflowDocsRoot: string;
  initialValue?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "pick", value: string): void;
}>();

const { ctx } = useApiContext();

const treeNodes = ref<FsTreeNode[]>([]);
const expandedKeys = ref<string[]>([]);
const selectedActualPath = ref("");
const treeLoading = ref(false);
const previewLoading = ref(false);
const preview = ref<FsReadFileResponseBody | null>(null);
const spreadsheetPreview = ref<FsSpreadsheetPreviewResponseBody | null>(null);
const documentPreview = ref<FsDocumentPreviewResponseBody | null>(null);
const pickerFullscreen = ref(false);

const isWorkbenchMode = computed(() => props.mode === "workbench-doc" || props.mode === "workbench-dir");
const isDirectoryMode = computed(() => props.mode === "workspace-dir" || props.mode === "workbench-dir");
const baseDir = computed(() => (isWorkbenchMode.value ? normalizePath(props.workflowDocsRoot) : ""));
const pickerTitle = computed(() => {
  if (props.mode === "workbench-doc") return "选择工作台文档";
  if (props.mode === "workbench-dir") return "选择工作台目录";
  if (props.mode === "workspace-dir") return "选择项目目录";
  return "选择项目文件";
});
const rootLabel = computed(() => {
  if (isWorkbenchMode.value) {
    return `路径基准：工作台文档根目录 ${baseDir.value || "(未配置)"}`;
  }
  return "路径基准：当前工作区根目录";
});
const emptyTreeDescription = computed(() => (isDirectoryMode.value ? "当前范围下没有可选目录" : "当前范围下没有可选文件"));
const selectedValue = computed(() => toStoredValue(selectedActualPath.value));
const selectedName = computed(() => {
  const actualPath = normalizePath(selectedActualPath.value);
  if (!actualPath) return isDirectoryMode.value ? "项目根目录" : "";
  return actualPath.split("/").filter(Boolean).pop() ?? actualPath;
});

const treeData = computed<TreeItem[]>(() => toTreeData(treeNodes.value));
const treeReady = computed(() => treeData.value.length > 0);
const treeSpinning = computed(() => treeLoading.value || previewLoading.value);
const pickerFullscreenTitle = computed(() => pickerFullscreen.value ? "还原知识源选择" : "全屏查看知识源选择");
const pickerModalWidth = computed(() => pickerFullscreen.value ? "100vw" : 980);
const pickerModalStyle = computed(() => pickerFullscreen.value ? { top: "0", paddingBottom: "0" } : {});
const pickerModalBodyStyle = computed(() =>
  pickerFullscreen.value
    ? { height: "calc(100dvh - 108px)", maxHeight: "calc(100dvh - 108px)", overflow: "hidden" }
    : {});
const pickerModalWrapClassName = computed(() =>
  pickerFullscreen.value
    ? "knowledge-source-picker-modal knowledge-source-picker-modal--fullscreen"
    : "knowledge-source-picker-modal");

const selectedNode = computed(() => findNodeByPath(treeNodes.value, selectedActualPath.value));
const selectedDirChildren = computed(() => {
  const node = selectedNode.value;
  if (!node?.isDir) return [];
  return (node.children ?? []).slice(0, 12);
});

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      pickerFullscreen.value = false;
      return;
    }
    treeNodes.value = [];
    expandedKeys.value = [];
    preview.value = null;
    spreadsheetPreview.value = null;
    documentPreview.value = null;
    await nextTick();
    const initialPath = toActualPath(props.initialValue ?? "");
    selectedActualPath.value = await resolveInitialPath(initialPath);
    await loadRoot();
    if (selectedActualPath.value) {
      await ensurePathLoaded(selectedActualPath.value);
      await loadPreview(selectedActualPath.value);
    }
  },
  { immediate: true },
);

function normalizePath(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function joinPath(base: string, rel: string): string {
  return [normalizePath(base), normalizePath(rel)].filter(Boolean).join("/");
}

function toActualPath(storedValue: string): string {
  const rel = normalizePath(storedValue);
  if (!rel || rel === ".") return baseDir.value;
  return isWorkbenchMode.value ? joinPath(baseDir.value, rel) : rel;
}

function toStoredValue(actualPath: string): string {
  const actual = normalizePath(actualPath);
  if (!actual) return isDirectoryMode.value ? "." : "";
  if (!isWorkbenchMode.value) return actual;
  const root = baseDir.value;
  if (!root) return actual;
  if (actual === root) return isDirectoryMode.value ? "." : "";
  const prefix = `${root}/`;
  return actual.startsWith(prefix) ? actual.slice(prefix.length) : actual;
}

/** 校验弹窗初始路径；不可用时回到当前模式的默认选择并显式提示。 */
async function resolveInitialPath(actualPath: string): Promise<string> {
  if (!actualPath) return isDirectoryMode.value ? baseDir.value : "";
  try {
    const res = await fetchFsStat(ctx.value, {
      workspaceId: props.workspaceId,
      path: actualPath,
    });
    if (!res.ok || !res.exists) return isDirectoryMode.value ? baseDir.value : "";
    if (isDirectoryMode.value) return res.isDir ? actualPath : baseDir.value;
    return res.isDir ? "" : actualPath;
  } catch (error) {
    message.warning(error instanceof Error ? `初始路径不可用：${error.message}` : "初始路径不可用");
    return isDirectoryMode.value ? baseDir.value : "";
  }
}

function toTreeData(nodes: FsTreeNode[]): TreeItem[] {
  return nodes.map((node) => ({
    key: node.path,
    title: node.name,
    isLeaf: !node.isDir,
    selectable: isDirectoryMode.value ? node.isDir : !node.isDir,
    fsNode: node,
    children: node.children ? toTreeData(node.children) : undefined,
  }));
}

async function loadRoot(): Promise<void> {
  if (!props.workspaceId) return;
  treeLoading.value = true;
  try {
    const res = await fetchFsTree(ctx.value, {
      workspaceId: props.workspaceId,
      dirPath: baseDir.value,
      depth: 1,
    });
    if (!res.ok) throw new Error(res.message);
    treeNodes.value = res.nodes ?? [];
    if (selectedActualPath.value) {
      expandedKeys.value = parentDirPaths(selectedActualPath.value);
    }
  } catch (error) {
    treeNodes.value = [];
    message.error(error instanceof Error ? error.message : "加载文件树失败");
  } finally {
    treeLoading.value = false;
  }
}

async function loadPreview(actualPath: string): Promise<void> {
  if (!actualPath || isDirectoryMode.value) {
    preview.value = null;
    spreadsheetPreview.value = null;
    documentPreview.value = null;
    return;
  }
  previewLoading.value = true;
  try {
    preview.value = null;
    spreadsheetPreview.value = null;
    documentPreview.value = null;
    if (isSpreadsheetPreviewPath(actualPath)) {
      const res = await fetchFsSpreadsheetPreview(ctx.value, {
        workspaceId: props.workspaceId,
        path: actualPath,
      });
      if (!res.ok) throw new Error(res.message);
      spreadsheetPreview.value = res;
      return;
    }
    if (isDocumentPreviewPath(actualPath)) {
      const res = await fetchFsDocumentPreview(ctx.value, {
        workspaceId: props.workspaceId,
        path: actualPath,
      });
      if (!res.ok) throw new Error(res.message);
      documentPreview.value = res;
      return;
    }
    const res = await fetchFsReadFile(ctx.value, {
      workspaceId: props.workspaceId,
      path: actualPath,
      maxBytes: 24 * 1024,
    });
    if (!res.ok) throw new Error(res.message);
    preview.value = res;
  } catch (error) {
    preview.value = null;
    spreadsheetPreview.value = null;
    documentPreview.value = null;
    message.error(error instanceof Error ? error.message : "读取文件预览失败");
  } finally {
    previewLoading.value = false;
  }
}

/** 切换知识源文件预览中的表格工作表。 */
async function onSpreadsheetSheetChange(sheetName: string): Promise<void> {
  if (!selectedActualPath.value || !isSpreadsheetPreviewPath(selectedActualPath.value)) return;
  previewLoading.value = true;
  try {
    const res = await fetchFsSpreadsheetPreview(ctx.value, {
      workspaceId: props.workspaceId,
      path: selectedActualPath.value,
      sheetName,
    });
    if (!res.ok) throw new Error(res.message);
    spreadsheetPreview.value = res;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取表格预览失败");
  } finally {
    previewLoading.value = false;
  }
}

function parentDirPaths(actualPath: string): string[] {
  const stored = toStoredValue(actualPath);
  const segments = normalizePath(stored).split("/").filter(Boolean);
  if (segments.length <= 1) return [];
  const dirs = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  return dirs.map((item) => joinPath(baseDir.value, item));
}

async function ensurePathLoaded(actualPath: string): Promise<void> {
  const dirs = parentDirPaths(actualPath);
  for (const dirPath of dirs) {
    await expandDir(dirPath);
  }
  expandedKeys.value = dirs;
}

function insertChildren(dirPath: string, children: FsTreeNode[]) {
  const insert = (nodes: FsTreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.path === dirPath && node.isDir) {
        node.children = children;
        return true;
      }
      if (node.children && insert(node.children)) return true;
    }
    return false;
  };
  insert(treeNodes.value);
}

async function expandDir(dirPath: string): Promise<void> {
  const res = await fetchFsTree(ctx.value, {
    workspaceId: props.workspaceId,
    dirPath,
    depth: 1,
  });
  if (!res.ok) throw new Error(res.message);
  insertChildren(dirPath, res.nodes ?? []);
}

async function onLoadData(treeNode: { fsNode?: FsTreeNode; key?: string }): Promise<void> {
  const dirPath = treeNode.fsNode?.path ?? String(treeNode.key ?? "");
  if (!dirPath) return;
  await expandDir(dirPath);
}

async function onSelect(_selectedKeys: string[], info: { node?: TreeItem }) {
  const fsNode = info.node?.fsNode;
  if (!fsNode) return;
  if (isDirectoryMode.value && !fsNode.isDir) return;
  if (!isDirectoryMode.value && fsNode.isDir) return;
  selectedActualPath.value = fsNode.path;
  await loadPreview(fsNode.path);
}

function onExpand(keys: string[]) {
  expandedKeys.value = keys;
}

async function selectRoot() {
  selectedActualPath.value = baseDir.value;
  await loadPreview(baseDir.value);
}

function close() {
  pickerFullscreen.value = false;
  emit("update:open", false);
}

/** 切换知识源选择弹框全屏状态，保留当前树选择和预览上下文。 */
function togglePickerFullscreen(): void {
  pickerFullscreen.value = !pickerFullscreen.value;
}

function confirmPick() {
  if (!selectedValue.value) {
    message.warning(isDirectoryMode.value ? "请先选择一个目录" : "请先选择一个文件");
    return;
  }
  emit("pick", selectedValue.value);
  emit("update:open", false);
}

function previewText(): string {
  const content = preview.value?.content;
  if (typeof content !== "string" || !content.length) return "";
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.length > 4000 ? `${normalized.slice(0, 4000)}\n\n...` : normalized;
}

function findNodeByPath(nodes: FsTreeNode[], actualPath: string): FsTreeNode | null {
  const target = normalizePath(actualPath);
  if (!target) return null;
  for (const node of nodes) {
    if (normalizePath(node.path) === target) return node;
    if (node.children?.length) {
      const found = findNodeByPath(node.children, target);
      if (found) return found;
    }
  }
  return null;
}
</script>

<template>
  <a-modal
    :open="open"
    :width="pickerModalWidth"
    :style="pickerModalStyle"
    :body-style="pickerModalBodyStyle"
    :wrap-class-name="pickerModalWrapClassName"
    :ok-text="isDirectoryMode ? '使用当前目录' : '使用当前文件'"
    cancel-text="取消"
    :mask-closable="true"
    @ok="confirmPick"
    @cancel="close"
  >
    <template #title>
      <div class="picker-modal__titlebar">
        <span>{{ pickerTitle }}</span>
        <a-tooltip :title="pickerFullscreenTitle">
          <a-button size="small" type="text" :aria-label="pickerFullscreenTitle" @click.stop="togglePickerFullscreen">
            <component :is="pickerFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
          </a-button>
        </a-tooltip>
      </div>
    </template>
    <div class="picker-modal" :class="{ 'picker-modal--fullscreen': pickerFullscreen }">
      <div class="picker-modal__toolbar">
        <div>
          <div class="picker-modal__eyebrow">{{ rootLabel }}</div>
          <div class="picker-modal__path">{{ selectedValue || "还没有选中内容" }}</div>
        </div>
        <button v-if="isDirectoryMode" class="picker-modal__root-btn" type="button" @click="selectRoot">
          选择当前根目录
        </button>
      </div>

      <div class="picker-modal__body">
        <section class="picker-modal__pane">
          <div class="picker-modal__pane-head">
            <strong>{{ isDirectoryMode ? "目录树" : "文件树" }}</strong>
            <span>只会把相对路径写回知识库，不会写绝对路径。</span>
          </div>
          <div class="picker-modal__tree">
            <div class="picker-modal__tree-host">
              <a-spin :spinning="treeSpinning" class="picker-modal__tree-spin">
                <a-directory-tree
                  v-if="treeReady"
                  :tree-data="treeData"
                  :expanded-keys="expandedKeys"
                  :selected-keys="selectedActualPath ? [selectedActualPath] : []"
                  :load-data="onLoadData"
                  :block-node="true"
                  :show-icon="false"
                  @select="onSelect"
                  @expand="onExpand"
                />
                <a-empty v-else-if="!treeSpinning" :description="emptyTreeDescription" />
              </a-spin>
            </div>
          </div>
        </section>

        <section class="picker-modal__pane picker-modal__pane--preview">
          <div class="picker-modal__pane-head">
            <strong>{{ selectedName || (isDirectoryMode ? "目录说明" : "文件预览") }}</strong>
            <span>
              {{ selectedValue || (isDirectoryMode ? "选择目录后，这里会显示范围说明。" : "选择文件后，这里会显示相对路径和内容预览。") }}
            </span>
          </div>
          <div class="picker-modal__preview">
            <div v-if="selectedValue" class="picker-modal__preview-meta">
              <div class="picker-modal__preview-path">{{ selectedValue }}</div>
            </div>
            <template v-if="!selectedValue">
              <a-empty :description="isDirectoryMode ? '左侧选择一个目录' : '左侧选择一个文件'" />
            </template>
            <template v-else-if="isDirectoryMode">
              <div class="picker-modal__dir-hint">目录型知识不会直接注入正文，而是把这个范围交给 AI 在执行态按需浏览和读取。</div>
              <div v-if="selectedDirChildren.length" class="picker-modal__dir-list">
                <div v-for="child in selectedDirChildren" :key="child.path" class="picker-modal__dir-item">
                  <strong>{{ child.name }}</strong>
                  <span>{{ child.isDir ? "目录" : "文件" }}</span>
                </div>
              </div>
              <a-empty v-else description="当前目录暂无已加载的子项" />
            </template>
            <SpreadsheetPreview
              v-else-if="spreadsheetPreview"
              :preview="spreadsheetPreview"
              @sheet-change="onSpreadsheetSheetChange"
            />
            <div
              v-else-if="documentPreview?.kind === 'pdf' && documentPreview.base64"
              class="picker-modal__document-preview"
            >
              <PdfPreview
                :base64="documentPreview.base64"
                :mime-type="documentPreview.mimeType"
                :file-path="selectedActualPath"
              />
            </div>
            <div
              v-else-if="documentPreview?.kind === 'word' && documentPreview.content != null"
              class="picker-modal__document-preview"
            >
              <WordPreview :content="documentPreview.content" :file-path="selectedActualPath" />
            </div>
            <div
              v-else-if="documentPreview?.kind === 'presentation' && documentPreview.base64"
              class="picker-modal__document-preview"
            >
              <PresentationPreview :base64="documentPreview.base64" :file-path="selectedActualPath" />
            </div>
            <a-empty v-else-if="preview && preview.isBinary" description="二进制文件不展示正文预览，但可以正常引用。" />
            <pre v-else class="picker-modal__preview-text">{{ previewText() }}</pre>
          </div>
        </section>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.picker-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.picker-modal__titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: calc(100% - 44px);
  min-width: 0;
}

.picker-modal__titlebar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-modal__toolbar {
  padding: 12px 14px;
  border-radius: 12px;
  background: #f7faff;
  border: 1px solid var(--app-border, #e8e8e8);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.picker-modal__eyebrow {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.picker-modal__path {
  margin-top: 4px;
  font-size: 13px;
  color: var(--app-text, #1f2937);
  word-break: break-all;
}

.picker-modal__root-btn {
  border: 1px solid #cfd8e3;
  border-radius: 10px;
  background: #fff;
  color: var(--app-text, #1f2937);
  font-size: 12px;
  padding: 7px 12px;
  cursor: pointer;
  white-space: nowrap;
}

.picker-modal__body {
  display: grid;
  grid-template-columns: minmax(320px, 360px) minmax(0, 1fr);
  gap: 12px;
  min-height: 500px;
}

.picker-modal__pane {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.picker-modal__pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
  background: rgba(15, 23, 42, 0.02);
}

.picker-modal__pane-head strong {
  font-size: 13px;
  color: var(--app-text, #1f2937);
}

.picker-modal__pane-head span {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.picker-modal__tree,
.picker-modal__preview {
  min-height: 0;
  flex: 1;
  padding: 12px 14px;
}

.picker-modal__tree {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 树已关闭 antd 虚拟滚动，由本层用原生滚动接管（flex + min-height:0 即可滚动，
   不用 height:100%：该父级无指定高度，百分比高度会解析成 auto）；滚动条走 layout.css 共用清单。 */
.picker-modal__tree-host {
  flex: 1;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
}

.picker-modal__tree-spin {
  display: block;
  width: 100%;
  height: 100%;
}

.picker-modal__preview {
  overflow: auto;
  background: #fbfdff;
}

.picker-modal__preview-meta {
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--app-border, #d7e1ec);
}

.picker-modal__preview-path {
  font-size: 12px;
  color: var(--app-muted, #64748b);
  word-break: break-all;
}

.picker-modal__preview-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-text, #1f2937);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, "SFMono-Regular", Menlo, Monaco, monospace;
}

.picker-modal__document-preview {
  height: 100%;
  min-height: 380px;
}

.picker-modal__dir-hint {
  padding: 10px 12px;
  border-radius: 10px;
  background: #f4f7fb;
  color: var(--app-muted, #64748b);
  font-size: 12px;
  line-height: 1.7;
}

.picker-modal__dir-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.picker-modal__dir-item {
  border: 1px solid #d7e1ec;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.picker-modal__dir-item strong {
  font-size: 13px;
  color: var(--app-text, #1f2937);
}

.picker-modal__dir-item span {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.picker-modal__tree-spin :deep(.ant-spin-nested-loading),
.picker-modal__tree-spin :deep(.ant-spin-container) {
  width: 100%;
  height: 100%;
}

:global(.knowledge-source-picker-modal--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

:global(.knowledge-source-picker-modal--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.knowledge-source-picker-modal--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.knowledge-source-picker-modal--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.knowledge-source-picker-modal--fullscreen) .picker-modal {
  height: 100%;
}

:global(.knowledge-source-picker-modal--fullscreen) .picker-modal__body {
  flex: 1 1 auto;
  min-height: 0;
}

:global(.knowledge-source-picker-modal--fullscreen) .picker-modal__document-preview {
  min-height: 0;
}

.picker-modal--fullscreen {
  height: 100%;
}

.picker-modal--fullscreen .picker-modal__body {
  flex: 1 1 auto;
  min-height: 0;
}

.picker-modal--fullscreen .picker-modal__document-preview {
  min-height: 0;
}

@media (max-width: 980px) {
  .picker-modal__toolbar,
  .picker-modal__body {
    grid-template-columns: 1fr;
    min-height: 0;
    flex-direction: column;
  }
}

:root[data-theme="dark"] .picker-modal__toolbar,
:root[data-theme="dark"] .picker-modal__pane,
:root[data-theme="dark"] .picker-modal__dir-item {
  border-color: #303030;
}

:root[data-theme="dark"] .picker-modal__toolbar {
  background: #142033;
}

:root[data-theme="dark"] .picker-modal__root-btn,
:root[data-theme="dark"] .picker-modal__dir-item {
  background: #162132;
  color: #e5edf7;
}

:root[data-theme="dark"] .picker-modal__pane-head {
  background: rgba(255, 255, 255, 0.03);
  border-bottom-color: #303030;
}

:root[data-theme="dark"] .picker-modal__preview,
:root[data-theme="dark"] .picker-modal__dir-hint {
  background: #111827;
}

:root[data-theme="dark"] .picker-modal__preview-meta {
  border-bottom-color: #314055;
}

:root[data-theme="dark"] .picker-modal__preview-text,
:root[data-theme="dark"] .picker-modal__path,
:root[data-theme="dark"] .picker-modal__pane-head strong,
:root[data-theme="dark"] .picker-modal__dir-item strong {
  color: #e5edf7;
}

:root[data-theme="dark"] .picker-modal__eyebrow,
:root[data-theme="dark"] .picker-modal__pane-head span,
:root[data-theme="dark"] .picker-modal__preview-path,
:root[data-theme="dark"] .picker-modal__dir-item span,
:root[data-theme="dark"] .picker-modal__dir-hint {
  color: #95a7bc;
}
</style>

