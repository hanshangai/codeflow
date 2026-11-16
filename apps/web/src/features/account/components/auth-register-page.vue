<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import type { CheckboxChangeEvent } from "ant-design-vue/es/checkbox/interface";
import { useRoute, useRouter } from "vue-router";
import type { AccountRegisterRequestBody } from "@codeflowai/shared";

import { trackProductEventWithEmail } from "../../../analytics/analytics";
import { useAccountStore } from "../../../store/account";
import { isAccountCaptchaEnabled } from "../captchaControl";
import { buildLoginRouteLocation } from "../loginRedirect";
import {
  normalizeEmailInput,
  normalizePhoneInput,
  validateConfirmPasswordInput,
  validateDisplayNameInput,
  validateEmailInput,
  validatePasswordInput,
  validatePhoneInput,
  validateVerificationCodeInput,
  normalizeInviteCodeInput,
  validateInviteCodeInput,
} from "../accountFormValidators";
import { useNowTicker } from "../useNowTicker";
import AuthShell from "./auth-shell.vue";
import CaptchaVerifyPopover from "./captcha-verify-popover.vue";
import UserAgreementModal from "./user-agreement-modal.vue";
import VerificationRow from "./verification-row.vue";

defineOptions({ name: "AuthRegisterPage" });

type CaptchaVerifyPopoverExpose = {
  resetChallenge: () => Promise<void>;
};

const COPY = {
  title: "用户注册",
  emailLabel: "邮箱",
  sendCodeIdle: "发送验证码",
  verificationCodeLabel: "邮箱验证码",
  phoneLabel: "手机号",
  fullNameLabel: "姓名",
  passwordLabel: "密码",
  confirmPasswordLabel: "确认密码",
  inviteCodeLabel: "邀请码（选填）",
  emailPlaceholder: "请输入邮箱账号",
  verificationCodePlaceholder: "请输入邮箱中的 6 位验证码",
  phonePlaceholder: "请输入手机号",
  fullNamePlaceholder: "请输入姓名",
  passwordPlaceholder: "至少 6 位",
  confirmPasswordPlaceholder: "请再次输入密码",
  inviteCodePlaceholder: "CF-XXXX-XXXX-XXXX",
  agreementPrefix: "我已阅读并同意",
  agreementLink: "《用户协议》",
  enterpriseAdminLabel: "注册为企业管理员",
  enterpriseNameLabel: "企业名称",
  enterpriseNamePlaceholder: "请输入企业名称",
  enterpriseNameRequired: "请输入企业名称",
  enterpriseNameTooLong: "企业名称不能超过 100 个字符",
  registerButton: "注册",
  loginLink: "已有账号，去登录",
  homeLink: "返回首页",
  agreementRequired: "请勾选后再继续注册",
  sendSuccess: "验证码已发送到该邮箱",
  registerSuccess: "注册完成，请使用邮箱和密码登录",
} as const;

const router = useRouter();
const route = useRoute();
const account = useAccountStore();
const captchaEnabled = isAccountCaptchaEnabled();
const now = useNowTicker();

const form = reactive({
  email: "",
  verificationCode: "",
  phone: "",
  fullName: "",
  password: "",
  confirmPassword: "",
  inviteCode: "",
});

const initialInviteCode = normalizeInviteCodeInput(
  Array.isArray(route.query.invite) ? route.query.invite[0] ?? "" : String(route.query.invite ?? ""),
);
form.inviteCode = initialInviteCode;

const fieldErrors = reactive({
  email: "",
  verificationCode: "",
  phone: "",
  fullName: "",
  password: "",
  confirmPassword: "",
  inviteCode: "",
});

const captchaPopoverRef = ref<CaptchaVerifyPopoverExpose | null>(null);
const captchaOpen = ref(false);
const agreementOpen = ref(false);
const agreementChecked = ref(false);
const agreementError = ref("");
const enterpriseAdminChecked = ref(false);
const enterpriseName = ref("");
const enterpriseNameError = ref("");
const sendingCode = ref(false);
const submitting = ref(false);
const errorMessage = ref("");
const errorLevel = ref<"info" | "error">("error");
const cooldownHintActive = ref(false);

const cooldownSeconds = computed(() => {
  return Math.max(0, Math.ceil((account.verificationCooldownUntil.register - now.value) / 1000));
});

const alertMessage = computed(() => {
  if (cooldownHintActive.value) {
    return cooldownSeconds.value > 0 ? `${cooldownSeconds.value} 秒后重试` : "";
  }
  return errorMessage.value;
});

/** alert 类型：邮箱冷却走 warning，验证类引导走 info，其余真错误走 error */
const alertType = computed<"info" | "warning" | "error">(() => {
  if (cooldownHintActive.value) return "warning";
  return errorLevel.value;
});

/** 控制滑块 popover 是否允许由「发送验证码」按钮 trigger 自动打开 */
const canTriggerCaptcha = computed(() => {
  if (!form.email.trim()) return false;
  if (validateEmailInput(form.email)) return false;
  if (cooldownSeconds.value > 0) return false;
  if (sendingCode.value) return false;
  return true;
});

/** 同步设置错误文案与级别，避免遗忘更新 errorLevel */
function setError(text: string, level: "info" | "error" = "error") {
  errorMessage.value = text;
  errorLevel.value = level;
}

function clearError() {
  errorMessage.value = "";
  errorLevel.value = "error";
}

const canSubmit = computed(() => {
  return Boolean(
    form.email.trim()
    && form.verificationCode.trim()
    && form.phone.trim()
    && form.fullName.trim()
    && form.password.trim()
    && form.confirmPassword.trim()
    && (!enterpriseAdminChecked.value || Boolean(enterpriseName.value.trim()))
    && agreementChecked.value,
  );
});

function resetFieldFeedback(field?: keyof typeof fieldErrors) {
  if (field) {
    fieldErrors[field] = "";
  } else {
    fieldErrors.email = "";
    fieldErrors.verificationCode = "";
    fieldErrors.phone = "";
    fieldErrors.fullName = "";
    fieldErrors.password = "";
    fieldErrors.confirmPassword = "";
    fieldErrors.inviteCode = "";
  }
  clearError();
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

function validatePhoneField(): string {
  const messageText = validatePhoneInput(form.phone);
  fieldErrors.phone = messageText;
  if (!messageText) {
    form.phone = normalizePhoneInput(form.phone);
  }
  return messageText;
}

/** 校验注册表单和内联企业名称，仅为企业管理员携带企业字段。 */
function validateRegisterForm(): AccountRegisterRequestBody | null {
  resetFieldFeedback();
  enterpriseNameError.value = "";
  fieldErrors.email = validateEmailInput(form.email);
  fieldErrors.verificationCode = validateVerificationCodeInput(form.verificationCode);
  fieldErrors.phone = validatePhoneField();
  fieldErrors.fullName = validateDisplayNameInput(form.fullName);
  fieldErrors.password = validatePasswordInput(form.password);
  fieldErrors.confirmPassword = validateConfirmPasswordInput(form.password, form.confirmPassword);
  fieldErrors.inviteCode = validateInviteCodeInput(form.inviteCode);

  const firstError = fieldErrors.email
    || fieldErrors.verificationCode
    || fieldErrors.phone
    || fieldErrors.fullName
    || fieldErrors.password
    || fieldErrors.confirmPassword
    || fieldErrors.inviteCode;
  if (firstError) {
    setError(firstError);
    return null;
  }

  form.email = normalizeEmailInput(form.email);
  form.verificationCode = form.verificationCode.trim();
  form.phone = normalizePhoneInput(form.phone);
  form.fullName = form.fullName.trim();
  if (enterpriseAdminChecked.value) {
    const name = enterpriseName.value.trim();
    if (!name) enterpriseNameError.value = COPY.enterpriseNameRequired;
    else if (name.length > 100) enterpriseNameError.value = COPY.enterpriseNameTooLong;
    if (enterpriseNameError.value) return null;
  }
  form.inviteCode = normalizeInviteCodeInput(form.inviteCode);

  return {
    email: form.email,
    verificationCode: form.verificationCode,
    phone: form.phone,
    fullName: form.fullName,
    password: form.password,
    confirmPassword: form.confirmPassword,
    agreementAccepted: agreementChecked.value,
    ...(enterpriseAdminChecked.value
      ? { registerAsEnterpriseAdmin: true, enterpriseName: enterpriseName.value.trim() }
      : {}),
    ...(form.inviteCode
      ? {
          inviteCode: form.inviteCode,
          inviteSource: form.inviteCode === initialInviteCode ? "link" as const : "manual" as const,
        }
      : {}),
  };
}

function validateAgreement(): boolean {
  if (agreementChecked.value) {
    agreementError.value = "";
    return true;
  }
  agreementError.value = COPY.agreementRequired;
  setError(agreementError.value);
  return false;
}

/** 由「发送验证码」按钮触发：先校验邮箱；验证码关闭时直接发码。 */
function openCaptchaPopover() {
  resetFieldFeedback("email");
  const emailError = validateEmailField();
  if (emailError) {
    setError(emailError);
    return;
  }
  if (!captchaEnabled) {
    void requestVerificationCode("");
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
  clearError();
  cooldownHintActive.value = false;
  try {
    const result = await account.sendVerificationCode({
      purpose: "register",
      email: normalizeEmailInput(form.email),
      captchaToken,
    });
    if (!result.ok) {
      trackProductEventWithEmail("auth_email_code_failed", form.email, {
        mode: "register",
        code: result.code,
      });
      if (result.code === "CAPTCHA_INVALID") {
        setError(result.message, "info");
        await captchaPopoverRef.value?.resetChallenge();
        return;
      }
      if (result.code === "EMAIL_SEND_COOLDOWN") {
        captchaOpen.value = false;
        cooldownHintActive.value = true;
        return;
      }
      if (result.code === "USER_ALREADY_EXISTS") {
        fieldErrors.email = result.message;
      }
      setError(result.message);
      captchaOpen.value = false;
      return;
    }
    form.email = normalizeEmailInput(form.email);
    captchaOpen.value = false;
    trackProductEventWithEmail("auth_email_code_sent", form.email, {
      mode: "register",
    });
    message.success(COPY.sendSuccess);
  } finally {
    sendingCode.value = false;
  }
}

function openAgreementModal() {
  agreementOpen.value = true;
}

function handleAgreementToggle(event: CheckboxChangeEvent) {
  agreementChecked.value = Boolean(event.target.checked);
  if (agreementChecked.value) {
    agreementError.value = "";
    if (errorMessage.value === COPY.agreementRequired) {
      clearError();
    }
  }
}

/** 关闭企业管理员注册时清除企业名称，避免提交隐藏字段。 */
function handleEnterpriseAdminToggle(event: CheckboxChangeEvent) {
  enterpriseAdminChecked.value = Boolean(event.target.checked);
  if (!enterpriseAdminChecked.value) {
    enterpriseName.value = "";
    enterpriseNameError.value = "";
  }
}

/** 提交个人或企业管理员注册请求，成功后跳转登录页。 */
async function submit() {
  if (submitting.value) return;
  const payload = validateRegisterForm();
  if (!payload) return;
  if (!validateAgreement()) return;

  submitting.value = true;
  clearError();
  try {
    const result = await account.register(payload);
    if (!result.ok) {
      trackProductEventWithEmail("auth_failed", payload.email, {
        mode: "register",
        code: result.code,
      });
      if (result.code === "USER_ALREADY_EXISTS") {
        fieldErrors.email = result.message;
      } else if (result.code === "AGREEMENT_REQUIRED") {
        agreementError.value = result.message;
      } else if (result.code === "INVITE_CODE_INVALID") {
        fieldErrors.inviteCode = result.message;
      } else if (result.code === "ENTERPRISE_NAME_ALREADY_EXISTS") {
        enterpriseNameError.value = result.message;
      }
      setError(result.message);
      return;
    }
    trackProductEventWithEmail("auth_success", payload.email, {
      mode: "register",
    });
    message.success(COPY.registerSuccess);
    await router.push(buildLoginRouteLocation(router.currentRoute.value.fullPath, { email: result.email }));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthShell :title="COPY.title">
    <div class="auth-register">
      <a-alert v-if="alertMessage" :type="alertType" show-icon :message="alertMessage" />

      <a-form
        id="auth-register-form"
        class="auth-register__form"
        layout="vertical"
        :colon="false"
        name="auth-register-form"
        autocomplete="off"
        @submit.prevent="submit"
      >
        <a-form-item
          :label="COPY.emailLabel"
          :validate-status="fieldErrors.email ? 'error' : undefined"
          :help="fieldErrors.email || undefined"
        >
          <div class="auth-register__email-row">
            <a-input
              id="register-email"
              v-model:value="form.email"
              name="register_email"
              :placeholder="COPY.emailPlaceholder"
              inputmode="email"
              autocomplete="section-register email"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              @update:value="resetFieldFeedback('email')"
              @blur="validateEmailField"
            />
            <CaptchaVerifyPopover
              ref="captchaPopoverRef"
              v-model:open="captchaOpen"
              placement="top"
              :disabled="!captchaEnabled || !canTriggerCaptcha"
              @confirm="handleCaptchaConfirm"
            >
              <VerificationRow
                :email="form.email"
                :cooldown-seconds="cooldownSeconds"
                :loading="sendingCode"
                :idle-label="COPY.sendCodeIdle"
                @send="openCaptchaPopover"
              />
            </CaptchaVerifyPopover>
          </div>
        </a-form-item>

        <a-form-item
          :label="COPY.verificationCodeLabel"
          :validate-status="fieldErrors.verificationCode ? 'error' : undefined"
          :help="fieldErrors.verificationCode || undefined"
        >
          <a-input
            id="register-verification-code"
            v-model:value="form.verificationCode"
            name="register_verification_code"
            :placeholder="COPY.verificationCodePlaceholder"
            inputmode="numeric"
            autocomplete="section-register one-time-code"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('verificationCode')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.phoneLabel"
          :validate-status="fieldErrors.phone ? 'error' : undefined"
          :help="fieldErrors.phone || undefined"
        >
          <a-input
            id="register-phone"
            v-model:value="form.phone"
            name="register_phone"
            :placeholder="COPY.phonePlaceholder"
            inputmode="tel"
            autocomplete="section-register tel"
            @blur="validatePhoneField"
            @update:value="resetFieldFeedback('phone')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.fullNameLabel"
          :validate-status="fieldErrors.fullName ? 'error' : undefined"
          :help="fieldErrors.fullName || undefined"
        >
          <a-input
            id="register-full-name"
            v-model:value="form.fullName"
            name="register_full_name"
            :placeholder="COPY.fullNamePlaceholder"
            autocomplete="section-register name"
            @update:value="resetFieldFeedback('fullName')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.passwordLabel"
          :validate-status="fieldErrors.password ? 'error' : undefined"
          :help="fieldErrors.password || undefined"
        >
          <a-input-password
            id="register-password"
            v-model:value="form.password"
            name="register_new_password"
            :placeholder="COPY.passwordPlaceholder"
            autocomplete="section-register new-password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('password')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.confirmPasswordLabel"
          :validate-status="fieldErrors.confirmPassword ? 'error' : undefined"
          :help="fieldErrors.confirmPassword || undefined"
        >
          <a-input-password
            id="register-confirm-password"
            v-model:value="form.confirmPassword"
            name="register_confirm_password"
            :placeholder="COPY.confirmPasswordPlaceholder"
            autocomplete="section-register new-password"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @update:value="resetFieldFeedback('confirmPassword')"
          />
        </a-form-item>

        <a-form-item
          :label="COPY.inviteCodeLabel"
          :validate-status="fieldErrors.inviteCode ? 'error' : undefined"
          :help="fieldErrors.inviteCode || undefined"
        >
          <a-input
            id="register-invite-code"
            v-model:value="form.inviteCode"
            name="register_invite_code"
            :placeholder="COPY.inviteCodePlaceholder"
            allow-clear
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            @blur="form.inviteCode = normalizeInviteCodeInput(form.inviteCode)"
            @update:value="resetFieldFeedback('inviteCode')"
          />
        </a-form-item>
      </a-form>

      <div class="auth-register__agreement">
        <a-checkbox :checked="agreementChecked" @change="handleAgreementToggle">
          <span class="auth-register__agreement-copy">{{ COPY.agreementPrefix }}</span>
          <button
            type="button"
            class="auth-register__agreement-link"
            @click.stop.prevent="openAgreementModal"
          >
            {{ COPY.agreementLink }}
          </button>
        </a-checkbox>
      </div>
      <div v-if="agreementError" class="auth-register__agreement-error">{{ agreementError }}</div>

      <div class="auth-register__enterprise">
        <a-checkbox :checked="enterpriseAdminChecked" :disabled="submitting" @change="handleEnterpriseAdminToggle">
          {{ COPY.enterpriseAdminLabel }}
        </a-checkbox>
        <a-form-item v-if="enterpriseAdminChecked" :label="COPY.enterpriseNameLabel"
          :validate-status="enterpriseNameError ? 'error' : undefined" :help="enterpriseNameError" required>
          <a-input v-model:value="enterpriseName" :maxlength="100" :disabled="submitting"
            :placeholder="COPY.enterpriseNamePlaceholder" autocomplete="organization" @press-enter="submit"
            @update:value="enterpriseNameError = ''" />
        </a-form-item>
      </div>

      <a-button
        class="auth-register__submit"
        type="primary"
        html-type="submit"
        form="auth-register-form"
        block
        :loading="submitting"
        :disabled="!canSubmit"
      >
        {{ COPY.registerButton }}
      </a-button>

      <div class="auth-register__footer">
        <a-button type="link" @click="router.push(buildLoginRouteLocation(router.currentRoute.value.fullPath))">{{ COPY.loginLink }}</a-button>
        <a-button type="link" @click="router.push('/')">{{ COPY.homeLink }}</a-button>
      </div>

    </div>

    <UserAgreementModal v-model:open="agreementOpen" />
  </AuthShell>
</template>

<style scoped>
.auth-register {
  --auth-control-width: min(100%, 360px);
  display: grid;
  gap: 14px;
}

.auth-register__form,
.auth-register__agreement,
.auth-register__agreement-error,
.auth-register__enterprise,
.auth-register__submit,
.auth-register__footer {
  width: var(--auth-control-width);
  margin-inline: auto;
}

.auth-register__form :deep(.ant-form-item) {
  margin-bottom: 14px;
}

.auth-register__form :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}

.auth-register__form :deep(.ant-form-item-label) {
  padding-bottom: 4px;
}

.auth-register__email-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 148px;
  gap: 12px;
  align-items: start;
}

.auth-register__agreement {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  color: var(--app-muted);
  font-size: 13px;
}

.auth-register__agreement-link {
  border: none;
  padding: 0;
  background: transparent;
  color: var(--app-accent);
  cursor: pointer;
}

.auth-register__agreement-copy {
  color: var(--app-muted);
}

.auth-register__agreement :deep(.ant-checkbox-wrapper) {
  color: var(--app-muted);
  font-size: 13px;
}

.auth-register__agreement-link:hover {
  text-decoration: underline;
}

.auth-register__agreement-link:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 46%, white);
  outline-offset: 2px;
  border-radius: 4px;
}

.auth-register__enterprise {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.auth-register__enterprise :deep(.ant-checkbox-wrapper) {
  color: var(--app-muted);
  font-size: inherit;
}

.auth-register__agreement-error {
  color: var(--app-danger, #d03050);
  font-size: 12px;
}

.auth-register__footer {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-height: 920px) and (min-width: 901px) {
  .auth-register {
    gap: 8px;
  }

  .auth-register__form :deep(.ant-form-item) {
    margin-bottom: 8px;
  }

  .auth-register__form :deep(.ant-form-item-label) {
    padding-bottom: 1px;
  }

  .auth-register__form :deep(.ant-form-item-label > label) {
    font-size: 12px;
    line-height: 1.25;
  }

  .auth-register__form :deep(.ant-input),
  .auth-register__form :deep(.ant-input-affix-wrapper),
  .auth-register__form :deep(.verification-row__button) {
    min-height: 30px;
    font-size: 13px;
  }

  .auth-register__form :deep(.ant-input) {
    padding-block: 4px;
  }

  .auth-register__form :deep(.ant-input-affix-wrapper) {
    padding-block: 3px;
  }

  .auth-register__form :deep(.ant-input-affix-wrapper input) {
    font-size: inherit;
  }

  .auth-register__form :deep(.ant-form-item-explain-error) {
    font-size: 11px;
    line-height: 1.3;
  }

  .auth-register__email-row {
    grid-template-columns: minmax(0, 1fr) 132px;
    gap: 8px;
  }

  .auth-register__agreement {
    font-size: 12px;
    line-height: 1.4;
  }

  .auth-register__agreement :deep(.ant-checkbox-wrapper) {
    font-size: 12px;
    line-height: 1.4;
  }

  .auth-register__agreement-error {
    font-size: 11px;
  }

  .auth-register__submit {
    min-height: 34px;
    font-size: 14px;
  }

  .auth-register__footer {
    gap: 6px;
  }

  .auth-register__footer :deep(.ant-btn-link) {
    height: auto;
    padding: 0;
    font-size: 12px;
  }

  .auth-register :deep(.ant-alert) {
    padding: 6px 10px;
  }

  .auth-register :deep(.ant-alert-message) {
    font-size: 12px;
    line-height: 1.35;
  }
}

@media (max-height: 760px) and (min-width: 901px) {
  .auth-register {
    --auth-control-width: min(100%, 332px);
    gap: 6px;
  }

  .auth-register__form :deep(.ant-form-item) {
    margin-bottom: 6px;
  }

  .auth-register__form :deep(.ant-form-item-label > label) {
    font-size: 11px;
  }

  .auth-register__form :deep(.ant-input),
  .auth-register__form :deep(.ant-input-affix-wrapper),
  .auth-register__form :deep(.verification-row__button) {
    min-height: 28px;
    font-size: 12px;
  }

  .auth-register__email-row {
    grid-template-columns: minmax(0, 1fr) 118px;
    gap: 6px;
  }

  .auth-register__agreement,
  .auth-register__agreement :deep(.ant-checkbox-wrapper) {
    font-size: 11px;
    line-height: 1.35;
  }

  .auth-register__submit {
    min-height: 32px;
    font-size: 13px;
  }
}
</style>

