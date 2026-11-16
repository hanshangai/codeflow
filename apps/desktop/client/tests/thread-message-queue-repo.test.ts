import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE, ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

const WORKSPACE_ID = "test:queue-repo-ws" as WorkspaceId;
const THREAD_ID = "test_thread_queue_repo" as ThreadId;

function setupDb(): { db: SqliteDb; repo: ThreadMessageQueueRepo } {
  const db = openSqliteDb(":memory:");
  // migrate 内部会启用 foreign_keys；插 FK 上游行（workspaces + threads）满足约束
  migrateClientDb(db);
  db.prepare(
    "INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(String(WORKSPACE_ID), "queue test ws", "/tmp/queue-test", Date.now(), Date.now());
  // threads 表字段在不同 schema 版本扩展过；用 INSERT 仅必填列 + 默认值
  db.prepare(
    "INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(String(THREAD_ID), String(WORKSPACE_ID), "claude", "queue test thread", Date.now(), Date.now());

  const blobs = new FileBlobRepo(db);
  const repo = new ThreadMessageQueueRepo(db, blobs);
  return { db, repo };
}

const SEND_OPTS = {
  workMode: "general" as const,
  planMode: false,
  accessMode: null,
  model: "claude-test",
  effort: null,
  contextWindow: null,
  autoCompactPct: null,
  serviceTier: null,
};

test("ThreadMessageQueueRepo appendItem 按 1024 间隔递增 position", () => {
  const { db, repo } = setupDb();
  try {
    const a = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "first",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
    });
    const b = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "second",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
    });
    const c = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "third",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
    });
    assert.equal(a.item.position, 1024, "首条 position 应为 1024");
    assert.equal(b.item.position, 2048, "第二条 position 应为 2048");
    assert.equal(c.item.position, 3072, "第三条 position 应为 3072");
    assert.equal(a.item.status, "pending");
    assert.equal(a.item.text, "first");
    assert.equal(a.item.sendOptions.model, "claude-test");
    assert.equal(a.item.sendOptions.serviceTier, null);
    assert.equal(a.idempotent, false);

    const active = repo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 3);
    assert.deepEqual(
      active.map((it) => it.text),
      ["first", "second", "third"],
      "listActiveByThread 应按 position 升序",
    );
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo hasActiveByThread 只判断 pending 和 sending", () => {
  const { db, repo } = setupDb();
  try {
    assert.equal(repo.hasActiveByThread(THREAD_ID), false);
    const queued = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "active-check",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
    });
    assert.equal(repo.hasActiveByThread(THREAD_ID), true);

    const claimed = repo.claimNextPending(THREAD_ID);
    assert.equal(claimed?.id, queued.item.id);
    assert.equal(repo.hasActiveByThread(THREAD_ID), true);

    repo.markSent(queued.item.id, "turn_active_check" as any);
    assert.equal(repo.hasActiveByThread(THREAD_ID), false);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo appendItem 幂等：同 thread + clientItemId 重复返回原 item", () => {
  const { db, repo } = setupDb();
  try {
    const r1 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "hello",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-A",
    });
    const r2 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "hello again (different text but same cid)",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-A",
    });
    assert.equal(r1.idempotent, false);
    assert.equal(r2.idempotent, true, "第二次同 cid 应被识别为幂等");
    assert.equal(r1.item.id, r2.item.id, "返回同一个 item id");
    assert.equal(r1.item.text, "hello", "原文本不变（幂等不覆盖）");
    assert.equal(repo.listActiveByThread(THREAD_ID).length, 1, "仅一条 active 项");
    assert.equal(r2.item.clientItemId, "cid-A");

    // 不同 cid 仍正常入队
    const r3 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "second",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-B",
    });
    assert.equal(r3.idempotent, false);
    assert.equal(repo.listActiveByThread(THREAD_ID).length, 2);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo appendItem 幂等：普通 sent/failed 项仍可用同 cid 重新入队", () => {
  const { db, repo } = setupDb();
  try {
    const r1 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "first",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-X",
    });
    repo.markSent(r1.item.id, "turn_1" as any); // 移出 active

    // sent 后再用同 cid 入队，应被视为新项（不命中幂等）
    const r2 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "first again",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-X",
    });
    assert.equal(r2.idempotent, false, "已 sent 项不阻止同 cid 重新入队");
    assert.notEqual(r1.item.id, r2.item.id);

    repo.markFailed(r2.item.id, "append_failed", "普通发送失败");
    const r3 = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "first after generic failure",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-X",
    });
    assert.equal(r3.idempotent, false, "普通 failed 项不应扩大为 ACK 后幂等恢复");
    assert.notEqual(r2.item.id, r3.item.id);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo 接收结果未知项在仓储重建和启动恢复后仍阻止同键重发", () => {
  const { db, repo } = setupDb();
  try {
    const input = {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "结果未知的输入", images: [], files: [],
      sendOptions: SEND_OPTS, originWebSessionId: null, clientItemId: "unknown-delivery-key",
    };
    const original = repo.appendItem(input).item;
    assert.equal(repo.claimNextPending(THREAD_ID)?.id, original.id);
    repo.markFailed(original.id, ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE, "stdin write outcome unknown");

    const reloaded = new ThreadMessageQueueRepo(db, new FileBlobRepo(db));
    assert.equal(reloaded.resetAllSending(), 0);
    for (let i = 0; i < 2; i++) {
      const replay = reloaded.appendItem(input);
      assert.equal(replay.idempotent, true);
      assert.equal(replay.item.id, original.id);
      assert.equal(replay.item.failureCode, ACTIVE_TURN_APPEND_OUTCOME_UNKNOWN_CODE);
      assert.equal(replay.item.status, "failed");
      assert.equal(replay.item.attemptCount, 1);
    }
    assert.equal(reloaded.listActiveByThread(THREAD_ID).length, 0);

    const fresh = reloaded.appendItem({ ...input, clientItemId: "new-delivery-key" });
    assert.equal(fresh.idempotent, false);
    assert.notEqual(fresh.item.id, original.id);
    assert.equal(reloaded.listActiveByThread(THREAD_ID).length, 1);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo appendItem 幂等：ACK 后待收尾项返回原 item", () => {
  const { db, repo } = setupDb();
  try {
    const original = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "provider accepted",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-post-ack",
    }).item;
    const claimed = repo.claimNextPending(THREAD_ID);
    assert.equal(claimed?.id, original.id);
    assert.equal(repo.markPostAckPending(
      original.id,
      "active_turn_append_post_ack_failed",
      "local finalize failed",
      "turn-post-ack" as any,
      claimed?.attemptCount ?? 0,
    ), true);

    const retry = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "provider accepted",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-post-ack",
    });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.item.id, original.id);
    assert.equal(retry.item.sentTurnId, "turn-post-ack");
    assert.equal(repo.completePostAck(
      original.id,
      "active_turn_append_post_ack_failed",
      retry.item.sentTurnId,
      retry.item.attemptCount,
    ), true);

    const completed = repo.getById(original.id);
    assert.equal(completed?.status, "sent");
    assert.equal(completed?.sentTurnId, "turn-post-ack");
    assert.equal(completed?.failureCode, "active_turn_append_post_ack_failed_completed");
    assert.equal(completed?.failureReason, null);

    const tombstone = repo.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "late retry",
      images: [],
      files: [],
      sendOptions: SEND_OPTS,
      originWebSessionId: null,
      clientItemId: "cid-post-ack",
    });
    assert.equal(tombstone.idempotent, true);
    assert.equal(tombstone.item.id, original.id);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo moveUp 交换相邻 position 且不违反唯一索引", () => {
  const { db, repo } = setupDb();
  try {
    const a = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "A",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });
    const b = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "B",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });

    // moveUp B → 与 A 交换；如果实现走单步 UPDATE 会因 uk_thread_message_queue_thread_position_active 报错
    const moved = repo.moveUp(THREAD_ID, b.item.id);
    assert.equal(moved, true);

    const active = repo.listActiveByThread(THREAD_ID);
    assert.deepEqual(
      active.map((it) => it.text),
      ["B", "A"],
      "moveUp 后顺序应反转",
    );
    assert.equal(active[0].id, b.item.id);
    assert.equal(active[1].id, a.item.id);

    // 首项再 moveUp 应 noop
    const noop = repo.moveUp(THREAD_ID, b.item.id);
    assert.equal(noop, false, "首项 moveUp 应返回 false");
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo claimNextPending 原子认领，不会重复返回同一项", () => {
  const { db, repo } = setupDb();
  try {
    const a = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "A",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });
    const b = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "B",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });

    const first = repo.claimNextPending(THREAD_ID);
    assert.ok(first);
    assert.equal(first!.id, a.item.id);
    assert.equal(first!.status, "sending", "认领后应转为 sending");
    assert.equal(first!.attemptCount, 1);

    // 再 claim 不应取到同一项（status 已是 sending）；应取到 b
    const second = repo.claimNextPending(THREAD_ID);
    assert.ok(second);
    assert.equal(second!.id, b.item.id);
    assert.equal(second!.status, "sending");

    // 第三次 claim 没有 pending 了，应返回 null
    const third = repo.claimNextPending(THREAD_ID);
    assert.equal(third, null);

    // markSent 后 listActiveByThread 不再包含 a
    repo.markSent(a.item.id, "turn_test_1" as any);
    const active = repo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, b.item.id);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo resetAllSending 把残留 sending 项重置为 pending", () => {
  const { db, repo } = setupDb();
  try {
    repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "A",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });
    repo.claimNextPending(THREAD_ID); // A 进入 sending

    const reset = repo.resetAllSending();
    assert.equal(reset, 1);

    const items = repo.listActiveByThread(THREAD_ID);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "pending", "resetAllSending 后应回 pending");
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo releaseClaim 仅把当前 sending 原子退回 pending", () => {
  const { db, repo } = setupDb();
  try {
    const first = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "A",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    }).item;
    const second = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "B",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    }).item;
    repo.claimNextPending(THREAD_ID);

    assert.equal(repo.releaseClaim(second.id, 0), false, "未认领的 pending 项不能被 release");
    assert.equal(repo.releaseClaim(first.id, 2), false, "旧 attempt 不能释放当前认领");
    assert.equal(repo.releaseClaim(first.id, 1), true);
    assert.equal(repo.releaseClaim(first.id, 1), false, "同一认领只能释放一次");

    const active = repo.listActiveByThread(THREAD_ID);
    assert.deepEqual(active.map((item) => item.id), [first.id, second.id], "释放后保持原 position 顺序");
    assert.deepEqual(active.map((item) => item.status), ["pending", "pending"]);
    assert.equal(active[0]?.attemptCount, 1, "释放认领不回滚已发生的 attempt 计数");

    const reclaimed = repo.claimNextPending(THREAD_ID);
    assert.equal(reclaimed?.id, first.id);
    assert.equal(reclaimed?.attemptCount, 2);
  } finally {
    db.close();
  }
});

test("ThreadMessageQueueRepo remove 单项不影响其它活跃项", () => {
  const { db, repo } = setupDb();
  try {
    const a = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "A",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });
    const b = repo.appendItem({
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text: "B",
      images: [], files: [], sendOptions: SEND_OPTS, originWebSessionId: null,
    });

    const removed = repo.remove(THREAD_ID, a.item.id);
    assert.equal(removed, true);

    const active = repo.listActiveByThread(THREAD_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, b.item.id);
  } finally {
    db.close();
  }
});
