<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { message } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../../../api/request";
import { useExplorerStore } from "../../../store/explorer";

defineOptions({ name: "GitCommitForm" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  ctx: ApiRequestContext;
  open: boolean;
  filePaths: string[];
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "committed"): void;
}>();

const explorer = useExplorerStore();
const subject = ref("");
const body = ref("");
const amend = ref(false);

const fileCount = computed(() => props.filePaths.length);

const canCommit = computed(() => {
  return subject.value.trim().length > 0 && (fileCount.value > 0 || amend.value);
});

/** 弹窗关闭时重置表单 */
watch(() => props.open, (val) => {
  if (!val) {
    subject.value = "";
    body.value = "";
    amend.value = false;
  }
});

async function doCommit() {
  if (!canCommit.value) return;

  // 先将未 staged 的选中文件执行 stage
  const stagedPaths = new Set(
    (explorer.gitStatus?.staged ?? []).map(f => f.path),
  );
  const needStage = props.filePaths.filter(p => !stagedPaths.has(p));
  if (needStage.length) {
    await explorer.gitStage(props.ctx, props.workspaceId, needStage);
  }

  const msg = body.value.trim()
    ? `${subject.value.trim()}\n\n${body.value.trim()}`
    : subject.value.trim();

  const result = await explorer.gitCommit(props.ctx, props.workspaceId, msg, amend.value);
  if (result.ok) {
    message.success(`提交成功：${result.hash.slice(0, 7)}`);
    emit("update:open", false);
    emit("committed");
  } else {
    message.error(`提交失败：${result.error}`);
  }
}

function onCancel() {
  emit("update:open", false);
}
</script>

<template>
  <a-modal
    :open="open"
    :title="`提交变更（${fileCount} 个文件）`"
    ok-text="提交"
    cancel-text="取消"
    :ok-button-props="{ disabled: !canCommit || explorer.operating }"
    :confirm-loading="explorer.operating"
    :mask-closable="false"
    @ok="doCommit"
    @cancel="onCancel"
  >
    <div class="git-commit-form">
      <a-input
        v-model:value="subject"
        name="codeflow-git-commit-subject"
        autocomplete="new-password"
        placeholder="提交信息 (subject)"
        :maxlength="100"
        @pressEnter="doCommit"
      />
      <a-textarea
        v-model:value="body"
        placeholder="详细描述 (可选)"
        :auto-size="{ minRows: 4, maxRows: 8 }"
      />
      <a-tooltip title="不产生新提交，而是把当前改动补充到上一次提交里">
        <a-checkbox v-model:checked="amend">修订上次提交</a-checkbox>
      </a-tooltip>
    </div>
  </a-modal>
</template>

<style scoped>
.git-commit-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>

