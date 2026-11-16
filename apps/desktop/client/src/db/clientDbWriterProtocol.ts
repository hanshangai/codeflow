import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import type { LocalEventBatch, LocalEventCommitReceipt } from "../runtime/localEventPersistence.js";

export type { LocalEventBatch, LocalEventCommitReceipt };
export const CLIENT_DB_WRITER_PROTOCOL_VERSION = 2;

export type ClientDbWriterWorkerData = {
  dbPath: string;
  writerEpoch: string;
  clientId?: string;
  maxWorkspaceConnections: number;
  workspaceIdleMs: number;
};

export type ClientDbWriterCommand =
  | { type: "commit"; commandId: string; batch: LocalEventBatch }
  | { type: "indexDatabase"; commandId: string; workspaceId: WorkspaceId; batchId: string }
  | { type: "indexed"; commandId: string; workspaceId: WorkspaceId; batchId: string; indexedCount: number }
  | { type: "confirmed"; commandId: string; workspaceId: WorkspaceId; batchId: string }
  | { type: "readySeq"; commandId: string; workspaceId: WorkspaceId }
  | { type: "drainWorkspace"; commandId: string; workspaceId: WorkspaceId }
  | { type: "invalidate"; commandId: string }
  | { type: "close"; commandId: string };

export type ClientDbWriterFailure = { code: string; message: string; requestId?: string; workspaceId?: WorkspaceId; batchId?: string;
  rootCause?: { name: string; message: string | null } };
export type ClientDbWriterMessage =
  | { type: "ready"; protocolVersion: number }
  | { type: "result"; commandId: string; receipt?: LocalEventCommitReceipt; readyThroughSeq?: number; localThreadIds?: ThreadId[] }
  | { type: "failed"; commandId: string; error: ClientDbWriterFailure }
  | { type: "fatal"; error: ClientDbWriterFailure }
  | { type: "closed"; commandId: string };

/** Reader 的异步事务与主线程同步准备共享同一准入队列。 */
export type ClientDbReadCoordinator = {
  run<T>(requestId: string, workspaceId: WorkspaceId, operation: () => Promise<T>): Promise<T>;
  synchronous<T>(operation: () => T): T;
};
