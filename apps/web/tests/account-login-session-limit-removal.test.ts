import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const LOGIN_PAGE = "apps/web/src/features/account/components/auth-login-page.vue";
const ACCOUNT_STORE = "apps/web/src/store/account.ts";
const ACCOUNT_API = "apps/web/src/api/account/index.ts";
const ACCOUNT_H5_ENTRY = "apps/web/src/features/office-h5/components/AccountH5Entry.vue";

/** noUnusedLocals 未开启时删除残留不会让 typecheck 变红，这里用源码扫描守住删除完备性。 */
test("login page no longer carries the web session replacement flow", () => {
  const source = readFileSync(LOGIN_PAGE, "utf8");
  for (const identifier of [
    "replaceLoginSession",
    "replacementChallenge",
    "replacementOpen",
    "replacingSession",
    "session_replaced",
    "WEB_SESSION_LIMIT_EXCEEDED",
    "confirmSessionReplacement",
    "AccountLoginReplacementChallengeDetails",
  ]) {
    assert.doesNotMatch(source, new RegExp(identifier, "u"), `登录页仍残留 ${identifier}`);
  }
});

/** 护栏：验证码失效分支必须仍在，证明清理未误删同一处理链中的保留项。 */
test("login page keeps the captcha invalidation branch", () => {
  const source = readFileSync(LOGIN_PAGE, "utf8");
  assert.match(source, /CAPTCHA_INVALID/u);
  assert.match(source, /remainingAttempts/u);
  assert.match(source, /formatTimestamp/u);
});

test("account store and api no longer expose the replacement login path", () => {
  assert.doesNotMatch(readFileSync(ACCOUNT_STORE, "utf8"), /replaceLoginSession/u);
  assert.doesNotMatch(readFileSync(ACCOUNT_API, "utf8"), /replaceLoginSession|replace-session/u);
});

test("office h5 entry no longer renders a session replacement recovery action", () => {
  assert.doesNotMatch(readFileSync(ACCOUNT_H5_ENTRY, "utf8"), /replace_session|replaceSession/u);
});
