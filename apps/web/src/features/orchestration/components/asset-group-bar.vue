<script setup lang="ts">
import { computed, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import { PlusOutlined, SettingOutlined } from "@ant-design/icons-vue";
import type { OrchAssetGroup } from "@codeflowai/shared";
import type { AssetGroupFilter } from "../composables/useAssetGroups";

type GroupableAsset = { id: string; name: string; kind?: string | null };
const props = defineProps<{
  groups: OrchAssetGroup[];
  modelValue: AssetGroupFilter;
  loading?: boolean;
  canManage?: boolean;
  loadGroups: () => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  assignGroup: (assetId: string, groupId: string | null) => Promise<void>;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: AssetGroupFilter): void }>();

const managerOpen = ref(false);
const draftName = ref("");
const renameId = ref<string | null>(null);
const renameName = ref("");
const creating = ref(false);
const busyGroupId = ref<string | null>(null);
const moveOpen = ref(false);
const moveTarget = ref<GroupableAsset | null>(null);
const moveSearch = ref("");
const moving = ref(false);
const options = computed(() => [
  { label: "全部分组", value: "all" },
  ...props.groups.map((group) => ({ label: group.builtin ? `${group.name} · 内置` : group.name, value: group.id })),
  { label: "未分组", value: "ungrouped" },
]);
const filteredMoveGroups = computed(() => {
  const query = moveSearch.value.trim().toLocaleLowerCase();
  const groups = props.groups.filter((group) => !group.builtin);
  return query ? groups.filter((group) => group.name.toLocaleLowerCase().includes(query)) : groups;
});

/** 打开分组管理弹窗，并刷新最新分组列表。 */
function openManager(): void {
  managerOpen.value = true;
  void props.loadGroups();
}

/** 校验名称后发起创建。 */
async function submitCreate(): Promise<void> {
  const name = draftName.value.trim();
  if (!name) return void message.info("请输入分组名称");
  creating.value = true;
  try {
    await props.createGroup(name);
    draftName.value = "";
    message.success("已创建分组");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建分组失败");
  } finally {
    creating.value = false;
  }
}

/** 提交当前分组重命名。 */
async function submitRename(): Promise<void> {
  const name = renameName.value.trim();
  if (!renameId.value || !name) return void message.info("请输入分组名称");
  const groupId = renameId.value;
  busyGroupId.value = groupId;
  try {
    await props.renameGroup(groupId, name);
    renameId.value = null;
    renameName.value = "";
    message.success("已重命名");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "重命名分组失败");
  } finally {
    busyGroupId.value = null;
  }
}

/** 删除前明确提示资产会回到未分组。 */
function confirmDelete(group: OrchAssetGroup): void {
  Modal.confirm({
    title: "删除资产分组",
    content: `删除“${group.name}”后，组内资产会回到未分组。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      busyGroupId.value = group.id;
      try {
        await props.deleteGroup(group.id);
        message.success("已删除分组");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除分组失败");
        throw error;
      } finally {
        busyGroupId.value = null;
      }
    },
  });
}

/** 打开单个自定义资产的移动分组弹窗。 */
function openMoveGroup(asset: GroupableAsset): void {
  if (asset.kind === "builtin") return;
  moveTarget.value = asset;
  moveSearch.value = "";
  moveOpen.value = true;
  void props.loadGroups();
}

/** 将当前资产移动到指定分组。 */
async function assignMoveGroup(groupId: string | null): Promise<void> {
  if (!moveTarget.value) return;
  moving.value = true;
  try {
    await props.assignGroup(moveTarget.value.id, groupId);
    moveOpen.value = false;
    message.success(groupId ? "已移动分组" : "已移至未分组");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "移动资产分组失败");
  } finally {
    moving.value = false;
  }
}

defineExpose({ openMoveGroup });
</script>

<template>
  <div class="asset-group-bar">
    <a-select :value="modelValue" size="small" :options="options" :loading="loading" @change="emit('update:modelValue', $event)" />
    <a-tooltip v-if="canManage" title="新建分组"><a-button size="small" @click="openManager"><template #icon><PlusOutlined /></template></a-button></a-tooltip>
    <a-tooltip v-if="canManage" title="管理分组"><a-button size="small" @click="openManager"><template #icon><SettingOutlined /></template></a-button></a-tooltip>
  </div>
  <a-modal v-model:open="managerOpen" title="资产分组管理" :footer="null" width="520px">
    <div class="asset-group-manager__create"><a-input v-model:value="draftName" maxlength="60" allow-clear placeholder="新分组名称" @press-enter="submitCreate" /><a-button type="primary" :loading="creating" @click="submitCreate">创建</a-button></div>
    <div class="asset-group-manager__list">
      <div v-if="loading" class="asset-group-manager__hint">加载分组中...</div>
      <div v-for="group in groups.filter((item) => !item.builtin)" :key="group.id" class="asset-group-manager__row">
        <template v-if="renameId === group.id"><a-input v-model:value="renameName" maxlength="60" @press-enter="submitRename" /><a-button size="small" type="primary" :loading="busyGroupId === group.id" @click="submitRename">保存</a-button><a-button size="small" @click="renameId = null">取消</a-button></template>
        <template v-else><span>{{ group.name }}</span><a-button size="small" @click="renameId = group.id; renameName = group.name">重命名</a-button><a-button size="small" danger :loading="busyGroupId === group.id" @click="confirmDelete(group)">删除</a-button></template>
      </div>
      <div v-if="!loading && groups.filter((item) => !item.builtin).length === 0" class="asset-group-manager__hint">暂无分组</div>
    </div>
  </a-modal>
  <a-modal v-model:open="moveOpen" title="切换分组" :footer="null" width="420px">
    <div class="asset-group-move">
      <a-input v-model:value="moveSearch" placeholder="搜索分组..." allow-clear />
      <button type="button" class="asset-group-move__item" :disabled="moving" @click="assignMoveGroup(null)">未分组</button>
      <button v-for="group in filteredMoveGroups" :key="group.id" type="button" class="asset-group-move__item" :disabled="moving" @click="assignMoveGroup(group.id)">{{ group.name }}</button>
      <div v-if="filteredMoveGroups.length === 0" class="asset-group-manager__hint">没有匹配的分组</div>
      <a-button block size="small" @click="openManager"><template #icon><PlusOutlined /></template>新建分组</a-button>
    </div>
  </a-modal>
</template>

<style scoped>
/* 分组栏三个控件统一 30px（与侧栏顶部工具按钮一致）；左右与上方 tab 区共用容器缩进，不再自带内边距。 */
.asset-group-bar { display: grid; grid-template-columns: minmax(0, 1fr) 30px 30px; align-items: center; gap: 6px; padding: 3px 0; }
/* antd 的 `.ant-select-sm` 规则带更多类名，普通覆盖会被压回 24px，必须用 !important 才能与按钮等高。 */
.asset-group-bar :deep(.ant-select-selector) { height: 30px !important; align-items: center; }
.asset-group-bar :deep(.ant-select-selection-item),
.asset-group-bar :deep(.ant-select-selection-placeholder) { line-height: 28px !important; }
.asset-group-bar :deep(.ant-btn) { width: 30px; height: 30px; padding: 0; }
.asset-group-manager__create { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-bottom: 12px; }
.asset-group-manager__list { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
.asset-group-manager__row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--app-divider); }
.asset-group-manager__hint { padding: 14px 0; color: var(--app-muted); text-align: center; }
.asset-group-move { display: grid; gap: 8px; }
.asset-group-move__item { width: 100%; padding: 8px 10px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-surface); color: var(--app-text); text-align: left; cursor: pointer; }
.asset-group-move__item:hover { border-color: color-mix(in srgb, var(--app-primary) 42%, var(--app-border)); color: var(--app-primary); }
.asset-group-move__item:disabled { cursor: wait; opacity: 0.6; }
</style>
