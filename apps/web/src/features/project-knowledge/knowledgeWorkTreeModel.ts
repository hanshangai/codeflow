import type { KnowledgeAssetNode, KnowledgeAssetNodeState, KnowledgeGenerationRunView, KnowledgePendingChangeNode } from "@codeflowai/shared";

/** 工作会话修订由原构建负责复检和采用；讨论保留独立交付及错误，不重复投影同一正文。 */
export function knowledgeResultRuns(runs: KnowledgeGenerationRunView[]): KnowledgeGenerationRunView[] {
  const generated = runs.filter(run => ["build", "batch", "review"].includes(run.mode)).flatMap(run => run.items);
  return runs.map(run => {
    if (run.mode !== "conversation" || run.proposedTree || run.appliedTreeHash) return run;
    const items = run.items.filter(item => !generated.some(owner => owner.nodeId === item.nodeId
      && (Boolean(run.threadId && owner.executionThreadId === run.threadId) || Boolean(item.revisionId && owner.revisionId === item.revisionId))));
    return items.length === run.items.length ? run : { ...run, items };
  });
}

/** 固定保留已有分类根，其余只显示待处理资产与祖先；移除或归档资产保留处理入口。 */
export function knowledgeWorkTree(nodes: KnowledgeAssetNode[], pending: KnowledgePendingChangeNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const included = new Set(nodes.filter(node => node.parentId === null && node.category && !node.archived).map(node => node.id));
  const counts: Record<string, number> = {};
  for (const item of pending) {
    if (!byId.has(item.nodeId)) byId.set(item.nodeId, {
      id: item.nodeId, parentId: null, title: item.title, orderKey: item.nodeId,
      summary: "知识已移除，保留待处理记录", instructions: "", sourceScope: [], tags: [],
    });
    let current = byId.get(item.nodeId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id); included.add(current.id);
      counts[current.id] = (counts[current.id] ?? 0) + item.count;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return {
    nodes: [...included].map(id => {
      const node = byId.get(id)!;
      return { ...node, archived: false, parentId: node.parentId && included.has(node.parentId) ? node.parentId : null };
    }),
    counts,
    targetCount: pending.length,
  };
}

/** 只将任务实际交付的未处理差异加入导航，完整候选快照不覆盖无关正式节点。 */
export function knowledgeResultWorkTree(nodes: KnowledgeAssetNode[], states: KnowledgeAssetNodeState[], runs: KnowledgeGenerationRunView[]) {
  const stateById = new Map(states.map(state => [state.nodeId, state]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const ordered = knowledgeResultRuns(runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = new Set<string>(), pending = new Map<string, KnowledgePendingChangeNode>();
  const dismissed = new Set(runs.flatMap(run => run.dismissals?.filter(item => item.revisionId !== null).map(item => `${item.nodeId}:${item.revisionId}`) ?? []));
  const planned = new Map<string, KnowledgeAssetNode>();
  const candidates = new Map<string, Map<string, KnowledgeAssetNode>>();
  for (const run of ordered) {
    const itemByNode = new Map(run.items.map(item => [item.nodeId, item]));
    const effective = run.adoptions?.flatMap(adoption => adoption.selections.filter(selection => adoption.completed || adoption.appliedNodeIds?.includes(selection.nodeId))) ?? [];
    const applied = new Set(effective.map(item => `${item.nodeId}:${item.revisionId ?? ""}`));
    const appliedStructure = new Set(effective.map(item => item.nodeId));
    const dismissedStructure = new Set(run.dismissals?.filter(item => item.revisionId === null).map(item => item.nodeId) ?? []);
    const proposed = new Map(run.proposedTree?.nodes.map(node => [node.id, node]) ?? []);
    const baseline = run.baseTree ? new Map(run.baseTree.nodes.map(node => [node.id, node])) : nodeById;
    const legacyAdopted = !run.adoptions?.length && !!run.appliedTreeHash && ["tree", "conversation"].includes(run.mode);
    if (!legacyAdopted) for (const node of proposed.values()) {
      if (JSON.stringify(node) === JSON.stringify(baseline.get(node.id))) continue;
      const current = nodeById.get(node.id);
      const unchanged = current && JSON.stringify(current) === JSON.stringify(node);
      const revision = itemByNode.get(node.id)?.revisionId;
      if (appliedStructure.has(node.id) || dismissedStructure.has(node.id) || unchanged || (revision && dismissed.has(`${node.id}:${revision}`))) continue;
      if (!planned.has(node.id)) planned.set(node.id, node);
      if (!pending.has(node.id)) { pending.set(node.id, { nodeId: node.id, title: node.title, count: 1 }); candidates.set(node.id, proposed); }
    }
    for (const item of run.items) {
      const executing = run.active && (run.activeItemIds?.includes(item.id) || run.activeItemId === item.id);
      if (latest.has(item.nodeId) && !executing) continue;
      if (item.revisionId ? dismissed.has(`${item.nodeId}:${item.revisionId}`) || applied.has(`${item.nodeId}:${item.revisionId}`) : dismissedStructure.has(item.nodeId)) continue;
      latest.add(item.nodeId);
      const state = stateById.get(item.nodeId);
      const reviewNeedsAction = item.reviewConfig?.enabled !== false && item.review && (item.review.stale || !["passed", "passed_with_warnings"].includes(item.review.status));
      if (executing || item.status !== "completed" || reviewNeedsAction || state?.draftCount || (!state && item.revisionId)) {
        if (!pending.has(item.nodeId)) { pending.set(item.nodeId, { nodeId: item.nodeId, title: item.title, count: 1 }); candidates.set(item.nodeId, proposed); }
      }
    }
  }
  const allNodes = new Map([...nodes, ...planned.values()].map(node => [node.id, node]));
  // 仅补齐待处理节点缺失的祖先；已存在的正式祖先不使用旧任务快照替换。
  for (const item of pending.values()) {
    const proposed = candidates.get(item.nodeId);
    let current = allNodes.get(item.nodeId) ?? proposed?.get(item.nodeId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!allNodes.has(current.id)) allNodes.set(current.id, current);
      current = current.parentId ? allNodes.get(current.parentId) ?? proposed?.get(current.parentId) : undefined;
    }
  }
  const supported = new Set<string>();
  for (const item of pending.values()) {
    const candidate = allNodes.get(item.nodeId);
    if (candidate?.contentMode === "directory" && !nodeById.has(item.nodeId)) continue;
    let current = candidate;
    while (current && !supported.has(current.id)) {
      supported.add(current.id);
      current = current.parentId ? allNodes.get(current.parentId) : undefined;
    }
  }
  // 纯新目录只承载未处理内容；最后一份草稿不采用后，空目录链不产生独立待办。
  for (const item of pending.values()) if (!nodeById.has(item.nodeId) && allNodes.get(item.nodeId)?.contentMode === "directory" && !supported.has(item.nodeId)) pending.delete(item.nodeId);
  const targets = [...pending.values()];
  return { ...knowledgeWorkTree([...allNodes.values()], targets), targets };
}

/** 聚合生成修订与会话建议的导航数量，处理时仍保留各自 API 和来源。 */
export function knowledgePendingWorkTree(nodes: KnowledgeAssetNode[], states: KnowledgeAssetNodeState[], runs: KnowledgeGenerationRunView[], changes: KnowledgePendingChangeNode[]) {
  const results = knowledgeResultWorkTree(nodes, states, runs);
  const pending = new Map(changes.map(item => [item.nodeId, { ...item }]));
  for (const item of results.targets) {
    const current = pending.get(item.nodeId);
    pending.set(item.nodeId, { ...item, count: (current?.count ?? 0) + item.count });
  }
  const allNodes = new Map([...nodes, ...results.nodes].map(node => [node.id, node]));
  return knowledgeWorkTree([...allNodes.values()], [...pending.values()]);
}

export type KnowledgeLibraryUpdate = {
  id: string; nodeId: string; runId: string; revisionId: string | null; body: boolean; structure: boolean; generating: boolean;
};

export type KnowledgeDocumentContext = { nodeId: string; runId: string | null; revisionId: string | null; sourceRevision?: { runId: string; revisionId: string } | null };

/** 按任务和版本查工作会话；人工编辑正式版只匹配其确切来源版本。 */
export function knowledgeDocumentSession(runs: KnowledgeGenerationRunView[], context: KnowledgeDocumentContext) {
  /** 优先使用正文工作线程，复检子线程回到父工作会话。 */
  const sessionFor = (run: KnowledgeGenerationRunView, item: KnowledgeGenerationRunView["items"][number]) => {
    const threadId = item.executionThreadId ?? item.review?.parentThreadId ?? item.review?.executionThreadId ?? (run.mode === "conversation" ? run.threadId : null);
    return threadId ? { threadId, title: item.title,
      kind: !item.executionThreadId && !item.review?.parentThreadId && item.review?.executionThreadId ? "复检会话" as const : "知识工作会话" as const } : null;
  };
  const source = context.sourceRevision;
  if (source !== undefined && !context.runId) {
    if (!source) return null;
    const sourceRun = runs.find(run => run.id === source.runId);
    const sourceItem = sourceRun?.items.find(item => item.nodeId === context.nodeId && item.revisionId === source.revisionId);
    return sourceRun && sourceItem ? sessionFor(sourceRun, sourceItem) : null;
  }
  const orderedRuns = [...(context.runId ? runs : knowledgeResultRuns(runs))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const matches = orderedRuns.filter(run => !context.runId || run.id === context.runId)
    .flatMap(run => run.items.filter(item => item.nodeId === context.nodeId && (!context.revisionId || item.revisionId === context.revisionId))
      .map(item => ({ run, item })));
  const sessions = matches.flatMap(({ run, item }) => { const session = sessionFor(run, item); return session ? [session] : []; });
  if (!context.runId && !context.revisionId && new Set(sessions.map(session => session.threadId)).size > 1) return null;
  return sessions[0] ?? null;
}

/** 复用任务事实区分生成与待确认；正式名称、位置和范围在采用前始终优先。 */
export function knowledgeLibraryTree(nodes: KnowledgeAssetNode[], states: KnowledgeAssetNodeState[], runs: KnowledgeGenerationRunView[], changes: KnowledgePendingChangeNode[]) {
  const official = new Map(nodes.filter(node => !node.archived).map(node => [node.id, node]));
  const all = new Map(official), updates: KnowledgeLibraryUpdate[] = [];
  const resultRuns = knowledgeResultRuns(runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // 活动任务的排队、生成和复检项目均视为处理中；状态按具体任务候选记录。
  const generating = new Set<string>(), generatingUpdates = new Set<string>();
  for (const run of resultRuns.filter(item => item.active)) {
    const activeItems = new Set([run.activeItemId, ...(run.activeItemIds ?? []), ...(run.activeItemStages ?? []).map(item => item.itemId)]);
    for (const item of run.items) {
      const reviewing = (item.reviewConfig ?? run.reviewConfig)?.enabled !== false
        && (item.review?.status === "pending" || item.review?.status === "repairing");
      if (item.status !== "pending" && !activeItems.has(item.id) && !reviewing) continue;
      generating.add(item.nodeId);
      generatingUpdates.add(`${run.id}:${item.nodeId}`);
    }
  }
  const seen = new Map<string, string>(), aliases = new Map<string, string>();
  const dismissals = runs.flatMap(run => run.dismissals?.filter(item => item.revisionId !== null) ?? []);
  const adopted = new Set(runs.flatMap(run => run.adoptions?.flatMap(receipt => receipt.selections
    .filter(selection => selection.revisionId && (receipt.completed || receipt.appliedNodeIds?.includes(selection.nodeId)))
    .map(selection => `${selection.nodeId}:${selection.revisionId}`)) ?? []));
  const current = new Map(states.map(state => [state.nodeId, state.revisionId]));
  for (const run of resultRuns) {
    const result = knowledgeResultWorkTree(nodes, states, [{ ...run, dismissals: [...(run.dismissals ?? []), ...dismissals] }]);
    const proposed = new Map(result.nodes.map(node => [node.id, node]));
    for (const node of result.nodes) if (!all.has(node.id) && !nodes.some(existing => existing.id === node.id)
      && run.proposedTree?.nodes.some(candidate => candidate.id === node.id)) all.set(node.id, node);
    for (const target of result.targets) {
      const revisionId = run.items.find(item => item.nodeId === target.nodeId)?.revisionId ?? null;
      const candidateNode = run.proposedTree?.nodes.find(node => node.id === target.nodeId);
      const baseline = run.baseTree?.nodes.find(node => node.id === target.nodeId) ?? nodes.find(node => node.id === target.nodeId);
      const structureChanged = Boolean(candidateNode && baseline && JSON.stringify(candidateNode) !== JSON.stringify(baseline)
        && JSON.stringify(candidateNode) !== JSON.stringify(nodes.find(node => node.id === target.nodeId))
        && !run.adoptions?.some(receipt => (receipt.completed || receipt.appliedNodeIds?.includes(target.nodeId)) && receipt.selections.some(selection => selection.nodeId === target.nodeId)));
      const bodyHandled = Boolean(revisionId && (current.get(target.nodeId) === revisionId || adopted.has(`${target.nodeId}:${revisionId}`)));
      if (bodyHandled && !structureChanged) continue;
      const lineage: KnowledgeAssetNode[] = [];
      let candidate = proposed.get(target.nodeId);
      const visited = new Set<string>();
      while (candidate && !visited.has(candidate.id)) {
        visited.add(candidate.id); lineage.unshift(candidate);
        candidate = candidate.parentId ? proposed.get(candidate.parentId) : undefined;
      }
      const identity = revisionId ? JSON.stringify([target.nodeId, revisionId, lineage]) : `${run.id}:${target.nodeId}`;
      const id = `${run.id}:${target.nodeId}`;
      aliases.set(id, seen.get(identity) ?? id);
      if (seen.has(identity)) continue;
      seen.set(identity, id);
      const contentMode = candidateNode?.contentMode ?? baseline?.contentMode ?? "generated";
      // 新增引用或正文属于文档更新；已有节点仅改名、移动或范围时属于结构更新。
      const bodyChanged = contentMode !== "directory" && Boolean((revisionId && !bodyHandled) || (!revisionId && !baseline));
      const structureUpdate = !baseline || proposed.get(target.nodeId)?.contentMode === "directory" || structureChanged;
      updates.push({ id, nodeId: target.nodeId, runId: run.id, revisionId, body: bodyChanged, structure: structureUpdate, generating: generatingUpdates.has(`${run.id}:${target.nodeId}`) });
    }
  }
  const pending = new Map<string, KnowledgePendingChangeNode>();
  for (const update of updates) pending.set(update.nodeId, { nodeId: update.nodeId, title: all.get(update.nodeId)?.title ?? update.nodeId, count: 1 });
  for (const change of changes) pending.set(change.nodeId, { ...change, count: 1 });
  const indexed = knowledgeWorkTree([...all.values()], [...pending.values()]);
  // 新目录只保留实际待办的祖先；不采用最后候选后，正式节点和默认空文档仍保留。
  const supported = new Set(indexed.nodes.map(node => node.id));
  const visible = [...all.values()].filter(node => official.has(node.id) || supported.has(node.id));
  const awaitingIds = new Set([...updates.filter(update => !update.generating).map(update => update.nodeId), ...changes.map(change => change.nodeId)]);
  const awaiting = [...pending.values()].filter(item => awaitingIds.has(item.nodeId));
  const documentIds = new Set([...updates.filter(update => update.body && !update.generating).map(update => update.nodeId), ...changes.map(change => change.nodeId)]);
  const structureIds = new Set(updates.filter(update => update.structure && !update.generating).map(update => update.nodeId));
  const generatingIds = [...generating].filter(id => all.has(id) && all.get(id)?.contentMode !== "directory" && !all.get(id)?.archived);
  const documentCounts = knowledgeWorkTree([...all.values()], awaiting.filter(item => documentIds.has(item.nodeId))).counts;
  const structureCounts = knowledgeWorkTree([...all.values()], awaiting.filter(item => structureIds.has(item.nodeId))).counts;
  const generatingCounts = knowledgeWorkTree([...all.values()], generatingIds.map(nodeId => ({ nodeId, title: all.get(nodeId)!.title, count: 1 }))).counts;
  return { nodes: visible, updates, aliases, counts: indexed.counts, targetCount: awaiting.length,
    documentCounts, structureCounts, documentCount: documentIds.size, structureCount: structureIds.size,
    generatingIds, generatingCounts, generatingCount: generatingIds.length, pendingCount: awaiting.length,
    newIds: visible.filter(node => !official.has(node.id)).map(node => node.id) };
}
