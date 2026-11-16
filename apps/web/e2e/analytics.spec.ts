import { expect, test, type Page } from "@playwright/test";

type BaiduCommand = [command: string, ...args: unknown[]];

/** 读取页面中等待百度脚本消费的命令队列。 */
async function readBaiduQueue(page: Page): Promise<BaiduCommand[]> {
  return page.evaluate(() => {
    return ((window as typeof window & { _hmt?: BaiduCommand[] })._hmt ?? []).map((command) => [...command]);
  });
}

test("百度统计覆盖首次访问、SPA 路由和语义点击且不再请求旧脚本", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await page.route("https://hm.baidu.com/hm.js?*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.__codeflowBaiduTrackerLoaded = true;",
    });
  });

  await page.goto("/");
  await expect.poll(async () => (await readBaiduQueue(page)).some((command) => (
    command[0] === "_trackPageview" && command[1] === "/"
  ))).toBe(true);

  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.analyticsEvent = "e2e_semantic_click";
    document.body.appendChild(button);
    button.click();

    const dynamicLabelButton = document.createElement("button");
    dynamicLabelButton.setAttribute("aria-label", "普通用户名称与工作区名称");
    document.body.appendChild(dynamicLabelButton);
    dynamicLabelButton.click();
  });
  await expect.poll(async () => (await readBaiduQueue(page)).some((command) => (
    command[0] === "_trackEvent"
      && command[1] === "codeflow"
      && command[2] === "ui_click"
      && command[3] === "e2e_semantic_click"
  ))).toBe(true);
  expect((await readBaiduQueue(page)).some((command) => (
    command[0] === "_trackEvent" && command[2] === "ui_click" && command[3] === "普通用户名称与工作区名称"
  ))).toBe(false);

  expect(requestedUrls.some((url) => url === "https://hm.baidu.com/hm.js?0123456789abcdef0123456789abcdef")).toBe(true);
  expect(requestedUrls.some((url) => /(?:umami|stat\/script\.js)/u.test(url))).toBe(false);
});

test("新增业务埋点使用稳定事件名和安全标签", async ({ page }) => {
  await page.route("https://hm.baidu.com/hm.js?*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.__codeflowBaiduTrackerLoaded = true;",
    });
  });
  await page.goto("/");
  const events = [
    "built_in_relay_auto_enable", "default_thread_auto_create", "client_download",
    "client_connection_change", "client_upgrade_start", "client_upgrade_success", "client_upgrade_failed",
    "client_upgrade_reconnect_timeout", "thread_create", "thread_open", "thread_rename", "thread_archive",
    "thread_pin", "thread_clear", "thread_delete", "thread_preferences_save", "thread_draft_save_failed",
    "turn_interrupt", "chat_send_failed", "plan_checkout_cancel", "plan_checkout_failed", "token_recharge_cancel",
    "token_recharge_failed", "token_recharge_qr_expired", "settings_save_success", "settings_save_failed",
    "asset_save", "asset_delete", "asset_install", "asset_uninstall", "skill_install", "skill_uninstall",
    "mcp_install", "mcp_uninstall", "mcp_config_save", "knowledge_workflow_start", "knowledge_schedule_save",
    "knowledge_candidate_create", "knowledge_candidate_review", "knowledge_release_create",
    "knowledge_release_transition", "knowledge_release_publish", "knowledge_retrieval", "workspace_switch",
    "workspace_migration_start", "workspace_migration_result", "workspace_client_bind", "oauth_bind_start", "oauth_bind_success",
    "oauth_bind_failed", "h5_login_success", "h5_login_failed",
  ];
  await page.evaluate(async (eventNames) => {
    const analytics = await import("/src/analytics/analytics.ts");
    for (const eventName of eventNames) {
      analytics.trackProductEvent(eventName, {
        source: "e2e",
        status: "success",
        error_code_group: "request_error",
        workspace_type: "local",
        platform: "windows",
        text: "do-not-send",
        token: "do-not-send",
      });
    }
    analytics.trackProductEvent("stable_dimension_probe", {
      target_scope: "USER",
      backend: "sqlite_fts5",
      effective_access_scope: "personal",
    });
    analytics.trackProductEvent("client_dimension_probe", {
      workspace_set: true,
      platform: "untrusted-client-platform",
      client_version_major: "v2026.08.30-custom",
    });
    analytics.setAnalyticsAccountContext({
      accountRole: "enterprise_admin",
      workspaceSet: true,
      accessContext: {
        identityType: "ENTERPRISE",
        editionType: "ENTERPRISE_PRO",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE",
      },
    });
    analytics.trackProductEvent("login_context_priority_probe", {
      status: "failed",
      error_code_group: "request_error",
      source: "settings",
      settings_panel: "message_notifications",
      settings_action: "save",
    });
  }, events);
  const queue = await readBaiduQueue(page);
  for (const eventName of events) {
    expect(queue).toContainEqual(["_trackEvent", "codeflow", eventName, expect.stringContaining("source=e2e")]);
  }
  expect(queue).toContainEqual([
    "_trackEvent",
    "codeflow",
    "stable_dimension_probe",
    "target_scope=USER|backend=sqlite_fts5|effective_access_scope=personal",
  ]);
  expect(queue).toContainEqual([
    "_trackEvent",
    "codeflow",
    "client_dimension_probe",
    "platform=other|client_version_major=2026|workspace_set=true",
  ]);
  expect(queue).toContainEqual([
    "_trackEvent",
    "codeflow",
    "login_context_priority_probe",
    expect.stringContaining("settings_panel=message_notifications|settings_action=save"),
  ]);
  expect(queue.some((command) => command.some((value) => String(value).includes("do-not-send")))).toBe(false);
});
