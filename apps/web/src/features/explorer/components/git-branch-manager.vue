<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { BranchesOutlined, PlusOutlined, DeleteOutlined, SwapOutlined, CheckOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../../api/request";
import { useExplorerStore } from "../../../store/explorer";

defineOptions({ name: "GitBranchManager" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
}>();

const explorer = useExplorerStore();
const newBranchName = ref("");
const showCreateForm = ref(false);

const localBranches = computed(() => explorer.gitBranches.filter(b => !b.isRemote));
const remoteBranches = computed(() => explorer.gitBranches.filter(b => b.isRemote));

watch(
  () => [props.workspaceId, explorer.selectedGitRepositoryPath, explorer.gitStatus?.isRepo] as const,
  ([wid, , isRepo]) => {
    if (wid && isRepo) explorer.loadGitBranches(props.ctx, wid);
  },
  { immediate: true },
);

async function createBranch() {
  const name = newBranchName.value.trim();
  if (!name) return;
  await explorer.gitBranchCreate(props.ctx, props.workspaceId, name);
  newBranchName.value = "";
  showCreateForm.value = false;
  message.success(`分支 ${name} 已创建`);
}

async function switchBranch(name: string) {
  await explorer.gitBranchSwitch(props.ctx, props.workspaceId, name);
  message.success(`已切换到 ${name}`);
}

function deleteBranch(name: string) {
  Modal.confirm({
    title: "删除分支",
    content: `确定删除分支 ${name}？`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      await explorer.gitBranchDelete(props.ctx, props.workspaceId, name);
      message.success(`分支 ${name} 已删除`);
    },
  });
}
</script>

<template>
  <div class="git-branch-mgr">
    <a-spin :spinning="explorer.gitBranchLoading">
      <!-- 创建分支 -->
      <div class="git-branch-mgr__create">
        <a-button v-if="!showCreateForm" size="small" type="dashed" block @click="showCreateForm = true">
          <PlusOutlined /> 新建分支
        </a-button>
        <div v-else class="git-branch-mgr__create-form">
          <a-input
            v-model:value="newBranchName"
            name="codeflow-git-branch-name"
            autocomplete="new-password"
            placeholder="分支名称"
            @pressEnter="createBranch"
          />
          <a-button size="small" type="primary" :disabled="!newBranchName.trim() || explorer.operating" @click="createBranch">创建</a-button>
          <a-button size="small" @click="showCreateForm = false">取消</a-button>
        </div>
      </div>

      <!-- 本地分支 -->
      <div class="git-branch-mgr__section">
        <div class="git-branch-mgr__section-title">本地分支</div>
        <div v-for="b in localBranches" :key="b.name" class="git-branch-mgr__item">
          <CheckOutlined v-if="b.current" class="git-branch-mgr__current" />
          <BranchesOutlined v-else class="git-branch-mgr__icon" />
          <span class="git-branch-mgr__name" :class="{ 'git-branch-mgr__name--current': b.current }">{{ b.name }}</span>
          <span v-if="b.tracking" class="git-branch-mgr__tracking">{{ b.tracking }}</span>
          <span class="git-branch-mgr__actions">
            <a-button
              v-if="!b.current"
              size="small" type="text" title="切换"
              :disabled="explorer.operating"
              @click="switchBranch(b.name)"
            ><SwapOutlined /></a-button>
            <a-button
              v-if="!b.current"
              size="small" type="text" title="删除" danger
              :disabled="explorer.operating"
              @click="deleteBranch(b.name)"
            ><DeleteOutlined /></a-button>
          </span>
        </div>
      </div>

      <!-- 远程分支 -->
      <div v-if="remoteBranches.length" class="git-branch-mgr__section">
        <div class="git-branch-mgr__section-title">远程分支</div>
        <div v-for="b in remoteBranches" :key="b.name" class="git-branch-mgr__item">
          <BranchesOutlined class="git-branch-mgr__icon" />
          <span class="git-branch-mgr__name">{{ b.name }}</span>
        </div>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.git-branch-mgr {
  height: 100%;
  overflow: auto;
  padding: 12px;
}

.git-branch-mgr__create {
  margin-bottom: 16px;
}

.git-branch-mgr__create-form {
  display: flex;
  gap: 6px;
  align-items: center;
}

.git-branch-mgr__section {
  margin-bottom: 16px;
}

.git-branch-mgr__section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
}

.git-branch-mgr__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 13px;
  transition: background 0.1s;
}

.git-branch-mgr__item:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}

.git-branch-mgr__current {
  color: var(--app-success, #52c41a);
  font-size: 12px;
}

.git-branch-mgr__icon {
  color: var(--app-muted);
  font-size: 12px;
}

.git-branch-mgr__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branch-mgr__name--current {
  font-weight: 600;
}

.git-branch-mgr__tracking {
  font-size: 11px;
  color: var(--app-muted);
}

.git-branch-mgr__actions {
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.git-branch-mgr__item:hover .git-branch-mgr__actions {
  opacity: 1;
}
</style>

