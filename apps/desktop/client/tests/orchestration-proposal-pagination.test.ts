import test from "node:test";
import assert from "node:assert/strict";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { OrchProposalRepo } from "../src/db/repos/orchProposalRepo.ts";
import { handleOrchProposalsList } from "../src/app/handlers/orchestrationHandlers.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import type { WorkflowProposal, WorkspaceId } from "@codeflowai/shared";

/** 使用真实 SQLite 和大快照验证 SQL 权限过滤、分页与摘要读取。 */
function harness() {
  const db = openSqliteDb(":memory:");
  db.exec(`CREATE TABLE orch_proposals (id TEXT PRIMARY KEY, workspace_id TEXT, intake_id TEXT, status TEXT, proposal_json TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE INDEX idx_orch_proposals_workspace ON orch_proposals(workspace_id, updated_at DESC)`);
  const repo = new OrchProposalRepo(db);
  const heavy = "大型快照".repeat(10_000);
  for (const [id, intake, at, workspace] of [
    ["z", "hidden", 10, "ws"], ["c", "visible", 9, "ws"], ["b", "visible", 9, "ws"],
    ["a", "visible", 8, "ws"], ["x", "visible", 11, "other"],
  ] as const) db.prepare("INSERT INTO orch_proposals VALUES (?, ?, ?, 'draft', ?, 1, ?)").run(id, workspace, intake,
    JSON.stringify({ id, workspaceId: workspace, intakeId: intake, status: "draft", intakeSnapshot: { title: heavy },
      draftWorkflow: { id: "wf", name: "流程", description: heavy, nodes: [] } }), at);
  return { db, repo };
}

test("proposal summaries filter permissions before paging and preserve equal-time boundaries", () => {
  const h = harness();
  try {
    const first = h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 1, allowedResourceIds: ["visible"] });
    assert.deepEqual(first.proposals.map(p => p.id), ["c"]);
    assert.equal(first.hasMore, true);
    const second = h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 1, cursor: first.nextCursor!, allowedResourceIds: ["visible"] });
    assert.deepEqual(second.proposals.map(p => p.id), ["b"]);
    const third = h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 1, cursor: second.nextCursor!, allowedResourceIds: ["visible"] });
    assert.deepEqual(third.proposals.map(p => p.id), ["a"]);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    assert.ok(JSON.stringify(first).length < 500);
    assert.equal("intakeSnapshot" in first.proposals[0]!, false);
    assert.equal("nodes" in first.proposals[0]!.draftWorkflow, false);
    assert.deepEqual(h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 10, allowedResourceIds: [] }).proposals, []);
    assert.equal(h.repo.listByWorkspace("ws" as WorkspaceId).length, 4);
    assert.ok(h.repo.get("c" as WorkflowProposal["id"])!.draftWorkflow.description.length > 10_000);
    assert.throws(() => h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 201 }), /limit/u);
    assert.throws(() => h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 1, cursor: "{}" }), /cursor/u);
  } finally { h.db.close(); }
});

test("proposal handler supports explicit summary pages and rejects invalid cursors", () => {
  const h = harness();
  const sent: any[] = [];
  const ctx = { db: { orchProposals: h.repo }, workspaces: new Map([["ws", "."]]), send: (message: unknown) => sent.push(message) } as unknown as ApiHandlerContext;
  try {
    for (const cursor of ["", "broken", "[-1,\"a\"]"]) {
      handleOrchProposalsList(ctx, { id: cursor || "first", body: { workspaceId: "ws", summaryOnly: true, limit: 1, cursor, allowedResourceIds: ["visible"] } } as ApiRequestMessage);
    }
    assert.equal(sent[0].body.proposals[0].id, "c");
    assert.equal(sent[0].body.hasMore, true);
    assert.equal(sent[1].status, 400);
    assert.equal(sent[2].status, 400);
  } finally { h.db.close(); }
});

test("proposal cursor pages seek the time range through the existing workspace index", (t) => {
  const h = harness();
  try {
    const prepare = h.db.prepare.bind(h.db);
    const plans: string[] = [];
    t.mock.method(h.db, "prepare", (sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, {
        /** 用实际仓储 SQL 和绑定参数检查执行计划，避免另写一份查询绕过回归。 */
        get(target, property) {
          if (property === "all") return (...params: unknown[]) => {
            plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String((row as any).detail)));
            return target.all(...params);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const page = h.repo.listSummaryPage("ws" as WorkspaceId, { limit: 2, cursor: '[9,"c"]', allowedResourceIds: ["visible"] });
    assert.deepEqual(page.proposals.map(p => p.id), ["b", "a"]);
    assert.match(plans.join("\n"), /USING INDEX idx_orch_proposals_workspace \(workspace_id=\? AND updated_at<\?\)/u);
  } finally { h.db.close(); }
});
