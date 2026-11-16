import type { ThreadId, TurnId } from "@codeflowai/shared";

/** send 幂等 LRU 默认 TTL：30 秒。短于一次正常请求的端到端窗口（含网络重试），但远大于 sending 锁释放时间。 */
const DEFAULT_TTL_MS = 30_000;
/** 单 thread 最多记 100 个 clientItemId；按 enqueue 顺序 LRU 淘汰，避免内存无限增长。 */
const MAX_KEYS_PER_THREAD = 100;

type Entry = {
  turnId: TurnId;
  expireAt: number;
};

/**
 * Send 路径的幂等缓存：thread × clientItemId → turnId。
 *
 * - 仅内存：Client 重启后丢失，但重启同时 turn 也丢了，重新发送是合理行为
 * - 仅 send / 即时下发路径使用；queue append 走 DB 唯一索引（持久化跨重启）
 * - 调用者：onThreadsSendMessage 在创建 turnId 之前 lookup；命中则直接返回原 turnId
 */
export class SendIdempotencyCache {
  private readonly byThread = new Map<string, Map<string, Entry>>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** 命中返回原 turnId（若未过期）；未命中返回 null。 */
  lookup(threadId: ThreadId, clientItemId: string): TurnId | null {
    const tid = String(threadId);
    const cid = String(clientItemId).trim();
    if (!cid) return null;
    const slot = this.byThread.get(tid);
    if (!slot) return null;
    const entry = slot.get(cid);
    if (!entry) return null;
    if (entry.expireAt <= Date.now()) {
      slot.delete(cid);
      if (slot.size === 0) this.byThread.delete(tid);
      return null;
    }
    return entry.turnId;
  }

  /** 记录一次成功的 send；同 clientItemId 在 TTL 内的后续请求都会命中。 */
  remember(threadId: ThreadId, clientItemId: string, turnId: TurnId): void {
    const tid = String(threadId);
    const cid = String(clientItemId).trim();
    if (!cid) return;
    const slot = this.byThread.get(tid) ?? new Map<string, Entry>();
    slot.set(cid, { turnId, expireAt: Date.now() + this.ttlMs });
    // LRU 淘汰：插入位置已是最新，删除最早的项即可
    if (slot.size > MAX_KEYS_PER_THREAD) {
      const oldestKey = slot.keys().next().value;
      if (oldestKey !== undefined) slot.delete(oldestKey);
    }
    this.byThread.set(tid, slot);
  }

  /** 测试用：清空缓存。 */
  clear(): void {
    this.byThread.clear();
  }
}
