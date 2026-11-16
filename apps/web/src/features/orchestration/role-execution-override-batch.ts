import {
  isRoleExecutionEngineEnabled,
  type EngineType,
  type RoleExecutionConfig,
} from "@codeflowai/shared";

export type RoleExecutionOverrideDraft = {
  enabled: boolean;
  engine: EngineType;
  model: string;
  effort: string;
  autoCompactPct: number | null;
  /** 服务档位覆盖；"fast" 开启，null 表示显式关闭角色默认的 Fast。 */
  serviceTier?: "fast" | null;
};

export type RoleExecutionOverrideBatchDraft = Omit<RoleExecutionOverrideDraft, "enabled">;

export type RoleExecutionOverrideBatchTarget = {
  roleId: string;
  executionConfig: RoleExecutionConfig;
};

const ROLE_EXECUTION_ENGINES: EngineType[] = ["codex", "claude"];

/** 返回全部目标角色共同启用的执行引擎；空目标不提供批量选项。 */
export function listCommonRoleExecutionEngines(
  targets: readonly RoleExecutionOverrideBatchTarget[],
): EngineType[] {
  const uniqueTargets = new Map(
    targets
      .map((target) => [String(target.roleId ?? "").trim(), target] as const)
      .filter(([roleId]) => roleId),
  );
  if (uniqueTargets.size === 0) return [];
  return ROLE_EXECUTION_ENGINES.filter((engine) => (
    Array.from(uniqueTargets.values()).every((target) => (
      isRoleExecutionEngineEnabled(target.executionConfig, engine, target.executionConfig.preferredEngine)
    ))
  ));
}

/** 把一套运行覆盖复制到唯一角色集合，并保留集合外草稿。 */
export function applyRoleExecutionOverrideBatch(
  current: Readonly<Record<string, RoleExecutionOverrideDraft>>,
  roleIds: Iterable<string>,
  batchDraft: RoleExecutionOverrideBatchDraft,
): Record<string, RoleExecutionOverrideDraft> {
  const next = { ...current };
  for (const roleId of uniqueRoleIds(roleIds)) {
    next[roleId] = { enabled: true, ...batchDraft };
  }
  return next;
}

/** 关闭唯一角色集合的本次运行覆盖，并保留字段值供后续再次启用。 */
export function disableRoleExecutionOverrideBatch(
  current: Readonly<Record<string, RoleExecutionOverrideDraft>>,
  roleIds: Iterable<string>,
): Record<string, RoleExecutionOverrideDraft> {
  const next = { ...current };
  for (const roleId of uniqueRoleIds(roleIds)) {
    const draft = next[roleId];
    if (draft) next[roleId] = { ...draft, enabled: false };
  }
  return next;
}

/** 规整角色 ID，确保同一角色只被批量处理一次。 */
function uniqueRoleIds(roleIds: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(roleIds, (roleId) => String(roleId ?? "").trim()).filter(Boolean)));
}
