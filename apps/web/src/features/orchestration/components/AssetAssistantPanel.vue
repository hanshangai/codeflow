<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { CheckCircleOutlined, EyeOutlined, SendOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type AssetDraftId,
  type AssetGenerationJobId,
  type AssetGenerationJobStatus,
  type AssetGenerationJob,
  type AssetValidationIssue,
  type AssetVersionId,
  type EngineType,
  type OrchAssetDraftJobListItem,
  type OrchAssetDraftJobSummary,
  type RoleDefinition,
  type RoleDraftComparison,
  type RoleDraftPayload,
  type RoleId,
  type SkillDefinition,
  type SkillDraftComparison,
  type SkillDraftPayload,
  type SkillId,
  type SkillTargetEngine,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";

import {
  applyAssetAssistantDraft,
  getAssetAssistantJob,
  getAssetAssistantResult,
  startAssetAssistantJob,
} from "../../../api/orchestration";
import { ApiResultError, createApiResultError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useChatStore } from "../../../store/chat";
import { useOrchestrationStore } from "../../../store/orchestration";
import ChatPanel from "../../chat/components/chat-panel.vue";
import AssetDraftPreviewModal, { type DraftPreviewTabKey } from "./asset-draft-preview-modal.vue";

defineOptions({ name: "AssetAssistantPanel" });

type AssistantMode = "create" | "revise";
type AssistantAssetKind = "role" | "skill";
type AssistantEngine = "" | EngineType;
type EditableRole = Omit<RoleDefinition, "createdAt" | "updatedAt">;
type EditableSkill = Omit<SkillDefinition, "createdAt" | "updatedAt">;

type CandidateDraft = {
  draftId: AssetDraftId;
  jobId: AssetGenerationJobId;
  payload: RoleDraftPayload | SkillDraftPayload;
  comparison: RoleDraftComparison | SkillDraftComparison;
  validationIssues: AssetValidationIssue[];
  state: "ready" | "applying" | "applied";
  appliedRoleId: RoleId | null;
  appliedSkillId: SkillId | null;
  appliedVersionId: AssetVersionId | null;
};

const props = withDefaults(defineProps<{
  workspaceId: WorkspaceId;
  maintenanceForbidden?: boolean;
  createKey?: number;
  selectedJobId?: AssetGenerationJobId | null;
}>(), {
  maintenanceForbidden: false,
  createKey: 0,
  selectedJobId: null,
});

const emit = defineEmits<{
  (e: "open-role", roleId: RoleId): void;
  (e: "open-skill", skillId: SkillId): void;
  (e: "session-active", value: boolean): void;
  (e: "session-status", value: string): void;
  (e: "active-job-change", value: AssetGenerationJobId | null): void;
  (e: "session-upsert", value: OrchAssetDraftJobListItem): void;
  (e: "sessions-refresh"): void;
}>();

const orch = useOrchestrationStore();
const chat = useChatStore();
const { ctx } = useApiContext();

const assetKind = ref<AssistantAssetKind>("role");
const mode = ref<AssistantMode>("create");
const agentName = ref("新 Agent");
const skillName = ref("新 Skill");
const prompt = ref("");
const engine = ref<AssistantEngine>("");
const selectedRoleId = ref<RoleId | "">("");
const selectedSkillId = ref<SkillId | "">("");
const running = ref(false);
const applying = ref(false);
const statusText = ref("");
const errorText = ref("");
const jobId = ref<AssetGenerationJobId | null>(null);
const jobStatus = ref<AssetGenerationJobStatus | null>(null);
const jobFailureRetryable = ref(false);
const interactionPrompt = ref("");
const activeThreadId = ref<ThreadId | null>(null);
const activeDraft = ref<CandidateDraft | null>(null);
const createDialogOpen = ref(false);
const previewOpen = ref(false);
const previewTab = ref<DraftPreviewTabKey>("definition");

let pollTimer: number | null = null;
let assistantUnmounted = false;

const editableRoles = computed(() => orch.roles.filter((role) => role.kind !== "builtin"));
const editableSkills = computed(() => orch.skills.filter((skill) => skill.kind !== "builtin"));
const selectedRole = computed(() =>
  selectedRoleId.value ? editableRoles.value.find((role) => role.id === selectedRoleId.value) ?? null : null,
);
const selectedSkill = computed(() =>
  selectedSkillId.value ? editableSkills.value.find((skill) => skill.id === selectedSkillId.value) ?? null : null,
);
const preferredEngine = computed<EngineType>(() => {
  if (engine.value) return engine.value;
  if (assetKind.value === "role") return selectedRole.value?.executionConfig.preferredEngine || "codex";
  return selectedSkill.value?.targetEngines?.includes("claude") ? "claude" : "codex";
});
const hasSession = computed(() => Boolean(jobId.value || activeThreadId.value || activeDraft.value));
const createDisabled = computed(() =>
  running.value
  || applying.value
  || props.maintenanceForbidden
  || (assetKind.value === "role" && mode.value === "revise" && !selectedRole.value)
  || (assetKind.value === "skill" && mode.value === "revise" && !selectedSkill.value),
);
const createOkButtonProps = computed(() => ({ disabled: createDisabled.value }));
const canContinueInChat = computed(() =>
  Boolean(
    activeThreadId.value
    && !props.maintenanceForbidden
    && !running.value
    && !applying.value
    && (
      jobStatus.value === "awaiting_input"
      || jobStatus.value === "awaiting_review"
      || jobStatus.value === "applied"
      || (jobStatus.value === "failed" && jobFailureRetryable.value)
    ),
  ),
);
const composerDisabled = computed(() => !canContinueInChat.value);
const embeddedRunningTurnId = computed(() =>
  chat.threadDisplayRunningStateForThread(activeThreadId.value)?.runningTurnId ?? null,
);
const sessionSubtitle = computed(() => {
  if (running.value) return "生成中";
  if (jobStatus.value === "awaiting_input") return "待补充";
  if (jobStatus.value === "failed" && jobFailureRetryable.value) return "可重试";
  if (activeDraft.value?.state === "applied") return "已应用";
  if (activeDraft.value) return "待确认";
  if (activeThreadId.value) return "会话中";
  return "未选择";
});
const promptPlaceholder = computed(() => mode.value === "create"
  ? assetKind.value === "role"
    ? "例如：做一个负责代码评审的 Agent，重点检查接口契约、异常处理和测试风险。"
    : "例如：做一个代码审查 Skill，包含触发条件、SKILL.md 和可选检查脚本。"
  : assetKind.value === "role"
    ? "例如：保留当前职责，但把输入输出契约拆清楚，并补充工具使用边界。"
    : "例如：只更新脚本 scripts/check.mjs，并补充这个脚本的输入输出 Schema。");
const candidateTitle = computed(() => activeDraft.value?.payload.draft.name || "候选草案");
const candidateSections = computed(() =>
  activeDraft.value?.comparison.sections.filter((section) => section.changeCount > 0).slice(0, 6) ?? [],
);
const activeAssetLabel = computed(() => activeDraft.value?.payload.assetKind === "skill" ? "Skill" : "Agent");
const candidatePrimaryText = computed(() => {
  const payload = activeDraft.value?.payload;
  if (!payload) return "";
  if (payload.assetKind === "skill") return payload.draft.description || payload.draft.trigger || "—";
  return payload.draft.description || "—";
});
const candidateSecondaryText = computed(() => {
  const payload = activeDraft.value?.payload;
  if (!payload) return "";
  if (payload.assetKind === "skill") return payload.draft.instructions || payload.draft.skillMd || "—";
  return payload.draft.responsibility || "—";
});
const candidateReferenceTags = computed(() => {
  const payload = activeDraft.value?.payload;
  if (!payload) return [];
  if (payload.assetKind === "skill") {
    return [
      `${payload.referenceSummary.skillIds.length} 个 Skill`,
      `${payload.referenceSummary.selectedPaths.length} 个文件`,
      `${payload.draft.files?.length ?? 0} 个包文件`,
      `${payload.draft.scripts?.length ?? 0} 个脚本`,
    ];
  }
  return [
    `${payload.referenceSummary.roleIds.length} 个 Agent`,
    `${payload.referenceSummary.knowledgeBundleIds.length} 个知识库`,
    `${payload.referenceSummary.toolsetIds.length} 个工具`,
    `${payload.referenceSummary.selectedPaths.length} 个文件`,
  ];
});
const candidateBindingIssues = computed<AssetValidationIssue[]>(() => {
  const payload = activeDraft.value?.payload;
  if (payload?.assetKind !== "role") return [];
  const draft = payload.draft;
  if (!draft) return [];
  const issues: AssetValidationIssue[] = [];
  if (!orch.knowledgeBundlesLoading) {
    const bundleIds = new Set(orch.knowledgeBundles.map((item) => String(item.id)));
    for (const bundleId of draft.defaultKnowledgeBundleIds ?? []) {
      if (!bundleIds.has(String(bundleId))) {
        issues.push(makeReferenceIssue("UNKNOWN_KNOWLEDGE_BUNDLE", "draft.defaultKnowledgeBundleIds", `引用的知识库不存在：${bundleId}`, "请选择当前工作区内已有的知识库"));
      }
    }
  }
  if (!orch.toolsetsLoading) {
    const toolsetById = new Map(orch.toolsets.map((item) => [String(item.id), item]));
    for (const ref of draft.toolRefs ?? []) {
      const toolset = toolsetById.get(String(ref.toolsetId));
      if (!toolset) {
        issues.push(makeReferenceIssue("UNKNOWN_TOOLSET", "draft.toolRefs", `引用的工具不存在：${ref.toolsetId}`, "请选择当前工作区内已有的工具"));
        continue;
      }
      if (!toolset.tools.some((tool) => String(tool.id) === String(ref.toolId))) {
        issues.push(makeReferenceIssue("UNKNOWN_TOOL", "draft.toolRefs", `工具 ${toolset.name} 中不存在工具：${ref.toolId}`, "请检查工具 ID 是否正确"));
      }
    }
  }
  return issues;
});
const candidateValidationIssues = computed(() =>
  mergeValidationIssues(activeDraft.value?.validationIssues ?? [], candidateBindingIssues.value),
);
const candidateWarnings = computed(() =>
  candidateValidationIssues.value.filter((issue) => issue.severity === "warning"),
);
const candidateErrors = computed(() =>
  candidateValidationIssues.value.filter((issue) => issue.severity === "error"),
);
const setupSummary = computed(() => {
  const label = assetKind.value === "role" ? "Agent" : "Skill";
  const target = assetKind.value === "role"
    ? mode.value === "revise" ? selectedRole.value?.name || "未选择 Agent" : agentName.value.trim() || "新 Agent"
    : mode.value === "revise" ? selectedSkill.value?.name || "未选择 Skill" : skillName.value.trim() || "新 Skill";
  return `${mode.value === "create" ? "创建" : "优化"} ${label} · ${target}`;
});
const composerGuardText = computed(() => {
  if (props.maintenanceForbidden) return "当前工作区没有资产维护权限。";
  if (applying.value) return "正在应用候选草案。";
  if (running.value) return "助手正在生成候选草案。";
  if (jobStatus.value === "failed") return jobFailureRetryable.value ? "本轮生成已中断，可补充说明后重试。" : "当前草案任务已结束。";
  if (jobStatus.value === "rejected") return "当前草案任务已结束。";
  if (jobStatus.value && jobStatus.value !== "awaiting_input" && jobStatus.value !== "awaiting_review" && jobStatus.value !== "applied") return `当前状态：${jobStatus.value}`;
  return "";
});

watch([mode, editableRoles, () => orch.selectedRoleId], () => {
  if (mode.value !== "revise") return;
  if (assetKind.value !== "role") return;
  const currentStillAvailable = selectedRoleId.value
    ? editableRoles.value.some((role) => role.id === selectedRoleId.value)
    : false;
  if (currentStillAvailable) return;
  const selectedFromStore = orch.selectedRoleId
    ? editableRoles.value.find((role) => role.id === orch.selectedRoleId) ?? null
    : null;
  selectedRoleId.value = selectedFromStore?.id ?? editableRoles.value[0]?.id ?? "";
}, { immediate: true });

watch([assetKind, mode, editableSkills, () => orch.selectedSkillId], () => {
  if (mode.value !== "revise") return;
  if (assetKind.value !== "skill") return;
  const currentStillAvailable = selectedSkillId.value
    ? editableSkills.value.some((skill) => skill.id === selectedSkillId.value)
    : false;
  if (currentStillAvailable) return;
  const selectedFromStore = orch.selectedSkillId
    ? editableSkills.value.find((skill) => skill.id === orch.selectedSkillId) ?? null
    : null;
  selectedSkillId.value = selectedFromStore?.id ?? editableSkills.value[0]?.id ?? "";
}, { immediate: true });

watch(sessionSubtitle, (value) => {
  emit("session-status", value);
}, { immediate: true });

watch(hasSession, (value) => {
  emit("session-active", value);
}, { immediate: true });

watch(() => props.createKey, () => openCreateDialog());

watch(activeDraft, (value) => {
  if (!value) previewOpen.value = false;
});

watch(() => props.selectedJobId, (value) => {
  void syncSelectedAssistantJob(value ?? null);
}, { immediate: true });

watch(embeddedRunningTurnId, (turnId, previousTurnId) => {
  if (turnId) {
    resumePollingForEmbeddedChatTurn();
    return;
  }
  if (previousTurnId) void refreshAssistantJobAfterEmbeddedTurn();
}, { immediate: true });

/** 卸载后停止轮询，并阻止迟到的草案应用回执改写页面。 */
onBeforeUnmount(() => {
  assistantUnmounted = true;
  stopPolling();
});

/** 根据左侧选中的助手任务恢复主面板状态。 */
async function syncSelectedAssistantJob(nextJobId: AssetGenerationJobId | null): Promise<void> {
  if (!nextJobId) {
    resetAssistantSession();
    return;
  }
  if (nextJobId === jobId.value && jobStatus.value) return;
  await loadAssistantSession(nextJobId);
}

/** 清空当前助手会话展示；不改动新建弹框里的固定要素。 */
function resetAssistantSession(): void {
  stopPolling();
  running.value = false;
  applying.value = false;
  statusText.value = "";
  errorText.value = "";
  jobId.value = null;
  jobStatus.value = null;
  jobFailureRetryable.value = false;
  interactionPrompt.value = "";
  activeThreadId.value = null;
  activeDraft.value = null;
  emit("active-job-change", null);
}

/** 打开新建会话弹框；多个助手草案允许并存，由左侧会话列表切换。 */
function openCreateDialog(): void {
  createDialogOpen.value = true;
}

/** 确认新建弹框后启动会话；失败时保留弹框便于用户修正。 */
async function handleCreateDialogOk(): Promise<void> {
  const started = await startAssistantSession();
  if (started) createDialogOpen.value = false;
}

/** 加载已存在的助手草案任务，恢复刷新后的会话与候选卡。 */
async function loadAssistantSession(nextJobId: AssetGenerationJobId): Promise<void> {
  stopPolling();
  errorText.value = "";
  statusText.value = "正在加载助手会话";
  activeDraft.value = null;
  activeThreadId.value = null;
  jobId.value = nextJobId;
  jobStatus.value = null;
  jobFailureRetryable.value = false;
  interactionPrompt.value = "";
  try {
    const res = await getAssetAssistantJob(ctx.value, { workspaceId: props.workspaceId, jobId: nextJobId });
    if (!res.ok) throw new Error(res.message || "加载助手会话失败");
    await applyJobSnapshot(res.job, res.draft);
    if (isOpenJobStatus(res.job.status) && res.job.status !== "awaiting_review") {
      startPolling(res.job.id);
    } else if (res.job.status === "awaiting_review") {
      startPolling(res.job.id);
    }
  } catch (error) {
    running.value = false;
    errorText.value = error instanceof Error ? error.message : "加载助手会话失败";
    stopPolling();
  }
}

/** 应用 job 快照到当前面板，并同步给左侧会话列表。 */
async function applyJobSnapshot(job: AssetGenerationJob, draftSummary: OrchAssetDraftJobSummary | null): Promise<void> {
  jobId.value = job.id;
  jobStatus.value = job.status;
  jobFailureRetryable.value = job.failure?.retryable === true;
  activeThreadId.value = job.threadId ?? null;
  statusText.value = job.progress?.headline || job.status;
  interactionPrompt.value = job.interactionRequest?.prompt?.trim() ?? "";
  running.value = isGeneratingStatus(job.status);
  if (running.value) {
    activeDraft.value = null;
  }
  emit("active-job-change", job.id);
  emit("session-upsert", { job, draft: draftSummary });

  if (job.status === "awaiting_review" && !draftSummary?.id) {
    throw new Error("候选草案已完成，但缺少草案编号");
  }
  if ((job.status === "awaiting_review" || job.status === "applied") && draftSummary?.id) {
    await loadCandidateDraft(
      draftSummary.id,
      job.id,
      job.status === "applied" || draftSummary.status === "applied" ? "applied" : "ready",
    );
    if (job.status === "awaiting_review") {
      statusText.value = "候选草案已生成，等待确认应用";
    }
  }
}

/** 嵌入聊天继续生成时恢复草案任务轮询，避免旧已应用候选卡停留。 */
function resumePollingForEmbeddedChatTurn(): void {
  const currentJobId = jobId.value;
  if (!currentJobId) return;
  errorText.value = "";
  running.value = true;
  statusText.value = "助手正在生成候选草案";
  if (activeDraft.value?.state === "applied") activeDraft.value = null;
  if (pollTimer === null) startPolling(currentJobId);
}

/** 嵌入聊天自然收口后补拉一次任务快照，覆盖错过轮询的边界。 */
async function refreshAssistantJobAfterEmbeddedTurn(): Promise<void> {
  const currentJobId = jobId.value;
  if (!currentJobId || pollTimer !== null) return;
  try {
    const res = await getAssetAssistantJob(ctx.value, { workspaceId: props.workspaceId, jobId: currentJobId });
    if (!res.ok) throw new Error(res.message || "加载助手状态失败");
    await applyJobSnapshot(res.job, res.draft);
    if (res.job.status === "failed" || res.job.status === "rejected") {
      errorText.value = res.job.failure?.message || res.job.progress?.detail || "助手执行失败";
    } else if (isGeneratingStatus(res.job.status)) {
      startPolling(currentJobId);
    }
  } catch (error) {
    running.value = false;
    errorText.value = error instanceof Error ? error.message : "助手执行失败";
  }
}

/** 发起资产草案任务；任务执行过程进入真实 asset-draft 会话。 */
async function startAssistantSession(): Promise<boolean> {
  errorText.value = "";
  const roleSnapshot = buildRoleSnapshot();
  const skillSnapshot = buildSkillSnapshot();
  if (assetKind.value === "role" && !roleSnapshot) {
    errorText.value = "请先选择一个可优化的自定义 Agent";
    return false;
  }
  if (assetKind.value === "skill" && !skillSnapshot) {
    errorText.value = "请先选择一个可优化的自定义 Skill";
    return false;
  }
  const userPrompt = prompt.value.trim() || buildDefaultPrompt(assetKind.value === "role" ? roleSnapshot! : skillSnapshot!);
  running.value = true;
  jobId.value = null;
  activeDraft.value = null;
  activeThreadId.value = null;
  statusText.value = "正在启动助手会话";
  jobStatus.value = null;
  jobFailureRetryable.value = false;
  interactionPrompt.value = "";
  try {
    const res = await startAssetAssistantJob(ctx.value, {
      workspaceId: props.workspaceId,
      assetKind: assetKind.value,
      mode: mode.value,
      targetAssetId: mode.value === "revise" ? (assetKind.value === "role" ? roleSnapshot!.id : skillSnapshot!.id) : null,
      roleSnapshot: assetKind.value === "role" ? roleSnapshot : null,
      skillSnapshot: assetKind.value === "skill" ? skillSnapshot : null,
      clientRequestId: createClientRequestId(),
      prompt: userPrompt,
      contextOptions: {
        includeExistingAssets: true,
        includeWorkspaceFiles: true,
        includeWorkbenchDocs: false,
        maxContextChars: 20000,
        selectedPaths: [],
      },
      enginePreference: {
        engine: engine.value || null,
        model: null,
        effort: null,
      },
    });
    if (!res.ok) {
      const existingJob = readExistingJobId(res.details);
      if (existingJob) {
        jobId.value = existingJob;
        emit("active-job-change", existingJob);
        emit("sessions-refresh");
        statusText.value = "检测到已有进行中的助手草案任务，正在继续跟踪";
        startPolling(existingJob);
        return true;
      }
      throw new Error(res.message || "启动助手失败");
    }
    jobId.value = res.job.id;
    jobStatus.value = res.job.status;
    activeThreadId.value = res.job.threadId ?? null;
    statusText.value = res.job.progress?.headline || "助手会话已启动";
    emit("active-job-change", res.job.id);
    emit("session-upsert", { job: res.job, draft: null });
    prompt.value = "";
    startPolling(res.job.id);
    return true;
  } catch (error) {
    running.value = false;
    errorText.value = error instanceof Error ? error.message : "助手执行失败";
    return false;
  }
}

/** 轮询草案任务状态，并同步执行 thread 与候选卡。 */
function startPolling(nextJobId: AssetGenerationJobId): void {
  stopPolling();
  const tick = async (): Promise<void> => {
    try {
      const res = await getAssetAssistantJob(ctx.value, { workspaceId: props.workspaceId, jobId: nextJobId });
      if (!res.ok) throw new Error(res.message || "加载助手状态失败");
      await applyJobSnapshot(res.job, res.draft);

      if (res.job.status === "failed" || res.job.status === "rejected") {
        running.value = false;
        errorText.value = res.job.failure?.message || res.job.progress?.detail || "助手执行失败";
        stopPolling();
        return;
      }

      if (res.job.status === "applied") {
        running.value = false;
        stopPolling();
        return;
      }

      pollTimer = window.setTimeout(tick, pollingDelayMs(res.job.status));
    } catch (error) {
      running.value = false;
      errorText.value = error instanceof Error ? error.message : "助手执行失败";
      stopPolling();
    }
  };
  pollTimer = window.setTimeout(tick, 600);
}

/** 读取候选草案详情，避免在轮询中重复覆盖已应用状态。 */
async function loadCandidateDraft(
  draftId: AssetDraftId,
  sourceJobId: AssetGenerationJobId,
  nextState: CandidateDraft["state"] = "ready",
): Promise<void> {
  if (activeDraft.value?.draftId === draftId && activeDraft.value.state === nextState && activeDraft.value.state !== "applying") return;
  if (activeDraft.value?.draftId === draftId && activeDraft.value.state === "applied" && nextState !== "applied") return;
  const result = await getAssetAssistantResult(ctx.value, { workspaceId: props.workspaceId, draftId });
  if (!result.ok) throw new Error(result.message || "读取候选草案失败");
  activeDraft.value = {
    draftId: result.draft.id,
    jobId: sourceJobId,
    payload: result.payload,
    comparison: result.comparison,
    validationIssues: result.draft.validationIssues ?? [],
    state: nextState,
    appliedRoleId: result.appliedRoleId ?? null,
    appliedSkillId: result.appliedSkillId ?? null,
    appliedVersionId: result.appliedVersionId ?? null,
  };
}

/** 打开确认框，确认后应用候选草案到正式 Agent 并生成版本记录。 */
function confirmApplyDraft(): void {
  if (!activeDraft.value || activeDraft.value.state !== "ready") return;
  if (candidateErrors.value.length > 0) {
    message.error("候选草案仍有阻断性校验问题，请先让助手修正。");
    return;
  }
  const assetLabel = activeDraft.value.payload.assetKind === "skill" ? "Skill" : "Agent";
  const warningCount = candidateWarnings.value.length;
  Modal.confirm({
    title: `应用 ${assetLabel} 草案`,
    content: warningCount > 0
      ? `该草案包含 ${warningCount} 条警告。确认后会写入正式 ${assetLabel}，并保留资产版本记录。`
      : `确认后会写入正式 ${assetLabel}，并保留资产版本记录。`,
    okText: "确认应用",
    cancelText: "取消",
    async onOk() {
      await applyDraft();
    },
  });
}

/** 构造正式依赖缺失错误，补齐刷新后资产被删除或历史草案缺少服务端校验的问题。 */
function makeReferenceIssue(code: string, fieldPath: string, issueMessage: string, suggestion: string): AssetValidationIssue {
  return {
    code,
    severity: "error",
    fieldPath,
    message: issueMessage,
    suggestion,
    source: "reference",
    blocking: true,
  };
}

/** 合并服务端校验和前端即时依赖校验，按稳定字段去重。 */
function mergeValidationIssues(primary: AssetValidationIssue[], secondary: AssetValidationIssue[]): AssetValidationIssue[] {
  const seen = new Set<string>();
  const merged: AssetValidationIssue[] = [];
  for (const issue of [...primary, ...secondary]) {
    const key = `${issue.code}::${issue.fieldPath}::${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

/** 应用草案；仅回写原页面和管理列表，失败显式抛出且保留已应用事实。 */
async function applyDraft(): Promise<void> {
  const draft = activeDraft.value;
  if (!draft || draft.state !== "ready" || applying.value) return;
  const workspaceId = props.workspaceId;
  const workspaceEpoch = orch.assetListWorkspaceEpoch;
  const rolePurpose = orch.assetListPurposes.role;
  const requestContext = ctx.value;
  /** 工作区、草案或组件生命周期变化后，不向新的页面回写旧操作。 */
  const isCurrentDraft = () => !assistantUnmounted && props.workspaceId === workspaceId
    && orch.assetListWorkspaceEpoch === workspaceEpoch
    && activeDraft.value?.draftId === draft.draftId && activeDraft.value.jobId === draft.jobId;
  applying.value = true;
  errorText.value = "";
  activeDraft.value = { ...draft, state: "applying" };
  try {
    const res = await applyAssetAssistantDraft(requestContext, {
      workspaceId,
      draftId: draft.draftId,
      expectedJobId: draft.jobId,
      expectedBaseVersionId: draft.payload.baseVersionId ?? null,
      forceApplyWarnings: true,
      review: {
        comment: "用户在助手候选卡确认应用",
        acknowledgedWarningCodes: candidateWarnings.value.map((issue) => issue.code),
        reviewedDiffHash: null,
      },
    });
    if (!res.ok) throw createApiResultError(res);
    if (!isCurrentDraft()) return;
    activeDraft.value = {
      ...draft,
      state: "applied",
      appliedRoleId: res.assetKind === "role" ? res.roleId : null,
      appliedSkillId: res.assetKind === "skill" ? res.skillId : null,
      appliedVersionId: res.versionId,
    };
    jobStatus.value = "applied";
    statusText.value = draft.payload.assetKind === "skill" ? "Skill 草案已应用" : "Agent 草案已应用";
    stopPolling();
    emit("sessions-refresh");
    if (res.assetKind === "skill") {
      await orch.refreshSkills(requestContext, workspaceId);
      if (!isCurrentDraft()) return;
      orch.selectedSkillId = res.skillId;
      message.success("Skill 草案已应用");
    } else {
      if (rolePurpose === "catalog" && orch.assetListPurposes.role === "catalog") {
        await orch.refreshRoles(requestContext, workspaceId);
        if (!isCurrentDraft()) return;
        if (orch.assetListPurposes.role === "catalog") orch.selectedRoleId = res.roleId;
      }
      message.success("Agent 草案已应用");
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "应用候选草案失败";
    console.error("[AssetAssistantPanel] draft apply failed", {
      errorCode: error instanceof ApiResultError ? error.code : "ORCH_DRAFT_APPLY_FAILED",
      requestId: error instanceof ApiResultError ? (error.details as { requestId?: unknown } | undefined)?.requestId ?? null : null,
      workspaceId, draftId: draft.draftId, jobId: draft.jobId, rootCause: messageText,
    });
    if (isCurrentDraft()) {
      if (activeDraft.value?.state !== "applied") activeDraft.value = { ...draft, state: "ready" };
      errorText.value = messageText;
      message.error(messageText);
    }
    throw error;
  } finally {
    if (!assistantUnmounted) applying.value = false;
  }
}

/** 切到正式资产表单，便于继续人工检查和微调。 */
function openAppliedAsset(): void {
  if (activeDraft.value?.payload.assetKind === "skill") {
    const skillId = activeDraft.value.appliedSkillId;
    if (!skillId) {
      message.warning("没有找到该草案落地的正式 Skill，可能已被删除或尚未应用。");
      return;
    }
    emit("open-skill", skillId);
    return;
  }
  const roleId = activeDraft.value?.appliedRoleId;
  if (!roleId) {
    message.warning("没有找到该草案落地的正式 Agent，可能已被删除或尚未应用。");
    return;
  }
  emit("open-role", roleId);
}

/** 打开候选草案预览弹框并定位到指定标签页。 */
function openDraftPreview(tab: DraftPreviewTabKey = "definition"): void {
  if (!activeDraft.value) return;
  previewTab.value = tab;
  previewOpen.value = true;
}

/** 从预览弹框跳到正式 Agent 表单前先收起弹框。 */
function handlePreviewOpenAsset(): void {
  previewOpen.value = false;
  openAppliedAsset();
}

/** 根据当前模式构造提交给草案服务的角色快照。 */
function buildRoleSnapshot(): EditableRole | null {
  if (mode.value === "revise") {
    const role = selectedRole.value;
    if (!role) return null;
    return {
      id: role.id,
      workspaceId: props.workspaceId,
      name: role.name,
      description: role.description,
      responsibility: role.responsibility ?? "",
      systemPrompt: role.systemPrompt,
      inputDefinition: role.inputDefinition,
      outputDefinition: role.outputDefinition,
      gateCriteria: [...(role.gateCriteria ?? [])],
      executionConfig: role.executionConfig,
      defaultKnowledgeBundleIds: [...(role.defaultKnowledgeBundleIds ?? [])],
      toolRefs: (role.toolRefs ?? []).map((item) => ({ ...item })),
      kind: role.kind,
    };
  }
  return {
    id: "" as RoleId,
    workspaceId: props.workspaceId,
    name: agentName.value.trim() || "新 Agent",
    description: "负责一类稳定工程动作的专业 Agent。",
    responsibility: "在明确职责边界内理解任务、执行操作并交付可验证结果。",
    systemPrompt: [
      "您是软件工程编排中的专业 Agent，必须先理解当前目标、上游输入和约束，再开始执行。",
      "不要假装完成未验证的工作；如果信息不足、结果不确定或存在风险，必须直接说明。",
      "输出时要交代做了什么、依据是什么、结果是否可靠，以及下一步建议。",
    ].join("\n"),
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig(preferredEngine.value),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
  };
}

/** 为草案服务生成默认用户意图，避免空输入时没有明确目标。 */
function buildSkillSnapshot(): EditableSkill | null {
  if (assetKind.value !== "skill") return null;
  if (mode.value === "revise") {
    const skill = selectedSkill.value;
    if (!skill) return null;
    return {
      id: skill.id,
      workspaceId: props.workspaceId,
      name: skill.name,
      slug: skill.slug ?? null,
      description: skill.description,
      trigger: skill.trigger,
      instructions: skill.instructions,
      targetEngines: [...(skill.targetEngines ?? [])],
      tags: [...(skill.tags ?? [])],
      kind: skill.kind,
      packageVersion: skill.packageVersion ?? 1,
      skillMd: skill.skillMd ?? null,
      files: (skill.files ?? []).map((file) => ({ ...file })),
      scripts: (skill.scripts ?? []).map((script) => ({ ...script })),
      installTargets: [...(skill.installTargets ?? skill.targetEngines ?? [])],
      packageHash: skill.packageHash ?? null,
    };
  }
  const name = skillName.value.trim() || "新 Skill";
  const selectedEngine = preferredEngine.value === "claude" ? "claude" : "codex";
  const targetEngines = [selectedEngine] as SkillTargetEngine[];
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "new-skill";
  const skillMd = [
    "---",
    `name: "${slug}"`,
    `description: "${name}"`,
    "---",
    "",
    `# ${name}`,
    "",
    "## Instructions",
    "",
    "Describe when to use this Skill and how to execute it.",
  ].join("\n");
  return {
    id: "" as SkillId,
    workspaceId: props.workspaceId,
    name,
    slug,
    description: "可复用的软件工程 Skill。",
    trigger: "当任务需要该能力时使用。",
    instructions: "先判断是否匹配触发条件，再按 SKILL.md 中的步骤执行，并说明结果与风险。",
    targetEngines,
    tags: [],
    kind: "custom",
    packageVersion: 1,
    skillMd,
    files: [{
      relPath: "SKILL.md",
      kind: "skill-md",
      contentText: skillMd,
      contentBase64: null,
      contentType: "text/markdown",
      sizeBytes: new Blob([skillMd]).size,
      sha256: "",
    }],
    scripts: [],
    installTargets: targetEngines,
    packageHash: null,
  };
}

/** 为草案服务生成默认用户意图，避免空输入时没有明确目标。 */
function buildDefaultPrompt(snapshot: EditableRole | EditableSkill): string {
  if ("targetEngines" in snapshot) {
    if (mode.value === "create") {
      return `请创建一个名为「${snapshot.name}」的 Skill，补全触发条件、执行说明、SKILL.md、文件和可选脚本入口。`;
    }
    return `请优化「${snapshot.name}」这个 Skill，优先使用增量 patch 修改字段、SKILL.md、文件或脚本。`;
  }
  const roleSnapshot = snapshot;
  if (mode.value === "create") {
    return `请创建一个名为「${roleSnapshot.name}」的 Agent，补全职责、系统提示词、输入定义、输出定义、默认知识库、工具和执行配置。`;
  }
  return `请优化「${roleSnapshot.name}」这个 Agent，保留核心职责，同时让提示词、输入输出契约、工具和知识库绑定更清晰。`;
}

/** 停止状态轮询，避免组件卸载后继续更新页面状态。 */
function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** 兼容服务端返回的 existingJob details，避免同一资产重复启动任务。 */
function readExistingJobId(details: unknown, depth = 0): AssetGenerationJobId | null {
  if (depth > 4 || typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const record = details as { existingJob?: { id?: unknown }; details?: unknown };
  const existingJob = record.existingJob;
  if (typeof existingJob?.id === "string" && existingJob.id) return existingJob.id as AssetGenerationJobId;
  return readExistingJobId(record.details, depth + 1);
}

/** 创建草案生成请求幂等标识。 */
function createClientRequestId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);
  return `asset-assistant-${Date.now()}-${suffix}`;
}

/** 判断任务是否仍会阻塞同类草案创建。 */
function isOpenJobStatus(status: AssetGenerationJobStatus): boolean {
  return status === "queued"
    || status === "planning"
    || status === "collecting_context"
    || status === "generating"
    || status === "validating"
    || status === "awaiting_input"
    || status === "awaiting_review";
}

/** 判断任务是否处在引擎执行或准备阶段。 */
function isGeneratingStatus(status: AssetGenerationJobStatus): boolean {
  return status === "queued"
    || status === "planning"
    || status === "collecting_context"
    || status === "generating"
    || status === "validating";
}

/** 根据任务状态控制轮询频率；等待用户时降低请求频率。 */
function pollingDelayMs(status: AssetGenerationJobStatus): number {
  if (status === "awaiting_input" || status === "awaiting_review") return 2500;
  return 1200;
}
</script>

<template>
  <div class="asset-assistant">
    <section class="asset-assistant__chat">
      <header class="asset-assistant__chat-head">
        <div>
          <h3>助手</h3>
          <p>通过实时会话生成和调整 Agent / Skill 候选草案。</p>
        </div>
        <span class="asset-assistant__status">{{ sessionSubtitle }}</span>
      </header>

      <div v-if="statusText || errorText" class="asset-assistant__status-stack">
        <div v-if="statusText" class="asset-assistant__notice">
          <strong>状态</strong>
          <span>{{ statusText }}</span>
        </div>
        <div v-if="jobStatus === 'awaiting_input' && interactionPrompt" class="asset-assistant__notice asset-assistant__notice--pending">
          <strong>需要补充</strong>
          <span>{{ interactionPrompt }}</span>
        </div>
        <div v-if="errorText" class="asset-assistant__notice asset-assistant__notice--error">
          <strong>失败</strong>
          <span>{{ errorText }}</span>
        </div>
      </div>

      <div v-if="!activeThreadId" class="asset-assistant__empty">
        <div class="asset-assistant__empty-copy">
          <h4>{{ running || jobId ? "正在准备助手会话" : "尚未新建助手会话" }}</h4>
          <p>{{ running || jobId ? "系统正在创建实时会话，请稍候。" : "点击新建后先填写本次会话的固定要素，再进入实时会话。" }}</p>
        </div>
        <button
          v-if="!running && !jobId"
          class="asset-assistant__primary"
          type="button"
          :disabled="props.maintenanceForbidden"
          @click="openCreateDialog"
        >
          <SendOutlined />
          <span>新建会话</span>
        </button>
      </div>

      <ChatPanel
        v-else
        class="asset-assistant__chat-panel"
        :workspace-id="workspaceId"
        :thread-id="activeThreadId"
        assistant-mode
        :composer-disabled="composerDisabled"
      >
        <template #composer-guard>
          <div v-if="composerGuardText" class="asset-assistant__composer-guard">{{ composerGuardText }}</div>
        </template>
      </ChatPanel>
    </section>

    <a-modal
      v-model:open="createDialogOpen"
      title="新建助手会话"
      ok-text="开始会话"
      cancel-text="取消"
      :confirm-loading="running"
      :ok-button-props="createOkButtonProps"
      @ok="handleCreateDialogOk"
    >
      <div class="asset-assistant__modal-form">
        <div class="asset-assistant__setup-grid">
          <label class="asset-assistant__control">
            <span>资产</span>
            <select v-model="assetKind" :disabled="running || applying">
              <option value="role">Agent</option>
              <option value="skill">Skill</option>
            </select>
          </label>
          <label class="asset-assistant__control">
            <span>模式</span>
            <select v-model="mode" :disabled="running || applying">
              <option value="create">创建{{ assetKind === "skill" ? " Skill" : " Agent" }}</option>
              <option value="revise">优化{{ assetKind === "skill" ? " Skill" : " Agent" }}</option>
            </select>
          </label>
          <label v-if="mode === 'create' && assetKind === 'role'" class="asset-assistant__control">
            <span>名称</span>
            <input v-model="agentName" name="asset-assistant-agent-name" autocomplete="new-password" :disabled="running || applying" />
          </label>
          <label v-else-if="mode === 'create'" class="asset-assistant__control">
            <span>名称</span>
            <input v-model="skillName" name="asset-assistant-skill-name" autocomplete="new-password" :disabled="running || applying" />
          </label>
          <label v-else-if="assetKind === 'role'" class="asset-assistant__control">
            <span>目标 Agent</span>
            <select v-model="selectedRoleId" :disabled="running || applying">
              <option value="">选择自定义 Agent</option>
              <option v-for="role in editableRoles" :key="role.id" :value="role.id">{{ role.name }}</option>
            </select>
          </label>
          <label v-else class="asset-assistant__control">
            <span>目标 Skill</span>
            <select v-model="selectedSkillId" :disabled="running || applying">
              <option value="">选择自定义 Skill</option>
              <option v-for="skill in editableSkills" :key="skill.id" :value="skill.id">{{ skill.name }}</option>
            </select>
          </label>
          <label class="asset-assistant__control">
            <span>引擎</span>
            <select v-model="engine" :disabled="running || applying">
              <option value="">自动</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        </div>

        <label class="asset-assistant__field asset-assistant__field--prompt">
          <span>初始说明</span>
          <textarea
            v-model="prompt"
            rows="5"
            name="asset-assistant-prompt"
            autocomplete="off"
            :disabled="running || applying"
            :placeholder="promptPlaceholder"
          />
        </label>

        <div class="asset-assistant__setup-summary">{{ setupSummary }}</div>
      </div>
    </a-modal>

    <aside class="asset-assistant__candidate" aria-label="候选草案">
      <header class="asset-assistant__candidate-head">
        <div>
          <span>候选卡片</span>
          <strong>{{ candidateTitle }}</strong>
        </div>
        <div v-if="activeDraft" class="asset-assistant__candidate-head-actions">
          <button class="asset-assistant__candidate-preview" type="button" title="预览候选草案完整内容" @click="openDraftPreview('definition')">
            <EyeOutlined />
            <span>预览</span>
          </button>
          <span class="asset-assistant__candidate-state">
            {{ activeDraft.state === "applied" ? "已应用" : activeDraft.state === "applying" ? "应用中" : "待确认" }}
          </span>
        </div>
      </header>

      <div v-if="!activeDraft" class="asset-assistant__candidate-empty">
        会话生成完成后，这里会显示候选草案、差异摘要和应用入口。
      </div>

      <template v-else>
        <div class="asset-assistant__candidate-scroll">
        <section
          class="asset-assistant__candidate-section asset-assistant__candidate-section--link"
          role="button"
          tabindex="0"
          title="查看完整 Agent 定义"
          @click="openDraftPreview('definition')"
          @keydown.enter.prevent="openDraftPreview('definition')"
        >
          <strong>{{ activeDraft.payload.assetKind === "skill" ? "Skill 摘要" : "职责摘要" }}<span class="asset-assistant__candidate-more">详情 ›</span></strong>
          <p>{{ candidatePrimaryText }}</p>
          <p>{{ candidateSecondaryText }}</p>
        </section>

        <section
          class="asset-assistant__candidate-section asset-assistant__candidate-section--link"
          role="button"
          tabindex="0"
          title="查看字段级变更对比"
          @click="openDraftPreview('diff')"
          @keydown.enter.prevent="openDraftPreview('diff')"
        >
          <strong>变更摘要<span class="asset-assistant__candidate-more">详情 ›</span></strong>
          <div class="asset-assistant__stats">
            <span>新增 {{ activeDraft.comparison.summary.added }}</span>
            <span>修改 {{ activeDraft.comparison.summary.modified }}</span>
            <span>移除 {{ activeDraft.comparison.summary.removed }}</span>
            <span>警告 {{ activeDraft.comparison.summary.warnings }}</span>
          </div>
          <ul v-if="candidateSections.length" class="asset-assistant__diff-list">
            <li v-for="section in candidateSections" :key="section.key">
              <span>{{ section.label }}</span>
              <strong>{{ section.changeCount }}</strong>
            </li>
          </ul>
          <p v-else>没有检测到字段级差异。</p>
        </section>

        <section
          v-if="candidateWarnings.length || candidateErrors.length"
          class="asset-assistant__candidate-section asset-assistant__candidate-section--link"
          role="button"
          tabindex="0"
          title="对照完整定义检查校验提示"
          @click="openDraftPreview('definition')"
          @keydown.enter.prevent="openDraftPreview('definition')"
        >
          <strong>校验提示<span class="asset-assistant__candidate-more">详情 ›</span></strong>
          <ul class="asset-assistant__issue-list">
            <li v-for="issue in candidateErrors" :key="`${issue.code}-${issue.fieldPath}`" class="asset-assistant__issue asset-assistant__issue--error">
              {{ issue.fieldPath }}：{{ issue.message }}
            </li>
            <li v-for="issue in candidateWarnings" :key="`${issue.code}-${issue.fieldPath}`" class="asset-assistant__issue">
              {{ issue.fieldPath }}：{{ issue.message }}
            </li>
          </ul>
        </section>

        <section
          class="asset-assistant__candidate-section asset-assistant__candidate-section--link"
          role="button"
          tabindex="0"
          title="查看生成依据明细"
          @click="openDraftPreview('rationale')"
          @keydown.enter.prevent="openDraftPreview('rationale')"
        >
          <strong>生成依据<span class="asset-assistant__candidate-more">详情 ›</span></strong>
          <div class="asset-assistant__tags">
            <span v-for="tag in candidateReferenceTags" :key="tag">{{ tag }}</span>
          </div>
        </section>

        <section
          class="asset-assistant__candidate-section asset-assistant__candidate-section--link"
          role="button"
          tabindex="0"
          title="查看关键决策与假设风险"
          @click="openDraftPreview('rationale')"
          @keydown.enter.prevent="openDraftPreview('rationale')"
        >
          <strong>决策说明<span class="asset-assistant__candidate-more">详情 ›</span></strong>
          <p>{{ activeDraft.payload.rationale.summary }}</p>
        </section>
        </div>

        <div class="asset-assistant__candidate-actions">
          <button
            v-if="activeDraft.state !== 'applied'"
            class="asset-assistant__primary"
            type="button"
            :disabled="applying || candidateErrors.length > 0"
            @click="confirmApplyDraft"
          >
            <CheckCircleOutlined />
            <span>{{ applying ? "应用中..." : "确认应用" }}</span>
          </button>
          <button
            v-else
            class="asset-assistant__ghost"
            type="button"
            @click="openAppliedAsset"
          >
            查看 {{ activeAssetLabel }}
          </button>
        </div>
      </template>
    </aside>

    <AssetDraftPreviewModal
      v-model:open="previewOpen"
      :workspace-id="workspaceId"
      :initial-tab="previewTab"
      :payload="activeDraft?.payload ?? null"
      :comparison="activeDraft?.comparison ?? null"
      :validation-issues="candidateValidationIssues"
      :draft-state="activeDraft?.state ?? null"
      :apply-disabled="applying || candidateErrors.length > 0"
      @apply="confirmApplyDraft"
      @open-asset="handlePreviewOpenAsset"
    />
  </div>
</template>

<style scoped>
.asset-assistant {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  gap: 16px;
  height: 100%;
  min-height: 0;
  padding: 16px;
  background: var(--app-bg);
}

.asset-assistant__chat,
.asset-assistant__candidate {
  min-height: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
  box-shadow: var(--app-shadow-sm);
}

.asset-assistant__chat {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.asset-assistant__chat-head,
.asset-assistant__candidate-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--app-border);
}

.asset-assistant__chat-head h3,
.asset-assistant__chat-head p {
  margin: 0;
}

.asset-assistant__chat-head h3 {
  color: var(--app-text);
  font-size: 16px;
  font-weight: 700;
}

.asset-assistant__chat-head p {
  margin-top: 3px;
  color: var(--app-muted);
  font-size: 12px;
}

.asset-assistant__status,
.asset-assistant__candidate-state {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 3px 9px;
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  color: var(--app-accent);
  font-size: 12px;
  font-weight: 600;
}

.asset-assistant__status-stack {
  display: grid;
  gap: 8px;
  padding: 12px 16px 0;
}

.asset-assistant__notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border: 1px solid color-mix(in srgb, var(--app-accent) 28%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-text);
  font-size: 12px;
}

.asset-assistant__notice--pending {
  border-color: color-mix(in srgb, var(--app-warning) 35%, transparent);
  background: color-mix(in srgb, var(--app-warning) 14%, transparent);
  color: var(--app-text);
}

.asset-assistant__notice--error {
  border-color: color-mix(in srgb, var(--app-danger) 35%, transparent);
  background: color-mix(in srgb, var(--app-danger) 12%, transparent);
  color: var(--app-text);
}

.asset-assistant__empty {
  display: grid;
  flex: 1;
  min-height: 0;
  place-items: center;
  align-content: center;
  gap: 16px;
  padding: 28px;
  text-align: center;
}

.asset-assistant__empty-copy {
  display: grid;
  gap: 6px;
  max-width: 420px;
}

.asset-assistant__empty-copy h4,
.asset-assistant__empty-copy p {
  margin: 0;
}

.asset-assistant__empty-copy h4 {
  color: var(--app-text);
  font-size: 16px;
  font-weight: 700;
}

.asset-assistant__empty-copy p {
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
}

.asset-assistant__setup-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.asset-assistant__control,
.asset-assistant__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 600;
}

.asset-assistant__control input,
.asset-assistant__control select,
.asset-assistant__field textarea {
  width: 100%;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  font: inherit;
  font-weight: 500;
  outline: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.asset-assistant__control input,
.asset-assistant__control select {
  height: 36px;
  padding: 0 10px;
}

.asset-assistant__field textarea {
  min-height: 68px;
  resize: vertical;
  padding: 9px 10px;
  line-height: 1.5;
}

.asset-assistant__field--prompt textarea {
  min-height: 140px;
}

.asset-assistant__control input:focus,
.asset-assistant__control select:focus,
.asset-assistant__field textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent) 60%, var(--app-border));
  box-shadow: var(--app-ring);
}

.asset-assistant__modal-form {
  display: grid;
  gap: 14px;
}

.asset-assistant__setup-summary {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 9px 10px;
  background: color-mix(in srgb, var(--app-text) 4%, var(--app-panel-bg));
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 700;
}

.asset-assistant__primary,
.asset-assistant__ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.asset-assistant__primary {
  border: 1px solid var(--app-accent);
  background: var(--app-accent);
  color: #fff;
}

.asset-assistant__ghost {
  border: 1px solid var(--app-border);
  background: var(--app-panel-bg);
  color: var(--app-text);
}

.asset-assistant__primary:disabled,
.asset-assistant__ghost:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.asset-assistant__chat-panel {
  flex: 1;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.asset-assistant__composer-guard {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--app-text) 4%, var(--app-panel-bg));
  color: var(--app-muted);
  font-size: 12px;
}

.asset-assistant__candidate {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.asset-assistant__candidate-head span {
  display: block;
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 600;
}

.asset-assistant__candidate-head strong {
  display: block;
  max-width: 240px;
  margin-top: 3px;
  overflow: hidden;
  color: var(--app-text);
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-assistant__candidate-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.asset-assistant__candidate-preview {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  padding: 3px 10px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease;
}

.asset-assistant__candidate-preview:hover {
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.asset-assistant__candidate-section--link {
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.asset-assistant__candidate-section--link:hover {
  background: color-mix(in srgb, var(--app-text) 6%, transparent);
}

.asset-assistant__candidate-section--link:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}

.asset-assistant__candidate-section--link > strong {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.asset-assistant__candidate-more {
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 600;
}

.asset-assistant__candidate-section--link:hover .asset-assistant__candidate-more {
  color: var(--app-accent);
}

.asset-assistant__candidate-empty {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 28px;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}

.asset-assistant__candidate-section {
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--app-border);
  padding: 14px 16px;
}

.asset-assistant__candidate-section strong {
  color: var(--app-text);
  font-size: 13px;
}

.asset-assistant__candidate-section p {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.asset-assistant__stats,
.asset-assistant__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.asset-assistant__stats span,
.asset-assistant__tags span {
  border-radius: 999px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 600;
}

.asset-assistant__diff-list,
.asset-assistant__issue-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.asset-assistant__diff-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 7px 9px;
  color: var(--app-muted);
  font-size: 12px;
}

.asset-assistant__issue {
  border-left: 3px solid var(--app-warning);
  padding-left: 8px;
  color: var(--app-warning);
  font-size: 12px;
  line-height: 1.5;
}

.asset-assistant__issue--error {
  border-left-color: var(--app-danger);
  color: var(--app-danger);
}

.asset-assistant__candidate-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.asset-assistant__candidate-actions {
  flex: 0 0 auto;
  border-top: 1px solid var(--app-border);
  padding: 14px 16px;
}

@media (max-width: 1180px) {
  .asset-assistant {
    grid-template-columns: minmax(0, 1fr);
  }

  .asset-assistant__candidate {
    min-height: 360px;
  }
}

@media (max-width: 760px) {
  .asset-assistant {
    padding: 10px;
  }

  .asset-assistant__chat-head,
  .asset-assistant__candidate-head {
    align-items: stretch;
    flex-direction: column;
  }

  .asset-assistant__setup-grid {
    grid-template-columns: 1fr;
  }
}
</style>
