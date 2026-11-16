import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { needsLocalModelSetup, shouldShowLocalModelSetupGuide, type LocalModelSetupInput } from "../src/features/composer/localModelSetup.ts";

function status(overrides: Record<string, unknown> = {}) {
  return { engineType: "claude", installed: true, version: "1", binPath: "claude", features: {}, models: [],
    providerCredentialStatus: [], credentialStatus: { available: false, source: "none", message: null }, ...overrides } as never;
}

function input(overrides: Partial<LocalModelSetupInput> = {}): LocalModelSetupInput {
  return {
    isDesktop: true, localRuntimeReady: true, hasActiveSession: false, desktopCloudAccountLinked: false,
    keyStoreLoading: false, keyStoreError: null, engineStatusLoading: false,
    hasKeysByEngine: { claude: false, codex: false },
    activeProviderIdsByEngine: { claude: [], codex: [] },
    statuses: { claude: status(), codex: status({ engineType: "codex" }) },
    ...overrides,
  };
}

const guide = (overrides: Record<string, unknown> = {}) => shouldShowLocalModelSetupGuide({
  ...input(), isDesktopLocalWorkspace: true, publicView: false, settingsOpen: false,
  workspaceSwitching: false, authModalOpen: false, stateReady: true, ...overrides,
} as never);

test("app-level guide only shows for ready desktop-local state without suppressions", () => {
  assert.equal(guide(), true);
  for (const key of ["publicView", "settingsOpen", "workspaceSwitching", "authModalOpen"]) {
    assert.equal(guide({ [key]: true }), false, key);
  }
  assert.equal(guide({ stateReady: false }), false);
  assert.equal(guide({ isDesktopLocalWorkspace: false }), false);
  assert.equal(guide({ hasActiveSession: true }), false);
  assert.equal(guide({ statuses: {
    claude: status({ providerCredentialStatus: [{ providerId: "anthropic", available: true, sources: ["local_api_key"], message: null }] }),
    codex: status({ engineType: "codex" }),
  } }), false);
});

test("prompts only for a logged-out desktop with no usable model credentials", () => {
  assert.equal(needsLocalModelSetup(input()), true);
  assert.equal(needsLocalModelSetup(input({ isDesktop: false })), false);
  assert.equal(needsLocalModelSetup(input({ hasActiveSession: true })), false);
  assert.equal(needsLocalModelSetup(input({ desktopCloudAccountLinked: true })), false);
  assert.equal(needsLocalModelSetup(input({ keyStoreLoading: true })), false);
  assert.equal(needsLocalModelSetup(input({ keyStoreError: "offline" })), false);
  assert.equal(needsLocalModelSetup(input({ engineStatusLoading: true })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: { claude: status() } })), false);
});

test("does not prompt when one installed engine has a key, native login or no CLI", () => {
  assert.equal(needsLocalModelSetup(input({ activeProviderIdsByEngine: { claude: ["anthropic"], codex: [] } })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ credentialStatus: { available: true, source: "native", message: null } }),
    codex: status({ engineType: "codex" }),
  } })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ providerCredentialStatus: [{ providerId: "anthropic", available: true, sources: ["native"], message: null }] }),
    codex: status({ engineType: "codex" }),
  } })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ installed: false }), codex: status({ engineType: "codex", installed: false }),
  } })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ providerCredentialStatus: undefined, credentialStatus: undefined }),
    codex: status({ engineType: "codex" }),
  } })), false);
});

test("keeps engine-level errors for maintained keys and broken native login", () => {
  // 已维护但未启用：应由引擎级提示说明，不能误报为“未配置”。
  assert.equal(needsLocalModelSetup(input({ hasKeysByEngine: { claude: true, codex: false } })), false);
  // 曾登录过但凭据当前不可用：保留具体错误提示。
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ credentialStatus: { available: false, source: "local_oauth", message: "登录已失效" } }),
    codex: status({ engineType: "codex" }),
  } })), false);
  assert.equal(needsLocalModelSetup(input({ statuses: {
    claude: status({ providerCredentialStatus: [{ providerId: "anthropic", available: false, sources: ["local_oauth"], message: "登录已失效" }] }),
    codex: status({ engineType: "codex" }),
  } })), false);
});

test("ignores stale keys and credentials on uninstalled engines", () => {
  assert.equal(needsLocalModelSetup(input({
    hasKeysByEngine: { claude: false, codex: true },
    statuses: { claude: status(), codex: status({ engineType: "codex", installed: false }) },
  })), true);
  assert.equal(needsLocalModelSetup(input({
    statuses: {
      claude: status(),
      codex: status({
        engineType: "codex",
        installed: false,
        credentialStatus: { available: true, source: "local_oauth", message: null },
      }),
    },
  })), true);
});

test("app-level guide refreshes scoped state and shares its active flag", () => {
  const guide = fs.readFileSync(new URL("../src/features/settings/composables/useLocalModelSetupGuide.ts", import.meta.url), "utf8");
  assert.match(guide, /shouldShowLocalModelSetupGuide/u);
  assert.match(guide, /engines\.refresh\(/u);
  assert.match(guide, /engineKeys\.refresh\(/u);
  assert.match(guide, /shouldApply/u);
  assert.match(guide, /LOCAL_MODEL_SETUP_GUIDE_STATE_FAILED/u);
  assert.match(guide, /desktopAuthModalOpen/u);
  assert.match(guide, /localModelSetupGuideActive\.value/u);
  assert.match(guide, /options\.openSettings\(\)/u);
  assert.match(guide, /options\.openDesktopAuth\(\)/u);
  assert.doesNotMatch(guide, /inject\(APP_MODALS_KEY/u);
  assert.match(guide, /preparedScope === scope && stateReady\.value/u);
  assert.match(guide, /localModelSetupGuideWorkspaceId\.value/u);
  // 加载期间沿用已结算结论，避免引擎周期刷新时空态和引导弹框反复闪动。
  assert.match(guide, /const setupNeeded = ref\(false\)/u);
  assert.match(guide, /const settledGuideInput = computed/u);
  assert.match(guide, /setupNeeded\.value = shouldShowLocalModelSetupGuide\(input\)/u);
  assert.match(guide, /watch\(workspaceId, \(\) => \{\s*setupNeeded\.value = false;\s*\}\)/u);
  const state = fs.readFileSync(new URL("../src/features/settings/localModelSetupGuideState.ts", import.meta.url), "utf8");
  assert.match(state, /export const localModelSetupGuideActive = ref\(false\)/u);
  assert.match(state, /export const localModelSetupGuideWorkspaceId = ref<string \| null>\(null\)/u);
});

test("standard app mounts the desktop-only model setup guide", () => {
  const app = fs.readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8");
  assert.match(app, /useLocalModelSetupGuide/u);
  assert.match(app, /LocalModelSetupModal/u);
  assert.match(app, /v-if="shell\.config\.isDesktop"/u);
  assert.match(app, /openSettings: \(\) =>/u);
  assert.match(app, /shell\.settingsActiveTab = "engine-keys"/u);
  assert.match(app, /openDesktopAuth: \(\) => shell\.openDesktopAuthModal\(\)/u);
  const modal = fs.readFileSync(new URL("../src/features/settings/components/local-model-setup-modal.vue", import.meta.url), "utf8");
  for (const text of ["开始使用前，先接入一个模型", "配置自己的模型 Key", "登录账号", "不上传", "私有 Key 只保存在本机", "暂不配置，先浏览"]) {
    assert.match(modal, new RegExp(text, "u"), text);
  }
});

test("empty chat panel keeps a model key entry while the guide is active", () => {
  const panel = fs.readFileSync(new URL("../src/features/chat/components/chat-panel.vue", import.meta.url), "utf8");
  assert.match(panel, /localModelSetupGuideActive/u);
  assert.match(panel, /localModelSetupGuideWorkspaceId/u);
  assert.match(panel, /showModelSetupEntry/u);
  assert.match(panel, /未配置可用的模型 Key/u);
  assert.match(panel, /openSettings\("engine-keys"\)/u);
});

test("composer keeps inline guidance but no longer owns a one-shot modal", () => {
  const source = fs.readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  assert.match(source, /needsLocalModelSetup/u);
  assert.match(source, /未登录且未配置模型 Key，当前无法发送/u);
  assert.match(source, /openSettings\("engine-keys"\)/u);
  assert.match(source, /openDesktopAuth\(\)/u);
  assert.doesNotMatch(source, /modelSetupPromptOpen|localModelSetupPromptShown\.v1|scheduleModelSetupPrompt/u);
});
