import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowSnapshotParser } from "../../apps/desktop/client/src/app/handlers/orchMetricsHandlers.js";

test("workflow metrics snapshot parser reuses only unchanged JSON for the same workflow", () => {
  const parse = createWorkflowSnapshotParser();
  const originalJson = JSON.stringify({ name: "流程 A", nodes: [{ id: "node-a" }] });
  const changedJson = JSON.stringify({ name: "流程 A v2", nodes: [{ id: "node-a" }] });

  const first = parse("workflow-a", originalJson);
  const cached = parse("workflow-a", originalJson);
  const otherWorkflow = parse("workflow-b", originalJson);
  const changed = parse("workflow-a", changedJson);

  assert.equal(cached, first);
  assert.notEqual(otherWorkflow, first);
  assert.notEqual(changed, first);
  assert.equal(changed.value.name, "流程 A v2");
  assert.equal(changed.invalid, false);
});

test("workflow metrics snapshot parser preserves invalid and no-ID parse semantics", () => {
  const parse = createWorkflowSnapshotParser();
  const invalidFirst = parse("workflow-invalid", "{");
  const invalidCached = parse("workflow-invalid", "{");
  const noIdFirst = parse("", "{}");
  const noIdSecond = parse("", "{}");

  assert.equal(invalidFirst.invalid, true);
  assert.equal(invalidCached, invalidFirst);
  assert.equal(noIdFirst.invalid, false);
  assert.notEqual(noIdSecond, noIdFirst);
});

test("workflow metrics snapshot parser refreshes LRU order and evicts the oldest workflow", () => {
  const parse = createWorkflowSnapshotParser(2);
  const workflowA = parse("workflow-a", "{\"name\":\"A\"}");
  const workflowB = parse("workflow-b", "{\"name\":\"B\"}");

  assert.equal(parse("workflow-a", "{\"name\":\"A\"}"), workflowA);
  parse("workflow-c", "{\"name\":\"C\"}");
  assert.equal(parse("workflow-a", "{\"name\":\"A\"}"), workflowA);
  assert.notEqual(parse("workflow-b", "{\"name\":\"B\"}"), workflowB);
});

test("workflow metrics snapshot parser keeps the production cache capped at 32 entries", () => {
  const parse = createWorkflowSnapshotParser(100);
  const oldest = parse("workflow-0", "{\"name\":\"0\"}");
  for (let index = 1; index <= 32; index += 1) {
    parse(`workflow-${index}`, `{\"name\":\"${index}\"}`);
  }

  assert.notEqual(parse("workflow-0", "{\"name\":\"0\"}"), oldest);
});
