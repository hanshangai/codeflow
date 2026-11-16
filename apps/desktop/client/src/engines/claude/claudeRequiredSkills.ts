import path from "node:path";

import type { RequiredWorkspaceSkill } from "../threadSession.js";

export const CLAUDE_REQUIRED_SKILL_UNAVAILABLE_CODE = "claude_required_skill_unavailable";

export type ClaudeRequiredSkillError = Error & {
  code: typeof CLAUDE_REQUIRED_SKILL_UNAVAILABLE_CODE;
  requestMethod: "system.init";
  terminationKind: "error";
  additionalDetails: string;
};

export type ClaudeRequiredSkillGateState = {
  requiredNames: string[];
  expectedPaths: string[];
  confirmed: boolean;
  failure: ClaudeRequiredSkillError | null;
};

const CLAUDE_OUTPUT_TYPES = new Set(["assistant", "stream_event", "result"]);
const CLAUDE_SKILL_DETAIL_ITEM_LIMIT = 10;
const CLAUDE_SKILL_DETAIL_VALUE_LIMIT = 120;
const CLAUDE_SKILL_DETAILS_LIMIT = 2_000;

/** 创建本回合 Claude Skill 发现门禁，并拒绝空 Skill 名称。 */
export function createClaudeRequiredSkillGate(
  requirements: RequiredWorkspaceSkill[] | null | undefined,
): ClaudeRequiredSkillGateState {
  const items = Array.isArray(requirements) ? requirements : [];
  const seenNames = new Set<string>();
  const normalizedItems = items.map((item, index) => {
    const name = String(item?.name ?? "").trim();
    const expectedPath = String(item?.expectedPath ?? "").trim();
    if (!name) {
      throw createRequiredSkillError(`requiredWorkspaceSkills[${index}] 缺少 name。`, [], [], "invalid_requirement");
    }
    if (!expectedPath || !path.isAbsolute(expectedPath)) {
      throw createRequiredSkillError("expectedPath 必须为 SKILL.md 的绝对路径。", [name], [], "invalid_expected_path", [expectedPath]);
    }
    if (seenNames.has(name)) {
      throw createRequiredSkillError(`requiredWorkspaceSkills 包含重复名称：${name}。`, [name], [], "duplicate_requirement", [expectedPath]);
    }
    seenNames.add(name);
    return { name, expectedPath };
  });
  const requiredNames = normalizedItems.map((item) => item.name);
  return {
    requiredNames,
    expectedPaths: normalizedItems.map((item) => item.expectedPath),
    confirmed: requiredNames.length === 0,
    failure: null,
  };
}

/** 检查单条 Claude stdout 事件，确保模型输出前已由 system.init.skills 确认全部 Skill。 */
export function inspectClaudeRequiredSkillEvent(
  state: ClaudeRequiredSkillGateState,
  event: unknown,
): ClaudeRequiredSkillError | null {
  if (state.failure || state.confirmed || state.requiredNames.length === 0) return state.failure;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;

  const record = event as Record<string, unknown>;
  const type = String(record.type ?? "").trim();
  const subtype = String(record.subtype ?? "").trim();
  if (type === "system" && subtype === "init") {
    const skillsValid = Array.isArray(record.skills)
      && record.skills.every((item) => typeof item === "string" && item.trim().length > 0);
    const availableNames = skillsValid
      ? [...new Set((record.skills as string[]).map((item) => item.trim()))]
      : [];
    if (!skillsValid) {
      state.failure = createRequiredSkillError(
        "Claude Code 初始化返回了非法的 system.init.skills 字段，本回合已在助手输出前中止。",
        state.requiredNames,
        availableNames,
        "invalid_skills_field",
        state.expectedPaths,
      );
      return state.failure;
    }
    const availableSet = new Set(availableNames);
    const missingNames = state.requiredNames.filter((name) => !availableSet.has(name));
    if (missingNames.length > 0) {
      state.failure = createRequiredSkillError(
        `Claude Code 初始化未发现本回合必需的工作区 Skill：${missingNames.join("、")}。本回合已在助手输出前中止。`,
        state.requiredNames,
        availableNames,
        "missing_required_skill",
        state.expectedPaths,
      );
      return state.failure;
    }
    state.confirmed = true;
    return null;
  }

  if (CLAUDE_OUTPUT_TYPES.has(type)) {
    state.failure = createRequiredSkillError(
      `Claude Code 在 system.init.skills 完成校验前返回了 ${type}，无法确认本回合必需的工作区 Skill。`,
      state.requiredNames,
      [],
      `output_before_init:${type}`,
      state.expectedPaths,
    );
  }
  return state.failure;
}

/** 在 Claude 子进程退出时补齐缺失 system.init 的显式失败。 */
export function finalizeClaudeRequiredSkillGate(
  state: ClaudeRequiredSkillGateState,
): ClaudeRequiredSkillError | null {
  if (state.failure || state.confirmed || state.requiredNames.length === 0) return state.failure;
  state.failure = createRequiredSkillError(
    "Claude Code 未返回 system.init.skills，无法确认本回合必需的工作区 Skill。",
    state.requiredNames,
    [],
    "missing_system_init",
    state.expectedPaths,
  );
  return state.failure;
}

/** 构造可进入统一 turn.error 语义的 Claude Skill 门禁错误。 */
function createRequiredSkillError(
  message: string,
  requiredNames: string[],
  availableNames: string[],
  reason: string,
  expectedPaths: string[] = [],
): ClaudeRequiredSkillError {
  const error = new Error(message) as ClaudeRequiredSkillError;
  error.code = CLAUDE_REQUIRED_SKILL_UNAVAILABLE_CODE;
  error.requestMethod = "system.init";
  error.terminationKind = "error";
  const details = [
    `reason=${reason}`,
    `required=${summarizeDetailValues(requiredNames)}`,
    `available=${summarizeDetailValues(availableNames)}`,
    `expectedPaths=${summarizeDetailValues(expectedPaths)}`,
  ].join("; ");
  error.additionalDetails = details.length > CLAUDE_SKILL_DETAILS_LIMIT
    ? `${details.slice(0, CLAUDE_SKILL_DETAILS_LIMIT)}...[truncated]`
    : details;
  return error;
}

/** 限制 Skill 发现详情的条目数和单项长度，避免 provider 返回值放大日志。 */
function summarizeDetailValues(values: string[]): string {
  if (!values.length) return "none";
  const visible = values.slice(0, CLAUDE_SKILL_DETAIL_ITEM_LIMIT).map((value) => (
    value.length > CLAUDE_SKILL_DETAIL_VALUE_LIMIT
      ? `${value.slice(0, CLAUDE_SKILL_DETAIL_VALUE_LIMIT)}...[truncated]`
      : value
  ));
  const hiddenCount = values.length - visible.length;
  if (hiddenCount > 0) visible.push(`...(+${hiddenCount})`);
  return visible.join(",");
}
