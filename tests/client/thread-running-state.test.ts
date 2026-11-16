import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadId, TurnId } from "../../packages/shared/src/index.ts";
import {
  clearActiveThreadTurnIfMatches,
  resolveTurnErrorIndexScope,
  resolveThreadRunningState,
} from "../../apps/desktop/client/src/app/threadRunningState.ts";

test("迟到终态只清理同一 active turn，不误删 successor", () => {
  const threadId = "thread-terminal-successor" as ThreadId;
  const oldTurnId = "turn-old" as TurnId;
  const successorTurnId = "turn-successor" as TurnId;
  const activeTurnByThreadId = new Map([[threadId, { turnId: successorTurnId, startedAt: 200 }]]);

  assert.equal(clearActiveThreadTurnIfMatches(activeTurnByThreadId, threadId, oldTurnId), false);
  assert.equal(activeTurnByThreadId.get(threadId)?.turnId, successorTurnId);
  assert.equal(clearActiveThreadTurnIfMatches(activeTurnByThreadId, threadId, successorTurnId), true);
  assert.equal(activeTurnByThreadId.has(threadId), false);
});

test("停止阶段从精确session owner派生，已保留的运行阶段支持断线重读", () => {
  const threadId = "thread-stop" as ThreadId, turnId = "turn-stop" as TurnId;
  const ctx = { db: { turns: { listRunningByWorkspace: () => ({}) } },
    getActiveThreadTurn: () => ({ turnId, startedAt: 10, source: "runtime" }),
    sessions: { getTurnPhase: (id: string, turn: string) => {
      assert.equal(id, threadId); assert.equal(turn, turnId); return "draining";
    } } } as any;
  assert.deepEqual(resolveThreadRunningState(ctx, { workspaceId: "workspace", threadId }), {
    runningTurnId: turnId, runningTurnStartedAt: 10, runningSource: "runtime", phase: "draining",
  });
  ctx.getActiveThreadTurn = () => ({ turnId, startedAt: 10, source: "runtime", phase: "draining" });
  ctx.sessions.getTurnPhase = () => null;
  assert.equal(resolveThreadRunningState(ctx, { workspaceId: "workspace", threadId })?.phase, "draining");
  ctx.getActiveThreadTurn = () => null;
  ctx.getTurnFinalizationFailure = () => ({ turnId, errorCode: "TURN_FINALIZATION_FAILED" });
  const failed = resolveThreadRunningState(ctx, { workspaceId: "workspace", threadId });
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.failureCode, "TURN_FINALIZATION_FAILED");
});

test("无 turnId 的 turn.error 保持为非 turn scope，不能触发精确终态清理", () => {
  assert.deepEqual(resolveTurnErrorIndexScope(undefined), { kind: "unscoped" });
  assert.deepEqual(resolveTurnErrorIndexScope("  "), { kind: "unscoped" });
  assert.deepEqual(resolveTurnErrorIndexScope(" turn-error "), {
    kind: "turn",
    turnId: "turn-error",
  });
});
