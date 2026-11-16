import type { KnowledgeAssetNode } from "@codeflowai/shared";

export type KnowledgeTreeRow = { node: KnowledgeAssetNode; depth: number; hasChildren: boolean; expanded: boolean };

/** 旧节点沿用正文语义；目录与实时引用不进入正文补齐或复检。 */
export function knowledgeNodeHasBody(node: KnowledgeAssetNode): boolean {
  return node.contentMode !== "directory" && node.contentMode !== "reference";
}

/** 采用子项时补齐可采用的祖先；取消目录同时取消依赖后代，不扩大任务候选范围。 */
export function knowledgeAdoptionSelection(nodes: KnowledgeAssetNode[], selectedIds: string[], nodeId: string, selected: boolean, applicableIds: ReadonlySet<string>): string[] {
  const byId = new Map(nodes.map(node => [node.id, node])), next = new Set(selectedIds);
  if (selected) {
    let current = byId.get(nodeId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (applicableIds.has(current.id)) next.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  } else {
    const descendants = knowledgeSelectedNodes(nodes, [nodeId], true);
    for (const node of descendants) next.delete(node.id);
  }
  return [...next];
}

/** 平面索引一次构建；搜索临时展开祖先，不修改用户的展开集合。 */
export function knowledgeTreeRows(nodes: KnowledgeAssetNode[], expanded: ReadonlySet<string>, query = ""): KnowledgeTreeRow[] {
  const byId = new Map(nodes.filter(n => !n.archived).map(n => [n.id, n]));
  const children = new Map<string | null, KnowledgeAssetNode[]>();
  for (const node of byId.values()) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node); children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  const needle = query.trim().toLocaleLowerCase(), matches = new Set<string>();
  if (needle) for (const node of byId.values()) {
    if (!`${node.title} ${node.summary} ${node.tags.join(" ")}`.toLocaleLowerCase().includes(needle)) continue;
    let parent: KnowledgeAssetNode | undefined = node;
    const seen = new Set<string>();
    while (parent && !seen.has(parent.id)) { seen.add(parent.id); matches.add(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
  }
  const rows: KnowledgeTreeRow[] = [], seen = new Set<string>();
  const stack = [...(children.get(null) ?? [])].reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (seen.has(node.id) || (needle && !matches.has(node.id))) continue;
    seen.add(node.id);
    const descendants = children.get(node.id) ?? [], open = Boolean(needle) || expanded.has(node.id);
    rows.push({ node, depth, hasChildren: descendants.length > 0, expanded: open });
    if (open) for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i]!, depth: depth + 1 });
  }
  return rows;
}

/** 确认前展开固定选区；勾选目录和“含后代”是两项独立选择。 */
export function knowledgeSelectedNodes(nodes: KnowledgeAssetNode[], ids: string[], includeDescendants: boolean): KnowledgeAssetNode[] {
  const active = nodes.filter(n => !n.archived), byId = new Map(active.map(n => [n.id, n]));
  const selected = new Set(ids);
  return active.filter(node => {
    let current: KnowledgeAssetNode | undefined = node, chosen = false;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (selected.has(current.id) && (includeDescendants || current.id === node.id)) chosen = true;
      if (current.parentId && !byId.has(current.parentId)) return false;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chosen;
  });
}
