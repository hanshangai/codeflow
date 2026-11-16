import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { migrateClientDb, CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { ThreadDraftRepo } from "../src/db/repos/threadDraftRepo.ts";
import { ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";
import {
  buildClientThreadPromptText,
  getOrCreateThreadInputActionHmacKey,
  normalizeClientThreadDisplayInput,
  resolveProviderSlashPreflightConflict,
} from "../src/engines/threadInputActions.ts";

const WORKSPACE_ID = "test:input-contract-ws" as WorkspaceId;
const THREAD_ID = "test_input_contract_thread" as ThreadId;
const SKILL_ID = `csk_${"a".repeat(43)}`;

test("Client Provider Slash 保留原文并在 mutation 前拒绝运行态冲突", () => {
  assert.deepEqual(normalizeClientThreadDisplayInput({
    text: "/review  src/a.ts  ",
    inputKind: "provider-slash",
  }), { text: "/review  src/a.ts  " });
  assert.equal(resolveProviderSlashPreflightConflict({
    engine: "claude",
    rawText: "/review  src/a.ts  ",
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    hasActiveTurn: false,
    hasQueuedInput: false,
  }), null);
  assert.match(resolveProviderSlashPreflightConflict({
    engine: "claude",
    rawText: "/review",
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    hasActiveTurn: false,
    hasQueuedInput: true,
  }) ?? "", /队列/u);
  assert.match(resolveProviderSlashPreflightConflict({
    engine: "claude",
    rawText: " /review",
    hasRole: false,
    imageCount: 0,
    fileCount: 0,
    pathReferenceCount: 0,
    hasActiveTurn: false,
    hasQueuedInput: false,
  }) ?? "", /第一个字符/u);
  assert.equal(buildClientThreadPromptText({
    text: "/review  src/a.ts  ",
    inputKind: "provider-slash",
    files: [],
    pathReferences: [],
  }), "/review  src/a.ts  ");
  assert.equal(buildClientThreadPromptText({
    text: "  ordinary message  ",
    inputKind: "message",
    files: [],
    pathReferences: [],
  }), "ordinary message");
});

function setupDb(engine = "codex"): SqliteDb {
  const db = openSqliteDb(":memory:");
  migrateClientDb(db);
  const now = Date.now();
  db.prepare("INSERT INTO workspaces (id, title, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(String(WORKSPACE_ID), "input contract", "/tmp/input-contract", now, now);
  db.prepare("INSERT INTO threads (id, workspace_id, engine, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(String(THREAD_ID), String(WORKSPACE_ID), engine, "input contract", now, now);
  return db;
}

function columns(db: SqliteDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

test("v83 creates, upgrades, and repairs all input-contract columns", () => {
  const db = openSqliteDb(":memory:");
  try {
    migrateClientDb(db);
    assert.equal(Number(db.pragma("user_version", { simple: true })), CLIENT_DB_SCHEMA_VERSION);
    assert.ok(columns(db, "thread_drafts").includes("input_kind"));
    assert.ok(columns(db, "thread_drafts").includes("skill_mentions_json"));
    assert.ok(columns(db, "thread_message_queue").includes("input_kind"));
    assert.ok(columns(db, "thread_message_queue").includes("skill_mentions_json"));

    db.exec("ALTER TABLE thread_drafts DROP COLUMN input_kind");
    db.exec("ALTER TABLE thread_message_queue DROP COLUMN skill_mentions_json");
    // 模拟 v82 时同步移除 v102 新表，避免伪造旧版本重复执行新建表迁移。
    db.exec("DROP TABLE local_model_context_preferences; DROP TABLE local_quick_phrases; DROP TABLE local_quick_phrase_collection");
    db.pragma("user_version = 82");
    migrateClientDb(db);
    assert.ok(columns(db, "thread_drafts").includes("input_kind"));
    assert.ok(columns(db, "thread_message_queue").includes("skill_mentions_json"));

    db.exec("ALTER TABLE thread_drafts DROP COLUMN skill_mentions_json");
    db.exec("ALTER TABLE thread_message_queue DROP COLUMN input_kind");
    migrateClientDb(db);
    assert.ok(columns(db, "thread_drafts").includes("skill_mentions_json"));
    assert.ok(columns(db, "thread_message_queue").includes("input_kind"));
  } finally {
    db.close();
  }
});

test("draft and queue round-trip explicit input semantics without persisting a Skill path", () => {
  const db = setupDb();
  try {
    const blobs = new FileBlobRepo(db);
    const drafts = new ThreadDraftRepo(db, blobs);
    const queue = new ThreadMessageQueueRepo(db, blobs);
    const text = "use $review";
    const skillMentions = [{ skillId: SKILL_ID, name: "review", start: 4, end: 11 }];

    const draft = drafts.save({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text,
      inputKind: "message",
      skillMentions,
      images: [],
      files: [],
      pathReferences: [],
    });
    assert.equal(draft.inputKind, "message");
    assert.deepEqual(draft.skillMentions, skillMentions);
    assert.deepEqual(drafts.get(THREAD_ID)?.skillMentions, skillMentions);

    const queued = queue.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text,
      inputKind: "message",
      skillMentions,
      images: [],
      files: [],
      pathReferences: [],
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: null,
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
      originWebSessionId: null,
    }).item;
    assert.equal(queued.inputKind, "message");
    assert.deepEqual(queued.skillMentions, skillMentions);
    assert.equal(queue.peekNextPendingNeedsFreshTurn(THREAD_ID), true);
    const raw = db.prepare("SELECT input_kind, skill_mentions_json FROM thread_message_queue WHERE id = ?")
      .get(queued.id) as { input_kind: string; skill_mentions_json: string };
    assert.equal(raw.input_kind, "message");
    assert.equal(raw.skill_mentions_json.includes("SKILL.md"), false);
  } finally {
    db.close();
  }
});

test("legacy NULL hydrates as an omitted field and a damaged claim is atomically failed", () => {
  const db = setupDb();
  try {
    const blobs = new FileBlobRepo(db);
    const queue = new ThreadMessageQueueRepo(db, blobs);
    const legacy = queue.appendItem({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: "legacy",
      images: [],
      files: [],
      pathReferences: [],
      sendOptions: {
        workMode: "general",
        planMode: false,
        accessMode: null,
        model: null,
        effort: null,
        contextWindow: null,
        autoCompactPct: null,
        serviceTier: null,
      },
      originWebSessionId: null,
    }).item;
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, "inputKind"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, "skillMentions"), false);

    db.prepare("UPDATE thread_message_queue SET skill_mentions_json = ? WHERE id = ?")
      .run("{broken", legacy.id);
    const claim = queue.claimNextPendingForDispatch(THREAD_ID);
    assert.equal(claim?.kind, "contract-invalid");
    const row = db.prepare("SELECT status, failure_code FROM thread_message_queue WHERE id = ?")
      .get(legacy.id) as { status: string; failure_code: string };
    assert.deepEqual(row, { status: "failed", failure_code: "queue_input_contract_invalid" });
  } finally {
    db.close();
  }
});

test("thread input action HMAC key is local, stable, and 32 bytes", () => {
  const db = setupDb();
  try {
    const first = getOrCreateThreadInputActionHmacKey(db);
    const second = getOrCreateThreadInputActionHmacKey(db);
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    const rows = db.prepare("SELECT key FROM meta WHERE key = 'thread_input_actions_hmac_v1'").all();
    assert.equal(rows.length, 1);
  } finally {
    db.close();
  }
});
