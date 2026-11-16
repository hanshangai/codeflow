/**
 * 「过程」折叠块的渲染门控：折叠状态下不挂载内部条目（含审批/用户输入项等挂载期请求）。
 * 规则是「首次展开才渲染、之后只增不减」：收起时保留已渲染内容，避免反复挂载与重建。
 */
export function markProcessBatchRendered(
  renderedKeys: ReadonlySet<string>,
  key: string,
  isOpen: boolean,
): ReadonlySet<string> {
  if (!isOpen || renderedKeys.has(key)) return renderedKeys;
  return new Set([...renderedKeys, key]);
}
