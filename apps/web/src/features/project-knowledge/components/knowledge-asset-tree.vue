<script setup lang="ts">
import type { KnowledgeAssetNode, KnowledgeAssetNodeState } from "@codeflowai/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CaretRightOutlined, EllipsisOutlined, FileMarkdownOutlined, FolderOpenOutlined, FolderOutlined, LoadingOutlined } from "@ant-design/icons-vue";
import { knowledgeTreeRows } from "../knowledgeTreeModel";
const props = defineProps<{ nodes: KnowledgeAssetNode[]; states: KnowledgeAssetNodeState[]; selectedId: string | null; workspaceKey: string; legacyWorkspaceKey?: string; canWrite: boolean; busy?: boolean; counts?: Record<string, number>; structureCounts?: Record<string, number>; generatingCounts?: Record<string, number>; newNodeIds?: string[]; emptyText?: string; selectionResetKey?: number }>();
const emit = defineEmits<{ select: [id: string]; checkedChange: [ids: string[]]; generate: [id: string]; review: [id: string]; updates: [id: string] }>();
const expanded = ref(new Set<string>()), checked = ref<string[]>([]);
const viewport = ref<HTMLElement | null>(null), top = ref(0), height = ref(400);
const rowHeight = 30;
let observer: ResizeObserver | null = null;
function report(error: unknown): void { console.error("[knowledge-tree]", { code: "KNOWLEDGE_TREE_STATE_FAILED", requestId: null, workspaceKey: props.workspaceKey, rootCause: String(error) }); }
function persist(): void { try { localStorage.setItem(`knowledge-tree:${props.workspaceKey}`, JSON.stringify([...expanded.value])); } catch (error) { report(error); } }
watch(() => props.workspaceKey, () => {
  checked.value = []; emit("checkedChange", []); top.value = 0;
  try {
    const storageKey = `knowledge-tree:${props.workspaceKey}`;
    const legacyKey = props.legacyWorkspaceKey ? `knowledge-tree:${props.legacyWorkspaceKey}` : null;
    const legacyValue = legacyKey ? localStorage.getItem(legacyKey) : null;
    const raw = localStorage.getItem(storageKey) ?? legacyValue;
    const saved: unknown = JSON.parse(raw ?? "[]");
    expanded.value = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
    if (localStorage.getItem(storageKey) === null && legacyValue !== null) localStorage.setItem(storageKey, legacyValue);
  }
  catch (error) { expanded.value = new Set(); report(error); }
  if (viewport.value) viewport.value.scrollTop = 0;
}, { immediate: true });
watch(() => [props.nodes, props.newNodeIds], () => { updateChecked(checked.value); });
watch(() => props.selectionResetKey, () => {
  if (!checked.value.length) return;
  checked.value = []; emit("checkedChange", []);
});
const rows = computed(() => knowledgeTreeRows(props.nodes, expanded.value));
const start = computed(() => Math.max(0, Math.floor(top.value / rowHeight) - 6));
const rendered = computed(() => rows.value.slice(start.value, start.value + Math.ceil(height.value / rowHeight) + 12));
const states = computed(() => new Map(props.states.map(s => [s.nodeId, s])));
const activeNodes = computed(() => props.nodes.filter(node => !node.archived));
const nodeById = computed(() => new Map(activeNodes.value.map(node => [node.id, node])));
const childrenById = computed(() => {
  const result = new Map<string, KnowledgeAssetNode[]>();
  for (const node of activeNodes.value) {
    if (!node.parentId) continue;
    const children = result.get(node.parentId) ?? [];
    children.push(node);
    result.set(node.parentId, children);
  }
  return result;
});
watch(rows, async () => {
  const max = Math.max(0, rows.value.length * rowHeight - height.value);
  if (top.value > max) { top.value = max; await nextTick(); if (viewport.value) viewport.value.scrollTop = max; }
});
/** 切换单个目录并记住展开状态，搜索统一由页面顶部负责。 */
function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next; persist();
}
/** 点击目录同时展开；阅读目标仍由父页统一决定并保护未保存编辑。 */
function select(id: string): void {
  if (props.busy) return;
  if (nodeById.value.get(id)?.contentMode === "directory" && !expanded.value.has(id)) { expanded.value = new Set([...expanded.value, id]); persist(); }
  emit("select", id);
}
/** 恢复正文或由目录打开后代时展开祖先，并让实际阅读文件保持可见。 */
watch(() => props.selectedId, async id => {
  if (!id) return;
  const next = new Set(expanded.value), seen = new Set<string>();
  let parentId = nodeById.value.get(id)?.parentId;
  while (parentId && !seen.has(parentId)) { seen.add(parentId); next.add(parentId); parentId = nodeById.value.get(parentId)?.parentId; }
  if (next.size !== expanded.value.size) { expanded.value = next; persist(); }
  await nextTick();
  if (id !== props.selectedId || !viewport.value) return;
  const index = rows.value.findIndex(row => row.node.id === id);
  if (index >= 0 && (index * rowHeight < top.value || (index + 1) * rowHeight > top.value + height.value)) viewport.value.scrollTop = index * rowHeight;
}, { immediate: true });
/** 判断节点是否位于某个选择根下，避免把整棵树展开后再传给批量任务。 */
function isWithin(nodeId: string, ancestorId: string): boolean {
  let currentId: string | null = nodeId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true;
    seen.add(currentId);
    currentId = nodeById.value.get(currentId)?.parentId ?? null;
  }
  return false;
}

/** 找到覆盖当前节点的最近选择根，用于取消子目录时保留同级范围。 */
function selectionOwner(id: string): string | null {
  let currentId: string | null = id;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    if (checked.value.includes(currentId)) return currentId;
    seen.add(currentId);
    currentId = nodeById.value.get(currentId)?.parentId ?? null;
  }
  return null;
}

/** 返回范围内排除指定子树后的最小选择根集合。 */
function rootsExcluding(scopeId: string, excludedId: string): string[] {
  if (scopeId === excludedId) return [];
  if (!isWithin(excludedId, scopeId)) return [scopeId];
  const children = childrenById.value.get(scopeId) ?? [];
  if (!children.length) return [scopeId];
  return children.flatMap(child => rootsExcluding(child.id, excludedId));
}

/** 仅保留可处理的正式选择根，避免取消父选区时混入待采用候选。 */
function updateChecked(ids: string[]): void {
  const next = [...new Set(ids)].filter(id => nodeById.value.has(id) && !props.newNodeIds?.includes(id));
  checked.value = next;
  emit("checkedChange", next);
}

/** 鼠标与键盘均拒绝候选选区；取消子目录时保留其余正式同级范围。 */
function check(id: string): void {
  if (!props.canWrite || props.busy || props.newNodeIds?.includes(id)) return;
  const owner = selectionOwner(id);
  if (owner) {
    const outside = checked.value.filter(root => !isWithin(root, owner));
    updateChecked([...outside, ...rootsExcluding(owner, id)]);
    return;
  }

  const hasSelectedDescendant = checked.value.some(root => root !== id && isWithin(root, id));
  const outside = checked.value.filter(root => !isWithin(root, id));
  updateChecked(hasSelectedDescendant ? [...outside, id] : [...checked.value, id]);
}

/** 仅正式节点继承父目录的勾选，候选不暗示已进入生成范围。 */
function isChecked(id: string): boolean { return !props.newNodeIds?.includes(id) && checked.value.some(root => isWithin(id, root)); }

/** 仅部分后代被选中时显示原生半选状态。 */
function isIndeterminate(id: string): boolean {
  return !isChecked(id) && checked.value.some(root => root !== id && isWithin(root, id));
}
/** 键盘跳过已展开的父目录，避免自动打开首篇文档使向上导航回到原位。 */
function keyboard(event: KeyboardEvent): void {
  if ((event.target as HTMLElement).tagName === "INPUT") return;
  const index = rows.value.findIndex(r => r.node.id === props.selectedId), row = rows.value[index];
  if (event.key === "ArrowRight" && row?.hasChildren && !row.expanded) toggle(row.node.id);
  else if (event.key === "ArrowLeft" && row?.hasChildren && row.expanded) toggle(row.node.id);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const navigable = rows.value.map((row, index) => ({ row, index })).filter(({ row }) => !row.hasChildren || !row.expanded);
    const next = (event.key === "Home" ? navigable[0] : event.key === "End" ? navigable.at(-1)
      : event.key === "ArrowDown" ? navigable.find(item => item.index > index) : navigable.filter(item => item.index < index).at(-1))?.index;
    if (next === undefined) { event.preventDefault(); return; }
    const target = rows.value[next]; if (!target) return;
    select(target.node.id);
    if (viewport.value && (next * rowHeight < top.value || (next + 1) * rowHeight > top.value + height.value)) viewport.value.scrollTop = next * rowHeight;
  } else if (event.key === " " && row && props.canWrite) check(row.node.id);
  else return;
  event.preventDefault();
}
onMounted(() => { observer = new ResizeObserver(([entry]) => { if (entry) height.value = entry.contentRect.height; }); if (viewport.value) observer.observe(viewport.value); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="asset-tree">
    <div ref="viewport" class="tree-viewport" role="tree" aria-label="规格库目录" aria-multiselectable="true" tabindex="0" @scroll="top = ($event.target as HTMLElement).scrollTop" @keydown="keyboard">
      <div v-if="!rows.length" class="tree-empty">{{ emptyText || '还没有规格库目录' }}</div>
      <div :style="{ height: `${rows.length * rowHeight}px`, position: 'relative' }">
        <div v-for="(row, index) in rendered" :key="row.node.id" class="asset-tree-row" role="treeitem" :aria-level="row.depth + 1" :aria-selected="selectedId === row.node.id" :aria-expanded="row.hasChildren ? row.expanded : undefined" :class="{ selected: selectedId === row.node.id }" :style="{ top: `${(start + index) * rowHeight}px`, paddingInlineStart: `${Math.min(row.depth, 3) * 18}px` }">
          <button v-if="row.hasChildren" class="disclosure" type="button" :aria-label="`${row.expanded ? '折叠' : '展开'}${row.node.title}`" @click="toggle(row.node.id)"><CaretRightOutlined :rotate="row.expanded ? 90 : 0" /></button>
          <span v-else class="disclosure" aria-hidden="true" />
          <input v-if="canWrite" type="checkbox" :disabled="newNodeIds?.includes(row.node.id)" :title="newNodeIds?.includes(row.node.id) ? '请先采用新候选，再完善或复检；修订请打开原工作会话。' : undefined" :checked="isChecked(row.node.id)" :indeterminate="isIndeterminate(row.node.id)" :aria-checked="isIndeterminate(row.node.id) ? 'mixed' : isChecked(row.node.id) ? 'true' : 'false'" :aria-label="`选择${row.node.title}`" @change="check(row.node.id)">
          <button class="node-label" type="button" :title="row.node.title" @click="select(row.node.id)">
            <component :is="row.node.contentMode === 'directory' || row.hasChildren ? (row.expanded ? FolderOpenOutlined : FolderOutlined) : FileMarkdownOutlined" class="node-icon" :class="{ document: row.node.contentMode !== 'directory' && !row.hasChildren }" aria-hidden="true" />
            <span class="node-title">{{ row.node.title }}</span>
          </button>
          <span v-if="newNodeIds?.includes(row.node.id)" class="pending-count">待新增</span>
          <span v-if="generatingCounts?.[row.node.id]" class="generating-status" :title="`${generatingCounts[row.node.id]} 篇文档生成中`"><LoadingOutlined spin aria-hidden="true" />{{ row.node.contentMode === 'directory' ? generatingCounts[row.node.id] : '' }} 生成中</span>
          <span v-if="counts?.[row.node.id]" class="pending-count" :title="`${counts[row.node.id]} 篇文档待确认更新`">{{ counts[row.node.id] }}</span>
          <span v-if="structureCounts?.[row.node.id]" class="pending-count" :title="`${structureCounts[row.node.id]} 项变更待确认`">变更</span>
          <span v-if="row.node.contentMode !== 'directory' && !generatingCounts?.[row.node.id]" class="state-dot" :class="{ reference: row.node.contentMode === 'reference', ready: states.get(row.node.id)?.revisionId, draft: counts?.[row.node.id] || states.get(row.node.id)?.draftCount, error: states.get(row.node.id)?.error }" :title="states.get(row.node.id)?.error?.message ?? (row.node.contentMode === 'reference' ? '实时引用原文' : counts?.[row.node.id] ? '有待确认更新' : states.get(row.node.id)?.revisionId ? '已入库启用' : '待生成')" />
          <a-dropdown v-if="row.node.contentMode === 'directory'" :trigger="['click']"><a-button class="directory-actions" type="text" size="small" :aria-label="`${row.node.title}目录操作`" :disabled="busy" @keydown.stop><template #icon><EllipsisOutlined /></template></a-button><template #overlay><a-menu><a-menu-item v-if="counts?.[row.node.id] || structureCounts?.[row.node.id] || generatingCounts?.[row.node.id]" @click="emit('updates', row.node.id)">查看此目录更新</a-menu-item><a-menu-item :disabled="!canWrite || newNodeIds?.includes(row.node.id)" @click="emit('generate', row.node.id)">生成此目录</a-menu-item><a-menu-item :disabled="!canWrite || newNodeIds?.includes(row.node.id)" @click="emit('review', row.node.id)">复检此目录</a-menu-item></a-menu></template></a-dropdown>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.asset-tree { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.tree-viewport { flex: 1; min-height: 0; min-width: 0; overflow: auto; outline-offset: -2px; }
.asset-tree-row { position: absolute; inset-inline: 8px; height: 30px; display: flex; align-items: center; gap: 4px; padding-inline-end: 8px; border-radius: 2px; }
.asset-tree-row:hover { background: var(--app-sidebar-hover-bg); }
.asset-tree-row.selected { background: var(--app-sidebar-active-bg); }
.directory-actions { flex-shrink: 0; opacity: 0; }
.asset-tree-row:hover .directory-actions, .asset-tree-row:focus-within .directory-actions { opacity: 1; }
@media (hover: none) { .directory-actions { opacity: 1; } }
.disclosure { width: 20px; height: 30px; display: inline-grid; place-items: center; flex: 0 0 auto; padding: 0; border: 0; background: transparent; color: var(--app-text); font-size: 10px; }
button.disclosure { cursor: pointer; }
.node-label { flex: 1; min-width: 0; height: 30px; display: flex; align-items: center; gap: 4px; text-align: left; padding: 0; border: 0; background: none; color: var(--app-text); font: inherit; font-size: 13px; cursor: pointer; }
.node-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-icon { flex: 0 0 auto; color: var(--app-muted); font-size: 14px; }
.node-icon.document { color: light-dark(#527a9d, #7fa8ca); }
input { flex: 0 0 auto; width: 13px; height: 13px; margin: 0; accent-color: var(--app-accent); }
.state-dot { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: var(--app-muted); opacity: .45; }
.pending-count { flex-shrink: 0; font-size: 10px; color: var(--app-muted); font-variant-numeric: tabular-nums; }
.generating-status { display: inline-flex; flex-shrink: 0; align-items: center; gap: 3px; font-size: 11px; color: var(--app-accent); }
.state-dot.reference { background: var(--app-accent); opacity: 1; }.state-dot.ready { background: var(--app-success); opacity: 1; }.state-dot.draft { background: var(--app-warning); opacity: 1; }.state-dot.error { background: var(--app-danger); opacity: 1; }
.tree-empty { padding: 26px 12px; color: var(--app-muted); text-align: center; font-size: 12px; }
</style>
