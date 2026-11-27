<script setup lang="ts">
import type { KnowledgeReviewIssue, KnowledgeReviewReportView } from "@codeflowai/shared";
import { computed } from "vue";

const props = withDefaults(defineProps<{ reports: KnowledgeReviewReportView[]; loading: boolean; busy: boolean; restartBusy?: boolean; canWrite: boolean; canStartTask?: boolean; canReviewVersion?: boolean; canRepair?: boolean; sourceRefreshRequired?: boolean; pending?: boolean; failure?: string | null; generationThreadId?: string | null; generationTitle?: string | null }>(), { canStartTask: true, canReviewVersion: true, canRepair: true });
const emit = defineEmits<{ review: []; repair: [report: KnowledgeReviewReportView]; repairIssue: [report: KnowledgeReviewReportView, issue: KnowledgeReviewIssue]; returnToGeneration: [report: KnowledgeReviewReportView] }>();
/** 重新复检只看文档是否被占用；其他操作仍以 busy 为准。 */
const restartDisabled = computed(() => props.restartBusy ?? props.busy);
/** 同一版本展示最近的复检结论。 */
const report = computed(() => [...props.reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null);
/** 就近解释一键修复的现有禁用条件，旧报告只用于查阅。 */
const issueRepairDisabledReason = computed(() => !props.canWrite ? "需要维护权限才能修复" : props.sourceRefreshRequired ? "请先更新候选并复检" : report.value?.stale
  ? props.canReviewVersion ? "报告已失效，请重新复检" : "报告已失效，请复检最新版本" : null);
const blockingIssues = computed(() => report.value?.issues.filter(issue => issue.severity === "error") ?? []);
/** 阻断项优先展示，同级问题保留报告原顺序，编号仅用于阅读。 */
const issues = computed(() => [...(report.value?.issues ?? [])].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")));
const status = computed(() => report.value?.stale ? "复检已失效" : report.value?.outcome === "passed" ? "复检通过" : report.value?.outcome === "passed_with_warnings" ? "复检通过（有提醒）" : report.value ? "发现问题" : props.pending ? "待复检" : props.failure ? "复检失败" : "尚未复检");
const category = { factual: "事实不符", coverage: "覆盖缺失", unsupported: "缺少证据", contradiction: "内容矛盾" };
</script>

<template>
  <section class="review-report" aria-label="知识复检报告" data-testid="knowledge-review-report">
    <header class="review-heading">
      <div><h3>复检报告</h3><span :title="report ? `${report.engine} / ${report.model || '引擎默认'} · ${report.effort || '默认思考强度'} · ${report.createdAt.replace('T', ' ').slice(0, 19)}` : undefined" :class="['review-status', { passed: (report?.outcome === 'passed' || report?.outcome === 'passed_with_warnings') && !report.stale, issues: report?.outcome === 'issues' || report?.stale }]">{{ status }}</span></div>
      <a-button v-if="canStartTask && !sourceRefreshRequired" size="small" :disabled="!canWrite || restartDisabled || pending || !canReviewVersion" @click="emit('review')">{{ report ? '重新复检' : '复检这份文档' }}</a-button>
    </header>
    <a-spin v-if="loading" />
    <p v-else-if="!report" class="review-note">{{ failure || (pending ? '文档已保存，等待复检；继续任务会从复检阶段接着处理。' : '复检会对照项目证据检查事实、覆盖范围与内容一致性。') }}</p>
    <a-alert v-if="report && failure" type="error" show-icon :message="failure" />
    <p v-if="canStartTask && !canReviewVersion && !sourceRefreshRequired" class="review-note">已有更新的待采用版本。请在待确认更新中查看最新版本；当前报告对应正在查看的版本。</p>
    <template v-if="report">
      <p v-if="sourceRefreshRequired || report.stale" class="review-stale" role="status">{{ sourceRefreshRequired ? '生成时引用的来源已变化。请更新候选并复检，原版本与报告会保留；单独复检不会更新旧版本的来源。' : '文档、生成要求或来源已经变化，已停用一键修复，避免按旧报告重复修改。' + (canReviewVersion ? '请重新复检后再修复。' : '请在待确认更新中选择最新版本，完成复检后再修复。') }}{{ report.staleReasons.join('；') }}</p>
      <template v-if="issues.length">
        <p class="review-counts">共 {{ issues.length }} 项问题：<strong>{{ blockingIssues.length }} 项需修复</strong><span> · {{ issues.length - blockingIssues.length }} 项提醒</span></p>
        <ol :key="report.id" class="review-issues" aria-label="复检问题条目">
          <li v-for="(issue, index) in issues" :key="`${report.id}:${issue.id}`">
            <article class="review-issue" :aria-label="`问题 ${index + 1}：${issue.title}`">
              <div class="issue-title"><h4>{{ index + 1 }}. {{ issue.title }}</h4><span :class="['issue-severity', { blocking: issue.severity === 'error' }]">{{ issue.severity === 'error' ? '需修复' : '提醒' }}</span></div>
              <p class="issue-location">{{ category[issue.category] }} · 正文第 {{ issue.documentStartLine }}{{ issue.documentEndLine !== issue.documentStartLine ? `–${issue.documentEndLine}` : '' }} 行</p>
              <div class="issue-description"><strong>问题说明</strong><p>{{ issue.detail }}</p></div>
              <div class="issue-suggestion">
                <div class="issue-suggestion-head"><strong>修复建议</strong><a-space wrap :size="6" :title="issueRepairDisabledReason ?? undefined"><span v-if="issueRepairDisabledReason" class="repair-disabled-reason">{{ issueRepairDisabledReason }}</span><a-button size="small" type="link" :disabled="Boolean(issueRepairDisabledReason)" @click="emit('repairIssue', report, issue)">一键修复</a-button></a-space></div>
                <p>{{ issue.suggestion }}</p>
              </div>
              <details v-if="issue.sources.length" class="issue-sources">
                <summary>查看证据 · {{ issue.sources.length }} 项</summary>
                <div v-for="(source, sourceIndex) in issue.sources" :key="sourceIndex" class="issue-evidence"><code>{{ source.path ?? source.requirement ?? '项目要求' }}{{ source.startLine ? `:${source.startLine}${source.endLine && source.endLine !== source.startLine ? `–${source.endLine}` : ''}` : '' }}</code><p>{{ source.relation }}</p></div>
              </details>
            </article>
          </li>
        </ol>
        <details :key="`summary-${report.id}`" class="review-explanation"><summary>查看核查说明</summary><p class="review-summary">{{ report.summary }}</p></details>
      </template>
      <p v-else class="review-summary">{{ report.summary }}</p>
      <footer v-if="blockingIssues.length || report.stale" class="review-actions"><p>{{ !canRepair ? '产品文档保留原文，请按报告更新原始资料，再导入并复检。' : !canStartTask ? '此知识尚未加入正式目录，请回知识工作会话修订，再继续原任务复检；通过后再采用。' : report.stale ? '报告已失效，请根据最新项目证据重新复检；需要修改正文时，可回知识工作会话修订。' : '仅错误会阻断交付。请按报告生成修订版，或回知识工作会话修订；新版本复检通过后再采用。' }}</p><div class="review-action-buttons"><a-button v-if="generationThreadId && canRepair" size="small" :disabled="!canWrite || busy" @click="emit('returnToGeneration', report)">回知识工作会话修订</a-button><a-button v-if="canStartTask && canRepair && blockingIssues.length" type="primary" size="small" :disabled="!canWrite || busy || report.stale" @click="emit('repair', report)">按报告问题生成修订版</a-button></div></footer>
      <p v-else-if="report.issues.length" class="review-note">以上为提醒项，不阻断采用；如需提升完整度，可以在知识工作会话中继续补充。</p>
    </template>
  </section>
</template>

<style scoped>
.review-report { min-width: 0; color: var(--app-text); }
.review-heading, .review-heading > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.review-heading { justify-content: space-between; margin-bottom: 6px; }
.review-heading h3 { margin: 0; font-size: 15px; }
.review-status, .review-note, .issue-location { color: var(--app-muted); font-size: 12px; }
.review-status.passed { color: var(--app-success); }
.review-status.issues { color: var(--app-warning); }
.review-report p { margin: 6px 0; line-height: 1.75; overflow-wrap: anywhere; white-space: pre-line; }
.review-summary { font-size: 13px; }
.review-stale { padding: 10px 12px; border-left: 2px solid var(--app-warning); background: color-mix(in srgb, var(--app-warning) 6%, var(--app-bg)); font-size: 12px; }
.review-report select { min-width: 0; max-width: 100%; padding: 3px 6px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-bg); color: var(--app-text); }
.review-counts { font-size: 12px; color: var(--app-muted); }
.review-counts strong { color: var(--app-text); }
.review-issues { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.review-issues > li { min-width: 0; }
.review-issue { min-width: 0; padding: 12px; border: 1px solid var(--app-divider); border-radius: 8px; font-size: 13px; }
.issue-title { display: flex; align-items: flex-start; gap: 8px; }
.issue-title h4 { flex: 1; min-width: 0; margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.issue-severity { flex-shrink: 0; color: var(--app-warning); font-size: 12px; }
.issue-severity.blocking { color: var(--app-danger); }
.issue-description { margin-top: 10px; }
.issue-description > strong, .issue-suggestion > strong { font-size: 12px; }
.issue-suggestion { margin-top: 10px; padding: 8px 10px; border-left: 2px solid var(--app-accent); background: color-mix(in srgb, var(--app-accent) 5%, var(--app-bg)); }
.issue-suggestion-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.repair-disabled-reason { color: var(--app-muted); font-size: 12px; }
.issue-suggestion-head :deep(.ant-btn) { height: auto; padding: 0; font-size: 12px; }
.issue-suggestion p { margin-bottom: 0; }
.issue-sources, .review-explanation { margin-top: 10px; font-size: 12px; }
.issue-sources summary, .review-explanation summary { cursor: pointer; color: var(--app-muted); overflow-wrap: anywhere; }
.issue-evidence { margin-top: 8px; padding: 8px 10px; border-left: 2px solid var(--app-divider); background: color-mix(in srgb, var(--app-muted) 4%, var(--app-bg)); }
.issue-evidence code { overflow-wrap: anywhere; white-space: pre-wrap; }
.issue-evidence p { margin: 5px 0 0; color: var(--app-muted); }
.review-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-top: 16px; }
.review-actions p { flex: 1 1 160px; margin: 0; font-size: 12px; color: var(--app-muted); }
.review-action-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.review-actions .ant-btn { white-space: normal; height: auto; min-height: 30px; max-width: 100%; }
@media (max-width: 767px) {
  .issue-sources summary, .review-explanation summary { min-height: 44px; align-content: center; }
}
</style>
