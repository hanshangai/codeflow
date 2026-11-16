import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadId } from "@codeflowai/shared";

import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";

function setup(): { db: SqliteDb; blobs: FileBlobRepo } {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  const blobs = new FileBlobRepo(db);
  return { db, blobs };
}

function rawCount(db: SqliteDb, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

test("FileBlobRepo.tryDeleteIfUnreferenced: 无引用 → 真删 file_blobs 行", () => {
  const { db, blobs } = setup();
  try {
    const id = blobs.put(Buffer.from("hello", "utf8"), "utf8");
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 1);

    const removed = blobs.tryDeleteIfUnreferenced(id);
    assert.equal(removed, true);
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 0);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.tryDeleteIfUnreferenced: 仍被 thread_draft_attachments 引用 → 不删", () => {
  const { db, blobs } = setup();
  try {
    db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws_x", "ws", "/tmp", Date.now(), Date.now());
    db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("t_x", "ws_x", "claude", "t", Date.now(), Date.now());
    db.prepare("INSERT INTO thread_drafts (thread_id, workspace_id, text, version, updated_at) VALUES (?, ?, ?, ?, ?)").run("t_x", "ws_x", "", 1, Date.now());

    const id = blobs.put(Buffer.from("img-data", "utf8"), "utf8");
    db.prepare(
      "INSERT INTO thread_draft_attachments (thread_id, attachment_id, kind, order_index, name, display_name, mime, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_x", "att_1", "image", 0, "img", null, "", 8, id);

    const removed = blobs.tryDeleteIfUnreferenced(id);
    assert.equal(removed, false, "仍有 attachment 引用，不应删");
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 1);

    // 删 attachment 行后，引用消失，再 GC 应成功
    db.prepare("DELETE FROM thread_draft_attachments WHERE attachment_id = ?").run("att_1");
    assert.equal(blobs.tryDeleteIfUnreferenced(id), true);
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 0);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.tryDeleteIfUnreferenced: 同 blob 被多源共享时只在最后一个引用消失后删", () => {
  const { db, blobs } = setup();
  try {
    db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws_y", "ws", "/tmp", Date.now(), Date.now());
    db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("t_y", "ws_y", "claude", "t", Date.now(), Date.now());
    db.prepare("INSERT INTO thread_drafts (thread_id, workspace_id, text, version, updated_at) VALUES (?, ?, ?, ?, ?)").run("t_y", "ws_y", "", 1, Date.now());

    const id = blobs.put(Buffer.from("shared", "utf8"), "utf8");
    // 同 sha 在 draft 与 queue attachment 各引用一次（实际就是 sha 去重场景）
    db.prepare(
      "INSERT INTO thread_draft_attachments (thread_id, attachment_id, kind, order_index, name, display_name, mime, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_y", "draft_a", "image", 0, "img", null, "", 6, id);
    db.prepare(
      "INSERT INTO thread_message_queue (id, thread_id, workspace_id, position, status, text, attachments_json, send_options_json, enqueued_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, '[]', '{}', ?, ?)",
    ).run("queue_1", "t_y", "ws_y", 1024, "", Date.now(), Date.now());
    db.prepare(
      "INSERT INTO thread_message_queue_attachments (id, queue_item_id, kind, order_index, name, display_name, mime, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("qatt_a", "queue_1", "image", 0, "img", null, "", 6, id);

    // 仅删除一个引用，blob 仍应保留
    db.prepare("DELETE FROM thread_draft_attachments WHERE attachment_id = ?").run("draft_a");
    assert.equal(blobs.tryDeleteIfUnreferenced(id), false, "另一处仍引用，不应删");
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 1);

    // 删除最后一个引用后，blob 应被删
    db.prepare("DELETE FROM thread_message_queue_attachments WHERE id = ?").run("qatt_a");
    assert.equal(blobs.tryDeleteIfUnreferenced(id), true);
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id = ?", id), 0);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.tryDeleteIfUnreferenced: turn_file_changes 三个引用列任一非空都阻止 GC", () => {
  const { db, blobs } = setup();
  try {
    db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws_z", "ws", "/tmp", Date.now(), Date.now());
    db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("t_z", "ws_z", "claude", "t", Date.now(), Date.now());
    db.prepare(
      "INSERT INTO thread_turns (turn_id, thread_id, workspace_id, engine, status, start_event_seq, end_event_seq, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("turn_z", "t_z", "ws_z", "claude", "completed", 1, 5, Date.now());

    const idBefore = blobs.put(Buffer.from("before-snap", "utf8"), "utf8");
    const idAfter = blobs.put(Buffer.from("after-snap", "utf8"), "utf8");
    const idAccepted = blobs.put(Buffer.from("accepted-snap", "utf8"), "utf8");

    db.prepare(
      "INSERT INTO turn_file_changes (thread_id, turn_id, path, op, before_blob_id, after_blob_id, before_exists, after_exists, captured_at, accepted_blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_z", "turn_z", "a.txt", "modify", idBefore, idAfter, 1, 1, Date.now(), idAccepted);

    // 三个引用列各占一个 blob，都不能删
    assert.equal(blobs.tryDeleteIfUnreferenced(idBefore), false, "before_blob_id 仍引用");
    assert.equal(blobs.tryDeleteIfUnreferenced(idAfter), false, "after_blob_id 仍引用");
    assert.equal(blobs.tryDeleteIfUnreferenced(idAccepted), false, "accepted_blob_id 仍引用");

    // 删 turn_file_changes 行后三个 blob 都应可删
    db.prepare("DELETE FROM turn_file_changes WHERE thread_id = ?").run("t_z");
    assert.equal(blobs.tryDeleteIfUnreferenced(idBefore), true);
    assert.equal(blobs.tryDeleteIfUnreferenced(idAfter), true);
    assert.equal(blobs.tryDeleteIfUnreferenced(idAccepted), true);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.tryDeleteIfUnreferencedMany: 批量去重 + 跳过空字符串", () => {
  const { db, blobs } = setup();
  try {
    const id1 = blobs.put(Buffer.from("a", "utf8"), "utf8");
    const id2 = blobs.put(Buffer.from("b", "utf8"), "utf8");
    const removed = blobs.tryDeleteIfUnreferencedMany([id1, "", id2, id1, "  "]);
    assert.deepEqual(removed.sort(), [id1, id2].sort());
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs", ), 0);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.tryDeleteIfUnreferencedMany: 任一删除失败时整批回滚", () => {
  const { db, blobs } = setup();
  try {
    const id1 = blobs.put(Buffer.from("atomic-a", "utf8"), "utf8");
    const id2 = blobs.put(Buffer.from("atomic-b", "utf8"), "utf8");
    db.exec(`
      CREATE TRIGGER fail_second_blob_delete
      BEFORE DELETE ON file_blobs
      WHEN OLD.blob_id = '${id2}'
      BEGIN
        SELECT RAISE(ABORT, 'forced batch delete failure');
      END;
    `);

    assert.throws(
      () => blobs.tryDeleteIfUnreferencedMany([id1, id2]),
      /forced batch delete failure/,
    );
    assert.equal(rawCount(db, "SELECT COUNT(*) AS c FROM file_blobs WHERE blob_id IN (?, ?)", id1, id2), 2);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.collectReferencedByThreadIds: 汇总五类引用并排除其他会话", () => {
  const { db, blobs } = setup();
  try {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("ws_collect", "ws", "/tmp", now, now);
    for (const threadId of ["t_collect", "t_other"]) {
      db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(threadId, "ws_collect", "claude", threadId, now, now);
      db.prepare(
        "INSERT INTO thread_turns (turn_id, thread_id, workspace_id, engine, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(`turn_${threadId}`, threadId, "ws_collect", "claude", "completed", now);
    }

    const beforeId = blobs.put(Buffer.from("before", "utf8"), "utf8");
    const afterId = blobs.put(Buffer.from("after", "utf8"), "utf8");
    const acceptedId = blobs.put(Buffer.from("accepted", "utf8"), "utf8");
    const draftId = blobs.put(Buffer.from("draft", "utf8"), "utf8");
    const queueId = blobs.put(Buffer.from("queue", "utf8"), "utf8");
    const otherId = blobs.put(Buffer.from("other", "utf8"), "utf8");
    db.prepare(
      "INSERT INTO turn_file_changes (thread_id, turn_id, path, op, before_blob_id, after_blob_id, accepted_blob_id, before_exists, after_exists, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_collect", "turn_t_collect", "target.txt", "modify", beforeId, afterId, acceptedId, 1, 1, now);
    db.prepare(
      "INSERT INTO turn_file_changes (thread_id, turn_id, path, op, before_blob_id, before_exists, after_exists, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_other", "turn_t_other", "other.txt", "modify", otherId, 1, 0, now);
    db.prepare("INSERT INTO thread_drafts (thread_id, workspace_id, text, version, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("t_collect", "ws_collect", "", 1, now);
    db.prepare(
      "INSERT INTO thread_draft_attachments (thread_id, attachment_id, kind, order_index, name, mime, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t_collect", "draft_collect", "file", 0, "draft", "", 5, draftId);
    db.prepare(
      "INSERT INTO thread_message_queue (id, thread_id, workspace_id, position, status, text, attachments_json, send_options_json, enqueued_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, '[]', '{}', ?, ?)",
    ).run("queue_collect", "t_collect", "ws_collect", 1024, "", now, now);
    db.prepare(
      "INSERT INTO thread_message_queue_attachments (id, queue_item_id, kind, order_index, name, mime, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("queue_attachment_collect", "queue_collect", "file", 0, "queue", "", 5, queueId);

    const actual = blobs.collectReferencedByThreadIds(["t_collect" as ThreadId, "t_collect" as ThreadId]);
    const expectedByteLens = new Map([
      [beforeId, 6],
      [afterId, 5],
      [acceptedId, 8],
      [draftId, 5],
      [queueId, 5],
    ]);
    const expected = [...expectedByteLens]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([blobId, byteLen]) => ({ blobId, byteLen }));
    assert.deepEqual(actual, expected);
    assert.equal(actual.some((item) => item.blobId === otherId), false);
  } finally {
    db.close();
  }
});

test("FileBlobRepo.collectReferencedByThreadIds: 各引用源按 thread 索引查询", () => {
  const { db } = setup();
  try {
    let collectSql = "";
    let collectParams: unknown[] = [];
    const tracedDb = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("referenced_blobs(blob_id)")) return statement;
          return {
            get: (...params: unknown[]) => statement.get(...params),
            all: (...params: unknown[]) => {
              collectSql = sql;
              collectParams = params;
              return statement.all(...params);
            },
            run: (...params: unknown[]) => statement.run(...params),
            iterate: (...params: unknown[]) => statement.iterate(...params),
          };
        };
      },
    }) as SqliteDb;

    const tracedBlobs = new FileBlobRepo(tracedDb);
    assert.deepEqual(tracedBlobs.collectReferencedByThreadIds(["thread_plan" as ThreadId]), []);
    assert.ok(collectSql, "应捕获 blob 引用收集查询");

    const details = db.prepare(`EXPLAIN QUERY PLAN ${collectSql}`)
      .all(...collectParams)
      .map((row) => String((row as { detail?: unknown }).detail ?? ""))
      .join("\n");
    assert.match(details, /SEARCH turn_file_changes USING INDEX idx_turn_file_changes_thread_path/);
    assert.match(details, /SEARCH thread_draft_attachments USING INDEX idx_thread_draft_attachments_thread_order/);
    assert.match(details, /SEARCH queue_item USING INDEX idx_thread_message_queue_thread_pos/);
    assert.match(details, /SEARCH attachment USING INDEX idx_thread_message_queue_attachments_item_order/);
    assert.doesNotMatch(details, /idx_turn_file_changes_(?:after|accepted)_blob_id/);
    assert.doesNotMatch(details, /\bSCAN (?:draft|attachment)\b/);
  } finally {
    db.close();
  }
});
