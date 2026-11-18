import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/** 登录验证码输入框回车需要与邮箱、密码一致触发登录。 */
test("desktop auth modal submits login from the numeric captcha field on enter", () => {
  const source = fs.readFileSync(new URL("../src/features/account/components/desktop-auth-modal.vue", import.meta.url), "utf8");
  assert.match(source, /<a-input v-model:value="login\.email"[^>]*@press-enter="submitLogin"/u);
  assert.match(source, /<a-input-password v-model:value="login\.password"[^>]*@press-enter="submitLogin"/u);
  assert.match(source, /<div class="auth-field" @keydown\.enter="submitLogin">\s*<span>数字验证码<\/span>\s*<NumericCaptchaField ref="loginCaptchaRef" v-model="loginCaptcha" \/>/u);
});
