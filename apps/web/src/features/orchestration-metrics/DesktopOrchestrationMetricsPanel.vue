<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, reactive, ref, watch } from "vue";
import type { OrchestrationMetricCollectResponse } from "@codeflowai/shared";
import { useConfigStore } from "../../store/config";
import { useWorkspacesStore } from "../../store/workspaces";
import { isDesktopWorkspace, requestDesktopApi } from "../../services/desktop";
import { createBrowserUuid } from "../../utils/browserUuid";
import { createDesktopMetricsReader, createDesktopMetricsState, readDesktopMetricToken, summarizeDesktopMetrics } from "./desktopOrchestrationMetrics";

const config = useConfigStore();
const workspaces = useWorkspacesStore();
const selectedWorkspaceId = ref("");
const state = reactive(createDesktopMetricsState());
const reader = createDesktopMetricsReader(requestDesktopApi<OrchestrationMetricCollectResponse>, state);
const summary = computed(() => summarizeDesktopMetrics(state.pages));
const lastPage = computed(() => state.pages.at(-1));
const localWorkspaceIds = computed(() => (config.desktopClient?.workspaceIds ?? []).filter(id => isDesktopWorkspace(config, id)));
const workspaceOptions = computed(() => localWorkspaceIds.value.map(id => ({
  value: id,
  label: workspaces.workspaces.find(item => String(item.id) === id)?.title || id,
})));
const nodeColumns = [
  { title: "节点", dataIndex: "nodeLabel", key: "nodeLabel" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "尝试", dataIndex: "attemptNo", key: "attemptNo" },
  { title: "耗时", dataIndex: "durationMs", key: "durationMs" },
];
const traceColumns = [
  { title: "模型 / 引擎", dataIndex: "model", key: "model" },
  { title: "输入 Token", dataIndex: "inputTokens", key: "inputTokens" },
  { title: "输出 Token", dataIndex: "outputTokens", key: "outputTokens" },
  { title: "总 Token", dataIndex: "totalTokens", key: "totalTokens" },
  { title: "耗时", dataIndex: "durationMs", key: "durationMs" },
  { title: "证据 / Trace 标识", dataIndex: "evidenceStatus", key: "evidenceStatus" },
];

/** 数值仅格式化真实已记录值；缺失证据明确显示未记录。 */
function count(value: number | null | undefined): string {
  return value == null ? "未记录" : value.toLocaleString("zh-CN");
}

/** 耗时只展示事实值，不用当前时间补齐运行中样本。 */
function duration(value: number | null | undefined): string {
  return value == null ? "未记录" : `${(value / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒`;
}

/** 成功仅提交当前范围；失败由本面板记录结构化上下文并展示失败态。 */
async function load(): Promise<void> {
  const requestId = createBrowserUuid();
  try {
    await reader.load(requestId);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    console.error("[desktop-orchestration-metrics]", {
      code: state.error?.code ?? "DESKTOP_METRICS_COLLECT_FAILED", requestId,
      workspaceId: state.workspaceId, method: "orch.metrics.collect",
      rootCause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 刷新从第一页重读，成功前不展示旧快照作为本次结果。 */
function refresh(): void {
  reader.select(selectedWorkspaceId.value);
  if (selectedWorkspaceId.value) void load();
}

watch([() => config.workspaceId, () => localWorkspaceIds.value.join("\n")], () => {
  const current = String(config.workspaceId ?? "");
  if (localWorkspaceIds.value.includes(current)) selectedWorkspaceId.value = current;
  else if (!localWorkspaceIds.value.includes(selectedWorkspaceId.value)) selectedWorkspaceId.value = localWorkspaceIds.value[0] ?? "";
}, { immediate: true });
watch(selectedWorkspaceId, refresh, { immediate: true });
onDeactivated(reader.cancel);
onBeforeUnmount(reader.cancel);
onActivated(() => {
  if (selectedWorkspaceId.value && !state.loading && !state.pages.length && !state.error) void load();
});
</script>

<template>
  <section class="desktop-metrics" aria-label="本机编排度量">
    <div class="desktop-metrics__toolbar">
      <a-select v-model:value="selectedWorkspaceId" :options="workspaceOptions" :disabled="!workspaceOptions.length" placeholder="选择本机工作区" aria-label="本机工作区" class="desktop-metrics__workspace" />
      <a-button :loading="state.loading" :disabled="!selectedWorkspaceId" @click="refresh">刷新</a-button>
    </div>
    <div class="desktop-metrics__scroll">
      <a-alert type="info" show-icon message="本机运行事实" description="仅统计此设备、所选工作区已加载的编排记录。可在未登录或 Server 断连时读取；Token 为已记录用量，账单与账号汇总请切换云端分析。" />
      <a-alert v-if="state.error" type="error" show-icon message="本机度量采集失败，请刷新重试" :description="`${state.error.message}（${state.error.code}；requestId: ${state.error.requestId}）已加载事实仅代表此前成功的分页。`" />
      <a-empty v-if="!config.localRuntimeReady" description="本机运行时尚未就绪" />
      <a-empty v-else-if="!selectedWorkspaceId" description="暂无可读取的本机工作区；共享或其他设备的数据请进入云端分析" />
      <div v-else-if="state.loading && !state.pages.length" class="desktop-metrics__loading"><a-spin /><div>正在读取本机运行事实</div></div>
      <a-empty v-else-if="state.pages.length && !summary.instances.length" description="此工作区暂无编排运行记录" />
      <template v-else-if="summary.instances.length">
        <div class="desktop-metrics__range">
          已加载 {{ summary.instances.length }} 条运行记录{{ lastPage?.hasMore ? '，仍有后续记录' : '，已加载全部记录' }}
          · 最近采集 {{ lastPage ? new Date(lastPage.collectedAt).toLocaleString('zh-CN') : '' }}
        </div>
        <div class="desktop-metrics__cards">
          <a-card size="small"><a-statistic title="运行记录" :value="summary.instances.length" /></a-card>
          <a-card size="small"><a-statistic title="节点执行" :value="summary.nodes.length" /></a-card>
          <a-card size="small"><a-statistic title="已记录运行耗时合计" :value="duration(summary.durationMs)" /><div>{{ summary.durationSamples }} / {{ summary.instances.length }} 条有耗时事实</div></a-card>
          <a-card size="small"><a-statistic title="已记录 Token 合计" :value="count(summary.tokens.total)" /><div>输入 {{ count(summary.tokens.input) }} · 输出 {{ count(summary.tokens.output) }}</div><div>{{ summary.tokens.measuredTraces }} 条字段完整，{{ summary.tokens.missingTraces }} 条字段缺失</div></a-card>
          <a-card size="small"><a-statistic title="Trace 记录" :value="summary.traces.length" /><div>{{ summary.incompleteTraceCount }} 条证据不完整</div></a-card>
          <a-card size="small"><a-statistic title="原始引擎事件" :value="summary.rawEngineEventCount" /><div>会话事件 {{ count(summary.conversationEventCount) }}</div></a-card>
        </div>
        <a-alert v-if="summary.missingRawTraceCount || summary.invalidPayloadCount" type="warning" show-icon :message="`证据缺口：${summary.missingRawTraceCount} 条运行缺少原始 Trace，${summary.invalidPayloadCount} 条运行存在无效源数据`" />
        <a-collapse>
          <a-collapse-panel v-for="run in summary.instances" :key="run.sourceInstanceId" :header="`${run.titleSummary} · ${run.status} · ${duration(run.durationMs)}`">
            <div class="desktop-metrics__identity">运行 ID：{{ run.sourceInstanceId }} · 流程：{{ run.workflowName }} · 会话事件 {{ run.conversationEventCount }} · 原始事件 {{ run.rawEngineEventCount }}</div>
            <a-table size="small" :columns="nodeColumns" :data-source="summary.nodes.filter(node => node.sourceInstanceId === run.sourceInstanceId)" row-key="nodeExecutionId" :pagination="false" :scroll="{ x: 480 }">
              <template #bodyCell="{ column, record }"><template v-if="column.key === 'durationMs'">{{ duration(record.durationMs) }}</template></template>
            </a-table>
            <a-table size="small" :columns="traceColumns" :data-source="summary.traces.filter(trace => trace.sourceInstanceId === run.sourceInstanceId)" row-key="promptSnapshotId" :pagination="false" :scroll="{ x: 780 }">
              <template #emptyText>暂无已持久化的 Prompt / Trace 记录</template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'model'">{{ record.model || record.engine }}</template>
                <template v-else-if="['inputTokens', 'outputTokens', 'totalTokens'].includes(column.key)">{{ count(readDesktopMetricToken(record, column.key)) }}</template>
                <template v-else-if="column.key === 'durationMs'">{{ duration(record.durationMs) }}</template>
                <template v-else-if="column.key === 'evidenceStatus'">
                  <a-tag :color="record.evidenceStatus === 'complete' ? 'success' : 'warning'">{{ record.evidenceStatus === 'complete' ? '完整' : '不完整' }}</a-tag>
                  <div>{{ record.evidenceReasons.join('、') }}</div>
                  <div>Prompt：{{ record.promptSnapshotId }}</div><div>Thread：{{ record.threadId }} · Turn：{{ record.turnId }}</div>
                </template>
              </template>
            </a-table>
          </a-collapse-panel>
        </a-collapse>
      </template>
      <div v-if="lastPage?.hasMore" class="desktop-metrics__more"><a-button :loading="state.loading" :disabled="Boolean(state.error)" @click="load">加载更多运行记录</a-button></div>
    </div>
  </section>
</template>

<style scoped>
.desktop-metrics {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  gap: 12px;
}
.desktop-metrics__toolbar { display: flex; gap: 8px; flex-shrink: 0; }
.desktop-metrics__workspace { flex: 1; min-width: 0; max-width: 480px; }
.desktop-metrics__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
}
.desktop-metrics__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.desktop-metrics__identity { margin-bottom: 12px; overflow-wrap: anywhere; }
.desktop-metrics__range { color: var(--app-muted); }
.desktop-metrics__loading, .desktop-metrics__more { padding: 24px; text-align: center; }
</style>
