import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertUpdateFailureRecord, assertDesktopUpdateFailureRecord, digestUpdateFailureRecord, matchesUpdateFailureAck, toUpdateDiagnosticCause, toShellUpdateDiagnosticCause,
  type UpdateFailureContext, type UpdateFailureRecord, type ShellUpdateFailureRecord, type DesktopUpdateFailureRecord, type UpdateFailureAck } from "@codeflowai/shared/desktop-update-failure";
export type { UpdateFailureContext, UpdateFailureRecord, ShellUpdateFailureRecord, DesktopUpdateFailureRecord, UpdateFailureAck } from "@codeflowai/shared/desktop-update-failure";
type Recovery = UpdateFailureRecord["recovery"];

/** 设备记录与业务正文分离；同一文件追加失败及确认，不另存一份待报正文。 */
export function createUpdateFailureJournal(rootDir: string) {
  const filePath = path.join(path.resolve(rootDir), "errors.jsonl");
  let flushing = false;
  let unusable: Error | null = null;

  /** 只管理同步日志操作；始终尝试关闭，关闭失败时保留此前抛出的任意值。 */
  const withJournalFile = (flags: "a" | "r+", operation: (fd: number) => void): void => {
    const fd = fs.openSync(filePath, flags, 0o600);
    let failure: { cause: unknown } | undefined;
    try {
      operation(fd);
    } catch (cause) {
      failure = { cause };
      throw cause;
    } finally {
      try { fs.closeSync(fd); }
      catch (error) {
        if (failure) throw new AggregateError([failure.cause, error], "DESKTOP_UPDATE_JOURNAL_CLOSE_FAILED");
        throw error;
      }
    }
  };

  /** 回滚无法确认文件边界时写入不可用标记，阻止重启后把残留 ACK 当作确认。 */
  const markUnusable = (): void => {
    withJournalFile("a", fd => {
      fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, kind: "journal-invalid" })}\n`, "utf8");
      fs.fsyncSync(fd);
    });
  };

  /** 不可用时拒写；追加同步失败恢复原长度，回滚失败保留双因，不能伪造确认。 */
  const append = (value: unknown): void => {
    if (unusable) throw new Error("DESKTOP_UPDATE_JOURNAL_UNAVAILABLE", { cause: unusable });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    withJournalFile("a", fd => {
      const beforeSize = fs.fstatSync(fd).size;
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
        fs.fsyncSync(fd);
      } catch (error) {
        try {
          fs.truncateSync(filePath, beforeSize);
          withJournalFile("r+", rollbackFd => { fs.fsyncSync(rollbackFd); });
        } catch (rollbackError) {
          const failure = new AggregateError([error, rollbackError], "DESKTOP_UPDATE_JOURNAL_APPEND_ROLLBACK_FAILED");
          unusable = failure;
          try { markUnusable(); }
          catch (markerError) { unusable = Object.assign(failure, { cause: markerError }); }
          throw unusable;
        }
        throw error;
      }
    });
  };

  /** 逐条验证证据和确认；损坏或未知记录显式失败，不跳过后继续上传。 */
  const readRecords = (): { failures: DesktopUpdateFailureRecord[]; pending: DesktopUpdateFailureRecord[] } => {
    if (unusable) throw new Error("DESKTOP_UPDATE_JOURNAL_UNAVAILABLE", { cause: unusable });
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return { failures: [], pending: [] };
      throw error;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const pending = new Map<string, DesktopUpdateFailureRecord>();
    const failures = new Map<string, DesktopUpdateFailureRecord>();
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line && index === lines.length - 1) continue;
      try {
        const value = JSON.parse(line) as DesktopUpdateFailureRecord | (UpdateFailureAck & { kind: "ack"; schemaVersion: 1 });
        if (value.schemaVersion !== 1 || typeof value.errorId !== "string" || typeof value.deviceId !== "string") throw new Error("invalid identity");
        if (value.kind === "failure") {
          assertDesktopUpdateFailureRecord(value);
          if (failures.has(value.errorId)) throw new Error("duplicate failure identity");
          failures.set(value.errorId, value);
          pending.set(value.errorId, value);
        } else if (value.kind === "ack") {
          if (Object.keys(value).length !== 5 || Object.keys(value).some(key => !["schemaVersion", "kind", "errorId", "deviceId", "payloadSha256"].includes(key))) throw new Error("invalid acknowledgement shape");
          const failure = failures.get(value.errorId);
          if (!failure || !matchesUpdateFailureAck(failure, value)) throw new Error("invalid acknowledgement");
          pending.delete(value.errorId);
        } else throw new Error("unknown record kind");
      } catch (cause) {
        throw Object.assign(new Error(`DESKTOP_UPDATE_JOURNAL_INVALID: line=${index + 1}`, { cause }), { code: "DESKTOP_UPDATE_JOURNAL_INVALID" });
      }
    }
    return { failures: [...failures.values()], pending: [...pending.values()] };
  };

  return {
    /** 只接受更新上下文；恢复结果与错误在一条证据中固定，不被上传结果覆盖。 */
    record(input: UpdateFailureContext & { requestId: string; releaseId: string; phase: string; recovery: Recovery; error: unknown; rollbackError?: unknown }): UpdateFailureRecord {
      const { error, rollbackError } = input;
      const payload = { deviceId: input.deviceId, shellVersion: input.shellVersion, currentReleaseId: input.currentReleaseId,
        webVersion: input.webVersion, clientVersion: input.clientVersion, requestId: input.requestId,
        releaseId: input.releaseId, phase: input.phase, recovery: input.recovery,
        schemaVersion: 1 as const, kind: "failure" as const, errorId: crypto.randomUUID(),
        at: new Date().toISOString(), errorCode: "DESKTOP_RELEASE_FAILED" as const,
        rootCause: toUpdateDiagnosticCause(error), rollbackError: rollbackError == null ? null : toUpdateDiagnosticCause(rollbackError) };
      const record = { ...payload, payloadSha256: digestUpdateFailureRecord(payload) };
      assertUpdateFailureRecord(record);
      append(record);
      return record;
    },
    /** 壳失败沿同一耐久日志保存；尚未发现目标时允许 shellId 为空。 */
    recordShell(input: UpdateFailureContext & { requestId: string; shellId: string | null; phase: ShellUpdateFailureRecord["phase"]; recovery: Recovery; error: unknown; rollbackError?: unknown }): ShellUpdateFailureRecord {
      const { error, rollbackError } = input;
      const payload = { deviceId: input.deviceId, shellVersion: input.shellVersion, currentReleaseId: input.currentReleaseId,
        webVersion: input.webVersion, clientVersion: input.clientVersion, requestId: input.requestId,
        shellId: input.shellId, phase: input.phase, recovery: input.recovery,
        schemaVersion: 1 as const, kind: "failure" as const, errorId: crypto.randomUUID(),
        at: new Date().toISOString(), errorCode: "DESKTOP_SHELL_UPDATE_FAILED" as const,
        rootCause: toShellUpdateDiagnosticCause(error), rollbackError: rollbackError == null ? null : toShellUpdateDiagnosticCause(rollbackError) };
      const record = { ...payload, payloadSha256: digestUpdateFailureRecord(payload) };
      assertDesktopUpdateFailureRecord(record);
      append(record);
      return record;
    },
    /** 重装后的新身份只取自己的待报记录，旧身份的证据继续保留原归属。 */
    pending(deviceId: string): DesktopUpdateFailureRecord[] {
      return readRecords().pending.filter(record => record.deviceId === deviceId);
    },
    /** 沿原严格日志读取当前设备历史及精确 ACK 状态，返回隔离的脱敏快照。 */
    diagnostics(deviceId: string): Array<{ record: DesktopUpdateFailureRecord; reported: boolean }> {
      const { failures, pending } = readRecords();
      const pendingIds = new Set(pending.map(record => record.errorId));
      return failures.filter(record => record.deviceId === deviceId).map(record => ({
        record: structuredClone(record), reported: !pendingIds.has(record.errorId),
      }));
    },
    /** 人工新周期读取原耐久证据；精确 ACK 不删除历史，也不混入绑定包或其他设备。 */
    shellFailures(deviceId: string, requestId: string): ShellUpdateFailureRecord[] {
      return readRecords().failures.filter((record): record is ShellUpdateFailureRecord =>
        record.errorCode === "DESKTOP_SHELL_UPDATE_FAILED" && record.deviceId === deviceId && record.requestId === requestId);
    },
    /** 串行补报并精确确认；任一发送或确认失败立即终止，保留其余待报记录。 */
    async flush(deviceId: string, send: (record: DesktopUpdateFailureRecord) => Promise<UpdateFailureAck>): Promise<void> {
      if (flushing) throw new Error("DESKTOP_UPDATE_DELIVERY_IN_PROGRESS");
      flushing = true;
      try {
        for (const record of this.pending(deviceId)) {
          const ack = await send(record);
          if (!matchesUpdateFailureAck(record, ack)) throw new Error(`DESKTOP_UPDATE_ACK_MISMATCH: requestId=${record.requestId}; errorId=${record.errorId}`);
          append({ schemaVersion: 1, kind: "ack", errorId: record.errorId, deviceId: record.deviceId, payloadSha256: record.payloadSha256 });
        }
      } finally {
        flushing = false;
      }
    },
  };
}
