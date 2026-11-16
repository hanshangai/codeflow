<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import type {
  AssigneeTemplate,
  AssigneeTemplateStatus,
  SharedWorkspaceMemberItem,
  WorkflowDefinition,
  WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useSharedWorkspacesStore } from "../../../store/sharedWorkspaces";

defineOptions({ name: "WorkflowAssigneeTemplateManager" });

const props = defineProps<{
  open: boolean;
  workspaceId: WorkspaceId;
  workflow: WorkflowDefinition | null;
  sharedWorkspaceId: string | null;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const orch = useOrchestrationStore();
const config = useConfigStore();
const sharedWorkspaces = useSharedWorkspacesStore();
const { ctx } = useApiContext();

const selectedTemplateId = ref("");
const templateNameDraft = ref("");
const templateStatusDraft = ref<AssigneeTemplateStatus>("published");
const nodeAssigneeDrafts = ref<Record<string, string[]>>({});
const savingTemplate = ref(false);
const deletingTemplate = ref(false);

const statusOptions: Array<{ value: AssigneeTemplateStatus; label: string; hint: string }> = [
  { value: "published", label: "已发布", hint: "需求选择协作运行时可直接选择" },
  { value: "draft", label: "草稿", hint: "可保存未补齐的预案，启动前不能选择" },
  { value: "archived", label: "已归档", hint: "保留历史，不出现在启动候选里" },
];

const roleRows = computed(() =>
  (props.workflow?.nodes ?? [])
    .filter((node) => node.type === "role")
    .map((node) => ({
      nodeId: String(node.id),
      label: node.label || node.id,
      roleName: node.roleId ? orch.roles.find((role) => role.id === node.roleId)?.name ?? "" : "",
    })),
);
const assigneeTemplates = computed(() => {
  const workflowId = String(props.workflow?.id ?? "");
  if (!workflowId) return [] as AssigneeTemplate[];
  return orch.assigneeTemplates
    .filter((template) => String(template.workflowId) === workflowId)
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
});
const selectedTemplate = computed(() =>
  assigneeTemplates.value.find((template) => template.id === selectedTemplateId.value) ?? null,
);
const activeSharedMembers = computed<SharedWorkspaceMemberItem[]>(() => {
  const id = props.sharedWorkspaceId;
  if (!id) return [];
  return (sharedWorkspaces.membersByWorkspaceId[id] ?? []).filter((member) => member.status === "active");
});
const activeSharedMemberOptions = computed(() =>
  activeSharedMembers.value
    .map((member) => ({
      userId: String(member.userId ?? "").trim(),
      label: formatSharedMemberLabel(member),
    }))
    .filter((item) => item.userId),
);
const assignedNodeCount = computed(() =>
  roleRows.value.filter((row) => (nodeAssigneeDrafts.value[row.nodeId]?.length ?? 0) > 0).length,
);
const saveDisabledBase = computed(() => savingTemplate.value || !props.workflow || roleRows.value.length === 0);
const publishBlockedReason = computed(() => {
  if (templateStatusDraft.value !== "published") return null;
  if (activeSharedMemberOptions.value.length === 0) return "共享成员列表为空或尚未加载，不能发布处理人模板。";
  if (roleRows.value.length === 0) return "当前流程模板没有角色节点，不能发布处理人模板。";
  if (assignedNodeCount.value !== roleRows.value.length) return "发布前必须为每个角色节点选择处理人。";
  return null;
});

watch(() => props.open, (open) => {
  if (!open) return;
  void loadTemplateManager().catch((error) => {
    message.error(error instanceof Error ? error.message : "加载处理人模板失败");
  });
});

watch(() => props.workflow?.id, () => {
  if (!props.open) return;
  void loadTemplateManager().catch((error) => {
    message.error(error instanceof Error ? error.message : "加载处理人模板失败");
  });
});

/** 关闭模板维护弹窗，不修改当前流程定义。 */
function closeManager(): void {
  emit("update:open", false);
}

/** 展示共享成员处理人候选，优先使用姓名，缺省显示邮箱或用户 ID。 */
function formatSharedMemberLabel(member: SharedWorkspaceMemberItem): string {
  return member.displayName || member.email || member.userId;
}

/** 加载共享成员与当前流程模板，保证候选和模板列表都是最新事实。 */
async function loadTemplateManager(): Promise<void> {
  if (!props.workflow || !props.sharedWorkspaceId) {
    resetDraft();
    return;
  }
  if (!sharedWorkspaces.membersByWorkspaceId[props.sharedWorkspaceId]?.length) {
    const result = await sharedWorkspaces.loadMembers(props.sharedWorkspaceId);
    if (!result.ok) throw new Error(result.message || "加载共享成员失败");
  }
  await orch.refreshAssigneeTemplates(ctx.value, props.workspaceId, props.workflow.id);
  const preferred = selectedTemplate.value
    ?? assigneeTemplates.value.find((template) => template.status === "published")
    ?? assigneeTemplates.value.find((template) => template.status === "draft")
    ?? assigneeTemplates.value[0]
    ?? null;
  if (preferred) {
    applyAssigneeTemplate(preferred);
    return;
  }
  resetDraft();
}

/** 重置为空模板草稿；若当前用户是有效成员，则默认填入自己以降低配置成本。 */
function resetDraft(): void {
  selectedTemplateId.value = "";
  templateNameDraft.value = "";
  templateStatusDraft.value = "published";
  syncAssigneeDrafts(true);
}

/** 根据当前共享成员清理草稿，避免保存已失效成员。 */
function syncAssigneeDrafts(fillDefault: boolean): void {
  const activeUserIds = new Set(activeSharedMemberOptions.value.map((member) => member.userId));
  const currentUserId = String(config.userSummary?.userId ?? "").trim();
  const defaultAssignee = currentUserId && activeUserIds.has(currentUserId) ? [currentUserId] : [];
  const next: Record<string, string[]> = {};
  for (const row of roleRows.value) {
    const existing = nodeAssigneeDrafts.value[row.nodeId] ?? (fillDefault ? defaultAssignee : []);
    const sanitized = existing.filter((userId) => activeUserIds.has(userId));
    next[row.nodeId] = sanitized.length > 0 ? sanitized : (fillDefault ? [...defaultAssignee] : []);
  }
  nodeAssigneeDrafts.value = next;
}

/** 把已保存模板复制为当前编辑草稿；失效成员会被过滤并要求重新补齐。 */
function applyAssigneeTemplate(template: AssigneeTemplate): void {
  selectedTemplateId.value = template.id;
  templateNameDraft.value = template.name;
  templateStatusDraft.value = template.status;
  const activeUserIds = new Set(activeSharedMemberOptions.value.map((member) => member.userId));
  const next: Record<string, string[]> = {};
  for (const row of roleRows.value) {
    next[row.nodeId] = (template.nodeAssigneeUserIdsByNodeId[row.nodeId] ?? [])
      .map((userId) => String(userId ?? "").trim())
      .filter((userId) => userId && activeUserIds.has(userId));
  }
  nodeAssigneeDrafts.value = next;
}

/** 处理模板下拉切换，空选项代表创建一套新模板。 */
function onTemplateChanged(): void {
  const template = selectedTemplate.value;
  if (template) {
    applyAssigneeTemplate(template);
    return;
  }
  resetDraft();
}

/** 收集当前节点处理人草稿，供模板保存接口使用。 */
function collectNodeAssigneeDrafts(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of roleRows.value) {
    const userIds = Array.from(new Set((nodeAssigneeDrafts.value[row.nodeId] ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)));
    if (userIds.length > 0) out[row.nodeId] = userIds;
  }
  return out;
}

/** 读取节点处理人草稿，保证多选框始终绑定数组值。 */
function getNodeAssigneeDraft(nodeId: string): string[] {
  return nodeAssigneeDrafts.value[nodeId] ?? [];
}

/** 同步节点处理人多选框变更，避免 v-model 绑定未初始化的对象索引。 */
function setNodeAssigneeDraft(nodeId: string, event: Event): void {
  nodeAssigneeDrafts.value = {
    ...nodeAssigneeDrafts.value,
    [nodeId]: readSelectedOptionValues(event),
  };
}

/** 从原生 multiple select 事件中提取已选成员 ID。 */
function readSelectedOptionValues(event: Event): string[] {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return [];
  return Array.from(target.selectedOptions)
    .map((option) => String(option.value ?? "").trim())
    .filter(Boolean);
}

/** 保存当前草稿；更新当前模板或另存为新模板由调用方决定。 */
async function saveAssigneeTemplate(createNew: boolean): Promise<void> {
  if (!props.workflow) {
    message.error("请先选择一个流程模板");
    return;
  }
  if (roleRows.value.length === 0) {
    message.error("当前流程模板没有角色节点，不能保存处理人模板");
    return;
  }
  const name = templateNameDraft.value.trim();
  if (!name) {
    message.error("请先填写处理人模板名称");
    return;
  }
  if (publishBlockedReason.value) {
    message.error(publishBlockedReason.value);
    return;
  }
  savingTemplate.value = true;
  try {
    const saved = await orch.saveAssigneeTemplate(ctx.value, props.workspaceId, {
      id: createNew ? null : selectedTemplateId.value || null,
      workspaceId: props.workspaceId,
      workflowId: props.workflow.id,
      name,
      status: templateStatusDraft.value,
      nodeAssigneeUserIdsByNodeId: collectNodeAssigneeDrafts(),
    });
    applyAssigneeTemplate(saved);
    message.success(createNew ? "处理人模板已创建" : "处理人模板已更新");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存处理人模板失败");
  } finally {
    savingTemplate.value = false;
  }
}

/** 删除当前模板，避免废弃预案继续占用维护视图。 */
function confirmDeleteTemplate(): void {
  const templateId = selectedTemplateId.value;
  if (!templateId) return;
  Modal.confirm({
    title: "删除处理人模板",
    content: "删除后不会影响已经启动的流程实例，确定继续吗？",
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      deletingTemplate.value = true;
      try {
        await orch.removeAssigneeTemplate(ctx.value, props.workspaceId, templateId);
        message.success("处理人模板已删除");
        const next = assigneeTemplates.value[0] ?? null;
        if (next) applyAssigneeTemplate(next);
        else resetDraft();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除处理人模板失败");
        throw error;
      } finally {
        deletingTemplate.value = false;
      }
    },
  });
}

/** 显示模板状态中文标签。 */
function statusLabel(status: AssigneeTemplateStatus): string {
  return statusOptions.find((item) => item.value === status)?.label ?? status;
}
</script>

<template>
  <a-modal
    :open="open"
    :width="900"
    :body-style="{ padding: '16px 18px', maxHeight: 'calc(100vh - 170px)', overflowY: 'auto' }"
    destroy-on-close
    @cancel="closeManager"
  >
    <template #title>
      <div class="assignee-template__title">
        <span>处理人模板</span>
        <small>{{ workflow?.name || "未选择流程" }}</small>
      </div>
    </template>
    <template #footer>
      <div class="assignee-template__footer">
        <button class="assignee-template__ghost" type="button" @click="closeManager">关闭</button>
        <button
          class="assignee-template__danger"
          type="button"
          :disabled="deletingTemplate || !selectedTemplateId"
          @click="confirmDeleteTemplate"
        >
          删除模板
        </button>
        <button
          class="assignee-template__ghost"
          type="button"
          :disabled="saveDisabledBase || !selectedTemplateId"
          @click="saveAssigneeTemplate(false)"
        >
          更新当前模板
        </button>
        <button class="assignee-template__primary" type="button" :disabled="saveDisabledBase" @click="saveAssigneeTemplate(true)">
          保存为新模板
        </button>
      </div>
    </template>

    <div class="assignee-template">
      <div class="assignee-template__note">
        这里维护流程模板的多套处理人预案，不写入流程节点定义；需求选择协作运行时可选模板并做本次覆盖，启动后冻结到执行实例。
      </div>

      <div v-if="!workflow" class="assignee-template__empty">请先选择一个流程模板。</div>
      <div v-else-if="roleRows.length === 0" class="assignee-template__empty">
        当前流程模板没有角色节点。请先保存包含角色节点的流程模板，再维护处理人模板。
      </div>

      <template v-else>
        <div class="assignee-template__bar">
          <label class="assignee-template__field assignee-template__field--wide">
            <span>已有模板</span>
            <select v-model="selectedTemplateId" :disabled="orch.assigneeTemplatesLoading" @change="onTemplateChanged">
              <option value="">新建模板</option>
              <option v-for="template in assigneeTemplates" :key="template.id" :value="template.id">
                {{ template.name }} · v{{ template.version }} · {{ statusLabel(template.status) }}
              </option>
            </select>
          </label>
          <label class="assignee-template__field">
            <span>模板名称</span>
            <input v-model="templateNameDraft" placeholder="例如：默认协作模板" />
          </label>
          <label class="assignee-template__field">
            <span>状态</span>
            <select v-model="templateStatusDraft">
              <option v-for="option in statusOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="assignee-template__status-hint">
          {{ statusOptions.find((item) => item.value === templateStatusDraft)?.hint }}
        </div>
        <div v-if="publishBlockedReason" class="assignee-template__warning">{{ publishBlockedReason }}</div>

        <div class="assignee-template__rows">
          <div v-for="row in roleRows" :key="row.nodeId" class="assignee-template__row">
            <div class="assignee-template__copy">
              <strong>{{ row.label }}</strong>
              <small>{{ row.roleName || "未绑定角色名称" }}</small>
            </div>
            <select
              :value="getNodeAssigneeDraft(row.nodeId)"
              multiple
              :disabled="activeSharedMemberOptions.length === 0"
              @change="setNodeAssigneeDraft(row.nodeId, $event)"
            >
              <option v-for="member in activeSharedMemberOptions" :key="member.userId" :value="member.userId">
                {{ member.label }}
              </option>
            </select>
          </div>
        </div>

        <div v-if="activeSharedMemberOptions.length === 0" class="assignee-template__empty assignee-template__empty--warning">
          共享成员列表为空或尚未加载，暂不能保存发布模板。
        </div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.assignee-template,
.assignee-template__rows {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.assignee-template__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.assignee-template__title small,
.assignee-template__copy small,
.assignee-template__status-hint {
  color: var(--app-muted, #6b7280);
}

.assignee-template__note,
.assignee-template__warning,
.assignee-template__empty {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, #f8fafc);
  color: var(--app-muted, #6b7280);
}

.assignee-template__warning,
.assignee-template__empty--warning {
  border-color: #ffd591;
  background: #fff7e6;
  color: #8a5a00;
}

.assignee-template__bar,
.assignee-template__row,
.assignee-template__footer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.assignee-template__bar {
  flex-wrap: wrap;
}

.assignee-template__field,
.assignee-template__copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assignee-template__field {
  min-width: 190px;
}

.assignee-template__field--wide {
  min-width: 280px;
}

.assignee-template__field span {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.assignee-template__field input,
.assignee-template__field select,
.assignee-template__row select {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
}

.assignee-template__row {
  align-items: center;
  padding: 12px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, #f8fafc);
}

.assignee-template__copy {
  flex: 1;
  min-width: 0;
}

.assignee-template__row select {
  width: 320px;
  min-height: 76px;
}

.assignee-template__footer {
  justify-content: flex-end;
}

.assignee-template__ghost,
.assignee-template__primary,
.assignee-template__danger {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  padding: 8px 14px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  cursor: pointer;
}

.assignee-template__primary {
  border-color: #1677ff;
  background: #1677ff;
  color: #fff;
}

.assignee-template__danger {
  border-color: #ffccc7;
  color: #cf1322;
}

.assignee-template__ghost:disabled,
.assignee-template__primary:disabled,
.assignee-template__danger:disabled,
.assignee-template__row select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 720px) {
  .assignee-template__bar,
  .assignee-template__row,
  .assignee-template__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .assignee-template__field,
  .assignee-template__field--wide,
  .assignee-template__row select {
    width: 100%;
    min-width: 0;
  }
}

/* 深色模式：warning 状态条换为深底+柔和橙字 */
:root[data-theme="dark"] .assignee-template__warning,
:root[data-theme="dark"] .assignee-template__empty--warning {
  background: rgba(249, 115, 22, 0.16);
  border-color: rgba(249, 115, 22, 0.4);
  color: #fdba74;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .assignee-template__warning,
  :root:not([data-theme]) .assignee-template__empty--warning {
    background: rgba(249, 115, 22, 0.16);
    border-color: rgba(249, 115, 22, 0.4);
    color: #fdba74;
  }
}
</style>
