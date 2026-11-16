import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationEventEnvelope, RawEngineEventEnvelope, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import * as eventRepo from "../src/db/repos/eventRepo.ts";

const NOW = 1_800_000_000_000;
const WORKSPACE_ID = "client-sequence:workspace" as WorkspaceId;
const THREAD_ID = "thread-sequence" as ThreadId;

/** 使用真实 SQLite 事务，测试结束只删除本项创建的临时目录。 */
function setup(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-event-sequence-"));
  const dbPath = path.join(directory, "client.db");
  const harness = { db: openClientDb({ dbPath }), dbPath };
  t.after(() => { harness.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  harness.db.workspaces.upsert({ id: WORKSPACE_ID, title: "Sequence", path: directory });
  harness.db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "Sequence" });
  return harness;
}

/** canonical 夹具只依赖公开仓储，不复制编号规则。 */
function canonical(seq: number): ConversationEventEnvelope {
  return { schema: 1, seq, ts: NOW, workspaceId: WORKSPACE_ID, threadId: THREAD_ID,
    engine: "codex", type: "turn.started", payload: { turnId: "turn-sequence" as any } };
}

/** raw 与 canonical 使用同一工作区，验证两类事件共享高水位。 */
function raw(seq: number): RawEngineEventEnvelope {
  return { schema: 1, seq, ts: NOW, workspaceId: WORKSPACE_ID, threadId: THREAD_ID,
    engine: "codex", source: "sequence-test", data: {}, handled: true, action: "mapped", emittedTypes: [] };
}

test("local event sequence interleaves canonical and raw within the same millisecond", (t) => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const first = eventRepo.allocateClientEventSeq(db.db);
  db.conversationEvents.appendEnvelope(canonical(first), { requireInsert: true });
  const second = eventRepo.allocateClientEventSeq(db.db);
  db.rawEvents.appendEnvelope(raw(second), { requireInsert: true });
  const third = eventRepo.allocateClientEventSeq(db.db);
  db.conversationEvents.appendEnvelope(canonical(third));
  assert.deepEqual([first, second, third], [NOW, NOW + 1, NOW + 2]);
  assert.equal(db.rawEvents.getLatestSeqByThread(THREAD_ID), NOW + 1);
  assert.equal(db.conversationEvents.getLatestSeqByThread(THREAD_ID), NOW + 2);
});

test("local event sequence advances beyond historical raw and canonical maxima", (t) => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  db.conversationEvents.appendEnvelope(canonical(NOW + 5));
  db.rawEvents.appendEnvelope(raw(NOW + 9));
  db.db.prepare("UPDATE meta SET value = ? WHERE key = 'event_seq'").run(String(NOW + 2));
  assert.equal(eventRepo.allocateClientEventSeq(db.db), NOW + 10);
  db.conversationEvents.appendEnvelope(canonical(NOW + 19));
  assert.equal(eventRepo.allocateClientEventSeq(db.db), NOW + 20);
});

test("local event sequence never reuses a deleted high watermark", (t) => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  db.rawEvents.appendEnvelope(raw(NOW + 9));
  const allocated = eventRepo.allocateClientEventSeq(db.db);
  db.conversationEvents.appendEnvelope(canonical(allocated));
  db.conversationEvents.deleteByThread(THREAD_ID);
  db.rawEvents.deleteByThread(THREAD_ID);
  assert.equal(eventRepo.allocateClientEventSeq(db.db), NOW + 11);
});

test("local event sequence survives restart and clock rollback without an event row", (t) => {
  const harness = setup(t);
  const clock = t.mock.method(Date, "now", () => NOW);
  assert.equal(eventRepo.allocateClientEventSeq(harness.db.db), NOW);
  harness.db.close();
  clock.mock.mockImplementation(() => NOW - 60_000);
  harness.db = openClientDb({ dbPath: harness.dbPath });
  assert.equal(eventRepo.allocateClientEventSeq(harness.db.db), NOW + 1);
});

test("local event sequence and event insertion roll back in the caller transaction", (t) => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const before = db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get();
  const failedCommit = db.db.transaction(() => {
    const seq = eventRepo.allocateClientEventSeq(db.db);
    db.conversationEvents.appendEnvelope(canonical(seq));
    throw new Error("simulated index failure");
  });
  assert.throws(failedCommit, /simulated index failure/);
  assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), before);
  assert.equal(db.conversationEvents.getLatestSeq(), 0);
  assert.equal(eventRepo.allocateClientEventSeq(db.db), NOW);
});

test("local event sequence rejects corrupt or missing metadata without repairing it", (t) => {
  const { db } = setup(t);
  for (const value of ["", " ", "invalid", "-1", "1.5", "NaN", "9007199254740992"]) {
    db.db.prepare("UPDATE meta SET value = ? WHERE key = 'event_seq'").run(value);
    assert.throws(() => eventRepo.allocateClientEventSeq(db.db), /序号|sequence/i, value);
    assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value });
  }
  db.db.prepare("DELETE FROM meta WHERE key = 'event_seq'").run();
  assert.throws(() => eventRepo.allocateClientEventSeq(db.db), /序号|sequence/i);
});

test("local event sequence rejects overflow without advancing its high watermark", (t) => {
  const { db } = setup(t);
  const value = String(Number.MAX_SAFE_INTEGER);
  db.db.prepare("UPDATE meta SET value = ? WHERE key = 'event_seq'").run(value);
  assert.throws(() => eventRepo.allocateClientEventSeq(db.db), /序号|sequence/i);
  assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value });
});

test("批量事件序号只耐久提交一次，重启及回退时钟后不复用已预留范围", t => {
  const harness = setup(t);
  const clock = t.mock.method(Date, "now", () => NOW);
  const before = harness.db.db.prepare("SELECT value FROM meta WHERE key='event_seq'").get();
  assert.deepEqual(eventRepo.reserveClientEventSeqs(harness.db.db, 3, { requireOutermost: true, minimumSeqExclusive: NOW + 10 }),
    [NOW + 11, NOW + 12, NOW + 13]);
  assert.notDeepEqual(harness.db.db.prepare("SELECT value FROM meta WHERE key='event_seq'").get(), before);
  harness.db.close();
  clock.mock.mockImplementation(() => NOW - 1000);
  harness.db = openClientDb({ dbPath: harness.dbPath });
  assert.equal(eventRepo.allocateClientEventSeq(harness.db.db), NOW + 14);
});

test("批量预留数量非法或越界不得推进高水位", t => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const before = db.db.prepare("SELECT value FROM meta WHERE key='event_seq'").get();
  for (const count of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => eventRepo.reserveClientEventSeqs(db.db, count, { requireOutermost: true }));
    assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key='event_seq'").get(), before);
  }
});

test("strict event append rejects duplicate canonical and raw while legacy append stays idempotent", (t) => {
  const { db } = setup(t);
  const conversation = canonical(NOW);
  const trace = raw(NOW + 1);
  db.conversationEvents.appendEnvelope(conversation);
  db.rawEvents.appendEnvelope(trace);
  assert.throws(() => db.conversationEvents.appendEnvelope(conversation, { requireInsert: true }), /未写入|not inserted/i);
  assert.throws(() => db.rawEvents.appendEnvelope(trace, { requireInsert: true }), /未写入|not inserted/i);
  assert.doesNotThrow(() => db.conversationEvents.appendEnvelope(conversation));
  assert.doesNotThrow(() => db.rawEvents.appendEnvelope(trace));
  assert.equal(db.conversationEvents.listByThread(THREAD_ID).length, 1);
  assert.equal(db.rawEvents.pageByThread(THREAD_ID).events.length, 1);
});

test("strict canonical append rejects message tombstones and rolls back the allocated counter", (t) => {
  const { db } = setup(t);
  t.mock.method(Date, "now", () => NOW);
  db.conversationEvents.deleteMessage(THREAD_ID, "deleted-message");
  const appendDeleted = db.db.transaction(() => {
    const seq = eventRepo.allocateClientEventSeq(db.db);
    db.conversationEvents.appendEnvelope({
      ...canonical(seq), type: "item.userMessage.created",
      payload: { itemId: "deleted-message" as any, text: "hidden", turnId: "turn-sequence" as any },
    }, { requireInsert: true });
  });
  assert.throws(appendDeleted, /未写入|not inserted/i);
  assert.equal(db.conversationEvents.getLatestSeq(), 0);
  assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: "0" });
});
