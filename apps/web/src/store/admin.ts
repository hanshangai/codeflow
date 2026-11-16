import { defineStore } from "pinia";
import type { PaymentOrderKind } from "@codeflowai/shared";

import { trackProductEvent } from "../analytics/analytics";

export type AdminPanel =
  | "settings"
  | "workspaces"
  | "account-settings"
  | "engine-keys"
  | "relay-self-usage"
  | "marketplace"
  | "message-notifications"
  | "scheduled-tasks"
  | "feedback"
  | "orchestration-metrics"
  | "contact-info"
  | "dashboard"
  | "desktop-crash-reports"
  | "tls-certificates"
  | "email"
  | "sessions"
  | "user-management"
  | "packages"
  | "payment-orders"
  | "payment-management"
  | "redemption-codes"
  | "invitations"
  | "invoice-management"
  | "relay-config"
  | "relay-price-config"
  | "relay-recharge-pricing"
  | "relay-management"
  | "relay-mapping"
  | "best-practices"
  | "in-app-notices"
  | "wechat-official-account"
  | "audit"
  | "enterprise-member-management"
  | "enterprise-token"
  | "shared-workspaces"
  | "client-db-devices"
  | "enterprise-audit";

export type PaymentOrderPanelPreset = {
  orderKind?: PaymentOrderKind;
};

export const useAdminStore = defineStore("admin", {
  state: () => ({
    activePanel: "settings" as AdminPanel,
    lastMenuPanel: "settings" as AdminPanel,
    paymentOrderPreset: null as PaymentOrderPanelPreset | null,
  }),

  actions: {
    /** 切换个人或企业设置面板，并记录功能访问。 */
    setPanel(panel: AdminPanel) {
      this.activePanel = panel;
      trackProductEvent("admin_panel_view", {
        admin_panel: panel,
      });
    },

    /** 记录最近一次可见系统菜单面板，供度量等非菜单面板返回时恢复。 */
    rememberMenuPanel(panel: AdminPanel) {
      this.lastMenuPanel = panel;
    },

    /** 设置支付订单页一次性筛选预设，用于跨面板跳转后自动查询。 */
    setPaymentOrderPreset(preset: PaymentOrderPanelPreset | null) {
      this.paymentOrderPreset = preset;
    },

    /** 消费支付订单页一次性筛选预设，避免后续进入页面重复套用。 */
    consumePaymentOrderPreset(): PaymentOrderPanelPreset | null {
      const preset = this.paymentOrderPreset;
      this.paymentOrderPreset = null;
      return preset;
    },
  },
});
