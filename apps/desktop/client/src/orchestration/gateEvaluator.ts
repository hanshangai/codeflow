import type { GateCriterion, GateEvidence, GateEvaluationOutcome, GateResult } from "@codeflowai/shared";

export type AiGateEvaluatorResult = {
  passed: boolean;
  message: string;
  outcome?: GateEvaluationOutcome | null;
  evidence?: GateEvidence[] | null;
  errorCode?: string | null;
  evaluationRunId?: string | null;
  evaluationCallId?: string | null;
  evaluationThreadId?: string | null;
  evaluationTurnId?: string | null;
  promptSnapshotId?: string | null;
};

/**
 * 评估所有门禁标准。
 * 对于 "ai" 类型门禁，调用传入的 aiEvaluator 回调。
 */
export async function evaluateGates(
  output: string,
  criteria: GateCriterion[],
  aiEvaluator?: (prompt: string, output: string) => Promise<AiGateEvaluatorResult>,
): Promise<GateResult[]> {
  const results: GateResult[] = [];

  for (const criterion of criteria) {
    let result: GateResult;

    switch (criterion.type) {
      case "regex":
        result = evaluateRegex(criterion, output);
        break;
      case "json-schema":
        result = evaluateJsonSchema(criterion, output);
        break;
      case "ai":
        result = await evaluateAi(criterion, output, aiEvaluator);
        break;
      default:
        result = {
          criterionId: criterion.id,
          passed: false,
          outcome: "error",
          evaluatorKind: "deterministic",
          errorCode: "UNSUPPORTED_GATE_TYPE",
          message: `未知门禁类型: ${criterion.type}`,
        };
    }

    results.push(result);
  }

  return results;
}

/** 检查是否有阻断性门禁失败。 */
export function hasBlockingFailure(results: GateResult[], criteria: GateCriterion[]): boolean {
  const criteriaMap = new Map(criteria.map((c) => [c.id, c]));
  return results.some((r) => {
    if (r.passed) return false;
    const criterion = criteriaMap.get(r.criterionId);
    if (r.outcome === "error") return true;
    return criterion?.blocking === true;
  });
}

// ── Regex Gate ──────────────────────────────────────────────────

function evaluateRegex(criterion: GateCriterion, output: string): GateResult {
  try {
    const regex = new RegExp(criterion.config, "m");
    const passed = regex.test(output);
    return {
      criterionId: criterion.id,
      passed,
      outcome: passed ? "pass" : "fail",
      evaluatorKind: "deterministic",
      message: passed ? "正则匹配通过" : `正则不匹配: ${criterion.config}`,
    };
  } catch (e) {
    return {
      criterionId: criterion.id,
      passed: false,
      outcome: "error",
      evaluatorKind: "deterministic",
      errorCode: "INVALID_REGEX",
      message: `正则表达式无效: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── JSON Schema Gate ────────────────────────────────────────────

function evaluateJsonSchema(criterion: GateCriterion, output: string): GateResult {
  // 简单的 JSON schema 校验：验证输出是有效 JSON 且匹配必需字段
  try {
    const schema = JSON.parse(criterion.config);
    const trimmed = output.trim();
    let data: any;

    try {
      data = JSON.parse(trimmed);
    } catch {
      return { criterionId: criterion.id, passed: false, outcome: "fail", evaluatorKind: "deterministic", message: "产出不是有效的 JSON" };
    }

    // 基础 schema 校验
    if (schema.type === "object" && typeof data !== "object") {
      return { criterionId: criterion.id, passed: false, outcome: "fail", evaluatorKind: "deterministic", message: `期望 object，得到 ${typeof data}` };
    }
    if (schema.type === "array" && !Array.isArray(data)) {
      return { criterionId: criterion.id, passed: false, outcome: "fail", evaluatorKind: "deterministic", message: `期望 array，得到 ${typeof data}` };
    }

    // required 字段检查
    if (Array.isArray(schema.required) && typeof data === "object" && data !== null) {
      const missing = schema.required.filter((key: string) => !(key in data));
      if (missing.length > 0) {
        return { criterionId: criterion.id, passed: false, outcome: "fail", evaluatorKind: "deterministic", message: `缺少必需字段: ${missing.join(", ")}` };
      }
    }

    return { criterionId: criterion.id, passed: true, outcome: "pass", evaluatorKind: "deterministic", message: "JSON schema 校验通过" };
  } catch (e) {
    return {
      criterionId: criterion.id,
      passed: false,
      outcome: "error",
      evaluatorKind: "deterministic",
      errorCode: "INVALID_JSON_SCHEMA",
      message: `schema 配置无效: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── AI Gate ─────────────────────────────────────────────────────

async function evaluateAi(
  criterion: GateCriterion,
  output: string,
  aiEvaluator?: (prompt: string, output: string) => Promise<AiGateEvaluatorResult>,
): Promise<GateResult> {
  if (!aiEvaluator) {
    return {
      criterionId: criterion.id,
      passed: false,
      outcome: "error",
      evaluatorKind: "ai",
      errorCode: "AI_GATE_EVALUATOR_NOT_CONFIGURED",
      message: "AI 门禁评估器未接入，无法自动判定",
    };
  }

  try {
    const result = await aiEvaluator(criterion.config, output);
    const outcome = result.outcome ?? (result.passed ? "pass" : "fail");
    const expectedPassed = outcome === "pass";
    if ((outcome !== "pass" && outcome !== "fail" && outcome !== "error") || result.passed !== expectedPassed) {
      return {
        criterionId: criterion.id,
        passed: false,
        outcome: "error",
        evaluatorKind: "ai",
        errorCode: "AI_GATE_RESULT_INCONSISTENT",
        message: "AI 门禁评估结果的 passed 与 outcome 不一致",
      };
    }
    return { criterionId: criterion.id, ...result, passed: expectedPassed, outcome, evaluatorKind: "ai" };
  } catch (e) {
    return {
      criterionId: criterion.id,
      passed: false,
      outcome: "error",
      evaluatorKind: "ai",
      errorCode: "AI_GATE_EVALUATION_FAILED",
      message: `AI 评估失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

