import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registerPageSource = readFileSync(
  new URL("../src/features/account/components/auth-register-page.vue", import.meta.url),
  "utf8",
);
const apiTypeSource = readFileSync(
  new URL("../../../packages/shared/src/types/api.ts", import.meta.url),
  "utf8",
);

test("注册页保留手机号格式校验但不再处理手机号占用错误", () => {
  assert.match(registerPageSource, /validatePhoneInput\(form\.phone\)/u);
  assert.doesNotMatch(registerPageSource, /PHONE_ALREADY_EXISTS/u);
  assert.doesNotMatch(apiTypeSource, /PHONE_ALREADY_EXISTS/u);
});
