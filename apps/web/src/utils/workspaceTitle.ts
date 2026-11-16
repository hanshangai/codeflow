/**
 * 工作区标题兜底：优先使用已加载标题，其次取路径末段或短 ID，避免多个未加载工作区同名。
 */
export function resolveWorkspaceDisplayTitle(
  workspaceId: string,
  lookup: (workspaceId: string) => string | undefined,
): string {
  const title = lookup(workspaceId)?.trim();
  if (title) return title;
  const tail = workspaceId.split(/[\\/]/).filter(Boolean).pop();
  if (tail && tail !== workspaceId && tail.length <= 32) return tail;
  return workspaceId.slice(0, 8);
}
