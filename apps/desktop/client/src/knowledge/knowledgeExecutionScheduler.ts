import { KnowledgeAssetError } from "./knowledgeAssetFiles.js";

export type KnowledgeExecutionState = "queued" | "running";
export type KnowledgeExecutionOptions = {
  signal: AbortSignal;
  onState?: (state: KnowledgeExecutionState) => void;
};

type QueueEntry = {
  start: () => void;
};

/** 并发预算属于本机 Client，不写入共享项目配置；默认允许 5 个知识任务同时执行。 */
export function resolveKnowledgeExecutionConcurrency(value: string | undefined): number {
  const normalized = value?.trim();
  return normalized && /^(?:[1-9]|1[0-6])$/.test(normalized) ? Number(normalized) : 5;
}

/** 生成和复检共用 FIFO 队列；只有取得额度后才调用 work 创建执行会话。 */
export class KnowledgeExecutionScheduler {
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private draining = false;

  constructor(private readonly limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
      throw new RangeError("知识任务并发数必须为 1 到 16 的整数");
    }
  }

  snapshot(): { limit: number; running: number; queued: number } {
    return { limit: this.limit, running: this.running, queued: this.queue.length };
  }

  run<T>({ signal, onState }: KnowledgeExecutionOptions, work: () => Promise<T>): Promise<T> {
    const interrupted = () => new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
    if (signal.aborted) return Promise.reject(interrupted());

    return new Promise<T>((resolve, reject) => {
      const removeQueued = (error: unknown) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(error);
        this.drain();
      };
      const abort = () => removeQueued(interrupted());
      const entry: QueueEntry = {
        start: () => {
          // 运行中的取消由 work 处理；不得在引擎尚未退出时提前归还额度。
          signal.removeEventListener("abort", abort);
          void (async () => {
            try {
              if (signal.aborted) throw interrupted();
              onState?.("running");
              if (signal.aborted) throw interrupted();
              resolve(await work());
            } catch (error) {
              reject(error);
            } finally {
              this.running--;
              this.drain();
            }
          })();
        },
      };
      this.queue.push(entry);
      signal.addEventListener("abort", abort, { once: true });
      if (this.running >= this.limit || this.queue.length > 1) {
        try { onState?.("queued"); }
        catch (error) { removeQueued(error); }
      }
      this.drain();
    });
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running < this.limit && this.queue.length > 0) {
        const entry = this.queue.shift()!;
        this.running++;
        entry.start();
      }
    } finally {
      this.draining = false;
    }
  }
}

export const knowledgeExecutionScheduler = new KnowledgeExecutionScheduler(
  resolveKnowledgeExecutionConcurrency(process.env.CODEFLOWAI_KNOWLEDGE_CONCURRENCY),
);
