import crypto from "node:crypto";

import {
  ROLLBACK_EVIDENCE_FENCE_SOURCE,
  type EngineType,
  type RawEngineEventEnvelope,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientToServerMessage } from "../protocol/messages.js";

type FenceSendResult = {
  accepted: boolean;
  reason?: string | null;
};

type PendingFence = {
  resolve: (seq: number) => void;
  reject: (cause: Error) => void;
  timeout: NodeJS.Timeout;
};

export type RollbackEvidenceFence = {
  request(input: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType }): Promise<number>;
  acceptAck(event: RawEngineEventEnvelope): boolean;
  rejectAck(event: RawEngineEventEnvelope, cause: unknown): boolean;
  rejectAll(cause: unknown): void;
};

/** 用现有 raw event ACK 建立 Client 到 Server 的顺序栅栏。 */
export function createRollbackEvidenceFence(input: {
  send: (message: ClientToServerMessage) => FenceSendResult;
  timeoutMs?: number;
}): RollbackEvidenceFence {
  const timeoutMs = Math.max(1_000, Number(input.timeoutMs ?? 10_000));
  const pending = new Map<string, PendingFence>();

  /** 发送 fence，并等待 Server 为此前全部上行消息分配完 seq。 */
  const request: RollbackEvidenceFence["request"] = (scope) => {
    const fenceId = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(fenceId);
        reject(new Error(`回滚事件栅栏等待超时：threadId=${scope.threadId}, fenceId=${fenceId}`));
      }, timeoutMs);
      timeout.unref?.();
      pending.set(fenceId, { resolve, reject, timeout });

      try {
        const result = input.send({
          t: "raw.event",
          event: {
            ts: Date.now(),
            workspaceId: scope.workspaceId,
            threadId: scope.threadId,
            engine: scope.engine,
            source: ROLLBACK_EVIDENCE_FENCE_SOURCE,
            data: { fenceId },
            handled: true,
            action: "mapped",
            emittedTypes: [],
          },
        });
        if (!result.accepted) {
          settleRejected(fenceId, new Error(`回滚事件栅栏发送失败：${String(result.reason ?? "transport rejected")}`));
        }
      } catch (cause) {
        settleRejected(fenceId, toError(cause, "回滚事件栅栏发送失败"));
      }
    });
  };

  /** 接受匹配 fence 的持久化 ACK，并返回其 Server seq。 */
  const acceptAck: RollbackEvidenceFence["acceptAck"] = (event) => {
    const fenceId = readFenceId(event);
    if (!fenceId) return false;
    const entry = pending.get(fenceId);
    if (!entry) return false;
    const seq = Number(event.seq ?? 0);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      settleRejected(fenceId, new Error(`回滚事件栅栏 ACK seq 无效：${String(event.seq)}`));
      return true;
    }
    pending.delete(fenceId);
    clearTimeout(entry.timeout);
    entry.resolve(seq);
    return true;
  };

  /** ACK 落库失败时拒绝对应 fence，禁止回滚继续提交。 */
  const rejectAck: RollbackEvidenceFence["rejectAck"] = (event, cause) => {
    const fenceId = readFenceId(event);
    if (!fenceId || !pending.has(fenceId)) return false;
    settleRejected(fenceId, toError(cause, "回滚事件栅栏 ACK 落库失败"));
    return true;
  };

  /** 连接关闭或 Client 退出时拒绝全部等待项。 */
  const rejectAll: RollbackEvidenceFence["rejectAll"] = (cause) => {
    const failure = toError(cause, "回滚事件栅栏连接已关闭");
    for (const fenceId of [...pending.keys()]) settleRejected(fenceId, failure);
  };

  /** 清理并拒绝单个等待项。 */
  function settleRejected(fenceId: string, cause: Error): void {
    const entry = pending.get(fenceId);
    if (!entry) return;
    pending.delete(fenceId);
    clearTimeout(entry.timeout);
    entry.reject(cause);
  }

  return { request, acceptAck, rejectAck, rejectAll };
}

/** 自动回滚后等待新事件越过 Server 顺序栅栏并严格落库；fence seq 不参与回滚屏障。 */
export async function waitForPostReconcileEventDurability(input: {
  rollbackReconciled: boolean;
  scope: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType };
  fence?: (scope: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType }) => Promise<number>;
  flush?: () => void | Promise<void>;
}): Promise<void> {
  if (!input.rollbackReconciled) return;
  if (!input.fence || !input.flush) {
    throw new Error(`自动回滚后事件持久化能力未初始化：threadId=${input.scope.threadId}`);
  }
  await input.fence(input.scope);
  await input.flush();
}

/** 只识别本组件生成的 raw fence ACK。 */
function readFenceId(event: RawEngineEventEnvelope): string | null {
  if (String(event.source ?? "") !== ROLLBACK_EVIDENCE_FENCE_SOURCE) return null;
  const fenceId = String((event.data as any)?.fenceId ?? "").trim();
  return fenceId || null;
}

/** 将未知异常规整为可追踪 Error。 */
function toError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) return cause;
  const message = String(cause ?? "").trim();
  return new Error(message || fallback, { cause });
}
