<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Modal } from "ant-design-vue";
import { LeftOutlined, ReloadOutlined, RightOutlined } from "@ant-design/icons-vue";
import { useRoute, useRouter } from "vue-router";
import type {
  Artifact,
  FeedbackAction,
  NodeExecutionState,
  OrchestrationInstance,
  PendingMineListItem,
  ReminderItem,
  WorkspaceId,
} from "@codeflowai/shared";

import { listWorkspaceReminderItems, markReminderRead } from "../../../api/reminders";
import {
  createOfficeH5RequestId,
  getOfficeH5OrchInstance,
  listOfficeH5PendingMine,
  listOfficeH5OrchArtifacts,
  resumeOfficeH5OrchInstance,
  skipOfficeH5OrchNode,
  startOfficeH5OrchNode,
  submitOfficeH5OrchFeedback,
  type AccountH5HttpMeta,
} from "../../../api/office-h5";
import { useApiContext } from "../../../composables/useApiContext";
import { resolveAccountH5DeepLink } from "../accountH5DeepLink";
import { APP_MODALS_KEY } from "../../../services/appModals";
import { useConfigStore } from "../../../store/config";
import { selectOfficeH5ChatReminderItems } from "../pendingItems";
import { resolveNodeWorkbenchDescriptor } from "../../orchestration/node-workbench";

const route = useRoute();
const router = useRouter();
const config = useConfigStore();
const appModals = inject(APP_MODALS_KEY, null);
const { ctx } = useApiContext();

type PendingAction = "approve" | "request_changes" | "submit" | "start" | "skip" | "resume" | "terminate";
type PendingActionOption = { key: PendingAction; label: string; tone?: "primary" | "danger" | "warning" | "neutral" };
type PendingRequirementGroup = {
  id: string;
  title: string;
  goal: string;
  updatedAt: number;
  items: PendingMineListItem[];
};

const pendingItems = ref<PendingMineListItem[]>([]);
const chatReminderItems = ref<ReminderItem[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const successMessage = ref("");
const targetNotice = ref("");
const requestId = ref("");
const actionKey = ref("");
const feedbackDrafts = ref<Record<string, string>>({});
const selectedPendingItem = ref<PendingMineListItem | null>(null);
const detailInstance = ref<OrchestrationInstance | null>(null);
const detailArtifacts = ref<Artifact[]>([]);
const detailLoading = ref(false);
const detailErrorMessage = ref("");
let listController: AbortController | null = null;
let actionController: AbortController | null = null;
let detailController: AbortController | null = null;
let refreshTimer: number | null = null;
let listRunId = 0;

const workspaceId = computed(() => String(config.workspaceId ?? "").trim());
const deepLink = computed(() => resolveAccountH5DeepLink(route.query as Record<string, unknown>));
const totalPendingCount = computed(() => pendingItems.value.length + chatReminderItems.value.length);
const actionRequiredCount = computed(() =>
  pendingItems.value.filter((item) => item.reminder.isActionRequired).length
  + chatReminderItems.value.filter((item) => item.isActionRequired).length,
);
const pendingRequirementGroups = computed<PendingRequirementGroup[]>(() => {
  const groups = new Map<string, PendingRequirementGroup>();
  for (const item of pendingItems.value) {
    const id = String(item.intake.id ?? item.reminder.routeTarget.intakeId ?? item.reminder.id);
    const current = groups.get(id);
    if (current) {
      current.items.push(item);
      current.updatedAt = Math.max(current.updatedAt, item.reminder.updatedAt);
      continue;
    }
    groups.set(id, {
      id,
      title: item.intake.title || item.reminder.title || "未命名需求",
      goal: item.intake.goal || "",
      updatedAt: item.reminder.updatedAt,
      items: [item],
    });
  }
  return [...groups.values()].sort((left, right) => right.updatedAt - left.updatedAt);
});
const selectedTarget = computed(() => selectedPendingItem.value ? pendingTarget(selectedPendingItem.value) : null);
const selectedNodeState = computed<NodeExecutionState | null>(() => {
  const nodeId = selectedTarget.value?.nodeId;
  return nodeId ? detailInstance.value?.nodeStates?.[nodeId] ?? null : null;
});
const selectedWorkbench = computed(() => resolveNodeWorkbenchDescriptor(selectedNodeState.value));
const selectedNodeLabel = computed(() => {
  const nodeId = selectedTarget.value?.nodeId;
  if (!nodeId) return selectedPendingItem.value?.reminder.statusLabel || "待处理节点";
  return detailInstance.value?.workflowSnapshot.nodes.find((node) => node.id === nodeId)?.label
    || selectedPendingItem.value?.listMeta.latestInstance?.runSummary.activeNodeLabel
    || nodeId;
});
const selectedFeedbackArtifacts = computed(() => {
  const nodeState = selectedNodeState.value;
  const nodeId = selectedTarget.value?.nodeId;
  if (!nodeState || !nodeId) return [];
  const outputIds = new Set((nodeState.outputArtifactIds ?? []).map(String));
  const candidates = outputIds.size
    ? detailArtifacts.value.filter((artifact) => outputIds.has(String(artifact.id)))
    : detailArtifacts.value.filter((artifact) => artifact.nodeId === nodeId && artifact.status !== "superseded");
  return [...candidates].sort((left, right) => {
    const versionDiff = Number(right.version ?? 0) - Number(left.version ?? 0);
    return versionDiff || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0);
  });
});
const visibleAcceptanceChecks = computed(() =>
  (selectedNodeState.value?.conclusion?.acceptanceChecks ?? []).filter((check) => check.verdict === "pass" || check.verdict === "fail"),
);
const selectedItemReadOnly = computed(() => Boolean(
  detailInstance.value?.readOnly || selectedPendingItem.value?.listMeta.latestInstance?.readOnly,
));

/** 为账号 H5 待办请求生成可追踪元数据。 */
function accountMeta(prefix: string): AccountH5HttpMeta {
  const meta = { entryChannel: "h5", requestId: createOfficeH5RequestId(prefix) } as const;
  requestId.value = meta.requestId;
  return meta;
}

/** 将待办状态限制为当前语义下可执行的动作。 */
function actionsFor(item: PendingMineListItem): PendingActionOption[] {
  if (item.listMeta.latestInstance?.readOnly) return [];
  if (item.pendingMineStatus === "waiting-start") {
    return [
      { key: "terminate", label: "终止", tone: "danger" },
      { key: "skip", label: "跳过", tone: "neutral" },
      { key: "start", label: "提交", tone: "primary" },
    ];
  }
  if (item.pendingMineStatus === "waiting-approval") {
    return [
      { key: "terminate", label: "终止", tone: "danger" },
      { key: "skip", label: "跳过", tone: "neutral" },
      { key: "request_changes", label: "要求修改", tone: "warning" },
      { key: "approve", label: "提交", tone: "primary" },
    ];
  }
  if (item.pendingMineStatus === "waiting-feedback") {
    return [
      { key: "terminate", label: "终止", tone: "danger" },
      { key: "skip", label: "跳过", tone: "neutral" },
      { key: "submit", label: "提交", tone: "primary" },
    ];
  }
  if (item.pendingMineStatus === "paused" || item.pendingMineStatus === "failed") {
    return [
      { key: "terminate", label: "终止", tone: "danger" },
      { key: "skip", label: "跳过", tone: "neutral" },
      { key: "resume", label: "恢复", tone: "primary" },
    ];
  }
  return [];
}

/** 判断当前动作是否必须携带人工意见。 */
function requiresFeedback(action: PendingAction): boolean {
  return action === "request_changes"
    || (action === "submit" && selectedWorkbench.value.attentionKind === "human_input");
}

/** 将需要人工反馈的 H5 操作映射到既有编排协议。 */
function feedbackActionFor(item: PendingMineListItem, action: PendingAction): FeedbackAction | null {
  if (action === "terminate") return "abort";
  if (action === "skip" && item.pendingMineStatus !== "waiting-start") return "skip";
  if (action === "approve") return "approve";
  if (action === "request_changes") return "retry";
  if (action === "submit") return "resume_with_input";
  return null;
}

/** 解析待办动作的工作区、实例和节点目标。 */
function pendingTarget(item: PendingMineListItem): { workspaceId: WorkspaceId; instanceId: string | null; nodeId: string | null } {
  return {
    workspaceId: (item.reminder.routeTarget.workspaceId || workspaceId.value) as WorkspaceId,
    instanceId: item.reminder.routeTarget.instanceId ?? null,
    nodeId: item.reminder.routeTarget.nodeId ?? null,
  };
}

/** 使用固定中文 locale 展示待办更新时间。 */
function formatTime(value: number | null | undefined): string {
  if (!value) return "更新时间未知";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 返回需求待办行中的节点和处理原因摘要。 */
function pendingItemSummary(item: PendingMineListItem): string {
  const detail = item.listMeta.latestInstance?.runSummary.detailText || item.reminder.summary;
  return String(detail ?? "").trim() || "等待人工处理";
}

/** 把节点结论转成与 Web 端一致的业务短标签。 */
function conclusionVerdictLabel(): string {
  const verdict = selectedNodeState.value?.conclusion?.reviewVerdict;
  if (verdict === "fail") return "不通过";
  if (verdict === "partial") return "部分满足";
  return "通过";
}

/** 生成详情页当前原因，优先使用实例节点的权威状态。 */
function selectedReason(): string {
  return String(
    selectedNodeState.value?.error
    ?? selectedWorkbench.value.detailLabel
    ?? selectedPendingItem.value?.reminder.summary
    ?? "等待人工处理",
  ).trim() || "等待人工处理";
}

/** 返回移动端关联结果的稳定状态文案。 */
function artifactStatusLabel(artifact: Artifact): string {
  if (artifact.status === "approved") return "已通过";
  if (artifact.status === "rejected") return "已驳回";
  if (artifact.status === "superseded") return "已被替换";
  return "草稿";
}

/** 仅展示已结构化的产物摘要，避免在 H5 展开大段原始 JSON。 */
function artifactSummary(artifact: Artifact): string {
  return String(artifact.manifest?.summary ?? "").trim() || "暂无摘要";
}

/** 判断待办是否命中通知深链中的目标标识。 */
function matchesDeepLinkTarget(item: PendingMineListItem | ReminderItem): boolean {
  const targetId = deepLink.value.targetId;
  if (!targetId) return false;
  const reminder = "reminder" in item ? item.reminder : item;
  const intakeId = "intake" in item ? item.intake.id : null;
  return [
    reminder.id,
    intakeId,
    reminder.routeTarget.instanceId,
    reminder.routeTarget.nodeId,
    reminder.routeTarget.threadId,
  ].some((value) => String(value ?? "").trim() === targetId);
}

/** 滚动并标记通知目标；目标已处理或不在当前列表时给出明确提示。 */
async function focusDeepLinkedPendingItem(): Promise<void> {
  targetNotice.value = "";
  if (!deepLink.value.targetId) return;
  await nextTick();
  if (typeof document === "undefined") return;
  const target = document.querySelector<HTMLElement>('[data-h5-pending-target="true"]');
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
    return;
  }
  targetNotice.value = "通知对应的待办可能已处理，或不在当前账号的待办列表中。";
}

/** 读取当前工作区待办；切换工作区或卸载时取消旧请求。 */
async function refreshPending(options: { focusDeepLink?: boolean } = {}): Promise<void> {
  listController?.abort();
  targetNotice.value = "";
  const currentWorkspaceId = workspaceId.value;
  if (!currentWorkspaceId) {
    pendingItems.value = [];
    loading.value = false;
    errorMessage.value = "";
    return;
  }

  const controller = new AbortController();
  const runId = ++listRunId;
  listController = controller;
  loading.value = true;
  errorMessage.value = "";

  try {
    const [workflowResult, reminderResult] = await Promise.all([
      listOfficeH5PendingMine(
        ctx.value,
        accountMeta("h5_pending"),
        currentWorkspaceId as WorkspaceId,
        controller.signal,
      ),
      listWorkspaceReminderItems(ctx.value, currentWorkspaceId as WorkspaceId, { signal: controller.signal }),
    ]);
    if (controller.signal.aborted || runId !== listRunId || currentWorkspaceId !== workspaceId.value) return;
    if (!workflowResult.ok) throw new Error(String(workflowResult.code) + ": " + String(workflowResult.message));
    if (!reminderResult.ok) throw new Error(String(reminderResult.code) + ": " + String(reminderResult.message));
    pendingItems.value = workflowResult.items ?? [];
    chatReminderItems.value = selectOfficeH5ChatReminderItems(reminderResult.items ?? []);
    if (selectedPendingItem.value) {
      const refreshedSelection = pendingItems.value.find((item) => item.reminder.id === selectedPendingItem.value?.reminder.id) ?? null;
      if (refreshedSelection) selectedPendingItem.value = refreshedSelection;
      else {
        closePendingDetail();
        successMessage.value = "该待办已处理，已返回列表。";
      }
    }
    if (options.focusDeepLink !== false) await focusDeepLinkedPendingItem();
  } catch (error) {
    if (controller.signal.aborted || runId !== listRunId) return;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (listController === controller) {
      listController = null;
      loading.value = false;
    }
  }
}

/** 加载待办对应的实例和产物，详情展示口径与 Web 节点反馈面板一致。 */
async function openPendingDetail(item: PendingMineListItem): Promise<void> {
  detailController?.abort();
  selectedPendingItem.value = item;
  detailInstance.value = null;
  detailArtifacts.value = [];
  detailErrorMessage.value = "";
  const target = pendingTarget(item);
  if (!target.instanceId || !target.nodeId) {
    detailErrorMessage.value = "当前待办缺少实例或节点标识，无法加载详情。";
    return;
  }

  const controller = new AbortController();
  detailController = controller;
  detailLoading.value = true;
  try {
    const [instanceResult, artifactsResult] = await Promise.all([
      getOfficeH5OrchInstance(ctx.value, accountMeta("h5_pending_instance"), {
        workspaceId: target.workspaceId,
        instanceId: target.instanceId,
      }, controller.signal),
      listOfficeH5OrchArtifacts(ctx.value, accountMeta("h5_pending_artifacts"), {
        workspaceId: target.workspaceId,
        instanceId: target.instanceId,
        includeContent: false,
      }, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (!instanceResult.ok) throw new Error(`${instanceResult.code}: ${instanceResult.message}`);
    if (!artifactsResult.ok) throw new Error(`${artifactsResult.code}: ${artifactsResult.message}`);
    detailInstance.value = instanceResult.instance;
    detailArtifacts.value = artifactsResult.artifacts ?? [];
    if (!detailInstance.value.nodeStates[target.nodeId]) {
      throw new Error("待办对应的节点状态不存在，请刷新后重试。");
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    detailErrorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (detailController === controller) {
      detailController = null;
      detailLoading.value = false;
    }
  }
}

/** 关闭待办详情并取消尚未完成的详情请求。 */
function closePendingDetail(): void {
  detailController?.abort();
  detailController = null;
  detailLoading.value = false;
  selectedPendingItem.value = null;
  detailInstance.value = null;
  detailArtifacts.value = [];
  detailErrorMessage.value = "";
}

/** 刷新当前可见层；详情打开时同步刷新列表和节点详情。 */
async function refreshVisiblePending(): Promise<void> {
  await refreshPending({ focusDeepLink: false });
  if (selectedPendingItem.value) await openPendingDetail(selectedPendingItem.value);
}

/** Open a chat completion reminder, mark it read, then open the H5 thread. */
async function openChatReminder(item: ReminderItem): Promise<void> {
  const threadId = String(item.routeTarget.threadId ?? "").trim();
  if (!threadId) {
    errorMessage.value = "该会话提醒缺少 threadId，无法打开。";
    return;
  }

  actionController?.abort();
  const controller = new AbortController();
  actionController = controller;
  actionKey.value = item.id + ":open";
  errorMessage.value = "";
  successMessage.value = "";

  try {
    const marker = String(item.id.split(":").slice(-1)[0] ?? "").trim() || null;
    const result = await markReminderRead(ctx.value, {
      workspaceId: item.workspaceId,
      entityType: "thread",
      entityId: threadId,
      marker,
    });
    if (!result.ok) throw new Error(String(result.code) + ": " + String(result.message));
    if (controller.signal.aborted) return;
    chatReminderItems.value = chatReminderItems.value.filter((entry) => entry.id !== item.id);
    await router.push({ path: "/chat", query: { ...route.query, threadId } });
  } catch (error) {
    if (controller.signal.aborted) return;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (actionController === controller) {
      actionController = null;
      actionKey.value = "";
    }
  }
}

/** Execute one orchestration pending action and preserve requestId on failure. */
async function executePendingAction(item: PendingMineListItem, action: PendingAction): Promise<void> {
  const target = pendingTarget(item);
  if (!target.instanceId || !target.nodeId) {
    errorMessage.value = "当前待办缺少实例或节点标识，无法执行。";
    return;
  }

  const feedback = String(feedbackDrafts.value[item.reminder.id] ?? "").trim();
  if (requiresFeedback(action) && !feedback) {
    errorMessage.value = action === "request_changes" ? "请先填写修改要求。" : "请先填写补充说明。";
    return;
  }

  actionController?.abort();
  const controller = new AbortController();
  actionController = controller;
  actionKey.value = `${item.reminder.id}:${action}`;
  errorMessage.value = "";
  successMessage.value = "";

  try {
    const feedbackAction = feedbackActionFor(item, action);
    const meta = accountMeta("h5_pending_action");
    const body = {
      workspaceId: target.workspaceId,
      instanceId: target.instanceId,
      nodeId: target.nodeId,
      feedback: feedback || null,
      ...(feedbackAction ? { artifactIds: selectedFeedbackArtifacts.value.map((artifact) => artifact.id) } : {}),
    };
    const result = action === "start"
      ? await startOfficeH5OrchNode(ctx.value, meta, body, controller.signal)
      : action === "skip" && item.pendingMineStatus === "waiting-start"
        ? await skipOfficeH5OrchNode(ctx.value, meta, body, controller.signal)
        : action === "resume"
          ? await resumeOfficeH5OrchInstance(ctx.value, meta, body, controller.signal)
          : await submitOfficeH5OrchFeedback(ctx.value, meta, { ...body, action: feedbackAction }, controller.signal);
    if (controller.signal.aborted) return;
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    feedbackDrafts.value[item.reminder.id] = "";
    successMessage.value = action === "terminate"
      ? "流程已终止。"
      : action === "skip"
        ? "节点已跳过。"
        : "操作已提交。";
    closePendingDetail();
    await refreshPending();
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    if (selectedPendingItem.value) detailErrorMessage.value = message;
    else errorMessage.value = message;
  } finally {
    if (actionController === controller) {
      actionController = null;
      actionKey.value = "";
    }
  }
}

/** 对终止和跳过动作进行二次确认，其余动作直接进入统一执行入口。 */
function requestPendingAction(item: PendingMineListItem, action: PendingAction): void {
  if (action === "terminate") {
    Modal.confirm({
      title: "确认终止本次流程？",
      content: "确认后，当前节点会标记为失败，本次流程执行会停止；已写入工作区的文件不会自动回滚。",
      okText: "确认终止流程",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => executePendingAction(item, action),
    });
    return;
  }
  if (action === "skip") {
    Modal.confirm({
      title: `确认跳过节点「${selectedNodeLabel.value}」？`,
      content: "确认后，系统会跳过当前节点并继续后续流程；如果下游依赖当前节点输出，后续节点可能失败。",
      okText: "确认跳过",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => executePendingAction(item, action),
    });
    return;
  }
  void executePendingAction(item, action);
}

/** 打开已有工作区管理能力，不在 H5 待办面板内复制配置表单。 */
function openWorkspaceManager(): void {
  appModals?.openWorkspaceManager();
}

watch(() => [workspaceId.value, deepLink.value.targetId] as const, () => {
  actionController?.abort();
  actionController = null;
  actionKey.value = "";
  successMessage.value = "";
  closePendingDetail();
  void refreshPending();
}, { immediate: true });

/** 列表可见时低频刷新待办；进入详情后暂停轮询，避免打断意见填写。 */
onMounted(() => {
  if (typeof window === "undefined") return;
  refreshTimer = window.setInterval(() => {
    if (document.hidden || selectedPendingItem.value) return;
    void refreshPending({ focusDeepLink: false });
  }, 60_000);
});

onBeforeUnmount(() => {
  listController?.abort();
  actionController?.abort();
  detailController?.abort();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  listController = null;
  actionController = null;
});
</script>

<template>
  <section class="h5-pending-panel">
    <template v-if="selectedPendingItem">
      <header class="h5-pending-detail__header">
        <button type="button" class="h5-pending-detail__back" aria-label="返回待办列表" @click="closePendingDetail">
          <LeftOutlined />
        </button>
        <div>
          <strong>待办详情</strong>
          <span>{{ selectedNodeLabel }}</span>
        </div>
        <button
          type="button"
          class="h5-pending-panel__refresh"
          :disabled="loading || detailLoading"
          aria-label="刷新待办详情"
          @click="refreshVisiblePending"
        >
          <ReloadOutlined :class="{ spinning: loading || detailLoading }" />
        </button>
      </header>

      <div class="h5-pending-detail__content">
        <div class="h5-pending-detail__identity">
          <div class="h5-pending-card__topline">
            <span>{{ selectedNodeState ? selectedWorkbench.statusLabel : selectedPendingItem.pendingMineStatusLabel }}</span>
            <time>{{ formatTime(selectedPendingItem.reminder.updatedAt) }}</time>
          </div>
          <h1>{{ selectedPendingItem.intake.title || selectedPendingItem.reminder.title }}</h1>
          <p>{{ selectedPendingItem.intake.goal || selectedPendingItem.reminder.summary }}</p>
        </div>

        <div v-if="detailLoading && !detailInstance" class="h5-pending-panel__empty h5-pending-panel__empty--detail">
          <strong>正在加载待办详情</strong>
          <p>正在读取节点状态、处理提示和关联结果。</p>
        </div>

        <div v-if="detailErrorMessage" class="h5-pending-panel__notice h5-pending-panel__notice--error" role="alert">
          <strong>待办详情加载或操作失败</strong>
          <span>{{ detailErrorMessage }}</span>
          <small v-if="requestId">requestId: {{ requestId }}</small>
          <button v-if="!detailInstance" type="button" @click="openPendingDetail(selectedPendingItem)">重新加载</button>
        </div>

        <template v-if="detailInstance && selectedNodeState">
          <section class="h5-pending-detail__section h5-pending-detail__section--reason">
            <span>当前原因</span>
            <p>{{ selectedReason() }}</p>
          </section>

          <section v-if="selectedNodeState.conclusion" class="h5-pending-detail__section">
            <span>业务结论</span>
            <strong>{{ conclusionVerdictLabel() }}</strong>
            <p>{{ selectedNodeState.conclusion.summary || "未填写结论摘要" }}</p>
            <p
              v-if="selectedNodeState.conclusion.humanInput?.summary && selectedNodeState.conclusion.humanInput.summary !== selectedNodeState.conclusion.summary"
              class="h5-pending-detail__supplement-hint"
            >
              {{ selectedNodeState.conclusion.humanInput.summary }}
            </p>
          </section>

          <section v-if="selectedFeedbackArtifacts.length" class="h5-pending-detail__section">
            <div class="h5-pending-detail__section-title">
              <span>关联结果</span>
              <small>{{ selectedFeedbackArtifacts.length }} 份</small>
            </div>
            <div class="h5-pending-detail__results">
              <article v-for="artifact in selectedFeedbackArtifacts" :key="artifact.id">
                <div>
                  <strong>{{ artifact.title || artifact.kind }}</strong>
                  <span>{{ artifactStatusLabel(artifact) }}</span>
                </div>
                <p>{{ artifactSummary(artifact) }}</p>
              </article>
            </div>
          </section>

          <section v-if="visibleAcceptanceChecks.length" class="h5-pending-detail__section">
            <div class="h5-pending-detail__section-title">
              <span>验收检查</span>
              <small>{{ visibleAcceptanceChecks.length }} 条</small>
            </div>
            <div class="h5-pending-detail__checks">
              <div v-for="check in visibleAcceptanceChecks" :key="check.criterionId || check.label" :class="check.verdict">
                <i aria-hidden="true" />
                <span>{{ check.label }}</span>
                <small>{{ check.evidence || (check.verdict === 'pass' ? '通过' : '未通过') }}</small>
              </div>
            </div>
          </section>

          <section v-if="!selectedItemReadOnly" class="h5-pending-detail__section h5-pending-detail__section--input">
            <label :for="`h5-pending-feedback-${selectedPendingItem.reminder.id}`">补充意见</label>
            <textarea
              :id="`h5-pending-feedback-${selectedPendingItem.reminder.id}`"
              v-model="feedbackDrafts[selectedPendingItem.reminder.id]"
              rows="5"
              :placeholder="selectedWorkbench.attentionKind === 'human_input'
                ? '按上面的补充要求填写缺失信息、文件路径或确认意见。'
                : '填写处理意见，提交时会一并写回当前节点。'"
            />
            <small v-if="selectedWorkbench.attentionKind === 'human_input'">当前节点需要补充信息后才能继续。</small>
          </section>

          <div v-if="selectedItemReadOnly" class="h5-pending-card__receipt">这条共享需求为只读，当前账号不能推进流程。</div>

          <footer v-else-if="actionsFor(selectedPendingItem).length" class="h5-pending-detail__actions">
            <button
              v-for="action in actionsFor(selectedPendingItem)"
              :key="action.key"
              type="button"
              :class="{
                'h5-pending-detail__action--primary': action.tone === 'primary',
                'h5-pending-detail__action--danger': action.tone === 'danger',
                'h5-pending-detail__action--warning': action.tone === 'warning',
                'h5-pending-detail__action--neutral': action.tone === 'neutral',
              }"
              :disabled="Boolean(actionKey) || (requiresFeedback(action.key) && !String(feedbackDrafts[selectedPendingItem.reminder.id] ?? '').trim())"
              @click="requestPendingAction(selectedPendingItem, action.key)"
            >
              {{ actionKey === `${selectedPendingItem.reminder.id}:${action.key}` ? "处理中" : action.label }}
            </button>
          </footer>
        </template>
      </div>
    </template>

    <template v-else>
      <header class="h5-pending-panel__toolbar">
        <div v-if="workspaceId" class="h5-pending-panel__summary">
          <span>待办 {{ totalPendingCount }}</span>
          <span>需操作 {{ actionRequiredCount }}</span>
        </div>
        <button type="button" class="h5-pending-panel__refresh" :disabled="loading" @click="refreshVisiblePending">
          <ReloadOutlined :class="{ spinning: loading }" />
          <span>{{ loading ? "刷新中" : "刷新" }}</span>
        </button>
      </header>

      <div v-if="!workspaceId" class="h5-pending-panel__empty">
        <strong>请先选择工作区</strong>
        <p>选择工作区后，H5 才能加载与该工作区关联的流程待办。</p>
        <button type="button" @click="openWorkspaceManager">选择工作区</button>
      </div>

      <template v-else>
      <div v-if="errorMessage" class="h5-pending-panel__notice h5-pending-panel__notice--error" role="alert">
        <strong>待办操作未完成</strong>
        <span>{{ errorMessage }}</span>
        <small v-if="requestId">requestId: {{ requestId }}</small>
      </div>
      <div v-else-if="successMessage" class="h5-pending-panel__notice h5-pending-panel__notice--success" aria-live="polite">
        {{ successMessage }}
      </div>
      <div v-if="targetNotice" class="h5-pending-panel__notice h5-pending-panel__notice--info" role="status">
        {{ targetNotice }}
      </div>

      <div v-if="loading && totalPendingCount === 0" class="h5-pending-panel__empty">
        <strong>正在加载待办</strong>
        <p>请稍候，不会在工作区切换后写回旧请求结果。</p>
      </div>
      <div v-else-if="totalPendingCount === 0 && !errorMessage" class="h5-pending-panel__empty">
        <strong>当前没有待处理事项</strong>
        <p>新的审核、反馈或会话完成提醒出现后会显示在这里。</p>
      </div>

        <section v-for="group in pendingRequirementGroups" :key="group.id" class="h5-pending-group">
          <header>
            <div>
              <strong>{{ group.title }}</strong>
              <p v-if="group.goal">{{ group.goal }}</p>
            </div>
            <span>{{ group.items.length }} 项</span>
          </header>
          <button
            v-for="item in group.items"
            :key="item.reminder.id"
            type="button"
            class="h5-pending-row"
            :class="{ 'h5-pending-row--target': matchesDeepLinkTarget(item) }"
            :data-h5-pending-target="matchesDeepLinkTarget(item) ? 'true' : undefined"
            @click="openPendingDetail(item)"
          >
            <span class="h5-pending-row__status">{{ item.pendingMineStatusLabel || item.reminder.statusLabel }}</span>
            <span class="h5-pending-row__body">
              <strong>{{ item.listMeta.latestInstance?.runSummary.activeNodeLabel || item.reminder.title }}</strong>
              <small>{{ pendingItemSummary(item) }}</small>
            </span>
            <time>{{ formatTime(item.reminder.updatedAt) }}</time>
            <RightOutlined />
          </button>
        </section>

        <section v-if="chatReminderItems.length" class="h5-pending-group h5-pending-group--chat">
          <header>
            <div><strong>会话待查收</strong></div>
            <span>{{ chatReminderItems.length }} 项</span>
          </header>
          <button
            v-for="item in chatReminderItems"
            :key="item.id"
            type="button"
            class="h5-pending-row"
            :class="{ 'h5-pending-row--target': matchesDeepLinkTarget(item) }"
            :data-h5-pending-target="matchesDeepLinkTarget(item) ? 'true' : undefined"
            :disabled="Boolean(actionKey)"
            @click="openChatReminder(item)"
          >
            <span class="h5-pending-row__status h5-pending-row__status--chat">{{ item.statusLabel }}</span>
            <span class="h5-pending-row__body">
              <strong>{{ item.title }}</strong>
              <small>{{ item.summary || "会话已完成，等待您查看结果。" }}</small>
            </span>
            <time>{{ formatTime(item.updatedAt) }}</time>
            <RightOutlined />
          </button>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.h5-pending-panel {
  min-height: 100%;
  padding: 4px 2px calc(20px + env(safe-area-inset-bottom));
  color: var(--app-text);
}

.h5-pending-panel__empty button {
  min-height: 44px;
  border-radius: 13px;
  font-weight: 700;
}

.h5-pending-panel__summary {
  display: flex;
  min-width: 0;
  gap: 8px;
  margin: 0;
}

.h5-pending-panel__summary span {
  padding: 6px 10px;
  border: 1px solid var(--app-divider);
  border-radius: 999px;
  color: var(--app-muted);
  background: var(--app-panel-bg);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.h5-pending-panel__notice,
.h5-pending-panel__empty {
  margin-top: 10px;
  border: 1px solid var(--app-divider);
  border-radius: 18px;
  background: var(--app-panel-bg);
}

.h5-pending-panel__notice {
  display: grid;
  gap: 5px;
  padding: 13px 15px;
  font-size: 13px;
}

.h5-pending-panel__notice--error {
  border-color: color-mix(in srgb, var(--app-danger) 38%, var(--app-divider));
  color: var(--app-danger);
}

.h5-pending-panel__notice--success {
  border-color: color-mix(in srgb, var(--app-success) 34%, var(--app-divider));
  color: var(--app-success);
}

.h5-pending-panel__notice--info {
  border-color: color-mix(in srgb, #2c6b58 30%, var(--app-divider));
  color: var(--app-text);
}

.h5-pending-panel__notice small {
  color: var(--app-muted);
  overflow-wrap: anywhere;
}

.h5-pending-panel__empty {
  padding: 28px 20px;
  text-align: center;
}

.h5-pending-panel__empty strong {
  font-size: 16px;
}

.h5-pending-panel__empty p {
  margin: 8px auto 16px;
  color: var(--app-muted);
  line-height: 1.6;
}

.h5-pending-panel__empty button {
  padding: 0 16px;
  border: 0;
  color: #fffdf7;
  background: #245f4e;
}

.h5-pending-card__topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--app-muted);
  font-size: 12px;
}

.h5-pending-card__topline span {
  padding: 5px 9px;
  border-radius: 999px;
  color: #875223;
  background: #f4e2c5;
  font-weight: 800;
}

.h5-pending-card__receipt {
  margin-top: 14px;
  color: var(--app-muted);
  font-size: 12px;
}

.h5-pending-panel__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 0 2px 8px;
}

.h5-pending-panel__toolbar .h5-pending-panel__refresh {
  margin-left: auto;
}

.h5-pending-panel__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 44px;
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--app-divider);
  border-radius: 12px;
  color: var(--app-muted);
  background: var(--app-panel-bg);
  font-weight: 700;
}

.h5-pending-panel__refresh .spinning {
  animation: h5-pending-spin 0.9s linear infinite;
}

.h5-pending-group {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--app-divider);
  border-radius: 18px;
  background: var(--app-panel-bg);
}

.h5-pending-group > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--app-divider);
}

.h5-pending-group > header strong {
  font-size: 15px;
}

.h5-pending-group > header p {
  max-width: 255px;
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-pending-group > header > span {
  flex: 0 0 auto;
  color: var(--app-muted);
  font-size: 12px;
}

.h5-pending-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 72px;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 74%, transparent);
  color: var(--app-text);
  background: transparent;
  text-align: left;
}

.h5-pending-row:last-child {
  border-bottom: 0;
}

.h5-pending-row:active,
.h5-pending-row--target {
  background: color-mix(in srgb, #2c6b58 9%, var(--app-panel-bg));
}

.h5-pending-row__status {
  align-self: start;
  margin-top: 1px;
  padding: 5px 7px;
  border-radius: 8px;
  color: #875223;
  background: #f4e2c5;
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}

.h5-pending-row__status--chat {
  color: #21634f;
  background: #dff1e9;
}

.h5-pending-row__body {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.h5-pending-row__body strong,
.h5-pending-row__body small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-pending-row__body strong {
  font-size: 14px;
}

.h5-pending-row__body small,
.h5-pending-row time,
.h5-pending-row > svg {
  color: var(--app-muted);
  font-size: 11px;
}

.h5-pending-row time {
  white-space: nowrap;
}

.h5-pending-detail__header {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 0 2px 8px;
  border-bottom: 1px solid var(--app-divider);
}

.h5-pending-detail__header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.h5-pending-detail__header strong,
.h5-pending-detail__header span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-pending-detail__header span {
  color: var(--app-muted);
  font-size: 12px;
}

.h5-pending-detail__back,
.h5-pending-detail__header .h5-pending-panel__refresh {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  min-width: 40px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  color: var(--app-text);
  background: transparent;
}

.h5-pending-detail__content {
  display: grid;
  gap: 10px;
  padding: 12px 2px calc(24px + env(safe-area-inset-bottom));
}

.h5-pending-detail__identity {
  padding: 2px 2px 4px;
}

.h5-pending-detail__identity h1 {
  margin: 11px 0 5px;
  font-size: 20px;
  line-height: 1.35;
}

.h5-pending-detail__identity > p {
  margin: 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

.h5-pending-detail__section {
  display: grid;
  gap: 7px;
  padding: 14px;
  border: 1px solid var(--app-divider);
  border-radius: 16px;
  background: var(--app-panel-bg);
}

.h5-pending-detail__section > span,
.h5-pending-detail__section-title > span,
.h5-pending-detail__section--input label {
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 800;
}

.h5-pending-detail__section > p,
.h5-pending-detail__supplement-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.h5-pending-detail__section--reason {
  border-color: color-mix(in srgb, var(--app-danger) 34%, var(--app-divider));
  background: color-mix(in srgb, var(--app-danger) 4%, var(--app-panel-bg));
}

.h5-pending-detail__section--reason > span {
  color: var(--app-danger);
}

.h5-pending-detail__section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.h5-pending-detail__section-title small,
.h5-pending-detail__section--input small {
  color: var(--app-muted);
  font-size: 11px;
}

.h5-pending-detail__results {
  display: grid;
  gap: 8px;
}

.h5-pending-detail__results article {
  padding: 10px;
  border-radius: 12px;
  background: var(--app-bg);
}

.h5-pending-detail__results article > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.h5-pending-detail__results article span {
  color: var(--app-muted);
  font-size: 11px;
}

.h5-pending-detail__results article p {
  margin: 5px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.h5-pending-detail__checks {
  display: grid;
  gap: 7px;
}

.h5-pending-detail__checks > div {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  font-size: 12px;
}

.h5-pending-detail__checks i {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--app-muted);
}

.h5-pending-detail__checks .pass i { background: var(--app-success); }
.h5-pending-detail__checks .fail i { background: var(--app-danger); }

.h5-pending-detail__checks small {
  grid-column: 2;
  color: var(--app-muted);
  line-height: 1.45;
}

.h5-pending-detail__section--input textarea {
  width: 100%;
  min-height: 118px;
  padding: 11px 12px;
  border: 1px solid var(--app-divider);
  border-radius: 12px;
  color: var(--app-text);
  background: var(--app-bg);
  font: inherit;
  line-height: 1.55;
  resize: vertical;
}

.h5-pending-detail__section--input textarea:focus {
  outline: 2px solid color-mix(in srgb, #2c6b58 38%, transparent);
  outline-offset: 1px;
}

.h5-pending-detail__actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(64px, 1fr));
  gap: 6px;
  padding: 10px 2px calc(8px + env(safe-area-inset-bottom));
  border-top: 1px solid color-mix(in srgb, var(--app-divider) 72%, transparent);
  background: color-mix(in srgb, var(--app-bg) 94%, transparent);
  box-shadow: 0 -8px 20px color-mix(in srgb, var(--app-text) 6%, transparent);
}

.h5-pending-detail__actions button {
  appearance: none;
  min-width: 0;
  min-height: 44px;
  padding: 0 6px;
  border: 1px solid var(--app-divider);
  border-radius: 10px;
  color: var(--app-text);
  background: var(--app-panel-bg);
  font-size: 13px;
  font-weight: 750;
  line-height: 1.2;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--app-text) 7%, transparent);
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.12s ease;
}

.h5-pending-detail__actions button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 62%, transparent);
  outline-offset: 2px;
}

.h5-pending-detail__actions button.h5-pending-detail__action--primary {
  border-color: #245f4e;
  color: #fffdf7;
  background: #2c6b58;
  box-shadow: 0 3px 8px color-mix(in srgb, #2c6b58 24%, transparent);
}

.h5-pending-detail__actions button.h5-pending-detail__action--danger {
  border-color: color-mix(in srgb, var(--app-danger) 40%, var(--app-divider));
  color: color-mix(in srgb, var(--app-danger) 72%, var(--app-text));
  background: color-mix(in srgb, var(--app-danger) 9%, var(--app-panel-bg));
}

.h5-pending-detail__actions button.h5-pending-detail__action--warning {
  border-color: color-mix(in srgb, var(--app-warning) 44%, var(--app-divider));
  color: color-mix(in srgb, var(--app-warning) 58%, var(--app-text));
  background: color-mix(in srgb, var(--app-warning) 12%, var(--app-panel-bg));
}

.h5-pending-detail__actions button.h5-pending-detail__action--neutral {
  border-color: color-mix(in srgb, var(--app-muted) 30%, var(--app-divider));
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  background: color-mix(in srgb, var(--app-muted) 7%, var(--app-panel-bg));
}

.h5-pending-detail__actions button:active:not(:disabled) {
  transform: scale(0.98);
}

.h5-pending-detail__actions button:disabled,
.h5-pending-panel__refresh:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@keyframes h5-pending-spin {
  to { transform: rotate(360deg); }
}

</style>
