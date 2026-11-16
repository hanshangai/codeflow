<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { InfoCircleOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type {
  RelayEnterpriseBalanceOperationView,
  RelayEnterpriseBalancePoolResponseBody,
  RelayEnterpriseMemberAllocationItem,
  RelayMemberQuotaAdjustType,
} from "@codeflowai/shared";

import {
  adjustEnterpriseRelayMemberAllocation,
  getEnterpriseRelayBalanceOperation,
  getEnterpriseRelayBalancePool,
  listEnterpriseRelayMemberAllocations,
} from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";
import RelayBalancePackPurchaseButton from "../../admin/components/relay-balance-pack-purchase-button.vue";
import {
  formatRelayUsdUnitsAsYuan,
  parseRelayUsdUnits,
  relayYuanTextToUsdUnits,
} from "../relayUsdUnits";
import { createBrowserUuid } from "../../../utils/browserUuid";
import EnterpriseTokenAdjustmentHistory from "./enterprise-token-adjustment-history.vue";

defineOptions({ name: "EnterpriseTokenQuotaTab" });

const props = defineProps<{
  enterpriseId?: string | null;
  allowPurchase?: boolean;
}>();

const { ctx } = useApiContext();
const pool = ref<RelayEnterpriseBalancePoolResponseBody | null>(null);
const rows = ref<RelayEnterpriseMemberAllocationItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loadError = ref("");
const submitting = ref(false);
const search = ref("");
const paging = reactive({ current: 1, pageSize: 20, pageSizeOptions: ["10", "20", "50", "100"] });
const adjustOpen = ref(false);
const selectedMember = ref<RelayEnterpriseMemberAllocationItem | null>(null);
const operationTimer = ref<number | null>(null);
let refreshRevision = 0;
const adjustForm = reactive({
  adjustType: "INCREASE" as RelayMemberQuotaAdjustType,
  amountYuan: "",
  note: "",
  idempotencyKey: "",
  submittedFingerprint: "",
});

const availableUsdUnits = computed(() => parseRelayUsdUnits(pool.value?.availableUsdUnits ?? "0"));
const memberRemainingUsdUnits = computed(() => parseRelayUsdUnits(selectedMember.value?.remainingUsdUnits ?? "0"));
const adjustAmountUsdUnits = computed(() => {
  try {
    return relayYuanTextToUsdUnits(adjustForm.amountYuan);
  } catch {
    return 0n;
  }
});
const previewMemberUsdUnits = computed(() => adjustForm.adjustType === "INCREASE"
  ? memberRemainingUsdUnits.value + adjustAmountUsdUnits.value
  : memberRemainingUsdUnits.value - adjustAmountUsdUnits.value);
const resultUnknownOperation = computed(() => rows.value
  .find((item) => item.operation?.operationStatus === "RESULT_UNKNOWN")?.operation ?? null);
const activeTab = ref<"members" | "history">("members");
const historyVisited = ref(false);
const historyRef = ref<{ refresh: () => Promise<void> } | null>(null);
const adjustError = computed(() => {
  let amount: bigint;
  try {
    amount = relayYuanTextToUsdUnits(adjustForm.amountYuan);
  } catch (error) {
    return error instanceof Error ? error.message : "调整额度格式不正确";
  }
  if (adjustForm.adjustType === "INCREASE" && amount > availableUsdUnits.value) return "企业可分配额度不足";
  if (adjustForm.adjustType === "RECLAIM" && amount > memberRemainingUsdUnits.value) return "成员可回收额度不足";
  return "";
});

/** 生成当前调整表单专用幂等键；同一次未确认请求重试时保持不变。 */
function createIdempotencyKey(memberUserId: string): string {
  return `enterprise-token-adjust:${memberUserId}:${createBrowserUuid()}`;
}

/** 将内部精确额度统一格式化为面向管理员的人民币金额。 */
function formatQuota(value: string | bigint): string {
  return formatRelayUsdUnitsAsYuan(value);
}

/** 净分配扣除已回收和已过期额度；尚未完成回收的冻结额度仍计入。 */
function formatNetAllocation(member: RelayEnterpriseMemberAllocationItem): string {
  return formatQuota(parseRelayUsdUnits(member.grantedUsdUnits)
    - parseRelayUsdUnits(member.returnedUsdUnits)
    - parseRelayUsdUnits(member.expiredUsdUnits));
}

/** 将 operation 状态映射为管理员可快速识别的标签。 */
function operationStatusMeta(value: RelayEnterpriseBalanceOperationView | null) {
  if (!value) return null;
  if (value.operationStatus === "SUCCEEDED") return { color: "green", text: "已完成" };
  if (value.operationStatus === "REJECTED") return { color: "red", text: "已拒绝" };
  if (value.operationStatus === "RESULT_UNKNOWN") return { color: "red", text: "结果待确认" };
  if (value.operationStatus === "RECONCILING") return { color: "orange", text: "对账中" };
  return { color: "blue", text: "处理中" };
}

/** 格式化 operation 开始时间，非法时间保持占位。 */
function formatOperationStart(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return "-";
  return new Date(startedAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 返回成员当前状态标签；失权或异常状态不得显示为普通未分配。 */
function memberStatusMeta(member: RelayEnterpriseMemberAllocationItem): { color: string; text: string } {
  if (member.membershipStatus === "removing") return { color: "orange", text: "移除处理中" };
  if (member.accountStatus !== "active") return { color: "red", text: "账号不可用" };
  if (member.allocationStatus === "exception") return { color: "red", text: "额度异常" };
  if (member.allocationStatus === "frozen") return { color: "orange", text: "额度冻结" };
  if (member.allocationStatus === "active") return { color: "green", text: "正常" };
  return { color: "default", text: "未分配" };
}

/** 仅允许 active 账号和 active membership 发起额度调整。 */
function canAdjustMember(member: RelayEnterpriseMemberAllocationItem): boolean {
  return member.accountStatus === "active"
    && member.membershipStatus === "active"
    && !member.operation;
}

/** 持久化加载错误并清除旧企业数据，避免把失败伪装成零余额或继续展示失权前快照。 */
function setLoadFailure(value: unknown, fallback: string): void {
  const detail = value instanceof Error ? value.message : String(value ?? "");
  loadError.value = detail.trim() || fallback;
  pool.value = null;
  rows.value = [];
  total.value = 0;
}

/** 清空企业作用域快照和编辑状态，禁止企业切换期间展示或提交旧成员数据。 */
function resetEnterpriseScopeState(): void {
  clearOperationPoll();
  pool.value = null;
  rows.value = [];
  total.value = 0;
  loadError.value = "";
  adjustOpen.value = false;
  selectedMember.value = null;
  adjustForm.submittedFingerprint = "";
}

/** 从当前成员页选择一个可自动查询的 operation，页面重开后继续跟踪。 */
function scheduleVisibleOperationPoll(items: RelayEnterpriseMemberAllocationItem[]): void {
  const next = items.find((item) => item.operation
    && ["PENDING", "SYNCING", "RECONCILING"].includes(item.operation.operationStatus))?.operation;
  if (next) scheduleOperationPoll(next.operationId);
}

/** 同时刷新企业池和当前成员页，任一接口失败都显式提示。 */
async function refreshAll(): Promise<void> {
  const revision = ++refreshRevision;
  clearOperationPoll();
  loadError.value = "";
  loading.value = true;
  try {
    const [poolResult, memberResult] = await Promise.all([
      getEnterpriseRelayBalancePool(ctx.value, { enterpriseId: props.enterpriseId }),
      listEnterpriseRelayMemberAllocations(ctx.value, {
        enterpriseId: props.enterpriseId,
        search: search.value.trim() || undefined,
        offset: (paging.current - 1) * paging.pageSize,
        limit: paging.pageSize,
      }),
    ]);
    if (revision !== refreshRevision) return;
    if (!poolResult.ok) {
      setLoadFailure(poolResult.message, "企业 Token 池加载失败");
      return;
    }
    if (!memberResult.ok) {
      setLoadFailure(memberResult.message, "成员 Token 额度加载失败");
      return;
    }
    pool.value = poolResult;
    rows.value = memberResult.items;
    total.value = memberResult.total;
    scheduleVisibleOperationPoll(memberResult.items);
  } catch (error) {
    if (revision !== refreshRevision) return;
    setLoadFailure(error, "企业 Token 额度加载失败");
  } finally {
    if (revision === refreshRevision) loading.value = false;
  }
}

/** 刷新当前可见 Tab，避免记录页触发无关成员列表请求。 */
async function refreshCurrentTab(): Promise<void> {
  if (activeTab.value === "history") {
    await historyRef.value?.refresh();
    return;
  }
  await refreshAll();
}

/** 切换企业 Token 子视图，并在首次进入时挂载记录组件。 */
function handleTabChange(key: string): void {
  activeTab.value = key === "history" ? "history" : "members";
  if (activeTab.value === "history") historyVisited.value = true;
}

/** 打开单成员增加或回收弹框，并锁定当前页面版本。 */
function openAdjust(member: RelayEnterpriseMemberAllocationItem, adjustType: RelayMemberQuotaAdjustType): void {
  selectedMember.value = member;
  adjustForm.adjustType = adjustType;
  adjustForm.amountYuan = "";
  adjustForm.note = "";
  adjustForm.idempotencyKey = createIdempotencyKey(member.userId);
  adjustForm.submittedFingerprint = "";
  adjustOpen.value = true;
}

/** 提交精确额度调整；版本冲突时刷新并清空旧确认，禁止自动重放。 */
async function submitAdjust(): Promise<void> {
  const member = selectedMember.value;
  if (!member || adjustError.value) {
    message.warning(adjustError.value || "请选择成员");
    return;
  }
  const amountUsdUnits = relayYuanTextToUsdUnits(adjustForm.amountYuan).toString();
  const fingerprint = JSON.stringify({
    adjustType: adjustForm.adjustType,
    amountUsdUnits,
    version: member.version,
    note: adjustForm.note.trim(),
  });
  if (adjustForm.submittedFingerprint && adjustForm.submittedFingerprint !== fingerprint) {
    adjustForm.idempotencyKey = createIdempotencyKey(member.userId);
  }
  adjustForm.submittedFingerprint = fingerprint;
  submitting.value = true;
  try {
    const result = await adjustEnterpriseRelayMemberAllocation(ctx.value, member.userId, {
      adjustType: adjustForm.adjustType,
      amountUsdUnits,
      version: member.version,
      idempotencyKey: adjustForm.idempotencyKey,
      note: adjustForm.note.trim() || null,
    }, props.enterpriseId);
    if (!result.ok) {
      if (result.code === "VERSION_CONFLICT") {
        adjustOpen.value = false;
        selectedMember.value = null;
        await refreshAll();
        message.warning("成员额度已变化，数据已刷新，请重新确认");
        return;
      }
      message.error(result.message || "成员 Token 额度调整失败");
      return;
    }
    adjustOpen.value = false;
    selectedMember.value = null;
    if (result.operationStatus === "REJECTED") {
      message.error("额度调整被拒绝，企业池与成员额度未变更");
    } else {
      message.success(result.operationStatus === "SUCCEEDED" ? "成员额度已调整" : "额度调整已受理");
    }
    await refreshAll();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "成员 Token 额度调整失败");
  } finally {
    submitting.value = false;
  }
}

/** 安排 operation 状态轮询，避免多个计时器并发覆盖页面状态。 */
function scheduleOperationPoll(operationId: string, delayMs = 2500): void {
  clearOperationPoll();
  operationTimer.value = window.setTimeout(() => void pollOperation(operationId), delayMs);
}

/** 读取公开 operation 状态并刷新成员页；下一轮由最新列表状态决定。 */
async function pollOperation(operationId: string): Promise<void> {
  try {
    const result = await getEnterpriseRelayBalanceOperation(ctx.value, operationId, props.enterpriseId);
    if (!result.ok) {
      message.error(result.message || "额度操作状态加载失败");
      await refreshAll();
      return;
    }
    await refreshAll();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "额度操作状态加载失败");
    await refreshAll();
  }
}

/** 清理 operation 轮询计时器。 */
function clearOperationPoll(): void {
  if (operationTimer.value !== null) {
    window.clearTimeout(operationTimer.value);
    operationTimer.value = null;
  }
}

/** 搜索成员时回到第一页，避免旧页码造成空结果。 */
async function applySearch(): Promise<void> {
  paging.current = 1;
  await refreshAll();
}

/** 处理成员分页和每页条数变化。 */
async function handlePageChange(page: number, pageSize: number): Promise<void> {
  const sizeChanged = pageSize !== paging.pageSize;
  paging.current = sizeChanged ? 1 : page;
  paging.pageSize = pageSize;
  await refreshAll();
}

onMounted(() => void refreshAll());
onUnmounted(() => {
  refreshRevision += 1;
  clearOperationPoll();
});

watch(() => props.enterpriseId, () => {
  refreshRevision += 1;
  resetEnterpriseScopeState();
  paging.current = 1;
  void refreshAll();
});
</script>

<template>
  <div class="enterprise-token-quota">
    <div class="enterprise-token-quota__head">
      <strong>企业Token</strong>
      <div class="enterprise-token-quota__head-actions">
        <a-popover
          title="额度使用规则"
          trigger="click"
          placement="bottomRight"
          :overlay-style="{ width: 'min(520px, calc(100vw - 32px))' }"
        >
          <template #content>
            <ul class="enterprise-token-quota__guide-list">
              <li>“增加”按钮为成员增加token额度，会同步减少企业“可分配”余额。</li>
              <li>“回收”按钮仅能回收成员的“可用额度”，已消费额度不能回收。</li>
              <li>“净分配”为累计增加减去已回收、已过期的额度，包含已消费、可用及冻结额度。</li>
              <li>回收期间会暂时停用该成员中转 Key，操作成功或明确拒绝后按当前权限恢复。</li>
              <li>显示“处理中”或“对账中”时请等待原操作结束。</li>
              <li>显示“结果待确认”时不要再次调整，并联系运维提供操作 ID。</li>
              <li>禁用或移除成员会触发未消费额度回收；清理未完成时成员保持不可用，重新启用或重新加入后需重新分配。</li>
            </ul>
          </template>
          <a-button type="text" size="small" aria-label="查看额度使用规则">
            <template #icon><InfoCircleOutlined /></template>
            使用规则
          </a-button>
        </a-popover>
        <a-button size="small" :loading="activeTab === 'members' && loading" @click="refreshCurrentTab">
          <template #icon><ReloadOutlined /></template>
          刷新
        </a-button>
      </div>
    </div>

    <div
      v-if="loading && !pool && !loadError"
      class="enterprise-token-quota__initial-loading"
      role="status"
      aria-live="polite"
    >
      <a-spin size="large" />
      <span>企业Token加载中...</span>
    </div>

    <div v-if="pool" class="enterprise-token-quota__metrics">
      <div v-for="item in [
        { label: '累计购买', value: pool?.purchasedUsdUnits ?? '0' },
        { label: '可分配', value: pool?.availableUsdUnits ?? '0' },
        { label: '成员可用', value: pool?.allocatedAvailableUsdUnits ?? '0' },
        { label: '已消费', value: pool?.consumedUsdUnits ?? '0' },
      ]" :key="item.label" class="enterprise-token-quota__metric">
        <div class="enterprise-token-quota__metric-head">
          <span>{{ item.label }}</span>
          <RelayBalancePackPurchaseButton
            v-if="item.label === '累计购买' && allowPurchase !== false"
            size="small"
            label="企业Token充值"
            default-target-scope="ENTERPRISE"
            :enterprise-id="pool?.enterpriseId"
            @succeeded="refreshAll"
          />
        </div>
        <strong>{{ formatQuota(item.value) }}</strong>
      </div>
    </div>

    <a-tabs v-if="pool || loadError" class="enterprise-token-quota__tabs" :active-key="activeTab" @change="handleTabChange">
      <a-tab-pane key="members" tab="Token分配">

    <a-alert
      v-if="loadError"
      type="error"
      show-icon
      message="企业 Token 额度加载失败"
      :description="loadError"
    >
      <template #action>
        <a-button size="small" :loading="loading" @click="refreshAll">重试</a-button>
      </template>
    </a-alert>

    <a-alert
      v-if="resultUnknownOperation"
      type="error"
      show-icon
      :message="resultUnknownOperation.publicMessage || '额度操作结果待确认'"
      :description="`操作 ID：${resultUnknownOperation.operationId}`"
    />

    <div v-if="pool" class="enterprise-token-quota__toolbar">
      <a-input
        v-model:value="search"
        allow-clear
        placeholder="搜索成员姓名或邮箱"
        @press-enter="applySearch"
      />
      <a-button :loading="loading" @click="applySearch">
        <template #icon><SearchOutlined /></template>
        查询
      </a-button>
    </div>

    <a-table
      v-if="pool"
      class="enterprise-token-quota__table"
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      row-key="membershipId"
      size="small"
      :scroll="{ x: 900 }"
    >
      <a-table-column title="成员" :width="210" fixed="left">
        <template #default="{ record }">
          <div class="enterprise-token-quota__member">
            <strong>{{ record.fullName || record.email }}</strong>
            <span>{{ record.email }}</span>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="净分配" :width="150">
        <template #default="{ record }">{{ formatNetAllocation(record) }}</template>
      </a-table-column>
      <a-table-column title="可用额度" :width="150">
        <template #default="{ record }"><strong>{{ formatQuota(record.remainingUsdUnits) }}</strong></template>
      </a-table-column>
      <a-table-column title="已消费" :width="150">
        <template #default="{ record }">{{ formatQuota(record.consumedUsdUnits) }}</template>
      </a-table-column>
      <a-table-column title="状态" :width="180">
        <template #default="{ record }">
          <div v-if="record.operation" class="enterprise-token-quota__operation">
            <a-tag v-if="record.membershipStatus === 'removing'" :bordered="false" color="orange">
              移除处理中
            </a-tag>
            <a-tag
              :bordered="false"
              :color="operationStatusMeta(record.operation)?.color"
              :title="record.operation.publicMessage || ''"
            >
              {{ operationStatusMeta(record.operation)?.text }}
            </a-tag>
            <span>{{ record.operation.adjustType === 'INCREASE' ? '增加' : '回收' }} · {{ formatOperationStart(record.operation.startedAt) }}</span>
            <code :title="record.operation.operationId">{{ record.operation.operationId }}</code>
          </div>
          <a-tag v-else :bordered="false" :color="memberStatusMeta(record).color">
            {{ memberStatusMeta(record).text }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column title="操作" :width="176" fixed="right">
        <template #default="{ record }">
          <a-space :size="4">
            <a-button size="small" :disabled="!canAdjustMember(record)" @click="openAdjust(record, 'INCREASE')">
              <template #icon><PlusOutlined /></template>
              增加
            </a-button>
            <a-button
              size="small"
              :disabled="!canAdjustMember(record) || parseRelayUsdUnits(record.remainingUsdUnits) === 0n"
              @click="openAdjust(record, 'RECLAIM')"
            >
              <template #icon><MinusOutlined /></template>
              回收
            </a-button>
          </a-space>
        </template>
      </a-table-column>
    </a-table>

    <div v-if="pool" class="enterprise-token-quota__mobile-list">
      <div v-for="record in rows" :key="record.membershipId" class="enterprise-token-quota__mobile-item">
        <div class="enterprise-token-quota__member">
          <strong>{{ record.fullName || record.email }}</strong>
          <span>{{ record.email }}</span>
        </div>
        <dl>
          <div><dt>可用额度</dt><dd>{{ formatQuota(record.remainingUsdUnits) }}</dd></div>
          <div><dt>已消费</dt><dd>{{ formatQuota(record.consumedUsdUnits) }}</dd></div>
        </dl>
        <div v-if="record.operation" class="enterprise-token-quota__operation">
          <a-tag v-if="record.membershipStatus === 'removing'" :bordered="false" color="orange">
            移除处理中
          </a-tag>
          <a-tag
            :bordered="false"
            :color="operationStatusMeta(record.operation)?.color"
            :title="record.operation.publicMessage || ''"
          >
            {{ operationStatusMeta(record.operation)?.text }}
          </a-tag>
          <span>{{ record.operation.adjustType === 'INCREASE' ? '增加' : '回收' }} · {{ formatOperationStart(record.operation.startedAt) }}</span>
          <code :title="record.operation.operationId">{{ record.operation.operationId }}</code>
        </div>
        <a-tag v-else :bordered="false" :color="memberStatusMeta(record).color">
          {{ memberStatusMeta(record).text }}
        </a-tag>
        <div class="enterprise-token-quota__mobile-actions">
          <a-button size="small" :disabled="!canAdjustMember(record)" @click="openAdjust(record, 'INCREASE')">
            <template #icon><PlusOutlined /></template>
            增加
          </a-button>
          <a-button
            size="small"
            :disabled="!canAdjustMember(record) || parseRelayUsdUnits(record.remainingUsdUnits) === 0n"
            @click="openAdjust(record, 'RECLAIM')"
          >
            <template #icon><MinusOutlined /></template>
            回收
          </a-button>
        </div>
      </div>
    </div>

    <div v-if="pool" class="enterprise-token-quota__pagination">
      <span>共 {{ total }} 名成员</span>
      <a-pagination
        :current="paging.current"
        :page-size="paging.pageSize"
        :total="total"
        :show-size-changer="true"
        :page-size-options="paging.pageSizeOptions"
        size="small"
        @change="handlePageChange"
        @show-size-change="handlePageChange"
      />
    </div>

      </a-tab-pane>
      <a-tab-pane key="history" tab="分配记录">
        <EnterpriseTokenAdjustmentHistory
          v-if="historyVisited"
          ref="historyRef"
          :enterprise-id="enterpriseId"
        />
      </a-tab-pane>
    </a-tabs>

    <a-modal
      v-model:open="adjustOpen"
      :title="adjustForm.adjustType === 'INCREASE' ? '增加成员额度' : '回收成员额度'"
      :confirm-loading="submitting"
      :ok-button-props="{ disabled: Boolean(adjustError) }"
      ok-text="确认"
      cancel-text="取消"
      @ok="submitAdjust"
    >
      <a-alert
        v-if="adjustForm.adjustType === 'RECLAIM'"
        type="warning"
        show-icon
        message="回收期间将暂时停用成员中转 Key"
        description="操作完成或明确拒绝后，将按成员当前权限恢复可用的中转 Key。"
      />
      <a-form layout="vertical" autocomplete="off">
        <a-form-item label="成员">
          <a-input :value="selectedMember?.fullName || selectedMember?.email" disabled />
        </a-form-item>
        <a-form-item label="当前可用额度">
          <a-input :value="formatQuota(selectedMember?.remainingUsdUnits ?? '0')" disabled />
        </a-form-item>
        <a-form-item label="调整额度（元）" :validate-status="adjustError ? 'warning' : ''" :help="adjustError || ' '">
          <a-input v-model:value="adjustForm.amountYuan" inputmode="decimal" prefix="￥" placeholder="例如 10.50" />
        </a-form-item>
        <a-form-item label="调整后成员可用额度">
          <a-input :value="formatQuota(previewMemberUsdUnits)" disabled />
        </a-form-item>
        <a-form-item label="备注">
          <a-textarea v-model:value="adjustForm.note" :maxlength="200" :rows="3" show-count />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.enterprise-token-quota {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.enterprise-token-quota__head,
.enterprise-token-quota__head-actions,
.enterprise-token-quota__toolbar,
.enterprise-token-quota__pagination,
.enterprise-token-quota__mobile-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.enterprise-token-quota__head,
.enterprise-token-quota__pagination {
  justify-content: space-between;
}

.enterprise-token-quota__pagination {
  box-sizing: border-box;
  min-height: 48px;
  padding: 8px 12px;
  border-top: 1px solid var(--app-divider);
}

.enterprise-token-quota__initial-loading {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  min-height: 240px;
  color: var(--app-muted);
  font-size: 13px;
}

.enterprise-token-quota__tabs {
  min-width: 0;
}

.enterprise-token-quota__member {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.enterprise-token-quota__member span,
.enterprise-token-quota__metric span,
.enterprise-token-quota__pagination,
.enterprise-token-quota__mobile-item dt {
  color: var(--app-muted);
  font-size: 12px;
}

.enterprise-token-quota__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: 1px solid var(--app-border);
  border-bottom: 1px solid var(--app-border);
}

.enterprise-token-quota__metric {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 14px 12px;
}

.enterprise-token-quota__metric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 24px;
}

.enterprise-token-quota__metric + .enterprise-token-quota__metric {
  border-left: 1px solid var(--app-border);
}

.enterprise-token-quota__metric strong {
  font-size: 18px;
  overflow-wrap: anywhere;
}

.enterprise-token-quota__guide-list {
  margin: 0;
  padding-left: 18px;
}

.enterprise-token-quota__guide-list li + li {
  margin-top: 4px;
}

.enterprise-token-quota__toolbar :deep(.ant-input-affix-wrapper) {
  width: min(360px, 100%);
}

.enterprise-token-quota__table {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.enterprise-token-quota__member strong,
.enterprise-token-quota__member span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-token-quota__operation {
  display: grid;
  justify-items: start;
  gap: 2px;
  min-width: 0;
}

.enterprise-token-quota__operation span,
.enterprise-token-quota__operation code {
  max-width: 100%;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-token-quota__mobile-list {
  display: none;
}

.enterprise-token-quota__mobile-item {
  display: grid;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
}

.enterprise-token-quota__mobile-item dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.enterprise-token-quota__mobile-item dl > div {
  display: grid;
  gap: 2px;
}

.enterprise-token-quota__mobile-item dd {
  margin: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .enterprise-token-quota__head {
    align-items: flex-start;
    flex-direction: column;
  }

  .enterprise-token-quota__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .enterprise-token-quota__metric + .enterprise-token-quota__metric {
    border-left: 0;
  }

  .enterprise-token-quota__metric:nth-child(even) {
    border-left: 1px solid var(--app-border);
  }

  .enterprise-token-quota__metric:nth-child(n + 3) {
    border-top: 1px solid var(--app-border);
  }

  .enterprise-token-quota__table {
    display: none;
  }

  .enterprise-token-quota__mobile-list {
    display: grid;
  }

  .enterprise-token-quota__pagination {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
