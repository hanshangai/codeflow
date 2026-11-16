import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type {
  PaymentOrderDetailView,
  PaymentOrderFilterView,
  PaymentOrderListItemView,
  VerificationProductResponseBody,
} from "@codeflowai/shared";

import {
  cancelPaymentOrder,
  createVerificationOrder,
  getPaymentOrderDetail,
  getVerificationProduct,
  listVerificationOrders,
  verifyPaymentOrder,
} from "../../../api/payment";
import { useApiContext } from "../../../composables/useApiContext";
import {
  collectPollingOrderIds,
  isPendingVerificationOrder,
  mergePolledOrderIntoList,
} from "../paymentVerificationState";

export function usePaymentVerification() {
  const { ctx } = useApiContext();
  const product = ref<VerificationProductResponseBody | null>(null);
  const activeOrder = ref<PaymentOrderDetailView | null>(null);
  const detailOrder = ref<PaymentOrderDetailView | null>(null);
  const items = ref<PaymentOrderListItemView[]>([]);
  const total = ref(0);
  const productLoading = ref(false);
  const listLoading = ref(false);
  const creating = ref(false);
  const refreshing = ref(false);
  const createDrawerOpen = ref(false);
  const detailDrawerOpen = ref(false);
  const activeOrderId = ref<string | null>(null);
  const polling = ref(false);
  const nowTick = ref(Date.now());
  const filters = ref<PaymentOrderFilterView>({
    status: "ALL",
    confirmedBy: "ALL",
    keyword: "",
    page: 1,
    pageSize: 20,
  });

  let pollTimer: number | null = null;
  let tickTimer: number | null = null;

  const countdownSeconds = computed(() => {
    if (!isPendingVerificationOrder(activeOrder.value)) return null;
    const expiresAt = activeOrder.value?.qrExpiresAt ?? null;
    if (!expiresAt) return null;
    return Math.max(0, Math.ceil((expiresAt - nowTick.value) / 1000));
  });

  function clearPolling() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    polling.value = false;
  }

  async function loadProduct() {
    productLoading.value = true;
    try {
      const res = await getVerificationProduct(ctx.value);
      if (!res.ok) {
        message.error(res.message);
        return;
      }
      product.value = res;
    } finally {
      productLoading.value = false;
    }
  }

  async function loadOrderDetail(orderId: string, opts?: { activate?: boolean; silent?: boolean }) {
    const res = await getPaymentOrderDetail(ctx.value, orderId);
    if (!res.ok) {
      if (!opts?.silent) message.error(res.message);
      return null;
    }
    items.value = mergePolledOrderIntoList(items.value, res.order);
    if (opts?.activate) {
      activeOrderId.value = res.order.orderId;
      activeOrder.value = res.order;
    }
    if (detailDrawerOpen.value && detailOrder.value?.orderId === res.order.orderId) {
      detailOrder.value = res.order;
    }
    return res.order;
  }

  async function loadOrders(opts?: { syncActive?: boolean; silent?: boolean }) {
    if (!opts?.silent) listLoading.value = true;
    try {
      const res = await listVerificationOrders(ctx.value, filters.value);
      if (!res.ok) {
        if (!opts?.silent) message.error(res.message);
        return;
      }
      items.value = res.items;
      total.value = res.total;
      if (opts?.syncActive === false) return;
      if (!activeOrderId.value) {
        const preferred = res.items.find((item) => item.status === "QR_READY" || item.status === "PAYING") ?? res.items[0] ?? null;
        if (preferred) {
          await loadOrderDetail(preferred.orderId, { activate: true, silent: true });
        } else {
          activeOrder.value = null;
        }
        return;
      }

      const stillVisible = res.items.some((item) => item.orderId === activeOrderId.value);
      if (stillVisible) {
        await loadOrderDetail(activeOrderId.value, { activate: true, silent: true });
      }
    } finally {
      if (!opts?.silent) listLoading.value = false;
    }
  }

  async function createOrder(remark: string) {
    const currentProduct = product.value;
    if (!currentProduct) return;
    creating.value = true;
    try {
      const res = await createVerificationOrder(ctx.value, {
        productCode: currentProduct.productCode,
        reuseActiveOrder: true,
        orderScene: "PAYMENT_VERIFICATION_PAGE",
        remark: remark.trim() || undefined,
      });
      if (!res.ok) {
        message.error(res.message);
        return;
      }
      createDrawerOpen.value = false;
      activeOrderId.value = res.order.orderId;
      activeOrder.value = res.order;
      if (detailDrawerOpen.value && detailOrder.value?.orderId === res.order.orderId) {
        detailOrder.value = res.order;
      }
      await loadOrders();
    } finally {
      creating.value = false;
    }
  }

  async function verifyOrder(orderId: string, triggerSource: "PAGE_REFRESH" | "DETAIL_DRAWER") {
    refreshing.value = true;
    try {
      const res = await verifyPaymentOrder(ctx.value, orderId, { triggerSource });
      if (!res.ok) {
        message.error(res.message);
        return;
      }
      if (activeOrderId.value === orderId) {
        activeOrder.value = res.order;
      }
      if (detailDrawerOpen.value && detailOrder.value?.orderId === orderId) {
        detailOrder.value = res.order;
      }
      await loadOrders();
    } finally {
      refreshing.value = false;
    }
  }

  async function cancelOrder(orderId: string) {
    refreshing.value = true;
    try {
      const res = await cancelPaymentOrder(ctx.value, orderId, { reason: "USER_CANCELLED" });
      if (!res.ok) {
        message.error(res.message);
        return;
      }
      if (activeOrderId.value === orderId) {
        activeOrder.value = res.order;
      }
      if (detailDrawerOpen.value && detailOrder.value?.orderId === orderId) {
        detailOrder.value = res.order;
      }
      await loadOrders();
    } finally {
      refreshing.value = false;
    }
  }

  async function openDetailDrawer(orderId: string) {
    detailDrawerOpen.value = true;
    const order = await loadOrderDetail(orderId, { silent: false });
    if (order) detailOrder.value = order;
  }

  function closeDetailDrawer() {
    detailDrawerOpen.value = false;
    detailOrder.value = null;
  }

  function schedulePolling() {
    clearPolling();
    const pollOrderIds = collectPollingOrderIds(activeOrder.value, detailOrder.value);
    if (!pollOrderIds.length) return;
    polling.value = true;
    const oldestVisibleCreatedAt = Math.min(
      activeOrder.value?.createdAt ?? Number.MAX_SAFE_INTEGER,
      detailOrder.value?.createdAt ?? Number.MAX_SAFE_INTEGER,
    );
    const ageMs = Date.now() - (Number.isFinite(oldestVisibleCreatedAt) ? oldestVisibleCreatedAt : Date.now());
    const delay = ageMs >= 60_000 ? 10_000 : 5_000;
    pollTimer = window.setTimeout(async () => {
      await Promise.all(
        pollOrderIds.map((orderId) =>
          loadOrderDetail(orderId, { activate: activeOrderId.value === orderId, silent: true })),
      );
      await loadOrders({ syncActive: false, silent: true });
      schedulePolling();
    }, delay);
  }

  async function changeFilters(next: Partial<PaymentOrderFilterView>) {
    filters.value = {
      ...filters.value,
      ...next,
      page: next.page ?? 1,
    };
    await loadOrders();
  }

  async function copyOutTradeNo(outTradeNo: string) {
    try {
      await navigator.clipboard.writeText(outTradeNo);
      message.success("订单号已复制");
    } catch {
      message.error("复制失败");
    }
  }

  watch(
    () => [activeOrder.value?.orderId, activeOrder.value?.status, activeOrder.value?.createdAt, activeOrder.value?.qrExpiresAt],
    () => {
      schedulePolling();
    },
    { immediate: true },
  );

  onMounted(async () => {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
    await loadProduct();
    await loadOrders();
  });

  onUnmounted(() => {
    clearPolling();
    if (tickTimer !== null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  });

  return {
    product,
    activeOrder,
    detailOrder,
    items,
    total,
    filters,
    productLoading,
    listLoading,
    creating,
    refreshing,
    polling,
    countdownSeconds,
    createDrawerOpen,
    detailDrawerOpen,
    openCreateDrawer: () => {
      createDrawerOpen.value = true;
    },
    closeCreateDrawer: () => {
      createDrawerOpen.value = false;
    },
    createOrder,
    verifyOrder,
    cancelOrder,
    openDetailDrawer,
    closeDetailDrawer,
    changeFilters,
    copyOutTradeNo,
  };
}
