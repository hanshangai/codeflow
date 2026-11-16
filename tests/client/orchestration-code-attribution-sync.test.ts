import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationMetricCodeAttributionBatch } from "../../packages/shared/src/index.ts";
import type { WorkspaceLogEntry } from "../../apps/desktop/client/src/logger.ts";
import type {
  ClaimedCodeAttributionBatch,
  CodeAttributionOutboxRepo,
  CodeAttributionOutboxRecord,
} from "../../apps/desktop/client/src/db/repos/codeAttributionOutboxRepo.ts";
import {
  CodeAttributionHttpTransportError,
  createCodeAttributionHttpTransport,
  type CodeAttributionHttpTransport,
} from "../../apps/desktop/client/src/orchestration/codeAttributionHttpTransport.ts";
import { CodeAttributionSyncWorker } from "../../apps/desktop/client/src/orchestration/codeAttributionSyncWorker.ts";

const CONTENT_SHA = "a".repeat(64);
const COMMIT_SHA = "b".repeat(40);

/** Builds one complete source-code-free leased batch. */
function makeClaim(): ClaimedCodeAttributionBatch {
  const payload = {
    commit: {
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: COMMIT_SHA,
      disposition: "matched" as const,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      commitEvidenceSha256: "c".repeat(64),
      observedAt: 9_000,
    },
    facts: [{
      sourceWorkspaceId: "workspace-a",
      sourceInstanceId: "instance-a",
      repository: "example/repo",
      commitSha: COMMIT_SHA,
      fileIdentitySha256: "d".repeat(64),
      language: "typescript",
      aiGeneratedAddedLines: 2,
      aiCandidateAddedLines: 2,
      retainedAiAddedLines: 1,
      committedAddedLines: 2,
      eligibleCommittedAddedLines: 2,
      coveredCommittedAddedLines: 2,
      qualityStatus: "complete" as const,
      qualityReasons: [],
      aiEvidenceSha256: "e".repeat(64),
      commitEvidenceSha256: "f".repeat(64),
      evidenceRef: `client-code-attribution:${"1".repeat(64)}`,
      executionRefs: [],
      observedAt: 9_000,
    }],
  };
  const record: CodeAttributionOutboxRecord = {
    id: "outbox-a",
    sourceBatchId: "batch-a",
    workspaceId: "workspace-a",
    instanceId: "instance-a",
    repository: "example/repo",
    commitSha: COMMIT_SHA,
    contentSha256: CONTENT_SHA,
    payload,
    associationId: "association-a",
    associationExpiresAt: 100_000,
    status: "leased",
    attemptCount: 1,
    availableAt: 0,
    leaseOwner: "worker-a",
    leaseExpiresAt: 60_000,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: 1,
    updatedAt: 10_000,
  };
  return {
    record,
    batch: {
      associationId: record.associationId,
      sourceSystem: "codeflow_client",
      sourceBatchId: record.sourceBatchId,
      sourceRecordCount: payload.facts.length,
      sourceContentSha256: record.contentSha256,
      ...payload,
    },
  };
}

/** Builds one matching Server receipt. */
function makeReceipt(): OrchestrationMetricCodeAttributionBatch {
  return {
    id: "server-batch-a",
    sourceSystem: "codeflow_client",
    sourceBatchId: "batch-a",
    scope: { scopeKind: "mine", scopeId: "user-a" },
    sourceRecordCount: 1,
    acceptedRecordCount: 1,
    sourceContentSha256: CONTENT_SHA,
    contentSha256: CONTENT_SHA,
    reconciliationStatus: "ai_trace_received",
    createdAt: 10_000,
    updatedAt: 10_000,
  };
}

/** Creates a structural outbox fake and captures settlement calls. */
function makeOutbox(claim: ClaimedCodeAttributionBatch | null = makeClaim()) {
  const calls = {
    claims: [] as any[],
    deleted: [] as unknown[],
    failed: [] as any[],
    terminal: [] as any[],
  };
  let next = claim;
  const outbox = {
    getNextAssociationToRenew() { return null; },
    claimNext(input: unknown) {
      calls.claims.push(input);
      const current = next;
      next = null;
      return current;
    },
    deleteSucceeded(input: unknown) {
      calls.deleted.push(input);
    },
    markFailed(input: any) {
      calls.failed.push(input);
      return claim!.record;
    },
    markTerminalFailure(input: any) {
      calls.terminal.push(input);
      return claim!.record;
    },
  } as unknown as CodeAttributionOutboxRepo;
  return { outbox, calls };
}

/** Creates a no-op structured logger for deterministic worker tests. */
function workerOptions(now = () => 10_000) {
  const logger = { info(_bindings: Record<string, unknown>, _message: string) {}, warn(_bindings: Record<string, unknown>, _message: string) {}, error(_bindings: Record<string, unknown>, _message: string) {} };
  return {
    leaseOwner: "worker-a",
    now,
    hasDemand: () => true,
    workspaceId: "workspace-a",
    writeWorkspaceLog: (_workspaceId: string, entry: WorkspaceLogEntry) => logger[entry.level === "debug" ? "info" : entry.level](entry.data as Record<string, unknown>, entry.message),
    logger,
    onFatalError() {},
  };
}

/** Builds a batch-only transport fake that fails if a retention path is invoked. */
function makeBatchTransport(upload: CodeAttributionHttpTransport["upload"]): CodeAttributionHttpTransport {
  return {
    upload,
    uploadRetention: async () => { throw new Error("unexpected retention upload"); },
  };
}

test("归因数据库段取得许可，HTTP 上传时已经释放许可", async () => {
  const { outbox, calls } = makeOutbox();
  let permitted = false;
  const claim = outbox.claimNext.bind(outbox);
  outbox.claimNext = input => { assert.equal(permitted, true); return claim(input); };
  const worker = new CodeAttributionSyncWorker(outbox, makeBatchTransport(async () => {
    assert.equal(permitted, false);
    return makeReceipt();
  }), {
    ...workerOptions(),
    withDatabase: async operation => { permitted = true; try { return operation(); } finally { permitted = false; } },
    writeWorkspaceLog: () => { assert.equal(permitted, true); },
  });
  assert.equal(await worker.runOnce(), "uploaded");
  assert.equal(calls.deleted.length, 1);
});

test("代码归因按需续签过期关联后才领取上传", async () => {
  const claim = makeClaim();
  const { outbox } = makeOutbox(claim);
  let renewed = false;
  outbox.getNextAssociationToRenew = () => ({ ...claim.record, associationExpiresAt: 1 });
  outbox.enqueue = input => {
    renewed = true;
    claim.batch.associationId = input.associationId;
    return { record: claim.record, replayed: true };
  };
  const transport = { ...makeBatchTransport(async batch => {
    assert.equal(renewed, true);
    assert.equal(batch.associationId, "renewed-association");
    return makeReceipt();
  }), renewAssociation: async () => ({ associationId: "renewed-association", expiresAt: 200_000 }) };
  const worker = new CodeAttributionSyncWorker(outbox, transport, workerOptions());
  assert.equal(await worker.runOnce(), "uploaded");
  assert.equal(renewed, true);
});

test("代码归因没有需求时不领取已有批次", async () => {
  const { outbox, calls } = makeOutbox();
  const worker = new CodeAttributionSyncWorker(outbox, makeBatchTransport(async () => { throw new Error("unexpected upload"); }), {
    ...workerOptions(), hasDemand: () => false,
  });
  assert.equal(await worker.runOnce(), "idle");
  assert.equal(calls.claims.length, 0);
});

test("等待数据库许可期间需求撤销后不扫描或续签关联", async () => {
  const { outbox, calls } = makeOutbox();
  let active = true;
  let segments = 0;
  let scanned = 0;
  let renewed = 0;
  outbox.getNextAssociationToRenew = () => { scanned += 1; return { associationId: "expired", workspaceId: "workspace-a", instanceId: "instance-a" } as never; };
  const worker = new CodeAttributionSyncWorker(outbox, {
    ...makeBatchTransport(async () => { throw new Error("unexpected upload"); }),
    renewAssociation: async () => { renewed += 1; return { associationId: "renewed", expiresAt: 200_000 }; },
  }, { ...workerOptions(), hasDemand: () => active,
    withDatabase: async operation => { segments += 1; if (segments === 3) active = false; return operation(); },
  });
  assert.equal(await worker.runOnce(), "idle");
  assert.equal(scanned, 0);
  assert.equal(renewed, 0);
  assert.equal(calls.claims.length, 0);
});

test("代码归因 worker 仅在匹配回执后精确删除租约记录", async () => {
  const { outbox, calls } = makeOutbox();
  const transport = makeBatchTransport(async () => makeReceipt());
  const worker = new CodeAttributionSyncWorker(outbox, transport, workerOptions());
  assert.equal(await worker.runOnce(), "uploaded");
  assert.equal(calls.claims[0]?.leaseMs, 90_000);
  assert.deepEqual(calls.deleted, [{
    id: "outbox-a",
    leaseOwner: "worker-a",
    contentSha256: CONTENT_SHA,
    now: 10_000,
  }]);
  assert.equal(calls.failed.length, 0);
  assert.equal(calls.terminal.length, 0);
});

test("代码归因 worker 对瞬态失败退避，对过期和协议错误写入终态", async () => {
  const transient = makeOutbox();
  const transientWorker = new CodeAttributionSyncWorker(transient.outbox, makeBatchTransport(
    async () => {
      throw new CodeAttributionHttpTransportError(
        "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 503, "INTERNAL_ERROR", "request-a", "temporary",
      );
    },
  ), workerOptions());
  assert.equal(await transientWorker.runOnce(), "failed");
  assert.equal(transient.calls.failed[0]?.retryAt, 15_000);
  assert.equal(transient.calls.failed[0]?.errorCode, "INTERNAL_ERROR");

  const expired = makeOutbox();
  const expiredWorker = new CodeAttributionSyncWorker(expired.outbox, makeBatchTransport(
    async () => {
      throw new CodeAttributionHttpTransportError(
        "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED",
        410,
        "ORCH_METRICS_DELIVERY_ASSOCIATION_EXPIRED",
        "request-b",
        "expired",
      );
    },
  ), workerOptions());
  assert.equal(await expiredWorker.runOnce(), "failed");
  assert.equal(expired.calls.terminal[0]?.associationExpired, true);

  const invalid = makeOutbox();
  const invalidWorker = new CodeAttributionSyncWorker(invalid.outbox, makeBatchTransport(
    async () => {
      throw new CodeAttributionHttpTransportError(
        "CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 400, "BAD_REQUEST", "request-c", "invalid",
      );
    },
  ), workerOptions());
  assert.equal(await invalidWorker.runOnce(), "failed");
  assert.equal(invalid.calls.terminal[0]?.associationExpired, false);

  const malformed = makeOutbox();
  const malformedWorker = new CodeAttributionSyncWorker(malformed.outbox, makeBatchTransport(
    async () => {
      throw new CodeAttributionHttpTransportError(
        "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID", 200, null, null, "malformed receipt",
      );
    },
  ), workerOptions());
  assert.equal(await malformedWorker.runOnce(), "failed");
  assert.equal(malformed.calls.terminal[0]?.associationExpired, false);
  assert.equal(malformed.calls.failed.length, 0);
});

test("代码归因 worker 不吞掉未知实现或持久化错误", async () => {
  const { outbox, calls } = makeOutbox();
  const failure = new Error("unexpected implementation failure");
  const worker = new CodeAttributionSyncWorker(outbox, makeBatchTransport(async () => { throw failure; }), workerOptions());
  await assert.rejects(worker.runOnce(), failure);
  assert.equal(calls.failed.length, 0);
  assert.equal(calls.terminal.length, 0);
});

test("代码归因 HTTP transport 校验请求身份一致的 Server 回执", async () => {
  const claim = makeClaim();
  const receipt = makeReceipt();
  let requestedUrl = "";
  const transport = createCodeAttributionHttpTransport({ serverWsUrl: "ws://127.0.0.1:39280", apiKey: "test-key" }, {
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer test-key");
      return new Response(JSON.stringify({ ok: true, ...receipt }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await transport.upload(claim.batch), receipt);
  assert.equal(requestedUrl, "http://127.0.0.1:39280/api/client/orchestration-metrics/code-attribution/batches");

  const mismatched = createCodeAttributionHttpTransport({ serverWsUrl: "ws://127.0.0.1:39280", apiKey: "test-key" }, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, ...receipt, contentSha256: "0".repeat(64) }), { status: 200 }),
  });
  await assert.rejects(
    mismatched.upload(claim.batch),
    (error: unknown) => error instanceof CodeAttributionHttpTransportError
      && error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID",
  );
});
