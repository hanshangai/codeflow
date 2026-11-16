import { expect, test, type Page } from "@playwright/test";

const enterpriseId = "enterprise_workspace_migration_e2e";
const localWorkspaceId = "client-a:root";
const sharedWorkspaceId = "shared:sw-1";

type HarnessOptions = {
  capability?: boolean;
  includeSharedMaintenance?: boolean;
  migrationFailure?: boolean;
  migrationErrorCode?: string;
  migrationErrorMessage?: string;
  migrationErrorDetails?: Record<string, unknown>;
  initialActivityBlocker?: boolean;
  staleFirstPrepareDelayMs?: number;
  staleFirstMigrationQueryDelayMs?: number;
  secondMigrationQueryDelayMs?: number;
  staleFirstMigrationQueryFails?: boolean;
  steadyRunningState?: "copying" | "verifying";
};

type HarnessState = {
  prepareBodies: unknown[];
  startBodies: unknown[];
  prepareResponseCount: number;
  activityQueryCount: number;
  activityQueryResponseCount: number;
};

/** 构造后台壳层刷新账号状态所需的完整摘要。 */
function createAccountSummary() {
  return {
    ok: true,
    userId: "enterprise_admin_e2e",
    email: "workspace-migration-e2e@test.local",
    fullName: "迁移 E2E 用户",
    phone: "",
    avatarUrl: null,
    accountRole: "enterprise_admin",
    accessContext: {
      identityType: "ENTERPRISE_ADMIN",
      editionType: "COMMUNITY",
      editionStatus: "ACTIVE",
      effectiveAccessScope: "ENTERPRISE_ADMIN",
      enterpriseId,
      enterpriseName: "迁移 E2E 企业",
    },
    enterpriseSummary: null,
    enterpriseMemberPackageSummary: null,
    pendingEnterpriseInvitations: [],
    packageSummary: { status: "NONE" },
    keySummary: null,
    securitySummary: { lastPasswordChangedAt: null, failedAttempts: 0, lockedUntil: null },
  };
}

/** 安装真实 Web 页面所需的本地账号、API 和 WS 运行桩。 */
async function installHarness(page: Page, options: HarnessOptions = {}): Promise<HarnessState> {
  const state: HarnessState = {
    prepareBodies: [],
    startBodies: [],
    prepareResponseCount: 0,
    activityQueryCount: 0,
    activityQueryResponseCount: 0,
  };
  const capability = options.capability ?? true;
  const includeSharedMaintenance = options.includeSharedMaintenance ?? false;
  const migrationFailure = options.migrationFailure ?? false;

  await page.addInitScript(({ enterpriseId, localWorkspaceId }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "workspace-migration-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      workspaceId: localWorkspaceId,
      accessContext: {
        identityType: "ENTERPRISE_ADMIN",
        editionType: "COMMUNITY",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE_ADMIN",
        enterpriseId,
        enterpriseName: "迁移 E2E 企业",
      },
      userSummary: {
        userId: "enterprise_admin_e2e",
        email: "workspace-migration-e2e@test.local",
        fullName: "迁移 E2E 用户",
        phone: "",
        avatarUrl: null,
        accountRole: "enterprise_admin",
        status: "active",
        enterpriseId,
        enterpriseName: "迁移 E2E 企业",
      },
    }));
  }, { enterpriseId, localWorkspaceId });

  let started = false;
  await page.route("http://127.0.0.1:39290/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    const method = request.method();
    const localWorkspace = {
      id: localWorkspaceId,
      title: "本地工作区",
      path: "C:\\workspaces\\root",
      kind: "local",
      ownerClientId: "client-a",
      ownerClientName: "Client A",
      createdAt: 1,
      updatedAt: 1,
    };
    const sharedWorkspace = {
      id: sharedWorkspaceId,
      title: "共享工作区",
      path: "",
      kind: "shared",
      entryStatus: "available",
      shared: {
        sharedWorkspaceId: "sw-1",
        displayName: "共享工作区",
        hostStatus: "online",
        hostMaintenance: includeSharedMaintenance ? {
          active: true,
          maintenanceEpoch: "epoch-e2e",
          maintenanceVersion: 2,
          phase: "copying",
          progressPct: 45,
          updatedAt: 200,
        } : null,
      },
      hostMaintenance: includeSharedMaintenance ? {
        active: true,
        maintenanceEpoch: "epoch-e2e",
        maintenanceVersion: 2,
        phase: "copying",
        progressPct: 45,
        updatedAt: 200,
      } : null,
      createdAt: 1,
      updatedAt: 1,
    };
    const operation = (operationState: string) => {
      const activityBlocked = Boolean(
        options.initialActivityBlocker
        && state.activityQueryCount <= 2
        && operationState === "awaiting_confirmation",
      );
      return {
      operationId: "migration-op-e2e",
      workspaceId: localWorkspaceId,
      state: operationState,
      stateVersion: started ? 3 : 1,
      phase: operationState === "completed"
        ? "completed"
        : operationState === "copying"
          ? "copying"
          : operationState === "verifying"
            ? "verifying"
            : operationState === "failed" ? "failed" : "checking",
      sourcePath: localWorkspace.path,
      targetPath: "D:\\workspaces\\root-new",
      sourceFileCount: 12,
      sourceDirectoryCount: 3,
      sourceTotalBytes: 4096,
      excludedDependencyDirectoryCount: operationState === "failed" ? 0 : 2,
      excludedDependencyDirectories: operationState === "failed" ? [] : ["node_modules", "service/target"],
      copiedFiles: operationState === "completed" ? 12 : 4,
      copiedBytes: operationState === "completed" ? 4096 : 1024,
      progressPct: operationState === "completed" ? 100 : operationState === "copying" ? 25 : operationState === "verifying" ? 70 : 0,
      canStart: operationState === "awaiting_confirmation" && !activityBlocked,
      canCancel: operationState === "copying" || operationState === "verifying",
      currentPath: operationState === "completed" ? "D:\\workspaces\\root-new" : localWorkspace.path,
      blockers: activityBlocked ? [{
        code: "WORKSPACE_MIGRATION_ACTIVE_RESOURCES",
        message: "1 个会话正在执行，请先停止后再迁移。",
        details: { type: "turn", count: 1, resourceIds: ["thread-1:turn-1"] },
      }] : [],
      sharedBlockers: [],
      errorCode: operationState === "failed" ? options.migrationErrorCode ?? "WORKSPACE_MIGRATION_LINK_UNSUPPORTED" : null,
      errorMessage: operationState === "failed" ? options.migrationErrorMessage ?? "工作区包含不支持的 Windows 重解析点" : null,
      errorDetails: operationState === "failed" ? options.migrationErrorDetails ?? {
        reason: "windows_reparse_unsupported",
        relativePath: "data/shared-assets",
        reparseType: "Junction",
      } : null,
      warningCode: null,
      warningDetails: null,
      startAttemptId: null,
      startDisposition: null,
      indexRebuildGeneration: null,
      indexRebuildStatus: "ready",
      createdAt: 100,
      updatedAt: started ? 300 : 100,
      completedAt: operationState === "completed" ? 300 : null,
      };
    };

    if (method === "GET" && path === "/api/workspaces") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          workspaces: includeSharedMaintenance ? [localWorkspace, sharedWorkspace] : [localWorkspace],
          resolvedCurrentWorkspaceId: null,
          workspaceListAuthoritative: true,
          activeClientCount: 1,
          workspaceListSuccessCount: 1,
          workspaceListFailureCount: 0,
        }),
      });
      return;
    }
    if (path === "/api/account/me/ws-bridge" && (method === "POST" || method === "GET")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, bridgeToken: "workspace-migration-e2e-bridge", expiresAt: Date.now() + 60_000, serverNow: Date.now() }),
      });
      return;
    }
    if (method === "GET" && path === "/api/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          now: Date.now(),
          authVia: "account",
          clientConnected: true,
          clients: [],
          onlineWebCount: 1,
          lastSeq: 0,
        }),
      });
      return;
    }
    if (method === "GET" && path === "/api/account/me/summary") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createAccountSummary()),
      });
      return;
    }
    if (method === "GET" && path === "/api/threads") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, threads: [], total: 0 }),
      });
      return;
    }
    if (path.endsWith(`/api/workspaces/${localWorkspaceId}/directory-migrations`) && method === "POST") {
      state.prepareBodies.push(request.postDataJSON());
      if (options.staleFirstPrepareDelayMs && state.prepareBodies.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, options.staleFirstPrepareDelayMs));
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, operation: operation(migrationFailure ? "failed" : "awaiting_confirmation") }),
      });
      state.prepareResponseCount += 1;
      return;
    }
    if (path.includes(`/api/workspaces/${localWorkspaceId}/directory-migrations/migration-op-e2e/start`) && method === "POST") {
      started = true;
      state.startBodies.push(request.postDataJSON());
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, operation: operation("copying") }) });
      return;
    }
    if (path.includes(`/api/workspaces/${localWorkspaceId}/directory-migrations/migration-op-e2e`) && method === "GET") {
      state.activityQueryCount += 1;
      const queryOrdinal = state.activityQueryCount;
      const responseOperation = operation(
        started || (options.staleFirstMigrationQueryDelayMs && queryOrdinal > 1)
          ? options.steadyRunningState ?? "completed"
          : "awaiting_confirmation",
      );
      if (options.staleFirstMigrationQueryDelayMs && queryOrdinal === 1) {
        await new Promise((resolve) => setTimeout(resolve, options.staleFirstMigrationQueryDelayMs));
      }
      if (options.secondMigrationQueryDelayMs && queryOrdinal === 2) {
        await new Promise((resolve) => setTimeout(resolve, options.secondMigrationQueryDelayMs));
      }
      if (options.staleFirstMigrationQueryFails && queryOrdinal === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, code: "INTERNAL", message: "旧查询失败" }),
        });
        state.activityQueryResponseCount += 1;
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, operation: responseOperation }) });
      state.activityQueryResponseCount += 1;
      return;
    }
    if (path.includes("/api/fs/index/rebuild")) {
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: [], total: 0 }) });
  });

  await page.routeWebSocket(/\/ws\/web(?:\?|$)/u, (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { t?: string; requestId?: string; workspaceId?: string; sinceSeq?: number };
      if (message.t !== "web.subscribeReplace") return;
      ws.send(JSON.stringify({
        t: "web.subscribeAck",
        requestId: message.requestId,
        workspaceId: message.workspaceId ?? null,
        sinceSeq: Number(message.sinceSeq ?? 0),
        bufferedCount: 0,
        serverSeq: 0,
      }));
    });
    setTimeout(() => {
      ws.send(JSON.stringify({
        t: "web.helloAck",
        webSessionId: "workspace-migration-e2e-web",
        serverNow: Date.now(),
        authMode: "account",
        accountRole: "enterprise_admin",
        homePath: "/chat",
        userSummary: {
          userId: "enterprise_admin_e2e",
          email: "workspace-migration-e2e@test.local",
          fullName: "迁移 E2E 用户",
          phone: "",
          avatarUrl: null,
          accountRole: "enterprise_admin",
          status: "active",
          enterpriseId,
          enterpriseName: "迁移 E2E 企业",
        },
        accessContext: {
          identityType: "ENTERPRISE_ADMIN",
          editionType: "COMMUNITY",
          editionStatus: "ACTIVE",
          effectiveAccessScope: "ENTERPRISE_ADMIN",
          enterpriseId,
          enterpriseName: "迁移 E2E 企业",
        },
      }));
      ws.send(JSON.stringify({
        t: "presence.event",
        event: {
          type: "presence.updated",
          ts: Date.now(),
          payload: {
            onlineWebCount: 1,
            clientOnline: true,
            onlineClients: [{
              clientId: "client-a",
              name: "Client A",
              version: "2026.08.05.01",
              connectedAt: Date.now(),
              workspaceIds: [localWorkspaceId],
              capabilities: { workspaceDirectoryMigrationV1: capability },
            }],
          },
        },
      }));
    }, 0);
  });

  await page.goto("/admin?panel=settings");
  await page.getByRole("button", { name: /工作区管理$/u }).click();
  await expect(page).toHaveURL(/panel=workspaces/u);
  await expect(page.locator(".ws-manager__card-title").filter({ hasText: "本地工作区" })).toBeVisible();
  return state;
}

test("local workspace migration completes through check, confirmation, start, and progress", async ({ page }) => {
  const state = await installHarness(page);
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("迁移前请先停止工作区活动", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/正在执行的会话、流程、终端和后台任务/u)).toBeVisible();
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect(dialog.getByText("迁移条件检查通过", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2 个", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/可重新生成目录不会迁移/u)).toBeVisible();
  await expect(dialog.getByText(/service\/target/u)).toBeVisible();
  await dialog.getByLabel("我已暂停 IDE、构建和文件同步软件对源目录的写入。").check();
  await dialog.getByLabel("目标未被同步软件托管，且迁移完成前我不会访问目标路径。").check();
  await dialog.getByRole("button", { name: "开始迁移" }).click();
  await expect(dialog.getByText("迁移完成", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText("请重新安装依赖并重新构建项目", { exact: true })).toBeVisible();
  expect(state.prepareBodies).toEqual([{
    idempotencyKey: expect.any(String),
    targetParentPath: "C:\\workspaces",
    targetDirectoryName: "root",
  }]);
  expect(state.startBodies).toEqual([{
    externalWritesPausedConfirmed: true,
    targetNotSyncManagedConfirmed: true,
  }]);
  await expect(dialog.locator(".migration-modal__footer button").filter({ hasText: /关\s*闭/u })).toBeVisible();
});

test("workspace removal shows a failed response and keeps the dialog available for retry", async ({ page }) => {
  await installHarness(page);
  let attempts = 0;
  await page.route("**/api/workspaces/delete", route => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ workspaceId: localWorkspaceId, clientId: "client-a" });
    return route.fulfill({ status: 503, json: { ok: false, code: "CLIENT_OFFLINE", message: "会话停止失败，请稍后重试",
      details: { requestId: "workspace-removal-e2e" } } });
  });
  await page.locator(".ws-manager").getByRole("button", { name: "移除", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "移除工作区" });
  await dialog.getByRole("button", { name: /移\s*除/u }).click();
  await expect(page.getByText("会话停止失败，请稍后重试", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /移\s*除/u })).toBeEnabled();
  await expect(page.locator(".ws-manager__card-title").filter({ hasText: "本地工作区" })).toBeVisible();
  await dialog.getByRole("button", { name: /移\s*除/u }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByText("已移除", { exact: true })).toHaveCount(0);
});

test("offline workspace can be removed and stays absent after reloading the page", async ({ page }) => {
  await installHarness(page);
  let removed = false;
  await page.route("**/api/workspaces?**", route => route.fulfill({ json: {
    ok: true, workspaceListAuthoritative: true, activeClientCount: 1, workspaceListSuccessCount: 1, workspaceListFailureCount: 0,
    workspaces: [
      { id: localWorkspaceId, title: "本地工作区", path: "C:/root", kind: "local", ownerClientId: "client-a", createdAt: 1, updatedAt: 1 },
      ...(removed ? [] : [{ id: "retired-client:old", title: "旧电脑工作区", path: "/missing", kind: "local", entryStatus: "client_offline",
        ownerClientId: "retired-client", createdAt: 1, updatedAt: 1 }]),
    ],
  } }));
  await page.route("**/api/workspaces/delete", route => {
    expect(route.request().postDataJSON()).toEqual({ workspaceId: "retired-client:old", clientId: "retired-client" });
    removed = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  const card = page.locator(".ws-manager__card").filter({ hasText: "旧电脑工作区" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "移除", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "移除工作区" });
  await expect(dialog.getByText(/Client 离线时也可移除/u)).toBeVisible();
  await dialog.getByRole("button", { name: /移\s*除/u }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".ws-manager__card-title").filter({ hasText: "本地工作区" })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("migration verification keeps a realistic progress range and hides footer close action", async ({ page }) => {
  await installHarness(page, { steadyRunningState: "verifying" });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect(dialog.getByText("迁移条件检查通过", { exact: true })).toBeVisible();
  await dialog.getByLabel("我已暂停 IDE、构建和文件同步软件对源目录的写入。").check();
  await dialog.getByLabel("目标未被同步软件托管，且迁移完成前我不会访问目标路径。").check();
  await dialog.getByRole("button", { name: "开始迁移" }).click();

  await expect(dialog.locator(".migration-modal__progress-head strong")).toHaveText("校验", { timeout: 3_000 });
  await expect(dialog.locator(".ant-progress-text")).toHaveText("70%");
  const footer = dialog.locator(".migration-modal__footer");
  await expect(footer.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "取消迁移", exact: true })).toBeVisible();
});

test("activity blockers refresh until the workspace becomes migratable", async ({ page }) => {
  const state = await installHarness(page, { initialActivityBlocker: true });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect(dialog.getByText("1 个会话正在执行，请先停止后再迁移。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始迁移" })).toBeDisabled();
  await dialog.getByLabel("我已暂停 IDE、构建和文件同步软件对源目录的写入。").check();
  await dialog.getByLabel("目标未被同步软件托管，且迁移完成前我不会访问目标路径。").check();
  await expect.poll(() => state.activityQueryResponseCount, { timeout: 5_000 }).toBe(2);
  await expect(dialog.getByRole("button", { name: "开始迁移" })).toBeDisabled();
  await expect(dialog.getByText("1 个会话正在执行，请先停止后再迁移。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始迁移" })).toBeEnabled({ timeout: 4_000 });
  await expect(dialog.getByText("1 个会话正在执行，请先停止后再迁移。", { exact: true })).toHaveCount(0);
  expect(state.activityQueryCount).toBeGreaterThanOrEqual(3);
});

test("late polling response cannot overwrite a reopened migration modal", async ({ page }) => {
  const state = await installHarness(page, {
    initialActivityBlocker: true,
    staleFirstMigrationQueryDelayMs: 3_000,
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect(dialog.getByText("1 个会话正在执行，请先停止后再迁移。", { exact: true })).toBeVisible();
  await expect.poll(() => state.activityQueryCount, { timeout: 4_000 }).toBe(1);

  await dialog.locator(".ant-modal-close").click();
  await expect(dialog).toBeHidden();
  await manager.getByRole("button", { name: "迁移中", exact: true }).click();
  await expect(dialog.getByText("迁移完成", { exact: true })).toBeVisible({ timeout: 3_000 });
  await expect.poll(() => state.activityQueryResponseCount, { timeout: 5_000 }).toBe(2);
  await expect(dialog.getByText("迁移完成", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 个会话正在执行，请先停止后再迁移。", { exact: true })).toHaveCount(0);
});

test("late prepare response cannot change a reopened target form or restart polling", async ({ page }) => {
  const state = await installHarness(page, { staleFirstPrepareDelayMs: 2_500 });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect.poll(() => state.prepareBodies.length).toBe(1);

  await dialog.locator(".ant-modal-close").click();
  await expect(dialog).toBeHidden();
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  await dialog.getByLabel("新目录名称").fill("root-reopened");
  await expect.poll(() => state.prepareResponseCount, { timeout: 4_000 }).toBe(1);

  await expect(dialog.getByLabel("新目录名称")).toHaveValue("root-reopened");
  await expect(dialog.getByRole("button", { name: "检查目标" })).toBeEnabled();
  await expect(dialog.getByText("迁移条件检查通过", { exact: true })).toHaveCount(0);
  await expect(manager.getByRole("button", { name: "迁移目录", exact: true })).toBeVisible();
  await page.waitForTimeout(1_700);
  expect(state.activityQueryCount).toBe(0);
});

test("late polling failure cannot overwrite a reopened completed migration", async ({ page }) => {
  const state = await installHarness(page, {
    initialActivityBlocker: true,
    staleFirstMigrationQueryDelayMs: 2_000,
    secondMigrationQueryDelayMs: 3_500,
    staleFirstMigrationQueryFails: true,
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect.poll(() => state.activityQueryCount, { timeout: 4_000 }).toBe(1);

  await dialog.locator(".ant-modal-close").click();
  await manager.getByRole("button", { name: "迁移中", exact: true }).click();
  await expect.poll(() => state.activityQueryCount, { timeout: 3_000 }).toBe(2);
  await expect.poll(() => state.activityQueryResponseCount, { timeout: 3_000 }).toBe(1);
  await expect(dialog.locator(".migration-modal")).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByText("旧查询失败", { exact: true })).toHaveCount(0);

  await expect(dialog.getByText("迁移完成", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => state.activityQueryResponseCount, { timeout: 5_000 }).toBe(2);

  await expect(dialog.getByText("迁移完成", { exact: true })).toBeVisible();
  await expect(dialog.getByText("旧查询失败", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(".migration-modal")).toHaveAttribute("aria-busy", "false");
});

test("failed migration shows actionable details and keeps footer controls inset", async ({ page }) => {
  await installHarness(page, {
    migrationFailure: true,
    migrationErrorMessage: "迁移失败 stderr=C:\\Users\\Free\\secret.log",
    migrationErrorDetails: {
      reason: "windows_reparse_unsupported",
      relativePath: "data/shared-assets",
      reparseType: "Junction",
      absolutePath: "C:\\Users\\Free\\OneDrive\\data\\shared-assets",
      stderrSummary: "stderr=probe failed at C:\\Users\\Free\\OneDrive",
    },
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();

  await expect(dialog.getByText("迁移未完成", { exact: true })).toBeVisible();
  await expect(dialog.getByText("检测到可重新生成目录之外的 Windows 目录联接（Junction）。该目录可能承载真实数据，一期迁移不会跳过；请移除目录联接或改为工作区内的普通目录后重试。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("data/shared-assets", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Junction", { exact: true })).toBeVisible();
  await expect(dialog.getByText("WORKSPACE_MIGRATION_LINK_UNSUPPORTED", { exact: true })).toBeVisible();
  await expect(dialog.getByText("migration-op-e2e", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/C:\\Users\\Free/u)).toHaveCount(0);
  await expect(dialog.getByText(/stderr=/u)).toHaveCount(0);
  await expect(page.getByText(/Cannot read properties/u)).toHaveCount(0);

  let dialogBox = await dialog.locator(".ant-modal-content").boundingBox();
  let retryBox = await dialog.getByRole("button", { name: "重新检查" }).boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  expect((dialogBox!.x + dialogBox!.width) - (retryBox!.x + retryBox!.width)).toBeGreaterThanOrEqual(16);
  expect((dialogBox!.y + dialogBox!.height) - (retryBox!.y + retryBox!.height)).toBeGreaterThanOrEqual(16);

  await page.setViewportSize({ width: 390, height: 600 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /系统.*设置与订单信息/u }).click();
  await expect(manager.getByRole("button", { name: "迁移目录", exact: true })).toBeVisible();
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  await dialog.getByRole("button", { name: "检查目标" }).click();
  await expect(dialog.getByRole("button", { name: "重新检查" })).toBeVisible();
  const sectionMetrics = await dialog.locator(".migration-modal__section").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: window.getComputedStyle(element).overflowY,
  }));
  expect(sectionMetrics.overflowY).toBe("auto");
  expect(sectionMetrics.scrollHeight).toBeGreaterThan(sectionMetrics.clientHeight);
  dialogBox = await dialog.locator(".ant-modal-content").boundingBox();
  retryBox = await dialog.getByRole("button", { name: "重新检查" }).boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  expect((dialogBox!.x + dialogBox!.width) - (retryBox!.x + retryBox!.width)).toBeGreaterThanOrEqual(16);
  expect((dialogBox!.y + dialogBox!.height) - (retryBox!.y + retryBox!.height)).toBeGreaterThanOrEqual(16);
});

test("known migration error code overrides a generic backend failure message", async ({ page }) => {
  await installHarness(page, {
    migrationFailure: true,
    migrationErrorCode: "WORKSPACE_MIGRATION_COPY_FAILED",
    migrationErrorMessage: "失败",
    migrationErrorDetails: { reason: "copy_failed", relativePath: "C:private-file" },
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();

  await expect(dialog.getByText("复制工作区内容时发生文件读取、写入或磁盘错误。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("WORKSPACE_MIGRATION_COPY_FAILED", { exact: true })).toBeVisible();
  await expect(dialog.getByText("C:private-file", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(".ant-result-subtitle")).toHaveText("工作区仍使用安全确认的目录。");
});

test("source change failure shows changed relative paths in the actionable reason", async ({ page }) => {
  await installHarness(page, {
    migrationFailure: true,
    migrationErrorCode: "WORKSPACE_MIGRATION_SOURCE_CHANGED",
    migrationErrorMessage: "迁移期间源目录内容发生变化",
    migrationErrorDetails: {
      reason: "source_file_changed_while_reading",
      sourceChangeCount: 3,
      sourceChangedPaths: ["src/main.ts", "README.md"],
      absolutePath: "D:\\multica\\src\\main.ts",
      stderrSummary: "stderr=watcher detail",
    },
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();

  await expect(dialog.getByText(
    "迁移期间检测到源目录内容发生变化，变化位置：src/main.ts、README.md。请停止外部写入后重新检查。",
    { exact: true },
  )).toBeVisible();
  await expect(dialog.getByText("src/main.ts、README.md", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/D:\\multica/u)).toHaveCount(0);
  await expect(dialog.getByText(/stderr=/u)).toHaveCount(0);
});

test("source change without a concrete path states that the file cannot be located", async ({ page }) => {
  await installHarness(page, {
    migrationFailure: true,
    migrationErrorCode: "WORKSPACE_MIGRATION_SOURCE_CHANGED",
    migrationErrorDetails: { reason: "source_manifest_changed" },
  });
  const manager = page.locator(".ws-manager");
  await manager.getByRole("button", { name: "迁移目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "迁移工作区目录" });
  await dialog.getByRole("button", { name: "检查目标" }).click();

  await expect(dialog.getByText("迁移未完成", { exact: true })).toBeVisible();
  await expect(dialog.getByText("迁移期间检测到源目录摘要发生变化，但无法定位具体文件。请停止外部写入后重新检查。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("变化位置", { exact: true })).toHaveCount(0);
});

test("missing migration capability disables the local migration entry", async ({ page }) => {
  await installHarness(page, { capability: false });
  const migrationButton = page.locator(".ws-manager").getByRole("button", { name: "迁移目录", exact: true });
  await expect(migrationButton).toBeDisabled();
});

test("shared Host maintenance is visible and blocks the shared selector entry", async ({ page }) => {
  await installHarness(page, { includeSharedMaintenance: true });
  await expect(page.getByText("共享维护中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /切换工作区/u }).click();
  const maintenanceOption = page.locator(".ws-compact-option").filter({ hasText: "维护中" });
  await expect(maintenanceOption).toBeVisible();
  await expect(maintenanceOption).toBeDisabled();
});
