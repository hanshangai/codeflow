import test from "node:test";
import assert from "node:assert/strict";

import { resolveOrchestrationUserFacingMessage, type NodeExecutionState } from "../../packages/shared/src/index.ts";
import {
  requiresStructuredNodeThreadAction,
  resolveNodeWorkbenchDescriptor,
} from "../../apps/web/src/features/orchestration/node-workbench.ts";

test("node thread accepts text for resumable feedback and guards non-guessable actions", () => {
  for (const humanActionSource of ["execution", "human_input", "review", "gate"] as const) {
    assert.equal(requiresStructuredNodeThreadAction({
      status: "waiting-feedback",
      humanActionSource,
    }), false, `${humanActionSource} feedback should accept text`);
  }

  for (const humanActionSource of ["branch_decision", "approval", undefined] as const) {
    assert.equal(requiresStructuredNodeThreadAction({
      status: "waiting-feedback",
      humanActionSource,
    }), true, `${humanActionSource ?? "missing"} feedback should require a structured action`);
  }

  assert.equal(requiresStructuredNodeThreadAction({
    status: "waiting-feedback",
    humanActionSource: "future_action" as any,
  }), true, "unknown feedback sources must not be guessed");
  assert.equal(requiresStructuredNodeThreadAction({
    status: "waiting-approval",
    humanActionSource: "execution",
  }), true, "approval always requires an explicit action");
  assert.equal(requiresStructuredNodeThreadAction({
    status: "waiting-start",
    humanActionSource: undefined,
  }), true, "manual start requires an explicit start or skip action");
  assert.equal(requiresStructuredNodeThreadAction({
    status: "running",
    humanActionSource: "branch_decision",
  }), false, "non-waiting states keep the normal node conversation input");
});

test("manual start wait exposes start action without chat preference", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "dev",
    status: "waiting-start",
    retryCount: 0,
    error: "等待人工启动节点",
  } satisfies NodeExecutionState);

  assert.equal(descriptor.preferredView, "detail");
  assert.equal(descriptor.statusLabel, "待启动");
  assert.equal(descriptor.actionLabel, "启动节点");
  assert.equal(descriptor.bannerText, "当前节点已满足前置条件，等待人工启动");
});

test("node workbench converts frozen-input diagnostics into a plain-language message", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "kb-review",
    status: "waiting-start",
    retryCount: 0,
    error: "请先恢复或重新生成同一 run 的完整冻结输入快照，并确认 manifest 与 source 文件集合一致；恢复后从当前 sqliteDb in_progress 工作项继续，不要重建看板。",
  } satisfies NodeExecutionState);

  assert.equal(
    descriptor.detailLabel,
    "当前节点暂时读不到已保存资料。请不要重跑或新建流程，当前进度会保留。",
  );
  assert.doesNotMatch(descriptor.detailLabel ?? "", /run|manifest|source|sqliteDb|in_progress|看板|平台处理|平台这边/u);
});

test("node workbench keeps ordinary business reasons readable", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "review",
    status: "waiting-feedback",
    humanActionSource: "human_input",
    retryCount: 0,
    conclusion: {
      nextAction: "ask_human",
      reviewVerdict: "partial",
      summary: "请补充部署环境与目标端口",
      blockingIssues: null,
      acceptanceChecks: null,
      humanInput: {
        summary: "请补充部署环境与目标端口",
        fields: null,
      },
      rework: null,
      decidedBy: "model",
      decidedAt: 1,
    },
  } satisfies NodeExecutionState);

  assert.equal(descriptor.detailLabel, "请补充部署环境与目标端口");
});

test("node workbench does not turn deterministic internal errors into a user input request", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "review",
    status: "waiting-feedback",
    humanActionSource: "human_input",
    retryCount: 0,
    conclusion: {
      nextAction: "ask_human",
      reviewVerdict: "partial",
      summary: "acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）",
      blockingIssues: null,
      acceptanceChecks: null,
      humanInput: {
        summary: "acceptanceCriteria 为空，Host 拒绝 runtime.workItems.complete（WORK_ITEM_TOOL_FAILED）",
        fields: null,
      },
      rework: null,
      decidedBy: "model",
      decidedAt: 1,
    },
  } satisfies NodeExecutionState);

  assert.equal(descriptor.attentionKind, "execution_error");
  assert.equal(descriptor.statusLabel, "系统处理中");
  assert.equal(descriptor.actionLabel, "查看进度");
  assert.match(descriptor.detailLabel ?? "", /自动校对当前节点并重试/);
});

test("known orchestration diagnostics use short recovery guidance", () => {
  assert.equal(
    resolveOrchestrationUserFacingMessage("WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED", "默认提示"),
    "系统正在整理当前节点的处理上下文，会继续使用原来的工作项和进度。你现在不用操作，已完成内容会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage("snapshot_verify_failed", "默认提示"),
    "当前节点暂时读不到已保存资料。请不要重跑或新建流程，当前进度会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage(
      "本轮资料检查发现问题，需要先修复固定资料。修复后会从当前进度继续，已经完成的内容不会丢失或重做。",
      "默认提示",
    ),
    "当前节点暂时读不到已保存资料。请不要重跑或新建流程，当前进度会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage("assetRuntimeSnapshot.knowledgeBundles.bundle.definition.scope 非法", "默认提示"),
    "当前节点暂时读不到知识库设置。请不要重跑或新建流程，当前进度会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage("验收条件为空", "默认提示"),
    "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage("请联系系统管理员或开发人员，由他们在后台修复；修复后回到原流程点击继续", "默认提示"),
    "系统会先自动校对当前节点并重试。你现在不用操作，已完成内容会保留。",
  );
  assert.equal(
    resolveOrchestrationUserFacingMessage("请补充部署环境与目标端口", "默认提示"),
    "请补充部署环境与目标端口",
  );
});

test("execution interruption prefers chat and exposes recovery wording", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "ui",
    status: "waiting-feedback",
    humanActionSource: "execution",
    retryCount: 0,
    error: "stream disconnected before completion",
    threadId: "thread-ui" as any,
  } satisfies NodeExecutionState);

  assert.equal(descriptor.preferredView, "chat");
  assert.equal(descriptor.statusLabel, "异常中断");
  assert.equal(descriptor.actionLabel, "查看异常会话");
  assert.equal(descriptor.bannerText, "会话异常中断，建议先查看会话与错误信息");
});

test("human input request prefers detail-first processing", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "arc",
    status: "waiting-feedback",
    humanActionSource: "human_input",
    retryCount: 0,
    conclusion: {
      nextAction: "ask_human",
      reviewVerdict: "partial",
      summary: "还缺少部署环境说明",
      blockingIssues: null,
      acceptanceChecks: null,
      humanInput: {
        summary: "请补充部署环境与目标端口",
        fields: null,
      },
      rework: null,
      decidedBy: "model",
      decidedAt: 1,
    },
  } satisfies NodeExecutionState);

  assert.equal(descriptor.preferredView, "detail");
  assert.equal(descriptor.statusLabel, "待补充");
  assert.equal(descriptor.actionLabel, "补充信息并继续");
  assert.equal(descriptor.detailLabel, "请补充部署环境与目标端口");
});

test("manual approval with rework suggestion keeps result-first decision flow", () => {
  const descriptor = resolveNodeWorkbenchDescriptor({
    nodeId: "prd",
    status: "waiting-approval",
    humanActionSource: "approval",
    retryCount: 0,
    outputArtifactIds: ["artifact-prd"] as any,
    conclusion: {
      nextAction: "rework",
      reviewVerdict: "partial",
      summary: "建议先退回补齐边界条件",
      blockingIssues: null,
      acceptanceChecks: null,
      humanInput: null,
      rework: {
        targetNodeId: "start",
        reason: "边界条件还不完整",
      },
      decidedBy: "model",
      decidedAt: 1,
    },
  } satisfies NodeExecutionState);

  assert.equal(descriptor.preferredView, "detail");
  assert.equal(descriptor.statusLabel, "待确认退回");
  assert.equal(descriptor.actionLabel, "查看结果并决策");
});
