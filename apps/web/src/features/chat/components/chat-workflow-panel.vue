<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ExternalLink, Play, Pause, Square, Check, RotateCcw, FileText, LoaderCircle, Circle, X, Ban, ChevronDown, ChevronUp, EyeOff, Trash2 } from "lucide-vue-next";
import { message } from "ant-design-vue";
import { FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons-vue";
import type { ChatWorkflowActionInput, ChatWorkflowSnapshot, ChatWorkflowTodo, ChatWorkflowView, NodeExecutionState, OrchestrationId, WorkflowNode, WorkspaceId, ThreadId } from "@codeflowai/shared";
import { CHAT_WORKFLOW_ACTIVE_STATUSES } from "@codeflowai/shared";
import { useApiContext } from "../../../composables/useApiContext";
import { actOnChatWorkflow, deleteChatWorkflow, getChatWorkflow, planChatWorkflowRework } from "../../../api/chatWorkflow";
import { getOrchArtifact, listOrchArtifactFiles } from "../../../api/orchestration";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useRequirementAnalysisStore } from "../../../store/requirementAnalysis";
import { useChatStore } from "../../../store/chat";
import { usePresenceStore } from "../../../store/presence";
import { useConfigStore } from "../../../store/config";
import { createApiResultError, isCancelledRequestError } from "../../../api/request";
import { chatWorkflowPollDelay } from "../chatWorkflowPolling";
import ArtifactFilePreview from "../../orchestration/components/artifact-file-preview.vue";
import NodeExecutionDetail from "../../orchestration/components/node-execution-detail.vue";
import { buildArtifactPresentation, type ArtifactPresentationFile } from "../../orchestration/components/artifact-preview-utils";
import { isRunningLikeStatus, nodeStatusLabel } from "../../orchestration/node-workbench";
import { isWorkflowTerminalNodeType } from "../../orchestration/workflow-node-cards";
import { isChatWorkflowCardFoldable, isChatWorkflowCardFolded, visibleChatWorkflowCards } from "../chatWorkflowCardFold";
import { hideChatWorkflowCard, hiddenWorkflowTaskIds } from "../hiddenWorkflowCards";
import { isDesktopWorkspace } from "../../../services/desktop";
import { createBrowserUuid } from "../../../utils/browserUuid";

const props = defineProps<{ workspaceId: WorkspaceId; threadId: ThreadId; readOnly?: boolean; replyRunning?: boolean }>();
const { ctx } = useApiContext();
const orch = useOrchestrationStore();
const analysis = useRequirementAnalysisStore();
const chat = useChatStore();
const presence = usePresenceStore();
const config = useConfigStore();
const router = useRouter();
const snapshot = ref<ChatWorkflowSnapshot>({ recommendationEnabled: false, tasks: [] });
const busy = ref(false);
const error = ref("");
const feedback = ref<Record<string, string>>({});
const branches = ref<Record<string, string>>({});
const reworkTask = ref<ChatWorkflowView | null>(null);
const reworkNode = ref("");
const reworkReason = ref("");
const artifactPreview = ref<ArtifactPresentationFile | null>(null);
const artifactTitle = ref("");
const artifactPreviewFullscreen = ref(false);
const stageDetail = ref<{
  instanceId: OrchestrationId;
  nodeId: string;
  title: string;
  nodeState: NodeExecutionState | null;
  node: WorkflowNode | null;
  workflowNodes: WorkflowNode[];
  loading: boolean;
  error: string | null;
} | null>(null);
const emptyStagePreview = buildArtifactPresentation(null);
const stageDetailFullscreen = ref(false);
let generation = 0;
let refreshSequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let requestController: AbortController | null = null;
let pollInFlight = false;
let pollAgain = false;
let failures = 0;
let failureCode: string | null = null;
let panelActive = true;
// 运行中节点的耗时按秒递增；常开定时器只用于驱动本面板重渲染。
const now = ref(Date.now());
const ticker = setInterval(() => { now.value = Date.now(); }, 1000);
const tasks = computed(() => snapshot.value.tasks.filter(v => v.task.state !== "superseded"
  && (v.task.state !== "dismissed" || !v.continuation || ["pending", "sending", "failed"].includes(v.continuation.status))));
/** 本机已隐藏的卡片 id 集合（localStorage 按会话，刷新与切回会话都仍命中）。 */
const hiddenTaskIds = computed(() => hiddenWorkflowTaskIds(props.threadId));
/** 回复期间隐藏卡片；结束后从已加载快照中过滤本机隐藏的卡片。 */
const visibleTasks = computed(() => props.replyRunning
  ? []
  : visibleChatWorkflowCards(tasks.value, hiddenTaskIds.value));
/** 用户手动展开过的卡片 id；默认折叠态完全由判定函数推出，这里只记「点开过」的。 */
const expandedTaskIds = ref<Set<string>>(new Set());
/** 该卡是否可折叠成一行摘要（已结束、无待办、无待确认返工）。 */
function isFoldable(view: ChatWorkflowView): boolean { return isChatWorkflowCardFoldable(view); }
/** 该卡当前是否处于折叠态：可折叠且用户未手动展开。 */
function isFolded(view: ChatWorkflowView): boolean { return isChatWorkflowCardFolded(view, expandedTaskIds.value); }
/**
 * 切换单卡的展开态。写时复制：轮询只替换 snapshot 引用，按稳定 task.id 索引的集合不受影响。
 * 不清理已失效的 id：后端瞬时返回部分列表时清理会吞掉用户刚点开的展开，会话切换即整体释放。
 */
function toggleCardExpanded(taskId: string): void {
  const next = new Set(expandedTaskIds.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  expandedTaskIds.value = next;
}
/** 本机隐藏该卡：仅记显示偏好，不删业务记录；只读会话下入口与执行双守卫。 */
function hideCard(taskId: string): void {
  if (props.readOnly) return;
  hideChatWorkflowCard(props.threadId, taskId);
}
function continuationMessage(view: ChatWorkflowView): string {
  if (!view.continuation) return "已选择在当前会话处理，但尚未提交续跑任务。点击下方按钮继续。";
  if (view.continuation.status === "failed") return `会话续跑发送失败：${view.continuation.failureReason || "请查看会话队列中的失败原因"}`;
  if (view.continuation.paused) return "已交回当前会话，消息队列已暂停，请在会话队列中继续发送。";
  return view.continuation.status === "sending" ? "正在当前会话中启动执行。" : "已交回当前会话，等待前序消息完成后执行。";
}
const statusLabels: Record<string, string> = { pending: "等待执行", running: "执行中", paused: "已暂停", "waiting-start": "待启动", "waiting-approval": "待审核", "waiting-feedback": "待补充", completed: "执行完成", failed: "执行失败", cancelled: "已终止", queued: "排队中", skipped: "已跳过", ready: "待执行" };
function label(view: ChatWorkflowView): string {
  if (view.accepted) return "验收通过";
  if (view.status === "completed") return "执行完成，待验收";
  return view.status ? statusLabels[view.status] ?? view.status : view.task.state === "starting" ? "正在启动" : "待确认使用";
}
/** 状态标签配色：验收通过为绿、执行失败为红，其余走中性色。 */
function labelColor(view: ChatWorkflowView): string {
  if (view.accepted) return "green";
  return view.status === "failed" ? "red" : "default";
}
/** 流程是否处于活跃状态（可暂停）。 */
function isActive(view: ChatWorkflowView): boolean {
  return Boolean(view.status && CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status));
}
/** 待办的稳定键：跨卡片区分同一节点。 */
function todoKey(view: ChatWorkflowView, todo: ChatWorkflowTodo): string {
  return `${view.task.id}:${todo.nodeId}:${todo.version}`;
}
/**
 * 可由会话框裸文本直接提交的唯一待补充待办键；空串表示不能，卡片须保留内联控件。
 * 三条件缺一不可，缺任一「请在会话框补充」都会变成假话：
 * 1) 含 resume_with_input —— 服务端只在 else 分支对这类待办做裸文本路由；
 * 2) 全局此类待办恰好 1 个 —— 与 store 的 hasSingleInputTodo 同口径；
 * 3) 所在流程 isActive —— 对齐服务端 active 过滤。
 * 必须读 snapshot.value.tasks 而非模板的 tasks（剔掉了 superseded / 已丢弃的 dismissed），
 * 否则「实际 2 个」会被误判为唯一，从而错误地隐藏控件。
 * 同理也不得改读 visibleTasks：它还剔掉了已折叠隐藏的卡，会让被隐藏卡上的待办漏算。
 */
const composerInputKey = computed(() => {
  const candidates = snapshot.value.tasks.flatMap(view => view.todos
    // 门禁待办的选项是「重新评估 / 忽略门禁继续」，必须留在卡片上：被会话框接管会连按钮一起隐藏。
    .filter(todo => todo.actions.some(a => a.action === "resume_with_input")
      && !todo.actions.some(a => a.action === "override"))
    .map(todo => ({ view, todo })));
  if (candidates.length !== 1) return "";
  const { view, todo } = candidates[0]!;
  return isActive(view) ? todoKey(view, todo) : "";
});
/** 该待办已改由会话框补充：命中唯一键时隐藏内联输入与其自身动作按钮。readOnly 下不接管。 */
function isComposerInput(view: ChatWorkflowView, todo: ChatWorkflowTodo): boolean {
  return !props.readOnly && composerInputKey.value !== "" && composerInputKey.value === todoKey(view, todo);
}
/**
 * 可由会话框「审核通过：意见」直接提交的唯一待审核待办键；空串表示不能。
 * 判据与 composerInputKey 同构（含 approve 动作、全局恰好 1 个、所在流程 isActive），
 * 只读 snapshot.value.tasks 而非模板 tasks，避免「实际 2 个」被误判为唯一。
 * 多个待审核时前缀无法指向具体待办，提示会是假话，故只有唯一时才接管。
 */
const composerApprovalKey = computed(() => {
  const candidates = snapshot.value.tasks.flatMap(view => view.todos
    .filter(todo => todo.actions.some(a => a.action === "approve"))
    .map(todo => ({ view, todo })));
  if (candidates.length !== 1) return "";
  const { view, todo } = candidates[0]!;
  return isActive(view) ? todoKey(view, todo) : "";
});
/** 该待办可在会话框批准：只隐藏内联 textarea，动作按钮与分支选择保留。readOnly 下不接管。 */
function isComposerApproval(view: ChatWorkflowView, todo: ChatWorkflowTodo): boolean {
  return !props.readOnly && composerApprovalKey.value !== "" && composerApprovalKey.value === todoKey(view, todo);
}
type ChatWorkflowStage = ChatWorkflowView["stages"][number];
/** 流程条节点的视觉分档：已终结、进行中、等待人工、失败、已取消、未到达。 */
type StageTone = "done" | "running" | "attention" | "failed" | "cancelled" | "idle";
/** 已完成或跳过的节点算已终结。 */
function isStageFinished(status: ChatWorkflowStage["status"]): boolean {
  return status === "completed" || status === "skipped";
}
/** 节点视觉分档：失败/已取消/已终结优先于「进行中」判定，未到达的归 idle。 */
function stageToneOf(stage: ChatWorkflowStage): StageTone {
  if (isStageFinished(stage.status)) return "done";
  if (stage.status === "failed") return "failed";
  if (stage.status === "cancelled") return "cancelled";
  // 三种等待人工的状态由人推进，仍归「进行中」一档，与监控口径一致。
  if (stage.status === "waiting-start" || stage.status === "waiting-approval" || stage.status === "waiting-feedback") return "attention";
  if (isRunningLikeStatus(stage.status)) return "running";
  return "idle";
}
/** 该节点累计执行耗时文案：无执行区间时为空串，维持原状态文案。 */
function activeDurationText(stage: ChatWorkflowStage): string {
  const closed = Math.max(0, stage.activeMs ?? 0);
  const open = stage.activeSinceAt == null ? 0 : Math.max(0, now.value - stage.activeSinceAt);
  // 未执行过的节点不显示 0s；仍在执行的节点即使不足 1 秒也要显示数字。
  return closed > 0 || stage.activeSinceAt != null ? formatActiveDuration(closed + open) : "";
}
/** 耗时格式：不足 1 分钟 `45s`、不足 1 小时 `3m 07s`、超过 1 小时 `1h 05m`。 */
function formatActiveDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
/** 流程条渲染项：分档、文案、错误提示与连线着色一次算好，避免模板内重复求值。 */
/** 并行分支序号用带圈数字，超出十个时退回 #n，保证再长的分支也能标出归属。 */
const BRANCH_BADGES = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function stageItems(view: ChatWorkflowView) {
  return view.stages.map((stage, index) => {
    const tone = stageToneOf(stage);
    const statusText = nodeStatusLabel(stage.status);
    const previous = view.stages[index - 1];
    const branchIndex = typeof stage.parallelBranchIndex === "number" ? stage.parallelBranchIndex : null;
    return {
      ...stage,
      tone,
      // 未到达的节点不转圈，避免整列一起转。
      spinning: tone === "running" || tone === "attention",
      statusText,
      // 耗时与状态同行内联，节点高度不变。
      statusLine: [statusText, activeDurationText(stage)].filter(Boolean).join(" · "),
      title: [stage.label, statusText, stage.error].filter(Boolean).join(" · "),
      arrowDone: previous ? isStageFinished(previous.status) : false,
      terminal: isWorkflowTerminalNodeType(stage.nodeType),
      // 分支起点前用 ∥：它标志「这里开始并列」；同一分支内部仍是先后关系，照画箭头。
      // 起点由服务端按展示顺序标出——分支在数组里可能交错，用相邻序号比较会误判。
      parallelLink: stage.isBranchStart === true,
      // 分支内每个节点都带序号，避免后续节点看不出自己属于哪一支。
      branchBadge: branchIndex === null ? null : (BRANCH_BADGES[branchIndex] ?? `#${branchIndex + 1}`),
    };
  });
}
/** 点流程条节点立即打开弹框，实例和详情在框内加载。 */
async function openStageDetail(view: ChatWorkflowView, stage: ChatWorkflowStage) {
  const instanceId = view.task.instanceId;
  if (!instanceId) { message.info("工作流尚未启动，暂无节点详情"); return; }
  stageDetail.value = {
    instanceId, nodeId: stage.nodeId, title: stage.label, nodeState: null,
    node: null, workflowNodes: [], loading: false, error: null,
  };
  await loadStageDetail();
}

/** 实例返回即展示节点；目录失败可重试，关闭或切换后禁止旧请求回写。 */
async function loadStageDetail(): Promise<void> {
  const detail = stageDetail.value;
  if (!detail || detail.loading) return;
  const scope = generation;
  const workspaceId = props.workspaceId;
  const threadId = props.threadId;
  const isCurrent = () => scope === generation && stageDetail.value === detail;
  const retry = Boolean(detail.error);
  detail.loading = true;
  detail.error = null;
  try {
    const instance = await orch.loadInstance(ctx.value, workspaceId, detail.instanceId, { loadDetails: false });
    if (!isCurrent()) return;
    if (!instance) throw new Error("运行实例不存在或已被清理，无法打开节点详情");
    const nodeState = instance.nodeStates[detail.nodeId];
    if (!nodeState) throw new Error("该节点尚未执行，暂无详情");
    const workflowNodes = instance.workflowSnapshot.nodes;
    detail.nodeState = nodeState;
    detail.node = workflowNodes.find((node) => node.id === detail.nodeId) ?? null;
    detail.workflowNodes = workflowNodes;
    await orch.ensureSelectedInstanceDetails(ctx.value, workspaceId, instance.id, {
      force: retry, allowNetworkHydration: isCurrent,
    });
  } catch (cause) {
    if (!isCurrent() || isCancelledRequestError(cause)) return;
    detail.error = cause instanceof Error ? cause.message : String(cause);
    const diagnostic = cause as { code?: string; requestId?: string; details?: { requestId?: string; serverRequestId?: string } } | null;
    console.error("[chat-workflow.node-detail.failed]", {
      code: diagnostic?.code ?? "CHAT_WORKFLOW_NODE_DETAIL_FAILED",
      requestId: diagnostic?.requestId ?? diagnostic?.details?.serverRequestId ?? diagnostic?.details?.requestId ?? null,
      workspaceId, threadId, instanceId: detail.instanceId, nodeId: detail.nodeId, rootCause: detail.error,
    });
  } finally {
    if (isCurrent()) detail.loading = false;
  }
}
/** 切换节点详情弹框的全屏态。 */
function toggleStageDetailFullscreen() { stageDetailFullscreen.value = !stageDetailFullscreen.value; }
const stageDesktopFullscreen = computed(() => stageDetailFullscreen.value && config.isDesktop);
const stageDetailWrapClass = computed(() => [
  "chat-workflow__node-detail-modal",
  stageDetailFullscreen.value ? "chat-workflow__node-detail-modal--fullscreen" : "",
  stageDesktopFullscreen.value ? "chat-workflow__node-detail-modal--desktop-fullscreen" : "",
].filter(Boolean).join(" "));
// 关闭弹框一律复位全屏态，Esc / 点遮罩 / 点 ✕ 都走 @cancel 关闭。
watch(stageDetail, (value) => { if (!value) stageDetailFullscreen.value = false; });

/** 使当前读取失效；恢复通知必须先隔离旧响应再启动新查询。 */
function invalidateCurrentRefresh(): void {
  refreshSequence++;
  requestController?.abort();
}

/** 当前请求才可回写快照；切换、隐藏或替换请求时取消旧读取。 */
async function refresh(scope = generation): Promise<void> {
  if (scope !== generation) return;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const sequence = ++refreshSequence;
  try {
    const result = await getChatWorkflow(ctx.value, props.workspaceId, props.threadId, controller.signal);
    if (scope !== generation || sequence !== refreshSequence || controller.signal.aborted) return;
    if (!result.ok) throw createApiResultError(result);
    snapshot.value = result;
    chat.setChatWorkflowSnapshot(props.threadId, result);
    error.value = "";
    failures = 0;
    failureCode = null;
  } catch (cause) {
    if (scope !== generation || sequence !== refreshSequence || controller.signal.aborted) return;
    if (isCancelledRequestError(cause)) return;
    failures++;
    failureCode = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : null;
    error.value = cause instanceof Error ? cause.message : String(cause);
    const details = (cause as { details?: { requestId?: unknown; serverRequestId?: unknown } })?.details;
    console.warn("[chat-workflow.read.failed]", { code: failureCode ?? "CHAT_WORKFLOW_FAILED", requestId: details?.serverRequestId ?? details?.requestId ?? null,
      workspaceId: props.workspaceId, threadId: props.threadId, rootCause: error.value });
  } finally {
    if (requestController === controller) requestController = null;
  }
}
/** 串行查询；通知打断退避，已有请求完成后最多追加一次刷新。 */
async function poll(scope: number) {
  if (scope !== generation || document.hidden || !panelActive
    || failureCode === "CLIENT_UPGRADE_REQUIRED") return;
  if (pollInFlight) { pollAgain = true; return; }
  clearTimeout(timer);
  pollInFlight = true;
  await refresh(scope);
  pollInFlight = false;
  if (pollAgain) { pollAgain = false; void poll(generation); return; }
  if (scope !== generation) return;
  clearTimeout(timer);
  const delay = chatWorkflowPollDelay({ visible: panelActive && !document.hidden, snapshot: snapshot.value, errorCode: failureCode, failures });
  if (delay !== null) timer = setTimeout(() => void poll(scope), delay);
}
/** 回到前台立即核对；后台取消请求和计时器。 */
function onVisibilityChanged(): void {
  clearTimeout(timer);
  if (document.hidden) requestController?.abort();
  else void poll(generation);
}
// 连接恢复先取消旧读，防止迟到结果覆盖当前状态。
watch(() => [config.connectionStatus, presence.clientForWorkspace(props.workspaceId)?.connectedAt,
  presence.runtimeStateForWorkspace(props.workspaceId).status], (current, previous) => {
  if (current[0] === "connected" && (previous[0] !== "connected" || current[1] !== previous[1]
    || current[2] === "online" && previous[2] !== "online")) {
    failures = 0; failureCode = null; invalidateCurrentRefresh(); void poll(generation);
  }
});
watch(() => [props.replyRunning, chat.threadWorkflowByThreadId[String(props.threadId)]], () => void poll(generation));
watch(() => [props.workspaceId, props.threadId], () => {
  generation++;
  stageDetail.value = null;
  invalidateCurrentRefresh();
  failures = 0; failureCode = null;
  busy.value = false;
  clearTimeout(timer);
  snapshot.value = { recommendationEnabled: false, tasks: [] };
  chat.setChatWorkflowSnapshot(props.threadId, snapshot.value);
  feedback.value = {}; branches.value = {}; reworkTask.value = null;
  // :key="thread.id" 重挂载已覆盖大部分场景，这处兜底 key 未变而 threadId 变的情况。
  expandedTaskIds.value = new Set();
  void poll(generation);
}, { immediate: true });
// 本机连接恢复独立于云端 WebSocket，立即重试原查询并隔离迟到响应。
watch(() => [config.localRuntimeReady, config.desktopClient?.connectedAt], (current, previous) => {
  if (!isDesktopWorkspace(config, props.workspaceId) || current[0] === previous[0] && current[1] === previous[1]) return;
  failures = 0; failureCode = null;
  invalidateCurrentRefresh();
  void poll(generation);
});
onMounted(() => document.addEventListener("visibilitychange", onVisibilityChanged));
onActivated(() => { panelActive = true; void poll(generation); });
onDeactivated(() => { panelActive = false; stageDetail.value = null; clearTimeout(timer); requestController?.abort(); });
onUnmounted(() => { generation++; requestController?.abort(); clearTimeout(timer); clearInterval(ticker); document.removeEventListener("visibilitychange", onVisibilityChanged); });

/** 提交流程动作并刷新状态；失败后释放 busy，允许用户重试。 */
async function action(view: ChatWorkflowView, actionName: ChatWorkflowActionInput["action"], extras: Partial<ChatWorkflowActionInput> = {}) {
  if (busy.value || props.readOnly || props.replyRunning) return;
  busy.value = true;
  const scope = generation;
  try {
    const result = await actOnChatWorkflow(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, taskId: view.task.id, requestId: createBrowserUuid(), expectedVersion: view.task.version, resultVersion: view.resultVersion ?? undefined, action: actionName, ...extras });
    if (!result.ok) throw new Error(result.message);
    await refresh(scope);
  } catch (cause) { if (scope === generation) { message.error(cause instanceof Error ? cause.message : String(cause)); await refresh(scope); } }
  finally { if (scope === generation) busy.value = false; }
}
/** 待办动作的提交负载；忽略门禁属高风险动作，模板里先做危险确认再调用同一个 action()。 */
function todoActionPayload(todo: ChatWorkflowTodo) {
  return { nodeId: todo.nodeId, nodeVersion: todo.version, feedback: feedback.value[todo.nodeId], targetNodeId: branches.value[todo.nodeId] };
}

/** 硬删未启动的推荐卡：不可恢复，成功后刷新面板让卡片在所有端消失；失败也刷新以免界面停在过期态。 */
async function removeCard(view: ChatWorkflowView): Promise<void> {
  if (busy.value || props.readOnly) return;
  busy.value = true;
  const scope = generation;
  try {
    const result = await deleteChatWorkflow(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, taskId: view.task.id, expectedVersion: view.task.version, requestId: createBrowserUuid() });
    if (!result.ok) throw new Error(result.message);
    await refresh(scope);
  } catch (cause) { if (scope === generation) { message.error(cause instanceof Error ? cause.message : String(cause)); await refresh(scope); } }
  finally { if (scope === generation) busy.value = false; }
}
/** 等待编排工作区首屏需求列表加载完成，避免列表刷新把刚落下的选择清掉。 */
async function waitForOrchestrationIntakesReady(timeoutMs = 10_000): Promise<void> {
  await nextTick();
  const deadline = Date.now() + timeoutMs;
  while (orch.intakesLoading) {
    if (Date.now() >= deadline) throw new Error("编排工作区需求列表加载超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** 打开执行详情：切到编排工作区的「需求编排」并选中该工作流所属需求与实例。 */
async function openDetails(view: ChatWorkflowView) {
  const instanceId = view.task.instanceId;
  const intakeId = view.task.intakeId;
  if (!instanceId || !intakeId) return;
  try {
    // 侧边栏 segmented 的唯一真源是 analysis.viewMode，不切模式会落在「原始需求」。
    analysis.openIntakeMode();
    await router.push("/orchestration/workspace");
    // 首屏 hydration 会 resetForWorkspace 并重拉需求列表，必须等它就绪后再落选择。
    await waitForOrchestrationIntakesReady();
    const instance = await orch.loadInstance(ctx.value, props.workspaceId, instanceId as any, { loadDetails: true });
    if (!instance) throw new Error("运行实例不存在或已被清理，无法打开执行详情");
    orch.selectedIntakeId = intakeId as any;
    // 用实例上冻结的需求快照兜底，列表未收录该需求时消费端守卫也能通过。
    orch.selectedIntakeSnapshot = instance.intakeSnapshot;
    orch.dispatchUiIntent({ kind: "open_monitor", intakeId: intakeId as any, instanceId: instanceId as any, nodeId: null });
  } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)); }
}
/**
 * 同一节点的同一产物只保留最新版本：节点重跑是「INSERT 新行 + version 递增」，后端会全量返回历史行。
 * 标题由后端拼成 `${节点标签} 输出 v${version}`，去掉尾部版本号即为产物名称，分组键取「节点 + 产物名称」。
 * 边界：标题不含空格+版本号后缀时按不合并处理（退化为现状，不会误删产物）；输出顺序沿用入参顺序。
 */
function latestArtifacts(artifacts: ChatWorkflowView["artifacts"]): ChatWorkflowView["artifacts"] {
  const keyOf = (artifact: ChatWorkflowView["artifacts"][number]) => `${artifact.nodeId}::${artifact.title.replace(/\s+v\d+$/u, "")}`;
  const latest = new Map<string, ChatWorkflowView["artifacts"][number]>();
  for (const artifact of artifacts) {
    const current = latest.get(keyOf(artifact));
    if (!current || artifact.version > current.version) latest.set(keyOf(artifact), artifact);
  }
  // 保持后端按产出时间升序的原始顺序，只把非最新的历史版本剔掉。
  return artifacts.filter(artifact => latest.get(keyOf(artifact)) === artifact);
}
/** 打开产物预览：复用编排产物展示层的解析，按落盘格式渲染而不是把 contentJson 当纯文本。 */
async function openArtifact(id: string, title: string) {
  try {
    const [artifactResult, filesResult] = await Promise.all([
      getOrchArtifact(ctx.value, { workspaceId: props.workspaceId, artifactId: id as any }),
      listOrchArtifactFiles(ctx.value, { workspaceId: props.workspaceId, artifactId: id }),
    ]);
    if (!artifactResult.ok) throw new Error(artifactResult.message);
    if (!filesResult.ok) throw new Error(filesResult.message);
    if (!artifactResult.artifact) throw new Error("产物不存在或已被清理，请刷新后重试");
    artifactTitle.value = title;
    artifactPreview.value = buildArtifactPresentation(artifactResult.artifact, filesResult.files);
  } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)); }
}
/** 切换产物预览弹框的全屏态。 */
function toggleArtifactPreviewFullscreen() { artifactPreviewFullscreen.value = !artifactPreviewFullscreen.value; }
const artifactDesktopFullscreen = computed(() => artifactPreviewFullscreen.value && config.isDesktop);
const artifactPreviewWrapClass = computed(() => [
  "chat-workflow__preview-modal",
  artifactPreviewFullscreen.value ? "chat-workflow__preview-modal--fullscreen" : "",
  artifactDesktopFullscreen.value ? "chat-workflow__preview-modal--desktop-fullscreen" : "",
].filter(Boolean).join(" "));
// 关闭弹框一律复位全屏态，Esc / 点遮罩 / 点 ✕ 都走 @cancel 关闭，因此全屏下 Esc 仍是直接关闭。
watch(artifactPreview, (value) => { if (!value) artifactPreviewFullscreen.value = false; });
function startRework(view: ChatWorkflowView) {
  reworkTask.value = view; reworkReason.value = "";
  reworkNode.value = view.task.workflow.nodes.find(n => n.type === "role")?.id ?? "";
}
async function prepareRework() {
  if (!reworkTask.value || !reworkReason.value.trim()) return;
  busy.value = true;
  try {
    const result = await planChatWorkflowRework(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId, taskId: reworkTask.value.task.id, nodeId: reworkNode.value, reason: reworkReason.value });
    if (!result.ok) throw new Error(result.message);
    reworkTask.value = null;
    await refresh();
  } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)); }
  finally { busy.value = false; }
}
</script>

<template>
  <section v-if="visibleTasks.length || error" class="chat-workflow" aria-label="会话工作流">
    <a-alert v-if="error" type="warning" :message="error" show-icon />
    <article v-for="view in visibleTasks" :key="view.task.id" class="chat-workflow__task">
      <!-- 已结束且无人工信号的卡收成一行摘要，可展开回看完整卡片、也可仅在本机隐藏。 -->
      <div v-if="isFolded(view)" class="chat-workflow__summary">
        <a-tag :color="labelColor(view)">{{ label(view) }}</a-tag>
        <strong class="chat-workflow__summary-title">{{ view.task.title }}</strong>
        <span class="chat-workflow__summary-meta">{{ view.task.workflow.name }}</span>
        <a-button size="small" aria-expanded="false" @click="toggleCardExpanded(view.task.id)"><ChevronDown :size="14" />展开</a-button>
        <a-popconfirm v-if="!readOnly" title="仅在本机隐藏此工作流卡片？需求编排工作区中的记录不受影响。" @confirm="hideCard(view.task.id)"><a-button size="small" :disabled="busy"><EyeOff :size="14" />隐藏</a-button></a-popconfirm>
      </div>
      <template v-else>
      <div class="chat-workflow__title"><strong>{{ view.task.title }}</strong><a-button v-if="isFoldable(view)" size="small" aria-expanded="true" @click="toggleCardExpanded(view.task.id)"><ChevronUp :size="14" />收起</a-button></div>
      <div class="chat-workflow__meta">{{ view.task.workflow.name }}</div>
      <template v-if="view.task.state === 'dismissed'">
        <a-alert :type="view.continuation?.status === 'failed' ? 'error' : 'info'" :message="continuationMessage(view)" show-icon />
        <div class="chat-workflow__actions">
          <a-button v-if="!view.continuation || (view.continuation.status === 'pending' && !view.continuation.paused)" :disabled="readOnly || busy" @click="action(view, 'dismiss')">继续在会话处理</a-button>
          <!-- 删除仅限发起人（canAccept 即 actorUserId === 发起人），共享会话里的旁观者可无条件读卡但删不动。 -->
          <a-popconfirm v-if="!readOnly && view.canAccept" title="删除此工作流卡片？删除后不可恢复，关联的需求与提案一并删除。" @confirm="removeCard(view)"><a-button size="small" danger :disabled="busy"><Trash2 :size="14" />删除</a-button></a-popconfirm>
        </div>
      </template>
      <template v-else-if="view.task.state === 'recommended'">
        <p>{{ view.task.rationale }}</p><p>{{ view.task.goal }}</p>
        <ul><li v-for="criterion in view.task.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul>
        <div class="chat-workflow__stages" :class="{ 'chat-workflow__stages--preview': !view.task.instanceId }"><template v-for="(stage, index) in stageItems(view)" :key="stage.nodeId"><span v-if="index > 0" class="chat-workflow__arrow" :class="{ 'chat-workflow__arrow--done': stage.arrowDone, 'chat-workflow__arrow--parallel': stage.parallelLink }" aria-hidden="true"></span><button type="button" class="chat-workflow__stage" :class="[`chat-workflow__stage--${stage.tone}`, { 'chat-workflow__stage--terminal': stage.terminal, 'chat-workflow__stage--alert': Boolean(stage.error) }]" :title="stage.title" @click="openStageDetail(view, stage)"><span class="chat-workflow__stage-head"><Check v-if="stage.tone === 'done'" :size="12" /><X v-else-if="stage.tone === 'failed'" :size="12" /><Ban v-else-if="stage.tone === 'cancelled'" :size="12" /><LoaderCircle v-else-if="stage.spinning" class="chat-workflow__spinner" :size="12" /><Circle v-else :size="12" /><span v-if="stage.branchBadge" class="chat-workflow__stage-branch">{{ stage.branchBadge }}</span><span class="chat-workflow__stage-label">{{ stage.label }}</span></span><span class="chat-workflow__stage-status">{{ stage.statusLine }}</span></button></template></div>
        <div class="chat-workflow__actions"><a-tag :color="labelColor(view)">{{ label(view) }}</a-tag><a-button type="primary" :disabled="readOnly || busy" @click="action(view, 'start')"><Play :size="14" />确认使用并启动</a-button><a-button :disabled="readOnly || busy" @click="action(view, 'dismiss')">本次直接在会话处理</a-button><a-popconfirm v-if="!readOnly && view.canAccept" title="删除此工作流卡片？删除后不可恢复，关联的需求与提案一并删除。" @confirm="removeCard(view)"><a-button size="small" danger :disabled="busy"><Trash2 :size="14" />删除</a-button></a-popconfirm></div>
      </template>
      <template v-else>
        <div class="chat-workflow__stages"><template v-for="(stage, index) in stageItems(view)" :key="stage.nodeId"><span v-if="index > 0" class="chat-workflow__arrow" :class="{ 'chat-workflow__arrow--done': stage.arrowDone, 'chat-workflow__arrow--parallel': stage.parallelLink }" aria-hidden="true"></span><button type="button" class="chat-workflow__stage" :class="[`chat-workflow__stage--${stage.tone}`, { 'chat-workflow__stage--terminal': stage.terminal, 'chat-workflow__stage--alert': Boolean(stage.error) }]" :title="stage.title" @click="openStageDetail(view, stage)"><span class="chat-workflow__stage-head"><Check v-if="stage.tone === 'done'" :size="12" /><X v-else-if="stage.tone === 'failed'" :size="12" /><Ban v-else-if="stage.tone === 'cancelled'" :size="12" /><LoaderCircle v-else-if="stage.spinning" class="chat-workflow__spinner" :size="12" /><Circle v-else :size="12" /><span v-if="stage.branchBadge" class="chat-workflow__stage-branch">{{ stage.branchBadge }}</span><span class="chat-workflow__stage-label">{{ stage.label }}</span></span><span class="chat-workflow__stage-status">{{ stage.statusLine }}</span></button></template></div>
        <div class="chat-workflow__actions">
          <a-tag :color="labelColor(view)">{{ label(view) }}</a-tag>
          <a-button size="small" @click="openDetails(view)"><ExternalLink :size="14" />执行详情</a-button>
          <a-button v-if="view.status === 'paused'" size="small" :disabled="readOnly || busy" @click="action(view, 'resume')"><Play :size="14" />恢复流程</a-button>
          <a-button v-else-if="isActive(view)" size="small" :disabled="readOnly || busy" @click="action(view, 'pause')"><Pause :size="14" />暂停流程</a-button>
          <a-popconfirm v-if="isActive(view)" title="终止此工作流？已产生的结果将保留。" @confirm="action(view, 'cancel')"><a-button size="small" danger :disabled="readOnly || busy"><Square :size="14" />终止流程</a-button></a-popconfirm>
        </div>
        <div v-for="todo in view.todos" :key="`${todo.nodeId}:${todo.version}`" class="chat-workflow__todo">
          <strong>{{ todo.label }} · {{ statusLabels[todo.status] }}</strong><p>{{ todo.question }}</p><pre v-if="todo.summary">{{ todo.summary }}</pre>
          <template v-if="isComposerInput(view, todo)">
            <p class="chat-workflow__todo-hint">请在下方会话框输入补充说明并发送</p>
            <div class="chat-workflow__actions"><a-button :disabled="readOnly || busy" @click="startRework(view)"><RotateCcw :size="14" />提出修改</a-button></div>
          </template>
          <template v-else>
            <p v-if="isComposerApproval(view, todo)" class="chat-workflow__todo-hint">可在下方会话框输入「审核通过：审核意见」提交；要打回重跑请点「提出修改」</p>
            <a-textarea v-else v-model:value="feedback[todo.nodeId]" placeholder="审核意见或补充内容" :rows="2" :disabled="readOnly || busy" />
            <a-select v-if="todo.actions.some(a => a.action === 'choose_branch')" v-model:value="branches[todo.nodeId]" placeholder="选择分支" :options="todo.branches.map(b => ({ label: b.label, value: b.nodeId }))" :disabled="readOnly || busy" />
            <div class="chat-workflow__actions"><template v-for="choice in todo.actions" :key="choice.action"><a-tooltip :title="choice.effect"><a-popconfirm v-if="choice.action === 'override'" title="确认忽略门禁并通过该节点？后续流程可能因缺少可靠结果而失败。" ok-text="确认忽略门禁" cancel-text="取消" @confirm="action(view, 'feedback', { ...todoActionPayload(todo), feedbackAction: choice.action })"><a-button danger :disabled="readOnly || busy"><Check :size="14" />{{ choice.label }}</a-button></a-popconfirm><a-button v-else :disabled="readOnly || busy" @click="action(view, 'feedback', { ...todoActionPayload(todo), feedbackAction: choice.action })"><Check :size="14" />{{ choice.label }}</a-button></a-tooltip></template><a-button :disabled="readOnly || busy" @click="startRework(view)"><RotateCcw :size="14" />提出修改</a-button></div>
          </template>
        </div>
        <div v-if="view.artifacts.length" class="chat-workflow__artifacts"><a-button v-for="artifact in latestArtifacts(view.artifacts)" :key="artifact.id" type="link" @click="openArtifact(artifact.id, artifact.title)"><FileText :size="14" />{{ artifact.title }}</a-button></div>
        <template v-if="view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled'">
          <ul><li v-for="criterion in view.acceptance" :key="criterion.text">{{ criterion.status === 'passed' ? '通过' : criterion.status === 'failed' ? '未通过' : '未验证' }}：{{ criterion.text }}<span v-if="criterion.evidence"> · {{ criterion.evidence }}</span></li></ul>
          <p v-if="!view.checks.length">暂无验证记录</p>
          <ul v-else><li v-for="check in view.checks" :key="`${check.nodeId}:${check.criterion}`">{{ check.passed ? '通过' : '未通过' }}：{{ check.message || check.criterion }}</li></ul>
          <div class="chat-workflow__actions"><a-button v-if="view.status === 'completed' && !view.accepted" type="primary" :disabled="readOnly || busy || !view.canAccept" @click="action(view, 'accept')"><Check :size="14" />最终验收通过</a-button><a-button :disabled="readOnly || busy" @click="startRework(view)"><RotateCcw :size="14" />提出修改</a-button></div>
        </template>
        <div v-if="view.task.rework" class="chat-workflow__todo"><strong>待确认返工</strong><p>{{ view.task.rework.reason }}</p><p>影响阶段：{{ view.task.rework.affectedNodeIds.map(id => view.stages.find(s => s.nodeId === id)?.label ?? id).join(' / ') }}</p><a-button :disabled="readOnly || busy || view.resultVersion !== view.task.rework.resultVersion" @click="action(view, 'confirm_rework')"><RotateCcw :size="14" />确认返工</a-button></div>
        <details v-if="view.updates.length" class="chat-workflow__history"><summary>执行记录</summary><div v-for="update in view.updates" :key="update.id"><time>{{ new Date(update.createdAt).toLocaleTimeString() }}</time> {{ update.text }}</div></details>
      </template>
      </template>
    </article>
    <a-modal :open="Boolean(reworkTask)" title="准备返工方案" ok-text="查看返工影响" :confirm-loading="busy" @ok="prepareRework" @cancel="reworkTask = null">
      <a-select v-model:value="reworkNode" class="chat-workflow__full" :options="reworkTask?.task.workflow.nodes.filter(n => n.type === 'role').map(n => ({ label: n.label, value: n.id }))" />
      <a-textarea v-model:value="reworkReason" :rows="4" placeholder="修改意见" class="chat-workflow__reason" />
    </a-modal>
    <a-modal
      :open="artifactPreview !== null"
      :width="artifactPreviewFullscreen ? '100vw' : '800px'"
      :wrap-class-name="artifactPreviewWrapClass"
      :footer="null"
      @cancel="artifactPreview = null"
    >
      <template #title>
        <div class="chat-workflow__preview-titlebar">
          <span class="chat-workflow__preview-titletext">{{ artifactTitle }}</span>
          <a-tooltip :title="artifactPreviewFullscreen ? '还原' : '全屏查看'">
            <a-button size="small" type="text" :aria-label="artifactPreviewFullscreen ? '还原产物预览弹框' : '全屏查看产物预览弹框'" @click.stop="toggleArtifactPreviewFullscreen">
              <component :is="artifactPreviewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
            </a-button>
          </a-tooltip>
        </div>
      </template>
      <div v-if="artifactPreview" class="chat-workflow__preview" :class="{ 'chat-workflow__preview--fullscreen': artifactPreviewFullscreen }"><ArtifactFilePreview :workspace-id="workspaceId" :preview="artifactPreview" /></div>
    </a-modal>
    <a-modal
      :open="stageDetail !== null"
      :width="stageDetailFullscreen ? '100vw' : '90%'"
      :wrap-class-name="stageDetailWrapClass"
      :footer="null"
      destroy-on-close
      @cancel="stageDetail = null"
    >
      <template #title>
        <div class="chat-workflow__node-detail-titlebar">
          <span class="chat-workflow__node-detail-titletext">{{ stageDetail?.title }}</span>
          <a-tooltip :title="stageDetailFullscreen ? '还原' : '全屏查看'">
            <a-button size="small" type="text" :aria-label="stageDetailFullscreen ? '还原节点详情弹框' : '全屏查看节点详情弹框'" @click.stop="toggleStageDetailFullscreen">
              <component :is="stageDetailFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
            </a-button>
          </a-tooltip>
        </div>
      </template>
      <div v-if="stageDetail" class="chat-workflow__node-detail" :class="{ 'chat-workflow__node-detail--fullscreen': stageDetailFullscreen }">
        <ArtifactFilePreview
          v-if="!stageDetail.nodeState"
          :workspace-id="workspaceId"
          :preview="emptyStagePreview"
          :loading="stageDetail.loading"
          :error="stageDetail.error"
          loading-text="正在加载节点详情..."
          @retry="loadStageDetail"
        />
        <template v-else>
          <a-alert v-if="stageDetail.error" type="error" :message="stageDetail.error" show-icon>
            <template #action><a-button size="small" :loading="stageDetail.loading" @click="loadStageDetail">重试</a-button></template>
          </a-alert>
          <NodeExecutionDetail :workspace-id="workspaceId" :instance-id="stageDetail.instanceId" :node-state="stageDetail.nodeState" :node="stageDetail.node" :workflow-nodes="stageDetail.workflowNodes" fill-height :artifacts="orch.selectedInstanceArtifacts" :prompt-snapshots="orch.selectedInstancePromptSnapshots" hide-headline-title />
        </template>
      </div>
    </a-modal>
  </section>
</template>

<style scoped>
/* 左缩进与消息内容列对齐：消息行是「头像 + 行内间距」再放内容，卡片没有头像，需要补同样的偏移。
   取值跟随 apps/web/src/styles/messages.css 的 .msg-row gap 与 .msg-avatar width，改动需同步。 */
.chat-workflow { min-width: 0; margin: 12px 0 12px 38px; font-size: 13px; }
.chat-workflow__title, .chat-workflow__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chat-workflow__task { border: 1px solid var(--border-color, #d9d9d9); border-radius: 6px; padding: 12px; margin-top: 10px; overflow-wrap: anywhere; }
.chat-workflow__title { justify-content: space-between; }
.chat-workflow__meta { color: var(--text-secondary, #777); margin-top: 4px; }
/* 折叠行：与卡片同宽的单行摘要，窄屏换行而非横向撑开；不设 overflow，不引入新的滚动盒。 */
.chat-workflow__summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.chat-workflow__summary-title { font-weight: 600; }
.chat-workflow__summary-meta { color: var(--text-secondary, #777); }
.chat-workflow__actions { margin-top: 10px; }
.chat-workflow__actions :deep(.ant-btn), .chat-workflow__artifacts :deep(.ant-btn), .chat-workflow__summary :deep(.ant-btn) { display: inline-flex; align-items: center; gap: 5px; height: auto; min-height: 28px; white-space: normal; max-width: 100%; }
/* 从左到右的流程条：单行横向滚动，节点不压缩、不换行。 */
.chat-workflow__stages { display: flex; flex-direction: row; align-items: stretch; margin-top: 10px; padding: 3px 0 4px; overflow-x: auto; overflow-y: hidden; }
/* 节点内容在框内左右居中：图标+标题成组居中，状态行同宽居中。 */
.chat-workflow__stage { --stage-tone: var(--app-muted); flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 76px; max-width: 176px; padding: 6px 10px; border: 1px solid var(--app-border); border-radius: 8px; background: transparent; color: var(--app-text); font: inherit; text-align: center; cursor: pointer; }
/* 开始/终审用胶囊形，与中间的角色节点区分。 */
.chat-workflow__stage--terminal { border-radius: 999px; padding-inline: 14px; }
/* max-width 兜住居中后的长标题：不收窄就会向两侧溢出节点框，标题也不会走省略号。 */
.chat-workflow__stage-head { display: flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; }
.chat-workflow__stage-head > svg { flex: 0 0 auto; color: var(--stage-tone); }
.chat-workflow__stage-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
/* 并行分支序号：标出这个节点属于哪一条并行分支。 */
.chat-workflow__stage-branch { flex: 0 0 auto; font-size: 11px; line-height: 1; color: var(--app-accent); }
.chat-workflow__stage-status { font-size: 11px; color: var(--app-muted); }
/* 每档只声明一个色值，边框与底色由它派生；实心底色表示已发生或正在发生，无底色表示等待人工，虚线表示未到达。 */
.chat-workflow__stage--done { --stage-tone: var(--app-success); border-color: var(--stage-tone); background: color-mix(in srgb, var(--stage-tone) 12%, transparent); }
.chat-workflow__stage--running { --stage-tone: var(--app-accent); border-color: var(--stage-tone); background: color-mix(in srgb, var(--stage-tone) 12%, transparent); }
.chat-workflow__stage--attention { --stage-tone: var(--app-warning); border-color: var(--stage-tone); }
.chat-workflow__stage--failed { --stage-tone: var(--app-danger); border-color: var(--stage-tone); background: color-mix(in srgb, var(--stage-tone) 12%, transparent); }
.chat-workflow__stage--cancelled { --stage-tone: var(--app-muted); border-color: var(--stage-tone); }
.chat-workflow__stage--idle { border-style: dashed; }
/* 带错误原因的节点加红点，具体原因在 title 里。 */
.chat-workflow__stage--alert { position: relative; }
.chat-workflow__stage--alert::after { content: ""; position: absolute; top: -3px; right: -3px; width: 6px; height: 6px; border-radius: 50%; background: var(--app-danger); }
.chat-workflow__stages:not(.chat-workflow__stages--preview) .chat-workflow__stage:hover { box-shadow: var(--app-shadow-sm); }
.chat-workflow__stage:focus-visible { outline: none; box-shadow: var(--app-ring); }
/* 未启动的工作流只做预览，点击不导航，因此不给悬停反馈。 */
.chat-workflow__stages--preview .chat-workflow__stage { cursor: default; }
.chat-workflow__arrow { flex: 0 0 auto; align-self: center; position: relative; width: 18px; height: 8px; }
.chat-workflow__arrow::before { content: ""; position: absolute; top: 50%; right: 5px; left: 0; border-top: 1px solid var(--app-border); }
.chat-workflow__arrow::after { content: ""; position: absolute; top: 50%; right: 4px; width: 4px; height: 4px; border-top: 1px solid var(--app-border); border-right: 1px solid var(--app-border); transform: translateY(-50%) rotate(45deg); }
.chat-workflow__arrow--done::before, .chat-workflow__arrow--done::after { border-color: var(--app-success); }
/* 并行段内改用 ∥：分支之间是并列关系，画箭头会被读成先后顺序。 */
.chat-workflow__arrow--parallel { height: auto; }
.chat-workflow__arrow--parallel::before {
  content: "∥";
  position: static;
  display: flex;
  align-items: center;
  justify-content: center;
  border-top: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--app-muted);
}
.chat-workflow__arrow--parallel::after { content: none; }
.chat-workflow__todo { border-top: 1px solid var(--border-color, #ddd); padding-top: 10px; margin-top: 12px; }
/* 会话框接管的待补充待办只留一句原位提示；层次沿用 --app-muted，自动跟随亮/暗主题。 */
.chat-workflow__todo-hint { color: var(--app-muted); font-size: 12px; }
.chat-workflow pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; font: inherit; }
.chat-workflow__todo :deep(.ant-select) { width: 100%; margin-top: 8px; }
.chat-workflow__spinner { vertical-align: -0.125em; animation: chat-workflow-spin 1s linear infinite; }
@keyframes chat-workflow-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .chat-workflow__spinner { animation: none; } }

/* 小屏下消息行改用 24px 头像 + 8px 间距，卡片缩进同步收窄。 */
@media (max-width: 767px) { .chat-workflow { margin-left: 32px; } }
.chat-workflow__full { width: 100%; }
.chat-workflow__reason { margin-top: 12px; }
.chat-workflow__history { margin-top: 12px; max-height: 180px; overflow: auto; }
.chat-workflow__history time { color: var(--text-secondary, #777); }
/* 预览器内部按 height:100% 布局，弹窗内需要一个确定高度的容器。 */
.chat-workflow__preview { height: 70vh; overflow: hidden; }
/* 全屏时高度改由 .ant-modal-body 的可用高度决定；与上一行特异性相同，必须写在它之后才生效。 */
.chat-workflow__preview--fullscreen { height: 100%; min-height: 0; }
/* 标题栏右侧按钮要避开 antd 绝对定位的关闭按钮，故预留 44px。 */
.chat-workflow__preview-titlebar, .chat-workflow__node-detail-titlebar { display: flex; align-items: center; gap: 8px; min-width: 0; width: calc(100% - 44px); box-sizing: border-box; }
.chat-workflow__preview-titletext, .chat-workflow__node-detail-titletext { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 弹框内容被 antd teleport 到 body，scoped 选择器够不到内部元素，只能用整体包裹的 :global(A B)；
   width/top/margin 必须 !important，因为 antd 把宽度写进 .ant-modal 的内联 style。 */
:global(.chat-workflow__preview-modal--fullscreen.ant-modal-wrap) { overflow: hidden !important; }
:global(.chat-workflow__preview-modal--desktop-fullscreen.ant-modal-wrap) { top: 44px !important; height: calc(100dvh - 44px) !important; }
:global(.chat-workflow__preview-modal--fullscreen .ant-modal) { width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; min-height: 100dvh !important; max-height: 100dvh !important; margin: 0 !important; top: 0 !important; padding-bottom: 0 !important; }
:global(.chat-workflow__preview-modal--desktop-fullscreen .ant-modal) { height: 100% !important; min-height: 100% !important; max-height: 100% !important; }
:global(.chat-workflow__preview-modal--fullscreen .ant-modal-content) { display: flex; flex-direction: column; height: 100dvh !important; max-height: 100dvh !important; border-radius: 0; overflow: hidden; }
:global(.chat-workflow__preview-modal--desktop-fullscreen .ant-modal-content) { height: 100% !important; max-height: 100% !important; }
:global(.chat-workflow__preview-modal--fullscreen .ant-modal-body) { flex: 1 1 auto; min-height: 0; overflow: hidden !important; }
/* 节点详情同样按 fill-height 布局，容器给确定高度。 */
.chat-workflow__node-detail { height: 70vh; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
/* 全屏时高度改由 .ant-modal-body 的可用高度决定；与上一行特异性相同，必须写在它之后才生效。 */
.chat-workflow__node-detail--fullscreen { height: 100%; min-height: 0; }
/* 同 392-393 行的约束：必须整体包裹成 :global(A B)，宽度类覆盖必须 !important。 */
:global(.chat-workflow__node-detail-modal--fullscreen.ant-modal-wrap) { overflow: hidden !important; }
:global(.chat-workflow__node-detail-modal--desktop-fullscreen.ant-modal-wrap) { top: 44px !important; height: calc(100dvh - 44px) !important; }
:global(.chat-workflow__node-detail-modal--fullscreen .ant-modal) { width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; min-height: 100dvh !important; max-height: 100dvh !important; margin: 0 !important; top: 0 !important; padding-bottom: 0 !important; }
:global(.chat-workflow__node-detail-modal--desktop-fullscreen .ant-modal) { height: 100% !important; min-height: 100% !important; max-height: 100% !important; }
:global(.chat-workflow__node-detail-modal--fullscreen .ant-modal-content) { display: flex; flex-direction: column; height: 100dvh !important; max-height: 100dvh !important; border-radius: 0; overflow: hidden; }
:global(.chat-workflow__node-detail-modal--desktop-fullscreen .ant-modal-content) { height: 100% !important; max-height: 100% !important; }
:global(.chat-workflow__node-detail-modal--fullscreen .ant-modal-body) { flex: 1 1 auto; min-height: 0; overflow: hidden !important; }
.chat-workflow p { margin: 8px 0; }
</style>
