<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined } from "@ant-design/icons-vue";
import type { ConversationApprovalRequest, WorkspaceId } from "@codeflowai/shared";

import MarkdownPreview from "../../../explorer/components/markdown-preview.vue";
import { createApiResultError } from "../../../../api/request";
import { useApiContext } from "../../../../composables/useApiContext";
import { respondApproval } from "../../../../api/interactions";
import { isDesktopWorkspace } from "../../../../services/desktop";
import { useConfigStore } from "../../../../store/config";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "ApprovalRequestItem" });

const submittingRequestIds = reactive(new Set<string>());

type Props = {
  item: ConversationApprovalRequest;
  compact?: boolean;
  workspaceId?: WorkspaceId;
};

const props = defineProps<Props>();

const config = useConfigStore();
const ui = useUiStore();
const { ctx } = useApiContext();
// 共享线程的 item 可能保留 Host workspaceId；写操作必须优先使用当前聊天上下文。
const operationWorkspaceId = computed(() => props.workspaceId ?? config.workspaceId ?? props.item.workspaceId);
const localReady = computed(() => isDesktopWorkspace(config, operationWorkspaceId.value));

const submitting = ref(false);
const requestKey = computed(() => String(props.item.requestId ?? ""));
const sharedSubmitting = computed(() => submittingRequestIds.has(requestKey.value));
const busy = computed(() => submitting.value || sharedSubmitting.value);
const disabled = computed(() => !(config.connected || localReady.value) || props.item.state !== "pending" || busy.value);

const stateLabel = computed(() => {
  if (props.item.state === "accepted") return "已同意";
  if (props.item.state === "declined") return "已拒绝";
  if (props.item.state === "expired") return "已失效";
  return "待处理";
});

const stateColor = computed(() => {
  if (props.item.state === "accepted") return "green";
  if (props.item.state === "declined") return "red";
  if (props.item.state === "expired") return "default";
  return "blue";
});

const hasOptions = computed(() => Array.isArray(props.item.options) && props.item.options.length > 0);
const selectedChoice = ref("");
const note = ref("");

watch(
  () => props.item.options,
  (options) => {
    const first = Array.isArray(options) && options.length > 0 ? options[0]!.value : "";
    if (!selectedChoice.value || !options?.some((opt) => opt.value === selectedChoice.value)) {
      selectedChoice.value = first;
    }
  },
  { immediate: true },
);

watch(
  () => props.item.requestId,
  () => {
    note.value = "";
  },
  { immediate: true },
);

const selectedOption = computed(() => props.item.options?.find((opt) => opt.value === selectedChoice.value) ?? null);
const resolvedOption = computed(() => props.item.options?.find((opt) => opt.value === props.item.resolvedChoice) ?? null);

// 从 toolName 提取可读标签，如 "item/commandExecution/requestApproval" → "命令执行"
const toolTypeLabel = computed(() => {
  const parts = String(props.item.toolName ?? "").split("/");
  const raw = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : (parts[0] ?? "");
  const labelMap: Record<string, string> = {
    commandExecution: "命令执行",
    command_execution: "命令执行",
    fileWrite: "文件写入",
    file_write: "文件写入",
    fileRead: "文件读取",
    file_read: "文件读取",
    network: "网络请求",
    bash: "Shell 命令",
  };
  return labelMap[raw] ?? (raw || "工具调用");
});

const exitPlanInfo = computed(() => {
  if (props.item.approvalKind !== "exitPlanMode") return null;
  const input = props.item.input as any;
  return {
    plan: typeof input?.plan === "string" ? input.plan : "",
    allowedPrompts: Array.isArray(input?.allowedPrompts) ? input.allowedPrompts.filter((x: any) => typeof x?.tool === "string" && typeof x?.prompt === "string") : [],
  };
});
const planPreview = computed(() => {
  const text = exitPlanInfo.value?.plan?.trim() ?? "";
  if (!text) return "";
  const first = text.split(/\r?\n/g).find((line: string) => line.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
});
const planModalOpen = ref(false);

// 从 input 提取命令和工作目录
const commandInfo = computed(() => {
  const inp = props.item.input as any;
  if (!inp) return null;
  const cmd = String(inp.command ?? "").trim();
  const cwd = String(inp.cwd ?? "").trim();
  return cmd ? { command: cmd, cwd } : null;
});

/** 提交审批选择；权威锁冲突时冻结旧快照并重新补水。 */
const submitDecision = async (decision: "accept" | "decline", choice?: string | null) => {
  if (disabled.value || busy.value) return;
  if (hasOptions.value) {
    const current = selectedOption.value;
    if (!current) return;
    if (current.requiresNote && !note.value.trim()) {
      message.warning("请先填写补充说明");
      return;
    }
    decision = current.intent;
    choice = current.value;
  }

  submitting.value = true;
  submittingRequestIds.add(requestKey.value);
  try {
    const requestWorkspaceId = operationWorkspaceId.value;
    const res = await respondApproval(ctx.value, {
      workspaceId: requestWorkspaceId,
      threadId: props.item.threadId,
      requestId: props.item.requestId,
      decision,
      choice: choice ?? null,
      note: note.value.trim() || null,
    });
    if (!res.ok) throw createApiResultError(res);
    message.success(decision === "accept" ? "已提交选择" : "已拒绝");
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "操作失败";
    message.error(errMsg);
  } finally {
    submitting.value = false;
    submittingRequestIds.delete(requestKey.value);
  }
};

const detailsOpen = ref(false);

const accept = async () => {
  await submitDecision("accept");
};

const decline = async () => {
  await submitDecision("decline");
};
</script>

<template>
  <div class="msg msg--tool msg--approval" :class="{ 'msg--approval-compact': compact }">
    <div class="msg__approval-header">
      <div class="msg__approval-left">
        <span class="msg__role">审批请求</span>
        <span class="msg__hint-inline">{{ toolTypeLabel }}</span>
      </div>
      <a-tag :color="stateColor" style="margin: 0; flex-shrink: 0">{{ stateLabel }}</a-tag>
    </div>

    <div v-if="item.message" class="msg__approval-message">{{ item.message }}</div>

    <div v-if="resolvedOption" class="msg__approval-cwd">已选：{{ resolvedOption.label }}</div>
    <div v-if="item.resolvedNote" class="msg__approval-note">{{ item.resolvedNote }}</div>

    <template v-if="exitPlanInfo?.allowedPrompts?.length">
      <div class="msg__approval-prompts-title">建议授权</div>
      <div class="msg__approval-prompts">
        <div v-for="(entry, idx) in exitPlanInfo.allowedPrompts" :key="`${entry.tool}-${idx}`" class="msg__approval-prompt">
          <span class="msg__approval-prompt-tool">{{ entry.tool }}</span>
          <span class="msg__approval-prompt-text">
            <span>{{ entry.prompt }}</span>
          </span>
        </div>
      </div>
    </template>

    <template v-if="exitPlanInfo?.plan">
      <div class="msg__approval-prompts-title">计划内容</div>
      <div class="msg__approval-plan-bar">
        <span v-if="planPreview" class="msg__approval-plan-preview">{{ planPreview }}</span>
        <a-button size="small" type="link" @click="planModalOpen = true">查看计划内容</a-button>
      </div>
    </template>

    <!-- 命令展示 -->
    <template v-if="!compact && commandInfo">
      <pre class="msg__approval-cmd">{{ commandInfo.command }}</pre>
      <div v-if="commandInfo.cwd" class="msg__approval-cwd">工作目录：{{ commandInfo.cwd }}</div>
    </template>

    <!-- 完整入参（折叠，仅在调试侧栏开启时显示） -->
    <div v-if="!compact && (item.input || exitPlanInfo?.plan) && ui.inspectorVisible" class="msg__approval-details">
      <button type="button" class="msg__approval-details-toggle" @click="detailsOpen = !detailsOpen">
        <RightOutlined v-if="!detailsOpen" style="font-size: 10px" />
        <DownOutlined v-else style="font-size: 10px" />
        完整参数
      </button>
      <pre v-if="exitPlanInfo?.plan && detailsOpen" class="msg__approval-details-body">{{ exitPlanInfo.plan }}</pre>
      <pre v-show="detailsOpen" class="msg__approval-details-body">{{ JSON.stringify(item.input, null, 2) }}</pre>
    </div>

    <!-- 操作按钮（仅待处理时显示） -->
    <template v-if="item.state === 'pending'">
      <div v-if="hasOptions" class="msg__approval-options">
        <a-radio-group v-model:value="selectedChoice" :disabled="disabled">
          <a-space direction="vertical">
            <a-radio v-for="opt in item.options" :key="opt.value" :value="opt.value">
              <span>{{ opt.label }}</span>
              <span v-if="opt.description" class="msg__approval-option-desc">{{ opt.description }}</span>
            </a-radio>
          </a-space>
        </a-radio-group>
        <a-textarea
          v-if="selectedOption?.requiresNote"
          v-model:value="note"
          :disabled="disabled"
          :auto-size="{ minRows: 2, maxRows: 4 }"
          :placeholder="selectedOption.notePlaceholder || '请输入补充说明'"
          style="margin-top: 8px"
        />
        <div class="msg__approval-actions">
          <a-button type="primary" size="small" :loading="busy" :disabled="disabled" @click="submitDecision('accept', selectedChoice)">提交选择</a-button>
        </div>
      </div>
      <div v-else class="msg__approval-actions">
        <a-button type="primary" size="small" :loading="busy" :disabled="disabled" @click="accept">同意</a-button>
        <a-button danger size="small" :loading="busy" :disabled="disabled" @click="decline">拒绝</a-button>
      </div>
    </template>
  </div>

  <a-modal
    :open="planModalOpen"
    title="计划内容"
    :footer="null"
    width="80%"
    :body-style="{ maxHeight: '70vh', overflow: 'auto' }"
    @cancel="planModalOpen = false"
  >
    <MarkdownPreview :content="exitPlanInfo?.plan ?? ''" file-path="plan.md" />
  </a-modal>
</template>

<style scoped>
.msg--approval-compact {
  padding: 8px 12px;
}

.msg__approval-message {
  color: var(--app-text);
  margin-bottom: 8px;
}

.msg__approval-note {
  margin-top: 6px;
  color: var(--app-text);
  white-space: pre-wrap;
}

.msg__approval-prompts-title {
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-muted);
}

.msg__approval-prompts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.msg__approval-prompt {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
}

.msg__approval-prompt-tool {
  color: var(--app-primary);
  font-weight: 600;
  flex-shrink: 0;
}

.msg__approval-prompt-text {
  color: var(--app-text);
}

.msg__approval-plan-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.msg__approval-plan-preview {
  color: var(--app-text);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg__approval-options {
  margin-top: 10px;
}

.msg__approval-option-desc {
  margin-left: 6px;
  color: var(--app-muted);
}
</style>
