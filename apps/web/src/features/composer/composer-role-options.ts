import type { RoleDefinition, WorkspaceId } from "@codeflowai/shared";

import { createApiResultError, type ApiRequestContext } from "../../api/request";
import { listOrchRoles } from "../../api/orchestration";

type RoleWithAvailability = RoleDefinition & {
  availability?: { available?: boolean; message?: string | null };
};

export type ComposerRoleOption = {
  label: string;
  value: string;
  title: string;
};

export type ComposerRoleListLoader = typeof listOrchRoles;

/** 将目标 Client 的可用 Agent 转为会话选项，失败时保持 API 的显式错误语义。 */
export async function loadComposerRoleOptions(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  loader: ComposerRoleListLoader = listOrchRoles,
): Promise<ComposerRoleOption[]> {
  const result = await loader(ctx, workspaceId, "execution");
  if (!result.ok) throw createApiResultError(result);

  return (result.roles as RoleWithAvailability[])
    .filter((role) => role.availability?.available !== false)
    .map((role) => ({
      label: role.name || role.id,
      value: role.id,
      title: role.description || role.name || role.id,
    }));
}
