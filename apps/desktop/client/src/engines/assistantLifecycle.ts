import type {
  AssistantCompletionSource,
  AssistantMessagePhase,
  ConversationEventInput,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";

export type AssistantLifecycleRecord = {
  itemId: string;
  engineMessageId: string;
  turnId: TurnId;
  text: string;
  revision: number;
  phase?: AssistantMessagePhase;
  completed: boolean;
  completionSource?: AssistantCompletionSource;
  updatedAtSeq: number;
};

function normalizeAssistantMessagePhase(raw: unknown): AssistantMessagePhase | undefined {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "commentary") return "commentary";
  if (normalized === "final_answer" || normalized === "final-answer" || normalized === "finalanswer") return "final_answer";
  if (normalized === "structured_result" || normalized === "structured-result" || normalized === "structuredresult") {
    return "structured_result";
  }
  return undefined;
}

export { normalizeAssistantMessagePhase };

export class AssistantLifecycleTracker {
  private readonly items = new Map<string, AssistantLifecycleRecord>();
  private activeTurnId: TurnId | null = null;
  private readonly retiredTurnIds = new Set<TurnId>();
  private nextUpdateSeq = 1;

  startTurn(turnId: TurnId): void {
    this.items.clear();
    this.retiredTurnIds.clear();
    this.activeTurnId = turnId;
    this.nextUpdateSeq = 1;
  }

  clear(): void {
    this.items.clear();
    this.retiredTurnIds.clear();
    this.activeTurnId = null;
    this.nextUpdateSeq = 1;
  }

  activeTurn(): TurnId | null {
    return this.activeTurnId;
  }

  retireTurn(turnId: TurnId): void {
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
    }
    this.retiredTurnIds.add(turnId);
  }

  isTurnRetired(turnId: TurnId): boolean {
    return this.retiredTurnIds.has(turnId);
  }

  ensureStarted(input: {
    itemId: string;
    engineMessageId: string;
    turnId: TurnId;
    phase?: AssistantMessagePhase;
  }): AssistantLifecycleRecord {
    const existing = this.items.get(input.itemId);
    if (existing) {
      if (input.phase && !existing.completed && assistantPhasePriority(input.phase) >= assistantPhasePriority(existing.phase)) {
        existing.phase = input.phase;
      }
      return existing;
    }
    const created: AssistantLifecycleRecord = {
      itemId: input.itemId,
      engineMessageId: input.engineMessageId,
      turnId: input.turnId,
      text: "",
      revision: 0,
      phase: input.phase,
      completed: false,
      updatedAtSeq: this.bumpUpdateSeq(),
    };
    this.items.set(input.itemId, created);
    return created;
  }

  appendDelta(itemId: string, delta: string): AssistantLifecycleRecord | null {
    const record = this.items.get(itemId) ?? null;
    if (!record) return null;
    if (record.completed) return null;
    record.text += delta;
    record.updatedAtSeq = this.bumpUpdateSeq();
    return record;
  }

  applySnapshot(input: {
    itemId: string;
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
  }): AssistantLifecycleRecord | null {
    const record = this.items.get(input.itemId) ?? null;
    if (!record) return null;
    if (record.completed) return null;
    record.text = input.text;
    record.revision = input.revision;
    if (input.phase) record.phase = input.phase;
    record.updatedAtSeq = this.bumpUpdateSeq();
    return record;
  }

  markCompleted(input: {
    itemId: string;
    text?: string;
    revision?: number;
    phase?: AssistantMessagePhase;
    completionSource: AssistantCompletionSource;
  }): AssistantLifecycleRecord | null {
    const record = this.items.get(input.itemId) ?? null;
    if (!record) return null;
    const wasCompleted = record.completed;
    const currentRevision = record.revision;
    const currentPhasePriority = assistantPhasePriority(record.phase);
    const nextPhasePriority = assistantPhasePriority(input.phase);
    const shouldUpdateText = input.text != null && (!record.completed || input.text !== record.text);
    const shouldUpdateRevision = typeof input.revision === "number" && input.revision > record.revision;
    const shouldUpdatePhase = Boolean(input.phase) && (
      !record.phase
      || nextPhasePriority > currentPhasePriority
      || (!record.completed && nextPhasePriority >= currentPhasePriority)
    );
    const shouldUpdateSource = completionSourcePriority(input.completionSource) > completionSourcePriority(record.completionSource);
    if (!shouldUpdateText && !shouldUpdateRevision && !shouldUpdatePhase && !shouldUpdateSource && wasCompleted) {
      return record;
    }
    if (shouldUpdateText) {
      record.text = input.text as string;
    }
    if (typeof input.revision === "number" && (shouldUpdateRevision || !wasCompleted)) {
      record.revision = input.revision;
    }
    if (shouldUpdatePhase) {
      record.phase = input.phase;
    }
    record.completed = true;
    if (shouldUpdateSource || !record.completionSource) {
      record.completionSource = input.completionSource;
    }
    if (!wasCompleted || shouldUpdateText || shouldUpdateRevision || shouldUpdatePhase || shouldUpdateSource || currentRevision !== record.revision) {
      record.updatedAtSeq = this.bumpUpdateSeq();
    }
    return record;
  }

  ensureCompleted(input: {
    itemId: string;
    engineMessageId: string;
    turnId: TurnId;
    text: string;
    revision: number;
    phase?: AssistantMessagePhase;
    completionSource: AssistantCompletionSource;
  }): AssistantLifecycleRecord {
    const existing = this.items.get(input.itemId);
    if (!existing) {
      this.items.set(input.itemId, {
        itemId: input.itemId,
        engineMessageId: input.engineMessageId,
        turnId: input.turnId,
        text: "",
        revision: 0,
        phase: input.phase,
        completed: false,
        updatedAtSeq: 0,
      });
    } else {
      existing.engineMessageId = input.engineMessageId;
      existing.turnId = input.turnId;
    }
    return this.markCompleted({
      itemId: input.itemId,
      text: input.text,
      revision: input.revision,
      phase: input.phase,
      completionSource: input.completionSource,
    }) as AssistantLifecycleRecord;
  }

  get(itemId: string): AssistantLifecycleRecord | null {
    return this.items.get(itemId) ?? null;
  }

  listByTurn(turnId: TurnId): AssistantLifecycleRecord[] {
    return [...this.items.values()].filter((item) => item.turnId === turnId);
  }

  listPendingTerminalization(turnId: TurnId): AssistantLifecycleRecord[] {
    return this.listByTurn(turnId).filter((item) => !item.completed && item.text.trim());
  }

  latestText(turnId: TurnId): string | null {
    const items = this.listByTurn(turnId).filter((item) => item.text.trim());
    if (!items.length) return null;
    const completed = items.filter((item) => item.completed);
    const pool = completed.length ? completed : items;
    const winner = pool.reduce((best, item) => {
      if (!best) return item;
      const bestPriority = assistantPhasePriority(best.phase);
      const itemPriority = assistantPhasePriority(item.phase);
      if (itemPriority !== bestPriority) {
        return itemPriority > bestPriority ? item : best;
      }
      return item.updatedAtSeq >= best.updatedAtSeq ? item : best;
    }, null as AssistantLifecycleRecord | null);
    const text = winner?.text?.trim() ?? "";
    return text || null;
  }

  private bumpUpdateSeq(): number {
    const current = this.nextUpdateSeq;
    this.nextUpdateSeq += 1;
    return current;
  }
}

function assistantPhasePriority(phase: AssistantMessagePhase | undefined): number {
  if (phase === "structured_result") return 4;
  if (phase === "final_answer") return 3;
  if (phase === "commentary") return 1;
  return 2;
}

function completionSourcePriority(source: AssistantCompletionSource | undefined): number {
  if (source === "synthetic_structured_result") return 4;
  if (source === "snapshot_reconcile") return 3;
  if (source === "provider") return 2;
  if (source === "runtime_close_reconcile") return 1;
  return 0;
}

export function buildAssistantCompletedEvent(input: {
  workspaceId: WorkspaceId;
  threadId: string;
  engine: "claude" | "codex";
  itemId: string;
  engineMessageId: string;
  turnId?: TurnId;
  text: string;
  revision: number;
  phase?: AssistantMessagePhase;
  completionSource: AssistantCompletionSource;
  structuredPayloadJson?: string | null;
}): ConversationEventInput {
  return {
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId as any,
    engine: input.engine,
    type: "item.agentMessage.completed",
    payload: {
      itemId: input.itemId as any,
      engineMessageId: input.engineMessageId,
      turnId: input.turnId,
      text: input.text,
      revision: input.revision,
      phase: input.phase,
      completionSource: input.completionSource,
      structuredPayloadJson: input.structuredPayloadJson ?? null,
    },
  };
}
