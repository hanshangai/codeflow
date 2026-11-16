import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { OrchestrationId, ThreadId, TurnId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import {
  CodeAttributionOutboxRepoError,
  hashCodeAttributionOutboxPayload,
} from "../../apps/desktop/client/src/db/repos/codeAttributionOutboxRepo.ts";
import { CodeAttributionRetentionTaskRepoError } from "../../apps/desktop/client/src/db/repos/codeAttributionRetentionTaskRepo.ts";
import { readCommitAttributionSnapshot } from "../../apps/desktop/client/src/git/gitService.ts";
import {
  collectCodeAttributionCommit,
  CodeAttributionCommitServiceError,
} from "../../apps/desktop/client/src/orchestration/codeAttributionCommitService.ts";

type CommitHarness = {
  root: string;
  workspacePath: string;
  repositoryPath: string;
  repositoryRoot: string;
  db: ClientDb;
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
};

/** Creates one isolated Client workspace with an optional nested Git repository. */
function createHarness(slug: string, repositoryPath = ""): CommitHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codeflow-code-commit-${slug}-`));
  const workspacePath = path.join(root, "workspace");
  const repositoryRoot = repositoryPath ? path.join(workspacePath, ...repositoryPath.split("/")) : workspacePath;
  fs.mkdirSync(repositoryRoot, { recursive: true });
  initGitRepository(repositoryRoot);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = `ws-${slug}` as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: slug, path: workspacePath });
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
      goal: "验证 commit 代码归因",
      triggerMode: "manual",
      taskType: "test",
      createdAt: 1,
      updatedAt: 1,
    } as any,
  });
  return { root, workspacePath, repositoryPath, repositoryRoot, db, workspaceId, instanceId: instance.id };
}

/** Initializes deterministic Git author settings without using global configuration. */
function initGitRepository(repositoryRoot: string): void {
  runGit(repositoryRoot, ["init", "--initial-branch=main"]);
  runGit(repositoryRoot, ["config", "user.name", "CodeFlow Test"]);
  runGit(repositoryRoot, ["config", "user.email", "codeflow-test@example.invalid"]);
}

/** Executes one fixture Git command and returns trimmed stdout. */
function runGit(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
}

/** Writes one repository-relative fixture file, preserving binary buffers. */
function writeRepoFile(repositoryRoot: string, relativePath: string, content: string | Buffer): void {
  const filePath = path.join(repositoryRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Commits exactly the listed fixture paths and returns the full immutable SHA. */
function commitPaths(repositoryRoot: string, message: string, paths: string[]): string {
  runGit(repositoryRoot, ["add", "-A", "--", ...paths]);
  runGit(repositoryRoot, ["commit", "-m", message]);
  return runGit(repositoryRoot, ["rev-parse", "HEAD"]);
}

/** Adds one completed orchestration turn and its before/after file snapshots. */
function addAiEvidence(
  harness: CommitHarness,
  changes: Array<{ workspaceRelativePath: string; before: string | null; after: string | null }>,
  suffix = "a",
): void {
  const threadId = `thread-${suffix}` as ThreadId;
  const turnId = `turn-${suffix}` as TurnId;
  harness.db.threads.create({
    id: threadId,
    workspaceId: harness.workspaceId,
    engine: "claude",
    title: suffix,
    threadType: "orchestration",
    threadSubtype: "node",
  });
  harness.db.turns.insertStarted({
    workspaceId: harness.workspaceId,
    threadId,
    engine: "claude",
    turnId,
    startedAt: 1_000,
    startEventSeq: 10,
  });
  harness.db.turns.setEnded(turnId, { status: "completed", endedAt: 1_100, endEventSeq: 20 });
  const attempt = harness.db.orchNodeAttempts.begin({ instanceId: harness.instanceId, nodeId: "node-a", attemptNo: 1 });
  harness.db.orchNodeAttempts.bindExecution(attempt.id, threadId, turnId);
  harness.db.orchPromptSnapshots.create({
    instanceId: harness.instanceId,
    nodeId: "node-a",
    attemptNo: 1,
    threadId,
    turnId,
    engine: "claude",
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
    createdAt: 1_000,
  });
  for (const change of changes) {
    const beforeBlobId = change.before === null ? null : harness.db.blobs.put(Buffer.from(change.before), "utf8");
    const afterBlobId = change.after === null ? null : harness.db.blobs.put(Buffer.from(change.after), "utf8");
    harness.db.fileChanges.captureBefore({
      threadId,
      turnId,
      path: change.workspaceRelativePath,
      beforeExists: change.before !== null,
      beforeBlobId,
      capturedAt: 1_020,
    });
    harness.db.fileChanges.captureAfter({
      threadId,
      turnId,
      path: change.workspaceRelativePath,
      afterExists: change.after !== null,
      afterBlobId,
      capturedAt: 1_030,
    });
  }
}

/** Builds one fresh explicit instance association for local collection tests. */
function collectInput(harness: CommitHarness, commitSha: string, now = 10_000) {
  return {
    workspaceId: harness.workspaceId,
    repositoryPath: harness.repositoryPath || null,
    commitSha,
    instanceId: harness.instanceId,
    associationId: `association-${commitSha.slice(0, 12)}`,
    associationExpiresAt: now + 60_000,
  };
}

/** Closes the local DB and removes every temporary Git fixture. */
function disposeHarness(harness: CommitHarness): void {
  harness.db.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("显式commit归因只在同步许可读取证据与原子落库，Git等待不占许可", async () => {
  const harness = createHarness("database-permit");
  let permitted = false, leases = 0;
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "enabled();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "guard", ["src/a.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/a.ts", before: null, after: "enabled();\n" }]);
    harness.db.db.setAccessGuard!(() => assert.equal(permitted, true, "归因仓储越过同步许可"));
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000,
      async withDatabase(operation) {
        assert.equal(permitted, false); permitted = true; leases++;
        try { const value = operation(); assert.equal(Boolean(value && typeof (value as any).then === "function"), false); return value; }
        finally { permitted = false; }
      },
    });
    assert.equal(receipt.factCount, 1);
    assert.ok(leases >= 4);
  } finally { harness.db.db.setAccessGuard!(null); disposeHarness(harness); }
});

test("根提交在嵌套仓库中形成重复行保真的脱敏归因批次", async () => {
  const harness = createHarness("root-nested", "packages/repo");
  try {
    const source = "  repeat();\nrepeat();\nmanual();\n";
    writeRepoFile(harness.repositoryRoot, "src/a.ts", source);
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    runGit(harness.repositoryRoot, ["remote", "add", "origin", "https://alice:secret@example.com/org/repo.git?token=hidden"]);
    addAiEvidence(harness, [{
      workspaceRelativePath: "packages/repo/src/a.ts",
      before: null,
      after: "  repeat();\nrepeat();\n",
    }]);

    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 });
    assert.equal(receipt.repository, "example.com/org/repo");
    assert.equal(receipt.factCount, 1);
    assert.equal(receipt.qualityStatus, "complete");
    const record = harness.db.codeAttributionOutbox.get(receipt.outboxId);
    assert.ok(record);
    assert.deepEqual(record.payload.facts.map((fact) => ({
      aiGeneratedAddedLines: fact.aiGeneratedAddedLines,
      aiCandidateAddedLines: fact.aiCandidateAddedLines,
      retainedAiAddedLines: fact.retainedAiAddedLines,
      committedAddedLines: fact.committedAddedLines,
      coveredCommittedAddedLines: fact.coveredCommittedAddedLines,
      executionRefs: fact.executionRefs.map((reference) => ({
        nodeId: reference.nodeId,
        attemptNo: reference.attemptNo,
        threadId: reference.threadId,
        turnId: reference.turnId,
      })),
    })), [{
      aiGeneratedAddedLines: 2,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 2,
      committedAddedLines: 3,
      coveredCommittedAddedLines: 3,
      executionRefs: [{ nodeId: "node-a", attemptNo: 1, threadId: "thread-a", turnId: "turn-a" }],
    }]);
    const storedRow = harness.db.db.prepare(
      "SELECT payload_json FROM code_attribution_outbox WHERE id = ?",
    ).get(receipt.outboxId) as { payload_json?: string } | undefined;
    const storedJson = String(storedRow?.payload_json ?? "");
    assert.ok(!storedJson.includes("src/a.ts"));
    assert.ok(!storedJson.includes("repeat();"));
    assert.ok(!storedJson.includes("secret"));
    assert.ok(!storedJson.includes("token"));
    const retentionTasks = harness.db.db.prepare(`SELECT window_days, file_path, retained_lines_json
      FROM code_attribution_retention_tasks ORDER BY window_days`).all() as Array<{
      window_days: number;
      file_path: string;
      retained_lines_json: string;
    }>;
    assert.deepEqual(retentionTasks.map((task) => ({
      windowDays: task.window_days,
      filePath: task.file_path,
      retainedLines: JSON.parse(task.retained_lines_json),
    })), [
      { windowDays: 7, filePath: "src/a.ts", retainedLines: ["repeat();", "repeat();"] },
      { windowDays: 30, filePath: "src/a.ts", retainedLines: ["repeat();", "repeat();"] },
    ]);
  } finally {
    disposeHarness(harness);
  }
});

test("归因 outbox 与 7/30 天留存任务在同一事务内提交", async () => {
  const harness = createHarness("retention-transaction");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "fromAi();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/a.ts", before: null, after: "fromAi();\n" }]);
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const fileIdentitySha256 = crypto.createHash("sha256")
      .update(`${snapshot.repository}\0src/a.ts`, "utf8")
      .digest("hex");
    harness.db.codeAttributionRetentionTasks.enqueue({
      id: `code-attribution-retention:${"0".repeat(64)}`,
      workspaceId: String(harness.workspaceId),
      instanceId: String(harness.instanceId),
      repositoryPath: "",
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256,
      retainedLines: ["drift();"],
      retainedAiAddedLines: 1,
      windowDays: 7,
      dueAt: snapshot.committedAt + 7 * 24 * 60 * 60 * 1_000,
      now: 10_000,
    });

    await assert.rejects(
      collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionRetentionTaskRepoError
        && error.code === "CODE_ATTRIBUTION_RETENTION_TASK_CONFLICT",
    );
    const outboxCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_outbox").get() as { count?: number } | undefined;
    const retentionCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_retention_tasks").get() as { count?: number } | undefined;
    assert.equal(Number(outboxCount?.count ?? -1), 0);
    assert.equal(Number(retentionCount?.count ?? -1), 1);
  } finally {
    disposeHarness(harness);
  }
});

test("根空提交显式拒绝且不创建 outbox 或留存任务", async () => {
  const harness = createHarness("root-empty-commit");
  try {
    runGit(harness.repositoryRoot, ["commit", "--allow-empty", "-m", "empty"]);
    const commitSha = runGit(harness.repositoryRoot, ["rev-parse", "HEAD"]);
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    assert.deepEqual(snapshot.files, []);
    await assert.rejects(
      collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionCommitServiceError
        && error.code === "CODE_ATTRIBUTION_COMMIT_NO_CODE_CHANGES"
        && error.message === "该提交不包含可统计的代码变更。",
    );
    const outboxCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_outbox").get() as { count?: number } | undefined;
    const retentionCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_retention_tasks").get() as { count?: number } | undefined;
    assert.equal(Number(outboxCount?.count ?? -1), 0);
    assert.equal(Number(retentionCount?.count ?? -1), 0);
  } finally {
    disposeHarness(harness);
  }
});

test("非根空提交返回零文件并在持久化前显式拒绝", async () => {
  const harness = createHarness("non-root-empty-commit");
  try {
    writeRepoFile(harness.repositoryRoot, "src/base.ts", "base();\n");
    const parentSha = commitPaths(harness.repositoryRoot, "base", ["src/base.ts"]);
    runGit(harness.repositoryRoot, ["commit", "--allow-empty", "-m", "empty"]);
    const commitSha = runGit(harness.repositoryRoot, ["rev-parse", "HEAD"]);
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    assert.deepEqual(snapshot.parentShas, [parentSha]);
    assert.deepEqual(snapshot.files, []);
    await assert.rejects(
      collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionCommitServiceError
        && error.code === "CODE_ATTRIBUTION_COMMIT_NO_CODE_CHANGES"
        && error.message === "该提交不包含可统计的代码变更。",
    );
    const outboxCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_outbox").get() as { count?: number } | undefined;
    const retentionCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_retention_tasks").get() as { count?: number } | undefined;
    assert.equal(Number(outboxCount?.count ?? -1), 0);
    assert.equal(Number(retentionCount?.count ?? -1), 0);
  } finally {
    disposeHarness(harness);
  }
});

test("非空提交的 Git diff 证据损坏时显式失败且不伪装为空提交", async () => {
  const harness = createHarness("malformed-non-empty-diff");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "tracked();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    const blobSha = runGit(harness.repositoryRoot, ["rev-parse", `${commitSha}:src/a.ts`]);
    const blobPath = path.join(harness.repositoryRoot, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2));
    assert.equal(fs.existsSync(blobPath), true);
    fs.rmSync(blobPath);

    await assert.rejects(
      () => readCommitAttributionSnapshot(harness.repositoryRoot, commitSha),
      (error: unknown) => error instanceof Error && error.message.startsWith("Git 命令失败："),
    );
    await assert.rejects(
      collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionCommitServiceError
        && error.code === "CODE_ATTRIBUTION_COMMIT_GIT_READ_FAILED",
    );
    const outboxCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_outbox").get() as { count?: number } | undefined;
    const retentionCount = harness.db.db.prepare("SELECT COUNT(*) AS count FROM code_attribution_retention_tasks").get() as { count?: number } | undefined;
    assert.equal(Number(outboxCount?.count ?? -1), 0);
    assert.equal(Number(retentionCount?.count ?? -1), 0);
  } finally {
    disposeHarness(harness);
  }
});

test("无网络 remote 的同源仓库使用相同根提交仓库键", async () => {
  const harness = createHarness("local-repository-key");
  const cloneRoot = path.join(harness.root, "clone");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "root();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    execFileSync("git", ["clone", "--no-hardlinks", harness.repositoryRoot, cloneRoot], {
      encoding: "utf8",
      windowsHide: true,
    });
    const original = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const clone = await readCommitAttributionSnapshot(cloneRoot, commitSha);
    assert.match(original.repository, /^local:[a-f0-9]{64}$/u);
    assert.equal(clone.repository, original.repository);
    assert.equal(original.files[0]?.changeType, "added");
  } finally {
    disposeHarness(harness);
  }
});

test("scp remote 清除凭据、查询参数和片段", async () => {
  const harness = createHarness("scp-remote-key");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "root();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    runGit(harness.repositoryRoot, ["remote", "add", "origin", "git@example.com:org/repo.git?token=hidden#fragment"]);
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    assert.equal(snapshot.repository, "example.com/org/repo");
  } finally {
    disposeHarness(harness);
  }
});

test("缺少 AI 证据的提交不能被推断为完整人工代码", async () => {
  const harness = createHarness("missing-ai-trace");
  try {
    writeRepoFile(harness.repositoryRoot, "src/manual.ts", "manual();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "manual", ["src/manual.ts"]);
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 });
    const payload = harness.db.codeAttributionOutbox.get(receipt.outboxId)?.payload;
    assert.equal(receipt.qualityStatus, "unavailable");
    assert.equal(payload?.commit.disposition, "partial");
    assert.deepEqual(payload?.facts[0]?.qualityReasons, ["association_missing"]);
    assert.equal(payload?.facts[0]?.eligibleCommittedAddedLines, 1);
    assert.equal(payload?.facts[0]?.coveredCommittedAddedLines, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("同一提交混合完整与缺失 AI 证据时保持部分覆盖", async () => {
  const harness = createHarness("partial-ai-trace");
  try {
    writeRepoFile(harness.repositoryRoot, "src/ai.ts", "fromAi();\n");
    writeRepoFile(harness.repositoryRoot, "src/unknown.ts", "unknown();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "mixed", ["src/ai.ts", "src/unknown.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/ai.ts", before: null, after: "fromAi();\n" }]);
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 });
    const payload = harness.db.codeAttributionOutbox.get(receipt.outboxId)?.payload;
    assert.equal(receipt.qualityStatus, "partial");
    assert.equal(payload?.commit.disposition, "partial");
    assert.deepEqual(payload?.facts.map((fact) => fact.qualityStatus).sort(), ["complete", "unavailable"]);
    assert.equal(payload?.facts.reduce((sum, fact) => sum + fact.coveredCommittedAddedLines, 0), 1);
    assert.equal(payload?.facts.reduce((sum, fact) => sum + fact.eligibleCommittedAddedLines, 0), 2);
  } finally {
    disposeHarness(harness);
  }
});

test("rename 和 copy 由 Git 权威状态识别且 rename 可沿前路径归因", async () => {
  const harness = createHarness("rename-copy");
  try {
    const baseSource = "base1();\nbase2();\nbase3();\nbase4();\n";
    writeRepoFile(harness.repositoryRoot, "src/base.ts", baseSource);
    commitPaths(harness.repositoryRoot, "base", ["src/base.ts"]);
    runGit(harness.repositoryRoot, ["mv", "src/base.ts", "src/renamed.ts"]);
    writeRepoFile(harness.repositoryRoot, "src/renamed.ts", `${baseSource}fromAi();\n`);
    const renameSha = commitPaths(harness.repositoryRoot, "rename", ["src/renamed.ts"]);
    addAiEvidence(harness, [{
      workspaceRelativePath: "src/base.ts",
      before: baseSource,
      after: `${baseSource}fromAi();\n`,
    }]);
    const renameSnapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, renameSha);
    assert.equal(renameSnapshot.files[0]?.changeType, "renamed");
    assert.equal(renameSnapshot.files[0]?.previousPath, "src/base.ts");
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, renameSha), { now: 10_000 });
    assert.equal(harness.db.codeAttributionOutbox.get(receipt.outboxId)?.payload.facts[0]?.retainedAiAddedLines, 1);

    writeRepoFile(harness.repositoryRoot, "src/copied.ts", `${baseSource}fromAi();\ncopyAi();\n`);
    const copySha = commitPaths(harness.repositoryRoot, "copy", ["src/copied.ts"]);
    const copySnapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, copySha);
    assert.equal(copySnapshot.files[0]?.changeType, "copied");
    assert.equal(copySnapshot.files[0]?.previousPath, "src/renamed.ts");
    assert.deepEqual(copySnapshot.files[0]?.addedLines, ["copyAi();"]);
  } finally {
    disposeHarness(harness);
  }
});

test("二进制与 merge commit 保留明确排除批次", async () => {
  const harness = createHarness("excluded-commits");
  try {
    writeRepoFile(harness.repositoryRoot, "asset.bin", Buffer.from([0, 1, 2, 3, 0, 4]));
    const binarySha = commitPaths(harness.repositoryRoot, "binary", ["asset.bin"]);
    const binaryReceipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, binarySha), { now: 10_000 });
    const binaryRecord = harness.db.codeAttributionOutbox.get(binaryReceipt.outboxId);
    assert.equal(binaryRecord?.payload.commit.disposition, "excluded");
    assert.deepEqual(binaryRecord?.payload.commit.qualityReasons, ["binary_file"]);
    assert.equal(binaryRecord?.payload.facts[0]?.eligibleCommittedAddedLines, 0);

    runGit(harness.repositoryRoot, ["switch", "-c", "feature"]);
    writeRepoFile(harness.repositoryRoot, "feature.ts", "feature();\n");
    commitPaths(harness.repositoryRoot, "feature", ["feature.ts"]);
    runGit(harness.repositoryRoot, ["switch", "main"]);
    writeRepoFile(harness.repositoryRoot, "main.ts", "main();\n");
    commitPaths(harness.repositoryRoot, "main", ["main.ts"]);
    runGit(harness.repositoryRoot, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    const mergeSha = runGit(harness.repositoryRoot, ["rev-parse", "HEAD"]);
    const mergeReceipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, mergeSha), { now: 10_000 });
    const mergeRecord = harness.db.codeAttributionOutbox.get(mergeReceipt.outboxId);
    assert.equal(mergeRecord?.payload.commit.disposition, "excluded");
    assert.deepEqual(mergeRecord?.payload.commit.qualityReasons, ["merge_commit"]);
    assert.equal(mergeRecord?.payload.facts.length, 0);
  } finally {
    disposeHarness(harness);
  }
});

test("outbox 支持幂等、失败重试、凭证续签和成功精确删除", async () => {
  const harness = createHarness("outbox-lifecycle");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "manual();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/other.ts", before: null, after: "other();\n" }]);
    const input = collectInput(harness, commitSha, 10_000);
    const first = await collectCodeAttributionCommit(harness.db, input, { now: 10_000 });
    const replay = await collectCodeAttributionCommit(harness.db, input, { now: 10_001 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outboxId, first.outboxId);

    const claimed = harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-a", now: 10_002, leaseMs: 5_000 });
    assert.ok(claimed);
    assert.equal(claimed.batch.associationId, input.associationId);
    assert.equal(claimed.batch.sourceContentSha256, first.contentSha256);
    assert.equal(claimed.record.attemptCount, 1);
    await assert.rejects(
      () => collectCodeAttributionCommit(harness.db, {
        ...input,
        associationId: "association-during-lease",
        associationExpiresAt: 90_000,
      }, { now: 10_003 }),
      (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT",
    );
    assert.throws(() => harness.db.codeAttributionOutbox.deleteSucceeded({
      id: first.outboxId,
      leaseOwner: "worker-a",
      contentSha256: "0".repeat(64),
      now: 10_003,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT");

    assert.throws(() => harness.db.codeAttributionOutbox.markFailed({
      id: first.outboxId,
      leaseOwner: "worker-a",
      contentSha256: first.contentSha256,
      errorCode: "TEST_RETRY_AFTER_ASSOCIATION",
      retryAt: input.associationExpiresAt + 1,
      now: 10_003,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_INPUT_INVALID");

    const failed = harness.db.codeAttributionOutbox.markFailed({
      id: first.outboxId,
      leaseOwner: "worker-a",
      contentSha256: first.contentSha256,
      errorCode: "TEST_RETRY",
      retryAt: 20_000,
      now: 10_003,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorMessage, "代码归因批次同步失败，请稍后重试。");
    assert.equal(harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-a", now: 19_999, leaseMs: 5_000 }), null);

    const renewed = await collectCodeAttributionCommit(harness.db, {
      ...input,
      associationId: "association-renewed",
      associationExpiresAt: 90_000,
    }, { now: 15_000 });
    assert.equal(renewed.replayed, true);
    const reclaimed = harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-b", now: 15_000, leaseMs: 5_000 });
    assert.equal(reclaimed?.batch.associationId, "association-renewed");
    assert.equal(reclaimed?.record.attemptCount, 2);
    harness.db.codeAttributionOutbox.deleteSucceeded({
      id: first.outboxId,
      leaseOwner: "worker-b",
      contentSha256: first.contentSha256,
      now: 15_001,
    });
    assert.equal(harness.db.codeAttributionOutbox.get(first.outboxId), null);
  } finally {
    disposeHarness(harness);
  }
});

test("outbox 终态写回要求未过期租约并等待显式凭证续签", async () => {
  const harness = createHarness("outbox-terminal");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "manual();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha, 10_000), { now: 10_000 });
    const claimed = harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-terminal", now: 10_001, leaseMs: 5_000 });
    assert.ok(claimed);
    const terminal = harness.db.codeAttributionOutbox.markTerminalFailure({
      id: receipt.outboxId,
      leaseOwner: "worker-terminal",
      contentSha256: receipt.contentSha256,
      errorCode: "ORCH_METRICS_DELIVERY_ASSOCIATION_EXPIRED",
      associationExpired: true,
      now: 10_002,
    });
    assert.equal(terminal.availableAt, Number.MAX_SAFE_INTEGER);
    assert.equal(terminal.lastErrorMessage, "实例关联凭证已过期或剩余有效期不足，请重新签发后重试。");
    assert.equal(harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-terminal", now: 20_000, leaseMs: 5_000 }), null);

    const renewed = await collectCodeAttributionCommit(harness.db, {
      ...collectInput(harness, commitSha, 10_000),
      associationId: "association-terminal-renewed",
      associationExpiresAt: 100_000,
    }, { now: 20_001 });
    assert.equal(renewed.replayed, true);
    assert.ok(harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-renewed", now: 20_002, leaseMs: 5_000 }));
    assert.throws(() => harness.db.codeAttributionOutbox.markTerminalFailure({
      id: receipt.outboxId,
      leaseOwner: "worker-renewed",
      contentSha256: receipt.contentSha256,
      errorCode: "STALE_TERMINAL",
      associationExpired: false,
      now: 25_002,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT");
  } finally {
    disposeHarness(harness);
  }
});

test("过期租约不能回写或删除，过期队首不阻塞后续有效批次", async () => {
  const harness = createHarness("outbox-expired-head");
  try {
    writeRepoFile(harness.repositoryRoot, "src/first.ts", "first();\n");
    const firstSha = commitPaths(harness.repositoryRoot, "first", ["src/first.ts"]);
    const firstInput = { ...collectInput(harness, firstSha, 10_000), associationExpiresAt: 15_000 };
    const first = await collectCodeAttributionCommit(harness.db, firstInput, { now: 10_000 });

    writeRepoFile(harness.repositoryRoot, "src/second.ts", "second();\n");
    const secondSha = commitPaths(harness.repositoryRoot, "second", ["src/second.ts"]);
    const second = await collectCodeAttributionCommit(harness.db, collectInput(harness, secondSha, 10_001), { now: 10_001 });
    const claimed = harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-valid", now: 10_101, leaseMs: 5_000 });
    assert.equal(claimed?.record.id, second.outboxId);
    assert.equal(harness.db.codeAttributionOutbox.get(first.outboxId)?.lastErrorCode, "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED");

    assert.throws(() => harness.db.codeAttributionOutbox.markFailed({
      id: second.outboxId,
      leaseOwner: "worker-valid",
      contentSha256: second.contentSha256,
      errorCode: "STALE_WORKER",
      retryAt: 20_000,
      now: claimed!.record.leaseExpiresAt!,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT");
    assert.throws(() => harness.db.codeAttributionOutbox.deleteSucceeded({
      id: second.outboxId,
      leaseOwner: "worker-valid",
      contentSha256: second.contentSha256,
      now: claimed!.record.leaseExpiresAt!,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_LEASE_CONFLICT");
  } finally {
    disposeHarness(harness);
  }
});

test("outbox 白名单移除额外路径和留存字段", async () => {
  const harness = createHarness("outbox-whitelist");
  try {
    writeRepoFile(harness.repositoryRoot, "src/中文.ts", "fromAi();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "unicode", ["src/中文.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/中文.ts", before: null, after: "fromAi();\n" }]);
    const receipt = await collectCodeAttributionCommit(harness.db, collectInput(harness, commitSha), { now: 10_000 });
    const record = harness.db.codeAttributionOutbox.get(receipt.outboxId)!;
    const payload = structuredClone(record.payload) as any;
    payload.commit.localPath = "C:/secret/repo";
    payload.facts[0].path = "src/中文.ts";
    payload.facts[0].stillPresentAiAddedLines = 1;
    const replay = harness.db.codeAttributionOutbox.enqueue({
      id: record.id,
      sourceBatchId: record.sourceBatchId,
      workspaceId: record.workspaceId,
      instanceId: record.instanceId,
      repository: record.repository,
      commitSha: record.commitSha,
      payload,
      contentSha256: hashCodeAttributionOutboxPayload(payload),
      associationId: record.associationId,
      associationExpiresAt: record.associationExpiresAt,
      now: 10_001,
    });
    assert.equal(replay.replayed, true);
    const storedRow = harness.db.db.prepare("SELECT payload_json FROM code_attribution_outbox WHERE id = ?")
      .get(record.id) as { payload_json?: string } | undefined;
    const stored = String(storedRow?.payload_json ?? "");
    assert.ok(!stored.includes("C:/secret/repo"));
    assert.ok(!stored.includes("src/中文.ts"));
    assert.ok(!stored.includes("stillPresentAiAddedLines"));
  } finally {
    disposeHarness(harness);
  }
});

test("完整 SHA 隔离 amend 历史且相同身份内容漂移显式冲突", async () => {
  const harness = createHarness("history-rewrite");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "v1();\n");
    const originalSha = commitPaths(harness.repositoryRoot, "original", ["src/a.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/a.ts", before: null, after: "v1();\n" }]);
    const original = await collectCodeAttributionCommit(harness.db, collectInput(harness, originalSha), { now: 10_000 });
    runGit(harness.repositoryRoot, ["commit", "--amend", "-m", "rewritten"]);
    const rewrittenSha = runGit(harness.repositoryRoot, ["rev-parse", "HEAD"]);
    assert.notEqual(rewrittenSha, originalSha);
    const rewritten = await collectCodeAttributionCommit(harness.db, collectInput(harness, rewrittenSha), { now: 10_000 });
    assert.notEqual(rewritten.outboxId, original.outboxId);
    await assert.rejects(
      () => collectCodeAttributionCommit(harness.db, { ...collectInput(harness, rewrittenSha), commitSha: rewrittenSha.slice(0, 12) }, { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionCommitServiceError && error.code === "CODE_ATTRIBUTION_COMMIT_INPUT_INVALID",
    );
    await assert.rejects(
      () => collectCodeAttributionCommit(harness.db, { ...collectInput(harness, rewrittenSha), repositoryPath: "../outside" }, { now: 10_000 }),
      (error: unknown) => error instanceof CodeAttributionCommitServiceError && error.code === "CODE_ATTRIBUTION_COMMIT_INPUT_INVALID",
    );

    const record = harness.db.codeAttributionOutbox.get(original.outboxId);
    assert.ok(record);
    const driftedPayload = {
      ...record.payload,
      commit: {
        ...record.payload.commit,
        disposition: "partial" as const,
        qualityStatus: "partial" as const,
        qualityReasons: ["ai_trace_missing" as const],
      },
    };
    assert.throws(() => harness.db.codeAttributionOutbox.enqueue({
      id: record.id,
      sourceBatchId: record.sourceBatchId,
      workspaceId: record.workspaceId,
      instanceId: record.instanceId,
      repository: record.repository,
      commitSha: record.commitSha,
      payload: driftedPayload,
      contentSha256: hashCodeAttributionOutboxPayload(driftedPayload),
      associationId: record.associationId,
      associationExpiresAt: record.associationExpiresAt,
      now: 10_001,
    }), (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_CONTENT_CONFLICT");
  } finally {
    disposeHarness(harness);
  }
});

test("过期关联拒绝领取且摘要匹配的非法持久化载荷仍显式失败", async () => {
  const harness = createHarness("outbox-corruption");
  try {
    writeRepoFile(harness.repositoryRoot, "src/a.ts", "manual();\n");
    const commitSha = commitPaths(harness.repositoryRoot, "root", ["src/a.ts"]);
    addAiEvidence(harness, [{ workspaceRelativePath: "src/other.ts", before: null, after: "other();\n" }]);
    const input = { ...collectInput(harness, commitSha, 10_000), associationExpiresAt: 10_100 };
    const receipt = await collectCodeAttributionCommit(harness.db, input, { now: 10_000 });
    assert.throws(
      () => harness.db.codeAttributionOutbox.claimNext({ leaseOwner: "worker-expired", now: 10_101, leaseMs: 5_000 }),
      (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED",
    );

    const row = harness.db.db.prepare(
      "SELECT payload_json FROM code_attribution_outbox WHERE id = ?",
    ).get(receipt.outboxId) as { payload_json?: string } | undefined;
    const payload = JSON.parse(String(row?.payload_json ?? "{}")) as any;
    payload.commit.disposition = "partial";
    payload.commit.qualityStatus = "partial";
    payload.commit.qualityReasons = ["unknown_reason"];
    const payloadJson = JSON.stringify(payload);
    const digest = crypto.createHash("sha256").update(payloadJson, "utf8").digest("hex");
    harness.db.db.prepare(
      "UPDATE code_attribution_outbox SET payload_json = ?, content_sha256 = ? WHERE id = ?",
    ).run(payloadJson, digest, receipt.outboxId);
    assert.throws(
      () => harness.db.codeAttributionOutbox.get(receipt.outboxId),
      (error: unknown) => error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_STORED_DATA_INVALID",
    );
  } finally {
    disposeHarness(harness);
  }
});
