<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { NumericCaptchaChallengeResponseBody } from "@codeflowai/shared";
import { ReloadOutlined } from "@ant-design/icons-vue";

import { useAccountStore } from "../../../store/account";
import { isAccountCaptchaEnabled } from "../captchaControl";

defineOptions({ name: "NumericCaptchaField" });

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const account = useAccountStore();
const enabled = isAccountCaptchaEnabled();
const challenge = ref<NumericCaptchaChallengeResponseBody | null>(null);
const digits = ref("");
const loading = ref(false);
const errorText = ref("");

const token = computed(() => (
  challenge.value && /^\d{4}$/u.test(digits.value)
    ? `numeric:${challenge.value.challengeId}:${digits.value}`
    : ""
));

watch(token, (value) => emit("update:modelValue", value), { immediate: true });

/** 只接受四位数字，输入完整后由父组件直接使用 token。 */
function handleInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value.replace(/\D/gu, "").slice(0, 4);
  digits.value = value;
}

/** 验证码图片跟随手动主题或系统暗色，由服务端生成对应对比度的图片。 */
function resolveCaptchaTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function loadChallenge(): Promise<void> {
  if (!enabled) return;
  loading.value = true;
  errorText.value = "";
  digits.value = "";
  try {
    const result = await account.fetchNumericCaptchaChallenge(resolveCaptchaTheme());
    if (!result.ok) {
      challenge.value = null;
      errorText.value = "验证码加载失败，请检查服务器连接";
      console.error("[NUMERIC_CAPTCHA_LOAD_FAILED]", { errorCode: "NUMERIC_CAPTCHA_LOAD_FAILED",
        code: result.code, message: result.message });
      return;
    }
    challenge.value = result;
  } catch (error) {
    challenge.value = null;
    errorText.value = "验证码加载失败，请检查服务器连接";
    console.error("[NUMERIC_CAPTCHA_LOAD_FAILED]", { errorCode: "NUMERIC_CAPTCHA_LOAD_FAILED",
      rootCause: error instanceof Error ? error.message : String(error) });
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  void loadChallenge();
}

onMounted(() => { void loadChallenge(); });

defineExpose({ refresh, reset: refresh });
</script>

<template>
  <div v-if="enabled" class="numeric-captcha" :class="{ 'numeric-captcha--disabled': disabled }">
    <input class="numeric-captcha__input" :value="digits" :disabled="disabled" inputmode="numeric" maxlength="4"
      autocomplete="off" aria-label="数字验证码" placeholder="输入图中 4 位数字" @input="handleInput" />
    <div class="numeric-captcha__visual">
      <img v-if="challenge" :src="challenge.image" :width="challenge.imageWidth" :height="challenge.imageHeight"
        alt="数字验证码" draggable="false" />
      <div v-else class="numeric-captcha__placeholder">
        <a-spin v-if="loading" size="small" />
        <span v-else>{{ errorText || "暂无验证码" }}</span>
      </div>
      <button type="button" class="numeric-captcha__refresh" :disabled="loading || disabled" title="换一张"
        aria-label="换一张验证码" @click="refresh">
        <ReloadOutlined :spin="loading" />
      </button>
    </div>
  </div>
  <p v-else class="numeric-captcha__hint">当前本地环境已关闭验证码</p>
</template>

<style scoped>
.numeric-captcha {
  display: flex;
  align-items: center;
  gap: 12px;
}

.numeric-captcha__visual {
  position: relative;
  width: 220px;
  height: 52px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border, rgba(148, 163, 184, 0.35));
  background: var(--app-bg-secondary, #f8fafc);
  flex: 0 0 auto;
}

.numeric-captcha__visual img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
}

.numeric-captcha__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #64748b;
}

.numeric-captcha__refresh {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text, #334155);
  background: var(--app-panel-bg, rgba(255, 255, 255, 0.82));
  cursor: pointer;
}

.numeric-captcha__refresh:hover { background: var(--app-panel-bg, #fff); }
.numeric-captcha__refresh:disabled { cursor: not-allowed; opacity: 0.6; }

.numeric-captcha__input {
  width: 100%;
  min-width: 0;
  height: 44px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, rgba(148, 163, 184, 0.45));
  background: var(--app-bg-secondary, rgba(255, 255, 255, 0.7));
  color: var(--app-text, #0f172a);
  font-size: 16px;
  letter-spacing: 6px;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.numeric-captcha__input::placeholder { color: var(--app-muted, #94a3b8); }

.numeric-captcha__input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
}

.numeric-captcha__hint {
  margin: 0;
  font-size: 12px;
  color: var(--app-muted, #64748b);
}

:global(:root[data-theme="dark"]) .numeric-captcha__visual {
  border-color: rgba(148, 163, 184, 0.22);
}

:global(:root[data-theme="dark"]) .numeric-captcha__input {
  background: rgba(15, 23, 42, 0.65);
  border-color: rgba(148, 163, 184, 0.3);
  color: #e2e8f0;
}

:global(:root[data-theme="dark"]) .numeric-captcha__refresh {
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
}

@media (max-width: 720px) {
  .numeric-captcha { flex-direction: column; align-items: stretch; }
  .numeric-captcha__visual { width: 100%; height: 56px; }
}
</style>
