<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import type { AccountH5BootstrapResponse, OfficeH5RecoveryAction, OfficePlatform } from "@codeflowai/shared";

import { bootstrapAccountH5, completeMyOfficeH5Binding } from "../../../api/office-h5";
import { resolveAccountH5DeepLink } from "../accountH5DeepLink";
import { consumeOfficeH5BootstrapHandoff } from "../officeH5Resume";
import { useAppShell } from "../../../composables/useAppShell";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useUiStore } from "../../../store/ui";

defineOptions({ name: "AccountH5Entry" });

const MobileLayout = defineAsyncComponent(() => import("../../../layouts/mobile/mobile-layout.vue"));

const emit = defineEmits<{
  (e: "logout"): void;
}>();

const copy = {
  brand: "CodeFlow H5",
  title: "移动工作台入口校验",
  checking: "正在校验账号、企业状态与 Token",
  workbenchLoading: "正在加载移动工作台",
  workbenchLoadingDescription: "账号校验通过，正在加载会话内容",
  blocked: "暂时无法进入移动工作台",
  retry: "重试",
  openMobile: "打开原移动端",
  account: "账号",
  package: "企业访问",
  token: "Token",
  requestId: "requestId",
  unavailable: "未知",
  contactAdmin: "联系管理员",
  openWeb: "打开 Web",
  retryAction: "重试校验",
  bindAccount: "绑定账号",
  backToOffice: "返回办公平台",
  refresh: "刷新",
} as const;

const { ctx } = useApiContext();
const route = useRoute();
const router = useRouter();
const shell = useAppShell();
const config = useConfigStore();
const ui = useUiStore();
const loading = ref(true);
const errorMessage = ref("");
const bootstrapState = ref<AccountH5BootstrapResponse | null>(null);
let bootstrapController: AbortController | null = null;

const ready = computed(() => bootstrapState.value?.status === "ready");
const accountLabel = computed(() => (
  bootstrapState.value?.userSummary?.fullName
  || bootstrapState.value?.userSummary?.email
  || copy.unavailable
));
const blockedMessage = computed(() => (
  bootstrapState.value?.message
  || errorMessage.value
  || copy.blocked
));

/** Maps server recovery actions to concise mobile labels. */
function recoveryLabel(action: OfficeH5RecoveryAction): string {
  if (action === "contact_admin") return copy.contactAdmin;
  if (action === "open_web") return copy.openWeb;
  if (action === "retry") return copy.retryAction;
  if (action === "bind_account") return copy.bindAccount;
  if (action === "back_to_office") return copy.backToOffice;
  if (action === "refresh") return copy.refresh;
  return action;
}

/** 应用通知深链中的工作区和目标 Tab，并清理上一次移动页面栈。 */
function applyAccountH5DeepLink(): void {
  const deepLink = resolveAccountH5DeepLink(route.query as Record<string, unknown>);
  ui.clearMobilePages();
  if (deepLink.workspaceId && deepLink.workspaceId !== config.workspaceId) {
    config.switchWorkspace(deepLink.workspaceId, { preservePrimaryThreadUrl: true });
  }
  if (String(route.query.openOfficeBindings ?? "") === "1") {
    ui.setActiveMobileTab("workspace");
    ui.pushMobilePage({ type: "settings", context: { tab: "office-bindings" } });
    return;
  }
  ui.setActiveMobileTab(deepLink.tab);
}

/** 退出 H5 前断开统一运行时连接，避免旧会话继续接收 presence。 */
function logoutFromH5(): void {
  shell.ws.disconnect();
  emit("logout");
}

/** 识别绑定回调平台，拒绝未知 query 值。 */
function bindingCallbackPlatform(): OfficePlatform | null {
  if (String(route.query.bindingCallback ?? "") !== "1") return null;
  const platform = String(route.query.bindingPlatform ?? "").trim();
  if (platform === "wecom" || platform === "dingtalk") return platform;
  throw new Error("办公平台绑定回调缺少有效平台标识，请重新发起绑定");
}

/** 重建发起绑定时的 redirectUri，移除办公平台追加的临时授权参数。 */
function bindingRedirectUri(): string {
  const url = new URL(window.location.href);
  for (const key of ["code", "authCode", "auth_code", "state"]) url.searchParams.delete(key);
  return url.toString();
}

/** 在现有 CodeFlow 会话下完成绑定回调，成功后清理授权参数并返回 H5 首页。 */
async function completePendingBinding(signal: AbortSignal): Promise<void> {
  const platform = bindingCallbackPlatform();
  if (!platform) return;
  const authCode = String(route.query.code ?? route.query.authCode ?? route.query.auth_code ?? "").trim();
  const state = String(route.query.state ?? "").trim();
  const corpId = String(route.query.corpId ?? "").trim();
  if (!authCode || !state || !corpId) throw new Error("办公平台绑定回调参数不完整，请重新发起绑定");
  const result = await completeMyOfficeH5Binding(ctx.value, {
    platform,
    authCode,
    corpId,
    state,
    redirectUri: bindingRedirectUri(),
    clientKind: "mobile",
  }, signal);
  if (!result.ok) throw new Error(result.message);
  message.success(`${platform === "wecom" ? "企业微信" : "钉钉"}绑定成功`);
  const query = { ...route.query };
  for (const key of ["bindingCallback", "bindingPlatform", "corpId", "code", "authCode", "auth_code", "state"]) delete query[key];
  await router.replace({ path: "/h5", query });
}

/** Validates the account H5 entry and exposes the full mobile workbench only when ready. */
async function bootstrap(): Promise<void> {
  bootstrapController?.abort();
  const controller = new AbortController();
  bootstrapController = controller;
  loading.value = true;
  errorMessage.value = "";
  bootstrapState.value = null;

  try {
    await completePendingBinding(controller.signal);
    const handedOff = consumeOfficeH5BootstrapHandoff(String(config.userSummary?.userId ?? "").trim());
    if (handedOff) {
      bootstrapState.value = handedOff;
      if (handedOff.status === "ready") applyAccountH5DeepLink();
      return;
    }
    const result = await bootstrapAccountH5(ctx.value, { clientKind: "mobile" }, controller.signal);
    if (!result.ok) {
      errorMessage.value = result.message;
      return;
    }
    bootstrapState.value = result;
    if (result.status === "ready") applyAccountH5DeepLink();
  } catch (error) {
    if (controller.signal.aborted) return;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (bootstrapController === controller) {
      bootstrapController = null;
      loading.value = false;
    }
  }
}

watch(
  () => route.fullPath,
  () => {
    if (ready.value) applyAccountH5DeepLink();
  },
);

onMounted(() => {
  void bootstrap();
});

onBeforeUnmount(() => {
  bootstrapController?.abort();
  bootstrapController = null;
});
</script>

<template>
  <Suspense v-if="ready">
    <MobileLayout entry-surface="h5" @logout="logoutFromH5" />
    <template #fallback>
      <main class="account-h5-entry" aria-busy="true">
        <section class="account-h5-entry__card">
          <div class="account-h5-entry__brand">{{ copy.brand }}</div>
          <div class="account-h5-entry__spinner" />
          <h1>{{ copy.workbenchLoading }}</h1>
          <p>{{ copy.workbenchLoadingDescription }}</p>
        </section>
      </main>
    </template>
  </Suspense>

  <main v-else class="account-h5-entry">
    <section class="account-h5-entry__card">
      <div class="account-h5-entry__brand">{{ copy.brand }}</div>

      <template v-if="loading">
        <div class="account-h5-entry__spinner" />
        <h1>{{ copy.title }}</h1>
        <p>{{ copy.checking }}</p>
      </template>

      <template v-else>
        <span class="account-h5-entry__status">{{ bootstrapState?.reasonCode || copy.blocked }}</span>
        <h1>{{ copy.blocked }}</h1>
        <p>{{ blockedMessage }}</p>

        <dl v-if="bootstrapState" class="account-h5-entry__facts">
          <div>
            <dt>{{ copy.account }}</dt>
            <dd>{{ accountLabel }}</dd>
          </div>
          <div>
            <dt>{{ copy.package }}</dt>
            <dd>{{ bootstrapState.entitlement?.accessStatus || copy.unavailable }}</dd>
          </div>
          <div>
            <dt>{{ copy.token }}</dt>
            <dd>{{ bootstrapState.entitlement?.tokenStatus || copy.unavailable }}</dd>
          </div>
        </dl>

        <div v-if="bootstrapState?.recoveryActions.length" class="account-h5-entry__recovery">
          <span v-for="action in bootstrapState.recoveryActions" :key="action">
            {{ recoveryLabel(action) }}
          </span>
        </div>

        <div class="account-h5-entry__actions">
          <button type="button" class="account-h5-entry__primary" @click="bootstrap">{{ copy.retry }}</button>
          <a href="/chat">{{ copy.openMobile }}</a>
        </div>

        <small v-if="bootstrapState?.requestId">
          {{ copy.requestId }}: {{ bootstrapState.requestId }}
        </small>
      </template>
    </section>
  </main>
</template>

<style scoped>
.account-h5-entry {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding:
    max(28px, env(safe-area-inset-top))
    20px
    max(28px, env(safe-area-inset-bottom));
  color: #18352e;
  background:
    radial-gradient(circle at 16% 12%, rgba(255, 249, 223, 0.96), transparent 34%),
    radial-gradient(circle at 88% 84%, rgba(92, 154, 130, 0.25), transparent 42%),
    linear-gradient(145deg, #eef3e4 0%, #dfeadd 48%, #cbded6 100%);
}

.account-h5-entry__card {
  width: min(100%, 460px);
  padding: 30px;
  border: 1px solid rgba(37, 84, 70, 0.16);
  border-radius: 28px;
  background: rgba(255, 253, 245, 0.9);
  box-shadow: 0 28px 70px rgba(39, 75, 63, 0.18);
  backdrop-filter: blur(18px);
}

.account-h5-entry__brand,
.account-h5-entry__status {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.account-h5-entry__brand {
  color: #f8f4e8;
  background: #1f5a4c;
}

.account-h5-entry__status {
  margin-top: 24px;
  color: #8b4a23;
  background: #f5dfbf;
}

.account-h5-entry h1 {
  margin: 22px 0 10px;
  font: 700 clamp(24px, 7vw, 34px) / 1.12 Georgia, "Times New Roman", serif;
}

.account-h5-entry p {
  margin: 0;
  color: #63726c;
  line-height: 1.7;
}

.account-h5-entry__spinner {
  width: 42px;
  height: 42px;
  margin-top: 26px;
  border: 4px solid rgba(31, 90, 76, 0.15);
  border-top-color: #1f5a4c;
  border-radius: 50%;
  animation: account-h5-spin 0.8s linear infinite;
}

.account-h5-entry__facts {
  display: grid;
  gap: 10px;
  margin: 24px 0 0;
}

.account-h5-entry__facts div {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(31, 90, 76, 0.07);
}

.account-h5-entry__facts dt {
  color: #6b7772;
}

.account-h5-entry__facts dd {
  margin: 0;
  font-weight: 700;
  text-align: right;
  overflow-wrap: anywhere;
}

.account-h5-entry__recovery {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.account-h5-entry__recovery span {
  padding: 6px 10px;
  border: 1px solid rgba(139, 74, 35, 0.18);
  border-radius: 999px;
  color: #7a482c;
  background: rgba(245, 223, 191, 0.55);
  font-size: 12px;
}

.account-h5-entry__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
}

.account-h5-entry__actions button,
.account-h5-entry__actions a {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 18px;
  border-radius: 14px;
  font-weight: 700;
  text-decoration: none;
}

.account-h5-entry__primary {
  border: 0;
  color: #fffdf5;
  background: #1f5a4c;
}

.account-h5-entry__actions a {
  color: #1f5a4c;
  border: 1px solid rgba(31, 90, 76, 0.2);
  background: rgba(255, 255, 255, 0.55);
}

.account-h5-entry small {
  display: block;
  margin-top: 18px;
  color: #7c8782;
  overflow-wrap: anywhere;
}

@keyframes account-h5-spin {
  to { transform: rotate(360deg); }
}
</style>
