<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { useRoute, useRouter } from "vue-router";

import { useAccountStore } from "../../../store/account";
import { useConfigStore } from "../../../store/config";
import { createCancelledRequestError, isCancelledRequestError } from "../../../api/request";
import { useViewport } from "../../../composables/useViewport";
import { trackProductEventWithEmail } from "../../../analytics/analytics";
import { formatTimestamp } from "../accountDisplay";
import { isAccountCaptchaEnabled } from "../captchaControl";
import { resolvePostLoginTarget } from "../loginRedirect";
import AuthShell from "./auth-shell.vue";
import CaptchaVerifyModal from "./captcha-verify-modal.vue";

defineOptions({ name: "AuthLoginPage" });

type CaptchaVerifyModalExpose = {
  resetChallenge: () => Promise<void>;
};

const router = useRouter();
const route = useRoute();
const account = useAccountStore();
const config = useConfigStore();
const { mode } = useViewport();
const captchaEnabled = isAccountCaptchaEnabled();

const form = reactive({
  email: String(route.query.email ?? "").trim(),
  password: "",
});

const captchaModalRef = ref<CaptchaVerifyModalExpose | null>(null);
const captchaOpen = ref(false);
const captchaToken = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const errorLevel = ref<"info" | "error">("error");
const lockedUntil = ref(0);
const loginTitle = "用户登录";
const loginShellVariant = computed(() => mode.value === "mobile" ? "mobile-login" : "default");

const helperText = computed(() => {
  if (lockedUntil.value > 0) {
    return `账号已锁定，请在 ${formatTimestamp(lockedUntil.value)} 后再试，或直接通过邮箱找回密码。`;
  }
  return errorMessage.value;
});

/** alert 类型：账号锁定走 warning，验证类引导走 info，其余真错误走 error */
const alertType = computed<"info" | "warning" | "error">(() => {
  if (lockedUntil.value > 0) return "warning";
  return errorLevel.value;
});

const captchaHintText = computed(() => {
  if (!captchaEnabled) {
    return "当前环境已关闭数字验证码，仅用于本地测试。";
  }
  return submitting.value && captchaToken.value
    ? "数字验证码已填写，正在登录..."
    : "请输入图中 4 位数字验证码";
});

const captchaHintVerified = computed(() => !captchaEnabled || (submitting.value && Boolean(captchaToken.value)));

/** 同步设置错误文案与级别，避免遗忘更新 errorLevel */
function setError(text: string, level: "info" | "error" = "error") {
  errorMessage.value = text;
  errorLevel.value = level;
}

function clearError() {
  errorMessage.value = "";
  errorLevel.value = "error";
}

function handleCaptchaTokenUpdate(value: string) {
  captchaToken.value = String(value ?? "").trim();
}

function clearCaptchaVerification() {
  handleCaptchaTokenUpdate("");
}

/** 登录失败后刷新数字验证码，下一次登录必须重新输入。 */
async function resetCaptchaAfterLoginFailure(): Promise<void> {
  clearCaptchaVerification();
  await captchaModalRef.value?.resetChallenge();
}

/** 打开居中数字验证弹窗；登录中默认抑制，必要时可强制打开。 */
function openCaptchaModal(opts?: { force?: boolean }) {
  if (submitting.value && !opts?.force) return;
  captchaOpen.value = true;
}

/** Returns current native login inputs after browser autofill or manual edits. */
function readLoginInputs() {
  return {
    emailInput: document.getElementById("login-email") as HTMLInputElement | null,
    passwordInput: document.getElementById("login-password") as HTMLInputElement | null,
    formEl: document.getElementById("auth-login-form") as HTMLFormElement | null,
  };
}

/** Reads native input values because browser autofill may not trigger Vue v-model updates. */
function syncBrowserAutofillValues() {
  const { emailInput, passwordInput } = readLoginInputs();
  if (emailInput) form.email = emailInput.value.trim();
  if (passwordInput) form.password = passwordInput.value;
}

/** Prevents the browser password manager from rewriting fields during the login click/submit phase. */
function lockBrowserCredentialRewrite() {
  const { emailInput, passwordInput, formEl } = readLoginInputs();
  formEl?.setAttribute("autocomplete", "off");
  emailInput?.setAttribute("autocomplete", "off");
  passwordInput?.setAttribute("autocomplete", "new-password");
}

/** Captures the currently selected browser credential before click can trigger another autofill pass. */
function prepareLoginSubmit() {
  syncBrowserAutofillValues();
  lockBrowserCredentialRewrite();
}

/** Keeps the login email draft in sync for manually typed values. */
function handleEmailInput(event: Event) {
  form.email = (event.target as HTMLInputElement | null)?.value ?? "";
}

/** Keeps the login password draft in sync for manually typed values. */
function handlePasswordInput(event: Event) {
  form.password = (event.target as HTMLInputElement | null)?.value ?? "";
}

function handleCaptchaConfirm(value: string) {
  handleCaptchaTokenUpdate(value);
  captchaOpen.value = false;
  clearError();
  void submit();
}

/** 校验后沿原账号入口登录，成功收尾只接受当前会话，真实失败明确显示。 */
async function submit() {
  prepareLoginSubmit();
  if (submitting.value) return;
  if (!form.email.trim() || !form.password.trim()) {
    setError("请输入邮箱和密码", "info");
    return;
  }
  if (captchaEnabled && !captchaToken.value) {
    setError("请输入图中 4 位数字验证码", "info");
    openCaptchaModal();
    return;
  }

  submitting.value = true;
  const serverWsOrigin = config.serverWsOrigin;
  clearError();
  lockedUntil.value = 0;
  try {
    const result = await account.login({
      email: form.email,
      password: form.password,
      captchaToken: captchaToken.value,
    });
    if (!result.ok) {
      trackProductEventWithEmail("auth_failed", form.email, {
        mode: "login",
        code: result.code,
      });
      const details = (result.details ?? {}) as Record<string, unknown>;
      await resetCaptchaAfterLoginFailure();
      if (result.code === "ACCOUNT_LOCKED") {
        lockedUntil.value = Number(details.lockedUntil ?? 0);
      }
      if (result.code === "CAPTCHA_INVALID") {
        if (!captchaEnabled) {
          setError("前端已关闭验证码，但服务端仍要求验证码，请同时设置 AIDT_CAPTCHA_ENABLED=0。");
          return result;
        }
        setError("数字验证码已失效，请重新输入", "info");
        openCaptchaModal({ force: true });
        return result;
      }
      if (result.code === "UNAUTHORIZED" && typeof details.remainingAttempts === "number") {
        setError(`${result.message}，剩余 ${details.remainingAttempts} 次尝试`);
      } else {
        setError(result.message);
      }
      return result;
    }
    if (config.sessionToken !== result.sessionToken || config.userSummary?.userId !== result.userSummary.userId
      || config.serverWsOrigin !== serverWsOrigin) throw createCancelledRequestError("scope-change");
    trackProductEventWithEmail("auth_success", form.email, {
      mode: "login",
    });
    message.success("登录成功");
    await router.push(resolvePostLoginTarget(result.homePath || "/chat", route.query as Record<string, unknown>));
  } catch (error) {
    if (!isCancelledRequestError(error) || error.kind !== "scope-change") {
      setError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthShell :title="loginTitle" :variant="loginShellVariant">
    <div class="auth-login">
      <a-alert
        v-if="helperText"
        :type="alertType"
        show-icon
        :message="helperText"
      />
      <a-form
        id="auth-login-form"
        class="auth-login__form"
        layout="vertical"
        :colon="false"
        name="auth-login-form"
        autocomplete="on"
        @keydown.enter.prevent="submit"
        @submit.prevent="submit"
      >
        <a-form-item label="邮箱">
          <a-input
            id="login-email"
            v-model:value="form.email"
            name="login_email"
            placeholder="请输入邮箱账号"
            inputmode="email"
            autocomplete="username"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @input="handleEmailInput"
          />
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password
            id="login-password"
            v-model:value="form.password"
            name="login_password"
            placeholder="请输入密码"
            autocomplete="current-password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @input="handlePasswordInput"
          />
        </a-form-item>
      </a-form>

      <a-button
        class="auth-login__submit"
        type="primary"
        html-type="button"
        block
        :loading="submitting"
        @pointerdown="prepareLoginSubmit"
        @click="submit"
      >
        登录
      </a-button>

      <div class="auth-login__captcha-hint" :class="{ 'auth-login__captcha-hint--verified': captchaHintVerified }">
        {{ captchaHintText }}
      </div>

      <div class="auth-login__footer">
        <a-button type="link" @click="router.push('/auth/register')">没有账号，去注册</a-button>
        <a-button type="link" @click="router.push('/auth/forgot')">忘记密码</a-button>
        <a-button type="link" @click="router.push('/')">返回首页</a-button>
      </div>
    </div>

    <CaptchaVerifyModal
      v-if="captchaEnabled"
      ref="captchaModalRef"
      v-model:open="captchaOpen"
      auto-submit
      :loading="submitting"
      @confirm="handleCaptchaConfirm"
    />
  </AuthShell>
</template>

<style scoped>
.auth-login {
  --auth-control-width: min(100%, 360px);
  display: grid;
  gap: 14px;
}

.auth-login__form,
.auth-login__submit,
.auth-login__captcha-hint,
.auth-login__footer,
.auth-login__office,
.auth-login__divider {
  width: var(--auth-control-width);
  margin-inline: auto;
}

.auth-login__form :deep(.ant-form-item) {
  margin-bottom: 14px;
}

.auth-login__form :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}

.auth-login__form :deep(.ant-form-item-label) {
  padding-bottom: 4px;
}

.auth-login__form :deep(#login-password[type="password"]) {
  font-family: Arial, "Helvetica Neue", "Noto Sans", sans-serif;
}

.auth-login__office {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(31, 90, 76, 0.12);
  border-radius: 18px;
  background: rgba(238, 244, 231, 0.72);
}

.auth-login__office-heading {
  display: grid;
  gap: 2px;
}

.auth-login__office-heading strong {
  color: #18352e;
  font-size: 15px;
}

.auth-login__office-heading span,
.auth-login__office-note {
  color: #6c7973;
  font-size: 12px;
  line-height: 1.5;
}

.auth-login__office-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.auth-login__office-button {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 14px;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}

.auth-login__office-button:disabled {
  cursor: not-allowed;
  filter: grayscale(0.65);
  opacity: 0.55;
}

.auth-login__office-button--wecom { background: linear-gradient(145deg, #1aad19, #087a32); }
.auth-login__office-button--dingtalk { background: linear-gradient(145deg, #2684ff, #0756c9); }

.auth-login__office-mark {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.2);
}

.auth-login__divider {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--app-muted);
  font-size: 12px;
}

.auth-login__divider::before,
.auth-login__divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: var(--app-border);
}

.auth-login__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.auth-login__captcha-hint {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
}

.auth-login__captcha-hint--verified {
  color: #389e0d;
}

@media (max-width: 767px) {
  .auth-login {
    --auth-control-width: 100%;
    gap: 16px;
  }

  .auth-login__form :deep(.ant-input),
  .auth-login__form :deep(.ant-input-affix-wrapper),
  .auth-login__submit {
    min-height: 48px;
    border-radius: 14px;
  }

  .auth-login__form :deep(input) {
    pointer-events: auto;
    touch-action: manipulation;
    -webkit-user-select: text;
    user-select: text;
  }

  .auth-login__office-actions {
    grid-template-columns: 1fr;
  }

  .auth-login__footer {
    justify-content: center;
  }
}

@media (max-height: 920px) and (min-width: 901px) {
  .auth-login {
    gap: 10px;
  }

  .auth-login__form :deep(.ant-form-item) {
    margin-bottom: 10px;
  }

  .auth-login__form :deep(.ant-form-item-label) {
    padding-bottom: 2px;
  }

  .auth-login__form :deep(.ant-form-item-label > label) {
    font-size: 12px;
    line-height: 1.25;
  }

  .auth-login__form :deep(.ant-input),
  .auth-login__form :deep(.ant-input-affix-wrapper) {
    min-height: 30px;
    font-size: 13px;
  }

  .auth-login__form :deep(.ant-input) {
    padding-block: 4px;
  }

  .auth-login__form :deep(.ant-input-affix-wrapper) {
    padding-block: 3px;
  }

  .auth-login__form :deep(.ant-input-affix-wrapper input) {
    font-size: inherit;
  }

  .auth-login__submit {
    min-height: 34px;
    font-size: 14px;
  }

  .auth-login__captcha-hint {
    font-size: 11px;
  }

  .auth-login__footer {
    gap: 6px;
  }

  .auth-login__footer :deep(.ant-btn-link) {
    height: auto;
    padding: 0;
    font-size: 12px;
  }
}

@media (max-height: 760px) and (min-width: 901px) {
  .auth-login {
    --auth-control-width: min(100%, 332px);
    gap: 8px;
  }

  .auth-login__form :deep(.ant-form-item) {
    margin-bottom: 8px;
  }

  .auth-login__form :deep(.ant-input),
  .auth-login__form :deep(.ant-input-affix-wrapper) {
    min-height: 28px;
    font-size: 12px;
  }

  .auth-login__submit {
    min-height: 32px;
    font-size: 13px;
  }

  .auth-login__captcha-hint {
    font-size: 11px;
  }
}
</style>
