import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { OfficeH5BootstrapResponse } from "@codeflowai/shared";

import { resolveOfficeH5CorpId } from "../src/features/office-h5/officeH5EntryResolution.ts";
import { consumeOfficeH5BootstrapHandoff, stageOfficeH5BootstrapHandoff } from "../src/features/office-h5/officeH5Resume.ts";

test("office h5 entry corpId helper prefers route and only backfills the single available option", () => {
  assert.deepEqual(resolveOfficeH5CorpId({
    routeCorpId: "corp-route",
    platform: "wecom",
    loginOptions: [
      { platform: "wecom", available: true, corpId: "corp-wecom", message: null },
    ],
  }), { corpId: "corp-route", source: "route" });

  assert.deepEqual(resolveOfficeH5CorpId({
    routeCorpId: "",
    platform: "wecom",
    loginOptions: [
      { platform: "wecom", available: true, corpId: "corp-wecom", message: null },
      { platform: "wecom", available: false, corpId: null, message: "ignored" },
      { platform: "dingtalk", available: true, corpId: "corp-dingtalk", message: null },
    ],
  }), { corpId: "corp-wecom", source: "login-options" });

  assert.equal(resolveOfficeH5CorpId({
    routeCorpId: null,
    platform: "wecom",
    loginOptions: [
      { platform: "wecom", available: false, corpId: null, message: "未配置" },
      { platform: "wecom", available: true, corpId: "corp-a", message: null },
      { platform: "wecom", available: true, corpId: "corp-b", message: null },
    ],
  }), null);

  assert.equal(resolveOfficeH5CorpId({
    routeCorpId: null,
    platform: "dingtalk",
    loginOptions: [
      { platform: "wecom", available: true, corpId: "corp-wecom", message: null },
    ],
  }), null);
});

test("office h5 shell resolves missing corpId before starting oauth", () => {
  const source = fs.readFileSync("apps/web/src/features/office-h5/components/OfficeH5Shell.vue", "utf8");

  assert.match(source, /getOfficeH5LoginOptions/);
  assert.match(source, /resolveOfficeH5CorpId/);
  assert.match(source, /const entryCorpId = await resolveOfficeH5EntryCorpId\(\);/u);
  assert.match(source, /await startOfficeAuthorization\(entryCorpId\.corpId\);/u);
  assert.match(source, /corpId: entryCorpId\.corpId,/u);
});

test("office h5 shell resumes a verified entry and hands bootstrap to account H5", () => {
  const shellSource = fs.readFileSync("apps/web/src/features/office-h5/components/OfficeH5Shell.vue", "utf8");
  const accountEntrySource = fs.readFileSync("apps/web/src/features/office-h5/components/AccountH5Entry.vue", "utf8");

  assert.match(shellSource, /resumeOfficeH5\(apiContext\(\)/u);
  assert.match(shellSource, /config\.officeH5Resume\[platform\.value\]/u);
  assert.match(shellSource, /res\.code === "UNAUTHORIZED"[\s\S]+return null;/u);
  assert.match(shellSource, /stageOfficeH5BootstrapHandoff\(data\)/u);
  assert.match(shellSource, /router\.replace\(redirect \? resolvePostLoginTarget\("\/h5", \{ redirect \}\) : \{ path: "\/h5" \}\)/u);
  assert.match(accountEntrySource, /consumeOfficeH5BootstrapHandoff\(String\(config\.userSummary\?\.userId/u);
  assert.match(accountEntrySource, /const shell = useAppShell\(\);/u);
  assert.match(accountEntrySource, /if \(handedOff\)[\s\S]+return;/u);
});

test("office h5 pending recovery does not expose a new-session fallback", () => {
  const source = fs.readFileSync("apps/web/src/features/office-h5/components/OfficeH5Shell.vue", "utf8");

  assert.doesNotMatch(source, /recoveryChoiceRequired/u);
  assert.doesNotMatch(source, /retry-existing/u);
  assert.doesNotMatch(source, /action === "new-thread"/u);
});

test("office h5 bootstrap handoff is consumed once", () => {
  const bootstrap = {
    status: "ready",
    serverNow: Date.now(),
    platformContext: {
      platform: "wecom",
      corpId: "corp-a",
      enterpriseId: null,
      clientKind: "mobile",
      entryChannel: "office_h5",
      requestId: "request-a",
    },
    userSummary: {
      userId: "user-a",
      email: "user-a@example.test",
      fullName: "User A",
      phone: "",
      avatarUrl: null,
      accountRole: "personal_normal",
      status: "active",
      enterpriseId: null,
      enterpriseName: null,
    },
    recoveryActions: [],
  } satisfies OfficeH5BootstrapResponse;

  stageOfficeH5BootstrapHandoff(bootstrap);
  assert.equal(consumeOfficeH5BootstrapHandoff("user-a")?.requestId, "request-a");
  assert.equal(consumeOfficeH5BootstrapHandoff("user-a"), null);

  stageOfficeH5BootstrapHandoff(bootstrap);
  assert.equal(consumeOfficeH5BootstrapHandoff("user-b"), null);
});
