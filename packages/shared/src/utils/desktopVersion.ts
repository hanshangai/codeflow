/** 仅按实际壳和资源事实生成展示号；旧号或缺少事实时保留原号，不参与排序。 */
export function formatDesktopVersion(shellVersion: string | null, resourceVersion: string | null): string | null {
  const shell = shellVersion?.trim() || null;
  const resource = resourceVersion?.trim() || null;
  if (!resource) return shell;
  /** 壳版本允许两至四段（含 Windows 完整版本），展示号只取前两段。 */
  const shellParts = shell?.match(/^(\d+)\.(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/);
  const resourceParts = resource.match(/^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/);
  if (!shellParts || !resourceParts) return resource;
  const [, year, month, day, patch] = resourceParts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day) || !Number.isSafeInteger(Number(patch)) || Number(patch) < 1) return resource;
  return `${shellParts[1]}.${shellParts[2]}.${month}${day}${Number(patch) === 1 ? "" : `.${Number(patch)}`}`;
}
