import type { ApiResult, DesktopApiRequest, OrchestrationMetricCollectRequest, OrchestrationMetricCollectResponse, OrchestrationMetricTraceFact } from "@codeflowai/shared";

type MetricFilters = OrchestrationMetricCollectRequest["filters"];
type Collect = (request: DesktopApiRequest) => Promise<ApiResult<OrchestrationMetricCollectResponse>>;
export type DesktopMetricsFailure = { code: string; requestId: string; workspaceId: string; message: string };
export type DesktopMetricsState = {
  workspaceId: string;
  loading: boolean;
  pages: OrchestrationMetricCollectResponse[];
  error: DesktopMetricsFailure | null;
};

/** 本机度量状态仅属于当前工作区，不读取账号或云端缓存。 */
export function createDesktopMetricsState(): DesktopMetricsState {
  return { workspaceId: "", loading: false, pages: [], error: null };
}

/** 使用原 collect 游标逐页读取；失败停止，取消或切换后拒绝迟到结果。 */
export function createDesktopMetricsReader(collect: Collect, state: DesktopMetricsState, options: { pageSize?: number } = {}) {
  let generation = 0;
  let filters: MetricFilters;
  const limit = options.pageSize ?? 50;

  /** 切换范围立即移除旧事实，同时令在途请求失效。 */
  function select(workspaceId: string, nextFilters?: MetricFilters): void {
    generation += 1;
    filters = nextFilters;
    Object.assign(state, createDesktopMetricsState(), { workspaceId });
  }

  /** 取消只失效在途读取，已经成功展示的事实仍保留。 */
  function cancel(): void {
    generation += 1;
    state.loading = false;
  }

  /** 每次仅加载一页，后续游标与快照身份沿用 Client 响应，禁止混入新采集事实。 */
  async function load(requestId: string): Promise<void> {
    if (state.loading) throw new Error("本机度量正在读取");
    if (state.error) throw new Error("采集已失败，请刷新后重试");
    if (!state.workspaceId) throw new Error("请先选择本机工作区");
    const previous = state.pages.at(-1);
    if (previous && !previous.hasMore) throw new Error("本机度量已加载全部数据");
    const version = generation;
    const workspaceId = state.workspaceId;
    const cursor = previous?.nextCursor ?? null;
    state.loading = true;
    state.error = null;
    try {
      const result = await collect({ method: "orch.metrics.collect", body: {
        workspaceId, scope: { scopeKind: "mine", scopeId: null }, filters, cursor, limit, snapshotId: previous?.snapshotId ?? null,
      } });
      assertCurrent();
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      if (result.sourceWorkspaceId !== workspaceId || !Array.isArray(result.instances) || !Array.isArray(result.nodes)
        || (previous?.snapshotId !== undefined && result.snapshotId !== previous.snapshotId)
        || result.instances.some(item => item.sourceWorkspaceId !== workspaceId)
        || typeof result.hasMore !== "boolean" || !result.coverage
        || (result.traceFacts !== undefined && !Array.isArray(result.traceFacts))
        || (result.hasMore && (!result.nextCursor || !/^\d+$/u.test(result.nextCursor) || Number(result.nextCursor) <= Number(cursor ?? 0)))) {
        throw Object.assign(new Error("本机度量响应的工作区或分页事实无效"), { code: "DESKTOP_METRICS_RESPONSE_INVALID" });
      }
      summarizeDesktopMetrics([...state.pages, result]);
      state.pages = [...state.pages, result];
    } catch (cause) {
      assertCurrent();
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "DESKTOP_METRICS_COLLECT_FAILED";
      state.error = { code, requestId, workspaceId, message };
      throw cause;
    } finally {
      if (version === generation) state.loading = false;
    }

    /** 已变更的选择属于显式取消，不能写入新工作区的成功或失败状态。 */
    function assertCurrent(): void {
      if (version !== generation) throw Object.assign(new Error("本机度量读取已取消"), { name: "AbortError", requestId, workspaceId });
    }
  }
  return { select, cancel, load };
}

/** 只有全部用量事件覆盖的字段可展示；无标记或部分缺失保留未知。 */
export function readDesktopMetricToken(trace: OrchestrationMetricTraceFact, field: "inputTokens" | "outputTokens" | "totalTokens"): number | null {
  if (trace.tokenUsageCoverage?.[field] !== true) return null;
  const value = trace[field];
  if (!Number.isFinite(value) || value < 0) throw new Error("本机度量事实包含无效的 Token 数量");
  return value;
}

/** 汇总已加载事实；未知耗时与缺失 Token 证据保留为空，禁止估算账单。 */
export function summarizeDesktopMetrics(pages: OrchestrationMetricCollectResponse[]) {
  const instances = [...new Map(pages.flatMap(page => page.instances).map(item => [item.sourceInstanceId, item])).values()];
  const nodes = [...new Map(pages.flatMap(page => page.nodes).map(item => [`${item.sourceInstanceId}:${item.nodeExecutionId}`, item])).values()];
  const traces = [...new Map(pages.flatMap(page => page.traceFacts ?? []).map(item => [`${item.sourceInstanceId}:${item.promptSnapshotId}`, item])).values()];
  const measured = traces.filter(item => item.tokenUsageCoverage?.inputTokens === true
    && item.tokenUsageCoverage.outputTokens === true && item.tokenUsageCoverage.totalTokens === true);
  const durations = instances.flatMap(item => item.durationMs == null ? [] : [item.durationMs]);
  for (const value of durations) {
    if (!Number.isFinite(value) || value < 0) throw new Error("本机度量事实包含无效的耗时或 Token 数量");
  }
  /** 每个字段只累加完整覆盖的 Trace，全部未知时返回空。 */
  function sumTokens(field: "inputTokens" | "outputTokens" | "totalTokens"): number | null {
    const values = traces.map(item => readDesktopMetricToken(item, field)).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return {
    instances, nodes, traces,
    durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    durationSamples: durations.length,
    tokens: {
      input: sumTokens("inputTokens"),
      output: sumTokens("outputTokens"),
      total: sumTokens("totalTokens"),
      measuredTraces: measured.length,
      missingTraces: traces.length - measured.length,
    },
    incompleteTraceCount: traces.filter(item => item.evidenceStatus !== "complete").length,
    conversationEventCount: instances.reduce((sum, item) => sum + item.conversationEventCount, 0),
    rawEngineEventCount: instances.reduce((sum, item) => sum + item.rawEngineEventCount, 0),
    missingRawTraceCount: pages.reduce((sum, page) => sum + page.coverage.missingRawTraceCount, 0),
    invalidPayloadCount: pages.reduce((sum, page) => sum + page.coverage.invalidPayloadCount, 0),
  };
}
