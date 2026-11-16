<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { ClientDirectoryNode } from "@codeflowai/shared";

import { fetchClientDirectoryTree } from "../../../api/clientFs";
import { useApiContext } from "../../../composables/useApiContext";

defineOptions({ name: "ClientDirectoryPickerModal" });

type TreeItem = {
  /** Ant Tree UI key；真实路径可能在快捷入口和子目录中重复。 */
  key: string;
  title: string;
  isLeaf: boolean;
  selectable: boolean;
  fsNode: ClientDirectoryNode;
  children?: TreeItem[];
};

type TreeNodeLike = {
  key?: string;
  fsNode?: ClientDirectoryNode;
  dataRef?: {
    key?: string;
    fsNode?: ClientDirectoryNode;
  };
};

const props = defineProps<{
  open: boolean;
  clientId: string;
  initialValue?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "pick", value: string): void;
}>();

const { ctx } = useApiContext();

const treeNodes = ref<ClientDirectoryNode[]>([]);
const expandedKeys = ref<string[]>([]);
const selectedPath = ref("");
const selectedKey = ref("");
const loading = ref(false);
let directoryLoadSeq = 0;

const normalizedClientId = computed(() => props.clientId.trim());
const selectedLabel = computed(() => selectedPath.value || "还没有选择目录");
const treeData = computed<TreeItem[]>(() => toTreeData(treeNodes.value));
const selectedKeys = computed<string[]>(() => {
  if (!selectedPath.value) return [];
  if (selectedKey.value && hasTreeKey(treeData.value, selectedKey.value)) return [selectedKey.value];
  const visibleKey = findTreeKeyByPath(treeData.value, selectedPath.value);
  return visibleKey ? [visibleKey] : [];
});

watch(
  () => [props.open, props.clientId] as const,
  async ([open]) => {
    const loadSeq = nextDirectoryLoadSeq();
    if (!open) {
      loading.value = false;
      return;
    }
    treeNodes.value = [];
    expandedKeys.value = [];
    selectedPath.value = String(props.initialValue ?? "").trim();
    selectedKey.value = "";
    if (!normalizedClientId.value) {
      loading.value = false;
      return;
    }
    await loadRoot(loadSeq);
  },
  { immediate: true },
);

/** 生成目录加载序号，用于忽略切换 Client 或关闭弹窗后的旧响应。 */
function nextDirectoryLoadSeq(): number {
  directoryLoadSeq += 1;
  return directoryLoadSeq;
}

/** 判断目录加载结果是否仍属于当前弹窗和当前目标 Client。 */
function isDirectoryLoadCurrent(loadSeq: number, clientId: string): boolean {
  return props.open && loadSeq === directoryLoadSeq && normalizedClientId.value === clientId;
}

/** 把 Client 返回的目录节点转换为 Ant Tree 节点，并生成全树唯一 UI key。 */
function toTreeData(nodes: ClientDirectoryNode[], parentKey = "root"): TreeItem[] {
  return nodes.map((node, index) => {
    const key = createTreeItemKey(parentKey, index, node.path);
    return {
      key,
      title: node.name,
      isLeaf: node.isLeaf === true,
      selectable: true,
      fsNode: node,
      children: node.children ? toTreeData(node.children, key) : undefined,
    };
  });
}

/** 生成仅用于渲染状态的树 key，避免重复绝对路径破坏 Ant Tree 层级。 */
function createTreeItemKey(parentKey: string, index: number, fsPath: string): string {
  return `${parentKey}/${index}:${fsPath}`;
}

/** 检查当前渲染树中是否还存在指定 UI key。 */
function hasTreeKey(nodes: TreeItem[], key: string): boolean {
  for (const node of nodes) {
    if (node.key === key) return true;
    if (node.children && hasTreeKey(node.children, key)) return true;
  }
  return false;
}

/** 按真实路径找到首个可见 UI key，用于初始值或刷新后恢复选中态。 */
function findTreeKeyByPath(nodes: TreeItem[], dirPath: string): string {
  for (const node of nodes) {
    if (node.fsNode.path === dirPath) return node.key;
    const childKey = node.children ? findTreeKeyByPath(node.children, dirPath) : "";
    if (childKey) return childKey;
  }
  return "";
}

/** 加载目标 Client 暴露的目录入口。 */
async function loadRoot(loadSeq = nextDirectoryLoadSeq()): Promise<void> {
  const clientId = normalizedClientId.value;
  if (!clientId) return;
  loading.value = true;
  try {
    const res = await fetchClientDirectoryTree(ctx.value, {
      clientId,
      dirPath: "",
      depth: 1,
    });
    if (!isDirectoryLoadCurrent(loadSeq, clientId)) return;
    if (!res.ok) throw new Error(res.message);
    treeNodes.value = res.nodes ?? [];
  } catch (error) {
    if (!isDirectoryLoadCurrent(loadSeq, clientId)) return;
    treeNodes.value = [];
    message.error(error instanceof Error ? error.message : "加载 Client 目录失败");
  } finally {
    if (isDirectoryLoadCurrent(loadSeq, clientId)) loading.value = false;
  }
}

/** 将懒加载返回的子目录写回所有相同真实路径节点，覆盖快捷入口重复路径场景。 */
function insertChildren(dirPath: string, children: ClientDirectoryNode[]): void {
  const insert = (nodes: ClientDirectoryNode[]): boolean => {
    let inserted = false;
    for (const node of nodes) {
      if (node.path === dirPath) {
        node.children = children;
        node.isLeaf = children.length === 0;
        inserted = true;
        continue;
      }
      if (node.children && insert(node.children)) inserted = true;
    }
    return inserted;
  };
  insert(treeNodes.value);
  treeNodes.value = [...treeNodes.value];
}

/** 展开指定目录并按需读取其子目录。 */
async function expandDir(dirPath: string): Promise<void> {
  const clientId = normalizedClientId.value;
  const loadSeq = directoryLoadSeq;
  const res = await fetchClientDirectoryTree(ctx.value, {
    clientId,
    dirPath,
    depth: 1,
  });
  if (!isDirectoryLoadCurrent(loadSeq, clientId)) return;
  if (!res.ok) throw new Error(res.message);
  insertChildren(dirPath, res.nodes ?? []);
}

/** Ant Tree 懒加载回调：只向目标 Client 请求被展开目录。 */
async function onLoadData(treeNode: TreeNodeLike): Promise<void> {
  const dirPath = treeNode.fsNode?.path ?? treeNode.dataRef?.fsNode?.path ?? "";
  if (!dirPath) {
    const error = new Error("无法识别目录节点路径");
    message.error(error.message);
    throw error;
  }
  try {
    await expandDir(dirPath);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "加载子目录失败");
    throw error;
  }
}

/** 记录当前选中的目标 Client 绝对目录。 */
function onSelect(_keys: string[], info: { node?: TreeNodeLike }): void {
  const node = info.node?.fsNode ?? info.node?.dataRef?.fsNode;
  if (!node) return;
  selectedPath.value = node.path;
  selectedKey.value = String(info.node?.key ?? info.node?.dataRef?.key ?? "");
}

/** 同步受控展开状态。 */
function onExpand(keys: string[]): void {
  expandedKeys.value = keys;
}

/** 关闭弹窗并交还开关状态给父组件。 */
function close(): void {
  emit("update:open", false);
}

/** 确认选择并把目标 Client 绝对路径写回父组件。 */
function confirmPick(): void {
  const value = selectedPath.value.trim();
  if (!value) {
    message.warning("请选择目录");
    return;
  }
  emit("pick", value);
  emit("update:open", false);
}
</script>

<template>
  <a-modal
    :open="open"
    title="选择 Client 本机目录"
    :width="760"
    ok-text="使用此目录"
    cancel-text="取消"
    :mask-closable="true"
    @ok="confirmPick"
    @cancel="close"
  >
    <div class="client-directory-picker">
      <a-alert
        v-if="!normalizedClientId"
        type="warning"
        show-icon
        message="请先选择目标 Client"
        description="目录树来自目标 Client 所在机器，不是当前浏览器所在机器。"
      />

      <template v-else>
        <div class="client-directory-picker__toolbar">
          <div>
            <div class="client-directory-picker__meta">目标 Client：{{ normalizedClientId }}</div>
            <div class="client-directory-picker__path">{{ selectedLabel }}</div>
          </div>
          <a-button size="small" :loading="loading" @click="loadRoot">刷新</a-button>
        </div>

        <a-spin :spinning="loading">
          <div class="client-directory-picker__tree">
            <a-directory-tree
              v-if="treeData.length"
              :tree-data="treeData"
              :expanded-keys="expandedKeys"
              :selected-keys="selectedKeys"
              :load-data="onLoadData"
              :block-node="true"
              :show-icon="false"
              @select="onSelect"
              @expand="onExpand"
            />
            <a-empty v-else-if="!loading" description="当前 Client 没有可选目录入口" />
          </div>
        </a-spin>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.client-directory-picker {
  display: grid;
  gap: 12px;
}

.client-directory-picker__toolbar {
  padding: 12px 14px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  background: #f8fafc;
}

/* 深色模式：toolbar 换为半透明白底，避免硬编码浅蓝灰刺眼 */
:root[data-theme="dark"] .client-directory-picker__toolbar {
  background: rgba(255, 255, 255, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .client-directory-picker__toolbar {
    background: rgba(255, 255, 255, 0.04);
  }
}

.client-directory-picker__meta {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.client-directory-picker__path {
  margin-top: 4px;
  font-size: 13px;
  color: var(--app-text, #1f2937);
  word-break: break-all;
}

.client-directory-picker__tree {
  min-height: 340px;
  max-height: 480px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
}
</style>
