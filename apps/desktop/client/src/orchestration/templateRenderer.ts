import type { DataMapping, NodeExecutionState, WorkflowRuntimeDefinition } from "@codeflowai/shared";

/**
 * 模板变量解析优先级：
 * 1. Edge 的 dataMappings（显式字段映射）
 * 2. 上游节点产出：{{NodeLabel.fieldName}} 或 {{NodeLabel}}
 * 3. 全局变量：{{requirement}}, {{timestamp}}, {{workspacePath}}
 */
export function renderTemplate(
  template: string,
  opts: {
    /** edge 上配置的显式字段映射。 */
    dataMappings?: DataMapping[];
    /** 节点输入绑定直接解析出的字段值。 */
    boundFields?: Record<string, string>;
    /** 累积的节点产出：key=nodeId, value=产出文本。 */
    context: Record<string, string>;
    /** 工作流定义（用于按 label 查找节点）。 */
    workflow: WorkflowRuntimeDefinition;
    /** 全局变量。 */
    globals: Record<string, string>;
  },
): string {
  const { dataMappings = [], boundFields = {}, context, workflow, globals } = opts;

  // 构建 label→nodeId 映射
  const labelToNodeId = new Map<string, string>();
  for (const node of workflow.nodes) {
    labelToNodeId.set(node.label, node.id);
  }

  // 构建显式映射 map: targetField → 值
  const explicitMap = new Map<string, string>();
  for (const mapping of dataMappings) {
    // sourceField 格式: "nodeId.fieldName" 或 "nodeId"
    const dotIdx = mapping.sourceField.indexOf(".");
    if (dotIdx > 0) {
      const nodeId = mapping.sourceField.slice(0, dotIdx);
      const output = context[nodeId] ?? "";
      // 尝试提取字段（如果产出是 JSON）
      const value = extractField(output, mapping.sourceField.slice(dotIdx + 1));
      explicitMap.set(mapping.targetField, value);
    } else {
      explicitMap.set(mapping.targetField, context[mapping.sourceField] ?? "");
    }
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match, expr: string, offset: number, source: string) => {
    const trimmed = expr.trim();

    // 1. 节点输入绑定直接提供的字段值
    if (boundFields[trimmed] != null) {
      return boundFields[trimmed];
    }

    // 2. 显式映射
    if (explicitMap.has(trimmed)) {
      return explicitMap.get(trimmed)!;
    }

    // 3. 节点产出引用: {{NodeLabel.fieldName}} 或 {{NodeLabel}}
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx > 0) {
      const label = trimmed.slice(0, dotIdx);
      const field = trimmed.slice(dotIdx + 1);
      const nodeId = labelToNodeId.get(label);
      if (nodeId && context[nodeId]) {
        return extractField(context[nodeId], field);
      }
    }
    // 直接用 label 引用整个产出
    const nodeId = labelToNodeId.get(trimmed);
    if (nodeId && context[nodeId] != null) {
      return context[nodeId];
    }

    // 也尝试直接用 nodeId
    if (context[trimmed] != null) {
      return context[trimmed];
    }

    // 4. 全局变量
    if (globals[trimmed] != null) {
      return normalizeGlobalInsertion(trimmed, globals[trimmed], {
        template: source,
        offset,
        length: match.length,
      });
    }

    // 未匹配：保留原样
    return `{{${trimmed}}}`;
  });
}

function normalizeGlobalInsertion(
  key: string,
  value: string,
  context: { template: string; offset: number; length: number },
): string {
  if (key !== "requirement") return value;
  if (!hasAdjacentTemplateText(context.template, context.offset, context.length)) return value;
  return String(value ?? "").replace(/[。！？!?；;]+\s*$/u, "");
}

function hasAdjacentTemplateText(template: string, offset: number, length: number): boolean {
  return previousNonWhitespaceChar(template, offset - 1) != null
    || nextNonWhitespaceChar(template, offset + length) != null;
}

function previousNonWhitespaceChar(text: string, index: number): string | null {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char && !/\s/.test(char)) return char;
  }
  return null;
}

function nextNonWhitespaceChar(text: string, index: number): string | null {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char && !/\s/.test(char)) return char;
  }
  return null;
}

/**
 * 从产出文本中提取字段：
 * - 如果产出是 JSON，尝试解析并取字段值
 * - 否则返回整个产出
 */
function extractField(output: string, fieldName: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && fieldName in parsed) {
        const val = parsed[fieldName];
        return typeof val === "string" ? val : JSON.stringify(val);
      }
    } catch {
      // not valid JSON
    }
  }
  return output;
}

