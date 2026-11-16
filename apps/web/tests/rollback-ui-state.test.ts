import test from "node:test";
import assert from "node:assert/strict";

import type { RollbackFileInfo, RollbackThreadResponseBody } from "@codeflowai/shared";

import {
  buildRollbackFeedback,
  canConfirmRollback,
  isRollbackFileSelectable,
} from "../src/features/chat/rollbackUiState.ts";

const safeFile: RollbackFileInfo = {
  path: "src/app.ts",
  rollbackOp: "restore",
  hasConflict: false,
  conflictReason: null,
  canRollback: true,
};

test("rollback confirmation requires a successful preview and a safe file selection", () => {
  assert.equal(canConfirmRollback({
    previewReady: false,
    previewError: null,
    previewScopeMatches: true,
    rollbackFiles: false,
    evidenceComplete: true,
    selectedFileCount: 0,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: "preview failed",
    previewScopeMatches: true,
    rollbackFiles: false,
    evidenceComplete: true,
    selectedFileCount: 0,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: "",
    previewScopeMatches: true,
    rollbackFiles: false,
    evidenceComplete: true,
    selectedFileCount: 0,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: null,
    previewScopeMatches: false,
    rollbackFiles: false,
    evidenceComplete: true,
    selectedFileCount: 0,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: null,
    previewScopeMatches: true,
    rollbackFiles: false,
    evidenceComplete: false,
    selectedFileCount: 0,
  }), true);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: null,
    previewScopeMatches: true,
    rollbackFiles: true,
    evidenceComplete: false,
    selectedFileCount: 1,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: null,
    previewScopeMatches: true,
    rollbackFiles: true,
    evidenceComplete: true,
    selectedFileCount: 0,
  }), false);
  assert.equal(canConfirmRollback({
    previewReady: true,
    previewError: null,
    previewScopeMatches: true,
    rollbackFiles: true,
    evidenceComplete: true,
    selectedFileCount: 1,
  }), true);
});

test("rollback file selection rejects conflicts, missing snapshots, and incomplete evidence", () => {
  assert.equal(isRollbackFileSelectable(safeFile, true), true);
  assert.equal(isRollbackFileSelectable({ ...safeFile, hasConflict: true }, true), false);
  assert.equal(isRollbackFileSelectable({ ...safeFile, canRollback: false }, true), false);
  assert.equal(isRollbackFileSelectable(safeFile, false), false);
});

test("rollback feedback distinguishes history-only, full file rollback, and retained files", () => {
  const historyOnly: RollbackThreadResponseBody = {
    droppedTurnCount: 2,
    revertedFileCount: 0,
    skippedFileCount: 3,
    fileRollbackStatus: "not_requested",
  };
  assert.deepEqual(buildRollbackFeedback(historyOnly), {
    level: "success",
    message: "已回滚对话历史：删除 2 轮；文件变更保持不变",
  });

  const completed: RollbackThreadResponseBody = {
    droppedTurnCount: 2,
    revertedFileCount: 3,
    skippedFileCount: 0,
    fileRollbackStatus: "completed",
  };
  assert.deepEqual(buildRollbackFeedback(completed), {
    level: "success",
    message: "已回滚对话历史：删除 2 轮；回滚 3 个文件",
  });

  const retained: RollbackThreadResponseBody = {
    droppedTurnCount: 2,
    revertedFileCount: 1,
    skippedFileCount: 2,
    fileRollbackStatus: "completed",
  };
  assert.deepEqual(buildRollbackFeedback(retained), {
    level: "warning",
    message: "已回滚对话历史：删除 2 轮；回滚 1 个所选文件，保留 2 个未选文件",
  });
});
