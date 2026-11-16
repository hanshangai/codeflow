import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

test("OrchPromptSnapshotRepo backfills title fields for older structured prompt envelopes", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-prompt-snapshot-"));
  const clientDb = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    clientDb.workspaces.upsert({ id: "ws-old" as any, title: "旧工作区", path: workspacePath });
    const runtimePolicy = {
      workflowId: "wf-old",
      workflowName: "旧流程",
      nodeId: "analysis",
      nodeLabel: "需求分析",
      approvalMode: "auto",
      executionEngine: "codex",
      accessMode: "current",
      toolRuntimePolicy: {
        allowedToolIds: [],
        requiresWorkspaceWrite: false,
      },
      artifactPolicy: {
        persistenceMode: "db-only",
        outputMode: "text",
        primaryKind: "analysis-report",
      },
    };
    const oldEnvelope = {
      schemaVersion: "node-prompt-envelope/v1",
      meta: {
        scene: "orchestration-node",
        instanceId: "orch-old",
        workflowId: "wf-old",
        workflowName: "旧流程",
        nodeId: "analysis",
        nodeLabel: "需求分析",
        intent: "execute",
      },
      role: {
        roleId: "role-analysis",
        name: "需求分析师",
        description: null,
        responsibility: null,
        systemPrompt: null,
        formalTemplateName: "历史模板",
        inputDefinition: { instructions: "", requiredFields: [] },
        outputDefinition: {
          instructions: "",
          deliveryMode: "direct",
          format: "markdown",
          resultKey: null,
          filePathRule: null,
          files: [],
          requiredFields: [],
        },
      },
      task: {
        goal: "旧结构化快照目标",
        background: null,
        acceptanceCriteria: null,
        renderedTaskInput: "旧输入",
        fieldBindings: {},
      },
      artifacts: { upstreamArtifacts: [] },
      knowledge: { catalogs: [], warnings: [] },
      review: { feedbackPatch: null },
      runtime: { runtimePolicy, toolRegistry: null },
    };
    clientDb.db.prepare(`
      INSERT INTO orch_instances (
        id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id, intake_snapshot_json,
        role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
        master_thread_id, status, node_states_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "orch-old",
      "ws-old",
      "wf-old",
      JSON.stringify({
        id: "wf-old",
        workspaceId: "ws-old",
        family: "feature-dev",
        name: "旧流程",
        description: "",
        workflowKnowledgeBundleIds: [],
        nodes: [],
        edges: [],
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
      null,
      JSON.stringify({
        id: "intake-old",
        workspaceId: "ws-old",
        triggerMode: "manual",
        taskType: "feature",
        title: "旧需求标题",
        goal: "旧结构化快照目标",
        createdAt: 1,
        updatedAt: 1,
      }),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify(null),
      JSON.stringify({}),
      null,
      "running",
      JSON.stringify({}),
      1,
      1,
    );

    /** Inserts a legacy structured snapshot with caller-controlled user prompt text. */
    const insertSnapshot = (id: string, userMessage: string, attemptNo = 1): void => {
      clientDb.db.prepare(`
        INSERT INTO orch_prompt_snapshots (
          id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort,
          prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
          runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        "orch-old",
        "analysis",
        attemptNo,
        null,
        null,
        "codex",
        null,
        null,
        JSON.stringify(oldEnvelope),
        "system",
        "developer",
        userMessage,
        "preview",
        JSON.stringify(runtimePolicy),
        null,
        JSON.stringify({ catalogs: [], warnings: [] }),
        JSON.stringify({ artifacts: [], fieldBindings: {} }),
        1,
      );
    };

    insertSnapshot("snapshot-old", "user");
    insertSnapshot("snapshot-attempt-2", "attempt-2", 2);

    assert.deepEqual(
      clientDb.orchPromptSnapshots.listByNode("orch-old" as any, "analysis", { includeContent: false, attemptNo: 2 })
        .map((snapshot) => snapshot.id),
      ["snapshot-attempt-2"],
    );
    assert.deepEqual(
      clientDb.orchPromptSnapshots.listByNode("orch-old" as any, "analysis", { includeContent: false, attemptNo: 1 })
        .map((snapshot) => snapshot.id),
      ["snapshot-old"],
    );

    const snapshot = clientDb.orchPromptSnapshots.get("snapshot-old");
    assert.equal(snapshot?.promptEnvelope.task.title, "旧结构化快照目标");
    assert.equal(snapshot?.promptEnvelope.task.titlePathSegment, "旧结构化快照目标");
    assert.equal(snapshot?.promptEnvelope.task.goal, "旧结构化快照目标");

    insertSnapshot(
      "snapshot-tag",
      "<user_prompt><task_title>标题 &lt;A&gt; &amp; B</task_title><task_title_path_segment>标题-A-B</task_title_path_segment></user_prompt>",
    );

    const taggedSnapshot = clientDb.orchPromptSnapshots.get("snapshot-tag");
    assert.equal(taggedSnapshot?.promptEnvelope.task.title, "标题 <A> & B");
    assert.equal(taggedSnapshot?.promptEnvelope.task.titlePathSegment, "标题-A-B");
  } finally {
    clientDb.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
