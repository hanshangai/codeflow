import crypto from "node:crypto";

import { normalizeTaskIntakeTitle, type ProposalId, type WorkflowProposal, type WorkflowProposalSummary, type WorkspaceId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import { readIntakeWorkspaceScope } from "./orchIntakeRepo.js";

export class OrchProposalScopeError extends Error {
  /** 固定诊断只保留原列身份，冻结正文不得进入错误链。 */
  constructor(readonly details: { proposalId: string; workspaceId: string; intakeId: string; field: string; reason: string }, readonly code = "ORCH_PROPOSAL_SCOPE_INVALID") {
    super(code);
    this.name = "OrchProposalScopeError";
  }
}

/** 编排提案仓储。 */
export class OrchProposalRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 在 SQL 中先过滤可信可见需求，再按稳定复合游标返回摘要；不读取完整快照。 */
  listSummaryPage(workspaceId: WorkspaceId, input: { limit: number; cursor?: string; allowedResourceIds?: string[] | null; allowedProposalIds?: string[] | null }): {
    proposals: WorkflowProposalSummary[]; hasMore: boolean; nextCursor: string | null;
  } {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new Error("invalid proposal page limit");
    let cursor: [number, string] | null = null;
    if (input.cursor) {
      const parsed: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0
        || typeof parsed[1] !== "string" || !parsed[1]) throw new Error("invalid proposal page cursor");
      cursor = parsed as [number, string];
    }
    const conditions = ["workspace_id = ?"];
    const params: unknown[] = [String(workspaceId)];
    if (input.allowedProposalIds) {
      conditions.push("id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(input.allowedProposalIds));
    }
    if (input.allowedResourceIds) {
      conditions.push("intake_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(input.allowedResourceIds));
    }
    if (cursor) {
      conditions.push("(updated_at, id) < (?, ?)");
      params.push(cursor[0], cursor[1]);
    }
    const rows = this.db.prepare(`SELECT id, workspace_id, intake_id, status, created_at, updated_at,
      json_extract(proposal_json, '$.draftWorkflow.id') AS workflow_id,
      json_extract(proposal_json, '$.draftWorkflow.name') AS workflow_name
      FROM orch_proposals WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params, input.limit + 1) as Array<{
        id: ProposalId; workspace_id: WorkspaceId; intake_id: WorkflowProposal["intakeId"];
        status: WorkflowProposal["status"]; created_at: number; updated_at: number;
        workflow_id: WorkflowProposal["draftWorkflow"]["id"]; workflow_name: string;
      }>;
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      proposals: page.map(row => ({ id: row.id, workspaceId: row.workspace_id, intakeId: row.intake_id,
        status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        draftWorkflow: { id: row.workflow_id, name: row.workflow_name } })),
      hasMore,
      nextCursor: hasMore && last ? JSON.stringify([Number(last.updated_at), last.id]) : null,
    };
  }

  /** 旧调用及内部执行读取完整快照，分页列表不使用此入口。 */
  listByWorkspace(workspaceId: WorkspaceId, options?: { strictScope?: boolean }): WorkflowProposal[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, intake_id, proposal_json, created_at, updated_at
         FROM orch_proposals WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(row => rowToProposal(row, options?.strictScope));
  }

  /** 本机准入严格核对冻结需求与原列身份；remote 保留既有读取口径。 */
  get(id: ProposalId, options?: { strictScope?: boolean }): WorkflowProposal | null {
    const row = this.db
      .prepare("SELECT id, workspace_id, intake_id, proposal_json, created_at, updated_at FROM orch_proposals WHERE id = ?")
      .get(String(id)) as any | undefined;
    if (!row) return null;
    return rowToProposal(row, options?.strictScope);
  }

  create(input: Omit<WorkflowProposal, "id" | "createdAt" | "updatedAt">): WorkflowProposal {
    const id = crypto.randomUUID() as ProposalId;
    const now = Date.now();
    const proposal: WorkflowProposal = {
      ...input,
      intakeSnapshot: {
        ...input.intakeSnapshot,
        title: normalizeTaskIntakeTitle(input.intakeSnapshot.title, input.intakeSnapshot.goal),
      },
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO orch_proposals (id, workspace_id, intake_id, status, proposal_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(proposal.workspaceId),
        String(proposal.intakeId),
        String(proposal.status),
        JSON.stringify(proposal),
        now,
        now,
      );

    return proposal;
  }

  update(proposal: WorkflowProposal): WorkflowProposal {
    const next: WorkflowProposal = { ...proposal, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE orch_proposals
         SET status = ?, proposal_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(String(next.status), JSON.stringify(next), next.updatedAt, String(next.id));
    return next;
  }

  confirm(id: ProposalId): WorkflowProposal | null {
    const current = this.get(id);
    if (!current) return null;
    return this.update({ ...current, status: "confirmed", confirmedAt: Date.now() });
  }

  delete(id: ProposalId): void {
    this.db.prepare("DELETE FROM orch_proposals WHERE id = ?").run(String(id));
  }

  deleteByIntake(intakeId: WorkflowProposal["intakeId"]): number {
    const result = this.db.prepare("DELETE FROM orch_proposals WHERE intake_id = ?").run(String(intakeId));
    return Number(result.changes ?? 0);
  }
}

function rowToProposal(row: any, strictScope = false): WorkflowProposal {
  const parsed = strictScope ? readStrictProposal(row) : safeParseJson<WorkflowProposal | null>(row.proposal_json, null);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      intakeSnapshot: {
        ...parsed.intakeSnapshot,
        title: normalizeTaskIntakeTitle(parsed.intakeSnapshot?.title, parsed.intakeSnapshot?.goal),
      },
      id: row.id as ProposalId,
      createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
    };
  }
  throw new Error(`无效的 proposal 记录：${String(row?.id ?? "")}`);
}

/** 只在原提案边界解析冻结范围，禁止按 live intake 或缺省共享标记猜测。 */
function readStrictProposal(row: any): WorkflowProposal {
  /** 固定字段和原因区分损坏类型，实体只来自可信原列。 */
  const failure = (field: string, reason: string) => new OrchProposalScopeError({ proposalId: String(row.id), workspaceId: String(row.workspace_id), intakeId: String(row.intake_id), field, reason });
  let value: any;
  try { value = JSON.parse(row.proposal_json); } catch { throw failure("proposal_json", "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("proposal_json", "expected_object");
  if ([row.id, row.workspace_id, row.intake_id].some(id => typeof id !== "string" || !id || id.trim() !== id)
    || value.id !== row.id || value.workspaceId !== row.workspace_id || value.intakeId !== row.intake_id) throw failure("proposal_json", "proposal_identity_mismatch");
  if (!value.intakeSnapshot || typeof value.intakeSnapshot !== "object" || Array.isArray(value.intakeSnapshot)
    || value.intakeSnapshot.id !== row.intake_id || value.intakeSnapshot.workspaceId !== row.workspace_id) throw failure("proposal_json.intakeSnapshot", "intake_identity_mismatch");
  let scope;
  try { scope = readIntakeWorkspaceScope(value.intakeSnapshot.workspaceScope, row.workspace_id); } catch { throw failure("proposal_json.intakeSnapshot.workspaceScope", "invalid_workspace_scope"); }
  const sharedContext = value.intakeSnapshot.sharedContext;
  if (sharedContext != null && (typeof sharedContext !== "object" || Array.isArray(sharedContext)
    || typeof sharedContext.sharedWorkspaceId !== "string" || !sharedContext.sharedWorkspaceId || sharedContext.sharedWorkspaceId.trim() !== sharedContext.sharedWorkspaceId)) {
    throw failure("proposal_json.intakeSnapshot.sharedContext", "expected_shared_workspace_identity");
  }
  return { ...value, intakeSnapshot: { ...value.intakeSnapshot, workspaceScope: scope } };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

