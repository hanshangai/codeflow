<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { DownloadOutlined, FileTextOutlined, PlusOutlined, UploadOutlined } from "@ant-design/icons-vue";
import type { FsSearchIndexStatus, FsSearchResult, FsTreeNode, GitFileStatus, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../../../api/request";
import { downloadWorkspaceFile, fetchFsReadFile, fetchFsSearch, fetchFsStat } from "../../../api/fs";
import { trackProductEvent } from "../../../analytics/analytics";
import { useChatStore } from "../../../store/chat";
import { useComposerStore } from "../../../store/composer";
import { useConfigStore } from "../../../store/config";
import { useExplorerStore } from "../../../store/explorer";
import { usePresenceStore } from "../../../store/presence";
import { isDesktopWorkspace } from "../../../services/desktop";
import { notifyWorkspaceClientOffline, resolveWorkspaceRuntimeUnavailableMessage } from "../../../utils/clientOfflineNotice";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import FileTreeNode from "./file-tree-node.vue";
import ExplorerPanelState from "./explorer-panel-state.vue";

defineOptions({ name: "FileTree" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
  searchKeyword?: string;
  searchRevision?: number;
}>();

const emit = defineEmits<{
  (e: "selectFile", path: string): void;
  (e: "uploadToDirectory", path: string): void;
}>();

const explorer = useExplorerStore();
const chat = useChatStore();
const composer = useComposerStore();
const config = useConfigStore();
const presence = usePresenceStore();
const searchNodes = ref<FsTreeNode[]>([]);
const searchLoading = ref(false);
const searchCompleted = ref(false);
const searchIndexNotice = ref("");
let searchAbortController: AbortController | null = null;
let searchRetryTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const MAX_TEXT_FILE_BYTES = 200 * 1024;
const EXPLORER_SEARCH_LIMIT = 100;

function toDotRelativePath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) return ".";
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

/** 转换为 antd tree 需要的数据格式 */
type TreeDataItem = {
  key: string;
  title: string;
  isLeaf: boolean;
  selectable: boolean;
  /** 原始 FsTreeNode（避免与 antd 内部 `node` 属性冲突，故命名为 fsNode）。 */
  fsNode: FsTreeNode;
  children?: TreeDataItem[];
};

function toTreeData(nodes: FsTreeNode[]): TreeDataItem[] {
  return nodes.map((n) => ({
    key: n.path,
    title: n.name,
    isLeaf: !n.isDir || (n.isDir && Array.isArray(n.children) && n.children.length === 0),
    selectable: !n.isDir,
    fsNode: n,
    children: n.children ? toTreeData(n.children) : undefined,
  }));
}

/**
 * 紧凑目录合并（IDEA 风格）：
 * 若某目录仅有一个已加载子目录（无文件），合并为 A/B/C 形式。
 * key 保持最外层目录路径（保证 expandedKeys 稳定），
 * fsNode 指向最内层目录（保证 lazy-load 时加载正确目录）。
 */
function compactTreeData(nodes: TreeDataItem[]): TreeDataItem[] {
  const dirs: TreeDataItem[] = [];
  const files: TreeDataItem[] = [];

  for (const n of nodes) {
    if (n.isLeaf) {
      files.push(n);
    } else {
      dirs.push({
        ...n,
        children: n.children ? compactTreeData(n.children) : undefined,
      });
    }
  }

  const merged: TreeDataItem[] = [];
  for (const d of dirs) {
    let node = d;
    while (
      node.children
      && node.children.length === 1
      && !node.children[0].isLeaf
      && node.children[0].children
    ) {
      const child = node.children[0];
      const mergedTitle = `${node.title}/${child.title}`;
      node = {
        key: d.key,                                   // 最外层 key
        title: mergedTitle,
        isLeaf: false,
        selectable: false,
        fsNode: { ...child.fsNode, name: mergedTitle }, // 最内层 fsNode，name 改为合并路径
        children: child.children,
      };
    }
    merged.push(node);
  }

  return [...merged, ...files];
}

/** 克隆树节点，目录命中时保留完整子树且不污染原始树。 */
function cloneTreeNode(node: TreeDataItem): TreeDataItem {
  return {
    ...node,
    children: node.children ? node.children.map(cloneTreeNode) : undefined,
  };
}

/** 将 fs.search 的扁平结果重建成文件树，保留命中路径的父目录。 */
function buildSearchTree(results: FsSearchResult[]): FsTreeNode[] {
  const roots: FsTreeNode[] = [];
  const byPath = new Map<string, FsTreeNode>();

  for (const result of results) {
    const normalizedPath = String(result.path ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
    if (!normalizedPath) continue;
    const parts = normalizedPath.split("/").filter(Boolean);
    let parentChildren = roots;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const nodePath = parts.slice(0, index + 1).join("/");
      const isResultNode = index === parts.length - 1;
      const isDir = isResultNode ? result.isDir : true;
      let node = byPath.get(nodePath);
      if (!node) {
        node = {
          name,
          path: nodePath,
          isDir,
          size: isDir ? undefined : result.size,
          mtime: isResultNode ? result.mtime : undefined,
          children: isDir ? [] : undefined,
        };
        byPath.set(nodePath, node);
        parentChildren.push(node);
      } else if (isResultNode) {
        node.isDir = isDir;
        node.size = isDir ? undefined : result.size;
        node.mtime = result.mtime;
        if (isDir && !node.children) node.children = [];
      }
      if (node.isDir) {
        if (!node.children) node.children = [];
        parentChildren = node.children;
      }
    }
  }

  sortFsTreeNodes(roots);
  return roots;
}

/** 按目录优先和名称排序搜索结果树，保持文件面板展示稳定。 */
function sortFsTreeNodes(nodes: FsTreeNode[]): void {
  nodes.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name));
  for (const node of nodes) {
    if (node.children) sortFsTreeNodes(node.children);
  }
}

/** 判断节点标题或 workspace 相对路径是否命中搜索词。 */
function treeNodeMatchesKeyword(node: TreeDataItem, kw: string): boolean {
  const title = String(node.title ?? "").toLowerCase();
  const relPath = String(node.fsNode?.path ?? "").toLowerCase();
  return title.includes(kw) || relPath.includes(kw);
}

/** 根据搜索关键词递归过滤树节点；目录命中时保留完整子树。 */
function filterTree(nodes: TreeDataItem[], keyword: string): TreeDataItem[] {
  const kw = keyword.toLowerCase();
  const result: TreeDataItem[] = [];
  for (const node of nodes) {
    const selfMatched = treeNodeMatchesKeyword(node, kw);
    if (node.isLeaf) {
      if (selfMatched) result.push(node);
    } else {
      if (selfMatched) {
        result.push(cloneTreeNode(node));
        continue;
      }
      const filteredChildren = node.children ? filterTree(node.children, keyword) : [];
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      }
    }
  }
  return result;
}

/** 收集所有目录 key（用于搜索时自动展开） */
function collectDirKeys(nodes: TreeDataItem[]): string[] {
  const keys: string[] = [];
  for (const n of nodes) {
    if (!n.isLeaf) {
      keys.push(n.key);
      if (n.children) keys.push(...collectDirKeys(n.children));
    }
  }
  return keys;
}

const rawTreeData = computed(() => compactTreeData(toTreeData(explorer.treeNodes)));
const searchTreeData = computed(() => compactTreeData(toTreeData(searchNodes.value)));
const treeRenderKey = computed(() => `${props.workspaceId}:${explorer.treeVersion}`);

const treeData = computed(() => {
  const kw = props.searchKeyword?.trim();
  if (!kw) return rawTreeData.value;
  if (searchCompleted.value || searchLoading.value) return searchTreeData.value;
  // 过滤后重新紧凑合并（过滤可能产生新的单子目录情况）
  return compactTreeData(filterTree(rawTreeData.value, kw));
});
const treeReady = computed(() => treeData.value.length > 0);
const treeSpinning = computed(() => explorer.treeLoading || searchLoading.value);

const expandedKeys = computed({
  get: () => {
    const kw = props.searchKeyword?.trim();
    if (kw) return collectDirKeys(treeData.value);
    return explorer.expandedKeys;
  },
  set: (v) => { explorer.expandedKeys = v; },
});
const selectedKeys = computed(() => explorer.selectedPath ? [explorer.selectedPath] : []);
const downloadingPath = ref<string | null>(null);

/** Git 状态映射（path -> status） */
const gitStatusMap = computed(() => {
  const map = new Map<string, GitFileStatus>();
  if (!explorer.gitStatus) return map;
  for (const f of explorer.gitStatus.staged) map.set(f.path, f);
  for (const f of explorer.gitStatus.unstaged) {
    if (!map.has(f.path)) map.set(f.path, f);
  }
  for (const p of explorer.gitStatus.untracked) {
    if (!map.has(p)) map.set(p, { path: p, index: "?", working: "?" });
  }
  return map;
});

/** 懒加载：展开目录时加载子节点 */
async function onLoadData(treeNode: any): Promise<void> {
  const fsNode = (treeNode.dataRef?.fsNode ?? treeNode.fsNode) as FsTreeNode | undefined;
  if (fsNode?.children) return;
  // 合并目录时 key 是最外层路径，fsNode.path 是最内层路径（实际需要加载的目录）
  const dirPath = fsNode?.path ?? (treeNode.key as string);
  await explorer.expandDir(props.ctx, props.workspaceId, dirPath);
}

/** 选中节点 */
function onSelect(keys: string[], info: any) {
  const fsNode = info.node?.fsNode as FsTreeNode | undefined;
  if (!fsNode) return;
  if (fsNode.isDir) return; // 目录不预览
  emit("selectFile", fsNode.path);
}

/** 展开/收起 */
function onExpand(keys: string[]) {
  expandedKeys.value = keys;
}

/** Stage 操作 */
function onStage(path: string) {
  explorer.gitStage(props.ctx, props.workspaceId, [path]);
}

/** Unstage 操作 */
function onUnstage(path: string) {
  explorer.gitUnstage(props.ctx, props.workspaceId, [path]);
}

/** 获取当前可操作会话；Client 离线时不继续追加文件上下文。 */
function resolveActiveThreadId(): ThreadId | null {
  if (!presence.isCurrentWorkspaceClientOnline
    || (!config.connected && !isDesktopWorkspace(config, props.workspaceId))) {
    notifyWorkspaceClientOffline(resolveWorkspaceRuntimeUnavailableMessage(
      presence.activeWorkspaceRuntimeState,
      {
        local: "当前工作区 Client 未连接，连接后才能加入文件。",
        sharedOffline: "共享工作区 Host 当前离线，连接后才能加入文件。",
      },
    ));
    return null;
  }
  const threadId = chat.selectedThreadId;
  if (!threadId) {
    message.warning("请先选择一个会话");
    return null;
  }
  return threadId;
}

function enqueueRelativePath(path: string): void {
  const threadId = resolveActiveThreadId();
  if (!threadId) return;
  const dotRelativePath = toDotRelativePath(path);
  composer.enqueueExternalAction({
    workspaceId: props.workspaceId,
    threadId,
    kind: "append-text",
    text: dotRelativePath,
  });
  message.success(`已添加相对路径：${dotRelativePath}`);
}

async function enqueueWorkspaceFile(node: FsTreeNode): Promise<void> {
  const threadId = resolveActiveThreadId();
  if (!threadId) return;
  const statRes = await fetchFsStat(props.ctx, { workspaceId: props.workspaceId, path: node.path });
  if (!statRes.ok || !statRes.exists || statRes.isDir) {
    message.warning(`无法作为文本附件添加：${node.path}`);
    return;
  }
  if (statRes.size > MAX_TEXT_FILE_BYTES) {
    message.warning(`文本文件过大：${node.path}（最大 ${Math.floor(MAX_TEXT_FILE_BYTES / 1024)}KB）`);
    return;
  }

  const readRes = await fetchFsReadFile(props.ctx, {
    workspaceId: props.workspaceId,
    path: node.path,
    maxBytes: MAX_TEXT_FILE_BYTES,
  });
  if (!readRes.ok) {
    message.error(readRes.message);
    return;
  }
  if (readRes.isBinary || readRes.content == null) {
    message.warning(`暂不支持作为文本附件添加：${node.path}`);
    return;
  }
  if (!readRes.content.trim()) {
    message.warning(`文本文件内容为空：${node.path}`);
    return;
  }

  composer.enqueueExternalAction({
    workspaceId: props.workspaceId,
    threadId,
    kind: "attach-text-file",
    file: {
      id: `workspace_file_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name: toDotRelativePath(node.path),
      displayName: node.name,
      mime: readRes.mimeType ?? "",
      size: statRes.size,
      text: readRes.content,
    },
  });
  message.success(`已添加文本附件：${node.name}`);
}

/** 按关键词搜索 workspace 路径，避免依赖受深度限制的完整文件树。 */
async function runWorkspacePathSearch(keyword: string): Promise<void> {
  const query = keyword.trim();
  const seq = ++searchSeq;
  searchAbortController?.abort(createCancelledRequestError("stale-result"));
  searchAbortController = null;
  clearSearchRetryTimer();
  if (!query) {
    searchNodes.value = [];
    searchCompleted.value = false;
    searchLoading.value = false;
    searchIndexNotice.value = "";
    return;
  }

  const controller = new AbortController();
  searchAbortController = controller;
  searchLoading.value = true;
  searchCompleted.value = false;
  searchIndexNotice.value = "";
  try {
    const result = await fetchFsSearch(props.ctx, {
      workspaceId: props.workspaceId,
      query,
      limit: EXPLORER_SEARCH_LIMIT,
      includeHidden: explorer.showHiddenFiles,
      kind: "all",
    }, { signal: controller.signal });
    if (seq !== searchSeq) return;
    if (!result.ok) {
      searchNodes.value = [];
      searchCompleted.value = true;
      searchIndexNotice.value = "";
      message.error(result.message);
      return;
    }
    searchNodes.value = buildSearchTree(result.results ?? []);
    searchIndexNotice.value = buildSearchIndexNotice(result.indexStatus, result.partial, result.indexedCount, result.message);
    scheduleSearchRetry(query, result.indexStatus, result.partial);
    searchCompleted.value = true;
  } catch (error) {
    if (seq !== searchSeq) return;
    if (isCancelledRequestError(error)) return;
    searchNodes.value = [];
    searchCompleted.value = true;
    searchIndexNotice.value = "";
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (seq === searchSeq) {
      searchLoading.value = false;
      if (searchAbortController === controller) searchAbortController = null;
    }
  }
}

/** 索引构建中自动重试当前搜索，避免用户手动重复触发。 */
function scheduleSearchRetry(query: string, status: FsSearchIndexStatus | undefined, partial: boolean | undefined): void {
  if (!partial || (status !== "queued" && status !== "building")) return;
  clearSearchRetryTimer();
  searchRetryTimer = setTimeout(() => {
    searchRetryTimer = null;
    if (props.searchKeyword?.trim() !== query) return;
    void runWorkspacePathSearch(query);
  }, 1200);
}

/** 清理搜索自动重试计时器。 */
function clearSearchRetryTimer(): void {
  if (!searchRetryTimer) return;
  clearTimeout(searchRetryTimer);
  searchRetryTimer = null;
}

/** 生成文件树搜索索引状态提示，缺失状态时保持旧 UI。 */
function buildSearchIndexNotice(
  status: FsSearchIndexStatus | undefined,
  partial: boolean | undefined,
  indexedCount: number | undefined,
  serverMessage: string | null | undefined,
): string {
  if (!status || !partial) return "";
  const countText = Number.isFinite(Number(indexedCount)) ? `，已索引 ${Number(indexedCount)} 个路径` : "";
  if (serverMessage) return `${serverMessage}${countText}`;
  if (status === "queued") return `文件索引等待后台构建，当前结果可能不完整${countText}`;
  if (status === "building") return `文件索引正在后台构建，当前结果可能不完整${countText}`;
  if (status === "stale") return `文件索引尚未完整，当前结果可能不完整${countText}`;
  if (status === "failed" || status === "disabled") return "文件索引不可用，已降级为实时搜索";
  return "";
}

/** 下载右键选中的 workspace 文件，权限和审计由后端传输接口统一处理。 */
async function downloadNodeFile(node: FsTreeNode): Promise<void> {
  if (node.isDir || downloadingPath.value) return;
  downloadingPath.value = node.path;
  try {
    const result = await downloadWorkspaceFile(props.ctx, { workspaceId: props.workspaceId, path: node.path });
    if (!result.ok) {
      message.error(result.message || "下载文件失败");
      return;
    }
    saveBlob(result.blob, result.filename || node.name || "download");
    message.success("已开始下载");
    trackProductEvent("workspace_file_transfer", {
      direction: "download",
      source: "file_tree",
      workspace_type: isSharedWorkspaceSelectionId(props.workspaceId) ? "shared" : "local",
    });
  } catch (error) {
    message.error(error instanceof Error ? error.message : "下载文件失败");
  } finally {
    downloadingPath.value = null;
  }
}

/** 触发浏览器保存下载的 Blob，并释放对象 URL。 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 搜索词、隐藏文件开关或外部刷新标记变化时刷新搜索结果。 */
watch(
  () => [props.searchKeyword, explorer.showHiddenFiles, props.workspaceId, props.searchRevision] as const,
  ([kw]) => {
    void runWorkspacePathSearch(kw ?? "");
  },
);

onBeforeUnmount(() => {
  searchAbortController?.abort(createCancelledRequestError("component-unmount"));
  searchAbortController = null;
  clearSearchRetryTimer();
});

</script>

<template>
  <div class="file-tree">
    <div v-if="searchIndexNotice" class="file-tree__search-notice">
      {{ searchIndexNotice }}
    </div>
    <div class="file-tree__host">
      <ExplorerPanelState v-if="treeSpinning && !treeReady" loading text="加载中" />
      <ExplorerPanelState v-else-if="!treeReady" text="无文件" />
      <a-spin v-else :spinning="treeSpinning" size="small" class="file-tree__spin">
        <a-directory-tree
          :key="treeRenderKey"
          :class="{ 'file-tree__directory--loading': explorer.previewLoading }"
          :tree-data="treeData"
          :expanded-keys="expandedKeys"
          :selected-keys="selectedKeys"
          :load-data="onLoadData"
          :block-node="true"
          :show-icon="false"
          @select="onSelect"
          @expand="onExpand"
        >
          <template #title="record">
            <a-dropdown :trigger="['contextmenu']">
              <div class="file-tree__node-shell" @contextmenu.prevent>
                <FileTreeNode
                  :node="record.fsNode"
                  :git-status-map="gitStatusMap"
                  :view-mode="explorer.viewMode"
                  @stage="onStage"
                  @unstage="onUnstage"
                />
              </div>
              <template #overlay>
                  <a-menu>
                  <a-menu-item @click="enqueueRelativePath(record.fsNode.path)">
                    <PlusOutlined />
                    {{ record.fsNode.isDir ? "添加路径到输入框" : "添加路径到输入框" }}
                  </a-menu-item>
                  <a-menu-item v-if="!record.fsNode.isDir" :disabled="downloadingPath === record.fsNode.path" @click="downloadNodeFile(record.fsNode)">
                    <DownloadOutlined />
                    下载文件
                  </a-menu-item>
                  <a-menu-item v-if="!record.fsNode.isDir" @click="enqueueWorkspaceFile(record.fsNode)">
                    <FileTextOutlined />
                    添加为文本附件
                  </a-menu-item>
                  <a-menu-item v-else @click="emit('uploadToDirectory', record.fsNode.path)">
                    <UploadOutlined />
                    上传文件到此目录
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </template>
        </a-directory-tree>
      </a-spin>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

/* 文件树已关闭 antd 虚拟滚动，由本层用原生滚动接管：flex 撑满 + min-height:0 即可
   滚动，不用 height:100%（该父级只有 flex、无指定高度，百分比高度会解析成 auto）。
   滚动条样式并入 layout.css 的共用清单，与会话列表同一口径。 */
.file-tree__host {
  flex: 1;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
}

.file-tree__spin {
  display: block;
  width: 100%;
  height: 100%;
}

.file-tree__search-notice {
  margin: 0 8px 6px;
  padding: 6px 8px;
  border: 1px solid rgba(217, 119, 6, 0.28);
  border-radius: 6px;
  background: rgba(255, 251, 235, 0.92);
  color: #92400e;
  font-size: 12px;
  line-height: 1.45;
}

.file-tree__directory--loading {
  pointer-events: none;
  opacity: 0.6;
}

.file-tree :deep(.ant-tree-node-content-wrapper) {
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.file-tree :deep(.ant-tree-title) {
  display: flex;
  width: 100%;
  min-width: 0;
}

.file-tree__node-shell {
  width: 100%;
  min-width: 0;
}

.file-tree__spin :deep(.ant-spin-nested-loading),
.file-tree__spin :deep(.ant-spin-container) {
  width: 100%;
  height: 100%;
}
</style>

