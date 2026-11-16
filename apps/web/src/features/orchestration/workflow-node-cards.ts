import type { ArtifactOutputMode, WorkflowNode } from "@codeflowai/shared";

export const WORKFLOW_NODE_CARD_WIDTH = 208;
export const WORKFLOW_NODE_CARD_HEIGHT = 126;
export const WORKFLOW_NODE_GAP_X = 304;
export const WORKFLOW_NODE_GAP_Y = 160;

export type WorkflowNodeCardTone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";
export type WorkflowNodeCardMetricTone = "input" | "output" | "thread" | "human" | "retry";

export type WorkflowNodeCardViewModel = {
  label: string;
  eyebrow: string | null;
  statusLabel: string;
  statusTone: WorkflowNodeCardTone;
  metrics: Array<{
    key: string;
    label: string;
    value: string;
    tone: WorkflowNodeCardMetricTone;
  }>;
  badges: Array<{
    key: string;
    text: string;
    tone: WorkflowNodeCardTone;
  }>;
};

/** 开始/结束是流程图里的终止符，渲染成圆，与矩形流程节点区分开。 */
export function isWorkflowTerminalNodeType(type: string | null | undefined): boolean {
  return type === "start" || type === "end";
}

/**
 * 节点实际渲染尺寸：终止符取正方形 bbox（边长沿用该视图的节点高度），其余沿用卡片尺寸。
 * 正方形是圆的唯一外接框——连接点、迷你图与布局都以 bbox 为准，所以不需要额外补偿。
 * 注意单条连线时锚点落在圆切点上；同一侧多条连线会按既有槽位规则沿边分布，略微偏离圆面。
 * 始终返回新对象，避免调用方改动返回值污染传入的基准尺寸常量。
 */
export function workflowNodeBoxSize(
  type: string | null | undefined,
  base: { width: number; height: number },
): { width: number; height: number } {
  return isWorkflowTerminalNodeType(type)
    ? { width: base.height, height: base.height }
    : { width: base.width, height: base.height };
}

export function workflowNodeRadius(type: WorkflowNode["type"]): string {
  if (isWorkflowTerminalNodeType(type)) return "50%";
  if (type === "condition") return "22px";
  if (type === "parallel-fork" || type === "parallel-join") return "16px";
  return "12px";
}

export function workflowNodeTypeLabel(type: WorkflowNode["type"]): string {
  switch (type) {
    case "start":
      return "开始";
    case "end":
      return "结束";
    case "role":
      return "角色节点";
    case "condition":
      return "条件判断";
    case "parallel-fork":
      return "并行分叉";
    case "parallel-join":
      return "并行汇合";
    default:
      return type;
  }
}

export function workflowNodeTypeTone(type: WorkflowNode["type"]): WorkflowNodeCardTone {
  switch (type) {
    case "start":
      return "success";
    case "end":
      return "danger";
    case "role":
      return "info";
    case "condition":
      return "warning";
    case "parallel-fork":
    case "parallel-join":
      return "violet";
    default:
      return "neutral";
  }
}

/**
 * 构建「节点 id → 节点名」索引，供卡片徽标解析退回目标名。
 * 必须由调用方传入权威节点列表：构建节点卡片时 editorNodes 还没被赋值，
 * 若索引从正在构建中的列表推导，退回徽标会全部退化成显示 id。
 */
export function buildWorkflowNodeLabelIndex(
  nodes: Array<Pick<WorkflowNode, "id" | "label">>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    const label = String(node.label ?? "").trim();
    if (label) index.set(node.id, label);
  }
  return index;
}

/** 构造流程编辑器节点卡片摘要，突出人工介入和输出配置。 */
export function buildConfigNodeCardViewModel(
  node: WorkflowNode,
  options?: {
    roleName?: string | null;
    /** 把退回目标节点 id 解析成节点名；解析不到时回退显示 id。 */
    resolveNodeLabel?: (nodeId: string) => string | null;
  },
): WorkflowNodeCardViewModel {
  const metrics: WorkflowNodeCardViewModel["metrics"] = [];
  const badges: WorkflowNodeCardViewModel["badges"] = [];

  if (node.type === "role") {
    pushCountMetric(metrics, "input", "输入", node.inputBindings?.length ?? 0, "input");
    pushCountMetric(metrics, "knowledge", "知识", node.knowledgeOverrideBundleIds?.length ?? 0, "thread");
    metrics.push(
      { key: "result", label: outputModeLabel(node.outputArtifactMode), value: "", tone: "output" },
      { key: "approval", label: approvalModeLabel(node.approvalMode), value: "", tone: "human" },
    );
    // 角色名由卡片副标题（eyebrow）展示，这里不再重复推 badge，否则同一张卡片会出现两次。
    if (node.workItemPolicy?.mode === "sequential") {
      badges.push({ key: "workItems", text: "顺序工作项", tone: "violet" });
    }
    if (node.startMode === "manual") {
      badges.push({ key: "startMode", text: "手动启动", tone: "warning" });
    }
    if (node.outputResultKey) {
      badges.push({ key: "resultKey", text: node.outputResultKey, tone: "neutral" });
    }
    if (node.reworkPolicy?.allowedTargetNodeIds?.length) {
      // 显示能退回到哪几个节点：只给个数读不出含义，改为列出节点名。
      const targetNames = node.reworkPolicy.allowedTargetNodeIds
        .map((nodeId) => options?.resolveNodeLabel?.(nodeId) ?? nodeId)
        .join("、");
      badges.push({ key: "rework", text: `可退回：${truncateText(targetNames, 26)}`, tone: "danger" });
    }
  } else if (node.type === "condition") {
    pushCountMetric(metrics, "input", "输入", node.inputBindings?.length ?? 0, "input");
    metrics.push({ key: "output", label: "结果", value: "分支", tone: "output" });
    if (node.conditionDecisionMode === "manual") {
      badges.push({ key: "decisionMode", text: "人工选择", tone: "warning" });
    }
    if (node.conditionExpr) {
      badges.push({ key: "condition", text: truncateText(node.conditionExpr, 20), tone: "warning" });
    }
  } else if (node.type === "parallel-fork" || node.type === "parallel-join") {
    pushCountMetric(metrics, "input", "输入", node.inputBindings?.length ?? 0, "input");
  }

  return {
    label: node.label,
    eyebrow: resolveEyebrow(node, options?.roleName ?? null),
    statusLabel: workflowNodeTypeLabel(node.type),
    statusTone: workflowNodeTypeTone(node.type),
    metrics: metrics.slice(0, 4),
    badges: limitBadges(badges),
  };
}

/** 生成节点卡片副标题，按节点类型展示最关键配置状态。 */
function resolveEyebrow(node: WorkflowNode, roleName: string | null): string | null {
  if (node.type === "role") {
    return roleName || "未绑定角色";
  }
  if (node.type === "condition") {
    if (node.conditionDecisionMode === "manual") return "运行时等待人工选择分支";
    return node.conditionExpr ? "已配置分支条件" : "未配置分支条件";
  }
  if (node.type === "parallel-fork") return "把流程拆成多条并行路径";
  if (node.type === "parallel-join") return "等待并行路径汇合";
  return null;
}

/** 格式化节点卡片里的输出模式，使用中文自然语序。 */
function outputModeLabel(mode: ArtifactOutputMode | null | undefined): string {
  switch (mode) {
    case "text":
      return "文本输出";
    case "structured":
      return "结构化输出";
    case "file":
      return "单文件输出";
    case "file-set":
      return "多文件输出";
    default:
      return "默认输出";
  }
}

/** 格式化节点卡片里的审核模式，使用中文自然语序。 */
function approvalModeLabel(mode: WorkflowNode["approvalMode"] | null | undefined): string {
  if (mode === "manual") return "人工审核";
  if (mode === "auto") return "自动审核";
  return "默认审核";
}

function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxChars) return text.trim();
  return `${chars.slice(0, maxChars).join("")}…`;
}

function limitBadges(
  badges: WorkflowNodeCardViewModel["badges"],
): WorkflowNodeCardViewModel["badges"] {
  if (badges.length <= 2) return badges;
  return [
    badges[0]!,
    {
      key: "more",
      text: `+${badges.length - 1}`,
      tone: "neutral",
    },
  ];
}

function pushCountMetric(
  metrics: WorkflowNodeCardViewModel["metrics"],
  key: string,
  label: string,
  count: number,
  tone: WorkflowNodeCardMetricTone,
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  metrics.push({ key, label, value: String(count), tone });
}

