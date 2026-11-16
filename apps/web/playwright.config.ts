import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 39291;
const MOCK_PORT = 39290;
const webBaseUrl = `http://127.0.0.1:${WEB_PORT}`;
const mockWsOrigin = `ws://127.0.0.1:${MOCK_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // 首页回归与移动端共用现有本地 mock 和 Web 服务。
  testMatch: /(?:homepage-efficiency|free-enterprise|analytics|basic|built-in-relay-auto-enable|chat-composer-actions|chat-thread-core|chat-workflow|default-thread-auto-create|enterprise-token-quota|file-preview|left-sidebar-resize|local-user-login|mcp-management|mobile-navigation|mobile-web|orchestration-workspace|project-knowledge|relay-recharge-pricing|settings-entry|shared-collaboration-lock|shared-workspace-rename|skill-marketplace|terminal-panel|workflow-builtin-first-order|workspace-directory-migration|workspace-thread-journey)\.spec\.ts/u,
  outputDir: "../../.tmp/playwright-output/local",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../.tmp/playwright-report/local/html", open: "never" }],
    ["json", { outputFile: "../../.tmp/playwright-report/local/results.json" }],
  ],
  use: {
    baseURL: webBaseUrl,
    trace: "on-first-retry",
    viewport: { width: 1366, height: 900 },
  },
  webServer: [
    {
      command: `pnpm exec tsx e2e/support/mock-codeflow-server.ts --port ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MOCK_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: webBaseUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_CODEFLOWAI_SERVER_WS_ORIGIN: mockWsOrigin,
        VITE_AIDT_CAPTCHA_ENABLED: "0",
        VITE_CODEFLOWAI_BAIDU_SITE_ID: "0123456789abcdef0123456789abcdef",
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-mobile-navigation",
      testMatch: /mobile-navigation\.spec\.ts/u,
      use: { ...devices["iPhone 13"] },
    },
  ],
});
