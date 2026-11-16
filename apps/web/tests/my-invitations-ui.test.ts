import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accountDrawerSource = readFileSync(new URL("../src/features/account/components/account-drawer.vue", import.meta.url), "utf8");
const modalSource = readFileSync(new URL("../src/features/account/components/my-invitations-modal.vue", import.meta.url), "utf8");
const accountApiSource = readFileSync(new URL("../src/api/account/index.ts", import.meta.url), "utf8");

test("ordinary users can open a paginated self invitation list from the account drawer", () => {
  assert.match(accountDrawerSource, /summary\.accountRole !== 'super_admin'/u);
  assert.match(accountDrawerSource, />\s*邀请记录\s*</u);
  assert.match(modalSource, /title="我的邀请记录"/u);
  assert.match(modalSource, /注册姓名/u);
  assert.match(modalSource, /maskedEmail/u);
  assert.match(modalSource, /注册时间/u);
  assert.match(modalSource, /show-quick-jumper/u);
  assert.match(accountApiSource, /\/api\/account\/me\/invitations/u);
});

test("self invitation UI does not expose admin-only invitation fields", () => {
  for (const field of ["phone", "rewardStatus", "rewardGrantId", "inviteeUserId", "relationId"]) {
    assert.doesNotMatch(modalSource, new RegExp(field, "u"));
  }
});
