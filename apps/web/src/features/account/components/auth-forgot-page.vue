<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { useRoute, useRouter } from "vue-router";

import { trackProductEventWithEmail } from "../../../analytics/analytics";
import { useAccountStore } from "../../../store/account";
import { isAccountCaptchaEnabled } from "../captchaControl";
import { buildLoginRouteLocation } from "../loginRedirect";
import {
  normalizeEmailInput,
  validateConfirmPasswordInput,
  validateEmailInput,
  validatePasswordInput,
  validateVerificationCodeInput,
} from "../accountFormValidators";
import { useNowTicker } from "../useNowTicker";
import AuthShell from "./auth-shell.vue";
import CaptchaVerifyModal from "./captcha-verify-modal.vue";
import VerificationRow from "./verification-row.vue";

defineOptions({ name: "AuthForgotPage" });

type CaptchaVerifyModalExpose = {
  resetChallenge: () => Promise<void>;
};

type ForgotPayload = {
  email: string;
  verificationCode: string;
  newPassword: string;
  confirmPassword: string;
};

const COPY = {
  title: "找回密码",
  emailLabel: "注册邮箱",
  emailPlaceholder: "请输入邮箱账号",
  sendCodeIdle: "发送验证码",
  verificationCodeLabel: "邮箱验证码",
  verificationCodePlaceholder: "请输入邮箱中的 6 位验证码",
  newPasswordLabel: "新密码",
  newPasswordPlaceholder: "至少 6 位",
  confirmPasswordLabel: "确认新密码",
  confirmPasswordPlaceholder: "请再次输入新密码",
  sendSuccess: "验证码已发送到该邮箱",
  sendFailed: "验证码发送失败，请稍后重试",
  submitSuccess: "密码已重置，请重新登录",
  submitButton: "重置密码",
  loginLink: "返回登录",
  registerLink: "没有账号，去注册",
} as const;

const router = useRouter();
const route = useRoute();
const account = useAccountStore();
const captchaEnabled = isAccountCaptchaEnabled();
const now = useNowTicker();

const form = reactive({
  email: String(route.query.email ?? "").trim(),
  verificationCode: "",
  newPassword: "",
  confirmPassword: "",
});

const fieldErrors = reactive({
  email: "",
  verificationCode: "",
  newPassword: "",
  confirmPassword: "",
});

const captchaModalRef = ref<CaptchaVerifyModalExpose | null>(null);
const captchaOpen = ref(false);
const sendingCode = ref(false);
const submitting = ref(false);
const errorMessage = ref("");
const cooldownHintActive = ref(false);

const cooldownSeconds = computed(() => {
  return Math.max(0, Math.ceil((account.verificationCooldownUntil.forgot_password - now.value) / 1000));
});

const alertMessage = computed(() => {
  if (cooldownHintActive.value) {
    return cooldownSeconds.value > 0 ? `${cooldownSeconds.value} 秒后重试` : "";
  }
  return errorMessage.value;
});

const canSubmit = computed(() => {
  return Boolean(
    form.email.trim()
    && form.verificationCode.trim()
    && form.newPassword.trim()
    && form.confirmPassword.trim(),
  );
});

function resetFieldFeedback(field?: keyof typeof fieldErrors) {
  if (field) {
    fieldErrors[field] = "";
  } else {
    fieldErrors.email = "";
    fieldErrors.verificationCode = "";
    fieldErrors.newPassword = "";
    fieldErrors.confirmPassword = "";
  }
  errorMessage.value = "";
  cooldownHintActive.value = false;
}

function validateEmailField(): string {
  const messageText = validateEmailInput(form.email);
  fieldErrors.email = messageText;
  if (!messageText) {
    form.email = normalizeEmailInput(form.email);
  }
  return messageText;
}

function validateForgotForm(): ForgotPayload | null {
  resetFieldFeedback();
  fieldErrors.email = validateEmailInput(form.email);
  fieldErrors.verificationCode = validateVerificationCodeInput(form.verificationCode);
  fieldErrors.newPassword = validatePasswordInput(form.newPassword);
  fieldErrors.confirmPassword = validateConfirmPasswordInput(
    form.newPassword,
    form.confirmPassword,
    COPY.confirmPasswordPlaceholder,
  );

  const firstError = fieldErrors.email
    || fieldErrors.verificationCode
    || fieldErrors.newPassword
    || fieldErrors.confirmPassword;
  if (firstError) {
    errorMessage.value = firstError;
    return null;
  }

  form.email = normalizeEmailInput(form.email);
  form.verificationCode = form.verificationCode.trim();

  return {
    email: form.email,
    verificationCode: form.verificationCode,
    newPassword: form.newPassword,
    confirmPassword: form.confirmPassword,
  };
}

async function openCaptchaModal() {
  resetFieldFeedback("email");
  const emailError = validateEmailField();
  if (emailError) {
    errorMessage.value = emailError;
    return;
  }

  sendingCode.value = true;
  try {
    const result = await account.checkVerificationEmail({
      purpose: "forgot_password",
      email: normalizeEmailInput(form.email),
    });
    if (!result.ok) {
      if (result.code === "USER_NOT_REGISTERED" || result.code === "BAD_REQUEST") {
        fieldErrors.email = result.message;
      }
      errorMessage.value = result.message;
      return;
    }
  } finally {
    sendingCode.value = false;
  }

  if (!captchaEnabled) {
    await requestVerificationCode("");
    return;
  }
  captchaOpen.value = true;
}

async function handleCaptchaConfirm(captchaToken: string) {
  await requestVerificationCode(captchaToken);
}

async function requestVerificationCode(captchaToken: string) {
  if (sendingCode.value) return;
  sendingCode.value = true;
  errorMessage.value = "";
  cooldownHintActive.value = false;
  try {
    const result = await account.sendVerificationCode({
      purpose: "forgot_password",
      email: normalizeEmailInput(form.email),
      captchaToken,
    });
    if (!result.ok) {
      trackProductEventWithEmail("auth_email_code_failed", form.email, {
        mode: "forgot_password",
        code: result.code,
      });
      if (result.code === "CAPTCHA_INVALID") {
        errorMessage.value = result.message;
        await captchaModalRef.value?.resetChallenge();
        return;
      }
      if (result.code === "USER_NOT_REGISTERED") {
        fieldErrors.email = result.message;
        errorMessage.value = result.message;
        captchaOpen.value = false;
        return;
      }
      if (result.code === "EMAIL_SEND_COOLDOWN") {
        cooldownHintActive.value = true;
        captchaOpen.value = false;
        return;
      }
      errorMessage.value = result.message;
      captchaOpen.value = false;
      message.error(COPY.sendFailed);
      return;
    }
    if (!result.delivered) {
      trackProductEventWithEmail("auth_email_code_failed", form.email, {
        mode: "forgot_password",
        code: "NOT_DELIVERED",
      });
      errorMessage.value = COPY.sendFailed;
      captchaOpen.value = false;
      message.error(COPY.sendFailed);
      return;
    }
    form.email = normalizeEmailInput(form.email);
    captchaOpen.value = false;
    trackProductEventWithEmail("auth_email_code_sent", form.email, {
      mode: "forgot_password",
    });
    message.success(COPY.sendSuccess);
  } finally {
    sendingCode.value = false;
  }
}

async function submit() {
  const payload = validateForgotForm();
  if (!payload) return;

  submitting.value = true;
  errorMessage.value = "";
  try {
    const result = await account.forgotPassword(payload);
    if (!result.ok) {
      trackProductEventWithEmail("auth_password_reset_failed", payload.email, {
        code: result.code,
      });
      errorMessage.value = result.message;
      return;
    }
    trackProductEventWithEmail("auth_password_reset_success", payload.email);
    message.success(COPY.submitSuccess);
    await router.push(buildLoginRouteLocation(route.fullPath, { email: payload.email }));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthShell :title="COPY.title">
    <div class="auth-forgot">
      <a-alert v-if="alertMessage" type="error" show-icon :message="alertMessage" />

      <a-form
        id="auth-forgot-password-form"
        class="auth-forgot__form"
        layout="vertical"
        :colon="false"
        name="auth-forgot-password-form"
        autocomplete="off"
        @submit.prevent="submit"
      >
        <a-form-item
          :label="COPY.emailLabel"
          :validate-status="fieldErrors.email ? 'error' : undefined"
          :help="fieldErrors.email || undefined"
        >
          <div class="auth-forgot__email-row">
            <a-input
              id="forgot-email"
              v-model:value="form.email"
              name="forgot_email"
              :placeholder="COPY.emailPlaceholder"
              inputmode="email"
              autocomplete="section-reset email"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              @update:value="resetFieldFeedback('email')"
              @blur="validateEmailField"
            />
            <VerificationRow
              :email="form.email"
              :cooldown-seconds="cooldownSeconds"
              :loading="sendingCode"
              :idle-label="COPY.sendCodeIdle"
              @send="openCaptchaModal"
            />
          </div>
        </a-form-item>

        <a-form-item
          :label="COPY.verificationCodeLabel"
          :validate-status="fieldErrors.verificationCode ? 'error' : undefined"
          :help="fieldErrors.verificationCode || undefined"
        >
          <a-input
            id="forgot-verification-code"
            v-model:value="form.verificationCode"
            name="forgot_verification_code"
            :placeholder="COPY.verificationCodePlaceholder"
            inputmode="numeric"
            autocomplete="section-reset one-time-code"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('verificationCode')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.newPasswordLabel"
          :validate-status="fieldErrors.newPassword ? 'error' : undefined"
          :help="fieldErrors.newPassword || undefined"
        >
          <a-input-password
            id="forgot-new-password"
            v-model:value="form.newPassword"
            name="forgot_new_password"
            :placeholder="COPY.newPasswordPlaceholder"
            autocomplete="section-reset new-password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('newPassword')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.confirmPasswordLabel"
          :validate-status="fieldErrors.confirmPassword ? 'error' : undefined"
          :help="fieldErrors.confirmPassword || undefined"
        >
          <a-input-password
            id="forgot-confirm-password"
            v-model:value="form.confirmPassword"
            name="forgot_confirm_password"
            :placeholder="COPY.confirmPasswordPlaceholder"
            autocomplete="section-reset new-password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('confirmPassword')"
          />
        </a-form-item>
      </a-form>

      <a-button
        class="auth-forgot__submit"
        type="primary"
        html-type="submit"
        form="auth-forgot-password-form"
        size="large"
        block
        :loading="submitting"
        :disabled="!canSubmit"
      >
        {{ COPY.submitButton }}
      </a-button>

      <div class="auth-forgot__footer">
        <a-button type="link" @click="router.push(buildLoginRouteLocation(route.fullPath))">{{ COPY.loginLink }}</a-button>
        <a-button type="link" @click="router.push('/auth/register')">{{ COPY.registerLink }}</a-button>
      </div>
    </div>

    <CaptchaVerifyModal
      v-if="captchaEnabled"
      ref="captchaModalRef"
      v-model:open="captchaOpen"
      auto-submit
      :loading="sendingCode"
      @confirm="handleCaptchaConfirm"
    />
  </AuthShell>
</template>

<style scoped>
.auth-forgot {
  --auth-control-width: min(100%, 360px);
  display: grid;
  gap: 14px;
}

.auth-forgot__form,
.auth-forgot__submit,
.auth-forgot__footer {
  width: var(--auth-control-width);
  margin-inline: auto;
}

.auth-forgot__form :deep(.ant-form-item) {
  margin-bottom: 14px;
}

.auth-forgot__form :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}

.auth-forgot__form :deep(.ant-form-item-label) {
  padding-bottom: 4px;
}

.auth-forgot__email-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 148px;
  gap: 12px;
  align-items: start;
}

.auth-forgot__footer {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-height: 920px) and (min-width: 901px) {
  .auth-forgot {
    gap: 12px;
  }

  .auth-forgot__form :deep(.ant-form-item) {
    margin-bottom: 12px;
  }

  .auth-forgot__form :deep(.ant-form-item-label) {
    padding-bottom: 2px;
  }

  .auth-forgot__form :deep(.ant-form-item-label > label) {
    font-size: 12px;
    line-height: 1.25;
  }

  .auth-forgot__form :deep(.ant-input),
  .auth-forgot__form :deep(.ant-input-affix-wrapper),
  .auth-forgot__form :deep(.verification-row__button) {
    min-height: 30px;
    font-size: 13px;
  }

  .auth-forgot__form :deep(.ant-input) {
    padding-block: 4px;
  }

  .auth-forgot__form :deep(.ant-input-affix-wrapper) {
    padding-block: 3px;
  }

  .auth-forgot__form :deep(.ant-input-affix-wrapper input) {
    font-size: inherit;
  }

  .auth-forgot__email-row {
    grid-template-columns: minmax(0, 1fr) 132px;
    gap: 10px;
  }

  .auth-forgot__footer {
    gap: 8px;
  }
}

@media (max-height: 760px) and (min-width: 901px) {
  .auth-forgot {
    --auth-control-width: min(100%, 332px);
    gap: 10px;
  }

  .auth-forgot__form :deep(.ant-form-item) {
    margin-bottom: 10px;
  }

  .auth-forgot__form :deep(.ant-form-item-label > label) {
    font-size: 11px;
  }

  .auth-forgot__form :deep(.ant-input),
  .auth-forgot__form :deep(.ant-input-affix-wrapper),
  .auth-forgot__form :deep(.verification-row__button) {
    min-height: 28px;
    font-size: 12px;
  }

  .auth-forgot__email-row {
    grid-template-columns: minmax(0, 1fr) 124px;
    gap: 8px;
  }
}
</style>
