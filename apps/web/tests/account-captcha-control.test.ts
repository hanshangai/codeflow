import assert from "node:assert/strict";
import test from "node:test";

import { isAccountCaptchaEnabled } from "../src/features/account/captchaControl.ts";

test("account captcha control defaults to enabled when env is absent", () => {
  assert.equal(isAccountCaptchaEnabled({}), true);
});

test("account captcha control accepts explicit disable flags", () => {
  assert.equal(isAccountCaptchaEnabled({ VITE_AIDT_CAPTCHA_ENABLED: "0" }), false);
  assert.equal(isAccountCaptchaEnabled({ VITE_AIDT_CAPTCHA_ENABLED: "false" }), false);
  assert.equal(isAccountCaptchaEnabled({ VITE_CODEFLOWAI_CAPTCHA_ENABLED: "0" }), false);
});

test("account captcha control keeps captcha enabled for other values", () => {
  assert.equal(isAccountCaptchaEnabled({ VITE_AIDT_CAPTCHA_ENABLED: "1" }), true);
  assert.equal(isAccountCaptchaEnabled({ VITE_AIDT_CAPTCHA_ENABLED: "true" }), true);
});

