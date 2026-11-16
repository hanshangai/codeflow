import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import { openClientDb, type ClientDb } from "./clientDb.js";
import { createLocalEventPersistence } from "../runtime/localEventPersistence.js";
import { createLocalEventDatabaseIndex } from "../runtime/localEventIndex.js";
import { isDesktopLocalThreadAssetExecution } from "../orchestration/orchAssetAuthorityRuntimeReadService.js";
import type { ThreadId } from "@codeflowai/shared";
import { sanitizeClientDbReaderRootCauseMessage } from "./clientDbReaderProtocol.js";
import { CLIENT_DB_WRITER_PROTOCOL_VERSION, type ClientDbWriterCommand, type ClientDbWriterFailure,
  type ClientDbWriterMessage, type ClientDbWriterWorkerData } from "./clientDbWriterProtocol.js";

if (!parentPort) throw new Error("CLIENT_DB_WRITER_PARENT_REQUIRED");
const port = parentPort;
let db: ClientDb | null = null;
let persistence: ReturnType<typeof createLocalEventPersistence> | null = null;
let closed = false;
let verifyApplicationIdentity: (() => void) | null = null;
const applyDatabaseIndex = createLocalEventDatabaseIndex();

/** 仅传固定错误码和安全身份；正文及数据库路径不跨失败协议传播。 */
function failure(cause: unknown, command?: ClientDbWriterCommand): ClientDbWriterFailure {
  const raw = cause instanceof Error ? cause.message : "";
  const code = /^[A-Z][A-Z0-9_]{0,95}$/u.test(raw) ? raw : "CLIENT_DB_WRITER_OPERATION_FAILED";
  return { code, message: code, requestId: command?.commandId,
    rootCause: { name: cause instanceof Error ? cause.name : "NonError", message: sanitizeClientDbReaderRootCauseMessage(raw) },
    ...(command && "workspaceId" in command ? { workspaceId: command.workspaceId } : {}),
    ...(command?.type === "commit" ? { workspaceId: command.batch.workspaceId, batchId: command.batch.batchId } : {}) };
}

/** Worker ACK 发送失败属于原线程致命故障，不能当作提交失败重写正文。 */
function post(message: ClientDbWriterMessage): void { port.postMessage(message); }

/** 每帧只执行一个有界同步段；连接之间不嵌套网络或主线程回调。 */
function handleCommand(command: ClientDbWriterCommand): void {
  if (closed) return;
  try {
    if (!command || typeof command.commandId !== "string" || !command.commandId || !db || !persistence) throw new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID");
    if (command.type !== "close") verifyApplicationIdentity?.();
    if (command.type === "commit") {
      const receipt = persistence.commitBatch(command.batch);
      post({ type: "result", commandId: command.commandId, receipt });
    } else if (command.type === "indexDatabase") {
      const scoped = db.forWorkspace(command.workspaceId);
      const localThreadIds = scoped.withWorkspaceCoreRepos(command.workspaceId, () => {
        const messages = persistence!.indexDatabase(command.workspaceId, command.batchId, applyDatabaseIndex);
        const clientId = (workerData as ClientDbWriterWorkerData).clientId;
        if (!clientId) return undefined;
        const workspace = scoped.workspaces.get(command.workspaceId);
        if (!workspace) throw new Error("CLIENT_DB_WRITER_WORKSPACE_MISSING");
        const workspaces = new Map([[command.workspaceId, workspace.path]]);
        return [...new Set(messages.map(message => message.event.threadId as ThreadId))]
          .filter(threadId => isDesktopLocalThreadAssetExecution(clientId, workspaces, scoped, threadId));
      });
      post({ type: "result", commandId: command.commandId, localThreadIds });
    } else if (command.type === "indexed") {
      const readyThroughSeq = persistence.completeBatchIndexes(command.workspaceId, command.batchId, command.indexedCount);
      post({ type: "result", commandId: command.commandId, readyThroughSeq });
    } else if (command.type === "confirmed") {
      persistence.confirmBatch(command.workspaceId, command.batchId);
      post({ type: "result", commandId: command.commandId });
    } else if (command.type === "readySeq") {
      post({ type: "result", commandId: command.commandId, readyThroughSeq: persistence.readReadyThroughSeq(command.workspaceId) });
    } else if (command.type === "drainWorkspace" || command.type === "invalidate") {
      db.closeWorkspaceConnections(command.type === "drainWorkspace" ? command.workspaceId : undefined);
      post({ type: "result", commandId: command.commandId });
    } else if (command.type === "close") {
      db.close(); db = null; closed = true;
      post({ type: "closed", commandId: command.commandId }); port.close();
    } else throw new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID");
  } catch (cause) { post({ type: "failed", commandId: command.commandId, error: failure(cause, command) }); }
}

/** 打开唯一 A owner，W 连接受原物理身份/schema/scope 检查保护。 */
function start(): void {
  try {
    const input = workerData as ClientDbWriterWorkerData;
    if (!input || typeof input.dbPath !== "string") throw new Error("CLIENT_DB_WRITER_CONFIG_INVALID");
    const identity = fs.lstatSync(input.dbPath, { bigint: true });
    verifyApplicationIdentity = () => {
      const current = fs.lstatSync(input.dbPath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("CLIENT_DB_WRITER_APPLICATION_REPLACED");
    };
    db = openClientDb({ dbPath: input.dbPath, existingOnly: true, localCanonicalEvents: true,
      workspaceConnectionCache: { maxEntries: input.maxWorkspaceConnections, idleMs: input.workspaceIdleMs,
        onError(cause, workspaceId) { post({ type: "fatal", error: { ...failure(cause), workspaceId } }); } } });
    verifyApplicationIdentity();
    persistence = createLocalEventPersistence({ db, writerEpoch: input.writerEpoch,
      applyConversation() { throw new Error("CLIENT_DB_WRITER_INDEX_OWNER_REQUIRED"); },
      applyRaw() { throw new Error("CLIENT_DB_WRITER_INDEX_OWNER_REQUIRED"); } });
    port.on("message", handleCommand);
    port.on("messageerror", cause => { post({ type: "fatal", error: failure(cause) }); });
    post({ type: "ready", protocolVersion: CLIENT_DB_WRITER_PROTOCOL_VERSION });
  } catch (cause) {
    let error = cause;
    try { db?.close(); } catch (closeError) { error = new AggregateError([cause, closeError], "CLIENT_DB_WRITER_INIT_CLEANUP_FAILED", { cause }); }
    post({ type: "fatal", error: failure(error) }); port.close();
  }
}
start();
