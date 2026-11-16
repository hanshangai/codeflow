<script setup lang="ts">
import { computed, ref } from "vue";
import { getPathDisplayInfo } from "@codeflowai/shared";
import { formatFileSizeLabel, formatMtimeLabel, formatMtimeTitle } from "../../../utils/fileMetaPresentation";
import {
  DownOutlined, RightOutlined, LoadingOutlined,
} from "@ant-design/icons-vue";
import type { GitFileStat, WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../../api/request";
import { useExplorerStore } from "../../../store/explorer";
import { Modal } from "ant-design-vue";
import GitCommitForm from "./git-commit-form.vue";
import ExplorerPanelState from "./explorer-panel-state.vue";

defineOptions({ name: "GitChangesPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
  searchKeyword?: string;
}>();

const emit = defineEmits<{
  (e: "selectFile", path: string, staged: boolean): void;
}>();

const explorer = useExplorerStore();
const layout = ref<"flat" | "tree">("flat");

// ---- 选择状态 ----
const selectedPaths = ref<Set<string>>(new Set());

// ---- 提交弹窗 ----
const commitModalOpen = ref(false);

const stagedRaw = computed(() => explorer.gitStatus?.staged ?? []);
const unstagedRaw = computed(() => explorer.gitStatus?.unstaged ?? []);
const untrackedRaw = computed(() => explorer.gitStatus?.untracked ?? []);

/** 搜索过滤 */
const searchKw = computed(() => props.searchKeyword?.trim().toLowerCase() ?? "");

function matchSearch(path: string): boolean {
  if (!searchKw.value) return true;
  const name = path.split("/").pop() ?? path;
  return name.toLowerCase().includes(searchKw.value);
}

const staged = computed(() => stagedRaw.value.filter(f => matchSearch(f.path)));
const unstaged = computed(() => unstagedRaw.value.filter(f => matchSearch(f.path)));
const untracked = computed(() => untrackedRaw.value.filter(p => matchSearch(p)));

/** 全部变更文件（用于 tree 视图） */
const allChanges = computed(() => {
  const map = new Map<string, { path: string; status: string; staged: boolean }>();
  for (const f of staged.value) {
    map.set(f.path, { path: f.path, status: f.index, staged: true });
  }
  for (const f of unstaged.value) {
    if (!map.has(f.path)) map.set(f.path, { path: f.path, status: f.working, staged: false });
  }
  for (const p of untracked.value) {
    if (!map.has(p)) map.set(p, { path: p, status: "?", staged: false });
  }
  return map;
});

// ---- 选择逻辑（按 section） ----

/** 获取某个 section 的所有路径 */
function sectionPaths(section: "staged" | "unstaged" | "untracked"): string[] {
  if (section === "staged") return staged.value.map(f => f.path);
  if (section === "unstaged") return unstaged.value.map(f => f.path);
  return untracked.value;
}

function isSectionAllSelected(section: "staged" | "unstaged" | "untracked"): boolean {
  const paths = sectionPaths(section);
  return paths.length > 0 && paths.every(p => selectedPaths.value.has(p));
}

function isSectionIndeterminate(section: "staged" | "unstaged" | "untracked"): boolean {
  const paths = sectionPaths(section);
  const count = paths.filter(p => selectedPaths.value.has(p)).length;
  return count > 0 && count < paths.length;
}

function toggleSectionSelectAll(section: "staged" | "unstaged" | "untracked", checked: boolean) {
  const next = new Set(selectedPaths.value);
  for (const p of sectionPaths(section)) {
    if (checked) next.add(p); else next.delete(p);
  }
  selectedPaths.value = next;
}

// ---- Section 折叠 ----
const collapsedSections = ref<Set<string>>(new Set());

function isSectionCollapsed(section: string): boolean {
  return collapsedSections.value.has(section);
}

function toggleSectionCollapse(section: string) {
  const next = new Set(collapsedSections.value);
  if (next.has(section)) next.delete(section); else next.add(section);
  collapsedSections.value = next;
}

function toggleSelect(path: string, checked: boolean) {
  const next = new Set(selectedPaths.value);
  if (checked) {
    next.add(path);
  } else {
    next.delete(path);
  }
  selectedPaths.value = next;
}

// ---- 工具栏按钮状态 ----

/** 选中文件中，属于 staged 的路径 */
const selectedStagedPaths = computed(() => {
  const stagedSet = new Set(stagedRaw.value.map(f => f.path));
  return [...selectedPaths.value].filter(p => stagedSet.has(p));
});

/** 选中文件中，属于 unstaged 的路径 */
const selectedUnstagedPaths = computed(() => {
  const unstagedSet = new Set(unstagedRaw.value.map(f => f.path));
  return [...selectedPaths.value].filter(p => unstagedSet.has(p));
});

/** 选中文件中，属于 untracked 的路径 */
const selectedUntrackedPaths = computed(() => {
  const untrackedSet = new Set(untrackedRaw.value);
  return [...selectedPaths.value].filter(p => untrackedSet.has(p));
});

/** 可 Stage：unstaged + untracked */
const canStage = computed(() => selectedUnstagedPaths.value.length + selectedUntrackedPaths.value.length > 0);
/** 可 Unstage：staged */
const canUnstage = computed(() => selectedStagedPaths.value.length > 0);
/** 可 Discard：unstaged（非 untracked） */
const canDiscard = computed(() => selectedUnstagedPaths.value.length > 0);
/** 可 Commit：任意选中 */
const canCommit = computed(() => selectedPaths.value.size > 0);

// ---- 工具栏操作 ----

function doStage() {
  const paths = [...selectedUnstagedPaths.value, ...selectedUntrackedPaths.value];
  if (paths.length) explorer.gitStage(props.ctx, props.workspaceId, paths);
}

function doUnstage() {
  const paths = selectedStagedPaths.value;
  if (paths.length) explorer.gitUnstage(props.ctx, props.workspaceId, paths);
}

function doDiscard() {
  const paths = selectedUnstagedPaths.value;
  if (!paths.length) return;
  Modal.confirm({
    title: "丢弃更改",
    content: `确定丢弃 ${paths.length} 个文件的工作区更改？此操作不可撤销。`,
    okText: "丢弃",
    okType: "danger",
    cancelText: "取消",
    onOk: () => explorer.gitDiscard(props.ctx, props.workspaceId, paths),
  });
}

function doOpenCommit() {
  commitModalOpen.value = true;
}

function onCommitted() {
  selectedPaths.value = new Set();
}

// ---- Tree 视图数据 ----

type GitTreeNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  selectable: boolean;
  children?: GitTreeNode[];
  /** 文件状态（仅叶子节点） */
  status?: string;
  staged?: boolean;
};

/** 从扁平路径列表构建树节点 */
const treeData = computed(() => {
  const root: Map<string, any> = new Map();

  for (const [path, info] of allChanges.value) {
    const parts = path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // 叶子节点
        current.set(part, { __leaf: true, path, status: info.status, staged: info.staged });
      } else {
        if (!current.has(part)) current.set(part, new Map());
        const next = current.get(part);
        if (next instanceof Map) {
          current = next;
        } else {
          // 冲突（文件和目录同名），跳过
          break;
        }
      }
    }
  }

  function buildNodes(map: Map<string, any>, prefix: string): GitTreeNode[] {
    const dirs: GitTreeNode[] = [];
    const files: GitTreeNode[] = [];

    for (const [name, value] of map) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (value instanceof Map) {
        dirs.push({
          key: fullPath,
          title: name,
          isLeaf: false,
          selectable: false,
          children: buildNodes(value, fullPath),
        });
      } else if (value.__leaf) {
        files.push({
          key: value.path,
          title: name,
          isLeaf: true,
          selectable: true,
          status: value.status,
          staged: value.staged,
        });
      }
    }

    // 紧凑目录合并：若目录只有一个子目录且无文件，合并路径
    const merged: GitTreeNode[] = [];
    for (const d of dirs) {
      let node = d;
      while (
        node.children &&
        node.children.length === 1 &&
        !node.children[0].isLeaf
      ) {
        const child = node.children[0];
        node = {
          key: child.key,
          title: `${node.title}/${child.title}`,
          isLeaf: false,
          selectable: false,
          children: child.children,
        };
      }
      merged.push(node);
    }

    return [...merged, ...files];
  }

  return buildNodes(root, "");
});

/** 目录 key → 所有后代叶子路径 */
const dirLeafMap = computed(() => {
  const map = new Map<string, string[]>();
  function collect(nodes: GitTreeNode[]): string[] {
    const leaves: string[] = [];
    for (const n of nodes) {
      if (n.isLeaf) {
        leaves.push(n.key);
      } else if (n.children) {
        const childLeaves = collect(n.children);
        map.set(n.key, childLeaves);
        leaves.push(...childLeaves);
      }
    }
    return leaves;
  }
  collect(treeData.value);
  return map;
});

function isDirAllSelected(dirKey: string): boolean {
  const leaves = dirLeafMap.value.get(dirKey);
  return !!leaves && leaves.length > 0 && leaves.every(p => selectedPaths.value.has(p));
}

function isDirIndeterminate(dirKey: string): boolean {
  const leaves = dirLeafMap.value.get(dirKey);
  if (!leaves || leaves.length === 0) return false;
  const count = leaves.filter(p => selectedPaths.value.has(p)).length;
  return count > 0 && count < leaves.length;
}

function toggleDirSelect(dirKey: string, checked: boolean) {
  const leaves = dirLeafMap.value.get(dirKey);
  if (!leaves) return;
  const next = new Set(selectedPaths.value);
  for (const p of leaves) {
    if (checked) next.add(p); else next.delete(p);
  }
  selectedPaths.value = next;
}

const treeExpandedKeys = ref<string[]>([]);

function expandAll() {
  const keys: string[] = [];
  function walk(nodes: GitTreeNode[]) {
    for (const n of nodes) {
      if (!n.isLeaf) {
        keys.push(n.key);
        if (n.children) walk(n.children);
      }
    }
  }
  walk(treeData.value);
  treeExpandedKeys.value = keys;
}

function collapseAll() {
  treeExpandedKeys.value = [];
}

function onTreeExpand(keys: string[]) {
  treeExpandedKeys.value = keys;
}

function onTreeSelect(_keys: string[], info: any) {
  const node = info.node;
  if (!node || !node.isLeaf) return;
  const path = node.key as string;
  const isStaged = node.staged ?? false;
  emit("selectFile", path, isStaged);
}

// ---- 通用 ----

/** 状态字母颜色 */
function statusColor(letter: string): string {
  if (letter === "M") return "var(--explorer-status-modified, #1890ff)";
  if (letter === "A") return "var(--explorer-status-added, #52c41a)";
  if (letter === "D") return "var(--explorer-status-deleted, #ff4d4f)";
  if (letter === "R") return "var(--explorer-status-renamed, #722ed1)";
  if (letter === "?") return "var(--explorer-status-untracked, #d48806)";
  return "var(--app-muted)";
}

function fileName(p: string): string { return getPathDisplayInfo(p).fileName; }
function fileDir(p: string): string { return getPathDisplayInfo(p).dirPath; }
function fileDirLabel(p: string): string { return fileDir(p) || "根目录"; }

/** 变更文件元信息取值；旧版 Client 不返回 fileStats 或文件已删除时统一为空。 */
function fileStat(p: string): GitFileStat | null {
  return explorer.gitStatus?.fileStats?.[p] ?? null;
}
function sizeLabel(p: string): string { return formatFileSizeLabel(fileStat(p)?.size); }
function mtimeLabel(p: string): string { return formatMtimeLabel(fileStat(p)?.mtime); }
function mtimeTitle(p: string): string { return formatMtimeTitle(fileStat(p)?.mtime); }

/** 是否有 diff 正在加载 */
const isDiffLoading = computed(() => explorer.gitDiffLoading);
/** 正在加载 diff 的文件路径 */
const loadingDiffPath = computed(() => isDiffLoading.value ? explorer.gitDiffPath : null);

function selectFile(path: string, isStaged: boolean) {
  emit("selectFile", path, isStaged);
}

defineExpose({
  layout,
  expandAll,
  collapseAll,
  canStage,
  canUnstage,
  canDiscard,
  canCommit,
  doStage,
  doUnstage,
  doDiscard,
  doOpenCommit,
});
</script>

<template>
  <div class="git-changes">
    <ExplorerPanelState v-if="!explorer.gitStatus && explorer.gitStatusLoading" loading text="加载中" />
    <ExplorerPanelState v-else-if="!explorer.gitStatus?.isRepo" text="未发现 Git 仓库" />
    <!-- ========== 树状视图 ========== -->
    <template v-else-if="layout === 'tree'">
      <a-directory-tree
        v-if="treeData.length"
        :class="{ 'git-changes__tree--loading': isDiffLoading }"
        :tree-data="treeData"
        :expanded-keys="treeExpandedKeys"
        :block-node="true"
        :show-icon="false"
        :selectable="true"
        @expand="onTreeExpand"
        @select="onTreeSelect"
      >
        <template #title="record">
          <span class="git-changes__tree-node">
            <a-checkbox
              v-if="record.isLeaf"
              :checked="selectedPaths.has(record.key)"
              @click.stop
              @change="(e: any) => toggleSelect(record.key, e.target.checked)"
              class="git-changes__tree-checkbox"
            />
            <a-checkbox
              v-else
              :checked="isDirAllSelected(record.key)"
              :indeterminate="isDirIndeterminate(record.key)"
              @click.stop
              @change="(e: any) => toggleDirSelect(record.key, e.target.checked)"
              class="git-changes__tree-checkbox"
            />
            <span class="git-changes__tree-label" :style="record.isLeaf && record.status ? { color: statusColor(record.status) } : {}">{{ record.title }}</span>
            <span class="git-changes__tree-status" :style="record.isLeaf && record.status ? { color: statusColor(record.status) } : {}">{{ record.isLeaf && record.status ? record.status : '' }}</span>
          </span>
        </template>
      </a-directory-tree>
      <ExplorerPanelState v-else-if="explorer.gitStatusLoading" loading text="加载中" />
      <ExplorerPanelState v-else text="工作区无变更" />
    </template>

    <!-- ========== 列表视图 ========== -->
    <template v-else>
      <!-- Staged -->
      <div v-if="staged.length" class="git-changes__section">
        <div class="git-changes__header">
          <a-checkbox
            :checked="isSectionAllSelected('staged')"
            :indeterminate="isSectionIndeterminate('staged')"
            @change="(e: any) => toggleSectionSelectAll('staged', e.target.checked)"
          />
          <span class="git-changes__title">Staged ({{ staged.length }})</span>
          <a-button size="small" type="text" class="git-changes__collapse-btn" @click="toggleSectionCollapse('staged')">
            <RightOutlined v-if="isSectionCollapsed('staged')" />
            <DownOutlined v-else />
          </a-button>
        </div>
        <div v-if="!isSectionCollapsed('staged')" class="git-changes__list" :class="{ 'git-changes__list--loading': isDiffLoading }">
          <div
            v-for="f in staged" :key="'s-' + f.path"
            class="git-changes__item"
            :class="{
              'git-changes__item--selected': explorer.gitDiffPath === f.path,
              'git-changes__item--dimmed': isDiffLoading && loadingDiffPath !== f.path,
            }"
            @click="selectFile(f.path, true)"
          >
            <a-checkbox
              :checked="selectedPaths.has(f.path)"
              @click.stop
              @change="(e: any) => toggleSelect(f.path, e.target.checked)"
              class="git-changes__checkbox"
            />
            <div class="git-changes__content">
              <div class="git-changes__main">
                <span class="git-changes__name" :title="fileName(f.path)" :style="{ color: statusColor(f.index) }">{{ fileName(f.path) }}</span>
                <span class="git-changes__mtime" :title="mtimeTitle(f.path)">{{ mtimeLabel(f.path) }}</span>
                <span class="git-changes__size">{{ sizeLabel(f.path) }}</span>
                <LoadingOutlined v-if="loadingDiffPath === f.path" class="git-changes__spinner" />
                <span v-else class="git-changes__status" :style="{ color: statusColor(f.index) }">{{ f.index }}</span>
              </div>
              <div class="git-changes__sub" :title="fileDirLabel(f.path)">{{ fileDirLabel(f.path) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Changes (Unstaged) -->
      <div v-if="unstaged.length" class="git-changes__section">
        <div class="git-changes__header">
          <a-checkbox
            :checked="isSectionAllSelected('unstaged')"
            :indeterminate="isSectionIndeterminate('unstaged')"
            @change="(e: any) => toggleSectionSelectAll('unstaged', e.target.checked)"
          />
          <span class="git-changes__title">Changes ({{ unstaged.length }})</span>
          <a-button size="small" type="text" class="git-changes__collapse-btn" @click="toggleSectionCollapse('unstaged')">
            <RightOutlined v-if="isSectionCollapsed('unstaged')" />
            <DownOutlined v-else />
          </a-button>
        </div>
        <div v-if="!isSectionCollapsed('unstaged')" class="git-changes__list" :class="{ 'git-changes__list--loading': isDiffLoading }">
          <div
            v-for="f in unstaged" :key="'u-' + f.path"
            class="git-changes__item"
            :class="{
              'git-changes__item--selected': explorer.gitDiffPath === f.path,
              'git-changes__item--dimmed': isDiffLoading && loadingDiffPath !== f.path,
            }"
            @click="selectFile(f.path, false)"
          >
            <a-checkbox
              :checked="selectedPaths.has(f.path)"
              @click.stop
              @change="(e: any) => toggleSelect(f.path, e.target.checked)"
              class="git-changes__checkbox"
            />
            <div class="git-changes__content">
              <div class="git-changes__main">
                <span class="git-changes__name" :title="fileName(f.path)" :style="{ color: statusColor(f.working) }">{{ fileName(f.path) }}</span>
                <span class="git-changes__mtime" :title="mtimeTitle(f.path)">{{ mtimeLabel(f.path) }}</span>
                <span class="git-changes__size">{{ sizeLabel(f.path) }}</span>
                <LoadingOutlined v-if="loadingDiffPath === f.path" class="git-changes__spinner" />
                <span v-else class="git-changes__status" :style="{ color: statusColor(f.working) }">{{ f.working }}</span>
              </div>
              <div class="git-changes__sub" :title="fileDirLabel(f.path)">{{ fileDirLabel(f.path) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Untracked -->
      <div v-if="untracked.length" class="git-changes__section">
        <div class="git-changes__header">
          <a-checkbox
            :checked="isSectionAllSelected('untracked')"
            :indeterminate="isSectionIndeterminate('untracked')"
            @change="(e: any) => toggleSectionSelectAll('untracked', e.target.checked)"
          />
          <span class="git-changes__title">Untracked ({{ untracked.length }})</span>
          <a-button size="small" type="text" class="git-changes__collapse-btn" @click="toggleSectionCollapse('untracked')">
            <RightOutlined v-if="isSectionCollapsed('untracked')" />
            <DownOutlined v-else />
          </a-button>
        </div>
        <div v-if="!isSectionCollapsed('untracked')" class="git-changes__list" :class="{ 'git-changes__list--loading': isDiffLoading }">
          <div
            v-for="p in untracked" :key="'t-' + p"
            class="git-changes__item"
            :class="{ 'git-changes__item--dimmed': isDiffLoading && loadingDiffPath !== p }"
            @click="selectFile(p, false)"
          >
            <a-checkbox
              :checked="selectedPaths.has(p)"
              @click.stop
              @change="(e: any) => toggleSelect(p, e.target.checked)"
              class="git-changes__checkbox"
            />
            <div class="git-changes__content">
              <div class="git-changes__main">
                <span class="git-changes__name" :title="fileName(p)" :style="{ color: statusColor('?') }">{{ fileName(p) }}</span>
                <span class="git-changes__mtime" :title="mtimeTitle(p)">{{ mtimeLabel(p) }}</span>
                <span class="git-changes__size">{{ sizeLabel(p) }}</span>
                <LoadingOutlined v-if="loadingDiffPath === p" class="git-changes__spinner" />
                <span v-else class="git-changes__status" :style="{ color: statusColor('?') }">?</span>
              </div>
              <div class="git-changes__sub" :title="fileDirLabel(p)">{{ fileDirLabel(p) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 无变更 / 无搜索结果 -->
      <template v-if="!staged.length && !unstaged.length && !untracked.length">
        <ExplorerPanelState v-if="explorer.gitStatusLoading && !searchKw" loading text="加载中" />
        <ExplorerPanelState v-else :text="searchKw ? '无匹配文件' : '工作区无变更'" />
      </template>
    </template>

    <!-- 提交弹窗 -->
    <GitCommitForm
      v-model:open="commitModalOpen"
      :workspace-id="workspaceId"
      :ctx="ctx"
      :file-paths="[...selectedPaths]"
      @committed="onCommitted"
    />
  </div>
</template>

<style scoped>
.git-changes {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.git-changes__section {
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

.git-changes__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  background: var(--app-hover, rgba(0, 0, 0, 0.02));
}

.git-changes__title {
  flex: 1;
}

.git-changes__collapse-btn {
  flex-shrink: 0;
  font-size: 10px;
}

.git-changes__list {
  padding: 2px 0;
}

.git-changes__list--loading {
  pointer-events: none;
}

.git-changes__tree--loading {
  pointer-events: none;
  opacity: 0.6;
}

.git-changes__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s, opacity 0.15s;
}

.git-changes__item--dimmed {
  opacity: 0.5;
}

.git-changes__item:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.git-changes__item--selected {
  background: var(--app-hover, rgba(0, 0, 0, 0.06));
}

.git-changes__checkbox {
  flex-shrink: 0;
  margin-top: 2px;
}

.git-changes__content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.git-changes__main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.git-changes__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.git-changes__sub {
  color: var(--app-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-changes__size {
  font-size: 11px;
  color: var(--app-muted);
  flex-shrink: 0;
  width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.git-changes__mtime {
  font-size: 11px;
  color: var(--app-muted);
  flex-shrink: 0;
  width: 50px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.git-changes__status {
  font-weight: 600;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.git-changes__spinner {
  color: var(--app-accent, #c96442);
  flex-shrink: 0;
  animation: git-changes-spin 1s linear infinite;
}

@keyframes git-changes-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Tree 视图节点 */
.git-changes__tree-node {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.git-changes__tree-checkbox {
  flex-shrink: 0;
}

.git-changes__tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-changes__tree-status {
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  margin-left: 4px;
}

.git-changes :deep(.ant-tree-node-content-wrapper) {
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.git-changes :deep(.ant-tree-title) {
  display: flex;
  width: 100%;
  min-width: 0;
}
</style>

