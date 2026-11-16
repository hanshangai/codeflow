import type { KnowledgeAssetAction } from "./types/knowledgeAssets.js";

type Shape = "string" | "number" | "boolean" | { fields: Record<string, Shape>; optional?: string[] } | { array: Shape } | { nullable: Shape } | { oneOf: Shape[] };
const nullable = (shape: Shape): Shape => ({ nullable: shape });
const array = (shape: Shape): Shape => ({ array: shape });
const oneOf = (...shapes: Shape[]): Shape => ({ oneOf: shapes });
const object = (fields: Record<string, Shape>, optional?: string[]): Shape => ({ fields, optional });
const error = nullable(object({ code: "string", message: "string" }));
const node = object({ id: "string", parentId: nullable("string"), title: "string", orderKey: "string", summary: "string", tags: array("string"), instructions: "string", sourceScope: array("string"), archived: "boolean", contentMode: "string", category: "string", appliesTo: array("string"), reference: object({ path: "string", adoptedContentHash: "string" }) }, ["archived", "contentMode", "reference", "category", "appliesTo"]);
const tree = object({ schemaVersion: "number", instructions: "string", nodes: array(node) });
const revision = object({ schemaVersion: "number", id: "string", nodeId: "string", createdAt: "string", origin: "string", instructions: "string", summary: "string", baseHash: nullable("string"), contentHash: "string", sourcesHash: "string", runId: nullable("string") });
const source = object({ kind: "string", path: "string", symbol: "string", startLine: "number", endLine: "number", contentHash: "string", requirement: "string", relation: "string" }, ["path", "symbol", "startLine", "endLine", "contentHash", "requirement"]);
const reviewConfig = object({ enabled: "boolean", model: nullable("string"), effort: nullable("string"), autoRepair: "boolean", maxRounds: "number" }, ["autoRepair", "maxRounds"]);
const reviewIssue = object({ id: "string", severity: "string", category: "string", title: "string", detail: "string", documentStartLine: "number", documentEndLine: "number", sources: array(source), suggestion: "string" });
const reviewReport = object({ schemaVersion: "number", id: "string", nodeId: "string", revisionId: "string", runId: "string", createdAt: "string", contentHash: "string", sourcesHash: "string", instructionsHash: "string", sourceScopeHash: "string", sourceHashes: array(object({ path: "string", contentHash: nullable("string") })), engine: "string", model: nullable("string"), effort: nullable("string"), outcome: "string", summary: "string", issues: array(reviewIssue), sources: array(source), stale: "boolean", staleReasons: array("string") });
const sourceFile = object({ path: "string", contentHash: "string", startLine: "number", endLine: "number", totalLines: "number", content: "string" });
const sourceDirectory = object({ kind: "string", path: "string", entries: array(object({ path: "string", directory: "boolean" })), nextOffset: nullable("number"), nextAction: "string" });
const itemReview = object({ status: "string", reportId: nullable("string"), executionThreadId: nullable("string"), round: "number", maxRounds: "number", error, stale: "boolean", staleReasons: array("string") }, ["executionThreadId", "round", "maxRounds", "stale", "staleReasons"]);
const document = object({ revision, content: "string", sources: array(source), path: "string" });
const changeFields: Record<string, Shape> = { schemaVersion: "number", id: "string", nodeId: "string", title: "string", summary: "string", createdAt: "string", updatedAt: "string", status: "string", origin: "string", baseHash: nullable("string"), reviewedAt: nullable("string"), reviewedBy: nullable("string"), reviewNote: "string", revisionId: nullable("string") };
const change = object({ ...changeFields, baseContent: "string", content: "string", sources: array(source), instructions: "string", hash: "string", currentContent: "string", stale: "boolean", staleReasons: array("string") });
const detail = object({ node, current: nullable(document), currentHash: nullable("string"), drafts: array(revision), effectiveInstructions: "string", freshness: array(object({ path: "string", state: "string", message: "string" }, ["message"])), reference: object({ path: "string", content: "string", contentHash: "string", readAt: "number", state: "string" }) }, ["reference"]);
const snapshot = object({ initialized: "boolean", knowledgeId: nullable("string"), root: "string", tree, treeHash: nullable("string"), canWrite: "boolean", states: array(object({ nodeId: "string", revisionId: nullable("string"), draftCount: "number", error })) });
const conversation = object({ threadId: "string", createdByUserId: "string", title: "string", nodeId: nullable("string"), engine: "string", model: nullable("string"), effort: nullable("string"), active: "boolean", createdAt: "number", updatedAt: "number" });
const runItem = object({ id: "string", nodeId: "string", title: "string", expectedHash: nullable("string"), instructions: "string", inheritedInstructions: "string", executionConfig: object({ model: nullable("string"), effort: nullable("string") }), executionThreadId: nullable("string"), repairRevisionId: "string", repairReportId: "string", reviewConfig, review: itemReview, status: "string", revisionId: nullable("string"), error }, ["executionThreadId", "executionConfig", "reviewConfig", "repairRevisionId", "repairReportId", "review"]);
const selectionFields: Record<string, Shape> = { nodeId: "string", revisionId: nullable("string") };
const selection = object(selectionFields);
// 公开恢复所需的确认清单与处理结果，内部目标树只保留在 Client。
const buildFields: Record<string, Shape> = {
  baseTree: tree,
  changePaths: array("string"),
  planningDecisions: array(object({ nodeId: "string", question: "string", whyGenerate: "string", sources: array(source) })),
  adoptions: array(object({ requestId: "string", treeHash: nullable("string"), planHash: "string", completed: "boolean", selections: array(selection), appliedNodeIds: array("string"), writtenNodeIds: array("string"), cancelled: "boolean", cancelledAt: "number", cancelledBy: "string", error }, ["appliedNodeIds", "writtenNodeIds", "cancelled", "cancelledAt", "cancelledBy"])),
  dismissals: array(object({ nodeId: "string", revisionId: nullable("string"), userId: "string", createdAt: "number" })),
};
const run = object({ schemaVersion: "number", id: "string", createdAt: "string", mode: "string", nodeId: nullable("string"), prompt: "string", engine: "string", threadId: nullable("string"), ownerThreadId: "string", selectedNodeIds: array("string"), includeDescendants: "boolean", strategy: "string", model: nullable("string"), effort: nullable("string"), concurrency: "number", reviewConfig, repairReports: array(object({ nodeId: "string", reportId: "string" })), treeHash: nullable("string"), proposedTree: nullable(tree), appliedTreeHash: nullable("string"), rationale: "string", gaps: array("string"), phase: "string", error, active: "boolean", activeItemId: nullable("string"), activeItemIds: array("string"), activeStage: nullable("string"), activeItemStages: array(object({ itemId: "string", stage: "string" })), scheduler: object({ limit: "number", running: "number", queued: "number" }), items: array(runItem), ...buildFields }, ["threadId", "appliedTreeHash", "ownerThreadId", "selectedNodeIds", "includeDescendants", "strategy", "concurrency", "activeItemIds", "activeStage", "activeItemStages", "reviewConfig", "repairReports", "scheduler", ...Object.keys(buildFields)]);
const preview = object({ runId: "string", tree, treeHash: nullable("string"), planHash: "string", items: array(object({ ...selectionFields, canApply: "boolean", reason: nullable("string"), applied: "boolean", dismissed: "boolean" }, ["dismissed"])) });
const updateSchedule = object({ schemaVersion: "number", id: "string", enabled: "boolean", cronExpr: "string", timezone: "string", executorClientId: "string", selectedWorkspaceId: "string", updatedAt: "number", selectedNodeIds: array("string"), includeDescendants: "boolean", engine: "string", model: nullable("string"), effort: nullable("string"), concurrency: "number", prompt: "string", reviewConfig });
const updateView = object({ schedule: nullable(updateSchedule), hash: nullable("string"), currentClientId: "string", nextRunAt: nullable("number"), lastCheck: nullable(object({ scheduledAt: "number", checkedAt: "number", outcome: "string", runId: nullable("string"), selectedCount: "number", deferredCount: "number", error })), run: nullable(run), defaultTimezone: "string" });
const responses: Record<KnowledgeAssetAction, Shape> = {
  "update.schedule": updateView, "update.save": updateView, "update.run": updateView,
  changes: object({ items: array(object(changeFields)), nextOffset: nullable("number"), pendingNodes: array(object({ nodeId: "string", title: "string", count: "number" })) }), change, "change.review": change,
  snapshot, node: detail, revision: document, reviews: array(reviewReport),
  search: object({ backend: "string", vectorBackend: "string", items: array(object({ nodeId: "string", title: "string", excerpt: "string", path: nullable("string"), keywordScore: "number", vectorScore: "number", score: "number", matchMode: "string", contentHash: "string", readAt: "number", chunkId: "string", heading: "string", startLine: "number", endLine: "number" }, ["contentHash", "readAt", "chunkId", "heading", "startLine", "endLine"])), issues: array(object({ nodeId: "string", code: "string", message: "string" })) }),
  runs: array(run), run, "run.preview": preview,
  imports: object({ files: array(object({ path: "string", title: "string", contentHash: "string" })), directories: array("string"), nextOffset: nullable("number") }),
  source: oneOf(sourceFile, sourceDirectory),
  "tree.save": snapshot, "document.save": revision, "revision.adopt": detail, "revision.adopt.batch": snapshot, "revision.dismiss": run, import: snapshot,
  generate: run, "run.apply": run, "run.cancelAdoption": run, "run.start": run, "run.stop": run,
  "conversation.list": array(conversation), "conversation.create": conversation, "conversation.connect": conversation, "conversation.end": conversation,
};

/** 严格投影知识文件 API，私有 Client 字段不会经嵌套对象透传。 */
export function projectKnowledgeAssetResponse(action: string, value: unknown): Record<string, unknown> | null {
  const shape = responses[action as KnowledgeAssetAction];
  if (!shape || !value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) return null;
  try { return { ok: true, data: project(shape, (value as { data?: unknown }).data) }; }
  catch { return null; }
}
function project(shape: Shape, value: unknown): unknown {
  if (typeof shape === "string") {
    if (typeof value !== shape || (typeof value === "number" && !Number.isFinite(value))) throw new Error("invalid primitive");
    return value;
  }
  if ("oneOf" in shape) {
    for (const candidate of shape.oneOf) {
      try { return project(candidate, value); } catch { /* 尝试下一个公开响应形状。 */ }
    }
    throw new Error("invalid union");
  }
  if ("nullable" in shape) return value === null ? null : project(shape.nullable, value);
  if ("array" in shape) {
    if (!Array.isArray(value) || value.length > 20_000) throw new Error("invalid array");
    return value.map(v => project(shape.array, v));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
  const source = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape.fields)) {
    if (source[key] === undefined && shape.optional?.includes(key)) continue;
    result[key] = project(child, source[key]);
  }
  return result;
}

const fields: Record<KnowledgeAssetAction, string[]> = {
  "update.schedule": [], "update.save": ["schedule", "expectedHash"], "update.run": [],
  changes: ["offset", "nodeId", "status"], change: ["changeId"], "change.review": ["changeId", "expectedHash", "decision", "note"],
  snapshot: ["includeStates"], node: ["nodeId", "runId"], revision: ["nodeId", "revisionId", "runId"], reviews: ["nodeId", "runId"], search: ["query", "nodeId", "includeDrafts"], runs: [], run: ["runId"], "run.preview": ["runId"],
  imports: ["directory", "offset"], source: ["path", "startLine", "count"],
  "tree.save": ["tree", "expectedHash"], "document.save": ["nodeId", "content", "sources", "expectedHash", "summary"],
  "revision.adopt": ["nodeId", "revisionId", "expectedHash"], "revision.adopt.batch": ["nodeIds"], "revision.dismiss": ["runId", "nodeId", "revisionId", "planHash"], import: ["path", "contentHash", "parentId", "treeHash", "category", "appliesTo"],
  generate: ["requestId", "mode", "ownerThreadId", "selectedNodeIds", "includeDescendants", "strategy", "prompt", "treeHash", "engine", "model", "effort", "concurrency", "reviewConfig", "repairReports"],
  "run.apply": ["runId", "requestId", "treeHash", "planHash", "selections"], "run.cancelAdoption": ["runId", "requestId"], "run.start": ["runId", "retryFailed", "nodeIds", "prompt", "model", "effort", "concurrency", "reviewConfig"], "run.stop": ["runId"],
  "conversation.list": [], "conversation.create": ["nodeId", "engine", "title", "model", "effort"], "conversation.connect": ["threadId"], "conversation.end": ["threadId"],
};
/** 只接受公开动作字段；统一采用的确认清单必须完整且逐项指明版本。 */
export function parseKnowledgeAssetRequest(action: KnowledgeAssetAction, value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["workspaceId", ...fields[action]]);
  if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.workspaceId !== "string" || !body.workspaceId.trim() || body.workspaceId.length > 200) return null;
  if (action === "snapshot" && body.includeStates !== undefined) {
    if (body.includeStates === "true") body.includeStates = true;
    else if (body.includeStates === "false") body.includeStates = false;
    else if (typeof body.includeStates !== "boolean") return null;
  }
  if (action === "search" && body.includeDrafts !== undefined) {
    if (body.includeDrafts === "true") body.includeDrafts = true;
    else if (body.includeDrafts === "false") body.includeDrafts = false;
    else if (typeof body.includeDrafts !== "boolean") return null;
  }
  if (action === "revision.adopt.batch") {
    if (!Array.isArray(body.nodeIds) || body.nodeIds.length < 1 || body.nodeIds.length > 500 || body.nodeIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200)) return null;
  }
  if (action === "import") {
    if (body.category !== undefined && !["specifications", "architecture", "product"].includes(body.category as string)) return null;
    if (body.appliesTo !== undefined && (!Array.isArray(body.appliesTo) || body.appliesTo.length > 100 || body.appliesTo.some(path => typeof path !== "string" || !path || path.length > 1000))) return null;
  }
  if (action === "run.cancelAdoption" && (typeof body.runId !== "string" || !body.runId.trim() || typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 200)) return null;
  if (action === "revision.dismiss") {
    if (typeof body.runId !== "string" || !body.runId.trim() || typeof body.nodeId !== "string" || !body.nodeId.trim()
      || (body.revisionId !== null && (typeof body.revisionId !== "string" || !body.revisionId.trim()))
      || (body.planHash !== undefined && (typeof body.planHash !== "string" || !/^[a-f0-9]{64}$/.test(body.planHash))) || (body.revisionId === null && body.planHash === undefined)) return null;
  }
  if (action === "run.apply" && ["requestId", "treeHash", "planHash", "selections"].some(key => body[key] !== undefined)) {
    if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 200 || typeof body.planHash !== "string" || !/^[a-f0-9]{64}$/.test(body.planHash)
      || (body.treeHash !== null && (typeof body.treeHash !== "string" || !/^[a-f0-9]{64}$/.test(body.treeHash))) || !Array.isArray(body.selections) || !body.selections.length || body.selections.length > 20_000) return null;
    const nodeIds = new Set<string>();
    for (const value of body.selections) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some(key => key !== "nodeId" && key !== "revisionId") || typeof item.nodeId !== "string" || !item.nodeId.trim() || item.nodeId.length > 100
        || (item.revisionId !== null && (typeof item.revisionId !== "string" || !item.revisionId.trim() || item.revisionId.length > 100)) || nodeIds.has(item.nodeId)) return null;
      nodeIds.add(item.nodeId);
    }
  }
  return { ...body, workspaceId: body.workspaceId.trim() };
}
