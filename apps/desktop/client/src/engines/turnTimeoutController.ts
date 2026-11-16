import type { ConversationEventInput, RawEngineEventInput } from "@codeflowai/shared";

import type { ConversationEmitFn, RawEmitFn, TurnTimeoutPolicy } from "./threadSession.js";

type TimeoutCode =
  | "legacy_turn_timeout"
  | "engine_idle_timeout";

type ActiveTool = {
  itemId: string;
  toolName?: string;
  startedAt: number;
};

type ActiveSubagent = {
  itemId: string;
  taskId: string;
  description: string;
  toolUseId?: string;
  startedAt: number;
};

type TimeoutTriggerDetail =
  | { code: "legacy_turn_timeout"; idleMs: number; phase: "legacy-turn" }
  | { code: "engine_idle_timeout"; idleMs: number; phase: "engine" };

type TimeoutDetail = TimeoutTriggerDetail & {
  timeoutSequence: number;
};

type TimeoutDiagnosticSnapshot = {
  engineIdleTimeoutMs: number | null;
  lastActivityAt: number;
  lastActivitySource: string;
  lastActivityType: string;
  activeToolCount: number;
  activeSubagentCount: number;
  waitingApprovalCount: number;
  waitingUserInputCount: number;
};

type TimeoutControllerOptions = {
  workspaceId: string;
  threadId: string;
  engine: "claude" | "codex";
  turnId: string;
  policy: TurnTimeoutPolicy;
  emitConversation: ConversationEmitFn;
  emitRaw: RawEmitFn;
  onTimeout: (error: EngineTimeoutError) => void;
  now?: () => number;
};

export class EngineTimeoutError extends Error {
  readonly code: TimeoutCode;
  readonly detail: TimeoutDetail;

  constructor(message: string, detail: TimeoutDetail) {
    super(message);
    this.name = "EngineTimeoutError";
    this.code = detail.code;
    this.detail = detail;
  }
}

export class TurnTimeoutController {
  private readonly now: () => number;
  private readonly approvals = new Set<string>();
  private readonly userInputs = new Set<string>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activeSubagents = new Map<string, ActiveSubagent>();
  private lastEngineActivityAt = 0;
  private engineTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private timedOut = false;
  private timeoutSequence = 0;
  private lastActivitySource = "timeout.controller";
  private lastActivityType = "monitoring_started";

  constructor(private readonly opts: TimeoutControllerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** 启动既有超时策略，并建立首个安全活动基线。 */
  start(): void {
    if (this.stopped || this.timedOut) return;
    this.recordEngineActivity("timeout.controller", "monitoring_started");
    if (this.opts.policy.mode === "legacy-turn") {
      this.legacyTimer = setTimeout(() => {
        const idleMs = this.now() - this.lastEngineActivityAt;
        this.fireTimeout({
          code: "legacy_turn_timeout",
          idleMs,
          phase: "legacy-turn",
        });
      }, this.opts.policy.timeoutMs);
      this.legacyTimer.unref?.();
      return;
    }
    this.rescheduleEngineTimer();
  }

  stop(): void {
    this.stopped = true;
    this.clearAllTimers();
    this.approvals.clear();
    this.userInputs.clear();
    this.activeTools.clear();
    this.activeSubagents.clear();
  }

  /** Provider 权威状态仍在运行时重新武装 activity watchdog。 */
  resumeAfterTimeout(reason: string): boolean {
    if (this.stopped || !this.timedOut || this.opts.policy.mode !== "activity") return false;
    this.timedOut = false;
    this.recordEngineActivity("timeout.controller", "monitoring_resumed");
    this.opts.emitRaw({
      ts: this.lastEngineActivityAt,
      workspaceId: this.opts.workspaceId as any,
      threadId: this.opts.threadId as any,
      engine: this.opts.engine,
      source: "timeout.controller",
      data: {
        turnId: this.opts.turnId,
        code: "engine_idle_timeout",
        phase: "engine",
        timeoutSequence: this.timeoutSequence,
        recovery: "monitoring_resumed",
        reason: String(reason ?? "").trim(),
        ...this.buildDiagnosticSnapshot(),
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });
    this.rescheduleEngineTimer();
    return true;
  }

  /** 用 raw 事件的协议标识刷新活动时间，不保留事件正文。 */
  onRawEvent(event: RawEngineEventInput): void {
    if (this.stopped || this.timedOut) return;
    if (this.opts.policy.mode !== "activity") return;
    const source = String(event.source ?? "raw.event");
    const type = readRawActivityType(event);
    this.touchEngine(source, type);
    // 保留 stderr 原有的第二次 touch 时序，避免诊断改动挪动 watchdog deadline。
    if (event.source === "claude.stderr" && type === "line") this.touchEngine(source, type);
  }

  /** 用映射后的事件类型刷新活动时间，并维护既有等待/工具状态。 */
  onConversationEvent(event: ConversationEventInput): void {
    if (this.stopped || this.timedOut) return;
    if (this.opts.policy.mode !== "activity") return;
    this.touchEngine("conversation.event", event.type);

    if (event.type === "approval.request") {
      this.approvals.add(String((event.payload as any)?.requestId ?? ""));
      this.rescheduleEngineTimer();
      return;
    }
    if (event.type === "approval.resolved" || event.type === "approval.expired") {
      this.approvals.delete(String((event.payload as any)?.requestId ?? ""));
      this.rescheduleEngineTimer();
      return;
    }
    if (event.type === "userInput.requested") {
      // 异步问题不阻塞 provider，继续检测其真实活动超时。
      if (event.payload.request.params.delivery === "async") return;
      this.userInputs.add(String((event.payload as any)?.request?.requestId ?? ""));
      this.rescheduleEngineTimer();
      return;
    }
    if (event.type === "userInput.resolved" || event.type === "userInput.expired") {
      const requestId =
        event.type === "userInput.resolved"
          ? String((event.payload as any)?.response?.requestId ?? "")
          : String((event.payload as any)?.requestId ?? "");
      this.userInputs.delete(requestId);
      this.rescheduleEngineTimer();
      return;
    }

    if (event.type === "item.tool.started") {
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      if (!itemId) return;
      const toolName = String((event.payload as any)?.toolName ?? "").trim() || undefined;
      const startedAt = Number(event.ts ?? this.now());
      const active: ActiveTool = {
        itemId,
        toolName,
        startedAt,
      };
      this.activeTools.set(itemId, active);
      this.rescheduleEngineTimer();
      return;
    }

    if (event.type === "item.tool.inputUpdated" || event.type === "item.tool.outputDelta") {
      return;
    }

    if (event.type === "item.tool.completed") {
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      this.completeTool(itemId);
      return;
    }

    if (event.type === "item.subagent.started") {
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      const taskId = String((event.payload as any)?.taskId ?? "").trim();
      if (!itemId || !taskId) return;
      const startedAt = Number(event.ts ?? this.now());
      const active: ActiveSubagent = {
        itemId,
        taskId,
        description: String((event.payload as any)?.description ?? "").trim(),
        toolUseId: String((event.payload as any)?.toolUseId ?? "").trim() || undefined,
        startedAt,
      };
      this.activeSubagents.set(itemId, active);
      this.rescheduleEngineTimer();
      return;
    }

    if (event.type === "item.subagent.progress") {
      return;
    }

    if (event.type === "item.subagent.childEvent") {
      return;
    }

    if (event.type === "item.subagent.completed") {
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      this.completeSubagent(itemId);
    }
  }

  /** 记录安全的活动来源元数据并重新计算 watchdog。 */
  private touchEngine(source: string, type: string): void {
    this.recordEngineActivity(source, type);
    this.rescheduleEngineTimer();
  }

  /** 只记录事件到达时间与类型，不保存原始正文。 */
  private recordEngineActivity(source: string, type: string): void {
    this.lastEngineActivityAt = this.now();
    this.lastActivitySource = String(source ?? "").trim() || "unknown";
    this.lastActivityType = String(type ?? "").trim() || "unknown";
  }

  private completeTool(itemId: string): void {
    if (!itemId) return;
    const active = this.activeTools.get(itemId);
    if (!active) return;
    this.activeTools.delete(itemId);
    this.rescheduleEngineTimer();
  }

  private completeSubagent(itemId: string): void {
    if (!itemId) return;
    const active = this.activeSubagents.get(itemId);
    if (!active) return;
    this.activeSubagents.delete(itemId);
    this.rescheduleEngineTimer();
  }

  private rescheduleEngineTimer(): void {
    if (this.opts.policy.mode !== "activity") return;
    if (this.engineTimer) {
      clearTimeout(this.engineTimer);
      this.engineTimer = null;
    }
    if (!this.shouldMonitorEngine()) return;
    const delay = Math.max(1, this.opts.policy.engineIdleTimeoutMs);
    this.engineTimer = setTimeout(() => {
      this.fireTimeout({
        code: "engine_idle_timeout",
        idleMs: this.now() - this.lastEngineActivityAt,
        phase: "engine",
      });
    }, delay);
    this.engineTimer.unref?.();
  }

  private shouldMonitorEngine(): boolean {
    if (this.stopped || this.timedOut) return false;
    if (this.approvals.size > 0 || this.userInputs.size > 0) return false;
    // Provider-native tool/subagent lifecycles are owned by the engine; while any
    // are active, the client-side watchdog should not infer a local timeout.
    if (this.activeTools.size > 0 || this.activeSubagents.size > 0) return false;
    return true;
  }

  /** 触发既有超时结算，并为本次 watchdog 周期附加诊断快照。 */
  private fireTimeout(trigger: TimeoutTriggerDetail): void {
    if (this.stopped || this.timedOut) return;
    this.timedOut = true;
    this.clearAllTimers();
    const detail: TimeoutDetail = {
      ...trigger,
      timeoutSequence: ++this.timeoutSequence,
    };
    const diagnosticSnapshot = this.buildDiagnosticSnapshot();

    const error = createTimeoutError(detail);
    this.opts.emitRaw({
      ts: this.now(),
      workspaceId: this.opts.workspaceId as any,
      threadId: this.opts.threadId as any,
      engine: this.opts.engine,
      source: "timeout.controller",
      data: {
        turnId: this.opts.turnId,
        code: detail.code,
        phase: detail.phase,
        idleMs: detail.idleMs,
        timeoutSequence: detail.timeoutSequence,
        ...diagnosticSnapshot,
        itemId: null,
        toolName: null,
        taskId: null,
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });
    this.opts.onTimeout(error);
  }

  /** 生成不含 prompt、工具输出和凭据的 timeout 状态快照。 */
  private buildDiagnosticSnapshot(): TimeoutDiagnosticSnapshot {
    return {
      engineIdleTimeoutMs: this.opts.policy.mode === "activity" ? this.opts.policy.engineIdleTimeoutMs : null,
      lastActivityAt: this.lastEngineActivityAt,
      lastActivitySource: this.lastActivitySource,
      lastActivityType: this.lastActivityType,
      activeToolCount: this.activeTools.size,
      activeSubagentCount: this.activeSubagents.size,
      waitingApprovalCount: this.approvals.size,
      waitingUserInputCount: this.userInputs.size,
    };
  }

  private clearAllTimers(): void {
    if (this.engineTimer) {
      clearTimeout(this.engineTimer);
      this.engineTimer = null;
    }
    if (this.legacyTimer) {
      clearTimeout(this.legacyTimer);
      this.legacyTimer = null;
    }
  }
}

export function normalizeTurnTimeoutPolicy(input: TurnTimeoutPolicy | undefined, legacyTimeoutMs: number | undefined): TurnTimeoutPolicy {
  if (input) return input;
  return {
    mode: "legacy-turn",
    timeoutMs: Math.max(10_000, Number(legacyTimeoutMs ?? 15 * 60_000)),
    startupTimeoutMs: 90_000,
  };
}

function createTimeoutError(detail: TimeoutDetail): EngineTimeoutError {
  switch (detail.code) {
    case "legacy_turn_timeout":
      return new EngineTimeoutError(`AI 运行超时（单轮硬超时，${detail.idleMs}ms）`, detail);
    case "engine_idle_timeout":
      return new EngineTimeoutError(`AI 长时间无活动（${detail.idleMs}ms）`, detail);
  }
}

/** 仅接受短协议标识符；自由文本或畸形值统一回退为 raw。 */
function readRawActivityType(event: RawEngineEventInput): string {
  const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : null;
  if (event.source === "claude.stderr" && String(data?.line ?? "").trim()) return "line";
  const candidate = typeof data?.method === "string" ? data.method : typeof data?.type === "string" ? data.type : "";
  const normalized = candidate.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) return "raw";
  return normalized;
}

