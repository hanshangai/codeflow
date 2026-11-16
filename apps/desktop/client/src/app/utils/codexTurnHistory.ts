import type { SessionId, ThreadId, TurnId } from "@codeflowai/shared";

import type { ClientDb } from "../../db/clientDb.js";
import {
  decideCodexProviderTurnMapping,
  type CodexProviderTurnMappingCandidate,
} from "../../db/repos/codexProviderTurnMapping.js";
import type { ThreadTurnRecord } from "../../db/repos/threadTurnRepo.js";

export type CodexProviderTurnPair = {
  engineSessionId: SessionId;
  engineTurnId: string;
};

export type CodexProviderTurnHistoryResolution = Readonly<{
  engineSessionId: SessionId | null;
  engineTurnId: string | null;
}>;

type ResolvedCodexProviderTurnHistory = CodexProviderTurnHistoryResolution;

export type CodexProviderTurnHistoryBatch = {
  /** 按单 turn 的原始错误边界解析完整 provider identity。 */
  resolve(clientTurnId: TurnId): CodexProviderTurnHistoryResolution;
  /** 兼容 findCodexProviderTurnPairFromHistory，并补齐完整 pair 的派生 session。 */
  findPair(clientTurnId: TurnId): CodexProviderTurnPair | null;
  /** 兼容 findCodexTurnIdFromHistory，只返回严格解析后的 provider turnId。 */
  findTurnId(clientTurnId: TurnId): string | null;
};

export type CodexProviderTurnIdentity = ResolvedCodexProviderTurnHistory & {
  engineSessionSource: "durable_history" | "start_attempt" | "turn_row" | "missing";
};

export type CodexProviderTurnClientIdLookup =
  | { kind: "candidates"; clientUserMessageIds: string[] }
  | { kind: "incomplete"; message: string };

type RawCodexProviderTurnEvidence = {
  engineSessionId: SessionId | null;
  engineTurnId: string;
  eventSeq: number;
  observedAt: number;
};

/** 原子恢复并校验同一本地 turn 的 provider session/turn pair。 */
export function findCodexProviderTurnPairFromHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnId: TurnId },
): CodexProviderTurnPair | null {
  const transaction = db.db.transaction(() => prepareCodexProviderTurnHistoryBatch(db, {
    threadId: input.threadId,
    clientTurnIds: [input.clientTurnId],
  }).findPair(input.clientTurnId));
  return transaction();
}

/**
 * 读取中断恢复所需的 provider 身份；start attempt 和 row-only session 仍须用 clientUserMessageId 最终确权。
 */
export function findCodexProviderTurnIdentityFromHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnId: TurnId },
): CodexProviderTurnIdentity {
  const transaction = db.db.transaction((): CodexProviderTurnIdentity => {
    const resolved = resolveCodexProviderTurnHistory(db, input);
    if (resolved.engineSessionId) {
      return { ...resolved, engineSessionSource: "durable_history" };
    }
    const turn = db.turns.get(input.clientTurnId);
    const startAttempt = db.turns.getCodexStartAttempt(input.clientTurnId);
    if (startAttempt) {
      const rowClientUserMessageId = String(turn?.userItemId ?? "").trim();
      if (rowClientUserMessageId && rowClientUserMessageId !== startAttempt.clientUserMessageId) {
        throw new Error(
          `Codex start attempt clientUserMessageId 与 turn 行冲突：turnId=${input.clientTurnId}`,
        );
      }
      return {
        engineSessionId: startAttempt.providerThreadId,
        engineTurnId: resolved.engineTurnId ?? startAttempt.provisionalProviderTurnId,
        engineSessionSource: "start_attempt",
      };
    }
    const rowSessionId = (String(turn?.engineSessionId ?? "").trim() || null) as SessionId | null;
    return {
      engineSessionId: rowSessionId,
      engineTurnId: resolved.engineTurnId,
      engineSessionSource: rowSessionId ? "turn_row" : "missing",
    };
  });
  return transaction();
}

/** 严格读取本地 turn 的 userMessage clientId；损坏或截断时返回 incomplete，禁止继续 provider ownership 推测。 */
export function findCodexClientUserMessageIdsFromHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnId: TurnId },
): CodexProviderTurnClientIdLookup {
  const turn = db.turns.get(input.clientTurnId);
  if (!turn || turn.threadId !== input.threadId || turn.engine !== "codex") {
    return {
      kind: "incomplete",
      message: `本地 Codex turn scope 不完整，无法恢复 provider ownership：turnId=${input.clientTurnId}`,
    };
  }
  const startSeq = Number.isSafeInteger(Number(turn.startEventSeq ?? 0)) && Number(turn.startEventSeq) > 0
    ? Number(turn.startEventSeq)
    : null;
  const clientSequenceById = new Map<string, number>();
  const initialClientId = String(turn.userItemId ?? "").trim();
  if (initialClientId) clientSequenceById.set(initialClientId, startSeq ?? 0);

  type UserMessageRow = {
    seq: number;
    thread_id: string;
    workspace_id: string;
    engine: string;
    type: string;
    event_json: string;
  };
  let rows: UserMessageRow[];
  try {
    const statement = db.db.prepare(
      [
        "SELECT seq, thread_id, workspace_id, engine, type, event_json",
        "FROM conversation_events",
        startSeq == null
          ? "WHERE thread_id = ? AND type = 'item.userMessage.created'"
          : "WHERE thread_id = ? AND seq >= ? AND type = 'item.userMessage.created'",
        "ORDER BY seq DESC LIMIT 5001",
      ].join("\n"),
    );
    rows = (startSeq == null
      ? statement.all(String(input.threadId))
      : statement.all(String(input.threadId), startSeq)) as UserMessageRow[];
  } catch (cause) {
    return {
      kind: "incomplete",
      message: `读取本地 userMessage 历史失败，无法恢复 provider ownership：turnId=${input.clientTurnId}；${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  let oldestReadSeq = Number.POSITIVE_INFINITY;
  for (const row of rows.slice(0, 5_000)) {
    const seq = Number(row.seq ?? 0);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      return {
        kind: "incomplete",
        message: `本地 userMessage 时序字段无效，无法恢复 provider ownership：turnId=${input.clientTurnId}`,
      };
    }
    oldestReadSeq = Math.min(oldestReadSeq, seq);
    let event: any;
    try {
      event = JSON.parse(String(row.event_json ?? ""));
    } catch (cause) {
      return {
        kind: "incomplete",
        message: `本地 userMessage 历史损坏，无法恢复 provider ownership：turnId=${input.clientTurnId}, seq=${seq}；${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    if (
      !event
      || typeof event !== "object"
      || Array.isArray(event)
      || String(row.thread_id ?? "") !== String(input.threadId)
      || String(row.workspace_id ?? "") !== String(turn.workspaceId)
      || String(row.engine ?? "") !== "codex"
      || String(row.type ?? "") !== "item.userMessage.created"
      || (event.threadId != null && String(event.threadId) !== String(input.threadId))
      || (event.workspaceId != null && String(event.workspaceId) !== String(turn.workspaceId))
      || (event.engine != null && String(event.engine) !== "codex")
      || (event.type != null && String(event.type) !== "item.userMessage.created")
      || !event.payload
      || typeof event.payload !== "object"
      || Array.isArray(event.payload)
    ) {
      return {
        kind: "incomplete",
        message: `本地 userMessage scope 损坏，无法恢复 provider ownership：turnId=${input.clientTurnId}, seq=${seq}`,
      };
    }
    if (String(event.payload.turnId ?? "") !== String(input.clientTurnId)) continue;
    const clientId = String(event.payload.itemId ?? "").trim();
    if (!clientId) {
      return {
        kind: "incomplete",
        message: `本地 userMessage 缺少 clientId，无法恢复 provider ownership：turnId=${input.clientTurnId}, seq=${seq}`,
      };
    }
    clientSequenceById.set(clientId, Math.max(clientSequenceById.get(clientId) ?? 0, seq));
  }

  if (rows.length > 5_000 && (startSeq == null || oldestReadSeq > startSeq)) {
    return {
      kind: "incomplete",
      message: `本地 userMessage 历史达到 5000 条上限且未覆盖 turn 起点，无法恢复 provider ownership：turnId=${input.clientTurnId}, startEventSeq=${startSeq ?? "missing"}`,
    };
  }
  if (clientSequenceById.size === 0) {
    return {
      kind: "incomplete",
      message: `本地 turn 缺少 userMessage clientId，无法恢复 provider ownership：turnId=${input.clientTurnId}, startEventSeq=${startSeq ?? "missing"}`,
    };
  }
  return {
    kind: "candidates",
    clientUserMessageIds: Array.from(clientSequenceById.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([clientId]) => clientId),
  };
}

/** 兼容旧调用方：只返回已校验历史中的 provider turnId。 */
export function findCodexTurnIdFromHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnId: TurnId },
): string | null {
  const transaction = db.db.transaction(() => prepareCodexProviderTurnHistoryBatch(db, {
    threadId: input.threadId,
    clientTurnIds: [input.clientTurnId],
  }).findTurnId(input.clientTurnId));
  return transaction();
}

type PreparedCodexProviderTurnTarget = {
  clientTurnId: TurnId;
  turn: ThreadTurnRecord | null;
  workspaceId: string | null;
  checkpoint: CodexProviderTurnMappingCandidate | null;
  canonicalFromSeq: number | null;
  rawFromSeq: number;
  initialClientUserMessageId: string;
  setupError: unknown | null;
  fallbackStartError: unknown | null;
};

type ScannedCanonicalEvent = {
  seq: number;
  event: any | null;
  error: unknown | null;
};

type SequencedHistoryError = {
  seq: number;
  error: unknown;
};

type HistoryLoadError = {
  cause: unknown;
};

type RawTurnStartedCandidate = {
  engineTurnId: string;
  engineSessionId: SessionId | null;
  eventSeq: number;
  observedAt: number;
};

type PreparedRawHistory = {
  loadError: HistoryLoadError | null;
  globalFirstPassErrors: SequencedHistoryError[];
  firstPassErrorsByTurnId: Map<TurnId, SequencedHistoryError[]>;
  explicitEvidenceByTurnId: Map<TurnId, RawCodexProviderTurnEvidence[]>;
  correlatedProviderTurnIdsByTurnId: Map<TurnId, Set<string>>;
  unscopedTurnStarted: RawTurnStartedCandidate[];
};

type PreparedCodexProviderTurnHistory = {
  threadId: ThreadId;
  targets: Map<TurnId, PreparedCodexProviderTurnTarget>;
  canonicalLoadError: HistoryLoadError | null;
  canonicalEngineBound: ScannedCanonicalEvent[];
  raw: PreparedRawHistory;
};

/**
 * 一次预载同一 thread 的 canonical/raw 尾部；该同步快照不得跨异步边界或数据库变化继续使用。
 * 具体 turn 到 findPair/findTurnId 时才按原窗口抛错。
 * 这样未被调用方访问的旧 turn 损坏不会提前扩大失败边界。
 */
export function prepareCodexProviderTurnHistoryBatch(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnIds: readonly TurnId[] },
): CodexProviderTurnHistoryBatch {
  const prepare = db.db.transaction(() => prepareCodexProviderTurnHistory(db, input));
  const prepared = prepare();
  const resolvedByTurnId = new Map<TurnId, ResolvedCodexProviderTurnHistory>();

  /** 解析单个目标；需要 pair 时在同一写事务内补齐派生 session。 */
  const resolve = (clientTurnId: TurnId, backfillPairSession: boolean): ResolvedCodexProviderTurnHistory => {
    const target = prepared.targets.get(clientTurnId);
    if (!target) {
      throw new Error(`Codex provider history batch 未包含 turn：turnId=${clientTurnId}`);
    }
    const cached = resolvedByTurnId.get(clientTurnId);
    if (cached) {
      if (backfillPairSession && cached.engineSessionId && cached.engineTurnId) {
        const backfill = db.db.transaction(() => db.turns.backfillEngineSessionId(clientTurnId, cached.engineSessionId!));
        backfill();
      }
      return cached;
    }
    const transaction = db.db.transaction(() => {
      const resolved = resolvePreparedCodexProviderTurnHistory(db, prepared, target);
      if (backfillPairSession && resolved.engineSessionId && resolved.engineTurnId) {
        // 与单 turn pair API 保持一致：checkpoint 修复与派生 session 回填同成同败。
        db.turns.backfillEngineSessionId(clientTurnId, resolved.engineSessionId);
      }
      return resolved;
    });
    const resolved = transaction();
    resolvedByTurnId.set(clientTurnId, resolved);
    return resolved;
  };

  return {
    resolve: (clientTurnId) => ({ ...resolve(clientTurnId, false) }),
    findPair: (clientTurnId) => {
      const resolved = resolve(clientTurnId, true);
      if (!resolved.engineSessionId || !resolved.engineTurnId) return null;
      return { engineSessionId: resolved.engineSessionId, engineTurnId: resolved.engineTurnId };
    },
    findTurnId: (clientTurnId) => resolve(clientTurnId, false).engineTurnId,
  };
}

/** 单 turn 兼容入口；实际读取复用 batch 的一次扫描实现。 */
function resolveCodexProviderTurnHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnId: TurnId },
): ResolvedCodexProviderTurnHistory {
  return prepareCodexProviderTurnHistoryBatch(db, {
    threadId: input.threadId,
    clientTurnIds: [input.clientTurnId],
  }).resolve(input.clientTurnId);
}

/** 只准备稀疏证据和按 seq 归属的错误，不在此阶段解析任一具体 turn。 */
function prepareCodexProviderTurnHistory(
  db: ClientDb,
  input: { threadId: ThreadId; clientTurnIds: readonly TurnId[] },
): PreparedCodexProviderTurnHistory {
  const clientTurnIds = Array.from(new Set(input.clientTurnIds.map((turnId) => String(turnId)))) as TurnId[];
  const thread = db.threads.get(input.threadId);
  const targets = new Map<TurnId, PreparedCodexProviderTurnTarget>();
  let scanWorkspaceId = thread?.workspaceId ?? null;

  for (const clientTurnId of clientTurnIds) {
    const turn = db.turns.get(clientTurnId);
    let setupError: unknown | null = null;
    if (turn && (turn.threadId !== input.threadId || turn.engine !== "codex")) {
      setupError = new Error(`Codex provider turn 映射 scope 不匹配：turnId=${clientTurnId}`);
    } else if (thread && thread.engine !== "codex") {
      setupError = new Error(`Codex provider thread 映射 scope 不匹配：threadId=${input.threadId}`);
    } else if (turn && thread && turn.workspaceId !== thread.workspaceId) {
      setupError = new Error(`Codex provider turn workspace scope 不匹配：turnId=${clientTurnId}`);
    }
    const workspaceId = turn?.workspaceId ?? thread?.workspaceId ?? null;
    if (!setupError && scanWorkspaceId == null && workspaceId != null) scanWorkspaceId = workspaceId;
    let checkpoint: CodexProviderTurnMappingCandidate | null = null;
    if (!setupError) {
      try {
        checkpoint = readProviderTurnFromCheckpoint(turn?.engineCheckpointJson ?? null, clientTurnId);
      } catch (error) {
        setupError = error;
      }
    }
    targets.set(clientTurnId, {
      clientTurnId,
      turn,
      workspaceId,
      checkpoint,
      canonicalFromSeq: turn?.startEventSeq ?? null,
      rawFromSeq: 1,
      initialClientUserMessageId: String(turn?.userItemId ?? "").trim(),
      setupError,
      fallbackStartError: null,
    });
  }

  for (const target of targets.values()) {
    if (!target.setupError && scanWorkspaceId != null && target.workspaceId != null && target.workspaceId !== scanWorkspaceId) {
      target.setupError = new Error(`Codex provider turn workspace scope 不匹配：turnId=${target.clientTurnId}`);
    }
  }

  const readableTargets = [...targets.values()].filter((target) => !target.setupError);
  const canonicalFromSeq = readableTargets.some((target) => target.canonicalFromSeq == null)
    ? null
    : minimumHistoryScanSeq(readableTargets.map((target) => Number(target.canonicalFromSeq)));
  const canonical = readCanonicalProviderHistoryBatch(db, {
    threadId: input.threadId,
    workspaceId: scanWorkspaceId,
    fromSeq: canonicalFromSeq,
    enabled: readableTargets.length > 0,
  });

  for (const target of readableTargets) {
    let startSeq = target.canonicalFromSeq;
    if (startSeq == null) {
      const fallback = findPreparedStrictCanonicalTurnStartSeq(target, canonical.turnStarted);
      startSeq = fallback.startSeq;
      target.fallbackStartError = fallback.error;
    }
    target.rawFromSeq = Math.max(1, Number(startSeq ?? 1));
  }

  const rawTargets = readableTargets.filter((target) => !target.fallbackStartError);
  const raw = scanStrictRawTurnBatch(db, {
    threadId: input.threadId,
    workspaceId: scanWorkspaceId,
    targets: rawTargets,
    fromSeq: minimumHistoryScanSeq(rawTargets.map((target) => target.rawFromSeq)),
    enabled: canonical.loadError === null && rawTargets.length > 0,
  });
  return {
    threadId: input.threadId,
    targets,
    canonicalLoadError: canonical.loadError,
    canonicalEngineBound: canonical.engineBound,
    raw,
  };
}

/** 按某个 turn 的原始 fromSeq 窗口消费预载证据，并保留原解析/错误顺序。 */
function resolvePreparedCodexProviderTurnHistory(
  db: ClientDb,
  prepared: PreparedCodexProviderTurnHistory,
  target: PreparedCodexProviderTurnTarget,
): ResolvedCodexProviderTurnHistory {
  if (target.setupError) throw target.setupError;
  if (prepared.canonicalLoadError !== null) throw prepared.canonicalLoadError.cause;
  const canonicalScans = prepared.canonicalEngineBound.filter(
    (scan) => target.canonicalFromSeq == null || scan.seq >= target.canonicalFromSeq,
  );
  const canonicalError = canonicalScans.find((scan) => scan.error)?.error;
  if (canonicalError) throw canonicalError;
  const canonical = resolveCanonicalProviderTurnChain(
    canonicalScans.flatMap((scan) => scan.event ? [scan.event] : []),
    { threadId: prepared.threadId, clientTurnId: target.clientTurnId },
    target.checkpoint,
  );
  // 旧记录的 turn.started fallback 原本发生在 canonical replacement 校验之后。
  if (target.fallbackStartError) throw target.fallbackStartError;

  if (prepared.raw.loadError !== null) throw prepared.raw.loadError.cause;
  const rawErrors = [
    ...prepared.raw.globalFirstPassErrors,
    ...(prepared.raw.firstPassErrorsByTurnId.get(target.clientTurnId) ?? []),
  ]
    .filter((item) => item.seq >= target.rawFromSeq)
    .sort((left, right) => left.seq - right.seq);
  if (rawErrors[0]) throw rawErrors[0].error;

  const rawEvidence = [...(prepared.raw.explicitEvidenceByTurnId.get(target.clientTurnId) ?? [])];
  const correlatedProviderTurnIds = prepared.raw.correlatedProviderTurnIdsByTurnId.get(target.clientTurnId) ?? new Set<string>();
  if (correlatedProviderTurnIds.size > 0) {
    for (const candidate of prepared.raw.unscopedTurnStarted) {
      if (candidate.eventSeq < target.rawFromSeq || !correlatedProviderTurnIds.has(candidate.engineTurnId)) continue;
      rawEvidence.push(materializeRawTurnStartedEvidence(candidate, target.clientTurnId));
    }
  }
  return resolveCodexProviderTurnHistoryFromEvidence(db, {
    threadId: prepared.threadId,
    clientTurnId: target.clientTurnId,
    turn: target.turn,
    checkpoint: target.checkpoint,
    canonical,
    rawEvidence,
  });
}

/** 合并已按单 turn 限界的 checkpoint、canonical、raw，并拒绝跨 session 拼接。 */
function resolveCodexProviderTurnHistoryFromEvidence(
  db: ClientDb,
  input: {
    threadId: ThreadId;
    clientTurnId: TurnId;
    turn: ThreadTurnRecord | null;
    checkpoint: CodexProviderTurnMappingCandidate | null;
    canonical: ReturnType<typeof resolveCanonicalProviderTurnChain>;
    rawEvidence: RawCodexProviderTurnEvidence[];
  },
): ResolvedCodexProviderTurnHistory {
  const { turn, checkpoint, canonical, rawEvidence } = input;
  const checkpointTurnId = checkpoint?.engineTurnId ?? null;
  const rawTurnIds = new Set(rawEvidence.map((evidence) => evidence.engineTurnId));
  const canonicalTurnId = canonical.current?.engineTurnId ?? null;
  const checkpointAheadOfCanonical = Boolean(
    checkpointTurnId
    && canonicalTurnId
    && checkpointTurnId !== canonicalTurnId
    && checkpoint?.source === "turn.engineBound"
    && Number(checkpoint.eventSeq) > Number(canonical.current?.eventSeq ?? 0)
    && checkpoint?.supersededEngineTurnIds?.includes(canonicalTurnId),
  );
  if (
    checkpointTurnId
    && canonicalTurnId
    && checkpointTurnId !== canonicalTurnId
    && !canonical.supersededTurnIds.has(checkpointTurnId)
    && !checkpointAheadOfCanonical
  ) {
    throw new Error(
      `Codex provider turn checkpoint 与 canonical 冲突：turnId=${input.clientTurnId}, checkpoint=${checkpointTurnId}, canonical=${canonicalTurnId}`,
    );
  }
  const supersededTurnIds = new Set([
    ...canonical.supersededTurnIds,
    ...(checkpoint?.supersededEngineTurnIds ?? []),
  ]);
  // ACK buffer 可能暂时只落到祖先 A，而 checkpoint 已由同一链推进到 B；此时 B 才是当前链尾。
  const resolved = checkpointAheadOfCanonical
    ? checkpointTurnId
    : canonicalTurnId ?? checkpointTurnId ?? (rawTurnIds.size === 1 ? [...rawTurnIds][0]! : null);
  if (!resolved && rawTurnIds.size > 1) {
    throw new Error(`Codex provider turn raw 证据不唯一：turnId=${input.clientTurnId}, raw=${JSON.stringify([...rawTurnIds])}`);
  }
  if (resolved) {
    const conflictingRaw = [...rawTurnIds].filter(
      (candidate) => candidate !== resolved && !supersededTurnIds.has(candidate),
    );
    if (conflictingRaw.length > 0) {
      throw new Error(
        `Codex provider turn raw 证据冲突：turnId=${input.clientTurnId}, resolved=${resolved}, raw=${JSON.stringify([...rawTurnIds])}`,
      );
    }
  }

  const durableSessionIds = new Set<string>();
  const addSessionId = (value: SessionId | string | null | undefined) => {
    const normalized = String(value ?? "").trim();
    if (normalized) durableSessionIds.add(normalized);
  };
  addSessionId(checkpoint?.engineSessionId ?? null);
  for (const sessionId of canonical.sessionIds) addSessionId(sessionId);
  for (const evidence of rawEvidence) {
    if (!resolved || evidence.engineTurnId === resolved || supersededTurnIds.has(evidence.engineTurnId)) {
      addSessionId(evidence.engineSessionId);
    }
  }
  if (durableSessionIds.size > 1) {
    throw new Error(
      `Codex provider session 证据冲突：turnId=${input.clientTurnId}, sessions=${JSON.stringify([...durableSessionIds])}`,
    );
  }
  const durableSessionId = ([...durableSessionIds][0] ?? null) as SessionId | null;
  const hasCanonicalSessionProof = Boolean(
    durableSessionId
    && (
      canonical.sessionIds.has(durableSessionId)
      || (checkpoint?.source === "turn.engineBound" && checkpoint.engineSessionId === durableSessionId)
    )
  );
  const rawResolvedCandidates = resolved
    ? rawEvidence.filter((evidence) => evidence.engineTurnId === resolved)
    : [];
  const rawResolvedEvidence = durableSessionId
    ? rawResolvedCandidates.find((evidence) => evidence.engineSessionId === durableSessionId)
      ?? rawResolvedCandidates[0]
      ?? null
    : rawResolvedCandidates[0] ?? null;
  if (turn && !checkpoint && !canonical.current && rawResolvedEvidence) {
    db.turns.setCodexProviderTurnId(input.clientTurnId, {
      engineTurnId: rawResolvedEvidence.engineTurnId,
      engineSessionId: rawResolvedEvidence.engineSessionId,
      source: "turn/started",
      eventSeq: rawResolvedEvidence.eventSeq,
      observedAt: rawResolvedEvidence.observedAt,
    });
  }
  if (hasCanonicalSessionProof) {
    repairCodexProviderSessionFromCanonical(db, input.clientTurnId, checkpoint, canonical.mappings);
    const repairedSessionId = String(db.turns.get(input.clientTurnId)?.engineSessionId ?? "").trim();
    if (repairedSessionId !== durableSessionId) {
      throw new Error(
        `Codex provider session canonical 修复未收敛：turnId=${input.clientTurnId}, expected=${durableSessionId}, actual=${repairedSessionId || "missing"}`,
      );
    }
  }
  return {
    engineTurnId: resolved,
    engineSessionId: durableSessionId,
  };
}

/** 在单一事务内按 canonical 顺序重放映射，只修复目标 turn 的旧派生 session。 */
function repairCodexProviderSessionFromCanonical(
  db: ClientDb,
  clientTurnId: TurnId,
  checkpoint: CodexProviderTurnMappingCandidate | null,
  canonicalMappings: readonly CodexProviderTurnMappingCandidate[],
): void {
  let replayStart = 0;
  if (checkpoint && canonicalMappings.length > 0) {
    const exactIndex = canonicalMappings.findIndex((mapping) => mapping.engineTurnId === checkpoint.engineTurnId);
    if (exactIndex >= 0) {
      // raw checkpoint 命中同一 ID 时仍需用 canonical 事件 promote；canonical checkpoint 只重放后继。
      replayStart = checkpoint.source === "turn.engineBound" ? exactIndex + 1 : exactIndex;
    } else {
      const canonicalTail = canonicalMappings[canonicalMappings.length - 1]!;
      if (checkpoint.supersededEngineTurnIds?.includes(canonicalTail.engineTurnId)) {
        // checkpoint 已领先当前 ACK buffer，canonical 仅是其祖先，无需反向重放。
        replayStart = canonicalMappings.length;
      } else {
        const successorIndex = canonicalMappings.findIndex(
          (mapping) => mapping.supersededEngineTurnIds?.includes(checkpoint.engineTurnId),
        );
        if (successorIndex < 0) {
          throw new Error(
            `Codex provider canonical 重放无法定位 checkpoint 后继：turnId=${clientTurnId}, checkpoint=${checkpoint.engineTurnId}`,
          );
        }
        replayStart = successorIndex;
      }
    }
  }
  const transaction = db.db.transaction(() => {
    let persisted = checkpoint;
    if (persisted?.source === "turn.engineBound") {
      db.turns.setCodexProviderTurnId(clientTurnId, persisted);
    }
    for (const mapping of canonicalMappings.slice(replayStart)) {
      db.turns.setCodexProviderTurnId(clientTurnId, mapping);
      persisted = mapping;
    }
  });
  transaction();
}

/** 严格读取 provider checkpoint 及其完整 ancestor lineage。 */
function readProviderTurnFromCheckpoint(
  raw: string | null,
  turnId: TurnId,
): CodexProviderTurnMappingCandidate | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Codex provider turn checkpoint 无法解析：turnId=${turnId}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Codex provider turn checkpoint 根必须是 object：turnId=${turnId}`);
  }
  const value = parsed.codexProviderTurn;
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex provider turn checkpoint 无效：turnId=${turnId}`);
  }
  const engineTurnId = String(value.engineTurnId ?? "").trim();
  const source = String(value.source ?? "").trim();
  const eventSeq = Number(value.eventSeq ?? 0);
  const observedAt = Number(value.observedAt ?? 0);
  if (
    Number(value.v) !== 1
    || !engineTurnId
    || (source !== "turn.engineBound" && source !== "turn/started")
    || !Number.isSafeInteger(eventSeq)
    || eventSeq <= 0
    || !Number.isFinite(observedAt)
    || observedAt <= 0
  ) {
    throw new Error(`Codex provider turn checkpoint 字段无效：turnId=${turnId}`);
  }
  const decision = decideCodexProviderTurnMapping(null, {
    engineTurnId,
    engineSessionId: (String(value.engineSessionId ?? "").trim() || null) as SessionId | null,
    previousEngineTurnId: String(value.previousEngineTurnId ?? "").trim() || null,
    supersededEngineTurnIds: value.supersededEngineTurnIds,
    source: source as "turn.engineBound" | "turn/started",
    eventSeq,
    observedAt,
  });
  if (decision.action !== "replace") {
    throw new Error(`Codex provider turn checkpoint lineage 无效：turnId=${turnId}`);
  }
  return decision.mapping;
}

/** 一次读取 batch 所需的 engineBound 与 legacy turn.started 稀疏 canonical 证据。 */
function readCanonicalProviderHistoryBatch(
  db: ClientDb,
  input: { threadId: ThreadId; workspaceId: string | null; fromSeq: number | null; enabled: boolean },
): {
  loadError: HistoryLoadError | null;
  engineBound: ScannedCanonicalEvent[];
  turnStarted: ScannedCanonicalEvent[];
} {
  if (!input.enabled) return { loadError: null, engineBound: [], turnStarted: [] };
  let rows: StoredEventRow[];
  try {
    const statement = db.db.prepare(
      [
        "SELECT seq, thread_id, workspace_id, engine, type, event_json, ts",
        "FROM conversation_events",
        input.fromSeq == null
          ? "WHERE thread_id = ? AND type IN ('turn.engineBound','turn.started')"
          : "WHERE thread_id = ? AND seq >= ? AND type IN ('turn.engineBound','turn.started')",
        "ORDER BY seq ASC",
      ].join("\n"),
    );
    rows = (input.fromSeq == null
      ? statement.all(String(input.threadId))
      : statement.all(String(input.threadId), input.fromSeq)) as StoredEventRow[];
  } catch (error) {
    return { loadError: { cause: error }, engineBound: [], turnStarted: [] };
  }
  const engineBound: ScannedCanonicalEvent[] = [];
  const turnStarted: ScannedCanonicalEvent[] = [];
  for (const row of rows) {
    const expectedType = String(row.type ?? "");
    const target = expectedType === "turn.engineBound" ? engineBound : turnStarted;
    try {
      target.push({
        seq: Number(row.seq),
        event: parseStrictCanonicalEnvelope(row, {
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          expectedType,
        }),
        error: null,
      });
    } catch (error) {
      target.push({ seq: Number(row.seq), event: null, error });
    }
  }
  return { loadError: null, engineBound, turnStarted };
}

/** 用已按 fromSeq 限界的 canonical 事件校验 authoritative replacement 链。 */
function resolveCanonicalProviderTurnChain(
  events: readonly any[],
  input: { threadId: ThreadId; clientTurnId: TurnId },
  checkpoint: CodexProviderTurnMappingCandidate | null,
): {
  current: CodexProviderTurnMappingCandidate | null;
  mappings: CodexProviderTurnMappingCandidate[];
  sessionIds: Set<SessionId>;
  supersededTurnIds: Set<string>;
} {
  let current: CodexProviderTurnMappingCandidate | null = null;
  const mappings: CodexProviderTurnMappingCandidate[] = [];
  const sessionIds = new Set<SessionId>();
  for (const event of events) {
    if (String(event.payload.turnId ?? "") !== String(input.clientTurnId)) continue;
    const nextTurnId = String(event.payload.engineTurnId ?? "").trim();
    const engineSessionId = String(event.payload.engineSessionId ?? "").trim() as SessionId;
    const previousTurnId = String(event.payload.previousEngineTurnId ?? "").trim() || null;
    if (!nextTurnId || !engineSessionId) {
      throw new Error(`Codex turn.engineBound 缺少 provider pair：turnId=${input.clientTurnId}`);
    }
    sessionIds.add(engineSessionId);
    const incoming: CodexProviderTurnMappingCandidate = {
      engineTurnId: nextTurnId,
      engineSessionId,
      previousEngineTurnId: previousTurnId,
      source: "turn.engineBound",
      eventSeq: Number(event.seq ?? 0),
      observedAt: Number(event.ts ?? 0),
    };
    const decision = decideCodexProviderTurnMapping(current, incoming);
    if (decision.action === "conflict") {
      const bridged = bridgeCanonicalProviderTurnGap(current, incoming, checkpoint);
      if (!bridged) {
        throw new Error(
          `Codex provider turn replacement 链冲突：turnId=${input.clientTurnId}, current=${current?.engineTurnId ?? "missing"}, incoming=${nextTurnId}`,
        );
      }
      current = bridged;
      mappings.push(bridged);
      continue;
    }
    if (decision.action === "replace") {
      current = decision.mapping;
      mappings.push(decision.mapping);
    }
  }
  return {
    current,
    mappings,
    sessionIds,
    supersededTurnIds: new Set(current?.supersededEngineTurnIds ?? []),
  };
}

/** 仅用同 session、同顺序的 durable checkpoint lineage 补合 canonical ACK 单段缺口。 */
function bridgeCanonicalProviderTurnGap(
  current: CodexProviderTurnMappingCandidate | null,
  incoming: CodexProviderTurnMappingCandidate,
  checkpoint: CodexProviderTurnMappingCandidate | null,
): CodexProviderTurnMappingCandidate | null {
  if (
    !current
    || checkpoint?.source !== "turn.engineBound"
    || incoming.source !== "turn.engineBound"
    || !incoming.previousEngineTurnId
    || !incoming.engineSessionId
    || checkpoint.engineSessionId !== incoming.engineSessionId
    || current.engineSessionId !== incoming.engineSessionId
    || checkpoint.eventSeq < incoming.eventSeq
  ) {
    return null;
  }
  const lineage = [
    ...(checkpoint.supersededEngineTurnIds ?? []),
    checkpoint.engineTurnId,
  ];
  const currentIndex = lineage.indexOf(current.engineTurnId);
  const previousIndex = lineage.indexOf(incoming.previousEngineTurnId);
  const incomingIndex = lineage.indexOf(incoming.engineTurnId);
  if (
    currentIndex < 0
    || previousIndex <= currentIndex
    || incomingIndex !== previousIndex + 1
    || incoming.eventSeq <= current.eventSeq
  ) {
    return null;
  }
  const expectedCurrentLineage = lineage.slice(0, currentIndex);
  const currentLineage = current.supersededEngineTurnIds ?? [];
  if (
    currentLineage.length !== expectedCurrentLineage.length
    || currentLineage.some((turnId, index) => turnId !== expectedCurrentLineage[index])
  ) {
    return null;
  }
  const normalized = decideCodexProviderTurnMapping(null, {
    ...incoming,
    supersededEngineTurnIds: lineage.slice(0, incomingIndex),
  });
  return normalized.action === "replace" ? normalized.mapping : null;
}

type StoredEventRow = {
  seq: number;
  thread_id: string;
  workspace_id: string;
  engine: string;
  type?: string;
  source?: string;
  event_json: string;
  ts: number;
};

/** 按原 DESC 访问顺序定位 legacy turn.started；只把实际越过的损坏行归给该 turn。 */
function findPreparedStrictCanonicalTurnStartSeq(
  target: PreparedCodexProviderTurnTarget,
  scans: readonly ScannedCanonicalEvent[],
): { startSeq: number | null; error: unknown | null } {
  for (let index = scans.length - 1; index >= 0; index -= 1) {
    const scan = scans[index]!;
    if (scan.error) return { startSeq: null, error: scan.error };
    if (String(scan.event?.payload?.turnId ?? "") === String(target.clientTurnId)) {
      return { startSeq: Number(scan.event?.seq ?? scan.seq), error: null };
    }
  }
  return { startSeq: null, error: null };
}

/** 返回一组历史起点的最小扫描 seq；任一非正起点都必须保留全历史窗口。 */
function minimumHistoryScanSeq(values: readonly number[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    minimum = Math.min(minimum, Number.isSafeInteger(value) && value > 0 ? value : 1);
  }
  return Number.isFinite(minimum) ? minimum : 1;
}

/** 一次分页扫描 batch 的 raw 尾部，只保留目标相关索引和按 seq 延迟抛出的错误。 */
function scanStrictRawTurnBatch(
  db: ClientDb,
  input: {
    threadId: ThreadId;
    workspaceId: string | null;
    targets: readonly PreparedCodexProviderTurnTarget[];
    fromSeq: number;
    enabled: boolean;
  },
): PreparedRawHistory {
  const prepared: PreparedRawHistory = {
    loadError: null,
    globalFirstPassErrors: [],
    firstPassErrorsByTurnId: new Map(),
    explicitEvidenceByTurnId: new Map(),
    correlatedProviderTurnIdsByTurnId: new Map(),
    unscopedTurnStarted: [],
  };
  if (!input.enabled) return prepared;

  const targetsById = new Map(input.targets.map((target) => [String(target.clientTurnId), target]));
  const targetsByInitialClientId = new Map<string, PreparedCodexProviderTurnTarget[]>();
  for (const target of input.targets) {
    if (!target.initialClientUserMessageId) continue;
    const targets = targetsByInitialClientId.get(target.initialClientUserMessageId) ?? [];
    targets.push(target);
    targetsByInitialClientId.set(target.initialClientUserMessageId, targets);
  }
  /** 保存只影响某个 target 窗口的行级错误。 */
  const addTargetError = (target: PreparedCodexProviderTurnTarget, seq: number, error: unknown): void => {
    const errors = prepared.firstPassErrorsByTurnId.get(target.clientTurnId) ?? [];
    errors.push({ seq, error });
    prepared.firstPassErrorsByTurnId.set(target.clientTurnId, errors);
  };
  /** 保存 userMessage clientId 精确确权的 provider turnId。 */
  const addCorrelatedProviderTurnId = (target: PreparedCodexProviderTurnTarget, providerTurnId: string): void => {
    const ids = prepared.correlatedProviderTurnIdsByTurnId.get(target.clientTurnId) ?? new Set<string>();
    ids.add(providerTurnId);
    prepared.correlatedProviderTurnIdsByTurnId.set(target.clientTurnId, ids);
  };

  const pageSize = 800;
  let statement: ReturnType<ClientDb["db"]["prepare"]>;
  try {
    statement = db.db.prepare(
      [
        "SELECT seq, thread_id, workspace_id, engine, source, event_json, ts",
        "FROM raw_engine_events",
        "WHERE thread_id = ? AND seq > ? AND source = 'codex.app-server.msg'",
        `ORDER BY seq ASC LIMIT ${pageSize}`,
      ].join("\n"),
    );
  } catch (error) {
    prepared.loadError = { cause: error };
    return prepared;
  }
  let cursor = Math.max(0, input.fromSeq - 1);
  while (true) {
    let rows: StoredEventRow[];
    try {
      rows = statement.all(String(input.threadId), cursor) as StoredEventRow[];
    } catch (error) {
      prepared.loadError = { cause: error };
      return prepared;
    }
    for (const row of rows) {
      const seq = Number(row.seq);
      let event: any;
      try {
        event = parseStrictRawEnvelope(row, { threadId: input.threadId, workspaceId: input.workspaceId });
      } catch (error) {
        prepared.globalFirstPassErrors.push({ seq, error });
        continue;
      }
      const hasClientTurnId = Object.prototype.hasOwnProperty.call(event, "clientTurnId");
      const explicitClientTurnId = String(event.clientTurnId ?? "").trim();
      if (hasClientTurnId && !explicitClientTurnId) {
        prepared.globalFirstPassErrors.push({
          seq,
          error: new Error(`Codex raw event clientTurnId 字段无效：seq=${seq}`),
        });
        continue;
      }
      const explicitTarget = explicitClientTurnId ? targetsById.get(explicitClientTurnId) ?? null : null;
      if (explicitClientTurnId && !explicitTarget) continue;

      const message = event.data ?? null;
      if (message && typeof message === "object" && String((message as any).method ?? "") === "item/started") {
        const params = (message as any).params ?? null;
        const item = params?.item ?? null;
        if (String(item?.type ?? "") === "userMessage") {
          const clientId = String(item?.clientId ?? "").trim();
          const correlationTargets = explicitTarget
            ? [explicitTarget]
            : targetsByInitialClientId.get(clientId) ?? [];
          for (const target of correlationTargets) {
            if (
              !target.initialClientUserMessageId
              || seq < target.rawFromSeq
              || clientId !== target.initialClientUserMessageId
            ) continue;
            const providerTurnId = String(params?.turn?.id ?? params?.turnId ?? "").trim();
            if (!providerTurnId) {
              addTargetError(
                target,
                seq,
                new Error(`Codex raw userMessage clientId 缺少 provider turnId：turnId=${target.clientTurnId}`),
              );
              continue;
            }
            addCorrelatedProviderTurnId(target, providerTurnId);
          }
        }
      }

      const candidate = readRawTurnStartedCandidate(event);
      if (!candidate) continue;
      if (!hasClientTurnId) {
        prepared.unscopedTurnStarted.push(candidate);
        continue;
      }
      if (!explicitTarget || seq < explicitTarget.rawFromSeq) continue;
      try {
        const evidence = materializeRawTurnStartedEvidence(candidate, explicitTarget.clientTurnId);
        const values = prepared.explicitEvidenceByTurnId.get(explicitTarget.clientTurnId) ?? [];
        values.push(evidence);
        prepared.explicitEvidenceByTurnId.set(explicitTarget.clientTurnId, values);
      } catch (error) {
        addTargetError(explicitTarget, seq, error);
      }
    }
    if (rows.length < pageSize) return prepared;
    const nextCursor = Number(rows.at(-1)?.seq ?? 0);
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
      prepared.loadError = {
        cause: new Error(`Codex raw ownership 分页游标无效：threadId=${input.threadId}, seq=${nextCursor}`),
      };
      return prepared;
    }
    cursor = nextCursor;
  }
}

/** 严格解析单条 raw envelope；batch 只缓存目标相关派生证据。 */
function parseStrictRawEnvelope(
  row: StoredEventRow,
  input: { threadId: ThreadId; workspaceId: string | null },
): any {
  const event = parseStrictStoredEnvelope(row, "raw");
  assertStoredEnvelopeScope(row, event, {
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    expectedEngine: "codex",
  });
  const explicitSource = String(event.source ?? "").trim();
  const storedSource = String(row.source ?? "").trim();
  if (!storedSource || (explicitSource && explicitSource !== storedSource)) {
    throw new Error(`Codex raw event source scope 不匹配：seq=${row.seq}`);
  }
  return { ...event, source: explicitSource || storedSource, seq: Number(row.seq), ts: Number(row.ts) };
}

/** 提取 raw turn/start 候选；时序字段延迟到确权给具体 client turn 时校验。 */
function readRawTurnStartedCandidate(event: any): RawTurnStartedCandidate | null {
  const message = event.data ?? null;
  if (!message || typeof message !== "object") return null;
  const method = String((message as any).method ?? "");
  if (method !== "turn/started" && method !== "turn/start") return null;
  const params = (message as any).params ?? null;
  const engineTurnId = String(params?.turn?.id ?? params?.turnId ?? "").trim();
  if (!engineTurnId) return null;
  const engineSessionId = String(
    params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId ?? "",
  ).trim();
  return {
    engineTurnId,
    engineSessionId: (engineSessionId || null) as SessionId | null,
    eventSeq: Number(event.seq ?? 0),
    observedAt: Number(event.ts ?? 0),
  };
}

/** 只有候选被某个 client turn 精确命中后，才按旧合同校验并物化 raw evidence。 */
function materializeRawTurnStartedEvidence(
  candidate: RawTurnStartedCandidate,
  clientTurnId: TurnId,
): RawCodexProviderTurnEvidence {
  if (
    !Number.isSafeInteger(candidate.eventSeq)
    || candidate.eventSeq <= 0
    || !Number.isFinite(candidate.observedAt)
    || candidate.observedAt <= 0
  ) {
    throw new Error(`Codex raw turn/started 时序字段无效：turnId=${clientTurnId}`);
  }
  return { ...candidate };
}

/** 严格解析 canonical envelope，并用持久化列补齐旧 envelope 的缺失 scope。 */
function parseStrictCanonicalEnvelope(
  row: StoredEventRow,
  input: { threadId: ThreadId; workspaceId: string | null; expectedType: string },
): any {
  const event = parseStrictStoredEnvelope(row, "canonical");
  assertStoredEnvelopeScope(row, event, {
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    expectedEngine: "codex",
  });
  const explicitType = String(event.type ?? "").trim();
  const storedType = String(row.type ?? "").trim();
  if (storedType !== input.expectedType || (explicitType && explicitType !== storedType)) {
    throw new Error(`Codex canonical event type scope 不匹配：seq=${row.seq}`);
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Codex canonical event payload 无效：type=${storedType}, seq=${row.seq}`);
  }
  const payloadTurnId = String(payload.turnId ?? "").trim();
  if (!payloadTurnId) throw new Error(`Codex canonical event 缺少 turnId：type=${storedType}, seq=${row.seq}`);
  return {
    ...event,
    threadId: input.threadId,
    workspaceId: input.workspaceId ?? String(row.workspace_id),
    engine: "codex",
    type: storedType,
    payload,
    seq: Number(row.seq),
    ts: Number(row.ts),
  };
}

/** JSON 损坏必须中断 ownership 恢复，禁止被 raw fallback 掩盖。 */
function parseStrictStoredEnvelope(row: StoredEventRow, kind: "canonical" | "raw"): any {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.event_json ?? ""));
  } catch (cause) {
    throw new Error(`Codex ${kind} event JSON 无法解析：seq=${row.seq}`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Codex ${kind} event envelope 无效：seq=${row.seq}`);
  }
  return parsed as any;
}

/** 显式 scope 与持久化列不一致时失败；旧 envelope 缺字段时仅信任持久化列。 */
function assertStoredEnvelopeScope(
  row: StoredEventRow,
  event: any,
  input: { threadId: ThreadId; workspaceId: string | null; expectedEngine: string },
): void {
  const storedThreadId = String(row.thread_id ?? "").trim();
  const storedWorkspaceId = String(row.workspace_id ?? "").trim();
  const storedEngine = String(row.engine ?? "").trim();
  const explicitThreadId = String(event.threadId ?? "").trim();
  const explicitWorkspaceId = String(event.workspaceId ?? "").trim();
  const explicitEngine = String(event.engine ?? "").trim();
  if (
    storedThreadId !== String(input.threadId)
    || !storedWorkspaceId
    || (input.workspaceId != null && storedWorkspaceId !== String(input.workspaceId))
    || storedEngine !== input.expectedEngine
    || (explicitThreadId && explicitThreadId !== storedThreadId)
    || (explicitWorkspaceId && explicitWorkspaceId !== storedWorkspaceId)
    || (explicitEngine && explicitEngine !== storedEngine)
  ) {
    throw new Error(`Codex event envelope scope 不匹配：seq=${row.seq}`);
  }
}
