import { type KnowledgeChange, type KnowledgeChangeDetail, type KnowledgeChangeSummary, type KnowledgePendingChangeNode } from "@codeflowai/shared";
import { KnowledgeAssetStore } from "./knowledgeAssetStore.js";
import { KnowledgeAssetError, knowledgeHash, knowledgeId, knowledgeJson, knowledgeRecord, knowledgeText } from "./knowledgeAssetFiles.js";

/** 修改建议独立保存；既不改变正式版本，也不依赖发起会话的结束或存活状态。 */
export class KnowledgeChangeStore {
  constructor(private readonly store: KnowledgeAssetStore) {}
  /** 审批记录跟随 Store 的配置目录。 */
  private get root(): string { return `${this.store.root}/changes`; }
  /** 解析项目内提案文件路径。 */
  private file(id: string): string { return `${this.root}/${knowledgeId(id)}/change.json`; }
  private summary(change: KnowledgeChange): KnowledgeChangeSummary {
    const { baseContent, content, sources, instructions, ...summary } = change;
    return summary;
  }
  /** 在项目知识根保存提案正文与列表摘要。 */
  private write(change: KnowledgeChange): void {
    const body = knowledgeJson(change);
    if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "修改建议及对比原文过大，请缩小文档范围", 400);
    this.store.files.write(this.file(change.id), body);
    this.store.files.write(`${this.root}/${change.id}/summary.json`, knowledgeJson(this.summary(change)));
  }
  private read(id: string): KnowledgeChange {
    const data = this.store.files.json<KnowledgeChange>(this.file(id));
    if (data.schemaVersion !== 1 || data.id !== id || !["pending", "approved", "rejected"].includes(data.status)
      || typeof data.content !== "string" || typeof data.baseContent !== "string" || !Array.isArray(data.sources)) {
      throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", "知识修改建议文件无效");
    }
    knowledgeId(data.nodeId);
    return data;
  }
  /** 读取项目提案摘要并按节点范围分页，不加载正文。 */
  list(offset = 0, filter: { nodeId?: string; status?: string } = {}): { items: KnowledgeChangeSummary[]; nextOffset: number | null; pendingNodes: KnowledgePendingChangeNode[] } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "分页位置无效", 400);
    if (filter.status && !["all", "pending", "approved", "rejected"].includes(filter.status)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "审批状态无效", 400);
    // 清单只读小摘要，正文与来源留到打开审批项时再读取。
    const all = this.store.files.directories(this.root).map(id => this.store.files.json<KnowledgeChangeSummary>(`${this.root}/${knowledgeId(id)}/summary.json`))
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    // 树索引覆盖全部待审批项，列表仍分页；Web 无须拉齐历史提案或正文来构造目录。
    const pending = new Map<string, KnowledgePendingChangeNode>();
    for (const item of all) if (item.status === "pending") {
      const previous = pending.get(item.nodeId);
      pending.set(item.nodeId, { nodeId: item.nodeId, title: item.title, count: (previous?.count ?? 0) + 1 });
    }
    let scope: Set<string> | null = null;
    if (filter.nodeId) {
      scope = new Set([knowledgeId(filter.nodeId)]);
      const children = new Map<string, string[]>();
      for (const node of this.store.readTree().tree.nodes) if (node.parentId) {
        const siblings = children.get(node.parentId) ?? [];
        siblings.push(node.id); children.set(node.parentId, siblings);
      }
      for (const id of scope) for (const child of children.get(id) ?? []) scope.add(child);
    }
    const items = all.filter(item => (!scope || scope.has(item.nodeId)) && (!filter.status || filter.status === "all" || item.status === filter.status));
    return { items: items.slice(offset, offset + 50),
      nextOffset: offset + 50 < items.length ? offset + 50 : null, pendingNodes: [...pending.values()] };
  }
  /** 核对当前版本、来源和分类；失效建议仍可查看和拒绝。 */
  detail(id: string): KnowledgeChangeDetail {
    const data = this.read(id);
    const reasons: string[] = [];
    let currentContent = "";
    try {
      const current = this.store.detail(data.nodeId);
      currentContent = current.current?.content ?? "";
      if (this.store.category(data.nodeId) === "product") reasons.push("产品文档保留原文，不接受 AI 修改建议");
      if (data.status === "pending" && current.currentHash !== data.baseHash) reasons.push("正式文档已变化");
      if (this.store.ancestry(data.nodeId).some(node => node.archived)) reasons.push("知识已归档");
      if (this.store.effectiveInstructions(data.nodeId) !== data.instructions) reasons.push("项目或目录要求已变化");
      this.store.parseSources(data.sources, true);
    } catch (error) { reasons.push(error instanceof Error ? error.message : "来源核验失败"); }
    return { ...data, hash: knowledgeHash(this.store.files.read(this.file(id))), currentContent, stale: reasons.length > 0, staleReasons: reasons };
  }
  /** 只为允许 AI 修订的资产保存建议，分类检查与提案写入共用项目锁。 */
  submit(raw: unknown, context: { threadId: string; turnId: string; origin: KnowledgeChange["origin"] }): KnowledgeChangeDetail {
    const input = knowledgeRecord(raw);
    const nodeId = knowledgeId(input.nodeId);
    const expectedHash = input.expectedHash === null ? null : knowledgeText(input.expectedHash, 64, true);
    if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "缺少当前版本指纹", 400);
    // 同一回合对同一节点补充内容更新同一提案，不制造多条待审批。
    const id = `change_${knowledgeHash(`${context.threadId}:${context.turnId}:${nodeId}`).slice(0, 32)}`;
    this.store.files.mutate(() => {
      const current = this.store.detail(nodeId);
      if (this.store.category(nodeId) === "product") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "产品文档保留原文，不接受 AI 修改建议", 403);
      if (current.currentHash !== expectedHash) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "正式文档已变化，请重新读取后提交修改建议");
      if (this.store.ancestry(nodeId).some(node => node.archived)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "归档知识不能提交修改建议");
      const previous = this.store.files.exists(this.file(id)) ? this.read(id) : null;
      if (previous && previous.status !== "pending") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "本轮提案已审核，请在新的回合中提交");
      const sources = this.store.parseSources(input.sources, true);
      if (!sources.length) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "修改建议必须包含直接来源", 400);
      const now = new Date().toISOString();
      const change: KnowledgeChange = {
        schemaVersion: 1, id, nodeId, title: current.node.title, summary: knowledgeText(input.summary, 4000, true),
        createdAt: previous?.createdAt ?? now, updatedAt: now, status: "pending", origin: context.origin,
        baseHash: expectedHash, baseContent: current.current?.content ?? "", content: knowledgeText(input.content, 1_000_000, true),
        sources, instructions: current.effectiveInstructions, reviewedAt: null, reviewedBy: null, reviewNote: "", revisionId: null,
      };
      this.write(change);
    });
    return this.detail(id);
  }
  review(input: { id: string; expectedHash: string; decision: "approve" | "reject"; note: string; userId: string }): KnowledgeChangeDetail {
    const reviewNote = knowledgeText(input.note, 4000);
    const initial = this.detail(input.id);
    const assertPending = () => {
      const current = this.detail(input.id);
      if (current.hash !== input.expectedHash || current.status !== "pending") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "修改建议已变化或已被审核，请刷新");
      if (input.decision === "approve" && current.stale) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", `请重新核对后提交：${current.staleReasons.join("；")}`);
    };
    const recordDecision = (revisionId: string | null) => this.write({
      ...this.read(input.id),
      status: input.decision === "approve" ? "approved" : "rejected", reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), reviewedBy: input.userId, reviewNote, revisionId,
    });
    if (input.decision === "reject") {
      this.store.files.mutate(() => { assertPending(); recordDecision(null); });
    } else {
      this.store.saveDocument({
        nodeId: initial.nodeId, content: initial.content, sources: initial.sources, expectedHash: initial.baseHash,
        origin: "ai", summary: initial.summary, instructions: initial.instructions, runId: initial.id, adopt: true,
        beforeSave: assertPending, afterSave: revision => recordDecision(revision.id),
      });
    }
    return this.detail(input.id);
  }
}
