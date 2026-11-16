<script setup lang="ts">
import { computed, nextTick, onActivated, onUnmounted, reactive, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import type {
  OrchestrationStatus,
  ApiResult,
  DesktopAccountScheduledTaskConfig,
  DesktopAccountScheduledTaskEdit,
  DesktopAccountScheduledTaskRun,
  LocalScheduledTaskConfig,
  LocalScheduledTaskRun,
  ScheduledTask,
  ScheduledTaskDeviceAssets,
  ScheduledTaskDeviceOption,
  ScheduledTaskRun,
  ScheduledTaskScriptPayload,
  ScheduledTaskType,
  ScheduledTaskWorkflowPayload,
} from "@codeflowai/shared";
import {
  SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES,
  SCHEDULED_TASK_WORKFLOW_STATUSES,
  SCHEDULED_TASK_WORKFLOW_STRICT_SKIP_STATUSES,
  normalizeScheduledTaskWorkflowSkipStatuses,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import * as scheduledTaskApi from "../../../api/scheduled-tasks";
import { listWorkspaces } from "../../../api/workspaces";
import { listOrchWorkflows } from "../../../api/orchestration";
import { getDesktopBridge, isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { captureAccountSession } from "../../../store/account";
import { createApiResultError, createCancelledRequestError, isApiResultError, isCancelledRequestError } from "../../../api/request";

defineOptions({ name: "AdminScheduledTasksPanel" });
const props = withDefaults(defineProps<{ source?: "account" | "local" | "desktop-account"; active?: boolean }>(), { source: "account", active: true });
type DesktopAccountTask = ScheduledTask & Omit<DesktopAccountScheduledTaskConfig, "task">;
type Task = ScheduledTask | LocalScheduledTaskConfig | DesktopAccountTask;
type Run = ScheduledTaskRun | LocalScheduledTaskRun | DesktopAccountScheduledTaskRun;

const DEFAULT_TIMEOUT_MINUTES = 120;

type TaskFormState = {
  id: string;
  clientId: string;
  deviceId: string;
  name: string;
  description: string;
  taskType: ScheduledTaskType;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  timeoutMinutes: number;
  workflowWorkspaceId: string;
  workflowId: string;
  workflowSkipPreset: WorkflowSkipPreset;
  workflowSkipStatuses: OrchestrationStatus[];
  scriptShell: ScheduledTaskScriptPayload["shell"];
  scriptCommand: string;
  scriptWorkspaceId: string;
  scriptCwdRelative: string;
  scriptEnvRefs: string;
};

type WorkflowSkipPreset = "default" | "strict" | "none" | "custom";

const { ctx } = useApiContext();
const config = useConfigStore();
const isLocal = computed(() => props.source === "local");
const isDesktopAccount = computed(() => props.source === "desktop-account");
const isOnDevice = computed(() => isLocal.value || isDesktopAccount.value);
const desktopDevice = ref<{ clientId: string; deviceId: string } | null>(null);
let readVersion = 0;
// 只区分面板寿命，允许本次认证清理继续报告；账号归属仍由原 owner 判断。
let viewVersion = 0;
let taskReadVersion = 0;
let assetVersion = 0;
let workflowVersion = 0;
let previewVersion = 0;
let runsVersion = 0;
let deleteConfirmation: ReturnType<typeof Modal.confirm> | null = null;
const panelError = ref("");
const formError = ref("");
const runsError = ref("");
const editingTask = ref<Task | null>(null);
const togglingTaskId = ref("");
const taskPage = ref(1);
const taskPageSize = ref(20);
const taskTotal = ref(0);
const runsPage = ref(1);
const runsTotal = ref(0);
const runsPageSize = 20;
// 工作区在本机/账号任务创建后固定，空归属也不允许编辑时重新绑定。
const boundWorkspace = computed(() => editingTask.value ? "workspaceScope" in editingTask.value
  ? editingTask.value.workspaceScope?.scopeId : editingTask.value.payload.contextWorkspaceId ?? undefined : undefined);
const workspaceEditing = computed(() => Boolean(editingTask.value));
const loading = ref(false);
const saving = ref(false);
const devicesLoading = ref(false);
const assetsLoading = ref(false);
const runsLoading = ref(false);
const formModalOpen = ref(false);
/** 页面主视图：定时任务与运行记录共用同一工具栏和高度链。 */
const activeView = ref<"tasks" | "runs">("tasks");
const previewLoading = ref(false);
const tasks = ref<Task[]>([]);
const devices = ref<ScheduledTaskDeviceOption[]>([]);
const assets = ref<Pick<ScheduledTaskDeviceAssets, "workspaces" | "workflows"> | null>(null);
const runs = ref<Run[]>([]);
const selectedRunsTask = ref<Task | null>(null);
const cronPreview = ref<number[]>([]);

const form = reactive<TaskFormState>({
  id: "",
  clientId: "",
  deviceId: "",
  name: "",
  description: "",
  taskType: "workflow",
  cronExpr: "0 9 * * *",
  timezone: "Asia/Shanghai",
  enabled: true,
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  workflowWorkspaceId: "",
  workflowId: "",
  workflowSkipPreset: "default",
  workflowSkipStatuses: [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES],
  scriptShell: "powershell",
  scriptCommand: "",
  scriptWorkspaceId: "",
  scriptCwdRelative: ".",
  scriptEnvRefs: "",
});

const workflowSkipPresetOptions = [
  { value: "default", label: "默认：跳过 pending/running/paused/waiting-*" },
  { value: "strict", label: "严格：默认 + failed/cancelled" },
  { value: "none", label: "不限制：每次到点都启动" },
  { value: "custom", label: "自定义：自己选择跳过状态" },
] satisfies Array<{ value: WorkflowSkipPreset; label: string }>;

const workflowStatusOptions = SCHEDULED_TASK_WORKFLOW_STATUSES.map((status) => ({
  value: status,
  label: `${workflowStatusLabel(status)} ${status}`,
}));

const workflowSkipStatusValues = computed({
  get: () => form.workflowSkipStatuses,
  set: (value: unknown[]) => {
    form.workflowSkipStatuses = normalizeScheduledTaskWorkflowSkipStatuses(value);
  },
});

/** 当前流程状态策略的说明文案，随预设切换展示对应规则。 */
const workflowSkipPresetDescription = computed(() => {
  if (form.workflowSkipPreset === "default") {
    return "默认策略：上一轮处于 pending / running / paused / waiting-* 时，本次自动调度跳过；completed、failed、cancelled 会继续调度。适合避免未结束流程重复启动。";
  }
  if (form.workflowSkipPreset === "strict") {
    return "严格策略：在默认基础上，failed、cancelled 也会跳过；completed 仍会继续调度。适合失败或取消后必须人工处理再恢复的任务。";
  }
  if (form.workflowSkipPreset === "none") {
    return "不限制：不检查上一轮流程状态，每次 cron 到点都尝试启动新流程。适合允许多轮流程并行执行的任务。";
  }
  return "自定义策略：只跳过下方勾选的状态；未勾选状态会继续调度。手动运行不受限制，但会更新上一轮实例记录。";
});

const taskColumns = computed(() => [
  { title: "任务名称", dataIndex: "name", key: "name", width: 240 },
  { title: "类型", dataIndex: "taskType", key: "taskType", width: 96, align: "center" },
  { title: "Cron", dataIndex: "cronExpr", key: "cronExpr", width: 150 },
  { title: "状态", dataIndex: "enabled", key: "enabled", width: 90, align: "center" },
  ...(isLocal.value ? [] : [
    { title: "下次运行", dataIndex: "nextRunAt", key: "nextRunAt", width: 180 },
    { title: "最近结果", dataIndex: "lastStatus", key: "lastStatus", width: 120, align: "center" },
  ]),
  { title: "操作", key: "actions", width: 230, align: "center" },
]);

const runColumns = computed(() => [
  ...(isOnDevice.value ? [{ title: isLocal.value ? "任务 / 修订" : "任务", key: "taskSnapshot", width: 170 }] : []),
  { title: "触发时间", dataIndex: "scheduledAt", key: "scheduledAt", width: 170 },
  { title: "状态", dataIndex: "status", key: "status", width: 100 },
  { title: "耗时", dataIndex: "durationMs", key: "durationMs", width: 120 },
  { title: "摘要", dataIndex: "summary", key: "summary" },
]);

const deviceSelectValue = computed({
  get: () => (form.clientId && form.deviceId ? `${form.clientId}::${form.deviceId}` : ""),
  set: (value: string) => {
    const [clientId = "", deviceId = ""] = value.split("::");
    const changed = clientId !== form.clientId || deviceId !== form.deviceId;
    if (changed) {
      resetDeviceAssetFields();
    }
    form.clientId = clientId;
    form.deviceId = deviceId;
    if (changed && form.clientId && form.deviceId) void loadAssets();
  },
});

const deviceOptions = computed(() =>
  devices.value.map((device) => ({
    value: `${device.clientId}::${device.deviceId}`,
    label: `${device.clientName} / ${device.platform ?? "-"} ${device.arch ?? ""}`,
  })),
);

const workspaceOptions = computed(() =>
  (assets.value?.workspaces ?? []).map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.title || workspace.workspaceId,
  })),
);

const workflowOptions = computed(() =>
  (assets.value?.workflows ?? [])
    .filter((workflow) => !form.workflowWorkspaceId || workflow.workspaceId === form.workflowWorkspaceId)
    .map((workflow) => ({
      value: workflow.workflowId,
      label: `${workflow.workflowName || workflow.workflowId} v${workflow.workflowVersion}`,
    })),
);

// 账号变化同步失效旧视图；本机任务不依赖云端认证。
watch([() => props.active, () => props.source,
  () => isLocal.value ? null : config.authMode,
  () => isLocal.value ? null : config.serverWsOrigin,
  () => isLocal.value ? null : config.userSummary?.userId,
  () => isLocal.value ? null : config.sessionToken,
] as const, async ([active, source], [previousActive, previousSource]) => {
  if (active !== previousActive || source !== previousSource) viewVersion++;
  readVersion++;
  taskReadVersion++;
  runsVersion++;
  loading.value = false;
  assetsLoading.value = false;
  devicesLoading.value = false;
  previewLoading.value = false;
  devices.value = [];
  desktopDevice.value = null;
  runsLoading.value = false;
  formModalOpen.value = false;
  activeView.value = "tasks";
  resetForm();
  runs.value = [];
  selectedRunsTask.value = null;
  runsPage.value = 1;
  runsTotal.value = 0;
  runsError.value = "";
  deleteConfirmation?.destroy();
  deleteConfirmation = null;
  saving.value = false;
  togglingTaskId.value = "";
  tasks.value = [];
  taskPage.value = 1;
  taskTotal.value = 0;
  panelError.value = "";
  const version = readVersion;
  // 认证动作会连续更新多个字段，仅在本轮配置稳定后读取一次。
  await nextTick();
  if (active && version === readVersion && (isLocal.value || (config.authMode === "account" && config.sessionToken && config.userSummary))) {
    void loadTasks();
    if (!isOnDevice.value) void loadDevices();
  }
}, { immediate: true, flush: "sync" });

/** 保活面板重新激活时静默刷新一次列表，避免切换菜单后任务数据过期。 */
onActivated(() => {
  if (!props.active || !tasks.value.length) return;
  void loadTasks(false, true);
});

onUnmounted(() => {
  viewVersion++;
  readVersion++; taskReadVersion++; assetVersion++; workflowVersion++; previewVersion++; runsVersion++;
  deleteConfirmation?.destroy();
});

// 只有工作流表单读取流程；脚本编辑回填固定工作区不触发无关读取。
watch([() => form.workflowWorkspaceId, () => form.taskType], () => {
  if (form.taskType !== "workflow") return;
  if (isOnDevice.value) {
    if (formModalOpen.value) void loadLocalWorkflows();
  } else ensureWorkflowSelectionValid();
});

watch(() => form.taskType, (taskType, previousType) => {
  if (taskType === "workflow" && previousType === "script" && !editingTask.value) resetWorkflowSkipPresetToDefault();
  if (boundWorkspace.value) {
    form.workflowWorkspaceId = boundWorkspace.value;
    form.scriptWorkspaceId = boundWorkspace.value;
  }
});

watch(() => form.workflowSkipPreset, (preset) => {
  applyWorkflowSkipPreset(preset);
});

watch(formModalOpen, (open) => {
  if (!open) { assetVersion++; workflowVersion++; previewVersion++; previewLoading.value = false; }
});

/** 读取在线设备列表。 */
async function loadDevices(): Promise<void> {
  if (!props.active || isOnDevice.value) return;
  const owner = captureTaskSession();
  const diagnostic = captureFailureContext();
  const version = readVersion;
  devicesLoading.value = true;
  try {
    const result = await scheduledTaskApi.listScheduledTaskDevices(owner.requestContext);
    assertResult(result);
    if (!props.active || version !== readVersion) return;
    devices.value = result.devices;
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "devices")) return;
    if (props.active && version === readVersion) panelError.value = describeFailure(error, "devices", undefined, diagnostic);
  } finally {
    if (version === readVersion) devicesLoading.value = false;
  }
}

/** 本机/管理页沿原分页；桌面账号快照在视图分页，明确刷新才重新同步。 */
async function loadTasks(sync = false, silent = false): Promise<void> {
  if (!props.active) return;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext();
  const version = ++taskReadVersion;
  const pagination = { limit: taskPageSize.value, offset: (taskPage.value - 1) * taskPageSize.value };
  panelError.value = "";
  // 保活面板重新激活时保留已展示列表，仅在无数据时显示加载态。
  if (!silent || !tasks.value.length) loading.value = true;
  try {
    if (isDesktopAccount.value) {
      const result = sync ? await scheduledTaskApi.syncDesktopAccountScheduledTasks() : await scheduledTaskApi.listDesktopAccountScheduledTasks();
      assertResult(result);
      if (!props.active || version !== taskReadVersion) return;
      desktopDevice.value = { clientId: result.clientId, deviceId: result.deviceId };
      taskTotal.value = result.items.length;
      taskPage.value = Math.min(taskPage.value, Math.max(1, Math.ceil(taskTotal.value / taskPageSize.value)));
      const offset = (taskPage.value - 1) * taskPageSize.value;
      tasks.value = result.items.slice(offset, offset + taskPageSize.value).map(({ task, ...revision }) => ({ ...task, ...revision }));
      return;
    }
    const result = isLocal.value ? await scheduledTaskApi.listLocalScheduledTasks(pagination)
      : await scheduledTaskApi.listScheduledTasks(owner!.requestContext, pagination);
    assertResult(result);
    if (!props.active || version !== taskReadVersion) return;
    const lastPage = Math.max(1, Math.ceil(result.total / taskPageSize.value));
    if (taskPage.value > lastPage) {
      taskPage.value = lastPage;
      await loadTasks(false, silent);
      return;
    }
    tasks.value = result.items;
    taskTotal.value = result.total;
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "list")) return;
    if (props.active && version === taskReadVersion) panelError.value = describeFailure(error, "list", undefined, diagnostic);
  } finally {
    if (version === taskReadVersion) loading.value = false;
  }
}

/** 读取目标设备本地工作区和工作流资产。 */
async function loadAssets(): Promise<void> {
  if (!props.active) return;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext();
  const version = ++assetVersion;
  assetsLoading.value = true;
  assets.value = null;
  try {
    if (isOnDevice.value) {
      if (!getDesktopBridge()) throw new Error("DESKTOP_BRIDGE_REQUIRED");
      const result = await listWorkspaces(ctx.value);
      assertResult(result);
      if (!props.active || version !== assetVersion) return;
      assets.value = { workspaces: result.workspaces.filter((workspace) => isDesktopWorkspace(config, workspace.id))
        .map((workspace) => ({ workspaceId: workspace.id, title: workspace.title, path: workspace.path })), workflows: [] };
      if (form.taskType === "workflow" && form.workflowWorkspaceId) await loadLocalWorkflows();
      return;
    }
    const result = await scheduledTaskApi.getScheduledTaskDeviceAssets(owner!.requestContext, {
      clientId: form.clientId,
      deviceId: form.deviceId,
    });
    assertResult(result);
    if (!props.active || version !== assetVersion) return;
    assets.value = result;
    if (!form.workflowWorkspaceId && result.workspaces[0]) form.workflowWorkspaceId = result.workspaces[0].workspaceId;
    ensureWorkflowSelectionValid();
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "assets")) return;
    if (props.active && version === assetVersion) formError.value = describeFailure(error, "assets", undefined, diagnostic);
  } finally {
    if (version === assetVersion) assetsLoading.value = false;
  }
}

/** 从当前真实本机工作区读取执行流程；缺失选项保留编辑草稿。 */
async function loadLocalWorkflows(): Promise<void> {
  const diagnostic = captureFailureContext();
  const workspaceId = form.workflowWorkspaceId;
  const version = ++workflowVersion;
  if (assets.value) assets.value.workflows = [];
  if (!workspaceId || !props.active) { assetsLoading.value = false; return; }
  assetsLoading.value = true;
  try {
    if (!getDesktopBridge() || !isDesktopWorkspace(config, workspaceId)) throw new Error("DESKTOP_WORKSPACE_REQUIRED");
    const result = await listOrchWorkflows(ctx.value, workspaceId, "execution");
    assertResult(result);
    if (!props.active || version !== workflowVersion || workspaceId !== form.workflowWorkspaceId) return;
    if (assets.value) assets.value.workflows = result.workflows.map((workflow) => ({ workspaceId,
      workflowId: workflow.id, workflowName: workflow.name, workflowVersion: workflow.version }));
  } catch (error) {
    if (props.active && version === workflowVersion) formError.value = describeFailure(error, "workflows", undefined, diagnostic);
  } finally {
    if (version === workflowVersion) assetsLoading.value = false;
  }
}

/** 桌面账号只用可信Host设备；管理页预置默认设备，等待期间切源不打开草稿。 */
async function openCreateModal(): Promise<void> {
  const version = readVersion;
  resetForm();
  if (isDesktopAccount.value && !desktopDevice.value) await loadTasks();
  else if (!isOnDevice.value && !devices.value.length) await loadDevices();
  if (!props.active || version !== readVersion) return;
  if (isDesktopAccount.value && !desktopDevice.value) return;
  const first = isDesktopAccount.value ? desktopDevice.value : devices.value[0];
  if (first) {
    form.clientId = first.clientId;
    form.deviceId = first.deviceId;
  }
  formModalOpen.value = true;
  if (isOnDevice.value || (form.clientId && form.deviceId)) void loadAssets();
}

/** 打开编辑任务弹框并回填表单。 */
function openEditModal(task: Task): void {
  resetForm();
  editingTask.value = JSON.parse(JSON.stringify(task)) as Task;
  form.id = task.id;
  form.clientId = task.clientId;
  form.deviceId = task.deviceId;
  form.name = task.name;
  form.description = task.description ?? "";
  form.taskType = task.taskType;
  form.cronExpr = task.cronExpr;
  form.timezone = task.timezone;
  form.enabled = task.enabled;
  form.timeoutMinutes = Math.max(1, Math.round(task.timeoutMs / 60_000));
  if (task.taskType === "workflow") {
    const payload = task.payload as ScheduledTaskWorkflowPayload;
    form.workflowWorkspaceId = payload.contextWorkspaceId;
    form.workflowId = payload.workflowId;
    applyWorkflowSkipStatusesToForm(normalizeScheduledTaskWorkflowSkipStatuses(payload.skipWhenPreviousInstanceStatuses));
  } else {
    const payload = task.payload as ScheduledTaskScriptPayload;
    form.scriptShell = payload.shell;
    form.scriptCommand = payload.command;
    form.scriptWorkspaceId = payload.contextWorkspaceId ?? "";
    form.scriptCwdRelative = payload.cwdRelative ?? ".";
    form.scriptEnvRefs = (payload.envRefs ?? []).join("\n");
  }
  formModalOpen.value = true;
  if (boundWorkspace.value) {
    form.workflowWorkspaceId = boundWorkspace.value;
    form.scriptWorkspaceId = boundWorkspace.value;
  }
  void loadAssets();
}

/** 重置任务表单到新建默认值。 */
function resetForm(): void {
  assetVersion++;
  workflowVersion++;
  previewVersion++;
  editingTask.value = null;
  formError.value = "";
  Object.assign(form, {
    id: "",
    clientId: "",
    deviceId: "",
    name: "",
    description: "",
    taskType: "workflow",
    cronExpr: "0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    workflowWorkspaceId: "",
    workflowId: "",
    workflowSkipPreset: "default",
    workflowSkipStatuses: [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES],
    scriptShell: "powershell",
    scriptCommand: "",
    scriptWorkspaceId: "",
    scriptCwdRelative: ".",
    scriptEnvRefs: "",
  });
  assets.value = null;
  cronPreview.value = [];
}

/** 清理设备资产选择；编辑时保留固定工作区，新建时清空归属。 */
function resetDeviceAssetFields(): void {
  form.workflowWorkspaceId = boundWorkspace.value ?? "";
  form.workflowId = "";
  form.scriptWorkspaceId = boundWorkspace.value ?? "";
  assets.value = null;
}

/** 重置工作流状态策略为默认预设，避免从脚本切回工作流时沿用无效状态。 */
function resetWorkflowSkipPresetToDefault(): void {
  form.workflowSkipPreset = "default";
  form.workflowSkipStatuses = [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES];
}

/** 资产已加载后校验工作流仍属于当前工作区。 */
function ensureWorkflowSelectionValid(): void {
  if (!assets.value || !form.workflowId) return;
  const matched = assets.value.workflows.some((workflow) =>
    workflow.workspaceId === form.workflowWorkspaceId && workflow.workflowId === form.workflowId,
  );
  if (!matched) form.workflowId = "";
}

/** 桌面编辑沿本地修订；新建提交Server后即结束创建，同步失败明确留在列表。 */
async function saveTask(): Promise<void> {
  if (saving.value) return;
  const version = readVersion;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext();
  let taskId = form.id;
  let created = false;
  const original = editingTask.value;
  formError.value = "";
  saving.value = true;
  try {
    const body = buildSaveBody();
    const { clientId: _clientId, deviceId: _deviceId, ...localBody } = body;
    const result = isLocal.value
      ? original && "revision" in original
        ? await scheduledTaskApi.updateLocalScheduledTask({ ...localBody, taskId: original.id, expectedRevision: original.revision })
        : await scheduledTaskApi.createLocalScheduledTask(localBody)
      : isDesktopAccount.value && original
      ? await scheduledTaskApi.updateDesktopAccountScheduledTask({ taskId: original.id,
        expectedLocalRevision: requireDesktopRevision(original), config: localBody })
      : form.id
      ? await scheduledTaskApi.updateScheduledTask(owner!.requestContext, form.id, body)
      : await scheduledTaskApi.createScheduledTask(owner!.requestContext, body);
    assertResult(result);
    if (!props.active || version !== readVersion) return;
    formModalOpen.value = false;
    if (isDesktopAccount.value && !original && "task" in result) {
      created = true;
      taskId = result.task.id;
      const synced = await scheduledTaskApi.syncDesktopAccountScheduledTasks();
      assertResult(synced);
      if (!props.active || version !== readVersion) return;
    }
    message.success("定时任务已保存");
    await loadTasks();
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "save", taskId)) return;
    if (props.active && version === readVersion) {
      const failure = describeFailure(error, created ? "createSync" : "save", taskId, diagnostic);
      if (created) panelError.value = `任务已创建，同步失败，请点击刷新重试：${failure}`;
      else {
        if (isDesktopAccount.value && original) await loadTasks();
        if (props.active && version === readVersion) formError.value = failure;
      }
    }
  } finally {
    if (version === readVersion) saving.value = false;
  }
}

/** 桌面账号写入只使用列表观察到的本地修订。 */
function requireDesktopRevision(task: Task): number {
  if (!("localRevision" in task)) throw new Error("任务修订不可用，请刷新后重新编辑");
  return task.localRevision;
}

/** 启停只提交原可编辑字段，排除身份与视图元数据。 */
function desktopEdit(task: Task, enabled: boolean): DesktopAccountScheduledTaskEdit {
  return { name: task.name, description: task.description, taskType: task.taskType, cronExpr: task.cronExpr,
    timezone: task.timezone, enabled, payload: task.payload, concurrencyPolicy: task.concurrencyPolicy,
    missedPolicy: task.missedPolicy, timeoutMs: task.timeoutMs };
}

/** 构造保存请求体；校验失败进入表单失败态且不派发写入。 */
function buildSaveBody() {
  if (workspaceEditing.value && ((form.taskType === "workflow" && (!boundWorkspace.value || form.workflowWorkspaceId !== boundWorkspace.value))
    || (form.taskType === "script" && (form.scriptWorkspaceId || undefined) !== boundWorkspace.value))) {
    throw new Error("任务工作区创建后不可更改，请新建任务");
  }
  if (!isLocal.value && (!form.clientId || !form.deviceId)) {
    throw new Error("请选择 Client 设备");
  }
  if (!form.name.trim()) {
    throw new Error("请输入任务名称");
  }
  const payload = form.taskType === "workflow"
    ? buildWorkflowPayload()
    : buildScriptPayload();
  return {
    clientId: form.clientId,
    deviceId: form.deviceId,
    name: form.name.trim(),
    description: form.description.trim() || null,
    taskType: form.taskType,
    cronExpr: form.cronExpr.trim(),
    timezone: form.timezone.trim() || "Asia/Shanghai",
    enabled: form.enabled,
    timeoutMs: editingTask.value && form.timeoutMinutes === Math.max(1, Math.round(editingTask.value.timeoutMs / 60_000))
      ? editingTask.value.timeoutMs : Math.max(1, form.timeoutMinutes) * 60_000,
    payload,
    concurrencyPolicy: editingTask.value?.concurrencyPolicy ?? "skip_if_running",
    missedPolicy: editingTask.value?.missedPolicy ?? "skip_missed",
  };
}

/** 构造工作流任务 payload。 */
function buildWorkflowPayload(): ScheduledTaskWorkflowPayload {
  if (!form.workflowWorkspaceId || !form.workflowId) {
    throw new Error("请选择工作区和工作流");
  }
  return {
    ...(editingTask.value?.taskType === "workflow" ? editingTask.value.payload as ScheduledTaskWorkflowPayload : {
      workflowVersionPolicy: "latest", intake: { goal: form.name.trim() }, runMode: "normal", approvalMode: "default",
    }),
    workflowId: form.workflowId as any,
    contextWorkspaceId: form.workflowWorkspaceId as any,
    skipWhenPreviousInstanceStatuses: [...form.workflowSkipStatuses],
  };
}

/** 构造脚本任务 payload。 */
function buildScriptPayload(): ScheduledTaskScriptPayload {
  if (!form.scriptCommand.trim()) {
    throw new Error("请输入脚本命令");
  }
  return {
    shell: form.scriptShell,
    command: form.scriptCommand.trim(),
    contextWorkspaceId: (form.scriptWorkspaceId || null) as any,
    cwdRelative: form.scriptCwdRelative.trim() || ".",
    envRefs: form.scriptEnvRefs.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
  };
}

/** 预览 cron 后续触发时间。 */
async function previewCron(): Promise<void> {
  const version = ++previewVersion;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext();
  const taskId = form.id;
  formError.value = "";
  previewLoading.value = true;
  try {
    const input = {
      cronExpr: form.cronExpr,
      timezone: form.timezone,
      count: 5,
    };
    const result = isOnDevice.value ? await scheduledTaskApi.previewLocalScheduledTaskCron(input)
      : await scheduledTaskApi.previewScheduledTaskCron(owner!.requestContext, input);
    assertResult(result);
    if (!props.active || !formModalOpen.value || version !== previewVersion) return;
    if (!result.valid) throw new Error(result.message || "cron 表达式无效");
    cronPreview.value = result.nextRunAts;
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "cronPreview", taskId)) return;
    if (props.active && formModalOpen.value && version === previewVersion) {
      formError.value = describeFailure(error, "cronPreview", taskId, diagnostic); cronPreview.value = [];
    }
  } finally {
    if (version === previewVersion) previewLoading.value = false;
  }
}

/** 手动运行任务。 */
async function runTaskNow(task: Task): Promise<void> {
  const version = readVersion;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext(task);
  try {
    const result = isLocal.value ? await scheduledTaskApi.runLocalScheduledTaskNow(task.id)
      : isDesktopAccount.value ? await scheduledTaskApi.runDesktopAccountScheduledTaskNow(task.id)
      : await scheduledTaskApi.runScheduledTaskNow(owner!.requestContext, task.id);
    assertResult(result);
    if (!props.active || version !== readVersion) return;
    if (result.run.status === "success") {
      message.success(task.taskType === "workflow" ? "已触发" : "执行成功");
    } else {
      message.warning(`手动运行结束：${formatStatus(result.run.status)}`);
    }
    await Promise.all([loadTasks(), openRunsView(task)]);
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "runNow", task.id)) return;
    if (props.active && version === readVersion) panelError.value = describeFailure(error, "runNow", task.id, diagnostic);
  }
}

/** 启停使用当前来源的观察修订，成功后重读当前页。 */
async function setTaskEnabled(task: Task, enabled: boolean): Promise<void> {
  if (!isOnDevice.value) return;
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext(task);
  const version = readVersion;
  togglingTaskId.value = task.id;
  panelError.value = "";
  try {
    const result = isDesktopAccount.value
      ? await scheduledTaskApi.updateDesktopAccountScheduledTask({ taskId: task.id, expectedLocalRevision: requireDesktopRevision(task), config: desktopEdit(task, enabled) })
      : await scheduledTaskApi.setLocalScheduledTaskEnabled({ taskId: task.id,
        expectedRevision: (task as LocalScheduledTaskConfig).revision, enabled });
    assertResult(result);
    if (!props.active || version !== readVersion) return;
    const updated = "item" in result ? { ...result.item.task, localRevision: result.item.localRevision,
      pending: result.item.pending, stopIntent: result.item.stopIntent } : result.task;
    tasks.value = tasks.value.map((item) => item.id === task.id ? updated : item);
    await loadTasks();
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "setEnabled", task.id)) return;
    const failure = describeFailure(error, "setEnabled", task.id, diagnostic);
    if (props.active && version === readVersion) {
      // 失败回执可能晚于本地耐久修订，只读对账，不重发写入或同步。
      if (isDesktopAccount.value) await loadTasks();
      if (props.active && version === readVersion) panelError.value = [failure, panelError.value].filter(Boolean).join("；");
    }
  } finally { if (version === readVersion) togglingTaskId.value = ""; }
}

/** 删除任务前二次确认。 */
function confirmDeleteTask(task: Task): void {
  const version = readVersion;
  const local = isLocal.value;
  const desktopAccount = isDesktopAccount.value;
  const owner = local ? null : captureTaskSession();
  const diagnostic = captureFailureContext(task);
  deleteConfirmation?.destroy();
  deleteConfirmation = Modal.confirm({
    title: "删除定时任务",
    content: `确认删除“${task.name}”？`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        if (!props.active || version !== readVersion) throw createCancelledRequestError("scope-change");
        const result: ApiResult<{ deleted: boolean; task?: LocalScheduledTaskConfig }> = local && "revision" in task
          ? await scheduledTaskApi.deleteLocalScheduledTask({ taskId: task.id, expectedRevision: task.revision })
          : desktopAccount ? await scheduledTaskApi.deleteDesktopAccountScheduledTask({ taskId: task.id, expectedLocalRevision: requireDesktopRevision(task) })
          : await scheduledTaskApi.deleteScheduledTask(owner!.requestContext, task.id);
        assertResult(result);
        if (!props.active || version !== readVersion) return;
        if (result.task && selectedRunsTask.value?.id === task.id) selectedRunsTask.value = result.task;
        message.success("定时任务已删除");
        await loadTasks();
      } catch (error) {
        if (!reportExpiredSession(error, owner, diagnostic, "delete", task.id) && props.active && version === readVersion) {
          const failure = describeFailure(error, "delete", task.id, diagnostic);
          if (desktopAccount) await loadTasks();
          if (props.active && version === readVersion) panelError.value = [failure, panelError.value].filter(Boolean).join("；");
        }
        throw error;
      }
    },
  });
}

/** 切换到运行记录视图；传入任务时只显示该任务记录。 */
async function openRunsView(task: Task | null): Promise<void> {
  selectedRunsTask.value = task;
  runsPage.value = 1;
  activeView.value = "runs";
  await loadRuns();
}

/** 兼容既有调用/测试的抽屉语义，实际映射到运行记录 tab。 */
const openRunsDrawer = openRunsView;
const runsDrawerOpen = computed({
  get: () => activeView.value === "runs",
  set: (open: boolean) => { activeView.value = open ? "runs" : "tasks"; },
});

/** 切换 tab 时按需加载运行记录；离开时取消旧响应落盘。 */
function handleViewChange(key: string | number): void {
  const next = key === "runs" ? "runs" : "tasks";
  if (next !== "runs") {
    runsVersion++;
    runsLoading.value = false;
  }
  activeView.value = next;
  if (next === "runs") void loadRuns();
}

/** 清除任务过滤，回到全部运行记录。 */
function clearRunsFilter(): void {
  selectedRunsTask.value = null;
  runsPage.value = 1;
  void loadRuns();
}

/** 历史总数由原持久化入口返回；本设备可省略taskId读取删除后历史。 */
async function loadRuns(): Promise<void> {
  if (!props.active || activeView.value !== "runs") return;
  if (!isOnDevice.value && !selectedRunsTask.value) {
    runs.value = [];
    runsTotal.value = 0;
    runsLoading.value = false;
    return;
  }
  const owner = isLocal.value ? null : captureTaskSession();
  const diagnostic = captureFailureContext(selectedRunsTask.value ?? undefined);
  const taskId = selectedRunsTask.value?.id;
  const version = ++runsVersion;
  runsError.value = "";
  runsLoading.value = true;
  try {
    const input = { limit: runsPageSize, offset: (runsPage.value - 1) * runsPageSize };
    const result = isLocal.value ? await scheduledTaskApi.listLocalScheduledTaskRuns({ ...input,
      ...(selectedRunsTask.value ? { taskId: selectedRunsTask.value.id } : {}) })
      : isDesktopAccount.value ? await scheduledTaskApi.listDesktopAccountScheduledTaskRuns({ ...input,
        ...(selectedRunsTask.value ? { taskId: selectedRunsTask.value.id } : {}) })
      : await scheduledTaskApi.listScheduledTaskRuns(owner!.requestContext, selectedRunsTask.value!.id, input);
    assertResult(result);
    if (!props.active || version !== runsVersion) return;
    runs.value = result.items;
    runsTotal.value = result.total;
  } catch (error) {
    if (reportExpiredSession(error, owner, diagnostic, "runs", taskId)) return;
    if (props.active && version === runsVersion) runsError.value = describeFailure(error, "runs", taskId, diagnostic);
  } finally {
    if (version === runsVersion) runsLoading.value = false;
  }
}

/** 账号 owner 绑定原面板寿命；自身认证清理不等同于关闭、切源或卸载。 */
function captureTaskSession() {
  return { ...captureAccountSession(config), viewVersion };
}

/** 发起时固定日志归属与实际脚本排除值，本机操作不绑定账号会话。 */
function captureFailureContext(task?: Task) {
  return { source: props.source, userId: isLocal.value ? null : config.userSummary?.userId ?? null,
    sessionToken: config.sessionToken, scriptCommands: [form.scriptCommand.trim(), task?.taskType === "script"
      ? (task.payload as ScheduledTaskScriptPayload).command.trim() : ""] };
}

/** 自身认证失效已清空视图，仍显式报告原失败；其他视图或账号不接收旧错误。 */
function reportExpiredSession(error: unknown, owner: ReturnType<typeof captureTaskSession> | null,
  diagnostic: ReturnType<typeof captureFailureContext>, operation: string, taskId?: string): boolean {
  if (!props.active || isLocal.value || !owner || owner.viewVersion !== viewVersion || !owner.isCurrentResponse()
    || config.sessionToken || config.userSummary || isCancelledRequestError(error)) return false;
  panelError.value = describeFailure(error, operation, taskId, diagnostic);
  return true;
}

/** 将失败信封转为异常，使写操作立即停止且保留诊断上下文。 */
function assertResult<T extends ApiResult<object>>(result: T): asserts result is Extract<T, { ok: true }> {
  if (!result.ok) throw createApiResultError(result);
}

/** 日志只保留安全定位与固定根因；原失败文案仍显式交给 UI。 */
function describeFailure(error: unknown, operation: string, taskId: string | undefined, diagnostic: ReturnType<typeof captureFailureContext>): string {
  const failure = error as { code?: string; message?: string; details?: { requestId?: string } };
  const secrets = [diagnostic.sessionToken, config.sessionToken, ...diagnostic.scriptCommands, form.scriptCommand.trim()];
  /** 即使格式合法，定位字段也不得承载本次已知凭据或脚本。 */
  const safeField = (value: unknown, format: RegExp): value is string => typeof value === "string" && format.test(value)
    && !secrets.some((secret) => secret && value.includes(secret));
  const idFormat = /^[A-Za-z0-9._:-]{1,128}$/u;
  const requestId = [failure?.details?.requestId, config.desktopRuntime?.requestId].find((value) => safeField(value, idFormat))
    ?? `scheduled-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = diagnostic.userId;
  console.error("SCHEDULED_TASK_UI_FAILED", { code: safeField(failure?.code, /^[A-Z][A-Z0-9_]{0,80}$/u) ? failure.code : "SCHEDULED_TASK_UI_FAILED",
    requestId, userId: safeField(userId, idFormat) ? userId : null,
    taskId: safeField(taskId, idFormat) ? taskId : null, source: diagnostic.source, operation,
    cause: isApiResultError(error) ? "任务接口返回失败" : error instanceof TypeError ? "网络请求或响应解析失败" : "任务操作失败" });
  return `${failure?.message ?? String(error)}${failure?.code === "CONFLICT" ? "，请刷新后重新编辑" : ""}`;
}

/** 格式化毫秒时间戳。 */
function formatTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

/** 将毫秒耗时格式化为更适合阅读的中文时长。 */
function formatDurationMs(value: number | null | undefined): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}毫秒`;
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))}秒`;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/** 格式化任务类型。 */
function formatTaskType(value: ScheduledTaskType): string {
  return value === "workflow" ? "工作流" : "脚本";
}

/** 格式化运行状态。 */
function formatStatus(value: string | null | undefined): string {
  const map: Record<string, string> = {
    running: "运行中",
    success: "成功",
    failed: "失败",
    skipped: "跳过",
    timeout: "超时",
    queued: "排队",
  };
  return value ? (map[value] ?? value) : "-";
}

/** 按预设更新工作流状态策略。 */
function applyWorkflowSkipPreset(preset: WorkflowSkipPreset): void {
  if (preset === "default") {
    form.workflowSkipStatuses = [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES];
  } else if (preset === "strict") {
    form.workflowSkipStatuses = [...SCHEDULED_TASK_WORKFLOW_STRICT_SKIP_STATUSES];
  } else if (preset === "none") {
    form.workflowSkipStatuses = [];
  }
}

/** 根据已有状态集合识别预设，无法匹配时进入自定义。 */
function applyWorkflowSkipStatusesToForm(statuses: OrchestrationStatus[]): void {
  const normalized = normalizeScheduledTaskWorkflowSkipStatuses(statuses);
  form.workflowSkipStatuses = normalized;
  if (sameStatuses(normalized, [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES])) {
    form.workflowSkipPreset = "default";
  } else if (sameStatuses(normalized, [...SCHEDULED_TASK_WORKFLOW_STRICT_SKIP_STATUSES])) {
    form.workflowSkipPreset = "strict";
  } else if (!normalized.length) {
    form.workflowSkipPreset = "none";
  } else {
    form.workflowSkipPreset = "custom";
  }
}

/** 比较两个状态集合，忽略顺序。 */
function sameStatuses(left: OrchestrationStatus[], right: OrchestrationStatus[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((status) => values.has(status));
}

/** 列表中展示工作流策略摘要。 */
function workflowPolicySummary(task: Task): string | null {
  if (task.taskType !== "workflow") return null;
  const payload = task.payload as ScheduledTaskWorkflowPayload;
  const statuses = normalizeScheduledTaskWorkflowSkipStatuses(payload.skipWhenPreviousInstanceStatuses);
  if (sameStatuses(statuses, [...SCHEDULED_TASK_WORKFLOW_DEFAULT_SKIP_STATUSES])) return "策略：默认";
  if (sameStatuses(statuses, [...SCHEDULED_TASK_WORKFLOW_STRICT_SKIP_STATUSES])) return "策略：严格";
  if (!statuses.length) return "策略：不限制";
  return `策略：自定义 ${statuses.length} 项`;
}

/** 流程实例状态中文标签。 */
function workflowStatusLabel(status: OrchestrationStatus): string {
  const map: Record<OrchestrationStatus, string> = {
    pending: "待开始",
    running: "运行中",
    paused: "已暂停",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待补充",
    completed: "已完成",
    failed: "已失败",
    cancelled: "已取消",
  };
  return map[status];
}
</script>

<template>
  <section class="scheduled-tasks">
    <div class="scheduled-tasks__toolbar">
      <div>
        <h2>{{ isDesktopAccount ? '账号任务 · 这台电脑' : '定时任务' }}</h2>
      </div>
      <div class="scheduled-tasks__actions">
        <template v-if="activeView === 'tasks'">
          <a-button :loading="loading" @click="loadTasks(true)">
            <ReloadOutlined />
            刷新
          </a-button>
          <a-button type="primary" :disabled="saving" @click="openCreateModal">
            <PlusOutlined />
            新建
          </a-button>
        </template>
        <template v-else>
          <a-tag v-if="selectedRunsTask" closable @close="clearRunsFilter">任务：{{ selectedRunsTask.name }}</a-tag>
          <a-button :loading="runsLoading" @click="loadRuns()">
            <ReloadOutlined />
            刷新
          </a-button>
        </template>
      </div>
    </div>

    <a-tabs v-model:active-key="activeView" class="scheduled-tasks__tabs" @change="handleViewChange">
      <a-tab-pane key="tasks" tab="定时任务">
        <div class="scheduled-tasks__view">
    <a-alert
      v-if="!isOnDevice && !devices.length && !devicesLoading"
      class="scheduled-tasks__alert"
      type="warning"
      show-icon
      message="暂无在线且已登记的 Client 设备"
    />
    <a-alert v-if="panelError" type="error" show-icon :message="panelError" />

    <a-table
      class="scheduled-tasks__table"
      row-key="id"
      size="small"
      :loading="loading"
      :columns="taskColumns"
      :data-source="tasks"
      :scroll="{ x: isLocal ? 806 : 1106, y: '100%' }"
      table-layout="fixed"
      :pagination="false"
      :locale="{ emptyText: '暂无定时任务' }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="scheduled-tasks__name" :title="record.name">{{ record.name }}</div>
          <div v-if="!isOnDevice" class="scheduled-tasks__sub" :title="record.clientNameSnapshot || record.clientId">{{ record.clientNameSnapshot || record.clientId }}</div>
          <div v-if="isDesktopAccount && record.pending" class="scheduled-tasks__sub">等待同步</div>
          <div v-if="isDesktopAccount && record.stopIntent" class="scheduled-tasks__sub">{{ record.stopIntent === 'deleted' ? '已停止，等待删除' : '已停止' }}</div>
          <div v-if="workflowPolicySummary(record)" class="scheduled-tasks__sub">{{ workflowPolicySummary(record) }}</div>
        </template>
        <template v-else-if="column.key === 'taskType'">
          <a-tag>{{ formatTaskType(record.taskType) }}</a-tag>
        </template>
        <template v-else-if="column.key === 'enabled'">
          <a-switch v-if="isOnDevice" :checked="record.enabled && !record.stopIntent" :loading="togglingTaskId === record.id" :disabled="Boolean(togglingTaskId)" :aria-label="`启用 ${record.name}`" @change="(checked: boolean | string | number) => setTaskEnabled(record, Boolean(checked))" />
          <a-tag v-else :color="record.enabled ? 'green' : 'default'">{{ record.enabled ? "启用" : "停用" }}</a-tag>
        </template>
        <template v-else-if="column.key === 'nextRunAt'">
          {{ formatTime(record.nextRunAt) }}
        </template>
        <template v-else-if="column.key === 'lastStatus'">
          {{ formatStatus(record.lastStatus) }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-space class="scheduled-tasks__row-actions" :size="8">
            <a-tooltip title="立即运行">
              <a-button size="small" aria-label="立即运行" @click="runTaskNow(record)">
                <PlayCircleOutlined />
              </a-button>
            </a-tooltip>
            <a-tooltip title="运行记录">
              <a-button size="small" aria-label="运行记录" @click="openRunsView(record)">
                <HistoryOutlined />
              </a-button>
            </a-tooltip>
            <a-tooltip title="编辑">
              <a-button size="small" aria-label="编辑" @click="openEditModal(record)">
                <EditOutlined />
              </a-button>
            </a-tooltip>
            <a-tooltip title="删除">
              <a-button size="small" danger aria-label="删除" @click="confirmDeleteTask(record)">
                <DeleteOutlined />
              </a-button>
            </a-tooltip>
          </a-space>
        </template>
      </template>
    </a-table>
    <a-pagination class="scheduled-tasks__pagination" :current="taskPage" :page-size="taskPageSize" :total="taskTotal" :show-size-changer="true" :hide-on-single-page="false"
      @change="(page: number, pageSize: number) => { taskPage = page; taskPageSize = pageSize; void loadTasks(); }" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="runs" tab="运行记录">
        <div class="scheduled-tasks__view">
          <a-alert v-if="runsError" type="error" show-icon :message="runsError" />
          <a-alert v-if="!isOnDevice && !selectedRunsTask" type="info" show-icon message="请从定时任务列表选择任务查看运行记录" />
          <a-table
            class="scheduled-tasks__table scheduled-tasks__runs"
            row-key="id"
            size="small"
            :loading="runsLoading"
            :columns="runColumns"
            :data-source="runs"
            :scroll="{ x: 700, y: '100%' }"
            :pagination="false"
            :locale="{ emptyText: '暂无运行记录' }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'taskSnapshot'">{{ record.taskNameSnapshot }}<div v-if="isLocal" class="scheduled-tasks__sub">修订 {{ record.configRevision }}</div></template>
              <template v-else-if="column.key === 'scheduledAt'">{{ formatTime(record.scheduledAt) }}</template>
              <template v-else-if="column.key === 'status'">{{ record.workflowInstanceId && record.status === 'success' ? '已触发' : formatStatus(record.status) }}</template>
              <template v-else-if="column.key === 'durationMs'">{{ formatDurationMs(record.durationMs) }}</template>
              <template v-else-if="column.key === 'summary'">
                <div>{{ record.summary || '-' }}</div>
                <div v-if="record.workflowInstanceId" class="scheduled-tasks__run-instance">instance: {{ record.workflowInstanceId }}</div>
                <pre v-if="record.errorMessage || record.outputExcerpt" class="scheduled-tasks__run-output">{{ record.errorMessage || record.outputExcerpt }}</pre>
              </template>
            </template>
          </a-table>
          <a-pagination class="scheduled-tasks__pagination" :current="runsPage" :page-size="runsPageSize" :total="runsTotal" :show-size-changer="false" :hide-on-single-page="false"
            @change="(page: number) => { runsPage = page; void loadRuns(); }" />
        </div>
      </a-tab-pane>
    </a-tabs>

    <a-modal
      v-model:open="formModalOpen"
      :title="form.id ? '编辑定时任务' : '新建定时任务'"
      :width="760"
      :confirm-loading="saving"
      :closable="!saving"
      :mask-closable="!saving"
      :keyboard="!saving"
      :cancel-button-props="{ disabled: saving }"
      ok-text="保存"
      cancel-text="取消"
      destroy-on-close
      @ok="saveTask"
      @cancel="formModalOpen = false"
    >
      <div class="scheduled-tasks__modal-body">
        <a-alert v-if="formError" class="scheduled-tasks__alert" type="error" show-icon :message="formError" />
        <a-form layout="vertical" autocomplete="off">
          <section class="scheduled-tasks__section">
            <div class="scheduled-tasks__section-title">基本信息</div>
            <a-form-item v-if="!isOnDevice" label="Client 设备">
              <a-select
                v-model:value="deviceSelectValue"
                :loading="devicesLoading"
                :options="deviceOptions"
                placeholder="选择在线 Client 设备"
              />
            </a-form-item>
            <a-form-item label="任务名称">
              <a-input v-model:value="form.name" name="codeflow-scheduled-task-name" autocomplete="new-password" />
            </a-form-item>
            <a-form-item label="说明">
              <a-textarea v-model:value="form.description" :rows="2" name="codeflow-scheduled-task-description" autocomplete="off" />
            </a-form-item>
          </section>

          <section class="scheduled-tasks__section">
            <div class="scheduled-tasks__section-title">调度设置</div>
            <a-row :gutter="16">
              <a-col :xs="24" :sm="16">
                <a-form-item label="任务类型">
                  <a-segmented v-model:value="form.taskType" :options="[{ label: '工作流', value: 'workflow', disabled: workspaceEditing && !boundWorkspace }, { label: '脚本', value: 'script' }]" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item label="启用">
                  <a-switch v-model:checked="form.enabled" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-row :gutter="16">
              <a-col :xs="24" :sm="10">
                <a-form-item label="Cron">
                  <a-input v-model:value="form.cronExpr" name="codeflow-scheduled-task-cron" autocomplete="off" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="8">
                <a-form-item label="时区">
                  <a-input v-model:value="form.timezone" name="codeflow-scheduled-task-timezone" autocomplete="off" />
                </a-form-item>
              </a-col>
              <a-col :xs="24" :sm="6">
                <a-form-item label="超时分钟">
                  <a-input-number v-model:value="form.timeoutMinutes" :min="1" :max="1440" style="width: 100%" />
                </a-form-item>
              </a-col>
            </a-row>
            <div class="scheduled-tasks__cron-actions">
              <a-button size="small" :loading="previewLoading" @click="previewCron">预览 Cron</a-button>
              <div v-if="cronPreview.length" class="scheduled-tasks__preview">
                <span v-for="item in cronPreview" :key="item">{{ formatTime(item) }}</span>
              </div>
            </div>
          </section>

          <section class="scheduled-tasks__section">
            <div class="scheduled-tasks__section-title">执行内容</div>
            <template v-if="form.taskType === 'workflow'">
              <a-row :gutter="16">
                <a-col :xs="24" :sm="12">
                  <a-form-item label="工作区">
                    <a-select
                      v-model:value="form.workflowWorkspaceId"
                      :disabled="workspaceEditing"
                      @change="form.workflowId = ''"
                      :loading="assetsLoading"
                      :options="workspaceOptions"
                      placeholder="选择工作区"
                    />
                  </a-form-item>
                </a-col>
                <a-col :xs="24" :sm="12">
                  <a-form-item label="工作流">
                    <a-select
                      v-model:value="form.workflowId"
                      :loading="assetsLoading"
                      :options="workflowOptions"
                      placeholder="选择工作流"
                    />
                  </a-form-item>
                </a-col>
              </a-row>
              <a-form-item label="上一轮流程状态策略">
                <a-select
                  v-model:value="form.workflowSkipPreset"
                  :options="workflowSkipPresetOptions"
                />
                <div v-if="form.workflowSkipPreset === 'custom'" class="scheduled-tasks__workflow-statuses">
                  <span class="scheduled-tasks__workflow-statuses-title">勾选后，如果上一轮流程处于这些状态，本次自动调度就跳过：</span>
                  <a-checkbox-group v-model:value="workflowSkipStatusValues" class="scheduled-tasks__workflow-status-grid">
                    <a-checkbox v-for="item in workflowStatusOptions" :key="item.value" :value="item.value">
                      {{ item.label }}
                    </a-checkbox>
                  </a-checkbox-group>
                  <p v-if="form.workflowSkipStatuses.includes('completed')" class="scheduled-tasks__warning">
                    勾选“已完成”会导致流程完成后也不再自动调度。
                  </p>
                </div>
                <p class="scheduled-tasks__hint">
                  {{ workflowSkipPresetDescription }}
                </p>
              </a-form-item>
            </template>

            <template v-else>
              <a-row :gutter="16">
                <a-col :xs="24" :sm="8">
                  <a-form-item label="Shell">
                    <a-select
                      v-model:value="form.scriptShell"
                      :options="['powershell', 'cmd', 'bash', 'sh'].map((value) => ({ value, label: value }))"
                    />
                  </a-form-item>
                </a-col>
                <a-col :xs="24" :sm="16">
                  <a-form-item label="工作区">
                    <a-select
                      v-model:value="form.scriptWorkspaceId"
                      :disabled="workspaceEditing"
                      allow-clear
                      :loading="assetsLoading"
                      :options="workspaceOptions"
                      placeholder="不选择则使用默认任务目录"
                    />
                  </a-form-item>
                </a-col>
              </a-row>
              <a-form-item label="命令">
                <a-textarea v-model:value="form.scriptCommand" :rows="4" name="codeflow-scheduled-task-command" autocomplete="off" />
              </a-form-item>
              <a-form-item label="相对目录">
                <a-input v-model:value="form.scriptCwdRelative" name="codeflow-scheduled-task-cwd" autocomplete="off" />
              </a-form-item>
              <a-form-item label="环境变量名">
                <a-textarea v-model:value="form.scriptEnvRefs" :rows="3" name="codeflow-scheduled-task-env-refs" autocomplete="off" />
              </a-form-item>
            </template>
          </section>
        </a-form>
      </div>
    </a-modal>

  </section>
</template>

<style scoped>
.scheduled-tasks {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.scheduled-tasks__toolbar {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  width: 100%;
}

.scheduled-tasks__toolbar h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.scheduled-tasks__toolbar p,
.scheduled-tasks__sub {
  margin: 4px 0 0;
  color: var(--app-text-secondary);
  font-size: 12px;
}

.scheduled-tasks__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.scheduled-tasks__modal-body {
  max-height: min(calc(100vh - 240px), 680px);
  padding-right: 4px;
  overflow: auto;
}

.scheduled-tasks__modal-body :deep(.ant-form-item) {
  margin-bottom: 16px;
}

.scheduled-tasks__section + .scheduled-tasks__section {
  margin-top: 2px;
  padding-top: 16px;
  border-top: 1px solid var(--app-divider);
}

.scheduled-tasks__section-title {
  margin-bottom: 10px;
  color: var(--app-text-secondary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.scheduled-tasks__cron-actions {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: -8px 0 0;
}

.scheduled-tasks__alert {
  margin-bottom: 12px;
}

.scheduled-tasks__table {
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.scheduled-tasks__table :deep(.ant-spin-nested-loading),
.scheduled-tasks__table :deep(.ant-spin-container),
.scheduled-tasks__table :deep(.ant-table),
.scheduled-tasks__table :deep(.ant-table-container) {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
}

.scheduled-tasks__table :deep(.ant-table-header) {
  flex: 0 0 auto;
}

.scheduled-tasks__table :deep(.ant-table-body) {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto !important;
}

.scheduled-tasks__pagination {
  flex: 0 0 auto;
  align-self: flex-end;
  min-height: 32px;
  margin: 0;
}

.scheduled-tasks__tabs {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
}

.scheduled-tasks__tabs :deep(.ant-tabs-nav) {
  flex: 0 0 auto;
  margin-bottom: 12px;
}

.scheduled-tasks__tabs :deep(.ant-tabs-content-holder) {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
}

.scheduled-tasks__tabs :deep(.ant-tabs-content) {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
}

.scheduled-tasks__tabs :deep(.ant-tabs-tabpane) {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
}

.scheduled-tasks__view {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

@media (max-width: 767px) {
  .scheduled-tasks__toolbar { gap: 8px; align-items: center; }
  .scheduled-tasks__toolbar h2 { font-size: 16px; white-space: nowrap; }
  .scheduled-tasks__actions { gap: 4px; justify-content: flex-end; }
}

.scheduled-tasks__name {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scheduled-tasks__sub {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scheduled-tasks__preview {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin: 0;
}

.scheduled-tasks__preview span {
  padding: 2px 6px;
  border: 1px solid var(--app-divider);
  border-radius: 4px;
  background: var(--app-bg);
  font-size: 12px;
}

.scheduled-tasks__hint {
  margin: 6px 0 0;
  color: var(--app-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.scheduled-tasks__workflow-statuses {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--app-divider);
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 94%, var(--app-bg, #fff));
}

.scheduled-tasks__workflow-statuses-title {
  color: var(--app-text-secondary);
  font-size: 12px;
}

.scheduled-tasks__workflow-status-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.scheduled-tasks__warning {
  margin: 0;
  color: var(--app-warning, #faad14);
  font-size: 12px;
}

.scheduled-tasks__run-instance {
  margin-top: 4px;
  color: var(--app-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.scheduled-tasks__run-output {
  max-height: 120px;
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--app-divider);
  border-radius: 4px;
  background: var(--app-bg);
  white-space: pre-wrap;
}

.scheduled-tasks__row-actions {
  justify-content: center;
}
</style>
