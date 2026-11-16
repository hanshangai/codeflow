import { expect, test, type Page } from "@playwright/test";

// 注入登录态；WS 握手与文件树/预览端点由 mock-codeflow-server 提供。
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "fp-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "fp-e2e-user", email: "fp-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

test.describe("资源预览", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  for (const desktop of [true, false]) {
    test(`FP-05 ${desktop ? "桌面" : "Web"}全屏预览铺满可用高度并随视口调整`, async ({ page }) => {
      page.on("pageerror", error => { throw error; });
      // 挂载真实预览组件与应用样式，仅替换桌面宿主边界。
      await page.route("**/__preview-layout", route => route.fulfill({ contentType: "text/html", body: `
        <!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div>
        <script type="module">
          import { createApp, h } from '/node_modules/.vite/deps/vue.js';
          import { createPinia } from '/node_modules/.vite/deps/pinia.js';
          import Antd from '/node_modules/.vite/deps/ant-design-vue.js';
          import Preview from '/src/features/explorer/components/explorer-preview-window.vue';
          import { useConfigStore } from '/src/store/config.ts';
          import '/src/App.vue?vue&type=style&index=0&lang.css';
          import '/src/styles.css';
          ${desktop ? "window.codeflowDesktop = { request: async () => { throw new Error('Unexpected desktop request'); }, getState: async () => ({ status: 'ready' }) };" : ""}
          const win = { id: 'layout', filePath: 'README.md', type: 'file', previewType: 'markdown',
            content: '# CodeFlow', base64: null, mimeType: null, diffOriginal: null, diffModified: null,
            diffStaged: false, diffVersionOld: null, diffVersionNew: null, cascadeIndex: 0, zIndex: 0 };
          const pinia = createPinia();
          const app = createApp({ render: () => h(Preview, { win }) }).use(pinia).use(Antd);
          useConfigStore(pinia);
          app.mount('#fixture');
        </script></body></html>` }));
      await page.goto("/__preview-layout");
      const content = page.locator(".explorer-preview-modal .ant-modal-content");
      await page.getByRole("button", { name: "全屏查看", exact: true }).click();
      for (const height of [900, 720, 1080]) {
        await page.setViewportSize({ width: 1440, height });
        await expect.poll(async () => {
          const bounds = await content.boundingBox();
          return bounds && { top: Math.round(bounds.y), bottom: Math.round(bounds.y + bounds.height) };
        }).toEqual({ top: desktop ? 44 : 0, bottom: height });
        await expect.poll(async () => {
          const bounds = await page.locator(".preview-window__content").boundingBox();
          return bounds && Math.round(bounds.y + bounds.height);
        }).toBe(height);
      }
      await page.getByRole("button", { name: "退出全屏", exact: true }).click();
      await expect(page.locator(".explorer-preview-modal--fullscreen")).toHaveCount(0);
      await expect.poll(async () => (await content.boundingBox())?.height).toBeLessThan(1080);
    });
  }

  test("FP-01 打开文件面板，文件树显示", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await expect(page.locator(".thread-list")).toBeVisible();
    const rightPanel = page.getByTestId("desktop-right-panel");
    if (!(await rightPanel.isVisible())) {
      await page.getByRole("button", { name: "文件" }).click();
    }
    await expect(rightPanel).toBeVisible();
    // 文件树懒加载：等待 src 目录出现并展开，再断言 index.ts
    await expect(page.getByText("src", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText("src", { exact: true }).first().click();
    await expect(page.getByText("index.ts").first()).toBeVisible({ timeout: 10_000 });
  });

  test("FP-02 点击文件，代码预览显示", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await expect(page.locator(".thread-list")).toBeVisible();
    const rightPanel = page.getByTestId("desktop-right-panel");
    if (!(await rightPanel.isVisible())) {
      await page.getByRole("button", { name: "文件" }).click();
    }
    await expect(rightPanel).toBeVisible();
    await expect(page.getByText("src", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText("src", { exact: true }).first().click();
    await page.getByText("index.ts").first().click();
    await expect(page.getByText("你好").first()).toBeVisible({ timeout: 10_000 });
  });

  test("FP-03 公共文章中的站内下载链接保留浏览器下载行为", async ({ page }) => {
    await page.route("**/api/public/best-practice-articles/link-regression", route => route.fulfill({ json: {
      ok: true, article: { slug: "link-regression", title: "文件链接回归", summary: "公共文章下载", publishedAt: 1, updatedAt: 1,
        bodyMarkdown: "[下载示例](/downloads/link-regression.zip)" },
    } }));
    await page.route("**/downloads/link-regression.zip", route => route.fulfill({
      contentType: "application/zip", headers: { "content-disposition": 'attachment; filename="link-regression.zip"' }, body: "PK-test",
    }));
    await page.goto("/best-practices/link-regression");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "下载示例", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("link-regression.zip");
    await expect(page.getByText("请先选择工作区后查看文件", { exact: true })).toHaveCount(0);
  });

  test("FP-04 会话中的无后缀文件、含井号文件名和脚本引用均打开文件预览", async ({ page }) => {
    const references = [
      { label: "构建文件", href: "Dockerfile", path: "Dockerfile" },
      { label: "说明文件", href: "README", path: "README" },
      { label: "含井号文档", href: "source/report%23final.md:52", path: "source/report#final.md" },
      { label: "过程脚本", href: "source/procedure.prc:52", path: "source/procedure.prc" },
      { label: "包脚本", href: "source/package.pck:52", path: "source/package.pck" },
    ];
    const readPaths: string[] = [];
    await page.route("**/api/threads/load", async route => {
      const response = await route.fetch();
      const body = await response.json();
      expect(body.ok).toBe(true);
      await route.fulfill({ response, json: { ...body, running: null, hasMore: false, events: [{
        schema: 1, seq: 1, ts: 1, workspaceId: body.thread.workspaceId, threadId: body.thread.id, engine: body.thread.engine,
        type: "item.agentMessage.completed", payload: { itemId: "file-reference-message", revision: 1,
          text: references.map(item => `[${item.label}](${item.href})`).join("\n\n") },
      }] } });
    });
    await page.route("**/api/fs/readFile", route => {
      const path = String(route.request().postDataJSON().path);
      readPaths.push(path);
      return route.fulfill({ json: { ok: true, path, content: "# 引用文件正文\nselect 1;", isBinary: false, size: 32, encoding: "utf8" } });
    });
    await installSession(page);
    const response = await page.request.post("http://127.0.0.1:39290/api/threads/create", {
      data: { workspaceId: "workspace_chat_core_e2e", engine: "codex", title: "文件引用回归" },
    });
    const created = await response.json();
    expect(created.ok).toBe(true);
    await page.goto(`/chat?workspaceId=workspace_chat_core_e2e&threadId=${created.threadId}`);
    for (const reference of references) {
      await page.getByRole("link", { name: reference.label, exact: true }).click();
      await expect(page.locator(".preview-window__title-text")).toHaveAttribute("title", reference.path);
      expect(readPaths.at(-1)).toBe(reference.path);
      await expect(page).toHaveURL(/\/chat(?:\?|$)/u);
      await page.getByRole("dialog").locator(".ant-modal-close").click();
      await expect(page.locator(".preview-window__title-text")).toBeHidden();
    }
  });
});
