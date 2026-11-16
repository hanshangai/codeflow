<script setup lang="ts">
import { computed, defineAsyncComponent, getCurrentInstance } from "vue";
import { useRoute, useRouter } from "vue-router";

import OfficeH5Shell from "./OfficeH5Shell.vue";
import { useAccountStore } from "../../../store/account";

defineOptions({ name: "H5App" });

const app = getCurrentInstance()?.appContext.app;
let antdInstallPromise: Promise<void> | undefined;

/** 为账号 H5 页面按需注册组件库，办公入口校验页不承担这段下载。 */
function ensureH5AntdInstalled(): Promise<void> {
  if (!app) throw new Error("H5 应用实例不可用，无法加载账号工作台");
  antdInstallPromise ??= import("ant-design-vue").then(({ default: Antd }) => {
    app.use(Antd);
  });
  return antdInstallPromise;
}

/** 登录后按需加载账号 H5 工作台。 */
async function loadAccountH5Entry() {
  const [, module] = await Promise.all([ensureH5AntdInstalled(), import("./AccountH5Entry.vue")]);
  return module.default;
}

/** 在轻量 H5 壳内按需加载登录页，避免切换完整 Web 工作台。 */
async function loadH5LoginPage() {
  const [, module] = await Promise.all([
    ensureH5AntdInstalled(),
    import("../../account/components/auth-login-page.vue"),
  ]);
  return module.default;
}

const AccountH5Entry = defineAsyncComponent(loadAccountH5Entry);
const AuthLoginPage = defineAsyncComponent(loadH5LoginPage);

const emit = defineEmits<{
  (event: "logout"): void;
}>();

const route = useRoute();
const router = useRouter();
const account = useAccountStore();
// 与入口壳共用路由解析结果，不受地址尾斜杠影响，也不改写授权参数。
const isH5LoginRoute = computed(() => route.name === "h5-login");
const isAccountH5Route = computed(() => route.meta.mainView === "h5");
const isOfficeH5Route = computed(() => route.meta.mainView === "office-h5");

/** 清理账号会话并回到账户 H5 登录入口，不加载标准 Web 壳。 */
async function logout(): Promise<void> {
  await account.logout();
  emit("logout");
  if (route.name !== "h5-login") await router.push({ name: "h5-login" });
}
</script>

<template>
  <div class="app-shell">
    <Suspense v-if="isH5LoginRoute">
      <AuthLoginPage />
      <template #fallback>
        <main class="account-h5-route-loading" aria-busy="true">
          <span class="app-route-loading-spinner" aria-label="加载中" />
        </main>
      </template>
    </Suspense>
    <Suspense v-else-if="isAccountH5Route">
      <AccountH5Entry @logout="logout" />
      <template #fallback>
        <main class="account-h5-route-loading" aria-busy="true">
          <span class="app-route-loading-spinner" aria-label="加载中" />
        </main>
      </template>
    </Suspense>
    <OfficeH5Shell v-else-if="isOfficeH5Route" @logout="logout" />
  </div>
</template>
