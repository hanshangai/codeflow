import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Artifact,
  ArtifactFileEntry,
  NodeResultField,
  NodeExecutionState,
  OrchestrationInstance,
  RoleDefinition,
  WorkflowDefinition,
} from "../../packages/shared/src/index.ts";
import { createDefaultRoleExecutionConfig } from "../../packages/shared/src/index.ts";
import { handleOrchArtifactRevise } from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";
import { OrchestrationEngine } from "../../apps/desktop/client/src/orchestration/orchestrationEngine.ts";

function createRole(): RoleDefinition {
  return {
    id: "role_delivery" as any,
    workspaceId: "client-a:ws-demo" as any,
    name: "交付整理",
    description: "交付整理",
    responsibility: "整理输出结果",
    systemPrompt: "您是交付整理角色",
    inputDefinition: {
      instructions: "任务={{requirement}}",
      requiredFields: [],
    },
    outputDefinition: {
      instructions: "",
      deliveryMode: "direct",
      format: "markdown",
      resultKey: "delivery-pack",
      filePathRule: null,
      requiredFields: [],
    },
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createNodeState(
  nodeId: string,
  status: NodeExecutionState["status"],
  patch: Partial<NodeExecutionState> = {},
): NodeExecutionState {
  return {
    nodeId,
    status,
    retryCount: 0,
    inputArtifactIds: [],
    outputArtifactIds: [],
    activeFeedbackRecordIds: [],
    feedbackRecordIds: [],
    ...patch,
  };
}

function createInstance(role: RoleDefinition, workflow: WorkflowDefinition): OrchestrationInstance {
  const { createdAt: _workflowCreatedAt, updatedAt: _workflowUpdatedAt, ...runtimeWorkflow } = workflow;
  const { createdAt: _roleCreatedAt, updatedAt: _roleUpdatedAt, ...runtimeRole } = role;
  return {
    id: "orch_rework_human_revision" as any,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    proposalId: null,
    intakeSnapshot: {
      id: "intake_demo" as any,
      workspaceId: workflow.workspaceId,
      triggerMode: "manual",
      taskType: "feature",
      title: "验证人工修订",
      goal: "验证人工修订",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: workflow,
    assetRuntimeSnapshot: {
      authorityMode: "legacy",
      workflow: {
        assetType: "workflow",
        assetId: workflow.id,
        definition: runtimeWorkflow,
        source: null,
      },
      roles: {
        [role.id]: {
          assetType: "role",
          assetId: role.id,
          definition: runtimeRole,
          source: { authorityMode: "legacy", createdAt: role.createdAt, updatedAt: role.updatedAt },
        },
      },
      knowledgeBundles: {},
      toolsets: {},
      skills: {},
    },
    roleSnapshots: { [role.id]: role },
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: null,
    status: "running",
    nodeStates: {
      implementation: createNodeState("implementation", "completed"),
      delivery: createNodeState("delivery", "waiting-approval", {
        outputArtifactIds: ["artifact_delivery_v1" as any, "artifact_delivery_v2" as any],
        conclusion: {
          nextAction: "rework",
          reviewVerdict: "fail",
          summary: "需要回退开发实现节点",
          blockingIssues: ["交付结果需要按人工修订版重做"],
          acceptanceChecks: null,
          humanInput: null,
          rework: {
            targetNodeId: "implementation",
            reason: "请基于最新交付结果重做",
            rerunNodeIds: ["implementation", "delivery"],
          },
          decidedBy: "model",
          decidedAt: 1,
        },
      }),
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createArtifact(input: Partial<Artifact> & Pick<Artifact, "id" | "instanceId" | "nodeId" | "kind">): Artifact {
  return {
    version: 1,
    title: input.kind,
    schemaRef: null,
    status: "draft",
    contentJson: JSON.stringify({ mode: "text", text: input.kind }),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

test("rework feedback keeps the latest human-edited artifact and its revision note", async () => {
  const role = createRole();
  const workflow: WorkflowDefinition = {
    id: "wf_rework_human_revision" as any,
    workspaceId: "client-a:ws-demo" as any,
    family: "feature-dev",
    name: "返工带人工修订记录",
    description: "返工带人工修订记录",
    workflowKnowledgeBundleIds: [],
    nodes: [
      { id: "implementation", type: "role", label: "开发实现", roleId: role.id, position: { x: 0, y: 0 } },
      {
        id: "delivery",
        type: "role",
        label: "交付整理",
        roleId: role.id,
        position: { x: 180, y: 0 },
        reworkPolicy: {
          allowedTargetNodeIds: ["implementation"],
        },
      },
    ],
    edges: [
      { id: "e-i-d", sourceNodeId: "implementation", targetNodeId: "delivery", dataMappings: [] },
    ],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const instance = createInstance(role, workflow);
  const feedbackRecords: Array<Record<string, unknown>> = [];
  const artifacts: Artifact[] = [
    createArtifact({
      id: "artifact_delivery_v1" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
      version: 1,
      contentJson: JSON.stringify({ mode: "text", text: "初版交付" }),
    }),
    createArtifact({
      id: "artifact_delivery_v2" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      status: "draft",
      version: 2,
      contentJson: JSON.stringify({ mode: "text", text: "人工修订后的交付" }),
      metadata: {
        revision: {
          source: "human",
          basedOnArtifactId: "artifact_delivery_v1",
          basedOnVersion: 1,
          note: "人工补充了验收清单和最终交付边界",
          editedAt: 2,
        },
      },
    }),
  ];

  const engine = new OrchestrationEngine({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
        updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
          instance.nodeStates = nodeStates;
        },
        updateStatus(_instanceId: string, status: OrchestrationInstance["status"]) {
          instance.status = status;
        },
        updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
          instance.artifactIndex = artifactIndex as any;
        },
      },
      orchFeedback: {
        create(input: Record<string, unknown>) {
          const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
          feedbackRecords.push(record);
          return record;
        },
        get() {
          return null;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId);
        },
        listByNode(instanceId: string, nodeId: string) {
          return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
        },
        get(artifactId: string) {
          return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
        },
        updateStatus(artifactId: string, status: Artifact["status"]) {
          const artifact = artifacts.find((item) => item.id === artifactId);
          if (artifact) artifact.status = status;
        },
        updateWorkspace() {},
      },
      orchNodeAttempts: {
        invalidateActiveByNode() {},
      },
      orchArtifactFiles: {
        listByArtifact() {
          return [];
        },
        updatePublishedPaths() {},
        updateStatusByArtifact() {},
      },
      orchEvents: {
        append() {},
      },
      orchRoles: {
        get() {
          return null;
        },
      },
    } as any,
    threads: {} as any,
    sessions: {} as any,
    workspaces: new Map(),
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
  });

  await engine.submitFeedback(instance.id, "delivery", "approve", { feedback: "请把实现与人工修订版对齐" });

  assert.deepEqual(instance.nodeStates.implementation.inputArtifactIds, ["artifact_delivery_v2"]);
  const reworkFeedback = feedbackRecords[1] as { artifactIds?: string[]; feedback?: string } | undefined;
  assert.equal(reworkFeedback?.artifactIds?.[0], "artifact_delivery_v2");
  assert.match(String(reworkFeedback?.feedback ?? ""), /人工修订记录：/);
  assert.match(String(reworkFeedback?.feedback ?? ""), /人工补充了验收清单和最终交付边界/);
});

test("artifact revise handler preserves fields, attachments, and file keys", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-human-revise-handler-"));
  try {
    const role = createRole();
    const workflow: WorkflowDefinition = {
      id: "wf_revise_handler" as any,
      workspaceId: "client-a:ws-demo" as any,
      family: "feature-dev",
      name: "人工修订 handler",
      description: "人工修订 handler",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "delivery", type: "role", label: "交付整理", roleId: role.id, position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const instance = createInstance(role, workflow);
    const artifact = createArtifact({
      id: "artifact_delivery_v1" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      contentJson: JSON.stringify({
        mode: "file-set",
        files: [{ key: "dgn", path: "codeflow-docs/dgn.md", content: "# old\n" }],
      }),
    });
    const revised = createArtifact({
      id: "artifact_delivery_v2" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
      version: 2,
      contentJson: JSON.stringify({ mode: "file-set", files: [{ key: "dgn", path: "codeflow-docs/dgn.md" }] }),
    });
    const files: ArtifactFileEntry[] = [{
      id: "file_1",
      artifactId: revised.id,
      fileKey: "dgn",
      fileRole: "contract",
      format: "markdown",
      contractKey: "dgn",
      summary: "设计文档",
      validationStatus: "valid",
      relPath: "codeflow-docs/dgn.md",
      stagingPath: null,
      publishedPath: "codeflow-docs/dgn.md",
      status: "staging",
      contentHash: "hash",
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    }];
    const fields: NodeResultField[] = [{
      id: "field_1",
      artifactId: revised.id,
      instanceId: instance.id,
      nodeId: "delivery",
      resultName: "delivery-pack",
      fieldKey: "verificationSummary",
      label: "验证摘要",
      valueType: "text",
      valueJson: JSON.stringify("人工修订后已复核。"),
      valuePreview: "人工修订后已复核。",
      required: true,
      source: "model",
      validationStatus: "valid",
      createdAt: 1,
      updatedAt: 1,
    }];
    let capturedAnswer: unknown = null;
    const responses: any[] = [];

    await handleOrchArtifactRevise({
      db: {
        orchInstances: {
          get(instanceId: string) {
            return instanceId === instance.id ? instance : null;
          },
        },
        orchArtifacts: {
          get(artifactId: string) {
            return artifactId === artifact.id ? artifact : null;
          },
        },
        orchArtifactFiles: {
          listByArtifact() {
            return files;
          },
        },
        orchArtifactFields: {
          listByArtifact() {
            return fields;
          },
        },
      },
      workspaces: new Map([[instance.workspaceId, workspacePath]]),
      orchEngine: {
        async ensureAssetRuntimeSnapshotForExecution() {
          return instance;
        },
        reviseArtifact(_instanceId: string, _nodeId: string, _artifactId: string, input: { answer: unknown }) {
          capturedAnswer = input.answer;
          return revised;
        },
      },
      send(message: unknown) {
        responses.push(message);
      },
    } as any, {
      t: "api.req",
      id: "req_revise",
      method: "orch.artifacts.revise",
      body: {
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        nodeId: "delivery",
        artifactId: artifact.id,
        answer: {
          mode: "file-set",
          files: [{ key: "dgn", path: "codeflow-docs/dgn.md", summary: "设计文档" }],
          attachments: [{ key: "ddl_ref_audit", path: "codeflow-docs/ref.sql", summary: "审计 DDL", format: "sql" }],
          fields: { verificationSummary: "人工修订后已复核。" },
          summary: "已人工修订",
          changedFiles: ["codeflow-docs/dgn.md"],
        },
        workspaceFiles: [{ path: "codeflow-docs/dgn.md", content: "# revised\n" }],
      },
    } as any);

    assert.equal(responses[0]?.status, 200);
    assert.equal((capturedAnswer as any)?.files?.[0]?.key, "dgn");
    assert.equal((capturedAnswer as any)?.fields?.verificationSummary, "人工修订后已复核。");
    assert.equal((capturedAnswer as any)?.attachments?.[0]?.key, "ddl_ref_audit");
    assert.equal((capturedAnswer as any)?.attachments?.[0]?.format, "sql");
    assert.equal(responses[0]?.body?.fields?.[0]?.fieldKey, "verificationSummary");
    assert.equal(fs.readFileSync(path.join(workspacePath, "codeflow-docs", "dgn.md"), "utf8"), "# revised\n");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("artifact revise handler writes no workspace file when runtime snapshot backfill fails", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-human-revise-gate-"));
  try {
    const role = createRole();
    const workflow: WorkflowDefinition = {
      id: "wf_revise_gate" as any,
      workspaceId: "client-a:ws-demo" as any,
      family: "feature-dev",
      name: "人工修订门禁",
      description: "人工修订门禁",
      workflowKnowledgeBundleIds: [],
      nodes: [{ id: "delivery", type: "role", label: "交付整理", roleId: role.id, position: { x: 0, y: 0 } }],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const instance = createInstance(role, workflow);
    const artifact = createArtifact({
      id: "artifact_revise_gate" as any,
      instanceId: instance.id,
      nodeId: "delivery",
      kind: "delivery-pack",
    });
    const responses: any[] = [];
    let reviseCalls = 0;

    await handleOrchArtifactRevise({
      db: {
        orchInstances: { get: () => instance },
        orchArtifacts: { get: () => artifact },
      },
      workspaces: new Map([[instance.workspaceId, workspacePath]]),
      orchEngine: {
        async ensureAssetRuntimeSnapshotForExecution() {
          throw new Error("snapshot backfill failed");
        },
        reviseArtifact() {
          reviseCalls += 1;
          return artifact;
        },
      },
      send(message: unknown) { responses.push(message); },
    } as any, {
      t: "api.req",
      id: "req_revise_gate",
      method: "orch.artifacts.revise",
      body: {
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        nodeId: "delivery",
        artifactId: artifact.id,
        answer: {
          mode: "file-set",
          files: [{ key: "dgn", path: "codeflow-docs/dgn.md" }],
          summary: "人工修订",
        },
        workspaceFiles: [{ path: "codeflow-docs/dgn.md", content: "# should-not-exist\n" }],
      },
    } as any);

    assert.equal(responses[0]?.status, 400);
    assert.match(String(responses[0]?.body?.message ?? ""), /snapshot backfill failed/);
    assert.equal(reviseCalls, 0);
    assert.equal(fs.existsSync(path.join(workspacePath, "codeflow-docs", "dgn.md")), false);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("reviseArtifact reads path-only workspace file and mirrors a lightweight revision event into the node thread", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-human-revision-"));
  try {
    const role = createRole();
    role.outputDefinition.requiredFields = [
      {
        key: "verificationSummary",
        label: "验证摘要",
        valueType: "text",
        required: true,
      },
    ];
    const workflow: WorkflowDefinition = {
      id: "wf_human_revision_sync" as any,
      workspaceId: "client-a:ws-demo" as any,
      family: "feature-dev",
      name: "人工修订同步",
      description: "人工修订同步",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "delivery", type: "role", label: "交付整理", roleId: role.id, position: { x: 0, y: 0 } },
      ],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const publishedPath = "codeflow-docs/功能/demo/交付整理/delivery-note.md";
    const instance: OrchestrationInstance = {
      ...createInstance(role, workflow),
      id: "orch_human_revision_sync" as any,
      status: "running",
      artifactIndex: {
        delivery: ["artifact_delivery_v1" as any],
      },
      nodeStates: {
        delivery: createNodeState("delivery", "waiting-feedback", {
          threadId: "thread_delivery" as any,
          outputArtifactIds: ["artifact_delivery_v1" as any],
        }),
      },
    };

    fs.mkdirSync(path.join(workspacePath, path.dirname(publishedPath)), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, publishedPath), "# revised\n", "utf8");

    const artifacts: Artifact[] = [
      createArtifact({
        id: "artifact_delivery_v1" as any,
        instanceId: instance.id,
        nodeId: "delivery",
        kind: "delivery-pack",
        status: "draft",
        version: 1,
        payloadMode: "file",
        persistenceMode: "dual-write",
        workspaceStatus: "published",
        workspaceBaseDir: "codeflow-docs/功能/demo/交付整理",
        publishedPath,
        manifest: {
          summary: "初版交付",
          changedFiles: [publishedPath],
          files: [{ relPath: "delivery-note.md", summary: "初版说明" }],
        },
        contentJson: JSON.stringify({
          mode: "file",
          file: {
            path: publishedPath,
            content: "# draft\n",
            summary: "初版说明",
          },
          summary: "初版交付",
          changedFiles: [publishedPath],
        }),
      }),
    ];
    const artifactFiles: ArtifactFileEntry[] = [{
      id: "artifact_file_v1" as any,
      artifactId: "artifact_delivery_v1" as any,
      relPath: "delivery-note.md",
      stagingPath: null,
      publishedPath,
      status: "published",
      contentHash: "hash_v1",
      sizeBytes: 9,
      createdAt: 1,
      updatedAt: 1,
    }];
    const artifactFields: NodeResultField[] = [];
    const feedbackRecords: Array<Record<string, unknown>> = [];
    const orchEvents: Array<Record<string, unknown>> = [];
    const conversationEvents: Array<Record<string, unknown>> = [];

    const engine = new OrchestrationEngine({
      db: {
        orchInstances: {
          get(instanceId: string) {
            return instanceId === instance.id ? instance : null;
          },
          updateNodeStates(_instanceId: string, nodeStates: Record<string, NodeExecutionState>) {
            instance.nodeStates = nodeStates;
          },
          updateArtifactIndex(_instanceId: string, artifactIndex: Record<string, string[]>) {
            instance.artifactIndex = artifactIndex as any;
          },
        },
        orchFeedback: {
          create(input: Record<string, unknown>) {
            const record = { id: `feedback_${feedbackRecords.length + 1}`, ...input };
            feedbackRecords.push(record);
            return record;
          },
        },
        orchArtifacts: {
          listByInstance(instanceId: string) {
            return artifacts.filter((artifact) => artifact.instanceId === instanceId);
          },
          listByNode(instanceId: string, nodeId: string) {
            return artifacts.filter((artifact) => artifact.instanceId === instanceId && artifact.nodeId === nodeId);
          },
          get(artifactId: string) {
            return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
          },
          create(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">) {
            const artifact: Artifact = {
              ...input,
              id: `artifact_delivery_v${artifacts.length + 1}` as any,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            artifacts.push(artifact);
            return artifact;
          },
        },
        orchArtifactFiles: {
          listByArtifact(artifactId: string) {
            return artifactFiles.filter((entry) => entry.artifactId === artifactId);
          },
          replaceForArtifact(artifactId: string, entries: Array<Omit<ArtifactFileEntry, "id" | "createdAt" | "updatedAt" | "artifactId">>) {
            for (let index = artifactFiles.length - 1; index >= 0; index -= 1) {
              if (artifactFiles[index].artifactId === artifactId) artifactFiles.splice(index, 1);
            }
            const created = entries.map((entry, index) => ({
              ...entry,
              id: `artifact_file_${artifactFiles.length + index + 1}` as any,
              artifactId: artifactId as any,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }));
            artifactFiles.push(...created);
            return created;
          },
        },
        orchArtifactFields: {
          replaceForArtifact(artifactId: string, entries: Array<Omit<NodeResultField, "id" | "createdAt" | "updatedAt" | "artifactId">>) {
            for (let index = artifactFields.length - 1; index >= 0; index -= 1) {
              if (artifactFields[index].artifactId === artifactId) artifactFields.splice(index, 1);
            }
            const created = entries.map((entry, index) => ({
              ...entry,
              id: `artifact_field_${artifactFields.length + index + 1}` as any,
              artifactId: artifactId as any,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }));
            artifactFields.push(...created);
            return created;
          },
          listByArtifact(artifactId: string) {
            return artifactFields.filter((field) => field.artifactId === artifactId);
          },
        },
        orchRoles: {
          get(roleId: string) {
            return roleId === role.id ? role : null;
          },
        },
        orchEvents: {
          append(input: Record<string, unknown>) {
            const record = { id: `orch_event_${orchEvents.length + 1}`, createdAt: Date.now(), ...input };
            orchEvents.push(record);
            return record;
          },
        },
        threads: {
          get(threadId: string) {
            if (threadId !== "thread_delivery") return null;
            return {
              id: threadId as any,
              title: "交付整理",
              threadType: "orchestration",
              threadSubtype: "node",
              archived: false,
              createdAt: 1,
              updatedAt: 1,
              engine: "codex",
            };
          },
        },
      } as any,
      threads: {} as any,
      sessions: {} as any,
      workspaces: new Map([[instance.workspaceId, workspacePath]]),
      timeoutPolicy: {
        mode: "activity",
        startupTimeoutMs: 1_000,
        engineIdleTimeoutMs: 1_000,
      },
      emitConversation(event: Record<string, unknown>) {
        conversationEvents.push(event);
      },
      emitRaw() {},
    });

    const revised = engine.reviseArtifact(instance.id, "delivery", "artifact_delivery_v1" as any, {
      note: "人工补充了最终交付说明",
      answer: {
        mode: "file",
        file: {
          path: publishedPath,
          summary: "最终说明",
        },
        fields: {
          verificationSummary: "人工修订后已复核。",
        },
        summary: "交付已按人工意见修订",
        changedFiles: [publishedPath],
      },
    });

    const revisedPayload = JSON.parse(String(orchEvents.find((event) => event.type === "orchestration.artifactRevised")?.payloadJson ?? "{}"));
    const revisedContent = JSON.parse(String(revised.contentJson ?? "{}"));

    assert.equal(revised.version, 2);
    assert.equal(artifactFields.find((field) => field.artifactId === revised.id)?.fieldKey, "verificationSummary");
    assert.equal(revisedPayload.version, 2);
    assert.equal(revisedPayload.files?.[0]?.path, publishedPath);
    assert.equal(revisedPayload.files?.[0]?.summary, "最终说明");
    assert.equal(revisedPayload.note, "人工补充了最终交付说明");
    assert.equal(revisedPayload.changedFiles?.[0], publishedPath);
    assert.equal(revisedContent.file?.content, "# revised\n");
    assert.equal(feedbackRecords[0]?.action, "human_artifact_edit");
    assert.deepEqual(instance.nodeStates.delivery.activeFeedbackRecordIds, ["feedback_1" as any]);
    assert.ok(conversationEvents.some((event) =>
      event.type === "orchestration.artifactRevised"
      && (event.payload as Record<string, unknown>)?.artifactId === revised.id
      && !Object.prototype.hasOwnProperty.call((event.payload as Record<string, unknown>) ?? {}, "content")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});



