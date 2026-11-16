import type { OrchNodeRuntimeBreakdown } from "@codeflowai/shared";

/** 一个节点的某个尝试线程的运行事实：时间线 + 工具调用/结果事件正文。 */
export type OrchThreadRuntimeFacts = {
  /** 该线程全部引擎事件的时间戳（毫秒，升序）。 */
  eventTimestamps: number[];
  /** 仅含 tool_use / tool_result 的事件正文（原始 stream-json 行），避免把全量事件正文送进聚合。 */
  toolEvents: Array<{ ts: number; json: string }>;
};

const TOOL_DETAIL_KEYS = ["command", "file_path", "pattern", "path", "url", "prompt"] as const;
/** 判定「这是一次测试执行」的命令特征；用于统计测试命令次数。 */
const TEST_COMMAND_PATTERN = /(?:playwright|vitest|jest|node\s+--test|--test\b|test:e2e|\bpnpm\s+(?:-C\s+\S+\s+)?(?:exec\s+)?test\b|\bnpm\s+(?:run\s+)?test\b|\byarn\s+test\b)/iu;
const SLOWEST_CALL_LIMIT = 5;
const DETAIL_MAX_CHARS = 140;
/** 只有 ≥ 该秒数的空档才可能是心跳；更短的间隔属正常事件密度。 */
const HEARTBEAT_MIN_SECONDS = 20;
const HEARTBEAT_TOLERANCE_SECONDS = 1;
/** 同一间隔至少出现该次数才认定为心跳，避免把单次真实卡顿误判成心跳而掩盖问题。 */
const HEARTBEAT_MIN_OCCURRENCES = 2;

type ToolCallFact = { toolUseId: string; tool: string; detail: string; startedAt: number };
type ToolResultFact = { toolUseId: string; endedAt: number };

/**
 * 把节点的若干尝试线程聚合成耗时分解。
 * 纯函数：只做解析与统计，不读写数据库，便于用构造事件覆盖各分支。
 */
export function computeOrchNodeRuntimeBreakdown(
  factsList: readonly OrchThreadRuntimeFacts[],
  options: { now?: () => number } = {},
): OrchNodeRuntimeBreakdown {
  const now = options.now ?? Date.now;
  const timestamps: number[] = [];
  const calls = new Map<string, ToolCallFact>();
  const results = new Map<string, ToolResultFact>();
  for (const facts of factsList) {
    for (const ts of facts.eventTimestamps) if (Number.isFinite(ts)) timestamps.push(Number(ts));
    for (const event of facts.toolEvents) {
      const parsed = readToolBlocks(event.json, Number(event.ts));
      for (const call of parsed.calls) {
        const existing = calls.get(call.toolUseId);
        if (!existing) {
          calls.set(call.toolUseId, call);
          continue;
        }
        // 流式 content_block_start 形态的 input 是空的，必须让后到的 assistant 正文补齐摘要
        // （否则命令摘要会丢、测试命令统计会漏），但调用起点仍取最早观测到的时间。
        if (!existing.detail && call.detail) {
          calls.set(call.toolUseId, { ...call, startedAt: Math.min(existing.startedAt, call.startedAt) });
        }
      }
      for (const result of parsed.results) if (!results.has(result.toolUseId)) results.set(result.toolUseId, result);
    }
  }
  timestamps.sort((left, right) => left - right);

  const countsByTool = new Map<string, number>();
  const slowest: OrchNodeRuntimeBreakdown["slowestCalls"] = [];
  let testCommandCount = 0;
  for (const call of calls.values()) {
    countsByTool.set(call.tool, (countsByTool.get(call.tool) ?? 0) + 1);
    if (call.tool.toLowerCase() === "bash" && TEST_COMMAND_PATTERN.test(call.detail)) testCommandCount += 1;
    const result = results.get(call.toolUseId);
    // 没有结果的调用（例如仍在执行）不参与耗时排序，但已计入调用次数。
    if (!result || result.endedAt <= call.startedAt) continue;
    slowest.push({
      tool: call.tool,
      seconds: roundSeconds((result.endedAt - call.startedAt) / 1000),
      detail: call.detail,
      startedAt: call.startedAt,
    });
  }
  slowest.sort((left, right) => right.seconds - left.seconds || left.startedAt - right.startedAt);
  const silence = readSilence(timestamps);

  return {
    threadCount: factsList.length,
    eventCount: timestamps.length,
    startedAt: timestamps.length ? timestamps[0]! : null,
    endedAt: timestamps.length ? timestamps[timestamps.length - 1]! : null,
    toolCallCount: calls.size,
    toolCallsByTool: [...countsByTool.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool)),
    slowestCalls: slowest.slice(0, SLOWEST_CALL_LIMIT),
    testCommandCount,
    heartbeatSeconds: silence.heartbeatSeconds,
    maxSilenceSeconds: silence.maxSilenceSeconds,
    maxSilenceStartedAt: silence.maxSilenceStartedAt,
    computedAt: now(),
  };
}

/** 从一条原始引擎事件里抽出工具调用与工具结果，兼容 assistant 正文与流式 content_block 两种形态。 */
function readToolBlocks(eventJson: string, fallbackTs: number): { calls: ToolCallFact[]; results: ToolResultFact[] } {
  const calls: ToolCallFact[] = [];
  const results: ToolResultFact[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch {
    return { calls, results };
  }
  const data = (parsed as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return { calls, results };
  // 事件自身的时间戳优先；缺失时退回行内 ts，保证耗时可比。
  const parsedTs = Number((parsed as { ts?: unknown }).ts);
  const eventTs = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : fallbackTs;
  const message = data.message as { content?: unknown } | undefined;
  const streamEvent = data.event as { content_block?: unknown } | undefined;
  const blocks: unknown[] = Array.isArray(message?.content)
    ? message!.content as unknown[]
    : streamEvent?.content_block ? [streamEvent.content_block] : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    const kind = String(record.type ?? "");
    if (kind === "tool_use") {
      const toolUseId = String(record.id ?? "");
      if (!toolUseId) continue;
      calls.push({
        toolUseId,
        tool: String(record.name ?? "unknown"),
        detail: readToolDetail(record.input),
        startedAt: eventTs,
      });
      continue;
    }
    if (kind === "tool_result") {
      const toolUseId = String(record.tool_use_id ?? "");
      if (!toolUseId) continue;
      results.push({ toolUseId, endedAt: eventTs });
    }
  }
  return { calls, results };
}

/** 取一个可读的调用摘要（命令 / 路径 / 模式），不泄漏工具入参全文。 */
function readToolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/gu, " ").trim().slice(0, DETAIL_MAX_CHARS);
    }
  }
  return "";
}

/**
 * 计算静默段：心跳是「出现次数最多的长间隔」，真实静默是排除心跳后的最大间隔。
 * 无法识别心跳（长间隔都只出现一次）时不排除任何间隔——宁可报出可疑卡顿，也不要静默掩盖。
 */
function readSilence(timestamps: readonly number[]): {
  heartbeatSeconds: number | null;
  maxSilenceSeconds: number;
  maxSilenceStartedAt: number | null;
} {
  const gaps: Array<{ seconds: number; startedAt: number }> = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = Number(timestamps[index]) - Number(timestamps[index - 1]);
    if (delta <= 0) continue;
    const seconds = delta / 1000;
    if (seconds < HEARTBEAT_MIN_SECONDS) continue;
    gaps.push({ seconds, startedAt: Number(timestamps[index - 1]) });
  }
  const counts = new Map<number, number>();
  for (const gap of gaps) {
    const key = Math.round(gap.seconds);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let heartbeatSeconds: number | null = null;
  let bestCount = 0;
  for (const [key, count] of [...counts.entries()].sort((left, right) => left[0] - right[0])) {
    if (count > bestCount) {
      heartbeatSeconds = key;
      bestCount = count;
    }
  }
  if (bestCount < HEARTBEAT_MIN_OCCURRENCES) heartbeatSeconds = null;
  const realGaps = heartbeatSeconds === null
    ? gaps
    : gaps.filter((gap) => Math.abs(gap.seconds - heartbeatSeconds!) > HEARTBEAT_TOLERANCE_SECONDS);
  let worst: { seconds: number; startedAt: number } | null = null;
  for (const gap of realGaps) if (!worst || gap.seconds > worst.seconds) worst = gap;
  return {
    heartbeatSeconds,
    maxSilenceSeconds: worst ? roundSeconds(worst.seconds) : 0,
    maxSilenceStartedAt: worst ? worst.startedAt : null,
  };
}

/** 秒数保留一位小数，避免界面出现长尾浮点。 */
function roundSeconds(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}
