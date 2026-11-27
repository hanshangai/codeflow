import { KNOWLEDGE_MAX_REVIEW_ROUNDS, type KnowledgeGenerationItem, type KnowledgeGenerationRunView, type KnowledgeReviewConfig } from "@codeflowai/shared";

/** 按节点和版本定位真实活动，独立复检与原生成任务共用展示口径。 */
export function knowledgeDocumentReviewActivity(runs: KnowledgeGenerationRunView[], nodeId: string, revisionId: string | null): string | null {
  if (!revisionId) return null;
  for (const run of runs) {
    if (!run.active) continue;
    const item = run.items.find(item => item.nodeId === nodeId && (item.revisionId === revisionId || item.review?.status === "repairing" && item.repairRevisionId === revisionId));
    if (!item) continue;
    const itemStage = run.activeItemStages?.find(stage => stage.itemId === item.id)?.stage;
    const active = Boolean(itemStage || run.activeItemId === item.id || run.activeItemIds?.includes(item.id));
    if (!active) continue;
    const stage = itemStage ?? run.activeStage;
    const repairing = item.review?.status === "repairing";
    if (stage === "queued") return repairing ? "等待修订…" : item.status === "completed" ? "等待复检…" : null;
    if (stage === "reviewing") return "正在复检，请稍候…";
    if (repairing) return stage === "generating" ? "正在根据问题修订…" : "等待修订…";
    if (item.status === "completed" && item.review?.status === "pending") return "等待复检…";
  }
  return null;
}

export function knowledgeReviewLabel(item: KnowledgeGenerationItem): string {
  if (item.reviewConfig?.enabled === false) return "已跳过复检";
  if (item.review?.status === "repairing") return "自动修订中";
  if (item.review?.stale) return "复检已失效";
  return item.review ? { pending: "待复检", repairing: "自动修订中", passed: "复检通过", passed_with_warnings: "复检通过（有提醒）", issues: item.review.round && item.review.maxRounds && item.review.round >= item.review.maxRounds ? `发现问题（已达 ${item.review.maxRounds} 轮）` : "发现问题", failed: "复检失败" }[item.review.status] : "未复检";
}

/** 识别生成依据过期。复检期间的读取漂移仍可以重试。 */
export function knowledgeReviewNeedsSourceRefresh(item?: KnowledgeGenerationItem): boolean {
  return item?.review?.error?.code === "KNOWLEDGE_ASSET_SOURCE_CHANGED"
    && item.review.error.message.includes("生成时引用的来源已变化");
}

/** 已保存的候选仅在原复检可以继续时提供续跑。 */
export function knowledgeItemNeedsReview(item: KnowledgeGenerationItem): boolean {
  return item.status === "completed" && !knowledgeReviewNeedsSourceRefresh(item) && item.reviewConfig?.enabled !== false
    && Boolean(item.review && !item.review.stale && (item.review.status === "pending" || item.review.status === "failed"));
}

export function knowledgeItemNeedsWork(item: KnowledgeGenerationItem): boolean {
  return item.status !== "completed" || knowledgeItemNeedsReview(item);
}

/** 批量生成遇到复检问题时，继续任务会自动进入修订并再次复检。 */
export function knowledgeItemNeedsRepair(item: KnowledgeGenerationItem, mode: "batch" | "review" | "build" = "batch", taskReviewConfig?: KnowledgeReviewConfig): boolean {
  const config = item.reviewConfig ?? taskReviewConfig;
  return item.status === "completed"
    && config?.enabled !== false
    && (config?.autoRepair ?? mode !== "review")
    && !item.review?.stale
    && item.review?.status === "issues"
    && (item.review.round ?? 0) < (item.review.maxRounds ?? config?.maxRounds ?? KNOWLEDGE_MAX_REVIEW_ROUNDS);
}

/** 构建与历史批次复用相同的生成、复检和修订续跑判断。 */
export function knowledgeItemNeedsRunWork(item: KnowledgeGenerationItem, mode: "batch" | "review" | "build", taskReviewConfig?: KnowledgeReviewConfig): boolean {
  return knowledgeItemNeedsWork(item) || knowledgeItemNeedsRepair(item, mode, taskReviewConfig);
}
