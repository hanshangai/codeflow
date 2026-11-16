import type { RawEngineEventEnvelope, TurnId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import {
  decideCodexProviderTurnMapping,
  type CodexProviderTurnMappingCandidate,
} from "../db/repos/codexProviderTurnMapping.js";

export type CodexProviderTurnIndexRuntime = {
  pendingCodexProviderTurnByClientTurnId: Map<TurnId, CodexProviderTurnMappingCandidate>;
};

export type CodexProviderTurnStartedIndexResult =
  | { kind: "ignored"; reason: "not_codex_turn_started" }
  | {
      kind: "ignored";
      reason: "missing_client_turn_id";
      providerTurnId: string | null;
    }
  | {
      kind: "mapped";
      clientTurnId: TurnId;
      providerTurnId: string;
      localTurnStatus: "started" | "completed" | "error" | "pending";
    };

/** 仅将携带显式 clientTurnId 的 raw turn/started 映射到对应本地 turn。 */
export function indexCodexProviderTurnStarted(
  ctx: { db: ClientDb; runtime: CodexProviderTurnIndexRuntime },
  event: RawEngineEventEnvelope,
): CodexProviderTurnStartedIndexResult {
  if (event.engine !== "codex" || event.source !== "codex.app-server.msg") {
    return { kind: "ignored", reason: "not_codex_turn_started" };
  }
  const message = event.data as any;
  if (String(message?.method ?? "") !== "turn/started") {
    return { kind: "ignored", reason: "not_codex_turn_started" };
  }
  const providerTurnId = String(message?.params?.turn?.id ?? message?.params?.turnId ?? "").trim();
  const clientTurnId = String(event.clientTurnId ?? "").trim() as TurnId;
  if (!clientTurnId) {
    return {
      kind: "ignored",
      reason: "missing_client_turn_id",
      providerTurnId: providerTurnId || null,
    };
  }
  if (!providerTurnId) {
    throw new Error(
      `Codex turn/started 缺少 provider turnId：threadId=${event.threadId}, clientTurnId=${clientTurnId}, eventSeq=${event.seq}`,
    );
  }

  const localTurn = ctx.db.turns.get(clientTurnId);
  if (
    localTurn
    && (
      localTurn.workspaceId !== event.workspaceId
      || localTurn.threadId !== event.threadId
      || localTurn.engine !== "codex"
    )
  ) {
    throw new Error(`Codex turn/started 本地关联冲突：threadId=${event.threadId}, turnId=${clientTurnId}`);
  }

  persistOrStageCodexProviderTurn(ctx, clientTurnId, {
    engineTurnId: providerTurnId,
    source: "turn/started",
    eventSeq: Number(event.seq ?? 0),
    observedAt: Number(event.ts ?? Date.now()),
  });
  return {
    kind: "mapped",
    clientTurnId,
    providerTurnId,
    localTurnStatus: localTurn?.status ?? "pending",
  };
}

/** turn 行未落库时暂存映射；已落库时沿用仓储的权威冲突判定。 */
export function persistOrStageCodexProviderTurn(
  ctx: { db: ClientDb; runtime: CodexProviderTurnIndexRuntime },
  turnId: TurnId,
  incoming: CodexProviderTurnMappingCandidate,
): void {
  if (ctx.db.turns.get(turnId)) {
    ctx.db.turns.setCodexProviderTurnId(turnId, incoming);
    return;
  }
  const current = ctx.runtime.pendingCodexProviderTurnByClientTurnId.get(turnId) ?? null;
  const decision = decideCodexProviderTurnMapping(current, incoming);
  if (decision.action === "keep") return;
  if (decision.action === "replace") {
    ctx.runtime.pendingCodexProviderTurnByClientTurnId.set(turnId, decision.mapping);
    return;
  }
  throw new Error(
    `Codex pending provider turn 映射冲突：turnId=${turnId}, existing=${current?.engineTurnId ?? "missing"}, incoming=${incoming.engineTurnId}`,
  );
}
