import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskIntake, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { readOrchIntakeListSnapshot } from "../src/db/orchIntakeListSnapshot.js";
import { isDesktopLocalAssetExecution, isDesktopLocalThreadAssetExecution } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { logger } from "../src/logger.js";

const workspaceId = "scope-device:project" as WorkspaceId;

/** 原仓储生成真实关系，只有 provider 与引擎副作用被测试边界替代。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-desktop-orch-scope-"));
  const rootDb = openClientDb({ dbPath: path.join(root, "client.db") });
  t.after(() => { rootDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  rootDb.workspaces.upsert({ id: workspaceId, title: "Scope", path: root });
  const db = rootDb.forWorkspace(workspaceId);
  const workflow = db.orchWorkflows.upsert({ id: "fixture-workflow" as any, workspaceId, name: "Scope flow", description: "Scope", version: 1, nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [] });
  const workspaces = new Map([[workspaceId, root]]);
  const sent: any[] = [];
  const effects: string[] = [];
  const ctx = { db, workspaces, clientId: "scope-device", localWorkspaceOnly: true, threads: new ThreadStore(),
    orchIntakeListReader: { async listIntakes(input: any) { return readOrchIntakeListSnapshot(db.forWorkspace(workspaceId).db, input); } },
    sessions: { beginThreadOperation() { return () => {}; }, async disposeThreadWithOptions(id: string) { effects.push(`dispose:${id}`); } },
    orchEngine: {
      /** 复用同一副作用记录，仅适配统一 API 的工作区装配边界。 */
      forWorkspace() { return this; },
      cancel(id: string) { effects.push(`cancel:${id}`); }, async cancelAndWait(id: string) { effects.push(`cancel:${id}`); },
    },
    send(message: unknown) { sent.push(message); },
  } as unknown as ApiHandlerContext;
  /** known-local live intake 可以合法承载其他归属的历史执行快照。 */
  function intake(id: string) {
    return db.orchIntakes.upsert({ id: id as any, workspaceId, title: id, goal: id, taskType: "feature", triggerMode: "manual", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  }
  /** 冻结归属来自原提案/实例，不能从 live intake 推断。 */
  function execution(item: TaskIntake, scope: "local" | "shared" | "unknown", status: "running" | "completed" = "completed") {
    const snapshot = { ...item, workspaceScope: scope === "unknown" ? null : scope === "local" ? { scopeType: "local_workspace", scopeId: workspaceId } : { scopeType: "shared_workspace", scopeId: "shared" } } as TaskIntake;
    const proposal = db.orchProposals.create({ workspaceId, intakeId: item.id, intakeSnapshot: snapshot, status: "confirmed", recommendedFamily: "feature-dev", rationale: "Scope", draftWorkflow: workflow, draftRoleBindings: [], draftKnowledgeBindings: [], warnings: [], requiresConfirmation: false });
    const instance = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, proposalId: proposal.id, intakeSnapshot: snapshot });
    db.orchInstances.updateStatus(instance.id, status);
    return { proposal, instance: db.orchInstances.get(instance.id)! };
  }
  /** 通过真实统一 API 捕获唯一响应。 */
  async function call(method: string, body: Record<string, unknown>) {
    const id = `scope-${sent.length}`;
    await handleApiRequest(ctx, { t: "api.req", id, method, body: { workspaceId, ...body } } as any);
    const response = sent.find(message => message.t === "api.res" && message.id === id);
    assert.ok(response);
    return response;
  }
  return { db, ctx, workspaces, workflow, intake, execution, call, effects };
}

/** 捕获真实工作区处理边界的错误，并校验诊断没有落入其他库。 */
function captureWorkspaceErrors(t: test.TestContext, db: ReturnType<typeof openClientDb>) {
  const logs: any[][] = [];
  t.mock.method(db, "writeWorkspaceLog", (...[loggedWorkspaceId, entry]: Parameters<typeof db.writeWorkspaceLog>) => {
    assert.equal(loggedWorkspaceId, workspaceId);
    if (entry.level === "error") logs.push([entry.tag, entry.message, entry.data]);
  });
  return logs;
}

test("desktop instance authority requires known local frozen intake scope", t => {
  const f = fixture(t);
  const item = f.intake("known-local");
  for (const scope of ["local", "shared", "unknown"] as const) {
    const { instance } = f.execution(item, scope);
    assert.equal(isDesktopLocalAssetExecution("scope-device", f.workspaces, instance), scope === "local");
  }
});

test("strict proposal and instance reads reject frozen JSON identity conflicts without exposing supplied identity", t => {
  const f = fixture(t);
  const item = f.intake("strict-intake");
  const { proposal, instance } = f.execution(item, "local");
  const secret = "PRIVATE_FROZEN_ID";
  f.db.db.prepare("UPDATE orch_proposals SET proposal_json = ? WHERE id = ?").run(JSON.stringify({ ...proposal, intakeSnapshot: { ...item, workspaceId: secret } }), proposal.id);
  assert.throws(() => f.db.orchProposals.get(proposal.id, { strictScope: true } as any), (error: any) => error.code === "ORCH_PROPOSAL_SCOPE_INVALID" && !JSON.stringify(error).includes(secret));
  f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...item, workspaceId: secret }), instance.id);
  assert.throws(() => f.db.orchInstances.get(instance.id, { strictScope: true } as any), (error: any) => error.code === "ORCH_INSTANCE_SCOPE_INVALID" && !JSON.stringify(error).includes(secret));
});

test("desktop lists and direct reads use each proposal and instance frozen scope before permission pagination", async t => {
  const f = fixture(t);
  const item = f.intake("mixed");
  const local = f.execution(item, "local");
  const shared = f.execution(item, "shared");
  const unknown = f.execution(item, "unknown");
  for (const entity of [shared, unknown]) {
    assert.equal((await f.call("orch.proposals.get", { proposalId: entity.proposal.id })).status, 404);
    assert.equal((await f.call("orch.instances.get", { instanceId: entity.instance.id })).status, 404);
    assert.equal((await f.call("orch.artifacts.list", { instanceId: entity.instance.id, includeContent: false })).status, 404);
  }
  const proposals = await f.call("orch.proposals.list", { summaryOnly: true, limit: 1, allowedResourceIds: [item.id] });
  assert.deepEqual(proposals.body.proposals.map((entry: any) => entry.id), [local.proposal.id]);
  assert.equal(proposals.body.hasMore, false);
  const instances = await f.call("orch.instances.list", { limit: 1, allowedResourceIds: [item.id] });
  assert.deepEqual(instances.body.instances.map((entry: any) => entry.id), [local.instance.id]);
  assert.deepEqual(instances.body.totalCountByIntake, { [item.id]: 1 });
  assert.equal(instances.body.hasMore, false);
  f.ctx.localWorkspaceOnly = false;
  assert.equal((await f.call("orch.instances.list", {})).body.instances.length, 3);
});

test("desktop intake metadata reranks visible mixed history and does not rewrite global state", async t => {
  const f = fixture(t);
  const item = f.intake("metadata");
  const local = f.execution(item, "local");
  f.execution(item, "shared", "running");
  f.execution(item, "unknown");
  const hiddenOnly = f.intake("hidden-only");
  f.execution(hiddenOnly, "shared", "running");
  const state = f.db.db.prepare("SELECT * FROM orch_intake_list_states ORDER BY intake_id").all();
  const result = await f.call("orch.intakes.list", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.listMetaById[item.id].latestInstance.id, local.instance.id);
  assert.equal(result.body.listMetaById[item.id].instanceCount, 1);
  assert.equal(result.body.listMetaById[item.id].listStatus, "completed");
  assert.equal(result.body.listMetaById[hiddenOnly.id].latestInstance, null);
  assert.equal(result.body.listMetaById[hiddenOnly.id].listStatus, "not-started");
  assert.equal(result.body.listMetaById[hiddenOnly.id].instanceCount, 0);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM orch_intake_list_states ORDER BY intake_id").all(), state);
});

test("live intake list and mutation use the same shared context authority", async t => {
  const f = fixture(t);
  const visible = f.intake("visible-live");
  const hidden = f.intake("protected-live");
  f.db.orchIntakes.upsert({ ...hidden, sharedContext: { sharedWorkspaceId: "shared" } } as TaskIntake);
  const before = f.db.db.prepare("SELECT total_changes() AS total").get();
  const page = await f.call("orch.intakes.list", { limit: 1 });
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.intakes.map((item: TaskIntake) => item.id), [visible.id]);
  assert.equal(page.body.totalCount, 1);
  assert.equal(page.body.hasMore, false);
  const searched = await f.call("orch.intakes.list", { search: hidden.title });
  assert.deepEqual(searched.body.intakes, []);
  assert.equal(searched.body.totalCount, 0);
  assert.equal((await f.call("orch.intakes.delete", { intakeId: hidden.id })).status, 404);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
});

test("desktop cascade refuses protected execution before cancel dispose or database deletion", async t => {
  const f = fixture(t);
  const item = f.intake("delete-protected");
  const protectedExecution = f.execution(item, "shared", "running");
  const result = await f.call("orch.intakes.delete", { intakeId: item.id, forceDeleteRunning: true });
  assert.equal(result.status, 409);
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(protectedExecution.instance.id));
  assert.deepEqual(f.effects, []);
  assert.ok(f.db.orchIntakes.get(item.id));
  assert.ok(f.db.orchInstances.get(protectedExecution.instance.id));
});

test("desktop RA sidebar intersects persisted authority and permissions without repairing or deleting history", async t => {
  const f = fixture(t);
  for (const [id, scope] of [["ra-local", "local_workspace"], ["ra-shared", "shared_workspace"], ["ra-unknown", null], ["ra-orphan", null]] as const) {
    if (id !== "ra-orphan") f.db.threads.create({ id: id as any, workspaceId, engine: "codex", title: "RA searchable", threadSubtype: "requirement-analysis" });
    f.db.orchRequirementAnalysisSessions.create({ id: id as any, workspaceId, title: "RA searchable", status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as any,
      workspaceScope: scope ? { scopeType: scope, scopeId: scope === "local_workspace" ? workspaceId : "shared" } : null });
  }
  f.db.db.prepare("DELETE FROM orch_requirement_analysis_search_fts WHERE session_id = 'ra-orphan'").run();
  const before = f.db.db.prepare("SELECT total_changes() AS total").get();
  const result = await f.call("orch.requirementAnalysis.sessions.list", { allowedResourceIds: ["ra-local", "ra-shared", "ra-unknown"], search: "RA", limit: 1 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sessions.map((item: any) => item.id), ["ra-local"]);
  assert.equal(result.body.totalCount, 1);
  assert.equal(result.body.hasMore, false);
  assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
  assert.ok(f.db.orchRequirementAnalysisSessions.get("ra-orphan" as any));
});

test("corrupt frozen resource produces one safe central error with database identity", async t => {
  const f = fixture(t);
  const item = f.intake("safe-error");
  const { proposal, instance } = f.execution(item, "local");
  const secret = "PRIVATE_INJECTED_IDENTITY";
  const logs = captureWorkspaceErrors(t, f.db);
  f.db.db.prepare("UPDATE orch_proposals SET proposal_json = ? WHERE id = ?").run(JSON.stringify({ ...proposal, id: secret }), proposal.id);
  const result = await f.call("orch.proposals.get", { proposalId: proposal.id });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "INTERNAL_ERROR");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].proposalId, proposal.id);
  assert.equal(logs[0][2].errorCode, "ORCH_PROPOSAL_SCOPE_INVALID");
  assert.equal(logs[0][2].reason, "proposal_identity_mismatch");
  assert.equal(logs[0][2].workspaceId, workspaceId);
  assert.equal(logs[0][2].intakeId, item.id);
  assert.doesNotMatch(JSON.stringify([result, logs]), new RegExp(secret));
  logs.length = 0;
  f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...item, workspaceId: secret }), instance.id);
  const failed = await f.call("orch.instances.get", { instanceId: instance.id });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INTERNAL_ERROR");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].instanceId, instance.id);
  assert.equal(logs[0][2].errorCode, "ORCH_INSTANCE_SCOPE_INVALID");
  assert.equal(logs[0][2].reason, "intake_identity_mismatch");
  assert.doesNotMatch(JSON.stringify([failed, logs]), new RegExp(secret));
});

test("node startup isolates only the corrupt bound parent and leaves unrelated good queue intact", t => {
  const f = fixture(t);
  const item = f.intake("node-recovery");
  const local = f.execution(item, "local");
  const bad = f.execution(item, "local");
  const queueItems: Record<string, string> = {};
  for (const [id, execution] of [["good-node", local], ["bad-node", bad]] as const) {
    f.db.threads.create({ id: id as any, workspaceId, engine: "codex", title: id, threadSubtype: "node", threadType: "orchestration" });
    f.db.orchInstances.updateNodeStates(execution.instance.id, { start: { ...execution.instance.nodeStates.start!, threadId: id as any } });
    queueItems[id] = f.db.threadMessageQueue.appendItem({ workspaceId, threadId: id as any, text: "Private queue", images: [], files: [],
      sendOptions: { workMode: "general", planMode: false, model: null, effort: null, accessMode: null, contextWindow: null, autoCompactPct: null, serviceTier: null }, originWebSessionId: null }).item.id;
  }
  f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...item, workspaceId: "PRIVATE_BAD_PARENT" }), bad.instance.id);
  assert.equal(isDesktopLocalThreadAssetExecution("scope-device", f.workspaces, f.db, "good-node" as any), true);
  const dispatcher = new ThreadQueueDispatcher(f.ctx);
  const logs = captureWorkspaceErrors(t, f.db);
  dispatcher.recoverOnStartup(id => { isDesktopLocalThreadAssetExecution("scope-device", f.workspaces, f.db, id); return false; });
  assert.equal(f.db.threadMessageQueue.getById(queueItems["good-node"]!)?.status, "pending");
  assert.equal(f.db.threadQueueStates.getState("good-node" as any).paused, false);
  assert.equal(f.db.threadMessageQueue.getById(queueItems["bad-node"]!)?.status, "failed");
  assert.equal(f.db.threadQueueStates.getState("bad-node" as any).paused, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].instanceId, bad.instance.id);
  assert.equal(logs[0][2].threadId, "bad-node");
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_BAD_PARENT/);
});

test("authority and intake metadata share frozen local scope and shared markers after each mutation", async t => {
  const f = fixture(t);
  const item = f.intake("mutating");
  const { instance } = f.execution(item, "local");
  for (const [snapshot, runtimeConfig, expected] of [
    [item, null, true],
    [{ ...item, workspaceScope: null }, null, false],
    [{ ...item, workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } }, null, false],
    [{ ...item, sharedContext: { sharedWorkspaceId: "shared" } }, null, false],
    [item, { executionProfileScope: { scopeType: "shared_workspace", scopeId: "shared" } }, false],
    [item, { executionProfileScope: { scopeType: "local_workspace", scopeId: workspaceId } }, true],
  ] as const) {
    f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ?, runtime_config_json = ? WHERE id = ?").run(JSON.stringify(snapshot), JSON.stringify(runtimeConfig), instance.id);
    const frozen = f.db.orchInstances.get(instance.id, { strictScope: true })!;
    assert.equal(isDesktopLocalAssetExecution("scope-device", f.workspaces, frozen), expected);
    const result = await f.call("orch.intakes.list", {});
    assert.equal(result.status, 200);
    assert.equal(result.body.listMetaById[item.id].instanceCount, expected ? 1 : 0);
    assert.equal(result.body.listMetaById[item.id].latestInstance?.id ?? null, expected ? instance.id : null);
  }
});

test("protected RA direct routes deny reads edits and sends without orphan cleanup", async t => {
  const f = fixture(t);
  for (const scope of [null, { scopeType: "shared_workspace", scopeId: "shared" }] as const) {
    const id = scope ? "shared-ra" : "unknown-ra";
    f.db.threads.create({ id: id as any, workspaceId, engine: "codex", title: id, threadSubtype: "requirement-analysis" });
    f.db.orchRequirementAnalysisSessions.create({ id: id as any, workspaceId, title: id, status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as any, workspaceScope: scope });
    const before = f.db.db.prepare("SELECT total_changes() AS total").get();
    for (const [method, body] of [
      ["orch.requirementAnalysis.sessions.get", { sessionId: id }],
      ["orch.requirementAnalysis.sessions.archive", { sessionId: id, status: "archived" }],
      ["orch.requirementAnalysis.sessions.create", { threadId: id, title: "Changed" }],
      ["orch.requirementAnalysis.messages.send", { sessionId: id, text: "Private message" }],
      ["orch.requirementAnalysis.createIntakes", { sessionId: id, candidateIds: ["candidate"] }],
    ] as const) assert.equal((await f.call(method, body)).status, 404, method);
    assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
  }
});

test("desktop proposal pagination and instance counts cover all 503 frozen local executions", async t => {
  const f = fixture(t);
  const item = f.intake("many-local");
  const expected: string[] = [];
  f.db.db.transaction(() => {
    for (let index = 0; index < 503; index++) {
      const { proposal } = f.execution(item, "local");
      f.db.db.prepare("UPDATE orch_proposals SET updated_at = ? WHERE id = ?").run(1000 - index, proposal.id);
      expected.push(proposal.id);
    }
    f.execution(item, "shared", "running");
    f.execution(item, "unknown");
  })();
  const received: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await f.call("orch.proposals.list", { summaryOnly: true, allowedResourceIds: [item.id], limit: 101, cursor });
    assert.equal(result.status, 200);
    received.push(...result.body.proposals.map((entry: any) => entry.id));
    assert.equal(result.body.hasMore, received.length < 503);
    cursor = result.body.nextCursor;
  } while (cursor);
  assert.deepEqual(received, expected);
  const instances = await f.call("orch.instances.list", { allowedResourceIds: [item.id], limit: 200 });
  assert.equal(instances.body.instances.length, 200);
  assert.equal(instances.body.totalCountByIntake[item.id], 503);
  assert.equal(instances.body.hasMore, true);
  const hidden = await f.call("orch.instances.list", { allowedResourceIds: [] });
  assert.deepEqual(hidden.body.instances, []);
  assert.deepEqual(hidden.body.totalCountByIntake, {});
});

test("frozen intake identity mismatch fails all local strict consumers before filters", async t => {
  const f = fixture(t);
  const item = f.intake("identity");
  const { instance } = f.execution(item, "local");
  f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...item, id: "PRIVATE_FALSE_INTAKE" }), instance.id);
  for (const run of [() => f.db.orchInstances.get(instance.id, { strictScope: true }), () => f.db.orchInstances.listByWorkspace(workspaceId, { strictScope: true })]) {
    assert.throws(run, (error: any) => error.code === "ORCH_INSTANCE_SCOPE_INVALID" && error.details.reason === "intake_projection_identity_mismatch" && !JSON.stringify(error).includes("PRIVATE_FALSE_INTAKE"));
  }
  const result = await f.call("orch.intakes.list", { allowedResourceIds: [item.id] });
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_FALSE_INTAKE/);
});

test("protected active execution blocks local proposal start without exposing its identity", async t => {
  const f = fixture(t);
  const item = f.intake("active-protected");
  const hidden = f.execution(item, "shared", "running");
  const local = f.execution(item, "local");
  const result = await f.call("orch.instances.start", { proposalId: local.proposal.id });
  assert.equal(result.status, 409);
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(hidden.instance.id));
  assert.deepEqual(f.effects, []);
  assert.equal(f.db.orchInstances.listByWorkspace(workspaceId).length, 2);
});

test("single RA routes do not scan an unrelated corrupt session in the same workspace", async t => {
  const f = fixture(t);
  for (const id of ["good-ra", "other-bad-ra"]) {
    f.db.threads.create({ id: id as any, workspaceId, engine: "codex", title: id, threadSubtype: "requirement-analysis" });
    f.db.orchRequirementAnalysisSessions.create({ id: id as any, workspaceId, title: id, status: "active", phase: "discover", engine: "codex", runtimeThreadId: id as any, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  }
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = 'other-bad-ra'").run("{PRIVATE_OTHER_RA");
  assert.equal((await f.call("orch.requirementAnalysis.sessions.get", { sessionId: "good-ra" })).status, 200);
  assert.equal((await f.call("orch.requirementAnalysis.sessions.archive", { sessionId: "good-ra", status: "archived" })).status, 200);
  const before = f.db.db.prepare("SELECT total_changes() AS total").get();
  const result = await f.call("orch.requirementAnalysis.createIntakes", { sessionId: "good-ra", candidateIds: ["missing-candidate"] });
  assert.equal(result.status, 400);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_OTHER_RA|other-bad-ra|ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID/);
  assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
  assert.equal((await f.call("orch.requirementAnalysis.sessions.list", {})).status, 500);
});

for (const reader of ["get", "list", "authority", "metadata"] as const) {
  test(`cross-workspace local profile is rejected by ${reader} without rewriting frozen configuration`, async t => {
    const f = fixture(t);
    const intake = f.intake("profile-identity");
    const { instance } = f.execution(intake, "local");
    const secret = "other-device:PRIVATE_PROFILE_WORKSPACE";
    const raw = JSON.stringify({ executionProfileScope: { scopeType: "local_workspace", scopeId: secret }, legacyOptional: { retained: true } });
    f.db.db.prepare("UPDATE orch_instances SET runtime_config_json = ? WHERE id = ?").run(raw, instance.id);
    if (reader === "authority") {
      assert.equal(isDesktopLocalAssetExecution("scope-device", f.workspaces, f.db.orchInstances.get(instance.id)), false);
    } else if (reader === "metadata") {
      const logs: any[][] = [];
      const original = logger.error;
      logger.error = (...args: any[]) => { logs.push(args); };
      try {
        const result = await f.call("orch.intakes.list", { allowedResourceIds: [intake.id] });
        assert.equal(result.status, 500);
        assert.equal(logs.length, 1);
        assert.equal(logs[0][2].errorDetails.instanceId, instance.id);
        assert.equal(logs[0][2].workspaceId, workspaceId);
        assert.equal(logs[0][2].errorDetails.reason, "local_profile_workspace_mismatch");
        assert.doesNotMatch(JSON.stringify([result, logs]), new RegExp(secret));
      } finally { logger.error = original; }
    } else {
      const read = reader === "get" ? () => f.db.orchInstances.get(instance.id, { strictScope: true })
        : () => f.db.orchInstances.listByWorkspace(workspaceId, { strictScope: true });
      assert.throws(read, (error: any) => {
        assert.equal(error.code, "ORCH_INSTANCE_SCOPE_INVALID");
        assert.deepEqual(error.details, { instanceId: instance.id, workspaceId, field: "runtime_config_json.executionProfileScope", reason: "local_profile_workspace_mismatch" });
        assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, new RegExp(secret));
        return true;
      });
    }
    assert.equal((f.db.db.prepare("SELECT runtime_config_json FROM orch_instances WHERE id = ?").get(instance.id) as any).runtime_config_json, raw);
  });
}

for (const corruption of ["json", "identity"] as const) {
  for (const method of ["orch.instances.start", "orch.proposals.create"] as const) {
    test(`${method} rejects ${corruption} in an existing active execution before later side effects`, async t => {
      const f = fixture(t);
      const item = f.intake("active-frozen-guard");
      const active = f.execution(item, "local", "running");
      const local = f.execution(item, "local");
      f.db.orchProposals.update({ ...local.proposal, draftWorkflow: { ...local.proposal.draftWorkflow,
        nodes: [...local.proposal.draftWorkflow.nodes, { id: "role", type: "role", roleId: "fixture-role" as any, label: "Role", position: { x: 0, y: 80 } }] } });
      const raw = corruption === "json" ? "{PRIVATE_ACTIVE_BODY" : JSON.stringify({ ...item, id: "PRIVATE_FALSE_ACTIVE_INTAKE" });
      // 仅测试库移除 JSON 表达式索引，以注入已损坏历史；业务读取仍走真实仓储。
      if (corruption === "json") f.db.db.exec("DROP INDEX idx_orch_instances_workspace_intake_display");
      f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(raw, active.instance.id);
      f.ctx.orchAssetRuntimeRead = { openWorkspace: () => ({ getAsset: () => ({ definition: f.workflow }), listAssets: () => [] }) } as unknown as ApiHandlerContext["orchAssetRuntimeRead"];
      f.ctx.orchAssetLaunchSnapshot = {
        /** 若单 active 检查漏过，记录真实后续启动入口，而不是仅断言失败响应。 */
        createFromWorkflow() { f.effects.push("launch"); throw new Error("REACHED_AFTER_ACTIVE_GUARD"); },
      } as unknown as ApiHandlerContext["orchAssetLaunchSnapshot"];
      const before = f.db.db.prepare("SELECT total_changes() AS total").get();
      const logs = captureWorkspaceErrors(t, f.db);
      const result = await f.call(method, method === "orch.instances.start" ? { proposalId: local.proposal.id }
        : { intakeId: item.id, workflowId: f.workflow.id });
      assert.equal(result.status, 500);
      assert.equal(result.body.code, "INTERNAL_ERROR");
      assert.equal(logs.length, 1);
      const details = logs[0]![2] as Record<string, unknown>;
      assert.equal(details.code, "ORCH_INSTANCE_SCOPE_INVALID");
      assert.equal(details.instanceId, active.instance.id);
      assert.equal(details.reason, corruption === "json" ? "invalid_json" : "intake_projection_identity_mismatch");
      assert.doesNotMatch(JSON.stringify([result, logs]), /PRIVATE_ACTIVE_BODY|PRIVATE_FALSE_ACTIVE_INTAKE/);
      assert.deepEqual(f.effects, []);
      assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
      assert.equal((f.db.db.prepare("SELECT intake_snapshot_json FROM orch_instances WHERE id = ?").get(active.instance.id) as any).intake_snapshot_json, raw);
    });
  }
}
