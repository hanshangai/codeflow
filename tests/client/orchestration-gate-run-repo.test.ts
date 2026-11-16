import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

test("AI 门禁逻辑运行支持幂等创建和 CAS 状态推进", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-gate-run-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  try {
    db.db.pragma("foreign_keys = OFF");
    const input = {
      id: "gate-run-1",
      instanceId: "instance-1" as any,
      nodeId: "node-1",
      nodeAttemptId: "attempt-1",
      artifactId: "artifact-1",
      criteriaHash: "criteria-hash",
      artifactHash: "artifact-hash",
    };
    const first = db.orchGateEvaluationRuns.create(input);
    const duplicate = db.orchGateEvaluationRuns.create({ ...input, id: "gate-run-2" });
    assert.equal(duplicate.id, first.id);
    assert.equal(first.status, "pending");
    assert.equal(db.orchGateEvaluationRuns.updateCas(first.id, first.statusVersion, { status: "running", activeCallId: "call-1" }), true);
    assert.equal(db.orchGateEvaluationRuns.updateCas(first.id, first.statusVersion, { status: "failed" }), false);
    const current = db.orchGateEvaluationRuns.get(first.id);
    assert.equal(current?.activeCallId, "call-1");
    assert.equal(db.orchGateEvaluationRuns.updateCas(first.id, current!.statusVersion, { status: "completed", resultsJson: "[]", finishedAt: Date.now() }), true);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
