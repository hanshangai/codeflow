import assert from "node:assert/strict";
import test from "node:test";

import { toSharedWorkspaceHostError } from "../src/app/handlers/sharedWorkspaceHandlers.ts";
import { SharedThreadAclWorkspaceMismatchError } from "../src/db/repos/threadRepo.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSharedWorkspaceEffectiveOperationPolicy, type SharedWorkspaceCommandEnvelope } from "@codeflowai/shared";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { getPendingTurnTerminalFailure } from "../src/app/turnInterrupt.ts";

test("共享Host历史、展示和列表在真实Writer下逐段读取，屏障失败不返回正文", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-host-writer-")), dbPath = path.join(root, "client.db");
  const app = openClientDb({ dbPath }), workspaceId = "host:workspace" as any, threadId = "shared-thread" as any;
  app.workspaces.upsert({ id: workspaceId, title: "Host", path: root });
  const db = app.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "共享会话", sharedAcl: { ownerUserId: "owner", sharedWorkspaceId: "shared" as any, visibility: "private" } });
  db.db.transaction(() => {
    for (let seq = 1; seq <= 650; seq++) db.conversationEvents.appendEnvelope({ schema: 1, seq, ts: seq, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "共享正文" } });
  })();
  const writer = new ClientDbWriterService({ db: app, dbPath, onFatalError(error) { assert.fail(error); } });
  const messages: any[] = [];
  const ctx: any = { db: app, clientId: "host", workspaces: new Map([[workspaceId, root]]), orchEngine: { forWorkspace() { return this; } },
    withDatabase: (requestId: string, operation: () => unknown) => writer.withLegacyDatabase(requestId, operation),
    async flushLocalEvents() { assert.throws(() => db.threads.get(threadId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/); }, send(message: unknown) { messages.push(message); },
  };
  /** 复用真实Server封套，指定的payload只表达本次已授权读取。 */
  const request = async (id: string, operationKey: "context.detail.read" | "context.list" | "context.thread.interrupt", payload: Record<string, unknown>) => {
    const envelope = { operationId: id, routeEventId: id, localWorkspaceId: workspaceId, sharedWorkspaceId: "shared", actorUserId: "owner", hostUserId: "owner", hostBindingId: "binding", actorRemoteSessionId: null,
      operationKey, policy: resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload)!, authorization: { actorAssetRole: "workspace_admin", authorizationResult: "allowed", authorizationReason: "test", assetType: "unknown", assetId: "", assetAction: "read" }, lockToken: "lock", lockVersion: 1, payload, createdAt: 1 } as SharedWorkspaceCommandEnvelope;
    await handleSharedWorkspaceCommand(ctx, envelope);
    return messages.find(message => message.t === "sharedWorkspace.route.result" && message.message.operationId === id)?.message;
  };
  try {
    await writer.ready();
    assert.equal((await request("replay", "context.detail.read", { resourceType: "thread", resourceId: threadId, includeEvents: true, limit: 500 })).status, "succeeded");
    assert.equal((await request("presentation", "context.detail.read", { resourceType: "thread", resourceId: threadId, detailMode: "presentation" })).status, "succeeded");
    assert.equal((await request("listing", "context.list", { resourceType: "thread" })).status, "succeeded");
    ctx.flushLocalEvents = async () => { throw new Error("SHARED_READ_INDEX_BARRIER_FAILED"); };
    const blocked = await request("blocked", "context.detail.read", { resourceType: "thread", resourceId: threadId, includeEvents: true });
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.result, undefined);
    ctx.flushLocalEvents = async () => {};
    const turnId = "shared-stop" as any;
    await writer.withLegacyDatabase("shared-stop-seed", () => db.turns.insertStarted({ workspaceId, threadId, turnId, engine: "codex", startedAt: 1, startEventSeq: 1 }));
    let release!: () => void, confirmed!: () => void, tail: Promise<void> | undefined, returned = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stopping = new Promise<void>(resolve => { confirmed = resolve; });
    ctx.threads = new ThreadStore();
    ctx.sessions = { beginThreadOperation: () => () => {}, async interrupt(_threadId: string, _turnId: string, options: any) { options.onStopConfirmed(); confirmed(); await gate; return true; } };
    ctx.onBeforeEmitConversationEvent = () => { throw new Error("SHARED_FINALIZATION_SAVE_FAILED"); };
    ctx.getTurnFinalizationFailure = getPendingTurnTerminalFailure;
    ctx.trackApiTail = (work: Promise<void>) => { tail = work; void work.then(() => {}, () => {}); };
    const work = request("shared-stop", "context.thread.interrupt", { threadId, turnId }).then(result => { returned = true; return result; });
    void work.then(() => {}, () => {});
    try {
      await stopping; await new Promise(resolve => setImmediate(resolve));
      assert.equal(returned, true, "共享停止不能等待保存尾链才回响应");
      assert.equal((await work).result.phase, "draining");
      assert.ok(tail);
      release(); await assert.rejects(tail, /TURN_INTERRUPT_FINALIZATION_FAILED/);
      const failed = await request("shared-failed-state", "context.detail.read", { resourceType: "thread", resourceId: threadId });
      assert.equal(failed.result.running.phase, "failed");
      assert.equal(messages.filter(message => message.t === "sharedWorkspace.route.result" && message.message.operationId === "shared-stop").length, 1);
    } finally { release(); await work.then(() => {}, () => {}); await tail?.then(() => {}, () => {}); }
  } finally { await writer.close(); app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("ACL workspace mismatch keeps its explicit protocol code and reconciliation detail", () => {
  const error = new SharedThreadAclWorkspaceMismatchError({
    mismatchScope: "local_workspace",
    threadId: "thread-a" as any,
    expectedWorkspaceId: "workspace-expected" as any,
    actualWorkspaceId: "workspace-actual" as any,
    expectedSharedWorkspaceId: "shared-a" as any,
    actualSharedWorkspaceId: "shared-b" as any,
    aclUpdatedAt: 123,
  });

  assert.deepEqual(toSharedWorkspaceHostError(error), {
    code: "SHARED_WORKSPACE_ACL_WORKSPACE_MISMATCH",
    message: "Shared thread ACL batch workspace mismatch: thread-a",
    status: 409,
    detail: error.context,
  });
});
