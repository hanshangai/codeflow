<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import type { AccountOrderInfoPaymentOrderItem, AccountOrderInfoPaymentOrdersQuery, InvoiceProfileView, InvoiceType } from "@codeflowai/shared";

import { createInvoiceApplication, getInvoiceProfile, listAccountOrderInfoPaymentOrders } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";
import { useAdminStore } from "../../../store/admin";
import {
  ORDER_KIND_OPTIONS,
  formatBillingCycleLabel,
  formatDateTimeShort,
  formatOrderKind,
  formatPaymentStatus,
  formatPriceFen,
  formatRelayMoneyFromUsd,
  paymentStatusTone,
} from "../paymentOrderLabels";

defineOptions({ name: "AccountOrderInfoPaymentOrdersPanel" });

const props = withDefaults(defineProps<{ h5?: boolean }>(), {
  h5: false,
});

const { ctx } = useApiContext();
const admin = useAdminStore();
const preset = admin.consumePaymentOrderPreset();

const paging = reactive({
  page: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});
const filters = reactive({
  orderKind: preset?.orderKind ?? ("ALL" as NonNullable<AccountOrderInfoPaymentOrdersQuery["orderKind"]>),
  paidFrom: "",
  paidTo: "",
});
const loading = ref(false);
const h5LoadingMore = ref(false);
const applyingInvoice = ref(false);
const invoiceProfileLoading = ref(false);
const invoiceProfileError = ref("");
const invoiceModalOpen = ref(false);
const h5FilterOpen = ref(false);
const selectedOrder = ref<AccountOrderInfoPaymentOrderItem | null>(null);
const defaultRecipientEmail = ref("");
/** 说明留空时的真实投递地址，保持与发票资料设置页一致。 */
const recipientEmailHint = computed(() => defaultRecipientEmail.value
  ? `留空时默认发送到您当前的注册邮箱：${defaultRecipientEmail.value}`
  : "留空时默认发送到您当前的注册邮箱");
const items = ref<AccountOrderInfoPaymentOrderItem[]>([]);
const total = ref(0);
const h5InvoicePendingCount = computed(() => items.value.filter((item) => (
  item.invoiceEligible && item.invoiceApplication?.issueStatus !== "ISSUED"
)).length);
const h5PageAmount = computed(() => items.value.reduce((sum, item) => sum + item.amountFen, 0));
const h5DateDraft = reactive({ paidFrom: "", paidTo: "" });
const h5DateFilterLabel = computed(() => {
  if (!filters.paidFrom && !filters.paidTo) return "日期筛选";
  return `${filters.paidFrom || "不限"} 至 ${filters.paidTo || "不限"}`;
});
const h5HasMore = computed(() => props.h5 && items.value.length < total.value);
/** 表格空态保留表头，避免企业成员暂无个人订单时内容区空白。 */
const paymentOrderTableLocale = computed(() => ({
  emptyText: loading.value ? "正在加载支付订单" : "暂无支付订单",
}));
/** 汇总当前查询条件，和顶部筛选控件保持同一口径。 */
const paymentOrderQuerySummary = computed(() => {
  const kindLabel = ORDER_KIND_OPTIONS.find((option) => option.value === filters.orderKind)?.label ?? "全部订单";
  const paidRange = filters.paidFrom || filters.paidTo
    ? `${filters.paidFrom || "不限"} 至 ${filters.paidTo || "不限"}`
    : "不限";
  return `订单类型：${kindLabel} / 支付日期：${paidRange} / 记录数：${total.value}`;
});

type InvoiceProfileForm = {
  invoiceType: InvoiceType;
  invoiceTitle: string;
  taxpayerId: string;
  recipientEmail: string;
  companyAddress: string;
  companyPhone: string;
  bankName: string;
  bankAccount: string;
};

const invoiceForm = reactive<InvoiceProfileForm>(createEmptyInvoiceProfileForm());
const isSpecialInvoice = () => invoiceForm.invoiceType === "SPECIAL";
const TAXPAYER_ID_PATTERN = /^[0-9A-Z]{15,20}$/;
const MOBILE_PHONE_PATTERN = /^(?:\+?86)?1[3-9]\d{9}$/;
const LANDLINE_PHONE_PATTERN = /^(?:0\d{2,3}-?)?\d{7,8}(?:-\d{1,6})?$/;
const BANK_ACCOUNT_PATTERN = /^\d{8,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 创建空发票表单，未维护资料的账号按空值展示。 */
function createEmptyInvoiceProfileForm(): InvoiceProfileForm {
  return {
    invoiceType: "GENERAL",
    invoiceTitle: "",
    taxpayerId: "",
    recipientEmail: "",
    companyAddress: "",
    companyPhone: "",
    bankName: "",
    bankAccount: "",
  };
}

/** 将已保存资料写入申请表单；无资料时恢复空表单。 */
function applyInvoiceProfile(profile: InvoiceProfileView | null): void {
  Object.assign(invoiceForm, createEmptyInvoiceProfileForm(), profile ? {
    invoiceType: profile.invoiceType,
    invoiceTitle: profile.invoiceTitle,
    taxpayerId: profile.taxpayerId,
    recipientEmail: profile.recipientEmail,
    companyAddress: profile.companyAddress,
    companyPhone: profile.companyPhone,
    bankName: profile.bankName,
    bankAccount: profile.bankAccount,
  } : {});
}

/** 归一化纳税人识别号，保持与服务端校验口径一致。 */
function normalizeTaxpayerId(value: string): string {
  return value.trim().replace(/\s/g, "").toUpperCase();
}

/** 归一化银行账号，允许用户输入空格或短横线。 */
function normalizeBankAccount(value: string): string {
  return value.trim().replace(/[\s-]/g, "");
}

/** 校验专票联系电话，支持手机号和区号固定电话。 */
function isValidInvoicePhone(value: string): boolean {
  const text = value.trim().replace(/\s/g, "");
  return MOBILE_PHONE_PATTERN.test(text.replace(/-/g, "")) || LANDLINE_PHONE_PATTERN.test(text);
}

function formatScope(scope: AccountOrderInfoPaymentOrderItem["scope"]): string {
  return scope === "ENTERPRISE" ? "企业" : "个人";
}

/** 显示当前订单归属主体，企业订单展示企业名，个人订单展示个人账号。 */
function formatOwnerLabel(record: AccountOrderInfoPaymentOrderItem): string {
  return record.scope === "ENTERPRISE" ? record.enterpriseName || "企业账号" : "个人账号";
}

/** 用户侧列表优先展示支付单号，未生成支付单时回退业务订单号。 */
function formatDisplayOrderId(record: AccountOrderInfoPaymentOrderItem): string {
  return record.paymentOrderId || record.businessOrderId;
}

/** 用户侧列表按支付完成时间展示；未支付订单回退创建时间，避免空白。 */
function formatDisplayOrderTime(record: AccountOrderInfoPaymentOrderItem): string {
  return formatDateTimeShort(record.paidAt ?? record.createdAt);
}

/** 压缩商品描述，只展示用户需要识别订单的标题和购买周期/到账金额。 */
function formatOrderSummary(record: AccountOrderInfoPaymentOrderItem): string {
  if (record.orderKind === "TOKEN" && record.relayTopUp) return `到账 ${formatRelayMoneyFromUsd(record.relayTopUp.quotaDeltaUsd)}`;
  return formatBillingCycleLabel(record.billingCycle, record.durationMonths);
}

/** 判断订单是否可开票，后端会排除赠送和兑换来源订单。 */
function isInvoiceEligible(record: AccountOrderInfoPaymentOrderItem): boolean {
  return record.invoiceEligible;
}

/** 格式化发票开具状态。 */
function formatInvoiceApplicationStatus(record: AccountOrderInfoPaymentOrderItem): string {
  if (!isInvoiceEligible(record)) return "-";
  if (record.invoiceApplication?.issueStatus === "ISSUED") return "已开票";
  const status = record.invoiceApplication?.status;
  if (status === "APPLIED") return "待开票";
  if (status === "PENDING") return "申请中";
  if (status === "FAILED") return "申请失败";
  return "未开票";
}

/** 按发票开具状态返回标签颜色。 */
function invoiceStatusTone(record: AccountOrderInfoPaymentOrderItem): string {
  if (!isInvoiceEligible(record)) return "default";
  if (record.invoiceApplication?.issueStatus === "ISSUED") return "green";
  const status = record.invoiceApplication?.status;
  if (status === "APPLIED" || status === "PENDING") return "gold";
  if (status === "FAILED") return "red";
  return "default";
}

/** 判断订单是否允许发起发票申请。 */
function canApplyInvoice(record: AccountOrderInfoPaymentOrderItem): boolean {
  if (!isInvoiceEligible(record)) return false;
  if (record.invoiceApplication?.issueStatus === "ISSUED") return false;
  const status = record.invoiceApplication?.status;
  return !status || status === "FAILED";
}

/** 读取上次保存的发票资料；失败时禁止继续提交申请。 */
async function loadInvoiceProfile(): Promise<void> {
  invoiceProfileLoading.value = true;
  invoiceProfileError.value = "";
  try {
    const result = await getInvoiceProfile(ctx.value);
    if (!result.ok) {
      invoiceProfileError.value = result.message || "发票资料加载失败";
      message.error(invoiceProfileError.value);
      return;
    }
    defaultRecipientEmail.value = result.defaultRecipientEmail;
    applyInvoiceProfile(result.profile);
  } catch (error) {
    invoiceProfileError.value = error instanceof Error ? error.message : "发票资料加载失败";
    message.error(invoiceProfileError.value);
  } finally {
    invoiceProfileLoading.value = false;
  }
}

/** 打开发票申请弹窗，并加载当前账号上次保存的资料。 */
function openInvoiceApplication(record: AccountOrderInfoPaymentOrderItem): void {
  selectedOrder.value = record;
  applyInvoiceProfile(null);
  defaultRecipientEmail.value = "";
  invoiceProfileError.value = "";
  invoiceModalOpen.value = true;
  void loadInvoiceProfile();
}

/** 校验发票申请资料，专票时公司地址、电话、开户行、银行账号也为必填。 */
function validateInvoiceProfile(): boolean {
  const missingFields: string[] = [];
  const taxpayerId = normalizeTaxpayerId(invoiceForm.taxpayerId);
  if (!invoiceForm.invoiceTitle.trim()) missingFields.push("公司全称");
  if (!taxpayerId) missingFields.push("纳税人识别号");
  const bankAccount = normalizeBankAccount(invoiceForm.bankAccount);
  if (invoiceForm.invoiceType === "SPECIAL") {
    if (!invoiceForm.companyAddress.trim()) missingFields.push("公司地址");
    if (!invoiceForm.companyPhone.trim()) missingFields.push("公司电话");
    if (!invoiceForm.bankName.trim()) missingFields.push("开户行");
    if (!bankAccount) missingFields.push("银行账号");
  }
  if (missingFields.length > 0) {
    message.warning(`请填写${missingFields.join("、")}`);
    return false;
  }
  if (!TAXPAYER_ID_PATTERN.test(taxpayerId)) {
    message.warning("纳税人识别号格式不合法，请输入15-20位大写字母或数字");
    return false;
  }
  const recipientEmail = invoiceForm.recipientEmail.trim();
  if (recipientEmail && !EMAIL_PATTERN.test(recipientEmail)) {
    message.warning("发票接收邮箱格式不合法");
    return false;
  }
  if (invoiceForm.invoiceType !== "SPECIAL") return true;
  if (!isValidInvoicePhone(invoiceForm.companyPhone)) {
    message.warning("公司电话格式不合法，请输入手机号或区号固定电话");
    return false;
  }
  if (!BANK_ACCOUNT_PATTERN.test(bankAccount)) {
    message.warning("银行账号格式不合法，请输入8-30位数字");
    return false;
  }
  return true;
}

/** 保存用户确认的资料并提交申请；任一步失败都停止后续状态流转。 */
async function submitInvoiceApplication(): Promise<void> {
  if (!selectedOrder.value || invoiceProfileLoading.value || invoiceProfileError.value) return;
  if (!validateInvoiceProfile()) return;
  applyingInvoice.value = true;
  try {
    const result = await createInvoiceApplication(ctx.value, selectedOrder.value.businessOrderId, {
      invoiceProfile: {
        invoiceType: invoiceForm.invoiceType,
        invoiceTitle: invoiceForm.invoiceTitle.trim(),
        taxpayerId: normalizeTaxpayerId(invoiceForm.taxpayerId),
        recipientEmail: invoiceForm.recipientEmail.trim() || undefined,
        companyAddress: invoiceForm.companyAddress.trim(),
        companyPhone: invoiceForm.companyPhone.trim(),
        bankName: invoiceForm.bankName.trim(),
        bankAccount: normalizeBankAccount(invoiceForm.bankAccount),
      },
    });
    if (!result.ok) {
      message.error(result.message);
      return;
    }
    message.success("发票申请已提交，平台将在24小时内发送到发票资料邮箱");
    invoiceModalOpen.value = false;
    selectedOrder.value = null;
    await loadList();
  } finally {
    applyingInvoice.value = false;
  }
}

/** 日期筛选统一按自然日取整，避免 date 输入只命中当天零点。 */
function resolveDateFilterTimestamp(value: string, endOfDay = false): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parts = normalized.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return undefined;
  const [year, month, day] = parts;
  const date = endOfDay
    ? new Date(year!, month! - 1, day!, 23, 59, 59, 999)
    : new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** 组装支付订单查询参数：顶部日期控件按整天过滤，列表仍按日期时间展示。 */
function buildQuery(): AccountOrderInfoPaymentOrdersQuery {
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    orderKind: filters.orderKind,
    paidFrom: filters.paidFrom ? resolveDateFilterTimestamp(filters.paidFrom) : undefined,
    paidTo: filters.paidTo ? resolveDateFilterTimestamp(filters.paidTo, true) : undefined,
  };
}

/** 拉取当前账号可见的支付订单列表。 */
async function loadList(options: { append?: boolean } = {}): Promise<void> {
  const append = options.append === true && props.h5;
  const previousPage = paging.page;
  if (append) {
    h5LoadingMore.value = true;
    paging.page = previousPage + 1;
  } else {
    loading.value = true;
  }
  try {
    const result = await listAccountOrderInfoPaymentOrders(ctx.value, buildQuery());
    if (!result.ok) {
      message.error(result.message);
      if (append) paging.page = previousPage;
      return;
    }
    items.value = append ? [...items.value, ...result.items] : result.items;
    total.value = result.total;
    paging.page = result.page;
    paging.pageSize = result.pageSize;
  } finally {
    if (append) h5LoadingMore.value = false;
    else loading.value = false;
  }
}

/** H5 订单按需追加下一批记录，不引入桌面页码控件。 */
async function loadMoreH5Orders(): Promise<void> {
  if (!h5HasMore.value || h5LoadingMore.value || loading.value) return;
  await loadList({ append: true });
}

/** 日期条件变化后回到第一页重新查询。 */
async function applyFilters(): Promise<void> {
  paging.page = 1;
  await loadList();
}

/** 清空支付日期筛选并回到第一页。 */
async function resetFilters(): Promise<void> {
  filters.orderKind = "ALL";
  filters.paidFrom = "";
  filters.paidTo = "";
  paging.page = 1;
  await loadList();
}

/** H5 订单类型分段选择后立即刷新，减少额外确认步骤。 */
async function selectH5OrderKind(orderKind: NonNullable<AccountOrderInfoPaymentOrdersQuery["orderKind"]>): Promise<void> {
  if (filters.orderKind === orderKind) return;
  filters.orderKind = orderKind;
  await applyFilters();
}

/** 打开 H5 日期筛选面板前同步已生效条件，取消时不污染查询状态。 */
function openH5Filter(): void {
  h5DateDraft.paidFrom = filters.paidFrom;
  h5DateDraft.paidTo = filters.paidTo;
  h5FilterOpen.value = true;
}

/** 应用 H5 日期筛选并关闭底部面板。 */
async function applyH5DateFilter(): Promise<void> {
  filters.paidFrom = h5DateDraft.paidFrom;
  filters.paidTo = h5DateDraft.paidTo;
  await applyFilters();
  h5FilterOpen.value = false;
}

/** 清空 H5 日期条件并立即回读全部订单。 */
async function resetH5DateFilter(): Promise<void> {
  h5DateDraft.paidFrom = "";
  h5DateDraft.paidTo = "";
  filters.paidFrom = "";
  filters.paidTo = "";
  await applyFilters();
  h5FilterOpen.value = false;
}

async function handlePageChange(page: number, pageSize?: number): Promise<void> {
  paging.page = page;
  paging.pageSize = pageSize ?? paging.pageSize;
  await loadList();
}

async function handlePaginationChange(page: number, pageSize: number): Promise<void> {
  const pageSizeChanged = pageSize !== paging.pageSize;
  await handlePageChange(pageSizeChanged ? 1 : page, pageSize);
}

async function handlePageSizeChange(_: number, pageSize: number): Promise<void> {
  await handlePageChange(1, pageSize);
}

onMounted(() => {
  void loadList();
});
</script>

<template>
  <div class="admin-panel account-order-info-payment-orders" :class="{ 'account-order-info-payment-orders--h5': props.h5 }">
    <header v-if="props.h5" class="account-order-info-payment-orders__h5-header">
      <div>
        <h1>订单</h1>
        <p>套餐与账单</p>
      </div>
      <span>{{ total }} 笔</span>
    </header>

    <div v-if="!props.h5" class="account-order-info-payment-orders__header">
      <div>
        <h2 class="admin-panel__title">支付订单</h2>
        <p class="admin-panel__description">当前账号可见的套餐和 Token 支付订单</p>
      </div>
      <span class="account-order-info-payment-orders__query-summary">{{ paymentOrderQuerySummary }}</span>
    </div>

    <section v-if="props.h5" class="account-order-info-payment-orders__h5-summary" aria-label="订单概览">
      <div><strong>{{ total }}</strong><span>全部订单</span></div>
      <div><strong>{{ h5InvoicePendingCount }}</strong><span>待开票</span></div>
      <div><strong>{{ formatPriceFen(h5PageAmount) }}</strong><span>本页实付</span></div>
    </section>

    <div v-if="props.h5" class="account-order-info-payment-orders__h5-controls">
      <div class="account-order-info-payment-orders__h5-kinds" role="tablist" aria-label="订单类型">
        <button
          v-for="option in ORDER_KIND_OPTIONS"
          :key="option.value"
          type="button"
          role="tab"
          :aria-selected="filters.orderKind === option.value"
          :class="{ active: filters.orderKind === option.value }"
          @click="selectH5OrderKind(option.value)"
        >
          {{ option.value === 'ALL' ? '全部' : option.label.replace('订单', '') }}
        </button>
      </div>
      <button type="button" class="account-order-info-payment-orders__h5-date-filter" @click="openH5Filter">
        <span>{{ h5DateFilterLabel }}</span>
        <b>{{ filters.paidFrom || filters.paidTo ? '已筛选' : '筛选' }}</b>
      </button>
    </div>

    <div v-if="!props.h5" class="account-order-info-payment-orders__toolbar">
      <a-select v-model:value="filters.orderKind" class="account-order-info-payment-orders__field account-order-info-payment-orders__field--select">
        <a-select-option v-for="option in ORDER_KIND_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
      </a-select>
      <label class="account-order-info-payment-orders__field account-order-info-payment-orders__field--date-group">
        <span class="account-order-info-payment-orders__date-label">支付日期始</span>
        <a-input v-model:value="filters.paidFrom" aria-label="支付日期始" class="account-order-info-payment-orders__date-input" type="date" />
      </label>
      <label class="account-order-info-payment-orders__field account-order-info-payment-orders__field--date-group">
        <span class="account-order-info-payment-orders__date-label">支付日期止</span>
        <a-input v-model:value="filters.paidTo" aria-label="支付日期止" class="account-order-info-payment-orders__date-input" type="date" />
      </label>
      <div class="account-order-info-payment-orders__toolbar-actions">
        <a-button type="primary" :loading="loading" @click="applyFilters">查询</a-button>
        <a-button @click="resetFilters">重置</a-button>
      </div>
    </div>

    <a-table
      v-if="!props.h5"
      class="account-order-info-payment-orders__table"
      :data-source="items"
      :loading="loading"
      :locale="paymentOrderTableLocale"
      :pagination="false"
      row-key="businessOrderId"
      size="small"
      :scroll="{ x: 'max-content', y: '100%' }"
    >
      <a-table-column title="订单时间" :width="80" fixed="left">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell">
            {{ formatDisplayOrderTime(record) }}
          </div>
        </template>
      </a-table-column>
      <a-table-column title="订单编号" :width="120">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell">
            {{ formatDisplayOrderId(record) }}
          </div>
        </template>
      </a-table-column>
      <a-table-column title="订单类型" :width="88">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell">
            <a-tag :bordered="false">{{ formatOrderKind(record.orderKind) }}</a-tag>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="商品内容" :width="180">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell">
            <strong>{{ record.title }}</strong>
            <small>{{ formatOrderSummary(record) }}</small>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="支付状态" :width="80">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell account-order-info-payment-orders__cell--status">
            <a-tag :color="paymentStatusTone(record.paymentStatus)">{{ formatPaymentStatus(record.paymentStatus) }}</a-tag>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="订单金额" :width="80">
        <template #default="{ record }">
          <div class="account-order-info-payment-orders__cell">
            <strong>{{ formatPriceFen(record.amountFen) }}</strong>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="发票状态" :width="80">
        <template #default="{ record }">
          <span v-if="!isInvoiceEligible(record)">-</span>
          <a-tag v-else :color="invoiceStatusTone(record)">{{ formatInvoiceApplicationStatus(record) }}</a-tag>
        </template>
      </a-table-column>
      <a-table-column title="操作" :width="120" fixed="right">
        <template #default="{ record }">
          <a-button v-if="canApplyInvoice(record)" size="small" type="primary" @click="openInvoiceApplication(record)">申请发票</a-button>
          <span v-else>-</span>
        </template>
      </a-table-column>
    </a-table>

    <div v-else class="account-order-info-payment-orders__h5-spin">
      <a-spin :spinning="loading">
        <div class="account-order-info-payment-orders__h5-list" aria-live="polite">
          <a-empty v-if="!loading && items.length === 0" description="暂无支付订单" />
          <article v-for="record in items" :key="record.businessOrderId" class="account-order-info-payment-orders__h5-card">
            <div class="account-order-info-payment-orders__h5-card-top">
              <span>订单号 {{ formatDisplayOrderId(record) }}</span>
              <a-tag :color="paymentStatusTone(record.paymentStatus)">{{ formatPaymentStatus(record.paymentStatus) }}</a-tag>
            </div>
            <div class="account-order-info-payment-orders__h5-product">
              <span class="account-order-info-payment-orders__h5-product-icon">{{ record.orderKind === 'TOKEN' ? 'T' : 'CF' }}</span>
              <span>
                <strong>{{ record.title }}</strong>
                <small>{{ formatOrderSummary(record) }} · {{ formatOwnerLabel(record) }}</small>
              </span>
            </div>
            <div class="account-order-info-payment-orders__h5-meta">
              <span>支付时间 {{ formatDisplayOrderTime(record) }}</span>
              <span>实付 <strong>{{ formatPriceFen(record.amountFen) }}</strong></span>
            </div>
            <div class="account-order-info-payment-orders__h5-invoice">
              <span>发票状态 <a-tag v-if="isInvoiceEligible(record)" :color="invoiceStatusTone(record)">{{ formatInvoiceApplicationStatus(record) }}</a-tag><b v-else>无需开票</b></span>
              <a-button v-if="canApplyInvoice(record)" type="link" @click="openInvoiceApplication(record)">申请发票</a-button>
            </div>
          </article>
          <button
            v-if="h5HasMore"
            type="button"
            class="account-order-info-payment-orders__h5-load-more"
            :disabled="h5LoadingMore"
            @click="loadMoreH5Orders"
          >
            {{ h5LoadingMore ? '正在加载' : '加载更多订单' }}
          </button>
        </div>
      </a-spin>
    </div>

    <div v-if="!props.h5" class="account-order-info-payment-orders__pagination">
      <div class="account-order-info-payment-orders__pagination-total">共 {{ total }} 条记录</div>
      <a-pagination
        :current="paging.page"
        :page-size="paging.pageSize"
        :total="total"
        :show-size-changer="!props.h5"
        :show-quick-jumper="total > paging.pageSize"
        :page-size-options="paging.pageSizeOptions"
        :show-less-items="true"
        @change="handlePaginationChange"
        @showSizeChange="handlePageSizeChange"
      >
        <template #buildOptionText="{ value }">
          {{ value }} 条/页
        </template>
      </a-pagination>
    </div>

    <a-drawer
      v-if="props.h5"
      v-model:open="h5FilterOpen"
      placement="bottom"
      height="min(56dvh, 460px)"
      :closable="false"
      root-class-name="h5-order-filter-drawer"
    >
      <section class="account-order-info-payment-orders__h5-filter-sheet">
        <header>
          <div><span>订单筛选</span><strong>选择支付日期</strong></div>
          <button type="button" @click="h5FilterOpen = false">完成</button>
        </header>
        <label><span>开始日期</span><input v-model="h5DateDraft.paidFrom" type="date" aria-label="H5支付日期始" /></label>
        <label><span>结束日期</span><input v-model="h5DateDraft.paidTo" type="date" aria-label="H5支付日期止" /></label>
        <div class="account-order-info-payment-orders__h5-filter-actions">
          <button type="button" @click="resetH5DateFilter">清除日期</button>
          <button type="button" class="primary" :disabled="loading" @click="applyH5DateFilter">{{ loading ? '查询中' : '查看订单' }}</button>
        </div>
      </section>
    </a-drawer>

    <a-modal
      v-model:open="invoiceModalOpen"
      title="申请发票"
      :width="props.h5 ? '100%' : 720"
      :wrap-class-name="props.h5 ? 'h5-invoice-modal' : undefined"
      :confirm-loading="applyingInvoice"
      :ok-button-props="{ disabled: invoiceProfileLoading || Boolean(invoiceProfileError) }"
      ok-text="确认并提交申请"
      cancel-text="取消"
      @ok="submitInvoiceApplication"
    >
      <div class="account-order-info-payment-orders__invoice-modal">
        <div v-if="selectedOrder" class="account-order-info-payment-orders__invoice-order">
          <div><span>订单</span><strong>{{ selectedOrder.title }}</strong></div>
          <div><span>订单金额</span><strong>{{ formatPriceFen(selectedOrder.amountFen) }}</strong></div>
          <div><span>订单编号</span><strong>{{ formatDisplayOrderId(selectedOrder) }}</strong></div>
        </div>

        <a-alert
          v-if="invoiceProfileError"
          type="error"
          show-icon
          :message="invoiceProfileError"
          description="发票资料未成功加载，不能继续申请。"
        >
          <template #action><a-button size="small" :loading="invoiceProfileLoading" @click="loadInvoiceProfile">重试</a-button></template>
        </a-alert>

        <a-spin :spinning="invoiceProfileLoading">
          <div class="account-order-info-payment-orders__invoice-form">
            <div class="account-order-info-payment-orders__invoice-intro">
              <strong>确认开票信息</strong>
              <span>已自动带入上次保存的结果；修改后会作为新的默认资料保存。</span>
            </div>

            <label class="account-order-info-payment-orders__invoice-field account-order-info-payment-orders__invoice-field--wide">
              <span>发票类型</span>
              <a-radio-group v-model:value="invoiceForm.invoiceType">
                <a-radio value="GENERAL">普票</a-radio>
                <a-radio value="SPECIAL">专票</a-radio>
              </a-radio-group>
            </label>

            <label class="account-order-info-payment-orders__invoice-field">
              <span>公司全称 <span style="color:#ff4d4f">*</span></span>
              <a-input v-model:value="invoiceForm.invoiceTitle" placeholder="请输入公司全称" :maxlength="120" />
            </label>
            <label class="account-order-info-payment-orders__invoice-field">
              <span>纳税人识别号 <span style="color:#ff4d4f">*</span></span>
              <a-input v-model:value="invoiceForm.taxpayerId" placeholder="15-20位大写字母或数字" :maxlength="20" />
            </label>
            <label class="account-order-info-payment-orders__invoice-field account-order-info-payment-orders__invoice-field--wide">
              <span>发票接收邮箱</span>
              <a-input v-model:value="invoiceForm.recipientEmail" :placeholder="recipientEmailHint" :maxlength="160" />
              <small>{{ recipientEmailHint }}</small>
            </label>

            <label class="account-order-info-payment-orders__invoice-field">
              <span>公司地址</span>
              <a-input v-model:value="invoiceForm.companyAddress" :placeholder="isSpecialInvoice() ? '专票必填' : '选填'" :maxlength="200" />
            </label>
            <label class="account-order-info-payment-orders__invoice-field">
              <span>公司电话</span>
              <a-input v-model:value="invoiceForm.companyPhone" :placeholder="isSpecialInvoice() ? '专票必填' : '选填'" :maxlength="60" />
            </label>
            <label class="account-order-info-payment-orders__invoice-field">
              <span>开户行</span>
              <a-input v-model:value="invoiceForm.bankName" :placeholder="isSpecialInvoice() ? '专票必填' : '选填'" :maxlength="120" />
            </label>
            <label class="account-order-info-payment-orders__invoice-field">
              <span>银行账号</span>
              <a-input v-model:value="invoiceForm.bankAccount" :placeholder="isSpecialInvoice() ? '专票必填' : '选填'" :maxlength="36" />
            </label>
          </div>
        </a-spin>

        <a-alert type="info" show-icon message="提交后平台将在1个工作日内处理，并发送到上述接收邮箱。" />
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.account-order-info-payment-orders {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 14px;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.account-order-info-payment-orders--h5 {
  box-sizing: border-box;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 12px;
  padding: 0 12px 12px;
  overflow: hidden;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-bg) 94%, var(--app-surface));
}

.account-order-info-payment-orders__h5-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.account-order-info-payment-orders__h5-kinds {
  min-width: 0;
  height: 42px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary) 88%, var(--app-surface));
}

.account-order-info-payment-orders__h5-kinds button {
  min-width: 0;
  border: 0;
  border-radius: 11px;
  color: var(--app-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 620;
}

.account-order-info-payment-orders__h5-kinds button.active {
  color: var(--app-accent);
  background: var(--app-surface);
  box-shadow: 0 3px 10px color-mix(in srgb, #000 7%, transparent);
}

.account-order-info-payment-orders__h5-date-filter {
  max-width: 108px;
  min-height: 42px;
  display: grid;
  align-content: center;
  gap: 1px;
  padding: 0 11px;
  border: 1px solid var(--app-divider);
  border-radius: 13px;
  color: var(--app-text);
  background: var(--app-surface);
  text-align: left;
}

.account-order-info-payment-orders__h5-date-filter span {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-order-info-payment-orders__h5-date-filter b {
  color: var(--app-accent);
  font-size: 10px;
  font-weight: 650;
}

.account-order-info-payment-orders__h5-filter-sheet {
  height: 100%;
  display: grid;
  align-content: start;
  gap: 12px;
  color: var(--app-text);
}

.account-order-info-payment-orders__h5-filter-sheet header {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.account-order-info-payment-orders__h5-filter-sheet header div {
  display: grid;
  gap: 2px;
}

.account-order-info-payment-orders__h5-filter-sheet header span,
.account-order-info-payment-orders__h5-filter-sheet > label {
  color: var(--app-muted);
  font-size: 12px;
}

.account-order-info-payment-orders__h5-filter-sheet header strong {
  font-size: 18px;
}

.account-order-info-payment-orders__h5-filter-sheet header button {
  min-width: 48px;
  min-height: 44px;
  border: 0;
  color: var(--app-accent);
  background: transparent;
  font-weight: 680;
}

.account-order-info-payment-orders__h5-filter-sheet > label {
  display: grid;
  gap: 7px;
}

.account-order-info-payment-orders__h5-filter-sheet input {
  min-height: 48px;
  box-sizing: border-box;
  padding: 0 13px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  outline: 0;
  color: var(--app-text);
  background: var(--app-bg-secondary);
  font: inherit;
}

.account-order-info-payment-orders__h5-filter-actions {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 9px;
  margin-top: 4px;
}

.account-order-info-payment-orders__h5-filter-actions button {
  min-height: 50px;
  border: 1px solid var(--app-border);
  border-radius: 15px;
  color: var(--app-text);
  background: var(--app-bg-secondary);
  font-weight: 680;
}

.account-order-info-payment-orders__h5-filter-actions button.primary {
  border-color: var(--app-accent);
  color: #fff;
  background: var(--app-accent);
}

.account-order-info-payment-orders__h5-header {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-inline: -12px;
  padding: 12px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 70%, transparent);
  background: color-mix(in srgb, var(--app-bg) 86%, transparent);
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
}

.account-order-info-payment-orders__h5-header h1,
.account-order-info-payment-orders__h5-header p {
  margin: 0;
  letter-spacing: 0;
}

.account-order-info-payment-orders__h5-header h1 {
  font-size: 21px;
  line-height: 1.25;
  font-weight: 720;
}

.account-order-info-payment-orders__h5-header p,
.account-order-info-payment-orders__h5-header > span {
  color: var(--app-muted);
  font-size: 12px;
}

.account-order-info-payment-orders__h5-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-divider) 80%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-surface) 94%, transparent);
  box-shadow: 0 10px 26px color-mix(in srgb, #000 5%, transparent);
}

.account-order-info-payment-orders__h5-summary > div {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 13px 8px;
  border-right: 1px solid color-mix(in srgb, var(--app-divider) 70%, transparent);
  text-align: center;
}

.account-order-info-payment-orders__h5-summary > div:last-child {
  border-right: 0;
}

.account-order-info-payment-orders__h5-summary strong {
  overflow: hidden;
  color: var(--app-text);
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-order-info-payment-orders__h5-summary span {
  color: var(--app-muted);
  font-size: 11px;
}

.account-order-info-payment-orders--h5 .account-order-info-payment-orders__toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.account-order-info-payment-orders--h5 .account-order-info-payment-orders__field--select,
.account-order-info-payment-orders--h5 .account-order-info-payment-orders__field--date-group {
  width: 100%;
  min-width: 0;
}

.account-order-info-payment-orders--h5 .account-order-info-payment-orders__field--select,
.account-order-info-payment-orders--h5 .account-order-info-payment-orders__toolbar-actions {
  grid-column: 1 / -1;
}

.account-order-info-payment-orders--h5 .account-order-info-payment-orders__toolbar-actions :deep(.ant-btn) {
  letter-spacing: 0;
}

.account-order-info-payment-orders--h5 .account-order-info-payment-orders__toolbar-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  margin: 0;
}

.account-order-info-payment-orders__h5-spin {
  display: block;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.account-order-info-payment-orders__h5-spin :deep(.ant-spin-nested-loading),
.account-order-info-payment-orders__h5-spin :deep(.ant-spin-container) {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.account-order-info-payment-orders__h5-list {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-content: start;
  gap: 10px;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 1px 1px 10px;
  overscroll-behavior: contain;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.account-order-info-payment-orders__h5-list::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.account-order-info-payment-orders__h5-load-more {
  flex: 0 0 auto;
  min-height: 44px;
  margin: 2px 4px 4px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-divider));
  border-radius: 13px;
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-surface));
  font-size: 13px;
  font-weight: 650;
}

.account-order-info-payment-orders__h5-load-more:disabled {
  opacity: 0.55;
}

.account-order-info-payment-orders__h5-card {
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-divider) 80%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-surface) 95%, transparent);
  box-shadow: 0 8px 22px color-mix(in srgb, #000 5%, transparent);
}

.account-order-info-payment-orders__h5-card-top,
.account-order-info-payment-orders__h5-meta,
.account-order-info-payment-orders__h5-invoice {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
}

.account-order-info-payment-orders__h5-card-top {
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 65%, transparent);
  color: var(--app-muted);
  font-size: 11px;
}

.account-order-info-payment-orders__h5-card-top > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-order-info-payment-orders__h5-product {
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px;
}

.account-order-info-payment-orders__h5-product-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: #fff;
  background: var(--app-accent);
  font-size: 13px;
  font-weight: 750;
}

.account-order-info-payment-orders__h5-product > span:last-child {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.account-order-info-payment-orders__h5-product strong,
.account-order-info-payment-orders__h5-product small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-order-info-payment-orders__h5-product strong {
  font-size: 14px;
}

.account-order-info-payment-orders__h5-product small,
.account-order-info-payment-orders__h5-meta,
.account-order-info-payment-orders__h5-invoice {
  color: var(--app-muted);
  font-size: 11px;
}

.account-order-info-payment-orders__h5-meta {
  padding-top: 0;
}

.account-order-info-payment-orders__h5-meta strong {
  color: var(--app-text);
  font-size: 13px;
}

.account-order-info-payment-orders__h5-invoice {
  min-height: 48px;
  border-top: 1px solid color-mix(in srgb, var(--app-divider) 65%, transparent);
}

.account-order-info-payment-orders__h5-invoice > span {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}

.account-order-info-payment-orders__h5-invoice b {
  color: var(--app-muted);
  font-weight: 500;
}

.account-order-info-payment-orders__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.admin-panel__title {
  margin: 0;
  font-size: 18px;
}

.admin-panel__description {
  margin: 6px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.account-order-info-payment-orders__query-summary {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.account-order-info-payment-orders__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.account-order-info-payment-orders__field {
  min-width: 0;
}

.account-order-info-payment-orders__field--select {
  flex: 0 1 150px;
  width: 150px;
  min-width: min(100%, 140px);
}

.account-order-info-payment-orders__field--date-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 220px;
  width: 220px;
  min-width: min(100%, 204px);
}

.account-order-info-payment-orders__date-label {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}

.account-order-info-payment-orders__date-input {
  flex: 1 1 auto;
  min-width: 0;
}

.account-order-info-payment-orders__date-input:deep(.ant-input) {
  min-width: 0;
}

.account-order-info-payment-orders__toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  margin-left: auto;
}

.account-order-info-payment-orders__table {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.account-order-info-payment-orders__table :deep(.ant-spin-nested-loading),
.account-order-info-payment-orders__table :deep(.ant-spin-container),
.account-order-info-payment-orders__table :deep(.ant-table),
.account-order-info-payment-orders__table :deep(.ant-table-container) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
}

.account-order-info-payment-orders__table :deep(.ant-table-content) {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  overflow: auto;
}

.account-order-info-payment-orders__table :deep(.ant-table-header) {
  flex: 0 0 auto;
}

.account-order-info-payment-orders__table :deep(.ant-table-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto !important;
}

.account-order-info-payment-orders__table :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 42px;
  padding: 11px 8px;
  font-size: 12px;
  line-height: 20px;
}

.account-order-info-payment-orders__table :deep(.ant-table-tbody > tr > td) {
  padding: 9px 8px;
  vertical-align: middle;
}

.account-order-info-payment-orders__cell {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.account-order-info-payment-orders__cell strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.account-order-info-payment-orders__cell small {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.account-order-info-payment-orders__cell--invoice {
  align-items: flex-start;
}

.account-order-info-payment-orders__cell--status {
  align-items: flex-start;
}

.account-order-info-payment-orders__invoice-action {
  width: fit-content;
  min-width: 48px;
  padding-inline: 10px;
}

.account-order-info-payment-orders__invoice-modal {
  display: grid;
  gap: 16px;
}

.account-order-info-payment-orders__invoice-order {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(110px, .5fr) minmax(160px, .8fr);
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--app-border);
}

.account-order-info-payment-orders__invoice-order > div,
.account-order-info-payment-orders__invoice-field,
.account-order-info-payment-orders__invoice-intro {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.account-order-info-payment-orders__invoice-order span,
.account-order-info-payment-orders__invoice-field > span {
  color: var(--app-muted);
  font-size: 12px;
}

.account-order-info-payment-orders__invoice-order strong {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.account-order-info-payment-orders__invoice-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
  min-height: 220px;
}

.account-order-info-payment-orders__invoice-intro,
.account-order-info-payment-orders__invoice-field--wide {
  grid-column: 1 / -1;
}

.account-order-info-payment-orders__invoice-intro {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  padding-bottom: 2px;
}

.account-order-info-payment-orders__invoice-intro span,
.account-order-info-payment-orders__invoice-field small {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.account-order-info-payment-orders__invoice-field {
  align-content: start;
}

.account-order-info-payment-orders__pagination {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.account-order-info-payment-orders__pagination-total {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}

@media (max-width: 768px) {
  .account-order-info-payment-orders__field--select,
  .account-order-info-payment-orders__field--date-group {
    flex-basis: 100%;
    width: 100%;
    min-width: 0;
  }

  .account-order-info-payment-orders__date-input {
    flex: 1 1 0;
  }

  .account-order-info-payment-orders__toolbar-actions {
    display: grid;
    width: 100%;
    margin-left: 0;
    flex-wrap: wrap;
  }

  .account-order-info-payment-orders__invoice-order,
  .account-order-info-payment-orders__invoice-form,
  .account-order-info-payment-orders__invoice-intro {
    grid-template-columns: minmax(0, 1fr);
  }
}

:global(.h5-order-filter-drawer .ant-drawer-content-wrapper),
:global(.h5-order-filter-drawer .ant-drawer-content) {
  overflow: hidden;
  border-radius: 24px 24px 0 0;
}

:global(.h5-order-filter-drawer .ant-drawer-body) {
  padding: 8px 16px max(14px, min(env(safe-area-inset-bottom, 0px), 8px));
  background: color-mix(in srgb, var(--app-panel-bg) 96%, transparent);
  backdrop-filter: blur(24px) saturate(1.22);
}

:global(.h5-invoice-modal) {
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}

:global(.h5-invoice-modal .ant-modal) {
  top: 0;
  width: 100% !important;
  max-width: 100%;
  margin: 0;
  padding: 0;
}

:global(.h5-invoice-modal .ant-modal-content) {
  max-height: min(86dvh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  border-radius: 24px 24px 0 0;
  background: color-mix(in srgb, var(--app-panel-bg) 97%, transparent);
}

:global(.h5-invoice-modal .ant-modal-header) {
  flex: 0 0 auto;
  margin: 0;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--app-divider);
  background: transparent;
}

:global(.h5-invoice-modal .ant-modal-body) {
  min-height: 0;
  overflow-y: auto;
  padding: 14px 14px 8px;
}

:global(.h5-invoice-modal .ant-modal-footer) {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 9px;
  margin: 0;
  padding: 10px 14px max(12px, min(env(safe-area-inset-bottom, 0px), 8px));
  border-top: 1px solid var(--app-divider);
}

:global(.h5-invoice-modal .ant-modal-footer .ant-btn) {
  min-height: 48px;
  margin: 0;
  border-radius: 14px;
}

@media (max-width: 340px) {
  .account-order-info-payment-orders--h5 .account-order-info-payment-orders__date-label {
    display: none;
  }
}
</style>
