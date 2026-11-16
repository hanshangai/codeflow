import crypto from "node:crypto";
import type { ClientToServerMessage, ConversationRelayDelivery, ConversationRelayDemand, ConversationRelayReady, ConversationRelayScope, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import { conversationRelayScopeKey, type ConversationRelayInvalidation } from "../db/repos/eventRepo.js";

type Flight = { generation: number; scopeKey: string; delivery: ConversationRelayDelivery } & (
  | { kind: "events"; cursor: number; throughSeq: number; seqs: number[] }
  | { kind: "invalidation"; entry: ConversationRelayInvalidation }
);
type ActiveScope = { key: string; scope: ConversationRelayScope; demand: ConversationRelayDemand; readyThroughSeq: number };

/** SQL 是唯一待投递正文来源；最多一个在途请求，ACK 仅推进投递元数据。 */
export function createLocalEventRelay(input: {
  db: ClientDb;
  serverUrl: string;
  send(message: ClientToServerMessage): { accepted: boolean; reason?: string | null };
  batchSize?: number;
  ackTimeoutMs: number;
  withDatabase<T>(operation: () => T): Promise<T>;
  readReadyThroughSeq(workspaceId: WorkspaceId): Promise<number>;
  onError(error: Error, context: { generation: number; delivery: ConversationRelayDelivery }): void;
}) {
  if (!Number.isSafeInteger(input.ackTimeoutMs) || input.ackTimeoutMs <= 0) throw new Error("CONVERSATION_RELAY_ACK_TIMEOUT_INVALID");
  let generation: number | null = null;
  let scopes: ActiveScope[] = [];
  let authorized: ConversationRelayScope[] = [];
  const pendingDemands = new Map<string, ConversationRelayDemand>();
  const demandVersions = new Map<string, { demandId: string; generation: number; enabled: boolean }>();
  let flight: Flight | null = null;
  const batchSize = input.batchSize ?? 128;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let scheduled: ReturnType<typeof setImmediate> | null = null;
  let nextEventScopeIndex = 0;
  let scan: { scopes: typeof scopes; generation: number; pendingInvalidations: Set<ActiveScope>; start: number; index: number; rerun: boolean } | null = null;

  /** 取消尚未读取的批次；SQL 事实和在途 ACK 不受调度取消影响。 */
  const clearScheduled = (): void => {
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    scan = null;
  };

  /** 仅管理一个 ACK 等待，不改变耐久进度或在当前连接自行重试。 */
  const clearAckTimer = (): void => {
    if (ackTimer) clearTimeout(ackTimer);
    ackTimer = null;
  };
  /** 失联 ACK 显式失败交回连接边界，后续由既有重连入口恢复 SQL 待投递。 */
  const waitForAck = (expected: Flight): void => {
    if (flight !== expected) return;
    clearAckTimer();
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (flight !== expected) return;
      flight = null;
      scopes = [];
      input.onError(new Error("CONVERSATION_RELAY_ACK_TIMEOUT"), { generation: expected.generation, delivery: expected.delivery });
    }, input.ackTimeoutMs);
    ackTimer.unref?.();
  };

  /** 每次只读一个 scope 的短事务，复用唯一 flight 与 ACK 推进入口。 */
  const flushScope = async (active: ActiveScope, connectionGeneration: number, phase: "invalidation" | "events",
    delivery: ConversationRelayDelivery): Promise<boolean> => {
    const readyThroughSeq = await input.readReadyThroughSeq(active.scope.workspaceId);
    return input.withDatabase(() => {
      if (generation !== connectionGeneration || !scopes.includes(active) || flight) return false;
      const workspace = input.db.forWorkspace(active.scope.workspaceId, { readonly: true });
      let next: Flight;
      let message: ClientToServerMessage;
      if (phase === "invalidation") {
        const pending = workspace.db.transaction(() => workspace.conversationEvents.readRelayInvalidation(active.key))();
        if (!pending) return false;
        next = { kind: "invalidation", generation: connectionGeneration, scopeKey: active.key, delivery, entry: pending };
        message = { t: "thread.history.cleaned", ...pending, delivery };
      } else {
        const batch = workspace.db.transaction(() => workspace.conversationEvents.readRelayBatch(active.key, batchSize))();
        batch.throughSeq = Math.max(batch.cursor, Math.min(batch.throughSeq, readyThroughSeq));
        batch.events = batch.events.filter(event => event.seq <= batch.throughSeq);
        if (batch.throughSeq === batch.cursor) return false;
        next = { kind: "events", generation: connectionGeneration, scopeKey: active.key, delivery,
          cursor: batch.cursor, throughSeq: batch.throughSeq, seqs: batch.events.map(event => event.seq) };
        message = { t: "conversation.event.relay", events: batch.events, delivery };
      }
      flight = next;
      try {
        const result = input.send(message);
        if (!result.accepted) throw new Error(`CONVERSATION_RELAY_SEND_REJECTED: ${result.reason ?? "no reason"}`);
        // 跨 ACK 保留事件轮转位置；下一轮仍先检查所有范围的耐久删除屏障。
        if (phase === "events") nextEventScopeIndex = (scopes.indexOf(active) + 1) % scopes.length;
        waitForAck(next);
      } catch (cause) { flight = null; throw cause; }
      return true;
    });
  };

  /** 每批只查一个范围；新增屏障追加待查范围，保留其余范围进度并始终先于事件。 */
  const runScheduled = async (): Promise<void> => {
    const running = scheduled;
    const current = scan;
    if (!current || disposed || flight || current.scopes !== scopes || current.generation !== generation) {
      scan = null;
      if (scheduled === running) scheduled = null;
      return;
    }
    const invalidation = current.pendingInvalidations.values().next().value;
    const active = invalidation ?? current.scopes[(current.start + current.index) % current.scopes.length]!;
    if (invalidation) current.pendingInvalidations.delete(invalidation);
    const delivery = { deliveryId: crypto.randomUUID(), scope: active.scope, demandId: active.demand.demandId, generation: active.demand.generation };
    try {
      if (await flushScope(active, current.generation, invalidation ? "invalidation" : "events", delivery)) {
        if (scan === current) scan = null;
        if (scheduled === running) scheduled = null;
        return;
      }
    } catch (cause) {
      if (current.scopes === scopes && current.generation === generation) { clearScheduled(); scopes = []; }
      input.onError(cause instanceof Error ? cause : new Error("CONVERSATION_RELAY_SCAN_FAILED", { cause }),
        { generation: current.generation, delivery });
      return;
    }
    if (scan !== current || current.scopes !== scopes || generation !== current.generation) return;
    if (!invalidation) current.index++;
    if (current.index === current.scopes.length) {
      if (current.rerun) { current.pendingInvalidations = new Set(current.scopes); current.rerun = false; }
      else { scan = null; if (scheduled === running) scheduled = null; return; }
      current.index = 0;
    }
    scheduled = setImmediate(runScheduled);
  };

  return {
    /** 授权不访问 SQLite；撤销范围立即栅栏旧需求及其迟到回执。 */
    activate(authorizedScopes: ConversationRelayScope[], connectionGeneration: number): void {
      if (disposed) throw new Error("CONVERSATION_RELAY_DISPOSED");
      if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) throw new Error("CONVERSATION_RELAY_GENERATION_INVALID");
      if (generation !== null && connectionGeneration < generation) throw new Error("CONVERSATION_RELAY_STALE_ACTIVATION");
      const keys = authorizedScopes.map(value => conversationRelayScopeKey(input.serverUrl, value));
      if (new Set(keys).size !== keys.length) throw new Error("CONVERSATION_RELAY_DUPLICATE_SCOPE");
      if (generation !== connectionGeneration) demandVersions.clear();
      authorized = authorizedScopes.map(value => ({ ...value }));
      const matches = (value: ConversationRelayScope): boolean => authorized.some(scope => sameScope(scope, value));
      const next = generation === connectionGeneration ? scopes.filter(active => matches(active.scope)) : [];
      for (const [key, demand] of pendingDemands) {
        if (generation !== connectionGeneration || !matches(demand.scope)) pendingDemands.delete(key);
      }
      const currentFlight = flight;
      const currentScope = currentFlight?.delivery.scope;
      const keepFlight = currentFlight && currentFlight.generation === connectionGeneration
        && next.some(({ key, scope }) => key === currentFlight.scopeKey
          && (currentScope?.kind === "personal"
            ? scope.kind === "personal" && scope.workspaceId === currentScope.workspaceId
            : scope.kind !== "personal" && scope.hostScopeEpoch === currentScope?.hostScopeEpoch));
      const keepRotation = generation === connectionGeneration && next.length === scopes.length
        && next.every(({ key, scope }, index) => {
          const previous = scopes[index]!;
          return key === previous.key && (scope.kind === "personal"
            || previous.scope.kind !== "personal" && scope.hostScopeEpoch === previous.scope.hostScopeEpoch);
        });
      clearScheduled();
      scopes = next;
      if (!keepRotation) nextEventScopeIndex = 0;
      generation = connectionGeneration;
      if (!keepFlight) { flight = null; clearAckTimer(); }
    },

    /** 新需求在索引读屏障 H 安装增量游标；恢复旧授权不补传无人订阅期间历史。 */
    async setDemand(demand: ConversationRelayDemand, enabled: boolean, connectionGeneration: number): Promise<ConversationRelayReady | null> {
      if (disposed || generation !== connectionGeneration) throw new Error("CONVERSATION_RELAY_DEMAND_CONNECTION_STALE");
      const key = conversationRelayScopeKey(input.serverUrl, demand.scope);
      const existing = scopes.find(active => active.key === key);
      const previous = demandVersions.get(key);
      if (previous && (demand.generation < previous.generation || demand.generation === previous.generation
        && (demand.demandId !== previous.demandId || enabled && !previous.enabled))) return null;
      demandVersions.set(key, { demandId: demand.demandId, generation: demand.generation, enabled });
      if (!enabled) {
        if (pendingDemands.get(key)?.demandId === demand.demandId) pendingDemands.delete(key);
        if (existing?.demand.demandId === demand.demandId) {
          clearScheduled(); scopes = scopes.filter(active => active !== existing);
          if (flight?.delivery.demandId === demand.demandId) { flight = null; clearAckTimer(); }
        }
        return null;
      }
      if (!demand.demandId || !demand.requestId || !Number.isSafeInteger(demand.generation) || demand.generation < 1
        || !authorized.some(scope => sameScope(scope, demand.scope))) throw new Error("CONVERSATION_RELAY_DEMAND_FORBIDDEN");
      if (existing?.demand.demandId === demand.demandId) return { ...demand, ok: true, readyThroughSeq: existing.readyThroughSeq };
      pendingDemands.set(key, demand);
      const readyThroughSeq = await input.readReadyThroughSeq(demand.scope.workspaceId);
      if (!Number.isSafeInteger(readyThroughSeq) || readyThroughSeq < 0) throw new Error("CONVERSATION_RELAY_BASELINE_INVALID");
      return input.withDatabase(() => {
        if (disposed || generation !== connectionGeneration || pendingDemands.get(key) !== demand
          || !authorized.some(scope => sameScope(scope, demand.scope))) return null;
        const workspace = input.db.forWorkspace(demand.scope.workspaceId);
        workspace.conversationEvents.beginRelayDemand(input.serverUrl, demand.scope, readyThroughSeq);
        clearScheduled();
        if (flight?.scopeKey === key) { flight = null; clearAckTimer(); }
        scopes = [...scopes.filter(active => active.key !== key), { key, scope: { ...demand.scope }, demand, readyThroughSeq }];
        pendingDemands.delete(key);
        return { requestId: demand.requestId, demandId: demand.demandId, generation: demand.generation,
          scope: demand.scope, ok: true, readyThroughSeq };
      });
    },

    /** 关闭当前连接后只清内存在途状态，数据库进度与清理屏障保留。 */
    disconnect(connectionGeneration: number): void {
      if (generation !== connectionGeneration) return;
      clearScheduled();
      scopes = [];
      authorized = [];
      pendingDemands.clear();
      demandVersions.clear();
      flight = null;
      clearAckTimer();
    },

    /** 合并唤醒；清理仅补查当前授权范围，重复通知不重置未完成的检查。 */
    scheduleFlush(restart = false, invalidatedScopeKey?: string): void {
      if (disposed || generation === null || flight || scopes.length === 0) return;
      const invalidated = invalidatedScopeKey === undefined ? scopes : scopes.filter(scope => scope.key === invalidatedScopeKey);
      if (!invalidated.length) return;
      if (!scan) scan = { scopes, generation, pendingInvalidations: new Set(scopes), start: nextEventScopeIndex, index: 0, rerun: false };
      else if (restart) { for (const active of invalidated) scan.pendingInvalidations.add(active); }
      else scan.rerun = true;
      if (!scheduled) scheduled = setImmediate(runScheduled);
    },

    /** 显式检查也沿跨 ACK 轮转位置；生产唤醒使用 scheduleFlush，屏障均先于事件。 */
    async flush(): Promise<void> {
      clearScheduled();
      if (disposed || generation === null || flight || scopes.length === 0) return;
      for (const phase of ["invalidation", "events"] as const) {
        for (let index = 0; index < scopes.length; index++) {
          const active = scopes[(phase === "events" ? nextEventScopeIndex + index : index) % scopes.length]!;
          if (await flushScope(active, generation, phase, { deliveryId: crypto.randomUUID(), scope: active.scope,
            demandId: active.demand.demandId, generation: active.demand.generation })) return;
        }
      }
    },

    /** 迟到或其他连接 ACK 返回未匹配；匹配请求的非法/不完整 ACK 必须显式失败。 */
    async acceptAck(message: unknown, connectionGeneration: number): Promise<boolean> {
      return input.withDatabase(() => {
        if (!flight || generation !== connectionGeneration || flight.generation !== connectionGeneration) return false;
        const ack = message as { t?: unknown; delivery?: ConversationRelayDelivery; seqs?: unknown;
          invalidationId?: unknown; workspaceId?: unknown; threadId?: unknown; throughSeq?: unknown } | null;
        if (!ack || ack.delivery?.deliveryId !== flight.delivery.deliveryId) return false;
        if (ack.delivery.demandId !== flight.delivery.demandId || ack.delivery.generation !== flight.delivery.generation) return false;
        const expected = flight.delivery.scope;
        const actual = ack.delivery.scope;
        if (!actual || Object.keys(expected).some((key) => actual[key as keyof ConversationRelayScope] !== expected[key as keyof ConversationRelayScope])) return false;
        if (flight.kind === "events") {
          if (ack.t !== "conversation.eventRelayAck") throw new Error("CONVERSATION_RELAY_ACK_TYPE_INVALID");
          const expectedSeqs = flight.seqs;
          if (!Array.isArray(ack.seqs) || ack.seqs.length !== flight.seqs.length
            || ack.seqs.some((seq, index) => !Number.isSafeInteger(seq) || seq !== expectedSeqs[index])) {
            throw new Error("CONVERSATION_RELAY_ACK_INCOMPLETE");
          }
          input.db.forWorkspace(expected.workspaceId).conversationEvents.advanceRelayCursor(flight.scopeKey, flight.cursor, flight.throughSeq);
        } else {
          if (ack.t !== "thread.history.cleanedAck") throw new Error("CONVERSATION_RELAY_ACK_TYPE_INVALID");
          const entry = flight.entry;
          if (ack.invalidationId !== entry.invalidationId || ack.workspaceId !== entry.workspaceId
            || ack.threadId !== entry.threadId || ack.throughSeq !== entry.throughSeq) throw new Error("CONVERSATION_RELAY_INVALIDATION_ACK_INVALID");
          const workspace = input.db.forWorkspace(expected.workspaceId);
          const scopeKey = flight.scopeKey;
          workspace.db.transaction(() => {
            // 本次在途 ACK 已匹配；更新的删除屏障保留，下一次 flush 继续投递。
            workspace.conversationEvents.acknowledgeRelayInvalidation(scopeKey, entry.invalidationId);
          })();
        }
        flight = null;
        clearAckTimer();
        return true;
      });
    },

    /** 停止入口及唯一 ACK 等待；待投递事实继续留在 SQL。 */
    dispose(): void {
      disposed = true;
      clearScheduled();
      clearAckTimer();
      flight = null;
      scopes = [];
      authorized = [];
      pendingDemands.clear();
      demandVersions.clear();
    },
  };
}

/** 比较完整身份与 Host epoch，稳定存储键不能替代当前授权校验。 */
function sameScope(a: ConversationRelayScope, b: ConversationRelayScope): boolean {
  return Object.keys(a).every(key => a[key as keyof ConversationRelayScope] === b[key as keyof ConversationRelayScope])
    && Object.keys(b).every(key => a[key as keyof ConversationRelayScope] === b[key as keyof ConversationRelayScope]);
}
