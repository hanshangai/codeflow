import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { openClientDb } from "../src/db/clientDb.ts";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.ts";
import { createServerReminderNotifier } from "../src/notifications/serverReminderNotifier.ts";

/** 提取实际 Host context 与统一发送入口，只替换外部连接和页面边界。 */
function fixture(t: test.TestContext) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const sendStart = source.indexOf("  const sendToServer = (message:");
  const sendEnd = source.indexOf("  const takeApiResponseDispatch", sendStart);
  const hostStart = source.indexOf("    const desktopHostContext = (owner:");
  const hostEnd = source.indexOf("    /** 凭据资格同步撤销", hostStart);
  assert.ok(sendStart > 0 && sendEnd > sendStart && hostStart > 0 && hostEnd > hostStart);
  const compiled = ts.transpileModule(`${source.slice(sendStart, sendEnd)}\n${source.slice(hostStart, hostEnd)}\nreturn { ctx: desktopHostContext(owner), sendToServer };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-host-offline-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "desktop-device:project" as never, threadId = "shared-thread" as never;
  db.workspaces.upsert({ id: workspaceId, title: "Host", path: directory });
  db.forWorkspace(workspaceId).threads.create({ id: threadId, workspaceId, engine: "codex", title: "Shared",
    sharedAcl: { sharedWorkspaceId: "shared" as never, ownerUserId: "owner-a" } });
  assert.equal(db.forWorkspace(workspaceId).threads.get(threadId)?.sharedWorkspaceId, "shared");
  let current = true, persistenceFailure: Error | null = null;
  const sent: unknown[] = [], published: unknown[] = [], applied: unknown[] = [];
  const scopes: any[] = [];
  const owner = { generation: 1 }, stale = new Error("DESKTOP_CLOUD_OWNER_STALE_OR_UNAVAILABLE");
  const context = {
    owner, apiHandlerContext: {}, desktopRequestId: "offline-regression", keepFullEventOutput: false,
    config: { clientId: "desktop-device" }, workspaces: new Map([[workspaceId, directory]]), db, desktopHostScopes: scopes,
    sanitizeClientToServerMessage: (value: unknown) => value,
    /** 保留本地持久化失败，不能因断云而伪造成功。 */
    assertWorkspacePersistenceAvailable() { if (persistenceFailure) throw persistenceFailure; },
    desktopLifecycle: { publishEvent: (value: unknown) => published.push(value), isTaskAdmissionPaused: () => false },
    desktopCloudAccount: {
      /** 模拟新账号已连接，但尚未授权旧 Host 范围。 */
      getOwner() { return { generation: current ? 1 : 2, ownerUserId: current ? "owner-a" : "owner-b" }; },
      /** 失效 owner 只负责阻止新操作及远程响应。 */
      assertOwner(value: unknown) { assert.equal(value, owner); if (!current) throw stale; },
      /** 观察是否有旧回合直接投到新云连接。 */
      send(value: unknown) { sent.push(value); return { accepted: true }; },
    },
    localEventPersistence: createLocalEventPersistence({ db, applyConversation: value => applied.push(value), applyRaw: value => applied.push(value) }),
    flushLocalEventRelay() {}, isDesktopLocalThreadAssetExecution: () => false,
  };
  const create = new Function(...Object.keys(context), compiled);
  return { ...create(...Object.values(context)), db, workspaceId, threadId, sent, published, applied, stale, scopes,
    /** 模拟原账号退役，后续远程通道可能已属于其他账号。 */
    retire() { current = false; },
    /** 注入本地准入失败，验证失败仍显式传播。 */
    failPersistence(error: Error) { persistenceFailure = error; },
  };
}

test("已派发共享回合断云后仍提交 canonical/raw，远程响应和新准入继续拒绝旧 owner", t => {
  const f = fixture(t);
  const event = { workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", ts: Date.now() };
  assert.equal(f.ctx.isTaskAdmissionPaused(), false);
  f.retire();
  assert.equal(f.ctx.send({ t: "conversation.event", event: { ...event, type: "turn.completed", payload: { turnId: "in-flight" } } }).accepted, true);
  assert.equal(f.ctx.send({ t: "raw.event", event: { ...event, source: "codex", data: { type: "turn/completed" }, handled: true, action: "mapped", emittedTypes: [] } }).accepted, true);
  const db = f.db.forWorkspace(f.workspaceId);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM conversation_events").get()?.count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get()?.count, 1);
  assert.equal(f.applied.length, 2);
  assert.deepEqual(f.published, []);
  assert.throws(() => f.ctx.send({ t: "api.res", id: "old-request", status: 200, body: { ok: true } }), error => error === f.stale);
  assert.throws(() => f.ctx.isTaskAdmissionPaused(), error => error === f.stale);
  assert.deepEqual(f.sent, []);
});

test("断云不掩盖本地提交失败", t => {
  const f = fixture(t), failure = new Error("WORKSPACE_PERSISTENCE_UNAVAILABLE");
  f.retire(); f.failPersistence(failure);
  assert.throws(() => f.ctx.send({ t: "conversation.event", event: { workspaceId: f.workspaceId, threadId: f.threadId } }), error => error === failure);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.sent, []);
});

test("原全局提醒入口在账号切换后只允许当前授权Host范围", async t => {
  const f = fixture(t);
  f.retire();
  const completion = { t: "reminder.completionNotification", notification: { workspaceId: f.workspaceId,
    sharedWorkspaceId: "shared-a", notificationKey: "private-turn", targetId: f.threadId, title: "PRIVATE_OLD_TITLE" } };
  const action = { ...completion, t: "reminder.actionNotification" }, dirty = { t: "reminders.changed", workspaceId: f.workspaceId };
  for (const message of [completion, action, dirty]) {
    const result = f.sendToServer(message);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "DESKTOP_HOST_REMINDER_SCOPE_REQUIRED");
  }
  const notifier = createServerReminderNotifier({ sendToServer: f.sendToServer });
  await assert.rejects(notifier.notifyCompletion(completion.notification as never), /DESKTOP_HOST_REMINDER_SCOPE_REQUIRED/u);
  await assert.rejects(notifier.notifyAction(action.notification as never), /DESKTOP_HOST_REMINDER_SCOPE_REQUIRED/u);
  assert.deepEqual(f.sent, []);
  f.scopes.push({ workspaceId: f.workspaceId, sharedWorkspaceId: "shared-b", userId: "owner-b", clientId: "desktop-device" });
  assert.equal(f.sendToServer(completion).accepted, false);
  assert.equal(f.sendToServer(action).accepted, false);
  f.scopes[0].sharedWorkspaceId = "shared-a";
  for (const message of [completion, action, dirty]) assert.equal(f.sendToServer(message).accepted, true);
  assert.equal(f.sent.length, 3);
  f.scopes[0].userId = "owner-a";
  for (const message of [completion, action, dirty]) assert.equal(f.sendToServer(message).accepted, false);
  assert.equal(f.sent.length, 3);
});
