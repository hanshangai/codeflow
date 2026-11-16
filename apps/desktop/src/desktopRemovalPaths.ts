/** 桌面卸载只删除固定授权清单；默认工作区与未知文件始终保留。 */
export const GENERATED_FILES = ["crash-reports.jsonl", "crash-session.json", "crash-session.clean.json", "crash-session.retry.json",
  "legacy-client-migration-account.json", "legacy-client-migration-journal.json"];
export const REMOVE_FILES = ["shell-update-attempt.json", "config.json", "codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "codeflowai.db-shm", "codeflowai.db-journal",
  "active-release.json", "previous-release.json", "errors.jsonl", "update-receipts.jsonl", ...GENERATED_FILES, "pending-release.json", "update-database-backup.json"];
export const REMOVE_DIRECTORIES = ["releases", ".staging", "logs", "legacy-client-migration", "cli-runtime", "update-database-backups", ".shell-update-file-auth"];
