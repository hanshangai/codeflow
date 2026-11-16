<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { CopyOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import {
  WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES,
  type ApiResult,
  type CancelWorkspaceDirectoryMigrationRequest,
  type OnlineClientInfo,
  type PrepareWorkspaceDirectoryMigrationRequest,
  type StartWorkspaceDirectoryMigrationRequest,
  type WorkspaceDirectoryMigrationOperation,
  type WorkspaceDirectoryMigrationOperationResponse,
  type WorkspaceSummary,
} from "@codeflowai/shared";

import { rebuildFsIndex } from "../../../api/fs";
import {
  cancelWorkspaceDirectoryMigration,
  getWorkspaceDirectoryMigration,
  prepareWorkspaceDirectoryMigration,
  recoverWorkspaceDirectoryMigration,
  startWorkspaceDirectoryMigration,
} from "../../../api/workspaces";
import { useApiContext } from "../../../composables/useApiContext";
import { copyToClipboard } from "../../../composables/useClipboard";
import { isDesktopWorkspace } from "../../../services/desktop";
import {
  cancelLocalWorkspaceDirectoryMigration,
  getLocalWorkspaceDirectoryMigration,
  prepareLocalWorkspaceDirectoryMigration,
  recoverLocalWorkspaceDirectoryMigration,
  startLocalWorkspaceDirectoryMigration,
} from "../workspaceDirectoryMigrationLocal";
import { createApiResultError, isApiResultError } from "../../../api/request";
import { useConfigStore } from "../../../store/config";
import { useWorkspacesStore } from "../../../store/workspaces";
import { createBrowserUuid } from "../../../utils/browserUuid";
import { getWorkspaceDisplayTitle } from "../../../utils/workspaceDisplay";
import { workspaceIdsReferToSameWorkspace } from "../../../utils/workspaceId";
import { trackProductEvent } from "../../../analytics/analytics";
import ClientDirectoryPickerModal from "./client-directory-picker-modal.vue";

defineOptions({ name: "WorkspaceDirectoryMigrationModal" });

type WorkspaceDirectoryMigrationErrorCode = (typeof WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES)[number];

const MIGRATION_FAILURE_FALLBACKS: Record<WorkspaceDirectoryMigrationErrorCode, string> = {
  WORKSPACE_MIGRATION_UNSUPPORTED: "当前 Client 或平台不支持工作区目录迁移，请升级 Client 后重试。",
  WORKSPACE_MIGRATION_NOT_FOUND: "迁移记录不存在或已失效，请关闭弹窗后重新发起检查。",
  WORKSPACE_MIGRATION_BUSY: "该工作区已有迁移操作正在处理，请等待当前操作结束。",
  WORKSPACE_MIGRATION_INDEX_NOT_READY: "工作区文件索引尚未就绪，请等待索引完成后重试。",
  WORKSPACE_MIGRATION_IDEMPOTENCY_CONFLICT: "同一请求标识对应了不同目标目录，请重新发起迁移。",
  WORKSPACE_MIGRATION_STATE_CONFLICT: "迁移状态已变化，请重新查询最新状态后继续。",
  WORKSPACE_MIGRATION_ACTIVE_RESOURCES: "工作区仍有运行中的任务、终端或后台资源，请停止后重试。",
  WORKSPACE_MIGRATION_IN_PROGRESS: "工作区正在迁移，当前操作暂不可执行。",
  WORKSPACE_MIGRATION_TARGET_INVALID: "目标路径不符合迁移要求，请检查路径、名称和目录关系。",
  WORKSPACE_MIGRATION_TARGET_STORAGE_UNSUPPORTED: "目标不属于允许的本机固定磁盘，或位于同步、移动、网络存储中。",
  WORKSPACE_MIGRATION_TARGET_STORAGE_UNCONFIRMED: "尚未确认目标目录不受同步软件托管。",
  WORKSPACE_MIGRATION_TARGET_CONFLICT: "目标目录或迁移临时目录已存在，请更换空的新目录。",
  WORKSPACE_MIGRATION_SPACE_INSUFFICIENT: "目标磁盘可用空间不足，无法容纳工作区内容。",
  WORKSPACE_MIGRATION_LINK_UNSUPPORTED: "工作区包含不支持迁移的链接或 Windows 重解析点。",
  WORKSPACE_MIGRATION_GIT_WORKTREE_UNSUPPORTED: "工作区使用了不支持迁移的 Git worktree 目录关系。",
  WORKSPACE_MIGRATION_SOURCE_CHANGED: "迁移期间源目录内容发生变化，请停止外部写入后重新检查。",
  WORKSPACE_MIGRATION_EXTERNAL_WRITES_UNCONFIRMED: "尚未确认 IDE、构建和同步软件已停止写入源目录。",
  WORKSPACE_MIGRATION_SHARED_ACTIVITY: "工作区仍有共享访问或共享维护活动，请结束后重试。",
  WORKSPACE_MIGRATION_INTERRUPTED: "Client 或文件 Worker 在迁移期间中断，目录尚未安全切换。",
  WORKSPACE_MIGRATION_COPY_FAILED: "复制工作区内容时发生文件读取、写入或磁盘错误。",
  WORKSPACE_MIGRATION_VERIFY_FAILED: "源目录与目标目录校验不一致，未切换工作区目录。",
  WORKSPACE_MIGRATION_SWITCH_FAILED: "切换工作区生效目录失败，系统将按持久证据恢复。",
  WORKSPACE_MIGRATION_CANCEL_NOT_ALLOWED: "迁移已越过可取消阶段，不能再取消。",
  WORKSPACE_MIGRATION_RECOVERY_REQUIRED: "迁移现场与持久状态不一致，需要先执行恢复。",
};
const MIGRATION_ERROR_CODE_SET = new Set<string>(WORKSPACE_DIRECTORY_MIGRATION_ERROR_CODES);

const props = defineProps<{
  open: boolean;
  workspace: WorkspaceSummary | null;
  client: OnlineClientInfo | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const config = useConfigStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();

/** 桌面单机模式直连内置 Client；已连接 Server 时沿用 Server 的共享维护与启动对账。 */
const localStandalone = computed(() => config.isDesktop && !config.connected && isDesktopWorkspace(config, workspaceId.value));

function requestMigrationGet(operationId: string) {
  return localStandalone.value
    ? getLocalWorkspaceDirectoryMigration(workspaceId.value, operationId)
    : getWorkspaceDirectoryMigration(ctx.value, workspaceId.value, operationId);
}

function requestMigrationPrepare(body: PrepareWorkspaceDirectoryMigrationRequest) {
  return localStandalone.value
    ? prepareLocalWorkspaceDirectoryMigration(workspaceId.value, body)
    : prepareWorkspaceDirectoryMigration(ctx.value, workspaceId.value, body);
}

function requestMigrationStart(operationId: string, body: StartWorkspaceDirectoryMigrationRequest) {
  return localStandalone.value
    ? startLocalWorkspaceDirectoryMigration(workspaceId.value, operationId, body)
    : startWorkspaceDirectoryMigration(ctx.value, workspaceId.value, operationId, body);
}

function requestMigrationCancel(operationId: string, body: CancelWorkspaceDirectoryMigrationRequest) {
  return localStandalone.value
    ? cancelLocalWorkspaceDirectoryMigration(workspaceId.value, operationId, body)
    : cancelWorkspaceDirectoryMigration(ctx.value, workspaceId.value, operationId, body);
}

function requestMigrationRecover(operationId: string) {
  return localStandalone.value
    ? recoverLocalWorkspaceDirectoryMigration(workspaceId.value, operationId)
    : recoverWorkspaceDirectoryMigration(ctx.value, workspaceId.value, operationId);
}

const operation = ref<WorkspaceDirectoryMigrationOperation | null>(null);
const lastTrackedMigrationCompletionId = ref("");
const operationReferenceId = ref<string | null>(null);
const targetParentPath = ref("");
const targetDirectoryName = ref("");
const idempotencyKey = ref("");
const externalWritesPausedConfirmed = ref(false);
const targetNotSyncManagedConfirmed = ref(false);
const pickerOpen = ref(false);
const preparing = ref(false);
const querying = ref(false);
const starting = ref(false);
const cancelling = ref(false);
const recovering = ref(false);
const reindexing = ref(false);
const reloadPending = ref(false);
const errorText = ref<string | null>(null);
const errorCode = ref<string | null>(null);
const startResolutionPending = ref(false);
let modalEpoch = 0;
let pollTimer: number | null = null;

const workspaceId = computed(() => String(props.workspace?.id ?? ""));
const currentTitle = computed(() => props.workspace ? getWorkspaceDisplayTitle(props.workspace) : "工作区");
const currentPath = computed(() => operation.value?.currentPath || props.workspace?.path || "");
const targetPathPreview = computed(() => joinDirectoryPath(targetParentPath.value, targetDirectoryName.value));
const hostedSharedName = computed(() => String(props.workspace?.hostedShared?.displayName ?? "").trim());
const hostedSharedCount = computed(() => Math.max(0, Number(props.workspace?.hostedSharedCount ?? (hostedSharedName.value ? 1 : 0))));
const isCurrentWorkspace = computed(() => workspaceIdsReferToSameWorkspace(config.workspaceId, workspaceId.value));
const isTargetForm = computed(() => !operation.value && !operationReferenceId.value);
const isQueryUnavailable = computed(() => !operation.value && Boolean(operationReferenceId.value));
const isChecking = computed(() => operation.value?.state === "scanning");
const isAwaitingConfirmation = computed(() => !startResolutionPending.value
  && operation.value?.state === "awaiting_confirmation"
  && operation.value.startDisposition !== "prepared");
const isConfirmingStart = computed(() => startResolutionPending.value
  || (operation.value?.state === "awaiting_confirmation" && operation.value.startDisposition === "prepared"));
const isRecoveryRequired = computed(() => operation.value?.state === "recovery_required");
const isCompleted = computed(() => operation.value?.state === "completed");
const isFailed = computed(() => operation.value?.state === "failed" || operation.value?.state === "cancelled");
/** 执行中的迁移不显示底部关闭动作，避免用户误以为操作已经结束。 */
const showFooterClose = computed(() => isTargetForm.value
  || isQueryUnavailable.value
  || isAwaitingConfirmation.value
  || isRecoveryRequired.value
  || isCompleted.value
  || isFailed.value);
const isRunning = computed(() => Boolean(operation.value)
  && !isChecking.value
  && !isAwaitingConfirmation.value
  && !isConfirmingStart.value
  && !isRecoveryRequired.value
  && !isCompleted.value
  && !isFailed.value);
const busy = computed(() => preparing.value || querying.value || starting.value || cancelling.value || recovering.value || reloadPending.value);
const canStart = computed(() => Boolean(operation.value?.canStart)
  && externalWritesPausedConfirmed.value
  && targetNotSyncManagedConfirmed.value
  && !busy.value
  && !startResolutionPending.value);
const operationItemCount = computed(() => (operation.value?.sourceFileCount ?? 0) + (operation.value?.sourceDirectoryCount ?? 0));
const excludedDependencyDirectoryCount = computed(() => Math.max(0, operation.value?.excludedDependencyDirectoryCount ?? 0));
const excludedDependencyDirectories = computed(() => (operation.value?.excludedDependencyDirectories ?? [])
  .map((value) => safeRelativePath(value))
  .filter((value): value is string => Boolean(value)));
const excludedDependencyDescription = computed(() => {
  const paths = excludedDependencyDirectories.value;
  if (!paths.length) return "迁移完成后请在新目录重新安装依赖并重新构建项目。";
  const remaining = Math.max(0, excludedDependencyDirectoryCount.value - paths.length);
  return `已排除：${paths.join("、")}${remaining > 0 ? `，另有 ${remaining} 个` : ""}。迁移完成后请重新安装依赖并重新构建项目。`;
});
const phaseLabel = computed(() => formatPhase(operation.value?.phase ?? "checking"));
const currentStep = computed(() => resolveStep(operation.value?.phase ?? "checking"));
const indexWarning = computed(() => operation.value?.warningCode === "WORKSPACE_INDEX_REBUILD_FAILED"
  || props.workspace?.directoryMigrationIndexState?.indexRebuildStatus === "failed");
const indexPending = computed(() => operation.value?.indexRebuildStatus === "pending"
  || props.workspace?.directoryMigrationIndexState?.indexRebuildStatus === "pending");
const blockers = computed(() => [...(operation.value?.blockers ?? []), ...(operation.value?.sharedBlockers ?? [])]);
const failureRelativePath = computed(() => readFailureDetail("relativePath"));
const failureReparseType = computed(() => readFailureDetail("reparseType"));
const failureChangedPaths = computed(() => operation.value?.errorCode === "WORKSPACE_MIGRATION_SOURCE_CHANGED"
  ? readFailureChangedPaths()
  : []);
const failureCause = computed(() => describeMigrationFailure(operation.value));

watch(
  () => [props.open, workspaceId.value] as const,
  ([open]) => {
    invalidateModalRequests();
    if (!open) return;
    void initializeModal(modalEpoch);
  },
  { immediate: true },
);

watch(
  () => workspaceId.value ? workspaces.migrationForWorkspace(workspaceId.value) : null,
  (next) => {
    if (!props.open || !next || next.operationId !== operation.value?.operationId) return;
    operation.value = next;
    if (shouldPoll(next)) schedulePoll();
  },
);

onBeforeUnmount(invalidateModalRequests);

/** 初始化目标表单；存在活动摘要时立即查询 Client 权威详情。 */
async function initializeModal(epoch: number): Promise<void> {
  preparing.value = false;
  querying.value = false;
  starting.value = false;
  cancelling.value = false;
  recovering.value = false;
  reindexing.value = false;
  reloadPending.value = false;
  pickerOpen.value = false;
  operation.value = null;
  operationReferenceId.value = null;
  startResolutionPending.value = false;
  errorText.value = null;
  errorCode.value = null;
  externalWritesPausedConfirmed.value = false;
  targetNotSyncManagedConfirmed.value = false;
  idempotencyKey.value = createBrowserUuid();
  targetParentPath.value = parentDirectory(props.workspace?.path ?? "");
  targetDirectoryName.value = baseName(props.workspace?.path ?? "");
  const activeOperationId = String(
    props.workspace?.activeDirectoryMigration?.operationId
      ?? (props.workspace?.directoryMigrationIndexState?.indexRebuildStatus === "failed"
        ? props.workspace.directoryMigrationIndexState.operationId
        : ""),
  ).trim();
  operationReferenceId.value = activeOperationId || null;
  if (!activeOperationId || !workspaceId.value) return;
  try {
    querying.value = true;
    const loaded = await requestMigrationOperation(
      epoch,
      requestMigrationGet(activeOperationId),
    );
    if (!loaded) return;
    operation.value = loaded;
    startResolutionPending.value = loaded.state === "awaiting_confirmation" && loaded.startDisposition === "prepared";
    if (shouldPoll(loaded)) schedulePoll();
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "暂时无法查询迁移状态");
  } finally {
    if (isActiveModalRequest(epoch)) querying.value = false;
  }
}

/** 创建预检操作；同一表单重试复用 idempotencyKey。 */
async function checkTarget(): Promise<void> {
  const parent = targetParentPath.value.trim();
  const name = targetDirectoryName.value.trim();
  if (!parent || !name) {
    errorText.value = "请选择目标父目录并填写新目录名称";
    return;
  }
  if (/[\\/]/u.test(name) || name === "." || name === "..") {
    errorText.value = "新目录名称不能包含路径分隔符，也不能是 . 或 ..";
    return;
  }
  const epoch = modalEpoch;
  preparing.value = true;
  errorText.value = null;
  errorCode.value = null;
  try {
    const loaded = await requestMigrationOperation(
      epoch,
      requestMigrationPrepare({
        idempotencyKey: idempotencyKey.value,
        targetParentPath: parent,
        targetDirectoryName: name,
      }),
    );
    if (!loaded) return;
    operation.value = loaded;
    operationReferenceId.value = loaded.operationId;
    startResolutionPending.value = false;
    if (shouldPoll(loaded)) schedulePoll();
    trackProductEvent("workspace_migration_start", { status: "prepared", source: "workspace_manager" });
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "迁移条件检查失败");
  } finally {
    if (isActiveModalRequest(epoch)) preparing.value = false;
  }
}

/** 查询当前 operation；失败停止轮询并保留可重试错误。 */
async function queryOperation(): Promise<void> {
  const current = operation.value;
  const referenceId = String(current?.operationId ?? operationReferenceId.value ?? "").trim();
  if (!referenceId || querying.value || !props.open) return;
  const epoch = modalEpoch;
  clearPollTimer();
  querying.value = true;
  try {
    const loaded = await requestMigrationOperation(
      epoch,
      requestMigrationGet(referenceId),
    );
    if (!loaded) return;
    operation.value = loaded;
    operationReferenceId.value = loaded.operationId;
    if (startResolutionPending.value) {
      startResolutionPending.value = loaded.state === "awaiting_confirmation"
        && loaded.startDisposition !== "accepted";
    }
    errorText.value = null;
    errorCode.value = null;
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "迁移状态查询失败");
  } finally {
    if (!isActiveModalRequest(epoch)) return;
    querying.value = false;
    if (operation.value && shouldPoll(operation.value) && !errorText.value) schedulePoll();
  }
}

/** 提交两项确认并启动迁移。 */
async function startMigration(): Promise<void> {
  const current = operation.value;
  if (!current || !canStart.value) return;
  const epoch = modalEpoch;
  starting.value = true;
  errorText.value = null;
  errorCode.value = null;
  try {
    const loaded = await requestMigrationOperation(
      epoch,
      requestMigrationStart(current.operationId, {
        externalWritesPausedConfirmed: true,
        targetNotSyncManagedConfirmed: true,
      }),
    );
    if (!loaded) return;
    operation.value = loaded;
    operationReferenceId.value = loaded.operationId;
    startResolutionPending.value = loaded.state === "awaiting_confirmation"
      && loaded.startDisposition === "prepared";
    schedulePoll(700);
    trackProductEvent("workspace_migration_start", { status: "started", source: "workspace_manager" });
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    if (isApiResultError(error) && error.code === "WORKSPACE_MIGRATION_IN_PROGRESS") {
      startResolutionPending.value = true;
      errorText.value = "正在确认启动状态，共享入口会继续保持维护态。";
      errorCode.value = error.code;
      await queryOperation();
      return;
    }
    setRequestError(error, "目录迁移启动失败");
  } finally {
    if (isActiveModalRequest(epoch)) starting.value = false;
  }
}

/** 取消当前可取消阶段；Client 只有完成清理后才返回 cancelled。 */
function confirmCancel(): void {
  const current = operation.value;
  if (!current?.canCancel || cancelling.value) return;
  const epoch = modalEpoch;
  Modal.confirm({
    title: isChecking.value || isAwaitingConfirmation.value ? "取消迁移检查" : "取消目录迁移",
    content: "取消会等待 Client 停止当前任务并清理临时目录，源目录不会删除。",
    okText: "确认取消",
    cancelText: "继续等待",
    async onOk() {
      if (!isActiveModalRequest(epoch)) return;
      cancelling.value = true;
      errorText.value = null;
      errorCode.value = null;
      try {
        const cancelled = await requestMigrationOperation(
          epoch,
          requestMigrationCancel(current.operationId, { reason: "user_cancelled" }),
        );
        if (!cancelled) return;
        operation.value = cancelled;
        trackProductEvent("workspace_migration_result", { status: "cancelled", source: "workspace_manager" });
      } catch (error) {
        if (!isActiveModalRequest(epoch)) return;
        setRequestError(error, "取消迁移失败");
        throw error;
      } finally {
        if (isActiveModalRequest(epoch)) cancelling.value = false;
      }
    },
  });
}

/** 取消 awaiting_confirmation 后回到目标表单，避免本地丢弃活动 operation。 */
async function returnToEdit(): Promise<void> {
  const current = operation.value;
  if (!current) return;
  const epoch = modalEpoch;
  cancelling.value = true;
  errorText.value = null;
  errorCode.value = null;
  try {
    const cancelled = await requestMigrationOperation(
      epoch,
      requestMigrationCancel(current.operationId, { reason: "user_cancelled" }),
    );
    if (!cancelled) return;
    if (cancelled.state !== "cancelled") throw new Error(`取消结果异常：${cancelled.state}`);
    resetForNewCheck();
    trackProductEvent("workspace_migration_result", { status: "cancelled", source: "workspace_manager" });
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "返回修改前取消检查失败");
  } finally {
    if (isActiveModalRequest(epoch)) cancelling.value = false;
  }
}

/** 请求 Client 重新核对恢复证据，恢复方向仍由 Client 决定。 */
async function retryRecovery(): Promise<void> {
  const current = operation.value;
  if (!current) return;
  const epoch = modalEpoch;
  recovering.value = true;
  errorText.value = null;
  errorCode.value = null;
  try {
    const loaded = await requestMigrationOperation(
      epoch,
      requestMigrationRecover(current.operationId),
    );
    if (!loaded) return;
    operation.value = loaded;
    operationReferenceId.value = loaded.operationId;
    if (shouldPoll(loaded)) schedulePoll(700);
    trackProductEvent("workspace_migration_result", { status: "recovery_started", source: "workspace_manager" });
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "重试恢复失败");
  } finally {
    if (isActiveModalRequest(epoch)) recovering.value = false;
  }
}

/** 终态后重置表单，新检查使用新的 idempotencyKey。 */
function resetForNewCheck(): void {
  operation.value = null;
  operationReferenceId.value = null;
  startResolutionPending.value = false;
  idempotencyKey.value = createBrowserUuid();
  externalWritesPausedConfirmed.value = false;
  targetNotSyncManagedConfirmed.value = false;
  errorText.value = null;
  errorCode.value = null;
  clearPollTimer();
}

/** 重建迁移完成后的文件索引；接口成功只表示已排队。 */
async function rebuildIndex(): Promise<void> {
  const epoch = modalEpoch;
  reindexing.value = true;
  errorText.value = null;
  errorCode.value = null;
  let rebuildQueued = false;
  try {
    const result = await rebuildFsIndex(ctx.value, { workspaceId: workspaceId.value });
    if (!isActiveModalRequest(epoch)) return;
    if (!result.ok) throw new Error(result.message);
    message.success("文件索引重建已排队");
    rebuildQueued = true;
    trackProductEvent("workspace_migration_result", { status: "index_rebuild_queued", source: "workspace_manager" });
    await workspaces.refresh(ctx.value);
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, rebuildQueued ? "文件索引已排队，但工作区状态刷新失败" : "文件索引重建失败", !rebuildQueued);
  } finally {
    if (isActiveModalRequest(epoch)) reindexing.value = false;
  }
}

/** 复制目标路径并显式反馈浏览器剪贴板失败。 */
async function copyTargetPath(): Promise<void> {
  const epoch = modalEpoch;
  const targetPath = operation.value?.targetPath ?? targetPathPreview.value;
  try {
    await copyToClipboard(targetPath);
    if (!isActiveModalRequest(epoch)) return;
    message.success("新目录路径已复制");
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    setRequestError(error, "复制新目录路径失败", false);
  }
}

/** 迁移完成后先保存当前草稿，再刷新列表和当前页面。 */
async function saveAndReload(): Promise<void> {
  const epoch = modalEpoch;
  reloadPending.value = true;
  errorText.value = null;
  errorCode.value = null;
  try {
    await config.reloadCurrentWorkspacePage(
      () => workspaces.refresh(ctx.value),
      () => isActiveModalRequest(epoch),
    );
  } catch (error) {
    if (!isActiveModalRequest(epoch)) return;
    const reason = error instanceof Error && error.message ? `：${error.message}` : "";
    errorText.value = `迁移已完成，但页面尚未切换；保存草稿失败，请重试${reason}`;
    errorCode.value = isApiResultError(error) ? error.code : null;
  } finally {
    if (isActiveModalRequest(epoch)) reloadPending.value = false;
  }
}

/** 关闭弹窗不取消 Client 后台迁移。 */
function closeModal(): void {
  invalidateModalRequests();
  pickerOpen.value = false;
  emit("update:open", false);
}

/** 接收同一 Client 的目标父目录选择。 */
function onDirectoryPicked(path: string): void {
  targetParentPath.value = path;
  idempotencyKey.value = createBrowserUuid();
}

/** 安排下一次权威详情查询。 */
function schedulePoll(delay = 1_500): void {
  clearPollTimer();
  if (!props.open || !operation.value || !shouldPoll(operation.value)) return;
  pollTimer = window.setTimeout(() => void queryOperation(), delay);
}

/** 清理当前弹窗轮询定时器。 */
function clearPollTimer(): void {
  if (pollTimer == null) return;
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

/** 立即作废当前代次请求并停止轮询。 */
function invalidateModalRequests(): void {
  modalEpoch += 1;
  clearPollTimer();
}

/** 仅允许当前打开代次处理异步结果。 */
function isActiveModalRequest(epoch: number): boolean {
  return epoch === modalEpoch && props.open;
}

/** 校验迁移响应仍属于当前弹框后，再同步 Store 和局部状态。 */
async function requestMigrationOperation(
  epoch: number,
  request: Promise<ApiResult<WorkspaceDirectoryMigrationOperationResponse>>,
): Promise<WorkspaceDirectoryMigrationOperation | null> {
  const response = await request;
  if (!isActiveModalRequest(epoch)) return null;
  if (!response.ok) throw createApiResultError(response);
  workspaces.setMigrationOperation(response.operation);
  if (response.operation.state === "completed" && lastTrackedMigrationCompletionId.value !== response.operation.operationId) {
    lastTrackedMigrationCompletionId.value = response.operation.operationId;
    trackProductEvent("workspace_migration_result", { status: "success", source: "workspace_manager" });
  }
  return response.operation;
}

/** 自动推进、启动确认或活动阻断期间持续查询权威状态。 */
function shouldPoll(value: WorkspaceDirectoryMigrationOperation): boolean {
  return startResolutionPending.value
    || value.state === "scanning"
    || value.state === "preparing"
    || value.state === "copying"
    || value.state === "verifying"
    || value.state === "publish_intent"
    || value.state === "target_ready"
    || value.state === "path_committed"
    || value.state === "finalizing"
    || (value.state === "awaiting_confirmation" && (
      value.startDisposition === "prepared"
      || value.blockers.length > 0
      || value.sharedBlockers.length > 0
    ));
}

/** 保留稳定 error code；迁移链路默认上报失败，辅助操作可显式关闭。 */
function setRequestError(error: unknown, fallback: string, trackMigrationFailure = true): void {
  const code = isApiResultError(error) ? error.code : null;
  errorCode.value = code;
  errorText.value = code && isMigrationErrorCode(code)
    ? MIGRATION_FAILURE_FALLBACKS[code]
    : safeFailureMessage(error instanceof Error ? error.message : "", fallback);
  if (trackMigrationFailure) {
    trackProductEvent("workspace_migration_result", {
      status: "failed",
      source: "workspace_manager",
      error_code_group: code ?? "request_error",
    });
  }
}

/** 从不可信失败详情中读取可展示的短文本，避免把 stderr 等诊断内容带入页面。 */
function readFailureDetail(key: "relativePath" | "reparseType"): string {
  const details = operation.value?.errorDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>)[key];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (key === "reparseType") {
    return /^[\p{L}\p{N} ._()-]{1,64}$/u.test(trimmed) ? trimmed : "";
  }
  return safeRelativePath(trimmed) ?? "";
}

/** 读取源变更证据中的相对路径，并限制展示数量和路径形态。 */
function readFailureChangedPaths(): string[] {
  const details = operation.value?.errorDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const sourceChangedPaths = (details as Record<string, unknown>).sourceChangedPaths;
  const boundedSourceChangedPaths = Array.isArray(sourceChangedPaths) ? sourceChangedPaths.slice(0, 50) : [];
  const values = [
    ...boundedSourceChangedPaths,
    (details as Record<string, unknown>).relativePath,
  ];
  return [...new Set(values
    .map((value) => safeRelativePath(value))
    .filter((value): value is string => Boolean(value)))].slice(0, 50);
}

/** 只展示规范化后的工作区相对路径，拒绝绝对路径和路径穿越。 */
function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized
    || normalized.length > 1_000
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.startsWith("/")
    || /^[a-z]:/iu.test(normalized)
    || parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return normalized.slice(0, 1_000);
}

/** 把结构化失败事实转换为明确、可操作的用户原因。 */
function describeMigrationFailure(value: WorkspaceDirectoryMigrationOperation | null): string {
  if (!value) return "";
  if (value.state === "cancelled") return "迁移已取消，工作区仍使用原目录。";
  const changedPaths = readFailureChangedPaths();
  if (value.errorCode === "WORKSPACE_MIGRATION_SOURCE_CHANGED" && changedPaths.length) {
    return `迁移期间检测到源目录内容发生变化，变化位置：${changedPaths.join("、")}。请停止外部写入后重新检查。`;
  }
  if (value.errorCode === "WORKSPACE_MIGRATION_SOURCE_CHANGED") {
    return "迁移期间检测到源目录摘要发生变化，但无法定位具体文件。请停止外部写入后重新检查。";
  }
  const reason = value.errorDetails && typeof value.errorDetails === "object" && !Array.isArray(value.errorDetails)
    ? String((value.errorDetails as Record<string, unknown>).reason ?? "")
    : "";
  const reparseType = readFailureDetail("reparseType").toLowerCase();
  if (reason === "windows_reparse_unsupported" && reparseType === "junction") {
    return "检测到可重新生成目录之外的 Windows 目录联接（Junction）。该目录可能承载真实数据，一期迁移不会跳过；请移除目录联接或改为工作区内的普通目录后重试。";
  }
  if (reason === "windows_reparse_probe_failed") {
    return "Client 无法完成 Windows 重解析点检查，尚未开始复制；请使用操作编号查询 Client 日志后重试。";
  }
  if (value.errorCode && isMigrationErrorCode(value.errorCode)) {
    return MIGRATION_FAILURE_FALLBACKS[value.errorCode];
  }
  return safeFailureMessage(
    String(value.errorMessage ?? ""),
    "Client 未提供可识别的失败原因；工作区目录未切换，请使用操作编号查询 Client 日志后重试。",
  );
}

/** 判断错误码是否属于迁移协议定义的完整集合。 */
function isMigrationErrorCode(value: string): value is WorkspaceDirectoryMigrationErrorCode {
  return MIGRATION_ERROR_CODE_SET.has(value);
}

/** 过滤可能含本机路径或 stderr 的未知错误文本，并为模糊消息提供可操作说明。 */
function safeFailureMessage(message: string, fallback: string): string {
  const normalized = message.trim().replace(/\s+/gu, " ").slice(0, 500);
  if (!normalized
    || /^(失败|迁移失败|操作失败)[。.!！]?$/u.test(normalized)
    || /(?:\\\\\?\\)?[a-z]:[\\/]/iu.test(normalized)
    || /(?:^|\s)stderr\s*[:=]/iu.test(normalized)) {
    return fallback;
  }
  return normalized;
}

/** 按目标平台路径风格拼接父目录与目录名。 */
function joinDirectoryPath(parent: string, name: string): string {
  const normalizedParent = parent.trim().replace(/[\\/]+$/u, "");
  const normalizedName = name.trim();
  if (!normalizedParent) return normalizedName;
  if (!normalizedName) return normalizedParent;
  return `${normalizedParent}${normalizedParent.includes("\\") ? "\\" : "/"}${normalizedName}`;
}

/** 提取跨平台路径最后一级名称。 */
function baseName(path: string): string {
  return path.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

/** 提取跨平台父目录，根目录输入保持原值。 */
function parentDirectory(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

/** 将字节数格式化为可扫描的二进制单位。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** 映射持久 phase 为用户可见阶段。 */
function formatPhase(phase: WorkspaceDirectoryMigrationOperation["phase"]): string {
  const labels: Record<WorkspaceDirectoryMigrationOperation["phase"], string> = {
    checking: "检查",
    preparing: "准备",
    copying: "复制",
    verifying: "校验",
    committing: "切换",
    finalizing: "收尾",
    recovery: "恢复",
    completed: "完成",
    cancelled: "已取消",
    failed: "失败",
  };
  return labels[phase];
}

/** 映射 phase 到五段进度条位置。 */
function resolveStep(phase: WorkspaceDirectoryMigrationOperation["phase"]): number {
  if (phase === "checking" || phase === "preparing") return 0;
  if (phase === "copying") return 1;
  if (phase === "verifying") return 2;
  if (phase === "committing" || phase === "finalizing" || phase === "recovery") return 3;
  return 4;
}
</script>

<template>
  <a-modal
    :open="open"
    :width="720"
    :mask-closable="false"
    :footer="null"
    :body-style="{ padding: '0 12px 24px', overflow: 'hidden' }"
    centered
    title="迁移工作区目录"
    @cancel="closeModal"
  >
    <div class="migration-modal" :aria-busy="busy || reindexing">
      <div class="migration-modal__facts">
        <div><span>工作区</span><strong>{{ currentTitle }}</strong></div>
        <div><span>所属 Client</span><strong>{{ client?.name || client?.clientId || "当前不可达" }}</strong></div>
        <div><span>当前目录</span><code>{{ currentPath || "暂无法确认" }}</code></div>
      </div>

      <a-alert
        v-if="errorText"
        type="error"
        show-icon
        :message="errorText"
        :description="errorCode ? `错误编号：${errorCode}` : undefined"
      />

      <section v-if="isTargetForm" class="migration-modal__section">
        <a-alert
          type="warning"
          show-icon
          message="迁移前请先停止工作区活动"
          description="请检查并停止此工作区内正在执行的会话、流程、终端和后台任务，未停止的活动会在迁移过程中修改工作区文件，导致迁移校验失败。"
        />
        <a-form layout="vertical">
          <a-form-item label="目标父目录">
            <div class="migration-modal__path-row">
              <a-input v-model:value="targetParentPath" autocomplete="off" placeholder="请选择工作区所属 Client 上的本机固定磁盘目录" />
              <a-button :disabled="!client" @click="pickerOpen = true">
                <template #icon><FolderOpenOutlined /></template>
                选择
              </a-button>
            </div>
          </a-form-item>
          <a-form-item label="新目录名称">
            <a-input v-model:value="targetDirectoryName" aria-label="新目录名称" autocomplete="off" />
          </a-form-item>
        </a-form>
        <div class="migration-modal__target">
          <span>迁移后目录</span>
          <code>{{ targetPathPreview || "待填写" }}</code>
        </div>
        <a-alert type="info" show-icon message="迁移成功后源目录仍会保留，不会自动删除。" />
        <a-alert
          v-if="hostedSharedName"
          type="warning"
          show-icon
          :message="`该目录承载 ${hostedSharedCount} 个共享工作区（${hostedSharedName}），迁移期间成员入口会进入维护态。`"
        />
      </section>

      <section v-else-if="isQueryUnavailable" class="migration-modal__section migration-modal__section--status">
        <a-result status="warning" title="暂时无法查询迁移状态" sub-title="迁移不会因关闭弹窗或 WebSocket 重连而停止，请重新查询权威状态后继续操作。" />
      </section>

      <section v-else class="migration-modal__section migration-modal__section--status">
        <template v-if="isChecking">
          <a-result status="info" title="正在检查迁移条件" sub-title="Client 正在扫描文件、目录、存储类型、空间和活动资源。" />
        </template>

        <template v-else-if="isAwaitingConfirmation">
          <div class="migration-modal__heading">迁移条件检查通过</div>
          <div class="migration-modal__summary">
            <div><span>文件与目录</span><strong>{{ operationItemCount.toLocaleString("zh-CN") }} 项</strong></div>
            <div><span>数据大小</span><strong>{{ formatBytes(operation?.sourceTotalBytes ?? 0) }}</strong></div>
            <div><span>迁移后目录</span><code>{{ operation?.targetPath }}</code></div>
            <div v-if="excludedDependencyDirectoryCount"><span>排除可重新生成目录</span><strong>{{ excludedDependencyDirectoryCount.toLocaleString("zh-CN") }} 个</strong></div>
          </div>
          <a-alert
            v-if="excludedDependencyDirectoryCount"
            type="warning"
            show-icon
            message="可重新生成目录不会迁移"
            :description="excludedDependencyDescription"
          />
          <a-checkbox v-model:checked="externalWritesPausedConfirmed">
            我已暂停 IDE、构建和文件同步软件对源目录的写入。
          </a-checkbox>
          <a-checkbox v-model:checked="targetNotSyncManagedConfirmed">
            目标未被同步软件托管，且迁移完成前我不会访问目标路径。
          </a-checkbox>
        </template>

        <template v-else-if="isConfirmingStart">
          <a-result status="info" title="正在确认启动状态" sub-title="正在与 Client 对账本次启动结果，确认前共享入口保持维护态。" />
        </template>

        <template v-else-if="isRunning">
          <a-steps
            size="small"
            :current="currentStep"
            :items="[
              { title: '检查' },
              { title: '复制' },
              { title: '校验' },
              { title: '切换' },
              { title: '完成' },
            ]"
          />
          <div class="migration-modal__progress-head">
            <strong>{{ phaseLabel }}</strong>
            <span>{{ formatBytes(operation?.copiedBytes ?? 0) }} / {{ formatBytes(operation?.sourceTotalBytes ?? 0) }}</span>
          </div>
          <a-progress :percent="Math.max(0, Math.min(100, operation?.progressPct ?? 0))" :status="isRecoveryRequired ? 'exception' : 'active'" />
          <a-alert type="info" show-icon :message="`当前生效目录：${operation?.currentPath || currentPath}`" />
        </template>

        <template v-else-if="isRecoveryRequired">
          <a-result status="warning" title="工作区需要恢复" sub-title="为避免写入错误目录，该工作区已暂停写操作；恢复方向由 Client 根据持久证据决定。" />
          <div class="migration-modal__summary">
            <div><span>操作编号</span><code>{{ operation?.operationId }}</code></div>
            <div><span>当前生效目录</span><code>{{ operation?.currentPath || "暂无法安全确认" }}</code></div>
            <div><span>源目录</span><code>{{ operation?.sourcePath }}</code></div>
            <div><span>目标目录</span><code>{{ operation?.targetPath }}</code></div>
          </div>
        </template>

        <template v-else-if="isCompleted">
          <a-result status="success" title="迁移完成" sub-title="工作区已经切换到新目录，源目录仍保留。" />
          <div class="migration-modal__summary">
            <div><span>当前目录</span><code>{{ operation?.targetPath }}</code></div>
            <div><span>源目录保留于</span><code>{{ operation?.sourcePath }}</code></div>
            <div><span>文件索引</span><strong>{{ indexWarning ? "重建失败" : indexPending ? "后台重建中" : "已就绪" }}</strong></div>
            <div v-if="excludedDependencyDirectoryCount"><span>未复制可重新生成目录</span><strong>{{ excludedDependencyDirectoryCount.toLocaleString("zh-CN") }} 个</strong></div>
          </div>
          <a-alert v-if="indexWarning" type="warning" show-icon message="工作区已切换，但文件搜索暂不可用；请重新触发索引重建。" />
          <a-alert
            v-if="excludedDependencyDirectoryCount"
            type="warning"
            show-icon
            message="请重新安装依赖并重新构建项目"
            :description="excludedDependencyDescription"
          />
          <a-alert type="info" show-icon message="请在外部 IDE 和终端重新打开新目录，确认项目正常后再自行处理源目录。" />
        </template>

        <template v-else-if="isFailed">
          <a-result
            :status="operation?.state === 'cancelled' ? 'info' : 'error'"
            :title="operation?.state === 'cancelled' ? '迁移已取消' : '迁移未完成'"
            sub-title="工作区仍使用安全确认的目录。"
          />
          <div class="migration-modal__summary">
            <div><span>失败阶段</span><strong>{{ phaseLabel }}</strong></div>
            <div v-if="failureCause"><span>失败原因</span><strong>{{ failureCause }}</strong></div>
            <div><span>当前生效目录</span><code>{{ operation?.currentPath || operation?.sourcePath }}</code></div>
            <div v-if="failureRelativePath"><span>问题位置</span><code :title="failureRelativePath">{{ failureRelativePath }}</code></div>
            <div v-if="failureChangedPaths.length"><span>变化位置</span><code :title="failureChangedPaths.join('、')">{{ failureChangedPaths.join("、") }}</code></div>
            <div v-if="failureReparseType"><span>重解析点类型</span><code>{{ failureReparseType }}</code></div>
            <div v-if="operation?.errorCode"><span>错误编号</span><code>{{ operation.errorCode }}</code></div>
            <div v-if="operation?.operationId"><span>操作编号</span><code>{{ operation.operationId }}</code></div>
          </div>
        </template>

        <div v-if="blockers.length" class="migration-modal__blockers">
          <div class="migration-modal__heading">需要先处理</div>
          <div v-for="blocker in blockers" :key="`${blocker.code}:${blocker.message}`" class="migration-modal__blocker">
            <code>{{ blocker.code }}</code>
            <span>{{ blocker.message }}</span>
          </div>
        </div>
      </section>

      <div class="migration-modal__footer">
        <span class="migration-modal__footer-note">关闭弹窗不会取消后台迁移。</span>
        <a-space :size="12" wrap>
          <a-button v-if="showFooterClose" @click="closeModal">关闭</a-button>
          <a-button v-if="isTargetForm" type="primary" :loading="preparing" :disabled="!client" @click="checkTarget">检查目标</a-button>
          <a-button v-if="isChecking && operation?.canCancel" :loading="cancelling" @click="confirmCancel">取消检查</a-button>
          <a-button v-if="isAwaitingConfirmation" :loading="cancelling" @click="returnToEdit">返回修改</a-button>
          <a-button v-if="isAwaitingConfirmation" type="primary" :loading="starting" :disabled="!canStart" @click="startMigration">开始迁移</a-button>
          <a-button v-if="(isRunning || isConfirmingStart) && operation?.canCancel" danger :loading="cancelling" @click="confirmCancel">取消迁移</a-button>
          <a-button v-if="isRecoveryRequired" type="primary" :loading="recovering" @click="retryRecovery">重试恢复</a-button>
          <a-button v-if="isFailed" type="primary" @click="resetForNewCheck">重新检查</a-button>
          <a-button v-if="errorText && operationReferenceId" :loading="querying" @click="queryOperation">
            <template #icon><ReloadOutlined /></template>
            重新查询
          </a-button>
          <a-button v-if="isCompleted" @click="copyTargetPath">
            <template #icon><CopyOutlined /></template>
            复制新路径
          </a-button>
          <a-button v-if="isCompleted && indexWarning" :loading="reindexing" @click="rebuildIndex">重建索引</a-button>
          <a-button v-if="isCompleted && isCurrentWorkspace" type="primary" :loading="reloadPending" @click="saveAndReload">保存并刷新页面</a-button>
        </a-space>
      </div>
    </div>
  </a-modal>

  <ClientDirectoryPickerModal
    v-model:open="pickerOpen"
    :client-id="client?.clientId ?? ''"
    :initial-value="targetParentPath"
    @pick="onDirectoryPicked"
  />
</template>

<style scoped>
.migration-modal {
  height: min(560px, calc(100dvh - 88px));
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.migration-modal__facts,
.migration-modal__summary {
  display: grid;
  gap: 8px;
}

.migration-modal__facts > div,
.migration-modal__summary > div,
.migration-modal__target,
.migration-modal__current-file {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.migration-modal__facts span,
.migration-modal__summary span,
.migration-modal__target span,
.migration-modal__current-file span {
  color: var(--app-muted);
}

.migration-modal code {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--app-text);
}

.migration-modal__summary strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.migration-modal__section {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 14px 2px 4px;
  border-top: 1px solid var(--app-divider);
}

.migration-modal__section :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}

.migration-modal__section :deep(.ant-result) {
  padding: 12px;
}

.migration-modal__section :deep(.ant-result-icon) {
  margin-bottom: 12px;
}

.migration-modal__section :deep(.ant-result-icon > .anticon) {
  font-size: 56px;
}

.migration-modal__path-row {
  display: flex;
  gap: 8px;
}

.migration-modal__path-row :deep(.ant-input) {
  min-width: 0;
}

.migration-modal__target {
  padding: 10px 12px;
  border: 1px solid var(--app-divider);
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-bg));
}

.migration-modal__heading {
  font-size: 15px;
  font-weight: 700;
  color: var(--app-text);
}

.migration-modal__progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--app-muted);
}

.migration-modal__blockers {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--app-divider);
}

.migration-modal__blocker {
  display: grid;
  grid-template-columns: minmax(150px, auto) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.migration-modal__footer {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 4px 0;
  border-top: 1px solid var(--app-divider);
}

.migration-modal__footer-note {
  color: var(--app-muted);
  font-size: 12px;
}

@media (max-width: 767px) {
  .migration-modal {
    height: min(560px, calc(100dvh - 88px));
  }

  .migration-modal__facts > div,
  .migration-modal__summary > div,
  .migration-modal__target,
  .migration-modal__current-file,
  .migration-modal__blocker {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }

  .migration-modal__path-row,
  .migration-modal__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .migration-modal__footer :deep(.ant-space) {
    width: 100%;
  }
}
</style>
