import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ConversationEventInput } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { captureFileChangeBeforeSnapshot, captureFileChangeAfterSnapshot, freezeFileBeforeSnapshot, freezeFileAfterSnapshot,
  type FrozenFileBeforeSnapshot, type FrozenFileAfterSnapshot } from "../src/eventIndex/fileChangeSnapshots.js";
import { extractToolPaths, isFileChangeLikeTool, normalizeChanges, normalizeToolNameKey,
  normalizeWorkspaceRelativePosixPath } from "../src/engines/toolFilePaths.js";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.js";
import { describeWorkspaceApiFailure } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";

/** 提取启动入口的实际函数；不启动 Client、provider 或用户目录。 */
function indexFunctions(dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["captureBeforeSnapshotOnEmit", "captureBeforeForPaths", "captureMissingBeforeForPaths", "applyFileChangeIndexEvent",
    "pickDiffForPath", "pickKindForPath", "resolveActiveStepKey", "tryUpdateClaudeTurnCheckpointsAfterCompaction"];
  const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(declarations.length, names.length);
  const code = ts.transpileModule(declarations.map(node => node.getText(tree)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${names.join(",")} };`)(...Object.values(dependencies));
}

/** W仓储、文件和turn均为本测试真实数据；日志收集仅替换外部应用输出。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-event-index-"));
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "file.ts"), "const original = 1;", "utf8");
  const db = openClientDb({ dbPath: path.join(root, "app.db") });
  db.workspaces.upsert({ id: "workspace", title: "项目", path: directory });
  const view = db.forWorkspace("workspace");
  view.threads.create({ id: "thread", workspaceId: "workspace", engine: "claude", title: "会话" });
  view.threads.setSessionId("thread", "session");
  for (const turnId of ["turn-a", "turn-b"]) {
    view.turns.insertStarted({ workspaceId: "workspace", threadId: "thread", engine: "claude", turnId, startedAt: 1, startEventSeq: null });
    view.turns.setEnded(turnId, { status: "completed", endedAt: 2, endEventSeq: null });
  }
  const applicationLogs: unknown[] = [];
  const methods = indexFunctions({ captureFileChangeBeforeSnapshot, captureFileChangeAfterSnapshot,
    freezeFileBeforeSnapshot, freezeFileAfterSnapshot, describeWorkspaceApiFailure,
    extractToolPaths, isFileChangeLikeTool, normalizeChanges, normalizeToolNameKey, normalizeWorkspaceRelativePosixPath,
    resolveClaudeSessionFilePath: () => "session.jsonl", readClaudeSessionFileByteLen: () => 100,
    logger: { warn: (...args: unknown[]) => { applicationLogs.push(args); }, info: (...args: unknown[]) => { applicationLogs.push(args); } },
    fs, path, STEP_KEY_ORDER: [], parseYaml: () => ({}) });
  const runtime = { activeTurnByThreadId: new Map([["thread", { turnId: "turn-a", engine: "claude" }]]),
    pendingToolPathsByItemId: new Map(), stepKeyByTurnId: new Map() };
  const ctx = { db, workspaces: new Map([["workspace", directory]]), runtime };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, view, directory, ctx, methods, applicationLogs };
}

test("emit前快照存储失败显式抛出，所属W记录诊断且应用日志无副本", t => {
  const f = fixture(t), original = new Error("SNAPSHOT_STORAGE_FAILED"), logs: any[] = [];
  f.view.blobs.put = () => { throw original; };
  f.view.writeWorkspaceLog = (workspaceId, entry) => { logs.push({ workspaceId, ...entry }); };
  assert.throws(() => f.methods.captureBeforeSnapshotOnEmit(f.ctx, { workspaceId: "workspace", threadId: "thread", engine: "claude",
    type: "item.tool.started", payload: { itemId: "tool", toolName: "Edit", input: { file_path: "file.ts" } } }), error => error === original);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].workspaceId, "workspace");
  assert.equal(logs[0].data.code, "CONVERSATION_BEFORE_SNAPSHOT_FAILED");
  assert.deepEqual(f.applicationLogs, []);
});

test("emit前存储和日志双错保原因及falsy诊断错误", t => {
  const f = fixture(t), original = new Error("SNAPSHOT_STORAGE_FAILED");
  f.view.blobs.put = () => { throw original; };
  f.view.writeWorkspaceLog = () => { throw undefined; };
  assert.throws(() => f.methods.captureBeforeSnapshotOnEmit(f.ctx, { workspaceId: "workspace", threadId: "thread", engine: "claude",
    type: "item.tool.started", payload: { itemId: "tool", toolName: "Edit", input: { file_path: "file.ts" } } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, undefined]);
    assert.equal(error.cause, original); return true;
  });
});

test("压缩checkpoint整组同W提交，第二条写失败回滚且不伪报成功", t => {
  const f = fixture(t);
  f.view.db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF engine_checkpoint_json ON thread_turns WHEN OLD.turn_id='turn-b' BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_WRITE_FAILED'); END;");
  assert.throws(() => f.methods.tryUpdateClaudeTurnCheckpointsAfterCompaction(f.ctx, { workspaceId: "workspace", threadId: "thread" }), /CHECKPOINT_WRITE_FAILED/);
  assert.ok(f.view.turns.listByThread("thread").every(turn => turn.engineCheckpointJson === null));
  assert.deepEqual(f.applicationLogs, []);
});

test("无法读取文件时保护哨兵明确落盘，诊断只记W且不泄露正文", t => {
  const f = fixture(t), nativeStat = fs.statSync, secret = "PRIVATE_SNAPSHOT_CONTENT";
  const original = Object.assign(new Error(secret), { code: "EIO" });
  const logs: any[] = [], app: unknown[] = [];
  t.mock.method(fs, "statSync", ((...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === path.join(f.directory, "file.ts")) throw original;
    return nativeStat(...args);
  }) as typeof fs.statSync);
  t.mock.method(logger, "error", (...args) => { app.push(args); });
  f.view.writeWorkspaceLog = (workspaceId, entry) => { logs.push({ workspaceId, ...entry }); };
  assert.equal(captureFileChangeBeforeSnapshot({ db: f.view, workspacePath: f.directory, workspaceId: "workspace", threadId: "thread",
    turnId: "turn-a", path: "file.ts", capturedAt: 1 }), "unavailable");
  assert.equal(f.view.fileChanges.get("thread", "turn-a", "file.ts")?.beforeBlobId, null);
  assert.equal(logs.length, 1); assert.equal(logs[0].workspaceId, "workspace");
  assert.equal(logs[0].data.rootCause.code, "EIO");
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.deepEqual(app, []);
});

for (const child of [false, true]) {
  test(`${child ? "子工具" : "顶层工具"}emit冻结证据随原turn保存，后续active和磁盘变化不能覆盖after`, t => {
    const f = fixture(t), file = path.join(f.directory, "file.ts");
    const beforeSnapshots = new WeakMap<ConversationEventInput, FrozenFileBeforeSnapshot[]>();
    const afterSnapshots = new WeakMap<ConversationEventInput, FrozenFileAfterSnapshot[]>();
    const emitContext = { ...f.ctx, db: new Proxy(f.db, { get() { throw new Error("EMIT_DATABASE_ACCESS_FORBIDDEN"); } }),
      deferredSnapshots: beforeSnapshots, deferredAfterSnapshots: afterSnapshots };
    const base = { ts: 1, workspaceId: "workspace", threadId: "thread", engine: "claude" as const };
    const startedPayload = { itemId: "write-tool", toolName: "Edit", input: { file_path: "file.ts" } };
    const started: ConversationEventInput = child
      ? { ...base, type: "item.subagent.childEvent", payload: { itemId: "parent-tool", taskId: "child", innerEventType: "item.tool.started", innerPayload: startedPayload } }
      : { ...base, type: "item.tool.started", payload: startedPayload };
    f.methods.captureBeforeSnapshotOnEmit(emitContext, started);
    assert.equal(beforeSnapshots.get(started)?.[0]?.turnId, "turn-a");
    const persistence = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
    fs.writeFileSync(file, "const completed = 2;", "utf8");
    f.ctx.runtime.activeTurnByThreadId.set("thread", { turnId: "turn-b", engine: "claude" });
    const completedPayload = { itemId: "write-tool", toolName: "Edit", status: "completed" as const,
      changes: [{ path: "file.ts", kind: "modify", diff: "completion diff" }] };
    const completed: ConversationEventInput = child
      ? { ...base, ts: 2, type: "item.subagent.childEvent", payload: { itemId: "parent-tool", taskId: "child", innerEventType: "item.tool.completed", innerPayload: completedPayload } }
      : { ...base, ts: 2, type: "item.tool.completed", payload: completedPayload };
    f.methods.captureBeforeSnapshotOnEmit(emitContext, completed);
    const frozen = afterSnapshots.get(completed)!;
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0]!.turnId, "turn-a");
    assert.equal(frozen[0]!.itemId, child ? "sub_write-tool" : "write-tool");
    fs.writeFileSync(file, "const subsequent = 3;", "utf8");
    const read = fs.readFileSync;
    t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw new Error("HISTORICAL_AFTER_MUST_NOT_READ_CURRENT_FILE");
      return read(...args);
    }) as typeof fs.readFileSync);
    persistence.commitBatch({ batchId: "file-effects", workspaceId: "workspace", ownerGeneration: 1, turnId: frozen[0]!.turnId,
      events: [{ t: "conversation.event", event: started, beforeSnapshots: beforeSnapshots.get(started) },
        { t: "conversation.event", event: completed, afterSnapshots: frozen }] });
    const restored = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
    restored.applyBatchEffects("workspace", "file-effects", message => {
      f.methods.applyFileChangeIndexEvent(f.ctx, message.event, true);
    });
    restored.confirmBatch("workspace", "file-effects");
    const record = f.view.fileChanges.get("thread", "turn-a", "file.ts")!;
    assert.equal(f.view.blobs.get(record.beforeBlobId!)!.data.toString("utf8"), "const original = 1;");
    assert.equal(f.view.blobs.get(record.afterBlobId!)!.data.toString("utf8"), "const completed = 2;");
    assert.equal(record.diffText, "completion diff");
    assert.equal(f.view.fileChanges.get("thread", "turn-b", "file.ts"), null);
    assert.equal(restored.readPendingBatch("workspace"), null);
  });
}

test("完成事件未知工具且无pending归属时不能按只读标记空证据", t => {
  const f = fixture(t);
  const afterSnapshots = new WeakMap<ConversationEventInput, FrozenFileAfterSnapshot[]>();
  const event: ConversationEventInput = { ts: 2, workspaceId: "workspace", threadId: "thread", engine: "claude",
    type: "item.tool.completed", payload: { itemId: "orphan-tool", status: "completed" } };
  assert.throws(() => f.methods.captureBeforeSnapshotOnEmit({ ...f.ctx,
    deferredSnapshots: new WeakMap(), deferredAfterSnapshots: afterSnapshots }, event), /LOCAL_EVENT_TOOL_IDENTITY_REQUIRED/u);
  assert.equal(afterSnapshots.has(event), false);
});
