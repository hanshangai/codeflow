import type { RollbackFileInfo, RollbackThreadResponseBody } from "@codeflowai/shared";

export type RollbackFeedback = {
  level: "success" | "warning";
  message: string;
};

/** 仅允许证据完整、快照可用且磁盘无冲突的文件进入自动回滚。 */
export function isRollbackFileSelectable(file: RollbackFileInfo, evidenceComplete: boolean): boolean {
  return evidenceComplete && file.canRollback && !file.hasConflict;
}

/** 统一判断回滚预览是否足以提交，文件模式还必须至少选择一个安全文件。 */
export function canConfirmRollback(input: {
  previewReady: boolean;
  previewError: string | null;
  previewScopeMatches: boolean;
  rollbackFiles: boolean;
  evidenceComplete: boolean;
  selectedFileCount: number;
}): boolean {
  if (!input.previewReady || input.previewError !== null || !input.previewScopeMatches) return false;
  if (!input.rollbackFiles) return true;
  return input.evidenceComplete && input.selectedFileCount > 0;
}

/** 根据权威文件回滚状态生成不夸大结果的用户反馈。 */
export function buildRollbackFeedback(result: RollbackThreadResponseBody): RollbackFeedback {
  const historyText = `已回滚对话历史：删除 ${result.droppedTurnCount} 轮`;
  if (result.fileRollbackStatus === "not_requested") {
    return { level: "success", message: `${historyText}；文件变更保持不变` };
  }
  if (result.skippedFileCount > 0) {
    return {
      level: "warning",
      message: `${historyText}；回滚 ${result.revertedFileCount} 个所选文件，保留 ${result.skippedFileCount} 个未选文件`,
    };
  }
  if (result.revertedFileCount > 0) {
    return { level: "success", message: `${historyText}；回滚 ${result.revertedFileCount} 个文件` };
  }
  return { level: "success", message: `${historyText}；没有需要回滚的文件` };
}
