import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/features/account/components/numeric-captcha-field.vue", import.meta.url), "utf8");

test("数字验证码按当前主题请求，不固定浅色", () => {
  assert.doesNotMatch(source, /fetchNumericCaptchaChallenge\("light"\)/u);
  assert.match(source, /fetchNumericCaptchaChallenge\(resolveCaptchaTheme\(\)\)/u);
});
