import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("账号菜单改为退出应用，退出登录迁入个人信息抽屉", () => {
  const menu = read("../src/features/account/components/user-menu-trigger.vue");
  assert.match(menu, /退出应用/u);
  assert.match(menu, /检查更新/u);
  assert.match(menu, /showExitApp/u);
  assert.match(menu, /showCheckUpdate/u);
  assert.match(menu, /emit\("exit-app"\)/u);
  assert.match(menu, /emit\("check-update"\)/u);
  assert.doesNotMatch(menu, /退出登录|LogoutOutlined/u);

  const topbar = read("../src/components/app-shell/app-topbar.vue");
  assert.match(topbar, /:show-exit-app="shell\.config\.isDesktop"/u);
  assert.match(topbar, /:show-check-update="shell\.config\.isDesktop"/u);
  assert.match(topbar, /@exit-app="exitDesktopApp"/u);
  assert.match(topbar, /@check-update="openAppUpdate"/u);
  assert.match(topbar, /await bridge\.exit\(\)/u);

  const drawer = read("../src/features/account/components/account-drawer.vue");
  assert.match(drawer, /退出登录/u);
  assert.match(drawer, /emit\('logout'\)/u);
  assert.match(drawer, /account-drawer__account-actions/u);
  assert.doesNotMatch(drawer, /登录状态|注销后当前账号将无法登录|当前会话会立即失效/u);
  assert.match(drawer, /获取帮助/u);
  assert.match(drawer, /account-drawer__qr-grid/u);
  assert.match(drawer, /\/images\/contact\/wechat-group-qr\.png/u);
  assert.match(drawer, /\/images\/contact\/official-account-qr\.jpg/u);
  assert.match(drawer, /const showInviteSection = false/u);
  assert.match(drawer, /v-if="showInviteSection"/u);

  const modals = read("../src/components/app-shell/app-shell-modals.vue");
  assert.match(modals, /:logging-out="shell\.config\.logoutInProgress"/u);
  assert.match(modals, /@logout="handleDrawerLogout"/u);
  assert.match(modals, /await shell\.logout\(\)/u);
});
