import type { EngineType, ItemId, OrchAssetExecutionAuthorization, SessionId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { readOrchAssetExecutionAuthorization } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";
import {
  createCodexProviderTurnMappingConflictError,
  decideCodexProviderTurnMapping,
  type CodexProviderTurnMappingCandidate,
} from "./codexProviderTurnMapping.js";

export type ThreadTurnStatus = "started" | "completed" | "error";

export type ThreadTurnRecord = {
  threadId: ThreadId;
  turnId: TurnId;
  workspaceId: WorkspaceId;
  engine: EngineType;
  engineSessionId: SessionId | null;
  status: ThreadTurnStatus;
  startedAt: number;
  endedAt: number | null;
  startEventSeq: number | null;
  endEventSeq: number | null;
  userItemId: ItemId | null;
  userText: string | null;
  engineCheckpointJson: string | null;
};

export type CodexStartAttemptCheckpoint = {
  v: 1;
  clientUserMessageId: string;
  providerThreadId: SessionId;
  provisionalProviderTurnId: string;
  attemptId: number;
  observedAt: number;
};

/** turn 索引仓储：用于“回滚到某个用户 turn”等能力（以本地事件为准）。 */
export class ThreadTurnRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 创建或补齐 turn.started 记录；同 scope 重放幂等，跨 scope 冲突显式失败。 */
  insertStarted(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    engine: EngineType;
    turnId: TurnId;
    startedAt: number;
    startEventSeq: number | null;
  }): void {
    this.db
      .prepare(
        [
          "INSERT OR IGNORE INTO thread_turns (",
          "  thread_id, turn_id, workspace_id, engine, engine_session_id, status, started_at, ended_at, start_event_seq, end_event_seq, user_item_id, user_text, engine_checkpoint_json",
          ") VALUES (?, ?, ?, ?, NULL, 'started', ?, NULL, ?, NULL, NULL, NULL, NULL)",
        ].join("\n"),
      )
      .run(
        String(input.threadId),
        String(input.turnId),
        String(input.workspaceId),
        String(input.engine),
        Number(input.startedAt ?? Date.now()),
        input.startEventSeq == null ? null : Number(input.startEventSeq),
      );
    const reconciled = this.db.prepare(
      [
        "UPDATE thread_turns",
        "SET started_at = MIN(started_at, ?), start_event_seq = COALESCE(start_event_seq, ?)",
        "WHERE turn_id = ? AND thread_id = ? AND workspace_id = ? AND engine = ?",
      ].join("\n"),
    ).run(
      Number(input.startedAt),
      input.startEventSeq == null ? null : Number(input.startEventSeq),
      String(input.turnId),
      String(input.threadId),
      String(input.workspaceId),
      String(input.engine),
    );
    if (Number(reconciled.changes ?? 0) !== 1) {
      throw new Error(
        `turn scope 不匹配：turnId=${input.turnId}, threadId=${input.threadId}, workspaceId=${input.workspaceId}, engine=${input.engine}`,
      );
    }
  }

  /** 保存回合原始输入供执行判断和回滚定位，独立于聊天记录的展示删除。 */
  setUserMessage(turnId: TurnId, input: { userItemId: ItemId; userText: string }): void {
    this.db
      .prepare("UPDATE thread_turns SET user_item_id = ?, user_text = ? WHERE turn_id = ?")
      .run(String(input.userItemId), String(input.userText ?? ""), String(turnId));
  }

  /** 写入 engineSessionId（用于诊断/回滚）。 */
  setEngineSessionIdByThread(threadId: ThreadId, engineSessionId: SessionId): void {
    this.db
      .prepare("UPDATE thread_turns SET engine_session_id = ? WHERE thread_id = ? AND (engine_session_id IS NULL OR engine_session_id = '')")
      .run(String(engineSessionId), String(threadId));
  }

  /** 用已经过 provider 证据校验的 sessionId 精确补齐单个 turn；已有冲突必须显式失败。 */
  backfillEngineSessionId(turnId: TurnId, engineSessionId: SessionId): void {
    const id = String(turnId ?? "").trim();
    const sessionId = String(engineSessionId ?? "").trim();
    if (!id) throw new Error("Invalid turnId for engine session backfill");
    if (!sessionId) throw new Error(`Invalid engine sessionId for turn ${id}`);

    const result = this.db
      .prepare(
        "UPDATE thread_turns SET engine_session_id = ? WHERE turn_id = ? AND TRIM(COALESCE(engine_session_id, '')) = ''",
      )
      .run(sessionId, id);
    if (Number(result.changes ?? 0) === 1) return;

    const row = this.db
      .prepare("SELECT engine_session_id FROM thread_turns WHERE turn_id = ?")
      .get(id) as { engine_session_id: string | null } | undefined;
    if (!row) throw new Error(`Turn not found for engine session backfill: ${id}`);
    const currentSessionId = String(row.engine_session_id ?? "").trim();
    if (currentSessionId !== sessionId) {
      throw new Error(
        `Engine session mismatch for local turn ${id}: existing=${currentSessionId || "missing"}, incoming=${sessionId}`,
      );
    }
  }

  /** 清除无法形成稳定 provider pair 的单 turn 派生 session 绑定。 */
  clearEngineSessionId(turnId: TurnId): void {
    const id = String(turnId ?? "").trim();
    if (!id) throw new Error("Invalid turnId for engine session cleanup");
    const result = this.db
      .prepare("UPDATE thread_turns SET engine_session_id = NULL WHERE turn_id = ?")
      .run(id);
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`Turn not found for engine session cleanup: ${id}`);
    }
  }

  /** 标记 turn 已结束（completed/error）。 */
  setEnded(turnId: TurnId, input: { status: Exclude<ThreadTurnStatus, "started">; endedAt: number; endEventSeq: number | null }): void {
    this.db
      .prepare("UPDATE thread_turns SET status = ?, ended_at = ?, end_event_seq = ? WHERE turn_id = ?")
      .run(String(input.status), Number(input.endedAt ?? Date.now()), input.endEventSeq == null ? null : Number(input.endEventSeq), String(turnId));
  }

  /** 写入provider checkpoint并保留已派发资产来源，禁止覆盖既有授权绑定。 */
  setEngineCheckpoint(turnId: TurnId, engineCheckpointJson: string): void {
    const row = this.db.prepare("SELECT engine_checkpoint_json FROM thread_turns WHERE turn_id = ?").get(String(turnId)) as { engine_checkpoint_json: string | null } | undefined;
    if (!row) throw new Error(`Turn not found for engine checkpoint: ${turnId}`);
    const current = parseEngineCheckpoint(row.engine_checkpoint_json, String(turnId));
    const incoming = parseEngineCheckpoint(engineCheckpointJson, String(turnId));
    const serialized = Object.prototype.hasOwnProperty.call(current, "assetExecutionAuthorization") ? JSON.stringify({ ...incoming,
      assetExecutionAuthorization: current.assetExecutionAuthorization,
      assetExecutionEngineSessionId: current.assetExecutionEngineSessionId ?? null,
    }) : engineCheckpointJson;
    this.db.prepare("UPDATE thread_turns SET engine_checkpoint_json = ? WHERE turn_id = ?").run(String(serialized), String(turnId));
  }

  /** 当前provider binding只复验其实际派发来源；未知binding证据保守保留。 */
  getAssetExecutionAuthorizations(threadId: ThreadId, engineSessionId: string | null): OrchAssetExecutionAuthorization[] {
    const rows = this.db.prepare("SELECT engine_session_id, engine_checkpoint_json FROM thread_turns WHERE thread_id = ? AND engine_checkpoint_json LIKE ? AND (engine_session_id IS NULL OR engine_session_id = '' OR engine_session_id = ?)")
      .all(String(threadId), '%"assetExecutionAuthorization"%', engineSessionId ?? "") as Array<{ engine_session_id: string | null; engine_checkpoint_json: string }>;
    const result: OrchAssetExecutionAuthorization[] = [];
    for (const row of rows) {
      const checkpoint = parseEngineCheckpoint(row.engine_checkpoint_json, String(threadId));
      const raw = checkpoint.assetExecutionAuthorization;
      if (!Object.prototype.hasOwnProperty.call(checkpoint, "assetExecutionAuthorization")) continue;
      const binding = row.engine_session_id || checkpoint.assetExecutionEngineSessionId || null;
      if (binding && binding !== engineSessionId) continue;
      result.push(readOrchAssetExecutionAuthorization(raw));
    }
    return result;
  }

  /** 严格浅合并 checkpoint 根对象，保留其他引擎及历史扩展键。 */
  mergeEngineCheckpoint(turnId: TurnId, patch: Readonly<Record<string, unknown>>): string {
    assertCheckpointObject(patch, "checkpoint patch");
    const id = String(turnId ?? "").trim();
    if (!id) throw new Error("Invalid turnId for engine checkpoint merge");

    const row = this.db
      .prepare("SELECT engine_checkpoint_json FROM thread_turns WHERE turn_id = ?")
      .get(id) as { engine_checkpoint_json: string | null } | undefined;
    if (!row) throw new Error(`Turn not found for engine checkpoint merge: ${id}`);

    const current = parseEngineCheckpoint(row.engine_checkpoint_json, id);
    const merged = { ...current, ...patch };
    const serialized = JSON.stringify(merged);
    if (typeof serialized !== "string") throw new Error(`Engine checkpoint is not serializable: ${id}`);

    const result = this.db
      .prepare("UPDATE thread_turns SET engine_checkpoint_json = ? WHERE turn_id = ?")
      .run(serialized, id);
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`Engine checkpoint merge did not update turn: ${id}`);
    }
    return serialized;
  }

  /** 在 provider response 结算时耐久保存 attempt-scoped provisional 身份，不提升为权威 turn 映射。 */
  setCodexStartAttempt(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    clientUserMessageId: string;
    providerThreadId: SessionId;
    provisionalProviderTurnId: string;
    attemptId: number;
    observedAt: number;
  }): string {
    const clientUserMessageId = String(input.clientUserMessageId ?? "").trim();
    const providerThreadId = String(input.providerThreadId ?? "").trim() as SessionId;
    const provisionalProviderTurnId = String(input.provisionalProviderTurnId ?? "").trim();
    const attemptId = Number(input.attemptId ?? 0);
    const observedAt = Number(input.observedAt ?? 0);
    if (!clientUserMessageId) throw new Error(`Invalid Codex start clientUserMessageId for turn ${input.turnId}`);
    if (!providerThreadId) throw new Error(`Invalid Codex start providerThreadId for turn ${input.turnId}`);
    if (!provisionalProviderTurnId) throw new Error(`Invalid Codex provisional provider turnId for turn ${input.turnId}`);
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) throw new Error(`Invalid Codex start attemptId for turn ${input.turnId}`);
    if (!Number.isFinite(observedAt) || observedAt <= 0) throw new Error(`Invalid Codex start observedAt for turn ${input.turnId}`);

    const transaction = this.db.transaction(() => {
      const thread = this.db.prepare(
        "SELECT workspace_id, engine FROM threads WHERE id = ?",
      ).get(String(input.threadId)) as { workspace_id: string; engine: string } | undefined;
      if (!thread) throw new Error(`Thread not found for Codex start attempt: ${input.threadId}`);
      if (thread.workspace_id !== String(input.workspaceId) || thread.engine !== "codex") {
        throw new Error(`Codex start attempt thread scope mismatch: ${input.threadId}`);
      }

      this.insertStarted({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: "codex",
        turnId: input.turnId,
        startedAt: observedAt,
        startEventSeq: null,
      });
      let current = this.get(input.turnId);
      if (!current || current.threadId !== input.threadId || current.workspaceId !== input.workspaceId || current.engine !== "codex") {
        throw new Error(`Codex start attempt turn scope mismatch: ${input.turnId}`);
      }
      const currentClientUserMessageId = String(current.userItemId ?? "").trim();
      if (currentClientUserMessageId && currentClientUserMessageId !== clientUserMessageId) {
        throw new Error(
          `Codex start attempt clientUserMessageId mismatch: turnId=${input.turnId}, existing=${currentClientUserMessageId}, incoming=${clientUserMessageId}`,
        );
      }
      if (!currentClientUserMessageId) {
        const userItemUpdate = this.db.prepare(
          "UPDATE thread_turns SET user_item_id = ? WHERE turn_id = ? AND user_item_id IS NULL",
        ).run(clientUserMessageId, String(input.turnId));
        if (Number(userItemUpdate.changes ?? 0) !== 1) {
          throw new Error(`Codex start attempt lost userMessage CAS: ${input.turnId}`);
        }
        current = this.get(input.turnId)!;
      }

      const checkpoint = parseEngineCheckpoint(current.engineCheckpointJson, input.turnId);
      const existing = readCodexStartAttemptCheckpoint(checkpoint.codexStartAttempt, input.turnId);
      if (existing) {
        if (existing.clientUserMessageId !== clientUserMessageId) {
          throw new Error(`Codex start attempt ownership conflict: ${input.turnId}`);
        }
        if (attemptId < existing.attemptId) return String(current.engineCheckpointJson);
        if (attemptId === existing.attemptId) {
          if (
            existing.providerThreadId === providerThreadId
            && existing.provisionalProviderTurnId === provisionalProviderTurnId
          ) {
            return String(current.engineCheckpointJson);
          }
          throw new Error(`Codex start attempt settlement conflict: turnId=${input.turnId}, attemptId=${attemptId}`);
        }
      }

      const next: CodexStartAttemptCheckpoint = {
        v: 1,
        clientUserMessageId,
        providerThreadId,
        provisionalProviderTurnId,
        attemptId,
        observedAt,
      };
      const serialized = JSON.stringify({ ...checkpoint, codexStartAttempt: next });
      const result = this.db.prepare(
        "UPDATE thread_turns SET engine_checkpoint_json = ? WHERE turn_id = ? AND engine_checkpoint_json IS ?",
      ).run(serialized, String(input.turnId), current.engineCheckpointJson);
      if (Number(result.changes ?? 0) !== 1) {
        throw new Error(`Codex start attempt lost checkpoint CAS: ${input.turnId}`);
      }
      return serialized;
    });
    return transaction();
  }

  /** 严格读取未确权的 Codex start response；损坏 checkpoint 必须显式失败。 */
  getCodexStartAttempt(turnId: TurnId): CodexStartAttemptCheckpoint | null {
    const current = this.get(turnId);
    if (!current) return null;
    if (current.engine !== "codex") throw new Error(`Codex start attempt cannot target ${current.engine} turn: ${turnId}`);
    const checkpoint = parseEngineCheckpoint(current.engineCheckpointJson, turnId);
    return readCodexStartAttemptCheckpoint(checkpoint.codexStartAttempt, turnId);
  }

  /** 持久化本地 turn 到 Codex provider turn 的稳定映射；冲突时显式失败。 */
  setCodexProviderTurnId(
    turnId: TurnId,
    input: CodexProviderTurnMappingCandidate,
  ): string {
    const id = String(turnId ?? "").trim() as TurnId;
    const engineTurnId = String(input.engineTurnId ?? "").trim();
    const eventSeq = Number(input.eventSeq ?? 0);
    const observedAt = Number(input.observedAt ?? 0);
    const source = input.source;
    const engineSessionId = String(input.engineSessionId ?? "").trim() || null;
    const previousEngineTurnId = String(input.previousEngineTurnId ?? "").trim() || null;
    if (!id) throw new Error("Invalid turnId for Codex provider turn mapping");
    if (!engineTurnId) throw new Error(`Invalid Codex provider turnId for local turn ${id}`);
    if (source !== "turn.engineBound" && source !== "turn/started") throw new Error(`Invalid Codex provider mapping source for local turn ${id}`);
    if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0) throw new Error(`Invalid Codex provider event seq for local turn ${id}`);
    if (!Number.isFinite(observedAt) || observedAt <= 0) throw new Error(`Invalid Codex provider observedAt for local turn ${id}`);

    const current = this.get(id);
    if (!current) throw new Error(`Turn not found for Codex provider mapping: ${id}`);
    if (current.engine !== "codex") throw new Error(`Codex provider mapping cannot target ${current.engine} turn: ${id}`);
    const checkpoint = parseEngineCheckpoint(current.engineCheckpointJson, id);
    const existing = checkpoint.codexProviderTurn;
    if (existing != null) {
      assertCheckpointObject(existing, `codexProviderTurn for turn ${id}`);
      const existingVersion = Number(existing.v ?? 0);
      const existingSource = String(existing.source ?? "").trim();
      const existingTurnId = String(existing.engineTurnId ?? "").trim();
      const existingSessionId = String(existing.engineSessionId ?? "").trim() || null;
      const existingPreviousTurnId = String(existing.previousEngineTurnId ?? "").trim() || null;
      const existingSupersededTurnIds = normalizeSupersededProviderTurnIds(
        existing.supersededEngineTurnIds,
        existingTurnId,
        id,
      );
      const existingEventSeq = Number(existing.eventSeq ?? 0);
      const existingObservedAt = Number(existing.observedAt ?? 0);
      if (
        existingVersion !== 1
        || (existingSource !== "turn.engineBound" && existingSource !== "turn/started")
        || !existingTurnId
        || !Number.isSafeInteger(existingEventSeq)
        || existingEventSeq <= 0
        || !Number.isFinite(existingObservedAt)
        || existingObservedAt <= 0
      ) {
        throw new Error(`Invalid codexProviderTurn checkpoint for turn ${id}`);
      }
      if (
        existingSessionId
        && (
          (engineSessionId != null && engineSessionId !== existingSessionId)
          || (source === "turn.engineBound" && engineSessionId == null)
        )
      ) {
        throw createCodexProviderTurnMappingConflictError(
          `Codex provider checkpoint session mismatch for local turn ${id}: existing=${existingSessionId}, incoming=${engineSessionId ?? "missing"}`,
          {
            kind: "session_mismatch",
            clientTurnId: id,
            existingSessionId,
            incomingSessionId: engineSessionId,
            existingProviderTurnId: existingTurnId,
            incomingProviderTurnId: engineTurnId,
          },
        );
      }
      const hasCanonicalSessionProof = Boolean(
        (existingSource === "turn.engineBound" && existingSessionId)
        || (source === "turn.engineBound" && engineSessionId),
      );
      const decision = decideCodexProviderTurnMapping({
        engineTurnId: existingTurnId,
        engineSessionId: existingSessionId,
        previousEngineTurnId: existingPreviousTurnId,
        supersededEngineTurnIds: existingSupersededTurnIds,
        source: existingSource as "turn.engineBound" | "turn/started",
        eventSeq: existingEventSeq,
        observedAt: existingObservedAt,
      }, {
        engineTurnId,
        engineSessionId,
        previousEngineTurnId,
        supersededEngineTurnIds: input.supersededEngineTurnIds,
        source,
        eventSeq,
        observedAt,
      });
      if (decision.action === "keep") {
        const verifiedSessionId = (existingSessionId ?? engineSessionId) as SessionId | null;
        if (verifiedSessionId) {
          this.reconcileCodexProviderSessionId(id, verifiedSessionId, {
            allowCanonicalRepair: hasCanonicalSessionProof,
            existingProviderTurnId: existingTurnId,
            incomingProviderTurnId: engineTurnId,
          });
        }
        return String(current.engineCheckpointJson);
      }
      if (decision.action === "conflict") {
        throw createCodexProviderTurnMappingConflictError(
          `Codex provider turn mapping conflict for local turn ${id}: existing=${existingTurnId}, incoming=${engineTurnId}`,
          {
            kind: previousEngineTurnId ? "lineage_conflict" : "turn_mismatch",
            clientTurnId: id,
            existingSessionId,
            incomingSessionId: engineSessionId,
            existingProviderTurnId: existingTurnId,
            incomingProviderTurnId: engineTurnId,
          },
        );
      }
      const verifiedSessionId = String(decision.mapping.engineSessionId ?? "").trim() as SessionId;
      return this.persistCodexProviderMapping(id, decision.mapping, verifiedSessionId || null, {
        allowCanonicalRepair: hasCanonicalSessionProof,
        existingProviderTurnId: existingTurnId,
        incomingProviderTurnId: engineTurnId,
      });
    }

    const decision = decideCodexProviderTurnMapping(null, {
      engineTurnId,
      engineSessionId,
      previousEngineTurnId,
      supersededEngineTurnIds: input.supersededEngineTurnIds,
      source,
      eventSeq,
      observedAt,
    });
    if (decision.action !== "replace") {
      throw createCodexProviderTurnMappingConflictError(
        `Invalid initial Codex provider mapping for local turn ${id}`,
        {
          kind: "lineage_conflict",
          clientTurnId: id,
          existingSessionId: current.engineSessionId,
          incomingSessionId: engineSessionId,
          existingProviderTurnId: null,
          incomingProviderTurnId: engineTurnId,
        },
      );
    }
    const verifiedSessionId = String(decision.mapping.engineSessionId ?? "").trim() as SessionId;
    return this.persistCodexProviderMapping(id, decision.mapping, verifiedSessionId || null, {
      allowCanonicalRepair: source === "turn.engineBound" && Boolean(engineSessionId),
      existingProviderTurnId: null,
      incomingProviderTurnId: engineTurnId,
    });
  }

  /** 原子写入 provider checkpoint，并仅用 canonical turn.engineBound 修复旧的 thread 级误回填。 */
  private persistCodexProviderMapping(
    turnId: TurnId,
    mapping: CodexProviderTurnMappingCandidate,
    verifiedSessionId: SessionId | null,
    opts: {
      allowCanonicalRepair: boolean;
      existingProviderTurnId: string | null;
      incomingProviderTurnId: string;
    },
  ): string {
    const tx = this.db.transaction(() => {
      const serialized = this.mergeEngineCheckpoint(turnId, { codexProviderTurn: { v: 1, ...mapping } });
      if (verifiedSessionId) {
        this.reconcileCodexProviderSessionId(turnId, verifiedSessionId, opts);
      }
      return serialized;
    });
    return tx();
  }

  /** turn.engineBound 是 turn 级权威证据；没有 canonical 证明时仍保持 fail-closed。 */
  private reconcileCodexProviderSessionId(
    turnId: TurnId,
    verifiedSessionId: SessionId,
    opts: {
      allowCanonicalRepair: boolean;
      existingProviderTurnId: string | null;
      incomingProviderTurnId: string;
    },
  ): void {
    const current = this.get(turnId);
    if (!current) throw new Error(`Turn not found for engine session reconciliation: ${turnId}`);
    const existingSessionId = String(current.engineSessionId ?? "").trim();
    const expectedSessionId = String(verifiedSessionId ?? "").trim();
    if (!expectedSessionId) throw new Error(`Invalid engine sessionId for turn ${turnId}`);
    if (!existingSessionId) {
      this.backfillEngineSessionId(turnId, verifiedSessionId);
      return;
    }
    if (existingSessionId === expectedSessionId) return;
    if (!opts.allowCanonicalRepair) {
      throw createCodexProviderTurnMappingConflictError(
        `Codex provider session mismatch for local turn ${turnId}: turn=${existingSessionId}, incoming=${expectedSessionId}`,
        {
          kind: "session_mismatch",
          clientTurnId: String(turnId),
          existingSessionId,
          incomingSessionId: expectedSessionId,
          existingProviderTurnId: opts.existingProviderTurnId,
          incomingProviderTurnId: opts.incomingProviderTurnId,
        },
      );
    }
    const result = this.db
      .prepare("UPDATE thread_turns SET engine_session_id = ? WHERE turn_id = ? AND engine_session_id = ?")
      .run(expectedSessionId, String(turnId), existingSessionId);
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`Codex provider session repair lost compare-and-set ownership for local turn ${turnId}`);
    }
  }

  /** 获取 turn 记录。 */
  get(turnId: TurnId): ThreadTurnRecord | null {
    const row = this.db
      .prepare(
        [
          "SELECT thread_id, turn_id, workspace_id, engine, engine_session_id, status, started_at, ended_at, start_event_seq, end_event_seq, user_item_id, user_text, engine_checkpoint_json",
          "FROM thread_turns WHERE turn_id = ?",
        ].join("\n"),
      )
      .get(String(turnId)) as
      | {
          thread_id: string;
          turn_id: string;
          workspace_id: string;
          engine: string;
          engine_session_id: string | null;
          status: string;
          started_at: number;
          ended_at: number | null;
          start_event_seq: number | null;
          end_event_seq: number | null;
          user_item_id: string | null;
          user_text: string | null;
          engine_checkpoint_json: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      threadId: row.thread_id as ThreadId,
      turnId: row.turn_id as TurnId,
      workspaceId: row.workspace_id as WorkspaceId,
      engine: row.engine as EngineType,
      engineSessionId: row.engine_session_id ? (row.engine_session_id as SessionId) : null,
      status: row.status as ThreadTurnStatus,
      startedAt: Number(row.started_at ?? 0),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      startEventSeq: row.start_event_seq == null ? null : Number(row.start_event_seq),
      endEventSeq: row.end_event_seq == null ? null : Number(row.end_event_seq),
      userItemId: row.user_item_id ? (row.user_item_id as ItemId) : null,
      userText: row.user_text == null ? null : String(row.user_text),
      engineCheckpointJson: row.engine_checkpoint_json == null ? null : String(row.engine_checkpoint_json),
    };
  }

  /** 判断某 thread 是否已经出现过至少一次真实 turn。 */
  hasAnyByThread(threadId: ThreadId): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM thread_turns WHERE thread_id = ? LIMIT 1")
      .get(String(threadId)) as { 1?: number } | undefined;
    return Boolean(row);
  }

  /** 列出某 thread 的所有 turn（按 end_event_seq 升序；未结束的排末尾）。 */
  listByThread(threadId: ThreadId): ThreadTurnRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT thread_id, turn_id, workspace_id, engine, engine_session_id, status, started_at, ended_at, start_event_seq, end_event_seq, user_item_id, user_text, engine_checkpoint_json",
          "FROM thread_turns WHERE thread_id = ?",
          "ORDER BY (end_event_seq IS NULL) ASC, end_event_seq ASC, started_at ASC",
        ].join("\n"),
      )
      .all(String(threadId)) as Array<{
      thread_id: string;
      turn_id: string;
      workspace_id: string;
      engine: string;
      engine_session_id: string | null;
      status: string;
      started_at: number;
      ended_at: number | null;
      start_event_seq: number | null;
      end_event_seq: number | null;
      user_item_id: string | null;
      user_text: string | null;
      engine_checkpoint_json: string | null;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id as ThreadId,
      turnId: row.turn_id as TurnId,
      workspaceId: row.workspace_id as WorkspaceId,
      engine: row.engine as EngineType,
      engineSessionId: row.engine_session_id ? (row.engine_session_id as SessionId) : null,
      status: row.status as ThreadTurnStatus,
      startedAt: Number(row.started_at ?? 0),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      startEventSeq: row.start_event_seq == null ? null : Number(row.start_event_seq),
      endEventSeq: row.end_event_seq == null ? null : Number(row.end_event_seq),
      userItemId: row.user_item_id ? (row.user_item_id as ItemId) : null,
      userText: row.user_text == null ? null : String(row.user_text),
      engineCheckpointJson: row.engine_checkpoint_json == null ? null : String(row.engine_checkpoint_json),
    }));
  }

  /** 读取某 workspace 下仍在运行中的 turns。 */
  listRunningByWorkspace(workspaceId: WorkspaceId): Record<string, { runningTurnId: TurnId; runningTurnStartedAt: number }> {
    const rows = this.db
      .prepare(
        [
          "SELECT thread_id, turn_id, started_at",
          "FROM thread_turns",
          "WHERE workspace_id = ? AND status = 'started' AND ended_at IS NULL",
          "ORDER BY started_at DESC, turn_id DESC",
        ].join("\n"),
      )
      .all(String(workspaceId)) as Array<{
      thread_id: string;
      turn_id: string;
      started_at: number;
    }>;

    const out: Record<string, { runningTurnId: TurnId; runningTurnStartedAt: number }> = {};
    for (const row of rows) {
      const threadId = String(row.thread_id ?? "").trim();
      const turnId = String(row.turn_id ?? "").trim();
      const startedAt = Number(row.started_at ?? 0);
      if (!threadId || !turnId || !Number.isFinite(startedAt) || startedAt <= 0) continue;
      if (out[threadId]) continue;
      out[threadId] = {
        runningTurnId: turnId as TurnId,
        runningTurnStartedAt: startedAt,
      };
    }
    return out;
  }

  listRunning(): ThreadTurnRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT thread_id, turn_id, workspace_id, engine, engine_session_id, status, started_at, ended_at, start_event_seq, end_event_seq, user_item_id, user_text, engine_checkpoint_json",
          "FROM thread_turns",
          "WHERE status = 'started' AND ended_at IS NULL",
          "ORDER BY started_at ASC, turn_id ASC",
        ].join("\n"),
      )
      .all() as Array<{
      thread_id: string;
      turn_id: string;
      workspace_id: string;
      engine: string;
      engine_session_id: string | null;
      status: string;
      started_at: number;
      ended_at: number | null;
      start_event_seq: number | null;
      end_event_seq: number | null;
      user_item_id: string | null;
      user_text: string | null;
      engine_checkpoint_json: string | null;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id as ThreadId,
      turnId: row.turn_id as TurnId,
      workspaceId: row.workspace_id as WorkspaceId,
      engine: row.engine as EngineType,
      engineSessionId: row.engine_session_id ? (row.engine_session_id as SessionId) : null,
      status: row.status as ThreadTurnStatus,
      startedAt: Number(row.started_at ?? 0),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      startEventSeq: row.start_event_seq == null ? null : Number(row.start_event_seq),
      endEventSeq: row.end_event_seq == null ? null : Number(row.end_event_seq),
      userItemId: row.user_item_id ? (row.user_item_id as ItemId) : null,
      userText: row.user_text == null ? null : String(row.user_text),
      engineCheckpointJson: row.engine_checkpoint_json == null ? null : String(row.engine_checkpoint_json),
    }));
  }

  /** 删除某 thread 在某 turn 之后的 turn 记录（包含边界以外，不含边界）。 */
  deleteAfterEndSeq(threadId: ThreadId, endSeqInclusive: number): number {
    const res = this.db
      .prepare("DELETE FROM thread_turns WHERE thread_id = ? AND end_event_seq IS NOT NULL AND end_event_seq > ?")
      .run(String(threadId), Number(endSeqInclusive));
    return Number(res.changes ?? 0);
  }
}

/** 严格读取 checkpoint 中的 replacement 祖先链。 */
function normalizeSupersededProviderTurnIds(raw: unknown, currentTurnId: string, localTurnId: TurnId): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`Invalid codexProviderTurn lineage for turn ${localTurnId}`);
  const values = raw.map((value) => String(value ?? "").trim());
  if (values.some((value) => !value || value === currentTurnId) || new Set(values).size !== values.length) {
    throw new Error(`Invalid codexProviderTurn lineage for turn ${localTurnId}`);
  }
  return values;
}

/** 严格读取 ACK 前保存的 turn/start response，禁止损坏证据参与恢复。 */
function readCodexStartAttemptCheckpoint(raw: unknown, turnId: TurnId): CodexStartAttemptCheckpoint | null {
  if (raw == null) return null;
  assertCheckpointObject(raw, `codexStartAttempt for turn ${turnId}`);
  const clientUserMessageId = String(raw.clientUserMessageId ?? "").trim();
  const providerThreadId = String(raw.providerThreadId ?? "").trim() as SessionId;
  const provisionalProviderTurnId = String(raw.provisionalProviderTurnId ?? "").trim();
  const attemptId = Number(raw.attemptId ?? 0);
  const observedAt = Number(raw.observedAt ?? 0);
  if (
    Number(raw.v) !== 1
    || !clientUserMessageId
    || !providerThreadId
    || !provisionalProviderTurnId
    || !Number.isSafeInteger(attemptId)
    || attemptId <= 0
    || !Number.isFinite(observedAt)
    || observedAt <= 0
  ) {
    throw new Error(`Invalid codexStartAttempt checkpoint for turn ${turnId}`);
  }
  return {
    v: 1,
    clientUserMessageId,
    providerThreadId,
    provisionalProviderTurnId,
    attemptId,
    observedAt,
  };
}

/** 解析已有 checkpoint；损坏或非对象数据必须显式失败。 */
function parseEngineCheckpoint(raw: string | null, turnId: string): Record<string, unknown> {
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid engine checkpoint JSON for turn ${turnId}: ${message}`);
  }
  assertCheckpointObject(parsed, `engine checkpoint for turn ${turnId}`);
  return parsed;
}

/** checkpoint 根值仅允许普通 JSON 对象，禁止数组、null 和标量。 */
function assertCheckpointObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
}

