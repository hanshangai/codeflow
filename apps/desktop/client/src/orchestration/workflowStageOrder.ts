import type { WorkflowEdge, WorkflowNode } from "@codeflowai/shared";

export type WorkflowStageOrderEntry = {
  node: WorkflowNode;
  /** 该段内第几条分支（0 起，按分支首个节点在原数组中的位置排序）；不在并行段内为 null。 */
  parallelBranchIndex: number | null;
  /**
   * 是否为该分支在展示顺序中最早出现的节点。
   * 卡片只在分支起点前画 ∥：分支在数组里可能交错（a1、b1、a2），
   * 用「与相邻阶段的序号比较」会把 a2 也误判成新分支的开始。
   */
  isBranchStart: boolean;
};

/**
 * 按 DAG 依赖排出会话卡片要展示的节点顺序，并标出每个节点所属的并行段与分支。
 *
 * 卡片此前直接用 nodes 数组顺序：内置工作流的数组是人工按流程写好的，顺序正确；
 * 自定义工作流的数组却是编辑器里的「节点添加顺序」（先放 START/END 就会排到最前），
 * 于是同一条流程在画布上正常、在卡片上错乱。这里改为按 edges 做拓扑排序，
 * 与节点坐标无关，因此对历史数据同样有效，不需要用户重新保存。
 *
 * 稳定性：就绪节点按原数组下标取最小者，保证并行分支之间的相对次序与定义一致。
 * 容错：存在环或孤立节点时，未排到的节点按原数组顺序追加到末尾，绝不丢节点。
 */
export function orderWorkflowNodesForDisplay(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowStageOrderEntry[] {
  if (!nodes.length) return [];
  const orderIndex = new Map(nodes.map((node, index) => [node.id, index] as const));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));

  for (const edge of edges) {
    const source = edge.sourceNodeId;
    const target = edge.targetNodeId;
    if (!outgoing.has(source) || !indegree.has(target) || source === target) continue;
    outgoing.get(source)!.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const orderedIds: string[] = [];
  const remaining = new Set(nodes.map((node) => node.id));
  while (remaining.size > 0) {
    // nodes 本身就是原数组顺序，第一个入度为 0 的就是「原下标最小」的就绪节点。
    // 节点规模是几十量级，这里的线性扫描比维护堆更简单，也不会成为瓶颈。
    const next = nodes.find((node) => remaining.has(node.id) && (indegree.get(node.id) ?? 0) === 0);
    if (!next) break; // 剩余节点在环上，交给下面的补齐分支处理。
    orderedIds.push(next.id);
    remaining.delete(next.id);
    for (const target of outgoing.get(next.id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
    }
  }
  // 环内或不可达节点按原顺序补齐：宁可顺序不完美，也不能漏掉节点。
  for (const node of nodes) if (remaining.has(node.id)) orderedIds.push(node.id);

  const { branchOf, groupOf } = resolveParallelBranches(nodes, outgoing, orderIndex);
  const entries: WorkflowStageOrderEntry[] = orderedIds.map((id) => ({
    node: nodeById.get(id)!,
    parallelBranchIndex: branchOf.get(id) ?? null,
    isBranchStart: false,
  }));

  // 分支起点按最终展示顺序判定，而不是按数组顺序或相邻比较。
  const seenBranchKeys = new Set<string>();
  for (const entry of entries) {
    const groupId = groupOf.get(entry.node.id);
    if (!groupId || entry.parallelBranchIndex === null) continue;
    const key = `${groupId}:${entry.parallelBranchIndex}`;
    if (seenBranchKeys.has(key)) continue;
    seenBranchKeys.add(key);
    entry.isBranchStart = true;
  }
  return entries;
}

/**
 * 识别并行段：对每个 parallel-fork，沿出边向下游扩散，遇到 parallel-join 或 END 停下，
 * 之间的节点属于这一段；每个节点按「从 fork 的第几条出边可达」得到分支序号。
 *
 * fork 不一定配有 join（资产校验不强制成对），所以 END 也算边界，
 * 否则终止节点会被当成某个并行分支的成员。分支序号按分支首个节点在原数组中的位置重排，
 * 避免 edges 顺序影响展示。
 */
function resolveParallelBranches(
  nodes: WorkflowNode[],
  outgoing: Map<string, string[]>,
  orderIndex: Map<string, number>,
): { branchOf: Map<string, number>; groupOf: Map<string, string> } {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const groupOf = new Map<string, string>();
  const branchOf = new Map<string, number>();

  for (const fork of nodes) {
    if (fork.type !== "parallel-fork") continue;
    const branchMembers = new Map<string, Set<string>>();
    (outgoing.get(fork.id) ?? []).forEach((startId) => {
      const members = new Set<string>();
      const visited = new Set<string>();
      const queue = [startId];
      // 用游标推进代替 queue.shift()，避免每个出队都搬一次数组。
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head]!;
        if (visited.has(current) || current === fork.id) continue;
        visited.add(current);
        const node = nodeById.get(current);
        if (!node || node.type === "parallel-join" || node.type === "end") continue;
        members.add(current);
        for (const next of outgoing.get(current) ?? []) queue.push(next);
      }
      if (members.size > 0) branchMembers.set(startId, members);
    });

    // 分支按「其成员在原数组中的最靠前位置」排序，保证序号与定义顺序一致。
    const orderedBranches = [...branchMembers.entries()].sort((left, right) => {
      return minOrderIndexOf(left[1], orderIndex) - minOrderIndexOf(right[1], orderIndex);
    });
    orderedBranches.forEach(([, members], branchIndex) => {
      for (const id of members) {
        // 嵌套并行时以先识别到的段为准，避免节点被重复归属。
        if (groupOf.has(id)) continue;
        groupOf.set(id, fork.id);
        branchOf.set(id, branchIndex);
      }
    });
  }
  return { branchOf, groupOf };
}

/** 取一组节点在原数组中的最小下标；用循环而非展开参数，避免成员极多时触发参数上限。 */
function minOrderIndexOf(ids: Set<string>, orderIndex: Map<string, number>): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const id of ids) {
    const index = orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
    if (index < min) min = index;
  }
  return min;
}
