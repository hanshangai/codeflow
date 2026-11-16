import { defineStore } from "pinia";
import type { QuickPhrase, QuickPhraseCollection } from "@codeflowai/shared";
import { createQuickPhrase, deleteQuickPhrase, listQuickPhrases, reorderQuickPhrases, updateQuickPhrase, type QuickPhraseRequestContext } from "../api/quickPhrases";
import type { ApiRequestContext } from "../api/request";
import { createBrowserUuid } from "../utils/browserUuid";

type CacheValue = QuickPhraseCollection & { cachedAt: number; schemaVersion: 1 };
type State = { scopeKey: string; scopeEpoch: number; items: QuickPhrase[]; revision: number; requestEpoch: number; loading: boolean; refreshing: boolean; error: string | null };

/** 账号常用提示词的集合范围键，统一 origin 与 userId 的规范化。 */
export function quickPhraseAccountScope(serverOrigin: string, userId: string): string {
  const origin = String(serverOrigin).trim().replace(/\/+$/u, "");
  const owner = String(userId).trim();
  return origin && owner ? `${origin}::${owner}` : "";
}

/** Server 已确认的集合不能因缓存失败被误判为业务未保存。 */
export class QuickPhraseCacheWriteError extends Error {
  readonly code = "QUICK_PHRASES_CACHE_WRITE_FAILED";
  /** 保留缓存根因，同时告知展示边界关闭已完成的写操作。 */
  constructor(cause: unknown) { super("账号常用提示词已由 Server 确认，当前页面已更新；本地缓存写入失败，请勿重复提交", { cause }); }
}

export const useQuickPhrasesStore = defineStore("quickPhrases", {
  state: (): State => ({ scopeKey: "", scopeEpoch: 0, items: [], revision: 0, requestEpoch: 0, loading: false, refreshing: false, error: null }),
  actions: {
    /** 本机直接读应用库；账号缓存按 Server 和用户隔离。 */
    async initialize(ctx: QuickPhraseRequestContext, serverOrigin: string, userId: string): Promise<void> {
      const scope = ctx.scope === "local" ? "local" : quickPhraseAccountScope(serverOrigin, userId);
      if (ctx.scope !== "local" && !scope) {
        this.invalidateScope();
        this.error = "账号信息未就绪，无法加载常用提示词";
        throw new Error(this.error);
      }
      if (scope !== this.scopeKey) {
        this.invalidateScope();
        this.scopeKey = scope;
        this.loading = true;
        if (scope !== "local") {
          const epoch = this.requestEpoch;
          try {
            const cached = await readCache(scope);
            if (this.scopeKey !== scope || this.requestEpoch !== epoch) return;
            if (cached) this.apply(cached);
          } catch (error) {
            if (this.scopeKey === scope && this.requestEpoch === epoch) { this.error = errorMessage(error); this.loading = false; }
            throw error;
          }
        }
      }
      await this.refresh(ctx, scope);
    },
    /** Refreshes one scope and rejects failures instead of showing an empty list. */
    async refresh(ctx: QuickPhraseRequestContext, expectedScope?: string): Promise<void> {
      const scope = expectedScope ?? this.scopeKey;
      this.requireScope(ctx, scope);
      const epoch = ++this.requestEpoch;
      this.refreshing = true;
      this.error = null;
      try {
        const result = await listQuickPhrases(ctx);
        if (this.scopeKey !== scope || this.requestEpoch !== epoch || result.revision < this.revision) return;
        this.apply(result);
        await this.persist();
      } catch (error) {
        if (this.scopeKey === scope && this.requestEpoch === epoch) this.error = errorMessage(error);
        throw error;
      } finally {
        if (this.scopeKey === scope && this.requestEpoch === epoch) { this.loading = false; this.refreshing = false; }
      }
    },
    /** 只有所选范围权威写入成功后才替换内存集合。 */
    async create(ctx: QuickPhraseRequestContext, title: string, content: string): Promise<void> {
      this.requireScope(ctx);
      const scope = this.scopeKey;
      const epoch = this.scopeEpoch;
      await this.commit(await createQuickPhrase(ctx, { clientRequestId: createBrowserUuid(), title, content }), scope, epoch);
    },
    /** Updates one phrase with its current optimistic-lock version. */
    async update(ctx: QuickPhraseRequestContext, phrase: QuickPhrase, title: string, content: string): Promise<void> {
      this.requireScope(ctx);
      const scope = this.scopeKey;
      const epoch = this.scopeEpoch;
      await this.commit(await updateQuickPhrase(ctx, phrase.id, { title, content, version: phrase.version }), scope, epoch);
    },
    /** Deletes one phrase with its current optimistic-lock version. */
    async remove(ctx: QuickPhraseRequestContext, phrase: QuickPhrase): Promise<void> {
      this.requireScope(ctx);
      const scope = this.scopeKey;
      const epoch = this.scopeEpoch;
      await this.commit(await deleteQuickPhrase(ctx, phrase.id, { version: phrase.version }), scope, epoch);
    },
    /** Persists a complete reordered ID list. */
    async reorder(ctx: QuickPhraseRequestContext, ids: string[]): Promise<void> {
      this.requireScope(ctx);
      const scope = this.scopeKey;
      const epoch = this.scopeEpoch;
      await this.commit(await reorderQuickPhrases(ctx, { revision: this.revision, ids }), scope, epoch);
    },
    /** Refreshes only when another session reports a newer revision. */
    async handleRemoteRevision(ctx: ApiRequestContext, revision: number): Promise<void> {
      if (this.scopeKey && this.scopeKey !== "local" && revision > this.revision) await this.refresh(ctx);
    },
    /** 账号退出只清内存；隔离缓存保留，本机范围不受登录影响。 */
    resetRuntimeState(): void {
      if (this.scopeKey === "local") return;
      this.invalidateScope();
    },
    /** 单调请求代数避免切走再切回时接纳旧请求。 */
    invalidateScope(): void {
      const epoch = this.requestEpoch + 1;
      const scopeEpoch = this.scopeEpoch + 1;
      this.$reset();
      this.requestEpoch = epoch;
      this.scopeEpoch = scopeEpoch;
    },
    /** 操作上下文必须与已加载范围一致，防止正文串写。 */
    requireScope(ctx: QuickPhraseRequestContext, expectedScope?: string): void {
      const scope = expectedScope ?? this.scopeKey;
      const origin = String(ctx.serverWsOrigin).trim().replace(/\/+$/u, "");
      if (!scope || this.scopeKey !== scope || (ctx.scope === "local") !== (scope === "local")
        || (scope !== "local" && (!origin || !scope.startsWith(`${origin}::`)))) throw new Error("常用提示词范围已变化，请重新加载");
    },
    /** 应用权威集合快照。 */
    apply(value: QuickPhraseCollection): void { this.revision = value.revision; this.items = value.items; },
    /** 只接受当前范围的写入结果，过期修订不能回退集合。 */
    async commit(value: QuickPhraseCollection, expectedScope: string, expectedEpoch: number): Promise<void> {
      if (!expectedScope || this.scopeKey !== expectedScope || this.scopeEpoch !== expectedEpoch) throw new Error("常用提示词范围已切换，已忽略旧请求结果");
      this.requestEpoch += 1;
      this.loading = false;
      this.refreshing = false;
      this.error = null;
      if (value.revision < this.revision) return;
      this.apply(value);
      await this.persist();
    },
    /** 本机已由 SQLite 持久化，账号缓存写失败必须显式失败。 */
    async persist(): Promise<void> {
      if (!this.scopeKey || this.scopeKey === "local") return;
      const items = this.items.map((item) => ({ ...item }));
      try { await writeCache(this.scopeKey, { revision: this.revision, items, cachedAt: Date.now(), schemaVersion: 1 }); }
      catch (error) { throw new QuickPhraseCacheWriteError(error); }
    },
  },
});

const DB_NAME = "codeflowai-quick-phrases-v1";
const STORE_NAME = "quick-phrases";
/** Opens the small account cache without adding a third-party dependency. */
function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}
async function readCache(key: string): Promise<CacheValue | null> {
  const db = await openCache();
  return await new Promise((resolve, reject) => { const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key); req.onsuccess = () => resolve((req.result as CacheValue | undefined) ?? null); req.onerror = () => reject(req.error); });
}
async function writeCache(key: string, value: CacheValue): Promise<void> {
  const db = await openCache();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
