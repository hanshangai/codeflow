import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

test("client setup wizard feature and all entry points are removed", () => {
  assert.equal(existsSync(new URL("../src/features/setup-wizard", import.meta.url)), false);

  const modals = read("components/app-shell/app-shell-modals.vue");
  assert.doesNotMatch(modals, /SetupWizard|setup-wizard/u);

  const topbar = read("components/app-shell/app-topbar.vue");
  assert.doesNotMatch(topbar, /openSetupWizard|open-wizard|wizardOpen/u);

  const menu = read("features/account/components/user-menu-trigger.vue");
  assert.doesNotMatch(menu, /安装Client|open-wizard|wizard/u);

  const shell = read("composables/useAppShell.ts");
  assert.doesNotMatch(shell, /wizardOpen|setWizardOpen|onWizardComplete|openWizard/u);

  const banner = read("components/app-shell/ClientStartupBanner.vue");
  assert.doesNotMatch(banner, /open-wizard|Client安装向导/u);
  assert.match(banner, /import \{ resolveDesktopRuntimeStatusHint \} from "\.\/desktopLocalClientStatus"/u);
  assert.match(banner, /config\.isDesktop && !config\.localRuntimeReady\s*\? resolveDesktopRuntimeStatusHint\(\{ ready: false, status: config\.desktopRuntime\?\.status, error: config\.desktopError \}\)/u);
  assert.match(banner, /router\.push\("\/download"\)/u);
});
