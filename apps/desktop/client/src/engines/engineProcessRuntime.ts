import type { ManagedServiceSnapshot, ThreadId } from "@codeflowai/shared";

type EngineProcessBucket = Map<string, ManagedServiceSnapshot>;

/**
 * 当前聊天窗口里的“引擎原生后台进程”运行时。
 *
 * 说明：
 * - 这里只维护 Client 进程还掌握着的实时状态，不负责跨 Client 重启恢复。
 * - serviceId 由适配层保证在同一 thread 内唯一。
 */
export class EngineProcessRuntime {
  private readonly itemsByThread = new Map<ThreadId, EngineProcessBucket>();

  upsertThreadService(threadId: ThreadId, snapshot: ManagedServiceSnapshot): boolean {
    const normalized = normalizeEngineProcessSnapshot(snapshot);
    const bucket = this.getOrCreateBucket(threadId);
    const previous = bucket.get(normalized.serviceId) ?? null;
    if (previous && isSameManagedServiceSnapshot(previous, normalized)) return false;
    bucket.set(normalized.serviceId, normalized);
    return true;
  }

  listThreadServices(threadId: ThreadId): ManagedServiceSnapshot[] {
    const bucket = this.itemsByThread.get(threadId);
    if (!bucket?.size) return [];
    return [...bucket.values()]
      .map(cloneManagedServiceSnapshot)
      .sort(compareManagedServiceSnapshot);
  }

  clearThread(threadId: ThreadId): void {
    this.itemsByThread.delete(threadId);
  }

  private getOrCreateBucket(threadId: ThreadId): EngineProcessBucket {
    let bucket = this.itemsByThread.get(threadId);
    if (!bucket) {
      bucket = new Map();
      this.itemsByThread.set(threadId, bucket);
    }
    return bucket;
  }
}

function normalizeEngineProcessSnapshot(snapshot: ManagedServiceSnapshot): ManagedServiceSnapshot {
  return {
    ...snapshot,
    source: "engine",
    displayName: String(snapshot.displayName ?? "").trim() || null,
    stopSupported: snapshot.stopSupported === true,
    args: [...(snapshot.args ?? [])],
    startupTimeoutMs: Number(snapshot.startupTimeoutMs ?? 0) || 0,
    readySummary: snapshot.readySummary ?? null,
    readyAt: snapshot.readyAt ?? null,
    exitedAt: snapshot.exitedAt ?? null,
    exitCode: snapshot.exitCode ?? null,
    exitSignal: snapshot.exitSignal ?? null,
  };
}

function cloneManagedServiceSnapshot(snapshot: ManagedServiceSnapshot): ManagedServiceSnapshot {
  return {
    ...snapshot,
    args: [...(snapshot.args ?? [])],
  };
}

function compareManagedServiceSnapshot(left: ManagedServiceSnapshot, right: ManagedServiceSnapshot): number {
  const leftTs = left.startedAt ?? 0;
  const rightTs = right.startedAt ?? 0;
  if (rightTs !== leftTs) return rightTs - leftTs;
  return String(left.serviceId).localeCompare(String(right.serviceId));
}

function isSameManagedServiceSnapshot(left: ManagedServiceSnapshot, right: ManagedServiceSnapshot): boolean {
  return (
    left.serviceId === right.serviceId
    && String(left.displayName ?? "") === String(right.displayName ?? "")
    && left.source === right.source
    && left.stopSupported === right.stopSupported
    && left.status === right.status
    && left.pid === right.pid
    && left.command === right.command
    && left.workingDirectory === right.workingDirectory
    && left.startupTimeoutMs === right.startupTimeoutMs
    && left.readySummary === right.readySummary
    && left.startedAt === right.startedAt
    && left.readyAt === right.readyAt
    && left.exitedAt === right.exitedAt
    && left.exitCode === right.exitCode
    && left.exitSignal === right.exitSignal
    && sameStringArray(left.args, right.args)
  );
}

function sameStringArray(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    if (leftItems[index] !== rightItems[index]) return false;
  }
  return true;
}
