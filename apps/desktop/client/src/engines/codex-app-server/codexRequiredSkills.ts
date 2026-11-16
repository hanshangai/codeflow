import path from "node:path";

import type { RequiredWorkspaceSkill } from "../threadSession.js";

const CODEX_SKILLS_LIST_REQUEST_TIMEOUT_MS = 10_000;

type CodexSkillsRequester = {
  request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; trackLateSettlement?: boolean },
  ): Promise<unknown>;
};

type NormalizedRequiredWorkspaceSkill = RequiredWorkspaceSkill & {
  normalizedExpectedPath: string;
};

/** 在创建或恢复 provider thread 前，强制刷新并校验本回合依赖的工作区 Skill。 */
export async function ensureCodexRequiredWorkspaceSkills(input: {
  requester: CodexSkillsRequester;
  workspacePath: string;
  requirements?: RequiredWorkspaceSkill[] | null;
}): Promise<void> {
  const requirements = normalizeRequirements(input.requirements, input.workspacePath);
  if (requirements.length === 0) return;

  let result: unknown;
  try {
    result = await input.requester.request(
      "skills/list",
      { cwds: [input.workspacePath], forceReload: true },
      { timeoutMs: CODEX_SKILLS_LIST_REQUEST_TIMEOUT_MS },
    );
  } catch (cause) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: `skills/list 请求失败：${formatErrorDetail(cause)}`,
      cause,
    });
  }

  assertCodexRequiredWorkspaceSkills(result, {
    workspacePath: input.workspacePath,
    requirements,
  });
}

/** 校验 skills/list 的 cwd 分组及 Skill 名称、路径、scope 和启用状态。 */
export function assertCodexRequiredWorkspaceSkills(
  result: unknown,
  input: {
    workspacePath: string;
    requirements: RequiredWorkspaceSkill[];
  },
): void {
  const requirements = normalizeRequirements(input.requirements, input.workspacePath);
  if (requirements.length === 0) return;

  const data = isRecord(result) && Array.isArray(result.data) ? result.data : null;
  if (!data) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: "skills/list 返回缺少 data 数组",
    });
  }

  const normalizedWorkspacePath = normalizePathForComparison(input.workspacePath);
  if (data.length !== 1
    || !isRecord(data[0])
    || normalizePathForComparison(data[0].cwd) !== normalizedWorkspacePath) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: `skills/list 应只返回当前工作区的唯一 cwd 分组，实际分组数为 ${data.length}`,
    });
  }

  const cwdGroup = data[0];
  if (!Array.isArray(cwdGroup.errors)) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: "skills/list cwd 分组缺少 errors 数组",
    });
  }
  if (cwdGroup.errors.length > 0) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: `skills/list 返回 ${cwdGroup.errors.length} 个发现错误：${formatErrorDetail(cwdGroup.errors[0])}`,
    });
  }
  if (!Array.isArray(cwdGroup.skills)) {
    throw createRequiredSkillError({
      workspacePath: input.workspacePath,
      requirements,
      reason: "skills/list cwd 分组缺少 skills 数组",
    });
  }

  for (const requirement of requirements) {
    const matches = cwdGroup.skills.filter((skill): skill is Record<string, unknown> => (
      isRecord(skill) && String(skill.name ?? "").trim() === requirement.name
    ));
    if (matches.length !== 1) {
      throw createRequiredSkillError({
        workspacePath: input.workspacePath,
        requirements: [requirement],
        reason: `应发现唯一同名 Skill，实际为 ${matches.length}`,
      });
    }

    const skill = matches[0]!;
    const actualPath = String(skill.path ?? "").trim();
    if (normalizePathForComparison(actualPath) !== requirement.normalizedExpectedPath) {
      throw createRequiredSkillError({
        workspacePath: input.workspacePath,
        requirements: [requirement],
        reason: `Skill 路径不匹配，实际为 ${actualPath || "<empty>"}`,
      });
    }
    if (String(skill.scope ?? "").trim() !== "repo") {
      throw createRequiredSkillError({
        workspacePath: input.workspacePath,
        requirements: [requirement],
        reason: `Skill scope 必须为 repo，实际为 ${String(skill.scope ?? "<empty>")}`,
      });
    }
    if (skill.enabled !== true) {
      throw createRequiredSkillError({
        workspacePath: input.workspacePath,
        requirements: [requirement],
        reason: "Skill 未启用",
      });
    }
  }
}

/** 规范化强依赖声明，并拒绝空名称、非绝对入口路径和重复名称。 */
function normalizeRequirements(
  requirements: RequiredWorkspaceSkill[] | null | undefined,
  workspacePath: string,
): NormalizedRequiredWorkspaceSkill[] {
  if (!requirements?.length) return [];
  const seenNames = new Set<string>();
  return requirements.map((requirement, index) => {
    const name = String(requirement?.name ?? "").trim();
    const expectedPath = String(requirement?.expectedPath ?? "").trim();
    if (!name) {
      throw createRequiredSkillError({
        workspacePath,
        requirements: [],
        reason: `requiredWorkspaceSkills[${index}] 缺少 name`,
      });
    }
    if (!expectedPath || !path.isAbsolute(expectedPath)) {
      throw createRequiredSkillError({
        workspacePath,
        requirements: [{ name, expectedPath }],
        reason: "expectedPath 必须为 SKILL.md 的绝对路径",
      });
    }
    if (seenNames.has(name)) {
      throw createRequiredSkillError({
        workspacePath,
        requirements: [{ name, expectedPath }],
        reason: "requiredWorkspaceSkills 包含重复名称",
      });
    }
    seenNames.add(name);
    return {
      name,
      expectedPath,
      normalizedExpectedPath: normalizePathForComparison(expectedPath),
    };
  });
}

/** 构造可进入 turn.error 的稳定 Skill 门禁错误。 */
function createRequiredSkillError(input: {
  workspacePath: string;
  requirements: Array<Pick<RequiredWorkspaceSkill, "name" | "expectedPath">>;
  reason: string;
  cause?: unknown;
}): Error {
  const names = input.requirements.map((item) => item.name).filter(Boolean).join(",") || "<invalid>";
  const message = `Codex 工作区 Skill 校验失败（workspace=${input.workspacePath}, skills=${names}）：${input.reason}`;
  return Object.assign(
    new Error(message, input.cause === undefined ? undefined : { cause: input.cause }),
    {
      code: "codex_required_skill_unavailable",
      requestMethod: "skills/list",
      terminationKind: "error" as const,
    },
  );
}

/** 将路径规范化为当前平台可稳定比较的绝对路径。 */
function normalizePathForComparison(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const resolved = path.normalize(path.resolve(raw));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 提取错误中的简短可追踪信息，避免内联整份协议结果。 */
function formatErrorDetail(value: unknown): string {
  const detail = value instanceof Error
    ? value.message
    : isRecord(value)
      ? String(value.message ?? value.path ?? "unknown")
      : String(value ?? "unknown");
  const normalized = detail.trim() || "unknown";
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...[truncated]` : normalized;
}

/** 判断未知协议值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
