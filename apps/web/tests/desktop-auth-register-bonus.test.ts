import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/** 登录/注册页展示新用户随机流量赠送提示。 */
test("desktop auth modal shows the new-user traffic bonus note", () => {
  const source = fs.readFileSync(new URL("../src/features/account/components/desktop-auth-modal.vue", import.meta.url), "utf8");
  assert.match(source, /新注册用户随机赠送 1-5 元流量/u);
  assert.match(source, /v-if="mode !== 'forgot'" class="auth-gift"/u);
  assert.match(source, /GiftOutlined/u);
});
