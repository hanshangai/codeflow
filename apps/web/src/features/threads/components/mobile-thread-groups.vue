<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CheckOutlined, DeleteOutlined, EditOutlined, FolderOutlined } from "@ant-design/icons-vue";
import type { ThreadGroupId, WorkspaceId } from "@codeflowai/shared";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useApiContext } from "../../../composables/useApiContext";
import { isCancelledRequestError } from "../../../api/request";
import { isDesktopWorkspace } from "../../../services/desktop";

const props = defineProps<{ open: boolean; loadError?: string }>();
const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
  (event: "select", id: ThreadGroupId | "ungrouped" | null): void;
  (event: "retry"): void;
  (event: "changed"): void;
}>();
const chat = useChatStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const name = ref("");
const editingId = ref<ThreadGroupId | null>(null);
const deletingId = ref<ThreadGroupId | null>(null);
const busy = ref(false);
const errorMessage = ref("");
/** 分组读写走本地桥，桌面本机工作区未登录也可用。 */
const unavailable = computed(() => busy.value
  || !config.workspaceId
  || !(config.connected || isDesktopWorkspace(config, config.workspaceId)));

watch(() => [props.open, config.workspaceId], () => {
  name.value = "";
  editingId.value = null;
  deletingId.value = null;
  errorMessage.value = "";
});

function select(id: ThreadGroupId | "ungrouped" | null): void {
  if (unavailable.value) return;
  emit("select", id);
  emit("update:open", false);
}

async function save(removeId?: ThreadGroupId): Promise<void> {
  if (unavailable.value) return;
  if (!removeId && !name.value.trim()) { errorMessage.value = "请输入分组名称"; return; }
  const workspaceId = config.workspaceId as WorkspaceId;
  const groupId = removeId ?? editingId.value;
  const action = removeId ? "delete" : groupId ? "rename" : "create";
  busy.value = true;
  errorMessage.value = "";
  try {
    if (removeId) await chat.deleteThreadGroup(ctx.value, { workspaceId, groupId: removeId });
    else if (groupId) await chat.renameThreadGroup(ctx.value, { workspaceId, groupId, name: name.value.trim() });
    else await chat.createThreadGroup(ctx.value, { workspaceId, name: name.value.trim() });
    if (config.workspaceId !== workspaceId) return;
    name.value = "";
    editingId.value = null;
    deletingId.value = null;
    emit("changed");
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    errorMessage.value = error instanceof Error ? error.message : "分组操作失败，请重试";
    console.error({ code: "MOBILE_THREAD_GROUP_MUTATION_FAILED", requestId: null, workspaceId, groupId,
      userId: config.userSummary?.userId, action, cause: errorMessage.value });
  } finally { busy.value = false; }
}
</script>

<template>
  <a-drawer :open="open" placement="bottom" height="min(78dvh, 680px)" :closable="false" :mask-closable="!busy" :keyboard="!busy" root-class-name="mobile-groups-drawer" @close="emit('update:open', false)">
    <section class="mobile-groups" aria-label="会话分组">
      <header><div><h2>会话分组</h2><p>管理自建会话，不影响流程与待办</p></div><button :disabled="busy" @click="emit('update:open', false)">完成</button></header>
      <form class="mobile-groups__form" @submit.prevent="save()">
        <a-input v-model:value="name" :maxlength="60" :disabled="unavailable" :placeholder="editingId ? '新的分组名称' : '输入新分组名称'" aria-label="分组名称" />
        <a-button type="primary" html-type="submit" :loading="busy" :disabled="unavailable">{{ editingId ? '保存' : '新建' }}</a-button>
        <a-button v-if="editingId" :disabled="busy" @click="editingId = null; name = ''">取消</a-button>
      </form>
      <p v-if="errorMessage" role="alert" class="mobile-groups__error">{{ errorMessage }}</p>
      <a-alert v-if="loadError" type="error" :message="loadError" show-icon>
        <template #action><a-button :disabled="unavailable" @click="emit('retry')">重试</a-button></template>
      </a-alert>
      <div class="mobile-groups__list" :aria-busy="chat.threadGroupsLoading">
        <button class="mobile-groups__choice" :disabled="unavailable" :aria-pressed="!chat.activeThreadGroupId" @click="select(null)"><FolderOutlined /><span>全部分组</span><CheckOutlined v-if="!chat.activeThreadGroupId" /></button>
        <button class="mobile-groups__choice" :disabled="unavailable" :aria-pressed="chat.activeThreadGroupId === 'ungrouped'" @click="select('ungrouped')"><FolderOutlined /><span>未分组</span><CheckOutlined v-if="chat.activeThreadGroupId === 'ungrouped'" /></button>
        <div v-for="group in chat.threadGroups" :key="group.id" class="mobile-groups__row">
          <button class="mobile-groups__choice" :disabled="unavailable" :aria-pressed="chat.activeThreadGroupId === group.id" @click="select(group.id)"><FolderOutlined /><span>{{ group.name }}</span><CheckOutlined v-if="chat.activeThreadGroupId === group.id" /></button>
          <button :disabled="unavailable" :aria-label="`重命名 ${group.name}`" @click="editingId = group.id; name = group.name; deletingId = null"><EditOutlined /></button>
          <button :disabled="unavailable" :aria-label="`删除 ${group.name}`" @click="deletingId = group.id"><DeleteOutlined /></button>
          <div v-if="deletingId === group.id" class="mobile-groups__confirm">
            <p>删除后，组内会话移至未分组，不会删除会话。</p>
            <a-button danger :loading="busy" :disabled="unavailable" @click="save(group.id)">确认删除</a-button>
            <a-button :disabled="busy" @click="deletingId = null">取消</a-button>
          </div>
        </div>
        <p v-if="chat.threadGroupsLoading" class="mobile-groups__hint">正在加载分组…</p>
        <p v-else-if="!loadError && !chat.threadGroups.length" class="mobile-groups__hint">还没有自定义分组，在上方新建一个。</p>
      </div>
    </section>
  </a-drawer>
</template>

<style scoped>
.mobile-groups { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 14px; color: var(--app-text); }
.mobile-groups header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mobile-groups h2 { margin: 0; font-size: 19px; }
.mobile-groups p { margin: 5px 0; font-size: 12px; color: var(--app-muted); }
.mobile-groups button { min-height: 44px; border: 0; background: transparent; color: inherit; border-radius: 10px; }
.mobile-groups button:disabled { opacity: .45; }
.mobile-groups header button { padding: 0 12px; color: var(--app-accent); }
.mobile-groups__form { display: flex; gap: 8px; }
.mobile-groups__form :deep(input) { min-width: 0; height: 44px; border-radius: 12px; font-size: 16px; }
.mobile-groups__form :deep(.ant-btn-primary) { background: var(--app-accent); color: #fff; }
.mobile-groups__list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: var(--safe-bottom); }
.mobile-groups__choice { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px; text-align: left; }
.mobile-groups__choice span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mobile-groups__choice[aria-pressed="true"] { background: color-mix(in srgb, var(--app-accent) 8%, var(--app-surface)); color: var(--app-accent); }
.mobile-groups__row { display: grid; grid-template-columns: minmax(0, 1fr) 44px 44px; border-bottom: 1px solid var(--app-divider); }
.mobile-groups__confirm { grid-column: 1 / -1; padding: 8px 12px 12px; background: var(--app-bg-secondary); border-radius: 12px; }
.mobile-groups__confirm .ant-btn { margin-right: 8px; }
.mobile-groups .mobile-groups__error { color: var(--app-danger); }
.mobile-groups__hint { padding: 20px 12px; }
:global(.mobile-groups-drawer .ant-drawer-content) { border-radius: 24px 24px 0 0; background: var(--app-panel-bg); }
:global(.mobile-groups-drawer .ant-drawer-body) { padding: 18px 14px; overflow: hidden; }
</style>
