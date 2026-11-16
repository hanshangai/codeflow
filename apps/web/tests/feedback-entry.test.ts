import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";

import { resolveAllowedSystemPanels } from "../src/features/admin/systemPanelAccess.ts";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("feedback uses the user menu and a shared app-shell modal", () => {
  const menu = read("../src/features/account/components/user-menu-trigger.vue");
  const topbar = read("../src/components/app-shell/app-topbar.vue");
  const modals = read("../src/services/appModals.ts");
  const shell = read("../src/composables/useAppShell.ts");
  const app = read("../src/standard-app.vue");
  const composer = read("../src/features/composer/components/chat-composer.vue");
  const modal = read("../src/features/feedback/components/feedback-modal.vue");
  assert.match(menu, /意见反馈/u);
  assert.match(menu, /open-feedback/u);
  assert.match(topbar, /appModals\?\.openFeedback\(\)/u);
  assert.match(modals, /openFeedback: \(source\?: "user_menu" \| "slash_command"\) => void/u);
  assert.match(shell, /const feedbackOpen = ref\(false\)/u);
  assert.match(shell, /feedbackOpen,/u);
  assert.match(app, /FeedbackModal v-model:open="shell\.feedbackOpen"/u);
  assert.match(composer, /appModals\.openFeedback\("slash_command"\)/u);
  assert.match(modal, /showBackActions|最多上传 3 张截图/u);
  assert.match(modal, /未登录提交请填写联系方式/u);
});

test("tray feedback request is bridged to the renderer without losing pending requests", () => {
  const main = read("../../../apps/desktop/src/main.ts");
  const preload = read("../../../apps/desktop/src/preload.ts");
  const preloadEntry = read("../../../apps/desktop/src/preloadEntry.ts");
  const desktopService = read("../src/services/desktop.ts");
  assert.match(main, /意见反馈/u);
  assert.match(main, /requestRendererFeedback/u);
  assert.match(main, /desktop:feedback-requested/u);
  assert.match(main, /desktop:takeFeedbackRequest/u);
  assert.match(preload, /onFeedbackRequested/u);
  assert.match(preloadEntry, /onFeedbackRequested/u);
  assert.match(desktopService, /takeDesktopFeedbackRequest/u);
  assert.match(desktopService, /subscribeDesktopFeedbackRequested/u);
});

test("feedback management stays outside all public account settings", () => { for (const scope of ["super_admin", "enterprise_admin", "enterprise_member", "personal_user"] as const) assert.equal(resolveAllowedSystemPanels(scope).includes("feedback"), false); const layout = read("../src/features/admin/components/admin-layout.vue"); assert.doesNotMatch(layout, /admin-feedback-panel\.vue/u); });
