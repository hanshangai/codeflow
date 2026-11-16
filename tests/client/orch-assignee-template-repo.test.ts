import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId, WorkflowId } from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

test("OrchAssigneeTemplateRepo upserts, lists, normalizes and deletes templates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-assignee-template-repo-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = "ws-assignee-template" as WorkspaceId;
  const workflowId = "wf-assignee-template" as WorkflowId;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "Assignee Template", path: tempDir });
    const legacyModeField = "collaboration" + "Mode";
    db.orchWorkflows.upsert({
      id: workflowId,
      workspaceId,
      name: "Collaborative Workflow",
      description: "",
      kind: "custom",
      [legacyModeField]: "collaborative",
      nodes: [{ id: "node-dev", type: "role", roleId: "role-dev", label: "开发", position: { x: 0, y: 0, ignored: true }, assigneeUserIds: ["user-a"] }],
      edges: [{ id: "edge-dev", sourceNodeId: "node-dev", targetNodeId: "end", dataMappings: [], assigneeUserIds: ["user-a"] }],
      version: 1,
    } as any);
    const storedWorkflow = db.orchWorkflows.get(workflowId) as any;
    assert.equal(storedWorkflow?.[legacyModeField], undefined);
    assert.equal(storedWorkflow?.nodes?.[0]?.assigneeUserIds, undefined);
    assert.equal(storedWorkflow?.nodes?.[0]?.position?.ignored, undefined);
    assert.equal(storedWorkflow?.edges?.[0]?.assigneeUserIds, undefined);

    const created = db.orchAssigneeTemplates.upsert({
      workspaceId,
      workflowId,
      name: "默认模板",
      status: "published",
      nodeAssigneeUserIdsByNodeId: {
        "node-dev": ["user-b", "user-b", "user-a"],
        "node-empty": [],
      },
    });
    assert.equal(created.version, 1);
    assert.deepEqual(created.nodeAssigneeUserIdsByNodeId, { "node-dev": ["user-b", "user-a"] });

    const listed = db.orchAssigneeTemplates.listByWorkspace(workspaceId, workflowId);
    assert.deepEqual(listed.map((item) => item.id), [created.id]);

    const updated = db.orchAssigneeTemplates.upsert({
      ...created,
      name: "夜间模板",
      status: "draft",
      nodeAssigneeUserIdsByNodeId: { "node-dev": ["user-c"] },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(db.orchAssigneeTemplates.get(created.id)?.nodeAssigneeUserIdsByNodeId, { "node-dev": ["user-c"] });

    db.orchAssigneeTemplates.delete(created.id);
    assert.equal(db.orchAssigneeTemplates.get(created.id), null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
