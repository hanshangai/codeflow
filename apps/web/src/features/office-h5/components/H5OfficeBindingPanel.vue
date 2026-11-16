<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { OfficeH5BindingView, OfficePlatform } from "@codeflowai/shared";
import { useRoute, useRouter } from "vue-router";

import { getMyOfficeH5Bindings, revokeMyOfficeH5Binding, startMyOfficeH5Binding } from "../../../api/office-h5";
import { useApiContext } from "../../../composables/useApiContext";

defineOptions({ name: "H5OfficeBindingPanel" });

const emit = defineEmits<{
  (event: "logout"): void;
}>();

const { ctx } = useApiContext();
const route = useRoute();
const router = useRouter();
const bindings = ref<OfficeH5BindingView[]>([]);
const loading = ref(false);
const bindingsLoaded = ref(false);
const busyPlatform = ref<OfficePlatform | null>(null);
const errorMessage = ref("");

/** 将路由中的平台参数收敛为支持的办公平台。 */
function normalizeRoutePlatform(value: unknown): OfficePlatform | null {
  const normalized = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
  return normalized === "wecom" || normalized === "dingtalk" ? normalized : null;
}

const switchPlatform = computed<OfficePlatform | null>(() => (
  String(route.query.switchAccount ?? "") === "1" ? normalizeRoutePlatform(route.query.switchPlatform) : null
));
const bindPlatform = computed<OfficePlatform | null>(() => normalizeRoutePlatform(route.query.bindPlatform));
const bindCorpId = computed(() => String(route.query.bindCorpId ?? "").trim());
const orderedBindings = computed(() => (["wecom", "dingtalk"] as OfficePlatform[]).map((platform) => {
  const binding = bindings.value.find((item) => item.platform === platform) ?? {
    platform,
    corpId: null,
    bound: false,
    lastSeenAt: null,
    message: "绑定状态尚未加载",
  };
  const targetCorpId = platform === bindPlatform.value ? bindCorpId.value : "";
  if (!targetCorpId || binding.bound) return binding;
  return { ...binding, corpId: targetCorpId, message: "当前办公入口待绑定" };
}));
const switchBinding = computed(() => orderedBindings.value.find((item) => item.platform === switchPlatform.value) ?? null);

/** 返回办公平台的用户可见名称。 */
function platformLabel(platform: OfficePlatform): string {
  return platform === "wecom" ? "企业微信" : "钉钉";
}

/** 格式化最近使用时间；尚未使用时保持明确空态。 */
function formatLastSeen(value: number | null): string {
  if (!value) return "尚未通过该平台登录";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 加载当前用户绑定状态，失败时保留显式错误。 */
async function loadBindings(): Promise<void> {
  loading.value = true;
  bindingsLoaded.value = false;
  errorMessage.value = "";
  try {
    const result = await getMyOfficeH5Bindings(ctx.value);
    if (!result.ok) {
      errorMessage.value = result.message;
      return;
    }
    bindings.value = result.bindings;
    bindingsLoaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

/** 构造绑定回调地址，仅保留绑定协议所需参数。 */
function buildBindingRedirectUri(binding: OfficeH5BindingView): string {
  if (!binding.corpId) throw new Error(`${platformLabel(binding.platform)}登录应用尚未配置`);
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/h5";
  url.search = "";
  url.hash = "";
  url.searchParams.set("bindingCallback", "1");
  url.searchParams.set("bindingPlatform", binding.platform);
  url.searchParams.set("corpId", binding.corpId);
  return url.toString();
}

/** 发起绑定专用 OAuth；Server 会把 state 绑定到当前 CodeFlow 用户。 */
async function startBinding(binding: OfficeH5BindingView): Promise<void> {
  if (binding.bound || busyPlatform.value) return;
  const corpId = String(binding.corpId ?? "").trim();
  if (!corpId) {
    errorMessage.value = `${platformLabel(binding.platform)}登录应用尚未配置`;
    return;
  }
  busyPlatform.value = binding.platform;
  errorMessage.value = "";
  try {
    const redirectUri = buildBindingRedirectUri(binding);
    const result = await startMyOfficeH5Binding(ctx.value, {
      platform: binding.platform,
      corpId,
      redirectUri,
      clientKind: "mobile",
    });
    if (!result.ok) {
      errorMessage.value = result.message;
      return;
    }
    window.location.assign(result.authorizeUrl);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyPlatform.value = null;
  }
}

/** 解除当前用户的平台绑定；退出登录不会自动调用该操作。 */
async function revokeBinding(platform: OfficePlatform): Promise<void> {
  if (busyPlatform.value) return;
  busyPlatform.value = platform;
  errorMessage.value = "";
  try {
    const result = await revokeMyOfficeH5Binding(ctx.value, { platform });
    if (!result.ok) {
      errorMessage.value = result.message;
      return;
    }
    await loadBindings();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyPlatform.value = null;
  }
}

/** 解绑完成后切换到目标账号登录，并在登录后重新打开绑定页。 */
async function continueAccountSwitch(): Promise<void> {
  const platform = switchPlatform.value;
  if (!platform || switchBinding.value?.bound) return;
  errorMessage.value = "";
  try {
    const query: Record<string, string> = { openOfficeBindings: "1", bindPlatform: platform };
    if (bindCorpId.value) query.bindCorpId = bindCorpId.value;
    await router.replace({
      path: "/h5",
      query,
    });
    emit("logout");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(() => {
  void loadBindings();
});
</script>

<template>
  <section class="h5-binding-panel">
    <header class="h5-binding-panel__header">
      <span class="h5-binding-panel__eyebrow">免密登录</span>
      <h2>办公平台账号绑定</h2>
      <p>首次绑定同时校验当前 CodeFlow 会话和办公平台 OAuth 身份。绑定后，从企业微信或钉钉通知进入 H5 可自动登录。</p>
    </header>

    <section v-if="switchPlatform && bindingsLoaded" class="h5-binding-panel__switch">
      <span>切换 CodeFlow 账号</span>
      <template v-if="switchBinding?.bound">
        <strong>第一步：解除当前{{ platformLabel(switchPlatform) }}绑定</strong>
        <p>解除后，本页面会显示“退出并登录新账号”。系统不会自动转移绑定。</p>
      </template>
      <template v-else>
        <strong>原{{ platformLabel(switchPlatform) }}绑定已解除</strong>
        <p>继续退出当前 CodeFlow 会话，登录目标账号后再绑定{{ platformLabel(switchPlatform) }}。</p>
        <a-button type="primary" block @click="continueAccountSwitch">退出并登录新账号</a-button>
      </template>
    </section>

    <section v-else-if="bindPlatform" class="h5-binding-panel__switch h5-binding-panel__switch--ready">
      <span>绑定新账号</span>
      <strong>当前 CodeFlow 账号登录成功</strong>
      <p>请在下方点击“绑定{{ platformLabel(bindPlatform) }}”，完成新的免密登录关系。</p>
    </section>

    <a-alert v-if="errorMessage" type="error" show-icon :message="errorMessage" />
    <a-spin :spinning="loading">
      <div class="h5-binding-panel__list">
        <article v-for="binding in orderedBindings" :key="binding.platform" class="h5-binding-card">
          <div class="h5-binding-card__identity">
            <span class="h5-binding-card__mark" :class="`h5-binding-card__mark--${binding.platform}`">
              {{ binding.platform === "wecom" ? "企" : "钉" }}
            </span>
            <div>
              <strong>{{ platformLabel(binding.platform) }}</strong>
              <span>{{ binding.bound ? "已绑定，可免密登录" : binding.message || "尚未绑定" }}</span>
            </div>
          </div>

          <dl class="h5-binding-card__meta">
            <div>
              <dt>绑定状态</dt>
              <dd :class="{ 'h5-binding-card__ok': binding.bound }">{{ binding.bound ? "已绑定" : "未绑定" }}</dd>
            </div>
            <div>
              <dt>最近使用</dt>
              <dd>{{ formatLastSeen(binding.lastSeenAt) }}</dd>
            </div>
          </dl>

          <a-popconfirm
            v-if="binding.bound"
            title="解除后将不能再使用该平台免密登录，确认解除吗？"
            ok-text="解除绑定"
            cancel-text="取消"
            @confirm="revokeBinding(binding.platform)"
          >
            <a-button danger block :loading="busyPlatform === binding.platform">解除绑定</a-button>
          </a-popconfirm>
          <a-button
            v-else
            type="primary"
            block
            :disabled="!binding.corpId"
            :loading="busyPlatform === binding.platform"
            @click="startBinding(binding)"
          >
            绑定{{ platformLabel(binding.platform) }}
          </a-button>
        </article>
      </div>
    </a-spin>

    <p class="h5-binding-panel__notice">退出登录只撤销当前 CodeFlow 会话，不会解除上述绑定。</p>
  </section>
</template>

<style scoped>
.h5-binding-panel {
  display: grid;
  gap: 18px;
  padding-bottom: max(24px, env(safe-area-inset-bottom));
  color: #18352e;
}

.h5-binding-panel__header {
  display: grid;
  gap: 8px;
  padding: 20px;
  border-radius: 22px;
  background:
    radial-gradient(circle at 90% 0%, rgba(241, 183, 90, 0.2), transparent 38%),
    linear-gradient(145deg, #f7f2df, #e6efe7);
  border: 1px solid rgba(31, 90, 76, 0.12);
}

.h5-binding-panel__eyebrow {
  width: fit-content;
  padding: 5px 9px;
  border-radius: 999px;
  color: #fffdf5;
  background: #1f5a4c;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.h5-binding-panel h2,
.h5-binding-panel p {
  margin: 0;
}

.h5-binding-panel h2 {
  font: 700 25px/1.2 Georgia, "Times New Roman", serif;
}

.h5-binding-panel__switch {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid rgba(196, 122, 36, 0.24);
  border-radius: 18px;
  background: rgba(255, 244, 218, 0.78);
}

.h5-binding-panel__switch--ready {
  border-color: rgba(31, 90, 76, 0.2);
  background: rgba(226, 241, 232, 0.82);
}

.h5-binding-panel__switch span {
  color: #9a5b17;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.h5-binding-panel__switch p {
  color: #65746e;
  line-height: 1.6;
}

.h5-binding-panel__header p,
.h5-binding-panel__notice {
  color: #65746e;
  line-height: 1.65;
}

.h5-binding-panel__list {
  display: grid;
  gap: 14px;
}

.h5-binding-card {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid rgba(31, 90, 76, 0.12);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 16px 38px rgba(39, 75, 63, 0.08);
}

.h5-binding-card__identity {
  display: flex;
  align-items: center;
  gap: 12px;
}

.h5-binding-card__identity div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.h5-binding-card__identity strong {
  font-size: 17px;
}

.h5-binding-card__identity span:last-child {
  color: #6b7772;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.h5-binding-card__mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 14px;
  color: white;
  font-size: 18px;
  font-weight: 800;
}

.h5-binding-card__mark--wecom { background: linear-gradient(145deg, #1aad19, #087a32); }
.h5-binding-card__mark--dingtalk { background: linear-gradient(145deg, #2684ff, #0756c9); }

.h5-binding-card__meta {
  display: grid;
  gap: 8px;
  margin: 0;
}

.h5-binding-card__meta div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.h5-binding-card__meta dt {
  color: #77837e;
}

.h5-binding-card__meta dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

.h5-binding-card__ok {
  color: #168447;
  font-weight: 700;
}

.h5-binding-panel__notice {
  padding: 0 4px;
  font-size: 12px;
}
</style>
