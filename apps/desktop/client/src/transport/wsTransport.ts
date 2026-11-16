import { performance } from "node:perf_hooks";
import WebSocket from "ws";

import { resolveClientWsCloseDisposition, type ClientWsCloseDisposition } from "./wsCloseCodes.js";

export type WsSendJsonResult = {
  accepted: boolean;
  messageType: string | null;
  readyState: number | null;
  bufferedAmount: number | null;
  bytes: number;
  reason: string | null;
  queuedAt: number;
  callbackError: string | null;
};

export type WsQueueDiagnostic = {
  connectionReady: boolean;
  socketReadyState: number | null;
  socketBufferedAmount: number | null;
  queuedMessages: number;
  queuedBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  helloMessages: number;
  activationMessages: number;
  priorityMessages: number;
  evidenceMessages: number;
  evidencePartitions: number;
  bulkMessages: number;
  inboundMessages: number;
  inboundBytes: number;
  inboundOldestQueuedMs: number;
  inboundActiveHandlers: number;
  inboundOldestActiveHandlerMs: number;
  inboundMaxHandlerDurationMs: number;
  inboundTypes: Record<string, { messages: number; bytes: number }>;
  inboundOverHighWater: boolean;
  inboundHighWaterMessages: number;
  inboundHighWaterBytes: number;
  inFlight: {
    messageType: string | null;
    bytes: number;
    lane: WsQueueLane;
    queuedAt: number;
  } | null;
};

export type WsInboundMessageMeta = {
  messageType: string;
  bytes: number;
  queuedAt: number;
};

export type WsInboundPressureSnapshot = {
  capturedAt: number;
  queuedMessages: number;
  queuedBytes: number;
  oldestQueuedMs: number;
  activeHandlers: number;
  oldestActiveHandlerMs: number;
  maxHandlerDurationMs: number;
  overHighWater: boolean;
  messageTypes: Record<string, { messages: number; bytes: number }>;
};

export type WsInboundMessageFailure = WsInboundMessageMeta & {
  data: unknown;
  handlerDurationMs: number;
  error: unknown;
};

export type WsDeliveryFailure = {
  at: number;
  phase: "queue_overflow" | "send_callback" | "socket_closed";
  messageType: string | null;
  bytes: number;
  reason: string;
  queue: WsQueueDiagnostic;
};

export type WsCloseDiagnostic = {
  connectedAt: number | null;
  lastPingAt: number | null;
  msSinceLastPing: number | null;
  lastMessageAt: number | null;
  msSinceLastMessage: number | null;
  lastSendAt: number | null;
  msSinceLastSend: number | null;
  lastSendMessageType: string | null;
  bufferedAmount: number | null;
  sendFailureCount: number;
  lastSendFailure: {
    at: number;
    reason: string;
    messageType: string | null;
    readyState: number | null;
  } | null;
  queue: WsQueueDiagnostic;
};

export type WsCloseInfo = {
  code: number;
  reason: string;
  disposition: ClientWsCloseDisposition;
  diagnostic: WsCloseDiagnostic;
};

export type WsTransportEvents = {
  onOpen: () => void;
  onClose: (info: WsCloseInfo) => void;
  onMessage: (data: unknown, meta: WsInboundMessageMeta) => void | Promise<void>;
  /** 明确handled时停止通用诊断；void保留旧通知，回调失败由原入站owner保存。 */
  onMessageFailure?: (failure: WsInboundMessageFailure) => { handled: true } | void;
  /** 可选：接收底层连接错误，供 CLI 做用户可见提示。 */
  onError?: (message: string, context?: { source: "socket"; code: string | null }) => void;
  /** 可选：接收心跳诊断日志（ping 间隔异常等）。 */
  onDiagnostic?: (level: "info" | "warn", message: string) => void;
  /** 可选：接收无法安全重发的最终投递失败，供上层显式告警或退出。 */
  onDeliveryFailure?: (failure: WsDeliveryFailure) => void;
};

/**
 * Client ↔ Server 的 WS 连接封装：
 * - 负责连接、重连与基础收发
 * - 不负责业务协议（业务在上层处理）
 * - 支持检测 server 心跳：server 每 30s 发 ping，连续 3 次未收到则主动断开重连
 */

/**
 * Server 心跳超时倍数：如果连续 HEARTBEAT_MISS_LIMIT 个周期没收到 server ping，
 * 则认为 server 已不可达，主动关闭并重连。
 * Server 每 30s 发一次 ping，3 次 = 90s。
 */
const HEARTBEAT_MISS_LIMIT = 3;
const HEARTBEAT_CHECK_MS = 30_000;
const DEFAULT_QUEUE_MAX_MESSAGES = 50_000;
const DEFAULT_QUEUE_MAX_BYTES = 256 * 1024 * 1024;
const SMALL_PRIORITY_MAX_BYTES = 512 * 1024;
const BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const BUFFER_LOW_WATER_BYTES = 128 * 1024;
const BULK_DRAIN_RETRY_MS = 20;
const DEFAULT_INBOUND_DISPATCH_BATCH_MESSAGES = 100;
const DEFAULT_INBOUND_DISPATCH_BUDGET_MS = 8;
const DEFAULT_INBOUND_HIGH_WATER_MESSAGES = 2_000;
const DEFAULT_INBOUND_HIGH_WATER_BYTES = 32 * 1024 * 1024;
const INBOUND_DIAGNOSTIC_WINDOW_MS = 15_000;
const INBOUND_DIAGNOSTIC_MESSAGE_THRESHOLD = 5_000;
const SMALL_PRIORITY_TYPES = new Set([
  "api.res",
  "sharedWorkspace.route.ack",
  "sharedWorkspace.route.result",
]);
const EVIDENCE_TYPES = new Set([
  "raw.event",
  "conversation.event",
  "conversation.event.relay",
  "relay.event",
  "orchestration.event",
]);
const ACTIVATION_CONTROL_TYPES = new Set([
  "client.workspaceDirectoryMigrationActivationSnapshot",
  "engine.models.applied",
  "engine.models.dispatchPaused",
]);
const CONNECTION_SCOPED_INBOUND_TYPES = new Set([
  "client.helloAck",
  "engine.models.updated",
  "engine.models.dispatchPause",
  "engine.models.dispatchResume",
  "engine.models.appliedConfirmed",
  "api.req",
  "sharedWorkspace.command",
  "conversation.event.relayScopes",
  "conversation.event.relayDemand",
  "remote.data.demand",
  "conversation.eventRelayAck",
  "thread.history.cleanedAck",
]);

export type WsQueueLane = "hello" | "activation" | "priority" | "evidence" | "bulk";
type ScheduledQueueLane = Exclude<WsQueueLane, "hello" | "activation">;
const FAIR_SCHEDULE: readonly ScheduledQueueLane[] = [
  "priority", "priority", "priority", "priority", "priority", "priority", "priority", "priority",
  "evidence", "evidence", "evidence", "evidence",
  "bulk",
];

type OutboundFrame = {
  encoded: string;
  messageType: string | null;
  partitionKey: string;
  bytes: number;
  queuedAt: number;
  lane: WsQueueLane;
  result: WsSendJsonResult;
  deliveryFailureReported: boolean;
  connectionScoped: boolean;
};

type InFlightSend = {
  frame: OutboundFrame;
  socket: WebSocket;
};

type InboundFrame = {
  data: unknown;
  messageType: string;
  bytes: number;
  queuedAt: number;
  socket: WebSocket;
};

type LaneSelection = {
  lane: WsQueueLane;
  scheduleIndex: number | null;
};

class OutboundFrameQueue {
  private values: Array<OutboundFrame | undefined> = [];
  private head = 0;

  /** 返回尚未出队的帧数。 */
  get length(): number {
    return this.values.length - this.head;
  }

  /** 将帧追加到 FIFO 尾部。 */
  push(frame: OutboundFrame): void {
    this.values.push(frame);
  }

  /** 将未交给底层的帧恢复到 FIFO 头部。 */
  unshift(frame: OutboundFrame): void {
    if (this.head > 0) {
      this.head -= 1;
      this.values[this.head] = frame;
      return;
    }
    this.values.unshift(frame);
  }

  /** 查看 FIFO 头部但不移除。 */
  peek(): OutboundFrame | null {
    return this.values[this.head] ?? null;
  }

  /** 判断尚未出队的帧中是否存在满足条件的项。 */
  some(predicate: (frame: OutboundFrame) => boolean): boolean {
    for (let index = this.head; index < this.values.length; index += 1) {
      const frame = this.values[index];
      if (frame && predicate(frame)) return true;
    }
    return false;
  }

  /** 汇总尚未出队帧的字节数，供连接诊断使用。 */
  totalBytes(): number {
    let bytes = 0;
    for (let index = this.head; index < this.values.length; index += 1) {
      bytes += this.values[index]?.bytes ?? 0;
    }
    return bytes;
  }

  /** 取出 FIFO 头部并按需压缩已消费空间。 */
  shift(): OutboundFrame | null {
    const frame = this.values[this.head] ?? null;
    if (!frame) return null;
    this.values[this.head] = undefined;
    this.head += 1;
    if (this.head >= 1_024 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
    return frame;
  }
}

/** evidence 按 thread 分区轮转，各分区内部保持严格 FIFO。 */
class PartitionedOutboundFrameQueue {
  private readonly queues = new Map<string, OutboundFrameQueue>();
  private readonly keys: string[] = [];
  private cursor = 0;
  private size = 0;

  /** 返回全部 thread 分区尚未发送的帧数。 */
  get length(): number {
    return this.size;
  }

  /** 返回当前活跃 thread 分区数。 */
  get partitionCount(): number {
    return this.keys.length;
  }

  /** 将帧追加到所属 thread FIFO。 */
  push(frame: OutboundFrame): void {
    let queue = this.queues.get(frame.partitionKey) ?? null;
    if (!queue) {
      queue = new OutboundFrameQueue();
      this.queues.set(frame.partitionKey, queue);
      this.keys.push(frame.partitionKey);
    }
    queue.push(frame);
    this.size += 1;
  }

  /** 将未交给底层的帧恢复到所属 thread FIFO 头部。 */
  unshift(frame: OutboundFrame): void {
    let queue = this.queues.get(frame.partitionKey) ?? null;
    if (!queue) {
      queue = new OutboundFrameQueue();
      this.queues.set(frame.partitionKey, queue);
      this.keys.splice(Math.min(this.cursor, this.keys.length), 0, frame.partitionKey);
    }
    queue.unshift(frame);
    this.size += 1;
  }

  /** 查看下一 thread 分区的 FIFO 头部。 */
  peek(): OutboundFrame | null {
    if (this.keys.length === 0) return null;
    if (this.cursor >= this.keys.length) this.cursor = 0;
    return this.queues.get(this.keys[this.cursor]!)?.peek() ?? null;
  }

  /** 从下一 thread 分区取帧，并把游标轮转到其它活跃 thread。 */
  shift(): OutboundFrame | null {
    if (this.keys.length === 0) return null;
    if (this.cursor >= this.keys.length) this.cursor = 0;
    const key = this.keys[this.cursor]!;
    const queue = this.queues.get(key);
    const frame = queue?.shift() ?? null;
    if (!frame || !queue) return null;
    this.size -= 1;
    if (queue.length === 0) {
      this.queues.delete(key);
      this.keys.splice(this.cursor, 1);
      if (this.cursor >= this.keys.length) this.cursor = 0;
    } else {
      this.cursor = (this.cursor + 1) % this.keys.length;
    }
    return frame;
  }
}

class InboundFrameQueue {
  private values: Array<InboundFrame | undefined> = [];
  private head = 0;

  /** 返回尚未分发的入站帧数。 */
  get length(): number {
    return this.values.length - this.head;
  }

  /** 将入站帧追加到严格 FIFO 尾部。 */
  push(frame: InboundFrame): void {
    this.values.push(frame);
  }

  /** 返回最早尚未分发的帧。 */
  peek(): InboundFrame | null {
    return this.values[this.head] ?? null;
  }

  /** 取出最早入站帧，并按需压缩已消费空间。 */
  shift(): InboundFrame | null {
    const frame = this.values[this.head] ?? null;
    if (!frame) return null;
    this.values[this.head] = undefined;
    this.head += 1;
    if (this.head >= 1_024 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
    return frame;
  }
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /** 是否已收到过 server 的 ping（用于向后兼容未升级的 server）。 */
  private serverPingReceived = false;
  private lastPingAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectedAt = 0;
  private lastMessageAt = 0;
  private lastSendAt = 0;
  private lastSendMessageType: string | null = null;
  private sendFailureCount = 0;
  private lastSendFailure: WsCloseDiagnostic["lastSendFailure"] = null;
  private lastBufferedAmountWarnAt = 0;
  private connectionReady = false;
  private inFlight: InFlightSend | null = null;
  private readonly helloQueue = new OutboundFrameQueue();
  private readonly activationQueue = new OutboundFrameQueue();
  private readonly priorityQueue = new OutboundFrameQueue();
  private readonly evidenceQueue = new PartitionedOutboundFrameQueue();
  private readonly bulkQueue = new OutboundFrameQueue();
  private normalQueuedBytes = 0;
  private fairnessCursor = 0;
  private bulkPaused = false;
  private bulkDrainTimer: NodeJS.Timeout | null = null;
  private readonly inboundQueue = new InboundFrameQueue();
  private inboundQueuedBytes = 0;
  private readonly inboundQueuedTypes = new Map<string, { messages: number; bytes: number }>();
  private inboundDispatchImmediate: NodeJS.Immediate | null = null;
  private inboundOverHighWater = false;
  private lastInboundPressureWarnAt = 0;
  private inboundDraining = false;
  private nextInboundHandlerId = 1;
  private readonly activeInboundHandlers = new Map<number, {
    startedAt: number;
    messageType: string;
    promise: Promise<void>;
    running: boolean;
    failure?: { error: unknown };
  }>();
  private inboundMaxHandlerDurationMs = 0;
  private inboundWindowStartedAt = Date.now();
  private inboundWindowMessages = 0;
  private inboundWindowBytes = 0;
  private readonly inboundWindowTypes = new Map<string, { messages: number; bytes: number }>();
  private inboundDiagnosticTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly maxQueuedMessages: number;
  private readonly maxQueuedBytes: number;
  private readonly inboundDispatchBatchMessages: number;
  private readonly inboundDispatchBudgetMs: number;
  private readonly inboundNow: () => number;
  private readonly inboundHighWaterMessages: number;
  private readonly inboundHighWaterBytes: number;
  private readonly inboundLowWaterMessages: number;
  private readonly inboundLowWaterBytes: number;

  constructor(
    private readonly opts: {
      url: string;
      headers: Record<string, string>;
      events: WsTransportEvents;
      queueLimits?: {
        maxMessages?: number;
        maxBytes?: number;
      };
      inboundLimits?: {
        batchMessages?: number;
        dispatchBudgetMs?: number;
        highWaterMessages?: number;
        highWaterBytes?: number;
        now?: () => number;
      };
      createWebSocket?: (url: string, headers: Record<string, string>) => WebSocket;
    },
  ) {
    this.maxQueuedMessages = resolvePositiveInteger(opts.queueLimits?.maxMessages, DEFAULT_QUEUE_MAX_MESSAGES);
    this.maxQueuedBytes = resolvePositiveInteger(opts.queueLimits?.maxBytes, DEFAULT_QUEUE_MAX_BYTES);
    this.inboundDispatchBatchMessages = resolvePositiveInteger(opts.inboundLimits?.batchMessages, DEFAULT_INBOUND_DISPATCH_BATCH_MESSAGES);
    this.inboundDispatchBudgetMs = resolvePositiveInteger(opts.inboundLimits?.dispatchBudgetMs, DEFAULT_INBOUND_DISPATCH_BUDGET_MS);
    this.inboundNow = opts.inboundLimits?.now ?? (() => performance.now());
    this.inboundHighWaterMessages = resolvePositiveInteger(opts.inboundLimits?.highWaterMessages, DEFAULT_INBOUND_HIGH_WATER_MESSAGES);
    this.inboundHighWaterBytes = resolvePositiveInteger(opts.inboundLimits?.highWaterBytes, DEFAULT_INBOUND_HIGH_WATER_BYTES);
    this.inboundLowWaterMessages = Math.max(1, Math.floor(this.inboundHighWaterMessages / 2));
    this.inboundLowWaterBytes = Math.max(1, Math.floor(this.inboundHighWaterBytes / 2));
  }

  /** 启动连接；重连期间保留尚未交给底层的帧。 */
  start(): void {
    this.stopped = false;
    this.stopping = false;
    this.connectionReady = false;
    this.startInboundDiagnosticWindow();
    this.connect();
  }

  /** 激活快照进入握手队列后释放业务队列并重置重连退避。 */
  markReady(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.opts.events.onDiagnostic?.("warn", "ws markReady ignored: socket is not open");
      return;
    }
    this.reconnectAttempt = 0;
    this.connectionReady = true;
    this.pump();
  }

  /** 关闭当前连接并保留进程内状态，由既有退避策略重新握手收敛。 */
  reconnect(reason: string): void {
    if (this.stopped || this.stopping) return;
    const socket = this.ws;
    if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
    this.connectionReady = false;
    socket.close(1012, String(reason ?? "reconnect required").slice(0, 120));
  }

  /** 停止和资源释放不被诊断失败跳过；全部原错误交调用方显式收口。 */
  stop(): void {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    const errors: unknown[] = [];
    /** 每个必要步骤独立收口，后续关闭不能因前一步失败被跳过。 */
    const stopStep = (action: () => void): void => {
      try { action(); } catch (error) { errors.push(error); }
    };
    this.stopInboundDispatch();
    if (this.inboundQueue.length > 0) {
      stopStep(() => this.opts.events.onDiagnostic?.(
        "warn",
        `ws transport draining received inbound messages before stop count=${this.inboundQueue.length} bytes=${this.inboundQueuedBytes}`,
      ));
      stopStep(() => this.drainInboundSynchronously());
    }
    stopStep(() => this.flushInboundWindow("stop"));
    this.stopInboundDiagnosticWindow();
    this.stopped = true;
    this.stopping = false;
    this.connectionReady = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopBulkDrainCheck();
    this.stopHeartbeatCheck();
    const queue = this.buildQueueDiagnostic();
    stopStep(() => this.opts.events.onDiagnostic?.(
      queue.queuedMessages > 0 || queue.inFlight ? "warn" : "info",
      `ws transport stopped queue=${JSON.stringify(queue)}`,
    ));
    try {
      this.ws?.close(1000, "stopped");
    } catch (error) {
      errors.push(error);
      stopStep(() => {
        const message = error instanceof Error ? error.message : String(error);
        this.opts.events.onDiagnostic?.("warn", `ws stop close failed: ${message}`);
        this.opts.events.onError?.(message);
      });
    }
    this.ws = null;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "WS_TRANSPORT_STOP_FAILED", { cause: errors[0] });
  }

  /** 停止新入口并等待原入站owner；已settled失败仍须显式消费。 */
  async stopAndDrain(): Promise<void> {
    let stopFailure: { error: unknown } | null = null;
    try { this.stop(); } catch (error) { stopFailure = { error }; }
    const handlers = Array.from(this.activeInboundHandlers);
    await Promise.all(handlers.map(([, handler]) => handler.promise));
    const failures = [...(stopFailure ? [stopFailure.error] : []),
      ...handlers.flatMap(([, handler]) => handler.failure ? [handler.failure.error] : [])];
    for (const [handlerId, handler] of handlers) {
      if (!handler.running && this.activeInboundHandlers.get(handlerId) === handler) this.activeInboundHandlers.delete(handlerId);
    }
    if (stopFailure && failures.length === 1) throw stopFailure.error;
    if (failures.length > 0) {
      throw new AggregateError(failures, `ws inbound handlers failed during stop count=${failures.length}`, { cause: failures[0] });
    }
  }

  /** 序列化并接收一帧；进入有界队列即视为 accepted，而非已送达。 */
  sendJson(obj: unknown): WsSendJsonResult {
    const ws = this.ws;
    const queuedAt = Date.now();
    const messageType = resolveMessageType(obj);
    const readyState = ws?.readyState ?? null;
    const bufferedAmount = ws ? safeBufferedAmount(ws) : null;
    const connectionScoped = messageType === "conversation.event.relayReady"
      || (messageType === "conversation.event.relay" || messageType === "thread.history.cleaned")
        && obj !== null && typeof obj === "object" && "delivery" in obj && obj.delivery !== undefined;
    if (this.stopped) {
      return this.rejectSend({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes: 0,
        reason: "transport stopped",
      });
    }
    if (connectionScoped && (readyState !== WebSocket.OPEN || !this.connectionReady)) {
      return this.rejectSend({ queuedAt, messageType, readyState, bufferedAmount, bytes: 0,
        reason: "durable relay requires a current ready connection" });
    }

    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(obj);
    } catch (error) {
      return this.rejectSend({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes: 0,
        reason: error instanceof Error ? error.message : "json stringify failed",
      });
    }
    if (typeof encoded !== "string") {
      return this.rejectSend({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes: 0,
        reason: "json stringify returned undefined",
      });
    }

    const bytes = Buffer.byteLength(encoded);
    const lane = resolveQueueLane(messageType, bytes);
    if ((lane === "hello" || lane === "activation") && readyState !== WebSocket.OPEN) {
      return this.rejectSend({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes,
        reason: `${messageType ?? "handshake message"} requires an open socket (${describeReadyState(readyState)})`,
      });
    }
    if (messageType === "client.hello"
      && (this.helloQueue.length > 0 || this.inFlight?.frame.lane === "hello")) {
      return this.rejectQueueOverflow({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes,
        reason: "client.hello queue already occupied",
      });
    }
    if (lane === "activation" && (
      this.activationQueue.some((frame) => frame.messageType === messageType)
      || (this.inFlight?.frame.lane === "activation" && this.inFlight.frame.messageType === messageType)
    )) {
      return this.rejectQueueOverflow({
        queuedAt,
        messageType,
        readyState,
        bufferedAmount,
        bytes,
        reason: `${messageType ?? "client activation message"} queue already occupied`,
      });
    }
    if (lane !== "hello" && lane !== "activation") {
      const queuedMessages = this.priorityQueue.length + this.evidenceQueue.length + this.bulkQueue.length;
      if (queuedMessages >= this.maxQueuedMessages || this.normalQueuedBytes + bytes > this.maxQueuedBytes) {
        return this.rejectQueueOverflow({
          queuedAt,
          messageType,
          readyState,
          bufferedAmount,
          bytes,
          reason: `queue overflow (messages=${queuedMessages}/${this.maxQueuedMessages}, bytes=${this.normalQueuedBytes}/${this.maxQueuedBytes})`,
        });
      }
    }

    const result: WsSendJsonResult = {
      accepted: true,
      messageType,
      readyState,
      bufferedAmount,
      bytes,
      reason: null,
      queuedAt,
      callbackError: null,
    };
    const frame: OutboundFrame = {
      encoded,
      messageType,
      bytes,
      queuedAt,
      lane,
      partitionKey: lane === "evidence" ? resolveEvidencePartitionKey(obj) : "__global__",
      result,
      deliveryFailureReported: false,
      connectionScoped,
    };
    if (lane === "hello") {
      this.helloQueue.push(frame);
    } else if (lane === "activation") {
      this.activationQueue.push(frame);
    } else if (lane === "priority") {
      this.priorityQueue.push(frame);
      this.normalQueuedBytes += bytes;
    } else if (lane === "evidence") {
      this.evidenceQueue.push(frame);
      this.normalQueuedBytes += bytes;
    } else {
      this.bulkQueue.push(frame);
      this.normalQueuedBytes += bytes;
    }
    this.pump();
    return result;
  }

  /** 创建底层连接并绑定单连接生命周期事件。 */
  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = this.opts.createWebSocket
        ? this.opts.createWebSocket(this.opts.url, this.opts.headers)
        : new WebSocket(this.opts.url, { headers: this.opts.headers });
    } catch (error) {
      this.opts.events.onError?.(error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.connectionReady = false;
      this.bulkPaused = false;
      this.stopBulkDrainCheck();
      this.serverPingReceived = false;
      this.lastPingAt = 0;
      this.connectedAt = Date.now();
      this.lastMessageAt = 0;
      this.lastSendAt = 0;
      this.lastSendMessageType = null;
      this.sendFailureCount = 0;
      this.lastSendFailure = null;
      this.lastBufferedAmountWarnAt = 0;
      this.startHeartbeatCheck(ws);
      this.opts.events.onOpen();
      this.pump();
    });
    ws.on("ping", () => {
      // Server 发来 ping（ws 库自动回复 pong），记录时间用于心跳检测
      const now = Date.now();
      if (this.serverPingReceived && this.lastPingAt > 0) {
        const gap = now - this.lastPingAt;
        // 正常间隔 ~30s，超过 35s 说明有延迟/丢包，记录诊断信息
        if (gap > 35_000) {
          this.opts.events.onDiagnostic?.("warn", `ping gap=${gap}ms (expected ~30000)`);
        }
      }
      this.serverPingReceived = true;
      this.lastPingAt = now;
    });
    ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof data === "string" ? data : Buffer.from(data as any).toString("utf8");
        this.enqueueInbound(text, ws);
      } catch (error) {
        this.opts.events.onError?.(error instanceof Error ? error.message : String(error));
      }
    });
    ws.on("close", (code, reason) => {
      this.stopHeartbeatCheck();
      this.stopBulkDrainCheck();
      const reasonText = reason.toString("utf8");
      const disposition = resolveClientWsCloseDisposition(code, reasonText);
      const info = {
        code,
        reason: reasonText,
        disposition,
        diagnostic: this.buildCloseDiagnostic(Date.now(), ws),
      };
      this.detachInFlightOnClose(ws, code, reasonText, !this.stopped);
      this.discardQueuedActivationOnClose(code, reasonText);
      this.discardQueuedDurableRelayOnClose(code, reasonText);
      this.connectionReady = false;
      this.bulkPaused = false;
      this.opts.events.onClose(info);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (disposition !== "reconnect") {
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      this.opts.events.onError?.(error instanceof Error ? error.message : String(error), {
        source: "socket", code: typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code! : null,
      });
      // close handler 会统一负责重连
    });
  }

  /** 将已接收消息放入严格 FIFO；高水位只记录诊断，不暂停公共 Server WS。 */
  private enqueueInbound(text: string, socket: WebSocket): void {
    if (this.stopped) {
      this.opts.events.onError?.("ws message received after transport stopped");
      return;
    }
    const bytes = Buffer.byteLength(text);
    const queuedAt = Date.now();
    const parsed = parseInboundData(text);
    const messageType = resolveMessageType(parsed) ?? "<unknown>";
    this.inboundQueue.push({ data: parsed, messageType, bytes, queuedAt, socket });
    this.inboundQueuedBytes += bytes;
    incrementTypeStats(this.inboundQueuedTypes, messageType, bytes);
    this.recordInboundWindow(messageType, bytes, queuedAt);
    if (
      !this.inboundOverHighWater
      && (
        this.inboundQueue.length >= this.inboundHighWaterMessages
        || this.inboundQueuedBytes >= this.inboundHighWaterBytes
      )
    ) {
      this.inboundOverHighWater = true;
      this.lastInboundPressureWarnAt = queuedAt;
      this.reportInboundPressure("warn", "high_water");
    } else if (this.inboundOverHighWater && queuedAt - this.lastInboundPressureWarnAt >= INBOUND_DIAGNOSTIC_WINDOW_MS) {
      this.lastInboundPressureWarnAt = queuedAt;
      this.reportInboundPressure("warn", "sustained_high_water");
    }
    this.scheduleInboundDispatch();
  }

  /** 每轮受消息数和时间片双重限制，至少分发一条后通过 setImmediate 让出事件循环。 */
  private drainInboundBatch(): void {
    this.inboundDispatchImmediate = null;
    if (this.inboundDraining) return;
    this.inboundDraining = true;
    try {
      let dispatched = 0;
      const startedAt = this.inboundNow();
      while (dispatched < this.inboundDispatchBatchMessages) {
        const frame = this.takeInboundFrame();
        if (!frame) break;
        this.dispatchInboundFrame(frame);
        dispatched += 1;
        if (this.inboundNow() - startedAt >= this.inboundDispatchBudgetMs) break;
      }
    } finally {
      this.inboundDraining = false;
    }
    this.clearInboundHighWaterIfDrained();
    if (this.inboundQueue.length > 0 && !this.stopped) this.scheduleInboundDispatch();
  }

  /** 停机时同步排空已经接收的帧，防止 raw ACK 在数据库关闭前丢失。 */
  private drainInboundSynchronously(): void {
    let frame = this.takeInboundFrame();
    while (frame) {
      this.dispatchInboundFrame(frame);
      frame = this.takeInboundFrame();
    }
    this.clearInboundHighWaterIfDrained();
  }

  /** 从入站 FIFO 取一帧，并同步字节统计。 */
  private takeInboundFrame(): InboundFrame | null {
    const frame = this.inboundQueue.shift();
    if (!frame) return null;
    this.inboundQueuedBytes = Math.max(0, this.inboundQueuedBytes - frame.bytes);
    decrementTypeStats(this.inboundQueuedTypes, frame.messageType, frame.bytes);
    return frame;
  }

  /** 按接收顺序调用上层处理器；异步完成可并发，但 rejection 必须显式上报。 */
  private dispatchInboundFrame(frame: InboundFrame): void {
    if (
      CONNECTION_SCOPED_INBOUND_TYPES.has(frame.messageType)
      && (this.ws !== frame.socket || frame.socket.readyState !== WebSocket.OPEN)
    ) {
      this.opts.events.onDiagnostic?.("warn", `ws discarded stale ${frame.messageType} from a closed connection`);
      return;
    }
    const startedAt = Date.now();
    const meta: WsInboundMessageMeta = {
      messageType: frame.messageType,
      bytes: frame.bytes,
      queuedAt: frame.queuedAt,
    };
    const handlerId = this.nextInboundHandlerId;
    this.nextInboundHandlerId += 1;
    const handler = { startedAt, messageType: frame.messageType, promise: Promise.resolve(), running: true,
      failure: undefined as { error: unknown } | undefined };
    this.activeInboundHandlers.set(handlerId, handler);
    try {
      const result = this.opts.events.onMessage(frame.data, meta);
      if (!isPromiseLike(result)) {
        this.finishInboundHandler(handlerId, startedAt);
        return;
      }
      handler.promise = Promise.resolve(result).then(
        () => this.finishInboundHandler(handlerId, startedAt),
        (error) => this.finishInboundHandler(handlerId, startedAt, { ...meta, data: frame.data, handlerDurationMs: 0, error }),
      );
    } catch (error) {
      this.finishInboundHandler(handlerId, startedAt, { ...meta, data: frame.data, handlerDurationMs: 0, error });
    }
  }

  /** 成功或明确handled才释放记录；未处理和回调失败保原值到显式排空。 */
  private finishInboundHandler(handlerId: number, startedAt: number, failure?: WsInboundMessageFailure): void {
    const handler = this.activeInboundHandlers.get(handlerId)!;
    handler.running = false;
    const durationMs = Math.max(0, Date.now() - startedAt);
    this.recordInboundHandlerDuration(durationMs);
    if (!failure) {
      this.activeInboundHandlers.delete(handlerId);
      return;
    }
    try {
      if (this.reportInboundMessageFailure({ ...failure, handlerDurationMs: durationMs })) this.activeInboundHandlers.delete(handlerId);
      else handler.failure = { error: failure.error };
    } catch (callbackError) {
      handler.failure = { error: new AggregateError([failure.error, callbackError], "WS_INBOUND_FAILURE_CALLBACK_FAILED", { cause: failure.error }) };
    }
  }

  /** 先交业务边界；明确handled不反射原因或产生应用同条诊断。 */
  private reportInboundMessageFailure(failure: WsInboundMessageFailure): boolean {
    const result = this.opts.events.onMessageFailure?.(failure);
    if (result?.handled === true) return true;
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    this.opts.events.onError?.(
      `ws inbound handler failed messageType=${failure.messageType} durationMs=${failure.handlerDurationMs}: ${message}`,
    );
    return false;
  }

  /** 在下一轮 check 阶段继续分发，避免连续消息占满 Node 主线程。 */
  private scheduleInboundDispatch(): void {
    if (this.inboundDispatchImmediate || this.stopped) return;
    this.inboundDispatchImmediate = setImmediate(() => this.drainInboundBatch());
    this.inboundDispatchImmediate.unref?.();
  }

  /** 取消尚未执行的入站调度；队列内容由调用方明确排空。 */
  private stopInboundDispatch(): void {
    if (!this.inboundDispatchImmediate) return;
    clearImmediate(this.inboundDispatchImmediate);
    this.inboundDispatchImmediate = null;
  }

  /** 队列降到低水位后清除诊断滞回状态。 */
  private clearInboundHighWaterIfDrained(): void {
    if (!this.inboundOverHighWater) return;
    if (
      this.inboundQueue.length > this.inboundLowWaterMessages
      || this.inboundQueuedBytes > this.inboundLowWaterBytes
    ) return;
    this.inboundOverHighWater = false;
    this.reportInboundPressure("info", "low_water_recovered");
  }

  /** 返回后台清理可复用的只读入站压力快照。 */
  getInboundPressureSnapshot(now = Date.now()): WsInboundPressureSnapshot {
    const oldestQueuedAt = this.inboundQueue.peek()?.queuedAt ?? null;
    let oldestActiveStartedAt: number | null = null;
    let activeHandlers = 0;
    for (const active of this.activeInboundHandlers.values()) {
      if (!active.running) continue;
      activeHandlers++;
      oldestActiveStartedAt = oldestActiveStartedAt == null
        ? active.startedAt
        : Math.min(oldestActiveStartedAt, active.startedAt);
    }
    return {
      capturedAt: now,
      queuedMessages: this.inboundQueue.length,
      queuedBytes: this.inboundQueuedBytes,
      oldestQueuedMs: oldestQueuedAt == null ? 0 : Math.max(0, now - oldestQueuedAt),
      activeHandlers,
      oldestActiveHandlerMs: oldestActiveStartedAt == null ? 0 : Math.max(0, now - oldestActiveStartedAt),
      maxHandlerDurationMs: this.inboundMaxHandlerDurationMs,
      overHighWater: this.inboundOverHighWater,
      messageTypes: typeStatsToRecord(this.inboundQueuedTypes),
    };
  }

  /** 记录 handler 最长耗时，不逐请求写日志。 */
  private recordInboundHandlerDuration(durationMs: number): void {
    this.inboundMaxHandlerDurationMs = Math.max(this.inboundMaxHandlerDurationMs, Math.max(0, durationMs));
  }

  /** 聚合入站类型窗口；达到时间或条数阈值时只输出一条诊断。 */
  private recordInboundWindow(messageType: string, bytes: number, now: number): void {
    if (this.inboundWindowMessages > 0 && now - this.inboundWindowStartedAt >= INBOUND_DIAGNOSTIC_WINDOW_MS) {
      this.flushInboundWindow("interval");
    }
    this.inboundWindowMessages += 1;
    this.inboundWindowBytes += bytes;
    incrementTypeStats(this.inboundWindowTypes, messageType, bytes);
    if (this.inboundWindowMessages >= INBOUND_DIAGNOSTIC_MESSAGE_THRESHOLD) {
      this.flushInboundWindow("threshold");
    }
  }

  /** 冲刷当前入站聚合窗口并重置计数。 */
  private flushInboundWindow(reason: "interval" | "threshold" | "stop"): void {
    if (this.inboundWindowMessages === 0) return;
    const now = Date.now();
    this.opts.events.onDiagnostic?.(
      "info",
      `ws inbound window ${JSON.stringify({
        reason,
        startedAt: this.inboundWindowStartedAt,
        durationMs: Math.max(0, now - this.inboundWindowStartedAt),
        messages: this.inboundWindowMessages,
        bytes: this.inboundWindowBytes,
        messageTypes: typeStatsToRecord(this.inboundWindowTypes),
        pressure: this.getInboundPressureSnapshot(now),
        dispatchBoundary: "fifo_invocation_async_completion_concurrent",
      })}`,
    );
    this.inboundWindowStartedAt = now;
    this.inboundWindowMessages = 0;
    this.inboundWindowBytes = 0;
    this.inboundWindowTypes.clear();
  }

  /** 启动固定窗口冲刷，低流量突发也会在 15 秒内留下聚合证据。 */
  private startInboundDiagnosticWindow(): void {
    if (this.inboundDiagnosticTimer) return;
    this.inboundDiagnosticTimer = setInterval(
      () => this.flushInboundWindow("interval"),
      INBOUND_DIAGNOSTIC_WINDOW_MS,
    );
    this.inboundDiagnosticTimer.unref?.();
  }

  /** 停止入站诊断窗口 timer。 */
  private stopInboundDiagnosticWindow(): void {
    if (!this.inboundDiagnosticTimer) return;
    clearInterval(this.inboundDiagnosticTimer);
    this.inboundDiagnosticTimer = null;
  }

  /** 输出高/低水位结构化快照；明确公共 socket 未被暂停。 */
  private reportInboundPressure(level: "info" | "warn", phase: string): void {
    this.opts.events.onDiagnostic?.(
      level,
      `ws inbound pressure ${JSON.stringify({ phase, socketPaused: false, pressure: this.getInboundPressureSnapshot() })}`,
    );
  }

  /** 在握手与三类业务队列间选择一帧，并保证仅一个 send 在途。 */
  private pump(): void {
    if (this.stopped || this.inFlight) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const selection = this.selectNextLane(ws);
    if (!selection) return;
    if (selection.lane === "evidence" || selection.lane === "bulk") this.stopBulkDrainCheck();

    const previousFairnessCursor = this.fairnessCursor;
    const frame = this.takeLane(selection);
    if (!frame) return;
    const send: InFlightSend = { frame, socket: ws };
    this.inFlight = send;
    const sentAt = Date.now();
    this.lastSendAt = sentAt;
    this.lastSendMessageType = frame.messageType;
    this.warnBufferedAmount(ws, frame, sentAt);
    try {
      ws.send(frame.encoded, (error) => this.handleSendCallback(send, error ?? null));
    } catch (error) {
      if (this.inFlight === send) this.inFlight = null;
      const reason = error instanceof Error ? error.message : "ws.send threw";
      const failureReason = `ws.send threw before handoff: ${reason}`;
      if (frame.lane === "hello") {
        frame.result.accepted = false;
        frame.result.reason = `${failureReason}; hello will be rebuilt after reconnect`;
        frame.deliveryFailureReported = true;
      } else {
        this.restoreLane(frame);
      }
      this.fairnessCursor = previousFairnessCursor;
      this.recordSendFailure({
        at: sentAt,
        reason: failureReason,
        messageType: frame.messageType,
        readyState: ws.readyState,
        bufferedAmount: safeBufferedAmount(ws),
        bytes: frame.bytes,
      });
      this.opts.events.onError?.(reason);
      this.terminateAfterSendFailure(ws, reason);
    }
  }

  /** 依次发送 hello 与激活控制消息；完成激活后才开放普通业务队列。 */
  private selectNextLane(ws: WebSocket): LaneSelection | null {
    if (this.helloQueue.length > 0) return { lane: "hello", scheduleIndex: null };
    if (this.activationQueue.length > 0) return { lane: "activation", scheduleIndex: null };
    if (!this.connectionReady) return null;
    for (let offset = 0; offset < FAIR_SCHEDULE.length; offset += 1) {
      const scheduleIndex = (this.fairnessCursor + offset) % FAIR_SCHEDULE.length;
      const lane = FAIR_SCHEDULE[scheduleIndex];
      const candidate = this.peekLane(lane);
      if (!candidate) continue;
      if ((lane === "evidence" || lane === "bulk") && this.shouldPauseBulk(ws, candidate)) continue;
      return { lane, scheduleIndex };
    }
    return null;
  }

  /** 查看指定通道的下一帧。 */
  private peekLane(lane: WsQueueLane): OutboundFrame | null {
    if (lane === "hello") return this.helloQueue.peek();
    if (lane === "activation") return this.activationQueue.peek();
    if (lane === "priority") return this.priorityQueue.peek();
    if (lane === "evidence") return this.evidenceQueue.peek();
    return this.bulkQueue.peek();
  }

  /** 从指定通道取帧，并同步队列字节与公平计数。 */
  private takeLane(selection: LaneSelection): OutboundFrame | null {
    const { lane } = selection;
    const frame = lane === "hello"
      ? this.helloQueue.shift()
      : lane === "activation"
        ? this.activationQueue.shift()
      : lane === "priority"
        ? this.priorityQueue.shift()
        : lane === "evidence"
          ? this.evidenceQueue.shift()
          : this.bulkQueue.shift();
    if (!frame) return null;
    if (lane !== "hello" && lane !== "activation") this.normalQueuedBytes -= frame.bytes;
    if (selection.scheduleIndex !== null) {
      this.fairnessCursor = (selection.scheduleIndex + 1) % FAIR_SCHEDULE.length;
    }
    return frame;
  }

  /** 同步 send 抛错时把未交给底层的帧原位恢复。 */
  private restoreLane(frame: OutboundFrame): void {
    if (frame.lane === "hello") {
      this.helloQueue.unshift(frame);
      return;
    }
    if (frame.lane === "activation") {
      this.activationQueue.unshift(frame);
      return;
    }
    if (frame.lane === "priority") this.priorityQueue.unshift(frame);
    else if (frame.lane === "evidence") this.evidenceQueue.unshift(frame);
    else this.bulkQueue.unshift(frame);
    this.normalQueuedBytes += frame.bytes;
  }

  /** 对 evidence/bulk 使用高低水位滞回；小控制帧仍可越过应用队列。 */
  private shouldPauseBulk(ws: WebSocket, frame: OutboundFrame): boolean {
    const bufferedAmount = safeBufferedAmount(ws);
    if (bufferedAmount === null) {
      this.bulkPaused = false;
      return false;
    }
    if (bufferedAmount >= BUFFER_HIGH_WATER_BYTES) this.bulkPaused = true;
    if (this.bulkPaused && bufferedAmount > BUFFER_LOW_WATER_BYTES) {
      this.warnBufferedAmount(ws, frame, Date.now());
      this.scheduleBulkDrainCheck();
      return true;
    }
    this.bulkPaused = false;
    return false;
  }

  /** 高水位期间定时复查 evidence/bulk，无需依赖 ws 未提供的 drain 事件。 */
  private scheduleBulkDrainCheck(): void {
    if (this.bulkDrainTimer || this.stopped) return;
    this.bulkDrainTimer = setTimeout(() => {
      this.bulkDrainTimer = null;
      this.pump();
    }, BULK_DRAIN_RETRY_MS);
    this.bulkDrainTimer.unref?.();
  }

  /** 清理当前 bulk 水位复查定时器。 */
  private stopBulkDrainCheck(): void {
    if (!this.bulkDrainTimer) return;
    clearTimeout(this.bulkDrainTimer);
    this.bulkDrainTimer = null;
  }

  /** 完成底层 send；callback error 是最终失败，不做不安全重发。 */
  private handleSendCallback(send: InFlightSend, error: Error | null): void {
    if (this.inFlight !== send) {
      if (error) {
        send.frame.result.callbackError = error.message;
        this.opts.events.onError?.(`ws send callback error after close: ${error.message}`);
      }
      return;
    }
    const queue = this.buildQueueDiagnostic();
    this.inFlight = null;
    if (error) {
      const reason = `send callback error: ${error.message}`;
      send.frame.result.callbackError = error.message;
      if (send.frame.lane === "activation") {
        send.frame.result.accepted = false;
        send.frame.result.reason = `${reason}; activation state will be rebuilt after reconnect`;
        send.frame.deliveryFailureReported = true;
        this.recordSendFailure({
          at: Date.now(),
          reason,
          messageType: send.frame.messageType,
          readyState: send.socket.readyState,
          bufferedAmount: safeBufferedAmount(send.socket),
          bytes: send.frame.bytes,
        });
        this.opts.events.onError?.(reason);
        this.terminateAfterSendFailure(send.socket, reason);
        return;
      }
      this.failFrame(send.frame, "send_callback", reason, queue);
      this.opts.events.onError?.(reason);
      this.terminateAfterSendFailure(send.socket, reason);
      return;
    }
    this.pump();
  }

  /** 连接关闭时只保留未交底层业务队列；连接级激活状态由下一次握手重建。 */
  private detachInFlightOnClose(ws: WebSocket, code: number, reasonText: string, reportFailure: boolean): void {
    const send = this.inFlight;
    if (!send || send.socket !== ws) return;
    const queue = this.buildQueueDiagnostic();
    this.inFlight = null;
    const reason = `socket closed before send callback (code=${code}, reason=${reasonText || "none"}); frame not retried`;
    if (send.frame.lane === "activation") {
      send.frame.result.accepted = false;
      send.frame.result.reason = `${reason}; activation state will be rebuilt after reconnect`;
      send.frame.deliveryFailureReported = true;
      this.opts.events.onDiagnostic?.(
        "warn",
        `ws discarded in-flight connection-scoped activation frame bytes=${send.frame.bytes} code=${code} reason=${reasonText || "none"}`,
      );
      return;
    }
    if (reportFailure) {
      this.failFrame(send.frame, "socket_closed", reason, queue);
      return;
    }
    send.frame.result.accepted = false;
    send.frame.result.reason = reason;
    send.frame.deliveryFailureReported = true;
  }

  /** 激活控制消息只属于当前物理连接；未交给底层的旧状态由下一次 helloAck 重建。 */
  private discardQueuedActivationOnClose(code: number, reasonText: string): void {
    let discardedMessages = 0;
    let discardedBytes = 0;
    let frame: OutboundFrame | null;
    while ((frame = this.activationQueue.shift())) {
      const reason = `socket closed before activation handoff (code=${code}, reason=${reasonText || "none"}); activation state will be rebuilt after reconnect`;
      frame.result.accepted = false;
      frame.result.reason = reason;
      frame.deliveryFailureReported = true;
      discardedMessages += 1;
      discardedBytes += frame.bytes;
    }
    if (discardedMessages === 0) return;
    this.opts.events.onDiagnostic?.(
      "warn",
      `ws discarded connection-scoped activation frames count=${discardedMessages} bytes=${discardedBytes} code=${code} reason=${reasonText || "none"}`,
    );
  }

  /** 耐久投递由 SQL 重建；断连旧正文副本明确失败，避免越过重连清理屏障。 */
  private discardQueuedDurableRelayOnClose(code: number, reasonText: string): void {
    const diagnostic = this.buildQueueDiagnostic();
    for (const queue of [this.priorityQueue, this.evidenceQueue, this.bulkQueue]) {
      const retained: OutboundFrame[] = [];
      let frame: OutboundFrame | null;
      while ((frame = queue.shift())) {
        if (!frame.connectionScoped) { retained.push(frame); continue; }
        this.normalQueuedBytes -= frame.bytes;
        this.failFrame(frame, "socket_closed", `connection closed before durable relay handoff (code=${code}, reason=${reasonText}); SQL delivery remains pending`, diagnostic);
      }
      for (const item of retained) queue.push(item);
    }
  }

  /** send 失败后终止当前连接，让 close 生命周期统一重连。 */
  private terminateAfterSendFailure(ws: WebSocket, reason: string): void {
    try {
      ws.terminate();
    } catch (error) {
      const terminateReason = error instanceof Error ? error.message : String(error);
      this.opts.events.onDiagnostic?.("warn", `ws terminate failed after ${reason}: ${terminateReason}`);
      this.opts.events.onError?.(terminateReason);
    }
  }

  /** 将无法安全重发的帧标记为失败，并只通知上层一次。 */
  private failFrame(frame: OutboundFrame, phase: WsDeliveryFailure["phase"], reason: string, queue: WsQueueDiagnostic): void {
    frame.result.accepted = false;
    frame.result.reason = reason;
    if (frame.deliveryFailureReported) return;
    frame.deliveryFailureReported = true;
    const at = Date.now();
    this.recordSendFailure({
      at,
      reason,
      messageType: frame.messageType,
      readyState: this.ws?.readyState ?? null,
      bufferedAmount: this.ws ? safeBufferedAmount(this.ws) : null,
      bytes: frame.bytes,
    });
    this.opts.events.onDeliveryFailure?.({
      at,
      phase,
      messageType: frame.messageType,
      bytes: frame.bytes,
      reason,
      queue,
    });
  }

  /** 拒绝超出有界队列的新帧，并同步发出一次最终失败事件。 */
  private rejectQueueOverflow(input: {
    queuedAt: number;
    messageType: string | null;
    readyState: number | null;
    bufferedAmount: number | null;
    bytes: number;
    reason: string;
  }): WsSendJsonResult {
    const result = this.rejectSend(input);
    this.opts.events.onDeliveryFailure?.({
      at: input.queuedAt,
      phase: "queue_overflow",
      messageType: input.messageType,
      bytes: input.bytes,
      reason: input.reason,
      queue: this.buildQueueDiagnostic(),
    });
    return result;
  }

  /** 生成可供关闭、停止与投递失败共同使用的队列快照。 */
  private buildQueueDiagnostic(): WsQueueDiagnostic {
    const helloBytes = this.helloQueue.peek()?.bytes ?? 0;
    const activationBytes = this.activationQueue.totalBytes();
    const inFlight = this.inFlight?.frame ?? null;
    const inbound = this.getInboundPressureSnapshot();
    return {
      connectionReady: this.connectionReady,
      socketReadyState: this.ws?.readyState ?? null,
      socketBufferedAmount: this.ws ? safeBufferedAmount(this.ws) : null,
      queuedMessages: this.helloQueue.length + this.activationQueue.length + this.priorityQueue.length + this.evidenceQueue.length + this.bulkQueue.length,
      queuedBytes: helloBytes + activationBytes + this.normalQueuedBytes,
      maxQueuedMessages: this.maxQueuedMessages,
      maxQueuedBytes: this.maxQueuedBytes,
      helloMessages: this.helloQueue.length,
      activationMessages: this.activationQueue.length,
      priorityMessages: this.priorityQueue.length,
      evidenceMessages: this.evidenceQueue.length,
      evidencePartitions: this.evidenceQueue.partitionCount,
      bulkMessages: this.bulkQueue.length,
      inboundMessages: inbound.queuedMessages,
      inboundBytes: inbound.queuedBytes,
      inboundOldestQueuedMs: inbound.oldestQueuedMs,
      inboundActiveHandlers: inbound.activeHandlers,
      inboundOldestActiveHandlerMs: inbound.oldestActiveHandlerMs,
      inboundMaxHandlerDurationMs: inbound.maxHandlerDurationMs,
      inboundTypes: inbound.messageTypes,
      inboundOverHighWater: inbound.overHighWater,
      inboundHighWaterMessages: this.inboundHighWaterMessages,
      inboundHighWaterBytes: this.inboundHighWaterBytes,
      inFlight: inFlight
        ? {
          messageType: inFlight.messageType,
          bytes: inFlight.bytes,
          lane: inFlight.lane,
          queuedAt: inFlight.queuedAt,
        }
        : null,
    };
  }

  /** 对底层缓冲高水位日志做限频，并附带当前帧信息。 */
  private warnBufferedAmount(ws: WebSocket, frame: OutboundFrame, now: number): void {
    const bufferedAmount = safeBufferedAmount(ws);
    if (bufferedAmount === null || bufferedAmount < BUFFER_HIGH_WATER_BYTES) return;
    if (now - this.lastBufferedAmountWarnAt < 5_000) return;
    this.lastBufferedAmountWarnAt = now;
    this.opts.events.onDiagnostic?.(
      "warn",
      `ws bufferedAmount high=${bufferedAmount} messageType=${frame.messageType ?? "unknown"} bytes=${frame.bytes} queue=${JSON.stringify(this.buildQueueDiagnostic())}`,
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const base = Math.min(1500 * Math.pow(2, this.reconnectAttempt), 30_000);
    const jitter = base * 0.2 * Math.random();
    const delay = Math.floor(base + jitter);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // 不使用 unref：首次连接失败且无其它事件源时，Node 可能提前退出，导致 client 无法持续重连。
  }

  /**
   * 客户端心跳检测：如果 server 曾发过 ping 但之后停了（server 崩溃），
   * 超过 HEARTBEAT_MISS_LIMIT * HEARTBEAT_CHECK_MS 未收到新 ping 则主动关闭并重连。
   * 若 server 未升级（不发 ping），则不做检测（向后兼容）。
   */
  private startHeartbeatCheck(ws: WebSocket): void {
    this.stopHeartbeatCheck();
    this.heartbeatTimer = setInterval(() => {
      if (!this.serverPingReceived) return; // server 未发过 ping，跳过检测
      const elapsed = Date.now() - this.lastPingAt;
      if (elapsed > HEARTBEAT_CHECK_MS * HEARTBEAT_MISS_LIMIT) {
        this.opts.events.onDiagnostic?.("warn", `server heartbeat timeout: no ping for ${elapsed}ms (limit=${HEARTBEAT_CHECK_MS * HEARTBEAT_MISS_LIMIT}ms)`);
        this.stopHeartbeatCheck();
        try {
          ws.close(1000, "server heartbeat timeout");
        } catch {
          ws.terminate();
        }
      }
    }, HEARTBEAT_CHECK_MS);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 汇总连接状态与队列状态，供 close 事件追踪未投递边界。 */
  private buildCloseDiagnostic(now: number, ws: WebSocket | null): WsCloseDiagnostic {
    return {
      connectedAt: this.connectedAt > 0 ? this.connectedAt : null,
      lastPingAt: this.lastPingAt > 0 ? this.lastPingAt : null,
      msSinceLastPing: this.lastPingAt > 0 ? now - this.lastPingAt : null,
      lastMessageAt: this.lastMessageAt > 0 ? this.lastMessageAt : null,
      msSinceLastMessage: this.lastMessageAt > 0 ? now - this.lastMessageAt : null,
      lastSendAt: this.lastSendAt > 0 ? this.lastSendAt : null,
      msSinceLastSend: this.lastSendAt > 0 ? now - this.lastSendAt : null,
      lastSendMessageType: this.lastSendMessageType,
      bufferedAmount: ws ? safeBufferedAmount(ws) : null,
      sendFailureCount: this.sendFailureCount,
      lastSendFailure: this.lastSendFailure,
      queue: this.buildQueueDiagnostic(),
    };
  }

  /** 记录同步拒绝并返回与上层兼容的失败结果。 */
  private rejectSend(input: {
    queuedAt: number;
    messageType: string | null;
    readyState: number | null;
    bufferedAmount: number | null;
    bytes: number;
    reason: string;
  }): WsSendJsonResult {
    this.recordSendFailure({
      at: input.queuedAt,
      reason: input.reason,
      messageType: input.messageType,
      readyState: input.readyState,
      bufferedAmount: input.bufferedAmount,
      bytes: input.bytes,
    });
    return {
      accepted: false,
      messageType: input.messageType,
      readyState: input.readyState,
      bufferedAmount: input.bufferedAmount,
      bytes: input.bytes,
      reason: input.reason,
      queuedAt: input.queuedAt,
      callbackError: null,
    };
  }

  /** 保存最近一次发送失败并输出可检索诊断。 */
  private recordSendFailure(input: {
    at: number;
    messageType: string | null;
    readyState: number | null;
    bufferedAmount: number | null;
    bytes: number;
    reason: string;
  }): void {
    this.sendFailureCount += 1;
    this.lastSendFailure = {
      at: input.at,
      reason: input.reason,
      messageType: input.messageType,
      readyState: input.readyState,
    };
    this.opts.events.onDiagnostic?.(
      "warn",
      `ws send rejected type=${input.messageType ?? "unknown"} readyState=${describeReadyState(input.readyState)} buffered=${input.bufferedAmount ?? "n/a"} bytes=${input.bytes} reason=${input.reason}`,
    );
  }
}

/** 将握手、小交互响应和 bulk/evidence 帧映射到唯一调度通道。 */
function resolveQueueLane(messageType: string | null, bytes: number): WsQueueLane {
  if (messageType === "client.hello") return "hello";
  if (messageType && ACTIVATION_CONTROL_TYPES.has(messageType)) return "activation";
  if (messageType && EVIDENCE_TYPES.has(messageType)) return "evidence";
  if (messageType && SMALL_PRIORITY_TYPES.has(messageType) && bytes <= SMALL_PRIORITY_MAX_BYTES) return "priority";
  return "bulk";
}

/** 读取正整数配置；无效值回落到生产默认值。 */
function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function resolveMessageType(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const t = (obj as Record<string, unknown>).t;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** 解析入站 JSON 供类型聚合与上层复用；非法 JSON 保留原文本交给现有解析失败日志。 */
function parseInboundData(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 判断返回值是否为可等待对象。 */
function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return Boolean(value && typeof value === "object" && typeof (value as PromiseLike<void>).then === "function");
}

/** 累加按消息类型分组的条数与字节数。 */
function incrementTypeStats(
  target: Map<string, { messages: number; bytes: number }>,
  messageType: string,
  bytes: number,
): void {
  const current = target.get(messageType);
  if (current) {
    current.messages += 1;
    current.bytes += bytes;
    return;
  }
  target.set(messageType, { messages: 1, bytes });
}

/** 从当前队列类型统计中移除一个已分发帧。 */
function decrementTypeStats(
  target: Map<string, { messages: number; bytes: number }>,
  messageType: string,
  bytes: number,
): void {
  const current = target.get(messageType);
  if (!current) return;
  current.messages = Math.max(0, current.messages - 1);
  current.bytes = Math.max(0, current.bytes - bytes);
  if (current.messages === 0) target.delete(messageType);
}

/** 复制 Map，避免外部修改传输内部统计。 */
function typeStatsToRecord(target: Map<string, { messages: number; bytes: number }>): Record<string, { messages: number; bytes: number }> {
  return Object.fromEntries(Array.from(target.entries(), ([messageType, stats]) => [messageType, { ...stats }]));
}

/** 提取 evidence 所属 thread；跨 thread 合批帧保持为独立共享分区。 */
function resolveEvidencePartitionKey(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "__global__";
  const message = obj as Record<string, unknown>;
  const directThreadId = readNonEmptyString(message.threadId);
  if (directThreadId) return `thread:${directThreadId}`;

  const event = message.event && typeof message.event === "object"
    ? message.event as Record<string, unknown>
    : null;
  const eventThreadId = readNonEmptyString(event?.threadId)
    ?? readNonEmptyString(
      event?.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>).threadId
        : null,
    );
  if (eventThreadId) return `thread:${eventThreadId}`;

  if (Array.isArray(message.events)) {
    const threadIds = new Set(
      message.events
        .map((item) => item && typeof item === "object"
          ? readNonEmptyString((item as Record<string, unknown>).threadId)
          : null)
        .filter((value): value is string => Boolean(value)),
    );
    if (threadIds.size === 1) return `thread:${threadIds.values().next().value}`;
  }

  const workspaceId = readNonEmptyString(message.workspaceId) ?? readNonEmptyString(event?.workspaceId);
  return workspaceId ? `workspace:${workspaceId}` : "__global__";
}

/** 将未知值规整为非空字符串。 */
function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function safeBufferedAmount(ws: WebSocket): number | null {
  const value = (ws as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeReadyState(state: number | null): string {
  if (state === null || state === undefined) return "null";
  if (state === WebSocket.CONNECTING) return "CONNECTING";
  if (state === WebSocket.OPEN) return "OPEN";
  if (state === WebSocket.CLOSING) return "CLOSING";
  if (state === WebSocket.CLOSED) return "CLOSED";
  return String(state);
}
