import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  OrchestrationId,
  OrchestrationMetricCodeAttributionRetentionIngestInput,
  OrchestrationMetricCodeAttributionRetentionIngestReceipt,
  WorkspaceId,
} from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { CodeAttributionRetentionTaskRepoError } from "../../apps/desktop/client/src/db/repos/codeAttributionRetentionTaskRepo.ts";
import {
  readCommitAttributionSnapshot,
  readCommitRetentionObservation,
} from "../../apps/desktop/client/src/git/gitService.ts";
import {
  CodeAttributionHttpTransportError,
  createCodeAttributionHttpTransport,
  type CodeAttributionHttpTransport,
} from "../../apps/desktop/client/src/orchestration/codeAttributionHttpTransport.ts";
import { CodeAttributionRetentionWorker } from "../../apps/desktop/client/src/orchestration/codeAttributionRetentionWorker.ts";

type RetentionHarness = {
  root: string;
  repositoryRoot: string;
  db: ClientDb;
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
};

/** Creates one isolated Client DB and Git repository for lineage observations. */
function createHarness(slug: string): RetentionHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codeflow-code-retention-${slug}-`));
  const repositoryRoot = path.join(root, "workspace");
  fs.mkdirSync(repositoryRoot, { recursive: true });
  runGit(repositoryRoot, ["init", "--initial-branch=main"]);
  runGit(repositoryRoot, ["config", "user.name", "CodeFlow Test"]);
  runGit(repositoryRoot, ["config", "user.email", "codeflow-test@example.invalid"]);
  runGit(repositoryRoot, ["config", "core.autocrlf", "false"]);
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = `workspace-${slug}` as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: slug, path: repositoryRoot });
  const workspaceDb = db.forWorkspace(workspaceId);
  const instance = workspaceDb.orchInstances.create({
    workspaceId,
    workflowId: `workflow-${slug}` as never,
    workflowSnapshot: {
      id: `workflow-${slug}`,
      workspaceId,
      name: slug,
      description: "",
      nodes: [],
      edges: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    } as never,
    intakeSnapshot: {
      id: `intake-${slug}`,
      workspaceId,
      title: slug,
      goal: "验证代码留存",
      triggerMode: "manual",
      taskType: "test",
      createdAt: 1,
      updatedAt: 1,
    } as never,
  });
  return { root, repositoryRoot, db: workspaceDb, workspaceId, instanceId: instance.id };
}

/** Executes one deterministic Git fixture command. */
function runGit(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
}

/** Writes one fixture file below the temporary repository. */
function writeFile(repositoryRoot: string, relativePath: string, content: string): void {
  const target = path.join(repositoryRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

/** Commits all fixture changes and returns the immutable commit SHA. */
function commitAll(repositoryRoot: string, message: string): string {
  runGit(repositoryRoot, ["add", "-A"]);
  runGit(repositoryRoot, ["commit", "-m", message]);
  return runGit(repositoryRoot, ["rev-parse", "HEAD"]);
}

/** Computes the same deterministic local observation identity used by collection. */
function observationId(input: {
  workspaceId: string;
  instanceId: string;
  repository: string;
  commitSha: string;
  fileIdentitySha256: string;
  windowDays: 7 | 30;
}): string {
  const commitIdentity = digest([
    "codeflow_client", input.workspaceId, input.instanceId, input.repository, input.commitSha,
  ].join("\0"));
  return `code-attribution-retention:${digest(`${commitIdentity}\0${input.fileIdentitySha256}\0${input.windowDays}`)}`;
}

/** Computes one lowercase SHA-256 digest for test identities. */
function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Closes the DB before recursively removing its temporary repository. */
function disposeHarness(harness: RetentionHarness): void {
  harness.db.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("Git 留存观察保留重复行并将权威删除计为完整零留存", async () => {
  const harness = createHarness("duplicates");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "repeat();\nrepeat();\ndrop();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    writeFile(harness.repositoryRoot, "src/a.ts", "repeat();\nrepeat();\n");
    commitAll(harness.repositoryRoot, "remove one line");
    const fileIdentitySha256 = digest(`${snapshot.repository}\0src/a.ts`);

    const observation = await readCommitRetentionObservation(harness.repositoryRoot, {
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256,
    });
    assert.equal(observation.status, "complete");
    if (observation.status === "complete") {
      assert.deepEqual(observation.targetCommitLines, ["repeat();", "repeat();"]);
      assert.match(observation.evidenceSha256, /^[a-f0-9]{64}$/u);
    }

    runGit(harness.repositoryRoot, ["rm", "src/a.ts"]);
    commitAll(harness.repositoryRoot, "delete file");
    const deletedObservation = await readCommitRetentionObservation(harness.repositoryRoot, {
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256,
    });
    assert.equal(deletedObservation.status, "complete");
    if (deletedObservation.status === "complete") {
      assert.deepEqual(deletedObservation.targetCommitLines, []);
      assert.match(deletedObservation.evidenceSha256, /^[a-f0-9]{64}$/u);
    }
  } finally {
    disposeHarness(harness);
  }
});

test("Git 留存观察沿净重命名路径读取目标 commit 行来源", async () => {
  const harness = createHarness("rename");
  try {
    writeFile(harness.repositoryRoot, "src/original.ts", "keepA();\nkeepB();\nkeepC();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    runGit(harness.repositoryRoot, ["mv", "src/original.ts", "src/renamed.ts"]);
    commitAll(harness.repositoryRoot, "rename");
    const observation = await readCommitRetentionObservation(harness.repositoryRoot, {
      repository: snapshot.repository,
      commitSha,
      filePath: "src/original.ts",
      fileIdentitySha256: digest(`${snapshot.repository}\0src/original.ts`),
    });
    assert.equal(observation.status, "complete");
    if (observation.status === "complete") {
      assert.deepEqual(observation.targetCommitLines, ["keepA();", "keepB();", "keepC();"]);
    }
  } finally {
    disposeHarness(harness);
  }
});

test("Git 留存观察将不再属于当前历史的目标 commit 标记为历史改写", async () => {
  const harness = createHarness("rewritten");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "old();\n");
    const commitSha = commitAll(harness.repositoryRoot, "old history");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    runGit(harness.repositoryRoot, ["switch", "--orphan", "replacement"]);
    writeFile(harness.repositoryRoot, "src/new.ts", "newHistory();\n");
    commitAll(harness.repositoryRoot, "new history");

    const observation = await readCommitRetentionObservation(harness.repositoryRoot, {
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256: digest(`${snapshot.repository}\0src/a.ts`),
    });
    assert.equal(observation.status, "unavailable");
    if (observation.status === "unavailable") assert.equal(observation.reason, "history_rewritten");
  } finally {
    disposeHarness(harness);
  }
});

test("Git 留存观察将已被清理的目标 commit 标记为历史改写", async () => {
  const harness = createHarness("pruned-history");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "old();\n");
    const commitSha = commitAll(harness.repositoryRoot, "old history");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    runGit(harness.repositoryRoot, ["switch", "--orphan", "replacement"]);
    writeFile(harness.repositoryRoot, "src/new.ts", "newHistory();\n");
    commitAll(harness.repositoryRoot, "new history");
    runGit(harness.repositoryRoot, ["update-ref", "-d", "refs/heads/main"]);
    runGit(harness.repositoryRoot, ["reflog", "expire", "--expire=now", "--all"]);
    runGit(harness.repositoryRoot, ["gc", "--prune=now"]);

    const observation = await readCommitRetentionObservation(harness.repositoryRoot, {
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256: digest(`${snapshot.repository}\0src/a.ts`),
    });
    assert.equal(observation.status, "unavailable");
    if (observation.status === "unavailable") assert.equal(observation.reason, "history_rewritten");
  } finally {
    disposeHarness(harness);
  }
});

test("留存 worker 无需求时不领取任务或读取 Git", async () => {
  const harness = createHarness("no-demand");
  try {
    harness.db.codeAttributionRetentionTasks.claimNext = () => { throw new Error("unexpected claim"); };
    const worker = new CodeAttributionRetentionWorker(harness.db, {} as never, {
      logger: { info() {}, warn() {}, error() {} }, onFatalError() {},
    });
    assert.equal(await worker.runOnce(), "idle");
  } finally { disposeHarness(harness); }
});

test("留存 worker 使用五分钟租约并上传完整脱敏计数", async () => {
  const harness = createHarness("worker-success");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "keep();\nmanual();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const fileIdentitySha256 = digest(`${snapshot.repository}\0src/a.ts`);
    const now = snapshot.committedAt + 31 * 24 * 60 * 60 * 1_000;
    const id = observationId({
      workspaceId: String(harness.workspaceId),
      instanceId: String(harness.instanceId),
      repository: snapshot.repository,
      commitSha,
      fileIdentitySha256,
      windowDays: 7,
    });
    harness.db.codeAttributionRetentionTasks.enqueue({
      id,
      workspaceId: String(harness.workspaceId),
      instanceId: String(harness.instanceId),
      repositoryPath: "",
      repository: snapshot.repository,
      commitSha,
      filePath: "src/a.ts",
      fileIdentitySha256,
      retainedLines: ["keep();"],
      retainedAiAddedLines: 1,
      windowDays: 7,
      dueAt: now - 1,
      now: 1,
    });
    let uploaded: OrchestrationMetricCodeAttributionRetentionIngestInput | null = null;
    let leaseExpiresAt: number | null = null;
    const transport: CodeAttributionHttpTransport = {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async (input) => {
        uploaded = input;
        leaseExpiresAt = harness.db.codeAttributionRetentionTasks.get(id)?.leaseExpiresAt ?? null;
        return {
          id: input.observationId,
          attributionFactId: "server-fact",
          sourceWorkspaceId: input.sourceWorkspaceId,
          sourceInstanceId: input.sourceInstanceId,
          repository: input.repository,
          commitSha: input.commitSha,
          fileIdentitySha256: input.fileIdentitySha256,
          windowDays: input.windowDays,
          stillPresentAiAddedLines: input.stillPresentAiAddedLines,
          qualityStatus: input.qualityStatus,
          qualityReasons: input.qualityReasons,
          retentionEvidenceSha256: input.retentionEvidenceSha256,
          evidenceRef: input.evidenceRef,
          observedAt: input.observedAt,
          createdAt: now,
        } as OrchestrationMetricCodeAttributionRetentionIngestReceipt;
      },
    };
    const worker = new CodeAttributionRetentionWorker(harness.db, transport, {
      leaseOwner: "worker-success",
      now: () => now,
      hasDemand: () => true,
      logger: { info() {}, warn() {}, error() {} },
      onFatalError() {},
    });
    assert.equal(await worker.runOnce(), "uploaded");
    assert.equal(leaseExpiresAt, now + 5 * 60_000);
    const uploadedObservation = uploaded as OrchestrationMetricCodeAttributionRetentionIngestInput | null;
    assert.equal(uploadedObservation?.qualityStatus, "complete");
    assert.equal(uploadedObservation?.stillPresentAiAddedLines, 1);
    assert.equal(harness.db.codeAttributionRetentionTasks.get(id), null);
  } finally {
    disposeHarness(harness);
  }
});

test("留存回执丢失后冻结首次 HEAD 和内容，重试不重新观察", async () => {
  const harness = createHarness("frozen-retry");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "keep();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const fileIdentitySha256 = digest(`${snapshot.repository}\0src/a.ts`);
    let now = snapshot.committedAt + 31 * 24 * 60 * 60 * 1_000;
    const id = observationId({ workspaceId: harness.workspaceId, instanceId: harness.instanceId,
      repository: snapshot.repository, commitSha, fileIdentitySha256, windowDays: 7 });
    harness.db.codeAttributionRetentionTasks.enqueue({
      id, workspaceId: harness.workspaceId, instanceId: harness.instanceId,
      repositoryPath: "", repository: snapshot.repository, commitSha, filePath: "src/a.ts", fileIdentitySha256,
      retainedLines: ["keep();"], retainedAiAddedLines: 1, windowDays: 7, dueAt: now - 1, now: 1,
    });
    const uploads: OrchestrationMetricCodeAttributionRetentionIngestInput[] = [];
    const transport: CodeAttributionHttpTransport = {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async observation => {
        uploads.push(structuredClone(observation));
        if (uploads.length === 1) throw new CodeAttributionHttpTransportError(
          "CODE_ATTRIBUTION_SYNC_NETWORK_FAILED", null, null, "lost-ack", "ack lost");
        return { ...observation, id: observation.observationId, attributionFactId: "fact", createdAt: now };
      },
    };
    const options = { hasDemand: () => true, now: () => now,
      logger: { info() {}, warn() {}, error() {} }, onFatalError() {} };
    const first = new CodeAttributionRetentionWorker(harness.db, transport, options);
    assert.equal(await first.runOnce(), "failed");
    writeFile(harness.repositoryRoot, "src/a.ts", "changed();\n");
    commitAll(harness.repositoryRoot, "change head after lost ack");
    now += 60_001;
    const retry = new CodeAttributionRetentionWorker(harness.db, transport, options);
    assert.equal(await retry.runOnce(), "uploaded");
    assert.equal(uploads[0]?.stillPresentAiAddedLines, 1);
    assert.deepEqual(uploads[1], uploads[0]);
  } finally { disposeHarness(harness); }
});

test("留存 worker 区分可重试与终态传输失败并隐藏本地路径", async () => {
  const harness = createHarness("worker-failures");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "keep();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const fileIdentitySha256 = digest(`${snapshot.repository}\0src/a.ts`);
    const now = snapshot.committedAt + 31 * 24 * 60 * 60 * 1_000;
    const enqueue = (windowDays: 7 | 30, repositoryPath = "") => {
      const id = observationId({
        workspaceId: String(harness.workspaceId), instanceId: String(harness.instanceId),
        repository: snapshot.repository, commitSha, fileIdentitySha256, windowDays,
      });
      harness.db.codeAttributionRetentionTasks.enqueue({
        id, workspaceId: String(harness.workspaceId), instanceId: String(harness.instanceId),
        repositoryPath, repository: snapshot.repository, commitSha, filePath: "src/a.ts",
        fileIdentitySha256, retainedLines: ["keep();"], retainedAiAddedLines: 1,
        windowDays, dueAt: now - 1, now: 1,
      });
      return id;
    };
    const retryId = enqueue(7);
    const retryWorker = new CodeAttributionRetentionWorker(harness.db, {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async () => {
        throw new CodeAttributionHttpTransportError(
          "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 503, "INTERNAL_ERROR", "request-retry", "temporary",
        );
      },
    }, {
      leaseOwner: "worker-retry", now: () => now,
      hasDemand: () => true,
      logger: { info() {}, warn() {}, error() {} }, onFatalError() {},
    });
    assert.equal(await retryWorker.runOnce(), "failed");
    assert.equal(harness.db.codeAttributionRetentionTasks.get(retryId)?.status, "failed");
    assert.ok((harness.db.codeAttributionRetentionTasks.get(retryId)?.availableAt ?? 0) > now);

    harness.db.db.prepare("UPDATE code_attribution_retention_tasks SET available_at=0 WHERE id=?").run(retryId);
    const missingFactWorker = new CodeAttributionRetentionWorker(harness.db, {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async () => {
        throw new CodeAttributionHttpTransportError(
          "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 404, "NOT_FOUND", "request-missing-fact", "not found",
        );
      },
    }, {
      leaseOwner: "worker-missing-fact", now: () => now + 120_000,
      hasDemand: () => true,
      logger: { info() {}, warn() {}, error() {} }, onFatalError() {},
    });
    assert.equal(await missingFactWorker.runOnce(), "failed");
    assert.equal(harness.db.codeAttributionRetentionTasks.get(retryId)?.status, "failed");
    assert.ok((harness.db.codeAttributionRetentionTasks.get(retryId)?.availableAt ?? 0) > now + 120_000);

    const terminalId = enqueue(30);
    const terminalWorker = new CodeAttributionRetentionWorker(harness.db, {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async () => {
        throw new CodeAttributionHttpTransportError(
          "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 400, "BAD_REQUEST", "request-terminal", "invalid",
        );
      },
    }, {
      leaseOwner: "worker-terminal", now: () => now,
      hasDemand: () => true,
      logger: { info() {}, warn() {}, error() {} }, onFatalError() {},
    });
    assert.equal(await terminalWorker.runOnce(), "failed");
    assert.equal(harness.db.codeAttributionRetentionTasks.get(terminalId)?.availableAt, Number.MAX_SAFE_INTEGER);

    const pathFileIdentitySha256 = digest(`${snapshot.repository}\0src/b.ts`);
    const pathFailureId = observationId({
      workspaceId: String(harness.workspaceId), instanceId: String(harness.instanceId),
      repository: snapshot.repository, commitSha, fileIdentitySha256: pathFileIdentitySha256, windowDays: 7,
    });
    harness.db.codeAttributionRetentionTasks.enqueue({
      id: pathFailureId, workspaceId: harness.workspaceId, instanceId: harness.instanceId,
      repositoryPath: "missing-repository", repository: snapshot.repository, commitSha,
      filePath: "src/b.ts", fileIdentitySha256: pathFileIdentitySha256,
      retainedLines: ["keep();"], retainedAiAddedLines: 1, windowDays: 7, dueAt: now - 1, now: 1,
    });
    const warnings: unknown[] = [];
    harness.db.writeWorkspaceLog = (_workspaceId, entry) => { if (entry.level === "warn") warnings.push(entry.data); };
    const pathWorker = new CodeAttributionRetentionWorker(harness.db, {
      upload: async () => { throw new Error("unexpected batch upload"); },
      uploadRetention: async () => { throw new Error("unexpected retention upload"); },
    }, {
      leaseOwner: "worker-path", now: () => now + 120_000,
      hasDemand: () => true,
      logger: { info() {}, warn(bindings) { warnings.push(bindings); }, error() {} }, onFatalError() {},
    });
    assert.equal(await pathWorker.runOnce(), "failed");
    const serializedWarnings = JSON.stringify(warnings);
    assert.equal(serializedWarnings.includes(harness.repositoryRoot), false);
    assert.equal(serializedWarnings.includes("missing-repository"), false);
    assert.match(serializedWarnings, /GIT_OBSERVATION_FAILED/u);
  } finally {
    disposeHarness(harness);
  }
});

test("留存任务持久化损坏统一返回 stored-data 错误", async () => {
  const harness = createHarness("stored-data");
  try {
    writeFile(harness.repositoryRoot, "src/a.ts", "keep();\n");
    const commitSha = commitAll(harness.repositoryRoot, "target");
    const snapshot = await readCommitAttributionSnapshot(harness.repositoryRoot, commitSha);
    const fileIdentitySha256 = digest(`${snapshot.repository}\0src/a.ts`);
    const id = observationId({
      workspaceId: String(harness.workspaceId), instanceId: String(harness.instanceId),
      repository: snapshot.repository, commitSha, fileIdentitySha256, windowDays: 7,
    });
    harness.db.codeAttributionRetentionTasks.enqueue({
      id, workspaceId: String(harness.workspaceId), instanceId: String(harness.instanceId),
      repositoryPath: "", repository: snapshot.repository, commitSha, filePath: "src/a.ts",
      fileIdentitySha256, retainedLines: ["keep();"], retainedAiAddedLines: 1,
      windowDays: 7, dueAt: 1, now: 1,
    });
    harness.db.db.prepare("UPDATE code_attribution_retention_tasks SET retained_lines_json='[\"  keep();\"]' WHERE id=?").run(id);
    assert.throws(
      () => harness.db.codeAttributionRetentionTasks.get(id),
      (error: unknown) => error instanceof CodeAttributionRetentionTaskRepoError
        && error.code === "CODE_ATTRIBUTION_RETENTION_TASK_STORED_DATA_INVALID",
    );
  } finally {
    disposeHarness(harness);
  }
});

test("留存 HTTP transport 仅接受全字段一致的不可变回执", async () => {
  const identity = {
    sourceWorkspaceId: "workspace-http",
    sourceInstanceId: "instance-http",
    repository: "example/repo",
    commitSha: "a".repeat(40),
    fileIdentitySha256: "b".repeat(64),
    windowDays: 7 as const,
  };
  const request: OrchestrationMetricCodeAttributionRetentionIngestInput = {
    observationId: observationId({ workspaceId: identity.sourceWorkspaceId, instanceId: identity.sourceInstanceId, ...identity }),
    ...identity,
    stillPresentAiAddedLines: 2,
    qualityStatus: "complete",
    qualityReasons: [],
    retentionEvidenceSha256: "c".repeat(64),
    evidenceRef: `client-code-attribution-retention:${"d".repeat(64)}`,
    observedAt: 2_000,
  };
  const receipt: OrchestrationMetricCodeAttributionRetentionIngestReceipt = {
    id: request.observationId,
    attributionFactId: "server-fact",
    ...identity,
    stillPresentAiAddedLines: request.stillPresentAiAddedLines,
    qualityStatus: "complete",
    qualityReasons: [],
    retentionEvidenceSha256: request.retentionEvidenceSha256,
    evidenceRef: request.evidenceRef,
    observedAt: request.observedAt,
    createdAt: 3_000,
  };
  let requestedUrl = "";
  const transport = createCodeAttributionHttpTransport({ serverWsUrl: "ws://127.0.0.1:39280", apiKey: "test-key" }, {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ ok: true, ...receipt }), { status: 200 });
    },
  });
  assert.deepEqual(await transport.uploadRetention(request), receipt);
  assert.equal(requestedUrl, "http://127.0.0.1:39280/api/client/orchestration-metrics/code-attribution/retention-observations");

  const mismatched = createCodeAttributionHttpTransport({ serverWsUrl: "ws://127.0.0.1:39280", apiKey: "test-key" }, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, ...receipt, evidenceRef: `client-code-attribution-retention:${"e".repeat(64)}` }), { status: 200 }),
  });
  await assert.rejects(
    mismatched.uploadRetention(request),
    (error: unknown) => error instanceof CodeAttributionHttpTransportError
      && error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID",
  );
});
