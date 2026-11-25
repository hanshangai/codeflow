import crypto from "node:crypto";
import fs from "node:fs";
import {
  type KnowledgeAssetDocument,
  type KnowledgeAssetSource,
  type KnowledgeAssetTree,
  type KnowledgeReviewIssue,
  type KnowledgeReviewReport,
  type KnowledgeReviewReportView,
} from "@codeflowai/shared";
import {
  KnowledgeAssetError, knowledgeHash, knowledgeId, knowledgeJson, knowledgeRecord, knowledgeText,
} from "./knowledgeAssetFiles.js";
import { KnowledgeAssetStore } from "./knowledgeAssetStore.js";

const SHA = /^[a-f0-9]{64}$/;
type ReviewEvidence = (KnowledgeAssetSource & { kind: "code" | "document"; path: string; contentHash: string; startLine: number; endLine: number })
  | (KnowledgeAssetSource & { kind: "requirement"; requirement: string });

/** 用户要求逐字匹配，文件证据则必须覆盖被引用的同版本行段。 */
function containsEvidence(read: ReviewEvidence, cited: ReviewEvidence): boolean {
  if (read.kind === "requirement" || cited.kind === "requirement") return read.kind === cited.kind && read.requirement === cited.requirement;
  return read.path === cited.path && read.contentHash === cited.contentHash && read.startLine <= cited.startLine && read.endLine >= cited.endLine;
}

export type KnowledgeReviewSnapshot = {
  nodeId: string;
  revisionId: string;
  document: KnowledgeAssetDocument;
  effectiveInstructions: string;
  requirementTexts: string[];
  sourceScope: string[];
  instructionsHash: string;
  sourceScopeHash: string;
  sourceHashes: Array<{ path: string; contentHash: string | null }>;
  targetRevisionId: string | null;
};

export type KnowledgeReviewSubmission = {
  runId: string;
  engine: "codex" | "claude";
  model: string | null;
  effort: string | null;
  outcome: "passed" | "passed_with_warnings" | "issues";
  summary: string;
  issues: KnowledgeReviewIssue[];
  sources: KnowledgeAssetSource[];
};

function canonicalReviewOutcome(issues: KnowledgeReviewIssue[]): KnowledgeReviewReport["outcome"] {
  if (issues.some(issue => issue.severity === "error")) return "issues";
  if (issues.some(issue => issue.severity === "warning")) return "passed_with_warnings";
  return "passed";
}

/** 复检结果是项目文件，保存时校验事实快照；调用处理边界负责记录结构化错误。 */
export class KnowledgeReviewStore {
  constructor(readonly store: KnowledgeAssetStore) {}

  /** 绑定正文、生成来源及可追溯要求；来源过期时拒绝复检旧候选。 */
  snapshot(nodeId: string, revisionId: string): KnowledgeReviewSnapshot {
    const tree = this.store.readTree().tree;
    const ancestry = this.store.ancestry(nodeId, tree);
    const document = this.store.readRevision(nodeId, revisionId);
    const instructions = this.instructionsState(nodeId, document, tree);
    const scopes = ancestry.map(node => ({ nodeId: node.id, sourceScope: node.sourceScope }));
    const snapshot: KnowledgeReviewSnapshot = {
      nodeId, revisionId, document, ...instructions,
      sourceScope: [...new Set(scopes.flatMap(node => node.sourceScope))],
      sourceScopeHash: knowledgeHash(knowledgeJson(scopes)),
      targetRevisionId: this.targetRevisionId(nodeId),
      sourceHashes: [...new Set(document.sources.flatMap(source => source.path ? [source.path] : []))]
        .sort().map(sourcePath => ({ path: sourcePath, contentHash: this.sourceHash(sourcePath) })),
    };
    const currentSources = new Map(snapshot.sourceHashes.map(source => [source.path, source.contentHash]));
    for (const source of document.sources) {
      if (source.path && currentSources.get(source.path) !== source.contentHash) {
        throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SOURCE_CHANGED", `生成时引用的来源已变化：${source.path}；请更新候选并复检，单独复检不会更新旧版本来源`);
      }
    }
    this.assertSnapshot(snapshot);
    return snapshot;
  }

  /** 保存绑定版本的报告，要求证据与文件证据分别校验，不接受未核对的来源。 */
  save(snapshot: KnowledgeReviewSnapshot, input: KnowledgeReviewSubmission): KnowledgeReviewReport {
    return this.store.files.mutate(() => {
      this.assertSnapshot(snapshot);
      if (this.store.ancestry(snapshot.nodeId).some(node => node.archived)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "归档知识不能提交新的复检结果");
      if (input.outcome !== "passed" && input.outcome !== "passed_with_warnings" && input.outcome !== "issues") this.invalid("复检结论无效");
      if (input.engine !== "codex" && input.engine !== "claude") this.invalid("复检引擎无效");
      if (!Array.isArray(input.issues) || input.issues.length > 200) this.invalid("复检问题最多包含 200 项");
      const sources = this.parseEvidence(input.sources, snapshot);
      const totalLines = snapshot.document.content.split(/\r?\n/).length;
      const issues = input.issues.map((raw): KnowledgeReviewIssue => {
        const issue = knowledgeRecord(raw);
        if (issue.severity !== "error" && issue.severity !== "warning") this.invalid("复检问题严重度无效");
        if (!["factual", "coverage", "unsupported", "contradiction"].includes(String(issue.category))) this.invalid("复检问题分类无效");
        this.validateLines(issue.documentStartLine, issue.documentEndLine, totalLines, "问题必须定位到正文中存在的行");
        const evidence = this.parseEvidence(issue.sources, snapshot);
        for (const cited of evidence) {
          if (!sources.some(read => containsEvidence(read, cited))) {
            this.invalid("问题依据必须包含在本次核对的来源范围中");
          }
        }
        return {
          id: knowledgeId(issue.id),
          severity: issue.severity as KnowledgeReviewIssue["severity"],
          category: issue.category as KnowledgeReviewIssue["category"],
          documentStartLine: Number(issue.documentStartLine), documentEndLine: Number(issue.documentEndLine),
          title: knowledgeText(issue.title, 300, true), detail: knowledgeText(issue.detail, 8000, true),
          suggestion: knowledgeText(issue.suggestion, 8000, true), sources: evidence,
        };
      });
      if (new Set(issues.map(issue => issue.id)).size !== issues.length) this.invalid("复检问题标识不能重复");
      const outcome = canonicalReviewOutcome(issues);
      if (input.outcome !== outcome) this.invalid("复检结论与问题严重度不一致：只有 error 才能阻断，通过但有 warning 应使用 passed_with_warnings");
      // 一个指纹只能证明文件版本；是否真正阅读对应行由执行回合的工具读取台账另行验证。
      const report: KnowledgeReviewReport = {
        schemaVersion: 1, id: `review_${crypto.randomUUID()}`,
        nodeId: snapshot.nodeId, revisionId: snapshot.revisionId, createdAt: new Date().toISOString(),
        runId: knowledgeId(input.runId), engine: input.engine,
        model: input.model === null ? null : knowledgeText(input.model, 200, true),
        effort: input.effort === null ? null : knowledgeText(input.effort, 100, true),
        contentHash: snapshot.document.revision.contentHash, sourcesHash: snapshot.document.revision.sourcesHash,
        instructionsHash: snapshot.instructionsHash, sourceScopeHash: snapshot.sourceScopeHash,
        sourceHashes: snapshot.sourceHashes.map(source => ({ ...source })),
        outcome, summary: knowledgeText(input.summary, 8000, true), issues, sources,
      };
      // 验证提交载荷期间，外部编辑器也可能写入项目文件。
      this.assertSnapshot(snapshot);
      for (const source of sources) {
        if (source.kind === "requirement") continue;
        if (this.sourceHash(source.path) !== source.contentHash) {
          throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SOURCE_CHANGED", `复检期间来源已变化，请重新核对：${source.path}`);
        }
      }
      const body = knowledgeJson(report);
      if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) this.invalid("复检报告超过 4 MiB，请合并重复问题及证据");
      this.store.files.write(`${this.reviewRoot(snapshot.nodeId)}/${report.id}.json`, body);
      return report;
    });
  }

  /** 报告列表共用本次只读文件检查，保存报告仍独立重读并核验。 */
  list(nodeId: string): KnowledgeReviewReportView[] {
    return this.store.files.withReadCache(() => this.readReports(nodeId));
  }

  /** 同一确切版本只使用最新报告，不回退到更早的通过结论。 */
  latest(nodeId: string, revisionId: string): KnowledgeReviewReportView | null {
    return this.list(nodeId).find(report => report.revisionId === revisionId) ?? null;
  }

  /** 读取并验证全部报告；损坏或越界文件继续向调用边界显式报错。 */
  private readReports(nodeId: string): KnowledgeReviewReportView[] {
    this.store.node(nodeId);
    const root = this.reviewRoot(nodeId);
    if (!this.store.files.exists(root)) return [];
    return fs.readdirSync(this.store.files.resolve(root), { withFileTypes: true })
      .filter(file => file.isFile() && /^review_[a-zA-Z0-9_-]+\.json$/.test(file.name))
      .map(file => {
        const stored = this.store.files.json<KnowledgeReviewReport>(`${root}/${file.name}`);
        // 旧版本把“只有 warning”保存为 issues；读取时归一化，避免历史任务继续被错误地判定为阻断。
        const report = stored.outcome === "issues" && stored.issues.length > 0 && stored.issues.every(issue => issue.severity === "warning")
          ? { ...stored, outcome: "passed_with_warnings" as const } : stored;
        this.validateStoredReport(report, nodeId, file.name);
        return { ...report, ...this.freshness(report) };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** 复检报告与正文保存在同一配置目录中。 */
  private reviewRoot(nodeId: string): string { return `${this.store.root}/assets/${knowledgeId(nodeId)}/reviews`; }

  private targetRevisionId(nodeId: string): string | null {
    const detail = this.store.detail(nodeId);
    return detail.drafts[0]?.id ?? detail.current?.revision.id ?? null;
  }

  private sourceHash(sourcePath: string): string | null {
    try { return this.store.readSource(sourcePath, 1, 1).contentHash; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof KnowledgeAssetError && error.code === "KNOWLEDGE_ASSET_NOT_FOUND")) return null;
      throw error;
    }
  }

  /** 规格额外绑定正式要求与历史来源，保存和过期检查复用同一指纹口径。 */
  private instructionsState(nodeId: string, document: KnowledgeAssetDocument, tree: KnowledgeAssetTree): Pick<KnowledgeReviewSnapshot, "effectiveInstructions" | "requirementTexts" | "instructionsHash"> {
    const effectiveInstructions = this.store.effectiveInstructions(nodeId, tree);
    const requirementTexts: string[] = [];
    const specification = this.store.category(nodeId, tree) === "specifications";
    if (specification) {
      const adopted = new KnowledgeAssetStore(this.store.files.root, this.store.files), adoptedTree = adopted.readTree().tree;
      const ancestor = [...this.store.ancestry(nodeId, tree)].reverse().find(node => adoptedTree.nodes.some(current => current.id === node.id));
      requirementTexts.push(adoptedTree.instructions, ...(ancestor ? adopted.ancestry(ancestor.id, adoptedTree).map(node => node.instructions) : []));
      requirementTexts.push(...this.store.revisionRequirementTexts(document));
    }
    const texts = [...new Set(requirementTexts.filter(Boolean))]
      .filter((text, _, values) => !values.some(other => other !== text && other.includes(text))).sort();
    return { effectiveInstructions, requirementTexts: texts,
      instructionsHash: knowledgeHash(knowledgeJson([effectiveInstructions, document.revision.instructions, ...(specification ? [texts] : [])])) };
  }

  /** 提交前重读正文、配置与确认要求，拒绝复检期间漂移的证据。 */
  private assertSnapshot(snapshot: KnowledgeReviewSnapshot): void {
    const document = this.store.readRevision(snapshot.nodeId, snapshot.revisionId);
    const tree = this.store.readTree().tree;
    const scopes = this.store.ancestry(snapshot.nodeId, tree).map(node => ({ nodeId: node.id, sourceScope: node.sourceScope }));
    if (document.revision.contentHash !== snapshot.document.revision.contentHash
      || document.revision.sourcesHash !== snapshot.document.revision.sourcesHash
      || this.targetRevisionId(snapshot.nodeId) !== snapshot.targetRevisionId
      || this.instructionsState(snapshot.nodeId, document, tree).instructionsHash !== snapshot.instructionsHash
      || knowledgeHash(knowledgeJson(scopes)) !== snapshot.sourceScopeHash) {
      throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "复检期间文档或生成要求已变化，请重新复检");
    }
    for (const source of snapshot.sourceHashes) {
      if (this.sourceHash(source.path) !== source.contentHash) {
        throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SOURCE_CHANGED", `复检期间来源已变化，请重新核对：${source.path}`);
      }
    }
  }

  /** 规格可核对绑定版本的有效/生成要求；任意模型文本不能充当用户要求来源。 */
  requirementEvidence(snapshot: KnowledgeReviewSnapshot, value: unknown): ReviewEvidence & { kind: "requirement" } {
    const source = knowledgeRecord(value);
    const requirement = knowledgeText(source.requirement, 16000, true);
    if (this.store.category(snapshot.nodeId) !== "specifications"
      || !snapshot.requirementTexts.some(text => text.includes(requirement))) {
      this.invalid("规格要求证据必须逐字引用本版本可追溯的已采用要求或用户输入");
    }
    return { kind: "requirement", requirement, relation: knowledgeText(source.relation, 2000, true) };
  }

  /** 文件证据核对当前指纹与行段，规格要求核对冻结版本的要求原文。 */
  private parseEvidence(value: unknown, snapshot: KnowledgeReviewSnapshot): ReviewEvidence[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200) this.invalid("复检必须提供 1 至 200 项已核对来源");
    return value.map(raw => {
      const input = knowledgeRecord(raw);
      if (input.kind === "requirement") return this.requirementEvidence(snapshot, input);
      if (input.kind !== "code" && input.kind !== "document") this.invalid("复检依据必须是项目代码或文档");
      const relative = this.store.sourcePath(input.path);
      if (typeof input.contentHash !== "string" || !SHA.test(input.contentHash)) this.invalid("复检依据必须携带完整内容指纹");
      const source = this.store.readSource(relative, 1, 1);
      if (input.contentHash !== source.contentHash) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SOURCE_CHANGED", `复检依据已变化，请重新读取：${relative}`);
      this.validateLines(input.startLine, input.endLine, source.totalLines, "复检依据行号超出来源范围");
      return {
        kind: input.kind as "code" | "document", path: relative, contentHash: input.contentHash as string,
        startLine: Number(input.startLine), endLine: Number(input.endLine), relation: knowledgeText(input.relation, 2000, true),
      };
    });
  }

  private validateLines(startLine: unknown, endLine: unknown, totalLines: number, message: string): void {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || Number(startLine) < 1 || Number(endLine) < Number(startLine) || Number(endLine) > totalLines) this.invalid(message);
  }

  /** 读取时验证报告结构与问题证据包含关系，保留历史版本的要求原文。 */
  private validateStoredReport(report: KnowledgeReviewReport, nodeId: string, fileName: string): void {
    try {
      if (!report || report.schemaVersion !== 1 || report.nodeId !== nodeId || `${report.id}.json` !== fileName
        || !SHA.test(report.contentHash) || !SHA.test(report.sourcesHash) || !SHA.test(report.instructionsHash) || !SHA.test(report.sourceScopeHash)
        || !Array.isArray(report.sourceHashes) || report.sourceHashes.length > 200 || !Array.isArray(report.sources)
        || !Array.isArray(report.issues) || report.issues.length > 200
         || (report.outcome !== "passed" && report.outcome !== "passed_with_warnings" && report.outcome !== "issues")
        || (report.engine !== "codex" && report.engine !== "claude") || typeof report.createdAt !== "string" || !Number.isFinite(Date.parse(report.createdAt))) {
        this.invalid("复检报告身份或结论格式无效");
      }
      knowledgeId(report.id); knowledgeId(report.revisionId); knowledgeId(report.runId);
      knowledgeText(report.summary, 8000, true);
      if (report.model !== null) knowledgeText(report.model, 200, true);
      if (report.effort !== null) knowledgeText(report.effort, 100, true);
      for (const raw of report.sourceHashes) {
        const source = knowledgeRecord(raw);
        this.store.sourcePath(source.path);
        if (source.contentHash !== null && (typeof source.contentHash !== "string" || !SHA.test(source.contentHash))) this.invalid("复检报告来源指纹无效");
      }
      const evidence = (value: unknown): ReviewEvidence[] => {
        if (!Array.isArray(value) || value.length < 1 || value.length > 200) this.invalid("复检报告缺少有效证据");
        return value.map(raw => {
          const source = knowledgeRecord(raw);
          if (source.kind === "requirement") {
            return { kind: "requirement", requirement: knowledgeText(source.requirement, 16000, true), relation: knowledgeText(source.relation, 2000, true) };
          }
          this.store.sourcePath(source.path);
          if ((source.kind !== "code" && source.kind !== "document") || typeof source.contentHash !== "string" || !SHA.test(source.contentHash)) this.invalid("复检报告证据无效");
          this.validateLines(source.startLine, source.endLine, Number.MAX_SAFE_INTEGER, "复检报告证据行号无效");
          knowledgeText(source.relation, 2000, true);
          return source as ReviewEvidence;
        });
      };
      const sources = evidence(report.sources);
      for (const raw of report.issues) {
        const issue = knowledgeRecord(raw);
        knowledgeId(issue.id);
        if ((issue.severity !== "error" && issue.severity !== "warning") || !["factual", "coverage", "unsupported", "contradiction"].includes(String(issue.category))) this.invalid("复检报告问题类型无效");
        knowledgeText(issue.title, 300, true); knowledgeText(issue.detail, 8000, true); knowledgeText(issue.suggestion, 8000, true);
        this.validateLines(issue.documentStartLine, issue.documentEndLine, Number.MAX_SAFE_INTEGER, "复检报告正文位置无效");
        for (const cited of evidence(issue.sources)) {
          if (!sources.some(source => containsEvidence(source, cited))) this.invalid("复检报告问题依据不在核对范围内");
        }
      }
      if (new Set(report.issues.map(issue => issue.id)).size !== report.issues.length) this.invalid("复检报告问题标识重复");
      if (report.outcome !== canonicalReviewOutcome(report.issues)) this.invalid("复检报告结论与问题严重度不一致");
    } catch (error) {
      if (error instanceof KnowledgeAssetError) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", `复检报告格式无效：${fileName}；${error.message}`);
      throw error;
    }
  }

  /** 要求变化由版本快照判断，只有文件证据需要重新读取内容指纹。 */
  private freshness(report: KnowledgeReviewReport): { stale: boolean; staleReasons: string[] } {
    const reasons: string[] = [];
    if (this.store.files.exists(`${this.store.root}/runs/${report.runId}/plan.json`)) {
      const owner = this.store.readRun(report.runId);
      const item = owner.items.find(item => item.nodeId === report.nodeId && item.revisionId === report.revisionId);
      if (!item?.review || item.review.reportId !== report.id || item.review.status === "pending" || item.review.status === "failed" || item.review.error) reasons.push("复检执行未完成，请重试复检");
    }
    try {
      const target = this.targetRevisionId(report.nodeId);
      if (target !== report.revisionId) reasons.push("知识已有新的当前版本或待采用版本");
      const snapshot = this.snapshot(report.nodeId, report.revisionId);
      if (snapshot.document.revision.contentHash !== report.contentHash || snapshot.document.revision.sourcesHash !== report.sourcesHash) reasons.push("被复检文档或来源关联已变化");
      if (snapshot.instructionsHash !== report.instructionsHash) reasons.push("项目或目录的有效要求已变化");
      if (snapshot.sourceScopeHash !== report.sourceScopeHash) reasons.push("项目或目录的来源范围已变化");
    } catch (error) {
      if (error instanceof KnowledgeAssetError && error.code === "KNOWLEDGE_ASSET_SOURCE_CHANGED") reasons.push(error.message);
      else if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof KnowledgeAssetError && ["KNOWLEDGE_ASSET_CONFLICT", "KNOWLEDGE_ASSET_FILE_INVALID", "KNOWLEDGE_ASSET_PATH_INVALID"].includes(error.code))) reasons.push("被复检文档或证据文件缺失、被修改或无法读取");
      else throw error;
    }
    for (const source of [...report.sourceHashes, ...report.sources]) {
      if ("kind" in source && source.kind === "requirement") continue;
      try {
        if (this.sourceHash(source.path!) !== source.contentHash) reasons.push(`来源已变化：${source.path}`);
      } catch (error) {
        if (error instanceof KnowledgeAssetError && ["KNOWLEDGE_ASSET_FILE_INVALID", "KNOWLEDGE_ASSET_PATH_INVALID"].includes(error.code)) reasons.push(`来源已无法读取：${source.path}`);
        else throw error;
      }
    }
    const staleReasons = [...new Set(reasons)];
    return { stale: staleReasons.length > 0, staleReasons };
  }

  private invalid(message: string): never { throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", message, 400); }
}
