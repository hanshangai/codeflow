export type CodexHistoryProjection = {
  turnIds?: readonly string[];
  excludeTurnIds?: readonly string[];
  itemTypes?: readonly string[];
};

type HistoryRequester = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Reads thread metadata and turn pages without transporting a complete rollout in one RPC line. */
export async function readCodexThreadHistory(
  request: HistoryRequester,
  params: Record<string, unknown>,
  projection?: CodexHistoryProjection,
): Promise<unknown> {
  const read = await request("thread/read", { ...params, includeTurns: false }) as any;
  const threadId = String(params.threadId ?? "");
  if (String(read?.thread?.id ?? "") !== threadId) {
    throw new Error(`Codex history thread ID mismatch: expected=${threadId}, actual=${read?.thread?.id ?? "missing"}`);
  }
  const turns: any[] = [];
  const seenTurnIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await readCodexTurnHistoryPage(request, {
      threadId,
      limit: 64,
      sortDirection: "asc",
      ...(cursor ? { cursor } : {}),
    }, projection, read.thread.historyMode) as any;
    for (const turn of page.data) {
      if (seenTurnIds.has(turn.id)) throw new Error(`Codex history duplicate turn: threadId=${threadId}, turnId=${turn.id}`);
      seenTurnIds.add(turn.id);
      turns.push(turn);
    }
    cursor = nextHistoryCursor(page, seenCursors, threadId);
  } while (cursor);
  return { ...read, thread: { ...read.thread, turns } };
}

/** Expands only selected item types from a bounded turn page; summary already contains user messages. */
export async function readCodexTurnHistoryPage(
  request: HistoryRequester,
  params: Record<string, unknown>,
  projection?: CodexHistoryProjection,
  historyMode?: string,
): Promise<unknown> {
  const threadId = String(params.threadId ?? "");
  if (historyMode === undefined && (!projection?.itemTypes || projection.itemTypes.some((type) => type !== "userMessage"))) {
    const metadata = await request("thread/read", { threadId, includeTurns: false }) as any;
    if (metadata?.thread?.id !== threadId) throw new Error(`Codex history thread ID mismatch: threadId=${threadId}`);
    historyMode = metadata.thread.historyMode;
  }
  const itemsView = !projection?.itemTypes || projection.itemTypes.includes("userMessage") ? "summary" : "notLoaded";
  const page = await request("thread/turns/list", { ...params, itemsView }) as any;
  if (!Array.isArray(page?.data)) throw new Error(`Codex turn page is invalid: threadId=${threadId}`);
  const data: any[] = [];
  for (const turn of page.data) {
    if (!turn || typeof turn.id !== "string" || !turn.id || !Array.isArray(turn.items)) {
      throw new Error(`Codex turn page entry is invalid: threadId=${threadId}`);
    }
    const selected = (!projection?.turnIds || projection.turnIds.includes(turn.id))
      && !projection?.excludeTurnIds?.includes(turn.id);
    const itemTypes = projection?.itemTypes;
    const loadItems = selected && (!itemTypes || itemTypes.some((type) => type !== "userMessage"));
    const items = loadItems
      ? historyMode === "legacy"
        ? await readLegacyTurnItems(request, threadId, turn.id, itemTypes)
        : historyMode === "paginated"
          ? await readTurnItems(request, threadId, turn.id, itemTypes)
          : failHistoryMode(threadId)
      : turn.items.filter((item: any) => selected && (!itemTypes || itemTypes.includes(item.type)));
    data.push({ ...turn, items, itemsView: "full" });
  }
  return { ...page, data };
}

/** Legacy stores paginate turns rather than items; find the target before loading its body. */
async function readLegacyTurnItems(
  request: HistoryRequester,
  threadId: string,
  turnId: string,
  itemTypes?: readonly string[],
): Promise<unknown[]> {
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = { threadId, limit: 1, sortDirection: "desc", ...(cursor ? { cursor } : {}) };
    const page = await request("thread/turns/list", { ...params, itemsView: "notLoaded" }) as any;
    if (!Array.isArray(page?.data)) throw new Error(`Codex legacy turn page is invalid: threadId=${threadId}`);
    if (page.data.some((turn: any) => turn?.id === turnId)) {
      const full = await request("thread/turns/list", { ...params, itemsView: "full" }) as any;
      const turn = full?.data?.[0];
      if (full?.data?.length !== 1 || turn?.id !== turnId || !Array.isArray(turn?.items)) {
        throw new Error(`Codex legacy turn changed during read: threadId=${threadId}, turnId=${turnId}`);
      }
      return turn.items.filter((item: any) => !itemTypes || itemTypes.includes(item.type));
    }
    cursor = nextHistoryCursor(page, seenCursors, threadId);
  } while (cursor);
  throw new Error(`Codex legacy turn is missing: threadId=${threadId}, turnId=${turnId}`);
}

/** Unknown storage modes cannot be treated as complete history. */
function failHistoryMode(threadId: string): never {
  throw new Error(`Codex history mode is missing or unsupported: threadId=${threadId}`);
}

/** Loads a turn's item pages and retains only the projection needed by its caller. */
async function readTurnItems(
  request: HistoryRequester,
  threadId: string,
  turnId: string,
  itemTypes?: readonly string[],
): Promise<unknown[]> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await request("thread/items/list", {
      threadId,
      turnId,
      limit: 8,
      sortDirection: "asc",
      ...(cursor ? { cursor } : {}),
    }) as any;
    if (!Array.isArray(page?.data)) throw new Error(`Codex item page is invalid: threadId=${threadId}, turnId=${turnId}`);
    for (const entry of page.data) {
      if (entry?.turnId !== turnId || !entry.item || typeof entry.item.type !== "string") {
        throw new Error(`Codex item page entry is invalid: threadId=${threadId}, turnId=${turnId}`);
      }
      if (!itemTypes || itemTypes.includes(entry.item.type)) items.push(entry.item);
    }
    cursor = nextHistoryCursor(page, seenCursors, threadId);
  } while (cursor);
  return items;
}

/** Rejects invalid or repeated pagination cursors instead of accepting partial history. */
function nextHistoryCursor(page: any, seen: Set<string>, threadId: string): string | null {
  const cursor = page?.nextCursor;
  if (cursor === null) return null;
  if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
    throw new Error(`Codex history cursor is invalid: threadId=${threadId}`);
  }
  seen.add(cursor);
  return cursor;
}
