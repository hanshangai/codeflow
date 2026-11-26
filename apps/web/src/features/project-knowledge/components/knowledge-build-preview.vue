<script setup lang="ts">
import type { KnowledgeAssetDetail, KnowledgeAssetDocument, KnowledgeAssetNode, KnowledgeGenerationAdoption, KnowledgeGenerationApplyInput, KnowledgeGenerationPreview, KnowledgeGenerationRunView, KnowledgeReviewIssue, KnowledgeReviewReportView, KnowledgeUpdateView } from "@codeflowai/shared";
import { Modal } from "ant-design-vue";
import { LoadingOutlined } from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { createApiResultError, isApiResultError, type ApiRequestContext } from "../../../api/request";
import MarkdownContent from "../../markdown/MarkdownContent.vue";
import DiffViewer from "../../chat/components/diff-viewer.vue";
import KnowledgeReviewReport from "./knowledge-review-report.vue";
import { knowledgeAdoptionSelection, knowledgeSelectedNodes, knowledgeTreeRows } from "../knowledgeTreeModel";
import type { KnowledgeDocumentContext } from "../knowledgeWorkTreeModel";
import { knowledgeDocumentReviewActivity, knowledgeItemNeedsReview } from "../knowledgeReviewModel";

const props = withDefaults(defineProps<{ workspaceId: string; context: ApiRequestContext; run: KnowledgeGenerationRunView; runs?: KnowledgeGenerationRunView[]; nodes?: KnowledgeAssetNode[]; canWrite: boolean; actionsBusy?: boolean; canStartTask?: boolean; embedded?: boolean; recoveryOnly?: boolean; suppliedPreview?: KnowledgeGenerationPreview | null; restrictionReason?: string | null; allowAdoption?: boolean; scopeNodeId?: string | null; focus?: { nodeId: string; revisionId?: string | null; report: boolean; selectOnly?: boolean } | null }>(), { allowAdoption: true, canStartTask: true });
const emit = defineEmits<{ changed: [run: KnowledgeGenerationRunView]; busy: [value: boolean]; openFile: [path: string]; review: [nodeId: string]; refreshSources: [context: KnowledgeDocumentContext]; resumeReview: [context: KnowledgeDocumentContext]; repair: [report: KnowledgeReviewReportView]; repairIssue: [report: KnowledgeReviewReportView, issue: KnowledgeReviewIssue]; returnToGeneration: [report: KnowledgeReviewReportView, runId: string]; error: [error: unknown, context: { runId: string; nodeId: string | null }] }>();
const preview = shallowRef<KnowledgeGenerationPreview | null>(null);
const selected = ref<string[]>([]), selectedId = ref<string | null>(null);
const detail = shallowRef<KnowledgeAssetDetail | null>(null), document = shallowRef<KnowledgeAssetDocument | null>(null);
const reports = shallowRef<KnowledgeReviewReportView[]>([]);
const reportsLoading = ref(false);
const reportsReadError = ref<string | null>(null);
const loading = ref(false), reading = ref(false), saving = ref(false), errorText = ref("");
const previewTab = ref<"diff" | "document" | "report">(props.embedded ? "diff" : "document");
const updateView = shallowRef<KnowledgeUpdateView | null>(null);
const maintenanceEnabled = ref(true), maintenanceTime = ref("03:00");
const maintenancePending = ref(false);
const pendingApply = shallowRef<KnowledgeGenerationApplyInput | null>(null);
const adoptions = shallowRef<KnowledgeGenerationAdoption[]>([]);
const cancelledAdoption = computed(() => adoptions.value.filter(receipt => receipt.cancelled).at(-1));
let generation = 0, detailGeneration = 0;
let controller: AbortController | null = null;
let ready: Promise<void> = Promise.resolve();
let maintenanceReady: Promise<boolean> = Promise.resolve(false);
watch(saving, value => emit("busy", value), { flush: "sync" });
/** 活动复检可沿用页面节点展示正文，采用资格仍只来自校验预览。 */
const displayNodes = computed(() => preview.value?.tree.nodes ?? props.run.proposedTree?.nodes ?? props.run.baseTree?.nodes ?? props.nodes);
const scopeNode = computed(() => displayNodes.value?.find(node => node.id === props.scopeNodeId));
const scopeIds = computed(() => scopeNode.value ? new Set(knowledgeSelectedNodes(displayNodes.value ?? [], [scopeNode.value.id], scopeNode.value.contentMode === "directory").map(node => node.id)) : null);
const showList = computed(() => !props.embedded && (!scopeNode.value || scopeNode.value.contentMode === "directory"));
const rows = computed(() => {
  const all = knowledgeTreeRows(displayNodes.value ?? [], new Set(displayNodes.value?.map(node => node.id) ?? []));
  if (!scopeIds.value) return all;
  const depth = all.find(row => row.node.id === scopeNode.value!.id)?.depth ?? 0;
  return all.filter(row => scopeIds.value!.has(row.node.id) && row.node.id !== scopeNode.value!.id).map(row => ({ ...row, depth: Math.max(0, row.depth - depth - 1) }));
});
const items = computed(() => new Map(preview.value?.items.map(item => [item.nodeId, item]) ?? []));
const node = computed(() => displayNodes.value?.find(node => node.id === selectedId.value));
const specificationPaths = computed(() => {
  const lineage = [];
  let current = node.value;
  while (current) { lineage.unshift(current); current = displayNodes.value?.find(parent => parent.id === current?.parentId); }
  return lineage[0]?.category === "specifications" ? [...lineage].reverse().find(parent => parent.appliesTo !== undefined)?.appliesTo ?? [] : null;
});
const productDocument = computed(() => {
  let current = node.value;
  while (current?.parentId) current = displayNodes.value?.find(parent => parent.id === current?.parentId);
  return current?.category === "product";
});
const currentItem = computed(() => selectedId.value ? items.value.get(selectedId.value) : null);
const executionItem = computed(() => props.run.items.find(item => item.nodeId === selectedId.value && item.revisionId === document.value?.revision.id));
const latestReport = computed(() => [...reports.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]);
/** 生成证据已过期时必须交付新候选，单独复检不能更新不可变版本。 */
const sourceRefreshRequired = computed(() => Boolean(document.value && !productDocument.value && currentItem.value?.reasonCode === "KNOWLEDGE_ASSET_SOURCE_CHANGED"));
const readyToAdopt = computed(() => Boolean(currentItem.value?.canApply && !currentItem.value.applied && !currentItem.value.dismissed));
const readyMessage = computed(() => latestReport.value?.outcome === "passed_with_warnings" ? "复检通过，可采用此版本；提醒不阻断采用。" : "此版本已就绪，可确认采用。");
const documentActivity = computed(() => node.value && document.value ? knowledgeDocumentReviewActivity(props.runs ?? [props.run], node.value.id, document.value.revision.id) : null);
const reviewBusy = computed(() => saving.value || props.actionsBusy || props.run.active || Boolean(documentActivity.value) || Boolean(pendingApply.value));
/** 重新复检只避开本文档正被处理的情况，原任务处理其他知识时不阻塞。 */
const restartReviewBusy = computed(() => saving.value || props.actionsBusy || Boolean(documentActivity.value) || Boolean(pendingApply.value));
const canResumeReview = computed(() => ["build", "batch", "review"].includes(props.run.mode) && Boolean(executionItem.value && knowledgeItemNeedsReview(executionItem.value)));
const canReviewVersion = computed(() => document.value?.revision.id === (detail.value?.drafts[0]?.id ?? detail.value?.current?.revision.id));
/** 用简短状态指引当前候选的下一步，具体问题保留在复检报告。 */
const reviewGuidance = computed(() => {
  if (!document.value || !(currentItem.value?.reason || props.restrictionReason) || currentItem.value?.applied || currentItem.value?.dismissed) return null;
  if (sourceRefreshRequired.value) return currentItem.value?.reason ?? "生成来源已变化，请更新候选并复检；原版本会保留。";
  if (reportsLoading.value) return "正在读取复检结果…";
  if (reportsReadError.value) return "复检报告读取失败，请重新读取报告。";
  const report = latestReport.value;
  const failure = executionItem.value?.review?.error;
  if (report && !report.stale && report.outcome !== "issues" && !failure) return null;
  if (!props.canWrite) return "尚未通过复检，请有维护权限的成员处理。";
  if (canResumeReview.value) return failure ? "复检未完成，请重试复检。" : "文档已保存，请继续复检。";
  if (!props.canStartTask) return "此知识尚未加入正式目录，请回工作会话修订。";
  if (productDocument.value && report?.outcome === "issues" && !report.stale) return "原文有问题，请更新资料后重新导入并复检。";
  if (!canReviewVersion.value && (report?.stale || report?.outcome !== "issues")) return "已有更新的待采用版本，请选择最新版本复检。";
  if (report?.stale) return "复检依据已变化，请重新复检。";
  if (report?.outcome === "issues") return `复检发现 ${report.issues.filter(issue => issue.severity === "error").length} 个阻断问题，请按报告修订。`;
  if (failure) return "复检未完成，请重新复检。";
  return "文档尚未复检，通过后可采用。";
});
const applicable = computed(() => preview.value?.items.filter(item => item.canApply && !item.applied && !item.dismissed && !knowledgeDocumentReviewActivity(props.runs ?? [props.run], item.nodeId, item.revisionId)) ?? []);
const scopedApplicable = computed(() => applicable.value.filter(item => !scopeIds.value || scopeIds.value.has(item.nodeId) && (scopeNode.value?.contentMode !== "directory" || item.nodeId !== scopeNode.value.id)));
const allVisibleSelected = computed(() => scopedApplicable.value.length > 0 && scopedApplicable.value.every(item => selected.value.includes(item.nodeId)));
const selections = computed(() => applicable.value.filter(item => selected.value.includes(item.nodeId)).map(({ nodeId, revisionId }) => ({ nodeId, revisionId })));
const reference = computed(() => detail.value?.reference);
const batchAdoption = computed(() => ["build", "batch", "review"].includes(props.run.mode));
const readAt = computed(() => reference.value ? new Date(reference.value.readAt).toLocaleString() : "");

/** 失败保持当前预览，显示请求标识并在拥有上下文的页面边界记录诊断。 */
function fail(error: unknown): void {
  const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  errorText.value = details?.requestId ? `${reason}（请求 ID：${String(details.requestId)}）` : reason;
  emit("error", error, { runId: props.run.id, nodeId: selectedId.value });
}

/** 原任务是采用恢复的事实源，恢复清单不依赖当前可采用项或重新生成的预览令牌。 */
function restoreRun(run: KnowledgeGenerationRunView): void {
  adoptions.value = run.adoptions ?? [];
  if (updateView.value) maintenancePending.value = !updateView.value.schedule && !!run.adoptions?.some(receipt => receipt.completed);
  const receipt = run.adoptions?.find(receipt => !receipt.completed && !receipt.cancelled);
  pendingApply.value = receipt ? { requestId: receipt.requestId, treeHash: receipt.treeHash, planHash: receipt.planHash, selections: receipt.selections.map(item => ({ ...item })) } : null;
  if (receipt) {
    selected.value = receipt.selections.map(item => item.nodeId);
  }
}

/** 沿用页面会话偏好保存维护选择，采用失败或切换视图后不把关闭选择重置为开启。 */
function maintenancePrefs(write = false): void {
  const key = `knowledge-build-maintenance:${props.context.serverWsOrigin}:${props.workspaceId}:${props.run.id}`;
  if (write) {
    sessionStorage.setItem(key, JSON.stringify({ enabled: maintenanceEnabled.value, time: maintenanceTime.value }));
    return;
  }
  const saved = sessionStorage.getItem(key);
  if (!saved) return;
  const value: unknown = JSON.parse(saved);
  if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean" || !("time" in value) || typeof value.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error("自动维护页面偏好损坏，请重新设置后保存");
  maintenanceEnabled.value = value.enabled; maintenanceTime.value = value.time;
}

/** 显式调整立即记住同任务维护选择，集中确认切换文档时不丢失用户决定。 */
function rememberMaintenance(): void {
  try { maintenancePrefs(true); }
  catch (error) { fail(error); }
}

/** 只为明确选中的内容补齐必要祖先，不保留已无所选内容的隐藏父目录。 */
function selectionWithAncestors(targets: string[]): string[] {
  const applicableIds = new Set(applicable.value.map(item => item.nodeId));
  return targets.reduce((ids, nodeId) => knowledgeAdoptionSelection(preview.value?.tree.nodes ?? [], ids, nodeId, true, applicableIds), [] as string[]);
}

/** 默认只选择当前浏览范围，必要父目录随子项补齐，避免隐藏分支被一并采用。 */
function defaultSelection(): string[] {
  return selectionWithAncestors(props.focus?.selectOnly ? [props.focus.nodeId] : scopedApplicable.value.map(item => item.nodeId));
}

/** 按当前范围全选或清空；未完成采用仍锁定原请求，不改变恢复清单。 */
function toggleAll(): void {
  if (pendingApply.value) return;
  selected.value = allVisibleSelected.value ? [] : defaultSelection();
}

/** 接收完整校验结果后才允许采用，展示候选树本身不授予采用资格。 */
function acceptPreview(value: KnowledgeGenerationPreview): void {
  if (value.runId !== props.run.id) throw new Error("预览与当前任务不一致，请重新打开更新");
  if (props.focus?.revisionId && value.items.find(item => item.nodeId === props.focus!.nodeId)?.revisionId !== props.focus.revisionId) throw new Error("所选正文已被后续修订替代，请重新打开对应文档的待确认更新");
  preview.value = value;
  if (props.focus && scopeIds.value && !scopeIds.value.has(props.focus.nodeId)) { preview.value = null; throw new Error("目标文档与左侧知识范围不一致，请重新选择。"); }
  if (!pendingApply.value) selected.value = defaultSelection();
}

/** 维护配置独立加载；失败显式保留错误，采用前必须等待成功。 */
async function loadMaintenance(current: number, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await requestKnowledgeAsset(props.context, "update.schedule", { workspaceId: props.workspaceId }, { signal });
    if (!result.ok) throw createApiResultError(result);
    if (current !== generation || signal.aborted) return false;
    updateView.value = result.data;
    maintenancePending.value = !result.data.schedule && adoptions.value.some(receipt => receipt.completed);
    return true;
  } catch (error) {
    if (current === generation && !signal.aborted) fail(error);
    return false;
  }
}

/** 正文和采用资格不等待维护配置；恢复读取原回执，采用时再等待配置。 */
async function load(refresh = false): Promise<void> {
  const current = ++generation;
  detailGeneration++;
  controller?.abort(); controller = new AbortController();
  detail.value = null; document.value = null; reports.value = []; reportsLoading.value = false; reportsReadError.value = null; reading.value = false;
  loading.value = true; errorText.value = ""; updateView.value = null; maintenancePending.value = false; selected.value = []; preview.value = null;
  maintenanceReady = Promise.resolve(false);
  try {
    maintenancePrefs();
    const focusedId = props.recoveryOnly ? null : props.focus?.nodeId ?? (!showList.value ? scopeNode.value?.id : null);
    const focusedRead = focusedId ? selectNode(focusedId) : Promise.resolve();
    maintenanceReady = loadMaintenance(current, controller.signal);
    const [run, result] = await Promise.all([
      props.embedded && !refresh ? Promise.resolve({ ok: true as const, data: props.run }) : requestKnowledgeAsset(props.context, "run", { workspaceId: props.workspaceId, runId: props.run.id }, { signal: controller.signal }),
      props.recoveryOnly || props.embedded && !refresh ? Promise.resolve(null) : requestKnowledgeAsset(props.context, "run.preview", { workspaceId: props.workspaceId, runId: props.run.id }, { signal: controller.signal }),
      focusedRead,
    ]);
    if (!run.ok) throw createApiResultError(run);
    if (result && !result.ok) throw createApiResultError(result);
    if (current !== generation) return;
    restoreRun(run.data);
    const checked = result?.data ?? props.suppliedPreview;
    if (checked) acceptPreview(checked);
    const visibleIds = new Set(rows.value.map(row => row.node.id));
    const firstNodeId = scopeNode.value ? rows.value.find(row => row.node.contentMode !== "directory")?.node.id : checked?.items.find(item => !item.applied)?.nodeId;
    const target = !showList.value ? scopeNode.value?.id ?? focusedId ?? null
      : focusedId && visibleIds.has(focusedId) ? focusedId
      : selectedId.value && visibleIds.has(selectedId.value) ? selectedId.value
      : firstNodeId ?? rows.value[0]?.node.id ?? scopeNode.value?.id ?? null;
    if (!props.recoveryOnly && !focusedId) await selectNode(target);
    if (refresh) await maintenanceReady;
  } catch (error) { if (current === generation && !controller.signal.aborted) fail(error); }
  finally { if (current === generation) loading.value = false; }
}

/** 切文件时重置预览 Tab，并按确切版本读取正文、节点和报告。 */
async function selectNode(nodeId: string | null): Promise<void> {
  selectedId.value = nodeId;
  detail.value = null; document.value = null; reports.value = []; reportsReadError.value = null;
  reportsLoading.value = false;
  previewTab.value = props.focus?.nodeId === nodeId && props.focus.report ? "report" : props.embedded ? "diff" : "document";
  const current = ++detailGeneration, parent = generation, signal = controller?.signal, runId = props.run.id, workspaceId = props.workspaceId;
  if (!nodeId) { reading.value = false; return; }
  reading.value = true;
  try {
    const revisionId = props.focus?.nodeId === nodeId && props.focus.revisionId ? props.focus.revisionId
      : items.value.get(nodeId)?.revisionId ?? props.run.items.find(item => item.nodeId === nodeId)?.revisionId;
    const [result, revision] = await Promise.all([
      requestKnowledgeAsset(props.context, "node", { workspaceId, nodeId, runId }, { signal }),
      revisionId ? requestKnowledgeAsset(props.context, "revision", { workspaceId, nodeId, runId, revisionId }, { signal }) : Promise.resolve(null),
    ]);
    if (!result.ok) throw createApiResultError(result);
    if (revision && !revision.ok) throw createApiResultError(revision);
    if (current !== detailGeneration || parent !== generation) return;
    detail.value = result.data;
    document.value = revision?.data ?? result.data.current;
    reportsLoading.value = Boolean(revisionId);
    reading.value = false;
    if (revisionId) {
      const response = await requestKnowledgeAsset(props.context, "reviews", { workspaceId, nodeId, runId }, { signal });
      if (!response.ok) throw createApiResultError(response);
      if (current !== detailGeneration || parent !== generation) return;
      reports.value = response.data.filter(report => report.revisionId === revisionId);
    }
  } catch (error) {
    if (current === detailGeneration && parent === generation && !signal?.aborted) {
      if (reportsLoading.value) reportsReadError.value = error instanceof Error ? error.message : String(error);
      fail(error);
    }
  }
  finally { if (current === detailGeneration && parent === generation) { reading.value = false; reportsLoading.value = false; } }
}

/** 仅重读当前候选报告，保留正文与所选 Tab；切换文件后丢弃迟到结果。 */
async function retryReports(): Promise<void> {
  const nodeId = selectedId.value, revisionId = document.value?.revision.id, current = detailGeneration, parent = generation, signal = controller?.signal;
  if (!nodeId || !revisionId || reportsLoading.value) return;
  reportsLoading.value = true; reportsReadError.value = null; errorText.value = "";
  try {
    const response = await requestKnowledgeAsset(props.context, "reviews", { workspaceId: props.workspaceId, nodeId, runId: props.run.id }, { signal });
    if (!response.ok) throw createApiResultError(response);
    if (current !== detailGeneration || parent !== generation) return;
    reports.value = response.data.filter(report => report.revisionId === revisionId);
  } catch (error) {
    if (current === detailGeneration && parent === generation && !signal?.aborted) {
      reportsReadError.value = error instanceof Error ? error.message : String(error);
      fail(error);
    }
  } finally { if (current === detailGeneration && parent === generation) reportsLoading.value = false; }
}

/** 只修改范围内待采用内容并重算依赖祖先，必要父目录仍由服务端完整校验。 */
function toggle(nodeId: string): void {
  if (pendingApply.value) return;
  const next = knowledgeAdoptionSelection(preview.value?.tree.nodes ?? [], selected.value, nodeId, !selected.value.includes(nodeId), new Set(applicable.value.map(item => item.nodeId)));
  const visibleIds = new Set(scopedApplicable.value.map(item => item.nodeId));
  selected.value = scopeNode.value ? selectionWithAncestors(next.filter(id => visibleIds.has(id))) : next;
}

/** 以项目维护权限采用当前预览版本；失败保留相同请求 ID，不连接原生成会话。 */
async function apply(): Promise<boolean> {
  if (loading.value || saving.value || !props.canWrite || (!pendingApply.value && (reading.value || !props.allowAdoption || !preview.value || !updateView.value || !selections.value.length))) return false;
  if (!updateView.value?.schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(maintenanceTime.value)) { errorText.value = "请输入有效的每日检查时间"; return false; }
  const current = generation;
  saving.value = true;
  try {
    if (!await maintenanceReady || current !== generation) return false;
    if (!updateView.value) throw new Error("自动维护配置尚未就绪，请重新读取后采用");
    errorText.value = "";
    maintenancePrefs(true);
    const input = pendingApply.value ?? { requestId: crypto.randomUUID(), treeHash: preview.value!.treeHash, planHash: preview.value!.planHash, selections: selections.value };
    pendingApply.value = input;
    if (props.run.mode === "conversation" && !props.run.proposedTree) {
      // 独立知识会话修订仍走原正文采用边界，不能伪装成批任务目录采用。
      for (const selection of input.selections) {
        if (!selection.revisionId) throw new Error("独立会话修订缺少正文版本，请重新打开对应文档");
        const nodeResult = await requestKnowledgeAsset(props.context, "node", { workspaceId: props.workspaceId, nodeId: selection.nodeId });
        if (!nodeResult.ok) throw createApiResultError(nodeResult);
        const expectedHash = props.run.items.find(item => item.nodeId === selection.nodeId)?.expectedHash ?? null;
        if (nodeResult.data.currentHash !== expectedHash) throw new Error("正式正文已变化，请重新比较后采用");
        const adopted = await requestKnowledgeAsset(props.context, "revision.adopt", { workspaceId: props.workspaceId, ...selection, revisionId: selection.revisionId, expectedHash }, { method: "POST" });
        if (!adopted.ok) throw createApiResultError(adopted);
      }
      pendingApply.value = null; emit("changed", props.run);
    } else {
      const result = await requestKnowledgeAsset(props.context, "run.apply", { workspaceId: props.workspaceId, runId: props.run.id, ...input }, { method: "POST", signal: controller?.signal });
      if (!result.ok) throw createApiResultError(result);
      if (current !== generation) return false;
      restoreRun(result.data);
      emit("changed", result.data);
    }
    if (batchAdoption.value && updateView.value && !updateView.value.schedule) {
      maintenancePending.value = true;
      await saveMaintenance();
      if (current !== generation) return false;
    }
    await load(true);
    return !errorText.value;
  } catch (error) {
    if (current === generation && !controller?.signal.aborted) {
      fail(error);
      if (maintenancePending.value) errorText.value = `内容已采用，自动维护计划保存失败：${errorText.value}。请重试保存计划。`;
      else if (pendingApply.value) {
        const failedText = errorText.value;
        try {
          const run = await requestKnowledgeAsset(props.context, "run", { workspaceId: props.workspaceId, runId: props.run.id }, { signal: controller?.signal });
          if (!run.ok) throw createApiResultError(run);
          if (current === generation) restoreRun(run.data);
        } catch (readError) { if (current === generation && !controller?.signal.aborted) { fail(readError); errorText.value = `${failedText}；采用状态读取失败，保留原请求重试：${errorText.value}`; } }
      }
    }
  }
  finally { saving.value = false; }
  return false;
}

/** 集中确认沿用原采用实现；采用版本或结构变化时显式中止，不替用户换版本。 */
async function applyConfirmed(input: KnowledgeGenerationApplyInput): Promise<void> {
  const current = generation;
  await ready;
  const maintenanceLoaded = await maintenanceReady;
  if (current !== generation) throw new Error("预览已变化，请重新查看更新后采用");
  if (!maintenanceLoaded) throw new Error(errorText.value || "自动维护配置读取失败，请重新读取后采用");
  if (errorText.value || !preview.value) throw new Error(errorText.value || "预览尚未就绪");
  const receipt = pendingApply.value;
  if (receipt && JSON.stringify(receipt.selections) !== JSON.stringify(input.selections)) throw new Error("此任务有未完成采用，请先恢复原清单或终止本次采用");
  if (!receipt && (preview.value.planHash !== input.planHash || preview.value.treeHash !== input.treeHash)) throw new Error("预览依据已变化，请重新查看更新后采用");
  selected.value = input.selections.map(item => item.nodeId);
  if (!receipt) pendingApply.value = input;
  if (!await apply()) throw new Error(errorText.value || "采用未完成，请检查原任务回执后重试");
}

/** 内容采用成功后初始化维护配置；已有计划保持原值，保存失败留待显式重试。 */
async function saveMaintenance(): Promise<void> {
  const view = updateView.value;
  if (!view || view.schedule) return;
  const current = generation;
  const [hour, minute] = maintenanceTime.value.split(":").map(Number);
  const timezone = view.defaultTimezone;
  if (!timezone) throw new Error("执行 Client 未返回项目时区，无法保存自动维护计划");
  const result = await requestKnowledgeAsset(props.context, "update.save", { workspaceId: props.workspaceId, expectedHash: view.hash,
    schedule: { enabled: maintenanceEnabled.value, cronExpr: `${minute} ${hour} * * *`, timezone, selectedNodeIds: [], includeDescendants: true,
      engine: props.run.engine, model: props.run.model, effort: props.run.effort, concurrency: props.run.concurrency ?? 5, prompt: "",
      reviewConfig: props.run.reviewConfig ?? { enabled: true, autoRepair: true, maxRounds: 2, model: props.run.model, effort: props.run.effort } } }, { method: "POST", signal: controller?.signal });
  if (!result.ok) throw createApiResultError(result);
  if (current !== generation) return;
  updateView.value = result.data; maintenancePending.value = false;
}

/** 维护保存失败后只重试计划写入，不重复采用已生效的知识。 */
async function retryMaintenance(): Promise<void> {
  if (saving.value || !maintenancePending.value) return;
  const currentGeneration = generation;
  saving.value = true; errorText.value = "";
  try {
    maintenancePrefs(true);
    const current = await requestKnowledgeAsset(props.context, "update.schedule", { workspaceId: props.workspaceId }, { signal: controller?.signal });
    if (!current.ok) throw createApiResultError(current);
    if (currentGeneration !== generation) return;
    updateView.value = current.data;
    if (current.data.schedule) maintenancePending.value = false;
    else await saveMaintenance();
    await load(true);
  }
  catch (error) { if (currentGeneration === generation && !controller?.signal.aborted) { fail(error); errorText.value = `内容已采用，自动维护计划保存失败：${errorText.value}`; } }
  finally { saving.value = false; }
}

/** 终止采用只关闭原请求的未生效选择，明确保留已经写入的项目知识。 */
function cancelPending(): void {
  const pending = pendingApply.value, current = generation;
  if (!pending || saving.value || !props.canWrite) return;
  Modal.confirm({ title: "终止本次未完成采用？", content: "已生效的知识会保留；原清单中尚未生效的内容将标记为本次不采用。其余候选仍可处理，也可重新生成。", okText: "终止本次采用", cancelText: "返回", onOk: async () => {
    if (current !== generation || pendingApply.value?.requestId !== pending.requestId) return;
    saving.value = true; errorText.value = "";
    try {
      const result = await requestKnowledgeAsset(props.context, "run.cancelAdoption", { workspaceId: props.workspaceId, runId: props.run.id, requestId: pending.requestId }, { method: "POST", signal: controller?.signal });
      if (!result.ok) throw createApiResultError(result);
      if (current !== generation) return;
      restoreRun(result.data); emit("changed", result.data); await load(true);
    } catch (error) { if (current === generation && !controller?.signal.aborted) fail(error); }
    finally { saving.value = false; }
  } });
}

/** 目录不采用前展示本任务受影响后代；正式知识和已采用内容均不在处理范围。 */
function dismiss(): void {
  const item = currentItem.value, plan = preview.value;
  if (!item || item.applied || item.dismissed || !plan || saving.value || !props.canWrite || !props.allowAdoption || pendingApply.value) return;
  const descendants = new Set(knowledgeSelectedNodes(plan.tree.nodes, [item.nodeId], true).map(node => node.id));
  const affected = node.value?.contentMode === "directory" ? plan.items.filter(candidate => descendants.has(candidate.nodeId) && !candidate.applied && !candidate.dismissed) : [item];
  const titles = affected.map(candidate => plan.tree.nodes.find(node => node.id === candidate.nodeId)!.title);
  const current = generation;
  Modal.confirm({ title: node.value?.contentMode === "directory" ? "本次不采用此目录及其候选后代？" : "本次不采用此项？", content: `本次处理 ${affected.length} 项：${titles.join("、")}。保留正式知识、已采用内容及其他任务记录。`, okText: "本次不采用", cancelText: "返回", onOk: () => current === generation ? dismissSelection(item.nodeId, item.revisionId, plan.planHash) : undefined });
}

/** 以项目维护权限不采用确切版本，保留原文件及其他来源建议，不连接原会话。 */
async function dismissSelection(nodeId: string, revisionId: string | null, planHash: string): Promise<void> {
  if (saving.value || !props.canWrite || pendingApply.value) return;
  const current = generation;
  saving.value = true; errorText.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "revision.dismiss", { workspaceId: props.workspaceId, runId: props.run.id, nodeId, revisionId, planHash }, { method: "POST", signal: controller?.signal });
    if (!result.ok) throw createApiResultError(result);
    if (current !== generation) return;
    emit("changed", result.data);
    await load(true);
  } catch (error) { if (current === generation && !controller?.signal.aborted) fail(error); }
  finally { saving.value = false; }
}

watch([() => props.workspaceId, () => props.run.id, () => props.focus, () => props.scopeNodeId, () => props.recoveryOnly], () => {
  if (!props.run.active || props.focus?.revisionId) ready = load();
}, { immediate: true });
/** 独立复检结束只重读当前版本报告，保留正文和标签页，等待首次读取完成。 */
watch(() => [Boolean(documentActivity.value), selectedId.value, document.value?.revision.id] as const, async ([active, nodeId, revisionId], [wasActive, previousNodeId, previousRevisionId]) => {
  if (active || !wasActive || nodeId !== previousNodeId || revisionId !== previousRevisionId) return;
  await ready;
  if (!documentActivity.value && selectedId.value === nodeId && document.value?.revision.id === revisionId) await retryReports();
});
/** 独立使用预览时仍在原任务完成后核对采用资格。 */
watch(() => props.run.active, active => { if (!active && !props.embedded) ready = load(); });
/** 父级校验完成仅更新资格，不重新读取已经展示的正文。 */
watch(() => props.suppliedPreview, value => {
  if (!props.embedded) return;
  preview.value = null; selected.value = [];
  if (!value) return;
  try { acceptPreview(value); }
  catch (error) { fail(error); }
});
onBeforeUnmount(() => { generation += 1; detailGeneration += 1; controller?.abort(); });

// 父级复用已读取的权威回执与就绪状态，恢复时不得改用历史请求。
defineExpose({ hasRecovery: () => Boolean(pendingApply.value || maintenancePending.value), adoptionReceipts: () => adoptions.value, whenReady: () => ready, applyConfirmed });
</script>

<template>
  <section class="build-preview" data-testid="knowledge-build-preview">
    <a-alert v-if="errorText" type="error" show-icon :message="errorText" />
    <div v-if="pendingApply" class="maintenance-default" role="alert"><span>上次采用尚未完成，已锁定原来的 {{ pendingApply.selections.length }} 项；可以恢复原请求或终止未生效部分。</span><a-button type="primary" :loading="saving" :disabled="!canWrite || loading" @click="apply">重试未完成采用</a-button><a-button danger :disabled="!canWrite || loading || saving" @click="cancelPending">终止本次采用</a-button></div>
    <a-alert v-if="cancelledAdoption" type="warning" show-icon :message="`已终止，已生效 ${cancelledAdoption.appliedNodeIds?.length ?? 0} 项，其余可重新生成。`" />
    <a-alert v-if="preview && !preview.items.length && run.phase === 'completed'" type="info" show-icon :message="run.rationale || '分析已完成，本次无需新增内容。'" />
    <div v-if="(!embedded || recoveryOnly) && batchAdoption && allowAdoption && updateView && !updateView.schedule" class="maintenance-default"><label><input v-model="maintenanceEnabled" type="checkbox" :disabled="saving" @change="rememberMaintenance">采用后自动维护</label><label>每天 <input v-model="maintenanceTime" type="time" aria-label="自动维护时间" :disabled="saving" @change="rememberMaintenance"></label><span>时区：{{ updateView.defaultTimezone }}</span><a-button v-if="maintenancePending" size="small" :loading="saving" @click="retryMaintenance">重试保存计划</a-button></div>
    <div v-else-if="!embedded && updateView?.schedule" class="maintenance-default">沿用项目自动维护计划：{{ updateView.schedule.enabled ? '已开启' : '已关闭' }} · {{ updateView.schedule.cronExpr }} · {{ updateView.schedule.timezone }}</div>
    <div v-else-if="maintenancePending" class="maintenance-default" role="alert"><span>内容已采用，自动维护计划尚未保存</span><a-button size="small" :loading="saving" @click="retryMaintenance">重试保存计划</a-button></div>
    <a-spin v-if="loading && (!displayNodes || recoveryOnly)" class="preview-loading" />
    <div v-else-if="displayNodes && !recoveryOnly" class="preview-layout" :class="{ 'document-only': !showList }">
      <div v-if="showList" class="preview-tree" aria-label="候选目录与采用选择">
        <label v-if="allowAdoption" class="select-all"><input type="checkbox" :checked="allVisibleSelected" :disabled="loading || saving || !canWrite || !scopedApplicable.length || Boolean(pendingApply)" @change="toggleAll">选择可采用内容</label>
        <div class="preview-tree-scroll"><div v-for="row in rows" :key="row.node.id" class="preview-row" :class="{ selected: selectedId === row.node.id }" :style="{ paddingLeft: `${12 + row.depth * 16}px` }">
          <input v-if="allowAdoption" type="checkbox" :aria-label="`采用 ${row.node.title}`" :checked="selected.includes(row.node.id)" :disabled="loading || saving || !canWrite || Boolean(pendingApply) || !items.get(row.node.id)?.canApply || items.get(row.node.id)?.applied || items.get(row.node.id)?.dismissed" @change="toggle(row.node.id)">
          <button type="button" :disabled="loading" @click="selectNode(row.node.id)"><span>{{ row.node.title }}</span><small>{{ items.get(row.node.id)?.dismissed ? '本次不采用' : items.get(row.node.id)?.applied ? '已采用' : row.node.contentMode === 'directory' ? '目录' : row.node.contentMode === 'reference' ? '实时引用' : '生成正文' }}</small></button>
        </div><p v-if="!rows.length" class="preview-empty">无需新增内容。{{ run.rationale }}</p></div>
      </div>
      <div class="preview-content">
        <a-spin v-if="reading" class="preview-loading" />
        <template v-else-if="node">
          <div class="preview-toolbar"><h3 :title="node.title">{{ node.title }}</h3><p v-if="specificationPaths !== null" class="specification-scope" :title="specificationPaths.join('、')">规格适用范围：{{ specificationPaths.length ? specificationPaths.join('、') : '整个项目' }}</p><span v-if="currentItem?.applied">已采用</span></div>
          <a-alert v-if="documentActivity || readyToAdopt || (currentItem?.reason || restrictionReason) && !currentItem?.applied" class="review-notice" :type="documentActivity ? 'info' : readyToAdopt ? 'success' : 'warning'" :role="documentActivity || readyToAdopt ? 'status' : 'alert'" :aria-busy="Boolean(documentActivity)" show-icon data-testid="knowledge-review-notice">
            <template v-if="documentActivity" #icon><LoadingOutlined spin aria-hidden="true" /></template>
            <template #message>
              <div class="review-notice-row">
                <span class="review-notice-text" :title="reportsReadError ?? executionItem?.review?.error?.message ?? currentItem?.reason ?? undefined">{{ documentActivity ?? (readyToAdopt ? readyMessage : reviewGuidance ?? currentItem?.reason ?? restrictionReason) }}</span>
                <a-space v-if="!documentActivity && reviewGuidance && canResumeReview" wrap :size="6">
                  <a-button v-if="canResumeReview && document" type="primary" size="small" :disabled="!canWrite || reviewBusy || reportsLoading || Boolean(reportsReadError)" @click="emit('resumeReview', { nodeId: node.id, runId: run.id, revisionId: document.revision.id })">{{ executionItem?.review?.status === 'failed' ? '重试复检' : '继续复检' }}</a-button>
                </a-space>
              </div>
            </template>
          </a-alert>
          <a-tabs v-if="document && node.contentMode !== 'reference'" v-model:active-key="previewTab" class="preview-tabs" size="small" :tab-bar-gutter="20" :tab-bar-style="{ margin: 0, padding: '0 12px' }" destroy-inactive-tab-pane>
            <a-tab-pane v-if="embedded" key="diff" tab="变更">
              <div class="preview-body showing-diff"><div class="revision-diff"><DiffViewer :original="detail?.current?.content ?? ''" :modified="document.content" :inline="!detail?.current" file-path="knowledge-asset.md" /></div></div>
            </a-tab-pane>
            <a-tab-pane key="document" tab="完整内容">
              <div class="preview-body"><MarkdownContent :text="document.content" :workspace-id="workspaceId" /></div>
            </a-tab-pane>
            <a-tab-pane key="report" tab="复检报告">
              <div class="preview-body"><a-spin v-if="reportsLoading" aria-label="正在加载复检报告" /><template v-else-if="reportsReadError"><a-alert type="error" show-icon message="复检报告读取失败" :description="reportsReadError" /><a-button size="small" @click="retryReports">重新读取报告</a-button></template><KnowledgeReviewReport v-else :reports="reports" :loading="false" :busy="reviewBusy" :restart-busy="restartReviewBusy || reportsLoading || Boolean(reportsReadError)" :can-write="canWrite" :can-start-task="canStartTask" :can-review-version="canReviewVersion" :can-repair="!productDocument" :source-refresh-required="sourceRefreshRequired" :pending="canResumeReview && executionItem?.review?.status === 'pending'" :failure="executionItem?.review?.error?.message" :generation-thread-id="executionItem?.executionThreadId" @review="emit('review', node.id)" @refresh-sources="emit('refreshSources', { nodeId: node.id, runId: run.id, revisionId: document.revision.id })" @repair="emit('repair', $event)" @repair-issue="(report, issue) => emit('repairIssue', report, issue)" @return-to-generation="emit('returnToGeneration', $event, run.id)" /></div>
            </a-tab-pane>
          </a-tabs>
          <div v-else class="preview-body">
            <template v-if="node.contentMode === 'reference'"><div class="reference-status"><strong>实时引用 · {{ reference?.state === 'changed' ? '原文已变化' : reference ? '原文未变化' : '原文不可用' }}</strong><code>{{ node.reference?.path }}</code><a-button v-if="reference" type="link" size="small" @click="emit('openFile', reference.path)">打开原文</a-button><span v-if="reference">读取时间：{{ readAt }}</span></div><MarkdownContent v-if="reference" :text="reference.content" :workspace-id="workspaceId" :resource-file-path="reference.path" @open-workspace-file="emit('openFile', $event)" /><a-alert v-else type="error" message="未能读取实时原文，请重新打开预览重试。" /></template>
            <p v-else-if="node.contentMode === 'directory'" class="preview-empty">此目录用于组织知识，无需生成正文。</p>
            <p v-else class="preview-empty">此项暂无可预览的正文，请等待生成或查看主页面的失败原因。</p>
          </div>
        </template>
        <p v-else class="preview-empty">选择内容查看目录、正文与来源。</p>
      </div>
    </div>
    <footer v-if="!embedded && !recoveryOnly"><span v-if="allowAdoption">{{ pendingApply ? pendingApply.selections.length : selections.length }} 项{{ pendingApply ? '待恢复' : '待采用' }} · 包含必要父目录</span><span v-else>已采用的正式知识</span><div><a-button v-if="allowAdoption && currentItem && !currentItem.applied && !currentItem.dismissed" :disabled="!canWrite || saving || loading || Boolean(pendingApply)" @click="dismiss">本次不采用</a-button><a-button v-if="!pendingApply && allowAdoption" type="primary" :disabled="!canWrite || !selections.length || loading || reading || !updateView || maintenancePending" :loading="saving" @click="apply()">采用所选内容</a-button></div></footer>
  </section>
</template>

<style scoped>
.build-preview { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
.build-preview > footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 6px 12px; border-top: 1px solid var(--app-divider); }
.build-preview footer > span { margin: 5px 0 0; font-size: 12px; color: var(--app-muted); }
.build-preview footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.preview-layout { display: grid; grid-template-columns: clamp(140px, 20%, 200px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); flex: 1 1 0; min-height: 0; overflow: hidden; }
.preview-tree { display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-right: 1px solid var(--app-divider); }
.select-all { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--app-divider); font-size: 12px; }
.preview-tree-scroll, .preview-content { min-height: 0; min-width: 0; }
.preview-tree-scroll { flex: 1 1 0; overflow: auto; }
.preview-content { display: flex; flex-direction: column; overflow: hidden; overflow-wrap: anywhere; }
.preview-content > :not(.preview-body):not(.preview-tabs) { flex-shrink: 0; }
.preview-tabs { flex: 1 1 0; min-height: 0; min-width: 0; }
.preview-tabs :deep(.ant-tabs-content-holder) { display: flex; min-height: 0; min-width: 0; overflow: hidden; }
.preview-tabs :deep(.ant-tabs-content) { height: 100%; min-width: 0; }
.preview-tabs :deep(.ant-tabs-tabpane) { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
.preview-body { flex: 1 1 0; min-height: 0; min-width: 0; overflow: auto; padding: 12px 16px; }
.preview-body.showing-diff { display: flex; overflow: hidden; padding: 0; }
.preview-row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; min-width: 0; }
.preview-row.selected { background: color-mix(in srgb, var(--app-accent) 9%, var(--app-bg)); }
.preview-row button { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; text-align: left; border: 0; padding: 6px 0; color: var(--app-text); background: transparent; cursor: pointer; overflow-wrap: anywhere; }
.preview-row small, .reference-status span { color: var(--app-muted); font-size: 11px; }
.preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 12px; }
.preview-toolbar h3 { flex: 0 1 auto; min-width: 0; margin: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 规格适用范围紧跟标题显示，占据剩余宽度，放不下才省略。 */
.specification-scope { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 12px; color: var(--app-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-notice { align-self: stretch; }
.review-notice-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; }
.review-notice-text { flex: 1 1 180px; min-width: 0; font-size: 12px; line-height: 1.5; }
.preview-empty { color: var(--app-muted); padding: 12px; font-size: 12px; line-height: 1.8; }
.reference-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 8px; font-size: 12px; }
.reference-status code { min-width: 0; overflow-wrap: anywhere; }
.maintenance-default { display: flex; flex: 0 0 auto; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 6px 12px; font-size: 12px; color: var(--app-muted); border-bottom: 1px solid var(--app-divider); }
.maintenance-default label { display: flex; align-items: center; gap: 6px; }
.maintenance-default input[type="time"] { background: var(--app-bg); color: var(--app-text); border: 1px solid var(--app-border); border-radius: 4px; padding: 3px; }
.preview-loading { margin: auto; }
.revision-diff { flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; }
.revision-diff :deep(.diff-viewer) { min-height: 0; }
@media (max-width: 720px) { .preview-layout { grid-template-columns: clamp(120px, 30%, 160px) minmax(0, 1fr); } .preview-body { padding: 12px; } }
.preview-layout.document-only { grid-template-columns: minmax(0, 1fr); }
</style>
