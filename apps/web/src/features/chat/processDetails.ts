import { reactive } from "vue";
import type { ConversationItem, ThreadProcessDetails } from "@codeflowai/shared";

export type ProcessDetailsPageRequest = { afterSeq?: number; cursor?: string; throughSeq?: number };

/** 只在展开期间按固定版本分页读取；条目为完整快照，按 ID 替换。 */
export function createProcessDetailsLoader(read: (body: ProcessDetailsPageRequest, signal: AbortSignal) => Promise<ThreadProcessDetails>) {
  const state = reactive({ items: [] as ConversationItem[], version: 0, hasMore: false, loading: false, error: null as string | null });
  let open = false;
  let targetVersion = 0;
  let generation = 0;
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let olderPage: ProcessDetailsPageRequest | null = null;
  let changedPage: ProcessDetailsPageRequest | null = null;

  /** 合并完整条目并按最新成员顺序排序；旧页不能覆盖已更新的缓存。 */
  function mergePage(page: ThreadProcessDetails, older: boolean): void {
    const byId = new Map(state.items.map(item => [String(item.id), item]));
    for (const item of page.items) if (!older || !byId.has(String(item.id))) byId.set(String(item.id), item);
    state.items = page.itemOrder ? page.itemOrder.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : [...byId.values()];
  }

  /** 单个请求串行读取；初次展开和加载更多均只读取一页。 */
  async function run(loadOlder: boolean): Promise<void> {
    if (!open) return;
    if (pending) return pending;
    if (!loadOlder && state.version >= targetVersion && !changedPage) return;
    const token = generation;
    const abort = new AbortController();
    controller = abort;
    state.loading = true;
    state.error = null;
    pending = (async () => {
      try {
        do {
          const older = loadOlder && !changedPage && Boolean(olderPage);
          const initial = state.version === 0;
          const request = older ? olderPage! : changedPage ?? { ...(state.version ? { afterSeq: state.version } : {}), throughSeq: targetVersion };
          const page = await read(request, abort.signal);
          if (!open || token !== generation) return;
          if (page.hasMore && (!page.nextCursor || page.nextCursor === request.cursor)) throw new Error("过程详情分页响应游标无效");
          if (page.version !== request.throughSeq) throw new Error("过程详情版本与请求边界不一致");
          mergePage(page, older && !changedPage);
          const next = page.hasMore ? { ...request, cursor: page.nextCursor! } : null;
          if (older || initial) {
            olderPage = next;
            if (initial) state.version = page.version;
          } else {
            changedPage = next;
            if (!next) state.version = page.version;
          }
          state.hasMore = Boolean(olderPage || changedPage);
          // 新版本只接续已完成批次；剩余页由用户显式加载。
          if (loadOlder || changedPage) break;
        } while (open && token === generation && state.version < targetVersion);
      } catch (error) {
        if (token !== generation || !open) return;
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (token === generation) {
          state.loading = false;
          controller = null;
          pending = null;
        }
      }
    })();
    await pending;
    // 旧页读取期间可能已合并更高通知，完成后接续一次变化页。
    if (open && token === generation && !state.error && !changedPage && state.version < targetVersion) await run(false);
  }

  /** 合并通知版本，展开时优先补读变化，折叠时只记录目标版本。 */
  async function refresh(version: number): Promise<void> {
    targetVersion = Math.max(targetVersion, version);
    await run(false);
  }

  /** 优先读取尚未完成的变化页，再读取固定旧版本的下一页。 */
  async function loadMore(): Promise<void> {
    if (state.hasMore) await run(true);
  }

  /** 收起即撤销当前读取，已完成缓存留待下次展开增量补读。 */
  async function setOpen(value: boolean, version: number): Promise<void> {
    open = value;
    if (!value) {
      generation++;
      controller?.abort();
      controller = null;
      pending = null;
      state.loading = false;
      return;
    }
    await refresh(version);
  }

  /** 组件销毁或会话缓存换代时撤销请求并清空详情。 */
  function dispose(): void {
    open = false;
    generation++;
    controller?.abort();
    controller = null;
    pending = null;
    state.items = [];
    state.version = 0;
    state.hasMore = false;
    olderPage = null;
    changedPage = null;
    state.loading = false;
    state.error = null;
    targetVersion = 0;
  }

  return { state, refresh, loadMore, setOpen, dispose };
}
