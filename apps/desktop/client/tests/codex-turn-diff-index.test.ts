import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ConversationEventEnvelope, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { analyzeUnifiedDiffPaths, normalizeWorkspaceRelativePosixPath } from "../src/engines/toolFilePaths.js";

/** 执行启动入口的真实索引函数，保留真实SQLite和Git解析，只观察解析边界次数。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-diff-index-"));
  const db = openClientDb({ dbPath: path.join(root, "app.db"), localCanonicalEvents: true });
  const workspaceId = "diff:workspace" as WorkspaceId, threadId = "thread" as ThreadId, turnId = "turn" as TurnId;
  db.workspaces.upsert({ id: workspaceId, title: "diff", path: root });
  const view = db.forWorkspace(workspaceId);
  view.threads.create({ id: threadId, workspaceId, engine: "codex", title: "diff" });
  view.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: 1 });
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["indexCodexTurnDiff", "parseEngineCheckpointObject"];
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(declarations.length, names.length);
  const code = ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  let parses = 0;
  const index = new Function("crypto", "analyzeUnifiedDiffPaths", "normalizeWorkspaceRelativePosixPath",
    `${code}\nreturn indexCodexTurnDiff;`)(crypto, (directory: string, diff: string) => {
      parses++;
      return analyzeUnifiedDiffPaths(directory, diff);
    }, normalizeWorkspaceRelativePosixPath) as (ctx: unknown, event: ConversationEventEnvelope) => void;
  const ctx = { db: view, workspaces: new Map([[workspaceId, root]]) };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { view, turnId, parses: () => parses,
    /** 不改变真实文件，仅将只读补丁解析结果写入所属turn索引。 */
    emit(seq: number, text = patch("file.txt")) {
      index(ctx, { schema: 1, seq, ts: seq * 100, workspaceId, threadId, engine: "codex", type: "item.diff.created",
        payload: { itemId: "diff", turnId, engineTurnId: `provider-${seq}`, diff: text } } as ConversationEventEnvelope);
    },
    checkpoint() { return JSON.parse(view.turns.get(turnId)!.engineCheckpointJson!).codexTurnDiff; },
  };
}

/** 合法统一补丁供真实git apply --numstat只读解析。 */
function patch(file: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after\n`;
}

test("同hash新序号复用成功解析并推进checkpoint，其他字段保留", t => {
  const f = fixture(t);
  f.view.turns.mergeEngineCheckpoint(f.turnId, { unrelated: { keep: true } });
  f.emit(10);
  f.emit(11);
  assert.equal(f.parses(), 1);
  assert.deepEqual(f.checkpoint().paths, ["file.txt"]);
  assert.equal(f.checkpoint().eventSeq, 11);
  assert.equal(f.checkpoint().engineTurnId, "provider-11");
  assert.equal(f.checkpoint().updatedAt, 1100);
  assert.deepEqual(JSON.parse(f.view.turns.get(f.turnId)!.engineCheckpointJson!).unrelated, { keep: true });
  f.emit(12, patch("changed.txt"));
  assert.equal(f.parses(), 2);
  assert.deepEqual(f.checkpoint().paths, ["changed.txt"]);
});

test("迟到seq不解析或覆盖，同seq异正文显式失败", t => {
  const f = fixture(t);
  f.emit(20);
  const checkpoint = f.checkpoint();
  f.emit(19, patch("old.txt"));
  assert.equal(f.parses(), 1);
  assert.deepEqual(f.checkpoint(), checkpoint);
  assert.throws(() => f.emit(20, patch("conflict.txt")), /同序号内容冲突/u);
  assert.deepEqual(f.checkpoint(), checkpoint);
});

test("失败解析不会被当作成功结果复用", t => {
  const f = fixture(t);
  f.emit(10, "invalid patch");
  assert.equal(f.checkpoint().parseComplete, false);
  f.emit(11, "invalid patch");
  assert.equal(f.parses(), 2);
  assert.equal(f.checkpoint().parseComplete, false);
});

test("空diff的零路径结果可复用，来源不匹配则重新验证", t => {
  const f = fixture(t);
  f.emit(10, "");
  f.emit(11, "");
  assert.equal(f.parses(), 1);
  assert.deepEqual(f.checkpoint().paths, []);
  assert.equal(f.checkpoint().eventSeq, 11);
  f.view.turns.mergeEngineCheckpoint(f.turnId, { codexTurnDiff: { ...f.checkpoint(), source: "unverified" } });
  f.emit(12, "");
  assert.equal(f.parses(), 2);
  assert.equal(f.checkpoint().source, "turn/diff/updated");
});

for (const paths of [["../outside.txt"], [null], "invalid"]) {
  test(`不复用不满足路径契约的checkpoint：${JSON.stringify(paths)}`, t => {
    const f = fixture(t);
    f.emit(10);
    f.view.turns.mergeEngineCheckpoint(f.turnId, { codexTurnDiff: { ...f.checkpoint(), paths } });
    f.emit(11);
    assert.equal(f.parses(), 2);
    assert.deepEqual(f.checkpoint().paths, ["file.txt"]);
  });
}
