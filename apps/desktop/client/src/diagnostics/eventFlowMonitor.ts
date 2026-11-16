type EventFlowBucket = {
  stage: "outbound" | "ack";
  wsType: string;
  threadId: string | null;
  clientTurnId: string | null;
  providerMethod: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  canonicalType: string | null;
  providerCorrelation: "mapped" | "unmapped";
  messages: number;
  bytes: number;
};

export type EventFlowSnapshot = {
  reason: "interval" | "threshold" | "disconnect" | "dispose" | "manual";
  startedAt: number;
  durationMs: number;
  messages: number;
  bytes: number;
  outboundRawEvents: number;
  outboundCanonicalEvents: number;
  rawAcks: number;
  canonicalAcks: number;
  uniqueRawAckSeqs: number;
  duplicateRawAckSeqs: number;
  uniqueCanonicalAckSeqs: number;
  duplicateCanonicalAckSeqs: number;
  mappedProviderAcks: number;
  unmappedProviderEvents: number;
  providerSeqConflicts: number;
  disconnects: number;
  reconnects: number;
  pendingEvidenceFramesAtDisconnect: number;
  buckets: EventFlowBucket[];
};

type EventFlowState = {
  startedAt: number;
  messages: number;
  bytes: number;
  outboundRawEvents: number;
  outboundCanonicalEvents: number;
  rawAcks: number;
  canonicalAcks: number;
  duplicateRawAckSeqs: number;
  duplicateCanonicalAckSeqs: number;
  mappedProviderAcks: number;
  unmappedProviderEvents: number;
  providerSeqConflicts: number;
  disconnects: number;
  reconnects: number;
  pendingEvidenceFramesAtDisconnect: number;
  buckets: Map<string, EventFlowBucket>;
  rawAckSeqs: Set<number>;
  canonicalAckSeqs: Set<number>;
  providerSeqById: Map<string, number>;
};

const DEFAULT_WINDOW_MS = 15_000;
const DEFAULT_MESSAGE_THRESHOLD = 5_000;
const MAX_BUCKETS = 256;

/** 聚合 provider→raw/canonical→WS→ACK 计数，不改变事件内容或发送顺序。 */
export function createEventFlowMonitor(opts: {
  windowMs?: number;
  messageThreshold?: number;
  onFlush: (snapshot: EventFlowSnapshot) => void;
}) {
  const windowMs = normalizePositiveInteger(opts.windowMs, DEFAULT_WINDOW_MS);
  const messageThreshold = normalizePositiveInteger(opts.messageThreshold, DEFAULT_MESSAGE_THRESHOLD);
  let disposed = false;
  let state = createState(Date.now());
  const timer = setInterval(() => flush("interval"), windowMs);
  timer.unref?.();

  /** 记录 Client 发往 Server 的 raw/canonical 事件。 */
  function recordOutbound(message: unknown, bytes: number): void {
    if (disposed) return;
    const record = readEventFlowRecord(message, "outbound");
    if (!record) return;
    addRecord(record, bytes);
  }

  /** 记录 Server 返回的 raw/canonical ACK，并检查 seq 重复或映射冲突。 */
  function recordAck(message: unknown, bytes: number): void {
    if (disposed) return;
    const record = readEventFlowRecord(message, "ack");
    if (!record) return;
    const envelope = asRecord(asRecord(message)?.event);
    const seq = readPositiveSafeInteger(envelope?.seq);
    if (record.wsType === "raw.eventAck") {
      state.rawAcks += 1;
      recordSeq(state.rawAckSeqs, seq, "raw");
    } else {
      state.canonicalAcks += 1;
      recordSeq(state.canonicalAckSeqs, seq, "canonical");
    }
    const providerId = readProviderEventId(envelope);
    if (providerId && seq != null) {
      state.mappedProviderAcks += 1;
      const correlationKey = `${record.threadId ?? "<unknown>"}:${providerId}`;
      const previousSeq = state.providerSeqById.get(correlationKey);
      if (previousSeq != null && previousSeq !== seq) state.providerSeqConflicts += 1;
      else state.providerSeqById.set(correlationKey, seq);
    }
    addRecord(record, bytes);
  }

  /** 记录连接中断时尚未发送的 evidence 帧；这些是待恢复发送，不冒充已确认重发。 */
  function recordDisconnect(pendingEvidenceFrames: number): void {
    if (disposed) return;
    state.disconnects += 1;
    state.pendingEvidenceFramesAtDisconnect += Math.max(0, Math.floor(Number(pendingEvidenceFrames) || 0));
    flush("disconnect");
  }

  /** 记录一次已重新建立的连接。 */
  function recordReconnect(): void {
    if (disposed) return;
    state.reconnects += 1;
  }

  /** 输出当前窗口；空窗口不写日志。 */
  function flush(reason: EventFlowSnapshot["reason"] = "manual"): EventFlowSnapshot | null {
    if (state.messages === 0 && state.disconnects === 0 && state.reconnects === 0) return null;
    const now = Date.now();
    const snapshot: EventFlowSnapshot = {
      reason,
      startedAt: state.startedAt,
      durationMs: Math.max(0, now - state.startedAt),
      messages: state.messages,
      bytes: state.bytes,
      outboundRawEvents: state.outboundRawEvents,
      outboundCanonicalEvents: state.outboundCanonicalEvents,
      rawAcks: state.rawAcks,
      canonicalAcks: state.canonicalAcks,
      uniqueRawAckSeqs: state.rawAckSeqs.size,
      duplicateRawAckSeqs: state.duplicateRawAckSeqs,
      uniqueCanonicalAckSeqs: state.canonicalAckSeqs.size,
      duplicateCanonicalAckSeqs: state.duplicateCanonicalAckSeqs,
      mappedProviderAcks: state.mappedProviderAcks,
      unmappedProviderEvents: state.unmappedProviderEvents,
      providerSeqConflicts: state.providerSeqConflicts,
      disconnects: state.disconnects,
      reconnects: state.reconnects,
      pendingEvidenceFramesAtDisconnect: state.pendingEvidenceFramesAtDisconnect,
      buckets: Array.from(state.buckets.values()).sort((left, right) => right.messages - left.messages),
    };
    state = createState(now);
    opts.onFlush(snapshot);
    return snapshot;
  }

  /** 停止窗口 timer，并冲刷仍有内容的最后窗口。 */
  function dispose(): void {
    if (disposed) return;
    clearInterval(timer);
    flush("dispose");
    disposed = true;
  }

  /** 累加一个有界聚合桶。 */
  function addRecord(record: Omit<EventFlowBucket, "messages" | "bytes">, bytes: number): void {
    const safeBytes = Math.max(0, Math.floor(Number(bytes) || 0));
    state.messages += 1;
    state.bytes += safeBytes;
    if (record.wsType === "raw.event") state.outboundRawEvents += 1;
    if (record.wsType === "conversation.event") state.outboundCanonicalEvents += 1;
    if (
      record.stage === "outbound"
      && record.wsType === "raw.event"
      && record.providerCorrelation === "unmapped"
      && record.providerMethod
    ) state.unmappedProviderEvents += 1;
    const key = makeBucketKey(record);
    const existing = state.buckets.get(key);
    if (existing) {
      existing.messages += 1;
      existing.bytes += safeBytes;
    } else if (state.buckets.size < MAX_BUCKETS) {
      state.buckets.set(key, { ...record, messages: 1, bytes: safeBytes });
    } else {
      const overflowKey = "<overflow>";
      const overflow = state.buckets.get(overflowKey);
      if (overflow) {
        overflow.messages += 1;
        overflow.bytes += safeBytes;
      } else {
        state.buckets.set(overflowKey, {
          stage: record.stage,
          wsType: "<overflow>",
          threadId: null,
          clientTurnId: null,
          providerMethod: null,
          providerTurnId: null,
          providerItemId: null,
          canonicalType: null,
          providerCorrelation: "unmapped",
          messages: 1,
          bytes: safeBytes,
        });
      }
    }
    if (state.messages >= messageThreshold) flush("threshold");
  }

  /** 记录 ACK seq；缺失 seq 保持 unmapped，不制造占位序号。 */
  function recordSeq(target: Set<number>, seq: number | null, kind: "raw" | "canonical"): void {
    if (seq == null) return;
    if (target.has(seq)) {
      if (kind === "raw") state.duplicateRawAckSeqs += 1;
      else state.duplicateCanonicalAckSeqs += 1;
      return;
    }
    target.add(seq);
  }

  return { recordOutbound, recordAck, recordDisconnect, recordReconnect, flush, dispose };
}

/** 初始化一个空聚合窗口。 */
function createState(startedAt: number): EventFlowState {
  return {
    startedAt,
    messages: 0,
    bytes: 0,
    outboundRawEvents: 0,
    outboundCanonicalEvents: 0,
    rawAcks: 0,
    canonicalAcks: 0,
    duplicateRawAckSeqs: 0,
    duplicateCanonicalAckSeqs: 0,
    mappedProviderAcks: 0,
    unmappedProviderEvents: 0,
    providerSeqConflicts: 0,
    disconnects: 0,
    reconnects: 0,
    pendingEvidenceFramesAtDisconnect: 0,
    buckets: new Map(),
    rawAckSeqs: new Set(),
    canonicalAckSeqs: new Set(),
    providerSeqById: new Map(),
  };
}

/** 从 raw/canonical WS 消息中读取可证明的关联维度。 */
function readEventFlowRecord(message: unknown, stage: EventFlowBucket["stage"]): Omit<EventFlowBucket, "messages" | "bytes"> | null {
  const record = asRecord(message);
  const wsType = String(record?.t ?? "").trim();
  if (stage === "outbound" && wsType !== "raw.event" && wsType !== "conversation.event") return null;
  if (stage === "ack" && wsType !== "raw.eventAck" && wsType !== "conversation.eventAck") return null;
  const envelope = asRecord(record?.event);
  const data = asRecord(envelope?.data);
  const params = asRecord(data?.params);
  const item = asRecord(params?.item);
  const turn = asRecord(params?.turn);
  const providerMethod = nullableString(data?.method);
  return {
    stage,
    wsType,
    threadId: nullableString(envelope?.threadId),
    clientTurnId: nullableString(envelope?.clientTurnId) ?? nullableString(asRecord(envelope?.payload)?.turnId),
    providerMethod,
    providerTurnId: nullableString(params?.turnId) ?? nullableString(turn?.id),
    providerItemId: nullableString(params?.itemId) ?? nullableString(item?.id),
    canonicalType: nullableString(envelope?.type),
    providerCorrelation: readProviderEventId(envelope) ? "mapped" : "unmapped",
  };
}

/** 只接受 provider 原生 id；通知没有 id 时保持 unmapped。 */
function readProviderEventId(envelope: Record<string, unknown> | null): string | null {
  const id = asRecord(envelope?.data)?.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return nullableString(id);
}

/** 生成不包含 payload 正文的聚合键。 */
function makeBucketKey(record: Omit<EventFlowBucket, "messages" | "bytes">): string {
  return [
    record.stage,
    record.wsType,
    record.threadId,
    record.clientTurnId,
    record.providerMethod,
    record.providerTurnId,
    record.providerItemId,
    record.canonicalType,
    record.providerCorrelation,
  ].map((value) => value ?? "").join("\u001f");
}

/** 把对象输入收窄为普通记录。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 读取非空字符串，不生成诊断占位 ID。 */
function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 读取正安全整数 seq。 */
function readPositiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 规范化正整数配置。 */
function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
