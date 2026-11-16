import { createQuickPhrase, listQuickPhrases, type QuickPhraseRequestContext } from "../../api/quickPhrases";
import type { ApiRequestContext } from "../../api/request";
import { useConfigStore } from "../../store/config";
import { quickPhraseAccountScope } from "../../store/quickPhrases";

const MERGED_STORAGE_PREFIX = "codeflowai.quick-phrases.merged:";
const OWNER_STORAGE_KEY = "codeflowai.quick-phrases.owner";
let syncedScope = "";
let generation = 0;
let pending: { scope: string; promise: Promise<void> } | null = null;

/** 读取已合并记录；损坏时记录并重建空记录，避免永久阻断合并。 */
function readMergedIds(scope: string): Set<string> {
  const key = `${MERGED_STORAGE_PREFIX}${scope}`;
  const raw = localStorage.getItem(key);
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return new Set(value as string[]);
  } catch {
    // 损坏记录按空集合重建；账号侧仍按标题去重，不会重复创建同名项。
  }
  console.warn("[quick-phrases.merge_record_invalid]", { code: "QUICK_PHRASE_MERGE_RECORD_INVALID", scope });
  localStorage.removeItem(key);
  return new Set();
}

/** 持久化已合并记录，写入失败显式抛出。 */
function writeMergedIds(scope: string, ids: Set<string>): void {
  localStorage.setItem(`${MERGED_STORAGE_PREFIX}${scope}`, JSON.stringify([...ids]));
}

/** 登录后把本机提示词合并到账号；账号已有同名项优先，已合并项不重复上传。 */
export async function syncQuickPhrasesToAccount(ctx: ApiRequestContext, serverOrigin: string, userId: string): Promise<void> {
  const config = useConfigStore();
  const scope = quickPhraseAccountScope(serverOrigin, userId);
  if (!config.isDesktop || !config.localRuntimeReady || !config.connected || !scope || syncedScope === scope) return;
  if (pending?.scope === scope) return pending.promise;
  if (pending) {
    // 另一个账号的合并尚未落定时先等待，避免同一批本机提示词并发上传到两个账号。
    try { await pending.promise; } catch { /* 失败不阻断新账号的归属判定 */ }
    if (syncedScope === scope) return;
  }
  const startGeneration = generation;
  const requestId = `quick-phrases-sync-${Date.now()}`;
  const promise = (async () => {
    // 本机提示词已归属其他账号时不再合并，避免跨账号上传。
    const owner = localStorage.getItem(OWNER_STORAGE_KEY) ?? "";
    if (owner && owner !== scope) { syncedScope = scope; return; }
    const localCtx: QuickPhraseRequestContext = { ...ctx, scope: "local" };
    const accountCtx: QuickPhraseRequestContext = { ...ctx, scope: "account" };
    const merged = readMergedIds(scope);
    const local = await listQuickPhrases(localCtx);
    if (!local.items.length) { syncedScope = scope; return; }
    const account = await listQuickPhrases(accountCtx);
    // 账号集合读取成功后才认领归属；读取失败时不会把本机提示词永久锁给该账号。
    localStorage.setItem(OWNER_STORAGE_KEY, scope);
    const titles = new Set(account.items.map((item) => item.title.trim()));
    let changed = false;
    for (const item of local.items) {
      if (merged.has(item.id)) continue;
      const title = item.title.trim();
      if (!titles.has(title)) {
        await createQuickPhrase(accountCtx, { clientRequestId: `merge:${item.id}`.slice(0, 100), title: item.title, content: item.content });
        titles.add(title);
      }
      merged.add(item.id);
      changed = true;
    }
    if (changed) writeMergedIds(scope, merged);
    // 合并期间登出时不再记录已同步，下一次登录同一账号仍会补合并新增项。
    if (startGeneration === generation) syncedScope = scope;
  })().catch((error) => {
    console.error("[quick-phrases.sync-failed]", {
      code: "QUICK_PHRASE_SYNC_FAILED", requestId, scope,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }).finally(() => { if (pending?.promise === promise) pending = null; });
  pending = { scope, promise };
  return promise;
}

/** 退出账号后允许下次登录重新合并本机新增项。 */
export function resetQuickPhraseSync(): void {
  generation += 1;
  syncedScope = "";
}
