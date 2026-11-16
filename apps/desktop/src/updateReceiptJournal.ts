import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { assertDesktopUpdateReceipt, digestDesktopUpdateReceipt, type DesktopUpdateReceipt, type DesktopUpdateReceiptAck } from "@codeflowai/shared/desktop-update-receipt";

type Line = { kind: "receipt"; receipt: DesktopUpdateReceipt } | { kind: "ack"; ack: DesktopUpdateReceiptAck };

/** 持久化阶段回执与精确确认；损坏日志显式失败，不跳过未知记录。 */
export function createUpdateReceiptJournal(rootDir: string) {
  const filePath = path.join(path.resolve(rootDir), "update-receipts.jsonl");
  let flushing = false;
  let unavailable: AggregateError | undefined;
  let lock: Promise<void> = Promise.resolve();
  const key = (value: Pick<DesktopUpdateReceipt, "deviceId" | "requestId" | "stage">): string => `${value.deviceId}|${value.requestId}|${value.stage}`;

  /** 串行化整个 JSONL 读写事务，避免并发查重后重复追加冲突证据。 */
  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  };

  /** 追加失败恢复原长度；回滚无法确认时禁用原日志，主次因均向上传递。 */
  const append = async (value: Line): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const file = await fs.open(filePath, "a", 0o600);
    let failure: { cause: unknown } | undefined;
    try {
      await file.chmod(0o600);
      const before = await file.stat();
      try { await file.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await file.sync(); }
      catch (error) {
        try { await restoreLength(before); }
        catch (rollback) {
          const errors = [error, rollback];
          // 同一日志留下拒读标识；磁盘拒写时保留额外根因，不宣称标识已持久化。
          try { await file.writeFile('\n{"kind":"journal-invalid"}\n', "utf8"); await file.sync(); }
          catch (marker) { errors.push(marker); }
          unavailable = new AggregateError(errors, "DESKTOP_UPDATE_RECEIPT_APPEND_ROLLBACK_FAILED");
          throw unavailable;
        }
        throw error;
      }
    }
    catch (cause) { failure = { cause }; throw cause; }
    finally {
      try { await file.close(); }
      catch (error) { if (failure) throw new AggregateError([failure.cause, error], "DESKTOP_UPDATE_RECEIPT_CLOSE_FAILED"); throw error; }
    }
  };

  /** Windows append 句柄不能截断；另开原文件并核对身份，恢复与关闭均须成功。 */
  const restoreLength = async (before: Stats): Promise<void> => {
    const file = await fs.open(filePath, "r+");
    let failure: { cause: unknown } | undefined;
    try {
      const current = await file.stat();
      if (current.dev !== before.dev || current.ino !== before.ino) throw new Error("DESKTOP_UPDATE_RECEIPT_FILE_CHANGED");
      await file.truncate(before.size);
      await file.sync();
    } catch (cause) { failure = { cause }; throw cause; }
    finally {
      try { await file.close(); }
      catch (error) { if (failure) throw new AggregateError([failure.cause, error], "DESKTOP_UPDATE_RECEIPT_ROLLBACK_CLOSE_FAILED"); throw error; }
    }
  };

  /** 严格读取所有历史记录，确认只能匹配原始回执。 */
  const readUnlocked = async (): Promise<{ records: Map<string, DesktopUpdateReceipt>; acknowledged: Set<string> }> => {
    if (unavailable) throw new Error("DESKTOP_UPDATE_RECEIPT_JOURNAL_UNAVAILABLE", { cause: unavailable });
    let text: string;
    try { text = await fs.readFile(filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: new Map(), acknowledged: new Set() }; throw error; }
    const records = new Map<string, DesktopUpdateReceipt>(); const acknowledged = new Set<string>();
    for (const [index, line] of text.split("\n").entries()) {
      if (!line && index === text.split("\n").length - 1) continue;
      try {
        const value = JSON.parse(line) as Line;
        if (value.kind === "receipt") {
          assertDesktopUpdateReceipt(value.receipt); const id = key(value.receipt); const old = records.get(id);
          if (old && digestDesktopUpdateReceipt(old) !== digestDesktopUpdateReceipt(value.receipt)) throw new Error("DESKTOP_UPDATE_RECEIPT_CONFLICT");
          records.set(id, value.receipt);
        } else if (value.kind === "ack") {
          const id = key(value.ack as DesktopUpdateReceipt); const receipt = records.get(id);
          if (!receipt || !matches(receipt, value.ack)) throw new Error("DESKTOP_UPDATE_RECEIPT_ACK_INVALID");
          acknowledged.add(id);
        } else throw new Error("DESKTOP_UPDATE_RECEIPT_JOURNAL_UNKNOWN");
      } catch (cause) { throw new Error(`DESKTOP_UPDATE_RECEIPT_JOURNAL_INVALID: line=${index + 1}`, { cause }); }
    }
    return { records, acknowledged };
  };

  return {
    /** 追加已校验回执；同一阶段同一证据幂等返回。 */
    async record(receipt: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
      return await withLock(async () => {
        assertDesktopUpdateReceipt(receipt); const state = await readUnlocked(); const id = key(receipt); const old = state.records.get(id);
        if (old) { if (digestDesktopUpdateReceipt(old) !== digestDesktopUpdateReceipt(receipt)) throw new Error("DESKTOP_UPDATE_RECEIPT_JOURNAL_CONFLICT"); return old; }
        await append({ kind: "receipt", receipt }); return receipt;
      });
    },
    /** 返回指定设备的未确认回执。 */
    async pending(deviceId: string): Promise<DesktopUpdateReceipt[]> {
      return await withLock(async () => pendingUnlocked(deviceId));
    },
    /** 读取同一设备、请求和阶段的原始回执，包含已确认记录。 */
    async find(deviceId: string, requestId: string, stage: DesktopUpdateReceipt["stage"]): Promise<DesktopUpdateReceipt | undefined> {
      return await withLock(async () => (await readUnlocked()).records.get(`${deviceId}|${requestId}|${stage}`));
    },
    /** 仅追加与原回执逐字段匹配的确认。 */
    async acknowledge(ack: DesktopUpdateReceiptAck): Promise<void> {
      await withLock(async () => acknowledgeUnlocked(ack));
    },
    /** 串行补报；确认必须匹配本次发送回执，失败时保留待报状态。 */
    async flush(deviceId: string, send: (receipt: DesktopUpdateReceipt) => Promise<DesktopUpdateReceiptAck>): Promise<void> {
      if (flushing) throw new Error("DESKTOP_UPDATE_RECEIPT_FLUSH_IN_PROGRESS"); flushing = true;
      try {
        await withLock(async () => {
          for (const receipt of await pendingUnlocked(deviceId)) {
            let ack: DesktopUpdateReceiptAck;
            try { ack = await send(receipt); }
            catch (cause) { throw wrapFlushError("DESKTOP_UPDATE_RECEIPT_SEND_FAILED", receipt.requestId, cause); }
            if (!matches(receipt, ack)) throw wrapFlushError("DESKTOP_UPDATE_RECEIPT_ACK_INVALID", receipt.requestId);
            try { await acknowledgeUnlocked(ack); }
            catch (cause) { throw wrapFlushError("DESKTOP_UPDATE_RECEIPT_ACK_FAILED", receipt.requestId, cause); }
          }
        });
      }
      finally { flushing = false; }
    },
  };

  /** 在已持有互斥锁时读取指定设备的待报回执。 */
  async function pendingUnlocked(deviceId: string): Promise<DesktopUpdateReceipt[]> {
    const state = await readUnlocked();
    return [...state.records.entries()].filter(([id]) => id.startsWith(`${deviceId}|`))
      .filter(([id]) => !state.acknowledged.has(id)).map(([, value]) => value);
  }

  /** 在已持有互斥锁时追加精确确认。 */
  async function acknowledgeUnlocked(ack: DesktopUpdateReceiptAck): Promise<void> {
    const state = await readUnlocked(); const id = key(ack as DesktopUpdateReceipt); const receipt = state.records.get(id);
    if (!receipt || !matches(receipt, ack)) throw new Error("DESKTOP_UPDATE_RECEIPT_ACK_INVALID");
    if (state.acknowledged.has(id)) return;
    await append({ kind: "ack", ack });
  }
}

/** 为每个失败阶段绑定实际回执 requestId，同时保留底层诊断原因。 */
function wrapFlushError(code: string, requestId: string, cause?: unknown): Error & { code: string; requestId: string } {
  const message = cause instanceof Error ? cause.message : code;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, requestId });
}

/** 比对确认与原始回执的全部稳定字段。 */
function matches(receipt: DesktopUpdateReceipt, ack: DesktopUpdateReceiptAck): boolean {
  return Object.keys(ack).length === 7 && ack.deviceId === receipt.deviceId && ack.requestId === receipt.requestId
    && ack.releaseId === receipt.releaseId && ack.archiveSha256 === receipt.archiveSha256 && ack.stage === receipt.stage
    && ack.at === receipt.at && ack.payloadSha256 === receipt.payloadSha256;
}
