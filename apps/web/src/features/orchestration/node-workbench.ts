import {
  isOrchestrationDeterministicRecoveryDiagnostic,
  resolveOrchestrationUserFacingMessage,
  type NodeExecutionState,
  type NodeExecutionStatus,
  type NodeHumanActionSource,
} from "@codeflowai/shared";

export type NodeWorkbenchAttentionKind =
  | "start"
  | "approval"
  | "branch_decision"
  | "human_input"
  | "review_decision"
  | "gate_failure"
  | "execution_error"
  | "feedback";

export type NodeWorkbenchView = "chat" | "detail";

export type NodeWorkbenchDescriptor = {
  attentionKind: NodeWorkbenchAttentionKind | null;
  source: NodeHumanActionSource | null;
  hasReviewableResult: boolean;
  preferredView: NodeWorkbenchView;
  statusLabel: string;
  detailLabel: string | null;
  badgeLabel: string | null;
  actionLabel: string | null;
  bannerText: string | null;
};

export function isRunningLikeStatus(status: NodeExecutionStatus | null | undefined): boolean {
  return status === "running"
    || status === "result-submitted"
    || status === "finalizing"
    || status === "artifact-writing"
    || status === "gate-checking";
}

/**
 * 节点会话仅在文字可以安全解释为补充信息或带意见续跑时开放输入。
 * 审批、分支选择以及未知人工动作都保留结构化入口，避免把普通文字误当成决定。
 */
export function requiresStructuredNodeThreadAction(
  state: Pick<NodeExecutionState, "status" | "humanActionSource"> | null | undefined,
): boolean {
  if (!state) return false;
  if (state.status === "waiting-start" || state.status === "waiting-approval") return true;
  if (state.status !== "waiting-feedback") return false;

  switch (state.humanActionSource) {
    case "execution":
    case "human_input":
    case "review":
    case "gate":
      return false;
    default:
      return true;
  }
}

export function hasNodeReviewableResult(state: NodeExecutionState | null | undefined): boolean {
  if (!state) return false;
  return Boolean(
    state.conclusion
    || (state.outputArtifactIds?.length ?? 0) > 0
    || (state.gateResults?.length ?? 0) > 0
    || String(state.output ?? "").trim(),
  );
}

/** 解析节点工作台状态，决定提示、按钮文案和默认查看视图。 */
export function resolveNodeWorkbenchDescriptor(state: NodeExecutionState | null | undefined): NodeWorkbenchDescriptor {
  if (!state) {
    return {
      attentionKind: null,
      source: null,
      hasReviewableResult: false,
      preferredView: "detail",
      statusLabel: "等待",
      detailLabel: null,
      badgeLabel: null,
      actionLabel: null,
      bannerText: null,
    };
  }

  const source = normalizeHumanActionSource(state.humanActionSource);
  const hasReviewableResult = hasNodeReviewableResult(state);
  const attentionKind = resolveAttentionKind(state, source, hasReviewableResult);

  if (state.status === "waiting-start") {
    return {
      attentionKind: "start",
      source: null,
      hasReviewableResult,
      preferredView: "detail",
      statusLabel: "待启动",
      detailLabel: resolveOrchestrationUserFacingMessage(state.error, "等待人工启动"),
      badgeLabel: "待启动",
      actionLabel: "启动节点",
      bannerText: "当前节点已满足前置条件，等待人工启动",
    };
  }

  if (state.status === "waiting-approval") {
    const awaitingRework = state.conclusion?.nextAction === "rework";
    return {
      attentionKind: "approval",
      source: "approval",
      hasReviewableResult,
      preferredView: "detail",
      statusLabel: awaitingRework ? "待确认退回" : "待审核",
      detailLabel: awaitingRework ? "建议退回，等待人工确认" : "等待人工审核",
      badgeLabel: "待审核",
      actionLabel: awaitingRework ? "查看结果并决策" : "查看结果并审核",
      bannerText: awaitingRework ? "模型建议退回上游节点，等待人工确认" : "结果已产出，等待人工审核",
    };
  }

  if (state.status === "waiting-feedback") {
    switch (attentionKind) {
      case "branch_decision":
        return {
          attentionKind,
          source,
          hasReviewableResult,
          preferredView: "detail",
          statusLabel: "待选分支",
          detailLabel: resolveBranchDecisionReason(state),
          badgeLabel: "待选分支",
          actionLabel: "选择分支",
          bannerText: "当前条件节点等待人工选择后续分支",
        };
      case "human_input":
        return {
          attentionKind,
          source,
          hasReviewableResult,
          preferredView: "detail",
          statusLabel: "待补充",
          detailLabel: resolveHumanInputReason(state),
          badgeLabel: "待补充",
          actionLabel: "补充信息并继续",
          bannerText: "当前节点缺少必要信息，补充后才能继续",
        };
      case "review_decision":
        return {
          attentionKind,
          source,
          hasReviewableResult,
          preferredView: "detail",
          statusLabel: "待决策",
          detailLabel: resolveReviewDecisionReason(state),
          badgeLabel: "待决策",
          actionLabel: "查看结果并决策",
          bannerText: "模型建议暂停当前流程，等待人工决策",
        };
      case "gate_failure":
        return {
          attentionKind,
          source,
          hasReviewableResult,
          preferredView: "detail",
          statusLabel: "门禁未过",
          detailLabel: resolveGateFailureReason(state),
          badgeLabel: "待处理",
          actionLabel: "查看结果并处理",
          bannerText: "结果已产出，但未通过门禁检查",
        };
      case "execution_error": {
        const autoRecovery = isOrchestrationDeterministicRecoveryDiagnostic(
          state.conclusion?.humanInput?.summary ?? state.conclusion?.summary ?? state.error,
        );
        return {
          attentionKind,
          source,
          hasReviewableResult,
          preferredView: "chat",
          statusLabel: autoRecovery ? "系统处理中" : "异常中断",
          detailLabel: autoRecovery
            ? "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。"
            : "会话异常中断",
          badgeLabel: autoRecovery ? "系统处理中" : "异常中断",
          actionLabel: autoRecovery ? "查看进度" : "查看异常会话",
          bannerText: autoRecovery
            ? "系统正在处理当前节点，完成后会从当前进度继续"
            : "会话异常中断，建议先查看会话与错误信息",
        };
      }
      default:
        return {
          attentionKind: attentionKind ?? "feedback",
          source,
          hasReviewableResult,
          preferredView: hasReviewableResult ? "detail" : "chat",
          statusLabel: "待处理",
          detailLabel: resolveGenericFeedbackReason(state),
          badgeLabel: "待处理",
          actionLabel: hasReviewableResult ? "查看结果并处理" : "查看会话",
          bannerText: hasReviewableResult ? "需要人工处理后继续" : "需要人工处理后继续，建议先查看当前会话",
        };
    }
  }

  if (isRunningLikeStatus(state.status)) {
    return {
      attentionKind: null,
      source,
      hasReviewableResult,
      preferredView: "chat",
      statusLabel: nodeStatusLabel(state.status),
      detailLabel: nodeStatusLabel(state.status),
      badgeLabel: null,
      actionLabel: null,
      bannerText: null,
    };
  }

  return {
    attentionKind: null,
    source,
    hasReviewableResult,
    preferredView: "detail",
    statusLabel: nodeStatusLabel(state.status),
    detailLabel: nodeStatusLabel(state.status),
    badgeLabel: null,
    actionLabel: null,
    bannerText: null,
  };
}

function normalizeHumanActionSource(value: NodeHumanActionSource | null | undefined): NodeHumanActionSource | null {
  return value ?? null;
}

/** 根据节点状态和人工来源推导工作台待处理动作类型。 */
function resolveAttentionKind(
  state: NodeExecutionState,
  source: NodeHumanActionSource | null,
  hasReviewableResult: boolean,
): NodeWorkbenchAttentionKind | null {
  if (state.status === "waiting-approval") return "approval";
  if (state.status === "waiting-start") return "start";
  if (state.status !== "waiting-feedback") return null;
  if ((state.conclusion?.nextAction === "ask_human" || state.conclusion?.nextAction === "stop")
    && isOrchestrationDeterministicRecoveryDiagnostic(
      state.conclusion?.humanInput?.summary ?? state.conclusion?.summary ?? state.error,
    )) {
    return "execution_error";
  }
  if (source === "branch_decision") return "branch_decision";
  if (source === "human_input") return "human_input";
  if (source === "review") return "review_decision";
  if (source === "gate") return "gate_failure";
  if (source === "execution") {
    return hasReviewableResult ? "feedback" : "execution_error";
  }
  if (state.conclusion?.nextAction === "ask_human") return "human_input";
  if (state.conclusion?.nextAction === "stop") return "review_decision";
  if ((state.gateResults?.length ?? 0) > 0) return "gate_failure";
  if (String(state.error ?? "").trim() && !hasReviewableResult) return "execution_error";
  return "feedback";
}

/** 提取人工分支等待原因，缺省保持稳定的短文案。 */
function resolveBranchDecisionReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.error ?? state.conclusion?.summary,
    "等待人工选择分支",
  );
}

/** 提取人工补充原因并隐藏已识别的内部诊断。 */
function resolveHumanInputReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.humanInput?.summary
    ?? state.conclusion?.summary
    ?? state.error
    ?? "等待补充信息",
    "等待补充信息",
  );
}

/** 提取人工决策原因并保持普通业务说明原样。 */
function resolveReviewDecisionReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.summary ?? state.error,
    "等待人工决策",
  );
}

/** 提取首条未通过门禁的说明并转换为用户提示。 */
function resolveGateFailureReason(state: NodeExecutionState): string {
  const failed = (state.gateResults ?? []).find((item) => !item.passed);
  return resolveOrchestrationUserFacingMessage(
    failed?.message ?? state.error,
    "未通过门禁检查",
  );
}

/** 提取通用反馈原因；空值使用稳定的默认提示。 */
function resolveGenericFeedbackReason(state: NodeExecutionState): string {
  return resolveOrchestrationUserFacingMessage(
    state.conclusion?.summary
    ?? state.error
    ?? "等待人工处理",
    "等待人工处理",
  );
}

/** 节点执行状态的中文文案；未知状态原样返回，避免显示成空白。 */
export function nodeStatusLabel(status: NodeExecutionStatus | null | undefined): string {
  const map: Record<NodeExecutionStatus, string> = {
    pending: "等待",
    ready: "就绪",
    queued: "排队",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "写入结果",
    "gate-checking": "门禁检查",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待反馈",
    completed: "已完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
  };
  if (!status) return "等待";
  return map[status] ?? status;
}
