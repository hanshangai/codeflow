<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { CheckboxChangeEvent } from "ant-design-vue/es/checkbox/interface";
import {
  CloudServerOutlined, GiftOutlined, SafetyCertificateOutlined, ThunderboltOutlined,
} from "@ant-design/icons-vue";

import { useAccountStore } from "../../../store/account";
import { useConfigStore } from "../../../store/config";
import { isAccountCaptchaEnabled } from "../captchaControl";
import { isDesktopLoginPromptDismissed, setDesktopLoginPromptDismissed } from "../desktopLoginPrompt";
import NumericCaptchaField from "./numeric-captcha-field.vue";

defineOptions({ name: "DesktopAuthModal" });

type AuthMode = "login" | "register" | "forgot";
type CaptchaFieldExpose = { refresh: () => void };

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "success"): void;
}>();

const account = useAccountStore();
const config = useConfigStore();
const captchaEnabled = isAccountCaptchaEnabled();

const mode = ref<AuthMode>("login");
const errorText = ref("");
const submitting = ref(false);
const sendingCode = reactive<Record<"register" | "forgot_password", boolean>>({ register: false, forgot_password: false });
const cooldown = reactive<Record<"register" | "forgot_password", number>>({ register: 0, forgot_password: 0 });
const loginCaptcha = ref("");
const registerCaptcha = ref("");
const forgotCaptcha = ref("");
const loginCaptchaRef = ref<CaptchaFieldExpose | null>(null);
const registerCaptchaRef = ref<CaptchaFieldExpose | null>(null);
const forgotCaptchaRef = ref<CaptchaFieldExpose | null>(null);
const suppressLoginPrompt = ref(isDesktopLoginPromptDismissed());
const enterpriseAdminChecked = ref(false);
const enterpriseName = ref("");
const enterpriseNameError = ref("");

const login = reactive({ email: "", password: "" });
const register = reactive({
  email: "", code: "", phone: "", fullName: "", password: "", confirmPassword: "", inviteCode: "", agreement: false,
});
const forgot = reactive({ email: "", code: "", password: "", confirmPassword: "" });

const copy = computed(() => {
  if (mode.value === "register") return { title: "创建账号", subtitle: "注册后可登录同步个人配置会话" };
  if (mode.value === "forgot") return { title: "找回密码", subtitle: "通过邮箱验证码重置账号密码" };
  return { title: "欢迎回来", subtitle: "登录后可在本机与云端之间同步个人配置及使用移动版本操作本机" };
});

const cooldownTimer = window.setInterval(() => {
  for (const key of ["register", "forgot_password"] as const) {
    if (cooldown[key] > 0) cooldown[key] -= 1;
  }
}, 1000);
onUnmounted(() => window.clearInterval(cooldownTimer));

watch(() => props.open, (open) => {
  if (!open) {
    resetEnterpriseRegistration();
    return;
  }
  errorText.value = "";
  loginCaptchaRef.value?.refresh();
  registerCaptchaRef.value?.refresh();
  forgotCaptchaRef.value?.refresh();
});

/** 切换账号操作并清除上次错误提示。 */
function setMode(next: AuthMode): void {
  mode.value = next;
  errorText.value = "";
}

/** 关闭登录弹窗时清除敏感输入和本次企业注册选择。 */
function close(): void {
  setDesktopLoginPromptDismissed(suppressLoginPrompt.value);
  login.password = "";
  register.code = "";
  register.password = "";
  register.confirmPassword = "";
  registerCaptcha.value = "";
  forgot.code = "";
  forgot.password = "";
  forgot.confirmPassword = "";
  forgotCaptcha.value = "";
  loginCaptcha.value = "";
  resetEnterpriseRegistration();
  emit("update:open", false);
}

/** 结束注册或关闭主弹窗后清除企业身份，避免下次误提交。 */
function resetEnterpriseRegistration(): void {
  enterpriseAdminChecked.value = false;
  enterpriseName.value = "";
  enterpriseNameError.value = "";
}

/** 关闭企业注册时同步移除名称，普通注册不携带企业字段。 */
function handleEnterpriseAdminToggle(event: CheckboxChangeEvent): void {
  enterpriseAdminChecked.value = Boolean(event.target.checked);
  if (!enterpriseAdminChecked.value) resetEnterpriseRegistration();
}

function emailValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function fail(text: string): void {
  errorText.value = text;
}

async function submitLogin(): Promise<void> {
  if (submitting.value) return;
  errorText.value = "";
  const email = login.email.trim();
  if (!email || !login.password) return fail("请输入邮箱和密码");
  if (!emailValid(email)) return fail("请输入正确的邮箱地址");
  if (captchaEnabled && !loginCaptcha.value) return fail("请输入图中 4 位数字验证码");
  submitting.value = true;
  try {
    const result = await account.login({ email, password: login.password, captchaToken: loginCaptcha.value });
    if (!result.ok) {
      fail(result.message);
      // 服务端会在密码校验前消费数字码，任何失败都必须换一张。
      loginCaptchaRef.value?.refresh();
      return;
    }
    message.success("登录成功");
    emit("success");
    close();
  } catch (error) {
    fail(error instanceof Error ? error.message : "登录失败，请稍后重试");
    loginCaptchaRef.value?.refresh();
  } finally {
    submitting.value = false;
  }
}

async function sendCode(purpose: "register" | "forgot_password"): Promise<void> {
  if (sendingCode[purpose]) return;
  errorText.value = "";
  const form = purpose === "register" ? register : forgot;
  const email = form.email.trim();
  if (!email || !emailValid(email)) return fail("请先输入正确的邮箱地址");
  if (cooldown[purpose] > 0) return;
  const captchaToken = purpose === "register" ? registerCaptcha.value : forgotCaptcha.value;
  if (captchaEnabled && !captchaToken) return fail("请输入图中 4 位数字验证码");
  sendingCode[purpose] = true;
  try {
    const result = await account.sendVerificationCode({ purpose, email, captchaToken });
    if (!result.ok) {
      fail(result.message);
      if (purpose === "register") registerCaptchaRef.value?.refresh();
      else forgotCaptchaRef.value?.refresh();
      return;
    }
    cooldown[purpose] = Math.max(60, Number(result.cooldownSec ?? 0));
    message.success("验证码已发送");
    if (purpose === "register") registerCaptchaRef.value?.refresh();
    else forgotCaptchaRef.value?.refresh();
  } catch (error) {
    fail(error instanceof Error ? error.message : "验证码发送失败");
    if (purpose === "register") registerCaptchaRef.value?.refresh();
    else forgotCaptchaRef.value?.refresh();
  } finally {
    sendingCode[purpose] = false;
  }
}

/** 校验内联企业名称并提交注册，重名时保留输入供修改。 */
async function submitRegister(): Promise<void> {
  if (submitting.value) return;
  errorText.value = "";
  enterpriseNameError.value = "";
  const email = register.email.trim();
  if (!email || !emailValid(email)) return fail("请输入正确的邮箱地址");
  if (!register.code.trim()) return fail("请输入邮箱验证码");
  if (!register.phone.trim()) return fail("请输入手机号");
  if (!register.fullName.trim()) return fail("请输入姓名");
  if (register.password.length < 6) return fail("密码至少需要 6 位");
  if (register.password !== register.confirmPassword) return fail("两次输入的密码不一致");
  if (!register.agreement) return fail("请先阅读并同意用户协议与隐私政策");
  if (enterpriseAdminChecked.value) {
    const name = enterpriseName.value.trim();
    if (!name) enterpriseNameError.value = "请输入企业名称";
    else if (name.length > 100) enterpriseNameError.value = "企业名称不能超过 100 个字符";
    if (enterpriseNameError.value) return;
  }
  submitting.value = true;
  const requestId = `desktop-account-registration-${Date.now()}`;
  try {
    const result = await account.register({
      email,
      verificationCode: register.code.trim(),
      phone: register.phone.trim(),
      fullName: register.fullName.trim(),
      password: register.password,
      confirmPassword: register.confirmPassword,
      agreementAccepted: true,
      ...(enterpriseAdminChecked.value
        ? { registerAsEnterpriseAdmin: true, enterpriseName: enterpriseName.value.trim() }
        : {}),
      ...(register.inviteCode.trim() ? { inviteCode: register.inviteCode.trim() } : {}),
    });
    if (!result.ok) {
      console.error("[DESKTOP_ACCOUNT_REGISTRATION_FAILED]", {
        errorCode: result.code, requestId, enterpriseName: enterpriseName.value || null, rootCause: result.message,
      });
      if (result.code === "ENTERPRISE_NAME_ALREADY_EXISTS") {
        enterpriseNameError.value = result.message;
      }
      return fail(result.message);
    }
    resetEnterpriseRegistration();
    message.success("注册成功，请登录");
    login.email = result.email || email;
    login.password = "";
    setMode("login");
  } catch (error) {
    const rootCause = error instanceof Error ? error.message : "注册失败，请稍后重试";
    console.error("[DESKTOP_ACCOUNT_REGISTRATION_FAILED]", {
      errorCode: "DESKTOP_ACCOUNT_REGISTRATION_FAILED", requestId, enterpriseName: enterpriseName.value || null, rootCause,
    });
    fail(rootCause);
  } finally {
    submitting.value = false;
  }
}

async function submitForgot(): Promise<void> {
  errorText.value = "";
  const email = forgot.email.trim();
  if (!email || !emailValid(email)) return fail("请输入正确的邮箱地址");
  if (!forgot.code.trim()) return fail("请输入邮箱验证码");
  if (forgot.password.length < 6) return fail("新密码至少需要 6 位");
  if (forgot.password !== forgot.confirmPassword) return fail("两次输入的密码不一致");
  submitting.value = true;
  try {
    const result = await account.forgotPassword({
      email,
      verificationCode: forgot.code.trim(),
      newPassword: forgot.password,
      confirmPassword: forgot.confirmPassword,
    });
    if (!result.ok) return fail(result.message);
    message.success("密码已重置，请登录");
    login.email = email;
    login.password = "";
    setMode("login");
  } catch (error) {
    fail(error instanceof Error ? error.message : "重置失败，请稍后重试");
  } finally {
    submitting.value = false;
  }
}

function sendLabel(purpose: "register" | "forgot_password"): string {
  if (cooldown[purpose] > 0) return `${cooldown[purpose]}s 后重发`;
  if (sendingCode[purpose]) return "发送中...";
  return "获取验证码";
}
</script>

<template>
  <a-modal :open="open" :footer="null" :width="920" centered :mask-closable="false"
    wrap-class-name="desktop-auth-modal-host" @cancel="close">
    <div class="auth-card">
      <aside class="auth-brand">
        <div class="auth-brand__glow auth-brand__glow--one" />
        <div class="auth-brand__glow auth-brand__glow--two" />
        <div class="auth-brand__logo"><span>Code</span>Flow <i>.</i></div>
        <h1>让研发协作，<br />回到工作台。</h1>
        <p>桌面端本地优先，登录后在云端与本机之间无缝同步。</p>
        <ul class="auth-brand__features">
          <li><ThunderboltOutlined /> 多智能体协作与完整研发闭环</li>
          <li><CloudServerOutlined /> 工作区、会话与任务跨端同步</li>
          <li><SafetyCertificateOutlined /> 本机数据隔离与权限边界</li>
        </ul>
        <div class="auth-brand__foot">CodeFlow Desktop · 安全登录</div>
      </aside>

      <section class="auth-panel">
        <div class="auth-panel__head">
          <span class="auth-panel__eyebrow">DESKTOP EDITION</span>
          <h2>{{ copy.title }}</h2>
          <p>{{ copy.subtitle }}</p>
        </div>

        <nav class="auth-tabs" aria-label="账号操作">
          <button type="button" :class="{ 'auth-tabs__item--active': mode === 'login' }"
            @click="setMode('login')">登录</button>
          <button type="button" :class="{ 'auth-tabs__item--active': mode === 'register' }"
            @click="setMode('register')">注册</button>
          <button type="button" :class="{ 'auth-tabs__item--active': mode === 'forgot' }"
            @click="setMode('forgot')">找回密码</button>
        </nav>

        <div v-if="mode !== 'forgot'" class="auth-gift" role="note">
          <GiftOutlined />
          <span>新注册用户随机赠送 1-5 元流量</span>
        </div>

        <transition name="auth-fade" mode="out-in">
          <div :key="mode" class="auth-form">
            <a-alert v-if="errorText" type="error" show-icon :message="errorText" class="auth-form__error" />

            <template v-if="mode === 'login'">
              <label class="auth-field">
                <span>邮箱</span>
                <a-input v-model:value="login.email" size="large" placeholder="请输入邮箱账号"
                  autocomplete="username" @press-enter="submitLogin" />
              </label>
              <label class="auth-field">
                <span>密码</span>
                <a-input-password v-model:value="login.password" size="large" placeholder="请输入密码"
                  autocomplete="current-password" @press-enter="submitLogin" />
              </label>
              <div class="auth-field" @keydown.enter="submitLogin">
                <span>数字验证码</span>
                <NumericCaptchaField ref="loginCaptchaRef" v-model="loginCaptcha" />
              </div>
              <a-button type="primary" size="large" block :loading="submitting" class="auth-submit"
                @click="submitLogin">登录</a-button>
              <a-checkbox v-model:checked="suppressLoginPrompt" class="auth-reminder-option">
                不再提醒登录
              </a-checkbox>
              <div class="auth-links">
                <button type="button" @click="setMode('forgot')">忘记密码？</button>
                <button type="button" @click="setMode('register')">没有账号，去注册</button>
              </div>
            </template>

            <template v-else-if="mode === 'register'">
              <label class="auth-field">
                <span>邮箱</span>
                <div class="auth-code-row">
                  <a-input v-model:value="register.email" size="large" placeholder="请输入邮箱账号" autocomplete="email" />
                  <a-button :loading="sendingCode.register" :disabled="cooldown.register > 0"
                    @click="sendCode('register')">{{ sendLabel("register") }}</a-button>
                </div>
              </label>
              <div class="auth-field">
                <span>数字验证码</span>
                <NumericCaptchaField ref="registerCaptchaRef" v-model="registerCaptcha" />
              </div>
              <div class="auth-grid">
                <label class="auth-field">
                  <span>邮箱验证码</span>
                  <a-input v-model:value="register.code" size="large" placeholder="6 位验证码" maxlength="12" />
                </label>
                <label class="auth-field">
                  <span>手机号</span>
                  <a-input v-model:value="register.phone" size="large" placeholder="请输入手机号" />
                </label>
              </div>
              <label class="auth-field">
                <span>姓名</span>
                <a-input v-model:value="register.fullName" size="large" placeholder="请输入姓名" />
              </label>
              <div class="auth-grid">
                <label class="auth-field">
                  <span>密码</span>
                  <a-input-password v-model:value="register.password" size="large" placeholder="至少 6 位" />
                </label>
                <label class="auth-field">
                  <span>确认密码</span>
                  <a-input-password v-model:value="register.confirmPassword" size="large" placeholder="再次输入密码" />
                </label>
              </div>
              <div class="auth-field">
                <a-checkbox :checked="enterpriseAdminChecked" :disabled="submitting"
                  @change="handleEnterpriseAdminToggle">注册为企业管理员</a-checkbox>
              </div>
              <a-form-item v-if="enterpriseAdminChecked" label="企业名称" required
                :validate-status="enterpriseNameError ? 'error' : undefined" :help="enterpriseNameError">
                <a-input v-model:value="enterpriseName" :maxlength="100" :disabled="submitting" size="large"
                  placeholder="请输入企业名称" autocomplete="organization" @press-enter="submitRegister"
                  @update:value="enterpriseNameError = ''" />
              </a-form-item>
              <a-checkbox v-model:checked="register.agreement" class="auth-agreement">
                我已阅读并同意《用户协议》与《隐私政策》
              </a-checkbox>
              <a-button type="primary" size="large" block :loading="submitting" class="auth-submit"
                @click="submitRegister">创建账号</a-button>
              <div class="auth-links auth-links--center">
                <button type="button" @click="setMode('login')">已有账号，返回登录</button>
              </div>
            </template>

            <template v-else>
              <label class="auth-field">
                <span>邮箱</span>
                <div class="auth-code-row">
                  <a-input v-model:value="forgot.email" size="large" placeholder="请输入邮箱账号" autocomplete="email" />
                  <a-button :loading="sendingCode.forgot_password" :disabled="cooldown.forgot_password > 0"
                    @click="sendCode('forgot_password')">{{ sendLabel("forgot_password") }}</a-button>
                </div>
              </label>
              <div class="auth-field">
                <span>数字验证码</span>
                <NumericCaptchaField ref="forgotCaptchaRef" v-model="forgotCaptcha" />
              </div>
              <label class="auth-field">
                <span>邮箱验证码</span>
                <a-input v-model:value="forgot.code" size="large" placeholder="6 位验证码" maxlength="12" />
              </label>
              <div class="auth-grid">
                <label class="auth-field">
                  <span>新密码</span>
                  <a-input-password v-model:value="forgot.password" size="large" placeholder="至少 6 位" />
                </label>
                <label class="auth-field">
                  <span>确认新密码</span>
                  <a-input-password v-model:value="forgot.confirmPassword" size="large" placeholder="再次输入密码" />
                </label>
              </div>
              <a-button type="primary" size="large" block :loading="submitting" class="auth-submit"
                @click="submitForgot">重置密码</a-button>
              <div class="auth-links auth-links--center">
                <button type="button" @click="setMode('login')">返回登录</button>
              </div>
            </template>
          </div>
        </transition>

        <p class="auth-panel__foot">
          当前连接：{{ config.connected ? "云端已连接" : "本机模式" }} · 登录后可同步云端数据
        </p>
      </section>
    </div>
  </a-modal>
</template>

<style scoped>
.auth-card {
  display: flex;
  min-height: 560px;
  max-height: min(860px, calc(100vh - 24px));
  background: var(--auth-panel-bg, #ffffff);
  color: var(--auth-text, #0f172a);
}

.auth-brand {
  position: relative;
  width: 350px;
  flex: 0 0 350px;
  padding: 38px 32px;
  overflow: hidden;
  color: var(--auth-brand-text, #4a241b);
  background: var(--auth-brand-bg, linear-gradient(150deg, #faf1ec 0%, #f3dcd1 55%, #e9bda9 100%));
}

.auth-brand__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(8px);
  opacity: 0.55;
  pointer-events: none;
}

.auth-brand__glow--one {
  width: 220px;
  height: 220px;
  right: -80px;
  top: -70px;
  background: var(--auth-brand-glow-one, radial-gradient(circle, rgba(255, 214, 190, 0.65), transparent 68%));
}

.auth-brand__glow--two {
  width: 180px;
  height: 180px;
  left: -70px;
  bottom: 40px;
  background: var(--auth-brand-glow-two, radial-gradient(circle, rgba(233, 189, 169, 0.45), transparent 70%));
}

.auth-brand__logo {
  position: relative;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.4px;
}

.auth-brand__logo span { color: var(--auth-brand-logo, #b5522f); }
.auth-brand__logo i { color: var(--auth-brand-accent, #c96442); font-style: normal; }

.auth-brand h1 {
  position: relative;
  margin: 48px 0 14px;
  font-size: 28px;
  line-height: 1.35;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.auth-brand p {
  position: relative;
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--auth-brand-soft, rgba(74, 36, 27, 0.72));
}

.auth-brand__features {
  position: relative;
  margin: 34px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 16px;
}

.auth-brand__features li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--auth-brand-soft-strong, rgba(74, 36, 27, 0.85));
}

.auth-brand__features li :deep(.anticon) {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--auth-brand-icon-bg, rgba(201, 100, 66, 0.12));
  color: var(--auth-brand-icon, #b5522f);
}

.auth-brand__foot {
  position: absolute;
  left: 32px;
  bottom: 30px;
  font-size: 11px;
  letter-spacing: 1.2px;
  color: var(--auth-brand-foot, rgba(74, 36, 27, 0.55));
}

.auth-panel {
  flex: 1;
  min-width: 0;
  padding: 36px 42px 28px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.45) transparent;
}

.auth-panel__head h2 {
  margin: 6px 0 6px;
  font-size: 24px;
  font-weight: 700;
  color: var(--auth-text, #0f172a);
}

.auth-panel__head p {
  margin: 0;
  font-size: 13px;
  color: var(--auth-muted, #64748b);
}

.auth-panel__eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: #a9543a;
  font-weight: 600;
}

.auth-tabs {
  display: inline-flex;
  gap: 4px;
  margin: 22px 0 20px;
  padding: 4px;
  width: fit-content;
  border-radius: 12px;
  background: var(--auth-tab-bg, #f1f5f9);
}

.auth-tabs button {
  border: 0;
  background: transparent;
  padding: 8px 18px;
  border-radius: 9px;
  font-size: 13px;
  color: var(--auth-muted, #64748b);
  cursor: pointer;
  transition: all 0.18s ease;
}

.auth-tabs button:hover { color: var(--auth-text, #0f172a); }

.auth-tabs__item--active {
  background: var(--auth-panel-bg, #ffffff) !important;
  color: var(--auth-text, #0f172a) !important;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.1);
  font-weight: 600;
}

.auth-gift {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -4px 0 16px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(198, 93, 62, 0.1);
  color: #a9543a;
  font-size: 12px;
}

.auth-gift :deep(.anticon) { font-size: 14px; }

.auth-form { display: grid; gap: 14px; }

.auth-form__error { margin-bottom: 2px; }

.auth-field {
  display: grid;
  gap: 7px;
  font-size: 12px;
  color: var(--auth-muted, #475569);
}

/* 数字验证码输入框对齐弹窗内其它大号输入框，修正 placeholder 字号和字距差异。 */
.auth-field :deep(.numeric-captcha__input) {
  height: 40px;
  padding: 6px 11px;
  border: 1px solid #d9d9d9;
  border-radius: 12px;
  background: #fff;
  color: rgba(0, 0, 0, 0.88);
  font-size: 16px;
  letter-spacing: normal;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.auth-field :deep(.numeric-captcha__input::placeholder) {
  color: rgba(0, 0, 0, 0.25);
  font-size: 16px;
  letter-spacing: normal;
}

.auth-field :deep(.numeric-captcha__input:focus) {
  border-color: #c96442;
  box-shadow: 0 0 0 2px rgba(201, 100, 66, 0.1);
}

.auth-field :deep(.numeric-captcha__visual) {
  height: 40px;
}

.auth-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.auth-code-row {
  display: flex;
  gap: 10px;
}

.auth-code-row :deep(.ant-input) { flex: 1; }

.auth-agreement { font-size: 12px; color: var(--auth-muted, #64748b); }

.auth-submit { margin-top: 4px; height: 44px; border-radius: 10px; }

.auth-reminder-option {
  margin-top: 10px;
  color: var(--auth-muted, #64748b);
  font-size: 12px;
}

.auth-links {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 2px;
}

.auth-links--center { justify-content: center; }

.auth-links button {
  border: 0;
  background: transparent;
  padding: 0;
  color: #2563eb;
  font-size: 12px;
  cursor: pointer;
}

.auth-links button:hover { text-decoration: underline; }

.auth-panel__foot {
  margin: auto 0 0;
  padding-top: 18px;
  font-size: 11px;
  color: var(--auth-muted, #94a3b8);
  text-align: center;
}

.auth-fade-enter-active,
.auth-fade-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.auth-fade-enter-from { opacity: 0; transform: translateY(6px); }
.auth-fade-leave-to { opacity: 0; transform: translateY(-4px); }

:global(.desktop-auth-modal-host .ant-modal-content) {
  padding: 0;
  overflow: hidden;
  border-radius: 22px;
  background: transparent;
  box-shadow: 0 32px 80px rgba(15, 23, 42, 0.34);
}

:global(.desktop-auth-modal-host .ant-modal-body) { padding: 0; }

:global(:root[data-theme="dark"]) .auth-card {
  --auth-panel-bg: #241d1a;
  --auth-text: #f2e9e3;
  --auth-muted: #b8a79e;
  --auth-tab-bg: rgba(255, 255, 255, 0.08);
  --auth-brand-bg: linear-gradient(150deg, #241a16 0%, #352420 55%, #4d3229 100%);
  --auth-brand-text: #f2e6de;
  --auth-brand-soft: rgba(242, 230, 222, 0.78);
  --auth-brand-soft-strong: rgba(242, 230, 222, 0.88);
  --auth-brand-logo: #f0b196;
  --auth-brand-accent: #ffcf9e;
  --auth-brand-icon-bg: rgba(255, 190, 150, 0.14);
  --auth-brand-icon: #f3b495;
  --auth-brand-foot: rgba(242, 230, 222, 0.5);
  --auth-brand-glow-one: radial-gradient(circle, rgba(240, 160, 120, 0.35), transparent 68%);
  --auth-brand-glow-two: radial-gradient(circle, rgba(233, 189, 169, 0.25), transparent 70%);
}

/* 跟随系统暗色时 data-theme 为空，需要与手动暗色保持同一套暖色。 */
@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme])) .auth-card {
    --auth-panel-bg: #241d1a;
    --auth-text: #f2e9e3;
    --auth-muted: #b8a79e;
    --auth-tab-bg: rgba(255, 255, 255, 0.08);
    --auth-brand-bg: linear-gradient(150deg, #241a16 0%, #352420 55%, #4d3229 100%);
    --auth-brand-text: #f2e6de;
    --auth-brand-soft: rgba(242, 230, 222, 0.78);
    --auth-brand-soft-strong: rgba(242, 230, 222, 0.88);
    --auth-brand-logo: #f0b196;
    --auth-brand-accent: #ffcf9e;
    --auth-brand-icon-bg: rgba(255, 190, 150, 0.14);
    --auth-brand-icon: #f3b495;
    --auth-brand-foot: rgba(242, 230, 222, 0.5);
    --auth-brand-glow-one: radial-gradient(circle, rgba(240, 160, 120, 0.35), transparent 68%);
    --auth-brand-glow-two: radial-gradient(circle, rgba(233, 189, 169, 0.25), transparent 70%);
  }
}

:global(:root[data-theme="dark"]) .auth-tabs__item--active {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}

:global(:root[data-theme="dark"]) .auth-panel__eyebrow { color: #e8a184; }
:global(:root[data-theme="dark"]) .auth-gift { background: rgba(232, 161, 132, 0.14); color: #e8a184; }

@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme])) .auth-panel__eyebrow { color: #e8a184; }
  :global(:root:not([data-theme])) .auth-gift { background: rgba(232, 161, 132, 0.14); color: #e8a184; }
}

@media (max-width: 820px) {
  .auth-brand { display: none; }
  .auth-panel { padding: 28px 22px 22px; }
  .auth-card { min-height: 0; }
}

@media (max-width: 560px) {
  .auth-grid { grid-template-columns: 1fr; }
  .auth-code-row { flex-direction: column; }
}
</style>

<style>
/* 弹窗内容挂在 body 下，深色模式下单独校正 Ant 输入与勾选。 */
:root[data-theme="dark"] .desktop-auth-modal-host .ant-modal-content { background: #241d1a; }
:root[data-theme="dark"] .desktop-auth-modal-host .ant-input,
:root[data-theme="dark"] .desktop-auth-modal-host .ant-input-affix-wrapper {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  color: #f2e9e3;
}
:root[data-theme="dark"] .desktop-auth-modal-host .ant-input-affix-wrapper .ant-input {
  background: transparent;
  border: 0;
}
:root[data-theme="dark"] .desktop-auth-modal-host .ant-input::placeholder,
:root[data-theme="dark"] .desktop-auth-modal-host .ant-input-affix-wrapper input::placeholder {
  color: #8f7f76;
}
:root[data-theme="dark"] .desktop-auth-modal-host .auth-card .numeric-captcha__input {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  color: #f2e9e3;
}
:root[data-theme="dark"] .desktop-auth-modal-host .auth-card .numeric-captcha__input::placeholder {
  color: #8f7f76;
}
:root[data-theme="dark"] .desktop-auth-modal-host .ant-checkbox-wrapper { color: #b8a79e; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .desktop-auth-modal-host .ant-modal-content { background: #241d1a; }
  :root:not([data-theme]) .desktop-auth-modal-host .ant-input,
  :root:not([data-theme]) .desktop-auth-modal-host .ant-input-affix-wrapper {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.12);
    color: #f2e9e3;
  }
  :root:not([data-theme]) .desktop-auth-modal-host .ant-input-affix-wrapper .ant-input {
    background: transparent;
    border: 0;
  }
  :root:not([data-theme]) .desktop-auth-modal-host .ant-input::placeholder,
  :root:not([data-theme]) .desktop-auth-modal-host .ant-input-affix-wrapper input::placeholder {
    color: #8f7f76;
  }
  :root:not([data-theme]) .desktop-auth-modal-host .auth-card .numeric-captcha__input {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.12);
    color: #f2e9e3;
  }
  :root:not([data-theme]) .desktop-auth-modal-host .auth-card .numeric-captcha__input::placeholder {
    color: #8f7f76;
  }
  :root:not([data-theme]) .desktop-auth-modal-host .ant-checkbox-wrapper { color: #b8a79e; }
}
</style>
