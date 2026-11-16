<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  EyeOutlined,
  LockOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons-vue";
import {
  isControlledExperimentTerminal,
  type ControlledExperimentCreateRequest,
  type ControlledExperimentDetail,
  type ControlledExperimentRun,
  type ControlledExperimentStatus,
  type ControlledExperimentSummary,
  type EngineStatus,
  type EngineType,
  type OrchestrationMetricEvaluationSetSummary,
} from "@codeflowai/shared";

import {
  cancelControlledExperiment,
  createControlledExperiment,
  freezeControlledExperiment,
  getControlledExperiment,
  getControlledExperiments,
  startControlledExperiment,
} from "../../api/orchestration-metrics";
import { getEnginesStatus } from "../../api/engines";
import { isCancelledRequestError } from "../../api/request";
import { useApiContext } from "../../composables/useApiContext";
import { useConfigStore } from "../../store/config";
import { useWorkspacesStore } from "../../store/workspaces";
import { createBrowserUuid } from "../../utils/browserUuid";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";

const props = defineProps<{
  active: boolean;
  evaluationSets: OrchestrationMetricEvaluationSetSummary[];
  evaluationSetsLoading: boolean;
  evaluationSetsError: string;
}>();

type ControlAction = "freeze" | "start" | "cancel";
type CreateDraft = {
  name: string;
  workspaceId: string;
  evaluationSetId: string;
  engine: EngineType;
  model: string;
  effort: string | null;
  perRunTimeoutSeconds: number;
  experimentDeadlineMinutes: number;
  maxTotalTokens: number;
  idempotencyKey: string;
};

const { ctx } = useApiContext();
const config = useConfigStore();
const workspaces = useWorkspacesStore();
const items = ref<ControlledExperimentSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const listLoaded = ref(false);
const listLoading = ref(false);
const listError = ref("");
const selectedExperimentId = ref("");
const detail = ref<ControlledExperimentDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const actionPending = ref<ControlAction | null>(null);
const actionError = ref("");
const createOpen = ref(false);
const createSaving = ref(false);
const createError = ref("");
const engineStatuses = ref<EngineStatus[]>([]);
const engineLoading = ref(false);
const engineError = ref("");
const draft = reactive<CreateDraft>(newDraft());

let listController: AbortController | null = null;
let detailController: AbortController | null = null;
let engineController: AbortController | null = null;
let listRequestVersion = 0;
let detailRequestVersion = 0;
let engineRequestVersion = 0;
let detailPollTimer: ReturnType<typeof setTimeout> | null = null;

const benchmarkOptions = computed(() => props.evaluationSets
  .filter((item) => item.kind === "benchmark")
  .map((item) => ({ label: `${item.name}（${item.itemCount} 条）`, value: item.id })));
const workspaceOptions = computed(() => workspaces.workspaces
  .filter((workspace) => workspace.kind !== "shared" && !workspace.shared && !isSharedWorkspaceSelectionId(String(workspace.id)))
  .map((workspace) => ({
    label: workspace.title || workspace.path || String(workspace.id),
    value: String(workspace.id),
    disabled: workspace.entryStatus != null && workspace.entryStatus !== "available",
  })));
const currentEngineStatus = computed(() => engineStatuses.value.find((item) => item.engineType === draft.engine) ?? null);
const engineOptions = computed(() => engineStatuses.value.map((item) => ({
  label: item.engineType === "codex" ? "Codex" : "Claude",
  value: item.engineType,
  disabled: !item.installed || Boolean(item.error),
})));
const modelOptions = computed(() => (currentEngineStatus.value?.models ?? []).map((model) => ({
  label: model.displayName || model.id,
  value: model.id,
})));
const currentModel = computed(() => currentEngineStatus.value?.models.find((model) => model.id === draft.model) ?? null);
const effortOptions = computed(() => (currentModel.value?.supportedReasoningEfforts ?? []).map((item) => ({
  label: item.reasoningEffort,
  value: item.reasoningEffort,
})));
const latestRuns = computed(() => latestAttemptRuns(detail.value?.runs ?? []));
const canSubmitCreate = computed(() => Boolean(
  draft.name.trim()
  && draft.workspaceId
  && draft.evaluationSetId
  && draft.model.trim()
  && !engineLoading.value
  && !engineError.value
));

/** Returns a fresh create form and stable idempotency key for one modal session. */
function newDraft(): CreateDraft {
  return {
    name: "",
    workspaceId: "",
    evaluationSetId: "",
    engine: "codex",
    model: "",
    effort: null,
    perRunTimeoutSeconds: 300,
    experimentDeadlineMinutes: 60,
    maxTotalTokens: 100_000,
    idempotencyKey: createBrowserUuid(),
  };
}

/** Loads one server-paged experiment slice without clearing valid cached rows on failure. */
async function loadList(): Promise<void> {
  const requestVersion = ++listRequestVersion;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  listLoading.value = true;
  listError.value = "";
  try {
    const result = await getControlledExperiments(ctx.value, page.value, pageSize.value, controller.signal);
    if (requestVersion !== listRequestVersion) return;
    if (!result.ok) {
      listError.value = result.message || "受控实验列表加载失败";
      return;
    }
    items.value = result.items;
    total.value = result.total;
    page.value = result.page;
    pageSize.value = result.pageSize;
    listLoaded.value = true;
  } catch (error) {
    if (isCancelledRequestError(error) || requestVersion !== listRequestVersion) return;
    listError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestVersion === listRequestVersion) listLoading.value = false;
  }
}

/** Applies table pagination and loads only the selected server page. */
function changePage(nextPage: number, nextPageSize: number): void {
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void loadList();
}

/** Opens and loads one exact experiment detail. */
async function openDetail(experimentId: string): Promise<void> {
  selectedExperimentId.value = experimentId;
  detail.value = detail.value?.id === experimentId ? detail.value : null;
  await loadDetail(experimentId);
}

/** Loads one detail with stale-result protection for selection changes and polling. */
async function loadDetail(experimentId: string, silent = false): Promise<void> {
  const requestVersion = ++detailRequestVersion;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  if (!silent) detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await getControlledExperiment(ctx.value, experimentId, controller.signal);
    if (requestVersion !== detailRequestVersion || selectedExperimentId.value !== experimentId) return;
    if (!result.ok) {
      detailError.value = result.message || "受控实验详情加载失败";
      return;
    }
    detail.value = result;
    updateListSummary(result);
  } catch (error) {
    if (isCancelledRequestError(error) || requestVersion !== detailRequestVersion) return;
    detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestVersion === detailRequestVersion) detailLoading.value = false;
  }
}

/** Closes the detail drawer and cancels its in-flight read. */
function closeDetail(): void {
  selectedExperimentId.value = "";
  detail.value = null;
  detailError.value = "";
  detailController?.abort();
  stopDetailPoll();
}

/** Executes one legal state command and refreshes only controlled-experiment state. */
async function executeAction(action: ControlAction): Promise<void> {
  const current = detail.value;
  if (!current || actionPending.value) return;
  actionPending.value = action;
  actionError.value = "";
  try {
    const result = action === "freeze"
      ? await freezeControlledExperiment(ctx.value, current.id)
      : action === "start"
        ? await startControlledExperiment(ctx.value, current.id)
        : await cancelControlledExperiment(ctx.value, current.id);
    if (!result.ok) {
      actionError.value = result.message || "受控实验操作失败";
      message.error(actionError.value);
      return;
    }
    detail.value = result;
    updateListSummary(result);
    await loadList();
    message.success(action === "freeze" ? "实验已冻结" : action === "start" ? "实验已启动" : "已请求取消实验");
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
    message.error(actionError.value);
  } finally {
    actionPending.value = null;
    scheduleDetailPoll();
  }
}

/** Opens a new create session and resolves current workspaces before model loading. */
async function openCreate(): Promise<void> {
  Object.assign(draft, newDraft());
  createError.value = "";
  createOpen.value = true;
  if (!workspaces.workspaces.length) {
    try {
      await workspaces.refresh(ctx.value);
    } catch (error) {
      createError.value = error instanceof Error ? error.message : String(error);
      return;
    }
  }
  const preferredWorkspaceId = workspaceOptions.value.some((item) => item.value === String(config.workspaceId ?? "") && !item.disabled)
    ? String(config.workspaceId)
    : workspaceOptions.value.find((item) => !item.disabled)?.value ?? "";
  draft.workspaceId = preferredWorkspaceId;
  draft.evaluationSetId = benchmarkOptions.value[0]?.value ?? "";
  await loadEngineCatalog(preferredWorkspaceId);
}

/** Loads the selected workspace's real engine/model catalog and selects valid defaults. */
async function loadEngineCatalog(workspaceId: string): Promise<void> {
  const requestVersion = ++engineRequestVersion;
  engineController?.abort();
  engineStatuses.value = [];
  engineError.value = "";
  draft.model = "";
  draft.effort = null;
  if (!workspaceId) return;
  const controller = new AbortController();
  engineController = controller;
  engineLoading.value = true;
  try {
    const result = await getEnginesStatus(ctx.value, workspaceId, { signal: controller.signal });
    if (requestVersion !== engineRequestVersion) return;
    if (!result.ok) {
      engineError.value = result.message || "引擎模型目录加载失败";
      return;
    }
    engineStatuses.value = result.engines;
    const preferred = result.engines.find((item) => item.engineType === draft.engine && item.installed && !item.error)
      ?? result.engines.find((item) => item.installed && !item.error)
      ?? null;
    if (!preferred) {
      engineError.value = "该工作区没有可用的受控实验引擎";
      return;
    }
    draft.engine = preferred.engineType;
    selectEngineDefaults();
  } catch (error) {
    if (isCancelledRequestError(error) || requestVersion !== engineRequestVersion) return;
    engineError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestVersion === engineRequestVersion) engineLoading.value = false;
  }
}

/** Applies the selected engine's default model and reasoning effort. */
function selectEngineDefaults(): void {
  const status = currentEngineStatus.value;
  const model = status?.models.find((item) => item.isDefault) ?? status?.models[0] ?? null;
  draft.model = model?.id ?? "";
  draft.effort = model?.defaultReasoningEffort ?? null;
}

/** Applies the selected model's default reasoning effort. */
function selectModelDefaultEffort(): void {
  draft.effort = currentModel.value?.defaultReasoningEffort ?? null;
}

/** Validates and submits one create request while retaining its key across ambiguous failures. */
async function submitCreate(): Promise<void> {
  createError.value = "";
  const input = buildCreateRequest();
  if (!input) return;
  createSaving.value = true;
  try {
    const result = await createControlledExperiment(ctx.value, input);
    if (!result.ok) {
      createError.value = result.message || "受控实验创建失败";
      return;
    }
    createOpen.value = false;
    page.value = 1;
    detail.value = result;
    selectedExperimentId.value = result.id;
    await loadList();
    message.success("受控实验草稿已创建");
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error);
  } finally {
    createSaving.value = false;
  }
}

/** Converts user-facing timeout units into the shared create contract. */
function buildCreateRequest(): ControlledExperimentCreateRequest | null {
  const name = draft.name.trim();
  const model = draft.model.trim();
  const perRunTimeoutMs = Math.round(Number(draft.perRunTimeoutSeconds) * 1_000);
  const experimentDeadlineMs = Math.round(Number(draft.experimentDeadlineMinutes) * 60_000);
  const maxTotalTokens = Math.round(Number(draft.maxTotalTokens));
  if (!name || !draft.workspaceId || !draft.evaluationSetId || !model) {
    createError.value = "实验名称、工作区、基准评估集和候选模型不能为空";
    return null;
  }
  if (!Number.isSafeInteger(perRunTimeoutMs) || perRunTimeoutMs < 60_000 || perRunTimeoutMs > 3_600_000
    || !Number.isSafeInteger(experimentDeadlineMs) || experimentDeadlineMs < perRunTimeoutMs || experimentDeadlineMs > 86_400_000
    || !Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) {
    createError.value = "请检查单次超时、实验时限和 Token 预算";
    return null;
  }
  return {
    name,
    workspaceId: draft.workspaceId,
    evaluationSetId: draft.evaluationSetId,
    candidate: { engine: draft.engine, model, effort: draft.effort || null },
    budget: { perRunTimeoutMs, experimentDeadlineMs, maxTotalTokens },
    idempotencyKey: draft.idempotencyKey,
  };
}

/** Replaces one visible list summary with the latest detail projection. */
function updateListSummary(value: ControlledExperimentDetail): void {
  const index = items.value.findIndex((item) => item.id === value.id);
  if (index >= 0) items.value.splice(index, 1, value);
}

/** Schedules the next active detail poll and keeps only one timer. */
function scheduleDetailPoll(): void {
  stopDetailPoll();
  const current = detail.value;
  if (!props.active || !current || (current.status !== "running" && current.status !== "cancel_requested")) return;
  detailPollTimer = setTimeout(async () => {
    if (!props.active || selectedExperimentId.value !== current.id) return;
    await loadDetail(current.id, true);
    scheduleDetailPoll();
  }, 5_000);
}

/** Stops detail polling when the subview is hidden or disposed. */
function stopDetailPoll(): void {
  if (detailPollTimer) clearTimeout(detailPollTimer);
  detailPollTimer = null;
}

/** Selects only the latest Attempt for each Assignment/Variant identity. */
function latestAttemptRuns(runs: ControlledExperimentRun[]): ControlledExperimentRun[] {
  const latest = new Map<string, ControlledExperimentRun>();
  for (const run of runs) {
    const key = `${run.assignmentId}\u001f${run.variantId}`;
    const current = latest.get(key);
    if (!current || run.attemptNo > current.attemptNo) latest.set(key, run);
  }
  return [...latest.values()].sort((left, right) => left.sampleId.localeCompare(right.sampleId)
    || left.variantKey.localeCompare(right.variantKey));
}

/** Maps finite experiment state to concise Chinese UI text. */
function statusLabel(status: ControlledExperimentStatus): string {
  return ({ draft: "草稿", ready: "待启动", running: "运行中", cancel_requested: "取消中",
    completed: "已完成", cancelled: "已取消", failed: "失败" } as const)[status];
}

/** Maps experiment state to an Ant tag color. */
function statusColor(status: ControlledExperimentStatus): string {
  return ({ draft: "default", ready: "blue", running: "processing", cancel_requested: "warning",
    completed: "success", cancelled: "default", failed: "error" } as const)[status];
}

/** Maps a Run state to concise Chinese UI text. */
function runStatusLabel(status: ControlledExperimentRun["status"]): string {
  return ({ queued: "排队", dispatched: "已派发", running: "运行中", cancel_requested: "取消中",
    succeeded: "成功", failed: "失败", timed_out: "超时", cancelled: "已取消" } as const)[status];
}

/** Formats one exact zh-CN minute timestamp. */
function formatDateTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** Shortens stable evidence identifiers for dense tables. */
function shortId(value: string | null): string {
  const text = String(value ?? "");
  return text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-6)}` : text || "—";
}

/** Resolves a local workspace title without hiding an unknown stable identity. */
function workspaceLabel(workspaceId: string): string {
  return workspaceOptions.value.find((item) => item.value === workspaceId)?.label || workspaceId;
}

/** Resolves a benchmark label while keeping unknown IDs compact. */
function benchmarkLabel(evaluationSetId: string): string {
  return benchmarkOptions.value.find((item) => item.value === evaluationSetId)?.label || shortId(evaluationSetId);
}

watch(() => props.active, (active) => {
  if (active) {
    if (!listLoaded.value && !listLoading.value) void loadList();
    scheduleDetailPoll();
    return;
  }
  listController?.abort();
  detailController?.abort();
  stopDetailPoll();
});
watch(() => detail.value?.status, () => scheduleDetailPoll());

onMounted(() => {
  if (props.active) void loadList();
});

onBeforeUnmount(() => {
  listController?.abort();
  detailController?.abort();
  engineController?.abort();
  stopDetailPoll();
});
</script>

<template>
  <div class="controlled-experiments">
    <div class="controlled-experiments__toolbar">
      <div>
        <strong>受控实验</strong>
        <span>{{ total }} 个实验</span>
      </div>
      <div class="controlled-experiments__actions">
        <a-button aria-label="刷新受控实验" :loading="listLoading" @click="loadList">
          <template #icon><ReloadOutlined /></template>
        </a-button>
        <a-button type="primary" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          新建实验
        </a-button>
      </div>
    </div>

    <a-alert v-if="listError" type="error" show-icon :message="listError" />
    <a-table
      row-key="id"
      size="small"
      :data-source="items"
      :loading="listLoading && !listLoaded"
      :pagination="false"
      :scroll="{ x: 980, y: 360 }"
      :locale="{ emptyText: '暂无受控实验' }"
    >
      <a-table-column title="实验" :width="220">
        <template #default="{ record }">
          <strong>{{ record.name }}</strong><br />
          <small>{{ workspaceOptions.find((item) => item.value === record.workspaceId)?.label || shortId(record.workspaceId) }}</small>
        </template>
      </a-table-column>
      <a-table-column title="配对进度" :width="130">
        <template #default="{ record }">{{ record.completedPairCount }} / {{ record.sampleCount }}</template>
      </a-table-column>
      <a-table-column title="状态" :width="110">
        <template #default="{ record }"><a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag></template>
      </a-table-column>
      <a-table-column title="Token 用量" :width="180">
        <template #default="{ record }">
          {{ record.totalTokens == null ? (record.usageAccountingStatus === 'pending' ? '待对账' : '—') : record.totalTokens.toLocaleString('zh-CN') }}
        </template>
      </a-table-column>
      <a-table-column title="更新时间" :width="160">
        <template #default="{ record }">{{ formatDateTime(record.updatedAt) }}</template>
      </a-table-column>
      <a-table-column title="操作" fixed="right" :width="88">
        <template #default="{ record }">
          <a-button type="link" size="small" :aria-label="`查看实验 ${record.name}`" @click="openDetail(record.id)">
            <template #icon><EyeOutlined /></template>
            查看
          </a-button>
        </template>
      </a-table-column>
    </a-table>
    <div v-if="total > 0" class="controlled-experiments__pagination">
      <span>{{ items.length }} / {{ total }}</span>
      <a-pagination
        :current="page"
        :page-size="pageSize"
        :total="total"
        size="small"
        show-size-changer
        :page-size-options="['10', '20', '50']"
        @change="changePage"
        @show-size-change="changePage"
      />
    </div>

    <a-drawer
      :open="Boolean(selectedExperimentId)"
      title="受控实验详情"
      width="min(920px, 96vw)"
      destroy-on-close
      @close="closeDetail"
    >
      <a-skeleton v-if="detailLoading && !detail" active :paragraph="{ rows: 8 }" />
      <a-alert v-if="detailError" type="error" show-icon :message="detailError" />
      <template v-if="detail">
        <div class="controlled-experiments__detail-head">
          <div><h3>{{ detail.name }}</h3><a-tag :color="statusColor(detail.status)">{{ statusLabel(detail.status) }}</a-tag></div>
          <div class="controlled-experiments__actions">
            <a-button v-if="detail.status === 'draft'" :loading="actionPending === 'freeze'" :disabled="Boolean(actionPending)" @click="executeAction('freeze')">
              <template #icon><LockOutlined /></template>冻结
            </a-button>
            <a-button v-if="detail.status === 'ready'" type="primary" :loading="actionPending === 'start'" :disabled="Boolean(actionPending)" @click="executeAction('start')">
              <template #icon><PlayCircleOutlined /></template>启动
            </a-button>
            <a-popconfirm v-if="!isControlledExperimentTerminal(detail.status) && detail.status !== 'cancel_requested'" title="确认取消该实验？" @confirm="executeAction('cancel')">
              <a-button danger :loading="actionPending === 'cancel'" :disabled="Boolean(actionPending)">
                <template #icon><StopOutlined /></template>取消
              </a-button>
            </a-popconfirm>
          </div>
        </div>
        <a-alert v-if="actionError" type="error" show-icon :message="actionError" />
        <a-alert v-if="detail.failureCode" type="error" show-icon :message="`失败码：${detail.failureCode}`" />
        <a-descriptions size="small" bordered :column="2" class="controlled-experiments__descriptions">
          <a-descriptions-item label="工作区">{{ workspaceLabel(detail.workspaceId) }}</a-descriptions-item>
          <a-descriptions-item label="基准评估集">{{ benchmarkLabel(detail.evaluationSetId) }}</a-descriptions-item>
          <a-descriptions-item label="配对进度">{{ detail.completedPairCount }} / {{ detail.sampleCount }}</a-descriptions-item>
          <a-descriptions-item label="Run 进度">{{ latestRuns.filter((run) => run.status === 'succeeded').length }} / {{ detail.sampleCount * 2 }}</a-descriptions-item>
          <a-descriptions-item label="Token 用量">{{ detail.totalTokens == null ? (detail.usageAccountingStatus === 'pending' ? '待对账' : '—') : detail.totalTokens.toLocaleString('zh-CN') }}</a-descriptions-item>
          <a-descriptions-item label="Token 上限">{{ detail.budget.maxTotalTokens.toLocaleString('zh-CN') }}</a-descriptions-item>
          <a-descriptions-item label="单次超时">{{ Math.round(detail.budget.perRunTimeoutMs / 1000) }} 秒</a-descriptions-item>
          <a-descriptions-item label="实验时限">{{ Math.round(detail.budget.experimentDeadlineMs / 60000) }} 分钟</a-descriptions-item>
        </a-descriptions>

        <h4>冻结 Variant</h4>
        <a-table row-key="id" size="small" :data-source="detail.variants" :pagination="false" :scroll="{ x: 720 }" :locale="{ emptyText: '尚未冻结 Variant' }">
          <a-table-column title="Variant" data-index="variantKey" :width="110" />
          <a-table-column title="引擎 / 模型" :width="240"><template #default="{ record }">{{ record.engine }} / {{ record.model }}</template></a-table-column>
          <a-table-column title="推理强度" :width="110"><template #default="{ record }">{{ record.effort || '默认' }}</template></a-table-column>
          <a-table-column title="配置摘要" :width="170"><template #default="{ record }">{{ shortId(record.configSha256) }}</template></a-table-column>
        </a-table>

        <h4>最新 Attempt</h4>
        <a-table row-key="id" size="small" :data-source="latestRuns" :pagination="false" :scroll="{ x: 900, y: 300 }" :locale="{ emptyText: '暂无执行 Attempt' }">
          <a-table-column title="样本" :width="150"><template #default="{ record }">{{ shortId(record.sampleId) }}</template></a-table-column>
          <a-table-column title="Variant" data-index="variantKey" :width="100" />
          <a-table-column title="Attempt" data-index="attemptNo" :width="82" />
          <a-table-column title="状态" :width="100"><template #default="{ record }">{{ runStatusLabel(record.status) }}</template></a-table-column>
          <a-table-column title="Token" :width="130">
            <template #default="{ record }">{{ record.totalTokens ?? (record.usageAccountingStatus === 'pending' ? '待对账' : '—') }}</template>
          </a-table-column>
          <a-table-column title="错误码" :width="180"><template #default="{ record }">{{ record.errorCode || '—' }}</template></a-table-column>
        </a-table>
      </template>
    </a-drawer>

    <a-modal
      v-model:open="createOpen"
      title="新建受控实验"
      :confirm-loading="createSaving"
      :ok-button-props="{ disabled: !canSubmitCreate }"
      ok-text="创建草稿"
      @ok="submitCreate"
    >
      <a-alert v-if="createError" type="error" show-icon :message="createError" class="controlled-experiments__form-alert" />
      <a-alert v-if="props.evaluationSetsError" type="error" show-icon :message="props.evaluationSetsError" class="controlled-experiments__form-alert" />
      <a-form layout="vertical">
        <a-form-item label="实验名称" required><a-input v-model:value="draft.name" :maxlength="80" /></a-form-item>
        <a-form-item label="工作区" required>
          <a-select v-model:value="draft.workspaceId" :options="workspaceOptions" show-search option-filter-prop="label" @change="loadEngineCatalog" />
        </a-form-item>
        <a-form-item label="基准评估集" required>
          <a-select v-model:value="draft.evaluationSetId" :options="benchmarkOptions" :loading="props.evaluationSetsLoading" show-search option-filter-prop="label" />
        </a-form-item>
        <div class="controlled-experiments__form-grid">
          <a-form-item label="候选引擎" required>
            <a-select v-model:value="draft.engine" :options="engineOptions" :loading="engineLoading" @change="selectEngineDefaults" />
          </a-form-item>
          <a-form-item label="候选模型" required>
            <a-select v-model:value="draft.model" :options="modelOptions" :loading="engineLoading" show-search option-filter-prop="label" @change="selectModelDefaultEffort" />
          </a-form-item>
          <a-form-item label="推理强度">
            <a-select v-model:value="draft.effort" :options="effortOptions" allow-clear placeholder="默认" />
          </a-form-item>
        </div>
        <a-alert v-if="engineError" type="error" show-icon :message="engineError" class="controlled-experiments__form-alert" />
        <div class="controlled-experiments__budget-grid">
          <a-form-item label="单次超时（秒）" required><a-input-number v-model:value="draft.perRunTimeoutSeconds" :min="60" :max="3600" /></a-form-item>
          <a-form-item label="实验时限（分钟）" required><a-input-number v-model:value="draft.experimentDeadlineMinutes" :min="1" :max="1440" /></a-form-item>
          <a-form-item label="Token 上限" required><a-input-number v-model:value="draft.maxTotalTokens" :min="1" :max="1000000000" /></a-form-item>
        </div>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.controlled-experiments { display: grid; gap: 12px; min-width: 0; }
.controlled-experiments__toolbar,
.controlled-experiments__detail-head,
.controlled-experiments__pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.controlled-experiments__toolbar > div:first-child { display: flex; align-items: baseline; gap: 10px; }
.controlled-experiments__toolbar span,
.controlled-experiments small,
.controlled-experiments__pagination > span { color: var(--app-muted); font-size: 12px; }
.controlled-experiments__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.controlled-experiments__detail-head h3 { display: inline; margin: 0 8px 0 0; font-size: 18px; }
.controlled-experiments__descriptions { margin: 14px 0; }
.controlled-experiments h4 { margin: 18px 0 8px; font-size: 14px; }
.controlled-experiments__form-grid { display: grid; grid-template-columns: 120px minmax(0, 1fr) 150px; gap: 10px; }
.controlled-experiments__budget-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 10px; }
.controlled-experiments__budget-grid :deep(.ant-input-number) { width: 100%; }
.controlled-experiments__form-alert { margin-bottom: 12px; }

@media (max-width: 767px) {
  .controlled-experiments__toolbar,
  .controlled-experiments__detail-head,
  .controlled-experiments__pagination { align-items: stretch; flex-direction: column; }
  .controlled-experiments__actions { justify-content: flex-start; }
  .controlled-experiments__form-grid,
  .controlled-experiments__budget-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
