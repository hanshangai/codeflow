import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkflowDefinition, WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../src/db/clientDb.ts";

test("legacy Client workflow persistence keeps edge route points", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-workflow-route-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const workspaceId = "workflow-route-workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "route test", path: tempDir });

  const workflow: Omit<WorkflowDefinition, "createdAt" | "updatedAt"> = {
    id: "workflow-route-persistence" as WorkflowDefinition["id"],
    workspaceId,
    name: "route test",
    description: "",
    nodes: [
      { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } },
      { id: "end", type: "end", label: "End", position: { x: 200, y: 0 } },
    ],
    edges: [{
      id: "start-end",
      sourceNodeId: "start",
      targetNodeId: "end",
      dataMappings: [],
      routePoints: [{ x: 40, y: 30 }, { x: 120, y: 30 }, { x: 240, y: 30 }],
    }],
    kind: "custom",
    version: 1,
  };

  try {
    db.orchWorkflows.upsert(workflow);
    const loaded = db.orchWorkflows.get(workflow.id);
    assert.deepEqual(loaded?.edges[0]?.routePoints, workflow.edges[0].routePoints);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
