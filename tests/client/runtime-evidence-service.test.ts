import test from "node:test";
import assert from "node:assert/strict";

import type {
  Artifact,
  FeedbackRecord,
  NodePromptSnapshot,
  OrchestrationEventRecord,
  OrchestrationInstance,
} from "../../packages/shared/src/index.ts";
import { RuntimeEvidenceService } from "../../apps/desktop/client/src/orchestration/runtimeEvidenceService.ts";

function createInstance(): OrchestrationInstance {
  return {
    id: "orch-runtime-evidence" as any,
    workspaceId: "client-a:ws-demo" as any,
    workflowId: "wf-runtime-evidence" as any,
    proposalId: null,
    intakeSnapshot: {
      id: "intake-runtime-evidence" as any,
      workspaceId: "client-a:ws-demo" as any,
      triggerMode: "manual",
      taskType: "feature",
      title: "验证实例运行证据",
      goal: "验证实例运行证据",
      background: null,
      acceptanceCriteria: null,
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      constraints: null,
      requester: null,
      createdAt: 1,
      updatedAt: 1,
    },
    workflowSnapshot: {
      id: "wf-runtime-evidence" as any,
      workspaceId: "client-a:ws-demo" as any,
      family: "feature-dev",
      name: "运行证据验证流",
      description: "运行证据验证流",
      workflowKnowledgeBundleIds: [],
      nodes: [
        { id: "design", type: "role", roleId: "role-design" as any, label: "方案设计", position: { x: 0, y: 0 } },
        { id: "verification", type: "role", roleId: "role-verification" as any, label: "测试验证", position: { x: 0, y: 120 } },
      ],
      edges: [],
      version: 1,
    },
    roleSnapshots: {},
    toolsetSnapshots: {},
    runtimeConfig: null,
    artifactIndex: {},
    masterThreadId: "thread_master" as any,
    status: "running",
    nodeStates: {
      design: {
        nodeId: "design",
        status: "completed",
        threadId: "thread-design" as any,
        retryCount: 1,
        startedAt: 10,
        completedAt: 20,
        outputArtifactIds: ["artifact_design_v1", "artifact_design_v2"] as any,
        feedbackRecordIds: ["feedback_design_resume", "feedback_design_approve"] as any,
      },
      verification: {
        nodeId: "verification",
        status: "running",
        threadId: "thread-verification" as any,
        retryCount: 0,
        startedAt: 30,
        completedAt: null,
        outputArtifactIds: [],
        feedbackRecordIds: [],
      },
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
    contentJson: JSON.stringify({ text: input.kind }),
    metadata: {},
    persistenceMode: "db-only",
    payloadMode: "text",
    workspaceStatus: "none",
    workspaceBaseDir: null,
    stagingPath: null,
    publishedPath: null,
    contentHash: null,
    manifest: null,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function createPromptSnapshot(overrides: Partial<NodePromptSnapshot> = {}): NodePromptSnapshot {
  return {
    id: "snapshot_design_v2",
    instanceId: "orch-runtime-evidence" as any,
    nodeId: "design",
    attemptNo: 2,
    threadId: "thread-design" as any,
    turnId: "turn-design-2",
    engine: "codex",
    model: "gpt-5.4",
    effort: "medium",
    promptEnvelope: {
      schemaVersion: "node-prompt-envelope/v1",
      meta: {
        scene: "orchestration-node",
        instanceId: "orch-runtime-evidence" as any,
        workflowId: "wf-runtime-evidence" as any,
        workflowName: "运行证据验证流",
        nodeId: "design",
        nodeLabel: "方案设计",
        intent: "execute",
      },
      role: {
        roleId: "role-design" as any,
        name: "方案设计师",
        description: "输出方案",
        responsibility: "给出方案",
        systemPrompt: "您是方案设计师",
        formalTemplateName: "方案模板",
        inputDefinition: {
          instructions: "根据输入输出方案",
          requiredFields: [],
        },
        outputDefinition: {
          instructions: "输出方案",
          deliveryMode: "direct",
          format: "markdown",
          resultKey: "solution-plan",
          filePathRule: null,
          requiredFields: [],
        },
      },
      task: {
        title: "输出方案版本",
        titlePathSegment: "输出方案版本",
        goal: "输出方案版本 v2",
        background: null,
        acceptanceCriteria: null,
        renderedTaskInput: "先核对上游方案版本，再输出新方案。",
        fieldBindings: {},
      },
      artifacts: {
        upstreamArtifacts: [],
      },
      knowledge: {
        catalogs: [],
        warnings: [],
      },
      review: {
        feedbackPatch: null,
      },
      runtime: {
        runtimePolicy: {
          executionEngine: "codex",
          workflowId: "wf-runtime-evidence",
          workflowName: "运行证据验证流",
          nodeId: "design",
          nodeLabel: "方案设计",
          approvalMode: "manual",
          accessMode: "current",
          toolRuntimePolicy: {
            allowedToolIds: ["runtime.inspectInstanceEvidence"],
            requiresWorkspaceWrite: false,
          },
          artifactPolicy: {
            persistenceMode: "db-only",
            outputMode: "text",
            primaryKind: "solution-plan",
          },
        },
        toolRegistry: null,
      },
    },
    systemMessage: "您是方案设计师",
    developerMessage: "先核对上游方案版本，再输出新方案。",
    userMessage: "请输出方案版本: v2",
    renderedInputPreview: "[SYSTEM]\n您是方案设计师",
    runtimePolicy: {
      workflowId: "wf-runtime-evidence",
      workflowName: "运行证据验证流",
      nodeId: "design",
      nodeLabel: "方案设计",
      approvalMode: "manual",
      executionEngine: "codex",
      accessMode: "current",
      toolRuntimePolicy: {
        allowedToolIds: ["runtime.inspectInstanceEvidence"],
        requiresWorkspaceWrite: false,
      },
      artifactPolicy: {
        persistenceMode: "db-only",
        outputMode: "text",
        primaryKind: "solution-plan",
      },
    },
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [],
      fieldBindings: {},
    },
    createdAt: 20,
    ...overrides,
  };
}

function createFeedback(input: Partial<FeedbackRecord> & Pick<FeedbackRecord, "id" | "instanceId" | "nodeId" | "action">): FeedbackRecord {
  return {
    createdAt: 1,
    ...input,
  };
}

function createEvent(input: Partial<OrchestrationEventRecord> & Pick<OrchestrationEventRecord, "id" | "instanceId" | "type">): OrchestrationEventRecord {
  return {
    nodeId: null,
    payloadJson: "{}",
    createdAt: 1,
    ...input,
  };
}

function createService() {
  const instance = createInstance();
  const artifacts = [
    createArtifact({
      id: "artifact_design_v1" as any,
      instanceId: instance.id,
      nodeId: "design",
      kind: "solution-plan",
      version: 1,
      title: "方案 v1",
      status: "rejected",
      createdAt: 11,
      updatedAt: 21,
    }),
    createArtifact({
      id: "artifact_design_v2" as any,
      instanceId: instance.id,
      nodeId: "design",
      kind: "solution-plan",
      version: 2,
      title: "方案 v2",
      status: "approved",
      createdAt: 12,
      updatedAt: 22,
    }),
  ];
  const feedbackRecords = [
    createFeedback({
      id: "feedback_design_resume" as any,
      instanceId: instance.id,
      nodeId: "design",
      action: "resume_with_input",
      feedback: "请补上方案版本标记。",
      artifactIds: ["artifact_design_v1"] as any,
      createdAt: 23,
    }),
    createFeedback({
      id: "feedback_design_approve" as any,
      instanceId: instance.id,
      nodeId: "design",
      action: "approve",
      feedback: "方案通过。",
      artifactIds: ["artifact_design_v2"] as any,
      createdAt: 24,
    }),
  ];
  const promptSnapshots = [
    createPromptSnapshot({
      id: "snapshot_design_v1",
      attemptNo: 1,
      userMessage: "请先输出方案 v1",
      createdAt: 19,
    }),
    createPromptSnapshot(),
  ];
  const events = [
    createEvent({
      id: "event_start" as any,
      instanceId: instance.id,
      nodeId: "design",
      type: "orchestration.started",
      payloadJson: JSON.stringify({ stage: "start" }),
      createdAt: 10,
    }),
    createEvent({
      id: "event_design_running" as any,
      instanceId: instance.id,
      nodeId: "design",
      type: "orchestration.nodeStateChanged",
      payloadJson: JSON.stringify({ status: "running" }),
      createdAt: 11,
    }),
    createEvent({
      id: "event_design_completed" as any,
      instanceId: instance.id,
      nodeId: "design",
      type: "orchestration.nodeStateChanged",
      payloadJson: JSON.stringify({ status: "completed" }),
      createdAt: 22,
    }),
  ];

  const service = new RuntimeEvidenceService({
    db: {
      orchInstances: {
        get(instanceId: string) {
          return instanceId === instance.id ? instance : null;
        },
      },
      orchArtifacts: {
        listByInstance(instanceId: string) {
          return instanceId === instance.id ? artifacts : [];
        },
      },
      orchFeedback: {
        listByInstance(instanceId: string) {
          return instanceId === instance.id ? feedbackRecords : [];
        },
      },
      orchPromptSnapshots: {
        listByInstance(instanceId: string) {
          return instanceId === instance.id ? promptSnapshots : [];
        },
        listByNode(instanceId: string, nodeId: string) {
          return instanceId === instance.id ? promptSnapshots.filter((item) => item.nodeId === nodeId) : [];
        },
      },
      orchEvents: {
        listByInstance(instanceId: string) {
          return instanceId === instance.id ? events : [];
        },
      },
    } as any,
    instance,
  });

  return { service, instance };
}

test("RuntimeEvidenceService summary returns node states, artifact versions, feedback, and prompt attempts", async () => {
  const { service, instance } = createService();
  const [tool] = service.buildBuiltinTools();
  assert.equal(String(tool.toolId), "runtime.inspectInstanceEvidence");

  const result = await service.executeBuiltinTool(tool, { mode: "summary" });

  assert.equal(result.mode, "summary");
  const summaryResult = result as any;
  assert.equal(summaryResult.instanceId, instance.id);
  assert.equal(summaryResult.workflowName, "运行证据验证流");
  assert.equal(summaryResult.nodes.length, 2);
  const designNode = summaryResult.nodes.find((item: any) => item.nodeId === "design");
  assert.ok(designNode);
  assert.equal(designNode.status, "completed");
  assert.deepEqual(
    designNode.artifacts.map((item: any) => ({ version: item.version, status: item.status })),
    [
      { version: 1, status: "rejected" },
      { version: 2, status: "approved" },
    ],
  );
  assert.deepEqual(
    designNode.feedback.map((item: any) => item.action),
    ["resume_with_input", "approve"],
  );
  assert.deepEqual(
    designNode.promptSnapshots.map((item: any) => item.attemptNo),
    [1, 2],
  );
});

test("RuntimeEvidenceService prompt mode returns the selected prompt snapshot", async () => {
  const { service, instance } = createService();
  const [tool] = service.buildBuiltinTools();

  const result = await service.executeBuiltinTool(tool, {
    mode: "prompt",
    nodeId: "design",
    attemptNo: 2,
  });

  assert.equal(result.mode, "prompt");
  const promptResult = result as any;
  assert.equal(promptResult.instanceId, instance.id);
  assert.equal(promptResult.nodeId, "design");
  assert.equal(promptResult.selectedAttemptNo, 2);
  assert.equal(promptResult.totalAttempts, 2);
  assert.equal(promptResult.snapshot.promptSnapshotId, "snapshot_design_v2");
  assert.match(promptResult.snapshot.promptEnvelope.text, /node-prompt-envelope\/v1/);
  assert.match(promptResult.snapshot.messages.system.text, /方案设计师/);
  assert.match(promptResult.snapshot.messages.user.text, /方案版本: v2/);
});

test("RuntimeEvidenceService events mode filters by node and type", async () => {
  const { service, instance } = createService();
  const [tool] = service.buildBuiltinTools();

  const result = await service.executeBuiltinTool(tool, {
    mode: "events",
    nodeId: "design",
    eventTypes: ["orchestration.nodeStateChanged"],
    limit: 10,
  });

  assert.equal(result.mode, "events");
  const eventsResult = result as any;
  assert.equal(eventsResult.instanceId, instance.id);
  assert.deepEqual(eventsResult.eventTypes, ["orchestration.nodeStateChanged"]);
  assert.equal(eventsResult.events.length, 2);
  assert.ok(eventsResult.events.every((item: any) => item.nodeId === "design"));
  assert.ok(eventsResult.events.every((item: any) => item.type === "orchestration.nodeStateChanged"));
});
