import type {
  KnowledgeAssetDetail,
  KnowledgeAssetDocument,
  KnowledgeAssetsSnapshot,
  KnowledgeReviewReportView,
} from "@codeflowai/shared";

export type KnowledgeNodeCacheEntry = {
  detail: KnowledgeAssetDetail;
  previewDocument: KnowledgeAssetDocument | null;
  previewRevisionId: string | null;
  reports: KnowledgeReviewReportView[];
};

const SNAPSHOT_CACHE_MAX = 5;
const NODE_CACHE_MAX = 20;

/** 规格库快照与当前正文缓存；模块级才能跨页面卸载/重新进入复用。 */
const snapshotCache = new Map<string, KnowledgeAssetsSnapshot>();
const nodeCache = new Map<string, KnowledgeNodeCacheEntry>();

/** 写入并按最近使用淘汰，重复写入会移到队尾。 */
function remember<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function rememberKnowledgeSnapshot(key: string, snapshot: KnowledgeAssetsSnapshot): void {
  remember(snapshotCache, key, snapshot, SNAPSHOT_CACHE_MAX);
}

export function readKnowledgeSnapshot(key: string): KnowledgeAssetsSnapshot | null {
  const snapshot = snapshotCache.get(key);
  if (!snapshot) return null;
  // 命中后移到队尾，保证同一批工作区中最近使用的快照优先保留。
  remember(snapshotCache, key, snapshot, SNAPSHOT_CACHE_MAX);
  return snapshot;
}

export function rememberKnowledgeNode(key: string, entry: KnowledgeNodeCacheEntry): void {
  remember(nodeCache, key, entry, NODE_CACHE_MAX);
}

export function readKnowledgeNode(key: string): KnowledgeNodeCacheEntry | null {
  const entry = nodeCache.get(key);
  if (!entry) return null;
  remember(nodeCache, key, entry, NODE_CACHE_MAX);
  return entry;
}

/** 退出登录、切换账号或权限变化时清空本地缓存，不保留旧账号的目录与正文。 */
export function clearKnowledgePageCache(): void {
  snapshotCache.clear();
  nodeCache.clear();
}
