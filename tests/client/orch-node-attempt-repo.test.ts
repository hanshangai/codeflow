import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NodeFinalAnswerPayload, OrchestrationId } from "@codeflowai/shared";

import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { OrchArtifactRepo } from "../../apps/desktop/client/src/db/repos/orchArtifactRepo.ts";
import { OrchNodeAttemptRepo } from "../../apps/desktop/client/src/db/repos/orchNodeAttemptRepo.ts";

test("OrchNodeAttemptRepo persists submissions idempotently and finalizes once", () => {
  const fixture = createFixture();
  try {
    const attempt = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "frontend-details" });
    const bound = fixture.attempts.bindExecution(attempt.id, "thread-1", "turn-1");
    assert.equal(bound.threadId, "thread-1");
    assert.equal(bound.turnId, "turn-1");

    const first = fixture.attempts.submit(attempt.id, createSubmission("完成"));
    const repeated = fixture.attempts.submit(attempt.id, createSubmission("完成"));
    assert.equal(first.idempotent, false);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.attempt.id, first.attempt.id);
    assert.throws(
      () => fixture.attempts.submit(attempt.id, createSubmission("不同结果")),
      /已提交不同结果/,
    );

    const finalizing = fixture.attempts.markFinalizing(attempt.id);
    assert.equal(finalizing.attempt.status, "finalizing");
    fixture.attempts.attachArtifact(attempt.id, "artifact-1");
    const completed = fixture.attempts.markTerminal(attempt.id, "completed");
    const replayed = fixture.attempts.markTerminal(attempt.id, "completed");
    assert.equal(completed.status, "completed");
    assert.equal(replayed.finalizedAt, completed.finalizedAt);
  } finally {
    fixture.close();
  }
});

test("OrchNodeAttemptRepo invalidates only the rerun node and keeps sibling attempt current", () => {
  const fixture = createFixture();
  try {
    const frontend = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "frontend-details" });
    const backend = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "backend-details" });
    const frontendRerun = fixture.attempts.begin({
      instanceId: fixture.instanceId,
      nodeId: "frontend-details",
      invalidationReason: "前端详情定向返工",
    });

    assert.equal(fixture.attempts.get(frontend.id)?.status, "invalidated");
    assert.equal(fixture.attempts.get(frontend.id)?.lastError, "前端详情定向返工");
    assert.equal(frontendRerun.attemptNo, 2);
    assert.equal(fixture.attempts.get(backend.id)?.status, "running");
    assert.equal(fixture.attempts.isCurrent(fixture.instanceId, "backend-details", backend.id), true);
  } finally {
    fixture.close();
  }
});

test("OrchNodeAttemptRepo exposes submitted attempts for crash recovery", () => {
  const fixture = createFixture();
  try {
    const attempt = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "database-details" });
    fixture.attempts.bindExecution(attempt.id, "thread-db", "turn-db");
    fixture.attempts.submit(attempt.id, createSubmission("数据库详情完成"));
    fixture.attempts.saveResponseText(attempt.id, "数据库详情完成");

    const recoverable = fixture.attempts.listRecoverableByInstance(fixture.instanceId);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0]?.id, attempt.id);
    assert.equal(recoverable[0]?.responseText, "数据库详情完成");
    assert.equal(recoverable[0]?.submission?.review.summary, "数据库详情完成");
  } finally {
    fixture.close();
  }
});

test("OrchNodeAttemptRepo rejects a repeated submission after finalization failed", () => {
  const fixture = createFixture();
  try {
    const attempt = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "frontend-details" });
    const submission = createSubmission("前端详情完成");
    fixture.attempts.submit(attempt.id, submission);
    fixture.attempts.markFinalizing(attempt.id);
    fixture.attempts.markTerminal(attempt.id, "failed", "artifact persist failed");

    assert.throws(
      () => fixture.attempts.submit(attempt.id, submission),
      /已失败，拒绝迟到提交/,
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeAttemptRepo restores the same waiting-feedback attempt without changing its identity", () => {
  const fixture = createFixture();
  try {
    const attempt = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "backend-details" });
    fixture.attempts.bindExecution(attempt.id, "thread-recovery", "turn-recovery");
    fixture.attempts.markTerminal(attempt.id, "waiting-feedback", "session invalidated");
    const submission = createSubmission("原 provider turn 已完成");

    const recovered = fixture.attempts.submitRecoveredWaitingFeedback({
      id: attempt.id,
      instanceId: fixture.instanceId,
      nodeId: "backend-details",
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      submission,
      responseText: "原 provider turn 已完成",
    });
    const repeated = fixture.attempts.submitRecoveredWaitingFeedback({
      id: attempt.id,
      instanceId: fixture.instanceId,
      nodeId: "backend-details",
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      submission,
      responseText: "原 provider turn 已完成",
    });

    assert.equal(recovered.idempotent, false);
    assert.equal(repeated.idempotent, true);
    assert.equal(recovered.attempt.id, attempt.id);
    assert.equal(recovered.attempt.attemptNo, attempt.attemptNo);
    assert.equal(recovered.attempt.threadId, "thread-recovery");
    assert.equal(recovered.attempt.turnId, "turn-recovery");
    assert.equal(recovered.attempt.status, "result-submitted");
    assert.equal(recovered.attempt.finalizedAt, null);
    assert.equal(recovered.attempt.lastError, null);
    assert.equal(recovered.attempt.responseText, "原 provider turn 已完成");
  } finally {
    fixture.close();
  }
});

test("OrchNodeAttemptRepo rejects recovery when the provider execution scope differs", () => {
  const fixture = createFixture();
  try {
    const attempt = fixture.attempts.begin({ instanceId: fixture.instanceId, nodeId: "backend-details" });
    fixture.attempts.bindExecution(attempt.id, "thread-recovery", "turn-recovery");
    fixture.attempts.markTerminal(attempt.id, "waiting-feedback", "session invalidated");

    assert.throws(
      () => fixture.attempts.submitRecoveredWaitingFeedback({
        id: attempt.id,
        instanceId: fixture.instanceId,
        nodeId: "backend-details",
        threadId: "thread-recovery",
        turnId: "turn-other",
        submission: createSubmission("错误 turn"),
        responseText: "错误 turn",
      }),
      /恢复执行边界不匹配/,
    );
    assert.equal(fixture.attempts.get(attempt.id)?.status, "waiting-feedback");
    assert.equal(fixture.attempts.get(attempt.id)?.submission, null);
  } finally {
    fixture.close();
  }
});

test("orch_artifacts enforces one artifact per node attempt", () => {
  const fixture = createFixture();
  try {
    const attempts = fixture.attempts;
    const attempt = attempts.begin({ instanceId: fixture.instanceId, nodeId: "backend-details" });
    const artifacts = new OrchArtifactRepo(fixture.db);
    artifacts.create(createArtifactInput(fixture.instanceId, attempt.id, 1));
    assert.throws(
      () => artifacts.create(createArtifactInput(fixture.instanceId, attempt.id, 2)),
      /UNIQUE constraint failed/,
    );
  } finally {
    fixture.close();
  }
});

function createFixture(): {
  db: ReturnType<typeof openSqliteDb>;
  instanceId: OrchestrationId;
  attempts: OrchNodeAttemptRepo;
  close: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-attempt-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  migrateClientDb(db);
  const instanceId = "orch-attempt-test" as OrchestrationId;
  db.prepare(`
    INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at)
    VALUES ('workspace-attempt-test', 'Attempt Test', ?, 0, 1, 1)
  `).run(tempDir);
  db.prepare(`
    INSERT INTO orch_instances (
      id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id, intake_snapshot_json,
      role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
      master_thread_id, status, node_states_json, created_at, updated_at
    ) VALUES (?, 'workspace-attempt-test', 'workflow-attempt-test', ?, NULL, ?, '{}', '{}', NULL, '{}', NULL, 'running', '{}', 1, 1)
  `).run(
    instanceId,
    JSON.stringify({ id: "workflow-attempt-test", nodes: [], edges: [] }),
    JSON.stringify({ id: "intake-attempt-test", workspaceId: "workspace-attempt-test", goal: "test" }),
  );
  return {
    db,
    instanceId,
    attempts: new OrchNodeAttemptRepo(db),
    close: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createSubmission(summary: string): NodeFinalAnswerPayload {
  return {
    answer: { mode: "text", text: summary },
    review: { verdict: "pass", summary, blockingIssues: null },
    control: { nextAction: "continue" },
    acceptanceChecks: null,
    humanInput: null,
    rework: null,
  };
}

function createArtifactInput(instanceId: OrchestrationId, attemptId: string, version: number) {
  return {
    instanceId,
    nodeId: "backend-details",
    kind: "backend-details",
    version,
    title: `Backend v${version}`,
    schemaRef: null,
    status: "draft" as const,
    contentJson: JSON.stringify({ mode: "text", text: "done" }),
    metadata: { nodeAttemptId: attemptId },
    persistenceMode: "db-only" as const,
    payloadMode: "text" as const,
    workspaceStatus: "none" as const,
    workspaceBaseDir: null,
    stagingPath: null,
    publishedPath: null,
    contentHash: null,
    manifest: null,
  };
}
