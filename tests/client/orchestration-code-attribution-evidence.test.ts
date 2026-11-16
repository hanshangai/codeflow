import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EngineType, OrchestrationId, ThreadId, TurnId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { buildLocalCodeAttributionEvidence } from "../../apps/desktop/client/src/orchestration/codeAttributionEvidence.ts";

type EvidenceHarness = {
  root: string;
  db: ClientDb;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  instanceId: OrchestrationId;
  engine: EngineType;
};

/** 创建带单节点编排实例的隔离 Client SQLite 测试环境。 */
function createHarness(slug: string, engine: EngineType): EvidenceHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codeflow-code-attribution-${slug}-`));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = `ws-${slug}` as WorkspaceId;
  const threadId = `thread-${slug}` as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: slug, path: root });
  db.threads.create({
    id: threadId,
    workspaceId,
    engine,
    title: slug,
    threadType: "orchestration",
    threadSubtype: "node",
  });
  const instance = db.orchInstances.create({
    workspaceId,
    workflowId: `workflow-${slug}` as any,
    workflowSnapshot: {
      id: `workflow-${slug}`,
      workspaceId,
      name: slug,
      description: "",
      nodes: [{ id: "node-a", type: "role", label: "节点 A", roleId: "role-a", position: { x: 0, y: 0 } }],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    } as any,
    intakeSnapshot: {
      id: `intake-${slug}`,
      workspaceId,
      title: slug,
      goal: "测试代码归因",
      triggerMode: "manual",
      taskType: "test",
      createdAt: 1,
      updatedAt: 1,
    } as any,
  });
  return { root, db, workspaceId, threadId, instanceId: instance.id, engine };
}

/** 创建已结束 turn，并绑定唯一 Prompt Snapshot 与节点 Attempt。 */
function createExecution(
  harness: EvidenceHarness,
  input: { turnId: string; attemptNo: number; startSeq: number; endSeq: number; createdAt: number; threadId?: ThreadId },
): void {
  const turnId = input.turnId as TurnId;
  const threadId = input.threadId ?? harness.threadId;
  harness.db.turns.insertStarted({
    workspaceId: harness.workspaceId,
    threadId,
    engine: harness.engine,
    turnId,
    startedAt: input.createdAt,
    startEventSeq: input.startSeq,
  });
  harness.db.turns.setEnded(turnId, {
    status: "completed",
    endedAt: input.createdAt + 50,
    endEventSeq: input.endSeq,
  });
  const attempt = harness.db.orchNodeAttempts.begin({
    instanceId: harness.instanceId,
    nodeId: "node-a",
    attemptNo: input.attemptNo,
  });
  harness.db.orchNodeAttempts.bindExecution(attempt.id, threadId, turnId);
  harness.db.orchPromptSnapshots.create({
    instanceId: harness.instanceId,
    nodeId: "node-a",
    attemptNo: input.attemptNo,
    threadId,
    turnId,
    engine: harness.engine,
    model: "test-model",
    effort: null,
    promptEnvelope: {} as any,
    systemMessage: "system",
    developerMessage: null,
    userMessage: "user",
    renderedInputPreview: "preview",
    runtimePolicy: {} as any,
    toolRegistry: null,
    knowledgeCatalogs: [],
    artifactInput: {} as any,
    purpose: "node-execution",
    createdAt: input.createdAt,
  });
}

/** 写入 turn 文件前后快照，复用正式 Blob 与 FileChange 仓储。 */
function captureTextChange(
  harness: EvidenceHarness,
  input: { turnId: string; filePath: string; before: string | null; after: string | null; capturedAt: number; threadId?: ThreadId },
): void {
  const threadId = input.threadId ?? harness.threadId;
  const beforeBlobId = input.before == null ? null : harness.db.blobs.put(Buffer.from(input.before), "utf8");
  const afterBlobId = input.after == null ? null : harness.db.blobs.put(Buffer.from(input.after), "utf8");
  harness.db.fileChanges.captureBefore({
    threadId,
    turnId: input.turnId as TurnId,
    path: input.filePath,
    beforeExists: input.before != null,
    beforeBlobId,
    capturedAt: input.capturedAt,
  });
  harness.db.fileChanges.captureAfter({
    threadId,
    turnId: input.turnId as TurnId,
    path: input.filePath,
    afterExists: input.after != null,
    afterBlobId,
    capturedAt: input.capturedAt,
  });
}

/** 在同一工作区创建另一个编排节点线程，供跨线程顺序测试使用。 */
function createSiblingThread(harness: EvidenceHarness, suffix: string): ThreadId {
  const threadId = `thread-${suffix}` as ThreadId;
  harness.db.threads.create({
    id: threadId,
    workspaceId: harness.workspaceId,
    engine: harness.engine,
    title: suffix,
    threadType: "orchestration",
    threadSubtype: "node",
  });
  return threadId;
}

/** 关闭数据库并清理隔离目录。 */
function disposeHarness(harness: EvidenceHarness): void {
  harness.db.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("Codex 外置 aggregate diff 形成严格归属的逐文件候选行", () => {
  const harness = createHarness("codex-aggregate", "codex");
  try {
    createExecution(harness, { turnId: "turn-codex-1", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,3 @@",
      " const base = 0;",
      "+  repeat();",
      "+repeat();",
      "",
    ].join("\n");
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-1" as any,
        title: "Diff",
        diff,
        turnId: "turn-codex-1" as TurnId,
        engineTurnId: "provider-turn-1",
      },
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "complete");
    assert.equal(result.evaluatedTurnCount, 1);
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0]?.source, "codex_aggregate_diff");
    assert.equal(result.patches[0]?.path, "src/a.ts");
    assert.deepEqual(result.patches[0]?.addedLines, ["  repeat();", "repeat();"]);
    assert.equal(result.candidateFiles[0]?.candidateAddedLines.length, 2);
    assert.match(result.patches[0]?.localPathSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.ok(!result.patches[0]?.evidenceRef.includes(harness.root));
  } finally {
    disposeHarness(harness);
  }
});

test("Codex aggregate 中的二进制文件不阻断同 turn 文本证据", () => {
  const harness = createHarness("codex-binary-mixed", "codex");
  try {
    createExecution(harness, { turnId: "turn-codex-mixed", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    const diff = [
      "diff --git a/assets/image.bin b/assets/image.bin",
      "new file mode 100644",
      "Binary files /dev/null and b/assets/image.bin differ",
      "diff --git a/src/a.ts b/src/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/a.ts",
      "@@ -0,0 +1 @@",
      "+textEvidence();",
      "",
    ].join("\n");
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-mixed" as any,
        title: "Diff",
        diff,
        turnId: "turn-codex-mixed" as TurnId,
      },
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "partial");
    assert.deepEqual(result.qualityReasons, ["binary_file"]);
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0]?.path, "src/a.ts");
    assert.equal(result.issues[0]?.path, "assets/image.bin");
  } finally {
    disposeHarness(harness);
  }
});

test("Codex 外置 aggregate 正文缺失与内容损坏使用不同质量原因", () => {
  const harness = createHarness("codex-snapshot-missing", "codex");
  try {
    createExecution(harness, { turnId: "turn-codex-missing", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-missing" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+missing();\n",
        turnId: "turn-codex-missing" as TurnId,
      },
    });
    harness.db.db.prepare("DELETE FROM conversation_diff_snapshots WHERE event_seq = ?").run(15);

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.deepEqual(result.qualityReasons, ["patch_snapshot_missing"]);
    assert.equal(result.issues[0]?.code, "patch_snapshot_missing");
  } finally {
    disposeHarness(harness);
  }
});

test("多轮文件快照建立 supersedes 链并只保留当前有效 AI 候选行", () => {
  const harness = createHarness("snapshot-chain", "claude");
  try {
    createExecution(harness, { turnId: "turn-claude-1", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-claude-1",
      filePath: "src/a.ts",
      before: "const base = 0;\n",
      after: "const ai = 1;\nkeep();\n",
      capturedAt: 1_020,
    });
    createExecution(harness, { turnId: "turn-claude-2", attemptNo: 2, startSeq: 30, endSeq: 40, createdAt: 2_000 });
    captureTextChange(harness, {
      turnId: "turn-claude-2",
      filePath: "src/a.ts",
      before: "const ai = 1;\nkeep();\n",
      after: "keep();\nnewAi();\n",
      capturedAt: 2_020,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "complete");
    assert.equal(result.patches.length, 2);
    assert.equal(result.patches[1]?.supersedesPatchId, result.patches[0]?.patchId);
    assert.deepEqual(result.candidateFiles[0]?.candidateAddedLines, ["keep();", "newAi();"]);
    assert.deepEqual(result.candidateFiles[0]?.patchIds, result.patches.map((patch) => patch.patchId));
  } finally {
    disposeHarness(harness);
  }
});

test("Codex 外置正文损坏时显式标记部分数据并使用完整 Blob 证据", () => {
  const harness = createHarness("codex-corrupt-fallback", "codex");
  try {
    createExecution(harness, { turnId: "turn-codex-corrupt", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromDiff();\n";
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-corrupt" as any,
        title: "Diff",
        diff,
        turnId: "turn-codex-corrupt" as TurnId,
      },
    });
    harness.db.db.prepare("UPDATE conversation_diff_snapshots SET diff_text = ? WHERE event_seq = ?")
      .run("corrupted", 15);
    captureTextChange(harness, {
      turnId: "turn-codex-corrupt",
      filePath: "src/a.ts",
      before: null,
      after: "fromBlob();\n",
      capturedAt: 1_030,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "partial");
    assert.deepEqual(result.qualityReasons, ["patch_snapshot_corrupt"]);
    assert.equal(result.patches[0]?.source, "turn_file_snapshot");
    assert.deepEqual(result.candidateFiles[0]?.candidateAddedLines, ["fromBlob();"]);
    assert.match(result.issues[0]?.message ?? "", /正文与引用摘要不一致/u);
  } finally {
    disposeHarness(harness);
  }
});

test("缺失 Blob 显式形成不可用质量原因", () => {
  const harness = createHarness("missing-blob", "claude");
  try {
    createExecution(harness, { turnId: "turn-missing-blob", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.fileChanges.captureBefore({
      threadId: harness.threadId,
      turnId: "turn-missing-blob" as TurnId,
      path: "src/missing.ts",
      beforeExists: false,
      beforeBlobId: null,
      capturedAt: 1_020,
    });
    harness.db.fileChanges.captureAfter({
      threadId: harness.threadId,
      turnId: "turn-missing-blob" as TurnId,
      path: "src/missing.ts",
      afterExists: true,
      afterBlobId: "a".repeat(64),
      capturedAt: 1_020,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.evaluatedTurnCount, 0);
    assert.deepEqual(result.qualityReasons, ["patch_snapshot_missing"]);
    assert.equal(result.issues[0]?.code, "patch_snapshot_missing");
    assert.equal(result.patches.length, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("二进制文件不进入候选行并保留明确排除原因", () => {
  const harness = createHarness("binary", "claude");
  try {
    createExecution(harness, { turnId: "turn-binary", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    const binaryBlobId = harness.db.blobs.put(Buffer.from([0, 1, 2, 3]), "binary");
    harness.db.fileChanges.captureBefore({
      threadId: harness.threadId,
      turnId: "turn-binary" as TurnId,
      path: "assets/image.bin",
      beforeExists: false,
      beforeBlobId: null,
      capturedAt: 1_020,
    });
    harness.db.fileChanges.captureAfter({
      threadId: harness.threadId,
      turnId: "turn-binary" as TurnId,
      path: "assets/image.bin",
      afterExists: true,
      afterBlobId: binaryBlobId,
      capturedAt: 1_020,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "partial");
    assert.equal(result.evaluatedTurnCount, 1);
    assert.deepEqual(result.qualityReasons, ["binary_file"]);
    assert.equal(result.issues[0]?.code, "binary_file");
  } finally {
    disposeHarness(harness);
  }
});

test("未知 Blob 编码按快照损坏处理而不是误报为二进制", () => {
  const harness = createHarness("invalid-blob-encoding", "claude");
  try {
    createExecution(harness, { turnId: "turn-invalid-encoding", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-invalid-encoding",
      filePath: "src/a.ts",
      before: null,
      after: "fromAi();\n",
      capturedAt: 1_020,
    });
    harness.db.db.prepare("UPDATE file_blobs SET encoding = 'unknown' WHERE encoding = 'utf8'").run();

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
    assert.deepEqual(result.qualityReasons, ["patch_snapshot_corrupt"]);
  } finally {
    disposeHarness(harness);
  }
});

test("Codex 删除文件会清空历史候选行并按执行序号建立取代链", () => {
  const harness = createHarness("codex-delete-chain", "codex");
  try {
    createExecution(harness, { turnId: "turn-codex-create", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_050,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-create" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+aiOriginal();\n",
        turnId: "turn-codex-create" as TurnId,
      },
    });
    createExecution(harness, { turnId: "turn-codex-delete", attemptNo: 2, startSeq: 30, endSeq: 40, createdAt: 2_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 35,
      ts: 1_050,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-delete" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-manualReplacement();\n",
        turnId: "turn-codex-delete" as TurnId,
      },
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.deepEqual(result.patches.map((patch) => patch.turnId), ["turn-codex-create", "turn-codex-delete"]);
    assert.equal(result.patches[1]?.supersedesPatchId, result.patches[0]?.patchId);
    assert.deepEqual(result.candidateFiles[0]?.candidateAddedLines, []);
  } finally {
    disposeHarness(harness);
  }
});

test("Codex aggregate 拒绝未外置正文和越过工作区的路径", () => {
  const inlineHarness = createHarness("codex-inline", "codex");
  try {
    createExecution(inlineHarness, { turnId: "turn-codex-inline", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    inlineHarness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: inlineHarness.workspaceId,
      threadId: inlineHarness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-inline" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+inline();\n",
        turnId: "turn-codex-inline" as TurnId,
      },
    });
    const row = inlineHarness.db.db.prepare("SELECT event_json FROM conversation_events WHERE seq = 15").get() as { event_json: string };
    const envelope = JSON.parse(row.event_json) as any;
    envelope.payload.diff = "inline";
    delete envelope.payload.diffRef;
    inlineHarness.db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE seq = 15").run(JSON.stringify(envelope));

    const result = buildLocalCodeAttributionEvidence(inlineHarness.db, { instanceId: inlineHarness.instanceId });
    assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
    assert.match(result.issues[0]?.message ?? "", /缺少外置正文引用/u);
  } finally {
    disposeHarness(inlineHarness);
  }

  const traversalHarness = createHarness("codex-traversal", "codex");
  try {
    createExecution(traversalHarness, { turnId: "turn-codex-traversal", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    traversalHarness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: traversalHarness.workspaceId,
      threadId: traversalHarness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-codex-traversal" as any,
        title: "Diff",
        diff: "diff --git a/../../outside.ts b/../../outside.ts\n--- a/../../outside.ts\n+++ b/../../outside.ts\n@@ -0,0 +1 @@\n+outside();\n",
        turnId: "turn-codex-traversal" as TurnId,
      },
    });

    const result = buildLocalCodeAttributionEvidence(traversalHarness.db, { instanceId: traversalHarness.instanceId });
    assert.equal(result.issues[0]?.code, "patch_path_invalid");
    assert.ok(!result.issues[0]?.message.includes("outside.ts"));
    assert.equal(result.issues[0]?.path, null);
  } finally {
    disposeHarness(traversalHarness);
  }
});

test("未知 aggregate 读取异常必须向上抛出", () => {
  const harness = createHarness("aggregate-runtime-error", "codex");
  try {
    createExecution(harness, { turnId: "turn-runtime-error", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-runtime-error" as any,
        title: "Diff",
        diff: "",
        turnId: "turn-runtime-error" as TurnId,
      },
    });
    harness.db.conversationEvents.getDiffEventBySeq = (() => {
      throw new Error("database unavailable");
    }) as typeof harness.db.conversationEvents.getDiffEventBySeq;

    assert.throws(
      () => buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId }),
      /database unavailable/u,
    );
  } finally {
    disposeHarness(harness);
  }
});

test("Codex aggregate 与完整 Blob 一致时使用 Blob 裁剪候选状态", () => {
  const harness = createHarness("aggregate-blob-match", "codex");
  try {
    createExecution(harness, { turnId: "turn-match", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-match" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromAi();\n",
        turnId: "turn-match" as TurnId,
      },
    });
    captureTextChange(harness, {
      turnId: "turn-match",
      filePath: "src/a.ts",
      before: null,
      after: "fromAi();\n",
      capturedAt: 1_025,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "complete");
    assert.equal(result.patches[0]?.source, "codex_aggregate_diff");
    assert.deepEqual(result.candidateFiles[0]?.candidateAddedLines, ["fromAi();"]);
  } finally {
    disposeHarness(harness);
  }
});

test("Codex aggregate 与完整 Blob 冲突时不输出伪确定候选", () => {
  const harness = createHarness("aggregate-blob-conflict", "codex");
  try {
    createExecution(harness, { turnId: "turn-conflict", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-conflict" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromDiff();\n",
        turnId: "turn-conflict" as TurnId,
      },
    });
    captureTextChange(harness, {
      turnId: "turn-conflict",
      filePath: "src/a.ts",
      before: null,
      after: "fromBlob();\n",
      capturedAt: 1_025,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.deepEqual(result.qualityReasons, ["ambiguous_attribution"]);
    assert.equal(result.issues[0]?.code, "patch_evidence_conflict");
    assert.equal(result.patches.length, 0);
    assert.equal(result.candidateFiles.length, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("跨线程顺序使用执行时间而不是各线程内部事件序号", () => {
  const harness = createHarness("cross-thread-order", "claude");
  try {
    const siblingThreadId = createSiblingThread(harness, "cross-thread-order-2");
    createExecution(harness, { turnId: "turn-first", attemptNo: 1, startSeq: 100, endSeq: 110, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-first",
      filePath: "src/a.ts",
      before: null,
      after: "first();\n",
      capturedAt: 1_020,
    });
    createExecution(harness, {
      turnId: "turn-second",
      attemptNo: 2,
      startSeq: 10,
      endSeq: 20,
      createdAt: 2_000,
      threadId: siblingThreadId,
    });
    captureTextChange(harness, {
      turnId: "turn-second",
      filePath: "src/a.ts",
      before: "first();\n",
      after: "first();\nsecond();\n",
      capturedAt: 2_020,
      threadId: siblingThreadId,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "complete");
    assert.deepEqual(result.patches.map((patch) => patch.turnId), ["turn-first", "turn-second"]);
    assert.equal(result.patches[1]?.supersedesPatchId, result.patches[0]?.patchId);
    assert.deepEqual(result.candidateFiles[0]?.candidateAddedLines, ["first();", "second();"]);
  } finally {
    disposeHarness(harness);
  }
});

test("跨线程并发修改同一路径时不建立取代链", () => {
  const harness = createHarness("cross-thread-overlap", "claude");
  try {
    const siblingThreadId = createSiblingThread(harness, "cross-thread-overlap-2");
    createExecution(harness, { turnId: "turn-overlap-a", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-overlap-a",
      filePath: "src/a.ts",
      before: null,
      after: "left();\n",
      capturedAt: 1_020,
    });
    createExecution(harness, {
      turnId: "turn-overlap-b",
      attemptNo: 2,
      startSeq: 30,
      endSeq: 40,
      createdAt: 1_020,
      threadId: siblingThreadId,
    });
    captureTextChange(harness, {
      turnId: "turn-overlap-b",
      filePath: "src/a.ts",
      before: null,
      after: "right();\n",
      capturedAt: 1_030,
      threadId: siblingThreadId,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "partial");
    assert.deepEqual(result.qualityReasons, ["ambiguous_attribution"]);
    assert.ok(result.patches.every((patch) => patch.supersedesPatchId === null));
    assert.equal(result.candidateFiles.length, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("aggregate 数据库行与事件正文身份漂移时显式拒绝", () => {
  const harness = createHarness("aggregate-identity-drift", "codex");
  try {
    createExecution(harness, { turnId: "turn-drift", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-drift" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+drift();\n",
        turnId: "turn-drift" as TurnId,
      },
    });
    const row = harness.db.db.prepare("SELECT event_json FROM conversation_events WHERE seq = 15").get() as { event_json: string };
    const envelope = JSON.parse(row.event_json) as any;
    envelope.workspaceId = "ws-drifted";
    harness.db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE seq = 15").run(JSON.stringify(envelope));

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
    assert.match(result.issues[0]?.message ?? "", /数据库行与事件身份不一致/u);
  } finally {
    disposeHarness(harness);
  }
});

test("aggregate 拒绝与创建操作矛盾或区间重叠的 Hunk", () => {
  const cases = [
    {
      slug: "invalid-create-hunk",
      diff: "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old();\n+new();\n",
    },
    {
      slug: "overlapping-hunks",
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-oldA();\n+newA();\n@@ -1 +1 @@\n-oldB();\n+newB();\n",
    },
  ];
  for (const testCase of cases) {
    const harness = createHarness(testCase.slug, "codex");
    try {
      createExecution(harness, { turnId: `turn-${testCase.slug}`, attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 15,
        ts: 1_020,
        workspaceId: harness.workspaceId,
        threadId: harness.threadId,
        engine: "codex",
        type: "item.diff.created",
        payload: {
          itemId: `diff-${testCase.slug}` as any,
          title: "Diff",
          diff: testCase.diff,
          turnId: `turn-${testCase.slug}` as TurnId,
        },
      });

      const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
      assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
      assert.equal(result.patches.length, 0);
    } finally {
      disposeHarness(harness);
    }
  }
});

test("规范 Patch 不保留原始 Header 中的本机路径", () => {
  const harness = createHarness("canonical-header", "codex");
  try {
    createExecution(harness, { turnId: "turn-header", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-header" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\tC:/Users/Alice/private\n+++ b/src/a.ts\tC:/Users/Alice/private\n@@ -0,0 +1 @@\n+safe();\n",
        turnId: "turn-header" as TurnId,
      },
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "complete");
    assert.ok(!result.patches[0]?.patchText.includes("Alice"));
    assert.ok(!result.patches[0]?.patchText.includes("private"));
  } finally {
    disposeHarness(harness);
  }
});

test("Prompt Snapshot 与 thread 真源漂移时拒绝执行归属", () => {
  const harness = createHarness("thread-identity-drift", "claude");
  try {
    createExecution(harness, { turnId: "turn-thread-drift", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-thread-drift",
      filePath: "src/a.ts",
      before: null,
      after: "fromAi();\n",
      capturedAt: 1_020,
    });
    harness.db.db.prepare("UPDATE threads SET engine = 'codex' WHERE id = ?").run(harness.threadId);

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.issues[0]?.code, "execution_association_mismatch");
    assert.match(result.issues[0]?.message ?? "", /thread 执行身份不一致/u);
  } finally {
    disposeHarness(harness);
  }
});

test("aggregate 外置快照身份字段漂移时显式拒绝", () => {
  const mutations = [
    ["diff-key", "UPDATE conversation_diff_snapshots SET diff_key = 'turn:other' WHERE event_seq = 15"],
    ["updated-at", "UPDATE conversation_diff_snapshots SET updated_at = updated_at + 1 WHERE event_seq = 15"],
  ] as const;
  for (const [slug, mutation] of mutations) {
    const harness = createHarness(`snapshot-identity-${slug}`, "codex");
    try {
      createExecution(harness, { turnId: `turn-${slug}`, attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
      harness.db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 15,
        ts: 1_020,
        workspaceId: harness.workspaceId,
        threadId: harness.threadId,
        engine: "codex",
        type: "item.diff.created",
        payload: {
          itemId: `diff-${slug}` as any,
          title: "Diff",
          diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromAi();\n",
          turnId: `turn-${slug}` as TurnId,
        },
      });
      harness.db.db.prepare(mutation).run();

      const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
      assert.equal(result.qualityStatus, "unavailable");
      assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
      assert.match(result.issues[0]?.message ?? "", /外置正文与事件身份不一致/u);
    } finally {
      disposeHarness(harness);
    }
  }
});

test("aggregate 尾随未识别文本不能被 parsePatch 静默忽略", () => {
  const harness = createHarness("aggregate-trailing-text", "codex");
  try {
    createExecution(harness, { turnId: "turn-trailing", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-trailing" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromAi();\nignored trailing prose\n",
        turnId: "turn-trailing" as TurnId,
      },
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.issues[0]?.code, "patch_snapshot_corrupt");
    assert.match(result.issues[0]?.message ?? "", /结构无效/u);
  } finally {
    disposeHarness(harness);
  }
});

test("aggregate 文本与 Blob 二进制判定冲突时不输出文本候选", () => {
  const harness = createHarness("aggregate-text-blob-binary", "codex");
  try {
    createExecution(harness, { turnId: "turn-binary-conflict", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 15,
      ts: 1_020,
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      type: "item.diff.created",
      payload: {
        itemId: "diff-binary-conflict" as any,
        title: "Diff",
        diff: "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+fromDiff();\n",
        turnId: "turn-binary-conflict" as TurnId,
      },
    });
    const binaryBlobId = harness.db.blobs.put(Buffer.from([0, 1, 2, 3]), "binary");
    harness.db.fileChanges.captureBefore({
      threadId: harness.threadId,
      turnId: "turn-binary-conflict" as TurnId,
      path: "src/a.ts",
      beforeExists: false,
      beforeBlobId: null,
      capturedAt: 1_025,
    });
    harness.db.fileChanges.captureAfter({
      threadId: harness.threadId,
      turnId: "turn-binary-conflict" as TurnId,
      path: "src/a.ts",
      afterExists: true,
      afterBlobId: binaryBlobId,
      capturedAt: 1_025,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.deepEqual(result.qualityReasons, ["ambiguous_attribution", "binary_file"]);
    assert.equal(result.patches.length, 0);
    assert.equal(result.candidateFiles.length, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("文件快照路径含控制字符时不生成可注入 Header 的 Patch", () => {
  const harness = createHarness("snapshot-control-path", "claude");
  try {
    createExecution(harness, { turnId: "turn-control-path", attemptNo: 1, startSeq: 10, endSeq: 20, createdAt: 1_000 });
    captureTextChange(harness, {
      turnId: "turn-control-path",
      filePath: "src/evil\tname.ts",
      before: null,
      after: "fromAi();\n",
      capturedAt: 1_020,
    });

    const result = buildLocalCodeAttributionEvidence(harness.db, { instanceId: harness.instanceId });
    assert.equal(result.qualityStatus, "unavailable");
    assert.equal(result.issues[0]?.code, "patch_path_invalid");
    assert.equal(result.issues[0]?.path, null);
    assert.equal(result.patches.length, 0);
  } finally {
    disposeHarness(harness);
  }
});
